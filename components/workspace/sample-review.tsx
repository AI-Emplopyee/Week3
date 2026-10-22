"use client";

import { useEffect, useState } from 'react';
import { ArrowUpRight, CheckCheck, Download, FileText, FlaskConical, Loader2 } from 'lucide-react';
import type { EcusFormField } from '@/lib/ecus-form';
import { useLocale } from '@/lib/i18n';
import { DEFAULT_SAMPLE_VARIANT, GLM_IMPROVEMENT_VARIANTS, SAMPLE_FORM_TABS as tabs, sampleDifferencesExport, sampleReviewSelection, sampleVisibleDifferences, selectedGlmTestSamples, type SampleDifferenceFilter } from '@/lib/sample-review-client';
import type { SampleReviewAsset, SampleReviewComparison, SampleReviewData, SampleReviewMetric, SampleReviewVariant } from '@/lib/sample-review-types';

import { SampleFilledForms, SampleDifferenceTable, sampleAssetUrl as assetUrl, sampleDisplayValue as display, sampleStatusText } from './sample-review-parts';

const pct = (value: number | null | undefined) => value == null ? '—' : `${(value * 100).toFixed(2)}%`;

export function SampleReview() {
  const { locale }=useLocale();
  const say=(vi:string,en:string)=>locale==='en'?en:vi;
  const [data,setData]=useState<SampleReviewData|null>(null);
  const [error,setError]=useState('');
  const [variantId,setVariant]=useState(DEFAULT_SAMPLE_VARIANT);
  const [packetId,setPacket]=useState('');
  const [tab,setTab]=useState<EcusFormField['tab']>('general_1');
  const [goodsIndex,setGoodsIndex]=useState(0);
  const [differencesOnly,setDifferencesOnly]=useState(false);
  const [expectedVisible,setExpectedVisible]=useState(true);
  const [focused,setFocused]=useState<SampleReviewComparison|null>(null);
  const [view,setView]=useState<'forms'|'differences'>('forms');
  const [differenceFilter,setDifferenceFilter]=useState<SampleDifferenceFilter>('attention');
  const [differenceScope,setDifferenceScope]=useState<'selected'|'shipment'>('selected');
  useEffect(()=>{
    const controller=new AbortController();
    fetch('/api/local-sample-review',{signal:controller.signal,cache:'no-store'}).then(async response=>{
      if(!response.ok) throw new Error('Sample results are unavailable.');
      const result=await response.json() as SampleReviewData;
      if(result.schemaVersion!==1 || !Array.isArray(result.variants)) throw new Error('Invalid sample data.');
      if (!sampleReviewSelection(result, DEFAULT_SAMPLE_VARIANT, '')) throw new Error('No saved samples are available.');
      if (!controller.signal.aborted) setData(result);
    }).catch(() => {
      if (!controller.signal.aborted) setError('The saved sample results could not be loaded.');
    });
    return ()=>controller.abort();
  },[]);
  const selection = data ? sampleReviewSelection(data, variantId, packetId) : null;
  const variant = selection?.variant;
  const sample = selection?.sample;
  const reset=()=>{setGoodsIndex(0);setFocused(null);};
  if(error) return <section className="sample-review"><div className="error-banner" role="alert">{say('Không tải được kết quả mẫu đã lưu.','The saved sample results could not be loaded.')}</div></section>;
  if(!data || !variant || !sample) return <section className="sample-review"><Loader2 className="spin"/><p>{say('Đang tải biểu mẫu đã điền…','Loading filled sample forms…')}</p></section>;
  const overall=variant.metrics.visible;
  const current=sample.metrics.visible;
  const testingSamples=selectedGlmTestSamples(variant);
  const isTestingVariant=testingSamples.length>0;
  const improvementVariants=GLM_IMPROVEMENT_VARIANTS.flatMap(id=>{
    const result=data.variants.find(item=>item.id===id && item.samples.length>0);
    return result?[result]:[];
  });
  const variantLabel=(item:SampleReviewVariant)=>item.id==='glm53-flash-low'
    ? say('GLM gốc','Original GLM')
    : item.stage==='automatic_mapping' || item.id==='glm53-flash-improved-auto'
      ? say('Điền biểu mẫu tự động cải tiến','Improved automatic filling')
      : item.stage==='review_assisted' || item.id===DEFAULT_SAMPLE_VARIANT
        ? say('Có rà soát nguồn bằng AI','With AI-assisted source review') : item.label;
  const reviewedVariant=variant.reviewAssisted===true || variant.stage==='review_assisted';
  const different=overall.unreviewedMismatches+overall.reviewedNotEquivalent;
  const componentShare=(count:number)=>overall.eligible?count/overall.eligible:null;
  const differenceSamples=isTestingVariant && differenceScope==='selected'?testingSamples:[sample];
  const differenceRows=differenceSamples.flatMap(source=>sampleVisibleDifferences(source,differenceFilter).map(comparison=>({source,comparison})));
  const statusText = (comparison?: SampleReviewComparison) => sampleStatusText(locale, comparison);
  const assets=(items:SampleReviewAsset[])=>items.map(asset=><a key={asset.id} href={assetUrl(asset.id)} target="_blank" rel="noreferrer" className="sample-asset"><FileText size={15}/><span>{asset.name}</span><ArrowUpRight size={14}/></a>);
  const score=(label:string,metric:SampleReviewMetric)=><span><strong>{pct(metric.contentAgreement)}</strong> {label}<small>{metric.contentCorrect}/{metric.eligible}</small></span>;
  const inventoryExcluded=data.inventory.filter(p=>!p.eligible);
  const exclusionLabel=(status:string)=>({
    non_import_collection:say('Không phải lô hàng nhập khẩu','Not an import collection'),
    no_primary_sources:say('Thiếu chứng từ nguồn chính','No primary source documents'),
    no_supported_import_answer_key:say('Chưa hỗ trợ mẫu đáp án nhập khẩu','Unsupported import answer format'),
  }[status] || status);
  const downloadDifferences=()=>{
    if(!isTestingVariant) return;
    const payload=sampleDifferencesExport(variant,data.generatedAt);
    const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)+'\n'],{type:'application/json'}));
    const link=document.createElement('a');
    link.href=url;link.download=`AICD_${variant.id}_sample_differences.json`;
    document.body.appendChild(link);link.click();link.remove();
    window.setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  const openComparison=(packet:string,comparison:SampleReviewComparison)=>{
    setPacket(packet);setTab(comparison.tab as EcusFormField['tab']);setGoodsIndex(comparison.printRowIndex??0);
    setDifferencesOnly(false);setView('forms');setFocused(comparison);
  };
  const openInventorySample=(packet:string)=>{
    const available=data.variants.filter(item=>item.samples.some(source=>source.packetId===packet));
    const chosen=available.find(item=>item.id===variant.id)
      ?? available.find(item=>item.id===DEFAULT_SAMPLE_VARIANT) ?? available[0];
    if(!chosen) return;
    setVariant(chosen.id);setPacket(packet);setView('forms');reset();
    window.scrollTo({top:0,behavior:'smooth'});
  };
  return <section className="sample-review">
    <header className="sample-heading"><div><div className="eyebrow"><FlaskConical size={16}/>{say('KIỂM THỬ MẪU · CHỨNG TỪ GỐC','SAMPLE TESTS · ORIGINAL DOCUMENTS')}</div><h1>{say('Biểu mẫu AI & đối chiếu ToKhai','AI-filled forms & ToKhai comparison')}</h1><p>{say('Xem ba biểu mẫu được điền từ kết quả AI đã lưu. Giá trị thiếu vẫn để trống; đáp án nhân viên chỉ dùng để đối chiếu.','Inspect all three forms filled from saved AI results. Missing values stay blank; employee answers are used only for comparison.')}</p></div><span className="sample-draft-label">{say('Bản nháp · chưa nộp','Drafts · not submitted')}</span></header>
    {improvementVariants.length>1 && <section className="sample-stage-comparison" aria-label={say('Tiến độ cải thiện GLM','GLM improvement progress')}>
      <h2>{say('Cải thiện trên cùng bốn mẫu','Improvement on the same four samples')}</h2>
      <div className="sample-stage-options">{improvementVariants.map((item,index)=><button type="button" key={item.id} aria-pressed={variant.id===item.id} onClick={()=>{setVariant(item.id);reset();}}>
        <span>{index+1}. {variantLabel(item)}</span><strong>{pct(item.metrics.visible.contentAgreement)}</strong><small>{item.metrics.visible.contentCorrect}/{item.metrics.visible.eligible} {say('khớp nội dung','content matches')}</small>
      </button>)}</div>
      <p>{say('Bốn mẫu phát triển được dùng lại','Four reused development samples')} · {reviewedVariant?say('Rà soát nội bộ có AI hỗ trợ','AI-assisted internal review'):say('Điểm nội dung gồm tương đương đã rà soát','Content score includes reviewed equivalents')} · {say('Chưa đạt mục tiêu 90%','90% target unmet')}</p>
    </section>}
    {testingSamples.length>0 && <section className="sample-testing-set" aria-label={say('Các mẫu được chọn để kiểm thử','Selected testing samples')}>
      <div className="sample-testing-heading"><div><span className="sample-testing-badge"><FlaskConical size={14}/>{say('ĐÃ CHỌN ĐỂ KIỂM THỬ','SELECTED FOR TESTING')}</span><h2>{testingSamples.length} {say('mẫu · GLM-5.3-Flash','samples · GLM-5.3-Flash')}</h2><p>{variantLabel(variant)} · {say('Chọn mẫu để xem cả ba biểu mẫu và đối chiếu với ToKhai.','Select a sample to inspect all three forms and compare with ToKhai.')}</p></div><button type="button" className="sample-download" onClick={downloadDifferences}><Download size={15}/>{say('Tải khác biệt của 4 mẫu (JSON)','Download 4-sample differences (JSON)')}</button></div>
      <div className="sample-testing-cards">{testingSamples.map((selected,index)=><button type="button" key={selected.packetId} className="sample-testing-card" aria-pressed={sample.packetId===selected.packetId} onClick={()=>{setPacket(selected.packetId);setDifferenceScope('shipment');setView('forms');reset();}}>
        <span className="sample-testing-number">{String(index+1).padStart(2,'0')} <span>{say('Mẫu kiểm thử','Test sample')}</span></span><strong>{selected.label}</strong><span className="sample-testing-score">{pct(selected.metrics.visible.contentAgreement)} <small>{say('khớp nội dung','content agreement')}</small></span><span className="sample-testing-counts">{selected.metrics.visible.unreviewedMismatches+selected.metrics.visible.reviewedNotEquivalent} {say('khác','different')} · {selected.metrics.visible.missing} {say('thiếu','missing')} · {selected.metrics.visible.reviewedEquivalent} {say('tương đương','equivalent')}</span>
      </button>)}</div>
      <p className="sample-testing-note">{say('Biểu mẫu, điểm số và tệp khác biệt đều theo phiên bản đang chọn. Mở trang này không chạy AI mới.','Forms, scores and the differences download follow the selected version. Opening this page does not start a new AI run.')}</p>
    </section>}
    <div className="sample-selectors"><label>{say('Kết quả mô hình','Model results')}<select value={variant.id} onChange={e=>{setVariant(e.target.value);reset();}}>{data.variants.map(v=><option key={v.id} value={v.id} disabled={!v.samples.length}>{v.label}</option>)}</select></label><label>{say('Lô hàng mẫu','Sample shipment')}<select value={sample.packetId} onChange={e=>{setPacket(e.target.value);reset();}}>{variant.samples.map(s=><option key={s.packetId} value={s.packetId}>{s.label}</option>)}</select></label></div>
    <section className="sample-outcomes" aria-label={say('Kết quả đối chiếu cả ba biểu mẫu','Agreement across all three forms')}>
      <div className="sample-outcome-heading"><h2>{say('Đối chiếu cả ba biểu mẫu','Comparison across all three forms')}</h2><span>{overall.eligible} {say('thành phần có thể so sánh','comparable components')} · {variant.sampleCount} {say('lô hàng','shipments')}</span></div>
      <div className="sample-outcome-counts">
        <article className="sample-outcome-agree"><span>{say('Khớp nội dung','Content agreement')}</span><strong>{pct(overall.contentAgreement)}</strong><small>{overall.contentCorrect} / {overall.eligible}</small></article>
        <article className="sample-outcome-different"><span>{say('Khác với ToKhai','Different from ToKhai')}</span><strong>{pct(componentShare(different))}</strong><small>{different} / {overall.eligible}</small></article>
        <article className="sample-outcome-missing"><span>{say('Còn thiếu','Missing values')}</span><strong>{pct(componentShare(overall.missing))}</strong><small>{overall.missing} / {overall.eligible}</small></article>
      </div>
      <div className="sample-outcome-bar" aria-hidden="true"><span className="sample-outcome-agree" style={{width:`${(componentShare(overall.contentCorrect)??0)*100}%`}}/><span className="sample-outcome-different" style={{width:`${(componentShare(different)??0)*100}%`}}/><span className="sample-outcome-missing" style={{width:`${(componentShare(overall.missing)??0)*100}%`}}/></div>
    </section>
    <div className="sample-score-grid">
      <article><span>{say('Độ khớp chính xác','Exact agreement')}</span><strong>{pct(overall.exactAgreement)}</strong><small>{overall.exactMatches}/{overall.eligible}</small></article>
      <article><span>{say('Tương đương có điểm','Credited equivalents')}</span><strong>{overall.reviewedEquivalent}</strong><small>{say('Có trong điểm khớp nội dung','Included in content agreement')}</small></article>
      <article><span>{say('Tỷ lệ có giá trị','Filled coverage')}</span><strong>{pct(overall.filledCoverage)}</strong><small>{overall.filled} {say('có giá trị','filled')} · {overall.missing} {say('còn thiếu','missing')}</small></article>
      <article><span>{say('Phạm vi kết quả','Result scope')}</span><strong>{variant.sampleCount} {say('lô hàng','shipments')}</strong><small>{variant.id==='kimi-k26'?say('18 phát triển + 11 kiểm tra riêng','18 development + 11 held-out'):variant.stage?say('Bốn mẫu phát triển được dùng lại','Four reused development samples'):say('Thử nghiệm 4 mẫu liên quan','Pilot of 4 related samples')}</small></article>
    </div>
    <p className="sample-scope-note">{say('Các điểm trên tính trên những thành phần có thể so sánh của cả ba biểu mẫu, bao gồm giá trị còn thiếu. Mẫu GLM không đại diện cho toàn bộ 29 lô hàng. Mục tiêu 90% chưa đạt.','Scores cover comparable components across all three forms, including missing values. The GLM pilot does not represent all 29 shipments. The 90% target has not been met.')}</p>
    {variant.id!=='kimi-k26' && <p className="sample-scope-note">{say('Kimi trước đây trên cùng 4 mẫu','Earlier Kimi results on these same 4 samples')}: <strong>{pct(data.historicalPilotReference.visible.contentAgreement)}</strong>. {say('Đây là dữ liệu tham chiếu từ lần chạy trước. Lượt Kimi đối chứng mới đã hủy theo yêu cầu ngừng sử dụng Kimi.','This is a historical reference. The fresh Kimi control was cancelled following your request to stop using Kimi.')}</p>}
    <section className="sample-packet-summary"><div><h2>{sample.label}</h2><p>{say('Điểm lô hàng này','This shipment')}: <strong>{pct(current.contentAgreement)}</strong> · {current.contentCorrect}/{current.eligible} {say('khớp nội dung','content matches')} · {current.missing} {say('thiếu','missing')}</p></div><div className="sample-reading"><span>{reviewedVariant?say('Đã có rà soát nguồn riêng bằng AI','Includes separate AI-assisted source review'):sample.readingStatus==='complete'?say('Đọc nguồn ban đầu: đã qua kiểm tra','Original source readings: checks passed'):say('Đọc nguồn: còn thiếu / cần rà soát','Source reading: incomplete / needs review')}</span><small>{sample.failures.length} {say('lỗi đọc đã lưu','saved reading failures')} · {sample.population==='holdout'?say('Mẫu kiểm tra riêng','Held-out sample'):say('Mẫu phát triển','Development sample')}</small></div></section>
    <div className="sample-form-scores">{tabs.map(t=><div key={t.id}>{score(t.label,sample.metrics.byForm[t.id])}</div>)}</div>
    <details className="sample-documents"><summary>{say('Chứng từ gốc & đáp án ToKhai','Original documents & employee ToKhai')} <span>{sample.originalAssets.length} + {sample.employeeAssets.length} {say('tệp','files')}</span></summary><div className="sample-document-columns"><section><h3>{say('Chứng từ AI đã đọc','Supporting originals read by AI')}</h3>{assets(sample.originalAssets)}</section><section><h3>{say('ToKhai nhân viên · chỉ đối chiếu','Employee ToKhai · comparison only')}</h3>{assets(sample.employeeAssets)}</section></div></details>
    <div className="sample-view-switch" role="group" aria-label={say('Cách xem kết quả','Result view')}><button type="button" aria-pressed={view==='forms'} onClick={()=>{setView('forms');setFocused(null);}}><FileText size={15}/>{say('Ba biểu mẫu đã điền','Three filled forms')}</button><button type="button" aria-pressed={view==='differences'} onClick={()=>{setView('differences');setFocused(null);}}><CheckCheck size={15}/>{say('Khác biệt với ToKhai','Differences from ToKhai')}</button></div>
    {view==='differences' && <section className="sample-differences" aria-label={say('Bảng khác biệt','Differences table')}>
      <div className="sample-difference-toolbar"><div><h2>{say('Đối chiếu AI với nhân viên','AI versus employee comparison')}</h2><p>{say('Tất cả ba biểu mẫu và các dòng hàng; bao gồm ô AI còn trống.','All three forms and goods rows, including blank AI values.')}</p></div><div className="sample-difference-filters">{isTestingVariant && <label>{say('Phạm vi','Scope')}<select value={differenceScope} onChange={e=>setDifferenceScope(e.target.value as 'selected'|'shipment')}><option value="selected">{say('Cả 4 mẫu đã chọn','All 4 selected samples')}</option><option value="shipment">{say('Lô hàng đang xem','Current shipment')}</option></select></label>}<label>{say('Trạng thái','Status')}<select value={differenceFilter} onChange={e=>setDifferenceFilter(e.target.value as SampleDifferenceFilter)}><option value="attention">{say('Khác + thiếu','Different + missing')}</option><option value="different">{say('Chỉ giá trị khác','Different values only')}</option><option value="missing">{say('Chỉ giá trị thiếu','Missing values only')}</option><option value="equivalent">{say('Tương đương đã rà soát · có điểm','Reviewed equivalents · credited')}</option></select></label></div></div>
      <p className="sample-difference-count" aria-live="polite"><strong>{differenceRows.length}</strong> {say('thành phần so sánh','comparable components')} · {differenceSamples.length} {say('lô hàng','shipments')}. {say('Các ô chưa đo lường không được tính là lỗi. Tương đương có điểm được liệt kê riêng.','Unmeasured controls are not counted as errors. Credited equivalents are listed separately.')}</p>
      <SampleDifferenceTable rows={differenceRows} onOpen={openComparison} />
    </section>}
    {view === 'forms' && <SampleFilledForms
      sample={sample} tab={tab} goodsIndex={goodsIndex}
      differencesOnly={differencesOnly} expectedVisible={expectedVisible}
      onTabChange={next => { setTab(next); setFocused(null); }}
      onGoodsChange={index => { setGoodsIndex(index); setFocused(null); }}
      onDifferencesOnlyChange={setDifferencesOnly}
      onExpectedVisibleChange={setExpectedVisible}
      onCompare={setFocused}
    />}
    {focused && <aside className="sample-comparison-detail" aria-label={say('Chi tiết đối chiếu','Comparison details')}><button className="sample-close-detail" onClick={()=>setFocused(null)}>{say('Đóng','Close')} ×</button><h3>{statusText(focused)} · {focused.fieldId}.{focused.component}</h3><dl><dt>{say('Bản nháp AI','AI draft')}</dt><dd>{display(focused.actual)}</dd><dt>ToKhai</dt><dd>{display(focused.expected)}</dd><dt>{say('Vị trí đáp án','Answer location')}</dt><dd>{focused.answerLocation.assetId?<a href={assetUrl(focused.answerLocation.assetId)} target="_blank" rel="noreferrer">{focused.answerLocation.sourceFile}</a>:focused.answerLocation.sourceFile} · {focused.answerLocation.sheet} · {focused.answerLocation.cell}</dd></dl>{focused.review && <p>{focused.review.reason}</p>}<small>{say('Tương đương nội dung là rà soát nội bộ có AI hỗ trợ, chưa phải xác nhận độc lập của con người.','Equivalent content uses AI-assisted internal review, not independent human validation.')}</small></aside>}
    <details className="sample-method"><summary>{say('Cách tính điểm & giới hạn','Scoring and limitations')}</summary><p>{say('Độ khớp nội dung = (khớp chính xác + tương đương đã rà soát) / tất cả thành phần có đáp án hợp lệ. Giá trị thiếu và khác chưa rà soát không được cộng điểm. Các ô “Chưa đo lường” không được tính là đúng.','Content agreement = (exact matches + reviewed equivalents) / all eligible answer components. Missing values and unreviewed differences receive no credit. “Not measured” controls are not counted as correct.')}</p>
      {reviewedVariant && <p>{say('Phiên bản này gồm rà soát nội bộ chứng từ bằng AI. Điểm số không phải độ chính xác hoàn toàn tự động của GLM hay xác nhận độc lập của con người. Bốn mẫu phát triển được dùng lại, chưa phải kiểm tra trên mẫu mới.','This version includes AI-assisted internal source review. Its score is not fully automatic GLM accuracy or independent human validation. The four development samples were reused; this is not an unseen holdout test.')}</p>}
      {variant.processingSummary && <p>{say('Lần đọc bổ sung','Supplementary reading attempts')}: {variant.processingSummary.newProviderCalls} · {say('Chấp nhận toàn bộ kết quả tự động','Fully accepted automatically')}: {variant.processingSummary.fullyAcceptedEnvelopes} · {say('Kết quả đầy đủ không qua kiểm tra','Full-response failures')}: {variant.processingSummary.fullEnvelopeFailures} · {say('Chỉnh sửa nguồn được rà soát riêng','Separately reviewed source edits')}: {variant.processingSummary.reviewedSourceEdits}.</p>}
      {variant.limitations?.map((note,index)=><p key={index}>{note}</p>)}
      <p>{say('Đối chiếu hàng hóa theo thứ tự dòng bản in; một số nhân viên gộp nhiều dòng hóa đơn. Bản nháp giữ dòng nguồn, nên khác dòng chưa chắc là lỗi đọc.','Goods use printed-row alignment; some employee declarations combine several invoice rows. Drafts retain source rows, so a row difference does not necessarily mean a reading error.')}</p><p>{say('Thành phần cấu trúc hàng hóa ngoài ba biểu mẫu','Structured goods components outside the three forms')}: {sample.metrics.byForm.structured_goods_only.contentCorrect}/{sample.metrics.byForm.structured_goods_only.eligible}. {sample.unscoredPopulatedComponents} {say('giá trị có dữ liệu nhưng chưa có đáp án hợp lệ để chấm.','populated components have no eligible scored answer.')}</p><p>{say('Không có giá trị mặc định hải quan nào được tự bịa. Các thông tin còn thiếu cần hướng dẫn công ty; mọi biểu mẫu vẫn là bản nháp.','No customs defaults are invented. Missing business decisions require company instructions; every form remains a draft.')}</p></details>
    <details className="sample-method"><summary>{say('Toàn bộ mẫu ToKhai','All ToKhai sample collections')} · {data.inventory.length} ({inventoryExcluded.length} {say('không đủ điều kiện chấm','excluded from scoring')})</summary><ul className="sample-inventory">{data.inventory.map(item=><li key={item.packetId}><span>{item.label}</span>{item.eligible?<button onClick={()=>openInventorySample(item.packetId)}>{say('Mở biểu mẫu','Open forms')}</button>:<small>{exclusionLabel(item.status)}</small>}</li>)}</ul></details>
  </section>;
}
