/**
 * sealService — §10.3-9 电子签·印章库前端服务。
 *
 * 对接服务端 /api/v1/seals（JWT-only + 领导/老板角色门禁；章图敏感，不对外开放）：
 *   GET    /           列表（?type=&ownerRoleId=&ownerUserId=&includeInactive=1）
 *   POST   /           新建
 *   PATCH  /:id        更新（改名/换图/改归属/设默认/启停）
 *   DELETE /:id        软删除
 *   GET    /resolve    按签字人解析应盖章图（?userId=&roleId=）
 */

import { apiService } from './apiService';

export const SEAL_TYPES = ['company_seal', 'legal_rep_seal', 'finance_seal', 'other'] as const;
export type SealType = (typeof SEAL_TYPES)[number];

export const SEAL_TYPE_LABELS: Record<string, string> = {
  company_seal: '公司公章',
  legal_rep_seal: '法人章',
  finance_seal: '财务专用章',
  other: '其他章',
};

/** 内置角色（与 server `_shared/rolePermissionMatrix.SYSTEM_ROLE_IDS` 对齐）——印章按角色归属用 */
export const SEAL_ROLE_OPTIONS: { id: string; label: string }[] = [
  { id: 'role-sales', label: '业务员' },
  { id: 'role-sales-manager', label: '销售主管' },
  { id: 'role-finance', label: '财务' },
  { id: 'role-qc', label: 'QC' },
  { id: 'role-logistics', label: '物流' },
  { id: 'role-admin', label: '领导' },
  { id: 'role-super-admin', label: '老板' },
];

export interface SealRecord {
  id: string;
  name: string;
  type: string;
  imageDataUrl: string;
  ownerRoleId: string | null;
  ownerUserId: string | null;
  isDefault: boolean;
  isActive: boolean;
  notes: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface SealInput {
  name: string;
  type?: SealType;
  imageDataUrl: string;
  ownerRoleId?: string | null;
  ownerUserId?: string | null;
  isDefault?: boolean;
  isActive?: boolean;
  notes?: string;
}

export interface ResolvedSeal {
  id: string;
  name: string;
  imageDataUrl: string;
}

function sealUrl(path: string, endpoint?: string): string {
  const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
  return apiService.buildApiUrl(`/v1/seals${path}`, base);
}

async function readError(res: any, fallback: string): Promise<never> {
  let message = fallback;
  try {
    const data = await res.json();
    message = data?.error?.message || data?.message || data?.error || fallback;
  } catch {
    /* 非 JSON 响应 → 用兜底文案 */
  }
  const err: any = new Error(typeof message === 'string' ? message : fallback);
  err.status = res.status;
  throw err;
}

export const sealService = {
  /** 印章列表（含敏感章图；仅领导/老板可调） */
  async listSeals(params: { includeInactive?: boolean; type?: string } = {}, endpoint?: string): Promise<SealRecord[]> {
    const qs = new URLSearchParams();
    if (params.includeInactive) qs.set('includeInactive', '1');
    if (params.type) qs.set('type', params.type);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const res = await fetch(sealUrl(`/${suffix}`, endpoint), { headers: apiService.getAuthHeaders() });
    if (!res.ok) await readError(res, '加载印章列表失败');
    const data = await res.json();
    return Array.isArray(data.items) ? data.items : [];
  },

  async createSeal(input: SealInput, endpoint?: string): Promise<SealRecord> {
    const res = await fetch(sealUrl('/', endpoint), {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(input),
    });
    if (!res.ok) await readError(res, '新建印章失败');
    const data = await res.json();
    return data.item;
  },

  async updateSeal(id: string, patch: Partial<SealInput>, endpoint?: string): Promise<SealRecord> {
    const res = await fetch(sealUrl(`/${encodeURIComponent(id)}`, endpoint), {
      method: 'PATCH',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(patch),
    });
    if (!res.ok) await readError(res, '更新印章失败');
    const data = await res.json();
    return data.item;
  },

  async deleteSeal(id: string, endpoint?: string): Promise<void> {
    const res = await fetch(sealUrl(`/${encodeURIComponent(id)}`, endpoint), {
      method: 'DELETE',
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) await readError(res, '删除印章失败');
  },

  /** 按签字人解析应盖章图（渲染链内部用；此处供管理端「生效预览」核对） */
  async resolveSeal(params: { userId?: string; roleId?: string }, endpoint?: string): Promise<ResolvedSeal | null> {
    const qs = new URLSearchParams();
    if (params.userId) qs.set('userId', params.userId);
    if (params.roleId) qs.set('roleId', params.roleId);
    const res = await fetch(sealUrl(`/resolve?${qs.toString()}`, endpoint), { headers: apiService.getAuthHeaders() });
    if (!res.ok) await readError(res, '解析印章失败');
    const data = await res.json();
    return data.seal ?? null;
  },
};

export default sealService;
