import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ACCESS_COOKIE, AuthError, authCookie, authMode, loginSchema, parseSession, passwordSchema, providerRequest, revokeCurrentSession, sessionCookies, supabaseConfig, userForToken, verifiedActor, verifySchema } from '../lib/auth-provider.ts';
import { allowedIdentity, consumeRateLimit, CONSUME_RECOVERY_SQL, hashAuthKey } from '../lib/auth-persistence.ts';

const providerUser = { id: 'a708357e-33fd-4f74-b738-d34b7c673662', email: 'OWNER@example.test', email_confirmed_at: '2026-10-10T12:00:00Z', user_metadata: { full_name: 'Synthetic Owner', role: 'owner' } };
const actor = verifiedActor(providerUser);
const config = { url: 'https://demo.supabase.co', key: 'sb_publishable_synthetic_test_key', ownerEmail: 'owner@example.test' };
const session = { access_token: 'synthetic.jwt.access_token', refresh_token: 'synthetic_refresh_token', expires_in: 3600, token_type: 'bearer' as const };
function sqliteD1(sqlite: DatabaseSync): D1Database {
  return { prepare(sql: string) { return { bind(...args: Array<string | number>) {
    return { first: async () => sqlite.prepare(sql).get(...args) || null, all: async () => ({ results: sqlite.prepare(sql).all(...args) }), run: async () => sqlite.prepare(sql).run(...args) };
  }, first: async () => sqlite.prepare(sql).get() || null }; } } as unknown as D1Database;
}
test('auth requires explicit configuration, rejects legacy modes, and validates standalone public keys', () => {
  assert.throws(() => authMode({}), AuthError);
  assert.throws(() => authMode({ AICD_AUTH_MODE: 'sites' }), AuthError);
  assert.throws(() => authMode({ AICD_AUTH_MODE: 'unconfigured' }), AuthError);
  assert.equal(authMode({ AICD_AUTH_MODE: 'supabase' }), 'supabase');
  assert.throws(() => authMode({ AICD_AUTH_MODE: '' }), AuthError);
  assert.throws(() => authMode({ AICD_AUTH_MODE: 'SUPABASE' }), AuthError);
  const environment = { AICD_AUTH_MODE: 'supabase', SUPABASE_URL: config.url, SUPABASE_ANON_KEY: config.key, AICD_OWNER_EMAIL: ' OWNER@example.test ' };
  assert.deepEqual(supabaseConfig(environment), config);
  for (const patch of [{ SUPABASE_URL: 'http://demo.supabase.co' }, { SUPABASE_URL: 'https://demo.supabase.co/forward' }, { SUPABASE_ANON_KEY: 'sb_secret_do_not_use_here' }, { SUPABASE_ANON_KEY: 'header.' + btoa('{"role":"service_role"}') + '.signature' }, { AICD_OWNER_EMAIL: '' }]) assert.throws(() => supabaseConfig({ ...environment, ...patch }), AuthError);
});
test('provider identity requires a verified email and uses namespaced stable IDs, never metadata roles', () => {
  assert.equal(actor.id, 'supabase:' + providerUser.id);
  assert.equal(actor.email, 'owner@example.test');
  assert.equal(Object.hasOwn(actor, 'role'), false);
  for (const patch of [{ email_confirmed_at: null }, { email_confirmed_at: '' }, { id: 'attacker' }, { is_anonymous: true }, { email: 'invalid' }]) assert.throws(() => verifiedActor({ ...providerUser, ...patch }), AuthError);
});
test('auth payloads reject unbounded inputs, redirect injection, signup verification and weak setup passwords', () => {
  assert.equal(loginSchema.parse({ email: 'OWNER@example.test', password: 'existing-password' }).email, 'owner@example.test');
  assert.throws(() => loginSchema.parse({ email: actor.email, password: 'x'.repeat(1025) }));
  assert.throws(() => loginSchema.parse({ email: actor.email, password: 'secret', redirect_to: 'https://evil.example' }));
  assert.throws(() => verifySchema.parse({ token_hash: 'a'.repeat(64), type: 'signup' }));
  assert.throws(() => verifySchema.parse({ token_hash: 'a'.repeat(64), type: 'email' }));
  assert.throws(() => passwordSchema.parse({ password: 'short' }));
  assert.doesNotThrow(() => passwordSchema.parse({ password: 'Long enough synthetic password' }));
});
test('cookies always carry host-only secure HTTP-only protections and ambiguous cookies are rejected', () => {
  for (const cookie of sessionCookies(session)) {
    assert.match(cookie, /^__Host-aicd-/); assert.match(cookie, /; Path=\/; HttpOnly; Secure; SameSite=Lax$/); assert.doesNotMatch(cookie, /Domain=/);
  }
  assert.ok(sessionCookies().every(value => value.includes('Max-Age=0')));
  const request = (cookie: string) => new Request('https://aicd.example/api/workspace', { headers: { cookie } });
  assert.equal(authCookie(request(`${ACCESS_COOKIE}=${session.access_token}`), ACCESS_COOKIE), session.access_token);
  assert.equal(authCookie(request(`${ACCESS_COOKIE}=${session.access_token}; ${ACCESS_COOKIE}=attacker_token`), ACCESS_COOKIE), null);
  assert.equal(authCookie(request(`${ACCESS_COOKIE}=malformed%20token`), ACCESS_COOKIE), null);
  assert.throws(() => parseSession({ ...session, access_token: 'a'.repeat(4000) }));
});
test('getUser validation goes to the configured provider and never trusts an unverified local JWT', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++; assert.equal(String(url), config.url + '/auth/v1/user');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ' + session.access_token);
    assert.equal(init?.cache, 'no-store'); assert.equal(init?.redirect, 'error');
    return Response.json(providerUser);
  };
  assert.deepEqual(await userForToken(config, session.access_token, fetcher), actor);
  assert.equal(calls, 1);
  await assert.rejects(() => userForToken(config, 'bad;token', fetcher), AuthError);
  assert.equal(calls, 1);
});
test('provider errors remain generic and provider output is bounded', async () => {
  await assert.rejects(() => providerRequest(config, '/token?grant_type=password', {}, async () => Response.json({ msg: 'Private account detail and secret' }, { status: 400 })), error => error instanceof AuthError && error.status === 401 && !error.message.includes('Private'));
  await assert.rejects(() => providerRequest(config, '/user', {}, async () => new Response('maintenance', { status: 503 })), error => error instanceof AuthError && error.status === 503);
  await assert.rejects(() => providerRequest(config, '/user', {}, async () => Response.json({ huge: 'a'.repeat(65_000) })), error => error instanceof AuthError && error.status === 502);
  await assert.rejects(() => providerRequest(config, '/user', {}, async () => { throw new Error('connection secret'); }), error => error instanceof AuthError && !error.message.includes('secret'));
  await assert.rejects(() => providerRequest(config, '/user', {}, async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('private transport detail')); } }), { headers: { 'content-type': 'application/json' } })), error => error instanceof AuthError && error.status === 503 && !error.message.includes('private'));
});
test('authentication releases provider response readers after success and rejected content', async () => {
  for (const content of ['{}', '{"huge":"' + 'a'.repeat(65_000) + '"}']) {
    const response = Response.json(JSON.parse(content));
    const operation = providerRequest(config, '/user', {}, async () => response);
    if (content.length > 64_000) await assert.rejects(operation, AuthError);
    else assert.deepEqual(await operation, {});
    assert.equal(response.body?.locked, false);
  }
});
test('logout refreshes an expired access token before revoking the remaining provider session', async () => {
  const paths: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    paths.push(String(url));
    if (paths.length === 1) return Response.json({ error: 'expired' }, { status: 401 });
    if (paths.length === 2) return Response.json({ ...session, access_token: 'new_synthetic_access_token' });
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer new_synthetic_access_token');
    return new Response(null, { status: 204 });
  };
  assert.equal(await revokeCurrentSession(config, session.access_token, session.refresh_token, fetcher), true);
  assert.deepEqual(paths.map(path => new URL(path).pathname + new URL(path).search), ['/auth/v1/logout?scope=local', '/auth/v1/token?grant_type=refresh_token', '/auth/v1/logout?scope=local']);
  assert.equal(await revokeCurrentSession(config, session.access_token, session.refresh_token, async () => { throw new Error('offline'); }), false);
});
test('invite-only membership never rebinds linked provider identities or bootstraps over existing data', async () => {
  const sqlite = new DatabaseSync(':memory:'); const db = sqliteD1(sqlite);
  try {
    sqlite.exec('CREATE TABLE workspace_members (email TEXT, user_id TEXT); CREATE TABLE workspaces (id TEXT);');
    assert.equal(await allowedIdentity(db, actor, actor.email), true);
    assert.equal(await allowedIdentity(db, { ...actor, email: 'outsider@example.test' }, actor.email), false);
    sqlite.prepare('INSERT INTO workspace_members VALUES (?, ?)').run(actor.email, 'old-provider-user');
    assert.equal(await allowedIdentity(db, actor, actor.email), false);
    sqlite.exec('DELETE FROM workspace_members; INSERT INTO workspaces VALUES (\'existing_workspace\');');
    assert.equal(await allowedIdentity(db, actor, actor.email), false);
    sqlite.prepare('INSERT INTO workspace_members VALUES (?, NULL)').run(actor.email);
    assert.equal(await allowedIdentity(db, actor, actor.email), true);
    sqlite.prepare('UPDATE workspace_members SET user_id = ?').run(actor.id);
    assert.equal(await allowedIdentity(db, actor, actor.email), true);
    assert.equal(await allowedIdentity(db, { ...actor, id: 'supabase:another-identity' }, actor.email), false);
    assert.equal(await allowedIdentity(db, { ...actor, email: 'changed@example.test' }, actor.email), false);
  } finally { sqlite.close(); }
});
test('atomic rate limits cap overlapping attempts, isolate scopes and reopen only after expiry', async () => {
  const sqlite = new DatabaseSync(':memory:'); const db = sqliteD1(sqlite);
  try {
    sqlite.exec('CREATE TABLE auth_rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);');
    const attempts = await Promise.all(Array.from({ length: 12 }, () => consumeRateLimit(db, 'login:synthetic', 3, 60, 1000)));
    assert.equal(attempts.filter(Boolean).length, 3);
    assert.equal(sqlite.prepare('SELECT count FROM auth_rate_limits WHERE key = ?').get('login:synthetic')?.count, 3);
    assert.equal(await consumeRateLimit(db, 'login:synthetic', 3, 60, 1059), false);
    assert.equal(await consumeRateLimit(db, 'kimi:synthetic', 3, 60, 1059), true);
    assert.equal(await consumeRateLimit(db, 'login:synthetic', 3, 60, 1060), true);
  } finally { sqlite.close(); }
});
test('password recovery proof is one-use, expires, and cannot cross identities or tokens', async () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec('CREATE TABLE auth_recovery_grants (token_hash TEXT PRIMARY KEY, user_id TEXT, expires_at INTEGER);');
    const key = await hashAuthKey(session.access_token);
    assert.doesNotMatch(key, /synthetic/); assert.equal(key.length, 64);
    const insert = sqlite.prepare('INSERT INTO auth_recovery_grants VALUES (?, ?, ?)');
    insert.run(key, actor.id, 1060);
    const consume = sqlite.prepare(CONSUME_RECOVERY_SQL);
    assert.equal(consume.get(key, 'other-user', 1000), undefined);
    assert.equal(consume.get('other-token', actor.id, 1000), undefined);
    assert.equal(consume.get(key, actor.id, 1000)?.user_id, actor.id);
    assert.equal(consume.get(key, actor.id, 1000), undefined);
    insert.run(key, actor.id, 1060);
    assert.equal(consume.get(key, actor.id, 1060), undefined);
  } finally { sqlite.close(); }
});
