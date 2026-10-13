import { apiService } from './apiService';
import { emailApiUrl } from './emailReadService';
import { getAuthState } from './authService';

export type CustomerConfirmationOutcome = 'accepted' | 'rejected' | 'partial';
export type CustomerConfirmationChannel = 'email' | 'screenshot' | 'phone' | 'meeting' | 'other';

export interface CustomerConfirmationTarget {
  targetType: string;
  targetId: string;
  businessLabel?: string;
  businessReference?: string | null;
  versionLabel?: string | null;
  scopeLabel?: string | null;
  finalContentFingerprint: string;
  internalApprovalId: string | null;
  scopeFingerprint: string;
  scope: unknown;
  nativeStatus?: unknown;
  recommendation?: { orderId?: string; relationId?: string; subject?: string; fromAddress?: string };
}

export interface CustomerConfirmationMailSourceIdentity {
  mailbox: string;
  uid: string | number;
  subject: string;
  sender: string;
  date: string | Date;
}

export interface CustomerConfirmationPartialOption {
  id: string;
  label: string;
}

export interface CustomerConfirmationPartialScope {
  options: CustomerConfirmationPartialOption[];
  /** The target adapter validates this exact structured selection on the server. */
  encodeSelection: (acceptedIds: string[]) => unknown;
}

export interface CustomerConfirmationRecordResult {
  ok: true;
  saved: true;
  confirmation: any;
  evidenceId: string | null;
  replayed: boolean;
  nativeStatus: unknown;
  effect: unknown;
  continuationStatus: 'completed' | 'pending' | 'not_applicable';
  continuationFailure: { code: string; message: string } | null;
}

/** In-memory fence for async confirmation work; never persisted or logged. */
export function customerConfirmationIdentityStamp(): string {
  const auth = getAuthState(), user = auth.user;
  return JSON.stringify([
    apiService.getStoredConfig().cloudEndpoint,
    apiService.getAuthHeaders(),
    auth.isAuthenticated,
    auth.isLoading,
    user?.id ?? null,
    user?.roles ?? [],
    user?.roleIds ?? [],
    user?.permissions ?? [],
    user?.permissionCeiling ?? null,
    user?.departmentIds ?? [],
    user?.department ?? null,
  ]);
}

function currentHeaders(jsonContentType = true): Record<string, string> {
  const headers = { ...apiService.getAuthHeaders() };
  if (!jsonContentType) {
    for (const key of Object.keys(headers)) if (key.toLowerCase() === 'content-type') delete headers[key];
  }
  return headers;
}

async function readJson(response: Response): Promise<any> {
  let payload: any;
  try { payload = await response.json(); } catch { throw new Error('客户确认服务返回格式不完整，请重新读取。'); }
  if (!response.ok) {
    const message = payload?.error?.message || payload?.error || `客户确认请求未完成（HTTP ${response.status}）。`;
    throw Object.assign(new Error(String(message)), { status: response.status, code: payload?.error?.code });
  }
  return payload;
}

export async function searchCustomerConfirmationEmails(input: {
  query?: string;
  searchBy?: 'subject' | 'fromAddress';
  recommendationsOnly?: boolean;
  target?: CustomerConfirmationTarget;
  limit?: number;
}, signal?: AbortSignal): Promise<any[]> {
  const query = input.query?.trim() || '';
  const recommendation = input.recommendationsOnly ? input.target?.recommendation : undefined;
  const params = new URLSearchParams({ limit: String(Math.max(1, Math.min(input.limit ?? 30, 100))), offset: '0' });
  if (query) params.set(input.searchBy === 'fromAddress' ? 'fromAddress' : 'subject', query);
  if (recommendation?.orderId) params.set('orderId', recommendation.orderId);
  if (recommendation?.relationId) params.set('relationId', recommendation.relationId);
  if (recommendation?.fromAddress && !query) params.set('fromAddress', recommendation.fromAddress);
  if (!query && !recommendation?.orderId && !recommendation?.relationId && !recommendation?.fromAddress)
    throw new Error('请先输入邮件主题关键字，或从当前客户/订单推荐结果开始查找。');
  const response = await fetch(emailApiUrl(`/v1/email?${params.toString()}`), {
    headers: currentHeaders(), credentials: 'include', signal,
  });
  const payload = await readJson(response);
  if (payload?.ok !== true || !Array.isArray(payload.items) || !Number.isSafeInteger(payload.total) || payload.total < 0)
    throw new Error('邮件列表未能完整核验，请重新搜索。');
  return payload.items.map((row: any) => {
    if (!row || typeof row.id !== 'string' || typeof row.subject !== 'string'
      || typeof row.fromAddress !== 'string' || typeof row.bodyText !== 'string' && row.bodyText !== null
      || !Array.isArray(row.attachments)) throw new Error('邮件列表包含无法核验的记录，请重新搜索。');
    return row;
  });
}

export async function fetchCustomerConfirmationEmail(id: string, signal?: AbortSignal): Promise<any> {
  const response = await fetch(emailApiUrl(`/v1/email/${encodeURIComponent(id)}`), {
    headers: currentHeaders(), credentials: 'include', signal,
  });
  const payload = await readJson(response);
  const row = payload?.data;
  if (payload?.ok !== true || !row || row.id !== id || typeof row.bodyText !== 'string' || !Array.isArray(row.attachments))
    throw new Error('所选邮件没有可核验的纯文本正文；请改选邮件或上传截图。');
  return row;
}

function senderAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const angle = value.match(/<\s*([^<>]+?)\s*>/);
  const candidate = (angle?.[1] ?? value).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(candidate) ? candidate : null;
}

/**
 * Resolve a live mailbox item only through its persisted mailbox+UID projection.
 * Ambiguous UID matches, outgoing mail, or mismatched message headers fail closed;
 * the returned body is always fetched from the server-owned Email row.
 */
export async function resolveCustomerConfirmationEmailFromMailbox(
  source: CustomerConfirmationMailSourceIdentity,
  signal?: AbortSignal,
): Promise<any> {
  const mailbox = source.mailbox.trim(), uid = String(source.uid).trim();
  if (!mailbox || !/^\d+$/.test(uid) || !source.subject.trim() || !senderAddress(source.sender)
    || !Number.isFinite(new Date(source.date).getTime()))
    throw new Error('当前邮件的邮箱、UID、发件人或时间不完整，无法安全关联已同步原件。');
  const url = emailApiUrl(`/v1/email/intents?mailbox=${encodeURIComponent(mailbox)}&uids=${encodeURIComponent(uid)}`);
  const response = await fetch(url, { headers: currentHeaders(), credentials: 'include', signal });
  const payload = await readJson(response);
  if (payload?.ok !== true || !Array.isArray(payload.items)) throw new Error('已同步邮件映射读取不完整，请重试。');
  const matches = payload.items.filter((row: any) => String(row?.uid) === uid && typeof row?.id === 'string' && row.id.startsWith('EML__'));
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? '本封邮件尚未同步为可核验的业务邮件；请先同步当前邮件后重试。'
      : '邮箱 UID 对应多条已同步记录，无法确认原件；请联系管理员核对邮件同步记录。');
  }
  const row = await fetchCustomerConfirmationEmail(matches[0].id, signal);
  const sourceDate = new Date(source.date).getTime();
  const persistedDate = new Date(row.sentAt ?? row.receivedAt ?? '').getTime();
  if (row.direction !== 'inbound' || row.mailbox !== mailbox || String(row.uid) !== uid
    || row.subject !== source.subject.trim() || senderAddress(row.fromAddress) !== senderAddress(source.sender)
    || !Number.isFinite(persistedDate) || Math.abs(persistedDate - sourceDate) > 1_000) {
    throw new Error('已同步记录与当前选中的邮件身份不一致；未使用该记录，请重新同步并核对。');
  }
  return row;
}

export async function searchCustomerConfirmationTargets(
  emailId: string,
  businessReference = '',
  signal?: AbortSignal,
): Promise<CustomerConfirmationTarget[]> {
  if (!emailId.trim()) throw new Error('请先读取已同步的客户来信。');
  const params = new URLSearchParams({ emailId: emailId.trim() });
  const reference = businessReference.trim();
  if (reference) params.set('businessReference', reference);
  const response = await fetch(apiService.buildApiUrl(`/v1/customer-confirmations/targets?${params.toString()}`), {
    headers: currentHeaders(), credentials: 'include', signal,
  });
  const payload = await readJson(response);
  if (payload?.ok !== true || payload.emailId !== emailId || !Array.isArray(payload.candidates))
    throw new Error('当前邮件对应业务事项未能完整核验，请重新搜索。');
  return payload.candidates.map((row: any) => {
    if (!row || typeof row.targetType !== 'string' || typeof row.targetId !== 'string'
      || !/^[a-f0-9]{64}$/.test(row.finalContentFingerprint)
      || !/^[a-f0-9]{64}$/.test(row.scopeFingerprint) || !row.scope || typeof row.scope !== 'object')
      throw new Error('业务事项搜索结果缺少当前版本或确认范围，不能用于登记。');
    return row as CustomerConfirmationTarget;
  });
}

export async function recordCustomerConfirmation(input: {
  target: CustomerConfirmationTarget;
  outcome: CustomerConfirmationOutcome;
  decisionScope?: unknown;
  customerName: string;
  customerAddress?: string;
  confirmedAt: string;
  channel: CustomerConfirmationChannel;
  idempotencyKey: string;
  source: { kind: 'email_selection'; emailId: string; selectedText: string; selectionStart: number; selectionEnd: number; attachmentIds: string[] }
    | { kind: 'screenshot' };
  screenshot?: File | null;
  supersedesConfirmationId?: string;
  correctionReason?: string;
}): Promise<CustomerConfirmationRecordResult> {
  const command = {
    targetType: input.target.targetType,
    targetId: input.target.targetId,
    finalContentFingerprint: input.target.finalContentFingerprint,
    internalApprovalId: input.target.internalApprovalId,
    scopeFingerprint: input.target.scopeFingerprint,
    scope: input.target.scope,
    ...(input.outcome === 'partial' ? { decisionScope: input.decisionScope } : {}),
    outcome: input.outcome,
    customerName: input.customerName.trim(),
    customerAddress: input.customerAddress?.trim() || null,
    confirmedAt: input.confirmedAt,
    channel: input.channel,
    idempotencyKey: input.idempotencyKey,
    supersedesConfirmationId: input.supersedesConfirmationId ?? null,
    correctionReason: input.correctionReason?.trim() || null,
  };
  const form = new FormData();
  form.set('command', JSON.stringify(command));
  form.set('source', JSON.stringify(input.source));
  if (input.source.kind === 'screenshot') {
    if (!input.screenshot) throw new Error('请随本次提交选择客户截图原件。');
    form.set('file', input.screenshot, input.screenshot.name);
  }
  const response = await fetch(emailApiUrl('/v1/customer-confirmations'), {
    method: 'POST', headers: currentHeaders(false), credentials: 'include', body: form,
  });
  const payload = await readJson(response);
  if (payload?.ok !== true || payload.saved !== true || !payload.confirmation?.id
    || !['completed', 'pending', 'not_applicable'].includes(payload.continuationStatus))
    throw new Error('保存回读未确认，请刷新业务详情核对本次结果后再重试。');
  return payload as CustomerConfirmationRecordResult;
}

export async function readCustomerConfirmations(target: CustomerConfirmationTarget, signal?: AbortSignal): Promise<any> {
  const path = `/v1/customer-confirmations/by-target/${encodeURIComponent(target.targetType)}/${encodeURIComponent(target.targetId)}`;
  const response = await fetch(apiService.buildApiUrl(path), { headers: currentHeaders(), credentials: 'include', signal });
  const payload = await readJson(response);
  if (payload?.ok !== true || payload.target?.finalContentFingerprint !== target.finalContentFingerprint
    || payload.target?.scopeFingerprint !== target.scopeFingerprint || !Array.isArray(payload.confirmations))
    throw new Error('业务版本或客户确认回读不一致，请重新打开当前业务。');
  return payload;
}

export async function fetchCustomerEvidenceFile(fileId: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(apiService.buildApiUrl(`/v1/customer-confirmations/files/${encodeURIComponent(fileId)}`), {
    headers: currentHeaders(), credentials: 'include', signal,
  });
  if (!response.ok) throw Object.assign(new Error('证据原件暂时不可读取或当前无权访问。'), { status: response.status });
  return response.blob();
}
