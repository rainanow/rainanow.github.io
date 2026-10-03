import { t } from '@nanokajs/core'

export const userPurgeTableName = 'user_purges'

/**
 * 「注销用户」的审计流水。
 *
 * 和 `room_purges` 是同一个动机：注销是**不可逆**的破坏性操作
 * （删账号 + 改写他所有消息的作者名），所以必须留痕。
 *
 * 同样**不记录被删的内容**：只记「谁、什么时候、注销了哪个账号」，
 * 否则这张表就成了一份「谁发过什么」的名单 —— 那和删号的目标相反。
 *
 * 保留 `purgedMessages` 计数是为了回答「这次操作波及了多少条历史」，
 * 这个数字本身不泄露内容。
 */
export const userPurgeFields = {
  id: t.uuid().primary().readOnly(),
  /** 被注销的账号 id。账号行已删，这个值留着是为了万一要复盘还能定位。 */
  purgedUserId: t.uuid(),
  /** 被注销时的用户名。账号没了，得留个字符串才读得懂这张表。 */
  purgedUsername: t.string().min(2).max(20),
  /** 执行操作的管理员。 */
  purgedBy: t.uuid(),
  purgedByUsername: t.string().min(2).max(20),
  /** 这次把他的名字改写成了什么。 */
  renamedTo: t.string(),
  /** 波及了多少条历史消息。 */
  purgedMessages: t.integer().default(0),
  createdAt: t.timestamp().defaultNow().readOnly(),
}
