/**
 * task ERP-P1-order-shipment-status-link-foundation
 *
 * Shipment 创建/状态变更 → Order 状态联动（同事务闭环）。
 *
 * 映射规则（单一来源）：
 *   Shipment Booked/Loading/Shipped/Arrived/Cleared → Order Shipping
 *   Shipment Delivered → Order Delivered
 *   Shipment Draft → 不联动（未启动）
 *   Shipment Cancelled → ★ A5（2026-09-18）：**回退**订单到「进入 Shipping 之前」的状态
 *     （原实现「留人工」⇒ 库存已反向回冲、货已回库，订单却仍卡在「出运中」，
 *       状态与实物不符；且人工没有入口知道该退回哪一档）
 *
 * 终态 Order（Delivered）不再被联动覆盖；Alert/非法当前 status fail closed；缺失 order/shipment fail closed。
 */

import { logger } from '../lib/logger';
// ★ A10-①（拍板件 §2.3）：运单取消导致的订单回退，也是「把订单写回某个状态」
//   ⇒ 同样**先跑恢复门禁、通过才写回**（第三处免检入口）。
//   ★ 方向安全：本模块此前是叶子模块（只 import logger），而 `orderLifecycleService`
//     **不**反向 import 本模块 ⇒ 不构成循环依赖。
import { evaluateOrderRestoreGate } from '../orders/orderLifecycleService';
import { consumeCreditException } from '../credit/creditExceptionGate';
import { SYSTEM_AUDIT_ACTOR } from '../audit/routeAudit';

export type TxLike = any;

// Order 合法状态（与 orders/route.ts VALID_ORDER_STATUSES 对齐）
export const VALID_ORDER_STATUSES = ['Pending', 'Confirmed', 'Production', 'Shipping', 'Delivered', 'Alert'];

// Order 终态（不可被联动覆盖）
const ORDER_TERMINAL_STATUSES = new Set(['Delivered', 'Alert']);

const VALID_ORDER_STATUS_SET = new Set(VALID_ORDER_STATUSES);

/**
 * 从 Shipment status 推导应联动的 Order status。
 * 返回 null 表示不联动（维持 Order 原状）。
 */
export function deriveOrderStatusFromShipment(shipmentStatus: string): string | null {
  switch (shipmentStatus) {
    case 'Booked':
    case 'Loading':
    case 'Shipped':
    case 'Arrived':
    case 'Cleared':
      return 'Shipping';
    case 'Delivered':
      return 'Delivered';
    default: return null; // Draft/Cancelled 不联动
  }
}

export interface LinkResult {
  ok: boolean;
  skipped?: boolean; // 无需联动（shipment status 不映射）
  orderId?: string;
  fromStatus?: string;
  toStatus?: string;
  error?: string;
  message?: string;
  /** A5：回退原因（未回退时的具体理由，便于调用方/日志解释「为什么订单没动」） */
  reason?: string;
  /**
   * ★ B50-1d：回退目标的**依据**。`history` = 真实流转留痕；其余三个值 = 写进去的状态是推断出来的。
   * 可选字段（旧消费方只读 toStatus ⇒ 行为不变），但推断值必须可被区分出来。
   */
  rollbackBasis?: RollbackTargetBasis;
  /**
   * ★ A10-①（拍板件 §2.3）—— **回退被恢复门禁拦下**时的结构化原因。
   *
   * 为什么不能只用 `reason`：`skipped:true` 在本仓既有两种意思
   * （① `shipment status` 不映射 = 无需联动；② 该订单还有别的在途票 = 不该联动），
   * 两者都是**正常路径**。本字段要表达的是第三件事：**本该联动、但订单当前不具备
   * 恢复到目标状态的条件**（客户冻结 / 信用证过期 / MOQ …）⇒ 必须能被机器区分出来，
   * 否则事后看审计会把「被门禁拦了」读成「本来就不用回退」。
   *
   * ★ 与 `reason`（人读）**并存**：`reason` 是英文的旧字段（历史消费方在读），
   *   本字段是结构化的：`code` 给程序判、`message` 给人读（中文、含下一步）。
   *   ★ `message` **刻意不内插门禁的原文**（只给原因码）—— 本仓 B22 棘轮
   *     （`message: <标识符>.message` 内部原文上屏）只许减不许增；原文走 logger。
   */
  restoreBlocked?: { code: string; message: string };
}

export interface LinkOptions {
  operator?: string;
  now?: () => number;
  /** A5：本次变更的运单 id —— 判「该订单还有没有别的在途票」时要把它排除掉 */
  shipmentId?: string;
}

/** 回退时可落的状态（其余一律 fallback 到 Confirmed） */
const ROLLBACK_ALLOWED = new Set(['Confirmed', 'Production']);

/**
 * 事务内联动：根据 shipment status 更新 order status + 写 OrderStatusTransition。
 * fail closed：order 不存在/已删/终态 → 抛错（事务回滚）。
 *
 * @returns LinkResult skipped=true 表示无需联动（正常路径，非错误）
 */
/**
 * ★ A5：该订单在「本次取消的运单之外」是否还有在途运单。
 *
 * 合票/分批场景下同一订单可能挂多票：只取消其中一票就退回订单状态是**错的**
 * （其余票还在海上，订单理应仍是 Shipping）。
 *
 * 「在途」= status ∉ {Cancelled, Draft}：Cancelled 显然不算；Draft 还没启动出运，
 * 也不该把订单钉在 Shipping（它重新 Booked 时会被再次联动过去）。
 */
export async function hasOtherActiveShipmentForOrder(
  tx: TxLike,
  orderId: string,
  cancelledShipmentId?: string,
): Promise<boolean> {
  const statusById = new Map<string, string>();

  // ① 主订单投影（Shipment.orderId）
  const byProjection: Array<{ id: string; status: string }> = await tx.shipment.findMany({
    where: { orderId, deletedAt: null },
    select: { id: true, status: true },
  });
  for (const s of byProjection) statusById.set(s.id, s.status);

  // ② 合票分配（ShipmentOrderAllocation.orderId）—— 没有 @relation，分两步查
  const allocs: Array<{ shipmentId: string }> = await tx.shipmentOrderAllocation.findMany({
    where: { orderId },
    select: { shipmentId: true },
  });
  const allocIds = [...new Set(allocs.map(a => a.shipmentId))].filter(id => !statusById.has(id));
  if (allocIds.length > 0) {
    const byAlloc: Array<{ id: string; status: string }> = await tx.shipment.findMany({
      where: { id: { in: allocIds }, deletedAt: null },
      select: { id: true, status: true },
    });
    for (const s of byAlloc) statusById.set(s.id, s.status);
  }

  for (const [id, status] of statusById) {
    if (cancelledShipmentId && id === cancelledShipmentId) continue;
    if (status === 'Cancelled' || status === 'Draft') continue;
    return true;
  }
  return false;
}

/**
 * ★ A5：订单「进入 Shipping 之前」的状态 —— 回退目标。
 * 依据 = OrderStatusTransition 里最后一条 toStatus='Shipping' 的 fromStatus（真实留痕）。
 *
 * ★ B50-1d：三种"取不到"必须**分开且可追溯**，不再统一静默 fallback：
 *   · `no-transition-row` 库里真没有 toStatus='Shipping' 那条留痕（老数据/旁路写入）
 *   · `row-unusable`      留痕有，但 fromStatus 不在可回退集合内（脏值）
 *   · `query-failed`      **查询本身失败** ⇒ 我们对历史一无所知（这跟"知道没有"是两件事）
 * 兜底值仍是 `Confirmed`（理由保留：能出运说明至少已确认；退回 Pending 是"未确认"语义，更错）。
 * 改变的是**这条记录不许长得像真实历史**：basis 随结果返回、并写进流转记录的 note，
 * 事后审计能一眼看出"这个状态是推断出来的"。⇒ §9 B50-1d 前半（"猜出来的值不留痕地当成历史"）在此收口；
 * ★ 注意收口的**只是可分辨性**：值仍是猜的、库仍照写，"猜"本身没变。
 * "回退该不该重跑确认门禁"是另一件事（政策问，§12.1 第 16 条第 ④ 问），本处不自拍。
 *
 * 真库实测（2026-09-21 只读，`panda_hub_local`）：当前 10 张 `Shipping` 订单**全部**有
 * `toStatus='Shipping'` 的流转留痕（10/10）⇒ 兜底今天不会因"无留痕"触发；本改动针对的是
 * "一旦发生就静默"这一类，不是"高频写错"。
 */
export type RollbackTargetBasis = 'history' | 'no-transition-row' | 'row-unusable' | 'query-failed';

export const ROLLBACK_BASIS_TEXT: Record<RollbackTargetBasis, string> = {
  history: '依据真实流转留痕',
  'no-transition-row': '库里没有 toStatus=Shipping 的流转留痕，目标为推断值',
  'row-unusable': '流转留痕的 fromStatus 不可用（脏值或空值），目标为推断值',
  // ⚠️ 这段文字会原样进 `OrderStatusTransition.note`，而 note 在订单时间线里是**纯文本渲染**
  //   （`components/OrderManager.tsx:2122`）⇒ 不许写 markdown 强调，星号会被看见。
  'query-failed': '流转留痕查询失败，目标为推断值（不代表"确认过没有留痕"）',
};

export async function resolveOrderStatusBeforeShipping(
  tx: TxLike, orderId: string,
): Promise<{ status: string; basis: RollbackTargetBasis }> {
  // ★ 查询与"查询之后的分类/日志"分开写：`try` 只罩住那一笔读。
  //   把 logger.warn 也罩进去过一次，后果是**日志子系统抛错会被归类成 query-failed**
  //   （"我不知道历史"被说成"我查历史失败"，同样是把两件事合并，正是本函数要拆开的东西）。
  let rows: Array<{ fromStatus: string }>;
  try {
    rows = await tx.orderStatusTransition.findMany({
      where: { orderId, toStatus: 'Shipping' },
      orderBy: { createdAt: 'desc' },
      take: 1,
      select: { fromStatus: true },
    });
  } catch (e: any) {
    // 查询失败与"查到但没有"必须分开：前者代表**系统不知道**，写出去的那条流转记录
    // 不能伪装成有据可依的历史（原文只进日志，不进任何对外字段）。
    logger.error('[shipping/orderLink] 回退目标留痕查询失败，仍按 Confirmed 兜底（结果里标 query-failed）', { orderId, error: e?.message });
    return { status: 'Confirmed', basis: 'query-failed' };
  }

  // 分类按**有没有读到行**，不按"读到的值是否非空"：三列在 schema 里都是裸 `String`（无 CHECK），
  // 空串 is 一条真实存在的留痕 ⇒ 归 row-unusable，不能说成"库里没有"。
  const from = rows[0]?.fromStatus;
  if (from && ROLLBACK_ALLOWED.has(from)) return { status: from, basis: 'history' };
  if (rows.length > 0) {
    logger.warn('[shipping/orderLink] 回退目标留痕不可用，按 Confirmed 兜底', { orderId, fromStatus: from ?? null });
    return { status: 'Confirmed', basis: 'row-unusable' };
  }
  logger.warn('[shipping/orderLink] 无 Shipping 流转留痕，回退目标按 Confirmed 推断', { orderId });
  return { status: 'Confirmed', basis: 'no-transition-row' };
}

/** ★ A5：运单取消 → 订单回退（ Shipping 且无其它在途票时才回退） */
async function rollbackOrderOnShipmentCancelled(
  tx: TxLike,
  orderId: string,
  options: LinkOptions,
): Promise<LinkResult> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { id: true, status: true, deletedAt: true },
  });
  if (!order || order.deletedAt) {
    throw Object.assign(new Error(`order ${orderId} not found or deleted`), { statusCode: 404, code: 'ORDER_NOT_FOUND' });
  }
  if (!VALID_ORDER_STATUS_SET.has(order.status)) {
    throw Object.assign(
      new Error(`order ${orderId} has unrecognized current status '${order.status}'. Valid: ${VALID_ORDER_STATUSES.join(', ')}`),
      { statusCode: 400, code: 'INVALID_CURRENT_ORDER_STATUS' },
    );
  }
  // 只回退 Shipping：Delivered/Alert 是终态；Production/Confirmed 本来就没在出运，不动
  if (order.status !== 'Shipping') {
    return { ok: true, skipped: true, orderId, fromStatus: order.status, reason: `order status is ${order.status} (only Shipping is rolled back)` };
  }
  if (await hasOtherActiveShipmentForOrder(tx, orderId, options.shipmentId)) {
    return { ok: true, skipped: true, orderId, fromStatus: order.status, reason: 'order still has other active shipments' };
  }

  const { status: target, basis } = await resolveOrderStatusBeforeShipping(tx, orderId);

  // ★ A10-①（拍板件 §2.3）：回退前**先跑恢复门禁、通过才写回**。
  //   本处此前是第三条免检入口：运单取消 ⇒ 直写 `tx.order.update` 把订单写回 `Confirmed`
  //   而**不跑任何门禁**（本函数同样不走 `transitionOrderStatus`）。
  //
  //   ★ 与「变更单」两处的差别（**如实登记**）：那两处的门禁跑在**事务外**
  //     （门禁自身会写东西 —— 信用被挡时自动发起 `credit_exemption` 审批单），
  //     而本函数**只在事务内**被调用（`shipmentMutationService.ts:309` / `:480` 的
  //     `prisma.$transaction` 里）⇒ 此处门禁只能在**调用方事务内**跑。后果：
  //     若本事务稍后因其它原因回滚，门禁顺带建的审批单会一起消失（原子，可接受）；
  //     把门禁提到事务外要改调用方结构 ⇒ **属扩围，未做**。
  //
  //   ★ 被拦时的语义（硬条件 3 的同款处理）：**运单取消照常生效**（那是操作人的权利），
  //     只是**订单状态不写回** ⇒ 返回 `skipped`（调用方据此不记 `orderStatus`），
  //     并带上 `restoreBlocked` 让人读得出「被门禁拦了」而不是「本来就不用回退」。
  //     刻意**不抛错**：抛错会把整笔事务回滚 ⇒ 变成「客户被冻结就取消不了运单」，
  //     把两件无关的事绑在一起（正是硬条件 3 要避免的那种绑定）。
  const restoreGate = await evaluateOrderRestoreGate({
    prisma: tx, orderId, targetStatus: target, actorId: options.operator || SYSTEM_AUDIT_ACTOR, logScope: 'shipping:rollback-restore',
  });
  if (!restoreGate.allowed) {
    logger.warn('[shipping/orderLink] 订单回退被恢复门禁拦下：运单取消照常，订单状态不写回', {
      orderId, targetStatus: target, rollbackBasis: basis, code: restoreGate.code,
    });
    return {
      ok: true,
      skipped: true,
      orderId,
      fromStatus: order.status,
      rollbackBasis: basis,
      reason: `rollback to ${target} blocked by restore gate (${restoreGate.code})`,
      // ★ 只给**码**与一句可行动的话，**不内插**门禁的 `message`：
      //   本仓 B22 棘轮（`message: <标识符>.message` 内部原文上屏）**只许减不许增**
      //   ⇒ 新写的这一处必须干净。门禁原文已由上面那条 logger.warn 留在服务端。
      restoreBlocked: {
        code: restoreGate.code,
        message: `订单状态未写回：当前不具备恢复到「${target}」的条件（原因码 ${restoreGate.code}）。运单取消已生效，订单停留在「${order.status}」；请先处理上述条件后另行恢复订单状态。`,
      },
    };
  }

  const inferred = basis !== 'history';
  const ts = options.now?.() ?? Date.now();
  await tx.orderStatusTransition.create({
    data: {
      id: `ST-SHIP-ROLLBACK-${orderId}-${ts}`,
      orderId,
      fromStatus: order.status,
      toStatus: target,
      // ★ 推断出来的目标要写在这条留痕本身里，否则事后看表它与真实历史长得一模一样
      note: `auto-rollback on shipment cancellation${options.shipmentId ? ` (shipment ${options.shipmentId})` : ''}`
        + (inferred ? ` — ${ROLLBACK_BASIS_TEXT[basis]}` : ''),
      operator: options.operator || 'shipping-sync',
      createdAt: BigInt(ts),
    },
  });
  await tx.order.update({ where: { id: orderId }, data: { status: target, updatedAt: BigInt(ts) } });
  if (restoreGate.creditExceptionPass) {
    const pass = restoreGate.creditExceptionPass;
    await consumeCreditException({ exceptionService: pass.service, exceptionId: pass.exception.id, scope: pass.scope,
      actorId: options.operator || SYSTEM_AUDIT_ACTOR, tx, note: `运单 ${options.shipmentId || '未录'} 取消后订单 ${orderId} 恢复到 ${target}` });
  }
  return { ok: true, orderId, fromStatus: order.status, toStatus: target, rollbackBasis: basis };
}

export async function linkOrderStatusFromShipment(
  tx: TxLike,
  orderId: string,
  shipmentStatus: string,
  options: LinkOptions = {},
): Promise<LinkResult> {
  if (!orderId) return { ok: false, error: 'MISSING_ORDER', message: 'orderId is required for status link' };

  const targetOrderStatus = deriveOrderStatusFromShipment(shipmentStatus);
  if (targetOrderStatus == null) {
    // Draft 不联动；Cancelled → A5 回退（货已反向入库，订单不该继续显示「出运中」）
    if (shipmentStatus !== 'Cancelled') return { ok: true, skipped: true };
    return rollbackOrderOnShipmentCancelled(tx, orderId, options);
  }

  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { id: true, status: true, deletedAt: true },
  });
  if (!order || order.deletedAt) {
    throw Object.assign(new Error(`order ${orderId} not found or deleted`), { statusCode: 404, code: 'ORDER_NOT_FOUND' });
  }

  // task review fix: 非法当前 status（脏数据）→ fail closed
  if (!VALID_ORDER_STATUS_SET.has(order.status)) {
    throw Object.assign(
      new Error(`order ${orderId} has unrecognized current status '${order.status}'. Valid: ${VALID_ORDER_STATUSES.join(', ')}`),
      { statusCode: 400, code: 'INVALID_CURRENT_ORDER_STATUS' },
    );
  }

  // 终态保护：Delivered/Alert 不被联动覆盖
  if (ORDER_TERMINAL_STATUSES.has(order.status) && order.status !== targetOrderStatus) {
    throw Object.assign(
      new Error(`order ${orderId} is in terminal status '${order.status}', cannot be changed by shipment link`),
      { statusCode: 400, code: 'ORDER_TERMINAL' },
    );
  }

  // 幂等：order 已在目标 status，跳过
  if (order.status === targetOrderStatus) {
    return { ok: true, skipped: true, orderId, fromStatus: order.status, toStatus: targetOrderStatus };
  }

  const ts = options.now?.() ?? Date.now();
  const transitionId = `ST-SHIP-${orderId}-${ts}`;

  // 写 OrderStatusTransition 审计
  await tx.orderStatusTransition.create({
    data: {
      id: transitionId,
      orderId,
      fromStatus: order.status,
      toStatus: targetOrderStatus,
      note: `auto-linked from shipment status '${shipmentStatus}'`,
      operator: options.operator || 'shipping-sync',
      createdAt: BigInt(ts),
    },
  });

  // 更新 Order status
  await tx.order.update({
    where: { id: orderId },
    data: { status: targetOrderStatus, updatedAt: BigInt(ts) },
  });

  return { ok: true, orderId, fromStatus: order.status, toStatus: targetOrderStatus };
}
