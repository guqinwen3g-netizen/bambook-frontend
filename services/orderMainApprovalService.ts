import { apiService } from './apiService';
import { getAuthState, hasPermission } from './authService';
import { beginBusinessRequest, clearAcknowledgedBusinessRequest, listBusinessRequests } from './businessRequestRecovery';
export interface MainApprovalRead { id: string; targetId: string; requesterId: string; status: string; reviewContentVersion: string; canApprove: boolean;
  frozenEvidenceStatus?: 'verified' | 'legacy_verified' | 'legacy_unverifiable'; rejectionReason?: string | null; requestedChanges?: string | null; approvalBlockers?: string[];
  withdrawnBy?: string | null; withdrawnAt?: string | null; withdrawalReason?: string | null }
export interface MainWithdrawalIntent { orderId: string; approvalId: string; reviewContentVersion: string; reason: string }
const url = (route: string) => apiService.buildApiUrl(`/v1/approvals${route}`, apiService.getStoredConfig().cloudEndpoint);
const session = () => JSON.stringify([getAuthState().user, apiService.getStoredConfig().cloudEndpoint, apiService.getAuthHeaders()]);
const check = (original: string) => { if (original !== session()) throw Error('账号、权限或服务地址已变化，请重新读取主单审批。'); };
async function parse(response: Response) {
  const data = await response.json().catch(() => null);
  if (!response.ok) throw Error(data?.message || data?.error?.message || (typeof data?.error === 'string' ? data.error : '主单审批结果待核，请保留原请求。'));
  return data;
}
export const pendingMainWithdrawals = () => listBusinessRequests<MainWithdrawalIntent>('order:main-withdraw:');
export async function readMainApproval(approvalId: string): Promise<MainApprovalRead> {
  const original = session(); const data = await parse(await fetch(url(`/${encodeURIComponent(approvalId)}`), { headers: apiService.getAuthHeaders() })); check(original);
  const item = data?.item;
  if (item?.id !== approvalId || !item.targetId || !/^[a-f0-9]{64}$/.test(item.reviewContentVersion ?? '') || typeof item.canApprove !== 'boolean') throw Error('主单审批读回不完整，请重新加载。');
  return item;
}
export async function withdrawMainApproval(intent: MainWithdrawalIntent) {
  if (!hasPermission('orders:write') || !getAuthState().user?.id) throw Error('当前账号没有主单来源写权限。');
  const original = session(), actorId = getAuthState().user!.id;
  const operation = `order:main-withdraw:${intent.orderId}`, record = beginBusinessRequest(operation, intent);
  const data = await parse(await fetch(url(`/${encodeURIComponent(intent.approvalId)}/withdraw`), { method: 'POST', headers: apiService.getAuthHeaders(),
    body: JSON.stringify({ requestKey: record.requestId, reviewContentVersion: record.payload.reviewContentVersion, reason: record.payload.reason }) })); check(original);
  const ack = data?.commandAck;
  if (data?.ok !== true || data.item?.id !== intent.approvalId || data.item.status !== 'cancelled' || ack?.operation !== 'withdraw_order_main_approval'
    || ack.requestKey !== record.requestId || ack.approvalId !== intent.approvalId || ack.orderId !== intent.orderId || ack.actorId !== actorId
    || ack.status !== 'cancelled' || ack.reason !== intent.reason.trim() || ack.reviewContentVersion !== record.payload.reviewContentVersion
    || !/^[a-f0-9]{64}$/.test(ack.commandHash ?? '')) throw Error('原撤回回执待核，请保留原请求并重新读取审批。');
  // Keep the original intent until the exact cancelled instance is readable.
  // An ACK with a failed follow-up read must not unlock a new submission.
  const source = await readMainApproval(intent.approvalId); check(original);
  if (source.targetId !== intent.orderId || source.status !== 'cancelled') throw Error('原审批尚未核对为已撤回，请保留原请求。');
  clearAcknowledgedBusinessRequest(operation, record.requestId); return data;
}
