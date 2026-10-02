/**
 * ChatRoom：一个聊天室一个实例，只负责「把消息推给所有连着的浏览器」。
 *
 * 职责边界是刻意划的：
 *   - 消息的**校验和落库**在 Worker 里做（Hono + nanoka 的验证器都在那边）；
 *   - DO 只做广播，外加维护在线人数。
 * 于是 DO 里没有业务逻辑，只有连接管理，休眠唤醒的代价也最小。
 *
 * 用 Hibernation API（`acceptWebSocket` 而不是 `server.accept()`）：
 * 连接空闲时 DO 会被换出内存，不计 compute duration。免费套餐给的是
 * 13,000 GB-s/天，而 DO 被换出后空闲时间是不计费的——收一条消息才计一次。
 * 心跳走 `setWebSocketAutoResponse`，由运行时直接回 pong，连唤醒都不会。
 */

import { verify } from '@nanokajs/auth'

import { ACCESS_TOKEN_COOKIE, DEFAULT_ROOM } from './config'
import type { Env } from './env'
import { readAccessToken } from './origins'
import type { BroadcastRequest, ChatServerEvent, SocketAttachment } from './types'

const BROADCAST_PATH = '/broadcast'
const ONLINE_PATH = '/online'

function unauthorized(reason: string): Response {
  return new Response(reason, { status: 401 })
}

export class ChatRoom implements DurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    // 客户端每 45 秒发一次文本 "ping"，运行时直接回 "pong"：
    // 不唤醒 DO、不计 compute duration。这一条是省额度的关键。
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname === BROADCAST_PATH) return this.handleBroadcast(request)
    if (pathname === ONLINE_PATH) return this.handleOnline()
    return this.handleUpgrade(request)
  }

  /**
   * Worker 问「现在谁连着」。和 /broadcast 一样，是给 Worker 调的内部端点，
   * DO 自己没有对外路由，外面碰不到。
   */
  private async handleOnline(): Promise<Response> {
    // `members` 是后来加的（带用户名，让 Worker 不用再查 users 表）。
    // `userIds` 保留是为了兼容老调用方，但它现在只是 members 的投影，不额外遍历。
    const members = this.onlineMembers()
    return Response.json({ userIds: members.map((m) => m.userId), members })
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

    let payload: { sub?: unknown; type?: unknown }
    try {
      payload = await verify<{ sub?: unknown; type?: unknown }>(token, this.env.AUTH_SECRET)
    } catch {
      return unauthorized('Invalid token')
    }
    if (payload.type !== 'access' || typeof payload.sub !== 'string') {
      return unauthorized('Invalid token')
    }

    const user = await this.env.DB.prepare('SELECT username FROM users WHERE id = ?1')
      .bind(payload.sub)
      .first<{ username: string }>()
    if (user === null) return unauthorized('Unknown user')

    const attachment: SocketAttachment = { userId: payload.sub, username: user.username }

    const pair = new WebSocketPair()
    const server = pair[1]
    this.ctx.acceptWebSocket(server)
    // 休眠会把内存里的东西全丢掉，只有 attachment 会被持久化下来。
    server.serializeAttachment(attachment)

    const room = new URL(request.url).searchParams.get('room') ?? DEFAULT_ROOM
    server.send(
      JSON.stringify({ type: 'ready', online: this.onlineCount(), room } satisfies ChatServerEvent),
    )
    this.publishPresence('join', attachment.username)

    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // 心跳的 "ping" 已经被 setWebSocketAutoResponse 拦掉了，根本走不到这里。
    // 剩下的是客户端发来的其它内容：这个聊天室是「只推不收」的，
    // 消息一律由 POST /api/messages 进来（那边才有校验和落库），所以这里什么都不做。
    // 仍然实现它，是为了让运行时有明确的处理器可调，而不是走未定义分支。
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null
    try {
      // 客户端发起的关闭要由服务端回一个 close 才算完成握手；不回的话连接可能悬着。
      ws.close(code, reason)
    } catch {
      // 已经关了，无所谓。
    }
    if (attachment !== null) this.publishPresence('leave', attachment.username)
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('chatroom websocket error', error)
    const attachment = ws.deserializeAttachment() as SocketAttachment | null
    if (attachment !== null) this.publishPresence('leave', attachment.username)
  }

  /**
   * 在线人数：按 userId 去重，而不是直接数连接。
   *
   * 一个人开三个标签页是三条 WebSocket，但屏幕上显示「在线 3 人」是骗人的。
   * 代价是每次统计都要把挂在每个连接上的 attachment 读出来——
   * 房间就几十个人，这点开销可以忽略，而且这些调用本来就发生在 DO 已经被唤醒的时候。
   */
  /** 当前连着的用户 id，按人算不按连接算（同一个人开三个标签页只出现一次）。 */
  /**
   * 当前在线的人，**带用户名**。
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
      const attachment = ws.deserializeAttachment() as SocketAttachment | null
      if (attachment === null || attachment.userId.length === 0) continue
      if (!seen.has(attachment.userId)) seen.set(attachment.userId, attachment.username)
    }
    return [...seen].map(([userId, username]) => ({ userId, username }))
  }

  private onlineUserIds(): string[] {
    return this.onlineMembers().map((member) => member.userId)
  }

  private onlineCount(): number {
    return this.onlineUserIds().length
  }

  private publish(event: ChatServerEvent): void {
    const data = JSON.stringify(event)
    for (const ws of this.ctx.getWebSockets()) {
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
}
