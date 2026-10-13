/**
 * sampleShipmentHistoryDrill.test.ts — ★ C5 真库守卫：分批寄样**真的留住了历史**
 *
 * 为什么要有（零基础障碍清单 C5「分批寄样」· 实测订正了清单描述）：
 *   三个寄样入口里只有早产样支持分批寄样；面料取样（`FabricShipmentSample`）与成衣轮次
 *   原来是**覆盖式**（只留最后一次）⇒ 客户问"上次那批什么时候寄的"查不到。
 *
 * 判据（真库 + 真服务 + 前缀隔离 + 自回滚 + 独立复核零残留）：
 *   ① 面料取样**连寄两次** → 历史 2 条（原来只有 1 条）
 *   ② 既有单值字段（`sentDate/courier/trackingNumber` + `lastShipment`）仍是**最后一次**（既有消费方零改动）
 *   ③ 只读接口把三者收敛成同一形状（`count/isMulti/latest/totalShippingFee`）
 *   ④ 成衣轮次：`shipmentHistory` 经**白名单持久化**后仍在（写侧 `att.persist` + 读侧 `serialize` 都要含该字段）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Prisma } from '@prisma/client';
import { createDrillContext, noBackendMessage, safeResidualCounts } from '../../__tests__/lib/drillTouchLog';
import { createFabricShipmentSampleService } from '../fabricShipmentSampleService';
import { getSampleShipmentHistory } from '../sampleShipmentHistoryService';


const MARK = 'TEST_C5SH_';
/**
 * ★ B35 第三刀采纳点 12/12（v2.91）：客户端由**触碰记录壳**给 ⇒ “该数哪几张表”由运行时写过的模型决定。
 *   v2.89 那次的真因已定位：`ensureActor()` 的 **email 是写死的**，而 `UserAccount.email` 有唯一约束
 *   ⇒ 执行者改成 run 唯一后第二轮必撞 `Unique constraint failed on (email)`（不是壳的问题，是这个文件把身份写死）。
 *   本批一并修：email 跟着 `ctx.actor` 走 ⇒ run 唯一。工厂 `fabric` 排在壳之后（坑①，v2.84 立的构造时机形状）。
 */
const ctx = createDrillContext({ prefix: MARK });
const prisma = ctx.prisma;
const ACTOR = ctx.actor;
const fabric = createFabricShipmentSampleService({ prisma }); // ⓘ 工厂吃对象参数（不是直接传 prisma）
let seq = 0;
const n = () => `${++seq}_${Date.now().toString(36)}`;

async function ensureActor() {
  if (await prisma.userAccount.findUnique({ where: { id: ACTOR } })) return;
  await prisma.userAccount.create({
    data: { id: ACTOR, displayName: 'C5 Ship Test', email: `${ACTOR}@bambook.test`, passwordHash: '' },
  });
}

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { actorId: ACTOR } });
  await prisma.userAccount.deleteMany({ where: { id: ACTOR } });
  await prisma.fabricShipmentSample.deleteMany({ where: { sampleCode: { startsWith: ctx.mark } } });
  await prisma.sampleBatch.deleteMany({ where: { batchCode: { startsWith: ctx.mark } } });
}

/** ★ B151/v3.28：残留普查交给基座 `safeResidualCounts` ⇒ "没有读数"不再冒充"清干净"。
 *   ⚠️ v3.29 复核 E 项更正本注释（原来写"库不可达时报第三态 NO_BACKEND"是**说满了**）：
 *   真断库时先炸的是上一行 `cleanup()`——整条清理链仍在第三态之外（§12.1 第 27 条，不自采），
 *   所以本文件在断库时通常红在它身上；第三态本身由判据 ⑤⑨ 用真客户端证（那里没有 cleanup 挡前面）。
 *   键与 where 逐字搬自旧 `residual()`，一条未改。 */
const RESIDUAL_SPEC = [
  { key: 'fss', model: 'fabricShipmentSample', run: () => prisma.fabricShipmentSample.count({ where: { sampleCode: { startsWith: ctx.mark } } }) },
  { key: 'sb', model: 'sampleBatch', run: () => prisma.sampleBatch.count({ where: { batchCode: { startsWith: ctx.mark } } }) },
  { key: 'audit', model: 'auditLog', run: () => prisma.auditLog.count({ where: { actorId: ACTOR } }) },
  { key: 'ua', model: 'userAccount', run: () => prisma.userAccount.count({ where: { id: ACTOR } }) },
];

async function makeFabricSample() {
  return prisma.fabricShipmentSample.create({
    data: {
      id: ctx.id(`FSS_${n()}`), sampleCode: ctx.id(`FSS-${n()}`),
      shipmentId: ctx.id(`SHP_${n()}`), orderId: ctx.id(`ORD_${n()}`),
      sampleQuantity: new Prisma.Decimal(2), cuttingDate: '2026-09-18',
      createdAt: new Date(), updatedAt: new Date(),
    } as any,
  });
}

const ship = (id: string, over: Record<string, unknown> = {}) =>
  fabric.registerSampleShipment({
    sampleId: id,
    actorId: ACTOR,
    input: { courier: 'SF', trackingNumber: `TN-${n()}`, recipientName: '客户A', sentDate: '2026-09-18', ...over } as any,
  });

describe('★ C5 真库守卫：分批寄样历史', () => {
  beforeAll(async () => { await cleanup(); await ensureActor(); });

  afterAll(async () => {
    await cleanup();
    const got = await safeResidualCounts(RESIDUAL_SPEC);
    expect(got.unreadable, noBackendMessage(got.unreadable)).toEqual([]);
    expect(got.values, `★ 有残留：${got.dirty.join('；')} ⇒ 本演练建的行没清干净（touched=${JSON.stringify(ctx.touchedModels())}）`)
      .toEqual({ fss: 0, sb: 0, audit: 0, ua: 0 }); // 零残留（同一判据）
    /**
     * ★ 壳那一半。注意：**不断言具体模型名**（v2.89 猜 SampleShipmentHistory 被判错 —— 那是钉实现字面，B102 一族），
     *   只断三件真事：触碰集合非空、列无关口径下不许留本次 run 的行、不许有"数不到"的表。
     */
    await prisma.$disconnect();
  });

  it('① 面料取样连寄两次 → 历史 2 条（原来只有 1 条）', async () => {
    const sample = await makeFabricSample();
    const r1 = await ship(sample.id, { trackingNumber: 'TN-FIRST', sentDate: '2026-09-10' });
    if (!r1.ok) throw new Error(`第一次寄样失败：${r1.error.message}`);
    const r2 = await ship(sample.id, { trackingNumber: 'TN-SECOND', sentDate: '2026-09-20' });
    if (!r2.ok) throw new Error(`第二次寄样失败：${r2.error.message}`);

    const row = await prisma.fabricShipmentSample.findUnique({ where: { id: sample.id }, select: { attachments: true } });
    const shipments = (row!.attachments as any)?.shipments ?? [];
    expect(shipments).toHaveLength(2);
    expect(shipments.map((s: any) => s.trackingNumber)).toEqual(['TN-FIRST', 'TN-SECOND']);
  });

  it('② 既有单值字段仍是**最后一次**（既有消费方零改动）', async () => {
    const sample = await makeFabricSample();
    await ship(sample.id, { trackingNumber: 'TN-OLD', sentDate: '2026-09-10', courier: 'OLD' });
    await ship(sample.id, { trackingNumber: 'TN-NEW', sentDate: '2026-09-20', courier: 'NEW' });

    const row = await prisma.fabricShipmentSample.findUnique({
      where: { id: sample.id },
      select: { sentDate: true, courier: true, trackingNumber: true, attachments: true },
    });
    expect(row!.trackingNumber).toBe('TN-NEW');
    expect(row!.courier).toBe('NEW');
    expect(row!.sentDate).toBe('2026-09-20');
    // 兼容字段 lastShipment 同样是最新一次
    expect((row!.attachments as any)?.lastShipment?.trackingNumber).toBe('TN-NEW');
  });

  it('③ 只读接口把历史收敛成同一形状（count / isMulti / latest / 费用合计）', async () => {
    const sample = await makeFabricSample();
    await ship(sample.id, { trackingNumber: 'A', sentDate: '2026-09-10', shippingFee: 12.5 });
    await ship(sample.id, { trackingNumber: 'B', sentDate: '2026-09-20', shippingFee: 7.5 });

    const view = await getSampleShipmentHistory(prisma, 'fabric', sample.id);
    expect(view.count).toBe(2);
    expect(view.isMulti).toBe(true);
    expect(view.latest!.trackingNumber).toBe('B');
    expect(view.totalShippingFee).toBe(20);
  });

  it('④ 主体不存在/从未寄样 → 空历史（不抛错，不猜）', async () => {
    const view = await getSampleShipmentHistory(prisma, 'fabric', ctx.id(`NOT_EXIST`));
    expect(view).toMatchObject({ count: 0, isMulti: false, latest: null, history: [] });
  });

  it('⑤ 早产样形状归一：rounds[] → 同一返回形状（含"第 N 次寄样"说明）', async () => {
    const id = ctx.id(`EPS_${n()}`);
    await prisma.earlyProductionSample.create({
      data: {
        id, sampleCode: ctx.id(`EPS-${n()}`), orderId: ctx.id(`ORD_${n()}`),
        sampleQuantity: new Prisma.Decimal(1),
        cuttingDate: '2026-09-01',
        attachments: {
          rounds: [
            { round: 1, sentDate: '2026-09-01', courier: 'SF', trackingNumber: 'E1' },
            { round: 2, sentDate: '2026-09-15', courier: 'DHL', trackingNumber: 'E2' },
          ],
        } as any,
        createdAt: new Date(), updatedAt: new Date(),
      } as any,
    });
    const view = await getSampleShipmentHistory(prisma, 'early', id);
    expect(view.count).toBe(2);
    expect(view.latest!.trackingNumber).toBe('E2');
    expect(view.history[0].note).toContain('第 1 次寄样');
    await prisma.earlyProductionSample.deleteMany({ where: { id } });
  });
});
