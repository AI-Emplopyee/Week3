CREATE TABLE `ecus_export_draft_history` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`case_id` text NOT NULL,
	`revision` integer NOT NULL,
	`form_json` text NOT NULL,
	`source_fingerprint` text NOT NULL,
	`source_workspace_revision` integer NOT NULL,
	`updated_by` text NOT NULL,
	`updated_by_name` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ecus_export_draft_history_revision` ON `ecus_export_draft_history` (`workspace_id`,`case_id`,`revision`);--> statement-breakpoint
CREATE TABLE `ecus_export_drafts` (
	`workspace_id` text NOT NULL,
	`case_id` text NOT NULL,
	`revision` integer NOT NULL,
	`form_json` text NOT NULL,
	`source_fingerprint` text NOT NULL,
	`source_workspace_revision` integer NOT NULL,
	`updated_by` text NOT NULL,
	`updated_by_name` text NOT NULL,
	`updated_at` integer NOT NULL,
	`save_id` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `case_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ecus_export_drafts_save_id_unique` ON `ecus_export_drafts` (`save_id`);--> statement-breakpoint
CREATE TABLE `ecus_job_resolutions` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`disposition` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_name` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	`draft_reference` text,
	`device_ack_at` integer,
	`ack_method` text,
	FOREIGN KEY (`job_id`) REFERENCES `ecus_export_jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ecus_job_resolutions_job_id_unique` ON `ecus_job_resolutions` (`job_id`);--> statement-breakpoint
CREATE INDEX `ecus_job_resolutions_workspace` ON `ecus_job_resolutions` (`workspace_id`);--> statement-breakpoint
ALTER TABLE `ecus_export_jobs` ADD `draft_revision` integer;--> statement-breakpoint
ALTER TABLE `ecus_export_jobs` ADD `retry_of` text;--> statement-breakpoint
CREATE UNIQUE INDEX `ecus_export_retry_parent` ON `ecus_export_jobs` (`retry_of`);