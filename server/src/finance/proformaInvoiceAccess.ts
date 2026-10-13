/** PI writes use current stored authority and actual source parents. The
 * optional actor is an in-process credential context, never a request body. */
import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { createPermissionService, hasScope } from '../auth/permissionService';
import { buildScopeWhereFromResolver } from '../auth/dataScopeWhere';
import { createTeamShareService } from '../teams/teamShareService';
import { buildOrderListScopeWhere } from '../orders/orderService';
import { isBusinessError, lookupErrorCode } from '../shared/errorCodes';
import { lockInvoiceFinancialSources } from '../shipping/shipmentFinancialAuthority';
import { DevelopmentDomainError } from '../development/developmentOperationalGuard';
import { OrderLineWriteError } from '../orders/orderLineWriteAccess';

export type ProformaAccessCode = 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'DEPENDENCY_CHECK_FAILED' | 'CONFLICT' | 'INVALID_INPUT' | 'INVALID_AMOUNT' | 'INVOICE_CUSTOMER_MISMATCH' | 'INVOICE_CONSOLIDATION_CUSTOMER_MISMATCH';
export class ProformaAccessError extends Error {
  readonly statusCode: number;
  constructor(readonly code: ProformaAccessCode, message: string) {
    super(message); this.statusCode = lookupErrorCode(code)?.status ?? 500;
  }
}
export function isProformaAccessCode(value: unknown): value is ProformaAccessCode {
  return typeof value === 'string' && ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'DEPENDENCY_CHECK_FAILED', 'CONFLICT', 'INVALID_INPUT', 'INVALID_AMOUNT', 'INVOICE_CUSTOMER_MISMATCH', 'INVOICE_CONSOLIDATION_CUSTOMER_MISMATCH'].includes(value);
}
function reject(code: ProformaAccessCode, message: string): never { throw new ProformaAccessError(code, message); }
function invisible(): never { return reject('NOT_FOUND', '来源不存在或无权访问，请核对原单。'); }
export async function currentProformaActor(tx: any, actorId: string | null, trustedActor?: TokenPayload | null): Promise<TokenPayload> {
  const userId = trustedActor?.userId || actorId;
  if (!userId || actorId != null && trustedActor != null && trustedActor.userId !== actorId) reject('UNAUTHORIZED', '请使用有效账号登录后继续。');
  try {
    const context = await createPermissionService({ prisma: tx }).getUserPermissionContext(userId);
    if (!context) reject('UNAUTHORIZED', '当前账号已失效，请重新登录。');
    const actor: TokenPayload = { userId: context.userId, roles: context.legacyRoleCodes, roleIds: context.roleIds, permissions: context.scopes,
      departmentIds: context.departmentIds, authorizationLoaded: true,
      ...(trustedActor?.permissionCeiling !== undefined ? { permissionCeiling: [...trustedActor.permissionCeiling] } : {}) };
    // Canonical owner affects visibility, but cannot restore a revoked action
    // grant. The signed ceiling and actual current scopes both remain required.
    if (!hasScope({ ...actor, roles: [] }, 'invoices:write')) reject('FORBIDDEN', '当前账号没有开票权限。');
    return actor;
  } catch (error) {
    if (error instanceof ProformaAccessError) throw error;
    return reject('DEPENDENCY_CHECK_FAILED', '当前授权暂时无法核对，请稍后重试。');
  }
}

async function requireCustomer(tx: any, actor: TokenPayload, id: string) {
  const row = await tx.relation.findFirst({ where: { id, deletedAt: null } });
  if (!row || !await createTeamShareService(tx).hasBizReadAccess(actor, id, { fresh: true })) invisible();
}
interface ProformaParents {
  orderIds: string[]; line: any; development: any; attachments: any[]; batches: any[];
  quotation: any; quotationParents: ProformaParents | null; signature: string;
}
async function actualParents(tx: any, kind: 'quotation' | 'invoice', source: any): Promise<ProformaParents> {
  const orderIds = new Set<string>();
  if (source.orderId) orderIds.add(source.orderId);
  let line: any = null, development: any = null, attachments: any[] = [], batches: any[] = [];
  let quotation: any = null, quotationParents: Awaited<ReturnType<typeof actualQuotationParents>> | null = null;
  if (kind === 'quotation') {
    if (source.convertedOrderId) orderIds.add(source.convertedOrderId);
    if (source.orderLineId) {
      line = await tx.orderLine.findUnique({ where: { id: source.orderLineId } });
      if (!line || source.orderId && line.orderId !== source.orderId) invisible();
      orderIds.add(line.orderId);
    }
    if (source.developmentCaseId) {
      development = await tx.developmentCase.findFirst({ where: { id: source.developmentCaseId, deletedAt: null } });
      if (!development) invisible();
    }
  } else {
    attachments = await tx.invoiceOrderAllocation.findMany({ where: { invoiceId: source.id, deletedAt: null }, orderBy: { id: 'asc' } });
    for (const attachment of attachments) orderIds.add(attachment.orderId);
    const batchIds = [...new Set<string>(attachments.filter(row => row.batchId).map(row => row.batchId))].sort();
    if (batchIds.length) batches = await tx.orderShipmentBatch.findMany({ where: { id: { in: batchIds } }, orderBy: { id: 'asc' } });
    const metadata = typeof source.attachments === 'string' ? JSON.parse(source.attachments) : source.attachments;
    const quotationId = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata.quotationId : null;
    if (quotationId != null) {
      if (typeof quotationId !== 'string' || !quotationId.trim()) reject('INVALID_INPUT', '形式发票的原报价标识无效，请核对原单。');
      quotation = await tx.quotation.findFirst({ where: { id: quotationId, deletedAt: null } });
      if (!quotation) invisible();
      quotationParents = await actualQuotationParents(tx, quotation);
      for (const id of quotationParents.orderIds) orderIds.add(id);
      line = quotationParents.line; development = quotationParents.development;
    }
  }
  return { orderIds: [...orderIds].sort(), line, development, attachments, batches, quotation, quotationParents,
    signature: JSON.stringify({ orderIds: [...orderIds].sort(), orderLineId: line?.id ?? null, lineOrderId: line?.orderId ?? null,
      developmentId: development?.id ?? null, customerRelationId: source.customerRelationId,
      quotation: quotation ? [quotation.id, quotation.orderId, quotation.orderLineId, quotation.convertedOrderId,
        quotation.developmentCaseId, quotation.customerRelationId, quotationParents?.signature] : null,
      attachments: attachments.map(row => [row.id, row.orderId, row.batchId, row.allocatedAmount?.toString() ?? null, row.note]),
      // Derived settlement caches/timestamps are deliberately not source facts.
      batches: batches.map(row => [row.id, row.orderId, row.shipmentId, row.status, row.currency, row.customerRelationId, row.amount?.toString() ?? null, row.deletedAt?.toString() ?? null]) }) };
}
// A separate wrapper keeps the recursive quotation branch's return type finite.
async function actualQuotationParents(tx: any, source: any): Promise<ProformaParents> { return actualParents(tx, 'quotation', source); }
async function requireSource(tx: any, actor: TokenPayload, kind: 'quotation' | 'invoice', source: any, parents: Awaited<ReturnType<typeof actualParents>>) {
  const permission = createPermissionService({ prisma: tx });
  if (kind === 'quotation') {
    const resolver = await permission.getDataScopeResolver(actor, 'quotations');
    if (source.customerRelationId) {
      if (resolver.rule.kind !== 'all') {
        const visible = await createTeamShareService(tx).resolveVisibleRelationIds(actor, { fresh: true });
        if (!visible.includes(source.customerRelationId)) invisible();
      }
      // Even an all-scope actor must not use a deleted customer anchor.
      if (!await tx.relation.findFirst({ where: { id: source.customerRelationId, deletedAt: null } })) invisible();
    } else if (resolver.rule.kind !== 'all' && source.ownerId !== actor.userId) invisible();
    if (parents.development) {
      if (parents.development.customerRelationId) await requireCustomer(tx, actor, parents.development.customerRelationId);
      else if ((await permission.getDataScopeResolver(actor, 'relations')).rule.kind !== 'all') invisible();
    }
  } else {
    const scope = buildScopeWhereFromResolver(await permission.getDataScopeResolver(actor, 'finance'), actor.userId);
    if (!await tx.invoice.findFirst({ where: { id: source.id, deletedAt: null, AND: [scope] }, select: { id: true } })) invisible();
    if (parents.quotation && parents.quotationParents) {
      await requireSource(tx, actor, 'quotation', parents.quotation, parents.quotationParents);
    }
  }
  const scope = await buildOrderListScopeWhere(tx, actor, { fresh: true });
  for (const id of parents.orderIds) if (!await tx.order.findFirst({ where: { id, deletedAt: null, AND: [scope] }, select: { id: true } })) invisible();
}

/** Actual shipment/release sources → Order(s) → physical batch/Shipment →
 * financial batch → PI/IOA, then reread authority
 * and parent links. No sequence/document/audit is written by this helper. */
export async function lockAuthorizedProformaSource(tx: any, kind: 'quotation' | 'invoice', id: string, actorId: string | null, trustedActor?: TokenPayload | null): Promise<{ actor: TokenPayload; source: any; parents: Awaited<ReturnType<typeof actualParents>> | null }> {
  try {
    let actor = await currentProformaActor(tx, actorId, trustedActor);
    const load = () => kind === 'quotation' ? tx.quotation.findFirst({ where: { id, deletedAt: null }, include: { lines: { orderBy: { lineNumber: 'asc' } } } })
      : tx.invoice.findFirst({ where: { id, deletedAt: null } });
    const hint = await load(); if (!hint) return { actor, source: null, parents: null };
    const before = await actualParents(tx, kind, hint); await requireSource(tx, actor, kind, hint, before);
    const conversionCandidate = kind === 'invoice' && hint.type === 'Proforma' && hint.status !== 'Cancelled';
    if (conversionCandidate && before.attachments.length) {
      // Real IOA rows are source hints only. Acquire the same native source set
      // as Shipment cancellation before any OSB or PI lock. Include every
      // actual header/quotation parent now, so no new parent is acquired later
      // while holding a financial batch. The actor is freshly loaded above;
      // only the trusted in-process credential contributes its signed ceiling.
      const allocatedParents = new Set(before.attachments.map(row => row.orderId));
      await lockInvoiceFinancialSources(tx, [
        ...before.attachments.map(row => ({ orderId: row.orderId, batchId: row.batchId })),
        ...before.orderIds.filter(orderId => !allocatedParents.has(orderId)).map(orderId => ({ orderId, batchId: null })),
      ], actor);
    }
    for (const orderId of before.orderIds) {
      const rows = await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id"=${orderId} AND "deletedAt" IS NULL FOR UPDATE`);
      if (!rows.length) invisible();
    }
    if (before.line) {
      const rows = await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "OrderLine" WHERE "id"=${before.line.id} FOR UPDATE`); if (!rows.length) invisible();
    }
    if (before.quotation) {
      const rows = await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Quotation" WHERE "id"=${before.quotation.id} AND "deletedAt" IS NULL FOR UPDATE`);
      if (!rows.length) invisible();
    }
    // Batch precedes its PI parent, matching the current source lock order.
    const batchIds = [...new Set<string>(before.attachments.filter(row => row.batchId).map(row => row.batchId))].sort();
    for (const batchId of batchIds) {
      const rows = await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "OrderShipmentBatch" WHERE "id"=${batchId} AND "deletedAt" IS NULL FOR UPDATE`);
      if (!rows.length) reject('INVALID_AMOUNT', '原发票的批次不存在或已删除，请先核对原分配。');
    }
    const table = kind === 'quotation' ? Prisma.raw('"Quotation"') : Prisma.raw('"Invoice"');
    const locked = await tx.$queryRaw(Prisma.sql`SELECT "id" FROM ${table} WHERE "id"=${id} AND "deletedAt" IS NULL FOR UPDATE`);
    if (!locked.length) return { actor, source: null, parents: null };
    // Existing active child rows share the locked Invoice parent boundary.
    // Re-read below also rejects changed/added/removed parent membership.
    if (kind === 'invoice') for (const attachment of before.attachments) {
      const rows = await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "InvoiceOrderAllocation" WHERE "id"=${attachment.id} AND "deletedAt" IS NULL FOR UPDATE`);
      if (!rows.length) reject('CONFLICT', '来源关联已变化，请刷新核对后重试。');
    }
    actor = await currentProformaActor(tx, actorId, trustedActor);
    const source = await load(); if (!source) return { actor, source: null, parents: null };
    // A stable non-PI/cancelled PI retains the service's established domain
    // refusal. It cannot turn into an eligible conversion while waiting on the
    // PI lock and then consume financial sources that this prelude did not lock.
    if (kind === 'invoice' && !conversionCandidate && source.type === 'Proforma' && source.status !== 'Cancelled')
      reject('CONFLICT', '原发票类型或状态在取得锁时变化，请刷新核对后重试。');
    const after = await actualParents(tx, kind, source); await requireSource(tx, actor, kind, source, after);
    if (kind === 'invoice') for (const allocation of after.attachments) {
      if (!allocation.batchId) continue;
      const batch = after.batches.find(row => row.id === allocation.batchId);
      if (!batch || batch.deletedAt != null || batch.status === 'cancelled' || batch.orderId !== allocation.orderId)
        reject('INVALID_AMOUNT', '原发票的批次已失效或订单归属不一致，请先核对原分配。');
      if (batch.currency !== source.currency) reject('CONFLICT', '原发票与批次币种不一致，请先核对实际来源；本次不会自动换汇。');
    }
    if (before.signature !== after.signature) reject('CONFLICT', '来源关联已变化，请刷新核对后重试。');
    return { actor, source, parents: after };
  } catch (error: any) {
    if (error instanceof ProformaAccessError) throw error;
    // Transport deliberate native source refusals through the existing PI
    // error contract. A driver/missing-delegate error with a similar code is
    // still a dependency failure, never evidence that the source was valid.
    if (isBusinessError(error) || error instanceof DevelopmentDomainError || error instanceof OrderLineWriteError) {
      if (isProformaAccessCode(error.code)) reject(error.code, String(error.message));
      if (error.code === 'ORDER_NOT_FOUND') invisible();
      if (error.code === 'ACCOUNT_DISABLED') reject('UNAUTHORIZED', '当前账号已失效，请重新登录。');
      if (error.code === 'AUTHORIZATION_UNAVAILABLE') reject('DEPENDENCY_CHECK_FAILED', '当前授权暂时无法核对，请稍后重试。');
    }
    if (error?.code === 'P2034' || error?.code === 'P2010' && ['40001', '40P01'].includes(error?.meta?.code)) reject('CONFLICT', '来源正在被其他操作更新，请刷新后重试。');
    return reject('DEPENDENCY_CHECK_FAILED', '开票来源或当前可见范围暂时无法核对，请稍后重试。');
  }
}
