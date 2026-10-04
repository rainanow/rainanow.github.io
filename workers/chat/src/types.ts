/** Worker 与 Durable Object 之间、以及服务端与浏览器之间共享的数据形状。 */

/** 一条聊天消息（已脱敏，不含被软删的字段）。 */
export interface ChatMessage {
  id: string
  userId: string
  username: string
  body: string
  /** epoch 毫秒。跨语言解析最省事，前端 `new Date(ms)` 直接用。 */
  createdAt: number
}

/** 服务端推给浏览器的 WebSocket 事件。 */
export type ChatServerEvent =
  /** 握手成功，附带当前在线人数 */
  | { type: 'ready'; online: number; room: string }
  /** 有新消息 */
  | { type: 'message'; message: ChatMessage }
  /** 有人进/出 */
  | { type: 'presence'; online: number; event: 'join' | 'leave'; username: string }
  /** 某条消息被作者本人或管理员撤回 */
  | { type: 'deleted'; room: string; id: string }
  /** 管理员把整个房间清空了 —— 所有客户端据此把消息列表抹掉 */
  | { type: 'purged'; room: string }

/** 挂在 WebSocket 上的身份信息，DO 休眠后靠它恢复（serializeAttachment）。 */
export interface SocketAttachment {
  userId: string
  username: string
  /**
   * 建起这条连接的那张 access token 的到期时间（epoch **秒**，和 JWT 的 `exp` 同口径）。
   *
   * 为什么要把它一起存下来：WebSocket 只在握手时验一次令牌，之后 DO 再也不看它。
   * 于是「令牌过期」「改密码吊销了会话」「账号被管理员注销」这三件事
   * 对一条**已经建好**的连接毫无影响 —— 人已经被删了，只要他不刷新页面
   * 就能一直收消息。记下 exp，广播时顺手对一下，洞就堵上了：
   * **连接的最长寿命 = 它凭以建立的那张凭证的寿命。**
   */
  exp: number
}

/** Worker 通过 DO 的 /broadcast 端点转发的服务端事件。 */
export interface BroadcastRequest {
  event: ChatServerEvent
}
