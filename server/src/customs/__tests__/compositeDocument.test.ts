/**
 * B3 组合文档测试 — 多对一数据聚合（合并 PL / 合并 IR 汇总）。
 *
 * 覆盖：
 *   1. assembleMergedDocumentSet：≥2 校验 / 装配失败 fail-closed / lines 合并重编行号 /
 *      totals 跨运单重算 / parties 首个非空 / missing 去重
 *   2. loadMergedInspectionSummary：≥2 校验 / 报告不存在 fail-closed / 跨报告合计统计 / 结论分布
 *   3. renderMergedPackingListBody / renderMergedInspectionSummaryBody 渲染关键内容
 *   4. isCompositeDocKind / registry 注册
 */

import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

// ── Mock 装配器（组合聚合的单运单/单报告真源）──
const { assembleMock, inspectionLoadMock, genNumberMock, appendVersionMock } = vi.hoisted(() => ({
  assembleMock: vi.fn(),
  inspectionLoadMock: vi.fn(),
  genNumberMock: vi.fn(),
  appendVersionMock: vi.fn(),
}));

// ★ v2.47：原先整模块替换 ⇒ 该模块新增的纯导出（`documentSetHttpErrorCode`）被桩吞掉，
//   报 `[vitest] No "documentSetHttpErrorCode"` —— 台账 B64 那一族。改成只换要换的那一个导出。
vi.mock('../../shipping/documentSetService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shipping/documentSetService')>();
  return { ...actual, assembleDocumentSetData: (...args: any[]) => assembleMock(...args) };
});

vi.mock('../../templates/docTemplates/inspectionReport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../templates/docTemplates/inspectionReport')>();
  return { ...actual, loadInspectionReportDocData: (...args: any[]) => inspectionLoadMock(...args) };
});

// 批次 H3：登记口径依赖 lifecycleService 的取号/版本留痕——mock 隔离（真机语义由 tradeDocumentLifecycle.test.ts 覆盖）
vi.mock('../tradeDocumentLifecycleService', () => ({
  generateTradeDocumentNumber: (...args: any[]) => genNumberMock(...args),
  appendTradeDocumentVersion: (...args: any[]) => appendVersionMock(...args),
}));

vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  assembleMergedDocumentSet,
  loadMergedInspectionSummary,
  assembleCompositeDocument,
  isCompositeDocKind,
  buildCompositeSourceRef,
  parseCompositeSourceRef,
  registerCompositeTradeDocument,
  COMPOSITE_TRADE_DOC_TYPE,
} from '../compositeDocumentService';
import { renderMergedPackingListBody } from '../../templates/docTemplates/mergedPackingList';
import { renderMergedInspectionSummaryBody } from '../../templates/docTemplates/mergedInspectionSummary';
import { SERVER_DOC_TEMPLATES } from '../../templates/docTemplates/registry';

const EXPORTER = {
  nameEn: 'BAMBOOK TRADING CO., LTD.',
  addressEn: 'Shanghai, China',
};

function makeDocSet(shipmentNumber: string, overrides: Record<string, any> = {}) {
  return {
    ok: true,
    data: {
      shipment: {
        id: `SHP_${shipmentNumber}`, shipmentNumber, status: 'Shipped',
        vesselOrFlight: 'MSC ANNA', voyageNumber: '023W',
        portOfLoading: 'SHANGHAI', portOfDischarge: 'HAMBURG',
        containerNumber: 'MSCU1234567', sealNumber: 'S1234',
        totalPackages: 100, grossWeight: 1000, netWeight: 900, volume: 2.5,
        ...overrides.shipment,
      },
      order: { id: `ord_${shipmentNumber}`, poNumber: `PO-${shipmentNumber}`, customer: 'ACME', currency: 'USD' },
      customs: null,
      parties: {
        customer: { name: 'ACME GmbH' },
        consignee: { name: 'ACME GmbH', address: 'Hamburg, Germany' },
        carrier: { name: 'MSC' },
      },
      lines: [
        { lineNumber: 1, description: `Goods from ${shipmentNumber}`, quantity: 500, unit: 'PCS', cartons: 50, grossWeight: 500, netWeight: 450, volume: 1.25, amount: 5000 },
        { lineNumber: 2, description: `Extra from ${shipmentNumber}`, quantity: 100, unit: 'PCS', cartons: 50, grossWeight: 500, netWeight: 450, volume: 1.25, amount: 1000 },
      ],
      totals: { quantity: 600, amount: 6000, cartons: 100, grossWeight: 1000, netWeight: 900, volume: 2.5, currency: 'USD' },
      missing: overrides.missing ?? ['缺少毛重'],
      extras: {},
      ...overrides,
    },
  };
}

describe('assembleMergedDocumentSet', () => {
  it('≥2 校验：单运单 → 拒绝', async () => {
    await expect(assembleMergedDocumentSet({} as PrismaClient, ['SHP_1'])).rejects.toThrow('至少需要 2 个运单');
  });

  it('装配失败 fail-closed：任一运单失败整体失败', async () => {
    assembleMock.mockImplementation(async (prisma: any, id: string) => {
      if (id === 'SHP_BAD') return { ok: false, error: { code: 'SHIPMENT_NOT_FOUND', message: '运单不存在' } };
      return makeDocSet('OK');
    });
    await expect(assembleMergedDocumentSet({} as PrismaClient, ['SHP_OK', 'SHP_BAD']))
      .rejects.toThrow('装配失败');
  });

  it('两运单合并：lines 拼接 + shipmentIndex 标注 + totals 跨运单重算 + missing 去重', async () => {
    assembleMock.mockImplementation(async (_p: any, id: string) => makeDocSet(id));
    const merged = await assembleMergedDocumentSet({} as PrismaClient, ['SHP_A', 'SHP_B']);

    expect(merged.shipments).toHaveLength(2);
    expect(merged.shipments[0].shipmentNumber).toBe('SHP_A');
    expect(merged.lines).toHaveLength(4); // 2 运单 × 2 行
    expect(merged.lines[0].shipmentIndex).toBe(1);
    expect(merged.lines[2].shipmentIndex).toBe(2);
    // totals = 600×2 = 1200（行级求和跨运单）
    expect(merged.totals.quantity).toBe(1200);
    expect(merged.totals.amount).toBe(12000);
    expect(merged.totals.grossWeight).toBe(2000);
    expect(merged.totals.currency).toBe('USD');
    // parties 首个非空 + missing 去重
    expect(merged.parties.consignee?.name).toBe('ACME GmbH');
    expect(merged.missing).toEqual(['缺少毛重']);
  });
});

function makeInspectionData(reportId: string, result: string, overrides: Record<string, any> = {}) {
  return {
    report: {
      id: reportId, inspectionType: 'final', inspectionDate: '2026-08-20',
      inspectorOrg: 'SGS', aqlLevel: 'AQL 2.5', lotSize: 5000, sampleSize: 200,
      totalUnits: 200, passedUnits: 196, criticalDefects: 0, majorDefects: 1, minorDefects: 3,
      defectSummary: null, result, inspectedBy: 'QC Zhang', notes: null,
      qcSignedAt: '2026-08-21', businessSignedAt: null,
      ...overrides,
    },
    order: { poNumber: `PO-${reportId}`, customer: 'ACME', product: 'Shirt', quantity: 5000, dueDate: '2026-09-30' },
    locationName: 'Nantong QC Station',
  };
}

describe('loadMergedInspectionSummary', () => {
  it('≥2 校验：单报告 → 拒绝', async () => {
    await expect(loadMergedInspectionSummary({} as PrismaClient, ['INR__1'])).rejects.toThrow('至少需要 2 份报告');
  });

  it('报告不存在 fail-closed', async () => {
    inspectionLoadMock.mockResolvedValue(null);
    await expect(loadMergedInspectionSummary({} as PrismaClient, ['INR__1', 'INR__missing']))
      .rejects.toThrow('不存在');
  });

  it('三报告汇总：合计统计 + 结论分布 + fail 优先判定数据齐备', async () => {
    inspectionLoadMock.mockImplementation(async (_p: any, id: string) =>
      id === 'INR__fail'
        ? makeInspectionData(id, 'fail', { criticalDefects: 2, totalUnits: 200, passedUnits: 180 })
        : makeInspectionData(id, 'pass'),
    );
    const merged = await loadMergedInspectionSummary({} as PrismaClient, ['INR__1', 'INR__2', 'INR__fail']);

    expect(merged.reports).toHaveLength(3);
    expect(merged.summary.count).toBe(3);
    expect(merged.summary.totalUnits).toBe(600);    // 200×3
    expect(merged.summary.passedUnits).toBe(572);   // 196+196+180
    expect(merged.summary.failedUnits).toBe(28);
    expect(merged.summary.criticalDefects).toBe(2); // 0+0+2
    expect(merged.summary.majorDefects).toBe(3);    // 1×3
    expect(merged.summary.passCount).toBe(2);
    expect(merged.summary.failCount).toBe(1);
  });
});

describe('assembleCompositeDocument（统一入口）', () => {
  it('未知 kind → 拒绝；MERGED_PL/MERGED_IR 分发正确', async () => {
    await expect(assembleCompositeDocument({} as PrismaClient, { kind: 'NOPE' as any, sourceIds: ['a', 'b'] }))
      .rejects.toThrow('未知组合文档类型');

    assembleMock.mockImplementation(async (_p: any, id: string) => makeDocSet(id));
    const r1 = await assembleCompositeDocument({} as PrismaClient, { kind: 'MERGED_PL', sourceIds: ['SHP_A', 'SHP_B'] });
    expect(r1.kind).toBe('MERGED_PL');

    inspectionLoadMock.mockImplementation(async (_p: any, id: string) => makeInspectionData(id, 'pass'));
    const r2 = await assembleCompositeDocument({} as PrismaClient, { kind: 'MERGED_IR', sourceIds: ['INR__1', 'INR__2'] });
    expect(r2.kind).toBe('MERGED_IR');
  });

  it('isCompositeDocKind / registry 注册（MERGED_PL/MERGED_IR 已入注册表）', () => {
    expect(isCompositeDocKind('MERGED_PL')).toBe(true);
    expect(isCompositeDocKind('MERGED_IR')).toBe(true);
    expect(isCompositeDocKind('PL')).toBe(false);
    expect(SERVER_DOC_TEMPLATES.MERGED_PL.title).toContain('合并装箱单');
    expect(SERVER_DOC_TEMPLATES.MERGED_IR.title).toContain('合并验货汇总');
  });
});

describe('组合模板渲染', () => {
  it('合并装箱单：Consolidated 标识 + 运单一览 + 来源运单列 + 合计', () => {
    const data = {
      shipments: [
        { id: 'SHP_A', shipmentNumber: 'SHP-A', status: 'Shipped', vesselOrFlight: 'MSC ANNA', voyageNumber: null, portOfLoading: 'SHANGHAI', portOfDischarge: 'HAMBURG', containerNumber: null, sealNumber: null, totalPackages: 100, grossWeight: 1000, netWeight: 900, volume: 2.5 },
        { id: 'SHP_B', shipmentNumber: 'SHP-B', status: 'Shipped', vesselOrFlight: 'EVER GIVEN', voyageNumber: null, portOfLoading: 'NINGBO', portOfDischarge: 'ROTTERDAM', containerNumber: null, sealNumber: null, totalPackages: 80, grossWeight: 800, netWeight: 700, volume: 2.0 },
      ],
      orders: [
        { id: 'ord_A', poNumber: 'PO-A', customer: 'ACME' },
        { id: 'ord_B', poNumber: 'PO-B', customer: 'ACME' },
      ],
      parties: { customer: { name: 'ACME GmbH' }, consignee: { name: 'ACME GmbH', address: 'Hamburg' }, carrier: { name: 'MSC' } },
      lines: [
        { lineNumber: 1, shipmentIndex: 1, description: 'Shirts A', quantity: 500, unit: 'PCS', cartons: 50, grossWeight: 500, netWeight: 450, volume: 1.25 },
        { lineNumber: 1, shipmentIndex: 2, description: 'Shirts B', quantity: 300, unit: 'PCS', cartons: 30, grossWeight: 400, netWeight: 350, volume: 1.0 },
      ],
      totals: { quantity: 800, amount: null, cartons: 80, grossWeight: 900, netWeight: 800, volume: 2.25, currency: 'USD' },
      missing: ['缺少毛重'],
    };
    const html = renderMergedPackingListBody(data as any, EXPORTER);
    expect(html).toContain('PACKING LIST');
    expect(html).toContain('Consolidated · 2 Shipments 合并');
    expect(html).toContain('SHP-A');
    expect(html).toContain('SHP-B');
    expect(html).toContain('Shipments 运单一览（2）');
    expect(html).toContain('来源运单');
    expect(html).toContain('TOTAL 合计（2 运单）');
    expect(html).toContain('800');
    expect(html).toContain('缺少毛重');
  });

  it('合并验货汇总：整体结论（含 fail 优先）+ 跨报告合计 + 每报告一节', () => {
    const data = {
      reports: [makeInspectionData('INR__1', 'pass'), makeInspectionData('INR__2', 'fail', { criticalDefects: 2 })],
      summary: {
        count: 2, totalUnits: 400, passedUnits: 376, failedUnits: 24,
        criticalDefects: 2, majorDefects: 2, minorDefects: 6,
        passCount: 1, conditionalCount: 0, failCount: 1,
      },
    };
    const html = renderMergedInspectionSummaryBody(data as any, EXPORTER);
    expect(html).toContain('INSPECTION SUMMARY');
    expect(html).toContain('2 Reports 合并');
    expect(html).toContain('FAIL 不合格'); // failCount>0 → 整体 FAIL
    expect(html).toContain('跨报告合计');
    expect(html).toContain('Report 1');
    expect(html).toContain('Report 2');
    expect(html).toContain('PASS');
    expect(html).toContain('Signed 2026-08-21');
    expect(html).toContain('Pending');
  });
});

// ────────────────────────────────────────────────────────────────
// 批次 H3：组合生成留档（登记 TradeDocument 台账）
// ────────────────────────────────────────────────────────────────

/** 登记测试用 prisma mock：tx 与本体同形（$transaction 同步执行），记录 create/update/audit 调用 */
function makeRegisterPrisma(existing: { id: string; documentNumber: string } | null = null) {
  const calls: { create: any[]; update: any[]; audit: any[] } = { create: [], update: [], audit: [] };
  const tx: any = {
    tradeDocument: {
      create: vi.fn(async ({ data }: any) => { calls.create.push(data); return { ...data }; }),
      update: vi.fn(async ({ where, data }: any) => { calls.update.push({ where, data }); return { id: where.id, ...data }; }),
      findFirst: vi.fn(async () => existing),
    },
    auditLog: { create: vi.fn(async ({ data }: any) => { calls.audit.push(data); return {}; }) },
  };
  const prisma: any = { ...tx, $transaction: vi.fn(async (fn: any) => fn(tx)), _calls: calls, _tx: tx };
  return prisma;
}

describe('批次 H3 sourceRef 构建/解析', () => {
  it('buildCompositeSourceRef：sourceIds 排序拼接（任意顺序同组合同 ref）', () => {
    expect(buildCompositeSourceRef('MERGED_PL', ['SHP_B', 'SHP_A'])).toBe('composite:MERGED_PL:SHP_A,SHP_B');
    expect(buildCompositeSourceRef('MERGED_PL', ['SHP_A', 'SHP_B'])).toBe('composite:MERGED_PL:SHP_A,SHP_B');
    expect(buildCompositeSourceRef('CONTRACT', ['ord2', 'ord1'])).toBe('composite:CONTRACT:ord1,ord2');
  });

  it('parseCompositeSourceRef：roundtrip + 非法输入 fail-closed null', () => {
    expect(parseCompositeSourceRef('composite:MERGED_PL:SHP_A,SHP_B')).toEqual({ kind: 'MERGED_PL', sourceIds: ['SHP_A', 'SHP_B'] });
    expect(parseCompositeSourceRef(null)).toBeNull();
    expect(parseCompositeSourceRef('PO_123')).toBeNull();
    expect(parseCompositeSourceRef('composite:NOPE:a,b')).toBeNull();
    expect(parseCompositeSourceRef('composite:MERGED_PL:ONLY_ONE')).toBeNull(); // <2 源不合法
  });

  it('COMPOSITE_TRADE_DOC_TYPE：MERGED_PL→PackingList / CONTRACT→Contract / MERGED_IR 不登记', () => {
    expect(COMPOSITE_TRADE_DOC_TYPE.MERGED_PL).toBe('PackingList');
    expect(COMPOSITE_TRADE_DOC_TYPE.CONTRACT).toBe('Contract');
    expect(COMPOSITE_TRADE_DOC_TYPE.MERGED_IR).toBeUndefined();
  });
});

describe('批次 H3 registerCompositeTradeDocument', () => {
  it('首次登记：自动取号 + Draft + sourceRef + v1 快照（装配数据冻结）+ 双审计', async () => {
    genNumberMock.mockResolvedValue('PL-2026-0009');
    appendVersionMock.mockResolvedValue(undefined);
    const prisma = makeRegisterPrisma(null);
    const data = { totals: { amount: 12000, currency: 'USD' }, lines: [] };

    const result = await registerCompositeTradeDocument(prisma, {
      kind: 'MERGED_PL', sourceIds: ['SHP_B', 'SHP_A'], data, actorId: 'user-1',
    });

    expect(result.outcome).toBe('created');
    expect(result.documentNumber).toBe('PL-2026-0009');
    const created = prisma._calls.create[0];
    expect(created.domain).toBe('customs');
    expect(created.type).toBe('PackingList');
    expect(created.status).toBe('Draft');
    expect(created.sourceRef).toBe('composite:MERGED_PL:SHP_A,SHP_B');
    expect(Number(created.totalAmount)).toBe(12000);
    expect(created.currency).toBe('USD');
    // v1 快照携带装配数据（归档语义）
    expect(appendVersionMock).toHaveBeenCalledTimes(1);
    const versionArgs = appendVersionMock.mock.calls[0][1];
    expect(versionArgs.content.source).toBe('composite');
    expect(versionArgs.content.kind).toBe('MERGED_PL');
    expect(versionArgs.content.sourceIds).toEqual(['SHP_B', 'SHP_A']);
    expect(versionArgs.content.data).toEqual(data);
    // 审计：版本留痕（append 内部）+ TRADE_DOCUMENT_CREATE
    expect(prisma._calls.audit.some((a: any) => a.action === 'TRADE_DOCUMENT_CREATE' && a.detail.source === 'composite')).toBe(true);
  });

  it('同组合重复登记：幂等 updated（刷新头字段，不追加版本、不重复建档）', async () => {
    appendVersionMock.mockClear();
    const prisma = makeRegisterPrisma({ id: 'TD_exist', documentNumber: 'PL-2026-0001' });
    const result = await registerCompositeTradeDocument(prisma, {
      kind: 'MERGED_PL', sourceIds: ['SHP_A', 'SHP_B'], data: { totals: { amount: 8000, currency: 'USD' } },
    });

    expect(result.outcome).toBe('updated');
    expect(result.documentId).toBe('TD_exist');
    expect(prisma._calls.create).toHaveLength(0);
    expect(prisma._calls.update).toHaveLength(1);
    expect(Number(prisma._calls.update[0].data.totalAmount)).toBe(8000);
    expect(appendVersionMock).not.toHaveBeenCalled();
    expect(prisma._calls.audit.some((a: any) => a.action === 'TRADE_DOCUMENT_DOMAIN_REFRESH')).toBe(true);
  });

  it('MERGED_IR 不登记（任务包口径保持即时产物）；无 tradeDocument 模型降级 skipped', async () => {
    const prisma = makeRegisterPrisma(null);
    const r1 = await registerCompositeTradeDocument(prisma, { kind: 'MERGED_IR', sourceIds: ['INR__1', 'INR__2'], data: {} });
    expect(r1.outcome).toBe('skipped');
    expect(prisma._calls.create).toHaveLength(0);

    const r2 = await registerCompositeTradeDocument({} as PrismaClient, { kind: 'MERGED_PL', sourceIds: ['A', 'B'], data: {} });
    expect(r2.outcome).toBe('skipped');
  });

  it('assembleCompositeDocument 默认触发登记（CONTRACT 之外的 MERGED_PL 走通全链）；register:false 跳过', async () => {
    genNumberMock.mockResolvedValue('PL-2026-0010');
    appendVersionMock.mockResolvedValue(undefined);
    assembleMock.mockImplementation(async (_p: any, id: string) => makeDocSet(id));

    const prisma = makeRegisterPrisma(null);
    const r = await assembleCompositeDocument(prisma, { kind: 'MERGED_PL', sourceIds: ['SHP_B', 'SHP_A'] });
    expect(r.kind).toBe('MERGED_PL');
    expect(prisma._calls.create).toHaveLength(1);
    expect(prisma._calls.create[0].sourceRef).toBe('composite:MERGED_PL:SHP_A,SHP_B');

    const prisma2 = makeRegisterPrisma(null);
    await assembleCompositeDocument(prisma2, { kind: 'MERGED_PL', sourceIds: ['SHP_A', 'SHP_B'] }, { register: false });
    expect(prisma2._calls.create).toHaveLength(0);
  });

  it('actorId 透传落台账：审计 actor 为真实操作人而非 system', async () => {
    genNumberMock.mockResolvedValue('PL-2026-0011');
    appendVersionMock.mockClear().mockResolvedValue(undefined);
    assembleMock.mockImplementation(async (_p: any, id: string) => makeDocSet(id));

    const prisma = makeRegisterPrisma(null);
    await assembleCompositeDocument(prisma, { kind: 'MERGED_PL', sourceIds: ['SHP_A', 'SHP_B'] }, { actorId: 'user-op-1' });

    const createAudit = prisma._calls.audit.find((a: any) => a.action === 'TRADE_DOCUMENT_CREATE');
    expect(createAudit).toBeTruthy();
    expect(createAudit.actorId).toBe('user-op-1');
    expect(createAudit.actorId).not.toBe('system');
    // 版本留痕 changedBy 同源
    expect(appendVersionMock.mock.calls[0][1].actorId).toBe('user-op-1');

    // 缺省不传 → 回落 system（非登录上下文兜底语义保持）
    const prisma2 = makeRegisterPrisma({ id: 'TD_exist', documentNumber: 'PL-2026-0001' });
    await registerCompositeTradeDocument(prisma2, { kind: 'MERGED_PL', sourceIds: ['SHP_A', 'SHP_B'], data: { totals: {} } });
    const refreshAudit = prisma2._calls.audit.find((a: any) => a.action === 'TRADE_DOCUMENT_DOMAIN_REFRESH');
    expect(refreshAudit.actorId).toBe('system');
  });

  it('登记失败 warn 不阻断装配输出（fail-open，输出语义优先）', async () => {
    assembleMock.mockImplementation(async (_p: any, id: string) => makeDocSet(id));
    const prisma: any = {
      tradeDocument: { findFirst: vi.fn(async () => { throw new Error('DB down'); }) },
    };
    const r = await assembleCompositeDocument(prisma, { kind: 'MERGED_PL', sourceIds: ['SHP_A', 'SHP_B'] });
    expect(r.kind).toBe('MERGED_PL'); // 装配结果照常返回
    expect((r.data as any).totals.quantity).toBe(1200);
  });
});
