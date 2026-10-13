/**
 * negativeCreditInvoiceSettle.test.ts — ★ CLM 索赔 S2 / S6 守卫：负额票必须能核销、能结清（2026-09-18）
 *
 * 为什么要有这个测试（零基础障碍清单「六·补 CLM 索赔」S2 + S6，同源）：
 *   供应商索赔确认会生成**负向 Payable 发票**（`amount = -|amount|`，见 materialReturnService.confirmReturn），
 *   语义 = 供应商索赔贷项、冲减应付。而结清判据原本内联两处：
 *     ① `recalcInvoiceStatus`：`amount.gt(0) && Σapplied >= amount` → 负额恒假 ⇒ **永不 Paid（S2）**
 *     ② `applyAllocation`：`remaining = amount − Σapplied` 恒为负 ⇒ 任何正数核销都被拒 ⇒ **无结清路径（S6）**
 *   叠加发票状态是**纯派生**（手工改被硬挡）⇒ 负额票永远挂在未结清应付列表，零出口。
 *
 * 判据（真库 + 前缀隔离 + 自回滚，含**阳性对照**）：
 *   ① 阳性对照：正额票核销满 → Paid（证明状态机没被改坏）
 *   ② 负额票未核销 → 仍 Issued（★ 防「一建就结清」⇒ 冲减消失 ⇒ 应付虚增）
 *   ③ 负额票核销满 |amount| → Paid（★ 修复点；修复前抛 AMOUNT_EXCEEDS_INVOICE）
 *   ④ 负额票部分核销 → PartiallyPaid
 *   ⑤ 核销超 |amount| → 拒绝 AMOUNT_EXCEEDS_INVOICE 且无副作用
 *   ⑥ afterAll 清理后**独立复核零残留**（含 EntityReference，本仓踩过悬挂引用）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Prisma } from '@prisma/client';
import { applyAllocation } from '../allocationService';
import { createDrillContext, noBackendMessage, safeResidualCounts } from '../../__tests__/lib/drillTouchLog';

const MARK = 'TEST_NCI_';
/**
 * ★ B35 宽尺第二刀采纳点 ②（v2.96）：执行者由壳生成成 **run 唯一**（`TEST_ACTOR_NCI_<runId>`），
 *   于是 `ensureActor()` 的 email 必须跟着走 —— 写死 email 会在第二轮撞 `UserAccount.email` 唯一约束
 *   （v2.89/v2.91 在 C5SH 上踩过的同一个坑，见 §9）。
 */
const ctx = createDrillContext({ prefix: MARK });
const prisma = ctx.prisma;
const ACTOR = ctx.actor;

/**
 * ★ B117：`EntityLink` 的"本次 run 范围"判据**只有一份**，删除与计数共用它
 *   （此前两侧各写一遍 = 本仓反复犯的"只删不数 / 只数不删"）。
 *   列集合按**壳的扫描口径**取（`sweepResidue` 对该模型全部 String 列做 `contains`）：
 *   只认 `fromId`/`toId` 的 `startsWith` 会与扫描面不齐 ⇒ 标记若落在 `id` 中段或 `source`/`Path` 上，
 *   会得到"永远红、又定向删不掉"的死局。`ctx.mark` 含 pid+时间戳 ⇒ `contains` 仍是 run 唯一，不会圈到别人的行。
 *   ⚠️ 已知不齐处：`metadata` 是 Json 列，本判据不覆盖（今日实测该服务写的边 `metadata` 全为 null）。
 */
const linkScopedToThisRun = () => ({
  OR: ['id', 'fromId', 'toId', 'fromPath', 'toPath', 'source']
    .map((c) => ({ [c]: { contains: ctx.mark } })),
});

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { actorId: ACTOR } });
  await prisma.invoiceAllocation.deleteMany({ where: { invoiceId: { startsWith: ctx.mark } } });
  await prisma.invoice.deleteMany({ where: { id: { startsWith: ctx.mark } } });
  await prisma.paymentVoucher.deleteMany({ where: { id: { startsWith: ctx.mark } } });
  // 悬挂引用必须一起清（sync 会产生 EntityReference，硬删主体后仍留 active 边）
  await prisma.entityReference.deleteMany({ where: { ownerId: { startsWith: ctx.mark } } });
  await prisma.entityReference.deleteMany({ where: { targetId: { startsWith: ctx.mark } } });
  /**
   * ★ B112：接上壳之后**当场量出来**的一条漏表 —— `syncAllocationVoucherLinks` 会写
   *   `EntityLink`（`settlesInvoice`，fromId=凭证 id / toId=发票 id），而本文件此前的 cleanup/residual
   *   两张清单里都没有它 ⇒ 收尾那句"零残留"从来不含这张表（每跑一轮漏 3 行，逐批归因见 §9 **B112**）。
   *   两侧都带本次标记 ⇒ 定向删。
   */
  await prisma.entityLink.deleteMany({ where: linkScopedToThisRun() });
  await prisma.userAccount.deleteMany({ where: { id: ACTOR } });
}

/** AuditLog.actorId 有 FK → 执行者必须是真实 UserAccount */
async function ensureActor() {
  const existing = await prisma.userAccount.findUnique({ where: { id: ACTOR } });
  if (existing) return;
  await prisma.userAccount.create({
    data: {
      id: ACTOR, displayName: 'NCI Guard Test',
      email: `${ACTOR}@bambook.test`, passwordHash: '',
    },
  });
}

let seq = 0;
const nextId = (p: string) => ctx.id(`${p}_${++seq}`);

async function makePayableInvoice(amount: string, currency = 'USD') {
  return prisma.invoice.create({
    data: {
      id: nextId('INV'), invoiceNumber: `TEST-NCI-${Date.now()}-${++seq}`,
      type: 'Payable', status: 'Issued', amount: new Prisma.Decimal(amount),
      currency, issueDate: '2026-09-18', customerName: 'NCI 守卫测试供应商',
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    },
  });
}

async function makeVoucher(type: 'Receipt' | 'Disbursement', amount: string, currency = 'USD') {
  return prisma.paymentVoucher.create({
    data: {
      id: nextId('PAY'), voucherNumber: `TEST-NCI-PAY-${Date.now()}-${++seq}`,
      type, amount: new Prisma.Decimal(amount), currency,
      paymentDate: '2026-09-18', paymentMethod: 'TT', status: 'unreconciled',
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    },
  });
}

describe('★ CLM S2/S6：负额票（供应商索赔贷项）的核销与结清', () => {
  beforeAll(ensureActor);

  afterAll(async () => {
    await cleanup();
    // 独立复核零残留（清理后必须真的为空，否则是「清了个寂寞」）
/** ★ v3.30（B151）：普查清单交给基座 ⇒ 库不可达时报第三态 NO_BACKEND，
 *   不再"抛裸 Prisma 栈"与"真有残留"共用一个读数。模型与 where 逐字搬自旧 Promise.all，
 *   顺序与条数不变；旧断言是"恰好 N 个 0"的位置字面量 ⇒ 换具名键等价且红话能点出表名。 */
const RESIDUAL_SPEC = [
  { key: 'invoice', model: 'invoice', run: () => prisma.invoice.count({ where: { id: { startsWith: ctx.mark } } }) },
  { key: 'paymentvoucher', model: 'paymentVoucher', run: () => prisma.paymentVoucher.count({ where: { id: { startsWith: ctx.mark } } }) },
  { key: 'invoiceallocation', model: 'invoiceAllocation', run: () => prisma.invoiceAllocation.count({ where: { invoiceId: { startsWith: ctx.mark } } }) },
  { key: 'entityreference', model: 'entityReference', run: () => prisma.entityReference.count({ where: { ownerId: { startsWith: ctx.mark } } }) },
  { key: 'entityreference2', model: 'entityReference', run: () => prisma.entityReference.count({ where: { targetId: { startsWith: ctx.mark } } }) },
  { key: 'auditlog', model: 'auditLog', run: () => prisma.auditLog.count({ where: { actorId: ACTOR } }) },
  { key: 'entitylink', model: 'entityLink', run: () => prisma.entityLink.count({ where: linkScopedToThisRun() }) },
  { key: 'useraccount', model: 'userAccount', run: () => prisma.userAccount.count({ where: { id: ACTOR } }) },
];
    const got = await safeResidualCounts(RESIDUAL_SPEC);
    expect(got.unreadable, noBackendMessage(got.unreadable)).toEqual([]);
    expect(got.values, `★ 有残留：${got.dirty.join('；')} ⇒ 本演练建的行没清干净（touched=${JSON.stringify(ctx.touchedModels())}）`)
      .toEqual({ invoice: 0, paymentvoucher: 0, invoiceallocation: 0, entityreference: 0, entityreference2: 0, auditlog: 0, entitylink: 0, useraccount: 0 });
    /**
     * ★ 壳那一半：不断言具体模型名（钉实现字面 = B102 那一族），只钉三件真事 ——
     *   触碰集合非空、列无关口径下不留本次 run 的行、不许有"数不到"的表。
     *   这份文件原本的 6 个手写 count 只覆盖它**想到**的 5 张表；`applyAllocation` 的写全部走**注入进来的
     *   那两个客户端**（`tx` 与 `prisma` 这里都是壳给的同一个代理，sync/audit 也在其中）⇒ 少算一张表就会红。
     */
    await prisma.$disconnect();
  });

  it('① 阳性对照：正额应付票核销满 → Paid（状态机没被改坏）', async () => {
    const inv = await makePayableInvoice('1000');
    const pay = await makeVoucher('Disbursement', '1000');
    const r = await applyAllocation(prisma, prisma, {
      invoiceId: inv.id, voucherId: pay.id, appliedAmount: '1000', actorId: ACTOR, source: 'nci_guard',
    });
    expect(r.newInvoiceStatus).toBe('Paid');
  });

  it('② ★ 负额票未核销 → 仍 Issued（防「一建就结清」导致应付虚增）', async () => {
    const inv = await makePayableInvoice('-500');
    const after = await prisma.invoice.findUnique({ where: { id: inv.id } });
    expect(Number(after!.amount)).toBe(-500);
    expect(after!.status).toBe('Issued');
  });

  it('③ ★★ 负额票核销满 |amount| → Paid（修复前抛 AMOUNT_EXCEEDS_INVOICE）', async () => {
    const inv = await makePayableInvoice('-500');
    const pay = await makeVoucher('Receipt', '500');
    const r = await applyAllocation(prisma, prisma, {
      invoiceId: inv.id, voucherId: pay.id, appliedAmount: '500', actorId: ACTOR, source: 'nci_guard',
    });
    expect(r.newInvoiceStatus).toBe('Paid');
    const after = await prisma.invoice.findUnique({ where: { id: inv.id } });
    expect(after!.status).toBe('Paid');
    expect(after!.settlementDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('④ 负额票部分核销 → PartiallyPaid', async () => {
    const inv = await makePayableInvoice('-500');
    const pay = await makeVoucher('Receipt', '300');
    const r = await applyAllocation(prisma, prisma, {
      invoiceId: inv.id, voucherId: pay.id, appliedAmount: '300', actorId: ACTOR, source: 'nci_guard',
    });
    expect(r.newInvoiceStatus).toBe('PartiallyPaid');
  });

  it('⑤ 核销金额超 |amount| → 拒绝 AMOUNT_EXCEEDS_INVOICE 且无副作用', async () => {
    const inv = await makePayableInvoice('-500');
    const pay = await makeVoucher('Receipt', '600');
    await expect(applyAllocation(prisma, prisma, {
      invoiceId: inv.id, voucherId: pay.id, appliedAmount: '600', actorId: ACTOR, source: 'nci_guard',
    })).rejects.toMatchObject({ code: 'AMOUNT_EXCEEDS_INVOICE' });
    const after = await prisma.invoice.findUnique({ where: { id: inv.id } });
    expect(after!.status).toBe('Issued');
    expect(await prisma.invoiceAllocation.count({ where: { invoiceId: inv.id } })).toBe(0);
  });
});
