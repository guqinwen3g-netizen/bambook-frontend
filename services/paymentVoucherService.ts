/**
 * PaymentVoucher API service.
 * Communicates with /api/v1/finance/vouchers endpoints.
 */
import { apiService } from './apiService';
import { runFinanceCommand } from './financeCommandRecovery';
import { cashAccountReference } from './companyCashAccountService';
import type { PaymentVoucher, VoucherStatus, VoucherType } from '../types';

/**
 * P0-9 / DR-022 凭证分类枚举真源（镜像后端 VALID_VOUCHER_CATEGORIES，
 * server/src/finance/paymentVoucherMutationService.ts fail-closed 校验）。
 * root types.ts 为冻结区（禁止编辑），VoucherCategory 内聚在本文件。
 */
export const VOUCHER_CATEGORIES = [
  'normal',
  'advance',
  'deposit',
  'sample_express',
  'customer_reimburse',
  'business_cost',
] as const;
export type VoucherCategory = (typeof VOUCHER_CATEGORIES)[number];

/** 凭证分类中文文案（设计真源：Prisma缺口清单与迁移方案.md P0-9 / 财务域模型组.md §2.2） */
export const VOUCHER_CATEGORY_LABELS: Record<VoucherCategory, string> = {
  normal: '常规',
  advance: '预收/预付',
  deposit: '保证金',
  sample_express: '样品快递费',
  customer_reimburse: '客户报销',
  business_cost: '业务成本',
};

export const voucherCategoryLabel = (category?: string | null): string =>
  category && (VOUCHER_CATEGORIES as readonly string[]).includes(category)
    ? VOUCHER_CATEGORY_LABELS[category as VoucherCategory]
    : (category || '—');

/** 列表/详情运行时行可能携带 voucherCategory（types.ts PaymentVoucher 冻结未含此列） */
export type PaymentVoucherWithCategory = PaymentVoucher & { voucherCategory?: VoucherCategory };

/** 创建/编辑输入允许携带 voucherCategory（后端 schema default('normal') 兜底） */
export type PaymentVoucherMutationInput = Omit<Partial<PaymentVoucher>, 'amount'|'bankFee'> & {
  amount?: string | number;
  bankFee?:string|number;
  feeBearer?:string;
  voucherCategory?: VoucherCategory;
  requestKey?: string;
  expectedUpdatedAt?: string;
  companyAccountId?: string;
  expectedAccountRevision?: number;
  actualAccountAmount?: string;
  bankReference?: string;
  evidenceNote?: string;
  /** DR-017 先申请后付款：Disbursement 必须关联审批通过的 PaymentRequest（后端门禁 PAYMENT_REQUEST_REQUIRED fail-closed） */
  paymentRequestId?: string;
};

type PaymentVoucherListParams = {
  type?: VoucherType;
  status?: VoucherStatus;
  invoiceId?: string;
  orderId?: string;
  search?: string;
  limit?: number;
  offset?: number;
};

/**
 * R678：统一错误透出——优先消费服务端 error.message（后端已中文化），
 * 无服务端文案时按 HTTP 状态码映射中文，杜绝 "xxx failed: HTTP 403" 英文裸透。
 */
const HTTP_STATUS_FALLBACK: Record<number, string> = {
  400: '请求参数有误',
  401: '登录状态已失效，请重新登录',
  403: '当前账号无权限执行此操作',
  404: '记录不存在或已被删除',
  409: '数据状态冲突，请刷新后重试',
  429: '操作过于频繁，请稍后再试',
  500: '服务器内部错误，请稍后重试',
};

/** 从错误响应体提取服务端文案（error.message / error 字符串 / message） */
function extractServerMessage(data: any): string {
  return (
    (typeof data?.error?.message === 'string' && data.error.message)
    || (typeof data?.error === 'string' && data.error)
    || (typeof data?.message === 'string' && data.message)
    || ''
  ).trim();
}

async function readVoucherError(res: Response, actionLabel: string): Promise<never> {
  const data = await res.json().catch(() => ({}));
  const reason = extractServerMessage(data) || HTTP_STATUS_FALLBACK[res.status] || '未知错误';
  throw new Error(`${actionLabel}失败：${reason}（HTTP ${res.status}）`);
}

export const paymentVoucherService = {
  async listPaymentVouchers(endpoint?: string, params?: PaymentVoucherListParams): Promise<PaymentVoucher[]> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/finance/vouchers', base);
    const query = new URLSearchParams();
    if (params?.type) query.set('type', params.type);
    if (params?.status) query.set('status', params.status);
    if (params?.invoiceId) query.set('invoiceId', params.invoiceId);
    if (params?.orderId) query.set('orderId', params.orderId);
    if (params?.search) query.set('search', params.search);
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));

    const fullUrl = query.toString() ? `${url}?${query.toString()}` : url;

    const res = await fetch(fullUrl, {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) await readVoucherError(res, '凭证列表加载');
    const data = await res.json();
    return data.items || [];
  },

  async getPaymentVoucher(id: string, endpoint?: string): Promise<PaymentVoucher> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/finance/vouchers/${encodeURIComponent(id)}`, base);

    const res = await fetch(url, {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) await readVoucherError(res, '凭证详情加载');
    const data = await res.json();
    return data;
  },

  async createPaymentVoucher(input: PaymentVoucherMutationInput, endpoint?: string): Promise<PaymentVoucher> {
    return runFinanceCommand({kind:'voucher.create',path:'/v1/finance/vouchers',method:'POST',permission:'vouchers:write',input,entity:'voucher',
      references:input.companyAccountId?[cashAccountReference(input.companyAccountId)]:[]},endpoint);
  },

  async updatePaymentVoucher(id: string, input: PaymentVoucherMutationInput, endpoint?: string): Promise<PaymentVoucher> {
    const path=`/v1/finance/vouchers/${encodeURIComponent(id)}`;
    return runFinanceCommand({kind:'voucher.update',targetId:id,path,method:'PATCH',permission:'vouchers:write',input,entity:'voucher',readPath:path,hashExtra:{voucherId:id}},endpoint);
  },

  // task_mqyusoio: 消费后端 DELETE /vouchers/:id（task_mqyurxot deleteVoucher service）
  /** 软删付款凭证（调后端 deleteVoucher service，HAS_ALLOCATIONS/NOT_FOUND 阻断） */
  async deletePaymentVoucher(id: string, endpoint?: string): Promise<{ ok: boolean }> {
    const path=`/v1/finance/vouchers/${encodeURIComponent(id)}`;
    return runFinanceCommand({kind:'voucher.delete',targetId:id,path,method:'DELETE',permission:'vouchers:write',input:{},entity:'none',readPath:path,hashExtra:{targetId:id}},endpoint);
  },

  /** 作废付款凭证（调后端 cancelVoucher service，HAS_ALLOCATIONS 阻断） */
  async cancelVoucher(id: string, reason?: string, endpoint?: string): Promise<PaymentVoucher> {
    const path=`/v1/finance/vouchers/${encodeURIComponent(id)}`;
    return runFinanceCommand({kind:'voucher.cancel',targetId:id,path:`${path}/cancel`,method:'POST',permission:'vouchers:write',input:{reason},entity:'voucher',readPath:path,hashExtra:{targetId:id}},endpoint);
  },
};
