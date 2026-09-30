CREATE TABLE `upload_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`count` integer DEFAULT 0 NOT NULL
);
