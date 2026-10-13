/**
 * shipmentEligibilityGate.ts — 出运放行资格门禁（shipping 域统一消费点）
 *
 * 设计真源：
 *   - DR-012：面料船样（S/S）客户确认是标准发货门禁（未确认正常路径一律阻断）
 *   - DR-014：面料大货 QC ∥ S/S 客户确认 ∥ RC 客户确认 三条件并行（缺任一即不具备资格）
 *   - REL-14-A4：服装链出运门禁 = 大货终期 Final QC（与样品 QC 严格独立）
 *   - DR-016：合票（ShipmentOrderAllocation）——一票多订单，逐订单校验
 *   - DR-013：受控例外（targetType='Order' + action='shipment:release'，例外不改变原门禁状态）
 *
 * 消费模式（与 samples 域 assertFabricShipmentGate 同一 SDK 范式）：
 *   1. 逐订单做原始资格判定（qcService，不感知例外）；
 *   2. 全部具备资格 → passedVia='gate' 放行（不触碰例外，一次性例外不被无意核销）；
 *   3. 任一不具备资格 → 对该订单查「Order + shipment:release」生效例外：
 *      - 例外精确命中 → 该订单 via='exception' 放行（携带例外摘要，供徽标展示/审计）；
 *      - 无生效例外 → 聚合抛出 GATE_BLOCKED（409，blockingReasons 带订单维度 + exceptionEntryHint）。
 *
 * 边界语义：
 *   - 无订单锚点的运单（散货，orderIds 为空）→ 无门禁语义，直接放行；
 *   - 订单不存在/已删除 → 视同不具备资格（fail-closed，NOT_FOUND 维度阻断）；
 *   - 非面料非服装订单（Other）→ 无出运门禁定义，放行；
 *   - 例外核销（consumeException）不在本层：一次性例外在 maxUses/validUntil 内对同订单分批出运保持有效，
 *     核销时机待总控裁决（登记遗留项，与 samples 域现状一致）。
 */

import { createQcService, type ShipmentBatchFinalOutcome } from '../qc/qcService';
import { isFabricChainOrder, isGarmentChainOrder } from '../qc/qcChainService';
import { evaluateLcGateForOrder } from '../customs/lcGate';
import { evaluateDepositGateForOrder } from '../orders/depositGate';
import {
  assertGateOrThrow,
  bindExceptionChecker,
  GateBlockedError,
  GATE_BLOCKED,
  EXCEPTION_ENTRY_HINT,
  type ActiveExceptionSummary,
  type ExceptionChecker,
  type ExceptionInactiveReason,
} from '../exceptions/exceptionGate';

export const SHIPMENT_RELEASE_GATE = 'shipment_release' as const;
/** DR-013 例外 scope 动作标识（EXC 创建时 scope.action 必须与此精确一致） */
export const SHIPMENT_RELEASE_ACTION = 'shipment:release' as const;

export type ShipmentGateChain = 'fabric' | 'garment' | 'other' | 'not_found';

export interface OrderShipmentGateOutcome {
  orderId: string;
  /** 链分派结果；not_found = 订单不存在/已删除（fail-closed 视同不具备资格） */
  chain: ShipmentGateChain;
  /** 原始门禁是否具备资格（不感知例外） */
  eligible: boolean;
  /** 原始阻断原因码（面料三条件 / 服装 Final QC / ORDER_NOT_FOUND） */
  blockingReasons: string[];
  /** 最终放行通道（仅聚合通过时有值）：gate=正常资格，exception=DR-013 例外放行 */
  via?: 'gate' | 'exception';
  /** via='exception' 时的生效例外摘要（供「DR-013 例外放行」徽标与审计） */
  exception?: ActiveExceptionSummary;
  /** Only supplied by the locked modern physical-allocation consumer. */
  productionBatchIds?: string[];
  /** Exact current Final evidence; absent for legacy/Other chain calls. */
  physicalBatches?: ShipmentBatchFinalOutcome[];
  /** Missing source/scope identity cannot be supplied by an Order exception. */
  nativeSampleProofBlocked?: boolean;
  nativeSampleFailureReasons?: string[];
}

export interface ShipmentReleaseGateBlockedError {
  code: typeof GATE_BLOCKED;
  message: string;
  /** 聚合阻断原因（`{orderId}:{reason}` 维度，合票场景可区分订单） */
  blockingReasons: string[];
  /** 逐订单判定明细（含例外查询结论） */
  orders: OrderShipmentGateOutcome[];
  /** 首个无例外订单的例外查询结论（无申请/未批准/已过期/已核销） */
  exceptionReason?: ExceptionInactiveReason;
  exceptionEntryHint: typeof EXCEPTION_ENTRY_HINT;
}

/** 订单存在性是先决条件（404 语义），不聚合进门禁阻断 */
export interface ShipmentReleaseGateOrderNotFoundError {
  code: 'ORDER_NOT_FOUND';
  message: string;
  orderIds: string[];
}

export type ShipmentReleaseGateError = ShipmentReleaseGateBlockedError | ShipmentReleaseGateOrderNotFoundError;

export type ShipmentReleaseGateResult =
  | { ok: true; data: { orders: OrderShipmentGateOutcome[] } }
  | { ok: false; error: ShipmentReleaseGateError };

/**
 * 出运放行资格判定（目标状态 = Shipped 时由 mutationService 调用）。
 * @param prisma 可为事务 client（与调用方同事务读，fail-closed）
 * @param orderIds 主订单 + 合票分配订单（函数内去重、过滤空值）
 * @param exceptionChecker DR-013 例外查询器（exceptionService.hasActiveException）；
 *                         缺省/null → 无例外放行能力（fail-closed，隐藏旁路禁止）
 */
export async function evaluateShipmentReleaseGate(params: {
  prisma: any;
  orderIds: Array<string | null | undefined>;
  at?: Date;
  exceptionChecker?: ExceptionChecker | null;
  /** Trusted, already locked/validated physical allocation identities. Omission
   * preserves the whole-order legacy contract; missing/empty entries cannot do so. */
  physicalBatchIdsByOrder?: Record<string, string[]>;
}): Promise<ShipmentReleaseGateResult> {
  const { prisma, at, exceptionChecker } = params;
  const orderIds = [...new Set(params.orderIds.filter((id): id is string => !!id?.trim()))];
  const physicalMode = params.physicalBatchIdsByOrder !== undefined;
  const batchesByOrder: Record<string, string[]> = {};
  if (physicalMode) {
    const missing = orderIds.filter(orderId => {
      const ids = params.physicalBatchIdsByOrder?.[orderId];
      if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id.trim())) return true;
      batchesByOrder[orderId] = [...new Set(ids)].sort();
      return false;
    });
    // Identity is a prerequisite, not a waivable Order business gate. No
    // exception lookup can replace a missing physical allocation scope.
    if (!orderIds.length || missing.length) {
      return { ok: false, error: { code: GATE_BLOCKED,
        message: '须先核对本次出运的实际生产批次，不能以整单资格替代缺失的物理来源。',
        blockingReasons: missing.length ? missing.map(id => `${id}:PHYSICAL_BATCH_SCOPE_REQUIRED`) : ['PHYSICAL_BATCH_SCOPE_REQUIRED'],
        orders: [], exceptionEntryHint: EXCEPTION_ENTRY_HINT } };
    }
  }

  // 无订单锚点（散货运单）→ 无门禁语义
  if (orderIds.length === 0) {
    return { ok: true, data: { orders: [] } };
  }

  const qc = createQcService(prisma);
  const checkOrderRelease = exceptionChecker
    ? bindExceptionChecker(exceptionChecker, { targetType: 'Order', action: SHIPMENT_RELEASE_ACTION })
    : null;

  // ── 1. 逐订单原始资格判定（不感知例外） ──
  const outcomes: OrderShipmentGateOutcome[] = [];
  const notFoundIds: string[] = [];
  for (const orderId of orderIds) {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.deletedAt !== null) {
      // 订单存在性是先决条件（404 语义），不参与门禁聚合
      notFoundIds.push(orderId);
      outcomes.push({
        orderId,
        chain: 'not_found',
        eligible: false,
        blockingReasons: ['ORDER_NOT_FOUND'],
      });
      continue;
    }

    // ★ G-4（矩阵 :137/:141）：L/C 门禁与链门禁**并联**——
    //   装运前核对信用证有效期 / 最迟装运期 / 不符点（Discrepant 阻断发运），
    //   原因合并进同一份 blockingReasons ⇒ 例外放行仍走这条订单已有的 DR-013 scope（shipment:release），
    //   **不另造一套例外机制**（矩阵原话）。Other 类型订单没有链门禁，但信用证照样要卡 ⇒ 三条链都合并。
    const lcElig = await evaluateLcGateForOrder({ prisma, orderId, order, stage: 'shipment:release', at });
    // ★ D3（2026-09-30 补齐，矩阵 D3 拍板）：T/T **未收足定金不得发运**，与 L/C 门禁并联同一份
    //   blockingReasons ⇒ 例外放行仍走这条订单已有的 DR-013 scope（shipment:release），不另造机制。
    //   ⓘ 只管 T/T（L/C 走自己的门禁，O/A·D/P·D/A 未拍板 ⇒ 不越权）；
    //   ⓘ 未录定金比例 ⇒ 不适用（不拦），但**绝不**显示成"已通过"。
    const depElig = await evaluateDepositGateForOrder(prisma, { orderId, order });
    const withLc = (o: OrderShipmentGateOutcome): OrderShipmentGateOutcome => ({
      ...o,
      ...(physicalMode ? { productionBatchIds: batchesByOrder[orderId] } : {}),
      eligible: o.eligible && lcElig.eligible && depElig.satisfied,
      blockingReasons: [
        ...o.blockingReasons,
        ...(lcElig.blockingReasons ?? []),
        ...(depElig.applicable && !depElig.satisfied ? ['DEPOSIT_INSUFFICIENT'] : []),
      ],
    });

    if (isFabricChainOrder(order)) {
      // DR-012/014：面料三条件并行（bulkQc ∥ S/S ∥ RC）
      const eligibility = await qc.checkShipmentEligibility(orderId, physicalMode ? batchesByOrder[orderId] : undefined);
      outcomes.push(withLc({
        orderId,
        chain: 'fabric',
        eligible: eligibility.eligible,
        blockingReasons: eligibility.missingGates,
        ...(eligibility.nativeSampleProofBlocked ? { nativeSampleProofBlocked: true,
          nativeSampleFailureReasons: eligibility.nativeSampleFailureReasons ?? [] } : {}),
        ...(eligibility.physicalBatches ? { physicalBatches: eligibility.physicalBatches } : {}),
      }));
      continue;
    }

    if (isGarmentChainOrder(order)) {
      // REL-14-A4：服装大货终期 Final QC 单条件
      const eligibility = await qc.checkGarmentShipmentEligibility(orderId, physicalMode ? batchesByOrder[orderId] : undefined);
      outcomes.push(withLc({
        orderId,
        chain: 'garment',
        eligible: eligibility.eligible,
        blockingReasons: eligibility.missingGates,
        ...(eligibility.physicalBatches ? { physicalBatches: eligibility.physicalBatches } : {}),
      }));
      continue;
    }

    // Other 类型订单无出运门禁定义 → 链门禁放行，但 L/C 仍生效（上面已合并）
    outcomes.push(withLc({ orderId, chain: 'other', eligible: true, blockingReasons: [] }));
  }

  // ── 2. 订单不存在 → 404 先决条件失败（不走门禁聚合，不查例外） ──
  if (notFoundIds.length > 0) {
    return {
      ok: false,
      error: {
        code: 'ORDER_NOT_FOUND',
        message: `订单 ${notFoundIds.join(', ')} 不存在或已删除，无法判定出运放行资格`,
        orderIds: notFoundIds,
      },
    };
  }

  // ── 3. 全部具备资格 → 正常放行（不触碰例外） ──
  const blocked = outcomes.filter((o) => !o.eligible);
  if (blocked.length === 0) {
    for (const o of outcomes) o.via = 'gate';
    return { ok: true, data: { orders: outcomes } };
  }

  const unresolvedNative = blocked.filter(outcome => outcome.nativeSampleProofBlocked);
  if (unresolvedNative.length) {
    return { ok: false, error: { code: GATE_BLOCKED,
      message: '本次出运的样品来源、覆盖范围或原件依据尚未核实，请先核对对应样品业务记录。订单例外不能替代实际来源证明。',
      blockingReasons: unresolvedNative.flatMap(outcome =>
        (outcome.nativeSampleFailureReasons?.length ? outcome.nativeSampleFailureReasons : outcome.blockingReasons)
          .map(reason => `${outcome.orderId}:${reason}`)),
      orders: outcomes, exceptionEntryHint: EXCEPTION_ENTRY_HINT } };
  }

  // ── 4. 不具备资格订单逐单查 DR-013 例外 ──
  const failures: Array<{ outcome: OrderShipmentGateOutcome; error: GateBlockedError }> = [];
  for (const outcome of blocked) {
    try {
      const pass = await assertGateOrThrow(
        {
          eligible: false,
          gate: SHIPMENT_RELEASE_GATE,
          blockingReasons: outcome.blockingReasons,
          message: `订单 ${outcome.orderId} 出运放行门禁未通过（${outcome.blockingReasons.join(', ')}）`,
        },
        checkOrderRelease
          ? () => checkOrderRelease(outcome.orderId, at)
          : { active: false, reason: 'NO_ACTIVE_EXCEPTION' },
      );
      if (pass.passedVia === 'exception') {
        outcome.via = 'exception';
        outcome.exception = pass.exception;
      }
    } catch (e) {
      if (e instanceof GateBlockedError) {
        failures.push({ outcome, error: e });
      } else {
        throw e;
      }
    }
  }

  if (failures.length > 0) {
    const first = failures[0].error;
    return {
      ok: false,
      error: {
        code: GATE_BLOCKED,
        message:
          `出运放行门禁未通过：${failures.map((f) => f.error.message.split('。')[0]).join('；')}` +
          `。${EXCEPTION_ENTRY_HINT}`,
        blockingReasons: failures.flatMap((f) =>
          f.outcome.blockingReasons.map((r) => `${f.outcome.orderId}:${r}`)),
        orders: outcomes,
        exceptionReason: first.exceptionReason,
        exceptionEntryHint: EXCEPTION_ENTRY_HINT,
      },
    };
  }

  // 全部不具备资格订单均经例外放行（正常资格订单 via='gate' 保持未标记 → 统一补标）
  for (const o of outcomes) if (!o.via) o.via = 'gate';
  return { ok: true, data: { orders: outcomes } };
}
