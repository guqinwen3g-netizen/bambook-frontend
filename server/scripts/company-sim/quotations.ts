/**
 * company-sim/quotations.ts — 报价→赢单转订单 + 未赢单报价（联动③）
 *
 * 剧情（确定性）：
 *   - 赢单 12 张：SIM-ORD-{1,6,11,…,56}（idx % 5 === 0，覆盖全部命运分布），
 *     status=Accepted，issueDate = 订单创建前 10 天，QuotationVersion v1 快照，
 *     回写 Quotation.convertedOrderId + Order.source='quotation-convert' + Order.quoteAmount=报价总额；
 *   - 未赢单 7 张：Sent 3 / Rejected 2 / Expired 2，散布 W3-W12，带 sentAt 与版本快照；
 *   - 面料报价 4 张：赢单 3 张转面料外销订单（SIM-FORD-{3,8,12}，行=面料 SKU + Meter 口径）+
 *     未赢单 1 张（面料询价 Sent，色卡寄送中）。
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { at, isoDate, round2, createManyLogged, SALES_NAME, USD_CNY_RATE, EUR_CNY_RATE } from './common';
import { CUSTOMERS, type MasterDataCtx } from './master-data';
import { isFabricPlan, FABRIC_WON_QUOTE_IDX, type FabricOrderPlan } from './fabric-orders';
import type { OrderPlan } from './orders';
// ★ S4 步骤6.1：写入前对撞用真源**已有**的自检函数（不新写口径逻辑）
import { findOrderAmountConflict } from '../../src/shared/orderAmount';

const DAY = 24 * 3600 * 1000;

/** 赢单报价覆盖的订单 idx（12 单） */
function isWonIdx(idx: number): boolean {
  return idx % 5 === 0;
}

/** 未赢单报价剧情：Sent 3 / Rejected 2 / Expired 2（散布各周） */
const LOST_DEFS: Array<{ week: number; status: 'Sent' | 'Rejected' | 'Expired'; note: string }> = [
  { week: 3, status: 'Expired', note: '报价有效期届满未获回复，自动过期。' },
  { week: 4, status: 'Expired', note: '客户项目推迟，报价过期未跟进。' },
  { week: 6, status: 'Rejected', note: '客户选择低价供应商，未成交。' },
  { week: 7, status: 'Rejected', note: '价格分歧未弥合，客户放弃本次采购。' },
  { week: 9, status: 'Sent', note: '报价已发送，等待客户回复。' },
  { week: 10, status: 'Sent', note: '已发送修订报价（含运费调整），跟进中。' },
  { week: 12, status: 'Sent', note: '新季报价已发送，预计下周复函。' },
];

export async function seedQuotations(
  prisma: PrismaClient,
  plans: Array<OrderPlan | FabricOrderPlan>,
  md: MasterDataCtx,
): Promise<void> {
  console.log('── 报价单（赢单 12 转订单 + 未赢单 7 + 面料报价 4） ──');

  const garmentIdxById = new Map(md.garmentAssets.map((g, i) => [g.id, i] as const));
  const fabricSkuOfGarment = (garmentId: string): string => {
    const gIdx = garmentIdxById.get(garmentId);
    if (gIdx === undefined) throw new Error(`garmentId ${garmentId} 不在 md.garmentAssets`);
    return md.fabricAssets[gIdx % 24].sku;
  };
  const fxOf = (currency: string): number => (currency === 'EUR' ? EUR_CNY_RATE : USD_CNY_RATE);

  const quotationRows: Prisma.QuotationUncheckedCreateInput[] = [];
  const lineRows: Prisma.QuotationLineUncheckedCreateInput[] = [];
  const versionRows: Prisma.QuotationVersionUncheckedCreateInput[] = [];
  const wonUpdates: Array<{ orderId: string; totalAmount: Prisma.Decimal; confirmedMs: number }> = [];

  let seq = 0;
  const buildQuotation = (args: {
    status: string;
    currency: string;
    customerRelId: string;
    customerName: string;
    issueMs: number;
    validUntil: string | null;
    salesName: string;
    salesId: string;
    sentAtMs: number | null;
    totalAmount: number;
    convertedOrderId: string | null;
    notes: string;
    confirmedMs: number;
    lines: Array<{ fabricCode: string; description: string; quantity: number; unit: string; unitPrice: number }>;
  }): void => {
    seq += 1;
    const qId = `SIM-QT-${String(seq).padStart(3, '0')}`;
    const quotationNumber = `SIM-QT-2026-${String(seq).padStart(3, '0')}`;
    quotationRows.push({
      id: qId, quotationNumber, status: args.status,
      currency: args.currency, totalAmount: new Prisma.Decimal(round2(args.totalAmount)), version: 1,
      exchangeRate: new Prisma.Decimal(fxOf(args.currency)), baseCurrency: 'CNY',
      customerRelationId: args.customerRelId, customerName: args.customerName, customerCode: args.customerRelId,
      issueDate: isoDate(args.issueMs), validUntil: args.validUntil,
      deliveryTerms: 'FOB Shanghai', paymentTerms: 'T/T 30% deposit, 70% against B/L copy',
      salesperson: args.salesName, convertedOrderId: args.convertedOrderId,
      notes: args.notes, sentAt: args.sentAtMs === null ? null : BigInt(args.sentAtMs),
      ownerId: args.salesId, departmentId: null,
      createdAt: BigInt(args.issueMs), updatedAt: BigInt(args.confirmedMs), deletedAt: null,
    });
    let amountSum = 0;
    args.lines.forEach((l, li) => {
      const amount = round2(l.quantity * l.unitPrice);
      amountSum = round2(amountSum + amount);
      lineRows.push({
        id: `${qId}-L${li + 1}`, quotationId: qId, lineNumber: li + 1,
        fabricCode: l.fabricCode, description: l.description,
        quantity: new Prisma.Decimal(l.quantity), unit: l.unit,
        unitPrice: new Prisma.Decimal(l.unitPrice), amount: new Prisma.Decimal(amount),
        notes: null, createdAt: BigInt(args.issueMs),
      });
    });
    if (Math.abs(amountSum - round2(args.totalAmount)) > 0.01) {
      throw new Error(`报价行金额合计不一致：${quotationNumber}（行合计 ${amountSum} ≠ 头 ${args.totalAmount}）`);
    }
    versionRows.push({
      id: `${qId}-V1`, quotationId: qId, version: 1,
      totalAmount: new Prisma.Decimal(round2(args.totalAmount)), currency: args.currency,
      headerSnapshot: {
        quotationNumber, status: args.status, currency: args.currency,
        customerName: args.customerName, issueDate: isoDate(args.issueMs), validUntil: args.validUntil,
        deliveryTerms: 'FOB Shanghai', paymentTerms: 'T/T 30% deposit, 70% against B/L copy',
        salesperson: args.salesName,
      },
      linesSnapshot: args.lines.map((l, li) => ({
        lineNumber: li + 1, fabricCode: l.fabricCode, description: l.description,
        quantity: l.quantity, unit: l.unit, unitPrice: l.unitPrice, amount: round2(l.quantity * l.unitPrice),
      })),
      changeReason: null, changedBy: args.salesName, createdAt: BigInt(args.issueMs),
    });
    if (args.convertedOrderId) {
      wonUpdates.push({ orderId: args.convertedOrderId, totalAmount: new Prisma.Decimal(round2(args.totalAmount)), confirmedMs: args.confirmedMs });
    }
  };

  // 1. 赢单 12 张（idx % 5 === 0；面料单走下方面料专属分支）
  for (const p of plans.filter((x) => isWonIdx(x.idx) && !isFabricPlan(x))) {
    buildQuotation({
      status: 'Accepted', currency: p.currency,
      customerRelId: p.customerId, customerName: p.customerName,
      issueMs: p.createdAtMs - 10 * DAY,
      validUntil: isoDate(p.createdAtMs - 10 * DAY + 30 * DAY),
      salesName: p.salesName, salesId: p.salesId,
      sentAtMs: p.createdAtMs - 9 * DAY,
      totalAmount: p.amount,
      convertedOrderId: p.id,
      notes: '客户确认报价后转订单（SIM 模拟赢单链路）。',
      confirmedMs: p.confirmMs ?? p.createdAtMs + 2 * DAY,
      lines: p.linePlans.map((l) => ({
        fabricCode: fabricSkuOfGarment(l.garmentId),
        description: `Ladies' ${l.category} — style ${l.styleNo}（${l.color}）`,
        quantity: l.qty, unit: 'PC', unitPrice: l.price,
      })),
    });
  }

  // 2. 未赢单 7 张
  LOST_DEFS.forEach((def, di) => {
    const cust = CUSTOMERS[(di + 3) % 8];
    const garment = md.garmentAssets[(di * 5 + 2) % 12];
    const qty = 1200 + di * 350;
    const price = round2(7.5 + (di % 5) * 0.9);
    const issueMs = at(def.week, 3, 10);
    const sentAtMs = issueMs + DAY;
    buildQuotation({
      status: def.status, currency: cust.currency,
      customerRelId: cust.id, customerName: cust.name,
      issueMs,
      validUntil: isoDate(issueMs + (def.status === 'Expired' ? 21 : 30) * DAY),
      salesName: SALES_NAME[cust.ownerId ?? ''] ?? 'Vivian Chen',
      salesId: cust.ownerId ?? '',
      sentAtMs,
      totalAmount: round2(qty * price),
      convertedOrderId: null,
      notes: def.note,
      confirmedMs: sentAtMs + 5 * DAY,
      lines: [{
        fabricCode: fabricSkuOfGarment(garment.id),
        description: `${garment.name}（询价样品款）`,
        quantity: qty, unit: 'PC', unitPrice: price,
      }],
    });
  });

  // 3. 面料报价：赢单 3 张转面料外销订单（SIM-FORD-{idx+1}，行=面料 SKU + Meter）
  for (const p of plans.filter((x): x is FabricOrderPlan => isFabricPlan(x) && FABRIC_WON_QUOTE_IDX.has(x.idx))) {
    buildQuotation({
      status: 'Accepted', currency: p.currency,
      customerRelId: p.customerId, customerName: p.customerName,
      issueMs: p.createdAtMs - 10 * DAY,
      validUntil: isoDate(p.createdAtMs - 10 * DAY + 30 * DAY),
      salesName: p.salesName, salesId: p.salesId,
      sentAtMs: p.createdAtMs - 9 * DAY,
      totalAmount: p.amount,
      convertedOrderId: p.id,
      notes: '客户确认面料报价后转外销订单（SIM 模拟面料赢单链路）。',
      confirmedMs: p.confirmMs ?? p.createdAtMs + 2 * DAY,
      lines: p.linePlans.map((l) => ({
        fabricCode: l.sku,
        description: `${l.description}（FOB Shanghai，按米计价）`,
        quantity: l.qty, unit: 'M', unitPrice: l.price,
      })),
    });
  }

  // 4. 面料未赢单 1 张：Aurora 面料询价 Sent（色卡寄送中）
  {
    const cust = CUSTOMERS[7]; // Aurora Milano S.r.l.（EUR）
    const fabric = md.fabricAssets[19];
    const qty = 18000;
    const price = round2((8.5 + (19 % 8) * 2.3) / USD_CNY_RATE * 1.42 / 1.08);
    const issueMs = at(10, 4, 10);
    const sentAtMs = issueMs + DAY;
    buildQuotation({
      status: 'Sent', currency: cust.currency,
      customerRelId: cust.id, customerName: cust.name,
      issueMs,
      validUntil: isoDate(issueMs + 30 * DAY),
      salesName: SALES_NAME[cust.ownerId ?? ''] ?? 'Vivian Chen',
      salesId: cust.ownerId ?? '',
      sentAtMs,
      totalAmount: round2(qty * price),
      convertedOrderId: null,
      notes: '面料样品色卡寄送中，等待客户确认缸号后下单。',
      confirmedMs: sentAtMs + 5 * DAY,
      lines: [{
        fabricCode: fabric.sku,
        description: `${fabric.name}（面料询价，Aurora AW26 预选）`,
        quantity: qty, unit: 'M', unitPrice: price,
      }],
    });
  }

  await createManyLogged(prisma, 'quotation', 'Quotation', quotationRows);
  await createManyLogged(prisma, 'quotationLine', 'QuotationLine', lineRows);
  await createManyLogged(prisma, 'quotationVersion', 'QuotationVersion', versionRows);

  // 3. 回写订单：source='quotation-convert' + quoteAmount=报价总额
  //
  // ★★ 2026-09-25（S4 任务 2）**为什么只写 quoteAmount、刻意不碰 totalNet / totalActual / contractAmount**：
  //   1) 真源是**明细行**。Kevin 2026-09-18 拍板口径：订单金额 = Σ明细行 netValue，
  //      **主档金额由明细行派生、不手工填**（见 server/src/shared/orderAmount.ts:17-24 的「Kevin 拍板口径」）。
  //      在这里补写那三列 = 手工填主档金额 ⇒ 正是真源文档点名要禁的写法。
  //   2) 生产侧同形路径也只写 quoteAmount：server/src/quotations/quotationService.ts:1249-1293
  //      的「报价转订单」是 order.create({ quoteAmount: totalAmount, lines: [{ netValue: line.amount }] })，
  //      同样**不手工填** totalNet / contractAmount / totalActual ⇒ 本演练与生产语义一致。
  //   3) 与 company-sim/orders.ts:201-203（四列同写同一变量）**不矛盾**：那边是**建单**时把 plan 的同一个数
  //      落到主档（模拟数据的便利写法），这边是**转单回写**、只改与报价有关的那一列。
  //
  // ★ 「谁保证这几列相等」的答案（S4 任务 2 验收）：
  //   plan 生成器把 `amount` 定义成 **Σ linePlans.netValue**
  //   （orders.ts:150、fabric-orders.ts:173），订单行 netValue = round2(qty*price)
  //   （orders.ts:145、fabric-orders.ts:166），报价行 amount 也 = round2(qty*price)
  //   ⇒ 订单行合计 ≡ 报价行合计 ≡ 报价单 totalAmount ≡ w.totalAmount ≡ 订单 totalNet ≡ p.amount，
  //   **同一个 plan 字段派生出全部六处**；另有 buildQuotation 内部断言（本文件 :101-103）
  //   把「报价行合计 == 报价头」钉死。
  //   ✅ 缺口已补（S4 步骤 6.1，2026-09-25）：下面回写循环**写入前**调用真源自检
  //   findOrderAmountConflict，把「订单行合计 ↔ 报价单总额（w.totalAmount）」对撞钉住；
  //   分叉即**拒绝回写并抛错**（宁可不写，也不写一个与明细行打架的报价额）。
  //   ★ 为什么必须**读库**而不能在内存里对撞：这两边同源于 p.amount
  //   ⇒ 内存对撞**判别力 0**（本仓已第 3 次踩这个坑）；只有拿**库里已有的明细行**去比才有牙。
  for (const w of wonUpdates) {
    // ★ S4 步骤 6.1：写入前对撞 —— 「订单行合计 ↔ 报价单总额」。
    //   用真源**已有**的自检函数（纯对象入参，零新增口径逻辑）；
    //   它同时覆盖 Σ明细行 ↔ totalNet / contractAmount / quoteAmount，
    //   以及（第 2 批 A 起）salesPrice ↔ 明细行单价 / salesPrice × quantity ↔ totalNet。
    const target = await prisma.order.findUnique({
      where: { id: w.orderId },
      select: {
        totalNet: true, contractAmount: true, salesPrice: true, quantity: true,
        lines: { select: { netValue: true, unitPrice: true } },
      },
    });
    const conflict = findOrderAmountConflict({
      totalNet: target?.totalNet ?? null,
      contractAmount: target?.contractAmount ?? null,
      quoteAmount: w.totalAmount, // ← 即将写入的新值（报价单总额）
      // ★ 2026-09-26（第 2 批 A）：自检已纳入单价族 ⇒ 一并传入，避免该守卫在此处静默退化。
      //   本库 salesPrice 现全为 null（实测 1069 张全空）⇒ ④⑤ 今天不触发，但将来填了就管得住。
      salesPrice: target?.salesPrice ?? null,
      quantity: target?.quantity ?? null,
      lines: target?.lines ?? null,
    });
    if (conflict) {
      throw new Error(
        `[company-sim] 拒绝回写：订单 ${w.orderId} 与报价单总额分叉 —— ${conflict.conflicts.join('；')}`,
      );
    }
    await prisma.order.update({
      where: { id: w.orderId },
      data: { source: 'quotation-convert', quoteAmount: w.totalAmount, updatedAt: BigInt(w.confirmedMs) },
    });
  }
  console.log(`  Order 回写（quotation-convert）: ${wonUpdates.length} 单`);
}
