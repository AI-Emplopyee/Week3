"use client";

import { useCallback, useEffect, useState } from 'react';
import { Monitor, RefreshCw } from 'lucide-react';
import { fetchWithSession } from '@/lib/auth-client';
import { useLocale } from '@/lib/i18n';
import type { WorkspaceResponse } from '@/lib/types';

type Device = { id: string; label: string; ready: boolean; lastSeen: number; profileId: string };
export function EcusConnection({ data }: { data: WorkspaceResponse }) {
  const { locale } = useLocale();
  const say = (vi: string, en: string) => locale === 'en' ? en : vi;
  const [devices, setDevices] = useState<Device[]>([]);
  const [label, setLabel] = useState('ECUS Windows');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const query = `?workspaceId=${encodeURIComponent(data.state.id)}`;
  const refresh = useCallback(async () => {
    const response = await fetchWithSession(`/api/ecus/status${query}`, { cache: 'no-store' });
    const result = await response.json() as { devices: Device[]; error?: string };
    if (!response.ok) throw new Error(result.error || 'Could not load ECUS computers.');
    setDevices(result.devices);
  }, [query]);
  useEffect(() => {
    const controller = new AbortController();
    void fetchWithSession(`/api/ecus/status${query}`, { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        const result = await response.json() as { devices: Device[]; error?: string };
        if (!response.ok) throw new Error(result.error || 'Could not load ECUS computers.');
        if (!controller.signal.aborted) setDevices(result.devices);
      }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [query]);
  const pair = async () => {
    setBusy(true); setError(''); setToken('');
    try {
      const response = await fetchWithSession(`/api/ecus/devices${query}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }) });
      const result = await response.json() as { token: string; error?: string };
      if (!response.ok) throw new Error(result.error || 'Could not pair the computer.');
      setToken(result.token);
      await refresh();
    } catch (error) { setError(error instanceof Error ? error.message : 'Pairing failed.'); }
    finally { setBusy(false); }
  };
  const disconnect = async (deviceId: string) => {
    setBusy(true); setError('');
    try {
      const response = await fetchWithSession(`/api/ecus/devices${query}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId }) });
      if (!response.ok) throw new Error((await response.json() as { error?: string }).error || 'Could not disconnect.');
      setToken(''); await refresh();
    } catch (error) { setError(error instanceof Error ? error.message : 'Disconnect failed.'); }
    finally { setBusy(false); }
  };
  return <section className="card settings-card">
    <div className="section-heading"><h2><Monitor size={19}/>{say('Kết nối ECUS — xuất khẩu', 'ECUS connection — export')}</h2></div>
    <p>{say('Máy Windows nhận biểu mẫu đã duyệt và mở “Đăng ký mới tờ khai xuất khẩu (EDA)”.', 'The Windows computer receives the approved form and opens “Đăng ký mới tờ khai xuất khẩu (EDA)”.')}</p>
    <p>{say('Cài Windows helper trong thư mục companion/ecus trên máy chạy ECUS và thiết lập các ô nhập của phiên bản đang dùng. Máy chỉ báo sẵn sàng khi cấu hình đã được kiểm tra.', 'Install the Windows helper from companion/ecus on the ECUS computer and configure the controls for its installed version. The computer reports ready only after its profile is checked.')}</p>
    <p>{say('Chế độ local yêu cầu AICD chạy trên cùng máy Windows. Nếu AICD chạy ở máy khác, dùng bản triển khai HTTPS có đăng nhập.', 'Local mode requires AICD on the same Windows computer. To use AICD from another computer, use an authenticated HTTPS deployment.')}</p>
    {error && <p className="error-banner" role="alert">{error}</p>}
    <ul>{devices.map(device => <li key={device.id}><strong>{device.label}</strong> — {device.ready ? say('Sẵn sàng', 'Ready') : say('Ngoại tuyến hoặc cần thiết lập', 'Offline or setup needed')}
      {data.role === 'owner' && <button className="button secondary" disabled={busy} onClick={() => void disconnect(device.id)}>{say('Ngắt kết nối', 'Disconnect')}</button>}</li>)}</ul>
    <button className="button secondary" disabled={busy} onClick={() => void refresh().catch(error => setError(error.message))}><RefreshCw size={14}/>{say('Kiểm tra kết nối', 'Refresh connection')}</button>
    {data.role === 'owner' && <form onSubmit={event => { event.preventDefault(); void pair(); }}>
      <label>{say('Tên máy Windows', 'Windows computer name')}<input value={label} maxLength={100} required disabled={busy} onChange={event => setLabel(event.target.value)}/></label>
      <button className="button primary" disabled={busy || !label.trim()}>{say('Tạo mã kết nối', 'Create connection key')}</button>
    </form>}
    {token && <div role="status"><label>{say('Mã hiển thị một lần — nhập vào Windows helper', 'Key shown once — enter it in the Windows helper')}<textarea readOnly rows={3} value={token} spellCheck={false}/></label><button className="button secondary" onClick={() => setToken('')}>{say('Đã lưu mã', 'I saved the key')}</button></div>}
  </section>;
}
