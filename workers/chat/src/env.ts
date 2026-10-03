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
  /**
   * 只在**本地开发**时用：设成 'true' 会把限流阈值放大到基本不生效。
   *
   * ## 为什么要它
   *
   * 限流按 IP 记账，而**本地 `clientIp()` 一律返回 `unknown`**
   * （拿不到 CF-Connecting-IP），于是所有请求共用 `127.0.0.1` 一个桶。
   * 结果是写几个测试脚本、或者手动注册几个账号就把额度用光，
   * 之后登录/注册直接 429 —— 现象看着像「代码坏了」，其实只是撞了限流。
   *
   * ## 为什么不直接调大常量
   *
   * 因为那会让**线上**的限流跟着变松。要「本地不拦、线上照拦」，
   * 就得让这个开关只可能在本机为真 —— 见下面的安全性说明。
   *
   * ## 安全性
   *
   * 它只写在 `.dev.vars` 里，而 `wrangler deploy` **不读** `.dev.vars`
   * （那是 `wrangler dev` 专用的），所以生产环境这个变量恒为 undefined。
   * 判定用的是 `=== 'true'` 而不是「非空即真」，万一有人在线上误配了空串，
   * 行为也是「不放宽」而不是「意外关掉限流」。
   */
  RELAX_LOCAL_LIMITS?: string
  /**
   * 优先级更高的反向开关：设成 'true' 时**即使** RELAX_LOCAL_LIMITS 为真也照常限流。
   *
   * 存在的理由：本地为了调试关掉限流之后，那些断言 429 的测试会集体变红
   * （实测 12 条），而「测试红了」很容易被误读成「代码坏了」。
   * 让跑测试的人能显式要求「这次要按线上的限流来」，两边就不打架了。
   *
   * 同样只写在 .dev.vars 里，生产恒为 undefined。
   */
  STRICT_RATE_LIMIT?: string
}
