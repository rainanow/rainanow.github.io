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

/**
 * 本地开发时把阈值放大到「等于没有」。
 *
 * ## 为什么需要
 *
 * 限流按 IP 记账，但**本地 `clientIp()` 一律返回 `unknown`**
 * （拿不到 CF-Connecting-IP），所以本机所有请求共用 `127.0.0.1` 一个桶。
 * 写几个测试脚本、或手动注册几个账号就能把 5 次/小时的额度用光，
 * 之后登录/注册直接 429 —— 现象像「代码坏了」，其实只是撞了限流。
 *
 * 调试期间反复去清 `rate_limits` 表很打断思路（本项目 2026-10-03 那天清了好几回），
 * 所以给个开关。
 *
 * ## 线上会不会被削弱
 *
 * 不会：这个开关只写在 `.dev.vars` 里，而 **`wrangler deploy` 不读 `.dev.vars`**
 * （那是 `wrangler dev` 专用的文件）。所以生产环境它恒为 undefined。
 * 判定用 `=== 'true'`，空串/别拼错的值都走「不放宽」这一侧。
 *
 * ## 放大多少
 *
 * 放到 100 万。不是「取消记账」—— 记账照做、行为可观测，
 * 只是阈值高到正常调试永远碰不到。这样万一以后写了依赖限流行为的测试，
 * 在本地也能跑出真实结果，而不是被静默跳过。
 */
const LOCAL_RELAXED_LIMIT = 1_000_000

/** 只在本机 `wrangler dev` 且 .dev.vars 显式设了 RELAX_LOCAL_LIMITS=true 时为真。 */
export function isLimitRelaxed(env: {
  RELAX_LOCAL_LIMITS?: string
  STRICT_RATE_LIMIT?: string
}): boolean {
  // 测试可以显式要求「限流必须生效」，用来跑那些断言 429 的用例。
  // 少了这一条，开发机上一旦开了放宽，限流测试就会集体变红
  // （实测 12 条），而人很容易把它当成「代码坏了」去查错方向。
  if (env.STRICT_RATE_LIMIT === 'true') return false
  return env.RELAX_LOCAL_LIMITS === 'true'
}

/**
 * 真正拿去比较的阈值。本地放宽时换成巨大的数，线上原样返回。
 *
 * 单独抽出来是为了让**所有调用点都不用改** —— 限流有七八处，
 * 逐处加 `if (local)` 早晚有人漏掉一处，而漏掉的那处会毫无征兆。
 */
export function effectiveLimit(
  env: { RELAX_LOCAL_LIMITS?: string; STRICT_RATE_LIMIT?: string },
  limit: number,
): number {
  return isLimitRelaxed(env) ? LOCAL_RELAXED_LIMIT : limit
}

export interface RateLimitState {
  blocked: boolean
  /** 距离窗口重置还有多少秒，用于 Retry-After。 */
  retryAfterSeconds: number
}

const TABLE = 'rate_limits'
const FREE: RateLimitState = { blocked: false, retryAfterSeconds: 0 }

/**
 * 每这么多次写入顺手清一次过期行。和 blacklist.ts 一个思路：
 * 单独为清理跑一条 SQL 不划算，搭着已有的写入做就行。
 */
const CLEANUP_INTERVAL = 32

/**
 * 窗口开始多久之后才算「可以删」。
 *
 * 表里只存了 windowStart、没存这一行用的是多长的窗口，所以只能取一个上界。
 * 目前最长的窗口是注册限流的 1 小时，给到 24 小时再删——宁可多留一会儿，
 * 也绝不能把还在生效的计数删掉（那等于把限流重置了）。
 * 将来要是加了更长的窗口，这个值必须跟着调大。
 */
const RETENTION_SECONDS = 24 * 60 * 60

let cleanupCounter = 0

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

  cleanupCounter += 1
  if (cleanupCounter % CLEANUP_INTERVAL === 0) {
    await db
      .prepare(`DELETE FROM ${TABLE} WHERE windowStart + ?1 < ?2`)
      .bind(RETENTION_SECONDS, now)
      .run()
  }

  const row = result.results?.[0]
  if (row === undefined) return FREE
  return evaluate(row.hits, row.windowStart, limit, windowSeconds)
}
