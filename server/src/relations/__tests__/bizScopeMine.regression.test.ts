/**
 * P1-001 回归：/v2/relations?bizScope=mine L2 业务口径过滤
 *
 * 根因：CRM 页客户下拉用图书馆口径（全公司 normal 档案）列表，默认选中
 * filtered[0] 可能是无权客户 → 跟进记录 403「仅跟进人与协作组」。
 * 修复：listRelations 支持 bizScope='mine'——非全权角色按
 * resolveVisibleRelationIds（followedBy ∪ teamGranted）过滤 ID 集，
 * 与 crmRouteV2 hasBizReadAccess 同一真源；全权角色 L2 全可见不过滤。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// permissionService 按 spec 维度可控（sales = department 维 → writeKind 非 all）
const dataScopeResolverMock = vi.fn().mockResolvedValue({ rule: { kind: 'department', own: true }, allowedDepartmentIds: ['dept_1'], allowedUserIds: [] });
vi.mock('../../auth/permissionService', () => ({
  createPermissionService: vi.fn(() => ({
    getDataScopeResolver: dataScopeResolverMock,
  })),
}));

vi.mock('../../sequence/sequenceService', () => ({
  createSequenceService: vi.fn(() => ({ nextNumber: vi.fn().mockResolvedValue('CUS-00001') })),
}));

vi.mock('../../dictionaries/dataDictionaryService', () => ({
  getDataDictionaryService: vi.fn(() => ({ getEntries: vi.fn().mockResolvedValue([]) })),
}));

vi.mock('../../config/systemConfigService', () => ({
  getSystemConfigService: vi.fn(() => ({ getString: vi.fn().mockResolvedValue('CNY') })),
}));

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('../relationMutationService', () => ({
  toRelationDbPayload: vi.fn((input: any) => ({ ...input })),
  toRelationUpdatePayload: vi.fn((input: any) => ({ ...input })),
  serializeRelation: vi.fn((row: any) => row),
  VALID_RELATION_CATEGORIES: new Set(['Customer', 'Supplier', 'Agent', 'Partner', 'Government', 'Internal', 'Other']),
}));

import { createRelationServiceV2 } from '../relationServiceV2';

const SALES_ACTOR = { userId: 'user_sales', departmentIds: ['dept_1'], role: 'sales' } as any;

function makePrisma({ visibleIds, listItems }: { visibleIds: string[]; listItems: any[] }) {
  return {
    relation: {
      // 两种调用：select.id（resolveVisibleRelationIds 内部）→ 返回 ID 行；否则为列表查询
      findMany: vi.fn().mockImplementation(async (args: any) => {
        if (args.select && args.select.id) {
          return visibleIds.map((id) => ({ id }));
        }
        return listItems;
      }),
      count: vi.fn().mockResolvedValue(listItems.length),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    teamMember: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    team: { findUnique: vi.fn().mockResolvedValue(null), findFirst: vi.fn().mockResolvedValue(null), update: vi.fn().mockResolvedValue({}) },
    teamDataGrant: {
      findMany: vi.fn().mockResolvedValue([]),
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

const OWNED_RELATION = { id: 'REL_MINE', code: 'CUS-00001', name: '我的客户', category: 'Customer', stage: 'Customer', tier: 'A', isOrganization: true, ownerId: 'user_sales', departmentId: 'dept_1', salesRepIds: ['user_sales'], deletedAt: null, createdAt: BigInt(0), updatedAt: BigInt(0) };
const FOREIGN_RELATION = { id: 'REL_OTHER', code: 'CUS-00002', name: '别人的客户', category: 'Customer', stage: 'Customer', tier: 'B', isOrganization: true, ownerId: 'user_2', departmentId: 'dept_2', salesRepIds: ['user_2'], deletedAt: null, createdAt: BigInt(0), updatedAt: BigInt(0) };

beforeEach(() => { vi.clearAllMocks(); });

describe('P1-001 listRelations bizScope=mine（L2 业务口径）', () => {
  /** 列表查询 = findMany 最后一次调用（此前可能有 resolveVisibleRelationIds 的 select.id 查询） */
  const lastListWhere = (prisma: any) => {
    const calls = prisma.relation.findMany.mock.calls;
    return calls[calls.length - 1][0].where;
  };

  it('非全权角色（sales）：where.id 限定 resolveVisibleRelationIds 返回的 ID 集', async () => {
    dataScopeResolverMock.mockResolvedValue({ rule: { kind: 'department', own: true }, allowedDepartmentIds: ['dept_1'], allowedUserIds: [] });
    const prisma = makePrisma({ visibleIds: ['REL_MINE', 'REL_TEAM'], listItems: [OWNED_RELATION, FOREIGN_RELATION] });
    const svc = createRelationServiceV2(prisma);
    const r = await svc.listRelations(SALES_ACTOR, { bizScope: 'mine' });
    expect(r.ok).toBe(true);
    expect(lastListWhere(prisma).id).toEqual({ in: ['REL_MINE', 'REL_TEAM'] });
  });

  it('全权角色（writeKind=all）：L2 全可见，不做 ID 过滤', async () => {
    dataScopeResolverMock.mockResolvedValue({ rule: { kind: 'all' }, allowedDepartmentIds: [], allowedUserIds: [] });
    const prisma = makePrisma({ visibleIds: [], listItems: [OWNED_RELATION, FOREIGN_RELATION] });
    const svc = createRelationServiceV2(prisma);
    const r = await svc.listRelations(SALES_ACTOR, { bizScope: 'mine' });
    expect(r.ok).toBe(true);
    expect(lastListWhere(prisma).id).toBeUndefined();
  });

  it('不传 bizScope：图书馆口径不变（无 ID 过滤，兼容关系智库等既有消费方）', async () => {
    dataScopeResolverMock.mockResolvedValue({ rule: { kind: 'department', own: true }, allowedDepartmentIds: ['dept_1'], allowedUserIds: [] });
    const prisma = makePrisma({ visibleIds: ['REL_MINE'], listItems: [OWNED_RELATION, FOREIGN_RELATION] });
    const svc = createRelationServiceV2(prisma);
    await svc.listRelations(SALES_ACTOR, {});
    expect(lastListWhere(prisma).id).toBeUndefined();
  });
});
