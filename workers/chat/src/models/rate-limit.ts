import { t } from '@nanokajs/core'

export const rateLimitTableName = 'rate_limits'

/**
 * 固定窗口限流表。`@nanokajs/auth` 明确说明 loginHandler 不带任何暴力破解防护，
 * 要自己在上层兜。D1 免费额度每天 10 万行写入，按「只记失败」的策略完全够用。
 *
 * 列名避开 SQL 关键字：用 `id` 而不是 `key`，用 `hits` 而不是 `count`。
 */
export const rateLimitFields = {
  id: t.string().primary(),
  hits: t.integer().default(0),
  windowStart: t.integer().default(0),
}
