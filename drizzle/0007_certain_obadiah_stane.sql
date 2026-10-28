CREATE TABLE `memo-call_contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`e164` text,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	`updatedAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `memo-call_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contact_user_name_idx` ON `memo-call_contacts` (`user_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `contact_user_e164_uq` ON `memo-call_contacts` (`user_id`,`e164`) WHERE e164 IS NOT NULL;