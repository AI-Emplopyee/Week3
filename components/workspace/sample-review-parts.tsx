"use client";

import { ArrowUpRight, CheckCheck } from 'lucide-react';
import { ECUS_FORM_FIELDS, type EcusFormField } from '@/lib/ecus-form';
import { useLocale } from '@/lib/i18n';
import { SAMPLE_FORM_TABS, sampleFieldComparison, sampleFormValue, sampleGoodsRowCount } from '@/lib/sample-review-client';
import type { SampleReviewComparison, SampleReviewSample } from '@/lib/sample-review-types';

export function sampleAssetUrl(id: string): string {
  return `/api/local-sample-review/assets/${encodeURIComponent(id)}`;
}

export function sampleDisplayValue(value: SampleReviewComparison['actual']) {
  return Array.isArray(value) ? value.join(' · ') : value ?? '—';
}

export function sampleStatusText(locale: string, comparison?: SampleReviewComparison): string {
  const labels: Record<SampleReviewComparison['contentStatus'] | 'unmeasured', [string, string]> = {
    exact_match: ['Khớp chính xác', 'Exact match'],
    reviewed_equivalent: ['Tương đương đã rà soát', 'Reviewed equivalent'],
    reviewed_not_equivalent: ['Khác — đã rà soát', 'Different · reviewed'],
    unreviewed_mismatch: ['Khác — cần rà soát', 'Different · needs review'],
    missing: ['Thiếu giá trị AI', 'AI value missing'],
    unmeasured: ['Chưa đo lường', 'Not measured'],
  };
  return labels[comparison?.contentStatus ?? 'unmeasured'][locale === 'en' ? 1 : 0];
}

type FormProps = {
  sample: SampleReviewSample;
  tab: EcusFormField['tab'];
  goodsIndex: number;
  differencesOnly: boolean;
  expectedVisible: boolean;
  onTabChange: (tab: EcusFormField['tab']) => void;
  onGoodsChange: (index: number) => void;
  onDifferencesOnlyChange: (checked: boolean) => void;
  onExpectedVisibleChange: (checked: boolean) => void;
  onCompare: (comparison: SampleReviewComparison) => void;
};

export function SampleFilledForms({
  sample, tab, goodsIndex, differencesOnly, expectedVisible,
  onTabChange, onGoodsChange, onDifferencesOnlyChange, onExpectedVisibleChange, onCompare,
}: FormProps) {
  const { locale } = useLocale();
  const say = (vi: string, en: string) => locale === 'en' ? en : vi;
  const fields = ECUS_FORM_FIELDS.filter(field => {
    if (field.tab !== tab) return false;
    if (!differencesOnly) return true;
    const comparison = sampleFieldComparison(sample, field, goodsIndex);
    return !!comparison && !['exact_match', 'reviewed_equivalent'].includes(comparison.contentStatus);
  });
  const sections = [...new Set(fields.map(field => field.section))];
  const activeTab = SAMPLE_FORM_TABS.find(item => item.id === tab)!;

  return <>
    <div className="sample-form-toolbar">
      <div className="sample-tabs" role="tablist" aria-label="ECUS forms">
        {SAMPLE_FORM_TABS.map(item => (
          <button key={item.id} type="button" role="tab" id={`sample-tab-${item.id}`}
            aria-controls="sample-form-panel" aria-selected={tab === item.id}
            onClick={() => onTabChange(item.id)}>
            {item.label}
          </button>
        ))}
      </div>
      <div className="sample-options">
        <label><input type="checkbox" checked={expectedVisible}
          onChange={event => onExpectedVisibleChange(event.target.checked)} />
          {say('Hiện đáp án ToKhai', 'Show ToKhai answers')}
        </label>
        <label><input type="checkbox" checked={differencesOnly}
          onChange={event => onDifferencesOnlyChange(event.target.checked)} />
          {say('Chỉ hiện khác / thiếu', 'Differences / missing only')}
        </label>
      </div>
    </div>
    <div className="sample-form-caption">
      <CheckCheck size={16} />
      {say(
        'Giá trị trong ô là bản nháp chứng từ của phiên bản đang chọn. Đáp án nhân viên nằm riêng bên dưới; không được chép vào biểu mẫu.',
        'Inputs contain saved source-based drafts for the selected version. Employee answers appear separately below and are never copied into the form.',
      )}
    </div>
    {tab === 'goods' && (
      <label className="sample-goods-select">
        {say('Dòng hàng', 'Goods row')}
        <select value={goodsIndex} onChange={event => onGoodsChange(Number(event.target.value))}>
          {Array.from({ length: sampleGoodsRowCount(sample) }, (_, index) => (
            <option key={index} value={index}>
              {index + 1}. {sample.shipment.goods[index]?.description || say('Chưa có dòng hàng AI', 'AI goods row missing')}
            </option>
          ))}
        </select>
        <small>{sample.shipment.goods.length} {say('dòng hàng AI', 'AI goods rows')} · {sample.extraGoodsRows ?? '—'} {say('dòng thêm ngoài đáp án', 'extra rows beyond answers')}</small>
      </label>
    )}
    <div id="sample-form-panel" role="tabpanel" aria-labelledby={`sample-tab-${activeTab.id}`} className="sample-form">
      {sections.map(section => {
        const group = fields.filter(field => field.section === section);
        return <fieldset key={section}>
          <legend>{locale === 'en' ? group[0].sectionEn : group[0].sectionVi}</legend>
          <div className="sample-form-grid">
            {group.map(field => {
              const comparison = sampleFieldComparison(sample, field, goodsIndex);
              const state = comparison?.contentStatus ?? 'unmeasured';
              const id = `sample-${field.key}-${field.tab === 'goods' ? goodsIndex : 'header'}`;
              const value = sampleFormValue(sample, field, goodsIndex);
              return <div key={field.key} data-field-key={field.key}
                className={`sample-field sample-field-${state} ${field.input === 'long_text' ? 'sample-field-wide' : ''}`}>
                <label htmlFor={id}>{field.labelVi}{locale === 'en' && <small>{field.labelEn}</small>}</label>
                {field.input === 'long_text'
                  ? <textarea id={id} value={value} readOnly rows={3} placeholder={say('Để trống — chưa có giá trị được hỗ trợ', 'Blank · no supported value')} />
                  : <input id={id} value={value} readOnly placeholder={say('Để trống', 'Blank')} />}
                <div className="sample-field-status">
                  <span className={`sample-status ${state}`}>{sampleStatusText(locale, comparison)}</span>
                  {comparison && <button type="button" onClick={() => onCompare(comparison)}
                    aria-label={`${say('Chi tiết so sánh', 'Compare')} ${field.labelEn}`}>
                    {say('Chi tiết', 'Details')}
                  </button>}
                </div>
                {comparison && expectedVisible && <div className="sample-expected">
                  <b>ToKhai:</b> {sampleDisplayValue(comparison.expected)}
                  {Array.isArray(comparison.expected) && <small>{say('So sánh toàn bộ danh sách một lần.', 'The complete list is scored once.')}</small>}
                </div>}
              </div>;
            })}
          </div>
        </fieldset>;
      })}
      {!sections.length && <p>{say('Không có giá trị khác hoặc thiếu trong phần này.', 'No differences or missing comparisons in this section.')}</p>}
    </div>
  </>;
}

type DifferenceRow = { source: SampleReviewSample; comparison: SampleReviewComparison };

export function SampleDifferenceTable({ rows, onOpen }: {
  rows: DifferenceRow[];
  onOpen: (packetId: string, comparison: SampleReviewComparison) => void;
}) {
  const { locale } = useLocale();
  const say = (vi: string, en: string) => locale === 'en' ? en : vi;
  return <div className="sample-difference-scroll">
    <table>
      <caption className="sr-only">{say('Giá trị AI, đáp án ToKhai và vị trí ô đáp án', 'AI values, ToKhai answers and answer cell locations')}</caption>
      <thead><tr>
        <th>{say('Mẫu / biểu mẫu', 'Sample / form')}</th>
        <th>{say('Trường / dòng hàng', 'Field / goods row')}</th>
        <th>{say('AI đã điền', 'AI filled value')}</th>
        <th>ToKhai</th>
        <th>{say('Trạng thái', 'Status')}</th>
        <th>{say('Ô đáp án', 'Answer cell')}</th>
      </tr></thead>
      <tbody>{rows.map(({ source, comparison }) => {
        const field = ECUS_FORM_FIELDS.find(item => item.tab === comparison.tab
          && item.fieldId === comparison.fieldId && item.component === comparison.component);
        return <tr key={`${source.packetId}:${comparison.id}`} className={`sample-difference-${comparison.contentStatus}`}>
          <td><strong>{source.label}</strong><small>{SAMPLE_FORM_TABS.find(tab => tab.id === comparison.tab)?.label}</small></td>
          <td>
            <button type="button" onClick={() => onOpen(source.packetId, comparison)}>
              {field ? (locale === 'en' ? field.labelEn : field.labelVi) : `${comparison.fieldId}.${comparison.component}`}
            </button>
            <small>{comparison.fieldId}.{comparison.component}
              {comparison.printRowIndex !== null && ` · ${say('Dòng', 'Row')} ${comparison.printRowIndex + 1}`}
            </small>
          </td>
          <td>{comparison.actual === null ? <em>{say('Để trống', 'Blank')}</em> : sampleDisplayValue(comparison.actual)}</td>
          <td>{sampleDisplayValue(comparison.expected)}</td>
          <td><span className={`sample-status ${comparison.contentStatus}`}>{sampleStatusText(locale, comparison)}</span></td>
          <td>
            {comparison.answerLocation.assetId
              ? <a href={sampleAssetUrl(comparison.answerLocation.assetId)} target="_blank" rel="noreferrer">
                {comparison.answerLocation.cell}<ArrowUpRight size={12} />
              </a>
              : comparison.answerLocation.cell}
            <small>{comparison.answerLocation.sheet}</small>
            <small>{comparison.answerLocation.sourceFile}</small>
          </td>
        </tr>;
      })}</tbody>
    </table>
    {!rows.length && <p className="sample-difference-empty">{say('Không có thành phần nào thuộc bộ lọc này.', 'No components match this filter.')}</p>}
  </div>;
}
