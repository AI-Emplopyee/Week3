import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';
import { PRIVATE_FILE_PATTERNS } from '../scripts/local-config.mjs';

test('Vite blocks real private files through source and filesystem URLs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aicd-private-files-'));
  const privateFiles = [
    '.env.local', '.dev.vars', 'credential.key', '.git/config',
    '.aicd-local/state/records.json', '.wrangler/state/records.json',
    'outputs/report.json', 'work/original.pdf', '.codex/session.json',
    '.agents/instructions.md', '.sites-runtime/config.json',
  ];
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    for (const name of [...privateFiles, 'readable.txt']) {
      const path = join(root, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, 'Synthetic privacy-boundary fixture');
    }
    server = await createServer({
      configFile: false, root, logLevel: 'silent', appType: 'custom',
      server: { host: '127.0.0.1', port: 0, fs: { strict: true, allow: [root], deny: PRIVATE_FILE_PATTERNS } },
    });
    await server.listen();
    const address = server.httpServer!.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${origin}/readable.txt`)).status, 200);
    for (const name of privateFiles) {
      for (const path of [`/${name}`, `/@fs${join(root, name)}`]) {
        const response = await fetch(new URL(path, origin));
        assert.equal(response.status, 403, `${name} must be denied via ${path}`);
        assert.doesNotMatch(await response.text(), /Synthetic privacy-boundary fixture/);
      }
    }
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});
