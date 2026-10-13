/**
 * ownershipOurStockDrill.test.ts — ★ C6 真库守卫：寄售/在途的我方货**不再被静默少算**
 *
 * 为什么要有（零基础障碍清单 C6）：
 *   原枚举只有 Owned/Transferred ⇒ 寄售（货在客户/海外仓）与在途（已发运未到货）无处可标。
 *   塞进 Owned ⇒ 我方存货虚高且看不出可用性；塞进 Transferred ⇒ **我方存货静默少算**。
 *
 * 判据（真库 + 前缀隔离 + 自回滚 + 独立复核零残留）：
 *   ① 设 4 档 → 分档明细正确
 *   ② ★ 我方存货合计 = 可用 + 在途 + 寄售（**含新两档**），已转移不计入
 *   ③ `ownedOnly` 是 `ourStock` 的别名（不是「只含 Owned」的旧口径）
 *   ④ 汇总按**单位分组**（跨单位不相加，含新档）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Prisma } from '@prisma/client';
import { createDrillContext, noBackendMessage, safeResidualCounts } from '../../__tests__/lib/drillTouchLog';
import { createInventoryOwnershipService } from '../inventoryOwnershipService';

const MARK = 'TEST_C6OWN_';
/**
 * ★ B35 第三刀采纳点 8/12（v2.84）：客户端由**触碰记录壳**给 ⇒ 该数哪几张表由运行时写过的模型决定。
 *   原来 `svc` 在建模块时就吃进裸客户端；现在吃进壳 ⇒ 服务内部的写（含 `$transaction` 里的，v2.81 起）也进触碰集合。
 *   id 仍在 `TEST_C6OWN_` 族内 ⇒ v2.63 认领与 v2.67 族对撞**不换口径**。
 */
const ctx = createDrillContext({ prefix: MARK });
const prisma = ctx.prisma;
const svc = createInventoryOwnershipService(prisma);

/** AuditLog.actorId 有 FK ⇒ 演练执行者必须是真实 UserAccount（不能传 'api'） */
const ACTOR = ctx.actor;
let seq = 0;
const n = () => `${++seq}_${Date.now().toString(36)}`;

async function ensureActor() {
  if (await prisma.userAccount.findUnique({ where: { id: ACTOR } })) return;
  await prisma.userAccount.create({
    data: { id: ACTOR, displayName: 'C6 Ownership Test', email: `${ACTOR}@bambook.test`, passwordHash: '' },
  });
}

async function cleanup() {
  // ★ 只删本次 run（ctx.mark 含 runId）⇒ 历史/别轮行不动（删它们要 §12.1 点头）
  await prisma.auditLog.deleteMany({ where: { actorId: ACTOR } });
  await prisma.inventoryItem.deleteMany({ where: { id: own } });
  await prisma.warehouse.deleteMany({ where: { id: own } });
  await prisma.userAccount.deleteMany({ where: { id: ACTOR } });
}

/** ★ B151/v3.28：残留普查交给基座 `safeResidualCounts` ⇒ "没有读数"不再冒充"清干净"。
 *   ⚠️ v3.29 复核 E 项更正本注释（原来写"库不可达时报第三态 NO_BACKEND"是**说满了**）：
 *   真断库时先炸的是上一行 `cleanup()`——整条清理链仍在第三态之外（§12.1 第 27 条，不自采），
 *   所以本文件在断库时通常红在它身上；第三态本身由判据 ⑤⑨ 用真客户端证（那里没有 cleanup 挡前面）。
 *   键与 where 逐字搬自旧 `residual()`，一条未改。 */
/** ★ v3.28：这行原来住在 `residual()` 函数体里；普查点被提级成模块级 SPEC 之后局部名要跟着提级，
 *   否则闭包引用到一个已消失的名字（这 4 份实测 14 个悬空点）。⚠️ 门禁本该报出来，但
 *   server/tsconfig.json 的 exclude 把 `*.test.ts` 与 `__tests__/**` 整类排除 ⇒ 演练文件的类型错误
 *   对 tsc 完全隐形 —— 这条场域问题记在 B154。 */
const own = { startsWith: ctx.mark };
const RESIDUAL_SPEC = [
  { key: 'item', model: 'inventoryItem', run: () => prisma.inventoryItem.count({ where: { id: own } }) },
  { key: 'wh', model: 'warehouse', run: () => prisma.warehouse.count({ where: { id: own } }) },
  { key: 'audit', model: 'auditLog', run: () => prisma.auditLog.count({ where: { actorId: ACTOR } }) },
  { key: 'ua', model: 'userAccount', run: () => prisma.userAccount.count({ where: { id: ACTOR } }) },
];

async function makeWarehouse() {
  return prisma.warehouse.create({
    data: {
      id: ctx.id(`WH_${n()}`), code: ctx.id(`WH-${n()}`), name: 'C6 测试仓', type: 'Main',
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    } as any,
  });
}

async function makeItem(warehouseId: string, ownership: string, qty: number, unit = 'M') {
  return prisma.inventoryItem.create({
    data: {
      id: ctx.id(`ITEM_${n()}`), warehouseId, description: 'C6 面料', category: 'Fabric',
      ownership, quantity: new Prisma.Decimal(qty), unit,
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    } as any,
  });
}

const groupOf = (summary: any, ownership: string) =>
  summary.byOwnership.find((g: any) => g.ownership === ownership);

describe('★ C6 真库守卫：货权 4 档与我方存货合计', () => {
  beforeAll(async () => { await cleanup(); await ensureActor(); });

  afterAll(async () => {
    await cleanup();
    const got = await safeResidualCounts(RESIDUAL_SPEC);
    expect(got.unreadable, noBackendMessage(got.unreadable)).toEqual([]);
    expect(got.values, `★ 有残留：${got.dirty.join('；')} ⇒ 本演练建的行没清干净（touched=${JSON.stringify(ctx.touchedModels())}）`)
      .toEqual({ item: 0, wh: 0, audit: 0, ua: 0 }); // 零残留（同一判据）
    /** ★ 壳那一半：触碰非空 + 含主对象 + 列无关 dirty=[] + 不许有数不到的表 */
    const touched = ctx.touchedModels();
    expect(touched, '库存项是本演练的主对象 ⇒ InventoryItem 必须在触碰集合里').toContain('InventoryItem');
    await prisma.$disconnect();
  });

  it('① 4 档都能落库并分档汇总（寄售/在途不再是「无处可标」）', async () => {
    const wh = await makeWarehouse();
    await makeItem(wh.id, 'Owned', 100);
    await makeItem(wh.id, 'Consignment', 200);
    await makeItem(wh.id, 'InTransit', 300);
    await makeItem(wh.id, 'Transferred', 400);

    const r = await svc.summarizeByOwnership({ warehouseId: wh.id });
    if (!r.ok) throw new Error(`汇总失败：${r.error.message}`);
    const s = r.data;

    expect(s.byOwnership.map((g: any) => g.ownership).sort()).toEqual(['Consignment', 'InTransit', 'Owned', 'Transferred']);
    expect(groupOf(s, 'Consignment')!.quantityByUnit).toEqual([{ unit: 'M', quantity: 200 }]);
    expect(groupOf(s, 'InTransit')!.quantityByUnit).toEqual([{ unit: 'M', quantity: 300 }]);
    // 标签是中文（不是英文裸值）
    expect(groupOf(s, 'Consignment')!.ownershipLabel).toContain('寄售');
    expect(groupOf(s, 'InTransit')!.ownershipLabel).toContain('在途');
  });

  it('★ ② 我方存货合计 = 可用 + 在途 + 寄售（已转移不计入）', async () => {
    const wh = await makeWarehouse();
    await makeItem(wh.id, 'Owned', 100);
    await makeItem(wh.id, 'Consignment', 200);
    await makeItem(wh.id, 'InTransit', 300);
    await makeItem(wh.id, 'Transferred', 9999); // 必须**不**计入

    const r = await svc.summarizeByOwnership({ warehouseId: wh.id });
    if (!r.ok) throw new Error(`汇总失败：${r.error.message}`);
    const s = r.data;

    expect(s.ourStock).toBeTruthy();
    expect(s.ourStock!.ownership).toBe('OurStock');
    // 100 + 200 + 300 = 600（不含 Transferred 的 9999）
    expect(s.ourStock!.quantityByUnit).toEqual([{ unit: 'M', quantity: 600 }]);
    expect(s.ourStock!.itemCount).toBe(3);
    // 分档明细只含计入的 3 档
    expect(s.ourStockBreakdown.map((g: any) => g.ownership)).toEqual(['Consignment', 'InTransit', 'Owned']);
  });

  it('★ ③ ownedOnly 是 ourStock 的别名（不是「只含 Owned」的旧口径）', async () => {
    const wh = await makeWarehouse();
    await makeItem(wh.id, 'Owned', 100);
    await makeItem(wh.id, 'InTransit', 300);

    const r = await svc.summarizeByOwnership({ warehouseId: wh.id });
    if (!r.ok) throw new Error(`汇总失败：${r.error.message}`);
    // 旧口径会给 100（静默少算在途的 300）；新口径 400
    expect(r.data.ownedOnly).toEqual(r.data.ourStock);
    expect(r.data.ownedOnly!.quantityByUnit).toEqual([{ unit: 'M', quantity: 400 }]);
  });

  it('④ 跨单位不相加（含新档）', async () => {
    const wh = await makeWarehouse();
    await makeItem(wh.id, 'InTransit', 300, 'M');
    await makeItem(wh.id, 'Consignment', 50, 'PCS');

    const r = await svc.summarizeByOwnership({ warehouseId: wh.id });
    if (!r.ok) throw new Error(`汇总失败：${r.error.message}`);
    expect(r.data.ourStock!.quantityByUnit).toEqual([
      { unit: 'M', quantity: 300 },
      { unit: 'PCS', quantity: 50 },
    ]);
  });

  it('⑤ setOwnership 接受新档（校验读同一份枚举真源）', async () => {
    const wh = await makeWarehouse();
    const item = await makeItem(wh.id, 'Owned', 100);

    const okRes = await svc.setOwnership({ itemId: item.id, ownership: 'Consignment', actorId: ACTOR });
    if (!okRes.ok) throw new Error(`设寄售失败：${okRes.error.message}`);
    expect(await prisma.inventoryItem.findUnique({ where: { id: item.id }, select: { ownership: true } }))
      .toEqual({ ownership: 'Consignment' });

    const badRes = await svc.setOwnership({ itemId: item.id, ownership: 'Weird', actorId: ACTOR });
    expect(badRes.ok).toBe(false);
    expect(badRes.error!.message).toContain('Consignment'); // 错误消息列出允许值（含新档）
  });
});
