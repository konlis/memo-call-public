CREATE TABLE `memo-call_dialed_numbers` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`e164` text NOT NULL,
	`last_used_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `memo-call_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `dialed_user_lastused_idx` ON `memo-call_dialed_numbers` (`user_id`,`last_used_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `dialed_user_e164_uq` ON `memo-call_dialed_numbers` (`user_id`,`e164`);