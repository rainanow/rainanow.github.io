import { and, asc, desc, eq, lt, sql } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import type { Context } from 'hono'
import { z } from 'zod'

import {
  DEFAULT_ROOM,
  DELETE_ALLOWED_PER_WINDOW,
  DELETE_WINDOW_SECONDS,
  EXPORT_LIMIT,
  HISTORY_PAGE_SIZE,
  KIND_USER,
  MAX_MESSAGE_LENGTH,
  MEMBER_LIST_LIMIT,
  MESSAGE_ALLOWED_PER_WINDOW,
  MESSAGE_WINDOW_SECONDS,
  REFRESH_TOKEN_COOKIE,
} from '../config'
import { deleteCookie } from 'hono/cookie'

import { scryptHasher } from '../hasher'
import { extractMediaKeys } from '../media'
import { refundUpload } from '../quota'
import { isMuted, mutedRemaining } from '../moderation'
import { consumeRateLimit, effectiveLimit } from '../rate-limit'
import { revokeAllSessions } from '../sessions'
import { insertSystemMessage, systemMessage, withdrawNotice } from '../system-message'
import type { AppEnv, ChatContext } from '../context'
import type { Env } from '../env'
import { cookieAuthBridge } from '../middleware'
import { isAllowedOrigin } from '../origins'
import type { ChatMessage, ChatServerEvent } from '../types'

const postMessageSchema = z.object({
  // 用常量而不是写死 500：以前这个数字在后端两处 + 前端一处各写一遍，
  // 而 config.ts 里的 MAX_MESSAGE_LENGTH 根本没人 import（是个死常量）。
  // 现在后端两处都读它，前端那处由 hugo.toml 的 params.chat.maxMessageLength 提供，
  // 两边是否一致由 `npm run verify-build` 的第 6 项守着。
  body: z
    .string()
    .trim()
    .min(1, '消息不能为空')
    .max(MAX_MESSAGE_LENGTH, `单条消息最多 ${MAX_MESSAGE_LENGTH} 字`),
  room: z.string().optional(),
})

/** 历史查询的返回形状，对应 drizzle/schema.ts 里 messages 表的列。 */
interface HistoryRow {
  id: string
  userId: string
  username: string
  body: string
  /**
   * `'user'` 或 `'system'`。
   *
   * 系统消息（谁进了房间、谁撤回了一条）和普通消息**同表**，翻页时天然按时间交错 ——
   * 这个字段是唯一的区分依据，前后端都靠它决定「渲染成一条气泡」还是「渲染成一条窄提示」。
   */
  kind: string
  createdAt: Date
}

function requireSubject(c: Context<AppEnv>): string {
  const sub = c.get('user')['sub']
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new HTTPException(401, { message: '未登录' })
  }
  return sub
}

/** 聊天室名只允许小写下划线，别的入口一律退回默认房间，避免拿房间名当注入面。 */
function normalizeRoom(value: string | undefined): string {
  if (value === undefined) return DEFAULT_ROOM
  const trimmed = value.trim()
  return /^[a-z0-9_-]{1,32}$/.test(trimmed) ? trimmed : DEFAULT_ROOM
}

/**
 * 管理员的门禁。
 *
 * 前端也会把按钮藏起来，但那只是「别让人白点」——真正的判定必须在这里，
 * 否则任何人手上一发请求就能清空整个房间。
 */
/**
 * 返回查到的 admin 账号，而不只是 void —— 清空房间那一处需要用它写审计流水
 * （谁清的）。原来返回 void 时那里要么再查一次库，要么记不下操作者。
 *
 * 已有的调用方（导出）忽略返回值即可，不受影响。
 */
async function requireAdmin(
  c: Context<AppEnv>,
  User: ChatContext['User'],
): Promise<NonNullable<Awaited<ReturnType<ChatContext['User']['findOne']>>>> {
  const sub = requireSubject(c)
  const user = await User.findOne(sub)
  if (user === null) throw new HTTPException(401, { message: '账号不存在' })
  if (user.role !== 'admin') throw new HTTPException(403, { message: '只有管理员能做这个操作' })
  return user
}

/**
 * 发言频率限制从 isolate 内存搬到了 D1（见 `consumeRateLimit`）。
 *
 * 内存那版挡手滑连点够用，但**换个接入点就绕过去了**：Workers 的 isolate 按 POP
 * 分布、随时回收，攻击者每次请求落在不同 isolate 上，等于每次都是全新的空计数。
 * 想真拦住就必须落库。代价是每条消息多一次 D1 写，这个换得值。
 */

/**
 * 把事件交给该房间的 Durable Object 去推给所有在线连接。
 *
 * ## 刻意做成「尽力而为」：任何失败都在这里吞掉，绝不往调用方抛
 *
 * 广播是**副作用**，业务写入（消息落库 / 标记撤回 / 清空房间）才是这个请求的实体。
 * 让一次 DO 抖动的异常冒到 Hono 的 onError，调用方拿到的是 500 ——
 * 而消息其实已经稳稳写进 D1 了。前端的反应是「发送失败，再点一次」，
 * 于是库里多出一条一模一样的消息。换句话说：
 * **广播失败会伪造出一个「写入失败」，并因此造成真实的重复写入。**
 *
 * 吞掉的代价只是「这条消息没实时推给别人」，他们下次拉历史就看到了。
 * 拿「晚几秒看到」换「不会重复发」，方向是明确的。
 *
 * 仍然 `await`（不改成 fire-and-forget）：顺序上要保证广播在响应之前发出，
 * 否则前端可能先收到 201、又通过历史接口拿到同一条，去重逻辑就得再复杂一层。
 *
 * 用 console.error 留痕而不是静默吞：线上真出问题时日志里要看得见。
 */
async function broadcast(env: Env, room: string, event: ChatServerEvent): Promise<void> {
  try {
    const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(room))
    const response = await stub.fetch('https://chat-room.internal/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event }),
    })
    if (!response.ok) {
      console.error('广播失败', { room, type: event.type, status: response.status })
    }
  } catch (error) {
    console.error('广播异常', { room, type: event.type, error })
  }
}

export function registerChatRoutes({ app, User, Message, RoomPurge, auth }: ChatContext): void {
  /** 存活探针。不带鉴权，用来确认 Worker、路由和 D1 绑定都活着。 */
  app.get('/api/health', (c) => c.json({ ok: true, service: 'yulo-chat' }))

  app.get('/api/me', cookieAuthBridge, auth.middleware(), async (c) => {
    const user = await User.findOne(requireSubject(c))
    if (user === null) throw new HTTPException(401, { message: '账号不存在' })
    return c.json({
      id: user.id,
      username: user.username,
      role: user.role,
      createdAt: user.createdAt,
    })
  })

  /**
   * 成员名单。
   *
   * 支持 `?scope=`：
   *   - 省略或 `all`（默认）：所有已注册账号 + 各自在不在线。会读 users 表，
   *     上限 MEMBER_LIST_LIMIT 行。
   *   - `online`：**只**返回此刻在线的人，名单数据来自 DO，不读 users 表。
   *
   * ## 为什么要有 online 这一档
   *
   * D1 是按**读取行数**计费的（免费 500 万行/天）。成员名单原本每次有人进出
   * （`presence` 事件）就要重新拉一次全表 —— 一次吃掉最多 500 行。
   * 用 `scope=online` 刷新就把这部分砍掉了：500 行 → 1 行。
   *
   * ⚠️ 说「不读 users 表」，但**不是零次 D1 查询**：上面那句
   * `User.findOne(requireSubject(c))` 仍然会跑，一次按主键查自己，
   * 用来确认账号还存在（删号的人不该还能拉名单）。这是刻意保留的 fail-closed，
   * 1 行和 500 行差了两个数量级，不值得为省这一行把校验去掉。
   * 别在注释里把「不读 users 表」写成「不读 D1」——会误导后来的人。
   *
   * 代价是 `role` 在 online 这一档拿不到（DO 里没存），置为 null ——
   * 名单展示用不到它。
   *
   * 前端的用法：首次展开面板拉 `all` 建好缓存，之后的 presence 刷新只拉 `online`。
   *
   * 返回**扁平数组**而不是分好组的两份列表：排序是展示层的事，
   * 前端想按在线优先排、还是加个搜索框筛，都不用再改后端。
   */
  app.get('/api/members', cookieAuthBridge, auth.middleware(), async (c) => {
    const room = normalizeRoom(c.req.query('room'))
    const onlineOnly = c.req.query('scope') === 'online'
    const me = await User.findOne(requireSubject(c))
    if (me === null) throw new HTTPException(401, { message: '账号不存在' })

    const stub = c.env.CHAT_ROOM.get(c.env.CHAT_ROOM.idFromName(room))
    let onlineIds: string[] = []
    let onlineMembers: { userId: string; username: string }[] = []
    try {
      const response = await stub.fetch('https://chat-room.internal/online')
      if (response.ok) {
        const payload = (await response.json()) as {
          userIds?: unknown
          members?: unknown
        }
        if (Array.isArray(payload.userIds)) {
          onlineIds = payload.userIds.filter((id): id is string => typeof id === 'string')
        }
        if (Array.isArray(payload.members)) {
          onlineMembers = payload.members.filter(
            (item): item is { userId: string; username: string } =>
              typeof item === 'object' &&
              item !== null &&
              typeof (item as { userId?: unknown }).userId === 'string' &&
              typeof (item as { username?: unknown }).username === 'string',
          )
        }
      }
    } catch {
      // DO 临时拿不到就当作「没人在线」，不能因为这一处把整个名单接口拖挂。
    }

    // 只问在线：直接把 DO 给的结果回出去，不查 users 表。
    //
    // ⚠️ 那个 `if` 不是多余的保险，是**必需的降级**：如果 DO 回了 userIds 却没有
    // members（老版本的 DO、或者两边代码版本不同步），而我们直接回空列表，
    // 前端会把**所有人**都标成离线 —— 那是「显示错」而不是「显示慢」。
    // 所以检测到「有人在线但拿不到用户名」时，退回全量那条老路：
    // 多花一次 D1 查询，但结果是对的。
    const doGaveUsernames = onlineMembers.length > 0 || onlineIds.length === 0
    if (onlineOnly && doGaveUsernames) {
      return c.json({
        room,
        scope: 'online',
        total: onlineMembers.length,
        members: onlineMembers.map((member) => ({
          id: member.userId,
          username: member.username,
          role: null,
          online: true,
        })),
      })
    }

    const online = new Set(onlineIds)

    // users 是小表，一次取完最省事；MEMBER_LIST_LIMIT 只是防呆上限。
    const rows = (await app.db
      .select({
        id: User.table.id,
        username: User.table.username,
        role: User.table.role,
        lastSeenAt: User.table.lastSeenAt,
        mutedUntil: User.table.mutedUntil,
      })
      .from(User.table)
      .orderBy(asc(User.table.username))
      .limit(MEMBER_LIST_LIMIT)) as {
      id: string
      username: string
      role: string
      lastSeenAt: Date | null
      mutedUntil: Date | null
    }[]

    // 被禁言中才算「现在受罚」，到期自动恢复正常。判断放在服务端，
    // 前端拿到的是一个已经算好的布尔值，不用自己算时间戳。
    const now = Date.now()

    return c.json({
      room,
      scope: 'all',
      total: rows.length,
      members: rows.map((row) => ({
        id: row.id,
        username: row.username,
        role: row.role,
        online: online.has(row.id),
        // 转成毫秒数字再给前端：drizzle 的 timestamp_ms 读出来是 Date，
        // 序列化成 JSON 会变成 ISO 字符串，前端还得再 parse 一次。
        // null 表示「从来没连过」或「连过但还没有记录」，前端显示「未知」。
        lastSeenAt: row.lastSeenAt === null ? null : row.lastSeenAt.getTime(),
        mutedUntil: row.mutedUntil === null ? null : row.mutedUntil.getTime(),
        muted: row.mutedUntil !== null && row.mutedUntil.getTime() > now,
      })),
    })
  })

  /**
   * 历史消息，倒序取一页再翻正，前端可以直接 append。
   *
   * 游标是**复合键** `(before, beforeId)` = 上一页最早那条的 `(createdAt, id)`。
   * 不用 offset —— nanoka 也把 offset 卡在 10 万以内防读放大。
   *
   * ## 为什么必须是复合键
   *
   * `createdAt` 是毫秒整数、**不唯一**。只用 `createdAt < ?` 的话，
   * 一页正好切在一组同毫秒消息中间时，那几个同毫秒、本页没包含的消息
   * 下一页会被一起排掉 —— 它们从此再也翻不出来（消息静默丢失）。
   * 加上 id 之后 `(createdAt, id)` 是全序，游标才能精确地「续上」。
   *
   * `beforeId` 缺失时退回单键比较。这是**故意留的兼容口**：
   * 手工拼的 URL、旧标签页里跑着的旧版前端都还能用，代价只是那些请求
   * 仍可能有丢条风险（和修之前一样），而不是直接 400。
   */
  app.get('/api/messages', cookieAuthBridge, auth.middleware(), async (c) => {
    /*
     * 和其它需要登录的路由保持一致：**查历史之前先确认账号还在**。
     *
     * 少了这一步，被管理员注销的账号在 access token 剩余有效期内（≤30 分钟）
     * 仍能反复拉取全部历史消息 —— 而它的 WebSocket 也已经被踢了
     * （见 SocketAttachment.exp），会出现「实时收不到、但能刷新出全部记录」
     * 这种半死状态，看着像 bug，实际是这一条漏了。
     */
    const me = await User.findOne(requireSubject(c))
    if (me === null) throw new HTTPException(401, { message: '账号不存在' })

    const room = normalizeRoom(c.req.query('room'))
    const beforeRaw = c.req.query('before')
    const beforeValue = beforeRaw === undefined ? Number.NaN : Number.parseInt(beforeRaw, 10)
    const beforeId = c.req.query('beforeId')

    const conditions = [eq(Message.table.room, room), eq(Message.table.deleted, false)]
    if (Number.isFinite(beforeValue)) {
      if (beforeId === undefined || beforeId === '') {
        conditions.push(lt(Message.table.createdAt, new Date(beforeValue)))
      } else {
        /*
         * 行值比较 `(createdAt, id) < (?, ?)`，而不是
         * `createdAt < ? OR (createdAt = ? AND id < ?)`。
         *
         * 两个写法结果一样，但**只有行值形式能稳定用上索引**：
         * SQLite 对索引列上的行值比较有专门的优化，能把它变成一次索引区间扫描；
         * 而 OR 形式在查询计划里经常退化成「全房间扫 + 排序」。
         * 这里的行数上限直接等于 D1 的计费口径，所以写法值得挑。
         *
         * 参数传的是**裸毫秒数**而不是 Date：`createdAt` 列在库里就是
         * 整数（timestamp_ms），绑整数最直接；raw `sql` 模板不会帮我们
         * 把 Date 转成毫秒，硬塞 Date 会变成字符串比较，那才是真正会出错的地方。
         */
        conditions.push(
          sql`(${Message.table.createdAt}, ${Message.table.id}) < (${beforeValue}, ${beforeId})`,
        )
      }
    }

    // 这里走 app.db（原始 Drizzle）而不是 Message.findMany：
    // 需要范围条件 + 倒序 + limit 的组合，模型 API 的 where 等值对象表达不了，
    // 而下面那个复合索引正是按这个查询形状建出来的。
    //
    // 结果需要显式标注：nanoka 的 `Model.table` 为了通用性把列类型放宽成了 unknown，
    // 所以 Drizzle 推不出每列的具体类型（拿到的 row.id 会是 unknown）。
    // 这份标注与 drizzle/schema.ts 里的列定义一一对应。
    //
    // ⚠️ ORDER BY 里必须有 id，而且**索引也必须跟着带上 id**：
    // `messages.id` 是 text 主键（不是 rowid），同一毫秒内它的顺序和索引里的
    // 隐含顺序（rowid 升序）不一致。只把 id 加进 ORDER BY、不动索引的话，
    // 老索引就满足不了排序，SQLite 会把**整个房间**的行读出来再排序 ——
    // 那等于把 `0001_chat_indexes.sql` 省下来的读取额度连本带利花回去。
    // 索引见 `0006_messages_cursor_index.sql`。
    const rows = (await app.db
      .select({
        id: Message.table.id,
        userId: Message.table.userId,
        username: Message.table.username,
        body: Message.table.body,
        kind: Message.table.kind,
        createdAt: Message.table.createdAt,
      })
      .from(Message.table)
      .where(and(...conditions))
      .orderBy(desc(Message.table.createdAt), desc(Message.table.id))
      .limit(HISTORY_PAGE_SIZE + 1)) as HistoryRow[]

    // 多取一条用来判断「还有没有更早的」，省掉一次 count(*)。
    const hasMore = rows.length > HISTORY_PAGE_SIZE
    const page = rows.slice(0, HISTORY_PAGE_SIZE).reverse()

    return c.json({
      room,
      hasMore,
      messages: page.map(
        (row): ChatMessage => ({
          id: row.id,
          userId: row.userId,
          username: row.username,
          body: row.body,
          kind: row.kind,
          createdAt: row.createdAt.getTime(),
        }),
      ),
    })
  })

  app.post('/api/messages', cookieAuthBridge, auth.middleware(), async (c) => {
    const sub = requireSubject(c)

    const parsed = postMessageSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? '输入不合法' }, 400)
    }

    // `+1` 的由来：`consumeRateLimit` 是「先记账再判断」，传 N 表示窗口里的
    // 第 N 次被拦 —— 想放行 10 次就得传 11。常量的名字已经是「允许的次数」，
    // 所以这里一定能看见 `+ 1`，不要让调用点直接写数字。
    const attempt = await consumeRateLimit(
      c.env.DB,
      `message:${sub}`,
      effectiveLimit(c.env, MESSAGE_ALLOWED_PER_WINDOW + 1),
      MESSAGE_WINDOW_SECONDS,
    )
    if (attempt.blocked) {
      c.header('Retry-After', String(attempt.retryAfterSeconds))
      return c.json({ error: `发得太快了，${attempt.retryAfterSeconds} 秒后再试` }, 429)
    }

    const user = await User.findOne(sub)
    if (user === null) throw new HTTPException(401, { message: '账号不存在' })

    // 禁言检查放在**限流之后、真正落库之前**：
    //   - 放限流之后，被禁言的人发消息照样占限流额度（想刷也刷不动，
    //     因为他根本发不出去），但「限流」和「禁言」是两种不同的拒绝，
    //     先报限流更贴近用户当下的真实处境；
    //   - 放落库之前是必须的，别写成「先存了再判断要不要删」。
    if (isMuted(user)) {
      return c.json({ error: `你已被禁言，还剩 ${mutedRemaining(user.mutedUntil!)}` }, 403)
    }

    const room = normalizeRoom(parsed.data.room)
    // Message.create 内部用了 `INSERT ... RETURNING`，所以这里能直接拿到
    // 由数据库默认值生成的 createdAt，不需要再查一次。
    const created = await Message.create({
      room,
      userId: user.id,
      username: user.username,
      body: parsed.data.body,
    })

    const message: ChatMessage = {
      id: created.id,
      userId: created.userId,
      username: created.username,
      body: created.body,
      // 从库里的返回值读，而不是把 `'user'` 写死在这儿：
      // 默认值定义在表结构上（models/message.ts），这里写死就等于同一件事有两个出处。
      kind: created.kind,
      createdAt: created.createdAt.getTime(),
    }

    await broadcast(c.env, room, { type: 'message', message })
    return c.json({ message }, 201)
  })

  /** 撤回：作者本人或管理员可以软删。 */
  app.delete('/api/messages/:id', cookieAuthBridge, auth.middleware(), async (c) => {
    const sub = requireSubject(c)
    const id = c.req.param('id')

    // 限流放在**查库之前**，是刻意的 fail-closed：
    //
    //  - 位置的差别在这里很实在。放到 `Message.findOne` 后面，攻击者拿随机 id 打过来
    //    就是无限次「读一行 + 404」，这一层保护等于没有——而这条路由原先连这个都没有。
    //  - 代价是「本来就删不掉」的请求（消息已被别人删掉、id 不存在）也会占额度。
    //    这在真实使用里可以忽略：前端一个消息只渲染一个撤回按钮，点两下、第二下拿到 404
    //    就到头了，而额度是 30 次/分钟。
    //  - 用 `delete:<userId>` 而不是复用发言那个 key，否则「连撤几条旧消息」会把人
    //    接下来的发言一起锁掉。原因写在 config.ts 那个常量上。
    const attempt = await consumeRateLimit(
      c.env.DB,
      `delete:${sub}`,
      effectiveLimit(c.env, DELETE_ALLOWED_PER_WINDOW + 1),
      DELETE_WINDOW_SECONDS,
    )
    if (attempt.blocked) {
      c.header('Retry-After', String(attempt.retryAfterSeconds))
      return c.json({ error: `撤回得太频繁了，${attempt.retryAfterSeconds} 秒后再试` }, 429)
    }

    const target = await Message.findOne(id)
    if (target === null || target.deleted) {
      return c.json({ error: '消息不存在' }, 404)
    }

    /*
     * 系统提示不能被撤回。
     *
     * 它不是谁「说」出来的话，撤回它没有语义；更实际的问题是**撤回本身会产生
     * 一条新的系统提示** —— 允许撤回等于用一个提示去删另一个提示，越删越乱。
     * 想清理就清空房间（硬删，那条路不会写提示）。
     *
     * 前端的渲染层根本不会给系统提示加撤回按钮，所以这一条主要是挡住
     * 手拼的请求（以及将来某个忘了判断 `kind` 的调用方）。
     * 放在归属判断**之前**：它跟「你是谁」无关，能省掉那次查库。
     */
    if (target.kind !== KIND_USER) {
      return c.json({ error: '系统提示不能被撤回' }, 403)
    }

    const me = await User.findOne(sub)
    if (me === null) throw new HTTPException(401, { message: '账号不存在' })

    if (target.userId !== me.id && me.role !== 'admin') {
      return c.json({ error: '只能撤回自己的消息' }, 403)
    }

    // 审计：记下**操作者**是谁、什么时候做的。
    //
    // deletedBy 存的是 me.id（操作者），不是 target.userId（作者）——
    // 自己撤自己的消息时这俩一样，但管理员撤别人的消息时不一样，
    // 而恰恰是后者才需要事后能查出来。
    //
    // 没有这两个字段的话，messages 表里只剩一个 `deleted = true`，
    // 你只能知道「它被删了」，回答不了「谁删的」，
    // README 里那句「软删方便留着追责」就是句空话。
    await Message.update(id, {
      deleted: true,
      deletedBy: me.id,
      deletedAt: new Date(),
    })

    // 撤回要连带把消息里引用的媒体对象也删掉（用户明确要求）。
    //
    // 删之前必须 head 一下确认 uploader 就是这条消息的作者 ——
    // 否则有人可以在自己的消息里写上**别人图片的 URL**，然后撤回，
    // 把别人的文件删了。这不是理论风险，是这一版必须堵的洞。
    const mediaKeys = extractMediaKeys(target.body)
    for (const key of mediaKeys) {
      try {
        const object = await c.env.MEDIA.head(key)
        if (object === null) continue

        /*
         * 归属判断优先用**不可变的 userId**，而不是用户名。
         *
         * 用户名是可复用的：账号被注销后 `users` 里那行就没了，别人可以
         * 注册同名账号 —— 只按用户名比对会让他有权删掉前任上传的文件。
         * userId 不复用，没有这个问题。
         *
         * 退回用户名是为了兼容这次改动**之前**上传的老对象（metadata 里
         * 没有 uploaderId）。老对象的主人必须还能删自己的文件，
         * 否则就成了「历史文件谁都删不掉」，比不修还糟。
         * 判断的是「有没有这个字段」而不是「它是不是空」——
         * 空字符串也是一个明确的（且匹配不上的）值。
         */
        const metadata = object.customMetadata ?? {}
        const owned =
          metadata['uploaderId'] !== undefined
            ? metadata['uploaderId'] === target.userId
            : metadata['uploader'] === target.username
        if (!owned) continue

        await c.env.MEDIA.delete(key)

        // 顺手把当初占用的上传额度退回来。不退的话，用户「传了又删」几次
        // 就把自己一天的额度耗光了，看着莫名其妙。
        // 必须按**当初上传那天**退 —— 用今天的话，跨日撤回就等于凭空多出额度。
        const day = object.customMetadata?.['day']
        if (day !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
          await refundUpload(c.env.DB, target.userId, object.size, day)
        }
      } catch {
        // 删文件或退额度失败都不该让撤回本身失败：消息已经标记删除了，
        // 最坏的结果是 R2 里留一个没人引用的孤儿对象，或者额度少退一次。
      }
    }

    /*
     * 撤回要在聊天记录里留下痕迹，而不是让那条消息「凭空消失」。
     *
     * 只发 `{type:'deleted'}` 的话，正在看的人只看到气泡不见了 —— 而他可能
     * 刚读到一半；刷新之后更是彻底无迹可寻。补一条系统提示回答「这里发生了什么」。
     *
     * 文案区分**自己撤**和**管理员撤别人的**（见 `withdrawNotice`）：
     * 后者是管理动作，必须一眼看得出来，这也是 `deletedBy` 那个审计字段存在的理由。
     *
     * ⚠️ 用 `me.username`（操作者）和 `target.username`（作者）拼，
     * 不能两个都用 me —— 那样管理员撤回别人消息时会写成「管理员 撤回了一条消息」，
     * 读的人根本不知道被撤的是谁说的。
     *
     * 写失败只记日志：撤回本身**已经生效**（`deleted = true` 已经落库、媒体也删了），
     * 为了补不上一条提示就把整个请求报成 500，会让前端显示「撤回失败」——
     * 而用户再点一次只会拿到 404。宁可少一条提示，也不能谎报失败。
     */
    let notice: ChatMessage | null = null
    try {
      const row = systemMessage(target.room, withdrawNotice(me.username, target.username))
      await insertSystemMessage(c.env.DB, row)
      notice = row
    } catch (error) {
      console.error('写撤回提示失败', { room: target.room, id, error })
    }

    // 顺序：先「这条消息没了」，再「这里发生过什么」。
    // 反过来的话，正在看的人会先看到一句「撤回了一条消息」，然后气泡才消失。
    await broadcast(c.env, target.room, { type: 'deleted', room: target.room, id })
    if (notice !== null) {
      await broadcast(c.env, target.room, { type: 'message', message: notice })
    }
    return c.json({ ok: true })
  })

  /**
   * 导出房间的全部消息（仅管理员）。
   *
   * 返回**原始数据**，不在这里拼 markdown —— 格式是展示层的事，
   * 后端猜错了就得改接口，不如让前端拿到之后想存成 md 还是 json 都行。
   *
   * 一次最多 `EXPORT_LIMIT` 条，超了截断并带 `truncated` 标记。
   * 这个上限是被 **CPU 10 ms / 请求**卡住的（实测 5000 条顶格消息要 9–13 ms，会 1102），
   * 不是被响应体积卡住的。理由和实测数据见 `config.ts` 里那个常量。
   *
   * ## `truncated` 为什么要多取一条
   *
   * 原先取 `EXPORT_LIMIT` 条、再判 `rows.length >= EXPORT_LIMIT`。
   * 房间**恰好**有 1000 条时，`1000 >= 1000` 成立 → 谎报截断，
   * 前端会告诉用户「还有更早的没导出」—— 其实一条不多不少全在手里。
   * 改取 1001 条、判 `> EXPORT_LIMIT`，和 `GET /api/messages` 里
   * `hasMore = rows.length > HISTORY_PAGE_SIZE` 的写法一致。
   * 多取这一条的开销可以忽略（序列化的仍然是 1000 条）。
   */
  app.get('/api/rooms/:room/export', cookieAuthBridge, auth.middleware(), async (c) => {
    const room = normalizeRoom(c.req.param('room'))
    await requireAdmin(c, User)

    const rows = (await app.db
      .select({
        id: Message.table.id,
        userId: Message.table.userId,
        username: Message.table.username,
        body: Message.table.body,
        kind: Message.table.kind,
        createdAt: Message.table.createdAt,
      })
      .from(Message.table)
      .where(and(eq(Message.table.room, room), eq(Message.table.deleted, false)))
      .orderBy(asc(Message.table.createdAt), asc(Message.table.id))
      .limit(EXPORT_LIMIT + 1)) as HistoryRow[]

    const truncated = rows.length > EXPORT_LIMIT
    const page = truncated ? rows.slice(0, EXPORT_LIMIT) : rows

    return c.json({
      room,
      count: page.length,
      truncated,
      messages: page.map((row) => ({
        id: row.id,
        username: row.username,
        body: row.body,
        // 导出也要带上 kind，否则系统提示在导出文件里会显示成
        // 「系统: 雨落 加入了房间」—— 像是一个叫「系统」的人在说话，
        // 而它其实只是一条提示。前端据此把它排成一行引用（`> …`）。
        kind: row.kind,
        createdAt: row.createdAt.getTime(),
      })),
    })
  })

  /** `R2Bucket.delete()` 一次最多能删多少个 key（官方硬上限，也是免费套餐内部子请求的合理粒度）。 */
  const R2_DELETE_BATCH = 1000

  /**
   * 改密码限额：同一账号 1 分钟内最多 30 次。
   *
   * 说它是「限额」有点勉强 —— 30 次/分钟明显不是给人用的量级，正常账号
   * 一辈子也就改几次。这里**真正在乎的是「有人拿着别人的 access token 刷」**，
   * 因为每一次都要跑一次 scrypt 验旧密码 + 一次 scrypt 哈希新密码：
   * scrypt 的设计目标就是「慢到爆破不划算」，单次开销是登录的数倍，
   * 不限流就等于给了一个 CPU 放大器（免费套餐只有 10 ms CPU/请求）。
   *
   * 所以这个数字是「用起来绝不会碰到、同时把放大倍数按死」的折中，
   * 和别的路由统一成 30 次/分钟，不再单独收窄。
   */
  const PASSWORD_CHANGE_LIMIT = 30
  const PASSWORD_CHANGE_WINDOW_SECONDS = 60

  const passwordSchema = z.object({
    currentPassword: z.string().min(1, '请输入当前密码').max(128, '密码最多 128 位'),
    newPassword: z.string().min(8, '新密码至少 8 位').max(128, '新密码最多 128 位'),
  })

  /**
   * 改密码。
   *
   * ## 为什么必须验旧密码
   *
   * 这是最容易被省掉、也最不该省的一步。没有它的话，任何能碰到你已登录浏览器的人
   * （借用电脑、离开时没锁屏、XSS 拿到执行上下文）都能直接改掉你的密码，
   * 把你永久锁在门外 —— 而 access token 还在他那边的 localStorage 里。
   *
   * ## 改完为什么要吊销所有 refresh token
   *
   * 改密码的**意义**是「别人拿不到我的账号了」。如果只改哈希、不吊销，
   * 之前泄露出去的 refresh token 还能继续换出新 access token ——
   * 等于密码改了但没实际生效。吊销之后，那些 token 换不出任何东西。
   *
   * ⚠️ 顺序不能反：先写新哈希、再吊销。反过来的话，中间失败会留下
   * 「密码没改但 token 全废」的状态，用户直接登不进去。
   */
  app.post(
    '/api/me/password',
    cookieAuthBridge,
    auth.middleware(),
    async (c) => {
      const sub = requireSubject(c)
      const user = await User.findOne(sub)
      if (user === null) throw new HTTPException(401, { message: '账号不存在' })

      // 限流放在验密码**之前**：一次请求只跑一次 scrypt，挡住就完全不烧 CPU。
      // 放后面的话，已经付出了验签的代价再告诉用户「太频繁」，等于没限。
      const attempt = await consumeRateLimit(
        c.env.DB,
        `password:${sub}`,
        effectiveLimit(c.env, PASSWORD_CHANGE_LIMIT + 1),
        PASSWORD_CHANGE_WINDOW_SECONDS,
      )
      if (attempt.blocked) {
        c.header('Retry-After', String(attempt.retryAfterSeconds))
        // 窗口是 1 分钟，所以按秒说就够了 —— 按分钟算会一律显示「1 分钟」，
        // 反而比秒数更糊。
        return c.json(
          { error: `改密码太频繁了，${attempt.retryAfterSeconds} 秒后再试` },
          429,
        )
      }

      const body = (await c.req.json().catch(() => null)) as {
        currentPassword?: unknown
        newPassword?: unknown
      } | null

      const parsed = passwordSchema.safeParse({
        currentPassword: typeof body?.currentPassword === 'string' ? body.currentPassword : '',
        newPassword: typeof body?.newPassword === 'string' ? body.newPassword : '',
      })
      if (!parsed.success) {
        return c.json({ error: parsed.error.issues[0]?.message ?? '输入不合法' }, 400)
      }

      const { currentPassword, newPassword } = parsed.data

      // 旧密码错**不能报「密码不对」**：等于确认了这个账号存在。
      // 统一说「当前密码不正确」，覆盖「账号不存在」和「密码不对」两种情况。
      const matches = await scryptHasher.verify(currentPassword, user.password)
      if (!matches) {
        return c.json({ error: '当前密码不正确' }, 403)
      }

      if (currentPassword === newPassword) {
        return c.json({ error: '新密码不能和当前密码一样' }, 400)
      }

      const hash = await scryptHasher.hash(newPassword)
      await User.update(user.id, { password: hash })

      // 吊销这个账号所有还活着的 refresh token，让改密码**真的**生效。
      // 不吊销的话，密码改了，之前泄露的 token 照样能换出新 access token。
      const revoked = await revokeAllSessions(c.env.DB, user.id)
      deleteCookie(c, REFRESH_TOKEN_COOKIE, { path: '/' })

      return c.json({ ok: true, revokedSessions: revoked })
    },
  )

  /**
   * 清空整个房间（仅管理员）。**硬删**，不是软删 —— 这是「清空」不是「撤回」。
   *
   * 消息里引用的媒体对象也一并删掉，否则它们会变成没人引用的孤儿：
   * 白占 R2 空间，而且那些 URL 是公开的，等于内容其实没清干净。
   *
   * ## 为什么必须批量删，而不是一个 key 一次 delete
   *
   * Workers 免费套餐对 **Cloudflare 内部服务**的子请求上限是 **1000 次 / 调用**
   * （对外部网络只有 50 次，别混淆）。而 `MEDIA.delete(key)` 每调一次就是一个内部子请求。
   * 房间里的文件一旦超过 1000 个，就会在第 1001 个上直接失败。
   *
   * 失败之所以致命，是因为异常被下面的 `catch` 吞掉、`app.db.delete` 照常执行：
   * **消息全没了、文件永久残留**，而那些文件的 URL 是公开可访问的 ——
   * 等于「清空」只清掉了一半，而且是不可恢复的那一半。
   *
   * `delete()` 接受 key 数组（一次最多 1000 个），所以按 1000 一批删干净。
   *
   * ## 为什么这里不加分页
   *
   * 分页查消息会**多花 D1 查询**，而 D1 查询的上限（50 次 / 调用）比 R2 子请求
   * （1000 次）稀缺得多，是更紧的约束。消息正文一行最多 500 字，一间房全部读进来
   * 的内存占用在这个应用的量级下完全可接受，所以保持「一条 SQL 查完」。
   */
  app.delete('/api/rooms/:room', cookieAuthBridge, auth.middleware(), async (c) => {
    const room = normalizeRoom(c.req.param('room'))
    const admin = await requireAdmin(c, User)

    const rows = (await app.db
      .select({ body: Message.table.body })
      .from(Message.table)
      .where(eq(Message.table.room, room))) as { body: string }[]

    // 用 Set 去重：同一个文件可能被多条消息引用（比如重复贴同一个链接），
    // 去重后既能少删一次（省一次子请求额度），removedMedia 的数字也才准。
    const keys = new Set<string>()
    for (const row of rows) {
      for (const key of extractMediaKeys(row.body)) keys.add(key)
    }

    let removedMedia = 0
    const all = [...keys]
    for (let offset = 0; offset < all.length; offset += R2_DELETE_BATCH) {
      const batch = all.slice(offset, offset + R2_DELETE_BATCH)
      try {
        await c.env.MEDIA.delete(batch)
        removedMedia += batch.length
      } catch {
        // 一批删失败不该让整个清空回滚，继续删剩下的。
        // 注意这里的后果：这一批文件会变成孤儿（消息没了、文件还在），
        // 但总好过整个请求失败、连消息都留在那里。批量之后失败面已经从
        // 「1001 个文件里坏一个」缩到「1000 个一批」，概率低得多。
        console.error('清空房间时删除媒体失败', { room, batch: batch.length, offset })
      }
    }

    await app.db.delete(Message.table).where(eq(Message.table.room, room))

    // 审计流水。这一步必须**在硬删之后**才准（数字已经算出来了），
    // 而且即便写入失败也不能让清空本身失败 —— 消息已经删了，
    // 回滚不回去，为了记一笔流水把整个操作报成 500 只会让人以为没删成。
    try {
      await RoomPurge.create({
        room,
        purgedBy: admin.id,
        purgedByUsername: admin.username,
        removedMessages: rows.length,
        removedMedia,
      })
    } catch (error) {
      console.error('清空房间的审计流水写入失败', { room, admin: admin.username, error })
    }

    await broadcast(c.env, room, { type: 'purged', room })

    return c.json({ ok: true, removedMessages: rows.length, removedMedia })
  })

  /**
   * WebSocket 入口。这一条**不做**鉴权，而是原样转发给 Durable Object 去验。
   *
   * 原因是升级请求不能被 clone：为了让 DO 从 header 里读到身份，
   * 就得 `new Request(original, { headers })`，而这个新 Request 已经不是
   * 「运行时的升级请求」了，DO 里的 `acceptWebSocket()` 会直接拒绝。
   * 所以这里只做能做的事（Origin 校验），身份校验交给 room.ts。
   */
  app.get('/api/ws', cookieAuthBridge, auth.middleware(), async (c) => {
    // 跨站 WebSocket 劫持（CSWSH）防护：WebSocket 握手不受 CORS 约束，
    // 浏览器一定会带上目标域的 Cookie。不查 Origin 的话，任意站点都能
    // 用访客的身份建连、然后把聊天内容读走。
    if (!isAllowedOrigin(c.env.ALLOWED_ORIGINS, c.req.header('Origin'))) {
      return c.json({ error: '来源不被允许' }, 403)
    }

    const room = normalizeRoom(c.req.query('room'))

    // 禁言的人不许连 WebSocket。
    //
    // **这一处最容易漏**：发言和上传拦住了，但他还能连着收消息、
    // 还能占着 DO 的连接数，在成员名单里还显示成「在线」——
    // 那等于禁言只禁了一半。三处（发言 / 上传 / 握手）必须一起拦。
    //
    // 这里给 /api/ws 挂上 auth.middleware() 是为了让 `c.get('user')` 有值：
    // 原来这条路由不做鉴权（校验在 DO 里），于是 Worker 这层拿不到 sub、
    // 也就查不了 mutedUntil。中间件只是读 Cookie 往 c 上挂个 user，
    // 真正转发给 DO 的仍然是 `c.req.raw` 原始请求（见坑列表第 4 条）。
    const sub = c.get('user')['sub']
    if (typeof sub === 'string' && sub.length > 0) {
      const user = await User.findOne(sub)
      if (isMuted(user)) {
        return c.json({ error: `你已被禁言，还剩 ${mutedRemaining(user!.mutedUntil!)}` }, 403)
      }
    }

    const stub = c.env.CHAT_ROOM.get(c.env.CHAT_ROOM.idFromName(room))
    return stub.fetch(c.req.raw)
  })
}
