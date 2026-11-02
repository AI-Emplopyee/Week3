CREATE TABLE `case_file_cleanup` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `plan_json` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `case_file_cleanup_workspace` ON `case_file_cleanup` (`workspace_id`);
--> statement-breakpoint
CREATE TABLE `deleted_case_documents` (
  `workspace_id` text NOT NULL,
  `document_id` text NOT NULL,
  `cleanup_vision` integer DEFAULT 1 NOT NULL,
  PRIMARY KEY (`workspace_id`, `document_id`),
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
