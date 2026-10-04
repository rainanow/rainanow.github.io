/**
 * 上传配额：挡住「把聊天室当免费网盘刷」。
 *
 * 为什么非要动 D1，不能继续用 isolate 内存：
 * 之前那个 3 秒间隔的限流是**内存**的，而 Workers 的 isolate 按 POP 分布、
 * 随时会被回收 —— 攻击者换个接入点就绕过去了。按 16MB × 3 秒算，
 * 一小时能灌进去将近 20GB，而 R2 免费额度只有 10GB。
 * 更别说注册本身是开放的（免费套餐发不了验证邮件），多注册几个号连「按人限」
 * 都能绕。所以这里必须落库，并且要有全站那一层兜底。
 *
 * 记账时机很关键：**先查后传、传成功才记**。
 * 不能反过来 —— 否则一次失败的上传（类型不符、R2 报错）也会白吃掉用户的额度。
 *
 * 但「先查」天然是 check-then-act：并发上传会同时看到「够」。所以最后的
 * 那笔写是**带条件**的（上限判定写进 UPSERT 的 WHERE），见 `markUpload`。
 * 预检负责把提示说清楚，带条件的写负责保证计数不越界，两者分工不同。
 */

import {
  DAILY_UPLOAD_BYTES_GLOBAL,
  DAILY_UPLOAD_BYTES_PER_USER,
  DAILY_UPLOAD_COUNT_GLOBAL,
  DAILY_UPLOAD_COUNT_PER_USER,
} from './config'

export interface QuotaDecision {
  allowed: boolean
  /** 不允许时给用户的说明，直接就能回给他看。 */
  reason?: string
  /** 今天还剩多少字节（allowed 为 true 时有值）。 */
  remainingBytes?: number
}

interface Usage {
  bytes: number
  count: number
}

/**
 * 配额按**北京时间**切日。
 *
 * 用 UTC 的话日界落在早上 8 点，用户会觉得「怎么早上八点才重置」。
 * D1 里存的就是这个字符串，所以改口径要连存量数据一起考虑。
 */
export function quotaDay(now = Date.now()): string {
  return new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

const userKey = (userId: string, day: string): string => `user:${userId}:${day}`
const globalKey = (day: string): string => `global:${day}`

async function readUsage(db: D1Database, id: string): Promise<Usage> {
  const row = await db
    .prepare('SELECT bytes, count FROM upload_usage WHERE id = ?1')
    .bind(id)
    .first<{ bytes: number; count: number }>()

  return { bytes: row?.bytes ?? 0, count: row?.count ?? 0 }
}

/**
 * 上传前问一句：这个人和全站今天的额度还够吗？
 *
 * 纯读，不改。这样调用方可以先鉴权、先看大小，最后才决定要不要记账。
 */
export async function checkUploadQuota(
  db: D1Database,
  userId: string,
  size: number,
): Promise<QuotaDecision> {
  const day = quotaDay()
  const [mine, all] = await Promise.all([
    readUsage(db, userKey(userId, day)),
    readUsage(db, globalKey(day)),
  ])

  // 全站那层先判：它一旦触顶，不管是谁都别传了
  if (all.count >= DAILY_UPLOAD_COUNT_GLOBAL || all.bytes + size > DAILY_UPLOAD_BYTES_GLOBAL) {
    return { allowed: false, reason: '今天全站的上传量到上限了，明天再来吧' }
  }

  if (mine.count >= DAILY_UPLOAD_COUNT_PER_USER) {
    return { allowed: false, reason: `今天已经传了 ${DAILY_UPLOAD_COUNT_PER_USER} 个文件了，明天再来吧` }
  }

  if (mine.bytes + size > DAILY_UPLOAD_BYTES_PER_USER) {
    return { allowed: false, reason: '今天你上传的总量到上限了，明天再来吧' }
  }

  return { allowed: true, remainingBytes: DAILY_UPLOAD_BYTES_PER_USER - mine.bytes }
}

/**
 * 一条**带条件**的 upsert 完成「没有就建、有就加」，而且加法本身会先看额度够不够。
 *
 * `ON CONFLICT ... DO UPDATE ... WHERE` 里的条件不满足时什么都不做，
 * 于是 `meta.changes` 为 0 —— 调用方据此知道「在我读完之后，额度被别人用掉了」。
 */
function guardedBumpStatement(
  db: D1Database,
  id: string,
  size: number,
  maxBytes: number,
  maxCount: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO upload_usage (id, bytes, count) VALUES (?1, ?2, 1)
       ON CONFLICT(id) DO UPDATE SET
         bytes = upload_usage.bytes + ?2,
         count = upload_usage.count + 1
       WHERE upload_usage.bytes + ?2 <= ?3 AND upload_usage.count + 1 <= ?4`,
    )
    .bind(id, size, maxBytes, maxCount)
}

/** 单个键退回一笔额度。`MAX(0, …)` 兜底，避免任何情况下把计数减成负数。 */
function refundKeyStatement(db: D1Database, id: string, size: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE upload_usage SET bytes = MAX(0, bytes - ?2), count = MAX(0, count - 1) WHERE id = ?1`,
    )
    .bind(id, size)
}

/**
 * 上传成功之后才调这个。个人和全站两个键一起记。
 *
 * ## 返回 false 的含义
 *
 * `checkUploadQuota` 是**纯读**的预检（它的作用是给出「今天已经传了 30 个」这种
 * 说得清楚的提示）。纯读就必然有 check-then-act 的竞态：同一账号并发传 N 个文件时，
 * N 个请求都会看到「够」，然后各自 +1 —— 越界的倍数取决于并发度，没有上界。
 *
 * 现在把上限判定写进 UPSERT 的 `WHERE` 里：更新不到就是「我读完之后额度被抢完了」。
 * 此时返回 `false`，调用方负责把刚传上去的那个对象删掉并回 429。
 * 计数器因此**永远不会越过上限**，代价只是极少数情况下多一次 R2 写 + 删。
 *
 * ## 为什么两个键要一起成功
 *
 * 只记上个人、没记上全站（或反过来）会留下半笔账。所以逐个看 `changes`，
 * 有任何一个失败就把已经记上的那个退回去，让状态回到「这次上传没发生过」。
 * 回退本身失败也不抛 —— 那只会让额度**宽松**一点，不该把请求变成 500。
 */
export async function markUpload(db: D1Database, userId: string, size: number): Promise<boolean> {
  const day = quotaDay()
  const mineKey = userKey(userId, day)
  const allKey = globalKey(day)

  const results = await db.batch([
    guardedBumpStatement(db, mineKey, size, DAILY_UPLOAD_BYTES_PER_USER, DAILY_UPLOAD_COUNT_PER_USER),
    guardedBumpStatement(db, allKey, size, DAILY_UPLOAD_BYTES_GLOBAL, DAILY_UPLOAD_COUNT_GLOBAL),
  ])

  const mineOk = (results[0]?.meta.changes ?? 0) > 0
  const allOk = (results[1]?.meta.changes ?? 0) > 0
  if (mineOk && allOk) return true

  if (mineOk || allOk) {
    const undo = mineOk ? mineKey : allKey
    await db
      .batch([refundKeyStatement(db, undo, size)])
      .catch((error: unknown) => {
        console.error('回退半笔上传配额失败', { key: undo, size, error })
      })
  }

  return false
}

/**
 * 撤回时把额度退回去。
 *
 * 不退的话，用户「传了又删」几次就把自己一天的额度耗光了 —— 他会觉得莫名其妙。
 * `day` 必须是**当初上传那天**（存在 R2 对象的 customMetadata 里），
 * 不能直接用今天：跨日撤回时退到今天，等于凭空多出额度。
 *
 * 用 MAX(0, …) 兜底，避免任何情况下把计数减成负数。
 */
export async function refundUpload(
  db: D1Database,
  userId: string,
  size: number,
  day: string,
): Promise<void> {
  await db.batch([
    refundKeyStatement(db, userKey(userId, day), size),
    refundKeyStatement(db, globalKey(day), size),
  ])
}
