/**
 * Reporting API service — REQ2-17 月末批量结转（DR-058）。
 * Communicates with /api/v1/reports endpoints:
 *   POST /monthly-close           — 月末批量结转（mc: 幂等键月末时点快照）
 *   GET  /monthly-close/compare   — 月度对比（相邻期 metric 汇总 Δ/Δ%）
 *
 * 类型定义内聚在本文件（root types.ts 为冻结区，禁止编辑）。
 * 设计真源：docs/design/04-模块设计/05-财务与结算/月末批量结转.md
 */
import { apiService } from './apiService';

export interface MonthlyCloseRunItem {
  definitionId: string;
  name: string;
  datasetKey: string;
  runId?: string;
  rowCount?: number;
  skipped: boolean;
  error?: string;
}

export interface MonthlyCloseRunResult {
  periodKey: string;
  total: number;
  ran: number;
  skipped: number;
  failed: number;
  results: MonthlyCloseRunItem[];
}

export interface MonthlyCloseDelta {
  metric: string;
  /** 本期/上期快照缺失时为 null（无基线 = 不可计算，不是 0），前端渲染为「—」 */
  current: number | null;
  previous: number | null;
  delta: number | null;
  deltaPct: number | null;
}

export interface MonthlyCloseCompareItem {
  definitionId: string;
  name: string;
  datasetKey: string;
  current: { runId: string; rowCount: number; totals: Record<string, number> } | null;
  previous: { runId: string; rowCount: number; totals: Record<string, number> } | null;
  deltas: MonthlyCloseDelta[];
}

export interface MonthlyCloseCompare {
  periodKey: string;
  previousPeriodKey: string;
  items: MonthlyCloseCompareItem[];
}

async function readError(res: Response, fallback: string): Promise<never> {
  const data = await res.json().catch(() => ({}));
  const code = data?.error?.code ?? (typeof data?.error === 'string' ? data.error : undefined);
  const rawMessage = data?.error?.message || data?.message || data?.error || `${fallback}: HTTP ${res.status}`;
  const message = typeof rawMessage === 'string' ? rawMessage : JSON.stringify(rawMessage);
  const err: any = new Error(code && !message.includes(code) ? `${code}：${message}` : message);
  err.status = res.status;
  err.code = code;
  throw err;
}

function reportsUrl(path: string, endpoint?: string): string {
  const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
  return apiService.buildApiUrl(`/v1/reports${path}`, base);
}

export const reportingService = {
  /** 月末批量结转（periodKey 默认上一个完整月；幂等：已结转定义 skipped） */
  async runMonthlyClose(periodKey?: string, endpoint?: string): Promise<MonthlyCloseRunResult> {
    const res = await fetch(reportsUrl('/monthly-close', endpoint), {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(periodKey ? { periodKey } : {}),
    });
    if (!res.ok) await readError(res, 'monthly close failed');
    return await res.json();
  },

  /** 月度对比（相邻期 mc: 快照 metric 汇总 Δ/Δ%） */
  async compareMonthlyClose(periodKey?: string, endpoint?: string): Promise<MonthlyCloseCompare> {
    const qs = periodKey ? `?periodKey=${encodeURIComponent(periodKey)}` : '';
    const res = await fetch(`${reportsUrl('/monthly-close/compare', endpoint)}${qs}`, {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) await readError(res, 'monthly close compare failed');
    return await res.json();
  },
};
