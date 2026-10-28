ALTER TABLE `memo-call_conversations` ADD `transcript_edited_at` integer;--> statement-breakpoint
ALTER TABLE `memo-call_conversations` ADD `reanalyzed_at` integer;--> statement-breakpoint
ALTER TABLE `memo-call_processing_jobs` ADD `kind` text DEFAULT 'analyze' NOT NULL;