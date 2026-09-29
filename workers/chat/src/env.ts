/** Worker 的绑定与变量。名字要和 wrangler.jsonc 里的 binding 完全一致。 */
export interface Env {
  /** D1：账号、消息、吊销名单、限流计数 */
  DB: D1Database
  /** 每个聊天室一个实例的 Durable Object（只做 WebSocket 广播） */
  CHAT_ROOM: DurableObjectNamespace
  /** HS256 签名密钥，至少 32 字符。用 `wrangler secret put AUTH_SECRET` 注入，不要写进仓库。 */
  AUTH_SECRET: string
  /** 允许携带 Cookie 跨域访问的来源白名单，逗号分隔 */
  ALLOWED_ORIGINS: string
}
