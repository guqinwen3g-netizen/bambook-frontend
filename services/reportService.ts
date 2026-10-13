/**
 * A5 报表引擎 API service — /api/v1/reports
 *
 * 契约要点：
 *   - 数据集/维度/指标/过滤字段均为服务端白名单，客户端只传字段名（注入不可能）
 *   - 预览 ≤500 行不落库；运行落快照（≤5000 行）供 CSV 重放导出
 *   - 定时调度幂等键 definitionId:periodKey，同周期重复触发被服务端跳过
 */
import { apiService } from './apiService';

// ────────────────────────────────────────────────────────────────
// 类型（与 server/src/reporting/datasets.ts + reportEngine.ts 对齐）
// ────────────────────────────────────────────────────────────────

export type ReportFieldType = 'string' | 'number' | 'date' | 'enum';

export interface ReportFieldSpec {
  key: string;
  label: string;
  type: ReportFieldType;
  enumValues?: readonly string[];
}

export interface ReportDatasetSpec {
  key: string;
  label: string;
  prismaModel: string;
  description?: string;
  dimensions: ReportFieldSpec[];
  metrics: ReportFieldSpec[];
  filterFields: ReportFieldSpec[];
  /** A5d 下钻契约：EntityLink 图谱类型码 */
  entityType: string;
  /** A5d 下钻契约：实体主键字段 */
  idField: string;
  /** A5d 下钻契约：明细行展示字段 */
  detailFields: ReportFieldSpec[];
}

export type ReportMetricAgg = 'sum' | 'avg' | 'min' | 'max' | 'count';
export type ReportFilterOp = 'eq' | 'ne' | 'in' | 'gte' | 'lte' | 'contains';
export type ReportSchedule = 'daily' | 'weekly' | 'monthly';

export interface ReportMetricSpec {
  field: string;
  agg: ReportMetricAgg;
}

export interface ReportFilterSpec {
  field: string;
  op: ReportFilterOp;
  value: unknown;
}

export interface ReportDefinition {
  id: string;
  name: string;
  description?: string | null;
  datasetKey: string;
  dimensions: string[];
  metrics: ReportMetricSpec[];
  filters?: ReportFilterSpec[] | null;
  schedule?: ReportSchedule | null;
  enabled: boolean;
  lastRunAt?: number | null;
  createdBy?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ReportDefinitionInput {
  name: string;
  description?: string;
  datasetKey: string;
  dimensions: string[];
  metrics: ReportMetricSpec[];
  filters?: ReportFilterSpec[];
  schedule?: ReportSchedule | null;
  enabled?: boolean;
}

export interface ReportRun {
  id: string;
  definitionId: string;
  definitionName: string;
  status: 'Running' | 'Success' | 'Failed';
  trigger: 'manual' | 'schedule';
  idempotencyKey?: string | null;
  rowCount?: number | null;
  columns?: string[] | null;
  columnLabels?: string[] | null;
  rows?: Array<Record<string, string | number | null>> | null;
  error?: string | null;
  startedAt: number;
  finishedAt?: number | null;
  createdAt: number;
}

export interface ReportPreviewResult {
  columns: string[];
  columnLabels: string[];
  rows: Array<Record<string, string | number | null>>;
  truncated: boolean;
}

/** A5d 下钻组约束：维度字段 → 组值（null 对应 groupBy 空值组） */
export type ReportDrillGroup = Record<string, string | null>;

export interface ReportDrillResult {
  entityType: string;
  idField: string;
  columns: string[];
  columnLabels: string[];
  rows: Array<Record<string, string | number | null>>;
  /** 组内成员总数（rows ≤200 截断时用 total 提示） */
  total: number;
}

// ────────────────────────────────────────────────────────────────
// HTTP 辅助
// ────────────────────────────────────────────────────────────────

function buildUrl(path: string, endpoint?: string): string {
  const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
  return apiService.buildApiUrl(`/v1/reports${path}`, base);
}

function headers(): Record<string, string> {
  // 统一认证头：Content-Type + API key + 登录会话 JWT（写/预览/运行端点必须 JWT）
  return apiService.getAuthHeaders();
}

async function parseOrThrow<T>(res: Response, fallback: string): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `${fallback}: HTTP ${res.status}`);
  return data as T;
}

// ────────────────────────────────────────────────────────────────
// API
// ────────────────────────────────────────────────────────────────

export const reportService = {
  async listDatasets(endpoint?: string): Promise<ReportDatasetSpec[]> {
    const res = await fetch(buildUrl('/datasets', endpoint), { headers: headers() });
    const data = await parseOrThrow<{ datasets: ReportDatasetSpec[] }>(res, 'listDatasets failed');
    return Array.isArray(data.datasets) ? data.datasets : [];
  },

  async listDefinitions(endpoint?: string): Promise<ReportDefinition[]> {
    const res = await fetch(buildUrl('/definitions', endpoint), { headers: headers() });
    const data = await parseOrThrow<{ definitions: ReportDefinition[] }>(res, 'listDefinitions failed');
    return Array.isArray(data.definitions) ? data.definitions : [];
  },

  async createDefinition(input: ReportDefinitionInput, endpoint?: string): Promise<ReportDefinition> {
    const res = await fetch(buildUrl('/definitions', endpoint), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(input),
    });
    return parseOrThrow<ReportDefinition>(res, 'createDefinition failed');
  },

  async updateDefinition(id: string, patch: Partial<ReportDefinitionInput>, endpoint?: string): Promise<ReportDefinition> {
    const res = await fetch(buildUrl(`/definitions/${encodeURIComponent(id)}`, endpoint), {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify(patch),
    });
    return parseOrThrow<ReportDefinition>(res, 'updateDefinition failed');
  },

  async deleteDefinition(id: string, endpoint?: string): Promise<void> {
    const res = await fetch(buildUrl(`/definitions/${encodeURIComponent(id)}`, endpoint), {
      method: 'DELETE',
      headers: headers(),
    });
    await parseOrThrow<{ ok: boolean }>(res, 'deleteDefinition failed');
  },

  /** 临时预览（不落库，≤500 行） */
  async preview(input: Omit<ReportDefinitionInput, 'name'>, endpoint?: string): Promise<ReportPreviewResult> {
    const res = await fetch(buildUrl('/preview', endpoint), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(input),
    });
    return parseOrThrow<ReportPreviewResult>(res, 'preview failed');
  },

  /** A5d 下钻：聚合组 → 组成员实体明细（不落库，≤200 行，实时数据） */
  async drill(
    input: Omit<ReportDefinitionInput, 'name' | 'schedule'> & { group: ReportDrillGroup },
    endpoint?: string,
  ): Promise<ReportDrillResult> {
    const res = await fetch(buildUrl('/drill', endpoint), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(input),
    });
    return parseOrThrow<ReportDrillResult>(res, 'drill failed');
  },

  /** 手动运行（落快照） */
  async runDefinition(id: string, endpoint?: string): Promise<ReportRun> {
    const res = await fetch(buildUrl(`/definitions/${encodeURIComponent(id)}/run`, endpoint), {
      method: 'POST',
      headers: headers(),
    });
    const data = await parseOrThrow<{ run: ReportRun }>(res, 'runDefinition failed');
    return data.run;
  },

  /** R3：运行历史分页（后端支持 limit/offset 并返回 total；旧服务端无 total 时回退为本页条数） */
  async listRuns(definitionId?: string, options?: { limit?: number; offset?: number }, endpoint?: string): Promise<{ runs: ReportRun[]; total: number }> {
    const query = new URLSearchParams();
    if (definitionId) query.set('definitionId', definitionId);
    query.set('limit', String(options?.limit ?? 50));
    if (options?.offset) query.set('offset', String(options.offset));
    const res = await fetch(buildUrl(`/runs?${query.toString()}`, endpoint), { headers: headers() });
    const data = await parseOrThrow<{ runs: ReportRun[]; total?: number }>(res, 'listRuns failed');
    const runs = Array.isArray(data.runs) ? data.runs : [];
    return { runs, total: typeof data.total === 'number' ? data.total : runs.length };
  },

  async getRun(id: string, endpoint?: string): Promise<ReportRun> {
    const res = await fetch(buildUrl(`/runs/${encodeURIComponent(id)}`, endpoint), { headers: headers() });
    const data = await parseOrThrow<{ run: ReportRun }>(res, 'getRun failed');
    return data.run;
  },

  /**
   * CSV 导出：携带鉴权头 fetch → blob → a[download]。
   * 替代旧 <a href download> 裸链（无鉴权头必 401）与 apiKey 拼 URL（凭据进 URL/日志泄漏）。
   */
  async downloadRunCsv(runId: string, endpoint?: string): Promise<void> {
    const url = buildUrl(`/runs/${encodeURIComponent(runId)}/export.csv`, endpoint);
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) throw new Error(`报表导出失败：HTTP ${res.status}`);
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
    const filename = m && m[1] ? decodeURIComponent(m[1]) : `报表运行_${runId}.csv`;
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  },
};
