/**
 * 固定窗口限流，落在 D1 里。
 *
 * 存在的理由：`@nanokajs/auth` 的 README 明确写了 `loginHandler()` **不自带任何暴力破解防护**，
 * 必须在上层兜住，否则攻击者能按 Worker 的吞吐速度挨个试密码。
 * 而且我们的密码哈希是刻意做重的（scrypt），不限流还能被人拿来打 CPU。
 *
 * 计数写在 D1 而不是 isolate 内存里：Workers 的 isolate 是按 POP 分布的、随时会被回收，
 * 内存计数既不准也不好解释。代价是失败一次多一行写入，D1 免费额度 10 万行/天足够。
 *
 * 用法上刻意分成两个函数：
 *   - `peekRateLimit`：登录前先看一眼，已经超了就直接 429，**不要去做 scrypt 校验**；
 *   - `consumeRateLimit`：失败/注册时记账。
 * 这样正常登录路径只花一次读，不产生写。
 */

export interface RateLimitState {
  blocked: boolean
  /** 距离窗口重置还有多少秒，用于 Retry-After。 */
  retryAfterSeconds: number
}

const TABLE = 'rate_limits'
const FREE: RateLimitState = { blocked: false, retryAfterSeconds: 0 }

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function evaluate(hits: number, windowStart: number, limit: number, windowSeconds: number): RateLimitState {
  const elapsed = nowSeconds() - windowStart
  if (elapsed >= windowSeconds) return FREE
  if (hits < limit) return FREE
  return { blocked: true, retryAfterSeconds: Math.max(1, windowStart + windowSeconds - nowSeconds()) }
}

/** 只读地检查当前窗口是否已经超出限额。 */
export async function peekRateLimit(
  db: D1Database,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitState> {
  const row = await db
    .prepare(`SELECT hits, windowStart FROM ${TABLE} WHERE id = ?1`)
    .bind(key)
    .first<{ hits: number; windowStart: number }>()

  if (row === null) return FREE
  return evaluate(row.hits, row.windowStart, limit, windowSeconds)
}

/**
 * 记一次，并返回记账后的状态。
 * 用一条 UPSERT 完成「窗口过期就重置、否则自增」，避免读-改-写的竞态。
 */
export async function consumeRateLimit(
  db: D1Database,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitState> {
  const now = nowSeconds()
  const result = await db
    .prepare(
      `INSERT INTO ${TABLE} (id, hits, windowStart) VALUES (?1, 1, ?2)
       ON CONFLICT(id) DO UPDATE SET
         hits = CASE WHEN ${TABLE}.windowStart + ?3 <= ?2 THEN 1 ELSE ${TABLE}.hits + 1 END,
         windowStart = CASE WHEN ${TABLE}.windowStart + ?3 <= ?2 THEN ?2 ELSE ${TABLE}.windowStart END
       RETURNING hits, windowStart`,
    )
    .bind(key, now, windowSeconds)
    .all<{ hits: number; windowStart: number }>()

  const row = result.results?.[0]
  if (row === undefined) return FREE
  return evaluate(row.hits, row.windowStart, limit, windowSeconds)
}
