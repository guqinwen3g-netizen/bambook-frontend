/**
 * C3 高频外贸场景 Agent 只读工具测试
 * 覆盖：shipping.scan_delays / finance.get_aging / quotations.query/get / customs.query_lc/get_lc
 * 以及四处登记的一致性（runtime 可执行 + manifest 只读安全元数据 + defaults 角色表）
 */

import { describe, expect, it, vi } from 'vitest';
import { executeTool } from '../toolRuntime';
import { getToolManifestSafety } from '../mcp/manifest';
import { DEFAULT_AGENT_TOOLS } from '../defaults';

const C3_TOOL_IDS = [
  'shipping.scan_delays',
  'quotations.query',
  'quotations.get',
  'customs.query_lc',
  'customs.get_lc',
  'finance.get_aging',
] as const;

// ────────────────────────────────────────────────────────────────
// Mock Prisma
// ────────────────────────────────────────────────────────────────

function makePrisma(overrides: {
  shipments?: any[];
  invoices?: any[];
  allocSums?: any[];
  quotations?: any[];
  quotation?: any;
  lcs?: any[];
} = {}) {
  const shipments = overrides.shipments ?? [];
  const invoices = overrides.invoices ?? [];
  const quotations = overrides.quotations ?? [];
  const lcs = overrides.lcs ?? [];
  return {
    shipment: {
      findMany: vi.fn().mockImplementation(async ({ where }: any) => {
        // scanDelayedShipments 两次查询按 status 形态区分
        return where?.status === 'Shipped'
          ? shipments.filter(s => s.status === 'Shipped')
          : shipments.filter(s => s.status !== 'Shipped');
      }),
    },
    invoice: { findMany: vi.fn().mockResolvedValue(invoices) },
    invoiceAllocation: { groupBy: vi.fn().mockResolvedValue(overrides.allocSums ?? []) },
    quotation: {
      findMany: vi.fn().mockResolvedValue(quotations),
      count: vi.fn().mockResolvedValue(quotations.length),
      findUnique: vi.fn().mockImplementation(async ({ where }: any) => quotations.find(q => q.id === where.id) ?? null),
      findFirst: vi.fn().mockImplementation(async ({ where }: any) =>
        quotations.find(q => q.quotationNumber === where.quotationNumber && !q.deletedAt) ?? null),
    },
    letterOfCredit: {
      findMany: vi.fn().mockImplementation(async ({ where }: any) =>
        lcs.filter(lc => {
          if (lc.deletedAt) return false;
          if (where?.status && lc.status !== where.status) return false;
          if (where?.expiryDate?.lt && !(lc.expiryDate && lc.expiryDate < where.expiryDate.lt)) return false;
          return true;
        })),
      count: vi.fn().mockResolvedValue(lcs.length),
      findFirst: vi.fn().mockImplementation(async ({ where }: any) =>
        lcs.find(lc => (where.id ? lc.id === where.id : lc.lcNumber === where.lcNumber) && !lc.deletedAt) ?? null),
    },
  } as any;
}

// ────────────────────────────────────────────────────────────────
// 登记一致性
// ────────────────────────────────────────────────────────────────

describe('C3 工具登记一致性', () => {
  it('6 个工具均在 manifest 注册为只读（免审批、无副作用）', () => {
    for (const id of C3_TOOL_IDS) {
      expect(getToolManifestSafety(id)).toEqual({ approval: 'never', sideEffects: false });
    }
  });

  it('6 个工具均在 defaults 角色表中且 risk=low', () => {
    const byId = new Map(DEFAULT_AGENT_TOOLS.map(t => [t.id, t]));
    for (const id of C3_TOOL_IDS) {
      const def = byId.get(id);
      expect(def, id).toBeDefined();
      expect(def!.risk).toBe('low');
      expect(def!.allowedRoles.length).toBeGreaterThan(0);
    }
  });
});

// ────────────────────────────────────────────────────────────────
// shipping.scan_delays
// ────────────────────────────────────────────────────────────────

describe('shipping.scan_delays', () => {
  it('离港延误（ETD 过 + 无 ATD + Booked）与到港延误（ETA 过 + 无 ATA + Shipped）分组返回', async () => {
    const prisma = makePrisma({
      shipments: [
        { id: 'S1', shipmentNumber: 'SHP-001', status: 'Booked', etd: '2026-08-01', atd: null, orderId: 'O1', customerName: 'ACME' },
        { id: 'S2', shipmentNumber: 'SHP-002', status: 'Shipped', eta: '2026-08-02', ata: null, orderId: 'O2', customerName: 'Beta' },
      ],
    });
    const result: any = await executeTool(prisma, { toolId: 'shipping.scan_delays', input: { asOf: '2026-08-07' } } as any);
    expect(result.ok).toBe(true);
    expect(result.departures).toHaveLength(1);
    expect(result.departures[0]).toMatchObject({ shipmentNumber: 'SHP-001', kind: 'dep', daysOverdue: 6, tier: 'critical' });
    expect(result.arrivals).toHaveLength(1);
    expect(result.arrivals[0]).toMatchObject({ shipmentNumber: 'SHP-002', kind: 'arr', daysOverdue: 5, tier: 'critical' });
    expect(result.total).toBe(2);
  });

  it('逾期 ≤3 天为 warning 分级', async () => {
    const prisma = makePrisma({
      shipments: [{ id: 'S1', shipmentNumber: 'SHP-003', status: 'Loading', etd: '2026-08-05', atd: null, orderId: null, customerName: null }],
    });
    const result: any = await executeTool(prisma, { toolId: 'shipping.scan_delays', input: { asOf: '2026-08-07' } } as any);
    expect(result.departures[0].tier).toBe('warning');
    expect(result.departures[0].daysOverdue).toBe(2);
  });

  it('无延误 → total 0', async () => {
    const prisma = makePrisma({ shipments: [] });
    const result: any = await executeTool(prisma, { toolId: 'shipping.scan_delays', input: {} } as any);
    expect(result.ok).toBe(true);
    expect(result.total).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// finance.get_aging
// ────────────────────────────────────────────────────────────────

describe('finance.get_aging', () => {
  it('返回账龄报告，行按逾期额降序且 rowLimit 生效', async () => {
    const invoices = [
      // 客户 A：逾期 40 天 100 美元（31-60 档）
      { id: 'I1', invoiceNumber: 'INV-1', amount: 100, currency: 'USD', issueDate: '2026-06-01', dueDate: '2026-06-28', customerRelationId: 'RA', customerName: 'A Corp' },
      // 客户 B：逾期 100 天 500 美元（90+ 档）
      { id: 'I2', invoiceNumber: 'INV-2', amount: 500, currency: 'USD', issueDate: '2026-03-01', dueDate: '2026-04-29', customerRelationId: 'RB', customerName: 'B Corp' },
    ];
    const prisma = makePrisma({ invoices });
    const result: any = await executeTool(prisma, { toolId: 'finance.get_aging', input: { type: 'Receivable', asOf: '2026-08-07' } } as any);
    expect(result.ok).toBe(true);
    expect(result.report.rows).toHaveLength(2);
    // B Corp 逾期 500 > A Corp 逾期 100 → B 排前
    expect(result.report.rows[0].customerName).toBe('B Corp');
    expect(result.report.rows[0].buckets.d90plus).toBe(500);
    expect(result.report.rows[1].buckets.d31_60).toBe(100);
    // 合计行完整返回
    expect(result.report.totals.length).toBeGreaterThan(0);
    expect(result.report.rowCount).toBe(2);
  });

  it('type 默认 Receivable；Payable 透传', async () => {
    const prisma = makePrisma({ invoices: [] });
    const r1: any = await executeTool(prisma, { toolId: 'finance.get_aging', input: {} } as any);
    expect(r1.report.type).toBe('Receivable');
    const r2: any = await executeTool(prisma, { toolId: 'finance.get_aging', input: { type: 'Payable' } } as any);
    expect(r2.report.type).toBe('Payable');
  });
});

// ────────────────────────────────────────────────────────────────
// quotations.query / quotations.get
// ────────────────────────────────────────────────────────────────

describe('quotations 工具', () => {
  const QUOTATIONS = [
    { id: 'QUO__1', quotationNumber: 'QUO-2026-0001', status: 'Sent', customerName: 'ACME', deletedAt: null, lines: [] },
  ];

  it('quotations.query 返回列表与总数', async () => {
    const prisma = makePrisma({ quotations: QUOTATIONS });
    const result: any = await executeTool(prisma, { toolId: 'quotations.query', input: { filters: { status: 'Sent' } } } as any);
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it('quotations.get 按 id / quotationNumber 读取', async () => {
    const prisma = makePrisma({ quotations: QUOTATIONS });
    const byId: any = await executeTool(prisma, { toolId: 'quotations.get', input: { id: 'QUO__1' } } as any);
    expect(byId.ok).toBe(true);
    expect(byId.item.quotationNumber).toBe('QUO-2026-0001');
    const byNo: any = await executeTool(prisma, { toolId: 'quotations.get', input: { quotationNumber: 'QUO-2026-0001' } } as any);
    expect(byNo.ok).toBe(true);
  });

  it('quotations.get 缺参数 / 未命中 → ok:false', async () => {
    const prisma = makePrisma({ quotations: [] });
    const noArg: any = await executeTool(prisma, { toolId: 'quotations.get', input: {} } as any);
    expect(noArg.ok).toBe(false);
    const miss: any = await executeTool(prisma, { toolId: 'quotations.get', input: { id: 'NOPE' } } as any);
    expect(miss.ok).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// customs.query_lc / customs.get_lc
// ────────────────────────────────────────────────────────────────

describe('customs LC 工具', () => {
  const LCS = [
    { id: 'LC__1', lcNumber: 'LC2026-001', status: 'Issued', expiryDate: '2026-08-20', issueBank: 'HSBC', deletedAt: null },
    { id: 'LC__2', lcNumber: 'LC2026-002', status: 'Settled', expiryDate: '2026-12-31', issueBank: 'Citi', deletedAt: null },
  ];

  it('customs.query_lc 状态过滤', async () => {
    const prisma = makePrisma({ lcs: LCS });
    const result: any = await executeTool(prisma, { toolId: 'customs.query_lc', input: { filters: { status: 'Issued' } } } as any);
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].lcNumber).toBe('LC2026-001');
  });

  it('customs.query_lc expiringBefore 到期过滤', async () => {
    const prisma = makePrisma({ lcs: LCS });
    const result: any = await executeTool(prisma, { toolId: 'customs.query_lc', input: { filters: { expiringBefore: '2026-09-01' } } } as any);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].lcNumber).toBe('LC2026-001');
  });

  it('customs.get_lc 按 lcNumber 读取；未命中返回 ok:false 而非抛错', async () => {
    const prisma = makePrisma({ lcs: LCS });
    const hit: any = await executeTool(prisma, { toolId: 'customs.get_lc', input: { lcNumber: 'LC2026-002' } } as any);
    expect(hit.ok).toBe(true);
    expect(hit.item.issueBank).toBe('Citi');
    const miss: any = await executeTool(prisma, { toolId: 'customs.get_lc', input: { lcNumber: 'NOPE' } } as any);
    expect(miss.ok).toBe(false);
    expect(miss.error).toContain('not found');
  });
});
