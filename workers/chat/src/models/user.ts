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
  createdAt: t.timestamp().defaultNow().readOnly(),
}
