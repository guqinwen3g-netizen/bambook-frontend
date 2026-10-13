import { stageBulkFirst, confirmBulkFirst, confirmBulkRejection, watchBulkFirstContext, type BulkFirstIntent, type PendingBulkFirst } from './bulkFirstInvoiceCommand';
/**
 * Invoice API service.
 * Communicates with /api/v1/finance endpoints (invoices).
 */
import { apiService } from './apiService';
import { runFinanceCommand } from './financeCommandRecovery';
import { getAuthState, hasPermission } from './authService';
import type { Invoice, InvoiceAttachment, InvoiceOrderAllocation, InvoiceStatus, InvoiceType, InvoiceWriteInput } from '../types';

type InvoiceListParams = {
  type?: InvoiceType;
  status?: InvoiceStatus;
  customer?: string;
  orderId?: string;
  search?: string;
  limit?: number;
  offset?: number;
};

export interface PendingBusinessCiReceivable {
  documentId: string;
  documentNumber: string;
  shipmentId: string;
  issueDate: string | null;
  amount: string;
  currency: string;
  customerName: string | null;
  customerRelationId: string | null;
  contractNumber: string | null;
  lineCount: number;
  orderReferences: Array<{ orderId: string; orderNumber: string | null; poNumber: string | null }>;
}

function invoiceSession(endpoint?: string, writing = false) {
  const auth = getAuthState();
  if (!auth.isAuthenticated || !auth.user?.id) throw new Error('请重新登录后核对财务单据。');
  if (writing && !hasPermission('invoices:write')) throw new Error('当前账号没有发票写入权限。');
  const base = endpoint ?? apiService.getStoredConfig().cloudEndpoint;
  const headers = apiService.getAuthHeaders();
  return { base, headers, identity: JSON.stringify([base, apiService.getStoredConfig().cloudEndpoint, headers,
    auth.user.id, auth.user.roles, auth.user.roleIds ?? [], auth.user.permissions, auth.user.permissionCeiling ?? null]) };
}
function assertInvoiceSession(session: ReturnType<typeof invoiceSession>, endpoint?: string, writing = false) {
  if (invoiceSession(endpoint, writing).identity !== session.identity)
    throw new Error('账号、权限或服务地址已变化，请重新读取财务单据；已提交请求的结果需核对。');
}
function checkedOrderReferences(data: any): void {
  // Missing summaries are unknown (not an empty source); old detail responses
  // remain readable through their actual orderAllocations contract.
  if (data?.orderReferences === undefined) return;
  const invalid = () => { throw new Error('财务关联订单回执未确认，请重新读取原单核对。'); };
  if (!Array.isArray(data.orderReferences)) invalid();
  const seen = new Set<string>();
  const nullableText = (value: unknown) => value === null || typeof value === 'string';
  for (const row of data.orderReferences) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || typeof row.orderId !== 'string' || !row.orderId || seen.has(row.orderId)
      || typeof row.direct !== 'boolean' || row.direct !== (row.orderId === data.orderId)
      || !nullableText(row.orderNumber) || !nullableText(row.poNumber) || !nullableText(row.note)
      || !(row.allocationId === null || (typeof row.allocationId === 'string' && row.allocationId))
      || !(row.batchId === null || (typeof row.batchId === 'string' && row.batchId))
      || !(row.allocatedAmount === null || (typeof row.allocatedAmount === 'string' && /^-?\d+(?:\.\d{1,4})?$/.test(row.allocatedAmount)))
      || (row.allocationId === null && (!row.direct || row.orderNumber !== null || row.poNumber !== null
        || row.batchId !== null || row.allocatedAmount !== null || row.note !== null))) invalid();
    seen.add(row.orderId);
  }
  if (data.orderId && !seen.has(data.orderId)) invalid();
  if (data.orderAllocations !== undefined) {
    if (!Array.isArray(data.orderAllocations)) invalid();
    const sources = new Map<string, any>();
    for (const row of data.orderAllocations) {
      if (!row || typeof row.orderId !== 'string' || !row.orderId || sources.has(row.orderId)
        || typeof row.id !== 'string' || !row.id) invalid();
      sources.set(row.orderId, row);
    }
    const expected = new Set([...sources.keys(), ...(data.orderId ? [data.orderId] : [])]);
    if (seen.size !== expected.size || [...expected].some(id => !seen.has(id))) invalid();
    for (const row of data.orderReferences) {
      const allocation = sources.get(row.orderId);
      if (row.allocationId !== (allocation?.id ?? null)
        || row.orderNumber !== (allocation?.orderNumber ?? null) || row.poNumber !== (allocation?.poNumber ?? null)
        || row.batchId !== (allocation?.batchId ?? null) || row.note !== (allocation?.note ?? null)) invalid();
    }
  }
}

function checkedInvoice(data: any, id?: string): Invoice {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.ok === false || data.error
    || typeof data.id !== 'string' || !data.id || (id !== undefined && data.id !== id)
    || typeof data.invoiceNumber !== 'string' || typeof data.status !== 'string')
    throw new Error('财务单据回执未确认，请重新读取核对，勿据此重复新建。');
  checkedOrderReferences(data);
  return data;
}

export const invoiceService = {
  async listInvoices(endpoint?: string, params?: InvoiceListParams): Promise<Invoice[]> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/finance', base);
    const query = new URLSearchParams();
    if (params?.type) query.set('type', params.type);
    if (params?.status) query.set('status', params.status);
    if (params?.customer) query.set('customer', params.customer);
    if (params?.orderId) query.set('orderId', params.orderId);
    if (params?.search) query.set('search', params.search);
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));

    const fullUrl = query.toString() ? `${url}?${query.toString()}` : url;

    const res = await fetch(fullUrl, {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) throw new Error(`listInvoices failed: HTTP ${res.status}`);
    const data = await res.json();
    const items = data.items || [];
    if (!Array.isArray(items)) throw new Error('财务单据列表回执未确认，请重新读取核对。');
    for (const item of items) checkedOrderReferences(item);
    return items;
  },

  /** Logistics-issued shipment CIs awaiting Finance's receivable registration. */
  async listPendingBusinessCiReceivables(endpoint?: string): Promise<PendingBusinessCiReceivable[]> {
    const session = invoiceSession(endpoint);
    if (!hasPermission('invoices:read')) throw new Error('当前账号没有查看待登记 CI 的权限。');
    const res = await fetch(apiService.buildApiUrl('/v1/finance/business-ci-pending', session.base), { headers: session.headers });
    assertInvoiceSession(session, endpoint);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `待登记 CI 加载失败：HTTP ${res.status}`);
    if (!data || !Array.isArray(data.items)) throw new Error('待登记 CI 回执格式无效，请重新读取。');
    const items: PendingBusinessCiReceivable[] = data.items.map((row: any) => {
      if (!row || typeof row.documentId !== 'string' || !row.documentId || typeof row.documentNumber !== 'string' || !row.documentNumber
        || typeof row.shipmentId !== 'string' || !row.shipmentId || !/^\d+(?:\.\d{1,4})?$/.test(String(row.amount))
        || typeof row.currency !== 'string' || !row.currency || !Array.isArray(row.orderReferences)
        || !Number.isInteger(row.lineCount) || row.lineCount < 1
        || row.orderReferences.some((order: any) => !order || typeof order.orderId !== 'string' || !order.orderId
          || !(order.orderNumber === null || typeof order.orderNumber === 'string')
          || !(order.poNumber === null || typeof order.poNumber === 'string'))) {
        throw new Error('待登记 CI 来源信息不完整，请刷新单证来源后核对。');
      }
      return row as PendingBusinessCiReceivable;
    });
    assertInvoiceSession(session, endpoint);
    return items;
  },

  /** Body is intentionally empty: all receivable facts are derived from the exact issued CI. */
  async registerBusinessCiReceivable(documentId: string, endpoint?: string): Promise<{ invoice: Invoice; replayed: boolean }> {
    const session = invoiceSession(endpoint, true);
    const res = await fetch(apiService.buildApiUrl(`/v1/finance/business-ci/${encodeURIComponent(documentId)}/register`, session.base), {
      method: 'POST', headers: session.headers, body: '{}',
    });
    assertInvoiceSession(session, endpoint, true);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `CI 应收登记失败：HTTP ${res.status}`);
    if (!data || typeof data.replayed !== 'boolean') throw new Error('CI 登记回执未确认，请重新读取财务台账核对。');
    const invoice = checkedInvoice(data.item);
    if (invoice.type !== 'Receivable' || (invoice as any).sourceType !== 'BusinessShipmentCI' || invoice.status !== 'Issued')
      throw new Error('CI 登记回执与原始商业发票不一致，请重新读取财务台账核对。');
    assertInvoiceSession(session, endpoint, true);
    return { invoice, replayed: data.replayed };
  },

  // ── DR-054 阶段 F：场景化开票（财务域统一入口）──

  /** preview：候选费用行 + 汇总（scene: dev_cost | fabric | sample | order） */
  async previewSceneInvoice(input: { scene: string; sourceId: string }, endpoint?: string): Promise<{
    scene: string; sceneLabel: string; title: string;
    wholeCaseBilling?: {caseId:string;message:string} | null;
    customerRelationId?: string | null; customerName?: string | null;
    rows: Array<{ id: string; recordNo: string; sourceType: string; costType: string; amount: number; currency: string; incurredAt: string; sourceLabel?: string | null; occupied: boolean }>;
    total: number;
    /** 兼容字段：仅单币种有效（多币种恒为 0/''）；请优先读 summaryByCurrency */
    summaryAmount: number; summaryCurrency: string;
    /** T7-②：按币种分组的汇总（多币种场景的真源） */
    summaryByCurrency: Array<{ currency: string; amount: number }>;
    /** T7-②：是否多币种（true 时提示「请按币种分开开票」，与 create 的 MULTI_CURRENCY 同口径） */
    multiCurrency: boolean;
  }> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/finance/scene-invoice/preview', base);
    const res = await fetch(url, { method: 'POST', headers: apiService.getAuthHeaders(), body: JSON.stringify(input) });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `previewSceneInvoice failed: HTTP ${res.status}`);
    }
    return res.json();
  },

  /** create：选费用行子集 → 发票（行级开票） */
  async createSceneInvoice(input: { scene: string; sourceId: string; lineIds: string[]; notes?: string; issueDate?: string; dueDate?: string }, endpoint?: string): Promise<{ invoice: Invoice }> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/finance/scene-invoice/create', base);
    const res = await fetch(url, { method: 'POST', headers: apiService.getAuthHeaders(), body: JSON.stringify(input) });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `createSceneInvoice failed: HTTP ${res.status}`);
    }
    return res.json();
  },

  // DR：详情——GET /v1/finance/:id，返回附带 orderAllocations[]（发票↔订单多对多）
  async getInvoice(id: string, endpoint?: string): Promise<Invoice & { orderAllocations?: InvoiceOrderAllocation[] }> {
    const session = invoiceSession(endpoint);
    const base = session.base;
    const url = apiService.buildApiUrl(`/v1/finance/${encodeURIComponent(id)}`, base);
    const res = await fetch(url, { headers: session.headers });
    assertInvoiceSession(session, endpoint);
    if (!res.ok) throw new Error(`getInvoice failed: HTTP ${res.status}`);
    const data = await res.json();
    assertInvoiceSession(session, endpoint);
    return checkedInvoice(data, id);
  },

  /** POST /v1/finance —— 创建发票（支持 orderIds[] 多订单分配） */
  async createInvoice(input: Omit<Partial<Invoice>, 'orderAllocations' | 'orderReferences' | 'amount' | 'exchangeRate'> & InvoiceWriteInput, endpoint?: string, bulkFirstIntent?: BulkFirstIntent): Promise<Invoice> {
    const session = invoiceSession(endpoint, true);
    const base = session.base;
    const url = apiService.buildApiUrl('/v1/finance', base);
    const pending = bulkFirstIntent ? stageBulkFirst(input as any, bulkFirstIntent) : null;
    const context = pending ? watchBulkFirstContext(() => assertInvoiceSession(session, endpoint, true)) : null;
    try {
    const res = await fetch(url, {
      method: 'POST',
      headers: session.headers,
      body: JSON.stringify(bulkFirstIntent ? { ...input, bulkFirstIntent } : input),
    });
    assertInvoiceSession(session, endpoint, true);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (pending && err?.bulkFirstRejection) await confirmBulkRejection(pending, err, () => context!.assertCurrent());
      const errorMessage = typeof err.error === 'object'
        ? JSON.stringify(err.error)
        : (err.error || `createInvoice failed: HTTP ${res.status}`);
      throw new Error(errorMessage);
    }
    const data = await res.json();
    assertInvoiceSession(session, endpoint, true);
    if (pending && data?.bulkFirstRejection) await confirmBulkRejection(pending, data, () => context!.assertCurrent());
    const checked = checkedInvoice(data);
    if (pending) await confirmBulkFirst(pending, data, () => context!.assertCurrent());
    assertInvoiceSession(session, endpoint, true);
    return checked;
    } finally { context?.stop(); }
  },

  async reconcileBulkFirst(record: PendingBulkFirst, endpoint?: string): Promise<Invoice> {
    const session = invoiceSession(endpoint, true);
    const context = watchBulkFirstContext(() => assertInvoiceSession(session, endpoint, true));
    try {
    const res = await fetch(apiService.buildApiUrl('/v1/finance/bulk-first/reconcile', session.base), { method: 'POST', headers: session.headers, body: JSON.stringify({ ...record.payload, bulkFirstIntent: { ...record.intent, mode: 'reconcile' } }) });
    assertInvoiceSession(session, endpoint, true);
    const data = await res.json();
    if (data?.bulkFirstRejection) await confirmBulkRejection(record, data, () => context.assertCurrent());
    if (!res.ok) throw new Error(data?.error?.message || '原开票结果尚未确认，请保留原请求。');
    const checked = checkedInvoice(data);
    await confirmBulkFirst(record, data, () => context.assertCurrent());
    assertInvoiceSession(session, endpoint, true);
    return checked;
    } finally { context.stop(); }
  },

  /** PATCH /v1/finance/:id —— 更新发票（orderIds[] 时后端按 replace 语义重写分配） */
  async updateInvoice(id: string, input: Omit<Partial<Invoice>, 'orderAllocations' | 'orderReferences' | 'amount' | 'exchangeRate'> & InvoiceWriteInput, endpoint?: string): Promise<Invoice> {
    const session = invoiceSession(endpoint, true);
    const base = session.base;
    const url = apiService.buildApiUrl(`/v1/finance/${encodeURIComponent(id)}`, base);
    const res = await fetch(url, {
      method: 'PATCH',
      headers: session.headers,
      body: JSON.stringify(input),
    });
    assertInvoiceSession(session, endpoint, true);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const errorMessage = typeof err.error === 'object'
        ? JSON.stringify(err.error)
        : (err.error || `updateInvoice failed: HTTP ${res.status}`);
      throw new Error(errorMessage);
    }
    const data = await res.json();
    assertInvoiceSession(session, endpoint, true);
    return checkedInvoice(data, id);
  },

  /** 导出发票 PDF（下载到本地） */
  async renderInvoicePdf(id: string, endpoint?: string): Promise<void> {
    return apiService.renderInvoicePdf(id, endpoint);
  },

  /** 发票预览 HTML（与导出 PDF 同源渲染 + screen 页边距，所见即所得） */
  async getInvoicePreviewHtml(id: string, endpoint?: string): Promise<string> {
    return apiService.getInvoicePreviewHtml(id, endpoint);
  },

  /** 上传发票真实文件（multipart），返回登记后的附件结构 */
  async invoiceAttachmentFileHash(file: File) {
    return apiService.invoiceAttachmentFileHash(file);
  },
  async uploadInvoiceAttachment(id: string, file: File, endpoint?: string, clientRequestId?: string) {
    return apiService.uploadInvoiceAttachment(id, file, endpoint, clientRequestId);
  },
  async getInvoiceAttachmentReceipt(id: string, clientRequestId: string, endpoint?: string) {
    return apiService.getInvoiceAttachmentReceipt(id, clientRequestId, endpoint);
  },
  async downloadInvoiceAttachment(id: string, attachment: InvoiceAttachment, endpoint?: string) {
    return apiService.downloadInvoiceAttachment(id, attachment, endpoint);
  },

  // task_mqyusoio: 消费后端 POST /:id/cancel + DELETE /:id（task_mqyurxot voidDeleteService）
  /** 作废发票（调后端 cancelInvoice service，返回更新后 invoice） */
  async cancelInvoice(id: string, reason?: string, endpoint?: string): Promise<any> {
    const path=`/v1/finance/${encodeURIComponent(id)}`;
    return runFinanceCommand({kind:'invoice.cancel',targetId:id,path:`${path}/cancel`,method:'POST',permission:'invoices:write',input:{reason},entity:'invoice',readPath:path,hashExtra:{targetId:id}},endpoint);
  },

  /**
   * ★ C7（2026-09-18）尾差销账：对某张**应收票**的未结额开一张贷项票（纯折让，非客诉）并立即抵扣。
   *
   * 为什么要有这个前端入口：后端 CN 的唯一创建路径原是「索赔处置」（5 步、语义错位），
   * 一笔几块钱的尾差实务上没人处理 ⇒ 发票永远 PartiallyPaid、账龄天天报警。
   *
   * @param reason 事由（后端要求 ≥10 字，尾差销账必须留痕）
   * @param amount 缺省 = 该发票当前未结额（整笔尾差）；有金额上限（见后端 writeOffService）
   */
  async writeOffTail(id: string, reason: string, amount?: number | null, endpoint?: string): Promise<any> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/invoices/${encodeURIComponent(id)}/write-off-tail`, base);
    const res = await fetch(url, {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify({ reason, ...(amount != null ? { amount } : {}) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || data?.error || `writeOffTail failed: HTTP ${res.status}`);
    return data;
  },

  /** 软删发票（调后端 deleteInvoice service，HAS_ALLOCATIONS/NOT_FOUND 阻断） */
  async deleteInvoice(id: string, endpoint?: string): Promise<{ ok: boolean }> {
    const path=`/v1/finance/${encodeURIComponent(id)}`;
    return runFinanceCommand({kind:'invoice.delete',targetId:id,path,method:'DELETE',permission:'invoices:write',input:{},entity:'none',readPath:path,hashExtra:{targetId:id}},endpoint);
  },
};
