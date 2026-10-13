/**
 * shortShipmentGate.ts — **短装（少做）门禁**（2026-09-29 晚）
 *
 * 设计真源：`docs/inventory/短装拦截-设计-2026-09-29.md`
 * 使用方口径（逐字提炼）：
 *   「**短产也是属于业务上一个比较大的问题**，通常要跟客户去确认，所以**肯定是要先拦的**…
 *     就是要**卡住**，卡住要等**业务员那边确认了**，**客人那边沟通下来同意了**，然后你这边**才能发货**。」
 *   「短装的情况**反映给客户** → 客户确认**能够少发货** → 我们这边**才能确认这笔大货能够出运** → 才能发出去 → 才能结。」
 *   放行留痕 = **走审批单**（2026-09-29 20:36 追加拍板）——不是"只写说明+附件"，也不是"只提醒不卡"。
 *
 * ── 三条硬口径（错一条就会误拦或漏拦） ──
 *  ① ★★ **只在"该行出运收尾"时判**：分批出运时，第一票必然少于合同量 ⇒
 *     若每次分配都判下界，**第一票就会被误拦**（合同 10000 分 3 票，第一票 3000 就低于下限 9500）。
 *     ⇒ 本文件的收尾判据 = 「该行**不存在**其它"未取消且未发运"的票」（本票除外，因为本票正要变成已发运）。
 *  ② ★★ **公差 pct 与溢装共用同一套取数链**（行级覆盖 → 客户标准 P0 → 已录我方标准 → 出厂默认 → 未判定）。
 *     若短装另取一套，就会出现"允许 ±1% 却拦了 −3%"这种自相矛盾（本仓 G6.3 多套并行真源）。
 *  ③ ★★ **已发量不许另写第二份累计** ⇒ 直接用真源 `OrderLine.shipmentQuantity`
 *     （由 `shared/orderLineShippedQty.ts` 在每次分配增删改/票取消时刷新）。
 *     ⓘ 该字段的口径是「Σ 分配（排除已取消票）」，**Draft 票的分配也算数**（见 `shared/shippingLock.ts` 的注释）；
 *       而我们只在"该行所有非取消票都已发运"时才判 ⇒ 判定那一刻两种口径**恰好重合**。
 *
 * ── ★★ D83：阻断时创建的审批单**必须写在事务之外** ──
 *   若在事务里创建审批单再抛错 ⇒ 事务回滚把审批单一起带走 ⇒ 屏幕上那句"已为你发起短装确认单"是**假话**
 *   （B50-1b 的既有教训）。所以本文件把两件事分开：
 *     · `evaluateShortShipment` —— **只读**，事务内跑，产出"谁被挡、谁已获批"；
 *     · `requestShortShipApproval` —— **写在事务外**，由调用方的 catch 分支调用。
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import { isShipmentCancelled, isShipmentShipped } from '../shared/shippingLock';
import { httpStatusOfCode } from '../shared/errorCodes';
import {
  gateToleranceOf,
  loadToleranceStandards,
  resolveLineTolerance,
  type ToleranceSource,
} from '../orders/toleranceStandardService';

/** 短装放行审批单的动作名（★ 与 MOQ 豁免 `order:moq-exemption` 同形，但按**行**挂） */
export const SHORT_SHIP_APPROVAL_ACTION = 'order:short-ship-exemption';
/** 门禁阻断时抛出的错误码（已登记进 `shared/errorCodes`，档位 409 = 与资源当前状态冲突） */
export const SHORT_SHIP_BLOCKED_CODE = 'ORDER_LINE_SHORT_SHIPPED';

// ───────────────────────────────────────────────────────────────────
// 纯判定
// ───────────────────────────────────────────────────────────────────

export type ShortShipDecisionKind =
  /** 该行还没收尾（还有未发运的票）⇒ **不判** */
  | 'not_closed'
  /** 已收尾且发够了 */
  | 'ok'
  /** 已收尾且**少发** ⇒ 拦 */
  | 'blocked';

export interface ShortShipDecisionInput {
  /** 合同量（订单行 quantity） */
  contractQty: number;
  /** 该行累计已（分配）出运量 —— 真源 `OrderLine.shipmentQuantity` */
  shippedQty: number;
  /** 与溢装同一套标准链取到的百分比（未判定时为 0，与门禁同口径） */
  tolerancePct: number;
  /** 该行是否还有其它"未取消且未发运"的票 */
  hasRemainingUnshipped: boolean;
}

export interface ShortShipDecision {
  kind: ShortShipDecisionKind;
  /** 允许下限 = 合同量 × (1 − pct/100) */
  allowedMin: number;
  /** 差了多少（`blocked` 时 > 0；否则 0） */
  shortage: number;
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * ★ **纯函数**：短装判定（口径唯一出处）。
 * ★ 边界：`hasRemainingUnshipped` 为真 ⇒ **一律不判**（哪怕是 −50%）——
 *   那是"还没发完"，不是"少发"。把两者混起来就是本仓最忌讳的"用正确的数回答错误的问题"。
 */
export function decideShortShipment(input: ShortShipDecisionInput): ShortShipDecision {
  const contractQty = Number(input.contractQty);
  const shippedQty = Number(input.shippedQty);
  const pct = Number(input.tolerancePct);
  const safePct = Number.isFinite(pct) && pct >= 0 ? pct : 0;
  if (!Number.isFinite(contractQty) || contractQty <= 0) {
    // 合同量非法 ⇒ 判不了（调用方本就不该走到这里）；`not_closed` 是"不判"的安全出口
    return { kind: 'not_closed', allowedMin: 0, shortage: 0 };
  }
  const allowedMin = round4(contractQty * (1 - safePct / 100));
  if (input.hasRemainingUnshipped) return { kind: 'not_closed', allowedMin, shortage: 0 };
  const shipped = Number.isFinite(shippedQty) ? shippedQty : 0;
  // ★ 容差：`shippedQty + 1e-6 >= allowedMin`（浮点/Decimal 折数后不许因 1e-12 的误差误拦）
  if (shipped + 1e-6 >= allowedMin) return { kind: 'ok', allowedMin, shortage: 0 };
  return { kind: 'blocked', allowedMin, shortage: round4(allowedMin - shipped) };
}

// ───────────────────────────────────────────────────────────────────
// 事务内：收集本票涉及的行的短装情况（**只读**）
// ───────────────────────────────────────────────────────────────────

export interface ShortShipCase {
  orderLineId: string;
  orderId: string;
  itemNo: string | null;
  unit: string | null;
  contractQty: number;
  shippedQty: number;
  allowedMin: number;
  shortage: number;
  /** 用到的公差百分比与其来源（要一起上屏，人才能知道"这个下限是谁定的"） */
  tolerancePct: number;
  toleranceSource: ToleranceSource;
  /** 未判定/重叠等我方侧提示（原样透出，不吞） */
  notices: string[];
  /** 已批准的短装放行审批单 id（`approved` 组里才有） */
  approvalRequestId?: string | null;
}

export interface ShortShipEvaluation {
  /** 被挡的行（**事实清楚：少了**，但没有批准过的短装放行单）⇒ 由调用方发起审批单 */
  blocked: ShortShipCase[];
  /** 少发但**已有批准**的行 ⇒ 放行，调用方据此写 `ShortShipped` 留痕 */
  approved: ShortShipCase[];
  /**
   * ★★ **事实还不清楚**的行（该行在本票的明细里 `actualQty` 为**空**）⇒ 拦，但**不许走审批**。
   *   使用方 2026-09-29 晚：「不存在不知道数量又要发起出运的情况……如果现在是不知道数量就能出运，
   *   那就是中间有巨大的缺口存在。」⇒ 这不是"客户同不同意"的问题，是**先把数量录上**的问题。
   */
  unfilled: ShortShipLineRef[];
  /** ★ 本票**一条出运明细都没有** ⇒ 同样拦（不知道发了什么，更不知道发了多少） */
  noAllocationDetail: boolean;
  /**
   * 本票里**真正判过**的行数 = 收尾了的行（判成 `ok` 或 `blocked` 都算）。
   * ★ 与 `blocked.length` **不是一回事**，别拿它当"有没有被拦"用：
   *   · `judgedLines === 0` 的含义是"**没得判/还没收尾**"（未分配，或该行还有未发运的票）；
   *   · `blocked.length === 0` 的含义是"判了，且没人被拦"。
   *   把两者混起来会让"门禁根本没跑"和"门禁跑了但通过"看起来一样 —— 那正是本仓最忌讳的假绿。
   */
  judgedLines: number;
}

/** 只带"哪一行、缺什么"的最小引用（缺数据时判不了短装，所以没有差额可算） */
export interface ShortShipLineRef {
  orderLineId: string;
  orderId: string;
  itemNo: string | null;
  /** 空值明细的条数 / 本票该行的明细条数（人要知道"是几行没填"） */
  unfilledCount: number;
  allocationCount: number;
}

/** A modern physical source can retain an explicit zero/zero historical association.
 * It is neither a plan for this line nor goods dispatched for it. Null quantities and
 * positive plans with no actual goods retain the original completeness/shortage rules. */
function knownZeroAssociation(row: any): boolean {
  if (row.plannedQty == null || row.actualQty == null) return false;
  try {
    return new Prisma.Decimal(String(row.plannedQty)).isZero()
      && new Prisma.Decimal(String(row.actualQty)).isZero();
  } catch { return false; }
}

/** 该行是否还有别的"未取消且未发运"的票（`currentShipmentId` 除外） */
export async function loadLineRemainingPlan(
  tx: any,
  orderLineId: string,
  currentShipmentId: string,
  physicalSource: boolean,
): Promise<{ hasRemaining: boolean; shipmentIds: string[] }> {
  const allocs = await tx.shipmentOrderAllocation.findMany({
    where: { orderLineId, status: { not: 'Cancelled' } },
    select: { shipmentId: true, plannedQty: true, actualQty: true },
  });
  const plans = physicalSource ? allocs.filter((row: any) => !knownZeroAssociation(row)) : allocs;
  const shipmentIds: string[] = Array.from(
    new Set<string>((plans ?? []).map((a: any) => String(a.shipmentId))),
  );
  if (!shipmentIds.length) return { hasRemaining: false, shipmentIds };
  const ships = await tx.shipment.findMany({
    where: { id: { in: shipmentIds }, deletedAt: null },
    select: { id: true, status: true },
  });
  const remaining = (ships ?? []).filter(
    (s: any) =>
      s.id !== currentShipmentId &&
      !isShipmentCancelled(s.status) &&
      !isShipmentShipped(s.status),
  );
  return { hasRemaining: remaining.length > 0, shipmentIds };
}

/**
 * ★★ 门禁唯一入口（**事务内、只读**）：算出"本票涉及的订单行"里谁被挡、谁已获批。
 *
 * ⚠️ 本函数**不写任何东西**（不写 ShortShipped、不建审批单）—— 写留痕与建审批单分别在
 *   调用方的事务内 / 事务外完成（D83）。
 */
export async function evaluateShortShipment(
  tx: any,
  params: { shipmentId: string; physicalSource?: boolean;
    /** Internal capability only: the native handoff has already revalidated
     * actual completed production, applicable tolerance and requester acceptance.
     * The departure quantity remains an independent, possibly partial fact. */
    quantityBasis?: 'delivery' | 'native_production_facts' },
): Promise<ShortShipEvaluation> {
  const out: ShortShipEvaluation = { blocked: [], approved: [], unfilled: [], noAllocationDetail: false, judgedLines: 0 };
  const storedAllocations = await tx.shipmentOrderAllocation.findMany({
    where: { shipmentId: params.shipmentId },
    // ★ orderId 一并取出：整单级分配（orderLineId=null）要靠它回落"该订单的全部行"
    select: { orderLineId: true, orderId: true, plannedQty: true, actualQty: true },
  });
  const allocs = params.physicalSource
    ? storedAllocations.filter((row: any) => !knownZeroAssociation(row)) : storedAllocations;
  // ★★ 缺口一：**一条出运明细都没有** ⇒ 谈不上"发了什么"，更谈不上"发了多少"
  if (!allocs?.length) {
    out.noAllocationDetail = true;
    return out;
  }
  const lineIds = [
    ...new Set((allocs ?? []).map((a: any) => a.orderLineId).filter((x: any) => !!x).map(String)),
  ] as string[];
  // ★★ 2026-09-30 修补（Kevin 拍板「整单分配按行比例分摊后纳入判定」）：
  //   原实现只取 orderLineId **非空**的分配行 ⇒ 整单级分配（orderLineId=null，
  //   allocationService 明确支持，注释「按订单行汇总同规则」）会让 lineIds 为空
  //   ⇒ 判定行数 = 0 ⇒ **短装门禁整段不执行 = 静默 fail-open**
  //   （实测：合同 2000、实发 1800、−10% 远超 ±3% 容差，仍照放行）。
  //   修法：整单级分配 ⇒ 把该分配所属订单的**全部订单行**纳入判定（已发量由真源
  //   `OrderLine.shipmentQuantity` 提供，它本就按行比例分摊刷新 ⇒ 与 allocationService 同口径，不另造算法）。
  const wholeOrderIds = [
    ...new Set(
      (allocs ?? []).filter((a: any) => !a.orderLineId && a.orderId).map((a: any) => String(a.orderId)),
    ),
  ] as string[];
  if (wholeOrderIds.length > 0) {
    const oLines = await tx.orderLine.findMany({
      where: { orderId: { in: wholeOrderIds } },
      select: { id: true },
    });
    for (const l of oLines ?? []) {
      const id = String(l.id);
      if (!lineIds.includes(id)) lineIds.push(id);
    }
  }

  /** ★★ 缺口二：该行在本票的明细里 `actualQty` **为空** ⇒ 数量没录（`0` 是"录了、确实没发"，`null` 才是"没录"） */
  const unfilledByLine = new Map<string, number>();
  const allocCountByLine = new Map<string, number>();
  for (const a of allocs ?? []) {
    const lid = a.orderLineId ? String(a.orderLineId) : null;
    if (!lid) continue;
    allocCountByLine.set(lid, (allocCountByLine.get(lid) ?? 0) + 1);
    if (a.actualQty == null) unfilledByLine.set(lid, (unfilledByLine.get(lid) ?? 0) + 1);
  }

  for (const lineId of lineIds) {
    const line = await tx.orderLine.findUnique({
      where: { id: lineId },
      select: {
        id: true, orderId: true, itemNo: true, unit: true, quantity: true,
        shipmentQuantity: true, tolerancePercent: true, toleranceSource: true,
      },
    });
    if (!line) continue;
    const contractQty = Number(line.quantity);
    if (!Number.isFinite(contractQty) || contractQty <= 0) continue; // 数量非法 ⇒ 不判（沿用既有"未设置不校验"）

    // ★ 数量没录 ⇒ **事实不清楚**：先拦（拦在"填数量"上，不是拦在"客户同意"上）
    if (unfilledByLine.has(lineId)) {
      out.unfilled.push({
        orderLineId: line.id,
        orderId: line.orderId,
        itemNo: line.itemNo ?? null,
        unfilledCount: unfilledByLine.get(lineId) ?? 0,
        allocationCount: allocCountByLine.get(lineId) ?? 0,
      });
      continue;
    }

    // Ledger 5.6 / 8.1: neither the first ticket nor the absence of a future
    // draft proves that the order line is finished. Native handoffs judge final
    // production at its accurate source; here only actual dispatch completeness
    // remains. Never create a second shortage approval from this ticket's amount.
    if (params.quantityBasis === 'native_production_facts') continue;

    const order = await tx.order.findUnique({
      where: { id: line.orderId },
      select: { customerRelationId: true },
    });
    // ★ 与溢装**共用同一个解析器**（含出厂默认与"未判定 ⇒ 按 0 卡"）
    const loaded = await loadToleranceStandards(tx, {
      customerRelationId: order?.customerRelationId ?? null,
    });
    const resolved = resolveLineTolerance(line, loaded, { measure: contractQty });
    const gate = gateToleranceOf(resolved);

    const { hasRemaining } = await loadLineRemainingPlan(tx, line.id, params.shipmentId, params.physicalSource === true);
    const shippedQty = line.shipmentQuantity == null ? 0 : Number(line.shipmentQuantity);
    const decision = decideShortShipment({
      contractQty,
      shippedQty,
      tolerancePct: gate.pct,
      hasRemainingUnshipped: hasRemaining,
    });
    if (decision.kind === 'not_closed') continue;   // 还没收尾 ⇒ **没判**（不计入 judgedLines）
    out.judgedLines += 1;                           // ★ 判过了（ok 或 blocked 都算）
    if (decision.kind !== 'blocked') continue;      // 判了且没被拦 ⇒ 走这里，不留痕

    const base: ShortShipCase = {
      orderLineId: line.id,
      orderId: line.orderId,
      itemNo: line.itemNo ?? null,
      unit: line.unit ?? null,
      contractQty,
      shippedQty,
      allowedMin: decision.allowedMin,
      shortage: decision.shortage,
      tolerancePct: gate.pct,
      toleranceSource: gate.source,
      notices: [...(gate.notices ?? []), ...(gate.gateNote ? [gate.gateNote] : [])],
    };
    // 已批准的短装放行单 ⇒ 放行（但仍然记进 `approved`，调用方要写 `ShortShipped` 留痕）
    const approved = await tx.approvalRequest.findFirst({
      where: {
        targetType: 'OrderLine',
        targetId: line.id,
        actionType: SHORT_SHIP_APPROVAL_ACTION,
        status: 'approved',
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (approved?.id) out.approved.push({ ...base, approvalRequestId: approved.id });
    else out.blocked.push(base);
  }

  return out;
}

/** 被挡时的错误消息（人话 + 下一步；不许只说"不允许"） */
export function buildShortShipBlockedMessage(blocked: ShortShipCase[], approvalHint?: string): string {
  const lines = blocked.map((c) => {
    const unit = c.unit ? ` ${c.unit}` : '';
    return (
      `行 ${c.itemNo ?? c.orderLineId}：合同 ${c.contractQty}${unit}，已出运 ${c.shippedQty}${unit}，`
      + `下限 ${c.allowedMin}${unit}（容差 ±${c.tolerancePct}%），**还少 ${c.shortage}${unit}**`
    );
  });
  return (
    '短装拦截：该行已出运完成，但总量低于合同约定的下限 —— '
    + lines.join('；')
    + '。按业务规则，短装必须先反映客户、客户同意少发，才能确认本笔出运。'
    + (approvalHint ? `（${approvalHint}）` : '')
  );
}

/** 抛错用：把门禁结果变成"带码 + 带明细"的错误（statusCode 问注册表，不写本地映射） */
export function shortShipBlockedError(blocked: ShortShipCase[], message: string): Error {
  return Object.assign(new Error(message), {
    code: SHORT_SHIP_BLOCKED_CODE,
    statusCode: httpStatusOfCode(SHORT_SHIP_BLOCKED_CODE),
    shortShipDetails: { blocked },
  });
}

// ───────────────────────────────────────────────────────────────────
// 「事实还不清楚」的两枚错误（★ 与短装分开：这两枚**不许**用审批单放行）
// ───────────────────────────────────────────────────────────────────

/** 明细的实际出运量为空 */
export const ACTUAL_QTY_MISSING_CODE = 'SHIPMENT_ACTUAL_QTY_MISSING';
/** 本票一条出运明细都没有 */
export const NO_ALLOCATION_DETAIL_CODE = 'SHIPMENT_NO_ALLOCATION_DETAIL';

/** 「实际出运量未填」的人话文案（点明哪几行、几行没填、下一步） */
export function buildActualQtyMissingMessage(unfilled: ShortShipLineRef[]): string {
  const lines = unfilled.map(
    (u) => `行 ${u.itemNo ?? u.orderLineId}（${u.unfilledCount}/${u.allocationCount} 条明细未填数量）`,
  );
  return (
    '出运明细的实际出运量未填，无法确认出运：'
    + lines.join('；')
    + '。出运前必须先有清单/清点数量（划码、装柜清单），否则系统不知道实际发了多少，也判不出是否短装。'
    + '请把实际出运量填上再确认出运（这是数据没录，不是"客户同意少发"，因此不能用审批单放行）。'
  );
}

/** 构造「数量未填」错误（statusCode 问注册表） */
export function actualQtyMissingError(unfilled: ShortShipLineRef[], message?: string): Error {
  return Object.assign(new Error(message ?? buildActualQtyMissingMessage(unfilled)), {
    code: ACTUAL_QTY_MISSING_CODE,
    statusCode: httpStatusOfCode(ACTUAL_QTY_MISSING_CODE),
    shortShipDetails: { unfilled },
  });
}

/** 构造「没有出运明细」错误（statusCode 问注册表） */
export function noAllocationDetailError(): Error {
  return Object.assign(
    new Error('本票没有任何出运明细，无法确认出运。请先录入出运明细（发哪些订单行、各多少）再确认出运。'),
    {
      code: NO_ALLOCATION_DETAIL_CODE,
      statusCode: httpStatusOfCode(NO_ALLOCATION_DETAIL_CODE),
      shortShipDetails: { unfilled: [], noAllocationDetail: true },
    },
  );
}

// ───────────────────────────────────────────────────────────────────
// 事务外：建审批单（★ D83 —— 必须在事务外）
// ───────────────────────────────────────────────────────────────────

export interface ShortShipApprovalResult {
  /** 每行对应的审批单 id（同一行重复触发由 `createBusinessApproval` 的"单人单次防重"幂等吸收） */
  approvalRequestIds: string[];
  /** 审批单创建失败的原因（**不静默放行**：门禁仍然拦着，只是把原因一并告诉人） */
  approvalError?: string;
}

/**
 * ★★ **事务外**为被挡的行发起"短装确认单"（DR-007 解析审批人；fail-closed）。
 * ★ 创建失败**不等于放行** —— 调用方必须仍然返回被挡；这里只负责把"发起失败"的原因带回去，
 *   否则业务员会看到"拦住了但没人告诉他怎么放行"。
 */
export async function requestShortShipApproval(
  prisma: PrismaClient,
  params: { actorId: string; shipmentId: string; blocked: ShortShipCase[] },
): Promise<ShortShipApprovalResult> {
  const ids: string[] = [];
  if (!params.blocked.length) return { approvalRequestIds: ids };
  let approvalCreateService: any = null;
  try {
    const [{ createApprovalCreateService }, { createApprovalRoutingService }] = await Promise.all([
      import('../approvals/approvalCreateService'),
      import('../approvals/approvalRoutingService'),
    ]);
    approvalCreateService = createApprovalCreateService({
      prisma,
      routingService: createApprovalRoutingService({ prisma }),
    });
  } catch (e: any) {
    logger.error('[ShortShipGate] 审批服务初始化失败（门禁仍然拦着）', { error: e?.message });
    return { approvalRequestIds: ids, approvalError: `审批服务不可用：${e?.message ?? String(e)}` };
  }

  for (const c of params.blocked) {
    try {
      const created = await approvalCreateService.createBusinessApproval({
        requesterId: params.actorId,
        actionType: SHORT_SHIP_APPROVAL_ACTION,
        targetType: 'OrderLine',
        targetId: c.orderLineId,
        risk: 'high',
        payload: {
          policyKey: 'short_ship_exemption',
          shipmentId: params.shipmentId,
          orderId: c.orderId,
          itemNo: c.itemNo,
          contractQty: c.contractQty,
          shippedQty: c.shippedQty,
          allowedMin: c.allowedMin,
          shortage: c.shortage,
          tolerancePct: c.tolerancePct,
          toleranceSource: c.toleranceSource,
        },
      });
      if (created?.id) ids.push(created.id);
    } catch (e: any) {
      logger.error('[ShortShipGate] 短装确认单创建失败（门禁仍然拦着）', {
        error: e?.message, code: e?.code, orderLineId: c.orderLineId,
      });
      return {
        approvalRequestIds: ids,
        approvalError: `${c.itemNo ?? c.orderLineId} 的短装确认单发起失败：${e?.message ?? String(e)}`,
      };
    }
  }
  return { approvalRequestIds: ids };
}

// ───────────────────────────────────────────────────────────────────
// 事务内：把"已获批的短装"写到业务记录上（★ 接上那个死状态）
// ───────────────────────────────────────────────────────────────────

/**
 * ★ 放行时把该分配标成 `ShortShipped` + 写 `exception` 说明。
 *
 * 为什么必须写：`ShipmentOrderAllocation.status='ShortShipped'` 与 `exception` 列**本来就存在**，
 * 但**全仓没有任何代码写它们**（死状态，与 `customerAgreementMoq` 同类病）。
 * ⇒ 不写的话，"这一票是短装出运"这件事只活在审批单里，运单/分配上看不出来，
 *   下一批做对账的人会当成"正常发运"。
 */
export async function markAllocationsShortShipped(
  tx: any,
  params: { shipmentId: string; cases: ShortShipCase[]; actorId?: string | null },
): Promise<number> {
  const lineIds = params.cases.map((c) => c.orderLineId);
  if (!lineIds.length) return 0;
  const noteOf = (c: ShortShipCase) =>
    `客户同意少发（短装确认单 ${c.approvalRequestId ?? '—'}）：合同 ${c.contractQty}${c.unit ? ' ' + c.unit : ''}，`
    + `实出运 ${c.shippedQty}${c.unit ? ' ' + c.unit : ''}，少 ${c.shortage}${c.unit ? ' ' + c.unit : ''}`;
  let updated = 0;
  for (const c of params.cases) {
    const r = await tx.shipmentOrderAllocation.updateMany({
      where: { shipmentId: params.shipmentId, orderLineId: c.orderLineId },
      data: { status: 'ShortShipped', exception: noteOf(c) },
    });
    updated += Number(r?.count ?? 0);
  }
  return updated;
}
