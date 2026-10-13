/**
 * commissionPayableService.ts — ★ D4 佣金/中间商的「订单应付闭环」（2026-09-18）
 *
 * ── 为什么需要它（零基础障碍清单 D4「缺订单应付闭环」· 实测核实）──
 * 佣金在**定价侧**其实已经算得很细（`PricingCalculation.commissionRate / commissionAmount` +
 * `CommissionRule` 规则表 + `commissionRuleId` 追溯），但**只算不收**：
 *   · 没有任何地方能回答「这张单欠中间人多少佣金」
 *   · 更没有「已开应付 / 已付 / 还差多少」的状态 ⇒ 佣金永远停在算价快照里，财务收不到
 * ⇒ 中间人（代理商）的钱没人管，且事后无法追溯。
 *
 * ── 修法（**零 migration**：不建新表，复用既有应付链路）──
 * 佣金应付 = **给中间人开一张应付发票**（`Invoice{type:'Payable', customerRelationId: 中间人}`）：
 *   · 立刻进入本仓既有的 **AP 账龄 / 付款凭证 / 供应商对账单** 链路 ⇒ 这才是真正的"闭环"
 *   · 幂等与追溯靠 `Invoice.sourceType='CommissionPayable'` + `sourceId=<orderId>#<序号>`
 *     （`sourceType/sourceId` 是 schema 既有字段，语义就是「来源业务单据」）
 *   · 开票复用真源 `finance/invoiceMutationService.createInvoice`（币种白名单/金额校验/取号/审计全都有）
 * 为什么不建 `OrderCommissionPayable` 表：① 应付这件事本仓已有模型（Payable 发票），
 *   再建一张会出现「同一笔应付两处记」的漂移（本仓反复踩过）② 生产已 28 条待迁移。
 *
 * ── 口径（**只算已确认的定价**）──
 *   · 只统计 `PricingCalculation.status = 'Confirmed'` 的行（Draft 不是承诺；Archived 已作废）
 *   · 佣金总额 = Σ(`commissionAmount` × `quantity`) —— `commissionAmount` 是**单价**口径
 *   · 币种 = USD（定价链是美元口径，`netUsdCost/commissionAmount` 都是 USD）
 *   · 中间人：由 `commissionRuleId` → `CommissionRule.intermediaryRelationId` 解析；
 *     **多行归属不同中间人 → 不猜**，返回 null + issue，让人工确认
 *   · 行缺 `quantity` → 无法算总额 ⇒ 不计入并记 issue（**不按 1 顶替**）
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import { createInvoice, type InvoiceMutationError, type InvoiceMutationErrorCode } from '../finance/invoiceMutationService';
import { httpStatusOfCode, isBusinessError } from '../shared/errorCodes';
import { safeRouteError } from '../shared/routeError';
// ★ 业务日期必须走真源（`toISOString().slice(0,10)` 是 **UTC 日期**，本仓有棘轮守卫禁它：
//   本地 00:00–08:00（GMT+8）时会差一天）
import { todayLocalKey } from '../shared/localDate';
import type { TokenPayload } from '../auth/service';
import { createPermissionService, hasScope } from '../auth/permissionService';
import { buildOrderListScopeWhere } from '../orders/orderService';
import { businessError } from '../shared/errorCodes';

// ────────────────────────────────────────────────────────────────
// 真源（纯函数，可单测）
// ────────────────────────────────────────────────────────────────

/** 定价计算行（佣金来源） */
export interface CommissionPricingRowRef {
  id: string;
  /** Draft | Confirmed | Archived */
  status?: string | null;
  commissionAmount?: unknown;
  quantity?: unknown;
  commissionRuleId?: string | null;
}

/** 佣金规则（中间人来源） */
export interface CommissionRuleRef {
  id: string;
  rate?: unknown;
  intermediaryRelationId?: string | null;
  intermediaryName?: string | null;
}

export interface CommissionLine {
  pricingId: string;
  /** 单价佣金（USD） */
  unitCommission: number;
  quantity: number;
  /** 该行佣金总额 = unitCommission × quantity */
  amount: number;
  ruleId: string | null;
  rate: number | null;
  intermediaryRelationId: string | null;
}

export interface CommissionSummary {
  orderId: string;
  /** 参与汇总的已确认定价行数 */
  lineCount: number;
  /** 佣金应付总额（USD） */
  totalCommission: number;
  currency: string;
  /** 中间人（**多行归属不同中间人时为 null**，见 issues） */
  intermediaryRelationId: string | null;
  intermediaryName: string | null;
  lines: CommissionLine[];
  /** 无法归集的原因（**不猜**，显式上报） */
  issues: string[];
  /** 被跳过的草稿/归档行数（透明，不静默丢） */
  skippedRowCount: number;
}

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = typeof v === 'object' ? Number(String(v)) : Number(v);
  return Number.isFinite(n) ? n : null;
};

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** 佣金币种：定价链（netUsdCost/commissionAmount/finalUnitPrice）恒为美元 */
export const COMMISSION_CURRENCY = 'USD';

/** 佣金应付来源标记（幂等判据 = sourceType + sourceId 前缀） */
export const COMMISSION_PAYABLE_SOURCE_TYPE = 'CommissionPayable';

/**
 * ★★ 来源锚点为什么带序号（`<orderId>#<n>`）—— 一个**差点造成死锁**的设计点
 *
 * `Invoice` 上有 `@@unique([sourceType, sourceId])`（schema 注释：「sourceType+sourceId 联合唯一」），
 * 即**同一来源业务单据只能开一张发票**，且该唯一键**不排除 Cancelled**。
 * 若把 `sourceId` 直接写成 `orderId`，就会出现：
 *   开错票 → 作废 → **再也开不出来**（撞唯一键）—— 而"金额算错了要重开"是**真实且常见**的需求。
 * 真库演练 ⑥ 正是这么把这个死锁抓出来的。
 *
 * ⇒ 锚点写成 `<orderId>#<序号>`：既能按前缀查出该订单的全部佣金票（含历史作废票，可追溯），
 *   又让"作废后重开"拿到新的锚点 ⇒ **出口存在**。
 * ⚠️ 分隔符用 `#`：orderId 形如 `ORD__xxxx`，不含 `#`，前缀匹配无歧义。
 */
export function commissionPayableSourceId(orderId: string, seq: number): string {
  return `${orderId}#${seq}`;
}

/** A neighboring Order ID is never this Order's namespace. An exact legacy
 * anchor is loaded only so it cannot be silently ignored and invoiced again. */
export function commissionPayableAnchorQuery(orderId: string) {
  return { OR: [{ sourceId: orderId }, { sourceId: { startsWith: orderId + '#' } }] };
}
export function commissionPayableAnchorSequence(orderId: string, row: { sourceId?: string | null; orderId?: string | null }): number | null {
  if (row.orderId !== orderId || !row.sourceId?.startsWith(orderId + '#')) return null;
  const sequence = row.sourceId.slice(orderId.length + 1);
  if (!/^[1-9]\d*$/.test(sequence) || !Number.isSafeInteger(Number(sequence))) return null;
  return Number(sequence);
}
function unverifiedAnchor(orderId: string, rows: Array<{ sourceId?: string | null; orderId?: string | null }>): boolean {
  return rows.some(row => commissionPayableAnchorSequence(orderId, row) === null);
}

/** 从锚点反解订单 id（供查询/追溯；非法锚点返回原串） */
export function orderIdFromSourceId(sourceId?: string | null): string | null {
  const v = (sourceId ?? '').trim();
  if (!v) return null;
  const i = v.lastIndexOf('#');
  return i > 0 ? v.slice(0, i) : v;
}

/**
 * 纯函数：汇总某订单的佣金应付。
 *
 * @param rows 该订单的定价计算行
 * @param rulesById 相关佣金规则（含行引用的规则；默认规则可另传）
 */
export function summarizeOrderCommission(input: {
  orderId: string;
  rows: CommissionPricingRowRef[];
  rulesById?: Map<string, CommissionRuleRef>;
}): CommissionSummary {
  const { orderId, rows = [] } = input;
  const rules = input.rulesById ?? new Map<string, CommissionRuleRef>();

  const lines: CommissionLine[] = [];
  const issues: string[] = [];
  let skippedRowCount = 0;
  let missingQuantity = 0;
  let noRule = 0;

  for (const r of rows) {
    const status = (r.status ?? '').trim();
    if (status !== 'Confirmed') { skippedRowCount += 1; continue; }

    const unit = num(r.commissionAmount);
    if (unit == null || unit <= 0) continue; // 无佣金的行（0/缺）不参与，不算问题

    const qty = num(r.quantity);
    if (qty == null || qty <= 0) {
      // ⚠️ 不按 1 顶替 —— 单价 × 数量，数量缺失就无法算总额
      missingQuantity += 1;
      continue;
    }

    const ruleId = (r.commissionRuleId ?? '').trim() || null;
    const rule = ruleId ? rules.get(ruleId) : null;
    if (!rule) noRule += 1;

    lines.push({
      pricingId: r.id,
      unitCommission: round4(unit),
      quantity: round4(qty),
      amount: round4(unit * qty),
      ruleId,
      rate: rule ? num(rule.rate) : null,
      intermediaryRelationId: rule ? ((rule.intermediaryRelationId ?? '').trim() || null) : null,
    });
  }

  const totalCommission = round4(lines.reduce((s, l) => s + l.amount, 0));

  // 中间人解析：**多行归属不同中间人 → 不猜**（让人工确认，而不是挑一个）
  const intermediaries = [...new Set(lines.map(l => l.intermediaryRelationId).filter((x): x is string => !!x))];
  let intermediaryRelationId: string | null = null;
  let intermediaryName: string | null = null;
  if (intermediaries.length === 1) {
    intermediaryRelationId = intermediaries[0];
    const rule = lines.map(l => (l.ruleId ? rules.get(l.ruleId) : null)).find(r => r && ((r.intermediaryRelationId ?? '').trim() || null) === intermediaryRelationId);
    intermediaryName = rule?.intermediaryName ?? null;
  } else if (intermediaries.length > 1) {
    issues.push(`该订单的佣金归属了 ${intermediaries.length} 个不同的中间人（${intermediaries.join(' / ')}）：系统不猜，请人工拆分或修正佣金规则后再开应付`);
  } else if (lines.length > 0) {
    issues.push('参与汇总的佣金行都没能解析出中间人（规则缺失或规则未填中间人）：请在佣金规则里补上中间人');
  }

  if (missingQuantity > 0) issues.push(`有 ${missingQuantity} 条定价行缺数量，无法算佣金总额（未按 1 顶替）`);
  if (noRule > 0) issues.push(`有 ${noRule} 条定价行引用的佣金规则已不存在：无法确定中间人`);
  if (skippedRowCount > 0) issues.push(`有 ${skippedRowCount} 条定价行不是「已确认」状态，未计入佣金（草稿不算承诺）`);

  return {
    orderId,
    lineCount: lines.length,
    totalCommission,
    currency: COMMISSION_CURRENCY,
    intermediaryRelationId,
    intermediaryName,
    lines,
    issues,
    skippedRowCount,
  };
}

// ────────────────────────────────────────────────────────────────
// 落库（只读汇总 + 开应付发票）
// ────────────────────────────────────────────────────────────────

export type CommissionResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; status: number } };

const ok = <T>(data: T): CommissionResult<T> => ({ ok: true, data });
const fail = (code: string, message: string, status = 400): CommissionResult<never> => ({ ok: false, error: { code, message, status } });

const COMMISSION_VIEW_FAILURE_MESSAGE = '读取订单佣金失败，请稍后重试。';
const COMMISSION_CREATE_FAILURE_MESSAGE = '佣金应付开票结果暂不可确认，请先核对原开票记录后重试。';

// InvoiceMutationResult has no HTTP status. Accept its declared error family;
// The three status codes have cross-domain 400/409 meanings. Here they follow
// finance/route.ts POST / and PATCH /:id's Invoice-specific 400 contract;
// every other code uses the central registry.
const INVOICE_ERROR_CODES: readonly InvoiceMutationErrorCode[] = [
  'INVALID_STATUS', 'INVALID_TRANSITION', 'INVALID_CURRENT_STATUS', 'INVALID_AMOUNT',
  'INVALID_CURRENCY', 'NOT_FOUND', 'STATUS_NOT_MANUAL_SETTABLE', 'CREATE_FAILED', 'UPDATE_FAILED',
  'LINE_ALREADY_ALLOCATED', 'INVOICE_CONSOLIDATION_CUSTOMER_MISMATCH', 'INVOICE_CUSTOMER_MISMATCH',
  'AMOUNT_BELOW_ALLOCATED', 'HAS_ALLOCATIONS', 'SOURCE_CLAIM_CONFLICT', 'REVIEW_STALE',
  'REVIEW_REQUIRED', 'COVERAGE_CONFLICT', 'INVALID_BILLING_SOURCE', 'HANDOFF_CONFLICT',
  'LC_GATE_BLOCKED', 'LC_EXCEPTION_CHECK_FAILED',
  'CONFLICT', 'UNAUTHORIZED', 'FORBIDDEN', 'ACCOUNT_DISABLED', 'AUTHORIZATION_UNAVAILABLE', 'ORDER_NOT_FOUND',
];

function unknownCommissionFailure(error: unknown, mode: 'read' | 'create'): CommissionResult<never> {
  logger.error(`[CommissionPayableService] ${mode} failed`, { error: error instanceof Error ? error.message : String(error) });
  const code = mode === 'read' ? 'COMMISSION_VIEW_FAILED' : 'CREATE_FAILED';
  const safe = safeRouteError(undefined, { fallbackCode: code,
    fallbackMessage: mode === 'read' ? COMMISSION_VIEW_FAILURE_MESSAGE : COMMISSION_CREATE_FAILURE_MESSAGE });
  return fail(code, safe.message, safe.status);
}

const INVOICE_STATUS_VALIDATION_CODES: readonly InvoiceMutationErrorCode[] = [
  'INVALID_STATUS', 'INVALID_TRANSITION', 'INVALID_CURRENT_STATUS',
];

function invoiceFailure(error: InvoiceMutationError | undefined): CommissionResult<never> {
  if (!error || !(INVOICE_ERROR_CODES as readonly string[]).includes(error.code) || typeof error.message !== 'string') {
    return unknownCommissionFailure(error, 'create');
  }
  // These are uncertain write results, including response/read failures after
  // commit. Never carry database diagnostics or claim that a rollback occurred.
  if (error.code === 'CREATE_FAILED' || error.code === 'UPDATE_FAILED') {
    logger.error('[CommissionPayableService] invoice result uncertain', { code: error.code, error: error.message });
    return fail(error.code, COMMISSION_CREATE_FAILURE_MESSAGE, httpStatusOfCode(error.code));
  }
  const status = INVOICE_STATUS_VALIDATION_CODES.includes(error.code)
    ? httpStatusOfCode('VALIDATION_FAILED') : httpStatusOfCode(error.code);
  return fail(error.code, error.message, status);
}

export interface CommissionPayableState {
  /** 已开出的佣金应付发票（未作废） */
  payableInvoices: Array<{ id: string; invoiceNumber: string; amount: number; currency: string; status: string; issueDate: string }>;
  /** 已开票金额合计（同币种） */
  invoicedAmount: number;
  /** 未开票余额 = 佣金总额 − 已开票（<0 说明定价变了/多开，需人工核对） */
  uninvoicedAmount: number;
}

export interface OrderCommissionView extends CommissionSummary, CommissionPayableState {}

/** 读取某订单的佣金应付视图（只读）：佣金总额 + 已开票 + 未开票余额 */
export async function getOrderCommission(prisma: PrismaClient, orderId: string): Promise<CommissionResult<OrderCommissionView>> {
  if (!orderId) return fail('VALIDATION_FAILED', 'orderId 必填');
  try {
    const db: any = prisma as any;

    const order = await db.order.findFirst({ where: { id: orderId, deletedAt: null }, select: { id: true } });
    if (!order) return fail('NOT_FOUND', `订单 ${orderId} 不存在或已删除`, 404);

    const rows: any[] = await db.pricingCalculation.findMany({
      where: { orderId, deletedAt: null },
      select: { id: true, status: true, commissionAmount: true, quantity: true, commissionRuleId: true },
    });

    const ruleIds = [...new Set(rows.map(r => (r.commissionRuleId ?? '').trim()).filter(Boolean))];
    const rules: any[] = ruleIds.length
      ? await db.commissionRule.findMany({ where: { id: { in: ruleIds }, deletedAt: null }, select: { id: true, rate: true, intermediaryRelationId: true, intermediaryName: true } })
      : [];
    // Inspect all history before projecting live balances. Cancelled/deleted
    // legacy anchors remain unverified facts, not permission to invent a new
    // liability. Include exact legacy only as a conflict, never in the balance.
    const invoices: any[] = await db.invoice.findMany({
      where: {
        type: 'Payable',
        sourceType: COMMISSION_PAYABLE_SOURCE_TYPE,
        ...commissionPayableAnchorQuery(orderId),
      },
      orderBy: { issueDate: 'asc' },
      select: { id: true, invoiceNumber: true, amount: true, currency: true, status: true, issueDate: true, sourceId: true, orderId: true, deletedAt: true },
    });
    if (unverifiedAnchor(orderId, invoices)) return fail('CONFLICT', '佣金应付存在未核对的旧来源或非法序号，请保留原票并人工核对', 409);

    return ok(lockedCommissionBalance(orderId, { rows, rules, anchors: invoices }).view);
  } catch (error: unknown) {
    return unknownCommissionFailure(error, 'read');
  }
}

export interface CreateCommissionPayableInput {
  orderId: string;
  /** 应付到期日（可空 —— 与发票模型一致） */
  dueDate?: string | null;
  notes?: string | null;
}

/**
 * 开一张**佣金应付发票**（给中间人的应付）—— 佣金应付的"落地"动作。
 *
 * 幂等：同订单已有未作废的佣金应付发票 → 拒绝（防重复开票；要改先作废原票）。
 * 复用 `createInvoice` 真源（币种白名单/金额校验/取号/审计/事件）。
 */
async function currentCommissionActor(db: any, actorId: string, supplied: TokenPayload | null | undefined): Promise<TokenPayload> {
  if (supplied === null || !actorId || (supplied !== undefined && !supplied.userId))
    throw businessError('UNAUTHORIZED', '请先登录后开佣金应付。');
  if (supplied && supplied.userId !== actorId)
    throw businessError('FORBIDDEN', '佣金应付操作人必须是当前真实账号。');
  const account = await db.userAccount.findFirst({ where: { id: actorId, status: 'active', deletedAt: null }, select: { id: true } });
  if (!account) throw businessError('FORBIDDEN', '当前账号不可开佣金应付。');
  const current = await createPermissionService({ prisma: db }).getUserPermissionContext(actorId);
  if (!current) throw businessError('FORBIDDEN', '当前账号不可开佣金应付。');
  const actor: TokenPayload = { userId: current.userId, roles: current.legacyRoleCodes,
    roleIds: current.roleIds, permissions: current.scopes, departmentIds: current.departmentIds,
    authorizationLoaded: true,
    ...(supplied?.permissionCeiling !== undefined ? { permissionCeiling: [...supplied.permissionCeiling] } : {}) };
  if (!current.scopes.includes('pricing:write') || !hasScope(actor, 'pricing:write'))
    throw businessError('FORBIDDEN', '当前权限不足以开佣金应付。');
  return actor;
}
async function requireCurrentCommissionOrder(db: any, orderId: string, actorId: string, supplied: TokenPayload | null | undefined) {
  const actor = await currentCommissionActor(db, actorId, supplied);
  const scope = await buildOrderListScopeWhere(db, actor, { fresh: true });
  if (!await db.order.findFirst({ where: { id: orderId, deletedAt: null, AND: [scope] }, select: { id: true } }))
    throw businessError('NOT_FOUND', '订单不存在或不在当前业务范围内。');
  return actor;
}
interface CommissionSources { rows: any[]; rules: any[]; anchors: any[] }
async function readCommissionSources(db: any, orderId: string, ignoreInvoiceId?: string): Promise<CommissionSources> {
  const rows = await db.pricingCalculation.findMany({ where: { orderId, deletedAt: null },
    select: { id: true, orderId: true, status: true, commissionAmount: true, quantity: true, commissionRuleId: true, deletedAt: true } });
  const ruleIds = [...new Set<string>(rows.map((row: any) => (row.commissionRuleId ?? '').trim()).filter(Boolean))].sort();
  const rules = ruleIds.length ? await db.commissionRule.findMany({ where: { id: { in: ruleIds }, deletedAt: null },
    select: { id: true, rate: true, intermediaryRelationId: true, intermediaryName: true, isActive: true, deletedAt: true } }) : [];
  const anchors = await db.invoice.findMany({ where: { type: 'Payable', sourceType: COMMISSION_PAYABLE_SOURCE_TYPE,
    ...commissionPayableAnchorQuery(orderId), ...(ignoreInvoiceId ? { id: { not: ignoreInvoiceId } } : {}) },
    select: { id: true, invoiceNumber: true, amount: true, currency: true, status: true, issueDate: true,
      sourceId: true, orderId: true, deletedAt: true } });
  return { rows, rules, anchors };
}
function commissionSourceSignature(source: CommissionSources): string {
  const scalar = (value: any) => value == null ? null : String(value);
  return JSON.stringify({
    rows: [...source.rows].sort((a,b) => a.id.localeCompare(b.id)).map(row =>
      [row.id, row.orderId, row.status, scalar(row.commissionAmount), scalar(row.quantity), row.commissionRuleId, scalar(row.deletedAt)]),
    rules: [...source.rules].sort((a,b) => a.id.localeCompare(b.id)).map(row =>
      [row.id, scalar(row.rate), row.intermediaryRelationId, row.intermediaryName, row.isActive, scalar(row.deletedAt)]),
    anchors: [...source.anchors].sort((a,b) => a.id.localeCompare(b.id)).map(row =>
      [row.id, row.invoiceNumber, scalar(row.amount), row.currency, row.status, row.issueDate, row.sourceId, row.orderId, scalar(row.deletedAt)]),
  });
}
async function lockCommissionSources(tx: any, orderId: string): Promise<CommissionSources> {
  const parents = await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id"=${orderId} AND "deletedAt" IS NULL FOR UPDATE`);
  if (!parents.length) throw businessError('NOT_FOUND', '订单不存在或已删除。');
  const hints = await readCommissionSources(tx, orderId);
  const priceIds = [...new Set<string>(hints.rows.map(row => row.id))].sort();
  if (priceIds.length) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "PricingCalculation" WHERE "id" IN (${Prisma.join(priceIds)}) ORDER BY "id" FOR UPDATE`);
  const ruleIds = [...new Set<string>(hints.rules.map(row => row.id))].sort();
  if (ruleIds.length) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "CommissionRule" WHERE "id" IN (${Prisma.join(ruleIds)}) ORDER BY "id" FOR UPDATE`);
  const invoiceIds = [...new Set<string>(hints.anchors.map(row => row.id))].sort();
  if (invoiceIds.length) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Invoice" WHERE "id" IN (${Prisma.join(invoiceIds)}) ORDER BY "id" FOR UPDATE`);
  const locked = await readCommissionSources(tx, orderId);
  if (commissionSourceSignature(hints) !== commissionSourceSignature(locked))
    throw businessError('CONFLICT', '佣金应付来源在取得锁时变化，请刷新后核对原记录。');
  return locked;
}
async function recheckCommissionSources(tx: any, orderId: string, source: CommissionSources, ignoreInvoiceId: string) {
  if (commissionSourceSignature(source) !== commissionSourceSignature(await readCommissionSources(tx, orderId, ignoreInvoiceId)))
    throw businessError('CONFLICT', '佣金应付来源在写入时变化，请核对原记录后重试。');
}

class CommissionAbort extends Error {
  constructor(readonly refusal: CommissionResult<never>) { super('Commission Payable refused'); }
}
function refuseCommissionView(c: OrderCommissionView): CommissionResult<never> | null {
  if (c.totalCommission <= 0) return fail('NO_COMMISSION', '该订单没有已确认的佣金（定价行未确认 / 佣金率为 0），无需开应付', 409);
  if (!c.intermediaryRelationId) return fail('INTERMEDIARY_UNRESOLVED',
    `无法确定收佣金的中间人：${c.issues.join('；') || '佣金规则未填中间人'}。请先在佣金规则里补上中间人，再开应付`, 409);
  if (c.uninvoicedAmount <= 0) return fail('ALREADY_INVOICED',
    `该订单的佣金应付已开票（已开 ${c.invoicedAmount} ${c.currency}，共 ${c.totalCommission}），无需重复开票；如需调整请先作废原发票`, 409);
  return null;
}
/** Stored financial decimals remain exact through multiplication, aggregation
 * and subtraction. Numbers are only the existing read-view representation. */
function lockedCommissionBalance(orderId: string, source: CommissionSources) {
  const summary = summarizeOrderCommission({ orderId, rows: source.rows,
    rulesById: new Map(source.rules.map(rule => [rule.id, rule])) });
  let total = new Prisma.Decimal(0);
  for (const line of summary.lines) {
    const row = source.rows.find(row => row.id === line.pricingId)!;
    total = total.plus(new Prisma.Decimal(String(row.commissionAmount))
      .times(new Prisma.Decimal(String(row.quantity))).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP));
  }
  const live = source.anchors.filter(row => row.deletedAt === null && row.status !== 'Cancelled');
  const invoiced = live.filter(row => row.currency === COMMISSION_CURRENCY).reduce((sum, row) =>
    sum.plus(new Prisma.Decimal(String(row.amount))), new Prisma.Decimal(0)).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
  const remaining = total.minus(invoiced).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
  const view: OrderCommissionView = { ...summary, totalCommission: total.toNumber(),
    payableInvoices: live.map(row => ({ id: row.id, invoiceNumber: row.invoiceNumber, amount: Number(row.amount),
      currency: row.currency, status: row.status, issueDate: row.issueDate })),
    invoicedAmount: invoiced.toNumber(), uninvoicedAmount: remaining.toNumber() };
  // Preserve the legacy numeric adapter for exact round-trips; larger amounts
  // stay decimal text rather than silently lose cents in IEEE-754 conversion.
  const numeric = remaining.toNumber();
  return { view, total, remaining, amount: new Prisma.Decimal(numeric).eq(remaining) ? numeric : remaining.toFixed(4) };
}

export async function createCommissionPayable(
  prisma: PrismaClient,
  input: CreateCommissionPayableInput,
  actorId: string,
  trustedActor?: TokenPayload | null,
): Promise<CommissionResult<{ invoice: any; commission: OrderCommissionView }>> {
  if (!input?.orderId) return fail('VALIDATION_FAILED', 'orderId 必填');
  const effects: Array<() => Promise<void>> = [];
  try {
    // Read-only preflight may refuse but never supplies a write amount. Every
    // accepted command reloads its sources and authority inside the native TX.
    await requireCurrentCommissionOrder(prisma, input.orderId, actorId, trustedActor);
    const preview = await getOrderCommission(prisma, input.orderId);
    if (!preview.ok) return preview;
    const previewRefusal = preview.data.totalCommission <= 0 || !preview.data.intermediaryRelationId
      ? refuseCommissionView(preview.data) : null;
    if (previewRefusal) return previewRefusal;
    const previewAnchors = await prisma.invoice.findMany({
      where: { type: 'Payable', sourceType: COMMISSION_PAYABLE_SOURCE_TYPE, ...commissionPayableAnchorQuery(input.orderId) },
      select: { sourceId: true, orderId: true },
    });
    if (unverifiedAnchor(input.orderId, previewAnchors))
      return fail('CONFLICT', '佣金应付存在未核对的旧来源或非法序号，请保留原票并人工核对', 409);

    const result = await prisma.$transaction(async tx => {
      await requireCurrentCommissionOrder(tx, input.orderId, actorId, trustedActor);
      const source = await lockCommissionSources(tx, input.orderId);
      await requireCurrentCommissionOrder(tx, input.orderId, actorId, trustedActor);
      if (unverifiedAnchor(input.orderId, source.anchors))
        throw businessError('CONFLICT', '佣金应付存在未核对的旧来源或非法序号，请保留原票并人工核对');
      const balance = lockedCommissionBalance(input.orderId, source), c = balance.view;
      // Decimal comparisons, not the read view's floating-point projection,
      // govern the financial write.
      if (balance.total.lte(0)) throw new CommissionAbort(refuseCommissionView(c)!);
      if (!c.intermediaryRelationId) throw new CommissionAbort(refuseCommissionView(c)!);
      if (balance.remaining.lte(0)) throw new CommissionAbort(refuseCommissionView(c)!);
      const used = source.anchors.map(row => commissionPayableAnchorSequence(input.orderId, row)!);
      const nextSeq = (used.length ? Math.max(...used) : 0) + 1;
      if (!Number.isSafeInteger(nextSeq)) throw new CommissionAbort(fail('CONFLICT', '佣金应付来源序号已超出安全范围，请保留原票并人工核对', 409));

      // The producer retains its delegated AP compatibility. It receives no
      // invoice-write token: current pricing authority is checked here and at
      // its mandatory audit boundary, in this same transaction.
      const guardedAudit = new Proxy(tx.auditLog, { get(target, property) {
        if (property === 'create') return async (args: any) => {
          await requireCurrentCommissionOrder(tx, input.orderId, actorId, trustedActor);
          await recheckCommissionSources(tx, input.orderId, source, args.data.targetId);
          return target.create(args);
        };
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
      } });
      const guardedTx = new Proxy(tx, { get(target, property) {
        if (property === 'auditLog') return guardedAudit;
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
      } });
      const invoiceResult = await createInvoice({ prisma, actorId,
        transaction: { tx: guardedTx, deferAfterCommit: work => { effects.push(work); } },
        input: { type: 'Payable', status: 'Issued', amount: balance.amount, currency: c.currency,
          issueDate: todayLocalKey(), dueDate: input.dueDate ?? null, orderId: input.orderId,
          customerRelationId: c.intermediaryRelationId, customerName: c.intermediaryName ?? null,
          sourceType: COMMISSION_PAYABLE_SOURCE_TYPE, sourceId: commissionPayableSourceId(input.orderId, nextSeq),
          notes: input.notes ?? `订单 ${input.orderId} 中间人佣金应付（${c.lineCount} 条定价行，佣金率见各行快照）` } });
      // Canonical refusals are Result values. Returning them would commit any
      // native writes already attempted; throw so the owning transaction aborts.
      if (!invoiceResult.ok) throw new CommissionAbort(invoiceFailure(invoiceResult.error));
      return invoiceResult;
    });
    for (const effect of effects) await effect();
    const after = await getOrderCommission(prisma, input.orderId);
    if (!after.ok) return unknownCommissionFailure(after.error, 'create');
    return ok({ invoice: result.data?.invoice ?? null, commission: after.data });
  } catch (error: unknown) {
    if (error instanceof CommissionAbort) return error.refusal;
    if (isBusinessError(error) && (INVOICE_ERROR_CODES as readonly string[]).includes(error.code)) {
      const safe = safeRouteError(error, { fallbackCode: 'CREATE_FAILED' });
      return invoiceFailure({ code: error.code as InvoiceMutationErrorCode, message: safe.message });
    }
    return unknownCommissionFailure(error, 'create');
  }
}

export { Prisma };
