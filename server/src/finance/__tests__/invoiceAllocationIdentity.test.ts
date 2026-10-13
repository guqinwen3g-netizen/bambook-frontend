import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

// The only stateful storage below is the explicit in-memory transaction. It
// enforces the schema's unique invoice/order pair even for soft-deleted rows.
vi.mock('../../entities/sync', () => ({ syncInvoiceReferences: vi.fn(async () => undefined) }));
vi.mock('../../credit/creditService', () => ({ notifyCustomerCreditRecalc: vi.fn(async () => undefined) }));
vi.mock('../shipmentBatchSettlementHook', () => ({ notifyShipmentBatchSettlementRecalc: vi.fn(async () => undefined) }));
vi.mock('../../events/businessEventBus', () => ({ publishBusinessEvent: vi.fn(async () => undefined) }));
vi.mock('../../lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { createInvoice, updateInvoice } from '../invoiceMutationService';

const decimal = (value: string) => new Prisma.Decimal(value);
const timestamp = BigInt('1790937600000');

function clone<T>(value: T): T {
  if (Prisma.Decimal.isDecimal(value)) return new Prisma.Decimal((value as any).toString()) as T;
  if (Array.isArray(value)) return value.map(clone) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) as T;
  return value;
}

function allocation(orderId: string, extra: Record<string, any> = {}) {
  return {
    id: `original-${orderId}`, invoiceId: 'invoice-original', orderId,
    orderNumber: `OLD-${orderId}`, poNumber: `OLD-PO-${orderId}`,
    allocatedAmount: decimal('40.0001'), batchId: `batch-${orderId}`, note: 'original note',
    createdAt: timestamp, updatedAt: timestamp, deletedAt: null, ...extra,
  };
}

function fixture(options: { allocations?: any[]; auditFail?: boolean; writeFailOrderId?: string } = {}) {
  let state: any = {
    invoice: { id: 'invoice-original', invoiceNumber: 'INV-ORIGINAL', type: 'Receivable', status: 'Draft',
      amount: decimal('100'), currency: 'USD', customerRelationId: 'customer-one', customerName: 'Customer One',
      orderId: 'order-one', issueDate: '2026-10-02', notes: 'old invoice note', createdAt: timestamp, updatedAt: timestamp, deletedAt: null },
    allocations: clone(options.allocations ?? [allocation('order-one')]),
    orders: ['order-one', 'order-two', 'order-three'].map(id => ({ id, code: `SO-${id}`, poNumber: `PO-${id}`,
      customerRelationId: 'customer-one', customer: 'Customer One', deletedAt: null })),
    batches: ['order-one', 'order-two', 'order-three'].map(orderId => ({ id: `batch-${orderId}`, orderId, status: 'planned', deletedAt: null })),
    audits: [],
  };
  const trace: string[] = [];
  const matches = (row: any, where: any): boolean => {
    if (!where) return true;
    return Object.entries(where).every(([key, expected]: [string, any]) => {
      if (expected && typeof expected === 'object' && 'in' in expected) return expected.in.includes(row[key]);
      if (expected && typeof expected === 'object' && 'notIn' in expected) return !expected.notIn.includes(row[key]);
      return expected === null ? row[key] == null : row[key] === expected;
    });
  };
  const selectRows = (rows: any[], query: any) => {
    let result = rows.filter(row => matches(row, query?.where));
    if (query?.orderBy?.id) result = [...result].sort((a, b) => a.id.localeCompare(b.id));
    return clone(result.map(row => query?.select ? Object.fromEntries(Object.keys(query.select).filter(key => query.select[key]).map(key => [key, row[key]])) : row));
  };
  const writeAllocation = (row: any, data: any) => {
    if (options.writeFailOrderId === (data.orderId ?? row?.orderId)) throw new Error('storage allocation write rejected');
    const next = { deletedAt: null, ...row, ...clone(data) };
    if (state.allocations.some((other: any) => other.id !== next.id && other.invoiceId === next.invoiceId && other.orderId === next.orderId)) {
      throw Object.assign(new Error('Unique constraint failed on invoiceId/orderId including deleted rows'), { code: 'P2002' });
    }
    return next;
  };
  const tx: any = {
    $queryRawUnsafe: vi.fn(async (sql: string) => { trace.push(sql.includes('MaterialReturn') ? 'source-read' : 'invoice-lock'); return []; }),
    invoice: {
      findUnique: vi.fn(async ({ where }: any) => where.id === state.invoice.id ? clone(state.invoice) : null),
      update: vi.fn(async ({ where, data }: any) => { if (where.id !== state.invoice.id) throw new Error('invoice missing');
        state.invoice = { ...state.invoice, ...clone(data) }; return clone(state.invoice); }),
      create: vi.fn(async ({ data }: any) => { state.invoice = { ...clone(data), deletedAt: null }; return clone(state.invoice); }),
    },
    invoiceOrderAllocation: {
      findMany: vi.fn(async (query: any) => { trace.push('allocation-read'); return selectRows(state.allocations, query); }),
      create: vi.fn(async ({ data }: any) => { const next = writeAllocation(undefined, data); state.allocations.push(next); return clone(next); }),
      update: vi.fn(async ({ where, data }: any) => {
        const index = state.allocations.findIndex((row: any) => row.id === where.id);
        if (index < 0) throw new Error('allocation missing');
        state.allocations[index] = writeAllocation(state.allocations[index], data); return clone(state.allocations[index]);
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        state.allocations = state.allocations.map((row: any) => { if (!matches(row, where)) return row;
          count += 1; return writeAllocation(row, data); });
        return { count };
      }),
      delete: vi.fn(() => { throw new Error('hard delete is forbidden'); }),
      deleteMany: vi.fn(() => { throw new Error('hard delete is forbidden'); }),
    },
    order: {
      findMany: vi.fn(async (query: any) => selectRows(state.orders, query)),
      findUnique: vi.fn(async ({ where }: any) => clone(state.orders.find((row: any) => row.id === where.id) ?? null)),
    },
    orderShipmentBatch: { findMany: vi.fn(async (query: any) => selectRows(state.batches, query)) },
    invoiceAllocation: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0), findFirst: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async ({ data }: any) => {
      if (options.auditFail) throw new Error('mandatory audit storage failure');
      JSON.stringify(data.detail); // Audit JSON cannot silently contain BigInt or a raw Decimal object.
      state.audits.push(clone(data)); return clone(data);
    }) },
  };
  const prisma: any = {
    ...tx,
    $transaction: vi.fn(async (work: any) => {
      const before = clone(state);
      try { return await work(tx); } catch (error) { state = before; throw error; }
    }),
  };
  const submit = (input: any) => updateInvoice({ prisma, invoiceId: 'invoice-original', input, actorId: 'actual-editor', ip: '127.0.0.1' });
  const stateSnapshot = () => clone(state);
  return { tx, prisma, submit, stateSnapshot, trace, state: () => state };
}

function expectedSnapshot(row: any) {
  return { id: row.id, invoiceId: row.invoiceId, orderId: row.orderId, orderNumber: row.orderNumber ?? null,
    poNumber: row.poNumber ?? null, allocatedAmount: row.allocatedAmount?.toString() ?? null,
    batchId: row.batchId ?? null, note: row.note ?? null, createdAt: row.createdAt.toString(),
    updatedAt: row.updatedAt.toString(), deletedAt: row.deletedAt?.toString() ?? null };
}

const ownBatch = (extra: any = {}) => ({ orderId: 'order-one', batchId: 'batch-order-one', allocatedAmount: '40.0001', note: 'original note', ...extra });

beforeEach(() => vi.clearAllMocks());

describe('invoice allocation identity across replacement and revival', () => {
  it('replaces an active pair without violating the schema uniqueness or changing its identity', async () => {
    const f = fixture();
    const original = f.stateSnapshot().allocations[0];
    const result = await f.submit({ orderAllocations: [ownBatch({ allocatedAmount: '55.0002', note: 'adjusted invoice scope' })] });
    expect(result.ok).toBe(true);
    expect(f.state().allocations).toHaveLength(1);
    expect(f.state().allocations[0]).toMatchObject({ id: original.id, invoiceId: original.invoiceId,
      orderId: original.orderId, createdAt: original.createdAt, batchId: 'batch-order-one', note: 'adjusted invoice scope', deletedAt: null });
    expect(f.state().allocations[0].allocatedAmount.toString()).toBe('55.0002');
    expect(f.tx.invoiceOrderAllocation.create).not.toHaveBeenCalled();
    expect(f.trace.indexOf('invoice-lock')).toBeLessThan(f.trace.indexOf('allocation-read'));
  });

  it('revives a historical pair with its original id and createdAt, and audits the exact former deletion', async () => {
    const f = fixture({ allocations: [allocation('order-one', { deletedAt: timestamp + BigInt(7), note: 'retired reason' })] });
    const before = f.stateSnapshot();
    expect((await f.submit({ orderAllocations: [ownBatch({ allocatedAmount: '37.1203', note: 'scope restored' })] })).ok).toBe(true);
    const after = f.state().allocations[0];
    expect(after.id).toBe(before.allocations[0].id);
    expect(after.createdAt).toBe(before.allocations[0].createdAt);
    expect(after.deletedAt).toBeNull();
    const detail = f.state().audits[0].detail;
    expect(detail.before.orderAllocations).toEqual([expectedSnapshot(before.allocations[0])]);
    expect(detail.after.orderAllocations).toEqual([expectedSnapshot(after)]);
    expect(f.state().audits[0]).toMatchObject({ actorId: 'actual-editor', action: 'update_invoice', targetType: 'Invoice', targetId: 'invoice-original' });
  });

  it('preserves retained and retired history while adding a genuinely new order pair', async () => {
    const f = fixture({ allocations: [allocation('order-one'), allocation('order-two'), allocation('historical-order', { deletedAt: timestamp })] });
    const before = f.stateSnapshot();
    expect((await f.submit({ orderAllocations: [ownBatch(), { orderId: 'order-three', allocatedAmount: '60.0001', note: 'added order' }] })).ok).toBe(true);
    expect(f.state().allocations).toHaveLength(4);
    expect(f.state().allocations.find((row: any) => row.orderId === 'order-one').id).toBe('original-order-one');
    const removed = f.state().allocations.find((row: any) => row.orderId === 'order-two');
    expect(removed.id).toBe('original-order-two');
    expect(removed.deletedAt).not.toBeNull();
    expect(removed.updatedAt).not.toBe(before.allocations[1].updatedAt);
    expect(f.state().allocations.find((row: any) => row.orderId === 'historical-order')).toEqual(before.allocations[2]);
    expect(f.tx.invoiceOrderAllocation.create).toHaveBeenCalledTimes(1);
    expect(f.tx.invoiceOrderAllocation.delete).not.toHaveBeenCalled();
    expect(f.tx.invoiceOrderAllocation.deleteMany).not.toHaveBeenCalled();
    expect(f.state().audits[0].detail.before.orderAllocations).toEqual(before.allocations.map(expectedSnapshot).sort((a: any, b: any) => a.id.localeCompare(b.id)));
    expect(f.state().audits[0].detail.after.orderAllocations).toEqual(f.state().allocations.map(expectedSnapshot).sort((a: any, b: any) => a.id.localeCompare(b.id)));
  });

  it.each(['orderIds', 'orderAllocations'])('an explicit empty %s soft-deletes the active set and keeps older tombstones', async field => {
    const f = fixture({ allocations: [allocation('order-one'), allocation('order-two', { deletedAt: timestamp })] });
    const before = f.stateSnapshot();
    expect((await f.submit({ [field]: [] })).ok).toBe(true);
    expect(f.state().allocations).toHaveLength(2);
    expect(f.state().allocations[0].deletedAt).not.toBeNull();
    expect(f.state().allocations[1]).toEqual(before.allocations[1]);
    expect(f.tx.invoiceOrderAllocation.create).not.toHaveBeenCalled();
    expect(f.state().audits[0].detail.before.orderAllocations).toHaveLength(2);
    expect(f.state().audits[0].detail.after.orderAllocations).toHaveLength(2);
  });

  it('repeat replacement and remove/re-add preserve one original pair, rather than accumulating new rows', async () => {
    const f = fixture();
    for (const input of [{ orderAllocations: [ownBatch()] }, { orderIds: [] }, { orderAllocations: [ownBatch()] }, { orderAllocations: [ownBatch()] }]) {
      expect((await f.submit(input)).ok).toBe(true);
    }
    expect(f.state().allocations).toHaveLength(1);
    expect(f.state().allocations[0].id).toBe('original-order-one');
    expect(f.state().allocations[0].deletedAt).toBeNull();
    expect(f.state().audits).toHaveLength(4);
    expect(f.tx.invoiceOrderAllocation.create).not.toHaveBeenCalled();
  });

  it('merges duplicate orderIds with explicit allocation fields without creating a second identity', async () => {
    const f = fixture();
    expect((await f.submit({ orderIds: ['order-one', 'order-one'], orderAllocations: [ownBatch({ allocatedAmount: '28.7654' })] })).ok).toBe(true);
    expect(f.state().allocations).toHaveLength(1);
    expect(f.state().allocations[0].allocatedAmount.toString()).toBe('28.7654');
    expect(f.state().allocations[0].batchId).toBe('batch-order-one');
  });

  it('changing the financial batch keeps the original pair and records the complete before/after source', async () => {
    const f = fixture();
    f.state().invoice.amount = decimal('99999999999999.9999');
    f.state().batches.push({ id: 'second-own-batch', orderId: 'order-one', deletedAt: null, status: 'planned' });
    const before = f.stateSnapshot().allocations[0];
    expect((await f.submit({ orderAllocations: [ownBatch({ batchId: 'second-own-batch', allocatedAmount: '99999999999999.9999', note: 'new planned tranche' })] })).ok).toBe(true);
    expect(f.state().allocations[0].id).toBe(before.id);
    expect(f.state().allocations[0].allocatedAmount.toString()).toBe('99999999999999.9999');
    expect(f.state().audits[0].detail.before.orderAllocations[0].batchId).toBe('batch-order-one');
    expect(f.state().audits[0].detail.after.orderAllocations[0]).toMatchObject({ batchId: 'second-own-batch', allocatedAmount: '99999999999999.9999', note: 'new planned tranche' });
  });
});

describe('existing invoice allocation semantics remain explicit', () => {
  it('a notes-only PATCH never reads or writes the existing IOA records', async () => {
    const f = fixture();
    const before = f.stateSnapshot().allocations;
    expect((await f.submit({ notes: 'only invoice notes' })).ok).toBe(true);
    expect(f.state().allocations).toEqual(before);
    expect(f.tx.invoiceOrderAllocation.findMany).not.toHaveBeenCalled();
    expect(f.tx.invoiceOrderAllocation.create).not.toHaveBeenCalled();
    expect(f.tx.invoiceOrderAllocation.update).not.toHaveBeenCalled();
    expect(f.tx.invoiceOrderAllocation.updateMany).not.toHaveBeenCalled();
    expect(f.state().audits[0].detail.before).not.toHaveProperty('orderAllocations');
    expect(f.state().audits[0].detail.after).not.toHaveProperty('orderAllocations');
  });

  it('legacy orderIds replacement explicitly returns to the null batch/whole-order amount contract', async () => {
    const f = fixture();
    expect((await f.submit({ orderIds: ['order-one'] })).ok).toBe(true);
    expect(f.state().allocations[0]).toMatchObject({ id: 'original-order-one', allocatedAmount: null, batchId: null, note: null, deletedAt: null });
  });

  it('pre-invoicing a valid planned batch remains permitted with an explicit amount', async () => {
    const f = fixture();
    expect((await f.submit({ orderAllocations: [ownBatch({ allocatedAmount: '25.0001' })] })).ok).toBe(true);
    expect(f.state().batches[0].status).toBe('planned');
    expect(f.state().allocations[0].allocatedAmount.toString()).toBe('25.0001');
  });

  it('create keeps its new-invoice/new-pair path and does not inspect unrelated historical IOA records', async () => {
    const f = fixture();
    const result = await createInvoice({ prisma: f.prisma, actorId: 'actual-editor', input: {
      id: 'genuinely-new-invoice', invoiceNumber: 'INV-NEW', type: 'Receivable', status: 'Draft', amount: '100',
      currency: 'USD', issueDate: '2026-10-02', customerRelationId: 'customer-one', customerName: 'Customer One', orderAllocations: [ownBatch()],
    } });
    expect(result.ok).toBe(true);
    expect(f.state().allocations).toHaveLength(2);
    expect(f.state().allocations[0].id).toBe('original-order-one');
    expect(f.state().allocations[1].invoiceId).toBe('genuinely-new-invoice');
    expect(f.tx.invoiceOrderAllocation.findMany).not.toHaveBeenCalled();
    expect(f.tx.invoiceOrderAllocation.update).not.toHaveBeenCalled();
  });

  it.each([undefined, null, '0', '-0.001', 'bad'])('batch allocation retains the explicit positive allocatedAmount gate: %s', async amount => {
    const f = fixture();
    const before = f.stateSnapshot();
    const result = await f.submit({ orderAllocations: [ownBatch({ allocatedAmount: amount })] });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_AMOUNT');
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
    expect(f.stateSnapshot()).toEqual(before);
  });

  it.each(['missing', 'deleted', 'cancelled', 'other-order'])('invalid batch source %s refuses replacement and restores all original facts', async kind => {
    const f = fixture();
    if (kind === 'missing') f.state().batches = [];
    if (kind === 'deleted') f.state().batches[0].deletedAt = timestamp;
    if (kind === 'cancelled') f.state().batches[0].status = 'cancelled';
    if (kind === 'other-order') f.state().batches[0].orderId = 'order-two';
    const before = f.stateSnapshot();
    const result = await f.submit({ notes: 'must roll back', orderAllocations: [ownBatch({ allocatedAmount: '33.3333' })] });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_AMOUNT');
    expect(f.stateSnapshot()).toEqual(before);
    expect(f.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('consolidation with another customer still refuses, preserving original customer and source history', async () => {
    const f = fixture();
    f.state().orders[1].customerRelationId = 'customer-two';
    f.state().orders[1].customer = 'Customer Two';
    const before = f.stateSnapshot();
    const result = await f.submit({ orderIds: ['order-one', 'order-two'] });
    expect(result.error?.code).toBe('INVOICE_CONSOLIDATION_CUSTOMER_MISMATCH');
    expect(f.stateSnapshot()).toEqual(before);
  });

  it('moving invoice customer and replacing its orders atomically audits the old and new ownership', async () => {
    const f = fixture();
    f.state().orders[1].customerRelationId = 'customer-two';
    f.state().orders[1].customer = 'Customer Two';
    expect((await f.submit({ customerRelationId: 'customer-two', customerName: 'Customer Two', orderIds: ['order-two'] })).ok).toBe(true);
    expect(f.state().allocations[0].deletedAt).not.toBeNull();
    expect(f.state().allocations[1]).toMatchObject({ orderId: 'order-two', invoiceId: 'invoice-original', deletedAt: null });
    expect(f.state().audits[0].detail.before).toMatchObject({ customerRelationId: 'customer-one', customerName: 'Customer One' });
    expect(f.state().audits[0].detail.after).toMatchObject({ customerRelationId: 'customer-two', customerName: 'Customer Two' });
  });

  it('a customer-only change continues to check retained allocations while leaving them untouched on refusal', async () => {
    const f = fixture();
    const before = f.stateSnapshot();
    expect((await f.submit({ customerRelationId: 'customer-two', customerName: 'Customer Two' })).error?.code).toBe('INVOICE_CUSTOMER_MISMATCH');
    expect(f.stateSnapshot()).toEqual(before);
    expect(f.tx.invoiceOrderAllocation.update).not.toHaveBeenCalled();
    expect(f.tx.invoiceOrderAllocation.updateMany).not.toHaveBeenCalled();
  });
});

describe('all allocation changes and mandatory audit share the invoice transaction', () => {
  it('a missing second order rolls back an already-updated first pair, including its former tombstone', async () => {
    const f = fixture({ allocations: [allocation('order-one', { deletedAt: timestamp })] });
    const before = f.stateSnapshot();
    const result = await f.submit({ orderAllocations: [ownBatch({ allocatedAmount: '12.0001' }), { orderId: 'missing-order', allocatedAmount: '87.9999' }] });
    expect(result.error?.code).toBe('INVALID_AMOUNT');
    expect(f.tx.invoiceOrderAllocation.update).toHaveBeenCalledTimes(1);
    expect(f.tx.auditLog.create).not.toHaveBeenCalled();
    expect(f.stateSnapshot()).toEqual(before);
  });

  it('the audit snapshot read failing after mutation restores the original allocation set', async () => {
    const f = fixture();
    const before = f.stateSnapshot();
    f.tx.invoiceOrderAllocation.findMany.mockImplementationOnce(async () => clone(before.allocations));
    f.tx.invoiceOrderAllocation.findMany.mockRejectedValueOnce(new Error('after-source snapshot unavailable'));
    const result = await f.submit({ orderAllocations: [ownBatch({ allocatedAmount: '11.0011' })] });
    expect(result.error?.code).toBe('UPDATE_FAILED');
    expect(f.tx.invoiceOrderAllocation.update).toHaveBeenCalledTimes(1);
    expect(f.tx.auditLog.create).not.toHaveBeenCalled();
    expect(f.stateSnapshot()).toEqual(before);
  });

  it('mandatory audit failure restores the invoice, revived/updated rows, removed rows and inserted rows', async () => {
    const f = fixture({ allocations: [allocation('order-one', { deletedAt: timestamp }), allocation('order-two')], auditFail: true });
    const before = f.stateSnapshot();
    const result = await f.submit({ notes: 'must not survive', orderAllocations: [ownBatch({ allocatedAmount: '70.0001' }), { orderId: 'order-three', allocatedAmount: '30.0001' }] });
    expect(result.error?.code).toBe('UPDATE_FAILED');
    expect(f.tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(f.tx.invoiceOrderAllocation.update).toHaveBeenCalled();
    expect(f.tx.invoiceOrderAllocation.create).toHaveBeenCalledTimes(1);
    expect(f.stateSnapshot()).toEqual(before);
    expect(result.error?.message).not.toContain('mandatory audit storage failure');
  });

  it('a storage error after the first pair update rolls back rather than falsely accepting replacement', async () => {
    const f = fixture({ allocations: [allocation('order-one')], writeFailOrderId: 'order-three' });
    const before = f.stateSnapshot();
    const result = await f.submit({ orderAllocations: [ownBatch({ allocatedAmount: '12.0001' }), { orderId: 'order-three', allocatedAmount: '87.9999' }] });
    expect(result.error?.code).toBe('UPDATE_FAILED');
    expect(f.tx.invoiceOrderAllocation.update).toHaveBeenCalledTimes(1);
    expect(f.tx.auditLog.create).not.toHaveBeenCalled();
    expect(f.stateSnapshot()).toEqual(before);
    expect(result.error?.message).not.toContain('storage allocation write rejected');
  });
});
