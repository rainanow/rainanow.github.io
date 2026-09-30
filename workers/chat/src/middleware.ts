import { getCookie } from 'hono/cookie'
import type { MiddlewareHandler } from 'hono'

import { ACCESS_TOKEN_COOKIE } from './config'
import type { AppEnv } from './context'

/**
 * 把 HttpOnly Cookie 里的 access token 桥接成 `Authorization: Bearer` 头。
 *
 * 为什么需要这一步：`@nanokajs/auth` 的 `middleware()` 只接受 Authorization 头，
 * 明确不读 Cookie（库作者的设计取舍，README 里写了 Cookie 是给 BFF 模式用的）。
 * 而浏览器端把 token 放 HttpOnly Cookie、让 JS 完全碰不到，是最稳的做法——
 * 于是中间架一层，把 Cookie 翻成那个库认的头。
 *
 * 注意：这里必须用 `new Request(...)` 造一个新请求，不能就地改 `c.req.raw.headers`
 * （Workers 里 Request 的 header 是不可变的）。
 * 这条路只给普通 HTTP 路由用；WebSocket 升级请求**不能**这么 clone，
 * 否则升级语义会丢，所以 /api/ws 单独处理，见 routes/chat.ts。
 */
export const cookieAuthBridge: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.header('Authorization') === undefined) {
    const token = getCookie(c, ACCESS_TOKEN_COOKIE)
    if (token !== undefined && token.length > 0) {
      const headers = new Headers(c.req.raw.headers)
      headers.set('Authorization', `Bearer ${token}`)
      c.req.raw = new Request(c.req.raw, { headers })
    }
  }
  await next()
}

/**
 * 取客户端 IP，用来当限流的桶键。
 *
 * 生产上请求一定经过 Cloudflare，`cf-connecting-ip` 由它写入，
 * 客户端自带同名头会被覆盖掉 —— 这是唯一可信的来源，限流一律以它为准。
 *
 * 走到下面说明**没**经过 Cloudflare，正常只有本地 `wrangler dev` 属于这种情况。
 * 此时 `x-forwarded-for` 是客户端想写什么就写什么的：拿它当桶键，
 * 等于把「换桶」的钥匙交给对方，限流形同虚设。
 * 所以只在它**不含逗号**（本地直连就是这种情形，本地也不需要防攻击）时才采信；
 * 一旦出现逗号说明前面有代理链、里面混着别人能控制的字段，一律落 'unknown'。
 * 共用同一个桶是 fail closed（只会更早触发 429），比让攻击者自己挑桶安全得多。
 *
 * 副作用：本地所有请求共用一个桶，注册 5 次就会被挡一小时。
 * 想看当前计数 `npm run inspect-d1`；`npm run smoke` 自己会清本地 rate_limits。
 */
export function clientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  const cloudflareIp = c.req.header('cf-connecting-ip')
  if (cloudflareIp !== undefined && cloudflareIp.length > 0) return cloudflareIp

  const forwarded = c.req.header('x-forwarded-for')
  if (forwarded !== undefined && forwarded.length > 0 && !forwarded.includes(',')) {
    const trimmed = forwarded.trim()
    if (trimmed.length > 0) return trimmed
  }

  return 'unknown'
}
