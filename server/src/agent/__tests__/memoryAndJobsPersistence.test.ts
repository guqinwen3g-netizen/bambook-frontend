import { describe, expect, it, vi } from 'vitest';
import { createMemoryService } from '../memory';
import { createJobService } from '../jobs';
import { createIdentityService } from '../identity';
import { buildAgentSystemPrompt } from '../llmPlanner';
import { createAgentLoop } from '../agentLoop';
import { executeAgentTool } from '../toolRuntime';
import { ToolDescriptor } from '../agentLoopTypes';

/**
 * 2026-08-19 批次1-1c 接线收口测试：
 *   - AgentMemory Prisma 持久化（scope 守卫 / personal-department 归属映射 / recall 过滤）
 *   - AgentJob Prisma 持久化 + 消费者执行器（claimNext 原子领取 / complete-fail 生命周期 / runPendingJobs）
 *   - 跨会话记忆注入系统提示词（buildAgentSystemPrompt + agentLoop memoryLoader）
 *   - memory.recall / memory.write 工具经 executeAgentTool actor 感知分发
 */

async function salesActor() {
  return createIdentityService().resolveActorContext({
    userId: 'u_sales_1',
    displayName: '销售一号',
    roles: ['sales'],
    departmentIds: ['dept_sales'],
  });
}

function makeMemoryPrisma() {
  const rows: any[] = [];
  return {
    rows,
    prisma: {
      agentMemory: {
        create: vi.fn(async ({ data }: any) => {
          const row = { ...data, createdAt: new Date(), updatedAt: new Date() };
          rows.push(row);
          return row;
        }),
        findMany: vi.fn(async ({ where, take }: any) =>
          rows.filter(m =>
            where.scope.in.includes(m.scope)
            && (where.status ? m.status === where.status : true)
            && (where.content?.contains ? m.content.includes(where.content.contains) : true)
          ).slice(0, take ?? 20)),
        count: vi.fn(async () => rows.length),
        groupBy: vi.fn(async () => Array.from(new Set(rows.map(r => r.scope))).map(scope => ({ scope }))),
      },
    } as any,
  };
}

describe('AgentMemory Prisma 持久化（批次1-1c）', () => {
  it('remember: scope 守卫 + personal/department 归属映射落列', async () => {
    const { prisma } = makeMemoryPrisma();
    const service = createMemoryService(prisma);
    const actor = await salesActor();

    const personal = await service.remember({ actor, scope: 'personal:u_sales_1', memoryType: 'preference', content: '喜欢中文摘要' });
    expect(personal).toMatchObject({ userId: 'u_sales_1', departmentId: null, status: 'active' });

    const department = await service.remember({ actor, scope: 'department:dept_sales', memoryType: 'process', content: '报价前确认客户等级' });
    expect(department).toMatchObject({ userId: null, departmentId: 'dept_sales' });

    // 越权 scope（role:finance 不在 sales actor 的 memoryScopes）→ 拒绝
    await expect(service.remember({ actor, scope: 'role:finance', memoryType: 'rule', content: 'x' }))
      .rejects.toThrow('MEMORY_SCOPE_NOT_ALLOWED');
    // 空 content → 拒绝
    await expect(service.remember({ actor, scope: 'company', memoryType: 'rule', content: '  ' }))
      .rejects.toThrow('MEMORY_CONTENT_REQUIRED');
  });

  it('recall: 只返回 actor.memoryScopes 内的活跃记忆；指定越权 scope 返回空', async () => {
    const { prisma, rows } = makeMemoryPrisma();
    const service = createMemoryService(prisma);
    const actor = await salesActor();

    rows.push(
      { scope: 'personal:u_sales_1', memoryType: 'preference', content: '喜欢中文摘要', status: 'active' },
      { scope: 'company', memoryType: 'rule', content: '高风险邮件需审批', status: 'active' },
      { scope: 'personal:u_sales_1', memoryType: 'fact', content: '已停用记忆', status: 'archived' },
      { scope: 'department:dept_finance', memoryType: 'rule', content: '财务部惯例', status: 'active' },
    );

    const all = await service.recall({ actor });
    expect(all).toHaveLength(2); // 不含 archived、不含 dept_finance（越权）

    const scoped = await service.recall({ actor, scope: 'company' });
    expect(scoped).toHaveLength(1);
    expect(scoped[0].content).toBe('高风险邮件需审批');

    // 越权指定 scope → 空结果（不抛错，fail-closed 静默）
    await expect(service.recall({ actor, scope: 'department:dept_finance' })).resolves.toHaveLength(0);
  });

  it('stats: 活跃记忆数与 scope 去重数', async () => {
    const { prisma, rows } = makeMemoryPrisma();
    const service = createMemoryService(prisma);
    rows.push(
      { scope: 'personal:u1', status: 'active' },
      { scope: 'company', status: 'active' },
      { scope: 'company', status: 'active' },
    );
    await expect(service.stats()).resolves.toEqual({ memories: 3, scopes: 2 });
  });
});

function makeJobPrisma() {
  const rows: any[] = [];
  const byId = () => {
    const map = new Map(rows.map(r => [r.id, r]));
    return (id: string) => map.get(id);
  };
  return {
    rows,
    getById: byId(),
    prisma: {
      agentJob: {
        create: vi.fn(async ({ data }: any) => {
          const row = { ...data, result: null, error: null, startedAt: null, completedAt: null, scheduledAt: new Date(), createdAt: new Date(), updatedAt: new Date() };
          rows.push(row);
          return row;
        }),
        findMany: vi.fn(async ({ where, orderBy, take }: any) =>
          rows.filter(r => r.status === where.status)
            .sort((a, b) => (a.priority - b.priority) || (a.scheduledAt.getTime() - b.scheduledAt.getTime()))
            .slice(0, take ?? 5)),
        updateMany: vi.fn(async ({ where, data }: any) => {
          const target = rows.find(r => r.id === where.id && r.status === where.status);
          if (!target) return { count: 0 };
          Object.assign(target, data);
          return { count: 1 };
        }),
        findUnique: vi.fn(async ({ where }: any) => rows.find(r => r.id === where.id) ?? null),
        update: vi.fn(async ({ where, data }: any) => {
          const target = rows.find(r => r.id === where.id);
          if (!target) throw new Error('not found');
          Object.assign(target, data);
          return target;
        }),
        groupBy: vi.fn(async () => rows.reduce((acc: any[], r: any) => {
          const existing = acc.find(row => row.status === r.status);
          if (existing) existing._count._all += 1; else acc.push({ status: r.status, _count: { _all: 1 } });
          return acc;
        }, [])),
      },
    } as any,
  };
}

describe('AgentJob Prisma 持久化 + 消费者执行器（批次1-1c）', () => {
  it('enqueue → claimNext 原子领取（priority 小者先）→ complete', async () => {
    const { prisma, rows } = makeJobPrisma();
    const jobs = createJobService(prisma);

    await jobs.enqueue({ jobType: 'b.low', payload: {}, priority: 9 });
    await jobs.enqueue({ jobType: 'a.high', payload: {}, priority: 1 });

    const claimed = await jobs.claimNext();
    expect(claimed).toMatchObject({ jobType: 'a.high', status: 'running' });

    await jobs.complete(claimed!.id, { ok: true });
    expect(rows.find(r => r.id === claimed!.id)).toMatchObject({ status: 'completed' });

    await expect(jobs.stats()).resolves.toMatchObject({ queued: 1, running: 0, completed: 1, failed: 0 });
  });

  it('claimNext：任务已被抢走（status 已变）→ 换下一个候选；队列空返回 null', async () => {
    const { prisma, rows } = makeJobPrisma();
    const jobs = createJobService(prisma);
    await jobs.enqueue({ jobType: 'x', payload: {} });

    // 模拟并发抢占：预改状态后 updateMany 命中 0
    rows[0].status = 'running';
    await expect(jobs.claimNext()).resolves.toBeNull();

    rows[0].status = 'completed';
    await expect(jobs.claimNext()).resolves.toBeNull();
  });

  it('runPendingJobs：成功/失败/未知类型三分支落库', async () => {
    const { prisma, rows } = makeJobPrisma();
    const jobs = createJobService(prisma);
    await jobs.enqueue({ jobType: 'known.ok', payload: { n: 1 } });
    await jobs.enqueue({ jobType: 'known.boom', payload: {} });
    await jobs.enqueue({ jobType: 'unknown.type', payload: {} });

    const summary = await jobs.runPendingJobs({
      'known.ok': async job => ({ doubled: (job.payload as any).n * 2 }),
      'known.boom': async () => { throw new Error('handler exploded'); },
    });

    expect(summary).toEqual({ processed: 3, completed: 1, failed: 2 });
    const byType = (type: string) => rows.find(r => r.jobType === type);
    expect(byType('known.ok')).toMatchObject({ status: 'completed', result: { doubled: 2 } });
    expect(byType('known.boom')).toMatchObject({ status: 'failed', error: 'handler exploded' });
    expect(byType('unknown.type')).toMatchObject({ status: 'failed', error: expect.stringContaining('UNKNOWN_JOB_TYPE') });
  });
});

describe('跨会话记忆注入系统提示词（批次1-1c）', () => {
  it('buildAgentSystemPrompt：有记忆渲染记忆段，无记忆不渲染', () => {
    const actor = {
      userId: 'u1', displayName: '测试', roles: ['sales'], departmentIds: ['sales'],
      permissionScopes: [], memoryScopes: ['personal:u1'], knowledgeScopes: [], toolScopes: [],
    } as any;
    const tools: ToolDescriptor[] = [{ id: 'memory.write', name: 'Write Memory', scope: 'memory', risk: 'low', description: '写记忆' }];

    const withMemories = buildAgentSystemPrompt({
      actor, tools, maxToolsPerStep: 3,
      memories: [{ scope: 'personal:u1', memoryType: 'preference', content: '喜欢中文摘要' }],
    });
    expect(withMemories).toContain('## 已知用户记忆（跨会话，个性化参考）');
    expect(withMemories).toContain('（personal:u1 · preference）喜欢中文摘要');
    expect(withMemories).toContain('memory.write');

    const withoutMemories = buildAgentSystemPrompt({ actor, tools, maxToolsPerStep: 3, memories: [] });
    expect(withoutMemories).not.toContain('已知用户记忆');
  });

  it('agentLoop：memoryLoader 注入的记忆进入 LLM systemPrompt；loader 异常降级为空不阻断', async () => {
    const capturedPrompts: string[] = [];
    const llm = vi.fn(async (input: any) => {
      capturedPrompts.push(input.systemPrompt);
      return JSON.stringify({ thought: '直接回答', action: 'final_answer', finalAnswer: '好的。' });
    });
    const toolExecutor = vi.fn();
    const loop = createAgentLoop({
      llm,
      toolExecutor,
      availableTools: [{ id: 'memory.recall', name: 'Recall Memories', scope: 'memory', risk: 'low', description: '读记忆' }],
      memoryLoader: async () => [{ scope: 'personal:u1', memoryType: 'rule', content: '给 Aurora 报价用 USD' }],
    });

    const actor = await salesActor();
    const result = await loop.run({
      actor,
      message: '你好',
      history: [],
      attachmentContext: [],
      signal: new AbortController().signal,
    } as any);

    expect(result.text).toBe('好的。');
    expect(capturedPrompts[0]).toContain('给 Aurora 报价用 USD');

    // loader 抛错 → 降级为空记忆，对话不中断
    const llm2 = vi.fn(async () => JSON.stringify({ thought: 'x', action: 'final_answer', finalAnswer: '降级OK' }));
    const loop2 = createAgentLoop({
      llm: llm2,
      toolExecutor,
      availableTools: [],
      memoryLoader: async () => { throw new Error('db down'); },
    });
    const result2 = await loop2.run({
      actor, message: '你好', history: [], attachmentContext: [],
      signal: new AbortController().signal,
    } as any);
    expect(result2.text).toBe('降级OK');
  });
});

describe('memory.recall / memory.write 工具 actor 感知分发（批次1-1c）', () => {
  it('memory.write：默认 personal scope 写入 + agent_tool 来源标记', async () => {
    const { prisma, rows } = makeMemoryPrisma();
    prisma.userAccount = { findFirst: vi.fn().mockResolvedValue(null) };
    prisma.agentTool = { upsert: vi.fn().mockResolvedValue({}) };
    prisma.agentToolPermission = { upsert: vi.fn().mockResolvedValue({}) };
    prisma.agentToolRun = { create: vi.fn().mockResolvedValue({ id: 'atr_1' }) };

    const actor = await salesActor();
    const output = await executeAgentTool({
      prisma,
      actor,
      toolId: 'memory.write',
      toolInput: { memoryType: 'rule', content: '给 Aurora 报价用 USD' },
      sessionId: 'sess_1',
    } as any);

    expect(output).toMatchObject({ ok: true, memory: { scope: 'personal:u_sales_1', memoryType: 'rule' } });
    expect(rows[0]).toMatchObject({
      scope: 'personal:u_sales_1',
      userId: 'u_sales_1',
      sourceType: 'agent_tool',
      sourceId: 'sess_1',
    });
  });

  it('memory.recall：返回记忆列表；越权 write scope 错误原样上抛', async () => {
    const { prisma, rows } = makeMemoryPrisma();
    rows.push({ scope: 'personal:u_sales_1', memoryType: 'preference', content: '喜欢中文摘要', status: 'active' });
    prisma.userAccount = { findFirst: vi.fn().mockResolvedValue(null) };
    prisma.agentTool = { upsert: vi.fn().mockResolvedValue({}) };
    prisma.agentToolPermission = { upsert: vi.fn().mockResolvedValue({}) };
    prisma.agentToolRun = { create: vi.fn().mockResolvedValue({ id: 'atr_1' }) };

    const actor = await salesActor();
    const recalled = await executeAgentTool({
      prisma, actor, toolId: 'memory.recall', toolInput: {},
    } as any);
    expect(recalled).toMatchObject({ ok: true, memories: [{ content: '喜欢中文摘要' }] });

    await expect(executeAgentTool({
      prisma, actor, toolId: 'memory.write',
      toolInput: { scope: 'department:dept_finance', memoryType: 'rule', content: '越权' },
    } as any)).rejects.toThrow('MEMORY_SCOPE_NOT_ALLOWED');
  });

  it('角色 toolScopes 无 memory（构造 viewer 之外的旁路角色不可达——所有角色已含 memory）→ 全角色可用', async () => {
    // identity ROLE_SCOPES 所有角色 tools 均含 'memory'（本批收口），抽两个角色验证
    const identity = createIdentityService();
    const viewer = await identity.resolveActorContext({ userId: 'v', roles: ['viewer'], departmentIds: ['company'] });
    const factory = await identity.resolveActorContext({ userId: 'f', roles: ['factory'], departmentIds: ['company'] });
    expect(viewer.toolScopes).toContain('memory');
    expect(factory.toolScopes).toContain('memory');
  });
});
