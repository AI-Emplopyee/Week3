import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { applyAction, createEmptyWorkspace } from '../lib/engine.ts';
import { prepareWorkspaceCommit, readWorkspaceState } from '../lib/server-persistence.ts';
import { jpegDimensions } from '../lib/vision.ts';
import { renderOriginalPage, startLocalBackground } from '../scripts/local-background.mjs';
import type { Actor, ShipmentDocument } from '../lib/types.ts';

const key = Symbol.for('aicd.tests.background');
const shared = globalThis as typeof globalThis & { [key]: Record<string, unknown> };
const stub = (code: string) => `data:text/javascript,${encodeURIComponent(code)}`;
const serverStub = stub(`
const fixture = () => globalThis[Symbol.for('aicd.tests.background')];
export class ApiError extends Error { constructor(status, message) { super(message); this.status=status; } }
export const workspace = request => fixture().context(request);
export const readJson = request => request.json();
export const mutate = (...args) => fixture().mutate(...args);
export const requireSameOrigin = request => { if (request.headers.get('origin') !== new URL(request.url).origin) throw new ApiError(403, 'Origin mismatch'); };
export const expectRevision = (context, revision) => { if (context.state.revision !== revision) throw new ApiError(409, 'Revision changed'); };
export const response = context => ({state:context.state,actor:context.actor,role:'owner',issues:[]});
export const json = value => Response.json(value);
export const bucket = () => fixture().bucket;
export const privateHeaders = {};
export const readLimitedBytes = async request => new Uint8Array(await request.arrayBuffer());
`);
register(stub(`
let options;
export const initialize = value => { options=value; };
export async function resolve(specifier, context, next) {
 if (specifier === 'cloudflare:workers') return { url: options.env, shortCircuit:true };
 if (specifier === '@/lib/server') return { url: options.server, shortCircuit:true };
 if (specifier === '@/lib/server-auth') return { url: options.auth, shortCircuit:true };
 if (specifier === '@/lib/server-vision') return { url: options.vision, shortCircuit:true };
 if (specifier === '@/lib/email-shipment-ai' && context.parentURL === options.serverEmail) return { url:options.emailPlanner, shortCircuit:true };
 if (specifier === '@/lib/kimi' && context.parentURL === options.serverKimi) return { url:options.kimi, shortCircuit:true };
 if (specifier.startsWith('@/')) return next(new URL(specifier.slice(2)+'.ts', options.root).href, context);
 return next(specifier, context);
}`), { data: {
  root: new URL('../', import.meta.url).href,
  serverEmail: new URL('../lib/server-email-grouping.ts', import.meta.url).href,
  emailPlanner: stub(`export * from ${JSON.stringify(new URL('../lib/email-shipment-ai.ts', import.meta.url).href)}; export const planEmailShipmentMatches = (...args) => globalThis[Symbol.for('aicd.tests.background')].extractEmail(...args);`),
  serverKimi: new URL('../lib/server-kimi.ts', import.meta.url).href,
  server: serverStub,
  env: stub(`export const env = globalThis[Symbol.for('aicd.tests.background')].env;`),
  auth: stub(`export const runtimeAuthMode = () => 'local';`),
  vision: stub(`export const loadVisionPages = (...args) => globalThis[Symbol.for('aicd.tests.background')].images(...args);`),
  kimi: stub(`export * from ${JSON.stringify(new URL('../lib/kimi.ts', import.meta.url).href)}; export const extractWithKimi = (...args) => globalThis[Symbol.for('aicd.tests.background')].extract(...args);`),
} });
shared[key] = { env: { AICD_AUTH_MODE: 'local', AICD_BACKGROUND_PROCESSING: '0', ZAI_API_KEY: 'synthetic-never-transmitted', ZAI_MODEL: 'glm-5.3-flash' } };
const { pendingAiJobs } = await import('../lib/server-ai-queue.ts');
const { requestKimiExtraction } = await import('../lib/server-kimi.ts');
const { uploadVisionPage } = await import('../lib/server-vision.ts');

class Statement {
  database: DatabaseSync; sql: string; values: SQLInputValue[];
  constructor(database: DatabaseSync, sql: string, values: SQLInputValue[] = []) { this.database=database; this.sql=sql; this.values=values; }
  bind(...values: SQLInputValue[]) { return new Statement(this.database,this.sql,values); }
  async first() { return this.database.prepare(this.sql).get(...this.values) ?? null; }
  async all() { return {results:this.database.prepare(this.sql).all(...this.values)}; }
  async run() { return {meta:{changes:Number(this.database.prepare(this.sql).run(...this.values).changes)}}; }
}

async function syntheticPdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([400, 300]).drawText('Synthetic invoice INV-42', { x: 30, y: 200, size: 16, font });
  return new Uint8Array(await pdf.save());
}

test('local PDF preparation verifies original bytes and creates a bounded JPEG without OCR', async () => {
  const bytes = await syntheticPdf();
  const source = { sha256:createHash('sha256').update(bytes).digest('hex'),mime:'application/pdf',pages:[{page:1,text:''}] };
  const raster = await renderOriginalPage(bytes,source,1);
  assert.deepEqual(jpegDimensions(raster.bytes), {width:raster.width,height:raster.height});
  assert.ok(raster.bytes.length <= 1.5*1024*1024);
  assert.ok(raster.width <= 2600 && raster.height <= 2600);
  await assert.rejects(() => renderOriginalPage(bytes,{...source,sha256:'0'.repeat(64)},1), /integrity/);
});

test('local HTTP runner reads two originals concurrently, saves both revisions and resumes without duplicate calls', async () => {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of ['0000_charming_ghost_rider','0001_classy_wrecking_crew','0002_workspace_state_chunks','0003_ai_processing_jobs']) sqlite.exec(readFileSync(new URL(`../drizzle/${name}.sql`,import.meta.url),'utf8'));
  const actor: Actor = {id:'owner',email:'owner@example.invalid',name:'Synthetic owner'};
  const initial = createEmptyWorkspace('ws_background');
  sqlite.prepare('INSERT INTO workspaces VALUES (?,?,?,?,?,?)').run(initial.id,actor.id,0,JSON.stringify(initial),'now','now');
  sqlite.prepare('INSERT INTO workspace_members VALUES (?,?,?,?,?,?)').run(initial.id,actor.email,actor.id,'owner',actor.id,'now');
  const db = { prepare(sql:string) { return new Statement(sqlite,sql); }, async batch(statements:Statement[]) { sqlite.exec('BEGIN IMMEDIATE'); try { const result=[]; for(const statement of statements) result.push(await statement.run()); sqlite.exec('COMMIT'); return result; } catch(error) { sqlite.exec('ROLLBACK'); throw error; } } } as unknown as D1Database;
  const bytes = await syntheticPdf();
  const state = applyAction(initial,{type:'intake',documents:['first','second'].map(id=>({id,name:id+'.pdf',mime:'application/pdf',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')+id,blobKey:'original/'+id,synthetic:true,extractionPipeline:'kimi',extractionStatus:'pending_ai',pages:[{page:1,text:''}]}))},actor);
  // Distinct source files are required by intake deduplication; use different PDF metadata.
  const originals = new Map<string,Uint8Array>();
  for (const [index,document] of state.documents.entries()) {
    const copy=await PDFDocument.load(bytes); copy.setTitle(`Synthetic original ${index}`); const original=new Uint8Array(await copy.save());
    document.sha256=createHash('sha256').update(original).digest('hex'); originals.set(document.id,original);
  }
  state.emails.push({id:'synthetic-email',messageId:'sample@example.invalid',sender:'sender@example.invalid',subject:'Invoice INV-42',text:'Invoice INV-42',receivedAt:'2026-10-19T00:00:00.000Z',originalName:'synthetic.eml',blobKey:'original/email',documentIds:state.documents.map(document=>document.id),sha256:'e'.repeat(64)});
  state.revision=1;
  await db.batch(prepareWorkspaceCommit(db,state,0,actor));
  const rasters=new Map<string,{page:number;imageSha256:string;width:number;height:number;bytes:Uint8Array}>();
  let calls=0, active=0, maxActive=0, emailCalls=0;
  let movedDuringPreparation=false, movedBeforeExtraction=false;
  const currentDestinations=new Map<string,string>();
  const errors:string[]=[];
  shared[key].mutate=async(context:{state:typeof state},expected:number,action:Parameters<typeof applyAction>[1])=>{
    const next=applyAction(context.state,action,actor); next.revision=expected+1;
    await db.batch(prepareWorkspaceCommit(db,next,expected,actor)); context.state=next;
    return {state:next,actor,role:'owner',issues:[]};
  };
  shared[key].extractEmail=async(_config:unknown,_state:unknown,emailIds:string[])=>{emailCalls++;return {model:'synthetic-email-kimi',emailIds,omittedEmailIds:[],omittedCaseIds:[],matches:[],rejected:0,truncated:false};};
  shared[key].bucket={async put(_key:string,bytes:Uint8Array){
    const imageSha256=createHash('sha256').update(bytes).digest('hex');
    rasters.set(imageSha256,{page:1,imageSha256,...jpegDimensions(bytes),bytes});
  }};
  shared[key].context=async()=>({db,actor,role:'owner',state:await readWorkspaceState(db,initial.id,actor.id)});
  shared[key].images=async(_workspace:string,_source:ShipmentDocument,references:{imageSha256:string}[])=>references.map(reference=>rasters.get(reference.imageSha256));
  shared[key].extract=async(_config:unknown,_source:ShipmentDocument,pages:number[])=>{
    calls++; active++; maxActive=Math.max(maxActive,active);
    const deadline=Date.now()+4000;
    while(calls<2 && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10));
    // Simulate network responses finishing at different times, exercising save rebasing.
    await new Promise(resolve=>setTimeout(resolve,active===2?30:70)); active--;
    return {model:'synthetic-kimi',pages,proposals:[],rejected:0,rejectionDiagnostics:[],pageReadings:pages.map(page=>({page,documentType:'invoice',readability:'clear'}))};
  };
  const server=createServer(async(request,response)=>{
    try {
      const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
      const chunks=[]; for await(const chunk of request) chunks.push(chunk);
      const body=Buffer.concat(chunks);
      const incoming=new Request(new URL(request.url!,origin),{method:request.method,headers:request.headers as Record<string,string>,...(body.length?{body}: {})});
      const path=new URL(incoming.url).pathname;
      let result:Response;
      if(path==='/api/ai/queue') result=await pendingAiJobs(incoming);
      else if(path==='/api/ai/extract') {
        if (!movedBeforeExtraction) {
          movedBeforeExtraction=true;
          const input=await incoming.clone().json() as {documentId:string};
          const latest=await readWorkspaceState(db,initial.id,actor.id);
          const changed=applyAction(latest!,{type:'move_documents',documentIds:[input.documentId],title:'Regrouped before extraction'},actor);
          changed.revision=latest!.revision+1;
          await db.batch(prepareWorkspaceCommit(db,changed,latest!.revision,actor));
          currentDestinations.set(input.documentId,changed.documents.find(document=>document.id===input.documentId)!.caseId);
        }
        result=Response.json(await requestKimiExtraction(incoming));
      }
      else if(path==='/api/workspace') { const saved=await readWorkspaceState(db,initial.id,actor.id); result=Response.json(new URL(incoming.url).searchParams.has('revisionOnly')?{revision:saved?.revision}:{state:saved,actor,role:'owner',issues:[]}); }
      else if(path.startsWith('/api/documents/')) {
        const documentId=decodeURIComponent(path.split('/').pop()!);
        if (!movedDuringPreparation) {
          movedDuringPreparation=true;
          const latest=await readWorkspaceState(db,initial.id,actor.id);
          const changed=applyAction(latest!,{type:'move_documents',documentIds:[documentId],title:'Regrouped while rendering'},actor);
          changed.revision=latest!.revision+1;
          await db.batch(prepareWorkspaceCommit(db,changed,latest!.revision,actor));
          currentDestinations.set(documentId,changed.documents.find(document=>document.id===documentId)!.caseId);
        }
        result=new Response(new Uint8Array(originals.get(documentId)!).buffer);
      }
      else if(path==='/api/ai/vision-page') result=await uploadVisionPage(incoming); else result=Response.json({error:'Unknown path'},{status:404});
      response.writeHead(result.status,Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()));
    } catch(error) { const status=typeof error==='object' && error && 'status' in error?Number(error.status):500; if(status>=500) errors.push(error instanceof Error?error.message:String(error)); response.writeHead(status,{'content-type':'application/json'}); response.end(JSON.stringify({error:'Synthetic request failed'})); }
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  let reader;
  try {
    const paused=await fetch(origin+'/api/ai/queue',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'}).then(response=>response.json());
    assert.equal((paused as {configured:boolean}).configured,false); assert.equal(calls,0);
    (shared[key].env as Record<string,string>).AICD_BACKGROUND_PROCESSING='1';
    reader=startLocalBackground(origin,{intervalMs:20,log:(message:string)=>errors.push(message)});
    const deadline=Date.now()+7000;
    while(Date.now()<deadline && Number(sqlite.prepare("SELECT COUNT(*) AS count FROM ai_processing_jobs WHERE state = 'completed'").get()?.count)<3) await new Promise(resolve=>setTimeout(resolve,25));
    reader.stop();
    assert.equal(errors.length,0,errors.join("; "));
    assert.equal(calls,2); assert.equal(maxActive,2);
    assert.equal((await readWorkspaceState(db,initial.id,actor.id))?.revision,6); assert.equal(emailCalls,1);
    assert.equal(movedDuringPreparation,true); assert.equal(movedBeforeExtraction,true);
    const saved=await readWorkspaceState(db,initial.id,actor.id);
    for(const [documentId,caseId] of currentDestinations) assert.equal(saved!.documents.find(document=>document.id===documentId)!.caseId,caseId);
    reader=startLocalBackground(origin,{intervalMs:20,log:(message:string)=>errors.push(message)});
    await new Promise(resolve=>setTimeout(resolve,90));
    reader.stop(); assert.equal(calls,2,'a restarted reader never calls the provider for completed pages');
    assert.equal(emailCalls,1,'unchanged no-match email results do not repeat');
    const changed=await readWorkspaceState(db,initial.id,actor.id);
    changed!.emails[0].text='A new reply changes the matching context.'; changed!.revision++;
    await db.batch(prepareWorkspaceCommit(db,changed!,changed!.revision-1,actor));
    reader=startLocalBackground(origin,{intervalMs:20,log:(message:string)=>errors.push(message)});
    const emailDeadline=Date.now()+3000;
    while(emailCalls<2 && Date.now()<emailDeadline) await new Promise(resolve=>setTimeout(resolve,25));
    reader.stop(); assert.equal(emailCalls,2,'new email evidence enters a new durable matching job');
  } finally { reader?.stop(); await new Promise<void>(resolve=>server.close(()=>resolve())); sqlite.close(); }
});
