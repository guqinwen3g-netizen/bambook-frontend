/**
 * Production Pipeline API service.
 * Communicates with /api/v1/production endpoints.
 */
import { apiService } from './apiService';
import type { ProductionProgressBoard } from '../server/src/production/productionProgressContract';
export type { ProductionProgressBoard, ProductionProgressItem, ProductionProgressLine, ProductionProgressBranch } from '../server/src/production/productionProgressContract';

export interface PipelineStage {
  id: string;
  orderId: string;
  stageKey: string;
  stageSeq: number;
  status: 'pending' | 'in_progress' | 'done' | 'blocked';
  note?: string | null;
  operator?: string | null;
  startedAt?: number | null;
  doneAt?: number | null;
  signedByProduction?: string | null;
  signedByBusiness?: string | null;
  signedAtProduction?: number | null;
  signedAtBusiness?: number | null;
}

export interface PreCutChecklist {
  orderId: string;
  gradingConfirmed: boolean;
  consumptionConfirmed: boolean;
  patternConfirmed: boolean;
  preProductionMeeting: boolean;
  meetingNote?: string | null;
  confirmedBy?: string | null;
  confirmedAt?: number | null;
}

export type InspectionType = 'midline' | 'final';

export interface InspectionReport {
  id?: string;
  orderId: string;
  inspectionType?: InspectionType | null;
  scopeType?: 'whole_order' | 'production_batch' | null;
  scopeKey?: string | null;
  productionBatchId?: string | null;
  productionBatchRevision?: number | null;
  revision?: number;
  createdAt?: number;
  updatedAt?: number;
  totalUnits: number;
  passedUnits: number;
  passRate: number;
  defectRate: number;
  inspectionDate?: string | null;
  inspectorOrg?: string | null;
  aqlLevel?: string | null;
  lotSize?: number | null;
  sampleSize?: number | null;
  criticalDefects?: number;
  majorDefects?: number;
  minorDefects?: number;
  defectSummary?: string | null;
  result?: 'pass' | 'conditional' | 'fail' | null;
  shipmentId?: string | null;
  reportFile?: string | null;
  inspectedBy?: string | null;
  approvedByBusiness: boolean;
  businessApprover?: string | null;
  approvedAt?: number | null;
  notes?: string | null;
}

export interface ProductionPipeline {
  stages: PipelineStage[];
  checklist: PreCutChecklist | null;
  inspection: InspectionReport | null;
  inspections?: InspectionReport[];
  outsourcing?: OutsourcingProgress[];
}

/** 阶段 D / D5：外协进度只读视图（真源 OutsourcingOrder，管理 UI 在 MES 可选模块） */
export interface OutsourcingProgress {
  id: string;
  orderNumber: string;
  supplierId?: string | null;
  supplierName?: string | null;
  processType: string;
  status: string;
  quantity: number;
  unit: string;
  plannedDeliveryDate?: string | null;
  actualDeliveryDate?: string | null;
  qualityAcceptedQty: number;
  qualityRejectedQty: number;
}

/** PRD 19.8：生产跟单泳道看板聚合项（GET /v1/production/board） */
export interface ProductionBoardItem {
  order: {
    id: string;
    poNumber: string | null;
    customer: string;
    quantity: string | null;
    unit: string | null;
    quantitySummary: {
      version: 1;
      state: 'single_unit' | 'mixed_units' | 'unresolved' | 'legacy_unit_unrecorded';
      quantity: string | null;
      unit: string | null;
      groups: Array<{ unit: string; quantity: string }>;
      markedPartial: boolean;
      legacyQuantity: string | null;
    };
    status: string;
    dueDate: string;
    businessLine: string | null;
    merchandiser: string | null;
    millName: string | null;
  };
  stages: Array<{ stageKey: string; stageSeq: number; status: string }>;
  currentStageKey: string | null;
  blockedCount: number;
}

export const productionService = {
  async getProgress(endpoint?: string): Promise<ProductionProgressBoard> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const res = await fetch(apiService.buildApiUrl('/v1/production/progress', base), { headers: apiService.getAuthHeaders() });
    const data = await res.json();
    if (!res.ok || data?.ok !== true) throw new Error(data?.error?.message || `生产事实暂不可读取：HTTP ${res.status}`);
    if (data.schemaVersion !== 1 || !Array.isArray(data.items) || !data.stats || data.items.some((item: any) => !item.order?.id || !Array.isArray(item.lines)))
      throw new Error('生产事实响应不完整，请刷新后重试。');
    return data;
  },
  async getBoard(endpoint?: string): Promise<ProductionBoardItem[]> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/production/board`, base);
    const res = await fetch(url, {
      headers: apiService.getAuthHeaders(),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data?.error?.message || `getBoard failed: HTTP ${res.status}`);
    return data.items || [];
  },

  /**
   * ★ D2（2026-09-18）排产覆盖度核对（GET /v1/production/:orderId/capacity-coverage）
   *
   * 为什么要有：一张订单可挂多条排产单（多工位/多批次）与多张外协单（多外协厂），
   * 系统此前**从不做合计核对** ⇒ 1000 件的订单可以排成 3000 件、也可以只排 200 件，
   * 两种都只有到交期才知道。
   *
   * ★ 判据是**按工序类型**合计（不是整单合计）：每道工序都排「全量」是正常的
   *   （裁剪 1000 → 缝制 1000 → 包装 1000）。
   */
  async getCapacityCoverage(orderId: string, opts?: { tolerancePercent?: number }, endpoint?: string): Promise<{
    orderId: string;
    poNumber: string | null;
    orderQuantity: number | null;
    unit: string | null;
    tolerancePercent: number;
    judged: boolean;
    planCount: number;
    outsourcingCount: number;
    overProcessTypes: string[];
    unknownProcessTypes: string[];
    processes: Array<{
      processType: string; processLabel: string; plannedTotal: number; unit: string | null;
      share: number | null; verdict: 'ok' | 'over' | 'unknown'; overBy: number;
      entries: Array<{ processType: string; plannedQuantity: number | string; unit?: string | null; source: 'plan' | 'outsourcing'; label?: string | null }>;
    }>;
  }> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/production/${encodeURIComponent(orderId)}/capacity-coverage`, base);
    const query = new URLSearchParams();
    if (opts?.tolerancePercent != null) query.set('tolerancePercent', String(opts.tolerancePercent));
    const fullUrl = query.toString() ? `${url}?${query.toString()}` : url;
    const res = await fetch(fullUrl, { headers: apiService.getAuthHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `getCapacityCoverage failed: HTTP ${res.status}`);
    return data;
  },

  async getPipeline(orderId: string, endpoint?: string): Promise<ProductionPipeline> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/production/${encodeURIComponent(orderId)}`, base);
    const res = await fetch(url, {
      headers: apiService.getAuthHeaders(),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data?.error?.message || `getPipeline failed: HTTP ${res.status}`);
    return { stages: data.stages || [], checklist: data.checklist || null, inspection: data.inspection || null, inspections: data.inspections || [], outsourcing: data.outsourcing || [] };
  },

  async advanceStage(orderId: string, stageKey: string, note?: string, endpoint?: string, ownerOverride?: { reason: string }): Promise<PipelineStage> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/production/${encodeURIComponent(orderId)}/advance/${encodeURIComponent(stageKey)}`, base);
    const res = await fetch(url, {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify({ note, ownerOverride }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data?.error?.message || data?.error?.code || `advanceStage failed: HTTP ${res.status}`);
    return data.stage;
  },

  // ── §10.7 P-3：产前样放行（DR-053 范围化放行，领导单签口径）──

  /** 订单放行汇总 + 范围列表（含 pending 请求，供领导签署） */
  async listOrderReleases(orderId: string, endpoint?: string): Promise<ReleaseOrderSummary> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/releases/orders/${encodeURIComponent(orderId)}/releases`, base);
    const res = await fetch(url, { headers: apiService.getAuthHeaders() });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data?.error?.message || `listOrderReleases failed: HTTP ${res.status}`);
    return { total: data.total, ready: data.ready, blocked: data.blocked, summary: data.summary, scopes: data.scopes || [], pendingRequests: data.pendingRequests || [] };
  },

  async createReleaseScope(orderId: string, lineId: string, input: ReleaseScopeInput, endpoint?: string): Promise<ReleaseScope> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/releases/orders/${encodeURIComponent(orderId)}/lines/${encodeURIComponent(lineId)}/release-scopes`, base);
    const res = await fetch(url, { method: 'POST', headers: apiService.getAuthHeaders(), body: JSON.stringify(input) });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data?.error?.message || `createReleaseScope failed: HTTP ${res.status}`);
    return data.scope;
  },

  async createReleaseRequest(scopeId: string, input: { sampleId?: string } = {}, endpoint?: string): Promise<ReleaseRequest> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/releases/release-scopes/${encodeURIComponent(scopeId)}/requests`, base);
    const res = await fetch(url, { method: 'POST', headers: apiService.getAuthHeaders(), body: JSON.stringify(input) });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data?.error?.message || `createReleaseRequest failed: HTTP ${res.status}`);
    return data.request;
  },

  /** 领导签字（单签口径：business 角色一签即批准） */
  async signRelease(requestId: string, role: 'production' | 'business' = 'business', endpoint?: string): Promise<void> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/releases/release-requests/${encodeURIComponent(requestId)}/signatures`, base);
    const res = await fetch(url, { method: 'POST', headers: apiService.getAuthHeaders(), body: JSON.stringify({ role }) });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data?.error?.message || `signRelease failed: HTTP ${res.status}`);
  },

  /** 范围管理动作：pause / resume / revoke */
  async transitionReleaseScope(scopeId: string, action: 'pause' | 'resume' | 'revoke', reason?: string, endpoint?: string): Promise<void> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/releases/release-scopes/${encodeURIComponent(scopeId)}/${action}`, base);
    const res = await fetch(url, { method: 'POST', headers: apiService.getAuthHeaders(), body: JSON.stringify({ reason }) });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data?.error?.message || `transitionReleaseScope failed: HTTP ${res.status}`);
  },

  async saveChecklist(orderId: string, data: Partial<PreCutChecklist>, endpoint?: string): Promise<PreCutChecklist> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/production/${encodeURIComponent(orderId)}/checklist`, base);
    const res = await fetch(url, {
      method: 'PUT',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(data),
    });
    const json = await res.json();
    if (!res.ok || !json.ok) throw new Error(json?.error?.message || `saveChecklist failed: HTTP ${res.status}`);
    return json.checklist;
  },

  async saveInspection(orderId: string, data: Partial<InspectionReport>, endpoint?: string): Promise<InspectionReport> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/production/${encodeURIComponent(orderId)}/inspection`, base);
    const res = await fetch(url, {
      method: 'PUT',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(data),
    });
    const json = await res.json();
    if (!res.ok || !json.ok) throw new Error(json?.error?.message || `saveInspection failed: HTTP ${res.status}`);
    return json.inspection;
  },

  async signStage(orderId: string, stageKey: string, signType: 'production' | 'business', signerId?: string, endpoint?: string): Promise<PipelineStage> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/production/${encodeURIComponent(orderId)}/sign/${encodeURIComponent(stageKey)}`, base);
    const res = await fetch(url, {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify({ signType, signerId }),
    });
    const json = await res.json();
    if (!res.ok || !json.ok) throw new Error(json?.error?.message || `signStage failed: HTTP ${res.status}`);
    return json.stage;
  },

  /** DR-053 阶段 2/4：订单放行汇总（ready/partial/blocked + scope 清单），消费 /api/v1/releases/orders/:id/releases */
  async getOrderReleases(orderId: string, endpoint?: string): Promise<{ total: number; ready: number; blocked: number; summary: 'ready' | 'partial' | 'blocked'; scopes: any[] }> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/releases/orders/${encodeURIComponent(orderId)}/releases`, base);
    const res = await fetch(url, { headers: apiService.getAuthHeaders() });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `getOrderReleases failed: HTTP ${res.status}`);
    }
    const json = await res.json();
    return json;
  },
};

// ── §10.7 P-3：放行域类型（DR-053） ──
export type ReleaseScopeState = 'no_release' | 'ready' | 'paused' | 'revoked' | 'invalidated';

export interface ReleaseScope {
  id: string;
  orderId: string;
  orderLineId: string;
  productionBatchId?: string | null;
  factoryRelationId?: string | null;
  quantity: number;
  unit?: string | null;
  state: ReleaseScopeState;
  scopeRevision: number;
  currentReleaseId?: string | null;
  confirmedSourceType?: string | null;
  confirmedSourceId?: string | null;
}

export interface ReleaseRequest {
  id: string;
  scopeId: string;
  state: 'pending' | 'granted' | 'rejected';
  createdBy: string;
}

export interface ReleaseOrderSummary {
  total: number;
  ready: number;
  blocked: number;
  summary: 'ready' | 'partial' | 'blocked';
  scopes: ReleaseScope[];
  pendingRequests: ReleaseRequest[];
}

export interface ReleaseScopeInput {
  factoryRelationId?: string;
  productionBatchId?: string;
  quantity: number;
  unit?: string;
  confirmedSourceType?: string;
  confirmedSourceId?: string;
  specSnapshot?: unknown;
}
