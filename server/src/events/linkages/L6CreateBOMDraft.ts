/**
 * Phase 2 跨模块联动 — L6
 *
 * 业务规则：订单确认（OrderConfirmed）→ 自动生成 BOM 草稿
 *
 * 设计决策：
 *   - 查询订单的 product 字段（产品描述）和 poNumber
 *   - 查找匹配的模板 BOM（Confirmed/Archived，description 包含订单产品名）
 *   - 若找到模板 → 复制物料行 + 成本估算项到新 Draft BOM
 *   - 若无模板 → 创建含单行占位物料的 BOM（用户需补充）
 *   - 新 BOM 关联 orderId
 *
 * 幂等性：
 *   - in-process: `auto:L6:${orderId}` 去重
 *   - 业务层: 查询是否已有 orderId 关联的 BOM，有则跳过
 */

import { businessEventBus } from '../businessEventBus';
import { createBOMService } from '../../bom/bomService';
import { isLinkageEnabled } from '../../config/automationConfig';
import { logger } from '../../lib/logger';

export function registerL6CreateBOMDraft(): void {
  businessEventBus.registerLinkage({
    id: 'L6_create_bom_draft',
    eventType: 'OrderConfirmed',
    idempotencyKey: (e) => `auto:L6:${e.orderId ?? e.sourceEntityId}`,
    execute: async (prisma, event) => {
      if (!isLinkageEnabled('L6_create_bom_draft')) {
        logger.info('[L6] linkage disabled, skipping', { orderId: event.orderId });
        return { ok: true, created: null, error: 'linkage disabled' };
      }

      const orderId = event.orderId;
      if (!orderId) {
        logger.warn('[L6] OrderConfirmed event missing orderId, skipping', { eventId: event.id });
        return { ok: true, created: null, error: 'no orderId' };
      }

      try {
        // 查询订单
        const order = await prisma.order.findUnique({
          where: { id: orderId },
          select: { id: true, product: true, poNumber: true, customer: true, currency: true },
        });

        if (!order) {
          logger.warn('[L6] order not found', { orderId });
          return { ok: false, error: `order ${orderId} not found` };
        }

        // 幂等：检查是否已有该 orderId 关联的 BOM
        const existingBOM = await prisma.bOM.findFirst({
          where: { orderId, deletedAt: null },
          select: { id: true, bomNumber: true },
        });
        if (existingBOM) {
          logger.info('[L6] BOM already exists for this order, skipping', {
            orderId, bomId: existingBOM.id, bomNumber: existingBOM.bomNumber,
          });
          return { ok: true, created: null, error: 'BOM already exists' };
        }

        // 查找匹配的模板 BOM（Confirmed/Archived，description 包含订单产品名）
        const productName = order.product || '';
        let templateBOM: any = null;
        if (productName) {
          templateBOM = await prisma.bOM.findFirst({
            where: {
              status: { in: ['Confirmed', 'Archived'] },
              deletedAt: null,
              description: { contains: productName },
            },
            include: {
              lines: { orderBy: { lineNumber: 'asc' } },
              costEstimates: { orderBy: { createdAt: 'asc' } },
            },
            orderBy: { updatedAt: 'desc' },
          });
        }

        let lines: any[];
        let costEstimates: any[];
        let bomDescription: string;
        let currency: string;
        let sellingPrice: number | undefined;

        if (templateBOM) {
          // 从模板复制
          lines = templateBOM.lines.map((line: any) => ({
            materialType: line.materialType,
            materialCode: line.materialCode ?? undefined,
            description: line.description,
            category: line.category ?? undefined,
            specification: line.specification ?? undefined,
            quantity: Number(line.quantity),
            unit: line.unit,
            wastagePercent: Number(line.wastagePercent ?? 0),
            unitCost: Number(line.unitCost),
            notes: line.notes ?? undefined,
          }));
          costEstimates = templateBOM.costEstimates.map((ce: any) => ({
            costType: ce.costType,
            description: ce.description,
            amount: Number(ce.amount),
            notes: ce.notes ?? undefined,
          }));
          bomDescription = `订单 ${order.poNumber || orderId} 的 BOM（从模板 ${templateBOM.bomNumber} 复制）`;
          currency = templateBOM.currency;
          sellingPrice = templateBOM.sellingPrice ? Number(templateBOM.sellingPrice) : undefined;
        } else {
          // 无模板：创建占位 BOM（单行占位物料）
          lines = [{
            materialType: 'Main' as const,
            description: `${productName || '待补充物料'}（占位行，请编辑补充）`,
            quantity: 1,
            unit: 'PC',
            unitCost: 0,
          }];
          costEstimates = [];
          bomDescription = `订单 ${order.poNumber || orderId} 的 BOM（自动生成，待补充）`;
          currency = order.currency || 'CNY';
          sellingPrice = undefined;
        }

        // 创建 Draft BOM
        const bomService = createBOMService(prisma);
        const bomNumber = `BOM-AUTO-${(order.poNumber || orderId).slice(-6).replace(/[^a-zA-Z0-9]/g, '')}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;

        const bom = await bomService.createBOM({
          bomNumber,
          description: bomDescription,
          orderId,
          currency,
          sellingPrice,
          notes: templateBOM
            ? `L6 联动自动生成，模板来源：${templateBOM.bomNumber}`
            : `L6 联动自动生成（无匹配模板），订单产品：${productName}`,
          lines,
          costEstimates,
        }, event.actorId || 'system');

        logger.info('[L6] BOM draft created', {
          orderId,
          bomId: bom.id,
          bomNumber: bom.bomNumber,
          fromTemplate: !!templateBOM,
          templateBOMNumber: templateBOM?.bomNumber,
          lineCount: lines.length,
        });

        return {
          ok: true,
          created: {
            bomId: bom.id,
            bomNumber: bom.bomNumber,
            fromTemplate: !!templateBOM,
            lineCount: lines.length,
          },
        };
      } catch (e: any) {
        logger.error('[L6] createBOMDraft from order failed', {
          error: e?.message,
          orderId,
          eventId: event.id,
        });
        return { ok: false, error: String(e?.message ?? e) };
      }
    },
  });
}
