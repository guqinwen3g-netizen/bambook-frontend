/** 审批队列：跨工作空间读取服务端派生的审批事项（仅提交快照），决定按原请求编号幂等保存并可核对。
 *  顶栏按钮和“审批与放行”页面共用同一份队列与恢复记录，避免两处各自轮询、各自决定。 */
import React from 'react';
import { ClipboardCheck } from 'lucide-react';
import { apiService } from '../../../../services/apiService';
import type { MistReviewTask } from '../../../../server/src/shared/mistReview';
import { IconButton, useToast } from '../../../../components/mist';
import { useMistSession } from './auth';
import { useMistWorkspace } from './workspace';
import { useNav } from '../nav';

export type MistReview = MistReviewTask & { workspaceId: string; workspaceName: string; revision: number; canDecide: boolean; files?: Array<{ id: string; name: string; size: number }> };
export type MistReviewIntent = { workspaceId: string; reviewId: string; requestId: string; expectedRevision: number; decision: 'approved' | 'rejected'; note: string };
export type MistReviewQueue = {
  rows: MistReview[]; loaded: boolean; error: string; busy: boolean; intent: MistReviewIntent | null;
  refresh: () => Promise<void>; clearError: () => void;
  /** 保存一次审批决定；成功返回 true。失败时保留恢复记录（网络/服务端异常）或给出明确原因（4xx）。 */
  decide: (row: MistReview, decision: 'approved' | 'rejected', note: string) => Promise<boolean>;
  recover: () => Promise<void>; download: (row: MistReview, file: { id: string; name: string }) => Promise<void>;
};

async function call(path: string, body?: unknown) {
  const response = await fetch('/api/mist/reviews' + path, { method: body ? 'POST' : 'GET', headers: apiService.getAuthHeaders(), credentials: 'include', ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json().catch(() => null); if (!response.ok) throw Object.assign(new Error(data?.error?.message || '审批记录读取失败'), { status: response.status }); return data;
}

const ReviewContext = React.createContext<MistReviewQueue | null>(null);
export function useMistReviews(): MistReviewQueue {
  const value = React.useContext(ReviewContext);
  if (!value) throw new Error('useMistReviews 需要在 MistReviewProvider 内使用');
  return value;
}

/** 页面级只读入口（例如工作台）：不在 Provider 内时返回 null，而不是报错。 */
export function useOptionalMistReviews(): MistReviewQueue | null { return React.useContext(ReviewContext); }

export function MistReviewProvider({ children }: { children: React.ReactNode }) {
  const session = useMistSession(), workspace = useMistWorkspace(), toast = useToast(), identity = session.sessionKey;
  const ref = React.useRef(identity); ref.current = identity;
  const currentWorkspace = React.useRef(workspace); currentWorkspace.current = workspace;
  const [rows, setRows] = React.useState<MistReview[]>([]), [loaded, setLoaded] = React.useState(false), [error, setError] = React.useState(''), [busy, setBusy] = React.useState(false), [intent, setIntent] = React.useState<MistReviewIntent | null>(null);
  const locked = React.useRef(false), requestCounter = React.useRef(0), key = 'bambook.mist.review-pending:' + session.user?.id;
  const refresh = React.useCallback(async () => {
    if (session.status !== 'authenticated') return; const sequence = ++requestCounter.current;
    try { const data = await call(''); if (identity === ref.current && sequence === requestCounter.current) { setRows(Array.isArray(data.reviews) ? data.reviews : []); setLoaded(true); setError(''); } }
    catch (e) { if (identity === ref.current && sequence === requestCounter.current) setError(e instanceof Error ? e.message : '无法读取审批'); }
  }, [identity, session.status]);
  React.useEffect(() => {
    ref.current = identity; setRows([]); setLoaded(false); setIntent(null); setError(''); locked.current = false; setBusy(false); requestCounter.current++;
    if (session.status !== 'authenticated') return;
    try { const value = localStorage.getItem(key); if (value) { const saved = JSON.parse(value); if (saved?.workspaceId && saved?.requestId && saved?.reviewId && ['approved', 'rejected'].includes(saved.decision)) setIntent(saved); } } catch { setError('本机审批恢复记录无法读取'); }
    void refresh(); const timer = window.setInterval(() => void refresh(), 30000);
    return () => { window.clearInterval(timer); if (ref.current === identity) ref.current = ''; };
  }, [identity, session.status, key, refresh]);
  const persist = (next: MistReviewIntent | null) => { if (next) localStorage.setItem(key, JSON.stringify(next)); else localStorage.removeItem(key); setIntent(next); };
  const refreshCurrentWorkspace = async (workspaceId: string) => {
    if (identity !== ref.current || currentWorkspace.current.workspace?.id !== workspaceId) return;
    try { await currentWorkspace.current.refresh(); }
    catch (e) { if (identity === ref.current && currentWorkspace.current.workspace?.id === workspaceId) setError('审批已保存，但当前工作区刷新失败：' + (e instanceof Error ? e.message : '请重新读取工作区')); }
  };
  const execute = async (next: MistReviewIntent) => {
    if (locked.current || identity !== ref.current) return false; locked.current = true; setBusy(true); setError('');
    try {
      persist(next);
      const result = await call('/' + encodeURIComponent(next.workspaceId) + '/' + encodeURIComponent(next.reviewId), { requestId: next.requestId, expectedRevision: next.expectedRevision, decision: next.decision, note: next.note });
      if (result.receipt?.requestId !== next.requestId) throw new Error('审批回执与原请求不符');
      if (identity !== ref.current) return false;
      persist(null); toast(next.decision === 'approved' ? '已批准，决定已保存' : '已退回，决定已保存'); await refresh(); await refreshCurrentWorkspace(next.workspaceId); return true;
    } catch (e: any) {
      if (identity === ref.current) { if (e.status >= 400 && e.status < 500) persist(null); setError((e instanceof Error ? e.message : '操作未完成') + (e.status ? '' : '；请核对原审批请求')); }
      return false;
    } finally { if (identity === ref.current) { locked.current = false; setBusy(false); } }
  };
  const decide = (row: MistReview, decision: 'approved' | 'rejected', note: string) => {
    if (intent) { setError('上一次审批结果待核对，请先核对原请求'); return Promise.resolve(false); }
    return execute({ workspaceId: row.workspaceId, reviewId: row.id, requestId: crypto.randomUUID(), expectedRevision: row.revision, decision, note: note.trim() });
  };
  const recover = async () => {
    if (!intent || locked.current) return; setBusy(true);
    try {
      const data = await call('/' + encodeURIComponent(intent.workspaceId) + '/receipts/' + encodeURIComponent(intent.requestId));
      if (data.receipt?.requestId !== intent.requestId) throw new Error('审批回执不一致');
      if (identity === ref.current) { persist(null); await refresh(); await refreshCurrentWorkspace(intent.workspaceId); toast('原审批结果已核对'); }
    } catch (e: any) { if (identity !== ref.current) return; if (e.status === 404) { setBusy(false); await execute(intent); } else setError(e instanceof Error ? e.message : '核对失败'); }
    finally { if (identity === ref.current) setBusy(false); }
  };
  const download = async (row: MistReview, file: { id: string; name: string }) => {
    try {
      const response = await fetch('/api/mist/reviews/' + encodeURIComponent(row.workspaceId) + '/' + encodeURIComponent(row.id) + '/files/' + encodeURIComponent(file.id), { headers: apiService.getAuthHeaders(), credentials: 'include' });
      if (!response.ok) throw new Error('审批附件读取失败'); const bytes = await response.blob(); if (identity !== ref.current) return;
      const url = URL.createObjectURL(bytes), link = document.createElement('a'); link.href = url; link.download = file.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { if (identity === ref.current) setError(e instanceof Error ? e.message : '附件读取失败'); }
  };
  const value: MistReviewQueue = { rows, loaded, error, busy, intent, refresh, clearError: () => setError(''), decide, recover, download };
  return <ReviewContext.Provider value={value}>{children}</ReviewContext.Provider>;
}

/** 顶栏入口：有待我决定的审批或待核对的审批结果时显示红点，点击进入“审批与放行”。 */
export function MistReviewButton() {
  const reviews = useMistReviews(), nav = useNav();
  const waiting = reviews.rows.filter(r => r.canDecide).length;
  return <IconButton icon={ClipboardCheck} label={waiting ? `审批与放行（${waiting} 项待我审批）` : '审批与放行'} dot={!!reviews.intent || waiting > 0} onClick={() => nav.go('approvals')} />;
}
