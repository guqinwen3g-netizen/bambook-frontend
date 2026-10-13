/**
 * thirdPartyStatementAttribution.test.ts — ★ A2 真库守卫：第三方代付必须记到**合同客户**头上
 *
 * 为什么要有这个测试（零基础障碍清单 A2，⚠️ 静默错账级）：
 *   旧逻辑按 `PaymentVoucher.customerRelationId`（= **打款人**）归集收款 ⇒
 *   A 替 B 付的钱：B 的对账单查不到（客户拿水单来对账时对不上），
 *   而 A 的对账单凭空多一笔无发票收款（余额变负）。两端都是账实不符。
 *
 * 判据（真库 + 前缀隔离 + 自回滚 + 独立复核零残留，含阳性对照）：
 *   ① 阳性对照：自付全额 → 对账单结清 0、无代付标（证明改造没弄坏正常路径）
 *   ② 代付全额 → 合同客户对账单出现该笔收款 + isThirdParty + 结清 0
 *   ③ 同一笔钱不得同时出现在代付方对账单（原来会让代付方余额变负）
 *   ④ 代付部分核销 → 合同客户只认核销额，余款留在打款人名下（预收不凭空归别人）
 *   ⑤ 未核销代付 → 合同客户对账单不出现收款，钱留在打款人名下
 *   ⑥ 跨口径对撞：代付核销后，账龄里合同客户的 open 同步下降（账龄侧本来就按票归集，
 *      这里坐实「对账单与账龄同源」，防止只修了一边）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Prisma } from '@prisma/client';
import { getCustomerStatement, getAgingReport } from '../reportService';
import { createDrillContext, noBackendMessage, safeResidualCounts } from '../../__tests__/lib/drillTouchLog';

const MARK = 'TEST_TPA_';
const ctx = createDrillContext({ prefix: MARK });
const prisma = ctx.prisma;
const REL_B = 'TEST_TPA_REL_CONTRACT';   // 合同客户（票开给谁）
const REL_A = 'TEST_TPA_REL_PAYER';      // 代付方（实际打款人）

let seq = 0;
const nextId = (p: string) => ctx.id(`${p}_${++seq}`);

async function makeReceivableInvoice(relationId: string, amount: string, currency = 'USD') {
  return prisma.invoice.create({
    data: {
      id: nextId('INV'), invoiceNumber: `TEST-TPA-${Date.now()}-${++seq}`,
      type: 'Receivable', status: 'Issued', amount: new Prisma.Decimal(amount),
      currency, issueDate: '2026-09-18', dueDate: '2026-10-18',
      customerRelationId: relationId,
      customerName: relationId === REL_B ? 'TPA 合同客户 Beta' : 'TPA 客户 Alpha',
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    },
  });
}

async function makeReceiptVoucher(relationId: string, amount: string, currency = 'USD') {
  return prisma.paymentVoucher.create({
    data: {
      id: nextId('PAY'), voucherNumber: `TEST-TPA-PAY-${Date.now()}-${++seq}`,
      type: 'Receipt', amount: new Prisma.Decimal(amount), currency,
      paymentDate: '2026-09-18', paymentMethod: 'TT', status: 'unreconciled',
      customerRelationId: relationId,
      customerName: relationId === REL_A ? 'TPA 代付方 Alpha' : 'TPA 客户 Beta',
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    },
  });
}

async function allocate(invoiceId: string, voucherId: string, appliedAmount: string) {
  return prisma.invoiceAllocation.create({
    data: {
      id: nextId('ALLOC'), invoiceId, voucherId,
      appliedAmount: new Prisma.Decimal(appliedAmount),
      appliedDate: '2026-09-18',
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    },
  });
}

/** 独立复核：不信任自己的回滚自述 —— 按前缀实查一遍 */
/** ★ v3.31（B151）：普查交给基座 ⇒ "没有读数"不再冒充"清干净"。键与 where 逐字搬自旧 `residualCounts()`。 */
const RESIDUAL_SPEC = [
  { key: 'inv', model: 'invoice', run: () => prisma.invoice.count({ where: { id: { startsWith: ctx.mark } } }) },
  { key: 'voc', model: 'paymentVoucher', run: () => prisma.paymentVoucher.count({ where: { id: { startsWith: ctx.mark } } }) },
  { key: 'alloc', model: 'invoiceAllocation', run: () => prisma.invoiceAllocation.count({ where: { id: { startsWith: ctx.mark } } }) },
];

async function cleanup() {
  await prisma.invoiceAllocation.deleteMany({ where: { id: { startsWith: ctx.mark } } });
  await prisma.invoice.deleteMany({ where: { id: { startsWith: ctx.mark } } });
  await prisma.paymentVoucher.deleteMany({ where: { id: { startsWith: ctx.mark } } });
}

const receiptOf = (stmt: Awaited<ReturnType<typeof getCustomerStatement>>, currency = 'USD') =>
  stmt.sections.find(s => s.currency === currency)?.transactions.filter(t => t.kind === 'receipt') ?? [];

describe('★ A2 真库守卫：第三方代付记到合同客户头上', () => {
  beforeAll(async () => { await cleanup(); });

  afterAll(async () => {
    await cleanup();
    const got = await safeResidualCounts(RESIDUAL_SPEC);
    expect(got.unreadable, noBackendMessage(got.unreadable)).toEqual([]);
    expect(got.values, `★ 有残留：${got.dirty.join('；')} ⇒ 本演练建的行没清干净（touched=${JSON.stringify(ctx.touchedModels())}）`)
      .toEqual({ inv: 0, voc: 0, alloc: 0 });
    await prisma.$disconnect();
  });

  it('① 阳性对照：自付全额 → 结清 0 且无代付标', async () => {
    const inv = await makeReceivableInvoice(REL_A, '5000');
    const voc = await makeReceiptVoucher(REL_A, '5000');
    await allocate(inv.id, voc.id, '5000');

    const stmt = await getCustomerStatement(prisma, { customerRelationId: REL_A });
    const receipts = receiptOf(stmt).filter(t => t.number === voc.voucherNumber);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].credit).toBe(5000);
    expect(receipts[0].isThirdParty).toBe(false);
    expect(stmt.sections.find(s => s.currency === 'USD')!.closingBalance).toBe(0);
  });

  it('② 代付全额 → 合同客户对账单出现该笔收款（带代付标）并结清', async () => {
    const inv = await makeReceivableInvoice(REL_B, '10000');
    const voc = await makeReceiptVoucher(REL_A, '10000');
    await allocate(inv.id, voc.id, '10000');

    const stmt = await getCustomerStatement(prisma, { customerRelationId: REL_B });
    const receipts = receiptOf(stmt).filter(t => t.number === voc.voucherNumber);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].credit).toBe(10000);
    expect(receipts[0].isThirdParty).toBe(true);
    expect(receipts[0].payerName).toContain('Alpha');
    expect(receipts[0].note).toContain('第三方代付');
    expect(stmt.sections.find(s => s.currency === 'USD')!.closingBalance).toBe(0);
  });

  it('③ 同一笔钱不得同时出现在代付方对账单（否则代付方余额变负）', async () => {
    const inv = await makeReceivableInvoice(REL_B, '7000');
    const voc = await makeReceiptVoucher(REL_A, '7000');
    await allocate(inv.id, voc.id, '7000');

    const payerStmt = await getCustomerStatement(prisma, { customerRelationId: REL_A });
    // 代付方自己的票（①）已独立结清；这笔代付不得出现在他的对账单上
    const tpLine = receiptOf(payerStmt).find(t => t.number === voc.voucherNumber);
    expect(tpLine).toBeUndefined();
  });

  it('④ 代付部分核销 → 合同客户只认核销额，余款留在打款人名下', async () => {
    const inv = await makeReceivableInvoice(REL_B, '10000');
    const voc = await makeReceiptVoucher(REL_A, '10000');
    await allocate(inv.id, voc.id, '6000');

    const beta = await getCustomerStatement(prisma, { customerRelationId: REL_B });
    const lineB = receiptOf(beta).find(t => t.number === voc.voucherNumber)!;
    expect(lineB.credit).toBe(6000);
    expect(lineB.isThirdParty).toBe(true);

    const alpha = await getCustomerStatement(prisma, { customerRelationId: REL_A });
    const lineA = receiptOf(alpha).find(t => t.number === voc.voucherNumber)!;
    expect(lineA.credit).toBe(4000);
    expect(lineA.isThirdParty).toBe(false); // 未核销余款 = 预收，挂打款人，不算代付
    expect(lineB.credit + lineA.credit).toBe(10000); // 守恒
  });

  it('⑤ 未核销代付（钱还没落票）→ 合同客户对账单不出现收款', async () => {
    await makeReceivableInvoice(REL_B, '3000');
    const voc = await makeReceiptVoucher(REL_A, '3000');

    const beta = await getCustomerStatement(prisma, { customerRelationId: REL_B });
    expect(receiptOf(beta).find(t => t.number === voc.voucherNumber)).toBeUndefined();

    const alpha = await getCustomerStatement(prisma, { customerRelationId: REL_A });
    const lineA = receiptOf(alpha).find(t => t.number === voc.voucherNumber)!;
    expect(lineA.credit).toBe(3000);
    expect(lineA.isThirdParty).toBe(false);
  });

  /**
   * ⑥ 用**差分**而不是绝对值（我第一版判据写错了）：
   *   前 5 条用例会留下 REL_B 的未结清余额（④ 剩 4000 + ⑤ 未核销 3000），
   *   所以「账龄里不该有 REL_B 的行」是**错的判据**（实测它确实有，且金额正好 7000 ——
   *   反过来说明归属是对的）。改成：开票 +9000 → 代付核销 −9000 → 账龄回到原点。
   */
  it('⑥ 跨口径对撞：代付核销后账龄里合同客户的 open 同步下降（差分）', async () => {
    const totalOf = async (relationId: string) => {
      const aging = await getAgingReport(prisma, { type: 'Receivable' });
      return aging.rows.find(r => r.customerRelationId === relationId)?.buckets.total ?? 0;
    };
    const before = await totalOf(REL_B);

    const inv = await makeReceivableInvoice(REL_B, '9000');
    const afterInvoice = await totalOf(REL_B);
    expect(afterInvoice).toBeCloseTo(before + 9000, 4); // 开票 → open 涨

    const voc = await makeReceiptVoucher(REL_A, '9000');
    await allocate(inv.id, voc.id, '9000');
    const afterPaid = await totalOf(REL_B);
    expect(afterPaid).toBeCloseTo(before, 4); // 代付核销 → open 归位（账龄侧本来就按票归集）

    // 反向坐实：核销一半时只减一半（守卫不是空跑）
    await prisma.invoiceAllocation.deleteMany({ where: { invoiceId: inv.id } });
    await allocate(inv.id, voc.id, '4500');
    expect(await totalOf(REL_B)).toBeCloseTo(before + 4500, 4);
  });
});
