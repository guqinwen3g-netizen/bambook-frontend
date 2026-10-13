import { describe, expect, it, vi } from 'vitest';
import { createKnowledgeService } from '../knowledge';
import { createMemoryService } from '../memory';
import { ensureDefaultAgentTools } from '../tools';
import { createJobService } from '../jobs';
import { createIdentityService } from '../identity';
import { createPolicyService } from '../policy';

describe('Agent OS services', () => {
  it('ingests documents into traceable chunks and filters search by actor policy', async () => {
    const identity = createIdentityService();
    const policy = createPolicyService();
    const service = createKnowledgeService({ policy });
    await service.ingestDocument({
      id: 'doc-finance',
      title: 'Finance SOP',
      sourceType: 'manual',
      content: '开票需要检查客户抬头。\n付款记录只能财务查看。',
      scopes: ['finance'],
    });
    await service.ingestDocument({
      id: 'doc-sales',
      title: 'Sales SOP',
      sourceType: 'manual',
      content: '报价前需要确认客户等级。',
      scopes: ['sales'],
    });

    const financeActor = await identity.resolveActorContext({ userId: 'f1', roles: ['finance'], departmentIds: ['finance'] });
    const results = await service.search({ actor: financeActor, query: '客户' });

    expect(results.map(result => result.title)).toEqual(['Finance SOP']);
    expect(results[0]).toMatchObject({
      source: 'knowledge-document:doc-finance',
      scopes: ['finance'],
    });
  });

  it('stores personal, role, department, and company memories separately (Prisma 持久化)', async () => {
    const created: any[] = [];
    const prisma = {
      agentMemory: {
        create: vi.fn(async ({ data }: any) => { created.push(data); return { ...data, createdAt: new Date(), updatedAt: new Date() }; }),
        findMany: vi.fn(async ({ where }: any) => created.filter(m =>
          where.scope.in.includes(m.scope))),
        count: vi.fn(async () => created.length),
        groupBy: vi.fn(async () => Array.from(new Set(created.map(m => m.scope))).map(scope => ({ scope }))),
      },
    } as any;
    const service = createMemoryService(prisma);
    const actor = await createIdentityService().resolveActorContext({ userId: 'u1', roles: ['sales'], departmentIds: ['sales'] });

    await service.remember({ actor, scope: 'personal:u1', memoryType: 'preference', content: '喜欢中文摘要' });
    await service.remember({ actor, scope: 'department:sales', memoryType: 'process', content: '报价前确认客户等级' });
    await service.remember({ actor, scope: 'company', memoryType: 'rule', content: '高风险发送邮件需审批' });

    await expect(service.recall({ actor, scope: 'personal:u1' })).resolves.toHaveLength(1);
    await expect(service.recall({ actor, scope: 'department:sales' })).resolves.toHaveLength(1);
    await expect(service.recall({ actor, scope: 'company' })).resolves.toHaveLength(1);
    // 越权 scope 写入拒绝（sales 不含 role:finance）
    await expect(service.remember({ actor, scope: 'role:finance', memoryType: 'rule', content: 'x' }))
      .rejects.toThrow('MEMORY_SCOPE_NOT_ALLOWED');
    // personal scope 落 userId 列
    expect(created[0]).toMatchObject({ userId: 'u1', departmentId: null, scope: 'personal:u1' });
    expect(created[1]).toMatchObject({ userId: null, departmentId: 'sales', scope: 'department:sales' });
  });

  it('persists default Agent OS tools and role permissions', async () => {
    const prisma = {
      role: { upsert: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({}) },
      agentTool: { upsert: vi.fn().mockResolvedValue({}) },
      agentToolPermission: { upsert: vi.fn().mockResolvedValue({}) },
    } as any;

    await ensureDefaultAgentTools(prisma);

    expect(prisma.agentTool.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'products.count' },
      create: expect.objectContaining({
        id: 'products.count',
        scope: 'products',
        risk: 'low',
        status: 'active',
      }),
    }));
    expect(prisma.agentToolPermission.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { toolId_roleId: { toolId: 'products.count', roleId: 'owner' } },
      create: expect.objectContaining({
        toolId: 'products.count',
        roleId: 'owner',
        access: 'execute',
        riskMode: 'direct',
      }),
    }));
  });

  it('queues learning and indexing jobs without blocking chat work (Prisma 持久化)', async () => {
    const jobsState: any[] = [];
    const prisma = {
      agentJob: {
        create: vi.fn(async ({ data }: any) => { jobsState.push({ ...data }); return { ...data, scheduledAt: new Date(), startedAt: null, completedAt: null, createdAt: new Date(), updatedAt: new Date() }; }),
        groupBy: vi.fn(async () => jobsState.reduce((acc: any[], j: any) => {
          const existing = acc.find(row => row.status === j.status);
          if (existing) existing._count._all += 1; else acc.push({ status: j.status, _count: { _all: 1 } });
          return acc;
        }, [])),
      },
    } as any;
    const jobs = createJobService(prisma);

    const job = await jobs.enqueue({ jobType: 'knowledge.index', payload: { documentId: 'doc-1' }, priority: 3 });

    expect(job).toMatchObject({ jobType: 'knowledge.index', status: 'queued', priority: 3 });
    expect(await jobs.stats()).toMatchObject({ queued: 1, running: 0, completed: 0, failed: 0 });
  });
});
