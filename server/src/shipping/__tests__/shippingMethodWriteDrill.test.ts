/**
 * shippingMethodWriteDrill.test.ts — ★ C2 真库守卫：运输方式写入校验 + 归一 + 分组不分裂
 *
 * 为什么要有这个测试（真库实测驱动）：
 *   `shippingMethod` 原本是**自由文本、服务端零校验**，真库实测 75 张票里
 *   `Sea` 67 · `Air` 7 · **`Sea Freight` 1** —— 同一含义三种写法 ⇒
 *   ① 报表按方式分组会多出第三种桶 ② 业务员想填「客户自提」没有选项。
 *
 * 判据（真库 + 真服务 + 前缀隔离 + 自回滚 + 独立复核零残留）：
 *   ① 海运/空运允许新建；陆运、铁路、快递、自提禁止新建
 *   ② 建票 `海运` / `Sea Freight` → **归一**落库 `Sea`（不是拒绝）
 *   ③ 建票 `Teleport` → 400 `INVALID_SHIPPING_METHOD` 且**无落库**
 *   ④ PATCH 改运输方式同样校验 + 归一
 *   ⑤ ★ 历史脏值票（直接落库 `Sea Freight`）PATCH **别的字段** → 不被拒（不回溯校验，不卡老数据）
 *   ⑥ 统计分组：`Sea` 与 `Sea Freight` 归到**同一个桶**（不再分裂）
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createDrillContext, noBackendMessage, safeResidualCounts } from '../../__tests__/lib/drillTouchLog';
import { createShipment, updateShipment } from '../shipmentMutationService';
import { getMethodStats } from '../shipmentStatsService';

const MARK = 'TEST_C2SM_';
/** ★ B35 第三刀采纳点 7/12（v2.83）：客户端由触碰记录壳给；id 仍在 TEST_C2SM_ 族内 ⇒ 认领口径不换。 */
const ctx = createDrillContext({ prefix: MARK });
const prisma = ctx.prisma;
const ACTOR = ctx.actor;

let seq = 0;
const n = () => `${++seq}_${Date.now().toString(36)}`;

async function ensureActor() {
  if (await prisma.userAccount.findUnique({ where: { id: ACTOR } })) return;
  await prisma.userAccount.create({
    data: { id: ACTOR, displayName: 'C2 SM Test', email: `${ACTOR}@bambook.test`, passwordHash: '' },
  });
}

async function cleanup() {
  // ★ 只删本次 run（ctx.mark 含 runId）⇒ 历史/别轮行不动
  await prisma.auditLog.deleteMany({ where: { actorId: ACTOR } });
  await prisma.shipmentOrderAllocation.deleteMany({ where: { shipmentId: own } });
  await prisma.shipmentEvent.deleteMany({ where: { shipmentId: own } });
  await prisma.shipment.deleteMany({ where: { id: own } });
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
  { key: 'shp', model: 'shipment', run: () => prisma.shipment.count({ where: { id: own } }) },
  { key: 'audit', model: 'auditLog', run: () => prisma.auditLog.count({ where: { actorId: ACTOR } }) },
  { key: 'evt', model: 'shipmentEvent', run: () => prisma.shipmentEvent.count({ where: { shipmentId: own } }) },
  { key: 'alloc', model: 'shipmentOrderAllocation', run: () => prisma.shipmentOrderAllocation.count({ where: { shipmentId: own } }) },
  { key: 'ua', model: 'userAccount', run: () => prisma.userAccount.count({ where: { id: ACTOR } }) },
];

const create = (shippingMethod: string, id?: string) =>
  createShipment({
    prisma: prisma as any,
    input: {
      id: id ?? ctx.id(`SHP_${n()}`),
      type: 'Export', status: 'Booked', shippingMethod,
    } as any,
    actorId: ACTOR,
    generateIdIfMissing: true,
  });

const methodOf = async (id: string) =>
  (await prisma.shipment.findUnique({ where: { id }, select: { shippingMethod: true } }))!.shippingMethod;

describe('MVP 真库守卫：运输方式（仅海运/空运 + 历史值兼容）', () => {
  beforeEach(async () => { await cleanup(); await ensureActor(); });

  afterAll(async () => {
    await cleanup();
    const got = await safeResidualCounts(RESIDUAL_SPEC);
    expect(got.unreadable, noBackendMessage(got.unreadable)).toEqual([]);
    expect(got.values, `★ 有残留：${got.dirty.join('；')} ⇒ 本演练建的行没清干净（touched=${JSON.stringify(ctx.touchedModels())}）`)
      .toEqual({ shp: 0, audit: 0, evt: 0, alloc: 0, ua: 0 }); // 零残留（含原来只在 cleanup 出现的两张表）
    const touched = ctx.touchedModels();
    expect(touched, '本演练建过运单 ⇒ Shipment 必须在触碰集合里').toContain('Shipment');
    await prisma.$disconnect();
  });

  it('① 建票海运/空运均可落库', async () => {
    const seaId = ctx.id(`SHP_${n()}`);
    const airId = ctx.id(`SHP_${n()}`);
    expect((await create('Sea', seaId)).ok).toBe(true);
    expect(await methodOf(seaId)).toBe('Sea');
    expect((await create('Air', airId)).ok).toBe(true);
    expect(await methodOf(airId)).toBe('Air');
  });

  it('② 建票传中文/脏值 → 归一落库（不是拒绝）', async () => {
    const id1 = ctx.id(`SHP_${n()}`);
    const id2 = ctx.id(`SHP_${n()}`);
    expect((await create('海运', id1)).ok).toBe(true);
    expect(await methodOf(id1)).toBe('Sea');

    expect((await create('Sea Freight', id2)).ok).toBe(true);
    expect(await methodOf(id2)).toBe('Sea');
  });

  it('③ 建票传认不出的值 → INVALID_SHIPPING_METHOD 且无落库', async () => {
    const id = ctx.id(`SHP_${n()}`);
    const r = await create('Teleport', id);
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe('INVALID_SHIPPING_METHOD');
    expect(await prisma.shipment.count({ where: { id } })).toBe(0);
  });

  it('③a 建票自提/陆运等非 MVP 方式 → INVALID_SHIPPING_METHOD 且无落库', async () => {
    for (const method of ['Pickup', 'Land', 'Rail', 'Courier']) {
      const id = ctx.id(`SHP_${n()}`);
      const result = await create(method, id);
      expect(result.ok, method).toBe(false);
      expect(result.error!.code, method).toBe('INVALID_SHIPPING_METHOD');
      expect(await prisma.shipment.count({ where: { id } }), method).toBe(0);
    }
  });

  it('④ PATCH 运输方式：校验 + 归一', async () => {
    const id = ctx.id(`SHP_${n()}`);
    await create('Sea', id);

    const ok = await updateShipment({ prisma: prisma as any, shipmentId: id, patch: { shippingMethod: '空运' } as any, hasStatus: false, actorId: ACTOR });
    expect(ok.ok).toBe(true);
    expect(await methodOf(id)).toBe('Air');

    const blocked = await updateShipment({ prisma: prisma as any, shipmentId: id, patch: { shippingMethod: '客户自提' } as any, hasStatus: false, actorId: ACTOR });
    expect(blocked.ok).toBe(false);
    expect(blocked.error!.code).toBe('INVALID_SHIPPING_METHOD');
    expect(await methodOf(id)).toBe('Air');

    const bad = await updateShipment({ prisma: prisma as any, shipmentId: id, patch: { shippingMethod: 'Teleport' } as any, hasStatus: false, actorId: ACTOR });
    expect(bad.ok).toBe(false);
    expect(bad.error!.code).toBe('INVALID_SHIPPING_METHOD');
    expect(await methodOf(id)).toBe('Air'); // 未被改坏
  });

  it('⑤ 历史脏值票 PATCH **别的字段** → 不被拒（校验不回溯，不卡老数据）', async () => {
    const id = ctx.id(`SHP_${n()}`);
    // 直接落库一个历史脏值（模拟真库那 1 条 Sea Freight）
    await prisma.shipment.create({
      data: {
        id, shipmentNumber: `${MARK}NO_${n()}`, type: 'Export', status: 'Booked',
        shippingMethod: 'Sea Freight',
        createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
      },
    });
    const r = await updateShipment({ prisma: prisma as any, shipmentId: id, patch: { notes: '补个备注' } as any, hasStatus: false, actorId: ACTOR });
    expect(r.ok).toBe(true);
    expect(await methodOf(id)).toBe('Sea Freight'); // 原值保留
  });

  it('⑥ 统计分组：Sea 与 Sea Freight 归同一桶（报表不再分裂出第三种方式）', async () => {
    const idClean = ctx.id(`SHP_${n()}`);
    const idDirty = ctx.id(`SHP_${n()}`);
    await create('Sea', idClean);
    await prisma.shipment.create({
      data: {
        id: idDirty, shipmentNumber: `${MARK}NO_${n()}`, type: 'Export', status: 'Booked',
        shippingMethod: 'Sea Freight',
        createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
      },
    });

    const stats = await getMethodStats(prisma);
    const seaBuckets = stats.methods.filter(b => b.method === 'Sea');
    expect(seaBuckets).toHaveLength(1);
    expect(seaBuckets[0].total).toBeGreaterThanOrEqual(2); // 两张票都进 Sea 桶
    expect(stats.methods.some(b => b.method === 'Sea Freight')).toBe(false);
  });
});
