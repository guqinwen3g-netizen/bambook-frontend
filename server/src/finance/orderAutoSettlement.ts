import type { PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import { SYSTEM_AUDIT_ACTOR, writeRouteAuditLog } from '../audit/routeAudit';
import { businessNowMs } from '../shared/businessClock';

/**
 * 08 决策总账 §8.4：这里只投影订单相关应收的财务结清事实。
 * 全额核销不证明生产、出运或业务履约完成，不修改这些状态或数量。
 *
 * 设计要点：
 * 1. **双向同步**：收齐自动结案；核销被撤销/调减导致出现未结清应收发票时，撤回自动结案
 *    （否则撤销核销后订单仍显示绿，是错的状态）。
 * 2. **不碰人工结案**：`settledBy === AUTO_SETTLE_ACTOR` 的才允许自动撤回；人工点「确认结清」
 *    的（settledBy 是真实 userId）一律保留——人确认过，系统无权替他反悔。
 * 3. **无应收发票的订单不参与**：没有票就无从判断"收齐"，仍走人工确认（既有 settleOrder 保留）。
 * 4. **fail-open**：任何异常只 warn 并跳过，绝不阻断核销本身（与通知/盖章接线同口径）。
 */

export const AUTO_SETTLE_ACTOR = 'system:auto-settle';

export type OrderAutoSettleOutcome = 'settled' | 'reverted' | 'skipped' | 'no_invoice' | 'manual_kept';

export async function syncOrderAutoSettlement(
  prisma: PrismaClient,
  orderId: string,
  opts: { source?: string; actorId?: string } = {},
): Promise<OrderAutoSettleOutcome> {
  try {
    const order = await (prisma as any).order.findFirst({
      where: { id: orderId, deletedAt: null },
      select: { id: true, settledAt: true, settledBy: true },
    });
    if (!order) return 'skipped';

    // 经发票↔订单分配（IOA）挂到本订单的发票（合并开票场景的真源）
    const ioaRows = (await (prisma as any).invoiceOrderAllocation?.findMany?.({
      where: { orderId, deletedAt: null },
      select: { invoiceId: true },
    })) ?? [];
    const ioaInvoiceIds = [...new Set(ioaRows.map((r: any) => r?.invoiceId).filter((v: any): v is string => !!v))];

    const invoices = await (prisma as any).invoice.findMany({
      where: {
        type: 'Receivable',
        deletedAt: null,
        status: { not: 'Cancelled' },
        // 订单的应收票集合 = 票头直挂 orderId ∪ 经 InvoiceOrderAllocation 分配过来的发票。
        // 合并开票（一张票挂多个订单，L2 高危②硬门禁后仅限同客户）时，非票头订单的票
        // 只存在于 IOA 上——此前只查票头会让这些订单永远判为"无应收发票"（no_invoice），
        // 收齐也不结案。口径与 shipmentBatchSettlementHook 一致。
        OR: [
          { orderId },
          ...(ioaInvoiceIds.length > 0 ? [{ id: { in: ioaInvoiceIds } }] : []),
        ],
      },
      select: { id: true, status: true },
    });
    if (invoices.length === 0) return 'no_invoice';

    const allPaid = invoices.every((i: any) => i.status === 'Paid');
    const now = BigInt(Date.now());
    const settledAt = BigInt(businessNowMs());
    const auditActorId = opts.actorId || SYSTEM_AUDIT_ACTOR;
    const source = opts.source || 'order:auto-settle';

    if (allPaid && !order.settledAt) {
      await (prisma as any).order.update({
        where: { id: orderId },
        data: { settledAt, settledBy: AUTO_SETTLE_ACTOR, updatedAt: now },
      });
      await writeRouteAuditLog({
        prisma,
        actorId: auditActorId,
        source,
        operation: 'order_auto_settle',
        targetType: 'Order',
        targetId: orderId,
        before: { settledAt: null, settledBy: null },
        after: { settledAt: settledAt.toString(), settledBy: AUTO_SETTLE_ACTOR, reason: 'all receivable invoices paid' },
        ip: null,
      }).catch(() => null);
      logger.info('[order-auto-settle] 应收发票全额核销，相关账款自动结清', { orderId });
      return 'settled';
    }

    if (!allPaid && order.settledAt && order.settledBy === AUTO_SETTLE_ACTOR) {
      // 先取快照再更新：避免依赖 update 是否回写本地对象（顺序无关，审计原值才有意义）
      const prevSettledAt = order.settledAt;
      await (prisma as any).order.update({
        where: { id: orderId },
        data: { settledAt: null, settledBy: null, updatedAt: now },
      });
      await writeRouteAuditLog({
        prisma,
        actorId: auditActorId,
        source,
        operation: 'order_auto_settle_revert',
        targetType: 'Order',
        targetId: orderId,
        before: { settledAt: prevSettledAt.toString(), settledBy: AUTO_SETTLE_ACTOR },
        after: { settledAt: null, settledBy: null, reason: 'receivable invoice no longer fully paid' },
        ip: null,
      }).catch(() => null);
      logger.info('[order-auto-settle] 出现未结清应收发票，财务结清标记已撤回', { orderId });
      return 'reverted';
    }

    // 已结案且仍全额 → 幂等无动作；未结清且属人工结案 → 保留
    return allPaid ? 'skipped' : 'manual_kept';
  } catch (e: any) {
    logger.warn('[order-auto-settle] 自动结案同步失败（fail-open，不阻断核销）', {
      orderId,
      error: e?.message ?? String(e),
    });
    return 'skipped';
  }
}

/**
 * 解析一张发票关联的**全部**订单：票头直挂 orderId ∪ InvoiceOrderAllocation 分配订单。
 *
 * 口径与 `shipmentBatchSettlementHook.notifyShipmentBatchSettlementRecalc` 逐字一致——
 * 此前本模块只看票头 orderId，合并开票（一张票挂多个订单）时只有票头那个订单会被结案，
 * 其余订单永远不结案（静默不一致）。两个 hook 必须同口径。
 */
export async function resolveInvoiceOrderIds(client: any, invoiceId: string): Promise<string[]> {
  const ids = new Set<string>();
  const ioa = (await client?.invoiceOrderAllocation?.findMany?.({
    where: { invoiceId, deletedAt: null },
    select: { orderId: true },
  })) ?? [];
  for (const r of ioa) {
    if (r?.orderId) ids.add(r.orderId);
  }
  const inv = await client?.invoice?.findUnique?.({ where: { id: invoiceId }, select: { orderId: true } });
  if (inv?.orderId) ids.add(inv.orderId);
  return [...ids];
}

/**
 * 按发票反查订单后同步（核销变更的调用点只知道 invoiceId）。
 *
 * 覆盖该发票关联的**所有**订单（票头 ∪ 分配）；任一订单结案/撤回即反映在返回值上，
 * 便于调用方观测（无关联订单时返回 'skipped'）。fail-open：内部全程 catch，绝不抛出。
 */
export async function syncOrderAutoSettlementByInvoice(
  prisma: PrismaClient,
  invoiceId: string,
  opts: { source?: string; actorId?: string } = {},
): Promise<OrderAutoSettleOutcome> {
  try {
    const orderIds = await resolveInvoiceOrderIds(prisma, invoiceId);
    if (orderIds.length === 0) return 'skipped';
    const outcomes: OrderAutoSettleOutcome[] = [];
    for (const orderId of orderIds) {
      outcomes.push(await syncOrderAutoSettlement(prisma, orderId, opts));
    }
    // 有实质动作（结案/撤回）优先反映，否则回最后一个订单的结果
    if (outcomes.includes('settled')) return 'settled';
    if (outcomes.includes('reverted')) return 'reverted';
    return outcomes[outcomes.length - 1] ?? 'skipped';
  } catch (e: any) {
    logger.warn('[order-auto-settle] 反查订单失败（fail-open）', { invoiceId, error: e?.message ?? String(e) });
    return 'skipped';
  }
}
