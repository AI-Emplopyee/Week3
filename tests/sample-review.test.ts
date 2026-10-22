import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { localSampleResponse } from '../lib/local-sample-review.ts';
import { sampleFormValue, sampleFieldComparison, sampleVisibleDifferences, sampleDifferencesExport, selectedGlmTestSamples, sampleReviewSelection, sampleGoodsRowCount, GLM_TEST_PACKET_IDS } from '../lib/sample-review-client.ts';
import { getEcusFormField } from '../lib/ecus-form.ts';
import type { SampleReviewComparison, SampleReviewData, SampleReviewSample, SampleReviewVariant } from '../lib/sample-review-types.ts';

test('selected GLM differences preserve blanks and values, separate credited equivalents and ignore unmeasured controls',()=>{
  const comparison=(contentStatus:SampleReviewComparison['contentStatus'],tab:SampleReviewComparison['tab']='general_1',actual:SampleReviewComparison['actual']='AI VALUE')=>({
    contentStatus,tab,actual,expected:'EMPLOYEE VALUE',fieldId:'1.41',component:'reference',ecusKeys:['invoiceNumber'],
    printRowIndex:null,pairHash:'pair-binding',answerLocation:{sourceFile:'ToKhai.xls',sheet:'Sheet 1',cell:'A10',assetId:null},review:null,
  }) as SampleReviewComparison;
  const sample={
    packetId:GLM_TEST_PACKET_IDS[0],label:'Selected test sample',
    comparisons:[comparison('exact_match'),comparison('unreviewed_mismatch'),comparison('missing','general_2',null),comparison('reviewed_equivalent'),comparison('reviewed_not_equivalent','goods'),comparison('unreviewed_mismatch','structured_goods_only'),comparison('missing','unmapped',null)],
    metrics:{visible:{eligible:5,contentCorrect:2}},extraGoodsRows:1,unscoredPopulatedComponents:4,
  } as unknown as SampleReviewSample;
  const before=JSON.stringify(sample);
  assert.equal(sampleVisibleDifferences(sample).length,3);
  assert.equal(sampleVisibleDifferences(sample,'different').length,2);
  assert.equal(sampleVisibleDifferences(sample,'missing').length,1);
  assert.equal(sampleVisibleDifferences(sample,'equivalent').length,1);
  const variant={id:'glm53-flash-low',model:'glm-5.3-flash',samples:[{...sample,packetId:'not-in-approved-selection'},sample]} as SampleReviewVariant;
  assert.equal(selectedGlmTestSamples(variant).length,1);
  assert.equal(selectedGlmTestSamples({...variant,id:'glm53-flash-high'}).length,0);
  const exported=sampleDifferencesExport(variant,'2026-10-20T00:00:00Z');
  assert.equal(exported.samples.length,1);
  assert.equal(exported.samples[0].differences.length,3);
  assert.equal(exported.samples[0].reviewedEquivalents.length,1);
  const missing=exported.samples[0].differences.find(row=>row.status==='missing')!;
  assert.equal(missing.aiValue,null);
  assert.equal(missing.employeeValue,'EMPLOYEE VALUE');
  assert.equal(missing.employeeSource.cell,'A10');
  assert.equal(missing.pairHash,'pair-binding');
  assert.equal(exported.samples[0].extraGoodsRows,1);
  assert.equal(JSON.stringify(sample),before);
});

test('comparison rows follow form order and numeric goods-row and field order without mutating the saved data',()=>{
  const row=(tab:SampleReviewComparison['tab'],printRowIndex:number|null,fieldId:string,component='text')=>({
    tab,printRowIndex,fieldId,component,contentStatus:'missing',
  }) as SampleReviewComparison;
  const comparisons=[
    row('goods',10,'1.78'),row('goods',1,'1.100'),row('general_2',null,'1.41'),
    row('goods',0,'1.78'),row('general_1',null,'1.2'),row('goods',1,'1.79'),
    row('goods',9,'1.78'),row('goods',1,'1.74','code'),row('goods',1,'1.74','name'),
  ];
  const sample={comparisons} as SampleReviewSample;
  const saved=JSON.stringify(comparisons);
  assert.deepEqual(sampleVisibleDifferences(sample).map(row=>[row.tab,row.printRowIndex,row.fieldId,row.component]),[
    ['general_1',null,'1.2','text'],['general_2',null,'1.41','text'],
    ['goods',0,'1.78','text'],['goods',1,'1.74','code'],['goods',1,'1.74','name'],
    ['goods',1,'1.79','text'],['goods',1,'1.100','text'],['goods',9,'1.78','text'],['goods',10,'1.78','text'],
  ]);
  assert.equal(JSON.stringify(comparisons),saved);
});

test('improved sample exports use the selected saved results and retain review labels and missing answers', () => {
  const makeSample = (actual: string | null, contentStatus: SampleReviewComparison['contentStatus']) => ({
    packetId: GLM_TEST_PACKET_IDS[0], label: 'Selected shipment',
    comparisons: [{ tab: 'general_1', fieldId: '1.15', component: 'name', ecusKeys: ['importerName'],
      printRowIndex: null, actual, expected: 'Employee name', contentStatus, pairHash: 'bound-pair',
      answerLocation: { sourceFile: 'ToKhai.xls', sheet: 'Sheet 1', cell: 'A10', assetId: null },
      review: contentStatus === 'reviewed_equivalent' ? { status: 'equivalent', reason: 'Same legal entity.' } : null,
    }], metrics: { visible: { eligible: 1 } }, extraGoodsRows: 0, unscoredPopulatedComponents: 0,
  }) as unknown as SampleReviewSample;
  const automatic = { id: 'glm53-flash-improved-auto', label: 'Automatic fixes', model: 'glm-5.3-flash',
    scope: 'Four reused development shipments; automatic mapping fixes.', samples: [makeSample(null, 'missing')],
  } as SampleReviewVariant;
  const reviewed = { ...automatic, id: 'glm53-flash-improved-reviewed', label: 'Source-reviewed draft',
    scope: 'Four reused development shipments; AI-assisted internal review.', samples: [makeSample('Source name', 'reviewed_equivalent')],
  } as SampleReviewVariant;
  for (const variant of [automatic, reviewed]) {
    assert.deepEqual(selectedGlmTestSamples(variant), variant.samples);
    const exported = sampleDifferencesExport(variant, '2026-10-20T00:00:00Z');
    assert.equal(exported.variant, variant.id);
    assert.equal(exported.samples.length, 1);
  }
  const automaticExport = sampleDifferencesExport(automatic, '2026-10-20T00:00:00Z');
  const reviewedExport = sampleDifferencesExport(reviewed, '2026-10-20T00:00:00Z');
  assert.equal(automaticExport.samples[0].differences[0].aiValue, null);
  assert.equal(automaticExport.samples[0].reviewedEquivalents.length, 0);
  assert.equal(reviewedExport.samples[0].differences.length, 0);
  assert.equal(reviewedExport.samples[0].reviewedEquivalents[0].aiValue, 'Source name');
  assert.equal(reviewedExport.samples[0].reviewedEquivalents[0].review?.reason, 'Same legal entity.');
});

test('employee answers never populate AI fields; missing/stale fields remain blank',()=>{
  const sample={shipment:{goods:[],declarationDraft:{schemaVersion:1,fields:[{fieldId:'1.41',applicability:'applicable',stale:false,value:{kind:'reference',reference:'AI-INVOICE'}}]}},comparisons:[{scope:'header',fieldId:'1.41',component:'reference',tab:'general_2',expected:'EMPLOYEE-ANSWER',actual:'AI-INVOICE'}]} as unknown as SampleReviewSample;
  assert.equal(sampleFormValue(sample,getEcusFormField('invoiceNumber')!,0),'AI-INVOICE');
  sample.comparisons[0].expected='CHANGED-GOLD';
  assert.equal(sampleFormValue(sample,getEcusFormField('invoiceNumber')!,0),'AI-INVOICE');
  assert.equal(sampleFormValue(sample,getEcusFormField('customsOffice')!,0),'');
  sample.shipment.declarationDraft.fields[0].stale=true;
  assert.equal(sampleFormValue(sample,getEcusFormField('invoiceNumber')!,0),'');
});

test('goods comparisons follow the frozen printed row, including missing AI rows',()=>{
  const sample={shipment:{goods:[{id:'g1'}],declarationDraft:{schemaVersion:1,fields:[]}},comparisons:[{scope:'goods:2',fieldId:'1.78',component:'text',tab:'goods',expected:'Missing second line',actual:null}]} as unknown as SampleReviewSample;
  const field=getEcusFormField('goodsDescription') || getEcusFormField('description');
  assert.ok(field);
  assert.equal(sampleFieldComparison(sample,field,0),undefined);
  assert.equal(sampleFieldComparison(sample,field,1)?.actual,null);
  assert.equal(sampleFormValue(sample,field,1),'');
});

test('private original endpoint serves verified bytes and denies mutations, traversal, changed files and escaped symlinks',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'sample-review-'));
  const directory=path.join(root,'.aicd-local/sample-review');
  const originals=path.join(directory,'originals');
  const bytes=Buffer.from('%PDF-synthetic-original');
  const sha=createHash('sha256').update(bytes).digest('hex');
  const id='source-'+sha;
  try {
    await mkdir(originals,{recursive:true});
    const filename=path.join(originals,sha+'.pdf');
    await writeFile(filename,bytes);
    await writeFile(path.join(directory,'data.json'),JSON.stringify({schemaVersion:1,variants:[]}));
    const asset={path:filename,name:'Original invoice.pdf',mime:'application/pdf',size:bytes.length,sha256:sha,role:'source'};
    const saveIndex=()=>writeFile(path.join(directory,'asset-index.json'),JSON.stringify({schemaVersion:1,assets:{[id]:asset}}));
    await saveIndex();
    const response=await localSampleResponse(root,'GET','/api/local-sample-review/assets/'+id);
    assert.equal(response?.status,200);assert.deepEqual(response?.body,bytes);
    assert.equal(response?.headers['Cache-Control'],'private, no-store');
    assert.equal(response?.headers['Cross-Origin-Resource-Policy'],'same-origin');
    assert.equal((await localSampleResponse(root,'HEAD','/api/local-sample-review/assets/'+id))?.body.length,0);
    assert.equal((await localSampleResponse(root,'POST','/api/local-sample-review'))?.status,405);
    assert.equal((await localSampleResponse(root,'GET','/api/local-sample-review/asset-index.json'))?.status,404);
    assert.equal((await localSampleResponse(root,'GET','/api/local-sample-review/assets/../../.model-comparison.vars'))?.status,404);
    await writeFile(filename,Buffer.alloc(bytes.length,1));
    assert.equal((await localSampleResponse(root,'GET','/api/local-sample-review/assets/'+id))?.status,409);
    const outside=path.join(root,'outside.pdf');await writeFile(outside,bytes);
    const link=path.join(originals,'escape.pdf');await symlink(outside,link);asset.path=link;await saveIndex();
    assert.equal((await localSampleResponse(root,'GET','/api/local-sample-review/assets/'+id))?.status,404);
    assert.equal(await localSampleResponse(root,'GET','/api/workspace'),null);
  } finally { await rm(root,{recursive:true,force:true}); }
});


test('sample selection skips empty variants, preserves matching packets and reports an empty export', () => {
  const first = { packetId: 'first' } as SampleReviewSample;
  const second = { packetId: 'second' } as SampleReviewSample;
  const empty = { id: 'empty', samples: [] } as unknown as SampleReviewVariant;
  const populated = { id: 'populated', samples: [first, second] } as unknown as SampleReviewVariant;
  const data = { variants: [empty, populated] } as SampleReviewData;
  assert.equal(sampleReviewSelection(data, 'empty', '')?.sample, first);
  assert.equal(sampleReviewSelection(data, 'populated', 'second')?.sample, second);
  assert.equal(sampleReviewSelection(data, 'missing-variant', 'missing-packet')?.sample, first);
  assert.equal(sampleReviewSelection({ variants: [empty] } as SampleReviewData, '', ''), null);
  assert.equal(sampleReviewSelection({ variants: [] } as unknown as SampleReviewData, '', ''), null);
});

test('goods navigation includes missing answer rows and ignores unrelated structured rows', () => {
  const sample = {
    shipment: { goods: [{ id: 'g1' }] },
    comparisons: [
      { tab: 'goods', printRowIndex: 3 },
      { tab: 'structured_goods_only', printRowIndex: 20 },
      { tab: 'general_1', printRowIndex: null },
    ],
  } as unknown as SampleReviewSample;
  assert.equal(sampleGoodsRowCount(sample), 4);
  assert.equal(sampleGoodsRowCount({ shipment: { goods: [] }, comparisons: [] } as unknown as SampleReviewSample), 1);
});
