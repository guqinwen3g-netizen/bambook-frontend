import { describe, expect, it, vi, beforeEach } from 'vitest';
import { businessEventBus } from '../../events/businessEventBus';
import { createCleanupTask, createCrashRecoveryTask } from '../tasks/retryLinkages';

function makePrisma() {
  const updates: Array<{ where: any; data: any }> = [];
  const prisma: any = {
    agentJob: {
      findMany: vi.fn(),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => {
        updates.push({ where, data });
        return { id: where.id, ...data };
      }),
    },
  };
  return { prisma, updates };
}

describe('createCleanupTask（G2-1 不静默丢弃超龄 queued 事件）', () => {
  const dispatchMock = vi.fn();
  beforeEach(() => { dispatchMock.mockClear(); dispatchMock.mockResolvedValue({ ok: true, errors: [] }); vi.spyOn(businessEventBus, 'dispatch').mockImplementation(dispatchMock); });

  it('超龄 queued 有效事件 → 重放并标 completed（获得补跑机会，不再静默完成）', async () => {
    const { prisma, updates } = makePrisma();
    prisma.agentJob.findMany.mockResolvedValue([
      { id: 'j1', jobType: 'bev:order_confirmed', status: 'queued', payload: { id: 'e1', type: 'order_confirmed', sourceEntityId: 'order-1' }, scheduledAt: new Date(Date.now() - 600000) },
    ]);
    const task = createCleanupTask();
    expect(task.shouldRun(new Date())).toBe(true);
    await task.run(prisma);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].data.status).toBe('completed');
  });

  it('无效 payload → 标 failed（可见，而非静默丢弃）', async () => {
    const { prisma, updates } = makePrisma();
    prisma.agentJob.findMany.mockResolvedValue([
      { id: 'j1', jobType: 'bev:x', status: 'queued', payload: null, scheduledAt: new Date() },
    ]);
    const task = createCleanupTask();
    expect(task.shouldRun(new Date())).toBe(true);
    await task.run(prisma);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(updates[0].data.status).toBe('failed');
  });
  it('consumer failure remains queued with error, later successful replay completes it', async () => {
    const { prisma, updates } = makePrisma();
    prisma.agentJob.findMany.mockResolvedValue([{ id: 'j1', jobType: 'bev:OrderConfirmed',
      payload: { type: 'OrderConfirmed', sourceEntityId: 'order-1' } }]);
    dispatchMock.mockResolvedValueOnce({ ok: false, errors: ['temporary db failure'] })
      .mockResolvedValueOnce({ ok: true, errors: [] });
    await createCleanupTask().run(prisma);
    expect(updates[0].data).toMatchObject({ status: 'queued', error: 'temporary db failure', completedAt: null });
    await createCleanupTask().run(prisma);
    expect(updates[1].data).toMatchObject({ status: 'completed', error: null });
    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'j1' }));
  });
  it('startup recovery keeps failed consumption queued and continues a full backlog next tick', async () => {
    const { prisma, updates } = makePrisma();
    prisma.agentJob.findMany.mockResolvedValueOnce(Array.from({ length: 50 }, (_, index) => ({
      id: `job-${index}`, jobType: 'bev:OrderConfirmed',
      payload: { type: 'OrderConfirmed', sourceEntityId: `order-${index}` },
    }))).mockResolvedValueOnce([]);
    dispatchMock.mockResolvedValueOnce({ ok: false, errors: ['unavailable'] });
    const task = createCrashRecoveryTask();
    await task.run(prisma);
    expect(updates[0].data.status).toBe('queued');
    expect(updates.filter(item => item.data.status === 'completed')).toHaveLength(49);
    expect(task.shouldRun(new Date())).toBe(true);
    await task.run(prisma);
    expect(task.shouldRun(new Date())).toBe(false);
  });
});