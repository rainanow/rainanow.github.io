import { t } from '@nanokajs/core'

export const roomPurgeTableName = 'room_purges'

/**
 * 「清空房间」的审计表。
 *
 * 为什么必须单独一张表，不能靠 messages 表的 `deleted` 字段：
 * 清空房间是**硬删**（`DELETE FROM messages WHERE room = ?`），
 * 消息行整个没了 —— 软删那套审计字段（deletedBy / deletedAt）在这里
 * 连写入的机会都没有。而清空又是所有操作里破坏性最大的一个
 * （消息 + 引用的媒体文件一起消失，没有撤销），
 * 恰恰是最该留下痕迹的。
 *
 * 所以每清空一次就在这里落一行：谁、什么时候、清了哪个房间、
 * 多少条消息、多少个文件。事后至少能回答「是谁干的」。
 *
 * 注意这里**不记录消息内容**：那等于把刚删掉的东西又存了一份，
 * 和「清空」这个动作的意图相反。只记元数据。
 */
export const roomPurgeFields = {
  id: t.uuid().primary().readOnly(),
  /** 被清空的房间名。 */
  room: t.string(),
  /** 操作者的 userId。 */
  purgedBy: t.uuid(),
  /** 操作者的用户名，省得事后还要拿 userId 去 users 表查一遍。 */
  purgedByUsername: t.string().min(2).max(20),
  /** 删掉了多少条消息。 */
  removedMessages: t.integer().default(0),
  /** 连带删掉了多少个 R2 对象。 */
  removedMedia: t.integer().default(0),
  createdAt: t.timestamp().defaultNow().readOnly(),
}
