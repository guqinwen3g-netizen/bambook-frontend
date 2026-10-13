import { teamBusinessFamilies } from '../hr/departmentBusinessAttributes';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../auth/tokenHelpers';
import { freshOrderLineScope } from '../orders/orderLineWriteAccess';
import { supplierFail, supplierFingerprint, supplierJson, supplierObject, SupplierContractError } from './supplierContractPolicy';

export type SupplierContractTx = Prisma.TransactionClient;
export type SupplierSourceProof = { orderId: string; orderLineId: string; businessLine: 'fabric' | 'garment'; mainApprovalId: string | null; mainApprovalFingerprint: string | null; commercialFingerprint: string; commercial: Prisma.InputJsonValue };
export type SupplierAccessMode = 'read' | 'write' | 'approve' | 'config';
export function hasActualSupplierScope(actor: TokenPayload, scope: string): boolean {
  return Array.isArray(actor.permissions) && (actor.permissions.includes('*') || actor.permissions.includes(scope))
    && (actor.permissionCeiling === undefined || Array.isArray(actor.permissionCeiling) && (actor.permissionCeiling.includes('*') || actor.permissionCeiling.includes(scope)));
}
/** The legacy auth loader only uses delegates. No token role/name defaults. */
export async function freshSupplierActor(tx: SupplierContractTx, prior: TokenPayload | null | undefined, mode: SupplierAccessMode): Promise<TokenPayload> {
  if (!prior?.userId) return supplierFail('UNAUTHORIZED', '供应商业务操作需要真实登录账号。', 401);
  try {
    const user = await loadUserWithRoles(tx as PrismaClient, prior.userId);
    if (!user || user.status !== 'active' || user.deletedAt != null) return supplierFail('ACCOUNT_DISABLED', '账号已失效，请重新登录。', 401);
    const current = await buildLoadedAuthTokenPayload(tx as PrismaClient, user);
    if (prior.permissionCeiling !== undefined) current.permissionCeiling = [...prior.permissionCeiling];
    if (!hasActualSupplierScope(current, mode === 'config' ? 'dictionary:write' : `procurement:${mode}`)
      || mode === 'config' && !current.roles.some(role => role === 'admin' || role === 'owner'))
      return supplierFail('FORBIDDEN', '当前账号没有该供应商业务操作权限。', 403);
    return current;
  } catch (error) {
    if (error instanceof SupplierContractError) throw error;
    return supplierFail('AUTHORIZATION_UNAVAILABLE', '暂时无法核验当前账号权限，请稍后重试。', 503);
  }
}
export async function lockSupplierCommand(tx: SupplierContractTx, actorId: string, requestKey: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`supplier-command:${actorId}:${requestKey}`}, 0))) AS supplier_command_lock`);
}
export async function lockSupplierContracts(tx: SupplierContractTx, contracts: Array<{ kind: 'purchase' | 'processing'; id: string }>): Promise<void> {
  for (const entry of [...new Map(contracts.map(row => [`${row.kind}:${row.id}`, row])).values()].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`))) {
    const rows = entry.kind === 'purchase'
      ? await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "PurchaseOrder" WHERE "id" = ${entry.id} AND "deletedAt" IS NULL FOR UPDATE`)
      : await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "OutsourcingOrder" WHERE "id" = ${entry.id} AND "deletedAt" IS NULL FOR UPDATE`);
    if (!rows.length) supplierFail('NOT_FOUND', '供应商单据不存在或已失效。', 404);
  }
}
export async function authorizeSupplierSources(tx: SupplierContractTx, prior: TokenPayload, requestedIds: string[], options: { mode: SupplierAccessMode; lock?: boolean; formal?: boolean; businessGates?: boolean }) {
  const ids = [...new Set(requestedIds)].sort();
  if (!ids.length || ids.some(id => typeof id !== 'string' || !id)) return supplierFail('SOURCE_REQUIRED', '每行须明确准确来源订单条目。');
  let actor = await freshSupplierActor(tx, prior, options.mode);
  const before = await tx.orderLine.findMany({ where: { id: { in: ids } } });
  if (before.length !== ids.length) return supplierFail('NOT_FOUND', '来源条目不存在或不在当前业务范围。', 404);
  let scope = await freshOrderLineScope(tx, actor);
  const orderIds = [...new Set(before.map(line => line.orderId))].sort();
  for (const id of orderIds) {
    if (!await tx.order.findFirst({ where: { id, deletedAt: null, AND: [scope] } })) return supplierFail('NOT_FOUND', '来源订单不存在或不在当前业务范围。', 404);
  }
  if (options.lock) {
    for (const id of orderIds) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id" = ${id} FOR UPDATE`);
    for (const id of ids) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "OrderLine" WHERE "id" = ${id} FOR UPDATE`);
    actor = await freshSupplierActor(tx, prior, options.mode);
    scope = await freshOrderLineScope(tx, actor);
  }
  const lines = await tx.orderLine.findMany({ where: { id: { in: ids } } });
  if (lines.length !== ids.length || lines.some(line => !before.some(old => old.id === line.id && old.orderId === line.orderId)))
    return supplierFail('SOURCE_CHANGED', '来源归属已变化，请刷新重载。', 409);
  const sources: SupplierSourceProof[] = [];
  const memberships = options.mode === 'write' ? await tx.teamMember.findMany({ where: { userId: actor.userId, leftAt: null }, include: { team: { include: { department: true } } } }) : [];
  for (const line of lines.sort((a, b) => a.id.localeCompare(b.id))) {
    const order = await tx.order.findFirst({ where: { id: line.orderId, deletedAt: null, AND: [scope] } });
    if (!order) return supplierFail('NOT_FOUND', '来源订单不存在或不在当前业务范围。', 404);
    const family = String(order.businessLine || order.type || '').toLowerCase();
    if (family !== 'fabric' && family !== 'garment') return supplierFail('SOURCE_DOMAIN_UNKNOWN', '来源订单业务域尚未明确。', 409);
    if (options.mode === 'write' && !memberships.some(row => row.team?.status === 'active' && row.team.deletedAt == null && teamBusinessFamilies(row.team).includes(family)))
      return supplierFail('FORBIDDEN', '须由准确来源条目的实际对应业务组经办。', 403);
    if (options.mode !== 'read' && options.businessGates !== false) {
      if (await tx.approvalRequest.findFirst({ where: { actionType: 'order:main_approval', targetType: 'Order', targetId: order.id, status: 'pending' }, select: { id: true } }))
        return supplierFail('SOURCE_APPROVAL_PENDING', '来源主单审批处理中，供应商业务写入已冻结。', 409);
      if (order.status === 'Cancelled' || order.status === 'Archived') return supplierFail('SOURCE_INACTIVE', '来源订单已取消或归档。', 409);
    }
    const main = await tx.approvalRequest.findFirst({ where: { actionType: 'order:main_approval', targetType: 'Order', targetId: order.id, status: 'approved' }, orderBy: { createdAt: 'desc' } });
    const mainFingerprint = supplierObject(main?.payload).contentFingerprint;
    if (options.businessGates !== false && options.formal && (!main || order.status === 'Pending' || typeof mainFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(mainFingerprint)))
      return supplierFail('SOURCE_NOT_APPROVED', '形成供应商承诺前，所有来源主单须有真实有效的批准依据。', 409);
    const commercial = supplierJson({ order: { id: order.id, code: order.code, poNumber: order.poNumber, businessLine: family, orderPurpose: order.orderPurpose, internalDemandTeamId: order.internalDemandTeamId,
      internalReceiverId: order.internalReceiverId, internalPurpose: order.internalPurpose, customerRelationId: order.customerRelationId, dueDate: order.dueDate },
      line: { id: line.id, description: line.description, materialCode: line.materialCode, quantity: line.quantity, unit: line.unit, unitPrice: line.unitPrice,
        confirmedSourceType: line.confirmedSourceType, confirmedSourceId: line.confirmedSourceId, specSnapshot: line.specSnapshot,
        fulfillmentMode: line.fulfillmentMode, cmtIncludedItems: line.cmtIncludedItems } });
    sources.push({ orderId: order.id, orderLineId: line.id, businessLine: family, mainApprovalId: main?.id ?? null,
      mainApprovalFingerprint: typeof mainFingerprint === 'string' ? mainFingerprint : null,
      commercialFingerprint: supplierFingerprint(commercial), commercial });
  }
  return { actor, sources };
}
