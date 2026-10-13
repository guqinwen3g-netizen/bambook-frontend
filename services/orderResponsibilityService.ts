import { apiService } from './apiService';
import { getAuthState, hasPermission, subscribe } from './authService';

export interface ResponsibilityUser { id: string; displayName: string }
export interface ResponsibilityDepartment { id: string; name: string; headId: string | null }
export interface OrderResponsibility {
  orderId: string; owner: ResponsibilityUser | null; department: ResponsibilityDepartment | null; updatedAt: string;
  canWrite: boolean; users?: ResponsibilityUser[]; departments?: ResponsibilityDepartment[];
}
export interface ResponsibilityInput { clientRequestId: string; ownerId: string | null; departmentId: string | null; expectedUpdatedAt: string; reason: string }
export interface ResponsibilityAck {
  responsibility?: Omit<OrderResponsibility, 'canWrite' | 'users' | 'departments'>;
  receipt: { operation: 'assign_order_responsibility'; orderId: string; actorId: string; clientRequestId: string; commandId: string; commandHash: string; before: { ownerId: string | null; departmentId: string | null; updatedAt: string }; after: { ownerId: string | null; departmentId: string | null; updatedAt: string }; reason: string; auditIds: string[] };
  callerCanRead: boolean; callerCanWrite: boolean;
}
export interface ResponsibilityCancellationReceipt { operation: 'cancel_order_responsibility'; orderId: string; actorId: string; clientRequestId: string; commandId: string; commandHash: string; intent: ResponsibilityInput; cancelReason: string; cancelledAt: string; auditIds: string[] }
export type ResponsibilityOutcome = (ResponsibilityAck & { outcome: 'committed' }) | { outcome: 'cancelled'; responsibility?: never; receipt: ResponsibilityCancellationReceipt; callerCanRead: boolean; callerCanWrite: boolean };
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const id = (v: unknown): v is string => text(v) && v.trim() === v;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const version = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v);
const nullableId = (v: unknown) => v === null || id(v);
const user = (v: any) => id(v?.id) && text(v.displayName);
const department = (v: any) => id(v?.id) && text(v.name) && nullableId(v.headId);
const core = (v: any, orderId: string) => v?.orderId === orderId && version(v.updatedAt) && (v.owner === null || user(v.owner)) && (v.department === null || department(v.department));
const list = (v: any, valid: (row: any) => boolean) => Array.isArray(v) && v.every(valid) && new Set(v.map(row => row.id)).size === v.length;
export function responsibilityIdentity(): string {
  const state = getAuthState(), u = state.user;
  return JSON.stringify([state.isAuthenticated, u?.id, u?.roles, u?.roleIds, u?.permissions, u?.permissionCeiling,
    u?.departmentIds, u?.department, apiService.buildApiUrl('/v2/orders/_/responsibility'), apiService.getAuthHeaders()]);
}
export class ResponsibilityRequestError extends Error { constructor(message: string, readonly validationRejected = false) { super(message); } }
function invalid(): never { throw new Error('订单责任响应不完整，请重新读取核对。'); }
export async function responsibilityCommandHash(orderId: string, input: ResponsibilityInput, actorId: string): Promise<string> {
  const body = JSON.stringify({ operation: 'assign_order_responsibility', actorId, orderId, clientRequestId: input.clientRequestId,
    ownerId: input.ownerId, departmentId: input.departmentId, expectedUpdatedAt: input.expectedUpdatedAt, reason: input.reason.trim() });
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
}
function validInput(input: ResponsibilityInput): boolean { return uuid(input.clientRequestId) && nullableId(input.ownerId) && nullableId(input.departmentId)
  && (!!input.ownerId || !!input.departmentId) && version(input.expectedUpdatedAt) && text(input.reason); }
function pendingKey(orderId: string): string { return `bambook_order_responsibility_intent:${JSON.stringify([getAuthState().user?.id, apiService.buildApiUrl('/v2/orders/_/responsibility'), orderId])}`; }
export function readResponsibilityIntent(orderId: string): ResponsibilityInput | null {
  try { const value = JSON.parse(sessionStorage.getItem(pendingKey(orderId)) || 'null'); return value && validInput(value) ? value : null; } catch { return null; }
}
export function storeResponsibilityIntent(orderId: string, input: ResponsibilityInput | null): void {
  if (input) sessionStorage.setItem(pendingKey(orderId), JSON.stringify(input)); else sessionStorage.removeItem(pendingKey(orderId));
}
async function request(orderId: string, input?: ResponsibilityInput, signal?: AbortSignal, recover = false, cancelReason?: string): Promise<any> {
  const auth = getAuthState();
  if (!auth.isAuthenticated || !hasPermission(input && !recover ? 'orders:write' : 'orders:read')) throw new Error('当前账号没有订单责任操作权限。');
  if (!id(orderId)) throw new Error('请重新打开原订单。');
  const cancelling = cancelReason !== undefined;
  const identity = responsibilityIdentity(); let stale = false;
  const controller = new AbortController();
  const check = () => { if (stale || signal?.aborted || identity !== responsibilityIdentity()) throw new Error('登录、权限或数据端点已变化，请重新读取当前订单。'); };
  const watch = () => { if (identity !== responsibilityIdentity()) { stale = true; controller.abort(); } };
  const stop = subscribe(watch); const external = () => controller.abort();
  signal?.addEventListener('abort', external, { once: true });
  if (typeof window !== 'undefined') window.addEventListener('storage', watch);
  try {
    check();
    const expectedHash = input ? await responsibilityCommandHash(orderId, input, auth.user!.id) : undefined; check();
    const res = await fetch(apiService.buildApiUrl(`/v2/orders/${encodeURIComponent(orderId)}/responsibility${recover ? `/receipts/${input!.clientRequestId}` : cancelling ? '/cancellations' : ''}`), {
      method: cancelling ? 'POST' : input && !recover ? 'PATCH' : 'GET', headers: { ...apiService.getAuthHeaders(), ...(input && !recover ? { 'Content-Type': 'application/json' } : {}) },
      ...(input && !recover ? { body: JSON.stringify(cancelling ? { ...input, parameterHash: expectedHash, cancelReason: cancelReason!.trim() } : input) } : {}), signal: controller.signal,
    });
    check();
    let data: any; try { data = await res.json(); } catch { throw new Error(input ? '提交结果尚未核对，请保留输入并核对本次交接。' : '订单责任响应不是有效资料，请重新读取。'); }
    check();
    if (!res.ok || data?.ok !== true) throw new ResponsibilityRequestError(data?.error?.message || data?.message || `订单责任操作未确认（HTTP ${res.status}）。`, !recover && !cancelling && res.status === 400 && data?.ok === false && data?.error === 'VALIDATION_FAILED');
    if (!input) {
      const r = data.responsibility;
      if (!core(r, orderId) || typeof r.canWrite !== 'boolean' || (r.canWrite && (!list(r.users, user) || !list(r.departments, department)))
        || (!r.canWrite && (r.users !== undefined || r.departments !== undefined))) invalid();
      return r as OrderResponsibility;
    }
    const r = data.receipt;
    if (typeof data.callerCanRead !== 'boolean' || typeof data.callerCanWrite !== 'boolean'
      || r?.orderId !== orderId || r.actorId !== auth.user?.id || r.clientRequestId !== input.clientRequestId
      || !uuid(r.commandId) || r.commandHash !== expectedHash || !Array.isArray(r.auditIds) || !r.auditIds.length || !r.auditIds.every(id)) invalid();
    if ((recover || cancelling) && !['committed', 'cancelled'].includes(data.outcome)) invalid();
    if ((recover || cancelling) && data.responsibility !== undefined) invalid();
    if (data.outcome === 'cancelled') {
      if (!recover && !cancelling) invalid();
      const original = r.intent;
      if (r.operation !== 'cancel_order_responsibility' || original?.clientRequestId !== input.clientRequestId
        || original.ownerId !== input.ownerId || original.departmentId !== input.departmentId
        || original.expectedUpdatedAt !== input.expectedUpdatedAt || original.reason !== input.reason.trim()
        || !text(r.cancelReason) || r.cancelReason !== r.cancelReason.trim() || !version(r.cancelledAt)
        || (cancelling && r.cancelReason !== cancelReason!.trim())) invalid();
      return data as ResponsibilityOutcome;
    }
    if (r.operation !== 'assign_order_responsibility'
      || r.before?.updatedAt !== input.expectedUpdatedAt || !nullableId(r.before.ownerId) || !nullableId(r.before.departmentId)
      || r.after?.ownerId !== input.ownerId || r.after.departmentId !== input.departmentId || !version(r.after.updatedAt)
      || BigInt(r.after.updatedAt) <= BigInt(input.expectedUpdatedAt) || r.reason !== input.reason.trim()) invalid();
    if (data.responsibility !== undefined && (!core(data.responsibility, orderId) || data.responsibility.updatedAt !== r.after.updatedAt
      || (data.responsibility.owner?.id ?? null) !== input.ownerId || (data.responsibility.department?.id ?? null) !== input.departmentId)) invalid();
    if (!recover && !cancelling && data.callerCanRead && data.replayed !== true && !core(data.responsibility, orderId)) invalid();
    return data as ResponsibilityAck;
  } finally { stop(); signal?.removeEventListener('abort', external); if (typeof window !== 'undefined') window.removeEventListener('storage', watch); }
}
export const orderResponsibilityService = {
  get: (orderId: string, signal?: AbortSignal): Promise<OrderResponsibility> => request(orderId, undefined, signal),
  async save(orderId: string, input: ResponsibilityInput, signal?: AbortSignal): Promise<ResponsibilityAck> {
    if (!validInput(input)) throw new Error('请指定负责人或负责部门，并填写调整原因。');
    return request(orderId, { clientRequestId: input.clientRequestId, ownerId: input.ownerId, departmentId: input.departmentId, expectedUpdatedAt: input.expectedUpdatedAt, reason: input.reason.trim() }, signal);
  },
  async recover(orderId: string, input: ResponsibilityInput, signal?: AbortSignal): Promise<ResponsibilityOutcome> {
    if (!validInput(input)) throw new Error('本次交接的核对信息不完整，请核对原订单。');
    return request(orderId, input, signal, true);
  },
  async cancel(orderId: string, input: ResponsibilityInput, cancelReason: string, signal?: AbortSignal): Promise<ResponsibilityOutcome> {
    if (!validInput(input) || !text(cancelReason)) throw new Error('请保留原交接信息并填写取消原因。');
    return request(orderId, input, signal, false, cancelReason.trim());
  },
};
