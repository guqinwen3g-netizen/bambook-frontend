
/**
 * Phase 2 跨模块联动 — L11
 *
 * 业务规则：生产完成（ProductionCompleted，第 10 阶段 qc_shipped 完成）→ 成品按订单行自动入库
 *
 * 设计决策（设计真源：docs/handoff-20260916-005500.md §三-T3 H8）：
 *   - 触发粒度：整单。ProductionCompleted 是订单级事件（stageService 只在 qc_shipped
 *     完成时发一次，payload 无批次维度），入库按 OrderLine 全量行落账；
 *     分批出运的"出"侧由 H9 出运扣库存按运单行扣减，进出两侧粒度本就不同。
 *   - 库存项身份 = OrderLine.materialCode ?? itemNo（与 H9 出运扣减的
 *     resolveOrderLineIdentity 同一口径，保证入得出、扣得着）。
 *   - 默认入主仓（type=Main, isActive=true 的第一个仓库）→ 任意 active 仓，照抄 L8。
 *   - 入库流水 referenceType='Order'，referenceId=orderId。
 *
 * 幂等性（照抄 L8 范式）：
 *   - in-process: `auto:L11:${orderId}` 去重
 *   - 业务层: 查询是否已有 referenceType='Order' + referenceId=orderId 的入库流水，有则跳过
 */

import { businessEventBus } from '../businessEventBus';
import { createInventoryService } from '../../inventory/inventoryService';
import { isLinkageEnabled } from '../../config/automationConfig';
import { logger } from '../../lib/logger';
import { todayLocalKey } from '../../shared/localDate';


export function registerL11FinishedGoodsStockIn(): void {
  businessEventBus.registerLinkage({
    id: 'L11_finished_goods_stock_in',
    eventType: 'ProductionCompleted',
    idempotencyKey: (e) => `auto:L11:${e.orderId ?? e.sourceEntityId}`,
    execute: async (prisma, event) => {
      if (!isLinkageEnabled('L11_finished_goods_stock_in')) {
        logger.info('[L11] linkage disabled, skipping', { orderId: event.orderId });
        return { ok: true, created: null, error: 'linkage disabled' };
      }

      const orderId = event.orderId;
      if (!orderId) {
        logger.warn('[L11] ProductionCompleted event missing orderId, skipping', { eventId: event.id });
        return { ok: true, created: null, error: 'no orderId' };
      }

      try {
        // 幂等：检查是否已有该订单的成品入库流水
        const existingMovement = await prisma.stockMovement.findFirst({
          where: {
            referenceType: 'Order',
            referenceId: orderId,
            type: 'Inbound',
          },
          select: { id: true },
        });
        if (existingMovement) {
          logger.info('[L11] finished goods already stocked in for this order, skipping', {
            orderId, movementId: existingMovement.id,
          });
          return { ok: true, created: null, error: 'already stocked in' };
        }

        // 查询订单 + 行明细
        const order = await prisma.order.findUnique({
          where: { id: orderId },
          include: { lines: { orderBy: { lineNumber: 'asc' } } },
        });
        if (!order || order.deletedAt) {
          logger.warn('[L11] order not found', { orderId });
          return { ok: false, error: `order ${orderId} not found` };
        }

        const targetLines = (order.lines as any[])
          .filter((line: any) => line.quantity != null && Number(line.quantity) > 0)
          .map((line: any) => ({
            identity: (String(line.materialCode ?? '').trim() || String(line.itemNo ?? '').trim()) || null,
            description: line.description || line.materialCode || line.itemNo || '未知成品',
            category: line.category ?? undefined,
            specification: line.specification ?? undefined,
            unit: line.unit || 'PC',
            quantity: Number(line.quantity),
          }));

        if (targetLines.length === 0) {
          logger.info('[L11] order has no lines with quantity, skipping stock-in', { orderId });
          return { ok: true, created: null, error: 'no order lines' };
        }

        // 查找入库仓库：主仓优先（type=Main）→ 任意 active 仓（L8 同款兜底）
        let warehouse = await prisma.warehouse.findFirst({
          where: { type: 'Main', isActive: true, deletedAt: null },
          orderBy: { sortOrder: 'asc' },
        });
        if (!warehouse) {
          warehouse = await prisma.warehouse.findFirst({
            where: { isActive: true, deletedAt: null },
            orderBy: { sortOrder: 'asc' },
          });
        }
        if (!warehouse) {
          logger.warn('[L11] no active warehouse found, skipping stock-in', { orderId });
          return { ok: false, error: 'no active warehouse' };
        }

        const inventoryService = createInventoryService(prisma);
        const movementDate = todayLocalKey();
        const createdMovements: string[] = [];

        for (const line of targetLines) {
          // 查找或创建库存项（同仓 + 同身份复用，L8 同款判定）
          let inventoryItem = null;
          if (line.identity) {
            inventoryItem = await prisma.inventoryItem.findFirst({
              where: {
                warehouseId: warehouse.id,
                materialCode: line.identity,
                deletedAt: null,
              },
            });
          }

          let itemId: string;
          if (inventoryItem) {
            itemId = inventoryItem.id;
          } else {
            const newItem = await inventoryService.createInventoryItem({
              warehouseId: warehouse.id,
              materialCode: line.identity ?? undefined,
              description: line.description,
              category: line.category,
              specification: line.specification,
              quantity: 0,
              unit: line.unit,
              notes: `由订单 ${order.poNumber || orderId} 生产完成自动创建`,
            }, event.actorId || 'agent:auto');
            itemId = newItem.id;
          }

          const movement = await inventoryService.createStockMovement({
            itemId,
            type: 'Inbound',
            quantity: line.quantity,
            unit: line.unit,
            reason: `生产完成入库：${order.poNumber || orderId}`,
            referenceType: 'Order',
            referenceId: orderId,
            movementDate,
            notes: `L11 联动自动入库，订单行：${line.description}`,
          }, event.actorId || 'system');

          createdMovements.push(movement.id);
        }

        logger.info('[L11] finished goods stock-in completed', {
          orderId, poNumber: order.poNumber,
          warehouseId: warehouse.id,
          movementCount: createdMovements.length,
        });

        return {
          ok: true,
          created: {
            warehouseId: warehouse.id,
            movementIds: createdMovements,
            movementCount: createdMovements.length,
          },
        };
      } catch (e: any) {
        logger.error('[L11] finished goods stock-in failed', {
          error: e?.message,
          orderId,
          eventId: event.id,
        });
        return { ok: false, error: String(e?.message ?? e) };
      }
    },
  });
}
