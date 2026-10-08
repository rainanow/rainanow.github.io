/**
 * 上传配额：挡住「把聊天室当免费网盘刷」。
 *
 * ## 两把尺子，量的是两件事
 *
 *   - **文件数按天**：挡「短时间内刷一堆小文件」。每天重置符合直觉。
 *   - **字节数按累计总量**：挡「长期把存储当网盘用」。这一条**永不重置** ——
 *     按天重置挡不住它（每天传满一点，存储只增不减），而 R2 的免费额度正是按
 *     存储量算的（10 GB-month），跟「每天传多少」无关。
 *
 * 所以账本用四个键、两张尺子分开记：
 *
 *   | 键 | 记在哪列 | 重置 |
 *   | --- | --- | --- |
 *   | `daily:user:<userId>:<YYYY-MM-DD>` | `count` | 每天 |
 *   | `daily:global:<YYYY-MM-DD>` | `count` | 每天 |
 *   | `total:user:<userId>` | `bytes` | 永不 |
 *   | `total:global` | `bytes` | 永不 |
 *
 * 四个键共用 `upload_usage` 这一张表（表本来就有 bytes / count 两列，够用），
 * 于是这次改动**不需要任何数据库迁移**。每行的两个维度只有一个有值。
 *
 * ## 为什么非要落库，不能继续用 isolate 内存
 *
 * 之前那个 3 秒间隔的限流是**内存**的，而 Workers 的 isolate 按 POP 分布、
 * 随时会被回收 —— 攻击者换个接入点就绕过去了。按 16 MB × 3 秒算，
 * 一小时能灌进去将近 20 GB，而 R2 免费额度只有 10 GB。
 * 更别说注册本身是开放的（免费套餐发不了验证邮件），多注册几个号连「按人限」
 * 都能绕。所以这里必须落库，并且要有全站那一层兜底。
 *
 * ## 记账时机
 *
 * **先查后传、传成功才记**。不能反过来 —— 否则一次失败的上传（类型不符、
 * R2 报错）也会白吃掉用户的额度。
 *
 * 但「先查」天然是 check-then-act：并发上传会同时看到「够」。所以最后的
 * 那笔写是**带条件**的（上限判定写进 UPSERT 的 WHERE），见 `markUpload`。
 * 预检负责把提示说清楚，带条件的写负责保证计数不越界，两者分工不同。
 */

import {
  DAILY_UPLOAD_COUNT_GLOBAL,
  DAILY_UPLOAD_COUNT_PER_USER,
  TOTAL_UPLOAD_BYTES_GLOBAL,
  TOTAL_UPLOAD_BYTES_PER_USER,
} from './config'

export interface QuotaDecision {
  allowed: boolean
  /** 不允许时给用户的说明，直接就能回给他看。 */
  reason?: string
  /** 允许时：**累计**字节额度还剩多少（不是「今天还剩多少」）。 */
  remainingBytes?: number
}

interface Usage {
  bytes: number
  count: number
}

const EMPTY: Usage = { bytes: 0, count: 0 }

/**
 * 配额里**按天**那一半按**北京时间**切日。
 *
 * 用 UTC 的话日界落在早上 8 点，用户会觉得「怎么早上八点才重置」。
 * 注意只有文件数用这个；字节数是累计总量，跟日界无关。
 * D1 里存的就是这个字符串，所以改口径要连存量数据一起考虑。
 */
export function quotaDay(now = Date.now()): string {
  return new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** 八个键的构造集中在这里，别在调用点手拼字符串。 */
export const dailyUserCountKey = (userId: string, day: string): string => `daily:user:${userId}:${day}`
export const dailyGlobalCountKey = (day: string): string => `daily:global:${day}`
export const totalUserBytesKey = (userId: string): string => `total:user:${userId}`
export const TOTAL_GLOBAL_BYTES_KEY = 'total:global'

const GB = 1024 * 1024 * 1024
const perUserGb = Math.round(TOTAL_UPLOAD_BYTES_PER_USER / GB)
const globalGb = Math.round(TOTAL_UPLOAD_BYTES_GLOBAL / GB)

async function readUsage(db: D1Database, id: string): Promise<Usage> {
  const row = await db
    .prepare('SELECT bytes, count FROM upload_usage WHERE id = ?1')
    .bind(id)
    .first<{ bytes: number; count: number }>()

  return { bytes: row?.bytes ?? 0, count: row?.count ?? 0 }
}

/**
 * 上传前问一句：这个人今天还能传几个文件、存储还剩多少？
 *
 * 纯读，不改。这样调用方可以先鉴权、先看大小，最后才决定要不要记账。
 *
 * 四条查询并发发出去（原本两条）。D1 免费版单次调用上限 50 条查询，
 * 加上限流和用户查询也远远够用。
 */
export async function checkUploadQuota(
  db: D1Database,
  userId: string,
  size: number,
): Promise<QuotaDecision> {
  const day = quotaDay()
  const [globalBytes, globalCount, mineCount, mineBytes] = await Promise.all([
    readUsage(db, TOTAL_GLOBAL_BYTES_KEY),
    readUsage(db, dailyGlobalCountKey(day)),
    readUsage(db, dailyUserCountKey(userId, day)),
    readUsage(db, totalUserBytesKey(userId)),
  ])

  // 全站存储先判：它一旦触顶，不管是谁都别传了（R2 免费额度是 10 GB，卡在 8 GB）
  if (globalBytes.bytes + size > TOTAL_UPLOAD_BYTES_GLOBAL) {
    return { allowed: false, reason: `全站的存储空间到上限了（${globalGb} GB），暂时传不了文件` }
  }

  if (globalCount.count >= DAILY_UPLOAD_COUNT_GLOBAL) {
    return { allowed: false, reason: '今天全站的上传量到上限了，明天再来吧' }
  }

  if (mineCount.count >= DAILY_UPLOAD_COUNT_PER_USER) {
    return { allowed: false, reason: `今天已经传了 ${DAILY_UPLOAD_COUNT_PER_USER} 个文件了，明天再来吧` }
  }

  if (mineBytes.bytes + size > TOTAL_UPLOAD_BYTES_PER_USER) {
    return {
      allowed: false,
      reason: `你的存储空间到上限了（${perUserGb} GB），删掉一些才能继续传`,
    }
  }

  return { allowed: true, remainingBytes: TOTAL_UPLOAD_BYTES_PER_USER - mineBytes.bytes }
}

/**
 * 一条**带条件**的 upsert：没有就建、有就加，而且加法本身先看额度够不够。
 *
 * `ON CONFLICT ... DO UPDATE ... WHERE` 的条件不满足时什么都不做，
 * 于是 `meta.changes` 为 0 —— 调用方据此知道「在我读完之后，额度被别人用掉了」。
 */
function guardedCountStatement(
  db: D1Database,
  id: string,
  maxCount: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO upload_usage (id, bytes, count) VALUES (?1, 0, 1)
       ON CONFLICT(id) DO UPDATE SET count = upload_usage.count + 1
       WHERE upload_usage.count + 1 <= ?2`,
    )
    .bind(id, maxCount)
}

function guardedBytesStatement(
  db: D1Database,
  id: string,
  size: number,
  maxBytes: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO upload_usage (id, bytes, count) VALUES (?1, ?2, 0)
       ON CONFLICT(id) DO UPDATE SET bytes = upload_usage.bytes + ?2
       WHERE upload_usage.bytes + ?2 <= ?3`,
    )
    .bind(id, size, maxBytes)
}

/** 退一笔计数（按天那两把尺子）。`MAX(0, …)` 兜底，避免把计数减成负数。 */
function refundCountStatement(db: D1Database, id: string): D1PreparedStatement {
  return db
    .prepare('UPDATE upload_usage SET count = MAX(0, count - 1) WHERE id = ?1')
    .bind(id)
}

/** 退一笔字节（累计那两把尺子）。 */
function refundBytesStatement(db: D1Database, id: string, size: number): D1PreparedStatement {
  return db
    .prepare('UPDATE upload_usage SET bytes = MAX(0, bytes - ?2) WHERE id = ?1')
    .bind(id, size)
}

/**
 * 上传成功之后才调这个。四个键一起记。
 *
 * ## 返回 false 的含义
 *
 * `checkUploadQuota` 是**纯读**的预检（它的作用是给出「今天已经传了 100 个」
 * 这种说得清楚的提示）。纯读就必然有 check-then-act 的竞态：同一账号并发传
 * N 个文件时，N 个请求都会看到「够」，然后各自 +1 —— 越界的倍数取决于并发度，
 * 没有上界。
 *
 * 现在把上限判定写进 UPSERT 的 `WHERE` 里：更新不到就是「我读完之后额度被抢完了」。
 * 此时返回 `false`，调用方负责把刚传上去的那个对象删掉并回 429。
 * 计数器因此**永远不会越过上限**，代价只是极少数情况下多一次 R2 写 + 删。
 *
 * ## 为什么四个键要一起成功
 *
 * 只记上其中一部分会留下半笔账。所以逐个看 `meta.changes`，有任何一个失败就把
 * 已经记上的那些**全部退回去**，让状态回到「这次上传没发生过」。
 * 回退本身失败也不抛 —— 那只会让额度**宽松**一点，不该把请求变成 500。
 */
export async function markUpload(db: D1Database, userId: string, size: number): Promise<boolean> {
  const day = quotaDay()
  const keys = {
    userCount: dailyUserCountKey(userId, day),
    globalCount: dailyGlobalCountKey(day),
    userBytes: totalUserBytesKey(userId),
    globalBytes: TOTAL_GLOBAL_BYTES_KEY,
  }

  const results = await db.batch([
    guardedCountStatement(db, keys.userCount, DAILY_UPLOAD_COUNT_PER_USER),
    guardedCountStatement(db, keys.globalCount, DAILY_UPLOAD_COUNT_GLOBAL),
    guardedBytesStatement(db, keys.userBytes, size, TOTAL_UPLOAD_BYTES_PER_USER),
    guardedBytesStatement(db, keys.globalBytes, size, TOTAL_UPLOAD_BYTES_GLOBAL),
  ])

  const applied = [
    { ok: (results[0]?.meta.changes ?? 0) > 0, undo: refundCountStatement(db, keys.userCount) },
    { ok: (results[1]?.meta.changes ?? 0) > 0, undo: refundCountStatement(db, keys.globalCount) },
    { ok: (results[2]?.meta.changes ?? 0) > 0, undo: refundBytesStatement(db, keys.userBytes, size) },
    { ok: (results[3]?.meta.changes ?? 0) > 0, undo: refundBytesStatement(db, keys.globalBytes, size) },
  ]

  if (applied.every((item) => item.ok)) return true

  const rollback = applied.filter((item) => item.ok).map((item) => item.undo)
  if (rollback.length > 0) {
    await db.batch(rollback).catch((error: unknown) => {
      console.error('回退半笔上传配额失败', { userId, size, error })
    })
  }

  return false
}

/**
 * 撤回时把额度退回去。
 *
 * 不退的话，用户「传了又删」几次就把额度耗光了 —— 他会觉得莫名其妙。
 *
 * ⚠️ `day` 必须是**当初上传那天**（存在 R2 对象的 customMetadata 里），
 * 不能直接用今天：跨日撤回时退到今天那个键上，等于凭空多出一份每日文件数。
 * 累计字节那两个键没有日期，所以不受影响 —— 这也正是把它们做成累计的好处之一，
 * 跨日撤回不会算错账。
 */
export async function refundUpload(
  db: D1Database,
  userId: string,
  size: number,
  day: string,
): Promise<void> {
  await db.batch([
    refundCountStatement(db, dailyUserCountKey(userId, day)),
    refundCountStatement(db, dailyGlobalCountKey(day)),
    refundBytesStatement(db, totalUserBytesKey(userId), size),
    refundBytesStatement(db, TOTAL_GLOBAL_BYTES_KEY, size),
  ])
}
