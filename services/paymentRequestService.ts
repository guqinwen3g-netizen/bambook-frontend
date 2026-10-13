/**
 * PaymentRequest API service — DR-017 付款申请（先申请后付款唯一入口）。
 * Communicates with /api/v1/payment-requests endpoints:
 *   POST /              — 创建（scope finance:payment_request:create；创建即 Pending + 生成审批单）
 *   GET  /              — 列表（status / paymentCategory / applicantId 过滤）
 *   GET  /:id           — 详情（附 approvalRequest / paymentVoucher 关联快照）
 *   POST /:id/cancel    — 申请人作废（仅 Draft/Pending，仅本人）
 *
 * 类型定义内聚在本文件（root types.ts 为冻结区，禁止编辑）。
 * 审批决策走审批域既有端点（approvalKernelService.decideApproval → POST /v1/approvals/:id/decide），
 * 本服务不重复封装。
 */
import { apiService } from './apiService';
import { runFinanceCommand } from './financeCommandRecovery';
import { getAuthState, hasPermission } from './authService';
import { financeContextIdentity } from './financeContextIdentity';
import { cashAccountReference } from './companyCashAccountService';
import type { PaymentVoucher } from '../types';
import { VOUCHER_CATEGORIES, type VoucherCategory } from './paymentVoucherService';

// ── 状态机（镜像后端 PAYMENT_REQUEST_STATUSES） ──
export const PAYMENT_REQUEST_STATUSES = [
  'Draft',
  'Pending',
  'Approved',
  'Rejected',
  'VoucherIssued',
  'Cancelled',
  'Executing',
  'Paid',
] as const;
export type PaymentRequestStatus = (typeof PAYMENT_REQUEST_STATUSES)[number];

export const PAYMENT_REQUEST_STATUS_LABELS: Record<PaymentRequestStatus, string> = {
  Draft: '草稿',
  Pending: '审批中',
  Approved: '已批准',
  Rejected: '已驳回',
  VoucherIssued: '历史已生成凭证',
  Cancelled: '已作废',
  Executing: '付款执行中',
  Paid: '已实付',
};

/** 付款性质 = PaymentVoucher.voucherCategory 同一枚举真源（镜像后端 VALID_PAYMENT_CATEGORIES） */
export const PAYMENT_CATEGORIES = VOUCHER_CATEGORIES;
export type PaymentCategory = VoucherCategory;

/** 来源单据类型（镜像后端 PAYMENT_REQUEST_SOURCE_TYPES，持久化于 attachments.sourceDocument） */
export const PAYMENT_REQUEST_SOURCE_TYPES = ['supplier_payable', 'purchase_order', 'order', 'expense', 'warehouse', 'other'] as const;
export type PaymentRequestSourceType = (typeof PAYMENT_REQUEST_SOURCE_TYPES)[number];

export const PAYMENT_REQUEST_SOURCE_TYPE_LABELS: Record<PaymentRequestSourceType, string> = {
  supplier_payable: '供应商应付原票',
  purchase_order: '采购单',
  order: '订单',
  expense: '费用',
  warehouse: '仓库费用',
  other: '其他',
};

export interface PaymentRequest {
  id: string;
  requestNumber: string;
  supplierId?: string | null;
  supplierName?: string | null;
  payeeType?: 'Supplier' | 'Customer';
  customerRelationId?: string | null;
  customerName?: string | null;
  requestDate: string;
  expectedPaymentDate?: string | null;
  totalAmount: number | string;
  currency: string;
  applicantId: string;
  reviewerId?: string | null;
  status: PaymentRequestStatus;
  approvalRequestId?: string | null;
  paymentVoucherId?: string | null;
  paymentCategory: PaymentCategory;
  ownerId?: string | null;
  remark?: string | null;
  attachments?: unknown;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

/** 详情关联的审批单快照（后端 GET /:id 返回） */
export interface PaymentRequestApprovalSnapshot {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | string;
  reviewerId?: string | null;
  decidedAt?: string | null;
  decisionNote?: string | null;
}

/** 详情关联的付款凭证快照（后端 GET /:id 返回） */
export interface PaymentRequestVoucherSnapshot {
  id: string;
  voucherNumber: string;
  type: string;
  voucherCategory?: VoucherCategory;
  amount: number | string;
  currency?: string;
  status: string;
}

export interface SupplierActualPaymentInput {
  amount: string; currency: string; paymentDate: string; paymentMethod: string;
  bankReference?: string; evidenceNote?: string; requestKey?: string; expectedRequestUpdatedAt?: string;
  companyAccountId?: string;expectedAccountRevision?: number;actualAccountAmount?:string;
  bankFee?:string;feeBearer?:string;
}
export interface PaymentRequestDetail extends PaymentRequest {
  actualPayments?: {paidAmount:string;remainingAmount:string;vouchers:Array<{id:string;voucherNumber:string;amount:string;currency:string;
    paymentDate:string;paymentMethod:string;status:string;deletedAt:string|null;verifiedActual:boolean}>};
  approvalRequest?: PaymentRequestApprovalSnapshot | null;
  paymentVoucher?: PaymentRequestVoucherSnapshot | null;
}

export interface CreatePaymentRequestInput {
  requestKey?: string;
  payableSelections?: PaymentRequestPayableSelection[];
  /** 付款对象：供应商 Relation ID 与名称至少其一必填 */
  supplierId?: string;
  supplierName?: string;
  totalAmount: number | string;
  currency: string;
  paymentCategory?: PaymentCategory;
  requestDate?: string;
  expectedPaymentDate?: string;
  sourceType?: PaymentRequestSourceType;
  sourceId?: string;
  remark?: string;
}

export interface PaymentRequestPayableSelection {
  invoiceId: string;
  requestedAmount: string;
  expectedSourceFingerprint: string;
}
export interface PaymentRequestPayableCandidate {
  invoiceId: string; vatInvoiceId: string; invoiceNumber: string; vatNumber: string; vatCode: string | null;
  supplierId: string; supplierName: string; currency: string; contractNumbers: string[]; sourceFingerprint: string;
  invoiceAmount: string; appliedAmount: string; remainingAmount: string; reservedAmount: string; availableAmount: string;
}
export interface PaymentRequestPayableSnapshot {
  schemaVersion: 1; sourceType: 'SupplierVatPayablePayment'; supplierId: string; currency: string; totalAmount: string;
  entries: Array<{ invoiceId: string; vatInvoiceId: string; requestedAmount: string; invoiceAmount: string;
    appliedAmountAtSubmission: string; remainingAmountAtSubmission: string; sourceFingerprint: string;
    originalDocument?: { invoiceNumber: string; vatCode: string | null; vatNumber: string; supplierName: string; contractNumbers: string[] } }>;
  sourceFingerprint: string;
}

function payableSession(endpoint?: string) {
  const auth = getAuthState(), base = endpoint ?? apiService.getStoredConfig().cloudEndpoint, headers = apiService.getAuthHeaders();
  if (!auth.isAuthenticated || !auth.user?.id || !hasPermission('invoices:read') || !hasPermission('finance:payment_request:create'))
    throw new Error('当前账号不能选择供应商应付原票。');
  return { base, headers, key: JSON.stringify([base, apiService.getStoredConfig().cloudEndpoint, headers, auth.user.id,
    auth.user.roles, auth.user.roleIds, auth.user.permissions, auth.user.permissionCeiling ?? null, auth.user.departmentIds ?? [], financeContextIdentity()]) };
}

function requestReadSession(endpoint?: string) {
  const auth = getAuthState(), base = endpoint ?? apiService.getStoredConfig().cloudEndpoint, headers = apiService.getAuthHeaders();
  if (!auth.isAuthenticated || !auth.user?.id) throw new Error('请登录后核对付款申请。');
  return { base, headers, identity: JSON.stringify([base, financeContextIdentity()]) };
}
export const paymentRequestReadIdentity = (endpoint?: string) => requestReadSession(endpoint).identity;

export interface PaymentRequestListParams {
  warehouseId?:string;
  status?: PaymentRequestStatus;
  paymentCategory?: PaymentCategory;
  applicantId?: string;
  /** 服务端模糊搜索：申请编号 / 收款方 / 事由（contains，大小写不敏感） */
  search?: string;
  limit?: number;
}

async function readError(res: Response, fallback: string): Promise<never> {
  const data = await res.json().catch(() => ({}));
  const code = typeof data?.error === 'string' ? data.error : undefined;
  const rawMessage = data?.message || data?.error || `${fallback}: HTTP ${res.status}`;
  const message = typeof rawMessage === 'string' ? rawMessage : JSON.stringify(rawMessage);
  const err: any = new Error(code && data?.message && !message.includes(code) ? `${code}：${message}` : message);
  err.status = res.status;
  err.code = code;
  throw err;
}

function requestUrl(path: string, endpoint?: string): string {
  const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
  return apiService.buildApiUrl(`/v1/payment-requests${path}`, base);
}

export const paymentRequestService = {
  async listPayableCandidates(params: { supplierId: string; currency: string; search?: string; cursor?: string }, endpoint?: string) {
    const session = payableSession(endpoint), query = new URLSearchParams({ supplierId: params.supplierId, currency: params.currency, limit: '30' });
    if (params.search?.trim()) query.set('search', params.search.trim()); if (params.cursor) query.set('cursor', params.cursor);
    const response = await fetch(`${requestUrl('/payable-candidates', endpoint)}?${query}`, { headers: session.headers });
    const current = () => { if (payableSession(endpoint).key !== session.key) throw new Error('账号、权限或服务地址已变化，请重新读取应付原票。'); };
    current(); const data = await response.json().catch(() => null); current();
    if (!response.ok) throw new Error(data?.error?.message || data?.message || '应付原票暂不可读取。');
    if (!Array.isArray(data?.items) || typeof data.hasMore !== 'boolean' || !(data.nextCursor === null || typeof data.nextCursor === 'string' && data.nextCursor)
      || data.hasMore !== (data.nextCursor !== null) || new Set(data.items.map((row: any) => row.invoiceId)).size !== data.items.length
      || data.items.some((row: any) => !row.invoiceId || !row.vatInvoiceId || !row.invoiceNumber || !row.vatNumber || row.supplierId !== params.supplierId
        || row.currency !== params.currency || !Array.isArray(row.contractNumbers) || !row.contractNumbers.length || !/^[a-f0-9]{64}$/.test(row.sourceFingerprint)
        || !['invoiceAmount', 'appliedAmount', 'remainingAmount', 'reservedAmount', 'availableAmount'].every(key => typeof row[key] === 'string' && /^\d+(?:\.\d{1,4})?$/.test(row[key]))))
      throw new Error('应付原票余额清单尚未核实，请重新读取。');
    return data as { items: PaymentRequestPayableCandidate[]; nextCursor: string | null; hasMore: boolean };
  },
  async recordActualPayment(id:string,input:SupplierActualPaymentInput,endpoint?:string):Promise<PaymentVoucher>{
    const path=`/v1/payment-requests/${encodeURIComponent(id)}`;
    return runFinanceCommand({kind:'payment_request.record_payment',targetId:id,path:`${path}/record-payment`,method:'POST',permission:'vouchers:write',
      input:{...input},entity:'voucher',readPath:path,readEntity:'item',revisionField:'expectedRequestUpdatedAt',hashExtra:{paymentRequestId:id},
      references:input.companyAccountId?[cashAccountReference(input.companyAccountId)]:[]},endpoint);
  },
  /**
   * 列表（status / paymentCategory / applicantId / search 过滤，按创建时间倒序）。
   * 返回 items + total：total 为服务端全量计数，items 受 limit 截断（默认 100，上限 500），
   * 消费方须以 total 透明披露截断（R3 诚实化）。
   */
  async listPaymentRequests(params?: PaymentRequestListParams, endpoint?: string): Promise<{ items: PaymentRequest[]; total: number }> {
    const session = requestReadSession(endpoint);
    const url = requestUrl('', endpoint);
    const query = new URLSearchParams();
    if(params?.warehouseId)query.set('warehouseId',params.warehouseId);
    if (params?.status) query.set('status', params.status);
    if (params?.paymentCategory) query.set('paymentCategory', params.paymentCategory);
    if (params?.applicantId) query.set('applicantId', params.applicantId);
    if (params?.search?.trim()) query.set('search', params.search.trim());
    if (params?.limit) query.set('limit', String(params.limit));
    const fullUrl = query.toString() ? `${url}?${query.toString()}` : url;
    const res = await fetch(fullUrl, { headers: session.headers });
    const current = () => { if (paymentRequestReadIdentity(endpoint) !== session.identity) throw new Error('账号、权限或服务地址已变化，请重新读取付款申请。'); };
    current();
    if (!res.ok) await readError(res, 'listPaymentRequests failed');
    const data = await res.json(); current();
    const items: PaymentRequest[] = Array.isArray(data.items) ? data.items : [];
    // total 兜底为 items 长度：兼容尚未返回 total 的旧后端（截断披露退化为不披露，不伪造数字）
    const total = Number.isFinite(Number(data.total)) ? Number(data.total) : items.length;
    return { items, total };
  },

  /** 详情（附 approvalRequest / paymentVoucher 关联快照） */
  async getPaymentRequest(id: string, endpoint?: string): Promise<PaymentRequestDetail> {
    const session = requestReadSession(endpoint);
    const res = await fetch(requestUrl(`/${encodeURIComponent(id)}`, endpoint), {
      headers: session.headers,
    });
    const current = () => { if (paymentRequestReadIdentity(endpoint) !== session.identity) throw new Error('账号、权限或服务地址已变化，请重新读取原付款申请。'); };
    current();
    if (!res.ok) await readError(res, 'getPaymentRequest failed');
    const data = await res.json(); current();
    if (data?.item?.id !== id) throw new Error('原付款申请详情尚未核实，请重新读取。');
    return data.item;
  },

  /**
   * §10.3-9 Phase B 批次 4：付款申请单 A4 预览 HTML（服务端模板实时装配，与生成 PDF 同源排版）。
   * 审批通过后按签署人取章盖入审批人签章位（电子签）。
   */
  async getPaymentRequestPreviewHtml(id: string, endpoint?: string): Promise<string> {
    const session = requestReadSession(endpoint);
    const res = await fetch(requestUrl(`/${encodeURIComponent(id)}/preview.html`, endpoint), {
      headers: session.headers,
    });
    const current = () => { if (paymentRequestReadIdentity(endpoint) !== session.identity) throw new Error('账号、权限或服务地址已变化，请重新读取原付款申请单据。'); };
    current();
    if (!res.ok) await readError(res, 'getPaymentRequestPreviewHtml failed');
    const html = await res.text(); current(); return html;
  },

  /**
   * §10.3-9 Phase B 批次 4：登记单据中心（domain=finance）+ 渲染付款申请单 PDF 落盘归档，
   * 生成后浏览器下载归档文件（经鉴权下载端点）。幂等：重复生成覆盖同一份 PDF。
   */
  async generatePaymentRequestDocument(
    id: string,
    endpoint?: string,
  ): Promise<{ documentNumber: string; fileName: string; fileSize: number }> {
    const res = await fetch(requestUrl(`/${encodeURIComponent(id)}/generate-document`, endpoint), {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) await readError(res, 'generatePaymentRequestDocument failed');
    const data = await res.json();
    await apiService.downloadTradeDocumentArchive(data.document.documentId, data.file.fileName, endpoint);
    return { documentNumber: data.document.documentNumber, fileName: data.file.fileName, fileSize: data.file.fileSize };
  },

  /** 创建（创建即 Pending 并生成审批单；reviewerId 由服务端 DR-007 解析，前端不得传入） */
  async createPaymentRequest(
    input: CreatePaymentRequestInput,
    endpoint?: string,
  ): Promise<{ paymentRequest: PaymentRequest; approvalRequestId: string }> {
    if (input.sourceType === 'supplier_payable') {
      const paymentRequest = await runFinanceCommand<PaymentRequest>({ kind: 'payment_request.create', path: '/v1/payment-requests',
        method: 'POST', permission: 'finance:payment_request:create', input: { ...input }, entity: 'paymentRequest' }, endpoint);
      if (!paymentRequest.approvalRequestId) throw new Error('原付款申请审批回执尚未核实，请核对原申请。');
      return { paymentRequest, approvalRequestId: paymentRequest.approvalRequestId };
    }
    const res = await fetch(requestUrl('', endpoint), {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(input),
    });
    if (!res.ok) await readError(res, 'createPaymentRequest failed');
    const data = await res.json();
    return data;
  },

  /** 申请人作废（仅 Draft/Pending，仅本人；关联审批单一并撤回） */
  async cancelPaymentRequest(id: string, endpoint?: string): Promise<PaymentRequest> {
    const res = await fetch(requestUrl(`/${encodeURIComponent(id)}/cancel`, endpoint), {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify({}),
    });
    if (!res.ok) await readError(res, 'cancelPaymentRequest failed');
    const data = await res.json();
    return data.paymentRequest;
  },
};
