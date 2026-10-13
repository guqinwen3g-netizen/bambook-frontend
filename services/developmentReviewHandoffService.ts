import { apiService } from './apiService';
import { getAuthState, hasPermission } from './authService';
import { dashboardReadIdentity } from './dashboardTaskService';
import { parseDevelopmentSampleQcReview, type DevelopmentSampleQcReview } from './qcService';
import type { DevelopmentReviewHandoffHistory, DevelopmentReviewHandoffInput, DevelopmentReviewHandoffOperation, DevelopmentReviewHandoffReceipt, DevelopmentReviewQcUser } from '../server/src/development/developmentReviewHandoffContract';
export type { DevelopmentReviewHandoffHistory, DevelopmentReviewHandoffInput, DevelopmentReviewHandoffOperation, DevelopmentReviewHandoffReceipt, DevelopmentReviewQcUser } from '../server/src/development/developmentReviewHandoffContract';

export interface DevelopmentReviewEvidenceFile {
  id: string; name: string; mimeType: string; size: number; sha256: string; uploadedBy: string; uploadedAt: string;
  sourceKind: 'development_review'; sourceId: string; sourceFingerprint: string;
}
export interface DevelopmentReviewHandoffContext {
  item: DevelopmentSampleQcReview; actorId: string; expectedUpdatedAt: string;
  currentExecutor: { id: string; displayName: string | null } | null;
  canClaim: boolean; canAssign?: boolean; canStart?: boolean; canTransfer: boolean; canExecute: boolean;
  users: DevelopmentReviewQcUser[]; history: DevelopmentReviewHandoffHistory[]; files: DevelopmentReviewEvidenceFile[];
}
export type DevelopmentReviewIdentity = Pick<DevelopmentSampleQcReview, 'id' | 'developmentCaseId' | 'sampleBatchId' | 'sampleVersionId' | 'sourceFingerprint'>;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const digits = (value: unknown): value is string => typeof value === 'string' && /^\d+$/.test(value);
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const developmentReviewPayloadHash = async (value: unknown): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)))))
  .map(byte => byte.toString(16).padStart(2, '0')).join('');
export const developmentReviewFileHash = async (file: File): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())))
  .map(byte => byte.toString(16).padStart(2, '0')).join('');
const url = (reviewId: string, suffix: string, endpoint?: string) => apiService.buildApiUrl(`/v1/qc/development-sample-reviews/${encodeURIComponent(reviewId)}/${suffix}`, endpoint ?? apiService.getStoredConfig().cloudEndpoint);

function currentFence(inspect = false) {
  const identity = dashboardReadIdentity(), actorId = getAuthState().user?.id;
  if (!actorId) throw Error('请使用当前真实登录账号核对开发 QC。');
  const check = () => {
    if (dashboardReadIdentity() !== identity || getAuthState().user?.id !== actorId) throw Error('账号、权限或服务地址已变化，请保留原请求并重新核对。');
    if (inspect && !hasPermission('qc:inspect')) throw Error('当前账号没有执行正式 QC 的专业权限。');
  };
  check(); return { actorId, check };
}
async function responseError(response: Response): Promise<never> {
  const body: unknown = await response.json().catch(() => null);
  const error = record(body) && record(body.error) ? body.error : null;
  const code = error && text(error.code) ? error.code : `HTTP_${response.status}`;
  throw Object.assign(new Error(error && text(error.message) ? `${code}：${error.message}` : '开发 QC 结果暂不可确认，请保留原请求核对。'), { code, status: response.status });
}
function verifiedFile(value: unknown, reviewId: string, sourceFingerprint: string): value is DevelopmentReviewEvidenceFile {
  return record(value) && typeof value.id === 'string' && /^qef_[a-f0-9-]{36}$/.test(value.id)
    && text(value.name) && typeof value.mimeType === 'string' && ['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(value.mimeType)
    && Number.isSafeInteger(value.size) && Number(value.size) > 0 && Number(value.size) <= 15 * 1024 * 1024
    && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256) && text(value.uploadedBy) && digits(value.uploadedAt)
    && value.sourceKind === 'development_review' && value.sourceId === reviewId && value.sourceFingerprint === sourceFingerprint;
}
function parseContext(value: unknown, reviewId: string, actorId: string): DevelopmentReviewHandoffContext {
  if (!record(value)) throw Error('开发 QC 交接上下文不完整，请重新读取。');
  const item = parseDevelopmentSampleQcReview(value.item);
  if (!item || item.id !== reviewId || !item.sampleBatchId || typeof item.sourceFingerprint !== 'string'
    || value.actorId !== actorId || !digits(value.expectedUpdatedAt)
    || !['canClaim', 'canTransfer', 'canExecute'].every(key => typeof value[key] === 'boolean')
    || !['canAssign', 'canStart'].every(key => value[key] === undefined || typeof value[key] === 'boolean')
    || !(value.currentExecutor === null || record(value.currentExecutor) && text(value.currentExecutor.id)
      && (value.currentExecutor.displayName === null || text(value.currentExecutor.displayName)))
    || !Array.isArray(value.users) || value.users.some(user => !record(user) || !text(user.id) || !text(user.displayName) || !(user.departmentName === null || typeof user.departmentName === 'string'))
    || !Array.isArray(value.history) || value.history.some(event => !record(event) || !text(event.auditId) || !['start', 'claim', 'assign', 'transfer', 'complete'].includes(String(event.operation))
      || !text(event.actorId) || !(event.fromUserId === null || text(event.fromUserId)) || !(event.toUserId === null || text(event.toUserId))
      || !(event.reason === null || typeof event.reason === 'string') || !(event.occurredAt === null || digits(event.occurredAt)))
    || !Array.isArray(value.files) || value.files.some(file => !verifiedFile(file, reviewId, item.sourceFingerprint!))) throw Error('开发 QC 交接上下文的准确来源或文件归属不一致，请重新读取。');
  if (new Set(value.users.map(user => user.id)).size !== value.users.length || new Set(value.files.map(file => file.id)).size !== value.files.length
    || (value.currentExecutor === null ? item.startedBy != null : value.currentExecutor.id !== item.startedBy)
    || value.canClaim && (item.startedBy != null || !item.sampleVersionId)
    || value.canAssign && (item.startedBy != null || item.responsibleHeadId !== actorId || !item.sampleVersionId)
    || value.canStart && (item.status !== 'queued' || item.startedBy !== actorId || !item.sampleVersionId)
    || value.canTransfer && (item.startedBy !== actorId && item.responsibleHeadId !== actorId || !item.sampleVersionId)
    || value.canExecute && (item.status !== 'in_progress' || item.startedBy !== actorId || !item.sampleVersionId)) throw Error('当前执行人与可操作状态不一致，请重新读取。');
  return { item, actorId, expectedUpdatedAt: value.expectedUpdatedAt, currentExecutor: value.currentExecutor as DevelopmentReviewHandoffContext['currentExecutor'],
    canClaim: value.canClaim as boolean, canAssign: value.canAssign === true, canStart: value.canStart === true, canTransfer: value.canTransfer as boolean, canExecute: value.canExecute as boolean,
    users: value.users as DevelopmentReviewQcUser[], history: value.history as DevelopmentReviewHandoffHistory[], files: value.files as DevelopmentReviewEvidenceFile[] };
}
async function envelope(response: Response, check: () => void) {
  check(); if (!response.ok) await responseError(response);
  const body: unknown = await response.json(); check();
  if (!record(body) || body.ok !== true || !record(body.data)) throw Error('开发 QC 回执不完整，请保留原请求核对。');
  return body.data;
}
function requireExactReview(review: DevelopmentReviewIdentity) {
  if (!text(review.id) || !text(review.developmentCaseId) || !text(review.sampleBatchId) || !text(review.sampleVersionId)
    || typeof review.sourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(review.sourceFingerprint)) throw Error('准确开发版本身份尚未齐全，暂不能新增执行事实。');
  return { reviewId: review.id, caseId: review.developmentCaseId, batchId: review.sampleBatchId, versionId: review.sampleVersionId, sourceFingerprint: review.sourceFingerprint };
}

export const developmentReviewHandoffService = {
  async read(reviewId: string, endpoint?: string): Promise<DevelopmentReviewHandoffContext> {
    const fence = currentFence();
    const data = await envelope(await fetch(url(reviewId, 'handoff-context', endpoint), { headers: apiService.getAuthHeaders() }), fence.check);
    return parseContext(data, reviewId, fence.actorId);
  },
  async mutate(review: DevelopmentReviewIdentity, operation: DevelopmentReviewHandoffOperation, input: DevelopmentReviewHandoffInput, endpoint?: string) {
    const exact = requireExactReview(review), fence = currentFence(true);
    const command = { ...input, reason: input.reason.trim(), toUserId: operation === 'claim' ? fence.actorId : input.toUserId };
    const data = await envelope(await fetch(url(review.id, operation, endpoint), { method: 'POST', headers: apiService.getAuthHeaders(), body: JSON.stringify(input) }), fence.check);
    const item = parseDevelopmentSampleQcReview(data.item), receipt = data.receipt;
    if (!item || !record(receipt) || typeof data.replayed !== 'boolean' || item.id !== review.id || item.startedBy !== command.toUserId || item.status !== (operation === 'assign' && command.toUserId !== fence.actorId ? 'queued' : 'in_progress')
      || item.sampleVersionId !== exact.versionId || item.sampleBatchId !== exact.batchId || item.sourceFingerprint !== exact.sourceFingerprint
      || receipt.protocolVersion !== 1 || receipt.operation !== operation || receipt.requestKey !== input.requestKey || !text(receipt.auditId)
      || receipt.actorId !== fence.actorId || receipt.reviewId !== exact.reviewId || receipt.developmentCaseId !== exact.caseId
      || receipt.sampleBatchId !== exact.batchId || receipt.sampleVersionId !== exact.versionId || receipt.sourceFingerprint !== input.sourceFingerprint
      || receipt.sourceFingerprint !== exact.sourceFingerprint || receipt.fromUserId !== input.expectedStartedBy || receipt.toUserId !== command.toUserId
      || receipt.reason !== command.reason || !digits(receipt.occurredAt)
      || receipt.parameterHash !== await developmentReviewPayloadHash({ reviewId: review.id, actorId: fence.actorId, operation, command }))
      throw Error('开发 QC 交接回执与原任务、执行人或请求内容不一致，请保留原请求核对。');
    fence.check(); return { item, receipt: receipt as unknown as DevelopmentReviewHandoffReceipt, replayed: data.replayed };
  },
  async upload(review: DevelopmentReviewIdentity, requestKey: string, file: File, endpoint?: string): Promise<DevelopmentReviewEvidenceFile> {
    const exact = requireExactReview(review), fence = currentFence(true);
    const sha256 = await developmentReviewFileHash(file); fence.check();
    const form = new FormData(); form.set('requestKey', requestKey); form.set('sourceFingerprint', exact.sourceFingerprint); form.set('file', file);
    const headers = new Headers(apiService.getAuthHeaders()); headers.delete('Content-Type');
    const data = await envelope(await fetch(url(review.id, 'evidence', endpoint), { method: 'POST', headers, body: form }), fence.check);
    const expectedName = file.name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200);
    if (data.ok !== true || data.requestKey !== requestKey || typeof data.replayed !== 'boolean' || !verifiedFile(data.file, review.id, exact.sourceFingerprint)
      || data.file.name !== expectedName || data.file.size !== file.size || data.file.sha256 !== sha256 || data.file.uploadedBy !== fence.actorId)
      throw Error('附件上传回执与本次准确评审、实际上传人或原文件不一致，请保留原请求核对。');
    return data.file;
  },
  async download(review: DevelopmentReviewIdentity, file: DevelopmentReviewEvidenceFile, endpoint?: string): Promise<Blob> {
    const exact = requireExactReview(review), fence = currentFence();
    if (!verifiedFile(file, review.id, exact.sourceFingerprint)) throw Error('附件不属于本次准确开发评审。');
    const response = await fetch(url(review.id, `evidence/${encodeURIComponent(file.id)}`, endpoint), { headers: apiService.getAuthHeaders() });
    fence.check(); if (!response.ok) await responseError(response);
    const bytes = await response.arrayBuffer(); fence.check();
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (bytes.byteLength !== file.size || hash !== file.sha256 || response.headers.get('content-type')?.split(';')[0] !== file.mimeType) throw Error('下载原件与报告附件指纹不一致，请重新核对。');
    fence.check(); return new Blob([bytes], { type: file.mimeType });
  },
};
