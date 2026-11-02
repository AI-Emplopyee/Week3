import type { ClientMemory, ClientMemoryAction } from './client-memory.ts';
import type { EmailShipmentMatchEvidence, EmailShipmentMatchProposal } from './email-shipment-ai.ts';
import type { DeclarationDraft, SaveDeclarationFieldAction, RemoveDeclarationFieldAction } from './declaration-types.ts';

export type Confidence = 'high' | 'medium' | 'low';
export type DocumentType = 'invoice' | 'packing_list' | 'bill_of_lading' | 'air_waybill' | 'contract' | 'certificate_of_origin' | 'other';
export type CaseType = 'import' | 'export' | 'reference' | 'unknown' | 'unsupported';
export type CaseStatus = 'review' | 'approved' | 'completed';
export type FieldDefinition = { key: string; label: string; group: string; required?: boolean; manualOnly?: boolean };
export type AiPageReading = { page: number; documentType: DocumentType; readability: 'clear' | 'uncertain' };
export type SourcePage = { aiReadability?: 'clear' | 'uncertain'; page: number; text: string; pdfText?: string; label?: string; documentType?: DocumentType; textSource?: 'kimi' | 'pdf_text' | 'ocr' | 'manual' | 'office' | 'xml'; ocrConfidence?: number };
export type SourceCollection = { name: string; folder: string; caseType?: CaseType };
export type DocumentProvenance = { sourcePaths?: string[]; referenceOnly?: boolean };
export type AiIntakeStatus = 'completed' | 'unavailable' | 'failed' | 'partial';
export type ShipmentDocument = DocumentProvenance & { extractionPipeline?: 'kimi'; aiProcessedPages?: number[]; aiRejectedPages?: number[]; aiStatus?: AiIntakeStatus; aiError?: string; classificationConfirmed?: boolean; id: string; caseId: string; name: string; type: DocumentType; mime: string; size: number; sha256: string; version: number; active: boolean; replacesId?: string; uploadedAt: string; blobKey?: string; pages: SourcePage[]; transcribedPages?: number[]; extractionStatus: 'pending_ai' | 'extracted' | 'needs_transcription' | 'unsupported' | 'failed'; extractionError?: string; sourceEmailId?: string; synthetic: boolean };
export type AiVisionPageEvidence = { page: number; imageSha256: string; width: number; height: number };
export type VisualEvidence = { imageSha256: string; bounds: [number, number, number, number]; textAgreement: boolean };
export type Candidate = { /** Uncalibrated model estimate, never inferred from the qualitative label. */ confidenceScore?: number; readability?: 'clear' | 'uncertain'; visualEvidence?: VisualEvidence; id: string; caseId: string; documentId: string; documentVersion: number; field: string; lineId?: string; value: string; originalText: string; page: number; location: string; method: string; confidence: Confidence; normalizations: { before: string; after: string; reason: string }[] };
export type ReviewedValue = { value: string; source: 'candidate' | 'manual'; candidateId?: string; reason: string; reviewedBy: string; reviewedAt: string; stale: boolean; unverified: boolean };
export type GoodsLine = { id: string; description: string; quantity: string; unit: string; unitPrice: string; amount: string; hsCode: string; origin: string; dutyRate: string; vatRate: string; sourceDocumentId?: string; sourcePage?: number; originalText?: string; reviewed: boolean; manual: boolean; reason?: string };
export type IssueResolution = { issueId: string; reason: string; actor: string; at: string; fingerprint: string };
export type ReviewHistoryEntry = { id: string; issue: Issue; status: 'confirmed' | 'corrected' | 'resolved'; action: string; actor: string; at: string; reason: string; value?: string };
export type ShipmentCase = { groupingMode?: 'manual'; dismissedClientMemoryIds?: string[]; sourceCollection?: SourceCollection; reviewHistory?: ReviewHistoryEntry[]; mergedInto?: string; id: string; reference: string; title: string; status: CaseStatus; caseType: CaseType; assignedTo: string; createdAt: string; updatedAt: string; documentIds: string[]; fields: Record<string, ReviewedValue>; goods: GoodsLine[]; groupingConfidence: Confidence; groupingReason: string; groupingConfirmed: boolean; synthetic: boolean; resolutions: IssueResolution[]; approval?: { actor: string; at: string; snapshotId: string }; completedBy?: string; completedAt?: string; declarationDraft?: DeclarationDraft };
export type Issue = { id: string; caseId: string; kind: 'conflict' | 'missing' | 'uncertain' | 'grouping' | 'unsupported' | 'document' | 'stale' | 'goods' | 'transfer' | 'declaration'; severity: 'error' | 'warning'; title: string; description: string; field?: string; ecusFieldKey?: string; goodsLineId?: string; candidateIds: string[]; documentIds: string[]; resolved: boolean; fingerprint: string; resolution?: IssueResolution };
export type AuditEntry = { id: string; caseId?: string; at: string; actor: string; action: string; field?: string; before?: unknown; after?: unknown; reason: string };
export type EmailShipmentMatch = { id: string; caseId: string; status: 'matched' | 'needs_review' | 'rejected'; evidence: EmailShipmentMatchEvidence[]; reason: string; model: string; createdAt: string; updatedAt: string; decisionSource: 'ai' | 'human'; reviewedBy?: string };
export type EmailRecord = { aiGroupedAt?: string; text?: string; inReplyTo?: string; references?: string[]; shipmentMatches?: EmailShipmentMatch[]; aiGroupingStatus?: 'complete' | 'partial' | 'unavailable' | 'failed'; aiGroupingError?: string; id: string; messageId: string; sender: string; subject: string; receivedAt: string; originalName: string; blobKey?: string; documentIds: string[]; sha256: string };
export type Snapshot = { id: string; caseId: string; createdAt: string; actor: string; version: number; declaration: ShipmentCase; candidates: Candidate[]; documents: ShipmentDocument[]; issues: Issue[]; customsValidation: 'Not yet assessed' };
export type HandoffRun = { id: string; caseId: string; snapshotId: string; idempotencyKey: string; at: string; actor: string; connector: 'test'; status: 'succeeded' | 'failed'; draftReference?: string; message: string; idaStatus: 'not_transmitted'; idcStatus: 'not_registered'; customsOutcome: 'not_assessed' };
export type EmailDraft = { id: string; caseId: string; issueIds: string[]; recipient: string; recipientSource?: 'sender' | 'manual'; subject: string; body: string; status: 'draft'; createdBy: string; createdAt: string; updatedAt: string;
  approval?: { actorId: string; actorName: string; at: string; sourceFingerprint?: string };
  automation?: { pendingClientMemoryIds?: string[]; locale: 'vi' | 'en'; sourceFingerprint: string; generatedSubject: string; generatedBody: string; pendingSubject?: string; pendingBody?: string; questionCount: number; state: 'ready' | 'needs_review' | 'resolved' | 'waiting_for_sources'; editedByUser?: boolean };
};
export type WorkspaceState = { caseSequence?: number; clientMemories?: ClientMemory[]; emailDrafts?: EmailDraft[]; id: string; name: string; revision: number; cases: ShipmentCase[]; documents: ShipmentDocument[]; candidates: Candidate[]; audit: AuditEntry[]; emails: EmailRecord[]; snapshots: Snapshot[]; handoffs: HandoffRun[]; settings: { inboxProvider: 'gmail'; inboxAddress: string; inboxStatus: 'not_connected'; defaultReviewer: string }; };
export type Actor = { id: string; name: string; email: string };
export type UploadedDocument = DocumentProvenance & { extractionPipeline?: 'kimi'; aiPageReadings?: AiPageReading[]; aiProcessedPages?: number[]; aiCandidates?: Candidate[]; aiStatus?: AiIntakeStatus; aiError?: string; id: string; name: string; mime: string; size: number; sha256: string; blobKey?: string; pages: SourcePage[]; extractionStatus: ShipmentDocument['extractionStatus']; extractionError?: string; sourceEmailId?: string; synthetic?: boolean };
export type PreparedWordSource = { pages: SourcePage[]; extractionStatus: 'pending_ai' | 'unsupported' | 'failed'; extractionError?: string };
/** Trusted server preparation only; never accepted by the public mutation schema. */
export type PreparedExistingDocument = PreparedWordSource & { documentId: string; documentVersion: number; sha256: string };
export type AiSourceProposal = { /** Optional only for older provider responses. */ confidenceScore?: number; readability?: 'clear' | 'uncertain'; evidence?: 'text' | 'vision'; bounds?: [number, number, number, number]; rowIndex?: number; field: string; value: string; quote: string; page: number; confidence: Confidence };
export type Action =
 | ClientMemoryAction
 | { type: 'review_email_match'; emailId: string; matchId: string; decision: 'accept' | 'reject'; reason: string }
 | { type: 'apply_email_matches'; emailIds: string[]; matches: EmailShipmentMatchProposal[]; model: string; truncated: boolean }
 | { type: 'email_matching_status'; emailIds: string[]; status: 'unavailable' | 'failed' | 'partial'; reason: string }
 | { type: 'refresh_extraction'; caseId: string; reason: string }
 | { type: 'refresh_case_automation'; caseId: string; locale?: 'vi' | 'en' }
 | { type: 'add_ai_candidates'; pageReadings?: AiPageReading[]; visionEvidence?: AiVisionPageEvidence[]; caseId: string; documentId: string; documentVersion: number; model: string; pages: number[]; proposals: AiSourceProposal[] }
 | SaveDeclarationFieldAction
 | RemoveDeclarationFieldAction
 | { type: 'regroup_existing'; caseIds?: string[] }
 | { type: 'draft_questions'; caseId: string; issueIds: string[]; locale?: 'vi' | 'en' }
 | { type: 'save_email_draft'; draftId: string; subject: string; body: string; recipient?: string }
 | { type: 'approve_email_draft'; draftId: string }
 | { type: 'seed_demo' }
 | { type: 'create_case'; title: string; caseType?: ShipmentCase['caseType'] }
 | { type: 'delete_case'; caseId: string; confirmed: true }
 | { type: 'intake'; sourceCollection?: SourceCollection; documents: UploadedDocument[]; preparedExisting?: PreparedExistingDocument[]; targetCaseId?: string; email?: EmailRecord; emails?: EmailRecord[] }
 | { type: 'review_field'; caseId: string; field: string; value: string; candidateId?: string; reason: string }
 | { type: 'review_goods'; caseId: string; goods: GoodsLine[]; reviewedLineIds?: string[]; reason: string }
 | { type: 'resolve_issue'; caseId: string; issueId: string; reason: string }
 | { type: 'confirm_grouping'; caseId: string; reason: string }
 | { type: 'move_documents'; documentIds: string[]; targetCaseId?: string; title?: string }
 | { type: 'merge_cases'; sourceCaseId: string; targetCaseId: string }
 | { type: 'replace_document'; documentId: string; document: UploadedDocument }
 | { type: 'classify_document'; documentId: string; documentType: DocumentType }
 | { type: 'transcribe_document'; documentId: string; pages: SourcePage[]; reason: string }
 | { type: 'update_case'; caseId: string; title?: string; assignedTo?: string; caseType?: ShipmentCase['caseType']; reason?: string }
 | { type: 'approve'; caseId: string }
 | { type: 'handoff'; caseId: string; simulateFailure?: boolean }
 | { type: 'complete'; caseId: string; reason: string }
 | { type: 'reopen'; caseId: string; reason: string }
 | { type: 'settings'; inboxAddress?: string; defaultReviewer?: string };
export type WorkspaceResponse = { state: WorkspaceState; actor: Actor; role: 'owner' | 'reviewer'; issues: Issue[] };
