/**
 * orderAmountEditDrift.test.ts — 任务 5 的「先咬红」用例
 * （S4 · P1 · 手动编辑路径与真源不同步）
 *
 * ## 被测缺陷（读码定性，2026-09-25 · 前端未实测）
 *
 * 同一个业务动作「改价 / 改量」在本仓有 **两条路径**，只有一条走了真源收口：
 *
 *   · 审批路径：orderChangeRequestService.ts:659 → recalcOrderAmountFromLines()
 *      ⇒ 明细行重算 + 主档三列由明细行派生 ⇒ 三列一致 ✓
 *
 *   · 手动编辑路径：PUT /api/v1/orders/:id（orders/route.ts:435）
 *      ⇒ stripReadonly（route.ts:735）**只按 ORDER_WRITABLE_FIELDS 白名单过滤**
 *        （quoteAmount / totalNet / salesPrice / contractAmount 均在白名单）
 *      ⇒ **零口径校验**，patch 原样落库 ⇒ 分叉 ✗
 *
 * 前端 `applyAmountLinkage`（components/OrderManager.tsx:892）在改**销售单价**时
 * 只写 `next.contractAmount = round2(price × qty)`（:900），**不碰 totalNet、不碰明细行**；
 * 该 patch 经 `:1165 const { id, lines, fieldSources, ...patch } = updatedOrder` 组装后
 * 原样发给 PUT。且 DR-010 门禁（:1083）只在 `isApprovedOrderStatus(status)` 为真时非空
 * ⇒ **未批准订单（如 'Pending'）直改放行**。
 *
 * ## 本用例覆盖什么 / 不覆盖什么（诚实边界）
 * ✅ 覆盖：服务端落库口 PUT /:id 收到「改价 / 改量 patch」时**是否收口**
 *    （真库 + 真路由 + 真事务 + 真 Decimal）
 * ❌ 未覆盖：真实浏览器里点「改单价」的 UI 链路（需 Playwright）
 *    —— 本用例的 patch **形状**来自读码 OrderManager.tsx:892 / :1091 / :1165，**非实测**
 *
 * ## 修复后的期望
 * 无论 patch 里带什么金额，落库后必须满足 Kevin 09-18 拍板口径「以明细行为准」：
 *   contractAmount == totalNet == Σ明细行 netValue（且 quoteAmount 同源）
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { createOrdersRouter } from '../route';
import { findOrderAmountConflict } from '../../shared/orderAmount';

const prisma = new PrismaClient();

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, JWT_SECRET);
const auth = () => ({ Authorization: `Bearer ${ownerToken}` });

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(
    '/api/v1/orders',
    createOrdersRouter({ prisma, requireAuth: false, apiKeys: new Set<string>() }),
  );
  return app;
}

/**
 * 固定 ID 前缀 —— 测试库 `panda_hub_local` 是**与常驻后端共享的真库**，
 * 清理必须**精确 ID**，禁止按 source 之类批量删。
 */
const ID_PRICE = 'T5-DRIFT-PRICE';
const ID_QTY = 'T5-DRIFT-QTY';
const ID_AMOUNT = 'T5-DRIFT-AMOUNT';
// ★ 第 2 批 B：同改「数量 + 单价」—— 单行订单，贴合真浏览器捕获的真实 payload
const ID_QTYPRICE = 'T5-DRIFT-QTYPRICE';
// ★ 第 2 批 C：**无明细行**订单 —— 刻意不建 OrderLine
const ID_NOLINES = 'T5-DRIFT-NOLINES';
const IDS = [ID_PRICE, ID_QTY, ID_AMOUNT, ID_QTYPRICE, ID_NOLINES];

async function wipe() {
  await prisma.orderLine.deleteMany({ where: { orderId: { in: IDS } } });
  await prisma.order.deleteMany({ where: { id: { in: IDS } } });
  // PUT /:id 在事务内写 route:orders:update 审计日志（targetId = 订单 id）。
  // AuditLog **无哈希链**（schema.prisma:3783 无 prevHash/hash）⇒ 精确删不破坏链；
  // 但不清会在共享真库留下 13 条指向已删订单的**孤儿审计**，故一并清。
  await prisma.auditLog.deleteMany({ where: { targetId: { in: IDS } } });
}

// JWT-mocked actor (userId='u1') 必须存在于 UserAccount —— AuditLog.actorId 有 FK（否则 P2003）
async function ensureTestActor() {
  await prisma.userAccount.upsert({
    where: { id: 'u1' },
    update: {},
    create: { id: 'u1', displayName: 'Test Owner', email: 'u1@test.local' },
  });
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * 造一张**起点自洽**的订单：三列一致 + Σ明细行 = 主档。
 * 起点必须自洽，否则红了也说不清是谁弄坏的。
 */
async function seedConsistentOrder(opts: {
  id: string;
  status: string;
  quantity: number;
  unitPrice: number;
}) {
  const { id, status, quantity, unitPrice } = opts;
  const total = round2(quantity * unitPrice);
  const q1 = Math.floor(quantity / 2);
  const q2 = quantity - q1;
  const v1 = round2(q1 * unitPrice);
  const v2 = round2(total - v1); // 尾差兜底 ⇒ ΣnetValue = total 精确

  await prisma.order.create({
    data: {
      id,
      poNumber: id,
      customer: 'T5 Drift Co',
      product: 'Test Fabric',
      type: 'Fabric',
      quantity,
      status,
      dueDate: '2026-12-31',
      quoteAmount: total,
      totalNet: total,
      contractAmount: total,
      salesPrice: unitPrice,
    },
  });
  await prisma.orderLine.createMany({
    data: [
      { id: `${id}-L1`, orderId: id, lineNumber: 1, quantity: q1, unitPrice, netValue: v1 },
      { id: `${id}-L2`, orderId: id, lineNumber: 2, quantity: q2, unitPrice, netValue: v2 },
    ],
  });
  return { total, q1, q2, v1, v2 };
}

/**
 * ★ 第 2 批 B 用：**单行**订单（一行 = 一行的真实形态）。
 * 与 `seedConsistentOrder` 的区别：那个固定拆两行，本函数刻意只造一行 ——
 * 让「主档单价 ↔ 明细行单价」这对关系一一对应，不受「多行不同单价无法归因」干扰。
 */
async function seedSingleLineOrder(opts: {
  id: string;
  status: string;
  quantity: number;
  unitPrice: number;
}) {
  const { id, status, quantity, unitPrice } = opts;
  const total = round2(quantity * unitPrice);
  await prisma.order.create({
    data: {
      id,
      poNumber: id,
      customer: 'T5 Drift Co',
      product: 'Test Fabric',
      type: 'Fabric',
      quantity,
      status,
      dueDate: '2026-12-31',
      quoteAmount: total,
      totalNet: total,
      contractAmount: total,
      salesPrice: unitPrice,
    },
  });
  await prisma.orderLine.create({
    data: { id: `${id}-L1`, orderId: id, lineNumber: 1, quantity, unitPrice, netValue: total },
  });
  return { total };
}

/** 回读落库后的三列 + Σ明细行（走真库，不信接口回包） */
async function readAmounts(id: string) {
  const o = await prisma.order.findUnique({
    where: { id },
    include: { lines: { orderBy: { lineNumber: 'asc' } } },
  });
  if (!o) throw new Error(`order ${id} not found after PUT`);
  const lineSum = round2(o.lines.reduce((s, l) => s + Number(l.netValue ?? 0), 0));
  return {
    contractAmount: Number(o.contractAmount),
    totalNet: Number(o.totalNet),
    quoteAmount: Number(o.quoteAmount),
    quantity: o.quantity,
    lineSum,
    lines: o.lines,
  };
}

describe('任务5 · 手动编辑路径与真源不同步（先咬红）', () => {
  beforeAll(async () => {
    const url = process.env.DATABASE_URL ?? '';
    if (!/localhost|127\.0\.0\.1/.test(url)) {
      throw new Error('Refusing to run: DATABASE_URL is not localhost');
    }
    await ensureTestActor();
  });
  beforeEach(wipe);
  afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
  });

  it('★ 未批准订单改销售单价 → contractAmount == totalNet == Σ明细行', async () => {
    // 'Pending' 不在 APPROVED_ORDER_STATUSES = ['Confirmed','Production','Shipping','Delivered']
    // ⇒ DR-010 前端门禁不生效，直改放行
    await seedConsistentOrder({ id: ID_PRICE, status: 'Pending', quantity: 100, unitPrice: 10 });

    // ── 起点自洽自检（先怀疑自己的检查）──
    const before = await readAmounts(ID_PRICE);
    expect(findOrderAmountConflict({
      totalNet: before.totalNet, quoteAmount: before.quoteAmount,
      contractAmount: before.contractAmount, lines: before.lines as any,
    })).toBeNull();

    // ── 模拟前端「销售单价 10 → 20」后发出的 patch（读码 OrderManager.tsx:892/:1091/:1165）──
    //   salesPrice: 20         ← 用户输入
    //   contractAmount: 2000   ← applyAmountLinkage :900  round2(20 × 100)
    //   totalNet: 1000         ← updatedOrder = { ...editForm } 带出的**旧值**，未被重算
    const res = await request(makeApp())
      .put(`/api/v1/orders/${ID_PRICE}`)
      .set(auth())
      .send({ salesPrice: 20, contractAmount: 2000, totalNet: 1000 });

    expect(res.status).toBe(200);

    const a = await readAmounts(ID_PRICE);

    // ★ 验收条款原文：断言 contractAmount == totalNet == Σ明细行
    expect(a.contractAmount).toBe(2000); // 用户意图 20 × 100
    expect(a.totalNet).toBe(2000);       // ← 当前实现仍是 1000 ⇒ 咬红
    expect(a.lineSum).toBe(2000);        // ← 当前实现仍是 1000 ⇒ 咬红

    // 真源自检（orderAmount.ts:116）一次覆盖「Σ明细行 ↔ totalNet / contractAmount / quoteAmount」三条
    expect(findOrderAmountConflict({
      totalNet: a.totalNet, quoteAmount: a.quoteAmount,
      contractAmount: a.contractAmount, lines: a.lines as any,
    })).toBeNull();                      // ← 当前实现返回冲突 ⇒ 咬红
  });

  it('★ 未批准订单改数量 → contractAmount == totalNet == Σ明细行', async () => {
    await seedConsistentOrder({ id: ID_QTY, status: 'Pending', quantity: 100, unitPrice: 10 });

    const before = await readAmounts(ID_QTY);
    expect(findOrderAmountConflict({
      totalNet: before.totalNet, quoteAmount: before.quoteAmount,
      contractAmount: before.contractAmount, lines: before.lines as any,
    })).toBeNull();

    // 模拟前端「数量 100 → 150」（applyAmountLinkage 的 hasQty 分支 :903-905）：
    //   quantity: 150 · contractAmount: 1500（= salesPrice 10 × 150）· totalNet: 1000（旧值）
    const res = await request(makeApp())
      .put(`/api/v1/orders/${ID_QTY}`)
      .set(auth())
      .send({ quantity: 150, contractAmount: 1500, totalNet: 1000 });

    expect(res.status).toBe(200);

    const a = await readAmounts(ID_QTY);

    // 改量后「以明细行为准」的正确金额 = 各行 quantity × unitPrice = 150 × 10 = 1500
    expect(a.contractAmount).toBe(1500);
    expect(a.totalNet).toBe(1500);  // ← 当前实现仍是 1000 ⇒ 咬红
    expect(a.lineSum).toBe(1500);   // ← 当前实现仍是 1000 ⇒ 咬红

    expect(findOrderAmountConflict({
      totalNet: a.totalNet, quoteAmount: a.quoteAmount,
      contractAmount: a.contractAmount, lines: a.lines as any,
    })).toBeNull();                 // ← 当前实现返回冲突 ⇒ 咬红
  });

  /**
   * ★★ 这条是「整对象回传」陷阱的**判别用例** —— 没有它，收口实现里
   * 「比对 DB 现值以区分『真改动』与『回传旧值』」这层逻辑就**未被验证**。
   *
   * 用户**只改合同额**（不动数量），但前端 patch 是整对象回传
   * （`OrderManager.tsx:1165` `...patch = updatedOrder`，而 `updatedOrder = { ...editForm }`）
   * ⇒ patch 里**带着未改动的旧 `quantity: 100`**。
   *
   * 若收口只看「patch 里有没有 quantity 这个键」⇒ 会被误判成「改数量 100」
   * ⇒ 明细行与金额全不动 ⇒ 本用例咬红。
   * 只有真的与 DB 现值比对（100 == 100 ⇒ 未改）才会走「改总额」分支 ⇒ 绿。
   */
  it('★ 未批准订单只改合同额（数量回传旧值）→ 三列仍须一致', async () => {
    await seedConsistentOrder({ id: ID_AMOUNT, status: 'Pending', quantity: 100, unitPrice: 10 });

    const before = await readAmounts(ID_AMOUNT);
    expect(findOrderAmountConflict({
      totalNet: before.totalNet, quoteAmount: before.quoteAmount,
      contractAmount: before.contractAmount, lines: before.lines as any,
    })).toBeNull();

    // 模拟前端「合同额 1000 → 2000」（applyAmountLinkage 的 hasContract 分支 :901-903
    // 反算 next.salesPrice = 2000 / 100 = 20）：
    //   contractAmount: 2000 · salesPrice: 20 · quantity: 100（← 未改动，整对象回传）· totalNet: 1000（旧值）
    const res = await request(makeApp())
      .put(`/api/v1/orders/${ID_AMOUNT}`)
      .set(auth())
      .send({ contractAmount: 2000, salesPrice: 20, quantity: 100, totalNet: 1000 });

    expect(res.status).toBe(200);

    const a = await readAmounts(ID_AMOUNT);

    // 数量**不该**被改（用户没动它）—— 误判成「改数量」时这里也会红
    expect(a.quantity).toBe(100);
    expect(a.contractAmount).toBe(2000);
    expect(a.totalNet).toBe(2000);  // ← 若误判为「改数量 100」则仍是 1000 ⇒ 咬红
    expect(a.lineSum).toBe(2000);   // ← 同上

    expect(findOrderAmountConflict({
      totalNet: a.totalNet, quoteAmount: a.quoteAmount,
      contractAmount: a.contractAmount, lines: a.lines as any,
    })).toBeNull();
  });

  /**
   * ★★ 第 2 批 B（P1）：同改「数量 + 单价」⇒ **改价被静默丢弃**。
   *
   * 病根：`detectAmountIntent` 的优先级 `quantity > contractAmount > quoteAmount > totalNet`
   * 且**只返回一个 mode** ⇒ 两者同改时 `quantity` 先命中 ⇒ `recalcOrderAmountFromLines`
   * 按**原单价**重算；而收口段只剔 `quantity/quoteAmount/contractAmount/totalNet`
   * ⇒ 用户输入的 `salesPrice` 照样落库 ⇒ **主档单价 ↔ 明细行单价矛盾**。
   *
   * ★ payload 取自**真浏览器捕获**（非读码推测）：
   *   `.workbuddy-ai/audit/复现脚本-2026-09-26/captured-put-b.json` 第 0 条
   *   （订单 SIM-ORD-056，原 1800 × 13.85 = 24930）。
   */
  it('★ 第2批B：同改「数量 + 单价」⇒ 两样都生效（不许静默丢一半）', async () => {
    await seedSingleLineOrder({ id: ID_QTYPRICE, status: 'Pending', quantity: 1800, unitPrice: 13.85 });

    const before = await readAmounts(ID_QTYPRICE);
    expect(before.totalNet).toBe(24930);
    expect(findOrderAmountConflict({
      totalNet: before.totalNet, quoteAmount: before.quoteAmount,
      contractAmount: before.contractAmount, salesPrice: 13.85, quantity: 1800, lines: before.lines as any,
    })).toBeNull();

    // 真实 payload：数量 1800 → 1500 且单价 13.85 → 20
    //   · salesPrice: 20        ← 用户输入
    //   · quantity: 1500        ← 用户输入
    //   · contractAmount: 30000 ← applyAmountLinkage :900 派生 round2(20 × 1500)
    //   · totalNet / quoteAmount: 24930 ← 整对象回传的**旧值**（applyAmountLinkage 不碰它们）
    const res = await request(makeApp())
      .put(`/api/v1/orders/${ID_QTYPRICE}`)
      .set(auth())
      .send({
        quantity: 1500,
        salesPrice: 20,
        contractAmount: 30000,
        totalNet: 24930,
        quoteAmount: 24930,
      });

    expect(res.status).toBe(200);

    const a = await readAmounts(ID_QTYPRICE);
    const row = await prisma.order.findUnique({
      where: { id: ID_QTYPRICE },
      select: { salesPrice: true },
    });
    const salesPrice = Number(row!.salesPrice);

    // ★ 验收条款原文：`salesPrice × quantity === totalNet` 且明细行 `unitPrice === 20`
    expect(a.quantity).toBe(1500);
    expect(salesPrice, '用户输入的单价必须落库').toBe(20);
    expect(Number(a.lines[0].unitPrice), '明细行单价必须跟着改 —— 当前实现仍是 13.85 ⇒ 咬红').toBe(20);
    expect(a.totalNet, '总额必须是 1500 × 20 —— 当前实现是 1500 × 13.85 = 20775 ⇒ 咬红').toBe(30000);
    expect(round2(salesPrice * a.quantity)).toBe(a.totalNet);

    // 三列与 Σ明细行仍须同源一致
    expect(a.contractAmount).toBe(30000);
    expect(a.lineSum).toBe(30000);
    expect(findOrderAmountConflict({
      totalNet: a.totalNet, quoteAmount: a.quoteAmount,
      contractAmount: a.contractAmount, salesPrice, quantity: a.quantity, lines: a.lines as any,
    })).toBeNull();
  });

  /**
   * ★ 反面对照（防「一律按新单价重算」的假修复）：
   * **只改数量**、单价未动 ⇒ 单价必须保持原值，不得被算成别的数。
   */
  it('★ 反面对照：只改数量 ⇒ 单价保持原值（不许被顺手改掉）', async () => {
    await seedSingleLineOrder({ id: ID_QTYPRICE, status: 'Pending', quantity: 1800, unitPrice: 13.85 });

    // 只改数量：patch 里 salesPrice 是**未改动的回传旧值** 13.85
    const res = await request(makeApp())
      .put(`/api/v1/orders/${ID_QTYPRICE}`)
      .set(auth())
      .send({ quantity: 1500, salesPrice: 13.85, contractAmount: 20775, totalNet: 24930 });

    expect(res.status).toBe(200);

    const a = await readAmounts(ID_QTYPRICE);
    const row = await prisma.order.findUnique({
      where: { id: ID_QTYPRICE },
      select: { salesPrice: true },
    });

    expect(Number(row!.salesPrice)).toBe(13.85);
    expect(Number(a.lines[0].unitPrice)).toBe(13.85);
    expect(a.totalNet).toBe(20775); // 1500 × 13.85
    expect(round2(Number(row!.salesPrice) * a.quantity)).toBe(a.totalNet);
  });

  /**
   * ★★ 第 2 批 C（P2）：无明细行订单改价 ⇒ 三列仍分叉，且**静默**。
   *
   * 病根：`recalcOrderAmountFromLines` 对「无明细行」**显式返回 null**
   *   （`orderAmountRecalc.ts:78` 明写「无明细行：没有可分摊的载体，保持主档单点写入（既有行为）」）
   *   ⇒ `route.ts` 的 `if (recalc)` 不成立 ⇒ 四键**不被剔除** ⇒ patch 原样落库
   *   ⇒ `contractAmount` 变而 `quoteAmount` / `totalNet` 不变 ⇒ 三列互相分叉，且**用户看不到**。
   *
   * ★ 规模实测更正（第 2 批指令原文写「1069 张里 1000 张无明细行」）：
   *   实测那 1000 张**全是已删行**（`deletedAt IS NOT NULL`）；**活单 69 张全部有明细行**
   *   （无明细行的活单 = **0**）⇒ 结构上成立，但当前测试库**活单触发面为 0**。
   *   故本用例**自造**一张无明细行订单（模拟手工建单 / 导入可能产生的形态）。
   *
   * 验收条款（第 2 批指令原文）：要么三列一致，要么返回**可识别**的拒绝。
   */
  it('★ 第2批C：无明细行订单改价 ⇒ 不许静默分叉（要么三列一致，要么可识别拒绝）', async () => {
    // 无明细行订单：三列起点一致（1001.5），刻意**不建** OrderLine
    await prisma.order.create({
      data: {
        id: ID_NOLINES,
        poNumber: ID_NOLINES,
        customer: 'T5 Drift Co',
        product: 'Test Fabric',
        type: 'Fabric',
        quantity: 100,
        status: 'Pending',
        dueDate: '2026-12-31',
        quoteAmount: 1001.5,
        totalNet: 1001.5,
        contractAmount: 1001.5,
      },
    });

    // 有金额意图：contractAmount 1001.5 → 10020（与现值不同 ⇒ 真的改了）
    const res = await request(makeApp())
      .put(`/api/v1/orders/${ID_NOLINES}`)
      .set(auth())
      .send({ contractAmount: 10020 });

    const row = await prisma.order.findUnique({
      where: { id: ID_NOLINES },
      select: { contractAmount: true, quoteAmount: true, totalNet: true },
    });
    const raw = {
      contractAmount: row!.contractAmount === null ? null : Number(row!.contractAmount),
      quoteAmount: row!.quoteAmount === null ? null : Number(row!.quoteAmount),
      totalNet: row!.totalNet === null ? null : Number(row!.totalNet),
    };

    if (res.status >= 400) {
      // ── 支路一：可识别的拒绝（结构化码 + 中文人话），且订单**一个字段都没动** ──
      expect(res.body?.error?.code, '拒绝必须是结构化码，不能只给 500').toBeTruthy();
      expect(typeof res.body?.error?.message).toBe('string');
      expect(res.body.error.message.length, '拒绝必须给人话（不许空文案）').toBeGreaterThan(0);
      expect(raw, '被拒绝时订单不许被改（否则等于静默写了一半）').toEqual({
        contractAmount: 1001.5, quoteAmount: 1001.5, totalNet: 1001.5,
      });
      return;
    }

    // ── 支路二：写了 ⇒ 三列必须一致（当前实现两条支路都不满足 ⇒ 咬红） ──
    expect(res.status).toBe(200);
    expect(raw.contractAmount, '三列必须一致').toBe(raw.quoteAmount);
    expect(raw.quoteAmount, '三列必须一致').toBe(raw.totalNet);
  });
});
