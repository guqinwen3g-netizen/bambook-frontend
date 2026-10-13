import { describe, expect, it, vi } from 'vitest';
import type { TokenPayload } from '../../auth/service';
import { createProductionBatch, splitProductionBatch, productionBatchLineFingerprint } from '../productionBatchService';
import { logger } from '../../lib/logger';

// Actual batch service, Orders permission loaders/L2 and branch arithmetic.
// Source qualification is an already-verified fixture boundary, not DB proof.
vi.mock('../releaseService', () => ({ lockOrderReleaseSources: vi.fn(async () => ({ failedSources: [] })) }));
vi.mock('../../orders/orderConfirmedSourceBinding', () => ({ orderConfirmedSourceBinding: vi.fn(async () => ({})) }));
vi.mock('../../development/fabricAssetEligibility', () => ({ assertConfirmedFabricSourceEligible: vi.fn(async () => ({ factoryRelationId: 'F1' })) }));
vi.mock('../../orderChanges/quantityPlanMoqGate', () => ({ currentOrderMoqReasons: vi.fn(async () => []) }));
vi.mock('../../lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
const actor: TokenPayload = { userId: 'batch-sales', roles: [], permissions: [], departmentIds: [] };
function storage(pending = false) {
  const user = { id: actor.userId, status: 'active', deletedAt: null,
    roles: [{ roleId: 'role-sales', role: { id: 'role-sales', permissions: [{ permission: { scope: 'orders:write' } }] } }] };
  const order = { id: 'O1', status: 'Confirmed', type: 'Garment', businessLine: 'garment', ownerId: actor.userId, customerRelationId: null, deletedAt: null };
  const line = { id: 'L1', orderId: 'O1', quantity: '10', unit: 'PC', confirmedSourceType: 'Asset', confirmedSourceId: 'A1', specSnapshot: { styleNo: 'S1' } };
  let rows: Array<Record<string, any>> = [];
  const audits: Array<Record<string, any>> = [];
  const db = {
    userAccount: { findFirst: vi.fn(async () => user), findUnique: vi.fn(async () => user) },
    userPermissionOverrides: { findMany: vi.fn(async () => []) },
    teamMember: { findMany: vi.fn(async () => []) }, teamDataGrant: { findMany: vi.fn(async () => []) },
    department: { findMany: vi.fn(async () => []) },
    relation: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => ({ ownerId: actor.userId, departmentId: null, salesRepIds: [] })),
      findUnique: vi.fn(async () => ({ id: 'F1', name: 'Factory', category: 'Supplier', isOrganization: true, ownerId: actor.userId, deletedAt: null })) },
    factoryProfile: { findUnique: vi.fn(async () => ({ relationId: 'F1', deletedAt: null, blacklistedAt: null })) },
    productAsset: { findUnique: vi.fn(async () => ({ id: 'A1', mainCategory: 'garment', garmentProfile: { factoryRelationId: 'F1' } })) },
    $queryRaw: vi.fn(async (query: { sql: string }) => {
      if (query.sql.includes('pg_advisory_xact_lock') && !query.sql.includes(')::text'))
        throw new Error('Prisma cannot deserialize a PostgreSQL void result');
      return [{ id: 'locked' }];
    }),
    order: { findFirst: vi.fn(async () => order), findUnique: vi.fn(async () => order) },
    orderLine: { findUnique: vi.fn(async () => line) },
    approvalRequest: { findFirst: vi.fn(async () => pending ? { id: 'APP1' } : null) },
    productionBatch: { findUnique: vi.fn(async ({ where }: any) => rows.find(row => row.id === where.id) ?? null),
      findMany: vi.fn(async ({ where }: any) => rows.filter(row => !where.state || row.state === where.state)),
      create: vi.fn(async ({ data }: any) => { const row = { ...data }; rows.push(row); return row; }),
      updateMany: vi.fn(async ({ where, data }: any) => { const index = rows.findIndex(row => row.id === where.id && row.state === where.state && row.revision === where.revision);
        if (index < 0) return { count: 0 }; rows[index] = { ...rows[index], ...data, revision: rows[index].revision + data.revision.increment }; return { count: 1 }; }) },
    productionBatchCompletion: { findFirst: vi.fn(async () => null) },
    shipmentProductionAllocation: { findFirst: vi.fn(async () => null) }, productionStockReceipt: { findFirst: vi.fn(async () => null) },
    auditLog: { findMany: vi.fn(async ({ where }: any) => audits.filter(audit => audit.detail.after.requestKey === where.AND[1].detail.equals)),
      create: vi.fn(async ({ data }: any) => { audits.push(data); return data; }) },
  };
  const prisma = { $transaction: vi.fn(async (work: (tx: typeof db) => Promise<unknown>) => work(db)) } as any;
  const input = { batchCode: 'FACTORY-A', quantity: '10', unit: 'PC', expectedLineFingerprint: productionBatchLineFingerprint(order, line), requestKey: 'create-original', productionLineChoice: { mode: 'factory_single' } };
  return { db, prisma, input, user, rows: () => rows, audits: () => audits,
    seedBatch: () => { rows.push({ id: 'PB1', orderId: 'O1', orderLineId: 'L1' }); } };
}

describe('production branch main-approval freeze and sales scope', () => {
  it('does not infer a new garment branch production organization from its factory', async () => {
    const f = storage(), { productionLineChoice: _choice, ...input } = f.input;
    expect(await createProductionBatch({ prisma: f.prisma, orderId: 'O1', lineId: 'L1', actor, input })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(f.db.productionBatch.create).not.toHaveBeenCalled(); expect(f.db.auditLog.create).not.toHaveBeenCalled();
  });
  it.each(['create', 'split'] as const)('pending main approval freezes %s after current identity and locks', async action => {
    const f = storage(true); f.seedBatch();
    const result = action === 'create'
      ? await createProductionBatch({ prisma: f.prisma, orderId: 'O1', lineId: 'L1', actor, input: f.input })
      : await splitProductionBatch({ prisma: f.prisma, batchId: 'PB1', actor, input: { requestKey: 'split-original' } });
    expect(result).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(f.db.approvalRequest.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ targetId: 'O1', status: 'pending' }) }));
    expect(f.db.auditLog.findMany).not.toHaveBeenCalled(); expect(f.db.productionBatch.create).not.toHaveBeenCalled();
    expect(f.db.productionBatch.updateMany).not.toHaveBeenCalled(); expect(f.db.auditLog.create).not.toHaveBeenCalled();
    expect(f.db.userAccount.findFirst).toHaveBeenCalledTimes(2); expect(f.db.$queryRaw).toHaveBeenCalled();
  });
  it('a current sales writer creates and splits its branch while preserving the parent and exact quantities', async () => {
    const f = storage();
    const created = await createProductionBatch({ prisma: f.prisma, orderId: 'O1', lineId: 'L1', actor, input: f.input });
    expect(created, String(vi.mocked(logger.error).mock.calls.at(-1)?.[1]?.error)).toMatchObject({ ok: true }); const parent = f.rows()[0];
    expect(parent).toMatchObject({ orderId: 'O1', orderLineId: 'L1', factoryRelationId: 'F1', createdBy: actor.userId, state: 'active' });
    const split = await splitProductionBatch({ prisma: f.prisma, batchId: parent.id, actor,
      input: { requestKey: 'split-original', expectedRevision: 1, expectedLineFingerprint: f.input.expectedLineFingerprint,
        children: [{ batchCode: 'CHILD-A', quantity: '4' }, { batchCode: 'CHILD-B', quantity: '6' }] } });
    expect(split, String(vi.mocked(logger.error).mock.calls.at(-1)?.[1]?.error)).toMatchObject({ ok: true });
    expect(f.rows().map(row => row.state)).toEqual(['split', 'active', 'active']);
    expect(f.rows().slice(1).map(row => String(row.quantity))).toEqual(['4', '6']);
    expect(f.rows().slice(1).every(row => row.parentBatchId === parent.id && row.createdBy === actor.userId)).toBe(true);
    expect(f.audits().map(audit => audit.action)).toEqual(['create_production_batch', 'split_production_batch']);
  });
  it('an unreadable main-approval state fails closed before creating or replaying a batch', async () => {
    const f = storage(); f.db.approvalRequest.findFirst.mockRejectedValue(Error('approval unavailable'));
    expect(await createProductionBatch({ prisma: f.prisma, orderId: 'O1', lineId: 'L1', actor, input: f.input }))
      .toMatchObject({ ok: false, error: { code: 'AUTHORIZATION_UNAVAILABLE' } });
    expect(f.db.productionBatch.create).not.toHaveBeenCalled(); expect(f.db.auditLog.findMany).not.toHaveBeenCalled();
  });
});
