/**
 * company-sim/orders.ts — 56 单订单剧情与全链数据
 *
 * 生命周期分布（13 周 2026-06-08 ~ 2026-08-30）：
 *   W1-W6  28 单 Delivered（全链：流转审计 + 10 阶段 + Final QC + 出运 + 发票 + 回款 + 3 单逾期催款）
 *   W7-W9  14 单 = 6 Delivered + 4 Shipping（批次 in-transit，票已开款未齐）+ 4 Production（阶段过半）
 *   W10-W13 14 单 = 5 Production（前期阶段）+ 6 Confirmed + 3 Pending（最近一周）
 *
 * Delivered 单收款时序分流（2026-09-02，common.deliveredFinance 真源）：
 *   提前出运合法，但交期未来（>= 2026-09-03）的单交易周期未完——约 2/3 收 30% 定金
 *   （PartiallyPaid），约 1/3 零收款（Issued）；交期已过的非逾期单全额 Paid。
 */

import { Prisma } from '@prisma/client';
import {
  at, isoDate, round2, createManyLogged, USERS, SIM_EXTRA_ACCOUNTS, SALES_POOL, SALES_NAME,
  deliveredFinance, USD_CNY_RATE, EUR_CNY_RATE, type DeliveredFinance,
} from './common';
import { CUSTOMERS, SUPPLIERS, FORWARDERS, MasterDataCtx, SUPPLIER_ADDR, customerAddrById } from './master-data';

const DAY = 24 * 3600 * 1000;

type OrderFate = 'Delivered' | 'Shipping' | 'Production' | 'Confirmed' | 'Pending';

function fateOf(idx: number): OrderFate {
  if (idx <= 27) return 'Delivered';
  if (idx <= 33) return 'Delivered';
  if (idx <= 37) return 'Shipping';
  if (idx <= 41) return 'Production'; // W9 阶段过半
  if (idx <= 46) return 'Production'; // W10-W11 前期
  if (idx <= 52) return 'Confirmed';
  return 'Pending';
}
function weekOf(idx: number): number {
  if (idx <= 3) return 1;
  if (idx <= 8) return 2;
  if (idx <= 13) return 3;
  if (idx <= 18) return 4;
  if (idx <= 23) return 5;
  if (idx <= 27) return 6;
  if (idx <= 32) return 7;
  if (idx <= 37) return 8;
  if (idx <= 41) return 9;
  if (idx <= 45) return 10;
  if (idx <= 49) return 11;
  if (idx <= 52) return 12;
  return 13;
}

/** 确定性行数分布：约 6 成 1 行 / 3 成 2 行 / 1 成 3 行 */
function lineCountOf(idx: number): number {
  const m = idx % 10;
  if (m < 6) return 1;
  if (m < 9) return 2;
  return 3;
}

const COLORS = ['Black', 'Ivory', 'Navy', 'Rose Dust', 'Sage Green', 'Camel', 'Dusty Blue', 'Terracotta'];
const PORT_BY_COUNTRY: Record<string, string> = {
  US: 'Los Angeles', DE: 'Hamburg', JP: 'Tokyo', AU: 'Melbourne',
  FR: 'Le Havre', GB: 'Felixstowe', IT: 'Genoa', CN: 'Shanghai',
};
const HS_BY_CATEGORY: Record<string, string> = { Dress: '6204.43.00', Blouse: '6206.40.00', 'Knit Top': '6110.20.99' };

// 阶段顺序（真源：server/src/production/stageService.ts PRODUCTION_STAGES）
const STAGE_KEYS = [
  'order_placed', 'materials_confirmed', 'production_planned', 'in_production', 'materials_arrived',
  'pre_cut_checked', 'pp_sample_approved', 'manufacturing', 'final_review', 'qc_shipped',
] as const;
const MERCH_IDS = ['SIM-usr-merch-1', 'SIM-usr-merch-2', 'SIM-usr-merch-3'];

export interface OrderPlan {
  idx: number;
  id: string;
  code: string;
  poNumber: string;
  fate: OrderFate;
  week: number;
  createdAtMs: number;
  salesId: string;
  salesName: string;
  customerId: string;
  customerName: string;
  currency: string;
  factoryId: string;
  factoryName: string;
  totalQty: number;
  amount: number;
  dueDate: string;
  linePlans: { lineId: string; garmentId: string; sku: string; styleNo: string; qty: number; price: number; netValue: number; color: string; category: string }[];
  // 时间线（Delivered/Shipping/Production 用）
  confirmMs?: number; prodStartMs?: number; shipMs?: number; deliveredMs?: number; etaMs?: number;
  stageDone?: number; // Production 单已完成阶段数
  overdue?: boolean; // Delivered 逾期部分收款
  dueMs?: number; // 账期到期
}

/** 逾期部分收款 3 单（W1/W2/W4，账期已到 + 半款未收） */
const OVERDUE_IDX = new Set([2, 8, 15]);

export interface OrdersOutcome {
  plans: OrderPlan[];
  overduePlans: OrderPlan[];
}

export async function seedOrders(prisma: PrismaClient, md: MasterDataCtx): Promise<OrdersOutcome> {
  console.log('── 订单 56 单（剧情时间线回填） ──');

  // 0. SIM 补充账号（EmployeeProfile/审计挂载；不改动既有账号，幂等 upsert）
  for (const acc of SIM_EXTRA_ACCOUNTS) {
    await prisma.userAccount.upsert({
      where: { id: acc.id },
      create: { id: acc.id, displayName: acc.displayName, email: acc.email, passwordHash: '', status: 'active' },
      update: { displayName: acc.displayName },
    });
  }

  // 1. 生成 56 单计划
  const plans: OrderPlan[] = [];
  for (let idx = 0; idx < 56; idx++) {
    const fate = fateOf(idx);
    const week = weekOf(idx);
    const id = `SIM-ORD-${String(idx + 1).padStart(3, '0')}`;
    const code = `SIM-SO-${String(1001 + idx)}`;
    const poNumber = `SIM-PO-${String(1001 + idx)}`;
    const salesId = SALES_POOL[idx % 3];
    const cust = CUSTOMERS[idx % 8];
    const factory = SUPPLIERS[7 + (idx % 3)];
    const createdMs = at(week, 1 + (idx % 3), 9 + (idx % 3), (idx * 7) % 50);
    const dayMs = createdMs % DAY;
    const atDay = (baseMs: number, addDays: number) => {
      const t = new Date(baseMs);
      return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + addDays, 9, (idx * 11) % 60) + 0;
    };
    void dayMs;

    const linePlans: OrderPlan['linePlans'] = [];
    const lc = lineCountOf(idx);
    for (let li = 0; li < lc; li++) {
      const g = md.garmentAssets[(idx + li * 5) % 12];
      const qty = (1500 + ((idx * 7 + li * 3100) % 10500)) - ((1500 + ((idx * 7 + li * 3100) % 10500)) % 100);
      const price = round2(6.5 + ((idx + li * 3) % 12) * 1.05);
      linePlans.push({
        lineId: `${id}-L${li + 1}`, garmentId: g.id, sku: g.sku, styleNo: g.styleNo,
        qty, price, netValue: round2(qty * price), color: COLORS[(idx + li) % COLORS.length],
        category: g.styleNo.startsWith('GST-2610') ? 'Dress' : (idx + li) % 3 === 0 ? 'Dress' : (idx + li) % 3 === 1 ? 'Blouse' : 'Knit Top',
      });
    }
    const totalQty = linePlans.reduce((s, l) => s + l.qty, 0);
    const amount = round2(linePlans.reduce((s, l) => s + l.netValue, 0));
    const dueMs = atDay(createdMs, 75); // 交期 ~75 天
    const plan: OrderPlan = {
      idx, id, code, poNumber, fate, week, createdAtMs: createdMs,
      salesId, salesName: SALES_NAME[salesId], customerId: cust.id, customerName: cust.name,
      currency: cust.currency, factoryId: factory.id, factoryName: factory.name,
      totalQty, amount, dueDate: isoDate(dueMs), dueMs, linePlans,
    };
    if (fate === 'Delivered') {
      plan.confirmMs = atDay(createdMs, 2);
      plan.prodStartMs = atDay(createdMs, 4);
      plan.shipMs = atDay(createdMs, 22);
      plan.deliveredMs = plan.shipMs + 21 * DAY;
      plan.overdue = OVERDUE_IDX.has(idx);
    } else if (fate === 'Shipping') {
      plan.confirmMs = atDay(createdMs, 2);
      plan.prodStartMs = atDay(createdMs, 4);
      plan.shipMs = atDay(createdMs, 22);
      plan.etaMs = plan.shipMs + 24 * DAY; // 未来到港（≥ 8/30 之后的部分保留未来值）
    } else if (fate === 'Production') {
      plan.confirmMs = atDay(createdMs, 2);
      plan.prodStartMs = atDay(createdMs, 4);
      plan.stageDone = idx <= 41 ? (idx % 2 === 0 ? 5 : 6) : [2, 3, 4, 2, 3][idx - 42];
    } else if (fate === 'Confirmed') {
      plan.confirmMs = atDay(createdMs, 2);
    }
    plans.push(plan);
  }

  // 2. Order + OrderLine
  const orderRows: Prisma.OrderUncheckedCreateInput[] = [];
  const lineRows: Prisma.OrderLineUncheckedCreateInput[] = [];
  const statusByFate: Record<OrderFate, string> = {
    Delivered: 'Delivered', Shipping: 'Shipping', Production: 'Production', Confirmed: 'Confirmed', Pending: 'Pending',
  };
  for (const p of plans) {
    const cust = CUSTOMERS[p.idx % 8];
    orderRows.push({
      id: p.id, code: p.code, poNumber: p.poNumber, customer: p.customerName,
      customerCode: p.customerId, customerRelationId: p.customerId,
      customerAddress: customerAddrById(p.customerId) || `Overseas (${p.customerName})`,
      // 2026-09-02 地图定位修复：写真实地址（millAddress 城市名与前端
      // CityCoordinates 对齐，让 Dashboard 地球解析到长三角工厂集群而非占位符）
      millAddress: SUPPLIER_ADDR[p.factoryId] || undefined,
      consigneeAddress: customerAddrById(p.customerId) || undefined,
      millName: p.factoryName, millRelationId: p.factoryId,
      consigneeName: p.customerName, consigneeRelationId: p.customerId,
      billToName: p.customerName, billToRelationId: p.customerId, billToIsAgent: false,
      product: p.linePlans.map((l) => l.styleNo).join(' / '),
      type: 'Garment', businessLine: 'garment',
      quantity: p.totalQty, status: statusByFate[p.fate],
      dueDate: p.dueDate, clientDate: p.dueDate, quoteAmount: new Prisma.Decimal(p.amount),
      totalNet: new Prisma.Decimal(p.amount), totalActual: new Prisma.Decimal(p.amount),
      contractAmount: new Prisma.Decimal(p.amount),
      salesPerson: p.salesName, merchandiser: ['Grace Liu', 'Tony Fang', 'Ivy Zhang'][p.idx % 3],
      season: 'SS26', poDate: isoDate(p.createdAtMs), source: 'manual',
      currency: p.currency, salesCurrency: p.currency, purchaseCurrency: 'CNY',
      deliveryTerms: 'FOB Shanghai', paymentTerms: 'T/T 30% deposit, 70% against B/L copy',
      paymentInstrument: 'T/T', salesContractNumber: `SIM-SC-${String(1001 + p.idx)}`,
      shipToName: p.customerName, shipToCountry: cust.country, shipToAddress1: 'See customer master',
      ownerId: p.salesId, departmentId: null,
      productionPlanDeadline: isoDate(p.createdAtMs + 7 * DAY),
      delayNoticeDeadline: isoDate(p.dueMs - 15 * DAY),
      moqSnapshot: {
        fabricDefaultMoq: 800, garmentDefaultMoq: 500, capsuleMoq: 300,
        snapshotAt: isoDate(p.createdAtMs), source: 'moq_config',
      } as unknown as Prisma.InputJsonValue,
      createdAt: new Date(p.createdAtMs), updatedAt: BigInt(p.createdAtMs), deletedAt: null,
    });
    p.linePlans.forEach((l, li) => {
      lineRows.push({
        id: l.lineId, orderId: p.id, lineNumber: li + 1, itemNo: String(li + 1),
        materialCode: l.sku, description: `Ladies' ${l.category} — style ${l.styleNo}`,
        quantity: new Prisma.Decimal(l.qty), unit: 'PCS', unitPrice: new Prisma.Decimal(l.price),
        netValue: new Prisma.Decimal(l.netValue), exMillDate: p.dueDate, deliveryDate: p.dueDate,
        status: statusByFate[p.fate], styleNo: l.styleNo, colorName: l.color,
        sizeBreakdown: {
          S: Math.round(l.qty * 0.15), M: Math.round(l.qty * 0.3), L: Math.round(l.qty * 0.3),
          XL: Math.round(l.qty * 0.18), XXL: l.qty - Math.round(l.qty * 0.93),
        } as unknown as Prisma.InputJsonValue,
        bomItems: [
          { type: 'fabric', name: `Main fabric for ${l.styleNo}`, qty: 1.6, unit: 'm' },
          { type: 'trim', name: 'YKK invisible zipper 5#', qty: 1, unit: 'pc' },
          { type: 'trim', name: 'Woven main label', qty: 1, unit: 'pc' },
        ] as unknown as Prisma.InputJsonValue,
        tolerancePercent: new Prisma.Decimal(5),
      });
    });
  }
  await createManyLogged(prisma, 'order', 'Order', orderRows);
  await createManyLogged(prisma, 'orderLine', 'OrderLine', lineRows);

  // 3. OrderStatusTransition（每次流转审计）
  const transitionRows: Prisma.OrderStatusTransitionUncheckedCreateInput[] = [];
  for (const p of plans) {
    const chain: Array<[string, string, number | undefined, string]> = [];
    if (p.confirmMs) chain.push(['Pending', 'Confirmed', p.confirmMs, p.salesName]);
    if (p.prodStartMs) chain.push(['Confirmed', 'Production', p.prodStartMs, ['Grace Liu', 'Tony Fang', 'Ivy Zhang'][p.idx % 3]]);
    if (p.shipMs) chain.push(['Production', 'Shipping', p.shipMs, 'Hank Zheng']);
    if (p.deliveredMs) chain.push(['Shipping', 'Delivered', p.deliveredMs, 'Hank Zheng']);
    chain.forEach(([from, to, ms, operator], i) => {
      transitionRows.push({
        id: `${p.id}-T${i + 1}`, orderId: p.id, fromStatus: from, toStatus: to,
        note: `${from} → ${to}（剧情回填）`, operator,
        createdAt: BigInt(ms ?? p.createdAtMs),
      });
    });
  }
  await createManyLogged(prisma, 'orderStatusTransition', 'OrderStatusTransition', transitionRows);

  // 4. ProductionStage（10 阶段；Delivered=全 10 done，Production=部分，Shipping=全 done）
  const stageRows: Prisma.ProductionStageUncheckedCreateInput[] = [];
  const checklistRows: Prisma.PreCutChecklistUncheckedCreateInput[] = [];
  for (const p of plans) {
    if (p.fate !== 'Delivered' && p.fate !== 'Shipping' && p.fate !== 'Production') continue;
    const totalDone = p.fate === 'Production' ? (p.stageDone ?? 0) : 10;
    const span = (p.shipMs ?? p.createdAtMs + 20 * DAY) - (p.prodStartMs ?? p.createdAtMs);
    STAGE_KEYS.forEach((key, si) => {
      const seq = si + 1;
      const startMs = (p.prodStartMs ?? p.createdAtMs) + Math.floor((span / 10) * si);
      const doneMs = startMs + Math.floor(span / 10) - 3600 * 1000;
      const status = seq <= totalDone ? 'done' : (seq === totalDone + 1 ? 'in_progress' : 'pending');
      stageRows.push({
        id: `PST__${p.id}__${key}`, orderId: p.id, stageKey: key, stageSeq: seq, status,
        note: seq <= totalDone ? '剧情回填完成' : null,
        operator: status === 'pending' ? null : MERCH_IDS[p.idx % 3],
        startedAt: status === 'pending' ? null : BigInt(startMs),
        doneAt: status === 'done' ? BigInt(doneMs) : null,
        // 产前样双签（stage 7 done 时由 QC 侧 + 业务侧签）
        signedByProduction: seq === 7 && status === 'done' ? USERS.qc : null,
        signedByBusiness: seq === 7 && status === 'done' ? USERS.salesManager : null,
        signedAtProduction: seq === 7 && status === 'done' ? BigInt(doneMs) : null,
        signedAtBusiness: seq === 7 && status === 'done' ? BigInt(doneMs) : null,
        createdAt: BigInt(startMs), updatedAt: BigInt(status === 'done' ? doneMs : startMs),
      });
      if (key === 'pre_cut_checked' && status === 'done') {
        checklistRows.push({
          id: `PCL__${p.id}`, orderId: p.id, gradingConfirmed: true, consumptionConfirmed: true,
          patternConfirmed: true, preProductionMeeting: true,
          meetingNote: '产前会议：尺寸表/辅料/包装确认，无遗留问题。',
          confirmedBy: USERS.qc, confirmedAt: BigInt(doneMs),
          createdAt: BigInt(startMs), updatedAt: BigInt(doneMs),
        });
      }
    });
  }
  await createManyLogged(prisma, 'productionStage', 'ProductionStage', stageRows);
  await createManyLogged(prisma, 'preCutChecklist', 'PreCutChecklist', checklistRows);

  // 5. InspectionReport（Final QC；Delivered/Shipping 全过；Delivered 前 10 单补 midline）
  const inspectionRows: Prisma.InspectionReportUncheckedCreateInput[] = [];
  for (const p of plans) {
    if (p.fate !== 'Delivered' && p.fate !== 'Shipping') continue;
    const atMs = (p.shipMs ?? p.createdAtMs) - 2 * DAY;
    inspectionRows.push({
      id: `INR__${p.id}`, orderId: p.id, inspectionType: 'final',
      totalUnits: p.totalQty, passedUnits: p.totalQty - Math.round(p.totalQty * 0.012),
      inspectionDate: isoDate(atMs), inspectorOrg: p.idx % 3 === 0 ? 'SGS' : '自有 QC',
      aqlLevel: '2.5/4.0 II', lotSize: p.totalQty, sampleSize: Math.max(125, Math.round(p.totalQty * 0.008)),
      criticalDefects: 0, majorDefects: Math.round(p.totalQty * 0.008), minorDefects: Math.round(p.totalQty * 0.004),
      defectSummary: '线头少量 / 轻微色差，均在 AQL 允许范围', result: 'pass',
      inspectedBy: 'Wilson Wu', approvedByBusiness: true, businessApprover: 'Vivian Chen',
      approvedAt: BigInt(atMs + 6 * 3600 * 1000),
      signatures: {
        qcSignedAt: isoDate(atMs), qcSignerId: USERS.qc,
        businessSignedAt: isoDate(atMs), businessSignerId: USERS.salesManager,
      } as unknown as Prisma.InputJsonValue,
      notes: '出货前终验通过，准予放行。', createdAt: BigInt(atMs), updatedAt: BigInt(atMs),
    });
    if (p.idx < 10) {
      const midMs = (p.prodStartMs ?? p.createdAtMs) + 12 * DAY;
      inspectionRows.push({
        id: `INR__${p.id}__midline`, orderId: p.id, inspectionType: 'midline',
        totalUnits: Math.round(p.totalQty * 0.5), passedUnits: Math.round(p.totalQty * 0.5) - 6,
        inspectionDate: isoDate(midMs), inspectorOrg: '自有 QC', aqlLevel: '2.5/4.0 II',
        lotSize: Math.round(p.totalQty * 0.5), sampleSize: 80, criticalDefects: 0,
        majorDefects: 4, minorDefects: 2, defectSummary: '针距不均 2 处，已现场整改', result: 'conditional',
        inspectedBy: 'Wilson Wu', approvedByBusiness: true, businessApprover: 'Vivian Chen',
        approvedAt: BigInt(midMs + 6 * 3600 * 1000), signatures: {} as unknown as Prisma.InputJsonValue,
        notes: '中期验货有条件通过，尾部复确认。', createdAt: BigInt(midMs), updatedAt: BigInt(midMs),
      });
    }
  }
  await createManyLogged(prisma, 'inspectionReport', 'InspectionReport', inspectionRows);

  // 6. 出运链：Shipment + Line + Allocation + Batch + Event + Carton(+Item)
  const shipPlans = plans.filter((p) => p.fate === 'Delivered' || p.fate === 'Shipping');
  const shipmentRows: Prisma.ShipmentUncheckedCreateInput[] = [];
  const shipLineRows: Prisma.ShipmentLineUncheckedCreateInput[] = [];
  const shipAllocRows: Prisma.ShipmentOrderAllocationUncheckedCreateInput[] = [];
  const batchRows: Prisma.OrderShipmentBatchUncheckedCreateInput[] = [];
  const eventRows: Prisma.ShipmentEventUncheckedCreateInput[] = [];
  const cartonRows: Prisma.ShipmentCartonUncheckedCreateInput[] = [];
  const cartonItemRows: Prisma.ShipmentCartonItemUncheckedCreateInput[] = [];
  const invoiceRowMap = new Map<string, Prisma.InvoiceUncheckedCreateInput>();
  const ioaRows: Prisma.InvoiceOrderAllocationUncheckedCreateInput[] = [];
  const voucherRows: Prisma.PaymentVoucherUncheckedCreateInput[] = [];
  const allocRows: Prisma.InvoiceAllocationUncheckedCreateInput[] = [];

  shipPlans.forEach((p, spi) => {
    const cust = CUSTOMERS[p.idx % 8];
    const fwd = FORWARDERS[p.idx % 2];
    const shipmentId = `SIM-SHP-${String(4001 + spi)}`;
    const isDelivered = p.fate === 'Delivered';
    const packages = Math.max(2, Math.ceil(p.totalQty / 240));
    const gross = round2(p.totalQty * 0.38);
    shipmentRows.push({
      id: shipmentId, shipmentNumber: `SIM-SHP-${String(4001 + spi)}`,
      type: 'Export', status: isDelivered ? 'Delivered' : 'Shipped',
      shippingMethod: p.idx % 6 === 0 ? 'Air' : 'Sea',
      bookingDate: isoDate((p.shipMs ?? p.createdAtMs) - 7 * DAY),
      etd: isoDate(p.shipMs ?? p.createdAtMs), atd: isDelivered || p.fate === 'Shipping' ? isoDate(p.shipMs ?? p.createdAtMs) : null,
      eta: isoDate(p.etaMs ?? p.deliveredMs ?? p.createdAtMs), ata: isDelivered ? isoDate(p.deliveredMs ?? p.createdAtMs) : null,
      vesselOrFlight: p.idx % 6 === 0 ? `CA flight CA${600 + (p.idx % 40)}` : `MV PACULAR ${['STAR', 'DAWN', 'TIDE', 'PEARL'][p.idx % 4]}`,
      voyageNumber: p.idx % 6 === 0 ? null : `V.${String(20 + (p.idx % 9))}E`,
      portOfLoading: 'Shanghai', portOfDischarge: PORT_BY_COUNTRY[cust.country] ?? 'Shanghai',
      containerNumber: p.idx % 6 === 0 ? null : `MSCU${7000000 + spi * 137}`,
      sealNumber: p.idx % 6 === 0 ? null : `SL${String(88200 + spi)}`,
      trackingNumber: `SIM-TRK-${String(900 + spi)}`,
      totalPackages: packages, grossWeight: new Prisma.Decimal(gross),
      netWeight: new Prisma.Decimal(round2(gross * 0.86)), volume: new Prisma.Decimal(round2(packages * 0.096)),
      freightAmount: new Prisma.Decimal(round2(1200 + packages * 12)), freightCurrency: 'USD',
      customsAmount: new Prisma.Decimal(320), customsCurrency: 'CNY',
      orderId: p.id, customerRelationId: p.customerId, customerName: p.customerName,
      carrierRelationId: fwd.id, carrierName: fwd.name,
      consigneeRelationId: p.customerId, consigneeName: p.customerName,
      payerRelationId: p.customerId, payerName: p.customerName,
      hsCode: HS_BY_CATEGORY[p.linePlans[0].category] ?? '6204.43.00',
      customsBroker: '上海华港报关行', notes: isDelivered ? '已签收结案。' : '在途，预计到港后清关派送。',
      createdAt: BigInt((p.shipMs ?? p.createdAtMs) - 7 * DAY), updatedAt: BigInt(p.deliveredMs ?? p.shipMs ?? p.createdAtMs),
      deletedAt: null,
    });
    p.linePlans.forEach((l, li) => {
      shipLineRows.push({
        id: `${shipmentId}-SL${li + 1}`, shipmentId, lineNumber: li + 1, orderLineId: l.lineId,
        productCode: l.styleNo, productName: `Ladies' ${l.category}`, colorCode: l.color,
        quantity: new Prisma.Decimal(l.qty), unit: 'PCS',
        cartons: Math.max(1, Math.ceil(l.qty / 240)), grossWeight: new Prisma.Decimal(round2(l.qty * 0.38)),
        netWeight: new Prisma.Decimal(round2(l.qty * 0.33)), volume: new Prisma.Decimal(round2(Math.ceil(l.qty / 240) * 0.096)),
        hsCode: HS_BY_CATEGORY[l.category] ?? '6204.43.00', countryOfOrigin: 'China',
        createdAt: BigInt(p.shipMs ?? p.createdAtMs), updatedAt: BigInt(p.shipMs ?? p.createdAtMs),
      });
    });
    shipAllocRows.push({
      id: `${shipmentId}-SA1`, shipmentId, orderId: p.id, orderLineId: null,
      plannedQty: new Prisma.Decimal(p.totalQty), actualQty: new Prisma.Decimal(p.totalQty),
      unit: 'PCS', status: 'Fulfilled',
      createdAt: BigInt(p.shipMs ?? p.createdAtMs), updatedAt: BigInt(p.deliveredMs ?? p.shipMs ?? p.createdAtMs),
    });
    // 批次（财务侧）—— Delivered 单按交期分流（common.deliveredFinance 真源）：
    // 交期未来 = 定金/零收款（提前出运合法但交易周期未完），交期已过 = 全额结清
    const fin: DeliveredFinance | null = isDelivered ? deliveredFinance(p) : null;
    const paidAmount = fin ? round2(p.amount * fin.paidRatio) : (p.idx % 2 === 0 ? round2(p.amount * 0.3) : 0);
    const settleStatus = fin ? fin.settleStatus : (paidAmount > 0 ? 'partially_settled' : 'unsettled');
    batchRows.push({
      id: `SIM-OSB-${String(5001 + spi)}`, orderId: p.id, shipmentId,
      batchNo: 1, plannedRatio: new Prisma.Decimal(100), plannedQty: new Prisma.Decimal(p.totalQty),
      unit: 'PCS', amount: new Prisma.Decimal(p.amount), currency: p.currency,
      customerRelationId: p.customerId, customerName: p.customerName,
      status: 'shipped', shippedAt: BigInt(p.shipMs ?? p.createdAtMs),
      settleStatus, invoicedAmount: new Prisma.Decimal(p.amount), paidAmount: new Prisma.Decimal(paidAmount),
      settledAt: settleStatus === 'settled' ? BigInt((p.deliveredMs ?? p.shipMs ?? p.createdAtMs) + 5 * DAY) : null,
      isFinalBatch: true, finalPaymentDueDays: 30, finalPaymentDueDate: isoDate((p.shipMs ?? p.createdAtMs) + 30 * DAY),
      notes: null, createdAt: BigInt(p.createdAtMs), updatedAt: BigInt(p.deliveredMs ?? p.shipMs ?? p.createdAtMs),
      deletedAt: null,
    });
    // 物流事件
    const evChain: Array<[string, string, number | undefined, string | null]> = [
      ['Booked', '订舱确认', (p.shipMs ?? p.createdAtMs) - 7 * DAY, USERS.logistics],
      ['Loading', '装货完成', (p.shipMs ?? p.createdAtMs) - 1 * DAY, USERS.logistics],
      ['Shipped', '已发运', p.shipMs, USERS.logistics],
      ...(isDelivered
        ? [
            ['Arrived', '到港', p.deliveredMs ? p.deliveredMs - 3 * DAY : undefined, USERS.logistics] as [string, string, number | undefined, string | null],
            ['Cleared', '清关放行', p.deliveredMs ? p.deliveredMs - 1 * DAY : undefined, USERS.logistics] as [string, string, number | undefined, string | null],
            ['Delivered', '签收交付', p.deliveredMs, USERS.logistics] as [string, string, number | undefined, string | null],
          ]
        : []),
    ];
    evChain.forEach(([node, note, ms, actor], ei) => {
      eventRows.push({
        id: `${shipmentId}-EV${ei + 1}`, shipmentId, fromNode: ei === 0 ? null : evChain[ei - 1][0],
        toNode: node, eventDate: isoDate(ms ?? p.createdAtMs), note, actorId: actor,
        createdAt: BigInt(ms ?? p.createdAtMs),
      });
    });
    // 装箱：每行平分 2 箱
    p.linePlans.forEach((l, li) => {
      for (let c = 0; c < 2; c++) {
        const cartonId = `${shipmentId}-CT${c + 1}`;
        if (li === 0) {
          cartonRows.push({
            id: cartonId, shipmentId, cartonNo: `${c + 1}-${c + 1 + Math.max(1, Math.ceil(p.totalQty / 480))}`,
            description: `Ladies' garments SS26 (${p.code})`,
            length: new Prisma.Decimal(60), width: new Prisma.Decimal(40), height: new Prisma.Decimal(40),
            grossWeight: new Prisma.Decimal(round2((p.totalQty / 2) * 0.38)),
            netWeight: new Prisma.Decimal(round2((p.totalQty / 2) * 0.33)), volume: new Prisma.Decimal(0.096),
            createdAt: BigInt(p.shipMs ?? p.createdAtMs), updatedAt: BigInt(p.shipMs ?? p.createdAtMs),
          });
        }
        cartonItemRows.push({
          id: `${cartonId}-I${li + 1}`, cartonId, shipmentLineId: `${shipmentId}-SL${li + 1}`,
          quantity: new Prisma.Decimal(Math.floor(l.qty / 2)),
          createdAt: BigInt(p.shipMs ?? p.createdAtMs), updatedAt: BigInt(p.shipMs ?? p.createdAtMs),
        });
      }
    });
    // 发票（出货即开票）—— 状态随 fin 分流：paid=Paid / overdue·deposit=PartiallyPaid / issued=Issued；
    // Shipping 单（fin=null）2026-09-02 修复：idx 偶数单已收 30% 定金并核销（有 InvoiceAllocation），
    // 发票状态必须 PartiallyPaid——「Issued 发票带核销」是财务状态机违例（审计 SIM-INV-2035/2037）。
    const invoiceId = `SIM-INV-${String(2001 + spi)}`;
    invoiceRowMap.set(p.id, {
      id: invoiceId, invoiceNumber: `SIM-INV-${String(2001 + spi)}`,
      type: 'Receivable', status: fin ? fin.invoiceStatus : (paidAmount > 0 ? 'PartiallyPaid' : 'Issued'),
      amount: new Prisma.Decimal(p.amount), currency: p.currency,
      issueDate: isoDate(p.shipMs ?? p.createdAtMs),
      dueDate: isoDate((p.shipMs ?? p.createdAtMs) + 30 * DAY),
      settlementDate: fin?.kind === 'paid' ? isoDate((p.deliveredMs ?? p.shipMs ?? p.createdAtMs) + 3 * DAY) : null,
      exchangeRate: new Prisma.Decimal(p.currency === 'EUR' ? EUR_CNY_RATE : USD_CNY_RATE), baseCurrency: 'CNY',
      orderId: p.id, customerRelationId: p.customerId, customerName: p.customerName,
      notes: !fin
        ? '见提单副本后 30 天付款。'
        : fin.kind === 'paid' ? '货已签收。'
        : fin.kind === 'overdue' ? '货已签收，尾款逾期催收中。'
        : fin.kind === 'deposit' ? '货已签收（提前出运），定金 30% 已收，尾款待付。'
        : '货已签收（提前出运），开票待收款。',
      ownerId: USERS.financeManager, departmentId: null,
      createdAt: BigInt(p.shipMs ?? p.createdAtMs), updatedAt: BigInt(p.deliveredMs ?? p.shipMs ?? p.createdAtMs),
      deletedAt: null,
    });
    ioaRows.push({
      id: `SIM-IOA-${String(7001 + spi)}`, invoiceId, orderId: p.id,
      orderNumber: p.code, poNumber: p.poNumber, allocatedAmount: new Prisma.Decimal(p.amount),
      batchId: `SIM-OSB-${String(5001 + spi)}`, note: '整单口径开票',
      createdAt: BigInt(p.shipMs ?? p.createdAtMs), updatedAt: BigInt(p.shipMs ?? p.createdAtMs), deletedAt: null,
    });
    if (paidAmount > 0) {
      const voucherId = `SIM-PAY-${String(3001 + spi)}`;
      // 凭证时间随 fin 分流：paid=交付+3 天；overdue=发运+12 天；deposit=开票+6 天定金（与 Shipping 单同口径）
      const payMs = fin
        ? (fin.kind === 'overdue' ? (p.shipMs ?? p.createdAtMs) + 12 * DAY
          : fin.kind === 'paid' ? (p.deliveredMs ?? p.shipMs ?? p.createdAtMs) + 3 * DAY
          : (p.shipMs ?? p.createdAtMs) + 6 * DAY)
        : (p.shipMs ?? p.createdAtMs) + 6 * DAY;
      voucherRows.push({
        id: voucherId, voucherNumber: `SIM-PAY-${String(3001 + spi)}`,
        type: 'Receipt', voucherCategory: 'normal',
        amount: new Prisma.Decimal(paidAmount), currency: p.currency,
        paymentDate: isoDate(payMs), paymentMethod: 'TT',
        // 凭证状态看自身核销进度（amount=appliedAmount=实收额 → 已全额核销）；发票层「部分收款/尾款待付」由 Invoice 状态表达，二者不可混
        status: 'reconciled',
        bankFee: new Prisma.Decimal(25), exchangeRate: new Prisma.Decimal(p.currency === 'EUR' ? EUR_CNY_RATE : USD_CNY_RATE),
        baseCurrency: 'CNY', invoiceId, appliedAmount: new Prisma.Decimal(paidAmount),
        orderId: p.id, customerRelationId: p.customerId, customerName: p.customerName,
        notes: fin?.kind === 'paid' ? '货款全额到账并核销。'
          : fin?.kind === 'deposit' ? '定金 30% 到账，尾款待付。'
          : '部分货款到账，余款挂账。',
        ownerId: USERS.finance, departmentId: null,
        createdAt: BigInt(payMs), updatedAt: BigInt(payMs), deletedAt: null,
      });
      allocRows.push({
        id: `SIM-ALLOC-${String(8001 + spi)}`, invoiceId, voucherId,
        appliedAmount: new Prisma.Decimal(paidAmount), appliedDate: isoDate(payMs),
        createdAt: BigInt(payMs), updatedAt: BigInt(payMs),
      });
    }
  });

  // Production / Confirmed 订单：批次计划（planned，未排船）
  const planOnlyPlans = plans.filter((p) => p.fate === 'Production' || p.fate === 'Confirmed');
  planOnlyPlans.forEach((p, ppi) => {
    batchRows.push({
      id: `SIM-OSB-P${String(501 + ppi)}`, orderId: p.id, shipmentId: null,
      batchNo: 1, plannedRatio: new Prisma.Decimal(100), plannedQty: new Prisma.Decimal(p.totalQty),
      unit: 'PCS', amount: new Prisma.Decimal(p.amount), currency: p.currency,
      customerRelationId: p.customerId, customerName: p.customerName,
      status: 'planned', shippedAt: null, settleStatus: 'unsettled',
      invoicedAmount: new Prisma.Decimal(0), paidAmount: new Prisma.Decimal(0),
      isFinalBatch: true, finalPaymentDueDays: 30, finalPaymentDueDate: null,
      notes: '接单即建批次计划，未排船。', createdAt: BigInt(p.createdAtMs),
      updatedAt: BigInt(p.createdAtMs), deletedAt: null,
    });
  });

  await createManyLogged(prisma, 'shipment', 'Shipment', shipmentRows);
  await createManyLogged(prisma, 'shipmentLine', 'ShipmentLine', shipLineRows);
  await createManyLogged(prisma, 'shipmentOrderAllocation', 'ShipmentOrderAllocation', shipAllocRows);
  await createManyLogged(prisma, 'orderShipmentBatch', 'OrderShipmentBatch', batchRows);
  await createManyLogged(prisma, 'shipmentEvent', 'ShipmentEvent', eventRows);
  await createManyLogged(prisma, 'shipmentCarton', 'ShipmentCarton', cartonRows);
  await createManyLogged(prisma, 'shipmentCartonItem', 'ShipmentCartonItem', cartonItemRows);

  // 7. 财务链：Invoice + IOA + PaymentVoucher + InvoiceAllocation
  await createManyLogged(prisma, 'invoice', 'Invoice', [...invoiceRowMap.values()]);
  await createManyLogged(prisma, 'invoiceOrderAllocation', 'InvoiceOrderAllocation', ioaRows);
  await createManyLogged(prisma, 'paymentVoucher', 'PaymentVoucher', voucherRows);
  await createManyLogged(prisma, 'invoiceAllocation', 'InvoiceAllocation', allocRows);

  // 8. 催款：3 单逾期 DunningRecord + 对应客户 DunningProfile
  const overduePlans = plans.filter((p) => p.overdue);
  const dunningRows: Prisma.DunningRecordUncheckedCreateInput[] = [];
  const dunningProfileRows: Prisma.DunningProfileUncheckedCreateInput[] = [];
  overduePlans.forEach((p, di) => {
    const daysOver = Math.max(1, Math.round((Date.UTC(2026, 7, 30) - (p.dueMs ?? p.createdAtMs)) / DAY));
    const stage = daysOver > 20 ? 'firm' : 'reminder';
    dunningRows.push({
      id: `SIM-DUN-${String(601 + di)}`, customerRelationId: p.customerId, customerName: p.customerName,
      currency: p.currency, totalOverdue: new Prisma.Decimal(round2(p.amount * 0.5)), invoiceCount: 1,
      agingBuckets: {
        current: 0, d1_30: daysOver <= 30 ? round2(p.amount * 0.5) : 0,
        d31_60: daysOver > 30 && daysOver <= 60 ? round2(p.amount * 0.5) : 0,
        d61_90: daysOver > 60 ? round2(p.amount * 0.5) : 0, d90plus: 0,
      } as unknown as Prisma.InputJsonValue,
      channel: 'email', result: di === 0 ? 'promised' : 'sent', stage,
      note: `尾款逾期 ${daysOver} 天，已发送催款函（${p.poNumber}）。`,
      operator: 'Melissa Zhao', createdAt: BigInt(Date.UTC(2026, 7, 20) + di * 2 * DAY),
    });
    dunningProfileRows.push({
      id: `SIM-DNP-${String(601 + di)}`,
      scopeKey: `rel:${p.customerId}:${p.currency}`, customerRelationId: p.customerId,
      customerName: p.customerName, currency: p.currency,
      stage, stageSource: 'auto', stageSince: BigInt(Date.UTC(2026, 7, 18)),
      autoStage: stage, escalatedAt: stage === 'firm' ? BigInt(Date.UTC(2026, 7, 18)) : null,
      downgradedAt: null, lastScanAt: BigInt(Date.UTC(2026, 7, 29, 2)),
      ownerName: p.salesName, createdAt: BigInt(Date.UTC(2026, 7, 18)), updatedAt: BigInt(Date.UTC(2026, 7, 29, 2)),
    });
  });
  await createManyLogged(prisma, 'dunningRecord', 'DunningRecord', dunningRows);
  await createManyLogged(prisma, 'dunningProfile', 'DunningProfile', dunningProfileRows);

  return { plans, overduePlans };
}
