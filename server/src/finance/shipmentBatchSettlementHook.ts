import { logger } from '../lib/logger';
import { createOrderShipmentBatchService } from '../shipping/orderShipmentBatchService';

/**
 * shipmentBatchSettlementHook.ts — W-A 波次 · P0-1 结算自动触发点挂接（finance → shipping）
 *
 * 设计真源：docs/design/10-评审与决策/2026-08-25-中度与严重缺失功能开发优先级规划.md P0-1
 *
 * 批次结算快照（OrderShipmentBatch.invoicedAmount/paidAmount/settleStatus）是纯派生数据，
 * 由 shipping 域 orderShipmentBatchService.recalcSettlement 从
 *   - InvoiceOrderAllocation(batchId)  发票→批次归属
 *   - InvoiceAllocation               凭证×发票核销记录
 * 聚合回写。本模块把「重算」挂到 finance 域核销事务收口处：
 *   - applyAllocation        核销创建/替换（route POST /allocations、Agent reconcileFlow、toolRuntime）
 *   - updateAllocation       核销金额调整（route PATCH /allocations/:id）
 *   - deleteAllocation       核销删除（route DELETE /allocations/:id）
 * 挂接点传入事务 client（tx），使批次快照与核销记录同事务落库，读到的是本事务最终态。
 *
 * 安全性约定：
 *  - 失败不阻断主业务：内部全量 catch + logger.warn，永不 throw；
 *  - 幂等：recalcSettlement 为无状态派生回写，重复调用结果收敛；
 *  - 发票未关联任何订单/批次时为 no-op（无批次可重算），无害。
 */

/**
 * 通知受影响订单的出运批次重算结算进度。
 * @param prisma PrismaClient 或已开的事务 client（TxLike）
 * @param opts.invoiceId 发生核销变动的发票 id
 * @param opts.source 触发来源标识（审计/日志用）
 */
export async function notifyShipmentBatchSettlementRecalc(
  prisma: any,
  opts: { invoiceId?: string | null; affectedOrderIds?: string[]; source: string },
): Promise<void> {
  const { invoiceId, source } = opts;
  if (!invoiceId || !prisma) return;
  try {
    // 受影响订单 = 发票↔订单分配行 ∪ 发票主档直挂 orderId
    const ioaRows: any[] = await prisma.invoiceOrderAllocation.findMany({
      where: { invoiceId, deletedAt: null },
      select: { orderId: true },
    });
    const orderIds = new Set<string>(opts.affectedOrderIds ?? []);
    for (const r of ioaRows) {
      if (r?.orderId) orderIds.add(r.orderId);
    }
    if (orderIds.size === 0) {
      const inv: any = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        select: { orderId: true },
      });
      if (inv?.orderId) orderIds.add(inv.orderId);
    }
    if (orderIds.size === 0) return; // 未关联订单 → 无批次可重算

    const svc = createOrderShipmentBatchService(prisma);
    for (const orderId of orderIds) {
      // recalcOrderSettlement 内部按批逐个 recalcSettlement，单批失败静默跳过不中断其余批次；
      // 本调用自身如抛错由外层 catch 兜底，不阻断主业务。
      await svc.recalcOrderSettlement(orderId);
    }
  } catch (e: any) {
    logger.warn(
      `[shipmentBatchSettlementRecalc] 核销变动后批次结算重算失败（不阻断主业务，可由下次核销动作或 markShipped 门禁前的强制重算收敛） `
      + `source=${source} invoiceId=${invoiceId} err=${String(e?.message ?? e)}`,
    );
  }
}
