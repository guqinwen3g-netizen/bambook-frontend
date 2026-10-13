import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { createPermissionService, hasScope } from '../auth/permissionService';
import { buildScopeWhereFromResolver } from '../auth/dataScopeWhere';
import { buildOrderListScopeWhere } from '../orders/orderService';
import { createTeamShareService } from '../teams/teamShareService';
import { resolveWriteKind, type PermissionScope } from '../_shared/rolePermissionMatrix';
import type { StepDef } from './workflowTypes';
import { loadWorkflowInvoiceSource, lockWorkflowInvoiceSource } from './workflowInvoiceSource';
import { businessError } from '../shared/errorCodes';

export class WorkflowError extends Error {
  constructor(public code: string, message: string, public statusCode: number) { super(message); }
}
export function workflowReject(code: string, message: string, statusCode = 409): never { throw new WorkflowError(code, message, statusCode); }
function workflowDependencyReject(message: string): never {
  const failure = businessError('DEPENDENCY_CHECK_FAILED', message);
  throw new WorkflowError(failure.code, failure.message, failure.statusCode);
}
export function workflowConcurrencyFailure(error: any): boolean {
  return error?.code === 'P2034' || error?.code === 'P2002'
    || error?.code === 'P2010' && ['40001', '40P01'].includes(String(error?.meta?.code));
}
export const WORKFLOW_SUPPORTED_EVENTS = ['OrderCreated', 'OrderConfirmed', 'OrderStatusChanged', 'InvoiceIssued', 'InvoiceCancelled', 'DevelopmentConverted'] as const;
export function workflowTriggerGap(entityType: string, event: string | null): string | null {
  if (!event) return null;
  if (entityType === 'Invoice' && event === 'ShipmentCompleted') return 'ShipmentCompleted只有出运来源，尚无可靠的原生Invoice联动事实；此自动触发已禁用';
  if (!WORKFLOW_SUPPORTED_EVENTS.includes(event as any)) return '此事件暂不支持可靠的工作流来源绑定；自动触发已禁用';
  return null;
}
export const WORKFLOW_ENTITY_TYPES = ['Order', 'Invoice', 'DevelopmentCase'] as const;
export type WorkflowEntityType = typeof WORKFLOW_ENTITY_TYPES[number];
export function workflowEntityType(value: unknown): WorkflowEntityType {
  if (!WORKFLOW_ENTITY_TYPES.includes(value as WorkflowEntityType)) workflowReject('INVALID_INPUT', '不支持此工作流来源类型', 400);
  return value as WorkflowEntityType;
}
const SCOPES: Record<WorkflowEntityType, { read: PermissionScope; start: PermissionScope; decide: PermissionScope }> = {
  Order: { read: 'orders:read', start: 'orders:write', decide: 'orders:write' },
  Invoice: { read: 'invoices:read', start: 'invoices:write', decide: 'invoices:write' },
  DevelopmentCase: { read: 'products:read', start: 'products:write', decide: 'qc:garment_chain:write' },
};
export function workflowScope(type: WorkflowEntityType, mode: 'read' | 'start' | 'decide'): PermissionScope { return SCOPES[type][mode]; }
export async function currentWorkflowActor(db: any, supplied?: TokenPayload | null): Promise<TokenPayload> {
  if (!supplied?.userId) workflowReject('UNAUTHORIZED', '请先登录', 401);
  try {
    const context = await createPermissionService({ prisma: db }).getUserPermissionContext(supplied.userId);
    if (!context) workflowReject('UNAUTHORIZED', '当前账号已失效', 401);
    return { userId: context.userId, roleIds: context.roleIds, roles: context.legacyRoleCodes,
      permissions: context.scopes, departmentIds: context.departmentIds, authorizationLoaded: true,
      ...(supplied.permissionCeiling !== undefined ? { permissionCeiling: [...supplied.permissionCeiling] } : {}) };
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    workflowDependencyReject('无法核对当前工作流权限，请稍后重试');
  }
}
export function assertWorkflowScope(actor: TokenPayload, type: WorkflowEntityType, mode: 'read' | 'start' | 'decide') {
  if (!hasScope(actor, workflowScope(type, mode))) workflowReject('FORBIDDEN', '当前权限不足以操作此工作流', 403);
}
// Only explicit legacy IDs have aliases. A custom Role.name never grants the
// canonical authority. production_manager has no current canonical mapping.
const LEGACY_REVIEWERS: Record<string, string> = { manager: 'role-sales-manager', finance: 'role-finance', admin: 'role-admin', owner: 'role-super-admin' };
export function canonicalWorkflowReviewer(value: string): string { return LEGACY_REVIEWERS[value] ?? value; }
/** Duties come from the configured step, never from whichever role the caller
 * currently holds. A designated user takes reviewer identity priority, while
 * an explicitly financial Order step retains its financial capability gate. */
export function hasWorkflowDecisionScope(actor: TokenPayload, type: WorkflowEntityType, step: Pick<StepDef, 'approverRole'> | null | undefined): boolean {
  if (type === 'Order' && step?.approverRole && canonicalWorkflowReviewer(step.approverRole) === 'role-finance') return hasScope(actor, 'orders:read') && hasScope(actor, 'invoices:write');
  return hasScope(actor, workflowScope(type, 'decide'));
}
export function assertWorkflowDecisionScope(actor: TokenPayload, type: WorkflowEntityType, step: Pick<StepDef, 'approverRole'> | null | undefined) {
  if (!hasWorkflowDecisionScope(actor, type, step)) workflowReject('FORBIDDEN', '当前权限不足以操作此工作流步骤', 403);
}
export function workflowReviewerMatches(actor: TokenPayload, step: Pick<StepDef, 'approverUserId' | 'approverRole'>): boolean {
  if (step.approverUserId) return step.approverUserId === actor.userId;
  if (!step.approverRole) return false;
  const canonical = canonicalWorkflowReviewer(step.approverRole);
  return !!actor.roleIds?.some(id => canonicalWorkflowReviewer(id) === canonical);
}
export function assertWorkflowReviewer(actor: TokenPayload, instance: any, step: any) {
  if (instance.initiatedById === actor.userId) workflowReject('FORBIDDEN', '发起人不能审批自己的工作流', 403);
  if (!workflowReviewerMatches(actor, step)) workflowReject('FORBIDDEN', '当前用户不是此步骤指定审批人', 403);
}
export function workflowCanCancel(actor: TokenPayload, instance: any): boolean {
  return instance.initiatedById === actor.userId || !!actor.roleIds?.some(id => ['role-sales-manager', 'role-admin', 'role-super-admin'].includes(canonicalWorkflowReviewer(id)));
}
export function workflowText(value: unknown, field: string, optional = false, max = 200): string {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) workflowReject('INVALID_INPUT', `${field}未填写或过长`, 400);
  return value.trim();
}
export function workflowJson(value: any): any {
  if (value === undefined) return null;
  if (typeof value === 'bigint' || Prisma.Decimal.isDecimal(value)) return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(workflowJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, workflowJson(value[key])]));
  return value;
}
export function workflowHash(value: any): string { return createHash('sha256').update(JSON.stringify(workflowJson(value))).digest('hex'); }

async function visibleWorkflowCustomer(db: any, actor: TokenPayload, id: string) {
  const row = await db.relation.findFirst({ where: { id, deletedAt: null } });
  if (!row) workflowReject('NOT_FOUND', '来源不存在或无权访问', 404);
  const resolver = await createPermissionService({ prisma: db }).getDataScopeResolver(actor, 'relations');
  if (resolveWriteKind(resolver.rule) !== 'all') {
    const ids = await createTeamShareService(db).resolveVisibleRelationIds(actor, { fresh: true });
    if (!ids.includes(id)) workflowReject('NOT_FOUND', '来源不存在或无权访问', 404);
  }
  return row;
}

async function visibleSource(db: any, actor: TokenPayload, type: WorkflowEntityType, id: string, mode: 'read' | 'start' | 'decide'): Promise<any> {
  if (type === 'Order') {
    const scope = await buildOrderListScopeWhere(db, actor, { fresh: true });
    const row = await db.order.findFirst({ where: { id, deletedAt: null, AND: [scope] } });
    if (!row) workflowReject('NOT_FOUND', '来源不存在或无权访问', 404);
    const lines = await db.orderLine.findMany({ where: { orderId: id }, orderBy: { id: 'asc' } });
    return { row, lines };
  }
  if (type === 'Invoice') {
    const permissions = createPermissionService({ prisma: db });
    const scope = buildScopeWhereFromResolver(await permissions.getDataScopeResolver(actor, 'finance'), actor.userId);
    const row = await db.invoice.findFirst({ where: { id, deletedAt: null, AND: [scope] } });
    if (!row) workflowReject('NOT_FOUND', '来源不存在或无权访问', 404);
    // Invoice's actual order attachments are business parents, not arbitrary
    // workflow input. A failed IOA query must not drop the restrictive parent.
    const attachments = await db.invoiceOrderAllocation.findMany({ where: { invoiceId: id, deletedAt: null }, orderBy: { id: 'asc' } });
    const lines = await db.invoiceLine.findMany({ where: { invoiceId: id }, orderBy: { id: 'asc' } });
    const origins = await loadWorkflowInvoiceSource(db, row, lines, attachments, {
      order: parentId => visibleSource(db, actor, 'Order', parentId, 'read'),
      development: parentId => visibleSource(db, actor, 'DevelopmentCase', parentId, 'read'),
      customer: parentId => visibleWorkflowCustomer(db, actor, parentId),
      reject: workflowReject,
    });
    return { row, lines, attachments, origins };
  }
  const row = await db.developmentCase.findFirst({ where: { id, deletedAt: null } });
  if (!row) workflowReject('NOT_FOUND', '来源不存在或无权访问', 404);
  const permissions = createPermissionService({ prisma: db });
  const resolver = await permissions.getDataScopeResolver(actor, 'relations');
  if (resolveWriteKind(resolver.rule) !== 'all') {
    if (!row.customerRelationId) workflowReject('NOT_FOUND', '来源不存在或无权访问', 404);
    const relation = await db.relation.findFirst({ where: { id: row.customerRelationId, deletedAt: null } });
    if (!relation) workflowReject('NOT_FOUND', '来源不存在或无权访问', 404);
    const ids = await createTeamShareService(db).resolveVisibleRelationIds(actor, { fresh: true });
    if (!ids.includes(relation.id)) workflowReject('NOT_FOUND', '来源不存在或无权访问', 404);
    if (mode !== 'read' && relation.ownerId !== actor.userId && !relation.salesRepIds?.includes(actor.userId)
      && !await db.teamDataGrant.findFirst({ where: { entityType: 'relation', entityId: relation.id, permission: 'read+followup', revokedAt: null,
        team: { deletedAt: null, members: { some: { userId: actor.userId, leftAt: null } } } } })) workflowReject('NOT_FOUND', '来源不存在或无权访问', 404);
  }
  return { row, batches: await db.sampleBatch.findMany({ where: { developmentCaseId: id, deletedAt: null }, orderBy: { id: 'asc' } }) };
}
export async function workflowSource(db: any, actor: TokenPayload, type: WorkflowEntityType, id: string, mode: 'read' | 'start' | 'decide', lock = false) {
  try {
    let source = await visibleSource(db, actor, type, id, mode);
    if (lock) {
      // Common source order: real parent Order(s), then Invoice; a plain
      // Prisma client must never execute these transaction-only row locks.
      if (type === 'Invoice') await lockWorkflowInvoiceSource(db, source.origins, { order: async () => null, development: async () => null, customer: async () => null, reject: workflowReject });
      const tables = { Order: Prisma.raw('"Order"'), Invoice: Prisma.raw('"Invoice"'), DevelopmentCase: Prisma.raw('"DevelopmentCase"') };
      const rows = await db.$queryRaw(Prisma.sql`SELECT "id" FROM ${tables[type]} WHERE "id"=${id} AND "deletedAt" IS NULL FOR UPDATE`);
      if (!rows.length) workflowReject('NOT_FOUND', '来源不存在或无权访问', 404);
      const current = await visibleSource(db, actor, type, id, mode);
      if (type === 'Invoice' && (workflowHash(current.attachments) !== workflowHash(source.attachments) || workflowHash(current.origins.bindings) !== workflowHash(source.origins.bindings)) || current.row.orderId !== source.row.orderId) workflowReject('CONFLICT', '来源关联已变化，请刷新后重试');
      source = current;
    }
    return { snapshot: workflowJson(source), fingerprint: workflowHash(source) };
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    // Keep the transaction's actual serialization/deadlock failure intact so
    // the outer command boundary returns its established retryable conflict.
    if (workflowConcurrencyFailure(error)) throw error;
    workflowDependencyReject('无法核对工作流来源，请稍后重试');
  }
}
