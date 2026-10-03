import { t } from '@nanokajs/core'

export const userSessionTableName = 'user_sessions'

/**
 * 「这个用户当前有哪些有效的 refresh token」。
 *
 * ## 为什么需要这张表（它不是重复造轮子）
 *
 * 现有的 `auth_blacklist` 是**拒绝名单**：只记「哪些 jti 已经被吊销」。
 * 于是「吊销这个人的所有会话」根本做不到 —— 系统从来没记录过他当前
 * 有哪些有效 token，吊销时无从枚举。
 *
 * 这在「改密码」这件事上直接变成漏洞：改完密码，之前**泄露出去的
 * refresh token 照样能换出新的 access token**，等于密码改了但没实际生效。
 * 攻击者拿一个旧 token 可以一直续期用到它自然过期（7 天）。
 *
 * 有了这张表，改密码就是 `DELETE FROM user_sessions WHERE userId = ?`，
 * 之后 refresh 中间件会发现「这个 jti 不在有效列表里」而拒绝。
 *
 * ## 为什么不存「撤销时间」然后按时间戳比较
 *
 * 那样需要一个能信的「token 签发时间」，而 `@nanokajs/auth` 的 `sign()`
 * **只写 `exp`、不写 `iat`**（看它 dist/index.js 的 sign 实现），所以拿不到。
 * 与其去猜一个不可靠的时间来源，不如直接记「有效的有哪些」。
 *
 * ## 清理
 *
 * 每次写这张表时顺手删掉 `expiresAt` 已过期的行 —— 那些 token 本来就换不出东西，
 * 留着只是让表无限变大。
 */
export const userSessionFields = {
  /**
   * refresh token 里的 `jti`。主键，和 `auth_blacklist.id` 用的是同一个值
   * （那边存 `sha256(jti)`，这边存明文 jti —— 两张表的用途不同：
   * 一张是「吊销判定」，要防枚举所以存哈希；一张是「有效会话」，要给中间件快速匹配）。
   */
  jti: t.string().primary(),
  userId: t.uuid(),
  /** 这个 token 自己的过期时间（秒，Unix）。清理过期行时用。 */
  expiresAt: t.integer(),
  createdAt: t.timestamp().defaultNow().readOnly(),
}
