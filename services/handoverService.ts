/**
 * Handover API service — REQ2-13 业务员离职一键交接（DR-056）。
 * Communicates with /api/v2/handover endpoints:
 *   GET  /preview    — 预览：离职者五类资产计数 + 警示（只读零写路径）
 *   POST /           — 执行交接（单事务原子）+ 可选停用 + 交接单/双审计留痕
 *   GET  /records    — 交接单历史（倒序，管理员审计视角）
 *
 * 门禁：users:admin（仅 SuperAdmin）。停用即时失效由服务端组合根守卫承接。
 * 类型定义内聚在本文件（root types.ts 为冻结区，禁止编辑）。
 * 设计真源：docs/design/04-模块设计/02-客户与开拓/业务员离职一键交接.md（REQ2-13，X-07）。
 */
import { apiService } from './apiService';

/** 五类移交资产计数（预览与执行共用同一口径） */
export interface HandoverCounts {
  relationsOwned: number;
  relationsCoFollowed: number;
  opportunities: number;
  followUpRecords: number;
  unanchoredOrders: number;
}

export interface HandoverUserBrief {
  id: string;
  displayName: string;
  email?: string | null;
  status: string;
  deletedAt?: string | number | null;
}

export interface HandoverPreview {
  fromUser: HandoverUserBrief;
  counts: HandoverCounts;
  warnings: string[];
}

export interface HandoverExecuteResult {
  handoverId: string;
  counts: HandoverCounts;
  accountDisabled: boolean;
}

export interface HandoverRecordView {
  id: string;
  fromUserId: string;
  toUserId: string;
  operatedBy: string;
  fromUserName: string;
  toUserName: string;
  disableAccount: boolean;
  note?: string | null;
  detail?: { relationsOwned?: number; relationsCoFollowed?: number; opportunities?: number; followUpRecords?: number; unanchoredOrders?: number } | null;
  createdAt: string | number;
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

function handoverUrl(path: string, endpoint?: string): string {
  const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
  return apiService.buildApiUrl(`/v2/handover${path}`, base);
}

export const handoverService = {
  /** 预览（toUserId 可选——给则追加接收人侧警示） */
  async preview(fromUserId: string, toUserId?: string, endpoint?: string): Promise<HandoverPreview> {
    const query = new URLSearchParams({ fromUserId });
    if (toUserId) query.set('toUserId', toUserId);
    const res = await fetch(`${handoverUrl('/preview', endpoint)}?${query.toString()}`, {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) await readError(res, 'handover preview failed');
    const data = await res.json();
    return {
      fromUser: data.fromUser,
      counts: data.counts,
      warnings: Array.isArray(data.warnings) ? data.warnings : [],
    };
  },

  /** 执行交接（默认停用离职者账号；单事务原子，失败整体回滚） */
  async execute(
    input: { fromUserId: string; toUserId: string; disableAccount?: boolean; note?: string },
    endpoint?: string,
  ): Promise<HandoverExecuteResult> {
    const res = await fetch(handoverUrl('', endpoint), {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(input),
    });
    if (!res.ok) await readError(res, 'handover execute failed');
    return await res.json();
  },

  /** 交接单历史（append-only 留痕，倒序） */
  async listRecords(limit = 20, endpoint?: string): Promise<{ records: HandoverRecordView[] }> {
    const res = await fetch(`${handoverUrl('/records', endpoint)}?limit=${limit}`, {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) await readError(res, 'handover records failed');
    const data = await res.json();
    return { records: Array.isArray(data.records) ? data.records : [] };
  },
};
