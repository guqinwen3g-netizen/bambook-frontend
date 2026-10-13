/**
 * 公差标准 API service（**双轨制**：内部标准 + 客户标准）。
 *
 * 契约真源：`server/src/orders/toleranceStandardRoute.ts`（fail-closed）
 *   GET  /api/v1/tolerance/internal-standard — 当前内部标准（登录即可读；未配置 ⇒ value:null + isDefault:true
 *                                              + defaultValue = **出厂默认**，界面据此预填）
 *   PUT  /api/v1/tolerance/internal-standard — 写入（scope `settings:tolerance:write`；reason ≥5 字；历史留痕）
 *   GET  /api/v1/tolerance/history           — append-only 变更历史
 *   GET  /api/v1/tolerance/customer-standard?relationId= — ★ P0 那一轨：该客户的标准 + 变更历史
 *   PUT  /api/v1/tolerance/customer-standard             — 写入/清空（scope `relations:write` 或 `settings:tolerance:write`）
 *
 * ★ 双轨制（使用方 2026-09-29 定的全局原则）：
 *   ① **客户标准**（`Relation.customerAgreementTolerance`）= ★ P0 **硬约束**（**没有**出厂默认）
 *   ② **内部标准**（`SystemConfig`）= 辅助；★ 公司未录时按**出厂默认**（后端 `internal_default`）
 *
 * ★★ 2026-09-29 晚 Kevin 口径（出厂默认）：
 *   「你可以有一个默认值，就是即使公司没有去设置这个内部值，你也直接用这个。」
 *   ⇒ 界面上「未配置」不再等于"出运会被一律卡住"；但要**显示清楚当前在用哪一套**。
 */
import { apiService } from './apiService';

// ── 类型（本文件自包含，避免触碰根 types.ts 与并行任务冲突） ──

/** 一档：`minQty`（含）~ `maxQty`（含，`null` = 上不封顶）之间，用 `pct` 百分比 */
export interface ToleranceBandItem {
  minQty: number;
  maxQty: number | null;
  pct: number;
}

export interface ToleranceStandardValue {
  /** 数量公差分档（按合同量选档） */
  qtyTolerance?: ToleranceBandItem[];
  /** 幅宽扣款比例分档（按幅宽选档） */
  widthDeduction?: ToleranceBandItem[];
  /** 约定日期（依据留痕） */
  agreementDate?: string;
  /** 依据（哪份规定/合同） */
  agreementRef?: string;
}

export interface ToleranceStandardResponse {
  ok: boolean;
  key: string;
  /** ★ `null` = **未配置**（不是空对象）—— 界面必须显示「未配置，请录入」而不是造一个默认值 */
  value: ToleranceStandardValue | null;
  /** ★ **出厂默认**（后端常量）：`isDefault:true` 时**它在生效**，界面用它预填表单 */
  defaultValue?: ToleranceStandardValue | null;
  version: number;
  /** ★ `true` = 从未配置过（`value` 必为 `null`） */
  isDefault: boolean;
  updatedAt: number | null;
  updatedBy: string | null;
}

/** 客户标准变更历史一条（来源 = 服务端审计行 ⇒ 方案 A「没有历史表」的代价由此补齐） */
export interface CustomerToleranceHistoryItem {
  id: string;
  at: string;
  actorId: string;
  reason: string | null;
  from: unknown;
  to: unknown;
}

export interface CustomerToleranceResponse {
  ok: boolean;
  relationId: string;
  customerName: string | null;
  /** ★ **客户标准没有出厂默认**：未录就是 `null`（我们不许替客户编标准） */
  value: ToleranceStandardValue | null;
  /** ★ `true` = 该客户尚未录标准（此时取数链往下降级） */
  isUnset: boolean;
  history: CustomerToleranceHistoryItem[];
}

export interface ToleranceStandardHistoryItem {
  id: string;
  versionFrom: number;
  versionTo: number;
  valueFrom: unknown;
  valueTo: unknown;
  actorId: string | null;
  reason: string | null;
  createdAt: string;
}

export interface ToleranceStandardUpdateInput {
  value: ToleranceStandardValue;
  /** 审计强制：trim 后 ≥5 字（与 MOQ 配置同口径） */
  reason: string;
}

/** 错误契约：`{ error: 'SCOPE_DENIED' 等码, message: 人类可读 }`（错误码透传） */
async function readToleranceError(res: Response, op: string): Promise<never> {
  const err = await res.json().catch(() => ({}));
  const code = typeof err?.error === 'string' ? err.error : undefined;
  const message = typeof err?.message === 'string' && err.message
    ? err.message
    : code || `${op} failed: HTTP ${res.status}`;
  const error: any = new Error(code && err?.message && !message.includes(code) ? `${code}：${message}` : message);
  error.status = res.status;
  error.code = code;
  throw error;
}

export const toleranceStandardService = {
  /** 读取当前内部公差标准（未配置 ⇒ value=null + isDefault=true） */
  async getInternalStandard(endpoint?: string): Promise<ToleranceStandardResponse> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/tolerance/internal-standard', base);
    const res = await fetch(url, { headers: apiService.getAuthHeaders() });
    if (!res.ok) return readToleranceError(res, 'getInternalToleranceStandard');
    return res.json();
  },

  /** 写入内部公差标准（需 `settings:tolerance:write`；reason trim 后 ≥5 字） */
  async updateInternalStandard(input: ToleranceStandardUpdateInput, endpoint?: string): Promise<{ version: number }> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/tolerance/internal-standard', base);
    const res = await fetch(url, {
      method: 'PUT',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(input),
    });
    if (!res.ok) return readToleranceError(res, 'updateInternalToleranceStandard');
    const data = await res.json();
    return { version: data?.version ?? 0 };
  },

  /** 变更历史（append-only 只读，倒序） */
  async listHistory(limit?: number, endpoint?: string): Promise<ToleranceStandardHistoryItem[]> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/tolerance/history', base);
    const fullUrl = limit ? `${url}?limit=${encodeURIComponent(String(limit))}` : url;
    const res = await fetch(fullUrl, { headers: apiService.getAuthHeaders() });
    if (!res.ok) return readToleranceError(res, 'listToleranceStandardHistory');
    const data = await res.json();
    return Array.isArray(data.items) ? data.items : [];
  },

  // ── ★ P0 那一轨：客户公差标准（2026-09-29 晚新增） ──

  /** 读某客户的公差标准 + 变更历史（未录 ⇒ `value:null` + `isUnset:true`） */
  async getCustomerStandard(relationId: string, endpoint?: string): Promise<CustomerToleranceResponse> {
    if (!relationId) throw Object.assign(new Error('读取客户公差标准必须带 relationId'), { code: 'RELATION_ID_REQUIRED' });
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/tolerance/customer-standard', base);
    const res = await fetch(`${url}?relationId=${encodeURIComponent(relationId)}`, { headers: apiService.getAuthHeaders() });
    if (!res.ok) return readToleranceError(res, 'getCustomerToleranceStandard');
    return res.json();
  },

  /**
   * 写 / 清空某客户的公差标准（scope `relations:write` 或 `settings:tolerance:write`；reason ≥5 字）。
   * ★ 清空必须**显式**传 `value: null`（服务端拒绝"字段没传"）。
   */
  async updateCustomerStandard(
    input: { relationId: string; value: ToleranceStandardValue | null; reason: string },
    endpoint?: string,
  ): Promise<{ cleared: boolean }> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/tolerance/customer-standard', base);
    const res = await fetch(url, {
      method: 'PUT',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(input),
    });
    if (!res.ok) return readToleranceError(res, 'updateCustomerToleranceStandard');
    const data = await res.json();
    return { cleared: !!data?.cleared };
  },
};
