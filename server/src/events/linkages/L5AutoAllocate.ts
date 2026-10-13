
/**
 * 收款登记只计算匹配建议，不调用核销写服务。
 * 保留 L5_auto_allocate 标识以兼容已有配置和事件；开关开启也不会自动记账。
 * 正式核销由 invoices:reconcile 权限入口显式提交并重新校验余额。
 */

import { sumAppliedAmountByInvoice } from '../../shared/invoiceAppliedSum';
import { Prisma } from '@prisma/client';
import { businessEventBus } from '../businessEventBus';
import { isLinkageEnabled } from '../../config/automationConfig';
import { logger } from '../../lib/logger';
// ★ 「未结清应收」判据唯一真源（含 amount>0 守卫）
//   为什么这里也必须用：候选发票按 issueDate 升序只取第一条。若最早那张是 **0 元 / 负额贷项**票，
//   它会被选中 → 下游 `remaining ≤ 0` 直接 `return { ok:true, created:null }`（**静默不核销**，只有 info 日志），
//   后面那张真正该收的正额发票永远轮不到 → 钱收了却没核销：应收虚高、账龄虚高、信用额度占用虚高。
import { openReceivableWhere, RECEIVABLE_OPEN_STATUSES } from '../../shared/openReceivable';
import { todayLocalKey } from '../../shared/localDate';


export function registerL5AutoAllocate(): void {
  businessEventBus.registerLinkage({
    id: 'L5_auto_allocate',
    eventType: 'PaymentVoucherCreated',
    idempotencyKey: (e) => `auto:L5:${e.sourceEntityId}`,
    execute: async (prisma, event) => {
      if (!isLinkageEnabled('L5_auto_allocate')) {
        logger.info('[L5] linkage disabled, skipping', { voucherId: event.sourceEntityId });
        return { ok: true, created: null, error: 'linkage disabled' };
      }
      return suggestReceiptAllocation(prisma, event);

    },
  });
}

/** Read-only proposal; all balances are revalidated by the explicit finance write. */
export async function suggestReceiptAllocation(prisma: any, event: { sourceEntityId: string; payload: unknown; id: string }) {
      const voucherId = event.sourceEntityId;
      const payload = event.payload as {
        voucherNumber?: string;
        type?: string;
        amount?: string;
        currency?: string;
        invoiceId?: string;
        customerRelationId?: string;
        orderId?: string;
      };

      // 仅处理 Receipt（收款）类型凭证
      if (payload.type && payload.type !== 'Receipt') {
        logger.info('[L5] voucher is not Receipt type, skipping auto-allocate', {
          voucherId,
          type: payload.type,
        });
        return { ok: true, created: null, error: 'not receipt type' };
      }

      try {
        // 查询凭证完整信息
        const voucher = await prisma.paymentVoucher.findUnique({
          where: { id: voucherId },
          select: {
            id: true,
            voucherNumber: true,
            type: true,
            amount: true,
            currency: true,
            invoiceId: true,
            orderId: true,
            customerRelationId: true,
            status: true,
            appliedAmount: true,
            deletedAt: true,
          },
        });
        if (!voucher) {
          logger.warn('[L5] voucher not found', { voucherId });
          return { ok: false, error: `voucher ${voucherId} not found` };
        }

        // 已核销的凭证跳过
        if (voucher.deletedAt || voucher.type !== 'Receipt' || !['unreconciled', 'partially_reconciled'].includes(voucher.status)) {
          logger.info('[L5] voucher already reconciled, skipping', { voucherId });
          return { ok: true, created: null, error: 'already reconciled' };
        }

        // 计算凭证剩余可核销金额
        const voucherAmount = new Prisma.Decimal(voucher.amount);
        const alreadyApplied = voucher.appliedAmount ? new Prisma.Decimal(voucher.appliedAmount) : new Prisma.Decimal(0);
        const remainingVoucherAmount = voucherAmount.minus(alreadyApplied);
        if (remainingVoucherAmount.lte(0)) {
          logger.info('[L5] voucher has no remaining amount to allocate', {
            voucherId,
            amount: voucherAmount.toString(),
            applied: alreadyApplied.toString(),
          });
          return { ok: true, created: null, error: 'no remaining amount' };
        }

        // 解析目标发票
        const targetInvoiceId = await resolveTargetInvoiceId(prisma, voucher, payload);
        if (!targetInvoiceId) {
          logger.info('[L5] no matching outstanding invoice found, skipping', {
            voucherId,
            orderId: voucher.orderId,
            customerRelationId: voucher.customerRelationId,
          });
          return { ok: true, created: null, error: 'no matching invoice' };
        }

        // 查询发票剩余金额
        const invoice = await prisma.invoice.findUnique({
          where: { id: targetInvoiceId },
          select: { id: true, invoiceNumber: true, amount: true, status: true, currency: true, type: true, deletedAt: true },
        });
        if (!invoice) {
          logger.warn('[L5] target invoice not found', { invoiceId: targetInvoiceId });
          return { ok: false, error: `invoice ${targetInvoiceId} not found` };
        }

        // 仅处理「未结清应收」状态发票 —— ★ 判据走唯一真源，不再内联字面量。
        // 注意这一处是**承重**的（不是防御性重复）：`resolveTargetInvoiceId` 的 path 1
        // （凭证显式指定 `invoiceId`）会**绕过** where 过滤直接返回 id，
        // 所以「状态是否可核销」只有这里把关。
        if (invoice.deletedAt || invoice.type !== 'Receivable' || invoice.currency !== voucher.currency || !(RECEIVABLE_OPEN_STATUSES as readonly string[]).includes(invoice.status)) {
          logger.info('[L5] invoice not in allocatable status, skipping', {
            invoiceId: targetInvoiceId,
            status: invoice.status,
          });
          return { ok: true, created: null, error: 'invoice not allocatable' };
        }

        // 计算发票剩余金额 = 发票金额 - 已核销总额
        const applied = await sumAppliedAmountByInvoice(prisma, [targetInvoiceId]);
        const invoiceAmount = new Prisma.Decimal(invoice.amount);
        const alreadyAllocated = new Prisma.Decimal(applied.get(targetInvoiceId) ?? 0);
        const remainingInvoiceAmount = invoiceAmount.minus(alreadyAllocated);
        if (remainingInvoiceAmount.lte(0)) {
          logger.info('[L5] invoice already fully allocated', {
            invoiceId: targetInvoiceId,
            amount: invoiceAmount.toString(),
            allocated: alreadyAllocated.toString(),
          });
          return { ok: true, created: null, error: 'invoice fully allocated' };
        }

        // 核销金额 = min(凭证剩余, 发票剩余)
        const allocateAmount = Prisma.Decimal.min(remainingVoucherAmount, remainingInvoiceAmount);
        const today = todayLocalKey();

        // A match is a proposal only. Recording a receipt never authorizes allocation.
        logger.info('[L5] allocation suggestion ready for finance confirmation', {
          voucherId, invoiceId: targetInvoiceId, suggestedAmount: allocateAmount.toString(),
        });
        return {
          ok: true,
          created: {
            kind: 'allocation_suggestion',
            requiresFinanceConfirmation: true,
            voucherId,
            invoiceId: targetInvoiceId,
            suggestedAmount: allocateAmount.toString(),
            suggestedDate: today,
          },
        };
      } catch (e: any) {
        logger.error('[L5] autoAllocate failed', {
          error: e?.message,
          voucherId,
          eventId: event.id,
        });
        return { ok: false, error: String(e?.message ?? e) };
      }
}

/**
 * 解析目标发票 ID：
 * 1. 优先使用凭证上的 invoiceId（用户创建凭证时已指定）
 * 2. 其次按 orderId 查找该订单的 Receivable 发票
 * 3. 最后按 customerRelationId 查找客户未结清的 Receivable 发票
 */
export async function resolveTargetInvoiceId(
  prisma: any,
  voucher: { invoiceId: string | null; orderId: string | null; customerRelationId: string | null },
  payload: { invoiceId?: string },
): Promise<string | null> {
  // 1. 凭证已指定 invoiceId
  const explicitInvoiceId = voucher.invoiceId || payload.invoiceId;
  if (explicitInvoiceId) return explicitInvoiceId;

  // 2. 按 orderId 查找未结清应收发票（★ 判据走真源：含 amount>0，跳过 0 元/负额票）
  if (voucher.orderId) {
    const byOrder = await prisma.invoice.findFirst({
      where: openReceivableWhere({ orderId: voucher.orderId }),
      orderBy: { issueDate: 'asc' }, // 优先核销最早的发票
      select: { id: true },
    });
    if (byOrder) return byOrder.id;
  }

  // 3. 按 customerRelationId 查找
  if (voucher.customerRelationId) {
    const byCustomer = await prisma.invoice.findFirst({
      where: openReceivableWhere({ customerRelationId: voucher.customerRelationId }),
      orderBy: { issueDate: 'asc' },
      select: { id: true },
    });
    if (byCustomer) return byCustomer.id;
  }

  return null;
}
