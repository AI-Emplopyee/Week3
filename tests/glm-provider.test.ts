import test from 'node:test';
import assert from 'node:assert/strict';
import { documentAiConfiguration, ZAI_ENDPOINT } from '../lib/ai-provider.ts';
import { extractWithKimi, KimiError, kimiStatus } from '../lib/kimi.ts';
import { createEmptyWorkspace } from '../lib/engine.ts';
import { planEmailShipmentMatches } from '../lib/email-shipment-ai.ts';
import type { ShipmentDocument } from '../lib/types.ts';

const config = documentAiConfiguration({ ZAI_API_KEY: 'synthetic-glm-secret' });
const source: ShipmentDocument = {
  id: 'glm-doc', caseId: 'glm-case', name: 'original.pdf', mime: 'application/pdf', size: 100,
  sha256: 'a'.repeat(64), version: 1, active: true, uploadedAt: '', synthetic: true, type: 'invoice',
  extractionPipeline: 'kimi', extractionStatus: 'pending_ai',
  pages: [{ page: 1, text: 'OLD TEXT MUST NOT BE SENT' }],
};
const image = {
  page: 1, imageSha256: 'b'.repeat(64), width: 100, height: 200,
  bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 200, 0, 100, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xd9]),
};
const reading = {
  pageReadings: [{ page: 1, documentType: 'invoice', readability: 'clear' }],
  candidates: [{ field: 'invoiceNumber', value: 'INV-100', quote: 'Invoice No: INV-100', page: 1, confidence: 'high', evidence: 'vision', bounds: { left: .1, top: .1, right: .5, bottom: .2 } }],
};
const reply = (content: unknown, reasoning = 'private synthetic provider continuation') => Response.json({
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content), reasoning_content: reasoning } }],
});

test('live configuration chooses GLM exclusively and fails closed without its key or with a wrong model', () => {
  const legacyOnly = { MOONSHOT_API_KEY: 'unused', MOONSHOT_MODEL: 'kimi-k2.6' };
  const unavailable = documentAiConfiguration({ ...legacyOnly, ZAI_API_KEY: undefined });
  assert.equal(kimiStatus(unavailable).configured, false);
  assert.deepEqual(kimiStatus(unavailable).missing, ['ZAI_API_KEY']);
  assert.equal(kimiStatus(config).provider, 'Z.ai');
  assert.equal(kimiStatus(config).model, 'glm-5.3-flash');
  assert.equal(kimiStatus(config).visionSupported, true);
  assert.equal(kimiStatus(documentAiConfiguration({ ZAI_API_KEY: 'test', ZAI_MODEL: 'kimi-k2.6' })).configured, false);
  assert.ok(!JSON.stringify(kimiStatus(config)).includes(config.apiKey!));
});

test('GLM uses fixed Z.ai endpoint and original images; repair retains private continuation without exposing it', async () => {
  let calls = 0;
  const result = await extractWithKimi(config, source, [1], {
    images: [image],
    fetch: async (url, init) => {
      calls++;
      assert.equal(url, `${ZAI_ENDPOINT}/chat/completions`);
      assert.equal(init?.redirect, 'manual');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, 'glm-5.3-flash');
      assert.equal(body.reasoning_effort, 'low');
      assert.deepEqual(body.thinking, { type: 'enabled', clear_thinking: false });
      assert.ok(!String(init?.body).includes(source.pages[0].text));
      assert.ok(body.messages[1].content.some((part: { type: string }) => part.type === 'image_url'));
      if (calls === 1) return reply({ bad: true });
      assert.equal(body.messages.at(-2).reasoning_content, 'private synthetic provider continuation');
      return reply(reading);
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.model, 'glm-5.3-flash');
  assert.equal(result.candidates[0].value, 'INV-100');
  assert.ok(!JSON.stringify(result).includes('private synthetic provider continuation'));
});

test('GLM failures report only the HTTP status without automatic retry or Moonshot fallback', async () => {
  for (const status of [401, 429, 500]) {
    let calls = 0;
    let cancelled = false;
    await assert.rejects(extractWithKimi(config, source, [1], { images: [image], fetch: async (url) => {
      calls++; assert.equal(url, `${ZAI_ENDPOINT}/chat/completions`);
      return new Response(new ReadableStream({
        cancel() { cancelled = true; throw new Error('private provider cancellation detail'); },
      }), { status });
    } }), error => error instanceof KimiError && error.status === 502
      && error.message.includes(`HTTP ${status}`) && !error.message.includes('private'));
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
  }
});

test('email matching also uses GLM and the fixed Z.ai endpoint', async () => {
  const state = createEmptyWorkspace('glm-email-tests');
  state.documents.push({ ...source, extractionPipeline: undefined, pages: [{ page: 1, text: 'Invoice Number: INV-100' }] });
  state.cases.push({
    id: source.caseId, reference: 'TEST', title: 'Test', status: 'review', caseType: 'import', assignedTo: '',
    createdAt: '', updatedAt: '', documentIds: [source.id], fields: {}, goods: [], groupingConfidence: 'high',
    groupingReason: '', groupingConfirmed: true, synthetic: true, resolutions: [],
  });
  state.emails.push({ id: 'email-1', messageId: '<test@example.invalid>', sender: 'test@example.invalid', subject: 'Invoice Number: INV-100', receivedAt: '', originalName: 'test.eml', documentIds: [source.id], sha256: 'c'.repeat(64) });
  let calls = 0;
  const result = await planEmailShipmentMatches(config, state, ['email-1'], { fetch: async (url, init) => {
    calls++; assert.equal(url, `${ZAI_ENDPOINT}/chat/completions`);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'glm-5.3-flash'); assert.equal(body.reasoning_effort, 'low');
    return reply({ matches: [] });
  } });
  assert.equal(calls, 1); assert.equal(result.model, 'glm-5.3-flash');
});
