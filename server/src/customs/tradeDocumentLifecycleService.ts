import { businessNowDate } from '../shared/businessClock';
import { generatePackingListArchive, isPackingListArchiveCandidate } from './packingListArchiveService';
import { registerPackingListDraft, readPackingListDocument, readPackingListVersion, isPackingListCandidateInTx, packingListFileUnavailable } from './shipmentPackingListCommand';
/**
 * 贸易单据生命周期服务 Trade Document Lifecycle Service（Wave A1 单据中心）
 *
 * 职责（PRD 19.14 / 11.2 落地）：
 *   1. 自动取号：按 5.6 规则 {类型前缀}-YYYY-NNNN，按年递增、全局唯一、作废不回收
 *     （序号扫描含软删记录，跳号保留审计痕迹）
 *   2. 版本留痕：appendTradeDocumentVersion —— 创建/更新单据时服务端事务内强制
 *      写 DocumentVersion（max+1 单调递增），不依赖客户端自觉（根因式留痕）
 *   3. 生成即登记：generateTradeDocumentsFromShipment —— 复用 shipping
 *      assembleDocumentSetData 装配数据，按选定类型批量创建 Draft 单据 + v1 快照
 *      （快照=装配 JSON，前端 EXPORT_DOC_RENDERERS 可直接渲染），同 shipmentId+type
 *      幂等 skipped，不重复登记
 *   4. 批量打包：packTradeDocumentsByOrder —— 订单全部未删单据 + 各自最新版本快照，
 *      供前端逐个渲染下载（L/C 交单场景）
 */

import { Prisma, PrismaClient } from '@prisma/client';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import type { TokenPayload } from '../auth/service';
import { QcReportError, qcReportDocumentSource, loadAuthorizedQcReportSource, qcReportSourceFingerprint, qcReportFailure } from '../qc/qcReportAuthority';
import { logger } from '../lib/logger';
import { assembleDocumentSetData } from '../shipping/documentSetService';
import { nextBusinessNumber } from '../shared/businessNumberService';
import { renderHtmlToPdf } from '../templates/pdf';
import { renderServerDocument, SERVER_DOC_TEMPLATES, serverKindForType } from '../templates/docTemplates/registry';
import { renderFinanceInvoiceDocument, renderHistoricalCiInvoiceDocument, renderBusinessShipmentCiSnapshot } from '../templates/docTemplates/financeInvoice';
import type { TradeDocumentType } from './customsService';
import { businessError } from '../shared/errorCodes';
import { readCiInvoiceSource, registerCanonicalCi, registerCanonicalCiInTx, readAuthorizedCiDocument, readAuthorizedCiDocumentInTx, readHistoricalCiDocumentInTx } from './ciInvoiceSource';
import { currentDocumentActor, documentSourceFingerprint, shipmentDocumentSourceInTx } from '../shipping/shipmentDocumentSource';
import { resolveDocumentSignerByDoc } from '../seal/documentSigner';
import { isBusinessShipmentCi, readBusinessShipmentCiVersion, readBusinessShipmentCiVersionInTx } from './businessShipmentCiSnapshot';
import { isDevelopmentCi, ciHash, readDevelopmentCiVersionInTx } from '../development/developmentCiSource';
import { renderDevelopmentCiDocument } from '../development/developmentCiDocument';
import { generateDevelopmentCiArchive, assertDevelopmentCiArchiveInTx } from '../development/developmentCiArchiveService';
import { isSupplierContractDocumentCandidate, rejectGenericSupplierDocumentWrite } from './supplierContractDocumentPolicy';
import { renderSupplierContractTradeDocument } from './supplierContractDocumentArchive';

// ────────────────────────────────────────────────────────────────
// 1. 自动取号
// ────────────────────────────────────────────────────────────────

/** 单据类型 → 编号前缀（5.6 风格：前缀-年-序号；B2 起含运营域类型） */
export const TRADE_DOC_NUMBER_PREFIX: Record<TradeDocumentType, string> = {
  CommercialInvoice: 'CI',
  PackingList: 'PL',
  CertificateOfOrigin: 'CO',
  BillOfLading: 'BL',
  AirWaybill: 'AWB',
  InsuranceCert: 'INS',
  InspectionCert: 'IC',
  PhytosanitaryCert: 'PC',
  ExportDeclarationProof: 'EDP',
  Other: 'DOC',
  // B2 运营域（PO 文档号=poNumber 业务单号直用，此映射供 IR 等域取号）
  PurchaseOrder: 'PO',
  ProcessingContract: 'CT',
  InspectionReport: 'IR',
  Quotation: 'QT', // B7：报价单文档号=quotationNumber 业务单号直用，此映射供兜底取号
  OrderConfirmation: 'OC', // B8：订单确认书文档号=poNumber 业务单号直用，此映射供兜底取号
  PaymentRequest: 'PAYR', // §10.3-9 Phase B 批次 4：付款申请单文档号=requestNumber 业务单号直用
  Contract: 'CT',
};

const VALID_TYPES = Object.keys(TRADE_DOC_NUMBER_PREFIX) as TradeDocumentType[];

/** Prisma 客户端或事务句柄 */
type DbLike = Pick<PrismaClient, 'tradeDocument'>;

/**
 * 生成下一单据编号：{PREFIX}-{YYYY}-{NNNN}（4 位补零）。
 * 序号 = 该前缀+年份下既有编号（含软删，作废不回收）最大序号 + 1；
 * 字符串排序在序号超过 4 位后不可靠，故取候选集解析数值取 max。
 */
export async function generateTradeDocumentNumber(db: DbLike, type: TradeDocumentType): Promise<string> {
  const prefix = TRADE_DOC_NUMBER_PREFIX[type];
  if (!prefix) throw new Error(`非法单据类型: ${type}`);
  const year = businessNowDate().getFullYear();
  const stem = `${prefix}-${year}-`;

  // 若 db 有 businessSequence 模型（生产环境），走统一编号服务
  if ((db as any).businessSequence) {
    return nextBusinessNumber(db as any, prefix as any, undefined, {
      occupied: async (num) => (await db.tradeDocument.findFirst({ where: { documentNumber: num }, select: { id: true } })) != null,
    });
  }

  // 降级：mock 环境（单元测试）或无 businessSequence 模型，回退到扫描 max+1
  const rows = await db.tradeDocument.findMany({
    where: { documentNumber: { startsWith: stem } },
    select: { documentNumber: true },
  });
  let maxSeq = 0;
  for (const row of rows) {
    const seq = parseInt(row.documentNumber.slice(stem.length), 10);
    if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
  }
  return `${stem}${String(maxSeq + 1).padStart(4, '0')}`;
}

export function isTradeDocumentType(type: string): type is TradeDocumentType {
  return (VALID_TYPES as string[]).includes(type);
}

// ────────────────────────────────────────────────────────────────
// 2. 版本留痕（服务端强制）
// ────────────────────────────────────────────────────────────────

const now = (): bigint => BigInt(Date.now());

/** Third-party originals are archive-only; never reconstruct them from order/shipment snapshots. */
const EXTERNAL_CUSTOMS_ARCHIVE_ONLY_TYPES = new Set([
  'CertificateOfOrigin', 'BillOfLading', 'AirWaybill', 'InsuranceCert',
  'InspectionCert', 'PhytosanitaryCert', 'ExportDeclarationProof', 'Other',
]);
const isExternalCustomsArchiveOnly = (doc: { domain?: string | null; type?: string | null }) =>
  (!doc.domain || doc.domain === 'customs') && EXTERNAL_CUSTOMS_ARCHIVE_ONLY_TYPES.has(String(doc.type));

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 本地日期 YYYY-MM-DD（issueDate 缺省=生成当天） */
function localToday(): string {
  const d = businessNowDate();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** TradeDocument 行 → JSON 安全快照（BigInt/Decimal → number），供 DocumentVersion.content */
export function toTradeDocumentSnapshot(doc: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (typeof value === 'bigint') out[key] = Number(value);
    else if (value instanceof Prisma.Decimal) out[key] = Number(value);
    else out[key] = value;
  }
  return out;
}

/**
 * 事务内追加单据版本（版本号 max+1 防并发跳号）+ 审计日志。
 * 创建/更新单据的服务必须在同一事务内调用，保证留痕与变更原子。
 */
export async function appendTradeDocumentVersion(
  tx: any,
  params: { documentId: string; content: Record<string, unknown>; actorId: string; changeReason?: string | null },
): Promise<void> {
  rejectGenericSupplierDocumentWrite(await tx.tradeDocument.findFirst({ where: { id: params.documentId, deletedAt: null } }));
  const last = await tx.documentVersion.findFirst({
    where: { documentId: params.documentId },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  const nextVersion = (last?.version ?? 0) + 1;
  await tx.documentVersion.create({
    data: {
      id: generateId('DVER'),
      documentId: params.documentId,
      version: nextVersion,
      content: params.content,
      changeReason: params.changeReason?.trim() || null,
      changedBy: params.actorId,
      createdAt: now(),
    },
  });
  await tx.auditLog.create({
    data: {
      id: generateId('AUD'),
      action: 'DOCUMENT_VERSION_CREATE',
      actorId: params.actorId,
      targetType: 'DocumentVersion',
      targetId: params.documentId,
      detail: { version: nextVersion, changeReason: params.changeReason ?? null, source: 'lifecycle' },
    },
  });
}

// ────────────────────────────────────────────────────────────────
// 3. 生成即登记（运单 → 单据草稿）
// ────────────────────────────────────────────────────────────────

export interface GenerateFromShipmentResult {
  created: Array<{ id: string; documentNumber: string; type: string }>;
  skipped: Array<{ type: string; id: string; documentNumber: string; reason: 'EXISTS' }>;
  /** 装配数据完整度提示（透传 documentSetService.missing，供 UI 展示不阻断） */
  missing: string[];
}

export async function generateTradeDocumentsFromShipment(
  prisma: PrismaClient,
  params: { shipmentId: string; types: TradeDocumentType[]; actorId: string; trustedActor?: TokenPayload | null; sourceInvoiceId?: string; expectedSourceFingerprint?: string; expectedShipmentSourceFingerprint?: string },
): Promise<GenerateFromShipmentResult> {
  const { shipmentId, types, actorId } = params;
  if (!shipmentId) throw new Error('shipmentId 必填');
  if (!Array.isArray(types) || types.length === 0) throw new Error('types 必填且非空');
  for (const t of types) {
    if (!isTradeDocumentType(t)) throw new Error(`非法单据类型: ${t}`);
  }
  if (types.some(type => type !== 'CommercialInvoice' && type !== 'PackingList')) {
    throw businessError('VALIDATION_FAILED', '出运流程只生成我方商业发票和装箱单；外部方出具的文件请上传归档。');
  }

  if (types.every(type => type === 'PackingList')) {
    const result = await registerPackingListDraft(prisma, { ...params, trustedActor: params.trustedActor ?? null });
    const item = { id: result.document.id, documentNumber: result.document.documentNumber, type: 'PackingList' };
    return { created: result.created ? [item] : [], skipped: result.created ? [] : [{ ...item, reason: 'EXISTS' as const }], missing: [] };
  }
  const ciOptions = { trustedActor: params.trustedActor ?? null, mode: 'register' as const, shipmentId,
    ...(params.sourceInvoiceId !== undefined ? { sourceInvoiceId: params.sourceInvoiceId } : {}),
    ...(params.expectedSourceFingerprint !== undefined ? { expectedSourceFingerprint: params.expectedSourceFingerprint } : {}),
    ...(params.expectedShipmentSourceFingerprint !== undefined ? { expectedShipmentSourceFingerprint: params.expectedShipmentSourceFingerprint } : {}) };
  const ciSource = types.includes('CommercialInvoice') ? await readCiInvoiceSource(prisma, ciOptions) : null;
  if (ciSource && actorId !== params.trustedActor?.userId) throw businessError('UNAUTHORIZED', '商业发票登记身份不一致。');
  const assembled = await assembleDocumentSetData(prisma, shipmentId, params.trustedActor ? { trustedActor: params.trustedActor, expectedSourceFingerprint: params.expectedShipmentSourceFingerprint } : undefined);
  if (!assembled.ok || !assembled.data) {
    throw new Error(assembled.error?.message || '运单数据装配失败');
  }
  const data = assembled.data;

  // relationId：装配数据只带客户名，单据登记补 Relation snapshot FK（经订单解析一次）
  let relationId: string | null = null;
  if (data.order?.id) {
    const order = await prisma.order.findUnique({
      where: { id: data.order.id },
      select: { customerRelationId: true },
    });
    relationId = order?.customerRelationId ?? null;
  }

  const created: GenerateFromShipmentResult['created'] = [];
  const skipped: GenerateFromShipmentResult['skipped'] = [];


  for (const type of types) {
    if (type === 'PackingList') {
      const result = await registerPackingListDraft(prisma, { ...params, trustedActor: params.trustedActor ?? null });
      const item = { id: result.document.id, documentNumber: result.document.documentNumber, type };
      if (result.created) created.push(item); else skipped.push({ ...item, reason: 'EXISTS' });
      continue;
    }
    if (type === 'CommercialInvoice') {
      const result = await registerCanonicalCi(prisma, { ...ciOptions, sourceInvoiceId: ciSource!.invoice.id, expectedSourceFingerprint: ciSource!.fingerprint });
      const item = { type, id: result.document.id, documentNumber: result.document.documentNumber };
      if (result.created) created.push(item); else skipped.push({ ...item, reason: 'EXISTS' });
      continue;
    }
    const existing = await prisma.tradeDocument.findFirst({
      where: { shipmentId, type, deletedAt: null },
      select: { id: true, documentNumber: true },
    });
    if (existing) {
      skipped.push({ type, id: existing.id, documentNumber: existing.documentNumber, reason: 'EXISTS' });
      continue;
    }

    const ts = now();
    const doc = await prisma.$transaction(async (tx) => {
      const documentNumber = await generateTradeDocumentNumber(tx, type);
      const document = await tx.tradeDocument.create({
        data: {
          id: generateId('TD'),
          documentNumber,
          type,
          status: 'Draft',
          shipmentId,
          declarationId: null,
          orderId: data.order?.id ?? null,
          relationId,
          sourceInvoiceId: null,
          issueDate: localToday(),
          expiryDate: null,
          issuedBy: null,
          consignee: data.parties.consignee?.name ?? data.parties.customer?.name ?? null,
          consignor: data.customs?.consignor ?? null,
          portOfLoading: data.shipment.portOfLoading ?? null,
          portOfDischarge: data.shipment.portOfDischarge ?? null,
          totalAmount: data.totals.amount != null ? new Prisma.Decimal(data.totals.amount) : null,
          currency: data.totals.currency ?? data.order?.currency ?? data.customs?.currency ?? null,
          filePath: null,
          fileName: null,
          notes: null,
          createdAt: ts,
          updatedAt: ts,
        },
      });
      // v1 快照 = 装配数据 JSON（前端 EXPORT_DOC_RENDERERS 直接消费渲染）
      await appendTradeDocumentVersion(tx, {
        documentId: document.id,
        content: { documentSet: data as unknown as Record<string, unknown> },
        actorId,
        changeReason: '运单生成',
      });
      await tx.auditLog.create({
        data: {
          id: generateId('AUD'),
          action: 'TRADE_DOCUMENT_CREATE',
          actorId,
          targetType: 'TradeDocument',
          targetId: document.id,
          detail: { documentNumber, type, source: 'generate-from-shipment', shipmentId },
        },
      });
      return document;
    });
    created.push({ id: doc.id, documentNumber: doc.documentNumber, type: doc.type });
  }

  logger.info('[TradeDocumentLifecycle] generate-from-shipment', {
    shipmentId,
    created: created.length,
    skipped: skipped.length,
    actorId,
  });
  return { created, skipped, missing: data.missing };
}

// ────────────────────────────────────────────────────────────────
// 4. 批量打包（订单全部单据 + 最新版本快照）
// ────────────────────────────────────────────────────────────────

export interface TradeDocumentPackItem {
  id: string;
  documentNumber: string;
  type: string;
  status: string;
  issueDate: string | null;
  consignee: string | null;
  consignor: string | null;
  totalAmount: number | null;
  currency: string | null;
  fileName: string | null;
  /** 最新版本号（无版本=null） */
  latestVersion: number | null;
  /** 最新版本快照（含 documentSet，供前端渲染下载；无版本=null） */
  content: Record<string, unknown> | null;
  supplierDocumentProof?: 'approved_revision' | 'legacy_approval_unknown';
}

export async function packTradeDocumentsByOrder(
  prisma: PrismaClient,
  orderId: string,
): Promise<{ items: TradeDocumentPackItem[]; total: number }> {
  if (!orderId) throw new Error('orderId 必填');
  const docs = await prisma.tradeDocument.findMany({
    where: { orderId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });
  const items: TradeDocumentPackItem[] = [];
  for (const doc of docs) {
    const latest = await prisma.documentVersion.findFirst({
      where: { documentId: doc.id },
      orderBy: { version: 'desc' },
      select: { version: true, content: true },
    });
    items.push({
      id: doc.id,
      documentNumber: doc.documentNumber,
      type: doc.type,
      status: doc.status,
      issueDate: doc.issueDate,
      consignee: doc.consignee,
      consignor: doc.consignor,
      totalAmount: doc.totalAmount != null ? Number(doc.totalAmount) : null,
      currency: doc.currency,
      fileName: doc.fileName,
      latestVersion: latest?.version ?? null,
      content: (latest?.content as Record<string, unknown> | undefined) ?? null,
    });
  }
  return { items, total: items.length };
}

// ────────────────────────────────────────────────────────────────
// 5. 一键生成文件（版本快照 → PDF 落盘归档，TradeDocument.filePath/fileName 回写）
// ────────────────────────────────────────────────────────────────

/** 单据文件落盘根目录（与静态服务根同源：BAMBOOK_UPLOAD_DIR 或 apps/Bambook/uploads——
 *  index.ts 静态服务 /api/uploads 的根；本文件在 server/src/customs/ 下需三级回溯） */
const TRADE_DOC_UPLOAD_DIR = process.env.BAMBOOK_UPLOAD_DIR || path.join(__dirname, '../../../uploads');

/**
 * 服务端渲染单据文档 HTML（统一入口，2026-08-22 B1 架构底座 / B2 运营域扩展）：
 *   - CI 带财务回链 → 财务真源模板（renderInvoiceDocumentHtml）
 *   - 批次 H3 组合单据（sourceRef=composite:{kind}:{ids}）→ 实时重装配渲染；
 *     真源记录被删装配失败时回落最新版本快照的冻结数据（归档语义）
 *   - 类型映射进服务端注册表 → registry 渲染：
 *     · PL（customs）：版本快照 documentSet 装配
 *     · PO/IR（运营域）：sourceRef 业务真源实时装配（改业务侧即改文档）
 *   - 其余类型 → null（模板真源暂在前端，前端渲染 html 传入）
 * screen=true → preview.html 预览模式（A4 纸张画布）。
 */
export async function renderTradeDocumentServerHtml(
  prisma: PrismaClient,
  doc: { id: string; type: string; domain?: string; sourceInvoiceId: string | null; sourceRef: string | null },
  opts: { screen?: boolean; trustedActor?: TokenPayload | null; version?: number } = {},
): Promise<string | null> {
  if (isSupplierContractDocumentCandidate(doc)) return renderSupplierContractTradeDocument(prisma, { documentId: doc.id, actor: opts.trustedActor, version: opts.version });
  if (isExternalCustomsArchiveOnly(doc)) throw businessError('CONFLICT', '第三方单据只提供归档文件，不从订单数据预览或生成模板。');
  if (doc.type === 'CommercialInvoice') {
    const actual = await prisma.tradeDocument.findFirst({ where: { id: doc.id, deletedAt: null } });
    if (!actual || actual.type !== 'CommercialInvoice') throw businessError('NOT_FOUND', '原商业发票记录不存在。');
    if (isDevelopmentCi(actual)) {
      await currentDocumentActor(prisma, opts.trustedActor, ['customs:read']);
      const selected = await prisma.$transaction(tx => readDevelopmentCiVersionInTx(tx, actual.id, opts.trustedActor,
        { version: opts.version, finance: true }));
      if (!opts.screen && (selected.document.status !== 'Issued' || selected.version.id !== selected.latestVersion.id || !selected.snapshot.issuedAt))
        throw businessError('CONFLICT', '只有已签发的当前开发 CI 版本可以正式出单。');
      const html = renderDevelopmentCiDocument(selected, opts.screen);
      const final = await prisma.$transaction(tx => readDevelopmentCiVersionInTx(tx, actual.id, opts.trustedActor,
        { version: selected.version.version, finance: true }));
      if (ciHash(final.document) !== ciHash(selected.document) || ciHash(final.version) !== ciHash(selected.version))
        throw businessError('CONFLICT', '开发 CI 原票在读取期间变化。');
      await currentDocumentActor(prisma, opts.trustedActor, ['customs:read']);
      return html;
    }
    if (isBusinessShipmentCi(actual)) {
      const selected = await readBusinessShipmentCiVersion(prisma, actual.id, opts.trustedActor, { version: opts.version, requiredScopes: ['customs:read'] });
      if (!opts.screen && (selected.document.status !== 'Issued' || selected.version.id !== selected.latestVersion.id || !selected.snapshot.issuedAt))
        throw businessError('CONFLICT', '只有当前已签发的业务商业发票版本可以正式出单。');
      const html = await renderBusinessShipmentCiSnapshot(prisma, selected.snapshot, selected.document.documentNumber,
        { screen: opts.screen, draft: !selected.snapshot.issuedAt, historical: selected.version.id !== selected.latestVersion.id,
          cancelled: selected.document.status === 'Cancelled' });
      const final = await readBusinessShipmentCiVersion(prisma, actual.id, opts.trustedActor,
        { version: selected.version.version, requiredScopes: ['customs:read'] });
      if (final.fingerprint !== selected.fingerprint) throw businessError('CONFLICT', '商业发票预览期间来源或权限已变化。');
      return html;
    }
    if (opts.screen) return renderHistoricalCiInvoiceDocument(prisma, actual.id, opts);
    if (!actual.sourceInvoiceId) throw businessError('CONFLICT', '历史版本无原财务回链，不能正式出单。');
    await currentDocumentActor(prisma, opts.trustedActor, ['customs:read']);
    const html = await renderFinanceInvoiceDocument(prisma, actual.sourceInvoiceId, { ...opts, documentId: actual.id });
    await currentDocumentActor(prisma, opts.trustedActor, ['customs:read']);
    return html;
  }
  // Native QC uses the actual persisted document, not a caller's sourceRef.
  if (isQcReportDocumentCandidate(doc)) {
    const actual = await prisma.tradeDocument.findFirst({ where: { id: doc.id, deletedAt: null } });
    if (!actual) throw new QcReportError('NOT_FOUND', '验货归档单据不存在。');
    const source = await loadAuthorizedQcDocumentSource(prisma, opts.trustedActor, actual);
    return renderNativeQcHtml(prisma, actual, source.data, opts.screen);
  }
  if (await isPackingListCandidateInTx(prisma, doc)) {
    const selected = opts.version === undefined ? await readPackingListDocument(prisma, doc.id, opts.trustedActor ?? null)
      : await readPackingListVersion(prisma, { documentId: doc.id, version: opts.version, trustedActor: opts.trustedActor ?? null });
    const data = 'legacyMergedPreview' in selected ? selected.legacyMergedPreview : selected.envelope ?? (selected.item.content as any).documentSet;
    const html = await renderServerDocument(prisma, 'shipmentIds' in selected ? 'MERGED_PL' : 'PL', data, { ...opts, packingListWarnings: selected.warnings }, { id: doc.id, type: doc.type, sourceRef: doc.sourceRef ?? null });
    const final = await readPackingListVersion(prisma, { documentId: doc.id, version: selected.item.version, trustedActor: opts.trustedActor ?? null });
    if (selected.fingerprint !== final.fingerprint) throw businessError('CONFLICT', '装箱单预览期间当前来源或权限已变化。');
    return html;
  }
  // §10.3-9 电子签：单据已签署（存在已批准的签署审批）时按签署人取章盖入签名区；
  // 未签署 / 未登记签署审批的类型 → signer 为 null，渲染链不出章（fail-open 不阻断出单）。
  const signer = await resolveDocumentSignerByDoc(prisma, { type: doc.type, sourceRef: doc.sourceRef ?? null });
  const ctx = { id: doc.id, type: doc.type, sourceRef: doc.sourceRef ?? null, signer };
  // 批次 H3 组合单据（合并装箱单/合并合同台账记录）：sourceRef 回链实时重装配
  // （register:false 防登记回环）；真源缺失回落 v1 快照冻结数据
  if (doc.sourceRef?.startsWith('composite:')) {
    const { parseCompositeSourceRef, assembleCompositeDocument } = await import('./compositeDocumentService');
    const parsed = parseCompositeSourceRef(doc.sourceRef);
    if (!parsed) return null;
    try {
      const { kind, data } = await assembleCompositeDocument(
        prisma,
        { kind: parsed.kind, sourceIds: parsed.sourceIds },
        { register: false },
      );
      return await renderServerDocument(prisma, kind, data, opts, ctx);
    } catch {
      const latest = await prisma.documentVersion.findFirst({
        where: { documentId: doc.id },
        orderBy: { version: 'desc' },
        select: { content: true },
      });
      const snapshotData = (latest?.content as Record<string, unknown> | null | undefined)?.data;
      if (!snapshotData || typeof snapshotData !== 'object') return null;
      return renderServerDocument(prisma, parsed.kind, snapshotData, opts, ctx);
    }
  }
  // 服务端注册表类型（PL / PO / IR ...）——数据装配真源由各模板 loadData 决定
  const kind = serverKindForType(doc.type);
  if (kind) {
    const template = SERVER_DOC_TEMPLATES[kind];
    const data = await template.loadData(prisma, { id: doc.id, type: doc.type, sourceRef: doc.sourceRef ?? null });
    if (!data) return null;
    return renderServerDocument(prisma, kind, data, opts, ctx);
  }
  return null;
}

// ────────────────────────────────────────────────────────────────
// 4b. 域单据登记（B2 运营域：各业务模块就地生成 → 单据中心统一归档）
// ────────────────────────────────────────────────────────────────

/** 域单据登记入参（PO/IR/QUOT 等业务模块生成入口） */
export interface UpsertDomainTradeDocumentInput {
  domain: string;                 // procurement | qc | contract | finance | quotation
  type: TradeDocumentType;        // PurchaseOrder | InspectionReport | Contract ...
  sourceRef: string;              // 业务真源 id（PurchaseOrder.id / InspectionReport.id）
  /** 文档号（缺省自动取号 {前缀}-YYYY-NNNN；采购单裁决=poNumber 直用） */
  documentNumber?: string;
  orderId?: string | null;
  relationId?: string | null;
  totalAmount?: number | null;
  currency?: string | null;
  issueDate?: string | null;
  actorId: string;
  /** Required for native QC; identity supplied by server, never input actor metadata. */
  trustedActor?: TokenPayload | null;
}

export interface UpsertDomainTradeDocumentResult {
  documentId: string;
  documentNumber: string;
  /** created=首次登记（含 v1 快照）；updated=已存在刷新头字段（金额/日期回写真源） */
  outcome: 'created' | 'updated';
}

/**
 * 域单据登记（幂等）：domain+type+sourceRef 定位唯一文档。
 *   - 首次：创建 TradeDocument（domain 状态机初始 Draft）+ v1 轻量快照
 *     （content 记 sourceRef 元数据，不复制业务内容——渲染走真源实时装配，与 CI 财务回链同模式）
 *   - 已存在：刷新头字段（totalAmount/currency/issueDate 随业务侧更新），不追加版本
 *   - 软删后重新生成：旧文档保持软删（审计留痕），新建新文档接续取号
 * 域校验 fail-closed：未知 domain / 手动入口类型（customs 交单类）直接拒绝。
 */
export async function upsertDomainTradeDocument(prisma: PrismaClient, input: UpsertDomainTradeDocumentInput): Promise<UpsertDomainTradeDocumentResult> {
  rejectGenericSupplierDocumentWrite(input);
  if (input.domain !== 'qc' || input.type !== 'InspectionReport') return upsertDomainTradeDocumentInternal(prisma, input);
  if (!input.trustedActor?.userId || input.actorId !== input.trustedActor.userId) {
    throw new QcReportError('UNAUTHORIZED', '验货报告登记需要当前可信登录身份。', 'actor_mismatch');
  }
  try {
    return await prisma.$transaction(async tx => {
      const source = await qcReportDocumentSource(tx, input.trustedActor, input.sourceRef, 'qc:write', true);
      if (input.orderId !== undefined && input.orderId !== source.report.orderId) {
        throw new QcReportError('CONFLICT', '报告关联订单已变化，请刷新后重试。', 'source_changed');
      }
      return upsertDomainTradeDocumentInternal(prisma, { ...input, actorId: source.actor.userId,
        orderId: source.report.orderId, issueDate: source.report.inspectionDate }, tx);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  } catch (error) { throw qcReportFailure(error); }
}

async function upsertDomainTradeDocumentInternal(
  prisma: PrismaClient,
  input: UpsertDomainTradeDocumentInput,
  authorizedTx?: any,
): Promise<UpsertDomainTradeDocumentResult> {
  const { docStatusTransitionsFor } = await import('./customsService');
  const db = authorizedTx ?? prisma;
  const transaction = (work: (tx: any) => Promise<void>) => authorizedTx ? work(authorizedTx) : prisma.$transaction(work);
  docStatusTransitionsFor(input.domain); // fail-closed：未知域直接抛错

  const existing = await db.tradeDocument.findFirst({
    where: { domain: input.domain, type: input.type, sourceRef: input.sourceRef, deletedAt: null },
    select: { id: true, documentNumber: true, orderId: true },
  });

  if (existing) {
    if (authorizedTx && input.domain === 'qc' && input.type === 'InspectionReport') {
      await authorizedTx.$queryRaw(Prisma.sql`SELECT "id" FROM "TradeDocument" WHERE "id" = ${existing.id} FOR UPDATE`);
      const actual = await authorizedTx.tradeDocument.findFirst({ where: { id: existing.id, deletedAt: null } });
      await qcReportDocumentSource(authorizedTx, input.trustedActor, input.sourceRef, 'qc:write');
      if (!actual || !isNativeQcDocument(actual) || actual.sourceRef !== input.sourceRef || actual.orderId !== input.orderId) {
        throw new QcReportError('CONFLICT', '归档单据与实际报告来源不一致，请重新登记。', 'source_changed');
      }
    }
    await transaction(async (tx: any) => {
      await tx.tradeDocument.update({
        where: { id: existing.id },
        data: {
          totalAmount: input.totalAmount != null ? new Prisma.Decimal(input.totalAmount) : undefined,
          currency: input.currency ?? undefined,
          issueDate: input.issueDate ?? undefined,
          updatedAt: now(),
        },
      });
      await tx.auditLog.create({
        data: {
          id: generateId('AUD'),
          actorId: input.actorId,
          action: 'TRADE_DOCUMENT_DOMAIN_REFRESH',
          targetType: 'TradeDocument',
          targetId: existing.id,
          detail: { domain: input.domain, type: input.type, sourceRef: input.sourceRef } as any,
          ip: null,
          operationType: 'update',
          fieldPath: null,
          beforeValue: null as any,
          afterValue: null as any,
          transactionId: null,
        },
      });
    });
    return { documentId: existing.id, documentNumber: existing.documentNumber, outcome: 'updated' };
  }

  const documentNumber = input.documentNumber?.trim() || await generateTradeDocumentNumber(db, input.type);
  const documentId = generateId('TD');
  await transaction(async (tx: any) => {
    await tx.tradeDocument.create({
      data: {
        id: documentId,
        documentNumber,
        domain: input.domain,
        type: input.type,
        status: 'Draft',
        orderId: input.orderId ?? null,
        relationId: input.relationId ?? null,
        sourceRef: input.sourceRef,
        totalAmount: input.totalAmount != null ? new Prisma.Decimal(input.totalAmount) : null,
        currency: input.currency ?? null,
        issueDate: input.issueDate ?? localToday(),
        createdAt: now(),
        updatedAt: now(),
      },
    });
    // v1 轻量快照：记录真源外链元数据（版本行可在单据中心展开；渲染不依赖快照）
    await appendTradeDocumentVersion(tx, {
      documentId,
      content: { source: 'domain', domain: input.domain, type: input.type, sourceRef: input.sourceRef },
      actorId: input.actorId,
      changeReason: `${input.domain} 域单据登记`,
    });
  });
  return { documentId, documentNumber, outcome: 'created' };
}

/** 按域外链查找单据（预览/生成文件入口用：sourceRef 一跳定位文档） */
export async function findDomainTradeDocument(
  prisma: PrismaClient,
  params: { domain: string; type: string; sourceRef: string },
): Promise<{ id: string; documentNumber: string; status: string; filePath: string | null; fileName: string | null } | null> {
  const doc = await prisma.tradeDocument.findFirst({
    where: { domain: params.domain, type: params.type, sourceRef: params.sourceRef, deletedAt: null },
    select: { id: true, documentNumber: true, status: true, filePath: true, fileName: true },
  });
  return doc ?? null;
}

/**
 * 生成单据文件 → 服务端 Puppeteer 转 PDF → 落盘 uploads/trade-documents/ →
 * 回写 TradeDocument.filePath/fileName。
 *
 * HTML 来源（按模板真源归属，2026-08-22 B1 起三级优先）：
 *   1. 服务端模板（CI 财务回链 / 注册表类型 PL…）：服务端自渲染（忽略入参 html，防双源漂移）
 *   2. 其余类型：前端渲染的完整 HTML（模板真源暂在前端 EXPORT_DOC_RENDERERS，B6 迁移收尾）
 *
 * 文件命名 `{documentNumber}-v{version}.pdf`：同版本重复生成覆盖（版本快照不变
 * 则文件理应一致，幂等）；跨版本各自留档，与版本留痕语义对齐。
 */
export async function generateTradeDocumentFile(
  prisma: PrismaClient,
  params: { id: string; html?: string; version?: number; actorId: string; trustedActor?: TokenPayload | null },
): Promise<{ filePath: string; fileName: string; fileSize: number }> {
  const { id, actorId } = params;
  const html = typeof params.html === 'string' ? params.html : '';
  if (!id) throw new Error('id 必填');

  const doc = await prisma.tradeDocument.findFirst({ where: { id, deletedAt: null } });
  if (!doc) throw new Error(`贸易单据 ${id} 不存在`);
  if (isSupplierContractDocumentCandidate(doc)) {
    rejectGenericSupplierDocumentWrite(doc);
  }
  if (isExternalCustomsArchiveOnly(doc)) throw businessError('CONFLICT', '第三方单据只允许上传归档，不可由系统模板生成。');

  if (await isPackingListCandidateInTx(prisma, doc) || await isPackingListArchiveCandidate(prisma, doc)) return generatePackingListArchive(prisma, { documentId: id, version: params.version, actorId, trustedActor: params.trustedActor ?? null });
  if (isBusinessShipmentCi(doc)) return generateBusinessShipmentCiDocumentFile(prisma, doc, params);
  if (isDevelopmentCi(doc)) return generateDevelopmentCiArchive(prisma, doc, params);
  if (doc.type === 'CommercialInvoice') return generateCanonicalCiDocumentFile(prisma, doc, params);
  if (isQcReportDocumentCandidate(doc)) return generateNativeQcDocumentFile(prisma, doc, params);

  // 服务端模板优先（CI 财务回链 / 注册表 PL 等）——忽略入参 html 防双源漂移
  let renderHtml = html;
  const serverHtml = await renderTradeDocumentServerHtml(prisma, doc);
  if (serverHtml) renderHtml = serverHtml;
  if (!renderHtml || renderHtml.length < 50) throw new Error('无可渲染内容（版本快照缺失或 html 无效）');
  if (renderHtml.length > 2 * 1024 * 1024) throw new Error('渲染内容过大（>2MB），拒绝执行');

  // 版本号：优先入参（前端点的是具体版本行），兜底最新版本
  let version = params.version;
  if (version == null) {
    const latest = await prisma.documentVersion.findFirst({
      where: { documentId: id },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    version = latest?.version ?? 1;
  }

  const pdf = await renderHtmlToPdf(renderHtml, { format: 'A4' });
  const dir = path.join(TRADE_DOC_UPLOAD_DIR, 'trade-documents');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const sanitizedNo = doc.documentNumber.replace(/[^\w.-]/g, '_');
  const fileName = `${sanitizedNo}-v${version}.pdf`;
  const physicalName = `${doc.id}-${fileName}`;
  fs.writeFileSync(path.join(dir, physicalName), pdf.pdf);

  const filePath = `trade-documents/${physicalName}`;
  const ts = BigInt(Date.now());
  await prisma.tradeDocument.update({
    where: { id },
    data: { filePath, fileName, updatedAt: ts },
  });
  await prisma.auditLog.create({
    data: {
      id: generateId('AUD'),
      action: 'TRADE_DOCUMENT_FILE_GENERATED',
      actorId,
      targetType: 'TradeDocument',
      targetId: id,
      detail: { version, fileName, fileSize: pdf.bytes, sha: pdf.sha },
    },
  });

  logger.info('[TradeDocumentLifecycle] generate-file', { id, version, fileName, actorId });
  return { filePath, fileName, fileSize: pdf.bytes };
}


export function isNativeQcDocument(doc: { domain?: string; type?: string } | null | undefined): boolean {
  return doc?.domain === 'qc' && doc.type === 'InspectionReport';
}

/** A misleading domain/type cannot route a real report through the generic IR loader. */
export function isQcReportDocumentCandidate(doc: { domain?: string; type?: string } | null | undefined): boolean {
  return doc?.domain === 'qc' || doc?.type === 'InspectionReport';
}

export async function loadAuthorizedQcDocumentSource(prisma: PrismaClient, actor: TokenPayload | null | undefined,
  doc: any, scope: 'qc:read' | 'qc:write' = 'qc:read') {
  const source = await loadAuthorizedQcReportSource(prisma, actor, doc.sourceRef, scope);
  assertNativeQcDocumentSource(doc, source.report);
  return source;
}

function assertNativeQcDocumentSource(doc: any, report: any) {
  if (!isNativeQcDocument(doc) || doc.sourceRef !== report.id || doc.orderId !== report.orderId) {
    throw new QcReportError('CONFLICT', '归档单据与实际报告来源不一致，请重新登记。', 'source_changed');
  }
}

async function renderNativeQcHtml(prisma: PrismaClient, doc: any, data: any, screen = false) {
  const signer = await resolveDocumentSignerByDoc(prisma, { type: doc.type, sourceRef: doc.sourceRef });
  return renderServerDocument(prisma, 'IR', data, { screen }, { id: doc.id, type: doc.type, sourceRef: doc.sourceRef, signer });
}

/** Existing native archives must match a committed mandatory generation audit
 * AND the currently authorized source. Legacy unverified/stale archives require
 * regeneration; a global customs scope cannot disclose another QC report. */
export async function assertQcTradeDocumentArchive(prisma: PrismaClient, doc: any, actor?: TokenPayload | null) {
  const filePath = typeof doc.filePath === 'string' ? path.posix.normalize(doc.filePath) : null;
  try {
    await prisma.$transaction(async tx => {
      const actual = await tx.tradeDocument.findFirst({ where: { id: doc.id, deletedAt: null } });
      if (!actual) throw new QcReportError('NOT_FOUND', '归档单据不存在。');
      // Domain survives a Draft type edit. Canonical fileRef + immutable native
      // generation audit also survives copying the path onto an ordinary PL.
      const record = actual.domain === 'qc' ? actual : filePath
        ? await tx.tradeDocument.findFirst({ where: { domain: 'qc', filePath } }) : null;
      const generations = filePath ? await tx.auditLog.findMany({ where: { targetType: 'TradeDocument',
        action: 'TRADE_DOCUMENT_FILE_GENERATED', detail: { path: ['filePath'], equals: filePath } }, orderBy: { createdAt: 'desc' } }) : [];
      // A later ordinary audit cannot hide an earlier native provenance fact.
      const provenance = generations.find(audit => {
        const fact = audit.detail as Record<string, unknown> | null;
        return typeof fact?.sourceReportId === 'string' && typeof fact?.sourceFingerprint === 'string';
      });
      const detail = provenance?.detail as Record<string, unknown> | null | undefined;
      const nativeRecord = record?.domain === 'qc' ? record : null;
      const auditReportId = typeof detail?.sourceReportId === 'string' ? detail.sourceReportId : null;
      const protectedPrefix = !!filePath?.startsWith('trade-documents/qc-');
      const reportCandidate = isQcReportDocumentCandidate(actual);
      if (!nativeRecord && !auditReportId && !protectedPrefix && !reportCandidate) return; // ordinary non-QC path, original behavior
      const reportId = nativeRecord?.sourceRef ?? auditReportId ?? (reportCandidate ? actual.sourceRef : null);
      if (!reportId) throw new QcReportError('CONFLICT', '验货归档文件来源未核验，请重新生成。', 'source_changed');
      const source = await qcReportDocumentSource(tx, actor, reportId, 'qc:read');
      if (actual.filePath !== doc.filePath || actual.domain !== 'qc' || actual.type !== 'InspectionReport'
        || actual.sourceRef !== source.report.id || actual.orderId !== source.report.orderId
        || (nativeRecord && nativeRecord.id !== actual.id) || (provenance && provenance.targetId !== actual.id)) {
        throw new QcReportError('CONFLICT', '归档文件不属于该原生验货报告，禁止改类型或借用文件路径。', 'source_changed');
      }
      if (!filePath) throw new QcReportError('NOT_FOUND', '该报告尚未生成归档文件。');
      if (!detail || detail.sourceFingerprint !== source.fingerprint || auditReportId !== source.report.id) {
        throw new QcReportError('CONFLICT', '报告归档尚未核验或来源已变化，请重新生成后下载。', 'source_changed');
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  } catch (error) { throw qcReportFailure(error); }
}

/** Files and PostgreSQL are distinct resources: each render has a unique file.
 * Only a post-render authorized locked commit publishes its reference and
 * mandatory audit. Failure removes this attempt's file; old archives stay intact. */
async function generateNativeQcDocumentFile(prisma: PrismaClient, doc: any,
  params: { version?: number; actorId: string; trustedActor?: TokenPayload | null }) {
  if (!params.trustedActor?.userId || params.actorId !== params.trustedActor.userId) {
    throw new QcReportError('UNAUTHORIZED', '生成验货报告需要当前可信登录身份。', 'actor_mismatch');
  }
  const source = await loadAuthorizedQcDocumentSource(prisma, params.trustedActor, doc, 'qc:write');
  const docFingerprint = qcReportSourceFingerprint(doc);
  const html = await renderNativeQcHtml(prisma, doc, source.data);
  if (!html || html.length < 50 || html.length > 2 * 1024 * 1024) {
    throw new QcReportError('VALIDATION_FAILED', '验货报告模板无有效可渲染内容。');
  }
  const latest = await prisma.documentVersion.findFirst({ where: { documentId: doc.id }, orderBy: { version: 'desc' }, select: { version: true } });
  const version = params.version ?? latest?.version ?? 1;
  const pdf = await renderHtmlToPdf(html, { format: 'A4' });
  const dir = path.join(TRADE_DOC_UPLOAD_DIR, 'trade-documents');
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `${doc.documentNumber.replace(/[^\w.-]/g, '_')}-v${version}.pdf`;
  const physicalName = `qc-${doc.id.replace(/[^\w.-]/g, '_')}-${crypto.randomUUID()}-${fileName}`;
  const physicalPath = path.join(dir, physicalName);
  const filePath = `trade-documents/${physicalName}`;
  let written = false;
  try {
    fs.writeFileSync(physicalPath, pdf.pdf, { flag: 'wx' });
    written = true;
    await prisma.$transaction(async tx => {
      let current = await qcReportDocumentSource(tx, params.trustedActor, doc.sourceRef, 'qc:write', true);
      const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "TradeDocument" WHERE "id" = ${doc.id} FOR UPDATE`);
      const actual = await tx.tradeDocument.findFirst({ where: { id: doc.id, deletedAt: null } });
      current = await qcReportDocumentSource(tx, params.trustedActor, doc.sourceRef, 'qc:write');
      if (!locked.length || !actual || !isNativeQcDocument(actual) || qcReportSourceFingerprint(actual) !== docFingerprint
        || current.fingerprint !== source.fingerprint) {
        throw new QcReportError('CONFLICT', '报告来源或归档记录已变化，请重新生成。', 'source_changed');
      }
      assertNativeQcDocumentSource(actual, current.report);
      await tx.tradeDocument.update({ where: { id: doc.id }, data: { filePath, fileName, updatedAt: BigInt(Date.now()) } });
      await tx.auditLog.create({ data: { id: generateId('AUD'), action: 'TRADE_DOCUMENT_FILE_GENERATED',
        actorId: current.actor.userId, targetType: 'TradeDocument', targetId: doc.id,
        detail: { version, filePath, fileName, fileSize: pdf.bytes, sha: pdf.sha,
          sourceReportId: current.report.id, sourceFingerprint: current.fingerprint } } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    return { filePath, fileName, fileSize: pdf.bytes };
  } catch (error) {
    if (written) {
      // A lost commit acknowledgement is not proof of rollback. Delete only a
      // successfully checked unpublished attempt; on DB uncertainty preserve it
      // privately for reconciliation, never return it or erase a committed file.
      try {
        const published = await prisma.tradeDocument.findFirst({ where: { id: doc.id, filePath }, select: { id: true } });
        const audit = await prisma.auditLog.findFirst({ where: { targetType: 'TradeDocument', targetId: doc.id,
          action: 'TRADE_DOCUMENT_FILE_GENERATED', detail: { path: ['filePath'], equals: filePath } }, select: { id: true } });
        if (!published && !audit) fs.unlinkSync(physicalPath);
      } catch (cleanupError) { logger.error('[TradeDocumentLifecycle] native QC unpublished attempt cleanup unconfirmed', { cleanupError }); }
    }
    throw qcReportFailure(error);
  }
}

/** CI render and publication have separate physical resources. Only locked
 * original source + document + mandatory audit commit can publish this unique
 * file. Lost commit acknowledgement preserves privately uncertain attempts. */
async function generateCanonicalCiDocumentFile(prisma: PrismaClient, document: any,
  params: { version?: number; actorId: string; trustedActor?: TokenPayload | null }) {
  if (!params.trustedActor?.userId || params.actorId !== params.trustedActor.userId) throw businessError('UNAUTHORIZED', '生成商业发票需要当前可信登录身份。');
  const readOptions = { trustedActor: params.trustedActor, mode: 'register' as const };
  const { source } = await readAuthorizedCiDocument(prisma, document.id, readOptions);
  const documentFingerprint = documentSourceFingerprint(document);
  const html = await renderFinanceInvoiceDocument(prisma, source.invoice.id, { ...readOptions, documentId: document.id, expectedSourceFingerprint: source.fingerprint });
  if (!html || html.length < 50 || html.length > 2 * 1024 * 1024) throw businessError('VALIDATION_FAILED', '原发票模板没有有效内容。');
  const latest = await prisma.documentVersion.findFirst({ where: { documentId: document.id }, orderBy: { version: 'desc' }, select: { version: true } });
  const version = params.version ?? latest?.version ?? 1;
  if (version !== (latest?.version ?? 1)) throw businessError('CONFLICT', '正式商业发票必须按当前原发票重新生成，历史版本只能预览。');
  const pdf = await renderHtmlToPdf(html, { format: 'A4' });
  const dir = path.join(TRADE_DOC_UPLOAD_DIR, 'trade-documents'); fs.mkdirSync(dir, { recursive: true });
  const fileName = `${document.documentNumber.replace(/[^\w.-]/g, '_')}-v${version}.pdf`;
  const physicalName = `ci-${document.id.replace(/[^\w.-]/g, '_')}-${crypto.randomUUID()}-${fileName}`;
  const physicalPath = path.join(dir, physicalName), filePath = `trade-documents/${physicalName}`;
  let written = false;
  try {
    fs.writeFileSync(physicalPath, pdf.pdf, { flag: 'wx' }); written = true;
    await prisma.$transaction(async tx => {
      const registered = await registerCanonicalCiInTx(tx, { ...readOptions, sourceInvoiceId: source.invoice.id,
        ...(document.shipmentId ? { shipmentId: document.shipmentId } : {}), expectedSourceFingerprint: source.fingerprint });
      if (registered.created || registered.document.id !== document.id || documentSourceFingerprint(registered.document) !== documentFingerprint)
        throw businessError('CONFLICT', '原商业发票或文件记录已变化，请重新生成。');
      await tx.tradeDocument.update({ where: { id: document.id }, data: { filePath, fileName, updatedAt: BigInt(Date.now()) } });
      await tx.auditLog.create({ data: { id: generateId('AUD'), action: 'TRADE_DOCUMENT_FILE_GENERATED', actorId: params.trustedActor!.userId,
        targetType: 'TradeDocument', targetId: document.id, detail: { version, filePath, fileName, fileSize: pdf.bytes, sha: pdf.sha,
          sourceInvoiceId: source.invoice.id, sourceFingerprint: source.fingerprint, sourceSnapshot: source as any } } });
      await readAuthorizedCiDocumentInTx(tx, document.id, { ...readOptions, expectedSourceFingerprint: source.fingerprint });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    return { filePath, fileName, fileSize: pdf.bytes };
  } catch (error) {
    if (written) {
      try {
        const published = await prisma.tradeDocument.findFirst({ where: { id: document.id, filePath }, select: { id: true } });
        const audit = await prisma.auditLog.findFirst({ where: { targetType: 'TradeDocument', targetId: document.id,
          action: 'TRADE_DOCUMENT_FILE_GENERATED', detail: { path: ['filePath'], equals: filePath } }, select: { id: true } });
        if (!published && !audit) fs.unlinkSync(physicalPath);
      } catch (cleanupError) { logger.error('[TradeDocumentLifecycle] CI attempt cleanup unconfirmed', { cleanupError }); }
    }
    throw error;
  }
}

/** Publish a logistics-owned CI from its exact immutable issued DocumentVersion. */
async function generateBusinessShipmentCiDocumentFile(prisma: PrismaClient, document: any,
  params: { version?: number; actorId: string; trustedActor?: TokenPayload | null }) {
  if (!params.trustedActor?.userId || params.actorId !== params.trustedActor.userId)
    throw businessError('UNAUTHORIZED', '生成商业发票需要当前可信登录身份。');
  const selected = await readBusinessShipmentCiVersion(prisma, document.id, params.trustedActor, { version: params.version, requiredScopes: ['customs:write'] });
  if (selected.document.status !== 'Issued' || selected.version.id !== selected.latestVersion.id || !selected.snapshot.issuedAt)
    throw businessError('CONFLICT', '只有当前已签发的业务商业发票版本可以生成正式归档。');
  const documentFingerprint = documentSourceFingerprint(selected.document);
  const contentFingerprint = documentSourceFingerprint(selected.snapshot);
  const html = await renderBusinessShipmentCiSnapshot(prisma, selected.snapshot, selected.document.documentNumber);
  if (!html || html.length < 50 || html.length > 2 * 1024 * 1024) throw businessError('VALIDATION_FAILED', '业务商业发票快照没有有效内容。');
  const version = selected.version.version;
  const pdf = await renderHtmlToPdf(html, { format: 'A4' });
  const dir = path.join(TRADE_DOC_UPLOAD_DIR, 'trade-documents'); fs.mkdirSync(dir, { recursive: true });
  const documentNumber = selected.document.documentNumber.replace(/[^\w.-]/g, '_');
  const physicalName = `ci-business-${selected.document.id.replace(/[^\w.-]/g, '_')}-${crypto.randomUUID()}-${documentNumber}-v${version}.pdf`;
  const physicalPath = path.join(dir, physicalName), filePath = `trade-documents/${physicalName}`;
  const fileName = `${documentNumber}-v${version}.pdf`;
  let written = false;
  try {
    fs.writeFileSync(physicalPath, pdf.pdf, { flag: 'wx' }); written = true;
    await prisma.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "TradeDocument" WHERE "id"=${document.id} FOR UPDATE`);
      const final = await readBusinessShipmentCiVersionInTx(tx, document.id, params.trustedActor!, { version, requiredScopes: ['customs:write'] });
      if (final.document.status !== 'Issued' || final.version.id !== final.latestVersion.id
        || final.fingerprint !== selected.fingerprint || documentSourceFingerprint(final.document) !== documentFingerprint
        || documentSourceFingerprint(final.snapshot) !== contentFingerprint || !final.snapshot.issuedAt)
        throw businessError('CONFLICT', '已签发 CI 或原出运来源在归档期间变化，请重新核对。');
      await tx.tradeDocument.update({ where: { id: document.id }, data: { filePath, fileName, updatedAt: BigInt(Date.now()) } });
      await tx.auditLog.create({ data: { id: generateId('AUD'), action: 'TRADE_DOCUMENT_FILE_GENERATED', actorId: params.trustedActor!.userId,
        targetType: 'TradeDocument', targetId: document.id, detail: { version, filePath, fileName, fileSize: pdf.bytes, sha: pdf.sha,
          businessCiVersionId: selected.version.id, businessCiVersion: version, businessCiSnapshotFingerprint: contentFingerprint,
          businessCiSourceFingerprint: selected.snapshot.sourceFingerprint } } });
      await readBusinessShipmentCiVersionInTx(tx, document.id, params.trustedActor!, { version, requiredScopes: ['customs:write'] });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    return { filePath, fileName, fileSize: pdf.bytes };
  } catch (error) {
    if (written) {
      try {
        const published = await prisma.tradeDocument.findFirst({ where: { id: document.id, filePath }, select: { id: true } });
        const audit = await prisma.auditLog.findFirst({ where: { targetType: 'TradeDocument', targetId: document.id,
          action: 'TRADE_DOCUMENT_FILE_GENERATED', detail: { path: ['filePath'], equals: filePath } }, select: { id: true } });
        if (!published && !audit) fs.unlinkSync(physicalPath);
      } catch (cleanupError) { logger.error('[TradeDocumentLifecycle] business CI unpublished attempt cleanup unconfirmed', { cleanupError }); }
    }
    throw error;
  }
}

/** Central download/ZIP routes call this before returning existing CI bytes.
 * Native CI files are tied to the actual original Invoice and exact rendering
 * source audit. A legacy archive retains read-only history only when its old
 * per-document path and original generation audit agree; no history is repaired. */
export async function assertCiTradeDocumentArchive(prisma: PrismaClient, requested: any, trustedActor?: TokenPayload | null) {
  await prisma.$transaction(async tx => {
    await currentDocumentActor(tx, trustedActor, ['customs:read']);
    const actual = await tx.tradeDocument.findFirst({ where: { id: requested.id, deletedAt: null } });
    if (!actual) throw businessError('NOT_FOUND', '归档单据不存在。');
    if (isDevelopmentCi(actual)) return assertDevelopmentCiArchiveInTx(tx, actual, requested, trustedActor);
    const requestedPath = typeof requested.filePath === 'string' ? path.posix.normalize(requested.filePath) : null;
    if (isBusinessShipmentCi(actual)) {
      if (actual.type !== 'CommercialInvoice' || actual.filePath !== requested.filePath || !requestedPath
        || !requestedPath.startsWith('trade-documents/ci-business-'))
        throw businessError('CONFLICT', '归档文件不属于当前已签发的业务商业发票。');
      const generations = await tx.auditLog.findMany({ where: { action: 'TRADE_DOCUMENT_FILE_GENERATED', targetType: 'TradeDocument',
        targetId: actual.id, detail: { path: ['filePath'], equals: requestedPath } } });
      const proof = generations.find(row => typeof (row.detail as any)?.businessCiVersionId === 'string')?.detail as any;
      if (!proof || !Number.isSafeInteger(proof.businessCiVersion)) throw businessError('CONFLICT', '业务商业发票归档缺少来源版本凭据。');
      const history = await readBusinessShipmentCiVersionInTx(tx, actual.id, trustedActor, { version: proof.businessCiVersion, requiredScopes: ['customs:read'] });
      if (actual.status !== 'Issued' || history.version.id !== history.latestVersion.id || !history.snapshot.issuedAt
        || proof.businessCiVersionId !== history.version.id || proof.businessCiSnapshotFingerprint !== documentSourceFingerprint(history.snapshot)
        || proof.businessCiSourceFingerprint !== history.snapshot.sourceFingerprint || proof.fileName !== actual.fileName
        || typeof proof.sha !== 'string' || !/^[0-9a-f]{64}$/.test(proof.sha) || !Number.isSafeInteger(proof.fileSize) || proof.fileSize <= 0)
        throw businessError('CONFLICT', '业务商业发票归档来源或文件凭据已变化。');
      await currentDocumentActor(tx, trustedActor, ['customs:read']);
      return;
    }
    const ciPrefix = requestedPath?.startsWith('trade-documents/ci-');
    const generations = requestedPath ? await tx.auditLog.findMany({ where: { action: 'TRADE_DOCUMENT_FILE_GENERATED',
      detail: { path: ['filePath'], equals: requestedPath } } }) : [];
    const native = generations.find(row => typeof (row.detail as any)?.sourceInvoiceId === 'string');
    if (actual.type !== 'CommercialInvoice' && !ciPrefix && !native) return;
    if (actual.type !== 'CommercialInvoice' || actual.filePath !== requested.filePath || !requestedPath) throw businessError('CONFLICT', '归档文件不属于当前原商业发票。');
    const detail = native?.detail as any;
    const history = await readHistoricalCiDocumentInTx(tx, actual.id, { trustedActor: trustedActor ?? null,
      ...(detail?.sourceSnapshot ? { additionalSnapshots: [detail.sourceSnapshot] } : {}) });
    if (ciPrefix || native) {
      if (!detail?.sourceSnapshot || detail.sourceSnapshot.invoice?.id !== history.currentInvoice?.id
        || detail.sourceSnapshot.fingerprint !== detail.sourceFingerprint
        || documentSourceFingerprint(Object.fromEntries(Object.entries(detail.sourceSnapshot).filter(([key]) => key !== 'fingerprint'))) !== detail.sourceFingerprint)
        throw businessError('CONFLICT', '原归档文件的来源快照凭据损坏。');
      if (!native || native.targetId !== actual.id || detail.sourceInvoiceId !== history.currentInvoice?.id || typeof detail.sourceFingerprint !== 'string' || typeof detail.sha !== 'string' || !/^[0-9a-f]{64}$/.test(detail.sha) || !Number.isSafeInteger(detail.fileSize) || detail.fileSize <= 0
        || detail.fileName !== actual.fileName) throw businessError('CONFLICT', '原发票归档来源未核验或已变化，请重新生成。');
    } else {
      const expectedStem = actual.id + '-' + actual.documentNumber.replace(/[^\w.-]/g, '_') + '-v';
      const legacy = await tx.auditLog.findMany({ where: { action: 'TRADE_DOCUMENT_FILE_GENERATED', targetType: 'TradeDocument', targetId: actual.id } });
      if (!requestedPath.startsWith('trade-documents/' + expectedStem) || !legacy.some(row => (row.detail as any)?.fileName === actual.fileName))
        throw businessError('CONFLICT', '该历史归档文件没有原单据生成凭据，只能阅读原历史版本。');
    }
    await currentDocumentActor(tx, trustedActor, ['customs:read', ...(history.currentInvoice ? ['invoices:read' as const] : [])]);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
