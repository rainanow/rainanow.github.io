-- 由 `npx nanoka generate` + `npx drizzle-kit generate` 产出，但**手工改过一处**：
-- `users.username` 加了 `COLLATE NOCASE`。
--
-- 为什么要改：SQLite 的比较与唯一索引都跟随列的排序规则。列声明成 NOCASE 之后
--   1. `users_username_unique` 这个唯一索引自动变成不区分大小写 —— "Alice" 和 "alice"
--      不能再注册成两个账号（否则可以拿大小写仿冒别人）；
--   2. `@nanokajs/auth` 的 loginHandler 内部走的是 `findOne({ username })`，
--      也就是 `WHERE username = ?`，它同样会跟随列排序规则，于是登录天然不区分大小写。
--      否则就得在登录路径上拦截并改写请求体，白白多一层复杂度。
--
-- 为什么敢手改：drizzle 的 sqlite schema 模型不记录 collation，
-- 所以这个改动对 drizzle-kit 后续的 diff 是不可见的，不会产生漂移。
-- NOCASE 只折叠 ASCII 的 A-Z，中文用户名不受影响（本来也没有大小写）。
--
CREATE TABLE `auth_blacklist` (
	`id` text PRIMARY KEY NOT NULL,
	`subject` text NOT NULL,
	`expiresAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`room` text DEFAULT 'general' NOT NULL,
	`userId` text NOT NULL,
	`username` text NOT NULL,
	`body` text NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`createdAt` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`id` text PRIMARY KEY NOT NULL,
	`hits` integer DEFAULT 0 NOT NULL,
	`windowStart` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text COLLATE NOCASE NOT NULL,
	`password` text NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`createdAt` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);