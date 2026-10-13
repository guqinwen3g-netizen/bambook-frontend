import { beforeEach, expect, it, vi } from 'vitest';

const seams = vi.hoisted(() => ({ readWhere: vi.fn(), attachUsers: vi.fn() }));

vi.mock('../qcAssignmentAccess', async importOriginal => {
  const actual = await importOriginal<typeof import('../qcAssignmentAccess')>();
  return { ...actual, qcAssignmentReadWhere: seams.readWhere };
});
vi.mock('../qcAssignmentUsers', async importOriginal => {
  const actual = await importOriginal<typeof import('../qcAssignmentUsers')>();
  return { ...actual, attachQcAssignmentUsers: seams.attachUsers };
});

import { createQcService } from '../qcService';

beforeEach(() => {
  vi.clearAllMocks();
  seams.readWhere.mockResolvedValue({ where: { orderId: { in: ['ORDER-1'] } } });
  seams.attachUsers.mockImplementation(async (_db: unknown, rows: unknown[]) => rows);
});

it('QC工作台订单快照只读返回 type，供业务线缺失时做保守的前端回退', async () => {
  const assignment = { id: 'QC-A1', orderId: 'ORDER-1', qcUserId: 'QC-1', status: 'Assigned',
    assignedAt: 1n, deletedAt: null, completedAt: null };
  const orderFindMany = vi.fn(async () => [{ id: 'ORDER-1', poNumber: 'PO-1', customer: '客户甲',
    product: '面料', businessLine: null, type: 'Fabric' }]);
  const db: any = {
    $transaction: async (work: (tx: any) => unknown) => work(db),
    qCAssignment: { findMany: vi.fn().mockResolvedValue([assignment]) },
    order: { findMany: orderFindMany },
  };

  const result = await createQcService(db).getWorkbench({}, { userId: 'QC-1' } as any);

  expect(orderFindMany).toHaveBeenCalledWith(expect.objectContaining({
    select: expect.objectContaining({ businessLine: true, type: true }),
  }));
  expect(result.assigned[0].order).toMatchObject({ businessLine: null, type: 'Fabric' });
});
