import assert from 'node:assert/strict';
import test from 'node:test';
import { AiResponseSizeError, readBoundedAiResponse } from '../lib/ai-provider.ts';

test('bounded AI responses cancel oversized advertised bodies without reading source content', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() { cancelled = true; },
  });
  await assert.rejects(
    readBoundedAiResponse(new Response(body, { headers: { 'content-length': '11' } }), 10),
    AiResponseSizeError,
  );
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test('streamed AI responses enforce actual bytes despite a false size header and release the reader', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('private source')); },
    cancel() { cancelled = true; throw new Error('private cancellation detail'); },
  });
  await assert.rejects(
    readBoundedAiResponse(new Response(body, { headers: { 'content-length': '1' } }), 10),
    error => error instanceof AiResponseSizeError && !error.message.includes('private'),
  );
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test('bounded AI response decoding preserves UTF-8 across chunks and rejects empty bodies', async () => {
  const bytes = new TextEncoder().encode('Tờ khai');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 2));
      controller.enqueue(bytes.slice(2));
      controller.close();
    },
  });
  assert.equal(await readBoundedAiResponse(new Response(body), bytes.length), 'Tờ khai');
  assert.equal(body.locked, false);
  await assert.rejects(readBoundedAiResponse(new Response(null), 10), AiResponseSizeError);
  await assert.rejects(readBoundedAiResponse(new Response(''), 10), AiResponseSizeError);
});
