/**
 * commissionPayableDrill.test.ts — ★ D4 真库守卫：佣金应付**闭环**（开票 → 进入 AP 链路）
 *
 * 为什么要有这个测试（零基础障碍清单 D4「缺订单应付闭环」）：
 *   佣金在定价侧算得很细（`PricingCalculation` + `CommissionRule`），但**只算不收** ——
 *   没有任何地方能回答「这张单欠中间人多少佣金、开了没、付了没」。
 *   本演练证明：一个动作就能把它变成**真正的应付**（进入 AP 账龄 / 付款 / 对账链路）。
 *
 * 判据（真库 + 真服务 + 前缀隔离 + 自回滚 + 独立复核零残留）：
 *   ① 已确认定价行 → 佣金总额正确；**草稿行不计入**（草稿不是承诺）
 *   ② 开佣金应付 → 落一张 `Payable` 发票（收款方=中间人、sourceType/sourceId 可追溯）+ 进入 AP
 *   ③ ★ 幂等：再开一次 → 409 ALREADY_INVOICED（**不重复开票**）
 *   ④ 中间人无法解析（规则未填中间人）→ 409 INTERMEDIARY_UNRESOLVED（不猜、不乱开）
 *   ⑤ 无佣金（全草稿/佣金为 0）→ 409 NO_COMMISSION
 *   ⑥ 作废原票后可重开（出口存在，不是死锁）
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Prisma } from '@prisma/client';
import { createDrillContext, noBackendMessage, safeResidualCounts } from '../../__tests__/lib/drillTouchLog';
import { getOrderCommission, createCommissionPayable, COMMISSION_PAYABLE_SOURCE_TYPE } from '../commissionPayableService';
import { openReceivableWhere } from '../../shared/openReceivable';

const MARK = 'TEST_D4CM_';
/**
 * ★ B35 第三刀采纳点 5/12（v2.75）：客户端由**触碰记录壳**给 ⇒ “该数哪几张表”由运行时写过的模型决定。
 *   本文件早就用业务锚点（`sourceType + sourceId`）认领发票（注释里记着那次“漏 54 张”的教训），
 *   壳补的是另一半：**服务层扇出去写的表**（事件总线 / 通知 / 留痕）由不得这份文件想起来查哪张。
 *   id 仍落在 `TEST_D4CM_` 族内 ⇒ v2.63 认领与 v2.67 族对撞**不换口径**；执行者改成 run 唯一（见 B101 的代价账）。
 */
const ctx = createDrillContext({ prefix: MARK });
const prisma = ctx.prisma;
const ACTOR = ctx.actor;
const REL = ctx.id('REL_AGENT');

let seq = 0;
const n = () => `${++seq}_${Date.now().toString(36)}`;

async function ensureActor() {
  if (!await prisma.userAccount.findUnique({ where: { id: ACTOR } })) {
    await prisma.userAccount.create({
      data: { id: ACTOR, displayName: 'D4 Commission Test', email: `${ACTOR}@bambook.test`, passwordHash: '', status: 'active' },
    });
  }
  // Delegated AP uses current pricing authority, not an invoice-write grant.
  const roleId = ctx.id('ROLE_PRICING');
  await prisma.role.upsert({ where: { id: roleId }, update: {},
    create: { id: roleId, name: 'Synthetic D4 pricing-only authority', isSystem: false } });
  await prisma.userRole.upsert({ where: { id: ctx.id('USER_ROLE') }, update: {},
    create: { id: ctx.id('USER_ROLE'), userId: ACTOR, roleId } });
  const permission = await prisma.permission.upsert({ where: { scope: 'pricing:write' }, update: {},
    create: { id: ctx.id('PERMISSION_PRICING_WRITE'), scope: 'pricing:write' } });
  await prisma.rolePermission.upsert({ where: { roleId_permissionId: { roleId, permissionId: permission.id } }, update: {},
    create: { id: ctx.id('ROLE_PERMISSION'), roleId, permissionId: permission.id } });
}

/**
 * ★★ 演练数据的「认领判据」必须是**业务锚点**，不能是 id。
 *
 * 实测踩过（浏览器走查发现的真问题）：本演练原来按 `invoice.id startsWith MARK` 清理 + 断言零残留，
 * 但**佣金应付发票是 `createInvoice` 服务生成的**（`INV__...`），演练前缀只在 `sourceType/sourceId` 上
 * ⇒ 清理删不掉、断言**永远看到 0** ⇒ **空过**（假绿），**往本地库漏了 54 张发票**。
 * 现在统一：清理与断言**用同一组判据**（业务锚点），并在清理前**先证明判据会咬**。
 */
const RUN = { startsWith: ctx.mark };
const ANCHOR = {
  // ★ 发票认领仍按**来源锚点**（服务生成的 id 不可用），但收窄到本次 run ⇒ 别轮的历史行不动
  invoice: { sourceType: 'CommissionPayable', sourceId: RUN },
  pricing: { id: RUN },
  rule: { id: RUN },
  order: { id: RUN },
  audit: { actorId: ACTOR },
};

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: ANCHOR.audit });
  await prisma.invoice.deleteMany({ where: ANCHOR.invoice });
  await prisma.pricingCalculation.deleteMany({ where: ANCHOR.pricing });
  await prisma.commissionRule.deleteMany({ where: ANCHOR.rule });
  await prisma.order.deleteMany({ where: ANCHOR.order });
  // ★ 本批补：账号面原来**只建不删**（它就是 §12.1 第 22 条那批 `TEST_ACTOR_*` 行的一种来源）
  await prisma.userAccount.deleteMany({ where: { id: ACTOR } });
  await prisma.rolePermission.deleteMany({ where: { roleId: { startsWith: ctx.mark } } });
  await prisma.userRole.deleteMany({ where: { roleId: { startsWith: ctx.mark } } });
  await prisma.role.deleteMany({ where: { id: { startsWith: ctx.mark } } });
  // A Permission reused from another suite/company is never owned by this run.
  await prisma.permission.deleteMany({ where: { id: { startsWith: ctx.mark } } });
  /**
   * ★ B103 第②步：`allocationService` 在 `tx` 里写 `EntityLink` / `EntityReference`（`:206/:216/:236`），
   *   实测本族在这两张表里各留了 **1212 行**（占各自全表 32%），而两表 `id startsWith 族前缀` 都是 0
   *   ⇒ 只能按“任一引用列带本次 run 标记”定向。这里**仍只删本次 run**（`ctx.mark` 含 runId），历史行不动。
   */
  const has = { contains: ctx.mark };
  const from = { startsWith: ctx.mark };
  await prisma.entityLink.deleteMany({ where: { OR: [{ id: has }, { fromId: from }, { toId: from }] } });
  await prisma.entityReference.deleteMany({ where: { OR: [{ id: has }, { ownerId: from }, { targetId: from }] } });
}

/** ★ B151/v3.28：残留普查交给基座 `safeResidualCounts` ⇒ "没有读数"不再冒充"清干净"。
 *   ⚠️ v3.29 复核 E 项更正本注释（原来写"库不可达时报第三态 NO_BACKEND"是**说满了**）：
 *   真断库时先炸的是上一行 `cleanup()`——整条清理链仍在第三态之外（§12.1 第 27 条，不自采），
 *   所以本文件在断库时通常红在它身上；第三态本身由判据 ⑤⑨ 用真客户端证（那里没有 cleanup 挡前面）。
 *   键与 where 逐字搬自旧 `residual()`，一条未改。 */
const RESIDUAL_SPEC = [
  { key: 'inv', model: 'invoice', run: () => prisma.invoice.count({ where: ANCHOR.invoice }) },
  { key: 'prc', model: 'pricingCalculation', run: () => prisma.pricingCalculation.count({ where: ANCHOR.pricing }) },
  { key: 'cr', model: 'commissionRule', run: () => prisma.commissionRule.count({ where: ANCHOR.rule }) },
  { key: 'ord', model: 'order', run: () => prisma.order.count({ where: ANCHOR.order }) },
  { key: 'audit', model: 'auditLog', run: () => prisma.auditLog.count({ where: ANCHOR.audit }) },
  { key: 'ua', model: 'userAccount', run: () => prisma.userAccount.count({ where: { id: ACTOR } }) },
  { key: 'link', model: 'entityLink', run: () => prisma.entityLink.count({ where: { OR: [{ id: { contains: ctx.mark } }, { fromId: { startsWith: ctx.mark } }, { toId: { startsWith: ctx.mark } }] } }) },
  { key: 'ref', model: 'entityReference', run: () => prisma.entityReference.count({ where: { OR: [{ id: { contains: ctx.mark } }, { ownerId: { startsWith: ctx.mark } }, { targetId: { startsWith: ctx.mark } }] } }) },
];

/** ★ 断言会咬自检：清理**前**必须能数到本次演练的行（否则判据是空集 ⇒ 零残留断言等于没写） */
async function assertAnchorBites() {
  const n = await prisma.invoice.count({ where: ANCHOR.invoice });
  if (n === 0) {
    throw new Error('演练认领判据**没咬到任何行** ⇒ 清理与零残留断言都会空过（判据写错了）');
  }
}

async function makeOrder() {
  return prisma.order.create({
    data: {
      id: ctx.id(`ORD_${n()}`), poNumber: ctx.id(`PO_${n()}`), customer: 'D4 客户',
      product: '面料', type: 'Fabric', quantity: 1000, status: 'Confirmed',
      dueDate: '2026-12-31', quoteAmount: 100000, updatedAt: BigInt(Date.now()), ownerId: ACTOR,
    },
  });
}

async function makeRule(intermediaryRelationId: string | null, rate = 5) {
  return prisma.commissionRule.create({
    data: {
      id: ctx.id(`CR_${n()}`), name: ctx.id(`规则-${n()}`), rate: new Prisma.Decimal(rate),
      intermediaryRelationId, intermediaryName: intermediaryRelationId ? 'D4 中间人' : null,
      isActive: true, createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    } as any,
  });
}

async function makePricing(orderId: string, ruleId: string, unitCommission: number, quantity: number, status = 'Confirmed') {
  return prisma.pricingCalculation.create({
    data: {
      id: ctx.id(`PRC_${n()}`), orderId, commissionRuleId: ruleId,
      purchaseCostCny: new Prisma.Decimal(10), refundRate: new Prisma.Decimal(13),
      exchangeRate: new Prisma.Decimal(7.2), profitMargin: new Prisma.Decimal(10),
      commissionRate: new Prisma.Decimal(5),
      netUsdCost: new Prisma.Decimal(1.2), profitAmount: new Prisma.Decimal(0.12),
      commissionAmount: new Prisma.Decimal(unitCommission), finalUnitPrice: new Prisma.Decimal(1.5),
      quantity: new Prisma.Decimal(quantity), status,
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    } as any,
  });
}

describe('★ D4 真库守卫：佣金应付闭环', () => {
  beforeEach(async () => { await cleanup(); await ensureActor(); });

  afterAll(async () => {
    const failures: unknown[] = [];
    try {
    // ★ 先证明判据会咬（清理前能数到我们的行）⇒ 之后的「零残留」才不是空过
    await assertAnchorBites();
    /**
     * ★ B103 的反真空：`EntityLink` / `EntityReference` 的“清干净”必须先证明**本次 run 写过**。
     *   否则断言 0 只是“服务今天没走到那条分支”的假绿（同族教训见 §9.1 的 B94 与壳单测的自证段）。
     */
    const own = { startsWith: ctx.mark };
    const written = await prisma.entityLink.count({ where: { OR: [{ id: { contains: ctx.mark } }, { fromId: own }, { toId: own }] } });
    if (written === 0) {
      console.warn('[B103] 本次 run 没有写过 EntityLink ⇒ 收尾那两个 0 只是“没写”，不是“清干净”');
    }
    } catch (error) { failures.push(error); }
    finally {
      // Anchor failure must not strand native financial/auth rows. Each failure
      // remains visible; a later cleanup failure cannot replace the anchor.
      try { await cleanup(); } catch (error) { failures.push(error); }
      try {
    const got = await safeResidualCounts(RESIDUAL_SPEC);
    expect(got.unreadable, noBackendMessage(got.unreadable)).toEqual([]);
    expect(got.values, `★ 有残留：${got.dirty.join('；')} ⇒ 本演练建的行没清干净（touched=${JSON.stringify(ctx.touchedModels())}）`)
      .toEqual({ inv: 0, prc: 0, cr: 0, ord: 0, audit: 0, ua: 0, link: 0, ref: 0 }); // 零残留（同一判据）
    /**
     * ★ 壳那一半（缺了它，上面那句只是"我想起查的五张表都干净"）：
     *   ① 触碰集合非空（尺没瞎）；② 里面有服务生成的 `Invoice`；
     *   ③ 按**列无关**口径，触碰过的表不许留本次 run 的行；④ 不许有"数不到"的表。
     */
    const touched = ctx.touchedModels();
    expect(touched, '发票由服务层写 ⇒ Invoice 必须在触碰集合里（这也是历史漏 54 张的那张）').toContain('Invoice');
    expect(await prisma.role.count({ where: { id: { startsWith: ctx.mark } } })).toBe(0);
    expect(await prisma.userRole.count({ where: { roleId: { startsWith: ctx.mark } } })).toBe(0);
    expect(await prisma.rolePermission.count({ where: { roleId: { startsWith: ctx.mark } } })).toBe(0);
    expect(await prisma.permission.count({ where: { id: { startsWith: ctx.mark } } })).toBe(0);
      } catch (error) { failures.push(error); }
      try { await prisma.$disconnect(); } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw Object.assign(new Error(failures.map(error => error instanceof Error ? error.message : String(error)).join('\n')), { errors: failures });
    }
  });

  it('① 已确认定价 → 佣金总额正确；草稿行不计入', async () => {
    const o = await makeOrder();
    const rule = await makeRule(REL);
    await makePricing(o.id, rule.id, 1.5, 100, 'Confirmed');
    await makePricing(o.id, rule.id, 9.9, 100, 'Draft'); // 不应计入

    const r = await getOrderCommission(prisma, o.id);
    expect(r.ok).toBe(true);
    expect(r.data!.totalCommission).toBe(150);
    expect(r.data!.currency).toBe('USD');
    expect(r.data!.intermediaryRelationId).toBe(REL);
    expect(r.data!.skippedRowCount).toBe(1);
    expect(r.data!.uninvoicedAmount).toBe(150);
  });

  it('② 开佣金应付 → 落 Payable 发票（收款方=中间人 + 来源可追溯）', async () => {
    const o = await makeOrder();
    const rule = await makeRule(REL);
    await makePricing(o.id, rule.id, 2, 100);

    const r = await createCommissionPayable(prisma, { orderId: o.id }, ACTOR);
    if (!r.ok) throw new Error(`开应付失败：${r.error.code} ${r.error.message}`);
    const inv = r.data!.invoice;
    expect(inv.type).toBe('Payable');
    expect(inv.status).toBe('Issued');
    expect(Number(inv.amount)).toBe(200);
    expect(inv.currency).toBe('USD');
    expect(inv.customerRelationId).toBe(REL);
    expect(inv.sourceType).toBe(COMMISSION_PAYABLE_SOURCE_TYPE);
    // ★ 锚点带序号（`<orderId>#<n>`）—— 因为 Invoice 有 @@unique([sourceType, sourceId])，
    //   直接写 orderId 会让「作废后重开」撞唯一键（死锁，见 ⑥ 与 service 头注释）
    expect(inv.sourceId).toBe(`${o.id}#1`);

    // 进入 AP 链路：按 orderId + 收款方 能查到（供应商对账/账龄读的就是它）
    const inAp = await prisma.invoice.findMany({
      where: { type: 'Payable', orderId: o.id, customerRelationId: REL, deletedAt: null },
      select: { id: true },
    });
    expect(inAp.map(i => i.id)).toContain(inv.id);
    // 佣金应付**不是**应收（不得混进 AR 账龄）
    const inAr = await prisma.invoice.findMany({ where: { ...openReceivableWhere({ orderId: o.id }) }, select: { id: true } });
    expect(inAr.map(i => i.id)).not.toContain(inv.id);

    // 视图回读：已开票 = 总额、未开票 = 0
    const view = await getOrderCommission(prisma, o.id);
    expect(view.data!.invoicedAmount).toBe(200);
    expect(view.data!.uninvoicedAmount).toBe(0);
  });

  it('③ ★ 幂等：再开一次 → 409 ALREADY_INVOICED（不重复开票）', async () => {
    const o = await makeOrder();
    const rule = await makeRule(REL);
    await makePricing(o.id, rule.id, 1, 100);

    expect((await createCommissionPayable(prisma, { orderId: o.id }, ACTOR)).ok).toBe(true);
    const again = await createCommissionPayable(prisma, { orderId: o.id }, ACTOR);
    expect(again.ok).toBe(false);
    expect(again.error!.code).toBe('ALREADY_INVOICED');
    expect(again.error!.status).toBe(409);
    // 仍然只有一张
    expect(await prisma.invoice.count({ where: { sourceType: COMMISSION_PAYABLE_SOURCE_TYPE, sourceId: { startsWith: o.id }, deletedAt: null } })).toBe(1);
  });

  it('④ 中间人无法解析 → 409 INTERMEDIARY_UNRESOLVED（不猜、不乱开）', async () => {
    const o = await makeOrder();
    const rule = await makeRule(null); // 规则未填中间人
    await makePricing(o.id, rule.id, 1, 100);

    const r = await createCommissionPayable(prisma, { orderId: o.id }, ACTOR);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('INTERMEDIARY_UNRESOLVED');
    expect(await prisma.invoice.count({ where: { sourceId: o.id, deletedAt: null } })).toBe(0);
  });

  it('⑤ 无佣金（全草稿 / 佣金为 0）→ 409 NO_COMMISSION', async () => {
    const o = await makeOrder();
    const rule = await makeRule(REL);
    await makePricing(o.id, rule.id, 1, 100, 'Draft');

    const r = await createCommissionPayable(prisma, { orderId: o.id }, ACTOR);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('NO_COMMISSION');
  });

  /**
   * ⑥ ★ 这条用例**抓出了一个真死锁**：`Invoice` 有 `@@unique([sourceType, sourceId])`，
   *   若锚点直接用 orderId，则「开错票 → 作废 → 重开」会撞唯一键 ⇒ **再也开不出来**
   *   （而"金额算错了要重开"是真实需求）。已把锚点改为 `<orderId>#<序号>` ⇒ 出口存在。
   */
  it('⑥ 作废原票后可重开（锚点带序号，出口存在不是死锁）', async () => {
    const o = await makeOrder();
    const rule = await makeRule(REL);
    await makePricing(o.id, rule.id, 1, 100);

    const first = await createCommissionPayable(prisma, { orderId: o.id }, ACTOR);
    if (!first.ok) throw new Error(`首次开票失败：${first.error.code}`);
    await prisma.invoice.update({ where: { id: first.data!.invoice.id }, data: { status: 'Cancelled' } });

    const second = await createCommissionPayable(prisma, { orderId: o.id }, ACTOR);
    if (!second.ok) throw new Error(`作废后重开失败：${second.error.code} ${second.error.message}`);
    expect(second.data!.invoice.id).not.toBe(first.data!.invoice.id);
    expect(first.data!.invoice.sourceId).toBe(`${o.id}#1`);
    expect(second.data!.invoice.sourceId).toBe(`${o.id}#2`); // 序号递增 ⇒ 不撞唯一键
  });
});
