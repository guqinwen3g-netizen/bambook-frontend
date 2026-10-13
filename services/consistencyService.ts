/**
 * consistencyService.ts — 一致性核对统一入口（T7 系列 + D2 的 5 个核对端点）
 *
 * 为什么单独一个 service：这 5 个核对横跨 finance / customs 两域
 * （多币种对账、收汇↔FOB 在 finance；三单一致、退税报缺、成交方式在 customs），
 * 放任一现有 service 都会污染其语义；工作台需要统一入口，故独立成文件。
 *
 * 口径（全部一致）：**只预警不阻断** —— 差异 severity 恒为 'warning'，UI 按"提示"色阶渲染，
 * 不出现阻断性红。汇率/单位一律不做跨口径换算（口径 A）。
 */
import { apiService } from './apiService';

// ─── 通用 ────────────────────────────────────────────────────────────────
export interface ConsistencyDiscrepancy {
  type: string;
  field: string;
  expected: string;
  actual: string;
  severity: 'warning' | 'critical' | 'info';
  message: string;
}

async function getJson<T>(path: string, endpoint?: string): Promise<T> {
  const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
  const url = apiService.buildApiUrl(path, base);
  const res = await fetch(url, { headers: apiService.getAuthHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `核对失败：HTTP ${res.status}`);
  return data as T;
}

// ─── T7-② 三单一致（箱单 / 商业发票 / 报关单）────────────────────────────
export interface TripleConsistencyResult {
  shipmentId: string;
  shipmentNumber: string | null;
  documents: {
    packingList: { id: string; documentNumber: string; status: string } | null;
    commercialInvoice: { id: string; documentNumber: string; status: string; invoiceId: string | null; invoiceNumber: string | null } | null;
    customsDeclaration: { id: string; declarationNumber: string; status: string } | null;
  };
  internal: { quantityTotal: number; totalPackages: number | null; grossWeight: number | null; netWeight: number | null; invoiceAmount: number | null; invoiceCurrency: string | null; lineCount: number };
  declared: { quantityTotal: number; totalPackages: number | null; grossWeight: number | null; netWeight: number | null; totalValue: number | null; currency: string | null; lineCount: number };
  discrepancies: ConsistencyDiscrepancy[];
}

// ─── T7-③ 收汇 ↔ 报关 FOB ───────────────────────────────────────────────
export interface ReceiptFobCurrencyRow {
  currency: string;
  receiptAmount: number;
  declaredFob: number;
  declaredGross: number;
  strippedFreight: number;
  strippedInsurance: number;
  difference: number;
  differencePct: number | null;
  tolerance: number;
  toleranceBasis: string;
  withinTolerance: boolean;
  unStrippable: Array<{ declarationNumber: string; reason: string }>;
}

export interface ReceiptFobResult {
  orderId: string;
  orderCode: string | null;
  customerName: string | null;
  byCurrency: ReceiptFobCurrencyRow[];
  discrepancies: ConsistencyDiscrepancy[];
  receiptVoucherCount: number;
  declarationCount: number;
  /** 该订单应收发票中最早的到期日（付款期限）；无应收发票 → null */
  paymentDueDate: string | null;
  /**
   * 尚未到收款期。⚠️ 此时「收汇不足」**被门槛压住不出现在 discrepancies 里** ——
   * 界面必须显式说明，否则「0 差异」会被误读成「对账通过」（实为「还没到期，未判定」）。
   * 「收汇多于 FOB」不受门槛影响。
   */
  notYetDue: boolean;
}

// ─── T7-④ 退税报缺 ──────────────────────────────────────────────────────
export interface TaxRefundGap { code: string; label: string; howToFix: string; ref?: string }

export interface TaxRefundGapsResult {
  declarationId: string;
  declarationNumber: string;
  figures: {
    fxRate: number | null;
    exportAmountFob: number | null;
    exportAmountCny: number | null;
    refundableVat: number | null;
    refundableRate: number | null;
    refundAmount: number | null;
    lineCount: number;
    gaps: TaxRefundGap[];
  };
  gaps: TaxRefundGap[];
}

// ─── D2 成交方式一致性 ───────────────────────────────────────────────────
export interface IncotermConsistencyResult {
  declarationId: string;
  declarationNumber: string;
  orderId: string | null;
  orderCode: string | null;
  orderTerms: string | null;
  orderGroup: string | null;
  declarationTerms: string | null;
  declarationGroup: string | null;
  consistent: boolean;
  sameGroup: boolean;
  discrepancies: ConsistencyDiscrepancy[];
}

export const consistencyService = {
  /** T7-② 三单一致（锚点：运单） */
  getTripleConsistency(shipmentId: string, endpoint?: string) {
    return getJson<TripleConsistencyResult>(`/v2/customs/shipments/${encodeURIComponent(shipmentId)}/triple-consistency`, endpoint);
  },

  /** T7-③ 收汇 ↔ 报关 FOB（锚点：订单） */
  getReceiptFob(orderId: string, endpoint?: string) {
    return getJson<ReceiptFobResult>(`/v1/reconciliation/orders/${encodeURIComponent(orderId)}/receipt-fob`, endpoint);
  },

  /** T7-④ 退税报缺（锚点：报关单） */
  getTaxRefundGaps(declarationId: string, endpoint?: string) {
    return getJson<TaxRefundGapsResult>(`/v2/customs/declarations/${encodeURIComponent(declarationId)}/tax-refund/gaps`, endpoint);
  },

  /** D2 成交方式 ↔ 订单 Incoterms 一致性（锚点：报关单） */
  getIncotermConsistency(declarationId: string, endpoint?: string) {
    return getJson<IncotermConsistencyResult>(`/v2/customs/declarations/${encodeURIComponent(declarationId)}/incoterm-consistency`, endpoint);
  },
};
