import { verify } from '@nanokajs/auth'
import { deleteCookie, getCookie } from 'hono/cookie'
import type { MiddlewareHandler } from 'hono'
import { z } from 'zod'

import { revokeRefreshToken } from '../blacklist'
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  REFRESH_TOKEN_TTL_SECONDS,
  USERNAME_PATTERN,
} from '../config'
import type { AppEnv, ChatContext } from '../context'
import { scryptHasher } from '../hasher'
import { clientIp } from '../middleware'
import { consumeRateLimit, peekRateLimit } from '../rate-limit'

/** 登录失败限额：同一 IP + 同一用户名，15 分钟内最多 10 次。 */
const LOGIN_FAILURE_LIMIT = 10
const LOGIN_WINDOW_SECONDS = 15 * 60

/** 注册限额：同一 IP 每小时最多 5 次。 */
const REGISTER_LIMIT = 5
const REGISTER_WINDOW_SECONDS = 60 * 60

/**
 * refresh 限额：同一账号 60 秒内最多 20 次。
 *
 * 为什么必须限：开了 `jwt.rotation` 之后，**每一次成功 refresh 都会往
 * `auth_blacklist` 写一行**（旧 jti 入名单）。不限流的话，任何人手里只要有一个
 * 有效的 refresh token，就能循环调这个接口稳定地烧 D1 写额度（免费 10 万行/天）。
 *
 * 为什么是 20 而不是更紧：access token 30 分钟过期，一个人开着好几个标签页时，
 * 过期那一瞬间会有 N 个标签页同时 refresh。20 次/分钟对这个量级绰绰有余，
 * 而它把「脚本无限刷」从「按 Worker 吞吐」压到了 20 次/分钟。
 *
 * 命名同 `DELETE_ALLOWED_PER_WINDOW`：这个数字是**允许的次数**，
 * 传给 `consumeRateLimit` 时要 `+1`（那个函数是先记账再判断）。
 */
const REFRESH_ALLOWED_PER_WINDOW = 20
const REFRESH_WINDOW_SECONDS = 60

const registerSchema = z.object({
  username: z.string().regex(USERNAME_PATTERN, '用户名只能是 2-20 位的中文、字母、数字或下划线'),
  password: z.string().min(8, '密码至少 8 位').max(128, '密码最多 128 位'),
})

/**
 * 登录前的限流闸门。
 *
 * 两个刻意的设计：
 *  1. **按「IP + 用户名」计数，不是只按 IP**。学校/公司的出口 IP 常被几百人共用，
 *     只按 IP 会让一个人手滑几次就把整栋楼锁掉。
 *  2. **只统计失败**。成功登录不记账，正常用户永远碰不到这个限制。
 *
 * 另外：先 `peek` 再决定要不要放行，超限时直接 429 返回，
 * 绝不会因为「先做一次 scrypt 校验再判断」而被人拿来烧 CPU。
 */
const loginThrottle: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ip = clientIp(c)
  // 这里必须用 `c.req.json()`，**不能**用 `c.req.raw.clone().json()`。
  //
  // Hono 的 json() 内部是把 `raw.text()` 的结果缓存进 `bodyCache.text`，
  // 下游 loginHandler 再调 `c.req.json()` 会直接命中这份缓存，等于零成本复用。
  // 而 clone 出去读的是另一份流，既不会写进 bodyCache，又把原始 body 消耗掉了，
  // 结果 loginHandler 的 `await c.req.json()` 抛错、走进它自己的
  // `catch { throw HTTPException(401, 'Invalid credentials') }`——
  // 表现就是「密码完全正确也一律 401」，非常难查。这个坑实测踩过一次。
  const body = (await c.req.json().catch(() => null)) as { username?: unknown } | null
  const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : ''

  const key = `login:${ip}:${username}`
  const state = await peekRateLimit(c.env.DB, key, LOGIN_FAILURE_LIMIT, LOGIN_WINDOW_SECONDS)
  if (state.blocked) {
    c.header('Retry-After', String(state.retryAfterSeconds))
    return c.json({ error: '登录失败次数过多，请过一会儿再试' }, 429)
  }

  await next()

  // 「只统计失败」的判断只能看最终状态码，**不能**用 try/catch 兜。
  // Hono 的 compose 是在「抛出的那一层」就地调用 onError 并把响应写进 c.res，
  // 异常根本不会冒泡回这一层——写成 try/catch 会静默失效（实测踩过一次，
  // 现象是 rate_limits 表里永远没有 login: 记录）。
  if (c.res?.status === 401) {
    await consumeRateLimit(c.env.DB, key, LOGIN_FAILURE_LIMIT, LOGIN_WINDOW_SECONDS)
  }
}

/**
 * refresh 的限流闸门。
 *
 * ## 桶键为什么优先用 token 里的 sub，而不是只按 IP
 *
 * 和登录限流同理：学校/公司几百人共用一个出口 IP，只按 IP 会让一个人
 * 开几个标签页就把整栋楼锁掉。能认出账号就按账号记。
 *
 * ## 为什么要先自己 verify 一次 token
 *
 * refresh 这条路径是**匿名**的 —— 请求里只有一个 refresh Cookie，
 * 没有 access token、没有 `auth.middleware()`，所以拿不到 `sub`。
 * 想按账号限流，就只能自己把 token 解开读 `sub`。
 *
 * 这次 verify 是一次 HMAC 验签 + JSON 解析，亚毫秒级，
 * 相对 10 ms 的 CPU 预算可以忽略；而它换来的是「按账号限流」这个准确度。
 *
 * ## 解不出 sub 时不能放行
 *
 * 令牌无效或过期时 `verify()` 会抛。这时**退回按 IP 记账**，而不是跳过限流 ——
 * 否则「拿一堆废 token 反复打」就是一条完全免费的 D1 写路径。
 */
const refreshThrottle: MiddlewareHandler<AppEnv> = async (c, next) => {
  let bucket = `refresh-ip:${clientIp(c)}`

  const token = getCookie(c, REFRESH_TOKEN_COOKIE)
  if (token !== undefined && token.length > 0) {
    try {
      const payload = await verify<{ sub?: unknown; type?: unknown }>(token, c.env.AUTH_SECRET)
      if (payload.type === 'refresh' && typeof payload.sub === 'string' && payload.sub.length > 0) {
        bucket = `refresh:${payload.sub}`
      }
    } catch {
      // 令牌无效/过期：解不出 sub，退回按 IP 记账（见上面第三点）
    }
  }

  const attempt = await consumeRateLimit(
    c.env.DB,
    bucket,
    REFRESH_ALLOWED_PER_WINDOW + 1,
    REFRESH_WINDOW_SECONDS,
  )
  if (attempt.blocked) {
    c.header('Retry-After', String(attempt.retryAfterSeconds))
    return c.json({ error: `刷新太频繁了，${attempt.retryAfterSeconds} 秒后再试` }, 429)
  }

  await next()
}

export function registerAuthRoutes({ app, User, auth }: ChatContext): void {
  app.post('/auth/login', loginThrottle, auth.loginHandler())

  app.post('/auth/refresh', refreshThrottle, auth.refreshHandler())

  app.post('/auth/register', async (c) => {
    const ip = clientIp(c)

    const body = (await c.req.json().catch(() => null)) as {
      username?: unknown
      password?: unknown
    } | null

    const parsed = registerSchema.safeParse({
      username: typeof body?.username === 'string' ? body.username.trim() : '',
      password: typeof body?.password === 'string' ? body.password : '',
    })
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? '输入不合法' }, 400)
    }

    // 记账放在格式校验**之后**：限流的目的是挡「反复建号」，不是挡「手滑输错」。
    // 之前顺序反了，一个人试 5 次不合格的用户名/密码就把自己锁满一小时，
    // 而那 5 次连一个账号都没建出来 —— 纯粹是误伤。
    const attempt = await consumeRateLimit(
      c.env.DB,
      `register:${ip}`,
      REGISTER_LIMIT,
      REGISTER_WINDOW_SECONDS,
    )
    if (attempt.blocked) {
      c.header('Retry-After', String(attempt.retryAfterSeconds))
      return c.json({ error: '注册太频繁了，请过一会儿再试' }, 429)
    }

    const { username, password } = parsed.data

    // users.username 建表时带了 COLLATE NOCASE，所以这条查询天然不区分大小写：
    // "Alice" 和 "alice" 会被认成同一个用户名。
    const existing = await User.findOne({ username })
    if (existing !== null) {
      return c.json({ error: '这个用户名已经被占用了' }, 409)
    }

    const hash = await scryptHasher.hash(password)

    try {
      // 字段名必须是 `password`：`@nanokajs/auth` 用 `fields.password` 指定的名字
      // 同时作为「数据库列名」和「登录请求体里的键名」，两边必须一致。
      // 详见 src/models/user.ts 的注释。
      const created = await User.create({ username, password: hash, role: 'user' })
      // 刻意逐字段构造响应，而不是 `c.json(created)`：
      // 这样密码哈希从结构上就没有出口（模型上的 `.writeOnly()` 是第二道保险）。
      return c.json({ id: created.id, username: created.username, createdAt: created.createdAt }, 201)
    } catch (error) {
      // 两个请求同时注册同一个名字时，会有一方撞上 UNIQUE 约束。
      console.error('register failed', error)
      return c.json({ error: '这个用户名已经被占用了' }, 409)
    }
  })

  /**
   * 登出：真正把 refresh token 拉黑，而不是只删 Cookie。
   *
   * 只删 Cookie 的话 token 在 7 天内依然有效——任何拿到过它的人都能继续换新的 access token。
   * 这里用库导出的 `verify()` 验明正身，再把 jti 写进 D1 吊销名单；
   * 之后 `refreshHandler()` 内部的 `hasForSubject` 就会拒绝它。
   */
  app.post('/auth/logout', async (c) => {
    const refreshToken = getCookie(c, REFRESH_TOKEN_COOKIE)
    if (refreshToken !== undefined && refreshToken.length > 0) {
      try {
        const payload = await verify<{
          sub?: unknown
          type?: unknown
          jti?: unknown
          exp?: unknown
        }>(refreshToken, c.env.AUTH_SECRET)

        if (
          payload.type === 'refresh' &&
          typeof payload.sub === 'string' &&
          typeof payload.jti === 'string'
        ) {
          const expiresAt =
            typeof payload.exp === 'number'
              ? payload.exp
              : Math.floor(Date.now() / 1000) + REFRESH_TOKEN_TTL_SECONDS
          await revokeRefreshToken(c.env.DB, payload.jti, payload.sub, expiresAt)
        }
      } catch {
        // 令牌本来就无效或已过期，不需要吊销，照常清 Cookie 即可。
      }
    }

    deleteCookie(c, ACCESS_TOKEN_COOKIE, { path: '/' })
    deleteCookie(c, REFRESH_TOKEN_COOKIE, { path: '/' })
    return c.json({ ok: true })
  })
}
