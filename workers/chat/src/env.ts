/** Worker 的绑定与变量。名字要和 wrangler.jsonc 里的 binding 完全一致。 */
export interface Env {
  /** D1：账号、消息、吊销名单、限流计数 */
  DB: D1Database
  /** 每个聊天室一个实例的 Durable Object（只做 WebSocket 广播） */
  CHAT_ROOM: DurableObjectNamespace
  /** 聊天室上传的图片和文档（R2 对象存储） */
  MEDIA: R2Bucket
  /** HS256 签名密钥，至少 32 字符。用 `wrangler secret put AUTH_SECRET` 注入，不要写进仓库。 */
  AUTH_SECRET: string
  /** 允许携带 Cookie 跨域访问的来源白名单，逗号分隔 */
  ALLOWED_ORIGINS: string
  /**
   * 媒体对象的公开访问前缀（R2 直连域名）。
   * 上传接口用它拼出完整 URL 写进消息正文，前端也靠它判断「这个 URL 是不是自家的」。
   */
  MEDIA_BASE_URL: string
  /**
   * 只在**本地开发**时用：显式写 'false' 可以让会话 Cookie 不带 Secure 标记。
   *
   * 为什么需要这个开关：本地是 http://localhost，而带 Secure 的 Cookie 会被浏览器
   * 直接丢掉（Chrome 明确拒绝「http + Secure」的组合），表现是登录接口返回 200、
   * 紧接着 /api/me 却 401，前端提示「登录状态没拿到」。
   *
   * 为什么安全：这个变量只写在 .dev.vars 里（已被 gitignore），线上没有它，
   * 于是 `undefined !== 'false'` 成立，Secure 保持开启。生产不可能被误关。
   */
  COOKIE_SECURE?: string
}
