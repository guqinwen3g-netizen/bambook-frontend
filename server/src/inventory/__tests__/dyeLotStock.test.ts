/**
 * dyeLotStock.test.ts — ★ D1 真源单测：库存缸号归集 + 色差风险（纯函数）
 *
 * 为什么单测这块（零基础障碍清单 D1「缺库存层 lot」）：
 *   面料行业**同缸号才能同批裁**（避免缸差）。缸号/色差评级只存在于缸差登记
 *   （`SampleColorBatch`），与库存零交集 ⇒ 业务员无法判断「这批货能不能用来做这一单」。
 *   本真源把「按缸号看库存 + 色差风险」做成可单测的纯函数。
 *
 * ★ 核心纪律：**未登记缸号一律 `unknown`，不是 `low`** ——「不知道」不能显示成「没问题」。
 */
import { describe, expect, it } from 'vitest';
import {
  summarizeDyeLotStock,
  dyeLotRiskOf,
  describeDyeLot,
  type DyeLotStockItemRef,
  type DyeLotRef,
} from '../dyeLotStockService';

const I = (batchNumber: string | null, quantity: number, unit = 'M'): DyeLotStockItemRef =>
  ({ itemId: `inv-${batchNumber}-${quantity}`, batchNumber, quantity, unit, category: 'Fabric' });
const D = (dyeLotNo: string, over: Partial<DyeLotRef> = {}): DyeLotRef =>
  ({ dyeLotNo, colorRating: 5, sideDiff: 5, endDiff: 5, defectCauses: [], stage: 'bulk', ...over });

describe('dyeLotRiskOf（色差评级 → 业务风险）', () => {
  it('① 未登记 / 无评级 → unknown（**不是** low）', () => {
    expect(dyeLotRiskOf(null)).toBe('unknown');
    expect(dyeLotRiskOf({ dyeLotNo: 'L1' })).toBe('unknown');
    expect(dyeLotRiskOf({ dyeLotNo: 'L1', colorRating: null })).toBe('unknown');
  });

  it('② 评级 ≤2 → high（慎用）', () => {
    expect(dyeLotRiskOf(D('L1', { colorRating: 2 }))).toBe('high');
    expect(dyeLotRiskOf(D('L1', { colorRating: 1 }))).toBe('high');
  });

  it('③ 评级 =3 → medium', () => {
    expect(dyeLotRiskOf(D('L1', { colorRating: 3 }))).toBe('medium');
  });

  it('④ 评级 ≥4 但左右/前后色差 ≤3 → medium（主评级好、局部色差不合格）', () => {
    expect(dyeLotRiskOf(D('L1', { colorRating: 5, sideDiff: 3 }))).toBe('medium');
    expect(dyeLotRiskOf(D('L1', { colorRating: 5, endDiff: 2 }))).toBe('medium');
  });

  it('⑤ 评级 ≥4 且色差未评 → low（未评 ≠ 差，不误报）', () => {
    expect(dyeLotRiskOf({ dyeLotNo: 'L1', colorRating: 4, sideDiff: null, endDiff: null })).toBe('low');
  });
});

describe('summarizeDyeLotStock（按缸号归集）', () => {
  it('① 按 batchNumber 分组；数量**按单位分组**（跨单位不可加）', () => {
    const r = summarizeDyeLotStock({
      items: [I('L1', 100, 'M'), I('L1', 50, 'M'), I('L1', 20, 'YD')],
      dyeLots: [D('L1')],
    });
    expect(r.lots).toHaveLength(1);
    const g = r.lots[0];
    expect(g.itemCount).toBe(3);
    expect(g.quantityByUnit).toEqual(expect.arrayContaining([{ unit: 'M', quantity: 150 }, { unit: 'YD', quantity: 20 }]));
  });

  it('② 已登记缸号 → 带出评级与风险', () => {
    const r = summarizeDyeLotStock({ items: [I('L1', 100)], dyeLots: [D('L1', { colorRating: 3 })] });
    expect(r.lots[0].registered).toBe(true);
    expect(r.lots[0].colorRating).toBe(3);
    expect(r.lots[0].risk).toBe('medium');
    expect(r.lots[0].note).toContain('需复核');
  });

  it('★ ③ 未登记缸号 → risk=unknown 且进入 unregisteredLots（数据缺口可见）', () => {
    const r = summarizeDyeLotStock({ items: [I('L-NEW', 100)], dyeLots: [D('L1')] });
    expect(r.lots[0].risk).toBe('unknown');
    expect(r.lots[0].registered).toBe(false);
    expect(r.unregisteredLots).toEqual(['L-NEW']);
    expect(r.lots[0].note).toContain('未在缸差登记里找到');
  });

  it('④ 空/空白批次号 → 不计入任何缸，单独计数（noBatchCount）', () => {
    const r = summarizeDyeLotStock({ items: [I('L1', 100), I(null, 10), I('   ', 20)], dyeLots: [D('L1')] });
    expect(r.lots).toHaveLength(1);
    expect(r.noBatchCount).toBe(2);
  });

  it('⑤ 批次号首尾空白归一（` L1 ` 与 `L1` 同缸）', () => {
    const r = summarizeDyeLotStock({ items: [I(' L1 ', 100), I('L1', 50)], dyeLots: [D('L1')] });
    expect(r.lots).toHaveLength(1);
    expect(r.lots[0].itemCount).toBe(2);
  });

  it('⑥ 同一缸号多条登记 → 取**首条**（调用方按时间倒序传入 = 最新）', () => {
    const r = summarizeDyeLotStock({
      items: [I('L1', 100)],
      dyeLots: [D('L1', { colorRating: 2 }), D('L1', { colorRating: 5 })],
    });
    expect(r.lots[0].colorRating).toBe(2); // 最新那条
    expect(r.lots[0].risk).toBe('high');
  });

  it('⑦ 排序：high → unknown → medium → low（业务员先看要处理的）', () => {
    const r = summarizeDyeLotStock({
      items: [I('L-low', 1), I('L-med', 1), I('L-unk', 1), I('L-high', 1)],
      dyeLots: [D('L-low'), D('L-med', { colorRating: 3 }), D('L-high', { colorRating: 1 })],
    });
    expect(r.lots.map(l => l.lot)).toEqual(['L-high', 'L-unk', 'L-med', 'L-low']);
  });

  it('⑧ summary 计数自洽', () => {
    const r = summarizeDyeLotStock({
      items: [I('L1', 1), I('L2', 1), I('L3', 1)],
      dyeLots: [D('L1'), D('L3', { colorRating: 1 })],
    });
    expect(r.summary).toEqual({ lotCount: 3, registeredCount: 2, unregisteredCount: 1, highRiskCount: 1 });
  });

  it('⑨ 空输入不炸（无库存/无缸号登记）', () => {
    expect(summarizeDyeLotStock({ items: [], dyeLots: [] })).toMatchObject({
      lots: [], unregisteredLots: [], noBatchCount: 0,
      summary: { lotCount: 0, registeredCount: 0, unregisteredCount: 0, highRiskCount: 0 },
    });
  });

  it('⑩ 非数/缺失数量被跳过（不制造假数量）', () => {
    const r = summarizeDyeLotStock({
      items: [I('L1', 100), { itemId: 'x', batchNumber: 'L1', quantity: Number.NaN, unit: 'M' }],
      dyeLots: [D('L1')],
    });
    expect(r.lots[0].quantityByUnit).toEqual([{ unit: 'M', quantity: 100 }]);
  });
});

describe('describeDyeLot（面向人的一句话）', () => {
  it('已登记：带主评级与色差 + 业务结论', () => {
    const note = describeDyeLot({ lot: 'L1', registered: true, colorRating: 5, sideDiff: 4, endDiff: null, risk: 'low' });
    expect(note).toContain('缸号 L1');
    expect(note).toContain('主评级 5');
    expect(note).toContain('左右 4');
    expect(note).toContain('可正常使用');
  });

  it('未登记：明说"无法判断，请补登记"（不给业务员假安心）', () => {
    const note = describeDyeLot({ lot: 'LX', registered: false, colorRating: null, sideDiff: null, endDiff: null, risk: 'unknown' });
    expect(note).toContain('无法判断');
    expect(note).toContain('补登记');
  });
});
