ALTER TABLE `user_sessions` ADD `sessionId` text;--> statement-breakpoint
ALTER TABLE `user_sessions` ADD `rooms` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
-- 旧行的会话 ID 在首次续期时写入。升级前的令牌仍可由新 Worker 续期。
CREATE UNIQUE INDEX `user_sessions_one_device` ON `user_sessions` (`userId`) WHERE `sessionId` IS NOT NULL;
