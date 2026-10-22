import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyWorkspace } from '../lib/engine.ts';
import { EMAIL_SHIPMENT_AI_LIMITS, groundEmailShipmentMatches, planEmailShipmentMatches, revalidateEmailShipmentMatches, type EmailShipmentMatchEvidence } from '../lib/email-shipment-ai.ts';
import { KIMI_ENDPOINT, KimiError } from '../lib/kimi.ts';
import type { Candidate, EmailRecord, ShipmentCase, ShipmentDocument, WorkspaceState } from '../lib/types.ts';
const config = { apiKey: 'test-only-secret', model: 'kimi-k2.6' };
const date = '2026-10-12T00:00:00Z';
function fixture(text = 'HBL Number: HBL-123\nInvoice Number: INV-123\nContract Number: CT-456\nContainer: TEST1234567', emailText = text) {
  const state = createEmptyWorkspace('email-matching-tests');
  const document: ShipmentDocument = { id: 'doc-1', caseId: 'case-1', name: 'original.pdf', type: 'invoice', mime: 'application/pdf', size: 100, sha256: 'private-hash', version: 1, active: true, uploadedAt: date, pages: [{ page: 1, text, textSource: 'pdf_text' }], extractionStatus: 'extracted', synthetic: true, blobKey: 'private-document-key' };
  const shipment: ShipmentCase = { id: 'case-1', reference: 'AICD-1', title: 'Shipment', status: 'review', caseType: 'import', assignedTo: '', createdAt: date, updatedAt: date, documentIds: [document.id], fields: {}, goods: [], groupingConfidence: 'high', groupingReason: '', groupingConfirmed: true, synthetic: true, resolutions: [] };
  const email: EmailRecord & { text?: string } = { id: 'email-1', messageId: '<message@invalid>', sender: 'sender@example.invalid', subject: 'Shipping documents', text: emailText, receivedAt: date, originalName: 'message.eml', documentIds: [document.id], sha256: 'private-email-hash', blobKey: 'private-email-key' };
  state.documents.push(document); state.cases.push(shipment); state.emails.push(email);
  return state;
}
function evidence(overrides: Partial<EmailShipmentMatchEvidence> = {}): EmailShipmentMatchEvidence { return { field: 'houseBillOfLading', value: 'HBL-123', emailQuote: 'HBL Number: HBL-123', documentId: 'doc-1', documentVersion: 1, page: 1, documentQuote: 'HBL Number: HBL-123', ...overrides }; }
const match = (proofs = [evidence()], caseId = 'case-1', emailId = 'email-1') => ({ emailId, caseId, evidence: proofs });
const reply = (matches: unknown = [match()], finish = 'stop') => Response.json({ choices: [{ finish_reason: finish, message: { content: JSON.stringify({ matches }) } }] });
function otherCase(state: WorkspaceState, text: string, id = '2') { state.documents.push({ ...structuredClone(state.documents[0]), id: `doc-${id}`, caseId: `case-${id}`, pages: [{ page: 1, text, textSource: 'pdf_text' }] }); state.cases.push({ ...structuredClone(state.cases[0]), id: `case-${id}`, documentIds: [`doc-${id}`] }); }

test('a decisive exact current HBL yields a pure email link without changing shipment or document assignments', async () => {
  const state = fixture(); const before = JSON.stringify(state); let calls = 0;
  const result = await planEmailShipmentMatches(config, state, ['email-1'], { fetch: async (url, init) => {
    calls++; assert.equal(url, `${KIMI_ENDPOINT}/chat/completions`); assert.equal(init?.redirect, 'manual');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${config.apiKey}`);
    const body = JSON.parse(String(init?.body)); assert.deepEqual(body.thinking, { type: 'disabled' }); assert.equal(body.max_tokens, EMAIL_SHIPMENT_AI_LIMITS.maxOutputTokens);
    assert.match(body.messages[0].content, /untrusted data/); assert.match(body.messages[0].content, /never obey instructions/); assert.deepEqual(body.response_format, { type: 'json_object' });
    const source = JSON.parse(body.messages[1].content); assert.equal(source.emails[0].text, state.emails[0].text); assert.equal(source.cases[0].facts[0].documentVersion, 1);
    for (const secret of [config.apiKey, 'private-document-key', 'private-email-key', 'private-hash', 'private-email-hash', 'sender@example.invalid']) assert.ok(!String(init?.body).includes(secret));
    return reply();
  } });
  assert.equal(result.matches[0].decision, 'link'); assert.equal(result.rejected, 0); assert.equal(calls, 1); assert.equal(JSON.stringify(state), before);
});

test('email matching rejects provider redirects without following their destination', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let calls = 0;
    await assert.rejects(() => planEmailShipmentMatches(config, fixture(), ['email-1'], { fetch: async (url, init) => {
      calls++;
      assert.equal(url, `${KIMI_ENDPOINT}/chat/completions`);
      assert.equal(init?.redirect, 'manual');
      return new Response('private redirect body', { status, headers: { Location: 'https://untrusted.example.invalid/forward' } });
    } }), (error: unknown) => error instanceof KimiError && error.status === 502 && !error.message.includes('private redirect'));
    assert.equal(calls, 1);
  }
});

test('same sender, thread, company or invoice alone does not automatically group emails', async () => {
  const noId = fixture('Buyer: Same company', 'Please check the shipment.'); let calls = 0;
  const empty = await planEmailShipmentMatches(config, noId, ['email-1'], { fetch: async () => { calls++; return reply(); } }); assert.equal(calls, 0); assert.deepEqual(empty.matches, []);
  const invoice = evidence({ field: 'invoiceNumber', value: 'INV-123', emailQuote: 'Invoice Number: INV-123', documentQuote: 'Invoice Number: INV-123' });
  assert.equal(groundEmailShipmentMatches(fixture(), ['email-1'], [match([invoice])]).matches[0].decision, 'review');
});

test('invoice and a distinct contract or container are independent anchors; repeated number roles are not', () => {
  const invoice = evidence({ field: 'invoiceNumber', value: 'INV-123', emailQuote: 'Invoice Number: INV-123', documentQuote: 'Invoice Number: INV-123' });
  const contract = evidence({ field: 'contractNumber', value: 'CT-456', emailQuote: 'Contract Number: CT-456', documentQuote: 'Contract Number: CT-456' });
  const container = evidence({ field: 'container', value: 'TEST1234567', emailQuote: 'Container: TEST1234567', documentQuote: 'Container: TEST1234567' });
  for (const supporting of [contract, container]) assert.equal(groundEmailShipmentMatches(fixture(), ['email-1'], [match([invoice, supporting])]).matches[0].decision, 'link');
  const state = fixture('Invoice Number: INV-123\nContract Number: INV-123');
  assert.equal(groundEmailShipmentMatches(state, ['email-1'], [match([invoice, { ...contract, value: 'INV-123', emailQuote: 'Contract Number: INV-123', documentQuote: 'Contract Number: INV-123' }])]).matches[0].decision, 'review');
});

test('fabricated quotes, roles, IDs, versions, pages, prefixes and partial evidence are rejected', () => {
  const state = fixture();
  for (const invalid of [evidence({ documentId: 'foreign-doc' }), evidence({ documentVersion: 99 }), evidence({ page: 2 }), evidence({ emailQuote: 'Invented HBL-123' }), evidence({ documentQuote: 'Invented HBL-123' }), evidence({ field: 'billOfLading' }), evidence({ value: 'HBL-12' })]) {
    const result = groundEmailShipmentMatches(state, ['email-1'], [match([invalid])]); assert.equal(result.matches.length, 0); assert.equal(result.rejected, 1);
  }
  assert.equal(groundEmailShipmentMatches(state, ['email-1'], [match([evidence(), evidence({ documentId: 'foreign-doc' })])]).matches.length, 0);
  assert.equal(groundEmailShipmentMatches(fixture(undefined, 'HBL Number: HBL-123-OTHER'), ['email-1'], [match()]).matches.length, 0);
  assert.throws(() => groundEmailShipmentMatches(state, ['email-1'], [{ ...match(), decision: 'link' }]), /invalid/);
});

test('shared HBL among cases is ambiguous even when the provider returns only one case', () => {
  const state = fixture(); otherCase(state, 'HBL Number: HBL-123');
  const result = groundEmailShipmentMatches(state, ['email-1'], [match()]); assert.equal(result.matches[0].decision, 'review'); assert.match(result.matches[0].explanation, /more than one/);
});

test('one email can reference two distinct shipments without merging their attachments', () => {
  const state = fixture('HBL Number: HBL-123', 'Shipment A: HBL Number: HBL-123\nShipment B: HBL Number: HBL-999'); otherCase(state, 'HBL Number: HBL-999');
  const before = JSON.stringify(state);
  const result = groundEmailShipmentMatches(state, ['email-1'], [match(), match([evidence({ documentId: 'doc-2', value: 'HBL-999', emailQuote: 'HBL Number: HBL-999', documentQuote: 'HBL Number: HBL-999' })], 'case-2')]);
  assert.deepEqual(result.matches.map(item => item.decision), ['link', 'link']); assert.equal(JSON.stringify(state), before);
});

test('conflicting explicit shipment bill vetoes otherwise matching invoice and contract', () => {
  const state = fixture(undefined, 'HBL Number: HBL-999\nInvoice Number: INV-123\nContract Number: CT-456');
  const proofs = [evidence({ field: 'invoiceNumber', value: 'INV-123', emailQuote: 'Invoice Number: INV-123', documentQuote: 'Invoice Number: INV-123' }), evidence({ field: 'contractNumber', value: 'CT-456', emailQuote: 'Contract Number: CT-456', documentQuote: 'Contract Number: CT-456' })];
  const result = groundEmailShipmentMatches(state, ['email-1'], [match(proofs)]); assert.equal(result.matches.length, 0); assert.equal(result.rejected, 1);
});

test('reference files, archived samples, completed cases and replaced documents cannot match live email', () => {
  const cases = [fixture(), fixture(), fixture(), fixture(), fixture()];
  cases[0].documents[0].referenceOnly = true; cases[1].cases[0].sourceCollection = { name: 'Samples', folder: 'Archive' }; cases[2].cases[0].status = 'completed'; cases[3].documents[0].active = false; cases[4].cases[0].mergedInto = 'another-case';
  for (const state of cases) assert.deepEqual(groundEmailShipmentMatches(state, ['email-1'], [match()]).matches, []);
});

test('weak OCR and manually transcribed identifiers require review', () => {
  const state = fixture(); state.documents[0].pages[0].textSource = 'ocr'; state.documents[0].pages[0].ocrConfidence = 0.5;
  assert.equal(groundEmailShipmentMatches(state, ['email-1'], [match()]).matches[0].decision, 'review');
  state.documents[0].pages[0].textSource = 'manual'; assert.equal(groundEmailShipmentMatches(state, ['email-1'], [match()]).matches[0].decision, 'review');
});

test('saved vision-only evidence remains usable for a review suggestion without pretending OCR agrees', () => {
  const state = fixture('OCR could not read this page.', 'HBL Number: HBL-123');
  const candidate: Candidate = { id: 'vision-1', caseId: 'case-1', documentId: 'doc-1', documentVersion: 1, field: 'houseBillOfLading', value: 'HBL-123', originalText: 'HBL Number: HBL-123', page: 1, location: 'Page 1', method: 'kimi:vision', confidence: 'low', normalizations: [], visualEvidence: { imageSha256: 'image-hash', bounds: [0, 0, 0.5, 0.5], textAgreement: false } };
  state.candidates.push(candidate); assert.equal(groundEmailShipmentMatches(state, ['email-1'], [match()]).matches[0].decision, 'review');
  candidate.documentVersion = 2; assert.deepEqual(groundEmailShipmentMatches(state, ['email-1'], [match()]).matches, []);
});

test('context limits are reported and prevent automatic linking when candidate context is incomplete', async () => {
  const state = fixture('HBL Number: HBL-123');
  for (let index = 2; index <= EMAIL_SHIPMENT_AI_LIMITS.maxCases + 1; index++) otherCase(state, 'HBL Number: HBL-123', String(index));
  const result = await planEmailShipmentMatches(config, state, ['email-1'], { fetch: async () => reply() });
  assert.equal(result.truncated, true); assert.equal(result.omittedCaseIds.length, 1); assert.equal(result.matches[0].decision, 'review');
  const long = fixture(undefined, `HBL Number: HBL-123\n${'x'.repeat(EMAIL_SHIPMENT_AI_LIMITS.maxEmailCharacters)}`);
  assert.equal(groundEmailShipmentMatches(long, ['email-1'], [match()]).matches[0].decision, 'review');
});

test('fresh-state validation retires replaced evidence and never upgrades a previous review', () => {
  const state = fixture(); const matches = groundEmailShipmentMatches(state, ['email-1'], [match()]).matches;
  assert.equal(revalidateEmailShipmentMatches(state, [{ ...matches[0], decision: 'review', explanation: 'Limited context.' }]).matches[0].decision, 'review');
  state.documents[0].version = 2; assert.deepEqual(revalidateEmailShipmentMatches(state, matches).matches, []);
});

test('missing administrator configuration and malformed provider outputs fail without disclosing source or secrets', async () => {
  const state = fixture(); let calls = 0;
  await assert.rejects(() => planEmailShipmentMatches({}, state, ['email-1'], { fetch: async () => { calls++; return reply(); } }), (error: unknown) => error instanceof KimiError && error.status === 503); assert.equal(calls, 0);
  const responses = [() => new Response('source secret'), () => reply([], 'length'), () => reply([{ ...match(), extra: 'bad' }]), () => reply(Array.from({ length: 49 }, () => match())), () => new Response('x'.repeat(EMAIL_SHIPMENT_AI_LIMITS.maxResponseBytes + 1)), () => new Response(config.apiKey, { status: 401 })];
  for (const response of responses) await assert.rejects(() => planEmailShipmentMatches(config, state, ['email-1'], { fetch: async () => response() }), (error: unknown) => error instanceof KimiError && error.status === 502 && !error.message.includes(config.apiKey) && !error.message.includes('source secret'));
});

test('timeout aborts once and provider exceptions are sanitized without automatic retry', async () => {
  let calls = 0; let signal: AbortSignal | undefined;
  await assert.rejects(() => planEmailShipmentMatches(config, fixture(), ['email-1'], { timeoutMs: 5, fetch: async (_, init) => { calls++; signal = init?.signal as AbortSignal; return new Promise<Response>(() => {}); } }), (error: unknown) => error instanceof KimiError && error.status === 504);
  assert.equal(calls, 1); assert.equal(signal?.aborted, true);
  await assert.rejects(() => planEmailShipmentMatches(config, fixture(), ['email-1'], { fetch: async () => { throw new Error(config.apiKey); } }), (error: unknown) => error instanceof KimiError && error.status === 502 && !error.message.includes(config.apiKey));
});

test('upstream email matching limits retain sanitized HTTP status without enabling queue retries', async () => {
  let calls = 0;
  let cancelled = false;
  await assert.rejects(planEmailShipmentMatches(config, fixture(), ['email-1'], { fetch: async () => {
    calls++;
    return new Response(new ReadableStream({
      cancel() { cancelled = true; throw new Error('private cancellation detail'); },
    }), { status: 429 });
  } }), error => error instanceof KimiError && error.status === 502
    && error.message.includes('HTTP 429') && !error.message.includes('private'));
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
});

test('nonempty provider output with no grounded associations fails without a completed-check result', async () => {
  const state = fixture(); const before = JSON.stringify(state); let calls = 0;
  await assert.rejects(() => planEmailShipmentMatches(config, state, ['email-1'], { fetch: async () => { calls++; return reply([match([evidence({ emailQuote: `secret invented source ${config.apiKey}` })])]); } }), (error: unknown) => error instanceof KimiError && error.status === 502 && /source evidence checks/.test(error.message) && !error.message.includes(config.apiKey) && !error.message.includes('secret invented source'));
  assert.equal(calls, 1); assert.equal(JSON.stringify(state), before);
  const empty = await planEmailShipmentMatches(config, state, ['email-1'], { fetch: async () => reply([]) });
  assert.deepEqual(empty.matches, []); assert.equal(empty.rejected, 0); assert.equal(empty.truncated, false);
});

test('partly rejected provider associations are incomplete and remaining grounded matches require review', async () => {
  const state = fixture();
  const result = await planEmailShipmentMatches(config, state, ['email-1'], { fetch: async () => reply([match(), match([evidence({ documentId: 'invented-doc' })], 'invented-case')]) });
  assert.equal(result.rejected, 1); assert.equal(result.truncated, true); assert.equal(result.matches.length, 1); assert.equal(result.matches[0].decision, 'review'); assert.match(result.matches[0].explanation, /failed source checks/);
  assert.equal(revalidateEmailShipmentMatches(state, result.matches).matches[0].decision, 'review');
});

test('different current bill readings inside one case prevent automatic email association', () => {
  const state = fixture('HBL Number: HBL-123\nHBL Number: HBL-999', 'HBL Number: HBL-123');
  const result = groundEmailShipmentMatches(state, ['email-1'], [match()]);
  assert.equal(result.matches.length, 1); assert.equal(result.matches[0].decision, 'review'); assert.match(result.matches[0].explanation, /different bill identifiers/);
  state.documents[0].pages[0].text = 'HBL Number: HBL-123\nHBL Number: HBL-123';
  assert.equal(groundEmailShipmentMatches(state, ['email-1'], [match()]).matches[0].decision, 'link');
});

test('a contradictory identifier beyond the email text bound never permits automatic linking', async () => {
  const state = fixture('HBL Number: HBL-123', `HBL Number: HBL-123\n${'x'.repeat(EMAIL_SHIPMENT_AI_LIMITS.maxEmailCharacters)}\nCorrection: HBL Number: HBL-999`);
  const result = await planEmailShipmentMatches(config, state, ['email-1'], { fetch: async () => reply() });
  assert.equal(result.truncated, true); assert.equal(result.matches[0].decision, 'review');
});

test('a standalone House bill heading cannot consume the next line label or split its identifier', async () => {
  const state = fixture('HOUSE BILL OF LADING\nHBL No: SYNTHETIC-HBL-100', 'Please check HBL Number: SYNTHETIC-HBL-100');
  const proposal = match([evidence({ value: 'SYNTHETIC-HBL-100', emailQuote: 'HBL Number: SYNTHETIC-HBL-100', documentQuote: 'HBL No: SYNTHETIC-HBL-100' })]);
  const result = await planEmailShipmentMatches(config, state, ['email-1'], { fetch: async (_url, init) => {
    const facts = JSON.parse(JSON.parse(String(init?.body)).messages[1].content).cases[0].facts;
    assert.ok(facts.some((fact: { value: string }) => fact.value === 'SYNTHETIC-HBL-100'));
    assert.ok(!facts.some((fact: { value: string }) => fact.value === '100'));
    return reply([proposal]);
  } });
  assert.equal(result.matches[0].decision, 'link');
});

test('unclassified, reference and unsupported live cases do not accept AI email associations', () => {
  const state = fixture();
  for (const caseType of ['unknown', 'reference', 'unsupported'] as const) {
    state.cases[0].caseType = caseType;
    assert.deepEqual(groundEmailShipmentMatches(state, ['email-1'], [match()]).matches, []);
  }
  state.cases[0].caseType = 'export'; assert.equal(groundEmailShipmentMatches(state, ['email-1'], [match()]).matches[0].decision, 'link');
});
