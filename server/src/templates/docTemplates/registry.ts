import type { ApprovalSignDocumentSnapshot } from '../../approvals/approvalSignDocumentSnapshotService';
/**
 * 服务端单据模板注册表（2026-08-22 全系统文档体系 B1 架构底座 / B2 运营域扩展）。
 *
 * 架构裁决：
 *   - 模板真源统一服务端（前端 EXPORT_DOC_RENDERERS 逐类退役，B6 收尾）
 *   - 每个 docKind 一个注册项：loadData（数据装配）+ renderBody（渲染）
 *     · PL：版本快照 documentSet（customs 域，生成时快照冻结）
 *     · PO/IR/QUOT/OC：业务真源实时装配（运营域——sourceRef 回链，改业务侧即改文档）
 *     · FIN_CI/STMT：完整文档形态（renderDocument，自带 doc-* 头部样式）——
 *       B11 收编：财务发票从 finance/route.ts 原位提取入注册表，此处为全站模板唯一目录
 *   - 组装统一走 buildServerDocument（doc-* 基座），preview.html 用 screen 模式
 *
 * 已注册（B1-B11 + 批次 H2）：PL/PO/IR/CI/CO/BL/AWB/INS/FORMA/BC/QUOT/OC/CONTRACT/MERGED_PL/MERGED_IR/STMT/FIN_CI/IC/PC/OTHER
 * （批次 H2 补齐 InspectionCert/PhytosanitaryCert/Other 三类打印模板——此前只能登记壳出不了文件）
 */

import { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../../auth/service';
import { businessError } from '../../shared/errorCodes';
import { getSystemConfigService } from '../../config/systemConfigService';
import { DEFAULT_EXPORTER_PROFILE, EXPORTER_PROFILE_CONFIG_KEY } from '../../config/systemConfigRoute';
import { buildServerDocument, esc, type DocSeal } from '../docPrintBase';
import { createSealService } from '../../seal/sealService';
import { logger } from '../../lib/logger';
import { assertPackingListEnvelope } from './packingListSource';
import { assertMergedPackingListEnvelope } from './mergedPackingListSource';
import { renderPackingListBody, type DocExporterProfile } from './packingList';
import { renderPurchaseOrderBody, loadPurchaseOrderDocData } from './purchaseOrder';
import { loadSupplierContractTemplateData, renderProcessingContractBody } from './processingContract';
import { renderInspectionReportBody, loadInspectionReportDocData } from './inspectionReport';
import { renderMergedPackingListBody } from './mergedPackingList';
import { renderMergedInspectionSummaryBody } from './mergedInspectionSummary';
import { renderCertificateOfOriginBody, renderBillOfLadingBody, renderInsurancePolicyBody, renderCommercialInvoiceBody, renderFormABody, renderBeneficiaryCertificateBody, renderAirWaybillBody, renderInspectionCertificateBody, renderPhytosanitaryCertBody, renderOtherTradeDocumentBody } from './customsDocs';
import { renderQuotationBody, loadQuotationDocData, type QuotationDocData } from './quotation';
import { renderOrderConfirmationBody, loadOrderConfirmationDocData } from './orderConfirmation';
import { renderContractBody } from './contract';
import { renderStatementBody } from './statement';
import { renderPaymentRequestBody, loadPaymentRequestDocData } from './paymentRequest';
import { renderFinanceInvoiceDocument } from './financeInvoice';
import type { ServerDocumentSetData } from './types';

/** 注册表渲染上下文：单据定位信息（loadData 按各自真源装配） */
export interface ServerDocContext {
  id: string;
  type: string;
  sourceRef: string | null;
  sourceInvoiceId?: string | null;
  shipmentId?: string;
  trustedActor?: TokenPayload | null;
  expectedSourceFingerprint?: string;
  expectedShipmentSourceFingerprint?: string;
  /**
   * 电子签签署人（§10.3-9）：仅当单据已签署/已批准时由调用方传入——
   * renderServerDocument 据此用 resolveSealForSigner 解析应盖章图，未传则不盖章。
   * 优先级：userId（指定到人）> roleId（按角色）> 全局默认章。
   */
  signer?: { userId?: string | null; roleId?: string | null; documentSnapshot?: ApprovalSignDocumentSnapshot; quotationData?: QuotationDocData } | null;
}

export interface ServerDocTemplate {
  /** 模板标识（与 TradeDocumentType 对齐或扩展） */
  kind: string;
  title: string;
  /** 数据装配：按模板各自真源（版本快照 / 业务外链）读取，失败返回 null（调用方 404） */
  loadData: (prisma: PrismaClient, doc: ServerDocContext) => Promise<any | null>;
  /** data → HTML body 片段（经 buildServerDocument 组装）；seal 为已签署时解析出的章图（可空） */
  renderBody: (data: any, exporter: DocExporterProfile, seal?: DocSeal | null) => string;
  /**
   * 完整文档渲染器（自带 doc-* 头部样式 + screen 画布壳的模板，如财务发票）——
   * 设置后 renderServerDocument 直接返回其输出，不走 renderBody 片段路径。
   * B11 收编：财务发票从 finance/route.ts 原位提取，注册表成为全站模板唯一目录。
   */
  renderDocument?: (prisma: PrismaClient, ctx: ServerDocContext, opts: { screen?: boolean }) => Promise<string | null>;
}

/** TradeDocumentType → 服务端模板 kind（模板注册地即映射真源） */
const TRADE_DOC_TYPE_TO_KIND: Partial<Record<string, string>> = {
  CommercialInvoice: 'CI', // 原财务应收票唯一真源；历史 documentSet 不再是正式 CI 渲染来源
  PackingList: 'PL',
  CertificateOfOrigin: 'CO',
  BillOfLading: 'BL',
  AirWaybill: 'AWB',
  InsuranceCert: 'INS',
  InspectionCert: 'IC', // 批次 H2
  PhytosanitaryCert: 'PC', // 批次 H2
  Other: 'OTHER', // 批次 H2（通用版式：快照优先，手工登记壳回落字段版式）
  PurchaseOrder: 'PO',
  ProcessingContract: 'PROCESSING',
  InspectionReport: 'IR',
  Quotation: 'QUOT',
  OrderConfirmation: 'OC',
  // §10.3-9 Phase B 批次 4：付款申请单（有文件类单据 → 走电子签盖章链）
  PaymentRequest: 'PAYREQ',
};

/** 出运制单 kind 集合（ShipmentDocumentGenerator 按运单渲染入口用——B6 前端模板退役；B11 增 AWB） */
export const SHIPMENT_DOC_KINDS = ['CI', 'PL', 'CO', 'BL', 'AWB', 'FORMA', 'INS', 'BC'] as const;
export type ShipmentDocKind = (typeof SHIPMENT_DOC_KINDS)[number];

export function isShipmentDocKind(kind: string): kind is ShipmentDocKind {
  return (SHIPMENT_DOC_KINDS as readonly string[]).includes(kind);
}

/** 按单据类型查服务端模板 kind（未迁移类型返回 null——前端本地渲染兜底） */
export function serverKindForType(type: string): string | null {
  return TRADE_DOC_TYPE_TO_KIND[type] ?? null;
}

/** PL 数据装配：最新版本快照的 documentSet（customs 域——生成时快照冻结，无快照返回 null） */
async function loadDocumentSetSnapshot(prisma: PrismaClient, doc: ServerDocContext): Promise<any | null> {
  const latest = await prisma.documentVersion.findFirst({
    where: { documentId: doc.id },
    orderBy: { version: 'desc' },
    select: { content: true },
  });
  const ds = (latest?.content as Record<string, unknown> | null | undefined)?.documentSet;
  return ds && typeof ds === 'object' ? ds : null;
}

/**
 * OTHER 数据装配（批次 H2）：运单生成的 Other 单据走 documentSet 快照版式；
 * 手工登记的 Other 单据（无快照）回落 TradeDocument 行字段版式——登记壳也能出文件。
 * BigInt/Decimal → number（模板直接渲染，不经 serializeValue）。
 */
async function loadOtherTradeDocumentData(prisma: PrismaClient, doc: ServerDocContext): Promise<any | null> {
  const set = await loadDocumentSetSnapshot(prisma, doc);
  if (set) return { source: 'set', set };
  const row = await (prisma as any).tradeDocument.findFirst({ where: { id: doc.id, deletedAt: null } });
  if (!row) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'bigint') out[key] = Number(value);
    else if (value && typeof value === 'object' && typeof (value as any).toNumber === 'function') out[key] = Number(value);
    else out[key] = value;
  }
  return { source: 'doc', doc: out };
}

export const SERVER_DOC_TEMPLATES: Record<string, ServerDocTemplate> = {
  CI: { kind: 'CI', title: 'Commercial Invoice 商业发票', loadData: async () => null,
    renderBody: () => { throw businessError('CONFLICT', '商业发票必须引用明确原财务票，不能渲染装配副本。'); },
    renderDocument: async (prisma, ctx, opts) => {
      if (!ctx.sourceInvoiceId) throw businessError('CONFLICT', '请选择原财务应收票。');
      return renderFinanceInvoiceDocument(prisma, ctx.sourceInvoiceId, { ...opts, trustedActor: ctx.trustedActor, shipmentId: ctx.shipmentId,
        ...(ctx.id ? { documentId: ctx.id } : {}), expectedSourceFingerprint: ctx.expectedSourceFingerprint, expectedShipmentSourceFingerprint: ctx.expectedShipmentSourceFingerprint });
    } },
  PL: { kind: 'PL', title: 'Packing List 装箱单', loadData: loadDocumentSetSnapshot, renderBody: renderPackingListBody },
  CO: { kind: 'CO', title: 'Certificate of Origin 原产地证', loadData: loadDocumentSetSnapshot, renderBody: renderCertificateOfOriginBody },
  BL: { kind: 'BL', title: 'Bill of Lading 提单补料', loadData: loadDocumentSetSnapshot, renderBody: renderBillOfLadingBody },
  AWB: { kind: 'AWB', title: 'Air Waybill 空运单', loadData: loadDocumentSetSnapshot, renderBody: renderAirWaybillBody },
  INS: { kind: 'INS', title: 'Insurance Policy 保险单', loadData: loadDocumentSetSnapshot, renderBody: renderInsurancePolicyBody },
  FORMA: { kind: 'FORMA', title: 'GSP Form A 普惠制原产地证', loadData: loadDocumentSetSnapshot, renderBody: renderFormABody },
  BC: { kind: 'BC', title: "Beneficiary's Certificate 受益人证明", loadData: loadDocumentSetSnapshot, renderBody: renderBeneficiaryCertificateBody },
  // 批次 H2：检验证书 / 植检证书 / 通用单据（此前无模板只能登记壳）
  IC: { kind: 'IC', title: 'Inspection Certificate 检验证书', loadData: loadDocumentSetSnapshot, renderBody: renderInspectionCertificateBody },
  PC: { kind: 'PC', title: 'Phytosanitary Certificate 植检证书', loadData: loadDocumentSetSnapshot, renderBody: renderPhytosanitaryCertBody },
  OTHER: { kind: 'OTHER', title: 'Trade Document 通用外贸单据', loadData: loadOtherTradeDocumentData, renderBody: renderOtherTradeDocumentBody },
  PO: { kind: 'PO', title: 'Purchase Order 采购订单', loadData: async (prisma, doc) => (doc.sourceRef?.startsWith('supplier:')
    ? loadSupplierContractTemplateData(prisma, doc, 'purchase') : doc.sourceRef ? loadPurchaseOrderDocData(prisma, doc.sourceRef) : null), renderBody: renderPurchaseOrderBody },
  PROCESSING: { kind: 'PROCESSING', title: 'Processing Contract 加工合同', loadData: async (prisma, doc) => loadSupplierContractTemplateData(prisma, doc, 'processing'), renderBody: renderProcessingContractBody },
  IR: { kind: 'IR', title: 'Inspection Report 验货报告', loadData: async (prisma, doc) => (doc.sourceRef ? loadInspectionReportDocData(prisma, doc.sourceRef) : null), renderBody: renderInspectionReportBody },
  QUOT: { kind: 'QUOT', title: 'Quotation 报价单', loadData: async (prisma, doc) => (doc.sourceRef ? loadQuotationDocData(prisma, doc.sourceRef) : null), renderBody: renderQuotationBody },
  OC: { kind: 'OC', title: 'Order Confirmation 订单确认书', loadData: async (prisma, doc) => (doc.sourceRef ? loadOrderConfirmationDocData(prisma, doc.sourceRef) : null), renderBody: renderOrderConfirmationBody },
  // B3/B8 组合文档（多对一聚合）：loadData 无单据级装配——数据由 compositeDocumentService 聚合后直喂 renderServerDocument
  MERGED_PL: { kind: 'MERGED_PL', title: 'Consolidated Packing List 合并装箱单', loadData: async () => null, renderBody: renderMergedPackingListBody },
  MERGED_IR: { kind: 'MERGED_IR', title: 'Consolidated Inspection Summary 合并验货汇总', loadData: async () => null, renderBody: renderMergedInspectionSummaryBody },
  CONTRACT: { kind: 'CONTRACT', title: 'Sales Contract 销售合同（多订单合并）', loadData: async () => null, renderBody: renderContractBody },
  // §10.3-9 Phase B 批次 4：付款申请单（sourceRef=PaymentRequest.id；真源实时装配）
  PAYREQ: { kind: 'PAYREQ', title: 'Payment Request 付款申请单', loadData: async (prisma, doc) => (doc.sourceRef ? loadPaymentRequestDocData(prisma, doc.sourceRef) : null), renderBody: renderPaymentRequestBody },
  // B9 财务域报表模板：数据由 finance 路由实时装配直喂（周期性报表，非 TradeDocument 归档体系）
  STMT: { kind: 'STMT', title: 'Statement of Account 客户对账单', loadData: async () => null, renderBody: renderStatementBody },
  // B11 结构收编：财务发票（商业发票唯一真源）入注册表——完整文档模板形态
  // （sourceRef=Invoice.id；lifecycleService 的 CI 财务回链分支等价于此入口）
  FIN_CI: {
    kind: 'FIN_CI',
    title: 'Commercial Invoice 商业发票（财务真源）',
    loadData: async () => null, // 数据装配在 renderDocument 内完成（loadInvoiceDoc）
    renderBody: () => '',
    renderDocument: async (_prisma, ctx, opts) => (ctx.sourceRef ? renderFinanceInvoiceDocument(_prisma, ctx.sourceRef, { ...opts, trustedActor: ctx.trustedActor, shipmentId: ctx.shipmentId, expectedSourceFingerprint: ctx.expectedSourceFingerprint }) : null),
  },
};

/**
 * 读取出口方档案（SystemConfig 真源，30s TTL 缓存 → DEFAULT_EXPORTER_PROFILE 兜底）。
 * 与 finance/route.ts loadInvoiceDoc 同语义；读取失败不阻断渲染（走默认档案）。
 */
export async function loadExporterProfile(prisma: PrismaClient, options?: { fresh?: boolean }): Promise<DocExporterProfile> {
  try {
    const found = await getSystemConfigService(prisma).get(EXPORTER_PROFILE_CONFIG_KEY, { skipCache: options?.fresh === true });
    if (found?.value && typeof found.value === 'object') {
      return { ...DEFAULT_EXPORTER_PROFILE, ...(found.value as object) } as DocExporterProfile;
    }
  } catch { /* 配置读取失败走默认档案 */ }
  return { ...DEFAULT_EXPORTER_PROFILE };
}

/**
 * 解析签署人应盖章图（§10.3-9）。失败 / 无可用章一律返回 null——
 * 盖章是增强，绝不因章库异常阻断单据渲染（fail-open；与通知接线同口径）。
 */
async function resolveSealSafe(
  prisma: PrismaClient,
  signer: { userId?: string | null; roleId?: string | null },
): Promise<DocSeal | null> {
  try {
    const resolved = await createSealService(prisma).resolveSealForSigner({
      userId: signer.userId ?? null,
      roleId: signer.roleId ?? null,
    });
    return resolved ? { id: resolved.id, name: resolved.name, imageDataUrl: resolved.imageDataUrl } : null;
  } catch (e: any) {
    logger.warn('[DocRegistry] resolve seal failed (rendering continues without stamp)', { error: e?.message });
    return null;
  }
}

/**
 * 按模板标识渲染完整单据文档（服务端统一入口）。
 * screen=true → preview.html 预览模式（灰底 A4 纸张画布）；false → 裸打印（renderHtmlToPdf 用）。
 * 完整文档模板（renderDocument 形态，如 FIN_CI）自带头部样式，ctx.sourceRef 定位业务真源。
 * ctx.signer 有值时按签署人解析章图盖入签名区（§10.3-9）；未传则不出章。
 * 未知模板返回 null（fail-closed，调用方 404）。
 */
export async function renderServerDocument(
  prisma: PrismaClient,
  kind: string,
  data: any,
  opts: { screen?: boolean; packingListWarnings?: string[] } = {},
  ctx?: ServerDocContext,
): Promise<string | null> {
  const template = SERVER_DOC_TEMPLATES[kind];
  if (!template) return null;
  if (template.renderDocument) {
    return template.renderDocument(prisma, ctx ?? { id: '', type: '', sourceRef: null }, opts);
  }
  const plHistory = (html: string, warnings = opts.packingListWarnings) => warnings?.length ? html.replace(/<body[^>]*>/, opening => opening + '<aside class="doc-history-note">' + warnings.join(' ') + '</aside>') : html;
  if (kind === 'MERGED_PL' && data && Object.prototype.hasOwnProperty.call(data, 'mergedPlSourceProtocol')) {
    const envelope = assertMergedPackingListEnvelope(data);
    return plHistory(buildServerDocument(renderMergedPackingListBody(envelope, envelope.mergedPackingListSource.exporter), opts), opts.packingListWarnings?.map(esc));
  }
  if (kind === 'PL' && data && Object.prototype.hasOwnProperty.call(data, 'plSourceProtocol')) {
    const envelope = assertPackingListEnvelope(data);
    const exporter = envelope.packingListSource.exporter;
    return plHistory(buildServerDocument(renderPackingListBody(envelope, exporter), opts));
  }
  const signedSnapshot = ctx?.signer?.documentSnapshot;
  if (signedSnapshot && (signedSnapshot.kind !== ctx?.type || signedSnapshot.sourceRef !== ctx?.sourceRef
    || (signedSnapshot.kind === 'OrderConfirmation' ? kind !== 'OC'
      : signedSnapshot.kind === 'Contract' ? kind !== 'CONTRACT' : kind !== 'QUOT')))
    throw new Error('签署快照与当前单据来源不一致');
  const exporter = signedSnapshot ? signedSnapshot.exporterProfile as unknown as DocExporterProfile
    : await loadExporterProfile(prisma, { fresh: kind === 'QUOT' || kind === 'OC' || kind === 'CONTRACT' });
  if (signedSnapshot) data = signedSnapshot.data;
  const signedQuotation = ctx?.signer?.quotationData;
  if (signedQuotation) {
    if (kind !== 'QUOT' || ctx?.type !== 'Quotation' || signedQuotation.qt.id !== ctx.sourceRef)
      throw new Error('签署报价与当前单据来源不一致');
    // A verified quote snapshot is the frozen rendering input. Keep the
    // same-row quotationData compatibility path only for callers that do not
    // provide the official signed-document envelope.
    if (!signedSnapshot) data = signedQuotation;
  }
  const seal = ctx?.signer ? await resolveSealSafe(prisma, ctx.signer) : null;
  const body = template.renderBody(data as ServerDocumentSetData, exporter, seal);
  return kind === 'PL' ? plHistory(buildServerDocument(body, opts)) : buildServerDocument(body, opts);
}
