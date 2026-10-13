/**
 * Development Management API service.
 * Communicates with /api/v1/development endpoints.
 */
import { registerDevelopmentCostCommand } from './developmentCostRegistrationContract';
import { fabricSearchRequest } from './fabricSearchService';
import { apiService } from './apiService';
import { getAuthState, subscribe } from './authService';
import { EMAIL_CONTEXT_EVENT } from './emailClientContext';
import type { SampleCardType } from './sampleRoomService';
import type {
  DevelopmentCase,
  DevelopmentCaseCreateInput,
  DevelopmentCaseUpdateInput,
  DevelopmentType,
  DevelopmentStage,
  DevelopmentPriority,
  DevelopmentSupplier,
  SampleBatch,
  SampleBatchType,
  SampleBatchCustomerStatus,
  SealSample,
} from '../types';

export type DevelopmentShippingCostSourceInput = { kind: 'fabric-send-event' | 'legacy-send-audit' | 'garment-send-event'; id: string; round: number; fingerprint: string };
export type GarmentSourceLinkCommand = { sourceRoundId: string; targetSampleId: string; existingAssetId: string;
  expectedRoundUpdatedAt: string; expectedSampleUpdatedAt: string; expectedAssetUpdatedAt: string; requestKey: string };
export type GarmentSourceLinkCandidate = { sourceRoundId: string; sampleId: string; sampleCode: string; assetId: string; sku: string; assetName: string;
  expectedRoundUpdatedAt: string; expectedSampleUpdatedAt: string; expectedAssetUpdatedAt: string; provenance: 'recorded_exact' | 'current_link_recorded' };
export type GarmentSourceBinding = { schemaVersion: 1; sourceRoundId: string; sampleId: string; assetId: string; auditId: string;
  provenance: 'recorded_exact' | 'current_link_recorded'; historicalApprovalRestored: false;
  caseId: string; actorId: string; requestKey: string; command: GarmentSourceLinkCommand };
export type DevelopmentShippingCostSource = DevelopmentShippingCostSourceInput & { schemaVersion: 1; caseId: string; batchId: string; batchCode: string; supplierRelationId: string; nativeAuditId: string; sourceSnapshot: { before?: Record<string, unknown>; after?: Record<string, unknown>; historicalAmountCurrencyUnknown?: boolean }; costRecordIds: string[] };

export type DevelopmentQcRoutingTeam = { id: string; name: string; family: 'fabric' | 'garment'; configuredHeadId: string | null; headId: string | null; headName: string | null };
export type DevelopmentVersionQcReview = {
  id: string; sampleVersionId?: string | null; status: string; result?: string | null; opinion?: string | null;
  reviewSequence?: number | null; reportId?: string | null; reviewedAt?: string | number | null;
  routingTeamId?: string | null; responsibleHeadId?: string | null;
  acknowledgedAt?: string | number | null; versionIdentityStatus?: 'recorded_exact' | 'unknown'; requestKey?: string;
};
export type DevelopmentVersionConfirmationInput = {
  requestKey: string; confirmerType: 'customer' | 'internal'; confirmerName: string;
  confirmerUserId?: string; confirmerRelationId?: string; confirmerOrganization?: string;
  confirmedAt: string; result: 'approved' | 'rejected' | 'needs_adjustment'; basis: string;
  evidence?: string[]; sampleBatchId?: string;
};
export type DevelopmentVersionConfirmation = Omit<DevelopmentVersionConfirmationInput, 'confirmerUserId' | 'confirmerRelationId' | 'confirmerOrganization' | 'sampleBatchId'> & {
  id: string; developmentCaseId: string; sampleVersionId: string; recordedBy: string; recordedAt: string;
  confirmerUserId?: string | null; confirmerRelationId?: string | null; confirmerOrganization?: string | null; sampleBatchId?: string | null;
};
export type DevelopmentVersionDecisions = {
  factoryCode?: string | null; physicalSequence?: number | null; sourceVersionId?: string | null;
  versionIdentityStatus?: 'recorded_exact' | 'unknown';
  developmentQcReview?: DevelopmentVersionQcReview | null;
  latestFormalQcReview?: DevelopmentVersionQcReview | null;
  developmentQcHistory?: DevelopmentVersionQcReview[];
  legacyDevelopmentQcReviews?: DevelopmentVersionQcReview[];
  versionConfirmation?: DevelopmentVersionConfirmation | null;
  versionConfirmationHistory?: DevelopmentVersionConfirmation[];
};
export type DevelopmentVersionConversionReceipt = { schemaVersion: 1; requestKey: string; caseId: string; sampleVersionId: string;
  sourceSampleBatchId: string; sourceType: string; sourceId: string; productAssetId: string; auditId: string };
export function developmentVersionConversionReceiptMatches(receipt: DevelopmentVersionConversionReceipt | null | undefined,
  expected: { caseId: string; versionId: string; requestKey: string; sourceType: string; sourceId: string; assetId: string }): boolean {
  return receipt?.schemaVersion === 1 && !!receipt.auditId && !!receipt.sourceSampleBatchId && receipt.caseId === expected.caseId
    && receipt.sampleVersionId === expected.versionId && receipt.requestKey === expected.requestKey
    && receipt.sourceType === expected.sourceType && receipt.sourceId === expected.sourceId && receipt.productAssetId === expected.assetId;
}

/** Parent status, customer preference and legacy reports cannot qualify another version. */
export function developmentVersionQcPassed(versionId: string | null | undefined, decisions: DevelopmentVersionDecisions): boolean {
  const report = decisions.latestFormalQcReview;
  return !!versionId && !!report?.id && report.sampleVersionId === versionId
    && report.versionIdentityStatus !== 'unknown' && ['reviewed', 'acknowledged'].includes(report.status)
    && (report.result === 'pass' || report.result === 'conditional_pass' && typeof report.opinion === 'string' && !!report.opinion.trim());
}

function verifiedVersionConfirmation(value: unknown, caseId: string): value is DevelopmentVersionConfirmation {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return row.developmentCaseId === caseId
    && ['id', 'sampleVersionId', 'requestKey', 'confirmerName', 'recordedBy', 'basis'].every(key => typeof row[key] === 'string' && !!row[key].trim())
    && ['customer', 'internal'].includes(String(row.confirmerType))
    && ['approved', 'rejected', 'needs_adjustment'].includes(String(row.result))
    && [row.confirmedAt, row.recordedAt].every(time => typeof time === 'string' && /^\d{1,16}$/.test(time) && Number(time) > 0)
    && (row.evidence == null || (Array.isArray(row.evidence) && row.evidence.every(item => typeof item === 'string' && !!item.trim())));
}

export type DevelopmentConversionMoqSummary = { state: 'compliant' | 'below' | 'unverified'; belowLineCount: number; basis: 'fallback' | 'configured_or_specific' | 'unknown' };
/** Only a coherent server verdict is a completed advisory read. */
export function readDevelopmentConversionMoq(value: unknown): DevelopmentConversionMoqSummary {
  const unknown: DevelopmentConversionMoqSummary = {state:'unverified',belowLineCount:0,basis:'unknown'};
  if (!value || typeof value !== 'object') return unknown;
  const r=value as any, snap=r.snapshot;
  if(typeof r.ok!=='boolean'||typeof r.capsuleActive!=='boolean'||!Array.isArray(r.lines)||r.lines.length<1||r.lines.length>128||!Array.isArray(r.blockedLineIndexes)
    ||!snap||!['moq_config','fallback_constant'].includes(snap.source)||typeof snap.snapshotAt!=='string'||!Number.isFinite(Date.parse(snap.snapshotAt))
    ||![snap.fabricDefaultMoq,snap.garmentDefaultMoq,snap.capsuleMoq].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>0)
    ||!(snap.source==='moq_config'?typeof snap.configId==='string'&&snap.configId.trim().length>0:snap.configId===null))return unknown;
  const below:number[]=[];
  for(let index=0;index<r.lines.length;index++){
    const line=r.lines[index];
    if(!line||line.lineIndex!==index||typeof line.quantity!=='number'||!Number.isFinite(line.quantity)||line.quantity<=0
      ||typeof line.effectiveMoq!=='number'||!Number.isFinite(line.effectiveMoq)||line.effectiveMoq<=0||typeof line.unit!=='string'||!line.unit.trim()
      ||typeof line.compliant!=='boolean'||line.compliant!==(line.quantity>=line.effectiveMoq)
      ||!['capsule_exemption','line_override','product_profile','factory_contract','customer_agreement','customer_tier','moq_config','fallback_constant'].includes(line.source))return unknown;
    if(!line.compliant)below.push(index);
  }
  if(r.ok!==(below.length===0)||r.blockedLineIndexes.length!==below.length||r.blockedLineIndexes.some((n:any,index:number)=>n!==below[index]))return unknown;
  return{state:below.length?'below':'compliant',belowLineCount:below.length,basis:r.lines.some((line:any)=>line.source==='fallback_constant')?'fallback':'configured_or_specific'};
}
export function developmentConversionNotice(summary: DevelopmentConversionMoqSummary, orderLabel: string): {kind:'success'|'warning';message:string} {
  if(summary.state==='below')return{kind:'warning',message:`订单 ${orderLabel} 已建为待确认状态，${summary.belowLineCount} 项数量低于${summary.basis==='fallback'?'系统默认 MOQ':' MOQ'}；需满足 MOQ 或取得有效豁免后，再确认订单及推进生产。`};
  if(summary.state==='unverified')return{kind:'warning',message:`订单 ${orderLabel} 已建立，但 MOQ 核验未完成；请核对起订量及有效豁免，再确认订单及推进生产。`};
  if(summary.basis==='fallback')return{kind:'warning',message:`订单 ${orderLabel} 已建立，已按系统默认起订量核验；请核对 MOQ 配置后再确认订单。`};
  return{kind:'success',message:`已转为订单 ${orderLabel}。`};
}

type DevelopmentListParams = {
  type?: DevelopmentType;
  stage?: DevelopmentStage;
  customer?: string;
  supplier?: string;
  owner?: string;
  search?: string;
  /** 发票详情反查：引用该样品发票的开发单（DR-057 v2.1 双向闭环） */
  sampleInvoiceId?: string;
  /** 产品档案详情反查：关联该档案的开发单（DR-057 v2.1） */
  productAssetId?: string;
  limit?: number;
  offset?: number;
};

// 后端错误合约统一为 { error: { code, message } }；直接把 err.error 塞给 new Error
// 会渲染成 "[object Object]"（2026-09-04 Kevin 验收实锤）。此处统一取人话 message。
function extractApiError(err: any, fallback: string, status?: number): Error {
  const msg = err?.error?.message || (typeof err?.error === 'string' ? err.error : null) || err?.message || fallback;
  return Object.assign(new Error(msg), { ...(status !== undefined ? { status } : {}), code: err?.error?.code, ...(typeof err?.error?.approvalRequestId==='string'&&err.error.approvalRequestId.trim()?{approvalRequestId:err.error.approvalRequestId}:{}) });
}

function verifiedDevelopmentCase(value: any, expectedId?: string): DevelopmentCase {
  const association = value?.orderAssociation;
  if (!value || typeof value.id !== 'string' || (expectedId !== undefined && value.id !== expectedId)
    || association?.caseId !== value.id || !['ready', 'restricted'].includes(association?.state) || !Array.isArray(association?.items)
    || (association.state === 'restricted' && association.items.length !== 0)) throw new Error('开发案关联订单未能完整核验，请重新读取。');
  const ids = new Set<string>();
  for (const item of association.items) {
    if (!item || typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id)
      || !(item.poNumber === null || typeof item.poNumber === 'string') || typeof item.status !== 'string' || !item.status.trim()
      || !['case-source', 'legacy-link'].includes(item.source)) throw new Error('开发案关联订单响应不完整，请重新读取。');
    ids.add(item.id);
  }
  return value;
}

export const developmentService = {
  /**
   * List development cases with optional filters.
   */
  async listDevelopmentCases(endpoint?: string, params?: DevelopmentListParams): Promise<DevelopmentCase[]> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/development', base);
    const query = new URLSearchParams();
    if (params?.type) query.set('type', params.type);
    if (params?.stage) query.set('stage', params.stage);
    if (params?.customer) query.set('customer', params.customer);
    if (params?.supplier) query.set('supplier', params.supplier);
    if (params?.owner) query.set('owner', params.owner);
    if (params?.search) query.set('search', params.search);
    if (params?.sampleInvoiceId) query.set('sampleInvoiceId', params.sampleInvoiceId);
    if (params?.productAssetId) query.set('productAssetId', params.productAssetId);
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));

    const fullUrl = query.toString() ? `${url}?${query.toString()}` : url;
    const res = await fetch(fullUrl, {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) throw new Error(`listDevelopmentCases failed: HTTP ${res.status}`);
    const data = await res.json();
    if (data?.ok !== true || !Array.isArray(data.cases)) throw new Error('开发案列表未能完整读取，请重新核对');
    return data.cases.map((value: any) => verifiedDevelopmentCase(value));
  },

  /**
   * Get a single development case by ID.
   */
  async getDevelopmentCase(id: string, endpoint?: string): Promise<DevelopmentCase> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/development/${encodeURIComponent(id)}`, base);
    const res = await fetch(url, {
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) throw new Error(`getDevelopmentCase failed: HTTP ${res.status}`);
    const data = await res.json();
    if (data?.ok !== true) throw new Error('开发案未能完整读取，请重新核对。');
    return verifiedDevelopmentCase(data.case, id);
  },

  /**
   * Create a new development case.
   */
  async createDevelopmentCase(input: DevelopmentCaseCreateInput, endpoint?: string): Promise<DevelopmentCase> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/development', base);
    const res = await fetch(url, {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw extractApiError(err, `createDevelopmentCase failed: HTTP ${res.status}`);
    }
    const data = await res.json();
    return data.case;
  },

  /**
   * Update a development case.
   */
  async updateDevelopmentCase(id: string, input: DevelopmentCaseUpdateInput, endpoint?: string): Promise<DevelopmentCase> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/development/${encodeURIComponent(id)}`, base);
    const res = await fetch(url, {
      method: 'PUT',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw extractApiError(err, `updateDevelopmentCase failed: HTTP ${res.status}`);
    }
    const data = await res.json();
    return data.case;
  },

  /**
   * Update stage with validation.
   */
  async updateStage(id: string, stage: DevelopmentStage, nextAction?: string, endpoint?: string): Promise<DevelopmentCase> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/development/${encodeURIComponent(id)}/stage`, base);
    const res = await fetch(url, {
      method: 'PATCH',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify({ stage, nextAction }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw extractApiError(err, `updateStage failed: HTTP ${res.status}`);
    }
    const data = await res.json();
    return data.case;
  },

  /**
   * DR-053 阶段 1：开发案确认成果列表（封样/样品 → 档案 → 工厂），供转单/直接返单选择版本。
   */
  async getCaseOutputs(id: string, endpoint?: string): Promise<Array<{
    confirmedSourceType: 'SealSample' | 'Sample';
    confirmedSourceId: string;
    code: string;
    name: string | null;
    status: string;
    supplierRelationId: string | null;
    supplierName: string | null;
    productAsset: { id: string; sku: string | null; name: string | null } | null;
  }>> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/development/${encodeURIComponent(id)}/outputs`, base);
    const res = await fetch(url, { headers: apiService.getAuthHeaders() });
    if (!res.ok) throw new Error(`getCaseOutputs failed: HTTP ${res.status}`);
    const data = await res.json();
    if (data?.ok !== true || !Array.isArray(data.outputs)) throw new Error('确认成果未能完整读取，请重新核对');
    return data.outputs;
  },

  /**
   * Convert development case to order.
   *
   * Two modes:
   *   - Pass `{ orderId, orderPo }` to link this dev case to an existing order.
   *   - Pass `{ autoCreate: true, ... }` (or omit orderId/orderPo) to ask the
   *     server to auto-create a new Order seeded from the dev case (customer,
   *     supplier, product all carried over via cross-module entity links).
   * Returns both the updated dev case and the new/linked order.
   */
  async convertToOrder(
    id: string,
    body: {
      orderId?: string;
      orderPo?: string;
      autoCreate?: boolean;
      customer?: string;
      millName?: string;
      millRelationId?: string; // DR-053 阶段 1：工厂传 ID（修"显示 B 厂实际关联 A 厂"）
      confirmedSourceType?: string; // DR-053 阶段 1：确认成果类型 SealSample | Sample | Asset
      confirmedSourceId?: string; // DR-053 阶段 1：确认成果 ID（版本载体=确认记录本身）
      clientRequestId?: string; // DR-053 阶段 1：幂等键（每次真实操作生成，重试复用）
      dueDate?: string;
      productName?: string;
      quantity?: number;
      quoteAmount?: number;
    } | { orderId: string; orderPo: string },
    endpoint?: string,
  ): Promise<{ case: DevelopmentCase; order: any | null; moqCheck: DevelopmentConversionMoqSummary }> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/development/${encodeURIComponent(id)}/convert`, base);
    const res = await fetch(url, {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw extractApiError(err, `convertToOrder failed: HTTP ${res.status}`);
    }
    const data = await res.json();
    return { case: data.case, order: data.order ?? null, moqCheck: readDevelopmentConversionMoq(data.moqCheck) };
  },

  /**
   * Soft delete a development case.
   */
  async deleteDevelopmentCase(id: string, endpoint?: string): Promise<void> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl(`/v1/development/${encodeURIComponent(id)}`, base);
    const res = await fetch(url, {
      method: 'DELETE',
      headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) throw new Error(`deleteDevelopmentCase failed: HTTP ${res.status}`);
  },

  // ── 面料链（DR-050）：开发供应商 / 样品批次 / 封样 / 转档 ──

  async listDevelopmentSuppliers(caseId: string, endpoint?: string): Promise<DevelopmentSupplier[]> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const res = await fetch(apiService.buildApiUrl(`/v1/development/${encodeURIComponent(caseId)}/suppliers`, base), { headers: apiService.getAuthHeaders() });
    if (!res.ok) throw new Error(`listDevelopmentSuppliers failed: HTTP ${res.status}`);
    const data = await res.json();
    return data.suppliers || [];
  },
  async addDevelopmentSupplier(caseId: string, input: { supplierRelationId: string; supplierName?: string }, endpoint?: string): Promise<DevelopmentSupplier> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const res = await fetch(apiService.buildApiUrl(`/v1/development/${encodeURIComponent(caseId)}/suppliers`, base), {
      method: 'POST', headers: apiService.getAuthHeaders(), body: JSON.stringify(input),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw extractApiError(err, `addDevelopmentSupplier failed: HTTP ${res.status}`); }
    return (await res.json()).supplier;
  },
  async updateDevelopmentSupplier(supplierId: string, input: { quoteNote?: string; leadTime?: string; trialConclusion?: string; notes?: string }, endpoint?: string): Promise<DevelopmentSupplier> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const res = await fetch(apiService.buildApiUrl(`/v1/development/suppliers/${encodeURIComponent(supplierId)}`, base), {
      method: 'PATCH', headers: apiService.getAuthHeaders(), body: JSON.stringify(input),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw extractApiError(err, `updateDevelopmentSupplier failed: HTTP ${res.status}`); }
    return (await res.json()).supplier;
  },
  async removeDevelopmentSupplier(supplierId: string, endpoint?: string): Promise<void> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const res = await fetch(apiService.buildApiUrl(`/v1/development/suppliers/${encodeURIComponent(supplierId)}`, base), {
      method: 'DELETE', headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) throw new Error(`removeDevelopmentSupplier failed: HTTP ${res.status}`);
  },

  async listSampleBatches(caseId: string, endpoint?: string): Promise<SampleBatch[]> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const res = await fetch(apiService.buildApiUrl(`/v1/development/${encodeURIComponent(caseId)}/batches`, base), { headers: apiService.getAuthHeaders() });
    if (!res.ok) throw new Error(`listSampleBatches failed: HTTP ${res.status}`);
    const data = await res.json();
    return data.batches || [];
  },
  async createSampleBatch(caseId: string, input: { sampleType: SampleBatchType; supplierRelationId: string; supplierName?: string; specNote?: string; dyeLotNo?: string; colorRating?: number; sideDiff?: number; endDiff?: number; defectCauses?: string[]; photos?: any; notes?: string; roundNotes?: string; factoryRequirements?: string; targetCompletionDate?: string; referenceAttachments?: string[]; planQuantity?: number; planUnit?: string; round?: number }, endpoint?: string): Promise<SampleBatch> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const res = await fetch(apiService.buildApiUrl(`/v1/development/${encodeURIComponent(caseId)}/batches`, base), {
      method: 'POST', headers: apiService.getAuthHeaders(), body: JSON.stringify(input),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw extractApiError(err, `createSampleBatch failed: HTTP ${res.status}`); }
    return (await res.json()).batch;
  },
  async createSampleBatches(caseId: string, input: { sampleTypes: SampleBatchType[]; supplierRelationId: string; supplierName?: string; sourceVersionId?: string; specNote?: string; roundNotes?: string; factoryRequirements?: string; targetCompletionDate?: string; referenceAttachments?: string[]; planQuantity?: number; planUnit?: string; samplePlans?: Array<{ sampleType: SampleBatchType; quantity: number; unit: string }>; round?: number }, endpoint?: string): Promise<SampleBatch[]> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const res = await fetch(apiService.buildApiUrl(`/v1/development/${encodeURIComponent(caseId)}/batches`, base), {
      method: 'POST', headers: apiService.getAuthHeaders(), body: JSON.stringify(input),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw extractApiError(err, `createSampleBatches failed: HTTP ${res.status}`); }
    const body = await res.json();
    if (!Array.isArray(body.batches) || body.batches.length !== input.sampleTypes.length) throw new Error('打样安排结果不完整，请核对本轮原请求后重试');
    return body.batches;
  },
  async updateSampleVersionTask(versionId: string, input: { factoryRequirements?: string; targetCompletionDate?: string | null; referenceAttachments?: string[]; samplePlans?: Array<{ batchId: string; quantity: number; unit: string }>; expectedUpdatedAt: string }, endpoint?: string) {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const res = await fetch(apiService.buildApiUrl(`/v1/development/sample-versions/${encodeURIComponent(versionId)}/task`, base), {
      method: 'PATCH', headers: apiService.getAuthHeaders(), body: JSON.stringify(input),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw extractApiError(err, 'updateSampleVersionTask failed', res.status); }
    const body = await res.json();
    if (!body?.item || body.item.id !== versionId) throw new Error('工厂任务保存结果不完整，请刷新核对');
    return body.item;
  },
  async updateSampleRoundRequirements(roundId: string, input: { notes: string; expectedUpdatedAt: string }, endpoint?: string) {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const res = await fetch(apiService.buildApiUrl(`/v1/development/sample-rounds/${encodeURIComponent(roundId)}/requirements`, base), {
      method: 'PATCH', headers: apiService.getAuthHeaders(), body: JSON.stringify(input),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw extractApiError(err, 'updateSampleRoundRequirements failed', res.status); }
    const body = await res.json();
    if (!body?.item || body.item.id !== roundId) throw new Error('轮次要求保存结果不完整，请刷新核对');
    return body.item;
  },
  async recordSampleBatchReturnResults(caseId: string, batchId: string, input: {
    requestKey: string;
    expectedBatchUpdatedAt: string;
    dyeLotNo?: string | null;
    colorRating?: number | null;
    sideDiff?: number | null;
    endDiff?: number | null;
    defectCauses?: string[];
    photos?: string[];
    notes?: string | null;
    actualQuantity?: string | null;
    actualUnit?: string | null;
  }, endpoint?: string): Promise<SampleBatch> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const res = await fetch(apiService.buildApiUrl(`/v1/development/${encodeURIComponent(caseId)}/batches/${encodeURIComponent(batchId)}/return-results`, base), {
      method: 'POST', headers: apiService.getAuthHeaders(), body: JSON.stringify(input),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw extractApiError(err, `recordSampleBatchReturnResults failed: HTTP ${res.status}`, res.status); }
    const body = await res.json();
    if (!body?.batch || body.batch.id !== batchId || body.batch.developmentCaseId !== caseId || body.batch.resultsRecorded !== true) throw new Error('返样成果响应不完整，请刷新核对原批次');
    return body.batch;
  },
  async listDevelopmentQcRoutingTeams(caseId: string): Promise<DevelopmentQcRoutingTeam[]> {
    const data = await fabricSearchRequest<{qcRoutingTeams: DevelopmentQcRoutingTeam[]}>(`personnel?caseId=${encodeURIComponent(caseId)}`);
    if (!Array.isArray(data?.qcRoutingTeams) || data.qcRoutingTeams.some(team => !team?.id || !team.name || !['fabric','garment'].includes(team.family) || (team.headId !== null && typeof team.headId !== 'string'))) throw new Error('QC 团队目录不完整，请重新读取');
    return data.qcRoutingTeams;
  },
  async initiateDevelopmentBatchQcReview(caseId: string, batchId: string, input: { requestKey: string; sampleVersionId?: string; routingTeamId?: string }, endpoint?: string): Promise<DevelopmentVersionQcReview> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const res = await fetch(apiService.buildApiUrl(`/v1/development/${encodeURIComponent(caseId)}/batches/${encodeURIComponent(batchId)}/qc-review`, base), {
      method: 'POST', headers: apiService.getAuthHeaders(), body: JSON.stringify(input),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw extractApiError(err, `initiateDevelopmentBatchQcReview failed: HTTP ${res.status}`, res.status); }
    const body = await res.json();
    const item = body?.item;
    if (body?.ok !== true || !item?.id || item.requestKey !== input.requestKey || (input.sampleVersionId && item.sampleVersionId !== input.sampleVersionId) || (input.routingTeamId && item.routingTeamId !== input.routingTeamId)) throw new Error('QC 评审准确版本回执不完整，请用原请求核对');
    return item;
  },
  async recordDevelopmentVersionConfirmation(caseId: string, versionId: string, input: DevelopmentVersionConfirmationInput, endpoint?: string): Promise<DevelopmentVersionConfirmation> {
    const actorId = getAuthState().user?.id;
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const res = await fetch(apiService.buildApiUrl(`/v1/development/${encodeURIComponent(caseId)}/sample-versions/${encodeURIComponent(versionId)}/confirmations`, base), {
      method: 'POST', headers: apiService.getAuthHeaders(), body: JSON.stringify(input),
    });
    if (!res.ok) throw extractApiError(await res.json().catch(() => ({})), '需求方确认登记失败，请核对原请求', res.status);
    const body = await res.json();
    const item = body?.item;
    const fields = ['confirmerType', 'confirmerName', 'confirmerUserId', 'confirmerRelationId', 'confirmerOrganization', 'confirmedAt', 'result', 'basis'] as const;
    if (body?.ok !== true || !verifiedVersionConfirmation(item, caseId) || item.sampleVersionId !== versionId
      || item.requestKey !== input.requestKey || item.recordedBy !== actorId
      || fields.some(key => (item[key] ?? null) !== (input[key] ?? null))
      || JSON.stringify(item.evidence ?? []) !== JSON.stringify(input.evidence ?? [])) throw new Error('需求方确认回执与原请求不一致，请用原请求核对');
    return item;
  },
  async listDevelopmentVersionConfirmations(caseId: string, versionIds?: string[], endpoint?: string): Promise<DevelopmentVersionConfirmation[]> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const query = versionIds?.length ? `?${new URLSearchParams({ versionIds: versionIds.join(',') })}` : '';
    const res = await fetch(apiService.buildApiUrl(`/v1/development/${encodeURIComponent(caseId)}/version-confirmations${query}`, base), { headers: apiService.getAuthHeaders() });
    if (!res.ok) throw extractApiError(await res.json().catch(() => ({})), '需求方确认记录读取失败', res.status);
    const body = await res.json();
    if (body?.ok !== true || !Array.isArray(body.items) || body.items.some((item: unknown) => !verifiedVersionConfirmation(item, caseId) || (versionIds?.length && !versionIds.includes(item.sampleVersionId)))) throw new Error('需求方确认记录不完整，请重新读取');
    return body.items;
  },
  async createDevelopmentSampleMinorVersion(caseId: string, parentVersionId: string, input: { requestKey: string; note: string }, endpoint?: string): Promise<{ id: string; versionLabel: string; versionKind: 'minor'; parentVersionId: string; minorChangeNote: string }> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const res = await fetch(apiService.buildApiUrl(`/v1/development/${encodeURIComponent(caseId)}/sample-versions/${encodeURIComponent(parentVersionId)}/minors`, base), {
      method: 'POST', headers: apiService.getAuthHeaders(), body: JSON.stringify(input),
    });
    if (!res.ok) throw extractApiError(await res.json().catch(() => ({})), '创建文字小版失败，请核对原请求', res.status);
    const body = await res.json(), item = body?.item;
    if (body?.ok !== true || !item?.id || !item.versionLabel || item.versionKind !== 'minor' || item.parentVersionId !== parentVersionId
      || item.minorChangeNote !== input.note) throw new Error('文字小版回执不完整，请用原请求核对');
    return item;
  },
  async acknowledgeDevelopmentBatchQcReview(caseId: string, reviewId: string, input: { requestKey: string }, endpoint?: string): Promise<DevelopmentVersionQcReview> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const res = await fetch(apiService.buildApiUrl(`/v1/development/${encodeURIComponent(caseId)}/qc-reviews/${encodeURIComponent(reviewId)}/acknowledge`, base), {
      method: 'POST', headers: apiService.getAuthHeaders(), body: JSON.stringify(input),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw extractApiError(err, `acknowledgeDevelopmentBatchQcReview failed: HTTP ${res.status}`, res.status); }
    const body = await res.json();
    if (body?.ok !== true || body.item?.id !== reviewId || body.item?.status !== 'acknowledged') throw new Error('QC 已阅回执不完整，请刷新核对原评审');
    return body.item;
  },
  async updateSampleBatch(batchId: string, input: { specNote?: string; dyeLotNo?: string; colorRating?: number | null; sideDiff?: number | null; endDiff?: number | null; defectCauses?: string[]; photos?: any; notes?: string; planQuantity?: number | null; planUnit?: string; actualQuantity?: number | null; actualUnit?: string }, endpoint?: string): Promise<SampleBatch> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const res = await fetch(apiService.buildApiUrl(`/v1/development/batches/${encodeURIComponent(batchId)}`, base), {
      method: 'PATCH', headers: apiService.getAuthHeaders(), body: JSON.stringify(input),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw extractApiError(err, `updateSampleBatch failed: HTTP ${res.status}`); }
    return (await res.json()).batch;
  },
  async deleteSampleBatch(batchId: string, endpoint?: string): Promise<void> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const res = await fetch(apiService.buildApiUrl(`/v1/development/batches/${encodeURIComponent(batchId)}`, base), {
      method: 'DELETE', headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw extractApiError(err, `deleteSampleBatch failed: HTTP ${res.status}`); }
  },
  async advanceSampleBatchStage(batchId: string, action: 'start' | 'send' | 'approve' | 'revise', input: { requestKey?: string; expectedRevision?: number; expectedRound?: number; sentDate?: string; courier?: string; trackingNumber?: string; shippingFee?: number; feedback?: string; feedbackDate?: string; notes?: string; physicalShipment?: { itemId: string; quantity: number; recipientName: string; relationId?: string } }, endpoint?: string): Promise<SampleBatch> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const res = await fetch(apiService.buildApiUrl(`/v1/development/batches/${encodeURIComponent(batchId)}/stage`, base), {
      method: 'PATCH', headers: apiService.getAuthHeaders(), body: JSON.stringify({ action, ...input }),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw extractApiError(err, `advanceSampleBatchStage failed: HTTP ${res.status}`, res.status); }
    return (await res.json()).batch;
  },
  async submitBatchCustomerFeedback(batchId: string, input: { requestKey?: string; expectedRevision?: number; expectedRound?: number; status: SampleBatchCustomerStatus; note?: string; feedbackDate?: string; asSealed?: boolean }, endpoint?: string): Promise<SampleBatch> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const res = await fetch(apiService.buildApiUrl(`/v1/development/batches/${encodeURIComponent(batchId)}/customer-feedback`, base), {
      method: 'POST', headers: apiService.getAuthHeaders(), body: JSON.stringify(input),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw extractApiError(err, `submitBatchCustomerFeedback failed: HTTP ${res.status}`, res.status); }
    return (await res.json()).batch;
  },

  // DR-054 阶段 B：批次级确认（确认锚点=批次；防重复确认）+ 收到实际结果登记样品间实物
  async confirmSampleBatch(batchId: string, endpoint?: string, input: { requestKey?: string; expectedRevision?: number; expectedRound?: number } = {}): Promise<{ batch: SampleBatch; sampleCount: number }> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const res = await fetch(apiService.buildApiUrl(`/v1/development/batches/${encodeURIComponent(batchId)}/confirm`, base), {
      method: 'POST', headers: apiService.getAuthHeaders(), body: JSON.stringify(input),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw extractApiError(err, `confirmSampleBatch failed: HTTP ${res.status}`, res.status); }
    return (await res.json());
  },
  async registerReceivedBatchCards(batchId: string, input: {
    receiptVersion: 2; cardType: SampleCardType; expectedSourceRound: number; expectedCaseId: string; expectedFactoryId: string;
    physicalCardCount: number; expectedBatchUpdatedAt: string; warehouseId?: string; location?: string; locationDetail?: { zone: string | null; shelf: string | null; level: string | null; bin: string | null };
    actualQuantity?: string | null; actualUnit?: string | null;
  }, endpoint?: string, isCurrent: () => boolean = () => true): Promise<{ item: any; batch: SampleBatch; created: boolean; receiptStatus: 'verified' }> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const identity = () => {
      const auth = getAuthState();
      return JSON.stringify([apiService.getStoredConfig().cloudEndpoint, apiService.getAuthHeaders(), auth.isAuthenticated, auth.isLoading,
        auth.user?.id, auth.user?.permissions, auth.user?.permissionCeiling, auth.user?.roles, auth.user?.roleIds]);
    };
    const originalIdentity = identity();
    const headers = apiService.getAuthHeaders();
    // Keep invalidation permanent while pending, including account/endpoint
    // A -> B -> A. The existing auth/config notifications observe each change.
    let stale = false;
    let posted = false;
    const observe = () => {
      try { if (!isCurrent() || identity() !== originalIdentity) stale = true; }
      catch { stale = true; }
    };
    const stop = subscribe(observe);
    const events = ['storage', 'focus', EMAIL_CONTEXT_EVENT];
    if (typeof window !== 'undefined') events.forEach(event => window.addEventListener(event, observe));
    const check = () => {
      observe();
      if (stale) throw new Error(posted
        ? '账号、权限、后台或来源页面已变化，请在原账号核对本次收样结果，勿重复登记'
        : '账号、权限、后台或来源页面已变化，本次收样尚未提交，请重新打开原批次');
    };
    try {
      check();
      const capability = await fetch(apiService.buildApiUrl('/v1/development/sample-room/receipt-contract', base), { headers });
      check();
      if (!capability.ok) {
        const err = await capability.json().catch(() => ({}));
        check();
        throw extractApiError(err, capability.status === 404 ? '当前后台尚未支持准确轮次收样，请更新测试环境；本次尚未提交' : '准确收样能力未能确认，本次尚未提交', capability.status);
      }
      const contract = await capability.json();
      check();
      if (contract?.ok !== true || contract.receiptVersion !== 2 || contract.custodyMode !== 'independent-exact-receipt' || contract.autoSampleProjection !== false) {
        throw new Error('当前后台尚未支持准确轮次收样，请更新测试环境；本次尚未提交');
      }
      check();
      posted = true;
      const res = await fetch(apiService.buildApiUrl(`/v1/development/batches/${encodeURIComponent(batchId)}/register-received`, base), {
        method: 'POST', headers, body: JSON.stringify(input),
      });
      check();
      if (!res.ok) { const err = await res.json().catch(() => ({})); check(); throw extractApiError(err, `registerReceivedBatchCards failed: HTTP ${res.status}`); }
      const result = await res.json();
      const receipt = result?.item?.receiptSnapshot;
      check();
      if (result.receiptStatus !== 'verified' || receipt?.version !== 2 || receipt.batchId !== batchId
        || receipt.sourceRound !== input.expectedSourceRound || receipt.factoryId !== input.expectedFactoryId || receipt.developmentCaseId !== input.expectedCaseId
        || receipt.cardType !== input.cardType || receipt.initialPhysicalCardCount !== input.physicalCardCount || receipt.physicalUnit !== 'PC') {
        throw new Error('后台未返回准确收样证明，请核对原登记，勿重复提交');
      }
      return result;
    } finally {
      stop();
      if (typeof window !== 'undefined') events.forEach(event => window.removeEventListener(event, observe));
    }
  },

  async listSealSamples(caseId: string, endpoint?: string): Promise<SealSample[]> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const res = await fetch(apiService.buildApiUrl(`/v1/development/${encodeURIComponent(caseId)}/seals`, base), { headers: apiService.getAuthHeaders() });
    if (!res.ok) throw new Error(`listSealSamples failed: HTTP ${res.status}`);
    const data = await res.json();
    return data.seals || [];
  },
  async createSealSample(caseId: string, input: { batchIds: string[]; name?: string; standardNo?: string; retainLocation?: string; qualityNote?: string; customerRelationId?: string; customerName?: string; notes?: string }, endpoint?: string): Promise<SealSample> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const res = await fetch(apiService.buildApiUrl(`/v1/development/${encodeURIComponent(caseId)}/seals`, base), {
      method: 'POST', headers: apiService.getAuthHeaders(), body: JSON.stringify(input),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw extractApiError(err, `createSealSample failed: HTTP ${res.status}`); }
    return (await res.json()).seal;
  },
  async updateSealSample(sealId: string, input: { batchIds?: string[]; name?: string; standardNo?: string; retainLocation?: string; qualityNote?: string; customerRelationId?: string; customerName?: string; notes?: string }, endpoint?: string): Promise<SealSample> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const res = await fetch(apiService.buildApiUrl(`/v1/development/seals/${encodeURIComponent(sealId)}`, base), {
      method: 'PATCH', headers: apiService.getAuthHeaders(), body: JSON.stringify(input),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw extractApiError(err, `updateSealSample failed: HTTP ${res.status}`); }
    return (await res.json()).seal;
  },
  async deleteSealSample(sealId: string, endpoint?: string): Promise<void> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const res = await fetch(apiService.buildApiUrl(`/v1/development/seals/${encodeURIComponent(sealId)}`, base), {
      method: 'DELETE', headers: apiService.getAuthHeaders(),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw extractApiError(err, `deleteSealSample failed: HTTP ${res.status}`); }
  },
  async sealSample(sealId: string, endpoint?: string): Promise<SealSample> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const res = await fetch(apiService.buildApiUrl(`/v1/development/seals/${encodeURIComponent(sealId)}/status`, base), {
      method: 'PATCH', headers: apiService.getAuthHeaders(), body: JSON.stringify({ status: 'sealed' }),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw extractApiError(err, `sealSample failed: HTTP ${res.status}`); }
    return (await res.json()).seal;
  },
  /**
   * 强制转档（DR-050 面料：batch/seal → FabricProfile；DR-051 成衣：node 确认样节点 / seal 封存轮次 → GarmentProfile）。
   * 后端按开发案类型分派，同一端点两种语义。
   */
  async convertToAsset(caseId: string, sourceType: 'batch' | 'seal' | 'node', sourceId: string, endpoint?: string, input: { requestKey?: string; expectedRevision?: number; expectedRound?: number; sourceRoundId?: string; sourceVersionId?: string; targetSampleId?: string } = {}): Promise<{ asset: any; case: DevelopmentCase; batch?: SampleBatch; conversionReceipt?: DevelopmentVersionConversionReceipt }> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const res = await fetch(apiService.buildApiUrl(`/v1/development/${encodeURIComponent(caseId)}/convert-to-asset`, base), {
      method: 'POST', headers: apiService.getAuthHeaders(), body: JSON.stringify({ ...input, sourceType, sourceId }),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw extractApiError(err, `convertToAsset failed: HTTP ${res.status}`, res.status); }
    const data = await res.json();
    if (input.sourceVersionId && (data.asset?.sourceSampleVersionId !== input.sourceVersionId
      || input.sourceRoundId && data.asset?.sourceSampleBatchId !== input.sourceRoundId)) throw new Error('转档回执缺少本次准确版本来源，请用原请求核对');
    if (input.sourceVersionId && (!input.requestKey || !developmentVersionConversionReceiptMatches(data.conversionReceipt, { caseId, versionId: input.sourceVersionId,
      requestKey: input.requestKey, sourceType, sourceId, assetId: data.asset?.id }))) throw new Error('转档原请求回执未完整核验，请用原请求核对');
    return { asset: data.asset, case: data.case, ...(data.batch ? { batch: data.batch } : {}), ...(data.conversionReceipt ? { conversionReceipt: data.conversionReceipt } : {}) };
  },
  async listGarmentSourceLinks(caseId: string): Promise<{ items: GarmentSourceLinkCandidate[]; blockedReason: string | null }> {
    const base = apiService.getStoredConfig().cloudEndpoint;
    const res = await fetch(apiService.buildApiUrl(`/v1/development/${encodeURIComponent(caseId)}/garment-source-links`, base), { headers: apiService.getAuthHeaders() });
    if (!res.ok) throw extractApiError(await res.json().catch(() => ({})), '成衣来源未能完整读取，请重新核对', res.status);
    const body = await res.json();
    if (body?.ok !== true || !Array.isArray(body.items) || body.items.some((row: any) =>
      ['sourceRoundId','sampleId','sampleCode','assetId','sku','expectedRoundUpdatedAt','expectedSampleUpdatedAt','expectedAssetUpdatedAt'].some(key => typeof row?.[key] !== 'string' || !row[key])
      || !['recorded_exact','current_link_recorded'].includes(row.provenance))) throw new Error('成衣来源结果不完整，请重新核对');
    return { items: body.items, blockedReason: typeof body.blockedReason === 'string' ? body.blockedReason : null };
  },
  async linkGarmentSource(caseId: string, input: GarmentSourceLinkCommand): Promise<GarmentSourceBinding> {
    const base = apiService.getStoredConfig().cloudEndpoint;
    const res = await fetch(apiService.buildApiUrl(`/v1/development/${encodeURIComponent(caseId)}/garment-source-links`, base), {
      method: 'POST', headers: apiService.getAuthHeaders(), body: JSON.stringify(input),
    });
    if (!res.ok) throw extractApiError(await res.json().catch(() => ({})), '来源关联未完成，请核对原请求后重试', res.status);
    const body = await res.json(), ack = body?.sourceBinding;
    if (body.ok !== true || ack?.schemaVersion !== 1 || ack.sourceRoundId !== input.sourceRoundId || ack.sampleId !== input.targetSampleId
      || ack.assetId !== input.existingAssetId || ack.caseId !== caseId || ack.requestKey !== input.requestKey || !ack.actorId
      || typeof ack.auditId !== 'string' || !ack.auditId || ack.historicalApprovalRestored !== false
      || !['recorded_exact','current_link_recorded'].includes(ack.provenance)
      || Object.keys(input).some(key => ack.command?.[key] !== (input as any)[key]) || Object.keys(ack.command ?? {}).length !== Object.keys(input).length) {
      throw new Error('关联回执未能核对，请保留原请求重新核对');
    }
    return ack;
  },
  /**
   * DR-054 阶段 E：开发域费用登记（统一费用发生簿 CostRecord）。
   * 归属 sourceType：DevelopmentCase（默认，sourceId=caseId）| SampleBatch（sourceId=batchId）| Sample（sourceId=sampleId）。
   */
  async listShippingCostSources(caseId: string, batchId: string): Promise<DevelopmentShippingCostSource[]> {
    const base = apiService.getStoredConfig().cloudEndpoint;
    const res = await fetch(apiService.buildApiUrl(`/v1/development/${encodeURIComponent(caseId)}/shipping-cost-sources?batchId=${encodeURIComponent(batchId)}`, base), { headers: apiService.getAuthHeaders() });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw Object.assign(extractApiError(err, '寄样费用来源未能完整读取，请重试'), { status: res.status }); }
    const body = await res.json();
    if (!Array.isArray(body.sources)) throw new Error('寄样费用来源结果不可确认，请重试');
    return body.sources;
  },
  async registerDevelopmentCost(caseId: string, input: {
    requestKey: string;
    sourceType: 'DevelopmentCase' | 'SampleBatch' | 'Sample';
    sourceId: string;
    costType: 'sample_making' | 'shipping' | 'testing' | 'development' | 'other';
    amount: number | string;
    currency?: string;
    incurredAt?: string;
    bearerType?: 'customer' | 'internal' | 'supplier';
    bearerRelationId?: string;
    notes?: string;
    shippingSource?: DevelopmentShippingCostSourceInput;
  }, endpoint?: string, isCurrent: () => boolean = () => true): Promise<{ costRecord: any }> {
    return registerDevelopmentCostCommand(caseId, input, endpoint, isCurrent);
  },
};
