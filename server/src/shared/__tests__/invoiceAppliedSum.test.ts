/**
 * invoiceAppliedSum.test.ts —— 「发票已核销合计」真源的行为守卫
 *
 * 背景：批量汇总处曾各自手写 `invoiceAllocation.groupBy`（只算收款），
 * 而状态判定真源 `sumAppliedAmount` 含**贷项票抵扣** ⇒ 客户拿了索赔折让后
 * 「状态说已结清、列表却显示还欠折让额」。本守卫钉住批量真源与单张真源同源。
 */
import { describe, it, expect } from 'vitest';
import { sumAppliedAmountByInvoice, sumCreditNoteAppliedByInvoice } from '../invoiceAppliedSum';

type Row = { invoiceId: string; appliedAmount: unknown };

function tx(ia: Row[], cn: Row[] | null) {
  return {
    invoiceAllocation: { findMany: async () => ia },
    ...(cn === null ? {} : { creditNoteAllocation: { findMany: async () => cn } }),
  };
}

describe('sumAppliedAmountByInvoice（收款核销 + 贷项票抵扣）', () => {
  it('★ 阳性：收款 9500 + 贷项 500 ⇒ 10000（贷项必须计入，否则「状态已结清、余额仍欠 500」）', async () => {
    const m = await sumAppliedAmountByInvoice(
      tx([{ invoiceId: 'A', appliedAmount: 9500 }], [{ invoiceId: 'A', appliedAmount: 500 }]),
      ['A'],
    );
    expect(m.get('A')).toBe(10000);
  });

  it('★ 对照组：只有收款、无贷项 ⇒ 9500（本函数不夸大）', async () => {
    const m = await sumAppliedAmountByInvoice(tx([{ invoiceId: 'A', appliedAmount: 9500 }], []), ['A']);
    expect(m.get('A')).toBe(9500);
  });

  it('多张发票分别汇总，互不串账', async () => {
    const m = await sumAppliedAmountByInvoice(
      tx(
        [{ invoiceId: 'A', appliedAmount: 100 }, { invoiceId: 'B', appliedAmount: 200 }],
        [{ invoiceId: 'B', appliedAmount: 50 }],
      ),
      ['A', 'B'],
    );
    expect(m.get('A')).toBe(100);
    expect(m.get('B')).toBe(250);
    expect(m.has('C')).toBe(false);
  });

  it('同票多行累加（分次核销）', async () => {
    const m = await sumAppliedAmountByInvoice(
      tx([{ invoiceId: 'A', appliedAmount: 30 }, { invoiceId: 'A', appliedAmount: 70 }], []),
      ['A'],
    );
    expect(m.get('A')).toBe(100);
  });

  it('兼容性：mock 无 creditNoteAllocation 模型 ⇒ 退化只算收款，不抛错（真库恒存在）', async () => {
    const m = await sumAppliedAmountByInvoice(tx([{ invoiceId: 'A', appliedAmount: 100 }], null), ['A']);
    expect(m.get('A')).toBe(100);
  });

  it('吃 Prisma.Decimal 形态（带 toNumber）', async () => {
    const dec = { toNumber: () => 12.5 };
    const m = await sumAppliedAmountByInvoice(tx([{ invoiceId: 'A', appliedAmount: dec }], []), ['A']);
    expect(m.get('A')).toBe(12.5);
  });

  /**
   * ★ B273（评审 I-10）改判：这一格原本断言"脏值当 0"，而那**正是评审点名的缺陷形状**——
   *   这个和会被拿去算 `未收额 = 票面额 − Σ已核销`，脏值按 0 就等于让客户凭空多欠一笔。
   *   原句真正想守的是"不得让整票汇总变成 NaN"，这一点由**抛错**同样满足（而且更强：
   *   既不 NaN，也不静默少算）。⇒ 断言从"得 40"改成"当场拒"，不是我把测试改成配合实现。
   */
  it('脏值不污染：null / NaN / 非数字 ⇒ 当场拒（既不 NaN，也不静默按 0 少算）', async () => {
    await expect(
      sumAppliedAmountByInvoice(
        tx(
          [
            { invoiceId: 'A', appliedAmount: null },
            { invoiceId: 'A', appliedAmount: Number.NaN },
            { invoiceId: 'A', appliedAmount: 'abc' },
            { invoiceId: 'A', appliedAmount: 40 },
          ],
          [],
        ),
        ['A'],
      ),
    ).rejects.toThrow(/appliedAmount/);
  });

  it('空入参 ⇒ 空 Map（不发查询、不瞎判）', async () => {
    let called = false;
    const spy = {
      invoiceAllocation: { findMany: async () => { called = true; return []; } },
    };
    const m = await sumAppliedAmountByInvoice(spy, []);
    expect(m.size).toBe(0);
    expect(called).toBe(false);
  });

  it('tx 为 null/undefined ⇒ 空 Map（不抛错）', async () => {
    expect((await sumAppliedAmountByInvoice(null, ['A'])).size).toBe(0);
    expect((await sumAppliedAmountByInvoice(undefined, ['A'])).size).toBe(0);
  });
});

describe('sumCreditNoteAppliedByInvoice（仅贷项，供有自身过滤条件的消费点叠加）', () => {
  it('★ 只返回贷项部分，不含收款（不得把收款算两遍）', async () => {
    const m = await sumCreditNoteAppliedByInvoice(
      tx([{ invoiceId: 'A', appliedAmount: 9500 }], [{ invoiceId: 'A', appliedAmount: 500 }]),
      ['A'],
    );
    expect(m.get('A')).toBe(500);
  });

  it('无贷项 ⇒ 空 Map', async () => {
    const m = await sumCreditNoteAppliedByInvoice(tx([], []), ['A']);
    expect(m.size).toBe(0);
  });

  it('mock 无该模型 ⇒ 空 Map（兼容旧测试替身）', async () => {
    const m = await sumCreditNoteAppliedByInvoice(tx([], null), ['A']);
    expect(m.size).toBe(0);
  });
});
