CREATE TABLE `memo-call_reconcile_tombstones` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`call_sid` text NOT NULL,
	`createdAt` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `memo-call_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tombstone_user_callsid_uq` ON `memo-call_reconcile_tombstones` (`user_id`,`call_sid`);