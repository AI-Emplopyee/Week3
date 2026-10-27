import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().unique(),
  revision: integer('revision').notNull().default(0),
  stateJson: text('state_json').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const workspaceStateChunks = sqliteTable('workspace_state_chunks', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  snapshotId: text('snapshot_id').notNull(),
  chunkIndex: integer('chunk_index').notNull(),
  content: text('content').notNull(),
}, table => [primaryKey({ columns: [table.workspaceId, table.snapshotId, table.chunkIndex] })]);

export const workspaceMembers = sqliteTable('workspace_members', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  email: text('email').notNull(),
  userId: text('user_id'),
  role: text('role', { enum: ['owner', 'reviewer'] }).notNull(),
  invitedBy: text('invited_by').notNull(),
  createdAt: text('created_at').notNull(),
}, table => [
  primaryKey({ columns: [table.workspaceId, table.email] }),
  uniqueIndex('workspace_member_identity').on(table.workspaceId, table.userId),
]);

export const authRateLimits = sqliteTable('auth_rate_limits', {
  key: text('key').primaryKey(),
  count: integer('count').notNull(),
  expiresAt: integer('expires_at').notNull(),
}, table => [index('auth_rate_limits_expiry').on(table.expiresAt)]);

export const authRecoveryGrants = sqliteTable('auth_recovery_grants', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id').notNull(),
  expiresAt: integer('expires_at').notNull(),
}, table => [index('auth_recovery_grants_expiry').on(table.expiresAt)]);

export const aiProcessingJobs = sqliteTable('ai_processing_jobs', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  documentId: text('document_id').notNull(),
  documentVersion: integer('document_version').notNull(),
  sha256: text('sha256').notNull(),
  page: integer('page').notNull(),
  state: text('state').notNull().default('queued'),
  leaseToken: text('lease_token'),
  leaseUntil: integer('lease_until').notNull().default(0),
  availableAt: integer('available_at').notNull().default(0),
  attempts: integer('attempts').notNull().default(0),
  startedAt: integer('started_at'),
  completedAt: integer('completed_at'),
  elapsedMs: integer('elapsed_ms'),
  error: text('error'),
}, table => [primaryKey({ columns: [table.workspaceId, table.documentId, table.documentVersion, table.sha256, table.page] }), index('ai_processing_jobs_active').on(table.workspaceId, table.state, table.leaseUntil)]);

export const ecusDevices = sqliteTable('ecus_devices', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  createdBy: text('created_by').notNull(), label: text('label').notNull(), tokenHash: text('token_hash').notNull(),
  createdAt: integer('created_at').notNull(), revokedAt: integer('revoked_at'),
  lastSeen: integer('last_seen').notNull().default(0), ready: integer('ready').notNull().default(0), profileId: text('profile_id').notNull().default(''),
}, table => [index('ecus_devices_workspace').on(table.workspaceId)]);

export const ecusExportJobs = sqliteTable('ecus_export_jobs', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  deviceId: text('device_id').notNull().references(() => ecusDevices.id), caseId: text('case_id').notNull(), approvedBy: text('approved_by').notNull(),
  sourceFingerprint: text('source_fingerprint').notNull(), approvalHash: text('approval_hash').notNull(), payloadJson: text('payload_json').notNull(), payloadHash: text('payload_hash').notNull(),
  status: text('status').notNull().default('queued'), createdAt: integer('created_at').notNull(), expiresAt: integer('expires_at').notNull(), claimedAt: integer('claimed_at'),
  leaseToken: text('lease_token'), leaseUntil: integer('lease_until'), finishedAt: integer('finished_at'), draftReference: text('draft_reference'), message: text('message').notNull().default(''), resultJson: text('result_json'),
  draftRevision: integer('draft_revision'), retryOf: text('retry_of'),
}, table => [uniqueIndex('ecus_export_job_approval').on(table.workspaceId, table.caseId, table.approvalHash), index('ecus_export_jobs_device').on(table.deviceId, table.status, table.createdAt),
  uniqueIndex('ecus_export_retry_parent').on(table.retryOf),
  uniqueIndex('ecus_export_one_running').on(table.deviceId).where(sql`${table.status} = 'running'`)]);

export const ecusExportDrafts = sqliteTable('ecus_export_drafts', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id), caseId: text('case_id').notNull(),
  revision: integer('revision').notNull(), formJson: text('form_json').notNull(), sourceFingerprint: text('source_fingerprint').notNull(),
  sourceWorkspaceRevision: integer('source_workspace_revision').notNull(), updatedBy: text('updated_by').notNull(),
  updatedByName: text('updated_by_name').notNull(), updatedAt: integer('updated_at').notNull(), saveId: text('save_id').notNull().unique(),
}, table => [primaryKey({ columns: [table.workspaceId, table.caseId] })]);

export const ecusExportDraftHistory = sqliteTable('ecus_export_draft_history', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id), caseId: text('case_id').notNull(),
  revision: integer('revision').notNull(), formJson: text('form_json').notNull(), sourceFingerprint: text('source_fingerprint').notNull(),
  sourceWorkspaceRevision: integer('source_workspace_revision').notNull(), updatedBy: text('updated_by').notNull(),
  updatedByName: text('updated_by_name').notNull(), updatedAt: integer('updated_at').notNull(),
}, table => [uniqueIndex('ecus_export_draft_history_revision').on(table.workspaceId, table.caseId, table.revision)]);

export const ecusJobResolutions = sqliteTable('ecus_job_resolutions', {
  id: text('id').primaryKey(), jobId: text('job_id').notNull().unique().references(() => ecusExportJobs.id),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id), payloadHash: text('payload_hash').notNull(),
  disposition: text('disposition').notNull(), actorId: text('actor_id').notNull(), actorName: text('actor_name').notNull(),
  reason: text('reason').notNull(), createdAt: integer('created_at').notNull(), draftReference: text('draft_reference'),
  deviceAckAt: integer('device_ack_at'), ackMethod: text('ack_method'),
}, table => [index('ecus_job_resolutions_workspace').on(table.workspaceId)]);
