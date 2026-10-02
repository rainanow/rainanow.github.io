import { t } from '@nanokajs/core'

import { MAX_MESSAGE_LENGTH } from '../config'

export const messageTableName = 'messages'

/**
 * 聊天消息表。
 *
 * `username` 是刻意的冗余（没有 users 表 join）：D1 免费额度是按「读取行数」计的，
 * 每页历史消息都多读 N 行 users 会让额度消耗翻倍。代价是改用户名不会回溯历史消息，
 * 目前没有改名功能，可以接受。
 *
 * `deleted` 用软删除：管理员删掉的消息仍然占一行，但不再返回，方便留着追责。
 */
export const messageFields = {
  id: t.uuid().primary().readOnly(),
  room: t.string().default('general'),
  userId: t.uuid(),
  username: t.string().min(2).max(20),
  // 同 routes/chat.ts：读常量而不是写死 500。改消息长度上限只需要动 config.ts 一处。
  body: t.string().min(1).max(MAX_MESSAGE_LENGTH),
  deleted: t.boolean().default(false),
  /**
   * 撤回的审计字段。**没有这两个，README 里那句「软删方便留着追责」就是空的** ——
   * `deleted` 只说明「它被删了」，说不出是谁删的、什么时候删的。
   *
   * 两个都是 optional（可空）：没被删过的消息这两列是 NULL。
   *
   * `deletedBy` 记的是**操作者**的 userId，不是消息作者 ——
   * 管理员删别人的消息时，这两者不一样，而恰恰是那种情况才需要追责。
   */
  deletedBy: t.uuid().optional(),
  deletedAt: t.timestamp().optional(),
  createdAt: t.timestamp().defaultNow().readOnly(),
}
