ALTER TABLE `memo-call_conversations` ADD `counterparty_e164` text;--> statement-breakpoint
ALTER TABLE `memo-call_conversations` ADD `counterparty_name_hint` text;--> statement-breakpoint
ALTER TABLE `memo-call_conversations` ADD `counterparty_state` text;--> statement-breakpoint
CREATE INDEX `conv_user_counterparty_idx` ON `memo-call_conversations` (`user_id`,`counterparty_e164`);