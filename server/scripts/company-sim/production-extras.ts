/**
 * company-sim/production-extras.ts — 生产域补全（13 周模拟二期）
 *
 * 一个文件搞定 4 张开天窗空表 + 1 张前置依赖表：
 *   - BOM / BOMLine        — BOM 页（8 张在产订单，042 带版本链 v1→v2 换色修订）
 *   - ProductionPlan       — MES 排产（10 条：Completed 2 / InProgress 3 / Confirmed 3 / Draft 2）
 *   - OrderChangeRequest   — 订单变更（5 条：Applied 2 / Pending 2 / Rejected 1，喂审批流演示）
 *   - SupplierInquiry      — 采购询价（4 张：Open 2 / Compared 1 / Closed 1，含多供应商比价明细）
 *   - WorkStation          — MES 排产硬 FK 前置（库中为 0，幂等补 8 个工位，无它 ProductionPlan 无法落库）
 *
 * 锚点全部从 DB 实查（订单/订单行/产品/供应商），查不到跳过并 console.warn。
 * 确定性：SIM- 前缀 ID + createMany skipDuplicates 幂等（PK/唯一键冲突即跳过）。
 * 时间锚：13 周窗口 2026-06-08~08-30（W10-W13 集中，在产单已开工、Confirmed 单排窗口尾部）。
 * 汇率口径与 common 真源一致（USD 6.74 / EUR 7.82，2026-09-02 对齐 ExchangeRate 行情）。
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { at, isoDate, round2, round4, createManyLogged, USERS, SIM_END, USD_CNY_RATE, EUR_CNY_RATE } from './common';

const DAY = 24 * 3600 * 1000;
const USD_RATE = USD_CNY_RATE;
const EUR_RATE = EUR_CNY_RATE;

export interface ProductionExtrasOutcome {
  workStationIds: string[];
  /** orderId → 最新版 BOM id（042 指向 v2） */
  bomByOrderId: Record<string, string>;
  planIds: string[];
  changeRequestIds: string[];
  inquiryIds: string[];
}

// ─── WorkStation（ProductionPlan 必填 FK，前置幂等补齐） ───
const WORK_STATIONS: Array<{
  id: string; code: string; name: string; type: string;
  capacity: number; unit: string; location: string; manager: string;
}> = [
  { id: 'SIM-WS-001', code: 'SIM-WS-CUT-01', name: '裁剪台 1#', type: 'Cutting', capacity: 3000, unit: 'PC', location: '一层裁剪车间', manager: 'Tony Fang' },
  { id: 'SIM-WS-002', code: 'SIM-WS-SEW-A', name: '缝纫 A 线', type: 'Sewing', capacity: 1200, unit: 'PC', location: '二层缝制车间', manager: 'Grace Liu' },
  { id: 'SIM-WS-003', code: 'SIM-WS-SEW-B', name: '缝纫 B 线', type: 'Sewing', capacity: 1200, unit: 'PC', location: '二层缝制车间', manager: 'Ivy Zhang' },
  { id: 'SIM-WS-004', code: 'SIM-WS-PRINT-01', name: '数码印花机 1#', type: 'Printing', capacity: 800, unit: 'PC', location: '一层印花工段', manager: 'Grace Liu' },
  { id: 'SIM-WS-005', code: 'SIM-WS-EMB-01', name: '电脑绣花机 1#', type: 'Embroidery', capacity: 500, unit: 'PC', location: '一层绣花工段', manager: 'Ivy Zhang' },
  { id: 'SIM-WS-006', code: 'SIM-WS-QC-01', name: '尾查/中查台', type: 'QC', capacity: 2000, unit: 'PC', location: '二层质检工段', manager: 'Wilson Wu' },
  { id: 'SIM-WS-007', code: 'SIM-WS-PACK-01', name: '包装线 1#', type: 'Packing', capacity: 1600, unit: 'PC', location: '一层包装车间', manager: 'Hank Zheng' },
  { id: 'SIM-WS-008', code: 'SIM-WS-FIN-01', name: '后整烫台', type: 'Other', capacity: 1500, unit: 'PC', location: '一层后整车间', manager: 'Tony Fang' },
];

/** 辅料选择（确定性）：bi%3==0 → 6 行；==1 → 5 行（含金属拉链）；==2 → 5 行（含贝壳纽扣） */
const TRIM_USAGE: Array<{ trimIdx: number; qty: number; condition: (bi: number) => boolean; spec: string }> = [
  { trimIdx: 0, qty: 1, condition: () => true, spec: '5# 尼龙隐形' },
  { trimIdx: 1, qty: 1, condition: (bi) => bi % 3 === 1, spec: '8# 金属铜头' },
  { trimIdx: 2, qty: 8, condition: () => true, spec: '18L 树脂' },
  { trimIdx: 3, qty: 12, condition: (bi) => bi % 3 !== 1, spec: '20L 贝壳' },
  { trimIdx: 4, qty: 1, condition: () => true, spec: '缎面织边 60×15mm' },
  { trimIdx: 5, qty: 1, condition: () => true, spec: 'Satin 印洗 50×70mm' },
];

// ─── MES 排产计划（10 条；orderIdx 对「Production/Confirmed 成衣订单按 id 升序」的下标） ───
interface PlanSpec {
  orderIdx: number; wsId: string; processType: string; seq: number;
  status: string; priority: string;
  startMs: number; endMs: number;
  actualStartMs?: number; actualEndMs?: number; actualRatio?: number;
  assignedTo: string;
}
const PLAN_SPECS: PlanSpec[] = [
  { orderIdx: 0, wsId: 'SIM-WS-001', processType: 'Cutting', seq: 1, status: 'Completed', priority: 'Normal',
    startMs: at(10, 3), endMs: at(10, 6), actualStartMs: at(10, 3), actualEndMs: at(10, 6, 16), assignedTo: 'Tony Fang' },
  { orderIdx: 0, wsId: 'SIM-WS-002', processType: 'Sewing', seq: 2, status: 'InProgress', priority: 'Normal',
    startMs: at(10, 6), endMs: at(12, 5), actualStartMs: at(10, 7), actualRatio: 0.42, assignedTo: 'Grace Liu' },
  { orderIdx: 1, wsId: 'SIM-WS-001', processType: 'Cutting', seq: 1, status: 'Completed', priority: 'Normal',
    startMs: at(10, 2), endMs: at(10, 5), actualStartMs: at(10, 2), actualEndMs: at(10, 5, 15), assignedTo: 'Tony Fang' },
  { orderIdx: 1, wsId: 'SIM-WS-003', processType: 'Sewing', seq: 2, status: 'InProgress', priority: 'High',
    startMs: at(10, 5), endMs: at(12, 7), actualStartMs: at(10, 6), actualRatio: 0.4, assignedTo: 'Ivy Zhang' },
  { orderIdx: 7, wsId: 'SIM-WS-005', processType: 'Embroidery', seq: 3, status: 'InProgress', priority: 'Normal',
    startMs: at(11, 2), endMs: at(12, 3), actualStartMs: at(11, 3), actualRatio: 0.6, assignedTo: 'Ivy Zhang' },
  { orderIdx: 5, wsId: 'SIM-WS-007', processType: 'Packing', seq: 6, status: 'Confirmed', priority: 'Normal',
    startMs: at(11, 5), endMs: at(12, 2), assignedTo: 'Hank Zheng' },
  { orderIdx: 8, wsId: 'SIM-WS-006', processType: 'QC', seq: 5, status: 'Confirmed', priority: 'High',
    startMs: at(12, 3), endMs: at(12, 7), assignedTo: 'Wilson Wu' },
  { orderIdx: 9, wsId: 'SIM-WS-001', processType: 'Cutting', seq: 1, status: 'Confirmed', priority: 'Normal',
    startMs: at(12, 2), endMs: at(12, 6), assignedTo: 'Tony Fang' },
  { orderIdx: 10, wsId: 'SIM-WS-002', processType: 'Sewing', seq: 2, status: 'Draft', priority: 'Normal',
    startMs: at(12, 3), endMs: at(12, 7), assignedTo: 'Grace Liu' },
  { orderIdx: 11, wsId: 'SIM-WS-001', processType: 'Cutting', seq: 1, status: 'Draft', priority: 'Normal',
    startMs: at(12, 5), endMs: at(12, 7), assignedTo: 'Tony Fang' },
];

export async function seedProductionExtras(prisma: PrismaClient): Promise<ProductionExtrasOutcome> {
  console.log('── 生产域补全：WorkStation / BOM / MES 排产 / 订单变更 / 采购询价 ──');
  const outcome: ProductionExtrasOutcome = {
    workStationIds: [], bomByOrderId: {}, planIds: [], changeRequestIds: [], inquiryIds: [],
  };

  // ═══ 1. WorkStation（幂等前置） ═══
  const wsRows: Prisma.WorkStationUncheckedCreateInput[] = WORK_STATIONS.map((w, i) => ({
    id: w.id, code: w.code, name: w.name, type: w.type,
    capacityPerDay: new Prisma.Decimal(w.capacity), capacityUnit: w.unit,
    isActive: true, sortOrder: i, location: w.location, manager: w.manager,
    notes: 'SIM 13 周生产域剧情工位（幂等补齐，ProductionPlan 硬 FK 前置）',
    createdAt: BigInt(at(1, 1, 8)), updatedAt: BigInt(at(1, 1, 8)), deletedAt: null,
  }));
  await createManyLogged(prisma, 'workStation', 'WorkStation', wsRows);
  outcome.workStationIds = WORK_STATIONS.map((w) => w.id);

  // ═══ 2. DB 锚点实查 ═══
  const garmentOrders = await prisma.order.findMany({
    where: { type: 'Garment', status: { in: ['Production', 'Confirmed'] }, deletedAt: null },
    orderBy: { id: 'asc' },
    select: { id: true, code: true, poNumber: true, customer: true, status: true, quantity: true, currency: true, ownerId: true, dueDate: true },
  });
  const deliveredOrders = await prisma.order.findMany({
    where: { type: 'Garment', status: 'Delivered', deletedAt: null },
    orderBy: { id: 'asc' }, take: 2,
    select: { id: true, poNumber: true, customer: true, quantity: true, ownerId: true },
  });

  const fabricAssets = await prisma.productAsset.findMany({
    where: { sku: { startsWith: 'SIM-FABSKU-' }, deletedAt: null },
    orderBy: { sku: 'asc' },
    select: { id: true, sku: true, name: true, cost: true },
  });
  const trimAssets = await prisma.productAsset.findMany({
    where: { sku: { startsWith: 'SIM-TRMSKU-' }, deletedAt: null },
    orderBy: { sku: 'asc' },
    select: { id: true, sku: true, name: true, cost: true },
  });
  // 面料/辅料行供应商（profile 快照真源）
  const fabricMillByAsset = new Map<string, string>();
  for (const fp of await prisma.fabricProfile.findMany({
    where: { deletedAt: null, productAssetId: { in: fabricAssets.map((f) => f.id) } },
    select: { productAssetId: true, millOrganizationId: true },
  })) if (fp.millOrganizationId) fabricMillByAsset.set(fp.productAssetId, fp.millOrganizationId);
  const trimSupplierByAsset = new Map<string, string>();
  for (const tp of await prisma.trimmingProfile.findMany({
    where: { deletedAt: null, productAssetId: { in: trimAssets.map((t) => t.id) } },
    select: { productAssetId: true, supplierRelationId: true },
  })) if (tp.supplierRelationId) trimSupplierByAsset.set(tp.productAssetId, tp.supplierRelationId);

  // ═══ 3. BOM（前 8 张在产/确认订单；042 剧情：v1 Archived + v2 Confirmed 换色修订） ═══
  const bomOrders = garmentOrders.slice(0, 8);
  const bomRows: Prisma.BOMUncheckedCreateInput[] = [];
  const bomLineRows: Prisma.BOMLineUncheckedCreateInput[] = [];
  let bomLineSeq = 0;
  const REVISE_ORDER_OFFSET = 3; // 042 = bomOrders[3]

  for (let bi = 0; bi < bomOrders.length; bi++) {
    const order = bomOrders[bi];
    const lines = await prisma.orderLine.findMany({
      where: { orderId: order.id }, orderBy: { lineNumber: 'asc' },
      select: { materialCode: true, styleNo: true, unitPrice: true, quantity: true },
    });
    if (!lines.length) {
      console.warn(`  [production-extras] 订单 ${order.id} 无订单行，跳过 BOM`);
      continue;
    }
    const firstLine = lines[0];
    // BOM 挂款式档案（OrderLine.materialCode = 成衣 SKU）
    const garmentAsset = await prisma.productAsset.findFirst({
      where: { sku: firstLine.materialCode ?? '', deletedAt: null },
      select: { id: true, sku: true, name: true },
    });
    if (!garmentAsset) {
      console.warn(`  [production-extras] 款式 ${firstLine.materialCode ?? '(空)'} 无产品档案，跳过 ${order.id} 的 BOM`);
      continue;
    }
    if (fabricAssets.length < 2 || trimAssets.length < 4) {
      console.warn('  [production-extras] 面料/辅料档案不足，BOM 生成中止');
      break;
    }

    const isRevise = bi === REVISE_ORDER_OFFSET;
    const buildBom = (version: number, bomId: string, status: string, createdMs: number): void => {
      const bomNumber = `SIM-BOM-${isoDate(createdMs).replace(/-/g, '')}-${String(bi + 1).padStart(3, '0')}${version > 1 ? 'R' : ''}`;

      // ── 物料行（面料 1-2 + 辅料 4-6 + 包装 2；单件用量口径，bi 偶数加里布） ──
      interface LineDraft {
        materialType: string; materialCode: string | null; description: string;
        category: string | null; specification: string | null; supplierId: string | null;
        quantity: number; unit: string; wastage: number; unitCost: number; notes: string | null;
      }
      const drafts: LineDraft[] = [];

      // 主料（1.3-1.8 m/件，损耗 3-5%）——款式档案面料真源：
      // master-data garmentDefs[i] 的 mainFabric = fabricAssets[i % 24]，BOM 主料同口径对齐（SIM-GAR-00X → fabric idx X-1）
      const garmentIdx = parseInt(garmentAsset.id.split('-').pop() ?? '1', 10) || 1;
      const mainFab = fabricAssets[(garmentIdx - 1) % fabricAssets.length];
      const mainUsage = round2(1.3 + (bi % 6) * 0.1);
      drafts.push({
        materialType: 'Main', materialCode: mainFab.sku, description: mainFab.name,
        category: 'Fabric', specification: '门幅 150cm · 匹长 60m', supplierId: fabricMillByAsset.get(mainFab.id) ?? null,
        quantity: mainUsage, unit: 'M', wastage: 3 + (bi % 3), unitCost: Number(mainFab.cost),
        notes: '大货主料，缸号批次与大货一致',
      });
      // 里布（bi 偶数 0.8-1.0 m/件）——里布业务语义即低价涤丝纺，确定性选低价段（idx 0/8/16，¥8.5）
      if (bi % 2 === 0) {
        const liningFab = fabricAssets[[0, 8, 16][bi % 3] % fabricAssets.length];
        drafts.push({
          materialType: 'Lining', materialCode: liningFab.sku, description: `${liningFab.name}（里布）`,
          category: 'Fabric', specification: '门幅 150cm', supplierId: fabricMillByAsset.get(liningFab.id) ?? null,
          quantity: round2(0.8 + (bi % 4) * 0.05), unit: 'M', wastage: 2, unitCost: Number(liningFab.cost),
          notes: '裙身里布，同缸染色',
        });
      }
      // 辅料（4-6 行，SIM-TRMSKU 真源）
      for (const t of TRIM_USAGE) {
        if (!t.condition(bi)) continue;
        const trim = trimAssets[t.trimIdx % trimAssets.length];
        if (!trim) continue;
        drafts.push({
          materialType: 'Trimmings', materialCode: trim.sku, description: trim.name,
          category: 'Trimmings', specification: t.spec, supplierId: trimSupplierByAsset.get(trim.id) ?? null,
          quantity: t.qty, unit: 'PC', wastage: 1, unitCost: Number(trim.cost),
          notes: null,
        });
      }
      // 包装 2 行（文本行，无档案）
      drafts.push({
        materialType: 'Packaging', materialCode: null, description: 'PP 平口胶袋（防锈五金扣）',
        category: 'Other', specification: '30×40cm · 0.04mm', supplierId: null,
        quantity: 1, unit: 'PC', wastage: 0, unitCost: 0.35, notes: null,
      });
      drafts.push({
        materialType: 'Packaging', materialCode: null, description: '五层瓦楞出口纸箱（60×40×40cm，装 60 件）',
        category: 'Other', specification: '≤22kg · 环保双瓦楞', supplierId: null,
        quantity: round4(1 / 60), unit: 'PC', wastage: 0, unitCost: 8.5, notes: '按 60 件/箱折算单件用量',
      });

      // ── 成本汇总（单件口径，与档案/订单真值联动） ──
      const materialCost = round4(drafts.reduce((s, d) => s + d.quantity * (1 + d.wastage / 100) * d.unitCost, 0));
      const laborCost = round2(6 + bi * 0.5);
      const overheadCost = round2(2.2 + bi * 0.3);
      const totalCost = round4(materialCost + laborCost + overheadCost);
      const fx = order.currency === 'EUR' ? EUR_RATE : USD_RATE;
      const sellingPrice = round4(Number(firstLine.unitPrice ?? 0) * fx);
      const profitAmount = round4(sellingPrice - totalCost);
      const profitMargin = sellingPrice > 0 ? round4((profitAmount / sellingPrice) * 100) : 0;

      bomRows.push({
        id: bomId, bomNumber, status,
        description: `订单 ${order.poNumber} · ${garmentAsset.name}（${firstLine.styleNo ?? garmentAsset.sku}）物料清单${version > 1 ? '（配色修订版）' : ''}`,
        productAssetId: garmentAsset.id, orderId: order.id, quotationId: null,
        version,
        parentBomId: version > 1 ? bomRows.find((b) => b.orderId === order.id)?.id ?? null : null,
        totalMaterialCost: new Prisma.Decimal(materialCost),
        totalLaborCost: new Prisma.Decimal(laborCost),
        totalOverheadCost: new Prisma.Decimal(overheadCost),
        totalCost: new Prisma.Decimal(totalCost),
        currency: 'CNY',
        sellingPrice: new Prisma.Decimal(sellingPrice),
        profitMargin: new Prisma.Decimal(profitMargin),
        profitAmount: new Prisma.Decimal(profitAmount),
        notes: version > 1
          ? 'SIM 13 周生产域剧情：客户 8/16 换色确认后修订重算（v1 归档，版本链可追溯）。'
          : bi === 6
            ? 'SIM 13 周生产域剧情：L6 订单确认自动生成，待成本经理复核确认（Draft）。'
            : 'SIM 13 周生产域剧情：L6 订单确认自动生成并完成审定。',
        attachments: undefined,
        createdAt: BigInt(createdMs), updatedAt: BigInt(createdMs + (version > 1 ? 3 * DAY : 2 * DAY)), deletedAt: null,
      });

      drafts.forEach((d, li) => {
        bomLineSeq += 1;
        const effQty = round4(d.quantity * (1 + d.wastage / 100));
        bomLineRows.push({
          id: `SIM-BOML-${String(bomLineSeq).padStart(4, '0')}`, bomId, lineNumber: li + 1,
          materialType: d.materialType, materialCode: d.materialCode, description: d.description,
          category: d.category, specification: d.specification, supplierId: d.supplierId,
          quantity: new Prisma.Decimal(d.quantity), unit: d.unit,
          wastagePercent: new Prisma.Decimal(d.wastage), effectiveQty: new Prisma.Decimal(effQty),
          unitCost: new Prisma.Decimal(d.unitCost), amount: new Prisma.Decimal(round4(effQty * d.unitCost)),
          currency: 'CNY', notes: d.notes,
          createdAt: BigInt(createdMs), updatedAt: BigInt(createdMs),
        });
      });
    };

    const baseMs = at(10, 2 + (bi % 5), 9, (bi * 17) % 40);
    const v1Id = `SIM-BOM-${String(bi + 1).padStart(3, '0')}`;
    // 042：v1 Archived + 8/18 v2 Confirmed；其余：044(bi=6) Draft，余 Confirmed
    if (isRevise) {
      buildBom(1, v1Id, 'Archived', baseMs);
      buildBom(2, `SIM-BOM-${String(bomOrders.length + 1).padStart(3, '0')}`, 'Confirmed', baseMs + 6 * DAY);
      outcome.bomByOrderId[order.id] = `SIM-BOM-${String(bomOrders.length + 1).padStart(3, '0')}`;
    } else {
      buildBom(1, v1Id, bi === 6 ? 'Draft' : 'Confirmed', baseMs);
      outcome.bomByOrderId[order.id] = v1Id;
    }
  }
  await createManyLogged(prisma, 'bOM', 'BOM', bomRows);
  await createManyLogged(prisma, 'bOMLine', 'BOMLine', bomLineRows);

  // ═══ 4. ProductionPlan（MES 排产 10 条） ═══
  const planRows: Prisma.ProductionPlanUncheckedCreateInput[] = [];
  PLAN_SPECS.forEach((spec, pi) => {
    const order = garmentOrders[spec.orderIdx];
    if (!order) {
      console.warn(`  [production-extras] 排产锚点订单 idx=${spec.orderIdx} 不存在，跳过计划 ${pi + 1}`);
      return;
    }
    const plannedQty = Number(order.quantity);
    const actualQty = spec.status === 'Completed' ? plannedQty
      : spec.status === 'InProgress' ? Math.round(plannedQty * (spec.actualRatio ?? 0)) : 0;
    planRows.push({
      id: `SIM-PP-${String(pi + 1).padStart(3, '0')}`,
      planNumber: `SIM-PP-${isoDate(spec.startMs).replace(/-/g, '')}-${String(pi + 1).padStart(3, '0')}`,
      orderId: order.id, workStationId: spec.wsId,
      processType: spec.processType, processSeq: spec.seq,
      plannedQuantity: new Prisma.Decimal(plannedQty), actualQuantity: new Prisma.Decimal(actualQty),
      unit: 'PC',
      plannedStartDate: isoDate(spec.startMs), plannedEndDate: isoDate(spec.endMs),
      actualStartDate: spec.actualStartMs ? isoDate(spec.actualStartMs) : null,
      actualEndDate: spec.actualEndMs ? isoDate(spec.actualEndMs) : null,
      status: spec.status, priority: spec.priority, assignedTo: spec.assignedTo,
      notes: spec.status === 'Completed'
        ? `SIM 13 周生产域剧情：${order.poNumber} ${spec.processType} 工序完工入库待转。`
        : spec.status === 'InProgress'
          ? `SIM 13 周生产域剧情：${order.poNumber} ${spec.processType} 工序进行中（完成 ${Math.round((spec.actualRatio ?? 0) * 100)}%）。`
          : spec.status === 'Draft'
            ? `SIM 13 周生产域剧情：${order.poNumber} 待排产审定（草稿）。`
            : `SIM 13 周生产域剧情：${order.poNumber} 排产已确认待开工。`,
      createdAt: BigInt(spec.startMs - 2 * DAY), updatedAt: BigInt(spec.actualEndMs ?? spec.endMs), deletedAt: null,
    });
    outcome.planIds.push(`SIM-PP-${String(pi + 1).padStart(3, '0')}`);
  });
  await createManyLogged(prisma, 'productionPlan', 'ProductionPlan', planRows);

  // ═══ 5. OrderChangeRequest（2 Delivered 历史留痕 + 3 在产审批中） ═══
  const crRows: Prisma.OrderChangeRequestUncheckedCreateInput[] = [];
  const crBase = (n: string) => `SIM-OCR-${String(n).padStart(3, '0')}`;

  // 5.1 Delivered 早期单 × 2（Applied 数量增 / Rejected 换色）
  deliveredOrders.slice(0, 2).forEach((d, di) => {
    const qty = Number(d.quantity);
    if (di === 0) {
      const afterQty = Math.ceil(qty * 1.12 / 10) * 10;
      const createdMs = at(6, 2 + 0, 10, 15);
      crRows.push({
        id: crBase('1'), orderId: d.id, requestNumber: 'SIM-OCR-20260714-001',
        beforeSnapshot: { quantity: qty, customer: d.customer, poNumber: d.poNumber } as unknown as Prisma.InputJsonValue,
        afterDelta: { quantity: afterQty } as unknown as Prisma.InputJsonValue,
        changeTypes: ['quantity'], impactLevel: 'high',
        changeReason: '客户电商渠道补单，要求按原价追加 12% 数量，工厂余料可覆盖，不加价不加期。',
        requesterId: d.ownerId ?? USERS.salesA, reviewerId: USERS.gm, approvalRequestId: null,
        status: 'Applied', appliedAt: new Date(at(6, 4, 14, 30)), appliedBy: d.ownerId ?? USERS.salesA,
        notes: '影响评估：主料余量充足，辅料按新数量补采，交期不变。审批通过后已回写订单数量。',
        attachments: undefined,
        createdAt: new Date(createdMs), updatedAt: new Date(at(6, 4, 14, 30)), deletedAt: null,
      });
    } else {
      const createdMs = at(7, 1, 9, 40);
      crRows.push({
        id: crBase('2'), orderId: d.id, requestNumber: 'SIM-OCR-20260720-001',
        beforeSnapshot: { colorName: 'Sage', customer: d.customer, poNumber: d.poNumber } as unknown as Prisma.InputJsonValue,
        afterDelta: { colorName: 'Ivory' } as unknown as Prisma.InputJsonValue,
        changeTypes: ['product_spec'], impactLevel: 'high',
        changeReason: '客户设计部提出换色至象牙白，但大货面料已开裁，申请评估换色可行性。',
        requesterId: d.ownerId ?? USERS.salesB, reviewerId: USERS.gm, approvalRequestId: null,
        status: 'Rejected', appliedAt: null, appliedBy: null,
        notes: '评审结论：大货已开裁且染缸排产锁定，换色损失超 8 万，驳回并按原色 Sage 执行。',
        attachments: undefined,
        createdAt: new Date(createdMs), updatedAt: new Date(at(7, 4, 16, 0)), deletedAt: null,
      });
    }
  });

  // 5.2 在产单 × 3（039 交期顺延 Applied / 041 数量减 Pending / 043 换色 Pending）
  // 快照真值原则：before/after 全部从订单实值推导（顺延 = dueDate+14d；减量 = quantity×85% 取整 5）
  type CrOrderRef = { quantity: unknown; dueDate: string | null };
  interface CrSpec {
    orderIdx: number; id: string; requestNumber: string;
    changeTypes: string[]; impactLevel: string;
    before: (o: CrOrderRef) => Record<string, unknown>;
    after: (o: CrOrderRef) => Record<string, unknown>;
    reason: string; status: string; appliedAt: Date | null;
    notes: string; createdMs: number;
  }
  const inProdCr: CrSpec[] = [
    {
      orderIdx: 0, id: crBase('3'), requestNumber: 'SIM-OCR-20260818-001',
      changeTypes: ['deliveryDate'], impactLevel: 'medium',
      before: (o) => ({ deliveryDate: o.dueDate, quantity: Number(o.quantity) }),
      after: (o) => ({ deliveryDate: isoDate(Date.parse(o.dueDate ?? '') + 14 * DAY) }),
      reason: '客户电商上线整体推迟两周，申请交期顺延；工厂可调整排产窗口，不影响其他订单交付。',
      status: 'Applied', appliedAt: new Date(at(11, 4, 15, 0)),
      notes: '影响评估：排产窗口可后移，面料无风险，尾款节点同步顺延。审批通过后已回写 dueDate。',
      createdMs: at(11, 2, 10, 20),
    },
    {
      orderIdx: 2, id: crBase('4'), requestNumber: 'SIM-OCR-20260824-001',
      changeTypes: ['quantity'], impactLevel: 'high',
      before: (o) => ({ quantity: Number(o.quantity) }),
      after: (o) => ({ quantity: Math.round((Number(o.quantity) * 0.85) / 5) * 5 }),
      reason: '客户终端动销放缓，申请减 15% 数量；主料已订不可退，余料转内部样衣库存，损失可控。',
      status: 'Pending', appliedAt: null,
      notes: '影响评估：主料按 MOQ 已订整匹，减量后余料转开发样衣；金额影响 -15%，已挂审批待批。',
      createdMs: at(12, 2, 11, 5),
    },
    {
      orderIdx: 4, id: crBase('5'), requestNumber: 'SIM-OCR-20260826-001',
      changeTypes: ['product_spec'], impactLevel: 'high',
      before: (o) => ({ colorName: 'Dusty Rose', quantity: Number(o.quantity) }),
      after: () => ({ colorName: 'Terracotta' }),
      reason: '客户设计部最终定色偏暖，申请换色至陶土红；绣花线需重新配色采购，涉及 0.2 万色线补采。',
      status: 'Pending', appliedAt: null,
      notes: '影响评估：主料染缸未排可改色，绣花线补采 7 天交期，换色风险中低，待主管审批。',
      createdMs: at(12, 4, 9, 30),
    },
  ];
  for (const c of inProdCr) {
    const order = garmentOrders[c.orderIdx];
    if (!order) {
      console.warn(`  [production-extras] 变更申请锚点订单 idx=${c.orderIdx} 不存在，跳过 ${c.requestNumber}`);
      continue;
    }
    crRows.push({
      id: c.id, orderId: order.id, requestNumber: c.requestNumber,
      beforeSnapshot: c.before(order) as unknown as Prisma.InputJsonValue,
      afterDelta: c.after(order) as unknown as Prisma.InputJsonValue,
      changeTypes: c.changeTypes, impactLevel: c.impactLevel, changeReason: c.reason,
      requesterId: order.ownerId ?? USERS.salesA, reviewerId: USERS.gm, approvalRequestId: null,
      status: c.status, appliedAt: c.appliedAt, appliedBy: c.status === 'Applied' ? (order.ownerId ?? USERS.salesA) : null,
      notes: c.notes, attachments: undefined,
      createdAt: new Date(c.createdMs), updatedAt: new Date(c.appliedAt?.getTime() ?? c.createdMs + 2 * DAY), deletedAt: null,
    });
  }
  await createManyLogged(prisma, 'orderChangeRequest', 'OrderChangeRequest', crRows);
  outcome.changeRequestIds = crRows.map((r) => r.id);

  // ═══ 6. SupplierInquiry（采购询价 4 张：Open 2 / Compared 1 / Closed 1） ═══
  const inquirySupplierIds = ['SIM-SUP-01', 'SIM-SUP-02', 'SIM-SUP-03', 'SIM-SUP-04'];
  const suppliers = await prisma.relation.findMany({
    where: { id: { in: inquirySupplierIds }, category: 'Supplier', deletedAt: null },
    select: { id: true, name: true },
  });
  const supplierById = new Map(suppliers.map((s) => [s.id, s] as const));
  const fabBySku = new Map(fabricAssets.map((f) => [f.sku, f] as const));
  const supName = (id: string): string | null => supplierById.get(id)?.name ?? null;

  interface QuoteDraft {
    supplierId: string; quoteAmount: number; quoteDateMs: number;
    expectedDeliveryDate: string; deliveryTerms: string; paymentTerms: string; notes: string; isSelected: boolean;
  }
  const mkQuotes = (inquirySeq: string, qs: QuoteDraft[]): Prisma.InputJsonValue => qs
    .filter((q) => supName(q.supplierId))
    .map((q, qi) => ({
      id: `SIM-SIQ-${inquirySeq}-Q${qi + 1}`, supplierId: q.supplierId, supplierName: supName(q.supplierId),
      quoteAmount: q.quoteAmount, currency: 'CNY', exchangeRate: 1, baseAmount: q.quoteAmount,
      quoteDate: isoDate(q.quoteDateMs), deliveryTerms: q.deliveryTerms, paymentTerms: q.paymentTerms,
      expectedDeliveryDate: q.expectedDeliveryDate, notes: q.notes, isSelected: q.isSelected,
    })) as unknown as Prisma.InputJsonValue;

  // 6.1 Compared：3 家比价中选（挂 041 在产订单 + 其 BOM，喂比价决策演示）
  const si1Fabric = fabBySku.get('SIM-FABSKU-004');
  const si1Order = garmentOrders[2];
  const si1BomId = si1Order ? outcome.bomByOrderId[si1Order.id] : undefined;
  const si1Rows: QuoteDraft[] = [
    { supplierId: 'SIM-SUP-01', quoteAmount: 156000, quoteDateMs: at(11, 3), expectedDeliveryDate: '2026-09-08', deliveryTerms: 'FOB 上海（含运）', paymentTerms: '月结 30 天', notes: '议价后 ¥12.95/m 含运，色牢度达 4 级', isSelected: true },
    { supplierId: 'SIM-SUP-02', quoteAmount: 159600, quoteDateMs: at(11, 3), expectedDeliveryDate: '2026-09-05', deliveryTerms: 'EXW 工厂自提', paymentTerms: '预付 30%', notes: '¥13.30/m 自提价，交期最早', isSelected: false },
    { supplierId: 'SIM-SUP-03', quoteAmount: 162000, quoteDateMs: at(11, 4), expectedDeliveryDate: '2026-09-12', deliveryTerms: 'FOB 上海（含运）', paymentTerms: '月结 30 天', notes: '¥13.50/m，可分两批交货', isSelected: false },
  ];
  // 6.2 Open：2 家已报待比（挂 044 订单 + 其 Draft BOM）
  const si2Order = garmentOrders[5];
  const si2BomId = si2Order ? outcome.bomByOrderId[si2Order.id] : undefined;
  const si2Rows: QuoteDraft[] = [
    { supplierId: 'SIM-SUP-03', quoteAmount: 244500, quoteDateMs: at(12, 3), expectedDeliveryDate: '2026-09-22', deliveryTerms: 'FOB 上海（含运）', paymentTerms: '月结 30 天', notes: '¥16.30/m，OEKO-TEX 认证在效', isSelected: false },
    { supplierId: 'SIM-SUP-04', quoteAmount: 250920, quoteDateMs: at(12, 4), expectedDeliveryDate: '2026-09-18', deliveryTerms: 'EXW 工厂自提', paymentTerms: '预付 30%', notes: '¥16.73/m 自提，需满 MOQ 15km', isSelected: false },
  ];
  // 6.3 Open：1 家已报 1 家未回（新询价）
  const si3Rows: QuoteDraft[] = [
    { supplierId: 'SIM-SUP-04', quoteAmount: 122400, quoteDateMs: at(12, 6), expectedDeliveryDate: '2026-09-30', deliveryTerms: 'FOB 上海（含运）', paymentTerms: '月结 30 天', notes: '¥13.60/m，等待另一家回价', isSelected: false },
  ];
  // 6.4 Closed：客户减单取消采购意向（2 家报价留档，无中选）
  const si4Rows: QuoteDraft[] = [
    { supplierId: 'SIM-SUP-01', quoteAmount: 56100, quoteDateMs: at(11, 2), expectedDeliveryDate: '2026-09-03', deliveryTerms: 'FOB 上海（含运）', paymentTerms: '月结 30 天', notes: '¥18.70/m 蕾丝满绣款', isSelected: false },
    { supplierId: 'SIM-SUP-02', quoteAmount: 57600, quoteDateMs: at(11, 2), expectedDeliveryDate: '2026-09-05', deliveryTerms: 'EXW 工厂自提', paymentTerms: '预付 30%', notes: '¥19.20/m，可小缸打样', isSelected: false },
  ];

  const inquiryRows: Prisma.SupplierInquiryUncheckedCreateInput[] = [];
  const pushInquiry = (n: number, data: Omit<Prisma.SupplierInquiryUncheckedCreateInput, 'id'>): void => {
    inquiryRows.push({ id: `SIM-SI-${String(n).padStart(3, '0')}`, ...data });
  };

  if (si1Fabric && si1Order && si1BomId) {
    const createdMs = at(11, 1, 9, 30);
    pushInquiry(1, {
      inquiryNumber: 'SIM-SI-20260810-001', status: 'Compared',
      description: `亚麻混纺平纹 55/45 大货采购（${si1Fabric.name}，AQL 4 级色牢度）`,
      materialCode: si1Fabric.sku, quantity: new Prisma.Decimal(12000), unit: 'M', currency: 'CNY',
      expectedDeliveryDate: '2026-09-08', orderId: si1Order.id, bomId: si1BomId, buyer: 'Grace Liu',
      supplierQuotes: mkQuotes('001', si1Rows),
      selectedSupplierId: 'SIM-SUP-01', selectedSupplierName: supName('SIM-SUP-01') ?? undefined,
      decisionNote: '价格最低且交期满足 9/8 前要求，中选 SIM-SUP-01（议价后 ¥12.95/m 含运）；待转采购单。',
      notes: 'SIM 13 周生产域剧情：订单面料缺口触发询价，3 家比价完成决策。',
      attachments: undefined,
      createdAt: BigInt(createdMs), updatedAt: BigInt(at(11, 5, 16, 0)), deletedAt: null,
    });
  } else {
    console.warn('  [production-extras] 询价 1（Compared）锚点缺失（面料/订单/BOM），跳过');
  }

  const si2Fabric = fabBySku.get('SIM-FABSKU-005');
  if (si2Fabric && si2Order && si2BomId) {
    const createdMs = at(12, 1, 10, 0);
    pushInquiry(2, {
      inquiryNumber: 'SIM-SI-20260817-001', status: 'Open',
      description: `全棉府绸 97/3 大货补采（${si2Fabric.name}，Draft BOM 审定同步询价）`,
      materialCode: si2Fabric.sku, quantity: new Prisma.Decimal(15000), unit: 'M', currency: 'CNY',
      expectedDeliveryDate: '2026-09-22', orderId: si2Order.id, bomId: si2BomId, buyer: 'Grace Liu',
      supplierQuotes: mkQuotes('002', si2Rows),
      selectedSupplierId: null, selectedSupplierName: null, decisionNote: null,
      notes: 'SIM 13 周生产域剧情：2 家已回价，等待第 3 家报价后统一比价。',
      attachments: undefined,
      createdAt: BigInt(createdMs), updatedAt: BigInt(at(12, 4, 15, 30)), deletedAt: null,
    });
  } else {
    console.warn('  [production-extras] 询价 2（Open）锚点缺失（面料/订单/BOM），跳过');
  }

  const si3Fabric = fabBySku.get('SIM-FABSKU-013');
  if (si3Fabric) {
    const createdMs = at(12, 5, 9, 45);
    pushInquiry(3, {
      inquiryNumber: 'SIM-SI-20260824-001', status: 'Open',
      description: `棉氨汗布 95/5 针织补采（${si3Fabric.name}，开发样衣转大货）`,
      materialCode: si3Fabric.sku, quantity: new Prisma.Decimal(9000), unit: 'M', currency: 'CNY',
      expectedDeliveryDate: '2026-09-30', orderId: null, bomId: null, buyer: 'Tony Fang',
      supplierQuotes: mkQuotes('003', si3Rows),
      selectedSupplierId: null, selectedSupplierName: null, decisionNote: null,
      notes: 'SIM 13 周生产域剧情：新发询价，1 家已回价 1 家未回，报价收集进行中。',
      attachments: undefined,
      createdAt: BigInt(createdMs), updatedAt: BigInt(at(12, 6, 11, 20)), deletedAt: null,
    });
  } else {
    console.warn('  [production-extras] 询价 3（Open）锚点缺失（面料 SIM-FABSKU-013），跳过');
  }

  const si4Fabric = fabBySku.get('SIM-FABSKU-021');
  if (si4Fabric) {
    const createdMs = at(11, 1, 14, 10);
    pushInquiry(4, {
      inquiryNumber: 'SIM-SI-20260810-002', status: 'Closed',
      description: `蕾丝面料满绣款采购（${si4Fabric.name}，客户减单后取消）`,
      materialCode: si4Fabric.sku, quantity: new Prisma.Decimal(3000), unit: 'M', currency: 'CNY',
      expectedDeliveryDate: '2026-09-03', orderId: null, bomId: null, buyer: 'Grace Liu',
      supplierQuotes: mkQuotes('004', si4Rows),
      selectedSupplierId: null, selectedSupplierName: null, decisionNote: null,
      notes: 'SIM 13 周生产域剧情：客户减单后采购意向取消，询价关闭（未转采购单，报价留档）。',
      attachments: undefined,
      createdAt: BigInt(createdMs), updatedAt: BigInt(at(11, 6, 10, 0)), deletedAt: null,
    });
  } else {
    console.warn('  [production-extras] 询价 4（Closed）锚点缺失（面料 SIM-FABSKU-021），跳过');
  }

  await createManyLogged(prisma, 'supplierInquiry', 'SupplierInquiry', inquiryRows);
  outcome.inquiryIds = inquiryRows.map((r) => r.id);

  // 13 周窗口越界哨兵（剧情时间都应落在 SIM_END 之前；越界说明 at() 锚点写错）
  const maxMs = Math.max(
    ...planRows.map((r) => Number(r.updatedAt ?? BigInt(0))),
    ...bomRows.map((r) => Number(r.updatedAt ?? BigInt(0))),
  );
  if (maxMs > SIM_END + DAY) {
    console.warn(`  [production-extras] 警告：剧情时间越界 13 周窗口（max=${isoDate(maxMs)}）`);
  }

  console.log(`  生产域补全完成：BOM ${bomRows.length} 行 / BOMLine ${bomLineRows.length} 行 / ProductionPlan ${planRows.length} 条 / OrderChangeRequest ${crRows.length} 条 / SupplierInquiry ${inquiryRows.length} 张`);
  return outcome;
}
