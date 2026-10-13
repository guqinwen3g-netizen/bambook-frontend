/**
 * Reconciliation API service — W-B 波次 P2-6 客户四单对账（订单↔出运↔开票↔收款）。
 * Communicates with /api/v1/reconciliation endpoints:
 *   GET  /orders/:orderId          — 单订单四单勾稽
 *   GET  /customers/:customerId    — 客户维度批量对账 + 汇总
 *   GET  /discrepancies            — 全量差异清单（severity 排序，分页/筛选）
 *   POST /orders/:orderId/refresh  — 强制重算（幂等，与 GET 同口径）
 *
 * 类型定义内聚在本文件（root types.ts 为冻结区，禁止编辑）。
 */
import { apiService } from './apiService';

export type DiscrepancySeverity = 'critical' | 'warning' | 'info';

export type DiscrepancyType =
  | 'quantity_mismatch'
  | 'invoice_amount_mismatch'
  | 'payment_mismatch'
  | 'status_inconsistency'
  | 'currency_mismatch'
  | 'manual_payment_field_drift'
  // P2-7 汇率链差异（全量清单拍平类型；type=fx 聚合筛选全部三段）
  | 'fx_order_to_invoice'
  | 'fx_invoice_to_payment'
  | 'fx_payment_to_settlement';

export interface ReconciliationDiscrepancy {
  type: DiscrepancyType;
  field: string;
  expected: string;
  actual: string;
  severity: DiscrepancySeverity;
  message: string;
}

// ────────────────────────────────────────────────────────────────
// P2-7 多币种汇率链（与后端 fxReconciliationService 同源）
// ────────────────────────────────────────────────────────────────

export type FxChainSegmentType = 'order_to_invoice' | 'invoice_to_payment' | 'payment_to_settlement';
export type FxRateSource = 'locked' | 'market' | 'upstream' | 'missing';

export interface FxDiscrepancy {
  type: FxChainSegmentType;
  fromCurrency: string;
  toCurrency: string;
  expectedRate: number | null;
  actualRate: number | null;
  variance: number | null;
  variancePct: number | null;
  severity: DiscrepancySeverity;
  message: string;
  locked: boolean;
  documentKind: 'invoice' | 'voucher' | 'settlement';
  documentId: string;
  documentNumber: string;
  foreignAmount: number;
  gainLossCny: number | null;
}

export interface FxChainSegment {
  stage: FxChainSegmentType;
  documentKind: 'invoice' | 'voucher' | 'settlement';
  documentId: string;
  documentNumber: string;
  currency: string;
  foreignAmount: number;
  documentRate: number | null;
  expectedRate: number | null;
  rateSource: FxRateSource;
  variance: number | null;
  variancePct: number | null;
  gainLossCny: number | null;
  locked: boolean;
}

export interface OrderFxDetail {
  orderId: string;
  baseCurrency: string;
  locks: Array<{ id: string; currency: string; rate: number }>;
  segments: FxChainSegment[];
  fxDiscrepancies: FxDiscrepancy[];
  realizedGainLossCny: number;
  invoicedByCurrency: Array<{ currency: string; amount: number; lockedAmount: number }>;
}

export interface CustomerFxCurrencySummary {
  currency: string;
  invoicedAmount: number;
  lockedAmount: number;
  coveragePct: number;
  realizedGainLossCny: number;
}

export const FX_SEGMENT_LABELS: Record<FxChainSegmentType, string> = {
  order_to_invoice: '订单 → 开票',
  invoice_to_payment: '开票 → 收付',
  payment_to_settlement: '收付 → 结汇',
};

export const FX_RATE_SOURCE_LABELS: Record<FxRateSource, string> = {
  locked: '锁定价',
  market: '市场价',
  upstream: '上游单据',
  missing: '缺档案',
};

export interface OrderReconciliation {
  orderId: string;
  orderCode: string | null;
  poNumber: string | null;
  customerName: string | null;
  customerRelationId: string | null;
  currency: string | null;
  orderAmount: number;
  orderStatus: string;
  orderedQty: number;
  shippedQty: number;
  delivered: boolean;
  /** T7-①：只在同币种内合并；跨币种 → null（分币种明细见 invoicedByCurrency） */
  invoicedAmount: number | null;
  paidAmount: number | null;
  invoicedByCurrency: CurrencyAmount[];
  paidByCurrency: CurrencyAmount[];
  invoiceCount: number;
  /** T7-① 口径 A-2/A-3：已结汇部分按结汇汇率折算的 CNY 合计（未结汇不计入） */
  settledCny: number;
  /** T7-④ 已退税 CNY（status='Refunded'）；已回笼 = settledCny + refundedCny */
  refundedCny: number;
  referenceActualPaymentAmount: number | null;
  discrepancies: ReconciliationDiscrepancy[];
  fxDiscrepancies: FxDiscrepancy[]; // P2-7 汇率链显著差异
  fx: OrderFxDetail;                // P2-7 三段对照 + 锁汇 + 已实现损益
}

/** T7-① 按币种分组的金额行 */
export interface CurrencyAmount {
  currency: string;
  amount: number;
}

/** T7-① 客户维度按币种分组的三档金额（跨币种不合并的真源） */
export interface CustomerCurrencyTotals {
  currency: string;
  orderAmount: number;
  invoicedAmount: number;
  paidAmount: number;
}

export interface CustomerReconciliationSummary {
  customerRelationId: string;
  totalOrders: number;
  discrepancyOrders: number;
  /** T7-①：客户下币种唯一（或全空）时才有值；跨币种 → null（改看 totalByCurrency） */
  totalOrderAmount: number | null;
  totalInvoicedAmount: number | null;
  totalPaidAmount: number | null;
  totalByCurrency: CustomerCurrencyTotals[];
  /** T7-① 已结汇按结汇汇率折算的 CNY 合计 */
  settledCnyTotal: number;
  /** T7-④ 已退税 CNY 合计；已回笼 = settledCnyTotal + refundedCnyTotal */
  refundedCnyTotal: number;
  criticalCount: number;
  warningCount: number;
  infoCount: number;
  fxGainLossTotal: CustomerFxCurrencySummary[]; // P2-7 多币种汇总（按币种分组）
}

export interface DiscrepancyListItem extends ReconciliationDiscrepancy {
  orderId: string;
  orderCode: string | null;
  poNumber: string | null;
  customerName: string | null;
  customerRelationId: string | null;
  currency: string | null;
  orderAmount: number;
}

export const DISCREPANCY_TYPE_LABELS: Record<DiscrepancyType, string> = {
  quantity_mismatch: '数量差异',
  invoice_amount_mismatch: '开票差异',
  payment_mismatch: '收款差异',
  status_inconsistency: '状态不一致',
  currency_mismatch: '币种不一致',
  manual_payment_field_drift: '手工实收漂移',
  fx_order_to_invoice: '汇率·订单→开票',
  fx_invoice_to_payment: '汇率·开票→收付',
  fx_payment_to_settlement: '汇率·收付→结汇',
};

export const SEVERITY_LABELS: Record<DiscrepancySeverity, string> = {
  critical: '严重',
  warning: '警示',
  info: '提示',
};

// ─── H16-② 客户对账回执（内部侧查看）──────────────────────────────────────
/** 回执状态（与后端 CustomerReconciliationAck.status 同口径） */
export type AckStatus = 'confirmed' | 'disputed';

export const ACK_STATUS_LABELS: Record<AckStatus, string> = {
  confirmed: '已确认',
  disputed: '有异议',
};

/** 回执里冻结的对账快照（按币种分组 —— 跨币种不合并，T7-① 口径） */
export interface AckSnapshotCurrencyRow {
  currency: string;
  openingBalance?: number;
  invoiced?: number;
  received?: number;
  closingBalance?: number;
}

export interface ReconciliationAckItem {
  id: string;
  customerRelationId: string;
  /** 客户名（后端由 Relation 补；缺失为 null） */
  customerName: string | null;
  customerUserName: string | null;
  periodStart: string;
  periodEnd: string;
  status: string;
  /** 异议说明（status=disputed 时必有） */
  disputeNote: string | null;
  snapshot: { byCurrency?: AckSnapshotCurrencyRow[]; capturedAt?: string } | null;
  ip: string | null;
  createdAt: number;
}

export interface ReconciliationAckListResult {
  items: ReconciliationAckItem[];
  total: number;
  page: number;
  pageSize: number;
  /** 同一基础筛选（客户/期间）下的两态计数；**不受 status 筛选影响**（后端口径） */
  summary: { confirmed: number; disputed: number; total: number };
}

async function readError(res: Response, fallback: string): Promise<never> {
  let data: any = null;
  try { data = await res.json(); } catch { /* ignore */ }
  const rawMessage = data?.error?.message ?? data?.message ?? `${fallback} (HTTP ${res.status})`;
  const code = data?.error?.code ?? data?.code;
  const message = typeof rawMessage === 'string' ? rawMessage : JSON.stringify(rawMessage);
  const err: any = new Error(code && data?.message && !message.includes(code) ? `${code}：${message}` : message);
  err.status = res.status;
  err.code = code;
  throw err;
}

function reconciliationUrl(path: string, endpoint?: string): string {
  const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
  return apiService.buildApiUrl(`/v1/reconciliation${path}`, base);
}

export const reconciliationService = {
  /** 单订单四单勾稽 */
  async reconcileOrder(orderId: string, endpoint?: string): Promise<OrderReconciliation> {
    const res = await fetch(reconciliationUrl(`/orders/${encodeURIComponent(orderId)}`, endpoint), {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) await readError(res, 'reconcileOrder failed');
    return res.json();
  },

  /** 强制重算（幂等，与 GET 同口径；预留缓存失效语义） */
  async refreshOrder(orderId: string, endpoint?: string): Promise<OrderReconciliation> {
    const res = await fetch(reconciliationUrl(`/orders/${encodeURIComponent(orderId)}/refresh`, endpoint), {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) await readError(res, 'refreshOrder failed');
    const data = await res.json();
    return data.result as OrderReconciliation;
  },

  /** 客户维度批量对账 */
  async reconcileCustomer(
    customerId: string,
    endpoint?: string,
  ): Promise<{ summary: CustomerReconciliationSummary; orders: OrderReconciliation[] }> {
    const res = await fetch(reconciliationUrl(`/customers/${encodeURIComponent(customerId)}`, endpoint), {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) await readError(res, 'reconcileCustomer failed');
    return res.json();
  },

  /** 全量差异清单（severity 排序，分页/筛选；type=fx 聚合筛选全部汇率链差异） */
  async listDiscrepancies(
    params: { severity?: DiscrepancySeverity | ''; type?: DiscrepancyType | 'fx' | ''; customerRelationId?: string; page?: number; pageSize?: number } = {},
    endpoint?: string,
  ): Promise<{ items: DiscrepancyListItem[]; total: number; page: number; pageSize: number }> {
    const query = new URLSearchParams();
    if (params.severity) query.set('severity', params.severity);
    if (params.type) query.set('type', params.type);
    if (params.customerRelationId) query.set('customerRelationId', params.customerRelationId);
    if (params.page) query.set('page', String(params.page));
    if (params.pageSize) query.set('pageSize', String(params.pageSize));
    const qs = query.toString();
    const res = await fetch(`${reconciliationUrl('/discrepancies', endpoint)}${qs ? `?${qs}` : ''}`, {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) await readError(res, 'listDiscrepancies failed');
    const data = await res.json();
    return {
      items: Array.isArray(data.items) ? data.items : [],
      total: Number(data.total ?? 0),
      page: Number(data.page ?? 1),
      pageSize: Number(data.pageSize ?? 50),
    };
  },

  /**
   * 客户对账回执列表（H16-② 内部侧入口）。
   * 期间筛选用**区间相交**（跨月对账单按「9 月」筛也会命中）；summary 不受 status 筛选影响。
   */
  async listAcks(
    params: { relationId?: string; status?: AckStatus | ''; periodFrom?: string; periodTo?: string; limit?: number; offset?: number } = {},
    endpoint?: string,
  ): Promise<ReconciliationAckListResult> {
    const query = new URLSearchParams();
    if (params.relationId) query.set('relationId', params.relationId);
    if (params.status) query.set('status', params.status);
    if (params.periodFrom) query.set('periodFrom', params.periodFrom);
    if (params.periodTo) query.set('periodTo', params.periodTo);
    if (params.limit) query.set('limit', String(params.limit));
    if (params.offset) query.set('offset', String(params.offset));
    const qs = query.toString();
    const res = await fetch(`${reconciliationUrl('/acks', endpoint)}${qs ? `?${qs}` : ''}`, {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) await readError(res, 'listAcks failed');
    const data = await res.json();
    return {
      items: Array.isArray(data.items) ? data.items : [],
      total: Number(data.total ?? 0),
      page: Number(data.page ?? 1),
      pageSize: Number(data.pageSize ?? 50),
      summary: {
        confirmed: Number(data.summary?.confirmed ?? 0),
        disputed: Number(data.summary?.disputed ?? 0),
        total: Number(data.summary?.total ?? 0),
      },
    };
  },
};
