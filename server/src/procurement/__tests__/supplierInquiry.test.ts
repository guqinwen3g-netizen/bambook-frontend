/**
 * 卡点 3 供应商询价比价 — 回归测试
 *
 * 覆盖（剧本 2.10 验收点 / procurementService.ts 询价家族 + procurementRoute.ts inquiries 端点）：
 *   ① 创建询价单：nextBusinessNumber(tx,'SI') 业务编号 + status=Open + 审计写入
 *   ② 状态机 Open → Compared → Closed（白名单外转移拒绝；终态 Closed 无出边）
 *   ③ 加报价：baseAmount = quoteAmount × exchangeRate 换算（含无汇率/非正汇率回退 1）
 *   ④ 比价决策 select：quoteId 不存在拒绝；存在时 Open→Compared 且中选快照落库
 *   ⑤ 软删除后不出现在列表（deletedAt 过滤）
 *   ⑥ 路由层入参过滤：POST /inquiries 白名单外字段丢弃；POST /:id/quotes 必填校验 400
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('../../events/businessEventBus', () => ({
  businessEventBus: { publish: vi.fn() },
  publishBusinessEvent: vi.fn(),
}));
vi.mock('../../entities/sync', () => ({
  syncPurchaseOrderReferences: vi.fn().mockResolvedValue(undefined),
  deactivateEntityLinks: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../shared/businessNumberService', () => ({
  nextBusinessNumber: vi.fn(async (_tx: unknown, prefix: string) => `${prefix}-2608-0001`),
}));
vi.mock('../../auth/middleware', () => ({
  // W-C 批三-E：路由写面挂 procurement:write scope 门（requirePermission 消费 actor.roles）——
  // mock actor 补 owner 角色（SuperAdmin 全放行）；userId 'u9' 语义不变（审计断言沿用）。
  extractActorFromRequest: vi.fn(() => ({ userId: 'u9', roles: ['owner'] })),
}));

import { createProcurementService } from '../procurementService';
import { createProcurementRouter } from '../procurementRoute';

/** 构造内存版 prisma mock（$transaction 内联执行；supplierInquiry 表按 state 读写） */
function makePrisma(seed: { inquiries?: any[]; factories?: any[] } = {}) {
  const state = {
    inquiries: [...(seed.inquiries ?? [])],
    factories: [...(seed.factories ?? [])],
    audits: [] as any[],
  };

  const applyWhere = (rows: any[], where: any = {}) => {
    let out = rows;
    if (where.deletedAt === null) out = out.filter(r => r.deletedAt == null);
    if (where.status) out = out.filter(r => r.status === where.status);
    return out;
  };

  const inquiryTable = {
    findUnique: async ({ where }: any) =>
      state.inquiries.find(r => r.id === where.id) ?? null,
    findMany: async ({ where }: any) => applyWhere(state.inquiries, where),
    count: async ({ where }: any) => applyWhere(state.inquiries, where).length,
    create: async ({ data }: any) => {
      const row = { ...data };
      state.inquiries.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const idx = state.inquiries.findIndex(r => r.id === where.id);
      if (idx < 0) throw new Error('record not found');
      state.inquiries[idx] = { ...state.inquiries[idx], ...data };
      return state.inquiries[idx];
    },
  };

  const prisma: any = {
    supplierInquiry: inquiryTable,
    // B2：报价门禁按 relationId 反查 FactoryProfile（身份真源 Relation → FactoryProfile 1:1）
    factoryProfile: {
      findUnique: async ({ where }: any) =>
        state.factories.find(r => r.relationId === where.relationId) ?? null,
    },
    auditLog: {
      create: async ({ data }: any) => {
        state.audits.push(data);
        return data;
      },
    },
    $transaction: async (fn: any) => fn(prisma),
  };
  return { prisma, state };
}

/** B2：正常供应商档案行（未拉黑/未删除） */
const makeFactory = (relationId: string, over: Record<string, any> = {}) => ({
  id: `FP_${relationId}`, relationId, blacklistedAt: null, blacklistReason: null, deletedAt: null, ...over,
});

const CREATE_INPUT = {
  description: '全棉汗布 GJ-2103 询价',
  materialCode: 'GJ-2103',
  quantity: 1500,
  unit: 'kg',
  currency: 'USD',
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ═══ 服务层 ═══
describe('供应商询价比价 service', () => {
  it('创建成功：生成 SI 业务编号 + status=Open + 写审计', async () => {
    const { prisma, state } = makePrisma();
    const svc = createProcurementService(prisma);
    const inquiry = await svc.createSupplierInquiry(CREATE_INPUT, 'u9');

    expect(inquiry.inquiryNumber).toBe('SI-2608-0001');
    expect(inquiry.status).toBe('Open');
    expect(inquiry.description).toBe(CREATE_INPUT.description);

    const audit = state.audits.find(a => a.action === 'create_supplier_inquiry');
    expect(audit).toBeTruthy();
    expect(audit.targetType).toBe('SupplierInquiry');
    expect(audit.targetId).toBe(inquiry.id);
    expect(audit.actorId).toBe('u9');
    expect(audit.operationType).toBe('create');
  });

  it('非法状态流转被拒：Closed 终态再 close/select 均拒绝；Compared 单不可重复 select', async () => {
    // Closed 终态：无出边（连 Closed→Closed 自转移都拒绝）
    const closedSeed = {
      id: 'SI_C1', inquiryNumber: 'SI-2608-0099', status: 'Closed',
      description: '已关闭询价', currency: 'USD',
      supplierQuotes: [], deletedAt: null, createdAt: 1, updatedAt: 1,
    };
    const a = makePrisma({ inquiries: [closedSeed] });
    await expect(
      createProcurementService(a.prisma).closeSupplierInquiry('SI_C1', 'u9'),
    ).rejects.toThrow(/询价单非法状态转换.*Closed/);

    const b = makePrisma({ inquiries: [closedSeed] });
    await expect(
      createProcurementService(b.prisma).selectSupplier('SI_C1', 'SQ_x', 'note', 'u9'),
    ).rejects.toThrow(/询价单非法状态转换.*Closed/);

    // Compared 状态：仅允许 →Closed，再次 select（目标仍是 Compared）为白名单外转移
    const comparedSeed = { ...closedSeed, status: 'Compared' };
    const c = makePrisma({ inquiries: [comparedSeed] });
    await expect(
      createProcurementService(c.prisma).selectSupplier('SI_C1', 'SQ_x', 'note', 'u9'),
    ).rejects.toThrow(/询价单非法状态转换.*Compared.*Closed/);
  });

  it('加报价：baseAmount=quoteAmount×exchangeRate；无汇率或非正汇率按 1 兜底；写审计', async () => {
    const seed = {
      id: 'SI_Q1', inquiryNumber: 'SI-2608-0002', status: 'Open',
      description: '比价单', currency: 'USD',
      supplierQuotes: [], deletedAt: null, createdAt: 1, updatedAt: 1,
    };
    const { prisma, state } = makePrisma({
      inquiries: [seed],
      factories: [makeFactory('REL-NT3'), makeFactory('REL-WX5')],
    });
    const svc = createProcurementService(prisma);

    const r1 = await svc.addSupplierQuote('SI_Q1', {
      supplierId: 'REL-NT3', supplierName: '南通三厂', quoteAmount: 5000, currency: 'CNY',
      exchangeRate: 7.25, quoteDate: '2026-08-25',
    }, 'u9');
    const q1 = (r1.supplierQuotes as any[])[0];
    expect(q1.baseAmount).toBe(36250); // 5000 × 7.25
    expect(q1.isSelected).toBe(false);

    const r2 = await svc.addSupplierQuote('SI_Q1', {
      supplierId: 'REL-WX5', supplierName: '无锡五厂', quoteAmount: 800, currency: 'USD',
      quoteDate: '2026-08-26', exchangeRate: -1,
    }, 'u9');
    const q2 = (r2.supplierQuotes as any[])[1];
    expect(q2.baseAmount).toBe(800); // 非正汇率 → 按 1

    const audit = state.audits.find(x => x.action === 'add_supplier_quote');
    expect(audit?.targetId).toBe('SI_Q1');
    expect(audit?.fieldPath).toBe('supplierQuotes');
  });

  it('updateQuote 改金额/汇率时重算 baseAmount', async () => {
    const seed = {
      id: 'SI_U1', inquiryNumber: 'SI-2608-0003', status: 'Open',
      description: '改价单', currency: 'USD',
      supplierQuotes: [{
        id: 'SQ_A1', supplierName: '常州厂', quoteAmount: 100, currency: 'USD',
        exchangeRate: 7, baseAmount: 700, quoteDate: '2026-08-01', isSelected: false,
      }],
      deletedAt: null, createdAt: 1, updatedAt: 1,
    };
    const { prisma } = makePrisma({ inquiries: [seed] });
    const svc = createProcurementService(prisma);
    const r = await svc.updateSupplierQuote('SI_U1', 'SQ_A1', { quoteAmount: 200 }, 'u9');
    const q = (r.supplierQuotes as any[])[0];
    expect(q.quoteAmount).toBe(200);
    expect(q.exchangeRate).toBe(7);
    expect(q.baseAmount).toBe(1400); // 200 × 7
  });

  it('select：quoteId 不存在拒绝且状态不变；存在时 Open→Compared 并落中选快照', async () => {
    const seed = {
      id: 'SI_S1', inquiryNumber: 'SI-2608-0004', status: 'Open',
      description: '决策单', currency: 'USD', buyer: '小王',
      supplierQuotes: [
        { id: 'SQ_W1', supplierId: 'REL-NANTONG', supplierName: '南通厂', quoteAmount: 100, currency: 'USD', baseAmount: 100, quoteDate: '2026-08-01', isSelected: false },
        { id: 'SQ_W2', supplierName: '苏州厂', quoteAmount: 120, currency: 'USD', baseAmount: 120, quoteDate: '2026-08-02', isSelected: false },
      ],
      deletedAt: null, createdAt: 1, updatedAt: 1,
    };
    const { prisma, state } = makePrisma({ inquiries: [seed] });
    const svc = createProcurementService(prisma);

    // 不存在的报价：无法比价决策
    await expect(
      svc.selectSupplier('SI_S1', 'SQ_NOPE', '', 'u9'),
    ).rejects.toThrow(/报价 SQ_NOPE 不存在于询价单 SI_S1/);
    expect(state.inquiries[0].status).toBe('Open'); // 状态未被污染

    // 存在中选报价：状态流转 + isSelected 标记 + 快照字段落库
    const updated = await svc.selectSupplier('SI_S1', 'SQ_W1', '南通厂价优交期短', 'u9');
    expect(updated.status).toBe('Compared');
    const row = state.inquiries[0];
    expect(row.selectedSupplierId).toBe('REL-NANTONG');
    expect(row.selectedSupplierName).toBe('南通厂');
    expect(row.decisionNote).toBe('南通厂价优交期短');
    expect(row.supplierQuotes.map((q: any) => q.isSelected)).toEqual([true, false]);

    const audit = state.audits.find(x => x.action === 'select_supplier');
    expect(audit?.operationType).toBe('transition');
    expect(audit?.beforeValue).toBe('Open');
    expect(audit?.afterValue).toBe('Compared');
  });

  it('软删后不出现在列表；且 getSupplierInquiry 返回 null', async () => {
    const { prisma } = makePrisma();
    const svc = createProcurementService(prisma);
    const created = await svc.createSupplierInquiry(CREATE_INPUT, 'u9');

    await svc.deleteSupplierInquiry(created.id, 'u9');

    const listed = await svc.listSupplierInquiries({});
    expect(listed.items).toHaveLength(0);
    expect(listed.total).toBe(0);
    expect(await svc.getSupplierInquiry(created.id)).toBeNull();
  });

  it('close：Compared→Closed 合法流转并写审计', async () => {
    const comparedSeed = {
      id: 'SI_CC1', inquiryNumber: 'SI-2608-0011', status: 'Compared',
      description: '待关闭', currency: 'USD',
      supplierQuotes: [], selectedSupplierName: '南通厂',
      deletedAt: null, createdAt: 1, updatedAt: 1,
    };
    const { prisma, state } = makePrisma({ inquiries: [comparedSeed] });
    const updated = await createProcurementService(prisma).closeSupplierInquiry('SI_CC1', 'u9');
    expect(updated.status).toBe('Closed');
    const audit = state.audits.find(x => x.action === 'close_supplier_inquiry');
    expect(audit?.afterValue).toBe('Closed');
  });

  // ── C9：询价比价撤回（Compared → Open） ──
  it('C9 撤回比价：Compared → Open，中选快照/决策备注清除、报价保留且 isSelected 清零、写审计', async () => {
    const comparedSeed = {
      id: 'SI_RV1', inquiryNumber: 'SI-2608-0021', status: 'Compared',
      description: '撤回单', currency: 'USD',
      supplierQuotes: [
        { id: 'SQ_R1', supplierId: 'REL-NANTONG', supplierName: '南通厂', quoteAmount: 100, currency: 'USD', baseAmount: 100, quoteDate: '2026-08-01', isSelected: true },
        { id: 'SQ_R2', supplierName: '苏州厂', quoteAmount: 120, currency: 'USD', baseAmount: 120, quoteDate: '2026-08-02', isSelected: false },
      ],
      selectedSupplierId: 'REL-NANTONG', selectedSupplierName: '南通厂', decisionNote: '价优',
      deletedAt: null, createdAt: 1, updatedAt: 1,
    };
    const { prisma, state } = makePrisma({ inquiries: [comparedSeed] });
    const svc = createProcurementService(prisma);

    const updated = await svc.updateSupplierInquiry('SI_RV1', { status: 'Open' } as any, 'u9');
    expect(updated.status).toBe('Open');
    const row = state.inquiries[0];
    expect(row.selectedSupplierId).toBeNull();
    expect(row.selectedSupplierName).toBeNull();
    expect(row.decisionNote).toBeNull();
    // 报价行保留（可重新决策），isSelected 全清零
    expect(row.supplierQuotes).toHaveLength(2);
    expect(row.supplierQuotes.map((q: any) => q.isSelected)).toEqual([false, false]);

    const audit = state.audits.find(x => x.action === 'reopen_supplier_inquiry');
    expect(audit).toBeTruthy();
    expect(audit.operationType).toBe('transition');
    expect(audit.beforeValue).toBe('Compared');
    expect(audit.afterValue).toBe('Open');
    // 决策留痕转审计（before 快照保留原中选信息）
    expect(audit.detail.before.selectedSupplierName).toBe('南通厂');

    // 撤回后回到 Open：可重新比价决策
    const reselected = await svc.selectSupplier('SI_RV1', 'SQ_R2', '改选苏州厂', 'u9');
    expect(reselected.status).toBe('Compared');
    expect(state.inquiries[0].selectedSupplierName).toBe('苏州厂');
  });

  it('C9 非 Compared 状态撤回拒绝：Open 单撤回（无决策可撤）与 Closed 终态撤回均报错', async () => {
    const openSeed = {
      id: 'SI_RV2', inquiryNumber: 'SI-2608-0022', status: 'Open',
      description: '询价中', currency: 'USD', supplierQuotes: [],
      deletedAt: null, createdAt: 1, updatedAt: 1,
    };
    // Open → Compared 走更新接口：越权绕开 selectSupplier，拒绝并指向专属入口
    const a = makePrisma({ inquiries: [openSeed] });
    await expect(
      createProcurementService(a.prisma).updateSupplierInquiry('SI_RV2', { status: 'Compared' } as any, 'u9'),
    ).rejects.toThrow(/专属操作/);

    const closedSeed = { ...openSeed, id: 'SI_RV3', status: 'Closed' };
    const b = makePrisma({ inquiries: [closedSeed] });
    await expect(
      createProcurementService(b.prisma).updateSupplierInquiry('SI_RV3', { status: 'Open' } as any, 'u9'),
    ).rejects.toThrow(/询价单非法状态转换/);

    // Compared → Closed 走更新接口：同样拒绝（须走 closeSupplierInquiry 专属入口）
    const comparedSeed = { ...openSeed, id: 'SI_RV4', status: 'Compared' };
    const c = makePrisma({ inquiries: [comparedSeed] });
    await expect(
      createProcurementService(c.prisma).updateSupplierInquiry('SI_RV4', { status: 'Closed' } as any, 'u9'),
    ).rejects.toThrow(/专属操作/);
  });
});

// ═══ B2：报价供应商档案门禁（黑名单/档案外/手打名称 一律拒绝） ═══
describe('供应商报价黑名单门禁（B2）', () => {
  const openInquiry = (id: string) => ({
    id, inquiryNumber: `SI-2608-${id.slice(-4)}`, status: 'Open',
    description: 'B2 门禁单', currency: 'USD',
    supplierQuotes: [], deletedAt: null, createdAt: 1, updatedAt: 1,
  });
  const QUOTE = { quoteAmount: 1000, currency: 'CNY', quoteDate: '2026-08-28' } as const;

  it('黑名单供应商报价 → 拒绝，文案「该供应商已被拉黑，禁止报价」，且不落数据/不写审计', async () => {
    const { prisma, state } = makePrisma({
      inquiries: [openInquiry('SI_BL1')],
      factories: [makeFactory('REL-BLACK', { blacklistedAt: 1750000000000, blacklistReason: '质量事故' })],
    });
    const svc = createProcurementService(prisma);

    await expect(
      svc.addSupplierQuote('SI_BL1', { supplierId: 'REL-BLACK', supplierName: '黑心厂', ...QUOTE }, 'u9'),
    ).rejects.toThrow('该供应商已被拉黑，禁止报价');
    expect(state.inquiries[0].supplierQuotes).toHaveLength(0);
    expect(state.audits.find(x => x.action === 'add_supplier_quote')).toBeUndefined();
  });

  it('档案外供应商（supplierId 查无档案）→ 拒绝并提示不存在于供应商档案', async () => {
    const { prisma, state } = makePrisma({ inquiries: [openInquiry('SI_BL2')] });
    const svc = createProcurementService(prisma);

    await expect(
      svc.addSupplierQuote('SI_BL2', { supplierId: 'REL-GHOST', supplierName: '影子厂', ...QUOTE }, 'u9'),
    ).rejects.toThrow(/不存在于供应商档案，禁止报价/);
    expect(state.inquiries[0].supplierQuotes).toHaveLength(0);
  });

  it('缺 supplierId（手打供应商名称旁路）→ 拒绝', async () => {
    const { prisma, state } = makePrisma({ inquiries: [openInquiry('SI_BL3')] });
    const svc = createProcurementService(prisma);

    await expect(
      svc.addSupplierQuote('SI_BL3', { supplierName: '手打厂', ...QUOTE }, 'u9'),
    ).rejects.toThrow(/supplierId 必填/);
    expect(state.inquiries[0].supplierQuotes).toHaveLength(0);
  });

  it('正常供应商报价 → 成功落库', async () => {
    const { prisma, state } = makePrisma({
      inquiries: [openInquiry('SI_BL4')],
      factories: [makeFactory('REL-GOOD')],
    });
    const svc = createProcurementService(prisma);

    const updated = await svc.addSupplierQuote('SI_BL4', { supplierId: 'REL-GOOD', supplierName: '正规厂', ...QUOTE }, 'u9');
    const quotes = updated.supplierQuotes as any[];
    expect(quotes).toHaveLength(1);
    expect(quotes[0].supplierId).toBe('REL-GOOD');
    expect(quotes[0].supplierName).toBe('正规厂');
    expect(state.audits.find(x => x.action === 'add_supplier_quote')).toBeTruthy();
  });

  it('编辑报价改动供应商身份为黑名单供应商 → 拒绝；仅改金额不拦（兼容存量手打报价）', async () => {
    const seed = {
      ...openInquiry('SI_BL5'),
      supplierQuotes: [{
        id: 'SQ_L1', supplierId: 'REL-GOOD', supplierName: '正规厂', quoteAmount: 100, currency: 'USD',
        baseAmount: 100, quoteDate: '2026-08-01', isSelected: false,
      }],
    };
    const { prisma, state } = makePrisma({
      inquiries: [seed],
      factories: [makeFactory('REL-GOOD'), makeFactory('REL-BLACK', { blacklistedAt: 1750000000000 })],
    });
    const svc = createProcurementService(prisma);

    // 改动供应商身份 → 黑名单：拒绝
    await expect(
      svc.updateSupplierQuote('SI_BL5', 'SQ_L1', { supplierId: 'REL-BLACK', supplierName: '黑心厂' }, 'u9'),
    ).rejects.toThrow('该供应商已被拉黑，禁止报价');
    expect((state.inquiries[0].supplierQuotes as any[])[0].supplierId).toBe('REL-GOOD'); // 未被污染

    // 仅改金额（不动供应商身份）：放行
    const ok = await svc.updateSupplierQuote('SI_BL5', 'SQ_L1', { quoteAmount: 200 }, 'u9');
    expect((ok.supplierQuotes as any[])[0].quoteAmount).toBe(200);
  });
});

// ═══ 路由层：入参白名单过滤 ═══
describe('供应商询价比价 route — 入参过滤', () => {
  function makeApp(prisma: any) {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/procurement', createProcurementRouter({
      prisma, requireAuth: false, apiKeys: new Set<string>(),
    }));
    return app;
  }

  it('POST /inquiries 丢弃白名单外字段（防客户端写入非法字段）', async () => {
    const { prisma, state } = makePrisma();
    const res = await request(makeApp(prisma))
      .post('/api/v1/procurement/inquiries')
      .send({ ...CREATE_INPUT, hackerField: 'DROP TABLE users', status: 'Closed' });

    expect(res.status).toBe(201);
    expect(res.body.inquiry.inquiryNumber).toBe('SI-2608-0001');
    const persisted = state.inquiries[0];
    expect(persisted.hackerField).toBeUndefined();
    expect(persisted.status).toBe('Open'); // body 里伪造的 status 未透传
    expect(persisted.description).toBe(CREATE_INPUT.description);
    expect(persisted.currency).toBe(CREATE_INPUT.currency);
  });

  it('C9 路由：PUT /inquiries/:id 携带 status=Open → 已比价单撤回 200；Closed 单撤回 409', async () => {
    const comparedSeed = {
      id: 'SI_RV9', inquiryNumber: 'SI-2608-0029', status: 'Compared',
      description: '路由撤回单', currency: 'USD',
      supplierQuotes: [
        { id: 'SQ_R9', supplierId: 'REL-GOOD', supplierName: '正规厂', quoteAmount: 100, currency: 'USD', baseAmount: 100, quoteDate: '2026-08-01', isSelected: true },
      ],
      selectedSupplierId: 'REL-GOOD', selectedSupplierName: '正规厂', decisionNote: '价优',
      deletedAt: null, createdAt: 1, updatedAt: 1,
    };
    const { prisma, state } = makePrisma({ inquiries: [comparedSeed] });
    const app = makeApp(prisma);

    const ok = await request(app)
      .put('/api/v1/procurement/inquiries/SI_RV9')
      .send({ status: 'Open' });
    expect(ok.status).toBe(200);
    expect(ok.body.inquiry.status).toBe('Open');
    expect(state.inquiries[0].selectedSupplierName).toBeNull();
    expect(state.inquiries[0].supplierQuotes[0].isSelected).toBe(false);

    const closedSeed = { ...comparedSeed, id: 'SI_RV10', status: 'Closed' };
    const b = makePrisma({ inquiries: [closedSeed] });
    const denied = await request(makeApp(b.prisma))
      .put('/api/v1/procurement/inquiries/SI_RV10')
      .send({ status: 'Open' });
    expect(denied.status).toBe(409);
  });

  it('POST /inquiries/:id/quotes 缺必填字段返回 400 且不落数据', async () => {
    const seed = {
      id: 'SI_R1', inquiryNumber: 'SI-2608-0012', status: 'Open',
      description: '缺参校验', currency: 'USD',
      supplierQuotes: [], deletedAt: null, createdAt: 1, updatedAt: 1,
    };
    const { prisma, state } = makePrisma({ inquiries: [seed] });
    const res = await request(makeApp(prisma))
      .post('/api/v1/procurement/inquiries/SI_R1/quotes')
      .send({ supplierName: '南通厂', quoteAmount: 99 }); // 缺 currency / quoteDate

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('缺少必填字段');
    expect(state.inquiries[0].supplierQuotes).toHaveLength(0); // 未写入
  });

  it('POST /inquiries/:id/quotes 黑名单供应商 → 403 + 文案「该供应商已被拉黑，禁止报价」；正常供应商 → 201', async () => {
    const seed = {
      id: 'SI_R2', inquiryNumber: 'SI-2608-0013', status: 'Open',
      description: 'B2 路由门禁', currency: 'USD',
      supplierQuotes: [], deletedAt: null, createdAt: 1, updatedAt: 1,
    };
    const { prisma, state } = makePrisma({
      inquiries: [seed],
      factories: [makeFactory('REL-BLACK', { blacklistedAt: 1750000000000 }), makeFactory('REL-GOOD')],
    });
    const app = makeApp(prisma);

    // 黑名单供应商报价 → 403 + 指定文案
    const denied = await request(app)
      .post('/api/v1/procurement/inquiries/SI_R2/quotes')
      .send({ supplierId: 'REL-BLACK', supplierName: '黑心厂', quoteAmount: 99, currency: 'CNY', quoteDate: '2026-08-28' });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('该供应商已被拉黑，禁止报价');
    expect(state.inquiries[0].supplierQuotes).toHaveLength(0); // 未落数据

    // 档案外供应商 → 404
    const ghost = await request(app)
      .post('/api/v1/procurement/inquiries/SI_R2/quotes')
      .send({ supplierId: 'REL-GHOST', supplierName: '影子厂', quoteAmount: 99, currency: 'CNY', quoteDate: '2026-08-28' });
    expect(ghost.status).toBe(404);
    expect(ghost.body.error).toContain('不存在于供应商档案');

    // 正常供应商报价 → 201 成功
    const ok = await request(app)
      .post('/api/v1/procurement/inquiries/SI_R2/quotes')
      .send({ supplierId: 'REL-GOOD', supplierName: '正规厂', quoteAmount: 99, currency: 'CNY', quoteDate: '2026-08-28' });
    expect(ok.status).toBe(201);
    const quotes = ok.body.inquiry.supplierQuotes as any[];
    expect(quotes).toHaveLength(1);
    expect(quotes[0].supplierId).toBe('REL-GOOD');
  });
});

describe('inquiry locked authorization and stale snapshot guards', () => {
  it.each(['update','delete','add','edit','remove','select','close','reopen'])('%s cannot write after concurrent source reassignment', async action=>{
    const inquiry={id:'IQ1',inquiryNumber:'IQ-1',orderId:'O2',status:action==='reopen'?'Compared':'Open',updatedAt:1n,deletedAt:null,supplierQuotes:[{id:'Q1',supplierId:'S1',supplierName:'Supplier',quoteAmount:1,currency:'CNY'}]};
    const f=makePrisma({inquiries:[inquiry],factories:[makeFactory('S1')]});
    f.prisma.$queryRaw=vi.fn(async()=>[{...inquiry}]);
    const svc=createProcurementService(f.prisma), opts={expectedOrderId:'O1'};
    const call=action==='update'?()=>svc.updateSupplierInquiry('IQ1',{description:'New'},'buyer',opts):action==='delete'?()=>svc.deleteSupplierInquiry('IQ1','buyer',opts):action==='add'?()=>svc.addSupplierQuote('IQ1',{supplierId:'S1',supplierName:'Supplier',quoteAmount:1,currency:'CNY'} as any,'buyer',opts):action==='edit'?()=>svc.updateSupplierQuote('IQ1','Q1',{quoteAmount:2},'buyer',opts):action==='remove'?()=>svc.removeSupplierQuote('IQ1','Q1','buyer',opts):action==='select'?()=>svc.selectSupplier('IQ1','Q1','Decision','buyer',opts):action==='close'?()=>svc.closeSupplierInquiry('IQ1','buyer',opts):()=>svc.updateSupplierInquiry('IQ1',{status:'Open'},'buyer',opts);
    await expect(call()).rejects.toMatchObject({status:409});expect(f.state.audits).toHaveLength(0);expect(f.state.inquiries[0]).toEqual(inquiry);
  });
});
