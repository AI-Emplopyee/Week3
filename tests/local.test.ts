import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import type { IncomingMessage } from 'node:http';
import { AuthError, authMode } from '../lib/auth-provider.ts';
import { assertLocalRequest, isLoopbackAddress, localActor, LOCAL_ACTOR, LOCAL_REQUEST_HEADER } from '../lib/local-auth.ts';
import { authorizeLocalIncoming } from '../build/local-vite-plugin.ts';
import { assertLocalDevelopment, localPort, localViteEnvironment, prepareLocalFiles, LOCAL_DATABASE_ID } from '../scripts/local-config.mjs';
import { prepareLocalLaunch } from '../scripts/local-instance.mjs';

const token = 'a'.repeat(64);
function request(url = 'http://127.0.0.1:5173/api/workspace', headers: Record<string, string> = {}): Request {
  return new Request(url, { headers: { [LOCAL_REQUEST_HEADER]: token, ...headers } });
}
function incoming(target = '/api/workspace', host = '127.0.0.1:5173', address = '127.0.0.1', extra: Record<string, string> = {}): IncomingMessage {
  const headers = { host, ...extra };
  return { url: target, headers, rawHeaders: Object.entries(headers).flat(), socket: { remoteAddress: address } } as unknown as IncomingMessage;
}
test('local identities require explicit dev compilation and a per-launch internal proof', () => {
  assert.equal(authMode({ AICD_AUTH_MODE: 'local' }, true), 'local');
  assert.throws(() => authMode({ AICD_AUTH_MODE: 'local' }), AuthError);
  assert.throws(() => authMode({ AICD_AUTH_MODE: 'local' }, false), AuthError);
  assert.deepEqual(localActor(request(), true, token), LOCAL_ACTOR);
  assert.throws(() => localActor(request(), false, token), /outside/);
  assert.throws(() => localActor(request(), true, undefined), /outside/);
  assert.throws(() => localActor(new Request('http://127.0.0.1:5173/api/workspace'), true, token), /loopback launcher/);
  assert.throws(() => localActor(request(), true, 'b'.repeat(64)), /loopback launcher/);
  const forgedIdentity = request(undefined, { 'oai-authenticated-user-id': 'attacker', 'oai-authenticated-user-email': 'attacker@example.test' });
  assert.deepEqual(localActor(forgedIdentity, true, token), LOCAL_ACTOR);
  assert.deepEqual(localActor(request(undefined, { 'x-forwarded-proto': 'http' }), true, token), LOCAL_ACTOR);
  assert.throws(() => localActor(new Request('http://127.0.0.1:5173/api/workspace', { headers: { 'x-forwarded-proto': 'http' } }), true, token), /loopback launcher/);
});
test('local guard rejects remote authority, mismatched hosts, forwarded requests and browser cross-origin GETs', () => {
  for (const url of ['https://aicd.example/api/workspace', 'http://192.168.1.2:5173/api/workspace', 'http://localhost.attacker.test/api/workspace', 'http://127.0.0.2:5173/api/workspace']) assert.throws(() => assertLocalRequest(request(url)), AuthError);
  assert.throws(() => assertLocalRequest(request(undefined, { host: 'evil.example' })), AuthError);
  assert.throws(() => assertLocalRequest(request(undefined, { origin: 'https://evil.example' })), AuthError);
  assert.throws(() => assertLocalRequest(request(undefined, { origin: 'http://localhost:5173' })), AuthError);
  assert.throws(() => assertLocalRequest(request(undefined, { origin: 'null' })), AuthError);
  assert.throws(() => assertLocalRequest(request(undefined, { 'sec-fetch-site': 'cross-site' })), AuthError);
  for (const header of ['forwarded', 'x-forwarded-host', 'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip']) assert.throws(() => assertLocalRequest(request(undefined, { [header]: '127.0.0.1' })), /Forwarded/);
  assert.doesNotThrow(() => assertLocalRequest(request(undefined, { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'same-origin' })));
  assert.doesNotThrow(() => assertLocalRequest(request('http://localhost:5173/api/workspace')));
});
test('raw listener checks the socket and strips forged proof before injecting its own', () => {
  const req = incoming('/api/workspace', '127.0.0.1:5173', '127.0.0.1', { [LOCAL_REQUEST_HEADER]: 'forged' });
  authorizeLocalIncoming(req, token);
  assert.equal(req.headers[LOCAL_REQUEST_HEADER], token);
  assert.equal(req.rawHeaders.includes('forged'), false);
  assert.equal(req.rawHeaders.filter(value => value === LOCAL_REQUEST_HEADER).length, 1);
  assert.throws(() => authorizeLocalIncoming(incoming('/', '127.0.0.1:5173', '192.168.1.10'), token), /loopback/);
  assert.throws(() => authorizeLocalIncoming(incoming('http://evil.example/api/workspace'), token));
  assert.throws(() => authorizeLocalIncoming(incoming('/', 'evil.example:5173'), token));
  assert.throws(() => authorizeLocalIncoming(incoming('/', '0x7f000001:5173'), token));
  assert.throws(() => authorizeLocalIncoming(incoming('/', '127.0.0.1:5173', '127.0.0.1', { 'x-forwarded-host': 'evil.example' }), token));
  assert.throws(() => authorizeLocalIncoming(incoming('/', '127.0.0.1:5173', '127.0.0.1', { origin: 'https://evil.example' }), token));
  for (const address of ['::1', '::ffff:127.0.0.1', '127.0.0.1']) assert.equal(isLoopbackAddress(address), true);
  assert.equal(isLoopbackAddress(undefined), false);
});
test('local launcher rejects production builds and host/deployment argument overrides', () => {
  assert.doesNotThrow(() => assertLocalDevelopment('serve', token));
  assert.throws(() => assertLocalDevelopment('build', token), /cannot be built/);
  assert.throws(() => assertLocalDevelopment('serve', undefined), /npm run local/);
  assert.equal(localPort([]), 5173);
  assert.equal(localPort(['--port', '5174']), 5174);
  for (const args of [['--host', '0.0.0.0'], ['--remote'], ['--config', 'other.json'], ['--port', '80'], ['--port', '99999'], ['--port', '5173', '--host', 'localhost']]) assert.throws(() => localPort(args));
});
test('first-run configuration is isolated, repeatable and preserves only explicitly local optional model credentials', () => {
  const root = mkdtempSync(join(tmpdir(), 'aicd-local-test-'));
  try {
    writeFileSync(join(root, '.dev.vars'), 'AICD_AUTH_MODE="sites"\nMOONSHOT_API_KEY="root-secret-must-not-load"\n');
    const first = prepareLocalFiles(root);
    const firstConfig = JSON.parse(readFileSync(first.config, 'utf8'));
    assert.equal(firstConfig.vars.AICD_AUTH_MODE, 'local');
    assert.equal(firstConfig.main, join(root, 'build', 'worker.ts'));
    assert.equal(firstConfig.d1_databases[0].database_name, 'aicd-local-db');
    assert.equal(firstConfig.r2_buckets[0].bucket_name, 'aicd-local-documents');
    assert.equal(firstConfig.d1_databases[0].database_id, LOCAL_DATABASE_ID);
    assert.equal(first.state, join(root, '.aicd-local', 'state'));
    assert.deepEqual(firstConfig.secrets.required, ['AICD_LOCAL_REQUEST_TOKEN']);
    assert.doesNotMatch(readFileSync(first.secrets, 'utf8'), /root-secret/);
    assert.equal(statSync(first.secrets).mode & 0o777, 0o600);
    writeFileSync(first.secrets, 'MOONSHOT_API_KEY="synthetic-local-key"\nMOONSHOT_MODEL="synthetic-model"\nSUPABASE_ANON_KEY="discard-me"\nAICD_AUTH_MODE="sites"\n');
    const next = prepareLocalFiles(root);
    const nextConfig = JSON.parse(readFileSync(next.config, 'utf8'));
    const localSecrets = parseEnv(readFileSync(next.secrets, 'utf8'));
    assert.notEqual(next.token, first.token);
    assert.equal(next.state, first.state);
    assert.equal(nextConfig.d1_databases[0].database_id, LOCAL_DATABASE_ID);
    assert.equal(localSecrets.MOONSHOT_API_KEY, 'synthetic-local-key');
    assert.equal(localSecrets.MOONSHOT_MODEL, 'synthetic-model');
    assert.equal(localSecrets.SUPABASE_ANON_KEY, undefined);
    assert.equal(localSecrets.AICD_AUTH_MODE, undefined);
    assert.equal(localSecrets.AICD_LOCAL_REQUEST_TOKEN, next.token);
    assert.deepEqual(nextConfig.secrets.required, ['AICD_LOCAL_REQUEST_TOKEN', 'MOONSHOT_API_KEY', 'MOONSHOT_MODEL']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('an occupied port cannot rotate or rewrite local configuration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aicd-local-port-test-'));
  try {
    const first = prepareLocalFiles(root);
    const config = readFileSync(first.config, 'utf8');
    const secrets = readFileSync(first.secrets, 'utf8');
    await assert.rejects(prepareLocalLaunch(root, 5173, async () => { throw new Error('occupied port'); }), /occupied port/);
    assert.equal(readFileSync(first.config, 'utf8'), config);
    assert.equal(readFileSync(first.secrets, 'utf8'), secrets);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('administrator provider environment overrides stay in private local Worker secrets', () => {
  const root = mkdtempSync(join(tmpdir(), 'aicd-local-provider-test-'));
  try {
    const first = prepareLocalFiles(root);
    writeFileSync(first.secrets, 'MOONSHOT_API_KEY="saved-test-key"\nMOONSHOT_MODEL="saved-model"\n');
    const next = prepareLocalFiles(root, {
      MOONSHOT_API_KEY: 'environment-test-key', SUPABASE_ANON_KEY: 'ignored',
      AICD_AUTH_MODE: 'supabase', VITE_MOONSHOT_API_KEY: 'ignored-public-value',
    });
    const config = JSON.parse(readFileSync(next.config, 'utf8'));
    const values = parseEnv(readFileSync(next.secrets, 'utf8'));
    assert.equal(values.MOONSHOT_API_KEY, 'environment-test-key');
    assert.equal(values.MOONSHOT_MODEL, 'saved-model');
    assert.deepEqual(Object.keys(values).sort(), ['AICD_LOCAL_REQUEST_TOKEN', 'MOONSHOT_API_KEY', 'MOONSHOT_MODEL']);
    assert.equal(config.vars.AICD_AUTH_MODE, 'local');
    assert.doesNotMatch(readFileSync(next.config, 'utf8'), /environment-test-key|saved-test-key|ignored/);
    assert.equal(statSync(next.secrets).mode & 0o777, 0o600);
    const disabled = prepareLocalFiles(root, { MOONSHOT_API_KEY: '' });
    assert.equal(parseEnv(readFileSync(disabled.secrets, 'utf8')).MOONSHOT_API_KEY, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('GLM credentials stay private and use GLM-5.3-Flash by default', () => {
  const root = mkdtempSync(join(tmpdir(), 'aicd-local-glm-test-'));
  try {
    const first = prepareLocalFiles(root, { ZAI_API_KEY: 'synthetic-zai-key', ZAI_BASE_URL: 'https://untrusted.example', VITE_ZAI_API_KEY: 'must-not-load' });
    const values = parseEnv(readFileSync(first.secrets, 'utf8'));
    const config = JSON.parse(readFileSync(first.config, 'utf8'));
    assert.equal(values.ZAI_API_KEY, 'synthetic-zai-key');
    assert.equal(values.ZAI_MODEL, 'glm-5.3-flash');
    assert.deepEqual(Object.keys(values).sort(), ['AICD_LOCAL_REQUEST_TOKEN', 'ZAI_API_KEY', 'ZAI_MODEL']);
    assert.doesNotMatch(readFileSync(first.config, 'utf8'), /synthetic-zai-key|untrusted|must-not-load/);
    assert.deepEqual(config.secrets.required, ['AICD_LOCAL_REQUEST_TOKEN', 'ZAI_API_KEY', 'ZAI_MODEL']);
    assert.equal(statSync(first.secrets).mode & 0o777, 0o600);
    const next = prepareLocalFiles(root);
    assert.equal(parseEnv(readFileSync(next.secrets, 'utf8')).ZAI_API_KEY, 'synthetic-zai-key');
    const overridden = prepareLocalFiles(root, { ZAI_API_KEY: 'synthetic-replacement', ZAI_MODEL: 'glm-5.3-flash' });
    assert.equal(parseEnv(readFileSync(overridden.secrets, 'utf8')).ZAI_API_KEY, 'synthetic-replacement');
    const disabled = prepareLocalFiles(root, { ZAI_API_KEY: '' });
    assert.equal(parseEnv(readFileSync(disabled.secrets, 'utf8')).ZAI_API_KEY, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('Vite cannot inherit private model credentials, including public-prefixed variants', () => {
  const environment = {
    ZAI_API_KEY: 'private-zai', ZAI_MODEL: 'glm-5.3-flash', ZAI_BASE_URL: 'private-endpoint',
    MOONSHOT_API_KEY: 'private-moonshot', SUPABASE_ANON_KEY: 'private-supabase',
    VITE_ZAI_API_KEY: 'public-prefixed-zai', NEXT_PUBLIC_ZAI_API_KEY: 'other-prefixed-zai',
    VITE_MOONSHOT_API_KEY: 'public-prefixed-moonshot', VITE_SUPABASE_ANON_KEY: 'public-prefixed-supabase',
    AICD_AUTH_MODE: 'sites', AICD_OWNER_EMAIL: 'owner@example.test', AICD_STANDALONE: '1',
    AICD_LOCAL: '1', AICD_LOCAL_REQUEST_TOKEN: token, PATH: '/synthetic/bin',
  };
  assert.deepEqual(localViteEnvironment(environment), { AICD_LOCAL: '1', AICD_LOCAL_REQUEST_TOKEN: token, PATH: '/synthetic/bin' });
  assert.equal(environment.ZAI_API_KEY, 'private-zai');
});
test('invalid provider configuration fails without printing the value or overwriting saved secrets', () => {
  const root = mkdtempSync(join(tmpdir(), 'aicd-local-invalid-provider-test-'));
  try {
    const first = prepareLocalFiles(root);
    const saved = readFileSync(first.secrets, 'utf8');
    for (const key of ['MOONSHOT_API_KEY', 'ZAI_API_KEY', 'ZAI_MODEL']) for (const value of ['private-test-key\nINJECTED=1', 'private-test-key"', 'private-test-key\\', 'x'.repeat(8193)]) {
      assert.throws(() => prepareLocalFiles(root, { [key]: value }), error => {
        assert.equal((error as Error).message, `Invalid ${key} in local AI configuration.`);
        return true;
      });
      assert.equal(readFileSync(first.secrets, 'utf8'), saved);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('a live launcher prevents a second port from changing shared files and releases its own lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aicd-local-lock-test-'));
  try {
    const first = await prepareLocalLaunch(root, 5173, async () => {});
    const config = readFileSync(first.config, 'utf8');
    const secrets = readFileSync(first.secrets, 'utf8');
    await assert.rejects(prepareLocalLaunch(root, 5174, async () => {}), /already running/);
    assert.equal(readFileSync(first.config, 'utf8'), config);
    assert.equal(readFileSync(first.secrets, 'utf8'), secrets);
    first.release();
    const next = await prepareLocalLaunch(root, 5174, async () => {});
    assert.notEqual(next.token, first.token);
    first.release(); // A prior owner must not remove the replacement lock.
    await assert.rejects(prepareLocalLaunch(root, 5175, async () => {}), /already running/);
    next.release();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
