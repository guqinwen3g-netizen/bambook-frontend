/**
 * Phase 3 跨模块联动 — L9
 *
 * 业务规则：报价被接受（QuotationAccepted）→ 自动转为订单草稿
 *
 * 设计决策：
 *   - 复用 quotationService.convertToOrder（统一建单逻辑，避免双套逻辑漂移）
 *   - 手动转化（报价页"转为订单"按钮）与自动转化（本联动）共享同一入口与幂等保护
 *   - 重复保护：已有 convertedOrderId 拒绝再次建单；本事件缺少原命令回执时待人工核对
 *   - 联动失败不阻断报价接受（businessEventBus fire-and-forget）
 *
 * 与手动转化的关系：
 *   - 默认 enabled=true：报价接受即自动建单，业务员在订单管理中直接看到草稿
 *   - 若业务希望"先人工确认再建单"，可在设置中关闭 L9，改用手动按钮
 *
 * 幂等性：
 *   - in-process: `auto:L9:${quotationId}` 去重
 *   - 业务层: convertToOrder 校验 convertedOrderId，已有指针不冒认新事件成功 → 返回 not-ok
 */

import { businessEventBus } from '../businessEventBus';
import { createQuotationService } from '../../quotations/quotationService';
import { isLinkageEnabled } from '../../config/automationConfig';
import { logger } from '../../lib/logger';

export function registerL9ConvertQuotationToOrder(): void {
  businessEventBus.registerLinkage({
    id: 'L9_convert_quotation_to_order',
    eventType: 'QuotationAccepted',
    idempotencyKey: (e) => `auto:L9:${e.sourceEntityId}`,
    execute: async (prisma, event) => {
      if (!isLinkageEnabled('L9_convert_quotation_to_order')) {
        logger.info('[L9] linkage disabled, skipping', { quotationId: event.sourceEntityId });
        return { ok: true, created: null, error: 'linkage disabled' };
      }

      const quotationId = event.sourceEntityId;
      if (!quotationId) {
        logger.warn('[L9] QuotationAccepted event missing sourceEntityId, skipping', { eventId: event.id });
        return { ok: true, created: null, error: 'no quotationId' };
      }

      try {
        // 复用统一建单服务（内部已做幂等 + 状态校验 + 审计）
        const quotationService = createQuotationService(prisma);
        const result = await quotationService.convertToOrder(quotationId, event.actorId || 'system', undefined, {mode:'accepted_event',event});

        logger.info('[L9] order draft auto-created from quotation', {
          quotationId,
          orderId: result.orderId,
        });

        return {
          ok: true,
          created: {
            orderId: result.orderId,
            quotationId,
          },
        };
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        // A converted pointer is not this event's immutable success receipt.
        // Preserve it and require review until the command-receipt protocol is installed.
        logger.error('[L9] convertQuotationToOrder failed', {
          error: msg,
          quotationId,
          eventId: event.id,
        });
        return { ok: false, error: msg };
      }
    },
  });
}
