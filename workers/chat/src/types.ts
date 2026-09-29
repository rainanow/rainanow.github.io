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

/** 挂在 WebSocket 上的身份信息，DO 休眠后靠它恢复（serializeAttachment）。 */
export interface SocketAttachment {
  userId: string
  username: string
}

/** Worker 通过 DO 的 /broadcast 端点转发的服务端事件。 */
export interface BroadcastRequest {
  event: ChatServerEvent
}
