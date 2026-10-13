/** Persist only the real approval decision. A supplier/CN approval never
 * creates a Disbursement or announces a bank movement; Finance records the
 * separate actual execution through the source-specific producer. */

import type { PrismaClient } from '@prisma/client';
import { approvalEventBus } from '../agent/events';
import { logger } from '../lib/logger';
import { createApprovalRoutingService } from '../approvals/approvalRoutingService';
import { createApprovalCreateService } from '../approvals/approvalCreateService';
import { createPaymentRequestService } from './paymentRequestService';

export function registerPaymentRequestApprovalHook(opts: { prisma: PrismaClient }): void {
  const { prisma } = opts;
  const approvalCreateService = createApprovalCreateService({
    prisma,
    routingService: createApprovalRoutingService({ prisma }),
  });
  const paymentRequestService = createPaymentRequestService({ prisma, approvalCreateService });

  approvalEventBus.on('resolved', (approvalId: string, payload: { decision?: string } = {}) => {
    (async () => {
      // 仅处理付款申请审批单（actionType=finance:payment_request 的申请以 approvalRequestId 反链）
      const pr = await (prisma as any).paymentRequest.findFirst({
        where: { approvalRequestId: approvalId, deletedAt: null },
      });
      if (!pr) return;
      const result = await paymentRequestService.syncApprovalDecision({
        paymentRequestId: pr.id,
        actorId: 'system_approval_hook',
      });
      if (!result.ok) {
        logger.error('[PaymentRequestHook] 审批决议回写失败', {
          approvalId, paymentRequestId: pr.id, error: result.error.code, message: result.error.message,
        });
        return;
      }
      if (result.data.synced) {
        logger.info('[PaymentRequestHook] 审批决议已回写', {
          approvalId,
          paymentRequestId: pr.id,
          decision: payload.decision,
        });
        // ApprovalDecisionService persists the approval notification. This
        // listener never announces a bank payment from an approval decision.
      }
    })().catch((e: any) => {
      // 决议已经提交；仅记录投影失败，不能以补发凭证代替补读审批结论。
      logger.error('[PaymentRequestHook] 审批决议处理异常', { approvalId, error: e?.message });
    });
  });

  logger.info('[PaymentRequestHook] DR-017 审批决议钩子已注册（approvalEventBus resolved）');
}
