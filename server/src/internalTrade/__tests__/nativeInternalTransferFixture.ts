/** Mock storage only. Native create/routing/decision services produce every approval fact.
 * This fixture is not SQL/transaction/concurrency evidence; opt-in PG probes cover those. */
import { vi } from 'vitest';
import { createInternalTransferService, internalTransferFingerprint } from '../internalTransferService';
import { createApprovalCreateService } from '../../approvals/approvalCreateService';
import { createApprovalRoutingService } from '../../approvals/approvalRoutingService';
import { approvalReviewContentVersion, createApprovalDecisionService } from '../../approvals/approvalDecisionService';
import type { TokenPayload } from '../../auth/service';

export const GARMENT_ORDER = { id: 'G1', deletedAt: null, status: 'Production', isInternalFabricTrade: false, businessLine: 'garment' };
export const FABRIC_ORDER = { id: 'F1', deletedAt: null, status: 'Production', isInternalFabricTrade: true, businessLine: 'fabric', internalCounterpartyId: 'CP-INTERNAL' };
export const baseOrders = () => [{ ...GARMENT_ORDER }, { ...FABRIC_ORDER }];
export const baseLines = () => [
  { id: 'GL1', orderId: 'G1', materialCode: 'M100', unit: 'M', quantity: 1000, shipmentQuantity: null, shippingDate: null, status: 'Pending', internalTransferPrice: null },
  { id: 'FL1', orderId: 'F1', materialCode: 'M100', unit: 'M', quantity: 1000, shipmentQuantity: null, shippingDate: null, status: 'Pending', internalTransferPrice: null },
];
export const VALID_INPUT = { requestDepartmentId: 'dept_garment', supplyDepartmentId: 'dept_fabric', garmentOrderId: 'G1', fabricOrderId: 'F1', materialCode: 'M100', quantity: 1000, unit: 'm', settlementPrice: 30, dueDate: '2026-09-01', requesterId: 'u_sales' };
export const TRUSTED_ACTOR: TokenPayload = { userId: 'u_sales', roles: ['finance'] };

export function matches(row: any, where: any = {}): boolean {
  return Object.entries(where).every(([key, wanted]: any) => {
    if (key === 'AND') return (Array.isArray(wanted) ? wanted : [wanted]).every((clause: any) => matches(row, clause));
    if (key === 'OR') return wanted.some((clause: any) => matches(row, clause));
    if (key === 'NOT') return !matches(row, wanted);
    const value = row[key];
    if (wanted && typeof wanted === 'object' && !(wanted instanceof Date)) {
      if ('path' in wanted) return internalTransferFingerprint(wanted.path.reduce((item: any, part: string) => item?.[part], value)) === internalTransferFingerprint(wanted.equals);
      if ('equals' in wanted) return internalTransferFingerprint(value) === internalTransferFingerprint(wanted.equals);
      if ('in' in wanted) return wanted.in.includes(value);
      if ('not' in wanted) return value !== wanted.not;
      return matches(value ?? {}, wanted);
    }
    return internalTransferFingerprint(value) === internalTransferFingerprint(wanted);
  });
}

export function makePrisma(opts: { orders?: any[]; orderLines?: any[]; shipments?: any[]; approvals?: any[]; transfers?: any[] } = {}) {
  // No approved flags are accepted as facts. Callers use decideApproval below.
  const orders = opts.orders ?? baseOrders(), orderLines = opts.orderLines ?? baseLines(), transfers = opts.transfers ?? [], shipments = opts.shipments ?? [], approvals: any[] = [], auditLogs: any[] = [];
  const users = ['u_sales','u_fabric','u_mgr','u_owner'].map(id => ({ id, displayName: id, status: 'active', deletedAt: null, primaryDeptId: 'dept_1', roles: [{ departmentId: 'dept_1', role: { id: id === 'u_mgr' ? 'role-sales-manager' : id === 'u_owner' ? 'role-super-admin' : 'role-finance', permissions: ['order:internal_trade:write','orders:read'].map(scope => ({ permission: { scope } })) } }] }));
  const calls = { transferCreate: [] as any[], transferUpdate: [] as any[], orderLineUpdate: [] as any[], approvalUpdateMany: [] as any[] };
  const update = (rows: any[], where: any, data: any) => { const row = rows.find(item => matches(item, where)); if (!row) throw Error('mock storage row not found'); Object.assign(row, data); return row; };
  const updateMany = (rows: any[], where: any, data: any) => { const selected = rows.filter(item => matches(item, where)); for (const row of selected) Object.assign(row, data); return { count: selected.length }; };
  const allocation = (shipment: any) => ({ id: `${shipment.id}-allocation`, shipmentId: shipment.id, orderId: shipment.orderId, orderLineId: shipment.orderId === 'F1' ? 'FL1' : 'GL1', unit: 'M', plannedQty: 1000, actualQty: 1000, status: 'Fulfilled' });
  const prisma: any = {
    order: { findUnique: vi.fn(async ({ where }: any) => orders.find(row => matches(row, where)) ?? null), findFirst: vi.fn(async ({ where }: any) => orders.find(row => matches(row, where)) ?? null), findMany: vi.fn(async ({ where }: any = {}) => orders.filter(row => matches(row, where))) },
    userAccount: { findFirst: vi.fn(async ({ where }: any) => users.find(row => matches(row, where)) ?? null), findUnique: vi.fn(async ({ where }: any) => users.find(row => matches(row, where)) ?? null) },
    userPermissionOverrides: { findMany: vi.fn(async () => []) },
    userRole: { findMany: vi.fn(async ({ where }: any = {}) => users.flatMap(user => user.roles.map(role => ({ userId: user.id, roleId: role.role.id, departmentId: role.departmentId, user }))).filter(row => matches(row, where))) },
    department: { findUnique: vi.fn(async () => ({ id: 'dept_1', status: 'active', headId: 'u_mgr', parentId: null })), findMany: vi.fn(async ({ where }: any = {}) => [{ id: 'dept_1', status: 'active', headId: 'u_mgr', parentId: null }].filter(row => matches(row, where))) },
    orderInternalTransfer: {
      create: vi.fn(async ({ data }: any) => { if (transfers.some(row => row.orderId === data.orderId && row.transferDirection === data.transferDirection && !row.deletedAt)) throw Object.assign(Error('unique mock transfer'), { code: 'P2002' }); const row = { ...data, createdAt: new Date(), updatedAt: new Date(), deletedAt: null, recognizedBy: data.recognizedBy ?? null, recognizedAt: data.recognizedAt ?? null }; transfers.push(row); calls.transferCreate.push(data); return row; }),
      findUnique: vi.fn(async ({ where }: any) => transfers.find(row => matches(row, where)) ?? null),
      findFirst: vi.fn(async ({ where }: any) => transfers.find(row => matches(row, where)) ?? null),
      findMany: vi.fn(async ({ where, orderBy }: any = {}) => { const result = transfers.filter(row => matches(row, where)); return orderBy?.createdAt === 'desc' ? [...result].reverse() : result; }),
      update: vi.fn(async ({ where, data }: any) => { const row = update(transfers, where, data); calls.transferUpdate.push({ where, data }); return row; }),
      updateMany: vi.fn(async ({ where, data }: any) => { const result = updateMany(transfers, where, data); calls.transferUpdate.push({ where, data }); return result; }),
    },
    orderLine: { findMany: vi.fn(async ({ where }: any) => orderLines.filter(row => matches(row, where))), findUnique: vi.fn(async ({ where }: any) => orderLines.find(row => matches(row, where)) ?? null), update: vi.fn(async ({ where, data }: any) => { calls.orderLineUpdate.push({ where, data }); return update(orderLines, where, data); }) },
    shipment: { findUnique: vi.fn(async ({ where }: any) => shipments.find(row => matches(row, where)) ?? null) },
    shipmentOrderAllocation: { findMany: vi.fn(async ({ where }: any) => shipments.map(allocation).filter(row => matches(row, where))), findUnique: vi.fn(async ({ where }: any) => shipments.map(allocation).find(row => matches(row, where)) ?? null) },
    approvalRequest: {
      findFirst: vi.fn(async ({ where }: any) => approvals.find(row => matches(row, where)) ?? null), findUnique: vi.fn(async ({ where }: any) => approvals.find(row => matches(row, where)) ?? null), findUniqueOrThrow: vi.fn(async ({ where }: any) => { const row = approvals.find(item => matches(item, where)); if (!row) throw Error('mock approval not found'); return row; }),
      create: vi.fn(async ({ data }: any) => { const row = { ...data, id: `ar_${approvals.length + 1}`, createdAt: new Date(), decidedAt: null, decisionNote: null, bossFinalBypassBy: null, bossFinalBypassAt: null, bossFinalBypassReason: null }; approvals.push(row); return row; }),
      updateMany: vi.fn(async ({ where, data }: any) => { calls.approvalUpdateMany.push({ where, data }); return updateMany(approvals, where, data); }),
    },
    auditLog: { create: vi.fn(async ({ data }: any) => { auditLogs.push(data); return data; }), findUnique: vi.fn(async ({ where }: any) => auditLogs.find(row => matches(row, where)) ?? null), findMany: vi.fn(async ({ where }: any) => auditLogs.filter(row => matches(row, where))) },
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (work: any) => { const stores = [orders, orderLines, transfers, approvals, auditLogs], snapshots = stores.map(rows => structuredClone(rows)); try { return await work(prisma); } catch (error) { stores.forEach((rows, i) => rows.splice(0, rows.length, ...snapshots[i])); throw error; } }),
  };
  return { prisma, calls, orders, transfers, orderLines, shipments, approvals, auditLogs, users };
}
export function makeService(prisma: any, approvalOverride?: any) {
  const actual = createApprovalCreateService({ prisma, routingService: createApprovalRoutingService({ prisma }) });
  const createBusinessApproval = approvalOverride ?? vi.fn(actual.createBusinessApproval);
  return { service: createInternalTransferService({ prisma, approvalCreateService: { createBusinessApproval } as any }), createBusinessApproval };
}
export async function decideApproval(prisma: any, approvalId: string, decision: 'approved' | 'rejected' = 'approved', mode: 'normal' | 'boss' = 'normal', actorId = mode === 'boss' ? 'u_owner' : 'u_mgr') {
  const approval = await prisma.approvalRequest.findUnique({ where: { id: approvalId } });
  if (!approval) throw Error('mock approval not found');
  return createApprovalDecisionService(prisma).decide({ id: approvalId, actor: { userId: actorId, roles: [mode === 'boss' ? 'owner' : 'manager'] }, decision, mode, source: 'api:approvals',
    reviewContentVersion: approvalReviewContentVersion(approval), confirmedReviewedContent: true,
    ...(mode === 'boss' ? { bossReason: 'This synthetic explicit owner final bypass reason exceeds thirty characters.' } : {}) });
}
export async function seedPendingTransfer(opts: { approvals?: any[] } = {}) {
  const ctx = makePrisma(), { service, createBusinessApproval } = makeService(ctx.prisma);
  const created = await service.createInternalTransfer(VALID_INPUT);
  if (!created.ok) throw Error(`mock native create failed: ${created.error.code}`);
  const requested = opts.approvals?.[0]?.status;
  if (requested === 'approved' || requested === 'rejected') await decideApproval(ctx.prisma, created.data.approvalRequestId, requested);
  return { ...ctx, service, createBusinessApproval, created: created.data };
}
export async function seedEffectiveTransfer() {
  const ctx = await seedPendingTransfer({ approvals: [{ status: 'approved' }] });
  const confirmed = await ctx.service.confirmInternalTransfer({ id: ctx.created.transfer.id, actorId: 'u_fabric' });
  if (!confirmed.ok) throw Error(`mock native confirm failed: ${confirmed.error.code}`);
  return { ...ctx, confirmed: confirmed.data };
}
