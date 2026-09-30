import { t } from '@nanokajs/core'

export const uploadUsageTableName = 'upload_usage'

/**
 * 上传配额账本。一行 = 一个计数键在某一天的累计。
 *
 * `id` 有两种形态，塞在同一张表里省一次建表：
 *
 *   - `user:<userId>:<YYYY-MM-DD>`  → 这个人今天传了多少
 *   - `global:<YYYY-MM-DD>`         → 全站今天传了多少
 *
 * 为什么不用 rate_limits 那张表：那边的语义是「窗口内的次数」，
 * 这里要记**字节数**，混在一起会让两张表的含义都变糊。
 *
 * 为什么按天而不是滑动窗口：配额这东西给人看的，按自然日算最直观，
 * 而且重置时机可预期（用户第二天自然就能再传）。
 */
export const uploadUsageFields = {
  id: t.string().primary(),
  bytes: t.integer().default(0),
  count: t.integer().default(0),
}
