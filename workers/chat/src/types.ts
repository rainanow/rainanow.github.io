/** Worker 与 Durable Object 之间、以及服务端与浏览器之间共享的数据形状。 */

/** 一条聊天消息（已脱敏，不含被软删的字段）。 */
export interface ChatMessage {
  id: string
  userId: string
  username: string
  body: string
  /**
   * `'user'` 或 `'system'`。系统消息（加入/离开房间、撤回提示）走的是**同一条通路**：
   * 同样的 `message` 事件、同样的 `insertMessage()` 排序去重，只有渲染不同。
   *
   * 前端按 `kind === 'system'` 判断，所以缺字段（老客户端）自然落回普通消息那一档。
   */
  kind: string
  /** epoch 毫秒。跨语言解析最省事，前端 `new Date(ms)` 直接用。 */
  createdAt: number
}

/** 服务端推给浏览器的 WebSocket 事件。 */
export type ChatServerEvent =
  /** 握手成功，附带当前在线人数 */
  | { type: 'ready'; online: number; room: string; videoCalls?: true; accessExpiresAt?: number }
  /** 设备会话已吊销，通知页面先于底层关闭握手。 */
  | { type: 'session-revoked' }
  /** 有新消息（普通消息和系统消息都走这里） */
  | { type: 'message'; message: ChatMessage }
  /**
   * 有人进/出。**只负责「在线人数」和「成员名单要不要刷」**，
   * 进出本身的那条提示是作为一条系统 `message` 单独广播的 ——
   * 两条通路的职责不同：presence 是状态，message 是内容。
   */
  | { type: 'presence'; online: number; event: 'join' | 'leave'; username: string }
  /** 某条消息被作者本人或管理员撤回 */
  | { type: 'deleted'; room: string; id: string }
  /** 管理员把整个房间清空了 —— 所有客户端据此把消息列表抹掉 */
  | { type: 'purged'; room: string }

/** 挂在 WebSocket 上的身份信息，DO 休眠后靠它恢复（serializeAttachment）。 */
export interface SocketAttachment {
  userId: string
  username: string
  /** 稳定的登录会话 ID。部署前已打开的连接需要续期后重新握手。 */
  sessionId?: string
  /** 仅视频信令启用后的新连接分配 ID。hello 后才加入可呼叫列表。 */
  connectionId?: string
  callReady?: true
  /**
   * 这条连接属于哪个房间。
   *
   * 为什么要存在连接上、而不是当成 DO 的一个字段：DO 的实例名是
   * `idFromName(room)`，实例自己**问不出**它叫哪个房间（没有那样的 API）。
   * 靠「第一次握手时记下来」能work，但那是个内存字段 —— DO 被驱逐后
   * 就退回默认值了，而驱逐之后那条连接断开时触发的 `webSocketClose`
   * 恰恰要靠它写「谁离开了房间」的提示。多房间时那会写成**错误的房间**。
   * attachment 是跟着连接持久化的，休眠唤醒后照样读得到，不受驱逐影响。
   */
  room: string
  /** 建立连接时 access token 的过期时间，单位为 Unix 秒。 */
  exp: number
}

/** Worker 通过 DO 的 /broadcast 端点转发的服务端事件。 */
export interface BroadcastRequest {
  event: ChatServerEvent
}
