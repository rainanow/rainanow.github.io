/**
 * 系统消息：房间里发生的、不是某个人「说」出来的事。
 *
 * 目前有三种：**加入房间**、**离开房间**、**撤回了一条消息**。
 * 它们和普通消息**共用 `messages` 表**（靠 `kind` 列区分），理由只有一个但足够：
 * 历史是按 `(createdAt, id)` 游标翻页的，两套数据分表存就得在接口层做
 * 「两路归并 + 跨表游标」，复杂度全砸在最不该复杂的地方。同表存之后，
 * 它们天然按时间交错，翻页 / 清空 / 导出三处一行都不用改。
 *
 * ## 为什么要哨兵作者，而不是让 userId 为空
 *
 * `messages` 那几列全是 NOT NULL（见表里的注释）。想把 `userId` 改成可空，
 * 在 SQLite 上等于重建整张表 —— 为了几个字符的语义不值得。
 * 所以系统消息用 `SYSTEM_USER_ID` 这个固定 uuid + `SYSTEM_USERNAME`，
 * 二分靠 `kind`，不靠「某个字段是不是空」。
 *
 * ## 文案为什么在服务端定
 *
 * 因为要**落库**。同一条系统消息必须对所有人和所有时间都长得一样，
 * 包括刷新之后从历史里读出来的那份 —— 文案一旦放在前端拼，
 * 历史里的 body 就没有意义了（它只是一段文本）。而且「管理员撤回了别人的消息」
 * 这句需要同时知道**操作者**和**作者**，那个信息只有服务端有。
 *
 * ⚠️ 所以这些文案是**可信内容**，前端渲染系统消息时可以直接当纯文本放进 DOM；
 * 但也只是「放进 textContent」—— 用户名是用户可控的，绝不能拼进 innerHTML。
 */

import { KIND_SYSTEM, KIND_USER, MAX_MESSAGE_LENGTH, SYSTEM_USER_ID, SYSTEM_USERNAME } from './config'

export { KIND_SYSTEM, KIND_USER, SYSTEM_USER_ID, SYSTEM_USERNAME }

/** 一条系统消息的完整形状（已经可以直接落库 / 广播）。 */
export interface SystemMessageRow {
  id: string
  room: string
  userId: string
  username: string
  body: string
  kind: string
  createdAt: number
}

/**
 * 落库用的 SQL。**Worker 和 Durable Object 共用这一条**，
 * 两边都拿不到对方的模型层（DO 里没有 nanoka 的 app），所以语句得摆在中间。
 *
 * 显式写 `createdAt` 而不是用列默认值：广播出去的那份和库里那份必须是**同一个**
 * 时间戳，否则前端按 createdAt 排序时，同一条消息在「实时收到」和「刷新后读到」
 * 两种情况下会落在不同位置。
 */
export const SYSTEM_MESSAGE_INSERT =
  `INSERT INTO messages (id, room, userId, username, body, kind, deleted, createdAt)` +
  ` VALUES (?1, ?2, ?3, ?4, ?5, '${KIND_SYSTEM}', 0, ?6)`

/**
 * 造一条待落库的系统消息。`now` 可注入，方便测试。
 *
 * 截断到 `MAX_MESSAGE_LENGTH`：`messages.body` 在表里有长度约束，而系统消息
 * **绕过了 `POST /api/messages` 的 Zod 校验**（它不是从那条路由进来的），
 * 也就是说这里是唯一一道闸。当前的三种文案都远远够不到上限（用户名本身
 * 卡在 20 字），但「谁 清空了房间（共 12345 条消息）」这类文案早晚会出现 ——
 * 到那时候没有这道截断，插入会因为约束失败而静默丢掉整条提示。
 */
export function systemMessage(room: string, body: string, now = Date.now()): SystemMessageRow {
  return {
    id: crypto.randomUUID(),
    room,
    userId: SYSTEM_USER_ID,
    username: SYSTEM_USERNAME,
    body: body.slice(0, MAX_MESSAGE_LENGTH),
    kind: KIND_SYSTEM,
    createdAt: now,
  }
}

/** 写入系统消息。调用方决定失败怎么办 —— 这个模块不吞异常。 */
export async function insertSystemMessage(db: D1Database, message: SystemMessageRow): Promise<void> {
  await db
    .prepare(SYSTEM_MESSAGE_INSERT)
    .bind(
      message.id,
      message.room,
      message.userId,
      message.username,
      message.body,
      message.createdAt,
    )
    .run()
}

export function joinNotice(username: string): string {
  return `${username} 加入了房间`
}

export function leaveNotice(username: string): string {
  return `${username} 离开了房间`
}

/**
 * 撤回提示。分两句话，因为这两种情况在**责任上**完全不同：
 * 自己撤自己说的是「我改主意了」，管理员撤别人的是管理动作。
 * 后者必须能一眼看出来 —— 这也是 `deletedBy` 那个审计字段存在的理由。
 */
export function withdrawNotice(actor: string, author: string): string {
  return actor === author
    ? `${author} 撤回了一条消息`
    : `${actor}（管理员）撤回了 ${author} 的一条消息`
}
