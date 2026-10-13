/**
 * shortShipmentGate 测试（2026-09-29 晚）
 *
 * 判据取向（照本仓惯例）：每条都写成"如果实现偷懒，这条就会红"。
 *   · 分批出运时**不判**（最容易被写错的一条 —— 写成"每次分配都判下界"就会误拦第一票）
 *   · 公差百分比必须走**标准链**（客户 P0 / 出厂默认），不许硬编码 5%
 *   · 拦截抛出的码必须是**注册表里的**那个（`ORDER_LINE_SHORT_SHIPPED` / 409）
 *   · 放行后必须把 `ShipmentOrderAllocation.status` 写成 `ShortShipped`（那个死状态要接上）
 *   ★ 真库段跑完要**零残留**（本仓惯例：自己造的数据自己清干净，并断言清干净了）
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createDrillContext, residualFailureMessage } from '../../__tests__/lib/drillTouchLog';
import { createAllocationService } from '../allocationService';
import {
  ACTUAL_QTY_MISSING_CODE,
  NO_ALLOCATION_DETAIL_CODE,
  SHORT_SHIP_APPROVAL_ACTION,
  SHORT_SHIP_BLOCKED_CODE,
  actualQtyMissingError,
  buildActualQtyMissingMessage,
  buildShortShipBlockedMessage,
  decideShortShipment,
  evaluateShortShipment,
  markAllocationsShortShipped,
  noAllocationDetailError,
  shortShipBlockedError,
} from '../shortShipmentGate';
import { httpStatusOfCode } from '../../shared/errorCodes';

// ══════════════════════════════════════════════════════════════════
// 一、纯判定（无 DB）
// ══════════════════════════════════════════════════════════════════

describe('decideShortShipment — 短装判定的**唯一口径**', () => {
  it('★★ 还有未发运的票 ⇒ **不判**（哪怕是 −50%）—— 这条防的是"误拦分批发货第一票"', () => {
    const d = decideShortShipment({ contractQty: 10000, shippedQty: 5000, tolerancePct: 5, hasRemainingUnshipped: true });
    expect(d.kind).toBe('not_closed');
    expect(d.shortage).toBe(0);
  });

  it('★ 已收尾 + 少发 ⇒ 拦，且算清"还少多少"', () => {
    // 合同 10000、出厂默认 5001+ 档 ⇒ ±1% ⇒ 下限 9900
    const d = decideShortShipment({ contractQty: 10000, shippedQty: 9000, tolerancePct: 1, hasRemainingUnshipped: false });
    expect(d.kind).toBe('blocked');
    expect(d.allowedMin).toBe(9900);
    expect(d.shortage).toBe(900);
  });

  it('★ 已收尾 + 刚好到下限 ⇒ 通过（边界是「含」）', () => {
    const d = decideShortShipment({ contractQty: 10000, shippedQty: 9900, tolerancePct: 1, hasRemainingUnshipped: false });
    expect(d.kind).toBe('ok');
    expect(d.allowedMin).toBe(9900);
  });

  it('★★ 浮点边界不许误拦：下限 −0.0000001 仍算通过', () => {
    const d = decideShortShipment({ contractQty: 10000, shippedQty: 9899.9999999, tolerancePct: 1, hasRemainingUnshipped: false });
    expect(d.kind, 'Decimal 折数后的 1e-12 误差不该判成短装').toBe('ok');
  });

  it('★ 容差为 0（未判定/硬顶）⇒ 下限就是合同量，少 1 也拦', () => {
    const d = decideShortShipment({ contractQty: 1000, shippedQty: 999, tolerancePct: 0, hasRemainingUnshipped: false });
    expect(d.kind).toBe('blocked');
    expect(d.allowedMin).toBe(1000);
    expect(d.shortage).toBe(1);
  });

  it('★ 非法/负数容差按 0 处理（不许因为脏参数放行）', () => {
    const a = decideShortShipment({ contractQty: 1000, shippedQty: 999, tolerancePct: Number.NaN, hasRemainingUnshipped: false });
    const b = decideShortShipment({ contractQty: 1000, shippedQty: 999, tolerancePct: -5, hasRemainingUnshipped: false });
    expect(a.kind).toBe('blocked');
    expect(b.kind).toBe('blocked');
  });

  it('★ 合同量非法（0/NaN）⇒ 不判（"未设置不校验"的既有原意）', () => {
    expect(decideShortShipment({ contractQty: 0, shippedQty: 0, tolerancePct: 5, hasRemainingUnshipped: false }).kind).toBe('not_closed');
    expect(decideShortShipment({ contractQty: Number.NaN, shippedQty: 0, tolerancePct: 5, hasRemainingUnshipped: false }).kind).toBe('not_closed');
  });

  it('★ 错误文案要给全：少了多少 / 下限是多少 / 下一步', () => {
    const msg = buildShortShipBlockedMessage([{
      orderLineId: 'L1', orderId: 'O1', itemNo: '001', unit: 'M',
      contractQty: 10000, shippedQty: 9000, allowedMin: 9900, shortage: 900,
      tolerancePct: 1, toleranceSource: 'internal_default', notices: [],
    }]);
    expect(msg).toContain('还少 900 M');
    expect(msg).toContain('下限 9900 M');
    expect(msg).toContain('客户同意少发');
  });

  it('★★ 抛出的码必须是注册表里的那个（409），不是本地写的数字', () => {
    const err: any = shortShipBlockedError([{
      orderLineId: 'L1', orderId: 'O1', itemNo: null, unit: null,
      contractQty: 1, shippedQty: 0, allowedMin: 1, shortage: 1,
      tolerancePct: 0, toleranceSource: 'none', notices: [],
    }], 'x');
    expect(err.code).toBe(SHORT_SHIP_BLOCKED_CODE);
    expect(err.statusCode).toBe(httpStatusOfCode(SHORT_SHIP_BLOCKED_CODE));
    expect(err.statusCode).toBe(409);
    expect(err.shortShipDetails.blocked).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════
// 二、收集（桩 tx，不连库）
// ══════════════════════════════════════════════════════════════════

describe('evaluateShortShipment — 收集本票涉及的行（桩）', () => {
  /**
   * 最小桩：只实现门禁用到的四个模型方法。
   * ⓘ `allocs` 必须带 `actualQty`：`null` = **数量没录**（⇒ 拦在"先填数量"），
   *   `0` = 录了、确实没发（⇒ 才轮到短装判定）。这两个语义混掉，本文件后半段就没意义了。
   */
  function stubTx(opts: {
    allocs: Array<{ orderLineId: string | null; shipmentId: string; actualQty?: unknown }>;
    line: any;
    order?: any;
    lineShipments: Array<{ id: string; status: string; deletedAt?: any }>;
    approved?: { id: string } | null;
  }) {
    return {
      shipmentOrderAllocation: {
        findMany: async (args: any) =>
          args?.where?.orderLineId
            ? opts.lineShipments.map((s) => ({ shipmentId: s.id }))
            : opts.allocs,
      },
      shipment: { findMany: async () => opts.lineShipments.map((s) => ({ id: s.id, status: s.status })) },
      orderLine: { findUnique: async () => opts.line },
      order: { findUnique: async () => opts.order ?? { customerRelationId: null } },
      systemConfig: { findUnique: async () => null },   // ⇒ 落出厂默认
      relation: { findUnique: async () => null },
      approvalRequest: { findFirst: async () => opts.approved ?? null },
    } as any;
  }

  const line = {
    id: 'L1', orderId: 'O1', itemNo: '001', unit: 'M', quantity: 10000,
    shipmentQuantity: 9000, tolerancePercent: null, toleranceSource: null,
  };

  it('★★ 该行还有别的未发运票 ⇒ 一行都不判', async () => {
    const ev = await evaluateShortShipment(stubTx({
      allocs: [{ orderLineId: 'L1', shipmentId: 'S1', actualQty: 9000 }],
      line,
      lineShipments: [
        { id: 'S1', status: 'Draft' },      // 本票
        { id: 'S2', status: 'Booked' },     // ★ 还有后续
      ],
    }), { shipmentId: 'S1' });
    expect(ev.blocked).toHaveLength(0);
    expect(ev.judgedLines, 'judgedLines=0 = 没得判（区别于"判了但没人被拦"）').toBe(0);
  });

  it('★ 判过但通过 ⇒ judgedLines=1 而 blocked=0（证明门禁确实跑了，不是静默跳过）', async () => {
    const ev = await evaluateShortShipment(stubTx({
      allocs: [{ orderLineId: 'L1', shipmentId: 'S1', actualQty: 9950 }],
      line: { ...line, shipmentQuantity: 9950 },       // 10000 落 ±1% ⇒ 下限 9900
      lineShipments: [{ id: 'S1', status: 'Booked' }],
    }), { shipmentId: 'S1' });
    expect(ev.blocked).toHaveLength(0);
    expect(ev.judgedLines, '★ 若这里也是 0，就分不清"门禁没跑"和"跑了但通过"').toBe(1);
  });

  it('★★ 该行已收尾且少发（无批准）⇒ 拦，并带上限/来源/差额', async () => {
    const ev = await evaluateShortShipment(stubTx({
      allocs: [{ orderLineId: 'L1', shipmentId: 'S1', actualQty: 9000 }],
      line,
      lineShipments: [{ id: 'S1', status: 'Booked' }], // 本票是唯一一票 ⇒ 收尾
    }), { shipmentId: 'S1' });
    expect(ev.blocked).toHaveLength(1);
    expect(ev.blocked[0].allowedMin, '10000 米落出厂默认 5001+ 档 ⇒ ±1%').toBe(9900);
    expect(ev.blocked[0].shortage).toBe(900);
    expect(ev.blocked[0].toleranceSource).toBe('internal_default');
    expect(ev.blocked[0].notices.join('')).toContain('出厂默认');
  });

  it('★★ 已批准的短装放行单 ⇒ 进 approved 组（放行但仍要写 ShortShipped 留痕）', async () => {
    const ev = await evaluateShortShipment(stubTx({
      allocs: [{ orderLineId: 'L1', shipmentId: 'S1', actualQty: 9000 }],
      line,
      lineShipments: [{ id: 'S1', status: 'Booked' }],
      approved: { id: 'ar_ok_1' },
    }), { shipmentId: 'S1' });
    expect(ev.blocked).toHaveLength(0);
    expect(ev.approved).toHaveLength(1);
    expect(ev.approved[0].approvalRequestId).toBe('ar_ok_1');
  });

  it('★ 本票没有分配 ⇒ 一行都不判，且**能被识别出来**（不是"静默跳过"）', async () => {
    const ev = await evaluateShortShipment(stubTx({
      allocs: [], line, lineShipments: [],
    }), { shipmentId: 'S1' });
    expect(ev.judgedLines).toBe(0);
    expect(ev.blocked).toHaveLength(0);
    expect(ev.noAllocationDetail, '★ 零明细必须能被识别出来 —— 否则"不知道发了什么"会被静默放行').toBe(true);
  });

  // ── ★★ 下面是"事实还不清楚"的两条（使用方 2026-09-29 晚：不知道数量就能出运 = 巨大缺口）──

  it('★★ 明细里 actualQty 为**空** ⇒ unfilled（先填数量），且不进 blocked（不许走审批）', async () => {
    const ev = await evaluateShortShipment(stubTx({
      allocs: [{ orderLineId: 'L1', shipmentId: 'S1', actualQty: null }],
      line,
      lineShipments: [{ id: 'S1', status: 'Booked' }],
    }), { shipmentId: 'S1' });
    expect(ev.unfilled, '数量没录 = 事实不清楚 ⇒ 先填数量').toHaveLength(1);
    expect(ev.unfilled[0].orderLineId).toBe('L1');
    expect(ev.unfilled[0].unfilledCount).toBe(1);
    expect(ev.blocked, '★ 它不是"少发"，不许让审批单把它放过去').toHaveLength(0);
    expect(ev.judgedLines, '没录数量 ⇒ 判不了短装').toBe(0);
  });

  it('★★ 区分 null 与 0：`actualQty=0` 是"录了、确实没发" ⇒ 走短装判定（不是"未填"）', async () => {
    const ev = await evaluateShortShipment(stubTx({
      allocs: [{ orderLineId: 'L1', shipmentId: 'S1', actualQty: 0 }],
      line: { ...line, shipmentQuantity: 0 },
      lineShipments: [{ id: 'S1', status: 'Booked' }],
    }), { shipmentId: 'S1' });
    expect(ev.unfilled, '0 是填过的值，不能当成"没填"').toHaveLength(0);
    expect(ev.blocked, '填了 0 又确实少发 ⇒ 这才该走"客户同意少发"的审批').toHaveLength(1);
    expect(ev.blocked[0].shippedQty).toBe(0);
  });

  it('★ 明细缺失的文案要点名哪几行 + 下一步（不许只说"不允许"）', () => {
    const msg = buildActualQtyMissingMessage([{
      orderLineId: 'L9', orderId: 'O1', itemNo: '007', unfilledCount: 2, allocationCount: 3,
    }]);
    expect(msg).toContain('行 007');
    expect(msg).toContain('2/3');
    expect(msg).toContain('清单');
    expect(msg, '必须说清这不是"客户同意"能解决的').toContain('不能用审批单放行');
  });

  it('★★ 两枚新码都必须是注册表里的（409），不是本地写的数字', () => {
    const a: any = actualQtyMissingError([{ orderLineId: 'L1', orderId: 'O1', itemNo: null, unfilledCount: 1, allocationCount: 1 }]);
    const b: any = noAllocationDetailError();
    expect(a.code).toBe(ACTUAL_QTY_MISSING_CODE);
    expect(b.code).toBe(NO_ALLOCATION_DETAIL_CODE);
    for (const e of [a, b]) {
      expect(e.statusCode).toBe(httpStatusOfCode(e.code));
      expect(e.statusCode, '业务规则阻断 = 409（不是 500、不是 400）').toBe(409);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
// 三、真库：端到端（造数 → 判定 → 写 ShortShipped → 零残留）
// ══════════════════════════════════════════════════════════════════

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * ★★ 接壳（B35/B111 那一族的要求：**新的写库演练必须接壳**）。
 *
 * 为什么必须（我第一版是"自己造前缀 + 自己清"，被两条门禁当场咬住）：
 *   ① `drill-adoption-ratchet` 的宽尺：带 `TEST_` 演练标记却未接壳的演练**当场红**（基线 3 份、按文件名钉死）；
 *   ② `drill-cleanup-scope`：我的清理判据里写了 `id: { startsWith: 'SHPA__' }` ——
 *      `SHPA__` 是**服务生成的分配 id 命名空间**，不是本演练的命名空间
 *      ⇒ "拿别人的命名空间当删除条件"（B111/B113 同型；那几份被钉在宽尺里等使用方知悉，我这**新**的一份不该再犯）。
 *
 * 壳带来的实质收益（不是形式）：
 *   · `ctx.mark` = `TEST_SHORTSHIP_<runId>_` ⇒ **本轮唯一**（写死前缀会让"下一轮删不到上一轮"，B117）；
 *   · `ctx.actor` = run 唯一的执行者（写死执行者会让"按标记对撞残留"对它天生失明）；
 *   · `ctx.residual()` 收尾按**运行时真正触碰过的表**对撞残留 ⇒ 少算一张表会红，而不是靠人手列清单；
 *   · 文件级断言由壳挂（v3.01 起），本文件不必自己抄一遍。
 * ★ 本文件的行 id 一律由 `P`（= `ctx.mark`）拼出 ⇒ 删/数两侧同源，天然只碰本轮的行。
 */
const ctx = createDrillContext({ prefix: 'TEST_SHORTSHIP_' });
const prisma = ctx.prisma;
const svc = createAllocationService(prisma);
/** ★ 本轮唯一的行标记（不再手写常量；`P + 'E2E1'` 这种拼法保持不变） */
const P = ctx.mark;
/** ★ run 唯一的执行者（id 与 email 都随它走 —— 写死会在第二轮撞 email 唯一约束） */
const ACTOR = ctx.actor;

async function cleanup() {
  // ★ 只按**本演练的**命名空间与执行者删（`orderId` 是本文件造的 ⇒ 天然只圈本轮的行）
  await prisma.shipmentOrderAllocation.deleteMany({ where: { orderId: { startsWith: P } } });
  await prisma.approvalRequest.deleteMany({ where: { requesterId: ACTOR } });
  await prisma.auditLog.deleteMany({ where: { actorId: ACTOR } });
  await prisma.shipment.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.orderLine.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.order.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.userAccount.deleteMany({ where: { id: ACTOR } });
}

async function ensureActor() {
  const found = await prisma.userAccount.findUnique({ where: { id: ACTOR } });
  if (found) return found;
  return prisma.userAccount.create({
    data: { id: ACTOR, displayName: 'Test 短装 Actor', email: 'test-shortship@bambook.test', passwordHash: '' },
  });
}

async function makeOrderWithLine(id: string, quantity: number) {
  await prisma.order.create({
    data: {
      id: P + id, customer: P + 'CUST_' + id, product: 'TEST', type: 'Garment', quantity,
      status: 'Confirmed', dueDate: '2026-12-31', quoteAmount: 10000, updatedAt: BigInt(Date.now()),
    },
  });
  return prisma.orderLine.create({
    data: { id: P + 'L_' + id, orderId: P + id, lineNumber: 1, quantity, unit: 'M' },
  });
}

async function makeShipment(id: string, status = 'Draft') {
  return prisma.shipment.create({
    data: {
      id: P + id, shipmentNumber: 'TEST-SS-' + id, type: 'Export', status,
      shippingMethod: 'Sea', createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    },
  });
}

describe('短装门禁 — 真库端到端', () => {
  beforeEach(async () => {
    await cleanup();
    await ensureActor();
  });

  afterAll(async () => {
    await cleanup();
    /**
     * ★ 收尾对撞交给壳：口径 = **本次运行真正写过的每一张表** × （本轮行标记 + 执行者）。
     *   · `failed` 非空 ⇒ 某些表**没数成**（= "零残留"这句话没有内容），与"数过且为 0"是两件事；
     *   · `dirty` 非空 ⇒ 真有残留，且红话会点名是哪张表、几行、是否挂在真用户名下。
     *   ⓘ 这比自己列七个前缀查询强：本文件新加一张表的写入时，**这里会自动跟着数**（B112 就是靠这个抓到的）。
     */
    const r = await ctx.residual();
    expect(r.failed, '残留查询失败的模型不许当零残留').toEqual([]);
    expect(r.dirty, residualFailureMessage({ dirty: r.dirty, touched: ctx.touchedModels() })).toEqual([]);
    // ★ 壳的 prisma 由本文件创建 ⇒ 仍由本文件关闭
    await ctx.prisma.$disconnect();
  });

  it('★★ 单票 9000 / 合同 10000 ⇒ 收尾即拦（并把 ShortShipped 留给放行那一步）', async () => {
    const line = await makeOrderWithLine('E2E1', 10000);
    const sh = await makeShipment('E2E1');
    // ★ 走 allocationService 建分配 ⇒ 顺带把 OrderLine.shipmentQuantity 快照刷新成真源口径
    const r = await svc.createAllocation(sh.id, { orderId: P + 'E2E1', orderLineId: line.id, actualQty: 9000 }, ACTOR);
    // ⓘ 别用 JSON.stringify(r) 打诊断：分配结果里有 BigInt，会抛 TypeError（本仓踩过同一坑）
    expect(r.ok, r.ok ? '' : `createAllocation 失败：${r.error?.code} ${r.error?.message}`).toBe(true);
    const fresh = await prisma.orderLine.findUnique({ where: { id: line.id } });
    expect(Number(fresh!.shipmentQuantity), '已发量快照必须被真源刷新').toBe(9000);

    const ev = await evaluateShortShipment(prisma, { shipmentId: sh.id });
    expect(ev.blocked).toHaveLength(1);
    expect(ev.blocked[0].shortage).toBe(900);
    expect(ev.approved).toHaveLength(0);
  });

  it('★★ 分批发货：第一票少发**不拦**，最后一票把量补齐才判收尾', async () => {
    const line = await makeOrderWithLine('E2E2', 10000);
    const s1 = await makeShipment('E2E2A');
    const s2 = await makeShipment('E2E2B');
    await svc.createAllocation(s1.id, { orderId: P + 'E2E2', orderLineId: line.id, actualQty: 3000 }, ACTOR);
    await svc.createAllocation(s2.id, { orderId: P + 'E2E2', orderLineId: line.id, plannedQty: 7000 }, ACTOR);

    // 第一票：还有 s2 这票没发 ⇒ 不判
    const ev1 = await evaluateShortShipment(prisma, { shipmentId: s1.id });
    expect(ev1.judgedLines, '★ 分批第一票绝不能被判短装').toBe(0);

    // ⓘ 第一票**先真的发出去**（`Booked` 不算已发运 ⇒ 不置 Shipped 的话，判最后一票时
    //    它仍会被当成"还有未发运的票"，门禁继续不判 —— 这是对的，是本用例原来的期望写错了）
    await prisma.shipment.update({ where: { id: s1.id }, data: { status: 'Shipped' } });

    // ★★ 此刻最后一票的**实际量还没填**（只录了计划 7000）⇒ 拦在"先填数量"上，不是拦在"少发"上
    const evMid = await evaluateShortShipment(prisma, { shipmentId: s2.id });
    expect(evMid.unfilled, '只录计划量、没录实际量 ⇒ 事实不清楚').toHaveLength(1);
    expect(evMid.blocked, '★ 不许把它算成短装（那会让人去跟客户道歉，其实只是没填数）').toHaveLength(0);
    expect(evMid.judgedLines).toBe(0);

    // 最后一票（把 actualQty 补成 7000 ⇒ 累计 10000）⇒ 通过
    await prisma.shipmentOrderAllocation.updateMany({
      where: { shipmentId: s2.id, orderLineId: line.id },
      data: { actualQty: 7000 },
    });
    await prisma.orderLine.update({ where: { id: line.id }, data: { shipmentQuantity: 10000 } });
    const ev2 = await evaluateShortShipment(prisma, { shipmentId: s2.id });
    expect(ev2.blocked).toHaveLength(0);
    expect(ev2.unfilled).toHaveLength(0);
    expect(ev2.judgedLines, '★ 最后一票**确实判了**（判成通过）—— 这是「收尾时才判」的正面对照').toBe(1);
  });

  it('★★ 一张一条明细都没有的票 ⇒ noAllocationDetail（"不知道发了什么"不许出运）', async () => {
    const sh = await makeShipment('E2E5');
    const ev = await evaluateShortShipment(prisma, { shipmentId: sh.id });
    expect(ev.noAllocationDetail, '★ 零明细的票必须被识别出来').toBe(true);
    expect(ev.blocked).toHaveLength(0);
  });

  it('★★ 只录计划量（actualQty 空）⇒ unfilled；补齐实际量后同一张票立刻能判', async () => {
    const line = await makeOrderWithLine('E2E6', 10000);
    const sh = await makeShipment('E2E6');
    await svc.createAllocation(sh.id, { orderId: P + 'E2E6', orderLineId: line.id, plannedQty: 10000 }, ACTOR);

    const before = await evaluateShortShipment(prisma, { shipmentId: sh.id });
    expect(before.unfilled, '只有计划量 ⇒ 该行被判为"数量没录"').toHaveLength(1);
    expect(before.unfilled[0].unfilledCount).toBe(1);
    expect(before.unfilled[0].allocationCount).toBe(1);

    // 补齐实际量（10000 ⇒ 100% ⇒ 不少于下限）⇒ 同一张票、同一条明细，立刻能判且通过
    await prisma.shipmentOrderAllocation.updateMany({
      where: { shipmentId: sh.id, orderLineId: line.id }, data: { actualQty: 10000 },
    });
    await prisma.orderLine.update({ where: { id: line.id }, data: { shipmentQuantity: 10000 } });
    const after = await evaluateShortShipment(prisma, { shipmentId: sh.id });
    expect(after.unfilled, '填上数量后就不该再报"没填"').toHaveLength(0);
    expect(after.blocked).toHaveLength(0);
    expect(after.judgedLines).toBe(1);
  });

  it('★★ 批准后放行：写 ShortShipped + exception（把那死状态接上）', async () => {
    const line = await makeOrderWithLine('E2E3', 10000);
    const sh = await makeShipment('E2E3');
    await svc.createAllocation(sh.id, { orderId: P + 'E2E3', orderLineId: line.id, actualQty: 9000 }, ACTOR);
    await prisma.approvalRequest.create({
      data: {
        id: P + 'AR1', requesterId: ACTOR, actionType: SHORT_SHIP_APPROVAL_ACTION,
        targetType: 'OrderLine', targetId: line.id, status: 'approved',
        risk: 'high', payload: { policyKey: 'short_ship_exemption' },
      },
    });

    const ev = await evaluateShortShipment(prisma, { shipmentId: sh.id });
    expect(ev.blocked).toHaveLength(0);
    expect(ev.approved).toHaveLength(1);

    const n = await markAllocationsShortShipped(prisma, { shipmentId: sh.id, cases: ev.approved, actorId: ACTOR });
    expect(n, '至少写到 1 条分配上').toBeGreaterThanOrEqual(1);
    const alloc = await prisma.shipmentOrderAllocation.findFirst({ where: { shipmentId: sh.id, orderLineId: line.id } });
    expect(alloc!.status, '★ 这个状态在本批之前全仓无人写入').toBe('ShortShipped');
    expect(String(alloc!.exception)).toContain('客户同意少发');
    expect(String(alloc!.exception)).toContain(P + 'AR1');
  });

  it('★ 收尾且发够 ⇒ 不拦（反面对照，证明不是"一律拦"）', async () => {
    const line = await makeOrderWithLine('E2E4', 1000);
    const sh = await makeShipment('E2E4');
    await svc.createAllocation(sh.id, { orderId: P + 'E2E4', orderLineId: line.id, actualQty: 970 }, ACTOR);
    const ev = await evaluateShortShipment(prisma, { shipmentId: sh.id });
    expect(ev.blocked).toHaveLength(0);
    expect(ev.judgedLines, '发够了也算判过（别用 judgedLines 当"有没有被拦"）').toBe(1);
    // 反面对照：少 1 米就该拦（1000 落 1000–3000 档 ⇒ ±3% ⇒ 下限 970）
    await prisma.orderLine.update({ where: { id: line.id }, data: { shipmentQuantity: 969 } });
    const ev2 = await evaluateShortShipment(prisma, { shipmentId: sh.id });
    expect(ev2.blocked).toHaveLength(1);
    expect(ev2.blocked[0].allowedMin).toBe(970);
  });
});

// ══════════════════════════════════════════════════════════════════
// 四、接线契约（源码级牙齿）：短装码的档位必须走注册表，不许被本地 `|| 500` 吞掉
// ══════════════════════════════════════════════════════════════════

describe('接线契约 — 短装拦截码必须能上屏（409，不是 500）', () => {
  const routeSrc = readFileSync(join(HERE, '..', 'route.ts'), 'utf8');
  const mutSrc = readFileSync(join(HERE, '..', 'shipmentMutationService.ts'), 'utf8');
  /**
   * ★ 注释剥离：本源扫描型守卫的口径是**只判代码不判注释**（B68 守卫自己就是这么做的）。
   *   ⓘ 同时这也是本批踩过的坑：我一开始在注释里照抄了那串被禁源码片段，
   *     结果被"按源码文本扫"的守卫当成真实现（本次在自己的测试里再犯一次 ⇒ 就地补剥离）。
   */
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const routeCode = stripComments(routeSrc);
  const mutCode = stripComments(mutSrc);

  it('★★ PATCH /:id 的档位：本地表查不到就问**注册表**，且**不许**自带兜底数字（B68 口径）', () => {
    // ★ 只看 PATCH 那一段（本文件里 POST/DELETE 各自还有一张历史本地表，不改它们）
    const start = routeCode.indexOf("router.patch('/:id'");
    const end = routeCode.indexOf('onDataChange?.({ entity: \'shipping\', action: \'update\'', start);
    expect(start, 'PATCH 处理器找不到了').toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const patchSrc = routeCode.slice(start, end);
    const iLocal = patchSrc.indexOf('statusCodeMap[code]');
    const iReg = patchSrc.indexOf('httpStatusOfCode(code)');
    expect(iLocal, '本地表那一层不许消失（它承载存量码的既有档位，如 ORDER_TERMINAL=400）').toBeGreaterThan(0);
    expect(iReg, '★ 少了注册表这一步 ⇒ 未登记的码会又变成 500').toBeGreaterThan(0);
    expect(iLocal, '顺序必须是 本地表 → 注册表').toBeLessThan(iReg);
    // ★★ 兜底数字不许出现在调用点（B68 守卫的判据同款）
    expect(patchSrc.match(/\?\.status\s*\?\?\s*\d/g) ?? [], '不许写 `?.status ?? <数字>`').toEqual([]);
    expect(patchSrc.includes('?? 500'), '不许写兜底 500 —— 档位只许从注册表拿').toBe(false);
  });

  it('★★ 运单服务能返回的**每一枚码**都必须定得了档（否则新码会让响应回不去）', () => {
    // 判据来源：`ShipmentMutationErrorCode` 联合 —— route 出口已改成"缺码即抛"，
    // 未登记的新码 = 抛错 = 请求回不到响应（比 500 更糟）。这条把整个联合逐枚验一遍。
    const unionSrc = mutSrc.slice(mutSrc.indexOf('export type ShipmentMutationErrorCode'), mutSrc.indexOf('export interface ShipmentMutationError'));
    const codes = [...unionSrc.matchAll(/'([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1]);
    expect(codes.length, '联合没解析出来 ⇒ 这条是恒绿的假闸门').toBeGreaterThan(15);
    const patchedSrc = routeCode.slice(routeCode.indexOf("router.patch('/:id'"), routeCode.indexOf('onDataChange?.({ entity: \'shipping\', action: \'update\'', routeCode.indexOf("router.patch('/:id'")));
    const localCodes = new Set([...patchedSrc.matchAll(/^\s*([A-Z][A-Z0-9_]+):\s*\d+,/gm)].map((m) => m[1]));
    const unresolved = codes.filter((c) => {
      if (localCodes.has(c)) return false;
      try { httpStatusOfCode(c); return false; } catch { return true; }
    });
    expect(unresolved, '这些码既不在本地表、也没登记进注册表 ⇒ 一旦返回就会抛错（挂住请求）').toEqual([]);
  });

  it('★★ 三枚新码**不许**抄进本地表（那是"登记欠债"，B32 棘轮盯着）', () => {
    const start = routeCode.indexOf("router.patch('/:id'");
    const end = routeCode.indexOf('onDataChange?.({ entity: \'shipping\', action: \'update\'', start);
    const localMap = routeCode.slice(routeCode.indexOf('const statusCodeMap', start), routeCode.indexOf('};', routeCode.indexOf('const statusCodeMap', start)));
    for (const c of [SHORT_SHIP_BLOCKED_CODE, ACTUAL_QTY_MISSING_CODE, NO_ALLOCATION_DETAIL_CODE]) {
      expect(localMap.includes(c), `★ ${c} 不该出现在本地表里：会凭空多登记一处本地 code→status 映射`).toBe(false);
    }
  });

  it('★★ 门禁挂在"运单流转至 Shipped"那一处（与放行门禁同事务、同位置）', () => {
    const i = mutSrc.indexOf('evaluateShortShipment(t, { shipmentId, physicalSource: modern,');
    expect(i, '运单服务里没有调用短装门禁 ⇒ 门禁是死的').toBeGreaterThan(0);
    // 必须在 `newStatus === 'Shipped'` 分支内（而不是别的状态上）
    const shippedIdx = mutSrc.indexOf("if (newStatus === 'Shipped' && existing.status !== 'Shipped')");
    expect(shippedIdx).toBeGreaterThan(0);
    expect(i, '短装门禁必须写在「流转至 Shipped」的分支里').toBeGreaterThan(shippedIdx);
    const gateCall = mutSrc.slice(i, mutSrc.indexOf('});', i) + 3);
    expect(gateCall).toContain("modern && isHandoffDeparture ? { quantityBasis: 'native_production_facts' as const }");
  });

  it('★★ 三个出口的顺序：先问"数据齐不齐"，再问"少不少"', () => {
    const i = mutSrc.indexOf('const shortShip = await evaluateShortShipment');
    const iNoDetail = mutSrc.indexOf('throw noAllocationDetailError()', i);
    const iUnfilled = mutSrc.indexOf('throw actualQtyMissingError(', i);
    const iBlocked = mutSrc.indexOf('throw shortShipBlockedError(', i);
    expect(iNoDetail).toBeGreaterThan(i);
    expect(iUnfilled).toBeGreaterThan(iNoDetail);
    expect(iBlocked, '★ 数据都没齐就先去发起审批，等于让"客户同意"给"没录数量"背书').toBeGreaterThan(iUnfilled);
  });

  it('★★ 阻断时审批单在**事务外**建（D83：事务里建的会被回滚带走 = 屏幕上那句是假话）', () => {
    const idxCatch = mutSrc.indexOf("if (e?.code === SHORT_SHIP_BLOCKED_CODE");
    const idxRequest = mutSrc.indexOf('await requestShortShipApproval(prisma,');
    expect(idxCatch, 'catch 分支里没有短装处理').toBeGreaterThan(0);
    expect(idxRequest, '审批单没有在事务外发起').toBeGreaterThan(idxCatch);
    // 事务内**不许**出现建审批单的调用（否则被回滚带走）
    const txSection = mutSrc.slice(mutSrc.indexOf('const shortShip = await evaluateShortShipment'), mutSrc.indexOf('await deductShipmentStockInTx'));
    expect(txSection.includes('requestShortShipApproval'), '事务内不许建审批单').toBe(false);
  });

  it('★★ 只有"事实清楚、缺客户同意"那一枚码才发起审批单（缺数据的两枚不许）', () => {
    const idxCatch = mutSrc.indexOf("if (e?.code === SHORT_SHIP_BLOCKED_CODE");
    const idxRequest = mutSrc.indexOf('await requestShortShipApproval(prisma,');
    const region = mutSrc.slice(idxCatch, idxRequest + 40);
    // 这个分支的**触发条件**里只许出现短装码；两枚"缺数据"的码出现在这里 = 逻辑混淆
    const condEnd = region.indexOf(') {');
    const cond = region.slice(0, condEnd + 1);
    expect(cond).toContain('SHORT_SHIP_BLOCKED_CODE');
    expect(cond.includes('ACTUAL_QTY_MISSING'), '★ "数量没填"不能用审批单放行').toBe(false);
    expect(cond.includes('NO_ALLOCATION_DETAIL'), '★ "没有明细"不能用审批单放行').toBe(false);
  });
});
