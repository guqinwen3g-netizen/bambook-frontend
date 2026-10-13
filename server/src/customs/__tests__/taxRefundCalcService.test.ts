/**
 * taxRefundCalcService.test.ts — T7-④ 退税核算 / 报缺 / 补齐后重算
 *
 * 口径 E（2026-09-16 拍板）钉住的不变量：
 *   1. **显式报缺**：算不出时能说清缺什么（fx_rate / hs_rebate_rate / line_total / no_lines）
 *   2. **默认只填 null**：recalc 不覆盖任何已有值（人工填过的金额不被系统冲掉）
 *   3. **force 模式只返回 diff，不落库**（一键重算不得悄悄改掉审核过的数）
 *   4. **状态约束**：仅 Draft / Rejected 可重算；Submitted 之后 409
 *   5. 退税率是**百分数**口径 → 核算须 /100（历史曾放大 100 倍）
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../audit/routeAudit', () => ({ writeRouteAuditLog: vi.fn(async () => ({})) }));

import { computeTaxRefundFigures, describeTaxRefundGaps, recalcTaxRefund } from '../taxRefundCalcService';

function makePrisma(seed: {
  declaration?: any;
  invoice?: any;
  voucher?: any;
  shipment?: any;
  hsCodes?: any[];
  taxRefund?: any;
} = {}) {
  const declaration = seed.declaration === undefined
    ? {
        id: 'CD1', declarationNumber: 'CD-001', status: 'Released',
        orderId: 'ORD1', relationId: 'REL1', shipmentId: 'SHP1',
        currency: 'USD', totalValue: '10000', declarationDate: '2026-09-01', deletedAt: null,
        lines: [{ id: 'CDL1', lineNumber: 1, hsCode: '5208.52', totalAmount: '10000' }],
      }
    : seed.declaration;
  const state = {
    invoice: seed.invoice === undefined ? { exchangeRate: '7.1' } : seed.invoice,
    voucher: seed.voucher === undefined ? null : seed.voucher,
    shipment: seed.shipment === undefined ? { atd: '2026-09-05', etd: '2026-09-04' } : seed.shipment,
    hsCodes: seed.hsCodes ?? [{ code: '5208.52', exportTaxRebateRate: '13' }],
    taxRefund: seed.taxRefund === undefined ? null : seed.taxRefund,
  };
  const updates: any[] = [];
  return {
    prisma: {
      customsDeclaration: { findFirst: async () => declaration },
      invoice: { findFirst: async () => state.invoice },
      paymentVoucher: { findFirst: async () => state.voucher },
      shipment: { findUnique: async () => state.shipment },
      hsCode: { findMany: async () => state.hsCodes },
      taxRefund: {
        findFirst: async () => state.taxRefund,
        update: async ({ data }: any) => { updates.push(data); return { ...state.taxRefund, ...data }; },
      },
    } as any,
    updates,
  };
}

describe('computeTaxRefundFigures — 核算 + 报缺', () => {
  it('数据齐全 → 核算正确且无缺项（退税率按百分数 /100）', async () => {
    const { prisma } = makePrisma();
    const f = await computeTaxRefundFigures(prisma, 'CD1');
    expect(f).not.toBeNull();
    expect(f!.gaps).toEqual([]);
    expect(f!.exportAmountFob).toBe(10000);
    expect(f!.fxRate).toBe(7.1);
    expect(f!.exportAmountCny).toBe(71000);
    // 10000 × 7.1 × (13/100) = 9230（若漏除 100 会变成 923000）
    expect(f!.refundableVat).toBe(9230);
    expect(f!.refundableRate).toBe(13);
    expect(f!.refundAmount).toBe(9230);
    expect(f!.exportDate).toBe('2026-09-05');
  });

  it('缺汇率（无发票汇率、无收汇凭证汇率）→ 报 fx_rate，且退税额为 null', async () => {
    const { prisma } = makePrisma({ invoice: null, voucher: null });
    const f = await computeTaxRefundFigures(prisma, 'CD1');
    expect(f!.fxRate).toBeNull();
    expect(f!.exportAmountCny).toBeNull();
    expect(f!.refundableVat).toBeNull();
    expect(f!.gaps.map(g => g.code)).toEqual(['fx_rate']);
    expect(f!.gaps[0].howToFix).toContain('exchangeRate');
  });

  it('回退链：无发票汇率时用收汇凭证汇率', async () => {
    const { prisma } = makePrisma({ invoice: null, voucher: { exchangeRate: '7.05' } });
    const f = await computeTaxRefundFigures(prisma, 'CD1');
    expect(f!.fxRate).toBe(7.05);
    expect(f!.gaps).toEqual([]);
  });

  it('HS 未登记退税率 → 报 hs_rebate_rate（带 HS 编码）', async () => {
    const { prisma } = makePrisma({ hsCodes: [] });
    const f = await computeTaxRefundFigures(prisma, 'CD1');
    expect(f!.gaps.map(g => g.code)).toEqual(['hs_rebate_rate']);
    expect(f!.gaps[0].ref).toBe('5208.52');
    expect(f!.gaps[0].howToFix).toContain('exportTaxRebateRate');
    expect(f!.refundableVat).toBeNull();
  });

  it('报关行缺 HS 编码 → 报 hs_rebate_rate（ref = 行号）', async () => {
    const { prisma } = makePrisma({
      declaration: {
        id: 'CD1', declarationNumber: 'CD-001', status: 'Released', orderId: 'ORD1', relationId: null,
        shipmentId: null, currency: 'USD', totalValue: '10000', declarationDate: '2026-09-01', deletedAt: null,
        lines: [{ id: 'CDL1', lineNumber: 1, hsCode: null, totalAmount: '10000' }],
      },
    });
    const f = await computeTaxRefundFigures(prisma, 'CD1');
    expect(f!.gaps[0].code).toBe('hs_rebate_rate');
    expect(f!.gaps[0].ref).toBe('1');
    expect(f!.gaps[0].label).toContain('缺 HS 编码');
  });

  it('报关行缺金额 → 报 line_total', async () => {
    const { prisma } = makePrisma({
      declaration: {
        id: 'CD1', declarationNumber: 'CD-001', status: 'Released', orderId: 'ORD1', relationId: null,
        shipmentId: null, currency: 'USD', totalValue: '10000', declarationDate: '2026-09-01', deletedAt: null,
        lines: [{ id: 'CDL1', lineNumber: 2, hsCode: '5208.52', totalAmount: null }],
      },
    });
    const f = await computeTaxRefundFigures(prisma, 'CD1');
    expect(f!.gaps.map(g => g.code)).toEqual(['line_total']);
    expect(f!.gaps[0].ref).toBe('2');
  });

  it('报关单无商品行 → 报 no_lines（且回退用 totalValue 算 FOB）', async () => {
    const { prisma } = makePrisma({
      declaration: {
        id: 'CD1', declarationNumber: 'CD-001', status: 'Released', orderId: 'ORD1', relationId: null,
        shipmentId: null, currency: 'USD', totalValue: '10000', declarationDate: '2026-09-01', deletedAt: null,
        lines: [],
      },
    });
    const f = await computeTaxRefundFigures(prisma, 'CD1');
    expect(f!.gaps.map(g => g.code)).toEqual(['no_lines']);
    expect(f!.exportAmountFob).toBe(10000);
  });

  it('HS 格式不一致（档案无分隔符 62044300 / 报关行带点 6204.43.00）→ 归一化后仍匹配（真库实测根因）', async () => {
    const { prisma } = makePrisma({
      declaration: {
        id: 'CD1', declarationNumber: 'CD-001', status: 'Released', orderId: 'ORD1', relationId: null,
        shipmentId: null, currency: 'USD', totalValue: '10000', declarationDate: '2026-09-01', deletedAt: null,
        lines: [{ id: 'CDL1', lineNumber: 1, hsCode: '6204.43.00', totalAmount: '10000' }],
      },
      hsCodes: [{ code: '62044300', exportTaxRebateRate: '13' }], // 档案写法：无分隔符
    });
    const f = await computeTaxRefundFigures(prisma, 'CD1');
    expect(f!.gaps).toEqual([]);       // 不得报「未登记退税率」
    expect(f!.refundableVat).toBe(9230);
  });

  it('HS 格式反向不一致（档案带点 / 报关行无分隔符）→ 同样匹配', async () => {
    const { prisma } = makePrisma({
      declaration: {
        id: 'CD1', declarationNumber: 'CD-001', status: 'Released', orderId: 'ORD1', relationId: null,
        shipmentId: null, currency: 'USD', totalValue: '10000', declarationDate: '2026-09-01', deletedAt: null,
        lines: [{ id: 'CDL1', lineNumber: 1, hsCode: '62044300', totalAmount: '10000' }],
      },
      hsCodes: [{ code: '6204.43.00', exportTaxRebateRate: '13' }],
    });
    const f = await computeTaxRefundFigures(prisma, 'CD1');
    expect(f!.gaps).toEqual([]);
    expect(f!.refundableVat).toBe(9230);
  });

  it('报关单不存在 → null', async () => {
    const prisma: any = { customsDeclaration: { findFirst: async () => null } };
    expect(await computeTaxRefundFigures(prisma, 'NOPE')).toBeNull();
  });
});

describe('describeTaxRefundGaps — 只读报缺', () => {
  it('报关单不存在 → 404', async () => {
    const prisma: any = { customsDeclaration: { findFirst: async () => null } };
    const r = await describeTaxRefundGaps(prisma, 'NOPE');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.status).toBe(404);
  });

  it('正常报关单 → 返回 figures + gaps', async () => {
    const { prisma } = makePrisma({ invoice: null, voucher: null });
    const r = await describeTaxRefundGaps(prisma, 'CD1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.declarationNumber).toBe('CD-001');
      expect(r.data.gaps).toHaveLength(1);
    }
  });
});

describe('recalcTaxRefund — 补齐后重算（口径 E）', () => {
  const draftWithNulls = {
    id: 'TR1', declarationId: 'CD1', status: 'Draft',
    fxRate: null, exportAmountFob: null, exportAmountFobCurrency: null,
    exportAmountCny: null, refundableVat: null, refundableRate: null,
    refundAmount: null, exportDate: null,
  };

  it('fill_missing：把空缺字段补上（默认模式）', async () => {
    const { prisma, updates } = makePrisma({ taxRefund: draftWithNulls });
    const r = await recalcTaxRefund(prisma, 'CD1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.mode).toBe('fill_missing');
      expect(r.data.applied).toBe(true);
      expect(r.data.patch!.refundableVat).toBe(9230);
      expect(r.data.patch!.fxRate).toBe(7.1);
    }
    expect(updates).toHaveLength(1);
  });

  it('fill_missing：**不覆盖已有值**（人工填过的金额不被冲掉）', async () => {
    const { prisma, updates } = makePrisma({
      taxRefund: { ...draftWithNulls, refundableVat: '8888', refundAmount: '8888', fxRate: null },
    });
    const r = await recalcTaxRefund(prisma, 'CD1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.applied).toBe(true);
      expect(r.data.patch!.refundableVat).toBeUndefined(); // 已有值不动
      expect(r.data.patch!.refundAmount).toBeUndefined();
      expect(r.data.patch!.fxRate).toBe(7.1);              // 空的那个才补
    }
    expect(updates[0].refundableVat).toBeUndefined();
  });

  it('fill_missing：无空缺 → applied=false（不写库）', async () => {
    const { prisma, updates } = makePrisma({
      taxRefund: {
        ...draftWithNulls, fxRate: '7.1', exportAmountFob: '10000', exportAmountFobCurrency: 'USD',
        exportAmountCny: '71000', refundableVat: '9230', refundableRate: '13', refundAmount: '9230', exportDate: '2026-09-05',
      },
    });
    const r = await recalcTaxRefund(prisma, 'CD1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.applied).toBe(false);
      expect(r.data.message).toContain('没有可补的空缺字段');
    }
    expect(updates).toHaveLength(0);
  });

  it('force：只返回 diff，**不落库**', async () => {
    const { prisma, updates } = makePrisma({
      taxRefund: { ...draftWithNulls, refundableVat: '8888', refundAmount: '8888' },
    });
    const r = await recalcTaxRefund(prisma, 'CD1', { mode: 'force' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.applied).toBe(false);
      const fields = r.data.diff.map(d => d.field);
      expect(fields).toContain('refundableVat');
      const rv = r.data.diff.find(d => d.field === 'refundableVat')!;
      expect(rv.before).toBe('8888');
      expect(rv.after).toBe('9230');
      expect(r.data.message).toContain('未落库');
    }
    expect(updates).toHaveLength(0);
  });

  it('状态约束：Submitted 之后拒绝重算（409，已提交数据不可悄悄改）', async () => {
    for (const status of ['Submitted', 'Reviewing', 'Approved', 'Refunded', 'Cancelled']) {
      const { prisma, updates } = makePrisma({ taxRefund: { ...draftWithNulls, status } });
      const r = await recalcTaxRefund(prisma, 'CD1');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.status).toBe(409);
        expect(r.error.code).toBe('STATUS_NOT_RECALCULABLE');
      }
      expect(updates).toHaveLength(0);
    }
  });

  it('Rejected 状态允许重算（被打回的可以改）', async () => {
    const { prisma } = makePrisma({ taxRefund: { ...draftWithNulls, status: 'Rejected' } });
    const r = await recalcTaxRefund(prisma, 'CD1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.applied).toBe(true);
  });

  it('尚无退税单 → 404（提示先生成草稿）', async () => {
    const { prisma } = makePrisma({ taxRefund: null });
    const r = await recalcTaxRefund(prisma, 'CD1');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.status).toBe(404);
      expect(r.error.code).toBe('TAX_REFUND_NOT_FOUND');
    }
  });

  it('报关单不存在 → 404', async () => {
    const prisma: any = { customsDeclaration: { findFirst: async () => null } };
    const r = await recalcTaxRefund(prisma, 'NOPE');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('DECLARATION_NOT_FOUND');
  });

  it('非法 mode → 400', async () => {
    const { prisma } = makePrisma({ taxRefund: draftWithNulls });
    const r = await recalcTaxRefund(prisma, 'CD1', { mode: 'whatever' as any });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_MODE');
  });
});

/**
 * 2026-09-17 修的高危 bug（接线证明 + 证伪）
 *
 * 旧行为：`exportAmountFob` 直接取申报毛额。CIF 报关时申报毛额**含运保费**，
 * 退税额因此系统性虚高，且**不报错**（变量名还叫 FOB，实为 CIF）。
 *
 * 这两条是**接线测试**：纯函数 stripToFob 通过不代表 computeTaxRefundFigures 真的用了它。
 * 把实现改回 `exportAmountFob = grossAmount`，第 2 条会立刻转红。
 */
describe('CIF 运保费剥离（2026-09-17 高危修复 · 接线证明）', () => {
  const CIF_DECL = {
    id: 'CD_CIF', declarationNumber: 'CD-CIF-001', status: 'Released',
    orderId: 'ORD1', relationId: 'REL1', shipmentId: 'SHP1',
    currency: 'USD', totalValue: '100000', tradeTerms: 'CIF',
    freightAmount: '8000', insuranceAmount: '1200',
    declarationDate: '2026-09-01', deletedAt: null,
    lines: [{ id: 'CDL1', lineNumber: 1, hsCode: '5208.52', totalAmount: '100000' }],
  };

  it('CIF 且已登记运保费 → FOB = 申报额 − 运费 − 保费（不是申报额本身）', async () => {
    const { prisma } = makePrisma({ declaration: CIF_DECL });
    const f = await computeTaxRefundFigures(prisma, 'CD_CIF');
    expect(f!.exportAmountFob).toBe(90800); // 100000 - 8000 - 1200
    expect(f!.exportAmountFob).toBeLessThan(100000);
    expect(f!.gaps.map(g => g.code)).not.toContain('freight_missing');
  });

  it('CIF 但**未登记运费** → 不给退税额（fail-closed），并报 freight_missing', async () => {
    const { prisma } = makePrisma({
      declaration: { ...CIF_DECL, freightAmount: null },
    });
    const f = await computeTaxRefundFigures(prisma, 'CD_CIF');
    // 关键：绝不能回退成申报毛额 100000（那正是旧实现的错）
    expect(f!.exportAmountFob).toBeNull();
    expect(f!.exportAmountCny).toBeNull();
    expect(f!.refundAmount).toBeNull();
    expect(f!.gaps.map(g => g.code)).toContain('freight_missing');
    expect(f!.gaps.find(g => g.code === 'freight_missing')!.howToFix).toContain('运费');
  });

  it('FOB 报关 → 不受影响（不剥，回归保护）', async () => {
    const { prisma } = makePrisma({
      declaration: { ...CIF_DECL, tradeTerms: 'FOB', freightAmount: null, insuranceAmount: null },
    });
    const f = await computeTaxRefundFigures(prisma, 'CD_CIF');
    expect(f!.exportAmountFob).toBe(100000);
  });

  /**
   * ★ 第二刀：**钱**也必须剥离（2026-09-17 补）。
   *
   * 第一刀只改了 `exportAmountFob`（报出来的字段），`refundableVat` 仍在按行
   * `totalAmount`（申报毛额）累加 —— 字段对了、变量名对了，**钱没对**。
   * 这正是最容易假绿的地方：上面那条接线测试只断言 FOB 字段，全绿，但退税额照旧虚高。
   */
  it('★ refundAmount 必须按剥离后的 FOB 算（不是按申报毛额）', async () => {
    const { prisma } = makePrisma({ declaration: CIF_DECL });
    const f = await computeTaxRefundFigures(prisma, 'CD_CIF');
    // 90800 × 7.1 × 13% = 83808.4
    expect(f!.refundAmount).toBe(83808.4);
    // 反例：按申报毛额算会得到 100000 × 7.1 × 13% = 92300（虚高 8491.6，报给税务局要补税）
    expect(f!.refundAmount).not.toBe(92300);
    // 退税率必须是真实退税率 13%；按毛额算会凑出 92300/644680 ≈ 14.32% 这种不存在的数
    expect(f!.refundableRate).toBe(13);
  });

  it('★ 多行不同退税率 → 运保费按行金额占比分摊（不是整笔砸到第一行）', async () => {
    const { prisma } = makePrisma({
      declaration: {
        ...CIF_DECL,
        lines: [
          { id: 'L1', lineNumber: 1, hsCode: '5208.52', totalAmount: '60000' }, // 13%
          { id: 'L2', lineNumber: 2, hsCode: '6204.43', totalAmount: '40000' }, // 9%
        ],
      },
      hsCodes: [
        { code: '5208.52', exportTaxRebateRate: '13' },
        { code: '6204.43', exportTaxRebateRate: '9' },
      ],
    });
    const f = await computeTaxRefundFigures(prisma, 'CD_CIF');
    // k = 90800/100000 = 0.908；行 FOB = 54480 / 36320
    // 54480×7.1×13% + 36320×7.1×9% = 50285.04 + 23208.48 = 73493.52
    expect(f!.refundableVat).toBe(73493.52);
    // 加权退税率 = 0.6×13 + 0.4×9 = 11.4（若运保费全砸第一行，这个数会偏）
    expect(f!.refundableRate).toBe(11.4);
  });

  it('★ 剥不出 FOB 时钱也必须为 null（不能拿毛额算出个「看着对」的数）', async () => {
    const { prisma } = makePrisma({ declaration: { ...CIF_DECL, insuranceAmount: null } });
    const f = await computeTaxRefundFigures(prisma, 'CD_CIF');
    expect(f!.exportAmountFob).toBeNull();
    expect(f!.exportAmountCny).toBeNull();
    expect(f!.refundableVat).toBeNull();
    expect(f!.refundAmount).toBeNull();
    expect(f!.refundableRate).toBeNull();
    expect(f!.gaps.map(g => g.code)).toContain('insurance_missing');
  });
});
