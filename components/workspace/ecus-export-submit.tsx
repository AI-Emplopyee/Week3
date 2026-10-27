"use client";

import { useEffect, useState } from 'react';
import { fetchWithSession } from '@/lib/auth-client';
import { EDA_GOODS_FIELDS, EDA_HEADER_FIELDS, parseEcusExportForm, suggestedEcusExportForm, validateEcusExportForm, type EdaField, type EcusExportDifference, type EcusExportForm, type EcusExportPayload } from '@/lib/ecus-export';
import { acceptSavedEcusDraft, ecusDraftIsDirty, ecusFieldLabel, ecusFormFingerprint, editableEcusDifferences, initialEcusDraftEditor, keepEcusDraftEdits, loadNewestEcusDraft, parseLocalEcusBackup, receiveEcusDraft, restoreEcusDraftBackup, type EcusDraftResponse } from '@/lib/ecus-client-draft';
import { useLocale } from '@/lib/i18n';
import type { ShipmentCase, WorkspaceState } from '@/lib/types';

type Device = { id: string; label: string; lastSeen: string | number | null; ready: boolean; profileId?: string | null };
type Resolution = { id: string; disposition: 'no_draft' | 'draft_kept'; actorName: string; reason: string; createdAt: string; deviceAcknowledged: boolean; draftReference?: string };
type Job = { id: string; deviceId: string; status: string; createdAt: string; message?: string; draftReference?: string; payload?: EcusExportPayload; readback?: EcusExportForm | null; differences?: EcusExportDifference[]; resolution?: Resolution | null; retryOf?: string | null };
type Status = { devices: Device[]; jobs: Job[] };
type Props = { state: WorkspaceState; shipment: ShipmentCase; disabled: boolean; onDirtyChange?: (dirty: boolean) => void };
const recoverableStatuses = new Set(['failed', 'cancelled', 'needs_reconciliation']);

function isReady(device: Device): boolean {
  const lastSeen = typeof device.lastSeen === 'number' ? device.lastSeen : Date.parse(device.lastSeen || '');
  return device.ready && !!device.profileId && Number.isFinite(lastSeen) && Date.now() - lastSeen < 60_000 && Date.now() - lastSeen >= -10_000;
}
function isDraftResponse(value: unknown): value is EcusDraftResponse {
  if (!value || typeof value !== 'object') return false;
  const data = value as EcusDraftResponse;
  return Number.isSafeInteger(data.workspaceRevision) && typeof data.sourceFingerprint === 'string' && (data.draft === null || (!!data.draft && Number.isSafeInteger(data.draft.revision) && data.draft.revision > 0 && typeof data.draft.updatedAt === 'string' && typeof data.draft.updatedBy?.name === 'string' && !!parseLocalEcusBackup({ form: data.draft.form })));
}
function readBackup(key: string) {
  try { const raw = window.sessionStorage.getItem(key); return raw && raw.length <= 3_000_000 ? parseLocalEcusBackup(JSON.parse(raw)) : null; }
  catch { return null; }
}
function responseError(value: unknown, fallback: string): string {
  return value && typeof value === 'object' && 'error' in value && typeof value.error === 'string' ? value.error : fallback;
}

function DifferencesTable({ differences, caption, expectedLabel, actualLabel }: { differences: EcusExportDifference[]; caption: string; expectedLabel: string; actualLabel: string }) {
  const { locale } = useLocale();
  return <div className="eda-diff-scroll"><table className="eda-diff-table"><caption>{caption}</caption><thead><tr><th scope="col">{locale === 'vi' ? 'Trường' : 'Field'}</th><th scope="col">{expectedLabel}</th><th scope="col">{actualLabel}</th></tr></thead><tbody>{differences.map((difference, index) => <tr key={`${difference.path}-${index}`}><th scope="row">{ecusFieldLabel(difference.path, locale)}</th><td>{difference.expected || <em>{locale === 'vi' ? '(trống)' : '(blank)'}</em>}</td><td>{difference.actual || <em>{locale === 'vi' ? '(trống)' : '(blank)'}</em>}{difference.message && <small>{difference.message}</small>}</td></tr>)}</tbody></table></div>;
}

function RecoveryPanel({ job, workspaceId, disabled, onResolved }: { job: Job; workspaceId: string; disabled: boolean; onResolved: (job: Job) => void }) {
  const { locale, date } = useLocale();
  const say = (vi: string, en: string) => locale === 'vi' ? vi : en;
  const [disposition, setDisposition] = useState<'' | 'no_draft' | 'draft_kept'>('');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState(job.draftReference || '');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const resolve = async (event: React.FormEvent) => {
    event.preventDefault();
    if (disabled || busy || !confirmed || !disposition || reason.trim().length < 10 || reason.trim().length > 2000 || (disposition === 'draft_kept' && !reference.trim())) return;
    setBusy(true); setError('');
    try {
      const response = await fetchWithSession(`/api/ecus/reconcile?${new URLSearchParams({ workspaceId })}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: job.id, disposition, reason: reason.trim(), confirmed: true, ...(disposition === 'draft_kept' ? { draftReference: reference.trim() } : {}) }) });
      const body = await response.json() as { job?: Job; error?: string };
      if (!response.ok) throw new Error(body.error || say('Không thể ghi nhận kết quả kiểm tra.', 'Could not record the inspection.'));
      if (!body.job?.id || !body.job.resolution) throw new Error(say('Chưa xác nhận được kết quả. Làm mới lịch sử trước khi tiếp tục.', 'The result was not confirmed. Refresh the history before continuing.'));
      onResolved(body.job);
    } catch (problem) { setError(problem instanceof Error ? problem.message : say('Không thể ghi nhận kết quả kiểm tra.', 'Could not record the inspection.')); setConfirmed(false); }
    finally { setBusy(false); }
  };
  if (job.resolution) return <div className="eda-recovery"><strong>{job.resolution.disposition === 'draft_kept' ? say('Nhân viên đã giữ bản nháp hiện có', 'Employee retained the existing draft') : say('Nhân viên đã xác nhận không còn bản nháp', 'Employee confirmed no draft remains')}</strong><p>{job.resolution.actorName} · {date(job.resolution.createdAt)}</p><p>{job.resolution.reason}</p>{job.resolution.draftReference && <p>{say('Mã bản nháp được giữ', 'Retained draft reference')}: {job.resolution.draftReference}</p>}<p>{job.resolution.disposition === 'draft_kept' ? say('Đây là ghi nhận kiểm tra thủ công, không phải xác minh tự động. Không thể tạo thêm bản nháp cho hồ sơ này.', 'This records a manual inspection, not automatic verification. Another draft cannot be created for this shipment.') : job.resolution.deviceAcknowledged ? say('Kết quả xử lý đã được xác nhận. Bạn có thể rà soát, lưu và gửi một yêu cầu mới bằng nút Gửi tới ECUS.', 'Recovery is acknowledged. You may review, save and submit a new request using Submit to ECUS.') : say('Đang chờ xác nhận kết quả xử lý từ hệ thống. Bạn có thể sửa và lưu bản nhập; chỉ gửi được sau khi có xác nhận.', 'Waiting for recovery acknowledgement. You may edit and save; submission remains blocked until acknowledgement.')}</p></div>;
  if (!recoverableStatuses.has(job.status)) return null;
  return <form className="eda-recovery" onSubmit={resolve}>
    <h4>{say('Ghi nhận kiểm tra trực tiếp trên ECUS', 'Record an inspection in ECUS')}</h4>
    <p>{say('Mở đúng ECUS trên máy đã nhận yêu cầu và kiểm tra bản nháp, kể cả bản tạo dở. Chỉ ghi nhận sau khi đã kiểm tra. Thao tác này không xóa hoặc tạo bản nháp trên máy.', 'Open ECUS on the computer that received this request and inspect existing and partial drafts. Record the result only after inspection. This action does not delete or create a native draft.')}</p>
    <label>{say('Kết quả kiểm tra', 'Inspection result')}<select value={disposition} disabled={disabled || busy} onChange={event => { setDisposition(event.target.value as typeof disposition); setConfirmed(false); }}><option value="">{say('Chọn kết quả', 'Choose a result')}</option><option value="no_draft">{say('Không còn bản nháp hoặc bản tạo dở', 'No existing or partial draft remains')}</option><option value="draft_kept">{say('Giữ bản nháp đã kiểm tra', 'Keep the inspected draft')}</option></select></label>
    {disposition === 'draft_kept' && <label>{say('Mã bản nháp đã kiểm tra và giữ lại', 'Reference of the inspected draft to keep')}<input value={reference} maxLength={160} disabled={disabled || busy} onChange={event => { setReference(event.target.value); setConfirmed(false); }} /></label>}
    <label>{say('Nội dung kiểm tra và lý do (10–2000 ký tự)', 'Inspection details and reason (10–2000 characters)')}<textarea value={reason} rows={3} maxLength={2000} disabled={disabled || busy} onChange={event => { setReason(event.target.value); setConfirmed(false); }} /></label>
    <label className="eda-review-check"><input type="checkbox" checked={confirmed} disabled={disabled || busy || !disposition} onChange={event => setConfirmed(event.target.checked)} /><span>{disposition === 'draft_kept' ? say('Tôi đã kiểm tra trực tiếp bản nháp nêu trên trong ECUS và quyết định giữ lại. Tôi hiểu đây là xác nhận thủ công.', 'I inspected this draft directly in ECUS and chose to keep it. I understand this is a manual acknowledgement.') : say('Tôi đã kiểm tra trực tiếp ECUS và xác nhận không còn bản nháp hiện có hoặc bản tạo dở từ yêu cầu này.', 'I inspected ECUS directly and confirm that no existing or partial draft from this request remains.')}</span></label>
    {error && <p role="alert">{error}</p>}<button className="button" type="submit" disabled={disabled || busy || !confirmed || !disposition || reason.trim().length < 10 || (disposition === 'draft_kept' && !reference.trim())}>{busy ? say('Đang ghi nhận…', 'Recording…') : say('Lưu kết quả kiểm tra', 'Record inspection result')}</button>
  </form>;
}

export function EcusExportSubmit(props: Props) { return <EcusExportEditor key={`${props.state.id}:${props.shipment.id}`} {...props} />; }

function EcusExportEditor({ state, shipment, disabled, onDirtyChange }: Props) {
  const { locale, date } = useLocale();
  const say = (vi: string, en: string) => locale === 'vi' ? vi : en;
  const storageKey = `aicd.eda-draft.${state.id}.${shipment.id}`;
  const [editor, setEditor] = useState(() => initialEcusDraftEditor(suggestedEcusExportForm(shipment), state.revision));
  const [tab, setTab] = useState<'general' | 'goods'>('general');
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState('');
  const [draftError, setDraftError] = useState('');
  const [error, setError] = useState('');
  const [storageError, setStorageError] = useState(false);
  const [deviceId, setDeviceId] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [sourceReview, setSourceReview] = useState('');
  const [conflictReview, setConflictReview] = useState('');
  const [restoredNeedsReview, setRestoredNeedsReview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const fingerprint = ecusFormFingerprint(editor.form);
  const dirty = editor.loaded && ecusDraftIsDirty(editor);
  const sourceReviewKey = `${editor.sourceFingerprint}:${editor.baseRevision}:${fingerprint}`;
  const conflictReviewKey = `${editor.serverDraft?.revision || 0}:${fingerprint}`;
  const approvalKey = `${sourceReviewKey}:${editor.workspaceRevision}:${deviceId}`;
  const needsSourceReview = editor.sourceChanged || restoredNeedsReview;
  const sourceConfirmed = sourceReview === sourceReviewKey;
  const saved = editor.loaded && editor.baseRevision > 0 && !dirty && !editor.conflict && !needsSourceReview;
  const readyDevice = status?.devices.find(device => device.id === deviceId && isReady(device));
  const blockedJob = status?.jobs.find(job => job.status === 'succeeded' || job.resolution?.disposition !== 'no_draft');
  const waitingAcknowledgement = status?.jobs.find(job => job.resolution?.disposition === 'no_draft' && !job.resolution.deviceAcknowledged);
  const issues = validateEcusExportForm(editor.form);
  const enabled = shipment.caseType === 'export' && shipment.status !== 'completed' && !shipment.mergedInto;
  const locked = disabled || saving || submitting || !editor.loaded || !!blockedJob;
  const maySave = !locked && !editor.conflict && !editor.localBackup && (!needsSourceReview || sourceConfirmed);
  const maySubmit = !disabled && !saving && !submitting && saved && !editor.localBackup && !!readyDevice && !blockedJob && !waitingAcknowledgement && !statusError && !draftError && issues.length === 0;

  useEffect(() => {
    if (!editor.loaded || editor.localBackup) return;
    let failed = false;
    try {
      if (dirty) window.sessionStorage.setItem(storageKey, JSON.stringify({ form: editor.form, baseRevision: editor.baseRevision, sourceFingerprint: editor.sourceFingerprint }));
      else window.sessionStorage.removeItem(storageKey);
    } catch { failed = true; }
    let active = true;
    queueMicrotask(() => { if (active) setStorageError(failed); });
    return () => { active = false; };
  }, [dirty, editor.loaded, editor.localBackup, editor.form, editor.baseRevision, editor.sourceFingerprint, storageKey]);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const backup = readBackup(storageKey);
    let timer: ReturnType<typeof setTimeout>;
    const update = async () => {
      const query = new URLSearchParams({ caseId: shipment.id, workspaceId: state.id });
      await Promise.all([
        (async () => {
          try {
            const response = await fetchWithSession(`/api/ecus/draft?${query}`, { cache: 'no-store', signal: controller.signal });
            const body = await response.json();
            if (!response.ok) throw new Error(responseError(body, 'The saved EDA draft is unavailable.'));
            if (!isDraftResponse(body)) throw new Error('The saved EDA draft response was incomplete.');
            if (!controller.signal.aborted) { setEditor(previous => receiveEcusDraft(previous, body, backup)); setDraftError(''); }
          } catch (problem) { if (!controller.signal.aborted) setDraftError(problem instanceof Error ? problem.message : 'The saved EDA draft is unavailable.'); }
        })(),
        (async () => {
          try {
            const response = await fetchWithSession(`/api/ecus/status?${query}`, { cache: 'no-store', signal: controller.signal });
            const body = await response.json() as Status & { error?: string };
            if (!response.ok) throw new Error(body.error || 'ECUS status is unavailable.');
            if (!Array.isArray(body.devices) || !Array.isArray(body.jobs)) throw new Error('ECUS returned an invalid status.');
            if (!controller.signal.aborted) { setStatus(body); setStatusError(''); }
          } catch (problem) { if (!controller.signal.aborted) setStatusError(problem instanceof Error ? problem.message : 'ECUS status is unavailable.'); }
        })(),
      ]);
      if (!controller.signal.aborted) timer = setTimeout(() => void update(), 5000);
    };
    void update();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [enabled, shipment.id, state.id, storageKey, refresh]);

  const invalidateReview = () => { setConfirmation(''); setSourceReview(''); setConflictReview(''); setError(''); };
  const change = (key: string, value: string, index?: number) => {
    setEditor(previous => ({ ...previous, form: index === undefined ? { ...previous.form, headers: { ...previous.form.headers, [key]: value } } : { ...previous.form, goods: previous.form.goods.map((row, rowIndex) => rowIndex === index ? { ...row, [key]: value } : row) } }));
    invalidateReview();
  };
  const saveDraft = async () => {
    if (!maySave) return;
    setSaving(true); setError('');
    try {
      const response = await fetchWithSession(`/api/ecus/draft?${new URLSearchParams({ workspaceId: state.id })}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseId: shipment.id, revision: editor.workspaceRevision, draftRevision: editor.baseRevision, form: editor.form, sourceConfirmed }) });
      const body = await response.json();
      if (!response.ok) {
        if (response.status === 409 && isDraftResponse(body)) setEditor(previous => receiveEcusDraft(previous, body));
        throw new Error(responseError(body, say('Chưa lưu được. Các thay đổi của bạn vẫn được giữ để rà soát.', 'Could not save. Your edits are preserved for review.')));
      }
      if (!isDraftResponse(body) || !body.draft) throw new Error(say('Chưa xác nhận được bản lưu. Làm mới trước khi gửi.', 'The saved draft was not confirmed. Refresh before submitting.'));
      setEditor(previous => acceptSavedEcusDraft(previous, body)); setRestoredNeedsReview(false); invalidateReview(); setDraftError('');
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not save the EDA draft.'); setConfirmation(''); setSourceReview(''); }
    finally { setSaving(false); setRefresh(value => value + 1); }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!maySubmit || confirmation !== approvalKey) return;
    setSubmitting(true); setError('');
    try {
      const response = await fetchWithSession(`/api/ecus/submit?${new URLSearchParams({ workspaceId: state.id })}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: editor.workspaceRevision, draftRevision: editor.baseRevision, caseId: shipment.id, deviceId, form: parseEcusExportForm(editor.form), confirmed: true }) });
      const body = await response.json() as { error?: string; job?: Job };
      if (!response.ok) throw new Error(body.error || say('Không thể gửi yêu cầu tới ECUS.', 'The ECUS handoff could not be queued.'));
      if (!body.job?.id || typeof body.job.status !== 'string') throw new Error(say('Chưa xác nhận được yêu cầu. Kiểm tra lịch sử trước khi tiếp tục.', 'The handoff was not confirmed. Check the history before continuing.'));
      const acceptedJob = body.job;
      setStatus(previous => ({ devices: previous?.devices || [], jobs: [acceptedJob, ...(previous?.jobs || []).filter(job => job.id !== acceptedJob.id)] }));
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'The ECUS handoff could not be confirmed. Check the history before continuing.'); }
    finally { setSubmitting(false); setConfirmation(''); setRefresh(value => value + 1); }
  };
  const renderField = (field: EdaField, index?: number) => {
    const value = index === undefined ? editor.form.headers[field.key] || '' : editor.form.goods[index][field.key] || '';
    const id = `eda-${shipment.id}-${index ?? 'header'}-${field.key}`;
    const shared = { id, value, disabled: locked, maxLength: field.input === 'textarea' ? 4000 : field.input === 'code' ? 64 : 512, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => change(field.key, event.target.value, index) };
    return <label key={field.key} htmlFor={id} className={field.input === 'textarea' ? 'eda-wide' : undefined}><span>{locale === 'vi' ? field.labelVi : field.labelEn}{field.required ? ' *' : ''}</span>{field.input === 'textarea' ? <textarea {...shared} rows={2} /> : <input {...shared} type="text" inputMode={field.input === 'decimal' ? 'decimal' : field.input === 'integer' ? 'numeric' : undefined} placeholder={field.input === 'date' ? 'YYYY-MM-DD' : undefined} />}</label>;
  };
  const onResolved = (job: Job) => { setStatus(previous => previous ? { ...previous, jobs: previous.jobs.map(item => item.id === job.id ? job : item) } : previous); setConfirmation(''); setRefresh(value => value + 1); };
  const issueMessage = (path: string, message: string) => locale === 'en' ? message : `${ecusFieldLabel(path, locale)}: ${/required/i.test(message) ? 'cần bổ sung' : /greater than zero/i.test(message) ? 'phải lớn hơn 0' : /at least one/i.test(message) ? 'cần ít nhất một dòng hàng' : 'cần kiểm tra định dạng hoặc giá trị'}`;

  if (!enabled) return <section className="card eda-export"><p>{say('EDA chỉ dành cho hồ sơ đang xử lý đã xác định là xuất khẩu.', 'EDA is available only for an active shipment explicitly classified as export.')}</p></section>;
  return <section className="card eda-export">
    <div className="section-heading"><h2>{say('Bản nháp xuất khẩu EDA', 'EDA export draft')}</h2><span className="badge">{say('Nhân viên rà soát', 'Employee review')}</span></div>
    <p>{say('Lưu bản nhập để tiếp tục trên máy khác, kể cả khi chưa điền đủ hoặc còn lỗi. Chỉ nút Gửi tới ECUS mới tạo bản nháp trên máy Windows được ghép nối, sau khi bạn rà soát và xác nhận.', 'Save your working draft to continue on another computer, even with incomplete or invalid fields. Only Submit to ECUS creates a draft on the paired Windows computer, after your review and approval.')}</p>
    <p className="muted">{say('Dữ liệu gợi ý từ hồ sơ xuất khẩu cần được rà soát. Đây là các trường được hỗ trợ; yêu cầu EDA khác, container và phụ lục cần hoàn tất trong ECUS. Không ký số hoặc gửi khai báo tới Hải quan.', 'Suggested export values need review. This form covers supported fields; other EDA requirements, containers and attachments must be completed in ECUS. This does not sign or transmit a declaration to Customs.')}</p>
    <div className="eda-draft-status" aria-live="polite"><strong className={dirty || editor.conflict ? 'eda-unsaved-note' : 'eda-saved-note'}>{!editor.loaded ? say('Đang tải bản lưu…', 'Loading saved draft…') : editor.conflict ? say('Có bản lưu mới hơn — thay đổi của bạn được giữ', 'A newer saved version exists — your edits are preserved') : dirty ? say('Có thay đổi chưa lưu', 'Unsaved changes') : editor.baseRevision ? say('Đã lưu trên máy chủ', 'Saved on the server') : say('Bản nhập mới — chưa lưu', 'New working draft — not saved')}</strong>{editor.serverDraft && <p>{say('Bản lưu gần nhất', 'Latest save')}: {date(editor.serverDraft.updatedAt)} · {editor.serverDraft.updatedBy.name} · {say('phiên bản', 'version')} {editor.serverDraft.revision}</p>}<button type="button" className="button" disabled={saving || submitting} onClick={() => setRefresh(value => value + 1)}>{say('Làm mới trạng thái', 'Refresh status')}</button>{draftError && <p role="alert">{draftError}</p>}</div>
    {editor.localBackup && <div className="eda-conflict"><h3>{say('Có bản khôi phục trong tab này', 'An unsaved recovery copy is available in this tab')}</h3><p>{say('Trang đang hiển thị bản từ máy chủ. Bạn có thể khôi phục các thay đổi chưa lưu để so sánh hoặc bỏ bản khôi phục.', 'The editor displays the server version. You may restore the unsaved recovery copy for comparison or discard it.')}</p><div className="eda-actions"><button type="button" className="button" disabled={locked} onClick={() => { setEditor(restoreEcusDraftBackup); setRestoredNeedsReview(true); invalidateReview(); }}>{say('Khôi phục thay đổi chưa lưu', 'Restore unsaved edits')}</button><button type="button" className="button" disabled={saving || submitting} onClick={() => setEditor(previous => ({ ...previous, localBackup: null }))}>{say('Bỏ bản khôi phục', 'Discard recovery copy')}</button></div></div>}
    {editor.conflict && <div className="eda-conflict"><h3>{say('Đối chiếu với bản mới hơn', 'Compare with the newer saved version')}</h3><p>{say('Không tự ghi đè thay đổi của người khác. Chọn bản mới hơn, hoặc rà soát các khác biệt rồi giữ các giá trị hiện tại để lưu.', 'Choose the newer saved version, or review the differences and deliberately keep your current values for saving.')}</p>{editor.serverDraft && <DifferencesTable differences={editableEcusDifferences(editor.serverDraft.form, editor.form)} caption={say('So sánh bản lưu và bản đang sửa', 'Saved version compared with your edits')} expectedLabel={say('Bản lưu mới hơn', 'Newer saved version')} actualLabel={say('Giá trị hiện tại của bạn', 'Your current values')} />}<label className="eda-review-check"><input type="checkbox" checked={conflictReview === conflictReviewKey} disabled={locked} onChange={event => setConflictReview(event.target.checked ? conflictReviewKey : '')} /><span>{say('Tôi đã đối chiếu bản mới hơn và rà soát lại toàn bộ giá trị muốn giữ.', 'I compared the newer version and re-reviewed all the values I want to keep.')}</span></label><div className="eda-actions"><button type="button" className="button" disabled={saving || submitting} onClick={() => { setEditor(loadNewestEcusDraft); setRestoredNeedsReview(false); invalidateReview(); }}>{say('Tải bản mới hơn, bỏ thay đổi hiện tại', 'Load newer version and discard current edits')}</button><button type="button" className="button" disabled={locked || conflictReview !== conflictReviewKey} onClick={() => { setEditor(keepEcusDraftEdits); invalidateReview(); }}>{say('Giữ các giá trị đã rà soát để lưu', 'Keep reviewed values for saving')}</button></div></div>}
    {needsSourceReview && <div className="eda-conflict"><p>{editor.sourceChanged ? say('Thông tin hồ sơ nguồn đã thay đổi kể từ lần lưu trước. Bản EDA không tự thay đổi. Kiểm tra lại hồ sơ và toàn bộ giá trị EDA trước khi lưu.', 'Shipment source information changed since the last save. EDA values were preserved. Recheck the shipment and all EDA values before saving.') : say('Bản khôi phục cần được rà soát với hồ sơ nguồn hiện tại trước khi lưu.', 'Review the recovery copy against the current shipment before saving.')} </p><label className="eda-review-check"><input type="checkbox" checked={sourceConfirmed} disabled={locked || editor.conflict} onChange={event => { setSourceReview(event.target.checked ? sourceReviewKey : ''); setConfirmation(''); }} /><span>{say('Tôi đã kiểm tra hồ sơ nguồn hiện tại và rà soát lại bản nhập EDA này.', 'I checked the current shipment source and re-reviewed this EDA working draft.')}</span></label></div>}
    {editor.loaded && <form onSubmit={submit} noValidate>
      <div className="eda-tabs" role="tablist" aria-label={say('Biểu mẫu xuất khẩu', 'Export form')}><button type="button" role="tab" aria-selected={tab === 'general'} onClick={() => setTab('general')}>{say('Thông tin chung', 'General information')}</button><button type="button" role="tab" aria-selected={tab === 'goods'} onClick={() => setTab('goods')}>{say('Danh sách hàng', 'Goods')} ({editor.form.goods.length})</button></div>
      {tab === 'general' ? <div className="eda-grid">{EDA_HEADER_FIELDS.map(field => renderField(field))}</div> : <div className="eda-goods">{editor.form.goods.map((_row, index) => <fieldset key={index}><legend>{say('Dòng hàng', 'Goods row')} {index + 1}</legend><div className="eda-grid">{EDA_GOODS_FIELDS.map(field => renderField(field, index))}</div><button type="button" className="button" disabled={locked} onClick={() => { setEditor(previous => ({ ...previous, form: { ...previous.form, goods: previous.form.goods.filter((_, rowIndex) => rowIndex !== index) } })); invalidateReview(); }}>{say('Xóa dòng này', 'Remove this row')}</button></fieldset>)}<button type="button" className="button" disabled={locked || editor.form.goods.length >= 500} onClick={() => { setEditor(previous => ({ ...previous, form: { ...previous.form, goods: [...previous.form.goods, {}] } })); invalidateReview(); }}>{say('Thêm dòng hàng', 'Add goods row')}</button></div>}
      <div className="eda-submit-controls">
        <div className="eda-actions"><button type="button" className="button" disabled={!maySave || (!dirty && editor.baseRevision > 0 && !needsSourceReview)} onClick={() => void saveDraft()}>{saving ? say('Đang lưu…', 'Saving…') : say('Lưu bản nhập', 'Save working draft')}</button><span className="muted">{say('Lưu bản nhập không gửi tới ECUS.', 'Saving does not send anything to ECUS.')}</span></div>
        {storageError && <p role="alert">{say('Không thể tạo bản khôi phục trong trình duyệt. Lưu trên máy chủ để giữ thay đổi.', 'Browser crash recovery is unavailable. Save to the server to preserve edits.')}</p>}
        {!!issues.length && <details><summary>{say(`${issues.length} mục cần kiểm tra trước khi gửi; vẫn có thể lưu bản nhập`, `${issues.length} items need attention before submission; saving is still allowed`)}</summary><ul>{issues.map((issue, index) => <li key={`${issue.path}-${index}`}>{issueMessage(issue.path, issue.message)}</li>)}</ul></details>}
        <label>{say('Máy Windows chạy ECUS', 'Windows computer running ECUS')}<select value={deviceId} disabled={disabled || saving || submitting || !!blockedJob} onChange={event => { setDeviceId(event.target.value); setConfirmation(''); }}><option value="">{say('Chọn máy đã ghép nối', 'Select a paired computer')}</option>{status?.devices.map(device => <option key={device.id} value={device.id} disabled={!isReady(device)}>{device.label} · {isReady(device) ? say('Sẵn sàng', 'Ready') : say('Chưa sẵn sàng', 'Not ready')}</option>)}</select></label>
        {!statusError && !status?.devices.some(isReady) && <p>{say('Chưa có máy Windows sẵn sàng. Bạn vẫn có thể sửa và lưu bản nhập. Ghép nối máy trong Cài đặt và mở chương trình kết nối bên cạnh ECUS trước khi gửi.', 'No Windows computer is ready. You may still edit and save. Pair a computer in Settings and open the companion alongside ECUS before submitting.')}</p>}
        {statusError && <p role="alert">{statusError}</p>}
        {blockedJob && <p role="status">{blockedJob.status === 'succeeded' ? say('Hồ sơ này đã có bản nháp ECUS được xác minh; không thể tạo thêm.', 'This shipment already has a verified ECUS draft; another cannot be created.') : blockedJob.resolution?.disposition === 'draft_kept' ? say('Nhân viên đã giữ bản nháp hiện có. Hồ sơ này không thể tạo thêm bản nháp.', 'An employee retained the existing draft. Another draft cannot be created for this shipment.') : recoverableStatuses.has(blockedJob.status) ? say('Cần kiểm tra trực tiếp ECUS và ghi nhận kết quả trong lịch sử bên dưới trước khi tiếp tục.', 'Inspect ECUS directly and record the result in the history below before continuing.') : say('Một yêu cầu đang được xử lý. Theo dõi kết quả bên dưới.', 'A handoff is in progress. Follow its result below.')}</p>}
        {!blockedJob && waitingAcknowledgement && <p role="status">{say('Chờ xác nhận kết quả xử lý trước khi gửi yêu cầu mới. Bạn vẫn có thể sửa và lưu.', 'Wait for recovery acknowledgement before a new submission. You may still edit and save.')}</p>}
        {!saved && !blockedJob && <p>{say('Lưu bản nhập đã rà soát trước khi gửi tới ECUS.', 'Save the reviewed working draft before submitting to ECUS.')}</p>}
        <label className="eda-confirm"><input type="checkbox" checked={confirmation === approvalKey} disabled={!maySubmit} onChange={event => setConfirmation(event.target.checked ? approvalKey : '')} /><span>{say('Tôi đã rà soát toàn bộ giá trị và dòng hàng xuất khẩu đã lưu, chọn đúng máy và đồng ý tạo bản nháp ECUS từ các giá trị này.', 'I reviewed every saved export value and goods row, selected the correct computer, and approve creating an ECUS draft from these values.')}</span></label>
        {error && <p role="alert">{error}</p>}<button className="button primary" type="submit" disabled={!maySubmit || confirmation !== approvalKey}>{submitting ? say('Đang gửi…', 'Submitting…') : say('Gửi tới ECUS (EDA)', 'Submit to ECUS (EDA)')}</button>
      </div>
    </form>}
    {!!status?.jobs.length && <div className="eda-jobs"><h3>{say('Lịch sử chuyển bản nháp và đối chiếu', 'Draft handoff and inspection history')}</h3><ul>{status.jobs.map(job => <li key={job.id}>
      <strong>{({ queued: say('Đang chờ máy Windows', 'Waiting for Windows'), running: say('Đang tạo và đối chiếu', 'Creating and verifying'), succeeded: say('Đã xác minh bản nháp', 'Draft verified'), failed: say('Không hoàn tất', 'Failed'), needs_reconciliation: say('Cần đối chiếu trên ECUS', 'Needs ECUS reconciliation'), cancelled: say('Đã hủy', 'Cancelled') } as Record<string, string>)[job.status] || job.status}</strong><span> · {date(job.createdAt)}</span>
      {job.retryOf && <p className="muted">{say('Yêu cầu mới sau khi nhân viên kiểm tra yêu cầu trước và duyệt lại.', 'A new submission after employee inspection and renewed approval of the previous attempt.')}</p>}
      <p>{say('Máy nhận yêu cầu', 'Receiving computer')}: {status.devices.find(device => device.id === job.deviceId)?.label || job.deviceId}</p>
      {job.draftReference && <p>{say('Mã bản nháp ECUS', 'ECUS draft reference')}: <strong>{job.draftReference}</strong></p>}{job.message && <p>{job.message}</p>}
      {!!job.differences?.length && <DifferencesTable differences={job.differences} caption={say('Khác biệt giữa giá trị đã duyệt và kết quả đọc lại', 'Differences between approved values and readback')} expectedLabel={say('Giá trị đã duyệt', 'Approved value')} actualLabel={say('Đọc lại từ ECUS', 'ECUS readback')} />}
      {!job.readback && <p>{say('Chưa có dữ liệu đọc lại từ ECUS. Điều này không chứng minh rằng chưa tạo bản nháp; cần kiểm tra trực tiếp khi có lỗi hoặc gián đoạn.', 'No ECUS readback is available. This does not prove that no draft was created; inspect ECUS directly after a failure or interruption.')}</p>}
      {job.payload && <details><summary>{say('Xem các giá trị đã duyệt', 'View approved values')}</summary><dl>{EDA_HEADER_FIELDS.filter(field => job.payload?.form.headers[field.key]).map(field => <div key={field.key}><dt>{locale === 'vi' ? field.labelVi : field.labelEn}</dt><dd>{job.payload!.form.headers[field.key]}</dd></div>)}</dl>{job.payload.form.goods.map((row, index) => <div key={index}><strong>{say('Dòng hàng', 'Goods row')} {index + 1}</strong><dl>{EDA_GOODS_FIELDS.filter(field => row[field.key]).map(field => <div key={field.key}><dt>{locale === 'vi' ? field.labelVi : field.labelEn}</dt><dd>{row[field.key]}</dd></div>)}</dl></div>)}</details>}
      <RecoveryPanel job={job} workspaceId={state.id} disabled={disabled || saving || submitting} onResolved={onResolved} />
    </li>)}</ul></div>}
  </section>;
}
