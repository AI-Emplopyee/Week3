import { z } from 'zod';
import type { Actor } from './types.ts';

export class AuthError extends Error {
  status: number;
  constructor(status: number, message = 'Sign-in could not be completed. Check your credentials or contact the workspace owner.') {
    super(message); this.status = status;
  }
}
export type AuthEnvironment = { AICD_AUTH_MODE?: string; SUPABASE_URL?: string; SUPABASE_ANON_KEY?: string; AICD_OWNER_EMAIL?: string };
export type SupabaseConfig = { url: string; key: string; ownerEmail: string };
export function authMode(environment: AuthEnvironment, allowLocalDevelopment = false): 'supabase' | 'local' {
  if (environment.AICD_AUTH_MODE === 'supabase') return 'supabase';
  if (environment.AICD_AUTH_MODE === 'local' && allowLocalDevelopment) return 'local';
  throw new AuthError(503, 'Authentication is not configured.');
}
export function supabaseConfig(environment: AuthEnvironment): SupabaseConfig {
  if (authMode(environment) !== 'supabase') throw new AuthError(404, 'Email sign-in is not enabled on this deployment.');
  try {
    const url = new URL(environment.SUPABASE_URL || '');
    const key = environment.SUPABASE_ANON_KEY || '';
    const ownerEmail = z.string().trim().email().max(320).parse(environment.AICD_OWNER_EMAIL).toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname) || key.length < 20 || key.length > 2048 || /[\s\r\n]/.test(key) || key.startsWith('sb_secret_')) throw new Error();
    // This adapter must never receive a privileged Supabase key.
    if (!key.startsWith('sb_publishable_')) {
      const payload = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (payload.role !== 'anon') throw new Error();
    }
    return { url: url.origin, key, ownerEmail };
  } catch { throw new AuthError(503, 'Authentication is not configured.'); }
}
const email = z.string().trim().email().max(320).transform(value => value.toLowerCase());
export const loginSchema = z.object({ email, password: z.string().min(1).max(1024) }).strict();
export const resetSchema = z.object({ email }).strict();
export const verifySchema = z.object({ token_hash: z.string().min(20).max(256).regex(/^[a-zA-Z0-9_-]+$/), type: z.enum(['invite', 'recovery']) }).strict();
export const passwordSchema = z.object({ password: z.string().min(12).max(128) }).strict();
export const emptySchema = z.object({}).strict();
const providerUserSchema = z.object({ id: z.string().uuid(), email, email_confirmed_at: z.string().datetime({ offset: true }), is_anonymous: z.boolean().optional(), user_metadata: z.record(z.unknown()).optional() });
export function verifiedActor(user: unknown): Actor {
  const parsed = providerUserSchema.safeParse(user);
  if (!parsed.success || parsed.data.is_anonymous) throw new AuthError(401);
  const name = parsed.data.user_metadata?.full_name;
  return { id: `supabase:${parsed.data.id}`, email: parsed.data.email, name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 160) : parsed.data.email };
}
const token = z.string().min(10).max(3800).regex(/^[a-zA-Z0-9_.-]+$/);
const sessionSchema = z.object({ access_token: token, refresh_token: token, expires_in: z.number().int().positive().max(86400), token_type: z.literal('bearer') });
export type AuthSession = z.infer<typeof sessionSchema>;
export function parseSession(value: unknown): AuthSession {
  const parsed = sessionSchema.safeParse(value);
  if (!parsed.success) throw new AuthError(502, 'The sign-in service returned an invalid response.');
  return parsed.data;
}
export async function providerRequest(config: SupabaseConfig, path: string, options: { method?: 'GET' | 'POST' | 'PUT'; body?: unknown; accessToken?: string } = {}, fetcher: typeof fetch = fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(`${config.url}/auth/v1${path}`, {
      method: options.method || 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(12_000),
      headers: { apikey: config.key, 'Content-Type': 'application/json', ...(options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch { throw new AuthError(503, 'The sign-in service is temporarily unavailable. Please retry.'); }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 429) throw new AuthError(429, 'Too many attempts. Please wait and try again.');
    if (response.status >= 500) throw new AuthError(503, 'The sign-in service is temporarily unavailable. Please retry.');
    throw new AuthError(401);
  }
  if (response.status === 204) return null;
  if (!response.headers.get('content-type')?.includes('application/json') || !response.body) throw new AuthError(502, 'The sign-in service returned an invalid response.');
  const reader = response.body.getReader(); let total = 0; let text = ''; const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > 64_000) { await reader.cancel(); throw new AuthError(502, 'The sign-in service returned an invalid response.'); }
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError(503, 'The sign-in service is temporarily unavailable. Please retry.');
  } finally { reader.releaseLock(); }
  try { return JSON.parse(text + decoder.decode()); } catch { throw new AuthError(502, 'The sign-in service returned an invalid response.'); }
}
export async function userForToken(config: SupabaseConfig, accessToken: string, fetcher?: typeof fetch): Promise<Actor> {
  if (!token.safeParse(accessToken).success) throw new AuthError(401);
  return verifiedActor(await providerRequest(config, '/user', { accessToken }, fetcher));
}
export async function revokeCurrentSession(config: SupabaseConfig, access: string | null, refresh: string | null, fetcher?: typeof fetch): Promise<boolean> {
  if (access) {
    try { await providerRequest(config, '/logout?scope=local', { method: 'POST', accessToken: access }, fetcher); return true; }
    catch (error) { if (!(error instanceof AuthError) || error.status !== 401 || !refresh) return false; }
  }
  if (!refresh) return !access;
  try {
    // A cookie can outlive provider expiry by network delay. Refresh once so
    // logout can revoke a live refresh session even when access has expired.
    const session = parseSession(await providerRequest(config, '/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: refresh } }, fetcher));
    await providerRequest(config, '/logout?scope=local', { method: 'POST', accessToken: session.access_token }, fetcher);
    return true;
  } catch { return false; }
}
export const ACCESS_COOKIE = '__Host-aicd-access';
export const REFRESH_COOKIE = '__Host-aicd-refresh';
export function authCookie(request: Request, name: string): string | null {
  const raw = request.headers.get('cookie') || '';
  if (raw.length > 16_384) return null;
  const matches = raw.split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  return token.safeParse(value).success ? value : null;
}
export function sessionCookies(session?: AuthSession): string[] {
  const suffix = '; Path=/; HttpOnly; Secure; SameSite=Lax';
  return [
    `${ACCESS_COOKIE}=${session?.access_token || ''}; Max-Age=${session ? session.expires_in : 0}${suffix}`,
    `${REFRESH_COOKIE}=${session?.refresh_token || ''}; Max-Age=${session ? 60 * 60 * 24 * 30 : 0}${suffix}`,
  ];
}
