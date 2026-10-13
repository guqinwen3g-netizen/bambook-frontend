import { describe, it, expect } from 'vitest';
import {
  settlementBasisOf,
  isSettledByApplied,
  remainingByApplied,
} from '../invoiceSettlementBasis';

/**
 * 结清基准额真源守卫（CLM 索赔 S2 / S6）
 *
 * ★ 每条断言都要能踩红：写完后请逐个把期望值反过来跑一次，确认测试真的会失败
 *   （本仓踩过「判据是空集 / 断言永远成立」的亏）。
 */

describe('settlementBasisOf — 面额 = |amount|', () => {
  it('正额票：basis === amount（历史行为逐字节不变）', () => {
    expect(settlementBasisOf(1000)).toBe(1000);
    expect(settlementBasisOf('1000')).toBe(1000);
  });

  it('负额票：basis === |amount|（修复点：面额不能是负数本身）', () => {
    expect(settlementBasisOf(-500)).toBe(500);
    expect(settlementBasisOf('-500')).toBe(500);
  });

  it('0 元票：basis === 0', () => {
    expect(settlementBasisOf(0)).toBe(0);
  });

  it('Decimal 入参走 Decimal 路径（精度无损，返回值仍带 .gt）', () => {
    const dec = { abs: () => ({ gt: () => true, gte: () => true, toString: () => '500' }), toNumber: () => -500 };
    const basis = settlementBasisOf(dec as any);
    expect(typeof (basis as any).gt).toBe('function');
    expect((basis as any).toString()).toBe('500');
  });
});

describe('isSettledByApplied — 已结清判定', () => {
  it('阳性对照：正额票核销满 → 已结清', () => {
    expect(isSettledByApplied(1000, 1000)).toBe(true);
    expect(isSettledByApplied(1000, 1200)).toBe(true);
  });

  it('正额票未核销满 → 未结清', () => {
    expect(isSettledByApplied(1000, 999)).toBe(false);
    expect(isSettledByApplied(1000, 0)).toBe(false);
  });

  it('★ 负额票核销满（|amount|）→ 已结清（修复前恒 false）', () => {
    expect(isSettledByApplied(-500, 500)).toBe(true);
    expect(isSettledByApplied(-500, 600)).toBe(true);
  });

  it('★★ 负额票未核销 → 必须仍判未结清（防「一建就结清」导致应付虚增）', () => {
    // 若把判据简化成 `applied >= amount`，这里会变成 true（0 >= -500）
    // ⇒ 贷项票刚生成就被判结清 ⇒ 从未结清应付列表消失 ⇒ 应付合计不再被冲减 ⇒ 应付虚增 500。
    expect(isSettledByApplied(-500, 0)).toBe(false);
    expect(isSettledByApplied(-500, 300)).toBe(false);
  });

  it('0 元票刻意不判结清（保持收口前行为）', () => {
    expect(isSettledByApplied(0, 0)).toBe(false);
  });
});

describe('remainingByApplied — 剩余可核销额', () => {
  it('正额票：amount − applied', () => {
    expect(remainingByApplied(1000, 400)).toBe(600);
  });

  it('★ 负额票：|amount| − applied（修复前恒为负 ⇒ 任何核销都判超额）', () => {
    expect(remainingByApplied(-500, 0)).toBe(500);
    expect(remainingByApplied(-500, 200)).toBe(300);
  });
});
