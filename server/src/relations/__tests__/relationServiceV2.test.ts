/**
 * relationServiceV2 单测
 * 覆盖：listRelations/getRelation/createRelation/updateRelation/deleteRelation
 *       + getSalesFunnel/changeStage/get360View/batchChangeStage
 *       + 行级权限 scope + 字典校验 + 配置默认值
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── mock 依赖 ──
vi.mock('../../auth/permissionService', () => ({
  createPermissionService: vi.fn(() => ({
    getDataScopeResolver: vi.fn().mockResolvedValue({ rule: { kind: 'all' }, allowedDepartmentIds: [], allowedUserIds: [] }),
  })),
}));

vi.mock('../../sequence/sequenceService', () => ({
  createSequenceService: vi.fn(() => ({
    nextNumber: vi.fn().mockResolvedValue('CUS-00001'),
  })),
}));

vi.mock('../../dictionaries/dataDictionaryService', () => ({
  getDataDictionaryService: vi.fn(() => ({
    getEntries: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('../../config/systemConfigService', () => ({
  getSystemConfigService: vi.fn(() => ({
    getString: vi.fn().mockResolvedValue('CNY'),
  })),
}));

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

// mock relationMutationService 的纯函数
vi.mock('../relationMutationService', () => ({
  toRelationDbPayload: vi.fn((input: any) => ({ ...input, id: input.id || `REL-${Date.now()}` })),
  toRelationUpdatePayload: vi.fn((input: any) => ({ ...input })),
  serializeRelation: vi.fn((row: any) => {
    const out: any = { ...row };
    for (const k of Object.keys(out)) {
      if (typeof out[k] === 'bigint') out[k] = Number(out[k]);
    }
    return out;
  }),
  VALID_RELATION_CATEGORIES: new Set(['Customer', 'Supplier', 'Agent', 'Partner', 'Government', 'Internal', 'Other']),
}));

import { createRelationServiceV2 } from '../relationServiceV2';

// ── helpers ──
function dec(v: number | string) {
  return { toString: () => String(v) };
}

const ACTOR = { userId: 'user_1', departmentIds: ['dept_1'], role: 'admin' } as any;

function makeRelation(overrides: any = {}) {
  return {
    id: 'REL__1',
    code: 'CUS-00001',
    name: 'Peerless',
    category: 'Customer',
    stage: 'Customer',
    tier: 'A',
    isOrganization: true,
    ownerId: 'user_1',
    departmentId: 'dept_1',
    deletedAt: null,
    createdAt: BigInt(0),
    updatedAt: BigInt(0),
    salesRepIds: ['user_1'],
    ...overrides,
  };
}

function makePrisma(overrides: {
  findMany?: any;
  count?: any;
  findFirst?: any;
  upsert?: any;
  update?: any;
  updateMany?: any;
  teamMemberFindMany?: any;
  teamGrantFindMany?: any;
} = {}) {
  return {
    relation: {
      findMany: overrides.findMany ?? vi.fn().mockResolvedValue([makeRelation()]),
      count: overrides.count ?? vi.fn().mockResolvedValue(1),
      findFirst: overrides.findFirst ?? vi.fn().mockResolvedValue(makeRelation()),
      upsert: overrides.upsert ?? vi.fn().mockImplementation(async ({ where, create }: any) => ({ ...create, id: where.id })),
      update: overrides.update ?? vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data })),
      // 级联软删子联系人（A7 修复）：默认无子联系人（count=0）
      updateMany: overrides.updateMany ?? vi.fn().mockResolvedValue({ count: 0 }),
    },
    // DR-042 小组共享依赖模型（默认：不在任何组、无授权）
    teamMember: {
      findMany: overrides.teamMemberFindMany ?? vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    team: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    teamDataGrant: {
      findMany: overrides.teamGrantFindMany ?? vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    order: { findMany: vi.fn().mockResolvedValue([]) },
    invoice: { findMany: vi.fn().mockResolvedValue([]) },
    paymentVoucher: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(async (fn: any) => fn({})),
  } as any;
}

beforeEach(() => { vi.clearAllMocks(); });

// ═══════════════════════════════════════════════════════════════
// listRelations
// ═══════════════════════════════════════════════════════════════

describe('listRelations 客户列表', () => {
  it('成功返回分页列表', async () => {
    const prisma = makePrisma();
    const svc = createRelationServiceV2(prisma);
    const r = await svc.listRelations(ACTOR, { limit: 10, offset: 0 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.items).toHaveLength(1);
      expect(r.data.total).toBe(1);
    }
  });

  it('筛选条件透传', async () => {
    const prisma = makePrisma();
    const svc = createRelationServiceV2(prisma);
    await svc.listRelations(ACTOR, { category: 'Customer', stage: 'Lead', tier: 'A', search: 'Peerless' });
    const where = prisma.relation.findMany.mock.calls[0][0].where;
    expect(where.category).toBe('Customer');
    expect(where.stage).toBe('Lead');
    expect(where.tier).toBe('A');
    expect(where.OR).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// getRelation
// ═══════════════════════════════════════════════════════════════

describe('getRelation 客户详情', () => {
  it('存在 → 返回数据', async () => {
    const prisma = makePrisma();
    const svc = createRelationServiceV2(prisma);
    const r = await svc.getRelation(ACTOR, 'REL__1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.id).toBe('REL__1');
  });

  it('不存在 → NOT_FOUND', async () => {
    const prisma = makePrisma({ findFirst: vi.fn().mockResolvedValue(null) });
    const svc = createRelationServiceV2(prisma);
    const r = await svc.getRelation(ACTOR, 'NOPE');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
  });
});

// ═══════════════════════════════════════════════════════════════
// createRelation
// ═══════════════════════════════════════════════════════════════

describe('createRelation 创建客户', () => {
  it('未登录 → UNAUTHORIZED', async () => {
    const prisma = makePrisma();
    const svc = createRelationServiceV2(prisma);
    const r = await svc.createRelation(null, { name: 'Test', category: 'Customer' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('UNAUTHORIZED');
  });

  it('name 为空 → VALIDATION_FAILED', async () => {
    const prisma = makePrisma();
    const svc = createRelationServiceV2(prisma);
    const r = await svc.createRelation(ACTOR, { name: '', category: 'Customer' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('VALIDATION_FAILED');
  });

  it('非法 category → VALIDATION_FAILED', async () => {
    const prisma = makePrisma();
    const svc = createRelationServiceV2(prisma);
    const r = await svc.createRelation(ACTOR, { name: 'Test', category: 'InvalidCategory' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('VALIDATION_FAILED');
  });

  it('成功创建 Customer（自动编号 CUS-00001 + ownerId 自动填充）', async () => {
    const prisma = makePrisma();
    const svc = createRelationServiceV2(prisma);
    const r = await svc.createRelation(ACTOR, { name: 'Peerless', category: 'Customer' });
    expect(r.ok).toBe(true);
    expect(prisma.relation.upsert).toHaveBeenCalledTimes(1);
    const upsertCall = prisma.relation.upsert.mock.calls[0][0];
    expect(upsertCall.create.code).toBe('CUS-00001');
    expect(upsertCall.create.ownerId).toBe('user_1');
    expect(upsertCall.create.stage).toBe('Customer');
  });

  it('Supplier 类型生成 supplier 编号', async () => {
    const prisma = makePrisma();
    const svc = createRelationServiceV2(prisma);
    await svc.createRelation(ACTOR, { name: 'Factory A', category: 'Supplier' });
    const upsertCall = prisma.relation.upsert.mock.calls[0][0];
    // seqType='supplier'，nextNumber mock 返回 CUS-00001（共用 mock，实际编号由 sequenceService 决定）
    expect(upsertCall.create.code).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════
// updateRelation
// ═══════════════════════════════════════════════════════════════

describe('updateRelation 更新客户', () => {
  it('未登录 → UNAUTHORIZED', async () => {
    const prisma = makePrisma();
    const svc = createRelationServiceV2(prisma);
    const r = await svc.updateRelation(null, 'REL__1', { stage: 'Key' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('UNAUTHORIZED');
  });

  it('不存在 → NOT_FOUND', async () => {
    const prisma = makePrisma({ findFirst: vi.fn().mockResolvedValue(null) });
    const svc = createRelationServiceV2(prisma);
    const r = await svc.updateRelation(ACTOR, 'NOPE', { stage: 'Key' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
  });

  it('成功更新 stage/tier', async () => {
    const prisma = makePrisma();
    const svc = createRelationServiceV2(prisma);
    const r = await svc.updateRelation(ACTOR, 'REL__1', { stage: 'Key', tier: 'S' });
    expect(r.ok).toBe(true);
    const updateCall = prisma.relation.update.mock.calls[0][0];
    expect(updateCall.data.stage).toBe('Key');
    expect(updateCall.data.tier).toBe('S');
  });

  it('成功更新 reportsToId（组织架构拖拽汇报线持久化 A2）', async () => {
    const prisma = makePrisma();
    const svc = createRelationServiceV2(prisma);
    const r = await svc.updateRelation(ACTOR, 'REL__1', { reportsToId: 'REL__BOSS' });
    expect(r.ok).toBe(true);
    const updateCall = prisma.relation.update.mock.calls[0][0];
    expect(updateCall.data.reportsToId).toBe('REL__BOSS');
  });

  it('reportsToId 置 null（拖到组织根清空汇报线）', async () => {
    const prisma = makePrisma();
    const svc = createRelationServiceV2(prisma);
    const r = await svc.updateRelation(ACTOR, 'REL__1', { reportsToId: null });
    expect(r.ok).toBe(true);
    const updateCall = prisma.relation.update.mock.calls[0][0];
    expect(updateCall.data.reportsToId).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// deleteRelation
// ═══════════════════════════════════════════════════════════════

describe('deleteRelation 软删除客户', () => {
  it('未登录 → UNAUTHORIZED', async () => {
    const prisma = makePrisma();
    const svc = createRelationServiceV2(prisma);
    const r = await svc.deleteRelation(null, 'REL__1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('UNAUTHORIZED');
  });

  it('不存在 → NOT_FOUND', async () => {
    const prisma = makePrisma({ findFirst: vi.fn().mockResolvedValue(null) });
    const svc = createRelationServiceV2(prisma);
    const r = await svc.deleteRelation(ACTOR, 'NOPE');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
  });

  it('成功 → deletedAt 落库', async () => {
    const prisma = makePrisma();
    const svc = createRelationServiceV2(prisma);
    const r = await svc.deleteRelation(ACTOR, 'REL__1');
    expect(r.ok).toBe(true);
    const updateCall = prisma.relation.update.mock.calls[0][0];
    expect(updateCall.data.deletedAt).toBeDefined();
  });

  it('组织删除 → 级联软删子联系人并返回 cascadedContactIds', async () => {
    // A7 修复：组织删除后其下联系人（parentId 指向该组织）必须级联软删，
    // 否则残留 UI 不可达的孤儿脏数据
    const prisma = makePrisma({
      updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      findMany: vi.fn().mockResolvedValue([{ id: 'C1' }, { id: 'C2' }]),
    });
    const svc = createRelationServiceV2(prisma);
    const r = await svc.deleteRelation(ACTOR, 'REL__ORG');
    expect(r.ok).toBe(true);
    const cascadeCall = prisma.relation.updateMany.mock.calls[0][0];
    expect(cascadeCall.where.parentId).toBe('REL__ORG');
    expect(cascadeCall.where.deletedAt).toBeNull();
    expect(cascadeCall.data.deletedAt).toBeDefined();
    if (r.ok) expect(r.data.cascadedContactIds).toEqual(['C1', 'C2']);
  });
});

// ═══════════════════════════════════════════════════════════════
// getSalesFunnel
// ═══════════════════════════════════════════════════════════════

describe('getSalesFunnel 销售漏斗聚合', () => {
  it('按 stage 分组 count', async () => {
    const prisma = makePrisma({
      findMany: vi.fn().mockResolvedValue([
        { stage: 'Lead' }, { stage: 'Lead' }, { stage: 'Customer' }, { stage: 'Key' },
      ]),
    });
    const svc = createRelationServiceV2(prisma);
    const r = await svc.getSalesFunnel(ACTOR, { category: 'Customer' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.total).toBe(4);
      const lead = r.data.stages.find((s: any) => s.stage === 'Lead');
      expect(lead.count).toBe(2);
    }
  });

  it('tier 筛选透传', async () => {
    const prisma = makePrisma({ findMany: vi.fn().mockResolvedValue([]) });
    const svc = createRelationServiceV2(prisma);
    await svc.getSalesFunnel(ACTOR, { category: 'Customer', tier: 'A' });
    const where = prisma.relation.findMany.mock.calls[0][0].where;
    expect(where.tier).toBe('A');
    expect(where.category).toBe('Customer');
  });
});

// ═══════════════════════════════════════════════════════════════
// changeStage
// ═══════════════════════════════════════════════════════════════

describe('changeStage 单个阶段变更', () => {
  it('未登录 → UNAUTHORIZED', async () => {
    const prisma = makePrisma();
    const svc = createRelationServiceV2(prisma);
    const r = await svc.changeStage(null, 'REL__1', 'Key');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('UNAUTHORIZED');
  });

  it('不存在 → NOT_FOUND', async () => {
    const prisma = makePrisma({ findFirst: vi.fn().mockResolvedValue(null) });
    const svc = createRelationServiceV2(prisma);
    const r = await svc.changeStage(ACTOR, 'NOPE', 'Key');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
  });

  it('成功 → stage + lastInteraction 更新', async () => {
    const prisma = makePrisma();
    const svc = createRelationServiceV2(prisma);
    const r = await svc.changeStage(ACTOR, 'REL__1', 'Key');
    expect(r.ok).toBe(true);
    const updateCall = prisma.relation.update.mock.calls[0][0];
    expect(updateCall.data.stage).toBe('Key');
    expect(updateCall.data.lastInteraction).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// get360View
// ═══════════════════════════════════════════════════════════════

describe('get360View 360°客户视图', () => {
  it('不存在 → NOT_FOUND', async () => {
    const prisma = makePrisma({ findFirst: vi.fn().mockResolvedValue(null) });
    const svc = createRelationServiceV2(prisma);
    const r = await svc.get360View(ACTOR, 'NOPE');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
  });

  it('成功聚合跨域数据', async () => {
    const prisma = makePrisma();
    prisma.relation.findFirst.mockResolvedValue({
      ...makeRelation(),
      contacts: [{ id: 'CON__1', isPrimary: true, name: 'John' }],
      creditLimits: [{ id: 'CL__1', status: 'active', limitAmount: dec(50000) }],
      followUpRecords: [{ id: 'FU__1', followUpAt: '2026-08-01', nextFollowUpAt: null }],
      opportunities: [{ id: 'OPP__1', stage: 'Proposal' }],
      customerTiers: [{ id: 'CT__1', status: 'active', tier: 'A' }],
      factoryProfile: null,
    });
    prisma.order.findMany.mockResolvedValue([
      { id: 'ORD__1', code: 'SO-1', status: 'Confirmed', quoteAmount: dec(10000) },
    ]);
    prisma.invoice.findMany.mockResolvedValue([
      { id: 'INV__1', type: 'Receivable', amount: dec(5000), currency: 'USD' },
    ]);
    prisma.paymentVoucher.findMany.mockResolvedValue([
      { id: 'PAY__1', type: 'Receipt', amount: dec(3000), currency: 'USD' },
    ]);
    const svc = createRelationServiceV2(prisma);
    const r = await svc.get360View(ACTOR, 'REL__1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.relation).toBeDefined();
      expect(r.data.contacts).toHaveLength(1);
      expect(r.data.orders).toHaveLength(1);
      expect(r.data.summary.orderCount).toBe(1);
      expect(r.data.summary.arTotal).toBe(5000);
      expect(r.data.summary.receiptTotal).toBe(3000);
      expect(r.data.summary.outstanding).toBe(2000);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// batchChangeStage
// ═══════════════════════════════════════════════════════════════

describe('batchChangeStage 批量阶段变更', () => {
  it('未登录 → UNAUTHORIZED', async () => {
    const prisma = makePrisma();
    const svc = createRelationServiceV2(prisma);
    const r = await svc.batchChangeStage(null, ['REL__1'], 'Key');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('UNAUTHORIZED');
  });

  it('全部成功 → updated=3, failed=0', async () => {
    const prisma = makePrisma();
    const svc = createRelationServiceV2(prisma);
    const r = await svc.batchChangeStage(ACTOR, ['REL__1', 'REL__2', 'REL__3'], 'Key');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.updated).toBe(3);
      expect(r.data.failed).toBe(0);
    }
  });

  it('部分不存在 → updated=1, failed=2', async () => {
    const prisma = makePrisma({
      findFirst: vi.fn()
        .mockResolvedValueOnce(makeRelation({ id: 'REL__1' }))
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null),
    });
    const svc = createRelationServiceV2(prisma);
    const r = await svc.batchChangeStage(ACTOR, ['REL__1', 'REL__2', 'REL__3'], 'Key');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.updated).toBe(1);
      expect(r.data.failed).toBe(2);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// DR-042 小组数据共享（设计真源：docs/design/03-业务规则/小组与业务数据共享.md v2）
// ═══════════════════════════════════════════════════════════════

import { createPermissionService } from '../../auth/permissionService';
import { __clearTeamShareCacheForTests } from '../../teams/teamShareService';

describe('DR-042 buildScopeWhere 读/写 scope 分离', () => {
  beforeEach(() => { __clearTeamShareCacheForTests(); });

  function useDepartmentRule() {
    vi.mocked(createPermissionService).mockImplementation((() => ({
      getDataScopeResolver: vi.fn().mockResolvedValue({
        rule: { kind: 'department', own: true },
        allowedDepartmentIds: ['dept_1'],
        allowedUserIds: ['user_1'],
      }),
    })) as any);
  }

  function useAllRule() {
    vi.mocked(createPermissionService).mockImplementation((() => ({
      getDataScopeResolver: vi.fn().mockResolvedValue({ rule: { kind: 'all' } }),
    })) as any);
  }

  it('T-33/T-34：读 scope = 图书馆（normal 全查 + confidential 仅跟进人，L1 不消费组授权）', async () => {
    useDepartmentRule();
    const prisma = makePrisma({
      teamMemberFindMany: vi.fn().mockResolvedValue([{ teamId: 'team_1' }]),
      teamGrantFindMany: vi.fn().mockResolvedValue([{ entityId: 'REL__TEAM' }]),
    });
    const svc = createRelationServiceV2(prisma);
    const where = await svc.buildScopeWhere(ACTOR);
    const orParts = (where as any).OR as any[];
    expect(orParts).toBeDefined();
    // normal 全公司可查分支（T-33；sensitivity 非 nullable，db push 已回填）
    expect(orParts.some((p: any) => p.sensitivity === 'normal')).toBe(true);
    // confidential 仅本人维（ownerId ∨ salesRepIds，T-34）
    const confBranch = orParts.find((p: any) => p.AND && p.AND[0]?.sensitivity === 'confidential');
    expect(confBranch).toBeDefined();
    const selfOr = confBranch.AND[1].OR;
    expect(selfOr.some((p: any) => p.ownerId === ACTOR.userId)).toBe(true);
    expect(selfOr.some((p: any) => p.salesRepIds?.has === ACTOR.userId)).toBe(true);
    // v2.2：L1 不再消费组授权——小组维 id-in 分支绝不能出现在档案读 scope
    expect(orParts.some((p: any) => p.id && p.id.in)).toBe(false);
  });

  it('T-40：all+write:self（sales 口径）→ 读图书馆、写本人维（读写分离核心）', async () => {
    vi.mocked(createPermissionService).mockImplementation((() => ({
      getDataScopeResolver: vi.fn().mockResolvedValue({ rule: { kind: 'all', write: 'self' } }),
    })) as any);
    const prisma = makePrisma({});
    const svc = createRelationServiceV2(prisma);
    // 读 = 图书馆口径（非 {}——写侧收窄即非真全权角色）
    const readWhere = await svc.buildScopeWhere(ACTOR);
    expect((readWhere as any).OR).toBeDefined();
    // 写 = 本人维（ownerId ∨ salesRepIds）
    const writeWhere = await svc.buildWriteScopeWhere(ACTOR);
    const orParts = (writeWhere as any).OR as any[];
    expect(orParts.some((p: any) => p.ownerId === ACTOR.userId)).toBe(true);
    expect(orParts.some((p: any) => p.salesRepIds?.has === ACTOR.userId)).toBe(true);
  });

  it('T-19：写 scope 不含小组维（组共享 ≠ 可写，防越权核心）', async () => {
    useDepartmentRule();
    const prisma = makePrisma({
      teamMemberFindMany: vi.fn().mockResolvedValue([{ teamId: 'team_1' }]),
      teamGrantFindMany: vi.fn().mockResolvedValue([{ entityId: 'REL__TEAM' }]),
    });
    const svc = createRelationServiceV2(prisma);
    const where = await svc.buildWriteScopeWhere(ACTOR);
    const orParts = (where as any).OR as any[] | undefined;
    // 小组维 id-in 分支绝不能出现在写 scope
    const hasTeamBranch = orParts?.some((p: any) => p.id && p.id.in) ?? false;
    expect(hasTeamBranch).toBe(false);
  });

  it('T-11：all 规则下小组维透明（无过滤，财务/QC 可见性不变）', async () => {
    useAllRule();
    const prisma = makePrisma({
      teamMemberFindMany: vi.fn().mockResolvedValue([{ teamId: 'team_1' }]),
      teamGrantFindMany: vi.fn().mockResolvedValue([{ entityId: 'REL__TEAM' }]),
    });
    const svc = createRelationServiceV2(prisma);
    const where = await svc.buildScopeWhere(ACTOR);
    expect(where).toEqual({}); // 无过滤
  });

  it('T-19 场景：仅组共享可见的实体 → updateRelation 拒绝（NOT_FOUND）', async () => {
    useDepartmentRule();
    // relation.findFirst 模拟：写 scope（部门维）查不到 REL__TEAM → findFirst 返回 null
    const prisma = makePrisma({
      findFirst: vi.fn().mockResolvedValue(null),
      teamMemberFindMany: vi.fn().mockResolvedValue([{ teamId: 'team_1' }]),
      teamGrantFindMany: vi.fn().mockResolvedValue([{ entityId: 'REL__TEAM' }]),
    });
    const svc = createRelationServiceV2(prisma);
    const r = await svc.updateRelation(ACTOR, 'REL__TEAM', { stage: 'Key' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
    // 防线断言：写路径 where 的 OR 分支绝不含小组维 id-in（where.id 本身是查询目标，应存在）
    const callWhere = (prisma.relation.findFirst as any).mock.calls[0][0].where;
    const orParts = (callWhere.OR || []) as any[];
    expect(orParts.some((p: any) => p.id && p.id.in)).toBe(false);
  });

  it('§8.2 徽章：列表项携带 teamShares（用户所在组的共享来源）', async () => {
    useAllRule();
    const prisma = makePrisma({
      teamMemberFindMany: vi.fn().mockResolvedValue([{ teamId: 'team_1' }]),
      teamGrantFindMany: vi.fn().mockImplementation(async ({ where }: any) => {
        // getActiveGrantedRelationIds（scope）与 getMyTeamSharesForEntities（徽章）共用 findMany
        if (where?.teamId && !where.entityId) return [{ entityId: 'REL__1' }];
        return [{
          id: 'g_1', entityId: 'REL__1', permission: 'read+followup',
          teamId: 'team_1', grantedBy: 'user_mgr', grantedAt: new Date(),
          team: { id: 'team_1', name: '欧洲市场组' },
        }];
      }),
    });
    const svc = createRelationServiceV2(prisma);
    const r = await svc.listRelations(ACTOR, {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      const item = r.data.items[0];
      expect(item.teamShares).toHaveLength(1);
      expect(item.teamShares[0]).toMatchObject({ teamId: 'team_1', teamName: '欧洲市场组', permission: 'read+followup' });
    }
  });

  it('§8.3 详情：all 规则 → accessMode=owner（全权，v2.1 档位）', async () => {
    useAllRule();
    const prisma = makePrisma({
      teamMemberFindMany: vi.fn().mockResolvedValue([{ teamId: 'team_1' }]),
      teamGrantFindMany: vi.fn().mockImplementation(async ({ where }: any) => {
        if (where?.teamId && !where.entityId) return [{ entityId: 'REL__1' }];
        return [{
          id: 'g_1', entityId: 'REL__1', permission: 'read',
          teamId: 'team_1', grantedBy: 'user_mgr', grantedAt: new Date(),
          team: { id: 'team_1', name: '欧洲市场组' },
        }];
      }),
    });
    const svc = createRelationServiceV2(prisma);
    const r = await svc.getRelation(ACTOR, 'REL__1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.accessMode).toBe('owner');
      expect(r.data.teamShares).toHaveLength(1);
    }
  });

  it('§8.3 详情：部门外实体 + 组共享 read 档 → accessMode=team-read（T-20 前端门禁依据）', async () => {
    useDepartmentRule();
    const prisma = makePrisma({
      // relation.findFirst：读 scope 命中（返回实体）→ 详情可见；
      // hasRelationWriteAccess 查他人实体（部门维不可写）——salesRepIds 须清空避免误判
      findFirst: vi.fn().mockResolvedValue(makeRelation({ id: 'REL__TEAM', ownerId: 'user_x', departmentId: 'dept_9', salesRepIds: [] })),
      teamMemberFindMany: vi.fn().mockResolvedValue([{ teamId: 'team_1' }]),
      teamGrantFindMany: vi.fn().mockImplementation(async ({ where }: any) => {
        if (where?.teamId && !where.entityId) return [{ entityId: 'REL__TEAM' }];
        return []; // getMyTeamSharesForEntities（徽章）——详情 chips 走 getEntityTeamShares 的 findMany，此处兜底
      }),
    });
    // getEntityTeamShares（chips）与 resolveRelationAccess 的 grant 查询走 teamDataGrant.findFirst
    (prisma.teamDataGrant.findFirst as any) = vi.fn().mockResolvedValue({ permission: 'read' });
    const svc = createRelationServiceV2(prisma);
    const r = await svc.getRelation(ACTOR, 'REL__TEAM');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.accessMode).toBe('team-read');
  });
});
