/**
 * 阶段 D / D3：订单全链路聚合 API service。
 * 只读 — 对应后端 GET /api/v1/orders/:id/context（直接查表制，按业务阶段分组）。
 */
import { apiService } from './apiService';

export interface OrderContextQuotation {
  id: string; quotationNumber: string; status: string;
  currency: string; totalAmount: number; issueDate: string;
}

export interface OrderContextSampleNode {
  id: string; developmentCaseId: string; level: string; round: number;
  status: string; sentDate?: string | null; approvedAt?: number | null;
}

export interface OrderContextDevelopmentCase {
  id: string; code: string; name: string; type: string; stage: string; currentRound: number;
  sampleNodes: OrderContextSampleNode[];
}

export interface OrderContextBom {
  id: string; bomNumber: string; status: string; version: number;
  totalCost: number | null; currency: string;
}

export interface OrderContextProcurement {
  id: string; poNumber: string; status: string; supplierName?: string | null;
  currency: string; totalAmount: number;
  orderDate: string; expectedDeliveryDate?: string | null; actualDeliveryDate?: string | null;
}

export interface OrderContextProductionStage {
  id: string; stageKey: string; stageSeq: number; status: string;
  startedAt?: number | null; doneAt?: number | null;
}

export interface OrderContextInspection {
  id: string; inspectionType: string; result?: string | null; inspectionDate?: string | null;
  aqlLevel?: string | null; criticalDefects: number; majorDefects: number; minorDefects: number;
}

export interface OrderContextOutsourcing {
  id: string; orderNumber: string; processType: string; status: string;
  quantity: number; unit: string;
  plannedDeliveryDate?: string | null; actualDeliveryDate?: string | null;
  qualityAcceptedQty: number; qualityRejectedQty: number;
}

export interface OrderContextTaxRefund {
  id: string; refundNumber: string; status: string; declarationId?: string | null;
  exportAmountFob?: number | null; exportAmountFobCurrency?: string | null;
  refundAmount?: number | null; refundDate?: string | null;
  sharedSource?: boolean;
}

export interface OrderContextCustomsDeclaration {
  id: string; declarationNumber: string; status: string; shipmentId?: string | null;
  declarationDate?: string | null; totalValue?: number | null; currency?: string | null;
  taxRefunds: OrderContextTaxRefund[];
  sharedSource?: boolean;
}

export interface OrderContextShipment {
  id: string; shipmentNumber: string; status: string; shippingMethod: string;
  etd?: string | null; atd?: string | null; eta?: string | null; ata?: string | null;
  portOfLoading?: string | null; portOfDischarge?: string | null;
  customsDeclarations: OrderContextCustomsDeclaration[];
  sharedSource?: boolean;
}

export interface OrderContextAllocation {
  id: string; invoiceId: string; voucherId: string | null; appliedAmount: number | null; appliedDate: string;
  sharedSource?: boolean;
}

export interface OrderContextInvoice {
  id: string; invoiceNumber: string; type: string; status: string;
  amount: number | null; currency: string;
  /** Exact IOA share for this Order; separate from the original invoice total. */
  orderAllocatedAmount?: string | null;
  amountScope?: 'invoice_total' | 'restricted_shared';
  sharedSource?: boolean;
  issueDate: string; dueDate?: string | null; settlementDate?: string | null;
  allocations: OrderContextAllocation[];
}

export interface OrderContextVoucher {
  id: string; voucherNumber: string; type: string; status: string;
  amount: number; currency: string; paymentDate: string; invoiceId?: string | null;
}

export interface OrderContext {
  /** Unreadable domains; distinct from a readable domain with no linked records. */
  restrictedStages?: string[];
  order: { id: string; poNumber: string | null; settledAt?: number | null; settledBy?: string | null };
  quotation: OrderContextQuotation[];
  developmentCase: OrderContextDevelopmentCase[];
  bom: OrderContextBom[];
  procurement: OrderContextProcurement[];
  production: { stages: OrderContextProductionStage[]; inspections: OrderContextInspection[] };
  outsourcing: OrderContextOutsourcing[];
  shipments: OrderContextShipment[];
  /** 未挂到本订单运单的报关单（按 orderId 直连的） */
  customsDeclarations: OrderContextCustomsDeclaration[];
  /** 未挂到报关单的退税记录 */
  taxRefunds: OrderContextTaxRefund[];
  finance: { invoices: OrderContextInvoice[]; vouchers: OrderContextVoucher[] };
}

export const orderContextService = {
  async getOrderContext(orderId: string, endpoint?: string): Promise<OrderContext> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/orders/${encodeURIComponent(orderId)}/context`, base);
    const res = await fetch(url, {
      headers: apiService.getAuthHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data?.message || data?.error || `getOrderContext failed: HTTP ${res.status}`);
    return data as OrderContext;
  },
};
