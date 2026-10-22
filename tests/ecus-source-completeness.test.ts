import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAction, createEmptyWorkspace, getIssues } from '../lib/engine.ts';
import type { DocumentType, ShipmentDocument } from '../lib/types.ts';

const actor={id:'completeness-reviewer',name:'Synthetic reviewer',email:'reviewer@example.invalid'};
function fixture(type: DocumentType) {
  const state=applyAction(createEmptyWorkspace('source-completeness'),{type:'create_case',title:'Synthetic source completeness'},actor);
  const shipment=state.cases[0];shipment.groupingConfirmed=true;
  const document:ShipmentDocument={id:'source',caseId:shipment.id,name:'source.txt',type,mime:'text/plain',size:1,sha256:'synthetic',active:true,version:1,uploadedAt:'',synthetic:true,extractionPipeline:'kimi',extractionStatus:'extracted',aiProcessedPages:[1],pages:[{page:1,text:'Invoice total: 100',documentType:type,aiReadability:'clear'}]};
  state.documents.push(document);shipment.documentIds.push(document.id);
  return {state,shipment,document};
}

test('the supplied information determines completeness without mandatory document categories',()=>{
  for(const type of ['invoice','packing_list','bill_of_lading','air_waybill','contract','other'] as const){
    const {state}=fixture(type);const issues=getIssues(state);
    assert.ok(!issues.some(issue=>/:missing-(invoice|packing|transport)$/.test(issue.id)),type);
    assert.ok(issues.some(issue=>issue.ecusFieldKey==='invoiceTotal'&&issue.id.endsWith(':required')),type);
    assert.ok(issues.some(issue=>issue.id.endsWith(':goods-missing')),type);
  }
});

test('removing document-category requirements retains unread-source and uncertain-value findings',()=>{
  const {state,shipment,document}=fixture('other');
  state.candidates.push({id:'uncertain-total',caseId:shipment.id,documentId:document.id,documentVersion:1,page:1,field:'invoiceTotal',value:'100',originalText:'Invoice total: 100',location:'Synthetic source',method:'kimi:synthetic',confidence:'low',readability:'uncertain',normalizations:[]});
  assert.ok(getIssues(state).some(issue=>issue.kind==='uncertain'&&issue.field==='invoiceTotal'));
  document.extractionStatus='pending_ai';document.aiProcessedPages=[];delete document.pages[0].aiReadability;
  const pending=getIssues(state);
  assert.ok(pending.some(issue=>issue.kind==='document'&&issue.documentIds.includes(document.id)));
  assert.ok(!pending.some(issue=>issue.id.endsWith(':required')),'Unread sources must not produce premature missing-field questions.');
  document.extractionStatus='needs_transcription';document.pages[0].aiReadability='uncertain';document.aiProcessedPages=[1];
  assert.equal(getIssues(state).find(issue=>issue.id.endsWith(':document-source'))?.title,'AI chưa đọc rõ chứng từ');
});
