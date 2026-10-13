/**
 * REQ2-19 砍价画像回归测试（设计文档 §5，DR-060）
 *
 * 覆盖：
 *   ① 版本快照：Draft 编辑金额变化 → 旧版 append QuotationVersion + version+1；金额不变不快照
 *   ② revise：Draft/Sent 显式修订（快照+version+1+回 Draft）；终态 409 语义（错误消息）
 *   ③ 画像聚合：首报 vs 当前降幅 Σ；成交偏差（convertedOrderId → Order.totalNet）
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('../moq/moqConfigService', () => ({ createMoqConfigService: vi.fn(() => ({})) }));
vi.mock('../moq/moqResolutionService', () => ({ createMoqResolutionService: vi.fn(() => ({})) }));
vi.mock('../moq/moqValidationService', () => ({ createMoqValidationService: vi.fn(() => ({ validateCreate: vi.fn().mockResolvedValue({ ok: true }) })) }));
vi.mock('../../approvals/approvalRoutingService', () => ({ createApprovalRoutingService: vi.fn(() => ({})) }));
vi.mock('../../approvals/approvalCreateService', () => ({ createApprovalCreateService: vi.fn(() => ({})) }));

import { createQuotationService } from '../quotationService';

function makePrisma(seed: { quotations?: any[]; versions?: any[]; orders?: any[] } = {}) {
  const state = {
    quotations: [...(seed.quotations ?? [])],
    versions: [...(seed.versions ?? [])],
    orders: [...(seed.orders ?? [])],
    auditLogs: [] as any[],
  };
  // Native ownership tables used by the real fail-closed material checker.
  // No matching F-1/customer-code row is known in this generic version fixture.
  const ownership: Record<string, any[]> = { productAsset: [], fabricProfile: [], fabricCustomerCode: [] };
  const fields: Record<string, Set<string>> = {
    productAsset: new Set(['id', 'sku', 'deletedAt']),
    fabricProfile: new Set(['articleNo', 'millQuality', 'deletedAt']),
    fabricCustomerCode: new Set(['clientCode', 'customerOrganizationId', 'productAssetId', 'isExclusive', 'deletedAt']),
  };
  function validateWhere(model: string, where: any): void {
    for (const [key, value] of Object.entries(where ?? {})) {
      if (key === 'OR') {
        if (!Array.isArray(value)) throw new Error('UNSUPPORTED_OWNERSHIP_OR');
        value.forEach(part => validateWhere(model, part));
      } else {
        if (!fields[model].has(key)) throw new Error('UNSUPPORTED_OWNERSHIP_FIELD:' + key);
        if (value && typeof value === 'object' && (!('in' in value) || !Array.isArray((value as any).in)))
          throw new Error('UNSUPPORTED_OWNERSHIP_OPERATOR');
      }
    }
  }
  function matches(row: any, where: any): boolean {
    return Object.entries(where ?? {}).every(([key, value]: any) => key === 'OR'
      ? value.some((part: any) => matches(row, part))
      : value && typeof value === 'object' ? value.in.includes(row[key]) : value === null ? row[key] == null : row[key] === value);
  }
  const ownershipDelegate = (model: string) => ({ findMany: async ({ where, select }: any) => {
    validateWhere(model, where);
    return ownership[model].filter(row => matches(row, where)).map(row => select
      ? Object.fromEntries(Object.keys(select).filter(key => select[key]).map(key => [key, row[key]])) : { ...row });
  } });
  const prisma: any = {
    productAsset: { ...ownershipDelegate('productAsset'), findFirst: async () => ({id:'P1',sku:'F-1',name:'面料',mainCategory:'Fabric'}) },
    fabricProfile: ownershipDelegate('fabricProfile'),
    fabricCustomerCode: ownershipDelegate('fabricCustomerCode'),
    quotation: {
      findUnique: async ({ where, include }: any) => {
        const q = state.quotations.find(x => x.id === where.id);
        if (!q) return null;
        return include?.lines ? { ...q, lines: q.lines ?? [] } : { ...q };
      },
      findMany: async ({ where, orderBy, select }: any) => {
        let rows = state.quotations.filter(q => {
          if (where?.deletedAt === null && q.deletedAt != null) return false;
          if (where?.customerRelationId && q.customerRelationId !== where.customerRelationId) return false;
          return true;
        });
        if (orderBy?.createdAt === 'desc') rows = [...rows].sort((a, b) => b.createdAt - a.createdAt);
        return rows.map(q => (select ? Object.fromEntries(Object.keys(select).map(k => [k, q[k]])) : q));
      },
      update: async ({ where, data, include }: any) => {
        const q = state.quotations.find(x => x.id === where.id);
        const applied: any = {};
        for (const [k, v] of Object.entries(data)) {
          if (v !== undefined) { (q as any)[k] = v; applied[k] = v; } // Prisma 语义：undefined = 不更新
        }
        return include?.lines ? { ...q, lines: q.lines ?? [] } : { ...q };
      },
    },
    quotationVersion: {
      findMany: async ({ where, orderBy }: any) => {
        let rows = state.versions.filter(v => {
          if (where?.quotationId?.in) {
            if (!where.quotationId.in.includes(v.quotationId)) return false;
          } else if (where?.quotationId && v.quotationId !== where.quotationId) return false;
          return true;
        });
        if (orderBy?.version === 'asc') rows = [...rows].sort((a, b) => a.version - b.version);
        return rows;
      },
      create: async ({ data }: any) => { state.versions.push(data); return data; },
    },
    order: {
      findMany: async ({ where }: any) =>
        state.orders.filter(o => (where?.id?.in ? where.id.in.includes(o.id) : true)),
    },
    quotationLine: {
      deleteMany: async ({ where }: any) => { return { count: 0 }; },
      createMany: async ({ data }: any) => { return { count: data.length }; },
    },
    auditLog: { create: async ({ data }: any) => { state.auditLogs.push(data); return { id: data.id }; } },
    // syncQuotationReferences 图谱同步（EntityLink/EntityReference upsert 空实现）
    entityReference: { upsert: async () => ({}), findMany: async () => [], update: async () => ({}) },
    entityLink: { upsert: async () => ({}), findMany: async () => [], update: async () => ({}), deleteMany: async () => ({ count: 0 }) },
    $queryRaw:vi.fn().mockResolvedValue([]), // Required Quote-first lock seam; business state is re-read above.
    $transaction: async (fn: any) => fn(prisma),
  };
  return { prisma, state };
}

beforeEach(() => { vi.clearAllMocks(); });

const BASE_Q = (overrides: any = {}) => ({
  id: 'QT-1', quotationNumber: 'QT-20260820-001', status: 'Draft', currency: 'USD',
  quotationType:'Fabric', notes:null, totalAmount: 1000, version: 1, customerRelationId: 'REL-1', customerName: 'Peerless',
  issueDate: '2026-08-20', deletedAt: null, createdAt: 1000,
  lines: [{ id:'QL-1', productAssetId:'P1', productType:'Fabric', lineNumber: 1, fabricCode: 'F-1', description: '面料', quantity: 100, unit: 'YD', unitPrice: 10, amount: 1000 }],
  ...overrides,
});

describe('updateQuotation 版本快照（DR-060-①）', () => {
  it('金额变化 → 快照旧版 + version+1', async () => {
    const { prisma, state } = makePrisma({ quotations: [BASE_Q()] });
    const svc = createQuotationService(prisma);
    await svc.updateQuotation('QT-1', {
      lines: [{ productAssetId:'P1', fabricCode: 'F-1', description: '面料', quantity: 100, unit: 'YD', unitPrice: 9 }], // 900
    } as any, 'u_sales');
    expect(state.versions).toHaveLength(1);
    expect(state.versions[0].version).toBe(1);
    expect(Number(state.versions[0].totalAmount)).toBe(1000); // 旧版快照
    expect(state.versions[0].linesSnapshot[0].unitPrice).toBe(10);
    expect(state.quotations[0].version).toBe(2);
  });

  it('对客备注变化也冻结旧版并递增', async () => {
    const { prisma, state } = makePrisma({ quotations: [BASE_Q()] });
    const svc = createQuotationService(prisma);
    await svc.updateQuotation('QT-1', { notes: '备注更新' } as any, 'u_sales');
    expect(state.versions).toHaveLength(1);
    expect(state.quotations[0].version).toBe(2);
  });

  it('Sent 状态编辑 → 拒绝（仅 Draft 可编辑）', async () => {
    const { prisma } = makePrisma({ quotations: [BASE_Q({ status: 'Sent' })] });
    const svc = createQuotationService(prisma);
    await expect(svc.updateQuotation('QT-1', { notes: 'x' } as any, 'u'))
      .rejects.toThrow('仅 Draft 状态可编辑');
  });
});

describe('reviseQuotation 显式修订（DR-060-①）', () => {
  it('Sent 修订：快照当前版 + version+1 + 回 Draft + 审计', async () => {
    const { prisma, state } = makePrisma({ quotations: [BASE_Q({ status: 'Sent', version: 1 })] });
    const svc = createQuotationService(prisma);
    const r = await svc.reviseQuotation('QT-1', '客户砍价 8%', 'u_sales');
    expect(state.versions).toHaveLength(1);
    expect(state.versions[0].changeReason).toBe('客户砍价 8%');
    expect(state.quotations[0].version).toBe(2);
    expect(state.quotations[0].status).toBe('Draft');
    expect(state.auditLogs.some(a => a.action === 'revise_quotation')).toBe(true);
    expect((r as any).version).toBe(2);
  });

  it('Accepted 终态不可修订', async () => {
    const { prisma } = makePrisma({ quotations: [BASE_Q({ status: 'Accepted' })] });
    const svc = createQuotationService(prisma);
    await expect(svc.reviseQuotation('QT-1', 'x', 'u')).rejects.toThrow('仅 Draft/Sent 可修订');
  });

  it('版本历史正序', async () => {
    const { prisma } = makePrisma({
      quotations: [BASE_Q({ version: 3 })],
      versions: [
        { quotationId: 'QT-1', version: 2, totalAmount: 950 },
        { quotationId: 'QT-1', version: 1, totalAmount: 1000 },
      ],
    });
    const svc = createQuotationService(prisma);
    const versions = await svc.listQuotationVersions('QT-1');
    expect(versions.map(v => v.version)).toEqual([1, 2]);
  });
});

describe('getPriceProfile 画像聚合（DR-060-②）', () => {
  it('首报 vs 当前降幅 + 成交偏差 + 汇总统计', async () => {
    const { prisma } = makePrisma({
      quotations: [
        BASE_Q({ id: 'QT-1', totalAmount: 900, version: 3, status: 'Accepted', convertedOrderId: 'ORD-1', createdAt: 2000 }),
        BASE_Q({ id: 'QT-2', quotationNumber: 'QT-20260820-002', totalAmount: 800, version: 2, status: 'Sent', createdAt: 1000 }),
        BASE_Q({ id: 'QT-3', quotationNumber: 'QT-20260820-003', totalAmount: 500, version: 1, status: 'Draft', createdAt: 3000 }),
      ],
      versions: [
        { quotationId: 'QT-1', version: 1, totalAmount: 1000 },
        { quotationId: 'QT-1', version: 2, totalAmount: 950 },
        { quotationId: 'QT-2', version: 1, totalAmount: 800 },
      ],
      orders: [{ id: 'ORD-1', totalNet: 920, poNumber: 'PO-1' }],
    });
    const svc = createQuotationService(prisma);
    const p = await svc.getPriceProfile('REL-1');

    expect(p.items).toHaveLength(3);
    const q1 = p.items.find(i => i.quotationId === 'QT-1');
    expect(q1.firstAmount).toBe(1000); // 最早快照 v1
    expect(q1.currentAmount).toBe(900);
    expect(q1.cutPct).toBe(-10); // (900-1000)/1000
    expect(q1.rounds).toBe(2);
    expect(q1.orderPo).toBe('PO-1');
    expect(q1.dealDeviationPct).toBe(-8); // (920-1000)/1000
    const q2 = p.items.find(i => i.quotationId === 'QT-2');
    expect(q2.cutPct).toBe(0); // v1 快照=当前（800=800，revise 后未改价）
    const q3 = p.items.find(i => i.quotationId === 'QT-3');
    expect(q3.firstAmount).toBe(500); // 无快照 → 当前即首报

    expect(p.summary.quotationCount).toBe(3);
    expect(p.summary.negotiatedCount).toBe(1); // 仅 QT-1 有降幅
    expect(p.summary.avgCutPct).toBe(-10);
    expect(p.summary.maxCutPct).toBe(-10);
    expect(p.summary.dealtCount).toBe(1);
    expect(p.summary.avgDealDeviationPct).toBe(-8);
  });

  it('无报价 → 空画像', async () => {
    const { prisma } = makePrisma();
    const svc = createQuotationService(prisma);
    const p = await svc.getPriceProfile('REL-X');
    expect(p.items).toHaveLength(0);
    expect(p.summary).toBeNull();
  });
});
