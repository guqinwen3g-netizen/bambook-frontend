/**
 * containerConsolidationDrill.test.ts — ★ C1 真库守卫：拼柜聚合（一柜多票）
 *
 * 为什么要有这个测试（零基础障碍清单 C1 · 实测订正了清单描述）：
 *   柜号字段**本来就有**（`Shipment.containerNumber`）。真缺口是**没有按柜号聚合的能力**：
 *   一柜装了几票/几个客户/多少件多少吨、对应几张报关单退了多少税、以及
 *   ★「同柜但 ETD/目的港/船名不一致」**毫无提示** —— 只能人工翻运单。
 *
 * 判据（真库 + 前缀隔离 + 自回滚 + 独立复核零残留）：
 *   ① 同柜两票 → 聚成一个柜：票数 2、客户数 2、件重体合计正确
 *   ② 阳性对照：另一柜只有 1 票 → 单独成柜、不进「拼柜」计数
 *   ③ 关联报关单 + 退税挂到**本柜**（不串柜）
 *   ④ ★ 柜内 ETD/目的港不一致 → 该柜 conflicts 命中（且不污染别的柜）
 *   ⑤ 未填柜号的票 → 进 unassigned，**不硬塞**进任何柜
 *   ⑥ summary 计数自洽（containerCount / consolidatedCount / conflictCount）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Prisma } from '@prisma/client';
import { createDrillContext, noBackendMessage, safeResidualCounts } from '../../__tests__/lib/drillTouchLog';
import { getContainerConsolidation } from '../containerConsolidationService';

const MARK = 'TEST_C1CT_';
/**
 * ★ B35 第三刀采纳点 4/12（v2.74）：prisma 换成**触碰记录壳** ⇒ “该数哪几张表”由运行时写过的模型决定。
 *   本文件历史上只数 `shp / decl / refund` 三张；接壳后若服务层还写了别的表，壳会直接把它纳进零残留判据。
 *   id 仍落在 `TEST_C1CT_` 族内 ⇒ v2.63 认领与 v2.67 族对撞**不换口径**。
 */
const ctx = createDrillContext({ prefix: MARK });
const prisma = ctx.prisma;
let seq = 0;
const n = () => `${++seq}_${Date.now().toString(36)}`;

/** 用**演练专属柜号**，避免与真库既有柜号混在一起（真库已有生产数据） */
const C1 = 'TESTC1CT0000001';
const C2 = 'TESTC1CT0000002';

async function cleanup() {
  // ★ 只删**本次 run**（ctx.mark 带 runId）⇒ 同族历史行一行不动（删它们要 §12.1 点头）
  const declIds = (await prisma.customsDeclaration.findMany({
    where: { OR: [{ declarationNumber: own }, { id: own }] }, select: { id: true },
  })).map(r => r.id);
  // 退税按“挂在本 run 报关单上”+ 自身两条件并着删，防它换了拼写就漏（★ `{in: []}` 不会进来：先判长度）
  if (declIds.length) await prisma.taxRefund.deleteMany({ where: { declarationId: { in: declIds } } });
  await prisma.taxRefund.deleteMany({ where: { OR: [{ id: own }, { refundNumber: own }] } });
  await prisma.customsDeclaration.deleteMany({ where: { OR: [{ declarationNumber: own }, { id: own }] } });
  await prisma.shipment.deleteMany({ where: { OR: [{ id: own }, { shipmentNumber: own }] } });
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
  { key: 'shp', model: 'shipment', run: () => prisma.shipment.count({ where: { OR: [{ id: own }, { shipmentNumber: own }] } }) },
  { key: 'decl', model: 'customsDeclaration', run: () => prisma.customsDeclaration.count({ where: { OR: [{ declarationNumber: own }, { id: own }] } }) },
  { key: 'refund', model: 'taxRefund', run: () => prisma.taxRefund.count({ where: { OR: [{ id: own }, { refundNumber: own }] } }) },
];

async function makeShipment(over: {
  containerNumber?: string | null;
  etd?: string | null;
  portOfDischarge?: string | null;
  customerName?: string;
  totalPackages?: number;
  grossWeight?: number;
  volume?: number;
}) {
  return prisma.shipment.create({
    data: {
      id: ctx.id(`SHP_${n()}`), shipmentNumber: ctx.id(`NO_${n()}`),
      type: 'Export', status: 'Shipped', shippingMethod: 'Sea',
      containerNumber: over.containerNumber === undefined ? C1 : over.containerNumber,
      etd: over.etd === undefined ? '2026-09-20' : over.etd,
      portOfDischarge: over.portOfDischarge === undefined ? 'ROTTERDAM' : over.portOfDischarge,
      vesselOrFlight: 'MSC ANNA', voyageNumber: 'V001',
      customerName: over.customerName ?? 'C1 客户A',
      totalPackages: over.totalPackages ?? 100,
      grossWeight: new Prisma.Decimal(over.grossWeight ?? 1000),
      volume: new Prisma.Decimal(over.volume ?? 20),
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    },
  });
}

async function makeDeclaration(shipmentId: string, totalValue = '50000') {
  return prisma.customsDeclaration.create({
    data: {
      id: ctx.id(`CD_${n()}`), declarationNumber: ctx.id(`DECL-${n()}`),
      shipmentId, type: 'Export', status: 'Released',
      declarationDate: '2026-09-21', totalValue: new Prisma.Decimal(totalValue), currency: 'USD',
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    },
  });
}

async function makeRefund(declarationId: string, refundAmount = '6500') {
  return prisma.taxRefund.create({
    data: {
      id: ctx.id(`TR_${n()}`), refundNumber: ctx.id(`TRNO-${n()}`), declarationId, status: 'Refunded',
      refundAmount: new Prisma.Decimal(refundAmount),
      exportAmountFob: new Prisma.Decimal(100000), exportAmountFobCurrency: 'USD',
      createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    },
  });
}

const groupOf = async (containerNumber: string) => {
  const res = await getContainerConsolidation(prisma);
  return res.containers.find(c => c.containerNumber === containerNumber);
};

describe('★ C1 真库守卫：拼柜聚合（按柜号）', () => {
  beforeAll(async () => { await cleanup(); });

  afterAll(async () => {
    await cleanup();
    const got = await safeResidualCounts(RESIDUAL_SPEC);
    expect(got.unreadable, noBackendMessage(got.unreadable)).toEqual([]);
    expect(got.values, `★ 有残留：${got.dirty.join('；')} ⇒ 本演练建的行没清干净（touched=${JSON.stringify(ctx.touchedModels())}）`)
      .toEqual({ shp: 0, decl: 0, refund: 0 }); // 零残留（自己想起查的那三张）
    /**
     * ★ 壳那一半：① 触碰集合非空（证尺没瞎）；② 触碰过的表按**列无关**口径也不许有本次 run 的行。
     *   缺了这两条，上面那句就只是“我想起查的三张表都干净”——正是 B94/B99/B100 那一族的形状。
     */
    const touched = ctx.touchedModels();
    expect(touched, '本演练建过退税 ⇒ TaxRefund 必须在触碰集合里').toContain('TaxRefund');
    await prisma.$disconnect();
  });

  it('① 同柜两票 → 聚成一个柜，票/客户/件重体合计正确', async () => {
    await makeShipment({ customerName: 'C1 客户A', totalPackages: 100, grossWeight: 1000, volume: 20 });
    await makeShipment({ customerName: 'C1 客户B', totalPackages: 50, grossWeight: 500, volume: 10 });

    const g = await groupOf(C1);
    expect(g).toBeTruthy();
    expect(g!.shipmentCount).toBe(2);
    expect(g!.customerCount).toBe(2);
    expect(g!.totals.totalPackages).toBe(150);
    expect(g!.totals.grossWeight).toBe(1500);
    expect(g!.totals.volume).toBe(30);
    expect(g!.conflicts).toEqual([]); // 同船同港同时离港 → 无矛盾
  });

  it('② 阳性对照：单票柜单独成柜，不算「拼柜」', async () => {
    await makeShipment({ containerNumber: C2, customerName: 'C1 客户C' });
    const g = await groupOf(C2);
    expect(g!.shipmentCount).toBe(1);

    const res = await getContainerConsolidation(prisma);
    // 本演练造的两个柜：C1 是拼柜、C2 不是
    const mine = res.containers.filter(c => [C1, C2].includes(c.containerNumber));
    expect(mine.filter(c => c.shipmentCount > 1).map(c => c.containerNumber)).toEqual([C1]);
  });

  it('③ 报关单 + 退税挂到**本柜**（不串柜）', async () => {
    const res0 = await getContainerConsolidation(prisma);
    const g0 = res0.containers.find(c => c.containerNumber === C1)!;
    const target = g0.shipments[0];

    const decl = await makeDeclaration(target.id, '50000');
    await makeRefund(decl.id, '6500');
    // 另一柜也造一张，验证不串柜
    const g2 = res0.containers.find(c => c.containerNumber === C2)!;
    const decl2 = await makeDeclaration(g2.shipments[0].id, '8000');

    const g1 = (await groupOf(C1))!;
    expect(g1.customsDeclarations.map(d => d.declarationNumber)).toContain(decl.declarationNumber);
    expect(g1.customsDeclarations.map(d => d.declarationNumber)).not.toContain(decl2.declarationNumber);
    expect(g1.taxRefunds).toHaveLength(1);
    expect(g1.taxRefunds[0].refundAmount).toBe(6500);

    const gC2 = (await groupOf(C2))!;
    expect(gC2.customsDeclarations.map(d => d.declarationNumber)).toEqual([decl2.declarationNumber]);
    expect(gC2.taxRefunds).toEqual([]); // 没有退税就空，不串
  });

  it('④ ★ 柜内 ETD/目的港不一致 → 该柜报矛盾，别的柜不受影响', async () => {
    await makeShipment({ etd: '2026-09-27', portOfDischarge: 'HAMBURG', customerName: 'C1 客户D' });

    const g1 = (await groupOf(C1))!;
    const codes = g1.conflicts.map(c => c.code).sort();
    expect(codes).toEqual(['DISCHARGE_PORT_MISMATCH', 'ETD_MISMATCH']);
    // 矛盾消息里带上冲突值与票号（可读、可定位）
    const etdConflict = g1.conflicts.find(c => c.code === 'ETD_MISMATCH')!;
    expect(etdConflict.values).toContain('2026-09-27');
    expect(etdConflict.shipmentNumbers.length).toBeGreaterThanOrEqual(2);

    expect((await groupOf(C2))!.conflicts).toEqual([]); // 不污染别的柜
  });

  it('⑤ 未填柜号的票 → 进 unassigned，不硬塞进任何柜', async () => {
    const loose = await makeShipment({ containerNumber: null, customerName: 'C1 散货' });
    const res = await getContainerConsolidation(prisma);
    expect(res.unassigned.shipments.map(s => s.id)).toContain(loose.id);
    expect(res.unassigned.shipmentCount).toBeGreaterThanOrEqual(1);
    // 反向：没有哪个柜把它算进去
    for (const c of res.containers) {
      expect(c.shipments.map(s => s.id)).not.toContain(loose.id);
    }
  });

  it('⑥ summary 计数自洽', async () => {
    const res = await getContainerConsolidation(prisma);
    const mine = res.containers.filter(c => [C1, C2].includes(c.containerNumber));
    expect(mine).toHaveLength(2);
    expect(res.summary.ticketCount).toBe(
      res.containers.reduce((s, c) => s + c.shipmentCount, 0) + res.unassigned.shipmentCount,
    );
    expect(res.summary.conflictCount).toBe(res.containers.reduce((s, c) => s + c.conflicts.length, 0));
    expect(res.summary.consolidatedCount).toBe(res.containers.filter(c => c.shipmentCount > 1).length);
  });

  it('⑦ 区间过滤走 etd（无 etd 的票在带区间时排除，与准交率/运输方式统计同口径）', async () => {
    const res = await getContainerConsolidation(prisma, { from: '2026-09-25', to: '2026-09-30' });
    const g1 = res.containers.find(c => c.containerNumber === C1);
    // 只有那条 etd=2026-09-27 的票落在区间内
    expect(g1?.shipmentCount).toBe(1);
    expect(g1?.conflicts).toEqual([]); // 单票柜无矛盾
  });
});
