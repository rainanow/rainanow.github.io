CREATE TABLE `user_purges` (
	`id` text PRIMARY KEY NOT NULL,
	`purgedUserId` text NOT NULL,
	`purgedUsername` text NOT NULL,
	`purgedBy` text NOT NULL,
	`purgedByUsername` text NOT NULL,
	`renamedTo` text NOT NULL,
	`purgedMessages` integer DEFAULT 0 NOT NULL,
	`createdAt` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
