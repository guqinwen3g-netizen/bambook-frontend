import { apiService } from './apiService';
import { getAuthState } from './authService';

// Mirrors the public orderCostReviewSource parser, without bundling server/Prisma.
export const REVIEW_CATEGORIES = ['procurement', 'companySupply', 'logistics', 'otherExpenses', 'bankFees', 'allowances'] as const;
export type ReviewCategory = typeof REVIEW_CATEGORIES[number];
export type ReviewCoverage = { status: 'pending' | 'verified' | 'not_applicable'; note: string; evidenceIds: string[] };
export type ReviewBill = { invoiceId: string; purchaseOrderId: string; purchaseLineIds: string[]; serviceDeliveryIds: string[]; treatment: 'cost' | 'stock_valuation'; evidenceIds: string[] };
export type ReviewSupply = { movementId: string; valuationInvoiceId: string; orderLineId: string; inputQuantity: string; usedQuantity: string; lossQuantity: string; unusedQuantity: string; unit: string; evidenceIds: string[] };
export type ReviewExpense = { costRecordId: string; category: 'logistics' | 'otherExpenses'; treatment: 'cost' | 'not_applicable'; note: string; evidenceIds: string[]; exchangeRate?: string; fxEvidenceIds?: string[] };
export type OrderCostReviewInput = { sourceFingerprint: string; bills: ReviewBill[]; supply: ReviewSupply[]; expenses: ReviewExpense[]; coverage: Record<ReviewCategory, ReviewCoverage> };
export type ConfirmCostReviewInput = OrderCostReviewInput & { expectedRevision: number; requestId: string; note: string };
export type ReviewSourceRow = { id: string; [key: string]: any };
export type ReviewEvidence = { id: string; orderId: string; originalName: string; mimeType: string; byteSize: number; sha256: string; note: string; createdBy: string; createdAt: string; auditId: string; requestId?: string; requestKey?: string; requestFingerprint?: string };
export type ReviewPreview = { status: 'pending' | 'complete'; pendingReasons: string[]; actualCostCny: number | null; actualRevenueCny: number | null; actualBreakdown: Record<ReviewCategory, number> | null; scopeSnapshot: Record<string, unknown> };
export type ReviewHistory = { id: string; orderId?: string; revision: number; sourceFingerprint: string; actualCostCny: number | null; actualRevenueCny: number | null; confirmedBy: string; confirmedAt: string; auditId: string; scopeSnapshot: Record<string, unknown> };
export type CostReviewAccount = {
  orderId: string; sourceFingerprint: string; currentRevision: number;
  sources: { order: ReviewSourceRow; orderLines: ReviewSourceRow[]; purchaseOrders: ReviewSourceRow[]; deliveries: ReviewSourceRow[]; invoices: ReviewSourceRow[]; costRecords: ReviewSourceRow[]; movements: ReviewSourceRow[]; vouchers: ReviewSourceRow[]; creditAllocations: ReviewSourceRow[]; costEvidence: ReviewSourceRow[]; [key: string]: any };
  current: Partial<ReviewPreview> & { status: 'pending' | 'complete' | 'stale'; reviewId?: string; reviewRevision?: number; confirmedAt?: string; confirmedBy?: string };
  history: ReviewHistory[]; evidence: ReviewEvidence[];
};
export type ConfirmCostReviewResult = { replayed: boolean; item: ReviewHistory & { orderId: string; requestKey: string; requestFingerprint: string; linesSnapshot: { input: OrderCostReviewInput; request: { requestId: string; expectedRevision: number; note: string } }; coverageSnapshot: OrderCostReviewInput['coverage'] } };
export type UploadCostReviewCommand = { originalName: string; mimeType: string; byteSize: number; sha256: string; note: string };
export type UploadCostReviewResult = { evidence: ReviewEvidence; replayed: boolean; requestId?: string; request?: Record<string, unknown> };
export type RetireCostReviewResult = ({ kind: 'Confirmed'; requestId: string; requestKey: string; requestFingerprint: string } & ConfirmCostReviewResult) | { kind: 'Retired'; orderId: string; requestId: string; requestKey: string; requestFingerprint: string; command: ConfirmCostReviewInput; auditId: string; actorId: string; createdAt: string; replayed: boolean };

export class CostReviewError extends Error {
  constructor(message: string, public status?: number, public code?: string) { super(message); }
}
export type ReviewSession = { userId: string; baseUrl: string; identity: string; headers: Record<string, string> };
/** Token/header values only live in memory; recovery keys contain actor+endpoint,
 * never credentials. No owner role shortcut is used for these financial controls. */
export function captureReviewSession(): ReviewSession {
  const auth = getAuthState(); const headers = apiService.getAuthHeaders();
  const baseUrl = apiService.buildApiUrl('/v1/pricing/order-cost-reviews', apiService.getStoredConfig().cloudEndpoint);
  const userId = auth.isAuthenticated ? auth.user?.id ?? '' : '';
  const identity = JSON.stringify([userId, baseUrl, headers, auth.user?.permissions ?? [], (auth.user as any)?.permissionCeiling ?? null]);
  return { userId, baseUrl, headers, identity };
}
export const reviewSessionCurrent = (session: ReviewSession) => session.identity === captureReviewSession().identity;
export function reviewPermission(scope: string): boolean {
  const user = getAuthState().user;
  if (!user || !getAuthState().isAuthenticated) return false;
  const scopes = user.permissions ?? [], ceiling = (user as any).permissionCeiling as string[] | undefined;
  return (!ceiling || ceiling.includes('*') || ceiling.includes(scope)) && (scopes.includes('*') || scopes.includes(scope));
}
export const canonicalReview = (value: unknown): string => {
  const sorted = (item: any): any => Array.isArray(item) ? item.map(sorted).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sorted(item[key])])) : item;
  return JSON.stringify(sorted(value));
};
async function hashReview(value: unknown): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalReview(value))))).map(byte => byte.toString(16).padStart(2, '0')).join('');
}
/** Check the server's immutable command identity independently of latest state. */
export async function validateOriginalReviewHashes(row: { requestKey?: string; requestFingerprint?: string }, orderId: string, session: ReviewSession, requestId: string, payload: object) {
  const [key, fingerprint] = await Promise.all([hashReview({ orderId, actorId: session.userId, requestId }), hashReview(payload)]);
  stillCurrent(session);
  if (row.requestKey !== key || row.requestFingerprint !== fingerprint) throw new CostReviewError('原请求指纹与回执不一致，请保留原内容及编号重试', undefined, 'ACK_UNKNOWN');
}
function stillCurrent(session: ReviewSession) {
  if (!reviewSessionCurrent(session)) throw new CostReviewError('账号、权限或服务地址已变化，请重新读取当前订单', undefined, 'SESSION_CHANGED');
}
async function checked(session: ReviewSession, path: string, init: RequestInit = {}, blob = false) {
  stillCurrent(session);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
  try {
    const headers = new Headers(session.headers);
    if (init.body instanceof FormData || blob) headers.delete('Content-Type');
    const res = await fetch(`${session.baseUrl}/${path}`, { ...init, headers, credentials: 'include', signal: controller.signal });
    stillCurrent(session);
    if (!res.ok) {
      const body = await res.json().catch(() => null); stillCurrent(session);
      throw new CostReviewError(body?.error?.message || (typeof body?.error === 'string' ? body.error : `核对请求失败（HTTP ${res.status}）`), res.status, body?.error?.code);
    }
    const result = blob ? await res.blob() : await res.json(); stillCurrent(session); return result;
  } catch (error) {
    stillCurrent(session);
    if (error instanceof CostReviewError) throw error;
    throw new CostReviewError(controller.signal.aborted ? '请求超时，结果尚未确认，请重试原请求' : '请求结果尚未确认，请检查网络后重试原请求', undefined, 'ACK_UNKNOWN');
  } finally { clearTimeout(timer); }
}
export function validateReviewAccount(value: CostReviewAccount, orderId: string) {
  if (value?.orderId !== orderId || !/^[a-f0-9]{64}$/.test(value.sourceFingerprint) || !Number.isSafeInteger(value.currentRevision) || value.currentRevision < 0
    || value.sources?.order?.id !== orderId || !['pending', 'complete', 'stale'].includes(value.current?.status) || !Array.isArray(value.history) || !Array.isArray(value.evidence)
    || ['orderLines', 'purchaseOrders', 'deliveries', 'invoices', 'costRecords', 'movements', 'vouchers', 'creditAllocations', 'costEvidence'].some(key => !Array.isArray(value.sources[key]))
    || value.evidence.some(row => row.orderId !== orderId || !row.id || !row.auditId || !/^[a-f0-9]{64}$/.test(row.sha256))) throw new CostReviewError('订单核对来源或凭据回执不完整，请重新读取');
  return value;
}
export function validateConfirmAck(result: ConfirmCostReviewResult, orderId: string, session: ReviewSession, command: ConfirmCostReviewInput) {
  const item = result?.item, { requestId, expectedRevision, note, ...input } = command;
  if (typeof result?.replayed !== 'boolean' || !item?.id || !item.auditId || item.orderId !== orderId || item.confirmedBy !== session.userId
    || item.revision !== expectedRevision + 1 || item.sourceFingerprint !== input.sourceFingerprint || !item.confirmedAt
    || canonicalReview(item.linesSnapshot?.request) !== canonicalReview({ requestId, expectedRevision, note })
    || canonicalReview(item.linesSnapshot?.input) !== canonicalReview(input) || canonicalReview(item.coverageSnapshot) !== canonicalReview(input.coverage)) throw new CostReviewError('确认回执未匹配完整原请求，请保留原内容及编号重试', undefined, 'ACK_UNKNOWN');
}
export async function inspectReviewFile(file: File, note: string): Promise<UploadCostReviewCommand> {
  if (!file || file.size < 1 || file.size > 10 * 1024 * 1024) throw new CostReviewError('请选择不超过 10MiB 的有效凭据');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const originalName = file.name.replace(/\\/g, '/').split('/').pop()!.replace(/[\x00-\x1f\x7f]/g, '').trim();
  const ext = originalName.split('.').pop()?.toLowerCase();
  const mimeType = ext === 'pdf' && String.fromCharCode(...bytes.slice(0, 5)) === '%PDF-' ? 'application/pdf'
    : ext === 'png' && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte) ? 'image/png'
      : ['jpg', 'jpeg'].includes(ext ?? '') && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' : '';
  if (!mimeType || !originalName || originalName.length > 180 || !note.trim() || note.trim().length > 2000) throw new CostReviewError('请选择内容与扩展名相符的 PDF、PNG 或 JPEG，并填写凭据说明');
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(byte => byte.toString(16).padStart(2, '0')).join('');
  return { originalName, mimeType, byteSize: bytes.length, sha256, note: note.trim() };
}
export function validateUploadAck(result: UploadCostReviewResult, orderId: string, session: ReviewSession, requestId: string, command: UploadCostReviewCommand) {
  const row = result?.evidence;
  if (row?.requestId !== requestId || typeof result.replayed !== 'boolean' || !row?.id || !row.auditId || row.orderId !== orderId || row.createdBy !== session.userId
    || ['originalName', 'mimeType', 'byteSize', 'sha256', 'note'].some(key => row[key as keyof ReviewEvidence] !== command[key as keyof UploadCostReviewCommand])) throw new CostReviewError('上传回执未匹配完整原文件及请求编号，请保留原请求重试', undefined, 'ACK_UNKNOWN');
}
export async function validateRetireAck(result: RetireCostReviewResult, orderId: string, session: ReviewSession, command: ConfirmCostReviewInput) {
  if (result?.kind === 'Confirmed') {
    validateConfirmAck(result, orderId, session, command);
    if (result.requestId !== command.requestId || result.requestKey !== result.item.requestKey || result.requestFingerprint !== result.item.requestFingerprint) throw new CostReviewError('原确认处置回执与原请求编号不一致，请保留原内容重试', undefined, 'ACK_UNKNOWN');
    await validateOriginalReviewHashes(result.item, orderId, session, command.requestId, command); return;
  }
  if (result?.kind !== 'Retired' || result.orderId !== orderId || result.actorId !== session.userId || result.requestId !== command.requestId
    || !result.auditId || !result.createdAt || typeof result.replayed !== 'boolean' || canonicalReview(result.command) !== canonicalReview(command)) throw new CostReviewError('结束请求回执未匹配完整原命令，请保留原内容及编号重试', undefined, 'ACK_UNKNOWN');
  await validateOriginalReviewHashes(result, orderId, session, command.requestId, command);
}
const segment = encodeURIComponent;
export const orderCostReviewService = {
  async list(orderId: string, session = captureReviewSession()): Promise<CostReviewAccount> { return validateReviewAccount(await checked(session, segment(orderId)), orderId); },
  async preview(orderId: string, input: OrderCostReviewInput, session = captureReviewSession()): Promise<ReviewPreview> {
    const value = await checked(session, `${segment(orderId)}/preview`, { method: 'POST', body: JSON.stringify(input) });
    if (!['pending', 'complete'].includes(value?.status) || !Array.isArray(value.pendingReasons)) throw new CostReviewError('预览结果未确认，请重试'); return value;
  },
  async confirm(orderId: string, command: ConfirmCostReviewInput, session = captureReviewSession()): Promise<ConfirmCostReviewResult> {
    const value = await checked(session, `${segment(orderId)}/confirm`, { method: 'POST', body: JSON.stringify(command) });
    validateConfirmAck(value, orderId, session, command); await validateOriginalReviewHashes(value.item, orderId, session, command.requestId, command); return value;
  },
  async retire(orderId: string, command: ConfirmCostReviewInput, session = captureReviewSession()): Promise<RetireCostReviewResult> {
    const value = await checked(session, `${segment(orderId)}/requests/retire`, { method: 'POST', body: JSON.stringify(command) });
    await validateRetireAck(value, orderId, session, command); return value;
  },
  async upload(orderId: string, file: File, requestId: string, command: UploadCostReviewCommand, session = captureReviewSession()): Promise<UploadCostReviewResult> {
    if (canonicalReview(await inspectReviewFile(file, command.note)) !== canonicalReview(command)) throw new CostReviewError('所选文件与原上传命令不同，请重新选择同一原文件');
    stillCurrent(session);
    const form = new FormData(); form.append('file', file, command.originalName); form.append('requestId', requestId); form.append('note', command.note);
    const value = await checked(session, `${segment(orderId)}/evidence`, { method: 'POST', body: form });
    validateUploadAck(value, orderId, session, requestId, command); await validateOriginalReviewHashes(value.evidence, orderId, session, requestId, command); return value;
  },
  async download(orderId: string, evidence: ReviewEvidence, session = captureReviewSession()) {
    const blob: Blob = await checked(session, `${segment(orderId)}/evidence/${segment(evidence.id)}/download`, {}, true);
    const bytes = await blob.arrayBuffer(); stillCurrent(session);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(byte => byte.toString(16).padStart(2, '0')).join('');
    stillCurrent(session);
    if (bytes.byteLength !== evidence.byteSize || hash !== evidence.sha256) throw new CostReviewError('下载凭据与原文件不一致，请联系负责人核查');
    const href = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = href; link.download = evidence.originalName; link.hidden = true; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  },
};
