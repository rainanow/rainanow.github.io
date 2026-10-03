-- 用户管理这批改动的迁移，三件事一起做（分三个迁移没意义，都是同一次上线）。
--
-- ⚠️ 文件名被**手工改过两次**：先生成 0003_milky_shape（撞了 0003_audit_fields），
-- 改成 0004_user_moderation；后来加了 user_sessions 表又生成 0004_narrow_the_hunter
-- （和改过名的那个撞），合并回这一个文件。journal 里那条 entry 的 tag 也同步改了。
-- 原因见 README 坑列表第 16 条：drizzle-kit 按 journal 的 **idx** 编号，
-- 而这里的 idx 2/3/4 对应的文件都被手工改过名，它就照样按 idx 生成前缀。
--
-- ① users.lastSeenAt —— 成员列表显示「上次在线」，由 DO 在断连时写入
--    （room.ts 的 markOffline，同一用户 5 分钟内只写一次）。
--
-- ② users.mutedUntil —— 管理员禁言。存**截止时间戳**而不是布尔值：
--    到期自动解除，不需要定时任务去取消，也没有「布尔和到期时间互相矛盾」的状态。
--    永久封禁不走这里，那是删号（语义不同）。
--
-- ③ user_sessions 表 —— 「这个用户当前有哪些有效 refresh token」。
--    这不是重复造轮子：现有的 auth_blacklist 是**拒绝名单**（只记已吊销的 jti），
--    所以「吊销某人的所有会话」根本做不到 —— 系统从没记录过有效 token，吊销时无从枚举。
--    没有它的话，改完密码之后**之前泄露的 refresh token 照样能换出新 access token**，
--    等于密码改了但没生效，攻击者能用它续期到自然过期（7 天）。
--
--    为什么不用「记撤销时间 + 按签发时间比较」：那样需要一个可信的 token 签发时间，
--    而 @nanokajs/auth 的 sign() **只写 exp、不写 iat**，拿不到。
--    与其猜一个不可靠的时间来源，不如直接记「有效的有哪些」。
--
-- 三列/新表都允许 NULL（除了 jti 主键），所以存量数据不需要回填：
--   - lastSeenAt 为 NULL → 前端显示「未知」，而不是拿注册时间冒充；
--   - mutedUntil 为 NULL → 视为未禁言；
--   - user_sessions 为空 → 存量用户第一次刷新时会重新登记。

ALTER TABLE `users` ADD `lastSeenAt` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `mutedUntil` integer;--> statement-breakpoint
CREATE TABLE `user_sessions` (
	`jti` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`createdAt` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
