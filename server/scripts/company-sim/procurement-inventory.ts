/**
 * company-sim/procurement-inventory.ts — 采购→来料→入库→生产领料→来料退换（联动①②⑥）
 *
 * 痕迹口径与 server/src/events/linkages/L8AutoStockIn.ts 幂等查询完全一致：
 *   入库流水：StockMovement(referenceType='PurchaseOrder', referenceId=receipt.id, type='Inbound')
 *   —— 将来真实收料触发 MaterialReceived 事件时，L8 按 (referenceType, referenceId) 查重，
 *      SIM 收料单 ID 与真实收料单 ID 不相交，且痕迹口径一致 ⇒ 不会重复入库。
 * 生产领料：StockMovement(referenceType='ProductionStage', referenceId=PST__{orderId}__manufacturing, type='Outbound')
 *
 * 剧情规则（确定性）：
 *   - W1-W11 已下单订单（idx 0..49）每单一张面料采购单（SIM-PO-2xxx，与销售订单客户PO号 SIM-PO-1xxx 避让）；
 *   - status 按剧情回填：W1-W9 全部 Received；W10-W11 按 ProductionStage.materials_arrived 是否 done：
 *     已到料 → Received（有收料+入库），未到料 → Confirmed（无收料）；
 *   - 用量 = 成衣数量 × 1.6m（与 OrderLine.bomItems 面料单耗一致），向上取整到 10m；
 *   - 生产领料 = 实收合格量 × 97%（3% 裁剪损耗余料留存），余量 ≥ 0 硬断言；
 *   - SIM-ORD-005 的收料单为来料不良场景：6% 拒收（totalRejected>0，行级 rejectedQuantity），
 *     挂一张 MaterialReturn(type='return', status='shipped', stockItemId 回填)。
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { at, isoDate, round2, createManyLogged, USERS } from './common';
import { SUPPLIERS, type MasterDataCtx } from './master-data';
import { isFabricPlan, type FabricOrderPlan } from './fabric-orders';
import type { OrderPlan } from './orders';

const DAY = 24 * 3600 * 1000;
const WAREHOUSE_ID = 'SIM-WH-MAIN';
const REJECT_ORDER_IDX = 4; // SIM-ORD-005：来料不良退换场景

interface MovementDraft {
  itemId: string;
  timeMs: number;
  type: 'Inbound' | 'Outbound';
  qty: number; // 正数；落库时 Outbound 取负
  unitCost: number;
  reason: string;
  referenceType: string;
  referenceId: string;
  operator: string;
  movementDate: string;
  notes: string;
}

export async function seedProcurementInventory(
  prisma: PrismaClient,
  plans: Array<OrderPlan | FabricOrderPlan>,
  md: MasterDataCtx,
): Promise<void> {
  console.log('── 采购→来料→入库→领料（W1-W11 订单面料采购链） ──');

  // 0. 主仓（幂等 upsert）
  await prisma.warehouse.upsert({
    where: { code: WAREHOUSE_ID },
    create: {
      id: WAREHOUSE_ID, code: WAREHOUSE_ID, name: '竹衍服饰主仓（SIM）', type: 'Main',
      address: '江苏省苏州市吴中区纺织产业园 8 号库', manager: 'Hank Zheng', phone: '0512-6688-0001',
      isActive: true, sortOrder: 100, notes: '13 周模拟 seed 主仓',
      createdAt: BigInt(at(1, 1, 8)), updatedAt: BigInt(at(1, 1, 8)), deletedAt: null,
    },
    update: { name: '竹衍服饰主仓（SIM）' },
  });
  console.log('  Warehouse: 1（SIM-WH-MAIN，Main）');

  // 1. 面料成本（ProductAsset.cost 真源）
  const fabRows = await prisma.productAsset.findMany({
    where: { id: { in: md.fabricAssets.map((f) => f.id) } },
    select: { id: true, cost: true },
  });
  const fabCost = new Map(fabRows.map((r) => [r.id, Number(r.cost)]));

  // 2. 每单面料需求：主面料 = md.fabricAssets[garmentIdx % 24]（与 master-data 同构）
  const garmentIdxById = new Map(md.garmentAssets.map((g, i) => [g.id, i] as const));
  const fabricOfLine = (garmentId: string) => {
    const gIdx = garmentIdxById.get(garmentId);
    if (gIdx === undefined) throw new Error(`garmentId ${garmentId} 不在 md.garmentAssets`);
    return { fabIdx: gIdx % 24, fabric: md.fabricAssets[gIdx % 24] };
  };

  // 面料外销单不建采购链（面料厂直发客户，无需我司进料库存）
  const poPlans = (plans as OrderPlan[]).filter((p) => p.week <= 11 && !isFabricPlan(p));
  interface PoLine { fabIdx: number; fabric: MasterDataCtx['fabricAssets'][number]; meters: number; rejected: number }
  interface PoPlan { p: OrderPlan; poId: string; received: boolean; receiptMs: number; lines: PoLine[] }
  const poList: PoPlan[] = poPlans.map((p) => {
    const received = p.week <= 9 || (p.stageDone ?? 0) >= 4; // materials_arrived done ⇒ 已到料
    const perFab = new Map<number, number>();
    for (const l of p.linePlans) {
      const { fabIdx } = fabricOfLine(l.garmentId);
      perFab.set(fabIdx, (perFab.get(fabIdx) ?? 0) + Math.ceil((l.qty * 1.6) / 10) * 10);
    }
    const firstFabIdx = Math.min(...perFab.keys());
    const lines: PoLine[] = [...perFab.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([fabIdx, meters]) => ({
        fabIdx,
        fabric: md.fabricAssets[fabIdx],
        meters,
        // 来料不良场景：仅 SIM-ORD-005 的首个面料行拒收 6%（向上取整到 10m）
        rejected: p.idx === REJECT_ORDER_IDX && fabIdx === firstFabIdx
          ? Math.ceil((meters * 0.06) / 10) * 10
          : 0,
      }));
    return { p, poId: `SIM-PO-${String(2001 + p.idx)}`, received, receiptMs: p.createdAtMs + 6 * DAY, lines };
  });

  // 3. PurchaseOrder + PurchaseLine
  const poRows: Prisma.PurchaseOrderUncheckedCreateInput[] = [];
  const poLineRows: Prisma.PurchaseLineUncheckedCreateInput[] = [];
  for (const { p, poId, received, receiptMs, lines } of poList) {
    const sup = SUPPLIERS.find((s) => s.id === md.fabricAssets[lines[0].fabIdx].millRelId) ?? SUPPLIERS[0];
    const totalAmount = round2(lines.reduce((s, l) => s + l.meters * (fabCost.get(l.fabric.id) ?? 0), 0));
    poRows.push({
      id: poId, poNumber: poId, status: received ? 'Received' : 'Confirmed',
      supplierRelationId: sup.id, supplierName: sup.name, supplierCode: `${sup.id}-CODE`,
      currency: 'CNY', totalAmount: new Prisma.Decimal(totalAmount),
      orderDate: isoDate(p.createdAtMs),
      expectedDeliveryDate: isoDate(p.createdAtMs + 10 * DAY),
      actualDeliveryDate: received ? isoDate(receiptMs) : null,
      deliveryTerms: '送货至苏州仓', paymentTerms: '月结 30 天',
      shipToAddress: '江苏省苏州市吴中区纺织产业园 8 号库',
      orderId: p.id, buyer: USERS.salesManager,
      notes: received ? '面料已全部到料入库。' : '面料已下单，等待供应商交货。',
      createdAt: BigInt(p.createdAtMs), updatedAt: BigInt(received ? receiptMs : p.createdAtMs + 2 * DAY),
      deletedAt: null,
    });
    lines.forEach((l, li) => {
      const cost = fabCost.get(l.fabric.id) ?? 0;
      poLineRows.push({
        id: `${poId}-L${li + 1}`, purchaseOrderId: poId, lineNumber: li + 1,
        materialCode: l.fabric.sku, description: l.fabric.name, category: 'Fabric',
        specification: '150cm 幅宽（SIM 模拟）', quantity: new Prisma.Decimal(l.meters), unit: 'M',
        unitPrice: new Prisma.Decimal(cost), amount: new Prisma.Decimal(round2(l.meters * cost)),
        receivedQuantity: new Prisma.Decimal(received ? l.meters - l.rejected : 0),
        rejectedQuantity: new Prisma.Decimal(received ? l.rejected : 0),
        notes: l.rejected > 0 ? `来料检验拒收 ${l.rejected}m（色差超 AQL）` : null,
        createdAt: BigInt(p.createdAtMs),
      });
    });
  }
  await createManyLogged(prisma, 'purchaseOrder', 'PurchaseOrder', poRows);
  await createManyLogged(prisma, 'purchaseLine', 'PurchaseLine', poLineRows);

  // 4. MaterialReceipt（仅 Received PO；拒收单为 PartiallyAccepted）
  const receiptRows: Prisma.MaterialReceiptUncheckedCreateInput[] = [];
  const receiptIdByPo = new Map<string, string>();
  for (const { p, poId, received, receiptMs, lines } of poList) {
    if (!received) continue;
    const totalReceived = lines.reduce((s, l) => s + l.meters, 0);
    const totalRejected = lines.reduce((s, l) => s + l.rejected, 0);
    const receiptId = `SIM-MR-${String(2001 + p.idx)}`;
    receiptIdByPo.set(poId, receiptId);
    receiptRows.push({
      id: receiptId, receiptNumber: receiptId, purchaseOrderId: poId,
      status: totalRejected > 0 ? 'PartiallyAccepted' : 'Accepted',
      receivedDate: isoDate(receiptMs), receivedBy: 'SIM 仓库收料组',
      inspectedBy: 'Wilson Wu', inspectionDate: isoDate(receiptMs),
      warehouseId: WAREHOUSE_ID, warehouseName: '竹衍服饰主仓（SIM）',
      totalReceived: new Prisma.Decimal(totalReceived),
      totalAccepted: new Prisma.Decimal(totalReceived - totalRejected),
      totalRejected: new Prisma.Decimal(totalRejected),
      rejectionReason: totalRejected > 0 ? '缸差色差超 AQL 4.0 标准' : null,
      qualityNotes: totalRejected > 0 ? '拒收部分已开退货单退回供应商。' : '来料检验合格，全数入库。',
      notes: null, createdAt: BigInt(receiptMs),
    });
  }
  await createManyLogged(prisma, 'materialReceipt', 'MaterialReceipt', receiptRows);

  // 5. 库存项（每面料 sku 一项，与 L8 findFirst({warehouseId, materialCode}) 口径一致）
  const usedFabIdx = new Set<number>();
  for (const pp of poList) {
    if (!pp.received) continue;
    for (const l of pp.lines) usedFabIdx.add(l.fabIdx);
  }
  const itemIdByFab = new Map<number, string>();
  const invRows: Prisma.InventoryItemUncheckedCreateInput[] = [];
  for (const fabIdx of [...usedFabIdx].sort((a, b) => a - b)) {
    const fabric = md.fabricAssets[fabIdx];
    const itemId = `SIM-INV-${String(fabIdx + 1).padStart(3, '0')}`;
    itemIdByFab.set(fabIdx, itemId);
    invRows.push({
      id: itemId, warehouseId: WAREHOUSE_ID, productAssetId: fabric.id,
      materialCode: fabric.sku, description: fabric.name, category: 'Fabric',
      specification: '150cm 幅宽（SIM 模拟）', batchNumber: `SIM-BATCH-${String(fabIdx + 1).padStart(3, '0')}`,
      locationCode: `A-01-${String(fabIdx + 1).padStart(2, '0')}`,
      quantity: new Prisma.Decimal(0), lockedQuantity: new Prisma.Decimal(0), unit: 'M',
      unitCost: new Prisma.Decimal(fabCost.get(fabric.id) ?? 0), currency: 'CNY',
      minStock: new Prisma.Decimal(500), maxStock: null,
      notes: '13 周模拟 seed（采购入库-生产领料累计）',
      createdAt: BigInt(at(1, 2, 9)), updatedAt: BigInt(at(1, 2, 9)), deletedAt: null,
    });
  }
  await createManyLogged(prisma, 'inventoryItem', 'InventoryItem', invRows);

  // 6. 流水草稿：Inbound（每收料合格行一条，痕迹=L8 口径）+ Outbound（Delivered/Shipping 按 manufacturing 阶段完成时点）
  const movements: MovementDraft[] = [];
  for (const { poId, received, receiptMs, lines } of poList) {
    if (!received) continue;
    const receiptId = receiptIdByPo.get(poId)!;
    for (const l of lines) {
      const accepted = l.meters - l.rejected; // 合格量口径（同 L8 stockInLines 契约）
      if (accepted <= 0) continue;
      movements.push({
        itemId: itemIdByFab.get(l.fabIdx)!, timeMs: receiptMs + 2 * 3600 * 1000, type: 'Inbound',
        qty: accepted, unitCost: fabCost.get(l.fabric.id) ?? 0, reason: `采购到货：${poId}`,
        referenceType: 'PurchaseOrder', referenceId: receiptId,
        operator: USERS.logistics, movementDate: isoDate(receiptMs),
        notes: `L8 口径入库（来料单 ${receiptId}，面料 ${l.fabric.sku}）`,
      });
    }
  }

  const outboundPlans = plans.filter((p) => p.fate === 'Delivered' || p.fate === 'Shipping');
  const mfgStages = await prisma.productionStage.findMany({
    where: { orderId: { in: outboundPlans.map((p) => p.id) }, stageKey: 'manufacturing' },
    select: { id: true, orderId: true, doneAt: true },
  });
  const mfgByOrder = new Map(mfgStages.map((s) => [s.orderId, s] as const));
  // 领料量 = 该单该面料「实收合格量」× 97%
  const acceptedByOrder = new Map<string, Map<number, number>>();
  for (const { p, received, lines } of poList) {
    if (!received) continue;
    const m = new Map<number, number>();
    for (const l of lines) m.set(l.fabIdx, (m.get(l.fabIdx) ?? 0) + (l.meters - l.rejected));
    acceptedByOrder.set(p.id, m);
  }
  for (const p of outboundPlans) {
    const accepted = acceptedByOrder.get(p.id);
    const stage = mfgByOrder.get(p.id);
    if (!accepted || !stage?.doneAt) continue;
    const doneMs = Number(stage.doneAt);
    for (const [fabIdx, acc] of [...accepted.entries()].sort((a, b) => a[0] - b[0])) {
      if (acc <= 0) continue;
      const fabric = md.fabricAssets[fabIdx];
      movements.push({
        itemId: itemIdByFab.get(fabIdx)!, timeMs: doneMs, type: 'Outbound',
        qty: round2(acc * 0.97), unitCost: fabCost.get(fabric.id) ?? 0,
        reason: `生产领料：${p.code}（裁剪损耗 3% 余料留存）`,
        referenceType: 'ProductionStage', referenceId: stage.id,
        operator: USERS.logistics, movementDate: isoDate(doneMs),
        notes: `生产领料（阶段 ${stage.id}，面料 ${fabric.sku}）`,
      });
    }
  }

  // 7. 逐项时间回放：balanceBefore/After 连续，余量 ≥ 0 硬断言
  const byItem = new Map<string, MovementDraft[]>();
  for (const m of movements) {
    const arr = byItem.get(m.itemId) ?? [];
    arr.push(m);
    byItem.set(m.itemId, arr);
  }
  const finalBalance = new Map<string, number>();
  for (const [itemId, arr] of byItem) {
    arr.sort((a, b) => a.timeMs - b.timeMs || (a.type === 'Inbound' ? 0 : 1) - (b.type === 'Inbound' ? 0 : 1));
    let balance = 0;
    for (const m of arr) {
      balance = round2(balance + (m.type === 'Inbound' ? m.qty : -m.qty));
      if (balance < 0) throw new Error(`库存余额为负：${itemId} @ ${m.movementDate}（${m.reason}）`);
    }
    finalBalance.set(itemId, balance);
  }

  // 8. 落库（流水号按 item 分组内顺序全局递增）
  const movementRows: Prisma.StockMovementUncheckedCreateInput[] = [];
  let seq = 0;
  for (const [itemId, arr] of [...byItem.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    let balance = 0;
    for (const m of arr) {
      seq += 1;
      const delta = m.type === 'Inbound' ? m.qty : -m.qty;
      const before = balance;
      balance = round2(balance + delta);
      movementRows.push({
        id: `SIM-SM-${String(seq).padStart(4, '0')}`,
        movementNumber: `SIM-SM-${String(seq).padStart(4, '0')}`,
        type: m.type, itemId, warehouseId: WAREHOUSE_ID, targetWarehouseId: null,
        quantity: new Prisma.Decimal(delta), unit: 'M',
        unitCost: new Prisma.Decimal(m.unitCost),
        balanceBefore: new Prisma.Decimal(before), balanceAfter: new Prisma.Decimal(balance),
        reason: m.reason, referenceType: m.referenceType, referenceId: m.referenceId,
        operator: m.operator, movementDate: m.movementDate, notes: m.notes,
        createdAt: BigInt(m.timeMs),
      });
    }
  }
  await createManyLogged(prisma, 'stockMovement', 'StockMovement', movementRows);

  // 9. InventoryItem 余额/末次出入库日期回填
  let invUpdated = 0;
  for (const [itemId, arr] of byItem) {
    const lastIn = arr.filter((m) => m.type === 'Inbound').at(-1);
    const lastOut = arr.filter((m) => m.type === 'Outbound').at(-1);
    await prisma.inventoryItem.update({
      where: { id: itemId },
      data: {
        quantity: new Prisma.Decimal(finalBalance.get(itemId) ?? 0),
        lastInDate: lastIn ? lastIn.movementDate : null,
        lastOutDate: lastOut ? lastOut.movementDate : null,
        updatedAt: BigInt(arr.at(-1)!.timeMs),
      },
    });
    invUpdated += 1;
  }
  console.log(`  InventoryItem 余额回填: ${invUpdated} 项`);

  // 10. 来料不良退换（联动⑥）：SIM-ORD-005 收料单 → MaterialReturn(return, shipped, stockItemId 回填)
  const rejPo = poList.find((pp) => pp.p.idx === REJECT_ORDER_IDX)!;
  const rejReceiptId = receiptIdByPo.get(rejPo.poId)!;
  const rejLine = rejPo.lines.find((l) => l.rejected > 0)!;
  const rejSup = SUPPLIERS.find((s) => s.id === md.fabricAssets[rejLine.fabIdx].millRelId) ?? SUPPLIERS[0];
  const rejItemId = itemIdByFab.get(rejLine.fabIdx)!;
  const returnMs = rejPo.receiptMs + 2 * DAY;
  await createManyLogged(prisma, 'materialReturn', 'MaterialReturn', [
    {
      id: 'SIM-RET-0001', returnNumber: 'SIM-RT-0001',
      receiptId: rejReceiptId, purchaseOrderId: rejPo.poId,
      supplierRelationId: rejSup.id, supplierName: rejSup.name,
      type: 'return',
      materialCode: rejLine.fabric.sku, materialName: rejLine.fabric.name,
      quantity: new Prisma.Decimal(rejLine.rejected), unit: 'M',
      amount: new Prisma.Decimal(round2(rejLine.rejected * (fabCost.get(rejLine.fabric.id) ?? 0))),
      currency: 'CNY', status: 'shipped', stockItemId: rejItemId,
      reason: '来料缸差色差超 AQL 4.0 标准，整批退回供应商',
      notes: '13 周模拟：来料不良退换场景（次品未入库，库存无扰动）',
      createdAt: BigInt(returnMs), updatedAt: BigInt(returnMs), deletedAt: null,
    },
  ]);
}
