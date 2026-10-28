CREATE TABLE `memo-call_processing_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`last_error_code` text,
	`next_retry_at` integer,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `memo-call_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `memo-call_conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `job_user_status_idx` ON `memo-call_processing_jobs` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `job_user_conv_idx` ON `memo-call_processing_jobs` (`user_id`,`conversation_id`);--> statement-breakpoint
ALTER TABLE `memo-call_conversations` ADD `call_sid` text;--> statement-breakpoint
ALTER TABLE `memo-call_conversations` ADD `recording_sid` text;--> statement-breakpoint
ALTER TABLE `memo-call_conversations` ADD `recording_deleted_at` integer;--> statement-breakpoint
ALTER TABLE `memo-call_conversations` ADD `started_at` integer;--> statement-breakpoint
ALTER TABLE `memo-call_conversations` ADD `ended_at` integer;--> statement-breakpoint
ALTER TABLE `memo-call_conversations` ADD `duration_ms` integer;--> statement-breakpoint
ALTER TABLE `memo-call_conversations` ADD `transcript_language` text;--> statement-breakpoint
ALTER TABLE `memo-call_conversations` ADD `transcript_segments` text;--> statement-breakpoint
ALTER TABLE `memo-call_conversations` ADD `analysis` text;--> statement-breakpoint
ALTER TABLE `memo-call_conversations` ADD `category` text;--> statement-breakpoint
ALTER TABLE `memo-call_conversations` ADD `category_overridden` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- HAND-EDIT (do NOT regenerate-overwrite): drizzle-kit 0.31.10 emits the inline
-- ALTER…ADD…REFERENCES table name UNQUOTED (`memo-call_projects`), so SQLite parses
-- the hyphen as subtraction → "near \"-\": syntax error". It also drops the ON DELETE
-- action on this path. Backticks added + ON DELETE SET NULL restored (the schema.ts
-- declaration). Valid because the added column defaults to NULL. See CLAUDE.md "Lessons".
ALTER TABLE `memo-call_conversations` ADD `project_id` text REFERENCES `memo-call_projects`(`id`) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `memo-call_conversations` ADD `project_overridden` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `conv_user_callsid_uq` ON `memo-call_conversations` (`user_id`,`call_sid`) WHERE call_sid IS NOT NULL;