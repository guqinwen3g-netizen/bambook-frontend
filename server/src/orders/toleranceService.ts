/**
 * toleranceService.ts — 订单溢短装视图（REQ2-03）
 *
 * ★ 2026-09-29 拆分：
 *   - 纯计算内核（`checkTolerance` / `validateTolerancePercentInput` / 类型）已移到
 *     `toleranceCore.ts`，本文件**转发导出** ⇒ 既有调用方 import 路径不变。
 *   - 本文件保留**订单维度视图** `getOrderToleranceStatus`，并把容差口径接到
 *     `toleranceStandardService` 的取数链（① 行级覆盖 → ② 客户标准 P0 → ③ 内部标准辅助 → ④ 未判定）。
 *
 * ★★ 修前这里有一个**静默回退**：`l.tolerancePercent != null ? Number(...) : 5`
 *   —— 与出运门禁（`allocationService`）的 `== null ? 0` **对同一个字段给了两个不同回退值**。
 *   两处都不该自己发明数字：现在**统一走同一个解析器**，取不到就报「未判定」。
 */
import { PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import { checkTolerance, type ToleranceCheckResult } from './toleranceCore';
import {
  evaluateWidthDeduction,
  gateToleranceOf,
  loadToleranceStandards,
  loadWidthMeasurements,
  resolveLineTolerance,
  widthDeviationPct,
  type ToleranceSource,
  type WidthDeductionEvaluation,
} from './toleranceStandardService';

// ── 转发导出（保持既有 import 路径可用）──
export { checkTolerance, validateTolerancePercentInput } from './toleranceCore';
export type { ToleranceVerdict, ToleranceCheckInput, ToleranceCheckResult } from './toleranceCore';

export interface OrderLineToleranceStatus {
  orderLineId: string;
  itemNo: string | null;
  description: string | null;
  unit: string | null;
  contractQty: number;
  shippedQty: number;          // 已发货量（shipmentQuantity 快照；未发=0）
  /**
   * ★ 2026-09-29：**生效的**公差百分比。
   * `null` = **未判定**（该客户未录标准、内部也未录）—— **不是 0，也不是 5**。
   */
  tolerancePercent: number | null;
  /** ★ 这个数从哪来：行级覆盖 / 客户标准 / 我方标准 / 无标准 */
  toleranceSource: ToleranceSource;
  /** ★ 是否**硬约束**（客户标准 / 行级覆盖 = true；我方标准 = false，辅助） */
  toleranceHard: boolean;
  /** ★ 未判定的原因（说人话，可直接上屏） */
  toleranceUnresolvedReason: string | null;
  /**
   * ★ **参考值**：行上那个数（`OrderLine.tolerancePercent`，是 `@default(5)` 填的），
   * **不是合同约定** —— 界面必须连同「非合同约定」一起显示。
   */
  toleranceReferencePct: number | null;
  unitPrice: number | null;
  /** ★ `null` = **判不了**（未判定 或 未发货）—— **不等于「合格」** */
  check: ToleranceCheckResult | null;
  /**
   * ★ 2026-09-29 晚：**幅宽扣款（窄幅索赔）**
   *   `null` = 该行**没有幅宽实测记录**（QC 还没量过）—— 与"量了但算不出"是两件事，
   *   后者返回对象且 `verdict='undetermined'`。
   * ★★ 这里的 `suggestedAmount` **只是建议**，系统**不落账**（R6：扣不扣、扣多少由人定）。
   */
  widthDeduction: (WidthDeductionEvaluation & { reportId: string; measuredAt: number | null }) | null;
}

export interface OrderToleranceStatus {
  orderId: string;
  poNumber: string | null;
  lines: OrderLineToleranceStatus[];
  /**
   * ★ 幅宽实测表**读取失败**（≠「这一单还没量过幅宽」）。
   *   `true` 时 `lines[].widthDeduction` 一律为 `null`，界面**必须**据此显示"读取失败"而不是"还没量"。
   */
  widthMeasurementUnavailable: boolean;
  summary: {
    total: number;
    ok: number;
    overLimit: number;
    underLimit: number;
    unshipped: number;
    /** ★ 2026-09-29：判不了的（无可用标准）—— 单独计数，不混进 ok */
    undetermined: number;
  };
}

/** 订单维度：全部行已发量 vs 合同量的溢短装状态（订单详情视图数据源） */
export async function getOrderToleranceStatus(prisma: PrismaClient, orderId: string): Promise<OrderToleranceStatus | null> {
  const db = prisma as any;
  const order = await db.order.findFirst({
    where: { id: orderId, deletedAt: null },
    select: { id: true, poNumber: true, customerRelationId: true },
  });
  if (!order) return null;

  const lines = await db.orderLine.findMany({
    where: { orderId },
    orderBy: { lineNumber: 'asc' },
    select: {
      id: true, itemNo: true, description: true, unit: true, quantity: true,
      unitPrice: true, netValue: true, shipmentQuantity: true, tolerancePercent: true, toleranceSource: true,
    },
  });

  // ★ 2026-09-29：标准只查一次（客户标准 P0 + 内部标准辅助）
  const loaded = await loadToleranceStandards(prisma, {
    customerRelationId: order.customerRelationId ?? null,
  });

  /**
   * ★ 幅宽实测（QC 查货登记）—— 读失败**不许**当成"没量过"：
   *   那会把"数据库/表出问题"伪装成"这一行还没量"，从而静默漏掉一笔索赔（本仓最忌讳的假绿）。
   *   ⇒ 失败时整表标 unavailable，由本函数返回的 `widthMeasurementUnavailable` 上屏。
   */
  let widthByLine = new Map<string, any>();
  let widthUnavailable = false;
  try {
    widthByLine = await loadWidthMeasurements(prisma, orderId);
  } catch (e: any) {
    widthUnavailable = true;
    logger.error('[ToleranceService] 幅宽实测读取失败（不当作"没量过"）', { orderId, error: e?.message });
  }

  const statuses: OrderLineToleranceStatus[] = lines.map((l: any) => {
    const contractQty = Number(l.quantity);
    const shippedQty = l.shipmentQuantity != null ? Number(l.shipmentQuantity) : 0;
    // ★ 与出运门禁（allocationService）**共用同一个解析器** ⇒ 两处不再各写各的回退值
    const resolved = resolveLineTolerance(l, loaded, { measure: contractQty });
    // 未发货（shippedQty=0）不做容差判定（发货启动后才触发条款）；★ 未判定也判不了
    const check = shippedQty > 0 && resolved.pct != null
      ? checkTolerance({
          contractQty,
          actualQty: shippedQty,
          tolerancePercent: resolved.pct,
          unitPrice: l.unitPrice != null ? Number(l.unitPrice) : null,
        })
      : null;
    // ★ 幅宽扣款：偏差（按基准幅宽算）→ 与数量公差**同一套标准链**取扣款比例 → 建议额
    //   ⚠️ 没有实测记录 ⇒ `null`（"还没量"），不是"扣 0"
    const wm = widthByLine.get(l.id);
    const widthDeduction = wm
      ? (() => {
          const dev = widthDeviationPct(wm.basisWidthCm, wm.measuredWidthCm);
          // ★ 量纲 = **偏差 %**（客户标准原文就是按偏差分档；详见标准服务的口径说明）
          // ⓘ `dev == null`（基准/实测缺失）时传 0 只是**占位**：这时 evaluateWidthDeduction 会在
          //   第一段就返回「缺幅宽数据」，不会用到这里解析出来的比例（★ 不允许把 null 当 0 去匹配档位）。
          const wResolved = resolveLineTolerance(
            { tolerancePercent: null, toleranceSource: null }, // 幅宽不走行级覆盖（那列是数量公差的）
            loaded,
            { subject: 'widthDeduction', measure: dev ?? 0 },
          );
          const ev = evaluateWidthDeduction({
            basisWidthCm: wm.basisWidthCm,
            measuredWidthCm: wm.measuredWidthCm,
            lineNetValue: l.netValue != null ? Number(l.netValue) : null,
            tolerance: gateToleranceOf(wResolved),
          });
          return { ...ev, reportId: wm.reportId, measuredAt: wm.createdAt };
        })()
      : null;

    return {
      orderLineId: l.id,
      widthDeduction,
      itemNo: l.itemNo ?? null,
      description: l.description ?? null,
      unit: l.unit ?? null,
      contractQty,
      shippedQty,
      tolerancePercent: resolved.pct,
      toleranceSource: resolved.source,
      toleranceHard: resolved.hard,
      toleranceUnresolvedReason: resolved.unresolvedReason,
      toleranceReferencePct: resolved.referencePct,
      unitPrice: l.unitPrice != null ? Number(l.unitPrice) : null,
      check,
    };
  });

  return {
    orderId: order.id,
    poNumber: order.poNumber ?? null,
    lines: statuses,
    widthMeasurementUnavailable: widthUnavailable,
    summary: {
      total: statuses.length,
      ok: statuses.filter(s => s.shippedQty > 0 && s.check?.verdict === 'ok').length,
      overLimit: statuses.filter(s => s.check?.verdict === 'over_limit').length,
      underLimit: statuses.filter(s => s.check?.verdict === 'under_limit').length,
      unshipped: statuses.filter(s => s.shippedQty <= 0).length,
      // ★ 判不了的单独计数：不许混进 ok（"没超"要有依据）
      undetermined: statuses.filter(s => s.shippedQty > 0 && s.check === null).length,
    },
  };
}
