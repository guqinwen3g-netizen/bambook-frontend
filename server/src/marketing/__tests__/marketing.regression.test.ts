/**
 * marketingService 回归测试（S-QA 测试补强 / W? 新增独立文件，禁止修改既有文件）
 *
 * 覆盖点：
 *   1. Campaign CRUD 主流程（创建 / 列表 / 详情 / 更新 / 软删除）
 *   2. Campaign ROI 计算（含 Decimal/BigInt 序列化、空线索、零成本）
 *   3. Lead CRUD 主流程（创建 / 列表 / 更新 / 软删除）+ 转化自动落 convertedAt
 *   4. Scope 行级守卫（无 actor → __NOBODY__；self 非 owner → NOT_FOUND（QA-SEC-2 后不泄露存在性）；all → 直通）
 *   5. 边界输入（非法 campaignId、缺失 name、缺线索 id、scope 拦截 → NOT_FOUND）
 *   6. 编号生成失败兜底（QA-SEC-3 后契约：seqSvc.nextNumber 抛错 → createCampaign fail-closed 抛错，无记录落库）
 *
 * 说明：本 service 层无强制状态机（status 字段是自由字符串），因此不校验状态转换的
 * 合法性，而是聚焦于 CRUD、scope 守卫、转化时间自动写入、错误码精确匹配。
 * 2026-08-17 总控仲裁（§6.1）：QA-SEC-1/2/3 修复后，本文件 9 项期望值由旧行为更新为新契约
 * （两段式 scope 校验 / 越权统一 NOT_FOUND / 编号失败抛错），由总控直接修订并复核。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

// ── mock 平台依赖（permission / sequence / dictionary / logger）──
const mockGetDataScopeResolver = vi.fn();
vi.mock('../../auth/permissionService', () => ({
  createPermissionService: vi.fn(() => ({
    getDataScopeResolver: mockGetDataScopeResolver,
  })),
}));

const mockNextNumber = vi.fn();
vi.mock('../../sequence/sequenceService', () => ({
  createSequenceService: vi.fn(() => ({
    nextNumber: mockNextNumber,
  })),
}));

vi.mock('../../dictionaries/dataDictionaryService', () => ({
  getDataDictionaryService: vi.fn(() => ({
    getByCode: vi.fn(),
    getEntries: vi.fn().mockResolvedValue([]),
    getLabel: vi.fn(),
    listDictionaries: vi.fn(),
    upsert: vi.fn(),
    invalidateCache: vi.fn(),
    __cacheSize: vi.fn(() => 0),
    DICT_CODES: {},
    ALL_SYSTEM_DICT_CODES: [],
  })),
}));

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createMarketingService } from '../marketingService';

// ── helpers ──
const ADMIN_ACTOR = { userId: 'u_admin', roles: ['admin'], permissions: [], departmentIds: ['d1'] } as any;
const SALES_ACTOR = { userId: 'u_sales', roles: ['sales'], permissions: [], departmentIds: ['d_sales'] } as any;

const SCOPE_ALL = { rule: { kind: 'all' }, allowedDepartmentIds: [], allowedUserIds: [] };
const SCOPE_SELF_SALES = { rule: { kind: 'self' }, allowedDepartmentIds: [], allowedUserIds: ['u_sales'] };

function makeCampaignRow(over: any = {}) {
  return {
    id: 'MC_1',
    code: 'MKT-202608-001',
    name: '巴黎时装周 2026',
    description: '春季新品发布',
    type: 'exhibition',
    status: 'Draft',
    startDate: '2026-09-01',
    endDate: '2026-09-10',
    budget: { toString: () => '50000' },
    actualCost: { toString: () => '30000' },
    targetSegment: null,
    seasonId: null,
    tradeShowId: null,
    ownerId: 'u_sales',
    departmentId: 'd_sales',
    createdAt: BigInt(1000),
    updatedAt: BigInt(1000),
    deletedAt: null,
    leads: [],
    ...over,
  };
}

function makeLeadRow(over: any = {}) {
  return {
    id: 'ML_1',
    campaignId: 'MC_1',
    relationId: 'REL_1',
    source: 'exhibition',
    contactName: 'Alice',
    contactEmail: 'alice@example.com',
    contactPhone: null,
    status: 'New',
    estimatedValue: { toString: () => '8000' },
    actualValue: null,
    convertedAt: null,
    notes: null,
    // QA-SEC-2 后 service 以 include campaign 两段式校验 scope，mock 默认携带关系
    campaign: { id: 'MC_1' },
    createdAt: BigInt(2000),
    updatedAt: BigInt(2000),
    deletedAt: null,
    ...over,
  };
}

function makePrisma(opts: {
  campaign?: any;             // findFirst 默认返回
  campaigns?: any[];          // findMany 返回
  campaignTotal?: number;
  lead?: any;                 // lead findFirst 默认返回
  leads?: any[];
  leadTotal?: number;
} = {}) {
  const campaign = opts.campaign === undefined ? makeCampaignRow() : opts.campaign;
  const lead = opts.lead === undefined ? makeLeadRow() : opts.lead;

  const calls = {
    campaignFindMany: vi.fn(async () => opts.campaigns ?? (campaign ? [campaign] : [])),
    campaignCount: vi.fn(async () => opts.campaignTotal ?? (campaign ? 1 : 0)),
    campaignFindFirst: vi.fn(async ({ where }: any) => {
      if (!campaign) return null;
      // 简单模拟 id 匹配
      if (where?.id && campaign.id !== where.id) return null;
      // QA-SEC 后 service 传入 scopeWhere（ownerId 等值 / OR in 列表），mock 按最小匹配语义生效
      if (where?.ownerId && campaign.ownerId !== where.ownerId) return null;
      if (Array.isArray(where?.OR)) {
        const hit = where.OR.some((c: any) => {
          if (c.ownerId?.in) return c.ownerId.in.includes(campaign.ownerId);
          if (c.departmentId?.in) return c.departmentId.in.includes(campaign.departmentId);
          return false;
        });
        if (!hit) return null;
      }
      return campaign;
    }),
    campaignCreate: vi.fn(async ({ data }: any) => ({ id: 'MC_NEW', ...data })),
    campaignUpdate: vi.fn(async ({ where, data }: any) => ({ ...(campaign ?? {}), ...data, id: where.id })),
    leadFindMany: vi.fn(async () => opts.leads ?? (lead ? [lead] : [])),
    leadCount: vi.fn(async () => opts.leadTotal ?? (lead ? 1 : 0)),
    leadFindFirst: vi.fn(async ({ where }: any) => {
      if (!lead) return null;
      if (where?.id && lead.id !== where.id) return null;
      return lead;
    }),
    leadCreate: vi.fn(async ({ data }: any) => ({ id: 'ML_NEW', ...data })),
    leadUpdate: vi.fn(async ({ where, data }: any) => ({ ...(lead ?? {}), ...data, id: where.id })),
  };

  const prisma: any = {
    marketingCampaign: {
      findMany: calls.campaignFindMany,
      count: calls.campaignCount,
      findFirst: calls.campaignFindFirst,
      create: calls.campaignCreate,
      update: calls.campaignUpdate,
    },
    marketingLead: {
      findMany: calls.leadFindMany,
      count: calls.leadCount,
      findFirst: calls.leadFindFirst,
      create: calls.leadCreate,
      update: calls.leadUpdate,
    },
  };
  return { prisma, calls };
}

function makeService(prisma: any) {
  return createMarketingService(prisma);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetDataScopeResolver.mockResolvedValue(SCOPE_ALL);
  mockNextNumber.mockResolvedValue('MKT-202608-001');
});

// ═══════════════════════════════════════════════════════════════
// Campaign CRUD
// ═══════════════════════════════════════════════════════════════
describe('Campaign CRUD 主流程', () => {
  it('createCampaign：actor=null → UNAUTHORIZED（fail-closed 401）', async () => {
    const { prisma } = makePrisma();
    const svc = makeService(prisma);
    await expect(svc.createCampaign(null, { name: 'X' })).rejects.toThrow('UNAUTHORIZED');
  });

  it('createCampaign：缺 name 仍创建成功（service 层不校验必填，由 DB NOT NULL 兜底）', async () => {
    const { prisma, calls } = makePrisma();
    const svc = makeService(prisma);
    // 说明：marketingService 未做 name 必填校验（生产代码事实），输入透传到 prisma
    // 真实场景依赖 Prisma schema 的 name String（必填）在 DB 层拒绝；此处记录行为基线
    const result = await svc.createCampaign(ADMIN_ACTOR, { name: '' });
    expect(calls.campaignCreate).toHaveBeenCalledTimes(1);
    expect(calls.campaignCreate.mock.calls[0][0].data.name).toBe('');
    expect(result.id).toBe('MC_NEW');
  });

  it('createCampaign：默认 status=Draft + ownerId=actor.userId + 编号注入', async () => {
    const { prisma, calls } = makePrisma();
    const svc = makeService(prisma);
    await svc.createCampaign(ADMIN_ACTOR, { name: '春夏发布会' });
    const data = calls.campaignCreate.mock.calls[0][0].data;
    expect(data.status).toBe('Draft');
    expect(data.ownerId).toBe('u_admin');
    expect(data.departmentId).toBe('d1');
    expect(data.code).toBe('MKT-202608-001');
    expect(typeof data.createdAt).toBe('bigint');
    expect(typeof data.updatedAt).toBe('bigint');
  });

  it('createCampaign：显式 status / ownerId / departmentId 覆盖默认值', async () => {
    const { prisma, calls } = makePrisma();
    const svc = makeService(prisma);
    await svc.createCampaign(ADMIN_ACTOR, {
      name: 'X', status: 'Active', ownerId: 'u_other', departmentId: 'd_other',
    });
    const data = calls.campaignCreate.mock.calls[0][0].data;
    expect(data.status).toBe('Active');
    expect(data.ownerId).toBe('u_other');
    expect(data.departmentId).toBe('d_other');
  });

  it('createCampaign：seqSvc.nextNumber 抛错 → fail-closed 抛错，无记录落库（QA-SEC-3 契约）', async () => {
    mockNextNumber.mockRejectedValueOnce(new Error('sequence unavailable'));
    const { prisma, calls } = makePrisma();
    const svc = makeService(prisma);
    await expect(svc.createCampaign(ADMIN_ACTOR, { name: 'X' })).rejects.toThrow('sequence unavailable');
    expect(calls.campaignCreate).not.toHaveBeenCalled();
  });

  it('listCampaigns：默认 limit=50/offset=0 + 携带 deletedAt:null 过滤', async () => {
    const { prisma, calls } = makePrisma();
    const svc = makeService(prisma);
    const r = await svc.listCampaigns(ADMIN_ACTOR);
    expect(r.limit).toBe(50);
    expect(r.offset).toBe(0);
    expect(r.total).toBe(1);
    const where = calls.campaignFindMany.mock.calls[0][0].where;
    expect(where.deletedAt).toBeNull();
  });

  it('listCampaigns：limit 越界截断（0→1，9999→500）+ offset 负数归零', async () => {
    const { prisma } = makePrisma();
    const svc = makeService(prisma);
    const a = await svc.listCampaigns(ADMIN_ACTOR, { limit: 0, offset: -5 });
    expect(a.limit).toBe(1);
    expect(a.offset).toBe(0);
    const b = await svc.listCampaigns(ADMIN_ACTOR, { limit: 9999 });
    expect(b.limit).toBe(500);
  });

  it('listCampaigns：search 注入 name/code/description OR 模糊查询 + status/type 过滤', async () => {
    const { prisma, calls } = makePrisma();
    const svc = makeService(prisma);
    await svc.listCampaigns(ADMIN_ACTOR, { status: 'Active', type: 'exhibition', search: ' 巴黎 ' });
    const where = calls.campaignFindMany.mock.calls[0][0].where;
    expect(where.status).toBe('Active');
    expect(where.type).toBe('exhibition');
    expect(Array.isArray(where.OR)).toBe(true);
    expect(where.OR[0].name.contains).toBe('巴黎');
    expect(where.OR[1].code.contains).toBe('巴黎');
    expect(where.OR[2].description.contains).toBe('巴黎');
  });

  it('listCampaigns：BigInt 字段序列化为 Number（createdAt/updatedAt）', async () => {
    const { prisma } = makePrisma();
    const svc = makeService(prisma);
    const r = await svc.listCampaigns(ADMIN_ACTOR);
    expect(typeof r.items[0].createdAt).toBe('number');
    expect(typeof r.items[0].updatedAt).toBe('number');
  });

  it('getCampaign：不存在 → null（route 层转 404）', async () => {
    const { prisma } = makePrisma({ campaign: null });
    const svc = makeService(prisma);
    const r = await svc.getCampaign(ADMIN_ACTOR, 'MC_X');
    expect(r).toBeNull();
  });

  it('getCampaign：scope=all 时 where 不含 ownerId 限制', async () => {
    const { prisma, calls } = makePrisma();
    const svc = makeService(prisma);
    await svc.getCampaign(ADMIN_ACTOR, 'MC_1');
    const where = calls.campaignFindFirst.mock.calls[0][0].where;
    expect(where).not.toHaveProperty('ownerId');
    expect(where).not.toHaveProperty('OR');
  });

  it('updateCampaign：campaign 不在 scope → NOT_FOUND', async () => {
    const { prisma } = makePrisma({ campaign: null });
    const svc = makeService(prisma);
    await expect(svc.updateCampaign(ADMIN_ACTOR, 'MC_X', { name: 'Y' })).rejects.toThrow('NOT_FOUND');
  });

  it('updateCampaign：剥离 patch.id / patch.code，强制刷新 updatedAt', async () => {
    const { prisma, calls } = makePrisma();
    const svc = makeService(prisma);
    await svc.updateCampaign(ADMIN_ACTOR, 'MC_1', { id: 'HACK', code: 'HACK', name: '新名' });
    const data = calls.campaignUpdate.mock.calls[0][0].data;
    expect(data.id).toBeUndefined();
    expect(data.code).toBeUndefined();
    expect(data.name).toBe('新名');
    expect(typeof data.updatedAt).toBe('bigint');
  });

  it('deleteCampaign：不存在 → NOT_FOUND；存在 → 软删除（deletedAt=BigInt）', async () => {
    const { prisma, calls } = makePrisma();
    const svc = makeService(prisma);
    await svc.deleteCampaign(ADMIN_ACTOR, 'MC_1');
    const data = calls.campaignUpdate.mock.calls[0][0].data;
    expect(typeof data.deletedAt).toBe('bigint');

    const { prisma: p2 } = makePrisma({ campaign: null });
    const svc2 = makeService(p2);
    await expect(svc2.deleteCampaign(ADMIN_ACTOR, 'MC_X')).rejects.toThrow('NOT_FOUND');
  });
});

// ═══════════════════════════════════════════════════════════════
// Campaign ROI
// ═══════════════════════════════════════════════════════════════
describe('Campaign ROI 计算', () => {
  it('campaign 不存在 → NOT_FOUND', async () => {
    const { prisma } = makePrisma({ campaign: null });
    const svc = makeService(prisma);
    await expect(svc.getCampaignROI(ADMIN_ACTOR, 'MC_X')).rejects.toThrow('NOT_FOUND');
  });

  it('空线索 → totalLeads=0 / conversionRate=0 / 有 actualCost 时 roi=-1（亏损全部成本）', async () => {
    const { prisma } = makePrisma({ campaign: makeCampaignRow({ leads: [], actualCost: { toString: () => '30000' } }) });
    const svc = makeService(prisma);
    const r = await svc.getCampaignROI(ADMIN_ACTOR, 'MC_1');
    expect(r.totalLeads).toBe(0);
    expect(r.convertedCount).toBe(0);
    expect(r.conversionRate).toBe(0);
    expect(r.totalEstimatedValue).toBe(0);
    expect(r.totalActualValue).toBe(0);
    // actualCost=30000 > 0 且 totalActualValue=0 → roi = (0-30000)/30000 = -1（亏 100%）
    expect(r.roi).toBe(-1);
  });

  it('混合状态线索：只统计 Converted 的 actualValue；roi = (actualValue - actualCost) / actualCost', async () => {
    const leads = [
      makeLeadRow({ id: 'L1', status: 'Converted', actualValue: { toString: () => '60000' }, estimatedValue: { toString: () => '50000' } }),
      makeLeadRow({ id: 'L2', status: 'Qualified', estimatedValue: { toString: () => '30000' } }),
      makeLeadRow({ id: 'L3', status: 'Lost', estimatedValue: { toString: () => '20000' } }),
    ];
    const { prisma } = makePrisma({
      campaign: makeCampaignRow({
        leads,
        budget: { toString: () => '50000' },
        actualCost: { toString: () => '40000' },
      }),
    });
    const svc = makeService(prisma);
    const r = await svc.getCampaignROI(ADMIN_ACTOR, 'MC_1');
    expect(r.totalLeads).toBe(3);
    expect(r.convertedCount).toBe(1);
    expect(r.conversionRate).toBeCloseTo(1 / 3, 5);
    expect(r.totalEstimatedValue).toBe(100000);   // 50k + 30k + 20k
    expect(r.totalActualValue).toBe(60000);       // 只 Converted
    expect(r.budget).toBe(50000);
    expect(r.actualCost).toBe(40000);
    expect(r.roi).toBeCloseTo((60000 - 40000) / 40000, 5);
  });

  /**
   * ★ 2026-09-17 口径修订（P4-1 P2-#11）：`actualCost=0 → roi` 由 **0 改为 null**。
   *
   * 旧断言 `expect(r.roi).toBe(0)` 固化了一个**与前端相反**的口径：
   *   · 数学上 `(0 − 0) / 0` **未定义**；
   *   · 返回 `0` 会被读成「投入无回报」，真实语义是「**无法计算**」（空值红线：无值显示「—」）；
   *   · 前端 `components/MarketingManager.tsx` 的 `campaignRoiOf` **早已返回 `null`**，
   *     且其契约测试 `components/marketingCampaignsLeadsContract.test.ts:66` 把 `: null` 钉成了断言。
   * ⇒ 后端返回 0 是**跨层口径漂移**，本批对齐为 `null`。
   */
  it('★ actualCost=0 → roi=null（无意义，非 0）—— 与前端同口径', async () => {
    const leads = [makeLeadRow({ status: 'Converted', actualValue: { toString: () => '99999' } })];
    const { prisma } = makePrisma({
      campaign: makeCampaignRow({ leads, actualCost: { toString: () => '0' } }),
    });
    const svc = makeService(prisma);
    const r = await svc.getCampaignROI(ADMIN_ACTOR, 'MC_1');
    expect(r.roi).toBeNull();
    expect(r.roi).not.toBe(0);
  });

  it('★ 跨层对撞：零成本 ROI 兜底在后端与前端必须是同一口径（都 null）', () => {
    const server = readFileSync(new URL('../marketingService.ts', import.meta.url), 'utf8');
    const frontend = readFileSync(
      new URL('../../../../components/MarketingManager.tsx', import.meta.url),
      'utf8',
    );
    // 两侧必须逐字同口径
    const NULL_EXPR = /const roi = actualCost > 0 \? \(totalActualValue - actualCost\) \/ actualCost : null;/;
    expect(server).toMatch(NULL_EXPR);
    expect(frontend).toMatch(NULL_EXPR);
    // 反向：任一侧退回 `: 0` 立即红
    const ZERO_EXPR = /const roi = actualCost > 0 \? \(totalActualValue - actualCost\) \/ actualCost : 0;/;
    expect(server).not.toMatch(ZERO_EXPR);
    expect(frontend).not.toMatch(ZERO_EXPR);
  });
});

// ═══════════════════════════════════════════════════════════════
// Lead CRUD
// ═══════════════════════════════════════════════════════════════
describe('Lead CRUD 主流程', () => {
  it('createLead：campaign 不在 scope → NOT_FOUND（含详细文案）', async () => {
    const { prisma } = makePrisma({ campaign: null });
    const svc = makeService(prisma);
    await expect(
      svc.createLead(ADMIN_ACTOR, { campaignId: 'MC_X', contactName: 'A' }),
    ).rejects.toThrow(/NOT_FOUND/);
  });

  it('createLead：默认 status=New + 注入 createdAt/updatedAt', async () => {
    const { prisma, calls } = makePrisma();
    const svc = makeService(prisma);
    await svc.createLead(ADMIN_ACTOR, { campaignId: 'MC_1', contactName: 'Alice' });
    const data = calls.leadCreate.mock.calls[0][0].data;
    expect(data.status).toBe('New');
    expect(data.campaignId).toBe('MC_1');
    expect(typeof data.createdAt).toBe('bigint');
    expect(typeof data.updatedAt).toBe('bigint');
  });

  it('createLead：显式 status=Qualified 覆盖默认 New', async () => {
    const { prisma, calls } = makePrisma();
    const svc = makeService(prisma);
    await svc.createLead(ADMIN_ACTOR, { campaignId: 'MC_1', status: 'Qualified' });
    expect(calls.leadCreate.mock.calls[0][0].data.status).toBe('Qualified');
  });

  it('listLeads：campaign 不存在 → NOT_FOUND（scope 拦截视为 NOT_FOUND，防穿透）', async () => {
    const { prisma } = makePrisma({ campaign: null });
    const svc = makeService(prisma);
    await expect(svc.listLeads(ADMIN_ACTOR, 'MC_X')).rejects.toThrow('NOT_FOUND');
  });

  it('listLeads：默认分页 + status 过滤 + 结果 BigInt 序列化', async () => {
    const { prisma, calls } = makePrisma();
    const svc = makeService(prisma);
    const r = await svc.listLeads(ADMIN_ACTOR, 'MC_1', { status: 'Contacted' });
    expect(r.limit).toBe(50);
    expect(r.offset).toBe(0);
    expect(calls.leadFindMany.mock.calls[0][0].where.status).toBe('Contacted');
    expect(calls.leadFindMany.mock.calls[0][0].where.campaignId).toBe('MC_1');
    expect(typeof r.items[0].createdAt).toBe('number');
  });

  it('listLeads：limit/offset 边界截断（>500 → 500；负数 → 0）', async () => {
    const { prisma } = makePrisma();
    const svc = makeService(prisma);
    const r = await svc.listLeads(ADMIN_ACTOR, 'MC_1', { limit: 999, offset: -3 });
    expect(r.limit).toBe(500);
    expect(r.offset).toBe(0);
  });

  it('updateLead：lead 不存在 → NOT_FOUND', async () => {
    const { prisma } = makePrisma({ lead: null });
    const svc = makeService(prisma);
    await expect(svc.updateLead(ADMIN_ACTOR, 'ML_X', { notes: 'x' })).rejects.toThrow('NOT_FOUND');
  });

  it('updateLead：剥离 patch.id / patch.campaignId，刷新 updatedAt', async () => {
    const { prisma, calls } = makePrisma();
    const svc = makeService(prisma);
    await svc.updateLead(ADMIN_ACTOR, 'ML_1', { id: 'HACK', campaignId: 'HACK', notes: 'ok' });
    const data = calls.leadUpdate.mock.calls[0][0].data;
    expect(data.id).toBeUndefined();
    expect(data.campaignId).toBeUndefined();
    expect(data.notes).toBe('ok');
    expect(typeof data.updatedAt).toBe('bigint');
  });

  it('updateLead：status → Converted 且未传 convertedAt → 服务端自动写入 convertedAt=BigInt', async () => {
    const { prisma, calls } = makePrisma();
    const svc = makeService(prisma);
    await svc.updateLead(ADMIN_ACTOR, 'ML_1', { status: 'Converted' });
    const data = calls.leadUpdate.mock.calls[0][0].data;
    expect(data.status).toBe('Converted');
    expect(typeof data.convertedAt).toBe('bigint');
  });

  it('updateLead：显式传入 convertedAt → 不被覆盖（保留客户端语义）', async () => {
    const { prisma, calls } = makePrisma();
    const svc = makeService(prisma);
    const explicit = BigInt(1234567890);
    await svc.updateLead(ADMIN_ACTOR, 'ML_1', { status: 'Converted', convertedAt: explicit });
    const data = calls.leadUpdate.mock.calls[0][0].data;
    expect(data.convertedAt).toBe(explicit);
  });

  it('updateLead：status ≠ Converted → 不写入 convertedAt', async () => {
    const { prisma, calls } = makePrisma();
    const svc = makeService(prisma);
    await svc.updateLead(ADMIN_ACTOR, 'ML_1', { status: 'Contacted' });
    expect(calls.leadUpdate.mock.calls[0][0].data.convertedAt).toBeUndefined();
  });

  it('deleteLead：lead 不存在 → NOT_FOUND；存在 → 软删除', async () => {
    const { prisma, calls } = makePrisma();
    const svc = makeService(prisma);
    await svc.deleteLead(ADMIN_ACTOR, 'ML_1');
    expect(typeof calls.leadUpdate.mock.calls[0][0].data.deletedAt).toBe('bigint');

    const { prisma: p2 } = makePrisma({ lead: null });
    const svc2 = makeService(p2);
    await expect(svc2.deleteLead(ADMIN_ACTOR, 'ML_X')).rejects.toThrow('NOT_FOUND');
  });
});

// ═══════════════════════════════════════════════════════════════
// Scope 行级守卫
// ═══════════════════════════════════════════════════════════════
describe('Scope 行级守卫（PL-2B marketing 模块）', () => {
  it('actor=null（匿名）→ buildScopeWhere 返回 { ownerId: __NOBODY__ }，list 必空', async () => {
    const { prisma, calls } = makePrisma();
    const svc = makeService(prisma);
    await svc.listCampaigns(null);
    const where = calls.campaignFindMany.mock.calls[0][0].where;
    expect(where.ownerId).toBe('__NOBODY__');
  });

  it('resolver.rule.kind=all（SuperAdmin/Admin）→ where 无 ownerId 过滤', async () => {
    mockGetDataScopeResolver.mockResolvedValue(SCOPE_ALL);
    const { prisma, calls } = makePrisma();
    const svc = makeService(prisma);
    await svc.listCampaigns(ADMIN_ACTOR);
    const where = calls.campaignFindMany.mock.calls[0][0].where;
    expect(where).not.toHaveProperty('ownerId');
    expect(where).not.toHaveProperty('OR');
  });

  it('resolver.rule.kind=self（sales 仅自己）→ where.ownerId=actor.userId', async () => {
    mockGetDataScopeResolver.mockResolvedValue(SCOPE_SELF_SALES);
    const { prisma, calls } = makePrisma();
    const svc = makeService(prisma);
    await svc.listCampaigns(SALES_ACTOR);
    const where = calls.campaignFindMany.mock.calls[0][0].where;
    expect(where.ownerId).toBe('u_sales');
  });

  it('resolver.rule.kind=department（无用户/部门白名单）→ 兜底 __NOBODY__（fail-closed）', async () => {
    mockGetDataScopeResolver.mockResolvedValue({
      rule: { kind: 'department', own: true },
      allowedDepartmentIds: [],
      allowedUserIds: [],
    });
    const { prisma, calls } = makePrisma();
    const svc = makeService(prisma);
    await svc.listCampaigns(SALES_ACTOR);
    const where = calls.campaignFindMany.mock.calls[0][0].where;
    expect(where.ownerId).toBe('__NOBODY__');
  });

  it('resolver.rule.kind=department（含 userIds/deptIds）→ 注入 OR 过滤', async () => {
    mockGetDataScopeResolver.mockResolvedValue({
      rule: { kind: 'department', own: true },
      allowedDepartmentIds: ['d1', 'd2'],
      allowedUserIds: ['u_a', 'u_b'],
    });
    const { prisma, calls } = makePrisma();
    const svc = makeService(prisma);
    await svc.listCampaigns(SALES_ACTOR);
    const where = calls.campaignFindMany.mock.calls[0][0].where;
    expect(Array.isArray(where.OR)).toBe(true);
    expect(where.OR).toContainEqual({ ownerId: { in: ['u_a', 'u_b'] } });
    expect(where.OR).toContainEqual({ departmentId: { in: ['d1', 'd2'] } });
  });

  it('updateLead：kind=self 且 campaign 不在 scope → NOT_FOUND（QA-SEC-2：越权与不存在统一，不泄露存在性）', async () => {
    mockGetDataScopeResolver.mockResolvedValue(SCOPE_SELF_SALES);
    const { prisma } = makePrisma({
      campaign: makeCampaignRow({ ownerId: 'u_other', departmentId: 'd_other' }),
      lead: makeLeadRow({
        campaign: { id: 'MC_1', ownerId: 'u_other', departmentId: 'd_other' },
      }),
    });
    const svc = makeService(prisma);
    await expect(
      svc.updateLead(SALES_ACTOR, 'ML_1', { notes: 'x' }),
    ).rejects.toThrow('NOT_FOUND');
  });

  it('updateLead：kind=self 且 campaign.ownerId = actor.userId → 通过', async () => {
    mockGetDataScopeResolver.mockResolvedValue(SCOPE_SELF_SALES);
    const { prisma, calls } = makePrisma({
      lead: makeLeadRow({
        campaign: { id: 'MC_1', ownerId: 'u_sales', departmentId: 'd_sales' },
      }),
    });
    const svc = makeService(prisma);
    await svc.updateLead(SALES_ACTOR, 'ML_1', { notes: 'ok' });
    expect(calls.leadUpdate).toHaveBeenCalledTimes(1);
  });

  it('updateLead：kind=all → 不做 owner 检查（直通）', async () => {
    mockGetDataScopeResolver.mockResolvedValue(SCOPE_ALL);
    const { prisma, calls } = makePrisma({
      lead: makeLeadRow({
        campaign: { id: 'MC_1', ownerId: 'u_anyone', departmentId: 'd_any' },
      }),
    });
    const svc = makeService(prisma);
    await svc.updateLead(ADMIN_ACTOR, 'ML_1', { notes: 'ok' });
    expect(calls.leadUpdate).toHaveBeenCalledTimes(1);
  });

  it('deleteLead：kind=self 且非 owner → NOT_FOUND（QA-SEC-2：越权与不存在统一）', async () => {
    mockGetDataScopeResolver.mockResolvedValue(SCOPE_SELF_SALES);
    const { prisma } = makePrisma({
      campaign: makeCampaignRow({ ownerId: 'u_other', departmentId: 'd_other' }),
      lead: makeLeadRow({
        campaign: { id: 'MC_1', ownerId: 'u_other', departmentId: 'd_other' },
      }),
    });
    const svc = makeService(prisma);
    await expect(svc.deleteLead(SALES_ACTOR, 'ML_1')).rejects.toThrow('NOT_FOUND');
  });

  it('deleteLead：kind=department 且 campaign 不在 scope → NOT_FOUND（QA-SEC-2 收口原盲区）', async () => {
    // QA-SEC-2 前 deleteLead 仅检查 kind==='self'，dept 规则零校验（原盲区）；
    // 修复后与 createLead/updateLead 一致走两段式 scope 校验，dept 不匹配 → NOT_FOUND
    mockGetDataScopeResolver.mockResolvedValue({
      rule: { kind: 'department', own: true },
      allowedDepartmentIds: ['d_other'],
      allowedUserIds: ['u_other'],
    });
    const { prisma, calls } = makePrisma({
      lead: makeLeadRow({
        campaign: { id: 'MC_1', ownerId: 'u_other', departmentId: 'd_other' },
      }),
    });
    const svc = makeService(prisma);
    await expect(svc.deleteLead(SALES_ACTOR, 'ML_1')).rejects.toThrow('NOT_FOUND');
    expect(calls.leadUpdate).not.toHaveBeenCalled();
  });

  it('createLead：campaign 不在 scope 内 → NOT_FOUND（不暴露 campaign 是否存在）', async () => {
    mockGetDataScopeResolver.mockResolvedValue(SCOPE_SELF_SALES);
    const { prisma } = makePrisma({ campaign: null });
    const svc = makeService(prisma);
    await expect(
      svc.createLead(SALES_ACTOR, { campaignId: 'MC_1' }),
    ).rejects.toThrow(/NOT_FOUND/);
  });
});

// ═══════════════════════════════════════════════════════════════
// 边界输入与精确错误码
// ═══════════════════════════════════════════════════════════════
describe('边界输入与错误码精确匹配', () => {
  it('getCampaign：id 为空字符串 → 走 findFirst（生产代码无 id 校验，由 scope+id 兜底）', async () => {
    const { prisma, calls } = makePrisma({ campaign: null });
    const svc = makeService(prisma);
    const r = await svc.getCampaign(ADMIN_ACTOR, '');
    expect(r).toBeNull();
    expect(calls.campaignFindFirst.mock.calls[0][0].where.id).toBe('');
  });

  it('updateCampaign：patch 为 {} → 仅刷新 updatedAt', async () => {
    const { prisma, calls } = makePrisma();
    const svc = makeService(prisma);
    await svc.updateCampaign(ADMIN_ACTOR, 'MC_1', {});
    const data = calls.campaignUpdate.mock.calls[0][0].data;
    expect(typeof data.updatedAt).toBe('bigint');
    expect(Object.keys(data)).toEqual(['updatedAt']);
  });

  it('updateLead：patch 为 {} → 仅刷新 updatedAt，不写 convertedAt', async () => {
    const { prisma, calls } = makePrisma();
    const svc = makeService(prisma);
    await svc.updateLead(ADMIN_ACTOR, 'ML_1', {});
    const data = calls.leadUpdate.mock.calls[0][0].data;
    expect(Object.keys(data)).toEqual(['updatedAt']);
    expect(data.convertedAt).toBeUndefined();
  });

  it('listCampaigns：search=纯空格 → trim 后为空仍注入 OR（生产代码事实）', async () => {
    const { prisma, calls } = makePrisma();
    const svc = makeService(prisma);
    await svc.listCampaigns(ADMIN_ACTOR, { search: '   ' });
    const where = calls.campaignFindMany.mock.calls[0][0].where;
    // trim 后空字符串 → OR.contains=''，Prisma 会全匹配（属于宽松行为，基线记录）
    expect(where.OR[0].name.contains).toBe('');
  });

  it('createCampaign：input.status=空字符串 → 仍走 || 默认 Draft（空串被当作 falsy）', async () => {
    const { prisma, calls } = makePrisma();
    const svc = makeService(prisma);
    await svc.createCampaign(ADMIN_ACTOR, { name: 'X', status: '' });
    expect(calls.campaignCreate.mock.calls[0][0].data.status).toBe('Draft');
  });

  it('createLead：input.status=空字符串 → 默认 New', async () => {
    const { prisma, calls } = makePrisma();
    const svc = makeService(prisma);
    await svc.createLead(ADMIN_ACTOR, { campaignId: 'MC_1', status: '' });
    expect(calls.leadCreate.mock.calls[0][0].data.status).toBe('New');
  });
});
