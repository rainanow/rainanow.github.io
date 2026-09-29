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

/** 取真实客户端 IP。本地 `wrangler dev` 没有 cf-connecting-ip，会落到 'unknown'。 */
export function clientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  const cloudflareIp = c.req.header('cf-connecting-ip')
  if (cloudflareIp !== undefined && cloudflareIp.length > 0) return cloudflareIp

  const forwarded = c.req.header('x-forwarded-for')
  const first = forwarded?.split(',')[0]?.trim()
  if (first !== undefined && first.length > 0) return first

  return 'unknown'
}
