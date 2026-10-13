/**
 * shipmentScheduleHistoryDrill.test.ts — ★ D5 真库守卫：甩柜/改船期**真的留下痕迹**
 *
 * 为什么要有这个测试（零基础障碍清单 D5 · 实测比描述更广）：
 *   `updateShipment` 的审计 before/after **只写了 status + shipmentNumber**
 *   ⇒ 改 ETD/ETA（甩柜、改船期）、改船名航次、改装卸港、改柜号封条 —— **全都查不到改了什么**。
 *   而甩柜/改船期正是面料外贸最高频的异常（船公司通知改期 → 运单/报关/单证/客户全要跟着改）。
 *
 * 判据（真库 + 真服务 + 前缀隔离 + 自回滚 + 独立复核零残留）：
 *   ① 改 ETD → 字段级审计落库；`getShipmentScheduleHistory` 能还原 from/to + 中文描述
 *   ② 一次改 ETD+船名+航次 → **3 条**（甩柜常同时改这三样），共享同一 transactionId
 *   ③ ★ 阳性对照：同值 PATCH → **不落痕**（否则审计被噪音淹没）
 *   ④ 清空字段（'' → null）→ 落痕且描述显示「—」（不是 null 字面量）
 *   ⑤ `datesOnly` 只返回日期类字段（回答「被甩了几次柜」）
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createDrillContext, noBackendMessage, safeResidualCounts } from '../../__tests__/lib/drillTouchLog';
import { createShipment, updateShipment } from '../shipmentMutationService';
import { getShipmentScheduleHistory, getShipmentRescheduleHistory } from '../shipmentScheduleHistoryService';

const MARK = 'TEST_D5SCH_';
/**
 * ★ B35 第三刀采纳点 6/12（v2.82）：客户端由**触碰记录壳**给 ⇒ 该数哪几张表由运行时写过的模型决定。
 *   本文件原来只数 `shp / audit` 两项，而 `shipmentEvent` / `shipmentOrderAllocation` 只在 `cleanup()` 里出现、
 *   **从不被断言** ⇒ 清没清干净没人知道（B94 的形状）。id 仍在 `TEST_D5SCH_` 族内 ⇒ 认领口径不换。
 */
const ctx = createDrillContext({ prefix: MARK });
const prisma = ctx.prisma;
const ACTOR = ctx.actor;

let seq = 0;
const n = () => `${++seq}_${Date.now().toString(36)}`;

async function ensureActor() {
  if (await prisma.userAccount.findUnique({ where: { id: ACTOR } })) return;
  await prisma.userAccount.create({
    data: { id: ACTOR, displayName: 'D5 Schedule Test', email: `${ACTOR}@bambook.test`, passwordHash: '' },
  });
}

async function cleanup() {
  // ★ 收窄为**只删本次 run**（ctx.mark 含 runId）⇒ 别轮/历史行不动（删它们要 §12.1 点头）
  await prisma.auditLog.deleteMany({ where: { actorId: ACTOR } });
  await prisma.shipmentOrderAllocation.deleteMany({ where: { shipmentId: own } });
  await prisma.shipmentEvent.deleteMany({ where: { shipmentId: own } });
  await prisma.shipment.deleteMany({ where: { OR: [{ id: own }, { shipmentNumber: own }] } });
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
  { key: 'shp', model: 'shipment', run: () => prisma.shipment.count({ where: { OR: [{ id: own }, { shipmentNumber: own }] } }) },
  { key: 'audit', model: 'auditLog', run: () => prisma.auditLog.count({ where: { actorId: ACTOR } }) },
  { key: 'evt', model: 'shipmentEvent', run: () => prisma.shipmentEvent.count({ where: { shipmentId: own } }) },
  { key: 'alloc', model: 'shipmentOrderAllocation', run: () => prisma.shipmentOrderAllocation.count({ where: { shipmentId: own } }) },
  { key: 'ua', model: 'userAccount', run: () => prisma.userAccount.count({ where: { id: ACTOR } }) },
];

async function makeShipment(over: Record<string, unknown> = {}) {
  const id = ctx.id(`SHP_${n()}`);
  const r = await createShipment({
    prisma: prisma as any,
    input: {
      id, type: 'Export', status: 'Booked', shippingMethod: 'Sea',
      etd: '2026-09-20',
      vesselOrFlight: 'MSC ANNA', voyageNumber: 'V001',
      portOfLoading: 'SHANGHAI', portOfDischarge: 'ROTTERDAM',
      ...over,
    } as any,
    actorId: ACTOR,
    generateIdIfMissing: true,
  });
  if (!r.ok) throw new Error(`预置运单失败：${JSON.stringify(r.error)}`);
  return r.data!.shipment;
}

const patch = (shipmentId: string, data: Record<string, unknown>) =>
  updateShipment({ prisma: prisma as any, shipmentId, patch: data as any, hasStatus: false, actorId: ACTOR });

describe('★ D5 真库守卫：改期/物流变更留痕', () => {
  beforeEach(async () => { await cleanup(); await ensureActor(); });

  afterAll(async () => {
    await cleanup();
    const got = await safeResidualCounts(RESIDUAL_SPEC);
    expect(got.unreadable, noBackendMessage(got.unreadable)).toEqual([]);
    expect(got.values, `★ 有残留：${got.dirty.join('；')} ⇒ 本演练建的行没清干净（touched=${JSON.stringify(ctx.touchedModels())}）`)
      .toEqual({ shp: 0, audit: 0, evt: 0, alloc: 0, ua: 0 }); // 零残留（含原来只在 cleanup 出现、从不被断言的两张表）
    /** ★ 壳那一半：触碰集合非空 + 列无关 dirty=[] + 不许有数不到的表 */
    const touched = ctx.touchedModels();
    expect(touched, '运单是本演练的主对象 ⇒ Shipment 必须在触碰集合里').toContain('Shipment');
    await prisma.$disconnect();
  });

  it('① 改 ETD → 能还原「改成什么、谁改的」', async () => {
    const sh = await makeShipment();
    const r = await patch(sh.id, { etd: '2026-09-27' });
    if (!r.ok) throw new Error(`改期失败：${JSON.stringify(r.error)}`);

    const hist = await getShipmentScheduleHistory(prisma, sh.id);
    const etdRow = hist.changes.find(c => c.field === 'etd');
    expect(etdRow).toBeTruthy();
    expect(etdRow!.fromValue).toBe('2026-09-20');
    expect(etdRow!.toValue).toBe('2026-09-27');
    expect(etdRow!.actorId).toBe(ACTOR);
    expect(etdRow!.description).toBe('预计离港(ETD) 2026-09-20 → 2026-09-27');
  });

  it('② 甩柜同时改 ETD+船名+航次 → 3 条，共享同一 transactionId', async () => {
    const sh = await makeShipment();
    await patch(sh.id, { etd: '2026-09-27', vesselOrFlight: 'MSC BOB', voyageNumber: 'V002' });

    const hist = await getShipmentScheduleHistory(prisma, sh.id);
    const fields = hist.changes.map(c => c.field).sort();
    expect(fields).toEqual(['etd', 'vesselOrFlight', 'voyageNumber']);
    // 同一业务操作可串联（便于 UI 归组成「一次改期」）
    const txIds = new Set(hist.changes.map(c => c.transactionId));
    expect(txIds.size).toBe(1);
    expect([...txIds][0]).toBeTruthy();
  });

  it('③ ★ 阳性对照：同值 PATCH → 不落痕（审计不被噪音淹没）', async () => {
    const sh = await makeShipment();
    const before = await prisma.auditLog.count({ where: { actorId: ACTOR, targetId: sh.id } });

    const r = await patch(sh.id, { etd: '2026-09-20', vesselOrFlight: 'MSC ANNA' }); // 与现值完全相同
    expect(r.ok).toBe(true);

    const hist = await getShipmentScheduleHistory(prisma, sh.id);
    expect(hist.changes).toEqual([]); // 没有任何字段级留痕
    // 汇总审计仍会写 1 条（那是「有人 PATCH 过」的事实，与「字段变没变」是两件事）
    expect(await prisma.auditLog.count({ where: { actorId: ACTOR, targetId: sh.id } })).toBe(before + 1);
  });

  it('④ 清空字段（\'\' → null 归一）→ 落痕且描述显示「—」', async () => {
    const sh = await makeShipment();
    await patch(sh.id, { sealNumber: 'SEAL-9' });
    await patch(sh.id, { sealNumber: '' }); // 表单清空常见写法

    const hist = await getShipmentScheduleHistory(prisma, sh.id);
    const sealRows = hist.changes.filter(c => c.field === 'sealNumber');
    // 第一次 SEAL-9 是「新增」（null → SEAL-9），第二次是清空（SEAL-9 → null）
    expect(sealRows.length).toBe(2);
    expect(sealRows[0].toValue).toBeNull();
    expect(sealRows[0].description).toBe('封条号 SEAL-9 → —'); // 不把 null 字面量摆到界面上
  });

  it('⑤ datesOnly 只返回日期类字段（回答「被甩了几次柜」）', async () => {
    const sh = await makeShipment();
    await patch(sh.id, { etd: '2026-09-27', vesselOrFlight: 'MSC BOB' });
    await patch(sh.id, { bookingDate: '2026-09-18' });

    const all = await getShipmentScheduleHistory(prisma, sh.id);
    expect(all.changes.length).toBe(3);

    const datesOnly = await getShipmentRescheduleHistory(prisma, sh.id);
    expect(datesOnly.changes.map(c => c.field).sort()).toEqual(['bookingDate', 'etd']);
    expect(datesOnly.count).toBe(2);
  });
});
