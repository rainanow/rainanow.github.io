/**
 * 账号管理：禁言判定 + 管理员的账号操作路由。
 *
 * 为什么单独一个文件：
 *   - **禁言判定**要三处用（发消息 / 上传 / WebSocket 握手）。集中在一处，
 *     是吸取限流那次的教训 —— 桶键和阈值散落之后，没人说得清一共拦了几处。
 *   - **管理路由**是账号管理而不是聊天，塞进 routes/chat.ts 会越滚越大。
 *
 * 三条安全约束集中写在这里，改动时能一眼看全：
 *   1. 每次都查库确认操作者是 admin，不信 JWT；
 *   2. 每次操作都有限流 —— 管理操作误触一次代价不小，UI 确认弹窗不够；
 *   3. 注销**保留消息**。聊天记录是别人发的、不可再生的数据，
 *      注销一个账号不该连带删掉别人参与过的对话。
 */

import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { z } from 'zod'

import type { AppEnv, ChatContext, UserModel } from './context'
import { cookieAuthBridge } from './middleware'
import { consumeRateLimit, effectiveLimit } from './rate-limit'
import { revokeAllSessions } from './sessions'

/** 管理员操作限额：同一管理员 1 分钟内最多 10 次。 */
const MODERATION_LIMIT = 10
const MODERATION_WINDOW_SECONDS = 60

/** 账号被注销后，历史消息里替代原用户名显示成什么。 */
export const PURGED_NAME = '已注销'

/**
 * 这个人现在是不是被禁言着。
 *
 * 存的是**截止时间**而不是布尔值（`users.mutedUntil`），所以判断只有一行、
 * 到期自动恢复正常 —— 不需要定时任务去「取消禁言」，也不会出现
 * 「布尔说是禁言、但到期时间已经过了」这种自相矛盾的状态。
 */
export function isMuted(user: { mutedUntil?: Date | null } | null | undefined): boolean {
  if (user === null || user === undefined) return false
  if (user.mutedUntil === null || user.mutedUntil === undefined) return false
  return user.mutedUntil.getTime() > Date.now()
}

/** 禁言剩余时长的中文描述，给 403 的提示用。 */
export function mutedRemaining(mutedUntil: Date): string {
  const left = mutedUntil.getTime() - Date.now()
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (left < hour) return `${Math.max(1, Math.ceil(left / minute))} 分钟`
  if (left < day) return `${Math.ceil(left / hour)} 小时`
  return `${Math.ceil(left / day)} 天`
}

/**
 * 取当前操作者并确认是管理员。
 *
 * **查库、不信 JWT**，两个原因：
 *   - `@nanokajs/auth` 的 access token 里只有 `sub` / `type` / `jti`，没有 role；
 *   - 就算加了也不该信 —— 真要降级谁，token 在有效期内还能继续用，
 *     降级会「延迟 30 分钟才生效」。查库是立刻生效的。
 *
 * 返回 `Response` 表示已经写过错误响应了，调用方直接 return 即可 ——
 * 用返回值而不是抛异常，是因为限流要带 `Retry-After` 头，
 * 而 Hono 的 HTTPException 不方便塞自定义头。
 */
async function requireModerator(
  c: Context<AppEnv>,
  User: UserModel,
): Promise<{ id: string; username: string } | Response> {
  const sub = c.get('user')['sub']
  if (typeof sub !== 'string' || sub.length === 0) {
    return c.json({ error: '未登录' }, 401)
  }

  const attempt = await consumeRateLimit(
    c.env.DB,
    `moderation:${sub}`,
    effectiveLimit(c.env, MODERATION_LIMIT + 1),
    MODERATION_WINDOW_SECONDS,
  )
  if (attempt.blocked) {
    c.header('Retry-After', String(attempt.retryAfterSeconds))
    return c.json({ error: `操作太频繁了，${attempt.retryAfterSeconds} 秒后再试` }, 429)
  }

  const me = await User.findOne(sub)
  if (me === null) return c.json({ error: '账号不存在' }, 401)
  if (me.role !== 'admin') return c.json({ error: '只有管理员能做这个操作' }, 403)

  return { id: me.id, username: me.username }
}

const muteSchema = z.object({
  /**
   * 禁言多少分钟。传 `null` 表示**解除禁言**。
   *
   * 解除的实现是「把 mutedUntil 置回 null」，而不是设成 0 或很久以前 ——
   * 后者会让 `isMuted` 的判断还得再写一遍「太早的也算已解除」。
   */
  minutes: z.number().int().min(1).max(60 * 24 * 30).nullable(),
})

export function registerModerationRoutes({ app, User, Message, UserPurge, auth }: ChatContext): void {
  /**
   * 禁言 / 解除禁言。
   *
   * 生效范围是三处：发言（routes/chat.ts）、上传（routes/media.ts）、
   * 以及 WebSocket 握手。三处都漏的话，被禁言的人至少还能连着看、能收消息 ——
   * 那不算「禁言」。
   */
  app.post('/api/users/:id/mute', cookieAuthBridge, auth.middleware(), async (c) => {
    const me = await requireModerator(c, User)
    if (me instanceof Response) return me

    const targetId = c.req.param('id')
    if (targetId === me.id) {
      // 不能对自己：这是「把自己关禁闭」的自残操作，想冷静该直接登出。
      return c.json({ error: '不能对自己执行这个操作' }, 400)
    }

    const target = await User.findOne(targetId)
    if (target === null) return c.json({ error: '用户不存在' }, 404)

    const body = (await c.req.json().catch(() => null)) as { minutes?: unknown } | null
    const parsed = muteSchema.safeParse({ minutes: body?.minutes ?? null })
    if (!parsed.success) {
      return c.json({ error: '禁言时长不合法' }, 400)
    }

    if (parsed.data.minutes === null) {
      // 这里必须用 drizzle 而不是 `User.update`：nanoka 的 update 用 `undefined`
      // 表示「这个字段不更新」，类型是 `Date | undefined`，**没有把列置回 NULL 的表达**。
      // 绕这一道是因为「解除禁言」在语义上就等于把这一列清空。
      await app.db
        .update(User.table)
        .set({ mutedUntil: null })
        .where(eq(User.table.id, target.id))
      return c.json({ ok: true, username: target.username, mutedUntil: null })
    }

    const mutedUntil = new Date(Date.now() + parsed.data.minutes * 60 * 1000)
    await User.update(target.id, { mutedUntil })

    return c.json({
      ok: true,
      username: target.username,
      mutedUntil: mutedUntil.getTime(),
    })
  })

  /**
   * 注销用户。
   *
   * ## 删什么、不删什么
   *
   * 删：users 行、user_sessions 里他的全部会话（吊销）、审计流水一行。
   * 不删：**他的所有消息** —— 只把消息里的 username 批量改写成「已注销」。
   *
   * 取舍理由：聊天记录是**别人发的、不可再生的数据**。注销一个账号不该
   * 连带抹掉别人参与过的对话，那等于替其他人删了他们的发言。
   *
   * 消息里的 username 是**冗余存**的（当初为了省 D1 读取行数没做 join），
   * 所以这里要显式 UPDATE 一批行。
   *
   * ## 为什么必须吊销他的会话
   *
   * 不吊销的话，他那个已经登录的浏览器在 access token 有效期内（30 分钟）
   * 仍然能读能发 —— 一个「已注销」的账号还在活动，比不注销更糟。
   */
  app.delete('/api/users/:id', cookieAuthBridge, auth.middleware(), async (c) => {
    const me = await requireModerator(c, User)
    if (me instanceof Response) return me

    const targetId = c.req.param('id')
    if (targetId === me.id) {
      // 不许注销自己：没有「恢复自己」的办法，等于误点一次就永久失去这个号。
      return c.json({ error: '不能注销自己' }, 400)
    }

    const target = await User.findOne(targetId)
    if (target === null) return c.json({ error: '用户不存在' }, 404)

    // 顺序上唯一的硬要求是**删账号必须在最后**：前面每一步都要用 target 的信息。
    const renamed = await app.db
      .update(Message.table)
      .set({ username: PURGED_NAME })
      .where(eq(Message.table.userId, targetId))
      .returning({ id: Message.table.id })

    await revokeAllSessions(c.env.DB, targetId)
    await app.db.delete(User.table).where(eq(User.table.id, targetId))

    // 审计写在最后：它要记 purgedMessages，而这个数来自上面的 returning。
    // 万一这步失败，账号已经删了 —— 只记日志，不能因此报错，
    // 否则调用方会以为「注销失败」而重试，而账号已经没了。
    try {
      // 用 nanoka 的 create 而不是 app.db.insert：主键是 `t.uuid().primary().readOnly()`，
      // 由模型生成 uuid，drizzle 那边没有默认值、直接 insert 会因为缺 id 而失败。
      // room_purges 那次也是这么写的。
      await UserPurge.create({
        purgedUserId: targetId,
        purgedUsername: target.username,
        purgedBy: me.id,
        purgedByUsername: me.username,
        renamedTo: PURGED_NAME,
        purgedMessages: renamed.length,
      })
    } catch (error) {
      console.error('注销用户的审计流水写入失败', { targetId, admin: me.username, error })
    }

    return c.json({ ok: true, username: target.username, renamedMessages: renamed.length })
  })
}
