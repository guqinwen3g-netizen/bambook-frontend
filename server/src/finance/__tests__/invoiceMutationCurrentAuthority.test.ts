/** Actual canonical/current-grant/object-scope controls with explicit in-memory
 * storage. No auth policy is mocked. Rollback is the supplied transaction seam;
 * this suite does not claim native PostgreSQL isolation or production role UAT.
 */
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenPayload } from '../../auth/service';
vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../events/businessEventBus', () => ({ publishBusinessEvent: vi.fn().mockResolvedValue(undefined) }));
// Independent post-commit derived refresh; notes-only must not call this hook.
vi.mock('../shipmentBatchSettlementHook', () => ({ notifyShipmentBatchSettlementRecalc: vi.fn().mockResolvedValue(undefined) }));
import { createInvoice, updateInvoice } from '../invoiceMutationService';
import { notifyShipmentBatchSettlementRecalc } from '../shipmentBatchSettlementHook';

const USER = 'synthetic-current-invoice-writer';
const ID = 'INV-current-authority';
const actor: TokenPayload = {
  userId: USER, roles: ['admin'], departmentIds: [], permissions: ['invoices:write'],
  authorizationLoaded: true, permissionCeiling: ['invoices:write'],
};
function clone<T>(value: T): T {
  if (Prisma.Decimal.isDecimal(value)) return new Prisma.Decimal(value.toString()) as T;
  if (Array.isArray(value)) return value.map(clone) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) as T;
  return value;
}
interface State { invoices: Record<string, any>[]; allocations: Record<string, any>[]; audits: Record<string, any>[]; sequence: number }
function matches(row: Record<string, any>, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'AND') return (Array.isArray(condition) ? condition : [condition]).every(item => matches(row, item));
    if (key === 'OR') return condition.some((item: Record<string, any>) => matches(row, item));
    return row[key] === condition;
  });
}
function fixture(options: { ownerId?: string; revokeAfter?: 'create' | 'update'; authorizationFails?: boolean; missingFinanceDepartment?: boolean } = {}) {
  const state: State = {
    invoices: [{ id: ID, invoiceNumber: 'INV-2026-0042', type: 'Receivable', status: 'Issued', currency: 'USD',
      amount: new Prisma.Decimal('100.0001'), ownerId: options.ownerId ?? USER, notes: 'Original note', deletedAt: null, createdAt: 1n, updatedAt: 2n }],
    // An original issued invoice may retain a historical cancelled shipment.
    // A legitimate notes correction must not read or rebind these identities.
    allocations: [{ id: 'IOA-history', invoiceId: ID, orderId: 'O-history', batchId: 'OSB-cancelled-history',
      allocatedAmount: new Prisma.Decimal('100.0001'), note: 'Original allocation', deletedAt: null, createdAt: 1n }],
    audits: [{ id: 'audit-original', actorId: USER, action: 'create_invoice' }], sequence: 0,
  };
  // Current account authority is external state: revocation is not undone by
  // rolling back this command's business transaction.
  const authority = { status: 'active', scopes: ['invoices:write'] };
  const forbiddenAllocation = () => vi.fn().mockRejectedValue(Error('A notes-only/standalone command must not read or mutate IOA'));
  const db = {
    department: { findMany: vi.fn(async () => []) },
    userAccount: { findUnique: vi.fn().mockImplementation(async ({ where }: any) => where.id === USER && where.deletedAt === null ? {
      id: USER, status: authority.status, primaryDeptId: 'synthetic-finance-department',
      primaryDepartment: options.missingFinanceDepartment ? null : { id: 'synthetic-finance-department', status: 'active', parentId: 'synthetic-company', metadata: { businessAttributes: ['finance'] } },
      // This stored custom role is self-scoped. A prior token's admin claim
      // cannot restore all-object visibility after current roles are loaded.
      roles: [{ departmentId: null, role: { id: 'synthetic-self-invoice-role',
        permissions: authority.scopes.map(scope => ({ permission: { scope } })) } }],
    } : null) },
    userPermissionOverrides: { findMany: vi.fn().mockImplementation(async () => {
      if (options.authorizationFails) throw Error('Synthetic storage outage with private SQL details');
      return [];
    }) },
    invoice: {
      findFirst: vi.fn().mockImplementation(async ({ where }: any) => clone(state.invoices.find(row => matches(row, where)) ?? null)),
      findUnique: vi.fn().mockImplementation(async ({ where }: any) => clone(state.invoices.find(row => row.id === where.id) ?? null)),
      create: vi.fn().mockImplementation(async ({ data }: any) => {
        state.invoices.push(clone(data));
        if (options.revokeAfter === 'create') authority.scopes = [];
        return clone(data);
      }),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => {
        const row = state.invoices.find(item => item.id === where.id);
        if (!row) throw Error('Synthetic update target missing');
        Object.assign(row, clone(data));
        if (options.revokeAfter === 'update') authority.scopes = [];
        return clone(row);
      }),
    },
    invoiceOrderAllocation: { findMany: forbiddenAllocation(), create: forbiddenAllocation(), update: forbiddenAllocation(),
      updateMany: forbiddenAllocation(), delete: forbiddenAllocation(), deleteMany: forbiddenAllocation() },
    invoiceLine: { findMany: vi.fn(async () => []) },
    businessSequence: {
      upsert: vi.fn().mockImplementation(async () => ({ seq: state.sequence })),
      update: vi.fn().mockImplementation(async () => ({ seq: ++state.sequence })),
    },
    auditLog: { create: vi.fn().mockImplementation(async ({ data }: any) => {
      // Actual route audit must provide serializable actor/action/detail.
      JSON.stringify(data.detail);
      state.audits.push(clone(data)); return clone(data);
    }) },
    $queryRawUnsafe: vi.fn().mockImplementation(async (query: string, id: string) => {
      if (query.startsWith('SELECT * FROM "MaterialReturn"')) return [];
      if (query === 'SELECT id FROM "Invoice" WHERE id = $1 FOR UPDATE') return state.invoices.some(row => row.id === id) ? [{ id }] : [];
      throw Error('Unexpected SQL in standalone/notes authority control');
    }),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (work: (tx: typeof db) => Promise<any>) => {
    const before = clone(state);
    try { return await work(db); }
    catch (error) { Object.assign(state, before); throw error; }
  });
  return { db, state, authority };
}
const standalone = { type: 'Receivable', status: 'Draft', amount: '7.0001', currency: 'USD' };
function noAllocationAccess(db: ReturnType<typeof fixture>['db']) {
  for (const delegate of Object.values(db.invoiceOrderAllocation)) expect(delegate).not.toHaveBeenCalled();
}
function noBusinessMutation(db: ReturnType<typeof fixture>['db']) {
  expect(db.invoice.create).not.toHaveBeenCalled(); expect(db.invoice.update).not.toHaveBeenCalled();
  expect(db.businessSequence.upsert).not.toHaveBeenCalled(); expect(db.businessSequence.update).not.toHaveBeenCalled();
  expect(db.auditLog.create).not.toHaveBeenCalled(); noAllocationAccess(db);
}
beforeEach(() => { vi.clearAllMocks(); });

describe('Actual Invoice current writer and financial object authority', () => {
  it('rejects an invoice role grant without an actual finance department before any write', async () => {
    const { db, state } = fixture({ missingFinanceDepartment: true }), before = clone(state);
    const result = await createInvoice({ prisma: db as any, actor, actorId: USER, input: standalone });
    expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(db.invoice.create).not.toHaveBeenCalled(); expect(db.auditLog.create).not.toHaveBeenCalled(); expect(state).toEqual(before);
  });
  it('standalone create rejects revoked stored grant even with a previously authorized admin token', async () => {
    const { db, state, authority } = fixture(); const before = clone(state); authority.scopes = [];
    const result = await createInvoice({ prisma: db as any, actor, actorId: USER, input: standalone });
    expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(db.userAccount.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: USER, deletedAt: null } }));
    expect(db.userPermissionOverrides.findMany).toHaveBeenCalledOnce(); expect(state).toEqual(before); noBusinessMutation(db);
  });
  it('standalone create preserves an explicit empty signed ceiling despite a live stored grant', async () => {
    const { db, state } = fixture(); const before = clone(state);
    const result = await createInvoice({ prisma: db as any, actor: { ...actor, permissionCeiling: [] }, actorId: USER, input: standalone });
    expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(db.userPermissionOverrides.findMany).toHaveBeenCalledOnce(); expect(state).toEqual(before); noBusinessMutation(db);
  });
  it('body actor/actorId cannot supply an explicitly missing trusted credential', async () => {
    const { db, state } = fixture(); const before = clone(state);
    const result = await createInvoice({ prisma: db as any, actor: null, actorId: USER,
      input: { ...standalone, actor, actorId: USER, ownerId: USER } as any });
    expect(result).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
    expect(db.userAccount.findUnique).not.toHaveBeenCalled(); expect(state).toEqual(before); noBusinessMutation(db);
  });
  it('notes-only update rejects a foreign financial object using current self scope without reading IOA', async () => {
    const { db, state } = fixture({ ownerId: 'other-current-owner' }); const before = clone(state);
    const result = await updateInvoice({ prisma: db as any, invoiceId: ID, actor, actorId: USER,
      input: { notes: 'Attempted foreign correction', ownerId: USER, actor } as any });
    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(db.invoice.findFirst).toHaveBeenCalledWith({ where: { id: ID, deletedAt: null, AND: [{ ownerId: USER }] }, select: { id: true } });
    expect(db.$queryRawUnsafe).toHaveBeenCalledWith('SELECT id FROM "Invoice" WHERE id = $1 FOR UPDATE', ID);
    expect(state).toEqual(before); noBusinessMutation(db);
  });
  it('revocation after notes storage and before mandatory audit rolls back the whole command', async () => {
    const { db, state, authority } = fixture({ revokeAfter: 'update' }); const before = clone(state);
    const result = await updateInvoice({ prisma: db as any, invoiceId: ID, actor, actorId: USER, input: { notes: 'Must roll back' } });
    expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(db.invoice.update).toHaveBeenCalledOnce(); expect(db.userAccount.findUnique).toHaveBeenCalledTimes(3);
    expect(db.auditLog.create).not.toHaveBeenCalled(); expect(authority.scopes).toEqual([]); expect(state).toEqual(before); noAllocationAccess(db);
    expect(notifyShipmentBatchSettlementRecalc).not.toHaveBeenCalled();
  });
  it('legal notes-only update uses actual current grants and mandatory audit while preserving all original IOA', async () => {
    const { db, state } = fixture(); const allocationBefore = clone(state.allocations);
    const result = await updateInvoice({ prisma: db as any, invoiceId: ID, actor, actorId: USER, input: { notes: 'Legitimate correction' }, ip: '127.0.0.7' });
    expect(result.ok).toBe(true); expect(state.invoices[0]).toMatchObject({ id: ID, notes: 'Legitimate correction', status: 'Issued', ownerId: USER });
    expect(state.invoices[0].amount.toString()).toBe('100.0001'); expect(db.userAccount.findUnique).toHaveBeenCalledTimes(3);
    expect(db.userPermissionOverrides.findMany).toHaveBeenCalledTimes(3);
    expect(db.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ actorId: USER, action: 'update_invoice', targetType: 'Invoice', targetId: ID, ip: '127.0.0.7',
      detail: { source: 'route:invoice:update', before: { status: 'Issued', amount: '100.0001' }, after: { status: 'Issued', amount: '100.0001' } } }) });
    expect(state.audits).toHaveLength(2); expect(state.allocations).toEqual(allocationBefore); noAllocationAccess(db);
    expect(notifyShipmentBatchSettlementRecalc).not.toHaveBeenCalled();
  });
  it('CI-backed receivable rejects edits to the issued invoice facts', async () => {
    const { db, state } = fixture();
    state.invoices[0].sourceType = 'BusinessShipmentCI';
    state.invoices[0].sourceId = 'issued-ci-version-1';
    const before = clone(state);
    const result = await updateInvoice({ prisma: db as any, invoiceId: ID, actorId: USER,
      actor,
      input: { amount: '90.0001' } as any });
    expect(result).toMatchObject({ ok: false, error: { code: 'HANDOFF_CONFLICT' } });
    expect(state).toEqual(before);
    expect(db.invoice.update).not.toHaveBeenCalled();
    noAllocationAccess(db);
  });
  it('revocation after standalone creation rolls back allocated number, invoice and audit without losing the revocation', async () => {
    const { db, state, authority } = fixture({ revokeAfter: 'create' }); const before = clone(state);
    const result = await createInvoice({ prisma: db as any, actor, actorId: USER, input: standalone });
    expect(result).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(db.invoice.create).toHaveBeenCalledOnce(); expect(db.businessSequence.update).toHaveBeenCalledOnce();
    expect(db.userAccount.findUnique).toHaveBeenCalledTimes(2); expect(db.auditLog.create).not.toHaveBeenCalled();
    expect(state).toEqual(before); expect(authority.scopes).toEqual([]); noAllocationAccess(db);
    expect(notifyShipmentBatchSettlementRecalc).not.toHaveBeenCalled();
  });
  it('a failed current personal-grant query returns safe AUTHORIZATION_UNAVAILABLE before any business write', async () => {
    const { db, state } = fixture({ authorizationFails: true }); const before = clone(state);
    const result = await createInvoice({ prisma: db as any, actor, actorId: USER, input: standalone });
    expect(result).toMatchObject({ ok: false, error: { code: 'AUTHORIZATION_UNAVAILABLE' } });
    expect(JSON.stringify(result)).not.toContain('private SQL'); expect(state).toEqual(before); noBusinessMutation(db);
  });
});


describe('CommissionPayable is derived only by its trusted pricing transaction', () => {
  it.each([undefined, { tx: {}, deferAfterCommit: 'body text' }])('a manual JSON source cannot mint a commission anchor (body transaction=%j)', async transaction => {
    const f = fixture(); const before = clone(f.state);
    const result = await createInvoice({ prisma: f.db as any, actorId: USER, actor,
      input: { ...standalone, type: 'Payable', sourceType: 'CommissionPayable', sourceId: 'O-source#1', transaction } as any });
    expect(result).toEqual({ ok: false, error: { code: 'CONFLICT', message: '佣金应付请从订单的佣金核算入口生成，不能手工指定该来源。' } });
    expect(f.db.$transaction).not.toHaveBeenCalled();
    expect(f.db.invoice.create).not.toHaveBeenCalled();
    expect(f.db.auditLog.create).not.toHaveBeenCalled();
    expect(f.state).toEqual(before);
  });
  it('ordinary manual AP without a reserved commission source keeps its current invoice authority', async () => {
    const f = fixture();
    const result = await createInvoice({ prisma: f.db as any, actorId: USER, actor,
      input: { ...standalone, type: 'Payable' } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error('Ordinary manual AP refused');
    expect(String(result.data!.invoice.amount)).toBe('7.0001');
    expect(result.data!.invoice.type).toBe('Payable');
    expect(f.state.invoices).toHaveLength(2);
    expect(f.state.audits).toHaveLength(2);
    noAllocationAccess(f.db);
  });
});
