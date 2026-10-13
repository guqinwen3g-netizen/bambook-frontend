/**
 * forwardFx.test.ts — ★ D6 真源单测：远期结汇合约的派生口径（纯函数）
 *
 * 为什么单测这块（零基础障碍清单 D6「远期结汇缺合约模型」）：
 *   `FxRateLock`（订单级锁汇）与 `FxSettlement`（结汇水单）都在，缺的是**与银行的远期合约** ⇒
 *   到期日没人管、合约汇率 vs 实际结汇汇率的**损益**算不出来。新增合约层的派生量（剩余/状态/损益/到期天数）必须可单测 —— 这些量算错 = 钱数错。
 */
import { describe, expect, it } from 'vitest';
import {
  forwardFxRemainingOf,
  forwardFxStatusOf,
  forwardFxPnlCnyOf,
  daysToMaturityOf,
  FORWARD_FX_STATUS_LABELS,
  FORWARD_FX_STATUSES,
} from '../forwardFxService';

describe('forwardFxRemainingOf（剩余可交割）', () => {
  it('① 正常：总 − 已交割', () => {
    expect(forwardFxRemainingOf(1000, 400)).toBe(600);
    expect(forwardFxRemainingOf(1000, 0)).toBe(1000);
  });

  it('★ ② 超额交割（历史脏数据）不会给负数 —— 但也不掩盖问题；创建侧会拒）', () => {
    expect(forwardFxRemainingOf(1000, 1500)).toBe(0);
  });

  it('③ 非数入参按 0 处理', () => {
    expect(forwardFxRemainingOf(null, null)).toBe(0);
    expect(forwardFxRemainingOf('x', 'y')).toBe(0);
  });
});

describe('forwardFxStatusOf（状态派生）', () => {
  it('① 未交割 → Open', () => {
    expect(forwardFxStatusOf({ foreignAmount: 1000, settledForeignAmount: 0 })).toBe('Open');
  });

  it('② 部分 → PartiallySettled', () => {
    expect(forwardFxStatusOf({ foreignAmount: 1000, settledForeignAmount: 300 })).toBe('PartiallySettled');
  });

  it('③ 交割完 → Settled', () => {
    expect(forwardFxStatusOf({ foreignAmount: 1000, settledForeignAmount: 1000 })).toBe('Settled');
  });

  it('★ ④ Cancelled 是终态（即使已交割完也保持 Cancelled → 不会「起死回生」）', () => {
    expect(forwardFxStatusOf({ foreignAmount: 1000, settledForeignAmount: 1000, cancelled: true })).toBe('Cancelled');
  });

  it('⑤ 枚举与标签齐全（漏一个 = 界面显示英文裸值）', () => {
    for (const s of FORWARD_FX_STATUSES) expect(FORWARD_FX_STATUS_LABELS[s]).toBeTruthy();
  });
});

describe('forwardFxPnlCnyOf（损益）', () => {
  it('① 实际汇率 > 合约汇率 → 正（比合约更划算 = 赚', () => {
    expect(forwardFxPnlCnyOf({ contractRate: 7.0, actualRate: 7.2, foreignAmount: 1000 })).toBe(200);
  });

  it('② 实际汇率 < 合约汇率 → 负（亏）', () => {
    expect(forwardFxPnlCnyOf({ contractRate: 7.2, actualRate: 7.0, foreignAmount: 1000 })).toBe(-200);
  });

  it('③ 一致 → 0', () => {
    expect(forwardFxPnlCnyOf({ contractRate: 7.1, actualRate: 7.1, foreignAmount: 1000 })).toBe(0);
  });

  it('★ ④ 入参非法 → null（**不猜**一个 0 或负数）', () => {
    expect(forwardFxPnlCnyOf({ contractRate: null, actualRate: 7.1, foreignAmount: 1000 })).toBeNull();
    expect(forwardFxPnlCnyOf({ contractRate: 7.1, actualRate: null, foreignAmount: 1000 })).toBeNull();
    expect(forwardFxPnlCnyOf({ contractRate: 7.1, actualRate: 7.1, foreignAmount: 0 })).toBeNull();
  });

  it('⑤ ★ Decimal 对象入参必须算得准（Prisma 查询结果是 Decimal，不是 number）', () => {
    const dec = (s: string) => ({ toString: () => s }) as any;
    expect(forwardFxPnlCnyOf({ contractRate: dec('7.0'), actualRate: dec('7.25'), foreignAmount: dec('400') })).toBe(100);
  });
});

describe('daysToMaturityOf（到期天数）', () => {
  it('① 未到期为正；已到期为负；当天为 0', () => {
    expect(daysToMaturityOf('2026-01-11', '2026-01-01')).toBe(10);
    expect(daysToMaturityOf('2025-12-25', '2026-01-01')).toBe(-7);
    expect(daysToMaturityOf('2026-01-01', '2026-01-01')).toBe(0);
  });

  it('★ ② 日期非法 → null（不猜 0 —— 0 会被读成"今天到期"，是最危险的错）', () => {
    expect(daysToMaturityOf('', '2026-01-01')).toBeNull();
    expect(daysToMaturityOf('2026-1-1', '2026-01-01')).toBeNull();
  });
});
