import { businessNowDate } from '../shared/businessClock';
import { isPackingListCandidateInTx, rejectGenericPackingListWrite, authorizePackingListMetadataInTx, finishPackingListMetadataInTx } from './shipmentPackingListCommand';
import { rejectGenericSupplierDocumentWrite } from './supplierContractDocumentPolicy';
/**
 * 外贸与报关服务 — Phase 5 B5 + Phase 3 C6
 *
 * 职责：
 *   1. CustomsDeclaration：报关单 CRUD + 状态机（Draft→Submitted→Declared→Inspecting→Released/Exception/Cancelled）+ 明细行
 *   2. HsCode：HS 编码库 CRUD（参考数据，无软删除）
 *   3. LetterOfCredit：信用证 CRUD + 状态机（Issued→Presented→Accepted→Settled/Discrepant/Expired/Cancelled）
 *   4. TaxRefund：出口退税 CRUD + 状态机（Draft→Submitted→Reviewing→Approved/Rejected→Refunded/Cancelled）+ 审核
 *   5. TradeDocument：贸易单据 CRUD + 状态机（Draft→Issued→Submitted→Accepted/Rejected/Cancelled）
 *
 * 设计原则：
 *   - 软删除（deletedAt BigInt），HsCode 参考数据用 isActive 标记
 *   - 事务内创建主表 + 行明细 + 审计日志
 *   - 状态转换有严格校验（非法转换抛错，fail-closed）
 *   - 退税金额自动计算：refundAmount = exportAmountCny × refundableRate
 *   - 事件发布失败不阻断业务（fire-and-forget）
 */

import { PrismaClient, Prisma } from '@prisma/client';
import { assertCiDocumentMetadataDelete, authorizeCiDocumentMetadataTransitionInTx, finishCiDocumentMetadataTransitionInTx, type CiDocumentMetadataOptions } from './ciDocumentMetadata';
import { logger } from '../lib/logger';
import { businessError, isBusinessError, lookupErrorCode } from '../shared/errorCodes';
import { writeFieldAuditDiff } from '../audit/routeAudit'; // ★ B220：字段级留痕复用共享真源
import { computeTaxRefundFigures } from './taxRefundCalcService';
import { clampLimit, clampOffset } from '../lib/paging';
import { businessEventBus } from '../events/businessEventBus';
import { deactivateEntityLinks, syncCustomsDeclarationReferences, syncLetterOfCreditReferences, syncTaxRefundReferences } from '../entities/sync';
import { appendTradeDocumentVersion, generateTradeDocumentNumber, toTradeDocumentSnapshot } from './tradeDocumentLifecycleService';
import { nextBusinessNumber } from '../shared/businessNumberService';
import { registerCanonicalCi, type CiInvoiceSourceOptions } from './ciInvoiceSource';
import { sweepNotificationsForDeletedEntities } from '../notifications/notificationService';
import { todayLocalKey } from '../shared/localDate';


// ────────────────────────────────────────────────────────────────
// 类型
// ────────────────────────────────────────────────────────────────

export type CustomsType = 'Export' | 'Import';
export type CustomsDeclarationStatus = 'Draft' | 'Submitted' | 'Declared' | 'Inspecting' | 'Released' | 'Exception' | 'Cancelled';
export type TradeTerms = 'FOB' | 'CIF' | 'EXW' | 'DDP' | 'FCA' | 'CPT' | 'CIP' | 'DAP' | 'DPU' | 'CFR';

export type HsCodeCategory = 'Textile' | 'Garment' | 'Accessory' | 'Material' | 'Yarn' | 'Other';

export type LetterOfCreditType = 'Irrevocable' | 'Revocable' | 'Standby' | 'Transferable';
export type LetterOfCreditStatus = 'Issued' | 'Presented' | 'Accepted' | 'Discrepant' | 'Settled' | 'Expired' | 'Cancelled';

export type TaxRefundStatus = 'Draft' | 'Submitted' | 'Reviewing' | 'Approved' | 'Rejected' | 'Refunded' | 'Cancelled';

export type TradeDocumentType =
  | 'CommercialInvoice'
  | 'PackingList'
  | 'CertificateOfOrigin'
  | 'BillOfLading'
  | 'AirWaybill'
  | 'InsuranceCert'
  | 'InspectionCert'
  | 'PhytosanitaryCert'
  | 'ExportDeclarationProof'
  | 'Other'
  // ── B2 运营域单据类型（2026-08-22 全系统单据枢纽：各业务域就地生成，非手动入口可建）──
  | 'PurchaseOrder'      // 采购订单（procurement 域，sourceRef=PurchaseOrder.id）
  | 'ProcessingContract'
  | 'InspectionReport'   // 验货报告（qc 域，sourceRef=InspectionReport.id）
  | 'Quotation'          // 报价单（quotation 域，B7 sourceRef=Quotation.id）
  | 'OrderConfirmation'  // 订单确认书（orders 域，B8 sourceRef=Order.id）
  | 'PaymentRequest'     // 付款申请单（finance 域，§10.3-9 Phase B 批次 4 sourceRef=PaymentRequest.id）
  | 'Contract';          // 合同（contract 域，占位——多订单合并合同走 CONTRACT 组合文档即时生成）
export type TradeDocumentStatus = 'Draft' | 'Issued' | 'Submitted' | 'Accepted' | 'Rejected' | 'Cancelled';

// ─── Input 类型 ───

export interface CustomsDeclarationInput {
  /** 报关单号（可选，服务端自动生成 CD-YYYY-NNNN；传入时优先使用传入值并校验唯一性） */
  declarationNumber?: string;
  shipmentId?: string;
  orderId?: string;
  relationId?: string;
  type: CustomsType;
  declarationDate?: string;
  customsCode?: string;
  declarationPort?: string;
  tradeTerms?: string;
  totalValue?: number;
  currency?: string;
  /**
   * 运保费（**报关时申报的**数，币种同 currency；退税算 FOB 时要用）
   * 为什么不用运单的 freightAmount：退税报给税务局，税务认报关单上填的数。
   * CIF/CIP 两项都必填；CFR/CPT 只需运费；其余不必填。
   * 未登记 → 退税算不出 FOB（fail-closed，不拿含运保费的金额冒充 FOB）。
   * 更新语义：undefined = 不改；null = 清空。
   */
  freightAmount?: number | null;
  insuranceAmount?: number | null;
  totalPackages?: number;
  grossWeight?: number;
  netWeight?: number;
  originCountry?: string;
  destinationCountry?: string;
  consignee?: string;
  consignor?: string;
  declarant?: string;
  agent?: string;
  notes?: string;
  lines?: CustomsDeclarationLineInput[];
}

export interface CustomsDeclarationLineInput {
  productCode?: string;
  productName: string;
  hsCode?: string;
  brandName?: string;
  specification?: string;
  quantity: number;
  unit: string;
  unitPrice?: number;
  totalAmount?: number;
  currency?: string;
  grossWeight?: number;
  netWeight?: number;
  originCountry?: string;
  notes?: string;
}

export interface HsCodeInput {
  code: string;
  description: string;
  category: HsCodeCategory;
  exportTaxRebateRate?: number;
  importTariffRate?: number;
  vatRate?: number;
  unit?: string;
  supervisionCondition?: string;
  inspectionQuarantine?: string;
  additionalDuty?: string;
  notes?: string;
  isActive?: boolean;
}

export interface LetterOfCreditInput {
  /** 信用证号（可选，服务端自动生成 LC-YYYY-NNNN；传入时优先使用传入值并校验唯一性） */
  lcNumber?: string;
  relationId?: string;
  orderId?: string;
  type: LetterOfCreditType;
  issueDate?: string;
  issueBank?: string;
  advisingBank?: string;
  negotiatingBank?: string;
  confirmingBank?: string;
  applicant?: string;
  beneficiary?: string;
  amount: number;
  currency?: string;
  availableAmount?: number;
  expiryDate?: string;
  expiryPlace?: string;
  presentationDeadline?: string;
  shipmentDeadline?: string;
  tradeTerms?: string;
  portOfLoading?: string;
  portOfDischarge?: string;
  documentsRequired?: string[];
  specialConditions?: string;
  discrepancies?: string;
  notes?: string;
}

export interface TaxRefundInput {
  /** 退税编号（可选，服务端自动生成 TR-YYYY-NNNN；传入时优先使用传入值并校验唯一性） */
  refundNumber?: string;
  declarationId?: string;
  orderId?: string;
  relationId?: string;
  exportDate?: string;
  declarationDate?: string;
  fxRate?: number;
  exportAmountFob?: number;
  exportAmountFobCurrency?: string;
  exportAmountCny?: number;
  refundableVat?: number;
  refundableRate?: number;
  refundAmount?: number;
  refundDate?: string;
  notes?: string;
}

export interface TaxRefundReviewInput {
  /** @deprecated 审核留痕取真实登录人（actorId 来自路由层认证身份），请求体 reviewedBy 仅作无身份时的兜底，不再受信 */
  reviewedBy?: string;
  decision: 'Approved' | 'Rejected';
  reviewNotes?: string;
  refundAmount?: number;
}

export interface TradeDocumentInput {
  /** 留空自动取号（{类型前缀}-YYYY-NNNN，按年递增、作废不回收，见 tradeDocumentLifecycleService） */
  documentNumber?: string;
  type: TradeDocumentType;
  shipmentId?: string;
  declarationId?: string;
  orderId?: string;
  relationId?: string;
  /** 可选业务真源外链：外部单据可直接回链到已有 LetterOfCredit.id。 */
  sourceRef?: string;
  issueDate?: string;
  expiryDate?: string;
  issuedBy?: string;
  consignee?: string;
  consignor?: string;
  portOfLoading?: string;
  portOfDischarge?: string;
  totalAmount?: number;
  currency?: string;
  filePath?: string;
  fileName?: string;
  notes?: string;
  /** 更新时写入 DocumentVersion 的变更原因（服务端自动留痕，仅 update 消费） */
  changeReason?: string;
}

// ────────────────────────────────────────────────────────────────
// 辅助函数
// ────────────────────────────────────────────────────────────────

const now = (): bigint => BigInt(Date.now());

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const VALID_CUSTOMS_TYPES: CustomsType[] = ['Export', 'Import'];
const VALID_DECLARATION_STATUSES: CustomsDeclarationStatus[] = ['Draft', 'Submitted', 'Declared', 'Inspecting', 'Released', 'Exception', 'Cancelled'];
const VALID_HS_CATEGORIES: HsCodeCategory[] = ['Textile', 'Garment', 'Accessory', 'Material', 'Yarn', 'Other'];
const VALID_LC_TYPES: LetterOfCreditType[] = ['Irrevocable', 'Revocable', 'Standby', 'Transferable'];
const VALID_LC_STATUSES: LetterOfCreditStatus[] = ['Issued', 'Presented', 'Accepted', 'Discrepant', 'Settled', 'Expired', 'Cancelled'];
const VALID_TAX_REFUND_STATUSES: TaxRefundStatus[] = ['Draft', 'Submitted', 'Reviewing', 'Approved', 'Rejected', 'Refunded', 'Cancelled'];
const VALID_DOC_TYPES: TradeDocumentType[] = ['CommercialInvoice', 'PackingList', 'CertificateOfOrigin', 'BillOfLading', 'AirWaybill', 'InsuranceCert', 'InspectionCert', 'PhytosanitaryCert', 'ExportDeclarationProof', 'Other', 'PurchaseOrder', 'ProcessingContract', 'InspectionReport', 'Contract'];
/** 手动可创建类型（单据中心 UI 创建入口）：仅 customs 交单类型——域单据（PO/IR/Contract）
 * 由各业务模块带 sourceRef 就地生成，手动建域单据无业务真源可引用，fail-closed 拒绝 */
const MANUALLY_CREATABLE_DOC_TYPES: TradeDocumentType[] = ['CommercialInvoice', 'PackingList', 'CertificateOfOrigin', 'BillOfLading', 'AirWaybill', 'InsuranceCert', 'InspectionCert', 'PhytosanitaryCert', 'ExportDeclarationProof', 'Other'];
const EXTERNAL_ARCHIVE_DOC_TYPES = new Set<TradeDocumentType>(['CertificateOfOrigin', 'BillOfLading', 'AirWaybill', 'InsuranceCert', 'InspectionCert', 'PhytosanitaryCert', 'ExportDeclarationProof', 'Other']);
const VALID_DOC_STATUSES: TradeDocumentStatus[] = ['Draft', 'Issued', 'Submitted', 'Accepted', 'Rejected', 'Cancelled'];

function validateCustomsType(type: string): asserts type is CustomsType {
  if (!VALID_CUSTOMS_TYPES.includes(type as CustomsType)) throw new Error(`非法报关类型: ${type}`);
}
function validateDeclarationStatus(status: string): asserts status is CustomsDeclarationStatus {
  if (!VALID_DECLARATION_STATUSES.includes(status as CustomsDeclarationStatus)) throw new Error(`非法报关单状态: ${status}`);
}
function validateHsCategory(cat: string): asserts cat is HsCodeCategory {
  if (!VALID_HS_CATEGORIES.includes(cat as HsCodeCategory)) throw new Error(`非法 HS 编码类别: ${cat}`);
}
/**
 * 税率类字段范围守卫（口径：**百分数**，如 13 表示 13%）。
 * 越界即拒绝（报错优于算错）——历史上无任何校验，前端按「(%)」录入后直接落库，
 * 一旦录入口径被误当小数（0.13 表示 13%）就会静默算错 100 倍。
 */
function validatePercentRate(value: number | null | undefined, label: string): void {
  if (value == null) return;
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${label}必须在 0-100 之间（百分数口径，如 13 表示 13%）`);
  }
}
function validateLcType(type: string): asserts type is LetterOfCreditType {
  if (!VALID_LC_TYPES.includes(type as LetterOfCreditType)) throw new Error(`非法信用证类型: ${type}`);
}
function validateLcStatus(status: string): asserts status is LetterOfCreditStatus {
  if (!VALID_LC_STATUSES.includes(status as LetterOfCreditStatus)) throw new Error(`非法信用证状态: ${status}`);
}
function validateTaxRefundStatus(status: string): asserts status is TaxRefundStatus {
  if (!VALID_TAX_REFUND_STATUSES.includes(status as TaxRefundStatus)) throw new Error(`非法退税状态: ${status}`);
}
function validateDocType(type: string): asserts type is TradeDocumentType {
  if (!VALID_DOC_TYPES.includes(type as TradeDocumentType)) throw new Error(`非法单据类型: ${type}`);
}
function validateDocStatus(status: string): asserts status is TradeDocumentStatus {
  if (!VALID_DOC_STATUSES.includes(status as TradeDocumentStatus)) throw new Error(`非法单据状态: ${status}`);
}

// ─── 状态转换规则 ───

const DECLARATION_TRANSITIONS: Record<string, string[]> = {
  Draft: ['Submitted', 'Cancelled'],
  Submitted: ['Declared', 'Exception', 'Cancelled'],
  Declared: ['Inspecting', 'Exception', 'Cancelled'],
  Inspecting: ['Released', 'Exception'],
  Released: [],
  Exception: ['Submitted', 'Cancelled'],
  Cancelled: [],
};

const LC_TRANSITIONS: Record<string, string[]> = {
  Issued: ['Presented', 'Expired', 'Cancelled'],
  Presented: ['Accepted', 'Discrepant', 'Cancelled'],
  Accepted: ['Settled', 'Cancelled'],
  Discrepant: ['Presented', 'Cancelled'],
  Settled: [],
  Expired: [],
  Cancelled: [],
};

const TAX_REFUND_TRANSITIONS: Record<string, string[]> = {
  Draft: ['Submitted', 'Cancelled'],
  Submitted: ['Reviewing', 'Rejected', 'Cancelled'],
  Reviewing: ['Approved', 'Rejected', 'Cancelled'],
  Approved: ['Refunded'],
  Rejected: ['Draft'],
  Refunded: [],
  Cancelled: [],
};

const DOC_TRANSITIONS: Record<string, string[]> = {
  Draft: ['Issued', 'Cancelled'],
  Issued: ['Submitted', 'Cancelled'],
  Submitted: ['Accepted', 'Rejected', 'Cancelled'],
  Accepted: [],
  Rejected: ['Draft'],
  Cancelled: [],
};

/** 非 customs 域（procurement/qc/contract/finance）文档生命周期状态机：
 * 简化 Draft → Issued → Cancelled——域单据内容随业务真源实时渲染，
 * 无交单流转语义（customs 交单状态机不适用）。 */
const SIMPLE_DOC_TRANSITIONS: Record<string, string[]> = {
  Draft: ['Issued', 'Cancelled'],
  Issued: ['Cancelled'],
  Cancelled: [],
};

/** 按业务域的单据状态机（schema TradeDocument.status 注释引用的真源）：
 * customs=交单状态机；其余域=简化文档生命周期。未知 domain fail-closed 拒绝。 */
export const DOC_DOMAIN_STATUS_TRANSITIONS: Record<string, Record<string, string[]>> = {
  customs: DOC_TRANSITIONS,
  procurement: SIMPLE_DOC_TRANSITIONS,
  qc: SIMPLE_DOC_TRANSITIONS,
  contract: SIMPLE_DOC_TRANSITIONS,
  finance: SIMPLE_DOC_TRANSITIONS,
  quotation: SIMPLE_DOC_TRANSITIONS,
  orders: SIMPLE_DOC_TRANSITIONS,
};

/** 按域取状态机（未知域 fail-closed——不允许无状态机的域建单据） */
export function docStatusTransitionsFor(domain: string): Record<string, string[]> {
  const transitions = DOC_DOMAIN_STATUS_TRANSITIONS[domain];
  if (!transitions) throw new Error(`非法单据业务域: ${domain}`);
  return transitions;
}

function validateTransition(transitions: Record<string, string[]>, from: string, to: string, entityName: string): void {
  const allowed = transitions[from] || [];
  if (!allowed.includes(to)) {
    throw new Error(`非法${entityName}状态转换: ${from} → ${to}（允许: ${allowed.join(', ') || '无'}）`);
  }
}

// ─── C4 关单闭环 ───
// 报关单关联运单（shipmentId）时，事务内回填 Shipment 关单字段：
//   - 创建报关单 → customsDeclarationNumber（免手工双录，运单详情即时可见）
//   - 放行（Released）→ customsDeclarationNumber（防漏补写）+ customsClearanceDate（当日 YYYY-MM-DD）
// 运单不存在/已软删时静默跳过（shipmentId 为 snapshot FK，不阻断报关单主流程）。
async function backfillShipmentCustoms(
  tx: any,
  decl: { shipmentId: string | null; declarationNumber: string },
  cleared: boolean,
): Promise<void> {
  if (!decl.shipmentId) return;
  const shipment = await tx.shipment.findUnique({ where: { id: decl.shipmentId }, select: { id: true, deletedAt: true } });
  if (!shipment || shipment.deletedAt) return;
  const data: Record<string, unknown> = {
    customsDeclarationNumber: decl.declarationNumber,
    updatedAt: now(),
  };
  if (cleared) {
    const d = businessNowDate();
    const pad = (n: number) => String(n).padStart(2, '0');
    data.customsClearanceDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  await tx.shipment.update({ where: { id: shipment.id }, data });
}

/** 信用证创建可写字段白名单（route / Agent Flow 共用真源；字段定义见 LetterOfCreditInput） */
export const LETTER_OF_CREDIT_CREATE_FIELDS: readonly string[] = [
  'lcNumber', 'relationId', 'orderId', 'type', 'issueDate', 'issueBank', 'advisingBank',
  'negotiatingBank', 'confirmingBank', 'applicant', 'beneficiary', 'amount', 'currency',
  'availableAmount', 'expiryDate', 'expiryPlace', 'presentationDeadline', 'shipmentDeadline',
  'tradeTerms', 'portOfLoading', 'portOfDischarge', 'documentsRequired', 'specialConditions',
  'discrepancies', 'notes',
];

/**
 * 报关单更新可 patch 字段白名单（仅 Draft 可编辑；status 走状态机流转，不在 update 通道内；
 * lines 不在 patch 通道内）
 */
export const CUSTOMS_DECLARATION_UPDATE_FIELDS: readonly string[] = [
  'declarationNumber', 'shipmentId', 'orderId', 'relationId', 'type', 'declarationDate',
  'customsCode', 'declarationPort', 'tradeTerms', 'totalValue', 'currency', 'totalPackages',
  'grossWeight', 'netWeight', 'originCountry', 'destinationCountry', 'consignee', 'consignor',
  'declarant', 'agent', 'notes',
];

/**
 * ★ B220（v3.112）：报关单**逐字段留痕**的追踪面。
 * 派生自上面那份白名单，但**不能只等于它** —— 那份是 agent 通道的窄面（`agent/customsFlow.ts:177` 拿它拒字段），
 * 而 HTTP 这条 `updateDeclaration` 还处理 `freightAmount` / `insuranceAmount` 两列（运保费，直接牵动退税）。
 * 只派生白名单 ⇒ 从界面改运保费**一行痕都不留**，于是取**两者并集**。
 */
export const CUSTOMS_DECLARATION_AUDIT_FIELDS: readonly string[] = [
  ...new Set([...CUSTOMS_DECLARATION_UPDATE_FIELDS, 'freightAmount', 'insuranceAmount']),
];

/**
 * 快照折叠：`@db.Decimal` 列（totalValue / grossWeight / netWeight / freightAmount / insuranceAmount）
 * 原值进 `Json` 列会带出 Prisma 内部形状 ⇒ 折成字符串；其余字段本就标量，原样。
 */
function customsAuditSnapshot(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of CUSTOMS_DECLARATION_AUDIT_FIELDS) {
    const v = row[f];
    out[f] = v == null || ['string', 'number', 'boolean'].includes(typeof v) ? v : String(v);
  }
  return out;
}

// ════════════════════════════════════════════════════════════════
// Service Factory
// ════════════════════════════════════════════════════════════════

export function createCustomsService(prisma: PrismaClient) {
  // ────────────────────────────────────────────────────────────
  // 1. CustomsDeclaration（报关单）
  // ────────────────────────────────────────────────────────────

  async function createDeclaration(input: CustomsDeclarationInput, actorId: string) {
    validateCustomsType(input.type);

    // PRD 5.6：服务端自动生成报关单号（CD-YYYY-NNNN），传入时优先使用传入值并校验唯一性
    // QA-SEC-5：自动生成走序号占用原子追平（含软删行，防并发/历史冲突）；显式传入单号仍校验唯一
    const duplicateCheck = input.declarationNumber
      ? await prisma.customsDeclaration.findFirst({
          where: { declarationNumber: input.declarationNumber, deletedAt: null },
          select: { id: true },
        })
      : null;
    if (duplicateCheck) throw new Error(`报关单号 ${input.declarationNumber} 已存在`);

    const ts = now();
    const declaration = await prisma.$transaction(async (tx) => {
      const declarationNumber = input.declarationNumber || await nextBusinessNumber(tx, 'CD', undefined, {
        occupied: async (num) => {
          // ⚠️ 必须**含软删行**：declarationNumber 的唯一约束在 DB 层不排除软删行，
          // 若这里加 deletedAt: null，软删的 CD-2026-0001 会被判为「未占用」→ 生成同号
          // → P2002 → 整个事务回滚 → 用户建不了报关单（真库实测 100% 复现）。
          const dup = await tx.customsDeclaration.findFirst({ where: { declarationNumber: num }, select: { id: true } });
          return dup != null;
        },
      });
      const decl = await tx.customsDeclaration.create({
        data: {
          id: generateId('CD'),
          declarationNumber,
          shipmentId: input.shipmentId ?? null,
          orderId: input.orderId ?? null,
          relationId: input.relationId ?? null,
          type: input.type,
          status: 'Draft',
          declarationDate: input.declarationDate ?? null,
          customsCode: input.customsCode ?? null,
          declarationPort: input.declarationPort ?? null,
          tradeTerms: input.tradeTerms ?? null,
          totalValue: input.totalValue != null ? new Prisma.Decimal(input.totalValue) : null,
          currency: input.currency ?? null,
          // 运保费（报关时申报的数，币种同 currency；退税算 FOB 要用，CIF/CFR 必填）
          freightAmount: input.freightAmount != null ? new Prisma.Decimal(input.freightAmount) : null,
          insuranceAmount: input.insuranceAmount != null ? new Prisma.Decimal(input.insuranceAmount) : null,
          totalPackages: input.totalPackages ?? null,
          grossWeight: input.grossWeight != null ? new Prisma.Decimal(input.grossWeight) : null,
          netWeight: input.netWeight != null ? new Prisma.Decimal(input.netWeight) : null,
          originCountry: input.originCountry ?? null,
          destinationCountry: input.destinationCountry ?? null,
          consignee: input.consignee ?? null,
          consignor: input.consignor ?? null,
          declarant: input.declarant ?? null,
          agent: input.agent ?? null,
          notes: input.notes ?? null,
          createdAt: ts,
          updatedAt: ts,
        },
      });

      // 创建明细行
      if (input.lines && input.lines.length > 0) {
        for (let i = 0; i < input.lines.length; i++) {
          const line = input.lines[i];
          await tx.customsDeclarationLine.create({
            data: {
              id: generateId('CDL'),
              declarationId: decl.id,
              lineNumber: i + 1,
              productCode: line.productCode ?? null,
              productName: line.productName,
              hsCode: line.hsCode ?? null,
              brandName: line.brandName ?? null,
              specification: line.specification ?? null,
              quantity: new Prisma.Decimal(line.quantity),
              unit: line.unit,
              unitPrice: line.unitPrice != null ? new Prisma.Decimal(line.unitPrice) : null,
              totalAmount: line.totalAmount != null ? new Prisma.Decimal(line.totalAmount) : null,
              currency: line.currency ?? null,
              grossWeight: line.grossWeight != null ? new Prisma.Decimal(line.grossWeight) : null,
              netWeight: line.netWeight != null ? new Prisma.Decimal(line.netWeight) : null,
              originCountry: line.originCountry ?? null,
              notes: line.notes ?? null,
              createdAt: ts,
              updatedAt: ts,
            },
          });
        }
      }

      await tx.auditLog.create({
        data: {
          id: generateId('AUD'),
          action: 'CUSTOMS_DECLARATION_CREATE',
          actorId,
          targetType: 'CustomsDeclaration',
          targetId: decl.id,
          detail: { declarationNumber: decl.declarationNumber, type: decl.type },
        },
      });

      // EntityLink 图谱：clearsShipment / aboutOrder / declaredFor
      await syncCustomsDeclarationReferences(prisma, decl, { source: 'api:customs' }, tx);

      // C4 关单闭环：回填运单报关单号
      await backfillShipmentCustoms(tx, decl, false);

      return decl;
    });

    // 事件发布（fire-and-forget）
    try {
      businessEventBus.publish({
        type: 'CustomsDeclarationCreated',
        sourceEntityType: 'CustomsDeclaration',
        sourceEntityId: declaration.id,
        actorId,
        payload: { declarationNumber: declaration.declarationNumber, type: declaration.type },
        timestamp: Date.now(),
      } as any);
    } catch (e) {
      logger.warn('[CustomsService] event publish failed', { error: (e as Error)?.message });
    }

    logger.info('[CustomsService] declaration created', { id: declaration.id, declarationNumber: declaration.declarationNumber, actorId });
    return getDeclaration(declaration.id);
  }

  async function updateDeclaration(id: string, input: Partial<CustomsDeclarationInput>, actorId: string) {
    const existing = await prisma.customsDeclaration.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new Error(`报关单 ${id} 不存在`);
    if (existing.status !== 'Draft') throw new Error(`报关单状态 ${existing.status} 不可编辑（仅 Draft 可编辑）`);

    if (input.type) validateCustomsType(input.type);

    const ts = now();
    const updated = await prisma.$transaction(async (tx) => {
      const decl = await tx.customsDeclaration.update({
        where: { id },
        data: {
          ...(input.declarationNumber && input.declarationNumber !== existing.declarationNumber
            ? { declarationNumber: input.declarationNumber }
            : {}),
          ...(input.shipmentId !== undefined ? { shipmentId: input.shipmentId } : {}),
          ...(input.orderId !== undefined ? { orderId: input.orderId } : {}),
          ...(input.relationId !== undefined ? { relationId: input.relationId } : {}),
          ...(input.type ? { type: input.type } : {}),
          ...(input.declarationDate !== undefined ? { declarationDate: input.declarationDate } : {}),
          ...(input.customsCode !== undefined ? { customsCode: input.customsCode } : {}),
          ...(input.declarationPort !== undefined ? { declarationPort: input.declarationPort } : {}),
          ...(input.tradeTerms !== undefined ? { tradeTerms: input.tradeTerms } : {}),
          ...(input.totalValue !== undefined ? { totalValue: input.totalValue != null ? new Prisma.Decimal(input.totalValue) : null } : {}),
          ...(input.currency !== undefined ? { currency: input.currency } : {}),
          // 运保费：undefined = 不改；null = 清空（改回「未登记」，退税随即转回不给数）
          ...(input.freightAmount !== undefined ? { freightAmount: input.freightAmount != null ? new Prisma.Decimal(input.freightAmount) : null } : {}),
          ...(input.insuranceAmount !== undefined ? { insuranceAmount: input.insuranceAmount != null ? new Prisma.Decimal(input.insuranceAmount) : null } : {}),
          ...(input.totalPackages !== undefined ? { totalPackages: input.totalPackages } : {}),
          ...(input.grossWeight !== undefined ? { grossWeight: input.grossWeight != null ? new Prisma.Decimal(input.grossWeight) : null } : {}),
          ...(input.netWeight !== undefined ? { netWeight: input.netWeight != null ? new Prisma.Decimal(input.netWeight) : null } : {}),
          ...(input.originCountry !== undefined ? { originCountry: input.originCountry } : {}),
          ...(input.destinationCountry !== undefined ? { destinationCountry: input.destinationCountry } : {}),
          ...(input.consignee !== undefined ? { consignee: input.consignee } : {}),
          ...(input.consignor !== undefined ? { consignor: input.consignor } : {}),
          ...(input.declarant !== undefined ? { declarant: input.declarant } : {}),
          ...(input.agent !== undefined ? { agent: input.agent } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          updatedAt: ts,
        },
      });

      // ★ B220：汇总行与字段级痕挂同一个 id（transactionId），读侧能看出「这几条是同一次操作」
      const auditId = generateId('AUD');
      await tx.auditLog.create({
        data: {
          id: auditId,
          action: 'CUSTOMS_DECLARATION_UPDATE',
          actorId,
          targetType: 'CustomsDeclaration',
          targetId: id,
          detail: { fields: Object.keys(input) },
        },
      });

      // ★ B220（v3.112）：上面那条只记"**被 patch 了哪些字段名**"，没有前后值 ⇒ 变更史看得出"动了运保费"，
      //   看不出"从多少改成多少"（这正是台账里给报关单记的那格）。补字段级痕，追踪面见
      //   `CUSTOMS_DECLARATION_AUDIT_FIELDS` 的注释（比 agent 白名单多两列，那两列牵动退税）。
      //   ⓘ 前值取**事务内**这一次读：函数开头那次 `existing` 读在事务外（状态校验用它），
      //   拿它当 `before` 会在并发改单时留下"没发生过的变更"（联系人那一域 v3.111 刚被同样的问题教育过）。
      const beforeRow = await tx.customsDeclaration.findFirst({ where: { id, deletedAt: null } });
      await writeFieldAuditDiff({
        prisma: tx,
        actorId,
        source: 'api:customs',
        operation: 'CUSTOMS_DECLARATION_UPDATE_FIELD',
        targetType: 'CustomsDeclaration',
        targetId: id,
        before: customsAuditSnapshot((beforeRow ?? existing) as unknown as Record<string, unknown>),
        after: customsAuditSnapshot(decl as unknown as Record<string, unknown>),
        trackedFields: [...CUSTOMS_DECLARATION_AUDIT_FIELDS],
        operationType: 'update',
        transactionId: auditId,
      });

      // EntityLink 图谱：FK 快照随 update 同步
      await syncCustomsDeclarationReferences(prisma, decl, { source: 'api:customs' }, tx);

      return decl;
    });

    logger.info('[CustomsService] declaration updated', { id, actorId });
    return getDeclaration(updated.id);
  }

  async function deleteDeclaration(id: string, actorId: string) {
    const existing = await prisma.customsDeclaration.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new Error(`报关单 ${id} 不存在`);
    if (existing.status !== 'Draft' && existing.status !== 'Cancelled') {
      throw new Error(`报关单状态 ${existing.status} 不可删除（仅 Draft/Cancelled 可删除）`);
    }

    const ts = now();
    await prisma.$transaction(async (tx) => {
      await tx.customsDeclaration.update({
        where: { id },
        data: { deletedAt: ts, updatedAt: ts },
      });
      // EntityLink 图谱：软删同步失效发出的关联
      await deactivateEntityLinks(tx, 'customsDeclaration', id, ts);
      await tx.auditLog.create({
        data: {
          id: generateId('AUD'),
          action: 'CUSTOMS_DECLARATION_DELETE',
          actorId,
          targetType: 'CustomsDeclaration',
          targetId: id,
        },
      });
    });

    logger.info('[CustomsService] declaration deleted', { id, actorId });
    // R6 通知治理：删除报关单后回收指向它的通知（best-effort，不影响删除结果）
    sweepNotificationsForDeletedEntities(prisma, [id]).catch(() => {});
    return { id, deleted: true };
  }

  async function listDeclarations(params: {
    type?: string;
    status?: string;
    shipmentId?: string;
    orderId?: string;
    relationId?: string;
    search?: string;
    limit?: number;
    offset?: number;
    /** §10.4.2 可见订单白名单（route 层注入）；null/undefined = 不受限 */
    visibleOrderIds?: string[] | null;
    /** §10.4.2 可见运单白名单（由可见订单经分配表推导，覆盖无 orderId 的报关单） */
    visibleShipmentIds?: string[];
  } = {}) {
    const where: Prisma.CustomsDeclarationWhereInput = { deletedAt: null };
    if (params.type) where.type = params.type;
    if (params.status) where.status = params.status;
    if (params.shipmentId) where.shipmentId = params.shipmentId;
    if (params.orderId) where.orderId = params.orderId;
    if (params.relationId) where.relationId = params.relationId;
    if (params.search) {
      where.OR = [
        { declarationNumber: { contains: params.search, mode: 'insensitive' } },
        { consignee: { contains: params.search, mode: 'insensitive' } },
        { consignor: { contains: params.search, mode: 'insensitive' } },
        { agent: { contains: params.search, mode: 'insensitive' } },
      ];
    }
    // §10.4.2：报关单随关联订单可见；无 orderId 的（挂关联关系人）按运单维兜底，
    // 由 route 层解析出的 shipmentIds 一并注入。
    if (params.visibleOrderIds) {
      where.AND = [...((where as any).AND ?? []), { OR: [{ orderId: { in: params.visibleOrderIds } }, { shipmentId: { in: params.visibleShipmentIds ?? [] } }] }];
    }

    const limit = clampLimit(params.limit, 100, 500);
    const offset = clampOffset(params.offset);
    const [items, total] = await Promise.all([
      prisma.customsDeclaration.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        include: { _count: { select: { lines: true } } },
      }),
      prisma.customsDeclaration.count({ where }),
    ]);

    return { items, total };
  }

  async function getDeclaration(id: string) {
    const decl = await prisma.customsDeclaration.findFirst({
      where: { id, deletedAt: null },
      include: { lines: { orderBy: { lineNumber: 'asc' } } },
    }).catch(error => {
      if (isBusinessError(error)) throw error;
      logger.error('[CustomsService] getDeclaration source query failed', { error: error instanceof Error ? error.message : String(error) });
      throw businessError('INTERNAL_ERROR', lookupErrorCode('INTERNAL_ERROR')!.message);
    });
    if (!decl) throw businessError('DECLARATION_NOT_FOUND', `报关单 ${id} 不存在`);
    return decl;
  }

  async function transitionDeclarationStatus(id: string, toStatus: CustomsDeclarationStatus, actorId: string) {
    validateDeclarationStatus(toStatus);
    const existing = await prisma.customsDeclaration.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new Error(`报关单 ${id} 不存在`);

    validateTransition(DECLARATION_TRANSITIONS, existing.status, toStatus, '报关单');

    const ts = now();
    const updated = await prisma.$transaction(async (tx) => {
      const decl = await tx.customsDeclaration.update({
        where: { id },
        data: { status: toStatus, updatedAt: ts },
      });
      await tx.auditLog.create({
        data: {
          id: generateId('AUD'),
          action: 'CUSTOMS_DECLARATION_TRANSITION',
          actorId,
          targetType: 'CustomsDeclaration',
          targetId: id,
          detail: { from: existing.status, to: toStatus },
        },
      });
      // C4 关单闭环：放行时回填运单报关单号 + 清关日期
      if (toStatus === 'Released') {
        await backfillShipmentCustoms(tx, decl, true);
      }
      return decl;
    });

    // 事件发布
    try {
      businessEventBus.publish({
        type: 'CustomsDeclarationStatusChanged',
        sourceEntityType: 'CustomsDeclaration',
        sourceEntityId: id,
        actorId,
        payload: { from: existing.status, to: toStatus },
        timestamp: Date.now(),
      } as any);
      if (toStatus === 'Released') {
        businessEventBus.publish({
          type: 'CustomsCleared',
          sourceEntityType: 'CustomsDeclaration',
          sourceEntityId: id,
          actorId,
          payload: { declarationNumber: existing.declarationNumber },
          timestamp: Date.now(),
        } as any);
      }
    } catch (e) {
      logger.warn('[CustomsService] event publish failed', { error: (e as Error)?.message });
    }

    logger.info('[CustomsService] declaration transition', { id, from: existing.status, to: toStatus, actorId });
    return updated;
  }

  // ────────────────────────────────────────────────────────────
  // 2. HsCode（HS 编码库）
  // ────────────────────────────────────────────────────────────

  async function createHsCode(input: HsCodeInput, actorId: string) {
    validateHsCategory(input.category);

    const existing = await prisma.hsCode.findUnique({ where: { code: input.code } });
    if (existing) throw new Error(`HS 编码 ${input.code} 已存在`);

    const ts = now();
    const hsCode = await prisma.$transaction(async (tx) => {
      const code = await tx.hsCode.create({
        data: {
          id: generateId('HS'),
          code: input.code,
          description: input.description,
          category: input.category,
          exportTaxRebateRate: input.exportTaxRebateRate != null ? new Prisma.Decimal(input.exportTaxRebateRate) : null,
          importTariffRate: input.importTariffRate != null ? new Prisma.Decimal(input.importTariffRate) : null,
          vatRate: input.vatRate != null ? new Prisma.Decimal(input.vatRate) : null,
          unit: input.unit ?? null,
          supervisionCondition: input.supervisionCondition ?? null,
          inspectionQuarantine: input.inspectionQuarantine ?? null,
          additionalDuty: input.additionalDuty ?? null,
          notes: input.notes ?? null,
          isActive: input.isActive ?? true,
          createdAt: ts,
          updatedAt: ts,
        },
      });
      await tx.auditLog.create({
        data: {
          id: generateId('AUD'),
          action: 'HS_CODE_CREATE',
          actorId,
          targetType: 'HsCode',
          targetId: code.id,
          detail: { code: code.code },
        },
      });
      return code;
    });

    logger.info('[CustomsService] hsCode created', { id: hsCode.id, code: input.code, actorId });
    return hsCode;
  }

  async function updateHsCode(id: string, input: Partial<HsCodeInput>, actorId: string) {
    const existing = await prisma.hsCode.findUnique({ where: { id } });
    if (!existing) throw new Error(`HS 编码 ${id} 不存在`);

    if (input.category) validateHsCategory(input.category);
    validatePercentRate(input.exportTaxRebateRate, '出口退税率');
    validatePercentRate(input.importTariffRate, '进口关税率');
    validatePercentRate(input.vatRate, '增值税率');

    const ts = now();
    const updated = await prisma.$transaction(async (tx) => {
      const code = await tx.hsCode.update({
        where: { id },
        data: {
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.category ? { category: input.category } : {}),
          ...(input.exportTaxRebateRate !== undefined ? { exportTaxRebateRate: input.exportTaxRebateRate != null ? new Prisma.Decimal(input.exportTaxRebateRate) : null } : {}),
          ...(input.importTariffRate !== undefined ? { importTariffRate: input.importTariffRate != null ? new Prisma.Decimal(input.importTariffRate) : null } : {}),
          ...(input.vatRate !== undefined ? { vatRate: input.vatRate != null ? new Prisma.Decimal(input.vatRate) : null } : {}),
          ...(input.unit !== undefined ? { unit: input.unit } : {}),
          ...(input.supervisionCondition !== undefined ? { supervisionCondition: input.supervisionCondition } : {}),
          ...(input.inspectionQuarantine !== undefined ? { inspectionQuarantine: input.inspectionQuarantine } : {}),
          ...(input.additionalDuty !== undefined ? { additionalDuty: input.additionalDuty } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          updatedAt: ts,
        },
      });
      await tx.auditLog.create({
        data: {
          id: generateId('AUD'),
          action: 'HS_CODE_UPDATE',
          actorId,
          targetType: 'HsCode',
          targetId: id,
        },
      });
      return code;
    });

    logger.info('[CustomsService] hsCode updated', { id, actorId });
    return updated;
  }

  async function deleteHsCode(id: string, actorId: string) {
    const existing = await prisma.hsCode.findUnique({ where: { id } });
    if (!existing) throw new Error(`HS 编码 ${id} 不存在`);

    // 参考数据用 deactivate 而非物理删除
    const ts = now();
    await prisma.$transaction(async (tx) => {
      await tx.hsCode.update({
        where: { id },
        data: { isActive: false, updatedAt: ts },
      });
      await tx.auditLog.create({
        data: {
          id: generateId('AUD'),
          action: 'HS_CODE_DEACTIVATE',
          actorId,
          targetType: 'HsCode',
          targetId: id,
        },
      });
    });

    logger.info('[CustomsService] hsCode deactivated', { id, actorId });
    return { id, deactivated: true };
  }

  async function listHsCodes(params: {
    category?: string;
    search?: string;
    isActive?: boolean;
    limit?: number;
    offset?: number;
  } = {}) {
    const where: Prisma.HsCodeWhereInput = {};
    if (params.category) where.category = params.category;
    if (params.isActive !== undefined) where.isActive = params.isActive;
    if (params.search) {
      where.OR = [
        { code: { contains: params.search, mode: 'insensitive' } },
        { description: { contains: params.search, mode: 'insensitive' } },
      ];
    }

    const limit = clampLimit(params.limit, 100, 500);
    const offset = clampOffset(params.offset);
    const [items, total] = await Promise.all([
      prisma.hsCode.findMany({
        where,
        orderBy: [{ category: 'asc' }, { code: 'asc' }],
        take: limit,
        skip: offset,
      }),
      prisma.hsCode.count({ where }),
    ]);

    return { items, total };
  }

  async function getHsCodeByCode(code: string) {
    const hsCode = await prisma.hsCode.findUnique({ where: { code } });
    if (!hsCode) throw new Error(`HS 编码 ${code} 不存在`);
    return hsCode;
  }

  // ────────────────────────────────────────────────────────────
  // 3. LetterOfCredit（信用证）
  // ────────────────────────────────────────────────────────────

  async function createLetterOfCredit(input: LetterOfCreditInput, actorId: string) {
    validateLcType(input.type);

    // PRD 5.6：服务端自动生成信用证号（LC-YYYY-NNNN），传入时优先使用传入值并校验唯一性
    // QA-SEC-5：自动生成走序号占用原子追平（含软删行，防并发/历史冲突）；显式传入单号仍校验唯一
    const duplicateCheck = input.lcNumber
      ? await prisma.letterOfCredit.findFirst({
          where: { lcNumber: input.lcNumber, deletedAt: null },
          select: { id: true },
        })
      : null;
    if (duplicateCheck) throw new Error(`信用证号 ${input.lcNumber} 已存在`);

    let lcNumber = input.lcNumber ?? '';
    const ts = now();
    const lc = await prisma.$transaction(async (tx) => {
      lcNumber = input.lcNumber || await nextBusinessNumber(tx, 'LC', undefined, {
        occupied: async (num) => {
          // 含软删行（理由同 createDeclaration：唯一约束不排除软删行，过滤了就会撞号）
          const dup = await tx.letterOfCredit.findFirst({ where: { lcNumber: num }, select: { id: true } });
          return dup != null;
        },
      });
      const letterOfCredit = await tx.letterOfCredit.create({
        data: {
          id: generateId('LC'),
          lcNumber,
          relationId: input.relationId ?? null,
          orderId: input.orderId ?? null,
          type: input.type,
          status: 'Issued',
          issueDate: input.issueDate ?? null,
          issueBank: input.issueBank ?? null,
          advisingBank: input.advisingBank ?? null,
          negotiatingBank: input.negotiatingBank ?? null,
          confirmingBank: input.confirmingBank ?? null,
          applicant: input.applicant ?? null,
          beneficiary: input.beneficiary ?? null,
          amount: new Prisma.Decimal(input.amount),
          currency: input.currency ?? 'USD',
          availableAmount: input.availableAmount != null ? new Prisma.Decimal(input.availableAmount) : new Prisma.Decimal(input.amount),
          expiryDate: input.expiryDate ?? null,
          expiryPlace: input.expiryPlace ?? null,
          presentationDeadline: input.presentationDeadline ?? null,
          shipmentDeadline: input.shipmentDeadline ?? null,
          tradeTerms: input.tradeTerms ?? null,
          portOfLoading: input.portOfLoading ?? null,
          portOfDischarge: input.portOfDischarge ?? null,
          documentsRequired: input.documentsRequired ?? Prisma.JsonNull,
          specialConditions: input.specialConditions ?? null,
          discrepancies: input.discrepancies ?? null,
          notes: input.notes ?? null,
          createdAt: ts,
          updatedAt: ts,
        },
      });
      await tx.auditLog.create({
        data: {
          id: generateId('AUD'),
          action: 'LC_CREATE',
          actorId,
          targetType: 'LetterOfCredit',
          targetId: letterOfCredit.id,
          detail: { lcNumber: letterOfCredit.lcNumber, type: letterOfCredit.type, amount: input.amount },
        },
      });
      // F1：首节点事件（开证登记）+ 图谱入链，同事务保证节点可追溯
      await tx.lcEvent.create({
        data: {
          id: generateId('LCE'),
          lcId: letterOfCredit.id,
          fromNode: null,
          toNode: 'Issued',
          eventDate: input.issueDate ?? todayLocalKey(),
          note: null,
          actorId,
          createdAt: ts,
        },
      });
      await syncLetterOfCreditReferences(prisma, letterOfCredit, { source: 'api:customs' }, tx);
      return letterOfCredit;
    });

    logger.info('[CustomsService] letterOfCredit created', { id: lc.id, lcNumber, actorId });
    return lc;
  }

  async function updateLetterOfCredit(id: string, input: Partial<LetterOfCreditInput>, actorId: string) {
    const existing = await prisma.letterOfCredit.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new Error(`信用证 ${id} 不存在`);
    if (existing.status !== 'Issued') throw new Error(`信用证状态 ${existing.status} 不可编辑（仅 Issued 可编辑）`);

    if (input.type) validateLcType(input.type);

    const ts = now();
    const updated = await prisma.$transaction(async (tx) => {
      const lc = await tx.letterOfCredit.update({
        where: { id },
        data: {
          ...(input.relationId !== undefined ? { relationId: input.relationId } : {}),
          ...(input.orderId !== undefined ? { orderId: input.orderId } : {}),
          ...(input.type ? { type: input.type } : {}),
          ...(input.issueDate !== undefined ? { issueDate: input.issueDate } : {}),
          ...(input.issueBank !== undefined ? { issueBank: input.issueBank } : {}),
          ...(input.advisingBank !== undefined ? { advisingBank: input.advisingBank } : {}),
          ...(input.negotiatingBank !== undefined ? { negotiatingBank: input.negotiatingBank } : {}),
          ...(input.confirmingBank !== undefined ? { confirmingBank: input.confirmingBank } : {}),
          ...(input.applicant !== undefined ? { applicant: input.applicant } : {}),
          ...(input.beneficiary !== undefined ? { beneficiary: input.beneficiary } : {}),
          ...(input.amount !== undefined ? { amount: new Prisma.Decimal(input.amount) } : {}),
          ...(input.currency !== undefined ? { currency: input.currency } : {}),
          ...(input.availableAmount !== undefined ? { availableAmount: input.availableAmount != null ? new Prisma.Decimal(input.availableAmount) : null } : {}),
          ...(input.expiryDate !== undefined ? { expiryDate: input.expiryDate } : {}),
          ...(input.expiryPlace !== undefined ? { expiryPlace: input.expiryPlace } : {}),
          ...(input.presentationDeadline !== undefined ? { presentationDeadline: input.presentationDeadline } : {}),
          ...(input.shipmentDeadline !== undefined ? { shipmentDeadline: input.shipmentDeadline } : {}),
          ...(input.tradeTerms !== undefined ? { tradeTerms: input.tradeTerms } : {}),
          ...(input.portOfLoading !== undefined ? { portOfLoading: input.portOfLoading } : {}),
          ...(input.portOfDischarge !== undefined ? { portOfDischarge: input.portOfDischarge } : {}),
          ...(input.documentsRequired !== undefined ? { documentsRequired: input.documentsRequired ?? Prisma.JsonNull } : {}),
          ...(input.specialConditions !== undefined ? { specialConditions: input.specialConditions } : {}),
          ...(input.discrepancies !== undefined ? { discrepancies: input.discrepancies } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          updatedAt: ts,
        },
      });
      await tx.auditLog.create({
        data: {
          id: generateId('AUD'),
          action: 'LC_UPDATE',
          actorId,
          targetType: 'LetterOfCredit',
          targetId: id,
        },
      });
      // F1：关联（relationId/orderId）可能变更，事务内重建图谱链接
      await syncLetterOfCreditReferences(prisma, lc, { source: 'api:customs' }, tx);
      return lc;
    });

    logger.info('[CustomsService] letterOfCredit updated', { id, actorId });
    return updated;
  }

  async function deleteLetterOfCredit(id: string, actorId: string) {
    const existing = await prisma.letterOfCredit.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new Error(`信用证 ${id} 不存在`);
    if (existing.status !== 'Issued' && existing.status !== 'Cancelled') {
      throw new Error(`信用证状态 ${existing.status} 不可删除（仅 Issued/Cancelled 可删除）`);
    }

    const ts = now();
    await prisma.$transaction(async (tx) => {
      await tx.letterOfCredit.update({
        where: { id },
        data: { deletedAt: ts, updatedAt: ts },
      });
      await tx.auditLog.create({
        data: {
          id: generateId('AUD'),
          action: 'LC_DELETE',
          actorId,
          targetType: 'LetterOfCredit',
          targetId: id,
        },
      });
      // F1：软删同步停用图谱链接（LcEvent 节点历史保留，append-only 不删）
      await deactivateEntityLinks(tx, 'letterOfCredit', id, ts);
    });

    logger.info('[CustomsService] letterOfCredit deleted', { id, actorId });
    return { id, deleted: true };
  }

  async function listLettersOfCredit(params: {
    status?: string;
    relationId?: string;
    orderId?: string;
    issuingBank?: string;
    expiringBefore?: string;
    search?: string;
    limit?: number;
    offset?: number;
  } = {}) {
    const where: Prisma.LetterOfCreditWhereInput = { deletedAt: null };
    if (params.status) where.status = params.status;
    if (params.relationId) where.relationId = params.relationId;
    if (params.orderId) where.orderId = params.orderId;
    if (params.issuingBank) where.issueBank = { contains: params.issuingBank, mode: 'insensitive' };
    // 到期预警：expiryDate 为 YYYY-MM-DD 字符串，字典序比较与全项目日期口径一致
    if (params.expiringBefore) where.expiryDate = { not: null, lt: params.expiringBefore };
    if (params.search) {
      where.OR = [
        { lcNumber: { contains: params.search, mode: 'insensitive' } },
        { applicant: { contains: params.search, mode: 'insensitive' } },
        { beneficiary: { contains: params.search, mode: 'insensitive' } },
        { issueBank: { contains: params.search, mode: 'insensitive' } },
      ];
    }

    const limit = params.limit ?? 100;
    const offset = params.offset ?? 0;
    const [items, total] = await Promise.all([
      prisma.letterOfCredit.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.letterOfCredit.count({ where }),
    ]);

    return { items, total };
  }

  async function getLetterOfCredit(id: string) {
    const lc = await prisma.letterOfCredit.findFirst({
      where: { id, deletedAt: null },
    });
    if (!lc) throw new Error(`信用证 ${id} 不存在`);
    return lc;
  }

  async function getLetterOfCreditByNumber(lcNumber: string) {
    const lc = await prisma.letterOfCredit.findFirst({
      where: { lcNumber, deletedAt: null },
    });
    if (!lc) throw new Error(`信用证 ${lcNumber} 不存在`);
    return lc;
  }

  async function transitionLcStatus(id: string, toStatus: LetterOfCreditStatus, actorId: string, discrepancies?: string) {
    validateLcStatus(toStatus);
    const existing = await prisma.letterOfCredit.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new Error(`信用证 ${id} 不存在`);

    validateTransition(LC_TRANSITIONS, existing.status, toStatus, '信用证');

    const ts = now();
    const updated = await prisma.$transaction(async (tx) => {
      const lc = await tx.letterOfCredit.update({
        where: { id },
        data: {
          status: toStatus,
          ...(discrepancies !== undefined && toStatus === 'Discrepant' ? { discrepancies } : {}),
          updatedAt: ts,
        },
      });
      await tx.auditLog.create({
        data: {
          id: generateId('AUD'),
          action: 'LC_TRANSITION',
          actorId,
          targetType: 'LetterOfCredit',
          targetId: id,
          detail: { from: existing.status, to: toStatus },
        },
      });
      // F1：节点事件入时间轴（同事务）；不符点内容落入 note，便于时间轴直接展示
      await tx.lcEvent.create({
        data: {
          id: generateId('LCE'),
          lcId: id,
          fromNode: existing.status,
          toNode: toStatus,
          eventDate: todayLocalKey(),
          note: toStatus === 'Discrepant' ? (discrepancies ?? existing.discrepancies ?? null) : null,
          actorId,
          createdAt: ts,
        },
      });
      return lc;
    });

    // F1：状态变更事件（事务提交后发布，fire-and-forget 不阻断业务）
    try {
      businessEventBus.publish({
        type: 'LcStatusChanged',
        sourceEntityType: 'LetterOfCredit',
        sourceEntityId: id,
        actorId,
        payload: { lcId: id, lcNumber: existing.lcNumber, from: existing.status, to: toStatus },
        timestamp: Date.now(),
      } as any);
    } catch (e) {
      logger.warn('[CustomsService] event publish failed', { error: (e as Error)?.message });
    }

    logger.info('[CustomsService] letterOfCredit transition', { id, from: existing.status, to: toStatus, actorId });
    return updated;
  }

  /** F1：信用证节点时间轴（按业务日期 + 创建时间升序，append-only 全量返回） */
  async function listLcEvents(lcId: string) {
    const lc = await prisma.letterOfCredit.findFirst({
      where: { id: lcId, deletedAt: null },
      select: { id: true },
    });
    if (!lc) throw new Error(`信用证 ${lcId} 不存在`);
    const items = await prisma.lcEvent.findMany({
      where: { lcId },
      orderBy: [{ eventDate: 'asc' }, { createdAt: 'asc' }],
    });
    return { items, total: items.length };
  }

  // ────────────────────────────────────────────────────────────
  // 4. TaxRefund（出口退税）
  // ────────────────────────────────────────────────────────────

  async function createTaxRefund(input: TaxRefundInput, actorId: string) {
    // PRD 5.6：服务端自动生成退税编号（TR-YYYY-NNNN），传入时优先使用传入值并校验唯一性
    // QA-SEC-5：自动生成走序号占用原子追平（含软删行，防并发/历史冲突）；显式传入单号仍校验唯一
    const duplicateCheck = input.refundNumber
      ? await prisma.taxRefund.findFirst({
          where: { refundNumber: input.refundNumber, deletedAt: null },
          select: { id: true },
        })
      : null;
    if (duplicateCheck) throw new Error(`退税编号 ${input.refundNumber} 已存在`);

    // 自动计算退税额：refundAmount = exportAmountCny × refundableRate / 100
    // 单位锚死（勿再踩）：refundableRate 口径为**百分数**（TaxRefund.refundableRate 注释「退税率(%)」，
    // 如 13 表示 13%），故须 /100。历史实现漏除导致退税额放大 100 倍。
    let refundAmount = input.refundAmount;
    if (refundAmount == null && input.exportAmountCny != null && input.refundableRate != null) {
      refundAmount = Math.round((input.exportAmountCny * input.refundableRate / 100) * 10000) / 10000;
    }

    const ts = now();
    const refund = await prisma.$transaction(async (tx) => {
      const refundNumber = input.refundNumber || await nextBusinessNumber(tx, 'TR', undefined, {
        occupied: async (num) => {
          // 含软删行（理由同 createDeclaration：唯一约束不排除软删行，过滤了就会撞号）
          const dup = await tx.taxRefund.findFirst({ where: { refundNumber: num }, select: { id: true } });
          return dup != null;
        },
      });
      const tr = await tx.taxRefund.create({
        data: {
          id: generateId('TR'),
          refundNumber,
          declarationId: input.declarationId ?? null,
          orderId: input.orderId ?? null,
          relationId: input.relationId ?? null,
          status: 'Draft',
          exportDate: input.exportDate ?? null,
          declarationDate: input.declarationDate ?? null,
          fxRate: input.fxRate != null ? new Prisma.Decimal(input.fxRate) : null,
          exportAmountFob: input.exportAmountFob != null ? new Prisma.Decimal(input.exportAmountFob) : null,
          exportAmountFobCurrency: input.exportAmountFobCurrency ?? null,
          exportAmountCny: input.exportAmountCny != null ? new Prisma.Decimal(input.exportAmountCny) : null,
          refundableVat: input.refundableVat != null ? new Prisma.Decimal(input.refundableVat) : null,
          refundableRate: input.refundableRate != null ? new Prisma.Decimal(input.refundableRate) : null,
          refundAmount: refundAmount != null ? new Prisma.Decimal(refundAmount) : null,
          refundDate: input.refundDate ?? null,
          notes: input.notes ?? null,
          createdAt: ts,
          updatedAt: ts,
        },
      });
      await tx.auditLog.create({
        data: {
          id: generateId('AUD'),
          action: 'TAX_REFUND_CREATE',
          actorId,
          targetType: 'TaxRefund',
          targetId: tr.id,
          detail: { refundNumber: tr.refundNumber },
        },
      });
      // EntityLink 图谱：refundsDeclaration / aboutOrder / refundTo
      await syncTaxRefundReferences(prisma, tr, { source: 'api:customs' }, tx);
      return tr;
    });

    logger.info('[CustomsService] taxRefund created', { id: refund.id, refundNumber: input.refundNumber, actorId });
    return refund;
  }

  async function updateTaxRefund(id: string, input: Partial<TaxRefundInput>, actorId: string) {
    const existing = await prisma.taxRefund.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new Error(`退税记录 ${id} 不存在`);
    if (existing.status !== 'Draft') throw new Error(`退税状态 ${existing.status} 不可编辑（仅 Draft 可编辑）`);

    // 重新计算退税额
    let refundAmount = input.refundAmount;
    const exportAmountCny = input.exportAmountCny != null ? input.exportAmountCny : Number(existing.exportAmountCny);
    const refundableRate = input.refundableRate != null ? input.refundableRate : Number(existing.refundableRate);
    if (refundAmount == null && exportAmountCny != null && refundableRate != null) {
      refundAmount = Math.round(exportAmountCny * refundableRate * 10000) / 10000;
    }

    const ts = now();
    const updated = await prisma.$transaction(async (tx) => {
      const tr = await tx.taxRefund.update({
        where: { id },
        data: {
          ...(input.declarationId !== undefined ? { declarationId: input.declarationId } : {}),
          ...(input.orderId !== undefined ? { orderId: input.orderId } : {}),
          ...(input.relationId !== undefined ? { relationId: input.relationId } : {}),
          ...(input.exportDate !== undefined ? { exportDate: input.exportDate } : {}),
          ...(input.declarationDate !== undefined ? { declarationDate: input.declarationDate } : {}),
          ...(input.fxRate !== undefined ? { fxRate: input.fxRate != null ? new Prisma.Decimal(input.fxRate) : null } : {}),
          ...(input.exportAmountFob !== undefined ? { exportAmountFob: input.exportAmountFob != null ? new Prisma.Decimal(input.exportAmountFob) : null } : {}),
          ...(input.exportAmountFobCurrency !== undefined ? { exportAmountFobCurrency: input.exportAmountFobCurrency } : {}),
          ...(input.exportAmountCny !== undefined ? { exportAmountCny: input.exportAmountCny != null ? new Prisma.Decimal(input.exportAmountCny) : null } : {}),
          ...(input.refundableVat !== undefined ? { refundableVat: input.refundableVat != null ? new Prisma.Decimal(input.refundableVat) : null } : {}),
          ...(input.refundableRate !== undefined ? { refundableRate: input.refundableRate != null ? new Prisma.Decimal(input.refundableRate) : null } : {}),
          ...(refundAmount !== undefined && refundAmount != null ? { refundAmount: new Prisma.Decimal(refundAmount) } : {}),
          ...(input.refundDate !== undefined ? { refundDate: input.refundDate } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          updatedAt: ts,
        },
      });
      await tx.auditLog.create({
        data: {
          id: generateId('AUD'),
          action: 'TAX_REFUND_UPDATE',
          actorId,
          targetType: 'TaxRefund',
          targetId: id,
        },
      });
      // EntityLink 图谱：FK 快照随 update 同步
      await syncTaxRefundReferences(prisma, tr, { source: 'api:customs' }, tx);
      return tr;
    });

    logger.info('[CustomsService] taxRefund updated', { id, actorId });
    return updated;
  }

  async function deleteTaxRefund(id: string, actorId: string) {
    const existing = await prisma.taxRefund.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new Error(`退税记录 ${id} 不存在`);
    if (existing.status !== 'Draft' && existing.status !== 'Cancelled') {
      throw new Error(`退税状态 ${existing.status} 不可删除（仅 Draft/Cancelled 可删除）`);
    }

    const ts = now();
    await prisma.$transaction(async (tx) => {
      await tx.taxRefund.update({
        where: { id },
        data: { deletedAt: ts, updatedAt: ts },
      });
      // EntityLink 图谱：软删同步失效发出的关联
      await deactivateEntityLinks(tx, 'taxRefund', id, ts);
      await tx.auditLog.create({
        data: {
          id: generateId('AUD'),
          action: 'TAX_REFUND_DELETE',
          actorId,
          targetType: 'TaxRefund',
          targetId: id,
        },
      });
    });

    logger.info('[CustomsService] taxRefund deleted', { id, actorId });
    return { id, deleted: true };
  }

  async function listTaxRefunds(params: {
    status?: string;
    declarationId?: string;
    orderId?: string;
    relationId?: string;
    search?: string;
    limit?: number;
    offset?: number;
  } = {}) {
    const where: Prisma.TaxRefundWhereInput = { deletedAt: null };
    if (params.status) where.status = params.status;
    if (params.declarationId) where.declarationId = params.declarationId;
    if (params.orderId) where.orderId = params.orderId;
    if (params.relationId) where.relationId = params.relationId;
    if (params.search) {
      where.OR = [
        { refundNumber: { contains: params.search, mode: 'insensitive' } },
      ];
    }

    const limit = params.limit ?? 100;
    const offset = params.offset ?? 0;
    const [items, total] = await Promise.all([
      prisma.taxRefund.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.taxRefund.count({ where }),
    ]);

    return { items, total };
  }

  async function getTaxRefund(id: string) {
    const tr = await prisma.taxRefund.findFirst({
      where: { id, deletedAt: null },
    }).catch(error => {
      if (isBusinessError(error)) throw error;
      logger.error('[CustomsService] getTaxRefund source query failed', { error: error instanceof Error ? error.message : String(error) });
      throw businessError('INTERNAL_ERROR', lookupErrorCode('INTERNAL_ERROR')!.message);
    });
    if (!tr) throw businessError('TAX_REFUND_NOT_FOUND', `退税记录 ${id} 不存在`);
    return tr;
  }

  async function transitionTaxRefundStatus(id: string, toStatus: TaxRefundStatus, actorId: string) {
    validateTaxRefundStatus(toStatus);
    const existing = await prisma.taxRefund.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new Error(`退税记录 ${id} 不存在`);

    validateTransition(TAX_REFUND_TRANSITIONS, existing.status, toStatus, '退税');

    const ts = now();
    const updated = await prisma.$transaction(async (tx) => {
      const tr = await tx.taxRefund.update({
        where: { id },
        data: { status: toStatus, updatedAt: ts },
      });
      await tx.auditLog.create({
        data: {
          id: generateId('AUD'),
          action: 'TAX_REFUND_TRANSITION',
          actorId,
          targetType: 'TaxRefund',
          targetId: id,
          detail: { from: existing.status, to: toStatus },
        },
      });
      return tr;
    });

    // 退税到账事件
    if (toStatus === 'Refunded') {
      try {
        businessEventBus.publish({
          type: 'TaxRefundCompleted',
          sourceEntityType: 'TaxRefund',
          sourceEntityId: id,
          actorId,
          payload: { refundNumber: existing.refundNumber },
          timestamp: Date.now(),
        } as any);
      } catch (e) {
        logger.warn('[CustomsService] event publish failed', { error: (e as Error)?.message });
      }
    }

    logger.info('[CustomsService] taxRefund transition', { id, from: existing.status, to: toStatus, actorId });
    return updated;
  }

  async function reviewTaxRefund(id: string, input: TaxRefundReviewInput, actorId: string) {
    const existing = await prisma.taxRefund.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new Error(`退税记录 ${id} 不存在`);
    if (existing.status !== 'Reviewing') throw new Error(`退税状态 ${existing.status} 不可审核（仅 Reviewing 可审核）`);

    const toStatus = input.decision === 'Approved' ? 'Approved' : 'Rejected';
    // G3：审核留痕取真实登录人——actorId 由路由层从认证身份（JWT）解析，请求体 reviewedBy 不再受信，仅作无身份兜底
    const reviewedBy = actorId?.trim() || input.reviewedBy?.trim() || 'system';
    const ts = now();
    const updated = await prisma.$transaction(async (tx) => {
      const tr = await tx.taxRefund.update({
        where: { id },
        data: {
          status: toStatus,
          reviewedBy,
          reviewedAt: ts,
          reviewNotes: input.reviewNotes ?? null,
          ...(input.refundAmount != null ? { refundAmount: new Prisma.Decimal(input.refundAmount) } : {}),
          updatedAt: ts,
        },
      });
      await tx.auditLog.create({
        data: {
          id: generateId('AUD'),
          action: 'TAX_REFUND_REVIEW',
          actorId,
          targetType: 'TaxRefund',
          targetId: id,
          detail: { decision: input.decision, reviewedBy },
        },
      });
      return tr;
    });

    logger.info('[CustomsService] taxRefund reviewed', { id, decision: input.decision, actorId, reviewedBy });
    return updated;
  }

  /**
   * 从报关单自动核算生成退税申报草稿（B1 收汇→结汇→退税闭环核心）
   *
   * 数据装配（单一回退链）：
   *   - FOB 金额：行明细 totalAmount 合计 → 回退报关单 totalValue，**再按成交方式剥离运保费**
   *     （CIF/CFR 时上面得到的是含运保费的申报毛额，必须剥离才是退税基数；
   *      剥不出（缺登记/D 组/剥成 ≤0）→ 不给数，绝不回退成毛额）
   *   - 汇率快照：应收发票 exchangeRate（开票当日） → 回收款凭证 exchangeRate（实际收汇日）
   *   - 出口日期：关联运单 atd（实际离港） → 回退申报日期
   *   - 退税率：按行 HS 编码查 HsCode.exportTaxRebateRate，加权汇总 refundableVat
   *     （行金额先按 FOB/毛额比例缩到 FOB 口径，否则退税额仍按毛额虚高）
   *
   * 幂等：同一报关单仅允许一份未删除退税申报（业务层去重，L10 联动与手动触发共用）
   */
  async function createTaxRefundFromDeclaration(declarationId: string, actorId: string) {
    const dup = await prisma.taxRefund.findFirst({
      where: { declarationId, deletedAt: null },
      select: { id: true, refundNumber: true },
    });
    if (dup) throw new Error(`报关单已存在退税申报 ${dup.refundNumber}，不可重复生成`);

    // T7-④：核算抽到 taxRefundCalcService（**单一算法真源**——与「报缺 / 补齐后重算」共用，
    // 避免「自动生成的金额」与「重算后的金额」两套算法漂移）。
    const f = await computeTaxRefundFigures(prisma, declarationId);
    if (!f) throw new Error(`报关单 ${declarationId} 不存在`);

    const refund = await createTaxRefund({
      refundNumber: `TRA-${f.declarationNumber}`,
      declarationId: f.declarationId,
      orderId: f.orderId ?? undefined,
      relationId: f.relationId ?? undefined,
      exportDate: f.exportDate ?? undefined,
      declarationDate: f.declarationDate ?? undefined,
      fxRate: f.fxRate ?? undefined,
      exportAmountFob: f.exportAmountFob ?? undefined,
      exportAmountFobCurrency: f.exportAmountFobCurrency ?? undefined,
      exportAmountCny: f.exportAmountCny ?? undefined,
      refundableVat: f.refundableVat ?? undefined,
      refundableRate: f.refundableRate ?? undefined,
      refundAmount: f.refundAmount ?? undefined,
      notes: `由报关单 ${f.declarationNumber} 放行自动核算生成`,
    }, actorId);

    logger.info('[CustomsService] taxRefund auto-created from declaration', {
      id: refund.id,
      declarationId,
      exportAmountFob: f.exportAmountFob,
      fxRate: f.fxRate,
      refundableVat: f.refundableVat,
    });
    return refund;
  }

  // ────────────────────────────────────────────────────────────
  // 5. TradeDocument（贸易单据）
  // ────────────────────────────────────────────────────────────

  async function createTradeDocument(input: TradeDocumentInput, actorId: string, ciOptions?: Omit<CiInvoiceSourceOptions, 'mode'>) {
    rejectGenericSupplierDocumentWrite(input);
    if (input.type === 'CommercialInvoice') {
      if (!ciOptions?.trustedActor?.userId || actorId !== ciOptions.trustedActor.userId) throw businessError('UNAUTHORIZED', '商业发票登记需要当前可信登录身份。');
      if (input.shipmentId !== undefined && input.shipmentId !== ciOptions.shipmentId) throw businessError('CONFLICT', '登记本票来源与当前业务对象不一致。');
      if (Object.keys(input).some(key => !['type', 'shipmentId'].includes(key))) throw businessError('CONFLICT', '商业发票内容只引用原财务发票，请在原发票流程编辑。');
      return (await registerCanonicalCi(prisma, { ...ciOptions, mode: 'register' })).document;
    }
    await rejectGenericPackingListWrite(prisma, null, input);
    validateDocType(input.type);
    // 手动入口仅允许 customs 交单类型——域单据（PO/IR/Contract）由业务模块带 sourceRef 就地生成
    if (!MANUALLY_CREATABLE_DOC_TYPES.includes(input.type)) {
      throw new Error(`单据类型 ${input.type} 由业务模块就地生成，不支持手动创建`);
    }

    let linkedLetterOfCredit: { id: string; orderId: string | null; relationId: string | null } | null = null;
    if (input.sourceRef !== undefined) {
      if (typeof input.sourceRef !== 'string' || !input.sourceRef.trim() || !EXTERNAL_ARCHIVE_DOC_TYPES.has(input.type)) {
        throw businessError('VALIDATION_FAILED', '信用证回链仅适用于第三方签发的外部单据。');
      }
      linkedLetterOfCredit = await prisma.letterOfCredit.findFirst({
        where: { id: input.sourceRef.trim(), deletedAt: null },
        select: { id: true, orderId: true, relationId: true },
      });
      if (!linkedLetterOfCredit) throw businessError('NOT_FOUND', '所关联的信用证不存在或已删除。');
      if (input.orderId !== undefined && input.orderId !== linkedLetterOfCredit.orderId) throw businessError('CONFLICT', '订单必须与所关联信用证的订单一致。');
      if (input.relationId !== undefined && input.relationId !== linkedLetterOfCredit.relationId) throw businessError('CONFLICT', '客户必须与所关联信用证的客户一致。');
    }

    const manualNumber = input.documentNumber?.trim() || '';
    if (manualNumber) {
      const existing = await prisma.tradeDocument.findFirst({
        where: { documentNumber: manualNumber, deletedAt: null },
        select: { id: true },
      });
      if (existing) throw new Error(`单据编号 ${manualNumber} 已存在`);
    }

    // 自动取号（留空时）+ unique 冲突重试：并发下同号则重取，最多 3 次
    for (let attempt = 0; attempt < 3; attempt++) {
      const ts = now();
      try {
        const doc = await prisma.$transaction(async (tx) => {
          const documentNumber = manualNumber || await generateTradeDocumentNumber(tx, input.type);
          const document = await tx.tradeDocument.create({
            data: {
              id: generateId('TD'),
              documentNumber,
              type: input.type,
              status: 'Draft',
              shipmentId: input.shipmentId ?? null,
              declarationId: input.declarationId ?? null,
              orderId: linkedLetterOfCredit ? linkedLetterOfCredit.orderId : input.orderId ?? null,
              relationId: linkedLetterOfCredit ? linkedLetterOfCredit.relationId : input.relationId ?? null,
              sourceRef: linkedLetterOfCredit?.id ?? null,
              issueDate: input.issueDate ?? null,
              expiryDate: input.expiryDate ?? null,
              issuedBy: input.issuedBy ?? null,
              consignee: input.consignee ?? null,
              consignor: input.consignor ?? null,
              portOfLoading: input.portOfLoading ?? null,
              portOfDischarge: input.portOfDischarge ?? null,
              totalAmount: input.totalAmount != null ? new Prisma.Decimal(input.totalAmount) : null,
              currency: input.currency ?? null,
              filePath: input.filePath ?? null,
              fileName: input.fileName ?? null,
              notes: input.notes ?? null,
              createdAt: ts,
              updatedAt: ts,
            },
          });
          // 服务端强制留痕：创建即 v1（整行字段快照），不依赖客户端自觉
          await appendTradeDocumentVersion(tx, {
            documentId: document.id,
            content: toTradeDocumentSnapshot(document),
            actorId,
            changeReason: '创建',
          });
          await tx.auditLog.create({
            data: {
              id: generateId('AUD'),
              action: 'TRADE_DOCUMENT_CREATE',
              actorId,
              targetType: 'TradeDocument',
              targetId: document.id,
              detail: { documentNumber: document.documentNumber, type: document.type },
            },
          });
          return document;
        });

        logger.info('[CustomsService] tradeDocument created', { id: doc.id, documentNumber: doc.documentNumber, actorId });
        return doc;
      } catch (e: any) {
        // 仅自动取号路径对 unique 冲突重试；手动编号冲突直接抛「已存在」语义外的错误
        const isUniqueConflict = e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
        if (!manualNumber && isUniqueConflict && attempt < 2) continue;
        throw e;
      }
    }
    throw new Error('单据编号生成失败，请重试');
  }

  async function updateTradeDocument(id: string, input: Partial<TradeDocumentInput>, actorId: string) {
    const existing = await prisma.tradeDocument.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new Error(`贸易单据 ${id} 不存在`);
    rejectGenericSupplierDocumentWrite(existing, input);
    if (input.sourceRef !== undefined && input.sourceRef !== existing.sourceRef) throw businessError('CONFLICT', '业务来源回链创建后不可直接修改；请从正确的信用证重新建档。');
    await rejectGenericPackingListWrite(prisma, existing, input);
    if (existing.type === 'CommercialInvoice' || input.type === 'CommercialInvoice') throw businessError('CONFLICT', '商业发票引用原财务票，不支持改类型、来源、金额或手动编辑；请回原发票流程。');
    if (existing.status !== 'Draft') throw new Error(`单据状态 ${existing.status} 不可编辑（仅 Draft 可编辑）`);

    if (input.type) validateDocType(input.type);

    const ts = now();
    const updated = await prisma.$transaction(async (tx) => {
      await rejectGenericPackingListWrite(tx, await tx.tradeDocument.findFirst({ where: { id, deletedAt: null } }), input);
      const doc = await tx.tradeDocument.update({
        where: { id },
        data: {
          ...(input.type ? { type: input.type } : {}),
          ...(input.shipmentId !== undefined ? { shipmentId: input.shipmentId } : {}),
          ...(input.declarationId !== undefined ? { declarationId: input.declarationId } : {}),
          ...(input.orderId !== undefined ? { orderId: input.orderId } : {}),
          ...(input.relationId !== undefined ? { relationId: input.relationId } : {}),
          ...(input.issueDate !== undefined ? { issueDate: input.issueDate } : {}),
          ...(input.expiryDate !== undefined ? { expiryDate: input.expiryDate } : {}),
          ...(input.issuedBy !== undefined ? { issuedBy: input.issuedBy } : {}),
          ...(input.consignee !== undefined ? { consignee: input.consignee } : {}),
          ...(input.consignor !== undefined ? { consignor: input.consignor } : {}),
          ...(input.portOfLoading !== undefined ? { portOfLoading: input.portOfLoading } : {}),
          ...(input.portOfDischarge !== undefined ? { portOfDischarge: input.portOfDischarge } : {}),
          ...(input.totalAmount !== undefined ? { totalAmount: input.totalAmount != null ? new Prisma.Decimal(input.totalAmount) : null } : {}),
          ...(input.currency !== undefined ? { currency: input.currency } : {}),
          ...(input.filePath !== undefined ? { filePath: input.filePath } : {}),
          ...(input.fileName !== undefined ? { fileName: input.fileName } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          updatedAt: ts,
        },
      });
      // 服务端强制留痕：字段更新后整行快照（max+1），不依赖客户端自觉
      await appendTradeDocumentVersion(tx, {
        documentId: doc.id,
        content: toTradeDocumentSnapshot(doc),
        actorId,
        changeReason: input.changeReason ?? '更新',
      });
      await tx.auditLog.create({
        data: {
          id: generateId('AUD'),
          action: 'TRADE_DOCUMENT_UPDATE',
          actorId,
          targetType: 'TradeDocument',
          targetId: id,
        },
      });
      return doc;
    });

    logger.info('[CustomsService] tradeDocument updated', { id, actorId });
    return updated;
  }

  async function deleteTradeDocument(id: string, actorId: string, ciAuthority?: CiDocumentMetadataOptions) {
    const existing = await prisma.tradeDocument.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new Error(`贸易单据 ${id} 不存在`);
    rejectGenericSupplierDocumentWrite(existing);
    if (await isPackingListCandidateInTx(prisma, existing)) {
      await prisma.$transaction(async tx => {
        const before = await authorizePackingListMetadataInTx(tx, id, ciAuthority?.trustedActor ?? null);
        if (actorId !== ciAuthority?.trustedActor?.userId || ciAuthority?.trustedAuthSource !== 'user-session') throw businessError('UNAUTHORIZED', '装箱单操作需要当前可信登录身份。');
        if (!['Draft','Cancelled'].includes(before.document.status)) throw businessError('VALIDATION_FAILED', '仅 Draft/Cancelled 装箱单可删除。');
        const ts = now();
        await tx.tradeDocument.update({ where: { id }, data: { deletedAt: ts, updatedAt: ts } });
        await tx.auditLog.create({ data: { id: generateId('AUD'), action: 'TRADE_DOCUMENT_DELETE', actorId, targetType: 'TradeDocument', targetId: id,
          detail: { versionId: before.item.id, contentHash: before.fingerprint } } });
        await finishPackingListMetadataInTx(tx, ciAuthority?.trustedActor ?? null, before);
      });
      return { id, deleted: true };
    }
    if (existing.type === 'CommercialInvoice') await assertCiDocumentMetadataDelete(prisma, id, actorId, ciAuthority);
    if (existing.status !== 'Draft' && existing.status !== 'Cancelled') {
      throw new Error(`单据状态 ${existing.status} 不可删除（仅 Draft/Cancelled 可删除）`);
    }

    const ts = now();
    await prisma.$transaction(async (tx) => {
      await tx.tradeDocument.update({
        where: { id },
        data: { deletedAt: ts, updatedAt: ts },
      });
      await tx.auditLog.create({
        data: {
          id: generateId('AUD'),
          action: 'TRADE_DOCUMENT_DELETE',
          actorId,
          targetType: 'TradeDocument',
          targetId: id,
        },
      });
    });

    logger.info('[CustomsService] tradeDocument deleted', { id, actorId });
    return { id, deleted: true };
  }

  async function listTradeDocuments(params: {
    type?: string;
    status?: string;
    /** 业务域过滤（B4：customs/procurement/qc/contract/finance——单据中心域视图） */
    domain?: string;
    shipmentId?: string;
    declarationId?: string;
    orderId?: string;
    relationId?: string;
    /** 财务发票回链反查（CI 引用财务 Invoice 真源，发票详情查交单状态用） */
    sourceInvoiceId?: string;
    search?: string;
    limit?: number;
    offset?: number;
  } = {}) {
    const where: Prisma.TradeDocumentWhereInput = { deletedAt: null };
    if (params.type) where.type = params.type;
    if (params.status) where.status = params.status;
    if (params.domain) where.domain = params.domain;
    if (params.shipmentId) where.shipmentId = params.shipmentId;
    if (params.declarationId) where.declarationId = params.declarationId;
    if (params.orderId) where.orderId = params.orderId;
    if (params.relationId) where.relationId = params.relationId;
    if (params.sourceInvoiceId) where.sourceInvoiceId = params.sourceInvoiceId;
    if (params.search) {
      where.OR = [
        { documentNumber: { contains: params.search, mode: 'insensitive' } },
        { consignee: { contains: params.search, mode: 'insensitive' } },
        { consignor: { contains: params.search, mode: 'insensitive' } },
        { issuedBy: { contains: params.search, mode: 'insensitive' } },
      ];
    }

    const limit = params.limit ?? 100;
    const offset = params.offset ?? 0;
    const [items, total] = await Promise.all([
      prisma.tradeDocument.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.tradeDocument.count({ where }),
    ]);

    return { items, total };
  }

  async function getTradeDocument(id: string) {
    const doc = await prisma.tradeDocument.findFirst({
      where: { id, deletedAt: null },
    });
    if (!doc) throw new Error(`贸易单据 ${id} 不存在`);
    return doc;
  }

  async function transitionTradeDocumentStatus(id: string, toStatus: TradeDocumentStatus, actorId: string, ciAuthority?: CiDocumentMetadataOptions) {
    validateDocStatus(toStatus);
    const existing = await prisma.tradeDocument.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) throw new Error(`贸易单据 ${id} 不存在`);
    rejectGenericSupplierDocumentWrite(existing);

    if (await isPackingListCandidateInTx(prisma, existing)) {
      return prisma.$transaction(async tx => {
        const before = await authorizePackingListMetadataInTx(tx, id, ciAuthority?.trustedActor ?? null);
        if (actorId !== ciAuthority?.trustedActor?.userId || ciAuthority?.trustedAuthSource !== 'user-session') throw businessError('UNAUTHORIZED', '装箱单操作需要当前可信登录身份。');
        try { validateTransition(docStatusTransitionsFor(before.document.domain || 'customs'), before.document.status, toStatus, '单据'); }
        catch { throw businessError('VALIDATION_FAILED', '原装箱单状态不允许此流转。'); }
        const updated = await tx.tradeDocument.update({ where: { id }, data: { status: toStatus, updatedAt: now() } });
        await tx.auditLog.create({ data: { id: generateId('AUD'), action: 'TRADE_DOCUMENT_TRANSITION', actorId, targetType: 'TradeDocument', targetId: id,
          detail: { from: before.document.status, to: toStatus, versionId: before.item.id, contentHash: before.fingerprint } } });
        await finishPackingListMetadataInTx(tx, ciAuthority?.trustedActor ?? null, before);
        return updated;
      });
    }
    // 按业务域选状态机（B2：customs 交单状态机 / 其余域简化文档生命周期；
    // domain 空值回退 customs——schema default 保证非空，此为历史行防御）
    if (existing.type !== 'CommercialInvoice') {
      validateTransition(docStatusTransitionsFor(existing.domain || 'customs'), existing.status, toStatus, '单据');
    }

    const ts = now();
    const updated = await prisma.$transaction(async (tx) => {
      if (existing.type === 'CommercialInvoice') {
        await authorizeCiDocumentMetadataTransitionInTx(tx, existing, toStatus, actorId, ciAuthority);
        try {
          validateTransition(docStatusTransitionsFor(existing.domain || 'customs'), existing.status, toStatus, '单据');
        } catch (error: any) { throw businessError('VALIDATION_FAILED', error.message); }
      }
      const doc = await tx.tradeDocument.update({
        where: { id },
        data: { status: toStatus, updatedAt: ts },
      });
      await tx.auditLog.create({
        data: {
          id: generateId('AUD'),
          action: 'TRADE_DOCUMENT_TRANSITION',
          actorId,
          targetType: 'TradeDocument',
          targetId: id,
          detail: { from: existing.status, to: toStatus },
        },
      });
      if (existing.type === 'CommercialInvoice') await finishCiDocumentMetadataTransitionInTx(tx, id, toStatus, actorId, ciAuthority);
      return doc;
    }).catch(error => {
      if (existing.type === 'CommercialInvoice' && !isBusinessError(error))
        throw businessError('INTERNAL_ERROR', '商业发票操作结果暂不可确认，请刷新原记录后核对。');
      throw error;
    });

    logger.info('[CustomsService] tradeDocument transition', { id, from: existing.status, to: toStatus, actorId });
    return updated;
  }

  // ────────────────────────────────────────────────────────────
  // 概览统计
  // ────────────────────────────────────────────────────────────

  async function getCustomsOverview() {
    const [
      declarationCount,
      releasedCount,
      pendingLcCount,
      settledLcCount,
      pendingRefundCount,
      refundedCount,
      docCount,
    ] = await Promise.all([
      prisma.customsDeclaration.count({ where: { deletedAt: null } }),
      prisma.customsDeclaration.count({ where: { deletedAt: null, status: 'Released' } }),
      prisma.letterOfCredit.count({ where: { deletedAt: null, status: { in: ['Issued', 'Presented', 'Accepted', 'Discrepant'] } } }),
      prisma.letterOfCredit.count({ where: { deletedAt: null, status: 'Settled' } }),
      prisma.taxRefund.count({ where: { deletedAt: null, status: { in: ['Draft', 'Submitted', 'Reviewing', 'Approved'] } } }),
      prisma.taxRefund.count({ where: { deletedAt: null, status: 'Refunded' } }),
      prisma.tradeDocument.count({ where: { deletedAt: null } }),
    ]);

    // 退税总额
    const refundedAgg = await prisma.taxRefund.aggregate({
      where: { deletedAt: null, status: 'Refunded', refundAmount: { not: null } },
      _sum: { refundAmount: true },
    });

    return {
      declarations: { total: declarationCount, released: releasedCount },
      lettersOfCredit: { pending: pendingLcCount, settled: settledLcCount },
      taxRefunds: { pending: pendingRefundCount, refunded: refundedCount, totalRefundedAmount: refundedAgg._sum.refundAmount ? Number(refundedAgg._sum.refundAmount) : 0 },
      tradeDocuments: { total: docCount },
    };
  }

  return {
    // CustomsDeclaration
    createDeclaration,
    updateDeclaration,
    deleteDeclaration,
    listDeclarations,
    getDeclaration,
    transitionDeclarationStatus,
    // HsCode
    createHsCode,
    updateHsCode,
    deleteHsCode,
    listHsCodes,
    getHsCodeByCode,
    // LetterOfCredit
    createLetterOfCredit,
    updateLetterOfCredit,
    deleteLetterOfCredit,
    listLettersOfCredit,
    getLetterOfCredit,
    getLetterOfCreditByNumber,
    transitionLcStatus,
    listLcEvents,
    // TaxRefund
    createTaxRefund,
    updateTaxRefund,
    deleteTaxRefund,
    listTaxRefunds,
    getTaxRefund,
    transitionTaxRefundStatus,
    reviewTaxRefund,
    createTaxRefundFromDeclaration,
    // TradeDocument
    createTradeDocument,
    updateTradeDocument,
    deleteTradeDocument,
    listTradeDocuments,
    getTradeDocument,
    transitionTradeDocumentStatus,
    // Overview
    getCustomsOverview,
  };
}

export type CustomsService = ReturnType<typeof createCustomsService>;
