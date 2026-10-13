
import { lockLegacyShipmentAllocationWrite } from './shipmentPhysicalAllocationService';
/**
 * T3 · H9 出运扣库存 / 取消回冲（shipmentStockService）
 *
 * 业务规则（设计真源：docs/handoff-20260916-005500.md §三-T3）：
 *   - 运单流转至 Shipped（出运放行语义）→ 按装运行（ShipmentLine）扣减成品库存，
 *     与出运放行门禁**同一事务**：门禁过了才扣，扣失败整体回滚（不出现"已发运未扣账"）。
 *   - 流转至 Cancelled 且此前已扣账（fromStatus ∈ Shipped/Arrived/Cleared/Delivered）→
 *     按原 Outbound 流水逐条补反向 Inbound（append-only，原行不动，对齐
 *     procurement/materialReturnService.ts 退货回冲范式）。
 *
 * 数量真源：
 *   - 主：ShipmentLine（物理装箱行；C4 建单首装 / pull-from-order 会从订单行带出
 *     orderLineId，映射口径见 shipmentPackingService.mapOrderLinesToShipmentLineInputs）。
 *     库存项身份 = 关联 OrderLine 的 materialCode ?? itemNo；无 orderLineId 的行回退
 *     productCode（同一映射口径的快照）。
 *   - 兜底：运单没有任何装运行时，用 ShipmentOrderAllocation 行级分配
 *     （actualQty ?? plannedQty）；订单级分配（orderLineId=null）无法定位库存项，跳过留痕。
 *
 * 写入纪律：
 *   - 一律经 createStockMovement 单一写入口（禁直改 InventoryItem.quantity）；
 *     通过 opts.tx 挂入调用方事务（门禁同事务原子提交）。
 *   - 每行扣减写一条 Outbound 流水。**不写 Lock**（handoff 原文"Lock→Outbound"经真库
 *     验证证伪）：Outbound 的可用量校验 = quantity − lockedQuantity（含本次自己刚锁的
 *     量），同一事务内 Lock N 再 Outbound N 时可用量已归 0，整仓全量出运（N=全部库存）
 *     必然自锁死——8081 真库实测「库存不足（含锁定量 800 M）：当前可用 0 M」。而
 *     Outbound 本身就尊重其他订单的锁（预留语义已内置），同事务再写 Lock/Unlock 纯属
 *     自我限制，还会在流水里留两条无业务含义的行。
 *   - 库存项定位：主仓（type=Main）优先，其次任意在用仓（与 L8/L11 入库落位对称）。
 *   - 找不到库存项 → 跳过并留痕（历史订单无成品入库账，不阻断出运；对齐
 *     materialReturnService 的"次品未入库跳过"范式）；可用量不足 → fail-closed 400。
 *
 * 幂等：扣减前查 referenceType='Shipment' + referenceId=shipmentId 的 Outbound 流水，
 * 已存在则整体跳过（重试安全）；回冲同理查 Inbound。
 */

import { lockClaimShipmentSource, deductClaimShipmentStockInTx } from '../claims/claimShipmentFact';
import { logger } from '../lib/logger';
import { SHIPPED_SHIPMENT_STATUSES } from '../shared/shippingLock';
import { createInventoryService } from '../inventory/inventoryService';
import { todayLocalKey } from '../shared/localDate';


/** 已扣账的状态集合：流转至 Cancelled 时 fromStatus 命中才需要回冲 */
// ★ 已发运判据收口到 shared/shippingLock（此前本仓有 5 处各写一份同样的 4 值集合）
//   「库存已扣」与「货已离厂」在本仓是同一组状态，语义一致 ⇒ 共用真源。
export const STOCK_DEDUCTED_STATUSES: ReadonlySet<string> = new Set<string>(SHIPPED_SHIPMENT_STATUSES);

export interface ShipmentStockDeductResult {
  movementCount: number;
  deductedLines: Array<{ identity: string; quantity: number; unit: string | null; itemId: string }>;
  skipped: string[];
  alreadyProcessed: boolean;
}

export interface ShipmentStockReverseResult {
  movementCount: number;
  alreadyProcessed: boolean;
}

/** 库存项身份解析口径（H8 入库与 H9 扣减两侧共用，保证对称可匹配） */
export function resolveOrderLineIdentity(orderLine: { materialCode?: string | null; itemNo?: string | null }): string | null {
  const identity = (orderLine.materialCode ?? '').trim() || (orderLine.itemNo ?? '').trim();
  return identity || null;
}

interface DeductionLine {
  identity: string;
  quantity: number;
  unit: string | null;
  label: string;
}

async function collectDeductionLines(tx: any, shipmentId: string): Promise<{ lines: DeductionLine[]; skipped: string[] }> {
  const skipped: string[] = [];
  const lines: DeductionLine[] = [];

  const shipmentLines = await tx.shipmentLine.findMany({ where: { shipmentId }, orderBy: { lineNumber: 'asc' } });

  // 订单行身份解析（批量取，避免逐行查询）
  const orderLineIds = Array.from(new Set(shipmentLines.map((l: any) => l.orderLineId).filter(Boolean))) as string[];
  const orderLineById = new Map<string, any>();
  if (orderLineIds.length > 0) {
    const orderLines = await tx.orderLine.findMany({ where: { id: { in: orderLineIds } } });
    for (const ol of orderLines) orderLineById.set(ol.id, ol);
  }

  for (const l of shipmentLines) {
    const qty = l.quantity != null ? Number(l.quantity) : null;
    if (qty == null || qty <= 0) {
      skipped.push(`装运行 ${l.lineNumber}：无有效数量，跳过`);
      continue;
    }
    const ol = l.orderLineId ? orderLineById.get(l.orderLineId) : null;
    const identity = ol ? resolveOrderLineIdentity(ol) : ((l.productCode ?? '') as string).trim() || null;
    if (!identity) {
      skipped.push(`装运行 ${l.lineNumber}：无法定位库存身份（orderLineId=${l.orderLineId ?? '无'}，productCode=${l.productCode ?? '无'}），跳过`);
      continue;
    }
    lines.push({
      identity,
      quantity: qty,
      unit: l.unit ?? null,
      label: ol ? `订单行 ${ol.lineNumber}${ol.description ? ` ${ol.description}` : ''}` : `装运行 ${l.lineNumber}（productCode=${identity}）`,
    });
  }

  if (lines.length === 0 && shipmentLines.length === 0) {
    // 兜底：无装运行 → 用行级分配（DR-016 合票分配）推导
    const allocations = await tx.shipmentOrderAllocation.findMany({ where: { shipmentId } });
    const allocOrderLineIds = Array.from(new Set(allocations.map((a: any) => a.orderLineId).filter(Boolean))) as string[];
    const allocOlById = new Map<string, any>();
    if (allocOrderLineIds.length > 0) {
      const ols = await tx.orderLine.findMany({ where: { id: { in: allocOrderLineIds } } });
      for (const ol of ols) allocOlById.set(ol.id, ol);
    }
    for (const a of allocations) {
      const qty = Number(a.actualQty ?? a.plannedQty ?? 0);
      if (qty <= 0) {
        skipped.push(`分配 ${a.id}：无有效数量，跳过`);
        continue;
      }
      const ol = a.orderLineId ? allocOlById.get(a.orderLineId) : null;
      const identity = ol ? resolveOrderLineIdentity(ol) : null;
      if (!identity) {
        skipped.push(`分配 ${a.id}：无法定位订单行库存身份，跳过`);
        continue;
      }
      lines.push({ identity, quantity: qty, unit: a.unit ?? null, label: `分配行 ${ol.lineNumber}` });
    }
    if (lines.length === 0 && skipped.length === 0) {
      skipped.push('运单无装运行且无行级分配，无账可扣');
    }
  }

  return { lines, skipped };
}

/** 库存项定位：身份匹配 + 主仓优先（与 L8/L11 入库落位对称），可用量足够者优先 */
async function resolveStockItem(tx: any, identity: string, quantity: number): Promise<any | null> {
  const items = await tx.inventoryItem.findMany({
    where: { materialCode: identity, deletedAt: null, warehouse: { isActive: true, deletedAt: null } },
    include: { warehouse: true },
  });
  if (items.length === 0) return null;
  const mainFirst = (a: any, b: any) =>
    (b.warehouse.type === 'Main' ? 1 : 0) - (a.warehouse.type === 'Main' ? 1 : 0)
    || (a.warehouse.sortOrder ?? 0) - (b.warehouse.sortOrder ?? 0);
  items.sort(mainFirst);
  const sufficient = items.find((it: any) => Number(it.quantity) - Number(it.lockedQuantity ?? 0) >= quantity);
  return sufficient ?? items[0];
}

/**
 * 出运放行扣库存（在调用方事务内执行；与出运门禁同事务原子提交）。
 * 抛错（如库存不足）时由调用方事务整体回滚——运单不会停在"已放行未扣账"。
 */
export async function deductShipmentStockInTx(
  tx: any,
  prisma: any,
  shipmentId: string,
  shipmentNumber: string,
  actorId: string,
): Promise<ShipmentStockDeductResult> {
  const claim = await lockClaimShipmentSource(tx, shipmentId);
  if (claim) return deductClaimShipmentStockInTx(tx, prisma, claim, actorId);
  await lockLegacyShipmentAllocationWrite(tx, { shipmentId });

  // 幂等：该运单已有出库流水（前次执行后事务外失败的补偿场景）→ 跳过
  const existingOutbound = await tx.stockMovement.findFirst({
    where: { referenceType: 'Shipment', referenceId: shipmentId, type: 'Outbound' },
    select: { id: true },
  });
  if (existingOutbound) {
    logger.info('[ShipmentStock] outbound movements already exist, skipping deduction', { shipmentId });
    return { movementCount: 0, deductedLines: [], skipped: [], alreadyProcessed: true };
  }

  const { lines, skipped } = await collectDeductionLines(tx, shipmentId);
  if (lines.length === 0) {
    return { movementCount: 0, deductedLines: [], skipped, alreadyProcessed: false };
  }

  const inventoryService = createInventoryService(prisma);
  const movementDate = todayLocalKey();
  const deductedLines: ShipmentStockDeductResult['deductedLines'] = [];
  let movementCount = 0;

  for (const line of lines) {
    const item = await resolveStockItem(tx, line.identity, line.quantity);
    if (!item) {
      skipped.push(`物料 ${line.identity}（${line.label}）：无在库成品库存项（历史订单未入库场景），跳过扣减`);
      continue;
    }

    const base = {
      unit: line.unit ?? undefined,
      referenceType: 'Shipment' as const,
      referenceId: shipmentId,
      movementDate,
    };
    // 单条 Outbound：可用量校验（quantity − lockedQuantity）已内置对其他订单锁的尊重。
    // 不写 Lock→Outbound→Unlock——同事务内 Lock 会把自身计入锁定量导致全量出运自锁死
    // （真库实测证据见文件头注释）。
    await inventoryService.createStockMovement({
      ...base, itemId: item.id, type: 'Outbound', quantity: line.quantity,
      reason: `出运发运扣减：${shipmentNumber}`, notes: `H9 出运库存联动（${line.label}）`,
    }, actorId, { tx });

    movementCount += 1;
    deductedLines.push({ identity: line.identity, quantity: line.quantity, unit: line.unit, itemId: item.id });
  }

  logger.info('[ShipmentStock] shipment stock deducted', {
    shipmentId, shipmentNumber, movementCount, deductedLines: deductedLines.length, skipped: skipped.length,
  });
  return { movementCount, deductedLines, skipped, alreadyProcessed: false };
}

/**
 * 运单取消回冲（在调用方事务内执行）：按原 Outbound 流水逐条补反向 Inbound。
 * append-only：不改原行、不删行（对齐 materialReturnService 回冲范式）。
 */
export async function reverseShipmentStockInTx(
  tx: any,
  prisma: any,
  shipmentId: string,
  shipmentNumber: string,
  actorId: string,
): Promise<ShipmentStockReverseResult> {
  await lockLegacyShipmentAllocationWrite(tx, { shipmentId });
  // 幂等：已有回冲 Inbound → 跳过
  const existingInbound = await tx.stockMovement.findFirst({
    where: { referenceType: 'Shipment', referenceId: shipmentId, type: 'Inbound' },
    select: { id: true },
  });
  if (existingInbound) {
    logger.info('[ShipmentStock] reversal inbound already exists, skipping', { shipmentId });
    return { movementCount: 0, alreadyProcessed: true };
  }

  const outbounds = await tx.stockMovement.findMany({
    where: { referenceType: 'Shipment', referenceId: shipmentId, type: 'Outbound' },
  });
  if (outbounds.length === 0) {
    return { movementCount: 0, alreadyProcessed: false };
  }

  const inventoryService = createInventoryService(prisma);
  const movementDate = todayLocalKey();
  for (const m of outbounds) {
    await inventoryService.createStockMovement({
      itemId: m.itemId,
      type: 'Inbound',
      quantity: Number(m.quantity),
      unit: m.unit ?? undefined,
      reason: `运单取消回冲：${shipmentNumber}`,
      referenceType: 'Shipment',
      referenceId: shipmentId,
      movementDate,
      notes: `H9 取消回冲，原流水 ${m.movementNumber}`,
    }, actorId, { tx });
  }

  logger.info('[ShipmentStock] shipment stock reversed', { shipmentId, shipmentNumber, movementCount: outbounds.length });
  return { movementCount: outbounds.length, alreadyProcessed: false };
}
