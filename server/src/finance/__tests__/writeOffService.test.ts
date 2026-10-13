/**
 * writeOffService 单测 —— ★ C7 尾差销账的上限口径（纯函数）
 *
 * 为什么单测这一块：上限是**防滥用**的唯一闸门（否则尾差销账会变成「一键销掉整张发票」）。
 * 真库演练（`writeOffTailDrill.test.ts`）钉接线与状态机结果，这里钉口径本身。
 */
import { describe, expect, it } from 'vitest';
import { checkTailThreshold, TAIL_MAX_BASE_CNY, TAIL_MAX_RATIO } from '../writeOffService';

describe('checkTailThreshold（尾差上限：比例 AND 等值本位币，取更严）', () => {
  it('小尾差（发票 10 万 USD、汇率 7.1）→ 放行', () => {
    // 比例上限 = 5000；等值上限 = 500/7.1 ≈ 70.42 ⇒ 取 70.42
    const r = checkTailThreshold({ writeOffAmount: 3.25, invoiceAmount: 100000, rateToCny: 7.1 });
    expect(r.ok).toBe(true);
    expect(r.message).toBeNull();
    expect(r.maxAllowed).toBeCloseTo(TAIL_MAX_BASE_CNY / 7.1, 4);
  });

  it('等值上限比比例上限更严时，以等值为准（大额发票不能靠 5% 销掉几千刀）', () => {
    const r = checkTailThreshold({ writeOffAmount: 1000, invoiceAmount: 100000, rateToCny: 7.1 });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('尾差上限');
  });

  it('比例上限比等值上限更严时，以比例为准（小额发票不能被 500 CNY 放大）', () => {
    // 发票 100 USD、汇率 7.1：比例上限 = 5 USD；等值上限 = 500/7.1 ≈ 70.4 ⇒ 取 5
    const r = checkTailThreshold({ writeOffAmount: 10, invoiceAmount: 100, rateToCny: 7.1 });
    expect(r.ok).toBe(false);
    expect(r.maxAllowed).toBeCloseTo(100 * TAIL_MAX_RATIO, 4);
  });

  it('边界：正好等于上限 → 放行（不用浮点相等）', () => {
    const invoiceAmount = 1000;
    const max = invoiceAmount * TAIL_MAX_RATIO; // 50，且 50 USD ≈ 355 CNY < 500 ⇒ 取 50
    const r = checkTailThreshold({ writeOffAmount: max, invoiceAmount, rateToCny: 7.1 });
    expect(r.ok).toBe(true);
    expect(r.maxAllowed).toBeCloseTo(50, 4);
  });

  it('汇率缺失 → 只用比例口径（不因缺汇率把正常尾差卡死），且消息里说明', () => {
    const okRes = checkTailThreshold({ writeOffAmount: 3, invoiceAmount: 100000, rateToCny: null });
    expect(okRes.ok).toBe(true);
    expect(okRes.baseLimitInInvoiceCurrency).toBeNull();

    const badRes = checkTailThreshold({ writeOffAmount: 6000, invoiceAmount: 100000, rateToCny: null });
    expect(badRes.ok).toBe(false);
    expect(badRes.message).toContain('本位币汇率缺失');
  });

  it('CNY 发票：等值上限直接生效（rate=1）', () => {
    const r = checkTailThreshold({ writeOffAmount: 600, invoiceAmount: 100000, rateToCny: 1 });
    expect(r.ok).toBe(false);
    expect(r.maxAllowed).toBe(TAIL_MAX_BASE_CNY);
  });

  it('拒绝消息必须同时给出两个上限 + 出口指引（不静默）', () => {
    const r = checkTailThreshold({ writeOffAmount: 9999, invoiceAmount: 10000, rateToCny: 7.1 });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('5%');
    expect(r.message).toContain('客户索赔');
  });
});
