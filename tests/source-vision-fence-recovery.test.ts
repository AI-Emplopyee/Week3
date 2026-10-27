import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverExactFence } from '../scripts/recover-source-vision-fences.mjs';

function fixture() {
  const model = { id: 'synthetic-model', canonical_slug: 'synthetic-model' };
  const job = { page: 2, packetId: 'synthetic-case', sourceSha256: 'a'.repeat(64), inputImageSha256: 'b'.repeat(64), width: 1000, height: 1200 };
  const value = { pageReadings: [{ page: 2, documentType: 'air_waybill', readability: 'clear' }], candidates: [
    { field: 'importerTelephone', value: '+840839102875', quote: 'Phone: +840839102875', page: 2, confidence: 'high', readability: 'clear', evidence: 'vision', bounds: { left: .1, top: .1, right: .4, bottom: .2 } },
  ] };
  const envelope = { model: model.id, choices: [{ finish_reason: 'stop', message: { content: `\`\`\`json\n${JSON.stringify(value)}\n\`\`\`` } }] };
  return { model, job, value, envelope };
}

test('exact fence recovery preserves every field value and leaves the original response unchanged', () => {
  const { model, job, value, envelope } = fixture(), original = structuredClone(envelope);
  const recovered = recoverExactFence(envelope, model, job);
  assert.ok(recovered);
  assert.equal(recovered.result.proposals[0].value, value.candidates[0].value);
  assert.equal(recovered.result.proposals[0].quote, value.candidates[0].quote);
  assert.equal(recovered.result.proposals[0].page, 2);
  assert.equal(recovered.result.rejected, 0);
  assert.deepEqual(envelope, original);
  assert.notEqual(recovered.originalContentSha256, recovered.unfencedContentSha256);
});

test('no prose stripping, malformed JSON repair or invalid-schema recovery is allowed', () => {
  const { model, job, value, envelope } = fixture();
  assert.equal(recoverExactFence({ ...envelope, choices: [{ finish_reason: 'stop', message: { content: `Here is the JSON:\n${envelope.choices[0].message.content}` } }] }, model, job), undefined);
  assert.equal(recoverExactFence({ ...envelope, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }, model, job), undefined);
  assert.throws(() => recoverExactFence({ ...envelope, choices: [{ finish_reason: 'stop', message: { content: '```json\n{"candidates":\n```' } }] }, model, job));
  assert.throws(() => recoverExactFence({ ...envelope, choices: [{ finish_reason: 'stop', message: { content: '```json\n{"candidates":[],"pageReadings":[]}\n```' } }] }, model, job));
});

test('model identity, complete response and original page checks remain mandatory', () => {
  const { model, job, envelope } = fixture();
  assert.throws(() => recoverExactFence({ ...envelope, model: 'different' }, model, job));
  assert.throws(() => recoverExactFence({ ...envelope, choices: [{ ...envelope.choices[0], finish_reason: 'length' }] }, model, job));
  assert.throws(() => recoverExactFence(envelope, model, { ...job, page: 1 }));
});
