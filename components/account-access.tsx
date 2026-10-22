"use client";

import Link from 'next/link';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AlertCircle, ArrowLeft, CheckCheck, HardDrive, KeyRound, Loader2, LockKeyhole, LogOut, Mail, ShieldCheck } from 'lucide-react';
import { AUTH_CHANGED_EVENT, notifyAuthChanged } from '@/lib/auth-client';
import { LocaleProvider, useLocale } from '@/lib/i18n';
import { translateSystemText } from '@/lib/i18n-core';
import { passwordValidation, callbackParameters, authAvailability } from '@/lib/account-validation';

type AuthStatus = { mode: 'supabase' | 'local' | 'unconfigured'; configured: boolean; authenticated: boolean; user?: { email: string; name: string }; canRefresh?: boolean; localOnly?: boolean; localDataPath?: string };
type AuthResponse = { ok?: boolean; user?: { email?: string; name?: string }; error?: string };
async function postAuth(endpoint: string, body: Record<string, unknown>): Promise<AuthResponse> {
  const response = await fetch(`/api/auth/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json() as AuthResponse;
  if (!response.ok) throw new Error(value.error || 'Không thể hoàn tất thao tác tài khoản. Vui lòng thử lại.');
  return value;
}
/** Session changes must discard the mounted workspace and cached user data. */
function reloadWorkspaceAfterAuthChange() {
  notifyAuthChanged();
  // A client route transition can retain workspace state from the previous session.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign('/');
}

export function useAuthStatus() {
  const [status, setStatus] = useState<AuthStatus | null>(null); const [error, setError] = useState('');
  useEffect(() => {
    let active = true; const controller = new AbortController();
    const read = () => fetch('/api/auth/status', { signal: controller.signal }).then(async response => { const body = await response.json() as AuthStatus & { error?: string }; if (!response.ok) throw new Error(body.error || 'Không thể kiểm tra cấu hình đăng nhập.'); if (active) { setStatus(body); setError(''); } }).catch(error => { if (active && !controller.signal.aborted) setError(error instanceof Error ? error.message : 'Không thể kiểm tra cấu hình đăng nhập.'); });
    void read(); window.addEventListener(AUTH_CHANGED_EVENT, read);
    return () => { active = false; controller.abort(); window.removeEventListener(AUTH_CHANGED_EVENT, read); };
  }, []);
  return { status, error };
}
function AuthError({ message }: { message: string }) { const { locale } = useLocale(); return message ? <div className="inline-form-error" role="alert"><AlertCircle size={16} /><span>{translateSystemText(message, locale)}</span></div> : null; }
function LanguageSelect() { const { locale, setLocale, t } = useLocale(); return <label className="language-switch"><span className="sr-only">{t('Ngôn ngữ giao diện')}</span><select aria-label={t('Ngôn ngữ giao diện')} value={locale} onChange={event => setLocale(event.target.value as 'vi' | 'en')}><option value="vi" lang="vi">Tiếng Việt</option><option value="en" lang="en">English</option></select></label>; }

export function AuthGate({ onAuthenticated, onRetry }: { onAuthenticated: () => void; onRetry: () => void }) {
  const { t } = useLocale(); const { status, error } = useAuthStatus();
  const availability = status ? authAvailability(status) : null;
  return <section className="auth-gate"><div className="auth-intro"><span className="auth-symbol"><ShieldCheck size={29} /></span><span className="eyebrow">AICD WORKSPACE</span><h1>{t(availability === 'local' ? 'Hồ sơ nhập khẩu, trên Mac của bạn.' : 'Chứng từ của đội bạn. Quyền truy cập được kiểm soát.')}</h1><p>{t(availability === 'local' ? 'Không gian cục bộ cho một người sử dụng. Không cần tài khoản ChatGPT hoặc email / mật khẩu.' : 'Đăng nhập bằng tài khoản đã được mời để tiếp tục rà soát lô hàng.')}</p><div className="auth-trust"><CheckCheck size={16} /><span>{t(availability === 'local' ? 'Dữ liệu hồ sơ và tệp gốc được lưu trên Mac này.' : 'Chỉ thành viên được cấp quyền mới truy cập hồ sơ và chứng từ.')}</span></div></div>
    <div className="auth-card"><div className="auth-card-heading"><span className="auth-lock"><LockKeyhole size={21} /></span><div><h2>{t(availability === 'local' ? 'Mở không gian cục bộ' : 'Đăng nhập không gian làm việc')}</h2><p>{t(availability === 'local' ? 'Một người sử dụng · lưu trên Mac' : 'Chỉ dành cho tài khoản được mời')}</p></div></div>
      {!status && !error && <p className="auth-loading"><Loader2 size={17} className="spin" />{t('Đang kiểm tra cấu hình máy chủ…')}</p>}
      {availability === 'local' && <div className="auth-mode-notice"><span className="badge green"><HardDrive size={12} />{t('Chế độ cục bộ')}</span><p>{t('Không đọc được không gian cục bộ. Kiểm tra AICD đang chạy trên Mac này rồi thử lại. Không cần đăng nhập.')}</p><button className="button primary" onClick={onRetry}>{t('Thử lại')}</button></div>}
      {availability === 'supabase' && status && (status.authenticated ? <div className="auth-session-state"><span className="badge green">{t('Đã đăng nhập')}</span><strong>{status.user?.email}</strong><p>{t('Tài khoản cần được quản trị viên cấp quyền vào không gian làm việc. Không có đăng ký công khai.')}</p><button className="button primary" onClick={onRetry}>{t('Kiểm tra lại quyền truy cập')}</button><SessionControl /></div> : <EmailPasswordForm onAuthenticated={onAuthenticated} />)}
      {availability === 'unconfigured' && <div className="auth-mode-notice"><span className="badge amber">{t('Đăng nhập chưa được cấu hình')}</span><p>{t('Quản trị viên cần hoàn tất cấu hình đăng nhập và mời tài khoản trước khi mở không gian làm việc. Hiện chưa thể đăng nhập bằng email / mật khẩu.')}</p><button className="button secondary" onClick={onRetry}>{t('Thử lại')}</button></div>}
      <AuthError message={error} /><div className="auth-footer-note">{availability === 'local' ? <HardDrive size={14} /> : <Mail size={14} />}{t(availability === 'local' ? 'Dừng máy chủ AICD để đóng quyền truy cập cục bộ.' : 'Chưa có lời mời? Liên hệ quản trị viên của đội bạn.')}</div>
    </div></section>;
}

function EmailPasswordForm({ onAuthenticated }: { onAuthenticated: () => void }) {
  const { t } = useLocale(); const [mode, setMode] = useState<'login' | 'reset'>('login');
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [pending, setPending] = useState(false); const [error, setError] = useState(''); const [sent, setSent] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (pending) return; setPending(true); setError('');
    try {
      if (mode === 'reset') { await postAuth('reset-password', { email: email.trim() }); setSent(true); }
      else { await postAuth('login', { email: email.trim(), password }); setPassword(''); notifyAuthChanged(); onAuthenticated(); }
    } catch (error) { setError(error instanceof Error ? error.message : 'Không thể hoàn tất thao tác tài khoản. Vui lòng thử lại.'); }
    finally { setPending(false); }
  };
  return <form className="auth-form" onSubmit={submit}>
    {mode === 'reset' && <div className="auth-reset-intro"><h3>{t('Đặt lại mật khẩu')}</h3><p>{t('Nhập email đã được mời. Nếu tài khoản đủ điều kiện, bạn sẽ nhận được liên kết đặt lại mật khẩu.')}</p></div>}
    <label htmlFor="account-email">{t('Địa chỉ email')}<input id="account-email" type="email" autoComplete="username" required maxLength={254} value={email} disabled={pending} onChange={event => setEmail(event.target.value)} placeholder={t('ban@congty.vn')} /></label>
    {mode === 'login' && <label htmlFor="account-password">{t('Mật khẩu')}<input id="account-password" type="password" autoComplete="current-password" required maxLength={128} value={password} disabled={pending} onChange={event => setPassword(event.target.value)} /></label>}
    <AuthError message={error} />{sent && <div className="auth-success" role="status"><CheckCheck size={17} /><p>{t('Nếu email được mời và đủ điều kiện, liên kết đặt lại mật khẩu đã được gửi. Kiểm tra hộp thư và thư rác.')}</p></div>}
    <button className="button primary" disabled={pending}>{pending ? <Loader2 size={16} className="spin" /> : mode === 'login' ? <LockKeyhole size={15} /> : <Mail size={15} />}{t(mode === 'login' ? 'Đăng nhập' : 'Gửi liên kết đặt lại')}</button>
    <button type="button" className="text-button auth-alternate" disabled={pending} onClick={() => { setMode(mode === 'login' ? 'reset' : 'login'); setError(''); setSent(false); setPassword(''); }}>{mode === 'reset' && <ArrowLeft size={13} />}{t(mode === 'login' ? 'Quên mật khẩu?' : 'Quay lại đăng nhập')}</button>
  </form>;
}

export function SessionControl({ disabled = false }: { disabled?: boolean }) {
  const { t } = useLocale(); const { status } = useAuthStatus(); const [pending, setPending] = useState(false); const [error, setError] = useState('');
  if (status?.mode !== 'supabase' || !status.authenticated) return null;
  const logout = async () => { setPending(true); setError(''); try { await postAuth('logout', {}); reloadWorkspaceAfterAuthChange(); } catch (error) { setError(error instanceof Error ? error.message : 'Không thể hoàn tất thao tác tài khoản. Vui lòng thử lại.'); setPending(false); } };
  return <div className="session-control"><button className="button secondary small" disabled={disabled || pending} onClick={() => void logout()} title={t(disabled ? 'Lưu nội dung đang chỉnh sửa trước khi đăng xuất' : 'Đăng xuất khỏi tài khoản này')}>{pending ? <Loader2 size={14} className="spin" /> : <LogOut size={14} />}{t('Đăng xuất')}</button><AuthError message={error} /></div>;
}

export function AccountCallbackPage() { return <LocaleProvider><AccountCallback /></LocaleProvider>; }
const emptyCallback = { tokenHash: '', type: '' as const, valid: false };
function createCallbackStore() {
  let captured = false; let snapshot: ReturnType<typeof callbackParameters> = emptyCallback;
  return { getSnapshot: () => snapshot, subscribe: (notify: () => void) => {
    if (!captured) { captured = true; snapshot = callbackParameters(window.location.hash); window.history.replaceState({}, '', window.location.pathname); notify(); }
    return () => undefined;
  } };
}
function useCallbackLink() {
  // A mounted callback owns this ephemeral store; capture and scrub happen only after hydration.
  const [store] = useState(createCallbackStore);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => emptyCallback);
}
function AccountCallback() {
  const { t } = useLocale(); const { tokenHash, type, valid } = useCallbackLink();
  const { status, error: statusError } = useAuthStatus();
  const [verified, setVerified] = useState(false); const [pending, setPending] = useState(false); const [error, setError] = useState('');
  const [password, setPassword] = useState(''); const [confirm, setConfirm] = useState(''); const [email, setEmail] = useState('');
  const passwordInput = useRef<HTMLInputElement>(null);
  const verify = async () => { if (!valid || !status?.configured || status.mode !== 'supabase' || pending) return; setPending(true); setError(''); try { const body = await postAuth('verify', { token_hash: tokenHash, type }); setEmail(body.user?.email || ''); setVerified(true); window.history.replaceState({}, '', '/auth/callback'); notifyAuthChanged(); requestAnimationFrame(() => passwordInput.current?.focus()); } catch (error) { setError(error instanceof Error ? error.message : 'Liên kết không hợp lệ hoặc đã hết hạn.'); } finally { setPending(false); } };
  const savePassword = async (event: React.FormEvent) => { event.preventDefault(); if (pending) return; const validation = passwordValidation(password, confirm); if (validation) { setError(validation); return; } setPending(true); setError(''); try { await postAuth('password', { password }); setPassword(''); setConfirm(''); reloadWorkspaceAfterAuthChange(); } catch (error) { setError((error instanceof Error ? error.message : 'Không thể hoàn tất thao tác tài khoản. Vui lòng thử lại.') + '\n' + 'Quay lại đăng nhập và yêu cầu liên kết đặt lại mật khẩu mới trước khi thử tiếp.'); setPending(false); } };
  return <main className="auth-callback-page"><header><Link className="standalone-brand" href="/" prefetch={false}>AICD<span>.</span></Link><LanguageSelect /></header><div className="auth-card"><span className="auth-symbol"><KeyRound size={28} /></span><div className="auth-card-heading"><div><h1>{t(verified ? 'Thiết lập mật khẩu của bạn' : type === 'recovery' ? 'Xác nhận đặt lại mật khẩu' : 'Hoàn tất lời mời tài khoản')}</h1><p>{t('Chỉ dành cho tài khoản được mời')}</p></div></div>
    {!verified ? <><p className="auth-callback-intro">{t('Chọn nút bên dưới để xác nhận liên kết và thiết lập mật khẩu. Mở trang này không tự sử dụng liên kết của bạn.')}</p>{!status && !statusError ? <p className="auth-loading"><Loader2 size={15} className="spin" />{t('Đang kiểm tra cấu hình máy chủ…')}</p> : status?.mode !== 'supabase' || !status.configured ? <p className="connection-blocker">{t('Đăng nhập email / mật khẩu chưa được cấu hình trên địa chỉ này. Liên hệ quản trị viên để nhận đúng liên kết.')}</p> : !valid ? <p className="connection-blocker">{t('Liên kết không hợp lệ hoặc đã hết hạn.')}</p> : <button className="button primary" disabled={pending} onClick={() => void verify()}>{pending ? <Loader2 className="spin" size={16} /> : <ShieldCheck size={16} />}{t('Xác nhận liên kết của tôi')}</button>}</> : <form className="auth-form" onSubmit={savePassword}>{email && <p className="account-email-display">{email}</p>}<label htmlFor="new-password">{t('Mật khẩu mới')}<input ref={passwordInput} id="new-password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={password} disabled={pending} onChange={event => setPassword(event.target.value)} /><small>{t('Từ 12 đến 128 ký tự. Không chia sẻ mật khẩu với người khác.')}</small></label><label htmlFor="confirm-password">{t('Nhập lại mật khẩu mới')}<input id="confirm-password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={confirm} disabled={pending} onChange={event => setConfirm(event.target.value)} /></label><button className="button primary" disabled={pending}>{pending && <Loader2 size={16} className="spin" />}{t('Lưu mật khẩu & tiếp tục')}</button></form>}
    <AuthError message={error || statusError} /><Link className="text-button auth-back-link" href="/" prefetch={false}><ArrowLeft size={13} />{t('Quay lại đăng nhập')}</Link>
  </div><p className="auth-privacy-note"><ShieldCheck size={14} />{t('Mật khẩu không được lưu trong bộ nhớ cục bộ của trình duyệt.')}</p></main>;
}
