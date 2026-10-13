import { authenticatedEventStream } from './authenticatedEventStream';
import { businessNowDate } from '../lib/businessClock';
import { parseShipmentCiSources, parseSourceDocumentSet, type SourceDocumentSetData, type ShipmentCiSources, type ShipmentDocumentSourceBinding } from './documentSourceContracts';
import type { SavedOrderRow } from '../types';
import { getAuthState, hasPermission, subscribe } from './authService';
import { EMAIL_CONTEXT_EVENT } from './emailClientContext';
import { emailRequestJson, fetchImapEmailDetail, fetchImapEmailPage } from './emailReadService';

/** The server projects linked orders only after native order authorization. */
export interface ProductRelatedOrderLine {
  id: string;
  orderId: string;
  lineNumber: number;
  itemNo: string | null;
  description: string | null;
  cloth: string | null;
  quantity: number | string;
  unit: string | null;
  order: { id: string; poNumber: string | null; customer: string | null; dueDate: string; status: string };
}
export type ProductAssetReadDetail = ProductAssetDetail & { relatedOrderLines: ProductRelatedOrderLine[] };

export type NativeInvoiceAttachment = InvoiceAttachment & { fileId: string; receiptId: string; invoiceId: string; sha256: string; fileSize: number; mimeType: string; uploadedAt: string };
export interface InvoiceAttachmentReceipt {
  operation: 'register_invoice_attachment'; actorId: string; invoiceId: string; clientRequestId: string;
  commandHash: string; auditId: string; attachment: NativeInvoiceAttachment;
}
export interface InvoiceAttachmentAck { ok: true; invoiceId: string; attachment: NativeInvoiceAttachment; receipt: InvoiceAttachmentReceipt; replayed: boolean; }
const attachmentUuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const attachmentText = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.trim() === v;
export function invoiceFileAttachments(metadata: unknown): InvoiceAttachment[] {
  if (Array.isArray(metadata)) return metadata;
  if (metadata && typeof metadata === 'object' && Array.isArray((metadata as any).invoiceFiles)) return (metadata as any).invoiceFiles;
  return [];
}
export function isNativeInvoiceAttachment(attachment: InvoiceAttachment): attachment is NativeInvoiceAttachment {
  const a = attachment as NativeInvoiceAttachment;
  return attachmentUuid(a.fileId) && attachmentText(a.receiptId) && attachmentText(a.invoiceId)
    && /^[a-f0-9]{64}$/.test(a.sha256 ?? '') && attachmentText(a.fileName) && attachmentText(a.mimeType)
    && Number.isSafeInteger(a.fileSize) && a.fileSize > 0 && a.fileSize <= 15 * 1024 * 1024
    && typeof a.uploadedAt === 'string' && Number.isFinite(Date.parse(a.uploadedAt))
    && a.url === `/api/v1/finance/${encodeURIComponent(a.invoiceId)}/attachments/${a.fileId}/download`;
}
function attachmentIdentity(endpoint?: string) {
  const auth = getAuthState();
  if (!auth.isAuthenticated || !auth.user?.id) throw Error('请重新登录后核对发票归档。');
  return JSON.stringify([endpoint ?? apiService.getStoredConfig().cloudEndpoint,apiService.getStoredConfig().cloudEndpoint,apiService.getAuthHeaders(),auth.user.id,
    auth.user.roles,auth.user.roleIds ?? [],auth.user.permissions,auth.user.permissionCeiling ?? null,auth.user.departmentIds ?? [],auth.user.department ?? null]);
}
async function attachmentRequest<T>(endpoint: string | undefined, writing: boolean, work: (current: () => void) => Promise<T>): Promise<T> {
  if (!hasPermission(writing ? 'invoices:write' : 'invoices:read')) throw Error('当前账号没有发票归档的操作权限。');
  const identity = attachmentIdentity(endpoint); let stale = false;
  const watch = () => { try { if (attachmentIdentity(endpoint) !== identity) stale = true; } catch { stale = true; } };
  const stop = subscribe(watch);
  const current = () => { watch(); if (stale) throw Error('账号、权限或服务地址已变化，原归档结果需核对。'); };
  window.addEventListener('storage',watch);window.addEventListener('focus',watch);
  try { current();return await work(current); }
  finally { stop();window.removeEventListener('storage',watch);window.removeEventListener('focus',watch); }
}
const attachmentHash = async (bytes: ArrayBuffer): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
export function checkedInvoiceAttachmentAck(data: any, invoiceId: string, clientRequestId: string, actorId: string): InvoiceAttachmentAck {
  const r = data?.receipt, a = data?.attachment;
  if (data?.ok !== true || data.invoiceId !== invoiceId || typeof data.replayed !== 'boolean' || !isNativeInvoiceAttachment(a ?? {})
    || a.invoiceId !== invoiceId || r?.operation !== 'register_invoice_attachment' || r.actorId !== actorId || r.invoiceId !== invoiceId
    || r.clientRequestId !== clientRequestId || !attachmentUuid(clientRequestId) || r.auditId !== a.receiptId
    || !/^[a-f0-9]{64}$/.test(r.commandHash ?? '') || JSON.stringify(r.attachment) !== JSON.stringify(a))
    throw Error('归档回执未确认，请核对本次归档；勿直接重复上传。');
  return data;
}

import {
  KnowledgeItem,
  SopTemplate,
  SopStep,
  KnowledgeRelationView,
  EntityLinkView,
  KnowledgeCitation,
  Order,
  OrderStatusTransition,
  SystemConfig,
  Email,
  Relation,
  ProductAsset,
  ProductAssetDetail,
  ProductSubCategory,
  FabricExclusivityViolation,
  Invoice,
  InvoiceAttachment,
  InvoiceOrderAllocation,
  InvoiceWriteInput,
  PaymentVoucher,
  Quotation,
  QuotationInput,
  HistoricalQuotationImportRow,
  QuotationImportResult,
  BrandLine,
  BrandLineInput,
  CommunicationLog,
  CommunicationLogInput,
  EmailSignature,
  EmailSignatureInput,
  DocumentTemplate,
  DocumentTemplateInput,
  PurchaseOrder,
  PurchaseOrderInput,
  MaterialReceipt,
  MaterialReceiptInput,
  MaterialReturn,
  MaterialReturnType,
  SupplierInquiry,
  SupplierInquiryInput,
  SupplierQuoteInput,
  Warehouse,
  WarehouseInput,
  InventoryItem,
  InventoryItemInput,
  InventoryOwnershipSummary,
  StockMovement,
  StockMovementInput,
  BOM,
  CreateBOMInput,
  UpdateBOMInput,
  Shipment,
  DocumentSetData,
  EntityAuditLogItem,
  DevelopmentCase,
  Insight,
  CreateProductAssetInput,
  BusinessProfile,
  BusinessProfileInput,
  ProductImage,
  SystemAsset,
  NotificationItem,
  NotificationStats,
  NotificationTypeCatalogItem,
  ApprovalRequestItem,
  ApprovalRequestStatus,
  AutomationRule,
  WorkflowDefinition,
  WorkflowInstance,
  WorkflowStepCommand,
  // CRM
  Contact,
  ContactInput,
  CreditLimit,
  CreditLimitInput,
  FollowUpRecord,
  FollowUpInput,
  Opportunity,
  OpportunityInput,
  CustomerTier,
  CustomerTierInput,
  CrmOverview,
  // 供应商管理（阶段 H H1）
  FactoryProfile,
  FactoryProfileInput,
  FactoryProfilePatch,
  FactoryEvaluation,
  FactoryEvaluationInput,
  FactoryCertification,
  FactoryCertificationInput,
  FactoryCapacity,
  FactoryOverview,
  // 季节性与趋势管理（阶段 H H2）
  Season,
  SeasonInput,
  SeasonPatch,
  SeasonReview,
  TrendTag,
  TrendTagInput,
  TrendTagPatch,
  TrendTagFabricLink,
  TrendingFabricItem,
  TradeShow,
  TradeShowInput,
  TradeShowPatch,
  TradeShowROI,
  TradeShowLead,
  TradeShowLeadInput,
  TradeShowLeadPatch,
  // 风险管理与合规（阶段 H H3）
  RiskAlert,
  RiskAlertStatus,
  RiskOverview,
  ExchangeRate,
  ExchangeRateInput,
  LatestFxRate,
  FxRateLock,
  FxRateLockInput,
  CreditRating,
  ComplianceCheck,
  ComplianceCheckInput,
  DefectTrendItem,
  // QC 工作台 + 驻地管理 + 业务线配置（阶段 P0）
  BusinessLine,
  BusinessLineInput,
  BusinessLinePatch,
  QCLocation,
  QCLocationInput,
  QCLocationPatch,
  QCAssignment,
  QCAssignmentInput,
  QCAssignmentPatch,
  QcWorkbenchData,
  QcMoqCheckResult,
  UserAccountOption,
  // MES
  WorkStation,
  WorkStationInput,
  WorkStationUtilization,
  ProductionPlan,
  ProductionPlanInput,
  ProductionPlanStatus,
  WorkHour,
  WorkHourInput,
  WorkHourSummary,
  PieceRateRule,
  PieceRateRuleInput,
  PieceRateRecord,
  PieceRateRecordInput,
  PieceRateStatus,
  PieceRateSummary,
  OutsourcingOrder,
  OutsourcingOrderInput,
  OrderProcessNodeRow,
  OrderProcessChainSummary,
  TcCertificateRow,
  DelayImpactResult,
  DelayReason,
  FactoryDelayRecord,
  TcStageSummary,
  TcChainVerification,
  TcStage,
  OutsourcingStatus,
  // Customs
  CustomsType,
  CustomsDeclaration,
  CustomsDeclarationInput,
  CustomsDeclarationLine,
  CustomsDeclarationLineInput,
  CustomsDeclarationStatus,
  HsCode,
  HsCodeInput,
  HsCodeCategory,
  LetterOfCredit,
  LetterOfCreditInput,
  LetterOfCreditType,
  LetterOfCreditStatus,
  LcEvent,
  TaxRefund,
  TaxRefundInput,
  TaxRefundReviewInput,
  TaxRefundStatus,
  TradeDocument,
  TradeDocumentInput,
  TradeDocumentType,
  TradeDocumentStatus,
  DocumentVersionRecord,
  GenerateTradeDocumentsResult,
  TradeDocumentPackItem,
  CustomsOverview,
  // Finance Reports (Phase B2)
  AgingReport,
  CashCalendarReport,
  CustomerStatement,
  SupplierStatement,
  FxGainLossReport,
  BusinessCockpit,
  // 催款函套件（REQ2-08，DR-050）+ P0-2 分级状态机
  DunningLetter,
  DunningChannel,
  DunningResultStatus,
  DunningRecord,
  DunningStage,
  DunningStageBoard,
  // 定价与利润（阶段 P1）
  TaxRefundRate,
  TaxRefundRateInput,
  TaxRefundRatePatch,
  TrackBInput,
  TrackBResult,
  TrackAInput,
  TrackAResult,
  PricingCalculation,
  PricingCalculationInput,
  PricingCalculationPatch,
  OrderProfitSheet,
  OrderCostRings,
  FreightImpactResult,
  MaterialPriceHistory,
  MaterialPriceInput,
  MaterialPricePatch,
  MaterialPriceTrendPoint,
  // 营销工具（阶段 P2）
  CommissionRule,
  CommissionRuleInput,
  CommissionRulePatch,
  LookbookCatalog,
  LookbookItemInput,
  FabricRecommendation,
  RecommendCriteria,
  // 营销活动管理（/api/v2/marketing/*，Phase 1-06）
  MarketingCampaign,
  CampaignRoi,
  MarketingLead,
  // 资料完备度引擎（/api/completeness/*）
  CompletenessSummaryData,
  CompletenessEntityData,
  CompletenessEntityType,
  CompletenessBatchData,
} from '../types';
import { getApiBaseUrl, CORPORATE_MASTER_IP, getDefaultBambookEndpoint, normalizeDataCenterEndpoint } from './apiBase';

export const DEFAULT_KNOWLEDGE_API_ENDPOINT = 'https://jiangsupanda.com/bambook';
export const DEFAULT_CLOUD_ENDPOINT = 'https://jiangsupanda.com/bambook';

export interface TestResult {
  ok: boolean;
  error?: string;
  detail?: string;
  testedUrl?: string;
  statusCode?: number;
  rawError?: string;
  isCorsIssue?: boolean;
  isProtocolIssue?: boolean;
  isPhysicalDown?: boolean;
}

export interface KnowledgeDocumentRecord {
  id: string;
  title: string;
  content: string;
  category: string | null;
  sourceType: string;
  version: number;
  chunkCount: number;
  checksum: string | null;
  createdAt: number;
  updatedAt: number;
  origin: 'erp' | 'upload';
}

export interface ProductAssetPage {
  assets: ProductAssetDetail[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export { CORPORATE_MASTER_IP, getApiBaseUrl } from './apiBase';

/** 动态获取 API base URL，确保设置变更后立即生效。 */
const getDynamicApiBaseUrl = () => getApiBaseUrl();

const normalizeEndpoint = (endpoint?: string): string => {
  // 本地 Web dev（VITE_API_BASE_URL 相对基座，如 '/api'）为硬路由，
  // 优先于调用方显式传入的 endpoint（默认为生产 cloudEndpoint）——
  // 与 authService.getAuthApiBase 的 env 优先级语义对齐，避免
  // 「登录走本地、业务数据却写往生产」的割裂路由。
  const envBase = String(import.meta.env.VITE_API_BASE_URL || '').trim();
  if (envBase.startsWith('/')) return envBase.replace(/\/$/, '');
  if (!endpoint?.trim()) return getDynamicApiBaseUrl().replace(/\/$/, '');
  let formatted = normalizeDataCenterEndpoint(endpoint);
  if (!formatted.startsWith('http')) formatted = `http://${formatted}`;
  try {
    const url = new URL(formatted);
    if (!url.port && url.pathname === '/') url.port = '8081';
    return `${url.origin}${url.pathname === '/' ? '' : url.pathname}`.replace(/\/$/, '');
  } catch {
    if (!formatted.match(/:\d+$/)) formatted = `${formatted}:8081`;
    return formatted;
  }
};

const buildApiUrl = (path: string, endpoint?: string): string => {
  const base = normalizeEndpoint(endpoint);
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  if (base.endsWith('/api')) {
    return `${base}${cleanPath.startsWith('/api/') ? cleanPath.slice(4) : cleanPath}`;
  }
  return `${base}${cleanPath.startsWith('/api/') ? cleanPath : `/api${cleanPath}`}`;
};

/**
 * API Key 取值。
 *
 * 刻意**不**再从 import.meta.env 读取 VITE_BAMBOOK_API_KEY：
 * Vite 会把 VITE_ 前缀变量原样内联进客户端产物，等于把服务端密钥印在
 * 任何人都可下载的 JS 里（实测线上 assets/App-*.js 可直接 grep 出 48 位 key，
 * 前端并在 /api/v2/orders、/api/v2/relations、/api/v1/finance 等 13 个业务接口上
 * 携带它发出）。浏览器无法保守秘密，因此网页端一律走 JWT 会话鉴权；
 * 只有在系统配置里显式填了 sdkApiKey 时才带 X-Bambook-API-Key 头。
 */
const getApiKey = (): string => {
  try {
    const saved = localStorage.getItem('panda_system_config');
    if (!saved) return '';
    return String(JSON.parse(saved)?.sdkApiKey || '').trim();
  } catch {
    return '';
  }
};

const jsonHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const key = getApiKey();
  if (key) headers['X-Bambook-API-Key'] = key;
  return headers;
};

/** JWT 头（写操作需 JWT 的路由使用，如 email-signatures；token 取自登录态存储） */
const jwtAuthHeaders = (): Record<string, string> => {
  try {
    const token = localStorage.getItem('bambook_auth_token') || sessionStorage.getItem('bambook_auth_token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
};

/**
 * requestJson 默认超时（ms）：弱网/服务无响应时避免界面无限挂起。
 * 大文件上传/流式（SSE/TTS）走独立 fetch 不经此入口；批量导入等长操作调用方传 timeoutMs 覆盖。
 */
const REQUEST_JSON_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 403「权限被拦」的屏面文案：把裸权限码包成一句可执行的话。
 * 返回 null = 不改写（非 403、或后端已经给了人话）。
 */
export function describeForbiddenHttpError(status: number, serverMessage?: string): string | null {
  if (status !== 403 || !serverMessage) return null;
  // 后端（或本文件上游）已经给了带中文的解释 ⇒ 原样透出，不许覆盖（DE-6 审批提示、MOQ 那句自带说明的都属这类）
  if (/[一-龥]/.test(serverMessage)) return null;
  const isScope = serverMessage.includes('INSUFFICIENT_SCOPE');
  const isLegacyRole = /^insufficient role/i.test(serverMessage.trim());
  if (!isScope && !isLegacyRole) return null;
  const scopes: string[] = [];
  const listed = serverMessage.match(/need one of \[([^\]]+)\]/i);
  if (listed) {
    for (const s of listed[1].split(',')) {
      const t = s.trim();
      if (t) scopes.push(t);
    }
  } else {
    for (const m of serverMessage.matchAll(/[a-z][a-z0-9]*(:[a-z0-9-]+)+/gi)) scopes.push(m[0]);
  }
  const unique = Array.from(new Set(scopes));
  if (unique.length > 0) {
    return `当前账号没有这一步需要的权限，需要其一：${unique.join('、')}。请找管理员在角色权限里开通后重试。`;
  }
  return '当前账号没有这一步需要的权限（角色不符）。请找管理员在角色权限里开通后重试。';
}

const requestJson = async <T>(path: string, opts: RequestInit & { endpoint?: string; timeoutMs?: number } = {}): Promise<T> => {
  const { endpoint, headers, timeoutMs = REQUEST_JSON_DEFAULT_TIMEOUT_MS, signal, ...init } = opts;
  // 已登录会话携带 JWT：后端写操作审计（AuditLog.actorId 外键）要求真实用户身份，
  // 仅 API key 时 actor 回退 'system' 会触发外键冲突；JWT 优先于 API key。
  //
  // 超时治理：调用方自带 signal（可取消操作）时不叠加超时；timeoutMs <= 0 显式关闭。
  // 优先 AbortSignal.timeout（原生实现不阻塞事件循环）；缺失环境回退 controller+timer（finally 清理）。
  let timeoutSignal: AbortSignal | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  if (!signal && timeoutMs > 0) {
    if (typeof AbortSignal !== 'undefined' && typeof (AbortSignal as any).timeout === 'function') {
      timeoutSignal = (AbortSignal as any).timeout(timeoutMs) as AbortSignal;
    } else {
      const controller = new AbortController();
      timeoutTimer = setTimeout(() => {
        try {
          controller.abort(new DOMException(`timeout after ${timeoutMs}ms`, 'TimeoutError'));
        } catch {
          controller.abort();
        }
      }, timeoutMs);
      timeoutSignal = controller.signal;
    }
  }
  let response: Response;
  try {
    response = await fetch(buildApiUrl(path, endpoint), {
      ...init,
      signal: signal ?? timeoutSignal ?? undefined,
      headers: {
        ...jsonHeaders(),
        ...jwtAuthHeaders(),
        ...(headers || {}),
      },
    });
  } catch (e: any) {
    // 超时：本入口自建的超时 signal 已中止，或原生 TimeoutError → 语义化超时错误
    if (timeoutSignal?.aborted || e?.name === 'TimeoutError') {
      throw Object.assign(
        new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）：服务器无响应或网络不稳定，请稍后重试`),
        { code: 'REQUEST_TIMEOUT' },
      );
    }
    // 调用方主动取消：保持原语义上抛，不吞掉 AbortError
    if (e?.name === 'AbortError') throw e;
    // 其余传输层失败（DNS/断网/证书）→ 语义化网络错误
    throw Object.assign(
      new Error('网络请求失败：无法连接到服务器，请检查网络连接或服务地址配置'),
      { code: 'NETWORK_ERROR', cause: e },
    );
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const serverMessage = data?.message || (typeof data?.error === 'string' ? data.error : data?.error?.message);
    // DE-6 统一透传：门禁错误响应携带 approvalRequestId 时，抛出错误附带审批单号提示
    // （toast/alert 直接展示 message 即可读「已发起审批单 XXX，请至审批中心处理」），
    // 并将 approvalRequestId/code 挂到错误对象供调用方跳转审批中心。
    const approvalRequestId: string | undefined =
      (typeof data?.approvalRequestId === 'string' && data.approvalRequestId)
      || (typeof data?.error?.approvalRequestId === 'string' && data.error.approvalRequestId)
      || undefined;
    const baseMessage = serverMessage || `HTTP ${response.status}`;
    const forbiddenCopy = describeForbiddenHttpError(response.status, serverMessage);
    const message = forbiddenCopy
      ? forbiddenCopy
      : (approvalRequestId && !baseMessage.includes(approvalRequestId)
        ? `${baseMessage}（已发起审批单 ${approvalRequestId}，请至审批中心处理）`
        : baseMessage);
    throw Object.assign(new Error(message), {
      code: (typeof data?.error === 'object' && data?.error?.code) || data?.code || (typeof data?.error === 'string' && /^[A-Z][A-Z0-9_]+$/.test(data.error) ? data.error : undefined),
      approvalRequestId,
      // HTTP 状态随错误携带：调用方据此区分 401/403/其他（2026-09-06：AuditHistorySection
      // 曾因只认 message 里的 '403'/'FORBIDDEN' 而漏判 INSUFFICIENT_SCOPE，误显「加载失败」）
      status: response.status,
    });
  }
  return data as T;
};

/** HR 模块统一通道：复用 requestJson 的 endpoint 解析 / API key / 错误信封；JWT Bearer 优先，无 token 时回退 cookie 会话。 */
const hrRequest = async <T>(path: string, opts: RequestInit & { endpoint?: string } = {}): Promise<T> => {
  const token = localStorage.getItem('bambook_auth_token') || sessionStorage.getItem('bambook_auth_token');
  return requestJson<T>(`/hr/${path.replace(/^\/+/, '')}`, {
    ...opts,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
    credentials: token ? 'omit' : 'include',
  });
};

/** 用户目录选项（/api/hr/personnel 聚合视图）：在 UserAccountOption 之上透出角色快照，供审批委派等选人控件展示 */
export interface UserAccountDirectoryOption extends UserAccountOption {
  roles?: string[] | null;
}

const postData = async (url: string, data: any) => {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(data),
    });
    return await response.json();
  } catch (error) {
    return { status: 'error', error: String(error) };
  }
};

const getData = async (url: string) => {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: jsonHeaders(),
    });
    return await response.json();
  } catch (error) {
    return { status: 'error', error: String(error) };
  }
};

// Email API
export const fetchEmails = async (config: any) => {
  return fetchImapEmailPage(config, config.box || 'INBOX', config.offset ?? 0, config.limit ?? 200, { ...jsonHeaders(), ...jwtAuthHeaders() });
};

export const fetchEmailDetail = async (config: any, uid: string) => {
  return fetchImapEmailDetail(config, config.box || 'INBOX', uid, { ...jsonHeaders(), ...jwtAuthHeaders() });
};

export const sendEmail = async (data: any) => {
  return emailRequestJson('/email/send', { method: 'POST', headers: { ...jsonHeaders(), ...jwtAuthHeaders() }, body: JSON.stringify(data) });
};

// ── 平台配置：公司档案（W7 设置域 §1A 裁决）类型契约：对齐 server/src/config/systemConfigRoute.ts ──
export interface CompanyExporterProfileValue {
  /** 公司英文名（单据抬头，必填） */
  nameEn: string;
  beneficiary?: string;
  addressEn?: string;
  bankName?: string;
  swiftCode?: string;
  bankAddress?: string;
  usdAccountNumber?: string;
}

export interface CompanyExporterProfileResponse {
  ok: boolean;
  key: string;
  value: CompanyExporterProfileValue;
  version: number;
  /** true = 服务端未配置，返回代码默认值（未落库） */
  isDefault: boolean;
  updatedAt?: number;
  updatedBy?: string | null;
}

export interface CompanyExporterProfileUpdateResponse {
  ok: boolean;
  key: string;
  value: CompanyExporterProfileValue;
  version: number;
  updatedAt: number;
}

// ── 市场行情（羊毛 / 亚麻，**由外部源自动同步**）：契约对齐 server/src/market/marketQuoteRoute.ts ──
export interface MarketManualQuote {
  key: 'wool' | 'linen';
  /** null = 尚无数据（界面显示「暂无数据」，不是 0） */
  price: number | null;
  asOf: string | null;
  note: string | null;
  /** true ⇒ 该值由外部源自动同步写入（人工应急覆盖时为 false） */
  auto: boolean;
  cadence: 'monthly' | 'quarterly' | null;
  /** 原始报价（美分/公斤 / 欧元/公斤），留档便于核对折算 */
  nativePrice: number | null;
  nativeUnit: string | null;
  nativeChangePct: number | null;
  sourceUrl: string | null;
  fetchedAt: string | null;
  /** 服务端给的合理区间 [下限, 上限]，CNY/吨 */
  range: [number, number];
  updatedAt?: string | null;
  updatedBy?: string | null;
}

/** 「立即同步」的结果：每个源各自成没成、没成的为什么 */
export interface MarketQuoteSyncReport {
  ok: string[];
  failed: Array<{ key: string; reason: string }>;
  skipped: string[];
}

export interface CompanyExporterProfileHistoryItem {
  id: string;
  configId: string;
  versionFrom: number;
  versionTo: number;
  valueFrom: CompanyExporterProfileValue | null;
  valueTo: CompanyExporterProfileValue | null;
  actorId: string | null;
  reason: string | null;
  createdAt: string;
}

/** Neutral physical ranges. Quantities remain Decimal strings; these records
 * do not assert production, stock, QC approval or release. */
export type GarmentSizeQuantityMap = Record<string, number>;
export type ProductionLineChoice = import('../server/src/production/productionLineIdentity').ProductionLineChoice;
export type ProductionLineIdentity = import('../server/src/production/productionLineIdentity').ProductionLineIdentity;
export type FactoryProductionLineRow = { id: string; factoryRelationId: string; name: string; location: string | null; state: string; revision: number; requestKey: string; parameterHash: string; createdBy: string; createdAt: string; updatedAt: string };
export type ProductionBatchCommand = { batchCode: string; quantity: string; unit: string; expectedLineFingerprint: string; requestKey: string; factoryRelationId?: string; sizeBreakdown?: GarmentSizeQuantityMap; productionLineChoice?: ProductionLineChoice };
export type ProductionBatchSplitCommand = { expectedRevision: number; expectedLineFingerprint: string; requestKey: string; children: Array<{ batchCode: string; quantity: string; sizeBreakdown?: GarmentSizeQuantityMap }> };
export type ProductionCompletionCommand = { expectedRevision: number; expectedLineFingerprint: string; actualQty: string; actualQtyBySize?: GarmentSizeQuantityMap; requestKey: string };
export type ProductionCompletionRow = { id: string; productionBatchId: string; productionBatchRevision: number; orderId: string; orderLineId: string;
  actualQuantity: string; actualSizeBreakdown?: GarmentSizeQuantityMap | null; unit: string; lineFingerprint: string; scopeSnapshot: Record<string, unknown>; requestKey: string; commandHash: string;
  commandSnapshot: { protocolVersion: number; operation: string; actorId: string; batchId: string; orderId: string; orderLineId: string;
    productionBatchRevision: number; expectedLineFingerprint: string; actualQty: string; actualQtyBySize?: GarmentSizeQuantityMap | null;
    unit: string; requestKey: string };
  recordedBy: string; recordedAt: string };
export type ProductionToleranceSummary = { status: 'pending' | 'within_tolerance' | 'over_tolerance' | 'under_tolerance' | 'unresolved'; source: string | null;
  comparisonBasis?: 'line_total' | 'per_size' | 'unknown'; percent: number | null; allowedMin: string | null; allowedMax: string | null; reason: string | null;
  perSize?: Array<{ size: string; contractQty: number; actualQty: number; status: 'within_tolerance' | 'over_tolerance' | 'under_tolerance' | 'unresolved';
    source: string | null; percent: number | null; allowedMin: string | null; allowedMax: string | null; reason: string | null }> };
export type ProductionCompletionBranch = { productionBatchId: string; productionBatchRevision: number; parentBatchId: string | null; factoryRelationId: string;
  plannedQty: string; plannedSizeBreakdown?: GarmentSizeQuantityMap | null; unit: string; actualQty: string | null; actualQtyBySize?: GarmentSizeQuantityMap | null;
  completedAt: string | null; completionId: string | null; completionCurrent: boolean };
export type OrderLineProductionCompletion = { status: 'not_started' | 'incomplete' | 'unresolved' | 'out_of_tolerance' | 'complete'; productionComplete: boolean;
  productionCompletionQuantity: string | null; actualQty: string | null; unit: string | null; expectedBranchCount: number; completedBranchCount: number;
  contractQty: string; coverageComplete: boolean; requiresPerSizeActuals: boolean | null; tolerance: ProductionToleranceSummary; branches: ProductionCompletionBranch[];
  blockers: Array<{ code: string; message: string }>; lineFingerprint: string };
export type ProductionBatchRow = {
  id: string; batchCode: string; orderId: string; orderLineId: string; parentBatchId: string | null;
  factoryRelationId: string; rangeStart: string; quantity: string; sizeBreakdown?: GarmentSizeQuantityMap | null; unit: string; revision: number;
  productionLineId?: string | null; productionLineSnapshot?: ProductionLineIdentity | null;
  state: 'active' | 'split' | 'cancelled' | 'invalidated'; confirmedSourceType: string; confirmedSourceId: string;
  specSnapshot: Record<string, unknown>; sourceFingerprint: string; requestKey: string; parameterHash: string;
  commandSnapshot: ProductionBatchCommand | (ProductionBatchSplitCommand & { parentId: string; childIndex: number });
  createdBy: string; createdAt: string; updatedAt: string;
  productionQcIssues?: { available: boolean; error?: string; issues: Array<{ issueId: string; productionBatchRevision: number;
    failedReportId: string; reason: string | null; createdBy: string; createdAt: string;
    status: 'open' | 'waiting_business_resume' | 'resumed' | 'unknown'; latestReportId: string | null;
    latestReportResult: string | null; latestEventAt: string | null }> };
};
export type ProductionBatchAccount = { ok: true; lineFingerprint: string; batches: ProductionBatchRow[]; productionCompletion?: OrderLineProductionCompletion; productionLineApplicable?: boolean };
export type ProductionBatchCreateReceipt = { ok: true; batch: ProductionBatchRow; replayed: boolean };
export type ProductionLineBindingCommand = { expectedRevision: number; expectedLineFingerprint: string; requestKey: string; productionLineChoice: ProductionLineChoice };
export type ProductionLineBindingReceipt = ProductionBatchCreateReceipt & { productionLineReceipt: { protocolVersion: 1; requestKey: string; actorId: string; orderId: string; orderLineId: string; batchId: string; expectedRevision: number; revision: number; parameterHash: string; command: ProductionLineBindingCommand } };
export type ProductionBatchSplitReceipt = { ok: true; parent: ProductionBatchRow; children: ProductionBatchRow[]; replayed: boolean };
export type ProductionCompletionReceipt = { ok: true; completion: ProductionCompletionRow; orderLineCompletion: OrderLineProductionCompletion; replayed: boolean };
export type ProductionQcResumeCommand = { orderLineId: string; expectedRevision: number; requestKey: string };
export type ProductionQcResumeReceipt = { ok: true; orderId: string; orderLineId: string; productionBatchId: string;
  productionBatchRevision: number; issueIds: string[]; resumedAt: string; replayed: boolean };
export type ProductionBatchRequestOptions = { endpoint?: string; headers?: Record<string, string> };
export type ProductionStockReceiptCommand = { expectedBatchRevision: number; expectedScopeFingerprint: string; warehouseId: string;
  quantity: string; unit: string; movementDate: string; receiptReference: string; ownership: 'Owned' | 'Transferred';
  unitCost: string | null; currency: string; requestKey: string };
export type ProductionStockReceiptRow = { id: string; productionBatchId: string; productionBatchRevision: number; orderId: string; orderLineId: string;
  warehouseId: string; inventoryItemId: string; stockMovementId: string; quantity: string; unit: string; scopeFingerprint: string; scopeSnapshot: Record<string, unknown>;
  movementDate: string; receiptReference: string; requestKey: string; createdBy: string; createdAt: string; commandHash: string;
  commandSnapshot?: ProductionStockReceiptCommand; receiptSnapshot?: Record<string, unknown> };
export type PhysicalStockItem = { id: string; warehouseId: string; quantity: string; lockedQuantity: string; unit: string; orderId: string | null;
  ownership: string; deletedAt: string | null; unitCost?: string | null; currency?: string };
export type ProductionStockReceiptAccount = { ok: true; batch: ProductionBatchRow; scopeFingerprint: string; receivedQuantity: string;
  receipts: Array<{ receipt: ProductionStockReceiptRow; inventoryItem: PhysicalStockItem | null }> };
export type ProductionStockReceiptAck = { ok: true; receipt: ProductionStockReceiptRow; inventoryItem: PhysicalStockItem;
  movement: { id: string; itemId: string; warehouseId: string; quantity: string; unit: string; unitCost: string | null; type: string; balanceBefore: string; balanceAfter: string;
    operator: string; referenceType: string; referenceId: string; movementDate: string }; replayed: boolean };



function customsDownloadFence(endpoint?: string, isCurrent: () => boolean = () => true) {
  const identity = () => { const state = getAuthState(), u = state.user; return JSON.stringify([endpoint, apiService.getStoredConfig().cloudEndpoint, apiService.getAuthHeaders(), state.isAuthenticated, state.isLoading, u?.id, u?.roles, u?.roleIds, u?.permissions, u?.permissionCeiling, u?.departmentIds, u?.department]); };
  if (!getAuthState().isAuthenticated || getAuthState().isLoading || !hasPermission('customs:read')) throw new Error('当前账号无权读取本单据。');
  const before = identity(); let stale = false;
  const observe = () => { if (identity() !== before || !isCurrent()) stale = true; };
  const unsubscribe = subscribe(observe); window.addEventListener('storage', observe); window.addEventListener('focus', observe);
  return { check: () => { observe(); if (stale) throw new Error('账号、权限或服务地址已变化，请重新读取原单据。'); },
    dispose: () => { unsubscribe(); window.removeEventListener('storage', observe); window.removeEventListener('focus', observe); } };
}

function subscribeRealtime<T>(endpoint: string | undefined, eventName: string, callback: (value: T) => void, onOpen?: () => void): () => void {
  if (typeof fetch === 'undefined' || typeof window === 'undefined') return () => {};
  return authenticatedEventStream({
    snapshot: () => {
      const headers = { ...jwtAuthHeaders(), ...(getApiKey() ? { 'X-Bambook-API-Key': getApiKey() } : {}) };
      const url = new URL(buildApiUrl('/v1/events', endpoint), window.location.origin).toString();
      const auth = getAuthState();
      return { url, headers, identity: JSON.stringify([url, headers, auth.isAuthenticated, auth.user]) };
    },
    observe: changed => {
      const stop = subscribe(changed);
      window.addEventListener('storage', changed); window.addEventListener('focus', changed); window.addEventListener(EMAIL_CONTEXT_EVENT, changed);
      return () => { stop(); window.removeEventListener('storage', changed); window.removeEventListener('focus', changed); window.removeEventListener(EMAIL_CONTEXT_EVENT, changed); };
    },
    onOpen,
    onEvent: (event, data) => {
      if (event !== eventName) return;
      let value: T;
      try { value = JSON.parse(data); } catch { console.warn('[Realtime] ignored malformed event'); return; }
      callback(value);
    },
  });
}

export const apiService = {
  getStoredConfig: (): SystemConfig => {
    const saved = localStorage.getItem('panda_system_config');

    const defaultConfig: SystemConfig = {
      // DEV 默认闭环本地后端（不读生产 VITE_CLOUD_ENDPOINT，显式配置仍可指生产）；
      // PROD 构建静态走原兜底链，行为不变。
      // @ts-ignore
      cloudEndpoint: import.meta.env.DEV
        ? getDefaultBambookEndpoint()
        : import.meta.env.VITE_CLOUD_ENDPOINT || DEFAULT_CLOUD_ENDPOINT,
      // @ts-ignore
      knowledgeApiEndpoint: import.meta.env.VITE_KNOWLEDGE_API_ENDPOINT || DEFAULT_KNOWLEDGE_API_ENDPOINT,
      knowledgeApiKey: '',
      databaseId: 'panda-node-v1',
      isCloudConnected: false,
      isRootActive: false,
      syncInterval: 15,
      agentName: '竹衍 (Bambook)',
      agentRole: 'Panda Clothing 数字智慧核心，精通全球供应链演化与逻辑推演。',
      // Visuals
      themeMode: 'system',
      compactMode: false,
      systemWallpaperOptions: undefined,
      enableProductionGlobe: true,
      // AI Core（默认与 Assistant 内 MODELS.FAST 一致 = MODELS.AUTO）
      chatModelId: 'ark-code-latest',
      temperature: 0.7,
      maxTokens: 2048,
      enableVision: true,
      // Voice
      ttsProvider: 'Volcengine-TTS',
      voiceSpeed: 1.0,
      // SDK API Defaults
      sdkApiKey: '',
      sdkAuthMode: 'auto'
    };

    if (!saved) return defaultConfig;

    try {
      const parsed = JSON.parse(saved);
      let didMigrateConfig = false;
      const normalizedCloudEndpoint = normalizeDataCenterEndpoint(parsed.cloudEndpoint);
      if (parsed.cloudEndpoint !== normalizedCloudEndpoint) {
        parsed.cloudEndpoint = normalizedCloudEndpoint;
        didMigrateConfig = true;
      }
      if (!parsed.knowledgeApiEndpoint || parsed.knowledgeApiEndpoint.trim() === '') {
        parsed.knowledgeApiEndpoint = defaultConfig.knowledgeApiEndpoint;
        didMigrateConfig = true;
      }
      if (!parsed.chatModelId && parsed.modelProvider) {
        // Migration: map legacy `modelProvider` enum to the current Ark model.
        const legacy: Record<string, string> = {
          'Qwen-Max': 'ark-code-latest',
          'GLM-4-Plus': 'ark-code-latest',
          'GLM-4-Flash': 'ark-code-latest',
          'GLM-4V-Plus': 'ark-code-latest'
        };
        parsed.chatModelId = legacy[parsed.modelProvider] || 'ark-code-latest';
      }
      // Belt-and-suspenders: 升级到新清单时，把已存的过期 chatModelId
      // 也归一到可用模型，避免下拉显示空白 / 后端 404。
      const VALID_MODEL_IDS = new Set([
        'ark-code-latest'
      ]);
      if (parsed.chatModelId && !VALID_MODEL_IDS.has(parsed.chatModelId)) {
        parsed.chatModelId = 'ark-code-latest';
        didMigrateConfig = true;
      }
      const migratedConfig = { ...defaultConfig, ...parsed };
      if (didMigrateConfig) {
        localStorage.setItem('panda_system_config', JSON.stringify(migratedConfig));
      }
      return migratedConfig;
    } catch (e) {
      return defaultConfig;
    }
  },

  saveConfig: (config: SystemConfig) => {
    localStorage.setItem('panda_system_config', JSON.stringify(config));
    // Same-tab endpoint ABA must invalidate active mailbox reads synchronously.
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(EMAIL_CONTEXT_EVENT));
  },

  async fetchCloudData<T>(path: string, endpoint: string): Promise<T | null> {
    if (!endpoint) return null;
    try {
      const response = await fetch(buildApiUrl(path, endpoint), {
        method: 'GET',
        // 数据中心快照拉取需带登录态 JWT（knowledge/insights/product-categories 等端点由 requirePermission 守卫，
        // 无 actor 时返回 401 "Login (JWT cookie or Bearer) required before scope check"）。
        // 与 requestJson 保持一致：API key + JWT Bearer 双携带，确保已登录会话能正常拉快照。
        headers: { ...jsonHeaders(), ...jwtAuthHeaders() },
      });
      if (!response.ok) throw new Error('Network response was not ok');
      return await response.json();
    } catch (e) {
      return null;
    }
  },

  async postCloudData(path: string, endpoint: string, data: any): Promise<boolean> {
    if (!endpoint) return false;
    try {
      const response = await fetch(buildApiUrl(path, endpoint), {
        method: 'POST',
        headers: { ...jsonHeaders(), ...jwtAuthHeaders() },
        body: JSON.stringify(data)
      });
      return response.ok;
    } catch (e) {
      return false;
    }
  },

  async probePhysicalLink(ip: string): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 2500);
      const img = new Image();
      img.onload = () => { clearTimeout(timeout); resolve(true); };
      img.onerror = () => { clearTimeout(timeout); resolve(true); };
      // 探测 IP 是否通畅，无视 CORS
      img.src = `http://${ip}:8081/favicon.ico?t=${Date.now()}`;
    });
  },

  async testConnection(endpoint: string): Promise<TestResult> {
    if (!endpoint) return { ok: false, error: 'MISSING_IP', detail: '请输入服务器公网 IP' };

    const cleanIp = endpoint.replace(/^https?:\/\//, '').replace(/\/$/, '').trim();
    const isPageHttps = window.location.protocol === 'https:';
    const testUrl = buildApiUrl('/health', endpoint);
    const isTargetHttp = testUrl.startsWith('http://');

    // 1. 协议检查
    if (isPageHttps && isTargetHttp) {
      return {
        ok: false,
        isProtocolIssue: true,
        testedUrl: testUrl,
        detail: '安全策略阻断 (Mixed Content)：由于你正在通过 HTTPS 访问此应用，浏览器禁止访问 HTTP 后端。请通过 http:// 协议打开应用，或在浏览器设置中允许“不安全内容”。'
      };
    }

    // 2. 物理链路探测仅适用于旧的 HTTP/IP 直连；Cloudflare HTTPS 直接请求健康检查。
    if (isTargetHttp) {
      const isPhysicalUp = await this.probePhysicalLink(cleanIp);
      if (!isPhysicalUp) {
        return {
          ok: false,
          isPhysicalDown: true,
          testedUrl: testUrl,
          detail: '物理链路不通 (Timeout)：无法连接到主数据 API。请检查端口、防火墙或后端进程。'
        };
      }
    }

    // 3. 完整接口测试
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);

      const res = await fetch(testUrl, {
        method: 'GET',
        mode: 'cors',
        signal: controller.signal,
        headers: { 'Access-Control-Allow-Private-Network': 'true' }
      });
      if (res.status === 404) {
        return {
          ok: false,
          testedUrl: testUrl,
          statusCode: res.status,
          detail: '主数据健康检查返回 404。若使用 Cloudflare /bambook，请确认 /bambook/api 优先路由到 Mac mini 8081。'
        };
      }
      const data = await res.json();
      if (data.status === 'ok') return { ok: true, testedUrl: testUrl, statusCode: res.status };
      return { ok: false, testedUrl: testUrl, statusCode: res.status, detail: '节点在线但响应数据格式异常。' };
    } catch (e: any) {
      return {
        ok: false,
        isCorsIssue: true,
        testedUrl: testUrl,
        detail: 'CORS、网络重置或超时错误。请确认 Cloudflare 路由、8081 服务、CORS 与数据库连接状态。'
      };
    }
  },

  async fetchEmailDetail(config: any, box: string, uid: string, options?: { signal?: AbortSignal }) {
    return fetchImapEmailDetail(config, box, uid, { ...jsonHeaders(), ...jwtAuthHeaders() }, options?.signal);
  },

  buildApiUrl,
  getApiKey,
  /** 统一认证头：Content-Type + API key + 登录会话 JWT（写操作必需，后端审计/角色校验依赖真实用户身份） */
  getAuthHeaders: (): Record<string, string> => ({ ...jsonHeaders(), ...jwtAuthHeaders() }),

  subscribeToDataChanges(endpoint: string | undefined, onChange: (event: { entity: string; action: string; ids?: string[]; timestamp: number }) => void, onReconnect?: () => void): () => void {
    let connected = false;
    return subscribeRealtime(endpoint, 'data-change', onChange, () => {
      if (connected) onReconnect?.();
      connected = true;
    });
  },

  /**
   * 订阅实时通知 SSE 事件（Phase 0 Sprint 1 通知系统实时链路）
   *
   * 后端 publishNotificationEvent 推送 `event: notification` SSE 事件，
   * 前端收到后增量更新未读徽章 + 抽屉列表，无需等待 30s 轮询。
   *
   * 返回 cleanup 函数，组件卸载时调用以关闭事件流。
   */
  subscribeToNotifications(endpoint: string | undefined, onNotification: (event: { type: string; title: string; body: string; level: string; link?: string; eventId: string; eventType: string; orderId?: string; recipientIds: string[]; metadata?: Record<string, unknown>; timestamp: number }) => void): () => void {
    return subscribeRealtime(endpoint, 'notification', onNotification);
  },

  /**
   * 订单列表（V2 行级口径，DR-042 v2.2 L2 换锚）：可见性锚 = 宿主客户的跟进人 ∪ 团队共享 ∪ 管理角色。
   * 旧 V1 端点无行级过滤，已切换至 V2；客户转让后历史订单视野自动继承。
   */
  async listOrders(endpoint?: string, params?: { limit?: number; offset?: number }): Promise<Order[]> {
    const page = await this.listOrdersPage(endpoint, params);
    return page.items;
  },

  /**
   * 订单列表分页口径（V2，DR-042 v2.2）：透传 limit/offset 并返回 total，
   * 供列表「加载更多」与截断提示使用；listOrders 保持数组返回不破坏既有调用方。
   */
  async listOrdersPage(endpoint?: string, params?: { limit?: number; offset?: number; search?: string }): Promise<{ items: Order[]; total: number }> {
    const query = new URLSearchParams();
    query.set('limit', String(params?.limit ?? 500));
    if (params?.offset != null) query.set('offset', String(params.offset));
    // 关联选择器（G1-3）/ 订单检索：按 PO/客户/产品名模糊搜索（对齐 V2 listOrders semantics）
    if (params?.search?.trim()) query.set('search', params.search.trim());
    const data = await requestJson<{ ok: boolean; items: Order[]; total: number }>(`/v2/orders?${query.toString()}`, { endpoint, method: 'GET' });
    const items = Array.isArray(data.items) ? data.items : [];
    return { items, total: typeof data.total === 'number' ? data.total : items.length };
  },

  async getOrderTimeline(orderId: string, endpoint?: string): Promise<OrderStatusTransition[]> {
    const data = await requestJson<{ ok: boolean; timeline?: OrderStatusTransition[] }>(`/v1/orders/${encodeURIComponent(orderId)}/timeline`, { endpoint, method: 'GET' });
    return Array.isArray(data.timeline) ? data.timeline : [];
  },

  async getOrderById(orderId: string, endpoint?: string): Promise<SavedOrderRow> {
    const data = await requestJson<{ ok: boolean; order: SavedOrderRow }>(`/v1/orders/${encodeURIComponent(orderId)}`, { endpoint, method: 'GET' });
    return data.order;
  },

  async getProductionBatches(orderId: string, lineId: string, options: ProductionBatchRequestOptions = {}): Promise<ProductionBatchAccount> {
    return requestJson(`/v1/production-batches/orders/${encodeURIComponent(orderId)}/lines/${encodeURIComponent(lineId)}`, { ...options, method: 'GET' });
  },
  async createProductionBatch(orderId: string, lineId: string, command: ProductionBatchCommand, options: ProductionBatchRequestOptions = {}): Promise<ProductionBatchCreateReceipt> {
    return requestJson(`/v1/production-batches/orders/${encodeURIComponent(orderId)}/lines/${encodeURIComponent(lineId)}`, { ...options, method: 'POST', body: JSON.stringify(command) });
  },
  async listFactoryProductionLines(orderId: string, lineId: string, factoryRelationId: string, options: ProductionBatchRequestOptions = {}): Promise<{ ok: true; orderId: string; orderLineId: string; factoryRelationId: string; lines: FactoryProductionLineRow[] }> {
    return requestJson(`/v1/production-batches/orders/${encodeURIComponent(orderId)}/lines/${encodeURIComponent(lineId)}/factory-production-lines?${new URLSearchParams({ factoryRelationId })}`, { ...options, method: 'GET' });
  },
  async registerFactoryProductionLine(orderId: string, lineId: string, command: { factoryRelationId: string; name: string; location: string | null; requestKey: string }, options: ProductionBatchRequestOptions = {}): Promise<{ ok: true; orderId: string; orderLineId: string; factoryRelationId: string; line: FactoryProductionLineRow; replayed: boolean }> {
    return requestJson(`/v1/production-batches/orders/${encodeURIComponent(orderId)}/lines/${encodeURIComponent(lineId)}/factory-production-lines`, { ...options, method: 'POST', body: JSON.stringify(command) });
  },
  async bindProductionBatchLine(batchId: string, command: ProductionLineBindingCommand, options: ProductionBatchRequestOptions = {}): Promise<ProductionLineBindingReceipt> {
    return requestJson(`/v1/production-batches/${encodeURIComponent(batchId)}/production-line`, { ...options, method: 'POST', body: JSON.stringify(command) });
  },
  async splitProductionBatch(batchId: string, command: ProductionBatchSplitCommand, options: ProductionBatchRequestOptions = {}): Promise<ProductionBatchSplitReceipt> {
    return requestJson(`/v1/production-batches/${encodeURIComponent(batchId)}/split`, { ...options, method: 'POST', body: JSON.stringify(command) });
  },
  async completeProductionBatch(batchId: string, command: ProductionCompletionCommand, options: ProductionBatchRequestOptions = {}): Promise<ProductionCompletionReceipt> {
    return requestJson(`/v1/production-batches/${encodeURIComponent(batchId)}/complete-production`, { ...options, method: 'POST', body: JSON.stringify(command) });
  },
  async resumeProductionQcIssues(batchId: string, command: ProductionQcResumeCommand, options: ProductionBatchRequestOptions = {}): Promise<ProductionQcResumeReceipt> {
    return requestJson(`/v1/qc/production-batches/${encodeURIComponent(batchId)}/business-resume`, { ...options, method: 'POST', body: JSON.stringify(command) });
  },

  async getProductionStockReceipts(batchId: string, options: ProductionBatchRequestOptions = {}): Promise<ProductionStockReceiptAccount> {
    return requestJson(`/v1/production-batches/${encodeURIComponent(batchId)}/stock-receipts`, { ...options, method: 'GET' });
  },
  async receiveProductionBatchStock(batchId: string, command: ProductionStockReceiptCommand, options: ProductionBatchRequestOptions = {}): Promise<ProductionStockReceiptAck> {
    return requestJson(`/v1/production-batches/${encodeURIComponent(batchId)}/stock-receipts`, { ...options, method: 'POST', body: JSON.stringify(command) });
  },
  async getProductionStockReceiptWarehouses(options: ProductionBatchRequestOptions = {}): Promise<Warehouse[]> {
    const data = await requestJson<{ warehouses: Warehouse[] }>('/v1/inventory/warehouses', { ...options, method: 'GET' });
    if (!Array.isArray(data.warehouses)) throw Error('仓库回读不完整，请重新核对。');
    return data.warehouses;
  },

  async transitionOrderStatus(orderId: string, toStatus: string, operator: string, note?: string, endpoint?: string): Promise<Order> {
    const data = await requestJson<{ ok: boolean; order?: Order; error?: { message?: string } }>(`/v1/orders/${encodeURIComponent(orderId)}/status-transition`, {
      endpoint,
      method: 'POST',
      headers: jwtAuthHeaders(),
      body: JSON.stringify({ toStatus, operator, ...(note ? { note } : {}) }),
    });
    if (!data.ok || !data.order) throw new Error(data.error?.message || '状态变更失败');
    return data.order;
  },

  // ── G3-4 订单结案（绿）：业务员手动"确认结清"（复用现有核销，进度满后确认） ──
  async settleOrder(orderId: string, note?: string, endpoint?: string): Promise<Order> {
    const data = await requestJson<{ ok: boolean; order?: Order; error?: { message?: string } }>(`/v2/orders/${encodeURIComponent(orderId)}/settle`, {
      endpoint,
      method: 'POST',
      body: JSON.stringify(note ? { note } : {}),
    });
    if (!data.ok || !data.order) throw new Error((data as any).message || '确认结清失败');
    return data.order;
  },

  async deleteOrderRemote(orderId: string, endpoint?: string): Promise<Order> {
    const data = await requestJson<{ ok: boolean; order?: Order; error?: { message?: string } }>(`/v1/orders/${encodeURIComponent(orderId)}`, {
      endpoint,
      method: 'DELETE',
      headers: jwtAuthHeaders(),
    });
    if (!data.ok || !data.order) throw new Error(data.error?.message || '订单删除失败');
    return data.order;
  },

  // ── B1 直接取消订单（仅 Pending；设计真源 订单变更规则.md §2A.1「业务员可直接取消」）──
  // 与归档（deleteOrderRemote，高危角色门）不同：这是业务员日常动作，理由必填并留痕到订单时间线。
  async cancelOrder(orderId: string, reason: string, endpoint?: string): Promise<Order> {
    const data = await requestJson<{ ok: boolean; order?: Order; error?: { message?: string } }>(`/v1/orders/${encodeURIComponent(orderId)}/cancel`, {
      endpoint,
      method: 'POST',
      headers: jwtAuthHeaders(),
      body: JSON.stringify({ reason }),
    });
    if (!data.ok || !data.order) throw new Error(data.error?.message || '订单取消失败');
    return data.order;
  },

  /**
   * 订单主档字段就地更新 —— PUT /v1/orders/:id。
   *
   * ⚠️ 这里是 **PUT 不是 PATCH**：`server/src/orders/route.ts:425` 只注册了 PUT，
   * 尽管它是部分更新语义（先 `stripReadonly` 白名单过滤，再 `tx.order.update({data})`，
   * 未传字段保持原值），且会写 `fieldSources`/审计。用 PATCH 会直接 404（已实测）。
   * 白名单当前含 fabricSampleSentDate / fabricSampleConfirmedDate / fabricSampleTrackingNumber。
   *
   * T1 用途：出运资格面板登记 RC 匹头样的寄出/确认日期 —— 那是门禁 rc 条件读的真源。
   */
  async updateOrderFields(orderId: string, patch: Record<string, unknown>, endpoint?: string): Promise<Order> {
    const data = await requestJson<{ ok: boolean; order?: Order; error?: { message?: string } }>(`/v1/orders/${encodeURIComponent(orderId)}`, {
      endpoint,
      method: 'PUT',
      headers: jwtAuthHeaders(),
      body: JSON.stringify(patch),
    });
    if (!data.ok || !data.order) throw new Error(data.error?.message || '订单字段更新失败');
    return data.order;
  },

  async getOrderMainApprovalHistory(orderId: string, endpoint?: string): Promise<any[]> {
    const data = await requestJson<{ ok: boolean; items?: any[] }>(`/v2/orders/${encodeURIComponent(orderId)}/main-approvals`, { endpoint, method: 'GET' });
    if (data.ok !== true || !Array.isArray(data.items)) throw new Error('订单主单审批历史响应无效。');
    return data.items;
  },

  async submitOrderMainApproval(orderId: string, endpoint?: string): Promise<any> {
    const data = await requestJson<{ ok: boolean; item?: any; message?: string }>(`/v2/orders/${encodeURIComponent(orderId)}/submit-main-approval`, {
      endpoint, method: 'POST', body: JSON.stringify({}),
    });
    if (data.ok !== true || !data.item?.id || data.item.actionType !== 'order:main_approval') throw new Error(data.message || '订单主单审批提交回执无效。');
    return data.item;
  },

  async scanProductionAlerts(endpoint?: string): Promise<{ orderId: string; poNumber?: string; customer?: string; alertType: string; deadline: string; message: string; severity: 'critical' | 'high' | 'medium' | 'low' }[]> {
    const data = await requestJson<{ ok: boolean; alerts?: any[] }>('/v1/production/alerts/scan', { endpoint, method: 'GET' });
    return Array.isArray(data.alerts) ? data.alerts : [];
  },

  async listInvoices(endpoint?: string, params?: { limit?: number; offset?: number; search?: string }): Promise<Invoice[]> {
    const page = await this.listInvoicesPage(endpoint, params);
    return page.items;
  },

  /** 发票列表分页口径（/v1/finance 后端默认 50 截断，上限 200）：透传 limit/offset/search 并返回 total */
  async listInvoicesPage(endpoint?: string, params?: { limit?: number; offset?: number; search?: string }): Promise<{ items: Invoice[]; total: number }> {
    const query = new URLSearchParams();
    if (params?.limit != null) query.set('limit', String(params.limit));
    if (params?.offset != null) query.set('offset', String(params.offset));
    if (params?.search) query.set('search', params.search);
    const qs = query.toString();
    const data = await requestJson<{ items: Invoice[]; total: number }>(`/v1/finance${qs ? `?${qs}` : ''}`, { endpoint, method: 'GET' });
    const items = Array.isArray(data.items) ? data.items : [];
    return { items, total: typeof data.total === 'number' ? data.total : items.length };
  },

  /** DR：发票详情——GET /v1/finance/:id，附带发票↔订单多对多 orderAllocations（含订单号/PO 快照）+ 附件 */
  async getInvoice(id: string, endpoint?: string): Promise<Invoice & { orderAllocations?: InvoiceOrderAllocation[] }> {
    return requestJson<Invoice & { orderAllocations?: InvoiceOrderAllocation[] }>(
      `/v1/finance/${encodeURIComponent(id)}`,
      { endpoint, method: 'GET' },
    );
  },

  /** 导出发票 PDF——GET /v1/finance/:id/render.pdf，下载到本地（浏览器触发保存） */
  async renderInvoicePdf(id: string, endpoint?: string): Promise<void> {
    const url = buildApiUrl(`/v1/finance/${encodeURIComponent(id)}/render.pdf`, endpoint);
    const res = await fetch(url, { headers: this.getAuthHeaders() });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error?.message || data?.error?.code || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename="?([^";]+)"?/i);
    const filename = (m && m[1] ? m[1] : `invoice-${id}.pdf`).replace(/%[0-9A-F]{2}/gi, '');
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  },

  /** 发票预览 HTML——GET /v1/finance/:id/preview.html（与 render.pdf 同源渲染 + screen 页边距，所见即所得） */
  async getInvoicePreviewHtml(id: string, endpoint?: string): Promise<string> {
    const url = buildApiUrl(`/v1/finance/${encodeURIComponent(id)}/preview.html`, endpoint);
    const res = await fetch(url, { headers: this.getAuthHeaders() });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error?.message || data?.error?.code || `HTTP ${res.status}`);
    }
    return res.text();
  },

  async invoiceAttachmentFileHash(file: File): Promise<string> {
    return attachmentHash(await file.arrayBuffer());
  },

  /** One explicit intent keeps its key until the immutable receipt is checked. */
  async uploadInvoiceAttachment(id: string, file: File, endpoint?: string, clientRequestId?: string): Promise<InvoiceAttachmentAck> {
    const key=clientRequestId??crypto.randomUUID();
    if(!attachmentText(id)||!attachmentUuid(key))throw Error('归档编号或原发票无效，请重新核对。');
    return attachmentRequest(endpoint,true,async current=>{
      const actorId=getAuthState().user!.id;
      const sha256=await attachmentHash(await file.arrayBuffer());current();
      const expectedHash=await attachmentHash(new TextEncoder().encode(JSON.stringify({operation:'register_invoice_attachment',actorId,invoiceId:id,clientRequestId:key,sha256,fileName:file.name,mimeType:file.type||'application/octet-stream',fileSize:file.size})).buffer as ArrayBuffer);current();
      const formData=new FormData();formData.append('file',file);
      const headers:Record<string,string>={...this.getAuthHeaders(),'X-Invoice-Attachment-Key':key,'X-Invoice-Attachment-Name':encodeURIComponent(file.name)};
      for(const name of Object.keys(headers))if(name.toLowerCase()==='content-type')delete headers[name];
      const response=await fetch(buildApiUrl(`/v1/finance/${encodeURIComponent(id)}/attachments`,endpoint),{method:'POST',headers,body:formData});current();
      const data=await response.json();current();
      if(!response.ok)throw Error(data?.error?.message||'归档结果未确认，请核对本次归档。');
      const ack=checkedInvoiceAttachmentAck(data,id,key,actorId);
      if(ack.receipt.commandHash!==expectedHash||ack.attachment.sha256!==sha256||ack.attachment.fileName!==file.name||ack.attachment.fileSize!==file.size)
        throw Error('归档内容与原文件不一致，请核对本次归档。');
      return ack;
    });
  },
  async getInvoiceAttachmentReceipt(id: string, clientRequestId: string, endpoint?: string): Promise<InvoiceAttachmentAck> {
    if(!attachmentText(id)||!attachmentUuid(clientRequestId))throw Error('归档编号或原发票无效，请重新核对。');
    return attachmentRequest(endpoint,false,async current=>{
      const actorId=getAuthState().user!.id;
      const response=await fetch(buildApiUrl(`/v1/finance/${encodeURIComponent(id)}/attachments/receipts/${clientRequestId}`,endpoint),{headers:this.getAuthHeaders()});current();
      const data=await response.json();current();
      if(!response.ok)throw Error(data?.error?.message||'本次归档尚未确认，请稍后核对；勿重复上传。');
      const ack=checkedInvoiceAttachmentAck(data,id,clientRequestId,actorId),a=ack.attachment;
      const expectedHash=await attachmentHash(new TextEncoder().encode(JSON.stringify({operation:'register_invoice_attachment',actorId,invoiceId:id,clientRequestId,sha256:a.sha256,fileName:a.fileName,mimeType:a.mimeType,fileSize:a.fileSize})).buffer as ArrayBuffer);current();
      if(ack.receipt.commandHash!==expectedHash)throw Error('原归档回执与文件记录无法核对，请联系管理员。');
      return ack;
    });
  },
  async downloadInvoiceAttachment(id:string,attachment:InvoiceAttachment,endpoint?:string):Promise<Blob> {
    if(!attachmentText(id)||!isNativeInvoiceAttachment(attachment))throw Error('该历史附件缺少原生归档凭据，请核对后重新原生上传。');
    return attachmentRequest(endpoint,false,async current=>{
      // The current invoice ID, not a stored arbitrary URL, selects the gate.
      const response=await fetch(buildApiUrl(`/v1/finance/${encodeURIComponent(id)}/attachments/${attachment.fileId}/download`,endpoint),{headers:this.getAuthHeaders()});current();
      if(!response.ok)throw Error('附件下载未确认，请核对原归档或当前权限。');
      const blob=await response.blob();current();
      if(blob.size!==attachment.fileSize||await attachmentHash(await blob.arrayBuffer())!==attachment.sha256)throw Error('原归档内容无法核对，请联系管理员。');current();
      return blob;
    });
  },

  /** 创建发票——POST /v1/finance，支持 orderIds[] 多订单分配 */
  async createInvoice(input: InvoiceWriteInput, endpoint?: string): Promise<Invoice> {
    return requestJson<Invoice>('/v1/finance', { endpoint, method: 'POST', body: JSON.stringify(input) });
  },

  /** 更新发票——PATCH /v1/finance/:id，orderIds[] 时后端按 replace 语义全量重写分配 */
  async updateInvoice(id: string, input: InvoiceWriteInput, endpoint?: string): Promise<Invoice> {
    return requestJson<Invoice>(`/v1/finance/${encodeURIComponent(id)}`, { endpoint, method: 'PATCH', body: JSON.stringify(input) });
  },

  async listPaymentVouchers(endpoint?: string, params?: { limit?: number; offset?: number; search?: string }): Promise<PaymentVoucher[]> {
    const page = await this.listPaymentVouchersPage(endpoint, params);
    return page.items;
  },

  /** 付款凭证列表分页口径（/v1/finance/vouchers 后端默认 50 截断，上限 200）：透传 limit/offset/search 并返回 total */
  async listPaymentVouchersPage(endpoint?: string, params?: { limit?: number; offset?: number; search?: string }): Promise<{ items: PaymentVoucher[]; total: number }> {
    const query = new URLSearchParams();
    if (params?.limit != null) query.set('limit', String(params.limit));
    if (params?.offset != null) query.set('offset', String(params.offset));
    if (params?.search) query.set('search', params.search);
    const qs = query.toString();
    const data = await requestJson<{ items: PaymentVoucher[]; total: number }>(`/v1/finance/vouchers${qs ? `?${qs}` : ''}`, { endpoint, method: 'GET' });
    const items = Array.isArray(data.items) ? data.items : [];
    return { items, total: typeof data.total === 'number' ? data.total : items.length };
  },

  // ── Phase B2: 财务报表 API（账龄 / 对账单 / 汇率损益，只读）──
  async getAgingReport(type: 'Receivable' | 'Payable', asOf?: string, endpoint?: string): Promise<AgingReport> {
    const query = new URLSearchParams({ type });
    if (asOf) query.set('asOf', asOf);
    return requestJson<AgingReport>(`/v1/finance/reports/aging?${query.toString()}`, { endpoint, method: 'GET' });
  },

  /** REQ2-02 资金日历与 30 天现金流预测（DR-044 净额口径） */
  async getCashCalendar(params: { asOf?: string; days?: number } = {}, endpoint?: string): Promise<CashCalendarReport> {
    const query = new URLSearchParams();
    if (params.asOf) query.set('asOf', params.asOf);
    if (params.days) query.set('days', String(params.days));
    const qs = query.toString();
    return requestJson<CashCalendarReport>(`/v1/finance/reports/cash-calendar${qs ? `?${qs}` : ''}`, { endpoint, method: 'GET' });
  },

  async getCustomerStatement(params: { customerRelationId: string; from?: string; to?: string }, endpoint?: string): Promise<CustomerStatement> {
    const query = new URLSearchParams({ customerRelationId: params.customerRelationId });
    if (params.from) query.set('from', params.from);
    if (params.to) query.set('to', params.to);
    return requestJson<CustomerStatement>(`/v1/finance/reports/statement?${query.toString()}`, { endpoint, method: 'GET' });
  },

  async getSupplierStatement(params: { supplierRelationId: string; from?: string; to?: string }, endpoint?: string): Promise<SupplierStatement> {
    const query = new URLSearchParams({ supplierRelationId: params.supplierRelationId });
    if (params.from) query.set('from', params.from);
    if (params.to) query.set('to', params.to);
    return requestJson<SupplierStatement>(`/v1/finance/reports/supplier-statement?${query.toString()}`, { endpoint, method: 'GET' });
  },

  /** 客户对账单 A4 预览——GET /v1/finance/reports/statement/preview.html（B9：STMT 服务端模板） */
  async getStatementPreviewHtml(params: { customerRelationId: string; from?: string; to?: string }, endpoint?: string): Promise<string> {
    const query = new URLSearchParams({ customerRelationId: params.customerRelationId });
    if (params.from) query.set('from', params.from);
    if (params.to) query.set('to', params.to);
    const url = buildApiUrl(`/v1/finance/reports/statement/preview.html?${query.toString()}`, endpoint);
    const res = await fetch(url, { headers: this.getAuthHeaders() });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
    }
    return res.text();
  },

  /** 客户对账单 Excel 导出——GET /v1/finance/reports/statement?format=xlsx（B9：多币种分节 sheet） */
  async exportCustomerStatementXlsx(params: { customerRelationId: string; from?: string; to?: string }, endpoint?: string): Promise<void> {
    const query = new URLSearchParams({ customerRelationId: params.customerRelationId, format: 'xlsx' });
    if (params.from) query.set('from', params.from);
    if (params.to) query.set('to', params.to);
    const url = buildApiUrl(`/v1/finance/reports/statement?${query.toString()}`, endpoint);
    const res = await fetch(url, { headers: this.getAuthHeaders() });
    if (!res.ok) throw new Error(`客户对账单导出失败：HTTP ${res.status}`);
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
    const filename = m && m[1] ? decodeURIComponent(m[1]) : `客户对账单_${businessNowDate().toISOString().slice(0, 10)}.xlsx`;
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  },

  /** 供应商对账单 Excel 导出——GET /v1/finance/reports/supplier-statement?format=xlsx */
  async exportSupplierStatementXlsx(params: { supplierRelationId: string; from?: string; to?: string }, endpoint?: string): Promise<void> {
    const query = new URLSearchParams({ supplierRelationId: params.supplierRelationId, format: 'xlsx' });
    if (params.from) query.set('from', params.from);
    if (params.to) query.set('to', params.to);
    const url = buildApiUrl(`/v1/finance/reports/supplier-statement?${query.toString()}`, endpoint);
    const res = await fetch(url, { headers: this.getAuthHeaders() });
    if (!res.ok) throw new Error(`供应商对账单导出失败：HTTP ${res.status}`);
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
    const filename = m && m[1] ? decodeURIComponent(m[1]) : `供应商对账单_${businessNowDate().toISOString().slice(0, 10)}.xlsx`;
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  },

  /** 账龄分析 Excel 导出——GET /v1/finance/reports/aging?format=xlsx */
  async exportAgingReportXlsx(type: 'Receivable' | 'Payable', asOf?: string, endpoint?: string): Promise<void> {
    const query = new URLSearchParams({ type, format: 'xlsx' });
    if (asOf) query.set('asOf', asOf);
    const url = buildApiUrl(`/v1/finance/reports/aging?${query.toString()}`, endpoint);
    const res = await fetch(url, { headers: this.getAuthHeaders() });
    if (!res.ok) throw new Error(`账龄分析导出失败：HTTP ${res.status}`);
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
    const filename = m && m[1] ? decodeURIComponent(m[1]) : `账龄分析_${businessNowDate().toISOString().slice(0, 10)}.xlsx`;
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  },

  async getFxGainLoss(params?: { from?: string; to?: string }, endpoint?: string): Promise<FxGainLossReport> {
    const query = new URLSearchParams();
    if (params?.from) query.set('from', params.from);
    if (params?.to) query.set('to', params.to);
    const qs = query.toString();
    return requestJson<FxGainLossReport>(`/v1/finance/reports/fx-gain-loss${qs ? '?' + qs : ''}`, { endpoint, method: 'GET' });
  },

  // ── REQ2-08 催款函套件（DR-050：中英函生成 / 登记留痕 / 历史）+ P0-2 分级状态机 ──
  async buildDunningLetter(params: {
    customerRelationId?: string;
    customerName?: string;
    currency: string;
    asOf?: string;
    stage?: DunningStage; // P0-2：分级档位（缺省按「DunningProfile 钉住 × 账龄自动定级」合成）
  }, endpoint?: string): Promise<DunningLetter> {
    return requestJson<DunningLetter>('/v1/finance/dunning/letter', {
      endpoint,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
  },

  async recordDunning(params: {
    customerRelationId?: string;
    customerName: string;
    currency: string;
    totalOverdue: number;
    invoiceCount: number;
    agingBuckets?: Record<string, number>;
    channel: DunningChannel;
    result: DunningResultStatus;
    stage?: DunningStage; // P0-2：分级快照（记录发生时的档位）
    note?: string;
    operator?: string;
  }, endpoint?: string): Promise<DunningRecord> {
    const data = await requestJson<{ ok: boolean; record?: DunningRecord; error?: { code?: string; message?: string } }>(
      '/v1/finance/dunning',
      {
        endpoint,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      },
    );
    if (!data.ok || !data.record) throw new Error(data.error?.message || '催款记录登记失败');
    return data.record;
  },

  /** P0-2 分级看板：账龄行 × P0-1 尾款喂入 × 生效分级（只读） */
  async getDunningStageBoard(params?: { asOf?: string }, endpoint?: string): Promise<DunningStageBoard> {
    const query = new URLSearchParams();
    if (params?.asOf) query.set('asOf', params.asOf);
    const qs = query.toString();
    return requestJson<DunningStageBoard>(`/v1/finance/dunning/stages${qs ? '?' + qs : ''}`, { endpoint, method: 'GET' });
  },

  /** P0-2 人工升降级（留痕 routeAudit；stage='none' 解除钉住回退自动定级） */
  async setDunningStageManual(params: {
    customerRelationId?: string | null;
    customerName: string;
    currency: string;
    stage: DunningStage;
    reason?: string;
    ownerName?: string | null;
  }, endpoint?: string): Promise<void> {
    const data = await requestJson<{ ok?: boolean; error?: { code?: string; message?: string } }>(
      '/v1/finance/dunning/stages/manual',
      {
        endpoint,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      },
    );
    if ((data as any).ok === false || data.error) throw new Error(data.error?.message || '催款分级调整失败');
  },

  async listDunningHistory(params: { customerRelationId?: string; customerName?: string; limit?: number } = {}, endpoint?: string): Promise<DunningRecord[]> {
    const query = new URLSearchParams();
    if (params.customerRelationId) query.set('customerRelationId', params.customerRelationId);
    else if (params.customerName) query.set('customerName', params.customerName);
    if (params.limit) query.set('limit', String(params.limit));
    const qs = query.toString();
    const data = await requestJson<{ items: DunningRecord[] }>(`/v1/finance/dunning${qs ? '?' + qs : ''}`, { endpoint, method: 'GET' });
    return Array.isArray(data.items) ? data.items : [];
  },

  // ── Phase C1: 经营驾驶舱 API（只读聚合）──
  async getBusinessCockpit(params?: { from?: string; to?: string; marginRowLimit?: number }, endpoint?: string): Promise<BusinessCockpit> {
    const query = new URLSearchParams();
    if (params?.from) query.set('from', params.from);
    if (params?.to) query.set('to', params.to);
    if (params?.marginRowLimit) query.set('marginRowLimit', String(params.marginRowLimit));
    const qs = query.toString();
    return requestJson<BusinessCockpit>(`/v1/dashboard/cockpit${qs ? '?' + qs : ''}`, { endpoint, method: 'GET' });
  },

  async listShipments(endpoint?: string, params?: { limit?: number; offset?: number; search?: string; customerRelationId?: string }): Promise<Shipment[]> {
    const page = await this.listShipmentsPage(endpoint, params);
    return page.items;
  },

  /** 运单列表分页口径（/v1/shipping 后端默认 50 截断，上限 200）：透传 limit/offset/search/customerRelationId 并返回 total */
  async listShipmentsPage(endpoint?: string, params?: { limit?: number; offset?: number; search?: string; customerRelationId?: string }): Promise<{ items: Shipment[]; total: number }> {
    const query = new URLSearchParams();
    if (params?.limit != null) query.set('limit', String(params.limit));
    if (params?.offset != null) query.set('offset', String(params.offset));
    if (params?.search) query.set('search', params.search);
    if (params?.customerRelationId) query.set('customerRelationId', params.customerRelationId);
    const qs = query.toString();
    const data = await requestJson<{ items: Shipment[]; total: number }>(`/v1/shipping${qs ? `?${qs}` : ''}`, { endpoint, method: 'GET' });
    const items = Array.isArray(data.items) ? data.items : [];
    return { items, total: typeof data.total === 'number' ? data.total : items.length };
  },

  /** 出运制单数据装配（CI/PL/CO/BL 成套生成数据源，只读） */
  async getShipmentDocumentSet(shipmentId: string, endpoint?: string): Promise<SourceDocumentSetData> {
    const data = await requestJson<unknown>(`/v1/shipping/${encodeURIComponent(shipmentId)}/document-set`, { endpoint, method: 'GET' });
    return parseSourceDocumentSet(data, shipmentId);
  },

  async getShipmentCiSources(shipmentId: string, endpoint?: string): Promise<ShipmentCiSources> {
    const data = await requestJson<unknown>(`/v1/shipping/${encodeURIComponent(shipmentId)}/ci-sources`, { endpoint, method: 'GET' });
    return parseShipmentCiSources(data, shipmentId);
  },

  /** 阶段 D / D6：实体级审计历史（模块读权限门禁，最近 20 条倒序） */
  async getEntityAuditLogs(targetType: string, targetId: string, endpoint?: string): Promise<EntityAuditLogItem[]> {
    const query = new URLSearchParams({ targetType, targetId });
    const data = await requestJson<{ ok: boolean; logs: EntityAuditLogItem[] }>(`/v1/audit/entity?${query.toString()}`, { endpoint, method: 'GET' });
    return Array.isArray(data.logs) ? data.logs : [];
  },

  /** G4.3：变更史导出（CSV）—— GET /v1/audit/entity/export（与查询同门禁；后端只读，不写审计） */
  async exportEntityAuditLogsCsv(targetType: string, targetId: string, endpoint?: string): Promise<void> {
    const query = new URLSearchParams({ targetType, targetId });
    const res = await fetch(buildApiUrl(`/v1/audit/entity/export?${query.toString()}`, endpoint), { headers: this.getAuthHeaders() });
    if (!res.ok) {
      // 403 与其余失败分开说清：前者是"这个角色不能看/导出该实体的变更史"，别让它显示成网络错误
      if (res.status === 403) {
        throw Object.assign(new Error('当前角色无权限导出该条记录的变更史'), { status: 403 });
      }
      throw new Error(`变更史导出失败：HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
    const filename = m && m[1] ? decodeURIComponent(m[1]) : `变更史-${targetType}.csv`;
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  },

  // ── Phase 2: 报价管理 API ──
  async listQuotations(params?: { status?: string; customerRelationId?: string; search?: string; limit?: number; offset?: number }, endpoint?: string): Promise<{ items: Quotation[]; total: number }> {
    const query = new URLSearchParams();
    if (params?.status) query.set('status', params.status);
    if (params?.customerRelationId) query.set('customerRelationId', params.customerRelationId);
    if (params?.search) query.set('search', params.search);
    if (params?.limit != null) query.set('limit', String(params.limit));
    if (params?.offset != null) query.set('offset', String(params.offset));
    const qs = query.toString();
    const path = `/v1/quotations${qs ? '?' + qs : ''}`;
    return requestJson<{ items: Quotation[]; total: number }>(path, { endpoint, method: 'GET' });
  },

  async getQuotation(id: string, endpoint?: string): Promise<Quotation | null> {
    try {
      const data = await requestJson<{ quotation: Quotation }>(`/v1/quotations/${encodeURIComponent(id)}`, { endpoint, method: 'GET' });
      return data.quotation;
    } catch { return null; }
  },

  async createQuotation(input: QuotationInput, endpoint?: string): Promise<Quotation> {
    const data = await requestJson<{ quotation: Quotation }>('/v1/quotations', { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.quotation;
  },

  async updateQuotation(id: string, input: Partial<QuotationInput>, endpoint?: string): Promise<Quotation> {
    const data = await requestJson<{ quotation: Quotation }>(`/v1/quotations/${encodeURIComponent(id)}`, { endpoint, method: 'PUT', body: JSON.stringify(input) });
    return data.quotation;
  },

  async deleteQuotation(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/quotations/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },

  /** REQ2-12 报价行图片上传（面料照片/色卡图 → /api/v1/quotations/line-image/... scoped URL） */
  async uploadQuotationLineImage(file: File, endpoint?: string): Promise<string> {
    const form = new FormData();
    form.append('file', file);
    const data = await requestJson<{ ok: boolean; url: string }>('/v1/quotations/line-image', {
      endpoint, method: 'POST', body: form,
    });
    return data.url;
  },

  /**
   * P0-3 报价行图片安全加载：返回可直接用于 `<img>` 的 URL。
   * - `/api/v1/quotations/line-image/...`（新 scoped 端点）与历史 `/api/uploads/quotations/...`
   *   （静态直读已 fail-closed 404）→ 经 fetch(Bearer) → blob URL——浏览器 `<img>` 无法带
   *   Authorization 头，只能走 blob 通道；无凭证/加载失败返回 null（占位消失）。
   * - 其余（产品档案主图等公共静态 / 外链）原样返回，零改动。
   */
  async loadQuotationLineImageSrc(url: string | null | undefined, endpoint?: string): Promise<string | null> {
    if (!url) return null;
    const scoped = '/api/v1/quotations/line-image/';
    const legacy = '/api/uploads/quotations/';
    let targetPath: string | null = null;
    if (url.startsWith(scoped)) targetPath = url;
    else if (url.startsWith(legacy)) targetPath = `${scoped}${encodeURIComponent(url.slice(legacy.length))}`;
    if (!targetPath) return url; // 公共静态 / 外链直接展示
    try {
      const res = await fetch(buildApiUrl(targetPath, endpoint), {
        headers: jwtAuthHeaders(),
        credentials: 'omit',
      });
      if (!res.ok) return null;
      const blob = await res.blob();
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  },

  async sendQuotation(id: string, endpoint?: string): Promise<Quotation> {
    const data = await requestJson<{ quotation: Quotation }>(`/v1/quotations/${encodeURIComponent(id)}/send`, { endpoint, method: 'POST' });
    return data.quotation;
  },

  async acceptQuotation(id: string, note?: string, endpoint?: string): Promise<Quotation> {
    const data = await requestJson<{ quotation: Quotation }>(`/v1/quotations/${encodeURIComponent(id)}/accept`, { endpoint, method: 'POST', body: JSON.stringify({ note }) });
    return data.quotation;
  },

  async rejectQuotation(id: string, note?: string, endpoint?: string): Promise<Quotation> {
    const data = await requestJson<{ quotation: Quotation }>(`/v1/quotations/${encodeURIComponent(id)}/reject`, { endpoint, method: 'POST', body: JSON.stringify({ note }) });
    return data.quotation;
  },

  // ── REQ2-19（DR-060）：砍价画像与版本对比 ──
  /** 显式修订（砍价重报：快照当前版 + version+1 + 回 Draft 可编辑重发） */
  async reviseQuotation(id: string, changeReason?: string, endpoint?: string): Promise<Quotation> {
    const data = await requestJson<{ quotation: Quotation }>(`/v1/quotations/${encodeURIComponent(id)}/revise`, { endpoint, method: 'POST', body: JSON.stringify({ changeReason }) });
    return data.quotation;
  },

  /** 版本历史（append-only 正序） */
  async listQuotationVersions(id: string, endpoint?: string): Promise<Array<{ id: string; version: number; totalAmount: number; currency?: string; changeReason?: string | null; changedBy?: string | null; createdAt: number; linesSnapshot?: Array<{ unitPrice: number; quantity: number; amount: number }> }>> {
    const data = await requestJson<{ versions: any[] }>(`/v1/quotations/${encodeURIComponent(id)}/versions`, { endpoint });
    return data.versions ?? [];
  },

  /** 客户砍价画像（首报偏差统计） */
  async getQuotationPriceProfile(relationId: string, endpoint?: string): Promise<{
    relationId: string;
    items: Array<{ quotationId: string; quotationNumber: string; status: string; currency: string; version: number; rounds: number; firstAmount: number; currentAmount: number; cutPct: number | null; issueDate: string; convertedOrderId: string | null; orderPo: string | null; orderDealAmount: number | null; dealDeviationPct: number | null }>;
    summary: { quotationCount: number; negotiatedCount: number; avgCutPct: number; maxCutPct: number; dealtCount: number; avgDealDeviationPct: number | null } | null;
  }> {
    return requestJson(`/v1/quotations/price-profile?relationId=${encodeURIComponent(relationId)}`, { endpoint });
  },

  async convertQuotationToOrder(id: string, overrides?: { poNumber?: string; millName?: string; type?: string; dueDate?: string; paymentInstrument?: string }, endpoint?: string): Promise<{ orderId: string; quotation: Quotation }> {
    const data = await requestJson<{ orderId: string; quotation: Quotation }>(`/v1/quotations/${encodeURIComponent(id)}/convert-to-order`, {
      endpoint,
      method: 'POST',
      body: JSON.stringify(overrides || {}),
    });
    return data;
  },

  // ── 报价审批层级（2026-09：条目级申请 / 总价申请含合并规则 / 状态） ──
  /** 业务员申请某条目报价审批 */
  async requestQuotationLineApproval(id: string, lineId: string, endpoint?: string): Promise<{ approvalId: string; lineId: string }> {
    const data = await requestJson<{ data: { approvalId: string; lineId: string } }>(`/v1/quotations/${encodeURIComponent(id)}/lines/${encodeURIComponent(lineId)}/request-approval`, { endpoint, method: 'POST' });
    return data.data;
  },
  /** 申请总价报价审批（合并规则：全条已批→默认全批；有未批→连带提示） */
  async requestQuotationTotalApproval(id: string, endpoint?: string): Promise<{ autoApproved: boolean; totalStatus: string; totalApprovalId: string | null; lineStatuses: Array<{ lineId: string; lineNumber: number; status: string }> }> {
    const data = await requestJson<{ data: { autoApproved: boolean; totalStatus: string; totalApprovalId: string | null; lineStatuses: Array<{ lineId: string; lineNumber: number; status: string }> } }>(`/v1/quotations/${encodeURIComponent(id)}/request-total-approval`, { endpoint, method: 'POST' });
    return data.data;
  },
  /** 查询报价单各条目审批态 + 总价态 */
  async getQuotationApprovalStatus(id: string, endpoint?: string): Promise<{ quotationId: string; lineStatuses: Array<{ lineId: string; lineNumber: number; status: string }>; totalApproval: { id: string; status: string } | null; autoApproved: boolean; totalStatus: string }> {
    const data = await requestJson<{ data: { quotationId: string; lineStatuses: Array<{ lineId: string; lineNumber: number; status: string }>; totalApproval: { id: string; status: string } | null; autoApproved: boolean; totalStatus: string } }>(`/v1/quotations/${encodeURIComponent(id)}/approval-status`, { endpoint });
    return data.data;
  },

  // ── 阶段 P3c：历史报价导入（PRD 16.1；preview 只校验，commit 导入合法行）──
  async importHistoricalQuotations(rows: HistoricalQuotationImportRow[], mode: 'preview' | 'commit', endpoint?: string): Promise<QuotationImportResult> {
    return requestJson<QuotationImportResult>('/v1/quotations/import', {
      endpoint,
      method: 'POST',
      body: JSON.stringify({ rows, mode }),
      // commit 模式逐行落库（历史报价批量导入可能数百行），放宽超时；preview 只解析用默认值
      timeoutMs: mode === 'commit' ? 120_000 : 30_000,
    });
  },

  // ── Phase 2 B1: 采购管理 API ──
  async listPurchaseOrders(params?: { status?: string; supplierRelationId?: string; dateFrom?: string; dateTo?: string; search?: string; limit?: number; offset?: number }, endpoint?: string): Promise<{ items: PurchaseOrder[]; total: number }> {
    const query = new URLSearchParams();
    if (params?.status) query.set('status', params.status);
    if (params?.supplierRelationId) query.set('supplierRelationId', params.supplierRelationId);
    if (params?.dateFrom) query.set('dateFrom', params.dateFrom);
    if (params?.dateTo) query.set('dateTo', params.dateTo);
    if (params?.search) query.set('search', params.search);
    if (params?.limit != null) query.set('limit', String(params.limit));
    if (params?.offset != null) query.set('offset', String(params.offset));
    const qs = query.toString();
    const path = `/v1/procurement${qs ? '?' + qs : ''}`;
    return requestJson<{ items: PurchaseOrder[]; total: number }>(path, { endpoint, method: 'GET' });
  },

  async getPurchaseOrder(id: string, endpoint?: string): Promise<PurchaseOrder | null> {
    try {
      const data = await requestJson<{ purchaseOrder: PurchaseOrder }>(`/v1/procurement/${encodeURIComponent(id)}`, { endpoint, method: 'GET' });
      return data.purchaseOrder;
    } catch { return null; }
  },

  async createPurchaseOrder(input: PurchaseOrderInput, endpoint?: string): Promise<PurchaseOrder> {
    const data = await requestJson<{ purchaseOrder: PurchaseOrder }>('/v1/procurement', { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.purchaseOrder;
  },

  async updatePurchaseOrder(id: string, input: Partial<PurchaseOrderInput>, endpoint?: string): Promise<PurchaseOrder> {
    const data = await requestJson<{ purchaseOrder: PurchaseOrder }>(`/v1/procurement/${encodeURIComponent(id)}`, { endpoint, method: 'PUT', body: JSON.stringify(input) });
    return data.purchaseOrder;
  },

  async deletePurchaseOrder(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/procurement/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },

  async sendPurchaseOrder(id: string, endpoint?: string): Promise<PurchaseOrder> {
    const data = await requestJson<{ purchaseOrder: PurchaseOrder }>(`/v1/procurement/${encodeURIComponent(id)}/send`, { endpoint, method: 'POST' });
    return data.purchaseOrder;
  },

  async confirmPurchaseOrder(id: string, endpoint?: string): Promise<PurchaseOrder> {
    const data = await requestJson<{ purchaseOrder: PurchaseOrder }>(`/v1/procurement/${encodeURIComponent(id)}/confirm`, { endpoint, method: 'POST' });
    return data.purchaseOrder;
  },

  async cancelPurchaseOrder(id: string, reason?: string, endpoint?: string): Promise<PurchaseOrder> {
    const data = await requestJson<{ purchaseOrder: PurchaseOrder }>(`/v1/procurement/${encodeURIComponent(id)}/cancel`, { endpoint, method: 'POST', body: JSON.stringify({ reason }) });
    return data.purchaseOrder;
  },

  async closePurchaseOrder(id: string, endpoint?: string): Promise<PurchaseOrder> {
    const data = await requestJson<{ purchaseOrder: PurchaseOrder }>(`/v1/procurement/${encodeURIComponent(id)}/close`, { endpoint, method: 'POST' });
    return data.purchaseOrder;
  },

  // ── B2 运营域单据：采购 PO 文档（服务端模板真源，单据中心统一归档） ──

  /** PO 预览 HTML——GET /v1/procurement/:id/preview.html（服务端模板实时装配渲染，与生成 PDF 同源排版） */
  async getPurchaseOrderPreviewHtml(id: string, endpoint?: string): Promise<string> {
    const url = buildApiUrl(`/v1/procurement/${encodeURIComponent(id)}/preview.html`, endpoint);
    const res = await fetch(url, { headers: this.getAuthHeaders() });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    return res.text();
  },

  /** PO 生成文档——POST /v1/procurement/:id/generate-document（登记域单据 domain=procurement +
   *  服务端渲染 PDF 落盘归档），生成后浏览器下载归档文件（经鉴权下载端点，见 downloadTradeDocumentArchive） */
  async generatePurchaseOrderDocument(id: string, endpoint?: string): Promise<{ documentNumber: string; fileName: string; fileSize: number }> {
    const data = await requestJson<{ document: { documentId: string; documentNumber: string }; file: { filePath: string; fileName: string; fileSize: number } }>(
      `/v1/procurement/${encodeURIComponent(id)}/generate-document`, { endpoint, method: 'POST' });
    await this.downloadTradeDocumentArchive(data.document.documentId, data.file.fileName, endpoint);
    return { documentNumber: data.document.documentNumber, fileName: data.file.fileName, fileSize: data.file.fileSize };
  },

  /** 报价单服务端模板预览——GET /v1/quotations/:id/preview.html（B7：与生成 PDF 同源排版） */
  async getQuotationPreviewHtml(id: string, endpoint?: string, version?: number): Promise<string> {
    const url = buildApiUrl(`/v1/quotations/${encodeURIComponent(id)}${version === undefined ? '' : `/versions/${version}`}/preview.html`, endpoint);
    const res = await fetch(url, { headers: this.getAuthHeaders() });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    return res.text();
  },

  /** 报价单生成文档——POST /v1/quotations/:id/generate-document（B7：登记域单据 domain=quotation +
   *  服务端渲染 PDF 落盘归档），生成后浏览器下载归档文件（经鉴权下载端点） */
  async generateQuotationDocument(id: string, endpoint?: string): Promise<{ documentNumber: string; fileName: string; fileSize: number }> {
    const data = await requestJson<{ document: { documentId: string; documentNumber: string }; file: { filePath: string; fileName: string; fileSize: number } }>(
      `/v1/quotations/${encodeURIComponent(id)}/generate-document`, { endpoint, method: 'POST' });
    await this.downloadTradeDocumentArchive(data.document.documentId, data.file.fileName, endpoint);
    return { documentNumber: data.document.documentNumber, fileName: data.file.fileName, fileSize: data.file.fileSize };
  },

  /** 订单确认书服务端模板预览——GET /v2/orders/:id/preview.html（B8：与生成 PDF 同源排版） */
  async getOrderConfirmationPreviewHtml(id: string, endpoint?: string): Promise<string> {
    const url = buildApiUrl(`/v2/orders/${encodeURIComponent(id)}/preview.html`, endpoint);
    const res = await fetch(url, { headers: this.getAuthHeaders() });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
    }
    return res.text();
  },

  /**
   * §10.3-9 电子签：订单确认书「提交签署」——POST /v2/orders/:id/request-sign。
   * 建 `order:confirmation_sign` 审批（DR-007 解析审批人）→ 审批中心「阅览并签署」→
   * 阅至文末点签字确认 → 一步完成盖章 + 批准。
   */
  async requestOrderConfirmationSign(id: string, endpoint?: string): Promise<{ approvalId: string; status: string }> {
    const data = await requestJson<{ approvalId: string; status: string }>(
      `/v2/orders/${encodeURIComponent(id)}/request-sign`, { endpoint, method: 'POST' });
    return { approvalId: data.approvalId, status: data.status };
  },

  /** 订单确认书生成文档——POST /v2/orders/:id/generate-document（B8：登记域单据 domain=orders +
   *  服务端渲染 PDF 落盘归档），生成后浏览器下载归档文件（经鉴权下载端点） */
  async generateOrderConfirmationDocument(id: string, endpoint?: string): Promise<{ documentNumber: string; fileName: string; fileSize: number }> {
    const data = await requestJson<{ document: { documentId: string; documentNumber: string }; file: { filePath: string; fileName: string; fileSize: number } }>(
      `/v2/orders/${encodeURIComponent(id)}/generate-document`, { endpoint, method: 'POST' });
    await this.downloadTradeDocumentArchive(data.document.documentId, data.file.fileName, endpoint);
    return { documentNumber: data.document.documentNumber, fileName: data.file.fileName, fileSize: data.file.fileSize };
  },

  /** 采购台账 Excel 导出——GET /v1/procurement?format=xlsx（当前筛选条件全量导出） */
  async exportPurchaseOrdersXlsx(params?: { status?: string; supplierRelationId?: string; dateFrom?: string; dateTo?: string; search?: string }, endpoint?: string): Promise<void> {
    const query = new URLSearchParams({ format: 'xlsx' });
    if (params?.status) query.set('status', params.status);
    if (params?.supplierRelationId) query.set('supplierRelationId', params.supplierRelationId);
    if (params?.dateFrom) query.set('dateFrom', params.dateFrom);
    if (params?.dateTo) query.set('dateTo', params.dateTo);
    if (params?.search) query.set('search', params.search);
    const url = buildApiUrl(`/v1/procurement?${query.toString()}`, endpoint);
    const res = await fetch(url, { headers: this.getAuthHeaders() });
    if (!res.ok) throw new Error(`采购台账导出失败：HTTP ${res.status}`);
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
    const filename = m && m[1] ? decodeURIComponent(m[1]) : `采购台账_${businessNowDate().toISOString().slice(0, 10)}.xlsx`;
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  },

  /** 订单台账 Excel 导出——GET /v2/orders?format=xlsx（当前筛选条件全量导出） */
  async exportOrdersXlsx(params?: { ledgerView?: 'orders' | 'items'; status?: string; type?: string; ownerId?: string; departmentId?: string; customerCode?: string; customerRelationId?: string; businessLine?: string; search?: string }, endpoint?: string): Promise<void> {
    const query = new URLSearchParams({ format: 'xlsx' });
    if (params?.ledgerView) query.set('ledgerView', params.ledgerView);
    if (params?.status) query.set('status', params.status);
    if (params?.type) query.set('type', params.type);
    if (params?.ownerId) query.set('ownerId', params.ownerId);
    if (params?.departmentId) query.set('departmentId', params.departmentId);
    if (params?.customerCode) query.set('customerCode', params.customerCode);
    if (params?.customerRelationId) query.set('customerRelationId', params.customerRelationId);
    if (params?.businessLine) query.set('businessLine', params.businessLine);
    if (params?.search) query.set('search', params.search);
    const url = buildApiUrl(`/v2/orders?${query.toString()}`, endpoint);
    const res = await fetch(url, { headers: this.getAuthHeaders() });
    if (!res.ok) throw new Error(`订单台账导出失败：HTTP ${res.status}`);
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
    const filename = m && m[1] ? decodeURIComponent(m[1]) : `订单台账_${businessNowDate().toISOString().slice(0, 10)}.xlsx`;
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  },

  /** BOM 台账 Excel 导出——GET /v1/bom?format=xlsx（当前筛选条件全量导出） */
  async exportBomListXlsx(params?: { status?: string; productAssetId?: string; orderId?: string; quotationId?: string; search?: string }, endpoint?: string): Promise<void> {
    const query = new URLSearchParams({ format: 'xlsx' });
    if (params?.status) query.set('status', params.status);
    if (params?.productAssetId) query.set('productAssetId', params.productAssetId);
    if (params?.orderId) query.set('orderId', params.orderId);
    if (params?.quotationId) query.set('quotationId', params.quotationId);
    if (params?.search) query.set('search', params.search);
    const url = buildApiUrl(`/v1/bom?${query.toString()}`, endpoint);
    const res = await fetch(url, { headers: this.getAuthHeaders() });
    if (!res.ok) throw new Error(`BOM台账导出失败：HTTP ${res.status}`);
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
    const filename = m && m[1] ? decodeURIComponent(m[1]) : `BOM台账_${businessNowDate().toISOString().slice(0, 10)}.xlsx`;
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  },

  /** 生产计划台账 Excel 导出——GET /v1/mes/plans?format=xlsx（当前筛选条件全量导出） */
  async exportMesPlansXlsx(params?: { orderId?: string; workStationId?: string; status?: string; processType?: string; dateFrom?: string; dateTo?: string }, endpoint?: string): Promise<void> {
    const query = new URLSearchParams({ format: 'xlsx' });
    if (params?.orderId) query.set('orderId', params.orderId);
    if (params?.workStationId) query.set('workStationId', params.workStationId);
    if (params?.status) query.set('status', params.status);
    if (params?.processType) query.set('processType', params.processType);
    if (params?.dateFrom) query.set('dateFrom', params.dateFrom);
    if (params?.dateTo) query.set('dateTo', params.dateTo);
    const url = buildApiUrl(`/v1/mes/plans?${query.toString()}`, endpoint);
    const res = await fetch(url, { headers: this.getAuthHeaders() });
    if (!res.ok) throw new Error(`生产计划台账导出失败：HTTP ${res.status}`);
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
    const filename = m && m[1] ? decodeURIComponent(m[1]) : `生产计划台账_${businessNowDate().toISOString().slice(0, 10)}.xlsx`;
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  },

  /** 报价台账 Excel 导出——GET /v1/quotations?format=xlsx（当前筛选条件全量导出） */
  async exportQuotationsXlsx(params?: { status?: string; customerRelationId?: string; dateFrom?: string; dateTo?: string; search?: string }, endpoint?: string): Promise<void> {
    const query = new URLSearchParams({ format: 'xlsx' });
    if (params?.status) query.set('status', params.status);
    if (params?.customerRelationId) query.set('customerRelationId', params.customerRelationId);
    if (params?.dateFrom) query.set('dateFrom', params.dateFrom);
    if (params?.dateTo) query.set('dateTo', params.dateTo);
    if (params?.search) query.set('search', params.search);
    const url = buildApiUrl(`/v1/quotations?${query.toString()}`, endpoint);
    const res = await fetch(url, { headers: this.getAuthHeaders() });
    if (!res.ok) throw new Error(`报价台账导出失败：HTTP ${res.status}`);
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
    const filename = m && m[1] ? decodeURIComponent(m[1]) : `报价台账_${businessNowDate().toISOString().slice(0, 10)}.xlsx`;
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  },

  /** 运单台账 Excel 导出——GET /v1/shipping?format=xlsx（当前筛选条件全量导出） */
  async exportShipmentsXlsx(params?: { type?: string; status?: string; orderId?: string; customerRelationId?: string; carrierRelationId?: string; carrierName?: string; shipmentNumber?: string; search?: string }, endpoint?: string): Promise<void> {
    const query = new URLSearchParams({ format: 'xlsx' });
    if (params?.type) query.set('type', params.type);
    if (params?.status) query.set('status', params.status);
    if (params?.orderId) query.set('orderId', params.orderId);
    if (params?.customerRelationId) query.set('customerRelationId', params.customerRelationId);
    if (params?.carrierRelationId) query.set('carrierRelationId', params.carrierRelationId);
    if (params?.carrierName) query.set('carrierName', params.carrierName);
    if (params?.shipmentNumber) query.set('shipmentNumber', params.shipmentNumber);
    if (params?.search) query.set('search', params.search);
    const url = buildApiUrl(`/v1/shipping?${query.toString()}`, endpoint);
    const res = await fetch(url, { headers: this.getAuthHeaders() });
    if (!res.ok) throw new Error(`运单台账导出失败：HTTP ${res.status}`);
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
    const filename = m && m[1] ? decodeURIComponent(m[1]) : `运单台账_${businessNowDate().toISOString().slice(0, 10)}.xlsx`;
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  },

  /** 下载贸易单据归档文件——GET /v1/customs/trade-documents/:id/download
   *（安全收口：uploads/trade-documents 已退出静态服务，本端点带 customs:read 鉴权；
   * 单据中心与各域 generate-document 的浏览器下载共用） */
  async downloadTradeDocumentArchive(documentId: string, fileName: string, endpoint?: string, version?: number, isCurrent?: () => boolean): Promise<void> {
    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) throw new Error('单据版本无效。');
    const finish = version === undefined ? { check: () => {}, dispose: () => {} } : customsDownloadFence(endpoint, isCurrent);
    try {
      const url = buildApiUrl(`/v1/customs/trade-documents/${encodeURIComponent(documentId)}/download${version === undefined ? '' : `?version=${version}`}`, endpoint);
      const res = await fetch(url, { headers: this.getAuthHeaders() });
      finish.check();
      if (!res.ok) throw new Error(`文件下载失败：HTTP ${res.status}`);
      const blob = await res.blob(); finish.check();
      if (version !== undefined && !new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()).slice(0, 5)).startsWith('%PDF-')) throw new Error('原版本归档文件无法核验。');
      finish.check();
      const objectUrl = URL.createObjectURL(blob);
      try { const a = document.createElement('a'); a.href = objectUrl; a.download = fileName; document.body.appendChild(a); finish.check(); a.click(); a.remove(); }
      finally { URL.revokeObjectURL(objectUrl); }
    } finally { finish.dispose(); }
  },

  /** 下载第三方原文件的指定归档版本；服务端校验版本快照与文件 SHA。 */
  async downloadExternalTradeDocumentArchive(documentId: string, version: number, fileName: string, endpoint?: string): Promise<void> {
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('单据版本无效。');
    const url = buildApiUrl(`/v1/customs/trade-documents/${encodeURIComponent(documentId)}/download?version=${version}`, endpoint);
    const response = await fetch(url, { headers: this.getAuthHeaders() });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error(data?.message || data?.error || `文件下载失败：HTTP ${response.status}`);
    }
    const blob = await response.blob();
    if (!blob.size) throw new Error('归档文件为空，请刷新版本记录后重试。');
    const objectUrl = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement('a'); anchor.href = objectUrl; anchor.download = fileName;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
    } finally { URL.revokeObjectURL(objectUrl); }
  },

  /** 上传第三方原文件到受保护的贸易单据归档区；浏览器负责 multipart boundary。 */
  async uploadExternalTradeDocumentArchive(documentId: string, file: File, endpoint?: string): Promise<{
    ok: true; documentId: string; archive: { version: number; fileName: string; mimeType: string; byteSize: number; sha256: string; uploadedAt: number; uploadedBy: string };
  }> {
    const form = new FormData(); form.append('file', file);
    const headers = this.getAuthHeaders();
    for (const key of Object.keys(headers)) if (key.toLowerCase() === 'content-type') delete headers[key];
    const response = await fetch(buildApiUrl(`/v1/customs/trade-documents/${encodeURIComponent(documentId)}/external-archive`, endpoint), {
      method: 'POST', headers, body: form,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.message || data?.error || `外部文件归档失败：HTTP ${response.status}`);
    if (data?.ok !== true || data?.documentId !== documentId || !Number.isSafeInteger(data?.archive?.version)
      || data.archive.version < 1 || data.archive.fileName !== file.name || data.archive.byteSize !== file.size
      || typeof data.archive.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(data.archive.sha256)) {
      throw new Error('归档回执与所选原文件不一致，请刷新单据版本核对。');
    }
    return data;
  },

  /** 库存台账 Excel 导出——GET /v1/inventory/items?format=xlsx（当前筛选条件全量导出） */
  async exportInventoryItemsXlsx(params?: { orderId?:string; productAssetId?:string; warehouseId?: string; category?: string; materialCode?: string; search?: string; lowStockOnly?: boolean }, endpoint?: string): Promise<void> {
    const query = new URLSearchParams({ format: 'xlsx' });
    if (params?.warehouseId) query.set('warehouseId', params.warehouseId);
    if (params?.category) query.set('category', params.category);
    if (params?.materialCode) query.set('materialCode', params.materialCode);
    if (params?.search) query.set('search', params.search);
    if (params?.lowStockOnly) query.set('lowStockOnly', 'true');
    const url = buildApiUrl(`/v1/inventory/items?${query.toString()}`, endpoint);
    const res = await fetch(url, { headers: this.getAuthHeaders() });
    if (!res.ok) throw new Error(`库存台账导出失败：HTTP ${res.status}`);
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
    const filename = m && m[1] ? decodeURIComponent(m[1]) : `库存台账_${businessNowDate().toISOString().slice(0, 10)}.xlsx`;
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  },

  async listMaterialReceipts(purchaseOrderId: string, endpoint?: string): Promise<MaterialReceipt[]> {
    const data = await requestJson<{ receipts: MaterialReceipt[] }>(`/v1/procurement/${encodeURIComponent(purchaseOrderId)}/receipts`, { endpoint, method: 'GET' });
    return Array.isArray(data.receipts) ? data.receipts : [];
  },

  async createMaterialReceipt(purchaseOrderId: string, input: MaterialReceiptInput, endpoint?: string): Promise<MaterialReceipt> {
    const data = await requestJson<{ receipt: MaterialReceipt }>(`/v1/procurement/${encodeURIComponent(purchaseOrderId)}/receipts`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.receipt;
  },

  // ── P1-4 物料退换货 API（退货/换货/索赔；/v1/procurement/material-returns）──
  async listMaterialReturns(params?: {
    purchaseOrderId?: string; receiptId?: string; supplierRelationId?: string; status?: string; limit?: number;
  }, endpoint?: string): Promise<MaterialReturn[]> {
    const qs = new URLSearchParams();
    if (params?.purchaseOrderId) qs.set('purchaseOrderId', params.purchaseOrderId);
    if (params?.receiptId) qs.set('receiptId', params.receiptId);
    if (params?.supplierRelationId) qs.set('supplierRelationId', params.supplierRelationId);
    if (params?.status) qs.set('status', params.status);
    if (params?.limit != null) qs.set('limit', String(params.limit));
    const path = `/v1/procurement/material-returns${qs.toString() ? '?' + qs.toString() : ''}`;
    const data = await requestJson<{ items: MaterialReturn[] }>(path, { endpoint, method: 'GET' });
    return Array.isArray(data.items) ? data.items : [];
  },

  async createMaterialReturn(input: {
    receiptId: string; type: MaterialReturnType; materialCode?: string; materialName?: string;
    quantity: number; unit?: string; amount?: number; currency?: string; reason?: string; notes?: string;
  }, endpoint?: string): Promise<MaterialReturn> {
    const data = await requestJson<{ materialReturn: MaterialReturn; error?: { code?: string; message?: string } }>(
      '/v1/procurement/material-returns',
      { endpoint, method: 'POST', body: JSON.stringify(input) },
    );
    if (!data.materialReturn) throw new Error((data as any).error?.message || '退换货登记失败');
    return data.materialReturn;
  },

  async markMaterialReturnShipped(id: string, endpoint?: string): Promise<{ materialReturn: MaterialReturn; skipStockReason?: string | null }> {
    const data = await requestJson<{ materialReturn: MaterialReturn; skipStockReason?: string | null }>(
      `/v1/procurement/material-returns/${encodeURIComponent(id)}/mark-shipped`,
      { endpoint, method: 'POST', body: JSON.stringify({}) },
    );
    return { materialReturn: data.materialReturn, skipStockReason: (data as any).skipStockReason ?? null };
  },

  async confirmMaterialReturn(id: string, endpoint?: string): Promise<{ materialReturn: MaterialReturn; claimInvoiceId?: string | null }> {
    const data = await requestJson<{ materialReturn: MaterialReturn; claimInvoiceId?: string | null; error?: { message?: string } }>(
      `/v1/procurement/material-returns/${encodeURIComponent(id)}/confirm`,
      { endpoint, method: 'POST', body: JSON.stringify({}) },
    );
    if (!data.materialReturn) throw new Error((data as any).error?.message || '供应商确认失败');
    return { materialReturn: data.materialReturn, claimInvoiceId: data.claimInvoiceId ?? null };
  },

  async settleMaterialReturn(id: string, endpoint?: string): Promise<MaterialReturn> {
    const data = await requestJson<{ materialReturn: MaterialReturn }>(
      `/v1/procurement/material-returns/${encodeURIComponent(id)}/settle`,
      { endpoint, method: 'POST', body: JSON.stringify({}) },
    );
    return data.materialReturn;
  },

  async cancelMaterialReturn(id: string, endpoint?: string): Promise<MaterialReturn> {
    const data = await requestJson<{ materialReturn: MaterialReturn }>(
      `/v1/procurement/material-returns/${encodeURIComponent(id)}/cancel`,
      { endpoint, method: 'POST', body: JSON.stringify({}) },
    );
    return data.materialReturn;
  },

  // ── 卡点 3：供应商询价比价 API（剧本 2.10 验收点） ──
  async listSupplierInquiries(params?: { status?: string; search?: string; limit?: number; offset?: number }, endpoint?: string): Promise<{ items: SupplierInquiry[]; total: number }> {
    const qs = new URLSearchParams();
    if (params?.status) qs.set('status', params.status);
    if (params?.search) qs.set('search', params.search);
    if (params?.limit != null) qs.set('limit', String(params.limit));
    if (params?.offset != null) qs.set('offset', String(params.offset));
    const path = `/v1/procurement/inquiries${qs.toString() ? '?' + qs.toString() : ''}`;
    return requestJson<{ items: SupplierInquiry[]; total: number }>(path, { endpoint, method: 'GET' });
  },

  async getSupplierInquiry(id: string, endpoint?: string): Promise<SupplierInquiry> {
    const data = await requestJson<{ inquiry: SupplierInquiry }>(`/v1/procurement/inquiries/${encodeURIComponent(id)}`, { endpoint, method: 'GET' });
    return data.inquiry;
  },

  async createSupplierInquiry(input: SupplierInquiryInput, endpoint?: string): Promise<SupplierInquiry> {
    const data = await requestJson<{ inquiry: SupplierInquiry }>('/v1/procurement/inquiries', { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.inquiry;
  },

  async updateSupplierInquiry(id: string, input: Partial<SupplierInquiryInput>, endpoint?: string): Promise<SupplierInquiry> {
    const data = await requestJson<{ inquiry: SupplierInquiry }>(`/v1/procurement/inquiries/${encodeURIComponent(id)}`, { endpoint, method: 'PUT', body: JSON.stringify(input) });
    return data.inquiry;
  },

  async deleteSupplierInquiry(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/procurement/inquiries/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },

  async addSupplierQuote(inquiryId: string, input: SupplierQuoteInput, endpoint?: string): Promise<SupplierInquiry> {
    const data = await requestJson<{ inquiry: SupplierInquiry }>(`/v1/procurement/inquiries/${encodeURIComponent(inquiryId)}/quotes`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.inquiry;
  },

  async updateSupplierQuote(inquiryId: string, quoteId: string, input: Partial<SupplierQuoteInput>, endpoint?: string): Promise<SupplierInquiry> {
    const data = await requestJson<{ inquiry: SupplierInquiry }>(`/v1/procurement/inquiries/${encodeURIComponent(inquiryId)}/quotes/${encodeURIComponent(quoteId)}`, { endpoint, method: 'PUT', body: JSON.stringify(input) });
    return data.inquiry;
  },

  async removeSupplierQuote(inquiryId: string, quoteId: string, endpoint?: string): Promise<SupplierInquiry> {
    const data = await requestJson<{ inquiry: SupplierInquiry }>(`/v1/procurement/inquiries/${encodeURIComponent(inquiryId)}/quotes/${encodeURIComponent(quoteId)}`, { endpoint, method: 'DELETE' });
    return data.inquiry;
  },

  async selectSupplier(inquiryId: string, quoteId: string, decisionNote: string, endpoint?: string): Promise<SupplierInquiry> {
    const data = await requestJson<{ inquiry: SupplierInquiry }>(`/v1/procurement/inquiries/${encodeURIComponent(inquiryId)}/select`, { endpoint, method: 'POST', body: JSON.stringify({ quoteId, decisionNote }) });
    return data.inquiry;
  },

  async closeSupplierInquiry(inquiryId: string, endpoint?: string): Promise<SupplierInquiry> {
    const data = await requestJson<{ inquiry: SupplierInquiry }>(`/v1/procurement/inquiries/${encodeURIComponent(inquiryId)}/close`, { endpoint, method: 'POST' });
    return data.inquiry;
  },

  // ── Phase 2 B2: 库存管理 API ──
  async listInventoryTransfers(id?:string): Promise<any[]> {const data=await requestJson<{tasks:any[]}>(`/v1/inventory/transfers${id?'?id='+encodeURIComponent(id):''}`,{method:'GET'});return data.tasks;},
  async createInventoryTransfer(input:unknown):Promise<any>{const data=await requestJson<{task:any}>('/v1/inventory/transfers',{method:'POST',body:JSON.stringify(input)});return data.task;},
  async advanceInventoryTransfer(id:string,action:string,input:unknown):Promise<any>{const data=await requestJson<{task:any}>(`/v1/inventory/transfers/${encodeURIComponent(id)}/${action}`,{method:'POST',body:JSON.stringify(input)});return data.task;},

  async listWarehousePersonnel(): Promise<Array<{id:string;displayName:string}>> {
    const data = await requestJson<{users:Array<{id:string;displayName:string}>}>('/v1/inventory/warehouse-personnel', {method:'GET'});
    return data.users;
  },

  async listWarehouses(includeInactive = false, endpoint?: string): Promise<Warehouse[]> {
    const data = await requestJson<{ warehouses: Warehouse[] }>(`/v1/inventory/warehouses${includeInactive ? '?includeInactive=true' : ''}`, { endpoint, method: 'GET' });
    return Array.isArray(data.warehouses) ? data.warehouses : [];
  },

  async createWarehouse(input: WarehouseInput, endpoint?: string): Promise<Warehouse> {
    const data = await requestJson<{ warehouse: Warehouse }>('/v1/inventory/warehouses', { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.warehouse;
  },

  async updateWarehouse(id: string, input: Partial<WarehouseInput>, endpoint?: string): Promise<Warehouse> {
    const data = await requestJson<{ warehouse: Warehouse }>(`/v1/inventory/warehouses/${encodeURIComponent(id)}`, { endpoint, method: 'PUT', body: JSON.stringify(input) });
    return data.warehouse;
  },

  async deleteWarehouse(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/inventory/warehouses/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },

  async listInventoryItems(params?: { orderId?:string; productAssetId?:string; warehouseId?: string; category?: string; materialCode?: string; search?: string; lowStockOnly?: boolean; limit?: number; offset?: number }, endpoint?: string): Promise<{ items: InventoryItem[]; total: number }> {
    const query = new URLSearchParams();
    if(params?.orderId)query.set('orderId',params.orderId);
    if(params?.productAssetId)query.set('productAssetId',params.productAssetId);
    if (params?.warehouseId) query.set('warehouseId', params.warehouseId);
    if (params?.category) query.set('category', params.category);
    if (params?.materialCode) query.set('materialCode', params.materialCode);
    if (params?.search) query.set('search', params.search);
    if (params?.lowStockOnly) query.set('lowStockOnly', 'true');
    if (params?.limit != null) query.set('limit', String(params.limit));
    if (params?.offset != null) query.set('offset', String(params.offset));
    const qs = query.toString();
    const path = `/v1/inventory/items${qs ? '?' + qs : ''}`;
    return requestJson<{ items: InventoryItem[]; total: number }>(path, { endpoint, method: 'GET' });
  },

  async getInventoryItem(id: string, endpoint?: string): Promise<InventoryItem | null> {
    try {
      const data = await requestJson<{ item: InventoryItem }>(`/v1/inventory/items/${encodeURIComponent(id)}`, { endpoint, method: 'GET' });
      return data.item;
    } catch { return null; }
  },

  async createInventoryItem(input: InventoryItemInput, endpoint?: string): Promise<InventoryItem> {
    const data = await requestJson<{ item: InventoryItem }>('/v1/inventory/items', { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.item;
  },

  async updateInventoryItem(id: string, input: Partial<InventoryItemInput>, endpoint?: string): Promise<InventoryItem> {
    const data = await requestJson<{ item: InventoryItem }>(`/v1/inventory/items/${encodeURIComponent(id)}`, { endpoint, method: 'PUT', body: JSON.stringify(input) });
    return data.item;
  },

  async deleteInventoryItem(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/inventory/items/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },

  async listStockMovements(params?: { itemId?: string; warehouseId?: string; type?: string; dateFrom?: string; dateTo?: string; limit?: number; offset?: number }, endpoint?: string): Promise<{ items: StockMovement[]; total: number }> {
    const query = new URLSearchParams();
    if (params?.itemId) query.set('itemId', params.itemId);
    if (params?.warehouseId) query.set('warehouseId', params.warehouseId);
    if (params?.type) query.set('type', params.type);
    if (params?.dateFrom) query.set('dateFrom', params.dateFrom);
    if (params?.dateTo) query.set('dateTo', params.dateTo);
    if (params?.limit != null) query.set('limit', String(params.limit));
    if (params?.offset != null) query.set('offset', String(params.offset));
    const qs = query.toString();
    const path = `/v1/inventory/movements${qs ? '?' + qs : ''}`;
    return requestJson<{ items: StockMovement[]; total: number }>(path, { endpoint, method: 'GET' });
  },

  async createStockMovement(input: StockMovementInput, endpoint?: string): Promise<StockMovement> {
    const data = await requestJson<{ movement: StockMovement }>('/v1/inventory/movements', { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.movement;
  },

  async getLowStockAlerts(endpoint?: string): Promise<InventoryItem[]> {
    const data = await requestJson<{ items: InventoryItem[]; total: number }>('/v1/inventory/alerts/low-stock', { endpoint, method: 'GET' });
    return Array.isArray(data.items) ? data.items : [];
  },

  /**
   * D7-② 按货权汇总存货 —— GET /v1/inventory/summary-by-ownership（inventory:read）
   * 口径：数量按单位分组、金额按币种分组（**跨单位/跨币种不相加**）。
   * ★ C6（2026-09-18）：`ourStock` = 我方存货（可用 + 在途 + 寄售）；`ownedOnly` 是其**别名**（deprecated）。
   */
  async getInventoryOwnershipSummary(warehouseId?: string, endpoint?: string): Promise<InventoryOwnershipSummary> {
    const qs = warehouseId ? `?warehouseId=${encodeURIComponent(warehouseId)}` : '';
    return requestJson<InventoryOwnershipSummary>(`/v1/inventory/summary-by-ownership${qs}`, { endpoint, method: 'GET' });
  },

  /**
   * D7-② 设置/变更某库存项的货权 —— PATCH /v1/inventory/items/:id/ownership（inventory:write）
   * 后端会写审计（operation=set_inventory_ownership），已是目标值时幂等返回 changed=false。
   */
  async registerInventoryOwner(id:string,input:{ownership:'Owned'|'Transferred';ownerRelationId?:string;date:string;evidence:string}):Promise<void>{
    await requestJson(`/v1/inventory/items/${encodeURIComponent(id)}/owner-registration`,{method:'POST',body:JSON.stringify(input)});
  },
  async setInventoryItemOwnership(itemId: string, ownership: string, note?: string | null, endpoint?: string): Promise<{ ok: boolean; changed: boolean; item?: InventoryItem; message?: string }> {
    return requestJson<{ ok: boolean; changed: boolean; item?: InventoryItem; message?: string }>(
      `/v1/inventory/items/${encodeURIComponent(itemId)}/ownership`,
      { endpoint, method: 'PATCH', body: JSON.stringify({ ownership, note: note ?? null }) },
    );
  },

  /**
   * ★ D1（2026-09-18）库存缸号配料核对（GET /v1/inventory/dye-lot-stock）
   *
   * 为什么需要：面料行业**同缸号才能同批裁**（避免缸差），而库存层此前没有缸号语义 ——
   * 缸号/色差评级只存在于缸差登记（`SampleColorBatch`），与库存零交集 ⇒
   * 业务员无法回答「这批货是哪个缸的、色差几级、能不能用来做这一单」。
   *
   * ⓘ 未登记缸号返回 `risk: 'unknown'`（**不是** low）——「不知道」不能显示成「没问题」。
   */
  async getDyeLotStock(params?: { category?: string; warehouseId?: string }, endpoint?: string): Promise<{
    lots: Array<{
      lot: string; itemCount: number;
      quantityByUnit: Array<{ unit: string; quantity: number }>;
      registered: boolean; colorRating: number | null; sideDiff: number | null; endDiff: number | null;
      defectCauses: string[]; risk: 'low' | 'medium' | 'high' | 'unknown'; note: string;
    }>;
    unregisteredLots: string[];
    noBatchCount: number;
    summary: { lotCount: number; registeredCount: number; unregisteredCount: number; highRiskCount: number };
  }> {
    const base = endpoint || apiService.getStoredConfig().cloudEndpoint;
    const url = apiService.buildApiUrl('/v1/inventory/dye-lot-stock', base);
    const query = new URLSearchParams();
    if (params?.category) query.set('category', params.category);
    if (params?.warehouseId) query.set('warehouseId', params.warehouseId);
    const fullUrl = query.toString() ? `${url}?${query.toString()}` : url;
    const res = await fetch(fullUrl, { headers: apiService.getAuthHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `getDyeLotStock failed: HTTP ${res.status}`);
    return data;
  },

  /**
   * ★ C4（2026-09-18）库存归属变更：备货 / 归属订单 / 挪货 / 退回（一个端点四个动作）
   *
   * 为什么一个端点：四个动作的前置条件互斥（见 server stockOwnershipService 头注释），
   * 用 action 显式表达意图 ⇒ 留痕能区分「认领」与「挪货」。
   *
   * @param targetOrderId 归属/挪货的目标：**可填订单 id 或 PO 号**（后端先按 id 再按 PO 号解析）
   */
  async changeInventoryOwnership(
    itemId: string,
    input: { action: 'mark_stock_prep' | 'attribute' | 'reassign' | 'release'; targetOrderId?: string | null; reason: string },
    endpoint?: string,
  ): Promise<{ ok: boolean; previousOrderId: string | null; currentOrderId: string | null; stockPrep: boolean }> {
    return requestJson(
      `/v1/inventory/items/${encodeURIComponent(itemId)}/ownership-change`,
      { endpoint, method: 'POST', body: JSON.stringify(input) },
    );
  },

  /** ★ C4 归属变更留痕（append-only，倒序） */
  async getInventoryOwnershipHistory(itemId: string, endpoint?: string): Promise<{ items: Array<Record<string, unknown>> }> {
    return requestJson(
      `/v1/inventory/items/${encodeURIComponent(itemId)}/ownership-history`,
      { endpoint, method: 'GET' },
    );
  },

  // ── Phase 2 B4: BOM / 成本核算 API ──
  async listBOMs(params?: { status?: string; productAssetId?: string; orderId?: string; quotationId?: string; search?: string; limit?: number; offset?: number }, endpoint?: string): Promise<{ items: BOM[]; total: number }> {
    const query = new URLSearchParams();
    if (params?.status) query.set('status', params.status);
    if (params?.productAssetId) query.set('productAssetId', params.productAssetId);
    if (params?.orderId) query.set('orderId', params.orderId);
    if (params?.quotationId) query.set('quotationId', params.quotationId);
    if (params?.search) query.set('search', params.search);
    if (params?.limit != null) query.set('limit', String(params.limit));
    if (params?.offset != null) query.set('offset', String(params.offset));
    const qs = query.toString();
    const path = `/v1/bom${qs ? '?' + qs : ''}`;
    return requestJson<{ items: BOM[]; total: number }>(path, { endpoint, method: 'GET' });
  },

  async getBOM(id: string, endpoint?: string): Promise<BOM | null> {
    try {
      const data = await requestJson<{ bom: BOM }>(`/v1/bom/${id}`, { endpoint, method: 'GET' });
      return data.bom;
    } catch {
      return null;
    }
  },

  async createBOM(input: CreateBOMInput, endpoint?: string): Promise<BOM> {
    const data = await requestJson<{ bom: BOM }>('/v1/bom', { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.bom;
  },

  async updateBOM(id: string, input: UpdateBOMInput, endpoint?: string): Promise<BOM> {
    const data = await requestJson<{ bom: BOM }>(`/v1/bom/${id}`, { endpoint, method: 'PUT', body: JSON.stringify(input) });
    return data.bom;
  },

  async deleteBOM(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/bom/${id}`, { endpoint, method: 'DELETE' });
  },

  async confirmBOM(id: string, endpoint?: string): Promise<BOM> {
    const data = await requestJson<{ bom: BOM }>(`/v1/bom/${id}/confirm`, { endpoint, method: 'POST' });
    return data.bom;
  },

  async archiveBOM(id: string, endpoint?: string): Promise<BOM> {
    const data = await requestJson<{ bom: BOM }>(`/v1/bom/${id}/archive`, { endpoint, method: 'POST' });
    return data.bom;
  },

  async reviseBOM(id: string, endpoint?: string): Promise<BOM> {
    const data = await requestJson<{ bom: BOM }>(`/v1/bom/${id}/revise`, { endpoint, method: 'POST' });
    return data.bom;
  },

  async recalculateBOMCost(id: string, endpoint?: string): Promise<BOM> {
    const data = await requestJson<{ bom: BOM }>(`/v1/bom/${id}/recalculate`, { endpoint, method: 'POST' });
    return data.bom;
  },

  // ════════════════════════════════════════
  // Phase 3 C2: 生产 MES 深化 API
  // ════════════════════════════════════════

  // ── 工位 WorkStation ──
  // R678：MES list 统一 { items, total } 返回 + 可选 limit/offset 透传（不传则后端全量返回）
  async listWorkStations(params?: { type?: string; isActive?: boolean; limit?: number; offset?: number }, endpoint?: string): Promise<{ items: WorkStation[]; total: number }> {
    const query = new URLSearchParams();
    if (params?.type) query.set('type', params.type);
    if (params?.isActive !== undefined) query.set('isActive', String(params.isActive));
    if (params?.limit != null) query.set('limit', String(params.limit));
    if (params?.offset != null) query.set('offset', String(params.offset));
    const qs = query.toString();
    const data = await requestJson<{ items: WorkStation[]; total?: number }>(`/v1/mes/work-stations${qs ? '?' + qs : ''}`, { endpoint, method: 'GET' });
    const items = Array.isArray(data.items) ? data.items : [];
    return { items, total: typeof data.total === 'number' ? data.total : items.length };
  },

  async getWorkStation(id: string, endpoint?: string): Promise<WorkStation | null> {
    try {
      const data = await requestJson<{ item: WorkStation }>(`/v1/mes/work-stations/${encodeURIComponent(id)}`, { endpoint, method: 'GET' });
      return data.item;
    } catch { return null; }
  },

  async getWorkStationUtilization(id: string, startDate: string, endDate: string, endpoint?: string): Promise<WorkStationUtilization | null> {
    try {
      const data = await requestJson<{ utilization: WorkStationUtilization }>(`/v1/mes/work-stations/${encodeURIComponent(id)}/utilization?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`, { endpoint, method: 'GET' });
      return data.utilization;
    } catch { return null; }
  },

  async createWorkStation(input: WorkStationInput, endpoint?: string): Promise<WorkStation> {
    const data = await requestJson<{ item: WorkStation }>('/v1/mes/work-stations', { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.item;
  },

  async updateWorkStation(id: string, input: Partial<WorkStationInput>, endpoint?: string): Promise<WorkStation> {
    const data = await requestJson<{ item: WorkStation }>(`/v1/mes/work-stations/${encodeURIComponent(id)}`, { endpoint, method: 'PUT', body: JSON.stringify(input) });
    return data.item;
  },

  async deleteWorkStation(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/mes/work-stations/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },

  // ── 排产 ProductionPlan ──
  async listProductionPlans(params?: { orderId?: string; workStationId?: string; status?: string; processType?: string; dateFrom?: string; dateTo?: string; limit?: number; offset?: number }, endpoint?: string): Promise<{ items: ProductionPlan[]; total: number }> {
    const query = new URLSearchParams();
    if (params?.orderId) query.set('orderId', params.orderId);
    if (params?.workStationId) query.set('workStationId', params.workStationId);
    if (params?.status) query.set('status', params.status);
    if (params?.processType) query.set('processType', params.processType);
    if (params?.dateFrom) query.set('dateFrom', params.dateFrom);
    if (params?.dateTo) query.set('dateTo', params.dateTo);
    if (params?.limit != null) query.set('limit', String(params.limit));
    if (params?.offset != null) query.set('offset', String(params.offset));
    const qs = query.toString();
    const data = await requestJson<{ items: ProductionPlan[]; total?: number }>(`/v1/mes/plans${qs ? '?' + qs : ''}`, { endpoint, method: 'GET' });
    const items = Array.isArray(data.items) ? data.items : [];
    return { items, total: typeof data.total === 'number' ? data.total : items.length };
  },

  async getProductionPlan(id: string, endpoint?: string): Promise<ProductionPlan | null> {
    try {
      const data = await requestJson<{ item: ProductionPlan }>(`/v1/mes/plans/${encodeURIComponent(id)}`, { endpoint, method: 'GET' });
      return data.item;
    } catch { return null; }
  },

  async createProductionPlan(input: ProductionPlanInput, endpoint?: string): Promise<ProductionPlan> {
    const data = await requestJson<{ item: ProductionPlan }>('/v1/mes/plans', { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.item;
  },

  async updateProductionPlan(id: string, input: Partial<ProductionPlanInput>, endpoint?: string): Promise<ProductionPlan> {
    const data = await requestJson<{ item: ProductionPlan }>(`/v1/mes/plans/${encodeURIComponent(id)}`, { endpoint, method: 'PUT', body: JSON.stringify(input) });
    return data.item;
  },

  async deleteProductionPlan(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/mes/plans/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },

  async transitionPlanStatus(id: string, toStatus: ProductionPlanStatus, endpoint?: string): Promise<ProductionPlan> {
    const data = await requestJson<{ item: ProductionPlan }>(`/v1/mes/plans/${encodeURIComponent(id)}/transition`, { endpoint, method: 'POST', body: JSON.stringify({ toStatus }) });
    return data.item;
  },

  async updatePlanProgress(id: string, actualQuantity: number, endpoint?: string): Promise<ProductionPlan> {
    const data = await requestJson<{ item: ProductionPlan }>(`/v1/mes/plans/${encodeURIComponent(id)}/progress`, { endpoint, method: 'POST', body: JSON.stringify({ actualQuantity }) });
    return data.item;
  },

  // ── 工时 WorkHour ──
  async listWorkHours(params?: { productionPlanId?: string; employeeId?: string; dateFrom?: string; dateTo?: string; limit?: number; offset?: number }, endpoint?: string): Promise<{ items: WorkHour[]; total: number }> {
    const query = new URLSearchParams();
    if (params?.productionPlanId) query.set('productionPlanId', params.productionPlanId);
    if (params?.employeeId) query.set('employeeId', params.employeeId);
    if (params?.dateFrom) query.set('dateFrom', params.dateFrom);
    if (params?.dateTo) query.set('dateTo', params.dateTo);
    if (params?.limit != null) query.set('limit', String(params.limit));
    if (params?.offset != null) query.set('offset', String(params.offset));
    const qs = query.toString();
    const data = await requestJson<{ items: WorkHour[]; total?: number }>(`/v1/mes/work-hours${qs ? '?' + qs : ''}`, { endpoint, method: 'GET' });
    const items = Array.isArray(data.items) ? data.items : [];
    return { items, total: typeof data.total === 'number' ? data.total : items.length };
  },

  async getWorkHourSummary(params?: { productionPlanId?: string; dateFrom?: string; dateTo?: string }, endpoint?: string): Promise<WorkHourSummary[]> {
    const query = new URLSearchParams();
    if (params?.productionPlanId) query.set('productionPlanId', params.productionPlanId);
    if (params?.dateFrom) query.set('dateFrom', params.dateFrom);
    if (params?.dateTo) query.set('dateTo', params.dateTo);
    const qs = query.toString();
    const data = await requestJson<{ summary: WorkHourSummary[] }>(`/v1/mes/work-hours/summary${qs ? '?' + qs : ''}`, { endpoint, method: 'GET' });
    return Array.isArray(data.summary) ? data.summary : [];
  },

  async createWorkHour(input: WorkHourInput, endpoint?: string): Promise<WorkHour> {
    const data = await requestJson<{ item: WorkHour }>('/v1/mes/work-hours', { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.item;
  },

  async deleteWorkHour(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/mes/work-hours/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },

  // ── 计件规则 PieceRateRule ──
  async listPieceRateRules(params?: { processType?: string; productAssetId?: string; isActive?: boolean; limit?: number; offset?: number }, endpoint?: string): Promise<{ items: PieceRateRule[]; total: number }> {
    const query = new URLSearchParams();
    if (params?.processType) query.set('processType', params.processType);
    if (params?.productAssetId) query.set('productAssetId', params.productAssetId);
    if (params?.isActive !== undefined) query.set('isActive', String(params.isActive));
    if (params?.limit != null) query.set('limit', String(params.limit));
    if (params?.offset != null) query.set('offset', String(params.offset));
    const qs = query.toString();
    const data = await requestJson<{ items: PieceRateRule[]; total?: number }>(`/v1/mes/piece-rate-rules${qs ? '?' + qs : ''}`, { endpoint, method: 'GET' });
    const items = Array.isArray(data.items) ? data.items : [];
    return { items, total: typeof data.total === 'number' ? data.total : items.length };
  },

  async createPieceRateRule(input: PieceRateRuleInput, endpoint?: string): Promise<PieceRateRule> {
    const data = await requestJson<{ item: PieceRateRule }>('/v1/mes/piece-rate-rules', { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.item;
  },

  async updatePieceRateRule(id: string, input: Partial<PieceRateRuleInput>, endpoint?: string): Promise<PieceRateRule> {
    const data = await requestJson<{ item: PieceRateRule }>(`/v1/mes/piece-rate-rules/${encodeURIComponent(id)}`, { endpoint, method: 'PUT', body: JSON.stringify(input) });
    return data.item;
  },

  async deletePieceRateRule(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/mes/piece-rate-rules/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },

  // ── 计件记录 PieceRateRecord ──
  async listPieceRateRecords(params?: { pieceRateRuleId?: string; productionPlanId?: string; employeeId?: string; status?: string; dateFrom?: string; dateTo?: string; limit?: number; offset?: number }, endpoint?: string): Promise<{ items: PieceRateRecord[]; total: number }> {
    const query = new URLSearchParams();
    if (params?.pieceRateRuleId) query.set('pieceRateRuleId', params.pieceRateRuleId);
    if (params?.productionPlanId) query.set('productionPlanId', params.productionPlanId);
    if (params?.employeeId) query.set('employeeId', params.employeeId);
    if (params?.status) query.set('status', params.status);
    if (params?.dateFrom) query.set('dateFrom', params.dateFrom);
    if (params?.dateTo) query.set('dateTo', params.dateTo);
    if (params?.limit != null) query.set('limit', String(params.limit));
    if (params?.offset != null) query.set('offset', String(params.offset));
    const qs = query.toString();
    const data = await requestJson<{ items: PieceRateRecord[]; total?: number }>(`/v1/mes/piece-rate-records${qs ? '?' + qs : ''}`, { endpoint, method: 'GET' });
    const items = Array.isArray(data.items) ? data.items : [];
    return { items, total: typeof data.total === 'number' ? data.total : items.length };
  },

  async getPieceRateSummary(params?: { employeeId?: string; status?: string; dateFrom?: string; dateTo?: string }, endpoint?: string): Promise<PieceRateSummary[]> {
    const query = new URLSearchParams();
    if (params?.employeeId) query.set('employeeId', params.employeeId);
    if (params?.status) query.set('status', params.status);
    if (params?.dateFrom) query.set('dateFrom', params.dateFrom);
    if (params?.dateTo) query.set('dateTo', params.dateTo);
    const qs = query.toString();
    const data = await requestJson<{ summary: PieceRateSummary[] }>(`/v1/mes/piece-rate-records/summary${qs ? '?' + qs : ''}`, { endpoint, method: 'GET' });
    return Array.isArray(data.summary) ? data.summary : [];
  },

  async createPieceRateRecord(input: PieceRateRecordInput, endpoint?: string): Promise<PieceRateRecord> {
    const data = await requestJson<{ item: PieceRateRecord }>('/v1/mes/piece-rate-records', { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.item;
  },

  async transitionPieceRateStatus(id: string, toStatus: PieceRateStatus, endpoint?: string): Promise<PieceRateRecord> {
    const data = await requestJson<{ item: PieceRateRecord }>(`/v1/mes/piece-rate-records/${encodeURIComponent(id)}/transition`, { endpoint, method: 'POST', body: JSON.stringify({ toStatus }) });
    return data.item;
  },

  async deletePieceRateRecord(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/mes/piece-rate-records/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },

  // ── 外协 OutsourcingOrder ──
  async listOutsourcingOrders(params?: { supplierId?: string; orderId?: string; status?: string; processType?: string; limit?: number; offset?: number }, endpoint?: string): Promise<{ items: OutsourcingOrder[]; total: number }> {
    const query = new URLSearchParams();
    if (params?.supplierId) query.set('supplierId', params.supplierId);
    if (params?.orderId) query.set('orderId', params.orderId);
    if (params?.status) query.set('status', params.status);
    if (params?.processType) query.set('processType', params.processType);
    if (params?.limit != null) query.set('limit', String(params.limit));
    if (params?.offset != null) query.set('offset', String(params.offset));
    const qs = query.toString();
    const data = await requestJson<{ items: OutsourcingOrder[]; total?: number }>(`/v1/mes/outsourcing${qs ? '?' + qs : ''}`, { endpoint, method: 'GET' });
    const items = Array.isArray(data.items) ? data.items : [];
    return { items, total: typeof data.total === 'number' ? data.total : items.length };
  },

  async getOutsourcingOrder(id: string, endpoint?: string): Promise<OutsourcingOrder | null> {
    try {
      const data = await requestJson<{ item: OutsourcingOrder }>(`/v1/mes/outsourcing/${encodeURIComponent(id)}`, { endpoint, method: 'GET' });
      return data.item;
    } catch { return null; }
  },

  async createOutsourcingOrder(input: OutsourcingOrderInput, endpoint?: string): Promise<OutsourcingOrder> {
    const data = await requestJson<{ item: OutsourcingOrder }>('/v1/mes/outsourcing', { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.item;
  },

  async updateOutsourcingOrder(id: string, input: Partial<OutsourcingOrderInput>, endpoint?: string): Promise<OutsourcingOrder> {
    const data = await requestJson<{ item: OutsourcingOrder }>(`/v1/mes/outsourcing/${encodeURIComponent(id)}`, { endpoint, method: 'PUT', body: JSON.stringify(input) });
    return data.item;
  },

  async deleteOutsourcingOrder(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/mes/outsourcing/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },

  async transitionOutsourcingStatus(id: string, toStatus: OutsourcingStatus, endpoint?: string): Promise<OutsourcingOrder> {
    const data = await requestJson<{ item: OutsourcingOrder }>(`/v1/mes/outsourcing/${encodeURIComponent(id)}/transition`, { endpoint, method: 'POST', body: JSON.stringify({ toStatus }) });
    return data.item;
  },

  async receiveOutsourcing(id: string, opts: { qualityAcceptedQty: number; qualityRejectedQty?: number }, endpoint?: string): Promise<OutsourcingOrder> {
    const data = await requestJson<{ item: OutsourcingOrder }>(`/v1/mes/outsourcing/${encodeURIComponent(id)}/receive`, { endpoint, method: 'POST', body: JSON.stringify(opts) });
    return data.item;
  },

  // ── REQ2-05 面料工序级委外链 OrderProcessNode（DR-047：计划+成本核算层） ──
  async listOrderProcessChain(orderId: string, endpoint?: string): Promise<{ nodes: OrderProcessNodeRow[]; summary: OrderProcessChainSummary }> {
    const data = await requestJson<{ nodes: OrderProcessNodeRow[]; summary: OrderProcessChainSummary }>(
      `/v1/mes/order-processes?orderId=${encodeURIComponent(orderId)}`, { endpoint, method: 'GET' });
    return { nodes: data.nodes ?? [], summary: data.summary };
  },

  async createOrderProcessNode(input: {
    orderId: string; seq: number; processType: string; supplierId?: string;
    inputQty: number; unit?: string; unitPrice: number; notes?: string; outsourcingOrderId?: string;
  }, endpoint?: string): Promise<OrderProcessNodeRow> {
    const data = await requestJson<{ node: OrderProcessNodeRow }>('/v1/mes/order-processes', { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.node;
  },

  async updateOrderProcessNode(id: string, patch: {
    supplierId?: string | null; inputQty?: number; unit?: string; unitPrice?: number; notes?: string;
  }, endpoint?: string): Promise<OrderProcessNodeRow> {
    const data = await requestJson<{ node: OrderProcessNodeRow }>(`/v1/mes/order-processes/${encodeURIComponent(id)}`, { endpoint, method: 'PATCH', body: JSON.stringify(patch) });
    return data.node;
  },

  async startOrderProcessNode(id: string, endpoint?: string): Promise<OrderProcessNodeRow> {
    const data = await requestJson<{ node: OrderProcessNodeRow }>(`/v1/mes/order-processes/${encodeURIComponent(id)}/start`, { endpoint, method: 'POST', body: '{}' });
    return data.node;
  },

  async completeOrderProcessNode(id: string, input: { outputQty: number; actualUnitPrice?: number }, endpoint?: string): Promise<{ node: OrderProcessNodeRow; lossPct: number | null }> {
    const data = await requestJson<{ node: OrderProcessNodeRow; lossPct: number | null }>(`/v1/mes/order-processes/${encodeURIComponent(id)}/complete`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return { node: data.node, lossPct: data.lossPct };
  },

  async deleteOrderProcessNode(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/mes/order-processes/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },

  // ── Phase 3 C1: CRM 深化 API ──
  // Contact
  async listContacts(relationId: string, endpoint?: string): Promise<Contact[]> {
    const data = await requestJson<{ contacts: Contact[] }>(`/v2/crm/${encodeURIComponent(relationId)}/contacts`, { endpoint, method: 'GET' });
    return data.contacts ?? [];
  },
  async createContact(relationId: string, input: ContactInput, endpoint?: string): Promise<Contact> {
    const data = await requestJson<{ contact: Contact }>(`/v2/crm/${encodeURIComponent(relationId)}/contacts`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.contact;
  },
  async updateContact(id: string, input: Partial<ContactInput>, endpoint?: string): Promise<Contact> {
    const data = await requestJson<{ contact: Contact }>(`/v2/crm/contacts/${encodeURIComponent(id)}`, { endpoint, method: 'PUT', body: JSON.stringify(input) });
    return data.contact;
  },
  async deleteContact(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v2/crm/contacts/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },

  // CreditLimit
  async getActiveCreditLimit(relationId: string, endpoint?: string): Promise<CreditLimit | null> {
    const data = await requestJson<{ creditLimit: CreditLimit | null }>(`/v2/crm/${encodeURIComponent(relationId)}/credit-limit`, { endpoint, method: 'GET' });
    return data.creditLimit;
  },
  async listCreditLimitHistory(relationId: string, endpoint?: string): Promise<CreditLimit[]> {
    const data = await requestJson<{ history: CreditLimit[] }>(`/v2/crm/${encodeURIComponent(relationId)}/credit-limit/history`, { endpoint, method: 'GET' });
    return data.history ?? [];
  },
  async setCreditLimit(relationId: string, input: CreditLimitInput, endpoint?: string): Promise<CreditLimit> {
    const data = await requestJson<{ creditLimit: CreditLimit }>(`/v2/crm/${encodeURIComponent(relationId)}/credit-limit`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.creditLimit;
  },
  async updateCreditLimitStatus(id: string, status: string, endpoint?: string): Promise<CreditLimit> {
    const data = await requestJson<{ creditLimit: CreditLimit }>(`/v2/crm/credit-limit/${encodeURIComponent(id)}/status`, { endpoint, method: 'PATCH', body: JSON.stringify({ status }) });
    return data.creditLimit;
  },

  // FollowUp
  async listFollowUps(relationId: string, opts?: { limit?: number; includeCompleted?: boolean }, endpoint?: string): Promise<FollowUpRecord[]> {
    const query = new URLSearchParams();
    if (opts?.limit != null) query.set('limit', String(opts.limit));
    if (opts?.includeCompleted) query.set('includeCompleted', 'true');
    const qs = query.toString();
    const data = await requestJson<{ followUps: FollowUpRecord[] }>(`/v2/crm/${encodeURIComponent(relationId)}/follow-ups${qs ? '?' + qs : ''}`, { endpoint, method: 'GET' });
    return data.followUps ?? [];
  },

  // ══════════════════════════════════════════════════════════════
  // DR-042 小组数据共享（设计真源：docs/design/03-业务规则/小组与业务数据共享.md）
  // ══════════════════════════════════════════════════════════════

  /** 客户档案被共享给的小组（chips）+ 当前用户访问档位（owner/team-followup/team-read/none） */
  async getRelationTeamShares(relationId: string, endpoint?: string): Promise<{ teamShares: Array<{ grantId: string; teamId: string; teamName: string; permission: string; grantedBy: string; grantedAt: string }>; accessMode: string }> {
    const data = await requestJson<{ teamShares: any[]; accessMode: string }>(`/v2/relations/${encodeURIComponent(relationId)}/team-shares`, { endpoint, method: 'GET' });
    return { teamShares: data.teamShares ?? [], accessMode: data.accessMode ?? 'none' };
  },

  /**
   * 当前用户 scope 内可见的客户档案列表（v2 行级口径：本人 ∪ 小组共享 / all 全量）。
   * 组管理的共享选择器数据源——列出可选客户，授权资格由服务端双重门禁把关。
   */
  async listRelationsV2(limit = 500, endpoint?: string): Promise<Array<{ id: string; name: string; code: string | null; stage: string | null }>> {
    const data = await requestJson<{ ok: boolean; items: any[] }>(`/v2/relations?limit=${limit}`, { endpoint, method: 'GET' });
    return (data.items ?? []).map((r: any) => ({ id: r.id, name: r.name, code: r.code ?? null, stage: r.stage ?? null }));
  },

  /** 详情页就地共享客户档案给小组（档位 read / read+followup） */
  async shareRelationToTeams(relationId: string, teamIds: string[], permission: 'read' | 'read+followup' = 'read+followup', endpoint?: string): Promise<{ granted: number }> {
    const data = await requestJson<{ ok: boolean; granted: number }>(`/v2/relations/${encodeURIComponent(relationId)}/team-shares`, {
      endpoint, method: 'POST', body: JSON.stringify({ teamIds, permission }),
    });
    return data;
  },

  /** 就地移除共享（reason 审计留痕必填） */
  async unshareRelationFromTeam(relationId: string, teamId: string, reason: string, endpoint?: string): Promise<{ revoked: boolean }> {
    const data = await requestJson<{ ok: boolean; revoked: boolean }>(`/v2/relations/${encodeURIComponent(relationId)}/team-shares/${encodeURIComponent(teamId)}`, {
      endpoint, method: 'DELETE', body: JSON.stringify({ reason }),
    });
    return data;
  },
  async createFollowUp(relationId: string, input: FollowUpInput, endpoint?: string): Promise<FollowUpRecord> {
    const data = await requestJson<{ followUp: FollowUpRecord }>(`/v2/crm/${encodeURIComponent(relationId)}/follow-ups`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.followUp;
  },
  async updateFollowUp(id: string, input: Partial<FollowUpInput>, endpoint?: string): Promise<FollowUpRecord> {
    const data = await requestJson<{ followUp: FollowUpRecord }>(`/v2/crm/follow-ups/${encodeURIComponent(id)}`, { endpoint, method: 'PUT', body: JSON.stringify(input) });
    return data.followUp;
  },
  async deleteFollowUp(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v2/crm/follow-ups/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },
  async listOverdueFollowUps(daysAhead?: number, endpoint?: string): Promise<FollowUpRecord[]> {
    const query = daysAhead != null ? `?daysAhead=${daysAhead}` : '';
    const data = await requestJson<{ overdueFollowUps: FollowUpRecord[] }>(`/v2/crm/follow-ups/overdue${query}`, { endpoint, method: 'GET' });
    return data.overdueFollowUps ?? [];
  },

  // ── 阶段 P3b：品牌线 BrandLine（PRD 6.2，客户 360°）──
  // ⚠️ DR-042 v2.2 遗留：brand-lines / comm-logs 仍在 V1 端点（crmRouteV2 未覆盖，
  // 无 L2 行级门禁）——待 Phase 3 V2 化补齐后切换（文档 §12 Phase 3 锚定扩展）。
  async listBrandLines(relationId: string, opts?: { includeInactive?: boolean }, endpoint?: string): Promise<BrandLine[]> {
    const qs = opts?.includeInactive ? '?includeInactive=1' : '';
    const data = await requestJson<{ items: BrandLine[]; total: number }>(`/v1/crm/${encodeURIComponent(relationId)}/brand-lines${qs}`, { endpoint, method: 'GET' });
    return data.items ?? [];
  },
  async createBrandLine(relationId: string, input: BrandLineInput, endpoint?: string): Promise<BrandLine> {
    const data = await requestJson<{ item: BrandLine }>(`/v1/crm/${encodeURIComponent(relationId)}/brand-lines`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.item;
  },
  async updateBrandLine(id: string, input: Partial<BrandLineInput>, endpoint?: string): Promise<BrandLine> {
    const data = await requestJson<{ item: BrandLine }>(`/v1/crm/brand-lines/${encodeURIComponent(id)}`, { endpoint, method: 'PUT', body: JSON.stringify(input) });
    return data.item;
  },
  async deleteBrandLine(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/crm/brand-lines/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },

  // ── 阶段 P3b：沟通日志 CommunicationLog（PRD 12.3，全渠道沟通流水）──
  async listCommLogs(relationId: string, opts?: { type?: string; direction?: string; limit?: number; offset?: number }, endpoint?: string): Promise<CommunicationLog[]> {
    const query = new URLSearchParams();
    if (opts?.type) query.set('type', opts.type);
    if (opts?.direction) query.set('direction', opts.direction);
    if (opts?.limit != null) query.set('limit', String(opts.limit));
    if (opts?.offset != null) query.set('offset', String(opts.offset));
    const qs = query.toString();
    const data = await requestJson<{ items: CommunicationLog[]; total: number }>(`/v1/crm/${encodeURIComponent(relationId)}/comm-logs${qs ? '?' + qs : ''}`, { endpoint, method: 'GET' });
    return data.items ?? [];
  },
  async createCommLog(relationId: string, input: CommunicationLogInput, endpoint?: string): Promise<CommunicationLog> {
    const data = await requestJson<{ item: CommunicationLog }>(`/v1/crm/${encodeURIComponent(relationId)}/comm-logs`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.item;
  },
  async updateCommLog(id: string, input: Partial<CommunicationLogInput>, endpoint?: string): Promise<CommunicationLog> {
    const data = await requestJson<{ item: CommunicationLog }>(`/v1/crm/comm-logs/${encodeURIComponent(id)}`, { endpoint, method: 'PUT', body: JSON.stringify(input) });
    return data.item;
  },
  async deleteCommLog(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/crm/comm-logs/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },

  // ── 阶段 P3b：邮件签名 EmailSignature（PRD 12.1；写操作需 JWT）──
  async listEmailSignatures(opts?: { language?: string; includeInactive?: boolean }, endpoint?: string): Promise<EmailSignature[]> {
    const query = new URLSearchParams();
    if (opts?.language) query.set('language', opts.language);
    if (opts?.includeInactive) query.set('includeInactive', '1');
    const qs = query.toString();
    const data = await requestJson<{ items: EmailSignature[]; total: number }>(`/v1/email-signatures${qs ? '?' + qs : ''}`, { endpoint, method: 'GET' });
    return data.items ?? [];
  },
  async createEmailSignature(input: EmailSignatureInput, endpoint?: string): Promise<EmailSignature> {
    const data = await requestJson<{ item: EmailSignature }>(`/v1/email-signatures`, { endpoint, method: 'POST', headers: jwtAuthHeaders(), body: JSON.stringify(input) });
    return data.item;
  },
  async updateEmailSignature(id: string, input: Partial<EmailSignatureInput>, endpoint?: string): Promise<EmailSignature> {
    const data = await requestJson<{ item: EmailSignature }>(`/v1/email-signatures/${encodeURIComponent(id)}`, { endpoint, method: 'PATCH', headers: jwtAuthHeaders(), body: JSON.stringify(input) });
    return data.item;
  },
  async deleteEmailSignature(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/email-signatures/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE', headers: jwtAuthHeaders() });
  },

  // ── 阶段 P3a：单据模板 DocumentTemplate（PRD 11.3；写操作需 JWT）──
  async listDocumentTemplates(opts?: { type?: string; language?: string; includeInactive?: boolean }, endpoint?: string): Promise<DocumentTemplate[]> {
    const query = new URLSearchParams();
    if (opts?.type) query.set('type', opts.type);
    if (opts?.language) query.set('language', opts.language);
    if (opts?.includeInactive) query.set('includeInactive', '1');
    const qs = query.toString();
    const data = await requestJson<{ items: DocumentTemplate[]; total: number }>(`/v1/document-templates${qs ? '?' + qs : ''}`, { endpoint, method: 'GET' });
    return data.items ?? [];
  },
  async createDocumentTemplate(input: DocumentTemplateInput, endpoint?: string): Promise<DocumentTemplate> {
    const data = await requestJson<{ item: DocumentTemplate }>(`/v1/document-templates`, { endpoint, method: 'POST', headers: jwtAuthHeaders(), body: JSON.stringify(input) });
    return data.item;
  },
  async updateDocumentTemplate(id: string, input: Partial<DocumentTemplateInput>, endpoint?: string): Promise<DocumentTemplate> {
    const data = await requestJson<{ item: DocumentTemplate }>(`/v1/document-templates/${encodeURIComponent(id)}`, { endpoint, method: 'PATCH', headers: jwtAuthHeaders(), body: JSON.stringify(input) });
    return data.item;
  },
  async deleteDocumentTemplate(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/document-templates/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE', headers: jwtAuthHeaders() });
  },

  // Opportunity
  async listOpportunities(params?: { relationId?: string; stage?: string; salesRepId?: string }, endpoint?: string): Promise<Opportunity[]> {
    const query = new URLSearchParams();
    if (params?.relationId) query.set('relationId', params.relationId);
    if (params?.stage) query.set('stage', params.stage);
    if (params?.salesRepId) query.set('salesRepId', params.salesRepId);
    const qs = query.toString();
    const data = await requestJson<{ opportunities: Opportunity[] }>(`/v2/crm/opportunities${qs ? '?' + qs : ''}`, { endpoint, method: 'GET' });
    return data.opportunities ?? [];
  },
  async createOpportunity(relationId: string, input: OpportunityInput, endpoint?: string): Promise<Opportunity> {
    const data = await requestJson<{ opportunity: Opportunity }>(`/v2/crm/${encodeURIComponent(relationId)}/opportunities`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.opportunity;
  },
  async getOpportunity(id: string, endpoint?: string): Promise<Opportunity | null> {
    try {
      const data = await requestJson<{ opportunity: Opportunity }>(`/v2/crm/opportunities/${encodeURIComponent(id)}`, { endpoint, method: 'GET' });
      return data.opportunity;
    } catch { return null; }
  },
  async updateOpportunity(id: string, input: Partial<OpportunityInput>, endpoint?: string): Promise<Opportunity> {
    const data = await requestJson<{ opportunity: Opportunity }>(`/v2/crm/opportunities/${encodeURIComponent(id)}`, { endpoint, method: 'PUT', body: JSON.stringify(input) });
    return data.opportunity;
  },
  async transitionOpportunity(id: string, toStage: string, endpoint?: string): Promise<Opportunity> {
    const data = await requestJson<{ opportunity: Opportunity }>(`/v1/crm/opportunities/${encodeURIComponent(id)}/transition`, { endpoint, method: 'POST', body: JSON.stringify({ toStage }) });
    return data.opportunity;
  },
  async deleteOpportunity(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v2/crm/opportunities/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },
  async getOpportunityPipelineSummary(salesRepId?: string, endpoint?: string): Promise<Record<string, { count: number; totalAmount: number }>> {
    const query = salesRepId ? `?salesRepId=${encodeURIComponent(salesRepId)}` : '';
    const data = await requestJson<{ pipeline: Record<string, { count: number; totalAmount: number }> }>(`/v2/crm/opportunities/pipeline/summary${query}`, { endpoint, method: 'GET' });
    return data.pipeline ?? {};
  },

  // CustomerTier
  async getActiveCustomerTier(relationId: string, endpoint?: string): Promise<CustomerTier | null> {
    const data = await requestJson<{ customerTier: CustomerTier | null }>(`/v2/crm/${encodeURIComponent(relationId)}/customer-tier`, { endpoint, method: 'GET' });
    return data.customerTier;
  },
  async listCustomerTierHistory(relationId: string, endpoint?: string): Promise<CustomerTier[]> {
    const data = await requestJson<{ history: CustomerTier[] }>(`/v2/crm/${encodeURIComponent(relationId)}/customer-tier/history`, { endpoint, method: 'GET' });
    return data.history ?? [];
  },
  async assignCustomerTier(relationId: string, input: CustomerTierInput, endpoint?: string): Promise<CustomerTier> {
    const data = await requestJson<{ customerTier: CustomerTier }>(`/v2/crm/${encodeURIComponent(relationId)}/customer-tier`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.customerTier;
  },
  async deleteCustomerTier(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v2/crm/customer-tier/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },

  // CRM Overview
  async getCrmOverview(relationId: string, endpoint?: string): Promise<CrmOverview | null> {
    try {
      const data = await requestJson<CrmOverview>(`/v2/crm/${encodeURIComponent(relationId)}/overview`, { endpoint, method: 'GET' });
      return data;
    } catch { return null; }
  },

  // ── 阶段 H H1: 供应商管理 Supplier Management API ──
  // FactoryProfile 档案
  async listFactoryProfiles(params?: { search?: string; blacklisted?: boolean; sort?: string; order?: 'asc' | 'desc'; limit?: number; offset?: number }, endpoint?: string): Promise<{ items: FactoryProfile[]; total: number }> {
    const query = new URLSearchParams();
    if (params?.search) query.set('search', params.search);
    if (params?.blacklisted !== undefined) query.set('blacklisted', String(params.blacklisted));
    if (params?.sort) query.set('sort', params.sort);
    if (params?.order) query.set('order', params.order);
    if (params?.limit != null) query.set('limit', String(params.limit));
    if (params?.offset != null) query.set('offset', String(params.offset));
    const qs = query.toString();
    const data = await requestJson<{ items: FactoryProfile[]; total: number }>(`/v1/suppliers${qs ? '?' + qs : ''}`, { endpoint, method: 'GET' });
    return { items: data.items ?? [], total: data.total ?? 0 };
  },
  async listSupplierDirectory(params: {search?:string;sort?:string;order?:string;blacklisted?:boolean;limit?:number;offset?:number} = {}): Promise<{items:FactoryProfile[];total:number}> {
    const query = new URLSearchParams();
    Object.entries(params).forEach(([key,value])=>{if(value!==undefined) query.set(key,String(value));});
    return requestJson(`/v1/suppliers/directory?${query}`, {method:'GET'});
  },
  async getSupplierDirectoryOverview(relationId:string): Promise<{profile:FactoryProfile;evaluations:FactoryEvaluation[];certifications:FactoryCertification[];capacity:FactoryCapacity[]}> {
    return requestJson(`/v1/suppliers/directory/${encodeURIComponent(relationId)}`, {method:'GET'});
  },
  async ensureSupplierProfile(input: FactoryProfileInput, endpoint?: string): Promise<FactoryProfile> {
    const data = await requestJson<{ ok: boolean; item: FactoryProfile }>('/v1/suppliers/ensure', {
      endpoint, method: 'POST', body: JSON.stringify(input),
    });
    return data.item;
  },
  async getFactoryProfile(id: string, endpoint?: string): Promise<FactoryProfile | null> {
    try {
      const data = await requestJson<{ item: FactoryProfile }>(`/v1/suppliers/${encodeURIComponent(id)}`, { endpoint, method: 'GET' });
      return data.item;
    } catch { return null; }
  },
  async createFactoryProfile(input: FactoryProfileInput, endpoint?: string): Promise<FactoryProfile> {
    const data = await requestJson<{ item: FactoryProfile }>(`/v1/suppliers`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.item;
  },
  async updateFactoryProfile(id: string, patch: FactoryProfilePatch, endpoint?: string): Promise<FactoryProfile> {
    const data = await requestJson<{ item: FactoryProfile }>(`/v1/suppliers/${encodeURIComponent(id)}`, { endpoint, method: 'PATCH', body: JSON.stringify(patch) });
    return data.item;
  },
  async deleteFactoryProfile(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/suppliers/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },
  async blacklistFactory(id: string, reason: string, endpoint?: string): Promise<FactoryProfile> {
    const data = await requestJson<{ item: FactoryProfile }>(`/v1/suppliers/${encodeURIComponent(id)}/blacklist`, { endpoint, method: 'POST', body: JSON.stringify({ reason }) });
    return data.item;
  },
  async unblacklistFactory(id: string, endpoint?: string): Promise<FactoryProfile> {
    const data = await requestJson<{ item: FactoryProfile }>(`/v1/suppliers/${encodeURIComponent(id)}/blacklist`, { endpoint, method: 'DELETE' });
    return data.item;
  },

  // FactoryEvaluation 评估
  async listFactoryEvaluations(factoryId: string, kind?: string, endpoint?: string): Promise<FactoryEvaluation[]> {
    const qs = kind ? `?kind=${encodeURIComponent(kind)}` : '';
    const data = await requestJson<{ items: FactoryEvaluation[] }>(`/v1/suppliers/${encodeURIComponent(factoryId)}/evaluations${qs}`, { endpoint, method: 'GET' });
    return data.items ?? [];
  },
  async addFactoryEvaluation(factoryId: string, input: FactoryEvaluationInput, endpoint?: string): Promise<FactoryEvaluation> {
    const data = await requestJson<{ item: FactoryEvaluation }>(`/v1/suppliers/${encodeURIComponent(factoryId)}/evaluations`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.item;
  },

  // FactoryCertification 认证
  async listFactoryCertifications(factoryId: string, endpoint?: string): Promise<FactoryCertification[]> {
    const data = await requestJson<{ items: FactoryCertification[] }>(`/v1/suppliers/${encodeURIComponent(factoryId)}/certifications`, { endpoint, method: 'GET' });
    return data.items ?? [];
  },
  async addFactoryCertification(factoryId: string, input: FactoryCertificationInput, endpoint?: string): Promise<FactoryCertification> {
    const data = await requestJson<{ item: FactoryCertification }>(`/v1/suppliers/${encodeURIComponent(factoryId)}/certifications`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.item;
  },
  async updateFactoryCertification(certId: string, patch: Partial<FactoryCertificationInput>, endpoint?: string): Promise<FactoryCertification> {
    const data = await requestJson<{ item: FactoryCertification }>(`/v1/suppliers/certifications/${encodeURIComponent(certId)}`, { endpoint, method: 'PATCH', body: JSON.stringify(patch) });
    return data.item;
  },
  async deleteFactoryCertification(certId: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/suppliers/certifications/${encodeURIComponent(certId)}`, { endpoint, method: 'DELETE' });
  },
  async listExpiringCertifications(days?: number, endpoint?: string): Promise<FactoryCertification[]> {
    const qs = days != null ? `?days=${days}` : '';
    const data = await requestJson<{ items: FactoryCertification[]; total: number }>(`/v1/suppliers/expiring-certifications${qs}`, { endpoint, method: 'GET' });
    return data.items ?? [];
  },

  // ── REQ2-06 GRS TC 交易证书链 TcCertificate（DR-048：三段链 + 一键校验） ──
  async listTcCertificates(params: { orderId?: string; relationId?: string }, endpoint?: string): Promise<{ items: TcCertificateRow[]; byStage: TcStageSummary[] }> {
    const query = new URLSearchParams();
    if (params.orderId) query.set('orderId', params.orderId);
    if (params.relationId) query.set('relationId', params.relationId);
    const data = await requestJson<{ items: TcCertificateRow[]; byStage: TcStageSummary[] }>(
      `/v1/suppliers/tc-certificates?${query.toString()}`, { endpoint, method: 'GET' });
    return { items: data.items ?? [], byStage: data.byStage ?? [] };
  },
  async createTcCertificate(input: {
    orderId: string; stage: TcStage; tcNo: string; quantityKg: number;
    relationId?: string; issuedAt?: string; validUntil?: string; notes?: string; parentTcId?: string;
  }, endpoint?: string): Promise<TcCertificateRow> {
    const data = await requestJson<{ tc: TcCertificateRow }>('/v1/suppliers/tc-certificates', { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.tc;
  },
  async verifyTcChain(orderId: string, endpoint?: string): Promise<TcChainVerification> {
    const data = await requestJson<{ verification: TcChainVerification }>(
      `/v1/suppliers/tc-certificates/verify?orderId=${encodeURIComponent(orderId)}`, { endpoint, method: 'GET' });
    return data.verification;
  },
  async updateTcCertificate(id: string, patch: {
    quantityKg?: number; issuedAt?: string; validUntil?: string; notes?: string;
  }, endpoint?: string): Promise<TcCertificateRow> {
    const data = await requestJson<{ tc: TcCertificateRow }>(`/v1/suppliers/tc-certificates/${encodeURIComponent(id)}`, { endpoint, method: 'PATCH', body: JSON.stringify(patch) });
    return data.tc;
  },
  async deleteTcCertificate(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/suppliers/tc-certificates/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },

  // ── REQ2-10 工厂延迟链路影响（DR-052：缓冲侵蚀分级 + 沟通建议 + 交期分联动） ──
  async previewFactoryDelay(supplierRelationId: string, delayDays: number, endpoint?: string): Promise<DelayImpactResult> {
    const query = new URLSearchParams({ supplierRelationId, delayDays: String(delayDays) });
    return requestJson<DelayImpactResult>(`/v1/suppliers/delays/preview?${query.toString()}`, { endpoint, method: 'GET' });
  },
  async registerFactoryDelay(input: {
    supplierRelationId: string; supplierName?: string; delayDays: number;
    reason?: DelayReason; reasonNote?: string; registeredBy?: string;
  }, endpoint?: string): Promise<{ record: FactoryDelayRecord; impact: DelayImpactResult; qualityScoreLinked: boolean }> {
    const data = await requestJson<{ record: FactoryDelayRecord; impact: DelayImpactResult; qualityScoreLinked: boolean }>(
      '/v1/suppliers/delays', { endpoint, method: 'POST', body: JSON.stringify(input) });
    return { record: data.record, impact: data.impact, qualityScoreLinked: data.qualityScoreLinked };
  },
  async listFactoryDelays(params: { supplierRelationId?: string; limit?: number } = {}, endpoint?: string): Promise<FactoryDelayRecord[]> {
    const query = new URLSearchParams();
    if (params.supplierRelationId) query.set('supplierRelationId', params.supplierRelationId);
    if (params.limit) query.set('limit', String(params.limit));
    const qs = query.toString();
    const data = await requestJson<{ items: FactoryDelayRecord[] }>(`/v1/suppliers/delays${qs ? '?' + qs : ''}`, { endpoint, method: 'GET' });
    return data.items ?? [];
  },

  // FactoryCapacity 产能日历
  async listFactoryCapacity(factoryId: string, endpoint?: string): Promise<FactoryCapacity[]> {
    const data = await requestJson<{ items: FactoryCapacity[] }>(`/v1/suppliers/${encodeURIComponent(factoryId)}/capacity`, { endpoint, method: 'GET' });
    return data.items ?? [];
  },
  async upsertFactoryCapacity(factoryId: string, month: string, input: { capacity: number; unit?: string | null; note?: string | null }, endpoint?: string): Promise<FactoryCapacity> {
    const data = await requestJson<{ item: FactoryCapacity }>(`/v1/suppliers/${encodeURIComponent(factoryId)}/capacity/${encodeURIComponent(month)}`, { endpoint, method: 'PUT', body: JSON.stringify(input) });
    return data.item;
  },
  async deleteFactoryCapacity(factoryId: string, month: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/suppliers/${encodeURIComponent(factoryId)}/capacity/${encodeURIComponent(month)}`, { endpoint, method: 'DELETE' });
  },

  // 工厂 360° 总览
  async getFactoryOverview(factoryId: string, endpoint?: string): Promise<FactoryOverview | null> {
    try {
      const data = await requestJson<FactoryOverview>(`/v1/suppliers/${encodeURIComponent(factoryId)}/overview`, { endpoint, method: 'GET' });
      return data;
    } catch { return null; }
  },

  // ── 阶段 H H2: 季节性与趋势管理 Season & Trend Management API ──
  // Season 季度
  async listSeasons(params?: { status?: string; search?: string; limit?: number }, endpoint?: string): Promise<{ items: Season[]; total: number }> {
    const query = new URLSearchParams();
    if (params?.status) query.set('status', params.status);
    if (params?.search) query.set('search', params.search);
    if (params?.limit != null) query.set('limit', String(params.limit));
    const qs = query.toString();
    const data = await requestJson<{ items: Season[]; total: number }>(`/v1/seasons${qs ? '?' + qs : ''}`, { endpoint, method: 'GET' });
    return { items: data.items ?? [], total: data.total ?? 0 };
  },
  async createSeason(input: SeasonInput, endpoint?: string): Promise<Season> {
    const data = await requestJson<{ ok: boolean; item: Season }>(`/v1/seasons`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.item;
  },
  async getSeason(id: string, endpoint?: string): Promise<Season | null> {
    try {
      const data = await requestJson<{ item: Season }>(`/v1/seasons/${encodeURIComponent(id)}`, { endpoint, method: 'GET' });
      return data.item;
    } catch { return null; }
  },
  async updateSeason(id: string, patch: SeasonPatch, endpoint?: string): Promise<Season> {
    const data = await requestJson<{ ok: boolean; item: Season }>(`/v1/seasons/${encodeURIComponent(id)}`, { endpoint, method: 'PATCH', body: JSON.stringify(patch) });
    return data.item;
  },
  async deleteSeason(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/seasons/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },
  async getSeasonReview(id: string, endpoint?: string): Promise<SeasonReview | null> {
    try {
      const data = await requestJson<{ review: SeasonReview | null }>(`/v1/seasons/${encodeURIComponent(id)}/review`, { endpoint, method: 'GET' });
      return data.review;
    } catch { return null; }
  },
  async generateSeasonReview(id: string, endpoint?: string): Promise<SeasonReview> {
    const data = await requestJson<{ ok: boolean; review: SeasonReview }>(`/v1/seasons/${encodeURIComponent(id)}/review`, { endpoint, method: 'POST' });
    return data.review;
  },

  // TrendTag 趋势标签
  async listTrendTags(params?: { seasonId?: string; type?: string }, endpoint?: string): Promise<TrendTag[]> {
    const query = new URLSearchParams();
    if (params?.seasonId) query.set('seasonId', params.seasonId);
    if (params?.type) query.set('type', params.type);
    const qs = query.toString();
    const data = await requestJson<{ items: TrendTag[]; total?: number }>(`/v1/seasons/trends${qs ? '?' + qs : ''}`, { endpoint, method: 'GET' });
    return data.items ?? [];
  },
  async createTrendTag(input: TrendTagInput, endpoint?: string): Promise<TrendTag> {
    const data = await requestJson<{ ok: boolean; item: TrendTag }>(`/v1/seasons/trends`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.item;
  },
  async updateTrendTag(tagId: string, patch: TrendTagPatch, endpoint?: string): Promise<TrendTag> {
    const data = await requestJson<{ ok: boolean; item: TrendTag }>(`/v1/seasons/trends/${encodeURIComponent(tagId)}`, { endpoint, method: 'PATCH', body: JSON.stringify(patch) });
    return data.item;
  },
  async deleteTrendTag(tagId: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/seasons/trends/${encodeURIComponent(tagId)}`, { endpoint, method: 'DELETE' });
  },
  async linkTrendFabric(tagId: string, input: { fabricId: string; note?: string | null }, endpoint?: string): Promise<TrendTagFabricLink> {
    const data = await requestJson<{ ok: boolean; item: TrendTagFabricLink }>(`/v1/seasons/trends/${encodeURIComponent(tagId)}/fabrics`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.item;
  },
  async unlinkTrendFabric(tagId: string, fabricId: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/seasons/trends/${encodeURIComponent(tagId)}/fabrics/${encodeURIComponent(fabricId)}`, { endpoint, method: 'DELETE' });
  },
  async listTrendingFabrics(seasonId?: string, endpoint?: string): Promise<TrendingFabricItem[]> {
    const qs = seasonId ? `?seasonId=${encodeURIComponent(seasonId)}` : '';
    const data = await requestJson<{ items: TrendingFabricItem[] }>(`/v1/seasons/trending-fabrics${qs}`, { endpoint, method: 'GET' });
    return data.items ?? [];
  },

  // TradeShow 展会
  async listTradeShows(params?: { seasonId?: string; status?: string }, endpoint?: string): Promise<TradeShow[]> {
    const query = new URLSearchParams();
    if (params?.seasonId) query.set('seasonId', params.seasonId);
    if (params?.status) query.set('status', params.status);
    const qs = query.toString();
    const data = await requestJson<{ items: TradeShow[]; total?: number }>(`/v1/seasons/shows${qs ? '?' + qs : ''}`, { endpoint, method: 'GET' });
    return data.items ?? [];
  },
  async createTradeShow(input: TradeShowInput, endpoint?: string): Promise<TradeShow> {
    const data = await requestJson<{ ok: boolean; item: TradeShow }>(`/v1/seasons/shows`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.item;
  },
  async getTradeShow(showId: string, endpoint?: string): Promise<{ item: TradeShow; roi: TradeShowROI } | null> {
    try {
      const data = await requestJson<{ item: TradeShow; roi: TradeShowROI }>(`/v1/seasons/shows/${encodeURIComponent(showId)}`, { endpoint, method: 'GET' });
      return data;
    } catch { return null; }
  },
  async updateTradeShow(showId: string, patch: TradeShowPatch, endpoint?: string): Promise<TradeShow> {
    const data = await requestJson<{ ok: boolean; item: TradeShow }>(`/v1/seasons/shows/${encodeURIComponent(showId)}`, { endpoint, method: 'PATCH', body: JSON.stringify(patch) });
    return data.item;
  },
  async deleteTradeShow(showId: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/seasons/shows/${encodeURIComponent(showId)}`, { endpoint, method: 'DELETE' });
  },
  async getTradeShowROI(showId: string, endpoint?: string): Promise<TradeShowROI | null> {
    try {
      const data = await requestJson<TradeShowROI>(`/v1/seasons/shows/${encodeURIComponent(showId)}/roi`, { endpoint, method: 'GET' });
      return data;
    } catch { return null; }
  },

  // TradeShowLead 展会线索
  async addTradeShowLead(showId: string, input: TradeShowLeadInput, endpoint?: string): Promise<TradeShowLead> {
    const data = await requestJson<{ ok: boolean; item: TradeShowLead }>(`/v1/seasons/shows/${encodeURIComponent(showId)}/leads`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.item;
  },
  async updateTradeShowLead(leadId: string, patch: TradeShowLeadPatch, endpoint?: string): Promise<TradeShowLead> {
    const data = await requestJson<{ ok: boolean; item: TradeShowLead }>(`/v1/seasons/leads/${encodeURIComponent(leadId)}`, { endpoint, method: 'PATCH', body: JSON.stringify(patch) });
    return data.item;
  },
  async deleteTradeShowLead(leadId: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/seasons/leads/${encodeURIComponent(leadId)}`, { endpoint, method: 'DELETE' });
  },
  async convertTradeShowLead(leadId: string, relationId: string, endpoint?: string): Promise<TradeShowLead> {
    const data = await requestJson<{ ok: boolean; item: TradeShowLead }>(`/v1/seasons/leads/${encodeURIComponent(leadId)}/convert`, { endpoint, method: 'POST', body: JSON.stringify({ relationId }) });
    return data.item;
  },

  // ── 阶段 H H3: 风险管理与合规 Risk & Compliance API ──
  // 预警中心 RiskAlert
  async getRiskOverview(endpoint?: string): Promise<RiskOverview> {
    const data = await requestJson<RiskOverview>(`/v1/risk/overview`, { endpoint, method: 'GET' });
    return { openByType: data.openByType ?? {}, openByLevel: data.openByLevel ?? {}, recent: data.recent ?? [] };
  },
  async listRiskAlerts(params?: { type?: string; level?: string; status?: string; limit?: number; offset?: number }, endpoint?: string): Promise<{ items: RiskAlert[]; total: number }> {
    const query = new URLSearchParams();
    if (params?.type) query.set('type', params.type);
    if (params?.level) query.set('level', params.level);
    if (params?.status) query.set('status', params.status);
    if (params?.limit != null) query.set('limit', String(params.limit));
    if (params?.offset != null) query.set('offset', String(params.offset));
    const qs = query.toString();
    const data = await requestJson<{ items: RiskAlert[]; total: number }>(`/v1/risk/alerts${qs ? '?' + qs : ''}`, { endpoint, method: 'GET' });
    return { items: data.items ?? [], total: data.total ?? 0 };
  },
  async updateRiskAlertStatus(id: string, status: RiskAlertStatus, endpoint?: string): Promise<RiskAlert> {
    const data = await requestJson<{ ok: boolean; item: RiskAlert }>(`/v1/risk/alerts/${encodeURIComponent(id)}`, { endpoint, method: 'PATCH', body: JSON.stringify({ status }) });
    return data.item;
  },

  // ExchangeRate 汇率
  async listExchangeRates(params?: { currency?: string; limit?: number }, endpoint?: string): Promise<ExchangeRate[]> {
    const query = new URLSearchParams();
    if (params?.currency) query.set('currency', params.currency);
    if (params?.limit != null) query.set('limit', String(params.limit));
    const qs = query.toString();
    const data = await requestJson<{ items: ExchangeRate[]; total?: number }>(`/v1/risk/fx-rates${qs ? '?' + qs : ''}`, { endpoint, method: 'GET' });
    return data.items ?? [];
  },
  async getLatestFxRates(endpoint?: string): Promise<LatestFxRate[]> {
    const data = await requestJson<{ items: LatestFxRate[] }>(`/v1/risk/fx-rates-latest`, { endpoint, method: 'GET' });
    return data.items ?? [];
  },
  async addExchangeRate(input: ExchangeRateInput, endpoint?: string): Promise<ExchangeRate> {
    const data = await requestJson<{ ok: boolean; item: ExchangeRate }>(`/v1/risk/fx-rates`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.item;
  },

  /** M7：禁运国清单读取（source=config 数据库配置 / default 内置默认回退） */
  async getSanctionedCountries(endpoint?: string): Promise<{ items: string[]; source: 'config' | 'default' }> {
    return requestJson<{ items: string[]; source: 'config' | 'default' }>(`/v1/risk/sanctioned-countries`, { endpoint, method: 'GET' });
  },
  /** M7：禁运国清单更新（risk:write；变更落 SystemConfigHistory） */
  async updateSanctionedCountries(items: string[], reason?: string, endpoint?: string): Promise<{ items: string[]; source: 'config' | 'default' }> {
    return requestJson<{ items: string[]; source: 'config' | 'default' }>(`/v1/risk/sanctioned-countries`, { endpoint, method: 'PUT', body: JSON.stringify({ items, reason }) });
  },

  // FxRateLock 汇率锁定
  async listFxLocks(orderId?: string, endpoint?: string): Promise<FxRateLock[]> {
    const qs = orderId ? `?orderId=${encodeURIComponent(orderId)}` : '';
    const data = await requestJson<{ items: FxRateLock[]; total?: number }>(`/v1/risk/fx-locks${qs}`, { endpoint, method: 'GET' });
    return data.items ?? [];
  },
  async lockFxRate(input: FxRateLockInput, endpoint?: string): Promise<FxRateLock> {
    const data = await requestJson<{ ok: boolean; item: FxRateLock }>(`/v1/risk/fx-locks`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.item;
  },
  async deleteFxLock(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/risk/fx-locks/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },

  // CreditRating 信用评级
  async listCreditRatings(params?: { relationId?: string; latestOnly?: boolean }, endpoint?: string): Promise<CreditRating[]> {
    const query = new URLSearchParams();
    if (params?.relationId) query.set('relationId', params.relationId);
    if (params?.latestOnly != null) query.set('latestOnly', String(params.latestOnly));
    const qs = query.toString();
    const data = await requestJson<{ items: CreditRating[]; total?: number }>(`/v1/risk/credit-ratings${qs ? '?' + qs : ''}`, { endpoint, method: 'GET' });
    return data.items ?? [];
  },
  async evaluateCreditRating(relationId: string, endpoint?: string): Promise<CreditRating> {
    const data = await requestJson<{ ok: boolean; item: CreditRating }>(`/v1/risk/credit-ratings/evaluate`, { endpoint, method: 'POST', body: JSON.stringify({ relationId }) });
    return data.item;
  },
  async runCreditRiskScan(endpoint?: string): Promise<{ frozenCount: number; badDebtCount: number }> {
    const data = await requestJson<{ ok: boolean; frozenCount: number; badDebtCount: number }>(`/v1/risk/credit-risk-scan`, { endpoint, method: 'POST' });
    return { frozenCount: data.frozenCount ?? 0, badDebtCount: data.badDebtCount ?? 0 };
  },

  // ComplianceCheck 合规检查
  async listComplianceChecks(params?: { type?: string; result?: string; targetType?: string; targetId?: string }, endpoint?: string): Promise<ComplianceCheck[]> {
    const query = new URLSearchParams();
    if (params?.type) query.set('type', params.type);
    if (params?.result) query.set('result', params.result);
    if (params?.targetType) query.set('targetType', params.targetType);
    if (params?.targetId) query.set('targetId', params.targetId);
    const qs = query.toString();
    const data = await requestJson<{ items: ComplianceCheck[]; total?: number }>(`/v1/risk/compliance-checks${qs ? '?' + qs : ''}`, { endpoint, method: 'GET' });
    return data.items ?? [];
  },
  async runHsCodeCheck(declarationId: string, endpoint?: string): Promise<ComplianceCheck> {
    const data = await requestJson<{ ok: boolean; item: ComplianceCheck }>(`/v1/risk/compliance-checks/hs-code`, { endpoint, method: 'POST', body: JSON.stringify({ declarationId }) });
    return data.item;
  },
  async runExportControlCheck(declarationId: string, endpoint?: string): Promise<ComplianceCheck> {
    const data = await requestJson<{ ok: boolean; item: ComplianceCheck }>(`/v1/risk/compliance-checks/export-control`, { endpoint, method: 'POST', body: JSON.stringify({ declarationId }) });
    return data.item;
  },
  async addComplianceCheck(input: ComplianceCheckInput, endpoint?: string): Promise<ComplianceCheck> {
    const data = await requestJson<{ ok: boolean; item: ComplianceCheck }>(`/v1/risk/compliance-checks`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.item;
  },

  // 质量 Quality 疵点趋势
  async getDefectTrends(groupBy: 'factory' | 'quarter', endpoint?: string): Promise<DefectTrendItem[]> {
    const data = await requestJson<{ items: DefectTrendItem[] }>(`/v1/risk/quality/defect-trends?groupBy=${encodeURIComponent(groupBy)}`, { endpoint, method: 'GET' });
    return data.items ?? [];
  },
  async runQualityRepeatScan(endpoint?: string): Promise<{ alerted: number }> {
    const data = await requestJson<{ ok: boolean; alerted: number }>(`/v1/risk/quality/repeat-scan`, { endpoint, method: 'POST' });
    return { alerted: data.alerted ?? 0 };
  },

  // ── 阶段 P0: 业务线配置 BusinessLine API ──
  async listBusinessLines(endpoint?: string): Promise<BusinessLine[]> {
    const data = await requestJson<{ items: BusinessLine[]; total?: number }>(`/v1/business-lines`, { endpoint, method: 'GET' });
    return data.items ?? [];
  },
  async createBusinessLine(input: BusinessLineInput, endpoint?: string): Promise<BusinessLine> {
    const data = await requestJson<{ ok: boolean; item: BusinessLine }>(`/v1/business-lines`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.item;
  },
  async updateBusinessLine(id: string, patch: BusinessLinePatch, endpoint?: string): Promise<BusinessLine> {
    const data = await requestJson<{ ok: boolean; item: BusinessLine }>(`/v1/business-lines/${encodeURIComponent(id)}`, { endpoint, method: 'PATCH', body: JSON.stringify(patch) });
    return data.item;
  },
  async deleteBusinessLine(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/business-lines/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },
  async setOrderBusinessLine(orderId: string, businessLine: string | null, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/business-lines/order/${encodeURIComponent(orderId)}`, { endpoint, method: 'PUT', body: JSON.stringify({ businessLine }) });
  },
  async checkOrderMoq(orderId: string, endpoint?: string): Promise<QcMoqCheckResult> {
    return requestJson<QcMoqCheckResult>(`/v1/business-lines/order/${encodeURIComponent(orderId)}/moq-check`, { endpoint, method: 'GET' });
  },

  // ── 阶段 P0: QC 驻地 QCLocation API ──
  async listQcLocations(endpoint?: string): Promise<QCLocation[]> {
    const data = await requestJson<{ items: QCLocation[]; total?: number }>(`/v1/qc/locations`, { endpoint, method: 'GET' });
    return data.items ?? [];
  },
  async createQcLocation(input: QCLocationInput, endpoint?: string): Promise<QCLocation> {
    const data = await requestJson<{ ok: boolean; item: QCLocation }>(`/v1/qc/locations`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.item;
  },
  async updateQcLocation(id: string, patch: QCLocationPatch, endpoint?: string): Promise<QCLocation> {
    const data = await requestJson<{ ok: boolean; item: QCLocation }>(`/v1/qc/locations/${encodeURIComponent(id)}`, { endpoint, method: 'PATCH', body: JSON.stringify(patch) });
    return data.item;
  },
  async deleteQcLocation(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/qc/locations/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },

  // ── 阶段 P0: QC 验货任务 QCAssignment API ──
  async listQcAssignments(params?: { qcUserId?: string; status?: string; orderId?: string; locationId?: string; dueBefore?: string }, endpoint?: string): Promise<QCAssignment[]> {
    const query = new URLSearchParams();
    if (params?.qcUserId) query.set('qcUserId', params.qcUserId);
    if (params?.status) query.set('status', params.status);
    if (params?.orderId) query.set('orderId', params.orderId);
    if (params?.locationId) query.set('locationId', params.locationId);
    if (params?.dueBefore) query.set('dueBefore', params.dueBefore);
    const qs = query.toString();
    const data = await requestJson<{ items: QCAssignment[]; total?: number }>(`/v1/qc/assignments${qs ? '?' + qs : ''}`, { endpoint, method: 'GET' });
    return data.items ?? [];
  },
  async createQcAssignment(input: QCAssignmentInput, endpoint?: string): Promise<QCAssignment> {
    const data = await requestJson<{ ok: boolean; item: QCAssignment }>(`/v1/qc/assignments`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.item;
  },
  async updateQcAssignment(id: string, patch: QCAssignmentPatch, endpoint?: string): Promise<QCAssignment> {
    const data = await requestJson<{ ok: boolean; item: QCAssignment }>(`/v1/qc/assignments/${encodeURIComponent(id)}`, { endpoint, method: 'PATCH', body: JSON.stringify(patch) });
    return data.item;
  },
  async deleteQcAssignment(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/qc/assignments/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },
  async startQcAssignment(id: string, endpoint?: string): Promise<QCAssignment> {
    const data = await requestJson<{ ok: boolean; item: QCAssignment }>(`/v1/qc/assignments/${encodeURIComponent(id)}/start`, { endpoint, method: 'POST' });
    return data.item;
  },
  async completeQcAssignment(id: string, reportId?: string, endpoint?: string): Promise<QCAssignment> {
    const data = await requestJson<{ ok: boolean; item: QCAssignment }>(`/v1/qc/assignments/${encodeURIComponent(id)}/complete`, { endpoint, method: 'POST', body: JSON.stringify({ reportId: reportId ?? null }) });
    return data.item;
  },
  async cancelQcAssignment(id: string, endpoint?: string): Promise<QCAssignment> {
    const data = await requestJson<{ ok: boolean; item: QCAssignment }>(`/v1/qc/assignments/${encodeURIComponent(id)}/cancel`, { endpoint, method: 'POST' });
    return data.item;
  },
  async getQcWorkbench(qcUserId?: string, endpoint?: string): Promise<QcWorkbenchData> {
    const qs = qcUserId ? `?qcUserId=${encodeURIComponent(qcUserId)}` : '';
    const data = await requestJson<{ assigned: QCAssignment[]; inProgress: QCAssignment[]; completed: QCAssignment[] }>(`/v1/qc/workbench${qs}`, { endpoint, method: 'GET' });
    return { assigned: data.assigned ?? [], inProgress: data.inProgress ?? [], completed: data.completed ?? [] };
  },

  // ── HR 模块（组织架构/团队/项目/工作分配）统一通道 ──
  async hrGet<T>(path: string, endpoint?: string): Promise<T> {
    return hrRequest<T>(path, { endpoint, method: 'GET' });
  },

  async hrSend<T>(path: string, body: unknown, method: 'POST' | 'PATCH' | 'DELETE' = 'POST', endpoint?: string): Promise<T> {
    return hrRequest<T>(path, { endpoint, method, body: JSON.stringify(body) });
  },

  // QC 人员选择器 / 审批委派选人：最小方法，复用已挂载的 /api/hr/personnel（UserAccount 聚合视图）
  // 该端点要求 owner/admin 角色；调用方需在失败时降级为手工录入用户 ID
  async listUserAccounts(endpoint?: string): Promise<UserAccountDirectoryOption[]> {
    const data = await hrRequest<{
      ok: boolean;
      personnel?: Array<{ id: string; displayName: string; email?: string | null; status?: string | null; department?: string | null; roles?: string[] | null }>;
    }>('personnel', { endpoint, method: 'GET' });
    const personnel = Array.isArray(data.personnel) ? data.personnel : [];
    return personnel
      .filter((u) => u && u.id && u.status !== 'disabled')
      .map((u) => ({
        id: u.id,
        displayName: u.displayName,
        email: u.email ?? null,
        status: u.status ?? null,
        department: u.department ?? null,
        roles: Array.isArray(u.roles) ? u.roles : null,
      }));
  },

  // ── 阶段 P1: 退税率表 TaxRefundRate API ──
  /**
   * ★ D6（2026-09-18）远期结汇合约一览（GET /v1/finance/forward-fx）
   *
   * 为什么需要：本仓已有订单级锁汇（`FxRateLock`）与结汇水单（`FxSettlement`），
   * 缺**与银行的远期合约** ⇒ 到期日没人管、合约汇率 vs 实际结汇汇率的**损益**算不出来。
   */
  async listForwardFxContracts(params?: { currency?: string; includeCancelled?: boolean }, endpoint?: string): Promise<{
    rows: Array<{
      id: string; contractNumber: string; bankName: string | null; currency: string;
      foreignAmount: number; contractRate: number; settledForeignAmount: number; remainingForeignAmount: number;
      status: string; statusLabel: string; signedDate: string; maturityDate: string;
      daysToMaturity: number | null; realizedPnlCny: number;
    }>;
  }> {
    const query = new URLSearchParams();
    if (params?.currency) query.set('currency', params.currency);
    if (params?.includeCancelled) query.set('includeCancelled', 'true');
    const qs = query.toString();
    return requestJson(`/v1/finance/forward-fx${qs ? `?${qs}` : ''}`, { endpoint, method: 'GET' });
  },

  /** ★ D6 登记远期合约（POST /v1/finance/forward-fx） */
  async createForwardFxContract(input: {
    contractNumber: string; bankRelationId?: string | null; bankName?: string | null;
    currency: string; foreignAmount: number | string; contractRate: number | string;
    signedDate: string; maturityDate: string; notes?: string | null;
  }, endpoint?: string): Promise<{ id: string; contractNumber: string; status: string }> {
    return requestJson('/v1/finance/forward-fx', { endpoint, method: 'POST', body: JSON.stringify(input) });
  },

  /**
   * ★ D6 用合约交割一笔结汇水单（POST /v1/finance/forward-fx/:id/settlements）
   * 返回 `pnlCny` =（实际结汇汇率 − 合约汇率）× 本次金额。
   */
  async settleForwardFx(contractId: string, input: { settlementId: string; foreignAmount: number | string; settleDate?: string }, endpoint?: string): Promise<{
    link: { id: string }; pnlCny: number | null; contract: { id: string; status: string; settledForeignAmount: number | string };
  }> {
    return requestJson(`/v1/finance/forward-fx/${encodeURIComponent(contractId)}/settlements`, {
      endpoint, method: 'POST', body: JSON.stringify(input),
    });
  },

  /**
   * ★ D4（2026-09-18）某订单的佣金应付视图（GET /v1/pricing/orders/:id/commission）
   *
   * 为什么需要：佣金在定价侧算得很细，但**只算不收** —— 没有任何地方能回答
   * 「这张单欠中间人多少佣金、开了没、付了没」。
   */
  async getOrderCommission(orderId: string, endpoint?: string): Promise<{
    orderId: string;
    lineCount: number;
    totalCommission: number;
    currency: string;
    intermediaryRelationId: string | null;
    intermediaryName: string | null;
    lines: Array<{ pricingId: string; unitCommission: number; quantity: number; amount: number; ruleId: string | null; rate: number | null }>;
    issues: string[];
    skippedRowCount: number;
    payableInvoices: Array<{ id: string; invoiceNumber: string; amount: number; currency: string; status: string; issueDate: string }>;
    invoicedAmount: number;
    uninvoicedAmount: number;
  }> {
    return requestJson(
      `/v1/pricing/orders/${encodeURIComponent(orderId)}/commission`,
      { endpoint, method: 'GET' },
    );
  },

  /**
   * ★ D4 开佣金应付发票（POST /v1/pricing/orders/:id/commission/payable）
   * 落地动作：复用既有应付链路（AP 账龄 / 付款 / 对账）⇒ 真正闭环。幂等：已有未作废票 → 409。
   */
  async createCommissionPayable(orderId: string, input?: { dueDate?: string | null; notes?: string | null }, endpoint?: string): Promise<{
    invoice: { id: string; invoiceNumber: string; amount: number | string; currency: string; status: string };
    commission: { uninvoicedAmount: number; invoicedAmount: number };
  }> {
    return requestJson(
      `/v1/pricing/orders/${encodeURIComponent(orderId)}/commission/payable`,
      { endpoint, method: 'POST', body: JSON.stringify(input ?? {}) },
    );
  },

  async listTaxRefundRates(includeInactive = false, endpoint?: string): Promise<TaxRefundRate[]> {
    const qs = includeInactive ? '?includeInactive=true' : '';
    const data = await requestJson<{ items: TaxRefundRate[]; total?: number }>(`/v1/pricing/tax-refund-rates${qs}`, { endpoint, method: 'GET' });
    return data.items ?? [];
  },
  async createTaxRefundRate(input: TaxRefundRateInput, endpoint?: string): Promise<TaxRefundRate> {
    const data = await requestJson<{ ok: boolean; item: TaxRefundRate }>(`/v1/pricing/tax-refund-rates`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.item;
  },
  async updateTaxRefundRate(id: string, patch: TaxRefundRatePatch, endpoint?: string): Promise<TaxRefundRate> {
    const data = await requestJson<{ ok: boolean; item: TaxRefundRate }>(`/v1/pricing/tax-refund-rates/${encodeURIComponent(id)}`, { endpoint, method: 'PATCH', body: JSON.stringify(patch) });
    return data.item;
  },
  async deleteTaxRefundRate(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/pricing/tax-refund-rates/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },
  async lookupTaxRefundRate(hsCode: string, endpoint?: string): Promise<{ hsCode: string; rate: number } | null> {
    const data = await requestJson<{ hit: { hsCode: string; rate: number } | null }>(`/v1/pricing/tax-refund-rates/lookup?hsCode=${encodeURIComponent(hsCode)}`, { endpoint, method: 'GET' });
    return data.hit ?? null;
  },

  // ── 阶段 P2: 轨道 A 系统估算 API（PRD 8.1/8.6） ──
  async previewTrackA(input: TrackAInput, endpoint?: string): Promise<TrackAResult> {
    return requestJson<TrackAResult>(`/v1/pricing/track-a-preview`, { endpoint, method: 'POST', body: JSON.stringify(input) });
  },

  // ── 阶段 P1: 轨道 B 定价 PricingCalculation API ──
  async previewTrackB(input: TrackBInput, endpoint?: string): Promise<TrackBResult> {
    return requestJson<TrackBResult>(`/v1/pricing/track-b-preview`, { endpoint, method: 'POST', body: JSON.stringify(input) });
  },

  // ── REQ2-22（DR-062）：面料计算器——六类行业换算/估算（纯计算零写路径，派生值后端单一真源） ──
  async calculateFabric(kind: string, input: Record<string, unknown>, endpoint?: string): Promise<Record<string, any>> {
    return requestJson<Record<string, any>>(`/v1/tools/fabric-calculator/calculate`, { endpoint, method: 'POST', body: JSON.stringify({ kind, ...input }) });
  },
  async listPricingCalculations(params?: { orderId?: string; quotationId?: string; status?: string }, endpoint?: string): Promise<PricingCalculation[]> {
    const query = new URLSearchParams();
    if (params?.orderId) query.set('orderId', params.orderId);
    if (params?.quotationId) query.set('quotationId', params.quotationId);
    if (params?.status) query.set('status', params.status);
    const qs = query.toString();
    const data = await requestJson<{ items: PricingCalculation[]; total?: number }>(`/v1/pricing/calculations${qs ? '?' + qs : ''}`, { endpoint, method: 'GET' });
    return data.items ?? [];
  },
  async createPricingCalculation(input: PricingCalculationInput, endpoint?: string): Promise<PricingCalculation> {
    const data = await requestJson<{ ok: boolean; item: PricingCalculation }>(`/v1/pricing/calculations`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.item;
  },
  async updatePricingCalculation(id: string, patch: PricingCalculationPatch, endpoint?: string): Promise<PricingCalculation> {
    const data = await requestJson<{ ok: boolean; item: PricingCalculation }>(`/v1/pricing/calculations/${encodeURIComponent(id)}`, { endpoint, method: 'PATCH', body: JSON.stringify(patch) });
    return data.item;
  },
  async deletePricingCalculation(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/pricing/calculations/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },

  // ── 阶段 P1: 订单利润表 OrderProfitSheet API ──
  async listProfitSheets(endpoint?: string): Promise<OrderProfitSheet[]> {
    const data = await requestJson<{ items: OrderProfitSheet[]; total?: number }>(`/v1/pricing/profit-sheets`, { endpoint, method: 'GET' });
    return data.items ?? [];
  },
  async generateProfitSheet(orderId: string, endpoint?: string): Promise<OrderProfitSheet> {
    const data = await requestJson<{ ok: boolean; item: OrderProfitSheet }>(`/v1/pricing/profit-sheets/generate/${encodeURIComponent(orderId)}`, { endpoint, method: 'POST' });
    return data.item;
  },
  async getProfitSheetByOrder(orderId: string, endpoint?: string): Promise<OrderProfitSheet | null> {
    try {
      const data = await requestJson<{ item: OrderProfitSheet }>(`/v1/pricing/profit-sheets/order/${encodeURIComponent(orderId)}`, { endpoint, method: 'GET' });
      return data.item ?? null;
    } catch {
      return null;
    }
  },
  async deleteProfitSheet(orderId: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/pricing/profit-sheets/order/${encodeURIComponent(orderId)}`, { endpoint, method: 'DELETE' });
  },

  /** 成本三环（2026-09-30）：报价估算 / BOM 目标 / 利润表实际 的只读对比。缺环在 missing[] 里如实披露。 */
  async getOrderCostRings(orderId: string, endpoint?: string): Promise<OrderCostRings> {
    const data = await requestJson<{ ok: boolean; item: OrderCostRings }>(`/v1/pricing/orders/${encodeURIComponent(orderId)}/cost-rings`, { endpoint, method: 'GET' });
    return data.item;
  },

  /** REQ2-14 海运费变动利润重估（DR-054：只读预览，受影响订单清单 + 三级建议） */
  async reestimateFreightImpact(multiplier: number, orderId?: string, endpoint?: string): Promise<FreightImpactResult> {
    const query = new URLSearchParams({ multiplier: String(multiplier) });
    if (orderId) query.set('orderId', orderId);
    return requestJson<FreightImpactResult>(`/v1/pricing/freight-impact?${query.toString()}`, { endpoint, method: 'GET' });
  },

  // ── 阶段 P1: 原材料价格 MaterialPriceHistory API ──
  async listMaterialPrices(params?: { materialType?: string; materialCode?: string; from?: string; to?: string }, endpoint?: string): Promise<MaterialPriceHistory[]> {
    const query = new URLSearchParams();
    if (params?.materialType) query.set('materialType', params.materialType);
    if (params?.materialCode) query.set('materialCode', params.materialCode);
    if (params?.from) query.set('from', params.from);
    if (params?.to) query.set('to', params.to);
    const qs = query.toString();
    const data = await requestJson<{ items: MaterialPriceHistory[]; total?: number }>(`/v1/pricing/material-prices${qs ? '?' + qs : ''}`, { endpoint, method: 'GET' });
    return data.items ?? [];
  },
  async createMaterialPrice(input: MaterialPriceInput, endpoint?: string): Promise<MaterialPriceHistory> {
    const data = await requestJson<{ ok: boolean; item: MaterialPriceHistory }>(`/v1/pricing/material-prices`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.item;
  },
  async updateMaterialPrice(id: string, patch: MaterialPricePatch, endpoint?: string): Promise<MaterialPriceHistory> {
    const data = await requestJson<{ ok: boolean; item: MaterialPriceHistory }>(`/v1/pricing/material-prices/${encodeURIComponent(id)}`, { endpoint, method: 'PATCH', body: JSON.stringify(patch) });
    return data.item;
  },
  async deleteMaterialPrice(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/pricing/material-prices/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },
  async getMaterialPriceTrend(params: { materialType: string; materialCode?: string; from?: string; to?: string }, endpoint?: string): Promise<MaterialPriceTrendPoint[]> {
    const query = new URLSearchParams({ materialType: params.materialType });
    if (params.materialCode) query.set('materialCode', params.materialCode);
    if (params.from) query.set('from', params.from);
    if (params.to) query.set('to', params.to);
    const data = await requestJson<{ items: MaterialPriceTrendPoint[] }>(`/v1/pricing/material-prices/trend?${query.toString()}`, { endpoint, method: 'GET' });
    return data.items ?? [];
  },

  // ── 阶段 P2: 佣金规则 CommissionRule API ──
  async listCommissionRules(includeInactive = false, endpoint?: string): Promise<CommissionRule[]> {
    const qs = includeInactive ? '?includeInactive=true' : '';
    const data = await requestJson<{ items: CommissionRule[]; total?: number }>(`/v1/pricing/commission-rules${qs}`, { endpoint, method: 'GET' });
    return data.items ?? [];
  },
  async createCommissionRule(input: CommissionRuleInput, endpoint?: string): Promise<CommissionRule> {
    const data = await requestJson<{ ok: boolean; item: CommissionRule }>(`/v1/pricing/commission-rules`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.item;
  },
  async updateCommissionRule(id: string, patch: CommissionRulePatch, endpoint?: string): Promise<CommissionRule> {
    const data = await requestJson<{ ok: boolean; item: CommissionRule }>(`/v1/pricing/commission-rules/${encodeURIComponent(id)}`, { endpoint, method: 'PATCH', body: JSON.stringify(patch) });
    return data.item;
  },
  async deleteCommissionRule(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/pricing/commission-rules/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },

  // ── 阶段 P2: 电子画册 LookbookCatalog API ──
  async listLookbooks(params?: { status?: string; limit?: number }, endpoint?: string): Promise<LookbookCatalog[]> {
    const query = new URLSearchParams();
    if (params?.status) query.set('status', params.status);
    if (params?.limit != null) query.set('limit', String(params.limit));
    const qs = query.toString();
    const data = await requestJson<{ items: LookbookCatalog[]; total?: number }>(`/v1/lookbooks${qs ? `?${qs}` : ''}`, { endpoint, method: 'GET' });
    return data.items ?? [];
  },
  async createLookbook(input: { title: string; description?: string | null }, endpoint?: string): Promise<LookbookCatalog> {
    const data = await requestJson<{ ok: boolean; item: LookbookCatalog }>(`/v1/lookbooks`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.item;
  },
  async getLookbook(id: string, endpoint?: string): Promise<LookbookCatalog> {
    const data = await requestJson<{ item: LookbookCatalog }>(`/v1/lookbooks/${encodeURIComponent(id)}`, { endpoint, method: 'GET' });
    return data.item;
  },
  async updateLookbook(id: string, patch: { title?: string; description?: string | null }, endpoint?: string): Promise<LookbookCatalog> {
    const data = await requestJson<{ ok: boolean; item: LookbookCatalog }>(`/v1/lookbooks/${encodeURIComponent(id)}`, { endpoint, method: 'PATCH', body: JSON.stringify(patch) });
    return data.item;
  },
  async setLookbookItems(id: string, items: LookbookItemInput[], endpoint?: string): Promise<LookbookCatalog> {
    const data = await requestJson<{ ok: boolean; item: LookbookCatalog }>(`/v1/lookbooks/${encodeURIComponent(id)}/items`, { endpoint, method: 'PUT', body: JSON.stringify({ items }) });
    return data.item;
  },
  async transitionLookbook(id: string, action: 'publish' | 'unpublish' | 'archive', endpoint?: string): Promise<LookbookCatalog> {
    const data = await requestJson<{ ok: boolean; item: LookbookCatalog }>(`/v1/lookbooks/${encodeURIComponent(id)}/${action}`, { endpoint, method: 'POST' });
    return data.item;
  },
  async deleteLookbook(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/lookbooks/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },

  // ── 阶段 P2: 面料推荐 FabricRecommendation API ──
  async recommendFabrics(criteria: RecommendCriteria, endpoint?: string): Promise<FabricRecommendation> {
    const data = await requestJson<{ ok: boolean; item: FabricRecommendation }>(`/v1/fabric-recommendations/recommend`, { endpoint, method: 'POST', body: JSON.stringify(criteria) });
    return data.item;
  },
  async listFabricRecommendations(params?: { limit?: number; offset?: number }, endpoint?: string): Promise<FabricRecommendation[]> {
    const query = new URLSearchParams();
    if (params?.limit != null) query.set('limit', String(params.limit));
    if (params?.offset != null) query.set('offset', String(params.offset));
    const qs = query.toString();
    const data = await requestJson<{ items: FabricRecommendation[]; total?: number }>(`/v1/fabric-recommendations${qs ? `?${qs}` : ''}`, { endpoint, method: 'GET' });
    return data.items ?? [];
  },
  async deleteFabricRecommendation(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/fabric-recommendations/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },

  // ── 营销活动管理 Marketing V2 API（/api/v2/marketing，Phase 1-06：campaigns CRUD + ROI + leads CRUD）──
  async listCampaigns(params?: { status?: string; type?: string; search?: string; limit?: number; offset?: number }, endpoint?: string): Promise<{ items: MarketingCampaign[]; total: number }> {
    const query = new URLSearchParams();
    if (params?.status) query.set('status', params.status);
    if (params?.type) query.set('type', params.type);
    if (params?.search) query.set('search', params.search);
    if (params?.limit != null) query.set('limit', String(params.limit));
    if (params?.offset != null) query.set('offset', String(params.offset));
    const qs = query.toString();
    const data = await requestJson<{ ok: boolean; items: MarketingCampaign[]; total: number }>(`/v2/marketing/campaigns${qs ? `?${qs}` : ''}`, { endpoint, method: 'GET' });
    const items = Array.isArray(data.items) ? data.items : [];
    return { items, total: typeof data.total === 'number' ? data.total : items.length };
  },
  async createCampaign(input: { name: string; description?: string | null; type?: string; status?: string; startDate?: string | null; endDate?: string | null; budget?: number | null; actualCost?: number | null }, endpoint?: string): Promise<MarketingCampaign> {
    const data = await requestJson<{ ok: boolean; campaign: MarketingCampaign }>(`/v2/marketing/campaigns`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.campaign;
  },
  async updateCampaign(id: string, patch: Partial<{ name: string; description: string | null; type: string; status: string; startDate: string | null; endDate: string | null; budget: number | null; actualCost: number | null }>, endpoint?: string): Promise<MarketingCampaign> {
    const data = await requestJson<{ ok: boolean; campaign: MarketingCampaign }>(`/v2/marketing/campaigns/${encodeURIComponent(id)}`, { endpoint, method: 'PUT', body: JSON.stringify(patch) });
    return data.campaign;
  },
  async deleteCampaign(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v2/marketing/campaigns/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },
  async getCampaignRoi(id: string, endpoint?: string): Promise<CampaignRoi> {
    const data = await requestJson<{ ok: boolean } & CampaignRoi>(`/v2/marketing/campaigns/${encodeURIComponent(id)}/roi`, { endpoint, method: 'GET' });
    return data;
  },
  async listLeads(campaignId: string, params?: { status?: string; limit?: number; offset?: number }, endpoint?: string): Promise<{ items: MarketingLead[]; total: number }> {
    const query = new URLSearchParams();
    if (params?.status) query.set('status', params.status);
    if (params?.limit != null) query.set('limit', String(params.limit));
    if (params?.offset != null) query.set('offset', String(params.offset));
    const qs = query.toString();
    const data = await requestJson<{ ok: boolean; items: MarketingLead[]; total: number }>(`/v2/marketing/campaigns/${encodeURIComponent(campaignId)}/leads${qs ? `?${qs}` : ''}`, { endpoint, method: 'GET' });
    const items = Array.isArray(data.items) ? data.items : [];
    return { items, total: typeof data.total === 'number' ? data.total : items.length };
  },
  async createLead(campaignId: string, input: { relationId?: string | null; source?: string | null; contactName?: string | null; contactEmail?: string | null; contactPhone?: string | null; status?: string; estimatedValue?: number | null; notes?: string | null }, endpoint?: string): Promise<MarketingLead> {
    const data = await requestJson<{ ok: boolean; lead: MarketingLead }>(`/v2/marketing/campaigns/${encodeURIComponent(campaignId)}/leads`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.lead;
  },
  async updateLead(id: string, patch: Partial<{ relationId: string | null; source: string | null; contactName: string | null; contactEmail: string | null; contactPhone: string | null; status: string; estimatedValue: number | null; actualValue: number | null; notes: string | null }>, endpoint?: string): Promise<MarketingLead> {
    const data = await requestJson<{ ok: boolean; lead: MarketingLead }>(`/v2/marketing/leads/${encodeURIComponent(id)}`, { endpoint, method: 'PUT', body: JSON.stringify(patch) });
    return data.lead;
  },
  async deleteLead(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v2/marketing/leads/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },

  async listDevelopmentCases(endpoint?: string, params?: { limit?: number; offset?: number }): Promise<DevelopmentCase[]> {
    const page = await this.listDevelopmentCasesPage(endpoint, params);
    return page.items;
  },

  /** 开发案列表分页口径（/v1/development 后端默认 50 截断，上限 200）：透传 limit/offset 并返回 total */
  async listDevelopmentCasesPage(endpoint?: string, params?: { limit?: number; offset?: number }): Promise<{ items: DevelopmentCase[]; total: number }> {
    const query = new URLSearchParams();
    if (params?.limit != null) query.set('limit', String(params.limit));
    if (params?.offset != null) query.set('offset', String(params.offset));
    const qs = query.toString();
    const data = await requestJson<{ ok: boolean; cases: DevelopmentCase[]; total: number }>(`/v1/development${qs ? `?${qs}` : ''}`, { endpoint, method: 'GET' });
    const items = Array.isArray(data.cases) ? data.cases : [];
    return { items, total: typeof data.total === 'number' ? data.total : items.length };
  },

  /**
   * 客户档案列表（V2 三层视野，DR-042 v2.2）：L1 档案图书馆化——
   * normal 档案全公司可查 + confidential 仅本人维；条目携带 sensitivity 与 teamShares 徽章数据。
   * 旧 V1 端点无行级过滤（未设防的全可见），已切换至 V2 设计过的图书馆口径。
   * bizScope='mine'：L2 业务口径（P1-001）——followedBy ∪ teamGranted，
   * 供 CRM 等业务页下拉使用，防止默认选中无权客户触发 403。
   */
  async listRelations(endpoint?: string, params?: { bizScope?: 'mine'; limit?: number; offset?: number }): Promise<Relation[]> {
    const page = await this.listRelationsPage(endpoint, params);
    return page.items;
  },

  /** 客户档案分页口径（V2 三层视野）：透传 limit/offset 并返回 total；listRelations 保持数组返回不破坏既有调用方 */
  async listRelationsPage(endpoint?: string, params?: { bizScope?: 'mine'; limit?: number; offset?: number }): Promise<{ items: Relation[]; total: number }> {
    const query = new URLSearchParams();
    query.set('limit', String(params?.limit ?? 500));
    if (params?.offset != null) query.set('offset', String(params.offset));
    if (params?.bizScope === 'mine') query.set('bizScope', 'mine');
    const data = await requestJson<{ ok: boolean; items: Relation[]; total: number }>(`/v2/relations?${query.toString()}`, { endpoint, method: 'GET' });
    const items = Array.isArray(data.items) ? data.items : [];
    return { items, total: typeof data.total === 'number' ? data.total : items.length };
  },

  /**
   * 新建客户档案（V2 行级口径）：服务端自动填充归属三键——
   * ownerId=当前登录人、departmentId=归属部门、salesRepIds=[owner]、code=CUS-xxxxx。
   * 旧 V1 端点不填归属，建档后创建者在本人维视野里看不到自己的客户（已废弃）。
   */
  async saveRelation(relation: Relation, endpoint?: string): Promise<Relation> {
    const data = await requestJson<{ ok: boolean; relation: Relation }>('/v2/relations', {
      endpoint,
      method: 'POST',
      body: JSON.stringify(relation),
    });
    return data.relation;
  },

  /** 更新客户档案（V2 行级口径：写 scope 校验——本人/全权角色可改，组共享只读） */
  async updateRelation(id: string, relation: Partial<Relation>, endpoint?: string): Promise<Relation> {
    const data = await requestJson<{ ok: boolean; relation: Relation }>(`/v2/relations/${encodeURIComponent(id)}`, {
      endpoint,
      method: 'PUT',
      body: JSON.stringify(relation),
    });
    return data.relation;
  },

  /** 关系智库档案受控导出——GET /v2/relations/export.csv（REQ2-13 SEC-01：服务端 data:export:full 门禁 + 审计留痕） */
  async exportRelationsCsv(params?: { category?: string; stage?: string; tier?: string; isOrganization?: boolean }, endpoint?: string): Promise<void> {
    const query = new URLSearchParams();
    if (params?.category) query.set('category', params.category);
    if (params?.stage) query.set('stage', params.stage);
    if (params?.tier) query.set('tier', params.tier);
    if (params?.isOrganization !== undefined) query.set('isOrganization', String(params.isOrganization));
    const qs = query.toString();
    const url = buildApiUrl(`/v2/relations/export.csv${qs ? `?${qs}` : ''}`, endpoint);
    const res = await fetch(url, { headers: this.getAuthHeaders() });
    if (!res.ok) {
      // 受控导出常见失败为 403（无 data:export:full scope）——尽力解析服务端 JSON 错误文案
      let message = `HTTP ${res.status}`;
      try {
        const data = await res.clone().json();
        if (data?.message) message = String(data.message);
      } catch { /* 保留 HTTP 状态码兜底 */ }
      throw new Error(`关系档案导出失败：${message}`);
    }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
    const filename = m && m[1] ? decodeURIComponent(m[1]) : `relations-${businessNowDate().toISOString().slice(0, 10)}.csv`;
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  },

  async deleteRelation(id: string, endpoint?: string): Promise<Relation> {
    const data = await requestJson<{ ok: boolean; relation: Relation }>(`/v2/relations/${encodeURIComponent(id)}`, {
      endpoint,
      method: 'DELETE',
    });
    return data.relation;
  },

  // ── 联系人体系统一：Contact 表 CRUD（/v1/relations/:id/contacts）──────────
  // 联系人唯一真源为 Contact 表（合约类型复用 types.ts 的 Contact）；
  // 列表排序 isPrimary desc + name asc，软删行服务端已排除。

  /** 按组织拉取 Contact 表通讯录（拉取失败由调用方降级 Relation 人物子行推导） */
  async listRelationContacts(relationId: string, endpoint?: string): Promise<Contact[]> {
    const data = await requestJson<{ ok: boolean; contacts: Contact[] }>(`/v1/relations/${encodeURIComponent(relationId)}/contacts`, { endpoint, method: 'GET' });
    return Array.isArray(data.contacts) ? data.contacts : [];
  },

  /** 新建组织联系人（服务端校验 name 必填 + 挂靠组织存在） */
  async createRelationContact(relationId: string, contact: Partial<Contact>, endpoint?: string): Promise<Contact> {
    const data = await requestJson<{ ok: boolean; contact: Contact }>(`/v1/relations/${encodeURIComponent(relationId)}/contacts`, {
      endpoint,
      method: 'POST',
      body: JSON.stringify(contact),
    });
    return data.contact;
  },

  /** 部分更新联系人（仅显式字段参与更新） */
  async updateRelationContact(relationId: string, contactId: string, patch: Partial<Contact>, endpoint?: string): Promise<Contact> {
    const data = await requestJson<{ ok: boolean; contact: Contact }>(`/v1/relations/${encodeURIComponent(relationId)}/contacts/${encodeURIComponent(contactId)}`, {
      endpoint,
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    return data.contact;
  },

  /** 删除联系人（服务端软删 deletedAt） */
  async deleteRelationContact(relationId: string, contactId: string, endpoint?: string): Promise<Contact> {
    const data = await requestJson<{ ok: boolean; contact: Contact }>(`/v1/relations/${encodeURIComponent(relationId)}/contacts/${encodeURIComponent(contactId)}`, {
      endpoint,
      method: 'DELETE',
    });
    return data.contact;
  },

  async listBusinessProfiles<TPayload = Record<string, unknown>, TAssets = Record<string, unknown>>(
    kind: string,
    endpoint?: string,
  ): Promise<Array<BusinessProfile<TPayload, TAssets>>> {
    const query = new URLSearchParams();
    if (kind) query.set('kind', kind);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    const data = await requestJson<{ ok: boolean; profiles: Array<BusinessProfile<TPayload, TAssets>> }>(
      `/v1/business-profiles${suffix}`,
      { endpoint, method: 'GET' },
    );
    return Array.isArray(data.profiles) ? data.profiles : [];
  },

  async saveBusinessProfile<TPayload = Record<string, unknown>, TAssets = Record<string, unknown>>(
    profile: BusinessProfileInput<TPayload, TAssets>,
    endpoint?: string,
  ): Promise<BusinessProfile<TPayload, TAssets>> {
    const data = await requestJson<{ ok: boolean; profile: BusinessProfile<TPayload, TAssets> }>(
      '/v1/business-profiles',
      {
        endpoint,
        method: 'POST',
        body: JSON.stringify(profile),
      },
    );
    return data.profile;
  },

  async deleteBusinessProfile<TPayload = Record<string, unknown>, TAssets = Record<string, unknown>>(
    id: string,
    endpoint?: string,
  ): Promise<BusinessProfile<TPayload, TAssets>> {
    const data = await requestJson<{ ok: boolean; profile: BusinessProfile<TPayload, TAssets> }>(
      `/v1/business-profiles/${encodeURIComponent(id)}`,
      { endpoint, method: 'DELETE' },
    );
    return data.profile;
  },

  async listKnowledge(endpoint?: string): Promise<KnowledgeItem[]> {
    return ((await this.fetchCloudData('/api/knowledge', endpoint || '')) as KnowledgeItem[] | null) || [];
  },

  async listProductAssets(
    endpoint?: string,
    params?: { mainCategory?: string; search?: string; limit?: number; offset?: number },
  ): Promise<ProductAssetDetail[]> {
    const page = await this.listProductAssetsPage(endpoint, params);
    return page.assets;
  },

  async listProductAssetsPage(
    endpoint?: string,
    params?: { mainCategory?: string; search?: string; limit?: number; offset?: number },
  ): Promise<ProductAssetPage> {
    const query = new URLSearchParams();
    if (params?.mainCategory) query.set('mainCategory', params.mainCategory);
    if (params?.search) query.set('search', params.search);
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    const suffix = query.toString() ? `?${query.toString()}` : '';
    const data = await requestJson<{ ok: boolean; assets: ProductAssetDetail[] }>(`/v1/products/assets${suffix}`, {
      endpoint,
      method: 'GET',
    });
    const assets = Array.isArray(data.assets) ? data.assets : [];
    return {
      assets,
      total: Number((data as any).total ?? assets.length),
      limit: Number((data as any).limit ?? params?.limit ?? assets.length),
      offset: Number((data as any).offset ?? params?.offset ?? 0),
      hasMore: Boolean((data as any).hasMore),
    };
  },

  /**
   * 产品资产全量拉取（循环分页直至取尽）：返回数组即全量集合——total 恒等于返回值 length
   * （循环终止条件直接消费 listProductAssetsPage 回包的 total/hasMore）。
   */
  async listAllProductAssets(
    endpoint?: string,
    params?: { mainCategory?: string; search?: string; pageSize?: number },
  ): Promise<ProductAssetDetail[]> {
    const pageSize = Math.min(Math.max(params?.pageSize || 500, 1), 500);
    const all: ProductAssetDetail[] = [];
    let offset = 0;
    for (let page = 0; page < 200; page += 1) {
      const result = await this.listProductAssetsPage(endpoint, {
        mainCategory: params?.mainCategory,
        search: params?.search,
        limit: pageSize,
        offset,
      });
      all.push(...result.assets);
      if (!result.hasMore || result.assets.length === 0 || all.length >= result.total) break;
      offset += result.assets.length;
    }
    return all;
  },

  async getProductAsset(id: string, endpoint?: string): Promise<ProductAssetReadDetail> {
    const data = await requestJson<{ ok: boolean; asset: ProductAssetDetail; relatedOrderLines?: ProductRelatedOrderLine[] }>(
      `/v1/products/assets/${encodeURIComponent(id)}`,
      { endpoint, method: 'GET' },
    );
    return { ...data.asset, relatedOrderLines: Array.isArray(data.relatedOrderLines) ? data.relatedOrderLines : [] };
  },

  async listFabricUseAuthorizations(id: string, endpoint?: string): Promise<any> {
    return requestJson<{ ok: boolean; ownerName: string | null; actionOptions: Array<{ value: string; label: string }>; items: any[]; activeGrants: any[] }>(
      `/v1/products/assets/${encodeURIComponent(id)}/fabric-use-authorizations`, { endpoint, method: 'GET' },
    );
  },

  async createFabricUseAuthorizationRequest(id: string, input: {
    granteeRelationId: string; operation: 'grant' | 'replace' | 'revoke'; allowedActions?: string[];
    effectiveFrom?: string | null; effectiveUntil?: string | null; expectedVersionId?: string | null; requestKey: string;
  }, endpoint?: string): Promise<any> {
    return requestJson(`/v1/products/assets/${encodeURIComponent(id)}/fabric-use-authorizations`, {
      endpoint, method: 'POST', body: JSON.stringify(input),
    });
  },

  /** P1-3 客户专属面料预检（只读；行级警示用——写路径校验由服务端四入口 fail-closed 承担） */
  async checkFabricExclusivity(params: {
    customerRelationId?: string | null;
    customerName?: string | null;
    fabricCode?: string;
    clientCode?: string;
    millQuality?: string;
    sku?: string;
    articleNo?: string;
    productAssetId?: string;
  }, endpoint?: string): Promise<{ allowed: boolean; violations: FabricExclusivityViolation[] }> {
    const data = await requestJson<{ ok: boolean; allowed: boolean; violations: FabricExclusivityViolation[] }>(
      '/v1/products/fabric-exclusivity/check',
      { endpoint, method: 'POST', body: JSON.stringify(params) },
    );
    return { allowed: data.allowed !== false, violations: data.violations ?? [] };
  },

  async createProductAsset(input: CreateProductAssetInput, endpoint?: string): Promise<ProductAssetDetail> {
    const data = await requestJson<{ ok: boolean; asset: ProductAssetDetail }>('/v1/products/assets', {
      endpoint,
      method: 'POST',
      body: JSON.stringify(input),
    });
    return data.asset;
  },

  async updateProductAsset(id: string, input: Record<string, any>, endpoint?: string): Promise<ProductAssetDetail> {
    const data = await requestJson<{ ok: boolean; asset: ProductAssetDetail }>(
      `/v1/products/assets/${encodeURIComponent(id)}`,
      { endpoint, method: 'PATCH', body: JSON.stringify(input) },
    );
    return data.asset;
  },

  async deleteProductAsset(id: string, endpoint?: string): Promise<{ ok: boolean; deleted: string }> {
    const data = await requestJson<{ ok: boolean; deleted: string }>(
      `/v1/products/assets/${encodeURIComponent(id)}`,
      { endpoint, method: 'DELETE' },
    );
    return data;
  },

  async listProducts(endpoint?: string): Promise<ProductAsset[]> {
    try {
      const assets = await this.listAllProductAssets(endpoint, { pageSize: 500 });
      if (assets.length > 0) return assets;
      const legacy = await this.fetchCloudData('/api/products', endpoint || '') as ProductAsset[];
      return Array.isArray(legacy) && legacy.length > 0 ? legacy : assets;
    } catch (error) {
      console.warn('[DataHub] v1 products API unavailable, falling back to legacy sync route:', error);
      const legacy = await this.fetchCloudData('/api/products', endpoint || '') as ProductAsset[];
      if (Array.isArray(legacy) && legacy.length > 0) return legacy;
      throw error;
    }
  },

  // ========== Product Images ==========

  async uploadProductImages(productId: string, files: File[], endpoint?: string): Promise<ProductImage[]> {
    const formData = new FormData();
    for (const file of files) {
      formData.append('files', file);
    }
    const url = buildApiUrl(`/v1/products/assets/${encodeURIComponent(productId)}/images`, endpoint);
    const apiKey = getApiKey();
    const headers: Record<string, string> = {};
    if (apiKey) headers['X-Bambook-API-Key'] = apiKey;
    // Note: do NOT set Content-Type for FormData — browser sets it with boundary

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: formData,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.message || data?.error || `HTTP ${response.status}`);
    return data.images;
  },

  async deleteProductImage(productId: string, imageId: string, endpoint?: string): Promise<void> {
    await requestJson(`/v1/products/assets/${encodeURIComponent(productId)}/images/${encodeURIComponent(imageId)}`, {
      endpoint,
      method: 'DELETE',
    });
  },

  // ── REQ2-07 历史数据批量迁移（DR-049：validate 零落库 → commit 落库+批次留痕） ──
  /** 纯鉴权头（不带 Content-Type——FormData 须由浏览器自动设 boundary） */
  _migrationAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    const apiKey = getApiKey();
    if (apiKey) headers['X-Bambook-API-Key'] = apiKey;
    try {
      const token = localStorage.getItem('bambook_auth_token') || sessionStorage.getItem('bambook_auth_token');
      if (token) headers['Authorization'] = `Bearer ${token}`;
    } catch { /* ignore */ }
    return headers;
  },

  async downloadMigrationTemplate(type: string, endpoint?: string): Promise<Blob> {
    const url = buildApiUrl(`/v1/data-migration/templates/${encodeURIComponent(type)}`, endpoint);
    const res = await fetch(url, { headers: this._migrationAuthHeaders() });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error?.message || `HTTP ${res.status}`);
    }
    return res.blob();
  },

  async validateMigrationFile(type: string, file: File, endpoint?: string): Promise<{
    rows: Array<{ lineNo: number; data: Record<string, string>; valid: boolean; reason?: string }>;
    totalRows: number; validCount: number; errorCount: number;
  }> {
    const url = buildApiUrl('/v1/data-migration/validate', endpoint);
    const form = new FormData();
    form.append('file', file);
    form.append('type', type);
    const res = await fetch(url, { method: 'POST', headers: this._migrationAuthHeaders(), body: form });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    return data;
  },

  async commitMigrationFile(type: string, file: File, endpoint?: string): Promise<{
    batch: { id: string; importedRows: number; skippedRows: number };
    imported: number; skipped: number;
  }> {
    const url = buildApiUrl('/v1/data-migration/commit', endpoint);
    const form = new FormData();
    form.append('file', file);
    form.append('type', type);
    const res = await fetch(url, { method: 'POST', headers: this._migrationAuthHeaders(), body: form });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    return data;
  },

  async listImportBatches(endpoint?: string): Promise<Array<{
    id: string; type: string; fileName: string; totalRows: number; importedRows: number;
    skippedRows: number; entityIds: string[]; status: 'committed' | 'rolled_back'; createdAt: number;
  }>> {
    const data = await requestJson<{ items: any[] }>('/v1/data-migration/batches', { endpoint, method: 'GET' });
    return data.items ?? [];
  },

  async rollbackImportBatch(batchId: string, endpoint?: string): Promise<{ rolledBack: number }> {
    const data = await requestJson<{ rolledBack: number }>(`/v1/data-migration/batches/${encodeURIComponent(batchId)}/rollback`, {
      endpoint, method: 'POST', body: JSON.stringify({}),
    });
    return data;
  },

  async setProductImagePrimary(productId: string, imageId: string, endpoint?: string): Promise<void> {
    await requestJson(`/v1/products/assets/${encodeURIComponent(productId)}/images/${encodeURIComponent(imageId)}/primary`, {
      endpoint,
      method: 'PATCH',
    });
  },

  async reorderProductImages(productId: string, orders: Array<{ id: string; sortOrder: number }>, endpoint?: string): Promise<void> {
    await requestJson(`/v1/products/assets/${encodeURIComponent(productId)}/images/reorder`, {
      endpoint,
      method: 'PATCH',
      body: JSON.stringify({ orders }),
    });
  },

  getProductImageUrl(filePath: string): string {
    return buildApiUrl(`/uploads/${filePath}`);
  },

  // ========== System Assets ==========

  async listSystemAssets(kind: 'wallpaper' = 'wallpaper', endpoint?: string, includeHidden = false): Promise<SystemAsset[]> {
    const suffix = `?kind=${encodeURIComponent(kind)}${includeHidden ? '&includeHidden=true' : ''}`;
    const data = await requestJson<{ ok: boolean; assets: SystemAsset[] }>(`/v1/system-assets${suffix}`, { endpoint });
    return Array.isArray(data.assets) ? data.assets : [];
  },

  async uploadSystemWallpaper(
    input: { id?: string; title: string; group: string; sortOrder?: number; hidden?: boolean; file?: File },
    endpoint?: string,
  ): Promise<SystemAsset> {
    const formData = new FormData();
    if (input.id) formData.append('id', input.id);
    formData.append('title', input.title);
    formData.append('group', input.group);
    formData.append('sortOrder', String(input.sortOrder ?? 0));
    formData.append('hidden', String(Boolean(input.hidden)));
    if (input.file) formData.append('file', input.file);

    const apiKey = getApiKey();
    const headers: Record<string, string> = {};
    if (apiKey) headers['X-Bambook-API-Key'] = apiKey;

    const response = await fetch(buildApiUrl('/v1/system-assets/wallpapers', endpoint), {
      method: 'POST',
      headers,
      body: formData,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.message || data?.error || `HTTP ${response.status}`);
    return data.asset;
  },

  async updateSystemAsset(id: string, patch: Partial<Pick<SystemAsset, 'title' | 'group' | 'sortOrder' | 'hidden' | 'metadata'>>, endpoint?: string): Promise<SystemAsset> {
    const data = await requestJson<{ ok: boolean; asset: SystemAsset }>(`/v1/system-assets/${encodeURIComponent(id)}`, {
      endpoint,
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    return data.asset;
  },

  async deleteSystemAsset(id: string, endpoint?: string): Promise<void> {
    await requestJson(`/v1/system-assets/${encodeURIComponent(id)}`, {
      endpoint,
      method: 'DELETE',
    });
  },

  getSystemAssetFileUrl(asset: Pick<SystemAsset, 'id' | 'fileUrl'>, endpoint?: string): string {
    return buildApiUrl(asset.fileUrl || `/v1/system-assets/${encodeURIComponent(asset.id)}/file`, endpoint);
  },

  async listProductCategories(endpoint?: string): Promise<ProductSubCategory[]> {
    return ((await this.fetchCloudData('/api/product-categories', endpoint || '')) as ProductSubCategory[] | null) || [];
  },

  async saveProductCategory(category: ProductSubCategory, endpoint?: string): Promise<void> {
    const ok = await this.postCloudData('/api/product-categories', endpoint || '', category);
    if (!ok) throw new Error('产品分类写入数据中心失败');
  },

  async deleteProductCategory(category: ProductSubCategory, endpoint?: string): Promise<void> {
    await this.saveProductCategory({ ...category, deletedAt: category.deletedAt || Date.now() }, endpoint);
  },

  async listInsights(endpoint?: string): Promise<Insight[]> {
    return ((await this.fetchCloudData('/api/insights', endpoint || '')) as Insight[] | null) || [];
  },

  // ========== ERP 知识文档（Prisma 真源） ==========

  /**
   * ERP 知识文档列表：服务端当前全量返回（无分页参数），limit/offset 在客户端切片生效——
   * 契约先行，后端支持服务端分页后此处无感切换。
   */
  async listKnowledgeDocuments(endpoint?: string, params?: { limit?: number; offset?: number }): Promise<KnowledgeDocumentRecord[]> {
    const data = await requestJson<{ ok: boolean; documents: KnowledgeDocumentRecord[] }>('/v1/knowledge-documents', {
      endpoint,
      method: 'GET',
    });
    const docs = (Array.isArray(data.documents) ? data.documents : []).filter(d => d.origin === 'erp');
    const start = Math.max(params?.offset ?? 0, 0);
    return params?.limit != null ? docs.slice(start, start + params.limit) : docs.slice(start);
  },

  async ingestKnowledgeText(input: { title: string; text: string; category: string; sourceType?: string; sourceUri?: string }, endpoint?: string): Promise<{ documentId: string; checksum: string; chunkCount: number; auditId: string }> {
    return requestJson('/v1/knowledge-documents/ingest-text', {
      endpoint,
      method: 'POST',
      body: JSON.stringify({
        title: input.title,
        text: input.text,
        sourceType: input.sourceType || 'manual',
        sourceUri: input.sourceUri || undefined,
        scopes: ['company'],
        metadata: { category: input.category },
      }),
    });
  },

  async updateKnowledgeDocument(
    id: string,
    input: { title?: string; text?: string; category?: string },
    endpoint?: string,
  ): Promise<{ documentId: string; version: number; updatedAt: number }> {
    return requestJson(`/v1/knowledge-documents/${encodeURIComponent(id)}`, {
      endpoint,
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },

  async deleteKnowledgeDocument(id: string, endpoint?: string): Promise<{ documentId: string }> {
    return requestJson(`/v1/knowledge-documents/${encodeURIComponent(id)}`, {
      endpoint,
      method: 'DELETE',
    });
  },

  // ========== C7 知识库深化：SOP 模板 / 知识关联 / 智能问答 ==========

  async listSopTemplates(params?: { category?: string; status?: string }, endpoint?: string): Promise<SopTemplate[]> {
    const query = new URLSearchParams();
    if (params?.category) query.set('category', params.category);
    if (params?.status) query.set('status', params.status);
    const qs = query.toString();
    const data = await requestJson<{ ok: boolean; items: SopTemplate[] }>(`/v1/knowledge/sop-templates${qs ? `?${qs}` : ''}`, {
      endpoint,
      method: 'GET',
    });
    return data.items || [];
  },

  async createSopTemplate(input: { title: string; category: string; summary?: string; content: string; steps?: SopStep[] }, endpoint?: string): Promise<SopTemplate> {
    const data = await requestJson<{ ok: boolean; item: SopTemplate }>('/v1/knowledge/sop-templates', {
      endpoint,
      method: 'POST',
      body: JSON.stringify(input),
    });
    return data.item;
  },

  async updateSopTemplate(id: string, input: Partial<{ title: string; category: string; summary: string | null; content: string; steps: SopStep[]; status: string }>, endpoint?: string): Promise<SopTemplate> {
    const data = await requestJson<{ ok: boolean; item: SopTemplate }>(`/v1/knowledge/sop-templates/${encodeURIComponent(id)}`, {
      endpoint,
      method: 'PATCH',
      body: JSON.stringify(input),
    });
    return data.item;
  },

  async deleteSopTemplate(id: string, endpoint?: string): Promise<void> {
    await requestJson(`/v1/knowledge/sop-templates/${encodeURIComponent(id)}`, {
      endpoint,
      method: 'DELETE',
    });
  },

  /** SOP 实例化：模板 → 知识文档（服务端渲染 + ingest 管线，sourceType='sop'） */
  async instantiateSopTemplate(id: string, endpoint?: string): Promise<{ documentId: string; checksum: string; chunkCount: number; templateVersion: number }> {
    return requestJson(`/v1/knowledge/sop-templates/${encodeURIComponent(id)}/instantiate`, {
      endpoint,
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  /** 知识文档的实体关联（正向） */
  async listKnowledgeDocumentRelations(docId: string, endpoint?: string): Promise<KnowledgeRelationView[]> {
    const data = await requestJson<{ ok: boolean; items: KnowledgeRelationView[] }>(`/v1/knowledge/graph/document/${encodeURIComponent(docId)}/relations`, {
      endpoint,
      method: 'GET',
    });
    return data.items || [];
  },

  /** 业务实体的知识关联 + 实体链接（反向） */
  async listKnowledgeEntityRelations(targetType: string, targetId: string, endpoint?: string): Promise<{ knowledge: KnowledgeRelationView[]; entityLinks: EntityLinkView[] }> {
    return requestJson(`/v1/knowledge/graph/entity/${encodeURIComponent(targetType)}/${encodeURIComponent(targetId)}/relations`, {
      endpoint,
      method: 'GET',
    });
  },

  /** 向量检索（Python knowledge_api 直调，Bearer 鉴权）— 问答引用片段 */
  async searchKnowledgeBase(query: string, topK?: number): Promise<KnowledgeCitation[]> {
    const config = this.getStoredConfig();
    const base = (config.knowledgeApiEndpoint || '').replace(/\/$/, '');
    const res = await fetch(`${base}/v1/knowledge/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.knowledgeApiKey ? { Authorization: `Bearer ${config.knowledgeApiKey}` } : {}),
      },
      body: JSON.stringify({ query, top_k: topK }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || `knowledge search failed: HTTP ${res.status}`);
    const results = Array.isArray(data?.results) ? data.results : [];
    return results.map((r: any) => ({
      id: String(r?.id ?? ''),
      title: String(r?.source_title ?? '未命名片段'),
      content: String(r?.content ?? ''),
      score: typeof r?.score === 'number' ? r.score : 0,
    }));
  },

  /** 智能问答（Python knowledge_api /v1/chat，RAG + DeepSeek 流式）；onChunk 逐段回调 */
  async askKnowledgeBase(message: string, onChunk: (piece: string) => void): Promise<void> {
    const config = this.getStoredConfig();
    const base = (config.knowledgeApiEndpoint || '').replace(/\/$/, '');
    const res = await fetch(`${base}/v1/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.knowledgeApiKey ? { Authorization: `Bearer ${config.knowledgeApiKey}` } : {}),
      },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.detail || `knowledge chat failed: HTTP ${res.status}`);
    }
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const piece = decoder.decode(value, { stream: true });
      if (piece) onChunk(piece);
    }
  },

  // ========== PO 订单数据库 ==========

  // [DELETED] getPOOrders, getPOOrderDetail, searchPOOrders, getPOItems,
  // getPOCustomers, importPOPdfs — all migrated to /api/v1/orders.

  // ========== 发货通知 ==========

  async generateShippingNotice(data: {
    poNumbers: string[];
    options?: {
      contractNo?: string;
      supplier?: string;
      destinationPort?: string;
      shipmentDate?: string;
      paymentTerms?: string;
      forwarder?: string;
      remarks?: string;
    };
  }): Promise<{
    success: boolean;
    filename?: string;
    downloadUrl?: string;
    data?: any;
    error?: string;
  }> {
    return postData(`${getDynamicApiBaseUrl()}/shipping-notice/generate`, data);
  },

  // 下载发货通知文件
  getShippingNoticeDownloadUrl(filename: string): string {
    const url = new URL(buildApiUrl('/shipping-notice/download'), window.location.origin);
    url.searchParams.set('file', filename);
    const apiKey = getApiKey();
    if (apiKey) url.searchParams.set('apiKey', apiKey);
    return url.toString();
  },

  // ── Phase 5 B5 + Phase 3 C6: 外贸与报关 API ──

  // CustomsDeclaration（报关单）
  async listCustomsDeclarations(params?: {
    type?: string;
    status?: string;
    shipmentId?: string;
    orderId?: string;
    relationId?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }, endpoint?: string): Promise<{ items: CustomsDeclaration[]; total: number }> {
    const query = new URLSearchParams();
    if (params?.type) query.set('type', params.type);
    if (params?.status) query.set('status', params.status);
    if (params?.shipmentId) query.set('shipmentId', params.shipmentId);
    if (params?.orderId) query.set('orderId', params.orderId);
    if (params?.relationId) query.set('relationId', params.relationId);
    if (params?.search) query.set('search', params.search);
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    const qs = query.toString();
    return requestJson<{ items: CustomsDeclaration[]; total: number }>(`/v1/customs/declarations${qs ? '?' + qs : ''}`, { endpoint, method: 'GET' });
  },

  async getCustomsDeclaration(id: string, endpoint?: string): Promise<CustomsDeclaration> {
    const data = await requestJson<{ item: CustomsDeclaration }>(`/v1/customs/declarations/${encodeURIComponent(id)}`, { endpoint, method: 'GET' });
    return data.item;
  },

  async createCustomsDeclaration(input: CustomsDeclarationInput, endpoint?: string): Promise<CustomsDeclaration> {
    const data = await requestJson<{ item: CustomsDeclaration }>(`/v1/customs/declarations`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.item;
  },

  async updateCustomsDeclaration(id: string, input: Partial<CustomsDeclarationInput>, endpoint?: string): Promise<CustomsDeclaration> {
    const data = await requestJson<{ item: CustomsDeclaration }>(`/v1/customs/declarations/${encodeURIComponent(id)}`, { endpoint, method: 'PUT', body: JSON.stringify(input) });
    return data.item;
  },

  async deleteCustomsDeclaration(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/customs/declarations/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },

  async transitionCustomsDeclarationStatus(id: string, toStatus: CustomsDeclarationStatus, endpoint?: string): Promise<CustomsDeclaration> {
    const data = await requestJson<{ item: CustomsDeclaration }>(`/v1/customs/declarations/${encodeURIComponent(id)}/transition`, { endpoint, method: 'POST', body: JSON.stringify({ toStatus }) });
    return data.item;
  },

  // HsCode（HS 编码库）
  async listHsCodes(params?: { category?: string; search?: string; isActive?: boolean; limit?: number; offset?: number }, endpoint?: string): Promise<{ items: HsCode[]; total: number }> {
    const query = new URLSearchParams();
    if (params?.category) query.set('category', params.category);
    if (params?.search) query.set('search', params.search);
    if (params?.isActive !== undefined) query.set('isActive', String(params.isActive));
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    const qs = query.toString();
    return requestJson<{ items: HsCode[]; total: number }>(`/v1/customs/hs-codes${qs ? '?' + qs : ''}`, { endpoint, method: 'GET' });
  },

  async getHsCodeByCode(code: string, endpoint?: string): Promise<HsCode> {
    const data = await requestJson<{ item: HsCode }>(`/v1/customs/hs-codes/${encodeURIComponent(code)}`, { endpoint, method: 'GET' });
    return data.item;
  },

  async createHsCode(input: HsCodeInput, endpoint?: string): Promise<HsCode> {
    const data = await requestJson<{ item: HsCode }>(`/v1/customs/hs-codes`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.item;
  },

  async updateHsCode(id: string, input: Partial<HsCodeInput>, endpoint?: string): Promise<HsCode> {
    const data = await requestJson<{ item: HsCode }>(`/v1/customs/hs-codes/${encodeURIComponent(id)}`, { endpoint, method: 'PUT', body: JSON.stringify(input) });
    return data.item;
  },

  async deleteHsCode(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/customs/hs-codes/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },

  // LetterOfCredit（信用证）
  async listLettersOfCredit(params?: { status?: string; relationId?: string; orderId?: string; search?: string; limit?: number; offset?: number }, endpoint?: string): Promise<{ items: LetterOfCredit[]; total: number }> {
    const query = new URLSearchParams();
    if (params?.status) query.set('status', params.status);
    if (params?.relationId) query.set('relationId', params.relationId);
    if (params?.orderId) query.set('orderId', params.orderId);
    if (params?.search) query.set('search', params.search);
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    const qs = query.toString();
    return requestJson<{ items: LetterOfCredit[]; total: number }>(`/v1/customs/letters-of-credit${qs ? '?' + qs : ''}`, { endpoint, method: 'GET' });
  },

  async getLetterOfCredit(id: string, endpoint?: string): Promise<LetterOfCredit> {
    const data = await requestJson<{ item: LetterOfCredit }>(`/v1/customs/letters-of-credit/${encodeURIComponent(id)}`, { endpoint, method: 'GET' });
    return data.item;
  },

  async createLetterOfCredit(input: LetterOfCreditInput, endpoint?: string): Promise<LetterOfCredit> {
    const data = await requestJson<{ item: LetterOfCredit }>(`/v1/customs/letters-of-credit`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.item;
  },

  async updateLetterOfCredit(id: string, input: Partial<LetterOfCreditInput>, endpoint?: string): Promise<LetterOfCredit> {
    const data = await requestJson<{ item: LetterOfCredit }>(`/v1/customs/letters-of-credit/${encodeURIComponent(id)}`, { endpoint, method: 'PUT', body: JSON.stringify(input) });
    return data.item;
  },

  async deleteLetterOfCredit(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/customs/letters-of-credit/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },

  async transitionLetterOfCreditStatus(id: string, toStatus: LetterOfCreditStatus, discrepancies?: string, endpoint?: string): Promise<LetterOfCredit> {
    const body: Record<string, string> = { toStatus };
    if (discrepancies !== undefined) body.discrepancies = discrepancies;
    const data = await requestJson<{ item: LetterOfCredit }>(`/v1/customs/letters-of-credit/${encodeURIComponent(id)}/transition`, { endpoint, method: 'POST', body: JSON.stringify(body) });
    return data.item;
  },

  /** F1：信用证节点时间轴 */
  async listLetterOfCreditEvents(id: string, endpoint?: string): Promise<{ items: LcEvent[]; total: number }> {
    return requestJson<{ items: LcEvent[]; total: number }>(`/v1/customs/letters-of-credit/${encodeURIComponent(id)}/events`, { endpoint, method: 'GET' });
  },

  // TaxRefund（出口退税）
  async listTaxRefunds(params?: { status?: string; declarationId?: string; orderId?: string; relationId?: string; search?: string; limit?: number; offset?: number }, endpoint?: string): Promise<{ items: TaxRefund[]; total: number }> {
    const query = new URLSearchParams();
    if (params?.status) query.set('status', params.status);
    if (params?.declarationId) query.set('declarationId', params.declarationId);
    if (params?.orderId) query.set('orderId', params.orderId);
    if (params?.relationId) query.set('relationId', params.relationId);
    if (params?.search) query.set('search', params.search);
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    const qs = query.toString();
    return requestJson<{ items: TaxRefund[]; total: number }>(`/v2/customs/tax-refunds${qs ? '?' + qs : ''}`, { endpoint, method: 'GET' });
  },

  async getTaxRefund(id: string, endpoint?: string): Promise<TaxRefund> {
    const data = await requestJson<{ item: TaxRefund }>(`/v2/customs/tax-refunds/${encodeURIComponent(id)}`, { endpoint, method: 'GET' });
    return data.item;
  },

  async createTaxRefund(input: TaxRefundInput, endpoint?: string): Promise<TaxRefund> {
    const data = await requestJson<{ item: TaxRefund }>(`/v2/customs/tax-refunds`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.item;
  },

  async updateTaxRefund(id: string, input: Partial<TaxRefundInput>, endpoint?: string): Promise<TaxRefund> {
    const data = await requestJson<{ item: TaxRefund }>(`/v2/customs/tax-refunds/${encodeURIComponent(id)}`, { endpoint, method: 'PUT', body: JSON.stringify(input) });
    return data.item;
  },

  async deleteTaxRefund(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v2/customs/tax-refunds/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },

  async transitionTaxRefundStatus(id: string, toStatus: TaxRefundStatus, endpoint?: string): Promise<TaxRefund> {
    const data = await requestJson<{ item: TaxRefund }>(`/v2/customs/tax-refunds/${encodeURIComponent(id)}/transition`, { endpoint, method: 'POST', body: JSON.stringify({ toStatus }) });
    return data.item;
  },

  async reviewTaxRefund(id: string, input: TaxRefundReviewInput, endpoint?: string): Promise<TaxRefund> {
    const data = await requestJson<{ item: TaxRefund }>(`/v2/customs/tax-refunds/${encodeURIComponent(id)}/review`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.item;
  },

  /** G4：从报关单一键核算生成退税草稿（幂等，重复生成由后端拦截） */
  async createTaxRefundFromDeclaration(declarationId: string, endpoint?: string): Promise<TaxRefund> {
    const data = await requestJson<{ item: TaxRefund }>(`/v2/customs/tax-refunds/from-declaration/${encodeURIComponent(declarationId)}`, { endpoint, method: 'POST' });
    return data.item;
  },

  // TradeDocument（贸易单据）
  async listTradeDocuments(params?: { type?: string; status?: string; domain?: string; shipmentId?: string; declarationId?: string; orderId?: string; relationId?: string; sourceInvoiceId?: string; search?: string; limit?: number; offset?: number }, endpoint?: string): Promise<{ items: TradeDocument[]; total: number }> {
    const query = new URLSearchParams();
    if (params?.type) query.set('type', params.type);
    if (params?.status) query.set('status', params.status);
    if (params?.domain) query.set('domain', params.domain);
    if (params?.shipmentId) query.set('shipmentId', params.shipmentId);
    if (params?.declarationId) query.set('declarationId', params.declarationId);
    if (params?.orderId) query.set('orderId', params.orderId);
    if (params?.relationId) query.set('relationId', params.relationId);
    if (params?.sourceInvoiceId) query.set('sourceInvoiceId', params.sourceInvoiceId);
    if (params?.search) query.set('search', params.search);
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    const qs = query.toString();
    return requestJson<{ items: TradeDocument[]; total: number }>(`/v1/customs/trade-documents${qs ? '?' + qs : ''}`, { endpoint, method: 'GET' });
  },

  /** B4 多选单据 ZIP 打包下载——POST /v1/customs/trade-documents/batch-download
   *  已归档文件直读，缺文件的单据服务端现场生成（幂等）保证打包完整 */
  async batchDownloadTradeDocumentsZip(ids: string[], endpoint?: string, versions?: Record<string, number>, isCurrent?: () => boolean): Promise<void> {
    if (versions && Object.entries(versions).some(([id, n]) => !ids.includes(id) || !Number.isSafeInteger(n) || n < 1)) throw new Error('单据版本无效。');
    const finish = versions && Object.keys(versions).length ? customsDownloadFence(endpoint, isCurrent) : { check: () => {}, dispose: () => {} };
    try {
      const url = buildApiUrl('/v1/customs/trade-documents/batch-download', endpoint);
      const res = await fetch(url, { method: 'POST', headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, ...(versions && Object.keys(versions).length ? { versions } : {}) }) });
      finish.check();
      if (!res.ok) { const data = await res.json().catch(() => null); throw new Error(data?.message || data?.error?.message || `HTTP ${res.status}`); }
      const blob = await res.blob(); finish.check();
      const cd = res.headers.get('Content-Disposition') || '';
      const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
      const filename = m && m[1] ? decodeURIComponent(m[1]) : `trade-documents_${businessNowDate().toISOString().slice(0, 10)}.zip`;
      const objectUrl = URL.createObjectURL(blob);
      try { const a = document.createElement('a'); a.href = objectUrl; a.download = filename; document.body.appendChild(a); finish.check(); a.click(); a.remove(); }
      finally { URL.revokeObjectURL(objectUrl); }
    } finally { finish.dispose(); }
  },

  async getMergedPackingListSelection(sourceIds: string[]): Promise<unknown> {
    return requestJson('/v1/customs/trade-documents/merged-packing-list-source', { method: 'POST', body: JSON.stringify({ sourceIds }) });
  },
  async createMergedPackingListDraft(input: unknown): Promise<unknown> {
    return requestJson('/v1/customs/trade-documents/merged-packing-lists', { method: 'POST', body: JSON.stringify(input) });
  },
  async getMergedPackingListCommand(requestKey: string): Promise<unknown> {
    return requestJson(`/v1/customs/trade-documents/merged-packing-list-commands/${encodeURIComponent(requestKey)}`, { method: 'GET' });
  },

  async getPackingListDraftSource(id: string): Promise<unknown> {
    return requestJson(`/v1/customs/trade-documents/${encodeURIComponent(id)}/packing-list-source`, { method: 'GET' });
  },
  async appendPackingListDraftVersion(id: string, input: unknown): Promise<unknown> {
    return requestJson(`/v1/customs/trade-documents/${encodeURIComponent(id)}/packing-list-versions`, { method: 'POST', body: JSON.stringify(input) });
  },
  async getPackingListDraftCommand(id: string, requestKey: string): Promise<unknown> {
    return requestJson(`/v1/customs/trade-documents/${encodeURIComponent(id)}/packing-list-commands/${encodeURIComponent(requestKey)}`, { method: 'GET' });
  },

  async getTradeDocument(id: string, endpoint?: string): Promise<TradeDocument> {
    const data = await requestJson<{ item: TradeDocument }>(`/v1/customs/trade-documents/${encodeURIComponent(id)}`, { endpoint, method: 'GET' });
    return data.item;
  },

  async createTradeDocument(input: TradeDocumentInput, endpoint?: string): Promise<TradeDocument> {
    const data = await requestJson<{ item: TradeDocument }>(`/v1/customs/trade-documents`, { endpoint, method: 'POST', body: JSON.stringify(input) });
    return data.item;
  },

  /** 登记系统外完成的出口申报；只接受有本运单已归档原件的完成事实。 */
  async completeShipmentExportDeclaration(shipmentId: string, input: { completedAt: string; evidenceDocumentId: string; reference?: string }, endpoint?: string): Promise<Shipment> {
    const { shipmentService } = await import('./shipmentService');
    return shipmentService.completeExportDeclaration(shipmentId,input,endpoint);
  },

  async updateTradeDocument(id: string, input: Partial<TradeDocumentInput>, endpoint?: string): Promise<TradeDocument> {
    const data = await requestJson<{ item: TradeDocument }>(`/v1/customs/trade-documents/${encodeURIComponent(id)}`, { endpoint, method: 'PUT', body: JSON.stringify(input) });
    return data.item;
  },

  async deleteTradeDocument(id: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/customs/trade-documents/${encodeURIComponent(id)}`, { endpoint, method: 'DELETE' });
  },

  async transitionTradeDocumentStatus(id: string, toStatus: TradeDocumentStatus, endpoint?: string): Promise<TradeDocument> {
    const data = await requestJson<{ item: TradeDocument }>(`/v1/customs/trade-documents/${encodeURIComponent(id)}/transition`, { endpoint, method: 'POST', body: JSON.stringify({ toStatus }) });
    return data.item;
  },

  // ── Wave A1 单据中心：版本 / 生成即登记 / 批量打包 ──

  async listTradeDocumentVersions(id: string, endpoint?: string): Promise<{ items: DocumentVersionRecord[]; total: number }> {
    return requestJson<{ items: DocumentVersionRecord[]; total: number }>(`/v1/customs/trade-documents/${encodeURIComponent(id)}/versions`, { endpoint, method: 'GET' });
  },

  async getTradeDocumentVersion(id: string, version: number, endpoint?: string): Promise<DocumentVersionRecord> {
    const data = await requestJson<{ item: DocumentVersionRecord }>(`/v1/customs/trade-documents/${encodeURIComponent(id)}/versions/${version}`, { endpoint, method: 'GET' });
    return data.item;
  },

  async generateTradeDocumentsFromShipment(params: { shipmentId: string; types: TradeDocumentType[] } & ShipmentDocumentSourceBinding, endpoint?: string): Promise<GenerateTradeDocumentsResult> {
    return requestJson<GenerateTradeDocumentsResult>(`/v1/customs/trade-documents/generate-from-shipment`, { endpoint, method: 'POST', body: JSON.stringify(params) });
  },

  /** 一键生成文件：版本快照渲染 HTML → 服务端转 PDF 落盘归档（回写 filePath/fileName）；CI 带财务回链时 html 可省（服务端真源模板自渲染） */
  async generateTradeDocumentFile(id: string, params: { html?: string; version?: number }, endpoint?: string): Promise<{ filePath: string; fileName: string; fileSize: number; version?: number; replayed?: boolean }> {
    return requestJson<{ filePath: string; fileName: string; fileSize: number; version?: number; replayed?: boolean }>(`/v1/customs/trade-documents/${encodeURIComponent(id)}/generate-file`, { endpoint, method: 'POST', body: JSON.stringify(params) });
  },

  /**
   * 单据服务端模板预览 HTML——GET /v1/customs/trade-documents/:id/preview.html。
   * 服务端模板类型（CI 财务回链 / PL / PO / IR）返回 screen 模式 A4 画布（与 PDF 同源）；
   * 其余类型 501 SERVER_TEMPLATE_NOT_AVAILABLE → 调用方回退前端本地渲染器。
   */
  async getTradeDocumentPreviewHtml(id: string, endpoint?: string): Promise<string> {
    const url = buildApiUrl(`/v1/customs/trade-documents/${encodeURIComponent(id)}/preview.html`, endpoint);
    const res = await fetch(url, { headers: this.getAuthHeaders() });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      const err: any = new Error(data?.error?.message || data?.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.code = data?.error === 'SERVER_TEMPLATE_NOT_AVAILABLE' ? 'SERVER_TEMPLATE_NOT_AVAILABLE' : data?.error?.code;
      throw err;
    }
    return res.text();
  },

  /** Read the selected immutable native version, including historical CI. */
  async getTradeDocumentVersionPreviewHtml(id: string, version: number, endpoint?: string): Promise<string> {
    if (!Number.isSafeInteger(version) || version <= 0) throw new Error('单据版本无效。');
    const url = buildApiUrl(`/v1/customs/trade-documents/${encodeURIComponent(id)}/preview.html?version=${version}`, endpoint);
    const res = await fetch(url, { headers: this.getAuthHeaders() });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error?.message || data?.error || `HTTP ${res.status}`);
    }
    return res.text();
  },

  // ── B3 组合文档（多对一数据聚合：MERGED_PL 多运单合并装箱单 / MERGED_IR 多报告合并汇总） ──

  /** 按运单渲染我方出运单据；外部方文件只上传归档。 */
  async renderShipmentDocument(shipmentId: string, kind: 'CI' | 'PL', endpoint?: string, source?: ShipmentDocumentSourceBinding): Promise<string> {
    const url = buildApiUrl('/v1/customs/trade-documents/render-by-shipment', endpoint);
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ shipmentId, kind, ...source }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw Object.assign(new Error(data?.error?.message || (typeof data?.error === 'string' ? data.error : null) || data?.message || `HTTP ${res.status}`), { status: res.status, code: data?.error?.code });
    }
    return res.text();
  },

  /** 组合文档预览 HTML——POST /v1/customs/trade-documents/composite/preview.html（A4 画布，与生成 PDF 同源） */
  async getCompositeDocumentPreviewHtml(kind: 'MERGED_PL' | 'MERGED_IR' | 'CONTRACT', sourceIds: string[], endpoint?: string): Promise<string> {
    const url = buildApiUrl('/v1/customs/trade-documents/composite/preview.html', endpoint);
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, sourceIds }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    return res.text();
  },

  /**
   * §10.3-9 电子签：合并销售合同「提交签署」——POST /v1/customs/trade-documents/composite/request-sign。
   * 建 `contract:sign` 审批（DR-007 解析审批人）→ 审批中心「阅览并签署销售合同」→
   * 阅至文末点签字确认 → 一步完成盖章 + 批准。
   */
  async requestContractSign(sourceIds: string[], endpoint?: string): Promise<{ approvalId: string; status: string; sourceRef: string }> {
    const url = buildApiUrl('/v1/customs/trade-documents/composite/request-sign', endpoint);
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'CONTRACT', sourceIds }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    return { approvalId: data.approvalId, status: data.status, sourceRef: data.sourceRef };
  },

  /** 组合文档生成 PDF——POST /v1/customs/trade-documents/composite/generate.pdf（流式下载，不归档） */  async generateCompositeDocumentPdf(kind: 'MERGED_PL' | 'MERGED_IR' | 'CONTRACT', sourceIds: string[], endpoint?: string): Promise<void> {
    const url = buildApiUrl('/v1/customs/trade-documents/composite/generate.pdf', endpoint);
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, sourceIds }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
    const filename = m && m[1] ? decodeURIComponent(m[1]) : `composite-${Date.now()}.pdf`;
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  },

  async packTradeDocumentsByOrder(orderId: string, endpoint?: string): Promise<{ items: TradeDocumentPackItem[]; total: number }> {
    return requestJson<{ items: TradeDocumentPackItem[]; total: number }>(`/v1/customs/trade-documents/pack?orderId=${encodeURIComponent(orderId)}`, { endpoint, method: 'GET' });
  },

  // Customs Overview
  async getCustomsOverview(endpoint?: string): Promise<CustomsOverview> {
    return requestJson<CustomsOverview>('/v1/customs/overview', { endpoint, method: 'GET' });
  },

  // ── Notifications ──
  async listNotifications(params: { unreadOnly?: boolean; type?: string; level?: string; limit?: number; offset?: number; endpoint?: string }): Promise<{ items: NotificationItem[]; total: number }> {
    const searchParams = new URLSearchParams();
    if (params.unreadOnly) searchParams.set('unreadOnly', 'true');
    if (params.type) searchParams.set('type', params.type);
    if (params.level) searchParams.set('level', params.level);
    if (params.limit) searchParams.set('limit', String(params.limit));
    if (params.offset) searchParams.set('offset', String(params.offset));
    const query = searchParams.toString();
    return requestJson<{ items: NotificationItem[]; total: number }>(`/v1/notifications${query ? `?${query}` : ''}`, { endpoint: params.endpoint, method: 'GET' });
  },

  async getNotificationStats(endpoint?: string): Promise<NotificationStats> {
    return requestJson<NotificationStats>('/v1/notifications/stats', { endpoint, method: 'GET' });
  },

  async markNotificationAsRead(notificationId: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/notifications/${encodeURIComponent(notificationId)}/read`, { endpoint, method: 'POST' });
  },

  async markAllNotificationsAsRead(endpoint?: string): Promise<{ count: number }> {
    const data = await requestJson<{ ok: boolean; count: number }>('/v1/notifications/read-all', { endpoint, method: 'POST' });
    return { count: data.count || 0 };
  },

  async deleteNotification(notificationId: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/notifications/${encodeURIComponent(notificationId)}`, { endpoint, method: 'DELETE' });
  },

  // PRD 7.1「忽略需填原因」：忽略通知（乐观移除由调用方处理；原因用于推送准确率优化）
  async dismissNotification(notificationId: string, reason: string, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/notifications/${encodeURIComponent(notificationId)}/dismiss`, {
      endpoint,
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },

  // ── D2 主动提醒引擎：偏好控制面 + 转跟进闭环 ──
  async getNotificationTypeCatalog(endpoint?: string): Promise<NotificationTypeCatalogItem[]> {
    const data = await requestJson<{ items: NotificationTypeCatalogItem[] }>('/v1/notifications/catalog', { endpoint, method: 'GET' });
    return Array.isArray(data.items) ? data.items : [];
  },

  async upsertNotificationPreference(notificationType: string, isEnabled: boolean, endpoint?: string): Promise<void> {
    await requestJson<{ ok: boolean }>(`/v1/notifications/preferences/${encodeURIComponent(notificationType)}`, {
      endpoint,
      method: 'PUT',
      body: JSON.stringify({ isEnabled }),
    });
  },

  async convertNotificationToFollowUp(notificationId: string, endpoint?: string): Promise<{ reused: boolean; followUpId?: string; nextFollowUpAt?: string | null }> {
    const data = await requestJson<{ ok: boolean; reused?: boolean; followUpId?: string; nextFollowUpAt?: string | null; error?: string; message?: string }>(
      `/v1/notifications/${encodeURIComponent(notificationId)}/convert-to-followup`,
      { endpoint, method: 'POST' },
    );
    if (!data.ok) throw new Error(data.message || data.error || '转跟进失败');
    return { reused: data.reused ?? false, followUpId: data.followUpId, nextFollowUpAt: data.nextFollowUpAt ?? null };
  },

  // ── 业务审批中心（PRD 19.21；JWT+角色门禁由服务端强制，未登录/无权限时抛错由 UI 降级处理）──
  async listApprovals(params?: { status?: 'pending' | 'done'; endpoint?: string }): Promise<ApprovalRequestItem[]> {
    const query = params?.status === 'done' ? '?status=done' : '';
    const data = await requestJson<{ items: ApprovalRequestItem[] }>(`/v1/approvals${query}`, { endpoint: params?.endpoint, method: 'GET' });
    return Array.isArray(data.items) ? data.items : [];
  },

  async decideApproval(approvalId: string, status: Exclude<ApprovalRequestStatus, 'pending' | 'cancelled'>, decisionNote?: string, endpoint?: string): Promise<ApprovalRequestItem> {
    const data = await requestJson<{ item: ApprovalRequestItem }>(`/v1/approvals/${encodeURIComponent(approvalId)}/decide`, {
      endpoint,
      method: 'POST',
      body: JSON.stringify({ status, decisionNote }),
    });
    return data.item;
  },

  // ── 平台配置：公司档案（W7 设置域 §1A 裁决；真源服务端 SystemConfig global::company.exporterProfile）──
  async getCompanyExporterProfile(endpoint?: string): Promise<CompanyExporterProfileResponse> {
    return requestJson<CompanyExporterProfileResponse>('/v1/config/company.exporterProfile', { endpoint, method: 'GET' });
  },

  async updateCompanyExporterProfile(
    payload: { value: CompanyExporterProfileValue; reason?: string },
    endpoint?: string,
  ): Promise<CompanyExporterProfileUpdateResponse> {
    return requestJson<CompanyExporterProfileUpdateResponse>('/v1/config/company.exporterProfile', {
      endpoint,
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  },

  async listCompanyExporterProfileHistory(
    params: { limit?: number } = {},
    endpoint?: string,
  ): Promise<CompanyExporterProfileHistoryItem[]> {
    const query = params.limit ? `?limit=${encodeURIComponent(String(params.limit))}` : '';
    const data = await requestJson<{ items: CompanyExporterProfileHistoryItem[] }>(
      `/v1/config/company.exporterProfile/history${query}`,
      { endpoint, method: 'GET' },
    );
    return Array.isArray(data.items) ? data.items : [];
  },

  // ── 市场行情（羊毛 / 亚麻）：读取 + 立即同步（外部源自动，人工写入仅作应急覆盖）──
  async getMarketManualQuotes(endpoint?: string): Promise<Record<string, MarketManualQuote>> {
    const data = await requestJson<{ quotes: Record<string, MarketManualQuote> }>(
      '/v1/market/quotes/manual',
      { endpoint, method: 'GET' },
    );
    return data.quotes || {};
  },

  /** 立即跑一轮外部源同步（不等每日调度）。返回每个源的结果 + 同步后的最新值 */
  async refreshMarketQuotes(endpoint?: string): Promise<{
    report: MarketQuoteSyncReport;
    quotes: Record<string, MarketManualQuote>;
  }> {
    return requestJson<{ report: MarketQuoteSyncReport; quotes: Record<string, MarketManualQuote> }>(
      '/v1/market/quotes/refresh',
      { endpoint, method: 'POST' },
    );
  },

  async updateMarketManualQuote(
    key: 'wool' | 'linen',
    payload: { price: number; asOf?: string | null; note?: string | null; reason?: string },
    endpoint?: string,
  ): Promise<MarketManualQuote> {
    const data = await requestJson<{ quote: MarketManualQuote }>(
      `/v1/market/quotes/manual/${encodeURIComponent(key)}`,
      { endpoint, method: 'PUT', body: JSON.stringify(payload) },
    );
    return data.quote;
  },

  // ── 自动化规则 ──
  async listAutomationRules(endpoint?: string): Promise<AutomationRule[]> {
    const data = await requestJson<{ rules: AutomationRule[] }>('/v1/automation/rules', { endpoint, method: 'GET' });
    return data.rules || [];
  },

  async updateAutomationRule(ruleId: string, enabled: boolean, endpoint?: string): Promise<AutomationRule> {
    return requestJson<{ rule: AutomationRule }>(`/v1/automation/rules/${encodeURIComponent(ruleId)}`, {
      endpoint,
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }).then(data => data.rule);
  },

  // ── 工作流引擎 ──
  async listWorkflowDefinitions(endpoint?: string): Promise<WorkflowDefinition[]> {
    const data = await requestJson<{ definitions: WorkflowDefinition[] }>('/v1/workflow/definitions', { endpoint, method: 'GET' });
    return data.definitions || [];
  },

  async listWorkflowSources(params: { entityType: 'Order' | 'Invoice' | 'DevelopmentCase'; limit?: number; offset?: number; endpoint?: string }): Promise<{ items: { id: string; label: string; type: 'Order' | 'Invoice' | 'DevelopmentCase' }[]; total: number; limit: number; offset: number }> {
    const query = new URLSearchParams({ entityType: params.entityType, limit: String(params.limit ?? 50), offset: String(params.offset ?? 0) });
    return requestJson(`/v1/workflow/sources?${query}`, { endpoint: params.endpoint, method: 'GET' });
  },

  async queryWorkflowRequest(params: { action: 'create' | 'approve' | 'reject' | 'cancel'; originalClientRequestId: string; originalPayload: Record<string, unknown> }, endpoint?: string): Promise<import('../types').WorkflowRequestResult> {
    return requestJson('/v1/workflow/requests/result', { endpoint, method: 'POST', body: JSON.stringify(params) });
  },

  async retireWorkflowRequest(params: { action: 'create' | 'approve' | 'reject' | 'cancel'; originalClientRequestId: string; originalPayload: Record<string, unknown>; retirementClientRequestId: string; reason: string }, endpoint?: string): Promise<import('../types').WorkflowRequestResult> {
    return requestJson('/v1/workflow/requests/retire', { endpoint, method: 'POST', body: JSON.stringify(params) });
  },

  async listWorkflowInstances(params: {
    view?: 'visible' | 'mine' | 'pending';
    status?: string;
    entityType?: string;
    entityId?: string;
    pendingApproverUserId?: string;
    pendingApproverRole?: string;
    limit?: number;
    offset?: number;
    endpoint?: string;
  } = {}): Promise<{ items: WorkflowInstance[]; total: number }> {
    const query = Object.entries(params)
      .filter(([key, v]) => key !== 'endpoint' && v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const path = query ? `/v1/workflow/instances?${query}` : '/v1/workflow/instances';
    return requestJson<{ items: WorkflowInstance[]; total: number }>(path, {
      endpoint: params.endpoint,
      method: 'GET',
    });
  },

  async getWorkflowInstance(instanceId: string, endpoint?: string): Promise<WorkflowInstance> {
    const data = await requestJson<{ instance: WorkflowInstance }>(`/v1/workflow/instances/${encodeURIComponent(instanceId)}`, { endpoint, method: 'GET' });
    return data.instance;
  },

  async createWorkflowInstance(params: {
    clientRequestId: string;
    definitionId: string;
    entityType: string;
    entityId: string;
    title?: string;
    endpoint?: string;
  }): Promise<WorkflowInstance> {
    const data = await requestJson<{ instance: WorkflowInstance }>('/v1/workflow/instances', {
      endpoint: params.endpoint,
      method: 'POST',
      body: JSON.stringify({
        clientRequestId: params.clientRequestId,
        definitionId: params.definitionId,
        entityType: params.entityType,
        entityId: params.entityId,
        title: params.title,
      }),
    });
    return data.instance;
  },

  async approveWorkflowStep(instanceId: string, note: string | undefined, command: WorkflowStepCommand, endpoint?: string): Promise<WorkflowInstance> {
    const data = await requestJson<{ instance: WorkflowInstance }>(`/v1/workflow/instances/${encodeURIComponent(instanceId)}/approve`, {
      endpoint,
      method: 'POST',
      body: JSON.stringify({ ...command, note }),
    });
    return data.instance;
  },

  async rejectWorkflowStep(instanceId: string, note: string | undefined, command: WorkflowStepCommand, endpoint?: string): Promise<WorkflowInstance> {
    const data = await requestJson<{ instance: WorkflowInstance }>(`/v1/workflow/instances/${encodeURIComponent(instanceId)}/reject`, {
      endpoint,
      method: 'POST',
      body: JSON.stringify({ ...command, note }),
    });
    return data.instance;
  },

  async cancelWorkflowInstance(instanceId: string, reason: string, command: WorkflowStepCommand, endpoint?: string): Promise<WorkflowInstance> {
    const data = await requestJson<{ instance: WorkflowInstance }>(`/v1/workflow/instances/${encodeURIComponent(instanceId)}/cancel`, {
      endpoint,
      method: 'POST',
      body: JSON.stringify({ ...command, reason }),
    });
    return data.instance;
  },

  async getEntityWorkflowHistory(entityType: string, entityId: string, endpoint?: string): Promise<WorkflowInstance[]> {
    const data = await requestJson<{ instances: WorkflowInstance[] }>(`/v1/workflow/entity/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`, { endpoint, method: 'GET' });
    return data.instances || [];
  },

  // ── 资料完备度引擎（GET /api/completeness/*）──
  // 提示型增强数据：调用方（列表徽标 / 详情横幅）在失败时降级为不展示，
  // 故本组函数保持 requestJson 标准抛错语义，由调用方统一 catch 降级。
  async completenessSummary(endpoint?: string): Promise<CompletenessSummaryData> {
    const data = await requestJson<{ ok: boolean; data: CompletenessSummaryData }>('/completeness/summary', { endpoint, method: 'GET' });
    return data?.data;
  },

  async completenessEntity(entityType: CompletenessEntityType, id: string, endpoint?: string): Promise<CompletenessEntityData> {
    const query = new URLSearchParams({ type: entityType, id });
    const data = await requestJson<{ ok: boolean; data: CompletenessEntityData }>(
      `/completeness/entity?${query.toString()}`,
      { endpoint, method: 'GET' },
    );
    return data?.data;
  },

  async completenessBatch(entityType: 'product' | 'relation', endpoint?: string): Promise<CompletenessBatchData> {
    const data = await requestJson<{ ok: boolean; data: CompletenessBatchData }>(
      `/completeness/batch?type=${encodeURIComponent(entityType)}`,
      { endpoint, method: 'GET' },
    );
    return data?.data;
  },
};
