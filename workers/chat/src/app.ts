import { createAuth } from '@nanokajs/auth'
import { d1Adapter, nanoka } from '@nanokajs/core'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'

import { d1BlacklistStore } from './blacklist'
import {
  ACCESS_TOKEN_COOKIE,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_COOKIE,
  REFRESH_TOKEN_TTL_SECONDS,
} from './config'
import type { AppEnv, ChatContext } from './context'
import type { Env } from './env'
import { scryptHasher } from './hasher'
import { messageFields, messageTableName } from './models/message'
import { roomPurgeFields, roomPurgeTableName } from './models/room-purge'
import { userFields, userTableName } from './models/user'
import { isAllowedOrigin } from './origins'
import { registerAuthRoutes } from './routes/auth'
import { registerChatRoutes } from './routes/chat'
import { registerMediaRoutes } from './routes/media'

export function buildChatApp(env: Env): ChatContext {
  if (typeof env.AUTH_SECRET !== 'string' || env.AUTH_SECRET.length < 32) {
    // createAuth 自己也会校验长度，但在启动时给出可操作的报错更省事。
    throw new Error(
      'AUTH_SECRET 缺失或太短：必须是至少 32 个字符。用 `wrangler secret put AUTH_SECRET` 注入。',
    )
  }

  const app = nanoka<AppEnv>(d1Adapter(env.DB))
  const User = app.model(userTableName, userFields)
  const Message = app.model(messageTableName, messageFields)
  const RoomPurge = app.model(roomPurgeTableName, roomPurgeFields)

  const auth = createAuth({
    model: User,
    secret: env.AUTH_SECRET,
    // 这两个名字是**一物两用**的：既用来读请求体（body[fields.password]），
    // 也用来读数据库行（user[fields.password]）。所以必须和模型字段名完全一致。
    // 详见 src/models/user.ts 里关于「为什么这一列叫 password 而存的是哈希」的说明。
    fields: { identifier: 'username', password: 'password' },
    hasher: scryptHasher,
    jwt: {
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      refreshExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
      // 开 rotation 才能真正「登出」：每用一次 refresh token 就换新的，
      // 旧的 jti 进 D1 吊销名单，被盗的令牌最多用一次就作废。
      rotation: true,
    },
    cookie: {
      // HttpOnly：JS 读不到 token，XSS 拿不走登录态。
      httpOnly: true,
      // api.yulo.top 和 yulo.top 属于同一个可注册域，所以是「同站」请求，
      // Lax 既能正常带上 Cookie，又能挡住跨站发起的写操作（CSRF）。
      sameSite: 'Lax',
      // 线上必须是 true —— 会话 Cookie 只在 HTTPS 上传输。
      // 但本地是 http://localhost，带 Secure 的 Cookie 会被 Chrome 直接丢掉
      // （浏览器明确拒绝「http + Secure」），症状是登录返回 200、紧接着 /api/me 却 401。
      // 所以留一个只在本地生效的开关：.dev.vars 里写 COOKIE_SECURE=false。
      // 线上没有这个变量，`undefined !== 'false'` 成立，Secure 保持开启，不可能被误关。
      secure: env.COOKIE_SECURE !== 'false',
      path: '/',
      accessTokenName: ACCESS_TOKEN_COOKIE,
      refreshTokenName: REFRESH_TOKEN_COOKIE,
    },
    blacklist: d1BlacklistStore(env.DB),
  })

  app.use(
    '*',
    cors({
      // 不用 `origin: '*'`：带 Cookie 的跨域请求必须回显具体来源，
      // 通配符会被浏览器直接拒掉（而且那等于什么来源都放行）。
      origin: (origin, c) => (isAllowedOrigin(c.env.ALLOWED_ORIGINS, origin) ? origin : undefined),
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      // 上传接口用 `X-Filename` 带原始文件名，它属于**自定义头**，
      // 浏览器会先发预检（OPTIONS）问一句「这个头能发吗」。没在这里声明的话
      // 预检就被判失败，请求根本发不出去，前端只能看到一个 fetch 层的 NetworkError
      // —— 服务器那边连日志都不会有，特别容易误判成网络问题。
      allowHeaders: ['Content-Type', 'Authorization', 'X-Filename'],
      credentials: true,
      maxAge: 86400,
    }),
  )

  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      // 库抛的 HTTPException 只带通用文案（"Invalid credentials" / "Unauthorized"），
      // 不会泄露内部原因。注意 v1.6.0 起这个库不再往 cause 上挂内部错误，
      // 这里也刻意只回 message，绝不把 cause 或堆栈序列化出去。
      return error.getResponse()
    }
    console.error('unhandled error', error)
    return c.json({ error: '服务器内部错误' }, 500)
  })

  const context: ChatContext = { app, User, Message, RoomPurge, auth }
  registerAuthRoutes(context)
  registerChatRoutes(context)
  registerMediaRoutes(context)
  return context
}

let cachedChatApp: ChatContext | null = null

/**
 * 按 isolate 缓存整个应用（Hono 路由表 + 模型 + auth 实例）。
 *
 * 这不是顺手做的微优化，是必需的：`createAuth()` 在构造时会**立刻**算一次
 * `hasher.hash('__dummy__')`——库里用它来防「用户名是否存在」的时序侧信道，
 * 代价是一次完整的 scrypt。若每个请求都重建 auth，就等于每个请求白扔一次 scrypt，
 * 免费套餐 10ms 的 CPU 预算根本扛不住。顺带也省掉每请求重新注册路由。
 *
 * 这样做安全的前提是：同一个 isolate 内 `env` 是稳定的（Cloudflare 的绑定就是如此）。
 */
export function getChatApp(env: Env): ChatContext {
  if (cachedChatApp === null) {
    cachedChatApp = buildChatApp(env)
  }
  return cachedChatApp
}
