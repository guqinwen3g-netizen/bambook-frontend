import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { buildCompositeSourceRef } from '../customs/compositeDocumentService';
import { assembleContractData } from '../customs/compositeDocumentService';
import { DEFAULT_EXPORTER_PROFILE, EXPORTER_PROFILE_CONFIG_ID } from '../config/systemConfigRoute';
import { buildContractClausePreview, CONTRACT_FIXED_CLAUSES_VERSION, CONTRACT_TEMPLATE_VERSION } from '../templates/docTemplates/contract';
import { loadOrderConfirmationDocData, ORDER_CONFIRMATION_TEMPLATE_VERSION } from '../templates/docTemplates/orderConfirmation';
import { assembleQuotationDocData, buildQuotationClausePreview, freezeQuotationDocumentImages,
  isFrozenQuotationDocumentImage, QUOTATION_TEMPLATE_VERSION } from '../templates/docTemplates/quotation';
import { localDateKey } from '../shared/localDate';


export const APPROVAL_SIGN_DOCUMENT_SNAPSHOT_KEY = 'documentSnapshot';

export type ApprovalSignDocumentKind = 'Quotation' | 'OrderConfirmation' | 'Contract';

export interface ApprovalSignDocumentSnapshot {
  schemaVersion: 1;
  kind: ApprovalSignDocumentKind;
  sourceRef: string;
  sourceIds: string[];
  templateVersion: string;
  clauses?: { version: string; entries: Array<{ no: number; title: string; body: string }>; quantityTolerance: string; generalClause: string };
  exporterProfile: Record<string, unknown>;
  exporterProfileSource: { configId: string; version: number; updatedAt: string | null; isDefault: boolean };
  data: Record<string, any>;
  /** Exact source decimals are stored as strings here, independently of template Number fields. */
  exactSource: Record<string, any>;
  sourceFingerprint: string;
  contentFingerprint: string;
}

type ApprovalForSignDocument = {
  id: string;
  actionType: string;
  targetType: string;
  targetId: string | null;
  payload: unknown;
};
type DbClient = PrismaClient | Prisma.TransactionClient;

type BuildInput =
  | { kind: 'Quotation'; quotationId: string; quotationSource?: any }
  | { kind: 'OrderConfirmation'; orderId: string }
  | { kind: 'Contract'; sourceIds: string[] };

const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, any> : {};
const text = (value: unknown): string => value == null ? '' : String(value).trim();
const hexDigest = /^[a-f0-9]{64}$/;
const exactDecimal = (value: unknown) => value == null ? null : String(value);

function jsonSafe(value: any): any {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    // Prisma Decimal is deliberately serialized as decimal text, never Number.
    if (typeof value.toFixed === 'function' && typeof value.toString === 'function') return value.toString();
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, jsonSafe(value[key])]));
  }
  return value;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(jsonSafe(value))).digest('hex');
}

function orderFacts(order: any) {
  if (!order || order.deletedAt) throw new ApprovalSignDocumentSnapshotError('订单不存在或已删除，不能冻结签署文件。');
  return {
    id: String(order.id),
    poNumber: order.poNumber ?? null,
    customer: order.customer ?? null,
    status: order.status ?? null,
    dueDate: order.dueDate ?? null,
    currency: order.currency ?? null,
    salesCurrency: order.salesCurrency ?? null,
    totalNet: order.totalNet ?? null,
    quoteAmount: order.quoteAmount ?? null,
    deliveryTerms: order.deliveryTerms ?? null,
    paymentTerms: order.paymentTerms ?? null,
    salesContractNumber: order.salesContractNumber ?? null,
    finalContractNumber: order.finalContractNumber ?? null,
    shipToName: order.shipToName ?? null,
    shipToAddress1: order.shipToAddress1 ?? null,
    shipToAddress2: order.shipToAddress2 ?? null,
    shipToCountry: order.shipToCountry ?? null,
    shipmentDate: order.shipmentDate ?? null,
    insuranceMode: order.insuranceMode ?? null,
    claimPeriodDays: order.claimPeriodDays ?? null,
    disputeResolution: order.disputeResolution ?? null,
    customerRelationId: order.customerRelationId ?? null,
    createdAt: order.createdAt ?? null,
    lines: (Array.isArray(order.lines) ? order.lines : []).map((line: any) => ({
      id: String(line.id), lineNumber: line.lineNumber, itemNo: line.itemNo ?? null,
      description: line.description ?? null, quantity: line.quantity ?? null, unit: line.unit ?? null,
      unitPrice: line.unitPrice ?? null, netValue: line.netValue ?? null,
      deliveryDate: line.deliveryDate ?? null, tolerancePercent: line.tolerancePercent ?? null,
    })),
  };
}

function relationFacts(relation: any) {
  if (!relation) return null;
  return {
    id: String(relation.id), name: relation.name ?? null,
    englishName: relation.englishName ?? null, chineseName: relation.chineseName ?? null,
    contactInfo: relation.contactInfo ?? null,
  };
}

async function exactOrderSource(prisma: any, orderId: string, kind: ApprovalSignDocumentKind) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { lines: { orderBy: [{ lineNumber: 'asc' }, { id: 'asc' }] } } });
  const relation = order?.customerRelationId
    ? await prisma.relation.findUnique({ where: { id: order.customerRelationId } }) : null;
  return { order: orderFacts(order), customer: relationFacts(relation), ...(kind === 'Contract' ? { shipments: [] as any[] } : {}) };
}

async function readAuthoritativeExporterProfile(prisma: any): Promise<{
  value: Record<string, unknown>; source: ApprovalSignDocumentSnapshot['exporterProfileSource'];
}> {
  let row: any;
  try { row = await prisma.systemConfig.findUnique({ where: { id: EXPORTER_PROFILE_CONFIG_ID } }); }
  catch { throw new ApprovalSignDocumentSnapshotError('出口方档案读取失败，不能冻结签署文档。'); }
  if (!row) return { value: jsonSafe({ nameEn: DEFAULT_EXPORTER_PROFILE.nameEn, addressEn: DEFAULT_EXPORTER_PROFILE.addressEn }),
    source: { configId: EXPORTER_PROFILE_CONFIG_ID, version: 0, updatedAt: null, isDefault: true } };
  if (row.encrypted === true || !row.value || typeof row.value !== 'object' || Array.isArray(row.value))
    throw new ApprovalSignDocumentSnapshotError('出口方档案格式无法核验，不能冻结签署文档。');
  const current = { ...DEFAULT_EXPORTER_PROFILE, ...(row.value as Record<string, unknown>) } as Record<string, unknown>;
  if (typeof current.nameEn !== 'string' || !current.nameEn.trim() || typeof current.addressEn !== 'string')
    throw new ApprovalSignDocumentSnapshotError('出口方档案缺少卖方名称或地址，不能冻结签署文档。');
  const value = { nameEn: current.nameEn, addressEn: current.addressEn };
  return { value: jsonSafe(value), source: { configId: EXPORTER_PROFILE_CONFIG_ID, version: Number(row.version),
    updatedAt: row.updatedAt == null ? null : String(row.updatedAt), isDefault: false } };
}

async function buildSnapshot(prisma: DbClient, input: BuildInput, frozenGeneratedData?: Record<string, any>): Promise<ApprovalSignDocumentSnapshot> {
  const db = prisma as any;
  const { value: exporterProfile, source: exporterProfileSource } = await readAuthoritativeExporterProfile(db);
  if (input.kind === 'Quotation') {
    const quotationId = text(input.quotationId);
    if (!quotationId) throw new ApprovalSignDocumentSnapshotError('报价签署缺少报价编号。');
    const quotation = input.quotationSource ?? await db.quotation.findUnique({ where: { id: quotationId },
      include: { lines: { orderBy: [{ lineNumber: 'asc' }, { id: 'asc' }] } } });
    if (!quotation || quotation.id !== quotationId || quotation.deletedAt)
      throw new ApprovalSignDocumentSnapshotError('报价来源不存在或已删除，不能冻结签署文件。');
    let data: ReturnType<typeof assembleQuotationDocData>;
    try { data = freezeQuotationDocumentImages(assembleQuotationDocData(quotation)); }
    catch (error: any) {
      throw new ApprovalSignDocumentSnapshotError(String(error?.message ?? '报价图片无法读取，请重新上传后再提交正式签署。'));
    }
    // Lifecycle status is neither printed nor commercial content. Keep it out
    // of the signed document so Draft → Sent does not invalidate a signature.
    data.qt.status = '';
    const clausePreview = buildQuotationClausePreview(data);
    const exactSource = {
      quotation: {
        id: String(quotation.id), quotationNumber: quotation.quotationNumber ?? null,
        version: quotation.version ?? null,
        currency: quotation.currency ?? null, totalAmount: exactDecimal(quotation.totalAmount),
        issueDate: quotation.issueDate ?? null, validUntil: quotation.validUntil ?? null,
        deliveryTerms: quotation.deliveryTerms ?? null, paymentTerms: quotation.paymentTerms ?? null,
        salesperson: quotation.salesperson ?? null, inquiryRef: quotation.inquiryRef ?? null,
        notes: quotation.notes ?? null, customerName: quotation.customerName ?? null,
        customerCode: quotation.customerCode ?? null, customerRelationId: quotation.customerRelationId ?? null,
        lines: (Array.isArray(quotation.lines) ? quotation.lines : []).map((line: any) => ({
          id: String(line.id), lineNumber: line.lineNumber, fabricCode: line.fabricCode ?? null,
          description: line.description ?? null, quantity: exactDecimal(line.quantity), unit: line.unit ?? null,
          unitPrice: exactDecimal(line.unitPrice), amount: exactDecimal(line.amount), notes: line.notes ?? null,
          imageUrl: line.imageUrl ?? null,
        })),
      },
      exporterProfileSource,
    };
    return finalizeSnapshot({ kind: input.kind, sourceRef: quotationId, sourceIds: [quotationId],
      templateVersion: QUOTATION_TEMPLATE_VERSION,
      clauses: { version: clausePreview.version, entries: jsonSafe(clausePreview.entries) } as any,
      exporterProfile, exporterProfileSource, data: jsonSafe(data), exactSource });
  }
  if (input.kind === 'OrderConfirmation') {
    const orderId = text(input.orderId);
    if (!orderId) throw new ApprovalSignDocumentSnapshotError('订单确认书缺少订单编号。');
    const [data, exactSource] = await Promise.all([
      loadOrderConfirmationDocData(prisma as PrismaClient, orderId), exactOrderSource(db, orderId, input.kind),
    ]);
    if (!data) throw new ApprovalSignDocumentSnapshotError('订单确认书来源订单不存在或已删除。');
    return finalizeSnapshot({ kind: input.kind, sourceRef: orderId, sourceIds: [orderId],
      templateVersion: ORDER_CONFIRMATION_TEMPLATE_VERSION, exporterProfile, exporterProfileSource,
      data: jsonSafe(data), exactSource: { ...exactSource, exporterProfileSource } });
  }

  const sourceIds = validateContractIds(input.sourceIds);
  const sourceRef = buildCompositeSourceRef('CONTRACT', sourceIds);
  const [assembled, orders, shipments] = await Promise.all([
    assembleContractData(prisma as PrismaClient, sourceIds),
    Promise.all(sourceIds.map(id => db.order.findUnique({ where: { id }, include: { lines: { orderBy: [{ lineNumber: 'asc' }, { id: 'asc' }] } } }))),
    db.shipment.findMany({ where: { orderId: { in: sourceIds }, deletedAt: null },
      select: { id: true, orderId: true, portOfLoading: true, portOfDischarge: true }, orderBy: { id: 'asc' } }),
  ]);
  const relationId = orders.map((order: any) => order?.customerRelationId).find(Boolean) ?? null;
  const relation = relationId ? await db.relation.findUnique({ where: { id: relationId } }) : null;
  const data = jsonSafe(assembled) as Record<string, any>;
  // Contract date and the generated fallback contract number are creation facts,
  // not mutable order terms. Preserve them for later live-source comparisons.
  if (frozenGeneratedData?.contractDate) data.contractDate = frozenGeneratedData.contractDate;
  if (frozenGeneratedData?.contractNumber) data.contractNumber = frozenGeneratedData.contractNumber;
  const exactSource = {
    orders: orders.map((order: any) => orderFacts(order)),
    customer: relationFacts(relation),
    exporterProfileSource,
    shipments: (shipments ?? []).map((shipment: any) => ({
      id: String(shipment.id), orderId: String(shipment.orderId),
      portOfLoading: shipment.portOfLoading ?? null, portOfDischarge: shipment.portOfDischarge ?? null,
    })),
  };
  const clausePreview = buildContractClausePreview(data as any);
  return finalizeSnapshot({ kind: input.kind, sourceRef, sourceIds, templateVersion: CONTRACT_TEMPLATE_VERSION,
    clauses: { version: `${CONTRACT_TEMPLATE_VERSION}/${CONTRACT_FIXED_CLAUSES_VERSION}`, entries: jsonSafe(clausePreview.entries),
      quantityTolerance: clausePreview.quantityTolerance, generalClause: clausePreview.generalClause },
    exporterProfile, exporterProfileSource, data, exactSource });
}

function finalizeSnapshot(params: Omit<ApprovalSignDocumentSnapshot, 'schemaVersion' | 'sourceFingerprint' | 'contentFingerprint'>): ApprovalSignDocumentSnapshot {
  const exactSource = jsonSafe(params.exactSource);
  const sourceFingerprint = digest({ kind: params.kind, sourceRef: params.sourceRef, sourceIds: params.sourceIds, exactSource });
  const contentFingerprint = digest({ schemaVersion: 1, ...params, exactSource, sourceFingerprint });
  return { schemaVersion: 1, ...jsonSafe(params), exactSource, sourceFingerprint, contentFingerprint } as ApprovalSignDocumentSnapshot;
}

function validateContractIds(ids: unknown): string[] {
  if (!Array.isArray(ids) || ids.length < 2 || ids.some(id => typeof id !== 'string' || !id.trim())
    || new Set(ids).size !== ids.length) throw new ApprovalSignDocumentSnapshotError('合并合同需要至少两个不同的订单编号。');
  return ids.map(id => String(id).trim());
}

export class ApprovalSignDocumentSnapshotError extends Error {
  code = 'APPROVAL_CONTENT_CHANGED';
  statusCode = 409;
  constructor(message: string) { super(message); this.name = 'ApprovalSignDocumentSnapshotError'; }
}

export async function buildApprovalSignDocumentSnapshot(prisma: DbClient, input: BuildInput): Promise<ApprovalSignDocumentSnapshot> {
  return buildSnapshot(prisma, input);
}

export async function buildQuotationApprovalSignDocumentSnapshot(prisma: DbClient, quotation: any): Promise<ApprovalSignDocumentSnapshot> {
  return buildSnapshot(prisma, { kind: 'Quotation', quotationId: text(quotation?.id), quotationSource: quotation });
}

/** Request/apply writers enter through the Quotation parent before locking its lines and exporter config. */
export async function lockQuotationSignDocumentSources(tx: Prisma.TransactionClient, quotationId: string): Promise<void> {
  await (tx as any).$queryRawUnsafe('SELECT "id" FROM "Quotation" WHERE "id"=$1 FOR UPDATE', quotationId);
  await (tx as any).$queryRawUnsafe('SELECT "id" FROM "QuotationLine" WHERE "quotationId"=$1 ORDER BY "id" FOR UPDATE', quotationId);
  await (tx as any).$queryRawUnsafe('SELECT "id" FROM "SystemConfig" WHERE "id"=$1 FOR UPDATE', EXPORTER_PROFILE_CONFIG_ID);
}

export function getApprovalSignDocumentSnapshot(approval: ApprovalForSignDocument): ApprovalSignDocumentSnapshot | null {
  const payload = object(approval.payload);
  const snapshot = object(payload[APPROVAL_SIGN_DOCUMENT_SNAPSHOT_KEY]) as unknown as ApprovalSignDocumentSnapshot;
  const expectedKind = approval.actionType === 'quotation:total_approve' && approval.targetType === 'Quotation'
    ? 'Quotation' : approval.actionType === 'order:confirmation_sign' && approval.targetType === 'OrderConfirmation'
    ? 'OrderConfirmation' : approval.actionType === 'contract:sign' && approval.targetType === 'Contract' ? 'Contract' : null;
  if (!expectedKind || snapshot.schemaVersion !== 1 || snapshot.kind !== expectedKind
    || !snapshot.sourceRef || !Array.isArray(snapshot.sourceIds) || !snapshot.sourceIds.length
    || !snapshot.templateVersion || !object(snapshot.exporterProfile) || !object(snapshot.exporterProfileSource)
    || !object(snapshot.data) || !object(snapshot.exactSource)
    || !hexDigest.test(snapshot.sourceFingerprint) || !hexDigest.test(snapshot.contentFingerprint)) return null;
  if (expectedKind === 'Quotation') {
    if (snapshot.sourceIds.length !== 1 || snapshot.sourceRef !== approval.targetId
      || snapshot.sourceIds[0] !== approval.targetId || payload.quotationId !== approval.targetId
      || snapshot.templateVersion !== QUOTATION_TEMPLATE_VERSION
      || snapshot.clauses?.version !== QUOTATION_TEMPLATE_VERSION
      || !Array.isArray(snapshot.clauses.entries)
      || !Array.isArray(snapshot.data.lines)
      || snapshot.data.lines.some((line: any) => line?.imageUrl != null && !isFrozenQuotationDocumentImage(line.imageUrl))
      || JSON.stringify(jsonSafe(snapshot.clauses.entries)) !== JSON.stringify(jsonSafe(buildQuotationClausePreview(snapshot.data as any).entries))) return null;
  } else if (expectedKind === 'OrderConfirmation') {
    if (snapshot.sourceIds.length !== 1 || snapshot.sourceRef !== approval.targetId
      || snapshot.sourceIds[0] !== approval.targetId || payload.orderId !== approval.targetId) return null;
  } else {
    if (approval.targetId !== snapshot.sourceRef || payload.sourceRef !== snapshot.sourceRef
      || JSON.stringify(payload.sourceIds) !== JSON.stringify(snapshot.sourceIds)
      || snapshot.sourceRef !== buildCompositeSourceRef('CONTRACT', snapshot.sourceIds)) return null;
  }
  if (digest({ kind: snapshot.kind, sourceRef: snapshot.sourceRef, sourceIds: snapshot.sourceIds, exactSource: snapshot.exactSource }) !== snapshot.sourceFingerprint) return null;
  const { contentFingerprint, ...signedContent } = snapshot;
  if (digest(signedContent) !== contentFingerprint) return null;
  if (expectedKind === 'Quotation' && snapshot.templateVersion !== QUOTATION_TEMPLATE_VERSION) return null;
  if (expectedKind === 'OrderConfirmation' && snapshot.templateVersion !== ORDER_CONFIRMATION_TEMPLATE_VERSION) return null;
  if (expectedKind === 'Contract' && (snapshot.templateVersion !== CONTRACT_TEMPLATE_VERSION
    || snapshot.clauses?.version !== `${CONTRACT_TEMPLATE_VERSION}/${CONTRACT_FIXED_CLAUSES_VERSION}`
    || JSON.stringify(jsonSafe(snapshot.clauses.entries)) !== JSON.stringify(jsonSafe(buildContractClausePreview(snapshot.data as any).entries))
    || snapshot.clauses.quantityTolerance !== buildContractClausePreview(snapshot.data as any).quantityTolerance
    || snapshot.clauses.generalClause !== buildContractClausePreview(snapshot.data as any).generalClause)) return null;
  return snapshot;
}

export function approvalSignDocumentPreviewFields(snapshot: ApprovalSignDocumentSnapshot): Array<{ key: string; label: string; value: string }> {
  const rows: Array<{ key: string; label: string; value: string }> = [];
  const add = (key: string, label: string, value: unknown) => {
    if (value !== null && value !== undefined && String(value) !== '') rows.push({ key, label, value: String(value) });
  };
  const data = snapshot.data;
  add('exporterProfile.nameEn', '卖方名称', snapshot.exporterProfile.nameEn);
  add('exporterProfile.addressEn', '卖方地址', snapshot.exporterProfile.addressEn);
  if (snapshot.kind === 'Quotation') {
    const qt = object(data.qt);
    add('quotation.quotationNumber', '报价单号', qt.quotationNumber);
    add('quotation.version', '报价版本', object(snapshot.exactSource.quotation).version);
    add('quotation.issueDate', '报价日期', qt.issueDate);
    add('quotation.inquiryRef', '询价参考', qt.inquiryRef);
    add('quotation.customerName', '客户', qt.customerName);
    add('quotation.customerCode', '客户编码', qt.customerCode);
    add('quotation.salesperson', '业务员', qt.salesperson);
    add('quotation.currency', '报价币种', qt.currency);
    add('quotation.totalAmount', '报价总额', object(snapshot.exactSource.quotation).totalAmount);
    add('quotation.validUntil', '有效期至', qt.validUntil);
    add('quotation.deliveryTerms', '交货条款', qt.deliveryTerms);
    add('quotation.paymentTerms', '付款条款', qt.paymentTerms);
    add('quotation.notes', '报价备注', qt.notes);
    const exact = object(snapshot.exactSource.quotation);
    const exactLines = Array.isArray(exact.lines) ? exact.lines : [];
    const lines = Array.isArray(data.lines) ? data.lines : [];
    lines.forEach((line: any, index: number) => {
      const source = object(exactLines[index]);
      const prefix = `quotation.lines.${index + 1}`;
      add(`${prefix}.fabricCode`, `第 ${index + 1} 行面料编号`, line.fabricCode);
      add(`${prefix}.description`, `第 ${index + 1} 行品名`, line.description);
      add(`${prefix}.quantity`, `第 ${index + 1} 行数量`, source.quantity);
      add(`${prefix}.unit`, `第 ${index + 1} 行单位`, line.unit);
      add(`${prefix}.unitPrice`, `第 ${index + 1} 行精确单价`, source.unitPrice);
      add(`${prefix}.amount`, `第 ${index + 1} 行精确金额`, source.amount);
      add(`${prefix}.notes`, `第 ${index + 1} 行备注`, line.notes);
      add(`${prefix}.image`, `第 ${index + 1} 行图片`, line.imageUrl ? '[已冻结在签署预览]' : '');
    });
    (snapshot.clauses?.entries ?? []).forEach(clause => {
      add(`quotation.clauses.${clause.no}`, clause.title, clause.body);
    });
    return rows;
  }
  if (snapshot.kind === 'OrderConfirmation') {
    const order = object(data.order);
    add('order.poNumber', '客户采购单号', order.poNumber);
    add('order.customer', '客户', order.customer);
    const createdAt = Number(order.createdAt);
    add('order.createdAt', '确认日期', Number.isFinite(createdAt) && createdAt > 0 ? localDateKey(new Date(createdAt)) : '—');
    add('order.currency', '币种', order.currency);
    add('order.orderAmount', '订单总金额', order.orderAmount);
    add('order.dueDate', '订单交期', order.dueDate);
    add('order.deliveryTerms', '贸易术语', order.deliveryTerms);
    add('order.paymentTerms', '付款方式', order.paymentTerms);
    add('order.salesContractNumber', '销售合同号', order.salesContractNumber);
    add('order.finalContractNumber', '最终合同号', order.finalContractNumber);
    add('order.shipToAddress', '收货地址', order.shipToAddress);
    const customer = object(data.customer);
    add('customer.name', '客户档案名称', customer.name);
    add('customer.englishName', '客户英文名称', customer.englishName);
    add('customer.chineseName', '客户中文名称', customer.chineseName);
    add('customer.contactInfo', '客户联系方式', customer.contactInfo);
    (Array.isArray(data.lines) ? data.lines : []).forEach((line: any, index: number) => {
      const prefix = `orderLines.${index + 1}`;
      add(`${prefix}.lineNumber`, `第 ${index + 1} 行行号`, line.lineNumber);
      add(`${prefix}.itemNo`, `第 ${index + 1} 行品号`, line.itemNo);
      add(`${prefix}.description`, `第 ${index + 1} 行品名描述`, line.description);
      add(`${prefix}.quantity`, `第 ${index + 1} 行数量`, line.quantity);
      add(`${prefix}.unit`, `第 ${index + 1} 行单位`, line.unit);
      add(`${prefix}.unitPrice`, `第 ${index + 1} 行单价`, line.unitPrice);
      add(`${prefix}.netValue`, `第 ${index + 1} 行金额`, line.netValue);
      add(`${prefix}.deliveryDate`, `第 ${index + 1} 行交期`, line.deliveryDate);
      add(`${prefix}.tolerancePercent`, `第 ${index + 1} 行溢短装容差`, line.tolerancePercent);
    });
    const exactLines = object(snapshot.exactSource.order).lines;
    (Array.isArray(exactLines) ? exactLines : []).forEach((line: any, index: number) => {
      add(`exactSource.order.lines.${index + 1}.quantity`, `第 ${index + 1} 行来源精确数量`, line.quantity);
      add(`exactSource.order.lines.${index + 1}.unitPrice`, `第 ${index + 1} 行来源精确单价`, line.unitPrice);
      add(`exactSource.order.lines.${index + 1}.netValue`, `第 ${index + 1} 行来源精确金额`, line.netValue);
    });
    add('exactSource.order.totalNet', '订单成交净额来源值（精确）', object(snapshot.exactSource.order).totalNet);
    add('exactSource.order.quoteAmount', '订单报价金额来源值（精确）', object(snapshot.exactSource.order).quoteAmount);
    return rows;
  }
  add('data.contractNumber', '合同编号', data.contractNumber);
  add('data.contractDate', '合同日期', data.contractDate);
  const customer = object(data.customer);
  add('customer.name', '客户档案名称', customer.name);
  add('customer.englishName', '客户英文名称', customer.englishName);
  add('customer.chineseName', '客户中文名称', customer.chineseName);
  add('customer.contactInfo', '客户联系方式', customer.contactInfo);
  (Array.isArray(data.orders) ? data.orders : []).forEach((order: any, index: number) => {
    const prefix = `orders.${index + 1}`;
    add(`${prefix}.poNumber`, `订单 ${index + 1} 客户采购单号`, order.poNumber);
    add(`${prefix}.customer`, `订单 ${index + 1} 客户`, order.customer);
    add(`${prefix}.currency`, `订单 ${index + 1} 币种`, order.currency);
    add(`${prefix}.orderAmount`, `订单 ${index + 1} 金额`, order.orderAmount);
    add(`${prefix}.dueDate`, `订单 ${index + 1} 交期`, order.dueDate);
    add(`${prefix}.lineCount`, `订单 ${index + 1} 行数`, order.lineCount);
    add(`${prefix}.shipmentDate`, `订单 ${index + 1} 装运期`, order.shipmentDate);
    add(`${prefix}.deliveryTerms`, `订单 ${index + 1} 贸易术语`, order.deliveryTerms);
    add(`${prefix}.paymentTerms`, `订单 ${index + 1} 付款方式`, order.paymentTerms);
    add(`${prefix}.insuranceMode`, `订单 ${index + 1} 保险方式`, order.insuranceMode);
    add(`${prefix}.claimPeriodDays`, `订单 ${index + 1} 索赔期限（天）`, order.claimPeriodDays);
    add(`${prefix}.disputeResolution`, `订单 ${index + 1} 争议解决方式`, order.disputeResolution);
    add(`${prefix}.portOfLoading`, `订单 ${index + 1} 起运港`, order.portOfLoading);
    add(`${prefix}.portOfDischarge`, `订单 ${index + 1} 目的港`, order.portOfDischarge);
  });
  add('totals.currency', '合同币种', data.totals?.currency);
  add('totals.amount', '合同总金额', data.totals?.amount);
  add('totals.quantity', '合同总数量', data.totals?.quantity);
  (Array.isArray(data.lines) ? data.lines : []).forEach((line: any, index: number) => {
    const prefix = `contractLines.${index + 1}`;
    add(`${prefix}.orderIndex`, `明细 ${index + 1} 所属订单序号`, line.orderIndex);
    add(`${prefix}.itemNo`, `明细 ${index + 1} 品号`, line.itemNo);
    add(`${prefix}.description`, `明细 ${index + 1} 品名描述`, line.description);
    add(`${prefix}.quantity`, `明细 ${index + 1} 数量`, line.quantity);
    add(`${prefix}.unit`, `明细 ${index + 1} 单位`, line.unit);
    add(`${prefix}.unitPrice`, `明细 ${index + 1} 单价`, line.unitPrice);
    add(`${prefix}.netValue`, `明细 ${index + 1} 金额`, line.netValue);
    add(`${prefix}.tolerancePercent`, `明细 ${index + 1} 溢短装容差`, line.tolerancePercent);
  });
  const exactOrders = Array.isArray(snapshot.exactSource.orders) ? snapshot.exactSource.orders : [];
  exactOrders.forEach((order: any, orderIndex: number) => {
    add(`exactSource.orders.${orderIndex + 1}.totalNet`, `订单 ${orderIndex + 1} 成交净额来源值（精确）`, order.totalNet);
    add(`exactSource.orders.${orderIndex + 1}.quoteAmount`, `订单 ${orderIndex + 1} 报价金额来源值（精确）`, order.quoteAmount);
  });
  const exactLines = exactOrders.flatMap((order: any, orderIndex: number) =>
    (Array.isArray(order.lines) ? order.lines : []).map((line: any) => ({ ...line, orderIndex })));
  exactLines.forEach((line: any, index: number) => {
    add(`exactSource.contractLines.${index + 1}.quantity`, `明细 ${index + 1} 来源精确数量`, line.quantity);
    add(`exactSource.contractLines.${index + 1}.unitPrice`, `明细 ${index + 1} 来源精确单价`, line.unitPrice);
    add(`exactSource.contractLines.${index + 1}.netValue`, `明细 ${index + 1} 来源精确金额`, line.netValue);
  });
  add('clauses.quantityTolerance', '合同溢短装条款全文', snapshot.clauses?.quantityTolerance);
  (snapshot.clauses?.entries ?? []).forEach(clause => {
    add(`clauses.${clause.no}.title`, `固定条款 ${clause.no}`, clause.title);
    add(`clauses.${clause.no}.body`, `固定条款 ${clause.no} 正文`, clause.body);
  });
  add('clauses.generalClause', '合同一般条款全文', snapshot.clauses?.generalClause);
  return rows;
}

function inputForApproval(approval: ApprovalForSignDocument): BuildInput {
  const snapshot = getApprovalSignDocumentSnapshot(approval);
  if (!snapshot) throw new ApprovalSignDocumentSnapshotError('本次签署申请缺少完整且有效的冻结文档快照，请重新提交签署。');
  return snapshot.kind === 'Quotation' ? { kind: 'Quotation', quotationId: snapshot.sourceIds[0] }
    : snapshot.kind === 'OrderConfirmation'
    ? { kind: 'OrderConfirmation', orderId: snapshot.sourceIds[0] }
    : { kind: 'Contract', sourceIds: snapshot.sourceIds };
}

export async function assertCurrentApprovalSignDocumentSnapshot(prisma: DbClient, approval: ApprovalForSignDocument): Promise<ApprovalSignDocumentSnapshot> {
  const frozen = getApprovalSignDocumentSnapshot(approval);
  const current = await readCurrentApprovalSignDocumentSnapshot(prisma, approval);
  if (!frozen || current.sourceFingerprint !== frozen.sourceFingerprint || current.contentFingerprint !== frozen.contentFingerprint)
    throw new ApprovalSignDocumentSnapshotError('订单或合同当前内容与已签署冻结版本不同，请重新提交签署。');
  return current;
}

/** Compare a quote using the very ORM row the caller already validated and will render. */
export async function assertCurrentQuotationSignDocumentSnapshot(prisma: DbClient, approval: ApprovalForSignDocument,
  quotation: any): Promise<ApprovalSignDocumentSnapshot> {
  const frozen = getApprovalSignDocumentSnapshot(approval);
  const current = await buildQuotationApprovalSignDocumentSnapshot(prisma, quotation);
  if (!frozen || frozen.kind !== 'Quotation' || current.sourceFingerprint !== frozen.sourceFingerprint
    || current.contentFingerprint !== frozen.contentFingerprint)
    throw new ApprovalSignDocumentSnapshotError('报价正文、条款、卖方档案或模板与已批准冻结版本不同。');
  return current;
}

/** Read the current authorized native source, preserving generated Contract header fields from the reference snapshot. */
export async function readCurrentApprovalSignDocumentSnapshot(prisma: DbClient, approval: ApprovalForSignDocument): Promise<ApprovalSignDocumentSnapshot> {
  const frozen = getApprovalSignDocumentSnapshot(approval);
  const input = inputForApproval(approval);
  const current = await buildSnapshot(prisma, input, frozen?.kind === 'Contract' ? frozen.data : undefined);
  return current;
}

/**
 * Existing order-change writes use Order → OrderChangeRequest → OrderLine → ApprovalRequest.
 * Signing locks all source Orders, then their Relations, OrderLines, and (for a
 * Contract) Shipments in stable order before the shared kernel locks ApprovalRequest.
 * Shipment writers enter through lockReleaseSources, which takes parent Orders and
 * source Relations/OrderLines before Shipment; ordinary Relation writers only need
 * the Relation row. This keeps aggregate signing compatible with those native locks.
 */
export async function lockAndAssertCurrentApprovalSignDocumentSnapshot(tx: Prisma.TransactionClient, approval: ApprovalForSignDocument): Promise<ApprovalSignDocumentSnapshot> {
  const frozen = getApprovalSignDocumentSnapshot(approval);
  const input = inputForApproval(approval);
  if (input.kind === 'Quotation') {
    await lockQuotationSignDocumentSources(tx, input.quotationId);
    return assertCurrentApprovalSignDocumentSnapshot(tx, approval);
  }
  const orderIds = input.kind === 'OrderConfirmation' ? [input.orderId] : [...input.sourceIds].sort();
  for (const id of orderIds) await (tx as any).$queryRawUnsafe('SELECT "id" FROM "Order" WHERE "id"=$1 FOR UPDATE', id);
  const currentOrders = await (tx as any).order.findMany({ where: { id: { in: orderIds } }, select: { id: true, customerRelationId: true } });
  if (currentOrders.length !== orderIds.length) throw new ApprovalSignDocumentSnapshotError('签署关联订单已缺失或被删除。');
  const relationIds = [...new Set(currentOrders.map((order: any) => order.customerRelationId).filter(Boolean))].sort();
  for (const id of relationIds) await (tx as any).$queryRawUnsafe('SELECT "id" FROM "Relation" WHERE "id"=$1 FOR UPDATE', id);
  for (const id of orderIds) await (tx as any).$queryRawUnsafe('SELECT "id" FROM "OrderLine" WHERE "orderId"=$1 ORDER BY "id" FOR UPDATE', id);
  if (input.kind === 'Contract') {
    // Shipment writers take the same parent Order locks before their Shipment
    // row, so this Order → Relation → OrderLine → Shipment order is consistent.
    const shipments = await (tx as any).shipment.findMany({ where: { orderId: { in: orderIds }, deletedAt: null }, select: { id: true }, orderBy: { id: 'asc' } });
    for (const shipment of shipments) await (tx as any).$queryRawUnsafe('SELECT "id" FROM "Shipment" WHERE "id"=$1 FOR UPDATE', shipment.id);
  }
  await (tx as any).$queryRawUnsafe('SELECT "id" FROM "SystemConfig" WHERE "id"=$1 FOR UPDATE', EXPORTER_PROFILE_CONFIG_ID);
  return assertCurrentApprovalSignDocumentSnapshot(tx, approval);
}
