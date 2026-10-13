/**
 * shipmentEligibilityGate.test.ts — 出运放行资格门禁（shipping 域统一消费点）全场景覆盖
 *
 * 覆盖矩阵：
 *   1. 无订单锚点（散货运单）→ 无门禁语义直接放行
 *   2. 面料订单 DR-014 三条件全满足 → via='gate' 正常放行（不触碰例外）
 *   3. 面料订单 S/S 未确认 + 无例外 → GATE_BLOCKED（blockingReasons 带订单维度 + exceptionEntryHint）
 *   4. 面料订单不具备资格 + 生效例外精确命中 → via='exception' 例外放行（携带例外摘要）
 *   5. 服装订单 Final QC 未通过 → GATE_BLOCKED（REL-14-A4 单条件）
 *   6. 服装订单 Final QC 通过 → via='gate'
 *   7. DR-016 合票：一票多订单，任一订单资格缺失 → 整体阻断（blockingReasons 可区分订单）
 *   8. 订单不存在/已删除 → ORDER_NOT_FOUND（404 先决条件语义，不聚合进门禁阻断、不查例外）
 *   9. Other 类型订单 → 无出运门禁定义放行
 *  10. orderIds 去重 + 空值过滤
 */
import { describe, expect, it, vi } from 'vitest';
import { storageReader } from './shippingSourceStorageFixture';
import { evaluateShipmentReleaseGate, SHIPMENT_RELEASE_ACTION } from '../shipmentEligibilityGate';
import { GATE_BLOCKED, type ActiveExceptionSummary, type ExceptionChecker } from '../../exceptions/exceptionGate';

// ────────────────────────────────────────────────────────────────────
// Mock 构造
// ────────────────────────────────────────────────────────────────────

type OrderFixture = {
  id: string;
  type?: string;
  businessLine?: string | null;
  deletedAt?: Date | null;
  fabricSampleSentDate?: Date | null;
  fabricSampleConfirmedDate?: Date | null;
};

function fabricOrder(id: string, rc?: { sent?: boolean; confirmed?: boolean }): OrderFixture {
  return {
    id,
    type: 'Fabric',
    businessLine: 'fabric',
    deletedAt: null,
    fabricSampleSentDate: rc?.sent ? new Date('2026-08-01') : null,
    fabricSampleConfirmedDate: rc?.confirmed ? new Date('2026-08-05') : null,
  };
}

function garmentOrder(id: string): OrderFixture {
  return { id, type: 'Garment', businessLine: 'garment', deletedAt: null };
}

function makePrisma(opts: {
  orders: OrderFixture[];
  productionBatches?: any[];
  /** orderId → 大货 Final QC 报告（null=无报告；D8 统一放行口径需数量/疵点/业务批准字段） */
  finalReports?: Record<string, {
    inspectionType: string;
    result: string;
    totalUnits?: number;
    passedUnits?: number;
    criticalDefects?: number;
    approvedByBusiness?: boolean;
  } | null>;
  /** orderId → 最新 S/S 船样（null=无船样）；DR-054 阶段 G：统一 Sample(type='ship') 挂 sourceOrderId */
  ssSamples?: Record<string, { id: string; code: string; type: string; sourceOrderId: string; customerStatus: string } | null>;
}) {
  const finalReports = opts.finalReports ?? {};
  const ssSamples = opts.ssSamples ?? {};
  const reports = Object.entries(finalReports).flatMap(([orderId, report]) => report ? [{ id: `INR__${orderId}`, orderId,
    scopeType: 'whole_order', scopeKey: 'whole_order', revision: 1, scopeFingerprint: null, ...report }] : []);
  return {
    orderSampleSource: { findFirst: vi.fn(async () => null) },
    order: {
      findUnique: vi.fn().mockImplementation(async ({ where }: any) => {
        const order = opts.orders.find((o) => o.id === where.id);
        return order ?? null;
      }),
    },
    inspectionReport: storageReader(() => reports),
    productionBatch: storageReader(() => opts.productionBatches ?? []),
    sample: {
      findMany: vi.fn().mockImplementation(async ({ where }: any) => {
        const sample = ssSamples[where.sourceOrderId];
        return sample ? [sample] : [];
      }),
    },
  } as any;
}

function makeExceptionSummary(overrides: Partial<ActiveExceptionSummary> = {}): ActiveExceptionSummary {
  return {
    id: 'EXC-1',
    exceptionNumber: 'EXC-2026-0001',
    exceptionCategory: 'shipment_release',
    subCategory: null,
    status: 'ReviewerApproved',
    bossFinalBypass: false,
    validUntil: null,
    ...overrides,
  };
}

/** 构造按 targetId 命中与否的例外查询器（校验 scope 绑定精确性） */
function makeExceptionChecker(activeFor: Record<string, ActiveExceptionSummary>): ExceptionChecker & ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation(async (scope: any) => {
    const summary = activeFor[scope.targetId];
    if (summary && scope.targetType === 'Order' && scope.action === SHIPMENT_RELEASE_ACTION) {
      return { active: true, exception: summary };
    }
    return { active: false, reason: 'NO_ACTIVE_EXCEPTION' as const };
  }) as any;
}

// D8 统一放行口径：result 非 fail + 合格率≥90% + 致命疵点=0 + 业务部批准 全部满足才算 Final QC 通过
const FINAL_PASS = {
  inspectionType: 'final', result: 'pass',
  totalUnits: 100, passedUnits: 98, criticalDefects: 0, approvedByBusiness: true,
};
const SS_APPROVED = { id: 'SMP-SS-1', code: 'SMP-20260801-001', type: 'ship', sourceOrderId: 'O1', customerStatus: 'approved' };

// ────────────────────────────────────────────────────────────────────
// 用例
// ────────────────────────────────────────────────────────────────────

describe('evaluateShipmentReleaseGate', () => {
  it('native sample range missing cannot be replaced by an approved whole-order exception', async () => {
    const prisma = makePrisma({ orders: [fabricOrder('O1')], finalReports: { O1: FINAL_PASS }, ssSamples: { O1: SS_APPROVED } });
    prisma.orderSampleSource.findFirst.mockResolvedValue({ id: 'native-order-source', orderId: 'O1', family: 'fabric_ss' });
    const exceptionChecker = makeExceptionChecker({ O1: makeExceptionSummary() });
    const result = await evaluateShipmentReleaseGate({ prisma, orderIds: ['O1'], exceptionChecker });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === GATE_BLOCKED) {
      expect(result.error.orders[0].nativeSampleProofBlocked).toBe(true);
      expect(result.error.message).toContain('订单例外不能替代实际来源证明');
    }
    expect(exceptionChecker).not.toHaveBeenCalled();
  });
  it('1. 无订单锚点（空 orderIds）→ 无门禁语义直接放行', async () => {
    const prisma = makePrisma({ orders: [] });
    const result = await evaluateShipmentReleaseGate({ prisma, orderIds: [] });
    expect(result).toEqual({ ok: true, data: { orders: [] } });
  });

  it('2. 面料订单三条件全满足（大货QC ∥ S/S ∥ RC）→ via=gate 正常放行，不触碰例外', async () => {
    const prisma = makePrisma({
      orders: [fabricOrder('O1', { sent: true, confirmed: true })],
      finalReports: { O1: FINAL_PASS },
      ssSamples: { O1: SS_APPROVED },
    });
    const exceptionChecker = makeExceptionChecker({});
    const result = await evaluateShipmentReleaseGate({ prisma, orderIds: ['O1'], exceptionChecker });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.orders).toHaveLength(1);
    expect(result.data.orders[0]).toMatchObject({
      orderId: 'O1', chain: 'fabric', eligible: true, via: 'gate', blockingReasons: [],
    });
    // 全部具备资格 → 不触碰例外（一次性例外不被无意核销）
    expect(exceptionChecker).not.toHaveBeenCalled();
  });

  it('3. 面料订单 S/S 未确认 + 无生效例外 → GATE_BLOCKED（409 语义聚合）', async () => {
    const prisma = makePrisma({
      orders: [fabricOrder('O1')], // RC 未启用
      finalReports: { O1: FINAL_PASS },
      ssSamples: { O1: { id: 'SMP-SS-1', code: 'SMP-20260801-001', type: 'ship', sourceOrderId: 'O1', customerStatus: 'pending' } },
    });
    const result = await evaluateShipmentReleaseGate({
      prisma, orderIds: ['O1'], exceptionChecker: makeExceptionChecker({}),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(GATE_BLOCKED);
    expect(result.error.blockingReasons).toEqual(['O1:SS_NOT_CONFIRMED']);
    expect(result.error.exceptionReason).toBe('NO_ACTIVE_EXCEPTION');
    expect(result.error.exceptionEntryHint).toContain('POST /api/v1/exceptions');
    expect(result.error.message).toContain('O1');
    // 明细保留原始判定（例外不改变原门禁状态）
    expect(result.error.orders[0]).toMatchObject({ orderId: 'O1', chain: 'fabric', eligible: false });
  });

  it('4. 面料订单 RC 未确认 + 生效例外精确命中 → via=exception 例外放行（携带摘要）', async () => {
    const prisma = makePrisma({
      orders: [fabricOrder('O1', { sent: true, confirmed: false })], // RC 启用未确认
      finalReports: { O1: FINAL_PASS },
      ssSamples: { O1: SS_APPROVED },
    });
    const summary = makeExceptionSummary();
    const exceptionChecker = makeExceptionChecker({ O1: summary });
    const result = await evaluateShipmentReleaseGate({ prisma, orderIds: ['O1'], exceptionChecker });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.orders[0]).toMatchObject({
      orderId: 'O1', chain: 'fabric', eligible: false, via: 'exception',
      blockingReasons: ['RC_NOT_CONFIRMED'],
    });
    expect(result.data.orders[0].exception).toEqual(summary);
    expect(exceptionChecker).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: 'Order', targetId: 'O1', action: 'shipment:release' }),
    );
  });

  it('5. 服装订单大货 Final QC 未通过 → GATE_BLOCKED（REL-14-A4 单条件）', async () => {
    const prisma = makePrisma({
      orders: [garmentOrder('G1')],
      finalReports: { G1: { inspectionType: 'final', result: 'fail' } },
    });
    const result = await evaluateShipmentReleaseGate({
      prisma, orderIds: ['G1'], exceptionChecker: makeExceptionChecker({}),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(GATE_BLOCKED);
    expect(result.error.blockingReasons).toEqual(['G1:BULK_QC_NOT_PASSED']);
    expect(result.error.orders[0]).toMatchObject({ orderId: 'G1', chain: 'garment', eligible: false });
  });

  it('6. 服装历史整单 Final pass 不能代替准确工厂分支的实际逐尺码检验', async () => {
    const prisma = makePrisma({
      orders: [garmentOrder('G1')],
      finalReports: { G1: FINAL_PASS },
    });
    const result = await evaluateShipmentReleaseGate({ prisma, orderIds: ['G1'], exceptionChecker: null });

    expect(result).toMatchObject({ ok: false, error: { code: GATE_BLOCKED,
      orders: [{ orderId: 'G1', chain: 'garment', eligible: false, blockingReasons: ['BULK_QC_NOT_PASSED'] }] } });
  });

  it('7. DR-016 合票：两订单中一单资格缺失 → 整体阻断，blockingReasons 可区分订单', async () => {
    const prisma = makePrisma({
      orders: [fabricOrder('O1'), garmentOrder('G1')],
      finalReports: { O1: FINAL_PASS }, // G1 无 Final QC 报告
      ssSamples: { O1: SS_APPROVED },
    });
    const result = await evaluateShipmentReleaseGate({
      prisma, orderIds: ['O1', 'G1'], exceptionChecker: makeExceptionChecker({}),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(GATE_BLOCKED);
    expect(result.error.blockingReasons).toEqual(['G1:BULK_QC_NOT_PASSED']);
    expect(result.error.orders).toHaveLength(2);
    expect(result.error.orders.find((o) => o.orderId === 'O1')).toMatchObject({ chain: 'fabric', eligible: true });
    expect(result.error.orders.find((o) => o.orderId === 'G1')).toMatchObject({ chain: 'garment', eligible: false });
  });

  it('7b. DR-016 合票：被阻断订单持有生效例外 → 合票整体经例外放行', async () => {
    const prisma = makePrisma({
      orders: [fabricOrder('O1'), garmentOrder('G1')],
      finalReports: { O1: FINAL_PASS },
      ssSamples: { O1: SS_APPROVED },
    });
    const summary = makeExceptionSummary({ bossFinalBypass: true });
    const result = await evaluateShipmentReleaseGate({
      prisma, orderIds: ['O1', 'G1'], exceptionChecker: makeExceptionChecker({ G1: summary }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.orders.find((o) => o.orderId === 'O1')).toMatchObject({ via: 'gate' });
    expect(result.data.orders.find((o) => o.orderId === 'G1')).toMatchObject({ via: 'exception' });
  });

  it('8a. 订单不存在 → ORDER_NOT_FOUND（404 先决条件语义，不聚合门禁、不查例外）', async () => {
    const prisma = makePrisma({ orders: [] });
    const exceptionChecker = makeExceptionChecker({});
    const result = await evaluateShipmentReleaseGate({ prisma, orderIds:['O-X'], exceptionChecker });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ORDER_NOT_FOUND');
    if (result.error.code !== 'ORDER_NOT_FOUND') return;
    expect(result.error.orderIds).toEqual(['O-X']);
    expect(result.error.message).toContain('O-X');
    expect(exceptionChecker).not.toHaveBeenCalled();
  });

  it('8b. 订单已软删 → 视同不存在（fail-closed）', async () => {
    const prisma = makePrisma({
      orders: [{ ...fabricOrder('O1'), deletedAt: new Date() }],
    });
    const result = await evaluateShipmentReleaseGate({ prisma, orderIds: ['O1'], exceptionChecker: null });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ORDER_NOT_FOUND');
  });

  it('8c. 混合场景：一单不存在 + 一单资格缺失 → 404 优先（存在性是先决条件）', async () => {
    const prisma = makePrisma({
      orders: [garmentOrder('G1')], // G1 资格缺失；O-X 不存在
    });
    const result = await evaluateShipmentReleaseGate({
      prisma, orderIds: ['O-X', 'G1'], exceptionChecker: makeExceptionChecker({}),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('ORDER_NOT_FOUND');
    if (result.error.code !== 'ORDER_NOT_FOUND') return;
    expect(result.error.orderIds).toEqual(['O-X']);
  });

  it('9. Other 类型订单 → 无出运门禁定义放行（via=gate）', async () => {
    const prisma = makePrisma({
      orders: [{ id: 'OT1', type: 'Other', businessLine: 'other', deletedAt: null }],
    });
    const result = await evaluateShipmentReleaseGate({ prisma, orderIds: ['OT1'], exceptionChecker: null });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.orders[0]).toMatchObject({ orderId: 'OT1', chain: 'other', eligible: true, via: 'gate' });
  });

  it('10. orderIds 去重 + 空值过滤（重复/空串/null/undefined）', async () => {
    const prisma = makePrisma({
      orders: [{ id: 'G1', type: 'Other', businessLine: 'other', deletedAt: null }],
    });
    const result = await evaluateShipmentReleaseGate({
      prisma, orderIds: ['G1', 'G1', '', null, undefined, '  '], exceptionChecker: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.orders).toHaveLength(1);
    // Other avoids unrelated QC selectors: the actual parent existence read
    // executes once after filtering/deduplicating every supplied identity.
    expect(prisma.order.findUnique).toHaveBeenCalledTimes(1);
  });

  it('11. exceptionChecker 缺省（fail-closed）→ 无例外放行能力，资格缺失即阻断', async () => {
    const prisma = makePrisma({
      orders: [fabricOrder('O1')],
      ssSamples: {}, // S/S 缺失
    });
    const result = await evaluateShipmentReleaseGate({ prisma, orderIds: ['O1'] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(GATE_BLOCKED);
    expect(result.error.exceptionReason).toBe('NO_ACTIVE_EXCEPTION');
  });
});


describe('Current whole-order Final QC source', () => {
  it('fabric legacy final approval is valid only when the actual order has no active physical batch', async () => {
    const opts = { orders: [fabricOrder('O1')], finalReports: { O1: FINAL_PASS }, ssSamples: { O1: SS_APPROVED },
      productionBatches: [{ id: 'foreign', orderId: 'O2', state: 'active' }, { id: 'retired', orderId: 'O1', state: 'retired' }] };
    expect((await evaluateShipmentReleaseGate({ prisma: makePrisma(opts), orderIds: ['O1'] })).ok).toBe(true);
    opts.productionBatches.push({ id: 'actual', orderId: 'O1', state: 'active' });
    const blocked = await evaluateShipmentReleaseGate({ prisma: makePrisma(opts), orderIds: ['O1'] });
    expect(blocked.ok).toBe(false); expect(blocked.error?.code).toBe('GATE_BLOCKED');
    expect(blocked.error?.blockingReasons).toContain('O1:BULK_QC_NOT_PASSED');
  });
  it('a line-scoped final report cannot manufacture whole-order release approval', async () => {
    const prisma = makePrisma({ orders: [garmentOrder('O1')], finalReports: { O1: { ...FINAL_PASS, scopeKey: 'order_line:OL1' } as any } });
    const result = await evaluateShipmentReleaseGate({ prisma, orderIds: ['O1'] });
    expect(result.ok).toBe(false); expect(result.error?.code).toBe('GATE_BLOCKED');
    expect(result.error?.blockingReasons).toContain('O1:BULK_QC_NOT_PASSED');
  });
});
