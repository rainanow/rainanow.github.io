import { t } from '@nanokajs/core'

export const authBlacklistTableName = 'auth_blacklist'

/**
 * refresh token 吊销名单（配合 `@nanokajs/auth` 的 `jwt.rotation` + `BlacklistStore`）。
 *
 * 库本身只自带 KV 版实现，但把名单放在 D1 里有两个好处：
 *   1. 不用再开一个 KV namespace；
 *   2. D1 是强一致的，KV 是最终一致的——库的 README 明确提醒 KV 版存在
 *      「两个并发 refresh 都成功」的竞态窗口。
 *
 * `id` 存的是 `sha256(jti)` 而不是明文 jti，避免名单被当成 jti 枚举表
 * （跟官方 KV 实现同样的思路）。`subject` 是 sub，用来做一层纵深防御：
 * 即便攻击者拿到某个 jti，也不能在别人的 sub 下复用。
 */
export const authBlacklistFields = {
  id: t.string().primary(),
  subject: t.string(),
  expiresAt: t.integer(),
}
