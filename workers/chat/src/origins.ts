/**
 * 跨域与令牌读取的公共工具。
 * Worker 路由和 Durable Object 都要用，所以不能依赖 Hono 的 Context。
 */

import { ACCESS_TOKEN_COOKIE } from './config'

/** 把 `ALLOWED_ORIGINS` 那个逗号分隔的字符串拆成数组。 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (raw === undefined) return []
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

/** 来源是否在白名单里。白名单为空 => 一律拒绝（fail closed，别默默放行）。 */
export function isAllowedOrigin(raw: string | undefined, origin: string | null | undefined): boolean {
  if (origin === undefined || origin === null || origin.length === 0) return false
  return parseAllowedOrigins(raw).includes(origin)
}

/** 从原始 Request 的 Cookie 头里取一个值。Durable Object 里没有 Hono Context，只能自己解析。 */
export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('Cookie')
  if (header === null) return undefined

  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1) continue
    if (part.slice(0, separator).trim() !== name) continue
    const value = part.slice(separator + 1).trim()
    return value.length > 0 ? decodeURIComponent(value) : undefined
  }
  return undefined
}

/**
 * 取 access token：优先 `Authorization: Bearer`，退回 HttpOnly Cookie。
 *
 * `@nanokajs/auth` 的 `middleware()` 只认 Authorization 头，不看 Cookie
 * （这是库的有意设计：Cookie 是给 BFF 模式用的）。而浏览器的 `new WebSocket()`
 * 又没有办法自己带 Authorization 头——所以 WebSocket 握手这条路只能走 Cookie。
 * 普通 HTTP 路由则由中间件把 Cookie 转成 Authorization 头，见 app.ts 的 cookieAuthBridge。
 */
export function readAccessToken(
  request: Request,
  cookieName: string = ACCESS_TOKEN_COOKIE,
): string | undefined {
  const header = request.headers.get('Authorization')
  if (header !== null) {
    const matched = /^Bearer\s+(.+)$/i.exec(header)
    const token = matched?.[1]?.trim()
    if (token !== undefined && token.length > 0) return token
  }
  return readCookie(request, cookieName)
}
