/**
 * MOQ 阈值配置 API service.
 * Communicates with /api/v1/moq endpoints（数据中心 fail-closed 真源）：
 *   GET  /config   — 当前生效配置（登录即可读；无 active 时 fallback 兜底常量）
 *   PUT  /config   — 更新配置（scope: settings:moq:write，changeReason ≥5 字，历史留痕）
 *   GET  /history  — append-only 变更历史
 *   POST /validate — dry-run 预检（不写库、不建审批单）
 */
import { apiService } from './apiService';

// ── 类型（本文件自包含，避免触碰根 types.ts 与并行任务冲突） ──

/** MoqThresholdConfig 记录（当前生效档位） */
export interface MoqThresholdConfigItem {
  id: string;
  fabricDefaultMoq: number;
  garmentDefaultMoq: number;
  capsuleMoq: number;
  isActive: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  changedBy: string;
  changeReason: string;
}

/** 无 active 配置时的兜底常量（last resort，A5） */
export interface MoqFallbackValues {
  fabricDefaultMoq: number;
  garmentDefaultMoq: number;
  capsuleMoq: number;
}

export interface MoqConfigResponse {
  item: MoqThresholdConfigItem | null;
  fallback: MoqFallbackValues | null;
  message?: string;
}

/** MoqThresholdConfigHistory 记录（append-only） */
export interface MoqConfigHistoryItem {
  id: string;
  configId: string | null;
  beforeFabricDefaultMoq: number;
  beforeGarmentDefaultMoq: number;
  beforeCapsuleMoq: number;
  afterFabricDefaultMoq: number;
  afterGarmentDefaultMoq: number;
  afterCapsuleMoq: number;
  changedBy: string;
  changeReason: string;
  changedAt: string;
}

export interface MoqConfigUpdateInput {
  fabricDefaultMoq: number;
  garmentDefaultMoq: number;
  capsuleMoq: number;
  /** 审计强制：trim 后 ≥5 字 */
  changeReason: string;
}

export interface MoqValidateLineInput {
  quantity: number;
  unit?: string;
  /** fabric | garment | capsule | other */
  businessLine?: string;
}

export type MoqGapSeverity = 'none' | 'low' | 'medium' | 'high';

export interface MoqValidateLineVerdict {
  lineIndex: number;
  quantity: number;
  unit: string;
  effectiveMoq: number;
  source: string;
  capsuleActive: boolean;
  compliant: boolean;
  /** 缺口百分比（仅不合规时 >0，1 位小数） */
  gapPct: number;
  severity: MoqGapSeverity;
  badge: 'none' | 'yellow' | 'red';
  requiresApproval: boolean;
}

export interface MoqValidateResult {
  ok: boolean;
  capsuleActive: boolean;
  lines: MoqValidateLineVerdict[];
  blockedLineIndexes: number[];
  snapshot: {
    fabricDefaultMoq: number;
    garmentDefaultMoq: number;
    capsuleMoq: number;
    snapshotAt: string;
    configId: string | null;
    source: 'moq_config' | 'fallback_constant';
  };
}

export interface MoqValidateDryRunInput {
  businessLine?: string;
  /** Capsule 豁免档（仅成衣族业务线允许；设置台 capsule 探针使用） */
  capsuleExemption?: boolean;
  /** 预检口径快照（设置台场景：用「拟变更值」评估现行基准量是否仍合规） */
  snapshot?: Partial<MoqFallbackValues>;
  lines: MoqValidateLineInput[];
}

/** MOQ 路由错误契约：{ error: 'SCOPE_DENIED' 等码, message: 人类可读 } — 错误码透传（err.code + CODE：message 前缀） */
async function readMoqError(res: Response, op: string): Promise<never> {
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

export const moqService = {
  /** 读取当前生效 MOQ 配置（无 active → item=null + fallback 兜底常量） */
  async getConfig(endpoint?: string): Promise<MoqConfigResponse> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/moq/config', base);
    const res = await fetch(url, { headers: apiService.getAuthHeaders() });
    if (!res.ok) return readMoqError(res, 'getMoqConfig');
    return res.json();
  },

  /** 更新 MOQ 阈值（需 settings:moq:write；changeReason trim 后 ≥5 字） */
  async updateConfig(input: MoqConfigUpdateInput, endpoint?: string): Promise<MoqThresholdConfigItem> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/moq/config', base);
    const res = await fetch(url, {
      method: 'PUT',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(input),
    });
    if (!res.ok) return readMoqError(res, 'updateMoqConfig');
    const data = await res.json();
    return data.item;
  },

  /** 变更历史（append-only 只读，按 changedAt 倒序） */
  async listHistory(limit?: number, endpoint?: string): Promise<MoqConfigHistoryItem[]> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/moq/history', base);
    const fullUrl = limit ? `${url}?limit=${encodeURIComponent(String(limit))}` : url;
    const res = await fetch(fullUrl, { headers: apiService.getAuthHeaders() });
    if (!res.ok) return readMoqError(res, 'listMoqHistory');
    const data = await res.json();
    return Array.isArray(data.items) ? data.items : [];
  },

  /** dry-run 预检（不写库、不建审批单；snapshot 传入拟变更口径评估影响） */
  async validateDryRun(input: MoqValidateDryRunInput, endpoint?: string): Promise<MoqValidateResult> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/moq/validate', base);
    const res = await fetch(url, {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(input),
    });
    if (!res.ok) return readMoqError(res, 'validateMoqDryRun');
    return res.json();
  },
};
