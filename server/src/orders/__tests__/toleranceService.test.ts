/**
 * REQ2-03 溢短装与多单位计价回归测试
 *
 * 验收锚点（需求池 REQ2-03）：
 *   - 任一合同录入 ±5% 后，发货 5.2% 时系统预警并给出按条款的结算金额
 *   - 米码换算双向精确（1yd = 0.9144m 国际标准）
 */
import { describe, expect, it, vi } from 'vitest';
import { checkTolerance, getOrderToleranceStatus, validateTolerancePercentInput } from '../toleranceService';
import { convertLength, fabricWeightKg, lengthFromWeightKg, METERS_PER_YARD, normalizeLengthUnit } from '../../lib/unitConversion';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ══════════════ 单位换算库 ══════════════

describe('unitConversion 米码换算（单一真源）', () => {
  it('M → YD / YD → M 双向精确（1yd = 0.9144m）', () => {
    expect(convertLength(0.9144, 'M', 'YD')).toBe(1);
    expect(convertLength(1, 'YD', 'M')).toBe(0.9144);
    expect(convertLength(1000, 'M', 'YD')).toBe(1093.6133); // 1000/0.9144
    expect(convertLength(1000, 'YD', 'M')).toBe(914.4);
    expect(METERS_PER_YARD).toBe(0.9144);
  });

  it('同单位直通；非长度单位（PC/SET/KG）返回 null', () => {
    expect(convertLength(500, 'M', 'M')).toBe(500);
    expect(convertLength(500, 'M', 'PC')).toBeNull();
    expect(convertLength(500, 'KG', 'M')).toBeNull();
  });

  it('单位别名归一化（meter/米/yard/码 大小写不敏感）', () => {
    expect(normalizeLengthUnit('meter')).toBe('M');
    expect(normalizeLengthUnit('米')).toBe('M');
    expect(normalizeLengthUnit('Yard')).toBe('YD');
    expect(normalizeLengthUnit('码')).toBe('YD');
    expect(normalizeLengthUnit('PC')).toBeNull();
  });

  it('公斤计价：克重×门幅×长度 → kg（240gsm 150cm 1000m = 360kg）', () => {
    expect(fabricWeightKg(240, 150, 1000)).toBe(360); // 240×1.5×1000/1000
    expect(fabricWeightKg(200, 145, 500)).toBe(145);  // 200×1.45×500/1000
  });

  it('公斤反推米数（360kg → 1000m 往返一致）', () => {
    expect(lengthFromWeightKg(240, 150, 360)).toBe(1000);
  });
});

// ══════════════ 容差校验 ══════════════

describe('validateTolerancePercentInput 写入口径校验（2026-09-03 审计 P1）', () => {
  it('合法区间 [0, 100] 含边界放行（number 与数字字符串）', () => {
    expect(validateTolerancePercentInput(0)).toEqual({ ok: true, value: 0 });
    expect(validateTolerancePercentInput(5)).toEqual({ ok: true, value: 5 });
    expect(validateTolerancePercentInput(100)).toEqual({ ok: true, value: 100 });
    expect(validateTolerancePercentInput('7.5')).toEqual({ ok: true, value: 7.5 });
  });

  it('null/undefined/空串放行（清空条款）', () => {
    expect(validateTolerancePercentInput(null)).toEqual({ ok: true, value: null });
    expect(validateTolerancePercentInput(undefined)).toEqual({ ok: true, value: null });
    expect(validateTolerancePercentInput('')).toEqual({ ok: true, value: null });
  });

  it('越界拒绝：-20 / 999 → 中文错误消息', () => {
    expect(validateTolerancePercentInput(-20)).toEqual({
      ok: false,
      message: '溢短装公差 tolerancePercent 必须在 0-100 之间（含边界），当前值：-20',
    });
    expect(validateTolerancePercentInput(999)).toEqual({
      ok: false,
      message: '溢短装公差 tolerancePercent 必须在 0-100 之间（含边界），当前值：999',
    });
  });

  it('非数值拒绝：NaN / 非数字字符串', () => {
    const nan = validateTolerancePercentInput(NaN);
    expect(nan.ok).toBe(false);
    if (!nan.ok) expect(nan.message).toContain('必须是数字');
    const bad = validateTolerancePercentInput('abc');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toContain('必须是数字');
  });
});

describe('checkTolerance 溢短装校验', () => {
  it('验收锚点：±5% 条款发货 5.2% → over_limit 预警 + 条款上限结算金额', () => {
    // 合同 10000M ±5%，发货 10520M（+5.2%），单价 3.25
    const r = checkTolerance({ contractQty: 10000, actualQty: 10520, tolerancePercent: 5, unitPrice: 3.25 });
    expect(r.verdict).toBe('over_limit');
    expect(r.deviationPct).toBe(5.2);
    expect(r.allowedMax).toBe(10500);
    expect(r.allowedMin).toBe(9500);
    expect(r.warning).toContain('溢装超限');
    expect(r.settlementAmount).toBe(34190);      // 3.25 × 10520（按实际量）
    expect(r.maxLimitAmount).toBe(34125);       // 3.25 × 10500（条款上限协商基准）
  });

  it('限额内（+4.9%）→ ok 无预警，按实际量结算', () => {
    const r = checkTolerance({ contractQty: 10000, actualQty: 10490, tolerancePercent: 5, unitPrice: 3.25 });
    expect(r.verdict).toBe('ok');
    expect(r.warning).toBeNull();
    expect(r.settlementAmount).toBe(34092.5);
  });

  it('短装超限（−6%）→ under_limit 预警 + 下限结算额', () => {
    const r = checkTolerance({ contractQty: 1000, actualQty: 940, tolerancePercent: 5, unitPrice: 10 });
    expect(r.verdict).toBe('under_limit');
    expect(r.deviationPct).toBe(-6);
    expect(r.minLimitAmount).toBe(9500);
    expect(r.warning).toContain('短装超限');
  });

  it('容差 0 = 足量交付：任何偏差即预警', () => {
    const r = checkTolerance({ contractQty: 100, actualQty: 101, tolerancePercent: 0 });
    expect(r.verdict).toBe('over_limit');
    expect(r.allowedMin).toBe(100);
    expect(r.allowedMax).toBe(100);
  });

  it('恰好等于上限 → ok（边界含端点）', () => {
    const r = checkTolerance({ contractQty: 1000, actualQty: 1050, tolerancePercent: 5 });
    expect(r.verdict).toBe('ok');
  });

  it('非法输入 fail-closed（qty≤0 / 负数）', () => {
    expect(() => checkTolerance({ contractQty: 0, actualQty: 1, tolerancePercent: 5 })).toThrow();
    expect(() => checkTolerance({ contractQty: 100, actualQty: -1, tolerancePercent: 5 })).toThrow();
  });

  it('无单价：金额字段为 null（数量校验仍可用）', () => {
    const r = checkTolerance({ contractQty: 100, actualQty: 106, tolerancePercent: 5, unitPrice: null });
    expect(r.verdict).toBe('over_limit');
    expect(r.settlementAmount).toBeNull();
  });
});

// ══════════════ 订单维度状态 ══════════════

describe('getOrderToleranceStatus 订单溢短装状态', () => {
  /**
   * ★ 2026-09-29：mock 补 `relation` / `systemConfig`
   *   —— 容差口径现在走**标准链**（客户标准 P0 → 内部标准辅助 → 未判定）。
   */
  function makePrisma(
    orders: any[],
    lines: any[],
    std: { internal?: unknown; customer?: unknown } = {},
    /** ★ 2026-09-29 晚：幅宽实测。`undefined` = 该表不可用（模拟读取故障）；`[]` = 确实没量过 */
    width?: { rows?: any[]; fail?: boolean },
  ) {
    const widthFindMany = vi.fn().mockImplementation(async () => {
      if (width?.fail) throw new Error('relation "InspectionWidthMeasurement" does not exist');
      return width?.rows ?? [];
    });
    return {
      order: { findFirst: vi.fn().mockImplementation(async ({ where }: any) => orders.find(o => o.id === where.id) ?? null) },
      orderLine: { findMany: vi.fn().mockResolvedValue(lines) },
      relation: {
        findUnique: vi.fn().mockResolvedValue(
          std.customer !== undefined ? { customerAgreementTolerance: std.customer } : null,
        ),
      },
      systemConfig: {
        findUnique: vi.fn().mockResolvedValue(std.internal !== undefined ? { value: std.internal } : null),
      },
      inspectionWidthMeasurement: { findMany: widthFindMany },
    } as any;
  }

  /** 内部标准：任意数量 ±5% */
  const INTERNAL_5 = { qtyTolerance: [{ minQty: 1, maxQty: null, pct: 5 }] };

  it('聚合各行已发量 vs 合同量（含 summary 与未发行）', async () => {
    const prisma = makePrisma(
      [{ id: 'PO-1', poNumber: 'DEMO-PO-1', customerRelationId: null }],
      [
        { id: 'L1', itemNo: '001', description: 'Cotton Twill', unit: 'M', quantity: 10000, unitPrice: 3.25, shipmentQuantity: 10520, tolerancePercent: null, toleranceSource: null },
        { id: 'L2', itemNo: '002', description: 'Wool Suiting', unit: 'YD', quantity: 2000, unitPrice: 15, shipmentQuantity: 2000, tolerancePercent: null, toleranceSource: null },
        { id: 'L3', itemNo: '003', description: 'Knit', unit: 'M', quantity: 500, unitPrice: 4, shipmentQuantity: null, tolerancePercent: null, toleranceSource: null },
      ],
      { internal: INTERNAL_5 },
    );
    const s = await getOrderToleranceStatus(prisma, 'PO-1');
    expect(s!.poNumber).toBe('DEMO-PO-1');
    expect(s!.lines).toHaveLength(3);
    const l1 = s!.lines[0];
    // ★ 口径来源要能看出来
    expect(l1.toleranceSource).toBe('internal_standard');
    expect(l1.toleranceHard, '内部标准是辅助，不是硬约束').toBe(false);
    expect(l1.check!.verdict).toBe('over_limit');
    expect(l1.check!.deviationPct).toBe(5.2);
    // 未发行（L3 shippedQty=0）：不触发容差判定，归 unshipped
    const l3 = s!.lines[2];
    expect(l3.shippedQty).toBe(0);
    expect(l3.check).toBeNull();
    expect(s!.summary).toEqual({ total: 3, ok: 1, overLimit: 1, underLimit: 0, unshipped: 1, undetermined: 0 });
  });

  it('订单不存在 → null', async () => {
    const prisma = makePrisma([], []);
    expect(await getOrderToleranceStatus(prisma, '__NONE__')).toBeNull();
  });

  /**
   * ★★ 2026-09-29 晚口径变更（Kevin：出厂默认值）—— 这条断言**整条换了口径**，理由写在这里：
   *   修前它钉的是「无标准 ⇒ tolerancePercent = null」（那是上午的口径：没人录 ⇒ 未判定）。
   *   现在「没人录」⇒ 落到 **我方出厂默认**（100 米 → 0–999 档 → ±5%），
   *   所以这里断言的是新口径的**三件套**：数从默认来 + source 自报 `internal_default` + 理由不再说"无标准"。
   *   ★ 仍然不许"静默回退 5%"：那个 5 必须有**来源名**，也必须能在 notices 里看到"这是出厂默认"。
   */
  it('★★ 内部未录 ⇒ 按**出厂默认**：tolerancePercent = 默认那一档，且 source 自报 internal_default', async () => {
    const prisma = makePrisma(
      [{ id: 'PO-2', poNumber: 'X', customerRelationId: null }],
      [{ id: 'L1', itemNo: '1', description: null, unit: null, quantity: 100, unitPrice: null, shipmentQuantity: null, tolerancePercent: null, toleranceSource: null }],
    );
    const s = await getOrderToleranceStatus(prisma, 'PO-2');
    expect(s!.lines[0].shippedQty).toBe(0);
    expect(s!.lines[0].tolerancePercent, '100 米落出厂默认第 1 档（0–999 → ±5%）').toBe(5);
    expect(s!.lines[0].toleranceSource, '★ 不许冒充"有人录过"').toBe('internal_default');
    expect(s!.lines[0].toleranceHard, '出厂默认是我方辅助，不是硬约束').toBe(false);
    expect(s!.lines[0].toleranceUnresolvedReason).toBeNull();
    expect(s!.lines[0].toleranceReferencePct, '行上那个数只在"判不了"时作参考').toBeNull();
  });

  it('★★ 真的没有可用标准时（我方标准**配置损坏**）⇒ tolerancePercent = null + 原因 + 参考值', async () => {
    // ★ 「配置存在但解析不出档位」是出厂默认上线后**仍然可达**的未判定路径（不套默认，见 loadToleranceStandards）
    const prisma = makePrisma(
      [{ id: 'PO-2B', poNumber: 'X', customerRelationId: null }],
      [{ id: 'L1', itemNo: '1', description: null, unit: null, quantity: 100, unitPrice: null, shipmentQuantity: null, tolerancePercent: null, toleranceSource: null }],
      { internal: {} },
    );
    const s = await getOrderToleranceStatus(prisma, 'PO-2B');
    expect(s!.lines[0].tolerancePercent, '★ 判不了就是 null —— 既不是 0 也不是 5').toBeNull();
    expect(s!.lines[0].toleranceSource).toBe('none');
    expect(s!.lines[0].toleranceUnresolvedReason).toBeTruthy();
  });

  it('★★ 未判定 ⇒ check 为 null 且单列 undetermined（**判不了 ≠ 合格**）', async () => {
    const prisma = makePrisma(
      [{ id: 'PO-3', poNumber: 'X', customerRelationId: null }],
      [{ id: 'L1', itemNo: '1', description: null, unit: null, quantity: 100, unitPrice: null, shipmentQuantity: 110, tolerancePercent: 5, toleranceSource: null }],
      { internal: {} },
    );
    const s = await getOrderToleranceStatus(prisma, 'PO-3');
    const l = s!.lines[0];
    expect(l.tolerancePercent, '★ 未判定 ⇒ null，既不是 0 也不是 5').toBeNull();
    expect(l.check, '判不了 ⇒ check 为 null（不等于「合格」）').toBeNull();
    expect(l.toleranceUnresolvedReason).toBeTruthy();
    expect(l.toleranceReferencePct, '行上那个 5 只能作**参考**（非合同约定）').toBe(5);
    expect(s!.summary.undetermined).toBe(1);
    expect(s!.summary.ok, '★ 判不了不许混进 ok').toBe(0);
  });

  it('★ 行级覆盖优先于内部标准（★ 白名单：必须带 toleranceSource）', async () => {
    const prisma = makePrisma(
      [{ id: 'PO-4', poNumber: 'X', customerRelationId: null }],
      [{ id: 'L1', itemNo: '1', description: null, unit: null, quantity: 100, unitPrice: null, shipmentQuantity: 110, tolerancePercent: 20, toleranceSource: 'line_override' }],
      { internal: INTERNAL_5 },
    );
    const s = await getOrderToleranceStatus(prisma, 'PO-4');
    expect(s!.lines[0].toleranceSource).toBe('line_override');
    expect(s!.lines[0].tolerancePercent).toBe(20);
    expect(s!.lines[0].check!.verdict, '+10% 在覆盖 ±20% 之内 ⇒ 合格').toBe('ok');
  });

  it('★★ 客户标准优先于内部标准（客户 P0）', async () => {
    const prisma = makePrisma(
      [{ id: 'PO-5', poNumber: 'X', customerRelationId: 'REL_1' }],
      [{ id: 'L1', itemNo: '1', description: null, unit: null, quantity: 100, unitPrice: null, shipmentQuantity: 103, tolerancePercent: null, toleranceSource: null }],
      { internal: INTERNAL_5, customer: { qtyTolerance: [{ minQty: 1, maxQty: null, pct: 1 }] } },
    );
    const s = await getOrderToleranceStatus(prisma, 'PO-5');
    const l = s!.lines[0];
    expect(l.toleranceSource).toBe('customer_standard');
    expect(l.tolerancePercent, '★ 客户 ±1% 压住内部 ±5%').toBe(1);
    expect(l.toleranceHard, '客户标准是硬约束').toBe(true);
    expect(l.check!.verdict, '+3% 超客户 ±1%').toBe('over_limit');
  });
});

// ════════════════════════════════════════════════════════════════════
// 幅宽扣款（窄幅索赔）在订单视图里的接线 —— 2026-09-29 晚
//   客户标准原文：可用幅宽 ≥147CM；偏差 ≤3%→扣10% · ≤4.5%→扣25% · ≤6%→扣30%
// ════════════════════════════════════════════════════════════════════

describe('订单视图 · 幅宽扣款（★ 只建议不落账；未量过 ≠ 扣 0）', () => {
  /**
   * ⓘ 自带一个最小桩：本文件里 `makePrisma` 是**上一个 describe 的局部函数**，作用域外看不见
   *   （我第一版直接复用它 ⇒ 六条全红 `makePrisma is not defined`）。只加本组用得到的模型。
   */
  const stub = (opts: {
    order: any; lines: any[]; std?: { internal?: unknown; customer?: unknown };
    width?: { rows?: any[]; fail?: boolean };
  }) =>
    ({
      order: { findFirst: vi.fn().mockResolvedValue(opts.order) },
      orderLine: { findMany: vi.fn().mockResolvedValue(opts.lines) },
      relation: {
        findUnique: vi.fn().mockResolvedValue(
          opts.std?.customer !== undefined ? { customerAgreementTolerance: opts.std.customer } : null,
        ),
      },
      systemConfig: {
        findUnique: vi.fn().mockResolvedValue(
          opts.std?.internal !== undefined ? { value: opts.std.internal } : null,
        ),
      },
      inspectionWidthMeasurement: {
        findMany: vi.fn().mockImplementation(async () => {
          if (opts.width?.fail) throw new Error('relation "InspectionWidthMeasurement" does not exist');
          return opts.width?.rows ?? [];
        }),
      },
    } as any);

  const CUSTOMER = {
    widthDeduction: [
      { minQty: 0, maxQty: 3, pct: 10 },
      { minQty: 3, maxQty: 4.5, pct: 25 },
      { minQty: 4.5, maxQty: 6, pct: 30 },
    ],
  };
  const line = {
    id: 'L1', itemNo: '001', description: 'Wool', unit: 'M', quantity: 10000,
    unitPrice: 3.25, netValue: 10000, shipmentQuantity: 0,
    tolerancePercent: null, toleranceSource: null,
  };
  const wm = (over: Record<string, unknown> = {}) => ({
    orderLineId: 'L1', reportId: 'INR__PO-W', measuredWidthCm: 141.12, basisWidthCm: 147,
    note: null, createdAt: 1, ...over,
  });

  it('★★ 偏差 4% + 客户标准 ⇒ 建议扣款 = 该行货款金额 × 25%（并说明不落账）', async () => {
    const prisma = stub({
      order: { id: 'PO-W', poNumber: 'PO-W', customerRelationId: 'REL-1' },
      lines: [line], std: { customer: CUSTOMER }, width: { rows: [wm()] },
    });
    const s = await getOrderToleranceStatus(prisma, 'PO-W');
    const w = s!.lines[0].widthDeduction!;
    expect(w.verdict).toBe('deduct');
    expect(w.deviationPct).toBe(4);
    expect(w.pct).toBe(25);
    expect(w.source).toBe('customer_standard');
    expect(w.suggestedAmount, '10000 × 25%').toBe(2500);
    expect(w.headline).toContain('不自动落账');
    expect(s!.widthMeasurementUnavailable).toBe(false);
  });

  it('★ 没有实测记录 ⇒ `null`（"还没量过"），**不是**扣 0', async () => {
    const prisma = stub({
      order: { id: 'PO-W2', poNumber: 'PO-W2', customerRelationId: 'REL-1' },
      lines: [line], std: { customer: CUSTOMER }, width: { rows: [] },
    });
    const s = await getOrderToleranceStatus(prisma, 'PO-W2');
    expect(s!.lines[0].widthDeduction).toBeNull();
    expect(s!.widthMeasurementUnavailable).toBe(false);
  });

  it('★★ 幅宽表**读不到** ⇒ unavailable=true（不许渲染成"还没量过"）', async () => {
    const prisma = stub({
      order: { id: 'PO-W3', poNumber: 'PO-W3', customerRelationId: 'REL-1' },
      lines: [line], std: { customer: CUSTOMER }, width: { fail: true },
    });
    const s = await getOrderToleranceStatus(prisma, 'PO-W3');
    expect(s!.widthMeasurementUnavailable, '读不到与没量过是两件事').toBe(true);
    expect(s!.lines[0].widthDeduction).toBeNull();
  });

  it('★★ 客户没录幅宽扣款 ⇒ 未判定（**不套内部默认**、不给金额）', async () => {
    const prisma = stub({
      order: { id: 'PO-W4', poNumber: 'PO-W4', customerRelationId: 'REL-1' },
      lines: [line], std: { internal: { qtyTolerance: [{ minQty: 1, maxQty: null, pct: 5 }] } },
      width: { rows: [wm()] },
    });
    const s = await getOrderToleranceStatus(prisma, 'PO-W4');
    const w = s!.lines[0].widthDeduction!;
    expect(w.verdict).toBe('undetermined');
    expect(w.pct).toBeNull();
    expect(w.suggestedAmount).toBeNull();
    expect(w.unresolvedReason).toContain('没有出厂默认');
  });

  it('★ 够宽 ⇒ ok（不扣），且不受"客户没录标准"影响', async () => {
    const prisma = stub({
      order: { id: 'PO-W5', poNumber: 'PO-W5', customerRelationId: 'REL-1' },
      lines: [line], std: {}, width: { rows: [wm({ measuredWidthCm: 150 })] },
    });
    const s = await getOrderToleranceStatus(prisma, 'PO-W5');
    const w = s!.lines[0].widthDeduction!;
    expect(w.verdict).toBe('ok');
    expect(w.pct).toBe(0);
    expect(w.suggestedAmount).toBe(0);
  });

  it('★ 同一行多次实测 ⇒ 取**最新一条**（中期量过、出货前又量）', async () => {
    const prisma = stub({
      order: { id: 'PO-W6', poNumber: 'PO-W6', customerRelationId: 'REL-1' },
      lines: [line], std: { customer: CUSTOMER },
      width: { rows: [wm({ measuredWidthCm: 146, createdAt: 2 }), wm({ measuredWidthCm: 141.12, createdAt: 1 })] },
    });
    const s = await getOrderToleranceStatus(prisma, 'PO-W6');
    expect(s!.lines[0].widthDeduction!.measuredWidthCm, 'createdAt 大的在前 ⇒ 取 146').toBe(146);
    expect(s!.lines[0].widthDeduction!.pct, '偏差 0.68% ⇒ 10%').toBe(10);
  });
});
