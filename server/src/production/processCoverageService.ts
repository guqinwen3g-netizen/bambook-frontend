/**
 * processCoverageService.ts — ★ D2 多工厂/多工位分批交货的「排产覆盖度」核对（2026-09-18）
 *
 * ── 为什么需要它（零基础障碍清单 D2：多工厂分批交货**缺合计校验**）──
 * 一张订单可以挂**多条** `ProductionPlan`（不同工位/不同批次）与**多张** `OutsourcingOrder`
 * （不同外协厂），但系统**从不做合计核对** ⇒ 排产可以排成 1000 件订单 + 3000 件计划，
 * 也可以只排 200 件就没人发现 —— 两种都只有到交期才知道。
 *
 * ── ★★ 判据的关键（差点写错的地方）──
 * `ProductionPlan` 有 `processSeq`（工序顺序）⇒ **每道工序都排「全量」是正常的**
 *   （裁剪 1000 → 缝制 1000 → 包装 1000）。
 * 所以「Σ ProductionPlan.plannedQuantity ≤ 订单量」是**错的判据**（会把正常多工序排产全判成超产）。
 * 正确判据 = **同一「工序类型」内**跨工位/跨批次合计 ≤ 订单量 ×(1+容差)：
 *   · 裁剪：2 个工位各 500 ⇒ 合计 1000 ✓
 *   · 裁剪：2 个工位各 1000 ⇒ 合计 2000 ✗ 超产（多做的货卖不掉）
 * 外协同理：同一工序外发两家厂各 600（订单 1000）⇒ 超产。
 *
 * ── 为什么只报不挡 ──
 * 「排产计划」是**可改的工作稿**（计划改期/换厂很正常），硬挡会把正常调整卡死。
 * 所以本服务是**只读核对**：给出每个工序的合计与占比，超产标红，让业务员自己判断。
 * （与 `toleranceService` 的「溢短装是条款不是门禁」同取向。）
 */
import type { PrismaClient } from '@prisma/client';

// ────────────────────────────────────────────────────────────────
// 真源（纯函数，可单测）
// ────────────────────────────────────────────────────────────────

/** 工序类型中文标签（与 schema 注释的取值集一致） */
export const PROCESS_TYPE_LABELS: Record<string, string> = {
  Sewing: '缝制',
  Cutting: '裁剪',
  Printing: '印花',
  Embroidery: '绣花',
  Packing: '包装',
  QC: '质检',
  Washing: '水洗',
  Dyeing: '染色',
  Other: '其他',
};

export function processTypeLabel(v: string): string {
  return PROCESS_TYPE_LABELS[v] ?? v;
}

/** 参与合计的一条排产/外协记录 */
export interface ProcessEntryRef {
  processType: string;
  plannedQuantity: number | string;
  unit?: string | null;
  /** 'plan'(排产单) | 'outsourcing'(外协单) —— 展示用，不影响判定 */
  source: 'plan' | 'outsourcing';
  /** 展示用（工位名/供应商名，可空） */
  label?: string | null;
}

export interface ProcessCoverage {
  processType: string;
  processLabel: string;
  /** 该工序的计划合计（单位一致时才有意义） */
  plannedTotal: number;
  unit: string | null;
  /** 计划合计 / 订单数量（覆盖度；订单量无效时 null） */
  share: number | null;
  /** 'ok' 未超 | 'over' 超产 | 'unknown' 单位不一致/订单量无效 ⇒ 判不了 */
  verdict: 'ok' | 'over' | 'unknown';
  /** 超出订单量的部分（verdict='over' 时 > 0） */
  overBy: number;
  entries: ProcessEntryRef[];
}

export interface ProcessCoverageResult {
  processes: ProcessCoverage[];
  /** 超产的工序类型（业务员最需要先看的） */
  overProcessTypes: string[];
  /** 因单位不一致而无法判定的工序（**不猜**，显式上报） */
  unknownProcessTypes: string[];
  /** 是否做了超产判定（订单数量无效时为 false） */
  judged: boolean;
}

/**
 * 金额/数量取值：兼容 number / 数字字符串 / **Prisma.Decimal（对象）**。
 *
 * ⚠️ 这个坑必须显式处理：`Number.isFinite(new Prisma.Decimal(1000))` 是 **false**
 *   （它是对象，不是 number）⇒ 只写 `typeof v === 'string' ? Number(v) : v` 会把
 *   **所有 Decimal 数量静默丢成 0**，而「0 不超产」让超产判定**永远不触发**（假绿）。
 *   本仓同类坑已出现多次（`crossCurrency` / `orderAmountOf` 都专门处理过）。
 */
type NumericLike = number | string | { toString(): string } | null | undefined;
const num = (v: NumericLike): number | null => {
  if (v == null) return null;
  const n = typeof v === 'object' ? Number(String(v)) : Number(v);
  return Number.isFinite(n) ? n : null;
};

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * 纯函数：按**工序类型**汇总并判定超产。
 *
 * @param orderQuantity 订单数量（≤0 或非数 ⇒ 不做判定，只汇总）
 * @param tolerancePercent 允许的额外比例（如成衣 +3% 备品）；默认 0（严格）
 */
export function summarizeProcessCoverage(input: {
  orderQuantity: number | string | null | undefined;
  entries: ProcessEntryRef[];
  tolerancePercent?: number | null;
}): ProcessCoverageResult {
  const orderQty = num(input.orderQuantity);
  const judged = orderQty != null && orderQty > 0;
  const tolPct = Math.max(0, Number(input.tolerancePercent) || 0);
  const allowedMax = judged ? round4(orderQty! * (1 + tolPct / 100)) : null;

  const byProcess = new Map<string, ProcessEntryRef[]>();
  for (const e of input.entries ?? []) {
    const key = (e.processType || '').trim() || 'Other';
    const arr = byProcess.get(key) ?? [];
    arr.push(e);
    byProcess.set(key, arr);
  }

  const processes: ProcessCoverage[] = [];
  for (const [processType, entries] of byProcess) {
    const quantities = entries.map(e => num(e.plannedQuantity)).filter((n): n is number => n != null && n > 0);
    const units = [...new Set(entries.map(e => (e.unit ?? '').trim()).filter(Boolean))];
    const plannedTotal = round4(quantities.reduce((s, n) => s + n, 0));

    // 单位不一致 ⇒ 合计没有意义（跨单位相加是错的），显式标 unknown 而不是硬算
    const mixedUnits = units.length > 1;
    const unit = units.length === 1 ? units[0] : null;

    let verdict: ProcessCoverage['verdict'] = 'unknown';
    let overBy = 0;
    if (!mixedUnits && judged && allowedMax != null) {
      if (plannedTotal > allowedMax + 1e-9) {
        verdict = 'over';
        overBy = round4(plannedTotal - allowedMax);
      } else {
        verdict = 'ok';
      }
    }

    processes.push({
      processType,
      processLabel: processTypeLabel(processType),
      plannedTotal,
      unit,
      share: judged ? round4(plannedTotal / orderQty!) : null,
      verdict,
      overBy,
      entries,
    });
  }

  // 超产的排前面（业务员最需要先看），其余按计划量降序
  processes.sort((a, b) => {
    if ((a.verdict === 'over') !== (b.verdict === 'over')) return a.verdict === 'over' ? -1 : 1;
    return b.plannedTotal - a.plannedTotal;
  });

  return {
    processes,
    overProcessTypes: processes.filter(p => p.verdict === 'over').map(p => p.processType),
    unknownProcessTypes: processes.filter(p => p.verdict === 'unknown' && p.entries.length > 0).map(p => p.processType),
    judged,
  };
}

// ────────────────────────────────────────────────────────────────
// 只读查询（真库）
// ────────────────────────────────────────────────────────────────

export interface OrderProductionCoverage extends ProcessCoverageResult {
  orderId: string;
  poNumber: string | null;
  orderQuantity: number | null;
  unit: string | null;
  tolerancePercent: number;
  /** 明细行（排产单 + 外协单），供界面展开 */
  planCount: number;
  outsourcingCount: number;
}

/**
 * 订单的「排产覆盖度」（只读）。
 *
 * 口径：
 *   · 排除 `Cancelled` 状态与软删记录（已取消的排产不该计入合计）
 *   · 工序类型分组；单位不一致 → 不判定（见真源注释）
 *   · 订单单位取**明细行单位**（订单主档无 unit）；多行单位不一致时只回带首个并标 null 判定
 */
export async function getOrderProductionCoverage(
  prisma: PrismaClient,
  orderId: string,
  opts: { tolerancePercent?: number | null } = {},
): Promise<OrderProductionCoverage | null> {
  if (!orderId) return null;
  const db: any = prisma as any;

  const order = await db.order.findFirst({
    where: { id: orderId, deletedAt: null },
    select: { id: true, poNumber: true, quantity: true },
  });
  if (!order) return null;

  const [lines, plans, outsourcings] = await Promise.all([
    db.orderLine.findMany({ where: { orderId }, select: { unit: true, quantity: true } }).catch(() => []),
    db.productionPlan.findMany({
      where: { orderId, deletedAt: null, status: { not: 'Cancelled' } },
      select: { processType: true, plannedQuantity: true, unit: true, workStationId: true, status: true },
    }).catch(() => []),
    db.outsourcingOrder.findMany({
      where: { orderId, deletedAt: null, status: { not: 'Cancelled' } },
      select: { processType: true, quantity: true, unit: true, supplierId: true, status: true },
    }).catch(() => []),
  ]);

  const units = [...new Set((lines as any[]).map(l => (l.unit ?? '').trim()).filter(Boolean))];
  const unit = units.length === 1 ? units[0] : null;

  const entries: ProcessEntryRef[] = [
    ...(plans as any[]).map(p => ({
      processType: p.processType,
      plannedQuantity: p.plannedQuantity,
      unit: p.unit,
      source: 'plan' as const,
      label: p.workStationId ?? null,
    })),
    ...(outsourcings as any[]).map(o => ({
      processType: o.processType,
      plannedQuantity: o.quantity,
      unit: o.unit,
      source: 'outsourcing' as const,
      label: o.supplierId ?? null,
    })),
  ];

  const summary = summarizeProcessCoverage({
    orderQuantity: order.quantity,
    entries,
    tolerancePercent: opts.tolerancePercent ?? 0,
  });

  return {
    ...summary,
    orderId: order.id,
    poNumber: order.poNumber ?? null,
    orderQuantity: num(order.quantity),
    unit,
    tolerancePercent: Math.max(0, Number(opts.tolerancePercent) || 0),
    planCount: plans.length,
    outsourcingCount: outsourcings.length,
  };
}
