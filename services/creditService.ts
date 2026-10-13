/**
 * Credit API service — 信用控制域（客户额度冻结/解冻/状态/历史时间线 + 破产货权处置）。
 * Communicates with /api/v1/credit endpoints（:customerId = 客户 Relation.id）:
 *   POST /:customerId/freeze   — 人工冻结（scope credit:freeze:write，理由必填）
 *   POST /:customerId/thaw     — 主管手动解冻（scope credit:thaw:write，理由必填，记录 thawedReason）
 *   GET  /:customerId/status   — 信用状态（含门禁标记 creditFrozen / 最大逾期天数）
 *   GET  /:customerId/history  — 历史时间线（冻结/解冻/占用释放全事件，append-only）
 *
 * REQ2-15 客户破产货权处置（DR-055，同挂 /v1/credit）：
 *   POST /bankruptcy            — 开案（declare 首动作 + 自动信用冻结 best-effort）
 *   GET  /bankruptcy            — 案件列表（含动作计数与金额汇总）
 *   GET  /bankruptcy/:id        — 案件详情 + 动作时间线（append-only 正序）+ 损益汇总
 *   POST /bankruptcy/:id/actions — 追加处置动作（resale/return_shipment/bad_debt/recover）
 *   POST /bankruptcy/:id/close  — 闭案（close 动作 + 汇总结论落 closeNote，终态）
 *
 * 类型定义内聚在本文件（root types.ts 为冻结区，禁止编辑）。
 * 设计真源：docs/design/03-业务规则/信用控制规则.md §2.4 / §6 #5/#6；
 *          docs/design/04-模块设计/05-财务与结算/客户破产货权处置.md（REQ2-15，X-10）。
 */
import { apiService } from './apiService';

// ── 额度状态（CreditLimit.status；冻结门禁以 Frozen 为唯一真源） ──
export type CreditLimitStatus = 'Active' | 'Frozen' | 'Expired' | 'Revoked' | string;

export const CREDIT_LIMIT_STATUS_LABELS: Record<string, string> = {
  Active: '正常',
  Frozen: '已冻结',
  Expired: '已过期',
  Revoked: '已吊销',
};

/** 系统自动冻结/解冻身份（镜像后端 SYSTEM_CREDIT_ACTOR） */
export const SYSTEM_CREDIT_ACTOR = 'system_credit_scan';

/** 60 天逾期冻结阈值（镜像后端 OVERDUE_FREEZE_THRESHOLD_DAYS） */
export const OVERDUE_FREEZE_THRESHOLD_DAYS = 60;

/** GET /:customerId/status 返回的信用状态视图 */
export interface CreditStatus {
  relationId: string;
  hasCreditLimit: boolean;
  creditLimitId: string | null;
  status: CreditLimitStatus | null;
  /** 门禁标记：Frozen/Revoked → true（新订单阻断结论） */
  creditFrozen: boolean;
  totalLimit: number | null;
  usedAmount: number | null;
  remaining: number | null;
  currency: string | null;
  frozenAt: string | null;
  frozenBy: string | null;
  thawedReason: string | null;
  lastAutoScanDate: string | null;
  /** 未结清应收发票的最大逾期天数（Net 30 推定口径，与后端同源） */
  maxOverdueDays: number;
}

/** CreditLimitHistory 时间线条目（append-only） */
export interface CreditHistoryItem {
  id: string;
  creditLimitId: string;
  relationId: string;
  beforeUsedAmount: number;
  afterUsedAmount: number;
  /** after - before（正=占用，负=释放，0=冻结/解冻状态迁移留痕） */
  delta: number;
  /** payment_allocate | order_confirm | order_cancel | manual_adjust | credit_freeze | credit_thaw */
  triggerType: string;
  triggerId: string | null;
  triggerBy: string | null;
  remark: string | null;
  createdAt: string;
}

export const CREDIT_TRIGGER_TYPE_LABELS: Record<string, string> = {
  payment_allocate: '收款核销',
  order_confirm: '订单确认',
  order_cancel: '订单取消',
  manual_adjust: '手动调整',
  credit_freeze: '信用冻结',
  credit_thaw: '信用解冻',
};

export const creditTriggerTypeLabel = (triggerType?: string | null): string =>
  (triggerType && CREDIT_TRIGGER_TYPE_LABELS[triggerType]) || triggerType || '—';

// ───────────────────────────────────────────────────────────────────
// REQ2-15 客户破产货权处置（DR-055；镜像 server/src/credit/bankruptcyService.ts）
// ───────────────────────────────────────────────────────────────────

/** 处置动作类型（append-only：declare 首动作开案，close 终动作闭案） */
export type BankruptcyActionType = 'declare' | 'resale' | 'return_shipment' | 'bad_debt' | 'recover' | 'close';

/** 处置期可追加的动作（declare/close 由专用端点触发） */
export const DISPOSAL_ACTION_TYPES: readonly BankruptcyActionType[] = ['resale', 'return_shipment', 'bad_debt', 'recover'];

export const BANKRUPTCY_ACTION_LABELS: Record<string, string> = {
  declare: '宣告破产',
  resale: '转卖处置',
  return_shipment: '退运',
  bad_debt: '坏账登记',
  recover: '部分回款',
  close: '闭案',
};

export const bankruptcyActionLabel = (actionType?: string | null): string =>
  (actionType && BANKRUPTCY_ACTION_LABELS[actionType]) || actionType || '—';

/** 损益汇总（净损失 = 申报债权额 − 转卖回收 − 部分回款 + 退运成本） */
export interface BankruptcySummary {
  totalClaimed: number;
  resaleRecovered: number;
  returnShippingCost: number;
  badDebt: number;
  recovered: number;
  netLoss: number;
  actionCount: number;
}

/** BankruptcyProceeding 视图（后端 serializeValue：BigInt/Decimal → number） */
export interface BankruptcyProceedingView {
  id: string;
  proceedingNumber: string;
  relationId: string;
  relationName: string;
  status: 'processing' | 'closed' | string;
  declaredAt: string;
  totalClaimedAmount: number;
  closeNote: string | null;
  closedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** BankruptcyAction 视图（append-only 时间线条目） */
export interface BankruptcyActionView {
  id: string;
  proceedingId: string;
  actionType: BankruptcyActionType | string;
  amount: number;
  payload: Record<string, unknown> | null;
  note: string | null;
  actor: string | null;
  createdAt: number;
}

/** 列表项 = 案件 + 实时汇总 */
export interface BankruptcyProceedingItem extends BankruptcyProceedingView {
  summary: BankruptcySummary;
}

export interface OpenBankruptcyInput {
  relationId: string;
  declaredAt: string;
  totalClaimedAmount: number;
  note?: string;
}

export interface AddBankruptcyActionInput {
  actionType: BankruptcyActionType;
  amount?: number;
  payload?: Record<string, unknown>;
  note?: string;
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

function creditUrl(customerId: string, path: string, endpoint?: string): string {
  const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
  return apiService.buildApiUrl(`/v1/credit/${encodeURIComponent(customerId)}${path}`, base);
}

/** REQ2-15 破产处置端点前缀：/v1/credit/bankruptcy（与信用域同路由，非 :customerId 子路径） */
function bankruptcyUrl(path: string, endpoint?: string): string {
  const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
  return apiService.buildApiUrl(`/v1/credit/bankruptcy${path}`, base);
}

export const creditService = {
  /** 客户信用状态（含门禁标记 creditFrozen / 最大逾期天数） */
  async getCreditStatus(customerId: string, endpoint?: string): Promise<CreditStatus> {
    const res = await fetch(creditUrl(customerId, '/status', endpoint), {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) await readError(res, 'getCreditStatus failed');
    const data = await res.json();
    return data;
  },

  /** 历史时间线（冻结/解冻/占用释放全事件，append-only，按时间倒序） */
  async getCreditHistory(
    customerId: string,
    params?: { limit?: number; offset?: number },
    endpoint?: string,
  ): Promise<{ items: CreditHistoryItem[]; total: number }> {
    const url = creditUrl(customerId, '/history', endpoint);
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    const fullUrl = query.toString() ? `${url}?${query.toString()}` : url;
    const res = await fetch(fullUrl, { headers: apiService.getAuthHeaders() });
    if (!res.ok) await readError(res, 'getCreditHistory failed');
    const data = await res.json();
    return { items: Array.isArray(data.items) ? data.items : [], total: Number(data.total ?? 0) };
  },

  /** 人工冻结（scope credit:freeze:write；理由必填，审计强制） */
  async freezeCredit(customerId: string, reason: string, endpoint?: string): Promise<{ frozen: string[] }> {
    const res = await fetch(creditUrl(customerId, '/freeze', endpoint), {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) await readError(res, 'freezeCredit failed');
    const data = await res.json();
    return { frozen: Array.isArray(data.frozen) ? data.frozen : [] };
  },

  /** 主管手动解冻（scope credit:thaw:write；理由必填，记录 thawedReason） */
  async thawCredit(customerId: string, reason: string, endpoint?: string): Promise<{ thawed: string[] }> {
    const res = await fetch(creditUrl(customerId, '/thaw', endpoint), {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) await readError(res, 'thawCredit failed');
    const data = await res.json();
    return { thawed: Array.isArray(data.thawed) ? data.thawed : [] };
  },

  // ── REQ2-15 客户破产货权处置（DR-055；写守卫 credit:freeze:write，服务端 fail-closed） ──

  /** 案件列表（含每案动作计数与金额汇总；可按 relationId/status 过滤） */
  async listBankruptcyProceedings(
    params?: { relationId?: string; status?: string },
    endpoint?: string,
  ): Promise<BankruptcyProceedingItem[]> {
    const query = new URLSearchParams();
    if (params?.relationId) query.set('relationId', params.relationId);
    if (params?.status) query.set('status', params.status);
    const qs = query.toString();
    const res = await fetch(`${bankruptcyUrl('', endpoint)}${qs ? `?${qs}` : ''}`, {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) await readError(res, 'listBankruptcyProceedings failed');
    const data = await res.json();
    return Array.isArray(data.items) ? data.items : [];
  },

  /** 案件详情：动作时间线（append-only 正序）+ 损益汇总 */
  async getBankruptcyProceeding(
    id: string,
    endpoint?: string,
  ): Promise<{ proceeding: BankruptcyProceedingView; actions: BankruptcyActionView[]; summary: BankruptcySummary }> {
    const res = await fetch(bankruptcyUrl(`/${encodeURIComponent(id)}`, endpoint), {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) await readError(res, 'getBankruptcyProceeding failed');
    const data = await res.json();
    return {
      proceeding: data.proceeding,
      actions: Array.isArray(data.actions) ? data.actions : [],
      summary: data.summary,
    };
  },

  /** 开案：declare 首动作 + 自动信用冻结 best-effort（同客户活跃案件唯一，409 冲突） */
  async openBankruptcyProceeding(
    input: OpenBankruptcyInput,
    endpoint?: string,
  ): Promise<{ proceeding: BankruptcyProceedingView; creditFrozen: boolean }> {
    const res = await fetch(bankruptcyUrl('', endpoint), {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(input),
    });
    if (!res.ok) await readError(res, 'openBankruptcyProceeding failed');
    const data = await res.json();
    return { proceeding: data.proceeding, creditFrozen: Boolean(data.creditFrozen) };
  },

  /** 追加处置动作（resale/return_shipment/bad_debt/recover；closed 案件 409） */
  async addBankruptcyAction(
    id: string,
    input: AddBankruptcyActionInput,
    endpoint?: string,
  ): Promise<{ action: BankruptcyActionView; summary: BankruptcySummary }> {
    const res = await fetch(bankruptcyUrl(`/${encodeURIComponent(id)}/actions`, endpoint), {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(input),
    });
    if (!res.ok) await readError(res, 'addBankruptcyAction failed');
    const data = await res.json();
    return { action: data.action, summary: data.summary };
  },

  /** 闭案（终态：close 动作 + 汇总结论落 closeNote；闭案不自动解冻，DR-055-③） */
  async closeBankruptcyProceeding(
    id: string,
    input: { note?: string },
    endpoint?: string,
  ): Promise<{ proceeding: BankruptcyProceedingView; summary: BankruptcySummary }> {
    const res = await fetch(bankruptcyUrl(`/${encodeURIComponent(id)}/close`, endpoint), {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(input),
    });
    if (!res.ok) await readError(res, 'closeBankruptcyProceeding failed');
    const data = await res.json();
    return { proceeding: data.proceeding, summary: data.summary };
  },
};
