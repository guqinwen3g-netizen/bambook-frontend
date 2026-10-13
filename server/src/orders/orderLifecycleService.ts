import { loadUserWithRoles, buildLoadedAuthTokenPayload } from '../auth/tokenHelpers';
/**
 * ERP-P1-order-lifecycle-route-foundation
 *
 * Order 软删 + 状态流转 service（route + Agent flow 共用契约）。
 * 业务写入 + Order EntityLink inactive + AuditLog 同事务闭环，失败 fail closed。
 * status-transition 只允许 6 状态枚举（Pending/Confirmed/Production/Shipping/Delivered/Alert），不新增 Cancelled。
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { writeRouteAuditLog, SYSTEM_AUDIT_ACTOR } from '../audit/routeAudit';
import { syncOrderEntityReferences, deactivateEntityLinks } from '../entities/sync';
import { publishBusinessEvent, persistBusinessEventInTransaction, type BusinessEvent } from '../events/businessEventBus';
import { logger } from '../lib/logger';
import { createCreditService } from '../credit/creditService';
import { createMoqConfigService } from '../moq/moqConfigService';
import { createMoqResolutionService } from '../moq/moqResolutionService';
import { buildActualMoqLines, findCurrentMoqApproval, actualMoqFamily, lockMoqBasisRows } from '../moq/moqApprovalBasis';
import { createMoqValidationService } from '../moq/moqValidationService';
import { createApprovalRoutingService } from '../approvals/approvalRoutingService';
import { createApprovalCreateService } from '../approvals/approvalCreateService';
import { createCreditExceptionService, resolveCreditException, consumeCreditException, CREDIT_EXCEPTION_CONSUMPTION_HTTP_STATUS, type CreditExceptionConsumptionErrorCode } from '../credit/creditExceptionGate';
import type { ActiveExceptionSummary, ExceptionScopeMatch } from '../exceptions/exceptionGate';
import type { ExceptionService } from '../exceptions/exceptionService';
import { createExceptionService } from '../exceptions/exceptionService';
// ★ G-4（矩阵 :136「订单确认时若付款方式为 L/C ⇒ 必须已登记信用证，否则不得确认」）
import { decideLcGate, LC_ORDER_CONFIRM_ACTION } from '../customs/lcGate';

export const VALID_ORDER_STATUSES = ['Pending', 'Confirmed', 'Production', 'Shipping', 'Delivered', 'Alert'] as const;
const VALID_STATUS_SET = new Set<string>(VALID_ORDER_STATUSES);

// Order 合法状态转换矩阵（from -> Set<to>）
export const ORDER_TRANSITIONS: Record<string, Set<string>> = {
  Pending: new Set(['Confirmed', 'Alert']),
  Confirmed: new Set(['Production', 'Alert']),
  Production: new Set(['Shipping', 'Alert']),
  Shipping: new Set(['Delivered', 'Alert']),
  Delivered: new Set(), // 终态
  Alert: new Set(['Pending', 'Confirmed', 'Production', 'Shipping']), // 恢复到非终态
};

export type OrderLifecycleErrorCode =
  | 'ORDER_NOT_FOUND'
  | 'ORDER_ALREADY_DELETED'
  | 'INVALID_STATUS'
  | 'INVALID_TRANSITION'
  | 'ORDER_LINE_WORKFLOW_REQUIRED'
  | 'NO_CHANGE'
  | 'DELETE_FAILED'
  | 'TRANSITION_FAILED'
  | 'ORDER_MAIN_APPROVAL_REQUIRED'
  // ── 确认门禁错误码（W-A 走查 DE-1/DE-6 修复；fail-closed） ──
  // MOQ_VIOLATION：Confirmed 门禁命中（低于 MOQ 且无 approved 豁免审批单），HTTP 409
  // CREDIT_FROZEN_60_DAYS / CREDIT_REVOKED / OVERDUE_60_DAYS：信用门禁阻断，HTTP 403
  // CREDIT_CHECK_FAILED：信用门禁自身故障（fail-closed 阻断），HTTP 500
  | 'MOQ_VIOLATION'
  | 'CREDIT_FROZEN_60_DAYS'
  | 'CREDIT_REVOKED'
  | 'OVERDUE_60_DAYS'
  | 'CREDIT_CHECK_FAILED'
  // LC_GATE_BLOCKED（G-4）：信用证门禁阻断确认（未登记 / 已过期 / 已注销），HTTP 403
  | 'LC_GATE_BLOCKED'
  // LC_EXCEPTION_CHECK_FAILED：信用证条款不满足、且**例外状态查不出来** ⇒ 仍阻断，但下一步是排障不是补证
  //（与 CREDIT_CHECK_FAILED 同档：门禁自身没结论 = 阻断，不当成"没例外"直接报门禁失败）
  | 'LC_EXCEPTION_CHECK_FAILED'
  // ── B14（refs G3-LA · G4.4 缺口③）──
  // DEPENDENCY_CHECK_FAILED：删除守卫的依赖计数**本身查不出来**。
  // 校验没结论 ≠ 「没有依赖」⇒ 必须拒删（fail-closed），HTTP 503（可重试的服务端无法完成）。
  // 注：`HAS_DEPENDENTS`（查到确实有依赖 ⇒ 409 拒删）至今**不在**本联合类型里，
  //     它靠 deleteOrder 的 `catch (e: any)` 和 route.ts 自带的一份映射活着 —— 已登记为遗留项。
  | 'DEPENDENCY_CHECK_FAILED';

// 注：DR-010 守卫运行时使用 'ORDER_LIFECYCLE_GUARDED' / 'ORDER_ALREADY_CLOSED' 错误码
// （见 ORDER_LIFECYCLE_EXTENSION_ERRORS 常量与 transitionOrderStatus 守卫 throw）。
// 二者不进本联合类型——OrderLifecycleErrorCode 被 agent/orderLifecycleFlow.ts 的
// Record<OrderLifecycleFlowErrorCode, string> 穷举消费，扩展需跨域协调（属 Track A 所有权）。

// ────────────────────────────────────────────────────────────────
// DR-010 扩展状态（不进 6 态枚举/矩阵；由 orderChanges 域服务直写）
//   CancelRequested 取消申请中 / PauseRequested 暂停申请中 / Closing 结案处理中：
//     守卫态——订单存在进行中的取消/暂停/结案处置，禁止常规 6 态推进
//   Paused 暂停中：暂停审批通过后的生效态，禁止常规推进（恢复走 Alert 通道或撤回）
//   Cancelled 已关闭：取消结案终态（等效软删）
// 设计真源：订单变更规则.md §2A / 订单状态机.md §14.3
// ────────────────────────────────────────────────────────────────
export const DR010_EXTENSION_STATUSES = ['CancelRequested', 'PauseRequested', 'Closing', 'Paused', 'Cancelled'] as const;
export type DR010ExtensionStatus = (typeof DR010_EXTENSION_STATUSES)[number];

/** 守卫态集合：处于这些状态的订单禁止 transitionOrderStatus 常规推进（fail-closed） */
export const DR010_GUARDED_STATUSES: ReadonlySet<string> = new Set([
  'CancelRequested',
  'PauseRequested',
  'Closing',
  'Paused',
]);

export const ORDER_LIFECYCLE_EXTENSION_ERRORS = {
  ORDER_LIFECYCLE_GUARDED: 'ORDER_LIFECYCLE_GUARDED',
  ORDER_ALREADY_CLOSED: 'ORDER_ALREADY_CLOSED',
} as const;

export type OrderLifecycleExtensionErrorCode =
  (typeof ORDER_LIFECYCLE_EXTENSION_ERRORS)[keyof typeof ORDER_LIFECYCLE_EXTENSION_ERRORS];

/**
 * 错误码 → HTTP 状态码的**唯一真源**（route / agent flow 都从这里取，别在调用点各写一份）。
 *
 * 为什么必须收在一处 —— 本仓已**三次**踩同一坑：调用点各自维护硬编码
 * `statusCodeMap[code] || 500`，新增业务码忘了补 → 兜成 **500**，
 * 用户看到「服务器错误」而实际只是状态/参数问题（前两次：`toAllocationError`、
 * `toError`，见 handoff-20260917-051500 / -074500）。
 *
 * 第三次（本处，2026-09-17 真库演练 `scripts/acceptance-pending-cancel-path.mjs` S11 实测）：
 * DR-010 守卫的两个码由 `throw` 抛出、**刻意不进 `OrderLifecycleErrorCode` 联合类型**
 * （见上方 :55-58 注释），于是 `orders/route.ts` 的 statusCodeMap 全部漏掉 →
 * 「订单处于取消申请中」时推进状态返回 **HTTP 500**（应为 409）。
 *
 * 类型写成 `Record<OrderLifecycleErrorCode | OrderLifecycleExtensionErrorCode, number>`：
 * **少一个键就编译不过** —— 下次加码的人被编译器拦住，而不是等用户看到 500。
 */
export const ORDER_LIFECYCLE_ERROR_HTTP_STATUS: Record<
  OrderLifecycleErrorCode | OrderLifecycleExtensionErrorCode | CreditExceptionConsumptionErrorCode,
  number
> = {
  ORDER_NOT_FOUND: 404,
  ORDER_ALREADY_DELETED: 409,
  INVALID_STATUS: 400,
  INVALID_TRANSITION: 400,
  ORDER_LINE_WORKFLOW_REQUIRED: 409,
  NO_CHANGE: 400,
  DELETE_FAILED: 500,
  TRANSITION_FAILED: 500,
  ORDER_MAIN_APPROVAL_REQUIRED: 409,
  // 确认门禁（fail-closed）
  MOQ_VIOLATION: 409,
  // LC_GATE_BLOCKED（G-4）：与信用门禁同档 —— 业务判定「这件事不许做」⇒ 403
  //（要改的是「先去登记信用证」这个前提，而不是原样重试）
  LC_GATE_BLOCKED: 403,
  LC_EXCEPTION_CHECK_FAILED: 500,
  CREDIT_FROZEN_60_DAYS: 403,
  CREDIT_REVOKED: 403,
  OVERDUE_60_DAYS: 403,
  CREDIT_CHECK_FAILED: 500,
  // B14：依赖校验没结论 ⇒ 拒删。503（服务端无法完成前置校验，可重试），
  // 不是 500（DELETE_FAILED 留给「删除动作本身失败」），也不是 409（HAS_DEPENDENTS 才是冲突）。
  DEPENDENCY_CHECK_FAILED: 503,
  // DR-010 守卫态 / 已关闭终态 —— 都是「冲突」而非「服务器错误」，必须 409
  ORDER_LIFECYCLE_GUARDED: 409,
  ORDER_ALREADY_CLOSED: 409,
  ...CREDIT_EXCEPTION_CONSUMPTION_HTTP_STATUS,
};

/** 订单是否处于 DR-010 守卫态（取消/暂停申请中、结案处理中、暂停中） */
export function isOrderLifecycleGuarded(status: string | null | undefined): boolean {
  return !!status && DR010_GUARDED_STATUSES.has(status);
}

/** 订单是否已关闭（取消结案终态） */
export function isOrderClosed(status: string | null | undefined): boolean {
  return status === 'Cancelled';
}

export interface OrderLifecycleError {
  code: OrderLifecycleErrorCode;
  message: string;
  /** MOQ_VIOLATION 时透传自动发起的豁免审批单 id（DR-007），供前端跳转审批 */
  approvalRequestId?: string;
}

/** Only mutation results can contain failed consumption of a used exception.
 * Preflight gates never consume and keep the original finite gate contract. */
export type OrderLifecycleMutationError = Omit<OrderLifecycleError, 'code'> & {
  code: OrderLifecycleErrorCode | OrderLifecycleExtensionErrorCode | CreditExceptionConsumptionErrorCode;
};

/**
 * ★ B14（refs G3-LA · G4.4 缺口③）：依赖/关联计数**查不出来**时的拒绝文案。
 * 说清「为什么」（校验没完成）+「结果」（删除已阻止）+「下一步」（重试或找管理员）—— G7.5。
 * 真源是 `shared/errorCodes` 注册表里同码的那句；本常量是 orders 域内两处 throw 的共用副本，
 * 二者逐字相同由 `deleteOrderDependencyGuardFailClosed.test.ts` 钉住（改一处忘另一处即红）。
 */
export const DEPENDENCY_CHECK_FAILED_MESSAGE =
  '关联单据校验未能完成，无法确认是否还有下游单据，为避免误删，本次删除已阻止，请稍后重试或联系管理员。';

/**
 * 造 B14 的拒绝错误。**必须在事务回调内 throw** —— 异常穿出 `$transaction` 回调
 * 即由 Prisma 回滚本次删除已做的全部写入；不得改成「catch 后 return false」（那放行写入）。
 * 状态码取自 `ORDER_LIFECYCLE_ERROR_HTTP_STATUS`（orders 域映射真源，少一个键就编译不过）。
 */
export function dependencyCheckFailedError(): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(DEPENDENCY_CHECK_FAILED_MESSAGE), {
    code: 'DEPENDENCY_CHECK_FAILED',
    statusCode: ORDER_LIFECYCLE_ERROR_HTTP_STATUS.DEPENDENCY_CHECK_FAILED,
  });
}

// ────────────────────────────────────────────────────────────────
// Order 软删
// ────────────────────────────────────────────────────────────────

export interface DeleteOrderParams {
  prisma: PrismaClient;
  orderId: string;
  actorId?: string;
}

export interface DeleteOrderResult {
  ok: boolean;
  error?: OrderLifecycleError;
  data?: { order: any; auditId: string };
}

export async function deleteOrder(params: DeleteOrderParams): Promise<DeleteOrderResult> {
  const { prisma, orderId, actorId } = params;
  const now = BigInt(Date.now());

  try {
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const existing = await tx.order.findUnique({ where: { id: orderId } });
      if (!existing) {
        throw Object.assign(new Error(`Order ${orderId} not found`), { code: 'ORDER_NOT_FOUND', statusCode: 404 });
      }
      if (existing.deletedAt) {
        throw Object.assign(new Error(`Order ${orderId} already deleted`), { code: 'ORDER_ALREADY_DELETED', statusCode: 409 });
      }

      // 检查关联实体：有发票/出运/凭证/核销分摊/批次计划的订单不可删除
      // （DR-016 合票时代订单经 InvoiceOrderAllocation/ShipmentOrderAllocation 多对多关联，
      //   直接 orderId 与分配表双口径都查，防分摊链软删断链）
      // ★ G4.4 缺口②（v2.49）：批次计划 OrderShipmentBatch 是第六路 —— 原先没有它，
      //   而删单路径不清理批次、`L3IssueInvoice` 与催款又继续读这些行 ⇒ 可构造（见守卫测试）。
      //
      // ★ B14（refs G3-LA · G4.4 缺口③）：这**六**个计数是**判定值**，不是显示值 ——
      // 原先每路各挂一个 `.catch(() => 0)`，把「查不出来」变成了「查出来没有依赖」，
      // 于是这条守卫的失败方向是**放行**。构造验证已确认（docs/B14-fail-open删除守卫-构造验证-2026-09-20.md
      // §3b：真库 + 真 deleteOrder）：订单挂 1 张活发票、`tx.invoice.count` 抛客户端侧校验错
      // ⇒ `ok = true` 且**事务提交**、发票成孤儿。区分点：引擎级错误会连带回滚（无害），
      // **Prisma 客户端侧错误不污染事务**（PG 未收到语句），后面的 `tx.order.update` 照写照提交（有害）。
      // 所以这里**不吞错**：任一跳数查询失败即在事务内抛出显式错误，让 Prisma 回滚整个删除。
      // 同仓先例（同口径、原本就没挂 catch）：orderChanges/orderChangeRequestService.ts 的 fail-closed 依赖守卫。
      let invoiceCount: number;
      let invoiceAllocCount: number;
      let shipmentCount: number;
      let shipmentAllocCount: number;
      let voucherCount: number;
      let batchCount: number;
      try {
        [invoiceCount, invoiceAllocCount, shipmentCount, shipmentAllocCount, voucherCount, batchCount] = await Promise.all([
          tx.invoice.count({ where: { orderId, deletedAt: null } }),
          tx.invoiceOrderAllocation.count({ where: { orderId, deletedAt: null } }),
          tx.shipment.count({ where: { orderId, deletedAt: null } }),
          tx.shipmentOrderAllocation.count({ where: { orderId } }),
          tx.paymentVoucher.count({ where: { orderId, deletedAt: null } }),
          // ★ G4.4 缺口②：批次计划也是依赖。删单路径原本不清理批次（全仓无删除联动），而这些行会被
          //   `L3IssueInvoice`（按 orderId 数活批次决定开票）与 `dunningStageService`（催款分级）继续消费
          //   ⇒ 少这一路 = 「订单没了，它的批次还在参与开票和催款」。
          // ★ v2.49 复核 I-3 的连带现量（库 `panda_hub_local`，只读 SELECT）：**活单 69 张里 65 张带活批次**
          //   ⇒ 若"有批次就拦"，删除功能对 94% 的活单直接失效。按状态再分：`shipped` 49 行 / 48 单、
          //   `planned` 17 行 / 17 单。**只有已发生事实该拦**：`shipped`（含 `cancelled`，取值集合见
          //   `prisma/schema.prisma:3235` 注释）算依赖；`planned` 是订单自己的计划行，不是业务事实
          //   ⇒ 改为**同事务级联软删**（见下方 cascadeBatches），既不拦掉可删的单，也不再留孤儿。
          tx.orderShipmentBatch.count({ where: { orderId, deletedAt: null, status: { not: 'planned' } } }),
        ]);
      } catch (e) {
        logger.error('[deleteOrder] 依赖校验失败，拒绝删除（fail-closed）', {
          orderId, error: (e as Error)?.message ?? String(e),
        });
        // 抛出（不是 return）：异常穿出 $transaction 回调 ⇒ Prisma 回滚本次删除已做的全部写入。
        // 码/状态/文案见 dependencyCheckFailedError()（真源：shared/errorCodes 注册表 + 本域映射表）。
        throw dependencyCheckFailedError();
      }
      // 六路计数与六个标签写成**同一个数组**：判定和"告诉用户是谁挡的"共用一份枚举，
      // 加第七路时不必再记"还有两处清单要同步"（V2 原先自己抄了一份「发票/出运/凭证/核销分摊」，
      // 补上批次后那份清单就成了假话 —— 现已删除，见 orderServiceV2.ts 的注释）。
      const blockers = [
        { label: '发票', count: invoiceCount },
        { label: '发票分摊', count: invoiceAllocCount },
        { label: '出运单', count: shipmentCount },
        { label: '出运分摊', count: shipmentAllocCount },
        { label: '付款凭证', count: voucherCount },
        { label: '批次计划（已出运/已取消）', count: batchCount },
      ].filter((d) => d.count > 0);
      if (blockers.length > 0) {
        const detail = blockers.map((d) => `${d.label}×${d.count}`).join('、');
        throw Object.assign(
          new Error(`订单存在关联单据（${detail}），不可删除；请先处理这些单据后再重试。`),
          { code: 'HAS_DEPENDENTS', statusCode: 409 },
        );
      }

      const updated = await tx.order.update({
        where: { id: orderId },
        data: { deletedAt: now, updatedAt: now },
        include: { lines: { orderBy: { lineNumber: 'asc' } } },
      });

      // EntityLink inactive（deactivate order 发出的所有 active link）
      await deactivateEntityLinks(tx, 'order', orderId, now);

      // ★ v2.49（G4.4 缺口② 的第二半，复核 I-3 连带）：**planned 批次随单一起软删**（同事务）。
      // 为什么级联而不是拦：现量 `panda_hub_local` 有 65/69 张活单带活批次，其中 17 张只带 `planned`
      // ⇒ "有批次就 409" 等于把删除功能对 94% 的单关掉，而 `planned` 行不是已发生业务事实，
      //   它跟着单走才是它的语义。级联之后 `L3IssueInvoice` / `dunningStageService` 读的是
      //   `deletedAt: null` ⇒ 不会再把已删订单的计划批次算进开票与催款（这才是本条要修的孤儿）。
      //   `shipped`/`cancelled` 不在此列 —— 它们在上面按依赖拦掉（保守：`cancelled` 也是留痕事实）。
      const cascadedBatches = await tx.orderShipmentBatch.updateMany({
        where: { orderId, deletedAt: null, status: 'planned' },
        data: { deletedAt: now, updatedAt: now },
      });
      if (cascadedBatches.count > 0) {
        await writeRouteAuditLog({
          prisma: tx, actorId: actorId || SYSTEM_AUDIT_ACTOR, source: 'route:order:delete',
          operation: 'cascade_delete_shipment_batches', targetType: 'OrderShipmentBatch', targetId: orderId,
          operationType: 'delete', fieldPath: 'deletedAt',
          before: { deletedAt: null, status: 'planned' },
          after: { deletedAt: Number(now), cascadedCount: cascadedBatches.count },
        });
      }

      // 删单联动：解除报价单的转换引用（Quotation.convertedOrderId → null）。
      // 根因：convertToOrder 见 convertedOrderId 非空即拒「不可重复转换」，若不清理，
      // 转出的订单被删后报价永久卡死、无法重新转单（2026-09-03 上线日审计 P1）。
      const unlinkedQuotations = await tx.quotation.updateMany({
        where: { convertedOrderId: orderId },
        data: { convertedOrderId: null, updatedAt: now },
      });
      if (unlinkedQuotations.count > 0) {
        await writeRouteAuditLog({
          prisma: tx, actorId: actorId || SYSTEM_AUDIT_ACTOR, source: 'route:order:delete',
          operation: 'unlink_quotation_conversion', targetType: 'Quotation', targetId: orderId,
          operationType: 'unlink', fieldPath: 'convertedOrderId',
          beforeValue: orderId, afterValue: null,
          before: { convertedOrderId: orderId },
          after: { convertedOrderId: null, unlinkedCount: unlinkedQuotations.count },
        });
      }

      const auditId = await writeRouteAuditLog({
        prisma: tx, actorId: actorId || SYSTEM_AUDIT_ACTOR, source: 'route:order:delete',
        operation: 'delete_order', targetType: 'Order', targetId: orderId,
        before: { deletedAt: null },
        after: { deletedAt: Number(now) },
      });
      return { order: updated, auditId };
    });
    return { ok: true, data: result };
  } catch (e: any) {
    if (e.code) return { ok: false, error: { code: e.code, message: e.message } };
    return { ok: false, error: { code: 'DELETE_FAILED', message: `Delete order transaction failed: ${String(e?.message ?? e)}` } };
  }
}

// ────────────────────────────────────────────────────────────────
// Order 状态流转
// ────────────────────────────────────────────────────────────────

export interface TransitionOrderStatusParams {
  prisma: PrismaClient;
  orderId: string;
  toStatus: string;
  note?: string;
  operator?: string;
  lineId?: string;
  actorId?: string;
}

export interface TransitionOrderStatusResult {
  ok: boolean;
  error?: OrderLifecycleMutationError;
  data?: { order: any; transitionId: string; auditId: string; fromStatus: string; toStatus: string; note: string | null; operator: string; lineId: string | null; createdAt: number };
}

/** DE-5 例外放行上下文：调用方须在业务动作事务内核销，再一起提交 */
export type CreditExceptionPass = { service: ExceptionService; exception: ActiveExceptionSummary; scope: ExceptionScopeMatch };

/**
 * 阻断结果沿用 `OrderLifecycleError` 这个**既有外壳**（`{ code, message }`，与 HTTP 面 6 条路由已消费的形状同一份）。
 *
 * ★ 为什么不是"只回传结构化片段、由调用方各自拼文案"，也不是新增一个 `message` 顶层字段：
 *  ① 文案已有一处实现（本模块内），挪到调用方会做出第二份措辞（同一句话两处写 = 本仓头号病）；
 *  ② 顶层 `message: gates.message` 这种跨层转发 `.message` 的写法，`rawErrorLeakRatchet`（B22）
 *     与 `serviceMessageWrapRatchet`（B30）会当场计成新的外泄站点（`customs/lcGate.ts` 的
 *     `LcGateDecision` 注释记的是同一枚坑）—— 而这两条判据分不清"拼好的中文产品文案"与
 *     "原始异常文本"，**正解是别新增这一跳转发**，不是去改判据放过我。
 *  ⇒ 结论：字符串仍在原处拼装（棘轮计数留在原文件、口径不变），跨层只传这个 error 对象本身。
 */
export type OrderConfirmGateOutcome =
  | { allowed: true; creditExceptionPass: CreditExceptionPass | null }
  | { allowed: false; error: OrderLifecycleError };

export async function evaluateOrderConfirmGates(params: {
  prisma: any;
  orderId: string;
  actorId?: string;
  operator?: string;
  /** 日志归属：区分"路由/V2 确认"与"agent 审批提交"，同一实现两处调用时要能分出是谁 */
  logScope?: string;
}): Promise<OrderConfirmGateOutcome> {
  const { prisma, orderId } = params;
  // ★ B55/B58：这里回退的字符串会当 `requesterId` 去建豁免审批单（该列同样有 UserAccount 外键）
  //   ⇒ 回退值必须是**库里真存在的账号**，不能再沿用 'api'（无行 = 自动发起必然静默失败）。
  const actor = params.actorId || params.operator || SYSTEM_AUDIT_ACTOR;
  const logScope = params.logScope || 'order:confirm';

  const gateOrder = await (prisma as any).order.findUnique({
    where: { id: orderId },
    select: {
      id: true, status: true, deletedAt: true, type: true, businessLine: true,
      quantity: true, unit: true, fieldSources: true, capsuleExemption: true, moqSnapshot: true, customerRelationId: true, quoteAmount: true,
      // ★ 必须带上：矩阵写的 `paymentMethod` 在 Order 上**不存在**（真库 information_schema 实测），
      //   真实字段是 `paymentInstrument`。select 漏了它 ⇒ gateOrder.paymentInstrument === undefined
      //   ⇒ 门禁**永不触发**且测试全绿（静默 fail-open）。这是本门禁最容易做出假门禁的一处。
      paymentInstrument: true,
    },
  });
  if (!gateOrder || gateOrder.deletedAt) {
    return { allowed: false, error: { code: 'ORDER_NOT_FOUND', message: `Order ${orderId} not found` } };
  }
  // 已是 Confirmed ⇒ 不重复跑门禁（原 `if (gateOrder.status !== 'Confirmed')` 那条规则的下沉处）
  if (gateOrder.status === 'Confirmed') {
    return { allowed: true, creditExceptionPass: null };
  }

  // ① 信用门禁（DE-1：checkCreditAvailable 此前生产零调用方，Frozen 客户可正常建单/确认）
  let creditExceptionPass: CreditExceptionPass | null = null;
  if (gateOrder.customerRelationId) {
    try {
      const creditSvc = createCreditService({ prisma });
      const credit = await creditSvc.checkCreditAvailable({
        relationId: gateOrder.customerRelationId,
        amount: Number(gateOrder.quoteAmount ?? 0) || undefined,
      });
      if (!credit.ok) {
        logger.error('[OrderLifecycle] 信用门禁校验失败（fail-closed 阻断 Confirmed）', { orderId, logScope, error: credit.error.message });
        return { allowed: false, error: { code: 'CREDIT_CHECK_FAILED', message: `信用门禁校验失败：${credit.error.message}` } };
      }
      const creditData = credit.data as { blocked: boolean; blockCode: string | null; blockReason: string | null };
      if (creditData.blocked) {
        logger.warn('[OrderLifecycle] 信用门禁阻断订单确认', { orderId, logScope, relationId: gateOrder.customerRelationId, blockCode: creditData.blockCode });
        // DE-5：DR-013 信用例外闭环 — 生效例外放行；无例外自动发起 credit_exemption 申请
        // （审批单 id 透传 DE-6 契约）；审批中不重复发起；发起失败保持阻断并提示手工入口
        const exceptionSvc = createCreditExceptionService(prisma as any);
        const scope: ExceptionScopeMatch = { targetType: 'Order', targetId: orderId, action: 'order:confirm' };
        const exemption = await resolveCreditException({
          exceptionService: exceptionSvc,
          scope,
          actorId: actor,
          blockReason: creditData.blockReason ?? '客户信用门禁阻断',
        });
        if (exemption.passed) {
          creditExceptionPass = { service: exceptionSvc, exception: exemption.exception, scope };
        } else {
          return {
            allowed: false,
            error: {
              code: (creditData.blockCode ?? 'CREDIT_FROZEN_60_DAYS') as OrderLifecycleErrorCode,
              message: `${creditData.blockReason ?? '客户信用门禁阻断，禁止确认订单'}（${exemption.hint}）`,
              ...(exemption.approvalRequestId ? { approvalRequestId: exemption.approvalRequestId } : {}),
            },
          };
        }
      }
    } catch (e: any) {
      logger.error('[OrderLifecycle] 信用门禁校验异常（fail-closed 阻断 Confirmed）', { orderId, logScope, error: e?.message });
      return { allowed: false, error: { code: 'CREDIT_CHECK_FAILED', message: `信用门禁校验失败，请重试或联系管理员：${e?.message}` } };
    }
  }
  // ② MOQ Confirmed 门禁（DE-2/DE-4：V1 此前无 MOQ 门禁，V2 有门禁但不发事件——统一收敛到本服务）
  try {
    const moqConfigSvc = createMoqConfigService({ prisma });
    const moqValidationSvc = createMoqValidationService({
      prisma,
      configService: moqConfigSvc,
      resolutionService: createMoqResolutionService({ prisma, configService: moqConfigSvc }),
      approvalCreateService: createApprovalCreateService({
        prisma,
        routingService: createApprovalRoutingService({ prisma }),
      }),
    });
    const actualLines = await buildActualMoqLines(prisma, await prisma.orderLine.findMany({ where: { orderId }, orderBy: { lineNumber: 'asc' } }), actualMoqFamily(gateOrder));
    await lockMoqBasisRows(prisma, actualLines, gateOrder.customerRelationId);
    const moqCheck = await moqValidationSvc.validateCreate({
      type: gateOrder.type,
      businessLine: gateOrder.businessLine,
      capsuleExemption: gateOrder.capsuleExemption === true,
      customerRelationId: gateOrder.customerRelationId ?? null,
      snapshot: gateOrder.moqSnapshot ?? null,
      lines: actualLines,
    }, {
      actor: await buildLoadedAuthTokenPayload(prisma, await loadUserWithRoles(prisma, actor)),
      autoCreateApproval: true, targetType: 'Order', targetId: orderId,
    });
    if (!moqCheck.ok) {
      let approved = await findCurrentMoqApproval(prisma, 'Order', orderId, moqCheck);
      if (!approved && !moqCheck.lines.some(line => line.unresolvedReason)) {
        const quote = await prisma.quotation.findFirst({ where: { convertedOrderId: orderId, deletedAt: null }, select: { id: true } });
        if (quote) approved = await findCurrentMoqApproval(prisma, 'Quotation', quote.id, moqCheck);
      }
      if (!approved) {
        const worst = moqCheck.lines.find(line => !line.compliant);
        if (moqCheck.lines.some(line => line.unresolvedReason)) return { allowed: false, error: { code: 'MOQ_VIOLATION', message: 'MOQ 数量或阈值单位未能核对，请先补齐真实单位依据；普通豁免不能代替单位来源' } };
        const approvalHint = moqCheck.approvalRequestId
          ? `（豁免审批单 ${moqCheck.approvalRequestId} 已自动发起，审批通过后重试）`
          : '（豁免审批单发起失败，请联系管理员）';
        return {
          allowed: false,
          error: { code: 'MOQ_VIOLATION', message: `订单行 ${(worst?.lineIndex ?? 0) + 1} 数量 ${worst?.quantityExact} ${worst?.unit} 低于 MOQ ${worst?.effectiveMoq} ${worst?.thresholdUnit}（缺口 ${worst?.gapPct}%，快照口径），须先完成 MOQ 豁免审批（DR-007 单人单次）${approvalHint}`, approvalRequestId: moqCheck.approvalRequestId },
        };
      }
    }
  } catch (e: any) {
    // fail-closed：门禁校验异常 → 阻断 Confirmed 推进
    logger.error('[OrderLifecycle] Confirmed 门禁 MOQ 校验异常（fail-closed 阻断）', { orderId, logScope, error: e?.message });
    return { allowed: false, error: { code: 'MOQ_VIOLATION', message: `MOQ 校验失败，请重试或联系管理员：${e?.message}` } };
  }
  // ③ ★ G-4 L/C 门禁（矩阵 :136 第 1 道）：付款方式为信用证的订单，确认前必须已登记可用信用证。
  //    非信用证订单在门禁内部直接放行 ⇒ 真库存量（实测 69/69 为 T/T）行为零变化。
  //    豁免走既有 DR-013，但 action 用 LC 专属值：与信用门禁共用 action 会让一条已批例外顺带开两道门。
  //    异常已被 decideLcGate 内部收敛成 fail-closed 的两种码，这里不再套 try（避免把"查例外失败"
  //    误报成"信用证失败"——那是两种不同的下一步）。
  const lcDecision = await decideLcGate({ prisma, orderId, order: gateOrder, stage: 'order:confirm', exceptionAction: LC_ORDER_CONFIRM_ACTION });
  if (!lcDecision.allowed) {
    logger.warn('[OrderLifecycle] L/C 门禁阻断订单确认（fail-closed）', { orderId, logScope, code: lcDecision.code, reasons: lcDecision.reasons });
    return {
      allowed: false,
      error: {
        code: lcDecision.code,
        message: lcDecision.code === 'LC_EXCEPTION_CHECK_FAILED'
        ? `信用证门禁未通过（${lcDecision.reasons.join(', ')}${lcDecision.lcLabel ? `；信用证 ${lcDecision.lcLabel}` : ''}），`
          + '且无法确认是否已有 DR-013 例外 ⇒ 保持阻断。请先排查例外/审批服务，再重试'
          : `该订单以信用证结算但未登记可用信用证（${lcDecision.reasons.join(', ') || 'LC_NOT_REGISTERED'}）；`
            + `请先在「信用证」登记并核对有效期，确需例外按 DR-013 申请（action='${LC_ORDER_CONFIRM_ACTION}'）`,
      },
    };
  }
  if (lcDecision.via === 'exception') {
    logger.warn('[OrderLifecycle] L/C 门禁经 DR-013 例外放行（留痕在例外申请侧）', { orderId, logScope, exceptionNumber: lcDecision.exceptionNumber });
  }
  // ★ A19（拍板件 §2.2 硬条件 1）：付款方式**未录**是独立一档 —— 不阻断，但**不许静默**。
  //   放行分支带回的结构化提示在这里落成一条 warn（服务端可见）；
  //   屏面侧由订单/报价界面按「该列为空」自行标出（见 components/OrderManager.tsx、QuotationManager.tsx）。
  //   ⚠️ 刻意**不**在这里拼中文再往上层转发（`OrderConfirmGateOutcome` 的注释记着：
  //      跨层转发 `.message` 会被 rawErrorLeakRatchet / serviceMessageWrapRatchet 计成新外泄站点）。
  if (lcDecision.notices && lcDecision.notices.length > 0) {
    logger.warn('[OrderLifecycle] 付款方式未录（L/C 门禁按"不知道"放行，不阻断但需补录）', {
      orderId, logScope, notices: lcDecision.notices, paymentInstrument: null,
    });
  }
  return { allowed: true, creditExceptionPass };
}

/**
 * ★ A10-②（拍板件 §2.3 硬条件 1 / 7；Kevin 2026-09-25 21:0x 拍板）——
 *   进入 `Production` 的唯一一项门禁：**客户冻结**。
 *
 * ## 为什么"只有这一项"（不是"投产门禁"）
 * 全仓**只有** `evaluateOrderConfirmGates` 这一个订单门禁函数，且它是**确认专属**
 * （`:406-409`「已是 Confirmed ⇒ 不重复跑」、`:421`「fail-closed 阻断 Confirmed」）
 * ⇒ 套到投产会引入确认语义（信用额度 / MOQ / L/C）。拍板件明令**不许**套用，
 * 也**不许**为"对称好看"多加项。信用证**不重复查**（发运侧已有独立 L/C 门禁，
 * 重复查就是两套口径）。
 *
 * ## 为什么要它（硬条件 7 的"不对称已解"）
 * 门禁原本只挂在「进入 Confirmed」⇒ `Confirmed → Production → Shipping → Delivered`
 * 全程不跑。若只有**恢复**路径跑门禁，就成了「**回退比前进更严**」的怪规则。
 * Kevin 的解法是**让前进也严一点**：投产前查一次客户冻结 ⇒ 前后都有守卫。
 * ★ 发运/完工两档**仍然不跑门禁** —— 这是**已知且接受的现状**，别顺手补（要补另立单）。
 *
 * ## 判据的唯一真源
 * 「客户冻结」= `CreditLimit.status ∈ {Frozen, Revoked}`，即
 * `creditService.getCreditStatus().creditFrozen`。本函数**调用它**，不另写一份
 * status 集合（同一个概念好几处各写各的 = 本仓头号病）。
 */
export type ProductionEntryGateOutcome =
  | { allowed: true }
  | { allowed: false; error: OrderLifecycleError };

export async function evaluateProductionEntryGate(params: {
  prisma: any;
  orderId: string;
  /** 日志归属：区分"路由流转"与"变更单恢复写回"，同一实现两处调用时要能分出是谁 */
  logScope?: string;
}): Promise<ProductionEntryGateOutcome> {
  const { prisma, orderId } = params;
  const logScope = params.logScope || 'order:production-entry';

  const order = await (prisma as any).order.findUnique({
    where: { id: orderId },
    select: { id: true, deletedAt: true, customerRelationId: true },
  });
  if (!order || order.deletedAt) {
    return { allowed: false, error: { code: 'ORDER_NOT_FOUND', message: `Order ${orderId} not found` } };
  }
  // 无客户关联 ⇒ 没有信用额度行 ⇒ **不存在"冻结"这件事**。
  // ★ 与 `evaluateOrderConfirmGates` 的 `if (gateOrder.customerRelationId)` 同口径；
  //   刻意**不**在这里新增"未关联客户"这一档（那属另一族：硬条件明令只加「客户冻结」）。
  if (!order.customerRelationId) return { allowed: true };

  try {
    const creditSvc = createCreditService({ prisma });
    const st = await creditSvc.getCreditStatus(order.customerRelationId);
    // 读不出状态（relationId 空白等）⇒ 与"没有额度行"同解，不阻断
    if (!st) return { allowed: true };
    if (st.creditFrozen) {
      const revoked = st.status === 'Revoked';
      logger.warn('[OrderLifecycle] 客户冻结门禁阻断投产', {
        orderId, logScope, relationId: order.customerRelationId, creditStatus: st.status,
      });
      return {
        allowed: false,
        error: {
          code: (revoked ? 'CREDIT_REVOKED' : 'CREDIT_FROZEN_60_DAYS') as OrderLifecycleErrorCode,
          message: revoked
            ? '该客户信用额度已吊销（坏账），禁止投产；请财务处理后再试。'
            : '该客户信用额度已冻结，禁止投产；请财务解冻后再试。',
        },
      };
    }
  } catch (e: any) {
    // fail-closed：查不出来 ≠ 没冻结（与信用门禁同档）
    logger.error('[OrderLifecycle] 客户冻结门禁校验异常（fail-closed 阻断 Production）', { orderId, logScope, error: e?.message });
    // ★ 文案里**刻意不内插** `e.message`（内部异常原文不上屏）。
    //   本仓 B30 棘轮（服务层把原文拼进业务文案）**只许减不许增** ⇒ 新写的这一处必须干净；
    //   上面那行 logger 已把原文留在服务端，上屏只给「码 + 可行动的话」。
    return { allowed: false, error: { code: 'CREDIT_CHECK_FAILED', message: '客户冻结门禁校验失败，请重试或联系管理员。' } };
  }
  return { allowed: true };
}

/**
 * ★ A10-①（拍板件 §2.3）——「**恢复/回退写回订单状态**」前的门禁派发。
 *
 * ## 为什么必须有这一个函数
 * 全仓有**三处**会把订单状态**写回**到「申请前 / 出运前」的状态，而它们**都不走**
 * `transitionOrderStatus`（该函数把 `CancelRequested/PauseRequested/Closing/Paused`
 * 当守卫态直接拒掉，见 `DR010_GUARDED_STATUSES`）⇒ 三处各自直写 `tx.order.update`：
 *   ① 审批**驳回**取消/暂停申请 → 恢复（`orderChangeRequestService.decideApproval`）
 *   ② 申请人**撤回**取消/暂停申请 → 恢复（`orderChangeRequestService.withdrawChangeRequest`）
 *   ③ **运单取消** → 订单回退（`orderLinkService.rollbackOrderOnShipmentCancelled`）
 * 结果是：一条 **HTTP 可达、无需审批**的免检入口 —— 可以把订单直接写回 `Confirmed`
 * 而**不跑任何门禁**。本函数是这三处**唯一**的档位决定者（别在调用方各写一份 if）。
 *
 * ## 档位（★ 逐字照抄 `审阅方更正件-S级复量-2026-09-25.md` §三 的表）
 *
 * | 档位 | 门禁 |
 * |---|---|
 * | 恢复回 `Confirmed` | 跑 `evaluateOrderConfirmGates`（**存在，直接用**） |
 * | 恢复回 `Production` | **没有现成门禁** ⇒ 补救在**前进侧**补（见下行） |
 * | **前进** `Confirmed → Production` | 新增一项「客户冻结」检查（`transitionOrderStatus` 里） |
 * | `Production → Shipping → Completed` | 仍不跑门禁（**已知且接受**，别顺手补） |
 *
 * ★ **恢复回 `Production` 刻意不跑门禁**（不是"忘了"）：
 *   更正件原文「恢复回 `Production` ⇒ **没有现成门禁** ⇒ 按下一行在**前进侧**补」，
 *   且硬条件 7 明写解不对称的办法是「**让前进也严一点**，不是把回退放松」。
 *   ⇒ 把 `evaluateProductionEntryGate` 也挂到这一档，是**未被授权的多加项**
 *     （硬条件 1 末句：「**也不许**为了"对称好看"多加项」）。
 *   我第一版就是那么写的，导致三条既有用例红（订单卡在 `CancelRequested`）—— 已改回。
 *   ⇒ 若将来要把它挂上来，是**一行的事**，但要先拿到授权，并同批补三条既有用例的 mock。
 *
 * ## 口径依据（与 B50 同源）
 * Kevin 已拍「**审批不算替代门禁**」—— 审批人批准的是「允许尝试这次确认」，
 * 不是「这个客户信用没问题」（他没看过信用数据）。
 */
export type OrderRestoreGateOutcome =
  | { allowed: true; creditExceptionPass?: CreditExceptionPass }
  | { allowed: false; code: OrderLifecycleErrorCode; message: string };

export async function evaluateOrderRestoreGate(params: {
  prisma: any;
  orderId: string;
  /** 写回的目标状态（时间线回查出来的那个，或运单回退推出的那个） */
  targetStatus: string;
  logScope?: string;
  actorId?: string;
}): Promise<OrderRestoreGateOutcome> {
  const { prisma, orderId, targetStatus } = params;

  if (targetStatus === 'Confirmed') {
    const gates = await evaluateOrderConfirmGates({
      prisma, orderId, actorId: params.actorId, logScope: params.logScope || 'order:restore',
    });
    if (gates.allowed) return gates.creditExceptionPass ? { allowed: true, creditExceptionPass: gates.creditExceptionPass } : { allowed: true };
    return { allowed: false, code: gates.error.code, message: gates.error.message };
  }

  // 其它目标状态（含 `Production` / `Pending` / `Shipping` / …）：
  // 本仓**没有**对应档位的门禁 ⇒ 放行。
  // ★ 此处**明写"没有档位"**而不是"默认放行" —— 将来加档位时不会漏看这一处；
  //   也明写「`Production` 也在这一支里」，否则下一个人会以为漏了。
  return { allowed: true };
}

export async function transitionOrderStatus(params: TransitionOrderStatusParams): Promise<TransitionOrderStatusResult> {
  const { prisma, orderId, toStatus, note, operator, lineId, actorId } = params;
  const now = BigInt(Date.now());

  // 枚举校验（6 状态，不新增 Cancelled）
  if (!VALID_STATUS_SET.has(toStatus)) {
    return { ok: false, error: { code: 'INVALID_STATUS', message: `Invalid target status: ${toStatus}. Allowed: ${VALID_ORDER_STATUSES.join(', ')}` } };
  }

  // Production and Shipping are fulfillment projections of many independent
  // order-line workflows. The legacy main-order transition route (including
  // Agent/V2 callers) cannot establish the per-line sample/QC/customer gates,
  // so it must never advance either state. A future line-workflow projector
  // must use its own private capability rather than reopening this endpoint.
  if (toStatus === 'Production' || toStatus === 'Shipping') {
    return { ok: false, error: {
      code: 'ORDER_LINE_WORKFLOW_REQUIRED',
      message: '大货投产与出运进度按订单条目逐条推进，不能通过旧主单状态接口变更。',
    } };
  }

  if (toStatus === 'Confirmed') {
    const current = await (prisma as any).order.findUnique({ where: { id: orderId }, select: { status: true, deletedAt: true } });
    if (current?.status === 'Pending' && !current.deletedAt) {
      const approvedMainRequest = await (prisma as any).approvalRequest.findFirst({ where: {
        actionType: 'order:main_approval', targetType: 'Order', targetId: orderId, status: 'approved',
      }, select: { id: true } });
      if (!approvedMainRequest) return { ok: false, error: { code: 'ORDER_MAIN_APPROVAL_REQUIRED', message: '订单必须先通过业务域主单审批，不能直接确认。' } };
    }
  }

  // ── 确认门禁（fail-closed，W-A 走查 DE-1/DE-2/DE-6 修复）──
  // 实现见 `evaluateOrderConfirmGates`（本文件）：进入 Confirmed 的所有路径共用那一份判定，
  // 包括 agent 审批提交（`agent/commitTransaction.ts` 在自己的事务里无法嵌套调用本函数 ⇒ 只共用判定）。
  // Consume only the exception actually used by this confirmation gate, inside
  // the same order transaction; never publish a successful action first.
  let creditExceptionPass: CreditExceptionPass | null = null;
  if (toStatus === 'Confirmed') {
    const gates = await evaluateOrderConfirmGates({ prisma, orderId, actorId, operator });
    if (!gates.allowed) return { ok: false, error: gates.error };
    creditExceptionPass = gates.creditExceptionPass;
  } else if (toStatus === 'Production') {
    // ★ A10-②（拍板件 §2.3 硬条件 1/7，Kevin 21:0x 拍板）：投产前查一次「客户冻结」。
    //   ★ 刻意写成 `else if` 而不是与 Confirmed 合并：两档是**不同档位**
    //     （确认 = 信用额度 + MOQ + L/C；投产 = **只看客户冻结**）——
    //     拍板件明令不许套用确认门禁、不许多加项。
    //   ★ 也刻意**不**给 Shipping/Delivered 加（已知且接受的现状，要补另立单）。
    const entry = await evaluateProductionEntryGate({ prisma, orderId, logScope: 'order:transition' });
    if (!entry.allowed) return { ok: false, error: entry.error };
  }

  try {
    const result = await prisma.$transaction(async (tx: any) => {
      const existing = await tx.order.findUnique({ where: { id: orderId } });
      if (!existing || existing.deletedAt) {
        throw Object.assign(new Error(`Order ${orderId} not found`), { code: 'ORDER_NOT_FOUND', statusCode: 404 });
      }
      if (existing.status === 'Pending' && toStatus === 'Confirmed') {
        const approvedMainRequest = await tx.approvalRequest.findFirst({ where: {
          actionType: 'order:main_approval', targetType: 'Order', targetId: orderId, status: 'approved',
        }, select: { id: true } });
        if (!approvedMainRequest) throw Object.assign(new Error('订单必须先通过业务域主单审批，不能直接确认。'), { code: 'ORDER_MAIN_APPROVAL_REQUIRED', statusCode: 409 });
      }
      if (existing.status === toStatus) {
        throw Object.assign(new Error(`Order ${orderId} already in status ${toStatus}`), { code: 'NO_CHANGE', statusCode: 400 });
      }

      const fromStatus = existing.status;
      // DR-010 守卫：取消/暂停申请中、结案处理中、暂停中、已关闭订单禁止常规 6 态推进
      if (DR010_GUARDED_STATUSES.has(fromStatus)) {
        throw Object.assign(new Error(`订单处于「${fromStatus}」（DR-010 守卫态），需先完成或撤回对应的变更/取消/暂停申请，禁止状态推进`), { code: 'ORDER_LIFECYCLE_GUARDED', statusCode: 409 });
      }
      if (fromStatus === 'Cancelled') {
        throw Object.assign(new Error(`订单 ${orderId} 已关闭（Cancelled 终态），禁止状态推进`), { code: 'ORDER_ALREADY_CLOSED', statusCode: 409 });
      }
      // 状态转换合法性校验
      const allowedTargets = ORDER_TRANSITIONS[fromStatus];
      if (!allowedTargets || !allowedTargets.has(toStatus)) {
        throw Object.assign(new Error(`Invalid status transition: ${fromStatus} -> ${toStatus}`), { code: 'INVALID_TRANSITION', statusCode: 400 });
      }
      const updated = await tx.order.update({
        where: { id: orderId },
        data: { status: toStatus, updatedAt: now },
        include: { lines: { orderBy: { lineNumber: 'asc' } } },
      });

      // OrderStatusTransition.create（审计时间线）
      const transitionId = `OST_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await tx.orderStatusTransition.create({
        data: {
          id: transitionId,
          orderId,
          fromStatus,
          toStatus,
          note: note || null,
          // 操作人留痕以 actorId（认证身份）为唯一真源：客户端传入的 operator 仅为
          // 无认证上下文（API Key/dev 直通）时的兜底，前端不再传字面量 operator（防伪造）。
          operator: actorId || operator || 'api',
          lineId: lineId || null,
          createdAt: now,
        },
      });

      // sync Order EntityLinks（更新 orderedBy/suppliedBy 等 active link）
      await syncOrderEntityReferences(prisma, updated, { source: 'route:order:status-transition' }, tx);

      const auditId = await writeRouteAuditLog({
        prisma: tx, actorId: actorId || SYSTEM_AUDIT_ACTOR, source: 'route:order:status-transition',
        operation: 'transition_order_status', targetType: 'Order', targetId: orderId,
        before: { status: fromStatus },
        after: { status: toStatus, transitionId },
      });

      if (creditExceptionPass) {
        await consumeCreditException({
          exceptionService: creditExceptionPass.service, exceptionId: creditExceptionPass.exception.id,
          scope: creditExceptionPass.scope, actorId: actorId || operator || 'api', tx,
          note: `订单 ${orderId} 确认（Confirmed）经信用例外 ${creditExceptionPass.exception.exceptionNumber} 放行`,
        });
      }

      const events: BusinessEvent[] = [{
        id: `bev_OrderStatusChanged_${transitionId}`,
        type: 'OrderStatusChanged', sourceEntityType: 'Order', sourceEntityId: orderId, orderId,
        payload: { poNumber: updated.poNumber, fromStatus, toStatus, transitionId },
        actorId: actorId || operator || 'api', transactionId: transitionId, occurredAt: Number(now),
      }];
      if (toStatus === 'Confirmed' && fromStatus !== 'Confirmed') {
        events.push({
          id: `bev_OrderConfirmed_${transitionId}`,
          type: 'OrderConfirmed', sourceEntityType: 'Order', sourceEntityId: orderId, orderId,
          payload: { poNumber: updated.poNumber, fromStatus, customer: updated.customer, transitionId },
          actorId: actorId || operator || 'api', transactionId: transitionId, occurredAt: Number(now),
        });
      }
      for (const event of events) await persistBusinessEventInTransaction(tx, event);

      return { order: updated, transitionId, auditId, events, fromStatus, toStatus, note: note || null, operator: actorId || operator || 'api', lineId: lineId || null, createdAt: Number(now) };
    });

    // Committed records already exist. Reusing IDs makes dispatch persistence idempotent.
    for (const event of result.events) {
      publishBusinessEvent({ ...event, eventId: event.id }).catch(() => { /* queued event remains recoverable */ });
    }

    return { ok: true, data: result };
  } catch (e: any) {
    if (e.code) return { ok: false, error: { code: e.code, message: e.message } };
    return { ok: false, error: { code: 'TRANSITION_FAILED', message: `Status transition transaction failed: ${String(e?.message ?? e)}` } };
  }
}
