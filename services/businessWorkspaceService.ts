import { apiService } from './apiService';
import { getAuthState } from './authService';
import type { BusinessWorkspaceScope, BusinessWorkspaceContext, BusinessWorkspaceContinueCommand, BusinessWorkspaceContinueResult } from '../server/src/shared/businessWorkspaceContract';
export type { BusinessWorkspaceScope, BusinessWorkspaceContext, BusinessWorkspaceNode, BusinessWorkspaceContinueCommand } from '../server/src/shared/businessWorkspaceContract';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : record(value)
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const digest = async (value: unknown) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical(value)))))].map(byte => byte.toString(16).padStart(2, '0')).join('');
export const workspaceScopeKey = (scope: BusinessWorkspaceScope) => JSON.stringify(canonical(scope));
export const workspaceIdentity = () => { const auth = getAuthState(); return JSON.stringify([auth.isAuthenticated, auth.user?.id,
  auth.user?.roles, auth.user?.roleIds, auth.user?.departmentIds, auth.user?.department, auth.user?.permissions, auth.user?.permissionCeiling,
  apiService.getStoredConfig().cloudEndpoint, apiService.getAuthHeaders()]); };
export function workspaceEndpoint(scope: BusinessWorkspaceScope) {
  const encode = encodeURIComponent;
  if (scope.kind === 'development_case' || scope.kind === 'development_version') return `/v1/dev/${encode(scope.caseId)}/business-workspace`;
  return `/v1/orders/${encode(scope.orderId)}/business-workspace`;
}
function checked(value: unknown, scope: BusinessWorkspaceScope): BusinessWorkspaceContext {
  if (!record(value) || value.schemaVersion !== 1 || workspaceScopeKey(value.scope as BusinessWorkspaceScope) !== workspaceScopeKey(scope)
    || !hash(value.scopeFingerprint) || !hash(value.contextFingerprint) || !record(value.overview) || !Array.isArray(value.nodes)
    || !Array.isArray(value.currentNodeIds) || value.currentNodeIds.some(id => !text(id)) || !Array.isArray(value.childSummaries) || value.childSummaries.some(row => !record(row)))
    throw new Error('工作区来源读回无法核对，请重新读取当前准确对象。');
  const seen = new Set<string>();
  for (const node of value.nodes) {
    if (!record(node) || !text(node.id) || seen.has(node.id) || !text(node.label) || !Array.isArray(node.precedingIds) || node.precedingIds.some(id => !text(id))
      || !['locked', 'current', 'recorded', 'blocked', 'unknown'].includes(String(node.status)) || typeof node.hasHistory !== 'boolean' || typeof node.canOpen !== 'boolean' || typeof node.canContinue !== 'boolean'
      || !Array.isArray(node.blockedReasons) || node.blockedReasons.some(row => !record(row) || !text(row.code) || !text(row.message))
      || !Array.isArray(node.evidenceRefs) || node.evidenceRefs.some(row => !record(row) || !text(row.kind) || !text(row.id))
      || node.canOpen && node.canContinue) throw new Error('工作区步骤依据不完整，请重新核对。');
    seen.add(node.id);
  }
  if (value.currentNodeIds.some(id => !seen.has(id))) throw new Error('工作区当前步骤读回不一致。');
  return value as unknown as BusinessWorkspaceContext;
}
async function request(path: string, body?: BusinessWorkspaceContinueCommand): Promise<unknown> {
  const identity = workspaceIdentity(), response = await fetch(apiService.buildApiUrl(path), { method: body ? 'POST' : 'GET', headers: apiService.getAuthHeaders(),
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const value: unknown = await response.json().catch(() => null);
  if (identity !== workspaceIdentity()) throw new Error('当前身份或数据端已变化，请重新打开准确对象。');
  if (!response.ok) { const error = record(value) && record(value.error) ? value.error : null; throw Object.assign(new Error(error && text(error.message) ? error.message : `工作区暂时无法核验（HTTP ${response.status}）`), { status: response.status }); }
  if (!record(value) || value.ok !== true || !record(value.data)) throw new Error('工作区结果暂不可确认，请保留原请求核对。');
  return value.data;
}
export async function readBusinessWorkspace(scope: BusinessWorkspaceScope): Promise<BusinessWorkspaceContext> {
  const query = new URLSearchParams();
  if (scope.kind === 'development_version') query.set('sampleVersionId', scope.sampleVersionId);
  if (scope.kind === 'order_line' || scope.kind === 'production_branch') query.set('orderLineId', scope.orderLineId);
  if (scope.kind === 'production_branch') { query.set('productionBatchId', scope.productionBatchId); query.set('productionBatchRevision', String(scope.productionBatchRevision)); }
  return checked(await request(`${workspaceEndpoint(scope)}${query.size ? `?${query}` : ''}`), scope);
}
export async function continueBusinessWorkspace(command: BusinessWorkspaceContinueCommand): Promise<BusinessWorkspaceContinueResult> {
  const actorId = getAuthState().user?.id, identity = workspaceIdentity();
  if (!actorId) throw new Error('请登录后明确继续。');
  const commandFingerprint = await digest(command);
  if (identity !== workspaceIdentity()) throw new Error('当前身份或数据端已变化，请重新打开准确对象。');
  const value = await request(`${workspaceEndpoint(command.scope)}/continue`, command);
  if (!record(value) || typeof value.replayed !== 'boolean' || !record(value.commandAck)) throw new Error('原继续请求未收到可核对的操作回执，请沿用原请求重试。');
  const ack = value.commandAck;
  if (ack.schemaVersion !== 1 || ack.requestKey !== command.requestKey || workspaceScopeKey(ack.scope as BusinessWorkspaceScope) !== workspaceScopeKey(command.scope)
    || ack.targetNodeId !== command.targetNodeId || ack.contextFingerprint !== command.expectedContextFingerprint || !hash(ack.scopeFingerprint) || !hash(ack.commandFingerprint)
    || !text(ack.auditId) || ack.actorId !== actorId || ack.commandFingerprint !== commandFingerprint) throw new Error('原继续回执的对象、操作人或参数不一致，请保留原请求核对。');
  return { context: checked(value.context, command.scope), commandAck: ack as unknown as BusinessWorkspaceContinueResult['commandAck'], replayed: value.replayed };
}
