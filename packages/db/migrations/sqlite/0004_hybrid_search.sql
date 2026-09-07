ALTER TABLE `search_index` ADD `embedding_dim` integer;--> statement-breakpoint
ALTER TABLE `search_index` ADD `embedding_updated_at` text;--> statement-breakpoint
ALTER TABLE `search_index` ADD `content_hash` text;--> statement-breakpoint
CREATE INDEX `idx_search_index_updated_at` ON `search_index` (`updated_at`);--> statement-breakpoint
CREATE VIRTUAL TABLE `contacts_fts` USING fts5(
	`contact_id` UNINDEXED,
	`search_text`,
	tokenize = 'unicode61 remove_diacritics 2'
);--> statement-breakpoint
CREATE TRIGGER `contacts_fts_ai` AFTER INSERT ON `search_index` BEGIN
	INSERT INTO `contacts_fts` (`contact_id`, `search_text`) VALUES (new.`contact_id`, new.`search_text`);
END;--> statement-breakpoint
CREATE TRIGGER `contacts_fts_ad` AFTER DELETE ON `search_index` BEGIN
	DELETE FROM `contacts_fts` WHERE `contact_id` = old.`contact_id`;
END;--> statement-breakpoint
CREATE TRIGGER `contacts_fts_au` AFTER UPDATE ON `search_index` BEGIN
	DELETE FROM `contacts_fts` WHERE `contact_id` = old.`contact_id`;
	INSERT INTO `contacts_fts` (`contact_id`, `search_text`) VALUES (new.`contact_id`, new.`search_text`);
END;--> statement-breakpoint
INSERT INTO `contacts_fts` (`contact_id`, `search_text`) SELECT `contact_id`, `search_text` FROM `search_index`;
