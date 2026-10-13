import { apiService } from './apiService';
import { getAuthState, hasPermission } from './authService';
import { beginBusinessRequest, clearAcknowledgedBusinessRequest, listBusinessRequests } from './businessRequestRecovery';

export interface QcEvidenceFile { id: string; name: string; mimeType: string; size: number; sha256: string; uploadedBy: string; uploadedAt: string;
  sourceKind: 'assignment' | 'development_review'; sourceId: string; sourceFingerprint: string }
export interface QcHandoffCommand { assignmentId: string; operation: 'claim' | 'transfer'; input: { expectedQcUserId: string | null;
  expectedUpdatedAt: string; expectedScopeFingerprint: string; reason: string; toQcUserId?: string } }
const identity = () => JSON.stringify([apiService.getStoredConfig().cloudEndpoint, apiService.getAuthHeaders(), getAuthState().user]);
function session() {
  const actorId = getAuthState().user?.id;
  if (!actorId) throw Error('请重新登录后继续。');
  const original = identity();
  return { actorId, current: () => { if (original !== identity()) throw Error('账号、权限或服务地址已变化，请重新读取当前 QC 来源。'); } };
}
const url = (route: string) => apiService.buildApiUrl(`/v1/qc${route}`, apiService.getStoredConfig().cloudEndpoint);
async function responseJson(response: Response) {
  const data = await response.json().catch(() => null);
  if (!response.ok) throw Error(data?.message || data?.error?.message || (typeof data?.error === 'string' ? data.error : 'QC 请求结果待核，请保留原请求。'));
  return data;
}
export const pendingQcProfessionalCommands = () => listBusinessRequests<QcHandoffCommand>('qc:professional:handoff:');
export async function submitQcHandoff(command: QcHandoffCommand) {
  if (!hasPermission('qc:inspect')) throw Error('当前账号没有专业 QC 执行权限。');
  const original = session(), operation = `qc:professional:handoff:${command.assignmentId}`;
  const record = beginBusinessRequest(operation, command);
  const result = await responseJson(await fetch(url(`/assignments/${encodeURIComponent(command.assignmentId)}/${command.operation}`), {
    method: 'POST', headers: apiService.getAuthHeaders(), body: JSON.stringify({ ...record.payload.input, requestKey: record.requestId }),
  }));
  original.current();
  const receipt = result?.receipt, expectedUser = command.operation === 'claim' ? original.actorId : command.input.toQcUserId;
  if (result?.ok !== true || result.item?.id !== command.assignmentId || result.item?.qcUserId !== expectedUser
    || receipt?.operation !== command.operation || receipt?.actorId !== original.actorId || receipt.assignmentId !== command.assignmentId
    || receipt.requestKey !== record.requestId || receipt.fromQcUserId !== command.input.expectedQcUserId || receipt.toQcUserId !== expectedUser
    || receipt.reason !== command.input.reason.trim() || receipt.scopeFingerprint !== command.input.expectedScopeFingerprint || !/^[a-f0-9]{64}$/.test(receipt.commandHash ?? '')) throw Error('认领/转交回执不完整，请保留原请求并读回实际接手人。');
  clearAcknowledgedBusinessRequest(operation, record.requestId); return result;
}
export async function listQcHandoffCandidates(id: string): Promise<Array<{ id: string; displayName: string }>> {
  const original = session();
  const data = await responseJson(await fetch(url(`/assignments/${encodeURIComponent(id)}/handoff-candidates`), { headers: apiService.getAuthHeaders() }));
  original.current();
  if (data?.ok !== true || !Array.isArray(data.users) || data.users.some((row: { id?: string; displayName?: string }) => !row?.id || !row.displayName)) throw Error('接手人员返回不完整。');
  return data.users;
}
export async function listQcEvidence(id: string): Promise<QcEvidenceFile[]> {
  const original = session();
  const data = await responseJson(await fetch(url(`/assignments/${encodeURIComponent(id)}/evidence-files`), { headers: apiService.getAuthHeaders() }));
  original.current();
  if (data?.ok !== true || !Array.isArray(data.files) || data.files.some((file: QcEvidenceFile) => !file?.id || file.sourceId !== id || file.sourceKind !== 'assignment' || !/^[a-f0-9]{64}$/.test(file.sha256))) throw Error('附件归属返回不完整。');
  return data.files;
}
export async function uploadQcEvidence(id: string, scopeFingerprint: string, file: File): Promise<QcEvidenceFile> {
  if (!hasPermission('qc:inspect')) throw Error('当前账号没有专业 QC 执行权限。');
  const original = session();
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  original.current();
  const operation = `qc:professional:file:${id}:${file.name}`;
  const record = beginBusinessRequest(operation, { assignmentId: id, scopeFingerprint, name: file.name, size: file.size, sha256 });
  const body = new FormData(); body.append('file', file); body.append('requestKey', record.requestId); body.append('expectedScopeFingerprint', scopeFingerprint);
  const headers = { ...apiService.getAuthHeaders() }; delete headers['Content-Type']; delete headers['content-type'];
  const result = await responseJson(await fetch(url(`/assignments/${encodeURIComponent(id)}/evidence-files`), { method: 'POST', headers, body }));
  original.current(); const uploaded: QcEvidenceFile | undefined = result?.file;
  if (result?.ok !== true || result.requestKey !== record.requestId || !uploaded?.id || uploaded.sourceId !== id || uploaded.sourceKind !== 'assignment'
    || uploaded.sourceFingerprint !== scopeFingerprint || uploaded.uploadedBy !== original.actorId || uploaded.sha256 !== sha256 || uploaded.size !== file.size) throw Error('附件上传回执待核，请重新选择同一原文件并按原请求重试。');
  clearAcknowledgedBusinessRequest(operation, record.requestId); return uploaded;
}
export async function downloadQcEvidence(reportId: string, file: QcEvidenceFile) {
  const original = session();
  const response = await fetch(url(`/reports/${encodeURIComponent(reportId)}/evidence-files/${encodeURIComponent(file.id)}`), { headers: apiService.getAuthHeaders() });
  if (!response.ok) { await responseJson(response); return; }
  const blob = await response.blob(); original.current();
  if (blob.size !== file.size) throw Error('附件原件大小不匹配，请重新核对报告。');
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  original.current(); if (digest !== file.sha256) throw Error('附件原件指纹不匹配，下载已停止。');
  const objectUrl = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = objectUrl; anchor.download = file.name; anchor.click(); URL.revokeObjectURL(objectUrl);
}
