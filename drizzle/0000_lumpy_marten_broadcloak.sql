CREATE TABLE `memo-call_auth_config` (
	`user_id` text PRIMARY KEY NOT NULL,
	`password_hash` text,
	`failed_attempts_count` integer DEFAULT 0 NOT NULL,
	`last_failure_at` integer,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `memo-call_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `memo-call_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `memo-call_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conv_user_created_idx` ON `memo-call_conversations` (`user_id`,`createdAt`);--> statement-breakpoint
CREATE TABLE `memo-call_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `memo-call_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `proj_user_category_idx` ON `memo-call_projects` (`user_id`,`category`);--> statement-breakpoint
CREATE TABLE `memo-call_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`name` text NOT NULL,
	`is_user_edited` integer DEFAULT false NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `memo-call_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `memo-call_conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tag_user_conv_idx` ON `memo-call_tags` (`user_id`,`conversation_id`);--> statement-breakpoint
CREATE TABLE `memo-call_transcript_edits` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`edited_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `memo-call_users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `memo-call_conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `txedit_user_conv_at_idx` ON `memo-call_transcript_edits` (`user_id`,`conversation_id`,`edited_at`);--> statement-breakpoint
CREATE TABLE `memo-call_users` (
	`id` text PRIMARY KEY NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
-- Seed: single-user MVP populates users with the constant 'me' per F-01.
-- See CLAUDE.md "Critical product constraints → schema is multi-user-ready".
-- Note: `createdAt` is omitted on purpose — the column DEFAULT (unixepoch())
-- fills it. Hand-edited; do NOT regenerate this file without re-applying this
-- block (drizzle-kit will overwrite). See plan.md Phase 2 §1 Critical Details.
INSERT INTO `memo-call_users` (`id`) VALUES ('me') ON CONFLICT DO NOTHING;
