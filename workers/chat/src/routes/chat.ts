import { and, asc, desc, eq, lt } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import type { Context } from 'hono'
import { z } from 'zod'

import { DEFAULT_ROOM, EXPORT_LIMIT, HISTORY_PAGE_SIZE, MEMBER_LIST_LIMIT } from '../config'
import { extractMediaKeys } from '../media'
import { refundUpload } from '../quota'
import type { AppEnv, ChatContext } from '../context'
import type { Env } from '../env'
import { cookieAuthBridge } from '../middleware'
import { isAllowedOrigin } from '../origins'
import type { ChatMessage, ChatServerEvent } from '../types'

/** 同一个人的两条消息之间至少隔这么久。 */
const MESSAGE_MIN_INTERVAL_MS = 1500

const postMessageSchema = z.object({
  body: z.string().trim().min(1, '消息不能为空').max(500, '单条消息最多 500 字'),
  room: z.string().optional(),
})

/** 历史查询的返回形状，对应 drizzle/schema.ts 里 messages 表的列。 */
interface HistoryRow {
  id: string
  userId: string
  username: string
  body: string
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
async function requireAdmin(c: Context<AppEnv>, User: ChatContext['User']): Promise<void> {
  const sub = requireSubject(c)
  const user = await User.findOne(sub)
  if (user === null) throw new HTTPException(401, { message: '账号不存在' })
  if (user.role !== 'admin') throw new HTTPException(403, { message: '只有管理员能做这个操作' })
}

/**
 * 发言频率限制放在 isolate 内存里，而不是 D1。
 *
 * 理由：这条路径每条消息本来就有「读用户 + 写消息」两次 D1 往返了，
 * 再为限流加一次写，延迟和额度都不划算。内存版是**软限制**——
 * Workers 的 isolate 按 POP 分布，理论上用户跨 isolate 能绕过；
 * 但这个限制的目的是防手滑连点和简单刷屏，不是安全边界（安全边界是登录态 + 长度上限）。
 */
const lastPostAt = new Map<string, number>()

function throttleMessage(userId: string): number | null {
  const now = Date.now()
  const last = lastPostAt.get(userId)
  if (last !== undefined && now - last < MESSAGE_MIN_INTERVAL_MS) {
    return Math.max(1, Math.ceil((MESSAGE_MIN_INTERVAL_MS - (now - last)) / 1000))
  }
  lastPostAt.set(userId, now)

  // Map 会长大，顺手清掉过期的键（只在超过阈值时才做，避免每条消息都遍历）。
  if (lastPostAt.size > 512) {
    for (const [key, timestamp] of lastPostAt) {
      if (now - timestamp > MESSAGE_MIN_INTERVAL_MS) lastPostAt.delete(key)
    }
  }
  return null
}

/** 把事件交给该房间的 Durable Object 去推给所有在线连接。 */
async function broadcast(env: Env, room: string, event: ChatServerEvent): Promise<void> {
  const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(room))
  await stub.fetch('https://chat-room.internal/broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event }),
  })
}

export function registerChatRoutes({ app, User, Message, auth }: ChatContext): void {
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
   * 成员名单：所有已注册账号，外加各自此刻在不在线。
   *
   * 在线状态只有 Durable Object 知道（连接握在它手里），所以这里问一次 DO 的 /online；
   * 离线账号从 D1 取。两边的交集就是在线名单。
   *
   * 返回**扁平数组**而不是分好组的两份列表：排序是展示层的事，
   * 前端想按在线优先排、还是加个搜索框筛，都不用再改后端。
   */
  app.get('/api/members', cookieAuthBridge, auth.middleware(), async (c) => {
    const room = normalizeRoom(c.req.query('room'))
    const me = await User.findOne(requireSubject(c))
    if (me === null) throw new HTTPException(401, { message: '账号不存在' })

    const stub = c.env.CHAT_ROOM.get(c.env.CHAT_ROOM.idFromName(room))
    let onlineIds: string[] = []
    try {
      const response = await stub.fetch('https://chat-room.internal/online')
      if (response.ok) {
        const payload = (await response.json()) as { userIds?: unknown }
        if (Array.isArray(payload.userIds)) {
          onlineIds = payload.userIds.filter((id): id is string => typeof id === 'string')
        }
      }
    } catch {
      // DO 临时拿不到就当作「没人在线」，不能因为这一处把整个名单接口拖挂。
    }
    const online = new Set(onlineIds)

    // users 是小表，一次取完最省事；MEMBER_LIST_LIMIT 只是防呆上限。
    const rows = (await app.db
      .select({
        id: User.table.id,
        username: User.table.username,
        role: User.table.role,
      })
      .from(User.table)
      .orderBy(asc(User.table.username))
      .limit(MEMBER_LIST_LIMIT)) as { id: string; username: string; role: string }[]

    return c.json({
      room,
      total: rows.length,
      members: rows.map((row) => ({
        id: row.id,
        username: row.username,
        role: row.role,
        online: online.has(row.id),
      })),
    })
  })

  /**
   * 历史消息，倒序取一页再翻正，前端可以直接 append。
   * `before` 是上一页最早那条的 createdAt（epoch 毫秒），游标分页，
   * 不用 offset —— nanoka 也把 offset 卡在 10 万以内防读放大。
   */
  app.get('/api/messages', cookieAuthBridge, auth.middleware(), async (c) => {
    const room = normalizeRoom(c.req.query('room'))
    const beforeRaw = c.req.query('before')
    const beforeValue = beforeRaw === undefined ? Number.NaN : Number.parseInt(beforeRaw, 10)

    const conditions = [eq(Message.table.room, room), eq(Message.table.deleted, false)]
    if (Number.isFinite(beforeValue)) {
      conditions.push(lt(Message.table.createdAt, new Date(beforeValue)))
    }

    // 这里走 app.db（原始 Drizzle）而不是 Message.findMany：
    // 需要 `createdAt < ?` 这种范围条件 + 倒序 + limit 的组合，模型 API 的
    // where 等值对象表达不了，而下方的复合索引正是按这个查询形状建的。
    //
    // 结果需要显式标注：nanoka 的 `Model.table` 为了通用性把列类型放宽成了 unknown，
    // 所以 Drizzle 推不出每列的具体类型（拿到的 row.id 会是 unknown）。
    // 这份标注与 drizzle/schema.ts 里的列定义一一对应。
    const rows = (await app.db
      .select({
        id: Message.table.id,
        userId: Message.table.userId,
        username: Message.table.username,
        body: Message.table.body,
        createdAt: Message.table.createdAt,
      })
      .from(Message.table)
      .where(and(...conditions))
      .orderBy(desc(Message.table.createdAt))
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

    const retryAfter = throttleMessage(sub)
    if (retryAfter !== null) {
      c.header('Retry-After', String(retryAfter))
      return c.json({ error: `发得太快了，${retryAfter} 秒后再试` }, 429)
    }

    const user = await User.findOne(sub)
    if (user === null) throw new HTTPException(401, { message: '账号不存在' })

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
      createdAt: created.createdAt.getTime(),
    }

    await broadcast(c.env, room, { type: 'message', message })
    return c.json({ message }, 201)
  })

  /** 撤回：作者本人或管理员可以软删。 */
  app.delete('/api/messages/:id', cookieAuthBridge, auth.middleware(), async (c) => {
    const sub = requireSubject(c)
    const id = c.req.param('id')

    const target = await Message.findOne(id)
    if (target === null || target.deleted) {
      return c.json({ error: '消息不存在' }, 404)
    }

    const me = await User.findOne(sub)
    if (me === null) throw new HTTPException(401, { message: '账号不存在' })

    if (target.userId !== me.id && me.role !== 'admin') {
      return c.json({ error: '只能撤回自己的消息' }, 403)
    }

    await Message.update(id, { deleted: true })

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
        if (object.customMetadata?.['uploader'] !== target.username) continue

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

    await broadcast(c.env, target.room, { type: 'deleted', room: target.room, id })
    return c.json({ ok: true })
  })

  /**
   * 导出房间的全部消息（仅管理员）。
   *
   * 返回**原始数据**，不在这里拼 markdown —— 格式是展示层的事，
   * 后端猜错了就得改接口，不如让前端拿到之后想存成 md 还是 json 都行。
   *
   * 一次最多 `EXPORT_LIMIT` 条，超了截断并带 `truncated` 标记，
   * 免得某个房间攒了几万条时把响应体撑爆。
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
        createdAt: Message.table.createdAt,
      })
      .from(Message.table)
      .where(and(eq(Message.table.room, room), eq(Message.table.deleted, false)))
      .orderBy(asc(Message.table.createdAt))
      .limit(EXPORT_LIMIT)) as HistoryRow[]

    return c.json({
      room,
      count: rows.length,
      truncated: rows.length >= EXPORT_LIMIT,
      messages: rows.map((row) => ({
        id: row.id,
        username: row.username,
        body: row.body,
        createdAt: row.createdAt.getTime(),
      })),
    })
  })

  /**
   * 清空整个房间（仅管理员）。**硬删**，不是软删 —— 这是「清空」不是「撤回」。
   *
   * 消息里引用的媒体对象也一并删掉，否则它们会变成没人引用的孤儿：
   * 白占 R2 空间，而且那些 URL 是公开的，等于内容其实没清干净。
   */
  app.delete('/api/rooms/:room', cookieAuthBridge, auth.middleware(), async (c) => {
    const room = normalizeRoom(c.req.param('room'))
    await requireAdmin(c, User)

    const rows = (await app.db
      .select({ body: Message.table.body })
      .from(Message.table)
      .where(eq(Message.table.room, room))) as { body: string }[]

    let removedMedia = 0
    for (const row of rows) {
      for (const key of extractMediaKeys(row.body)) {
        try {
          await c.env.MEDIA.delete(key)
          removedMedia += 1
        } catch {
          // 单个对象删失败不该让整个清空回滚，继续删剩下的
        }
      }
    }

    await app.db.delete(Message.table).where(eq(Message.table.room, room))
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
  app.get('/api/ws', async (c) => {
    // 跨站 WebSocket 劫持（CSWSH）防护：WebSocket 握手不受 CORS 约束，
    // 浏览器一定会带上目标域的 Cookie。不查 Origin 的话，任意站点都能
    // 用访客的身份建连、然后把聊天内容读走。
    if (!isAllowedOrigin(c.env.ALLOWED_ORIGINS, c.req.header('Origin'))) {
      return c.json({ error: '来源不被允许' }, 403)
    }

    const room = normalizeRoom(c.req.query('room'))
    const stub = c.env.CHAT_ROOM.get(c.env.CHAT_ROOM.idFromName(room))
    return stub.fetch(c.req.raw)
  })
}
