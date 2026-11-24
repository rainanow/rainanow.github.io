/**
 * ChatRoom：一个聊天室一个实例，管理在线连接、文字广播和定向视频信令。
 *
 * 职责边界是刻意划的：
 *   - 文字消息在 Worker 上校验和落库，DO 广播给房间成员。
 *   - 通话由 CallSignaling 校验，只向指定连接转发。
 *
 * 用 Hibernation API（`acceptWebSocket` 而不是 `server.accept()`）：
 * 连接空闲时 DO 会被换出内存，不计 compute duration。免费套餐给的是
 * 13,000 GB-s/天，而 DO 被换出后空闲时间是不计费的——收一条消息才计一次。
 * 心跳走 `setWebSocketAutoResponse`，由运行时直接回 pong，连唤醒都不会。
 */

import { verify } from '@nanokajs/auth'

import { CallSignaling, callSocketTags } from './calls/signaling'
import type { CallDeparture } from './calls/signaling'
import { ICE_ACCESS_PATH, iceAccessSchema } from './calls/ice'
import { ACCESS_TOKEN_COOKIE, normalizeRoom } from './config'
import type { Env } from './env'
import { readAccessToken } from './origins'
import { CLOSE_SESSION_PATH, currentSessions, isAccessActive, openSessionRoom } from './sessions'
import {
  insertSystemMessage,
  joinNotice,
  leaveNotice,
  systemMessage,
} from './system-message'
import type { BroadcastRequest, ChatServerEvent, SocketAttachment } from './types'

const BROADCAST_PATH = '/broadcast'
const ONLINE_PATH = '/online'

/**
 * 同一用户的 lastSeenAt 最短间隔多久写一次（毫秒）。
 *
 * 5 分钟是权衡出来的：短于它，写入量对 D1 不友好（断连很频繁）；
 * 长于它，「几分钟前」这个显示档位会失真。5 分钟能让绝大多数
 * 「刚下线的人」落在「1 分钟前 ~ 5 分钟前」这个区间里，够用。
 */
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000

function unauthorized(reason: string): Response {
  return new Response(reason, { status: 401 })
}

export class ChatRoom implements DurableObject {
  /**
   * userId → 上次写 lastSeenAt 的时间戳（内存态）。
   *
   * 刻意**不做**持久化：DO 被驱逐后这张表清空，最坏后果只是下一次断连
   * 多写一行 D1，不会写错也不会漏写。用 storage 持久化反而多一次写。
   */
  private readonly lastSeenWrites = new Map<string, number>()

  /** 已经处理过离场的连接，用来挡「error 和 close 各播一次 leave」。见 handleDeparture。 */
  private readonly departed = new WeakSet<WebSocket>()
  private readonly calls: CallSignaling

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    this.calls = new CallSignaling(ctx, env.DB, env.VIDEO_CALL_ROOMS, this.departed)
    // 客户端每 45 秒发一次文本 "ping"，运行时直接回 "pong"：
    // 不唤醒 DO、不计 compute duration。这一条是省额度的关键。
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname === BROADCAST_PATH) return this.handleBroadcast(request)
    if (pathname === ONLINE_PATH) return this.handleOnline()
    if (pathname === CLOSE_SESSION_PATH) return this.handleCloseSession(request)
    if (pathname === ICE_ACCESS_PATH) {
      if (request.method !== 'POST') return new Response(null, { status: 405 })
      const access = iceAccessSchema.safeParse(await request.json().catch(() => undefined))
      const allowed = access.success && await this.calls.canIssueIce(access.data)
      return new Response(null, { status: allowed ? 204 : 403 })
    }
    return this.handleUpgrade(request)
  }

  /**
   * Worker 问「现在谁连着」。和 /broadcast 一样，是给 Worker 调的内部端点，
   * DO 自己没有对外路由，外面碰不到。
   */
  private async handleOnline(): Promise<Response> {
    // `members` 是后来加的（带用户名，让 Worker 不用再查 users 表）。
    // `userIds` 保留是为了兼容老调用方，但它现在只是 members 的投影，不额外遍历。
    await this.pruneSessions()
    const members = this.onlineMembers()
    return Response.json({ userIds: members.map((m) => m.userId), members })
  }

  private async handleCloseSession(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response(null, { status: 405 })
    const payload = await request.json<{ userId?: unknown; sessionId?: unknown }>().catch(() => null)
    if (typeof payload?.userId !== 'string' || typeof payload.sessionId !== 'string') {
      return new Response(null, { status: 400 })
    }
    const departures: Promise<void>[] = []
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = this.liveAttachment(ws)
      if (attachment?.userId === payload.userId && attachment.sessionId === payload.sessionId) {
        departures.push(this.closeRevokedSocket(ws))
      }
    }
    await Promise.all(departures)
    return new Response(null, { status: 204 })
  }

  /** Worker 校验并落库之后，把事件丢过来广播。DO 没有对外的 route，只有 Worker 能调到这里。 */
  private async handleBroadcast(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 })
    }

    let payload: BroadcastRequest
    try {
      payload = await request.json<BroadcastRequest>()
    } catch {
      return new Response('Invalid JSON', { status: 400 })
    }

    const event = payload.event
    if (event === undefined || event === null || typeof event.type !== 'string') {
      return new Response('Invalid event', { status: 400 })
    }

    await this.pruneSessions()
    this.publish(event)
    return new Response(null, { status: 204 })
  }

  private async handleUpgrade(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 })
    }

    // 为什么要在这里验令牌，而不是在 Worker 里验完再把身份传进来？
    // 因为转发必须用**原始的 Request 对象**（`stub.fetch(c.req.raw)`），
    // 一旦为了让 DO 读到 `x-chat-user` 而 `new Request(original, { headers })`，
    // 这个 Request 就不是「真正的升级请求」了，DO 里的 acceptWebSocket() 会拒绝。
    // 所以身份没法通过 header 传，只能让 DO 自己从原始请求的 Cookie 里读、自己验。
    const token = readAccessToken(request, ACCESS_TOKEN_COOKIE)
    if (token === undefined) return unauthorized('Missing token')

    let payload: { sub?: unknown; sid?: unknown; type?: unknown; exp?: unknown }
    try {
      payload = await verify<typeof payload>(token, this.env.AUTH_SECRET)
    } catch {
      return unauthorized('Invalid token')
    }
    const { sub: userId, sid: sessionId, exp } = payload
    if (payload.type !== 'access' || typeof userId !== 'string' || typeof sessionId !== 'string' ||
        typeof exp !== 'number' || exp <= Math.floor(Date.now() / 1000)) {
      return unauthorized('Invalid token')
    }

    const room = normalizeRoom(new URL(request.url).searchParams.get('room'))
    await this.pruneSessions()
    // 防止这次查验与 socket 注册之间插入会话吊销请求，导致旧设备漏关。
    return this.ctx.blockConcurrencyWhile(() => this.acceptConnection(userId, sessionId, room, exp))
  }

  private async acceptConnection(userId: string, sessionId: string, room: string, exp: number): Promise<Response> {
    const member = await openSessionRoom(this.env.DB, userId, sessionId, room)
    if (member === undefined) return unauthorized('Session revoked')
    const connectionId = this.calls.enabled(room) ? crypto.randomUUID() : undefined

    const attachment: SocketAttachment = {
      userId,
      username: member.username,
      sessionId,
      exp,
      room,
      ...(connectionId === undefined ? {} : { connectionId }),
    }

    /*
     * 「这个人已经在线了吗」必须在 acceptWebSocket **之前**问 —— 之后就分不清
     * 列表里那条连接是新来的还是本来就有的了。
     *
     * 为什么要问：进出提示是按**人**算的，不是按连接算的。一个人开三个标签页
     * 是三条 WebSocket，但「雨落 加入了房间」在一份聊天记录里出现三次是荒谬的。
     * 同理离线那边（见 handleDeparture）。
     */
    const alreadyOnline = this.hasConnectionFor(userId)

    const pair = new WebSocketPair()
    const server = pair[1]
    const tags = connectionId === undefined ? undefined : callSocketTags(userId, connectionId)
    this.ctx.acceptWebSocket(server, tags)
    // 休眠会把内存里的东西全丢掉，只有 attachment 会被持久化下来。
    server.serializeAttachment(attachment)

    const ready: ChatServerEvent = { type: 'ready', online: this.onlineCount(), room }
    if (connectionId !== undefined) {
      ready.videoCalls = true
      ready.accessExpiresAt = exp * 1000
    }
    server.send(JSON.stringify(ready))
    if (connectionId !== undefined) this.calls.sendRoomSnapshot(server)

    /*
     * 这里有两种播报，去重只落在后面那一种上：
     *   - publishPresence：广播「在线人数变成了 N」。**每次**连接增减都该发，
     *     和「是不是同一个人」无关 —— 它是状态。
     *   - notifyPresence：往聊天记录里插一条「XX 加入了房间」。它是**内容**，
     *     会持久化，所以必须按人算 —— 第二、第三个标签页不该再插一条。
     */
    this.publishPresence('join', attachment.username)
    if (!alreadyOnline) {
      this.notifyPresence('join', attachment.username, room)
    }

    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // 心跳的 "ping" 已经被 setWebSocketAutoResponse 拦掉了，根本走不到这里。
    const attachment = this.liveAttachment(ws)
    if (attachment === null) return
    if (!await isAccessActive(this.env.DB, attachment.userId, attachment.sessionId)) {
      await this.closeRevokedSocket(ws)
      return
    }
    await this.calls.receive(ws, message)
  }

  async alarm(): Promise<void> {
    await this.calls.alarm()
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      // 客户端未发送关闭码时，运行时报告的 1005 不能写回关闭帧。
      if (code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code)) ws.close(code, reason)
      else ws.close()
    } catch {
      // 已经关了，无所谓。
    }
    await this.handleDeparture(ws, code === 1000 && reason === 'page closed' ? 'page-closed' : undefined)
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('chatroom websocket error', error)
    // 异常断开同样要记：用户掉线时往往就是这个路径，
    // 只在 webSocketClose 里写的话，拔网线/杀进程的人会永远停在「在线」。
    await this.handleDeparture(ws)
  }

  /**
   * 一条连接离开时统一走这里。
   *
   * ## 为什么要去重
   *
   * 同一条连接**可能先后触发两个回调**：异常断开时运行时既叫 `webSocketError`
   * 又叫 `webSocketClose`。于是「leave」会被广播两次 ——
   * 房间里其他人看到的是同一个人连着退出两回。
   * `markOffline` 有节流挡着、不会重复写库，但广播是每次都发的，挡不住。
   *
   * 用 WeakSet 按连接对象去重、**不持久化**：DO 被驱逐后集合清空，
   * 最坏结果只是多播一次 leave，不影响正确性；用 storage 持久化反而多一次写。
   */
  private async handleDeparture(ws: WebSocket, departure?: CallDeparture): Promise<void> {
    if (this.departed.has(ws)) return
    this.departed.add(ws)

    const attachment = ws.deserializeAttachment() as SocketAttachment | null
    if (attachment === null) return
    this.publishPresence('leave', attachment.username)
    this.markOffline(attachment.userId)

    /*
     * 「离开了房间」只在**这个人最后一条连接**断开时才写。
     *
     * 一个人开三个标签页、关掉其中一个是再正常不过的操作 ——
     * 每关一个就往聊天记录里插一条「XX 离开了房间」，房间会被这种噪音淹没，
     * 而且它是**持久化**的：刷出来之后就永远留在那儿，翻历史还能再看见一遍。
     * 同一个理由在 `handleUpgrade` 那边反向成立（已经在线就不再播 join）。
     *
     * 判据是「除了这条连接，还有没有别的连接挂在同一个 userId 上」，
     * 不是「连接数 == 0」——同一个人另外两个标签页还开着时连接数 ≥ 1，
     * 但那些 ws 对象和这条不是同一个，所以要把自己排除掉再问。
     */
    if (!this.hasConnectionFor(attachment.userId, ws)) {
      this.notifyPresence('leave', attachment.username, attachment.room)
    }
    await this.calls.departure(attachment, departure)
  }

  /**
   * 计数和广播共用同一个有效连接判定。旧版本尚未绑定会话的连接也要重新握手。
   */
  private liveAttachment(ws: WebSocket): (SocketAttachment & { sessionId: string }) | null {
    if (this.departed.has(ws) || ws.readyState !== WebSocket.OPEN) return null
    const attachment = ws.deserializeAttachment() as SocketAttachment | null
    if (attachment === null) return null
    const { sessionId, exp } = attachment
    if (typeof sessionId === 'string' && exp > Math.floor(Date.now() / 1000)) {
      return { ...attachment, sessionId }
    }
    this.closeSocket(ws, 4401, 'session expired')
    return null
  }

  private closeSocket(ws: WebSocket, code: number, reason: string): void {
    try { ws.close(code, reason) } catch { /* 已关。 */ }
  }

  private async closeRevokedSocket(ws: WebSocket): Promise<void> {
    try {
      ws.send(JSON.stringify({ type: 'session-revoked' } satisfies ChatServerEvent))
    } catch { /* 已关闭的连接无需通知。 */ }
    this.closeSocket(ws, 4403, 'session revoked')
    await this.handleDeparture(ws, 'session-revoked')
  }

  /** 会话通知偶尔未送达时，下一次读名单或广播会从数据库收敛到真实状态。 */
  private async pruneSessions(): Promise<void> {
    const sockets = this.ctx.getWebSockets().flatMap((ws) => {
      const attachment = this.liveAttachment(ws)
      return attachment === null ? [] : [{ ws, attachment }]
    })
    const active = await currentSessions(this.env.DB, [...new Set(sockets.map(({ attachment }) => attachment.userId))])
    await Promise.all(sockets.filter(({ attachment }) => active.get(attachment.userId) !== attachment.sessionId)
      .map(({ ws }) => this.closeRevokedSocket(ws)))
  }

  /**
   * 记下「这个人刚离线」，写进 users.lastSeenAt。
   *
   * ## 为什么要节流
   *
   * 断连事件比想象频繁得多：网络抖动、切换 WiFi、页面被浏览器挂起、
   * 心跳超时……每个都会走一次 webSocketClose 或 webSocketError。
   * 不节流的话，一个网络不稳的人一晚上能刷出几百行 D1 写。
   *
   * ## 为什么用内存 Map 而不是 DO 的 alarm 合并
   *
   * alarm 那套要先把待写集合存进 DO storage（因为 alarm 到点时 DO 可能已被驱逐，
   * 内存里的东西就没了），而每存一次本身又是一次写 —— 反而更贵。
   * 内存 Map 的代价是「DO 被驱逐后节流失效」，最坏结果就是**多写一次**，
   * 不会写错、也不会漏写。这里的正确性要求只是「lastSeen 大致准」，不需要精确。
   *
   * 写失败只记日志不改流程：lastSeen 是个展示用的辅助信息，
   * 写不进去不该影响断开处理。
   */
  private markOffline(userId: string): void {
    if (userId.length === 0) return
    const now = Date.now()
    const previous = this.lastSeenWrites.get(userId)
    if (previous !== undefined && now - previous < LAST_SEEN_THROTTLE_MS) return
    this.lastSeenWrites.set(userId, now)

    this.ctx.waitUntil(
      this.env.DB.prepare('UPDATE users SET lastSeenAt = ?1 WHERE id = ?2')
        .bind(now, userId)
        .run()
        .catch((error: unknown) => {
          console.error('写 lastSeenAt 失败', { userId, error })
        }),
    )
  }

  /**
   * 当前在线的人，**带用户名**。
   *
   * ## 为什么按 userId 去重，而不是直接数连接
   *
   * 一个人开三个标签页是三条 WebSocket，但屏幕上显示「在线 3 人」是骗人的。
   * 代价是每次统计都要把挂在每个连接上的 attachment 读出来——
   * 房间就几十个人，这点开销可以忽略，而且这些调用本来就发生在 DO 已经被唤醒的时候。
   *
   * ## 为什么要带用户名
   *
   * 以前这里只返回 userId，Worker 拿到之后还得去 D1 的 users 表查一遍
   * 才能知道这些人叫什么 —— 而成员名单每次有人进出就要刷一次，
   * 等于每次都白读几百行。用户名在 attachment 里本来就有（握手时存下的），
   * 直接一并返回，那条 D1 查询就能省掉。
   */
  private onlineMembers(): { userId: string; username: string }[] {
    // 用 Map 而不是 Set：同一个人开多个标签页会有多条连接，
    // 要按 userId 去重（和 onlineCount 的口径一致），同时留住第一次见到的用户名。
    const seen = new Map<string, string>()
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = this.liveAttachment(ws)
      if (attachment === null || attachment.userId.length === 0) continue
      if (!seen.has(attachment.userId)) seen.set(attachment.userId, attachment.username)
    }
    return [...seen].map(([userId, username]) => ({ userId, username }))
  }

  /** 当前连着的用户 id，按人算不按连接算（同一个人开三个标签页只出现一次）。 */
  private onlineUserIds(): string[] {
    return this.onlineMembers().map((member) => member.userId)
  }

  /**
   * 这个人现在还有连接挂着吗。
   *
   * `except` 用来排除「正在离开的那条连接」：在 `webSocketClose` 回调里，
   * 刚断开的那条 ws **仍然**会被 `getWebSockets()` 返回（运行时还没来得及
   * 把它从列表里摘掉）。不排除自己的话，「这是最后一条连接吗」永远问出 true ——
   * 而这个判断存在的**全部意义**就是不重复播报离场（见 handleDeparture）。
   *
   * 遍历而不是用 Map 缓存：房间就几十个人、连接数更少，而这些调用本来就发生在
   * DO 已经被唤醒的时候（握手 / 断开回调里），省下来的那次遍历换不来什么。
   */
  private hasConnectionFor(userId: string, except?: WebSocket): boolean {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue
      const attachment = this.liveAttachment(ws)
      if (attachment !== null && attachment.userId === userId) return true
    }
    return false
  }

  private onlineCount(): number {
    return this.onlineUserIds().length
  }

  /** 推送房间事件时跳过正在关闭或已过期的连接。 */
  private publish(event: ChatServerEvent): void {
    const data = JSON.stringify(event)
    for (const ws of this.ctx.getWebSockets()) {
      if (this.liveAttachment(ws) === null) continue
      try {
        ws.send(data)
      } catch {
        // 这个连接正在关闭，跳过；它自己的 webSocketClose 会负责清理。
      }
    }
  }

  private publishPresence(event: 'join' | 'leave', username: string): void {
    this.publish({
      type: 'presence',
      online: this.onlineCount(),
      event,
      username,
    })
  }

  /**
   * 把「有人进/出房间」写成一条**系统消息**，落库之后再广播。
   *
   * ## 和 publishPresence 的分工
   *
   * `publishPresence` 发的是**状态**：「在线人数变成 N 了」，发完就没了。
   * 这里发的是**内容**：一条真正进了聊天记录的话，刷新之后还在。
   * 两个都要，但它们服务于不同的东西，别想着合并成一个事件 ——
   * 合并之后要么人数刷新依赖一条要落库的消息（慢、还会因为 D1 抖动而丢），
   * 要么那条提示因为「人数没变」而不发（一个人只是又开了个标签页时确实人数没变，
   * 但离场提示该不该发是另一回事）。
   *
   * ## 为什么先落库、后广播
   *
   * 反过来的话，房间里其他人先看到提示，而**发提示的那个人自己**去翻历史
   * 却翻不到 —— 因为那一刻它还没在库里。所以广播放在 `.then()` 里。
   *
   * ## 失败为什么只记日志、不往外抛
   *
   * 这条提示是**内容**而不是「业务实体」（对比 `routes/chat.ts` 里那段
   * 「广播失败要吞掉」的理由）。这里更极端：它发生在**握手过程中**和
   * **断开回调**里 —— 让一次 D1 抖动把整个 WebSocket 握手变成 500
   * 是明显不成比例的，用户看到的是「进不去房间」，而实际原因只是少了一条提示。
   * 写不进去的代价仅仅是「聊天记录里少一条进出提示」。
   *
   * 用 `waitUntil` 而不是 `await`：握手响应不该被一次 D1 往返拖慢；
   * 同时 `waitUntil` 会保证这次写入在 DO 被换出内存之前跑完，不会丢。
   */
  private notifyPresence(kind: 'join' | 'leave', username: string, room: string): void {
    // 文案在服务端定（见 system-message.ts）：这条 body 是要落库的，
    // 刷新之后从历史里读出来的那份必须和现在广播出去的**一模一样**。
    const message = systemMessage(
      room,
      kind === 'join' ? joinNotice(username) : leaveNotice(username),
    )

    this.ctx.waitUntil(
      insertSystemMessage(this.env.DB, message)
        // SystemMessageRow 是 ChatMessage 的结构超集（多的 `room` 字段前端会忽略），
        // 所以直接当 ChatMessage 发出去，不为省几个字段再造一个对象。
        .then(() => {
          this.publish({ type: 'message', message })
        })
        .catch((error: unknown) => {
          console.error('写进出房间提示失败', { room, kind, username, error })
        }),
    )
  }
}
