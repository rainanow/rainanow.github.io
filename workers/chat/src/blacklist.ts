/**
 * 把 refresh token 的吊销名单放在 D1 里，实现 `@nanokajs/auth` 的 `BlacklistStore` 接口。
 *
 * 库自带的是 `kvBlacklistStore`，要额外开一个 KV namespace。放 D1 有两个好处：
 *   1. 少一个要配置的云资源；
 *   2. **D1 是强一致的，KV 是最终一致的**。库的 README 自己写了 KV 版的坑：
 *      跨区域的两个并发 refresh 可能都通过校验。D1 没这个问题。
 *
 * 和官方 KV 实现一样，落库的是 `sha256(jti)` 而不是明文 jti——D1 里就算被人看到，
 * 也拿不到可用的 jti 清单。
 */

import type { BlacklistStore } from '@nanokajs/auth'

const TABLE = 'auth_blacklist'

/** 清理过期行的频率：每 32 次写入顺手清一次，避免每次写都多跑一条 DELETE。 */
const CLEANUP_INTERVAL = 32

let cleanupCounter = 0

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

async function revoke(
  db: D1Database,
  jti: string,
  subject: string,
  expiresAt: number,
): Promise<void> {
  const id = await sha256Hex(jti)
  await db
    .prepare(
      `INSERT INTO ${TABLE} (id, subject, expiresAt) VALUES (?1, ?2, ?3)
       ON CONFLICT(id) DO UPDATE SET subject = ?2, expiresAt = ?3`,
    )
    .bind(id, subject, expiresAt)
    .run()

  cleanupCounter += 1
  if (cleanupCounter % CLEANUP_INTERVAL === 0) {
    // 过期行留着不影响正确性（查询会按 expiresAt 过滤），只是白占存储，慢慢清就行。
    await db.prepare(`DELETE FROM ${TABLE} WHERE expiresAt < ?1`).bind(nowSeconds()).run()
  }
}

async function isRevoked(db: D1Database, jti: string, subject?: string): Promise<boolean> {
  const id = await sha256Hex(jti)
  const row = await db
    .prepare(`SELECT subject FROM ${TABLE} WHERE id = ?1 AND expiresAt > ?2`)
    .bind(id, nowSeconds())
    .first<{ subject: string }>()
  if (row === null) return false
  // 不传 subject 时只要存在就算已吊销；传了就要求 sub 也对得上（纵深防御）。
  return subject === undefined || row.subject === subject
}

/**
 * 主动吊销一个 refresh token（登出用）。
 *
 * 单独导出这个函数、而不是让调用方走 `BlacklistStore.addWithSubject`，
 * 是因为接口上那两个方法是**可选**的（`addWithSubject?`），调用时要处理 undefined；
 * 而且走必选的 `add()` 会把 subject 记成空串，之后库的 `hasForSubject(jti, sub)`
 * 永远比对不上，登出就变成了「看起来成功、其实没吊销」。这里绕过那个歧义。
 */
export async function revokeRefreshToken(
  db: D1Database,
  jti: string,
  subject: string,
  expiresAt: number,
): Promise<void> {
  await revoke(db, jti, subject, expiresAt)
}

export function d1BlacklistStore(db: D1Database): BlacklistStore {
  return {
    async add(jti, expiresAt) {
      await revoke(db, jti, '', expiresAt)
    },
    async has(jti) {
      return isRevoked(db, jti)
    },
    async addWithSubject(jti, subject, expiresAt) {
      await revoke(db, jti, subject, expiresAt)
    },
    async hasForSubject(jti, subject) {
      return isRevoked(db, jti, subject)
    },
  }
}
