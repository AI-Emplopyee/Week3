import test from 'node:test';
import assert from 'node:assert/strict';
import { authAvailability, callbackParameters, passwordValidation } from '../lib/account-validation.ts';
import { buildAiBatches } from '../lib/client-vision.ts';
import { fetchWithSession } from '../lib/auth-client.ts';
import { translate, translateSystemText, auditActionLabel } from '../lib/i18n-core.ts';

const token = 'a_valid_invitation_hash_123';
const limits = { maxPages: 5, maxTextCharacters: 24000, maxCandidates: 100 };

test('only configured email deployments offer password sign-in; partial config shows setup', () => {
  assert.equal(authAvailability({ mode: 'supabase', configured: false }), 'unconfigured');
  assert.equal(authAvailability({ mode: 'unconfigured', configured: false }), 'unconfigured');
  assert.equal(authAvailability({ mode: 'supabase', configured: true }), 'supabase');
});

test('account callbacks accept fragment-only invite/recovery links and strict token bounds', () => {
  assert.deepEqual(callbackParameters(`#token_hash=${token}&type=invite`), { tokenHash: token, type: 'invite', valid: true });
  assert.equal(callbackParameters(`#token_hash=${token}&type=recovery`).valid, true);
  for (const fragment of [`?token_hash=${token}&type=invite`, `#token_hash=${token}&type=signup`, `#token_hash=${token}&type=invite&type=recovery`, `#token_hash=${token}&token_hash=${token}&type=invite`, `#token_hash=${'a'.repeat(19)}&type=invite`, `#token_hash=${'a'.repeat(257)}&type=invite`, '#token_hash=invalid%2Btoken%2Fhash_here&type=invite', '']) {
    const result = callbackParameters(fragment); assert.equal(result.valid, false, fragment); assert.equal(result.tokenHash, '', 'invalid secrets are discarded');
  }
  assert.equal(callbackParameters(`#token_hash=${'a'.repeat(20)}&type=invite`).valid, true);
  assert.equal(callbackParameters(`#token_hash=${'a'.repeat(256)}&type=invite`).valid, true);
});

test('password checks preserve whitespace and require exact confirmation within server limits', () => {
  assert.equal(passwordValidation('a'.repeat(11), 'a'.repeat(11)), 'Mật khẩu phải có từ 12 đến 128 ký tự.');
  assert.equal(passwordValidation('a'.repeat(129), 'a'.repeat(129)), 'Mật khẩu phải có từ 12 đến 128 ký tự.');
  assert.equal(passwordValidation(' leading space ', 'leading space'), 'Mật khẩu nhập lại chưa khớp.');
  assert.equal(passwordValidation(' leading space ', ' leading space '), undefined);
  assert.equal(passwordValidation('a'.repeat(128), 'a'.repeat(128)), undefined);
});

test('AI batches select only requested pages and preserve stored text', () => {
  const pages = [{ page: 3, text: 'Invoice: 12.450,50 USD\n quoted facts\n' }, { page: 1, text: 'Page one text' }, { page: 2, text: 'PRIVATE UNSELECTED PAGE' }];
  const before = JSON.stringify(pages);
  assert.deepEqual(buildAiBatches(pages, [3, 1], limits, false), [[1, 3]]);
  assert.equal(JSON.stringify(pages), before);
});

test('AI text batches reject missing, blank or oversized pages and divide long selections', () => {
  assert.throws(() => buildAiBatches([{ page: 1, text: 'x' }], [], limits, false));
  assert.throws(() => buildAiBatches([{ page: 1, text: 'x' }], [1, 2], limits, false));
  assert.throws(() => buildAiBatches([{ page: 1, text: '  ' }], [1], limits, false));
  const pages = Array.from({ length: 6 }, (_, index) => ({ page: index + 1, text: 'x' }));
  assert.deepEqual(buildAiBatches(pages, [1, 2, 3, 4, 5, 6], limits, false), [[1, 2, 3, 4, 5], [6]]);
  assert.throws(() => buildAiBatches([{ page: 1, text: 'x'.repeat(24001) }], [1], limits, false));
  assert.deepEqual(buildAiBatches([{ page: 1, text: 'x'.repeat(24000) }], [1], limits, false), [[1]]);
});

test('session refresh retries an authorized internal request once with its original body', async context => {
  const calls: { input: string; init?: RequestInit }[] = [];
  const init = { method: 'POST', body: '{"revision":4}' }; let originalCalls = 0;
  context.mock.method(globalThis, 'fetch', async (input: string, options?: RequestInit) => { calls.push({ input, init: options }); if (input === '/api/auth/refresh') return new Response('{}'); originalCalls++; return new Response('{}', { status: originalCalls === 1 ? 401 : 200 }); });
  assert.equal((await fetchWithSession('/api/workspace', init)).status, 200);
  assert.deepEqual(calls.map(call => call.input), ['/api/workspace', '/api/auth/refresh', '/api/workspace']);
  assert.strictEqual(calls[2].init, init);
});

test('parallel expired requests share one refresh', async context => {
  let finishRefresh: (() => void) | undefined; const wait = new Promise<void>(resolve => { finishRefresh = resolve; });
  let refreshed = false; let refreshCalls = 0;
  context.mock.method(globalThis, 'fetch', async (input: string) => { if (input === '/api/auth/refresh') { refreshCalls++; await wait; refreshed = true; return new Response('{}'); } return new Response('{}', { status: refreshed ? 200 : 401 }); });
  const requests = [fetchWithSession('/api/workspace'), fetchWithSession('/api/team')];
  await Promise.resolve(); await Promise.resolve(); finishRefresh?.();
  assert.deepEqual((await Promise.all(requests)).map(result => result.status), [200, 200]); assert.equal(refreshCalls, 1);
});

test('failed refresh and repeated 401 never form a retry loop', async context => {
  const calls: string[] = []; context.mock.method(globalThis, 'fetch', async (input: string) => { calls.push(input); return new Response('{}', { status: 401 }); });
  assert.equal((await fetchWithSession('/api/workspace')).status, 401);
  assert.deepEqual(calls, ['/api/workspace', '/api/auth/refresh']);
  calls.length = 0;
  context.mock.method(globalThis, 'fetch', async (input: string) => { calls.push(input); return new Response('{}', { status: input === '/api/auth/refresh' ? 200 : 401 }); });
  assert.equal((await fetchWithSession('/api/workspace')).status, 401);
  assert.deepEqual(calls, ['/api/workspace', '/api/auth/refresh', '/api/workspace']);
});

test('callback auth, external URLs, and provider failures cannot trigger session refresh', async context => {
  const calls: string[] = []; context.mock.method(globalThis, 'fetch', async (input: string) => { calls.push(input); return new Response('{}', { status: input === '/api/ai/extract' ? 502 : 401 }); });
  for (const path of ['/api/auth/verify', '/api/auth/password', 'https://api.moonshot.ai/v1', '/api/ai/extract']) await fetchWithSession(path);
  assert.deepEqual(calls, ['/api/auth/verify', '/api/auth/password', 'https://api.moonshot.ai/v1', '/api/ai/extract']);
});

test('auth and AI feedback translates in both directions and keeps evidence unchanged', () => {
  assert.equal(translate('en', 'Đăng nhập chưa được cấu hình'), 'Sign-in is not configured');
  assert.equal(translateSystemText('Sign-in could not be completed. Check your credentials or contact the workspace owner.', 'vi'), 'Không thể đăng nhập. Kiểm tra thông tin đăng nhập hoặc liên hệ quản trị viên không gian.');
  assert.equal(translateSystemText('Chỉ chọn tối đa 5 trang mỗi lần.', 'en'), 'Select at most 5 pages per request.');
  assert.equal(translateSystemText('Select at most 5 pages per request.', 'vi'), 'Chỉ chọn tối đa 5 trang mỗi lần.');
  assert.equal(translateSystemText('Văn bản được chọn vượt quá 24000 ký tự. Chọn ít trang hơn; nội dung sẽ không bị cắt tự động.', 'en'), 'Selected text exceeds 24000 characters. Select fewer pages; text will not be truncated automatically.');
  assert.equal(auditActionLabel('ai_header_proposals_received', 'en'), 'AI header proposals received');
  assert.equal(translateSystemText('Original invoice: Công ty Nguyễn — 12.450 USD', 'en'), 'Original invoice: Công ty Nguyễn — 12.450 USD');
});
