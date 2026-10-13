/** Current financial scope plus actual source parents. Customer-directory
 * visibility and a stale JWT role never authorize a business invoice. */
import type { TokenPayload } from '../auth/service';
import type { PermissionScope } from '../_shared/rolePermissionMatrix';
import { createPermissionService } from '../auth/permissionService';
import { createTeamShareService } from '../teams/teamShareService';
import { buildOrderListScopeWhere } from '../orders/orderService';
import { businessError } from '../shared/errorCodes';
import { currentCiActor, ciHash, DEVELOPMENT_CI_SOURCE, developmentCiSnapshot } from '../development/developmentCiSource';
import { BUSINESS_SHIPMENT_CI_PREFIX } from '../customs/businessShipmentCiSnapshot';
import { SUPPLIER_VAT_PAYABLE_SOURCE, readSupplierVatPayableSource, supplierVatAuthorizationOrderIds } from './supplierVatPayableSource';
import { FABRIC_COMMISSION_SOURCE, readFabricCommissionOriginal, readFabricCommissionInvoiceSource } from './fabricCommissionSource';

const invisible = (): never => { throw businessError('NOT_FOUND', '财务记录不存在，或不在当前业务数据范围。'); };
type Source = { type: string; id: string };

export async function createFinanceSourceAccess(tx: any, prior: TokenPayload | null | undefined,
  scopes: readonly PermissionScope[] = ['invoices:read']) {
  const actor = await currentCiActor(tx, prior, scopes);
  const resolver = await createPermissionService({ prisma: tx }).getDataScopeResolver(actor, 'finance');
  const all = resolver.rule.kind === 'all';
  const signature = ciHash({ userId: actor.userId, roles: actor.roles, roleIds: actor.roleIds,
    permissions: actor.permissions, ceiling: actor.permissionCeiling, resolver });
  const share = createTeamShareService(tx);
  const allowedOwners = new Set<string>(resolver.allowedUserIds ?? [actor.userId]);
  const authorizedInvoices = new Set<string>();
  const authorizedVouchers = new Set<string>();
  const authorizedVatInvoices = new Set<string>();

  async function customer(id: string | null | undefined) {
    if (!id) return false;
    const row = await tx.relation.findFirst({ where: { id, deletedAt: null }, select: { id: true, ownerId: true, salesRepIds: true } });
    if (!row) return false;
    if (all) return true;
    const followedBy = [row.ownerId, ...(Array.isArray(row.salesRepIds) ? row.salesRepIds : [])];
    if (followedBy.includes(actor.userId)) return true;
    if (resolver.rule.kind !== 'team') return false;
    return followedBy.some(userId => allowedOwners.has(userId))
      || (await share.getActiveGrantedRelationIds(actor.userId, { fresh: true })).includes(id);
  }
  async function order(id: string) {
    const row = await tx.order.findFirst({ where: { id, deletedAt: null } });
    if (!row) return false;
    if (all) return true;
    if (!await tx.order.findFirst({ where: { id, deletedAt: null,
      AND: [await buildOrderListScopeWhere(tx, actor, { fresh: true })] }, select: { id: true } })) return false;
    // A wider orders role cannot silently expand a narrower finance scope.
    return await customer(row.customerRelationId) || allowedOwners.has(row.ownerId);
  }
  async function source(ref: Source, path = new Set<string>()): Promise<boolean> {
    if (!ref.id || !ref.type || path.size > 32) return false;
    const key = `${ref.type}:${ref.id}`;
    if (path.has(key)) return false;
    const next = new Set(path); next.add(key);
    if (ref.type === 'Order') return order(ref.id);
    if (ref.type === FABRIC_COMMISSION_SOURCE) {
      const version = await tx.documentVersion.findUnique({ where: { id: ref.id } });
      if (!version) return false;
      const original = await readFabricCommissionOriginal(tx, version.documentId);
      return original.version.id === ref.id && order(original.snapshot.source.orderId);
    }
    if (ref.type === SUPPLIER_VAT_PAYABLE_SOURCE) {
      const original = await readSupplierVatPayableSource(tx, ref.id);
      for (const id of supplierVatAuthorizationOrderIds(original.snapshot)) if (!await order(id)) return false;
      return true;
    }
    if (ref.type === 'Scene') {
      const split = ref.id.indexOf(':'), scene = ref.id.slice(0, split), id = ref.id.slice(split + 1);
      const type = ({ dev_cost: 'DevelopmentCase', fabric: 'DevelopmentCase', sample: 'Sample', order: 'Order' } as any)[scene];
      return split > 0 && !!type && source({ type, id }, next);
    }
    if (ref.type === DEVELOPMENT_CI_SOURCE || ref.type === 'BusinessShipmentCI') {
      const version = await tx.documentVersion.findUnique({ where: { id: ref.id } });
      const document = version && await tx.tradeDocument.findFirst({ where: { id: version.documentId, deletedAt: null } });
      if (!version || !document || document.status !== 'Issued') return false;
      if (ref.type === DEVELOPMENT_CI_SOURCE) {
        const snapshot = developmentCiSnapshot(version, document);
        return !!snapshot.issuedAt && source({ type: 'DevelopmentCase', id: snapshot.caseId }, next);
      }
      const snapshot = version.content?.commercialInvoiceSnapshot;
      if (document.type !== 'CommercialInvoice' || document.domain !== 'customs' || document.sourceInvoiceId != null
        || !document.sourceRef?.startsWith(`${BUSINESS_SHIPMENT_CI_PREFIX}${document.shipmentId}:`)
        || snapshot?.sourceKind !== 'shipment' || snapshot.shipmentId !== document.shipmentId || !snapshot.issuedAt
        || !Array.isArray(snapshot.orderIds) || !snapshot.orderIds.length) return false;
      for (const id of snapshot.orderIds) if (!await order(id)) return false;
      return source({ type: 'Shipment', id: snapshot.shipmentId }, next);
    }
    const models: Record<string, string> = { DevelopmentCase: 'developmentCase', Sample: 'sample', SampleBatch: 'sampleBatch',
      SealSample: 'sealSample', OrderLine: 'orderLine', CostRecord: 'costRecord', BillingItem: 'billingItem',
      Shipment: 'shipment', Quotation: 'quotation', PurchaseOrder: 'purchaseOrder', purchaseOrder: 'purchaseOrder',
      PurchaseServiceDelivery: 'purchaseServiceDelivery', materialReturn: 'materialReturn' };
    const model = models[ref.type];
    if (!model) return false; // New/unknown producers need an explicit source adapter.
    const row = await tx[model].findFirst({ where: { id: ref.id } });
    if (!row || row.deletedAt != null) return false;
    if (ref.type === 'CostRecord' || ref.type === 'BillingItem') {
      if (!await source({ type: row.sourceType, id: row.sourceId }, next)) return false;
      if (ref.type === 'BillingItem' && row.costRecordId && !await source({ type: 'CostRecord', id: row.costRecordId }, next)) return false;
      return true;
    }
    const parents: Source[] = [];
    if (ref.type === 'DevelopmentCase') return customer(row.customerRelationId);
    if (row.sourceCaseId || row.developmentCaseId) parents.push({ type: 'DevelopmentCase', id: row.sourceCaseId || row.developmentCaseId });
    if (row.sourceOrderId || row.orderId) parents.push({ type: 'Order', id: row.sourceOrderId || row.orderId });
    if (row.orderLineId) parents.push({ type: 'OrderLine', id: row.orderLineId });
    if (row.purchaseOrderId) parents.push({ type: 'PurchaseOrder', id: row.purchaseOrderId });
    if (ref.type === 'Shipment') {
      const links = await tx.shipmentOrderAllocation.findMany({ where: { shipmentId: row.id } });
      for (const link of links) parents.push({ type: 'Order', id: link.orderId });
    }
    for (const parent of parents) if (!await source(parent, next)) return false;
    if (parents.length) return true;
    return customer(row.customerRelationId);
  }
  async function invoice(row: any): Promise<boolean> {
    if (!row || row.deletedAt != null) return false;
    if (row.sourceType === FABRIC_COMMISSION_SOURCE) {
      if (!row.sourceId) return false;
      const original = await readFabricCommissionInvoiceSource(tx, row.sourceId);
      if (original.invoice.id !== row.id || !await order(original.snapshot.source.orderId)) return false;
      authorizedInvoices.add(row.id); return true;
    }
    // Native supplier AP always proves its original VAT and exact approved
    // contract lineage, including under a legitimate all-finance scope.
    if (row.sourceType === SUPPLIER_VAT_PAYABLE_SOURCE) {
      if (!row.sourceId) return false;
      const original = await readSupplierVatPayableSource(tx, row.sourceId);
      if (original.invoice.id !== row.id) return false;
      for (const id of supplierVatAuthorizationOrderIds(original.snapshot)) if (!await order(id)) return false;
      authorizedInvoices.add(row.id); return true;
    }
    // Explicit all-finance scope includes historical/unclassified records for
    // reconciliation. Ordinary business users must resolve a known producer.
    if (all) { authorizedInvoices.add(row.id); return true; }
    if ((row.sourceType == null) !== (row.sourceId == null)) return false;
    if (row.customerRelationId && row.type !== 'Payable' && !await customer(row.customerRelationId)) return false;
    let anchored = false;
    if (row.sourceType === 'CommissionPayable') {
      if (!row.orderId || !(row.sourceId === row.orderId || row.sourceId?.startsWith(`${row.orderId}#`))) return false;
      if (!await order(row.orderId)) return false; anchored = true;
    } else if (row.sourceType != null) {
      if (!await source({ type: row.sourceType, id: row.sourceId })) return false; anchored = true;
    }
    const links = await tx.invoiceOrderAllocation.findMany({ where: { invoiceId: row.id, deletedAt: null } });
    const orders = new Set<string>([row.orderId, ...links.map((link: any) => link.orderId)].filter(Boolean));
    for (const id of orders) { if (!await order(id)) return false; anchored = true; }
    const lines = await tx.invoiceLine.findMany({ where: { invoiceId: row.id } });
    for (const line of lines) {
      if (line.sourceType === 'Manual') continue;
      if (!await source({ type: line.sourceType, id: line.sourceId })) return false;
      anchored = true;
    }
    const visible = anchored || await customer(row.customerRelationId);
    if (visible) authorizedInvoices.add(row.id);
    return visible;
  }
  async function voucher(row: any) {
    if (!row || row.deletedAt != null) return false;
    if (all) { authorizedVouchers.add(row.id); return true; }
    if (row.orderId && !await order(row.orderId)) return false;
    // Cash ownership is not customer follow-up authority. A third-party payer
    // is legal, while reading its whole voucher still needs actual source L2.
    const visible = await customer(row.customerRelationId);
    if (!visible) return false;
    if (row.invoiceId && !await invoice(await tx.invoice.findFirst({ where: {id: row.invoiceId, deletedAt: null} }))) return false;
    for (const link of await tx.invoiceAllocation.findMany({where: {voucherId: row.id}}))
      if (!await invoice(await tx.invoice.findFirst({where: {id: link.invoiceId, deletedAt: null}}))) return false;
    authorizedVouchers.add(row.id);
    return true;
  }
  async function vat(row: any) {
    if (!row || row.deletedAt != null) return false;
    if (all) { if (row.id) authorizedVatInvoices.add(row.id); return true; }
    let anchored = false;
    if (row.invoiceId) {
      if (!await invoice(await tx.invoice.findFirst({ where: { id: row.invoiceId, deletedAt: null } }))) return false;
      anchored = true;
    }
    if (row.orderId) { if (!await order(row.orderId)) return false; anchored = true; }
    if (!anchored && !await customer(row.relationId)) return false;
    if (row.id) authorizedVatInvoices.add(row.id); return true;
  }
  async function quotation(row: any) {
    if (!row || row.deletedAt != null) return false;
    if (all) return true;
    if (row.orderId && !await order(row.orderId)) return false;
    return await customer(row.customerRelationId) || allowedOwners.has(row.ownerId);
  }
  async function recheckAuthority() {
    const fresh = await currentCiActor(tx, prior, scopes);
    const scope = await createPermissionService({ prisma: tx }).getDataScopeResolver(fresh, 'finance');
    if (signature !== ciHash({ userId: fresh.userId, roles: fresh.roles, roleIds: fresh.roleIds,
      permissions: fresh.permissions, ceiling: fresh.permissionCeiling, resolver: scope }))
      throw businessError('CONFLICT', '当前财务权限或数据范围已变化，请重新读取。');
  }
  async function finish(options: { deletedInvoiceIds?: string[]; deletedVoucherIds?: string[]; deletedVatIds?: string[] } = {}) {
    await recheckAuthority();
    for (const id of [...authorizedInvoices]) {
      let row = await tx.invoice.findFirst({ where: { id } });
      if (row && options.deletedInvoiceIds?.includes(id)) row = { ...row, deletedAt: null };
      if (!await invoice(row)) invisible();
    }
    for (const id of [...authorizedVouchers]) {
      let row = await tx.paymentVoucher.findFirst({ where: { id } });
      if (row && options.deletedVoucherIds?.includes(id)) row = { ...row, deletedAt: null };
      if (!await voucher(row)) invisible();
    }
    for (const id of [...authorizedVatInvoices]) {
      let row = await tx.vatInvoice.findFirst({ where: { id } });
      if (row && options.deletedVatIds?.includes(id)) row = { ...row, deletedAt: null };
      if (!await vat(row)) invisible();
    }
  }
  return { actor, all, customer, order, source, invoice, voucher, vat, quotation, finish, recheckAuthority,
    ownerAllowed: (id:string|null|undefined) => all || !!id && allowedOwners.has(id),
    teamAllowed: (id:string|null|undefined) => all || !!id && (resolver.allowedTeamIds ?? []).includes(id) };
}

export type FinanceObjectKind = 'invoice' | 'voucher' | 'vat' | 'quotation';
const objectModels = { invoice: 'invoice', voucher: 'paymentVoucher', vat: 'vatInvoice', quotation: 'quotation' } as const;

/** Financial scope and actual parents are intersected before pagination/count. */
export async function visibleFinanceObjectWhere(tx: any, actor: TokenPayload | null | undefined, kind: FinanceObjectKind,
  where: any = {}, scopes: readonly PermissionScope[] = [kind === 'voucher' ? 'vouchers:read' : kind === 'vat' ? 'vat:read' : kind === 'quotation' ? 'quotations:read' : 'invoices:read']) {
  const access = await createFinanceSourceAccess(tx, actor, scopes);
  if (access.all) return { where, access };
  const ids: string[] = [];
  for (const row of await tx[objectModels[kind]].findMany({ where })) if (await access[kind](row)) ids.push(row.id);
  await access.finish();
  return { where: { AND: [where, { id: { in: ids } }] }, access };
}

export async function requireFinanceObjectAccess(tx: any, actor: TokenPayload | null | undefined, kind: FinanceObjectKind,
  id: string, scopes: readonly PermissionScope[]) {
  const access = await createFinanceSourceAccess(tx, actor, scopes);
  const row = await tx[objectModels[kind]].findFirst({ where: { id, deletedAt: null } });
  if (!await access[kind](row)) invisible();
  await access.finish();
  return { row, access };
}

/** Validate VAT links as financial source facts, not arbitrary foreign IDs. */
export async function assertVatInvoiceSource(tx: any, row: any) {
  if (row.relationId && !await tx.relation.findFirst({ where: { id: row.relationId, deletedAt: null } }))
    throw businessError('CONFLICT', '供应商或客户档案不存在，请核对原票。');
  if (row.orderId && !await tx.order.findFirst({ where: { id: row.orderId, deletedAt: null } }))
    throw businessError('CONFLICT', '原票关联订单不存在。');
  if (!row.invoiceId) return;
  const invoice = await tx.invoice.findFirst({ where: { id: row.invoiceId, deletedAt: null } });
  if (!invoice || invoice.status === 'Cancelled') throw businessError('CONFLICT', '原票关联的账目不存在或已作废。');
  if (invoice.sourceType === SUPPLIER_VAT_PAYABLE_SOURCE && (invoice.sourceId !== row.id || row.direction !== 'Input'))
    throw businessError('HANDOFF_CONFLICT', '原生供应商应付只关联其准确供应商原票，不能将其他票改挂或冒用该登记。');
  if (row.direction === 'Input' && (invoice.type !== 'Payable' || ['BusinessDevelopmentCI', 'BusinessShipmentCI'].includes(invoice.sourceType)))
    throw businessError('CONFLICT', '供应商进项原票只能关联供应商应付，不能借用我方业务 CI。');
  if (row.direction === 'Output' && invoice.type !== 'Receivable') throw businessError('CONFLICT', '销项原票与应收应付方向不一致。');
  if (invoice.currency !== row.currency || row.relationId && invoice.customerRelationId !== row.relationId)
    throw businessError('CONFLICT', '原票币种或交易对象与关联账目不一致。');
  if (row.orderId && invoice.orderId !== row.orderId && !await tx.invoiceOrderAllocation.findFirst({ where: { invoiceId: invoice.id, orderId: row.orderId, deletedAt: null } }))
    throw businessError('CONFLICT', '原票订单不在关联账目的准确来源范围。');
}

/** Apply visibility before limit/count. Never use a post-page filter. */
export async function visibleFinanceInvoiceWhere(tx: any, prior: TokenPayload | null | undefined, where: any = {}) {
  const access = await createFinanceSourceAccess(tx, prior);
  if (access.all) return { where, access };
  const candidates = await tx.invoice.findMany({ where });
  const ids: string[] = [];
  for (const row of candidates) if (await access.invoice(row)) ids.push(row.id);
  await access.finish();
  return { where: { AND: [where, { id: { in: ids } }] }, access };
}

export async function requireFinanceInvoiceAccess(tx: any, prior: TokenPayload | null | undefined, invoiceId: string,
  scopes: readonly PermissionScope[] = ['invoices:read']) {
  const access = await createFinanceSourceAccess(tx, prior, scopes);
  const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, deletedAt: null } });
  if (!await access.invoice(invoice)) invisible();
  await access.finish();
  return { invoice, access };
}

/** Used only with trusted transport actor context, never req.body.actor. */
export async function requireFinanceAllocationAccess(tx: any, prior: TokenPayload | null | undefined, invoiceId: string, voucherId: string) {
  const { invoice, access } = await requireFinanceInvoiceAccess(tx, prior, invoiceId, ['invoices:read', 'invoices:reconcile']);
  const voucher = await tx.paymentVoucher.findFirst({ where: { id: voucherId, deletedAt: null } });
  if (invoice.sourceType === SUPPLIER_VAT_PAYABLE_SOURCE) {
    const original = await readSupplierVatPayableSource(tx, invoice.sourceId);
    if (['RedFlushed', 'Cancelled'].includes(original.vatInvoice.status))
      throw businessError('CONFLICT', '供应商原票已红冲或作废，请先核对独立应付冲销依据；税务状态不等于付款或账款已冲。');
  }
  if (!await access.voucher(voucher)) invisible();
  await access.finish();
  return { invoice, voucher, access };
}

export async function listVisibleFinanceAllocations(tx: any, prior: TokenPayload | null | undefined,
  params: { invoiceId?: string; voucherId?: string; limit?: number } = {}) {
  if (params.invoiceId) await requireFinanceInvoiceAccess(tx, prior, params.invoiceId);
  if (params.voucherId) await requireFinanceObjectAccess(tx, prior, 'voucher', params.voucherId, ['vouchers:read']);
  const visible = await visibleFinanceInvoiceWhere(tx, prior, { deletedAt: null });
  const invoices = await tx.invoice.findMany({ where: visible.where, select: { id: true } });
  const where = { invoiceId: params.invoiceId ?? { in: invoices.map((row: any) => row.id) },
    ...(params.voucherId ? { voucherId: params.voucherId } : {}) };
  const [items, total] = await Promise.all([
    tx.invoiceAllocation.findMany({ where, orderBy: { createdAt: 'desc' }, take: Math.max(1, Math.min(params.limit ?? 200, 500)) }),
    tx.invoiceAllocation.count({ where }),
  ]);
  for (const item of items) await requireFinanceInvoiceAccess(tx, prior, item.invoiceId);
  await visible.access.finish();
  return { items, total };
}
