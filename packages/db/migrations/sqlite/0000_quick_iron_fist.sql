CREATE TABLE `account` (
	`userId` text NOT NULL,
	`type` text NOT NULL,
	`provider` text NOT NULL,
	`providerAccountId` text NOT NULL,
	`refresh_token` text,
	`access_token` text,
	`expires_at` integer,
	`token_type` text,
	`scope` text,
	`id_token` text,
	`session_state` text,
	PRIMARY KEY(`provider`, `providerAccountId`),
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `activity_log` (
	`id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`entity_type` text,
	`entity_id` text,
	`metadata` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `campaign_recipients` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`status` text DEFAULT 'pending',
	`current_step` integer DEFAULT 0,
	`personalized_vars` text,
	`scheduled_at` text,
	`sent_at` text,
	`opened_at` text,
	`replied_at` text,
	`bounced_at` text,
	`error_message` text,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'draft',
	`type` text DEFAULT 'single',
	`template` text,
	`steps` text,
	`send_from` text,
	`send_via` text,
	`daily_limit` integer DEFAULT 50,
	`total_recipients` integer DEFAULT 0,
	`sent` integer DEFAULT 0,
	`opened` integer DEFAULT 0,
	`replied` integer DEFAULT 0,
	`bounced` integer DEFAULT 0,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`full_name` text NOT NULL,
	`first_name` text,
	`last_name` text,
	`email` text,
	`email_verified` integer DEFAULT false,
	`phone` text,
	`avatar_url` text,
	`headline` text,
	`company` text,
	`company_domain` text,
	`role` text,
	`seniority` text,
	`department` text,
	`industry` text,
	`location` text,
	`country` text,
	`timezone` text,
	`linkedin_url` text,
	`github_url` text,
	`twitter_url` text,
	`website_url` text,
	`source` text NOT NULL,
	`source_id` text,
	`tags` text,
	`custom_fields` text,
	`notes` text,
	`relationship_score` real DEFAULT 0,
	`last_interaction` text,
	`interaction_count` integer DEFAULT 0,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE TABLE `edges` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`target_id` text NOT NULL,
	`relation` text NOT NULL,
	`strength` real DEFAULT 0.5,
	`context` text,
	`bidirectional` integer DEFAULT true,
	`discovered_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `enrichments` (
	`id` text PRIMARY KEY NOT NULL,
	`contact_id` text NOT NULL,
	`provider` text NOT NULL,
	`data_type` text NOT NULL,
	`raw_payload` text,
	`confidence` real,
	`fetched_at` text NOT NULL,
	`expires_at` text,
	`stale` integer DEFAULT false,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `follow_ups` (
	`id` text PRIMARY KEY NOT NULL,
	`contact_id` text NOT NULL,
	`reason` text,
	`due_at` text NOT NULL,
	`snoozed_until` text,
	`status` text DEFAULT 'pending',
	`completed_at` text,
	`recurring` integer DEFAULT false,
	`recurrence_rule` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `interactions` (
	`id` text PRIMARY KEY NOT NULL,
	`contact_id` text NOT NULL,
	`type` text NOT NULL,
	`direction` text,
	`subject` text,
	`content` text,
	`sentiment` text,
	`channel` text,
	`campaign_id` text,
	`occurred_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `profile_views` (
	`id` text PRIMARY KEY NOT NULL,
	`viewer_ip` text,
	`viewer_agent` text,
	`referrer` text,
	`resolved_contact` text,
	`viewed_page` text NOT NULL,
	`viewed_at` text NOT NULL,
	`country` text,
	`city` text,
	FOREIGN KEY (`resolved_contact`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `search_index` (
	`contact_id` text PRIMARY KEY NOT NULL,
	`search_text` text NOT NULL,
	`company_norm` text,
	`role_norm` text,
	`location_norm` text,
	`seniority_norm` text,
	`industry_norm` text,
	`embedding` text,
	`embedding_model` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `session` (
	`sessionToken` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`expires` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`email` text NOT NULL,
	`emailVerified` integer,
	`image` text
);
--> statement-breakpoint
CREATE TABLE `verificationToken` (
	`identifier` text NOT NULL,
	`token` text NOT NULL,
	`expires` integer NOT NULL,
	PRIMARY KEY(`identifier`, `token`)
);
