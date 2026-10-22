import type { DeclarationDraft } from './declaration-types.ts';
import type { EcusFormField } from './ecus-form.ts';
import { ecusFormValue } from './ecus-form.ts';
import type { SampleReviewComparison, SampleReviewData, SampleReviewSample, SampleReviewVariant } from './sample-review-types.ts';

export const GLM_TEST_PACKET_IDS = [
  'tokhai-76a082a307d4',
  'tokhai-82ee2cb6f9ee',
  'tokhai-956a36182771',
  'tokhai-22455ec490c0',
] as const;

export const DEFAULT_SAMPLE_VARIANT = 'glm53-flash-improved-reviewed';
export const GLM_IMPROVEMENT_VARIANTS = [
  'glm53-flash-low', 'glm53-flash-improved-auto', DEFAULT_SAMPLE_VARIANT,
] as const;

export const SAMPLE_FORM_TABS = [
  { id: 'general_1', label: 'Thông tin chung' },
  { id: 'general_2', label: 'Thông tin chung 2' },
  { id: 'goods', label: 'Danh sách hàng' },
] as const;

/** Fall back to an available variant without leaving an empty export loading forever. */
export function sampleReviewSelection(data: SampleReviewData, variantId: string, packetId: string) {
  const variant = data.variants.find(item => item.id === variantId && item.samples.length > 0)
    ?? data.variants.find(item => item.samples.length > 0);
  if (!variant) return null;
  const sample = variant.samples.find(item => item.packetId === packetId) ?? variant.samples[0];
  return { variant, sample };
}

/** Keep missing employee rows visible even when the AI produced fewer goods rows. */
export function sampleGoodsRowCount(sample: SampleReviewSample): number {
  return sample.comparisons.reduce((count, comparison) => (
    comparison.tab === 'goods' && comparison.printRowIndex !== null
      ? Math.max(count, comparison.printRowIndex + 1)
      : count
  ), Math.max(sample.shipment.goods.length, 1));
}

export type SampleDifferenceFilter = 'attention' | 'different' | 'missing' | 'equivalent';

export function selectedGlmTestSamples(variant: SampleReviewVariant): SampleReviewSample[] {
  if (!GLM_IMPROVEMENT_VARIANTS.some(id => id === variant.id)) return [];
  const samplesById = new Map(variant.samples.map(sample => [sample.packetId, sample]));
  return GLM_TEST_PACKET_IDS.flatMap(id => {
    const sample = samplesById.get(id);
    return sample ? [sample] : [];
  });
}

/** Only comparable controls from the three visible forms; unmeasured controls are not errors. */
export function sampleVisibleDifferences(sample: SampleReviewSample, filter: SampleDifferenceFilter = 'attention'): SampleReviewComparison[] {
  const formOrder = SAMPLE_FORM_TABS.map(tab => tab.id) as string[];
  return sample.comparisons.filter(comparison => {
    if (!formOrder.includes(comparison.tab)) return false;
    if (filter === 'equivalent') return comparison.contentStatus === 'reviewed_equivalent';
    if (filter === 'missing') return comparison.contentStatus === 'missing';
    const different = ['reviewed_not_equivalent', 'unreviewed_mismatch'].includes(comparison.contentStatus);
    return different || (filter === 'attention' && comparison.contentStatus === 'missing');
  }).sort((a, b) => formOrder.indexOf(a.tab) - formOrder.indexOf(b.tab)
    || (a.printRowIndex ?? -1) - (b.printRowIndex ?? -1)
    || a.fieldId.localeCompare(b.fieldId, 'en', { numeric: true })
    || a.component.localeCompare(b.component, 'en', { numeric: true }));
}

export function sampleDifferencesExport(variant: SampleReviewVariant, generatedAt: string) {
  const samples = selectedGlmTestSamples(variant);
  const row = (comparison: SampleReviewComparison) => ({
    form: comparison.tab, fieldId: comparison.fieldId, component: comparison.component,
    formControls: comparison.ecusKeys, goodsRow: comparison.printRowIndex === null ? null : comparison.printRowIndex + 1,
    aiValue: comparison.actual, employeeValue: comparison.expected, status: comparison.contentStatus,
    employeeSource: comparison.answerLocation, pairHash: comparison.pairHash,
    review: comparison.review ? { status: comparison.review.status, reason: comparison.review.reason } : null,
  });
  return {
    schemaVersion: 1, model: variant.model, variant: variant.id, sourceExportGeneratedAt: generatedAt,
    variantLabel: variant.label, stage: variant.stage ?? 'original_provider_result',
    reviewAssisted: variant.reviewAssisted ?? false,
    scoreMethod: variant.scoreMethod ?? 'frozen_pair_bound_review',
    limitations: variant.limitations ?? [], processingSummary: variant.processingSummary ?? null,
    scope: `${samples.length} preselected GLM-5.3-Flash samples; comparable controls in the three visible forms. Variant: ${variant.label}.`,
    notes: [
      'Saved draft values are exported without substitution. Employee ToKhai answers are used only for comparison.',
      'Differences include missing values and values that do not have content credit.',
      'Reviewed equivalents have content credit and are listed separately. Reviews are AI-assisted internal review, not independent human validation.',
      'Unmeasured controls are not counted as wrong or correct. Structured goods components outside the visible forms are excluded from this difference list.',
      'Goods use the frozen printed-row alignment. Additional AI rows are reported separately, not silently counted as matched.',
      ...(variant.stage ? ['These four development samples were reused for improvement; this is not an unseen holdout evaluation.'] : []),
      ...(variant.reviewAssisted ? ['This variant includes AI-assisted internal source review and is not fully automatic GLM accuracy or independent human validation.'] : []),
    ],
    samples: samples.map(sample => ({
      packetId: sample.packetId, label: sample.label, metrics: sample.metrics.visible,
      extraGoodsRows: sample.extraGoodsRows, unscoredPopulatedComponents: sample.unscoredPopulatedComponents,
      differences: sampleVisibleDifferences(sample).map(row),
      reviewedEquivalents: sampleVisibleDifferences(sample, 'equivalent').map(row),
    })),
  };
}

/** Project only saved AI entries into the existing ECUS form controls.
 * Employee comparison values never participate in this function. */
export function sampleFormValue(sample: SampleReviewSample, field: EcusFormField, goodsIndex: number): string {
  const goods = sample.shipment.goods[goodsIndex];
  if (field.tab === 'goods' && !goods) return '';
  if (field.key === 'goodsSequence') return String(goodsIndex + 1);
  const goodsLineId = field.tab === 'goods' ? goods?.id : undefined;
  const entry = sample.shipment.declarationDraft.fields.find(item => (
    item.fieldId === field.fieldId && item.goodsLineId === goodsLineId
  ));
  if (!entry || entry.stale || entry.applicability !== 'applicable') return '';
  // ecusFormValue only needs this entry, not a copy of every saved field per control.
  const draft: DeclarationDraft = {
    schemaVersion: 1,
    fields: [{
      ...entry,
      basis: 'Frozen source-document draft',
      reason: '',
      provenance: [],
      review: null,
      updatedBy: '',
      updatedAt: '',
      codeVerification: 'unverified',
    }],
  };
  return ecusFormValue(field, draft, goodsLineId);
}

export function sampleFieldComparison(sample: SampleReviewSample, field: EcusFormField, goodsIndex: number): SampleReviewComparison | undefined {
  const scope = field.tab === 'goods' ? `goods:${goodsIndex + 1}` : 'header';
  // A reference set is one measured component, not five independently scored controls.
  if (field.fieldId === '1.26' && (field.rowIndex ?? 0) > 0) return undefined;
  return sample.comparisons.find(comparison => (
    comparison.scope === scope && comparison.fieldId === field.fieldId
    && comparison.component === field.component && comparison.tab === field.tab
  ));
}
