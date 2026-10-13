/**
 * VatInvoice API service（阶段 C6 增值税发票全生命周期）.
 * Communicates with /api/v1/finance/vat-invoices endpoints.
 *
 * 契约要点：
 *   - 金额三栏服务端校验：totalAmount = netAmount + taxAmount（精确）；
 *     taxAmount ≈ netAmount × taxRate/100（开票尾差容差 ±0.02）
 *   - 查重：(vatCode, vatNumber) 复合唯一，重复票被服务端拒绝（DUPLICATE_VAT_INVOICE）
 *   - 状态机：Received → Verified → Declared（仅 Input+Special 且必须挂 taxRefundId）→ RedFlushed；
 *     Received → Cancelled；Declared/RedFlushed/Cancelled 不可编辑
 *   - Declared 禁删（仅可红冲）；Decimal 字段以 string 传输（保精度）
 */
import { apiService } from './apiService';
import { runFinanceCommand } from './financeCommandRecovery';
import type { VatInvoice, VatInvoiceStatus } from '../types';

export interface VatInvoiceCreateInput {
  requestKey?: string;
  expectedUpdatedAt?: string;
  vatCode?: string;
  vatNumber: string;
  direction?: string;
  invoiceType?: string;
  sellerName: string;
  sellerTaxNo?: string;
  buyerName: string;
  buyerTaxNo?: string;
  issueDate: string;
  netAmount: number | string;
  taxRate: number | string;
  taxAmount: number | string;
  totalAmount: number | string;
  currency?: string;
  invoiceId?: string;
  orderId?: string;
  relationId?: string;
  notes?: string;
}

export type VatInvoicePatchInput = Partial<Omit<VatInvoiceCreateInput, 'vatNumber' | 'direction' | 'invoiceType'>> & {
  deductionPeriod?: string;
};

export interface VatInvoiceTransitionInput {
  requestKey?: string;
  expectedUpdatedAt?: string;
  toStatus: VatInvoiceStatus;
  verifiedDate?: string;    // →Verified 缺省当日
  deductionPeriod?: string; // →Verified 可带勾选所属期 YYYY-MM
  taxRefundId?: string;     // →Declared 必填（或已挂在票上）
  redFlushNumber?: string;  // →RedFlushed 可带红字发票号
  redFlushDate?: string;    // →RedFlushed 缺省当日
}

type VatInvoiceListParams = {
  status?: string;
  direction?: string;
  relationId?: string;
  taxRefundId?: string;
  invoiceId?: string;
  orderId?: string;
  from?: string;
  to?: string;
};

function buildQuery(params?: VatInvoiceListParams): string {
  const query = new URLSearchParams();
  if (params?.status) query.set('status', params.status);
  if (params?.direction) query.set('direction', params.direction);
  if (params?.relationId) query.set('relationId', params.relationId);
  if (params?.taxRefundId) query.set('taxRefundId', params.taxRefundId);
  if (params?.invoiceId) query.set('invoiceId', params.invoiceId);
  if (params?.orderId) query.set('orderId', params.orderId);
  if (params?.from) query.set('from', params.from);
  if (params?.to) query.set('to', params.to);
  return query.toString();
}

export const vatInvoiceService = {
  async listVatInvoices(endpoint?: string, params?: VatInvoiceListParams): Promise<{ items: VatInvoice[]; total: number }> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/finance/vat-invoices', base);
    const qs = buildQuery(params);
    const fullUrl = qs ? `${url}?${qs}` : url;
    const res = await fetch(fullUrl, {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) throw new Error(`listVatInvoices failed: HTTP ${res.status}`);
    const data = await res.json();
    return { items: Array.isArray(data.items) ? data.items : [], total: Number(data.total) || 0 };
  },

  async getVatInvoice(id: string, endpoint?: string): Promise<VatInvoice> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/finance/vat-invoices/${encodeURIComponent(id)}`, base);
    const res = await fetch(url, {
      headers: apiService.getAuthHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `getVatInvoice failed: HTTP ${res.status}`);
    return data;
  },

  /** 登记增值税发票（金额三栏校验 + 查重，服务端 fail closed） */
  async createVatInvoice(input: VatInvoiceCreateInput, endpoint?: string): Promise<VatInvoice> {
    return runFinanceCommand({kind:'vat.create',path:'/v1/finance/vat-invoices',method:'POST',permission:'vat:write',input:{...input},entity:'vatInvoice'},endpoint);
  },

  /** 票面修正（Declared/RedFlushed/Cancelled 被服务端拒绝） */
  async updateVatInvoice(id: string, patch: VatInvoicePatchInput, endpoint?: string): Promise<VatInvoice> {
    const path=`/v1/finance/vat-invoices/${encodeURIComponent(id)}`;
    return runFinanceCommand({kind:'vat.update',targetId:id,path,method:'PATCH',permission:'vat:write',input:{...patch},entity:'vatInvoice',readPath:path,hashExtra:{vatInvoiceId:id}},endpoint);
  },

  /** 状态机流转（认证 / 申报退税 / 红冲 / 作废），非法流转被服务端拒绝 */
  async transitionVatInvoice(id: string, input: VatInvoiceTransitionInput, endpoint?: string): Promise<VatInvoice> {
    const path=`/v1/finance/vat-invoices/${encodeURIComponent(id)}`;
    return runFinanceCommand({kind:'vat.transition',targetId:id,path:`${path}/transition`,method:'POST',permission:'vat:write',input:{...input},entity:'vatInvoice',readPath:path,hashExtra:{vatInvoiceId:id}},endpoint);
  },

  /** 软删（Declared 禁删，仅可红冲） */
  async deleteVatInvoice(id: string, endpoint?: string): Promise<{ ok: boolean }> {
    const path=`/v1/finance/vat-invoices/${encodeURIComponent(id)}`;
    return runFinanceCommand({kind:'vat.delete',targetId:id,path,method:'DELETE',permission:'vat:write',input:{},entity:'none',readPath:path,hashExtra:{vatInvoiceId:id}},endpoint);
  },
};
