import { t } from '@nanokajs/core'

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
  body: t.string().min(1).max(500),
  deleted: t.boolean().default(false),
  createdAt: t.timestamp().defaultNow().readOnly(),
}
