/**
 * 有效 refresh token 的登记与吊销。
 *
 * 存在的理由见 `models/user-session.ts` 的注释：一句话概括，
 * **没有这张表就做不到「吊销某个用户的全部会话」**，而这让「改密码」形同虚设 ——
 * 改完密码，之前泄露出去的 refresh token 照样能换出新 access token。
 *
 * 和 `blacklist.ts` 的分工：
 *   - `auth_blacklist`（拒绝名单）：记「哪些 jti 已经被吊销」，防的是**重放**；
 *   - `user_sessions`（有效名单）：记「哪些 jti 还有效」，防的是**改密码后没换 token**。
 * 两者不能互相替代，缺一不可。
 */

const TABLE = 'user_sessions'

/** 清理过期行的频率：每 16 次写入顺手清一次。 */
const CLEANUP_INTERVAL = 16

let cleanupCounter = 0

/**
 * 登记一个刚签发的 refresh token。
 *
 * `jti` 存明文而不是像 blacklist 那样存 `sha256(jti)`：这张表要回答的是
 * 「这个 jti 还在不在有效列表里」，中间件每次 refresh 都要匹配一次，
 * 存哈希的话每次多一次 SHA-256（不贵，但没必要）。
 * 权衡：D1 里被看到能拿到有效 jti 清单 —— 但能看 D1 的人本来就能读密码哈希。
 */
export async function registerSession(
  db: D1Database,
  jti: string,
  userId: string,
  expiresAt: number,
): Promise<void> {
  cleanupCounter += 1
  const shouldCleanup = cleanupCounter % CLEANUP_INTERVAL === 0

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO ${TABLE} (jti, userId, expiresAt) VALUES (?1, ?2, ?3)
         ON CONFLICT(jti) DO UPDATE SET expiresAt = excluded.expiresAt`,
      )
      .bind(jti, userId, expiresAt),
  ]

  // 过期行本来也匹配不上（token 自己都过期了），留着只是让表无限变大。
  if (shouldCleanup) {
    statements.push(db.prepare(`DELETE FROM ${TABLE} WHERE expiresAt < ?1`).bind(nowSeconds()))
  }

  await db.batch(statements)
}

/** 这个 jti 现在还有效吗？改密码之后会被判成无效。 */
export async function isSessionActive(db: D1Database, jti: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS ok FROM ${TABLE} WHERE jti = ?1 AND expiresAt >= ?2 LIMIT 1`)
    .bind(jti, nowSeconds())
    .first<{ ok: number }>()
  return row !== null
}

/**
 * 吊销某个用户的**全部**会话，返回吊销了几条。
 *
 * 这就是改密码时调的那个 —— 删掉之后，那个人的所有 refresh token
 * 都在 `isSessionActive` 里查不到了，refresh 中间件会拒绝它们。
 */
export async function revokeAllSessions(db: D1Database, userId: string): Promise<number> {
  const before = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE userId = ?1`)
    .bind(userId)
    .first<{ n: number }>()

  await db.prepare(`DELETE FROM ${TABLE} WHERE userId = ?1`).bind(userId).run()

  return before?.n ?? 0
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}
