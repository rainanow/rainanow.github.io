-- 由 `npx nanoka generate` + `npx drizzle-kit generate` 产出。
--
-- ⚠️ 文件名被**手工从 0002_ 改成 0003_**。原因是仓库里已经有一个 0002
-- （create_upload_usage，当初也是改名出来的，为了给手写的 0001_chat_indexes 让位），
-- 而 drizzle-kit 是按 journal 里的 **idx** 编号的 —— 它这次照样生成了 0002_，
-- 直接撞名。改名的同时把 meta/_journal.json 里那条 entry 的 tag 一起改了。
-- 以后再生成迁移时留意这一点，别让两个文件挤在同一个前缀上。
--
-- 这次改动的动机：README 一直写着「管理员删掉的消息仍然占一行，方便留着追责」，
-- 但 messages 表原先只有 `deleted` 一个布尔 —— 说不出**谁**删的、**什么时候**删的。
-- 加 deletedBy / deletedAt 之后这句话才真的成立。
--
-- deletedBy 记的是**操作者**（不是消息作者）：管理员删别人的消息时这两者不同，
-- 而恰恰是那种情况才需要追责。
--
-- 另外新建 room_purges 表，是因为「清空房间」是**硬删** —— 消息行整个没了，
-- 软删这套审计字段连写入的机会都没有，所以得单独留一行元数据。
-- 注意它**不记录消息内容**，否则等于把刚删掉的东西又存了一份，与「清空」的意图相悖。

CREATE TABLE `room_purges` (
	`id` text PRIMARY KEY NOT NULL,
	`room` text NOT NULL,
	`purgedBy` text NOT NULL,
	`purgedByUsername` text NOT NULL,
	`removedMessages` integer DEFAULT 0 NOT NULL,
	`removedMedia` integer DEFAULT 0 NOT NULL,
	`createdAt` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `messages` ADD `deletedBy` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `deletedAt` integer;