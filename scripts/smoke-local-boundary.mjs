// Read-only checks against an explicitly local AICD development server.
import assert from 'node:assert/strict';
import http from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const base = new URL(process.argv[2] || 'http://127.0.0.1:5173');
if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('This check supports HTTP loopback only.');
const root = fileURLToPath(new URL('../', import.meta.url));
// Native HTTP preserves explicit Host headers; fetch may replace this forbidden browser header.
const request = (path, headers = {}) => new Promise((resolveStatus, reject) => {
  const outgoing = http.request(new URL(path, base), { headers }, response => {
    response.resume(); response.on('end', () => resolveStatus(response.statusCode));
  });
  outgoing.setTimeout(10_000, () => outgoing.destroy(new Error('Local request timed out.')));
  outgoing.on('error', reject); outgoing.end();
});
const checks = [
  ['external Host', '/api/workspace', { Host: 'aicd.example' }],
  ['cross-site GET', '/api/workspace', { 'Sec-Fetch-Site': 'cross-site' }],
  ['external Origin', '/api/workspace', { Origin: 'https://untrusted.invalid' }],
  ['forged forwarding', '/api/workspace', { Forwarded: 'for=127.0.0.1;host=127.0.0.1:5173' }],
  ['local secrets path', '/.aicd-local/.dev.vars', {}],
  ['local config path', '/.aicd-local/wrangler.json', {}],
  ['Vite file URL secrets', '/@fs' + resolve(root, '.aicd-local/.dev.vars'), {}],
  ['root secrets path', '/.dev.vars', {}],
];
for (const [label, path, headers] of checks) {
  const status = await request(path, headers);
  assert(status >= 400 && status < 500, `${label}: expected rejection, received ${status}`);
  console.log(`PASS ${label}: ${status}`);
}
// A nonexistent file can produce 404 even when its directory is denied.
// Check a saved report when present; temporary fixtures cover all private paths
// in tests/local-files.test.ts without needing shipment data in a fresh checkout.
const report = resolve(root, 'outputs/AICD_final_accuracy_report.docx');
if (existsSync(report)) {
  const status = await request('/@fs' + report);
  assert.equal(status, 403, `private report: expected denial, received ${status}`);
  console.log(`PASS private report file URL: ${status}`);
}
const status = await fetch(new URL('/api/auth/status', base)).then(response => response.json());
assert.equal(status.mode, 'local'); assert.equal(status.authenticated, true);
console.log('PASS direct local identity');
