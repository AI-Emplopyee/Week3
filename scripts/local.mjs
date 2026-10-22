import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { localPort, localViteEnvironment } from './local-config.mjs';
import { prepareLocalLaunch } from './local-instance.mjs';
import { startLocalBackground } from './local-background.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const port = localPort(process.argv.slice(2));
// Pass only administrator-supplied provider variables to the private Worker
// configuration. prepareLocalFiles ignores every other environment variable.
const local = await prepareLocalLaunch(root, port, undefined, process.env);
process.once('exit', local.release);
const childEnv = localViteEnvironment({ ...process.env, AICD_LOCAL: '1', AICD_LOCAL_REQUEST_TOKEN: local.token, CLOUDFLARE_ENV: '', CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH: '', CLOUDFLARE_CF_FETCH_ENABLED: 'false', WRANGLER_SEND_METRICS: 'false', WRANGLER_WRITE_LOGS: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false' });
childEnv.WRANGLER_LOG_PATH = local.directory + '/logs';
childEnv.WRANGLER_REGISTRY_PATH = local.directory + '/registry';
childEnv.MINIFLARE_REGISTRY_PATH = local.directory + '/registry';
const migration = spawnSync(process.execPath, [fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)), 'd1', 'migrations', 'apply', 'DB', '--local', '--config', local.config, '--persist-to', local.state], { cwd: root, env: { ...childEnv, CI: 'true' }, stdio: 'inherit' });
if (migration.error) throw migration.error;
if (migration.status !== 0) process.exit(migration.status ?? 1);
console.log(`AICD local workspace: http://127.0.0.1:${port}\nData stays in .aicd-local/state. Stop with Ctrl+C. No account is required.`);
const background = process.env.AICD_BACKGROUND_PROCESSING === '0' ? null : startLocalBackground(`http://127.0.0.1:${port}`);
process.once('exit', () => background?.stop());
// Import the dev CLI in this process so Ctrl+C reaches the actual server.
Object.assign(process.env, childEnv);
for (const key of Object.keys(process.env)) if (!(key in childEnv)) delete process.env[key];
process.argv = [process.execPath, fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)), '--host', '127.0.0.1', '--port', String(port), '--strictPort'];
await import('../node_modules/vite/bin/vite.js');
