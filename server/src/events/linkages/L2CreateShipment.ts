/**
 * Phase 1 Sprint 3 — 联动执行器 L2
 *
 * 业务规则：生产完成（ProductionCompleted）→ 自动创建发货单草稿
 *
 * 设计决策：
 *   - 仅创建 Draft 状态发货单，不自动订舱/发运（需人工补充装箱/物流信息）
 *   - 默认 type=Export, shippingMethod=Sea（服装外贸最常见场景，用户可改）
 *   - 从订单快照带出 customerName/customerRelationId，保持数据一致性
 *
 * 幂等性：
 *   - in-process: `auto:L2:${orderId}` 去重
 *   - 业务层: 先查询是否已有该订单的发货单，有则跳过
 */

import { businessEventBus } from '../businessEventBus';
import { randomUUID } from 'node:crypto';
import { createShipment } from '../../shipping/shipmentMutationService';
import { isLinkageEnabled } from '../../config/automationConfig';
import { logger } from '../../lib/logger';
import { todayLocalKey } from '../../shared/localDate';


export function registerL2CreateShipment(): void {
  businessEventBus.registerLinkage({
    id: 'L2_create_shipment',
    eventType: 'ProductionCompleted',
    idempotencyKey: (e) => `auto:L2:${e.orderId ?? e.sourceEntityId}`,
    execute: async (prisma, event) => {
      if (!isLinkageEnabled('L2_create_shipment')) {
        logger.info('[L2] linkage disabled, skipping', { orderId: event.orderId });
        return { ok: true, created: null, error: 'linkage disabled' };
      }
      const orderId = event.orderId;
      if (!orderId) {
        logger.warn('[L2] ProductionCompleted event missing orderId, skipping', { eventId: event.id });
        return { ok: true, created: null, error: 'no orderId' };
      }

      try {
        // 幂等检查：该订单是否已有发货单
        const existing = await prisma.shipment.findFirst({
          where: { orderId, deletedAt: null },
          select: { id: true, shipmentNumber: true },
        });
        if (existing) {
          logger.info('[L2] shipment already exists for order, skipping', {
            orderId,
            shipmentId: existing.id,
            shipmentNumber: existing.shipmentNumber,
          });
          return { ok: true, created: null, error: 'shipment already exists' };
        }

        // 查询订单快照
        const order = await prisma.order.findUnique({
          where: { id: orderId },
          select: {
            poNumber: true,
            customer: true,
            customerRelationId: true,
            currency: true,
          },
        });
        if (!order) {
          logger.warn('[L2] order not found', { orderId });
          return { ok: false, error: `order ${orderId} not found` };
        }

        // Business date stays with the simulation; the complete wall timestamp
        // and UUID suffix keep repeated registrations distinct while it is fixed.
        const ts = `${todayLocalKey().replace(/-/g, '')}-${Date.now()}-${randomUUID().slice(0, 8)}`;
        const poRef = order.poNumber || orderId.slice(-8);
        const shipmentNumber = `SHP-${poRef}-${ts}`;

        const result = await createShipment({
          prisma,
          input: {
            orderId,
            shipmentNumber,
            type: 'Export',
            status: 'Draft',
            shippingMethod: 'Sea',
            customerName: order.customer,
            customerRelationId: order.customerRelationId,
          },
          actorId: 'system',
          auditSource: 'agent:linkage:L2',
          auditOperation: 'auto_create_shipment_draft',
          syncSource: 'agent:linkage:L2',
          generateIdIfMissing: true,
        });

        if (!result.ok) {
          logger.error('[L2] createShipment returned error', {
            orderId,
            error: result.error?.message,
            code: result.error?.code,
          });
          return { ok: false, error: result.error?.message || 'create shipment failed' };
        }

        logger.info('[L2] shipment draft created', {
          orderId,
          shipmentId: result.data?.shipment.id,
          shipmentNumber,
        });
        return { ok: true, created: { shipmentId: result.data?.shipment.id, shipmentNumber } };
      } catch (e: any) {
        logger.error('[L2] createShipment failed', {
          error: e?.message,
          orderId,
          eventId: event.id,
        });
        return { ok: false, error: String(e?.message ?? e) };
      }
    },
  });
}
