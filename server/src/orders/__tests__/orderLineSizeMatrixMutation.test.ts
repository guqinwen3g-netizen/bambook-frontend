import { beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({ order: null as any, line: null as any, created: null as any, updated: null as any }));
vi.mock('../orderLineWriteAccess', () => ({
  requireOrderLineWriteIdentity: vi.fn(),
  authorizeOrderLineWrite: vi.fn(async () => ({ order: shared.order, actor: { userId: 'sales-1' } })),
  lockedOrderLine: vi.fn(async () => shared.line),
  orderLineWriteFailure: vi.fn(() => null),
  OrderLineWriteError: class OrderLineWriteError extends Error {},
}));
vi.mock('../orderLineItems', () => ({ nextItemNo: vi.fn(() => '001') }));
vi.mock('../toleranceService', () => ({ validateTolerancePercentInput: vi.fn(() => ({ ok: true })) }));
vi.mock('../orderLifecycleService', () => ({ dependencyCheckFailedError: vi.fn() }));
vi.mock('../orderRequiredSampleFamilies', () => ({
  normalizeRequiredSampleFamilies: vi.fn(() => []), RequiredSampleFamiliesError: class RequiredSampleFamiliesError extends Error {},
}));
vi.mock('../../products/fabricExclusivityService', () => ({ assertFabricAllowed: vi.fn(async () => ({ ok: true })) }));
vi.mock('../../production/stageService', () => ({ advanceStage: vi.fn(async () => undefined) }));
vi.mock('../../shared/orderQuantityProjection', () => ({ refreshOrderQuantityHeader: vi.fn(async () => undefined) }));
vi.mock('../../entities/sync', () => ({ syncOrderLineEntityReferences: vi.fn(async () => undefined), deactivateEntityLinks: vi.fn() }));
vi.mock('../../audit/routeAudit', () => ({ writeRouteAuditLog: vi.fn(async () => 'AUDIT-1') }));
vi.mock('../../lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

import { createOrderLine, updateOrderLine } from '../orderLineMutationService';

const actor = { userId: 'sales-1', roles: [], permissions: [], departmentIds: [] } as any;
function database() {
  const tx: any = {
    $queryRaw: vi.fn(async () => [{ id: 'O1' }]),
    order: { findUniqueOrThrow: vi.fn(async () => shared.order) },
    approvalRequest: { findFirst: vi.fn(async () => null) },
    orderLine: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => ({ orderId: 'O1' })),
      create: vi.fn(async ({ data }: any) => {
        shared.created = data;
        return { ...data, quantity: { toString: () => String(data.quantity) } };
      }),
      update: vi.fn(async ({ data }: any) => {
        shared.updated = data;
        return { ...shared.line, ...data, quantity: { toString: () => String(data.quantity ?? shared.line.quantity) } };
      }),
    },
  };
  return { tx, prisma: { $transaction: vi.fn(async (work: any) => work(tx)), orderLine: { findMany: vi.fn(async () => []) } } as any };
}

beforeEach(() => {
  shared.order = { id: 'O1', type: 'Garment', businessLine: 'garment', status: 'Pending', customerRelationId: null, customer: '客户甲' };
  shared.line = { id: 'O1__001', orderId: 'O1', quantity: { toString: () => '100' }, unit: 'PC',
    sizeBreakdown: { S: 40, M: 60 }, status: 'Pending', productionSteps: [] };
  shared.created = null; shared.updated = null;
});

describe('authoritative garment size matrix writes', () => {
  it('rejects mismatched sizes before creating or auditing a line', async () => {
    const db = database();
    const result = await createOrderLine({ prisma: db.prisma, orderId: 'O1', quantity: '100', trustedActor: actor,
      extra: { sizeBreakdown: { S: 40, M: 59 } } });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('合计 99') } });
    expect(db.tx.orderLine.create).not.toHaveBeenCalled(); expect(shared.created).toBeNull();
  });

  it('stores the canonical valid matrix with a new line', async () => {
    const db = database();
    const result = await createOrderLine({ prisma: db.prisma, orderId: 'O1', quantity: '100', trustedActor: actor,
      extra: { sizeBreakdown: { ' S ': 40, M: 60 } } });
    expect(result).toMatchObject({ ok: true }); expect(shared.created?.sizeBreakdown).toEqual({ S: 40, M: 60 });
  });

  it('rejects quantity changes that would desynchronize the existing matrix', async () => {
    const db = database();
    const result = await updateOrderLine({ prisma: db.prisma, lineId: shared.line.id, trustedActor: actor, patch: { quantity: '101' } });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('合计 100') } });
    expect(db.tx.orderLine.update).not.toHaveBeenCalled(); expect(shared.updated).toBeNull();
  });

  it('allows a draft to change the matrix only when it still sums to the line quantity', async () => {
    const db = database();
    const result = await updateOrderLine({ prisma: db.prisma, lineId: shared.line.id, trustedActor: actor,
      patch: { sizeBreakdown: { S: 35, M: 65 } } });
    expect(result).toMatchObject({ ok: true }); expect(shared.updated?.sizeBreakdown).toEqual({ S: 35, M: 65 });
  });
});
