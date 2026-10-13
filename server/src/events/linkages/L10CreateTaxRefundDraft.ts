/**
 * Phase B1 跨模块联动 — L10
 *
 * 业务规则：报关放行（CustomsCleared）→ 自动核算生成退税申报草稿
 *
 * 设计决策：
 *   - 复用 customsService.createTaxRefundFromDeclaration（统一核算逻辑，手动/自动同一入口）
 *   - 核算数据链：报关单行明细 + HS 退税率 + 发票/订单汇率快照 + 运单实际离港日
 *   - 幂等保护：同一报关单已存在退税申报即跳过（createTaxRefundFromDeclaration 内部也校验）
 *   - 联动失败不阻断报关放行（businessEventBus fire-and-forget）
 *
 * 闭环位置：
 *   收汇（L5 核销）→ 报关放行（CustomsCleared）→ 退税申报草稿（本联动）→ 人工提交审核
 *
 * 幂等性：
 *   - in-process: `auto:L10:${declarationId}` 去重
 *   - 业务层: createTaxRefundFromDeclaration 校验 declarationId 唯一，重复触发抛错被捕获 → 幂等成功
 */

import { businessEventBus } from '../businessEventBus';
import { createCustomsService } from '../../customs/customsService';
import { isLinkageEnabled } from '../../config/automationConfig';
import { logger } from '../../lib/logger';

export function registerL10CreateTaxRefundDraft(): void {
  businessEventBus.registerLinkage({
    id: 'L10_create_tax_refund_draft',
    eventType: 'CustomsCleared',
    idempotencyKey: (e) => `auto:L10:${e.sourceEntityId}`,
    execute: async (prisma, event) => {
      if (!isLinkageEnabled('L10_create_tax_refund_draft')) {
        logger.info('[L10] linkage disabled, skipping', { declarationId: event.sourceEntityId });
        return { ok: true, created: null, error: 'linkage disabled' };
      }

      const declarationId = event.sourceEntityId;
      if (!declarationId) {
        logger.warn('[L10] CustomsCleared event missing sourceEntityId, skipping', { eventId: event.id });
        return { ok: true, created: null, error: 'no declarationId' };
      }

      try {
        const customsService = createCustomsService(prisma);
        const refund = await customsService.createTaxRefundFromDeclaration(declarationId, event.actorId || 'system');

        logger.info('[L10] tax refund draft auto-created from customs clearance', {
          declarationId,
          taxRefundId: refund.id,
          refundNumber: refund.refundNumber,
        });

        return {
          ok: true,
          created: {
            taxRefundId: refund.id,
            refundNumber: refund.refundNumber,
            declarationId,
          },
        };
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        // 已生成过（declarationId 唯一约束）→ 视为幂等成功，不算失败
        if (msg.includes('不可重复生成')) {
          logger.info('[L10] tax refund already exists for declaration, skipping', { declarationId });
          return { ok: true, created: null, error: 'already created' };
        }
        logger.error('[L10] createTaxRefundFromDeclaration failed', {
          error: msg,
          declarationId,
          eventId: event.id,
        });
        return { ok: false, error: msg };
      }
    },
  });
}
