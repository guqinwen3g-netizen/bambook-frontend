/**
 * WorkflowEngine 单元测试
 *
 * 覆盖：
 *   1. createInstance — 从定义创建实例 + 所有步骤
 *   2. 幂等性 — 同实体+定义+running → 返回已有实例
 *   3. decideStep(approve) — 推进到下一步
 *   4. decideStep(approve last) — 完成实例
 *   5. decideStep(reject) — 终止实例
 *   6. cancelInstance — 取消实例
 *   7. listInstances — 过滤
 *   8. seedDefaultWorkflowDefinitions — seed 默认定义
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';

// Mock realtime 模块 — 避免真实 SSE 推送
vi.mock('../../realtime', () => ({
  publishNotificationEvent: vi.fn(),
}));

// Mock logger
vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { WorkflowEngine, seedDefaultWorkflowDefinitions, DEFAULT_WORKFLOW_DEFINITIONS } from '../workflowEngine';

// Storage seam only: transaction clones prove mock rollback, not PG locks or concurrency.
const INITIATOR = { userId: 'initiator_1', roles: [], permissions: [], departmentIds: [] };
const REVIEWER = { userId: 'user_1', roles: [], permissions: [], departmentIds: [] };
let requestSerial = 0;
const nextRequest = () => 'workflow-unit-' + ++requestSerial;
const grants = ['orders:read','orders:write','invoices:read','invoices:write','products:read','products:write','qc:garment_chain:write'];
async function stepCommand(engine: WorkflowEngine, instanceId: string, actor = REVIEWER) {
  const current = await engine.getInstance(instanceId, actor);
  return { actor, clientRequestId: nextRequest(), expectedStepId: current!.currentStepId!, expectedStepIndex: current!.currentStepIndex,
    sourceFingerprint: current!.sourceFingerprint!, confirmedReviewedContent: true };
}
function matches(row: any, where: any = {}): boolean {
  return Object.entries(where).every(([key, value]: [string, any]) => {
    if (key === 'AND') return (Array.isArray(value) ? value : [value]).every(condition => matches(row, condition));
    if (key === 'OR') return value.some((condition: any) => matches(row, condition));
    if (value && typeof value === 'object') {
      if ('in' in value) return value.in.includes(row[key]);
      if ('not' in value) return row[key] !== value.not;
    }
    return (row[key] ?? null) === (value ?? null);
  });
}
function makeMockPrisma(overrides: Record<string, any> = {}) {
  const users = [INITIATOR.userId, REVIEWER.userId].map(id => ({ id, displayName: 'Test User', status: 'active', deletedAt: null, primaryDeptId: null,
    roles: [id === REVIEWER.userId ? 'role-sales-manager' : 'role-finance', ...(id === REVIEWER.userId ? ['role-finance'] : [])].map(roleId => ({ departmentId: null,
      role: { id: roleId, permissions: grants.map(scope => ({ permission: { scope } })) } })) }));
  const data: Record<string, any[]> = { workflowDefinition: [], workflowInstance: [], workflowStep: [], auditLog: [], userAccount: users, userRole: [] };
  const prisma: any = { _mockData: data };
  const decorate = (row: any, include: any) => !row ? null : include?.steps ? { ...row,
    steps: data.workflowStep.filter(step => step.instanceId === row.id).sort((a, b) => a.stepIndex - b.stepIndex),
    definition: data.workflowDefinition.find(def => def.id === row.definitionId), initiator: data.userAccount.find(user => user.id === row.initiatedById) } : row;
  for (const name of Object.keys(data)) {
    prisma[name] = {
      findUnique: vi.fn(async ({ where, include }: any) => decorate(data[name].find(row => matches(row, where)), include)),
      findFirst: vi.fn(async ({ where, include }: any = {}) => decorate(data[name].find(row => matches(row, where)), include)),
      findMany: vi.fn(async ({ where, include, take, skip }: any = {}) => {
        const rows = data[name].filter(row => matches(row, where)).map(row => decorate(row, include));
        return rows.slice(skip || 0, take === undefined ? undefined : (skip || 0) + take);
      }),
      count: vi.fn(async ({ where }: any = {}) => data[name].filter(row => matches(row, where)).length),
      create: vi.fn(async ({ data: input, include }: any) => {
        const row = { createdAt: new Date(), updatedAt: new Date(), completedAt: null, decisionNote: null, decidedById: null, decidedAt: null, ...input };
        data[name].push(row);
        for (const step of input.steps?.create || []) data.workflowStep.push({ instanceId: row.id, createdAt: new Date(), decisionNote: null, decidedById: null, decidedAt: null, ...step });
        return decorate(row, include);
      }),
      updateMany: vi.fn(async ({ where, data: patch }: any) => {
        const rows = data[name].filter(row => matches(row, where)); rows.forEach(row => Object.assign(row, patch)); return { count: rows.length };
      }),
      update: vi.fn(async ({ where, data: patch }: any) => { const row = data[name].find(row => matches(row, where)); Object.assign(row, patch); return row; }),
    };
  }
  prisma.order = { findFirst: vi.fn(async ({ where }: any) => ({ id: where.id, deletedAt: null, ownerId: INITIATOR.userId, quantity: 10, status: 'Pending', quoteAmount: '100.0000', currency: 'USD' })) };
  prisma.orderLine = { findMany: vi.fn(async () => []) };
  prisma.role = { findUnique: vi.fn(async ({ where }: any) => ['role-sales-manager','role-finance','role-qc'].includes(where.id) ? { id: where.id } : null) };
  prisma.userPermissionOverrides = { findMany: vi.fn(async () => []) };
  prisma.$queryRaw = vi.fn(async () => [{ id: 'synthetic-locked-row' }]);
  prisma.notification = { create: vi.fn(async () => ({})), createMany: vi.fn(async () => ({ count: 0 })) };
  prisma.$transaction = vi.fn(async (fn: any) => {
    const before = structuredClone(data);
    try { return await fn(prisma); } catch (error) { for (const key of Object.keys(before)) data[key] = before[key]; throw error; }
  });
  return Object.assign(prisma, overrides);
}

// ── 测试用定义 ──
const TEST_DEFINITION = {
  id: 'wf_def_test',
  name: '测试审批流',
  description: '两步审批',
  entityType: 'Order',
  triggerEvent: null,
  steps: [
    { name: '销售经理审批', approverRole: 'manager' },
    { name: '财务审批', approverRole: 'finance' },
  ],
  version: 1,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('WorkflowEngine', () => {
  let prisma: any;
  let engine: WorkflowEngine;

  beforeEach(() => {
    prisma = makeMockPrisma();
    // 预置测试定义
    prisma._mockData.workflowDefinition.push({ ...TEST_DEFINITION });
    engine = new WorkflowEngine(prisma);
  });

  describe('createInstance', () => {
    it('creates instance with all steps from definition', async () => {
      const instance = await engine.createInstance({ actor: INITIATOR, clientRequestId: nextRequest(),
        definitionId: 'wf_def_test',
        entityType: 'Order',
        entityId: 'ord_123',
        title: '订单 #123 审批',
        initiatedById: INITIATOR.userId,
      });

      expect(instance.id).toBeDefined();
      expect(instance.status).toBe('running');
      expect(instance.currentStepIndex).toBe(0);
      expect(instance.steps).toHaveLength(2);
      expect(instance.steps[0].stepName).toBe('销售经理审批');
      expect(instance.steps[0].decision).toBeNull();
      expect(instance.steps[1].stepName).toBe('财务审批');
    });

    it('returns existing instance for same entity + definition (idempotent)', async () => {
      const first = await engine.createInstance({ actor: INITIATOR, clientRequestId: nextRequest(),
        definitionId: 'wf_def_test',
        entityType: 'Order',
        entityId: 'ord_456',
      });

      const second = await engine.createInstance({ actor: INITIATOR, clientRequestId: nextRequest(),
        definitionId: 'wf_def_test',
        entityType: 'Order',
        entityId: 'ord_456',
      });

      expect(second.id).toBe(first.id);
    });

    it('throws for non-existent definition', async () => {
      await expect(engine.createInstance({ actor: INITIATOR, clientRequestId: nextRequest(),
        definitionId: 'nonexistent',
        entityType: 'Order',
        entityId: 'ord_1',
      })).rejects.toThrow('不存在');
    });
  });

  describe('decideStep', () => {
    it('advances to next step on approve', async () => {
      const instance = await engine.createInstance({ actor: INITIATOR, clientRequestId: nextRequest(),
        definitionId: 'wf_def_test',
        entityType: 'Order',
        entityId: 'ord_approve_1',
        initiatedById: INITIATOR.userId,
      });

      const result = await engine.decideStep({ ...await stepCommand(engine, instance.id), instanceId: instance.id,
        decidedById: 'user_1',
        decision: 'approved',
        note: '同意',
      });

      expect(result.status).toBe('running');
      expect(result.currentStepIndex).toBe(1);
      // 第一步已决策
      expect(result.steps[0].decision).toBe('approved');
      expect(result.steps[0].decisionNote).toBe('同意');
    });

    it('completes instance when last step approved', async () => {
      const instance = await engine.createInstance({ actor: INITIATOR, clientRequestId: nextRequest(),
        definitionId: 'wf_def_test',
        entityType: 'Order',
        entityId: 'ord_complete_1',
        initiatedById: INITIATOR.userId,
      });

      // 审批第一步
      await engine.decideStep({ ...await stepCommand(engine, instance.id), instanceId: instance.id,
        decidedById: 'user_1',
        decision: 'approved',
      });

      // 审批第二步（最后一步）
      const result = await engine.decideStep({ ...await stepCommand(engine, instance.id), instanceId: instance.id,
        decidedById: 'user_1',
        decision: 'approved',
      });

      expect(result.status).toBe('approved');
      expect(result.completedAt).not.toBeNull();
    });

    it('terminates instance on reject', async () => {
      const instance = await engine.createInstance({ actor: INITIATOR, clientRequestId: nextRequest(),
        definitionId: 'wf_def_test',
        entityType: 'Order',
        entityId: 'ord_reject_1',
        initiatedById: INITIATOR.userId,
      });

      const result = await engine.decideStep({ ...await stepCommand(engine, instance.id), instanceId: instance.id,
        decidedById: 'user_1',
        decision: 'rejected',
        rejectionReason: '价格不合理', requestedChanges: '按客户确认版本重新核价', note: '补充市场参考价',
      });

      expect(result.status).toBe('rejected');
      expect(result.completedAt).not.toBeNull();
      expect(result.steps[0].decision).toBe('rejected');
      expect(result.steps[0].decisionNote).toBe('驳回原因：价格不合理\n需要修改的内容：按客户确认版本重新核价\n补充说明：补充市场参考价');
    });

    it('throws for non-running instance', async () => {
      const instance = await engine.createInstance({ actor: INITIATOR, clientRequestId: nextRequest(),
        definitionId: 'wf_def_test',
        entityType: 'Order',
        entityId: 'ord_status_1',
      });

      // 先驳回
      await engine.decideStep({ ...await stepCommand(engine, instance.id), instanceId: instance.id,
        decidedById: 'user_1',
        decision: 'rejected',
        rejectionReason: '需补资料', requestedChanges: '补交订单来源文件',
      });

      // 再尝试审批 → 应报错
      await expect(engine.decideStep({ ...await stepCommand(engine, instance.id), instanceId: instance.id,
        decidedById: 'user_1',
        decision: 'approved',
      })).rejects.toThrow('无法审批');
    });
  });

  describe('cancelInstance', () => {
    it('cancels a running instance', async () => {
      const instance = await engine.createInstance({ actor: INITIATOR, clientRequestId: nextRequest(),
        definitionId: 'wf_def_test',
        entityType: 'Order',
        entityId: 'ord_cancel_1',
      });

      const result = await engine.cancelInstance(instance.id, '不再需要', await stepCommand(engine, instance.id, INITIATOR));
      expect(result.status).toBe('cancelled');
    });

    it('throws for non-running instance', async () => {
      const instance = await engine.createInstance({ actor: INITIATOR, clientRequestId: nextRequest(),
        definitionId: 'wf_def_test',
        entityType: 'Order',
        entityId: 'ord_cancel_2',
      });

      await engine.cancelInstance(instance.id, undefined, await stepCommand(engine, instance.id, INITIATOR));

      await expect(engine.cancelInstance(instance.id, undefined, await stepCommand(engine, instance.id, INITIATOR))).rejects.toThrow('无法取消');
    });
  });

  describe('listInstances', () => {
    it('filters by status', async () => {
      // 创建两个实例，一个通过一个运行中
      const inst1 = await engine.createInstance({ actor: INITIATOR, clientRequestId: nextRequest(),
        definitionId: 'wf_def_test',
        entityType: 'Order',
        entityId: 'ord_list_1',
      });
      const inst2 = await engine.createInstance({ actor: INITIATOR, clientRequestId: nextRequest(),
        definitionId: 'wf_def_test',
        entityType: 'Order',
        entityId: 'ord_list_2',
      });
      // inst1 通过
      await engine.decideStep({ ...await stepCommand(engine, inst1.id), instanceId: inst1.id, decidedById: 'user_1', decision: 'approved' });
      await engine.decideStep({ ...await stepCommand(engine, inst1.id), instanceId: inst1.id, decidedById: 'user_1', decision: 'approved' });

      const running = await engine.listInstances({ actor: INITIATOR, status: 'running' });
      const approved = await engine.listInstances({ actor: INITIATOR, status: 'approved' });

      expect(running.items.some(i => i.id === inst2.id)).toBe(true);
      expect(running.items.some(i => i.id === inst1.id)).toBe(false);
      expect(approved.items.some(i => i.id === inst1.id)).toBe(true);
    });

    it('filters by entity type + id', async () => {
      await engine.createInstance({ actor: INITIATOR, clientRequestId: nextRequest(),
        definitionId: 'wf_def_test',
        entityType: 'Order',
        entityId: 'ord_entity_1',
      });

      const result = await engine.listInstances({ actor: INITIATOR, entityType: 'Order', entityId: 'ord_entity_1' });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].entityId).toBe('ord_entity_1');
    });
  });

  describe('getInstancesForEntity', () => {
    it('returns all workflows for an entity', async () => {
      await engine.createInstance({ actor: INITIATOR, clientRequestId: nextRequest(),
        definitionId: 'wf_def_test',
        entityType: 'Order',
        entityId: 'ship_1',
      });

      const instances = await engine.getInstancesForEntity('Order', 'ship_1', INITIATOR);
      expect(instances).toHaveLength(1);
      expect(instances[0].entityType).toBe('Order');
    });
  });

  describe('listDefinitions', () => {
    it('returns active definitions', async () => {
      const defs = await engine.listDefinitions(INITIATOR);
      expect(defs).toHaveLength(1);
      expect(defs[0].id).toBe('wf_def_test');
    });
  });
});

describe('seedDefaultWorkflowDefinitions', () => {
  it('seeds default definitions that do not exist yet', async () => {
    const prisma = makeMockPrisma();
    await seedDefaultWorkflowDefinitions(prisma);

    // 默认定义应被创建
    const createdIds = prisma._mockData.workflowDefinition.map((d: any) => d.id);
    for (const def of DEFAULT_WORKFLOW_DEFINITIONS) {
      expect(createdIds).toContain(def.id);
    }
  });

  it('skips definitions that already exist', async () => {
    const prisma = makeMockPrisma();
    // 预置一个已存在的定义
    prisma._mockData.workflowDefinition.push({ id: DEFAULT_WORKFLOW_DEFINITIONS[0].id, name: 'existing' });

    const beforeCount = prisma._mockData.workflowDefinition.length;
    await seedDefaultWorkflowDefinitions(prisma);

    // 不应重复创建
    const duplicates = prisma._mockData.workflowDefinition.filter((d: any) => d.id === DEFAULT_WORKFLOW_DEFINITIONS[0].id);
    expect(duplicates).toHaveLength(1);
  });
});

describe('workflow authorization and mandatory storage contract (not PG evidence)', () => {
  async function running() {
    const prisma = makeMockPrisma(); prisma._mockData.workflowDefinition.push({ ...TEST_DEFINITION });
    const engine = new WorkflowEngine(prisma);
    const instance = await engine.createInstance({ actor: INITIATOR, clientRequestId: nextRequest(), definitionId: TEST_DEFINITION.id, entityType: 'Order', entityId: 'security-order' });
    return { prisma, engine, instance };
  }
  it('rejects missing identity and missing stable ID before creation', async () => {
    const { prisma, engine } = await running(), count = prisma._mockData.workflowInstance.length;
    await expect(engine.createInstance({ definitionId: TEST_DEFINITION.id, entityType: 'Order', entityId: 'other' })).rejects.toMatchObject({ code: 'UNAUTHORIZED', statusCode: 401 });
    await expect(engine.createInstance({ actor: INITIATOR, definitionId: TEST_DEFINITION.id, entityType: 'Order', entityId: 'other' })).rejects.toMatchObject({ code: 'INVALID_INPUT', statusCode: 400 });
    expect(prisma._mockData.workflowInstance).toHaveLength(count);
  });
  it('rejects mismatched Shipment identity without writes', async () => {
    const { prisma, engine } = await running(), before = structuredClone(prisma._mockData);
    await expect(engine.createInstance({ actor: INITIATOR, clientRequestId: nextRequest(), definitionId: TEST_DEFINITION.id, entityType: 'Shipment', entityId: 'shipment' })).rejects.toMatchObject({ code: 'INVALID_INPUT', statusCode: 400 });
    expect(prisma._mockData).toEqual(before);
  });
  it('rejects ordinary self approval and signed permission ceiling', async () => {
    const { engine, instance } = await running();
    await expect(engine.decideStep({ ...await stepCommand(engine, instance.id, INITIATOR), instanceId: instance.id, decidedById: INITIATOR.userId, decision: 'approved' })).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    await expect(engine.decideStep({ ...await stepCommand(engine, instance.id), actor: { ...REVIEWER, permissionCeiling: ['orders:read'] }, instanceId: instance.id, decidedById: REVIEWER.userId, decision: 'approved' })).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    expect((await engine.getInstance(instance.id, INITIATOR))?.status).toBe('running');
  });
  it('replays an exact decision acknowledgement but rejects same key changed note', async () => {
    const { engine, instance } = await running();
    const command = { ...await stepCommand(engine, instance.id), instanceId: instance.id, decidedById: REVIEWER.userId, decision: 'approved' as const, note: 'original' };
    const first = await engine.decideStep(command), second = await engine.decideStep(command);
    expect(second.acknowledgement).toEqual(first.acknowledgement); expect(second.currentStepIndex).toBe(1);
    await expect(engine.decideStep({ ...command, note: 'changed' })).rejects.toMatchObject({ code: 'CONFLICT', statusCode: 409 });
  });
  it('requires explicit review acknowledgment for a new decision and writes nothing when absent', async () => {
    const { prisma, engine, instance } = await running();
    const command = { ...await stepCommand(engine, instance.id), instanceId: instance.id, decidedById: REVIEWER.userId, decision: 'approved' as const };
    delete (command as any).confirmedReviewedContent;
    const before = structuredClone(prisma._mockData);
    await expect(engine.decideStep(command)).rejects.toMatchObject({ code: 'REVIEW_CONFIRMATION_REQUIRED', statusCode: 400 });
    expect(prisma._mockData).toEqual(before);
  });
  it('rolls mock storage back when the mandatory decision audit fails', async () => {
    const { prisma, engine, instance } = await running(); const original = prisma.auditLog.create;
    prisma.auditLog.create = vi.fn(async (input: any) => { if (input.data.action === 'workflow_approve') throw Error('storage unavailable'); return original(input); });
    const before = structuredClone(prisma._mockData);
    await expect(engine.decideStep({ ...await stepCommand(engine, instance.id), instanceId: instance.id, decidedById: REVIEWER.userId, decision: 'approved' })).rejects.toThrow('storage unavailable');
    expect(prisma._mockData).toEqual(before);
  });
  it('never approves legacy rows with no complete source fact', async () => {
    const { prisma, engine, instance } = await running(); prisma._mockData.auditLog = [];
    const current = await engine.getInstance(instance.id, INITIATOR);
    expect(current?.allowedActions.approve).toBe(false); expect(current?.blockedReason).toContain('重新发起');
    await expect(engine.decideStep({ ...await stepCommand(engine, instance.id), instanceId: instance.id, decidedById: REVIEWER.userId, decision: 'approved' })).rejects.toMatchObject({ code: 'CONFLICT', statusCode: 409 });
  });
});
