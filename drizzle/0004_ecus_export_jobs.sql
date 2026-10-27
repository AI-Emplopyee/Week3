CREATE TABLE `ecus_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`created_by` text NOT NULL,
	`label` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	`last_seen` integer DEFAULT 0 NOT NULL,
	`ready` integer DEFAULT 0 NOT NULL,
	`profile_id` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ecus_devices_workspace` ON `ecus_devices` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `ecus_export_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`device_id` text NOT NULL,
	`case_id` text NOT NULL,
	`approved_by` text NOT NULL,
	`source_fingerprint` text NOT NULL,
	`approval_hash` text NOT NULL,
	`payload_json` text NOT NULL,
	`payload_hash` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`claimed_at` integer,
	`lease_token` text,
	`lease_until` integer,
	`finished_at` integer,
	`draft_reference` text,
	`message` text DEFAULT '' NOT NULL,
	`result_json` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_id`) REFERENCES `ecus_devices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ecus_export_job_approval` ON `ecus_export_jobs` (`workspace_id`,`case_id`,`approval_hash`);--> statement-breakpoint
CREATE INDEX `ecus_export_jobs_device` ON `ecus_export_jobs` (`device_id`,`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `ecus_export_one_running` ON `ecus_export_jobs` (`device_id`) WHERE "ecus_export_jobs"."status" = 'running';