/**
 * stockOwnershipDrill.test.ts — ★ C4 真库守卫：备货归属 + A 单货挪 B 单**留痕**
 *
 * 为什么要有这个测试（零基础障碍清单 C4）：
 *   `InventoryItem` 此前**完全没有订单锚点** ⇒ 备货（无单先产）无法归属订单；
 *   更严重的是「A 单货挪 B 单」**无任何留痕** —— 谁挪的、什么时候、为什么，全查不到。
 *   本演练证明：归属真的落库、**挪货真的留痕**、且拒绝路径不留垃圾。
 *
 * 判据（真库 + 真服务 + 前缀隔离 + 自回滚 + 独立复核零残留）：
 *   ① 备货 → 归属订单（attribute）：orderId 落库 + stockPrep 转 false + 留痕 1 条
 *   ② ★ 挪货（reassign A→B）：orderId 变 B + **留痕记下 from=A/to=B** + 按订单查得到/查不到
 *   ③ 退回（release）→ 再标记备货（mark_stock_prep）：状态可逆且**每步都有留痕**
 *   ④ 拒绝路径：已归属直接标备货 / 已归属用 attribute / 未归属用 reassign / 0 库存 / 事由太短
 *      —— 全部**零落库**（拦在写之前）
 *   ⑤ 历史 append-only：四次变更 → 4 条留痕，倒序可读
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Prisma } from '@prisma/client';
import { createDrillContext, noBackendMessage, safeResidualCounts } from '../../__tests__/lib/drillTouchLog';
import {
  applyOwnershipChange,
  listOwnershipHistory,
  listItemsByOrder,
  OWNERSHIP_REASON_MIN,
} from '../stockOwnershipService';

const MARK = 'TEST_C4OWN_';
/**
 * ★ B35 第三刀（#32）采纳点 1/12：prisma 换成**触碰记录壳**（原来这里是裸 `new PrismaClient()`）。
 *   为什么 `MARK` 还留着：它负责**清历史行**（本批之前每轮门禁留下的 `TEST_C4OWN_*`），
 *   而 `ctx.mark` 只圈**本次 run** ⇒ 两者都在 `TEST_C4OWN_` 前缀族内 ⇒
 *   v2.63 的"按前缀族认领"与 v2.67 的"族 ⊆ 源派生"两条判据都不换口径。
 *   执行者也改成 run 唯一（`ctx.actor`）—— 原来写死的 `TEST_ACTOR_C4OWN` 不带行标记，
 *   而这张 `userAccount` 表在本文件既不清也不数 ⇒ 它就是库里那 11 行演练账号的来源之一。
 */
const ctx = createDrillContext({ prefix: MARK });
const prisma = ctx.prisma;
const ACTOR = ctx.actor;

let seq = 0;
const n = () => `${++seq}_${Date.now().toString(36)}`;

async function ensureActor() {
  if (await prisma.userAccount.findUnique({ where: { id: ACTOR } })) return;
  await prisma.userAccount.create({
    data: { id: ACTOR, displayName: 'C4 Ownership Test', email: `${ACTOR}@bambook.test`, passwordHash: '' },
  });
}

async function cleanup() {
  // 历史行（族前缀）+ 本次 run 的执行者行；★ 不删别的 run 的账号
  await prisma.auditLog.deleteMany({ where: { actorId: ACTOR } });
  await prisma.inventoryOwnershipChange.deleteMany({ where: { itemId: { startsWith: MARK } } });
  await prisma.inventoryItem.deleteMany({ where: { id: { startsWith: MARK } } });
  await prisma.warehouse.deleteMany({ where: { id: { startsWith: MARK } } });
  await prisma.order.deleteMany({ where: { id: { startsWith: MARK } } });
  await prisma.userAccount.deleteMany({ where: { id: ACTOR } });
}

/** ★ B151/v3.28：残留普查交给基座 `safeResidualCounts` ⇒ "没有读数"不再冒充"清干净"。
 *   ⚠️ v3.29 复核 E 项更正本注释（原来写"库不可达时报第三态 NO_BACKEND"是**说满了**）：
 *   真断库时先炸的是上一行 `cleanup()`——整条清理链仍在第三态之外（§12.1 第 27 条，不自采），
 *   所以本文件在断库时通常红在它身上；第三态本身由判据 ⑤⑨ 用真客户端证（那里没有 cleanup 挡前面）。
 *   键与 where 逐字搬自旧 `residual()`，一条未改。 */
const RESIDUAL_SPEC = [
  { key: 'item', model: 'inventoryItem', run: () => prisma.inventoryItem.count({ where: { id: { startsWith: MARK } } }) },
  { key: 'chg', model: 'inventoryOwnershipChange', run: () => prisma.inventoryOwnershipChange.count({ where: { itemId: { startsWith: MARK } } }) },
  { key: 'wh', model: 'warehouse', run: () => prisma.warehouse.count({ where: { id: { startsWith: MARK } } }) },
  { key: 'ord', model: 'order', run: () => prisma.order.count({ where: { id: { startsWith: MARK } } }) },
  { key: 'audit', model: 'auditLog', run: () => prisma.auditLog.count({ where: { actorId: ACTOR } }) },
  { key: 'ua', model: 'userAccount', run: () => prisma.userAccount.count({ where: { id: ACTOR } }) },
];

async function makeWarehouse() {
  return prisma.warehouse.create({
    data: {
      // ★ 一律走 ctx.id(...)：这样每一行都带**本次 run** 的标记 ⇒ 收尾对撞才是"我这次写的干净没有"，
      //   而不是"整个 TEST_C4OWN_ 族历史上干不干净"（那是另一件事，由认领清单/清扫器负责）。
      id: ctx.id(`WH_${n()}`), code: ctx.id(`WH-${n()}`), name: 'C4 测试仓', type: 'Main',
      address: '测试地', createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    } as any,
  });
}

async function makeItem(quantity = 1000) {
  const wh = await makeWarehouse();
  return prisma.inventoryItem.create({
    data: {
      id: ctx.id(`ITEM_${n()}`), warehouseId: wh.id,
      description: 'C4 备货面料', category: 'Fabric', unit: 'M',
      quantity: new Prisma.Decimal(quantity),
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    },
  });
}

async function makeOrder(tag: string) {
  return prisma.order.create({
    data: {
      id: ctx.id(`ORD_${tag}_${n()}`), poNumber: ctx.id(`PO-${tag}`), customer: 'C4 客户',
      product: 'Fabric', type: 'Fabric', quantity: 1000, status: 'Confirmed',
      dueDate: '2026-12-31', quoteAmount: 10000, updatedAt: BigInt(Date.now()),
    },
  });
}

const itemOf = (id: string) =>
  prisma.inventoryItem.findUnique({ where: { id }, select: { orderId: true, stockPrep: true } });

const REASON = '备货归属测试：留痕校验用';

describe('★ C4 真库守卫：备货归属与挪货留痕', () => {
  beforeEach(async () => { await cleanup(); await ensureActor(); });

  afterAll(async () => {
    // ★ 先把"本次 run 到底写过哪些表"取下来（运行时得到，不是这份文件写下的清单）
    const touched = ctx.touchedModels();
    await cleanup();
    const got = await safeResidualCounts(RESIDUAL_SPEC);
    expect(got.unreadable, noBackendMessage(got.unreadable)).toEqual([]);
    expect(got.values, `★ 有残留：${got.dirty.join('；')} ⇒ 本演练建的行没清干净（touched=${JSON.stringify(ctx.touchedModels())}）`)
      .toEqual({ item: 0, chg: 0, wh: 0, ord: 0, audit: 0, ua: 0 }); // 零残留（本文件自己数的）
    // ★ 非空与方向都要钉：touched 为空 ⇒ 上面那句 `dirty=[]` 是在测空气（壳没记到东西）；
    //   userAccount 必须在 touched 里 —— 它是本文件历史上"写了但从不数"的那张表（B94 的活例）。
    expect(touched, '本文件确实建过执行者行 ⇒ 它必须在触碰集合里').toContain('UserAccount');
    await prisma.$disconnect();
  });

  it('① 备货 → 归属订单：orderId 落库、stockPrep 转 false、留痕 1 条', async () => {
    const item = await makeItem();
    const o = await makeOrder('A');

    const prep = await applyOwnershipChange(prisma, { itemId: item.id, action: 'mark_stock_prep', reason: REASON }, ACTOR);
    if (!prep.ok) throw new Error(`标记备货失败：${prep.error.code} ${prep.error.message}`);
    expect(await itemOf(item.id)).toEqual({ orderId: null, stockPrep: true });

    const attr = await applyOwnershipChange(prisma, { itemId: item.id, action: 'attribute', targetOrderId: o.id, reason: REASON }, ACTOR);
    if (!attr.ok) throw new Error(`归属失败：${attr.error.code} ${attr.error.message}`);
    expect(attr.data).toMatchObject({ previousOrderId: null, currentOrderId: o.id, stockPrep: false });
    expect(await itemOf(item.id)).toEqual({ orderId: o.id, stockPrep: false });

    const hist = await listOwnershipHistory(prisma, item.id);
    expect(hist.ok).toBe(true);
    expect(hist.data!.items).toHaveLength(2);
    expect(hist.data!.items[0].action).toBe('attribute'); // 倒序
    expect(hist.data!.items[1].action).toBe('mark_stock_prep');
  });

  it('② ★ 挪货 A→B：留痕记下 from=A/to=B，且按订单查得到/查不到', async () => {
    const item = await makeItem();
    const A = await makeOrder('A');
    const B = await makeOrder('B');

    await applyOwnershipChange(prisma, { itemId: item.id, action: 'attribute', targetOrderId: A.id, reason: REASON }, ACTOR);
    const move = await applyOwnershipChange(prisma, { itemId: item.id, action: 'reassign', targetOrderId: B.id, reason: 'A 单减量，这批货转给 B 单用' }, ACTOR);
    if (!move.ok) throw new Error(`挪货失败：${move.error.code} ${move.error.message}`);
    expect(move.data).toMatchObject({ previousOrderId: A.id, currentOrderId: B.id });

    // 留痕：能查到「从谁挪到谁、谁挪的、为什么」
    const hist = await listOwnershipHistory(prisma, item.id);
    const reassignRow = hist.data!.items.find((r: any) => r.action === 'reassign')!;
    expect(reassignRow.fromOrderId).toBe(A.id);
    expect(reassignRow.toOrderId).toBe(B.id);
    expect(reassignRow.operatorId).toBe(ACTOR);
    expect(reassignRow.reason).toContain('转给 B');

    // 按订单查：B 有、A 没有
    const byB = await listItemsByOrder(prisma, B.id);
    expect(byB.data!.items.map((i: any) => i.id)).toContain(item.id);
    const byA = await listItemsByOrder(prisma, A.id);
    expect(byA.data!.items.map((i: any) => i.id)).not.toContain(item.id);
  });

  it('③ 退回 → 再标记备货：状态可逆，每步都留痕', async () => {
    const item = await makeItem();
    const o = await makeOrder('A');
    await applyOwnershipChange(prisma, { itemId: item.id, action: 'attribute', targetOrderId: o.id, reason: REASON }, ACTOR);

    const rel = await applyOwnershipChange(prisma, { itemId: item.id, action: 'release', reason: '客户取消，货退回备货池' }, ACTOR);
    if (!rel.ok) throw new Error(`退回失败：${rel.error.code} ${rel.error.message}`);
    expect(await itemOf(item.id)).toEqual({ orderId: null, stockPrep: false });

    const prep = await applyOwnershipChange(prisma, { itemId: item.id, action: 'mark_stock_prep', reason: '退回后作为备货' }, ACTOR);
    if (!prep.ok) throw new Error(`再标记备货失败：${prep.error.code} ${prep.error.message}`);
    expect(await itemOf(item.id)).toEqual({ orderId: null, stockPrep: true });

    const hist = await listOwnershipHistory(prisma, item.id);
    expect(hist.data!.items.map((r: any) => r.action)).toEqual(['mark_stock_prep', 'release', 'attribute']);
  });

  it('④ 拒绝路径全部零落库（拦在写之前）', async () => {
    const item = await makeItem();
    const zeroItem = await makeItem(0);
    const A = await makeOrder('A');
    const B = await makeOrder('B');
    await applyOwnershipChange(prisma, { itemId: item.id, action: 'attribute', targetOrderId: A.id, reason: REASON }, ACTOR);
    const before = await prisma.inventoryOwnershipChange.count({ where: { itemId: item.id } });

    // 已归属直接标备货
    const r1 = await applyOwnershipChange(prisma, { itemId: item.id, action: 'mark_stock_prep', reason: REASON }, ACTOR);
    expect(r1.ok).toBe(false);
    expect((r1 as any).error.code).toBe('ALREADY_ATTRIBUTED');

    // 已归属用 attribute 换单
    const r2 = await applyOwnershipChange(prisma, { itemId: item.id, action: 'attribute', targetOrderId: B.id, reason: REASON }, ACTOR);
    expect((r2 as any).error.code).toBe('ALREADY_ATTRIBUTED');

    // 0 库存
    const r3 = await applyOwnershipChange(prisma, { itemId: zeroItem.id, action: 'mark_stock_prep', reason: REASON }, ACTOR);
    expect((r3 as any).error.code).toBe('NO_STOCK');

    // 事由太短
    const r4 = await applyOwnershipChange(prisma, { itemId: item.id, action: 'release', reason: 'x'.repeat(OWNERSHIP_REASON_MIN - 1) }, ACTOR);
    expect((r4 as any).error.code).toBe('REASON_TOO_SHORT');

    // 目标订单不存在
    const r5 = await applyOwnershipChange(prisma, { itemId: item.id, action: 'reassign', targetOrderId: `${MARK}NOT_EXIST`, reason: REASON }, ACTOR);
    expect((r5 as any).error.code).toBe('ORDER_NOT_FOUND');

    // 全部零落库 + 当前态未被改坏
    expect(await prisma.inventoryOwnershipChange.count({ where: { itemId: item.id } })).toBe(before);
    expect(await prisma.inventoryOwnershipChange.count({ where: { itemId: zeroItem.id } })).toBe(0);
    expect(await itemOf(item.id)).toEqual({ orderId: A.id, stockPrep: false });
  });

  it('④b 目标订单可填 **PO 号**（业务员手上是 PO 号，不是内部 id）', async () => {
    const item = await makeItem();
    const A = await makeOrder('A');
    const r = await applyOwnershipChange(prisma, { itemId: item.id, action: 'attribute', targetOrderId: A.poNumber!, reason: REASON }, ACTOR);
    if (!r.ok) throw new Error(`按 PO 号归属失败：${r.error.code} ${r.error.message}`);
    expect(r.data!.currentOrderId).toBe(A.id); // 落库的是真 id，不是 PO 号
    expect(await itemOf(item.id)).toEqual({ orderId: A.id, stockPrep: false });

    // 认不出的目标 → ORDER_NOT_FOUND（消息提示可填 id 或 PO 号）
    const bad = await applyOwnershipChange(prisma, { itemId: item.id, action: 'reassign', targetOrderId: 'NO-SUCH-PO', reason: REASON }, ACTOR);
    expect((bad as any).error.code).toBe('ORDER_NOT_FOUND');
    expect((bad as any).error.message).toContain('PO 号');
  });

  it('⑤ 历史 append-only：四次变更 → 4 条留痕', async () => {
    const item = await makeItem();
    const A = await makeOrder('A');
    const B = await makeOrder('B');
    // ⓘ 每一步都**必须断言返回值**：初版这里没检查，于是「事由 4 字 < 下限 6」被静默吞掉，
    //   表现为「应该有 4 条留痕却只有 3 条」—— 排查成本远高于一行断言。
    const steps: Array<Parameters<typeof applyOwnershipChange>[1]> = [
      { itemId: item.id, action: 'mark_stock_prep', reason: REASON },
      { itemId: item.id, action: 'attribute', targetOrderId: A.id, reason: REASON },
      { itemId: item.id, action: 'reassign', targetOrderId: B.id, reason: '改单挪货：转给 B 单' },
      { itemId: item.id, action: 'release', reason: '最终退回备货池' },
    ];
    for (const step of steps) {
      const r = await applyOwnershipChange(prisma, step, ACTOR);
      if (!r.ok) throw new Error(`步骤 ${step.action} 失败：${r.error.code} ${r.error.message}`);
    }

    const hist = await listOwnershipHistory(prisma, item.id);
    expect(hist.data!.items).toHaveLength(4);
    expect(hist.data!.items.map((r: any) => r.action)).toEqual(['release', 'reassign', 'attribute', 'mark_stock_prep']);
    // 审计同样落痕（4 次变更 → 至少 4 条）
    // ⓘ AuditLog 的字段是 `action`（不是 operation）—— 本仓已有踩坑记录
expect(await prisma.auditLog.count({ where: { actorId: ACTOR, action: 'INVENTORY_OWNERSHIP_CHANGE' } })).toBeGreaterThanOrEqual(4);
  });
});
