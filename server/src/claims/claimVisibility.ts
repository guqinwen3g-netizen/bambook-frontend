import { httpStatusOfCode } from '../shared/errorCodes';
import type { TokenPayload } from '../auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../auth/tokenHelpers';
import { createPermissionService, hasScope } from '../auth/permissionService';
import { buildScopeWhereFromResolver } from '../auth/dataScopeWhere';
import { createTeamShareService } from '../teams/teamShareService';

/** DR-042 §5.1/5.3: business subtrees inherit actual customer L2 visibility.
 * Module permission is a separate route gate; a known name is never a customer FK.
 * DB faults cannot be presented as a successfully empty customer/work queue.
 */
export class ClaimVisibilityError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'VALIDATION_FAILED' | 'DEPENDENCY_CHECK_FAILED' | 'ACCOUNT_DISABLED' | 'FORBIDDEN',
    message: string) { super(message); this.statusCode = httpStatusOfCode(code); }
  readonly statusCode: number;
}
const missing = () => new ClaimVisibilityError('NOT_FOUND', '记录不存在或不在当前业务范围内');
const invalid = (message: string) => new ClaimVisibilityError('VALIDATION_FAILED', message);
const unavailable = () => new ClaimVisibilityError('DEPENDENCY_CHECK_FAILED', '暂时无法核验售后业务来源和数据范围，请稍后重试');
export function claimPage(input: { offset?: unknown; limit?: unknown } = {}) {
  const limit = input.limit == null ? 100 : Number(input.limit);
  const offset = input.offset == null ? 0 : Number(input.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(offset) || offset < 0) throw invalid('limit 须为 1–500 的整数，offset 须为非负整数');
  return { limit, offset };
}
async function checked<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (error) {
    if (error instanceof ClaimVisibilityError) throw error;
    throw unavailable();
  }
}
function sourceId(value: unknown, field: string): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value) throw invalid(`${field} 须为准确的记录 ID`);
  return value;
}
const ids = (rows: any[]) => rows.map(row => row.id);

/** Structural validation also runs inside create's business transaction.
 * DR-016 permits a distinct invoice billTo only when the actual order link proves
 * the source; the complaint customer remains the order's business customer.
 */
export async function validateClaimSourceFacts(tx: any, input: any) {
  return checked(async () => {
    let customerRelationId = sourceId(input.customerRelationId, 'customerRelationId');
    const sourceOrderId = sourceId(input.sourceOrderId, 'sourceOrderId');
    const sourceInvoiceId = sourceId(input.sourceInvoiceId, 'sourceInvoiceId');
    const order = sourceOrderId ? await tx.order.findFirst({ where: { id: sourceOrderId, deletedAt: null } }) : null;
    const invoice = sourceInvoiceId ? await tx.invoice.findFirst({ where: { id: sourceInvoiceId, deletedAt: null, type: 'Receivable' } }) : null;
    if (sourceOrderId && !order || sourceInvoiceId && !invoice) throw missing();
    if (order) {
      if (customerRelationId && customerRelationId !== (order.customerRelationId ?? null)) throw invalid('案件客户与真实来源订单的业务客户不一致');
      customerRelationId = order.customerRelationId ?? null;
      if (invoice && invoice.orderId !== order.id) {
        const allocation = await tx.invoiceOrderAllocation.findFirst({ where: { invoiceId: invoice.id, orderId: order.id, deletedAt: null } });
        if (!allocation) throw invalid('发票与来源订单没有真实有效的关联');
      }
    } else if (invoice) {
      if (!invoice.customerRelationId || customerRelationId && customerRelationId !== invoice.customerRelationId) throw invalid('未关联订单时，案件客户须为真实来源发票的开票对象');
      customerRelationId = invoice.customerRelationId;
    }
    const customer = customerRelationId ? await tx.relation.findFirst({ where: { id: customerRelationId, deletedAt: null, category: 'Customer' } }) : null;
    if (customerRelationId && !customer) throw missing();
    return { customerRelationId, sourceOrderId, sourceInvoiceId,
      customerName: customer ? customer.name : input.customerName ?? null, customer, order, invoice };
  });
}

export function createClaimVisibility(prisma: any, inputActor: TokenPayload) {
  let contextPromise: Promise<any> | undefined;
  async function context() {
    if (!contextPromise) contextPromise = checked(async () => {
      // Re-read identity, role tree and personal grants. Keep credential ceilings.
      const user = await loadUserWithRoles(prisma, inputActor.userId);
      if (!user || user.status !== 'active' || user.deletedAt != null) throw new ClaimVisibilityError('ACCOUNT_DISABLED', '当前账号不可用');
      const actor = await buildLoadedAuthTokenPayload(prisma, user);
      if (inputActor.permissionCeiling !== undefined) actor.permissionCeiling = [...inputActor.permissionCeiling];
      // The existing general resolver has compatibility fallbacks on team-query
      // faults. Observe that exact delegated query instead of inventing a role map.
      let resolverFault = false;
      const strictPrisma = new Proxy(prisma, { get(target, key) {
        if (key !== 'teamMember') return Reflect.get(target, key);
        if (!target.teamMember) { resolverFault = true; throw unavailable(); }
        return new Proxy(target.teamMember, { get(delegate, method) {
          if (method !== 'findMany') return Reflect.get(delegate, method);
          return async (...args: any[]) => { try { return await delegate.findMany(...args); } catch (error) { resolverFault = true; throw error; } };
        } });
      } });
      const permission = createPermissionService({ prisma: strictPrisma });
      const resolve = async (module: string) => {
        const result = await permission.getDataScopeResolver(actor, module);
        if (resolverFault) throw unavailable();
        return result;
      };
      const caseResolver = await resolve('aftersales');
      const orderResolver = await resolve('orders');
      const financeResolver = await resolve('finance');
      const visibleRelationIds = caseResolver.rule.kind === 'all' ? null
        : await createTeamShareService(strictPrisma).resolveVisibleRelationIds(actor, { fresh: true });
      if (resolverFault) throw unavailable();
      const relationWhere = visibleRelationIds === null ? {} : { id: { in: visibleRelationIds } };
      const orderWhere = orderResolver.rule.kind === 'all' ? {} : { OR: [
        { customerRelationId: { in: visibleRelationIds ?? await createTeamShareService(strictPrisma).resolveVisibleRelationIds(actor, { fresh: true }) } },
        { AND: [{ customerRelationId: null }, { ownerId: actor.userId }] },
      ] };
      const invoiceWhere = buildScopeWhereFromResolver(financeResolver, actor.userId);
      return { actor, caseResolver, orderResolver, financeResolver, relationWhere, orderWhere, invoiceWhere, visibleRelationIds };
    });
    return contextPromise;
  }
  let caseWherePromise: Promise<any> | undefined;
  async function caseScopeWhere() {
    if (!caseWherePromise) caseWherePromise = checked(async () => {
      const ctx = await context();
      // A module-wide case view is not authority over other module anchors.
      // Preserve the existing unrestricted-history path only when every
      // independently resolved source module is itself unrestricted.
      if ([ctx.caseResolver, ctx.orderResolver, ctx.financeResolver].every(resolver => resolver.rule.kind === 'all')) return {};
      const [orders, invoices] = await Promise.all([
        prisma.order.findMany({ where: { deletedAt: null, AND: [ctx.orderWhere] }, select: { id: true } }),
        prisma.invoice.findMany({ where: { deletedAt: null, type: 'Receivable', AND: [ctx.invoiceWhere] }, select: { id: true } }),
      ]);
      return { OR: [
        { AND: [
          ...(ctx.visibleRelationIds === null ? [] : [{ OR: [{ customerRelationId: null }, { customerRelationId: { in: ctx.visibleRelationIds } }] }]),
          { OR: [{ sourceOrderId: null }, { sourceOrderId: { in: ids(orders) } }] },
          { OR: [{ sourceInvoiceId: null }, { sourceInvoiceId: { in: ids(invoices) } }] },
          { OR: [{ customerRelationId: { not: null } }, { sourceOrderId: { not: null } }, { sourceInvoiceId: { not: null } }] },
        ] },
        { customerRelationId: null, sourceOrderId: null, sourceInvoiceId: null,
          ...(ctx.caseResolver.rule.kind === 'all' ? {} : { reportedBy: { in: ctx.caseResolver.allowedUserIds ?? [ctx.actor.userId] } }) },
      ] };
    });
    return caseWherePromise;
  }
  async function requireCase(id: string) {
    return checked(async () => {
      const row = await prisma.claimCase.findFirst({ where: { id, deletedAt: null, AND: [await caseScopeWhere()] } });
      if (!row) throw missing();
      return row;
    });
  }
  async function requireChild(kind: 'disposition' | 'returnReceipt' | 'returnLine' | 'repair' | 'shipment', id: string) {
    return checked(async () => {
      let row: any;
      if (kind === 'shipment') {
        const [dispositions, repairs] = await Promise.all([
          prisma.claimDisposition.findMany({ where: { replacementShipmentId: id, deletedAt: null } }),
          prisma.repairWorkOrder.findMany({ where: { reshipmentId: id, deletedAt: null } }),
        ]);
        if (dispositions.length + repairs.length !== 1) throw missing();
        row = dispositions[0] ?? repairs[0];
      } else if (kind === 'returnLine') {
        row = await prisma.returnReceiptLine.findUnique({ where: { id } });
        if (!row) throw missing();
        const [receipt, disposition] = await Promise.all([
          prisma.returnReceipt.findFirst({ where: { id: row.returnReceiptId, deletedAt: null } }),
          prisma.claimDisposition.findFirst({ where: { id: row.claimDispositionId, deletedAt: null } }),
        ]);
        if (!receipt || !disposition || receipt.claimCaseId !== disposition.claimCaseId) throw missing();
        row = { ...row, claimCaseId: receipt.claimCaseId };
      } else {
        const model = kind === 'disposition' ? prisma.claimDisposition : kind === 'repair' ? prisma.repairWorkOrder : prisma.returnReceipt;
        row = await model.findFirst({ where: { id, deletedAt: null } });
      }
      if (!row?.claimCaseId) throw missing();
      await requireCase(row.claimCaseId);
      return row;
    });
  }
  async function creditNoteScopeWhere() {
    return checked(async () => {
      const ctx = await context();
      if ([ctx.caseResolver, ctx.orderResolver, ctx.financeResolver].every(resolver => resolver.rule.kind === 'all')) return {};
      const cases = await prisma.claimCase.findMany({ where: { deletedAt: null, AND: [await caseScopeWhere()] }, select: { id: true } });
      const invoices = await prisma.invoice.findMany({ where: { deletedAt: null, type: 'Receivable', AND: [ctx.invoiceWhere] }, select: { id: true } });
      return { OR: [
        { AND: [
          { OR: [{ claimCaseId: null }, { claimCaseId: { in: ids(cases) } }] },
          { OR: [{ logicalClaimCaseId: null }, { logicalClaimCaseId: { in: ids(cases) } }] },
          { OR: [{ claimCaseId: { not: null } }, { logicalClaimCaseId: { not: null } }] },
          { OR: [{ sourceInvoiceId: null }, { sourceInvoiceId: { in: ids(invoices) } }] },
        ] },
        { claimCaseId: null, logicalClaimCaseId: null, AND: [
          ...(ctx.visibleRelationIds === null ? [] : [{ OR: [{ customerRelationId: null }, { customerRelationId: { in: ctx.visibleRelationIds } }] }]),
          { OR: [{ sourceInvoiceId: null }, { sourceInvoiceId: { in: ids(invoices) } }] },
          ...(ctx.caseResolver.rule.kind === 'all' ? [] : [{ OR: [{ customerRelationId: { not: null } }, { sourceInvoiceId: { not: null } }] }]),
        ] },
      ] };
    });
  }
  async function requireCreditNote(id: string) {
    return checked(async () => {
      const note = await prisma.creditNote.findFirst({ where: { id, deletedAt: null, AND: [await creditNoteScopeWhere()] } });
      if (!note) throw missing();
      if (note.claimCaseId && note.logicalClaimCaseId && note.claimCaseId !== note.logicalClaimCaseId) throw missing();
      if (note.claimCaseId || note.logicalClaimCaseId) {
        const claim = await requireCase(note.claimCaseId || note.logicalClaimCaseId);
        if ((note.customerRelationId ?? null) !== (claim.customerRelationId ?? null)) throw missing();
      }
      return note;
    });
  }
  async function requireInvoice(id: string) {
    return checked(async () => {
      const ctx = await context();
      const row = await prisma.invoice.findFirst({ where: { id, deletedAt: null, type: 'Receivable', AND: [ctx.invoiceWhere] } });
      if (!row) throw missing();
      return row;
    });
  }
  async function assertCreateSources(input: any) {
    return checked(async () => {
      const ctx = await context();
      if (!hasScope(ctx.actor, 'aftersales:write')) throw new ClaimVisibilityError('FORBIDDEN', '当前权限不可登记售后案件');
      // Establish visibility before reporting consistency errors, so a guessed
      // private source cannot reveal its existence via a different error code.
      const customerId = sourceId(input.customerRelationId, 'customerRelationId');
      const orderId = sourceId(input.sourceOrderId, 'sourceOrderId');
      const invoiceId = sourceId(input.sourceInvoiceId, 'sourceInvoiceId');
      if (customerId && !await prisma.relation.findFirst({ where: { id: customerId, category: 'Customer', deletedAt: null, AND: [ctx.relationWhere] }, select: { id: true } })) throw missing();
      if (orderId && !await prisma.order.findFirst({ where: { id: orderId, deletedAt: null, AND: [ctx.orderWhere] }, select: { id: true } })) throw missing();
      if (invoiceId) await requireInvoice(invoiceId);
      const facts = await validateClaimSourceFacts(prisma, input);
      if (facts.customer && !await prisma.relation.findFirst({ where: { id: facts.customer.id, deletedAt: null, AND: [ctx.relationWhere] }, select: { id: true } })) throw missing();
      if (facts.order && !await prisma.order.findFirst({ where: { id: facts.order.id, deletedAt: null, AND: [ctx.orderWhere] }, select: { id: true } })) throw missing();
      return facts;
    });
  }
  async function candidateCustomers(filter: any = {}) {
    return checked(async () => {
      const ctx = await context(), page = claimPage(filter);
      const where = { deletedAt: null, category: 'Customer', AND: [ctx.relationWhere,
        ...(filter.search ? [{ name: { contains: String(filter.search), mode: 'insensitive' } }] : [])] };
      const [items, total] = await Promise.all([
        prisma.relation.findMany({ where, select: { id: true, name: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }], skip: page.offset, take: page.limit }),
        prisma.relation.count({ where }),
      ]);
      return { items, total, ...page };
    });
  }
  async function candidateOrders(filter: any = {}) {
    return checked(async () => {
      const ctx = await context(), page = claimPage(filter);
      const where = { deletedAt: null, ...(filter.customerRelationId ? { customerRelationId: String(filter.customerRelationId) } : {}), AND: [ctx.orderWhere] };
      const [items, total] = await Promise.all([
        prisma.order.findMany({ where, select: { id: true, code: true, poNumber: true, customerRelationId: true, customer: true }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: page.offset, take: page.limit }),
        prisma.order.count({ where }),
      ]);
      return { items: items.map((row: any) => ({ id: row.id, code: row.code, poNumber: row.poNumber,
        customerRelationId: row.customerRelationId, customerName: row.customer })), total, ...page };
    });
  }
  async function candidateInvoices(filter: any = {}) {
    return checked(async () => {
      const ctx = await context(), page = claimPage(filter);
      let sourceWhere: any = filter.customerRelationId ? { customerRelationId: String(filter.customerRelationId) } : {};
      if (filter.sourceOrderId) {
        const order = await prisma.order.findFirst({ where: { id: String(filter.sourceOrderId), deletedAt: null, AND: [ctx.orderWhere] } });
        if (!order) throw missing();
        if (filter.customerRelationId && filter.customerRelationId !== order.customerRelationId) throw invalid('筛选客户与来源订单不一致');
        const allocations = await prisma.invoiceOrderAllocation.findMany({ where: { orderId: order.id, deletedAt: null }, select: { invoiceId: true } });
        sourceWhere = { OR: [{ orderId: order.id }, { id: { in: allocations.map((row: any) => row.invoiceId) } }] };
      }
      const where = { deletedAt: null, type: 'Receivable', AND: [ctx.invoiceWhere, sourceWhere] };
      const [rows, total] = await Promise.all([
        prisma.invoice.findMany({ where, select: { id: true, invoiceNumber: true, currency: true, customerRelationId: true, customerName: true, orderId: true }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: page.offset, take: page.limit }),
        prisma.invoice.count({ where }),
      ]);
      const allocations = rows.length ? await prisma.invoiceOrderAllocation.findMany({ where: { invoiceId: { in: ids(rows) }, deletedAt: null }, select: { invoiceId: true, orderId: true } }) : [];
      // Only IDs from visible source orders, not every neighbour on a consolidated invoice.
      const orderIds = Array.from(new Set([...rows.map((row: any) => row.orderId), ...allocations.map((row: any) => row.orderId)].filter(Boolean)));
      const visibleOrders = orderIds.length ? await prisma.order.findMany({ where: { id: { in: orderIds }, deletedAt: null, AND: [ctx.orderWhere] }, select: { id: true } }) : [];
      const visibleSet = new Set(ids(visibleOrders));
      const items = rows.map((row: any) => ({ id: row.id, invoiceNumber: row.invoiceNumber, currency: row.currency,
        customerRelationId: row.customerRelationId, billTo: { id: row.customerRelationId, name: row.customerName },
        sourceOrderIds: Array.from(new Set([row.orderId, ...allocations.filter((allocation: any) => allocation.invoiceId === row.id).map((allocation: any) => allocation.orderId)].filter(id => visibleSet.has(id)))) }));
      return { items, total, ...page };
    });
  }
  return { caseScopeWhere, requireCase, requireChild, creditNoteScopeWhere, requireCreditNote, requireInvoice,
    assertCreateSources, candidateCustomers, candidateOrders, candidateInvoices, currentActor: async () => (await context()).actor as TokenPayload };
}

/** Mandatory callback for actual CN refund services. Never accept caller IDs in lieu of this parent. */
export async function assertClaimCreditNoteVisibility(tx: any, note: any, actor: TokenPayload): Promise<void> {
  if (!note?.id || !actor?.userId) throw unavailable();
  await createClaimVisibility(tx, actor).requireCreditNote(note.id);
}
