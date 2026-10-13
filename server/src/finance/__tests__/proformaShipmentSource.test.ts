import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../../auth/service';

// Explicit storage only: the real PI, source locks, live authorization,
// allocation producer and mandatory audit run here. This fixture models atomic
// rollback, not PostgreSQL lock scheduling; native PG qualifies contention.
vi.mock('../../sequence/sequenceService', () => ({ createSequenceService: () => ({
  nextNumber: async (tx: any) => tx.testNextInvoiceNumber(),
}) }));
vi.mock('../../credit/creditService', () => ({ notifyCustomerCreditRecalc: vi.fn(async () => undefined) }));
vi.mock('../shipmentBatchSettlementHook', () => ({ notifyShipmentBatchSettlementRecalc: vi.fn(async () => undefined) }));
vi.mock('../../events/businessEventBus', () => ({ publishBusinessEvent: vi.fn(async () => undefined) }));
vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { createProformaInvoiceService } from '../proformaInvoiceService';
import { publishBusinessEvent } from '../../events/businessEventBus';
import { notifyShipmentBatchSettlementRecalc } from '../shipmentBatchSettlementHook';

const at = BigInt('1790937600000');
const decimal = (value: string) => new Prisma.Decimal(value);
const credential: TokenPayload = { userId: 'finance-user', roles: ['admin'], permissions: ['invoices:write', 'orders:read'],
  departmentIds: [], authorizationLoaded: true, permissionCeiling: ['invoices:write', 'orders:read'] };
function clone<T>(value: T): T {
  if (Prisma.Decimal.isDecimal(value)) return decimal((value as any).toString()) as T;
  if (Array.isArray(value)) return value.map(clone) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) as T;
  return value;
}
function matches(row: any, where: any): boolean {
  return !where || Object.entries(where).every(([key, expected]: [string, any]) => {
    if (key === 'AND') return (Array.isArray(expected) ? expected : [expected]).every(item => matches(row, item));
    if (key === 'OR') return expected.some((item: any) => matches(row, item));
    if (expected && typeof expected === 'object' && 'in' in expected) return expected.in.includes(row[key]);
    return expected === null ? row[key] == null : row[key] === expected;
  });
}
function select(rows: any[], query: any): any[] {
  const result = rows.filter(row => matches(row, query?.where));
  if (query?.orderBy?.id) result.sort((a, b) => a.id.localeCompare(b.id));
  return clone(result.map(row => query?.select ? Object.fromEntries(Object.keys(query.select).filter(key => query.select[key]).map(key => [key, row[key]])) : row));
}
function fixture(options: { batchStatus?: string; shipmentStatus?: string; batchId?: string | null; shipmentId?: string | null;
  physicalBatch?: boolean; auditFail?: boolean; allocationFail?: boolean; atLock?: (table: string, state: any) => void } = {}) {
  const shipmentId = options.shipmentId === undefined ? 'shipment-original' : options.shipmentId;
  let state: any = {
    account: { id: 'finance-user', status: 'active', deletedAt: null, primaryDeptId: null,
      roles: [{ roleId: 'role-admin', departmentId: null, role: { id: 'role-admin', permissions:
        ['invoices:write', 'orders:read'].map(scope => ({ permission: { scope } })) } }] },
    invoices: [{ id: 'pi-original', invoiceNumber: 'PI-ORIGINAL', type: 'Proforma', status: 'Draft', amount: decimal('40.0001'),
      currency: 'USD', issueDate: '2026-10-02', dueDate: null, exchangeRate: decimal('7.0001'), baseCurrency: 'CNY',
      orderId: 'order-one', customerRelationId: 'customer-one', customerName: 'Customer One', notes: 'original PI notes',
      attachments: {}, ownerId: 'finance-user', departmentId: null, createdAt: at, updatedAt: at, deletedAt: null }],
    allocations: [{ id: 'ioa-original', invoiceId: 'pi-original', orderId: 'order-one', orderNumber: 'SO-ORIGINAL', poNumber: 'PO-ORIGINAL',
      allocatedAmount: decimal('40.0001'), batchId: options.batchId === undefined ? 'osb-original' : options.batchId,
      note: ' original allocation note ', createdAt: at, updatedAt: at, deletedAt: null }],
    orders: [{ id: 'order-one', code: 'SO-ORIGINAL', poNumber: 'PO-ORIGINAL', customerRelationId: 'customer-one',
      customer: 'Customer One', ownerId: 'finance-user', paymentInstrument: 'TT', deletedAt: null }],
    batches: [{ id: 'osb-original', orderId: 'order-one', shipmentId, status: options.batchStatus ?? 'shipped', currency: 'USD',
      customerRelationId: 'customer-one', amount: decimal('40.0001'), createdAt: at, updatedAt: at, deletedAt: null }],
    shipments: shipmentId ? [{ id: shipmentId, orderId: 'order-one', status: options.shipmentStatus ?? 'Shipped', deletedAt: null }] : [],
    shipmentAllocations: shipmentId ? [{ id: 'soa-original', shipmentId, orderId: 'order-one', orderLineId: null,
      plannedQty: decimal('10'), actualQty: decimal('10'), unit: 'M', status: 'Shipped' }] : [],
    productionBatches: options.physicalBatch ? [{ id: 'production-original', orderId: 'order-one', orderLineId: 'line-original' }] : [],
    invisibleOrders: [], audits: [{ id: 'audit-original', detail: { original: true } }], sequence: 0,
  };
  const trace: string[] = [];
  const tx: any = {
    userAccount: { findUnique: vi.fn(async () => clone(state.account)), findFirst: vi.fn(async () => clone(state.account)) },
    userPermissionOverrides: { findMany: vi.fn(async () => []) },
    order: { findFirst: vi.fn(async (query: any) => state.invisibleOrders.includes(query.where.id) ? null : select(state.orders, query)[0] ?? null),
      findMany: vi.fn(async (query: any) => select(state.orders, query)), findUnique: vi.fn(async (query: any) => select(state.orders, query)[0] ?? null) },
    orderLine: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) },
    releaseScope: { findMany: vi.fn(async () => []) },
    sample: { findMany: vi.fn(async () => []) },
    productionBatch: { findMany: vi.fn(async (query: any) => select(state.productionBatches, query)) },
    claimDisposition: { findMany: vi.fn(async () => []) }, repairWorkOrder: { findMany: vi.fn(async () => []) },
    shipmentOrderAllocation: { findMany: vi.fn(async (query: any) => select(state.shipmentAllocations, query)) },
    shipmentProductionAllocation: { findMany: vi.fn(async () => []) },
    shipment: { findMany: vi.fn(async (query: any) => select(state.shipments, query)), findUnique: vi.fn(async (query: any) => select(state.shipments, query)[0] ?? null) },
    orderShipmentBatch: { findMany: vi.fn(async (query: any) => select(state.batches, query)) },
    invoice: {
      findFirst: vi.fn(async (query: any) => select(state.invoices, query)[0] ?? null),
      create: vi.fn(async ({ data }: any) => { trace.push('write:Invoice'); const row = { deletedAt: null, ...clone(data) }; state.invoices.push(row); return clone(row); }),
      update: vi.fn(async ({ where, data }: any) => { trace.push('write:PI'); const row = state.invoices.find((item: any) => item.id === where.id);
        if (!row) throw Error('missing invoice'); Object.assign(row, clone(data)); return clone(row); }),
    },
    invoiceOrderAllocation: {
      findMany: vi.fn(async (query: any) => select(state.allocations, query)),
      create: vi.fn(async ({ data }: any) => {
        trace.push('write:IOA'); if (options.allocationFail) throw Error('allocation storage rejected');
        if (state.allocations.some((row: any) => row.invoiceId === data.invoiceId && row.orderId === data.orderId)) throw Object.assign(Error('unique IOA pair'), { code: 'P2002' });
        const row = { deletedAt: null, ...clone(data) }; state.allocations.push(row); return clone(row);
      }),
    },
    auditLog: { create: vi.fn(async ({ data }: any) => {
      trace.push('write:Audit'); if (options.auditFail) throw Error('SQL audit storage secret');
      JSON.stringify(data.detail); state.audits.push(clone(data)); return clone(data);
    }) },
    $queryRaw: vi.fn(async (sql: any) => {
      const table = String(sql.sql).match(/FROM "([^"]+)"/)?.[1];
      if (!table) throw Error('unexpected raw query');
      trace.push(`lock:${table}`); options.atLock?.(table, state);
      return sql.values.map((id: any) => ({ id }));
    }),
    testNextInvoiceNumber: vi.fn(async () => { trace.push('sequence'); state.sequence += 1; return `INV-NATIVE-${state.sequence}`; }),
  };
  const prisma: any = { ...tx, $transaction: vi.fn(async (work: any) => {
    const before = clone(state);
    try { return await work(tx); } catch (error) { state = before; throw error; }
  }) };
  const convert = (actor: TokenPayload = credential, input: any = {}) => createProformaInvoiceService(prisma)
    .convertToReceivable('pi-original', input, 'finance-user', '127.0.0.1', actor);
  return { tx, prisma, trace, convert, state: () => state, snapshot: () => clone(state) };
}
function expectNoWrites(f: ReturnType<typeof fixture>) {
  expect(f.tx.testNextInvoiceNumber).not.toHaveBeenCalled(); expect(f.tx.invoice.create).not.toHaveBeenCalled();
  expect(f.tx.invoice.update).not.toHaveBeenCalled(); expect(f.tx.invoiceOrderAllocation.create).not.toHaveBeenCalled();
  expect(f.tx.auditLog.create).not.toHaveBeenCalled(); expect(publishBusinessEvent).not.toHaveBeenCalled();
  expect(notifyShipmentBatchSettlementRecalc).not.toHaveBeenCalled();
}
beforeEach(() => vi.clearAllMocks());

describe('PI conversion consumes the actual locked financial shipment source', () => {
  it('cancelled actual Shipment with historical shipped OSB rejects 409 before locking PI or writing anything', async () => {
    const f = fixture({ shipmentStatus: 'Cancelled', physicalBatch: true }), before = f.snapshot();
    const result = await f.convert();
    expect(result).toMatchObject({ ok: false, error: { code: 'CONFLICT', statusCode: 409 } });
    expect(f.state()).toEqual(before); expectNoWrites(f);
    expect(f.trace).toContain('lock:Shipment'); expect(f.trace).not.toContain('lock:Invoice');
    expect(f.trace.indexOf('lock:ProductionBatch')).toBeLessThan(f.trace.indexOf('lock:Shipment'));
    expect(f.trace.indexOf('lock:Shipment')).toBeLessThan(f.trace.indexOf('lock:OrderShipmentBatch'));
  });
  it.each([['Cancelled', 'Proforma', 'ALREADY_CONVERTED'], ['Draft', 'Receivable', 'NOT_PROFORMA']])(
    'a stable non-convertible invoice status=%s type=%s keeps its original domain refusal', async (status, type, code) => {
      const f = fixture({ shipmentStatus: 'Cancelled' }); Object.assign(f.state().invoices[0], { status, type });
      expect(await f.convert()).toMatchObject({ ok: false, error: { code } }); expectNoWrites(f);
      expect(f.trace).not.toContain('lock:Shipment');
    });
  it.each([['Cancelled', 'Proforma'], ['Draft', 'Receivable']])(
    'an initially non-convertible status=%s type=%s cannot become eligible under PI lock without source locks', async (status, type) => {
      const f = fixture({ atLock: (table, state) => { if (table === 'Invoice') Object.assign(state.invoices[0], { status: 'Draft', type: 'Proforma' }); } });
      Object.assign(f.state().invoices[0], { status, type });
      expect(await f.convert()).toMatchObject({ ok: false, error: { code: 'CONFLICT', statusCode: 409 } }); expectNoWrites(f);
      expect(f.trace).not.toContain('lock:Shipment');
    });
  it('cancellation observed while acquiring the actual Shipment lock rejects the stale PI source hint', async () => {
    const f = fixture({ atLock: (table, state) => { if (table === 'Shipment') state.shipments[0].status = 'Cancelled'; } });
    expect(await f.convert()).toMatchObject({ ok: false, error: { code: 'CONFLICT', statusCode: 409 } });
    expectNoWrites(f); expect(f.trace).not.toContain('lock:Invoice');
  });
  it('a legitimate legacy dispatch converts with source locks before OSB and original PI/IOA locks', async () => {
    const f = fixture(), original = f.snapshot();
    const result = await f.convert(); expect(result.ok).toBe(true);
    const locks = ['Order', 'Shipment', 'OrderShipmentBatch', 'Invoice', 'InvoiceOrderAllocation'].map(table => f.trace.indexOf(`lock:${table}`));
    expect(locks.every(index => index >= 0)).toBe(true); expect([...locks].sort((a, b) => a - b)).toEqual(locks);
    expect(f.trace.indexOf('sequence')).toBeGreaterThan(locks[4]);
    expect(f.state().allocations[0]).toEqual(original.allocations[0]);
    const receivable = f.state().invoices.find((row: any) => row.type === 'Receivable');
    expect(receivable).toMatchObject({ status: 'Issued', customerRelationId: 'customer-one', currency: 'USD' });
    expect(receivable.amount.toString()).toBe('40.0001'); expect(receivable.exchangeRate.toString()).toBe('7.0001');
    expect(f.state().allocations.find((row: any) => row.invoiceId === receivable.id)).toMatchObject({ orderId: 'order-one', batchId: 'osb-original', note: ' original allocation note ' });
    expect(f.state().audits[1].detail.after.orderAllocations[0]).toMatchObject({ sourceAllocationId: 'ioa-original', allocatedAmount: '40.0001' });
    expect(f.state().invoices[0].status).toBe('Cancelled'); expect(publishBusinessEvent).toHaveBeenCalledTimes(1);
  });
  it('planned pre-invoicing with a real planned Shipment locks the physical batch and needs only Finance and Order read authority', async () => {
    const f = fixture({ batchStatus: 'planned', shipmentStatus: 'Planned', physicalBatch: true });
    expect((await f.convert()).ok).toBe(true);
    expect(f.trace.indexOf('lock:ProductionBatch')).toBeLessThan(f.trace.indexOf('lock:Shipment'));
    expect(f.trace.indexOf('lock:Shipment')).toBeLessThan(f.trace.indexOf('lock:OrderShipmentBatch'));
    expect(credential.permissions).not.toContain('shipments:write');
  });
  it('planned pre-invoicing without a Shipment remains legal', async () => {
    const f = fixture({ batchStatus: 'planned', shipmentId: null });
    expect((await f.convert()).ok).toBe(true); expect(f.trace).not.toContain('lock:Shipment');
    expect(f.state().allocations[1].batchId).toBe('osb-original');
  });
  it('a real legacy null-batch allocation remains null and never borrows another OSB', async () => {
    const f = fixture({ batchId: null }); expect((await f.convert()).ok).toBe(true);
    expect(f.state().allocations[1].batchId).toBeNull(); expect(f.trace).not.toContain('lock:Shipment');
    expect(f.trace).not.toContain('lock:OrderShipmentBatch');
  });
  it('OSB changes to a different Shipment during source locking are rejected before a PI lock', async () => {
    const f = fixture({ atLock: (table, state) => { if (table === 'OrderShipmentBatch') state.batches[0].shipmentId = 'different-source'; } });
    expect(await f.convert()).toMatchObject({ ok: false, error: { code: 'CONFLICT', statusCode: 409 } });
    expectNoWrites(f); expect(f.trace).not.toContain('lock:Invoice');
  });
  it('a new active shipping sample appearing during the source lock cannot be consumed from stale hints', async () => {
    const f = fixture(); f.tx.sample.findMany.mockResolvedValueOnce([]).mockResolvedValue([{ id: 'shipping-sample-added' }]);
    expect(await f.convert()).toMatchObject({ ok: false, error: { code: 'CONFLICT', statusCode: 409 } });
    expectNoWrites(f); expect(f.trace).not.toContain('lock:Invoice');
  });
  it('an actual order-line source set changed under release locks retains the native 409 refusal', async () => {
    const f = fixture(); f.tx.orderLine.findMany.mockResolvedValueOnce([]).mockResolvedValue([{ id: 'line-added', orderId: 'order-one' }]);
    expect(await f.convert()).toMatchObject({ ok: false, error: { code: 'CONFLICT', statusCode: 409 } });
    expectNoWrites(f); expect(f.trace).not.toContain('lock:Invoice');
  });
  it('actual IOA membership changes while acquiring the PI lock are rejected rather than consuming an unlocked batch', async () => {
    const f = fixture({ atLock: (table, state) => { if (table === 'Invoice') state.allocations[0].batchId = null; } });
    expect(await f.convert()).toMatchObject({ ok: false, error: { code: 'CONFLICT', statusCode: 409 } }); expectNoWrites(f);
  });
  it('a shipped OSB cannot borrow a merely planned actual Shipment as completed dispatch', async () => {
    const f = fixture({ shipmentStatus: 'Planned' });
    expect(await f.convert()).toMatchObject({ ok: false, error: { code: 'CONFLICT', statusCode: 409 } }); expectNoWrites(f);
  });
  it('a shipped OSB needs a real positive actual quantity on its matching original order', async () => {
    const f = fixture(); f.state().shipmentAllocations[0].actualQty = null;
    expect(await f.convert()).toMatchObject({ ok: false, error: { code: 'CONFLICT', statusCode: 409 } }); expectNoWrites(f);
  });
});

describe('source-lock authority is current and retains the signed ceiling', () => {
  it('revoked Invoice write while waiting on Shipment locks cannot use the earlier grant snapshot', async () => {
    const f = fixture({ atLock: (table, state) => { if (table === 'Shipment') state.account.roles[0].role.permissions = [{ permission: { scope: 'orders:read' } }]; } });
    expect(await f.convert()).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', statusCode: 403 } }); expectNoWrites(f);
  });
  it('an account disabled at the Shipment lock is rejected using the PI account contract', async () => {
    const f = fixture({ atLock: (table, state) => { if (table === 'Shipment') state.account.status = 'disabled'; } });
    expect(await f.convert()).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED', statusCode: 401 } }); expectNoWrites(f);
  });
  it('a signed ceiling excluding Order read is retained even when stored Admin grants include it', async () => {
    const f = fixture();
    expect(await f.convert({ ...credential, permissionCeiling: ['invoices:write'] })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', statusCode: 403 } }); expectNoWrites(f);
  });
  it('an explicitly empty signed ceiling stays empty', async () => {
    const f = fixture();
    expect(await f.convert({ ...credential, permissionCeiling: [] })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', statusCode: 403 } }); expectNoWrites(f);
  });
  it('actual parent L2 visibility lost at a Shipment lock rejects the original source', async () => {
    const f = fixture({ atLock: (table, state) => { if (table === 'Shipment') state.invisibleOrders.push('order-one'); } });
    expect(await f.convert()).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', statusCode: 404 } }); expectNoWrites(f);
  });
});

describe('all PI, IOA, sequence and mandatory-audit writes share one transaction', () => {
  it.each([{ auditFail: true }, { allocationFail: true }])('a real storage write refusal rolls back exact original state: %j', async options => {
    const f = fixture(options), before = f.snapshot();
    const result = await f.convert(); expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(result.error?.message).not.toMatch(/SQL|secret|rejected/); expect(f.state()).toEqual(before);
    expect(f.tx.invoice.create).toHaveBeenCalledTimes(1); expect(f.tx.testNextInvoiceNumber).toHaveBeenCalledTimes(1);
    expect(publishBusinessEvent).not.toHaveBeenCalled(); expect(notifyShipmentBatchSettlementRecalc).not.toHaveBeenCalled();
  });
  it('a driver code without the deliberate business HTTP status remains a safe dependency failure', async () => {
    const f = fixture(); f.tx.shipmentProductionAllocation.findMany.mockRejectedValue(Object.assign(Error('SQL source secret'), { code: 'CONFLICT' }));
    const result = await f.convert();
    expect(result).toMatchObject({ ok: false, error: { code: 'DEPENDENCY_CHECK_FAILED', statusCode: 503 } });
    expect(result.error?.message).not.toMatch(/SQL|secret/); expectNoWrites(f);
  });
  it('a missing source-storage delegate is a dependency failure, never an implicit legacy source bypass', async () => {
    const f = fixture(); delete f.tx.shipmentProductionAllocation; delete f.prisma.shipmentProductionAllocation;
    expect(await f.convert()).toMatchObject({ ok: false, error: { code: 'DEPENDENCY_CHECK_FAILED', statusCode: 503 } }); expectNoWrites(f);
  });
});
