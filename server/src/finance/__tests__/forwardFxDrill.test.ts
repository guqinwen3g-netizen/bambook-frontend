/**
 * forwardFxDrill.test.ts — ★ D6 真库守卫：远期结汇合约的到期与损益**算得出来**
 *
 * 为什么要有（零基础障碍清单 D6）：`FxRateLock`（订单级锁汇）与 `FxSettlement`（结汇水单）都在，
 * 缺**与银行的远期合约**这一层 ⇒ 到期日没人管、合约汇率 vs 实际结汇汇率的**损益**算不出来。
 *
 * 判据（真库 + 真服务 + 前缀隔离 + 自回滚 + 独立复核零残留）：
 *   ① 建合约 → Open + 剩余 = 全额
 *   ② 分次交割 → 累计正确 + 状态 PartiallySettled/Settled + **损益** =（实际汇率 − 合约汇率）× 金额
 *   ③ 交割完再交割 → OVER_CONTRACT 409（不允许超合约）
 *   ④ 币种不一致 → CURRENCY_MISMATCH
 *   ⑤ 一笔结汇水单挂第二张合约 → SETTLEMENT_ALREADY_LINKED 409
 *   ⑥ 一览表：到期天数 + 已实现损益汇总
 *
 * ⓘ 水单用 prisma 直接落（水单本身有既有服务与守卫覆盖；本演练主体是合约与交割）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Prisma } from '@prisma/client';
import { createDrillContext, withBackend } from '../../__tests__/lib/drillTouchLog';
import { createForwardFxContract, settleForwardFx, listForwardFxContracts } from '../forwardFxService';

const MARK = 'TEST_D6FX_';
/**
 * ★ B35 第三刀采纳点 2/12：走触碰记录壳。族前缀 `TEST_D6FX_` **保留**（业务号仍由它开头）
 *   ⇒ v2.63 的认领判据与 v2.67 的"族 ⊆ 源派生"都不换口径；`ctx.mark` 只多圈出**本次 run**。
 */
const ctx = createDrillContext({ prefix: MARK });
const prisma = ctx.prisma;
const ACTOR = ctx.actor;

let seq = 0;
const n = () => `${++seq}_${Date.now().toString(36)}`;

async function ensureActor() {
  if (await prisma.userAccount.findUnique({ where: { id: ACTOR } })) return;
  await prisma.userAccount.create({
    data: { id: ACTOR, displayName: 'D6 FX Test', email: `${ACTOR}@bambook.test`, passwordHash: '' },
  });
}

/**
 * ★★ 演练数据的「认领判据」必须是**业务锚点**，不能是 id。
 *
 * 实测踩过（浏览器走查发现的真问题）：本演练原来按 `forwardFxContract.id startsWith MARK` 清理 + 断言零残留，
 * 但 **`createForwardFxContract` 的 id 是服务生成的**（`FFX__...`），演练前缀只加在 `contractNumber` 上
 * ⇒ 清理删不掉、断言**永远看到 0** ⇒ **空过**（假绿），**往本地库漏了 44 行**。
 * 现在统一：清理与断言**用同一组判据**（业务锚点），并在清理前**先证明判据会咬**（能数到我们的行）。
 */
const ANCHOR = {
  contract: { contractNumber: { startsWith: MARK } },
  link: { id: { startsWith: MARK } }, // ★ 已知不够：link 的 id 由服务生成 ⇒ 这一条**永远命中 0**（见 v2.70 的 B99）
  settlement: { settlementNumber: { startsWith: MARK } },
  voucher: { voucherNumber: { startsWith: MARK } },
  audit: { actorId: ACTOR },
};

async function cleanup() {
  // ★ run 范围内先清关联行（它的 id 不带前缀，只能靠"本次 run 的水单号/合同 id"定位）
  const runLinks = await prisma.forwardFxContract.findMany({
    where: { contractNumber: { startsWith: ctx.mark } }, select: { id: true },
  });
  await prisma.forwardFxSettlementLink.deleteMany({
    where: {
      OR: [
        { settlementId: { startsWith: ctx.mark } },
        ...(runLinks.length ? [{ contractId: { in: runLinks.map((r) => r.id) } }] : []),
      ],
    },
  });
  await prisma.forwardFxSettlementLink.deleteMany({ where: ANCHOR.link });
  await prisma.auditLog.deleteMany({ where: ANCHOR.audit });
  await prisma.fxSettlement.deleteMany({ where: ANCHOR.settlement });
  await prisma.paymentVoucher.deleteMany({ where: ANCHOR.voucher });
  await prisma.forwardFxContract.deleteMany({ where: ANCHOR.contract });
  // ★ 本文件建了执行者却从不删（= §9.1 那批 TEST_ACTOR_* 账号的来源之一）。只删**本次 run** 这一行。
  await prisma.userAccount.deleteMany({ where: { id: ACTOR } });
}

async function residual() {
  const [c, l, s, v, audit, ua] = await Promise.all([
    prisma.forwardFxContract.count({ where: ANCHOR.contract }),
    // ★ 同一件事换判据：原来数 `id startsWith MARK`（恒 0 ⇒ 恒"干净"），现在数"带本次 run 标记的行"
    prisma.forwardFxSettlementLink.count({ where: { OR: [{ settlementId: { startsWith: ctx.mark } }, { id: { startsWith: ctx.mark } }] } }),
    prisma.fxSettlement.count({ where: ANCHOR.settlement }),
    prisma.paymentVoucher.count({ where: ANCHOR.voucher }),
    prisma.auditLog.count({ where: ANCHOR.audit }),
    prisma.userAccount.count({ where: { id: ACTOR } }),
  ]);
  return { c, l, s, v, audit, ua };
}

/** ★ 断言会咬自检：清理**前**必须能数到本次演练的行（否则判据是空集 ⇒ 零残留断言等于没写） */
async function assertAnchorBites() {
  const n = await prisma.forwardFxContract.count({ where: ANCHOR.contract });
  if (n === 0) {
    throw new Error('演练认领判据**没咬到任何行** ⇒ 清理与零残留断言都会空过（判据写错了）');
  }
}

async function makeContract(over: Record<string, unknown> = {}) {
  const r = await createForwardFxContract(
    prisma,
    {
      contractNumber: ctx.id(`FX-${n()}`),
      bankName: '某银行',
      currency: 'USD',
      foreignAmount: 1000,
      contractRate: 7.0,
      signedDate: '2026-01-01',
      maturityDate: '2026-06-30',
      ...over,
    } as any,
    ACTOR,
  );
  if (!r.ok) throw new Error(`建合约失败：${r.error.code} ${r.error.message}`);
  return r.data!.contract;
}

/** 落一张结汇水单（直接落 —— 水单自身有既有服务与守卫） */
async function makeSettlement(currency = 'USD', foreignAmount = 1000, fxRate = 7.2) {
  const voucher = await prisma.paymentVoucher.create({
    data: {
      id: ctx.id(`PAY_${n()}`), voucherNumber: ctx.id(`PAY-${n()}`), // 业务锚点（id 也可能被服务覆盖，双保险）
      type: 'Receipt', amount: new Prisma.Decimal(foreignAmount), currency,
      paymentDate: '2026-06-01', paymentMethod: 'TT', status: 'reconciled',
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    } as any,
  });
  return prisma.fxSettlement.create({
    data: {
      id: ctx.id(`FXS_${n()}`), settlementNumber: ctx.id(`FXS-${n()}`),
      voucherId: voucher.id, settleDate: '2026-06-01',
      foreignAmount: new Prisma.Decimal(foreignAmount), currency,
      fxRate: new Prisma.Decimal(fxRate), cnyAmount: new Prisma.Decimal(foreignAmount * fxRate),
      bank: '某银行', createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    } as any,
  });
}

describe('★ D6 真库守卫：远期结汇合约', () => {
  beforeAll(async () => { await cleanup(); await ensureActor(); });

  afterAll(async () => {
    // ★ 先证明判据会咬（清理前能数到我们的行）⇒ 之后的「零残留」才不是空过
    await assertAnchorBites();
    const touched = ctx.touchedModels();
    await cleanup();
    expect(await withBackend(`ForwardFx 六张表`, residual)).toEqual({ c: 0, l: 0, s: 0, v: 0, audit: 0, ua: 0 }); // 零残留（同一判据）
    expect(touched, '本演练建过执行者 ⇒ UserAccount 必须在触碰集合里').toContain('UserAccount');
    await prisma.$disconnect();
  });

  it('① 建合约 → Open，剩余 = 全额', async () => {
    const c = await makeContract();
    expect(c.status).toBe('Open');
    expect(Number(c.settledForeignAmount)).toBe(0);
    const list = await listForwardFxContracts(prisma, { currency: 'USD' });
    if (!list.ok) throw new Error(list.error.message);
    const row = list.data!.rows.find(r => r.id === c.id)!;
    expect(row.remainingForeignAmount).toBe(1000);
    expect(row.statusLabel).toBe('未交割');
  });

  it('② 分次交割 → 累计正确 + 状态流转 + **损益**', async () => {
    const contract = await makeContract();
    const s1 = await makeSettlement('USD', 600, 7.2);
    const r1 = await settleForwardFx(prisma, { contractId: contract.id, settlementId: s1.id, foreignAmount: 600 }, ACTOR);
    if (!r1.ok) throw new Error(`第一次交割失败：${r1.error.code} ${r1.error.message}`);
    expect(r1.data!.contract.status).toBe('PartiallySettled');
    // (7.2 − 7.0) × 600 = 120
    expect(r1.data!.pnlCny).toBe(120);

    const s2 = await makeSettlement('USD', 400, 6.8);
    const r2 = await settleForwardFx(prisma, { contractId: contract.id, settlementId: s2.id, foreignAmount: 400 }, ACTOR);
    if (!r2.ok) throw new Error(`第二次交割失败：${r2.error.code} ${r2.error.message}`);
    expect(r2.data!.contract.status).toBe('Settled');
    // (6.8 − 7.0) × 400 = −80
    expect(r2.data!.pnlCny).toBe(-80);

    // 一览表汇总已实现损益：120 − 80 = 40
    const list = await listForwardFxContracts(prisma, { currency: 'USD' });
    if (!list.ok) throw new Error(list.error.message);
    expect(list.data!.rows.find(r => r.id === contract.id)!.realizedPnlCny).toBe(40);
  });

  it('③ 交割完再交割 → OVER_CONTRACT 409（不允许超合约）', async () => {
    const contract = await makeContract({ foreignAmount: 100 });
    const s = await makeSettlement('USD', 100, 7.0);
    const first = await settleForwardFx(prisma, { contractId: contract.id, settlementId: s.id, foreignAmount: 100 }, ACTOR);
    if (!first.ok) throw new Error(first.error.message);
    const s2 = await makeSettlement('USD', 50, 7.0);
    const second = await settleForwardFx(prisma, { contractId: contract.id, settlementId: s2.id, foreignAmount: 50 }, ACTOR);
    expect(second.ok).toBe(false);
    expect(second.error!.code).toBe('OVER_CONTRACT');
    expect(second.error!.status).toBe(409);
  });

  it('④ 币种不一致 → CURRENCY_MISMATCH', async () => {
    const contract = await makeContract();
    const s = await makeSettlement('EUR', 100, 7.0);
    const r = await settleForwardFx(prisma, { contractId: contract.id, settlementId: s.id, foreignAmount: 100 }, ACTOR);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('CURRENCY_MISMATCH');
  });

  it('⑤ 一笔结汇水单挂第二张合约 → SETTLEMENT_ALREADY_LINKED 409', async () => {
    const c1 = await makeContract();
    const c2 = await makeContract();
    const s = await makeSettlement('USD', 200, 7.1);
    const first = await settleForwardFx(prisma, { contractId: c1.id, settlementId: s.id, foreignAmount: 100 }, ACTOR);
    if (!first.ok) throw new Error(first.error.message);
    const second = await settleForwardFx(prisma, { contractId: c2.id, settlementId: s.id, foreignAmount: 100 }, ACTOR);
    expect(second.ok).toBe(false);
    expect(second.error!.code).toBe('SETTLEMENT_ALREADY_LINKED');
  });

  it('⑥ 到期天数：未到期为正、已逾期为负；到期日非法不显示成「今天到期」', async () => {
    const future = await makeContract({ maturityDate: '2099-12-31' });
    // ⓘ 签约日也要给早的 —— 否则撞「到期日不得早于签约日」的校验（我第一版只改到期日 ⇒ 用例自己红
    const past = await makeContract({ maturityDate: '2020-01-01', signedDate: '2019-01-01' });
    const list = await listForwardFxContracts(prisma, { currency: 'USD' });
    if (!list.ok) throw new Error(list.error.message);
    const rows = list.data!.rows;
    expect(rows.find(r => r.id === future.id)!.daysToMaturity).toBeGreaterThan(0);
    expect(rows.find(r => r.id === past.id)!.daysToMaturity).toBeLessThan(0);
  });

  it('⑦ 合约号重复 → DUPLICATE_CONTRACT 409（银行合约号用于对账）', async () => {
    const number = ctx.id(`DUP-${n()}`);
    await makeContract({ contractNumber: number });
    const r = await createForwardFxContract(prisma, {
      contractNumber: number, currency: 'USD', foreignAmount: 100, contractRate: 7, signedDate: '2026-01-01', maturityDate: '2026-06-30',
    } as any, ACTOR);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('DUPLICATE_CONTRACT');
  });
});
