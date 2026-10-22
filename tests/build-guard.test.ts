import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertNoLocalBuildConflict } from '../scripts/local-instance.mjs';

test('build guard permits absent or dead locks and preserves active or invalid locks', () => {
  const root = mkdtempSync(join(tmpdir(), 'aicd-build-guard-'));
  const directory = join(root, '.aicd-local');
  const lock = join(directory, 'launcher.lock');
  try {
    assert.doesNotThrow(() => assertNoLocalBuildConflict(root));
    mkdirSync(directory);
    const ended = spawnSync(process.execPath, ['-e', ''], { timeout: 5000 });
    assert.equal(ended.status, 0);
    const stale = JSON.stringify({ pid: ended.pid, nonce: 'ended-test-child' });
    writeFileSync(lock, stale);
    assert.doesNotThrow(() => assertNoLocalBuildConflict(root));
    assert.equal(readFileSync(lock, 'utf8'), stale, 'inspection never removes a stale lock');
    for (const owner of [
      JSON.stringify({ pid: process.pid, nonce: 'live-test-owner' }),
      '', '{', 'null', '{}', '{"pid":0}', '{"pid":"123"}',
    ]) {
      writeFileSync(lock, owner);
      assert.throws(() => assertNoLocalBuildConflict(root), /Stop the local AICD server before building/);
      assert.equal(readFileSync(lock, 'utf8'), owner);
    }
    rmSync(lock);
    mkdirSync(lock);
    assert.throws(() => assertNoLocalBuildConflict(root), /launcher state could not be verified/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('build entry point rejects an active local launcher before runtime or CLI side effects', () => {
  const root = mkdtempSync(join(tmpdir(), 'aicd-build-entry-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, '.aicd-local'));
    for (const name of ['run-framework.mjs', 'local-instance.mjs', 'local-config.mjs']) {
      copyFileSync(new URL(`../scripts/${name}`, import.meta.url), join(root, 'scripts', name));
    }
    writeFileSync(join(root, '.aicd-local', 'launcher.lock'), JSON.stringify({ pid: process.pid }));
    writeFileSync(join(root, 'scripts', 'runtime-env.mjs'),
      "import {writeFileSync} from 'node:fs'; writeFileSync(new URL('../runtime-touched', import.meta.url), 'unexpected');");
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'run-framework.mjs'), 'build'], {
      cwd: root, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Stop the local AICD server before building/);
    assert.equal(existsSync(join(root, 'runtime-touched')), false);
    assert.doesNotMatch(result.stderr, /vinext|ERR_MODULE_NOT_FOUND/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
