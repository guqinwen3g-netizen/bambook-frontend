/**
 * writeOffTailDrill.test.ts — ★ C7 真库守卫：尾差销账真的能把发票销平
 *
 * 为什么要有这个测试（零基础障碍清单 C7）：
 *   A3 修好了 CN 抵扣的**内核**，但 CN 的唯一创建入口是索赔处置（5 步、语义错位）⇒
 *   一笔 $3.25 的尾差实务上没人处理 ⇒ 发票永远 PartiallyPaid、账龄天天报警。
 *   本演练证明「一个动作」真的把发票推到 Paid 并从「未结清应收」退出。
 *
 * 判据（真库 + 前缀隔离 + 自回滚 + 独立复核零残留）：
 *   ① 尾差 3.25 / 票面 10000 → 成功：CN 生成 + CreditNoteAllocation 落行 + 发票 Paid + 退出未结清
 *   ② 事由太短 → 400，且**无任何落库**（拦在写之前）
 *   ③ 销账金额 > 未结额 → OVER_APPLIED，且**无 CN 残留**（事务原子）
 *   ④ 超过尾差上限 → TAIL_LIMIT_EXCEEDED，且**无 CN 残留**
 *   ⑤ 已销平的发票再销 → NO_OPEN_AMOUNT（幂等提示，不产生第二条 CN）
 *   ⑥ 部分销账（不传 amount，只销一半）→ 发票仍 PartiallyPaid、CN 余额 > 0
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Prisma } from '@prisma/client';
import { createDrillContext, noBackendMessage, safeResidualCounts } from '../../__tests__/lib/drillTouchLog';
import { writeOffInvoiceTail } from '../writeOffService';
import { openReceivableWhere } from '../../shared/openReceivable';

const MARK = 'TEST_C7WO_';
/**
 * ★ B35 第三刀采纳点 3/12。**本演练正是 §9 B35 里那句"写了凭证却从不数它"的原件**：
 *   它 `:74` 建 `paymentVoucher`，而下面原来那份 `cleanup()`/`residual()` **两张都没登记**
 *   ⇒ 历轮各漏一批 ⇒ §9.1 现量 `paymentVoucher` 带标记 **498 行**且**每跑一次门禁就涨**。
 *   壳把"该数哪几张表"交给运行时触碰记录 ⇒ 这次起 `PaymentVoucher` 必然被数到（本批同步补它自己的清理）。
 */
const ctx = createDrillContext({ prefix: MARK });
const prisma = ctx.prisma;
const ACTOR = ctx.actor;

let seq = 0;
const n = () => `${++seq}_${Date.now().toString(36)}`;

async function ensureActor() {
  if (await prisma.userAccount.findUnique({ where: { id: ACTOR } })) return;
  await prisma.userAccount.create({
    data: { id: ACTOR, displayName: 'C7 WriteOff Test', email: `${ACTOR}@bambook.test`, passwordHash: '' },
  });
}

async function cleanup() {
  const ownedNotes = await prisma.creditNote.findMany({ where: { OR: [
    { id: { startsWith: ctx.mark } }, { sourceInvoiceId: { contains: ctx.mark } },
    { appliedToInvoiceId: { contains: ctx.mark } }, { notes: { contains: ctx.mark } },
    { reason: { startsWith: ctx.mark } },
  ] }, select: { id: true } });
  const ownedIds = ownedNotes.map(row => row.id);
  for (const row of await prisma.creditNoteSettlementEvent.findMany({ where: { creditNoteId: { in: ownedIds } }, select: { id: true } })) await prisma.creditNoteSettlementEvent.delete({ where: { id: row.id } });
  await prisma.auditLog.deleteMany({ where: { actorId: ACTOR } });
  const cnIds = ownedIds;
  if (cnIds.length) await prisma.creditNoteAllocation.deleteMany({ where: { creditNoteId: { in: cnIds } } });
  await prisma.creditNote.deleteMany({ where: { id: { startsWith: MARK } } });
  await prisma.creditNoteAllocation.deleteMany({ where: { invoiceId: { startsWith: MARK } } });
  await prisma.invoiceAllocation.deleteMany({ where: { invoiceId: { startsWith: MARK } } });
  await prisma.invoice.deleteMany({ where: { id: { startsWith: MARK } } });
  // ★ 本批补：只删**本次 run** 建的收款凭证（`ctx.mark` 含 runId ⇒ 历史 498 行**一行不动**，删它们要 §12.1 点头）
  await prisma.paymentVoucher.deleteMany({ where: { id: { startsWith: ctx.mark } } });
  // ★★ 壳当场量出来的第二处（本次取证）：`CreditNote` 的 id 由服务生成 ⇒ 原来那两条 `id startsWith MARK` **永远删不到它**，
  //   而它的 sourceInvoiceId/appliedToInvoiceId/customerRelationId/notes 里带着演练标记 ⇒ 库里现量 **503 行**带 `TEST_C7WO_`（B99 同族）。
  //   这里同样**只删本次 run**（含 ctx.mark）；那 503 行历史数据等 §12.1 点头，本批一行不动。
  await prisma.creditNote.deleteMany({
    where: { OR: [
      { sourceInvoiceId: { contains: ctx.mark } },
      { appliedToInvoiceId: { contains: ctx.mark } },
      { notes: { contains: ctx.mark } },
    ] },
  });
  await prisma.userAccount.deleteMany({ where: { id: ACTOR } });
}

/** ★ B151/v3.28：残留普查交给基座 `safeResidualCounts` ⇒ "没有读数"不再冒充"清干净"。
 *   ⚠️ v3.29 复核 E 项更正本注释（原来写"库不可达时报第三态 NO_BACKEND"是**说满了**）：
 *   真断库时先炸的是上一行 `cleanup()`——整条清理链仍在第三态之外（§12.1 第 27 条，不自采），
 *   所以本文件在断库时通常红在它身上；第三态本身由判据 ⑤⑨ 用真客户端证（那里没有 cleanup 挡前面）。
 *   键与 where 逐字搬自旧 `residual()`，一条未改。 */
const RESIDUAL_SPEC = [
  { key: 'inv', model: 'invoice', run: () => prisma.invoice.count({ where: { id: { startsWith: MARK } } }) },
  { key: 'cn', model: 'creditNote', run: () => prisma.creditNote.count({ where: { id: { startsWith: MARK } } }) },
  { key: 'cnAlloc', model: 'creditNoteAllocation', run: () => prisma.creditNoteAllocation.count({ where: { id: { startsWith: MARK } } }) },
  { key: 'audit', model: 'auditLog', run: () => prisma.auditLog.count({ where: { actorId: ACTOR } }) },
  { key: 'vch', model: 'paymentVoucher', run: () => prisma.paymentVoucher.count({ where: { id: { startsWith: ctx.mark } } }) },
  { key: 'cnOwn', model: 'creditNote', run: () => prisma.creditNote.count({ where: { OR: [{ sourceInvoiceId: { contains: ctx.mark } }, { notes: { contains: ctx.mark } }] } }) },
  { key: 'ua', model: 'userAccount', run: () => prisma.userAccount.count({ where: { id: ACTOR } }) },
];

async function makeInvoice(amount: string, currency = 'USD') {
  return prisma.invoice.create({
    data: {
      id: ctx.id(`INV_${n()}`), invoiceNumber: ctx.id(`INV-${n()}`),
      type: 'Receivable', status: 'Issued', amount: new Prisma.Decimal(amount),
      currency, issueDate: '2026-09-18', dueDate: '2026-10-18',
      customerRelationId: ctx.id(`REL`), customerName: 'C7 测试客户',
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    },
  });
}


/** 造一笔收款并核销（模拟「客户已付，只差尾差」的真实场景） */
async function payAndAllocate(invoiceId: string, payAmount: string, currency = 'USD') {
  const voucher = await prisma.paymentVoucher.create({
    data: {
      id: ctx.id(`PAY_${n()}`), voucherNumber: ctx.id(`PAY-${n()}`),
      type: 'Receipt', amount: new Prisma.Decimal(payAmount), currency,
      paymentDate: '2026-09-18', paymentMethod: 'TT', status: 'reconciled',
      customerRelationId: ctx.id(`REL`), customerName: 'C7 测试客户',
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    },
  });
  await prisma.invoiceAllocation.create({
    data: {
      id: ctx.id(`ALLOC_${n()}`), invoiceId, voucherId: voucher.id,
      appliedAmount: new Prisma.Decimal(payAmount), appliedDate: '2026-09-18',
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    },
  });
  await prisma.invoice.update({ where: { id: invoiceId }, data: { status: 'PartiallyPaid' } });
}

const cnCountOf = (invoiceId: string) =>
  prisma.creditNoteAllocation.count({ where: { invoiceId } });

const invoiceOf = (id: string) =>
  prisma.invoice.findUnique({ where: { id }, select: { status: true, amount: true } });

describe('★ C7 真库守卫：尾差销账', () => {
  beforeEach(async () => { await cleanup(); await ensureActor(); });

  afterAll(async () => {
    await cleanup();
    const got = await safeResidualCounts(RESIDUAL_SPEC);
    expect(got.unreadable, noBackendMessage(got.unreadable)).toEqual([]);
    expect(got.values, `★ 有残留：${got.dirty.join('；')} ⇒ 本演练建的行没清干净（touched=${JSON.stringify(ctx.touchedModels())}）`)
      .toEqual({ inv: 0, cn: 0, cnAlloc: 0, audit: 0, vch: 0, cnOwn: 0, ua: 0 }); // 零残留（同一判据）
    /**
     * ★ 第三刀的保险：**该数哪几张表由运行时触碰记录决定**，不由这份文件决定。
     *   `PaymentVoucher` 就是本文件历史上"写了但从不数"的那张 ⇒ §9.1 那 498 行凭证的来源。
     */
    const touched = ctx.touchedModels();
    expect(touched, '本演练建过收款凭证 ⇒ PaymentVoucher 必须在触碰集合里（它正是历史漏数的那张）').toContain('PaymentVoucher');
    await prisma.$disconnect();
  });

  it('① 真实尾差：10000 的票客户付了 9996.75 → 销 3.25 → 发票 Paid + 退出未结清', async () => {
    const inv = await makeInvoice('10000');
    await payAndAllocate(inv.id, '9996.75');
    const r = await writeOffInvoiceTail(prisma, { invoiceId: inv.id, reason: '客户汇款手续费差额，尾差抹零' }, ACTOR);
    if (!r.ok) throw new Error(`销账失败：${r.error!.code} ${r.error!.message}`);
    expect(r.ok).toBe(true);
    expect(r.data!.appliedAmount).toBe(3.25); // 不传 amount = 销平**剩余未结额**（3.25，不是票面 10000）
    expect(r.data!.creditNote.creditNoteNumber).toMatch(/^CLM-/);
    expect(r.data!.creditNote.claimCaseId).toBeNull(); // 纯折让，不是客诉
    expect(r.data!.creditNote.reason).toContain('尾差销账');
    expect(r.data!.invoiceStatusAfter).toBe('Paid');
    expect(await cnCountOf(inv.id)).toBe(1);

    // 退出「未结清应收」判据（账龄/催办/授信随之下线）
    const stillOpen = await prisma.invoice.findMany({ where: { ...openReceivableWhere({ id: inv.id }) }, select: { id: true } });
    expect(stillOpen).toHaveLength(0);
  });

  it('② 事由太短 → 400，且无任何落库（拦在写之前）', async () => {
    const inv = await makeInvoice('10000');
    const r = await writeOffInvoiceTail(prisma, { invoiceId: inv.id, reason: '尾差' }, ACTOR);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('VALIDATION_FAILED');
    expect(await cnCountOf(inv.id)).toBe(0);
    expect((await invoiceOf(inv.id))!.status).toBe('Issued');
  });

  it('③ 销账金额 > 未结额 → OVER_APPLIED，且无 CN 残留（销账只能抹平不能多销）', async () => {
    // ⓘ 构造要点：先收款到只剩 4（未结额 4 < 上限），再传 amount=4.5 —— 这样**只**撞 OVER_APPLIED，
    //   不会被上限判定抢先（我第一版用 100 的票传 150，结果先撞上限，判据无法区分两条守卫）
    const inv = await makeInvoice('100');
    await payAndAllocate(inv.id, '96');
    const r = await writeOffInvoiceTail(prisma, { invoiceId: inv.id, amount: 4.5, reason: '故意传超额，验证销账只能抹平不能多销' }, ACTOR);
    if (r.ok) throw new Error('应当被拒却成功了');
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('OVER_APPLIED');
    expect(r.error!.message).toContain('未结额');
    expect(await cnCountOf(inv.id)).toBe(0);
  });

  it('④ 超过尾差上限 → TAIL_LIMIT_EXCEEDED，且无 CN 残留', async () => {
    const inv = await makeInvoice('10000'); // 5% = 500 USD ⇒ 等值上限更严（≈70 USD）
    const r = await writeOffInvoiceTail(prisma, { invoiceId: inv.id, amount: 3000, reason: '大额折让，应走索赔流程' }, ACTOR);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('TAIL_LIMIT_EXCEEDED');
    expect(r.error!.message).toContain('客户索赔');
    expect(await cnCountOf(inv.id)).toBe(0);
  });

  it('⑤ 已销平的发票再销 → NO_OPEN_AMOUNT（不产生第二条 CN）', async () => {
    const inv = await makeInvoice('100');
    await payAndAllocate(inv.id, '96'); // 只剩 4 的尾差
    const first = await writeOffInvoiceTail(prisma, { invoiceId: inv.id, reason: '第一次销平，正常路径' }, ACTOR);
    if (!first.ok) throw new Error(`第一次销平失败：${first.error!.code} ${first.error!.message}`);
    expect(first.ok).toBe(true);
    const again = await writeOffInvoiceTail(prisma, { invoiceId: inv.id, reason: '第二次销平，应当被拒' }, ACTOR);
    expect(again.ok).toBe(false);
    expect(again.error!.code).toBe('NO_OPEN_AMOUNT');
    expect(await cnCountOf(inv.id)).toBe(1); // 仍然只有一条
  });

  it('⑥ 只销指定金额 → 发票仍 PartiallyPaid；返回的 CN 是**抵扣后**状态（不是刚建快照）', async () => {
    const inv = await makeInvoice('10000');
    const r = await writeOffInvoiceTail(prisma, { invoiceId: inv.id, amount: 3.25, reason: '客户只付到这一档，剩余尾差单独抹平' }, ACTOR);
    if (!r.ok) throw new Error(`销账失败：${r.error!.code} ${r.error!.message}`);
    expect(r.data!.invoiceStatusAfter).toBe('PartiallyPaid'); // 票面只抹掉 3.25
    // CN 自己已把这 3.25 全额抵扣出去 ⇒ 余额 0、状态 Closed
    expect(Number(r.data!.creditNote.openAmount)).toBe(0);
    expect(r.data!.creditNote.status).toBe('Closed');
  });
});
