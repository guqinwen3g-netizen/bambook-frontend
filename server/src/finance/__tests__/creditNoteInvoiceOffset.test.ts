/**
 * creditNoteInvoiceOffset.test.ts — ★ A3 守卫：贷项票抵扣发票必须落发票侧（2026-09-18）
 *
 * 为什么要有这个测试（零基础障碍清单 A3，⚠️ 静默错账级）：
 *   旧 applyCreditNote 出口一（抵扣发票）**只减 CN 自身余额、不落发票侧** ⇒
 *   发票永久 `PartiallyPaid` → 永久逾期 → 账龄/催办/授信全被污染，且无任何自动路径解除。
 *
 * 判据（真库 + 前缀隔离 + 自回滚，含**阳性对照**）：
 *   ① 阳性对照：纯收款核销能把发票推到 Paid（证明状态机本身没坏）
 *   ② CN 部分抵扣 → 发票 PartiallyPaid + CreditNoteAllocation 落行
 *   ③ CN 抵平剩余 → 发票 Paid + settlementDate + 退出「未结清应收」（openReceivableWhere）
 *   ④ 抵扣超发票剩余可抵额（收款已核的部分同样占用）→ 拒绝 OVER_APPLIED 且无副作用
 *   ⑤ 币种不一致 → 拒绝 CURRENCY_MISMATCH
 *   ⑥ 反向：CN 抵扣后收款核销不得超额（applyAllocation 剩余额校验含 CN 占用）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Prisma } from '@prisma/client';
import { createCreditNote, applyCreditNote } from '../../claims/creditNoteService';
import { applyAllocation } from '../allocationService';
import { openReceivableWhere } from '../../shared/openReceivable';
import { createDrillContext, noBackendMessage, safeResidualCounts } from '../../__tests__/lib/drillTouchLog';

const MARK = 'TEST_CNA_';
const ctx = createDrillContext({ prefix: MARK });
const prisma = ctx.prisma;
/**
 * ★ 接壳采纳点 ③：执行者是 run 唯一（`TEST_ACTOR_CNA_<runId>`），所以 `ensureActor()` 的 email
 *   必须跟着 ACTOR 走 —— 写死 email 会在第二轮撞 `UserAccount.email` 唯一约束。
 */
const ACTOR = ctx.actor;

/**
 * ★ B117：派生表（`EntityLink` / `EntityReference`）的"本次 run 范围"判据**只有一份**，
 *   删除与计数共用它 —— 此前这类表是"只删不数"或"只数不删"两份各自漂。
 *   取列按**壳的扫描口径**（`sweepResidue` 对该模型所有 String 列做 `contains`）对齐：
 *   `syncAllocationVoucherLinks` 把 `voucherId`/`invoiceId` 同时拼进 `id`、`ownerId`/`targetId`、
 *   `fromId`/`toId` 与 `snapshot` ⇒ 只认其中一列就会与扫描面不齐，
 *   得到"永远红、又定向删不掉"的死局。`ctx.mark` 含 pid+时间戳 ⇒ `contains` 仍是 run 唯一，圈不到别人的行。
 */
const runScopedDerivedRow = (idCols: string[]) => ({
  OR: idCols.map((c) => ({ [c]: { contains: ctx.mark } })),
});
const linkScopedToThisRun = () => runScopedDerivedRow(['id', 'fromId', 'toId', 'fromPath', 'toPath', 'source']);
const refScopedToThisRun = () => runScopedDerivedRow(['id', 'ownerId', 'targetId', 'targetPath', 'source']);

async function cleanup() {
  const cnIds = (await prisma.creditNote.findMany({ where: { reason: { startsWith: ctx.mark } }, select: { id: true } })).map(r => r.id);
  // Immutable settlement children belong to these exact run-owned credit notes.
  // Remove only those children before their parents in this private test fixture.
  for (const row of await prisma.creditNoteSettlementEvent.findMany({ where: { creditNoteId: { in: cnIds } }, select: { id: true } })) await prisma.creditNoteSettlementEvent.delete({ where: { id: row.id } });
  await prisma.auditLog.deleteMany({ where: { actorId: ACTOR } });
  if (cnIds.length) await prisma.creditNoteAllocation.deleteMany({ where: { creditNoteId: { in: cnIds } } });
  await prisma.creditNote.deleteMany({ where: { id: { in: cnIds } } });
  await prisma.invoiceAllocation.deleteMany({ where: { invoiceId: { startsWith: ctx.mark } } });
  await prisma.invoice.deleteMany({ where: { id: { startsWith: ctx.mark } } });
  await prisma.paymentVoucher.deleteMany({ where: { id: { startsWith: ctx.mark } } });
  /**
   * ★ 接上壳之后**当场量出来**的两条漏表（与 §9 **B112** 同形状，本族此前漏 3+3 行）：
   *   `applyAllocation` → `syncAllocationVoucherLinks` 会 upsert `EntityReference` 与 `EntityLink`，
   *   而本文件此前的 cleanup 两张清单里都没有它们 ⇒ "零残留"这句从来不含这两张表。
   */
  await prisma.entityReference.deleteMany({ where: refScopedToThisRun() });
  await prisma.entityLink.deleteMany({ where: linkScopedToThisRun() });
  /**
   * ★ B119：先删**本次执行者自己的通知**再删账号。`Notification.userId` 是必选关系且无 cascade
   *   ⇒ 00:00 的 briefing 任务给"当时还活着的每个账号"发通知（实测单轮 84 行/账号）之后，
   *   `userAccount.deleteMany` 会被 FK 挡下 ⇒ 演练只在"跨零点的门禁跑"里红，且红在 afterAll
   *   （`Tests` 行 0 失败 ⇒ 只看那条汇总会漏报）。判据按 run 唯一的 `userId: ACTOR`，圈不到别人的收件箱。
   */
  await prisma.notification.deleteMany({ where: { userId: ACTOR } });
  await prisma.userAccount.deleteMany({ where: { id: ACTOR } });
}

/** AuditLog.actorId 有 FK → 测试执行者必须是真实 UserAccount（字段按 allocationService.test.ts：displayName，无 role） */
async function ensureActor() {
  const existing = await prisma.userAccount.findUnique({ where: { id: ACTOR } });
  if (existing) return;
  await prisma.userAccount.create({
    data: {
      id: ACTOR, displayName: 'CNA Guard Test',
      email: `${ACTOR}@bambook.test`, passwordHash: '',
    },
  });
}

let seq = 0;
const nextId = (p: string) => ctx.id(`${p}_${++seq}`);

async function makeReceivableInvoice(amount: string, currency = 'USD') {
  return prisma.invoice.create({
    data: {
      id: nextId('INV'), invoiceNumber: `TEST-CNA-${Date.now()}-${++seq}`,
      type: 'Receivable', status: 'Issued', amount: new Prisma.Decimal(amount),
      currency, issueDate: '2026-09-18', customerName: 'CNA 守卫测试客户',
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    },
  });
}

async function makeReceiptVoucher(amount: string, currency = 'USD') {
  return prisma.paymentVoucher.create({
    data: {
      id: nextId('PAY'), voucherNumber: `TEST-CNA-PAY-${Date.now()}-${++seq}`,
      type: 'Receipt', amount: new Prisma.Decimal(amount), currency,
      paymentDate: '2026-09-18', paymentMethod: 'TT', status: 'unreconciled',
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    },
  });
}

describe('★ A3 守卫：贷项票抵扣发票必须落发票侧', () => {
  beforeAll(ensureActor);

  afterAll(async () => {
    await cleanup();
    /**
     * ★ 本文件此前**一句残留断言都没有**（afterAll 只 cleanup + disconnect）：
     *   "清干净了"这件事完全靠人自觉。现在先按显式清单数一遍，再叠一层列无关口径的壳对撞。
     */
/** ★ v3.30（B151）：普查清单交给基座 ⇒ 库不可达时报第三态 NO_BACKEND，
 *   不再"抛裸 Prisma 栈"与"真有残留"共用一个读数。模型与 where 逐字搬自旧 Promise.all，
 *   顺序与条数不变；旧断言是"恰好 N 个 0"的位置字面量 ⇒ 换具名键等价且红话能点出表名。 */
const RESIDUAL_SPEC = [
  { key: 'invoice', model: 'invoice', run: () => prisma.invoice.count({ where: { id: { startsWith: ctx.mark } } }) },
  { key: 'paymentvoucher', model: 'paymentVoucher', run: () => prisma.paymentVoucher.count({ where: { id: { startsWith: ctx.mark } } }) },
  { key: 'invoiceallocation', model: 'invoiceAllocation', run: () => prisma.invoiceAllocation.count({ where: { invoiceId: { startsWith: ctx.mark } } }) },
  { key: 'creditnote', model: 'creditNote', run: () => prisma.creditNote.count({ where: { reason: { startsWith: ctx.mark } } }) },
  { key: 'auditlog', model: 'auditLog', run: () => prisma.auditLog.count({ where: { actorId: ACTOR } }) },
  { key: 'entityreference', model: 'entityReference', run: () => prisma.entityReference.count({ where: refScopedToThisRun() }) },
  { key: 'entitylink', model: 'entityLink', run: () => prisma.entityLink.count({ where: linkScopedToThisRun() }) },
  { key: 'notification', model: 'notification', run: () => prisma.notification.count({ where: { userId: ACTOR } }) },
  { key: 'useraccount', model: 'userAccount', run: () => prisma.userAccount.count({ where: { id: ACTOR } }) },
];
    const got = await safeResidualCounts(RESIDUAL_SPEC);
    expect(got.unreadable, noBackendMessage(got.unreadable)).toEqual([]);
    expect(got.values, `★ 有残留：${got.dirty.join('；')} ⇒ 本演练建的行没清干净（touched=${JSON.stringify(ctx.touchedModels())}）`)
      .toEqual({ invoice: 0, paymentvoucher: 0, invoiceallocation: 0, creditnote: 0, auditlog: 0, entityreference: 0, entitylink: 0, notification: 0, useraccount: 0 });
    await prisma.$disconnect();
  });

  it('① 阳性对照：纯收款核销能把发票推到 Paid（状态机本身没坏）', async () => {
    const inv = await makeReceivableInvoice('100');
    const pay = await makeReceiptVoucher('100');
    const r = await applyAllocation(prisma, prisma, {
      invoiceId: inv.id, voucherId: pay.id, appliedAmount: '100', actorId: ACTOR, source: 'cna_guard',
    });
    expect(r.newInvoiceStatus).toBe('Paid');
  });

  it('② CN 部分抵扣 → 发票 PartiallyPaid + CreditNoteAllocation 落行', async () => {
    const inv = await makeReceivableInvoice('500');
    const cn = await createCreditNote(prisma, { amount: 200, currency: 'USD', reason: ctx.mark }, ACTOR);
    expect(cn.ok).toBe(true);
    const noteId = cn.data!.creditNote.id;
    const r = await applyCreditNote(prisma, noteId, { appliedAmount: 200, toInvoiceId: inv.id }, ACTOR);
    expect(r.ok).toBe(true);

    const alloc = await prisma.creditNoteAllocation.findUnique({
      where: { creditNoteId_invoiceId: { creditNoteId: noteId, invoiceId: inv.id } },
    });
    expect(alloc).not.toBeNull();
    expect(Number(alloc!.appliedAmount)).toBe(200);

    const after = await prisma.invoice.findUnique({ where: { id: inv.id } });
    expect(after!.status).toBe('PartiallyPaid');
  });

  it('③ CN 抵平剩余 → 发票 Paid + settlementDate + 退出「未结清应收」', async () => {
    const inv = await makeReceivableInvoice('300');
    const pay = await makeReceiptVoucher('200');
    await applyAllocation(prisma, prisma, {
      invoiceId: inv.id, voucherId: pay.id, appliedAmount: '200', actorId: ACTOR, source: 'cna_guard',
    });
    expect((await prisma.invoice.findUnique({ where: { id: inv.id } }))!.status).toBe('PartiallyPaid');

    const cn = await createCreditNote(prisma, { amount: 100, currency: 'USD', reason: ctx.mark }, ACTOR);
    const r = await applyCreditNote(prisma, cn.data!.creditNote.id, { appliedAmount: 100, toInvoiceId: inv.id }, ACTOR);
    expect(r.ok).toBe(true);

    const after = await prisma.invoice.findUnique({ where: { id: inv.id } });
    expect(after!.status).toBe('Paid');
    expect(after!.settlementDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // 退出「未结清应收」判据（真源 openReceivableWhere）
    const stillOpen = await prisma.invoice.findFirst({ where: { ...openReceivableWhere(), id: inv.id } });
    expect(stillOpen).toBeNull();
  });

  it('④ 抵扣超发票剩余可抵额（收款已核部分同样占用）→ 拒绝 OVER_APPLIED 且无副作用', async () => {
    const inv = await makeReceivableInvoice('300');
    const pay = await makeReceiptVoucher('250');
    await applyAllocation(prisma, prisma, {
      invoiceId: inv.id, voucherId: pay.id, appliedAmount: '250', actorId: ACTOR, source: 'cna_guard',
    });
    const cn = await createCreditNote(prisma, { amount: 100, currency: 'USD', reason: ctx.mark }, ACTOR);
    const r = await applyCreditNote(prisma, cn.data!.creditNote.id, { appliedAmount: 100, toInvoiceId: inv.id }, ACTOR);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('OVER_APPLIED');
    // 无副作用：CN 余额未动、明细未落、发票状态未变
    const note = await prisma.creditNote.findUnique({ where: { id: cn.data!.creditNote.id } });
    expect(Number(note!.openAmount)).toBe(100);
    expect(await prisma.creditNoteAllocation.count({ where: { creditNoteId: note!.id } })).toBe(0);
    expect((await prisma.invoice.findUnique({ where: { id: inv.id } }))!.status).toBe('PartiallyPaid');
  });

  it('⑤ 币种不一致 → 拒绝 CURRENCY_MISMATCH', async () => {
    const inv = await makeReceivableInvoice('100', 'EUR');
    const cn = await createCreditNote(prisma, { amount: 50, currency: 'USD', reason: ctx.mark }, ACTOR);
    const r = await applyCreditNote(prisma, cn.data!.creditNote.id, { appliedAmount: 50, toInvoiceId: inv.id }, ACTOR);
    expect(r.error!.code).toBe('CURRENCY_MISMATCH');
  });

  it('⑥ 反向：CN 抵扣占用后，收款核销不得超额（剩余额校验含 CN 占用）', async () => {
    const inv = await makeReceivableInvoice('200');
    const cn = await createCreditNote(prisma, { amount: 200, currency: 'USD', reason: ctx.mark }, ACTOR);
    expect((await applyCreditNote(prisma, cn.data!.creditNote.id, { appliedAmount: 200, toInvoiceId: inv.id }, ACTOR)).ok).toBe(true);
    expect((await prisma.invoice.findUnique({ where: { id: inv.id } }))!.status).toBe('Paid');

    // 发票已全额抵平 → 再来一笔收款核销必须被拒（AMOUNT_EXCEEDS_INVOICE_REMAINING）
    const pay = await makeReceiptVoucher('100');
    await expect(applyAllocation(prisma, prisma, {
      invoiceId: inv.id, voucherId: pay.id, appliedAmount: '100', actorId: ACTOR, source: 'cna_guard',
    })).rejects.toThrow(/remaining/i);
  });
});
