/**
 * incotermConsistency.test.ts — D2 报关成交方式 ↔ 订单 Incoterms 一致性核对
 *
 * 口径（业务方授权按行业专业判断）钉住的不变量：
 *   1. **以订单条款为准**（商业合同依据）；差异只预警不阻断（severity 恒 warning）
 *   2. **逐字归一化比对**：CFR ≠ CIF 是差异（保险责任不同），但按矩阵 D2 分组区分严重程度
 *      —— 跨组（FOB vs CIF）> 同组细分（CFR vs CIF）
 *   3. 一侧缺失 → incoterm_missing（报"无法核对"而非"不一致"）
 *   4. 订单锚可经运单回退（报关单可能只挂 shipmentId）
 */
import { describe, expect, it } from 'vitest';
import { checkIncotermConsistency, incotermGroup } from '../incotermConsistency';

function makePrisma(seed: {
  declaration?: any;
  shipment?: any;
  order?: any;
} = {}) {
  const declaration = seed.declaration === undefined
    ? { id: 'CD1', declarationNumber: 'CD-001', orderId: 'ORD1', shipmentId: 'SHP1', tradeTerms: 'FOB', deletedAt: null }
    : seed.declaration;
  const shipment = seed.shipment === undefined ? { id: 'SHP1', orderId: 'ORD1' } : seed.shipment;
  const order = seed.order === undefined ? { id: 'ORD1', code: 'SO-001', deliveryTerms: 'FOB', deletedAt: null } : seed.order;
  return {
    customsDeclaration: { findFirst: async () => declaration },
    shipment: { findUnique: async () => shipment },
    order: { findFirst: async () => order },
  } as any;
}

describe('incotermGroup — 按矩阵 D2 拍板分组（CFR 随 CIF）', () => {
  it('FOB / FCA / EXW → FOB 组（买方负责主运费）', () => {
    expect(incotermGroup('FOB')).toBe('FOB');
    expect(incotermGroup('fca')).toBe('FOB');
    expect(incotermGroup(' EXW ')).toBe('FOB');
  });

  it('CIF / CIP / CFR / CPT → CIF 组（卖方负责主运费，CFR 随 CIF）', () => {
    expect(incotermGroup('CIF')).toBe('CIF');
    expect(incotermGroup('CIP')).toBe('CIF');
    expect(incotermGroup('CFR')).toBe('CIF');
    expect(incotermGroup('CPT')).toBe('CIF');
  });

  it('D 组 → OTHER', () => {
    expect(incotermGroup('DDP')).toBe('OTHER');
    expect(incotermGroup('DAP')).toBe('OTHER');
  });

  it('空值 → null', () => {
    expect(incotermGroup(null)).toBeNull();
    expect(incotermGroup('   ')).toBeNull();
  });
});

describe('checkIncotermConsistency — D2 一致性核对', () => {
  it('一致（FOB vs FOB）→ 零差异', async () => {
    const r = await checkIncotermConsistency(makePrisma(), 'CD1');
    expect(r).not.toBeNull();
    expect(r!.consistent).toBe(true);
    expect(r!.sameGroup).toBe(false);
    expect(r!.discrepancies).toEqual([]);
  });

  it('归一化后一致（大小写/空白差异）→ 不算不一致', async () => {
    const r = await checkIncotermConsistency(makePrisma({
      declaration: { id: 'CD1', declarationNumber: 'CD-001', orderId: 'ORD1', shipmentId: 'SHP1', tradeTerms: ' fob ', deletedAt: null },
      order: { id: 'ORD1', code: 'SO-001', deliveryTerms: 'FOB', deletedAt: null },
    }), 'CD1');
    expect(r!.consistent).toBe(true);
    expect(r!.discrepancies).toEqual([]);
  });

  it('**跨组**不一致（订单 CIF / 报关 FOB）→ warning 且提示"跨组"', async () => {
    const r = await checkIncotermConsistency(makePrisma({
      declaration: { id: 'CD1', declarationNumber: 'CD-001', orderId: 'ORD1', shipmentId: 'SHP1', tradeTerms: 'FOB', deletedAt: null },
      order: { id: 'ORD1', code: 'SO-001', deliveryTerms: 'CIF', deletedAt: null },
    }), 'CD1');
    expect(r!.consistent).toBe(false);
    expect(r!.sameGroup).toBe(false);
    const d = r!.discrepancies[0];
    expect(d.type).toBe('incoterm_mismatch');
    expect(d.severity).toBe('warning');
    expect(d.expected).toBe('CIF');   // 期望 = 订单条款
    expect(d.actual).toBe('FOB');     // 实际 = 报关成交方式
    expect(d.message).toContain('跨组');
    expect(d.message).toContain('以订单条款为准');
  });

  it('**同组细分**差异（订单 CFR / 报关 CIF）→ warning 且提示"是否含保险"', async () => {
    const r = await checkIncotermConsistency(makePrisma({
      declaration: { id: 'CD1', declarationNumber: 'CD-001', orderId: 'ORD1', shipmentId: 'SHP1', tradeTerms: 'CIF', deletedAt: null },
      order: { id: 'ORD1', code: 'SO-001', deliveryTerms: 'CFR', deletedAt: null },
    }), 'CD1');
    expect(r!.consistent).toBe(false);
    expect(r!.sameGroup).toBe(true);   // 同组
    const d = r!.discrepancies[0];
    expect(d.message).toContain('同组细分');
    expect(d.message).toContain('保险');
  });

  it('订单未登记交货条款 → incoterm_missing（报"无法核对"）', async () => {
    const r = await checkIncotermConsistency(makePrisma({
      order: { id: 'ORD1', code: 'SO-001', deliveryTerms: null, deletedAt: null },
    }), 'CD1');
    expect(r!.discrepancies[0].type).toBe('incoterm_missing');
    expect(r!.discrepancies[0].message).toContain('无法与报关成交方式');
  });

  it('报关未填成交方式 → incoterm_missing', async () => {
    const r = await checkIncotermConsistency(makePrisma({
      declaration: { id: 'CD1', declarationNumber: 'CD-001', orderId: 'ORD1', shipmentId: 'SHP1', tradeTerms: null, deletedAt: null },
    }), 'CD1');
    expect(r!.discrepancies[0].type).toBe('incoterm_missing');
    expect(r!.discrepancies[0].message).toContain('无法与订单条款');
  });

  it('订单锚经运单回退（报关单只挂 shipmentId）', async () => {
    const r = await checkIncotermConsistency(makePrisma({
      declaration: { id: 'CD1', declarationNumber: 'CD-001', orderId: null, shipmentId: 'SHP1', tradeTerms: 'FOB', deletedAt: null },
      shipment: { id: 'SHP1', orderId: 'ORD1' },
    }), 'CD1');
    expect(r!.orderId).toBe('ORD1');
    expect(r!.orderTerms).toBe('FOB');
    expect(r!.consistent).toBe(true);
  });

  it('任何差异 severity **恒为 warning**（口径：只预警不阻断）', async () => {
    const cases = [
      { declaration: { id: 'CD1', declarationNumber: 'CD-001', orderId: 'ORD1', shipmentId: 'SHP1', tradeTerms: 'FOB', deletedAt: null }, order: { id: 'ORD1', code: 'S', deliveryTerms: 'CIF', deletedAt: null } },
      { declaration: { id: 'CD1', declarationNumber: 'CD-001', orderId: 'ORD1', shipmentId: 'SHP1', tradeTerms: 'CIF', deletedAt: null }, order: { id: 'ORD1', code: 'S', deliveryTerms: 'CFR', deletedAt: null } },
      { declaration: { id: 'CD1', declarationNumber: 'CD-001', orderId: 'ORD1', shipmentId: 'SHP1', tradeTerms: 'FOB', deletedAt: null }, order: { id: 'ORD1', code: 'S', deliveryTerms: null, deletedAt: null } },
    ];
    for (const c of cases) {
      const r = await checkIncotermConsistency(makePrisma(c), 'CD1');
      expect(r!.discrepancies.length).toBeGreaterThan(0);
      expect(r!.discrepancies.every(d => d.severity === 'warning')).toBe(true);
    }
  });

  it('订单写 `FOB SHANGHAI`（带港口）/ 报关写 `FOB`（代码）→ **视为一致**（行业：报关成交方式栏不含地点）', async () => {
    const r = await checkIncotermConsistency(makePrisma({
      order: { id: 'ORD1', code: 'SO-001', deliveryTerms: 'FOB SHANGHAI', deletedAt: null },
      declaration: { id: 'CD1', declarationNumber: 'CD-001', orderId: 'ORD1', shipmentId: 'SHP1', tradeTerms: 'FOB', deletedAt: null },
    }), 'CD1');
    expect(r!.consistent).toBe(true);
    expect(r!.discrepancies).toEqual([]);
  });

  it('订单写 `CIF SURABAYA` / 报关写 `FOB` → 仍是跨组不一致（提取代码不得掩盖真差异）', async () => {
    const r = await checkIncotermConsistency(makePrisma({
      order: { id: 'ORD1', code: 'SO-001', deliveryTerms: 'CIF SURABAYA', deletedAt: null },
    }), 'CD1');
    expect(r!.consistent).toBe(false);
    expect(r!.discrepancies[0].message).toContain('跨组');
    expect(r!.discrepancies[0].message).toContain('CIF SURABAYA'); // 原文出现在提示里，便于人工判断
  });

  it('报关单不存在 → null（路由层转 404）', async () => {
    const prisma: any = { customsDeclaration: { findFirst: async () => null } };
    expect(await checkIncotermConsistency(prisma, 'NOPE')).toBeNull();
  });
});
