/**
 * 全站每日请求数熔断，阈值对齐 **Cloudflare Workers 免费版的 10 万请求/天**。
 *
 * ## 为什么要有这一层
 *
 * 超了 10 万请求，Cloudflare 直接返回 1027 错误页（免费额度按 **UTC 午夜**重置）。
 * 那是「整站突然打不开」的结局，连一句能看懂的话都没有。这一层的作用不是防攻击
 * （防攻击是各处按 IP / 按账号的限流），而是**把平台的硬边界翻译成人话**：
 * 到顶之后回一句「今天到上限了，明天再来」，而不是让人对着 1027 猜。
 *
 * ## 为什么计数不每请求写 D1
 *
 * 10 万请求 × 1 次写正好等于 D1 免费额度的「写入 10 万行/天」——
 * 而 D1 超了额度是**直接拒绝执行查询**（不是计费），等于拿 D1 的额度去守
 * Workers 的额度，两边一起死。
 *
 * 所以采用了「isolate 内存累加 + 每 10 秒批量落一次库」：
 *
 *   - 每天写入量从 10 万降到约 8640 次（86400 秒 / 10 秒）；
 *   - 代价是**计数是软性的**：最多滞后一个同步周期，且每个 isolate 各自有
 *     一份 pending。判断用的是「库里的总数 + 本 isolate 还没落库的部分」，
 *     所以只会**偏保守地早拦**，不会漏放很久。
 *
 * 这个取舍是刻意的：它是**成本护栏**，不是安全边界。少拦几个请求的后果是
 * 多花几毫秒 CPU；而为了精确计数去写 10 万行 D1，后果是整个库不能用。
 *
 * ## 失败必须放行（fail-open）
 *
 * 同步失败（D1 抖动、超额度）时只记日志、不抛。理由同上：护栏坏掉不该让
 * 网站打不开 —— 这与按账号限流的 fail-closed 取向**相反**，方向不同是有意的，
 * 别照着那边改。
 */

import type { MiddlewareHandler } from 'hono'

import { GLOBAL_DAILY_REQUEST_LIMIT } from './config'
import type { AppEnv } from './context'

/** 复用限流那张表：形状正好够用（id / hits / windowStart），也省掉一次数据库迁移。 */
const TABLE = 'rate_limits'

/** 多久把内存里的 pending 落一次库。调小＝更准但写得多，调大＝更省但更滞后。 */
const FLUSH_INTERVAL_MS = 10_000

/**
 * `windowStart` 存的是最后一次同步的时刻。它同时被 `rate-limit.ts` 的清理逻辑
 * 用到（`windowStart + 24h < now` 就删），所以每次同步都要更新它，
 * 否则这一行会在第二天被当成过期数据清掉 —— 而它其实还在用。
 */
interface BreakerState {
  /** UTC 日期，跨日就整块重置（与 Cloudflare 额度重置的时刻一致）。 */
  day: string
  /** 上一次同步拿到的全站总数。 */
  known: number
  /** 本 isolate 自上次同步以来处理的请求数。 */
  pending: number
  /** 上次同步的时刻。初始 0 保证「isolate 的第一个请求一定先同步」。 */
  syncedAt: number
}

/**
 * 按 isolate 缓存的计数状态。
 *
 * 和 `app.ts` 里缓存整个 app 是同一个前提：同一个 isolate 内 `env` 稳定。
 * Workers 的 isolate 会按 POP 分布、随时被回收，所以这只是「尽力而为」的账本。
 */
let state: BreakerState | null = null

/** Cloudflare 的免费额度按 UTC 0 点重置，所以这里也用 UTC 切日。 */
function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

/** 距离下一个 UTC 0 点还有多少秒，用来填 `Retry-After`。 */
function secondsUntilUtcMidnight(now: number): number {
  const date = new Date(now)
  const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)
  return Math.max(1, Math.ceil((next - now) / 1000))
}

/**
 * 把本 isolate 的 pending 加到库里，并把库里返回的总数记下来。
 *
 * 用一条 `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` 完成「加」和「读回」：
 * 分两次（先读再加）在多个 isolate 并发时会互相覆盖，把对方的计数吃掉。
 */
async function sync(db: D1Database, current: BreakerState): Promise<void> {
  const now = Date.now()
  const id = `requests:${current.day}`
  const pending = current.pending

  try {
    const row = await db
      .prepare(
        `INSERT INTO ${TABLE} (id, hits, windowStart) VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET hits = ${TABLE}.hits + ?2, windowStart = ?3
         RETURNING hits`,
      )
      .bind(id, pending, Math.floor(now / 1000))
      .first<{ hits: number }>()

    current.known = row?.hits ?? current.known + pending
    current.pending = 0
    current.syncedAt = now
  } catch (error) {
    // fail-open：护栏自身出错不该让网站打不开。只把同步时刻推后，下个周期再试，
    // pending 继续在内存里累积（本 isolate 内部仍然是准的）。
    current.syncedAt = now
    console.error('全站请求计数同步失败（本轮退化为按 isolate 自计）', error)
  }
}

export const globalRequestLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const now = Date.now()
  const day = utcDay(now)

  if (state === null || state.day !== day) {
    // syncedAt 从 0 开始 → isolate 的第一个请求（以及跨日后的第一个请求）
    // 一定会先同步一次，避免新 isolate 在「额度早就满了」的情况下还放行 10 秒。
    state = { day, known: 0, pending: 0, syncedAt: 0 }
  }

  const current = state
  current.pending += 1

  if (now - current.syncedAt >= FLUSH_INTERVAL_MS) {
    await sync(c.env.DB, current)
  }

  if (current.known + current.pending >= GLOBAL_DAILY_REQUEST_LIMIT) {
    c.header('Retry-After', String(secondsUntilUtcMidnight(now)))
    return c.json(
      {
        error: `今天全站的访问量到上限了（${GLOBAL_DAILY_REQUEST_LIMIT} 次），${secondsUntilUtcMidnight(now)} 秒后再来`,
      },
      429,
    )
  }

  await next()
}
