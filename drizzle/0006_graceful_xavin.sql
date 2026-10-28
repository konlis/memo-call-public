CREATE INDEX `conv_user_project_idx` ON `memo-call_conversations` (`user_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `tag_user_name_idx` ON `memo-call_tags` (`user_id`,`name`);