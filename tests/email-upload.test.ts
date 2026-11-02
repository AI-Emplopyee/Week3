import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import PostalMime from 'postal-mime';
import { PDFDocument } from 'pdf-lib';
import { applyAction, createEmptyWorkspace } from '../lib/engine.ts';
import { automaticDocuments } from '../lib/ai-processing-queue.ts';
import type { Action, WorkspaceState } from '../lib/types.ts';
const actor = { id: 'upload-test', name: 'Test reviewer', email: 'reviewer@example.invalid' };
const fixtureKey = Symbol.for('aicd.tests.emailUpload');
type Fixture = { context: { state: WorkspaceState }; originals: Map<string, Uint8Array>; apply: (action: Action) => unknown };
const globals = globalThis as typeof globalThis & { [fixtureKey]?: Fixture };
const stub = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
const serverStub = stub(`
  const fixture = () => globalThis[Symbol.for('aicd.tests.emailUpload')];
  export class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
  export const workspace = async () => fixture().context;
  export const bucket = () => ({ put: async (key, bytes) => fixture().originals.set(key, new Uint8Array(bytes)), delete: async keys => { for (const key of [].concat(keys)) fixture().originals.delete(key); } });
  export const expectRevision = (context, revision) => { if (context.state.revision !== revision) throw new ApiError(409, 'Revision conflict'); };
  export const requireSameOrigin = () => {};
  export const readLimitedBytes = async (request, limit) => { const bytes = new Uint8Array(await request.arrayBuffer()); if (bytes.length > limit) throw new ApiError(413, 'Too large'); return bytes; };
  export const json = value => Response.json(value);
  export const response = context => ({ state: context.state });
  export const mutate = async (context, revision, action) => { expectRevision(context, revision); return fixture().apply(action); };
`);
// module.register is supported by the project's Node 22.13 minimum. Keep the
// asynchronous loader scoped to this one server module inside the test process.
register(stub(`
  let settings;
  export function initialize(data) { settings = data; }
  export async function resolve(specifier, context, next) {
    if (context.parentURL !== settings.serverUploadUrl) return next(specifier, context);
    if (settings.stubs[specifier]) return { url: settings.stubs[specifier], shortCircuit: true };
    if (specifier.startsWith('@/')) return next(new URL(specifier.slice(2) + '.ts', settings.projectUrl).href, context);
    return next(specifier, context);
  }
`), {
  parentURL: import.meta.url,
  data: {
    serverUploadUrl: new URL('../lib/server-upload.ts', import.meta.url).href,
    projectUrl: new URL('../', import.meta.url).href,
    stubs: {
      'cloudflare:workers': stub('export const env = {};'),
      '@/lib/server': serverStub,
      '@/lib/auth-persistence': stub('export const consumeRateLimit = async () => { throw new Error("No provider request expected"); };'),
      '@/lib/server-email-grouping': stub('export const matchEmailsInContext = async () => { throw new Error("No provider request expected"); };'),
    },
  },
});
const { upload } = await import('../lib/server-upload.ts');
function reset(state = createEmptyWorkspace('upload-tests')) {
  const fixture: Fixture = { context: { state }, originals: new Map(), apply(action) { this.context.state = applyAction(this.context.state, action, actor); return { state: this.context.state }; } };
  globals[fixtureKey] = fixture; return fixture;
}
async function send(raw: string, name = 'reply.eml') {
  const form = new FormData(); form.append('file', new File([raw], name, { type: 'message/rfc822' })); form.append('revision', String(globals[fixtureKey]!.context.state.revision));
  form.append('documents', JSON.stringify([{ name, pages: [], extractionStatus: 'extracted', attachments: [] }]));
  return upload(new Request('https://aicd.invalid/api/upload', { method: 'POST', headers: { origin: 'https://aicd.invalid' }, body: form }));
}
async function sendFiles(files: { name: string; text: string }[], targetCaseId?: string) {
  const form = new FormData();
  for (const file of files) form.append('file', new File([file.text], file.name, { type: 'text/plain' }));
  form.append('revision', String(globals[fixtureKey]!.context.state.revision));
  form.append('documents', JSON.stringify(files.map(file => ({ name: file.name, pages: [], extractionStatus: 'pending_ai' }))));
  if (targetCaseId) form.append('targetCaseId', targetCaseId);
  return upload(new Request('https://aicd.invalid/api/upload', { method: 'POST', headers: { origin: 'https://aicd.invalid' }, body: form }));
}
async function sendOriginals(files: { name: string; bytes: Uint8Array; mime?: string }[], options: { targetCaseId?: string; documentId?: string; metadata?: unknown[] } = {}) {
  const form = new FormData();
  for (const file of files) form.append('file', new File([new Uint8Array(file.bytes).buffer], file.name, { type: file.mime || 'application/octet-stream' }));
  form.append('revision', String(globals[fixtureKey]!.context.state.revision));
  form.append('documents', JSON.stringify(options.metadata ?? files.map(file => ({ name: file.name, pages: [], extractionStatus: 'pending_ai' }))));
  if (options.targetCaseId) form.append('targetCaseId', options.targetCaseId);
  if (options.documentId) form.append('documentId', options.documentId);
  return upload(new Request('https://aicd.invalid/api/upload', { method: 'POST', headers: { origin: 'https://aicd.invalid' }, body: form }));
}
const wordOriginal = new Uint8Array(await readFile(new URL('./fixtures/word/synthetic-invoice.doc', import.meta.url)));
const plain = (body: string) => `From: sender@example.invalid\r\nSubject: Shipment follow-up\r\nMessage-ID: <reply-1@example.invalid>\r\nIn-Reply-To: <first@example.invalid>\r\nReferences: <first@example.invalid>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`;

test('body-only email preserves exact EML and text without creating a document or provisional shipment', async () => {
  const fixture = reset(); const raw = plain('Please confirm HBL Number: HBL-123.');
  assert.equal((await send(raw)).status, 200);
  const state = fixture.context.state; assert.equal(state.emails.length, 1); assert.equal(state.documents.length, 0); assert.equal(state.cases.length, 0);
  const email = state.emails[0]; assert.match(email.text!, /HBL-123/); assert.deepEqual(email.documentIds, []); assert.equal(email.inReplyTo, '<first@example.invalid>'); assert.deepEqual(email.references, ['<first@example.invalid>']);
  assert.equal(fixture.originals.size, 1); assert.equal(new TextDecoder().decode(fixture.originals.get(email.blobKey!)), raw);
  assert.ok(state.audit.some(entry => entry.action === 'email_received'));
  await send(raw); assert.equal(fixture.context.state.emails.length, 1); assert.equal(fixture.originals.size, 1);
});

test('a follow-up email leaves existing shipment data and approvals intact', async () => {
  const state = applyAction(createEmptyWorkspace('existing-shipment'), { type: 'intake', documents: [{ id: 'original-invoice', name: 'invoice.txt', mime: 'text/plain', size: 100, sha256: 'invoice-sha', pages: [{ page: 1, text: 'Invoice Number: INV-123\nHBL Number: HBL-123' }], extractionStatus: 'extracted' }] }, actor);
  state.cases[0].approval = { actor: actor.name, at: '2026-10-12', snapshotId: 'snapshot-1' }; state.cases[0].status = 'approved';
  const before = JSON.stringify({ cases: state.cases, documents: state.documents, candidates: state.candidates }); const fixture = reset(state);
  await send(plain('Regarding HBL Number: HBL-123, please use the original invoice.'));
  assert.equal(JSON.stringify({ cases: fixture.context.state.cases, documents: fixture.context.state.documents, candidates: fixture.context.state.candidates }), before);
  assert.equal(fixture.context.state.emails.length, 1); assert.equal(fixture.originals.size, 1);
});

test('HTML-only message text is read without rendering resources or treating scripts as evidence', async () => {
  const fixture = reset();
  const html = '<html><head><style>HBL Number: STYLE-999</style></head><body><p>HBL Number: HBL-123</p><p>Invoice Number: INV-456 &amp; contract &#35; CT-789</p><script>fetch("https://invalid.example"); HBL Number: SCRIPT-999</script><img src="https://invalid.example/tracker"><p>Ki&#7875;m tra&nbsp;lô hàng.</p></body></html>';
  const raw = `From: sender@example.invalid\r\nSubject: HTML reply\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}`;
  assert.equal((await PostalMime.parse(raw)).text, undefined, 'Parser does not synthesize text for a HTML-only message.');
  await send(raw);
  const email = fixture.context.state.emails[0]; assert.match(email.text!, /HBL Number: HBL-123\n+Invoice Number: INV-456 & contract # CT-789/); assert.match(email.text!, /Kiểm tra lô hàng/);
  for (const discarded of ['SCRIPT-999', 'STYLE-999', 'invalid.example', '<p>', 'fetch(']) assert.ok(!email.text!.includes(discarded));
  assert.equal(fixture.context.state.documents.length, 0); assert.equal(fixture.context.state.cases.length, 0); assert.equal(new TextDecoder().decode(fixture.originals.get(email.blobKey!)), raw);
});

test('large reply text remains bounded while the full original is retained', async () => {
  const fixture = reset(); const raw = plain('x'.repeat(60000)); await send(raw);
  assert.equal(fixture.context.state.emails[0].text!.length, 50000); assert.equal(new TextDecoder().decode(fixture.originals.values().next().value!), raw); assert.equal(fixture.context.state.cases.length, 0);
});

test('PDF upload disregards client extraction claims and stores only original page placeholders until Kimi runs', async () => {
  const fixture = reset();
  const pdf = await PDFDocument.create(); pdf.addPage().drawText('Invoice Number: ORIGINAL-123');
  const bytes = await pdf.save();
  const form = new FormData();
  form.append('file', new File([new Uint8Array(bytes).buffer], 'invoice.pdf', { type: 'application/pdf' }));
  form.append('revision', '0');
  form.append('documents', JSON.stringify([{ name: 'invoice.pdf', extractionStatus: 'extracted', pages: [{ page: 1, text: 'Invoice Number: CLIENT-FAKE', pdfText: 'OCR-FAKE', textSource: 'ocr', ocrConfidence: .99, documentType: 'invoice' }] }]));
  const response = await upload(new Request('https://aicd.invalid/api/upload', { method: 'POST', headers: { origin: 'https://aicd.invalid' }, body: form }));
  assert.equal(response.status, 200);
  const state = fixture.context.state;
  assert.equal(state.documents.length, 1); assert.equal(state.candidates.length, 0);
  const document = state.documents[0];
  assert.equal(document.extractionPipeline, 'kimi'); assert.equal(document.extractionStatus, 'pending_ai');
  assert.equal(document.aiStatus, 'unavailable'); assert.equal(document.type, 'other');
  assert.equal(document.pages.length, 1); assert.equal(document.pages[0].text, '');
  assert.ok(!JSON.stringify(document).includes('CLIENT-FAKE')); assert.ok(!JSON.stringify(document).includes('OCR-FAKE'));
  assert.deepEqual(fixture.originals.get(document.blobKey!), bytes);
});

test('Word upload prepares text from the original bytes, ignores forged browser evidence and waits for AI facts', async () => {
  const fixture = reset();
  const response = await sendOriginals([{ name: 'invoice.DOC', bytes: wordOriginal, mime: 'application/msword' }], {
    metadata: [{ name: 'invoice.DOC', extractionStatus: 'extracted', pages: [{ page: 1, text: 'Invoice Number: CLIENT-FAKE', textSource: 'office', documentType: 'invoice' }] }],
  });
  assert.equal(response.status, 200);
  const state = fixture.context.state;
  const document = state.documents[0];
  assert.equal(document.mime, 'application/msword');
  assert.equal(document.extractionPipeline, 'kimi');
  assert.equal(document.extractionStatus, 'pending_ai');
  assert.equal(document.type, 'other');
  assert.equal(document.sha256, createHash('sha256').update(wordOriginal).digest('hex'));
  assert.deepEqual(fixture.originals.get(document.blobKey!), wordOriginal);
  assert.match(document.pages.map(page => page.text).join('\n'), /TEST-DOC-2026/);
  assert.match(document.pages.map(page => page.text).join('\n'), /Công ty Thử nghiệm Việt Nam/);
  assert.ok(document.pages.every(page => page.textSource === 'office' && !page.documentType && !page.aiReadability));
  assert.ok(!JSON.stringify(document).includes('CLIENT-FAKE'));
  assert.deepEqual(state.candidates, []);
  assert.deepEqual(state.cases[0].goods, []);
  assert.deepEqual(automaticDocuments(state).map(source => source.id), [document.id]);
});

test('mixed intake preserves unreadable and unsupported Word originals while saving readable files in the selected case', async () => {
  const state = applyAction(createEmptyWorkspace('mixed-word'), { type: 'create_case', title: 'Word batch' }, actor);
  const fixture = reset(state);
  const damaged = new Uint8Array(512); damaged.set([208, 207, 17, 224, 161, 177, 26, 225]);
  const rtf = new TextEncoder().encode('{\\rtf1 Unsupported renamed RTF source}');
  const files = [
    { name: 'invoice.doc', bytes: wordOriginal },
    { name: 'damaged.doc', bytes: damaged },
    { name: 'renamed.doc', bytes: rtf },
    { name: 'packing.txt', bytes: new TextEncoder().encode('Packing list: TEST-PACKING') },
  ];
  assert.equal((await sendOriginals(files, { targetCaseId: state.cases[0].id })).status, 200);
  const saved = fixture.context.state;
  assert.equal(saved.cases.length, 1);
  assert.equal(saved.documents.length, 4);
  assert.equal(fixture.originals.size, 4);
  for (const source of saved.documents) {
    assert.equal(source.caseId, state.cases[0].id);
    assert.deepEqual(fixture.originals.get(source.blobKey!), files.find(file => file.name === source.name)!.bytes);
  }
  const damagedSource = saved.documents.find(source => source.name === 'damaged.doc')!;
  assert.equal(damagedSource.extractionStatus, 'failed');
  assert.deepEqual(damagedSource.pages, []);
  assert.match(damagedSource.extractionError!, /PDF/);
  const unsupportedSource = saved.documents.find(source => source.name === 'renamed.doc')!;
  assert.equal(unsupportedSource.extractionStatus, 'unsupported');
  assert.deepEqual(unsupportedSource.pages, []);
  assert.match(unsupportedSource.extractionError!, /PDF/);
  assert.deepEqual(automaticDocuments(saved).map(source => source.name).sort(), ['invoice.doc', 'packing.txt']);
});

test('Word email attachments use the same server extraction and preserve original attachment and email bytes', async () => {
  const fixture = reset();
  const raw = [
    'From: sender@example.invalid', 'Subject: Word invoice', 'Message-ID: <word-invoice@example.invalid>', 'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="word-boundary"', '', '--word-boundary',
    'Content-Type: application/msword; name="invoice.doc"', 'Content-Disposition: attachment; filename="invoice.doc"',
    'Content-Transfer-Encoding: base64', '', Buffer.from(wordOriginal).toString('base64'), '--word-boundary--', '',
  ].join('\r\n');
  const bytes = new TextEncoder().encode(raw);
  const response = await sendOriginals([{ name: 'invoice.eml', bytes, mime: 'message/rfc822' }], {
    metadata: [{ name: 'invoice.eml', pages: [], extractionStatus: 'extracted', attachments: [{ name: 'invoice.doc', index: 0, pages: [{ page: 1, text: 'ATTACHMENT-CLIENT-FAKE', textSource: 'office' }], extractionStatus: 'extracted' }] }],
  });
  assert.equal(response.status, 200);
  const { documents, emails, candidates } = fixture.context.state;
  assert.equal(documents.length, 1); assert.equal(emails.length, 1);
  const document = documents[0];
  assert.equal(document.sourceEmailId, emails[0].id);
  assert.deepEqual(emails[0].documentIds, [document.id]);
  assert.equal(document.extractionStatus, 'pending_ai');
  assert.match(document.pages.map(page => page.text).join('\n'), /TEST-DOC-2026/);
  assert.ok(!JSON.stringify(document).includes('ATTACHMENT-CLIENT-FAKE'));
  assert.equal(document.sha256, createHash('sha256').update(wordOriginal).digest('hex'));
  assert.deepEqual(fixture.originals.get(document.blobKey!), wordOriginal);
  assert.deepEqual(fixture.originals.get(emails[0].blobKey!), bytes);
  assert.deepEqual(candidates, []);
});

test('replacing a document with Word keeps the case and previous original while preparing the new version', async () => {
  const fixture = reset();
  await sendFiles([{ name: 'old.txt', text: 'Previous source text' }]);
  const previous = structuredClone(fixture.context.state.documents[0]);
  const oldOriginal = fixture.originals.get(previous.blobKey!);
  assert.equal((await sendOriginals([{ name: 'replacement.doc', bytes: wordOriginal }], { documentId: previous.id })).status, 200);
  const state = fixture.context.state;
  assert.equal(state.cases.length, 1);
  assert.equal(state.documents.length, 2);
  assert.equal(state.documents.find(source => source.id === previous.id)!.active, false);
  const replacement = state.documents.find(source => source.active)!;
  assert.equal(replacement.caseId, previous.caseId);
  assert.equal(replacement.replacesId, previous.id);
  assert.equal(replacement.version, previous.version + 1);
  assert.equal(replacement.extractionStatus, 'pending_ai');
  assert.match(replacement.pages.map(page => page.text).join('\n'), /TEST-DOC-2026/);
  assert.deepEqual(fixture.originals.get(previous.blobKey!), oldOriginal);
  assert.deepEqual(fixture.originals.get(replacement.blobKey!), wordOriginal);
});

test('multipart batch uploads attach every original to the selected case before AI reads them', async () => {
  const state = applyAction(createEmptyWorkspace('selected-upload'), { type: 'create_case', title: 'Chosen export', caseType: 'export' }, actor);
  const fixture = reset(state); const caseId = state.cases[0].id;
  const files = [
    { name: 'invoice.txt', text: 'Invoice Number: INV-A' },
    { name: 'packing.txt', text: 'Packing List: PKG-A' },
    { name: 'bill.txt', text: 'Bill of lading: BILL-A' },
  ];
  assert.equal((await sendFiles(files, caseId)).status, 200);
  assert.equal(fixture.context.state.cases.length, 1);
  assert.equal(fixture.context.state.cases[0].caseType, 'export');
  assert.equal(fixture.context.state.documents.length, 3);
  assert.equal(fixture.originals.size, 3);
  assert.ok(fixture.context.state.documents.every(document => document.caseId === caseId && document.extractionStatus === 'pending_ai'));
});

test('a duplicate in another case stays there and its existing location is reported alongside a new targeted original', async () => {
  const fixture = reset(); const original = { name: 'invoice.txt', text: 'Invoice Number: INV-A' };
  await sendFiles([original]);
  const first = structuredClone(fixture.context.state.cases[0]);
  const existing = structuredClone(fixture.context.state.documents[0]);
  fixture.context.state = applyAction(fixture.context.state, { type: 'create_case', title: 'Second case' }, actor);
  const targetId = fixture.context.state.cases[1].id;
  const result = await sendFiles([original, { name: 'packing.txt', text: 'Packing List: PKG-A' }], targetId);
  const body = await result.json() as { notice: string };
  assert.match(body.notice, /invoice\.txt/);
  assert.ok(body.notice.includes(first.reference));
  assert.ok(body.notice.includes(first.title));
  assert.equal(fixture.context.state.documents.length, 2);
  assert.equal(fixture.originals.size, 2);
  assert.deepEqual(fixture.context.state.documents.find(document => document.id === existing.id), existing);
  assert.equal(fixture.context.state.documents.find(document => document.name === 'packing.txt')!.caseId, targetId);
});

test('upload to a completed or absent destination rejects the whole batch before storing originals', async () => {
  const state = applyAction(createEmptyWorkspace('closed-upload'), { type: 'create_case', title: 'Closed case' }, actor);
  state.cases[0].status = 'completed';
  const fixture = reset(state);
  for (const caseId of [state.cases[0].id, 'case-missing']) {
    await assert.rejects(() => sendFiles([{ name: 'invoice.txt', text: 'Invoice Number: INV-A' }], caseId), /Open shipment case not found/);
    assert.equal(fixture.originals.size, 0);
    assert.equal(fixture.context.state.documents.length, 0);
  }
});
