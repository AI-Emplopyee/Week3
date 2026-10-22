import type { DeclarationValue, DeclarationComponentIssue } from './declaration-types';

/** Private local sample-review export. No filesystem paths or document text are browser data. */
export type SampleReviewTab = 'general_1' | 'general_2' | 'goods' | 'structured_goods_only' | 'unmapped';
export type SampleReviewMetric = {
  eligible: number; exactMatches: number; reviewedEquivalent: number; reviewedNotEquivalent: number;
  unreviewedMismatches: number; missing: number; filled: number; contentCorrect: number;
  exactAgreement: number | null; contentAgreement: number | null; filledContentAgreement: number | null;
  filledCoverage: number | null; assessedCoverage: number | null; measured: boolean;
};
export type SampleReviewMetrics = { visible: SampleReviewMetric; all: SampleReviewMetric; byForm: Record<SampleReviewTab, SampleReviewMetric> };
export type SampleReviewAsset = {
  id: string; name: string; mime: string; size: number; sha256: string;
  role: 'source' | 'employee_answer' | 'excluded_support'; available: boolean;
};
export type SampleReviewFieldEntry = {
  fieldId: string; goodsLineId?: string; value: DeclarationValue;
  applicability: 'unresolved' | 'applicable' | 'not_applicable'; stale: boolean;
  componentIssues?: DeclarationComponentIssue[];
  provenance: { assetId: string; page: number; documentVersion: number }[];
};
export type SampleReviewGoods = {
  id: string; description: string; quantity: string; unit: string; unitPrice: string; amount: string;
  hsCode: string; origin: string; dutyRate: string; vatRate: string;
  sourceAssetId?: string; sourcePage?: number; reviewed: boolean; manual: boolean;
};
export type SampleReviewComparison = {
  id: string; packetId: string; scope: string; fieldId: string; component: string;
  ecusKeys: string[]; tab: SampleReviewTab; goodsLineId: string | null; printRowIndex: number | null;
  expected: string | string[] | null; actual: string | string[] | null;
  status: 'match' | 'mismatch' | 'missing';
  contentStatus: 'exact_match' | 'reviewed_equivalent' | 'reviewed_not_equivalent' | 'unreviewed_mismatch' | 'missing';
  pairHash: string; staleReviewCount: number;
  review: { status: string; reason: string; reviewer: string; reviewedAt: string; evidence: unknown; ruleId?: string } | null;
  answerLocation: { assetId: string | null; sourceFile: string; sheet: string; cell: string };
};
export type SampleReviewSample = {
  id: string; packetId: string; label: string; caseType: string; population: 'development' | 'holdout';
  shipment: { id: string; title: string; caseType: string; declarationDraft: { schemaVersion: 1; fields: SampleReviewFieldEntry[] }; fields: Record<string, string>; goods: SampleReviewGoods[] };
  comparisons: SampleReviewComparison[]; metrics: SampleReviewMetrics;
  originalAssets: SampleReviewAsset[]; employeeAssets: SampleReviewAsset[];
  readingStatus: string; formStatus: string; scoreStatus: string;
  failures: { stage: string; page: number | null; error: string; assetId: string | null }[];
  blockedPages: number | null; blockedDocuments: number | null;
  extraGoodsRows: number | null; unscoredPopulatedComponents: number;
  labelConflictCount: number; warnings: string[];
  provenance: { snapshotId: string; resultSha256: string; formValuesSha256: string; comparisonCount: number; formValuesVerified: true; actualComparisonsVerified: true };
};
export type SampleReviewInventory = {
  packetId: string; label: string; caseType: string; eligible: boolean; status: string;
  population: 'development' | 'holdout' | 'excluded'; sourceDocuments: number;
  originalAssets: SampleReviewAsset[]; employeeAssets: SampleReviewAsset[];
  availableVariants: string[]; notes: string[];
};
export type SampleReviewVariant = {
  id: string; label: string; model: string; scope: string; sampleCount: number;
  metrics: SampleReviewMetrics; samples: SampleReviewSample[];
  stage?: 'automatic_mapping' | 'review_assisted';
  reviewAssisted?: boolean;
  scoreMethod?: 'frozen_pair_bound_review' | 'posthoc_pair_bound_review';
  limitations?: string[];
  processingSummary?: {
    newProviderCalls: number; fullEnvelopeFailures: number;
    fullyAcceptedEnvelopes: number; reviewedSourceEdits: number;
  };
};
export type SampleReviewData = {
  schemaVersion: 1; generatedAt: string; scopeNotes: string[];
  historicalPilotReference: { sampleCount: number; visible: SampleReviewMetric; isFreshRun: false };
  inventory: SampleReviewInventory[]; variants: SampleReviewVariant[];
  validation: { inventoryCollections: number; eligibleCollections: number; exportedSamples: number; comparedComponents: number; originalAssets: number; unavailableAssets: number; formValueChecks: number; actualComparisonChecks: number; sourceAndAnswerHashesDisjoint: true; frozenReportsMatched: true };
};
/** Server-side only. Never return this index from the sample-data endpoint. */
export type SampleReviewAssetIndex = {
  schemaVersion: 1; generatedAt: string; assets: Record<string, { path: string; name: string; mime: string; size: number; sha256: string; role: SampleReviewAsset['role'] }>;
};
