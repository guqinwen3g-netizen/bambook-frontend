/**
 * invoiceAppliedSumFailLoud.test.ts — 台账 §9 B273 / 评审 I-10（补，M3 前）：
 * 「已核销额」唯一真源里的 `num()` 原本把**坏值静默变成 0**，而这个 0 会被累加进
 * `未收额 = 票面额 − Σ已核销` ⇒ 一笔读不出来的核销金额会让客户**凭空多欠一笔钱**。
 *
 * ★ 可达性先量过再定性（不许拿"没样本"当不适用）：两张核销表的 `appliedAmount`
 *   在 schema 与现库都是 `Decimal(18,4) NOT NULL`（`information_schema` 现读 is_nullable=NO、
 *   库内 null **0** 条）⇒ 走 Prisma 的正常路径喂不出那三种坏形状。
 *   所以本件钉的是**剩下那条路**：这个函数是 export 出去的，消费点有 `agent/toolRuntime`、
 *   `credit/creditService` 等非纯 DB 调用方 ⇒ 一旦有人传进 null / NaN / 抛错的 Decimal，
 *   必须**当场炸**，不许悄悄当 0 加进钱里。
 */
import { describe, it, expect, vi } from 'vitest';
import { sumAppliedAmountByInvoice } from '../invoiceAppliedSum';

const invoiceIds = ['INV-B273-1'];

const txWith = (allocations: any[], creditAllocations: any[] = []) => ({
  invoiceAllocation: { findMany: vi.fn().mockResolvedValue(allocations) },
  creditNoteAllocation: { findMany: vi.fn().mockResolvedValue(creditAllocations) },
}) as any;

describe('B273：核销汇总遇到读不出来的金额必须当场炸，不许静默按 0 累加', () => {
  it('① 正常 Decimal 行照旧汇总（阳性对照：不是把函数改成永不返回）', async () => {
    const map = await sumAppliedAmountByInvoice(
      txWith([{ invoiceId: 'INV-B273-1', appliedAmount: { toNumber: () => 300 } }]),
      invoiceIds,
    );
    expect(map.get('INV-B273-1')).toBe(300);
  });

  it('② appliedAmount 为 null ⇒ 抛错，不返回 0', async () => {
    await expect(
      sumAppliedAmountByInvoice(txWith([{ invoiceId: 'INV-B273-1', appliedAmount: null }]), invoiceIds),
    ).rejects.toThrow(/appliedAmount/i);
  });

  it('③ 拿到 NaN/Infinity 的 number ⇒ 抛错', async () => {
    await expect(
      sumAppliedAmountByInvoice(txWith([{ invoiceId: 'INV-B273-1', appliedAmount: Number.NaN }]), invoiceIds),
    ).rejects.toThrow(/appliedAmount/i);
  });

  it('④ 字符串是"1,000"这种读不出来的形状 ⇒ 抛错（原来 `Number("1,000")` 得 NaN 再被夹成 0）', async () => {
    await expect(
      sumAppliedAmountByInvoice(txWith([{ invoiceId: 'INV-B273-1', appliedAmount: '1,000' }]), invoiceIds),
    ).rejects.toThrow(/appliedAmount/i);
  });

  it('⑤ Decimal 的 toNumber() 自己抛错 ⇒ 也炸，不许被 catch 吞成 0', async () => {
    const boom = { toNumber: () => { throw new Error('Decimal overflow'); } };
    await expect(
      sumAppliedAmountByInvoice(txWith([{ invoiceId: 'INV-B273-1', appliedAmount: boom }]), invoiceIds),
    ).rejects.toThrow(/appliedAmount/i);
  });

  it('⑥ 贷项抵扣那一侧同族同修（同一个 num 喂两张表）', async () => {
    await expect(
      sumAppliedAmountByInvoice(txWith([], [{ invoiceId: 'INV-B273-1', appliedAmount: null }]), invoiceIds),
    ).rejects.toThrow(/appliedAmount/i);
  });
});
