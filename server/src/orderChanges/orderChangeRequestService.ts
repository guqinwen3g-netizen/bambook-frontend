import { businessNowDate } from '../shared/businessClock';
import { isValidSnapshot } from '../moq/moqResolutionService';
import { freezeQuantityMoqSnapshot, requireProposedPlanMoq, withQuantityApprovalFingerprint, assertOriginalQuantityDecision } from './quantityPlanMoqGate';
import {canonicalClaimJson} from '../claims/claimApprovalFact';
import {businessError} from '../shared/errorCodes';
import type {TokenPayload} from '../auth/service';
import {lockAndValidateQuantityPlan,applyExactQuantityPlan,canonicalQuantityPlan,quantityPlanApprovalHash,quantityPlanCommercialFacts} from './orderLineQuantityPlan';
/**
 * orderChangeRequestService.ts — DR-010 已批准订单变更/取消/暂停控制服务（Track B 唯一入口）
 *
 * 设计真源：
 *   - docs/design/03-业务规则/订单变更规则.md §2A（取消/暂停流程）/§6 触发矩阵 #10/#11/#12
 *   - docs/design/04-模块设计/03-订单与生产/Orders-订单管理/订单状态机.md §14.3（OSM-010-C1~C5）
 *   - docs/design/10-评审与决策/2026-08-16-设计评审决策记录.md DR-010
 *   - docs/design/03-业务规则/交期与生产规则.md L1 交期锁死（ORDER_SHIPPING_LOCKED）
 *
 * 铁律（fail-closed）：
 *   1. 仅已批准订单（status ∈ APPROVED_ORDER_STATUSES）可发起变更申请；
 *      草稿/待审批订单由业务员直接撤回/取消/暂停，不走本链（ORDER_NOT_APPROVED）
 *   2. 任何比例/任何件数改动均需审批，无阈值分级（DR-007 去阈值化）；
 *      before/after 值、变更原因（≥15字）、影响说明（≥10字）必填
 *   3. 审批单必须经 approvalCreateService.createBusinessApproval 创建（reviewerId 服务端 DR-007 解析，绝不手写）
 *   4. apply 仅允许 status=Approved；重复 apply 幂等返回 ALREADY_APPLIED，不产生二次写入
 *   5. 交期变更：Shipping/Delivered 状态直接拒绝 ORDER_SHIPPING_LOCKED（硬防篡改，
 *      无 EXC 直跳；需先走订单状态回退 Confirmed 审批链，见订单变更规则.md §13 OCG-EXC-3）
 *   6. 取消：批准后无不可逆承诺直接结案关闭；有承诺进 Closing（结案处理中），
 *      处置完成（completeClosing）才关闭——EXC 也不得跳过结案处理闭环
 *   7. 暂停：原因/责任人/预计恢复日期 3 字段必填；到期未恢复置 resumeReminderFlagged=true
 *      （checkPauseResumeDue 为 scheduler 接入点，由调度层定期调用）
 */

import type { PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import { recalcOrderAmountFromLines } from './orderAmountRecalc';
// ★ S4 任务3：客户变更额度联动取订单金额 ⇒ 走唯一真源
import { orderAmountOf } from '../shared/orderAmount';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { publishBusinessEvent } from '../events/businessEventBus';
import { syncOrderEntityReferences } from '../entities/sync';
import {
  DR010_GUARDED_STATUSES,
  ORDER_LIFECYCLE_EXTENSION_ERRORS,
  evaluateOrderRestoreGate,
} from '../orders/orderLifecycleService';
import type { ApprovalCreateService } from '../approvals/approvalCreateService';
import { approvalReviewContentVersion, createApprovalDecisionService, evaluateDecideOwnership } from '../approvals/approvalDecisionService';
import { createCreditService } from '../credit/creditService';
import { consumeCreditException, CreditExceptionConsumptionError, type CreditExceptionConsumptionErrorCode } from '../credit/creditExceptionGate';

import { isLeaderPrincipal } from '../_shared/rolePermissionMatrix';
import { isOrderShipped, isShipmentShipped } from '../shared/shippingLock';
import { statusFromError } from '../shared/bizStatus';
import { createSequenceService } from '../sequence/sequenceService';
import { assertFinalCustomerConfirmationInTx, currentCustomerConfirmationActor } from '../customerConfirmations/customerConfirmationService';
import { hasScope } from '../auth/permissionService';
import { freshOrderLineScope } from '../orders/orderLineWriteAccess';
import { assertOrderChangeApprovalDecisionFact, assertOrderChangeDecisionFact, buildOrderChangeFinalVersion, captureOrderChangeReviewBasis, normalizeOrderChangeDecimal, orderChangeAmendmentProposalFingerprint, OrderChangeFinalVersionError } from './orderChangeFinalVersion';
import { todayLocalKey } from '../shared/localDate';
import { loadOrderQueryReadAccess } from '../orders/orderQueryReadAccess';
import { finishOrderChangeRead, readCompleteOrderChangeSource } from './orderChangeReadAccess';

// ───────────────────────────────────────────────────────────────────
// 错误码（全部 fail-closed）
// ───────────────────────────────────────────────────────────────────
export const ORDER_CHANGE_ERRORS = {
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  ORDER_NOT_APPROVED: 'ORDER_NOT_APPROVED',
  ORDER_LIFECYCLE_GUARDED: ORDER_LIFECYCLE_EXTENSION_ERRORS.ORDER_LIFECYCLE_GUARDED,
  MISSING_BEFORE_AFTER: 'MISSING_BEFORE_AFTER',
  INVALID_CHANGE_TYPE: 'INVALID_CHANGE_TYPE',
  REASON_TOO_SHORT: 'REASON_TOO_SHORT',
  IMPACT_TOO_SHORT: 'IMPACT_TOO_SHORT',
  PAUSE_FIELDS_REQUIRED: 'PAUSE_FIELDS_REQUIRED',
  PAUSE_RESUME_DATE_INVALID: 'PAUSE_RESUME_DATE_INVALID',
  CHANGE_REQUEST_NOT_FOUND: 'CHANGE_REQUEST_NOT_FOUND',
  CHANGE_REQUEST_NOT_PENDING: 'CHANGE_REQUEST_NOT_PENDING',
  CHANGE_REQUEST_NOT_APPROVED: 'CHANGE_REQUEST_NOT_APPROVED',
  ALREADY_APPLIED: 'ALREADY_APPLIED',
  ORDER_SHIPPING_LOCKED: 'ORDER_SHIPPING_LOCKED',
  /** ★ B3：改量后数量 < 已出运量（已发的货比订单还多，库存/开票/结算全对不上） */
  ORDER_QTY_BELOW_SHIPPED: 'ORDER_QTY_BELOW_SHIPPED',
  WITHDRAW_NOT_BY_REQUESTER: 'WITHDRAW_NOT_BY_REQUESTER',
  ORDER_STATUS_CONFLICT: 'ORDER_STATUS_CONFLICT',
  CUSTOMER_CONFIRMATION_REQUIRED: 'CUSTOMER_CONFIRMATION_REQUIRED',
  ORDER_CHANGE_VERSION_MISMATCH: 'ORDER_CHANGE_VERSION_MISMATCH',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  AUTHORIZATION_UNAVAILABLE: 'AUTHORIZATION_UNAVAILABLE',
  REVISION_NOT_ALLOWED: 'REVISION_NOT_ALLOWED',
  AMENDMENT_NOT_ALLOWED: 'AMENDMENT_NOT_ALLOWED',
  CLOSING_NOT_REQUIRED: 'CLOSING_NOT_REQUIRED',
} as const;

export type OrderChangeErrorCode = (typeof ORDER_CHANGE_ERRORS)[keyof typeof ORDER_CHANGE_ERRORS];

export type OrderChangeResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: OrderChangeErrorCode | CreditExceptionConsumptionErrorCode; message: string; statusCode: number; approvalRequestId?: string } };

/**
 * ★ A10-①（拍板件 §2.3 硬条件 3）——「恢复被门禁拦下」的结构化说明。
 *
 * 语义（**撤回 / 驳回共用一份形状**，别各写一份）：
 *  · 变更单**照常**撤回/驳回（那是申请人与审批人的权利）；
 *  · **只有订单状态不写回** —— 订单当前不具备恢复条件（客户冻结 / 信用证过期 / MOQ / …）；
 *  · `message` 必须说清"不是不让你撤回，是订单不具备条件" + 给下一步。
 *
 * ★ 为什么不是"直接失败"：若撤回本身也失败，申请人会被一个**他无法解决的**
 *   条件卡住（他改不了客户冻结），而撤回是他的权利 ⇒ 两件事必须分开。
 */
export type OrderRestoreBlocked = { code: string; message: string };

// ───────────────────────────────────────────────────────────────────
// 变更类型（任务契约 7 类）↔ schema changeTypes 枚举映射
//   price → unitPrice | quantity → quantity | delivery → deliveryDate
//   customer → customer | product → product_spec | cancel → other | pause → other
// ───────────────────────────────────────────────────────────────────
export const ORDER_CHANGE_TYPES = ['price', 'quantity', 'delivery', 'customer', 'product', 'cancel', 'pause'] as const;
export type OrderChangeType = (typeof ORDER_CHANGE_TYPES)[number];

const CHANGE_TYPE_TO_SCHEMA: Record<OrderChangeType, string> = {
  price: 'unitPrice',
  quantity: 'quantity',
  delivery: 'deliveryDate',
  customer: 'customer',
  product: 'product_spec',
  cancel: 'other',
  pause: 'other',
};

/** 已批准（正式承诺）状态集合：仅这些状态允许发起变更申请 */
export const APPROVED_ORDER_STATUSES = ['Confirmed', 'Production', 'Shipping', 'Delivered'] as const;

/**
 * L1 锁死状态集合（订单侧）—— 收口到 shared/shippingLock 真源，不再内联。
 *
 * ★★ B3（2026-09-18）：锁死的**不再只是交期**。
 *   原实现只有 `changeType === 'delivery'` 才查这个集合 ⇒ 货都发走了，
 *   还能提交/生效「改价」「改量」申请：
 *     · 改价 → 已出运批次已按旧价结算、发票已开 ⇒ 改一个数字，账静默地变了
 *     · 改量 → 与 A1 同型：库存已扣、已开票额不动，数量却变了
 *   两者都**联动不到已出运量/已开票额**，属 A 类静默错账，只是入口在改单链。
 *
 * ⓘ 为什么不含 customer / product：这两项是**主体描述**，实务上出运后仍有合法更正
 *   （客户名称笔误、规格描述补全），且本身是 high-risk 审批 + 全量审计留痕；
 *   改价/改量/交期则直接改金额与数量，错了就是错账 ⇒ 三档硬锁，另两档留给审批。
 */
const SHIPPING_LOCKED_CHANGE_TYPES = new Set<OrderChangeType>(['delivery', 'price', 'quantity']);

const CHANGE_REASON_MIN = 15; // 变更理由 ≥15 字（schema 注释 fail-closed 约定）
const IMPACT_SUMMARY_MIN = 10; // 影响说明 ≥10 字（DR-010「记录前后值、原因与影响」服务端强制下限）

// afterDelta.field → Order 列映射（apply 时一次性写入）
const ORDER_FIELD_MAP: Record<string, string> = {
  quantity: 'quantity',
  unitPrice: 'quoteAmount',
  deliveryDate: 'dueDate',
  dueDate: 'dueDate',
  clientDate: 'clientDate',
  customer: 'customer',
  customerRelationId: 'customerRelationId',
  customerCode: 'customerCode',
  product: 'product',
  type: 'type',
  businessLine: 'businessLine',
};

const genId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const epochNow = () => BigInt(Date.now());

function fail<T>(code: OrderChangeErrorCode | CreditExceptionConsumptionErrorCode, message: string, statusCode: number): OrderChangeResult<T> {
  return { ok: false, error: { code, message, statusCode } };
}

// ───────────────────────────────────────────────────────────────────
// 服务工厂
// ───────────────────────────────────────────────────────────────────
export interface OrderChangeRequestServiceOptions {
  prisma: PrismaClient;
  approvalCreateService: ApprovalCreateService;
}

export interface CreateChangeRequestInput {
  orderId: string;
  changeType: OrderChangeType;
  /** 变更前快照（writeOnce），如 { quantity: 200 } */
  beforeSnapshot: Record<string, unknown>;
  /** 变更后增量，如 { quantity: 180 } */
  afterDelta: Record<string, unknown>;
  /** 变更理由（≥15字必填） */
  changeReason: string;
  /** 影响说明（≥10字必填，写入 notes） */
  impactSummary: string;
  requesterId: string;
  trustedActor?:TokenPayload;
  /** 暂停必填：原因（缺省回落 changeReason）/责任人/预计恢复日期 YYYY-MM-DD */
  pauseReason?: string;
  pauseOwnerId?: string;
  expectedResumeDate?: string;
  attachments?: unknown;
}

export function createOrderChangeRequestService(opts: OrderChangeRequestServiceOptions) {
  const { prisma, approvalCreateService } = opts;
  let decisionService!: ReturnType<typeof createApprovalDecisionService>;

  // ── 内部：写入 OrderStatusTransition（不经过 6 态矩阵的扩展迁移，见 orderLifecycleService 注释） ──
  async function writeExtensionTransition(
    tx: any,
    orderId: string,
    fromStatus: string,
    toStatus: string,
    operator: string,
    note: string | null,
  ) {
    await tx.orderStatusTransition.create({
      data: {
        id: genId('OST'),
        orderId,
        fromStatus,
        toStatus,
        note,
        operator,
        lineId: null,
        createdAt: epochNow(),
      },
    });
  }

  // ── 内部：客户变更信用额度联动 ──
  // 已接线 Track F 统一信用服务（creditService.reserveCredit / releaseCredit）：
  // usedAmount 写操作 + CreditLimitHistory append-only 由信用域收口，
  // 保持既有语义：客户变更 → 旧客户释放（-amount）+ 新客户占用（+amount），
  // triggerType='order_change_customer'，triggerId=变更申请 ID，triggerBy='system_change_apply'。
  const creditService = createCreditService({ prisma });
  async function applyCustomerCreditLinkage(
    tx: any,
    changeRequestId: string,
    order: any,
    newCustomerRelationId: string,
  ) {
    const amountRaw = orderAmountOf(order);
    const amount = Number(amountRaw);
    if (!Number.isFinite(amount) || amount <= 0) {
      logger.warn('[OrderChange] 客户变更额度联动跳过：订单金额不可用', { orderId: order.id, amountRaw });
      return { released: false, occupied: false, amount: 0 };
    }
    const oldRelationId: string | null = order.customerRelationId ?? null;
    const remark = `DR-010 客户变更额度联动（订单 ${order.id}）`;
    const shiftBase = {
      amount,
      triggerType: 'order_change_customer',
      triggerId: changeRequestId,
      triggerBy: 'system_change_apply',
      remark,
      tx,
    };

    // 语义与原 shift() 一致：无 Active 额度 → false（跳过不报错）
    let released = false;
    if (oldRelationId && oldRelationId !== newCustomerRelationId) {
      const res = await creditService.releaseCredit({ ...shiftBase, relationId: oldRelationId });
      released = res.ok && res.data.adjusted;
      if (!res.ok) {
        logger.warn('[OrderChange] 旧客户额度释放失败', { changeRequestId, oldRelationId, error: res.error });
      }
    }
    const occ = await creditService.reserveCredit({ ...shiftBase, relationId: newCustomerRelationId });
    const occupied = occ.ok && occ.data.adjusted;
    if (!occ.ok) {
      logger.warn('[OrderChange] 新客户额度占用失败', { changeRequestId, newCustomerRelationId, error: occ.error });
    }
    logger.info('[OrderChange] 客户变更额度联动完成', {
      changeRequestId, orderId: order.id, oldRelationId, newCustomerRelationId, released, occupied, amount,
    });
    return { released, occupied, amount };
  }

  // ── 内部：取消影响汇总（合同/面料采购/样品/生产/付款/库存 6 方面，§2A.2 步骤 1） ──
  // 设计真源：订单变更规则.md §6 触发矩阵 #10。影响汇总失败 → impactSummaryFailed: true（fail-closed 标记，需人工介入）。
  async function summarizeCancelImpact(orderId: string, order: any) {
    const emptyLines: any[] = [];
    const safeCount = async (fn: () => Promise<number>) => {
      try { return await fn(); } catch (e: any) {
        logger.warn('[OrderChange] 取消影响汇总子项失败', { orderId, error: e?.message });
        return -1;
      }
    };

    const contract = {
      customerPoNumber: order.poNumber ?? null,
      salesContractNumber: order.salesContractNumber ?? null,
      finalContractNumber: order.finalContractNumber ?? null,
      hasSignedContract: Boolean(order.salesContractNumber || order.finalContractNumber || order.poNumber),
    };
    const procurement = {
      purchaseOrderCount: await safeCount(() => prisma.purchaseOrder.count({ where: { orderId, deletedAt: null } })),
      committedCount: await safeCount(() => prisma.purchaseOrder.count({
        where: { orderId, deletedAt: null, status: { in: ['Sent', 'Confirmed', 'PartiallyReceived', 'Received'] } },
      })),
    };
    // 样品维度：DevelopmentCase.linkedOrderId → SampleBatch（消双轨 L-2：封样/开发样统一由
    // SampleBatch 承载，SampleNode 退役；样品侧承诺以开发案样品批次反映）
    const developmentCaseIds: string[] = await prisma.developmentCase
      .findMany({ where: { linkedOrderId: orderId, deletedAt: null }, select: { id: true } })
      .then((rows: any[]) => rows.map((r) => r.id))
      .catch(() => []);
    const samples = {
      developmentCaseCount: developmentCaseIds.length,
      sampleNodeCount: developmentCaseIds.length > 0
        ? await safeCount(() => prisma.sampleBatch.count({ where: { developmentCaseId: { in: developmentCaseIds }, deletedAt: null } }))
        : 0,
    };
    const production = {
      startedStageCount: await safeCount(() => prisma.productionStage.count({
        where: { orderId, status: { in: ['done', 'in_progress'] }, stageSeq: { gt: 1 } },
      })),
    };
    const finance = {
      invoiceCount: await safeCount(() => prisma.invoice.count({ where: { orderId, deletedAt: null } })),
      paymentVoucherCount: await safeCount(() => prisma.paymentVoucher.count({ where: { orderId, deletedAt: null } })),
    };
    const inventory = { note: '无订单级库存锁模型；库存占用经采购/到货链路反映（见 procurement.committedCount）' };

    const impactSummaryFailed = [procurement.purchaseOrderCount, procurement.committedCount,
      samples.sampleNodeCount, production.startedStageCount, finance.invoiceCount, finance.paymentVoucherCount]
      .some((n) => n < 0);

    // 不可逆承诺：已盖章/确认采购合同、已启动生产（seq>1 已有完成/进行中）、已开票、已收款
    const hasIrreversibleCommitments =
      procurement.committedCount > 0 || production.startedStageCount > 0 ||
      finance.invoiceCount > 0 || finance.paymentVoucherCount > 0;

    return {
      contract, procurement, samples, production, finance, inventory,
      impactSummaryFailed,
      hasIrreversibleCommitments,
    };
  }

  // ── 内部：业务单号 OCR-YYYYMMDD-NNN —— ★ B274（评审 I-19）：取号收进发号真源 ──
  // 旧写法是 `count(前缀)` 再 +1 的**先读后写** ⇒ 真库并发必然撞号（同族 PAYR 修前同形，实测过"有界重试治标不治本"），
  // 而它前面那层"查询失败兜成 0"会把失败变成"今天第 1 号"。现在两样都没有：SequenceRegister 行 + 数据库级原子 increment。
  // ★ **必须在事务内用 tx 调用** ⇒ 落库回滚时号一并退回去；号的**面格式逐字不变**（仍是 OCR-YYYYMMDD-NNN）。
  async function nextRequestNumber(tx: any): Promise<string> {
    return createSequenceService(tx as any).nextNumber(tx, 'orderChangeRequest', {
      // 占用追平：序列落后于业务表（历史上直写单号 / 序列表重建）时自动递增到首个未占用号
      occupied: async (num: string) => {
        const dup = await tx.orderChangeRequest.findFirst({ where: { requestNumber: num }, select: { id: true } });
        return dup != null;
      },
    });
  }

  /**
   * ★ B3：该订单的「已出运事实」—— 用于改价/改量/交期的硬锁判定。
   *
   * 为什么**不只看 Order.status**：合票场景下非主订单（只经 ShipmentOrderAllocation 关联）
   * 不会被正向联动到 Shipping（既有行为，见 orderLinkService），
   * 只看订单状态会**漏掉整票已发运的合票订单** —— 又是「改一处、其余不动」。
   * 所以同时看：① 订单状态 ② 该订单名下有没有已离厂的运单。
   */
  async function shippedFactsOfOrder(orderId: string, db: any = prisma): Promise<{
    shipped: boolean;
    /** 已离厂运单上的累计出运量（单位不一致时为 null —— 宁可不判，不误伤） */
    shippedQty: number | null;
  }> {
    // ⓘ 取「事实」的只读查询：模型缺失/查询失败一律退化为空（fail-open）。
    //   主要判据仍是 isOrderShipped(order.status)，这里只是补上「合票订单状态没跟上」的漏网；
    //   取不到事实不该把正常改单卡死，更不该让整条申请链 500。
    const allocs: Array<{ shipmentId: string; actualQty: unknown; unit: string | null }> =
      await (db as any).shipmentOrderAllocation
        ?.findMany({ where: { orderId }, select: { shipmentId: true, actualQty: true, unit: true } })
        .catch(() => [] as any[]) ?? [];
    const projectionIds: string[] = await (db as any).shipment
      ?.findMany({ where: { orderId, deletedAt: null }, select: { id: true } })
      .then((rows: any[]) => (rows ?? []).map((r: any) => r.id))
      .catch(() => [] as string[]) ?? [];
    const ids = [...new Set([...allocs.map(a => a.shipmentId), ...projectionIds])];
    if (ids.length === 0) return { shipped: false, shippedQty: 0 };

    const ships: Array<{ id: string; status: string }> = await (db as any).shipment
      ?.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, status: true } })
      .catch(() => [] as any[]) ?? [];
    const shippedIds = new Set(ships.filter(s => isShipmentShipped(s.status)).map(s => s.id));
    if (shippedIds.size === 0) return { shipped: false, shippedQty: 0 };

    // 累计出运量：只算已离厂运单上的分配；单位混杂时判不了 → null（不猜、不误挡）
    let qty = 0;
    let unit: string | null | undefined;
    let mixed = false;
    for (const a of allocs) {
      if (!shippedIds.has(a.shipmentId)) continue;
      const q = Number(a.actualQty ?? 0);
      if (!Number.isFinite(q) || q <= 0) continue;
      const u = (a.unit ?? '').trim().toLowerCase() || null;
      if (unit === undefined) unit = u;
      else if (unit !== u) { mixed = true; break; }
      qty += q;
    }
    return { shipped: true, shippedQty: mixed ? null : qty };
  }

  /**
   * ★ B3：改价/改量/交期的出运硬锁。返回 fail 结果 = 拒绝；null = 放行。
   *
   * 规则：
   *   · delivery / price：只要**已出运**（订单已 Shipping/Delivered，或已有离厂运单）→ 硬拒
   *     出口 = 「订单状态回退 Confirmed」审批链（与交期锁同一条，出口已存在 ⇒ 不是死锁）
   *   · quantity：**改后数量 < 已出运量** 才拒（已发的货比订单还多 ⇒ 库存/开票/结算全对不上）；
   *     减到「不低于已出运量」是**合法业务**（剩下的不发了），必须放行，否则把正常减量卡死
   *   · 判不了（无新数量 / 单位混杂）→ 放行（宁可漏，不可误伤正常业务）
   */
  async function assertShippingLockForChange(
    order: { id: string; status: string },
    changeType: OrderChangeType,
    newQty: number | null,
    db: any = prisma,
  ): Promise<OrderChangeResult<never> | null> {
    if (!SHIPPING_LOCKED_CHANGE_TYPES.has(changeType)) return null;
    const facts = await shippedFactsOfOrder(order.id, db);
    if (!facts.shipped && !isOrderShipped(order.status)) return null;

    if (changeType === 'quantity') {
      if (newQty == null || facts.shippedQty == null) return null; // 判不了 → 放行
      if (newQty < facts.shippedQty - 1e-6) {
        return fail(
          ORDER_CHANGE_ERRORS.ORDER_QTY_BELOW_SHIPPED,
          `改后数量 ${newQty} 低于已出运量 ${facts.shippedQty}：已发出的货比订单数量还多，库存/已开票额/批次结算无法对齐。请先把多出部分走退货/索赔，或把数量改为 ≥ ${facts.shippedQty}`,
          409,
        );
      }
      return null; // 减到「不低于已出运量」= 合法减量，放行
    }

    return fail(
      ORDER_CHANGE_ERRORS.ORDER_SHIPPING_LOCKED,
      `订单已出运（${order.status}${facts.shipped ? ' / 存在已发运运单' : ''}），${changeType === 'price' ? '价格' : '交期'}锁死禁止篡改（B3）。已出运批次已按旧价结算且发票已开，改一个数字账就静默地变了。请先走「订单状态回退 Confirmed」审批，回退成功后再提交${changeType === 'price' ? '改价' : '交期'}申请`,
      409,
    );
  }

  async function lockOrderAndLinesForReview(tx: any, orderId: string, prior: TokenPayload | undefined,
    requiredScope: 'order:change_request:create' | 'order:change_request:apply' = 'order:change_request:create') {
    let actor = await currentCustomerConfirmationActor(tx, prior, requiredScope);
    let scope = await freshOrderLineScope(tx, actor);
    const visible = await tx.order.findFirst({ where: { id: orderId, deletedAt: null, AND: [scope] } });
    if (!visible) throw businessError('NOT_FOUND', '订单不存在或不在当前可操作范围。');
    await tx.$queryRawUnsafe('SELECT "id" FROM "Order" WHERE "id"=$1 FOR UPDATE', orderId);
    actor = await currentCustomerConfirmationActor(tx, prior, requiredScope);
    scope = await freshOrderLineScope(tx, actor);
    const order = await tx.order.findFirst({ where: { id: orderId, deletedAt: null, AND: [scope] } });
    if (!order) throw businessError('NOT_FOUND', '订单归属或可操作范围已变化，请刷新重试。');
    await tx.$queryRawUnsafe('SELECT "id" FROM "OrderLine" WHERE "orderId"=$1 ORDER BY "id" FOR UPDATE', orderId);
    const lines = await tx.orderLine.findMany({ where: { orderId }, orderBy: { id: 'asc' } });
    return { actor, order, lines };
  }

  async function prepareSuccessorProposal(tx: any, input: {
    orderId: string; changeType: 'price' | 'quantity' | 'delivery'; rawAfterDelta: Record<string, unknown>;
    requesterId: string; actor: TokenPayload; requiredScope: 'order:change_request:create' | 'order:change_request:apply';
  }) {
    let afterDelta: Record<string, unknown> = { ...input.rawAfterDelta };
    let beforeSnapshot: Record<string, unknown>;
    let order: any;
    let lines: any[];
    let actor = input.actor;
    let hitChangeTypes = [CHANGE_TYPE_TO_SCHEMA[input.changeType]];
    if (input.changeType === 'quantity') {
      if (Object.keys(afterDelta).some(key => key !== 'lineQuantityPlan' && key !== 'quantity'))
        throw businessError('INVALID_INPUT', '数量修订只接受逐行数量计划');
      const frozen = await lockAndValidateQuantityPlan(tx, input.orderId, afterDelta.lineQuantityPlan, actor, input.requiredScope);
      actor = frozen.actor;
      order = frozen.order;
      lines = frozen.actual;
      if (actor.userId !== input.requesterId && input.requiredScope === 'order:change_request:create')
        throw businessError('FORBIDDEN', '只有原申请人可以修订被驳回的订单变更');
      if (!(APPROVED_ORDER_STATUSES as readonly string[]).includes(order.status) || DR010_GUARDED_STATUSES.has(order.status))
        throw businessError('CONFLICT', '订单状态或进行中的申请已变化，不能按旧驳回内容修订');
      const shippingLock = await assertShippingLockForChange(order, 'quantity', Number(afterDelta.quantity ?? NaN) || null, tx);
      if (shippingLock && !shippingLock.ok) throw businessError(shippingLock.error.code, shippingLock.error.message);
      if (afterDelta.quantity != null && String(afterDelta.quantity) !== frozen.proposed.quantity)
        throw businessError('INVALID_INPUT', '总数量与逐行计划不一致');
      afterDelta = { ...afterDelta, lineQuantityPlan: frozen.plan, lineQuantityPlanHash: frozen.hash,
        lineCommercialFacts: quantityPlanCommercialFacts(frozen) };
      const moqSnapshot = await freezeQuantityMoqSnapshot(tx, order);
      if (moqSnapshot) afterDelta.quantityPlanMoqSnapshot = moqSnapshot;
      if (frozen.plan.version === 2 && frozen.plan.lines.some(line => line.beforeNetValue !== line.afterNetValue))
        hitChangeTypes = [CHANGE_TYPE_TO_SCHEMA.quantity, CHANGE_TYPE_TO_SCHEMA.price];
      afterDelta.quantity = frozen.proposed.quantity;
      beforeSnapshot = { quantity: order.quantity?.toString() ?? null, unit: order.unit,
        lineQuantityPlan: { version: frozen.plan.version, orderId: input.orderId, expectedUpdatedAt: frozen.plan.expectedUpdatedAt,
          lines: frozen.plan.lines.map(line => ({ ...line, afterQuantity: line.beforeQuantity,
            ...(frozen.plan.version === 2 ? { afterNetValue: line.beforeNetValue } : {}) })) } };
    } else {
      const locked = await lockOrderAndLinesForReview(tx, input.orderId, actor, input.requiredScope);
      actor = locked.actor;
      order = locked.order;
      lines = locked.lines;
      if (actor.userId !== input.requesterId && input.requiredScope === 'order:change_request:create')
        throw businessError('FORBIDDEN', '只有原申请人可以修订被驳回的订单变更');
      if (!(APPROVED_ORDER_STATUSES as readonly string[]).includes(order.status) || DR010_GUARDED_STATUSES.has(order.status))
        throw businessError('CONFLICT', '订单状态或进行中的申请已变化，不能按旧驳回内容修订');
      if (input.changeType === 'price') {
        if (Object.keys(afterDelta).length !== 1 || !Object.prototype.hasOwnProperty.call(afterDelta, 'unitPrice'))
          throw businessError('INVALID_INPUT', '改价修订只接受变更后金额');
        const value = normalizeOrderChangeDecimal(afterDelta.unitPrice);
        if (value == null || value.startsWith('-')) throw businessError('INVALID_INPUT', '变更后金额必须为非负精确数字');
        const currentAmount = normalizeOrderChangeDecimal(orderAmountOf({ ...order, lines }));
        if (currentAmount == null) throw businessError('CONFLICT', '当前订单金额无法核验，不能修订旧申请');
        beforeSnapshot = { unitPrice: currentAmount };
        afterDelta = { unitPrice: value };
      } else {
        if (Object.keys(afterDelta).length !== 1 || !Object.prototype.hasOwnProperty.call(afterDelta, 'deliveryDate'))
          throw businessError('INVALID_INPUT', '交期修订只接受交期字段');
        if (typeof afterDelta.deliveryDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(afterDelta.deliveryDate))
          throw businessError('INVALID_INPUT', '变更后交期必须为 YYYY-MM-DD');
        beforeSnapshot = { deliveryDate: String(order.dueDate ?? order.clientDate ?? '') };
      }
      const shippingLock = await assertShippingLockForChange(order, input.changeType, null, tx);
      if (shippingLock && !shippingLock.ok) throw businessError(shippingLock.error.code, shippingLock.error.message);
    }
    return { actor, order, lines, beforeSnapshot, afterDelta, hitChangeTypes,
      reviewBasis: captureOrderChangeReviewBasis(order, lines) };
  }

  function assertSourceApprovalMatchesChangeRequest(source: any, approval: any) {
    const payload = approval?.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || canonicalClaimJson(payload.beforeSnapshot) !== canonicalClaimJson(source.beforeSnapshot)
      || canonicalClaimJson(payload.afterDelta) !== canonicalClaimJson(source.afterDelta)
      || payload.changeReason !== source.changeReason
      || payload.impactSummary !== source.notes
      || canonicalClaimJson(payload.hitChangeTypes) !== canonicalClaimJson(source.changeTypes))
      throw new OrderChangeFinalVersionError('原待审审批内容与变更申请事实不一致，不能安全修改并批准。');
  }

  // ══════════════════════════════════════════════════════════════════
  // createChangeRequest — 仅已批准订单可发起（scope 由 route 层守卫）
  // ══════════════════════════════════════════════════════════════════
  async function createChangeRequest(input: CreateChangeRequestInput): Promise<OrderChangeResult<{ changeRequest: any; approvalRequestId: string }>> {
    const {
      orderId, changeType, beforeSnapshot, afterDelta, changeReason, impactSummary,
      requesterId, pauseReason, pauseOwnerId, expectedResumeDate, attachments,
    } = input;

    // 1. 变更类型校验
    if (!ORDER_CHANGE_TYPES.includes(changeType)) {
      return fail(ORDER_CHANGE_ERRORS.INVALID_CHANGE_TYPE, `非法变更类型: ${changeType}。允许: ${ORDER_CHANGE_TYPES.join(', ')}`, 400);
    }
    // 2. before/after 必填
    if (!beforeSnapshot || typeof beforeSnapshot !== 'object' || Object.keys(beforeSnapshot).length === 0 ||
        !afterDelta || typeof afterDelta !== 'object' || Object.keys(afterDelta).length === 0) {
      return fail(ORDER_CHANGE_ERRORS.MISSING_BEFORE_AFTER, 'beforeSnapshot 与 afterDelta 均必填且非空（DR-010 前后值留痕）', 400);
    }
    // 3. 原因 / 影响必填
    const reason = (changeReason ?? '').trim();
    if (reason.length < CHANGE_REASON_MIN) {
      return fail(ORDER_CHANGE_ERRORS.REASON_TOO_SHORT, `变更理由至少 ${CHANGE_REASON_MIN} 字（审计强制）`, 400);
    }
    const impact = (impactSummary ?? '').trim();
    if (impact.length < IMPACT_SUMMARY_MIN) {
      return fail(ORDER_CHANGE_ERRORS.IMPACT_TOO_SHORT, `影响说明至少 ${IMPACT_SUMMARY_MIN} 字（DR-010 记录原因与影响）`, 400);
    }
    // 4. 暂停 3 字段必填（原因/责任人/预计恢复日期）+ 日期格式与未来性校验
    if (changeType === 'pause') {
      const pr = (pauseReason ?? reason).trim();
      if (!pr || !(pauseOwnerId ?? '').trim() || !(expectedResumeDate ?? '').trim()) {
        return fail(ORDER_CHANGE_ERRORS.PAUSE_FIELDS_REQUIRED, '暂停申请必须记录原因、责任人和预计恢复日期（DR-010 §2A.3）', 400);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expectedResumeDate!) || expectedResumeDate! < todayLocalKey()) {
        return fail(ORDER_CHANGE_ERRORS.PAUSE_RESUME_DATE_INVALID, '预计恢复日期必须为 YYYY-MM-DD 且不早于今天（禁止无限期挂起）', 400);
      }
    }

    // 5. 订单校验：存在 / 未软删 / 已批准 / 非生命周期守卫中
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.deletedAt) {
      return fail(ORDER_CHANGE_ERRORS.ORDER_NOT_FOUND, `订单 ${orderId} 不存在或已删除`, 404);
    }
    if (DR010_GUARDED_STATUSES.has(order.status)) {
      return fail(ORDER_CHANGE_ERRORS.ORDER_LIFECYCLE_GUARDED, `订单处于「${order.status}」，存在进行中的变更/取消/暂停申请，禁止并发发起`, 409);
    }
    if (!(APPROVED_ORDER_STATUSES as readonly string[]).includes(order.status)) {
      return fail(ORDER_CHANGE_ERRORS.ORDER_NOT_APPROVED, `仅已批准订单（${APPROVED_ORDER_STATUSES.join('/')}）可发起变更申请；草稿/待审批订单由业务员直接撤回/取消/暂停`, 400);
    }
    // ★ B3：交期/价格/数量的出运硬锁（原只锁交期 ⇒ 货发走了还能改价改量）
    const lockFail = await assertShippingLockForChange(
      order, changeType,
      changeType === 'quantity' ? Number((afterDelta as any)?.quantity ?? NaN) || null : null,
    );
    if (lockFail) return lockFail;

    // 6. 取消：进入「取消申请中」前汇总 6 方面影响（§2A.2 步骤 1）
    let cancelImpact: Record<string, unknown> | null = null;
    if (changeType === 'cancel') {
      cancelImpact = (await summarizeCancelImpact(orderId, order)) as unknown as Record<string, unknown>;
    }

    // 7. 审批单创建（DR-007 组织归属路由；NO_REVIEWER_RESOLVED 原样透传）
    // ★ B274（评审 I-19）：取号与审批单**一起挪进下面那笔 $transaction**（照同族 PAYR 的先例收口）——
    //   · 取号原本在事务外 `count+1` 先读后写 ⇒ 真库并发撞号；
    //   · 审批单原本也在事务外先建 ⇒ 落库回滚会留下「审批单存在、变更单不存在」的孤儿审批单。
    //   审批失败的对外档位保持原样（外层 catch 用 __approvalFailure 标记分出这条路径）。
    const actionType = changeType === 'cancel' ? 'order:cancel' : changeType === 'pause' ? 'order:pause' : 'order:change';
    let approval: any;
    let requestNumber = '';

    // 8. 事务：OrderChangeRequest 落库 + 订单状态迁移 + 时间线 + 审计
    const crId = genId('OCR');
    const lifecycleStatus = changeType === 'cancel' ? 'CancelRequested' : changeType === 'pause' ? 'PauseRequested' : null;
    const impactLevel = changeType === 'customer' || changeType === 'product' || changeType === 'cancel' ? 'high' : 'medium';
    let hitChangeTypes=[CHANGE_TYPE_TO_SCHEMA[changeType]];
    const pauseMeta = changeType === 'pause'
      ? { pauseReason: (pauseReason ?? reason).trim(), pauseOwnerId: pauseOwnerId!.trim(), expectedResumeDate, resumeReminderFlagged: false }
      : null;

    try {
      const changeRequest = await prisma.$transaction(async (tx: any) => {
        let versionOrder = order;
        let versionLines: any[] = [];
        let orderChangeReviewBasis: any = null;
        if(changeType==='quantity'){
          if(Object.keys(afterDelta).some(k=>k!=='lineQuantityPlan'&&k!=='quantity'))throw businessError('INVALID_INPUT','数量变更只接受逐行计划，不混入客户、价格等其他业务字段');
          const frozen=await lockAndValidateQuantityPlan(tx,orderId,afterDelta.lineQuantityPlan,input.trustedActor,'order:change_request:create');
          if(input.trustedActor?.userId!==requesterId)throw businessError('FORBIDDEN','数量计划申请人不匹配');
          versionOrder=frozen.order;versionLines=frozen.actual;
          if(!(APPROVED_ORDER_STATUSES as readonly string[]).includes(versionOrder.status)||DR010_GUARDED_STATUSES.has(versionOrder.status))throw businessError('CONFLICT','订单状态或进行中的申请已变化，请刷新后重试');
          const sourceLock=await assertShippingLockForChange(versionOrder,changeType,Number(afterDelta.quantity??NaN)||null,tx);if(sourceLock&&!sourceLock.ok)throw businessError(sourceLock.error.code,sourceLock.error.message);
          if(afterDelta.quantity!=null&&String(afterDelta.quantity)!==frozen.proposed.quantity)throw businessError('INVALID_INPUT','总数量与逐行计划不一致');
          afterDelta.lineQuantityPlan=frozen.plan;afterDelta.lineQuantityPlanHash=frozen.hash;afterDelta.lineCommercialFacts=quantityPlanCommercialFacts(frozen);const moqSnapshot=await freezeQuantityMoqSnapshot(tx,frozen.order);if(moqSnapshot)afterDelta.quantityPlanMoqSnapshot=moqSnapshot;
          if(frozen.plan.version===2&&frozen.plan.lines.some(line=>line.beforeNetValue!==line.afterNetValue))hitChangeTypes=[CHANGE_TYPE_TO_SCHEMA.quantity,CHANGE_TYPE_TO_SCHEMA.price];
          afterDelta.quantity=frozen.proposed.quantity;
          beforeSnapshot.lineQuantityPlan={version:frozen.plan.version,orderId,expectedUpdatedAt:frozen.plan.expectedUpdatedAt,lines:frozen.plan.lines.map(l=>({...l,afterQuantity:l.beforeQuantity,...(frozen.plan.version===2?{afterNetValue:l.beforeNetValue}:{})}))};
          beforeSnapshot.quantity=frozen.order.quantity?.toString()??null;beforeSnapshot.unit=frozen.order.unit;
          orderChangeReviewBasis=captureOrderChangeReviewBasis(versionOrder,versionLines);
        } else if(changeType==='price'||changeType==='delivery'){
          const locked=await lockOrderAndLinesForReview(tx,orderId,input.trustedActor);
          if (locked.actor.userId !== requesterId) throw businessError('FORBIDDEN','申请人与当前登录主体不匹配');
          versionOrder=locked.order;versionLines=locked.lines;
          if(!(APPROVED_ORDER_STATUSES as readonly string[]).includes(versionOrder.status)||DR010_GUARDED_STATUSES.has(versionOrder.status))throw businessError('CONFLICT','订单状态或进行中的申请已变化，请刷新后重试');
          if(changeType==='price'){
            if(Object.keys(afterDelta).some(k=>k!=='unitPrice'))throw businessError('INVALID_INPUT','改价申请只接受金额字段');
            const currentAmount=normalizeOrderChangeDecimal(orderAmountOf({...versionOrder,lines:versionLines}));
            if(currentAmount==null||normalizeOrderChangeDecimal(beforeSnapshot.unitPrice)!==currentAmount)throw businessError('CONFLICT','申请前金额与当前订单明细不一致，请重新加载订单并核对报价');
            if(normalizeOrderChangeDecimal(afterDelta.unitPrice)==null)throw businessError('INVALID_INPUT','变更后金额必须是明确的非负精确数字');
          }else{
            if(Object.keys(afterDelta).some(k=>k!=='deliveryDate'))throw businessError('INVALID_INPUT','交期申请只接受交期字段');
            const currentDate=String(versionOrder.dueDate??versionOrder.clientDate??'');
            if(String(beforeSnapshot.deliveryDate??'')!==currentDate)throw businessError('CONFLICT','申请前交期与当前订单不一致，请重新加载订单并核对交期');
            if(typeof afterDelta.deliveryDate!=='string'||!/^(\d{4})-(\d{2})-(\d{2})$/.test(afterDelta.deliveryDate))throw businessError('INVALID_INPUT','变更后交期必须为 YYYY-MM-DD');
          }
          const sourceLock=await assertShippingLockForChange(versionOrder,changeType,null,tx);if(sourceLock&&!sourceLock.ok)throw businessError(sourceLock.error.code,sourceLock.error.message);
          orderChangeReviewBasis=captureOrderChangeReviewBasis(versionOrder,versionLines);
        }
        // ★ B274：取号在事务内（用 tx）；号仍写成 OCR-YYYYMMDD-NNN
        requestNumber = await nextRequestNumber(tx);
        try {
          approval = await approvalCreateService.createBusinessApproval({
            requesterId,
            actionType,
            targetType: 'OrderChangeRequest',
            targetId: orderId,
            payload: withQuantityApprovalFingerprint({
              changeType,
              hitChangeTypes,
              beforeSnapshot,
              afterDelta,
              changeReason: reason,
              impactSummary: impact,
              requestNumber,
              ...(orderChangeReviewBasis ? { orderChangeReviewBasis } : {}),
              ...(changeType === 'cancel' ? { cancelImpact } : {}),
              ...(changeType === 'pause' ? { pauseReason: (pauseReason ?? reason).trim(), pauseOwnerId, expectedResumeDate } : {}),
            }),
            risk: changeType === 'customer' || changeType === 'product' || changeType === 'cancel' ? 'high' : 'medium',
            client: tx,   // ★ B274：审批单与本笔事务同生共死（同族 PAYR 先例）
          });
        } catch (e: any) {
          (e as any).__approvalFailure = true;
          throw e;   // 让外层 catch 按原档位回（NO_REVIEWER_RESOLVED 等语义不变）
        }
        const finalVersion = orderChangeReviewBasis ? buildOrderChangeFinalVersion({
          changeRequest: { id: crId, orderId, requestNumber, changeTypes: hitChangeTypes, requesterId,
            approvalRequestId: approval.id, deletedAt: null, status: 'Pending', beforeSnapshot, afterDelta,
            changeReason: reason, notes: impact },
          order: versionOrder, orderLines: versionLines, approval, requireApproved: false,
        }) : null;
        const cr = await tx.orderChangeRequest.create({
          data: {
            id: crId,
            orderId,
            requestNumber,
            beforeSnapshot: beforeSnapshot as any,
            afterDelta: afterDelta as any,
            changeTypes: hitChangeTypes,
            impactLevel,
            changeReason: reason,
            requesterId,
            reviewerId: approval.reviewerId as string,
            approvalRequestId: approval.id,
            ...(finalVersion ? { finalContentFingerprint: finalVersion.finalContentFingerprint } : {}),
            status: 'Pending',
            notes: impact,
            attachments: (attachments ?? (cancelImpact || pauseMeta ? { cancelImpact, pause: pauseMeta } : undefined)) as any,
          },
        });

        if (lifecycleStatus) {
          const now = epochNow();
          await tx.order.update({ where: { id: orderId }, data: { status: lifecycleStatus, updatedAt: now } });
          await writeExtensionTransition(tx, orderId, order.status, lifecycleStatus, requesterId, `${requestNumber} 申请提交`);
        }

        await writeRouteAuditLog({
          prisma: tx, actorId: requesterId, source: 'service:order-change:create',
          operation: 'order_change_request', targetType: 'OrderChangeRequest', targetId: crId,
          before: { orderStatus: order.status },
          after: { changeType, requestNumber, approvalRequestId: approval.id, ...(lifecycleStatus ? { orderStatus: lifecycleStatus } : {}) },
        });
        return cr;
      });

      logger.info('[OrderChange] 变更申请已创建', { id: crId, requestNumber, changeType, orderId, approvalRequestId: approval.id });
      return { ok: true, data: { changeRequest, approvalRequestId: approval.id } };
    } catch (e: any) {
      if (e?.__approvalFailure) {
        // 与迁移前逐字同档位同文案：审批单创建失败（如 NO_REVIEWER_RESOLVED）原样透传
        // B129 收口（v3.12）：档位由真尺给（`fail` 的第三参会经 orderChangeRoute 直接 res.status 上屏）
        return fail(e?.code ?? ORDER_CHANGE_ERRORS.ORDER_STATUS_CONFLICT, e?.message ?? '审批单创建失败', statusFromError(e, 500));
      }
      if(e?.code==='NOT_FOUND')return fail(ORDER_CHANGE_ERRORS.ORDER_NOT_FOUND,'订单不存在或不在当前可操作范围',404);
      if(e?.code==='CUSTOMER_CONFIRMATION_REQUIRED')return fail(ORDER_CHANGE_ERRORS.CUSTOMER_CONFIRMATION_REQUIRED,e.message,e.statusCode??409);
      if(e?.code==='ORDER_CHANGE_VERSION_MISMATCH')return fail(ORDER_CHANGE_ERRORS.ORDER_CHANGE_VERSION_MISMATCH,e.message,e.statusCode??409);
      if(e?.code==='UNAUTHORIZED'||e?.code==='FORBIDDEN'||e?.code==='AUTHORIZATION_UNAVAILABLE')return fail(e.code,e.message,e.statusCode??403);
      if(e?.code==='CONFLICT'||e?.code==='INVALID_INPUT')return fail(ORDER_CHANGE_ERRORS.ORDER_STATUS_CONFLICT,e.message,e.statusCode??409);
      logger.error('[OrderChange] 变更申请落库失败', { orderId, changeType, error: e?.message });
      // B39：原文只进日志（上一行）。D52 覆盖面：本 try 内唯一的库写入 = 那笔 prisma.$transaction，之后只有 logger.info + return
      // ⇒ 可以承诺"本次未确认任何改动"。
      return fail(ORDER_CHANGE_ERRORS.ORDER_STATUS_CONFLICT, '变更申请创建未能完成，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对该订单的变更单与审批单。', 500);
    }
  }

  async function reviseRejectedChangeRequest(input: {
    changeRequestId: string; trustedActor?: TokenPayload; afterDelta: Record<string, unknown>;
    changeReason: string; impactSummary: string;
  }): Promise<OrderChangeResult<{ changeRequest: any; approvalRequestId: string; revisionOfId: string }>> {
    const sourceHint = await prisma.orderChangeRequest.findUnique({ where: { id: input.changeRequestId } });
    if (!sourceHint || sourceHint.deletedAt) return fail(ORDER_CHANGE_ERRORS.CHANGE_REQUEST_NOT_FOUND, '被驳回的变更申请不存在。', 404);
    if (!input.trustedActor?.userId || input.trustedActor.userId !== sourceHint.requesterId)
      return fail(ORDER_CHANGE_ERRORS.FORBIDDEN, '只有原申请人本人可以修订被驳回的订单变更。', 403);
    const changeType = (sourceHint.approvalRequestId
      ? ((await prisma.approvalRequest.findUnique({ where: { id: sourceHint.approvalRequestId } }))?.payload as any)?.changeType
      : null) as OrderChangeType | null;
    if (changeType !== 'price' && changeType !== 'quantity' && changeType !== 'delivery')
      return fail(ORDER_CHANGE_ERRORS.REVISION_NOT_ALLOWED, '当前订单变更类型暂不支持由原申请人修订重提。', 409);
    const reason = input.changeReason.trim(), impact = input.impactSummary.trim();
    if (reason.length < CHANGE_REASON_MIN) return fail(ORDER_CHANGE_ERRORS.REASON_TOO_SHORT, `变更理由至少 ${CHANGE_REASON_MIN} 字。`, 400);
    if (impact.length < IMPACT_SUMMARY_MIN) return fail(ORDER_CHANGE_ERRORS.IMPACT_TOO_SHORT, `影响说明至少 ${IMPACT_SUMMARY_MIN} 字。`, 400);

    try {
      const result = await prisma.$transaction(async (tx: any) => {
        await tx.$queryRawUnsafe('SELECT "id" FROM "Order" WHERE "id"=$1 FOR UPDATE', sourceHint.orderId);
        await tx.$queryRawUnsafe('SELECT "id" FROM "OrderChangeRequest" WHERE "id"=$1 FOR UPDATE', sourceHint.id);
        const source = await tx.orderChangeRequest.findUnique({ where: { id: sourceHint.id } });
        if (!source || source.deletedAt || source.status !== 'Rejected' || source.approvalRequestId !== sourceHint.approvalRequestId)
          throw businessError('CONFLICT', '原变更申请不再是当前可修订的驳回记录。');
        if (source.requesterId !== input.trustedActor!.userId)
          throw businessError('FORBIDDEN', '只有原申请人本人可以修订被驳回的订单变更。');
        if (!source.approvalRequestId) throw businessError('CONFLICT', '原申请缺少审批关联，不能安全修订。');
        await tx.$queryRawUnsafe('SELECT "id" FROM "OrderLine" WHERE "orderId"=$1 ORDER BY "id" FOR UPDATE', source.orderId);
        await tx.$queryRawUnsafe('SELECT "id" FROM "ApprovalRequest" WHERE "id"=$1 FOR UPDATE', source.approvalRequestId);
        const originalApproval = await tx.approvalRequest.findUnique({ where: { id: source.approvalRequestId } });
        if (!originalApproval || originalApproval.status !== 'rejected' || originalApproval.requesterId !== source.requesterId
          || originalApproval.targetType !== 'OrderChangeRequest' || originalApproval.targetId !== source.orderId
          || originalApproval.actionType !== 'order:change'
          || (originalApproval.payload as any)?.changeType !== changeType)
          throw businessError('CONFLICT', '原驳回审批与订单变更申请不一致，不能创建修订链。');
        const rejectionAudits = await tx.auditLog.findMany({ where: { OR: [
          { targetType: 'ApprovalRequest', targetId: originalApproval.id },
          { detail: { path: ['approvalId'], equals: originalApproval.id } },
        ] } });
        assertOrderChangeDecisionFact(originalApproval, rejectionAudits, 'rejected');
        const priorSuccessor = await tx.orderChangeRequest.findFirst({ where: { revisionOfId: source.id, deletedAt: null,
          status: { in: ['Pending', 'Approved', 'Applied'] } } as any, select: { id: true } });
        if (priorSuccessor) throw businessError('CONFLICT', '此驳回记录已有未完成的修订后继申请，请打开后继申请继续处理。');
        const actor = await currentCustomerConfirmationActor(tx, input.trustedActor, 'order:change_request:create');
        const proposal = await prepareSuccessorProposal(tx, { orderId: source.orderId, changeType,
          rawAfterDelta: input.afterDelta, requesterId: source.requesterId, actor, requiredScope: 'order:change_request:create' });
        const requestNumber = await nextRequestNumber(tx);
        const successorId = genId('OCR');
        const payload = withQuantityApprovalFingerprint({
          changeType, hitChangeTypes: proposal.hitChangeTypes, beforeSnapshot: proposal.beforeSnapshot,
          afterDelta: proposal.afterDelta, changeReason: reason, impactSummary: impact, requestNumber,
          orderChangeReviewBasis: proposal.reviewBasis, revisionOfId: source.id,
          revisionReason: reason, priorRejectionNote: originalApproval.decisionNote ?? null,
          supersedes: { changeRequestId: source.id, approvalRequestId: originalApproval.id },
        });
        const approval = await approvalCreateService.createBusinessApproval({ requesterId: source.requesterId,
          actionType: 'order:change', targetType: 'OrderChangeRequest', targetId: source.orderId,
          payload, risk: 'medium', client: tx });
        const finalVersion = buildOrderChangeFinalVersion({
          changeRequest: { id: successorId, orderId: source.orderId, requestNumber, changeTypes: proposal.hitChangeTypes,
            requesterId: source.requesterId, approvalRequestId: approval.id, deletedAt: null, status: 'Pending',
            beforeSnapshot: proposal.beforeSnapshot, afterDelta: proposal.afterDelta, changeReason: reason, notes: impact },
          order: proposal.order, orderLines: proposal.lines, approval, requireApproved: false,
        });
        const successor = await tx.orderChangeRequest.create({ data: {
          id: successorId, orderId: source.orderId, requestNumber,
          beforeSnapshot: proposal.beforeSnapshot as any, afterDelta: proposal.afterDelta as any,
          changeTypes: proposal.hitChangeTypes, impactLevel: 'medium', changeReason: reason,
          requesterId: source.requesterId, reviewerId: approval.reviewerId, approvalRequestId: approval.id,
          finalContentFingerprint: finalVersion.finalContentFingerprint, revisionOfId: source.id,
          status: 'Pending', notes: impact,
        } as any });
        await writeRouteAuditLog({ prisma: tx, actorId: actor.userId, source: 'service:order-change:revise',
          operation: 'order_change_revision', targetType: 'OrderChangeRequest', targetId: successorId,
          before: { sourceChangeRequestId: source.id, status: source.status, beforeSnapshot: source.beforeSnapshot, afterDelta: source.afterDelta },
          after: { revisionOfId: source.id, status: 'Pending', beforeSnapshot: proposal.beforeSnapshot,
            afterDelta: proposal.afterDelta, changeReason: reason, impactSummary: impact, approvalRequestId: approval.id,
            finalContentFingerprint: finalVersion.finalContentFingerprint } });
        return { changeRequest: successor, approvalRequestId: approval.id, revisionOfId: source.id };
      });
      return { ok: true, data: result };
    } catch (error: any) {
      if (error?.code === 'UNAUTHORIZED' || error?.code === 'FORBIDDEN' || error?.code === 'AUTHORIZATION_UNAVAILABLE')
        return fail(error.code, error.message, error.statusCode ?? 403);
      if (error?.code === 'NOT_FOUND') return fail(ORDER_CHANGE_ERRORS.ORDER_NOT_FOUND, '订单不存在或不在当前可操作范围。', 404);
      if (error?.code === 'INVALID_INPUT') return fail(ORDER_CHANGE_ERRORS.INVALID_CHANGE_TYPE, error.message, 400);
      if (error?.code === 'CONFLICT' || error?.code === 'ORDER_CHANGE_VERSION_MISMATCH') return fail(ORDER_CHANGE_ERRORS.ORDER_CHANGE_VERSION_MISMATCH, error.message, 409);
      if (error?.code === 'NO_REVIEWER_RESOLVED' || error?.code === 'APPROVAL_PENDING_CONTENT_CHANGED')
        return fail(error.code, error.message, error.statusCode ?? 409);
      logger.error('[OrderChange] 驳回修订创建失败', { changeRequestId: input.changeRequestId, error: error?.message });
      return fail(ORDER_CHANGE_ERRORS.ORDER_STATUS_CONFLICT, '修订申请未能完成，本次没有创建新申请，请稍后重试。', 500);
    }
  }

  async function previewChangeRequestAmendment(input: {
    changeRequestId: string; trustedActor?: TokenPayload; expectedApprovalReviewVersion: string;
    afterDelta: Record<string, unknown>; changeReason: string; impactSummary: string;
  }): Promise<OrderChangeResult<{ finalProposalFingerprint: string; proposal: Record<string, unknown> }>> {
    const sourceHint = await prisma.orderChangeRequest.findUnique({ where: { id: input.changeRequestId } });
    if (!sourceHint || sourceHint.deletedAt) return fail(ORDER_CHANGE_ERRORS.CHANGE_REQUEST_NOT_FOUND, '待审订单变更申请不存在。', 404);
    if (!input.trustedActor?.userId) return fail(ORDER_CHANGE_ERRORS.UNAUTHORIZED, '请登录后核对待审变更。', 401);
    if (!/^[a-f0-9]{64}$/.test(input.expectedApprovalReviewVersion))
      return fail(ORDER_CHANGE_ERRORS.AMENDMENT_NOT_ALLOWED, '审批内容版本无法核验，请重新打开待审申请。', 400);
    const reason = input.changeReason.trim(), impact = input.impactSummary.trim();
    if (reason.length < CHANGE_REASON_MIN) return fail(ORDER_CHANGE_ERRORS.REASON_TOO_SHORT, `修改理由至少 ${CHANGE_REASON_MIN} 字。`, 400);
    if (impact.length < IMPACT_SUMMARY_MIN) return fail(ORDER_CHANGE_ERRORS.IMPACT_TOO_SHORT, `影响说明至少 ${IMPACT_SUMMARY_MIN} 字。`, 400);
    if (!input.afterDelta || typeof input.afterDelta !== 'object' || Array.isArray(input.afterDelta))
      return fail(ORDER_CHANGE_ERRORS.AMENDMENT_NOT_ALLOWED, '修改并批准必须提交明确的最终变更内容。', 400);

    try {
      const preview = await prisma.$transaction(async (tx: any) => {
        await tx.$queryRawUnsafe('SELECT "id" FROM "Order" WHERE "id"=$1 FOR UPDATE', sourceHint.orderId);
        await tx.$queryRawUnsafe('SELECT "id" FROM "OrderChangeRequest" WHERE "id"=$1 FOR UPDATE', sourceHint.id);
        const source = await tx.orderChangeRequest.findUnique({ where: { id: sourceHint.id } });
        if (!source || source.deletedAt || source.status !== 'Pending' || !source.approvalRequestId)
          throw businessError('CONFLICT', '待审申请已变化；请刷新后按当前版本处理。');
        await tx.$queryRawUnsafe('SELECT "id" FROM "OrderLine" WHERE "orderId"=$1 ORDER BY "id" FOR UPDATE', source.orderId);
        await tx.$queryRawUnsafe('SELECT "id" FROM "ApprovalRequest" WHERE "id"=$1 FOR UPDATE', source.approvalRequestId);
        const approval = await tx.approvalRequest.findUnique({ where: { id: source.approvalRequestId } });
        const changeType = (approval?.payload as any)?.changeType as OrderChangeType | undefined;
        if (!approval || approval.status !== 'pending' || approval.requesterId !== source.requesterId
          || approval.targetType !== 'OrderChangeRequest' || approval.targetId !== source.orderId
          || approval.actionType !== 'order:change' || !['price', 'quantity', 'delivery'].includes(changeType ?? ''))
          throw businessError('CONFLICT', '当前审批不属于可修改的待审订单价格、数量或交期变更。');
        assertSourceApprovalMatchesChangeRequest(source, approval);
        const actor = await currentCustomerConfirmationActor(tx, input.trustedActor, 'order:change_request:apply');
        const ownership = evaluateDecideOwnership(approval, { ...actor, roles: actor.roles ?? [] });
        if (!ownership.ok) throw businessError(ownership.code, ownership.message);
        if (actor.userId === source.requesterId) throw businessError('FORBIDDEN', '申请人不可修改并批准自己的申请。');
        const reviewVersion = approvalReviewContentVersion(approval);
        if (reviewVersion !== input.expectedApprovalReviewVersion)
          throw new OrderChangeFinalVersionError('原审批内容已变化，请重新加载差异并核对后再签署。');
        const proposal = await prepareSuccessorProposal(tx, { orderId: source.orderId,
          changeType: changeType as 'price' | 'quantity' | 'delivery', rawAfterDelta: input.afterDelta,
          requesterId: source.requesterId, actor, requiredScope: 'order:change_request:apply' });
        const finalProposalFingerprint = orderChangeAmendmentProposalFingerprint({
          sourceChangeRequest: source, sourceApproval: approval, sourceApprovalReviewVersion: reviewVersion,
          currentSourceBasis: proposal.reviewBasis,
          proposal: { changeType: changeType as 'price' | 'quantity' | 'delivery', hitChangeTypes: proposal.hitChangeTypes, beforeSnapshot: proposal.beforeSnapshot,
            afterDelta: proposal.afterDelta, changeReason: reason, impactSummary: impact },
        });
        const quantityPlan = (proposal.afterDelta as any).lineQuantityPlan;
        const displayDiff = changeType === 'quantity'
          ? ((quantityPlan?.lines ?? []).map((line: any) => {
              const sourceLine = proposal.lines.find((candidate: any) => candidate.id === line.lineId);
              return { label: sourceLine?.itemNo || `第${sourceLine?.lineNumber ?? '未知'}行`,
                before: line.beforeQuantity, after: line.afterQuantity, unit: line.unit,
                beforeAmount: line.beforeNetValue ?? sourceLine?.netValue?.toString?.() ?? null,
                afterAmount: line.afterNetValue ?? null };
            }))
          : [{ label: changeType === 'price' ? '订单金额' : '交期',
              before: changeType === 'price' ? proposal.beforeSnapshot.unitPrice : proposal.beforeSnapshot.deliveryDate,
              after: changeType === 'price' ? proposal.afterDelta.unitPrice : proposal.afterDelta.deliveryDate,
              unit: changeType === 'price' ? proposal.order.salesCurrency ?? proposal.order.currency ?? null : null }];
        return { finalProposalFingerprint, proposal: { changeType, beforeSnapshot: proposal.beforeSnapshot,
          afterDelta: proposal.afterDelta, changeReason: reason, impactSummary: impact,
          displayDiff } };
      });
      return { ok: true, data: preview };
    } catch (error: any) {
      if (error?.code === 'UNAUTHORIZED' || error?.code === 'FORBIDDEN' || error?.code === 'AUTHORIZATION_UNAVAILABLE'
        || error?.code === 'APPROVAL_NOT_ASSIGNED' || error?.code === 'SELF_APPROVAL_FORBIDDEN')
        return fail(error.code as OrderChangeErrorCode, error.message, error.statusCode ?? 403);
      if (error?.code === 'NOT_FOUND') return fail(ORDER_CHANGE_ERRORS.ORDER_NOT_FOUND, '订单不存在或不在当前可操作范围。', 404);
      if (error?.code === 'INVALID_INPUT') return fail(ORDER_CHANGE_ERRORS.AMENDMENT_NOT_ALLOWED, error.message, 400);
      if (error?.code === 'ORDER_CHANGE_VERSION_MISMATCH' || error?.code === 'CONFLICT' || error?.code === 'ORDER_SHIPPING_LOCKED'
        || error?.code === 'ORDER_QTY_BELOW_SHIPPED') return fail(error.code, error.message, error.statusCode ?? 409);
      return fail(ORDER_CHANGE_ERRORS.ORDER_STATUS_CONFLICT, '最终变更内容预览未完成，请刷新后重试。', 500);
    }
  }

  async function amendAndApproveChangeRequest(input: {
    changeRequestId: string; trustedActor?: TokenPayload; expectedApprovalReviewVersion: string;
    expectedFinalProposalFingerprint: string;
    afterDelta: Record<string, unknown>; changeReason: string; impactSummary: string; decisionNote?: string;
    confirmedReviewedContent: boolean;
  }): Promise<OrderChangeResult<{ changeRequest: any; approvalRequestId: string; revisionOfId: string; sync?: any }>> {
    const sourceHint = await prisma.orderChangeRequest.findUnique({ where: { id: input.changeRequestId } });
    if (!sourceHint || sourceHint.deletedAt) return fail(ORDER_CHANGE_ERRORS.CHANGE_REQUEST_NOT_FOUND, '待审订单变更申请不存在。', 404);
    if (!input.trustedActor?.userId) return fail(ORDER_CHANGE_ERRORS.UNAUTHORIZED, '请登录后处理待审变更。', 401);
    if (!/^[a-f0-9]{64}$/.test(input.expectedApprovalReviewVersion)
      || !/^[a-f0-9]{64}$/.test(input.expectedFinalProposalFingerprint) || input.confirmedReviewedContent !== true)
      return fail(ORDER_CHANGE_ERRORS.AMENDMENT_NOT_ALLOWED, '修改并批准必须绑定原审批版本、最终拟案指纹并确认核对最终内容。', 400);
    const reason = input.changeReason.trim(), impact = input.impactSummary.trim();
    if (reason.length < CHANGE_REASON_MIN) return fail(ORDER_CHANGE_ERRORS.REASON_TOO_SHORT, `修改理由至少 ${CHANGE_REASON_MIN} 字。`, 400);
    if (impact.length < IMPACT_SUMMARY_MIN) return fail(ORDER_CHANGE_ERRORS.IMPACT_TOO_SHORT, `影响说明至少 ${IMPACT_SUMMARY_MIN} 字。`, 400);

    try {
      const result = await prisma.$transaction(async (tx: any) => {
        await tx.$queryRawUnsafe('SELECT "id" FROM "Order" WHERE "id"=$1 FOR UPDATE', sourceHint.orderId);
        await tx.$queryRawUnsafe('SELECT "id" FROM "OrderChangeRequest" WHERE "id"=$1 FOR UPDATE', sourceHint.id);
        const source = await tx.orderChangeRequest.findUnique({ where: { id: sourceHint.id } });
        if (!source || source.deletedAt || source.status !== 'Pending' || !source.approvalRequestId)
          throw businessError('CONFLICT', '待审申请已变化；请刷新后按当前版本处理。');
        await tx.$queryRawUnsafe('SELECT "id" FROM "OrderLine" WHERE "orderId"=$1 ORDER BY "id" FOR UPDATE', source.orderId);
        await tx.$queryRawUnsafe('SELECT "id" FROM "ApprovalRequest" WHERE "id"=$1 FOR UPDATE', source.approvalRequestId);
        const originalApproval = await tx.approvalRequest.findUnique({ where: { id: source.approvalRequestId } });
        const changeType = (originalApproval?.payload as any)?.changeType as OrderChangeType | undefined;
        if (!originalApproval || originalApproval.status !== 'pending' || originalApproval.requesterId !== source.requesterId
          || originalApproval.targetType !== 'OrderChangeRequest' || originalApproval.targetId !== source.orderId
          || originalApproval.actionType !== 'order:change' || !['price', 'quantity', 'delivery'].includes(changeType ?? ''))
          throw businessError('CONFLICT', '当前审批不属于可修改的待审订单价格、数量或交期变更。');
        assertSourceApprovalMatchesChangeRequest(source, originalApproval);
        const actor = await currentCustomerConfirmationActor(tx, input.trustedActor, 'order:change_request:apply');
        const ownership = evaluateDecideOwnership(originalApproval, { ...actor, roles: actor.roles ?? [] });
        if (!ownership.ok) throw businessError(ownership.code, ownership.message);
        if (actor.userId === source.requesterId) throw businessError('FORBIDDEN', '申请人不可修改并批准自己的申请。');
        if (approvalReviewContentVersion(originalApproval) !== input.expectedApprovalReviewVersion)
          throw new OrderChangeFinalVersionError('原审批内容已变化，请重新加载差异并核对后再签署。');
        const priorSuccessor = await tx.orderChangeRequest.findFirst({ where: { revisionOfId: source.id, deletedAt: null } as any, select: { id: true } });
        if (priorSuccessor) throw businessError('CONFLICT', '此待审申请已有后继修订，请打开后继申请处理。');

        const proposal = await prepareSuccessorProposal(tx, { orderId: source.orderId, changeType: changeType as 'price' | 'quantity' | 'delivery',
          rawAfterDelta: input.afterDelta, requesterId: source.requesterId, actor, requiredScope: 'order:change_request:apply' });
        const finalProposalFingerprint = orderChangeAmendmentProposalFingerprint({
          sourceChangeRequest: source, sourceApproval: originalApproval,
          sourceApprovalReviewVersion: input.expectedApprovalReviewVersion, currentSourceBasis: proposal.reviewBasis,
          proposal: { changeType: changeType as 'price' | 'quantity' | 'delivery', hitChangeTypes: proposal.hitChangeTypes, beforeSnapshot: proposal.beforeSnapshot,
            afterDelta: proposal.afterDelta, changeReason: reason, impactSummary: impact },
        });
        if (finalProposalFingerprint !== input.expectedFinalProposalFingerprint)
          throw new OrderChangeFinalVersionError('最终拟案或订单来源在预览后已变化，尚未创建后继申请或批准；请重新预览并核对。');
        const requestNumber = await nextRequestNumber(tx);
        const successorId = genId('OCR');
        // Preserve both the requester's identity and the moderator's exact amendment diff.
        const payload = withQuantityApprovalFingerprint({
          changeType, hitChangeTypes: proposal.hitChangeTypes, beforeSnapshot: proposal.beforeSnapshot,
          afterDelta: proposal.afterDelta, changeReason: reason, impactSummary: impact, requestNumber,
          orderChangeReviewBasis: proposal.reviewBasis, revisionOfId: source.id,
          amendment: { sourceChangeRequestId: source.id, sourceApprovalId: originalApproval.id,
            amendedBy: actor.userId, reason, beforeSnapshot: source.beforeSnapshot, beforeDelta: source.afterDelta,
            finalBeforeSnapshot: proposal.beforeSnapshot, finalAfterDelta: proposal.afterDelta,
            finalProposalFingerprint },
        });

        // The old pending pair is superseded inside this transaction. It remains an immutable rejected/approved
        // fact if already resolved; here only the pending proposal is cancelled, with explicit successor audits.
        const cancelApproval = await tx.approvalRequest.updateMany({ where: {
          id: originalApproval.id, status: 'pending', requesterId: originalApproval.requesterId,
          reviewerId: originalApproval.reviewerId, actionType: originalApproval.actionType,
          targetType: originalApproval.targetType, targetId: originalApproval.targetId,
          payload: { equals: originalApproval.payload },
        }, data: { status: 'cancelled', decidedAt: businessNowDate(), decisionNote: '本待审申请已由订单域原生修改并批准流程替代。' } });
        if (cancelApproval.count !== 1) throw businessError('CONFLICT', '原待审审批在修订过程中已变化，请重新加载。');
        const cancelChange = await tx.orderChangeRequest.updateMany({ where: { id: source.id, status: 'Pending', approvalRequestId: originalApproval.id },
          data: { status: 'Cancelled' } });
        if (cancelChange.count !== 1) throw businessError('CONFLICT', '原待审变更申请已变化，请重新加载。');

        const approval = await approvalCreateService.createBusinessApproval({ requesterId: source.requesterId,
          actionType: 'order:change', targetType: 'OrderChangeRequest', targetId: source.orderId,
          payload, risk: 'medium', client: tx });
        const finalVersion = buildOrderChangeFinalVersion({
          changeRequest: { id: successorId, orderId: source.orderId, requestNumber, changeTypes: proposal.hitChangeTypes,
            requesterId: source.requesterId, approvalRequestId: approval.id, deletedAt: null, status: 'Pending',
            beforeSnapshot: proposal.beforeSnapshot, afterDelta: proposal.afterDelta, changeReason: reason, notes: impact },
          order: proposal.order, orderLines: proposal.lines, approval, requireApproved: false,
        });
        const successor = await tx.orderChangeRequest.create({ data: {
          id: successorId, orderId: source.orderId, requestNumber,
          beforeSnapshot: proposal.beforeSnapshot as any, afterDelta: proposal.afterDelta as any,
          changeTypes: proposal.hitChangeTypes, impactLevel: 'medium', changeReason: reason,
          requesterId: source.requesterId, reviewerId: approval.reviewerId, approvalRequestId: approval.id,
          finalContentFingerprint: finalVersion.finalContentFingerprint, revisionOfId: source.id,
          status: 'Pending', notes: impact,
        } as any });
        const supersededAuditId = genId('alog');
        await tx.auditLog.create({ data: { id: supersededAuditId, actorId: actor.userId, action: 'approval_superseded',
          targetType: 'ApprovalRequest', targetId: originalApproval.id,
          detail: { approvalId: originalApproval.id, changeRequestId: source.id, replacementChangeRequestId: successor.id,
            replacementApprovalRequestId: approval.id, actorId: actor.userId, reason },
          operationType: 'transition', fieldPath: 'status', beforeValue: 'pending', afterValue: 'cancelled', transactionId: null } });
        await writeRouteAuditLog({ prisma: tx, actorId: actor.userId, source: 'service:order-change:amend-and-approve',
          operation: 'order_change_amend_and_approve', targetType: 'OrderChangeRequest', targetId: successorId,
          before: { sourceChangeRequestId: source.id, sourceApprovalId: originalApproval.id,
            sourceBeforeSnapshot: source.beforeSnapshot, sourceAfterDelta: source.afterDelta },
          after: { revisionOfId: source.id, status: 'Pending', requesterId: source.requesterId,
            amendmentBy: actor.userId, beforeSnapshot: proposal.beforeSnapshot, afterDelta: proposal.afterDelta,
            changeReason: reason, impactSummary: impact, finalProposalFingerprint,
            finalContentFingerprint: finalVersion.finalContentFingerprint,
            approvalRequestId: approval.id } });
        const decisionInput = { id: approval.id, actor: { userId: actor.userId, roles: actor.roles ?? [],
          roleIds: actor.roleIds, authorizationLoaded: true as const, displayName: actor.displayName },
          decision: 'approved' as const, source: 'api:approvals' as const,
          decisionNote: `修改并批准：${(input.decisionNote ?? reason).trim()}`,
          reviewContentVersion: approvalReviewContentVersion(approval), confirmedReviewedContent: true };
        const committed = await decisionService.decideInTransaction(tx, decisionInput);
        return { changeRequest: successor, approvalRequestId: approval.id, revisionOfId: source.id, committed, decisionInput };
      });
      const published = await decisionService.publishCommittedDecision(result.committed, result.decisionInput);
      const currentSuccessor = await prisma.orderChangeRequest.findUnique({ where: { id: result.changeRequest.id } });
      return { ok: true, data: { changeRequest: currentSuccessor ?? result.changeRequest,
        approvalRequestId: result.approvalRequestId, revisionOfId: result.revisionOfId, sync: published.sync } };
    } catch (error: any) {
      if (error?.code === 'UNAUTHORIZED' || error?.code === 'FORBIDDEN' || error?.code === 'AUTHORIZATION_UNAVAILABLE'
        || error?.code === 'APPROVAL_NOT_ASSIGNED' || error?.code === 'SELF_APPROVAL_FORBIDDEN')
        return fail(error.code as OrderChangeErrorCode, error.message, error.statusCode ?? 403);
      if (error?.code === 'NOT_FOUND') return fail(ORDER_CHANGE_ERRORS.ORDER_NOT_FOUND, '订单不存在或不在当前可操作范围。', 404);
      if (error?.code === 'INVALID_INPUT') return fail(ORDER_CHANGE_ERRORS.AMENDMENT_NOT_ALLOWED, error.message, 400);
      if (error?.code === 'ORDER_CHANGE_VERSION_MISMATCH' || error?.code === 'CONFLICT' || error?.code === 'APPROVAL_CONTENT_CHANGED')
        return fail(ORDER_CHANGE_ERRORS.ORDER_CHANGE_VERSION_MISMATCH, error.message, 409);
      if (error?.code === 'NO_REVIEWER_RESOLVED' || error?.code === 'APPROVAL_PENDING_CONTENT_CHANGED')
        return fail(error.code, error.message, error.statusCode ?? 409);
      logger.error('[OrderChange] 待审内容修改并批准失败', { changeRequestId: input.changeRequestId, error: error?.message });
      return fail(ORDER_CHANGE_ERRORS.ORDER_STATUS_CONFLICT, '修改并批准未完成，原待审内容仍保持不变，请稍后刷新重试。', 500);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // applyChangeRequest — 审批通过后生效（幂等；scope 由 route 层守卫）
  // ══════════════════════════════════════════════════════════════════
  async function applyChangeRequest(params: { changeRequestId: string; appliedBy: string; trustedActor?:TokenPayload }): Promise<OrderChangeResult<{ changeRequest: any; applied: string }>> {
    const { changeRequestId, appliedBy } = params;

    const initialCr = await prisma.orderChangeRequest.findUnique({ where: { id: changeRequestId } });
    if (!initialCr || initialCr.deletedAt) {
      return fail(ORDER_CHANGE_ERRORS.CHANGE_REQUEST_NOT_FOUND, `变更申请 ${changeRequestId} 不存在`, 404);
    }
    let cr: any = initialCr;
    // 幂等：已 Applied 直接返回，不产生二次写入
    if (cr.status === 'Applied') {
      return fail(ORDER_CHANGE_ERRORS.ALREADY_APPLIED, `变更申请 ${cr.requestNumber} 已生效（appliedAt=${cr.appliedAt?.toISOString?.() ?? cr.appliedAt}），防重复 apply`, 409);
    }
    if (cr.status !== 'Approved') {
      return fail(ORDER_CHANGE_ERRORS.CHANGE_REQUEST_NOT_APPROVED, `变更申请当前状态 ${cr.status}，仅 Approved 可生效`, 409);
    }

    const schemaType: string = cr.changeTypes?.[0] ?? 'other';
    // schema 枚举反推业务类型：非 'other' 直接反查；'other' 由 attachments.pause 区分 pause/cancel
    let businessType: OrderChangeType = schemaType !== 'other'
      ? ((Object.keys(CHANGE_TYPE_TO_SCHEMA) as OrderChangeType[])
          .find((k) => CHANGE_TYPE_TO_SCHEMA[k] === schemaType) ?? 'cancel')
      : ((cr as any).attachments?.pause ? 'pause' : 'cancel');
    let afterDelta = (cr.afterDelta ?? {}) as Record<string, unknown>;
    let order: any = null;

    try {
      const result = await prisma.$transaction(async (tx: any) => {
        await tx.$queryRawUnsafe('SELECT "id" FROM "Order" WHERE "id"=$1 FOR UPDATE',cr.orderId);
        await tx.$queryRawUnsafe('SELECT "id" FROM "OrderChangeRequest" WHERE "id"=$1 FOR UPDATE',cr.id);
        const currentCr=await tx.orderChangeRequest.findUniqueOrThrow({where:{id:initialCr.id}});
        if(currentCr.status!=='Approved')throw businessError('CONFLICT','变更申请已生效或不再处于批准状态');
        cr=currentCr;
        order=await tx.order.findUnique({where:{id:cr.orderId}});
        if(!order||order.deletedAt)throw businessError('NOT_FOUND','订单不存在或已删除');
        const currentSchemaType: string = cr.changeTypes?.[0] ?? 'other';
        businessType = currentSchemaType !== 'other'
          ? ((Object.keys(CHANGE_TYPE_TO_SCHEMA) as OrderChangeType[]).find((k) => CHANGE_TYPE_TO_SCHEMA[k] === currentSchemaType) ?? 'cancel')
          : ((cr as any).attachments?.pause ? 'pause' : 'cancel');
        afterDelta = (cr.afterDelta ?? {}) as Record<string, unknown>;
        const requiresCustomerConfirmation = ['price','quantity','delivery'].includes(businessType);
        let approval: any = null;
        let finalVersion: ReturnType<typeof buildOrderChangeFinalVersion> | null = null;
        if(requiresCustomerConfirmation){
          if(!cr.approvalRequestId)throw new OrderChangeFinalVersionError('订单变更缺少内部审批关联');
          await tx.$queryRawUnsafe('SELECT "id" FROM "OrderLine" WHERE "orderId"=$1 ORDER BY "id" FOR UPDATE',cr.orderId);
          const currentLines=await tx.orderLine.findMany({where:{orderId:cr.orderId},orderBy:{id:'asc'}});
          await tx.$queryRawUnsafe('SELECT "id" FROM "ApprovalRequest" WHERE "id"=$1 FOR UPDATE',cr.approvalRequestId);
          approval=await tx.approvalRequest.findUnique({where:{id:cr.approvalRequestId}});
          if(!approval)throw new OrderChangeFinalVersionError('找不到原内部审批单');
          finalVersion=buildOrderChangeFinalVersion({changeRequest:cr,order,orderLines:currentLines,approval});
          if(!cr.finalContentFingerprint||finalVersion.finalContentFingerprint!==cr.finalContentFingerprint)
            throw new OrderChangeFinalVersionError('内部批准最终版本与当前订单/订单行不一致，订单未修改');
          const audits=await tx.auditLog.findMany({where:{OR:[
            {targetType:'ApprovalRequest',targetId:approval.id},
            {detail:{path:['approvalId'],equals:approval.id}},
          ]}});
          assertOrderChangeApprovalDecisionFact(approval,audits);
          if(params.trustedActor?.userId!==appliedBy)throw businessError('FORBIDDEN','订单变更执行主体不匹配');
          const confirmationActor=await currentCustomerConfirmationActor(tx,params.trustedActor,'order:change_request:apply');
          await assertFinalCustomerConfirmationInTx(tx,{targetType:'OrderChangeRequest',targetId:cr.id,actor:confirmationActor,
            finalContentFingerprint:finalVersion.finalContentFingerprint,internalApprovalId:approval.id,
            scopeFingerprint:finalVersion.scopeFingerprint,requiredScope:finalVersion.scope});
        }
        const applyLockFail=await assertShippingLockForChange(order,businessType,
          businessType==='quantity'?Number(afterDelta?.quantity??NaN)||null:null,tx);
        if(applyLockFail&&!applyLockFail.ok)throw Object.assign(new Error(applyLockFail.error.message),{code:applyLockFail.error.code,statusCode:applyLockFail.error.statusCode});
        let validatedPlan:Awaited<ReturnType<typeof lockAndValidateQuantityPlan>>|null=null;
        if(businessType==='quantity'){
          if(params.trustedActor?.userId!==appliedBy)throw businessError('FORBIDDEN','数量计划执行主体不匹配');
          validatedPlan=await lockAndValidateQuantityPlan(tx,cr.orderId,afterDelta.lineQuantityPlan,params.trustedActor,'order:change_request:apply');
          if(!approval||approval.status!=='approved'||approval.requesterId!==cr.requesterId||approval.targetType!=='OrderChangeRequest'||approval.targetId!==cr.orderId||approval.actionType!=='order:change')throw businessError('CONFLICT','原批准数量计划无法核验');
          await assertOriginalQuantityDecision(tx,approval);
          const approvedDelta=(approval.payload as any)?.afterDelta;
          if(canonicalClaimJson(afterDelta.lineCommercialFacts)!==canonicalClaimJson(quantityPlanCommercialFacts(validatedPlan)))throw businessError('CONFLICT','审批后实际行价格或金额事实已变化，请重新核对逐行变更方案');
          if(canonicalClaimJson(approvedDelta)!==canonicalClaimJson(currentCr.afterDelta)||canonicalClaimJson((approval.payload as any)?.beforeSnapshot)!==canonicalClaimJson(currentCr.beforeSnapshot)||canonicalClaimJson(currentCr.afterDelta)!==canonicalClaimJson(afterDelta))throw businessError('CONFLICT','原批准快照和当前变更原件不一致');
          if(!approvedDelta?.lineQuantityPlan||quantityPlanApprovalHash(canonicalQuantityPlan(approvedDelta.lineQuantityPlan),approvedDelta.lineCommercialFacts)!==validatedPlan.hash||approvedDelta.lineQuantityPlanHash!==validatedPlan.hash||afterDelta.lineQuantityPlanHash!==validatedPlan.hash)throw businessError('CONFLICT','数量计划与原审批快照不一致');
        }
        if(validatedPlan){const blocked=await requireProposedPlanMoq(tx,currentCr,validatedPlan,approvalCreateService);if(blocked)return {moqBlocked:blocked};}
        const now = epochNow();
        let appliedTag: string = businessType;
        let orderUpdateData: Record<string, unknown> | null = null;
        let statusTo: string | null = null;

        if (businessType === 'cancel') {
          // §2A.2 步骤 3a/3b：无不可逆承诺 → 直接结案关闭；有承诺 → 结案处理中
          if (order.status !== 'CancelRequested') {
            throw Object.assign(new Error(`订单当前状态 ${order.status}，取消生效要求 CancelRequested`), { code: ORDER_CHANGE_ERRORS.ORDER_STATUS_CONFLICT });
          }
          const impact = await summarizeCancelImpact(cr.orderId, order);
          statusTo = impact.hasIrreversibleCommitments ? 'Closing' : 'Cancelled';
          orderUpdateData = { status: statusTo, updatedAt: now };
          appliedTag = statusTo === 'Closing' ? 'cancel_to_closing' : 'cancel_closed_direct';
        } else if (businessType === 'pause') {
          if (order.status !== 'PauseRequested') {
            throw Object.assign(new Error(`订单当前状态 ${order.status}，暂停生效要求 PauseRequested`), { code: ORDER_CHANGE_ERRORS.ORDER_STATUS_CONFLICT });
          }
          const pauseMeta = (cr as any).attachments?.pause ?? {};
          statusTo = 'Paused';
          orderUpdateData = { status: 'Paused', updatedAt: now };
          await tx.orderChangeRequest.update({
            where: { id: cr.id },
            data: {
              attachments: {
                ...(((cr as any).attachments) ?? {}),
                pause: { ...pauseMeta, pausedAt: businessNowDate().toISOString(), resumeReminderFlagged: false },
              } as any,
            },
          });
          appliedTag = 'pause_activated';
        } else {
          // 业务字段变更：写入 Order 字段（before 不被覆盖，审批通过才 commit）
          const data: Record<string, unknown> = { updatedAt: now };
          for (const [field, value] of Object.entries(afterDelta)) {
            const column = ORDER_FIELD_MAP[field];
            if (column) data[column] = value;
          }
          orderUpdateData = data;

          // 客户变更 → 额度联动（EXC 也不跳过联动，OCG-EXC-2）
          if (businessType === 'customer') {
            const newRelationId = String(afterDelta.customerRelationId ?? afterDelta.customer ?? '');
            if (newRelationId && newRelationId !== order.customerRelationId) {
              await applyCustomerCreditLinkage(tx, cr.id, order, newRelationId);
            } else if (!newRelationId) {
              logger.warn('[OrderChange] 客户变更缺少 customerRelationId after 值，额度联动跳过', { changeRequestId: cr.id });
            }
          }

          // 产品变更 → PreCutChecklist 重置（4 项全部→false，重新走裁剪前确认，§9.3 质量门禁联动）
          if (businessType === 'product') {
            await tx.preCutChecklist.updateMany({
              where: { orderId: cr.orderId },
              data: {
                gradingConfirmed: false, consumptionConfirmed: false,
                patternConfirmed: false, preProductionMeeting: false,
                confirmedBy: null, confirmedAt: null, updatedAt: now,
              },
            });
          }
          // 数量变更 → MOQ 重算接入点：校验服务属其他 Track，此处发布 OrderChanged 事件
          // 由下游 MOQ/豁免校验订阅重算（见下方 publishBusinessEvent），留 TODO 接口点。

          // ★★ 改数量 / 改价 → 明细行 + 派生金额联动重算
          //    Kevin 2026-09-18 拍板②「跟着改，金额重算」。
          //    此前只写主档一个字段、明细行与 totalNet 一律不动 ⇒
          //    实测：客户砍到 1500 件，主档 quantity=1500，明细行仍是 1800，金额仍按 1800 件算
          //    —— 客户要 1500 件、我们按 1800 件收钱（**出错账**，且不报错）。
          //    ⓘ afterDelta.unitPrice 装的其实是**总金额**（见 services/orderChangeService.ts
          //      case 'price'：afterAmount），故此处按 'price' 模式反算单价。
          if(businessType==='quantity'){if(!validatedPlan)throw businessError('CONFLICT','缺少原批准逐行计划');await applyExactQuantityPlan(tx,validatedPlan);if((afterDelta.quantityPlanMoqSnapshot as any)?.snapshot){const current=await tx.order.findUnique({where:{id:cr.orderId},select:{moqSnapshot:true}});if(!isValidSnapshot(current?.moqSnapshot))data.moqSnapshot=(afterDelta.quantityPlanMoqSnapshot as any).snapshot;}delete data.quantity;}
          if (businessType === 'price') {
            const rawTarget = afterDelta.unitPrice;
            const target = Number(rawTarget);
            if (Number.isFinite(target)) {
              // ★ 联动是**增强**，绝不能反过来把改单主流程搞挂：
              //   失败时降级为「只写主档」（= 既有行为）并告警，不阻断审批生效。
              let recalc: Awaited<ReturnType<typeof recalcOrderAmountFromLines>> = null;
              try {
                recalc = await recalcOrderAmountFromLines(
                  tx,
                  cr.orderId,
                  'price',
                  target,
                );
              } catch (e: any) {
                logger.error('[OrderChange] 金额联动重算失败，降级为仅写主档', {
                  changeRequestId: cr.id, orderId: cr.orderId, businessType, error: String(e?.message ?? e),
                });
                throw e;
              }
              if (recalc && orderUpdateData) {
                // 联动已写入主档派生金额：剔除单点写入，避免覆盖掉尾差兜底后的真值
                for (const k of ['quantity', 'quoteAmount', 'contractAmount', 'totalNet']) {
                  delete (orderUpdateData as Record<string, unknown>)[k];
                }
                logger.info('[OrderChange] 金额联动重算完成', {
                  changeRequestId: cr.id, orderId: cr.orderId, businessType,
                  lines: recalc.linesUpdated, quantity: recalc.quantity, totalNet: recalc.totalNet,
                });
              }
            }
          }
        }

        // 订单写回 + 状态迁移（cancel/pause 有状态机动作）
        let updatedOrder = order;
        if (orderUpdateData) {
          updatedOrder = await tx.order.update({ where: { id: cr.orderId }, data: orderUpdateData });
          if (statusTo) {
            await writeExtensionTransition(tx, cr.orderId, order.status, statusTo, appliedBy, `${cr.requestNumber} 审批通过生效`);
          }
          // 业务字段变更后同步 EntityLink（customer 等关联快照）
          if (!statusTo && (businessType === 'customer' || businessType === 'product')) {
            await syncOrderEntityReferences(prisma, updatedOrder, { source: 'service:order-change:apply' }, tx);
          }
        }

        // 变更申请状态 → Applied（仅非 cancel/pause 在 updateMany 前已写过 attachments，统一覆盖）
        const applied = await tx.orderChangeRequest.update({
          where: { id: cr.id },
          data: { status: 'Applied', appliedAt: businessNowDate(), appliedBy },
        });

        // 字段级 AuditLog：每个 afterDelta 字段一条（§4.1），transactionId=approvalRequestId ?? cr.id
        const transactionId = cr.approvalRequestId ?? cr.id;
        const beforeSnapshot = (cr.beforeSnapshot ?? {}) as Record<string, unknown>;
        for (const [field, value] of Object.entries(afterDelta)) {
          await tx.auditLog.create({
            data: {
              id: genId('alog'),
              actorId: appliedBy,
              action: 'order_change_approved',
              targetType: 'Order',
              targetId: cr.orderId,
              detail: { source: 'service:order-change:apply', changeRequestId: cr.id, changeType: businessType } as any,
              ip: null,
              operationType: 'update',
              fieldPath: field,
              beforeValue: beforeSnapshot[field] as any,
              afterValue: value as any,
              transactionId,
            },
          });
        }

        return { changeRequest: applied, applied: appliedTag };
      });

      if('moqBlocked' in result && result.moqBlocked)return {ok:false,error:{code:ORDER_CHANGE_ERRORS.ORDER_STATUS_CONFLICT,message:result.moqBlocked.message,statusCode:409,approvalRequestId:result.moqBlocked.approvalRequestId}};
      // 事务提交后 fire-and-forget 事件（复用既有 OrderStatusChanged 类型，payload 带 changeType/applied 语义；
      // 数量变更 → MOQ 重算 / 出运聚合重算由订阅方处理）
      publishBusinessEvent({
        type: 'OrderStatusChanged',
        sourceEntityType: 'OrderChangeRequest',
        sourceEntityId: changeRequestId,
        orderId: cr.orderId,
        payload: {
          orderChangeApplied: true,
          changeType: businessType,
          requestNumber: cr.requestNumber,
          applied: result.applied,
          // TODO(cross-domain)：quantity 变更后由 MOQ 校验服务订阅本事件重算豁免缺口；
          // 已有部分出运分配时由出运域订阅重算聚合（OSM-010-C2 联动，当前无既有订阅方）
        },
        actorId: appliedBy,
        transactionId: cr.approvalRequestId ?? cr.id,
      }).catch(() => { /* event publish failure must not fail business */ });

      logger.info('[OrderChange] 变更已生效', { changeRequestId, applied: result.applied, appliedBy });
      return { ok: true, data: result };
    } catch (e: any) {
      if (e?.code === ORDER_CHANGE_ERRORS.ORDER_STATUS_CONFLICT) {
        return fail(ORDER_CHANGE_ERRORS.ORDER_STATUS_CONFLICT, e.message, 409);
      }
      if(e?.code===ORDER_CHANGE_ERRORS.ORDER_SHIPPING_LOCKED||e?.code===ORDER_CHANGE_ERRORS.ORDER_QTY_BELOW_SHIPPED)
        return fail(e.code,e.message,e.statusCode??409);
      if(e?.code===ORDER_CHANGE_ERRORS.CUSTOMER_CONFIRMATION_REQUIRED)
        return fail(ORDER_CHANGE_ERRORS.CUSTOMER_CONFIRMATION_REQUIRED,e.message,e.statusCode??409);
      if(e?.code===ORDER_CHANGE_ERRORS.ORDER_CHANGE_VERSION_MISMATCH)
        return fail(ORDER_CHANGE_ERRORS.ORDER_CHANGE_VERSION_MISMATCH,e.message,e.statusCode??409);
      if(e?.code==='UNAUTHORIZED'||e?.code==='FORBIDDEN'||e?.code==='AUTHORIZATION_UNAVAILABLE')
        return fail(e.code,e.message,e.statusCode??403);
      logger.error('[OrderChange] 变更生效事务失败', { changeRequestId, error: e?.message });
      if(e?.code==='NOT_FOUND')return fail(ORDER_CHANGE_ERRORS.ORDER_NOT_FOUND,'订单不存在或不在当前可操作范围',404);
      if(e?.code==='CONFLICT'||e?.code==='INVALID_INPUT'||e?.code==='UNAUTHORIZED'||e?.code==='FORBIDDEN')return fail(ORDER_CHANGE_ERRORS.ORDER_STATUS_CONFLICT,e.message,e.statusCode??409);
      // B39 / D52：外层 try 与本笔 tx 同段；`recalcOrderAmountFromLines(tx, …)` **传了 tx**
      // ⇒ 金额联动在**事务内**（且有自己的内层 try 降级不阻断）⇒ 唯一业务写 = tx ⇒ 可承诺零改动。
      return fail(ORDER_CHANGE_ERRORS.ORDER_STATUS_CONFLICT, '变更生效未能完成，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对该变更单的明细行与派生金额。', 500);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // syncFromApprovalDecision — 审批决策同步（P0-003 修复）
  //   审批单 approved/rejected 后同步变更申请状态：
  //   - approved → OrderChangeRequest.status: Pending → Approved（业务员随后 apply 生效，两段式语义保留）
  //   - rejected → Pending → Rejected + 订单从 CancelRequested/PauseRequested 恢复申请前状态（时间线回查，同撤回路径）
  //   幂等：仅 Pending 状态处理；找不到关联变更申请（非 OrderChangeRequest 类审批）静默返回。
  // ══════════════════════════════════════════════════════════════════
  async function syncFromApprovalDecision(params: {
    approvalRequestId: string;
    decision: 'approved' | 'rejected';
    decisionNote?: string;
    actorId: string;
  }): Promise<OrderChangeResult<{ changeRequest: any; orderRestoredTo?: string | null; restoreBlocked?: OrderRestoreBlocked | null }>> {
    const { approvalRequestId, decision, decisionNote, actorId } = params;

    const cr = await prisma.orderChangeRequest.findFirst({
      where: { approvalRequestId, deletedAt: null },
    });
    if (!cr || cr.status !== 'Pending') {
      // 非 OrderChangeRequest 类审批 / 已同步（幂等）→ 静默跳过
      return { ok: true, data: { changeRequest: cr } };
    }

    const order = await prisma.order.findUnique({ where: { id: cr.orderId } });
    const schemaType: string = cr.changeTypes?.[0] ?? 'other';
    const isPause = schemaType === 'other' && Boolean((cr as any).attachments?.pause);
    const isCancel = schemaType === 'other' && !isPause;

    // 驳回取消/暂停：恢复申请前状态（时间线回查 fromStatus，与撤回同源逻辑）
    let restoreStatus: string | null = null;
    if (
      decision === 'rejected' && (isCancel || isPause) && order &&
      (order.status === 'CancelRequested' || order.status === 'PauseRequested')
    ) {
      const lastTransition = await prisma.orderStatusTransition.findFirst({
        where: { orderId: order.id, toStatus: order.status },
        orderBy: { createdAt: 'desc' },
      });
      const candidate = lastTransition?.fromStatus ?? null;
      restoreStatus = candidate && !DR010_GUARDED_STATUSES.has(candidate) && candidate !== 'Cancelled' ? candidate : 'Confirmed';
    }
    // ★ A10-①（拍板件 §2.3）：恢复也是"进入某个状态" ⇒ **先跑门禁、通过才写回**。
    //   本处此前是**HTTP 可达、无需审批的免检入口**：直写 `tx.order.update` 把订单写回
    //   `Confirmed` 而**不跑任何门禁**（本函数不走 `transitionOrderStatus` —— 它把
    //   `CancelRequested`/`PauseRequested` 当 DR-010 守卫态直接拒掉）。
    //   ★ 门禁在**事务外**跑：门禁自身会写东西（自动发起豁免审批单），塞进本事务会把
    //     "审批单已建"与"订单已改"绑成一次提交 —— 两者的失败语义不同。
    //   ★ 硬条件 2：`restoreStatus` 的兜底值 `'Confirmed'`（回查不到时间线时写死）由此
    //     一并被门禁罩住 —— 它是 §9 B210 同族病（读不出来就给个看着合理的默认值），
    //     拍板件给的两条路是"补门禁"或"改成显式失败"，此处取前者。
    const restoreGate = restoreStatus
      ? await evaluateOrderRestoreGate({
          prisma, orderId: order!.id, targetStatus: restoreStatus, actorId,
          logScope: 'order-change:approval-reject-restore',
        })
      : null;
    const restoreAllowed = restoreGate === null || restoreGate.allowed;

    try {
      const updated = await prisma.$transaction(async (tx: any) => {
        const now = epochNow();
        const next = await tx.orderChangeRequest.update({
          where: { id: cr.id },
          data: { status: decision === 'approved' ? 'Approved' : 'Rejected' },
        });
        // 驳回 → 订单恢复申请前状态（仅 cancel/pause 有状态迁移）
        // ★ A10-① 硬条件 3：门禁不过时**订单状态不写回**，但变更单**照常**落 Rejected
        //   （驳回是审批人的权利，不该因为订单当前不具备恢复条件而卡住）。
        if (restoreStatus && order && restoreAllowed) {
          await tx.order.update({ where: { id: order.id }, data: { status: restoreStatus, updatedAt: now } });
          await writeExtensionTransition(tx, order.id, order.status, restoreStatus, actorId, `${cr.requestNumber} 审批驳回${decisionNote ? `：${decisionNote}` : ''}`);
        }
        await writeRouteAuditLog({
          prisma: tx, actorId, source: 'service:order-change:approval-sync',
          operation: 'order_change_approval_synced', targetType: 'OrderChangeRequest', targetId: cr.id,
          before: { status: 'Pending' },
          after: {
            status: decision === 'approved' ? 'Approved' : 'Rejected',
            orderRestoredTo: restoreAllowed ? restoreStatus : null,
            // ★ A10-①：被门禁拦下时把**码**留痕 —— 事后看审计要能分清
            //   "本来就没恢复"与"想恢复但被拦了"。
            //   ★ 只留码、不留门禁原文：留痕用码（稳定、可机读），原文走 logger（见下）。
            restoreBlockedBy: restoreAllowed ? null : { code: restoreGate!.code },
            decisionNote: decisionNote ?? null,
          },
        });
        if (restoreStatus && order && restoreGate?.allowed && restoreGate.creditExceptionPass) {
          const pass = restoreGate.creditExceptionPass;
          await consumeCreditException({ exceptionService: pass.service, exceptionId: pass.exception.id, scope: pass.scope, actorId, tx,
            note: `${cr.requestNumber} 审批驳回后订单恢复到 ${restoreStatus}` });
        }
        return next;
      });
      if (!restoreAllowed) {
        // ★ 门禁原文**只进日志**，不内插进对外文案（B30 棘轮：服务层把原文拼进业务文案，只许减不许增）
        logger.warn('[OrderChange] 审批驳回后订单未恢复：当前不具备恢复条件（变更单照常驳回）', {
          approvalRequestId, changeRequestId: cr.id, orderRestoredTo: null,
          blockedCode: restoreGate!.code, blockedReason: restoreGate!.message,
        });
      }
      logger.info('[OrderChange] 审批决策已同步变更申请', { approvalRequestId, decision, changeRequestId: cr.id, orderRestoredTo: restoreAllowed ? restoreStatus : null });
      return {
        ok: true,
        data: {
          changeRequest: updated,
          orderRestoredTo: restoreAllowed ? restoreStatus : null,
          // ★ A10-① 硬条件 3：**变更单照常驳回**，只是订单状态不写回。
          //   文案要说清"不是不让你驳回，是订单当前不具备恢复条件" + 给下一步。
          //   ★ 刻意**不内插**门禁的 `message`（服务层错误文案）：对外给「**原因码**」
          //     （可机读、前端可映射），原文由上面那条 logger.warn 留在服务端。
          restoreBlocked: restoreAllowed ? null : {
            code: restoreGate!.code,
            message: `订单未恢复：当前不具备恢复到「${restoreStatus}」的条件（原因码 ${restoreGate!.code}）。本次驳回已生效，变更单状态为 Rejected；请先处理上述条件后另行恢复订单状态。`,
          },
        },
      };
    } catch (e: any) {
      logger.error('[OrderChange] 审批决策同步失败', { approvalRequestId, decision, error: e?.message });
      if (e instanceof CreditExceptionConsumptionError) return fail(e.code, e.message, e.statusCode);
      // B39 / D52：try 内唯一写 = $transaction⇒ 可承诺零改动。
      return fail(ORDER_CHANGE_ERRORS.ORDER_STATUS_CONFLICT, '审批决策同步未能完成，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对该变更单与订单状态。', 500);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // withdrawChangeRequest — 申请人撤回（仅 Pending，仅本人）
  // ══════════════════════════════════════════════════════════════════
  async function withdrawChangeRequest(params: { changeRequestId: string; actorId: string; actorRoles?: readonly string[]; trustedActor?: TokenPayload }): Promise<OrderChangeResult<{ changeRequest: any; orderRestoredTo?: string | null; restoreBlocked?: OrderRestoreBlocked | null }>> {
    const { changeRequestId, actorId } = params;

    if (!params.trustedActor?.userId || params.trustedActor.userId !== actorId)
      return fail(ORDER_CHANGE_ERRORS.UNAUTHORIZED, '订单变更撤回需要与当前执行主体一致的已核验账号。', 401);
    let currentActor: TokenPayload;
    try {
      currentActor = await currentCustomerConfirmationActor(prisma, params.trustedActor, 'order:change_request:create');
    } catch (error: any) {
      const code = ['UNAUTHORIZED', 'FORBIDDEN', 'AUTHORIZATION_UNAVAILABLE'].includes(error?.code) ? error.code : 'AUTHORIZATION_UNAVAILABLE';
      return fail(code as OrderChangeErrorCode, error?.message ?? '当前订单变更权限暂时无法核验。', error?.statusCode ?? 503);
    }

    const cr = await prisma.orderChangeRequest.findUnique({ where: { id: changeRequestId } });
    if (!cr || cr.deletedAt) {
      return fail(ORDER_CHANGE_ERRORS.CHANGE_REQUEST_NOT_FOUND, `变更申请 ${changeRequestId} 不存在`, 404);
    }
    if (cr.status !== 'Pending') {
      return fail(ORDER_CHANGE_ERRORS.CHANGE_REQUEST_NOT_PENDING, `变更申请当前状态 ${cr.status}，仅 Pending 可撤回`, 409);
    }
    const initialScope = await freshOrderLineScope(prisma, currentActor);
    const order = await prisma.order.findFirst({ where: { id: cr.orderId, deletedAt: null, AND: [initialScope] } });
    if (!order) return fail(ORDER_CHANGE_ERRORS.ORDER_NOT_FOUND, '订单不存在或不在当前可操作范围。', 404);
    // §10.4.1（2026-09-12 定案）：谁提的谁撤 + 领导/老板可撤。
    // 归属型豁免走身份判定（isLeaderPrincipal），不是 scope——销售主管不含在内。
    if (cr.requesterId !== actorId && !isLeaderPrincipal(currentActor.roles)) {
      return fail(ORDER_CHANGE_ERRORS.WITHDRAW_NOT_BY_REQUESTER, '仅申请人本人或领导/老板可撤回变更申请（§10.4.1）', 403);
    }
    const schemaType: string = cr.changeTypes?.[0] ?? 'other';
    const isPause = schemaType === 'other' && Boolean((cr as any).attachments?.pause);
    const isCancel = schemaType === 'other' && !isPause;

    // 恢复申请前状态：从 OrderStatusTransition 时间线回查最近一次进入 取消/暂停申请中 的 fromStatus（审计真源，不污染 beforeSnapshot）
    let restoreStatus: string | null = null;
    if ((isCancel || isPause) && order && (order.status === 'CancelRequested' || order.status === 'PauseRequested')) {
      const lastTransition = await prisma.orderStatusTransition.findFirst({
        where: { orderId: order.id, toStatus: order.status },
        orderBy: { createdAt: 'desc' },
      });
      const candidate = lastTransition?.fromStatus ?? null;
      restoreStatus = candidate && !DR010_GUARDED_STATUSES.has(candidate) && candidate !== 'Cancelled' ? candidate : 'Confirmed';
    }
    // ★ A10-①（拍板件 §2.3）：与「审批驳回」同源 —— 撤回也是"把订单写回某个状态"，
    //   同样**先跑门禁、通过才写回**（本处此前是第二条免检入口）。
    //   硬条件 3：门禁不过时**变更单照常撤回**（撤回是申请人的权利），只是订单状态不写回。
    //   硬条件 4（阳性对照）：造「暂停期间客户被冻结」⇒ 撤回被拒、订单停在 `PauseRequested`、
    //   变更单状态 `Cancelled`、响应里有可读原因 —— 见
    //   `src/orderChanges/__tests__/orderChangeRestoreGate.test.ts`。
    const restoreGate = restoreStatus
      ? await evaluateOrderRestoreGate({
          prisma, orderId: order!.id, targetStatus: restoreStatus, actorId,
          logScope: 'order-change:withdraw-restore',
        })
      : null;
    const restoreAllowed = restoreGate === null || restoreGate.allowed;

    try {
      const updated = await prisma.$transaction(async (tx: any) => {
        const transactionActor = await currentCustomerConfirmationActor(tx, params.trustedActor, 'order:change_request:create');
        if (transactionActor.userId !== actorId) throw businessError('FORBIDDEN', '当前撤回主体与请求账号不匹配。');
        await tx.$queryRawUnsafe('SELECT "id" FROM "Order" WHERE "id"=$1 FOR UPDATE', cr.orderId);
        await tx.$queryRawUnsafe('SELECT "id" FROM "OrderChangeRequest" WHERE "id"=$1 FOR UPDATE', cr.id);
        const currentCr = await tx.orderChangeRequest.findUnique({ where: { id: cr.id } });
        const transactionScope = await freshOrderLineScope(tx, transactionActor);
        const currentOrder = await tx.order.findFirst({ where: { id: cr.orderId, deletedAt: null, AND: [transactionScope] } });
        if (!currentCr || currentCr.deletedAt || currentCr.status !== 'Pending' || currentCr.orderId !== cr.orderId
          || !currentOrder || currentOrder.status !== order.status)
          throw businessError('CONFLICT', '订单或待撤回申请已变化，请刷新后重新核对。');
        if (currentCr.requesterId !== transactionActor.userId && !isLeaderPrincipal(transactionActor.roles))
          throw businessError('FORBIDDEN', '当前账号不是原申请人或有权撤回的领导。');
        const now = epochNow();
        const next = await tx.orderChangeRequest.update({
          where: { id: currentCr.id },
          data: { status: 'Cancelled' },
        });
        // 撤回关联审批单（防止审批人继续处理已撤回的申请）
        if (currentCr.approvalRequestId) {
          await tx.approvalRequest.updateMany({
            where: { id: currentCr.approvalRequestId, status: 'pending' },
            data: { status: 'cancelled', decidedAt: businessNowDate(), decisionNote: `变更申请 ${cr.requestNumber} 已被申请人撤回` },
          });
        }
        // 订单从 取消申请中/暂停申请中 恢复申请前状态
        // ★ A10-① 硬条件 3：门禁不过 ⇒ 订单状态不写回（撤回本身照常生效）
        if (order && restoreStatus && restoreAllowed && (order.status === 'CancelRequested' || order.status === 'PauseRequested')) {
          await tx.order.update({ where: { id: order.id }, data: { status: restoreStatus, updatedAt: now } });
          await writeExtensionTransition(tx, order.id, order.status, restoreStatus, actorId, `${cr.requestNumber} 申请人撤回`);
        }
        await writeRouteAuditLog({
          prisma: tx, actorId, source: 'service:order-change:withdraw',
          operation: 'order_change_withdraw', targetType: 'OrderChangeRequest', targetId: cr.id,
          before: { status: 'Pending' },
          after: {
            status: 'Cancelled',
            orderRestoredTo: restoreAllowed ? restoreStatus : null,
            // ★ 同审批驳回那一处：只留**码**，门禁原文走 logger
            restoreBlockedBy: restoreAllowed ? null : { code: restoreGate!.code },
          },
        });
        if (order && restoreStatus && restoreGate?.allowed && restoreGate.creditExceptionPass &&
          (order.status === 'CancelRequested' || order.status === 'PauseRequested')) {
          const pass = restoreGate.creditExceptionPass;
          await consumeCreditException({ exceptionService: pass.service, exceptionId: pass.exception.id, scope: pass.scope, actorId, tx,
            note: `${cr.requestNumber} 申请人撤回后订单恢复到 ${restoreStatus}` });
        }
        return next;
      });
      if (!restoreAllowed) {
        logger.warn('[OrderChange] 撤回后订单未恢复：当前不具备恢复条件（撤回照常生效）', {
          changeRequestId, actorId, orderRestoredTo: null,
          blockedCode: restoreGate!.code, blockedReason: restoreGate!.message,
        });
      }
      logger.info('[OrderChange] 变更申请已撤回', { changeRequestId, actorId, orderRestoredTo: restoreAllowed ? restoreStatus : null });
      return {
        ok: true,
        data: {
          changeRequest: updated,
          orderRestoredTo: restoreAllowed ? restoreStatus : null,
          // ★ A10-① 硬条件 3：文案要说清「不是不让你撤回，是订单当前不具备恢复条件」+ 给下一步。
          //   ★ 同审批驳回那一处：**不内插**门禁的 `message`（B30 棘轮），对外只给原因码。
          restoreBlocked: restoreAllowed ? null : {
            code: restoreGate!.code,
            message: `订单未恢复：当前不具备恢复到「${restoreStatus}」的条件（原因码 ${restoreGate!.code}）。本次撤回已生效，变更单状态为 Cancelled；请先处理上述条件后另行恢复订单状态。`,
          },
        },
      };
    } catch (e: any) {
      logger.error('[OrderChange] 撤回失败', { changeRequestId, error: e?.message });
      if (e instanceof CreditExceptionConsumptionError) return fail(e.code, e.message, e.statusCode);
      if (e?.code === 'UNAUTHORIZED' || e?.code === 'FORBIDDEN' || e?.code === 'AUTHORIZATION_UNAVAILABLE')
        return fail(e.code as OrderChangeErrorCode, e.message, e.statusCode ?? 403);
      if (e?.code === 'CONFLICT') return fail(ORDER_CHANGE_ERRORS.ORDER_STATUS_CONFLICT, e.message, 409);
      // B39 / D52：try 内唯一写 = $transaction⇒ 可承诺零改动。
      return fail(ORDER_CHANGE_ERRORS.ORDER_STATUS_CONFLICT, '变更申请撤回未能完成，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对该变更单的审批单与订单状态。', 500);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // completeClosing — 结案处理完成（Closing → Cancelled）
  //   §2A.2 步骤 3b：完成供应商、物料、客户责任和财务损益处置后才可关闭
  // ══════════════════════════════════════════════════════════════════
  async function completeClosing(params: { orderId: string; actorId: string; note?: string }): Promise<OrderChangeResult<{ order: any }>> {
    const { orderId, actorId, note } = params;
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.deletedAt) {
      return fail(ORDER_CHANGE_ERRORS.ORDER_NOT_FOUND, `订单 ${orderId} 不存在或已删除`, 404);
    }
    if (order.status !== 'Closing') {
      return fail(ORDER_CHANGE_ERRORS.CLOSING_NOT_REQUIRED, `订单当前状态 ${order.status}，仅「结案处理中」可执行结案完成`, 409);
    }
    try {
      const updated = await prisma.$transaction(async (tx: any) => {
        const now = epochNow();
        const next = await tx.order.update({ where: { id: orderId }, data: { status: 'Cancelled', updatedAt: now } });
        await writeExtensionTransition(tx, orderId, 'Closing', 'Cancelled', actorId, note ?? '结案处置完成（供应商/物料/客户责任/财务损益），订单关闭');
        await writeRouteAuditLog({
          prisma: tx, actorId, source: 'service:order-change:complete-closing',
          operation: 'order_closing_completed', targetType: 'Order', targetId: orderId,
          before: { status: 'Closing' },
          after: { status: 'Cancelled', note: note ?? null },
        });
        return next;
      });
      return { ok: true, data: { order: updated } };
    } catch (e: any) {
      // B39（D51）：本处原本**没有 `logger.error`**（该文件 5 个 B39 站点里只有这处缺）⇒ 先补日志，再换文案。
      // D52 覆盖面：try 内唯一写 = $transaction⇒ 可承诺零改动。
      logger.error('[OrderChange] 结案完成事务失败', { orderId, actorId, error: e?.message });
      return fail(ORDER_CHANGE_ERRORS.ORDER_STATUS_CONFLICT, '订单结案完成未能生效，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对该订单的结案处置记录与状态。', 500);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // checkPauseResumeDue — 暂停到期提醒接入点（scheduler 定期调用）
  //   §2A.3 步骤 3：到期未恢复自动提醒，禁止无限期挂起
  //   返回本次新标记的申请数；提醒投递（通知中心/邮件）由调度层按 resumeReminderFlagged=true 驱动
  // ══════════════════════════════════════════════════════════════════
  async function checkPauseResumeDue(params?: { today?: string }): Promise<{ flagged: number; orderIds: string[] }> {
    const today = params?.today ?? todayLocalKey();
    // Paused 订单 + 暂停申请已 Applied + expectedResumeDate ≤ today + 未标记
    const pausedOrders = await prisma.order.findMany({ where: { status: 'Paused', deletedAt: null }, select: { id: true } });
    if (pausedOrders.length === 0) return { flagged: 0, orderIds: [] };
    const orderIds = pausedOrders.map((o: any) => o.id);

    const dueRequests = await prisma.orderChangeRequest.findMany({
      where: { orderId: { in: orderIds }, status: 'Applied', deletedAt: null },
      orderBy: { appliedAt: 'desc' },
    });
    const flaggedOrderIds: string[] = [];
    for (const cr of dueRequests) {
      const pause = (cr as any).attachments?.pause;
      if (!pause?.expectedResumeDate || pause.resumeReminderFlagged) continue;
      if (pause.expectedResumeDate <= today) {
        await prisma.orderChangeRequest.update({
          where: { id: cr.id },
          data: {
            attachments: {
              ...((cr as any).attachments ?? {}),
              pause: { ...pause, resumeReminderFlagged: true, resumeReminderFlaggedAt: businessNowDate().toISOString() },
            } as any,
          },
        });
        flaggedOrderIds.push(cr.orderId);
      }
    }
    if (flaggedOrderIds.length > 0) {
      // 提醒投递（通知中心/邮件/升级 T+7 总领导）由调度层消费本函数返回值驱动；
      // BusinessEventType 联合类型属事件总线跨域所有权，本域不新增事件类型
      logger.warn('[OrderChange] 暂停到期未恢复，已标记提醒', { orderIds: flaggedOrderIds });
    }
    return { flagged: flaggedOrderIds.length, orderIds: flaggedOrderIds };
  }

  // ══════════════════════════════════════════════════════════════════
  // listChangeRequests / getChangeRequest — 只读查询（与 orderChangeRoute GET 同一合约真源）
  //   Agent 只读工具与路由共用本入口；纯查询，不触发审批链、不写库
  // ══════════════════════════════════════════════════════════════════
  async function listChangeRequests(filter: {
    orderId?: string;
    status?: string;
    requesterId?: string;
    limit?: number;
    trustedActor?: TokenPayload | null;
  }): Promise<{ items: any[] }> {
    const access = await loadOrderQueryReadAccess(prisma, { actor: filter.trustedActor });
    if (filter.limit !== undefined && (!Number.isSafeInteger(filter.limit) || filter.limit <= 0))
      throw businessError('INVALID_INPUT', '变更申请读取数量须为正整数。');
    const limit = Math.min(filter.limit ?? 100, 500);
    const where: any = { deletedAt: null };
    if (filter.orderId) where.orderId = filter.orderId;
    if (filter.status) where.status = filter.status;
    if (filter.requesterId) where.requesterId = filter.requesterId;
    const items: any[] = [];
    for (let skip = 0; items.length < limit; skip += 100) {
      const candidates = await prisma.orderChangeRequest.findMany({ where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100, skip });
      for (const candidate of candidates) {
        if (await readCompleteOrderChangeSource(prisma, candidate, access)) items.push(candidate);
        if (items.length === limit) break;
      }
      if (candidates.length < 100) break;
    }
    await finishOrderChangeRead(prisma, access, filter.trustedActor, items);
    return { items };
  }

  async function getChangeRequest(id: string, trustedActor?: TokenPayload | null): Promise<{ item: any | null }> {
    const access = await loadOrderQueryReadAccess(prisma, { actor: trustedActor });
    const item = await prisma.orderChangeRequest.findUnique({ where: { id } });
    if (!item || item.deletedAt) return { item: null };
    const source = await readCompleteOrderChangeSource(prisma, item, access);
    if (!source) return { item: null };
    const order = source.order, approvalRequest = source.approval;
    const successor = await prisma.orderChangeRequest.findFirst({ where: { revisionOfId: id, deletedAt: null } as any,
      orderBy: { createdAt: 'desc' } });
    const readableSuccessor = successor && successor.orderId === item.orderId
      && await readCompleteOrderChangeSource(prisma, successor, access) ? successor : null;
    const revisionSuccessor = readableSuccessor ? { id: readableSuccessor.id,
      requestNumber: readableSuccessor.requestNumber, status: readableSuccessor.status,
      createdAt: readableSuccessor.createdAt } : null;
    const approvalSummary = approvalRequest ? {
      ...Object.fromEntries(['id', 'requesterId', 'actionType', 'targetType', 'targetId', 'status',
        'reviewerId', 'decidedAt', 'decisionNote'].map(key => [key, approvalRequest[key]])),
      reviewContentVersion: approvalReviewContentVersion(approvalRequest),
    } : null;
    await finishOrderChangeRead(prisma, access, trustedActor, [item, ...(readableSuccessor ? [readableSuccessor] : [])]);
    return { item: { ...item, order, approvalRequest: approvalSummary, revisionSuccessor } };
  }

  decisionService = createApprovalDecisionService(prisma, { onDecided: async decision => {
    if (decision.targetType === 'OrderChangeRequest' && decision.actionType === 'order:change') {
      await syncFromApprovalDecision({ approvalRequestId: decision.id, decision: decision.status, actorId: decision.actualDecisionActor });
    }
  } });

  return {
    createChangeRequest,
    previewChangeRequestAmendment,
    reviseRejectedChangeRequest,
    amendAndApproveChangeRequest,
    applyChangeRequest,
    syncFromApprovalDecision,
    withdrawChangeRequest,
    completeClosing,
    checkPauseResumeDue,
    listChangeRequests,
    getChangeRequest,
  };
}

export type OrderChangeRequestService = ReturnType<typeof createOrderChangeRequestService>;

// ───────────────────────────────────────────────────────────────────
// B1 直接取消订单（2026-09-18 · 零基础障碍清单 B1）
//
// 设计真源：订单变更规则.md §2A.1 ——
//   | 草稿/待审批（Pending） | 变更：业务员可直接修改/撤回 | **取消/暂停：业务员可直接取消/暂停** |
// 此前三条路全堵（acceptance-pending-cancel-path.mjs S2/S3/S4 实测）：
//   ① DR-010 变更链拒 Pending（ORDER_NOT_APPROVED）② 6 态状态机不含 Cancelled
//   ③ DELETE 是高危角色门（业务员 403）⇒ 「刚下单还没投产就取消」这一**最常见**
//   场景零路径。本函数补的就是这条路 —— **不把 Pending 塞进审批链**（与 §2A.1 一致）。
//
// 口径：
//   - 仅 status='Pending'（未确认 = 无正式承诺）可直接取消；Confirmed 及以后走 DR-010 取消链。
//   - fail-closed 依赖守卫：已有采购单/出运分配/发票/收款凭证的订单**不可直接取消**
//   （存在这些 = 已发生真实业务事实，必须先处置它们，或走 DR-010 取消审批链）。
//   - 留痕三件套（同一事务）：Order.status → Cancelled + OrderStatusTransition（note=理由，
//     详情页时间线可见）+ AuditLog；事务提交后 fire-and-forget 发布 OrderStatusChanged。
// ───────────────────────────────────────────────────────────────────

export const DIRECT_CANCEL_ERRORS = {
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  ORDER_ALREADY_DELETED: 'ORDER_ALREADY_DELETED',
  ORDER_NOT_PENDING: 'ORDER_NOT_PENDING',
  ORDER_HAS_DEPENDENTS: 'ORDER_HAS_DEPENDENTS',
  REASON_REQUIRED: 'REASON_REQUIRED',
  CANCEL_FAILED: 'CANCEL_FAILED',
} as const;

export type DirectCancelErrorCode = (typeof DIRECT_CANCEL_ERRORS)[keyof typeof DIRECT_CANCEL_ERRORS];

export interface DirectCancelResult {
  ok: boolean;
  error?: { code: DirectCancelErrorCode; message: string; statusCode: number };
  data?: { order: any; transitionId: string; auditId: string };
}

/** 错误码 → HTTP 状态码（真源收口，防第四次「漏码兜 500」） */
export const DIRECT_CANCEL_ERROR_HTTP_STATUS: Record<DirectCancelErrorCode, number> = {
  ORDER_NOT_FOUND: 404,
  ORDER_ALREADY_DELETED: 409,
  ORDER_NOT_PENDING: 409,
  ORDER_HAS_DEPENDENTS: 409,
  REASON_REQUIRED: 400,
  CANCEL_FAILED: 500,
};

export async function directCancelPendingOrder(
  prisma: PrismaClient,
  orderId: string,
  reason: string,
  actorId: string,
): Promise<DirectCancelResult> {
  if (!reason?.trim()) {
    return { ok: false, error: { code: DIRECT_CANCEL_ERRORS.REASON_REQUIRED, message: '取消必须填写理由（将留痕到订单时间线）', statusCode: 400 } };
  }

  const existing = await prisma.order.findUnique({ where: { id: orderId } });
  if (!existing) {
    return { ok: false, error: { code: DIRECT_CANCEL_ERRORS.ORDER_NOT_FOUND, message: `订单 ${orderId} 不存在`, statusCode: 404 } };
  }
  if (existing.deletedAt) {
    return { ok: false, error: { code: DIRECT_CANCEL_ERRORS.ORDER_ALREADY_DELETED, message: `订单 ${orderId} 已删除`, statusCode: 409 } };
  }
  if (existing.status !== 'Pending') {
    return {
      ok: false,
      error: {
        code: DIRECT_CANCEL_ERRORS.ORDER_NOT_PENDING,
        message: `仅「待确认（Pending）」订单可由业务员直接取消；当前状态「${existing.status}」已确认执行，请走「取消订单申请」审批链（DR-010）`,
        statusCode: 409,
      },
    };
  }

  try {
    const result = await prisma.$transaction(async (tx: any) => {
      const now = BigInt(Date.now());
      // 事务内复读（防并发窗口：读到 Pending 后订单被确认/推进）
      const fresh = await tx.order.findUnique({ where: { id: orderId } });
      if (!fresh || fresh.deletedAt) {
        throw Object.assign(new Error(`订单 ${orderId} 不存在或已删除`), { code: DIRECT_CANCEL_ERRORS.ORDER_NOT_FOUND, statusCode: 404 });
      }
      if (fresh.status !== 'Pending') {
        throw Object.assign(new Error(`订单已推进到「${fresh.status}」，不可直接取消（请走取消申请审批链）`), { code: DIRECT_CANCEL_ERRORS.ORDER_NOT_PENDING, statusCode: 409 });
      }

      // fail-closed 依赖守卫：有任何真实业务事实 → 不允许「直接」取消，避免静默弃单。
      // ★ v2.49 复核 I-3：这条与 `deleteOrder` 的守卫**本来就是同一件事的两次手写**，而它比那边还少两路
      //   —— 旧注释写"与 deleteOrder 五路同口径"时 deleteOrder 已是六路，且这条从来没有 `shipment.count`
      //   （只查了 `shipmentOrderAllocation`：合票时代走分配表，但**单票直连的出运**不落在分配表里）
      //   ⇒ 一个挂着已出运批次的单可以被"直接取消"，正好造出 deleteOrder 这条线要防的那个孤儿
      //     （`L3IssueInvoice.ts:76` / `dunningStageService.ts:100,142` 都按 `{orderId, deletedAt: null}` 读活批次）。
      //   现补齐两路，并照 deleteOrder 的口径**只把"已发生事实"算依赖**（`planned` 不算，见下）。
      // ⚠️ 两处仍是两份手写清单（第七路要改两个文件）——合并成一份真源属结构改造，已登记为待办，不在本批顺手做。
      // ⚠️ 另一个**未定口径**：取消要不要把 `planned` 批次一起级联？删除是"这单不存在了"，取消是"这单别再往下走"，
      //    两者对计划行的语义未必相同 ⇒ 属业务判断，挂给 Kevin，不擅自动（见台账 §2 G4.4 / §12.1）。
      const [poCount, invoiceCount, invoiceAllocCount, shipmentCount, shipmentAllocCount, voucherCount, executedBatchCount] = await Promise.all([
        tx.purchaseOrder.count({ where: { orderId, deletedAt: null } }),
        tx.invoice.count({ where: { orderId, deletedAt: null } }),
        tx.invoiceOrderAllocation.count({ where: { orderId, deletedAt: null } }),
        tx.shipment.count({ where: { orderId, deletedAt: null } }),
        tx.shipmentOrderAllocation.count({ where: { orderId } }),
        tx.paymentVoucher.count({ where: { orderId, deletedAt: null } }),
        tx.orderShipmentBatch.count({ where: { orderId, deletedAt: null, status: { not: 'planned' } } }),
      ]);
      if (poCount > 0 || invoiceCount > 0 || invoiceAllocCount > 0 || shipmentCount > 0 || shipmentAllocCount > 0 || voucherCount > 0 || executedBatchCount > 0) {
        const deps: string[] = [];
        if (poCount > 0) deps.push(`采购单 ${poCount} 张`);
        if (invoiceCount > 0) deps.push(`发票 ${invoiceCount} 张`);
        if (invoiceAllocCount > 0) deps.push(`开票分摊 ${invoiceAllocCount} 条`);
        if (shipmentCount > 0) deps.push(`出运单 ${shipmentCount} 张`);
        if (shipmentAllocCount > 0) deps.push(`出运分配 ${shipmentAllocCount} 条`);
        if (voucherCount > 0) deps.push(`收款凭证 ${voucherCount} 笔`);
        if (executedBatchCount > 0) deps.push(`已出运/已取消批次 ${executedBatchCount} 批`);
        throw Object.assign(
          new Error(`订单已挂有业务事实（${deps.join('、')}），不可直接取消 —— 请先处置这些单据，或走「取消订单申请」审批链（DR-010）`),
          { code: DIRECT_CANCEL_ERRORS.ORDER_HAS_DEPENDENTS, statusCode: 409 },
        );
      }

      const updated = await tx.order.update({
        where: { id: orderId },
        data: { status: 'Cancelled', updatedAt: now },
      });

      // 留痕一：状态时间线（详情页可见，note=取消理由）
      const transitionId = `OST_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await tx.orderStatusTransition.create({
        data: {
          id: transitionId, orderId,
          fromStatus: 'Pending', toStatus: 'Cancelled',
          note: reason.trim(), operator: actorId || 'api', lineId: null, createdAt: now,
        },
      });

      // 留痕二：审计日志
      const auditId = await writeRouteAuditLog({
        prisma: tx, actorId: actorId || 'api', source: 'route:order:direct-cancel',
        operation: 'cancel_order_direct', targetType: 'Order', targetId: orderId,
        before: { status: 'Pending' },
        after: { status: 'Cancelled', reason: reason.trim(), transitionId },
      });

      return { order: updated, transitionId, auditId };
    });

    // 事务提交后发事件（fire-and-forget，与 transitionOrderStatus 同模式）
    publishBusinessEvent({
      type: 'OrderStatusChanged',
      sourceEntityType: 'Order',
      sourceEntityId: orderId,
      orderId,
      payload: { poNumber: result.order.poNumber, fromStatus: 'Pending', toStatus: 'Cancelled', transitionId: result.transitionId },
      actorId: actorId || 'api',
      transactionId: result.transitionId,
    }).catch(() => { /* event publish failure must not fail business */ });

    return { ok: true, data: result };
  } catch (e: any) {
    if (e.code) {
      return { ok: false, error: { code: e.code, message: e.message, statusCode: e.statusCode ?? DIRECT_CANCEL_ERROR_HTTP_STATUS[e.code as DirectCancelErrorCode] ?? 500 } };
    }
    return { ok: false, error: { code: DIRECT_CANCEL_ERRORS.CANCEL_FAILED, message: `直接取消事务失败：${String(e?.message ?? e)}`, statusCode: 500 } };
  }
}
