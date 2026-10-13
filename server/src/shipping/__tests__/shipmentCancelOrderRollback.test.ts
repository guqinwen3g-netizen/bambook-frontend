/**
 * shipmentCancelOrderRollback.test.ts — ★ A5 守卫：运单取消必须回退订单状态
 *
 * 为什么要有这个测试（零基础障碍清单 A5）：
 *   旧 `deriveOrderStatusFromShipment('Cancelled')` 返回 null ⇒ **不联动**，
 *   文档口径是「留人工」。但取消运单时**库存已反向回冲、货已回库**，
 *   订单却仍卡在 `Shipping` ⇒ **状态与实物不符**；而人工侧既没有入口、
 *   也不知道该退回哪一档（Pending/Confirmed/Production？）——实务上等于没人改。
 *
 * 判据（真库 + 前缀隔离 + 自回滚 + 独立复核零残留，含**阳性对照**）：
 *   ① 阳性对照：建 Booked 运单 → 订单 Shipping（正向联动没被改坏）
 *   ② 唯一运单取消 → 订单退回「进入 Shipping 前」的状态（Production，取自 transition 留痕）
 *   ③ 无过渡留痕（脏数据/手工改状态）→ fallback Confirmed（不猜 Pending）
 *   ④ 分批/合票：还有第二票在途 → 取消一票**不**回退（不误退，最关键的一条）
 *   ⑤ 订单终态 Delivered → 不回退
 *   ⑥ 合票中「非主订单」（仅经 ShipmentOrderAllocation 关联）→ 整票取消同样回退
 *   ⑦⑧⑨（B50-1d）回退目标的**依据**要可分辨：history / 无留痕 / 脏留痕 / 查询失败 四种各自一个值，
 *      推断出来的那个还要在 OrderStatusTransition.note 里写明 ⇒ 事后审计不会把推断当真实历史
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createShipment, updateShipment } from '../shipmentMutationService';
import { createDrillContext, noBackendMessage, safeResidualCounts } from '../../__tests__/lib/drillTouchLog';

const MARK = 'TEST_SHPRB_';
const ctx = createDrillContext({ prefix: MARK });
const prisma = ctx.prisma;
/** ★ 执行者 run 唯一 ⇒ email 必须跟着走（写死会在第二轮撞 `UserAccount.email` 唯一约束） */
const ACTOR = ctx.actor;

let seq = 0;
const n = () => `${++seq}_${Date.now().toString(36)}`;

/**
 * ★ B117：这三张表的"本次 run 范围"判据**只有一份**，删除与计数共用它
 *   （分成两份就会漂成"只删不数"或"只数不删"）。
 *   取列按**壳的扫描口径**对齐：`sweepResidue` 对该模型**所有** String 列做 `contains`，
 *   所以删除面必须覆盖同一批列 ⇒ 否则会掉进"永远红、又定向删不掉"的死局。
 *   `ctx.mark` / `ctx.actor` 含 pid+时间戳 ⇒ `contains` 仍是 run 唯一，圈不到别人的行。
 */
const linkScopedToThisRun = () => ({
  OR: ['id', 'fromId', 'toId', 'fromPath', 'toPath', 'source'].map((c) => ({ [c]: { contains: ctx.mark } })),
});
const refScopedToThisRun = () => ({
  OR: ['id', 'ownerId', 'targetId', 'targetPath', 'source'].map((c) => ({ [c]: { contains: ctx.mark } })),
});
/** 事件行的标记可能在 `shipmentId`/`note`/`id`，执行者在 `actorId` ⇒ 两样都认 */
const eventScopedToThisRun = () => ({
  OR: [
    { shipmentId: { contains: ctx.mark } },
    { note: { contains: ctx.mark } },
    { id: { contains: ctx.mark } },
    { actorId: ACTOR },
  ],
});

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { actorId: ACTOR } });
  await prisma.shipmentOrderAllocation.deleteMany({ where: { shipmentId: { startsWith: ctx.mark } } });
  await prisma.shipmentLine.deleteMany({ where: { shipmentId: { startsWith: ctx.mark } } });
  await prisma.shipment.deleteMany({ where: { id: { startsWith: ctx.mark } } });
  await prisma.orderStatusTransition.deleteMany({ where: { orderId: { startsWith: ctx.mark } } });
  await prisma.orderLine.deleteMany({ where: { id: { startsWith: ctx.mark } } });
  await prisma.order.deleteMany({ where: { id: { startsWith: ctx.mark } } });
  /**
   * ★ 接壳当场量出来的漏表：`ensureActor()` 建了一条 `UserAccount`，而本文件的 cleanup 与 residual
   *   **两张清单里都没有它** ⇒ 那句"零残留"从来不含这张表（与 §9 B112 / allocationDuplicateGuard 同形状）。
   *   判据按 run 唯一的 `id: ACTOR` 定向删 ⇒ 圈不到别人的账号。
   */
  /**
   * ★ 接壳当场量出来的另外三张漏表（本文件的 cleanup / residual 两张清单里都没有它们）：
   *   `createShipment` 与 `updateShipment` 会写 `EntityReference` / `EntityLink` / `ShipmentEvent`
   *   ⇒ 那句"零残留"从来不含这三张表（与 §9 **B112** 同形状）。三处都按本次 run 的标记定向删。
   */
  await prisma.entityReference.deleteMany({ where: refScopedToThisRun() });
  await prisma.entityLink.deleteMany({ where: linkScopedToThisRun() });
  await prisma.shipmentEvent.deleteMany({ where: eventScopedToThisRun() });
  /**
   * ★ B119：先删**本次执行者自己的通知**再删账号。`Notification.userId` 是必选关系且无 cascade
   *   ⇒ 00:00 的 briefing 任务给"当时还活着的每个账号"发通知（实测单轮 84 行/账号）之后，
   *   `userAccount.deleteMany` 会被 FK 挡下 ⇒ 演练只在"跨零点的门禁跑"里红，且红在 afterAll
   *   （`Tests` 行 0 失败 ⇒ 只看那条汇总会漏报）。判据按 run 唯一的 `userId: ACTOR`，圈不到别人的收件箱。
   */
  await prisma.notification.deleteMany({ where: { userId: ACTOR } });
  await prisma.userAccount.deleteMany({ where: { id: ACTOR } });
}

async function ensureActor() {
  const existing = await prisma.userAccount.findUnique({ where: { id: ACTOR } });
  if (existing) return;
  await prisma.userAccount.create({
    data: { id: ACTOR, displayName: 'Rollback Test', email: `${ACTOR}@bambook.test`, passwordHash: '' },
  });
}

async function makeOrder(status = 'Production') {
  return prisma.order.create({
    data: {
      id: ctx.id(`ORD_${n()}`), customer: 'TEST_CUST_RB', product: 'P', type: 'Garment',
      quantity: 1000000, lines: { create: { id: ctx.id(`LINE_${n()}`), lineNumber: 1, quantity: 1000000, unit: 'PCS' } }, status, dueDate: '2026-12-31', quoteAmount: 10000,
      updatedAt: BigInt(Date.now()),
    },
  });
}

async function makeShipment(orderId: string | null, status = 'Booked') {
  const r = await createShipment({
    prisma: prisma as any,
    input: {
      id: ctx.id(`SHP_${n()}`),
      type: 'Export', status, shippingMethod: 'Sea',
      orderId: orderId ?? undefined,
    } as any,
    actorId: ACTOR,
    generateIdIfMissing: true,
  });
  if (!r.ok) throw new Error(`预置运单失败：${JSON.stringify(r.error)}`);
  return r.data!.shipment;
}

const cancel = (shipmentId: string) =>
  updateShipment({ prisma: prisma as any, shipmentId, patch: { status: 'Cancelled' }, hasStatus: true, actorId: ACTOR });

const orderStatus = async (orderId: string) =>
  (await prisma.order.findUnique({ where: { id: orderId }, select: { status: true } }))!.status;

/** ★ B151/v3.28：残留普查交给基座 `safeResidualCounts` ⇒ "没有读数"不再冒充"清干净"。
 *   ⚠️ v3.29 复核 E 项更正本注释（原来写"库不可达时报第三态 NO_BACKEND"是**说满了**）：
 *   真断库时先炸的是上一行 `cleanup()`——整条清理链仍在第三态之外（§12.1 第 27 条，不自采），
 *   所以本文件在断库时通常红在它身上；第三态本身由判据 ⑤⑨ 用真客户端证（那里没有 cleanup 挡前面）。
 *   键与 where 逐字搬自旧 `residual()`，一条未改。 */
const RESIDUAL_SPEC = [
  { key: 'shipmentLine', model: 'shipmentLine', run: () => prisma.shipmentLine.count({ where: { shipmentId: { startsWith: ctx.mark } } }) },
  { key: 'line', model: 'orderLine', run: () => prisma.orderLine.count({ where: { id: { startsWith: ctx.mark } } }) },
  { key: 'shp', model: 'shipment', run: () => prisma.shipment.count({ where: { id: { startsWith: ctx.mark } } }) },
  { key: 'ord', model: 'order', run: () => prisma.order.count({ where: { id: { startsWith: ctx.mark } } }) },
  { key: 'tr', model: 'orderStatusTransition', run: () => prisma.orderStatusTransition.count({ where: { orderId: { startsWith: ctx.mark } } }) },
  { key: 'alloc', model: 'shipmentOrderAllocation', run: () => prisma.shipmentOrderAllocation.count({ where: { shipmentId: { startsWith: ctx.mark } } }) },
  { key: 'audit', model: 'auditLog', run: () => prisma.auditLog.count({ where: { actorId: ACTOR } }) },
  { key: 'ref', model: 'entityReference', run: () => prisma.entityReference.count({ where: refScopedToThisRun() }) },
  { key: 'link', model: 'entityLink', run: () => prisma.entityLink.count({ where: linkScopedToThisRun() }) },
  { key: 'evt', model: 'shipmentEvent', run: () => prisma.shipmentEvent.count({ where: eventScopedToThisRun() }) },
  { key: 'notif', model: 'notification', run: () => prisma.notification.count({ where: { userId: ACTOR } }) },
  { key: 'acct', model: 'userAccount', run: () => prisma.userAccount.count({ where: { id: ACTOR } }) },
];

describe('★ A5 守卫：运单取消回退订单状态', () => {
  beforeEach(async () => { await cleanup(); await ensureActor(); });

  afterAll(async () => {
    await cleanup();
    const got = await safeResidualCounts(RESIDUAL_SPEC);
    expect(got.unreadable, noBackendMessage(got.unreadable)).toEqual([]);
    expect(got.values, `★ 有残留：${got.dirty.join('；')} ⇒ 本演练建的行没清干净（touched=${JSON.stringify(ctx.touchedModels())}）`)
      .toEqual({ shipmentLine: 0, line: 0, shp: 0, ord: 0, tr: 0, alloc: 0, audit: 0, ref: 0, link: 0, evt: 0, notif: 0, acct: 0 }); // 零残留
    await prisma.$disconnect();
  });

  it('① 阳性对照：建 Booked 运单 → 订单 Production → Shipping（正向联动没被改坏）', async () => {
    const order = await makeOrder('Production');
    await makeShipment(order.id, 'Booked');
    expect(await orderStatus(order.id)).toBe('Shipping');
  });

  it('② 唯一运单取消 → 订单退回「进入 Shipping 前」的状态（Production，取自留痕）', async () => {
    const order = await makeOrder('Production');
    const sh = await makeShipment(order.id, 'Booked');
    expect(await orderStatus(order.id)).toBe('Shipping');

    const r = await cancel(sh.id);
    expect(r.ok).toBe(true);
    expect(await orderStatus(order.id)).toBe('Production');

    // 留痕：回退本身也要写一条 transition（否则下次再取消又无据可依）
    const tr = await prisma.orderStatusTransition.findMany({
      where: { orderId: order.id, toStatus: 'Production' },
      orderBy: { createdAt: 'desc' },
    });
    expect(tr.length).toBeGreaterThan(0);
    expect(tr[0].note).toContain('cancellation');
  });

  it('③ 无过渡留痕（手工把订单改成 Shipping）→ fallback Confirmed，不猜 Pending', async () => {
    const order = await makeOrder('Confirmed');
    await prisma.order.update({ where: { id: order.id }, data: { status: 'Shipping' } });
    await prisma.orderStatusTransition.deleteMany({ where: { orderId: order.id } });

    const sh = await makeShipment(order.id, 'Booked');
    const r = await cancel(sh.id);
    expect(r.ok).toBe(true);
    expect(await orderStatus(order.id)).toBe('Confirmed');
  });

  it('④ 分批/合票：还有第二票在途 → 取消一票**不**回退（不误退，最关键）', async () => {
    const order = await makeOrder('Production');
    const sh1 = await makeShipment(order.id, 'Booked');
    await makeShipment(order.id, 'Booked'); // 第二票仍在途
    expect(await orderStatus(order.id)).toBe('Shipping');

    const r = await cancel(sh1.id);
    expect(r.ok).toBe(true);
    expect(await orderStatus(order.id)).toBe('Shipping'); // 保持
  });

  /**
   * ⑤ 判据修正（第一版写错了）：我原想「给 Delivered 订单建运单」—— 但那在建单阶段就被
   *   既有的 ORDER_TERMINAL fail-closed 挡掉了，构不出场景。真实场景是**出运途中订单
   *   被手工推进到终态 Delivered**（或已交付后才取消运单），此时取消不该把终态改回去。
   */
  it('⑤ 订单已到终态 Delivered → 取消运单不回退', async () => {
    const order = await makeOrder('Production');
    const sh = await makeShipment(order.id, 'Booked');
    expect(await orderStatus(order.id)).toBe('Shipping');
    await prisma.order.update({ where: { id: order.id }, data: { status: 'Delivered' } });

    const r = await cancel(sh.id);
    expect(r.ok).toBe(true);
    expect(await orderStatus(order.id)).toBe('Delivered');
  });

  it('⑥ 合票中「非主订单」（仅经分配关联）→ 整票取消同样回退（不漏收）', async () => {
    const main = await makeOrder('Production');
    const consol = await makeOrder('Production');
    const sh = await makeShipment(main.id, 'Booked');

    // 合票：consol 只通过 ShipmentOrderAllocation 挂在这票上（不是 Shipment.orderId）
    await prisma.shipmentOrderAllocation.create({
      data: {
        id: ctx.id(`SHPA_${n()}`), shipmentId: sh.id, orderId: consol.id, orderLineId: null,
        plannedQty: 100, actualQty: 100, unit: 'PCS', status: 'Planned',
        createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
      },
    });
    // 正向联动只联动主订单（既有行为），这里手工把合票订单置为 Shipping 以构造回退前提
    await prisma.order.update({ where: { id: consol.id }, data: { status: 'Shipping' } });

    const r = await cancel(sh.id);
    expect(r.ok).toBe(true);
    expect(await orderStatus(main.id)).toBe('Production');
    expect(await orderStatus(consol.id)).toBe('Confirmed'); // 无留痕 → fallback
  });

  // ─────────────────────────────────────────────────────────────
  // ★ B50-1d：回退目标"是查来的"还是"是推断的"必须可分辨。
  //   兜底值本身没变（仍是 Confirmed，理由见 orderLinkService 的注释与本文件 ③），
  //   改的是**它不许伪装成真实历史**：结果里带 basis、流转留痕的 note 里带依据。
  //   （台账 §9 B50-1d 的另一半"恢复算不算新确认"是政策问 §12.1#16④，本批不自拍。）
  // ─────────────────────────────────────────────────────────────
  it('⑦ 依据可分辨：真实留痕 / 无留痕 / 脏留痕 三种情形各返回自己的 basis', async () => {
    const { resolveOrderStatusBeforeShipping } = await import('../orderLinkService');

    // (a) 真实留痕：走正向联动写进去的那条 Shipping transition（fromStatus=Production）
    const real = await makeOrder('Production');
    await makeShipment(real.id, 'Booked');
    expect(await resolveOrderStatusBeforeShipping(prisma as any, real.id))
      .toEqual({ status: 'Production', basis: 'history' });

    // (b) 无留痕
    const none = await makeOrder('Confirmed');
    await prisma.orderStatusTransition.deleteMany({ where: { orderId: none.id } });
    expect(await resolveOrderStatusBeforeShipping(prisma as any, none.id))
      .toEqual({ status: 'Confirmed', basis: 'no-transition-row' });

    // (c) 有留痕但 fromStatus 不在可回退集合（脏值）⇒ 与 (b) 分开，别把"查到了不可用"说成"没有"
    const dirty = await makeOrder('Confirmed');
    await prisma.orderStatusTransition.deleteMany({ where: { orderId: dirty.id } });
    await prisma.orderStatusTransition.create({
      data: {
        id: ctx.id(`ST_${n()}`), orderId: dirty.id, fromStatus: 'Alert', toStatus: 'Shipping',
        note: 'TEST 脏留痕', operator: ACTOR, createdAt: BigInt(Date.now()),
      },
    });
    expect(await resolveOrderStatusBeforeShipping(prisma as any, dirty.id))
      .toEqual({ status: 'Confirmed', basis: 'row-unusable' });

    // (d) 留痕在、但 fromStatus 是空串（schema 三列都是裸 String、无 CHECK ⇒ 不是不可能）
    //     ★ 必须归 row-unusable：库里**有**一条留痕，说成"没有留痕"是假陈述。
    const blank = await makeOrder('Confirmed');
    await prisma.orderStatusTransition.deleteMany({ where: { orderId: blank.id } });
    await prisma.orderStatusTransition.create({
      data: {
        id: ctx.id(`ST_${n()}`), orderId: blank.id, fromStatus: '', toStatus: 'Shipping',
        note: 'TEST 空值留痕', operator: ACTOR, createdAt: BigInt(Date.now()),
      },
    });
    expect(await resolveOrderStatusBeforeShipping(prisma as any, blank.id))
      .toEqual({ status: 'Confirmed', basis: 'row-unusable' });
  });

  it('★ ⑧ 推断出来的回退，note 里必须自带依据（真库端到端；有留痕的那条不许带）', async () => {
    // 构造"真的一条留痕都没有"：建票（会写 Shipping 留痕）→ 删掉这些留痕 → 再把状态摆回 Shipping
    const inferredOrder = await makeOrder('Confirmed');
    const shInferred = await makeShipment(inferredOrder.id, 'Booked');
    await prisma.orderStatusTransition.deleteMany({ where: { orderId: inferredOrder.id } });
    await prisma.order.update({ where: { id: inferredOrder.id }, data: { status: 'Shipping' } });
    // 前提自检：如果这里还有留痕，本例测的就不是"无据可查"那一支，而是"有脏留痕"那一支
    expect(await prisma.orderStatusTransition.count({ where: { orderId: inferredOrder.id } })).toBe(0);
    await cancel(shInferred.id);
    const inferredNote = (await prisma.orderStatusTransition.findFirst({
      where: { orderId: inferredOrder.id, toStatus: 'Confirmed' }, orderBy: { createdAt: 'desc' }, select: { note: true },
    }))!.note;
    expect(inferredNote).toContain('推断');
    expect(inferredNote).toContain('没有 toStatus=Shipping'); // 必须是**那一种**推断，不是一句通用"推断"

    // 反面对照：有真实留痕的回退，note 里不许出现"推断"（否则这条判据等于什么都没说）
    const realOrder = await makeOrder('Production');
    const shReal = await makeShipment(realOrder.id, 'Booked');
    await cancel(shReal.id);
    const realNote = (await prisma.orderStatusTransition.findFirst({
      where: { orderId: realOrder.id, toStatus: 'Production' }, orderBy: { createdAt: 'desc' }, select: { note: true },
    }))!.note;
    // 反面对照：有真实留痕的回退，note 里不许出现**任何一种**依据说明。
    // ★ 旧断言只咬 `推断` 两个字，而 history 那支的文案是「依据真实流转留痕」（不含"推断"）
    //   ⇒ 一个"四种 basis 一律追加后缀"的错实现照样绿。改成按导出的文案表逐支咬，
    //   这样"有依据也标注"和"把依据搞错"两类错法都会红。
    expect(realNote).not.toContain('推断');
    const { ROLLBACK_BASIS_TEXT } = await import('../orderLinkService');
    for (const text of Object.values(ROLLBACK_BASIS_TEXT)) {
      expect(realNote).not.toContain(text);
    }
  });

  it('⑨ 留痕查询失败 ⇒ basis=query-failed（"系统不知道"≠"确认过没有"），仍按 Confirmed 兜底但不谎称有据', async () => {
    const { resolveOrderStatusBeforeShipping } = await import('../orderLinkService');
    const failingTx = { orderStatusTransition: { findMany: async () => { throw new Error('relation does not exist'); } } };
    const r = await resolveOrderStatusBeforeShipping(failingTx as any, 'ORD_WHATEVER');
    expect(r.basis).toBe('query-failed');
    expect(r.status).toBe('Confirmed');
  });

  // ─────────────────────────────────────────────────────────────
  // ★ A10-①（拍板件 §2.3）：本处是**第三条免检入口** —— 运单取消 ⇒ 直写
  //   `tx.order.update` 把订单写回 `Confirmed` 而**不跑任何门禁**。
  //   改法：回退前先跑 `evaluateOrderRestoreGate`（与变更单那两处同一派发）。
  //
  //   ★ 造阻断场景选 **L/C 未登记** 这一支，不选"客户冻结"：信用门禁被挡时会
  //     **自动发起** `credit_exemption`（写 `ExceptionRequest` + `ApprovalRequest` 两行），
  //     本文件那套"零残留"清单里没有这两张表 ⇒ 会污染判据；而 L/C 阻断路径
  //     （`decideLcGate` → `hasActiveException`）**全程只读** ⇒ 零新增残留表。
  //     判据强度不打折：走的是同一个 `evaluateOrderConfirmGates` 的同一处 fail-closed 返回。
  // ─────────────────────────────────────────────────────────────
  /** 把订单摆成「回退目标必为 Confirmed」：删掉那条 toStatus=Shipping 的留痕 */
  async function forceRollbackTargetConfirmed(orderId: string) {
    await prisma.orderStatusTransition.deleteMany({ where: { orderId } });
    const { resolveOrderStatusBeforeShipping } = await import('../orderLinkService');
    const r = await resolveOrderStatusBeforeShipping(prisma as any, orderId);
    expect(r.status, '前置自检：目标必须落在 Confirmed 这一档（否则门禁根本不跑，本例变成恒绿）').toBe('Confirmed');
  }

  it('★ A10-① 端到端：回退目标 = Confirmed 且门禁不过 ⇒ 运单取消照常、订单状态**不写回**', async () => {
    const order = await makeOrder('Production');
    // 以 L/C 结算但不登记信用证 ⇒ 确认门禁必拦（`LC_GATE_BLOCKED`）
    await prisma.order.update({ where: { id: order.id }, data: { paymentInstrument: 'L/C' } });
    const sh = await makeShipment(order.id, 'Booked');
    expect(await orderStatus(order.id)).toBe('Shipping');
    await forceRollbackTargetConfirmed(order.id);

    const r = await cancel(sh.id);
    // ★ 硬条件 3 的同款语义：取消运单是操作人的权利，**不该被订单的门禁卡住**
    expect(r.ok, '运单取消本身必须照常成功（不许把两件无关的事绑在一起）').toBe(true);
    expect(await orderStatus(order.id), '★ 门禁不过 ⇒ 订单状态不写回（停在 Shipping）').toBe('Shipping');
  });

  it('★ A10-① 反面对照：同一场景改走 T/T ⇒ 订单写回 Confirmed（防"一律拦下"的假门禁）', async () => {
    const order = await makeOrder('Production');
    await prisma.order.update({ where: { id: order.id }, data: { paymentInstrument: 'T/T' } });
    const sh = await makeShipment(order.id, 'Booked');
    expect(await orderStatus(order.id)).toBe('Shipping');
    await forceRollbackTargetConfirmed(order.id);

    const r = await cancel(sh.id);
    expect(r.ok).toBe(true);
    expect(await orderStatus(order.id), '门禁该放行时就必须放行').toBe('Confirmed');
  });

  it('★ A10-① 返回值：被拦时带 `restoreBlocked`（与既有的两种 skipped 可机器区分）', async () => {
    const { linkOrderStatusFromShipment } = await import('../orderLinkService');

    const blocked = await makeOrder('Production');
    await prisma.order.update({ where: { id: blocked.id }, data: { paymentInstrument: 'L/C' } });
    const shB = await makeShipment(blocked.id, 'Booked');
    await forceRollbackTargetConfirmed(blocked.id);
    // ★ 必须先真取消：否则 `hasOtherActiveShipmentForOrder` 会把这一票算成"别的在途票"
    //   ⇒ 返回的是"不该联动"那一种 skipped，本例就测不到门禁这一支（假绿）。
    expect((await cancel(shB.id)).ok).toBe(true);

    const rB = await prisma.$transaction(tx => linkOrderStatusFromShipment(tx as any, blocked.id, 'Cancelled', { shipmentId: shB.id, operator: ACTOR }));
    expect(rB.ok).toBe(true);
    expect(rB.skipped, '订单状态确实没动 ⇒ 调用方据 skipped 不记 orderStatus').toBe(true);
    expect(rB.restoreBlocked?.code, '★ 必须能读出"被门禁拦了"，不能与"本来就不用回退"混同').toBe('LC_GATE_BLOCKED');
    // ★ 文案要「说清 + 给下一步」，且**不许内插内部异常原文**（B22 棘轮：只许减不许增）
    expect(rB.restoreBlocked?.message ?? '').toContain('订单状态未写回');
    expect(rB.restoreBlocked?.message ?? '').toContain('LC_GATE_BLOCKED');
    expect(rB.restoreBlocked?.message ?? '', '内部原文/英文异常不得上屏').not.toMatch(/PrismaClient|Error:|at .*\.ts:\d+/);
    expect(rB.rollbackBasis, '被拦时仍要如实报出回退目标是怎么来的').toBe('no-transition-row');

    // ★ 反面对照：真正"无需联动"的那一支**不许**带 restoreBlocked（否则这个字段等于没信息量）
    const shC = await makeShipment(blocked.id, 'Booked');
    const rC = await linkOrderStatusFromShipment(prisma as any, blocked.id, 'Booked', { shipmentId: shC.id });
    expect(rC.skipped).toBe(true);
    expect(rC.restoreBlocked, 'Booked 不映射 ⇒ 无需联动，不是被门禁拦').toBeUndefined();
  });
});
