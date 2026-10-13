import { createShipment as createSharedShipment, updateShipment as updateSharedShipment } from '../shipping/shipmentMutationService';
import { AsyncLocalStorage } from 'node:async_hooks';
import { updateDevelopmentStage as mutateDevelopmentStage } from '../development/developmentCaseMutationService';
import { PrismaClient, Prisma } from '@prisma/client';
import { logger } from '../lib/logger';
import { logAgentFailure, publicAgentFailure } from './publicFailure';
// ★ 口径 E4：未结清应收判据的**唯一真源**（含 amount > 0 守卫），不手写状态集合
import { openReceivableWhere } from '../shared/openReceivable';
import { registerTool, dispatchFromRegistry, getRegisteredToolCount } from './toolDispatchRegistry';
import { registerNewDomainQueryTools } from './newDomainQueryTools';
import { getToolOutcome } from './toolOutcome';
import { DEFAULT_AGENT_TOOLS } from './defaults';
import { createPolicyService } from './policy';
import { executeActorMemoryTool } from './memoryAuthorization';
import { createAgentLinksService } from '../entities/agentLinksService';
import { AiEmit } from '../ai/runtime';
import { emitAgentWorkEvent } from './events';
import { getToolManifestSafety } from './mcp/manifest';
import { ActorContext, KnowledgeHit, ToolRisk } from './types';
import { isFinanceReadProjection, withFinanceReadProjection } from '../finance/financeReadProjection';
import { createAllocation } from '../finance/allocationMutationService';
import { toolActorToken } from './toolActorContext';
import { businessNowMs } from '../shared/businessClock';
import { resolveActorUserAccountId } from './actorIdentity';
import { SYSTEM_AUDIT_ACTOR } from '../audit/routeAudit';
import { createApprovalRoutingService } from '../approvals/approvalRoutingService';
import { describeOrderSchema, getOrder, queryOrders } from '../orders/query';
// ★ B50：订单状态写入的唯一引擎（确认门禁 / 转换矩阵 / AuditLog / 事务都在它里面）。
//   此前 orders.update_status 与 orders.batch_status 各自手抄了一份"读旧状态 → 写 transition → update status"，
//   结果四条控制一条都没有。先例：agent/orderLifecycleFlow.ts:12 早已 import 同一函数。
import { transitionOrderStatus } from '../orders/orderLifecycleService';
import { describeRelationSchema, expandRelation, getRelation, queryRelations } from '../relations/query';
import { hydrateEntities, searchEntities } from '../entities/search';
import { syncInvoiceReferences, syncPaymentVoucherReferences, syncShipmentReferences, syncRelationEntityReferences } from '../entities/sync';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { validateStatusTransition } from '../statusTransition';
import { linkOrderStatusFromShipment } from '../shipping/orderLinkService';
import { createOrderShipmentBatchService } from '../shipping/orderShipmentBatchService';
import { extractEmailAi } from '../email/aiExtract';
import { syncEmailReferences } from '../email/sync';
import { createInvoice, updateInvoice } from '../finance/invoiceMutationService';
import { createPaymentVoucher, updatePaymentVoucher } from '../finance/paymentVoucherMutationService';
import { applyAllocation, readAllocationRefusal } from '../finance/allocationService';
import { readSupplierClaimRefusal } from '../finance/supplierClaimSettlementGuard';
import { readCashRefundRefusal } from '../claims/claimCashRefundFact';
import { sumAppliedAmountByInvoice } from '../shared/invoiceAppliedSum';
import { getAgingReport, getCustomerStatement } from '../finance/reportService';
import { createQuotationService } from '../quotations/quotationService';
import { createCustomsService } from '../customs/customsService';
import { scanDelayedShipments } from '../shipping/shipmentDelayService';
import {
  listTemplates as listAvailableTemplates,
  renderTemplate as renderTemplateById,
  readTemplateRefusal,
  type TemplateId,
} from '../templates/render';
import { renderHtmlToPdf } from '../templates/pdf';
import { saveRenderedDoc, savePdfFile } from '../templates/store';
import { assessAgentLoopStep } from './loopController';
import { resolveApprovalDecision, buildOrderConfirmProcessDraft, getToolDefinition, P0B_TOOL_DEFINITIONS, loadOrderSnapshot, validateOrderSnapshot, type ProcessDraft, type OrderSnapshotForDraft } from './toolRegistry';
import { buildOrderConfirmError } from './feedbackContract';
import { commitOrderConfirm, recoverProcessDraftFromPayload } from './commitTransaction';
import { buildPaymentReconcileDraft, commitPaymentReceiveAndReconcile, validateReconcileDraftSemantics, verifyReconcileDraftHash, buildPaymentReconcileError } from './reconcileFlow';
import { buildOrderShipDraft, commitOrderShip, validateOrderShipDraftSemantics, verifyOrderShipDraftHash, buildOrderShipError } from './orderShipFlow';
import { buildEmailReplySendDraft, commitEmailReplySend, validateEmailReplySendDraftSemantics, verifyEmailReplySendDraftHash, buildEmailReplySendError } from './emailReplySendFlow';
import { buildRelationOnboardDraft, commitRelationOnboard, validateRelationOnboardDraftSemantics, verifyRelationOnboardDraftHash, buildRelationOnboardError } from './relationOnboardFlow';
import { buildRelationUpdateDraft, commitRelationUpdate, validateRelationUpdateDraftSemantics, buildRelationDeleteDraft, commitRelationDelete, validateRelationDeleteDraftSemantics, buildRelationMutationError } from './relationMutationFlow';
import { buildInvoiceIssueDraft, commitInvoiceIssue, validateInvoiceIssueDraftSemantics, verifyInvoiceIssueDraftHash, buildInvoiceIssueError } from './invoiceIssueFlow';
import { buildInvoiceCreateDraft, buildInvoiceUpdateDraft, commitInvoiceCreate, commitInvoiceUpdate, validateInvoiceCreateDraftSemantics, validateInvoiceUpdateDraftSemantics, buildInvoiceMutationError, checkCurrentInvoiceToolActor } from './invoiceMutationFlow';
import { buildEmailSendOutboxDraft, commitEmailSendOutbox, validateEmailSendOutboxDraftSemantics, verifyEmailSendOutboxDraftHash, buildEmailSendOutboxError, redactEmailSendInput } from './emailSendOutboxFlow';
import { readDurableOutboxContext } from '../email/outboxSendAttemptService';
import { buildEmailSyncDraft, commitEmailSync, validateEmailSyncDraftSemantics, verifyEmailSyncDraftHash } from './emailSyncFlow';
import { buildKnowledgeIngestDraft, commitKnowledgeIngest, validateKnowledgeIngestDraftSemantics, verifyKnowledgeIngestDraftHash } from './knowledgeIngestFlow';
import { putEmailCredential, takeEmailCredential, putEmailSendCredential } from './emailCredentialStore';
import { buildDevConvertDraft, commitDevConvert, validateDevConvertDraftSemantics, verifyDevConvertDraftHash, buildDevConvertError } from './developmentConvertFlow';
import { buildDevCreateDraft, commitDevCreate, validateDevCreateDraftSemantics, verifyDevCreateDraftHash, buildDevCreateError } from './developmentCreateFlow';
import { buildStatementSendDraft, commitStatementSend, validateStatementSendDraftSemantics, verifyStatementSendDraftHash, buildStatementSendError, statementHasActivity } from './statementSendFlow';
import { buildInvoiceCancelDraft, commitInvoiceCancel, validateInvoiceCancelDraftSemantics, verifyInvoiceCancelDraftHash, buildInvoiceCancelError } from './invoiceCancelFlow';
import { buildInvoiceDeleteDraft, commitInvoiceDelete, validateInvoiceDeleteDraftSemantics, buildPaymentVoucherDeleteDraft, commitPaymentVoucherDelete, validatePaymentVoucherDeleteDraftSemantics, buildFinanceSoftDeleteError } from './financeSoftDeleteFlow';
import { buildProductAssetCreateDraft, commitProductAssetCreate, buildProductAssetUpdateDraft, commitProductAssetUpdate, buildProductAssetDeleteDraft, commitProductAssetDelete, buildProductAssetFlowError } from './productAssetMutationFlow';
import { buildPaymentVoucherCreateDraft, commitPaymentVoucherCreate, validatePaymentVoucherCreateDraftSemantics, buildPaymentVoucherUpdateDraft, commitPaymentVoucherUpdate, validatePaymentVoucherUpdateDraftSemantics, buildPaymentVoucherFlowError } from './paymentVoucherMutationFlow';
import { PRODUCT_ASSET_WRITABLE_FIELDS } from '../products/productAssetWritable';
import { maskProductCost } from '../products/productCostVisibility';
import { buildOrderStatusTransitionDraft, commitOrderStatusTransition, validateOrderStatusTransitionDraftSemantics, buildOrderDeleteDraft, commitOrderDelete, validateOrderDeleteDraftSemantics, buildOrderLifecycleError } from './orderLifecycleFlow';
import { buildOrderLineUpdateDraft, commitOrderLineUpdate, validateOrderLineUpdateDraftSemantics, verifyOrderLineUpdateDraftHash, buildOrderLineUpdateError } from './orderLineUpdateFlow';
import { registerOrderChangesFlowTools, buildOrderChangeCreateDraft, validateOrderChangeCreateDraftSemantics, verifyOrderChangeCreateDraftHash, buildOrderChangeWithdrawDraft, validateOrderChangeWithdrawDraftSemantics, verifyOrderChangeWithdrawDraftHash, buildOrderChangesFlowError } from './orderChangesFlow';
import { registerPaymentRequestsFlowTools, buildPaymentRequestCreateDraft, validatePaymentRequestCreateDraftSemantics, verifyPaymentRequestCreateDraftHash, buildPaymentRequestCancelDraft, validatePaymentRequestCancelDraftSemantics, verifyPaymentRequestCancelDraftHash, buildPaymentRequestsFlowError } from './paymentRequestsFlow';
import { registerCreditFlowTools, buildCreditFreezeDraft, validateCreditFreezeDraftSemantics, verifyCreditFreezeDraftHash, buildCreditThawDraft, validateCreditThawDraftSemantics, verifyCreditThawDraftHash, buildCreditFlowError } from './creditFlow';
import { registerSamplesFlowTools, buildSampleRoundCreateDraft, validateSampleRoundCreateDraftSemantics, verifySampleRoundCreateDraftHash, buildSampleSubmitToCustomerDraft, validateSampleSubmitToCustomerDraftSemantics, verifySampleSubmitToCustomerDraftHash, buildSampleCustomerConfirmationDraft, validateSampleCustomerConfirmationDraftSemantics, verifySampleCustomerConfirmationDraftHash, buildSamplesFlowError } from './samplesFlow';
import { registerQcFlowTools, buildQcGarmentReviewDraft, validateQcGarmentReviewDraftSemantics, verifyQcGarmentReviewDraftHash, buildQcFabricReviewDraft, validateQcFabricReviewDraftSemantics, verifyQcFabricReviewDraftHash, buildQcSignReportDraft, validateQcSignReportDraftSemantics, verifyQcSignReportDraftHash, buildQcFlowError } from './qcFlow';
import { registerInternalTradeFlowTools, buildInternalTradeCreateDraft, validateInternalTradeCreateDraftSemantics, verifyInternalTradeCreateDraftHash, buildInternalTradeConfirmDraft, validateInternalTradeConfirmDraftSemantics, verifyInternalTradeConfirmDraftHash, buildInternalTradeFlowError } from './internalTradeFlow';
import { registerProcurementFlowTools, buildProcurementCreateDraft, validateProcurementCreateDraftSemantics, verifyProcurementCreateDraftHash, buildProcurementUpdateStatusDraft, validateProcurementUpdateStatusDraftSemantics, verifyProcurementUpdateStatusDraftHash, buildProcurementFlowError } from './procurementFlow';
import { registerInventoryFlowTools, buildInventoryAdjustStockDraft, validateInventoryAdjustStockDraftSemantics, verifyInventoryAdjustStockDraftHash, buildInventoryFlowError } from './inventoryFlow';
import { registerQuotationFlowTools, buildQuotationCreateDraft, validateQuotationCreateDraftSemantics, verifyQuotationCreateDraftHash, buildQuotationUpdateDraft, validateQuotationUpdateDraftSemantics, verifyQuotationUpdateDraftHash, buildQuotationFlowError } from './quotationFlow';
import { registerCustomsFlowTools, buildCustomsRegisterLcDraft, validateCustomsRegisterLcDraftSemantics, verifyCustomsRegisterLcDraftHash, buildCustomsUpdateDeclarationDraft, validateCustomsUpdateDeclarationDraftSemantics, verifyCustomsUpdateDeclarationDraftHash, buildCustomsFlowError } from './customsFlow';
import { stripLineWritable, ORDER_LINE_WRITABLE_FIELDS } from '../orders/orderLineWritable';
import { PAYMENT_VOUCHER_CREATE_FIELDS, PAYMENT_VOUCHER_PATCH_FIELDS, VALID_PAYMENT_VOUCHER_STATUS } from '../finance/paymentVoucherMutationService';
import { AgentTaskFrame } from './taskFrame';
import { RELATION_UPDATE_FIELDS, VALID_RELATION_CATEGORIES } from '../relations/relationMutationService';
import { INVOICE_CREATE_FIELDS, INVOICE_PATCH_FIELDS } from '../finance/invoiceMutationService';

export type PlannedToolCall = {
  toolId: string;
  input: Record<string, unknown>;
  reason: string;
};

type ToolRunResult = {
  hit: KnowledgeHit;
  output: unknown;
  toolRunId?: string;
  risk?: ToolRisk;
  /** Phase 7-58: 工具被审批拦截时 ApprovalRequest 主键。命中此字段时 hit/output 为空。 */
  approvalPending?: {
    approvalId: string;
    risk: ToolRisk;
    editableFields?: string[];
  };
};

type ToolDefinition = {
  id: string;
  name: string;
  scope: string;
  risk: ToolRisk;
};

type ProductFieldDefinition = {
  path: string;
  label: string;
  type: 'text' | 'number' | 'enum' | 'relation' | 'array';
  filterable: boolean;
  sortable?: boolean;
  operators: Array<'contains' | 'equals' | 'gte' | 'lte'>;
  queryPath?: string;
};

const PRODUCT_FIELD_DEFINITIONS: ProductFieldDefinition[] = [
  { path: 'sku', label: 'SKU / 品号', type: 'text', filterable: true, sortable: true, operators: ['contains', 'equals'] },
  { path: 'name', label: '名称', type: 'text', filterable: true, sortable: true, operators: ['contains', 'equals'] },
  { path: 'mainCategory', label: '主分类', type: 'enum', filterable: true, operators: ['contains', 'equals'] },
  { path: 'subCategoryId', label: '子分类', type: 'text', filterable: true, operators: ['contains', 'equals'] },
  { path: 'season', label: '季节', type: 'text', filterable: true, operators: ['contains', 'equals'] },
  { path: 'status', label: '状态', type: 'enum', filterable: true, sortable: true, operators: ['contains', 'equals'] },
  { path: 'updatedAt', label: '更新时间', type: 'number', filterable: true, sortable: true, operators: ['gte', 'lte'] },
  { path: 'fabric.articleNo', label: '面料 Article No.', type: 'text', filterable: true, sortable: false, operators: ['contains', 'equals'] },
  { path: 'fabric.millQuality', label: 'Mill Quality', type: 'text', filterable: true, operators: ['contains', 'equals'] },
  { path: 'fabric.millOrganizationId', label: '供应商 / 生产工厂', type: 'text', filterable: true, operators: ['contains', 'equals'] },
  { path: 'fabric.millColorCode', label: '工厂色号', type: 'text', filterable: true, operators: ['contains', 'equals'] },
  { path: 'fabric.colorDescription', label: '颜色描述', type: 'text', filterable: true, operators: ['contains', 'equals'] },
  { path: 'fabric.construction', label: '组织', type: 'text', filterable: true, operators: ['contains', 'equals'] },
  { path: 'fabric.yarnCount', label: '纱支', type: 'text', filterable: true, operators: ['contains', 'equals'] },
  { path: 'fabric.pattern', label: '花型', type: 'text', filterable: true, operators: ['contains', 'equals'] },
  { path: 'fabric.weightValue', label: '克重数值', type: 'number', filterable: true, operators: ['gte', 'lte', 'equals'] },
  { path: 'fabric.weightUnit', label: '克重单位', type: 'enum', filterable: true, operators: ['contains', 'equals'] },
  { path: 'fabric.widthValue', label: '门幅数值', type: 'number', filterable: true, operators: ['gte', 'lte', 'equals'] },
  { path: 'fabric.widthText', label: '门幅文本', type: 'text', filterable: true, operators: ['contains', 'equals'] },
  { path: 'fabric.stockStatus', label: '现货状态', type: 'enum', filterable: true, operators: ['contains', 'equals'] },
  { path: 'fabric.stockQuantity', label: '现货数量', type: 'number', filterable: true, operators: ['gte', 'lte', 'equals'] },
  { path: 'fabric.moqValue', label: '起订量', type: 'number', filterable: true, operators: ['gte', 'lte', 'equals'] },
  { path: 'fabric.riskNote', label: '品质风险', type: 'text', filterable: true, operators: ['contains'] },
  { path: 'fabric.specialNote', label: '特殊备注', type: 'text', filterable: true, operators: ['contains'] },
  { path: 'fabric.certification', label: '认证许可', type: 'array', filterable: true, operators: ['contains', 'equals'] },
  { path: 'fabric.customerCode', label: '客户码', type: 'array', filterable: true, operators: ['contains', 'equals'] },
  { path: 'fabric.compositionTerm', label: '成分名称 / 缩写', type: 'array', filterable: true, operators: ['contains', 'equals'] },
  { path: 'fabric.compositionPercentage', label: '成分比例', type: 'number', filterable: true, operators: ['gte', 'lte', 'equals'] },
  { path: 'fabric.priceAmount', label: '价格金额', type: 'number', filterable: true, operators: ['gte', 'lte', 'equals'] },
  { path: 'fabric.priceType', label: '价格类型', type: 'enum', filterable: true, operators: ['contains', 'equals'] },
  { path: 'garment.styleNo', label: '成衣款号', type: 'text', filterable: true, operators: ['contains', 'equals'] },
  { path: 'garment.customer', label: '成衣客户', type: 'text', filterable: true, operators: ['contains', 'equals'] },
  { path: 'garment.brand', label: '品牌', type: 'text', filterable: true, operators: ['contains', 'equals'] },
  { path: 'garment.factory', label: '成衣工厂', type: 'text', filterable: true, operators: ['contains', 'equals'] },
  { path: 'trimming.trimmingCode', label: '辅料编码', type: 'text', filterable: true, operators: ['contains', 'equals'] },
  { path: 'trimming.trimmingName', label: '辅料名称', type: 'text', filterable: true, operators: ['contains', 'equals'] },
  { path: 'trimming.supplier', label: '辅料供应商', type: 'text', filterable: true, operators: ['contains', 'equals'] },
  { path: 'trimming.stockStatus', label: '辅料库存状态', type: 'enum', filterable: true, operators: ['contains', 'equals'] },
];

const TOOL_DEFINITIONS = new Map<string, ToolDefinition>(
  DEFAULT_AGENT_TOOLS.map(tool => [tool.id, {
    id: tool.id,
    name: tool.name,
    scope: tool.scope,
    risk: tool.risk,
    description: (tool as any).description || '',
    inputHint: (tool as any).inputHint || undefined,
  }]),
);
// P0-B: merge 四切片定义（补齐 order.confirm 等 flow API 未在 DEFAULT_AGENT_TOOLS 的工具）
for (const p0bDef of P0B_TOOL_DEFINITIONS) {
  if (!TOOL_DEFINITIONS.has(p0bDef.id)) {
    TOOL_DEFINITIONS.set(p0bDef.id, {
      id: p0bDef.id,
      name: p0bDef.name,
      scope: p0bDef.scope,
      risk: p0bDef.risk,
    });
  }
}

export function planAgentToolCalls(query: string): PlannedToolCall[] {
  const normalized = query.toLowerCase();
  const calls: PlannedToolCall[] = [];
  const exactProductLookup = extractProductLookup(query);
  const wantsProductSchema = isProductCatalogQuery(normalized)
    && /(字段|schema|结构|有哪些|能查什么|怎么查)/i.test(query);
  const subcategoryCountQuery = isProductCatalogQuery(normalized) && isCountQuery(normalized)
    ? extractProductSubcategoryCountQuery(query)
    : '';

  if (exactProductLookup && isProductCatalogQuery(normalized)) {
    calls.push({
      toolId: 'products.get',
      input: { ...exactProductLookup, followUp: { expand: true, include: inferProductExpandInclude(query) } },
      reason: '用户询问某一条数字档案，需要按唯一标识读取完整产品档案',
    });
  }

  if (subcategoryCountQuery) {
    calls.push({
      toolId: 'dictionary.query',
      input: {
        dictionary: 'productSubCategory',
        mainCategory: 'Fabric',
        query: subcategoryCountQuery,
        intent: 'resolve_product_subcategory_for_count',
      },
      reason: '用户询问某类面料数量，需要先解析标准子分类再统计记录',
    });
  } else if (isProductCatalogQuery(normalized) && isCountQuery(normalized)) {
    calls.push({
      toolId: 'products.count',
      input: { mainCategory: 'Fabric', includeProductAssetTotal: true },
      reason: '用户询问数字档案/面料库统计，需要后端工具返回全库数量',
    });
  }

  if (wantsProductSchema) {
    calls.push({
      toolId: 'products.describe_schema',
      input: { entity: 'ProductAsset' },
      reason: '用户询问数字档案可查询字段/筛选/排序能力，需要读取后端字段能力清单',
    });
  }

  if (isProductCatalogQuery(normalized) && !isCountQuery(normalized) && !exactProductLookup && !wantsProductSchema) {
    calls.push({
      toolId: 'products.query',
      input: extractProductQueryInput(query, normalized),
      reason: '用户询问数字档案/产品/面料，需要按通用筛选条件查询产品档案',
    });
  }

  // 注意：订单/关系类规划已迁移到 mcp/planner.ts，由 extractOrderQuery / inferOrderFilters /
  //       buildRelationQueryInput 等结构化抽取函数生成精确入参。这里若再 push 一份 legacy
  //       'orders.search' / 'relations.search'，mapLegacyToolCall 会把整句中文当 query 透传，
  //       且会被 SINGLE_STEP_TOOLS 去重器先于精确路径占位，导致 filters.customer 永远为空。
  //       因此此处不再生成订单/关系类工具调用，由上层 planMcpToolCalls 统一负责。

  return calls;
}

/**
 * agentLoop 专用的工具执行入口。
 *
 * 与 runAgentToolCalls 不同：
 *   - 不做"自动 follow-up"循环（那是 LLM 的职责）。
 *   - 不做事件 emit（agentLoop 自己负责 tool_call_start / tool_call_end）。
 *   - 仅做 1 次 policy 校验 + 1 次 dispatch + 完整 audit 记录。
 *
 * 返回值：
 *   - 成功：output（工具原始返回）
 *   - 失败：抛错（含 policy 拒绝、handler 缺失、handler 抛错）
 */
const emailSendSecrets = new WeakMap<object, { password: string; suppliedRef: boolean }>();
function sanitizeEmailSendInput(input: Record<string, unknown>): Record<string, unknown> {
  const c = input.credentials && typeof input.credentials === 'object' && !Array.isArray(input.credentials) ? input.credentials as any : {};
  const internal = emailSendSecrets.get(input);
  const secret = internal || { password: typeof c.pass === 'string' && c.pass ? c.pass
    : typeof input.password === 'string' ? input.password : '', suppliedRef: c.credentialRef !== undefined };
  const safe = redactEmailSendInput(input);
  delete (safe.credentials as any).credentialRef;
  emailSendSecrets.set(safe, secret);
  return safe;
}

export async function executeAgentTool(input: {
  prisma: PrismaClient;
  actor: ActorContext;
  toolId: string;
  toolInput: Record<string, unknown>;
  sessionId?: string;
  actorUserId?: string;
  requestSource?: 'user-session' | 'api-key' | 'dev';
  skipApprovalCheck?: boolean;
  // P1-A: 审批通过后重跑时携带 approvalId，用于精确恢复已审批 ProcessDraft
  approvalId?: string;
}): Promise<unknown> {
  // Sanitize before policy failures, events and approval persistence, including
  // the legacy top-level password shape. Secret material remains ephemeral.
  if (input.toolId === 'email.send') input = { ...input, toolInput: sanitizeEmailSendInput(input.toolInput) };
  const definition = TOOL_DEFINITIONS.get(input.toolId);
  if (!definition) {
    throw new Error(`TOOL_NOT_REGISTERED: ${input.toolId}`);
  }

  const policy = createPolicyService();
  const decision = policy.canUseTool(input.actor, {
    toolId: definition.id,
    scope: definition.scope,
    risk: definition.risk,
    input: input.toolInput,
  });
  if (!decision.allowed) {
    await recordAgentToolRun(input.prisma, {
      actor: input.actor,
      definition,
      status: 'failed',
      toolInput: input.toolInput,
      error: decision.reason || 'TOOL_NOT_ALLOWED',
      startedAt: new Date(),
      sessionId: input.sessionId,
      actorUserId: input.actorUserId,
      requestSource: input.requestSource,
    });
    throw new Error(`TOOL_NOT_ALLOWED: ${decision.reason || 'role_not_allowed'}`);
  }

  // 审批拦截：与旧路径 runAgentToolCall 保持一致，统一走 resolveApprovalDecision 仲裁。
  // P0-B 已注册工具由 approvalPolicy 决定（优先于 manifest fail-closed），未注册工具回退 manifest。
  const safetyForAgentLoop = getToolManifestSafety(definition.id);
  const riskLevelForAgentLoop = String(definition.risk);
  const manifestRequiresApprovalForAgentLoop = safetyForAgentLoop.approval === 'always'
    || (safetyForAgentLoop.approval === 'risk_based' && (riskLevelForAgentLoop === 'high' || riskLevelForAgentLoop === 'critical'));
  // P0-B: 统一仲裁（与 runAgentToolCall 同一套 helper）
  const { requiresApproval: toolRequiresApprovalForAgentLoop } = resolveApprovalDecision({
    toolId: definition.id,
    riskLevel: riskLevelForAgentLoop,
    manifestRequiresApproval: manifestRequiresApprovalForAgentLoop,
  });

  // P0-B processSpec.draftPhase：flow API 在审批拦截前先读订单快照 + 生成 ProcessDraft
  // P1-A: 读真实订单快照（amount/currency/customer/lineCount），不硬编码
  const p0bToolDef = getToolDefinition(definition.id);
  let processDraftForApproval: ReturnType<typeof buildOrderConfirmProcessDraft> | undefined;
  if (p0bToolDef?.processSpec && p0bToolDef.id === 'order.confirm') {
    const poNumber = String(input.toolInput.poNumber || '');
    const snapshot = await loadOrderSnapshot(input.prisma, poNumber);
    const snapshotValidation = validateOrderSnapshot(snapshot);
    if (!snapshotValidation.ok) {
      // preconditions fail closed：订单快照不满足，不生成 draft
      const errMsg = `ORDER_CONFIRM_PRECONDITIONS_FAILED: ${snapshotValidation.errors.join(', ')}`;
      // 记录 toolRun 失败 + 返回结构化错误（不进审批流程）
      await recordAgentToolRun(input.prisma, {
        actor: input.actor, definition, status: 'failed',
        toolInput: input.toolInput, error: errMsg,
        startedAt: new Date(), sessionId: input.sessionId,
        actorUserId: input.actorUserId, requestSource: input.requestSource,
      });
      return {
        status: 'preconditions_failed',
        message: errMsg,
        toolId: definition.id,
        errors: snapshotValidation.errors,
      };
    }
    processDraftForApproval = buildOrderConfirmProcessDraft({
      poNumber,
      previousStatus: snapshot!.status,
      newStatus: 'Confirmed',
      snapshot: snapshot!,
    });
  }

  // task Agent-P1: payment.receive_and_reconcile draft-first（审批前生成 ProcessDraft）
  if (p0bToolDef?.processSpec && definition.id === 'payment.receive_and_reconcile') {
    const ti = input.toolInput || {};
    const voucherId = String(ti.voucherId || '');
    const voucherAmount = Number(ti.voucherAmount || 0);
    const currency = String(ti.currency || '');
    const allocations = Array.isArray(ti.allocations) ? ti.allocations : [];
    if (!voucherId || !voucherAmount || allocations.length === 0) {
      const errMsg = 'PAYMENT_RECONCILE_PRECONDITIONS_FAILED: voucherId, voucherAmount, and at least one allocation are required';
      await recordAgentToolRun(input.prisma, {
        actor: input.actor, definition, status: 'failed',
        toolInput: input.toolInput, error: errMsg,
        startedAt: new Date(), sessionId: input.sessionId,
        actorUserId: input.actorUserId, requestSource: input.requestSource,
      });
      return {
        status: 'preconditions_failed',
        message: errMsg,
        toolId: definition.id,
        errors: ['voucherId/voucherAmount/allocations required'],
      };
    }
    const draft = buildPaymentReconcileDraft({ voucherId, voucherAmount, currency, allocations });
    // draft 语义 + hash 校验（审批前确保 draft 自洽）
    const semCheck = validateReconcileDraftSemantics(draft);
    if (!semCheck.ok || !verifyReconcileDraftHash(draft).ok) {
      const errMsg = `PAYMENT_RECONCILE_DRAFT_INVALID: ${semCheck.error?.message || 'hash mismatch'}`;
      await recordAgentToolRun(input.prisma, {
        actor: input.actor, definition, status: 'failed',
        toolInput: input.toolInput, error: errMsg,
        startedAt: new Date(), sessionId: input.sessionId,
        actorUserId: input.actorUserId, requestSource: input.requestSource,
      });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    // processDraftForApproval 用 ProcessDraft 类型（payment draft 结构兼容）
    (processDraftForApproval as any) = draft;
  }

  // task ERP-P1: order.ship draft-first（审批前生成 ProcessDraft）
  if (p0bToolDef?.processSpec && definition.id === 'order.ship') {
    const ti = input.toolInput || {};
    const orderId = String(ti.orderId || '');
    const shipment = (ti.shipment || {}) as { shipmentNumber?: string; shippingMethod?: string; [key: string]: any };
    if (!orderId || !shipment.shipmentNumber || !shipment.shippingMethod) {
      const errMsg = 'ORDER_SHIP_PRECONDITIONS_FAILED: orderId, shipment.shipmentNumber, and shipment.shippingMethod are required';
      await recordAgentToolRun(input.prisma, {
        actor: input.actor, definition, status: 'failed',
        toolInput: input.toolInput, error: errMsg,
        startedAt: new Date(), sessionId: input.sessionId,
        actorUserId: input.actorUserId, requestSource: input.requestSource,
      });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['orderId/shipment.shipmentNumber/shippingMethod required'] };
    }
    const draft = buildOrderShipDraft({ orderId, shipment: shipment as any });
    const semCheck = validateOrderShipDraftSemantics(draft);
    if (!semCheck.ok || !verifyOrderShipDraftHash(draft).ok) {
      const errMsg = `ORDER_SHIP_DRAFT_INVALID: ${semCheck.error?.message || 'hash mismatch'}`;
      await recordAgentToolRun(input.prisma, {
        actor: input.actor, definition, status: 'failed',
        toolInput: input.toolInput, error: errMsg,
        startedAt: new Date(), sessionId: input.sessionId,
        actorUserId: input.actorUserId, requestSource: input.requestSource,
      });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // task ERP-P1: email.reply_and_send draft-first（审批前生成 ProcessDraft）
  if (p0bToolDef?.processSpec && definition.id === 'email.reply_and_send') {
    const ti = input.toolInput || {};
    const to = Array.isArray(ti.to) ? ti.to : [];
    const subject = String(ti.subject || '');
    const bodyText = String(ti.bodyText || '');
    if (to.length === 0 || !subject || !bodyText) {
      const errMsg = 'EMAIL_REPLY_SEND_PRECONDITIONS_FAILED: to (non-empty array), subject, bodyText are required';
      await recordAgentToolRun(input.prisma, {
        actor: input.actor, definition, status: 'failed',
        toolInput: input.toolInput, error: errMsg,
        startedAt: new Date(), sessionId: input.sessionId,
        actorUserId: input.actorUserId, requestSource: input.requestSource,
      });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['to/subject/bodyText required'] };
    }
    const draft = buildEmailReplySendDraft({
      replyToEmailId: ti.replyToEmailId ? String(ti.replyToEmailId) : undefined,
      to, cc: Array.isArray(ti.cc) ? ti.cc : undefined,
      subject, bodyText, bodyHtml: ti.bodyHtml ? String(ti.bodyHtml) : undefined,
      relationId: ti.relationId ? String(ti.relationId) : undefined,
      orderId: ti.orderId ? String(ti.orderId) : undefined,
    });
    const semCheck = validateEmailReplySendDraftSemantics(draft);
    if (!semCheck.ok || !verifyEmailReplySendDraftHash(draft).ok) {
      const errMsg = `EMAIL_REPLY_SEND_DRAFT_INVALID: ${semCheck.error?.message || 'hash mismatch'}`;
      await recordAgentToolRun(input.prisma, {
        actor: input.actor, definition, status: 'failed',
        toolInput: input.toolInput, error: errMsg,
        startedAt: new Date(), sessionId: input.sessionId,
        actorUserId: input.actorUserId, requestSource: input.requestSource,
      });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // task Agent-P1: relation.update draft-first
  if (p0bToolDef?.processSpec && definition.id === 'relation.update') {
    const ti = input.toolInput || {};
    const relationId = String(ti.relationId || '');
    const rawPatch = (ti.patch && typeof ti.patch === 'object') ? ti.patch as Record<string, unknown> : null;
    if (!relationId || !rawPatch || Object.keys(rawPatch).length === 0) {
      const errMsg = 'RELATION_UPDATE_PRECONDITIONS_FAILED: relationId and non-empty patch required';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['relationId+patch required'] };
    }
    const allowed = new Set(RELATION_UPDATE_FIELDS as readonly string[]);
    const illegalFields = Object.keys(rawPatch).filter((k) => !allowed.has(k));
    if (illegalFields.length > 0) {
      const errMsg = `RELATION_UPDATE_PRECONDITIONS_FAILED: patch contains non-writable fields: ${illegalFields.join(', ')}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [`INVALID_INPUT: non-writable fields [${illegalFields.join(',')}]`] };
    }
    if (rawPatch.category != null && (typeof rawPatch.category !== 'string' || !(VALID_RELATION_CATEGORIES as Set<string>).has(rawPatch.category))) {
      const errMsg = 'RELATION_UPDATE_PRECONDITIONS_FAILED: invalid category';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['INVALID_CATEGORY'] };
    }
    const select = Object.fromEntries([...Object.keys(rawPatch), 'id', 'deletedAt'].map((field) => [field, true])) as any;
    const existing = await (input.prisma as any).relation.findUnique({ where: { id: relationId }, select }).catch(() => null);
    if (!existing || existing.deletedAt) {
      const errMsg = `RELATION_UPDATE_PRECONDITIONS_FAILED: relation ${relationId} not found or deleted`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['NOT_FOUND'] };
    }
    const currentSnapshot: Record<string, unknown> = {};
    for (const field of Object.keys(rawPatch)) currentSnapshot[field] = (existing as any)[field] ?? null;
    const draft = buildRelationUpdateDraft({ relationId, patch: rawPatch, currentSnapshot });
    const semCheck = validateRelationUpdateDraftSemantics(draft);
    if (!semCheck.ok) {
      const errMsg = `RELATION_UPDATE_DRAFT_INVALID: ${semCheck.error?.message}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // task Agent-P1: relation.delete draft-first
  if (p0bToolDef?.processSpec && definition.id === 'relation.delete') {
    const ti = input.toolInput || {};
    const relationId = String(ti.relationId || '');
    if (!relationId) {
      const errMsg = 'RELATION_DELETE_PRECONDITIONS_FAILED: relationId required';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['relationId required'] };
    }
    const existing = await (input.prisma as any).relation.findUnique({ where: { id: relationId }, select: { id: true, name: true, category: true, type: true, deletedAt: true } }).catch(() => null);
    if (!existing || existing.deletedAt) {
      const errMsg = `RELATION_DELETE_PRECONDITIONS_FAILED: relation ${relationId} not found or deleted`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['NOT_FOUND'] };
    }
    const draft = buildRelationDeleteDraft({ relationId, currentSnapshot: { name: existing.name, category: existing.category, type: existing.type } });
    const semCheck = validateRelationDeleteDraftSemantics(draft);
    if (!semCheck.ok) {
      const errMsg = `RELATION_DELETE_DRAFT_INVALID: ${semCheck.error?.message}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // task Agent-P1: relation.onboard draft-first（审批前生成 ProcessDraft）
  if (p0bToolDef?.processSpec && definition.id === 'relation.onboard') {
    const ti = input.toolInput || {};
    const org = (ti.organization || {}) as { id?: string; name?: string; category?: string; [key: string]: any };
    if (!org.id || !org.name) {
      const errMsg = 'RELATION_ONBOARD_PRECONDITIONS_FAILED: organization.id and organization.name are required';
      await recordAgentToolRun(input.prisma, {
        actor: input.actor, definition, status: 'failed',
        toolInput: input.toolInput, error: errMsg,
        startedAt: new Date(), sessionId: input.sessionId,
        actorUserId: input.actorUserId, requestSource: input.requestSource,
      });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['organization.id/name required'] };
    }
    const draft = buildRelationOnboardDraft({ organization: org as any, contact: ti.contact as any });
    const semCheck = validateRelationOnboardDraftSemantics(draft);
    if (!semCheck.ok || !verifyRelationOnboardDraftHash(draft).ok) {
      const errMsg = `RELATION_ONBOARD_DRAFT_INVALID: ${semCheck.error?.message || 'hash mismatch'}`;
      await recordAgentToolRun(input.prisma, {
        actor: input.actor, definition, status: 'failed',
        toolInput: input.toolInput, error: errMsg,
        startedAt: new Date(), sessionId: input.sessionId,
        actorUserId: input.actorUserId, requestSource: input.requestSource,
      });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // task Agent-P1: invoice.create draft-first
  if (p0bToolDef?.processSpec && definition.id === 'invoice.create') {
    const ti = input.toolInput || {};
    const body = ti.input && typeof ti.input === 'object' ? ti.input as Record<string, unknown> : null;
    const allowed = new Set(INVOICE_CREATE_FIELDS as readonly string[]);
    const decimalFields = new Set(['amount','exchangeRate']);
    const isDecimal = (v: unknown) => v !== undefined && v !== null && ((typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())));
    if (!body) { const errMsg = 'INVOICE_CREATE_PRECONDITIONS_FAILED: input object required'; await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource }); return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['input required'] }; }
    const illegalFields = Object.keys(body).filter(k => !allowed.has(k));
    if (illegalFields.length) { const errMsg = `INVOICE_CREATE_PRECONDITIONS_FAILED: input contains non-writable fields: ${illegalFields.join(', ')}`; await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource }); return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['INVALID_INPUT'] }; }
    for (const f of ['invoiceNumber','type','amount','currency','issueDate']) if ((body as any)[f] === undefined || (body as any)[f] === null || (body as any)[f] === '') { const errMsg = `INVOICE_CREATE_PRECONDITIONS_FAILED: ${f} required`; await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource }); return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [`${f} required`] }; }
    const invalidDecimal = Object.keys(body).find(k => decimalFields.has(k) && !isDecimal(body[k]));
    if (invalidDecimal) { const errMsg = `INVOICE_CREATE_PRECONDITIONS_FAILED: invalid decimal field ${invalidDecimal}`; await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource }); return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['INVALID_AMOUNT'] }; }
    if (body.status != null) {
      if (typeof body.status !== 'string') { const errMsg = 'INVOICE_CREATE_PRECONDITIONS_FAILED: invalid status'; await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource }); return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['INVALID_STATUS'] }; }
      const transition = validateStatusTransition('Invoice', 'Draft', body.status);
      if (!transition.ok) { const errMsg = `INVOICE_CREATE_PRECONDITIONS_FAILED: ${transition.message}`; await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource }); return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [transition.error || 'INVALID_STATUS'] }; }
    }
    const draft = buildInvoiceCreateDraft({ input: body });
    const semCheck = validateInvoiceCreateDraftSemantics(draft);
    if (!semCheck.ok) { const errMsg = `INVOICE_CREATE_DRAFT_INVALID: ${semCheck.error?.message}`; await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource }); return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] }; }
    (processDraftForApproval as any) = draft;
  }

  // task Agent-P1: invoice.update draft-first
  if (p0bToolDef?.processSpec && definition.id === 'invoice.update') {
    const ti = input.toolInput || {};
    const invoiceId = String(ti.invoiceId || '');
    const rawPatch = ti.patch && typeof ti.patch === 'object' ? ti.patch as Record<string, unknown> : null;
    const allowed = new Set(INVOICE_PATCH_FIELDS as readonly string[]);
    const decimalFields = new Set(['amount','exchangeRate']);
    const isDecimal = (v: unknown) => v !== undefined && v !== null && ((typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())));
    if (!invoiceId || !rawPatch || Object.keys(rawPatch).length === 0) { const errMsg = 'INVOICE_UPDATE_PRECONDITIONS_FAILED: invoiceId and non-empty patch required'; await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource }); return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['invoiceId+patch required'] }; }
    const illegalFields = Object.keys(rawPatch).filter(k => !allowed.has(k));
    if (illegalFields.length) { const errMsg = `INVOICE_UPDATE_PRECONDITIONS_FAILED: patch contains non-writable fields: ${illegalFields.join(', ')}`; await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource }); return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['INVALID_INPUT'] }; }
    const invalidDecimal = Object.keys(rawPatch).find(k => decimalFields.has(k) && !isDecimal(rawPatch[k]));
    if (invalidDecimal) { const errMsg = `INVOICE_UPDATE_PRECONDITIONS_FAILED: invalid decimal field ${invalidDecimal}`; await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource }); return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['INVALID_AMOUNT'] }; }
    const select = Object.fromEntries([...Object.keys(rawPatch), 'id', 'deletedAt'].map(f => [f, true])) as any;
    const existing = await (input.prisma as any).invoice.findUnique({ where: { id: invoiceId }, select }).catch(() => null);
    if (!existing || existing.deletedAt) { const errMsg = `INVOICE_UPDATE_PRECONDITIONS_FAILED: invoice ${invoiceId} not found or deleted`; await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource }); return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['NOT_FOUND'] }; }
    if (Object.prototype.hasOwnProperty.call(rawPatch, 'status')) {
      if (typeof rawPatch.status !== 'string') { const errMsg = 'INVOICE_UPDATE_PRECONDITIONS_FAILED: invalid status'; await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource }); return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['INVALID_STATUS'] }; }
      const transition = validateStatusTransition('Invoice', String((existing as any).status), rawPatch.status);
      if (!transition.ok) { const errMsg = `INVOICE_UPDATE_PRECONDITIONS_FAILED: ${transition.message}`; await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource }); return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [transition.error || 'INVALID_STATUS'] }; }
    }
    const currentSnapshot: Record<string, unknown> = {}; for (const f of Object.keys(rawPatch)) currentSnapshot[f] = (existing as any)[f] ?? null;
    const draft = buildInvoiceUpdateDraft({ invoiceId, patch: rawPatch, currentSnapshot });
    const semCheck = validateInvoiceUpdateDraftSemantics(draft);
    if (!semCheck.ok) { const errMsg = `INVOICE_UPDATE_DRAFT_INVALID: ${semCheck.error?.message}`; await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource }); return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] }; }
    (processDraftForApproval as any) = draft;
  }

  // task Agent-P1: invoice.issue draft-first（审批前生成 ProcessDraft）
  if (p0bToolDef?.processSpec && definition.id === 'invoice.issue') {
    const ti = input.toolInput || {};
    const invoiceNumber = String(ti.invoiceNumber || '');
    const amount = Number(ti.amount || 0);
    if (!invoiceNumber || amount <= 0) {
      const errMsg = 'INVOICE_ISSUE_PRECONDITIONS_FAILED: invoiceNumber and positive amount are required';
      await recordAgentToolRun(input.prisma, {
        actor: input.actor, definition, status: 'failed',
        toolInput: input.toolInput, error: errMsg,
        startedAt: new Date(), sessionId: input.sessionId,
        actorUserId: input.actorUserId, requestSource: input.requestSource,
      });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['invoiceNumber/amount required'] };
    }
    const draft = buildInvoiceIssueDraft({
      invoiceNumber, amount,
      type: ti.type ? String(ti.type) : undefined,
      currency: ti.currency ? String(ti.currency) : undefined,
      issueDate: ti.issueDate ? String(ti.issueDate) : undefined,
      dueDate: ti.dueDate ? String(ti.dueDate) : undefined,
      customerRelationId: ti.customerRelationId ? String(ti.customerRelationId) : undefined,
      customerName: ti.customerName ? String(ti.customerName) : undefined,
      orderId: ti.orderId ? String(ti.orderId) : undefined,
      notes: ti.notes ? String(ti.notes) : undefined,
      invoiceId: ti.invoiceId ? String(ti.invoiceId) : undefined,
      email: (ti.email as any) ? {
        to: Array.isArray((ti.email as any).to) ? (ti.email as any).to.map((x: any) => String(x)) : [],
        subject: String((ti.email as any).subject || ''),
        bodyText: String((ti.email as any).bodyText || ''),
      } : undefined,
    });
    const semCheck = validateInvoiceIssueDraftSemantics(draft);
    if (!semCheck.ok || !verifyInvoiceIssueDraftHash(draft).ok) {
      const errMsg = `INVOICE_ISSUE_DRAFT_INVALID: ${semCheck.error?.message || 'hash mismatch'}`;
      await recordAgentToolRun(input.prisma, {
        actor: input.actor, definition, status: 'failed',
        toolInput: input.toolInput, error: errMsg,
        startedAt: new Date(), sessionId: input.sessionId,
        actorUserId: input.actorUserId, requestSource: input.requestSource,
      });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // task Agent-P1: email.send draft-first（引用 Outbox emailId）
  if (p0bToolDef?.processSpec && definition.id === 'email.send' && !input.skipApprovalCheck) {
    const ti = input.toolInput || {};
    const emailId = String(ti.emailId || '');
    const tiCreds = (ti.credentials || {}) as { user?: string; pass?: string; host?: string; port?: number };
    const credentialsUser = String(tiCreds.user || ti.email || '');
    const secret = emailSendSecrets.get(ti);
    if (secret?.suppliedRef) {
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed',
        toolInput: input.toolInput, error: 'EMAIL_SEND_CREDENTIAL_REF_UNTRUSTED', startedAt: new Date(),
        sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: '首次发送不能使用客户端提供的凭据引用，请重新提供本账号凭据',
        toolId: definition.id, errors: ['EMAIL_SEND_CREDENTIAL_REF_UNTRUSTED'] };
    }
    if (!emailId || !credentialsUser) {
      const errMsg = 'EMAIL_SEND_PRECONDITIONS_FAILED: emailId and credentials.user are required';
      await recordAgentToolRun(input.prisma, {
        actor: input.actor, definition, status: 'failed',
        toolInput: input.toolInput, error: errMsg,
        startedAt: new Date(), sessionId: input.sessionId,
        actorUserId: input.actorUserId, requestSource: input.requestSource,
      });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['emailId/credentials.user required'] };
    }
    const sendContext = await readDurableOutboxContext({ prisma: input.prisma, emailId,
      actorId: input.actor.userId, actor: toolActorToken(input.actor) });
    if (!sendContext.ok) {
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed',
        toolInput: input.toolInput, error: sendContext.error.message, startedAt: new Date(),
        sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: sendContext.error.message,
        toolId: definition.id, errors: [sendContext.error.code] };
    }
    const draft = buildEmailSendOutboxDraft({
      emailId,
      sendContext: sendContext.data,
      credentials: {
        user: credentialsUser,
        pass: String(tiCreds.pass || ti.password || ''),
        host: tiCreds.host ? String(tiCreds.host) : undefined,
        port: tiCreds.port ? Number(tiCreds.port) : undefined,
      },
    });
    const semCheck = validateEmailSendOutboxDraftSemantics(draft);
    if (!semCheck.ok || !verifyEmailSendOutboxDraftHash(draft).ok) {
      const errMsg = `EMAIL_SEND_DRAFT_INVALID: ${semCheck.error?.message || 'hash mismatch'}`;
      await recordAgentToolRun(input.prisma, {
        actor: input.actor, definition, status: 'failed',
        toolInput: input.toolInput, error: errMsg,
        startedAt: new Date(), sessionId: input.sessionId,
        actorUserId: input.actorUserId, requestSource: input.requestSource,
      });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    if (secret?.password) (input.toolInput.credentials as any).credentialRef = putEmailSendCredential(secret.password, {
      actorId: input.actor.userId, emailId, smtpUser: credentialsUser, contentHash: sendContext.data.contentHash,
    });
    (processDraftForApproval as any) = draft;
  }

  // task Agent-P1: email.sync draft-first（credentialRef 模式，镜像 email.send）
  if (p0bToolDef?.processSpec && definition.id === 'email.sync') {
    const ti = input.toolInput || {};
    const tiCreds = (ti.credentials || {}) as { user?: string; pass?: string; host?: string; port?: number };
    const credentialsUser = String(tiCreds.user || ti.email || '');
    if (!credentialsUser) {
      const errMsg = 'EMAIL_SYNC_PRECONDITIONS_FAILED: credentials.user is required';
      await recordAgentToolRun(input.prisma, {
        actor: input.actor, definition, status: 'failed',
        toolInput: input.toolInput, error: errMsg,
        startedAt: new Date(), sessionId: input.sessionId,
        actorUserId: input.actorUserId, requestSource: input.requestSource,
      });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['credentials.user required'] };
    }
    const draft = buildEmailSyncDraft({
      credentialsUser,
      host: tiCreds.host ? String(tiCreds.host) : undefined,
      port: tiCreds.port ? Number(tiCreds.port) : undefined,
      box: ti.box ? String(ti.box) : undefined,
      limit: ti.limit ? Number(ti.limit) : undefined,
    });
    const semCheck = validateEmailSyncDraftSemantics(draft);
    if (!semCheck.ok || !verifyEmailSyncDraftHash(draft).ok) {
      const errMsg = `EMAIL_SYNC_DRAFT_INVALID: ${semCheck.error?.message || 'hash mismatch'}`;
      await recordAgentToolRun(input.prisma, {
        actor: input.actor, definition, status: 'failed',
        toolInput: input.toolInput, error: errMsg,
        startedAt: new Date(), sessionId: input.sessionId,
        actorUserId: input.actorUserId, requestSource: input.requestSource,
      });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    // IMAP pass 不持久化到 payload（credentialRef one-shot 模式，镜像 email.send）
    const imapPass = String(tiCreds.pass || ti.password || '');
    if (imapPass) {
      (input as any).__emailCredentialRef = putEmailCredential(imapPass);
      if (!input.toolInput.credentials) (input.toolInput as any).credentials = {};
      (input.toolInput.credentials as any).pass = '';
      (input.toolInput.credentials as any).credentialRef = (input as any).__emailCredentialRef;
    }
    (processDraftForApproval as any) = draft;
  }

  // task Agent-P1: knowledge.ingest draft-first（无凭据，但走 draft→approval→commit 保证审计闭环）
  if (p0bToolDef?.processSpec && definition.id === 'knowledge.ingest') {
    const ti = input.toolInput || {};
    const title = String(ti.title || '');
    const text = String(ti.text || ti.content || '');
    if (!title || !text || text.trim().length === 0) {
      const errMsg = 'KNOWLEDGE_INGEST_PRECONDITIONS_FAILED: title and text are required';
      await recordAgentToolRun(input.prisma, {
        actor: input.actor, definition, status: 'failed',
        toolInput: input.toolInput, error: errMsg,
        startedAt: new Date(), sessionId: input.sessionId,
        actorUserId: input.actorUserId, requestSource: input.requestSource,
      });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['title/text required'] };
    }
    if (text.length > 500000) {
      const errMsg = 'KNOWLEDGE_INGEST_PRECONDITIONS_FAILED: text exceeds 500000 character limit';
      await recordAgentToolRun(input.prisma, {
        actor: input.actor, definition, status: 'failed',
        toolInput: input.toolInput, error: errMsg,
        startedAt: new Date(), sessionId: input.sessionId,
        actorUserId: input.actorUserId, requestSource: input.requestSource,
      });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['text too large'] };
    }
    const draft = buildKnowledgeIngestDraft({
      title,
      text,
      sourceType: ti.sourceType ? String(ti.sourceType) : undefined,
      sourceUri: ti.sourceUri ? String(ti.sourceUri) : undefined,
      tags: Array.isArray(ti.tags) ? ti.tags : undefined,
      metadata: ti.metadata as Record<string, unknown> || undefined,
      scopes: Array.isArray(ti.scopes) ? ti.scopes : undefined,
    });
    const semCheck = validateKnowledgeIngestDraftSemantics(draft);
    if (!semCheck.ok || !verifyKnowledgeIngestDraftHash(draft).ok) {
      const errMsg = `KNOWLEDGE_INGEST_DRAFT_INVALID: ${semCheck.error?.message || 'hash mismatch'}`;
      await recordAgentToolRun(input.prisma, {
        actor: input.actor, definition, status: 'failed',
        toolInput: input.toolInput, error: errMsg,
        startedAt: new Date(), sessionId: input.sessionId,
        actorUserId: input.actorUserId, requestSource: input.requestSource,
      });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // task Agent-P1: development.convert_to_order draft-first
  if (p0bToolDef?.processSpec && definition.id === 'development.convert_to_order') {
    const ti = input.toolInput || {};
    const caseId = String(ti.caseId || '');
    const mode = String(ti.mode || '') === 'link' ? 'link' : 'autoCreate';
    if (!caseId) {
      const errMsg = 'DEV_CONVERT_PRECONDITIONS_FAILED: caseId is required';
      await recordAgentToolRun(input.prisma, {
        actor: input.actor, definition, status: 'failed',
        toolInput: input.toolInput, error: errMsg,
        startedAt: new Date(), sessionId: input.sessionId,
        actorUserId: input.actorUserId, requestSource: input.requestSource,
      });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['caseId required'] };
    }
    const draft = buildDevConvertDraft({
      caseId, mode,
      orderId: ti.orderId ? String(ti.orderId) : undefined,
      orderPo: ti.orderPo ? String(ti.orderPo) : undefined,
      customer: ti.customer ? String(ti.customer) : undefined,
      millName: ti.millName ? String(ti.millName) : undefined,
      dueDate: ti.dueDate ? String(ti.dueDate) : undefined,
      productName: ti.productName ? String(ti.productName) : undefined,
      quantity: typeof ti.quantity === 'number' ? ti.quantity : undefined,
      quoteAmount: typeof ti.quoteAmount === 'number' ? ti.quoteAmount : undefined,
    });
    const semCheck = validateDevConvertDraftSemantics(draft);
    if (!semCheck.ok || !verifyDevConvertDraftHash(draft).ok) {
      const errMsg = `DEV_CONVERT_DRAFT_INVALID: ${semCheck.error?.message || 'hash mismatch'}`;
      await recordAgentToolRun(input.prisma, {
        actor: input.actor, definition, status: 'failed',
        toolInput: input.toolInput, error: errMsg,
        startedAt: new Date(), sessionId: input.sessionId,
        actorUserId: input.actorUserId, requestSource: input.requestSource,
      });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // task E3: development.create draft-first（给 XX 客户下样品单）
  if (p0bToolDef?.processSpec && definition.id === 'development.create') {
    const ti = input.toolInput || {};
    const code = String(ti.code || '');
    const name = String(ti.name || '');
    const type = String(ti.type || '');
    if (!code || !name || !type) {
      const errMsg = 'DEV_CREATE_PRECONDITIONS_FAILED: code/name/type are required';
      await recordAgentToolRun(input.prisma, {
        actor: input.actor, definition, status: 'failed',
        toolInput: input.toolInput, error: errMsg,
        startedAt: new Date(), sessionId: input.sessionId,
        actorUserId: input.actorUserId, requestSource: input.requestSource,
      });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['code/name/type required'] };
    }
    const draft = buildDevCreateDraft({
      code, name, type,
      stage: ti.stage ? String(ti.stage) : undefined,
      priority: ti.priority ? String(ti.priority) : undefined,
      owner: ti.owner ? String(ti.owner) : undefined,
      customerRelationId: ti.customerRelationId ? String(ti.customerRelationId) : undefined,
      customerName: ti.customerName ? String(ti.customerName) : undefined,
      supplierRelationId: ti.supplierRelationId ? String(ti.supplierRelationId) : undefined,
      supplierName: ti.supplierName ? String(ti.supplierName) : undefined,
      productAssetId: ti.productAssetId ? String(ti.productAssetId) : undefined,
      productName: ti.productName ? String(ti.productName) : undefined,
      nextAction: ti.nextAction ? String(ti.nextAction) : undefined,
      targetDate: ti.targetDate ? String(ti.targetDate) : undefined,
      sampleType: ti.sampleType ? String(ti.sampleType) : undefined,
      sampleQuantity: typeof ti.sampleQuantity === 'number' ? ti.sampleQuantity : undefined,
      sampleUnit: ti.sampleUnit ? String(ti.sampleUnit) : undefined,
      notes: ti.notes ? String(ti.notes) : undefined,
      tags: Array.isArray(ti.tags) ? ti.tags.map(String) : undefined,
    });
    const semCheck = validateDevCreateDraftSemantics(draft);
    if (!semCheck.ok || !verifyDevCreateDraftHash(draft).ok) {
      const errMsg = `DEV_CREATE_DRAFT_INVALID: ${semCheck.error?.message || 'hash mismatch'}`;
      await recordAgentToolRun(input.prisma, {
        actor: input.actor, definition, status: 'failed',
        toolInput: input.toolInput, error: errMsg,
        startedAt: new Date(), sessionId: input.sessionId,
        actorUserId: input.actorUserId, requestSource: input.requestSource,
      });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // task E3: statement.send draft-first（生成对账单并投递客户；draft 内含完整快照，commit 零重算）
  if (p0bToolDef?.processSpec && definition.id === 'statement.send') {
    const ti = input.toolInput || {};
    const customerRelationId = String(ti.customerRelationId || '');
    const emailInput = (ti.email || {}) as { to?: unknown; subject?: unknown };
    const emailTo = Array.isArray(emailInput.to) ? emailInput.to.map(String).filter(Boolean) : [];
    const emailSubject = emailInput.subject ? String(emailInput.subject) : '';
    if (!customerRelationId || emailTo.length === 0 || !emailSubject) {
      const errMsg = 'STATEMENT_SEND_PRECONDITIONS_FAILED: customerRelationId and email.to/email.subject are required';
      await recordAgentToolRun(input.prisma, {
        actor: input.actor, definition, status: 'failed',
        toolInput: input.toolInput, error: errMsg,
        startedAt: new Date(), sessionId: input.sessionId,
        actorUserId: input.actorUserId, requestSource: input.requestSource,
      });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['customerRelationId/email required'] };
    }
    // draft 阶段生成完整对账单快照（审批即所得：commit 仅从快照渲染，零 DB 重算）
    const snapshot = await getCustomerStatement(input.prisma, {
      actor: toolActorToken(input.actor), customerRelationId,
      from: ti.from ? String(ti.from) : undefined,
      to: ti.to ? String(ti.to) : undefined,
    });
    if (!statementHasActivity(snapshot)) {
      const errMsg = 'STATEMENT_SEND_PRECONDITIONS_FAILED: customer has no receivable activity in the given period';
      await recordAgentToolRun(input.prisma, {
        actor: input.actor, definition, status: 'failed',
        toolInput: input.toolInput, error: errMsg,
        startedAt: new Date(), sessionId: input.sessionId,
        actorUserId: input.actorUserId, requestSource: input.requestSource,
      });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['STATEMENT_EMPTY'] };
    }
    const draft = buildStatementSendDraft({
      customerRelationId,
      customerName: ti.customerName ? String(ti.customerName) : snapshot.customerName,
      from: ti.from ? String(ti.from) : undefined,
      to: ti.to ? String(ti.to) : undefined,
      email: { to: emailTo, subject: emailSubject },
      statementSnapshot: snapshot,
    });
    const semCheck = validateStatementSendDraftSemantics(draft);
    if (!semCheck.ok || !verifyStatementSendDraftHash(draft).ok) {
      const errMsg = `STATEMENT_SEND_DRAFT_INVALID: ${semCheck.error?.message || 'hash mismatch'}`;
      await recordAgentToolRun(input.prisma, {
        actor: input.actor, definition, status: 'failed',
        toolInput: input.toolInput, error: errMsg,
        startedAt: new Date(), sessionId: input.sessionId,
        actorUserId: input.actorUserId, requestSource: input.requestSource,
      });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // task Agent-P1: invoice.cancel draft-first
  if (p0bToolDef?.processSpec && definition.id === 'invoice.cancel') {
    const ti = input.toolInput || {};
    const invoiceId = String(ti.invoiceId || '');
    if (!invoiceId) {
      const errMsg = 'INVOICE_CANCEL_PRECONDITIONS_FAILED: invoiceId is required';
      await recordAgentToolRun(input.prisma, {
        actor: input.actor, definition, status: 'failed',
        toolInput: input.toolInput, error: errMsg,
        startedAt: new Date(), sessionId: input.sessionId,
        actorUserId: input.actorUserId, requestSource: input.requestSource,
      });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['invoiceId required'] };
    }
    // 读真实 invoice status（避免 beforeAfterDiff hardcode，确保 what-you-approve-is-what-you-commit）
    const existingInvoice = await input.prisma.invoice.findUnique({ where: { id: invoiceId }, select: { id: true, status: true, deletedAt: true } }).catch(() => null);
    if (!existingInvoice || existingInvoice.deletedAt) {
      const errMsg = `INVOICE_CANCEL_PRECONDITIONS_FAILED: invoice ${invoiceId} not found or deleted`;
      await recordAgentToolRun(input.prisma, {
        actor: input.actor, definition, status: 'failed',
        toolInput: input.toolInput, error: errMsg,
        startedAt: new Date(), sessionId: input.sessionId,
        actorUserId: input.actorUserId, requestSource: input.requestSource,
      });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['invoice not found'] };
    }
    const draft = buildInvoiceCancelDraft({
      invoiceId,
      reason: ti.reason ? String(ti.reason) : undefined,
      currentStatus: existingInvoice.status,
    });
    const semCheck = validateInvoiceCancelDraftSemantics(draft);
    if (!semCheck.ok || !verifyInvoiceCancelDraftHash(draft).ok) {
      const errMsg = `INVOICE_CANCEL_DRAFT_INVALID: ${semCheck.error?.message || 'hash mismatch'}`;
      await recordAgentToolRun(input.prisma, {
        actor: input.actor, definition, status: 'failed',
        toolInput: input.toolInput, error: errMsg,
        startedAt: new Date(), sessionId: input.sessionId,
        actorUserId: input.actorUserId, requestSource: input.requestSource,
      });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // task Agent-P1: invoice.delete draft-first
  if (p0bToolDef?.processSpec && definition.id === 'invoice.delete') {
    const ti = input.toolInput || {};
    const invoiceId = String(ti.invoiceId || '');
    if (!invoiceId) {
      const errMsg = 'INVOICE_DELETE_PRECONDITIONS_FAILED: invoiceId is required';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['invoiceId required'] };
    }
    // 读真实 invoice（不存在/已 deletedAt → preconditions_failed，不创建 approval）
    const existingInvoice = await input.prisma.invoice.findUnique({ where: { id: invoiceId }, select: { id: true, deletedAt: true } }).catch(() => null);
    if (!existingInvoice || existingInvoice.deletedAt) {
      const errMsg = `INVOICE_DELETE_PRECONDITIONS_FAILED: invoice ${invoiceId} not found or already deleted`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['INVOICE_NOT_FOUND'] };
    }
    const draft = buildInvoiceDeleteDraft({ invoiceId });
    const semCheck = validateInvoiceDeleteDraftSemantics(draft);
    if (!semCheck.ok) {
      const errMsg = `INVOICE_DELETE_DRAFT_INVALID: ${semCheck.error?.message}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // task Agent-P1: payment_voucher.delete draft-first
  if (p0bToolDef?.processSpec && definition.id === 'payment_voucher.delete') {
    const ti = input.toolInput || {};
    const voucherId = String(ti.voucherId || '');
    if (!voucherId) {
      const errMsg = 'VOUCHER_DELETE_PRECONDITIONS_FAILED: voucherId is required';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['voucherId required'] };
    }
    // 读真实 paymentVoucher（不存在/已 deletedAt → preconditions_failed，不创建 approval）
    const existingVoucher = await input.prisma.paymentVoucher.findUnique({ where: { id: voucherId }, select: { id: true, deletedAt: true } }).catch(() => null);
    if (!existingVoucher || existingVoucher.deletedAt) {
      const errMsg = `VOUCHER_DELETE_PRECONDITIONS_FAILED: voucher ${voucherId} not found or already deleted`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['VOUCHER_NOT_FOUND'] };
    }
    const draft = buildPaymentVoucherDeleteDraft({ voucherId });
    const semCheck = validatePaymentVoucherDeleteDraftSemantics(draft);
    if (!semCheck.ok) {
      const errMsg = `VOUCHER_DELETE_DRAFT_INVALID: ${semCheck.error?.message}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }



  // task Agent-P1: payment_voucher.create draft-first
  if (p0bToolDef?.processSpec && definition.id === 'payment_voucher.create') {
    const ti = input.toolInput || {};
    const body = ti.input && typeof ti.input === 'object' ? ti.input as Record<string, unknown> : null;
    const allowed = new Set(PAYMENT_VOUCHER_CREATE_FIELDS as readonly string[]);
    const decimalFields = new Set(['amount', 'bankFee', 'exchangeRate', 'appliedAmount']);
    const isValidDecimal = (v: unknown) => {
      if (v === undefined) return true;
      if (v === null) return false;
      if (typeof v === 'number') return Number.isFinite(v);
      if (typeof v === 'string') {
        if (!/^-?\d+(\.\d+)?$/.test(v.trim())) return false;
        try { return new Prisma.Decimal(v).isFinite(); } catch { return false; }
      }
      return false;
    };
    if (!body) {
      const errMsg = 'PAYMENT_VOUCHER_CREATE_PRECONDITIONS_FAILED: input object required';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['input required'] };
    }
    const illegalFields = Object.keys(body).filter((k) => !allowed.has(k));
    if (illegalFields.length > 0) {
      const errMsg = `PAYMENT_VOUCHER_CREATE_PRECONDITIONS_FAILED: input contains non-writable fields: ${illegalFields.join(', ')}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [`INVALID_INPUT: non-writable fields [${illegalFields.join(',')}]`] };
    }
    for (const field of ['voucherNumber', 'type', 'amount', 'currency', 'paymentDate', 'paymentMethod']) {
      if ((body as any)[field] === undefined || (body as any)[field] === null || (body as any)[field] === '') {
        const errMsg = `PAYMENT_VOUCHER_CREATE_PRECONDITIONS_FAILED: ${field} required`;
        await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
        return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [`${field} required`] };
      }
    }
    if (body.status != null && (typeof body.status !== 'string' || !(VALID_PAYMENT_VOUCHER_STATUS as readonly string[]).includes(body.status))) {
      const errMsg = 'PAYMENT_VOUCHER_CREATE_PRECONDITIONS_FAILED: invalid status';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['INVALID_STATUS'] };
    }
    const invalidDecimal = Object.keys(body).find((k) => decimalFields.has(k) && !isValidDecimal(body[k]));
    if (invalidDecimal) {
      const errMsg = `PAYMENT_VOUCHER_CREATE_PRECONDITIONS_FAILED: invalid decimal field ${invalidDecimal}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['INVALID_AMOUNT'] };
    }
    const draft = buildPaymentVoucherCreateDraft({ input: body });
    const semCheck = validatePaymentVoucherCreateDraftSemantics(draft);
    if (!semCheck.ok) {
      const errMsg = `PAYMENT_VOUCHER_CREATE_DRAFT_INVALID: ${semCheck.error?.message}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // task Agent-P1: payment_voucher.update draft-first
  if (p0bToolDef?.processSpec && definition.id === 'payment_voucher.update') {
    const ti = input.toolInput || {};
    const voucherId = String(ti.voucherId || '');
    const rawPatch = (ti.patch && typeof ti.patch === 'object') ? ti.patch as Record<string, unknown> : null;
    const allowed = new Set(PAYMENT_VOUCHER_PATCH_FIELDS as readonly string[]);
    const decimalFields = new Set(['amount', 'bankFee', 'exchangeRate', 'appliedAmount']);
    const isValidDecimal = (v: unknown) => {
      if (v === undefined) return true;
      if (v === null) return false;
      if (typeof v === 'number') return Number.isFinite(v);
      if (typeof v === 'string') {
        if (!/^-?\d+(\.\d+)?$/.test(v.trim())) return false;
        try { return new Prisma.Decimal(v).isFinite(); } catch { return false; }
      }
      return false;
    };
    if (!voucherId || !rawPatch || Object.keys(rawPatch).length === 0) {
      const errMsg = 'PAYMENT_VOUCHER_UPDATE_PRECONDITIONS_FAILED: voucherId and non-empty patch required';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['voucherId+patch required'] };
    }
    const illegalFields = Object.keys(rawPatch).filter((k) => !allowed.has(k));
    if (illegalFields.length > 0) {
      const errMsg = `PAYMENT_VOUCHER_UPDATE_PRECONDITIONS_FAILED: patch contains non-writable fields: ${illegalFields.join(', ')}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [`INVALID_INPUT: non-writable fields [${illegalFields.join(',')}]`] };
    }
    if (rawPatch.status != null && (typeof rawPatch.status !== 'string' || !(VALID_PAYMENT_VOUCHER_STATUS as readonly string[]).includes(rawPatch.status))) {
      const errMsg = 'PAYMENT_VOUCHER_UPDATE_PRECONDITIONS_FAILED: invalid status';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['INVALID_STATUS'] };
    }
    const invalidDecimal = Object.keys(rawPatch).find((k) => decimalFields.has(k) && !isValidDecimal(rawPatch[k]));
    if (invalidDecimal) {
      const errMsg = `PAYMENT_VOUCHER_UPDATE_PRECONDITIONS_FAILED: invalid decimal field ${invalidDecimal}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['INVALID_AMOUNT'] };
    }
    const select = Object.fromEntries([...Object.keys(rawPatch), 'id', 'deletedAt'].map((field) => [field, true])) as any;
    const existing = await (input.prisma as any).paymentVoucher.findUnique({ where: { id: voucherId }, select }).catch(() => null);
    if (!existing || existing.deletedAt) {
      const errMsg = `PAYMENT_VOUCHER_UPDATE_PRECONDITIONS_FAILED: voucher ${voucherId} not found or deleted`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['NOT_FOUND'] };
    }
    const currentSnapshot: Record<string, unknown> = {};
    for (const field of Object.keys(rawPatch)) currentSnapshot[field] = (existing as any)[field] ?? null;
    const draft = buildPaymentVoucherUpdateDraft({ voucherId, patch: rawPatch, currentSnapshot });
    const semCheck = validatePaymentVoucherUpdateDraftSemantics(draft);
    if (!semCheck.ok) {
      const errMsg = `PAYMENT_VOUCHER_UPDATE_DRAFT_INVALID: ${semCheck.error?.message}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // task Agent-P1: product_asset.create draft-first
  if (p0bToolDef?.processSpec && definition.id === 'product_asset.create') {
    const ti = input.toolInput || {};
    const body = ti.body && typeof ti.body === 'object' ? ti.body as Record<string, unknown> : null;
    if (!body || !body.sku || !body.name || !body.mainCategory) {
      const errMsg = 'PRODUCT_ASSET_CREATE_PRECONDITIONS_FAILED: body with sku/name/mainCategory required';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['body+sku+name+mainCategory required'] };
    }
    const draft = buildProductAssetCreateDraft({ body });
    (processDraftForApproval as any) = draft;
  }

  // task Agent-P1: product_asset.update draft-first
  if (p0bToolDef?.processSpec && definition.id === 'product_asset.update') {
    const ti = input.toolInput || {};
    const assetId = String(ti.assetId || '');
    const rawPatch = (ti.patch && typeof ti.patch === 'object') ? ti.patch as Record<string, unknown> : null;
    if (!assetId || !rawPatch || Object.keys(rawPatch).length === 0) {
      const errMsg = 'PRODUCT_ASSET_UPDATE_PRECONDITIONS_FAILED: assetId and non-empty patch required';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['assetId+patch required'] };
    }
    // fail closed: 非法字段检测（approval 前拒绝）
    const rawKeys = Object.keys(rawPatch);
    const illegalFields = rawKeys.filter((k) => !PRODUCT_ASSET_WRITABLE_FIELDS.has(k));
    if (illegalFields.length > 0) {
      const errMsg = `PRODUCT_ASSET_UPDATE_PRECONDITIONS_FAILED: patch contains non-writable fields: ${illegalFields.join(', ')}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [`INVALID_INPUT: non-writable fields [${illegalFields.join(',')}]`] };
    }
    // 读真实 ProductAsset（not found/deleted → fail closed）
    const existing = await input.prisma.productAsset.findFirst({ where: { id: assetId, deletedAt: null }, select: { id: true, sku: true, name: true, deletedAt: true } }).catch(() => null);
    if (!existing) {
      const errMsg = `PRODUCT_ASSET_UPDATE_PRECONDITIONS_FAILED: product asset ${assetId} not found or deleted`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['NOT_FOUND'] };
    }
    const draft = buildProductAssetUpdateDraft({ assetId, patch: rawPatch, currentSnapshot: { sku: existing.sku, name: existing.name } });
    (processDraftForApproval as any) = draft;
  }

  // task Agent-P1: product_asset.delete draft-first
  if (p0bToolDef?.processSpec && definition.id === 'product_asset.delete') {
    const ti = input.toolInput || {};
    const assetId = String(ti.assetId || '');
    if (!assetId) {
      const errMsg = 'PRODUCT_ASSET_DELETE_PRECONDITIONS_FAILED: assetId required';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['assetId required'] };
    }
    // 读真实 ProductAsset（not found/deleted → fail closed）
    const existing = await input.prisma.productAsset.findFirst({ where: { id: assetId, deletedAt: null }, select: { id: true, deletedAt: true } }).catch(() => null);
    if (!existing) {
      const errMsg = `PRODUCT_ASSET_DELETE_PRECONDITIONS_FAILED: product asset ${assetId} not found or already deleted`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['NOT_FOUND'] };
    }
    const draft = buildProductAssetDeleteDraft({ assetId });
    (processDraftForApproval as any) = draft;
  }

  // task Agent-P1: order.status_transition draft-first
  if (p0bToolDef?.processSpec && definition.id === 'order.status_transition') {
    const ti = input.toolInput || {};
    const orderId = String(ti.orderId || '');
    const toStatus = String(ti.toStatus || '');
    if (!orderId || !toStatus) {
      const errMsg = 'ORDER_TRANSITION_PRECONDITIONS_FAILED: orderId and toStatus are required';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['orderId+toStatus required'] };
    }
    const existingOrder = await input.prisma.order.findUnique({ where: { id: orderId }, select: { id: true, status: true, deletedAt: true } }).catch(() => null);
    if (!existingOrder || existingOrder.deletedAt) {
      const errMsg = `ORDER_TRANSITION_PRECONDITIONS_FAILED: order ${orderId} not found or deleted`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['order not found'] };
    }
    const draft = buildOrderStatusTransitionDraft({ orderId, toStatus, currentStatus: existingOrder.status, note: ti.note ? String(ti.note) : undefined, lineId: ti.lineId ? String(ti.lineId) : undefined });
    const semCheck = validateOrderStatusTransitionDraftSemantics(draft);
    if (!semCheck.ok) {
      const errMsg = `ORDER_TRANSITION_DRAFT_INVALID: ${semCheck.error?.message}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // task Agent-P1: order.delete draft-first
  if (p0bToolDef?.processSpec && definition.id === 'order.delete') {
    const ti = input.toolInput || {};
    const orderId = String(ti.orderId || '');
    if (!orderId) {
      const errMsg = 'ORDER_DELETE_PRECONDITIONS_FAILED: orderId is required';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['orderId required'] };
    }
    // 读真实 order（not found/deleted → preconditions_failed，避免为必然失败的删除创建审批）
    const existingOrderForDelete = await input.prisma.order.findUnique({ where: { id: orderId }, select: { id: true, deletedAt: true } }).catch(() => null);
    if (!existingOrderForDelete || existingOrderForDelete.deletedAt) {
      const errMsg = `ORDER_DELETE_PRECONDITIONS_FAILED: order ${orderId} not found or already deleted`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['order not found or already deleted'] };
    }
    const draft = buildOrderDeleteDraft({ orderId });
    const semCheck = validateOrderDeleteDraftSemantics(draft);
    if (!semCheck.ok) {
      const errMsg = `ORDER_DELETE_DRAFT_INVALID: ${semCheck.error?.message}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // task Agent-P1: order.line_update draft-first
  if (p0bToolDef?.processSpec && definition.id === 'order.line_update') {
    const ti = input.toolInput || {};
    const lineId = String(ti.lineId || '');
    const rawPatch = (ti.patch && typeof ti.patch === 'object') ? ti.patch as Record<string, unknown> : null;
    if (!lineId || !rawPatch || Object.keys(rawPatch).length === 0) {
      const errMsg = 'ORDER_LINE_UPDATE_PRECONDITIONS_FAILED: lineId and non-empty patch are required';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['lineId+patch required'] };
    }
    // fail closed: 先检测任何非法字段（pure illegal + mixed 都走 non-writable fields，在 normalize/filter 前校验原始 key）
    const rawKeys = Object.keys(rawPatch);
    const illegalFields = rawKeys.filter((k) => !ORDER_LINE_WRITABLE_FIELDS.has(k));
    if (illegalFields.length > 0) {
      const errMsg = `ORDER_LINE_UPDATE_PRECONDITIONS_FAILED: patch contains non-writable fields: ${illegalFields.join(', ')}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [`INVALID_INPUT: non-writable fields [${illegalFields.join(',')}]`] };
    }
    // 此时 rawPatch 全合法，patch = rawPatch
    const patch = rawPatch;
    // 读真实 orderLine（not found → preconditions_failed）— select 动态覆盖 patch 涉及的所有字段
    const patchFields = Object.keys(patch);
    const existingLine = await input.prisma.orderLine.findUnique({ where: { id: lineId }, select: Object.fromEntries([...patchFields, 'id'].map((f) => [f, true])) as any }).catch(() => null);
    if (!existingLine) {
      const errMsg = `ORDER_LINE_UPDATE_PRECONDITIONS_FAILED: order line ${lineId} not found`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['order line not found'] };
    }
    // before snapshot：从真实 orderLine 读取 patch 涉及的字段（避免误写 null）
    const currentSnapshot: Record<string, unknown> = {};
    for (const k of patchFields) { currentSnapshot[k] = (existingLine as any)[k] ?? null; }
    const draft = buildOrderLineUpdateDraft({ lineId, patch, currentSnapshot });
    const semCheck = validateOrderLineUpdateDraftSemantics(draft);
    if (!semCheck.ok || !verifyOrderLineUpdateDraftHash(draft).ok) {
      const errMsg = `ORDER_LINE_UPDATE_DRAFT_INVALID: ${semCheck.error?.message || 'hash mismatch'}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // ── Phase 2 S3a：六新域写工具 draft-first ──

  // order_changes.create draft-first
  if (p0bToolDef?.processSpec && definition.id === 'order_changes.create') {
    const ti = input.toolInput || {};
    const body = ti.input && typeof ti.input === 'object' ? ti.input as Record<string, unknown> : null;
    if (!body) {
      const errMsg = 'ORDER_CHANGES_CREATE_PRECONDITIONS_FAILED: input object required';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['input required'] };
    }
    const draft = buildOrderChangeCreateDraft({ input: body });
    const semCheck = validateOrderChangeCreateDraftSemantics(draft);
    if (!semCheck.ok || !verifyOrderChangeCreateDraftHash(draft).ok) {
      const errMsg = `ORDER_CHANGES_CREATE_DRAFT_INVALID: ${semCheck.error?.message || 'hash mismatch'}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // order_changes.withdraw draft-first
  if (p0bToolDef?.processSpec && definition.id === 'order_changes.withdraw') {
    const ti = input.toolInput || {};
    const changeRequestId = String(ti.changeRequestId || '');
    const actorId = String(ti.actorId || '');
    if (!changeRequestId || !actorId) {
      const errMsg = 'ORDER_CHANGES_WITHDRAW_PRECONDITIONS_FAILED: changeRequestId and actorId required';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['changeRequestId+actorId required'] };
    }
    const draft = buildOrderChangeWithdrawDraft({ changeRequestId, actorId });
    const semCheck = validateOrderChangeWithdrawDraftSemantics(draft);
    if (!semCheck.ok || !verifyOrderChangeWithdrawDraftHash(draft).ok) {
      const errMsg = `ORDER_CHANGES_WITHDRAW_DRAFT_INVALID: ${semCheck.error?.message || 'hash mismatch'}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // payment_requests.create draft-first
  if (p0bToolDef?.processSpec && definition.id === 'payment_requests.create') {
    const ti = input.toolInput || {};
    const body = ti.input && typeof ti.input === 'object' ? ti.input as Record<string, unknown> : null;
    if (!body) {
      const errMsg = 'PAYMENT_REQUESTS_CREATE_PRECONDITIONS_FAILED: input object required';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['input required'] };
    }
    const draft = buildPaymentRequestCreateDraft({ input: body });
    const semCheck = validatePaymentRequestCreateDraftSemantics(draft);
    if (!semCheck.ok || !verifyPaymentRequestCreateDraftHash(draft).ok) {
      const errMsg = `PAYMENT_REQUESTS_CREATE_DRAFT_INVALID: ${semCheck.error?.message || 'hash mismatch'}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // payment_requests.cancel draft-first
  if (p0bToolDef?.processSpec && definition.id === 'payment_requests.cancel') {
    const ti = input.toolInput || {};
    const paymentRequestId = String(ti.paymentRequestId || '');
    const actorId = String(ti.actorId || '');
    if (!paymentRequestId || !actorId) {
      const errMsg = 'PAYMENT_REQUESTS_CANCEL_PRECONDITIONS_FAILED: paymentRequestId and actorId required';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['paymentRequestId+actorId required'] };
    }
    const draft = buildPaymentRequestCancelDraft({ paymentRequestId, actorId });
    const semCheck = validatePaymentRequestCancelDraftSemantics(draft);
    if (!semCheck.ok || !verifyPaymentRequestCancelDraftHash(draft).ok) {
      const errMsg = `PAYMENT_REQUESTS_CANCEL_DRAFT_INVALID: ${semCheck.error?.message || 'hash mismatch'}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // credit.freeze draft-first
  if (p0bToolDef?.processSpec && definition.id === 'credit.freeze') {
    const ti = input.toolInput || {};
    const relationId = String(ti.relationId || '');
    const reason = String(ti.reason || '');
    const actorId = String(ti.actorId || '');
    if (!relationId || !reason || !actorId) {
      const errMsg = 'CREDIT_FREEZE_PRECONDITIONS_FAILED: relationId, reason, actorId required';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['relationId+reason+actorId required'] };
    }
    const draft = buildCreditFreezeDraft({ relationId, reason, actorId });
    const semCheck = validateCreditFreezeDraftSemantics(draft);
    if (!semCheck.ok || !verifyCreditFreezeDraftHash(draft).ok) {
      const errMsg = `CREDIT_FREEZE_DRAFT_INVALID: ${semCheck.error?.message || 'hash mismatch'}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // credit.thaw draft-first
  if (p0bToolDef?.processSpec && definition.id === 'credit.thaw') {
    const ti = input.toolInput || {};
    const relationId = String(ti.relationId || '');
    const reason = String(ti.reason || '');
    const actorId = String(ti.actorId || '');
    if (!relationId || !reason || !actorId) {
      const errMsg = 'CREDIT_THAW_PRECONDITIONS_FAILED: relationId, reason, actorId required';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['relationId+reason+actorId required'] };
    }
    const draft = buildCreditThawDraft({ relationId, reason, actorId });
    const semCheck = validateCreditThawDraftSemantics(draft);
    if (!semCheck.ok || !verifyCreditThawDraftHash(draft).ok) {
      const errMsg = `CREDIT_THAW_DRAFT_INVALID: ${semCheck.error?.message || 'hash mismatch'}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // samples.create_round draft-first
  if (p0bToolDef?.processSpec && definition.id === 'samples.create_round') {
    const ti = input.toolInput || {};
    const caseId = String(ti.caseId || '');
    const body = ti.input && typeof ti.input === 'object' ? ti.input as Record<string, unknown> : null;
    const actorId = String(ti.actorId || '');
    if (!caseId || !body || !actorId) {
      const errMsg = 'SAMPLES_CREATE_ROUND_PRECONDITIONS_FAILED: caseId, input, actorId required';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['caseId+input+actorId required'] };
    }
    const draft = buildSampleRoundCreateDraft({ caseId, input: body, actorId });
    const semCheck = validateSampleRoundCreateDraftSemantics(draft);
    if (!semCheck.ok || !verifySampleRoundCreateDraftHash(draft).ok) {
      const errMsg = `SAMPLES_CREATE_ROUND_DRAFT_INVALID: ${semCheck.error?.message || 'hash mismatch'}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // samples.submit_to_customer draft-first
  if (p0bToolDef?.processSpec && definition.id === 'samples.submit_to_customer') {
    const ti = input.toolInput || {};
    const roundId = String(ti.roundId || '');
    const body = ti.input && typeof ti.input === 'object' ? ti.input as Record<string, unknown> : null;
    const actorId = String(ti.actorId || '');
    if (!roundId || !body || !actorId) {
      const errMsg = 'SAMPLES_SUBMIT_PRECONDITIONS_FAILED: roundId, input, actorId required';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['roundId+input+actorId required'] };
    }
    const draft = buildSampleSubmitToCustomerDraft({ roundId, input: body, actorId });
    const semCheck = validateSampleSubmitToCustomerDraftSemantics(draft);
    if (!semCheck.ok || !verifySampleSubmitToCustomerDraftHash(draft).ok) {
      const errMsg = `SAMPLES_SUBMIT_DRAFT_INVALID: ${semCheck.error?.message || 'hash mismatch'}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // samples.register_customer_confirmation draft-first
  if (p0bToolDef?.processSpec && definition.id === 'samples.register_customer_confirmation') {
    const ti = input.toolInput || {};
    const roundId = String(ti.roundId || '');
    const body = ti.input && typeof ti.input === 'object' ? ti.input as Record<string, unknown> : null;
    const actorId = String(ti.actorId || '');
    if (!roundId || !body || !actorId) {
      const errMsg = 'SAMPLES_CONFIRM_PRECONDITIONS_FAILED: roundId, input, actorId required';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['roundId+input+actorId required'] };
    }
    const draft = buildSampleCustomerConfirmationDraft({ roundId, input: body, actorId });
    const semCheck = validateSampleCustomerConfirmationDraftSemantics(draft);
    if (!semCheck.ok || !verifySampleCustomerConfirmationDraftHash(draft).ok) {
      const errMsg = `SAMPLES_CONFIRM_DRAFT_INVALID: ${semCheck.error?.message || 'hash mismatch'}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // qc.review_garment_sample draft-first
  if (p0bToolDef?.processSpec && definition.id === 'qc.review_garment_sample') {
    const ti = input.toolInput || {};
    const orderId = String(ti.orderId || '');
    const body = ti.input && typeof ti.input === 'object' ? ti.input as Record<string, unknown> : null;
    const actorId = String(ti.actorId || '');
    if (!orderId || !body || !actorId) {
      const errMsg = 'QC_REVIEW_GARMENT_PRECONDITIONS_FAILED: orderId, input, actorId required';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['orderId+input+actorId required'] };
    }
    const draft = buildQcGarmentReviewDraft({ orderId, input: body, actorId });
    const semCheck = validateQcGarmentReviewDraftSemantics(draft);
    if (!semCheck.ok || !verifyQcGarmentReviewDraftHash(draft).ok) {
      const errMsg = `QC_REVIEW_GARMENT_DRAFT_INVALID: ${semCheck.error?.message || 'hash mismatch'}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // qc.review_fabric_sample draft-first
  if (p0bToolDef?.processSpec && definition.id === 'qc.review_fabric_sample') {
    const ti = input.toolInput || {};
    const orderId = String(ti.orderId || '');
    const body = ti.input && typeof ti.input === 'object' ? ti.input as Record<string, unknown> : null;
    const actorId = String(ti.actorId || '');
    if (!orderId || !body || !actorId) {
      const errMsg = 'QC_REVIEW_FABRIC_PRECONDITIONS_FAILED: orderId, input, actorId required';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['orderId+input+actorId required'] };
    }
    const draft = buildQcFabricReviewDraft({ orderId, input: body, actorId });
    const semCheck = validateQcFabricReviewDraftSemantics(draft);
    if (!semCheck.ok || !verifyQcFabricReviewDraftHash(draft).ok) {
      const errMsg = `QC_REVIEW_FABRIC_DRAFT_INVALID: ${semCheck.error?.message || 'hash mismatch'}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // qc.sign_report draft-first
  if (p0bToolDef?.processSpec && definition.id === 'qc.sign_report') {
    const ti = input.toolInput || {};
    const reportId = String(ti.reportId || '');
    const role = String(ti.role || '');
    const actorId = String(ti.actorId || '');
    if (!reportId || !role || !actorId) {
      const errMsg = 'QC_SIGN_REPORT_PRECONDITIONS_FAILED: reportId, role, actorId required';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['reportId+role+actorId required'] };
    }
    const draft = buildQcSignReportDraft({ reportId, role, actorId,
      delegationReason: typeof ti.delegationReason === 'string' ? ti.delegationReason : undefined });
    const semCheck = validateQcSignReportDraftSemantics(draft);
    if (!semCheck.ok || !verifyQcSignReportDraftHash(draft).ok) {
      const errMsg = `QC_SIGN_REPORT_DRAFT_INVALID: ${semCheck.error?.message || 'hash mismatch'}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // internal_trade.create draft-first
  if (p0bToolDef?.processSpec && definition.id === 'internal_trade.create') {
    const ti = input.toolInput || {};
    const body = ti.input && typeof ti.input === 'object' ? ti.input as Record<string, unknown> : null;
    if (!body) {
      const errMsg = 'INTERNAL_TRADE_CREATE_PRECONDITIONS_FAILED: input object required';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['input required'] };
    }
    const draft = buildInternalTradeCreateDraft({ input: body });
    const semCheck = validateInternalTradeCreateDraftSemantics(draft);
    if (!semCheck.ok || !verifyInternalTradeCreateDraftHash(draft).ok) {
      const errMsg = `INTERNAL_TRADE_CREATE_DRAFT_INVALID: ${semCheck.error?.message || 'hash mismatch'}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // internal_trade.confirm draft-first
  if (p0bToolDef?.processSpec && definition.id === 'internal_trade.confirm') {
    const ti = input.toolInput || {};
    const transferId = String(ti.transferId || '');
    const actorId = String(ti.actorId || '');
    if (!transferId || !actorId) {
      const errMsg = 'INTERNAL_TRADE_CONFIRM_PRECONDITIONS_FAILED: transferId and actorId required';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['transferId+actorId required'] };
    }
    const draft = buildInternalTradeConfirmDraft({ transferId, actorId, confirmedQuantity: ti.confirmedQuantity !== undefined ? Number(ti.confirmedQuantity) : undefined, confirmedDueDate: ti.confirmedDueDate ? String(ti.confirmedDueDate) : undefined });
    const semCheck = validateInternalTradeConfirmDraftSemantics(draft);
    if (!semCheck.ok || !verifyInternalTradeConfirmDraftHash(draft).ok) {
      const errMsg = `INTERNAL_TRADE_CONFIRM_DRAFT_INVALID: ${semCheck.error?.message || 'hash mismatch'}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // ── Phase 2 S3b：四存量域写工具 draft-first ──

  // procurement.create draft-first
  if (p0bToolDef?.processSpec && definition.id === 'procurement.create') {
    const ti = input.toolInput || {};
    const body = ti.input && typeof ti.input === 'object' ? ti.input as Record<string, unknown> : null;
    if (!body) {
      const errMsg = 'PROCUREMENT_CREATE_PRECONDITIONS_FAILED: input object required';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['input required'] };
    }
    const draft = buildProcurementCreateDraft({ input: body });
    const semCheck = validateProcurementCreateDraftSemantics(draft);
    if (!semCheck.ok || !verifyProcurementCreateDraftHash(draft).ok) {
      const errMsg = `PROCUREMENT_CREATE_DRAFT_INVALID: ${semCheck.error?.message || 'hash mismatch'}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // procurement.update_status draft-first
  if (p0bToolDef?.processSpec && definition.id === 'procurement.update_status') {
    const ti = input.toolInput || {};
    const purchaseOrderId = String(ti.purchaseOrderId || '');
    const toStatus = String(ti.toStatus || '');
    if (!purchaseOrderId || !toStatus) {
      const errMsg = 'PROCUREMENT_UPDATE_STATUS_PRECONDITIONS_FAILED: purchaseOrderId and toStatus required';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['purchaseOrderId+toStatus required'] };
    }
    const draft = buildProcurementUpdateStatusDraft({ purchaseOrderId, toStatus, reason: ti.reason ? String(ti.reason) : undefined });
    const semCheck = validateProcurementUpdateStatusDraftSemantics(draft);
    if (!semCheck.ok || !verifyProcurementUpdateStatusDraftHash(draft).ok) {
      const errMsg = `PROCUREMENT_UPDATE_STATUS_DRAFT_INVALID: ${semCheck.error?.message || 'hash mismatch'}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // inventory.adjust_stock draft-first
  if (p0bToolDef?.processSpec && definition.id === 'inventory.adjust_stock') {
    const ti = input.toolInput || {};
    const movement = ti.movement && typeof ti.movement === 'object' ? ti.movement as Record<string, unknown> : null;
    if (!movement) {
      const errMsg = 'INVENTORY_ADJUST_STOCK_PRECONDITIONS_FAILED: movement object required';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['movement required'] };
    }
    const draft = buildInventoryAdjustStockDraft({ movement });
    const semCheck = validateInventoryAdjustStockDraftSemantics(draft);
    if (!semCheck.ok || !verifyInventoryAdjustStockDraftHash(draft).ok) {
      const errMsg = `INVENTORY_ADJUST_STOCK_DRAFT_INVALID: ${semCheck.error?.message || 'hash mismatch'}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // quotation.create draft-first
  if (p0bToolDef?.processSpec && definition.id === 'quotation.create') {
    const ti = input.toolInput || {};
    const body = ti.input && typeof ti.input === 'object' ? ti.input as Record<string, unknown> : null;
    if (!body) {
      const errMsg = 'QUOTATION_CREATE_PRECONDITIONS_FAILED: input object required';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['input required'] };
    }
    const draft = buildQuotationCreateDraft({ input: body });
    const semCheck = validateQuotationCreateDraftSemantics(draft);
    if (!semCheck.ok || !verifyQuotationCreateDraftHash(draft).ok) {
      const errMsg = `QUOTATION_CREATE_DRAFT_INVALID: ${semCheck.error?.message || 'hash mismatch'}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // quotation.update draft-first
  if (p0bToolDef?.processSpec && definition.id === 'quotation.update') {
    const ti = input.toolInput || {};
    const quotationId = String(ti.quotationId || '');
    const rawPatch = (ti.patch && typeof ti.patch === 'object') ? ti.patch as Record<string, unknown> : null;
    if (!quotationId || !rawPatch || Object.keys(rawPatch).length === 0) {
      const errMsg = 'QUOTATION_UPDATE_PRECONDITIONS_FAILED: quotationId and non-empty patch required';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['quotationId+patch required'] };
    }
    const draft = buildQuotationUpdateDraft({ quotationId, patch: rawPatch });
    const semCheck = validateQuotationUpdateDraftSemantics(draft);
    if (!semCheck.ok || !verifyQuotationUpdateDraftHash(draft).ok) {
      const errMsg = `QUOTATION_UPDATE_DRAFT_INVALID: ${semCheck.error?.message || 'hash mismatch'}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // customs.register_lc draft-first
  if (p0bToolDef?.processSpec && definition.id === 'customs.register_lc') {
    const ti = input.toolInput || {};
    const body = ti.input && typeof ti.input === 'object' ? ti.input as Record<string, unknown> : null;
    if (!body) {
      const errMsg = 'CUSTOMS_REGISTER_LC_PRECONDITIONS_FAILED: input object required';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['input required'] };
    }
    const draft = buildCustomsRegisterLcDraft({ input: body });
    const semCheck = validateCustomsRegisterLcDraftSemantics(draft);
    if (!semCheck.ok || !verifyCustomsRegisterLcDraftHash(draft).ok) {
      const errMsg = `CUSTOMS_REGISTER_LC_DRAFT_INVALID: ${semCheck.error?.message || 'hash mismatch'}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // customs.update_declaration draft-first
  if (p0bToolDef?.processSpec && definition.id === 'customs.update_declaration') {
    const ti = input.toolInput || {};
    const declarationId = String(ti.declarationId || '');
    const rawPatch = (ti.patch && typeof ti.patch === 'object') ? ti.patch as Record<string, unknown> : null;
    if (!declarationId || !rawPatch || Object.keys(rawPatch).length === 0) {
      const errMsg = 'CUSTOMS_UPDATE_DECLARATION_PRECONDITIONS_FAILED: declarationId and non-empty patch required';
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: ['declarationId+patch required'] };
    }
    const draft = buildCustomsUpdateDeclarationDraft({ declarationId, patch: rawPatch });
    const semCheck = validateCustomsUpdateDeclarationDraftSemantics(draft);
    if (!semCheck.ok || !verifyCustomsUpdateDeclarationDraftHash(draft).ok) {
      const errMsg = `CUSTOMS_UPDATE_DECLARATION_DRAFT_INVALID: ${semCheck.error?.message || 'hash mismatch'}`;
      await recordAgentToolRun(input.prisma, { actor: input.actor, definition, status: 'failed', toolInput: input.toolInput, error: errMsg, startedAt: new Date(), sessionId: input.sessionId, actorUserId: input.actorUserId, requestSource: input.requestSource });
      return { status: 'preconditions_failed', message: errMsg, toolId: definition.id, errors: [semCheck.error?.code || 'DRAFT_INVALID'] };
    }
    (processDraftForApproval as any) = draft;
  }

  // 新架构支持在挂起后自动重跑：如果在挂起等待后重跑，skipApprovalCheck 为 true
  if (!input.skipApprovalCheck && (decision.requiresApproval || toolRequiresApprovalForAgentLoop)) {
    // agentLoop 路径：不 throw，而是创建审批请求并返回结构化结果，
    // 让 agentLoop 能正确 emit blocked + approval block。
    const approvalId = await createPendingApprovalRequest(input.prisma, {
      actor: input.actor,
      definition,
      input: input.toolInput,
      reason: 'agent-loop',
      sessionId: input.sessionId,
      decisionReason: decision.reason,
      processDraft: processDraftForApproval,
    });
    await recordAgentToolRun(input.prisma, {
      actor: input.actor,
      definition,
      status: 'approval_required',
      toolInput: input.toolInput,
      error: decision.reason || 'APPROVAL_REQUIRED',
      startedAt: new Date(),
      sessionId: input.sessionId,
      actorUserId: input.actorUserId,
      requestSource: input.requestSource,
      approvalId: approvalId || undefined,
    });
    if (definition.id === 'email.send' && !approvalId) return { status: 'preconditions_failed',
      message: '发送审批未能登记，请核对真实账号与审批人，未发送邮件', toolId: definition.id,
      errors: ['APPROVAL_NOT_REGISTERED'] };
    const finalApprovalId = approvalId || `ar_temp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return {
      status: 'approval_required',
      message: `${input.toolId} 需要审批后才能执行（risk=${definition.risk}）。`,
      toolId: definition.id,
      risk: definition.risk,
      approvalId: finalApprovalId,
      approvalRequired: true,
      editableFields: safetyForAgentLoop.editableFields,
      // P0-B: ProcessDraft 在审批前已生成（draftPhase 在 approvalPhase 之前）
      processDraft: processDraftForApproval,
    };
  }

  // ── memory 工具（actor 感知分发）──
  // 两个 runtime 入口共享记忆 dispatch + 当前成员验证；每个入口各记录一次工具审计。
  if (definition.id === 'memory.recall' || definition.id === 'memory.write') {
    const memoryStartedAt = new Date();
    try {
      const memoryOutput = await executeActorMemoryTool(input.prisma, input.actor, definition.id, input.toolInput, input.sessionId);
      await recordAgentToolRun(input.prisma, {
        actor: input.actor,
        definition,
        status: 'success',
        toolInput: input.toolInput,
        output: memoryOutput,
        startedAt: memoryStartedAt,
        sessionId: input.sessionId,
        actorUserId: input.actorUserId,
        requestSource: input.requestSource,
      });
      return memoryOutput;
    } catch (error: any) {
      await recordAgentToolRun(input.prisma, {
        actor: input.actor,
        definition,
        status: 'failed',
        toolInput: input.toolInput,
        error: publicAgentFailure(error),
        startedAt: memoryStartedAt,
        sessionId: input.sessionId,
        actorUserId: input.actorUserId,
        requestSource: input.requestSource,
      });
      throw error;
    }
  }

  const startedAt = new Date();
  try {
    const output = await executeTool(input.prisma, {
      toolId: input.toolId,
      input: input.toolInput,
      reason: 'agent-loop',
      approvalId: input.approvalId,
    } as any, { actorId: input.actorUserId || input.actor.userId, actor: input.actor });
    const outcome = getToolOutcome(output, input.toolId);
    await recordAgentToolRun(input.prisma, {
      actor: input.actor,
      definition,
      status: outcome.status,
      ...(outcome.status === 'failed' ? { error: outcome.error } : {}),
      approvalId: input.approvalId,
      toolInput: input.toolInput,
      output,
      startedAt,
      sessionId: input.sessionId,
      actorUserId: input.actorUserId,
      requestSource: input.requestSource,
    });
    return output;
  } catch (error: any) {
    await recordAgentToolRun(input.prisma, {
      actor: input.actor,
      definition,
      status: 'failed',
      approvalId: input.approvalId,
      toolInput: input.toolInput,
      error: publicAgentFailure(error),
      startedAt,
      sessionId: input.sessionId,
      actorUserId: input.actorUserId,
      requestSource: input.requestSource,
    });
    throw error;
  }
}

export async function runAgentToolCalls(input: {
  prisma: PrismaClient;
  actor: ActorContext;
  calls: PlannedToolCall[];
  sessionId?: string;
  actorUserId?: string;
  requestSource?: 'user-session' | 'api-key' | 'dev';
  taskFrame?: AgentTaskFrame;
  emitStep?: (message: string) => void;
  emit?: AiEmit;
}): Promise<KnowledgeHit[]> {
  const hits: KnowledgeHit[] = [];
  const pending = [...input.calls];
  const seen = new Set<string>();
  const completedCalls: PlannedToolCall[] = [];
  logger.debug(`[runAgentToolCalls] plan has ${pending.length} calls: ${pending.map(c => c.toolId).join(', ')}`);
  for (let step = 0; step < pending.length && step < 8; step += 1) {
    const originalCall = pending[step];
    const call = originalCall.toolId === 'email.send'
      ? { ...originalCall, input: sanitizeEmailSendInput(originalCall.input) } : originalCall;
    const signature = `${call.toolId}:${JSON.stringify(call.input)}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    logger.debug(`[runAgentToolCalls] step ${step}: executing ${call.toolId}`);
    const startMessage = toolStartMessage(call);
    input.emitStep?.(startMessage);
    const callId = `call_${step}_${call.toolId}`;
    const callRisk = TOOL_DEFINITIONS.get(call.toolId)?.risk;
    emitAgentWorkEvent(input.emit, {
      phase: 'tool_call',
      status: 'running',
      title: toolTitle(call.toolId),
      message: startMessage,
      toolId: call.toolId,
      summary: call.reason,
      metadata: { callId, input: call.input, reason: call.reason, risk: callRisk },
    }, { legacyStep: false });
    const result = await runAgentToolCall({
      prisma: input.prisma,
      actor: input.actor,
      call,
      sessionId: input.sessionId,
      actorUserId: input.actorUserId,
      requestSource: input.requestSource,
    });
    logger.debug(`[runAgentToolCalls] step ${step}: ${call.toolId} result approvalPending=${!!result?.approvalPending} hit=${!!result?.hit}`);
    // Phase 7-58: 工具被审批拦截时，emit blocked + approval block 让前端提示用户决策。
    // 不抛错、不进入 loop assessment —— 等用户在 /approvals/:id/resolve 决策后下一轮再跑。
    if (result?.approvalPending) {
      logger.info(`[runAgentToolCalls] step ${step}: ${call.toolId} BLOCKED by approval, approvalId=${result.approvalPending.approvalId} risk=${result.approvalPending.risk}`);
      const approvalMessage = `${toolTitle(call.toolId)}需要审批后才能执行（risk=${result.approvalPending.risk}）。`;
      input.emitStep?.(approvalMessage);
      emitAgentWorkEvent(input.emit, {
        phase: 'tool_call',
        status: 'blocked',
        title: `${toolTitle(call.toolId)}已挂起待审批`,
        message: approvalMessage,
        toolId: call.toolId,
        summary: call.reason,
        metadata: {
          callId,
          input: call.input,
          reason: call.reason,
          risk: result.approvalPending.risk,
          approvalId: result.approvalPending.approvalId,
          editableFields: result.approvalPending.editableFields,
        },
      }, { legacyStep: false });
      // 生成审批上下文 KnowledgeHit，让 LLM 能看到"审批已发起"的事实，
      // 从而在最终回答中说"已为你发起审批"而非"下一步应调用 X"。
      hits.push({
        title: `Agent 工具审批: ${call.toolId}`,
        category: 'ApprovalPending',
        content: formatApprovalContext(call, result),
        source: `agent-approval/${call.toolId}`,
        scopes: ['company'],
      });
      // 不参与 loop 判定（assessAgentLoopStep 期望 output 非空），直接进入下一个 pending call
      continue;
    }
    if (result?.hit) {
      hits.push(result.hit);
      completedCalls.push(call);
      const resultMessage = toolResultMessage(call, result.output);
      input.emitStep?.(resultMessage);
      emitAgentWorkEvent(input.emit, {
        phase: 'tool_result',
        status: 'complete',
        title: `${toolTitle(call.toolId)}完成`,
        message: resultMessage,
        toolId: call.toolId,
        summary: summarizeToolOutput(call, result.output),
        metadata: {
          callId,
          input: call.input,
          output: result.output,
          outputSummary: summarizeToolOutput(call, result.output),
          toolRunId: result.toolRunId,
          risk: result.risk,
        },
      }, { legacyStep: false });
    }
    const loopDecision = assessAgentLoopStep({
      taskFrame: input.taskFrame,
      call,
      output: result?.output,
      completedCalls,
    });
    const followUps = loopDecision.nextCalls;
    if (!followUps.length) {
      emitAgentWorkEvent(input.emit, {
        phase: 'assessment',
        status: loopDecision.status === 'blocked' ? 'blocked' : 'complete',
        title: loopDecision.status === 'blocked' ? '需要补充条件' : '判断本步已完成',
        message: loopDecision.reason,
        toolId: call.toolId,
        summary: `${call.toolId}: ${loopDecision.status}`,
        metadata: {
          loopDecision: loopDecision.status,
          observation: loopDecision.observation,
          evidenceSatisfied: loopDecision.evidenceSatisfied,
          evidenceMissing: loopDecision.evidenceMissing,
        },
      }, { legacyStep: false });
    }
    for (const nextCall of followUps) {
      const nextSignature = `${nextCall.toolId}:${JSON.stringify(nextCall.input)}`;
      if (!seen.has(nextSignature)) {
        const followUpMessage = toolFollowUpMessage(call, nextCall);
        input.emitStep?.(followUpMessage);
        emitAgentWorkEvent(input.emit, {
          phase: 'assessment',
          status: 'running',
          title: '判断需要继续执行',
          message: followUpMessage,
          toolId: nextCall.toolId,
          summary: `${call.toolId} -> ${nextCall.toolId}`,
          metadata: {
            previousToolId: call.toolId,
            nextToolId: nextCall.toolId,
            nextInput: nextCall.input,
            loopDecision: loopDecision.status,
            observation: loopDecision.observation,
            evidenceSatisfied: loopDecision.evidenceSatisfied,
            evidenceMissing: loopDecision.evidenceMissing,
          },
        }, { legacyStep: false });
        pending.push(nextCall);
      }
    }
  }
  return hits;
}

function toolTitle(toolId: string) {
  if (toolId.startsWith('products.')) return '读取数字档案';
  if (toolId.startsWith('orders.')) return '读取订单数据';
  if (toolId === 'relations.create') return '创建关系档案';
  if (toolId.startsWith('relations.')) return '读取关系智库';
  if (toolId.startsWith('knowledge.')) return '检索知识库';
  if (toolId.startsWith('entities.')) return '解析业务实体';
  if (toolId === 'dictionary.query') return '读取业务字典';
  if (toolId === 'records.query') return '查询业务记录';
  return `调用 ${toolId}`;
}

function summarizeToolOutput(call: PlannedToolCall, output: unknown) {
  const result = output && typeof output === 'object' ? output as any : {};
  if (call.toolId.endsWith('.query')) {
    return `total=${result.total ?? result.count ?? 0}; count=${result.count ?? 0}`;
  }
  if (call.toolId.endsWith('.get')) {
    return result.found ? 'found=true' : result.ambiguous ? 'ambiguous=true' : 'found=false';
  }
  if (call.toolId === 'relations.expand') {
    return `profileContacts=${result.profileContacts?.length ?? 0}; people=${result.people?.length ?? 0}`;
  }
  if (call.toolId.endsWith('.expand')) {
    return `include=${Array.isArray(result.include) ? result.include.join('/') : 'profile'}`;
  }
  if (typeof result.count !== 'undefined') return `count=${result.count}`;
  return '工具已返回结构化结果';
}

function toolStartMessage(call: PlannedToolCall) {
  if (call.toolId === 'dictionary.query') return `我先查业务字典 ${String(call.input.dictionary || '')}，确认是否有标准分类。`;
  if (call.toolId === 'records.query') return '我继续查 Bambook 业务记录，用结构化条件做真实统计。';
  if (call.toolId === 'products.query') return '我正在查询数字档案，按字段筛选、排序和分页读取结果。';
  if (call.toolId === 'products.get') return '我正在读取单条完整数字档案，先做唯一标识匹配。';
  if (call.toolId === 'products.expand') return '我正在展开数字档案上下文，读取价格、成分、认证、图片、客户码和关联关系。';
  if (call.toolId === 'products.describe_schema') return '我先读取数字档案字段能力，确认能筛选和排序哪些字段。';
  if (call.toolId === 'products.count') return '我正在调用产品统计工具，读取后端真实数量。';
  if (call.toolId === 'orders.query') return '我正在查询订单库，按订单字段筛选、排序和分页读取结果。';
  if (call.toolId === 'orders.get') return '我正在读取单条订单和订单行详情。';
  if (call.toolId === 'orders.expand') return '我正在展开订单上下文，读取订单行、客户供应商、发票、样品和生产节点。';
  if (call.toolId === 'relations.create') return '我正在创建新的客户/供应商/联系人档案。';
  if (call.toolId === 'relations.query') return '我正在查询关系智库，读取客户、供应商、联系人和结算信息。';
  if (call.toolId === 'relations.get') return '我正在读取单条关系智库档案。';
  if (call.toolId === 'relations.expand') return '我正在展开关系上下文，读取档案、联系人和关联人物。';
  if (call.toolId === 'knowledge.search') return '我正在检索 Bambook 自建知识库，寻找规则和文档依据。';
  if (call.toolId === 'entities.search') return '我正在解析跨模块业务实体候选。';
  if (call.toolId === 'entities.hydrate') return '我正在补全已识别实体的详细信息。';
  return `我正在调用 Bambook 后端工具 ${call.toolId}。`;
}

function toolResultMessage(call: PlannedToolCall, output: unknown) {
  const result = output && typeof output === 'object' ? output as any : {};
  if (call.toolId === 'dictionary.query') {
    return `业务字典返回 ${result.count ?? 0} 条；我会根据命中情况决定是否继续查业务记录。`;
  }
  if (call.toolId === 'records.query' && result.aggregate === 'count') {
    return `业务记录统计完成，匹配数量是 ${result.count ?? 0}。`;
  }
  if (call.toolId === 'products.query') {
    return `数字档案查询完成，总匹配 ${result.total ?? 0} 条，本页展开 ${result.count ?? 0} 条。`;
  }
  if (call.toolId === 'products.get') {
    return result.found ? '完整数字档案已读取到。' : '没有唯一命中完整档案，我只能返回候选或说明未命中。';
  }
  if (call.toolId === 'products.expand') {
    return result.found ? `数字档案上下文展开完成，包含 ${Array.isArray(result.include) ? result.include.join('/') : 'profile'}。` : '没有唯一命中可展开的数字档案。';
  }
  if (call.toolId === 'orders.query') return `订单查询完成，总匹配 ${result.total ?? result.count ?? 0} 条，本页展开 ${result.count ?? 0} 条。`;
  if (call.toolId === 'orders.get') return result.found ? '单条订单和订单行已读取到。' : '没有唯一命中订单。';
  if (call.toolId === 'orders.expand') return result.found ? `订单上下文展开完成，包含 ${Array.isArray(result.include) ? result.include.join('/') : 'summary'}。` : '没有唯一命中可展开的订单。';
  if (call.toolId === 'relations.query') return `关系智库查询完成，总匹配 ${result.total ?? result.count ?? 0} 条，本页展开 ${result.count ?? 0} 条。`;
  if (call.toolId === 'relations.create') return `关系档案创建请求已发起（risk=high），等待审批确认。`;
  if (call.toolId === 'relations.expand') return `关系上下文展开完成，包含 ${Array.isArray(result.include) ? result.include.join('/') : 'profile'}；档案联系人 ${result.profileContacts?.length ?? 0} 个，通讯录人物 ${result.people?.length ?? 0} 个。`;
  if (call.toolId === 'knowledge.search') return `知识库检索完成，命中 ${result.count ?? 0} 条。`;
  if (call.toolId === 'entities.search') return `实体解析完成，候选 ${result.count ?? 0} 个。`;
  return `${call.toolId} 已返回工具结果。`;
}

function toolFollowUpMessage(previous: PlannedToolCall, next: PlannedToolCall) {
  if (previous.toolId === 'dictionary.query' && next.toolId === 'records.query') {
    return '分类字典结果不足以直接回答，我继续用 records.query 查询产品档案统计。';
  }
  if (previous.toolId === 'relations.query' && next.toolId === 'relations.get') {
    return '关系查询已唯一命中档案，我继续读取完整关系档案和联系人明细。';
  }
  if (previous.toolId === 'relations.query' && next.toolId === 'relations.expand') {
    return '关系查询已唯一命中公司，我继续展开关系上下文。';
  }
  if (previous.toolId === 'products.get' && next.toolId === 'products.expand') {
    return '数字档案已唯一命中，我继续展开价格、成分、认证、图片、客户码和关联关系。';
  }
  if (previous.toolId === 'orders.get' && next.toolId === 'orders.expand') {
    return '订单已唯一命中，我继续展开订单行、客户供应商、发票、样品和生产节点。';
  }
  return `根据 ${previous.toolId} 的结果，我继续执行 ${next.toolId}。`;
}

async function runAgentToolCall(input: {
  prisma: PrismaClient;
  actor: ActorContext;
  call: PlannedToolCall;
  sessionId?: string;
  actorUserId?: string;
  requestSource?: 'user-session' | 'api-key' | 'dev';
}): Promise<ToolRunResult | null> {
  const definition = TOOL_DEFINITIONS.get(input.call.toolId);
  if (!definition) return null;

  // MCP email sends share the exact server-read draft and approval contract.
  // Other MCP tools retain their existing runtime and approval behavior.
  if (definition.id === 'email.send') {
    let output: any;
    try { output = await executeAgentTool({ prisma: input.prisma, actor: input.actor,
      toolId: definition.id, toolInput: input.call.input, sessionId: input.sessionId,
      actorUserId: input.actorUserId, requestSource: input.requestSource }); }
    catch { return null; } // Shared runtime already records sanitized failures.
    if (output?.status === 'approval_required') return { hit: undefined as any, output, risk: definition.risk,
      approvalPending: { approvalId: output.approvalId, risk: definition.risk, editableFields: output.editableFields } };
    if (!output?.ok) return { hit: undefined as any, output, risk: definition.risk };
    return { output, risk: definition.risk, hit: { title: `${definition.name} 工具结果`, category: 'AgentTool',
      content: formatToolResult(definition, input.call, output), source: `agent-tool/${definition.id}`, scopes: ['company'] } };
  }

  const policy = createPolicyService();
  const decision = policy.canUseTool(input.actor, {
    toolId: definition.id,
    scope: definition.scope,
    risk: definition.risk,
    input: input.call.input,
  });
  if (!decision.allowed) {
    await recordAgentToolRun(input.prisma, {
      actor: input.actor,
      definition,
      status: 'failed',
      toolInput: input.call.input,
      error: decision.reason || 'TOOL_NOT_ALLOWED',
      startedAt: new Date(),
      sessionId: input.sessionId,
      actorUserId: input.actorUserId,
      requestSource: input.requestSource,
    });
    return null;
  }

  // Phase 7-58: 审批拦截。三个判定都进入审批队列：
  //   1) policy.requiresApproval（Phase 5/6 已有的 actor-role x risk 矩阵判定）
  //   2) manifest.safety.approval === 'always'（写动作强制）
  //   3) manifest.safety.approval === 'risk_based' 且 risk 是 high/critical
  //
  // 命中后：创建 ApprovalRequest 落库 → 关联到 toolRun → 返回 approvalPending，让外层
  //   runAgentToolCalls 跳过本步执行并 emit blocked + approval block。
  // 真正执行发生在用户走 /approvals/:id/resolve 之后的下一轮 agent 调用里。
  const safety = getToolManifestSafety(definition.id);
  // ToolRisk 当前最高 'high'；将来扩 'critical' 时这里会自动覆盖
  const riskLevel = String(definition.risk);
  const manifestRequiresApproval = safety.approval === 'always'
    || (safety.approval === 'risk_based' && (riskLevel === 'high' || riskLevel === 'critical'));
  // P0-B: 已注册工具由 approvalPolicy 决定审批（优先于 manifest fail-closed）；
  // 未注册工具继续走 manifest safety（fail-closed always）。
  const { requiresApproval: toolRequiresApproval } = resolveApprovalDecision({
    toolId: definition.id,
    riskLevel,
    manifestRequiresApproval,
  });
  if (decision.requiresApproval || toolRequiresApproval) {
    const approvalId = await createPendingApprovalRequest(input.prisma, {
      actor: input.actor,
      definition,
      input: input.call.input,
      reason: input.call.reason,
      sessionId: input.sessionId,
      decisionReason: decision.reason,
    });
    await recordAgentToolRun(input.prisma, {
      actor: input.actor,
      definition,
      status: 'approval_required',
      toolInput: input.call.input,
      error: decision.reason || 'APPROVAL_REQUIRED',
      startedAt: new Date(),
      sessionId: input.sessionId,
      actorUserId: input.actorUserId,
      requestSource: input.requestSource,
      approvalId: approvalId || undefined,
    });
    if (!approvalId) {
      // 落库失败时不能返回 null（会导致 "did not return structured output" 误导），
      // 而是返回一个带 approvalPending 信息的 output，让外层正确 emit blocked 事件。
      // 使用临时 ID（而非空字符串）确保 emitApprovalBlock 能正确发射 approval block ——
      // events.ts 的 emitApprovalBlock 会检查 approvalId 非空才发 block，空字符串会跳过。
      const tempApprovalId = `ar_temp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      return {
        hit: undefined as unknown as KnowledgeHit,
        output: {
          status: 'approval_required',
          message: `${definition.id} 需要审批后才能执行。已创建审批请求但无法落库（可能是 API Key 模式下缺少用户账户关联）。请在前端登录后操作，或联系管理员。`,
          toolId: definition.id,
          risk: definition.risk,
        },
        risk: definition.risk,
        approvalPending: {
          approvalId: tempApprovalId,
          risk: definition.risk,
          editableFields: safety.editableFields,
        },
      };
    }
    return {
      // hit 用空骨架 —— 外层 runAgentToolCalls 仅在 result.hit 存在时收集 KnowledgeHit
      // 这里不能塞真 hit，否则会被当成"已成功"。所以 result.hit 不写入。
      hit: undefined as unknown as KnowledgeHit,
      output: undefined,
      risk: definition.risk,
      approvalPending: {
        approvalId,
        risk: definition.risk,
        editableFields: safety.editableFields,
      },
    };
  }

  const startedAt = new Date();
  try {
    const output = await executeTool(input.prisma, input.call, { actorId: input.actorUserId || input.actor.userId, actor: input.actor, sessionId: input.sessionId });
    const toolRunId = await recordAgentToolRun(input.prisma, {
      actor: input.actor,
      definition,
      status: 'success',
      toolInput: input.call.input,
      output,
      startedAt,
      sessionId: input.sessionId,
      actorUserId: input.actorUserId,
      requestSource: input.requestSource,
    });
    return {
      output,
      toolRunId,
      risk: definition.risk,
      hit: {
        title: `Agent 工具结果: ${definition.id}`,
        category: 'ToolResult',
        content: formatToolResult(definition, input.call, output),
        source: `agent-tool/${definition.id}`,
        scopes: ['company', definition.scope],
      },
    };
  } catch (error: any) {
    await recordAgentToolRun(input.prisma, {
      actor: input.actor,
      definition,
      status: 'failed',
      toolInput: input.call.input,
      error: publicAgentFailure(error),
      startedAt,
      sessionId: input.sessionId,
      actorUserId: input.actorUserId,
      requestSource: input.requestSource,
    });
    throw error;
  }
}

/**
 * 创建 pending ApprovalRequest 并落库。
 *
 * 设计：
 *   - 主键自带 ar_ 前缀方便审计区分
 *   - requesterId：从 actor 中尽力解析；找不到则用 'agent-runtime' 兜底（Prisma 可能因
 *     外键失败而抛错，调用方负责 catch 后兜底拒绝）
 *   - actionType / targetType：以 toolId 派生，便于后续审计聚合
 *   - payload：完整记录原始 input + 工具元数据（reason/sessionId），后续 resolve 路由
 *     合并 resolution 字段
 *
 * 失败兜底：catch 任何异常返回 null，调用方按"拒绝执行"处理。
 */
async function createPendingApprovalRequest(prisma: PrismaClient, opts: {
  actor: ActorContext;
  definition: ToolDefinition;
  input: Record<string, unknown>;
  reason: string;
  sessionId?: string;
  decisionReason?: string;
  processDraft?: ProcessDraft;
}): Promise<string | null> {
  try {
    let requesterId = await resolveActorUserAccountId(prisma, opts.actor).catch(() => null);
    let fallbackToOwner = false;
    // Exact email context is authorized for this native account; an unresolved
    // requester must not silently become the default owner's approval.
    if (opts.definition.id === 'email.send' && requesterId !== opts.actor.userId) return null;
    if (!requesterId) {
      // API Key / dev 模式下 actor 可能没有关联的真实用户账户（如 default-user）。
      // fallback 到 owner 账户，确保审批能落库、前端 resolve 能找到——
      // 否则生成 ar_temp_ 临时 ID，resolve 时 404，审批闭环断裂。
      const owner = await prisma.userAccount.findFirst({
        where: { id: 'usr_owner_default', deletedAt: null, status: 'active' },
        select: { id: true },
      }).catch(() => null);
      if (!owner?.id) return null;
      requesterId = owner.id;
      fallbackToOwner = true;
    }
    // DR-007：reviewerId 只能由服务端 resolveReviewerByDepartment 解析（与业务审批同一 kernel），
    // 落库 reviewerId / reviewerResolverRoute / departmentSnapshotId 三个 createOnce 字段。
    // 解析失败（NO_REVIEWER_RESOLVED 等）落入下方 catch → return null，按"审批无法落库"拒绝执行，
    // 绝不允许 reviewerId=null 的审批单落库（BASE-39-B4 fail-closed）。
    const resolution = await createApprovalRoutingService({ prisma }).resolveReviewerByDepartment(requesterId);
    const id = `ar_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await prisma.approvalRequest.create({
      data: {
        id,
        requesterId,
        reviewerId: resolution.reviewerId,
        reviewerResolverRoute: resolution.route,
        departmentSnapshotId: resolution.departmentSnapshotId,
        actionType: `tool:${opts.definition.id}`,
        targetType: opts.definition.scope || 'agent-tool',
        targetId: opts.definition.id,
        status: 'pending',
        risk: opts.definition.risk || 'high',
        payload: {
          toolId: opts.definition.id,
          toolName: opts.definition.name,
          scope: opts.definition.scope,
          input: opts.input,
          reason: opts.reason,
          sessionId: opts.sessionId,
          policyReason: opts.decisionReason,
          requestedAt: new Date().toISOString(),
          fallbackRequester: fallbackToOwner,
          originalActorUserId: opts.actor.userId,
          // P1-A: ProcessDraft 写入 payload，approved 后 commitTransaction 从这里恢复
          processDraft: opts.processDraft,
        } as any,
      },
    });
    return id;
  } catch {
    return null;
  }
}

/**
 * 为审批拦截生成上下文 KnowledgeHit 内容，让 LLM 看到"审批已发起"的事实，
 * 从而在最终回答中正确告知用户"已为你发起审批"而非"下一步应调用 X"。
 */
function formatApprovalContext(call: PlannedToolCall, result: ToolRunResult): string {
  const lines = [
    `⚠️ 审批拦截: ${call.toolId} 是高风险操作，已挂起待审批。`,
    `tool_id = ${call.toolId}`,
    `tool_reason = ${call.reason}`,
    `input = ${JSON.stringify(call.input)}`,
    `risk = ${result.approvalPending?.risk || 'high'}`,
  ];
  if (result.approvalPending?.approvalId) {
    lines.push(`approval_id = ${result.approvalPending.approvalId}`);
    lines.push('审批请求已落库，用户可在前端审批面板中确认或拒绝。');
  } else {
    lines.push('审批请求未能落库（可能是 API Key 模式下缺少用户账户关联）。');
    lines.push('请告知用户：需要在前端登录后操作，或联系管理员。');
  }
  lines.push('');
  lines.push('重要：不要在最终回答中说"下一步应调用"此工具——审批流程已在进行中。');
  lines.push('正确做法：告知用户"已为你发起创建审批，请在审批面板确认后生效"。');
  return lines.join('; ');
}

const trustedToolActor = new AsyncLocalStorage<string>();
export async function executeTool(prisma: PrismaClient, call: PlannedToolCall, context?: import('./toolDispatchRegistry').ToolExecutionContext) {
  const output = await trustedToolActor.run(context?.actorId || SYSTEM_AUDIT_ACTOR, () => executeToolWithContext(prisma, call, context));
  if (['products.get', 'products.expand', 'products.query', 'products.search'].includes(call.toolId)) {
    const actor = context?.actor;
    // A tool input cannot claim scopes or owner identity; use only the trusted
    // runtime context, preserving its explicit snapshot and credential ceiling.
    return maskProductCost(output, actor ? { userId: actor.userId, roles: actor.roles,
      departmentIds: actor.departmentIds,
      permissions: actor.permissionScopes, authorizationLoaded: actor.permissionsAuthoritative === true ? true : undefined,
      permissionCeiling: actor.permissionCeiling } : null);
  }
  return output;
}
async function executeToolWithContext(prisma: PrismaClient, call: PlannedToolCall, context?: import('./toolDispatchRegistry').ToolExecutionContext) {
  if (context?.actor && (call.toolId === 'memory.recall' || call.toolId === 'memory.write')) return executeActorMemoryTool(prisma, context.actor, call.toolId, call.input, context.sessionId);
  // 注册表优先分发（渐进式迁移：命中则返回，未命中走下方 if 链）
  const regResult = await dispatchFromRegistry(prisma, call, context);
  if (regResult.hit) return regResult.result;

  if (call.toolId === 'products.count') return countProductAssets(prisma);
  if (call.toolId === 'products.search') return searchProductAssets(prisma, String(call.input.query || ''), numberInput(call.input.limit, 5));
  if (call.toolId === 'products.query') return queryProductAssets(prisma, call.input);
  if (call.toolId === 'products.describe_schema') return describeProductSchema();
  if (call.toolId === 'dictionary.query') return queryBusinessDictionary(prisma, call.input);
  if (call.toolId === 'records.query') return queryBusinessRecords(prisma, call.input);
  if (call.toolId === 'products.get') return getProductAsset(prisma, call.input);
  if (call.toolId === 'products.expand') return expandProductAssetContext(prisma, call.input);
  if (call.toolId === 'orders.search') return searchOrders(prisma, String(call.input.query || ''), numberInput(call.input.limit, 5));
  if (call.toolId === 'relations.search') return searchRelations(prisma, String(call.input.query || ''), numberInput(call.input.limit, 5));
  if (call.toolId === 'orders.query') return queryOrdersWithDataCenterFallback(prisma, call.input, context);
  if (call.toolId === 'orders.get') return getOrderWithDataCenterFallback(prisma, call.input);
  if (call.toolId === 'orders.expand') return expandOrderContext(prisma, call.input);
  if (call.toolId === 'relations.query') return queryRelationsWithDataCenterFallback(prisma, call.input);
  if (call.toolId === 'relations.get') return getRelationWithDataCenterFallback(prisma, call.input);
  if (call.toolId === 'relations.expand') return expandRelationWithDataCenterFallback(prisma, call.input);
  if (call.toolId === 'knowledge.search') return searchKnowledge(prisma, call.input);
  if (call.toolId === 'entities.search') return searchBusinessEntities(prisma, call.input);
  if (call.toolId === 'entities.hydrate') return hydrateBusinessEntities(prisma, call.input);
  // Development management tools
  if (call.toolId === 'development.query') return queryDevelopmentCases(prisma, call.input);
  if (call.toolId === 'development.get') return getDevelopmentCase(prisma, call.input);
  if (call.toolId === 'development.update_stage') return updateDevelopmentStage(prisma, call.input);
  // development.convert_to_order 走 P0B draft/approval/commit contract（下方 skipApprovalCheck 分支）
  // Production management tools
  if (call.toolId === 'orders.list_by_status') return listOrdersByStatus(prisma, call.input);
  if (call.toolId === 'orders.update_status') return updateOrderStatus(prisma, call.input);
  if (call.toolId === 'orders.get_timeline') return getOrderTimeline(prisma, call.input);
  if (call.toolId === 'orders.batch_status') return batchUpdateOrderStatus(prisma, call.input);
  if (call.toolId === 'orders.kanban') return getOrdersKanban(prisma, call.input);
  if (call.toolId === 'garment.update_size_breakdown') return updateGarmentSizeBreakdown(prisma, call.input);
  if (call.toolId === 'garment.update_production_steps') return updateGarmentProductionSteps(prisma, call.input);
  // Cross-module relationship graph
  if (call.toolId === 'links.query') return queryEntityLinks(prisma, call.input, context);
  if (call.toolId === 'links.expand_neighbors') return expandEntityNeighbors(prisma, call.input, context);
  // ─── 财务管理 (finance) — B1 阶段：空 stub，返回 200 + 空数据，不抛错 ───
  if (call.toolId === 'finance.list_invoices') return handleFinanceListInvoices(prisma, call.input, context);
  if (call.toolId === 'finance.get_invoice') return handleFinanceGetInvoice(prisma, call.input, context);
  if (call.toolId === 'finance.list_vouchers') return handleFinanceListVouchers(prisma, call.input, context);
  if (call.toolId === 'finance.get_voucher') return handleFinanceGetVoucher(prisma, call.input, context);
  if (call.toolId === 'finance.query_outstanding') return handleFinanceQueryOutstanding(prisma, call.input, context);
  if (call.toolId === 'finance.create_invoice') return handleFinanceCreateInvoice(prisma, call.input, context);
  if (call.toolId === 'finance.create_voucher') return handleFinanceCreateVoucher(prisma, call.input, context);
  if (call.toolId === 'finance.apply_voucher_to_invoice') return handleFinanceApplyVoucherToInvoice(prisma, call.input, context);
  // ─── 货运管理 (shipping) ───
  if (call.toolId === 'shipping.list_shipments') return handleShippingListShipments(prisma, call.input);
  if (call.toolId === 'shipping.get_shipment') return handleShippingGetShipment(prisma, call.input);
  if (call.toolId === 'shipping.create_shipment') return handleShippingCreateShipment(prisma, call.input, context);
  if (call.toolId === 'shipping.update_tracking_status') return handleShippingUpdateTrackingStatus(prisma, call.input, context);
  // ─── 关系智库写入 (relations.create) ───
  if (call.toolId === 'relations.create') return handleRelationCreate(prisma, call.input);
  // ─── 邮件管理 (email) ───
  if (call.toolId === 'email.list') return handleEmailListEmails(prisma, call.input);
  if (call.toolId === 'email.get') return handleEmailGetEmail(prisma, call.input);
  if (call.toolId === 'email.search') return handleEmailSearchEmails(prisma, call.input);
  if (call.toolId === 'email.link_to_order') return handleEmailLinkEmailToOrder(prisma, call.input);
  if (call.toolId === 'email.ai_extract') return handleEmailAiExtract(prisma, call.input);
  // ─── 编译模板 (templates) ───
  if (call.toolId === 'template.list') return handleTemplateList();
  if (call.toolId === 'template.render') return handleTemplateRender(prisma, call.input);
  if (call.toolId === 'template.render_pdf') return handleTemplateRenderPdf(prisma, call.input);
  // ─── P0-B 四切片 draftPhase stub（验收"四切片可运行"边界）───
  // task Agent-P1: knowledge.ingest skipApprovalCheck=true 走 commit 闭环
  if (call.toolId === 'knowledge.ingest') {
    const targetApprovalId = String((call as any).approvalId || '');
    if (!targetApprovalId) {
      return { ok: false, errorFeedback: { code: 'APPROVAL_ID_MISSING', message: 'approvalId not provided for knowledge.ingest commit', retryable: false } };
    }
    const approval = await (prisma as any).approvalRequest.findUnique({ where: { id: targetApprovalId } }).catch(() => null);
    if (!approval) {
      return { ok: false, errorFeedback: { code: 'APPROVAL_NOT_FOUND', message: `approval ${targetApprovalId} not found`, retryable: false } };
    }
    if (approval.status === 'pending') {
      return { ok: false, errorFeedback: { code: 'APPROVAL_PENDING', message: 'approval not yet approved', retryable: false } };
    }
    if (approval.status !== 'approved') {
      return { ok: false, errorFeedback: { code: 'APPROVAL_MODIFIED_UNSUPPORTED', message: `approval status is ${approval.status}, expected approved`, retryable: false } };
    }
    const payload = approval.payload as Record<string, unknown> | null;
    const result = await commitKnowledgeIngest({
      prisma,
      approvalId: targetApprovalId,
      approvalPayload: payload,
    });
    if (!result.ok) return { ok: false, errorFeedback: { code: (result as any).feedback.error.code, message: (result as any).feedback.error.message, retryable: false } };
    return { ok: true, ...(result as any).feedback };
  }
  // task Agent-P1: email.sync skipApprovalCheck=true 走 commit 闭环
  if (call.toolId === 'email.sync') {
    const targetApprovalId = String((call as any).approvalId || '');
    if (!targetApprovalId) {
      return { ok: false, errorFeedback: { code: 'APPROVAL_ID_MISSING', message: 'approvalId not provided for email.sync commit', retryable: false } };
    }
    const approval = await (prisma as any).approvalRequest.findUnique({ where: { id: targetApprovalId } }).catch(() => null);
    if (!approval) {
      return { ok: false, errorFeedback: { code: 'APPROVAL_NOT_FOUND', message: `approval ${targetApprovalId} not found`, retryable: false } };
    }
    if (approval.status === 'pending') {
      return { ok: false, errorFeedback: { code: 'APPROVAL_PENDING', message: 'approval not yet approved', retryable: false } };
    }
    if (approval.status !== 'approved') {
      return { ok: false, errorFeedback: { code: 'APPROVAL_MODIFIED_UNSUPPORTED', message: `approval status is ${approval.status}, expected approved`, retryable: false } };
    }
    const payload = approval.payload as Record<string, unknown> | null;
    const payloadInput = (payload as any)?.input || {};
    const payloadCreds = payloadInput.credentials || {};
    const credentialRef = payloadCreds.credentialRef;
    const recoveredPass = credentialRef ? takeEmailCredential(credentialRef) : '';
    const result = await commitEmailSync({
      prisma,
      approvalId: targetApprovalId,
      approvalPayload: payload,
      credentialsPassword: recoveredPass || '',
    });
    if (!result.ok) return { ok: false, errorFeedback: { code: (result as any).feedback.error.code, message: (result as any).feedback.error.message, retryable: false } };
    return { ok: true, ...(result as any).feedback };
  }
  // order.confirm P1-A: skipApprovalCheck=true 走 commitTransaction 事务提交闭环
  // 从 ApprovalRequest.payload 恢复已审批的 ProcessDraft（what-you-approve-is-what-you-commit）
  if (call.toolId === 'order.confirm') {
    // P1-A: 用 agentLoop 传入的 approvalId 精确查（what-you-approve-is-what-you-commit）
    const poNumber = String(call.input.poNumber || '');
    const targetApprovalId = String((call as any).approvalId || '');
    if (!targetApprovalId) {
      return {
        ok: false,
        committed: false,
        error: 'COMMIT_FAILED: approvalId not provided for order.confirm commit (contract violation: resumed execution must carry approvalId)',
        errorFeedback: { ...(buildOrderConfirmError as any)('approvalId not provided'), retryable: false },
        poNumber,
      };
    }
    const approval = await (prisma as any).approvalRequest.findUnique({
      where: { id: targetApprovalId },
    }).catch(() => null);
    // P1-A: order.confirm ProcessDraft flow 只支持 approved（不支持 modified）
    // modified 路径违反 what-you-approve-is-what-you-commit——用户改了参数但 draft 是旧的。
    // 遇到 modified fail closed，提示需要重新生成 ProcessDraft/重新审批。
    if (!approval || approval.status !== 'approved') {
      const approvalErr = approval?.status === 'modified'
        ? `COMMIT_FAILED: order.confirm does not support modified approval (status=modified). User modified params but draft is stale — regenerate ProcessDraft and re-approve.`
        : `COMMIT_FAILED: approval ${targetApprovalId} not found or not approved (status=${approval?.status || 'null'})`;
      return {
        ok: false,
        committed: false,
        error: approvalErr,
        errorFeedback: { ...(buildOrderConfirmError as any)(approvalErr), retryable: false },
        poNumber,
      };
    }

    const payload = approval.payload as Record<string, unknown> | null;
    const draft = recoverProcessDraftFromPayload(payload);
    if (!draft) {
      // fail-closed: 无已审批 draft，不能 commit
      return {
        ok: false,
        committed: false,
        error: 'COMMIT_FAILED: no approved process draft found for order.confirm (approvalId missing or draft not in payload)',
        errorFeedback: { ...(buildOrderConfirmError as any)('no approved process draft'), retryable: false },
        poNumber,
      };
    }

    const result = await commitOrderConfirm({
      prisma,
      approvalId: targetApprovalId,
      approvalPayload: payload,
    });
    // 阻断1修复：commit 失败必须抛错（让 agentLoop catch 捕获，不当成功）
    if (!result.ok) {
      throw new Error(result.error || 'COMMIT_TRANSACTION_FAILED');
    }
    return result;
  }

  // task Agent-P1: payment.receive_and_reconcile skipApprovalCheck=true 走 commit 闭环
  if (call.toolId === 'payment.receive_and_reconcile') {
    const targetApprovalId = String((call as any).approvalId || '');
    if (!targetApprovalId) {
      return {
        ok: false,
        status: 'failed',
        errorFeedback: { ...(buildPaymentReconcileError as any)('APPROVAL_ID_MISSING', 'approvalId not provided for payment.receive_and_reconcile commit'), retryable: false },
      };
    }
    const approval = await (prisma as any).approvalRequest.findUnique({
      where: { id: targetApprovalId },
    }).catch(() => null);
    if (!approval || approval.status !== 'approved') {
      const msg = approval?.status === 'modified'
        ? `COMMIT_FAILED: payment.receive_and_reconcile does not support modified approval (status=modified). Regenerate draft and re-approve.`
        : `COMMIT_FAILED: approval ${targetApprovalId} not found or not approved (status=${approval?.status || 'null'})`;
      return {
        ok: false,
        status: 'failed',
        errorFeedback: { ...(buildPaymentReconcileError as any)(approval?.status === 'modified' ? 'APPROVAL_MODIFIED_UNSUPPORTED' : 'APPROVAL_NOT_FOUND', msg), retryable: false },
      };
    }
    const payload = approval.payload as Record<string, unknown> | null;
    const result = await commitPaymentReceiveAndReconcile({
      prisma,
      approvalId: targetApprovalId,
      approvalPayload: payload,
    });
    if (!result.ok) {
      throw new Error(`COMMIT_FAILED: ${(result.feedback as any).error?.code}: ${(result.feedback as any).error?.message}`);
    }
    return { ok: true, ...result.feedback };
  }

  // task ERP-P1: order.ship skipApprovalCheck=true 走 commit 闭环
  if (call.toolId === 'order.ship') {
    const targetApprovalId = String((call as any).approvalId || '');
    if (!targetApprovalId) {
      return {
        ok: false,
        status: 'failed',
        errorFeedback: { ...(buildOrderShipError as any)('APPROVAL_ID_MISSING', 'approvalId not provided for order.ship commit'), retryable: false },
      };
    }
    const approval = await (prisma as any).approvalRequest.findUnique({
      where: { id: targetApprovalId },
    }).catch(() => null);
    if (!approval || approval.status !== 'approved') {
      const msg = approval?.status === 'modified'
        ? `COMMIT_FAILED: order.ship does not support modified approval (status=modified). Regenerate draft and re-approve.`
        : `COMMIT_FAILED: approval ${targetApprovalId} not found or not approved (status=${approval?.status || 'null'})`;
      return {
        ok: false,
        status: 'failed',
        errorFeedback: { ...(buildOrderShipError as any)(approval?.status === 'modified' ? 'APPROVAL_MODIFIED_UNSUPPORTED' : 'APPROVAL_NOT_FOUND', msg), retryable: false },
      };
    }
    const payload = approval.payload as Record<string, unknown> | null;
    const result = await commitOrderShip({
      prisma,
      approvalId: targetApprovalId,
      approvalPayload: payload,
      actorId: context?.actor?.userId ?? context?.actorId, trustedActor: context?.actor ? toolActorToken(context.actor) : undefined,
    });
    if (!result.ok) {
      // task review-fix: 返回结构化 errorFeedback（不 throw，对齐稳定 error code 口径，agentLoop 可消费）
      return { ok: false, ...result.feedback };
    }
    return { ok: true, ...result.feedback };
  }

  // task ERP-P1: email.reply_and_send skipApprovalCheck=true 走 commit 闭环
  if (call.toolId === 'email.reply_and_send') {
    const targetApprovalId = String((call as any).approvalId || '');
    if (!targetApprovalId) {
      return { ok: false, errorFeedback: { ...(buildEmailReplySendError as any)('APPROVAL_ID_MISSING', 'approvalId not provided for email.reply_and_send commit'), retryable: false } };
    }
    const approval = await (prisma as any).approvalRequest.findUnique({ where: { id: targetApprovalId } }).catch(() => null);
    if (!approval || approval.status !== 'approved') {
      const msg = approval?.status === 'modified'
        ? `COMMIT_FAILED: email.reply_and_send does not support modified approval (status=modified). Regenerate draft and re-approve.`
        : `COMMIT_FAILED: approval ${targetApprovalId} not found or not approved (status=${approval?.status || 'null'})`;
      return { ok: false, errorFeedback: { ...(buildEmailReplySendError as any)(approval?.status === 'modified' ? 'APPROVAL_MODIFIED_UNSUPPORTED' : 'APPROVAL_NOT_FOUND', msg), retryable: false } };
    }
    const payload = approval.payload as Record<string, unknown> | null;
    const result = await commitEmailReplySend({ prisma, approvalId: targetApprovalId, approvalPayload: payload });
    if (!result.ok) return { ok: false, ...result.feedback };
    return { ok: true, ...result.feedback };
  }

  // task Agent-P1: relation.update commit
  if (call.toolId === 'relation.update') {
    const targetApprovalId = String((call as any).approvalId || '');
    if (!targetApprovalId) return { ok: false, errorFeedback: { ...(buildRelationMutationError as any)('APPROVAL_ID_MISSING', 'approvalId not provided'), retryable: false } };
    const approval = await (prisma as any).approvalRequest.findUnique({ where: { id: targetApprovalId } }).catch(() => null);
    if (!approval || approval.status !== 'approved') return { ok: false, errorFeedback: { ...(buildRelationMutationError as any)(approval?.status === 'modified' ? 'APPROVAL_MODIFIED_UNSUPPORTED' : 'APPROVAL_NOT_FOUND', 'approval invalid'), retryable: false } };
    const result = await commitRelationUpdate({ prisma, approvalId: targetApprovalId, approvalPayload: approval.payload });
    if (!result.ok) return { ok: false, ...result.feedback };
    return { ok: true, ...result.feedback };
  }

  // task Agent-P1: relation.delete commit
  if (call.toolId === 'relation.delete') {
    const targetApprovalId = String((call as any).approvalId || '');
    if (!targetApprovalId) return { ok: false, errorFeedback: { ...(buildRelationMutationError as any)('APPROVAL_ID_MISSING', 'approvalId not provided'), retryable: false } };
    const approval = await (prisma as any).approvalRequest.findUnique({ where: { id: targetApprovalId } }).catch(() => null);
    if (!approval || approval.status !== 'approved') return { ok: false, errorFeedback: { ...(buildRelationMutationError as any)(approval?.status === 'modified' ? 'APPROVAL_MODIFIED_UNSUPPORTED' : 'APPROVAL_NOT_FOUND', 'approval invalid'), retryable: false } };
    const result = await commitRelationDelete({ prisma, approvalId: targetApprovalId, approvalPayload: approval.payload });
    if (!result.ok) return { ok: false, ...result.feedback };
    return { ok: true, ...result.feedback };
  }

  // task Agent-P1: relation.onboard skipApprovalCheck=true 走 commit 闭环
  if (call.toolId === 'relation.onboard') {
    const targetApprovalId = String((call as any).approvalId || '');
    if (!targetApprovalId) {
      return { ok: false, errorFeedback: { ...(buildRelationOnboardError as any)('APPROVAL_ID_MISSING', 'approvalId not provided for relation.onboard commit'), retryable: false } };
    }
    const approval = await (prisma as any).approvalRequest.findUnique({ where: { id: targetApprovalId } }).catch(() => null);
    if (!approval || approval.status !== 'approved') {
      const msg = approval?.status === 'modified'
        ? `COMMIT_FAILED: relation.onboard does not support modified approval (status=modified). Regenerate draft and re-approve.`
        : `COMMIT_FAILED: approval ${targetApprovalId} not found or not approved (status=${approval?.status || 'null'})`;
      return { ok: false, errorFeedback: { ...(buildRelationOnboardError as any)(approval?.status === 'modified' ? 'APPROVAL_MODIFIED_UNSUPPORTED' : 'APPROVAL_NOT_FOUND', msg), retryable: false } };
    }
    const payload = approval.payload as Record<string, unknown> | null;
    const result = await commitRelationOnboard({ prisma, approvalId: targetApprovalId, approvalPayload: payload });
    if (!result.ok) return { ok: false, ...result.feedback };
    return { ok: true, ...result.feedback };
  }

  // task Agent-P1: invoice.create commit
  if (call.toolId === 'invoice.create') {
    const targetApprovalId = String((call as any).approvalId || '');
    if (!targetApprovalId) return { ok: false, errorFeedback: { ...(buildInvoiceMutationError as any)('APPROVAL_ID_MISSING', 'approvalId not provided'), retryable: false } };
    const approval = await (prisma as any).approvalRequest.findUnique({ where: { id: targetApprovalId } }).catch(() => null);
    if (!approval || approval.status !== 'approved') return { ok: false, errorFeedback: { ...(buildInvoiceMutationError as any)(approval?.status === 'modified' ? 'APPROVAL_MODIFIED_UNSUPPORTED' : 'APPROVAL_NOT_FOUND', 'approval invalid'), retryable: false } };
    if (approval.actionType !== 'tool:invoice.create') return { ok: false, errorFeedback: { code: 'CROSS_APPROVAL_BINDING', message: '原审批与本次开票操作不一致，请核对原审批。', retryable: false } };
    const result = await commitInvoiceCreate({ prisma, approvalId: targetApprovalId, approvalPayload: approval.payload,
      actorId: context?.actor?.userId, trustedActor: context?.actor ? toolActorToken(context.actor) : undefined });
    if (!result.ok) return { ok: false, ...result.feedback };
    return { ok: true, ...result.feedback };
  }

  // task Agent-P1: invoice.update commit
  if (call.toolId === 'invoice.update') {
    const targetApprovalId = String((call as any).approvalId || '');
    if (!targetApprovalId) return { ok: false, errorFeedback: { ...(buildInvoiceMutationError as any)('APPROVAL_ID_MISSING', 'approvalId not provided'), retryable: false } };
    const approval = await (prisma as any).approvalRequest.findUnique({ where: { id: targetApprovalId } }).catch(() => null);
    if (!approval || approval.status !== 'approved') return { ok: false, errorFeedback: { ...(buildInvoiceMutationError as any)(approval?.status === 'modified' ? 'APPROVAL_MODIFIED_UNSUPPORTED' : 'APPROVAL_NOT_FOUND', 'approval invalid'), retryable: false } };
    if (approval.actionType !== 'tool:invoice.update') return { ok: false, errorFeedback: { code: 'CROSS_APPROVAL_BINDING', message: '原审批与本次开票操作不一致，请核对原审批。', retryable: false } };
    const result = await commitInvoiceUpdate({ prisma, approvalId: targetApprovalId, approvalPayload: approval.payload,
      actorId: context?.actor?.userId, trustedActor: context?.actor ? toolActorToken(context.actor) : undefined });
    if (!result.ok) return { ok: false, ...result.feedback };
    return { ok: true, ...result.feedback };
  }

  // task Agent-P1: invoice.issue skipApprovalCheck=true 走 commit 闭环
  if (call.toolId === 'invoice.issue') {
    const targetApprovalId = String((call as any).approvalId || '');
    if (!targetApprovalId) {
      return { ok: false, errorFeedback: { ...(buildInvoiceIssueError as any)('APPROVAL_ID_MISSING', 'approvalId not provided for invoice.issue commit'), retryable: false } };
    }
    const approval = await (prisma as any).approvalRequest.findUnique({ where: { id: targetApprovalId } }).catch(() => null);
    if (!approval || approval.status !== 'approved') {
      const msg = approval?.status === 'modified'
        ? `COMMIT_FAILED: invoice.issue does not support modified approval (status=modified). Regenerate draft and re-approve.`
        : `COMMIT_FAILED: approval ${targetApprovalId} not found or not approved (status=${approval?.status || 'null'})`;
      return { ok: false, errorFeedback: { ...(buildInvoiceIssueError as any)(approval?.status === 'modified' ? 'APPROVAL_MODIFIED_UNSUPPORTED' : 'APPROVAL_NOT_FOUND', msg), retryable: false } };
    }
    const payload = approval.payload as Record<string, unknown> | null;
    const result = await commitInvoiceIssue({ prisma, approvalId: targetApprovalId, approvalPayload: payload,
      actorId: context?.actor?.userId, trustedActor: context?.actor ? toolActorToken(context.actor) : undefined,
      requesterId: approval.requesterId });
    if (!result.ok) return { ok: false, ...result.feedback };
    return { ok: true, ...result.feedback };
  }

  // task Agent-P1: email.send skipApprovalCheck=true 走 commit 闭环
  if (call.toolId === 'email.send') {
    const targetApprovalId = String((call as any).approvalId || '');
    if (!targetApprovalId) {
      return { ok: false, errorFeedback: { ...(buildEmailSendOutboxError as any)('APPROVAL_ID_MISSING', 'approvalId not provided for email.send commit'), retryable: false } };
    }
    const approval = await (prisma as any).approvalRequest.findUnique({ where: { id: targetApprovalId } }).catch(() => null);
    if (!approval || approval.status !== 'approved') {
      const msg = approval?.status === 'modified'
        ? `COMMIT_FAILED: email.send does not support modified approval (status=modified). Regenerate draft and re-approve.`
        : `COMMIT_FAILED: approval ${targetApprovalId} not found or not approved (status=${approval?.status || 'null'})`;
      return { ok: false, errorFeedback: { ...(buildEmailSendOutboxError as any)(approval?.status === 'modified' ? 'APPROVAL_MODIFIED_UNSUPPORTED' : 'APPROVAL_NOT_FOUND', msg), retryable: false } };
    }
    const payload = approval.payload as Record<string, unknown> | null;
    if (approval.actionType !== 'tool:email.send') return { ok: false, errorFeedback: {
      code: 'CROSS_APPROVAL_BINDING', message: '审批不属于 email.send', retryable: false } };
    let recoveryOnly: boolean;
    try {
      if (!(prisma as any).agentCommitReceipt) throw Error('Agent receipt delegate unavailable');
      recoveryOnly = (await (prisma as any).agentCommitReceipt.findUnique({
        where: { idempotencyKey: `commit:email.send:${targetApprovalId}` } })) != null;
    } catch {
      return { ok: false, errorFeedback: { code: 'SEND_LEDGER_UNAVAILABLE',
        message: '原 Agent 发送记录暂时无法核对，未重新发送', retryable: false } };
    }
    // credentialRef 恢复：从短期 secret context 取 pass（one-shot，不落 payload 明文）
    const payloadInput = (payload as any)?.input || {};
    const payloadCreds = payloadInput.credentials || {};
    const credentialRef = payloadCreds.credentialRef;
    const result = await commitEmailSendOutbox({
      prisma,
      approvalId: targetApprovalId,
      approvalPayload: payload,
      credentialRef: typeof credentialRef === 'string' ? credentialRef : undefined,
      actorId: context?.actor?.userId,
      trustedActor: context?.actor ? toolActorToken(context.actor) : undefined,
      requesterId: approval.requesterId,
      recoveryOnly,
    });
    if (!result.ok) return { ok: false, ...result.feedback };
    return { ok: true, ...result.feedback };
  }

  // task Agent-P1: development.convert_to_order skipApprovalCheck=true 走 commit 闭环
  if (call.toolId === 'development.convert_to_order') {
    const targetApprovalId = String((call as any).approvalId || '');
    if (!targetApprovalId) {
      return { ok: false, errorFeedback: { ...(buildDevConvertError as any)('APPROVAL_ID_MISSING', 'approvalId not provided for development.convert_to_order commit'), retryable: false } };
    }
    const approval = await (prisma as any).approvalRequest.findUnique({ where: { id: targetApprovalId } }).catch(() => null);
    if (!approval || approval.status !== 'approved') {
      const msg = approval?.status === 'modified'
        ? `COMMIT_FAILED: development.convert_to_order does not support modified approval (status=modified). Regenerate draft and re-approve.`
        : `COMMIT_FAILED: approval ${targetApprovalId} not found or not approved (status=${approval?.status || 'null'})`;
      return { ok: false, errorFeedback: { ...(buildDevConvertError as any)(approval?.status === 'modified' ? 'APPROVAL_MODIFIED_UNSUPPORTED' : 'APPROVAL_NOT_FOUND', msg), retryable: false } };
    }
    const payload = approval.payload as Record<string, unknown> | null;
    const result = await commitDevConvert({ prisma, approvalId: targetApprovalId, approvalPayload: payload, actorId: context?.actor?.userId, trustedActor: context?.actor ? toolActorToken(context.actor) : undefined });
    if (!result.ok) return { ok: false, ...result.feedback };
    return { ok: true, ...result.feedback };
  }

  // task Agent-P1: invoice.cancel skipApprovalCheck=true 走 commit 闭环
  if (call.toolId === 'invoice.cancel') {
    const targetApprovalId = String((call as any).approvalId || '');
    if (!targetApprovalId) {
      return { ok: false, errorFeedback: { ...(buildInvoiceCancelError as any)('APPROVAL_ID_MISSING', 'approvalId not provided for invoice.cancel commit'), retryable: false } };
    }
    const approval = await (prisma as any).approvalRequest.findUnique({ where: { id: targetApprovalId } }).catch(() => null);
    if (!approval || approval.status !== 'approved') {
      const msg = approval?.status === 'modified'
        ? `COMMIT_FAILED: invoice.cancel does not support modified approval (status=modified). Regenerate draft and re-approve.`
        : `COMMIT_FAILED: approval ${targetApprovalId} not found or not approved (status=${approval?.status || 'null'})`;
      return { ok: false, errorFeedback: { ...(buildInvoiceCancelError as any)(approval?.status === 'modified' ? 'APPROVAL_MODIFIED_UNSUPPORTED' : 'APPROVAL_NOT_FOUND', msg), retryable: false } };
    }
    const payload = approval.payload as Record<string, unknown> | null;
    const result = await commitInvoiceCancel({ prisma, approvalId: targetApprovalId, approvalPayload: payload, actorId: context?.actor?.userId, actor: context?.actor ? toolActorToken(context.actor) : undefined });
    if (!result.ok) return { ok: false, ...result.feedback };
    return { ok: true, ...result.feedback };
  }

  // task Agent-P1: invoice.delete commit
  if (call.toolId === 'invoice.delete') {
    const targetApprovalId = String((call as any).approvalId || '');
    if (!targetApprovalId) {
      return { ok: false, errorFeedback: { ...(buildFinanceSoftDeleteError as any)('APPROVAL_ID_MISSING', 'approvalId not provided'), retryable: false } };
    }
    const approval = await (prisma as any).approvalRequest.findUnique({ where: { id: targetApprovalId } }).catch(() => null);
    if (!approval || approval.status !== 'approved') {
      const msg = approval?.status === 'modified' ? `COMMIT_FAILED: modified approval not supported` : `COMMIT_FAILED: approval ${targetApprovalId} not found or not approved`;
      return { ok: false, errorFeedback: { ...(buildFinanceSoftDeleteError as any)(approval?.status === 'modified' ? 'APPROVAL_MODIFIED_UNSUPPORTED' : 'APPROVAL_NOT_FOUND', msg), retryable: false } };
    }
    const result = await commitInvoiceDelete({ prisma, approvalId: targetApprovalId, approvalPayload: approval.payload, actorId: context?.actor?.userId, actor: context?.actor ? toolActorToken(context.actor) : undefined });
    if (!result.ok) return { ok: false, ...result.feedback };
    return { ok: true, ...result.feedback };
  }

  // task Agent-P1: payment_voucher.delete commit
  if (call.toolId === 'payment_voucher.delete') {
    const targetApprovalId = String((call as any).approvalId || '');
    if (!targetApprovalId) {
      return { ok: false, errorFeedback: { ...(buildFinanceSoftDeleteError as any)('APPROVAL_ID_MISSING', 'approvalId not provided'), retryable: false } };
    }
    const approval = await (prisma as any).approvalRequest.findUnique({ where: { id: targetApprovalId } }).catch(() => null);
    if (!approval || approval.status !== 'approved') {
      const msg = approval?.status === 'modified' ? `COMMIT_FAILED: modified approval not supported` : `COMMIT_FAILED: approval ${targetApprovalId} not found or not approved`;
      return { ok: false, errorFeedback: { ...(buildFinanceSoftDeleteError as any)(approval?.status === 'modified' ? 'APPROVAL_MODIFIED_UNSUPPORTED' : 'APPROVAL_NOT_FOUND', msg), retryable: false } };
    }
    const result = await commitPaymentVoucherDelete({ prisma, approvalId: targetApprovalId, approvalPayload: approval.payload, actorId: context?.actor?.userId, actor: context?.actor ? toolActorToken(context.actor) : undefined });
    if (!result.ok) return { ok: false, ...result.feedback };
    return { ok: true, ...result.feedback };
  }



  // task Agent-P1: payment_voucher.create commit
  if (call.toolId === 'payment_voucher.create') {
    const targetApprovalId = String((call as any).approvalId || '');
    if (!targetApprovalId) return { ok: false, errorFeedback: { ...(buildPaymentVoucherFlowError as any)('APPROVAL_ID_MISSING', 'approvalId not provided'), retryable: false } };
    const approval = await (prisma as any).approvalRequest.findUnique({ where: { id: targetApprovalId } }).catch(() => null);
    if (!approval || approval.status !== 'approved') return { ok: false, errorFeedback: { ...(buildPaymentVoucherFlowError as any)(approval?.status === 'modified' ? 'APPROVAL_MODIFIED_UNSUPPORTED' : 'APPROVAL_NOT_FOUND', 'approval invalid'), retryable: false } };
    const result = await commitPaymentVoucherCreate({ prisma, approvalId: targetApprovalId, approvalPayload: approval.payload, actorId: context?.actor?.userId, actor: context?.actor ? toolActorToken(context.actor) : undefined });
    if (!result.ok) return { ok: false, ...result.feedback };
    return { ok: true, ...result.feedback };
  }

  // task Agent-P1: payment_voucher.update commit
  if (call.toolId === 'payment_voucher.update') {
    const targetApprovalId = String((call as any).approvalId || '');
    if (!targetApprovalId) return { ok: false, errorFeedback: { ...(buildPaymentVoucherFlowError as any)('APPROVAL_ID_MISSING', 'approvalId not provided'), retryable: false } };
    const approval = await (prisma as any).approvalRequest.findUnique({ where: { id: targetApprovalId } }).catch(() => null);
    if (!approval || approval.status !== 'approved') return { ok: false, errorFeedback: { ...(buildPaymentVoucherFlowError as any)(approval?.status === 'modified' ? 'APPROVAL_MODIFIED_UNSUPPORTED' : 'APPROVAL_NOT_FOUND', 'approval invalid'), retryable: false } };
    const result = await commitPaymentVoucherUpdate({ prisma, approvalId: targetApprovalId, approvalPayload: approval.payload, actorId: context?.actor?.userId, actor: context?.actor ? toolActorToken(context.actor) : undefined });
    if (!result.ok) return { ok: false, ...result.feedback };
    return { ok: true, ...result.feedback };
  }

  // task Agent-P1: product_asset.create commit
  if (call.toolId === 'product_asset.create') {
    const targetApprovalId = String((call as any).approvalId || '');
    if (!targetApprovalId) return { ok: false, errorFeedback: { ...(buildProductAssetFlowError as any)('APPROVAL_ID_MISSING', 'approvalId not provided'), retryable: false } };
    const approval = await (prisma as any).approvalRequest.findUnique({ where: { id: targetApprovalId } }).catch(() => null);
    if (!approval || approval.status !== 'approved') return { ok: false, errorFeedback: { ...(buildProductAssetFlowError as any)(approval?.status === 'modified' ? 'APPROVAL_MODIFIED_UNSUPPORTED' : 'APPROVAL_NOT_FOUND', 'approval invalid'), retryable: false } };
    const result = await commitProductAssetCreate({ prisma, approvalId: targetApprovalId, approvalPayload: approval.payload });
    if (!result.ok) return { ok: false, ...result.feedback };
    return { ok: true, ...result.feedback };
  }

  // task Agent-P1: product_asset.update commit
  if (call.toolId === 'product_asset.update') {
    const targetApprovalId = String((call as any).approvalId || '');
    if (!targetApprovalId) return { ok: false, errorFeedback: { ...(buildProductAssetFlowError as any)('APPROVAL_ID_MISSING', 'approvalId not provided'), retryable: false } };
    const approval = await (prisma as any).approvalRequest.findUnique({ where: { id: targetApprovalId } }).catch(() => null);
    if (!approval || approval.status !== 'approved') return { ok: false, errorFeedback: { ...(buildProductAssetFlowError as any)(approval?.status === 'modified' ? 'APPROVAL_MODIFIED_UNSUPPORTED' : 'APPROVAL_NOT_FOUND', 'approval invalid'), retryable: false } };
    const result = await commitProductAssetUpdate({ prisma, approvalId: targetApprovalId, approvalPayload: approval.payload });
    if (!result.ok) return { ok: false, ...result.feedback };
    return { ok: true, ...result.feedback };
  }

  // task Agent-P1: product_asset.delete commit
  if (call.toolId === 'product_asset.delete') {
    const targetApprovalId = String((call as any).approvalId || '');
    if (!targetApprovalId) return { ok: false, errorFeedback: { ...(buildProductAssetFlowError as any)('APPROVAL_ID_MISSING', 'approvalId not provided'), retryable: false } };
    const approval = await (prisma as any).approvalRequest.findUnique({ where: { id: targetApprovalId } }).catch(() => null);
    if (!approval || approval.status !== 'approved') return { ok: false, errorFeedback: { ...(buildProductAssetFlowError as any)(approval?.status === 'modified' ? 'APPROVAL_MODIFIED_UNSUPPORTED' : 'APPROVAL_NOT_FOUND', 'approval invalid'), retryable: false } };
    const result = await commitProductAssetDelete({ prisma, approvalId: targetApprovalId, approvalPayload: approval.payload });
    if (!result.ok) return { ok: false, ...result.feedback };
    return { ok: true, ...result.feedback };
  }

  // task Agent-P1: order.status_transition commit
  if (call.toolId === 'order.status_transition') {
    const targetApprovalId = String((call as any).approvalId || '');
    if (!targetApprovalId) {
      return { ok: false, errorFeedback: { ...(buildOrderLifecycleError as any)('APPROVAL_ID_MISSING', 'approvalId not provided'), retryable: false } };
    }
    const approval = await (prisma as any).approvalRequest.findUnique({ where: { id: targetApprovalId } }).catch(() => null);
    if (!approval || approval.status !== 'approved') {
      const msg = approval?.status === 'modified' ? `COMMIT_FAILED: modified approval not supported` : `COMMIT_FAILED: approval ${targetApprovalId} not found or not approved`;
      return { ok: false, errorFeedback: { ...(buildOrderLifecycleError as any)(approval?.status === 'modified' ? 'APPROVAL_MODIFIED_UNSUPPORTED' : 'APPROVAL_NOT_FOUND', msg), retryable: false } };
    }
    const result = await commitOrderStatusTransition({ prisma, approvalId: targetApprovalId, approvalPayload: approval.payload });
    if (!result.ok) return { ok: false, ...result.feedback };
    return { ok: true, ...result.feedback };
  }

  // task Agent-P1: order.delete commit
  if (call.toolId === 'order.delete') {
    const targetApprovalId = String((call as any).approvalId || '');
    if (!targetApprovalId) {
      return { ok: false, errorFeedback: { ...(buildOrderLifecycleError as any)('APPROVAL_ID_MISSING', 'approvalId not provided'), retryable: false } };
    }
    const approval = await (prisma as any).approvalRequest.findUnique({ where: { id: targetApprovalId } }).catch(() => null);
    if (!approval || approval.status !== 'approved') {
      const msg = approval?.status === 'modified' ? `COMMIT_FAILED: modified approval not supported` : `COMMIT_FAILED: approval ${targetApprovalId} not found or not approved`;
      return { ok: false, errorFeedback: { ...(buildOrderLifecycleError as any)(approval?.status === 'modified' ? 'APPROVAL_MODIFIED_UNSUPPORTED' : 'APPROVAL_NOT_FOUND', msg), retryable: false } };
    }
    const result = await commitOrderDelete({ prisma, approvalId: targetApprovalId, approvalPayload: approval.payload });
    if (!result.ok) return { ok: false, ...result.feedback };
    return { ok: true, ...result.feedback };
  }

  // task Agent-P1: order.line_update commit
  if (call.toolId === 'order.line_update') {
    const targetApprovalId = String((call as any).approvalId || '');
    if (!targetApprovalId) {
      return { ok: false, errorFeedback: { ...(buildOrderLineUpdateError as any)('APPROVAL_ID_MISSING', 'approvalId not provided'), retryable: false } };
    }
    const approval = await (prisma as any).approvalRequest.findUnique({ where: { id: targetApprovalId } }).catch(() => null);
    if (!approval || approval.status !== 'approved') {
      const msg = approval?.status === 'modified' ? `COMMIT_FAILED: modified approval not supported` : `COMMIT_FAILED: approval ${targetApprovalId} not found or not approved`;
      return { ok: false, errorFeedback: { ...(buildOrderLineUpdateError as any)(approval?.status === 'modified' ? 'APPROVAL_MODIFIED_UNSUPPORTED' : 'APPROVAL_NOT_FOUND', msg), retryable: false } };
    }
    const result = await commitOrderLineUpdate({ prisma, approvalId: targetApprovalId, approvalPayload: approval.payload, trustedActor: context?.actor ? toolActorToken(context.actor) : undefined });
    if (!result.ok) return { ok: false, ...result.feedback };
    return { ok: true, ...result.feedback };
  }
  throw new Error(`Tool handler not implemented: ${call.toolId}`);
}

// ════════════════════════════════════════════════════════════════════
// 工具分发注册表 — 渐进式迁移 if 链到 Map 注册表
// 新增工具应在此处 registerTool()，而非在 executeTool 中加 if 分支
// ════════════════════════════════════════════════════════════════════
registerTool('products.count', async (prisma) => { const r = await countProductAssets(prisma); return { ok: true, ...r }; });
registerTool('products.search', async (prisma, input) => { const r = await searchProductAssets(prisma, String(input.query || ''), numberInput(input.limit, 5)); return { ok: true, ...r }; });
registerTool('products.query', async (prisma, input) => { const r = await queryProductAssets(prisma, input); return { ok: true, ...r }; });
registerTool('products.describe_schema', async () => { const r = await describeProductSchema(); return { ok: true, ...r }; });
registerTool('products.get', async (prisma, input) => { const r = await getProductAsset(prisma, input); return { ok: true, ...r }; });
registerTool('products.expand', async (prisma, input) => { const r = await expandProductAssetContext(prisma, input); return { ok: true, ...r }; });
registerTool('dictionary.query', async (prisma, input) => { const r = await queryBusinessDictionary(prisma, input); return { ok: true, ...r }; });
registerTool('records.query', async (prisma, input) => { const r = await queryBusinessRecords(prisma, input); return { ok: true, ...r }; });
registerTool('orders.search', async (prisma, input) => { const r = await searchOrders(prisma, String(input.query || ''), numberInput(input.limit, 5)); return { ok: true, ...r }; });
registerTool('orders.query', async (prisma, input, _call, context) => { const r = await queryOrdersWithDataCenterFallback(prisma, input, context); return { ok: true, ...r }; });
registerTool('orders.get', async (prisma, input) => { const r = await getOrderWithDataCenterFallback(prisma, input); return { ok: true, ...r }; });
registerTool('orders.expand', async (prisma, input) => { const r = await expandOrderContext(prisma, input); return { ok: true, ...r }; });
registerTool('relations.search', async (prisma, input) => { const r = await searchRelations(prisma, String(input.query || ''), numberInput(input.limit, 5)); return { ok: true, ...r }; });
registerTool('relations.query', (prisma, input) => queryRelationsWithDataCenterFallback(prisma, input));
registerTool('relations.get', (prisma, input) => getRelationWithDataCenterFallback(prisma, input));
registerTool('relations.expand', (prisma, input) => expandRelationWithDataCenterFallback(prisma, input));
registerTool('knowledge.search', async (prisma, input) => { const r = await searchKnowledge(prisma, input); return { ok: true, ...r }; });
registerTool('entities.search', async (prisma, input) => { const r = await searchBusinessEntities(prisma, input); return { ok: true, ...r }; });
registerTool('entities.hydrate', async (prisma, input) => { const r = await hydrateBusinessEntities(prisma, input); return { ok: true, ...r }; });
registerTool('development.query', async (prisma, input) => { const r = await queryDevelopmentCases(prisma, input); return { ok: true, ...r }; });
registerTool('development.get', async (prisma, input) => { const r = await getDevelopmentCase(prisma, input); return { ok: true, ...r }; });
registerTool('development.update_stage', async (prisma, input) => updateDevelopmentStage(prisma, input));
registerTool('orders.list_by_status', async (prisma, input) => { const r = await listOrdersByStatus(prisma, input); return { ok: true, ...r }; });
registerTool('orders.update_status', (prisma, input) => updateOrderStatus(prisma, input));
registerTool('orders.get_timeline', async (prisma, input) => { const r = await getOrderTimeline(prisma, input); return { ok: true, ...r }; });
registerTool('orders.batch_status', (prisma, input) => batchUpdateOrderStatus(prisma, input));
registerTool('orders.kanban', async (prisma, input) => { const r = await getOrdersKanban(prisma, input); return { ok: true, ...r }; });
registerTool('garment.update_size_breakdown', (prisma, input) => updateGarmentSizeBreakdown(prisma, input));
registerTool('garment.update_production_steps', (prisma, input) => updateGarmentProductionSteps(prisma, input));
registerTool('links.query', async (prisma, input, _call, context) => queryEntityLinks(prisma, input, context));
registerTool('links.expand_neighbors', (prisma, input, _call, context) => expandEntityNeighbors(prisma, input, context));
registerTool('finance.list_invoices', (prisma, input, _call, context) => handleFinanceListInvoices(prisma, input, context));
registerTool('finance.get_invoice', (prisma, input, _call, context) => handleFinanceGetInvoice(prisma, input, context));
registerTool('finance.list_vouchers', (prisma, input, _call, context) => handleFinanceListVouchers(prisma, input, context));
registerTool('finance.get_voucher', (prisma, input, _call, context) => handleFinanceGetVoucher(prisma, input, context));
registerTool('finance.query_outstanding', (prisma, input, _call, context) => handleFinanceQueryOutstanding(prisma, input, context));
registerTool('finance.create_invoice', (prisma, input, _call, context) => handleFinanceCreateInvoice(prisma, input, context));
registerTool('finance.create_voucher', (prisma, input, _call, context) => handleFinanceCreateVoucher(prisma, input, context));
registerTool('finance.apply_voucher_to_invoice', (prisma, input, _call, context) => handleFinanceApplyVoucherToInvoice(prisma, input, context));
registerTool('shipping.list_shipments', (prisma, input) => handleShippingListShipments(prisma, input));
registerTool('shipping.get_shipment', (prisma, input) => handleShippingGetShipment(prisma, input));
registerTool('shipping.create_shipment', (prisma, input, _call, context) => handleShippingCreateShipment(prisma, input, context));
registerTool('shipping.update_tracking_status', (prisma, input, _call, context) => handleShippingUpdateTrackingStatus(prisma, input, context));
registerTool('relations.create', (prisma, input) => handleRelationCreate(prisma, input));
registerTool('email.list', (prisma, input) => handleEmailListEmails(prisma, input));
registerTool('email.get', (prisma, input) => handleEmailGetEmail(prisma, input));
registerTool('email.search', (prisma, input) => handleEmailSearchEmails(prisma, input));
registerTool('email.link_to_order', (prisma, input) => handleEmailLinkEmailToOrder(prisma, input));
registerTool('email.ai_extract', (prisma, input) => handleEmailAiExtract(prisma, input));
registerTool('template.list', () => handleTemplateList());
registerTool('template.render', (prisma, input) => handleTemplateRender(prisma, input));
registerTool('template.render_pdf', (prisma, input) => handleTemplateRenderPdf(prisma, input));

// C3 高频外贸场景只读工具（智能报价 / 跟单提醒 / LC 审单 / 客户风险预警）
registerTool('quotations.query', (prisma, input) => handleQuotationsQuery(prisma, input));
registerTool('quotations.get', (prisma, input) => handleQuotationsGet(prisma, input));
registerTool('finance.get_aging', (prisma, input, _call, context) => handleFinanceGetAging(prisma, input, context));
registerTool('finance.get_statement', (prisma, input, _call, context) => handleFinanceGetStatement(prisma, input, context));
registerTool('customs.query_lc', (prisma, input) => handleCustomsQueryLc(prisma, input));
registerTool('customs.get_lc', (prisma, input) => handleCustomsGetLc(prisma, input));
registerTool('shipping.scan_delays', (prisma, input) => handleShippingScanDelays(prisma, input));

// Current production facts use the same fresh source and authorization as HTTP.
registerTool('production.get_pipeline', async (prisma, input, _call, context) => {
  const { readProductionProgressOrder } = await import('../production/productionProgressService');
  const item = await readProductionProgressOrder(prisma, context?.actor ? toolActorToken(context.actor) : undefined, String(input.orderId || ''));
  return { ok: true, progress: item };
});
for (const name of ['production.advance_stage', 'production.save_checklist', 'production.save_inspection', 'production.sign_stage']) {
  registerTool(name, async () => ({ ok: false, error: { code: 'EXACT_PRODUCTION_COMMAND_REQUIRED',
    message: '请使用准确产品条目、工厂分支和当前授权的原生样品、QC、放行或完工操作。历史整单阶段只读。' } }));
}
registerTool('production.scan_alerts', async (prisma, _input, _call, context) => {
  const { readProductionProgressAlerts } = await import('../production/productionProgressService');
  return { ok: true, ...await readProductionProgressAlerts(prisma, context?.actor ? toolActorToken(context.actor) : undefined) };
});

// ── Phase 4 Track G：Phase 2 八域只读查询工具（risk=low + approvalPolicy=never，无写库）──
registerNewDomainQueryTools();

// ── Phase 2 S3a/S3b：21 个写工具 Flow 注册（commit 统一走 registerCommitTool）──
registerOrderChangesFlowTools();
registerPaymentRequestsFlowTools();
registerCreditFlowTools();
registerSamplesFlowTools();
registerQcFlowTools();
registerInternalTradeFlowTools();
registerProcurementFlowTools();
registerInventoryFlowTools();
registerQuotationFlowTools();
registerCustomsFlowTools();

// 注册统计日志（开发环境可查看）
// ═══ 复合 commit 工具注册（通过 registerCommitTool 统一 approval boilerplate）═══
import { registerCommitTool as _rct } from './toolDispatchRegistry';
_rct('knowledge.ingest', async (ctx) => {
  const result = await commitKnowledgeIngest({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload, actorId: ctx.actorId });
  const _r = result as any; return _r.ok ? { ok: true, ..._r.feedback } : { ok: false, errorFeedback: { code: _r.feedback?.error?.code || 'COMMIT_FAILED', message: _r.feedback?.error?.message || 'commit failed', retryable: false } };
});
_rct('email.sync', async (ctx) => {
  const payloadInput = (ctx.approvalPayload as any)?.input || {};
  const credentialRef = payloadInput.credentials?.credentialRef;
  const recoveredPass = credentialRef ? takeEmailCredential(credentialRef) : '';
  const result = await commitEmailSync({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload, actorId: ctx.actorId, credentialsPassword: recoveredPass || '' });
  const _r = result as any; return _r.ok ? { ok: true, ..._r.feedback } : { ok: false, errorFeedback: { code: _r.feedback?.error?.code || 'COMMIT_FAILED', message: _r.feedback?.error?.message || 'commit failed', retryable: false } };
});
_rct('order.confirm', async (ctx) => {
  const result = await commitOrderConfirm({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload, actorId: ctx.actorId });
  const _r = result as any;
  if (!_r.ok) {
    // ★ `CommitResult` 的形状是 `{ ok, committed, error, errorFeedback }` —— **没有** `feedback` 那一层
    //   （`feedback` 是 commitInvoiceIssue / commitEmailSync 那批 Flow 的形状，它们各自有 wrapper）。
    //   原写法 `_r.feedback?.error?.message || 'commit failed'` 恒取不到 ⇒ 每次都走
    //   `buildOrderConfirmError('commit failed')` → `parseErrorCode` 逐条不命中 → 一律
    //   `UNKNOWN_ERROR` / "未知错误，请联系管理员"。后果不是"文案难看"，而是**本批刚接上的门禁码在最后一公里被销毁**：
    //   业务员被 MOQ / 信用 / 信用证挡住时，前端拿不到 `CONFIRM_GATE_BLOCKED` + `gateCode` + 豁免单号，
    //   也就没有任何一条路能跳到"去批豁免"。这正是 §12.05 D80 那一族（跨层边界把码销毁）的第 N 次现形。
    const ef = _r.errorFeedback ?? {};
    return {
      ok: false,
      errorFeedback: {
        code: ef.code || 'COMMIT_FAILED',
        // ★ 对外文案取 `_r.error`（同一句话的两个字段，`error` 是权威那份），**不写 `message: ef.message`**：
        //   后者正是 `rawErrorLeakRatchet`（B22）计的"跨层转发 .message"形状 —— 它分不清产品文案与原始异常文本，
        //   所以这里不做那一跳转发（`customs/lcGate.ts` 的 LcGateDecision 注释记的是同一枚坑、同一个正解）。
        message: _r.error || 'commit failed',
        userAction: ef.userAction || '',
        ...(ef.details ? { details: ef.details } : {}),
        ...(ef.gateCode ? { gateCode: ef.gateCode } : {}),
        ...(ef.approvalRequestId ? { approvalRequestId: ef.approvalRequestId } : {}),
        retryable: ef.retryable === true,
      },
    };
  }
  // 成功路径保持原样（`_r.feedback` 对 CommitResult 恒 undefined ⇒ 展开为空），
  // 不在本批顺手改载荷形状：committed 字段（orderId/invoiceId/…）此前就没透出去，改它要先看模型侧与前端消费方（已立账）。
  return { ok: true, ..._r.feedback };
});
_rct('payment.receive_and_reconcile', async (ctx) => {
  const result = await commitPaymentReceiveAndReconcile({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload, actorId: ctx.actorId });
  const _r = result as any; return _r.ok ? { ok: true, ..._r.feedback } : { ok: false, errorFeedback: { code: _r.feedback?.error?.code || 'COMMIT_FAILED', message: _r.feedback?.error?.message || 'commit failed', retryable: _r.feedback?.error?.retryable === true } };
});
_rct('order.ship', async (ctx) => {
  const result = await commitOrderShip({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload, actorId: ctx.actorId, trustedActor: ctx.actor ? toolActorToken(ctx.actor) : undefined });
  const _r = result as any; return _r.ok ? { ok: true, ..._r.feedback } : { ok: false, errorFeedback: { code: _r.feedback?.error?.code || 'COMMIT_FAILED', message: _r.feedback?.error?.message || 'commit failed', retryable: false } };
});
_rct('email.reply_and_send', async (ctx) => {
  const result = await commitEmailReplySend({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload, actorId: ctx.actorId });
  const _r = result as any; return _r.ok ? { ok: true, ..._r.feedback } : { ok: false, errorFeedback: { code: _r.feedback?.error?.code || 'COMMIT_FAILED', message: _r.feedback?.error?.message || 'commit failed', retryable: false } };
});
_rct('relation.update', async (ctx) => {
  const result = await commitRelationUpdate({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload, actorId: ctx.actorId });
  const _r = result as any; return _r.ok ? { ok: true, ..._r.feedback } : { ok: false, errorFeedback: { code: _r.feedback?.error?.code || 'COMMIT_FAILED', message: _r.feedback?.error?.message || 'commit failed', retryable: false } };
});
_rct('relation.delete', async (ctx) => {
  const result = await commitRelationDelete({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload, actorId: ctx.actorId });
  const _r = result as any; return _r.ok ? { ok: true, ..._r.feedback } : { ok: false, errorFeedback: { code: _r.feedback?.error?.code || 'COMMIT_FAILED', message: _r.feedback?.error?.message || 'commit failed', retryable: false } };
});
_rct('relation.onboard', async (ctx) => {
  const result = await commitRelationOnboard({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload, actorId: ctx.actorId });
  const _r = result as any; return _r.ok ? { ok: true, ..._r.feedback } : { ok: false, errorFeedback: { code: _r.feedback?.error?.code || 'COMMIT_FAILED', message: _r.feedback?.error?.message || 'commit failed', retryable: false } };
});
_rct('invoice.create', async (ctx) => {
  const result = await commitInvoiceCreate({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload, actorId: ctx.actor?.userId, trustedActor: ctx.actor ? toolActorToken(ctx.actor) : undefined });
  const _r = result as any; return _r.ok ? { ok: true, ..._r.feedback } : { ok: false, errorFeedback: { code: _r.feedback?.error?.code || 'COMMIT_FAILED', message: _r.feedback?.error?.message || 'commit failed', retryable: false } };
});
_rct('invoice.update', async (ctx) => {
  const result = await commitInvoiceUpdate({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload, actorId: ctx.actor?.userId, trustedActor: ctx.actor ? toolActorToken(ctx.actor) : undefined });
  const _r = result as any; return _r.ok ? { ok: true, ..._r.feedback } : { ok: false, errorFeedback: { code: _r.feedback?.error?.code || 'COMMIT_FAILED', message: _r.feedback?.error?.message || 'commit failed', retryable: false } };
});
_rct('invoice.issue', async (ctx) => {
  const result = await commitInvoiceIssue({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload,
    actorId: ctx.actor?.userId, trustedActor: ctx.actor ? toolActorToken(ctx.actor) : undefined, requesterId: ctx.actorId });
  const _r = result as any; return _r.ok ? { ok: true, ..._r.feedback } : { ok: false, errorFeedback: { code: _r.feedback?.error?.code || 'COMMIT_FAILED', message: _r.feedback?.error?.message || 'commit failed', retryable: false } };
});
_rct('invoice.cancel', async (ctx) => {
  const result = await commitInvoiceCancel({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload, actorId: ctx.actor?.userId, actor: ctx.actor ? toolActorToken(ctx.actor) : undefined });
  const _r = result as any; return _r.ok ? { ok: true, ..._r.feedback } : { ok: false, errorFeedback: { code: _r.feedback?.error?.code || 'COMMIT_FAILED', message: _r.feedback?.error?.message || 'commit failed', retryable: false } };
});
_rct('invoice.delete', async (ctx) => {
  const result = await commitInvoiceDelete({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload, actorId: ctx.actor?.userId, actor: ctx.actor ? toolActorToken(ctx.actor) : undefined });
  const _r = result as any; return _r.ok ? { ok: true, ..._r.feedback } : { ok: false, errorFeedback: { ...(buildFinanceSoftDeleteError as any)('UNKNOWN_ERROR', _r.feedback?.error?.message || 'delete failed'), retryable: false } };
});
_rct('email.send', async (ctx) => {
  // credentialRef 恢复：从短期 secret context 取 SMTP pass（one-shot，不落 payload 明文）
  // 镜像 email.sync commit handler——draft 阶段 pass 存 emailCredentialStore，payload 只存 credentialRef
  const payloadInput = (ctx.approvalPayload as any)?.input || {};
  const credentialRef = payloadInput.credentials?.credentialRef;
  const result = await commitEmailSendOutbox({ prisma: ctx.prisma, approvalId: ctx.approvalId,
    approvalPayload: ctx.approvalPayload, actorId: ctx.actor?.userId,
    trustedActor: ctx.actor ? toolActorToken(ctx.actor) : undefined,
    requesterId: ctx.actorId, recoveryOnly: ctx.recoveryOnly, credentialRef: typeof credentialRef === 'string' ? credentialRef : undefined });
  const _r = result as any; return _r.ok ? { ok: true, ..._r.feedback } : { ok: false, errorFeedback: { code: _r.feedback?.error?.code || 'COMMIT_FAILED', message: _r.feedback?.error?.message || 'commit failed', retryable: false } };
});
_rct('development.convert_to_order', async (ctx) => {
  const result = await commitDevConvert({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload, actorId: ctx.actor?.userId, trustedActor: ctx.actor ? toolActorToken(ctx.actor) : undefined });
  const _r = result as any; return _r.ok ? { ok: true, ..._r.feedback } : { ok: false, errorFeedback: { code: _r.feedback?.error?.code || 'COMMIT_FAILED', message: _r.feedback?.error?.message || 'commit failed', retryable: false } };
});
_rct('development.create', async (ctx) => {
  const result = await commitDevCreate({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload, actorId: ctx.actor?.userId, trustedActor: ctx.actor ? toolActorToken(ctx.actor) : undefined });
  const _r = result as any; return _r.ok ? { ok: true, ..._r.feedback } : { ok: false, errorFeedback: { code: _r.feedback?.error?.code || 'COMMIT_FAILED', message: _r.feedback?.error?.message || 'commit failed', retryable: false } };
});
_rct('statement.send', async (ctx) => {
  const result = await commitStatementSend({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload, actorId: ctx.actorId });
  const _r = result as any; return _r.ok ? { ok: true, ..._r.feedback } : { ok: false, errorFeedback: { code: _r.feedback?.error?.code || 'COMMIT_FAILED', message: _r.feedback?.error?.message || 'commit failed', retryable: false } };
});
_rct('order.status_transition', async (ctx) => {
  const result = await commitOrderStatusTransition({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload, actorId: ctx.actorId });
  const _r = result as any; return _r.ok ? { ok: true, ..._r.feedback } : { ok: false, errorFeedback: { ...(buildOrderLifecycleError as any)(_r.feedback?.error?.message || 'transition failed'), retryable: false } };
});
_rct('order.delete', async (ctx) => {
  const result = await commitOrderDelete({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload, actorId: ctx.actorId });
  const _r = result as any; return _r.ok ? { ok: true, ..._r.feedback } : { ok: false, errorFeedback: { ...(buildOrderLifecycleError as any)(_r.feedback?.error?.message || 'delete failed'), retryable: false } };
});
_rct('order.line_update', async (ctx) => {
  const result = await commitOrderLineUpdate({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload, actorId: ctx.actorId, trustedActor: ctx.actor ? toolActorToken(ctx.actor) : undefined });
  const _r = result as any; return _r.ok ? { ok: true, ..._r.feedback } : { ok: false, errorFeedback: { ...((buildOrderLineUpdateError as any)(_r.feedback?.error?.code || 'UNKNOWN_ERROR', _r.feedback?.error?.message || 'line update failed')), retryable: false } };
});
_rct('payment_voucher.create', async (ctx) => {
  const result = await commitPaymentVoucherCreate({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload, actorId: ctx.actor?.userId, actor: ctx.actor ? toolActorToken(ctx.actor) : undefined });
  const _r = result as any; return _r.ok ? { ok: true, ..._r.feedback } : { ok: false, errorFeedback: { ...(buildPaymentVoucherFlowError as any)(_r.feedback?.error?.message || 'create failed'), retryable: false } };
});
_rct('payment_voucher.update', async (ctx) => {
  const result = await commitPaymentVoucherUpdate({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload, actorId: ctx.actor?.userId, actor: ctx.actor ? toolActorToken(ctx.actor) : undefined });
  const _r = result as any; return _r.ok ? { ok: true, ..._r.feedback } : { ok: false, errorFeedback: { ...(buildPaymentVoucherFlowError as any)(_r.feedback?.error?.message || 'update failed'), retryable: false } };
});
_rct('payment_voucher.delete', async (ctx) => {
  const result = await commitPaymentVoucherDelete({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload, actorId: ctx.actor?.userId, actor: ctx.actor ? toolActorToken(ctx.actor) : undefined });
  const _r = result as any; return _r.ok ? { ok: true, ..._r.feedback } : { ok: false, errorFeedback: { ...(buildFinanceSoftDeleteError as any)('UNKNOWN_ERROR', _r.feedback?.error?.message || 'delete failed'), retryable: false } };
});
_rct('product_asset.create', async (ctx) => {
  const result = await commitProductAssetCreate({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload, actorId: ctx.actorId });
  const _r = result as any; return _r.ok ? { ok: true, ..._r.feedback } : { ok: false, errorFeedback: { ...(buildProductAssetFlowError as any)(_r.feedback?.error?.message || 'create failed'), retryable: false } };
});
_rct('product_asset.update', async (ctx) => {
  const result = await commitProductAssetUpdate({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload, actorId: ctx.actorId });
  const _r = result as any; return _r.ok ? { ok: true, ..._r.feedback } : { ok: false, errorFeedback: { ...(buildProductAssetFlowError as any)(_r.feedback?.error?.message || 'update failed'), retryable: false } };
});
_rct('product_asset.delete', async (ctx) => {
  const result = await commitProductAssetDelete({ prisma: ctx.prisma, approvalId: ctx.approvalId, approvalPayload: ctx.approvalPayload, actorId: ctx.actorId });
  const _r = result as any; return _r.ok ? { ok: true, ..._r.feedback } : { ok: false, errorFeedback: { ...(buildProductAssetFlowError as any)(_r.feedback?.error?.message || 'delete failed'), retryable: false } };
});

if (process.env.NODE_ENV !== 'production') {
  logger.info(`[toolDispatchRegistry] ${getRegisteredToolCount()} simple tools registered (complex commit tools remain in if-chain)`);
}

async function countProductAssets(prisma: PrismaClient) {
  const remote = getAgentDataApiConfig();
  if (remote) {
    const [all, fabric, garment, trimming] = await Promise.all([
      fetchRemoteProductAssets(remote, { limit: 1, offset: 0 }),
      fetchRemoteProductAssets(remote, { mainCategory: 'Fabric', limit: 1, offset: 0 }),
      fetchRemoteProductAssets(remote, { mainCategory: 'Garment', limit: 1, offset: 0 }),
      fetchRemoteProductAssets(remote, { mainCategory: 'Trimmings', limit: 1, offset: 0 }),
    ]);
    return {
      dataSource: 'bambook-data-center',
      totalCount: all.total,
      fabricCount: fabric.total,
      garmentCount: garment.total,
      trimmingCount: trimming.total,
    };
  }
  const productAsset = (prisma as any).productAsset;
  if (!productAsset?.count) {
    return { dataSource: 'local-prisma-unavailable', totalCount: 0, fabricCount: 0, garmentCount: 0, trimmingCount: 0 };
  }

  const [totalCount, fabricCount, garmentCount, trimmingCount] = await Promise.all([
    productAsset.count({ where: { deletedAt: null } }),
    productAsset.count({
      where: {
        deletedAt: null,
        OR: [
          { mainCategory: { contains: 'Fabric', mode: 'insensitive' as const } },
          { fabricProfile: { isNot: null } },
        ],
      },
    }),
    productAsset.count({
      where: {
        deletedAt: null,
        mainCategory: { contains: 'Garment', mode: 'insensitive' as const },
      },
    }),
    productAsset.count({
      where: {
        deletedAt: null,
        mainCategory: { contains: 'Trimming', mode: 'insensitive' as const },
      },
    }),
  ]);

  return { dataSource: 'local-prisma', totalCount, fabricCount, garmentCount, trimmingCount };
}

async function queryBusinessDictionary(prisma: PrismaClient, input: Record<string, unknown>) {
  const dictionary = cleanIdentifier(input.dictionary);
  const query = cleanIdentifier(input.query);
  const mainCategory = cleanIdentifier(input.mainCategory);
  if (dictionary !== 'productSubCategory') {
    return { dictionary, query, count: 0, items: [], reason: 'DICTIONARY_NOT_SUPPORTED' };
  }
  const remote = getAgentDataApiConfig();
  if (remote) {
    const items = await fetchRemoteProductCategories(remote);
    const terms = dictionaryQueryTerms(query);
    const filtered = items
      .filter((item: any) => !item.deletedAt)
      .filter((item: any) => !mainCategory || String(item.mainCategory || '').toLowerCase() === mainCategory.toLowerCase())
      .filter((item: any) => !terms.length || terms.some(term => [
        item.id,
        item.name,
        item.description,
      ].some(value => String(value || '').toLowerCase().includes(term.toLowerCase()))))
      .slice(0, 10);
    return {
      dataSource: 'bambook-data-center',
      dictionary,
      query,
      mainCategory,
      count: filtered.length,
      items: filtered.map((item: any) => ({
        id: item.id,
        mainCategory: item.mainCategory,
        name: item.name,
        description: item.description,
      })),
    };
  }
  const model = (prisma as any).productSubCategory;
  if (!model?.findMany) return { dictionary, query, count: 0, items: [], reason: 'PRODUCT_SUBCATEGORY_MODEL_UNAVAILABLE' };
  const queryTerms = dictionaryQueryTerms(query);
  const items = await model.findMany({
    where: {
      deletedAt: null,
      ...(mainCategory ? { mainCategory: { equals: mainCategory, mode: 'insensitive' as const } } : {}),
      ...(query
        ? {
          OR: [
            ...queryTerms.flatMap(term => [
              { id: { contains: term, mode: 'insensitive' as const } },
              { name: { contains: term, mode: 'insensitive' as const } },
              { description: { contains: term, mode: 'insensitive' as const } },
            ]),
          ],
        }
        : {}),
    },
    orderBy: { updatedAt: 'desc' },
    take: 10,
  });
  return {
    dataSource: 'local-prisma',
    dictionary,
    query,
    mainCategory,
    count: items.length,
    items: items.map((item: any) => ({
      id: item.id,
      mainCategory: item.mainCategory,
      name: item.name,
      description: item.description,
    })),
  };
}

async function queryBusinessRecords(prisma: PrismaClient, input: Record<string, unknown>) {
  const entity = cleanIdentifier(input.entity) || 'ProductAsset';
  const aggregate = cleanIdentifier(input.aggregate) || '';
  if (entity !== 'ProductAsset') {
    return { entity, aggregate, reason: 'ENTITY_NOT_SUPPORTED' };
  }
  const remote = getAgentDataApiConfig();
  if (remote) {
    const normalized = normalizeProductQueryInput(input);
    const response = await fetchRemoteProductAssetQuery(remote, {
      ...normalized,
      entity,
      aggregate: aggregate === 'count' ? 'count' : 'list',
      limit: aggregate === 'count' ? 1 : normalized.limit,
    });
    if (aggregate === 'count') {
      return {
        dataSource: 'bambook-data-center',
        entity,
        aggregate,
        count: response.count ?? response.total,
        filters: normalized.filters,
        sort: normalized.sort,
        query: normalized.query,
      };
    }
    return {
      dataSource: 'bambook-data-center',
      query: normalized.query,
      filters: normalized.filters,
      sort: normalized.sort,
      total: response.total,
      count: response.assets.length,
      limit: normalized.limit,
      offset: normalized.offset,
      hasMore: response.hasMore,
      items: response.assets.map(formatProductAsset),
    };
  }
  const productAsset = (prisma as any).productAsset;
  if (!productAsset?.count) return { entity, aggregate, count: 0, reason: 'PRODUCT_ASSET_MODEL_UNAVAILABLE' };

  const normalized = normalizeProductQueryInput(input);
  const where = buildProductQueryWhere(normalized);
  if (aggregate === 'count') {
    const count = await productAsset.count({ where });
    return {
      dataSource: 'local-prisma',
      entity,
      aggregate,
      count,
      filters: normalized.filters,
      sort: normalized.sort,
    };
  }
  return queryProductAssets(prisma, input);
}

async function searchProductAssets(prisma: PrismaClient, query: string, limit: number) {
  const remote = getAgentDataApiConfig();
  if (remote) {
    const response = await fetchRemoteProductAssets(remote, { search: query, limit, offset: 0 });
    return {
      dataSource: 'bambook-data-center',
      query,
      total: response.total,
      count: response.assets.length,
      items: response.assets.map(formatProductAsset),
    };
  }
  const productAsset = (prisma as any).productAsset;
  if (!productAsset?.findMany) return { query, items: [] };
  const words = splitQueryWords(query);
  const items = await productAsset.findMany({
    where: {
      deletedAt: null,
      OR: [
        { sku: { contains: query, mode: 'insensitive' as const } },
        { name: { contains: query, mode: 'insensitive' as const } },
        { mainCategory: { contains: query, mode: 'insensitive' as const } },
        { season: { contains: query, mode: 'insensitive' as const } },
        { fabricProfile: { is: { articleNo: { contains: query, mode: 'insensitive' as const } } } },
        { fabricProfile: { is: { millQuality: { contains: query, mode: 'insensitive' as const } } } },
        { fabricProfile: { is: { millColorCode: { contains: query, mode: 'insensitive' as const } } } },
        ...words.flatMap(word => [
          { sku: { contains: word, mode: 'insensitive' as const } },
          { name: { contains: word, mode: 'insensitive' as const } },
          { mainCategory: { contains: word, mode: 'insensitive' as const } },
          { fabricProfile: { is: { articleNo: { contains: word, mode: 'insensitive' as const } } } },
          { fabricProfile: { is: { millQuality: { contains: word, mode: 'insensitive' as const } } } },
        ]),
      ],
    },
    include: {
      fabricProfile: true,
      fabricCustomerCodes: { where: { deletedAt: null }, take: 5 },
      compositionLines: { include: { term: true }, take: 8 },
    },
    orderBy: { updatedAt: 'desc' },
    take: limit,
  });
  return { dataSource: 'local-prisma', query, count: items.length, items: items.map(formatProductAsset) };
}

async function queryProductAssets(prisma: PrismaClient, input: Record<string, unknown>) {
  const remote = getAgentDataApiConfig();
  if (remote) {
    const normalized = normalizeProductQueryInput(input);
    const response = await fetchRemoteProductAssetQuery(remote, {
      ...normalized,
      entity: 'ProductAsset',
      aggregate: 'list',
    });
    return {
      dataSource: 'bambook-data-center',
      query: normalized.query,
      filters: normalized.filters,
      sort: normalized.sort,
      total: response.total,
      count: response.assets.length,
      limit: normalized.limit,
      offset: normalized.offset,
      hasMore: response.hasMore,
      items: response.assets.map(formatProductAsset),
    };
  }
  const productAsset = (prisma as any).productAsset;
  if (!productAsset?.findMany) return { query: input, total: 0, items: [], reason: 'PRODUCT_ASSET_MODEL_UNAVAILABLE' };

  const normalized = normalizeProductQueryInput(input);
  const where = buildProductQueryWhere(normalized);
  const orderBy = productQueryOrderBy(normalized.sort);
  const [items, total] = await Promise.all([
    productAsset.findMany({
      where,
      include: {
        fabricProfile: true,
        fabricCustomerCodes: { where: { deletedAt: null }, take: 8 },
        fabricPrices: { where: { deletedAt: null }, orderBy: { updatedAt: 'desc' as const }, take: 8 },
        fabricCertifications: { where: { deletedAt: null }, take: 12 },
        compositionLines: {
          where: { deletedAt: null },
          include: { term: true },
          orderBy: { sortOrder: 'asc' as const },
          take: 12,
        },
      },
      orderBy,
      take: normalized.limit,
      skip: normalized.offset,
    }),
    productAsset.count?.({ where }) ?? Promise.resolve(undefined),
  ]);

  return {
    dataSource: 'local-prisma',
    query: normalized.query,
    filters: normalized.filters,
    sort: normalized.sort,
    total,
    count: items.length,
    limit: normalized.limit,
    offset: normalized.offset,
    hasMore: typeof total === 'number' ? normalized.offset + items.length < total : undefined,
    items: items.map(formatProductAsset),
  };
}

function describeProductSchema() {
  return {
    entity: 'ProductAsset',
    sourceOfTruth: 'Bambook backend database',
    purpose: '让 Agent 先发现数字档案有哪些可读字段、可筛选字段、可排序字段，再生成 products.query / products.get 调用。',
    tools: {
      get: {
        id: 'products.get',
        useWhen: '已有 SKU、Article No.、styleNo、trimmingCode 或 ProductAsset id，需要读取唯一完整档案。',
      },
      query: {
        id: 'products.query',
        useWhen: '需要按字段筛选、排序、分页、统计匹配数量，类似用户在数字档案页面筛选。',
        genericFilterShape: {
          fieldFilters: [
            { path: 'fabric.certification', operator: 'contains', value: 'RWS' },
            { path: 'fabric.weightValue', operator: 'gte', value: 250 },
          ],
          sort: { field: 'updatedAt', direction: 'desc' },
          limit: 10,
          offset: 0,
        },
      },
    },
    fields: PRODUCT_FIELD_DEFINITIONS,
    sortableFields: PRODUCT_FIELD_DEFINITIONS.filter(field => field.sortable).map(field => field.path),
    writableNow: false,
    writePath: '后续写入/编辑必须走单独 action tool + 权限校验 + dry-run + 审批/审计，不允许模型直接改数据库。',
  };
}

async function getProductAsset(prisma: PrismaClient, input: Record<string, unknown>) {
  const remote = getAgentDataApiConfig();
  if (remote) {
    const lookup = normalizeProductLookup(input);
    if (!lookup) return { dataSource: 'bambook-data-center', found: false, reason: 'MISSING_PRODUCT_IDENTIFIER', input };
    if (lookup.type === 'id') {
      const item = await fetchRemoteProductAsset(remote, lookup.value);
      return item
        ? { dataSource: 'bambook-data-center', found: true, matchType: lookup.type, identifier: lookup.value, item: formatFullProductAsset(item) }
        : { dataSource: 'bambook-data-center', found: false, matchType: lookup.type, identifier: lookup.value, candidates: [] };
    }
    const response = await fetchRemoteProductAssets(remote, { search: lookup.value, limit: 5, offset: 0 });
    const exact = response.assets.filter((item: any) => remoteProductMatchesLookup(item, lookup));
    if (exact.length === 1) {
      const full = await fetchRemoteProductAsset(remote, exact[0].id).catch(() => exact[0]);
      return { dataSource: 'bambook-data-center', found: true, matchType: lookup.type, identifier: lookup.value, item: formatFullProductAsset(full || exact[0]) };
    }
    return {
      dataSource: 'bambook-data-center',
      found: false,
      ambiguous: exact.length > 1 || response.assets.length > 0,
      matchType: lookup.type,
      identifier: lookup.value,
      candidates: (exact.length ? exact : response.assets).map(formatProductAsset),
    };
  }
  const productAsset = (prisma as any).productAsset;
  if (!productAsset?.findMany) return { found: false, reason: 'PRODUCT_ASSET_MODEL_UNAVAILABLE', input };

  const lookup = normalizeProductLookup(input);
  if (!lookup) return { found: false, reason: 'MISSING_PRODUCT_IDENTIFIER', input };

  const exactMatchesRaw = await productAsset.findMany({
    where: {
      deletedAt: null,
      OR: productExactWhere(lookup),
    },
    include: fullProductAssetInclude(),
    orderBy: { updatedAt: 'desc' },
    take: 3,
  });
  const exactMatches = Array.isArray(exactMatchesRaw) ? exactMatchesRaw : [];

  if (exactMatches.length === 1) {
    return {
      found: true,
      matchType: lookup.type,
      identifier: lookup.value,
      item: formatFullProductAsset(exactMatches[0]),
    };
  }

  if (exactMatches.length > 1) {
    return {
      found: false,
      ambiguous: true,
      matchType: lookup.type,
      identifier: lookup.value,
      candidates: exactMatches.map(formatProductAsset),
    };
  }

  const candidateMatchesRaw = await productAsset.findMany({
    where: {
      deletedAt: null,
      OR: productCandidateWhere(lookup.value),
    },
    include: fullProductAssetInclude(),
    orderBy: { updatedAt: 'desc' },
    take: 5,
  });
  const candidateMatches = Array.isArray(candidateMatchesRaw) ? candidateMatchesRaw : [];

  return {
    found: false,
    ambiguous: candidateMatches.length > 0,
    matchType: lookup.type,
    identifier: lookup.value,
    candidates: candidateMatches.map(formatProductAsset),
  };
}

async function expandProductAssetContext(prisma: PrismaClient, input: Record<string, unknown>) {
  const include = normalizeProductExpandInclude(input.include);
  const result = await getProductAsset(prisma, input);
  const item = (result as any).item;
  if (!(result as any).found || !item) {
    return {
      dataSource: (result as any).dataSource || 'bambook-data-center',
      found: false,
      include,
      reason: (result as any).reason,
      matchType: (result as any).matchType,
      identifier: (result as any).identifier,
      candidates: (result as any).candidates || [],
    };
  }

  return compactObject({
    dataSource: (result as any).dataSource || 'bambook-data-center',
    found: true,
    matchType: (result as any).matchType,
    identifier: (result as any).identifier,
    include,
    product: formatExpandedProductSummary(item),
    profile: include.includes('profile') ? productProfileContext(item) : undefined,
    pricing: include.includes('pricing') ? item.fabricPrices || [] : undefined,
    certifications: include.includes('certifications') ? item.fabricCertifications || [] : undefined,
    composition: include.includes('composition') ? item.compositionLines || [] : undefined,
    images: include.includes('images') ? item.images || [] : undefined,
    customerCodes: include.includes('customerCodes') ? item.fabricCustomerCodes || [] : undefined,
    relations: include.includes('relations') ? productRelationRefs(item) : undefined,
  });
}

function formatExpandedProductSummary(product: any) {
  return compactObject({
    id: product.id,
    sku: product.sku,
    name: product.name,
    mainCategory: product.mainCategory,
    subCategoryId: product.subCategoryId,
    season: product.season,
    status: product.status,
    imageUrl: product.imageUrl,
    techPackUrl: product.techPackUrl,
    updatedAt: product.updatedAt,
  });
}

function productProfileContext(product: any) {
  return compactObject({
    fabricProfile: product.fabricProfile,
    garmentProfile: product.garmentProfile,
    trimmingProfile: product.trimmingProfile,
  });
}

function productRelationRefs(product: any) {
  const refs: Array<Record<string, unknown>> = [];
  const add = (kind: string, relationId?: unknown, label?: unknown, source?: string) => {
    const id = cleanIdentifier(relationId);
    const name = cleanIdentifier(label);
    if (!id && !name) return;
    const signature = `${kind}:${id || name}:${source || ''}`;
    if (refs.some(ref => ref.signature === signature)) return;
    refs.push(compactObject({ signature, kind, relationId: id || undefined, name: name || undefined, source }));
  };

  add('millOrganization', product.fabricProfile?.millOrganizationId, product.fabricProfile?.millQuality, 'fabricProfile');
  for (const code of product.fabricCustomerCodes || []) {
    add('customerOrganization', code.customerOrganizationId, code.customerNameSnapshot, 'fabricCustomerCodes');
  }
  for (const price of product.fabricPrices || []) {
    add('priceCustomerOrganization', price.customerOrganizationId, undefined, 'fabricPrices');
  }
  add('garmentCustomer', undefined, product.garmentProfile?.customer, 'garmentProfile');
  add('garmentFactory', undefined, product.garmentProfile?.factory, 'garmentProfile');
  add('trimmingSupplier', undefined, product.trimmingProfile?.supplier, 'trimmingProfile');

  return refs.map(({ signature, ...ref }) => ref);
}

function normalizeProductExpandInclude(value: unknown) {
  const allowed = new Set(defaultProductExpandInclude());
  const raw = Array.isArray(value) ? value.map(String) : defaultProductExpandInclude();
  const include = raw.filter(item => allowed.has(item));
  return include.length ? Array.from(new Set(include)) : ['profile'];
}

function defaultProductExpandInclude() {
  return ['profile', 'pricing', 'certifications', 'composition', 'images', 'customerCodes', 'relations'];
}

function inferProductExpandInclude(query: string) {
  const include = new Set<string>(['profile']);
  if (/价格|报价|成本|price|pricing|cost/i.test(query)) include.add('pricing');
  if (/认证|证书|certification|certificate|rws|grs|ocs/i.test(query)) include.add('certifications');
  if (/成分|composition|羊毛|棉|poly|viscose|fiber/i.test(query)) include.add('composition');
  if (/图片|照片|image|photo|图/i.test(query)) include.add('images');
  if (/客户码|客户编号|customer\s*code|client\s*code|article/i.test(query)) include.add('customerCodes');
  if (/关联|供应商|客户|工厂|关系|relation|supplier|customer|mill|factory/i.test(query)) include.add('relations');
  if (/完整|详细|展开|全部|上下文|档案|detail|full|expand|context/i.test(query)) {
    for (const item of defaultProductExpandInclude()) include.add(item);
  }
  return Array.from(include);
}

async function searchOrders(prisma: PrismaClient, query: string, limit: number) {
  const words = splitQueryWords(query);
  const items = await prisma.order.findMany({
    where: {
      deletedAt: null,
      OR: [
        { poNumber: { contains: query, mode: 'insensitive' } },
        { customer: { contains: query, mode: 'insensitive' } },
        { product: { contains: query, mode: 'insensitive' } },
        ...words.flatMap(word => [
          { poNumber: { contains: word, mode: 'insensitive' as const } },
          { customer: { contains: word, mode: 'insensitive' as const } },
          { product: { contains: word, mode: 'insensitive' as const } },
        ]),
      ],
    },
    orderBy: { updatedAt: 'desc' },
    take: limit,
  });
  return {
    query,
    count: items.length,
    items: items.map(order => ({
      id: order.id,
      poNumber: order.poNumber,
      customer: order.customer,
      product: order.product,
      status: order.status,
      quantity: order.quantity,
      dueDate: order.dueDate,
    })),
  };
}

async function searchRelations(prisma: PrismaClient, query: string, limit: number) {
  const words = splitQueryWords(query);
  const items = await prisma.relation.findMany({
    where: {
      deletedAt: null,
      OR: [
        { name: { contains: query, mode: 'insensitive' } },
        { chineseName: { contains: query, mode: 'insensitive' } },
        { englishName: { contains: query, mode: 'insensitive' } },
        { summary: { contains: query, mode: 'insensitive' } },
        ...words.flatMap(word => [
          { name: { contains: word, mode: 'insensitive' as const } },
          { chineseName: { contains: word, mode: 'insensitive' as const } },
          { englishName: { contains: word, mode: 'insensitive' as const } },
        ]),
      ],
    },
    orderBy: { lastInteraction: 'desc' },
    take: limit,
  });
  return {
    query,
    count: items.length,
    items: items.map(relation => ({
      id: relation.id,
      name: relation.name,
      chineseName: relation.chineseName,
      englishName: relation.englishName,
      category: relation.category,
      summary: relation.summary,
      preferences: relation.preferences,
      contactInfo: relation.contactInfo,
    })),
  };
}

async function queryOrdersWithDataCenterFallback(prisma: PrismaClient, input: Record<string, unknown>, context?: import('./toolDispatchRegistry').ToolExecutionContext) {
  const remote = getAgentDataApiConfig();
  if (remote) {
    return fetchRemoteDataCenter(remote, '/v1/orders/query', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }
  return queryOrders(prisma, input, { actor: context?.actor ? toolActorToken(context.actor) : undefined });
}

async function getOrderWithDataCenterFallback(prisma: PrismaClient, input: Record<string, unknown>) {
  const remote = getAgentDataApiConfig();
  if (remote) {
    const id = cleanIdentifier(input.id || input.poNumber || input.po);
    if (!id) return { dataSource: 'bambook-data-center', found: false, reason: 'MISSING_ORDER_IDENTIFIER', input };
    const data = await fetchRemoteDataCenter(remote, `/v1/orders/${encodeURIComponent(id)}`);
    return data.order ? { dataSource: 'bambook-data-center', found: true, item: data.order } : data;
  }
  return getOrder(prisma, input);
}

async function expandOrderContext(prisma: PrismaClient, input: Record<string, unknown>) {
  const include = normalizeOrderExpandInclude(input.include);
  const result = await getOrderWithDataCenterFallback(prisma, input);
  const item = (result as any).item;
  if (!(result as any).found || !item) {
    return {
      dataSource: (result as any).dataSource || 'bambook-data-center',
      found: false,
      include,
      reason: (result as any).reason,
      input,
    };
  }

  return compactObject({
    dataSource: (result as any).dataSource || 'bambook-data-center',
    found: true,
    include,
    summary: include.includes('summary') ? orderSummaryContext(item) : undefined,
    lines: include.includes('lines') ? item.lines || [] : undefined,
    parties: include.includes('parties') ? orderPartiesContext(item) : undefined,
    dates: include.includes('dates') ? orderDatesContext(item) : undefined,
    invoices: include.includes('invoices') ? orderInvoicesContext(item) : undefined,
    samples: include.includes('samples') ? orderSamplesContext(item) : undefined,
    production: include.includes('production') ? orderProductionContext(item) : undefined,
    missingFields: include.includes('missingFields') ? orderMissingFields(item) : undefined,
    currencies: include.includes('currencies') ? orderCurrenciesContext(item) : undefined,
  });
}

function orderSummaryContext(order: any) {
  return compactObject({
    id: order.id,
    poNumber: order.poNumber,
    customer: order.customer,
    customerCode: order.customerCode,
    product: order.product,
    type: order.type,
    quantity: order.quantity,
    status: order.status,
    season: order.season,
    quoteAmount: order.quoteAmount,
    totalNet: order.totalNet,
    totalActual: order.totalActual,
    updatedAt: order.updatedAt,
    importedAt: order.importedAt,
    source: order.source,
  });
}

function orderPartiesContext(order: any) {
  return compactObject({
    customer: compactObject({
      name: order.customer,
      code: order.customerCode,
      relationId: order.customerRelationId,
      address: order.customerAddress,
      contactPerson: order.contactPerson,
      contactPhone: order.contactPhone,
    }),
    mill: compactObject({
      name: order.millName,
      relationId: order.millRelationId,
      address: order.millAddress,
      contact: order.millContact,
      phone: order.millPhone,
    }),
    consignee: compactObject({
      name: order.consigneeName || order.shipToName,
      relationId: order.consigneeRelationId,
      address: order.consigneeAddress || [order.shipToAddress1, order.shipToAddress2, order.shipToCountry].filter(Boolean).join(' '),
      contact: order.consigneeContact,
      phone: order.shipToPhone,
      deliverTo: order.deliverTo,
    }),
    billTo: compactObject({
      name: order.billToName,
      relationId: order.billToRelationId,
      address: order.billToAddress,
      contact: order.billToContact,
      isAgent: order.billToIsAgent,
    }),
    internalTeam: compactObject({
      salesPerson: order.salesPerson,
      salesPersonRelationId: order.salesPersonRelationId,
      merchandiser: order.merchandiser,
      merchandiserRelationId: order.merchandiserRelationId,
      supervisor: order.supervisor,
      supervisorRelationId: order.supervisorRelationId,
      asPerson: order.asPerson,
    }),
  });
}

function orderDatesContext(order: any) {
  return compactObject({
    poDate: order.poDate,
    dueDate: order.dueDate,
    clientDate: order.clientDate,
    productionDate: order.productionDate,
    shipmentDate: order.shipmentDate,
    expectedPaymentDate: order.expectedPaymentDate,
    actualPaymentDate: order.actualPaymentDate,
    importedAt: order.importedAt,
    updatedAt: order.updatedAt,
    lineDates: Array.isArray(order.lines) ? order.lines.map((line: any) => compactObject({
      id: line.id,
      lineNumber: line.lineNumber,
      itemNo: line.itemNo,
      deliveryDate: line.deliveryDate,
      exMillDate: line.exMillDate,
      shippingDate: line.shippingDate,
      invoiceDate: line.invoiceDate,
      actualPaymentDate: line.actualPaymentDate,
    })) : [],
  });
}

function orderInvoicesContext(order: any) {
  return compactObject({
    sales: compactObject({
      invoiceNumber: order.invoiceNumber,
      invoiceDate: order.invoiceDate,
      shipmentAmount: order.shipmentAmount,
      actualPaymentAmount: order.actualPaymentAmount,
      paymentInstrument: order.paymentInstrument,
      paymentTerms: order.paymentTerms,
    }),
    purchase: compactObject({
      supplierInvoiceNumber: order.supplierInvoiceNumber,
      supplierInvoiceDate: order.supplierInvoiceDate,
      supplierInvoiceAmount: order.supplierInvoiceAmount,
      purchasePrice: order.purchasePrice,
      purchasePaymentDate: order.purchasePaymentDate,
    }),
    lines: Array.isArray(order.lines) ? order.lines.map((line: any) => compactObject({
      id: line.id,
      lineNumber: line.lineNumber,
      itemNo: line.itemNo,
      invoiceNumber: line.invoiceNumber,
      invoiceDate: line.invoiceDate,
      shipmentAmount: line.shipmentAmount,
      actualPaymentAmount: line.actualPaymentAmount,
    })) : [],
  });
}

function orderSamplesContext(order: any) {
  return compactObject({
    shipmentSample: compactObject({
      sampleSentDate: order.sampleSentDate,
      sampleConfirmedDate: order.sampleConfirmedDate,
      sampleTrackingNumber: order.sampleTrackingNumber,
      comments: order.shipmentSampleComments,
    }),
    fabricSample: compactObject({
      fabricSampleSentDate: order.fabricSampleSentDate,
      fabricSampleConfirmedDate: order.fabricSampleConfirmedDate,
      fabricSampleTrackingNumber: order.fabricSampleTrackingNumber,
      paidSampleQuantity: order.paidSampleQuantity,
    }),
    factoryVisitDate: order.factoryVisitDate,
  });
}

function orderProductionContext(order: any) {
  return compactObject({
    productionBatch: order.productionBatch,
    productionDate: order.productionDate,
    productColorCode: order.productColorCode,
    clientCode: order.clientCode,
    referenceBatch: order.referenceBatch,
    fabricCode: order.fabricCode,
    fabricContent: order.fabricContent,
    width: order.width,
    gsm: order.gsm,
    shipmentMethod: order.shipmentMethod,
    shipmentQuantity: order.shipmentQuantity,
    specialInstructions: order.specialInstructions,
    ocDays: order.ocDays,
    lines: Array.isArray(order.lines) ? order.lines.map((line: any) => compactObject({
      id: line.id,
      lineNumber: line.lineNumber,
      itemNo: line.itemNo,
      materialCode: line.materialCode,
      millQuality: line.millQuality,
      description: line.description,
      width: line.width,
      quantity: line.quantity,
      unit: line.unit,
      status: line.status,
      productionBatch: line.productionBatch,
      shippingDate: line.shippingDate,
      shippingMethod: line.shippingMethod,
      specialInstructions: line.specialInstructions,
    })) : [],
  });
}

function orderCurrenciesContext(order: any) {
  return compactObject({
    currency: order.currency,
    salesCurrency: order.salesCurrency,
    purchaseCurrency: order.purchaseCurrency,
    salesPrice: order.salesPrice,
    purchasePrice: order.purchasePrice,
    contractAmount: order.contractAmount,
    quoteAmount: order.quoteAmount,
    totalNet: order.totalNet,
    totalActual: order.totalActual,
  });
}

function orderMissingFields(order: any) {
  const fields = [
    'poNumber', 'customer', 'customerCode', 'millName', 'billToName', 'consigneeName',
    'dueDate', 'clientDate', 'productionDate', 'shipmentDate',
    'invoiceNumber', 'supplierInvoiceNumber',
    'paymentTerms', 'salesCurrency', 'purchaseCurrency',
    'sampleSentDate', 'fabricSampleSentDate',
  ];
  return fields.filter(field => {
    const value = order[field];
    return value == null || value === '';
  });
}

function normalizeOrderExpandInclude(value: unknown) {
  const allowed = new Set(defaultOrderExpandInclude());
  const raw = Array.isArray(value) ? value.map(String) : defaultOrderExpandInclude();
  const include = raw.filter(item => allowed.has(item));
  return include.length ? Array.from(new Set(include)) : ['summary'];
}

function defaultOrderExpandInclude() {
  return ['summary', 'lines', 'parties', 'dates', 'invoices', 'samples', 'production', 'missingFields', 'currencies'];
}

async function queryRelationsWithDataCenterFallback(prisma: PrismaClient, input: Record<string, unknown>) {
  const remote = getAgentDataApiConfig();
  if (remote) {
    return fetchRemoteDataCenter(remote, '/v1/relations/query', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }
  return queryRelations(prisma, input);
}

async function getRelationWithDataCenterFallback(prisma: PrismaClient, input: Record<string, unknown>) {
  const remote = getAgentDataApiConfig();
  if (remote) {
    const id = cleanIdentifier(input.id || input.name);
    if (!id) return { dataSource: 'bambook-data-center', found: false, reason: 'MISSING_RELATION_IDENTIFIER', input };
    const data = await fetchRemoteDataCenter(remote, `/v1/relations/${encodeURIComponent(id)}`);
    return data.relation ? { dataSource: 'bambook-data-center', found: true, item: data.relation } : data;
  }
  return getRelation(prisma, input);
}

async function expandRelationWithDataCenterFallback(prisma: PrismaClient, input: Record<string, unknown>) {
  const remote = getAgentDataApiConfig();
  if (remote) {
    const id = cleanIdentifier(input.id || input.relationId || input.name);
    if (!id) return { dataSource: 'bambook-data-center', found: false, reason: 'MISSING_RELATION_IDENTIFIER', input };
    const params = new URLSearchParams();
    if (Array.isArray(input.include)) params.set('include', input.include.map(String).join(','));
    if (input.limit) params.set('limit', String(input.limit));
    return fetchRemoteDataCenter(remote, `/v1/relations/${encodeURIComponent(id)}/expand${params.size ? `?${params.toString()}` : ''}`);
  }
  return expandRelation(prisma, input);
}

/**
 * 通过权威 Python RAG（pgvector 向量检索）查询企业知识库。
 * 收口方向：Agent 的 knowledge.search 以向量检索为主，Prisma 子串为降级补充。
 * 未配置 BAMBOOK_RAG_API_KEY 或 RAG 不可达时优雅降级（返回 ok:false），不抛错。
 *
 * 2026-08-19 降级显式化（批次1-1d）：degraded 区分"服务不可用"（not_configured /
 * unreachable / http_error）与"服务正常但零命中"（empty，非降级），由 searchKnowledge
 * 向 LLM observation 输出 notice——回答质量劣化可预期、可提示，不再静默。
 */
type RagSearchOutcome = {
  ok: boolean;
  hits: Array<Record<string, unknown>>;
  degraded: boolean;
  degradedReason?: 'not_configured' | 'unreachable' | 'http_error' | 'empty';
};

async function searchRagKnowledge(query: string, limit: number): Promise<RagSearchOutcome> {
  const apiKey = process.env.BAMBOOK_RAG_API_KEY;
  const baseUrl = (process.env.BAMBOOK_RAG_BASE_URL || 'http://127.0.0.1:8091/bambook/kb').replace(/\/$/, '');
  if (!apiKey) return { ok: false, hits: [], degraded: true, degradedReason: 'not_configured' };
  try {
    const res = await fetch(`${baseUrl}/v1/knowledge/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, top_k: Math.max(1, Math.min(limit, 20)) }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { ok: false, hits: [], degraded: true, degradedReason: 'http_error' };
    const data = (await res.json()) as { results?: Array<any> };
    const results = Array.isArray(data.results) ? data.results : [];
    const hits = results.map((r) => {
      const meta = (r.metadata && typeof r.metadata === 'object' ? r.metadata : {}) as Record<string, unknown>;
      const category = String(meta.category || 'company');
      return {
        source: `rag-knowledge:${category}`,
        title: r.source_title || r.title || '',
        category,
        content: String(r.content || '').slice(0, 1200),
        scopes: ['company'],
        metadata: meta,
        score: typeof r.score === 'number' ? Number(r.score.toFixed(3)) : undefined,
      };
    }).filter((h: any) => (h.content || '').length > 0);
    if (hits.length === 0) return { ok: false, hits: [], degraded: false, degradedReason: 'empty' };
    return { ok: true, hits, degraded: false };
  } catch {
    return { ok: false, hits: [], degraded: true, degradedReason: 'unreachable' };
  }
}

async function searchKnowledge(prisma: PrismaClient, input: Record<string, unknown>) {
  const query = cleanIdentifier(input.query);
  const limit = numberInput(input.limit, 8);
  if (!query) return { dataSource: 'bambook-data-center', query, count: 0, items: [] };
  const words = splitQueryWords(query);
  // 收口：优先向量检索（Python RAG/pgvector），未配置或不可达时静默降级为空。
  const rag = await searchRagKnowledge(query, limit);
  const [chunks, documents, legacy] = await Promise.all([
    (prisma as any).knowledgeChunk?.findMany?.({
      where: {
        deletedAt: null,
        document: { deletedAt: null, status: 'active' },
        OR: [
          { content: { contains: query, mode: 'insensitive' as const } },
          { summary: { contains: query, mode: 'insensitive' as const } },
          ...words.flatMap(word => [
            { content: { contains: word, mode: 'insensitive' as const } },
            { summary: { contains: word, mode: 'insensitive' as const } },
          ]),
        ],
      },
      include: { document: true },
      orderBy: { updatedAt: 'desc' as const },
      take: limit,
    }) ?? Promise.resolve([]),
    (prisma as any).knowledgeDocument?.findMany?.({
      where: {
        deletedAt: null,
        status: 'active',
        OR: [
          { title: { contains: query, mode: 'insensitive' as const } },
          ...words.map(word => ({ title: { contains: word, mode: 'insensitive' as const } })),
        ],
      },
      orderBy: { updatedAt: 'desc' as const },
      take: Math.max(1, Math.floor(limit / 2)),
    }) ?? Promise.resolve([]),
    (prisma as any).knowledgeItem?.findMany?.({
      where: {
        deletedAt: null,
        OR: [
          { title: { contains: query, mode: 'insensitive' as const } },
          { content: { contains: query, mode: 'insensitive' as const } },
          ...words.flatMap(word => [
            { title: { contains: word, mode: 'insensitive' as const } },
            { content: { contains: word, mode: 'insensitive' as const } },
          ]),
        ],
      },
      orderBy: { updatedAt: 'desc' as const },
      take: Math.max(1, Math.floor(limit / 2)),
    }) ?? Promise.resolve([]),
  ]);
  const items = [
    ...rag.hits.map((hit) => ({
      source: hit.source,
      title: hit.title,
      category: hit.category,
      content: hit.content,
      scopes: hit.scopes,
      metadata: hit.metadata,
      score: hit.score,
    })),
    ...chunks.map((chunk: any) => ({
      source: 'KnowledgeChunk',
      id: chunk.id,
      documentId: chunk.documentId,
      title: chunk.document?.title,
      chunkIndex: chunk.chunkIndex,
      summary: chunk.summary,
      content: String(chunk.content || '').slice(0, 1200),
      tags: chunk.tags,
    })),
    ...documents.map((document: any) => ({
      source: 'KnowledgeDocument',
      id: document.id,
      title: document.title,
      sourceType: document.sourceType,
      sourceUri: document.sourceUri,
      metadata: document.metadata,
    })),
    ...legacy.map((item: any) => ({
      source: 'KnowledgeItemCompat',
      id: item.id,
      title: item.title,
      category: item.category,
      content: String(item.content || '').slice(0, 1200),
    })),
  ];
  // 去重（按内容摘要去重，RAG 向量命中优先）+ 截断到 limit
  const seen = new Set<string>();
  const deduped: Array<Record<string, unknown>> = [];
  for (const item of items) {
    const key = String(item.title || '') + '|' + String(item.content || '').slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
    if (deduped.length >= limit) break;
  }
  // 降级显式化：语义检索不可用时向 LLM observation 输出 notice（回答可预期、可对用户提示），
  // 服务正常但零命中（empty）不算降级
  return {
    dataSource: rag.ok ? 'bambook-rag' : 'bambook-data-center',
    query,
    count: deduped.length,
    items: deduped,
    ragDegraded: rag.degraded,
    ...(rag.degraded
      ? {
          ragDegradedReason: rag.degradedReason,
          notice: `语义检索（RAG 向量）不可用（${rag.degradedReason}），已降级为关键词子串匹配，同义/模糊表述可能无法命中；基于当前结果回答时应向用户说明检索方式受限`,
        }
      : {}),
  };
}

async function searchBusinessEntities(prisma: PrismaClient, input: Record<string, unknown>) {
  const items = await searchEntities(prisma, {
    query: cleanIdentifier(input.query),
    entityTypes: Array.isArray(input.entityTypes) ? input.entityTypes.map(String) : undefined,
    limit: numberInput(input.limit, 10),
    include: typeof input.include === 'object' && input.include ? input.include as any : { fillPatch: false, links: true },
  });
  return { dataSource: 'bambook-data-center', count: items.length, items };
}

async function hydrateBusinessEntities(prisma: PrismaClient, input: Record<string, unknown>) {
  const refs = Array.isArray(input.refs) ? input.refs : [];
  const items = await hydrateEntities(prisma, {
    refs: refs.map((ref: any) => ({
      entityType: String(ref.entityType || ''),
      id: String(ref.id || ''),
      targetPath: ref.targetPath ? String(ref.targetPath) : undefined,
    })),
    include: typeof input.include === 'object' && input.include ? input.include as any : { fillPatch: false, links: true },
  });
  return { dataSource: 'bambook-data-center', count: items.length, items };
}

async function recordAgentToolRun(
  prisma: PrismaClient,
  input: {
    actor: ActorContext;
    definition: ToolDefinition;
    status: 'success' | 'failed' | 'approval_required';
    toolInput: Record<string, unknown>;
    output?: unknown;
    error?: string;
    startedAt: Date;
    sessionId?: string;
    actorUserId?: string;
    requestSource?: 'user-session' | 'api-key' | 'dev';
    approvalId?: string;
  },
): Promise<string | undefined> {
  const toolRunId = `atr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    const userId = await resolveActorUserAccountId(prisma, {
      userId: input.actor.userId,
      displayName: input.actor.displayName,
    });
    await (prisma as any).agentTool?.upsert?.({
      where: { id: input.definition.id },
      create: {
        id: input.definition.id,
        name: input.definition.name,
        scope: input.definition.scope,
        risk: input.definition.risk,
        inputSchema: {},
        status: 'active',
      },
      update: {
        name: input.definition.name,
        scope: input.definition.scope,
        risk: input.definition.risk,
        status: 'active',
      },
    });
    await (prisma as any).agentToolRun?.create?.({
      data: {
        id: toolRunId,
        toolId: input.definition.id,
        userId,
        actorId: input.actorUserId || input.actor.userId,
        actorDisplayName: input.actor.displayName,
        actorRoles: input.actor.roles,
        sessionId: input.sessionId,
        requestSource: input.requestSource || 'dev',
        approvalId: input.approvalId,
        status: input.status,
        input: input.toolInput,
        output: input.output as any,
        error: input.error,
        risk: input.definition.risk,
        startedAt: input.startedAt,
        completedAt: new Date(),
      },
    });
    await recordAuditLog(prisma, {
      userId,
      actor: input.actor,
      actorUserId: input.actorUserId,
      definition: input.definition,
      status: input.status,
      sessionId: input.sessionId,
      requestSource: input.requestSource || 'dev',
      approvalId: input.approvalId,
      error: input.error,
    });
    return toolRunId;
  } catch (error: any) {
    logger.error(`[agent-tool-run] failed to record ${input.definition.id}`, { error: error?.message || String(error) });
    return undefined;
  }
}

async function recordAuditLog(
  prisma: PrismaClient,
  input: {
    userId: string | null;
    actor: ActorContext;
    actorUserId?: string;
    definition: ToolDefinition;
    status: 'success' | 'failed' | 'approval_required';
    sessionId?: string;
    requestSource: string;
    approvalId?: string;
    error?: string;
  },
) {
  if (!input.userId) return;
  try {
    await (prisma as any).auditLog?.create?.({
      data: {
        id: `alog_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        actorId: input.userId,
        action: `agent_tool_${input.status}`,
        targetType: 'AgentTool',
        targetId: input.definition.id,
        detail: {
          toolId: input.definition.id,
          scope: input.definition.scope,
          risk: input.definition.risk,
          sessionId: input.sessionId,
          requestSource: input.requestSource,
          approvalId: input.approvalId,
          actorId: input.actorUserId || input.actor.userId,
          actorDisplayName: input.actor.displayName,
          actorRoles: input.actor.roles,
          error: input.error,
        },
      },
    });
  } catch {
    // AuditLog is secondary to AgentToolRun. Tool execution should not fail if
    // the generic audit sink is temporarily unavailable.
  }
}

function formatToolResult(definition: ToolDefinition, call: PlannedToolCall, output: unknown) {
  const lines = [
    `tool_id = ${definition.id}`,
    `tool_scope = ${definition.scope}`,
    `tool_risk = ${definition.risk}`,
    `tool_reason = ${call.reason}`,
    `input = ${JSON.stringify(call.input)}`,
  ];

  if (definition.id === 'products.count' && output && typeof output === 'object') {
    const result = output as any;
    lines.push(
      `output.data_source = ${result.dataSource || 'unknown'}`,
      `output.ProductAsset.total_count = ${result.totalCount}`,
      `output.Fabric.total_count = ${result.fabricCount}`,
      `output.Garment.total_count = ${result.garmentCount}`,
      `output.Trimming.total_count = ${result.trimmingCount}`,
      '这些是 Bambook 后端工具执行结果，不是本轮文本检索样本数量。',
    );
    return lines.join('; ');
  }

  if (definition.id === 'dictionary.query' && output && typeof output === 'object') {
    const result = output as any;
    lines.push(
      `output.data_source = ${result.dataSource || 'unknown'}`,
      `output.dictionary = ${result.dictionary || ''}`,
      `output.query = ${result.query || ''}`,
      `output.count = ${result.count ?? 0}`,
      `output.items = ${JSON.stringify(result.items || [])}`,
      '这是 Bambook 后端业务字典查询结果；如果唯一命中，可以继续用标准 id 查询业务记录。',
    );
    return lines.join('; ');
  }

  if (definition.id === 'records.query' && output && typeof output === 'object') {
    const result = output as any;
    lines.push(
      `output.data_source = ${result.dataSource || 'unknown'}`,
      `output.entity = ${result.entity || ''}`,
      `output.aggregate = ${result.aggregate || ''}`,
      `output.count = ${result.count ?? ''}`,
      `output.filters = ${JSON.stringify(result.filters || {})}`,
      result.items ? `output.items = ${JSON.stringify(result.items)}` : '',
      '这是 Bambook 后端业务记录查询结果；aggregate=count 时 count 是匹配记录总数。',
    );
    return lines.filter(Boolean).join('; ');
  }

  if (definition.id === 'products.query' && output && typeof output === 'object') {
    const result = output as any;
    lines.push(
      `output.data_source = ${result.dataSource || 'unknown'}`,
      `output.total = ${result.total ?? ''}`,
      `output.count = ${result.count ?? 0}`,
      `output.filters = ${JSON.stringify(result.filters || {})}`,
      `output.sort = ${JSON.stringify(result.sort || {})}`,
      `output.items = ${JSON.stringify(result.items || [])}`,
      '这是 Bambook 后端按结构化筛选条件查询数字档案的结果；total 是匹配全量数量，items 是本页展开记录。',
    );
    return lines.join('; ');
  }

  if (definition.id === 'products.describe_schema' && output && typeof output === 'object') {
    const result = output as any;
    lines.push(
      `output.entity = ${result.entity}`,
      `output.fields = ${JSON.stringify(result.fields || [])}`,
      `output.sortable_fields = ${JSON.stringify(result.sortableFields || [])}`,
      `output.query_tool = ${JSON.stringify(result.tools?.query || {})}`,
      `output.write_path = ${result.writePath || ''}`,
      '这是 Bambook 后端暴露给 Agent 的数字档案字段能力清单，不是模型臆测。',
    );
    return lines.join('; ');
  }

  if (definition.id === 'products.get' && output && typeof output === 'object') {
    const result = output as any;
    if (result.found && result.item) {
      lines.push(
        `output.data_source = ${result.dataSource || 'unknown'}`,
        `output.found = true`,
        `output.match_type = ${result.matchType}`,
        `output.identifier = ${result.identifier}`,
        `output.full_record = ${JSON.stringify(result.item)}`,
        '这是 Bambook 后端按唯一标识读取的完整数字档案。',
      );
      return lines.join('; ');
    }
    lines.push(
      `output.data_source = ${result.dataSource || 'unknown'}`,
      `output.found = false`,
      `output.match_type = ${result.matchType || ''}`,
      `output.identifier = ${result.identifier || ''}`,
      result.ambiguous ? 'output.ambiguous = true' : 'output.ambiguous = false',
      `output.candidates = ${JSON.stringify(result.candidates || [])}`,
      '未唯一命中完整数字档案；只能返回候选，不能猜测具体档案。',
    );
    return lines.join('; ');
  }

  if (definition.id === 'products.expand' && output && typeof output === 'object') {
    const result = output as any;
    lines.push(
      `output.data_source = ${result.dataSource || 'unknown'}`,
      `output.found = ${Boolean(result.found)}`,
      `output.include = ${JSON.stringify(result.include || [])}`,
      `output.product = ${JSON.stringify(result.product || null)}`,
      `output.profile = ${JSON.stringify(result.profile || null)}`,
      `output.pricing = ${JSON.stringify(result.pricing || [])}`,
      `output.certifications = ${JSON.stringify(result.certifications || [])}`,
      `output.composition = ${JSON.stringify(result.composition || [])}`,
      `output.images = ${JSON.stringify(result.images || [])}`,
      `output.customer_codes = ${JSON.stringify(result.customerCodes || [])}`,
      `output.relations = ${JSON.stringify(result.relations || [])}`,
      '这是 Bambook 后端数字档案上下文展开结果；include 控制展开 profile/pricing/certifications/composition/images/customerCodes/relations。',
    );
    return lines.join('; ');
  }

  if (definition.id === 'orders.expand' && output && typeof output === 'object') {
    const result = output as any;
    lines.push(
      `output.data_source = ${result.dataSource || 'unknown'}`,
      `output.found = ${Boolean(result.found)}`,
      `output.include = ${JSON.stringify(result.include || [])}`,
      `output.summary = ${JSON.stringify(result.summary || null)}`,
      `output.lines = ${JSON.stringify(result.lines || [])}`,
      `output.parties = ${JSON.stringify(result.parties || null)}`,
      `output.dates = ${JSON.stringify(result.dates || null)}`,
      `output.invoices = ${JSON.stringify(result.invoices || null)}`,
      `output.samples = ${JSON.stringify(result.samples || null)}`,
      `output.production = ${JSON.stringify(result.production || null)}`,
      `output.missing_fields = ${JSON.stringify(result.missingFields || [])}`,
      `output.currencies = ${JSON.stringify(result.currencies || null)}`,
      '这是 Bambook 后端订单上下文展开结果；include 控制展开 summary/lines/parties/dates/invoices/samples/production/missingFields/currencies。',
    );
    return lines.join('; ');
  }

  if (definition.id === 'relations.expand' && output && typeof output === 'object') {
    const result = output as any;
    lines.push(
      `output.data_source = ${result.dataSource || 'unknown'}`,
      `output.found = ${Boolean(result.found)}`,
      `output.include = ${JSON.stringify(result.include || [])}`,
      `output.organization = ${JSON.stringify(result.organization || null)}`,
      `output.lookup = ${JSON.stringify(result.lookup || {})}`,
      `output.profile_contacts = ${JSON.stringify(result.profileContacts || [])}`,
      `output.people_count = ${result.people?.length ?? 0}`,
      `output.people = ${JSON.stringify(result.people || [])}`,
      '这是 Bambook 后端关系上下文展开结果；profile_contacts 来自公司档案字段，people 来自 Relation.isOrganization=false 的人物记录。',
    );
    return lines.join('; ');
  }

  lines.push(`output = ${JSON.stringify(output)}`);
  return lines.join('; ');
}

function formatProductAsset(product: any) {
  const fabric = product.fabricProfile || {};
  const customerCodes = Array.isArray(product.fabricCustomerCodes)
    ? product.fabricCustomerCodes.map((code: any) => code.clientCode || code.customerNameSnapshot).filter(Boolean)
    : [];
  const composition = Array.isArray(product.compositionLines)
    ? product.compositionLines.map((line: any) => {
      const term = line.term?.labelZh || line.term?.labelEn || line.fiberName || line.termId;
      return [term, line.percentage != null ? `${line.percentage}%` : ''].filter(Boolean).join(' ');
    }).filter(Boolean)
    : [];

  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    mainCategory: product.mainCategory,
    subCategoryId: product.subCategoryId,
    season: product.season,
    status: product.status,
    articleNo: fabric.articleNo,
    millQuality: fabric.millQuality,
    millColorCode: fabric.millColorCode,
    colorDescription: fabric.colorDescription,
    construction: fabric.construction,
    weight: fabric.weightValue != null ? `${fabric.weightValue} ${fabric.weightUnit || ''}`.trim() : undefined,
    width: fabric.widthValue != null ? `${fabric.widthValue} ${fabric.widthUnit || ''}`.trim() : fabric.widthText,
    stockStatus: fabric.stockStatus,
    moq: fabric.moqValue,
    riskNote: fabric.riskNote,
    specialNote: fabric.specialNote,
    customerCodes,
    composition,
  };
}

function formatFullProductAsset(product: any) {
  return compactObject({
    id: product.id,
    sku: product.sku,
    name: product.name,
    mainCategory: product.mainCategory,
    subCategoryId: product.subCategoryId,
    season: product.season,
    techPackUrl: product.techPackUrl,
    imageUrl: product.imageUrl,
    cost: product.cost,
    status: product.status,
    updatedAt: product.updatedAt,
    fabricProfile: product.fabricProfile,
    garmentProfile: product.garmentProfile,
    trimmingProfile: product.trimmingProfile,
    fabricCustomerCodes: product.fabricCustomerCodes,
    fabricPrices: product.fabricPrices,
    fabricCertifications: product.fabricCertifications,
    compositionLines: product.compositionLines?.map((line: any) => ({
      ...line,
      term: line.term,
    })),
    images: product.images,
  });
}

type AgentDataApiConfig = {
  baseUrl: string;
  apiKey?: string;
};

function getAgentDataApiConfig(): AgentDataApiConfig | null {
  const raw = String(process.env.BAMBOOK_AGENT_DATA_API_BASE || '').trim().replace(/\/$/, '');
  if (!raw) return null;
  return {
    baseUrl: raw,
    apiKey: String(process.env.BAMBOOK_AGENT_DATA_API_KEY || process.env.BAMBOOK_API_KEY || process.env.VITE_BAMBOOK_API_KEY || '').trim() || undefined,
  };
}

async function fetchRemoteProductAssets(config: AgentDataApiConfig, input: {
  mainCategory?: string;
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const url = new URL(`${config.baseUrl}/v1/products/assets`);
  if (input.mainCategory) url.searchParams.set('mainCategory', input.mainCategory);
  if (input.search) url.searchParams.set('search', input.search);
  url.searchParams.set('limit', String(Math.min(Math.max(input.limit || 10, 1), 500)));
  url.searchParams.set('offset', String(Math.max(input.offset || 0, 0)));
  const data = await fetchRemoteJson(config, url);
  return {
    assets: Array.isArray(data.assets) ? data.assets : [],
    total: Number(data.total || 0),
    limit: Number(data.limit || input.limit || 10),
    offset: Number(data.offset || input.offset || 0),
    hasMore: Boolean(data.hasMore),
  };
}

async function fetchRemoteProductAssetQuery(config: AgentDataApiConfig, input: ReturnType<typeof normalizeProductQueryInput> & {
  entity: string;
  aggregate: 'count' | 'list';
}) {
  const url = new URL(`${config.baseUrl}/v1/products/assets/query`);
  const data = await fetchRemoteJson(config, url, {
    method: 'POST',
    body: JSON.stringify({
      entity: input.entity,
      aggregate: input.aggregate,
      query: input.query,
      mainCategory: input.mainCategory,
      filters: input.filters,
      sort: input.sort,
      limit: input.limit,
      offset: input.offset,
    }),
  });
  return {
    assets: Array.isArray(data.assets) ? data.assets : Array.isArray(data.items) ? data.items : [],
    total: Number(data.total ?? data.count ?? 0),
    count: Number(data.count ?? data.total ?? 0),
    limit: Number(data.limit || input.limit || 10),
    offset: Number(data.offset || input.offset || 0),
    hasMore: Boolean(data.hasMore),
  };
}

async function fetchRemoteProductAsset(config: AgentDataApiConfig, id: string) {
  const url = new URL(`${config.baseUrl}/v1/products/assets/${encodeURIComponent(id)}`);
  const data = await fetchRemoteJson(config, url);
  return data.asset || null;
}

async function fetchRemoteProductCategories(config: AgentDataApiConfig) {
  const url = new URL(`${config.baseUrl}/product-categories`);
  const data = await fetchRemoteJson(config, url);
  return Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : [];
}

async function fetchRemoteDataCenter(config: AgentDataApiConfig, path: string, init: RequestInit = {}) {
  const url = new URL(`${config.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
  const data = await fetchRemoteJson(config, url, init);
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return { dataSource: 'bambook-data-center', ...data };
  }
  return { dataSource: 'bambook-data-center', value: data };
}

async function fetchRemoteJson(config: AgentDataApiConfig, url: URL, init: RequestInit = {}) {
  const headers: Record<string, string> = {};
  if (config.apiKey) headers['X-Bambook-API-Key'] = config.apiKey;
  if (init.body) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> || {}) } });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.message || data?.error || `Bambook data center API failed with ${response.status}`);
  }
  return data;
}

function remoteProductMatchesLookup(item: any, lookup: { type: string; value: string }) {
  const value = lookup.value.toLowerCase();
  const fabric = item.fabricProfile || {};
  if (lookup.type === 'sku') return String(item.sku || '').toLowerCase() === value;
  if (lookup.type === 'articleNo') {
    return [fabric.articleNo, fabric.millQuality].some(candidate => String(candidate || '').toLowerCase() === value);
  }
  if (lookup.type === 'styleNo') return String(item.garmentProfile?.styleNo || '').toLowerCase() === value;
  if (lookup.type === 'trimmingCode') return String(item.trimmingProfile?.trimmingCode || '').toLowerCase() === value;
  if (lookup.type === 'id') return String(item.id || '').toLowerCase() === value;
  return false;
}

function fullProductAssetInclude() {
  return {
    fabricProfile: true,
    garmentProfile: true,
    trimmingProfile: true,
    fabricCustomerCodes: { where: { deletedAt: null } },
    fabricPrices: { where: { deletedAt: null }, orderBy: { updatedAt: 'desc' as const } },
    fabricCertifications: { where: { deletedAt: null } },
    compositionLines: {
      where: { deletedAt: null },
      include: { term: true },
      orderBy: { sortOrder: 'asc' as const },
    },
    images: {
      where: { deletedAt: null },
      orderBy: { sortOrder: 'asc' as const },
    },
  };
}

function normalizeProductLookup(input: Record<string, unknown>) {
  const typedValue = cleanIdentifier(input.value);
  const typedType = cleanIdentifier(input.type);
  if (typedValue && typedType) return { type: typedType, value: typedValue };
  const id = cleanIdentifier(input.id);
  if (id) return { type: 'id', value: id };
  const sku = cleanIdentifier(input.sku);
  if (sku) return { type: 'sku', value: sku };
  const articleNo = cleanIdentifier(input.articleNo);
  if (articleNo) return { type: 'articleNo', value: articleNo };
  const styleNo = cleanIdentifier(input.styleNo);
  if (styleNo) return { type: 'styleNo', value: styleNo };
  const trimmingCode = cleanIdentifier(input.trimmingCode);
  if (trimmingCode) return { type: 'trimmingCode', value: trimmingCode };
  const query = cleanIdentifier(input.query);
  return query ? extractProductLookup(query) : null;
}

function extractProductQueryInput(query: string, normalizedQuery: string) {
  const filters: Record<string, unknown> = {};
  const certifications = extractCertifications(query);
  if (certifications.length) filters.certifications = certifications;
  const stockStatus = extractStockStatus(query);
  if (stockStatus) filters.stockStatus = stockStatus;
  const supplier = extractValueAfterLabels(query, ['供应商', '工厂', '厂家', 'mill', 'supplier']);
  if (supplier) filters.supplier = supplier;
  const color = extractValueAfterLabels(query, ['颜色', '色号', 'color', 'colour']);
  if (color) filters.color = color;
  const compositionTerms = extractCompositionTerms(query);
  if (compositionTerms.length) filters.compositionTerms = compositionTerms;
  const weight = extractWeightRange(query);
  if (weight.weightMin != null) filters.weightMin = weight.weightMin;
  if (weight.weightMax != null) filters.weightMax = weight.weightMax;

  return {
    query: cleanProductFreeText(query),
    mainCategory: normalizedQuery.includes('辅料') || normalizedQuery.includes('trimming') ? 'Trimmings' : 'Fabric',
    filters,
    sort: extractProductSort(query, normalizedQuery),
    limit: extractLimit(query, 10),
    offset: 0,
  };
}

function extractProductSubcategoryCountQuery(query: string) {
  if (/(系统里|全部|全库|面料库|数字档案|产品库).{0,8}(一共|总共|多少|几条|数量)/.test(query)) {
    return '';
  }
  const direct = query.match(/([\u4e00-\u9fa5A-Za-z0-9/_ -]{2,40}?面料)\s*(?:一共|总共|有多少|多少|几条|几个|数量)/);
  const candidate = cleanCategoryQuery(direct?.[1] || query.split(/一共|总共|有多少|多少|几条|几个|数量/)[0]);
  if (!candidate || !candidate.includes('面料')) return '';
  if (candidate === '面料' || candidate === '面料信息') return '';
  return candidate;
}

function dictionaryQueryTerms(query: string) {
  const terms = new Set<string>();
  const cleaned = cleanCategoryQuery(query);
  if (cleaned) terms.add(cleaned);
  const withoutGenericSuffix = cleaned
    .replace(/(面料|产品|档案|分类|子分类|品类)$/g, '')
    .trim();
  if (withoutGenericSuffix.length >= 2) terms.add(withoutGenericSuffix);
  for (const word of splitQueryWords(cleaned)) {
    const normalized = word.replace(/(面料|产品|档案|分类|子分类|品类)$/g, '').trim();
    if (normalized.length >= 2) terms.add(normalized);
  }
  return Array.from(terms).slice(0, 8);
}

function cleanCategoryQuery(value: unknown) {
  return cleanIdentifier(value)
    .replace(/^(帮我|请|查询|查一下|查|统计|看一下|我想知道|需要)/, '')
    .replace(/(的|有)$/g, '')
    .trim();
}

function normalizeProductQueryInput(input: Record<string, unknown>) {
  const filters = typeof input.filters === 'object' && input.filters ? input.filters as Record<string, unknown> : {};
  const sort = typeof input.sort === 'object' && input.sort ? input.sort as Record<string, unknown> : {};
  return {
    query: cleanIdentifier(input.query),
    mainCategory: cleanIdentifier(input.mainCategory) || undefined,
    filters: {
      certifications: arrayOfCleanStrings(filters.certifications),
      stockStatus: cleanIdentifier(filters.stockStatus),
      supplier: cleanIdentifier(filters.supplier),
      color: cleanIdentifier(filters.color),
      compositionTerms: arrayOfCleanStrings(filters.compositionTerms),
      weightMin: finiteNumber(filters.weightMin),
      weightMax: finiteNumber(filters.weightMax),
      fieldFilters: normalizeFieldFilters(filters.fieldFilters),
    },
    sort: {
      field: cleanIdentifier(sort.field) || 'updatedAt',
      direction: cleanIdentifier(sort.direction).toLowerCase() === 'asc' ? 'asc' : 'desc',
    },
    limit: numberInput(input.limit, 10),
    offset: Math.max(0, Math.floor(Number(input.offset || 0) || 0)),
  };
}

function buildProductQueryWhere(input: ReturnType<typeof normalizeProductQueryInput>) {
  const and: any[] = [{ deletedAt: null }];
  if (input.mainCategory) {
    and.push({ mainCategory: { contains: input.mainCategory, mode: 'insensitive' as const } });
  }
  if (input.query) {
    and.push({
      OR: [
        ...productCandidateWhere(input.query),
        { fabricCustomerCodes: { some: { deletedAt: null, clientCode: { contains: input.query, mode: 'insensitive' as const } } } },
        { fabricCustomerCodes: { some: { deletedAt: null, customerNameSnapshot: { contains: input.query, mode: 'insensitive' as const } } } },
        { fabricCertifications: { some: { deletedAt: null, certification: { contains: input.query, mode: 'insensitive' as const } } } },
        { compositionLines: { some: { deletedAt: null, term: { is: { abbreviation: { contains: input.query, mode: 'insensitive' as const } } } } } },
        { compositionLines: { some: { deletedAt: null, term: { is: { chineseName: { contains: input.query, mode: 'insensitive' as const } } } } } },
        { compositionLines: { some: { deletedAt: null, term: { is: { englishName: { contains: input.query, mode: 'insensitive' as const } } } } } },
      ],
    });
  }
  for (const certification of input.filters.certifications) {
    and.push({ fabricCertifications: { some: { deletedAt: null, certification: { contains: certification, mode: 'insensitive' as const } } } });
  }
  if (input.filters.stockStatus) {
    and.push({
      OR: [
        { status: { contains: input.filters.stockStatus, mode: 'insensitive' as const } },
        { fabricProfile: { is: { stockStatus: { contains: input.filters.stockStatus, mode: 'insensitive' as const } } } },
        { trimmingProfile: { is: { stockStatus: { contains: input.filters.stockStatus, mode: 'insensitive' as const } } } },
      ],
    });
  }
  if (input.filters.supplier) {
    and.push({
      OR: [
        { fabricProfile: { is: { millOrganizationId: { contains: input.filters.supplier, mode: 'insensitive' as const } } } },
        { trimmingProfile: { is: { supplier: { contains: input.filters.supplier, mode: 'insensitive' as const } } } },
        { trimmingProfile: { is: { factory: { contains: input.filters.supplier, mode: 'insensitive' as const } } } },
      ],
    });
  }
  if (input.filters.color) {
    and.push({
      OR: [
        { fabricProfile: { is: { millColorCode: { contains: input.filters.color, mode: 'insensitive' as const } } } },
        { fabricProfile: { is: { colorDescription: { contains: input.filters.color, mode: 'insensitive' as const } } } },
        { trimmingProfile: { is: { color: { contains: input.filters.color, mode: 'insensitive' as const } } } },
        { trimmingProfile: { is: { colorCode: { contains: input.filters.color, mode: 'insensitive' as const } } } },
      ],
    });
  }
  for (const term of input.filters.compositionTerms) {
    and.push({
      compositionLines: {
        some: {
          deletedAt: null,
          term: {
            is: {
              OR: [
                { abbreviation: { contains: term, mode: 'insensitive' as const } },
                { chineseName: { contains: term, mode: 'insensitive' as const } },
                { englishName: { contains: term, mode: 'insensitive' as const } },
              ],
            },
          },
        },
      },
    });
  }
  const weightWhere: any = {};
  if (input.filters.weightMin != null) weightWhere.gte = input.filters.weightMin;
  if (input.filters.weightMax != null) weightWhere.lte = input.filters.weightMax;
  if (Object.keys(weightWhere).length) {
    // 克重区间统一按归一化 g/m²（weightValueGsm）过滤
    and.push({ fabricProfile: { is: { weightValueGsm: weightWhere } } });
  }
  for (const filter of input.filters.fieldFilters) {
    const where = productFieldFilterWhere(filter);
    if (where) and.push(where);
  }
  return and.length === 1 ? and[0] : { AND: and };
}

function productQueryOrderBy(sort: { field: string; direction: string }) {
  const direction = sort.direction === 'asc' ? 'asc' as const : 'desc' as const;
  if (sort.field === 'sku') return { sku: direction };
  if (sort.field === 'name') return { name: direction };
  return { updatedAt: direction };
}

function normalizeFieldFilters(value: unknown) {
  const items = Array.isArray(value) ? value : [];
  return items.map((item: any) => ({
    path: cleanIdentifier(item?.path),
    operator: normalizeOperator(item?.operator),
    value: item?.value,
  })).filter(item => item.path && item.value !== undefined && item.value !== null && item.value !== '').slice(0, 12);
}

function normalizeOperator(value: unknown) {
  const operator = cleanIdentifier(value).toLowerCase();
  if (operator === 'equals' || operator === 'gte' || operator === 'lte') return operator;
  return 'contains';
}

function productFieldFilterWhere(filter: { path: string; operator: string; value: unknown }) {
  const definition = PRODUCT_FIELD_DEFINITIONS.find(field => field.path === filter.path && field.filterable);
  if (!definition || !definition.operators.includes(filter.operator as any)) return null;
  const value = definition.type === 'number' ? finiteNumber(filter.value) : cleanIdentifier(filter.value);
  if (value === undefined || value === '') return null;
  const scalar = fieldScalarCondition(definition, filter.operator, value);

  switch (filter.path) {
    case 'sku':
    case 'name':
    case 'mainCategory':
    case 'subCategoryId':
    case 'season':
    case 'status':
    case 'updatedAt':
      return { [filter.path]: scalar };
    case 'fabric.articleNo':
      return { fabricProfile: { is: { articleNo: scalar } } };
    case 'fabric.millQuality':
      return { fabricProfile: { is: { millQuality: scalar } } };
    case 'fabric.millOrganizationId':
      return { fabricProfile: { is: { millOrganizationId: scalar } } };
    case 'fabric.millColorCode':
      return { fabricProfile: { is: { millColorCode: scalar } } };
    case 'fabric.colorDescription':
      return { fabricProfile: { is: { colorDescription: scalar } } };
    case 'fabric.construction':
      return { fabricProfile: { is: { construction: scalar } } };
    case 'fabric.yarnCount':
      return { fabricProfile: { is: { yarnCount: scalar } } };
    case 'fabric.pattern':
      return { fabricProfile: { is: { pattern: scalar } } };
    case 'fabric.weightValue':
      return { fabricProfile: { is: { weightValue: scalar } } };
    case 'fabric.weightUnit':
      return { fabricProfile: { is: { weightUnit: scalar } } };
    case 'fabric.widthValue':
      return { fabricProfile: { is: { widthValue: scalar } } };
    case 'fabric.widthText':
      return { fabricProfile: { is: { widthText: scalar } } };
    case 'fabric.stockStatus':
      return { fabricProfile: { is: { stockStatus: scalar } } };
    case 'fabric.stockQuantity':
      return { fabricProfile: { is: { stockQuantity: scalar } } };
    case 'fabric.moqValue':
      return { fabricProfile: { is: { moqValue: scalar } } };
    case 'fabric.riskNote':
      return { fabricProfile: { is: { riskNote: scalar } } };
    case 'fabric.specialNote':
      return { fabricProfile: { is: { specialNote: scalar } } };
    case 'fabric.certification':
      return { fabricCertifications: { some: { deletedAt: null, certification: scalar } } };
    case 'fabric.customerCode':
      return {
        fabricCustomerCodes: {
          some: {
            deletedAt: null,
            OR: [{ clientCode: scalar }, { customerNameSnapshot: scalar }],
          },
        },
      };
    case 'fabric.compositionTerm':
      return {
        compositionLines: {
          some: {
            deletedAt: null,
            term: {
              is: {
                OR: [{ abbreviation: scalar }, { chineseName: scalar }, { englishName: scalar }],
              },
            },
          },
        },
      };
    case 'fabric.compositionPercentage':
      return { compositionLines: { some: { deletedAt: null, percentage: scalar } } };
    case 'fabric.priceAmount':
      return { fabricPrices: { some: { deletedAt: null, amount: scalar } } };
    case 'fabric.priceType':
      return { fabricPrices: { some: { deletedAt: null, priceType: scalar } } };
    case 'garment.styleNo':
      return { garmentProfile: { is: { styleNo: scalar } } };
    case 'garment.customer':
      return { garmentProfile: { is: { customer: scalar } } };
    case 'garment.brand':
      return { garmentProfile: { is: { brand: scalar } } };
    case 'garment.factory':
      return { garmentProfile: { is: { factory: scalar } } };
    case 'trimming.trimmingCode':
      return { trimmingProfile: { is: { trimmingCode: scalar } } };
    case 'trimming.trimmingName':
      return { trimmingProfile: { is: { trimmingName: scalar } } };
    case 'trimming.supplier':
      return { trimmingProfile: { is: { supplier: scalar } } };
    case 'trimming.stockStatus':
      return { trimmingProfile: { is: { stockStatus: scalar } } };
    default:
      return null;
  }
}

function fieldScalarCondition(definition: ProductFieldDefinition, operator: string, value: string | number) {
  if (definition.type === 'number') {
    if (operator === 'gte') return { gte: value };
    if (operator === 'lte') return { lte: value };
    return value;
  }
  if (operator === 'equals') return { equals: String(value), mode: 'insensitive' as const };
  return { contains: String(value), mode: 'insensitive' as const };
}

function productExactWhere(lookup: { type: string; value: string }) {
  const value = lookup.value;
  const textEquals = { equals: value, mode: 'insensitive' as const };
  if (lookup.type === 'id') return [{ id: value }];
  if (lookup.type === 'sku') return [{ sku: textEquals }];
  if (lookup.type === 'styleNo') return [{ garmentProfile: { is: { styleNo: textEquals } } }];
  if (lookup.type === 'trimmingCode') return [{ trimmingProfile: { is: { trimmingCode: textEquals } } }];
  if (lookup.type === 'articleNo') {
    return [
      { fabricProfile: { is: { articleNo: textEquals } } },
      { fabricProfile: { is: { millQuality: textEquals } } },
    ];
  }
  return productCandidateWhere(value);
}

function productCandidateWhere(value: string) {
  const textContains = { contains: value, mode: 'insensitive' as const };
  return [
    { id: value },
    { sku: textContains },
    { name: textContains },
    { fabricProfile: { is: { articleNo: textContains } } },
    { fabricProfile: { is: { millQuality: textContains } } },
    { fabricProfile: { is: { millColorCode: textContains } } },
    { garmentProfile: { is: { styleNo: textContains } } },
    { garmentProfile: { is: { productName: textContains } } },
    { trimmingProfile: { is: { trimmingCode: textContains } } },
    { trimmingProfile: { is: { trimmingName: textContains } } },
  ];
}

function extractProductLookup(query: string): { type: string; value: string } | null {
  const patterns: Array<[string, RegExp]> = [
    ['sku', /\bSKU[:：#]?\s*([A-Za-z0-9._-]{3,})\b/i],
    ['sku', /(?:品号|编号|档案号)[:：#]?\s*([A-Za-z0-9._-]{3,})/i],
    ['articleNo', /(?:Article|article|面料号|面料编号)[:：#]?\s*([A-Za-z0-9._/-]{3,})/i],
    ['styleNo', /(?:style|Style|款号)[:：#]?\s*([A-Za-z0-9._/-]{3,})/i],
    ['trimmingCode', /(?:辅料编码|辅料编号)[:：#]?\s*([A-Za-z0-9._/-]{3,})/i],
    ['id', /\b(ProductAsset|productAsset|id|ID)[:：#]?\s*([A-Za-z0-9._-]{6,})\b/i],
  ];
  for (const [type, pattern] of patterns) {
    const match = query.match(pattern);
    const value = cleanIdentifier(match?.[2] || match?.[1]);
    if (isPlausibleProductLookupValue(type, value)) return { type, value };
  }
  const standaloneSku = query.match(/\b\d{6,}\b/);
  return standaloneSku ? { type: 'sku', value: standaloneSku[0] } : null;
}

function isPlausibleProductLookupValue(type: string, value: string) {
  if (!value) return false;
  const normalized = value.toLowerCase().replace(/[.#:：]+$/g, '');
  const fieldNameWords = new Set([
    'number',
    'no',
    'name',
    'and',
    'field',
    'fields',
    'article',
    'sku',
    'style',
    'id',
    'code',
    'value',
    'article number',
    'article no',
  ]);
  if (fieldNameWords.has(normalized)) return false;
  if (/^(名称|名字|字段|编号|号码|和|以及|列表|档案|信息)$/.test(value)) return false;
  if (/[\u4e00-\u9fa5]/.test(value)) return false;
  if (type === 'id') return value.length >= 6;
  if (/\d/.test(value) || /[._/-]/.test(value)) return value.length >= 3;
  return /^[A-Za-z]{6,}$/.test(value);
}

function extractCertifications(query: string) {
  const certifications = new Set<string>();
  const known = ['RWS', 'GOTS', 'GRS', 'OCS', 'OEKO', 'OEKO-TEX', 'BCI', 'FSC', 'RCS', 'WRAP', 'BSCI'];
  for (const item of known) {
    if (new RegExp(`\\b${escapeRegExp(item)}\\b`, 'i').test(query)) certifications.add(item);
  }
  for (const match of query.matchAll(/([A-Za-z][A-Za-z0-9-]{1,16})\s*(?:认证|证书|certification|certified)/gi)) {
    const value = cleanIdentifier(match[1]).toUpperCase();
    if (value && !['CERTIFICATION', 'CERTIFIED'].includes(value)) certifications.add(value);
  }
  return Array.from(certifications);
}

function extractStockStatus(query: string) {
  const match = query.match(/(?:库存状态|现货状态|状态)[:：]?\s*([\u4e00-\u9fa5A-Za-z0-9_-]{1,20})/i);
  if (match?.[1]) return cleanIdentifier(match[1]);
  if (/现货|有库存|in\s*stock/i.test(query)) return '现货';
  if (/通过|active|approved/i.test(query)) return '通过';
  if (/草稿|draft/i.test(query)) return '草稿';
  if (/开发|development/i.test(query)) return 'Development';
  return '';
}

function extractCompositionTerms(query: string) {
  const terms = new Set<string>();
  const dictionary: Array<[RegExp, string]> = [
    [/羊毛|wool|\bW\b/i, 'Wool'],
    [/羊绒|cashmere|\bWS\b/i, 'Cashmere'],
    [/棉|cotton|\bC\b/i, 'Cotton'],
    [/涤|聚酯|polyester|\bP\b/i, 'Polyester'],
    [/再生|recycled/i, 'Recycled'],
    [/尼龙|锦纶|nylon|\bN\b/i, 'Nylon'],
    [/氨纶|弹力|spandex|elastane|pu\b/i, 'PU'],
    [/麻|linen|flax/i, 'Linen'],
    [/真丝|silk/i, 'Silk'],
  ];
  for (const [pattern, term] of dictionary) {
    if (pattern.test(query)) terms.add(term);
  }
  return Array.from(terms);
}

function extractWeightRange(query: string) {
  const result: { weightMin?: number; weightMax?: number } = {};
  const between = query.match(/克重.*?(\d+(?:\.\d+)?)\s*(?:-|到|至|~)\s*(\d+(?:\.\d+)?)/);
  if (between) {
    result.weightMin = Number(between[1]);
    result.weightMax = Number(between[2]);
    return result;
  }
  const min = query.match(/克重.*?(\d+(?:\.\d+)?)\s*(?:以上|起|大于|>=)/);
  if (min) result.weightMin = Number(min[1]);
  const max = query.match(/克重.*?(\d+(?:\.\d+)?)\s*(?:以下|以内|小于|<=)/);
  if (max) result.weightMax = Number(max[1]);
  return result;
}

function extractProductSort(query: string, normalizedQuery: string) {
  const direction = /升序|从小到大|最早|asc/i.test(query) ? 'asc' : 'desc';
  if (/时间|更新|最近|最新|updated/i.test(normalizedQuery)) return { field: 'updatedAt', direction };
  if (/(?:按|按照|排序|sort\s+by).{0,8}(sku|品号|编号)|(sku|品号|编号).{0,8}(排序|升序|降序|asc|desc)/i.test(query)) {
    return { field: 'sku', direction };
  }
  if (/(?:按|按照|排序|sort\s+by).{0,8}(名称|名字|name)|(名称|名字|name).{0,8}(排序|升序|降序|asc|desc)/i.test(query)) {
    return { field: 'name', direction };
  }
  return { field: 'updatedAt', direction: 'desc' };
}

function extractValueAfterLabels(query: string, labels: string[]) {
  for (const label of labels) {
    const pattern = new RegExp(`${escapeRegExp(label)}[:：]?\\s*([\\u4e00-\\u9fa5A-Za-z0-9._#/-]{2,40})`, 'i');
    const match = query.match(pattern);
    const value = cleanIdentifier(match?.[1]);
    if (value && !['的', '是', '为'].includes(value)) return value;
  }
  return '';
}

function cleanProductFreeText(query: string) {
  return query
    .replace(/前?\s*\d+\s*(条|个|项|款|records?|items?)/gi, ' ')
    .replace(/\b(article\s*(number|no\.?)?|mill\s*quality|name|sku|fields?)\b/gi, ' ')
    .replace(/(查询|查找|找|筛选|列出|给我|帮我|面料|产品|数字档案|认证|证书|按照|按|排序|时间|最新|最近|更新|有|的|里|中)/g, ' ')
    .replace(/(档案|名称|名字|字段|编号|号码|数量|总数|一共|总共|多少|几条|几个|前|条|个|项|和|以及)/g, ' ')
    .replace(/\b(RWS|GOTS|GRS|OCS|OEKO|OEKO-TEX|BCI|FSC|RCS|WRAP|BSCI)\b/gi, ' ')
    .replace(/[，。；;、,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanIdentifier(value: unknown) {
  return String(value || '')
    .trim()
    .replace(/[，。；;、,]+$/g, '')
    .slice(0, 120);
}

function arrayOfCleanStrings(value: unknown) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items.map(cleanIdentifier).filter(Boolean).slice(0, 12);
}

function finiteNumber(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function extractLimit(query: string, fallback: number) {
  const match = query.match(/(?:前|top|limit)\s*(\d{1,3})/i) || query.match(/(\d{1,3})\s*(?:条|个)/);
  return match ? numberInput(match[1], fallback) : fallback;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compactObject(value: any): any {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'bigint') return Number(value);
  if (Prisma.Decimal.isDecimal(value)) return Number(value);
  if (Array.isArray(value)) return value.map(compactObject).filter(item => item !== undefined);
  if (typeof value !== 'object') return value;
  const entries = Object.entries(value)
    .map(([key, item]) => [key, compactObject(item)])
    .filter(([, item]) => item !== undefined);
  return Object.fromEntries(entries);
}

function splitQueryWords(query: string) {
  return query
    .split(/[\s,，。！？!?;；:：]+/)
    .map(word => word.trim())
    .filter(word => word.length >= 2)
    .slice(0, 6);
}

function numberInput(value: unknown, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.min(Math.floor(numeric), 20) : fallback;
}

function isProductCatalogQuery(normalizedQuery: string) {
  return [
    '数字档案',
    '面料库',
    '面料',
    '产品库',
    '产品档案',
    'fabric',
    'fabrics',
    'material library',
    'product archive',
    'product catalog',
  ].some(keyword => normalizedQuery.includes(keyword));
}

function isCountQuery(normalizedQuery: string) {
  return [
    '多少',
    '几条',
    '数量',
    '总数',
    '一共',
    'count',
    'how many',
    'total',
  ].some(keyword => normalizedQuery.includes(keyword));
}

// ---------------------------------------------------------------------------
// Development Management Tool Implementations
// ---------------------------------------------------------------------------

async function queryDevelopmentCases(prisma: PrismaClient, input: Record<string, unknown>) {
  const dc = (prisma as any).developmentCase;
  if (!dc?.findMany) return { dataSource: 'unavailable', count: 0, items: [], reason: 'DEVELOPMENT_CASE_MODEL_UNAVAILABLE' };

  const query = String(input.query || '').trim().toLowerCase();
  const filters = (input.filters || {}) as Record<string, any>;
  const sort = (input.sort || {}) as Record<string, string>;
  const limit = numberInput(input.limit, 20);

  const where: any = { deletedAt: null };
  if (filters.type?.length) where.type = { in: filters.type };
  if (filters.stage?.length) where.stage = { in: filters.stage };
  if (filters.customer) where.customerName = { contains: filters.customer, mode: 'insensitive' };
  if (filters.supplier) where.supplierName = { contains: filters.supplier, mode: 'insensitive' };
  if (filters.owner) where.owner = { contains: filters.owner, mode: 'insensitive' };
  if (filters.priority?.length) where.priority = { in: filters.priority };

  if (query) {
    where.OR = [
      { code: { contains: query, mode: 'insensitive' } },
      { name: { contains: query, mode: 'insensitive' } },
      { customerName: { contains: query, mode: 'insensitive' } },
      { supplierName: { contains: query, mode: 'insensitive' } },
    ];
  }

  const orderBy: any = {};
  const sortField = sort.field || 'createdAt';
  const sortDir = sort.direction || 'desc';
  orderBy[sortField] = sortDir;

  const items = await dc.findMany({ where, orderBy, take: limit });
  return {
    dataSource: 'local-prisma',
    count: items.length,
    items: items.map((item: any) => ({
      id: item.id, code: item.code, name: item.name, type: item.type, stage: item.stage,
      priority: item.priority, owner: item.owner, customerName: item.customerName, supplierName: item.supplierName,
      currentRound: item.currentRound, nextAction: item.nextAction, targetDate: item.targetDate,
      sampleType: item.sampleType, linkedOrderPo: item.linkedOrderPo,
    })),
  };
}

async function getDevelopmentCase(prisma: PrismaClient, input: Record<string, unknown>) {
  const dc = (prisma as any).developmentCase;
  if (!dc?.findFirst) return { found: false, reason: 'MODEL_UNAVAILABLE' };

  const where: any = { deletedAt: null };
  if (input.id) where.id = String(input.id);
  else if (input.code) where.code = String(input.code);
  else return { found: false, reason: 'ID_OR_CODE_REQUIRED' };

  const item = await dc.findFirst({ where });
  if (!item) return { found: false, reason: 'NOT_FOUND' };

  // Serialize BigInts + Decimals
  const out: any = { ...item };
  for (const k of Object.keys(out)) {
    if (typeof out[k] === 'bigint') out[k] = Number(out[k]);
    else if (Prisma.Decimal.isDecimal(out[k])) out[k] = Number(out[k]);
  }
  return { found: true, item: out };
}

async function updateDevelopmentStage(prisma: PrismaClient, input: Record<string, unknown>) {
  const dc = (prisma as any).developmentCase;
  if (!dc?.update) return { ok: false, reason: 'MODEL_UNAVAILABLE' };

  const id = String(input.id || '');
  const stage = String(input.stage || '');
  if (!id || !stage) return { ok: false, reason: 'ID_AND_STAGE_REQUIRED' };

  const result = await mutateDevelopmentStage({
    prisma, caseId: id, stage, actorId: trustedToolActor.getStore() || SYSTEM_AUDIT_ACTOR,
    ...(input.nextAction ? { nextAction: String(input.nextAction) } : {}),
  });
  if (!result.ok) {
    const error = result.error ?? { code: 'STAGE_UPDATE_FAILED', message: '开发阶段更新失败' };
    return { ok: false, reason: error.code, error };
  }
  return { ok: true, id, stage };
}

async function convertDevelopmentToOrder(prisma: PrismaClient, input: Record<string, unknown>) {
  const dc = (prisma as any).developmentCase;
  if (!dc?.update) return { ok: false, reason: 'MODEL_UNAVAILABLE' };

  const id = String(input.id || '');
  const orderId = String(input.orderId || '');
  const orderPo = String(input.orderPo || '');
  if (!id || !orderId || !orderPo) return { ok: false, reason: 'ALL_FIELDS_REQUIRED' };

  await dc.update({
    where: { id },
    data: {
      linkedOrderId: orderId,
      linkedOrderPo: orderPo,
      convertedAt: BigInt(Date.now()),
      stage: 'approved',
      updatedAt: BigInt(Date.now()),
    },
  });
  return { ok: true, id, orderId, orderPo };
}

// ---------------------------------------------------------------------------
// Production Management Tool Implementations
// ---------------------------------------------------------------------------

async function listOrdersByStatus(prisma: PrismaClient, input: Record<string, unknown>) {
  const statuses = Array.isArray(input.status) ? input.status : input.status ? [input.status] : undefined;
  const type = String(input.type || '');
  const customer = String(input.customer || '');
  const overdue = input.overdue === true;
  const limit = numberInput(input.limit, 30);

  const where: any = { deletedAt: null };
  if (statuses?.length) where.status = { in: statuses };
  if (type) where.type = type;
  if (customer) where.customer = { contains: customer, mode: 'insensitive' };

  const orders = await prisma.order.findMany({
    where,
    orderBy: [{ updatedAt: 'desc' }],
    take: limit,
    include: { lines: { orderBy: { lineNumber: 'asc' }, take: 1 } },
  });

  let result = orders.map(serializeOrderSummary);
  if (overdue) {
    const now = businessNowMs();
    result = result.filter((o: any) => {
      if (!o.dueDate) return false;
      const due = new Date(o.dueDate).getTime();
      return due < now && o.status !== 'Delivered';
    });
  }

  return { dataSource: 'local-prisma', count: result.length, items: result };
}

/**
 * ★ B50-1a 复核（R4-T4）抓到的 BLOCKER，我自己的实读复核确认成立：
 *   `AuditLog.actorId` 是 **UserAccount 的外键**（`prisma/schema.prisma:3796`；实库 `pg_constraint` 有
 *   `AuditLog_actorId_fkey`，NOT DEFERRABLE），而我第一版传了自造字面量 `'agent'` ⇒ 引擎在同一事务里
 *   写审计（`orderLifecycleService.ts:522`）/发起信用豁免（`:374`）时必然 P2003 回滚
 *   ⇒ "把 agent 接回门禁"会变成"agent 再也改不动任何订单状态"。单测把引擎整个 mock 掉，看不见这个。
 *   ★ 而且**这个坑本仓早已踩过并定过哨兵**：`audit/routeAudit.ts` 里 `SYSTEM_AUDIT_ACTOR` 上方的注释原文写着
 *   "'system' 哨兵与 seed 系统账号对齐（AuditLog.actorId 外键要求 UserAccount 行存在；历史哨兵 'api'
 *   无对应账号 → API-Key 审计写 FK 违约，已统一收敛为 'system'）" ⇒ 我没查既有真源就自造了一个，
 *   正是本仓反复登记的头号病。修法=用既有 `'system'`；"谁发起的"交给无外键的 `operator` 列。
 * ✅ 上面那句残留（`orderLifecycleService.ts` 三处 `actorId || 'api'`）**已在 B58 收口**：
 *   三处与门禁兜底一起改用导出的 `SYSTEM_AUDIT_ACTOR`，不再各自抄字面量。
 *   ⚠️ 但同一族在别处仍有残留（`actorId: ... || 'api'` 全仓 90+ 处，B55/B65 已立账）。
 */
// ★ B58 补漏：值不再有第二份字面量（原来这里手抄了一遍 'system'，与
//   `routeAudit.SYSTEM_AUDIT_ACTOR` 并存 = 同一判断两处实现，本仓头号病）。
const AGENT_SYSTEM_ACTOR = SYSTEM_AUDIT_ACTOR;

/** 已知生命周期错误码 = 对外可发的词表；其余（典型是引擎原样抛出的 Prisma `P2xxx`）一律塌成稳定码。 */
const LIFECYCLE_TOOL_REASONS = new Set([
  'ORDER_NOT_FOUND', 'ORDER_ALREADY_DELETED', 'INVALID_STATUS', 'INVALID_TRANSITION', 'NO_CHANGE',
  'DELETE_FAILED', 'TRANSITION_FAILED', 'ORDER_ALREADY_CLOSED', 'ORDER_LIFECYCLE_GUARDED', 'HAS_DEPENDENTS',
  'DEPENDENCY_CHECK_FAILED',
  // 门禁类（本批正是要把它们透出去）
  'MOQ_VIOLATION', 'CREDIT_FROZEN_60_DAYS', 'CREDIT_REVOKED', 'OVERDUE_60_DAYS', 'CREDIT_CHECK_FAILED',
  'LC_GATE_BLOCKED', 'LC_EXCEPTION_CHECK_FAILED',
]);

/**
 * 服务侧错误码 → 工具对外的旧 reason（纯映射，不在此重做任何判定）。
 * ⚠️ 复核抓到第二版缺陷：**未知码不得原样透出** —— 引擎 `:568` 会把 `e.code` 原样带回，
 *   于是 Prisma 的 `P2003/P2025` 会变成 MCP 的 `reason`（等于把内部错误码发给模型/客户端）。
 */
function lifecycleReasonToToolReason(code: string | undefined, toStatus: string): string {
  switch (code) {
    case 'NO_CHANGE': return 'ALREADY_IN_STATUS';
    case 'ORDER_ALREADY_DELETED': return 'ORDER_NOT_FOUND'; // 工具旧语义：软删=找不到
    case 'INVALID_STATUS': return `INVALID_STATUS: ${toStatus}`; // 旧格式带目标值
    default: return code && LIFECYCLE_TOOL_REASONS.has(code) ? code : 'TRANSITION_FAILED';
  }
}

async function updateOrderStatus(prisma: PrismaClient, input: Record<string, unknown>) {
  const orderId = String(input.orderId || '');
  const toStatus = String(input.toStatus || '');
  const note = String(input.note || '');
  if (!orderId || !toStatus) return { ok: false, reason: 'ORDER_ID_AND_STATUS_REQUIRED' };

  const VALID = new Set(['Pending', 'Confirmed', 'Production', 'Shipping', 'Delivered', 'Alert']);
  if (!VALID.has(toStatus)) return { ok: false, reason: `INVALID_STATUS: ${toStatus}` };

  // ★ B50：本函数此前自己 `orderStatusTransition.create` + `order.update({status})`，
  //   于是**四样东西同时缺**：确认门禁（信用 / MOQ / L/C）、状态转换矩阵、AuditLog、事务原子性。
  //   同一个动作在 `orderLifecycleService.transitionOrderStatus` 里已有唯一实现（V1/V2 路由与
  //   `orderLifecycleFlow`（审批复合流）都走它）⇒ 这里不再抄第二套判定，只把写交回那个引擎。
  //   `risk:'high' + approvalPolicy:'always'` 的审批是**追加**控制，不替代业务门禁：
  //   审批人说的是"允许尝试这次确认"，不是"这个客户没被冻结、信用证已登记"。
  const r = await transitionOrderStatus({ prisma, orderId, toStatus, note: note || undefined, operator: 'agent', actorId: AGENT_SYSTEM_ACTOR });
  if (!r.ok || !r.data) {
    const reason = lifecycleReasonToToolReason(r.error?.code, toStatus);
    // 引擎返回的原始码/文案不许进对外词表 ⇒ 原文只进日志（B22/B42 同一族的"对外收窄、日志留全"）
    if (reason === 'TRANSITION_FAILED') {
      logger.error('[agent/orders.update_status] 引擎返回未知错误码', { orderId, toStatus, code: r.error?.code, message: r.error?.message ?? '' });
    }
    return {
      ok: false,
      reason,
      message: r.error?.message ?? '',
      // MOQ 命中时服务会自动发起豁免审批单（DR-007）⇒ id 必须带出去，否则调用方只能看到"被拒"而不知下一步
      ...(r.error?.approvalRequestId ? { approvalRequestId: r.error.approvalRequestId } : {}),
    };
  }
  return { ok: true, orderId, fromStatus: r.data.fromStatus, toStatus: r.data.toStatus, note: r.data.note };
}

async function getOrderTimeline(prisma: PrismaClient, input: Record<string, unknown>) {
  const orderId = String(input.orderId || '');
  if (!orderId) return { timeline: [], reason: 'ORDER_ID_REQUIRED' };

  const transitions = await prisma.orderStatusTransition.findMany({
    where: { orderId },
    orderBy: { createdAt: 'asc' },
  });

  return {
    orderId,
    timeline: transitions.map((t: any) => {
      const out: any = { ...t };
      for (const k of Object.keys(out)) {
        if (typeof out[k] === 'bigint') out[k] = Number(out[k]);
        else if (Prisma.Decimal.isDecimal(out[k])) out[k] = Number(out[k]);
        else if (Prisma.Decimal.isDecimal(out[k])) out[k] = Number(out[k]);
      }
      return out;
    }),
  };
}

async function batchUpdateOrderStatus(prisma: PrismaClient, input: Record<string, unknown>) {
  const orderIds = Array.isArray(input.orderIds) ? input.orderIds.map(String) : [];
  const toStatus = String(input.toStatus || '');
  const note = String(input.note || '');

  if (!orderIds.length) return { ok: false, reason: 'ORDER_IDS_REQUIRED' };
  const VALID = new Set(['Confirmed', 'Production', 'Shipping', 'Delivered']);
  if (!VALID.has(toStatus)) return { ok: false, reason: `INVALID_STATUS: ${toStatus}` };

  // ★ B50：逐条交回唯一引擎（同 updateOrderStatus，四样缺项一次补齐：门禁 / 转换矩阵 / AuditLog / 事务）。
  const results: Array<{ orderId: string; fromStatus: string; toStatus: string }> = [];
  // "本来就在目标状态"不是失败 —— 旧实现把它静默 continue 掉（更糟），但把它算进 failed 会让"无事可做"
  // 变成"批量失败"（复核抓到的 MINOR）⇒ 单列 skipped，既不再说谎也不误报。
  const skipped: Array<{ orderId: string; reason: string }> = [];
  const failed: Array<{ orderId: string; reason: string; message?: string; approvalRequestId?: string }> = [];
  for (const orderId of orderIds) {
    const r = await transitionOrderStatus({ prisma, orderId, toStatus, note: note || undefined, operator: 'agent', actorId: AGENT_SYSTEM_ACTOR });
    if (r.ok && r.data) {
      results.push({ orderId, fromStatus: r.data.fromStatus, toStatus: r.data.toStatus });
      continue;
    }
    const reason = lifecycleReasonToToolReason(r.error?.code, toStatus);
    if (reason === 'TRANSITION_FAILED') {
      logger.error('[agent/orders.batch_status] 引擎返回未知错误码', { orderId, toStatus, code: r.error?.code, message: r.error?.message ?? '' });
    }
    if (reason === 'ALREADY_IN_STATUS') { skipped.push({ orderId, reason }); continue; }
    failed.push({
      orderId,
      reason,
      message: r.error?.message ?? '',
      ...(r.error?.approvalRequestId ? { approvalRequestId: r.error.approvalRequestId } : {}),
    });
  }

  // ★ `ok` 此前恒为 true 且**静默 continue** 掉不处理的单 ⇒ 三条单全被门禁挡下时，返回值仍然长得像"批量成功"，
  //   agent 会照实汇报"已确认 3 单"。⇒ 现在：真失败就不算成功；无事可做单独一档，不算失败。
  return { ok: failed.length === 0, updated: results, skipped, failed };
}

async function getOrdersKanban(prisma: PrismaClient, input: Record<string, unknown>) {
  const type = String(input.type || '');
  const where: any = { deletedAt: null };
  if (type) where.type = type;

  const groups = await prisma.order.groupBy({
    by: ['status'],
    where,
    _count: { id: true },
    _sum: { quoteAmount: true },
  });

  return {
    kanban: groups.map((g: any) => ({
      status: g.status,
      count: g._count?.id ?? 0,
      totalAmount: Number(g._sum?.quoteAmount ?? 0),
    })),
  };
}

async function updateGarmentSizeBreakdown(prisma: PrismaClient, input: Record<string, unknown>) {
  const lineId = String(input.lineId || '');
  const sizeBreakdown = input.sizeBreakdown;
  if (!lineId || !sizeBreakdown) return { ok: false, reason: 'LINE_ID_AND_BREAKDOWN_REQUIRED' };

  await prisma.orderLine.update({
    where: { id: lineId },
    data: { sizeBreakdown: sizeBreakdown as any },
  });
  return { ok: true, lineId };
}

async function updateGarmentProductionSteps(prisma: PrismaClient, input: Record<string, unknown>) {
  const lineId = String(input.lineId || '');
  const productionSteps = input.productionSteps;
  if (!lineId || !productionSteps) return { ok: false, reason: 'LINE_ID_AND_STEPS_REQUIRED' };

  await prisma.orderLine.update({
    where: { id: lineId },
    data: { productionSteps: productionSteps as any },
  });
  return { ok: true, lineId };
}

function serializeOrderSummary(o: any) {
  const out: any = {};
  for (const k of ['id', 'poNumber', 'customer', 'status', 'type', 'dueDate', 'quantity', 'quoteAmount', 'millName', 'salesCurrency']) {
    out[k] = typeof (o as any)[k] === 'bigint' ? Number((o as any)[k]) : Prisma.Decimal.isDecimal((o as any)[k]) ? Number((o as any)[k]) : (o as any)[k];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cross-module relationship graph (EntityLink)
// ---------------------------------------------------------------------------

async function queryEntityLinks(prisma: PrismaClient, input: Record<string, unknown>, context?: import('./toolDispatchRegistry').ToolExecutionContext) {
  if (context?.actor) return createAgentLinksService(prisma, context.actor).query(input);
  // Accept both shapes:
  //   {type,id}                — bidirectional (entity is on either side)
  //   {fromType,fromId}        — outgoing only
  //   {toType,toId}            — incoming only
  //   {fromType,fromId,toType} — outgoing filtered by neighbor type
  const type = String(input.type || '').trim();
  const id = String(input.id || '').trim();
  const fromType = String(input.fromType || '').trim();
  const fromId = String(input.fromId || '').trim();
  const toType = String(input.toType || '').trim();
  const toId = String(input.toId || '').trim();
  const linkKind = input.linkKind ? String(input.linkKind) : undefined;
  const limit = Math.max(1, Math.min(Number(input.limit || 100), 500));

  let where: any = { status: 'active', deletedAt: null };

  if (type && id) {
    where.OR = [
      { fromType: type, fromId: id },
      { toType: type, toId: id },
    ];
  } else if (fromType && fromId) {
    where.fromType = fromType;
    where.fromId = fromId;
    if (toType) where.toType = toType;
  } else if (toType && toId) {
    where.toType = toType;
    where.toId = toId;
    if (fromType) where.fromType = fromType;
  } else {
    return {
      ok: false,
      reason: 'TYPE_AND_ID_REQUIRED',
      hint: 'Pass either {type,id} for bidirectional, or {fromType,fromId} for outgoing, or {toType,toId} for incoming.',
    };
  }
  if (linkKind) where.linkKind = linkKind;

  const links = await (prisma as any).entityLink.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    take: limit,
  });

  const serialized = links.map((l: any) => {
    const o: any = { ...l };
    for (const k of Object.keys(o)) {
      if (typeof o[k] === 'bigint') o[k] = Number(o[k]);
      else if (Prisma.Decimal.isDecimal(o[k])) o[k] = Number(o[k]);
    }
    const direction: 'out' | 'in' = (o.fromType === type && o.fromId === id) ? 'out' : 'in';
    return {
      direction,
      linkKind: o.linkKind,
      otherType: direction === 'out' ? o.toType : o.fromType,
      otherId: direction === 'out' ? o.toId : o.fromId,
      updatedAt: o.updatedAt,
      source: o.source,
    };
  });

  return { ok: true, total: serialized.length, links: serialized };
}

async function expandEntityNeighbors(prisma: PrismaClient, input: Record<string, unknown>, context?: import('./toolDispatchRegistry').ToolExecutionContext) {
  if (context?.actor) return createAgentLinksService(prisma, context.actor).expand(input);
  const type = String(input.type || '').trim();
  const id = String(input.id || '').trim();
  const limit = Math.max(1, Math.min(Number(input.limit || 200), 500));
  if (!type || !id) return { ok: false, reason: 'TYPE_AND_ID_REQUIRED' };

  const links = await (prisma as any).entityLink.findMany({
    where: {
      OR: [{ fromType: type, fromId: id }, { toType: type, toId: id }],
      status: 'active',
      deletedAt: null,
    },
    orderBy: { updatedAt: 'desc' },
    take: limit,
  });

  const groups: Record<string, Array<any>> = {};
  for (const l of links) {
    const o: any = { ...l };
    for (const k of Object.keys(o)) {
      if (typeof o[k] === 'bigint') o[k] = Number(o[k]);
      else if (Prisma.Decimal.isDecimal(o[k])) o[k] = Number(o[k]);
    }
    const direction: 'out' | 'in' = (o.fromType === type && o.fromId === id) ? 'out' : 'in';
    const otherType = direction === 'out' ? o.toType : o.fromType;
    const otherId = direction === 'out' ? o.toId : o.fromId;
    const bucket = o.linkKind || 'related';
    if (!groups[bucket]) groups[bucket] = [];
    groups[bucket].push({ direction, type: otherType, id: otherId, updatedAt: o.updatedAt });
  }

  // Pull labels from EntityReference snapshots so the Agent has human text.
  const targets = new Set<string>();
  for (const links of Object.values(groups)) for (const n of links) targets.add(`${n.type}::${n.id}`);
  const labels: Record<string, string> = {};
  if (targets.size > 0) {
    const refs = await (prisma as any).entityReference.findMany({
      where: {
        OR: Array.from(targets).map(k => {
          const [t, i] = k.split('::');
          return { targetType: t, targetId: i, status: 'active' };
        }),
      },
      orderBy: { updatedAt: 'desc' },
      take: targets.size * 4,
    });
    for (const r of refs) {
      const key = `${r.targetType}::${r.targetId}`;
      if (!labels[key]) {
        const snap: any = r.snapshot ?? {};
        labels[key] = snap.label || snap.name || '';
      }
    }
    // Attach labels into the result
    for (const links of Object.values(groups)) {
      for (const n of links) {
        n.label = labels[`${n.type}::${n.id}`] || undefined;
      }
    }
  }

  return { ok: true, type, id, total: links.length, neighbors: groups };
}

// ═══════════════════════════════════════════════════════════════════════
// 财务管理 (finance) — B2 阶段真实实现
// ═══════════════════════════════════════════════════════════════════════
// 读操作：prisma 查询 + 过滤/分页/聚合
// 写操作：prisma.create/update + sync 双写（EntityReference + EntityLink）
// ═══════════════════════════════════════════════════════════════════════

async function handleFinanceListInvoices(prisma: PrismaClient, input: any, context?: import('./toolDispatchRegistry').ToolExecutionContext): Promise<any> {
  if (!isFinanceReadProjection(prisma)) return withFinanceReadProjection(prisma, context?.actor ? toolActorToken(context.actor) : undefined, db => handleFinanceListInvoices(db, input, context));
  const where: any = { deletedAt: null };
  if (input?.filters?.type) where.type = input.filters.type;
  if (input?.filters?.status) where.status = input.filters.status;
  if (input?.filters?.orderId) where.orderId = input.filters.orderId;
  if (input?.filters?.customerRelationId) where.customerRelationId = input.filters.customerRelationId;
  if (input?.filters?.currency) where.currency = input.filters.currency;

  const limit = Math.min(Number(input?.limit) || 50, 200);
  const offset = Number(input?.offset) || 0;
  const [items, total] = await Promise.all([
    (prisma as any).invoice.findMany({ where, take: limit, skip: offset, orderBy: { createdAt: 'desc' } }),
    (prisma as any).invoice.count({ where }),
  ]);
  return { ok: true, items, total, limit, offset };
}

async function handleFinanceGetInvoice(prisma: PrismaClient, input: any, context?: import('./toolDispatchRegistry').ToolExecutionContext): Promise<any> {
  if (!isFinanceReadProjection(prisma)) return withFinanceReadProjection(prisma, context?.actor ? toolActorToken(context.actor) : undefined, db => handleFinanceGetInvoice(db, input, context));
  const where: any = { deletedAt: null };
  if (input?.id) where.id = input.id;
  else if (input?.invoiceNumber) where.invoiceNumber = input.invoiceNumber;
  else return { ok: false, error: 'id or invoiceNumber required' };

  const item = await (prisma as any).invoice.findFirst({ where });
  if (!item) return { ok: false, error: 'Invoice not found' };
  return { ok: true, item };
}

async function handleFinanceListVouchers(prisma: PrismaClient, input: any, context?: import('./toolDispatchRegistry').ToolExecutionContext): Promise<any> {
  if (!isFinanceReadProjection(prisma)) return withFinanceReadProjection(prisma, context?.actor ? toolActorToken(context.actor) : undefined, db => handleFinanceListVouchers(db, input, context));
  const where: any = { deletedAt: null };
  if (input?.filters?.type) where.type = input.filters.type;
  if (input?.filters?.invoiceId) where.invoiceId = input.filters.invoiceId;
  if (input?.filters?.orderId) where.orderId = input.filters.orderId;
  if (input?.filters?.customerRelationId) where.customerRelationId = input.filters.customerRelationId;
  if (input?.filters?.currency) where.currency = input.filters.currency;

  const limit = Math.min(Number(input?.limit) || 50, 200);
  const offset = Number(input?.offset) || 0;
  const [items, total] = await Promise.all([
    (prisma as any).paymentVoucher.findMany({ where, take: limit, skip: offset, orderBy: { createdAt: 'desc' } }),
    (prisma as any).paymentVoucher.count({ where }),
  ]);
  return { ok: true, items, total, limit, offset };
}

async function handleFinanceGetVoucher(prisma: PrismaClient, input: any, context?: import('./toolDispatchRegistry').ToolExecutionContext): Promise<any> {
  if (!isFinanceReadProjection(prisma)) return withFinanceReadProjection(prisma, context?.actor ? toolActorToken(context.actor) : undefined, db => handleFinanceGetVoucher(db, input, context));
  const where: any = { deletedAt: null };
  if (input?.id) where.id = input.id;
  else if (input?.voucherNumber) where.voucherNumber = input.voucherNumber;
  else return { ok: false, error: 'id or voucherNumber required' };

  const item = await (prisma as any).paymentVoucher.findFirst({ where });
  if (!item) return { ok: false, error: 'PaymentVoucher not found' };
  return { ok: true, item };
}

// ── C3 高频外贸场景只读工具（智能报价 / 跟单提醒 / LC 审单 / 客户风险预警）──

async function handleQuotationsQuery(prisma: PrismaClient, input: any): Promise<any> {
  const service = createQuotationService(prisma);
  const filters = input?.filters || {};
  const { items, total } = await service.listQuotations({
    status: filters.status ? String(filters.status) : undefined,
    customerRelationId: filters.customerRelationId ? String(filters.customerRelationId) : undefined,
    dateFrom: filters.dateFrom ? String(filters.dateFrom) : undefined,
    dateTo: filters.dateTo ? String(filters.dateTo) : undefined,
    search: input?.query ? String(input.query) : undefined,
    limit: input?.limit,
    offset: input?.offset,
  });
  return { ok: true, items, total };
}

async function handleQuotationsGet(prisma: PrismaClient, input: any): Promise<any> {
  const service = createQuotationService(prisma);
  const id = input?.id ? String(input.id) : '';
  const quotationNumber = input?.quotationNumber ? String(input.quotationNumber) : '';
  if (!id && !quotationNumber) return { ok: false, error: 'id or quotationNumber required' };
  const item = id
    ? await service.getQuotation(id)
    : await prisma.quotation.findFirst({
        where: { quotationNumber, deletedAt: null },
        include: { lines: { orderBy: { lineNumber: 'asc' } } },
      });
  if (!item) return { ok: false, error: 'Quotation not found' };
  return { ok: true, item };
}

async function handleFinanceGetAging(prisma: PrismaClient, input: any, context?: import('./toolDispatchRegistry').ToolExecutionContext): Promise<any> {
  if (!isFinanceReadProjection(prisma)) return withFinanceReadProjection(prisma, context?.actor ? toolActorToken(context.actor) : undefined, db => handleFinanceGetAging(db, input, context));
  const type = input?.type === 'Payable' ? 'Payable' : 'Receivable';
  const report = await getAgingReport(prisma, { type, asOf: input?.asOf ? String(input.asOf) : undefined });
  // 行级按逾期额（1-90+ 四档合计）降序截取，控制响应体积；合计行始终完整返回
  const rowLimit = Math.min(Math.max(Number(input?.rowLimit) || 20, 1), 100);
  const overdueOf = (r: { buckets: { d1_30: number; d31_60: number; d61_90: number; d90plus: number } }) =>
    r.buckets.d1_30 + r.buckets.d31_60 + r.buckets.d61_90 + r.buckets.d90plus;
  const rows = [...report.rows].sort((a, b) => overdueOf(b) - overdueOf(a)).slice(0, rowLimit);
  return { ok: true, report: { ...report, rows, rowCount: report.rows.length } };
}

async function handleFinanceGetStatement(prisma: PrismaClient, input: any, context?: import('./toolDispatchRegistry').ToolExecutionContext): Promise<any> {
  if (!isFinanceReadProjection(prisma)) return withFinanceReadProjection(prisma, context?.actor ? toolActorToken(context.actor) : undefined, db => handleFinanceGetStatement(db, input, context));
  const customerRelationId = input?.customerRelationId ? String(input.customerRelationId) : '';
  if (!customerRelationId) return { ok: false, error: 'customerRelationId required' };
  const statement = await getCustomerStatement(prisma, {
    customerRelationId,
    from: input?.from ? String(input.from) : undefined,
    to: input?.to ? String(input.to) : undefined,
  });
  return { ok: true, statement };
}

async function handleCustomsQueryLc(prisma: PrismaClient, input: any): Promise<any> {
  const service = createCustomsService(prisma);
  const filters = input?.filters || {};
  const { items, total } = await service.listLettersOfCredit({
    status: filters.status ? String(filters.status) : undefined,
    relationId: filters.relationId ? String(filters.relationId) : undefined,
    orderId: filters.orderId ? String(filters.orderId) : undefined,
    issuingBank: filters.issuingBank ? String(filters.issuingBank) : undefined,
    expiringBefore: filters.expiringBefore ? String(filters.expiringBefore) : undefined,
    search: input?.query ? String(input.query) : undefined,
    limit: input?.limit,
    offset: input?.offset,
  });
  return { ok: true, items, total };
}

async function handleCustomsGetLc(prisma: PrismaClient, input: any): Promise<any> {
  const service = createCustomsService(prisma);
  const id = input?.id ? String(input.id) : '';
  const lcNumber = input?.lcNumber ? String(input.lcNumber) : '';
  if (!id && !lcNumber) return { ok: false, error: 'id or lcNumber required' };
  try {
    const item = id ? await service.getLetterOfCredit(id) : await service.getLetterOfCreditByNumber(lcNumber);
    return { ok: true, item };
  } catch {
    return { ok: false, error: 'Letter of credit not found' };
  }
}

async function handleShippingScanDelays(prisma: PrismaClient, input: any): Promise<any> {
  // 与 shipmentDelayDetector 调度任务同一口径（shipmentDelayService 单一权威源）
  const result = await scanDelayedShipments(prisma, {
    asOf: input?.asOf ? String(input.asOf) : undefined,
    limit: input?.limit,
  });
  return { ok: true, ...result };
}


async function handleFinanceQueryOutstanding(prisma: PrismaClient, input: any, context?: import('./toolDispatchRegistry').ToolExecutionContext): Promise<any> {
  if (!isFinanceReadProjection(prisma)) return withFinanceReadProjection(prisma, context?.actor ? toolActorToken(context.actor) : undefined, db => handleFinanceQueryOutstanding(db, input, context));
  // ★ 口径 E4（2026-09-17 业务方拍板）：
  //   ① where 用**唯一真源** `openReceivableWhere` 拼（含 `amount > 0` 守卫）——
  //      原先本地手写真源同值的状态集合，真源演化即漂移；
  //   ② **返回前按 `outstanding > 0` 过滤** —— 这个工具的名字就是「查未结清的」，
  //      把 0 元/负额票算进 `invoiceCount`、并影响 `earliestDueDate` 是**语义错**。
  //   ⚠️ 注意：负额**贷项票**（客户/供应商索赔）也会被本过滤排除 ——
  //      那是刻意的（它不构成"还欠着的应收"），其结清语义另见退款单独立状态（口径 A3）。
  //   见 docs/业务口径决策单-2026-09-17.md E4。
  const extra: any = {};
  if (input?.scope?.customerRelationId) extra.customerRelationId = input.scope.customerRelationId;
  if (input?.scope?.orderId) extra.orderId = input.scope.orderId;
  if (input?.scope?.currency) extra.currency = input.scope.currency;
  const where: any = openReceivableWhere(extra);
  // type filter: Receivable (应收) or Payable (应付) —— 调用方显式指定时覆盖真源默认
  if (input?.type) where.type = input.type;

  const invoices = await (prisma as any).invoice.findMany({
    where,
    select: { id: true, amount: true, currency: true, status: true, dueDate: true, customerRelationId: true, orderId: true },
  });

  // Phase 1 W1: 扣减已核销金额（Decimal-safe，避免 IEEE 754 漂移）
  // outstanding = invoice.amount - Σ InvoiceAllocation.appliedAmount WHERE invoiceId
  const invoiceIds = invoices.map((inv: any) => inv.id);
  // 已核销真源（收款核销 + 贷项票抵扣）—— 此前只算收款 ⇒ 客户拿了折让后 AI 报的未结清额虚高
  const appliedNum = await sumAppliedAmountByInvoice(prisma as any, invoiceIds);
  const allocatedByInvoice = new Map<string, any>();
  for (const [invoiceId, v] of appliedNum) {
    allocatedByInvoice.set(invoiceId, new Prisma.Decimal(v));
  }

  const invoicesWithOutstanding = invoices.map((inv: any) => {
    const amount = new Prisma.Decimal(inv.amount || 0);
    const allocated = allocatedByInvoice.get(inv.id) ?? new Prisma.Decimal(0);
    const outstanding = amount.minus(allocated);
    return {
      ...inv,
      amount: amount.toString(),
      allocatedAmount: allocated.toString(),
      outstandingAmount: outstanding.toString(),
    };
  });

  const dueDates = invoices.map((inv: any) => inv.dueDate).filter(Boolean).sort();
  const earliestDueDate = dueDates[0] || null;

  // ★ 口径 E4：**只返回真正未结清的**（`outstanding > 0`）——
  //   三个聚合量（totalOutstanding / invoiceCount / earliestDueDate）**必须都基于过滤后的集合**，
  //   否则"列表已过滤、汇总没过滤"会自相矛盾。
  const openInvoices = invoicesWithOutstanding.filter(
    (inv: any) => new Prisma.Decimal(inv.outstandingAmount).gt(0),
  );
  const openTotal = openInvoices.reduce(
    (acc: any, inv: any) => acc.plus(new Prisma.Decimal(inv.outstandingAmount)),
    new Prisma.Decimal(0),
  );
  const openDueDates = openInvoices.map((inv: any) => inv.dueDate).filter(Boolean).sort();

  return {
    ok: true,
    scope: input?.scope ?? {},
    type: input?.type ?? 'Receivable',
    totalOutstanding: openTotal.toString(),
    invoiceCount: openInvoices.length,
    earliestDueDate: openDueDates[0] || null,
    invoices: openInvoices,
    // 便于调用方自检「有没有被过滤掉的东西」（不改变既有字段语义，只新增）
    filteredOutCount: invoices.length - openInvoices.length,
  };
}

// Invoice creation has a verified runtime actor and current Invoice grant.
// Other direct Finance handlers below retain their existing audit contracts.
async function handleFinanceCreateInvoice(prisma: PrismaClient, input: any,
  context?: import('./toolDispatchRegistry').ToolExecutionContext): Promise<any> {
  const trustedActor = context?.actor ? toolActorToken(context.actor) : undefined;
  const authority = await checkCurrentInvoiceToolActor(prisma, trustedActor);
  if (!authority.ok) return { ok: false, error: authority.error.code, message: authority.error.message };
  // Phase 1 W1: 改写为复用 invoiceMutationService.createInvoice
  // 消除双账本漂移：统一走 service 层的 status 校验 / Decimal 校验 / sync / audit
  const id = input?.id || `INV__${Date.now().toString(36)}`;
  const result = await createInvoice({
    prisma,
    input: { ...input, id },
    actorId: trustedActor!.userId,
    actor: trustedActor,
    ip: null,
  });
  if (!result.ok || !result.data) {
    return { ok: false, error: result.error?.code || 'CREATE_FAILED', message: result.error?.message };
  }
  return { ok: true, created: result.data.invoice, auditId: result.data.auditId };
}

async function handleFinanceCreateVoucher(prisma: PrismaClient, input: any, context?: import('./toolDispatchRegistry').ToolExecutionContext): Promise<any> {
  // Phase 1 W1: 改写为复用 paymentVoucherMutationService.createPaymentVoucher
  // 消除双账本漂移：统一走 service 层的 status 校验 / Decimal 校验 / sync / audit
  const id = input?.id || `PAY__${Date.now().toString(36)}`;
  const result = await createPaymentVoucher({
    prisma,
    input: { ...input, id },
    actorId: context?.actor?.userId,
    actor: context?.actor ? toolActorToken(context.actor) : undefined,
    ip: null,
  });
  if (!result.ok) {
    return { ok: false, error: result.error?.code || 'CREATE_FAILED', message: result.error?.message };
  }
  return { ok: true, created: result.data.voucher, auditId: result.data.auditId };
}

async function handleFinanceApplyVoucherToInvoice(prisma: PrismaClient, input: any, context?: import('./toolDispatchRegistry').ToolExecutionContext): Promise<any> {
  const actor = context?.actor ? toolActorToken(context.actor) : undefined;
  const result = await createAllocation({prisma, actor, actorId: actor?.userId, input});
  if (!result.ok) return {ok: false, error: result.error?.code, message: result.error?.message};
  return {ok: true, ...result.data};
}

// ═══════════════════════════════════════════════════════════════════════
// 货运管理 (shipping) — 真实实现
// ═══════════════════════════════════════════════════════════════════════

async function handleRelationCreate(prisma: PrismaClient, input: any): Promise<any> {
  const id = String(input?.id || '').trim();
  const name = String(input?.name || '').trim();
  if (!id) return { ok: false, error: 'MISSING_ID', dataSource: 'bambook-data-center' };
  if (!name) return { ok: false, error: 'MISSING_NAME', dataSource: 'bambook-data-center' };
  const now = BigInt(Date.now());
  const VALID_CATEGORIES = new Set(['Customer', 'Supplier', 'Agent', 'Partner', 'Government', 'Internal', 'Other']);
  // task_mqy2aqkz: category 对齐 route 口径——显式非法返回 MISSING_CATEGORY，缺失默认 Other
  const rawCategory = String(input?.category || '').trim();
  if (rawCategory && !VALID_CATEGORIES.has(rawCategory)) {
    return { ok: false, error: 'MISSING_CATEGORY', message: 'category 必须是 Customer/Supplier/Agent/Partner/Government/Internal/Other 之一', dataSource: 'bambook-data-center' };
  }
  const category = rawCategory || (VALID_CATEGORIES.has(String(input?.type || '')) ? String(input.type) : 'Other');
  const type = String(input?.type || category).trim();
  const data: any = {
    id,
    name,
    category,
    type,
    isOrganization: input?.isOrganization !== undefined ? Boolean(input.isOrganization) : true,
    contactInfo: String(input?.contactInfo || input?.notes || ''),
    lastInteraction: now,
    parentId: input.parentId,
    role: input.role,
    department: input.department,
    tags: Array.isArray(input.tags) ? input.tags : undefined,
    paymentTerms: input.paymentTerms,
    primaryContactName: input.primaryContactName,
    primaryContactEmail: input.primaryContactEmail,
    primaryContactPhone: input.primaryContactPhone,
    creditLevel: input.creditLevel,
    currency: input.currency,
    officialAddress: input.address || input.officialAddress,
    factoryAddresses: Array.isArray(input.factoryAddresses) ? input.factoryAddresses : undefined,
    billingAddress: input.billingAddress,
    shippingAddress: input.shippingAddress,
    summary: input.notes || input.summary,
    website: input.website,
    taxId: input.taxId,
    email: input.email,
    phone: input.phone,
    mobile: input.mobile,
    wechat: input.wechat,
    whatsapp: input.whatsapp,
  };
  Object.keys(data).forEach((k) => data[k] === undefined && delete data[k]);
  try {
    // task: relations-audit-entitylink-contract: 业务写入 + sync + AuditLog 同事务闭环（fail closed）
    const created = await (prisma as any).$transaction(async (tx: any) => {
      const rel = await tx.relation.upsert({
        where: { id },
        update: { ...data, lastInteraction: now },
        create: data,
      });
      await syncRelationEntityReferences(prisma, rel, { source: 'agent.relations.create' }, tx);
      await writeRouteAuditLog({
        prisma: tx, actorId: SYSTEM_AUDIT_ACTOR, source: 'agent:relation:create',
        operation: 'create_relation', targetType: 'Relation', targetId: rel.id,
        after: { id: rel.id, name: rel.name, category: rel.category, type: rel.type },
      });
      return rel;
    });
    return {
      ok: true,
      dataSource: 'bambook-data-center',
      entity: 'Relation',
      created,
    };
  } catch (e: any) {
    const failure = publicAgentFailure(e);
    logAgentFailure('[agent] relation create failed', e);
    return { ok: false, error: 'CREATE_FAILED', message: failure, dataSource: 'bambook-data-center' };
  }
}

async function handleShippingListShipments(prisma: PrismaClient, input: any): Promise<any> {
  const filters = input?.filters ?? {};
  const sort = input?.sort ?? { field: 'createdAt', direction: 'desc' };
  const limit = Math.min(input?.limit ?? 50, 200);

  const where: any = { deletedAt: null };
  if (filters.type) where.type = filters.type;
  if (filters.status) where.status = { in: Array.isArray(filters.status) ? filters.status : [filters.status] };
  if (filters.orderId) where.orderId = filters.orderId;
  if (filters.customerRelationId) where.customerRelationId = filters.customerRelationId;
  if (filters.carrierRelationId) where.carrierRelationId = filters.carrierRelationId;
  if (filters.carrier) where.carrierName = { contains: filters.carrier, mode: 'insensitive' };

  const orderBy: any = {};
  orderBy[sort.field || 'createdAt'] = sort.direction || 'desc';

  const [items, total] = await Promise.all([
    (prisma as any).shipment.findMany({ where, take: limit, orderBy }),
    (prisma as any).shipment.count({ where }),
  ]);

  return {
    ok: true,
    dataSource: 'bambook-data-center',
    entity: 'Shipment',
    items,
    total,
    count: items.length,
    limit,
    hasMore: items.length < total,
    filters,
  };
}

async function handleShippingGetShipment(prisma: PrismaClient, input: any): Promise<any> {
  const { shipmentNumber, id } = input ?? {};
  let item: any = null;

  if (id) {
    item = await (prisma as any).shipment.findUnique({ where: { id } });
  } else if (shipmentNumber) {
    item = await (prisma as any).shipment.findUnique({ where: { shipmentNumber } });
  }

  if (!item || item.deletedAt) {
    return { ok: true, item: null, queriedBy: input ?? {} };
  }

  return { ok: true, item };
}

export async function handleShippingCreateShipment(prisma: PrismaClient, input: any,
  context?: import('./toolDispatchRegistry').ToolExecutionContext): Promise<any> {
  const { shipmentNumber, type, shippingMethod } = input ?? {};
  if (!shipmentNumber || !type || !shippingMethod)
    return { ok: false, error: 'MISSING_FIELDS', message: 'shipmentNumber, type, and shippingMethod are required', dataSource: 'bambook-data-center' };
  const result = await createSharedShipment({ prisma, input,
    actorId: context?.actor?.userId ?? context?.actorId ?? SYSTEM_AUDIT_ACTOR,
    ...(context?.actor ? { actor: toolActorToken(context.actor) } : {}),
    auditSource: 'agent:shipping:create_shipment', syncSource: 'agent:create_shipment' });
  if (!result.ok) return { ok: false, error: result.error!.code, message: result.error!.message,
    gateDetails: result.error!.gateDetails ?? null, dataSource: 'bambook-data-center' };
  return { ok: true, created: result.data!.shipment, dataSource: 'bambook-data-center' };
}

export async function handleShippingUpdateTrackingStatus(prisma: PrismaClient, input: any,
  context?: import('./toolDispatchRegistry').ToolExecutionContext): Promise<any> {
  const { shipmentId, status } = input ?? {};
  if (!shipmentId || !status) return { ok: false, error: 'MISSING_FIELDS', message: 'shipmentId and status are required', dataSource: 'bambook-data-center' };
  const patch: any = { status };
  const fields = { vessel: 'vesselOrFlight', voyage: 'voyageNumber', blNumber: 'containerNumber',
    etd: 'etd', eta: 'eta', atd: 'atd', ata: 'ata', notes: 'notes' };
  for (const [inputKey, patchKey] of Object.entries(fields)) if (input[inputKey] !== undefined) patch[patchKey] = input[inputKey];
  const result = await updateSharedShipment({ prisma, shipmentId, patch, hasStatus: true,
    actorId: context?.actor?.userId ?? context?.actorId ?? SYSTEM_AUDIT_ACTOR,
    ...(context?.actor ? { actor: toolActorToken(context.actor) } : {}),
    physicalCommand: { requestKey: input.requestKey, expectedShipmentUpdatedAt: input.expectedShipmentUpdatedAt,
      expectedPhysicalAllocationFingerprint: input.expectedPhysicalAllocationFingerprint },
    auditSource: 'agent:shipping:update_tracking', syncSource: 'agent:update_tracking' });
  if (!result.ok) return { ok: false, error: result.error!.code, message: result.error!.message,
    gateDetails: result.error!.gateDetails ?? null, dataSource: 'bambook-data-center' };
  return { ok: true, shipmentId, newStatus: result.data!.shipment.status,
    updatedAt: result.data!.shipment.updatedAt, dataSource: 'bambook-data-center' };
}

// ════════════════════════════════════════════════════════════════════
// Email Module Handlers (Phase 4a)
// ════════════════════════════════════════════════════════════════════

async function handleEmailListEmails(prisma: PrismaClient, input: any): Promise<any> {
  const filters = input?.filters ?? {};
  const sort = input?.sort ?? { field: 'receivedAt', direction: 'desc' };
  const limit = Math.min(input?.limit ?? 50, 200);

  const where: any = { deletedAt: null };
  if (filters.mailbox || filters.folder) where.mailbox = filters.mailbox || filters.folder;
  if (filters.direction) where.direction = filters.direction;
  if (filters.status) where.status = filters.status;
  if (filters.fromAddress) where.fromAddress = { contains: filters.fromAddress, mode: 'insensitive' };
  if (filters.subject) where.subject = { contains: filters.subject, mode: 'insensitive' };
  if (filters.hasAttachments !== undefined) where.hasAttachments = filters.hasAttachments;
  if (filters.orderId || filters.orderRelationId) where.orderId = filters.orderId || filters.orderRelationId;
  if (filters.relationId || filters.contactRelationId) where.relationId = filters.relationId || filters.contactRelationId;
  if (filters.invoiceId) where.invoiceId = filters.invoiceId;
  if (filters.dateFrom) where.sentAt = { ...(where.sentAt ?? {}), gte: filters.dateFrom };
  if (filters.dateTo) where.sentAt = { ...(where.sentAt ?? {}), lte: filters.dateTo };

  const orderBy: any = {};
  orderBy[sort.field || 'receivedAt'] = sort.direction || 'desc';

  const emailModel = (prisma as any).email;
  if (!emailModel?.findMany) {
    return { ok: true, items: [], total: 0, filters, note: 'email model unavailable' };
  }

  const [items, total] = await Promise.all([
    emailModel.findMany({
      where,
      take: limit,
      orderBy,
      select: {
        id: true,
        messageId: true,
        direction: true,
        status: true,
        fromAddress: true,
        fromName: true,
        subject: true,
        snippet: true,
        mailbox: true,
        sentAt: true,
        receivedAt: true,
        hasAttachments: true,
        attachmentCount: true,
        orderId: true,
        orderPo: true,
        relationId: true,
        relationName: true,
        invoiceId: true,
        invoiceNumber: true,
        labels: true,
      },
    }),
    emailModel.count({ where }),
  ]);

  return { ok: true, items, total, filters };
}

async function handleEmailGetEmail(prisma: PrismaClient, input: any): Promise<any> {
  const { id, emailId, messageId } = input ?? {};
  const lookupId = id || emailId;
  const emailModel = (prisma as any).email;
  if (!emailModel?.findUnique) {
    return { ok: true, item: null, note: 'email model unavailable' };
  }

  let item: any = null;
  if (lookupId) {
    item = await emailModel.findUnique({
      where: { id: lookupId },
      include: { attachments: true },
    });
  } else if (messageId) {
    item = await emailModel.findUnique({
      where: { messageId },
      include: { attachments: true },
    });
  }

  if (!item || item.deletedAt) {
    return { ok: true, item: null, queriedBy: input ?? {} };
  }

  return { ok: true, item };
}

async function handleEmailSearchEmails(prisma: PrismaClient, input: any): Promise<any> {
  const { query, limit: limitInput } = input ?? {};
  const limit = Math.min(limitInput ?? 30, 100);

  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return { ok: false, error: 'query is required' };
  }

  const emailModel = (prisma as any).email;
  if (!emailModel?.findMany) {
    return { ok: true, items: [], total: 0, note: 'email model unavailable' };
  }

  const q = query.trim();
  const items = await emailModel.findMany({
    where: {
      deletedAt: null,
      OR: [
        { subject: { contains: q, mode: 'insensitive' } },
        { fromAddress: { contains: q, mode: 'insensitive' } },
        { fromName: { contains: q, mode: 'insensitive' } },
        { snippet: { contains: q, mode: 'insensitive' } },
        { bodyText: { contains: q, mode: 'insensitive' } },
      ],
    },
    take: limit,
    orderBy: { receivedAt: 'desc' },
    select: {
      id: true,
      direction: true,
      status: true,
      fromAddress: true,
      fromName: true,
      subject: true,
      snippet: true,
      mailbox: true,
      sentAt: true,
      receivedAt: true,
      hasAttachments: true,
      orderId: true,
      relationId: true,
    },
  });

  return { ok: true, items, total: items.length, query: q };
}

async function handleEmailLinkEmailToOrder(prisma: PrismaClient, input: any): Promise<any> {
  const { emailId, orderId, orderRelationId, relationId, contactRelationId, relationName, orderPo } = input ?? {};
  const targetOrderId = orderId || orderRelationId;
  const targetRelationId = relationId || contactRelationId;
  if (!emailId) {
    return { ok: false, error: 'emailId is required' };
  }
  if (!targetOrderId && !targetRelationId) {
    return { ok: false, error: 'At least one of orderId or relationId is required' };
  }

  const emailModel = (prisma as any).email;
  if (!emailModel?.update) {
    return { ok: false, error: 'email model unavailable' };
  }

  const now = BigInt(Date.now());
  const patchData: any = { updatedAt: now };
  if (targetOrderId !== undefined) patchData.orderId = targetOrderId;
  if (targetRelationId !== undefined) patchData.relationId = targetRelationId;
  if (relationName !== undefined) patchData.relationName = relationName;
  if (orderPo !== undefined) patchData.orderPo = orderPo;

  const updated = await emailModel.update({
    where: { id: emailId },
    data: patchData,
  });

  await syncEmailReferences(prisma, updated, { source: 'agent:link_email_to_order' });

  return { ok: true, emailId, orderId: targetOrderId, relationId: targetRelationId, updatedAt: now };
}

// ════════════════════════════════════════════════════════════════════
// Email AI Extract Handler (Phase 4b)
// ════════════════════════════════════════════════════════════════════

async function handleEmailAiExtract(prisma: PrismaClient, input: any): Promise<any> {
  const { emailId, force, model } = input ?? {};
  if (!emailId || typeof emailId !== 'string') {
    return { ok: false, error: 'emailId is required' };
  }
  const result = await extractEmailAi({
    prisma,
    emailId,
    force: !!force,
    model: typeof model === 'string' ? model : undefined,
  });
  return result;
}

// ════════════════════════════════════════════════════════════════════
// Templates Handlers (Phase 6 — Compiled Templates)
// ════════════════════════════════════════════════════════════════════

const KNOWN_TEMPLATE_IDS: ReadonlySet<TemplateId> = new Set<TemplateId>([
  'invoice.sample.pdas',
  'invoice.sample.fabric',
]);

async function handleTemplateList(): Promise<any> {
  return {
    ok: true,
    schemaVersion: 1,
    templates: listAvailableTemplates(),
  };
}

async function handleTemplateRender(prisma: PrismaClient, input: any): Promise<any> {
  const templateId = String(input?.templateId ?? '');
  const data = input?.data;
  if (!templateId) return { ok: false, error: 'templateId is required' };
  if (!KNOWN_TEMPLATE_IDS.has(templateId as TemplateId)) {
    return { ok: false, error: `Unknown templateId: ${templateId}` };
  }
  if (!data || typeof data !== 'object') {
    return { ok: false, error: 'data must be an object' };
  }
  try {
    const result = renderTemplateById(templateId as TemplateId, data);
    // 异步落库，不阻塞返回
    saveRenderedDoc({
      prisma,
      templateId: result.templateId,
      schemaVersion: result.schemaVersion,
      inputJson: data,
      htmlSha: result.sha,
      htmlBytes: result.bytes,
      source: 'agent',
    }).catch((err: unknown) => {
      logger.error('[templates] saveRenderedDoc error', { error: err instanceof Error ? err.message : String(err) });
    });
    return {
      ok: true,
      renderedDocId: 'pending', // caller 无法等异步落库，落库后不可知 renderedDocId
      templateId: result.templateId,
      schemaVersion: result.schemaVersion,
      sha: result.sha,
      bytes: result.bytes,
      generatedAt: result.generatedAt,
      html: result.html,
    };
  } catch (err) {
    const refusal = readTemplateRefusal(err);
    const failure = refusal ?? publicAgentFailure(err);
    logAgentFailure('[agent] template render failed', err);
    if (refusal !== undefined) return { ok: false, error: refusal };
    return { ok: false, error: failure };
  }
}

async function handleTemplateRenderPdf(prisma: PrismaClient, input: any): Promise<any> {
  const templateId = String(input?.templateId ?? '');
  const data = input?.data;
  const format = (input?.format as 'A4' | 'A5' | 'Letter' | undefined) ?? 'A4';
  const landscape = Boolean(input?.landscape);
  if (!templateId) return { ok: false, error: 'templateId is required' };
  if (!KNOWN_TEMPLATE_IDS.has(templateId as TemplateId)) {
    return { ok: false, error: `Unknown templateId: ${templateId}` };
  }
  if (!data || typeof data !== 'object') {
    return { ok: false, error: 'data must be an object' };
  }
  try {
    const html = renderTemplateById(templateId as TemplateId, data);
    const pdf = await renderHtmlToPdf(html.html, { format, landscape });
    // 同步落库 + PDF 文件存储
    let renderedDocId: string | undefined;
    try {
      const pdfPath = savePdfFile(pdf.pdf, `rnd-pdf-${Date.now()}`);
      renderedDocId = await saveRenderedDoc({
        prisma,
        templateId: html.templateId,
        schemaVersion: html.schemaVersion,
        inputJson: data,
        htmlSha: html.sha,
        htmlBytes: html.bytes,
        pdfSha: pdf.sha,
        pdfBytes: pdf.bytes,
        pdfPath,
        format,
        landscape,
        source: 'agent',
      });
    } catch (storeErr) {
      logger.error('[templates] saveRenderedDoc error', { error: storeErr instanceof Error ? storeErr.message : String(storeErr) });
    }
    return {
      ok: true,
      renderedDocId: renderedDocId ?? null,
      templateId: html.templateId,
      schemaVersion: html.schemaVersion,
      htmlSha: html.sha,
      pdfSha: pdf.sha,
      pdfBytes: pdf.bytes,
      pdfBase64: pdf.pdf.toString('base64'),
      format: pdf.format,
      landscape,
      generatedAt: pdf.generatedAt,
    };
  } catch (err) {
    const refusal = readTemplateRefusal(err);
    const failure = refusal ?? publicAgentFailure(err);
    logAgentFailure('[agent] template render failed', err);
    if (refusal !== undefined) return { ok: false, error: refusal };
    return { ok: false, error: failure };
  }
}
