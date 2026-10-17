import React from 'react';
import { apiService } from '../../../../services/apiService';
import { useMistSession } from './auth';
import type { MistCommand, MistFile, MistRunReceipt, MistState, MistWorkspaceEnvelope } from '../../../../server/src/shared/mistWorkspace';

type Pending = { workspaceId: string; requestId: string; expectedRevision: number; kind: 'command' | 'upload' | 'archive' | 'restore' | 'member' | 'mail-send'; command?: MistCommand; file?: { name: string; size: number; sha256?: string }; actorId?: string; claimId?: string; action?: 'add' | 'remove'; account?: string;
  /** 邮件发送意图：发出前存本机，丢失回执后用同一 requestKey 核对；凭据类动作绝不写入。 */
  mail?: { requestKey: string; draftId?: string; forwardOfId?: string; input: Record<string, unknown>;
    /** 回执与原意图不符（账号 / 请求编号 / 主题 / 收件人 / 已被其他意图认领）时写入：停在待人工核对，不再自动核对或重发。 */
    review?: string } };
export type MistUploadOptions={claimId:string};
export type ArchivedMistWorkspace={id:string;name:string;revision:number;archivedAt:string};
export type MistPendingCreate = { actorId: string; slug: string; name: string; seed: 'demo' | 'empty' };
type Authority = { key: string; userId?: string; status: string };
export interface MistWorkspaceContext {
  state: MistState | null; workspace: MistWorkspaceEnvelope | null; workspaces: Array<{ id: string; name: string; shared?: boolean }>;
  loading: boolean; saving: boolean; error: string; pending: Pending | null;
  pendingCreate?: MistPendingCreate | null;
  run: (command: MistCommand) => Promise<MistRunReceipt>;
  uploadFile: (file: File, options?:MistUploadOptions) => Promise<MistFile>;
  downloadFile: (file: MistFile) => Promise<void>;
  prepareCreditDocument: (creditId: string, versionId: string) => Promise<void>;
  issueCreditDocument: (creditId: string, versionId: string) => Promise<Record<string, unknown>>;
  downloadCreditDocument: (creditId: string, versionId: string) => Promise<void>;
  fileUrl: (file: MistFile) => string;
  refresh: () => Promise<void>; recover: () => Promise<MistRunReceipt | undefined>;
  switchWorkspace: (id: string) => Promise<void>;
  createWorkspace: (name: string, seed?: 'demo' | 'empty') => Promise<void>;
  archivedWorkspaces?:ArchivedMistWorkspace[];
  refreshArchived?:()=>Promise<void>;
  archiveWorkspace?:()=>Promise<void>;
  restoreWorkspace?:(id:string)=>Promise<void>;
  /** 所有者授权/撤销其他账号进入当前空间；对方能看到什么仍由其自身岗位权限决定（服务端裁剪）。 */
  changeMember?:(action:'add'|'remove',account:string)=>Promise<void>;
  /** 智能邮箱真实收发：绑定/断开凭据、同步、发送、重发与核对；凭据只提交到服务端，不进入工作空间状态。 */
  mail?:(action:MistMailAction)=>Promise<MistMailResult>;
  /** 待人工核对的发送意图：本人核对已发送 / 待发送后关闭本机记录；不会发送任何邮件。 */
  closeMailReview?:()=>Promise<void>;
}
export type MistMailAction =
  | { kind: 'bind'; accountId: string; password: string }
  | { kind: 'disconnect'; accountId: string }
  | { kind: 'sync'; accountId: string }
  | { kind: 'send'; requestKey: string; draftId?: string; input?: Record<string, unknown>; forwardOfId?: string }
  | { kind: 'retry'; sendId: string; confirmUnknown?: boolean }
  | { kind: 'verify'; sendId: string };
export interface MistMailResult { sync?: { remaining?: number; failedFolders?: string[]; error?: string | null; [key: string]: unknown }; send?: { id: string; status: string; message?: string; replayed?: boolean; recovered?: boolean; recoveredFor?: string; found?: boolean; foundIn?: string[]; confirmed?: boolean; recipients?: Array<{ address: string; status: string }> } }
const Context = React.createContext<MistWorkspaceContext | null>(null);
const BASE = '/api/mist/workspaces';
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const mailRequestKey = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(value);
const claimIdentifier=(value:unknown):value is string=>typeof value==='string'&&value.length<=120&&/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
async function creditPdfBytes(blob: Blob): Promise<Uint8Array> {
  const buffer = typeof blob.arrayBuffer === 'function' ? await blob.arrayBuffer() : await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => {
      const result = reader.result;
      if (result && typeof result !== 'string' && Object.prototype.toString.call(result) === '[object ArrayBuffer]' && Number.isSafeInteger(result.byteLength)) resolve(result);
      else reject(new RequestError('CN PDF 读取失败'));
    }; reader.onerror = () => reject(new RequestError('CN PDF 读取失败')); reader.readAsArrayBuffer(blob);
  });
  const bytes = new Uint8Array(buffer);
  const header = String.fromCharCode(...bytes.subarray(0, 5));
  const ending = String.fromCharCode(...bytes.subarray(Math.max(0, bytes.length - 1024)));
  if (bytes.length < 10 || header !== '%PDF-' || !/%%EOF\s*$/.test(ending)) throw new RequestError('服务未返回有效的 CN PDF 原件，请核对文档生成结果');
  return bytes;
}
function uploadTarget(options:unknown):string|undefined{
  if(options===undefined)return undefined;
  if(!object(options)||Object.keys(options).length!==1||!claimIdentifier(options.claimId))throw new RequestError('请选择当前案件的有效上传目标');
  return options.claimId;
}
/** 所有者，或服务端确认的被授权成员，才能使用该工作区快照。 */
export function workspaceAccessibleBy(value: MistWorkspaceEnvelope, userId?: string | null) { return !!userId && (value.ownerId === userId || value.access?.role === 'member' && Array.isArray(value.state?.memberIds) && value.state.memberIds.includes(userId)); }
class RequestError extends Error { constructor(message: string, public status = 0, public code?: string) { super(message); } }
function envelope(value: unknown, actorId: string, workspaceId?: string): MistWorkspaceEnvelope {
  const candidate = value as MistWorkspaceEnvelope;
  const arrays: Array<keyof MistState> = ['devs', 'versions', 'drafts', 'fabrics', 'orders', 'orderLines', 'productions', 'receipts', 'invoices', 'allocations', 'payments', 'customers', 'contacts', 'files', 'events', 'tasks', 'notifications', 'calendar'];
  if (!candidate || !nonempty(candidate.id) || workspaceId && candidate.id !== workspaceId || !workspaceAccessibleBy(candidate, actorId)
    || !Number.isSafeInteger(candidate.revision) || candidate.revision < 0 || candidate.state?.schemaVersion !== 1
    || arrays.some(key => !Array.isArray(candidate.state[key])) || !object(candidate.state.settings) || !!candidate.state.workspaceArchive) throw new RequestError('工作区响应不完整或身份、来源不一致');
  return candidate;
}
/**
 * 结构共享：新读到的工作区里没有变化的记录沿用旧对象，只有真正变了的记录换新引用。
 * 后台同步他人修改时，正在编辑的表单、展开状态等依赖记录引用的页面不会因无关更新被重置。
 */
/** 后台同步版本号的间隔。 */
export const MIST_SYNC_INTERVAL_MS = 15_000;
export function shareStructure<T>(previous: unknown, next: T): T {
  if (Object.is(previous, next)) return next;
  if (Array.isArray(previous) && Array.isArray(next)) {
    const byId = new Map<unknown, unknown>();
    for (const item of previous) if (object(item) && typeof item.id === 'string') byId.set(item.id, item);
    let same = previous.length === next.length;
    const out = next.map((item, index) => {
      const prior = object(item) && typeof item.id === 'string' && byId.has(item.id) ? byId.get(item.id) : previous[index];
      const shared = shareStructure(prior, item); if (shared !== previous[index]) same = false; return shared;
    });
    return (same ? previous : out) as T;
  }
  if (object(previous) && object(next) && !Array.isArray(previous) && !Array.isArray(next)) {
    const keys = Object.keys(next); let same = keys.length === Object.keys(previous).length;
    const out: Record<string, unknown> = {};
    for (const key of keys) { const shared = shareStructure(previous[key], next[key]); out[key] = shared; if (!Object.prototype.hasOwnProperty.call(previous, key) || shared !== previous[key]) same = false; }
    return (same ? previous : out) as T;
  }
  return next;
}
function receipt(value: unknown, intent: Pending): MistRunReceipt {
  const candidate = value as MistRunReceipt;
  if (!candidate || candidate.requestId !== intent.requestId || candidate.revision !== intent.expectedRevision + 1 || !object(candidate.result)) throw new RequestError('操作回执与原请求或版本不一致');
  return candidate;
}
function validateReceiptState(value: MistWorkspaceEnvelope, acknowledged: MistRunReceipt, intent: Pending) {
  if (value.revision < acknowledged.revision) throw new RequestError('工作区快照早于操作回执，请核对原请求');
  if (intent.kind === 'member' && (acknowledged.result.workspaceId !== intent.workspaceId || acknowledged.result.action !== intent.action || !nonempty(acknowledged.result.userId))) throw new RequestError('授权回执与原操作不一致，请核对原请求');
  if (intent.kind === 'upload') {
    const fileId = acknowledged.result.fileId || acknowledged.result.id;
    const file = value.state.files.find(item => item.id === fileId);
    if (acknowledged.result.claimId!==intent.claimId || !nonempty(fileId) || !file || file.size !== intent.file?.size || file.name !== intent.file?.name || file.storageKey !== `${intent.workspaceId}/${file.id}`) throw new RequestError('上传回执没有对应当前工作区及原案件目标的原附件');
  }
}
/** 发送回执须指向当前空间中由同一 requestKey 登记的发送记录，才算原意图已有结果。 */
/** 本机发送结案登记：每个发送意图（原 requestKey）核实后记下它认领的回执（send.id）。只存编号，不含正文与凭据。 */
type MailClaim = { workspaceId: string; requestKey: string; sendId: string; accountId: string; closedAt: string; alias?: boolean };
const MAIL_CLAIMS = 'bambook.mist.mail-receipts:';
const MAIL_REVIEW = 'MAIL_RECEIPT_MISMATCH', MAIL_MANUAL = 'MAIL_MANUAL_REVIEW';
function readMailClaims(userId: string): MailClaim[] {
  let raw: string | null;
  try { raw = localStorage.getItem(MAIL_CLAIMS + userId); } catch { throw new RequestError('发送回执与原请求不符：本机发送结案记录不可读，无法确认回执是否已被其他发送意图认领；不算已发送，也不会重发，已停在待人工核对', 409, MAIL_REVIEW); }
  if (!raw) return [];
  try {
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows) || rows.some(row => !object(row) || !nonempty(row.workspaceId) || !nonempty(row.requestKey) || !nonempty(row.sendId) || !nonempty(row.accountId))) throw new Error('invalid');
    return rows as MailClaim[];
  } catch { throw new RequestError('发送回执与原请求不符：本机发送结案记录格式无效，无法确认回执是否已被其他发送意图认领；不算已发送，也不会重发，已停在待人工核对', 409, MAIL_REVIEW); }
}
function writeMailClaim(userId: string, claim: MailClaim) {
  const rows = readMailClaims(userId).filter(row => !(row.workspaceId === claim.workspaceId && row.requestKey === claim.requestKey));
  rows.push(claim);
  try { localStorage.setItem(MAIL_CLAIMS + userId, JSON.stringify(rows.slice(-500))); }
  catch { throw new RequestError('无法保存本机发送结案记录；发送结果尚未确认，请稍后再核对原请求'); }
}
const mailAddresses = (value: unknown) => [...new Set((String(value ?? '').match(/[^\s<>,;，；"']+@[^\s<>,;，；"']+/g) || []).map(item => item.toLowerCase()))].sort().join(',');
const mailSubject = (value: unknown) => String(value ?? '').trim() || '（无主题）';
/** 回执核对：回执必须指向当前空间里同一发送人、同一发件账号、同一 requestKey（或服务端确认的别名）、主题 / 收件人 / 正文一致、且未被其他意图认领的发送记录；任何一项不符都停在待人工核对。 */
function mailSendAcknowledged(data: any, value: MistWorkspaceEnvelope, intent: Pending, userId: string) {
  const id = data?.send?.id, sends = (value.state as any).email?.sends, input = intent.mail!.input;
  const stop = (reason: string) => { throw new RequestError('发送回执与原请求不符：' + reason + '；不算已发送，也不会重发，已停在待人工核对', 409, MAIL_REVIEW); };
  if (!nonempty(id) || !Array.isArray(sends)) stop('服务器没有返回可核对的发送记录');
  const row = sends.find((item: any) => item?.id === id);
  if (!row) stop('回执对应的发送记录不在当前空间');
  // 服务端确认的关联：回执写明 recoveredFor = 本次 requestKey，且当前空间的原记录已持久登记该别名。
  const alias = row.requestKey !== intent.requestId && data?.send?.recoveredFor === intent.requestId && Array.isArray(row.aliasKeys) && row.aliasKeys.includes(intent.requestId);
  const owner = readMailClaims(userId).find(item => item.workspaceId === intent.workspaceId && item.sendId === id && item.requestKey !== intent.requestId);
  if (owner && !alias) stop('该回执已被其他发送意图认领');
  if (row.requestKey !== intent.requestId && !alias) stop('回执属于其他发送请求，服务端没有确认它是本次请求的结果');
  if (row.createdById !== userId) stop('发送人不一致');
  if (row.accountId !== input.accountId) stop('发件账号不一致');
  if (mailSubject(row.subject) !== mailSubject(input.subject)) stop('主题不一致');
  if ((['to', 'cc', 'bcc'] as const).some(role => mailAddresses(row[role]) !== mailAddresses(input[role]))) stop('收件人不一致');
  if (String(row.body ?? '').trim() !== String(input.body ?? '').trim()) stop('正文不一致');
  return { workspaceId: intent.workspaceId, requestKey: intent.requestId, sendId: id, accountId: String(input.accountId), closedAt: new Date().toISOString(), ...(alias ? { alias: true } : {}) } as MailClaim;
}
const mailReviewCode = (failure: unknown) => failure instanceof RequestError && (failure.code === MAIL_REVIEW || failure.code === MAIL_MANUAL);
const mailSendBody = (intent: Pending) => JSON.stringify({ requestKey: intent.mail!.requestKey, ...(intent.mail!.draftId ? { draftId: intent.mail!.draftId } : {}), input: intent.mail!.input, ...(intent.mail!.forwardOfId ? { forwardOfId: intent.mail!.forwardOfId } : {}) });
const mailSendSettled = (failure: unknown) => failure instanceof RequestError && failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status) && failure.code !== 'MAIL_BUSY' && !mailReviewCode(failure);
function readPending(raw: string, actorId: string): Pending {
  const value = JSON.parse(raw) as Pending;
  if (!object(value) || !nonempty(value.workspaceId) || !nonempty(value.requestId) || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0
    || value.actorId && value.actorId !== actorId || !['command', 'upload','archive','restore','member','mail-send'].includes(value.kind)
    || value.kind === 'mail-send' && (!object(value.mail) || !mailRequestKey(value.mail.requestKey) || value.mail.requestKey !== value.requestId || !object(value.mail.input) || !nonempty(value.mail.input.accountId)
      || value.mail.draftId !== undefined && !nonempty(value.mail.draftId) || value.mail.forwardOfId !== undefined && !nonempty(value.mail.forwardOfId)
      || value.mail.review !== undefined && (!nonempty(value.mail.review) || value.mail.review.length > 500))
    || value.mail !== undefined && value.kind !== 'mail-send'
    || value.kind === 'member' && (!['add', 'remove'].includes(value.action!) || !nonempty(value.account) || value.account.length > 200)
    || value.claimId!==undefined&&(value.kind!=='upload'||!claimIdentifier(value.claimId))
    || value.kind === 'command' && (!object(value.command) || !nonempty(value.command.type) || !object(value.command.payload))
    || value.kind === 'upload' && (!value.file || !nonempty(value.file.name) || !Number.isSafeInteger(value.file.size) || value.file.size < 1 || value.file.size > 50 * 1024 * 1024
      || value.file.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(value.file.sha256))) throw new RequestError('本机待核对记录格式无效，请重新核对操作历史');
  return { ...value, actorId };
}
function readPendingCreate(raw: string, actorId: string): MistPendingCreate {
  const value = JSON.parse(raw) as MistPendingCreate;
  if (!object(value) || value.actorId !== actorId || !nonempty(value.slug) || value.slug.length > 100 || value.slug !== value.slug.trim()
    || !nonempty(value.name) || value.name.length > 120 || value.name !== value.name.trim() || !['demo', 'empty'].includes(value.seed)) throw new RequestError('本机工作区创建记录格式无效，请核对创建历史');
  return value;
}
function createNotice(intent: MistPendingCreate) { return `工作区“${intent.name}”的创建结果待核对，请用相同名称和初始方式重试原创建请求`; }
async function request(path: string, init: RequestInit = {}): Promise<any> {
  const headers = { ...apiService.getAuthHeaders(), ...(init.headers as Record<string, string> | undefined) };
  if (init.body instanceof FormData) delete headers['Content-Type'];
  const response = await fetch(path, { ...init, headers, credentials: 'include' });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new RequestError(data?.error?.message || data?.message || '操作未完成，请重试', response.status, data?.error?.code);
  if (!data) throw new RequestError('没有收到可核对的操作结果');
  return data;
}
async function fileDigest(file: File): Promise<string> {
  const bytes = typeof file.arrayBuffer === 'function' ? await file.arrayBuffer() : await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.onerror = () => reject(new RequestError('附件读取失败')); reader.readAsArrayBuffer(file);
  });
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function MistWorkspaceProvider({ children }: { children: React.ReactNode }) {
  const session = useMistSession();
  const [current, setCurrent] = React.useState<{ key: string; value: MistWorkspaceEnvelope } | null>(null);
  const [workspaces, setWorkspaces] = React.useState<Array<{ id: string; name: string; shared?: boolean }>>([]);
  const [archivedWorkspaces,setArchivedWorkspaces]=React.useState<ArchivedMistWorkspace[]>([]);
  const [loading, setLoading] = React.useState(true), [saving, setSaving] = React.useState(false), [error, setError] = React.useState('');
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [pendingCreate, setPendingCreate] = React.useState<MistPendingCreate | null>(null);
  const live = React.useRef<Authority>({ key: session.sessionKey, userId: session.user?.id, status: session.status });
  live.current = { key: session.sessionKey, userId: session.user?.id, status: session.status };
  const activeScope = React.useRef<Authority>(live.current);
  const mounted = React.useRef(false), snapshot = React.useRef<MistWorkspaceEnvelope | null>(null), pendingRef = React.useRef<Pending | null>(null);
  const pendingCreateRef = React.useRef<MistPendingCreate | null>(null);
  const mutation = React.useRef<symbol | null>(null), navigating = React.useRef(false), scopeEpoch = React.useRef(0), readEpoch = React.useRef(0);
  const readController = React.useRef<AbortController | null>(null), wanted = React.useRef<string | undefined>(undefined);
  const latest = React.useRef(new Map<string, MistWorkspaceEnvelope>());
  const authority = { key: session.sessionKey, userId: session.user?.id, status: session.status };
  const scopeIsCurrent = activeScope.current.key === authority.key && activeScope.current.userId === authority.userId && activeScope.current.status === authority.status;
  const visible = scopeIsCurrent && session.status === 'authenticated' && current?.key === session.sessionKey && workspaceAccessibleBy(current.value, session.user?.id) ? current.value : null;
  const boundEpoch = scopeEpoch.current, boundWorkspaceId = visible?.id;
  const assertIdentity = React.useCallback((bound: Authority) => {
    if (!mounted.current || bound.status !== 'authenticated' || !bound.userId || live.current.status !== 'authenticated'
      || live.current.key !== bound.key || live.current.userId !== bound.userId) throw new RequestError('会话已变化，请在当前账号重新操作');
    return bound.userId;
  }, []);
  const assertSource = React.useCallback((bound: Authority, epoch: number, workspaceId?: string) => {
    assertIdentity(bound);
    if (navigating.current || epoch !== scopeEpoch.current || !workspaceId || snapshot.current?.id !== workspaceId) throw new RequestError('工作区已切换，请在当前工作区重新操作');
  }, [assertIdentity]);
  const publishPending = React.useCallback((value: Pending | null) => { pendingRef.current = value; setPending(value); }, []);
  const publishCreate = React.useCallback((value: MistPendingCreate | null) => { pendingCreateRef.current = value; setPendingCreate(value); }, []);
  const persistCreate = React.useCallback((value: MistPendingCreate, bound: Authority) => {
    const userId = assertIdentity(bound);
    try { localStorage.setItem('bambook.mist.pending-create:' + userId, JSON.stringify(value)); }
    catch { throw new RequestError('无法保存本机创建恢复记录，本次尚未提交。请允许本机存储后重试'); }
    publishCreate(value);
  }, [assertIdentity, publishCreate]);
  const clearCreate = React.useCallback((bound: Authority) => {
    assertIdentity(bound); publishCreate(null);
    try { localStorage.removeItem('bambook.mist.pending-create:' + bound.userId); }
    catch { setError('工作区已创建，但本机恢复记录暂未清理；原创建请求可安全重试。'); }
  }, [assertIdentity, publishCreate]);
  const persist = React.useCallback((value: Pending, bound: Authority) => {
    const userId = assertIdentity(bound);
    try { localStorage.setItem('bambook.mist.pending:' + userId, JSON.stringify(value)); }
    catch { throw new RequestError('无法保存本机恢复记录，本次尚未提交。请允许本机存储后重试'); }
    publishPending(value);
  }, [assertIdentity, publishPending]);
  const clearPending = React.useCallback((bound: Authority) => {
    assertIdentity(bound); publishPending(null);
    try { localStorage.removeItem('bambook.mist.pending:' + bound.userId); }
    catch { setError('操作已保存，但本机恢复记录暂未清理；重新打开后可核对同一回执。'); }
  }, [assertIdentity, publishPending]);
  /** 发送意图转为待人工核对：保留原意图（同一 requestKey）并写明原因；之后的核对不再重放。 */
  const holdForReview = React.useCallback((intent: Pending, reason: string, bound: Authority) => {
    const value: Pending = { ...intent, mail: { ...intent.mail!, review: reason.slice(0, 500) } };
    try { persist(value, bound); } catch { publishPending(value); }
  }, [persist, publishPending]);
  const put = React.useCallback((value: MistWorkspaceEnvelope, bound: Authority) => {
    assertIdentity(bound);
    const previous = latest.current.get(value.id);
    const next = previous && previous.revision > value.revision ? previous : previous ? shareStructure(previous, value) : value;
    latest.current.set(next.id, next); snapshot.current = next; setCurrent({ key: bound.key, value: next });
  }, [assertIdentity]);
  const rememberSelection = React.useCallback((id: string, bound: Authority) => {
    const userId = assertIdentity(bound);
    try { localStorage.setItem('bambook.mist.selected-workspace:' + userId, id); }
    catch { setError('当前工作区已打开，但选择未能保存在本机；刷新后可能需要重新选择。'); }
  }, [assertIdentity]);
  const forgetSelection = React.useCallback((bound: Authority) => {
    const userId = assertIdentity(bound);
    try { localStorage.removeItem('bambook.mist.selected-workspace:' + userId); }
    catch { setError('原工作区已不存在，但本机选择记录暂未清理。'); }
  }, [assertIdentity]);
  const load = React.useCallback(async (bound: Authority, id?: string, navigation = false, fallbackMissingSelection = false) => {
    const userId = assertIdentity(bound), generation = ++readEpoch.current;
    readController.current?.abort(); const controller = new AbortController(); readController.current = controller;
    if (navigation) { scopeEpoch.current++; wanted.current = id; navigating.current = true; snapshot.current = null; setCurrent(null); }
    setLoading(true); setError('');
    const isCurrent = () => mounted.current && live.current.key === bound.key && live.current.userId === userId && generation === readEpoch.current;
    try {
      let targetId = id, data: any;
      try { data = await request(targetId ? BASE + '/' + encodeURIComponent(targetId) : BASE + '/default', { signal: controller.signal }); }
      catch (failure) {
        if (!fallbackMissingSelection || !targetId || !(failure instanceof RequestError) || failure.status !== 404 || !isCurrent() || controller.signal.aborted) throw failure;
        forgetSelection(bound); targetId = undefined; wanted.current = undefined;
        data = await request(BASE + '/default', { signal: controller.signal });
      }
      if (!isCurrent()) return;
      const value = envelope(data.workspace, userId, targetId); wanted.current = value.id; put(value, bound); rememberSelection(value.id, bound);
      const list = await request(BASE, { signal: controller.signal });
      if (isCurrent()) setWorkspaces(Array.isArray(list.workspaces) ? list.workspaces.filter((item: unknown) => object(item) && nonempty(item.id) && nonempty(item.name)).map((item: any) => ({ id: item.id, name: item.name, shared: item.access?.role === 'member' || nonempty(item.ownerId) && item.ownerId !== userId })) : []);
    } catch (failure) { if (isCurrent() && !controller.signal.aborted) {
      if (failure instanceof RequestError && [401,403,404].includes(failure.status)) {
        snapshot.current = null; setCurrent(null);
        if (id) { latest.current.delete(id); setWorkspaces(previous => previous.filter(item => item.id !== id)); }
      }
      setError(failure instanceof Error ? failure.message : '工作区读取失败');
    } }
    finally { if (isCurrent()) { navigating.current = false; setLoading(false); const waiting = pendingCreateRef.current; if (waiting) setError(previous => previous || createNotice(waiting)); } }
  }, [assertIdentity, put, rememberSelection, forgetSelection]);
  React.useEffect(() => {
    activeScope.current = authority;
    mounted.current = true; scopeEpoch.current++; readEpoch.current++; readController.current?.abort();
    snapshot.current = null; latest.current.clear(); wanted.current = undefined; navigating.current = false; mutation.current = null;
    setCurrent(null); setWorkspaces([]); setArchivedWorkspaces([]); setError(''); setSaving(false); publishPending(null); publishCreate(null);
    if (authority.status === 'authenticated' && authority.userId) {
      let restored: Pending | null = null;
      let selected: string | undefined;
      let recoveryError = '';
      try { const raw = localStorage.getItem('bambook.mist.pending:' + authority.userId); if (raw) restored = readPending(raw, authority.userId); }
      catch (failure) { recoveryError = failure instanceof Error ? failure.message : '本机恢复记录不可读'; }
      try { const raw = localStorage.getItem('bambook.mist.pending-create:' + authority.userId); if (raw) publishCreate(readPendingCreate(raw, authority.userId)); }
      catch (failure) { recoveryError = failure instanceof Error ? failure.message : '本机创建恢复记录不可读'; }
      try {
        const raw = localStorage.getItem('bambook.mist.selected-workspace:' + authority.userId);
        if (raw && nonempty(raw) && raw === raw.trim() && raw.length <= 120) selected = raw;
        else if (raw) forgetSelection(authority);
      } catch { recoveryError = '本机工作区选择不可读，请重新选择工作区'; }
      // An unresolved command must reopen its exact workspace before recovery.
      const lifecycle=restored&&(restored.kind==='archive'||restored.kind==='restore');
      const initialId = lifecycle?selected:restored?.workspaceId ?? selected;
      publishPending(restored); void load(authority, initialId, true, !!lifecycle||!restored && !!selected).finally(() => {
        if (recoveryError && mounted.current && live.current.key === authority.key && live.current.userId === authority.userId && live.current.status === 'authenticated') setError(previous => previous || recoveryError);
      });
    } else setLoading(authority.status === 'loading');
    return () => { mounted.current = false; scopeEpoch.current++; readEpoch.current++; readController.current?.abort(); mutation.current = null; };
  }, [authority.key, authority.userId, authority.status, load, publishPending, publishCreate, forgetSelection]);

  /**
   * 后台同步：页面可见时每 15 秒（以及切回窗口时）只查一次版本号，别人有更新才静默读取完整内容。
   * 不打断正在进行的保存、切换或待核对的请求；读到的内容经结构共享并入，没变的记录引用不变。
   * 这样多人同时办公时，本页看到的版本始终接近最新，保存时极少因“落后太多”被要求刷新。
   */
  React.useEffect(() => {
    if (authority.status !== 'authenticated' || !authority.userId || !boundWorkspaceId) return;
    const bound = authority, workspaceId = boundWorkspaceId, epoch = boundEpoch;
    let busy = false, stopped = false;
    const quiet = () => stopped || !mounted.current || navigating.current || !!mutation.current || !!pendingRef.current || !!pendingCreateRef.current
      || epoch !== scopeEpoch.current || snapshot.current?.id !== workspaceId || live.current.key !== bound.key || live.current.userId !== bound.userId || live.current.status !== 'authenticated';
    const sync = async () => {
      if (busy || typeof document !== 'undefined' && document.visibilityState === 'hidden' || quiet()) return;
      busy = true;
      try {
        const known = snapshot.current!.revision, generation = readEpoch.current;
        const head = await request(BASE + '/' + encodeURIComponent(workspaceId) + '/revision');
        if (!Number.isSafeInteger(head?.revision) || head.revision <= known || quiet()) return;
        const data = await request(BASE + '/' + encodeURIComponent(workspaceId));
        if (quiet() || generation !== readEpoch.current) return;
        put(envelope(data.workspace, bound.userId!, workspaceId), bound);
      } catch { /* 后台同步失败不打扰当前操作，下一轮或下一次保存时再处理。 */ }
      finally { busy = false; }
    };
    const timer = setInterval(() => { void sync(); }, MIST_SYNC_INTERVAL_MS);
    const wake = () => { void sync(); };
    window.addEventListener('focus', wake); document.addEventListener('visibilitychange', wake);
    return () => { stopped = true; clearInterval(timer); window.removeEventListener('focus', wake); document.removeEventListener('visibilitychange', wake); };
  }, [authority.key, authority.userId, authority.status, boundWorkspaceId, boundEpoch, put]);

  const lock = React.useCallback(() => {
    if (mutation.current) throw new RequestError('已有操作正在保存，请稍候');
    const token = Symbol('mist-mutation'); mutation.current = token; setSaving(true); return token;
  }, []);
  const unlock = React.useCallback((token: symbol, bound: Authority) => {
    if (mutation.current === token && mounted.current && live.current.key === bound.key) { mutation.current = null; setSaving(false); }
  }, []);
  const perform = React.useCallback(async (intent: Pending, body: BodyInit, bound: Authority): Promise<MistRunReceipt> => {
    const restoring = pendingRef.current?.requestId === intent.requestId;
    const operationEpoch = scopeEpoch.current;
    persist(intent, bound); setError('');
    try {
      const data = await request(BASE + '/' + encodeURIComponent(intent.workspaceId) + (intent.kind === 'upload' ? '/files' : intent.kind === 'member' ? '/members' : '/commands'), { method: 'POST', body });
      assertIdentity(bound);
      const acknowledged = receipt(data.receipt, intent), value = envelope(data.workspace, bound.userId!, intent.workspaceId);
      validateReceiptState(value, acknowledged, intent);
      put(value, bound); clearPending(bound); return acknowledged;
    } catch (failure) {
      if (mounted.current && live.current.key === bound.key && live.current.userId === bound.userId && live.current.status === 'authenticated') {
        const known = !restoring && failure instanceof RequestError && failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status) && failure.code !== 'REQUEST_CONFLICT';
        if (known) clearPending(bound);
        const message = (failure instanceof Error ? failure.message : '保存失败') + (known ? '' : '；结果尚未确认，请核对原请求');
        const refreshConflict = known && failure instanceof RequestError && failure.status === 409 && failure.code === 'REVISION_CONFLICT'
          && !pendingRef.current && !pendingCreateRef.current && !navigating.current && scopeEpoch.current === operationEpoch && snapshot.current?.id === intent.workspaceId;
        if (refreshConflict) {
          // The rejected command is not replayed. Keep the current page mounted while
          // adopting the latest source revision for the user's next explicit save.
          const generation = readEpoch.current + 1;
          await load(bound, intent.workspaceId);
          if (mounted.current && live.current.key === bound.key && live.current.userId === bound.userId && live.current.status === 'authenticated'
            && scopeEpoch.current === operationEpoch && readEpoch.current === generation && snapshot.current?.id === intent.workspaceId && !pendingRef.current && !pendingCreateRef.current) setError(message);
        } else setError(message);
      }
      throw failure;
    }
  }, [persist, assertIdentity, put, clearPending, load]);
  const refresh = React.useCallback(async () => {
    assertIdentity(authority);
    if (boundEpoch !== scopeEpoch.current || navigating.current) throw new RequestError('工作区正在切换，请稍候');
    await load(authority, boundWorkspaceId ?? wanted.current);
  }, [authority.key, authority.userId, authority.status, boundEpoch, boundWorkspaceId, assertIdentity, load]);
  const readArchived=React.useCallback(async(bound:Authority)=>{
    assertIdentity(bound);const data=await request(BASE+'/archived');assertIdentity(bound);
    if(!Array.isArray(data.workspaces)||data.workspaces.some((row:any)=>!nonempty(row.id)||!nonempty(row.name)||!Number.isSafeInteger(row.revision)||!nonempty(row.archivedAt)))throw new RequestError('回收站响应不完整');
    setArchivedWorkspaces(data.workspaces);
  },[assertIdentity]);
  const adoptLifecycle=React.useCallback(async(data:any,intent:Pending,bound:Authority)=>{
    assertIdentity(bound);const acknowledged=receipt(data.receipt,intent);
    if(acknowledged.result.workspaceId!==intent.workspaceId||acknowledged.result.action!==intent.kind)throw new RequestError('工作区操作回执来源不一致');
    const value=envelope(data.workspace,bound.userId!);scopeEpoch.current++;wanted.current=value.id;put(value,bound);rememberSelection(value.id,bound);clearPending(bound);
    await load(bound,value.id);try{await readArchived(bound);}catch(failure){if(live.current.key===bound.key)setError(failure instanceof Error?failure.message:'回收站读取失败');}return acknowledged;
  },[assertIdentity,put,rememberSelection,clearPending,load,readArchived]);
  const performLifecycle=React.useCallback(async(intent:Pending,bound:Authority)=>{
    const restoring=pendingRef.current?.requestId===intent.requestId;persist(intent,bound);setError('');
    try{const data=await request(BASE+'/'+encodeURIComponent(intent.workspaceId)+'/'+intent.kind,{method:'POST',body:JSON.stringify({requestId:intent.requestId,expectedRevision:intent.expectedRevision})});return await adoptLifecycle(data,intent,bound);}
    catch(failure){if(mounted.current&&live.current.key===bound.key){const known=!restoring&&failure instanceof RequestError&&failure.status>=400&&failure.status<500&&![408,429].includes(failure.status)&&failure.code!=='REQUEST_CONFLICT';if(known)clearPending(bound);setError((failure instanceof Error?failure.message:'工作区操作失败')+(known?'':'；请核对原请求'));}throw failure;}
  },[persist,adoptLifecycle,clearPending]);
  const refreshArchived=React.useCallback(async()=>{try{await readArchived(authority);}catch(failure){if(live.current.key===authority.key)setError(failure instanceof Error?failure.message:'回收站读取失败');throw failure;}},[authority.key,authority.userId,authority.status,readArchived]);
  const changeMember=React.useCallback(async(action:'add'|'remove',account:string)=>{
    assertSource(authority,boundEpoch,boundWorkspaceId);if(pendingRef.current||pendingCreateRef.current||navigating.current)throw new RequestError('请先核对未完成操作');
    const row=snapshot.current;if(!row||row.access?.canManageMembers!==true)throw new RequestError('只有工作空间所有者可以授权其他账号');
    if(!['add','remove'].includes(action)||!nonempty(account)||account.trim().length>200)throw new RequestError('请选择授权操作和有效账号');
    const token=lock();
    try{const intent:Pending={workspaceId:row.id,requestId:crypto.randomUUID(),expectedRevision:row.revision,actorId:authority.userId,kind:'member',action,account:account.trim()};
      await perform(intent,JSON.stringify({requestId:intent.requestId,expectedRevision:intent.expectedRevision,action:intent.action,account:intent.account}),authority);}
    finally{unlock(token,authority);}
  },[authority.key,authority.userId,authority.status,boundEpoch,boundWorkspaceId,assertSource,lock,perform,unlock]);
  const mail=React.useCallback(async(action:MistMailAction):Promise<MistMailResult>=>{
    assertSource(authority,boundEpoch,boundWorkspaceId);
    if(pendingCreateRef.current)throw new RequestError(createNotice(pendingCreateRef.current));
    if(pendingRef.current)throw new RequestError('存在待核对的操作，请先核对原请求结果');
    const ws=encodeURIComponent(boundWorkspaceId!),id=(value:string)=>encodeURIComponent(value);
    const call:{path:string;method:string;body?:unknown}=action.kind==='bind'?{path:'accounts/'+id(action.accountId)+'/credential',method:'PUT',body:{password:action.password}}
      :action.kind==='disconnect'?{path:'accounts/'+id(action.accountId)+'/credential',method:'DELETE'}
      :action.kind==='sync'?{path:'accounts/'+id(action.accountId)+'/sync',method:'POST',body:{}}
      :action.kind==='send'?{path:'sends',method:'POST',body:{requestKey:action.requestKey,...(action.draftId?{draftId:action.draftId}:{}),...(action.input?{input:action.input}:{}),...(action.forwardOfId?{forwardOfId:action.forwardOfId}:{})}}
      :action.kind==='retry'?{path:'sends/'+id(action.sendId)+'/retry',method:'POST',body:action.confirmUnknown?{confirmUnknown:true}:{}}
      :{path:'sends/'+id(action.sendId)+'/verify',method:'POST',body:{}};
    if(action.kind==='send'&&(!mailRequestKey(action.requestKey)||!object(action.input)||!nonempty(action.input.accountId)))throw new RequestError('发送内容不完整，请重新核对后发送');
    const token=lock();
    // 只有发送意图会存本机（收件人/正文属于本人待发内容）；绑定密码等凭据动作从不持久。
    const intent:Pending|null=action.kind==='send'?{workspaceId:boundWorkspaceId!,requestId:action.requestKey,expectedRevision:snapshot.current!.revision,actorId:authority.userId,kind:'mail-send',mail:JSON.parse(JSON.stringify({requestKey:action.requestKey,...(action.draftId?{draftId:action.draftId}:{}),...(action.forwardOfId?{forwardOfId:action.forwardOfId}:{}),input:action.input}))}:null;
    try{
      if(intent)persist(intent,authority);
      const data=await request(BASE+'/'+ws+'/email/'+call.path,{method:call.method,...(call.body!==undefined?{body:JSON.stringify(call.body)}:{})});
      assertSource(authority,boundEpoch,boundWorkspaceId);const value=envelope(data.workspace,authority.userId!,boundWorkspaceId);
      if(intent)writeMailClaim(authority.userId!,mailSendAcknowledged(data,value,intent,authority.userId!));
      put(value,authority);if(intent)clearPending(authority);
      return {...(data.sync?{sync:data.sync}:{}),...(data.send?{send:data.send}:{})};
    }catch(failure){
      if(intent&&(pendingRef.current as Pending|null)?.requestId===intent.requestId&&mounted.current&&live.current.key===authority.key&&live.current.userId===authority.userId){
        if(mailReviewCode(failure)){holdForReview(intent,(failure as Error).message,authority);if(live.current.key===authority.key)await load(authority,boundWorkspaceId).catch(()=>undefined);throw failure;}
        if(mailSendSettled(failure))clearPending(authority);
        else{const message=(failure instanceof Error?failure.message:'发送未完成');const unsure=message.includes('发送结果尚未确认')?message:message+'；发送结果尚未确认，请核对原请求';if(live.current.key===authority.key)await load(authority,boundWorkspaceId).catch(()=>undefined);throw new RequestError(unsure,failure instanceof RequestError?failure.status:0,failure instanceof RequestError?failure.code:undefined);}
      }
      if(live.current.key===authority.key)await load(authority,boundWorkspaceId).catch(()=>undefined);
      throw failure;
    }finally{unlock(token,authority);}
  },[authority.key,authority.userId,authority.status,boundEpoch,boundWorkspaceId,assertSource,lock,load,put,unlock,persist,clearPending,holdForReview]);
  const run = React.useCallback(async (command: MistCommand) => {
    assertSource(authority, boundEpoch, boundWorkspaceId);
    if (pendingCreateRef.current) throw new RequestError(createNotice(pendingCreateRef.current));
    if (pendingRef.current) throw new RequestError('存在待核对的操作，请先核对原请求结果');
    const token = lock();
    try {
      const intent: Pending = { workspaceId: boundWorkspaceId!, requestId: crypto.randomUUID(), expectedRevision: snapshot.current!.revision, actorId: authority.userId, kind: 'command', command: JSON.parse(JSON.stringify(command)) };
      return await perform(intent, JSON.stringify({ requestId: intent.requestId, expectedRevision: intent.expectedRevision, command: intent.command }), authority);
    } finally { unlock(token, authority); }
  }, [authority.key, authority.userId, authority.status, boundEpoch, boundWorkspaceId, assertSource, lock, perform, unlock]);
  const uploadFile = React.useCallback(async (file: File,options?:MistUploadOptions) => {
    assertSource(authority, boundEpoch, boundWorkspaceId);
    const claimId=uploadTarget(options);
    if (pendingCreateRef.current) throw new RequestError(createNotice(pendingCreateRef.current));
    if (!file.size || file.size > 50 * 1024 * 1024) throw new RequestError('请上传一个不超过50MiB的实际文件');
    const token = lock();
    try {
      const digest = await fileDigest(file); assertSource(authority, boundEpoch, boundWorkspaceId);
      const previous = pendingRef.current;
      if (previous && (previous.kind !== 'upload' || previous.workspaceId !== boundWorkspaceId || previous.claimId!==claimId || previous.file?.name !== file.name || previous.file?.size !== file.size || previous.file.sha256 && previous.file.sha256 !== digest)) throw new RequestError('所选附件或案件目标与原上传不同，请先核对原上传结果');
      if (previous && !previous.file?.sha256) throw new RequestError('原上传记录缺少内容摘要，请先核对原上传回执，不能仅凭文件名重传');
      const intent: Pending = previous ?? { workspaceId: boundWorkspaceId!, requestId: crypto.randomUUID(), expectedRevision: snapshot.current!.revision, actorId: authority.userId, kind: 'upload', file: { name: file.name, size: file.size, sha256: digest },...(claimId===undefined?{}:{claimId}) };
      const form = new FormData(); form.append('file', file); form.append('requestId', intent.requestId); form.append('expectedRevision', String(intent.expectedRevision));
      if(intent.claimId!==undefined)form.append('claimId',intent.claimId);
      const acknowledged = await perform(intent, form, authority);
      const found = snapshot.current?.state.files.find(item => item.id === (acknowledged.result.fileId || acknowledged.result.id));
      if (!found) throw new RequestError('附件回执没有对应已保存的文件');
      return { ...found, url: BASE + '/' + encodeURIComponent(intent.workspaceId) + '/files/' + encodeURIComponent(found.id) };
    } finally { unlock(token, authority); }
  }, [authority.key, authority.userId, authority.status, boundEpoch, boundWorkspaceId, assertSource, lock, perform, unlock]);
  const fileUrl = React.useCallback((file: MistFile) => {
    assertSource(authority, boundEpoch, boundWorkspaceId);
    if (!snapshot.current?.state.files.some(item => item.id === file.id)) throw new RequestError('附件不属于当前工作区');
    return BASE + '/' + encodeURIComponent(boundWorkspaceId!) + '/files/' + encodeURIComponent(file.id);
  }, [authority.key, authority.userId, authority.status, boundEpoch, boundWorkspaceId, assertSource]);
  const downloadFile = React.useCallback(async (file: MistFile) => {
    const path = fileUrl(file), response = await fetch(path, { headers: apiService.getAuthHeaders(), credentials: 'include' });
    if (!response.ok) throw new RequestError('附件读取失败', response.status);
    const blob = await response.blob(); assertSource(authority, boundEpoch, boundWorkspaceId);
    const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = file.name; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 30000);
  }, [authority.key, authority.userId, authority.status, boundEpoch, boundWorkspaceId, fileUrl, assertSource]);
  const readCreditDocument = React.useCallback(async (creditId: string, versionId: string, draft: boolean) => {
    assertSource(authority, boundEpoch, boundWorkspaceId);
    if (!claimIdentifier(creditId) || !claimIdentifier(versionId)) throw new RequestError('CN 或版本编号无效');
    const path = BASE + '/' + encodeURIComponent(boundWorkspaceId!) + '/credits/' + encodeURIComponent(creditId) + '/versions/' + encodeURIComponent(versionId) + (draft ? '/preview.pdf' : '/document.pdf');
    const response = await fetch(path, { headers: apiService.getAuthHeaders(), credentials: 'include' });
    if (!response.ok) {
      let message = draft ? 'CN 草稿预览未完成' : '正式 CN 原件读取失败';
      try { const body = await response.json(); if (typeof body?.error?.message === 'string') message = body.error.message; } catch { /* Preserve the useful default when an upstream response is not JSON. */ }
      throw new RequestError(message, response.status);
    }
    if ((response.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/pdf') throw new RequestError('服务未返回有效的 CN PDF，请核对文档生成结果');
    const blob = await response.blob(); await creditPdfBytes(blob); assertSource(authority, boundEpoch, boundWorkspaceId);
    const disposition = response.headers.get('Content-Disposition') ?? '';
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
    let name = creditId + '-' + versionId + (draft ? '-DRAFT.pdf' : '.pdf');
    if (encoded) { try { name = decodeURIComponent(encoded); } catch { /* Keep the safe identifier filename. */ } }
    const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 30000);
  }, [authority.key, authority.userId, authority.status, boundEpoch, boundWorkspaceId, assertSource]);
  const prepareCreditDocument = React.useCallback((creditId: string, versionId: string) => readCreditDocument(creditId, versionId, true), [readCreditDocument]);
  const downloadCreditDocument = React.useCallback((creditId: string, versionId: string) => readCreditDocument(creditId, versionId, false), [readCreditDocument]);
  const issueCreditDocument = React.useCallback(async (creditId: string, versionId: string) => {
    if (!claimIdentifier(creditId) || !claimIdentifier(versionId)) throw new RequestError('CN 或版本编号无效');
    return (await run({ type: 'platform.credit.issue', payload: { creditId, versionId } })).result;
  }, [run]);
  const recover = React.useCallback(async (): Promise<MistRunReceipt | undefined> => {
    assertIdentity(authority);
    const intent = pendingRef.current; if (!intent) return;
    if(intent.kind==='archive'||intent.kind==='restore'){
      if(intent.actorId&&intent.actorId!==authority.userId)throw new RequestError('待核对请求属于其他账号');const token=lock();setError('');
      try{let data:any;try{data=await request(BASE+'/'+encodeURIComponent(intent.workspaceId)+'/receipts/'+encodeURIComponent(intent.requestId));}catch(failure){if(failure instanceof RequestError&&failure.status===404)return await performLifecycle(intent,authority);throw failure;}
        const acknowledged=receipt(data.receipt,intent);let next:any;const target=intent.kind==='restore'?intent.workspaceId:acknowledged.result.activeWorkspaceId;
        try{next=await request(BASE+'/'+encodeURIComponent(String(target)));}catch(failure){if(!(failure instanceof RequestError)||failure.status!==404)throw failure;next=await request(BASE+'/default');}
        return await adoptLifecycle({...next,receipt:acknowledged},intent,authority);
      }catch(failure){if(live.current.key===authority.key)setError(failure instanceof Error?failure.message:'原请求仍待核对');throw failure;}finally{unlock(token,authority);}
    }
    assertSource(authority, boundEpoch, boundWorkspaceId);
    if (intent.workspaceId !== boundWorkspaceId || intent.actorId && intent.actorId !== authority.userId) throw new RequestError('待核对请求属于其他账号或工作区');
    if (intent.kind === 'mail-send') {
      // 已转待人工核对：不再自动核对、不再重放，避免把不相符的回执当成已发或触发重发。
      if (intent.mail!.review) throw new RequestError('这封邮件待人工核对：' + intent.mail!.review + '。系统不会把它算作已发送，也不会自动重发；请在已发送 / 待发送中核对后关闭本记录', 409, MAIL_MANUAL);
      const token = lock(); setError('');
      try {
        const claimed = readMailClaims(authority.userId!).find(item => item.workspaceId === intent.workspaceId && item.requestKey === intent.requestId);
        if (claimed) {
          // 本机已结案（例如结案后、清理待核对记录前刷新或重启）：只读取当前空间核对原回执，不再提交发送。
          const next = await request(BASE + '/' + encodeURIComponent(intent.workspaceId)); assertSource(authority, boundEpoch, boundWorkspaceId);
          const value = envelope(next.workspace, authority.userId!, intent.workspaceId), row = ((value.state as any).email?.sends || []).find((item: any) => item?.id === claimed.sendId);
          mailSendAcknowledged({ send: { id: claimed.sendId, ...(claimed.alias ? { recoveredFor: intent.requestId } : {}) } }, value, intent, authority.userId!);
          put(value, authority); clearPending(authority);
          return { requestId: intent.requestId, revision: value.revision, result: { send: { id: claimed.sendId, status: row?.status, replayed: true, ...(claimed.alias ? { recovered: true, recoveredFor: intent.requestId } : {}) } } } as unknown as MistRunReceipt;
        }
        // 用原 requestKey 与原内容重放：服务端已登记则只返回原记录、不重复投递；从未收到则按已确认的原内容发送一次。
        const data = await request(BASE + '/' + encodeURIComponent(intent.workspaceId) + '/email/sends', { method: 'POST', body: mailSendBody(intent) });
        assertSource(authority, boundEpoch, boundWorkspaceId);
        const value = envelope(data.workspace, authority.userId!, intent.workspaceId);
        writeMailClaim(authority.userId!, mailSendAcknowledged(data, value, intent, authority.userId!));
        put(value, authority); clearPending(authority);
        return { requestId: intent.requestId, revision: value.revision, result: { send: data.send } } as unknown as MistRunReceipt;
      } catch (failure) {
        if (mounted.current && live.current.key === authority.key && live.current.userId === authority.userId && live.current.status === 'authenticated' && pendingRef.current?.requestId === intent.requestId) {
          if (mailReviewCode(failure)) holdForReview(intent, (failure as Error).message, authority);
          else if (mailSendSettled(failure)) clearPending(authority);
        }
        if (mailReviewCode(failure)) throw failure;
        // 由调用页面展示（邮箱页有专门的核对横幅）；不写入全局读取错误，避免误报“邮箱未读取”。
        const message = failure instanceof Error ? failure.message : '发送结果仍待核对';
        throw mailSendSettled(failure) || message.includes('发送结果尚未确认') ? failure : new RequestError(message + '；发送结果尚未确认，请稍后再核对', failure instanceof RequestError ? failure.status : 0, failure instanceof RequestError ? failure.code : undefined);
      } finally { unlock(token, authority); }
    }
    const token = lock(); setError('');
    try {
      let data: any;
      try { data = await request(BASE + '/' + encodeURIComponent(intent.workspaceId) + '/receipts/' + encodeURIComponent(intent.requestId)); }
      catch (failure) {
        assertSource(authority, boundEpoch, boundWorkspaceId);
        if (failure instanceof RequestError && failure.status === 404 && intent.kind === 'command') return await perform(intent, JSON.stringify({ requestId: intent.requestId, expectedRevision: intent.expectedRevision, command: intent.command }), authority);
        if (failure instanceof RequestError && failure.status === 404 && intent.kind === 'member') return await perform(intent, JSON.stringify({ requestId: intent.requestId, expectedRevision: intent.expectedRevision, action: intent.action, account: intent.account }), authority);
        throw failure;
      }
      assertSource(authority, boundEpoch, boundWorkspaceId); const acknowledged = receipt(data.receipt, intent);
      const next = await request(BASE + '/' + encodeURIComponent(intent.workspaceId)); assertSource(authority, boundEpoch, boundWorkspaceId);
      const value = envelope(next.workspace, authority.userId!, intent.workspaceId);
      validateReceiptState(value, acknowledged, intent);
      put(value, authority); clearPending(authority); return acknowledged;
    } catch (failure) {
      if (mounted.current && live.current.key === authority.key && live.current.userId === authority.userId && live.current.status === 'authenticated') setError(failure instanceof Error ? failure.message : '原请求仍待核对');
      throw failure;
    } finally { unlock(token, authority); }
  }, [authority.key, authority.userId, authority.status, boundEpoch, boundWorkspaceId, assertIdentity,assertSource, lock, perform,performLifecycle,adoptLifecycle, put, clearPending, unlock, holdForReview]);
  const closeMailReview = React.useCallback(async () => {
    assertIdentity(authority);
    const intent = pendingRef.current;
    if (!intent || intent.kind !== 'mail-send' || !intent.mail?.review) throw new RequestError('没有待人工核对的发送记录');
    if (intent.actorId && intent.actorId !== authority.userId) throw new RequestError('待核对请求属于其他账号');
    // 只关闭本机待核对记录，不提交、不重发；不写入结案登记（没有可认领的回执）。
    clearPending(authority);
  }, [authority.key, authority.userId, authority.status, assertIdentity, clearPending]);
  const switchWorkspace = React.useCallback(async (id: string) => {
    assertIdentity(authority);
    if (mutation.current || pendingRef.current || pendingCreateRef.current) throw new RequestError('请先核对未完成操作');
    if (!nonempty(id)) throw new RequestError('请选择有效工作区');
    await load(authority, id, true);
  }, [authority.key, authority.userId, authority.status, assertIdentity, load]);
  const createWorkspace = React.useCallback(async (name: string, seed: 'demo' | 'empty' = 'empty') => {
    assertIdentity(authority);
    if (pendingRef.current || navigating.current || boundEpoch !== scopeEpoch.current) throw new RequestError('请先核对当前操作或在当前工作区重试');
    const normalizedName = name.trim();
    if (!normalizedName || normalizedName.length > 120 || !['demo', 'empty'].includes(seed)) throw new RequestError('请输入有效工作区名称和初始方式');
    const previous = pendingCreateRef.current;
    if (previous && (previous.name !== normalizedName || previous.seed !== seed)) throw new RequestError(createNotice(previous));
    const intent: MistPendingCreate = previous ?? { actorId: authority.userId!, slug: crypto.randomUUID(), name: normalizedName, seed };
    const token = lock();
    let submitted = false, responded = false;
    try {
      persistCreate(intent, authority); setError(''); submitted = true;
      const data = await request(BASE, { method: 'POST', body: JSON.stringify({ name: intent.name, seed: intent.seed, slug: intent.slug }) }); responded = true; assertIdentity(authority);
      const value = envelope(data.workspace, authority.userId!);
      const requestId = 'create:' + intent.slug;
      const acknowledgement = await request(BASE + '/' + encodeURIComponent(value.id) + '/receipts/' + encodeURIComponent(requestId)); assertIdentity(authority);
      if (acknowledgement.receipt?.requestId !== requestId || acknowledgement.receipt.revision !== 0 || acknowledgement.receipt.result?.workspaceId !== value.id) throw new RequestError('创建回执与原请求或工作区不一致');
      scopeEpoch.current++; wanted.current = value.id; put(value, authority); rememberSelection(value.id, authority);
      await load(authority, value.id); assertIdentity(authority); clearCreate(authority);
      setError(currentError => currentError === createNotice(intent) ? '' : currentError);
    } catch (failure) {
      if (mounted.current && live.current.key === authority.key && live.current.userId === authority.userId && live.current.status === 'authenticated') {
        const known = !previous && (!submitted || !responded && failure instanceof RequestError && failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status) && failure.code !== 'REQUEST_CONFLICT');
        if (known && pendingCreateRef.current?.slug === intent.slug) clearCreate(authority);
        setError((failure instanceof Error ? failure.message : '创建工作区失败') + (known ? '' : '；' + createNotice(intent)));
      }
      throw failure;
    } finally { unlock(token, authority); }
  }, [authority.key, authority.userId, authority.status, boundEpoch, assertIdentity, lock, load, put, rememberSelection, persistCreate, clearCreate, unlock]);
  const changeArchive=React.useCallback(async(kind:'archive'|'restore',id?:string)=>{
    assertIdentity(authority);if(pendingRef.current||pendingCreateRef.current||navigating.current)throw new RequestError('请先核对未完成操作');
    if(kind==='archive')assertSource(authority,boundEpoch,boundWorkspaceId);const row=kind==='archive'?snapshot.current:archivedWorkspaces.find(row=>row.id===id);if(!row)throw new RequestError('工作区不存在，请刷新回收站');
    const token=lock();try{await performLifecycle({workspaceId:row.id,expectedRevision:row.revision,requestId:crypto.randomUUID(),actorId:authority.userId,kind},authority);}finally{unlock(token,authority);}
  },[authority.key,authority.userId,authority.status,boundEpoch,boundWorkspaceId,archivedWorkspaces,assertIdentity,assertSource,lock,performLifecycle,unlock]);
  return <Context.Provider value={{ state: visible?.state ?? null, workspace: visible, workspaces: scopeIsCurrent ? workspaces : [], archivedWorkspaces:scopeIsCurrent?archivedWorkspaces:[],refreshArchived,archiveWorkspace:()=>changeArchive('archive'),restoreWorkspace:id=>changeArchive('restore',id),changeMember,mail,closeMailReview,loading: scopeIsCurrent ? loading : session.status !== 'anonymous', error: scopeIsCurrent ? error : '', saving: scopeIsCurrent ? saving : false, pending: scopeIsCurrent ? pending : null, pendingCreate: scopeIsCurrent ? pendingCreate : null, run, uploadFile, downloadFile, prepareCreditDocument, issueCreditDocument, downloadCreditDocument, fileUrl, refresh, recover, switchWorkspace, createWorkspace }}>{children}</Context.Provider>;
}
export function useMistWorkspace(): MistWorkspaceContext {
  const context = React.useContext(Context); if (!context) throw new Error('useMistWorkspace must be used inside MistWorkspaceProvider'); return context;
}
