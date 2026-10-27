/** Exact representation changes only. Source values and quotes remain untouched.
 * Source locators and the older payment-guide discrepancy are recorded in
 * docs/explicit-form-code-sources.json and docs/verified-form-normalization-sources.json.
 * This is not general code validation. */
export type ExplicitFormCode = { value: string; source: string; reason: string };
export type PaymentCodebook = 'vnaccs-circular-38-2015';

export function explicitFormCode(field: string, value: string, paymentCodebook?: PaymentCodebook): ExplicitFormCode | undefined {
  const literal = value.trim().replace(/\s+/g, ' ');
  if (field === 'packageUnit' && /^(?:pk|pkgs?|packages?)$/i.test(literal)) return {
    value: 'PK', source: 'unece-rec21-package',
    reason: 'form-code: Explicit package unit represented as PK (UNECE Recommendation 21, Package; docs/verified-form-normalization-sources.json). Original source quote retained. Piece/PCS/PCE does not establish this packaging type.',
  };
  if (['unit', 'unit2', 'grossWeightUnit'].includes(field)) {
    if (/^(?:kg|kgm|kilograms?)$/i.test(literal)) return {
      value: 'KGM', source: 'unece-rec20-kilogram',
      reason: 'form-code: Explicit kilogram unit represented as KGM (UNECE Recommendation 20, kilogram; docs/explicit-form-code-sources.json). Original source quote retained.',
    };
    if (field !== 'grossWeightUnit' && /^(?:pc|pcs|pce|pieces?)$/i.test(literal)) return {
      value: 'PCE', source: 'vnaccs-ccs4eo-v1-p25',
      reason: 'form-code: Explicit piece unit represented as PCE (CCS4EO VNACCS manual V1.0, page 25; docs/explicit-form-code-sources.json). Original source quote retained.',
    };
  }
  // The supplied older guide assigns TT differently. Never silently select a
  // payment codebook from an invoice date or change ordinary current forms.
  if (field === 'paymentMethod' && paymentCodebook === 'vnaccs-circular-38-2015' && /^(?:tt|ttr|telegraphic transfer)$/i.test(literal)) return {
    value: 'TTR', source: paymentCodebook,
    reason: 'form-code: Explicit telegraphic transfer represented as TTR under the explicitly selected Circular 38/2015 Appendix II section 1.43, printed page 233. Original source quote retained.',
  };
  return undefined;
}
