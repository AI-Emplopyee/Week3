import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';

export const LOCAL_DATABASE_ID = 'a1cd0000-0000-4000-8000-000000000001';
// Vite's source server must never expose credentials, saved work or private
// evaluation artifacts, including through its /@fs filesystem route.
export const PRIVATE_FILE_PATTERNS = [
  '**/.env', '**/.env.*', '**/*.{crt,pem,key}', '**/.git/**',
  '**/.aicd-local/**', '**/.dev.vars*', '**/.wrangler/**',
  '**/outputs/**', '**/work/**', '**/.codex/**', '**/.agents/**', '**/.sites-runtime/**',
];
export function localPaths(root = process.cwd()) {
  const directory = resolve(root, '.aicd-local');
  return { directory, state: resolve(directory, 'state'), config: resolve(directory, 'wrangler.json'), secrets: resolve(directory, '.dev.vars') };
}
export function localPort(args) {
  if (!args.length) return 5173;
  if (args.length === 2 && args[0] === '--port' && /^\d{4,5}$/.test(args[1]) && Number(args[1]) >= 1024 && Number(args[1]) <= 65535) return Number(args[1]);
  throw new Error('Use npm run local, or npm run local -- --port PORT. Host and deployment overrides are not accepted.');
}
export function assertLocalDevelopment(command, token) {
  if (command !== 'serve' || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Local mode cannot be built or deployed. Start it with npm run local.');
}
export function localViteEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => {
    const privateKey = key.replace(/^(?:VITE_|NEXT_PUBLIC_)/, '');
    return !['SUPABASE_', 'MOONSHOT_', 'ZAI_'].some(prefix => privateKey.startsWith(prefix))
      && !['AICD_AUTH_MODE', 'AICD_OWNER_EMAIL', 'AICD_STANDALONE'].includes(key);
  }));
}
export function prepareLocalFiles(root = process.cwd(), providerEnvironment = {}) {
  const paths = localPaths(root);
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  chmodSync(paths.directory, 0o700);
  let existing = {};
  if (existsSync(paths.secrets)) {
    const content = readFileSync(paths.secrets, 'utf8');
    if (content.length > 16_384) throw new Error('The local secrets file is too large.');
    existing = parseEnv(content);
  }
  const token = randomBytes(32).toString('hex');
  const secrets = { AICD_LOCAL_REQUEST_TOKEN: token };
  // Only these explicitly named provider values may enter the local Worker.
  // Root .env/.dev.vars and all hosted authentication settings stay isolated.
  // Environment overrides are persisted here, then stripped from Vite's process
  // environment by local.mjs so they cannot become browser build variables.
  for (const key of ['MOONSHOT_API_KEY', 'MOONSHOT_MODEL', 'ZAI_API_KEY', 'ZAI_MODEL']) {
    const provided = Object.hasOwn(providerEnvironment, key) ? providerEnvironment[key] : existing[key];
    if (provided !== undefined && typeof provided !== 'string') throw new Error(`Invalid ${key} in local AI configuration.`);
    const value = provided?.trim();
    if (value) {
      if (value.length > 8192 || /[\r\n"\\]/.test(value)) throw new Error(`Invalid ${key} in local AI configuration.`);
      secrets[key] = value;
    }
  }
  if (secrets.ZAI_API_KEY && !secrets.ZAI_MODEL) secrets.ZAI_MODEL = 'glm-5.3-flash';
  const config = {
    name: 'aicd-local', main: resolve(root, 'build/worker.ts'), compatibility_date: '2026-05-15', compatibility_flags: ['nodejs_compat'],
    vars: { AICD_AUTH_MODE: 'local', AICD_BACKGROUND_PROCESSING: providerEnvironment.AICD_BACKGROUND_PROCESSING === '0' ? '0' : '1' }, secrets: { required: Object.keys(secrets) },
    d1_databases: [{ binding: 'DB', database_name: 'aicd-local-db', database_id: LOCAL_DATABASE_ID, migrations_dir: resolve(root, 'drizzle') }],
    r2_buckets: [{ binding: 'BUCKET', bucket_name: 'aicd-local-documents' }],
  };
  writeFileSync(paths.config, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  writeFileSync(paths.secrets, Object.entries(secrets).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600 });
  chmodSync(paths.config, 0o600); chmodSync(paths.secrets, 0o600);
  return { ...paths, token };
}
