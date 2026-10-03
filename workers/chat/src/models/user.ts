import { t } from '@nanokajs/core'

export const userTableName = 'users'

/**
 * 账号表。
 *
 * 关于 `password` 这个字段名（它存的是 scrypt 哈希，不是明文）：
 *
 * `@nanokajs/auth` 的 `createAuth({ fields: { password } })` 里那个名字是**一物两用**的，
 * 既当数据库列名、又当登录请求体里的键名：
 *
 *   const passwordValue = body[passwordField]   // 读请求体
 *   const storedHash    = user[passwordField]   // 读数据库行
 *
 * 所以字段名一旦叫 `passwordHash`，客户端登录就必须发
 * `{ "username": "...", "passwordHash": "<明文密码>" }`——既反直觉又危险：
 * 一个名叫 passwordHash 的入参里装着明文密码，很容易被日志/抓包当成「已经是哈希」而放行。
 *
 * 于是这里把字段名对齐成 `password`：请求体就是正常的 `{ username, password }`，
 * 库里那列叫 `password` 但存的确实是哈希。列名叫 password 而存哈希是通行做法
 * （Django 的 auth_user.password 就是哈希），再配合下面的 `.writeOnly()`
 * 保证它永远不会出现在任何响应里。
 *
 * `role` 只有 'user' / 'admin' 两个取值，admin 可以撤回别人的消息。提权要手动改库：
 *   npx wrangler d1 execute yulo-chat --remote \
 *     --command "UPDATE users SET role='admin' WHERE username='xxx'"
 */
export const userFields = {
  id: t.uuid().primary().readOnly(),
  username: t.string().min(2).max(20).unique(),
  password: t.string().writeOnly(),
  role: t.string().default('user'),
  /**
   * 最后一次**离线**的时刻（UTC 毫秒），用来在成员列表里显示「上次在线」。
   *
   * 由 DO 在最后一条 WebSocket 断开时写入（见 `room.ts` 的 `markOffline`），
   * 同一用户 5 分钟内只写一次，避免网络抖动时反复刷库。
   *
   * 允许为 null：账号刚注册、还没连过一次就没有这个值。
   * 前端对 null 显示「未知」而不是编一个时间出来 ——
   * 拿注册时间冒充「上次在线」是在显示假信息。
   */
  lastSeenAt: t.timestamp().optional(),
  /**
   * 禁言到什么时候（UTC 毫秒）。null = 没被禁言。
   *
   * 和 `role` 一样，这是**管理员施加的临时状态**，所以：
   *   - 存的是「截止时间」而不是布尔值 —— 禁言 1 小时和 7 天用同一列表达，
   *     到期自动解除，不需要定时任务去「取消」；
   *   - 不用 `deleted` 那种布尔，因为布尔得另配一个「什么时候解封」的字段，
   *     两份状态可能互相矛盾。
   *
   * 为什么不用「永久封禁」：那属于删号（`DELETE` 那个接口），语义不同。
   */
  mutedUntil: t.timestamp().optional(),
  createdAt: t.timestamp().defaultNow().readOnly(),
}
