import { createServer } from 'node:net';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { localPaths, prepareLocalFiles } from './local-config.mjs';

export function assertLocalPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new Error(`Cannot start AICD: local port ${port} is unavailable. Stop the existing server or choose another --port.`)));
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => probe.close(error => error ? reject(error) : resolve()));
  });
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

/** Production generation and the local server share framework metadata. */
export function assertNoLocalBuildConflict(root) {
  let owner;
  try { owner = readFileSync(join(localPaths(root).directory, 'launcher.lock'), 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw new Error('Stop the local AICD server before building. Its launcher state could not be verified.');
  }
  let pid;
  try { pid = JSON.parse(owner).pid; } catch { /* Partial/malformed locks fail closed. */ }
  if (processIsAlive(pid)) {
    throw new Error('Stop the local AICD server before building. Production builds share generated files with the running local server.');
  }
}

/** Protect the shared local files even when another launch chooses a new port. */
function reserveInstance(root) {
  const directory = localPaths(root).directory;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, 'launcher.lock');
  const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  for (let attempt = 0; attempt < 2; attempt++) {
    let descriptor;
    try { descriptor = openSync(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let previous;
      try { previous = readFileSync(lock, 'utf8'); }
      catch { throw new Error('An AICD local launch is already in progress. Try again after it stops.'); }
      let pid;
      try { pid = JSON.parse(previous).pid; } catch { /* A partial lock fails closed. */ }
      if (processIsAlive(pid)) throw new Error('AICD is already running for this local workspace. Stop it before starting another instance.');
      // Recover a lock left by a process that was forcibly killed. Do not remove
      // a lock whose owner changed while checking whether the old process lives.
      if (readFileSync(lock, 'utf8') === previous) unlinkSync(lock);
      continue;
    }
    try { writeFileSync(descriptor, owner); }
    finally { closeSync(descriptor); }
    return () => {
      try { if (readFileSync(lock, 'utf8') === owner) unlinkSync(lock); }
      catch { /* Exit cleanup must not hide the actual shutdown reason. */ }
    };
  }
  throw new Error('Another AICD local launch is in progress. Try again after it stops.');
}

export async function prepareLocalLaunch(root, port, portProbe = assertLocalPortAvailable, providerEnvironment = {}) {
  // This must precede every file write: a second launch must never rotate the
  // running Worker's proof or cause Vite to reload its configuration.
  await portProbe(port);
  const release = reserveInstance(root);
  try { return { ...prepareLocalFiles(root, providerEnvironment), release }; }
  catch (error) { release(); throw error; }
}
