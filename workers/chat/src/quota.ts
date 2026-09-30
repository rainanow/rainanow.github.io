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

/** 一条 upsert 完成「没有就建、有就加」，不用读-改-写。 */
function bumpStatement(db: D1Database, id: string, size: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO upload_usage (id, bytes, count) VALUES (?1, ?2, 1)
       ON CONFLICT(id) DO UPDATE SET bytes = upload_usage.bytes + ?2, count = upload_usage.count + 1`,
    )
    .bind(id, size)
}

/** 上传成功之后才调这个。个人和全站两个键一起记。 */
export async function markUpload(db: D1Database, userId: string, size: number): Promise<void> {
  const day = quotaDay()
  await db.batch([bumpStatement(db, userKey(userId, day), size), bumpStatement(db, globalKey(day), size)])
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
  const statement = db
    .prepare(
      `UPDATE upload_usage SET bytes = MAX(0, bytes - ?2), count = MAX(0, count - 1) WHERE id = ?1`,
    )

  await db.batch([
    statement.bind(userKey(userId, day), size),
    statement.bind(globalKey(day), size),
  ])
}
