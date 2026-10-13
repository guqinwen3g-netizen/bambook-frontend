import { describe, expect, it, vi } from 'vitest';
import type { Request, Response, RequestHandler } from 'express';
import type { TokenPayload } from '../../auth/service';
import { createOrderLinesRouter } from '../orderLinesRoute';
import { orderConfirmedSourceBinding } from '../orderConfirmedSourceBinding';

// Directly invokes the real version handler without opening an HTTP listener.
// Current transactional identity, locks and audit run; source eligibility is a
// substituted boundary here and is exercised by confirmedSourceRoute separately.
vi.mock('../../development/fabricAssetEligibility', () => ({ lockConfirmedFabricSources: vi.fn(async () => undefined) }));
vi.mock('../orderConfirmedSourceBinding', () => ({ orderConfirmedSourceBinding: vi.fn(async () => ({
  sourceCode: 'VERIFIED-SOURCE', specSnapshot: { specification: 'real selected source' },
})) }));
const actor: TokenPayload = { userId: 'sales-version', roles: [], permissions: [], departmentIds: [] };
function fixture(patch: Record<string, unknown> = {}, pending = false) {
  let line = { id: 'L1', orderId: 'O1', confirmedSourceType: null, confirmedSourceId: null,
    confirmedAt: null, confirmedBy: null, specSnapshot: null, ...patch };
  const order = { id: 'O1', type: 'fabric', status: 'Pending', ownerId: actor.userId, customerRelationId: null, deletedAt: null };
  const user = { id: actor.userId, status: 'active', deletedAt: null,
    roles: [{ roleId: 'role-sales', role: { id: 'role-sales', permissions: [{ permission: { scope: 'orders:write' } }] } }] };
  const db = {
    userAccount: { findFirst: vi.fn(async () => user), findUnique: vi.fn(async () => user) },
    userPermissionOverrides: { findMany: vi.fn(async () => []) },
    teamMember: { findMany: vi.fn(async () => []) }, teamDataGrant: { findMany: vi.fn(async () => []) },
    department: { findMany: vi.fn(async () => []) }, relation: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => [{ id: 'locked' }]), order: { findFirst: vi.fn(async () => order) },
    approvalRequest: { findFirst: vi.fn(async () => pending ? { id: 'APP1' } : null) },
    productionBatch: { findFirst: vi.fn(async (): Promise<{ id: string } | null> => null) },
    releaseScope: { findFirst: vi.fn(async (): Promise<{ id: string } | null> => null) },
    orderSampleCoverage: { findFirst: vi.fn(async (): Promise<{ id: string } | null> => null) },
    shipmentLine: { findFirst: vi.fn(async (): Promise<{ id: string } | null> => null) },
    shipmentOrderAllocation: { findFirst: vi.fn(async (): Promise<{ id: string } | null> => null) },
    invoiceOrderAllocation: { findFirst: vi.fn(async (): Promise<{ id: string } | null> => null) },
    purchaseLine: { findFirst: vi.fn(async (): Promise<{ id: string } | null> => null) },
    procurementDemand: { findFirst: vi.fn(async (): Promise<{ id: string } | null> => null) },
    inspectionReport: { findFirst: vi.fn(async (): Promise<{ id: string } | null> => null) },
    orderLine: { findFirst: vi.fn(async () => ({ ...line })), findUnique: vi.fn(async () => line),
      findUniqueOrThrow: vi.fn(async () => line), updateMany: vi.fn(async ({ data }: { data: typeof line }) => { line = { ...line, ...data }; return { count: 1 }; }) },
    auditLog: { create: vi.fn(async () => ({})) },
  };
  const prisma = { ...db, $transaction: vi.fn(async (work: (tx: typeof db) => Promise<unknown>) => work(db)) };
  const onDataChange = vi.fn();
  const router = createOrderLinesRouter({ prisma: prisma as never, requireAuth: true, apiKeys: new Set(), onDataChange });
  const handler = router.stack.find(layer => layer.route?.path === '/:id/version')!.route.stack.at(-1).handle as RequestHandler;
  let status = 200, body: unknown;
  const res = { locals: { orderWriteScope: {} }, status(value: number) { status = value; return this; },
    json(value: unknown) { body = value; return this; } };
  const invoke = async (input = { confirmedSourceType: 'Asset', confirmedSourceId: 'ASSET1' }) => {
    await handler({ params: { id: 'L1' }, body: input, actor, ip: null } as unknown as Request, res as unknown as Response, vi.fn());
    return { status, body };
  };
  return { db, order, onDataChange, invoke, line: () => line };
}

describe('version selection preserves approval and frozen basis', () => {
  it('pending main approval freezes source selection before source lookup or mutation', async () => {
    vi.mocked(orderConfirmedSourceBinding).mockClear(); const f = fixture({}, true);
    expect(await f.invoke()).toMatchObject({ status: 409, body: { ok: false, error: { code: 'CONFLICT' } } });
    expect(orderConfirmedSourceBinding).not.toHaveBeenCalled(); expect(f.db.orderLine.updateMany).not.toHaveBeenCalled();
    expect(f.db.auditLog.create).not.toHaveBeenCalled(); expect(f.onDataChange).not.toHaveBeenCalled();
  });
  it.each([
    { name: 'specification', patch: { specSnapshot: { approvedSpecification: '保留原依据' } } },
    { name: 'confirmation time', patch: { confirmedAt: BigInt(1) } },
    { name: 'original approver', patch: { confirmedBy: 'original-approver' } },
  ])('incomplete historical reference with $name cannot replace its existing evidence', async ({ patch }) => {
    vi.mocked(orderConfirmedSourceBinding).mockClear(); const f = fixture(patch); f.order.status = 'Confirmed';
    const before = { ...f.line() };
    expect(await f.invoke()).toMatchObject({ status: 409, body: { ok: false, error: { code: 'CONFLICT' } } });
    expect(f.line()).toEqual(before); expect(orderConfirmedSourceBinding).not.toHaveBeenCalled();
    expect(f.db.orderLine.updateMany).not.toHaveBeenCalled(); expect(f.db.auditLog.create).not.toHaveBeenCalled();
  });
  it('a sales writer may explicitly bind a verified source to a truly empty historical row', async () => {
    vi.mocked(orderConfirmedSourceBinding).mockClear(); const f = fixture();
    expect(await f.invoke()).toMatchObject({ status: 200, body: { ok: true } });
    expect(orderConfirmedSourceBinding).toHaveBeenCalledWith(f.db, f.order, expect.any(Object),
      { confirmedSourceType: 'Asset', confirmedSourceId: 'ASSET1', millRelationId: undefined },
      expect.objectContaining({ userId: actor.userId, roles: ['sales'], authorizationLoaded: true }));
    expect(f.db.orderLine.updateMany).toHaveBeenCalledTimes(1); expect(f.db.auditLog.create).toHaveBeenCalledTimes(1);
  });
  it('an empty formal historical row records selection audit without creating confirmation metadata', async () => {
    const f = fixture(); f.order.status = 'Confirmed';
    expect(await f.invoke()).toMatchObject({ status: 200, body: { ok: true } });
    expect(f.line()).toMatchObject({ confirmedSourceType: 'Asset', confirmedSourceId: 'ASSET1', confirmedAt: null, confirmedBy: null });
    expect(f.db.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      action: 'backfill_order_line_version', actorId: actor.userId,
      detail: expect.objectContaining({ after: expect.objectContaining({ selectedAt: expect.any(String), selectedBy: actor.userId, selectionOnly: true }) }),
    }) }));
  });
  it.each(['productionBatch', 'releaseScope', 'orderSampleCoverage', 'shipmentLine', 'shipmentOrderAllocation', 'invoiceOrderAllocation', 'inspectionReport', 'purchaseLine', 'procurementDemand'] as const)('a formal blank source with %s facts cannot be backfilled', async delegate => {
    const f = fixture(); f.order.status = 'Confirmed'; f.db[delegate].findFirst.mockResolvedValue({ id: 'EXISTING-FACT' });
    expect(await f.invoke()).toMatchObject({ status: 409, body: { ok: false, error: { code: 'CONFLICT' } } });
    expect(f.db.orderLine.updateMany).not.toHaveBeenCalled(); expect(f.db.auditLog.create).not.toHaveBeenCalled();
  });
  it.each([{ productionBatch: '旧生产批' }, { productionSteps: [{ step: 'sewing', status: 'done' }] },
    { shipmentQuantity: 3 }, { actualPaymentAmount: '2' }, { garmentSampleStages: [{ stage: 'pp', status: 'confirmed' }] }])('a formal row with its own fulfillment fields cannot acquire a new basis', async patch => {
    const f = fixture(patch); f.order.status = 'Confirmed';
    expect(await f.invoke()).toMatchObject({ status: 409, body: { ok: false, error: { code: 'CONFLICT' } } });
    expect(f.db.orderLine.updateMany).not.toHaveBeenCalled(); expect(f.db.auditLog.create).not.toHaveBeenCalled();
  });
  it('the same frozen reference is a readback without replacing its snapshot, time, approver or audit', async () => {
    const f = fixture({ confirmedSourceType: 'Asset', confirmedSourceId: 'ASSET1', confirmedAt: BigInt(10),
      confirmedBy: 'original-approver', specSnapshot: { approvedSpecification: '保留原依据' } });
    f.order.status = 'Confirmed'; const before = { ...f.line() };
    expect(await f.invoke()).toMatchObject({ status: 200, body: { ok: true } });
    expect(f.line()).toEqual(before); expect(f.db.orderLine.updateMany).not.toHaveBeenCalled();
    expect(f.db.auditLog.create).not.toHaveBeenCalled(); expect(f.onDataChange).not.toHaveBeenCalled();
  });
  it('a different source cannot replace a complete approved reference', async () => {
    const f = fixture({ confirmedSourceType: 'Asset', confirmedSourceId: 'ORIGINAL', confirmedAt: BigInt(10),
      confirmedBy: 'original-approver', specSnapshot: { approvedSpecification: '保留原依据' } });
    f.order.status = 'Confirmed';
    expect(await f.invoke()).toMatchObject({ status: 409, body: { ok: false, error: { code: 'CONFLICT' } } });
    expect(f.line().confirmedSourceId).toBe('ORIGINAL'); expect(f.db.orderLine.updateMany).not.toHaveBeenCalled();
    expect(f.db.auditLog.create).not.toHaveBeenCalled(); expect(f.onDataChange).not.toHaveBeenCalled();
  });
});
