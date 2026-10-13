/**
 * company-sim/fabric-orders.ts — 面料外销业务线（13 单，成衣主线之外的第二条销售链）
 *
 * 剧情（确定性）：
 *   - 13 张 Fabric 类型订单（SIM-FORD-001..013 / SIM-SO-901..913 / 客户 PO FO-2606xx）：
 *     现有海外客户直接采购面料（8 家客户轮转），面料厂（SIM-SUP-01..04，master-data
 *     fabricAssets.millRelId 真源）织染后直发；
 *   - 生命周期（13 周窗口 2026-06-08~08-30）：W1-W6 7 单 Delivered（完整链）+
 *     W8/W9 2 单 Shipping（在途已开票）+ W10/W11 2 单 Production（织造/染缸中）+
 *     W12 1 单 Confirmed + W13 1 单 Pending；
 *   - idx1 / idx4 两张 Delivered 挂 DunningRecord 逾期半款（与成衣 3 单并存；
 *     客户 Nordic/Willow 与成衣逾期客户 Maple/Sakura/Aurora 错开，不撞
 *     DunningProfile scopeKey）；
 *   - idx3 缸差扣款剧情：终期验布 conditional（整缸色差 3-4 级）→ 发票/回款 =
 *     订单额 × 97%（QC 缸差索赔 3%），Invoice/批次备注留痕（喂 QC/质量域演示）；
 *   - idx5 30,000m 大单分批出运 2 票（70% / 30%，双批次双发票；交期未来 → 每票 30% 定金在途）；
 *   - 面料单无成衣 10 阶段生产链 / 样衣阶段；Delivered/Shipping 单有终期验布
 *     InspectionReport（final，qc-tr 统一指派 QCAssignment）+ 全程
 *     OrderStatusTransition 审计流转。
 *
 * 单位口径：Meter（OrderLine / ShipmentLine / 批次 / 报关行一致）。
 * 价格口径：ProductAsset.cost（CNY/m，真源）÷ USD_CNY_RATE(6.74) × 1.42 折 FOB USD/m，EUR 客户再 ÷1.08。
 * ID 范式：SIM- 前缀确定性 ID，段位与成衣链避让（FSHP/FOSB/FINV/FIOA/FPAY/FALLOC/DUN-61x）。
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { at, isoDate, round2, createManyLogged, USERS, SALES_POOL, SALES_NAME, SIM_END, deliveredFinance, USD_CNY_RATE, EUR_CNY_RATE, type DeliveredFinance } from './common';
import { CUSTOMERS, SUPPLIERS, type MasterDataCtx, SUPPLIER_ADDR, customerAddrById } from './master-data';

const DAY = 24 * 3600 * 1000;

type FabricFate = 'Delivered' | 'Shipping' | 'Production' | 'Confirmed' | 'Pending';

const FABRIC_ORDER_COUNT = 13;
/** 逾期半款 + Dunning：idx1（Nordic EUR，firm）/ idx4（Willow & Wren USD，reminder） */
const OVERDUE_FABRIC_IDX = new Set([1, 4]);
/** 缸差扣款剧情：idx3（发票 = 订单额 × 97%） */
const SHADE_DEDUCTION_IDX = 3;
/** 分批出运 2 票大单：idx5（30,000m，70% / 30%） */
const SPLIT_SHIPMENT_IDX = 5;
/** 面料赢单报价覆盖的订单 idx（quotations.ts 消费：3 张赢单转面料订单） */
export const FABRIC_WON_QUOTE_IDX = new Set([2, 7, 11]);

function fateOf(idx: number): FabricFate {
  if (idx <= 6) return 'Delivered';
  if (idx <= 8) return 'Shipping';
  if (idx <= 10) return 'Production';
  if (idx === 11) return 'Confirmed';
  return 'Pending';
}
function weekOf(idx: number): number {
  return [1, 2, 3, 4, 5, 6, 6, 8, 9, 10, 11, 12, 13][idx];
}

const FABRIC_COLORS = [
  'Natural White', 'Indigo', 'Charcoal', 'Dusty Rose', 'Sage',
  'Sky Blue', 'Camel', 'Ivory', 'Terracotta', 'Classic Navy',
];
const PORT_BY_COUNTRY: Record<string, string> = {
  US: 'Los Angeles', DE: 'Hamburg', JP: 'Tokyo', AU: 'Melbourne',
  FR: 'Le Havre', GB: 'Felixstowe', IT: 'Genoa', CN: 'Shanghai',
};

/** 面料 HS 编码（行级真源）：梭织棉 5208 / 梭织化纤 5407 / 针织棉 6006.21 / 针织化纤 6006.32 */
function fabricHsCode(fabIdx: number): string {
  if (fabIdx < 12) return fabIdx % 2 === 0 ? '5208.52.00' : '5407.61.00';
  return fabIdx % 2 === 0 ? '6006.21.00' : '6006.32.00';
}

export interface FabricLinePlan {
  lineId: string;
  garmentId: string; // ''（面料单无成衣档案；占位保持与 OrderPlan 行结构同构，供下游鸭子类型消费）
  sku: string;
  styleNo: string;
  qty: number;
  price: number;
  netValue: number;
  color: string;
  category: string; // 'Fabric'
  description: string;
  hsCode: string;
  unit: string; // 'Meter'
  kgPerUnit: number; // 毛重 kg/m（净重按 ×0.875，与 trade-docs 报关行口径一致）
}

interface FabricShipLeg {
  ratio: number; // 占订单数量比例（1 或 0.7/0.3）
  qty: number;
  amount: number; // 该票订单额（按行金额比例摊）
  shipMs: number;
  deliveredMs: number | null; // Delivered 单到货；Shipping 单为 null
}

export interface FabricOrderPlan {
  idx: number;
  id: string;
  code: string;
  poNumber: string;
  fate: FabricFate;
  week: number;
  createdAtMs: number;
  salesId: string;
  salesName: string;
  customerId: string;
  customerName: string;
  currency: string;
  country: string;
  factoryId: string;
  factoryName: string;
  totalQty: number;
  amount: number;
  dueDate: string;
  dueMs: number;
  linePlans: FabricLinePlan[];
  confirmMs?: number;
  prodStartMs?: number;
  shipMs?: number;
  deliveredMs?: number;
  etaMs?: number;
  overdue?: boolean; // Delivered 逾期半款（挂 Dunning）
  shadeDeduction?: boolean; // 缸差索赔 3%（发票 = 订单额 × 97%）
  legs?: FabricShipLeg[]; // 出运票（分批单 2 票，其余 1 票）
}

export interface FabricOrdersOutcome {
  fabricPlans: FabricOrderPlan[];
}

/** 面料外销单判别（下游模块共用：采购/QC 测试/成衣报价排除面料单，报关/审计/CRM/信用额度自然并入） */
export function isFabricPlan(p: { id: string }): boolean {
  return p.id.startsWith('SIM-FORD-');
}

export async function seedFabricOrders(prisma: PrismaClient, md: MasterDataCtx): Promise<FabricOrdersOutcome> {
  console.log('── 面料外销订单 13 单（Fabric 业务线全链） ──');

  // ── 1. 生成 13 单计划 ──
  const plans: FabricOrderPlan[] = [];
  const supplierById = new Map(SUPPLIERS.map((s) => [s.id, s] as const));
  for (let idx = 0; idx < FABRIC_ORDER_COUNT; idx++) {
    const fate = fateOf(idx);
    const week = weekOf(idx);
    const id = `SIM-FORD-${String(idx + 1).padStart(3, '0')}`;
    const code = `SIM-FSO-${String(901 + idx)}`;
    const poNumber = `FO-2606${String(idx + 1).padStart(2, '0')}`;
    const salesId = SALES_POOL[idx % 3];
    const cust = CUSTOMERS[(idx * 7 + 2) % 8];
    const createdMs = at(week, 2 + (idx % 3), 9 + (idx % 3), (idx * 13) % 50);
    const atDay = (addDays: number) => {
      const t = new Date(createdMs);
      return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + addDays, 9, (idx * 11) % 60);
    };

    const lineCount = idx % 3 === 0 ? 2 : 1;
    const linePlans: FabricLinePlan[] = [];
    for (let li = 0; li < lineCount; li++) {
      const fabIdx = (idx * 5 + li * 11) % 24;
      const fabric = md.fabricAssets[fabIdx];
      const costCny = round2(8.5 + (fabIdx % 8) * 2.3); // 与 master-data ProductAsset.cost 同构
      const price = round2((costCny / USD_CNY_RATE) * 1.42 / (cust.currency === 'EUR' ? 1.08 : 1));
      let qty = 5000 + ((idx * 4300 + li * 9700) % 25000);
      qty = Math.ceil(qty / 500) * 500;
      if (idx === SPLIT_SHIPMENT_IDX) qty = 30000; // 分批出运大单
      linePlans.push({
        lineId: `${id}-L${li + 1}`, garmentId: '', sku: fabric.sku, styleNo: fabric.sku,
        qty, price, netValue: round2(qty * price),
        color: FABRIC_COLORS[(idx + li) % FABRIC_COLORS.length],
        category: 'Fabric', description: `${fabric.name}（${FABRIC_COLORS[(idx + li) % FABRIC_COLORS.length]}）`,
        hsCode: fabricHsCode(fabIdx), unit: 'Meter', kgPerUnit: 0.32,
      });
    }
    const totalQty = linePlans.reduce((s, l) => s + l.qty, 0);
    const amount = round2(linePlans.reduce((s, l) => s + l.netValue, 0));
    const factory = supplierById.get(md.fabricAssets[(idx * 5) % 24].millRelId) ?? SUPPLIERS[0];
    const dueMs = atDay(60); // 面料交期 ~60 天（短于成衣 75 天）

    const plan: FabricOrderPlan = {
      idx, id, code, poNumber, fate, week, createdAtMs: createdMs,
      salesId, salesName: SALES_NAME[salesId],
      customerId: cust.id, customerName: cust.name, currency: cust.currency, country: cust.country,
      factoryId: factory.id, factoryName: factory.name,
      totalQty, amount, dueDate: isoDate(dueMs), dueMs, linePlans,
      overdue: OVERDUE_FABRIC_IDX.has(idx),
      shadeDeduction: idx === SHADE_DEDUCTION_IDX,
    };
    if (fate === 'Delivered') {
      plan.confirmMs = atDay(2);
      plan.prodStartMs = atDay(4);
      plan.shipMs = atDay(18);
      plan.deliveredMs = atDay(39); // ship + 21 天海运
    } else if (fate === 'Shipping') {
      plan.confirmMs = atDay(2);
      plan.prodStartMs = atDay(4);
      plan.shipMs = atDay(18);
      plan.etaMs = atDay(42); // ship + 24 天，未来到港
    } else if (fate === 'Production') {
      plan.confirmMs = atDay(2);
      plan.prodStartMs = atDay(4);
    } else if (fate === 'Confirmed') {
      plan.confirmMs = atDay(2);
    }
    plans.push(plan);
  }

  // ── 2. Order + OrderLine ──
  const orderRows: Prisma.OrderUncheckedCreateInput[] = [];
  const lineRows: Prisma.OrderLineUncheckedCreateInput[] = [];
  const statusByFate: Record<FabricFate, string> = {
    Delivered: 'Delivered', Shipping: 'Shipping', Production: 'Production', Confirmed: 'Confirmed', Pending: 'Pending',
  };
  for (const p of plans) {
    orderRows.push({
      id: p.id, code: p.code, poNumber: p.poNumber, customer: p.customerName,
      customerCode: p.customerId, customerRelationId: p.customerId,
      customerAddress: customerAddrById(p.customerId) || `Overseas (${p.customerName})`,
      // 2026-09-02 地图定位修复（同 orders.ts）：真实地址，城市名对齐 CityCoordinates
      millAddress: SUPPLIER_ADDR[p.factoryId] || undefined,
      consigneeAddress: customerAddrById(p.customerId) || undefined,
      millName: p.factoryName, millRelationId: p.factoryId,
      consigneeName: p.customerName, consigneeRelationId: p.customerId,
      billToName: p.customerName, billToRelationId: p.customerId, billToIsAgent: false,
      product: p.linePlans.map((l) => l.styleNo).join(' / '),
      type: 'Fabric', businessLine: 'fabric',
      quantity: p.totalQty, status: statusByFate[p.fate],
      dueDate: p.dueDate, clientDate: p.dueDate, quoteAmount: new Prisma.Decimal(p.amount),
      totalNet: new Prisma.Decimal(p.amount), totalActual: new Prisma.Decimal(p.amount),
      contractAmount: new Prisma.Decimal(p.amount),
      salesPerson: p.salesName, merchandiser: 'Ivy Zhang', // 面料跟单（苏州驻场，hr-kb 剧情对齐）
      season: 'SS26', poDate: isoDate(p.createdAtMs), source: 'manual',
      currency: p.currency, salesCurrency: p.currency, purchaseCurrency: 'CNY',
      deliveryTerms: 'FOB Shanghai', paymentTerms: 'T/T 30% deposit, 70% against B/L copy',
      paymentInstrument: 'T/T', salesContractNumber: `SIM-FSC-${String(901 + p.idx)}`,
      shipToName: p.customerName, shipToCountry: p.country, shipToAddress1: 'See customer master',
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
        materialCode: l.sku, description: l.description,
        quantity: new Prisma.Decimal(l.qty), unit: 'Meter', unitPrice: new Prisma.Decimal(l.price),
        netValue: new Prisma.Decimal(l.netValue), exMillDate: p.dueDate, deliveryDate: p.dueDate,
        status: statusByFate[p.fate], styleNo: l.styleNo, colorName: l.color,
        // sizeBreakdown/bomItems 不传（面料无尺码/BOM，落库 null）
        tolerancePercent: new Prisma.Decimal(3), // 面料数量允差 ±3%
      });
    });
  }
  await createManyLogged(prisma, 'order', 'Order（Fabric）', orderRows);
  await createManyLogged(prisma, 'orderLine', 'OrderLine（Fabric，Meter）', lineRows);

  // ── 3. OrderStatusTransition（审计流转；面料单无 10 阶段生产链） ──
  const transitionRows: Prisma.OrderStatusTransitionUncheckedCreateInput[] = [];
  for (const p of plans) {
    const chain: Array<[string, string, number | undefined, string]> = [];
    if (p.confirmMs) chain.push(['Pending', 'Confirmed', p.confirmMs, p.salesName]);
    if (p.prodStartMs) chain.push(['Confirmed', 'Production', p.prodStartMs, 'Ivy Zhang']);
    if (p.shipMs) chain.push(['Production', 'Shipping', p.shipMs, 'Hank Zheng']);
    if (p.deliveredMs) chain.push(['Shipping', 'Delivered', p.deliveredMs, 'Hank Zheng']);
    chain.forEach(([from, to, ms, operator], i) => {
      const note = p.idx === 9 && to === 'Production'
        ? 'Confirmed → Production（面料织造中，头缸色差复染处理中）'
        : `${from} → ${to}（面料外销剧情回填）`;
      transitionRows.push({
        id: `${p.id}-T${i + 1}`, orderId: p.id, fromStatus: from, toStatus: to,
        note, operator,
        createdAt: BigInt(ms ?? p.createdAtMs),
      });
    });
  }
  await createManyLogged(prisma, 'orderStatusTransition', 'OrderStatusTransition（Fabric）', transitionRows);

  // ── 4. InspectionReport（终期验布；Delivered/Shipping 单） ──
  const inspectionRows: Prisma.InspectionReportUncheckedCreateInput[] = [];
  for (const p of plans) {
    if (p.fate !== 'Delivered' && p.fate !== 'Shipping') continue;
    const atMs = (p.shipMs ?? p.createdAtMs) - 2 * DAY;
    const shade = !!p.shadeDeduction;
    inspectionRows.push({
      id: `INR__${p.id}`, orderId: p.id, inspectionType: 'final',
      totalUnits: p.totalQty, passedUnits: p.totalQty,
      inspectionDate: isoDate(atMs), inspectorOrg: '自有 QC',
      aqlLevel: '4.0（验布 4 分制）', lotSize: p.totalQty,
      sampleSize: Math.max(100, Math.round(p.totalQty * 0.02)),
      criticalDefects: 0,
      majorDefects: shade ? Math.round(p.totalQty * 0.004) : Math.round(p.totalQty * 0.001),
      minorDefects: Math.round(p.totalQty * 0.002),
      defectSummary: shade ? '整缸色差 3-4 级（客户标准 4 级），头尾差局部超标' : '轻微头尾差/边中差，均在允差范围',
      result: shade ? 'conditional' : 'pass',
      inspectedBy: 'Wilson Wu', approvedByBusiness: true, businessApprover: 'Vivian Chen',
      approvedAt: BigInt(atMs + 6 * 3600 * 1000),
      signatures: {
        qcSignedAt: isoDate(atMs), qcSignerId: USERS.qc,
        businessSignedAt: isoDate(atMs), businessSignerId: USERS.salesManager,
      } as unknown as Prisma.InputJsonValue,
      notes: shade ? '缸差索赔 3% 后客户书面接受放行，发票按订单额 97% 开具。' : '终期验布通过（4 分制），准予出运。',
      createdAt: BigInt(atMs), updatedAt: BigInt(atMs),
    });
  }
  await createManyLogged(prisma, 'inspectionReport', 'InspectionReport（Fabric 验布）', inspectionRows);

  // ── 5. 出运链：每 Delivered/Shipping 单 1 票（idx5 分批大单 2 票） ──
  interface LegBuild {
    plan: FabricOrderPlan;
    leg: FabricShipLeg;
    shipmentId: string;
    batchId: string;
    invoiceId: string;
    invoiceAmount: number;
    paidAmount: number;
    settleStatus: string;
    invoiceStatus: string;
    voucherStatus: string | null;
    fin: DeliveredFinance | null; // Delivered 单交期分流（null = Shipping 单）
  }
  const shipPlans = plans.filter((p) => p.fate === 'Delivered' || p.fate === 'Shipping');
  const shipmentRows: Prisma.ShipmentUncheckedCreateInput[] = [];
  const shipLineRows: Prisma.ShipmentLineUncheckedCreateInput[] = [];
  const shipAllocRows: Prisma.ShipmentOrderAllocationUncheckedCreateInput[] = [];
  const batchRows: Prisma.OrderShipmentBatchUncheckedCreateInput[] = [];
  const eventRows: Prisma.ShipmentEventUncheckedCreateInput[] = [];
  const cartonRows: Prisma.ShipmentCartonUncheckedCreateInput[] = [];
  const cartonItemRows: Prisma.ShipmentCartonItemUncheckedCreateInput[] = [];
  const invoiceRows: Prisma.InvoiceUncheckedCreateInput[] = [];
  const ioaRows: Prisma.InvoiceOrderAllocationUncheckedCreateInput[] = [];
  const voucherRows: Prisma.PaymentVoucherUncheckedCreateInput[] = [];
  const allocRows: Prisma.InvoiceAllocationUncheckedCreateInput[] = [];
  const legBuilds: LegBuild[] = [];

  let shipSeq = 0;
  for (const p of shipPlans) {
    const legs: FabricShipLeg[] = p.idx === SPLIT_SHIPMENT_IDX
      ? [
          { ratio: 0.7, qty: Math.round(p.totalQty * 0.7 / 100) * 100, amount: round2(p.amount * 0.7), shipMs: (p.shipMs!), deliveredMs: p.deliveredMs ?? null },
          { ratio: 0.3, qty: p.totalQty - Math.round(p.totalQty * 0.7 / 100) * 100, amount: round2(p.amount - round2(p.amount * 0.7)), shipMs: (p.shipMs!) + 7 * DAY, deliveredMs: (p.deliveredMs ?? 0) + 7 * DAY },
        ]
      : [{ ratio: 1, qty: p.totalQty, amount: p.amount, shipMs: p.shipMs!, deliveredMs: p.deliveredMs ?? null }];
    for (const leg of legs) {
      shipSeq += 1;
      const shipmentId = `SIM-FSHP-${String(9000 + shipSeq)}`;
      const batchId = `SIM-FOSB-${String(9000 + shipSeq)}`;
      const invoiceId = `SIM-FINV-${String(9000 + shipSeq)}`;
      // 该票开票额：缸差单索赔 3% 后按票金额比例摊
      const legInvoiceAmount = p.shadeDeduction ? round2(leg.amount * 0.97) : leg.amount;
      const isDelivered = p.fate === 'Delivered';
      // Delivered 单按交期分流（common.deliveredFinance 真源）：交期未来 = 定金/零收款，交期已过 = 全额结清
      const fin: DeliveredFinance | null = isDelivered ? deliveredFinance(p) : null;
      const paidAmount = fin
        ? round2(legInvoiceAmount * fin.paidRatio)
        : (p.idx % 2 === 0 ? round2(legInvoiceAmount * 0.3) : 0);
      const settleStatus = fin ? fin.settleStatus : (paidAmount > 0 ? 'partially_settled' : 'unsettled');
      // 2026-09-02 修复：Shipping 单（fin=null）idx 偶数已收 30% 定金并核销（有 InvoiceAllocation），
      // 发票状态必须 PartiallyPaid——「Issued 发票带核销」是财务状态机违例（审计 SIM-FINV-9010）。
      const invoiceStatus = fin ? fin.invoiceStatus : (paidAmount > 0 ? 'PartiallyPaid' : 'Issued');
      const voucherStatus = fin ? fin.voucherStatus : (paidAmount > 0 ? 'partially_reconciled' : null);
      legBuilds.push({
        plan: p, leg, shipmentId, batchId, invoiceId,
        invoiceAmount: legInvoiceAmount, paidAmount, settleStatus, invoiceStatus, voucherStatus, fin,
      });

      const packages = Math.max(2, Math.ceil(leg.qty / 800)); // 每卷 ~800m（塑卷+编织布包装）
      const gross = round2(leg.qty * 0.32);
      const isFcl = leg.qty >= 20000; // 大票走整箱，其余拼箱（LCL）直发
      shipmentRows.push({
        id: shipmentId, shipmentNumber: shipmentId,
        type: 'Export', status: isDelivered ? 'Delivered' : 'Shipped',
        shippingMethod: 'Sea',
        bookingDate: isoDate(leg.shipMs - 7 * DAY),
        etd: isoDate(leg.shipMs), atd: isoDate(leg.shipMs),
        eta: isoDate(leg.shipMs + 21 * DAY),
        ata: isDelivered && leg.deliveredMs ? isoDate(leg.deliveredMs) : null,
        vesselOrFlight: `MV PACIFIC ${['GEM', 'STAR', 'DAWN', 'TIDE', 'PEARL', 'WAVE'][p.idx % 6]}`,
        voyageNumber: `V.${String(20 + (p.idx % 9))}E`,
        portOfLoading: 'Shanghai', portOfDischarge: PORT_BY_COUNTRY[p.country] ?? 'Shanghai',
        containerNumber: isFcl ? `MSKU${6000000 + shipSeq * 173}` : null,
        sealNumber: isFcl ? `FS${String(77300 + shipSeq)}` : null,
        trackingNumber: `SIM-FTRK-${String(700 + shipSeq)}`,
        totalPackages: packages, grossWeight: new Prisma.Decimal(gross),
        netWeight: new Prisma.Decimal(round2(gross * 0.875)), volume: new Prisma.Decimal(round2(packages * 0.052)),
        freightAmount: new Prisma.Decimal(round2(850 + packages * 60)), freightCurrency: 'USD',
        customsAmount: new Prisma.Decimal(280), customsCurrency: 'CNY',
        orderId: p.id, customerRelationId: p.customerId, customerName: p.customerName,
        carrierRelationId: 'SIM-FWD-01', carrierName: '上海锦昀国际货运代理有限公司',
        consigneeRelationId: p.customerId, consigneeName: p.customerName,
        payerRelationId: p.customerId, payerName: p.customerName,
        hsCode: p.linePlans[0].hsCode,
        customsBroker: '上海华港报关行',
        notes: isDelivered ? '面料厂直发，已签收结案。' : `${isFcl ? '整箱（FCL）' : '拼箱（LCL）直发'}，在途，预计到港后清关派送。`,
        createdAt: BigInt(leg.shipMs - 7 * DAY), updatedAt: BigInt(leg.deliveredMs ?? leg.shipMs),
        deletedAt: null,
      });
      p.linePlans.forEach((l, li) => {
        const legQty = Math.round(l.qty * leg.ratio / 100) * 100;
        shipLineRows.push({
          id: `${shipmentId}-SL${li + 1}`, shipmentId, lineNumber: li + 1, orderLineId: l.lineId,
          productCode: l.styleNo, productName: l.description.split('（')[0], colorCode: l.color,
          quantity: new Prisma.Decimal(legQty), unit: 'Meter',
          cartons: Math.max(1, Math.ceil(legQty / 800)),
          grossWeight: new Prisma.Decimal(round2(legQty * l.kgPerUnit)),
          netWeight: new Prisma.Decimal(round2(legQty * l.kgPerUnit * 0.875)),
          volume: new Prisma.Decimal(round2(Math.ceil(legQty / 800) * 0.052)),
          hsCode: l.hsCode, countryOfOrigin: 'China',
          createdAt: BigInt(leg.shipMs), updatedAt: BigInt(leg.shipMs),
        });
      });
      shipAllocRows.push({
        id: `${shipmentId}-SA1`, shipmentId, orderId: p.id, orderLineId: null,
        plannedQty: new Prisma.Decimal(leg.qty), actualQty: new Prisma.Decimal(leg.qty),
        unit: 'Meter', status: 'Fulfilled',
        createdAt: BigInt(leg.shipMs), updatedAt: BigInt(leg.deliveredMs ?? leg.shipMs),
      });
      batchRows.push({
        id: batchId, orderId: p.id, shipmentId,
        batchNo: legs.length > 1 ? (leg.ratio > 0.5 ? 1 : 2) : 1,
        plannedRatio: new Prisma.Decimal(round2(leg.ratio * 100)), plannedQty: new Prisma.Decimal(leg.qty),
        unit: 'Meter', amount: new Prisma.Decimal(leg.amount), currency: p.currency,
        customerRelationId: p.customerId, customerName: p.customerName,
        status: 'shipped', shippedAt: BigInt(leg.shipMs),
        settleStatus, invoicedAmount: new Prisma.Decimal(legInvoiceAmount), paidAmount: new Prisma.Decimal(paidAmount),
        settledAt: settleStatus === 'settled' ? BigInt((leg.deliveredMs ?? leg.shipMs) + 3 * DAY) : null,
        isFinalBatch: legs.length === 1 || leg.ratio < 0.5,
        finalPaymentDueDays: 30, finalPaymentDueDate: isoDate(leg.shipMs + 30 * DAY),
        notes: p.shadeDeduction ? '缸差索赔 3%，开票口径 = 批次额 × 97%（QC 留痕）。' : null,
        createdAt: BigInt(p.createdAtMs), updatedAt: BigInt(leg.deliveredMs ?? leg.shipMs),
        deletedAt: null,
      });
      // 物流事件
      const evChain: Array<[string, string, number, string | null]> = [
        ['Booked', '订舱确认', leg.shipMs - 7 * DAY, USERS.logistics],
        ['Loading', '装货完成', leg.shipMs - 1 * DAY, USERS.logistics],
        ['Shipped', '已发运', leg.shipMs, USERS.logistics],
        ...(isDelivered && leg.deliveredMs
          ? ([
              ['Arrived', '到港', leg.deliveredMs - 3 * DAY, USERS.logistics],
              ['Cleared', '清关放行', leg.deliveredMs - 1 * DAY, USERS.logistics],
              ['Delivered', '签收交付', leg.deliveredMs, USERS.logistics],
            ] as Array<[string, string, number, string | null]>)
          : []),
      ];
      evChain.forEach(([node, note, ms, actor], ei) => {
        eventRows.push({
          id: `${shipmentId}-EV${ei + 1}`, shipmentId, fromNode: ei === 0 ? null : evChain[ei - 1][0],
          toNode: node, eventDate: isoDate(ms), note, actorId: actor,
          createdAt: BigInt(ms),
        });
      });
      // 装箱（面料卷包）：每票 2 卷包
      for (let c = 0; c < 2; c++) {
        const cartonId = `${shipmentId}-CT${c + 1}`;
        cartonRows.push({
          id: cartonId, shipmentId, cartonNo: `${c + 1}-${c + 1 + Math.max(2, Math.ceil(leg.qty / 1600))}`,
          description: `Fabric rolls on pallet（${p.code}）`,
          length: new Prisma.Decimal(120), width: new Prisma.Decimal(100), height: new Prisma.Decimal(90),
          grossWeight: new Prisma.Decimal(round2((leg.qty / 2) * 0.32)),
          netWeight: new Prisma.Decimal(round2((leg.qty / 2) * 0.28)), volume: new Prisma.Decimal(round2(Math.ceil(leg.qty / 1600) * 0.052)),
          createdAt: BigInt(leg.shipMs), updatedAt: BigInt(leg.shipMs),
        });
        p.linePlans.forEach((l, li) => {
          cartonItemRows.push({
            id: `${cartonId}-I${li + 1}`, cartonId, shipmentLineId: `${shipmentId}-SL${li + 1}`,
            quantity: new Prisma.Decimal(round2((l.qty * leg.ratio) / 2)),
            createdAt: BigInt(leg.shipMs), updatedAt: BigInt(leg.shipMs),
          });
        });
      }
    }
  }

  // ── 6. 财务链：Invoice + IOA + PaymentVoucher + InvoiceAllocation（出货即开票） ──
  for (const b of legBuilds) {
    const p = b.plan;
    const leg = b.leg;
    const isDelivered = p.fate === 'Delivered';
    invoiceRows.push({
      id: b.invoiceId, invoiceNumber: b.invoiceId,
      type: 'Receivable', status: b.invoiceStatus,
      amount: new Prisma.Decimal(b.invoiceAmount), currency: p.currency,
      issueDate: isoDate(leg.shipMs),
      dueDate: isoDate(leg.shipMs + 30 * DAY),
      settlementDate: b.fin?.kind === 'paid' ? isoDate((leg.deliveredMs ?? leg.shipMs) + 3 * DAY) : null,
      exchangeRate: new Prisma.Decimal(p.currency === 'EUR' ? EUR_CNY_RATE : USD_CNY_RATE), baseCurrency: 'CNY',
      orderId: p.id, customerRelationId: p.customerId, customerName: p.customerName,
      notes: p.shadeDeduction
        ? `缸差索赔 3%（QC 终期验布 conditional），按订单额 ${p.amount} × 97% 开具。`
        : !b.fin
          ? '面料见提单副本后 30 天付款。'
          : b.fin.kind === 'paid' ? '面料货已签收。'
          : b.fin.kind === 'overdue' ? '面料货已签收，尾款逾期催收中。'
          : b.fin.kind === 'deposit' ? '面料货已签收（提前出运），定金 30% 已收，尾款待付。'
          : '面料货已签收（提前出运），开票待收款。',
      ownerId: USERS.financeManager, departmentId: null,
      createdAt: BigInt(leg.shipMs), updatedAt: BigInt(leg.deliveredMs ?? leg.shipMs),
      deletedAt: null,
    });
    ioaRows.push({
      id: `SIM-FIOA-${b.invoiceId.slice(-4)}`, invoiceId: b.invoiceId, orderId: p.id,
      orderNumber: p.code, poNumber: p.poNumber, allocatedAmount: new Prisma.Decimal(b.invoiceAmount),
      batchId: b.batchId,
      note: p.idx === SPLIT_SHIPMENT_IDX ? `分批出运第 ${leg.ratio > 0.5 ? 1 : 2} 票（批次口径）` : '整单口径开票',
      createdAt: BigInt(leg.shipMs), updatedAt: BigInt(leg.shipMs), deletedAt: null,
    });
    if (b.paidAmount > 0) {
      const voucherId = `SIM-FPAY-${b.invoiceId.slice(-4)}`;
      // 凭证时间随 fin 分流：paid=交付+3 天；overdue=发运+12 天；deposit=开票+6 天定金（与 Shipping 单同口径）
      const payMs = b.fin
        ? (b.fin.kind === 'overdue' ? leg.shipMs + 12 * DAY
          : b.fin.kind === 'paid' ? (leg.deliveredMs ?? leg.shipMs) + 3 * DAY
          : leg.shipMs + 6 * DAY)
        : leg.shipMs + 6 * DAY;
      voucherRows.push({
        id: voucherId, voucherNumber: voucherId,
        type: 'Receipt', voucherCategory: 'normal',
        amount: new Prisma.Decimal(b.paidAmount), currency: p.currency,
        paymentDate: isoDate(payMs), paymentMethod: 'TT',
        // 凭证状态看自身核销进度（amount=appliedAmount=实收额 → 已全额核销）；发票层部分收款由 Invoice 状态表达
        status: 'reconciled',
        bankFee: new Prisma.Decimal(20), exchangeRate: new Prisma.Decimal(p.currency === 'EUR' ? EUR_CNY_RATE : USD_CNY_RATE),
        baseCurrency: 'CNY', invoiceId: b.invoiceId, appliedAmount: new Prisma.Decimal(b.paidAmount),
        orderId: p.id, customerRelationId: p.customerId, customerName: p.customerName,
        notes: p.shadeDeduction
          ? '缸差索赔扣款后货款到账并核销（97% 口径）。'
          : b.fin?.kind === 'paid' ? '面料货款全额到账并核销。'
          : b.fin?.kind === 'deposit' ? '面料定金 30% 到账，尾款待付。'
          : '部分货款到账，余款挂账。',
        ownerId: USERS.finance, departmentId: null,
        createdAt: BigInt(payMs), updatedAt: BigInt(payMs), deletedAt: null,
      });
      allocRows.push({
        id: `SIM-FALLOC-${b.invoiceId.slice(-4)}`, invoiceId: b.invoiceId, voucherId,
        appliedAmount: new Prisma.Decimal(b.paidAmount), appliedDate: isoDate(payMs),
        createdAt: BigInt(payMs), updatedAt: BigInt(payMs),
      });
    }
  }

  // Production / Confirmed / Pending 单：批次计划（planned，未排船）
  const planOnlyPlans = plans.filter((p) => p.fate === 'Production' || p.fate === 'Confirmed');
  planOnlyPlans.forEach((p, ppi) => {
    batchRows.push({
      id: `SIM-FOSB-P${String(901 + ppi)}`, orderId: p.id, shipmentId: null,
      batchNo: 1, plannedRatio: new Prisma.Decimal(100), plannedQty: new Prisma.Decimal(p.totalQty),
      unit: 'Meter', amount: new Prisma.Decimal(p.amount), currency: p.currency,
      customerRelationId: p.customerId, customerName: p.customerName,
      status: 'planned', shippedAt: null, settleStatus: 'unsettled',
      invoicedAmount: new Prisma.Decimal(0), paidAmount: new Prisma.Decimal(0),
      isFinalBatch: true, finalPaymentDueDays: 30, finalPaymentDueDate: null,
      notes: p.idx === 9 ? '面料织造中（头缸色差复染处理中），未排船。' : '接单即建批次计划，未排船。',
      createdAt: BigInt(p.createdAtMs),
      updatedAt: BigInt(p.createdAtMs), deletedAt: null,
    });
  });

  await createManyLogged(prisma, 'shipment', 'Shipment（Fabric）', shipmentRows);
  await createManyLogged(prisma, 'shipmentLine', 'ShipmentLine（Fabric）', shipLineRows);
  await createManyLogged(prisma, 'shipmentOrderAllocation', 'ShipmentOrderAllocation（Fabric）', shipAllocRows);
  await createManyLogged(prisma, 'orderShipmentBatch', 'OrderShipmentBatch（Fabric）', batchRows);
  await createManyLogged(prisma, 'shipmentEvent', 'ShipmentEvent（Fabric）', eventRows);
  await createManyLogged(prisma, 'shipmentCarton', 'ShipmentCarton（Fabric 卷包）', cartonRows);
  await createManyLogged(prisma, 'shipmentCartonItem', 'ShipmentCartonItem（Fabric）', cartonItemRows);
  await createManyLogged(prisma, 'invoice', 'Invoice（Fabric）', invoiceRows);
  await createManyLogged(prisma, 'invoiceOrderAllocation', 'InvoiceOrderAllocation（Fabric）', ioaRows);
  await createManyLogged(prisma, 'paymentVoucher', 'PaymentVoucher（Fabric）', voucherRows);
  await createManyLogged(prisma, 'invoiceAllocation', 'InvoiceAllocation（Fabric）', allocRows);

  // ── 7. 催款：2 张 Delivered 面单逾期半款（与成衣 3 单并存，客户错开） ──
  const overdueFabric = plans.filter((p) => p.overdue);
  const dunningRows: Prisma.DunningRecordUncheckedCreateInput[] = [];
  const dunningProfileRows: Prisma.DunningProfileUncheckedCreateInput[] = [];
  overdueFabric.forEach((p, di) => {
    const leg = legBuilds.find((b) => b.plan.id === p.id)!;
    const invoiceDueMs = leg.leg.shipMs + 30 * DAY;
    const daysOver = Math.max(1, Math.round((SIM_END - invoiceDueMs) / DAY));
    const stage = daysOver > 20 ? 'firm' : 'reminder';
    dunningRows.push({
      id: `SIM-DUN-${String(611 + di)}`, customerRelationId: p.customerId, customerName: p.customerName,
      currency: p.currency, totalOverdue: new Prisma.Decimal(round2(leg.invoiceAmount * 0.5)), invoiceCount: 1,
      agingBuckets: {
        current: 0, d1_30: daysOver <= 30 ? round2(leg.invoiceAmount * 0.5) : 0,
        d31_60: daysOver > 30 ? round2(leg.invoiceAmount * 0.5) : 0, d61_90: 0, d90plus: 0,
      } as unknown as Prisma.InputJsonValue,
      channel: 'email', result: di === 0 ? 'promised' : 'sent', stage,
      note: `面料订单尾款逾期 ${daysOver} 天，已发送催款函（${p.poNumber}）。`,
      operator: 'Melissa Zhao', createdAt: BigInt(Date.UTC(2026, 7, 21) + di * 3 * DAY),
    });
    dunningProfileRows.push({
      id: `SIM-DNP-${String(611 + di)}`,
      scopeKey: `rel:${p.customerId}:${p.currency}`, customerRelationId: p.customerId,
      customerName: p.customerName, currency: p.currency,
      stage, stageSource: 'auto', stageSince: BigInt(Date.UTC(2026, 7, 19)),
      autoStage: stage, escalatedAt: stage === 'firm' ? BigInt(Date.UTC(2026, 7, 19)) : null,
      downgradedAt: null, lastScanAt: BigInt(Date.UTC(2026, 7, 29, 2)),
      ownerName: p.salesName, createdAt: BigInt(Date.UTC(2026, 7, 19)), updatedAt: BigInt(Date.UTC(2026, 7, 29, 2)),
    });
  });
  await createManyLogged(prisma, 'dunningRecord', 'DunningRecord（Fabric 逾期）', dunningRows);
  await createManyLogged(prisma, 'dunningProfile', 'DunningProfile（Fabric）', dunningProfileRows);

  return { fabricPlans: plans };
}
