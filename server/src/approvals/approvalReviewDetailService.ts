import { createHash } from 'node:crypto';
import { Prisma, type ApprovalRequest, type PrismaClient } from '@prisma/client';
import { approvalReviewContentVersion } from './approvalReviewContent';
import { buildQuotationSnapshot, canonicalQuotationJson, quotationApprovalSourceState } from '../quotations/quotationApprovalSnapshot';
import { assertCurrentMoqApproval } from '../moq/moqApprovalBasis';
import { assertClaimSnapshot } from '../claims/claimApprovalFact';
import { buildOrderChangeFinalVersion, captureOrderChangeReviewBasis } from '../orderChanges/orderChangeFinalVersion';
import { canonicalCustomerConfirmationJson } from '../customerConfirmations/customerConfirmationService';
import { approvalSignDocumentPreviewFields, assertCurrentApprovalSignDocumentSnapshot,
  buildQuotationApprovalSignDocumentSnapshot, getApprovalSignDocumentSnapshot, readCurrentApprovalSignDocumentSnapshot } from './approvalSignDocumentSnapshotService';
import { decideShortShipment, loadLineRemainingPlan } from '../shipping/shortShipmentGate';
import { gateToleranceOf, loadToleranceStandards, resolveLineTolerance } from '../orders/toleranceStandardService';
import { isShipmentCancelled } from '../shared/shippingLock';
import type { TokenPayload } from '../auth/service';
import { assertPaymentRequestPayableApproval } from '../paymentRequests/paymentRequestPayableSource';

export interface ApprovalReviewField {
  key: string;
  label: string;
  value: string;
}

export interface ApprovalReviewAttachment {
  id: string;
  fileName: string;
  href: string;
  mimeType?: string;
}

export interface ApprovalReviewSourceReference {
  kind: string;
  id: string;
  label: string;
}

export interface ApprovalReviewHistoryEntry {
  id: string;
  action: string;
  actorId: string;
  actorName: string | null;
  occurredAt: string;
  decisionNote?: string;
  status?: string;
}

export interface ApprovalReviewDetail {
  schemaVersion: 1;
  approvalId: string;
  actionType: string;
  targetType: string;
  targetId: string | null;
  title: string;
  reviewContentVersion: string;
  frozen: {
    label: string;
    fields: ApprovalReviewField[];
    attachments: ApprovalReviewAttachment[];
    attachmentStatus: 'available' | 'unavailable' | 'not_applicable';
    attachmentStatusLabel: string;
    sourceReference: ApprovalReviewSourceReference | null;
    previewDigest: string;
  };
  currentSource: {
    status: 'available' | 'missing' | 'unavailable' | 'not_applicable';
    label: string;
    fields: ApprovalReviewField[];
  };
  decisionHistory: ApprovalReviewHistoryEntry[];
  decisionHistoryStatus: 'available' | 'unavailable';
  approvalBlockers: string[];
  canApprove: boolean;
}

type ReviewApproval = Pick<ApprovalRequest,
  'id' | 'requesterId' | 'reviewerId' | 'actionType' | 'targetType' | 'targetId' | 'payload' | 'status'> &
  Partial<Pick<ApprovalRequest, 'createdAt' | 'decidedAt' | 'decisionNote'>>;

const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, any> : {};
const text = (value: unknown): string => value == null ? '' : String(value).trim();
const present = (value: unknown): boolean => value !== null && value !== undefined && !(typeof value === 'string' && !value.trim());
const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const FIELD_LABELS: Record<string, string> = {
  requestNumber: '申请单号', quotationNumber: '报价单号', quotationId: '报价记录', quotationSnapshot: '报价冻结版本', quotationVersion: '报价版本',
  contractKind: '合同类别', supplierRelationId: '供应商记录', mainDeliveryLocation: '主要交付地点',
  orderDate: '下单日期', requestedDeliveryDate: '本行要求交期', supplierCommittedDeliveryDate: '供应商承诺交期',
  inputSource: '原料准确来源', specification: '规格', processType: '加工工序', businessOwnerId: '真实经办人',
  exceptionNumber: '例外单号', exceptionCategory: '例外分类', subCategory: '例外子类', exceptionReason: '例外理由',
  supplierName: '供应商', supplierId: '供应商记录', customerName: '客户', customerRelationId: '客户关系记录',
  totalAmount: '总金额', amount: '金额', waivedAmount: '减免金额', currency: '币种', quantity: '数量', unit: '单位',
  unitPrice: '单价', deviationPercent: '价格偏差', paymentCategory: '付款用途', payeeType: '收款对象类型',
  expectedPaymentDate: '预计付款日期', requestDate: '申请日期', sourceDocument: '来源单据', reason: '申请原因',
  changeReason: '变更原因', description: '说明', itemId: '事项', itemNo: '收费项编号', orderId: '订单编号', lineId: '订单行',
  status: '状态', level: '规则等级', policyKey: '审批规则', requesterId: '申请人', reviewerId: '审批人',
  riskMitigationPlan: '风险应对措施', hitConditions: '命中条件', ruleFindings: '规则依据', beforeSnapshot: '变更前',
  afterDelta: '申请变更后', impactSummary: '影响摘要', changeType: '变更类型', hitChangeTypes: '命中变更类型',
  lineNumber: '行号', materialCode: '物料编号', fabricCode: '面料编号', netValue: '净额',
  deliveryDate: '交期', dueDate: '交期', price: '价格', lineQuantityPlanHash: '分行数量计划校验值',
  bearerType: '费用承担方', bearerRelationId: '承担方客户记录', bearerName: '费用承担方名称', sourceType: '来源类型', sourceId: '来源编号',
  chargeType: '收费类型', developmentWorkflowState: '开发工作流状态', developmentWorkflowVersion: '开发工作流版本',
  developmentExpenseReviewId: '开发费用核齐记录', expenseReviewId: '费用核齐记录', workflowVersion: '开发工作流版本',
  financeUserId: '财务接收人', caseId: '开发案编号', transferAmount: '内部供料总额', transferCurrency: '内部结算币种',
  settlementPrice: '结算单价', garmentOrderId: '服装订单', garmentOrderLineId: '服装订单行', fabricOrderId: '面料订单',
  fabricOrderLineId: '面料订单行', requestDepartmentId: '申请部门', supplyDepartmentId: '供料部门', customer: '客户',
  updatedAt: '更新时间', validUntil: '报价有效期', notes: '备注', problemDesc: '问题描述', reportedAt: '报告日期',
  reportedBy: '报告人', claimCase: '原售后案件', disposition: '售后处置', kind: '类型', returnDisposition: '退货处理方式',
  sourceOrderId: '原订单', sourceInvoiceId: '原发票', orderChangeReviewBasis: '申请时原订单及订单行基准',
  order: '订单', orderLines: '订单行', orderVersion: '订单版本', type: '业务类型', businessLine: '业务线',
  moqBasis: 'MOQ 计算依据', moqBasisVersion: 'MOQ 依据版本', moqSnapshot: 'MOQ 商品规格快照', content: '申请内容',
  account: '收款账户', paymentAccount: '收款账户', scope: '适用业务范围', action: '业务动作',
  sourceSnapshot: '准确来源冻结依据', entries: '逐票付款依据', originalDocument: '供应商原票', invoiceNumber: '应付登记号',
  vatNumber: '供应商原票号码', vatCode: '原票代码', contractNumbers: '已批准合同编号', invoiceAmount: '原票价税合计',
  requestedAmount: '本次逐票申请额', appliedAmountAtSubmission: '申请时已核销额', remainingAmountAtSubmission: '申请时未核销额',
};
const HIDDEN_KEYS = /(?:fingerprint|hash|signature|schemaVersion|^id$|Id$|^source$|previewVersion|reviewContentVersion)/i;

function scalar(value: unknown): string {
  if (value === null || value === undefined || value === '') return '未填写';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function flatten(value: unknown, path = '', key = ''): ApprovalReviewField[] {
  if (key === 'documentSnapshot' || HIDDEN_KEYS.test(key) || ['attachments', 'files', 'evidence', 'evidenceFiles'].includes(key)) return [];
  if (Array.isArray(value)) return value.flatMap((entry, index) => flatten(entry, path ? `${path} · 第 ${index + 1} 项` : `第 ${index + 1} 项`, key));
  if (value && typeof value === 'object') return Object.entries(value as Record<string, unknown>).flatMap(([childKey, child]) => {
    if (childKey === 'documentSnapshot' || HIDDEN_KEYS.test(childKey)) return [];
    const label = FIELD_LABELS[childKey] ?? childKey.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
    return flatten(child, path ? `${path} · ${label}` : label, childKey);
  });
  return path ? [{ key: path, label: path, value: scalar(value) }] : [];
}

function previewDigestFor(approval: ReviewApproval, fields: ApprovalReviewField[], reference: ApprovalReviewSourceReference | null): string {
  return sha256({ schemaVersion: 1, reviewContentVersion: approvalReviewContentVersion(approval as any),
    approvalId: approval.id, actionType: approval.actionType,
    targetType: approval.targetType, targetId: approval.targetId, fields, sourceReference: reference });
}

function titleFor(approval: ReviewApproval): string {
  const labels: Record<string, string> = {
    'finance:payment_request': '付款申请', 'order:change': '订单变更申请',
    'order:dr013-exception': '业务例外申请', 'order:moq-exemption': 'MOQ 豁免申请',
    'quotation:moq-exemption': '报价 MOQ 豁免申请', 'quotation:price-deviation': '报价偏差审批',
    'quotation:line_approve': '报价条目审批', 'quotation:total_approve': '报价总价审批',
    'order:internal_trade_price': '内部供料价格审批', 'aftersales:claim-disposition': '售后处置审批',
    'order:short-ship-exemption': '短装例外审批', 'development:fee': '开发收费审批',
    'order:confirmation_sign': '订单确认书签署', 'contract:sign': '销售合同签署',
  };
  const payload = object(approval.payload);
  const code = text(payload.requestNumber || payload.quotationNumber || payload.exceptionNumber);
  return `${labels[approval.actionType] ?? '业务审批'}${code ? ` · ${code}` : ''}`;
}

function attachmentEntries(value: unknown, out: ApprovalReviewAttachment[] = []): ApprovalReviewAttachment[] {
  if (Array.isArray(value)) {
    value.forEach(entry => attachmentEntries(entry, out));
    return out;
  }
  const row = object(value);
  if (Object.keys(row).length === 0) return out;
  const href = text(row.href || row.url || row.fileUrl);
  const fileName = text(row.fileName || row.filename || row.name);
  const id = text(row.fileId || row.attachmentId || row.id);
  // Only existing authenticated download routes are exposed. Arbitrary paths,
  // file-system names, and external URLs in legacy JSON never become links.
  const emailMatch = /^\/api\/v1\/email\/attachments\/([A-Za-z0-9_-]+)\/download$/.exec(href);
  const invoiceMatch = /^\/api\/v1\/finance\/([A-Za-z0-9_-]+)\/attachments\/([A-Za-z0-9_-]+)\/download$/.exec(href);
  if (fileName && ((emailMatch && (!id || id === emailMatch[1])) || (invoiceMatch && (!id || id === invoiceMatch[2])))) {
    const exactHref = emailMatch ? `/api/v1/email/attachments/${emailMatch[1]}/download`
      : `/api/v1/finance/${invoiceMatch![1]}/attachments/${invoiceMatch![2]}/download`;
    const attachmentId = emailMatch?.[1] ?? invoiceMatch?.[2] ?? '';
    if (attachmentId && !out.some(item => item.id === attachmentId)) out.push({
      id: attachmentId, fileName, href: exactHref, ...(present(row.mimeType) ? { mimeType: text(row.mimeType) } : {}),
    });
  }
  for (const [key, child] of Object.entries(row)) {
    if (['attachments', 'files', 'evidence', 'evidenceFiles', 'content', 'claimCase'].includes(key)) attachmentEntries(child, out);
  }
  return out;
}

function hasAttachmentReference(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasAttachmentReference);
  const row = object(value);
  if (!Object.keys(row).length) return false;
  if (['attachments', 'files', 'evidence', 'evidenceFiles'].some(key => {
    const child = row[key]; return Array.isArray(child) ? child.length > 0 : !!child;
  })) return true;
  return Object.values(row).some(child => child && typeof child === 'object' && hasAttachmentReference(child));
}

function sourceReference(approval: ReviewApproval, payload: Record<string, any>): ApprovalReviewSourceReference | null {
  const signSnapshot = getApprovalSignDocumentSnapshot(approval);
  if (signSnapshot?.kind === 'OrderConfirmation')
    return { kind: 'order_confirmation', id: signSnapshot.sourceRef, label: '订单确认书' };
  if (signSnapshot?.kind === 'Contract')
    return { kind: 'contract', id: signSnapshot.sourceRef, label: '合并销售合同' };
  if (approval.actionType === 'finance:payment_request' && approval.targetType === 'PaymentRequest' && approval.targetId)
    return { kind: 'payment_request', id: approval.targetId, label: '付款申请' };
  if (approval.actionType === 'order:change' && approval.targetType === 'OrderChangeRequest' && approval.targetId)
    return { kind: 'order', id: approval.targetId, label: '关联订单' };
  if (approval.actionType.startsWith('quotation:')) {
    const id = text(payload.quotationId || approval.targetId);
    if (id) return { kind: 'quotation', id, label: '关联报价' };
  }
  if (approval.actionType === 'aftersales:claim-disposition') {
    const id = text(object(object(payload.content).claimCase).id);
    if (id) return { kind: 'claim_case', id, label: '原售后案件' };
  }
  if (approval.actionType === 'development:fee' && approval.targetId)
    return { kind: 'billing_item', id: approval.targetId, label: '开发收费记录' };
  if (approval.actionType === 'order:dr013-exception' && approval.targetId)
    return { kind: 'exception', id: approval.targetId, label: '业务例外申请' };
  const value = object(payload.sourceDocument);
  const kind = text(value.type);
  const id = text(value.id);
  const allowed: Record<string, string> = {
    purchase_order: '采购订单', customer_order: '客户订单', expense: '费用记录', invoice: '发票',
  };
  return kind && id && allowed[kind] ? { kind, id, label: allowed[kind] } : null;
}

function missingFrozenBasis(approval: ReviewApproval): string[] {
  const payload = object(approval.payload);
  const missing: string[] = [];
  const need = (condition: boolean, label: string) => { if (!condition) missing.push(label); };
  switch (approval.actionType) {
    case 'finance:payment_request': {
      const cashRefund = object(payload.content);
      if (payload.schemaVersion === 1 && cashRefund.paymentRequest) {
        need(/^[a-f0-9]{64}$/.test(text(payload.contentFingerprint)), '退款冻结依据校验值');
        need(present(cashRefund.refund) && present(cashRefund.version) && present(cashRefund.paymentRequest), '退款对象、原始贷项版本与收款申请');
        need(present(object(cashRefund.refund).payeeSnapshot) && present(object(cashRefund.paymentRequest).totalAmount)
          && present(object(cashRefund.paymentRequest).currency), '退款收款方、金额和币种');
      } else {
        need(present(payload.requestNumber), '付款申请单号');
        need(Number.isFinite(Number(payload.totalAmount)) && Number(payload.totalAmount) > 0, '付款金额');
        need(present(payload.currency), '付款币种');
        need(present(payload.paymentCategory), '付款类别');
        need(present(payload.supplierId) || present(payload.supplierName) || present(payload.customerRelationId) || present(payload.customerName), '收款方');
      }
      break;
    }
    case 'order:change':
      need(approval.targetType === 'OrderChangeRequest' && present(approval.targetId), '订单变更申请关联');
      need(present(payload.requestNumber), '变更申请单号');
      need(present(payload.changeReason), '变更原因');
      need(Object.keys(object(payload.beforeSnapshot)).length > 0, '变更前冻结内容');
      need(Object.keys(object(payload.afterDelta)).length > 0, '拟变更内容');
      need(Array.isArray(payload.hitChangeTypes) && payload.hitChangeTypes.length > 0, '变更类型');
      break;
    case 'quotation:line_approve':
    case 'quotation:total_approve': {
      const snapshot = object(payload.quotationSnapshot);
      need(approval.targetType === (approval.actionType === 'quotation:line_approve' ? 'QuotationLine' : 'Quotation'), '报价审批目标类型');
      need(snapshot.schemaVersion === 2, '报价冻结版本');
      need(present(payload.quotationId) && snapshot.quotationId === payload.quotationId, '报价来源关联');
      need(/^[a-f0-9]{64}$/.test(text(payload.contentFingerprint)), '报价冻结依据校验值');
      need(present(snapshot.currency) && present(snapshot.totalAmount) && Array.isArray(snapshot.lines) && snapshot.lines.length > 0, '报价金额、币种和条目');
      if (approval.actionType === 'quotation:line_approve') need(snapshot.lines.filter((line: any) => line?.id === approval.targetId).length === 1, '本次审批条目');
      if (approval.actionType === 'quotation:total_approve') {
        const documentSnapshot = getApprovalSignDocumentSnapshot(approval);
        need(!!documentSnapshot && documentSnapshot.kind === 'Quotation'
          && documentSnapshot.sourceRef === approval.targetId && documentSnapshot.sourceIds.length === 1,
        '完整冻结报价单、原生条款、卖方档案和模板依据');
      }
      break;
    }
    case 'quotation:price-deviation':
      const priceSnapshot = object(payload.quotationSnapshot);
      need(approval.targetType === 'Quotation' && payload.quotationId === approval.targetId, '报价来源关联');
      need(priceSnapshot.schemaVersion === 2 && priceSnapshot.quotationId === approval.targetId
        && Array.isArray(priceSnapshot.lines) && priceSnapshot.lines.length > 0,
      '报价完整冻结版本');
      need(/^[a-f0-9]{64}$/.test(text(payload.contentFingerprint))
        && text(payload.contentFingerprint) === sha256({ actionType: approval.actionType, targetType: approval.targetType,
          targetId: approval.targetId, quotationSnapshot: priceSnapshot }), '报价冻结依据校验值');
      need(Array.isArray(payload.hitConditions) && payload.hitConditions.length > 0, '触发的价格规则');
      need(present(payload.level) && present(payload.requestedAt) && payload.policyKey === 'price_approval', '规则等级、申请时间和规则类型');
      if (payload.source === 'quotation-dual-track')
        need(present(payload.trackAMedianUsd) && present(payload.trackBFinalUsd) && present(payload.deviationPercent), '双轨单价和偏差结果');
      need(present(payload.ruleFindings), '价格偏差规则依据');
      break;
    case 'order:moq-exemption':
    case 'quotation:moq-exemption':
      need(payload.moqBasisVersion === 1 && present(payload.moqBasis), 'MOQ 冻结依据');
      need(/^[a-f0-9]{64}$/.test(text(payload.moqBasisHash)) && payload.contentFingerprint === payload.moqBasisHash, 'MOQ 冻结依据校验值');
      need(present(payload.reason), '豁免原因');
      break;
    case 'order:dr013-exception':
      need(approval.targetType === 'Dr013ExceptionRequest' && present(approval.targetId), '例外申请关联');
      need(present(payload.exceptionNumber) && present(payload.exceptionCategory), '例外单号和分类');
      need(Array.isArray(payload.bypassedApprovalIds)
        && payload.bypassedApprovalIds.every((id: unknown) => typeof id === 'string' && !!id.trim())
        && new Set(payload.bypassedApprovalIds).size === payload.bypassedApprovalIds.length, '被绕过的历史审批');
      need(typeof payload.exceptionReason === 'string' && payload.exceptionReason.trim().length >= 30
        && present(payload.riskMitigationPlan), '例外理由和风险应对');
      need(present(object(payload.scope).targetType) && present(object(payload.scope).targetId) && present(object(payload.scope).action)
        && Number.isSafeInteger(object(payload.scope).maxUses) && object(payload.scope).maxUses >= 1
        && (object(payload.scope).validUntil === null || (typeof object(payload.scope).validUntil === 'string'
          && Number.isFinite(Date.parse(object(payload.scope).validUntil))))
        && present(payload.responsibleOwnerId), '适用业务范围和责任人');
      break;
    case 'aftersales:claim-disposition': {
      const content = object(payload.content);
      need(approval.targetType === 'ClaimDisposition' && present(approval.targetId), '售后处置关联');
      need(payload.schemaVersion === 1 && /^[a-f0-9]{64}$/.test(text(payload.contentFingerprint)), '售后冻结依据校验值');
      need(present(content.disposition) && present(content.claimCase), '处置内容与原售后案件');
      break;
    }
    case 'order:internal_trade_price': {
      const content = object(payload.content);
      need(approval.targetType === 'OrderInternalTransfer' && present(approval.targetId), '内部供料单关联');
      need(payload.schemaVersion === 2 && /^[a-f0-9]{64}$/.test(text(payload.contentFingerprint)), '内部价格冻结依据校验值');
      need(['garmentOrderId', 'fabricOrderId', 'garmentOrderLineId', 'fabricOrderLineId', 'materialCode', 'unit', 'dueDate', 'transferCurrency']
        .every(key => present(content[key])) && ['quantity', 'settlementPrice', 'transferAmount'].every(key => Number.isFinite(Number(content[key])) && Number(content[key]) > 0), '内部价格、数量、物料和交期');
      break;
    }
    case 'order:short-ship-exemption':
      need(approval.targetType === 'OrderLine' && present(approval.targetId) && present(payload.shipmentId) && present(payload.orderId), '短装订单行和出运关联');
      need(present(payload.itemNo) && ['contractQty', 'shippedQty', 'allowedMin', 'shortage']
        .every(key => present(payload[key]) && Number.isFinite(Number(payload[key])) && Number(payload[key]) >= 0), '订单行编号、合同量、已出运量和短装计算依据');
      need(present(payload.tolerancePct) && Number.isFinite(Number(payload.tolerancePct)) && Number(payload.tolerancePct) >= 0
        && present(payload.toleranceSource) && payload.policyKey === 'short_ship_exemption', '客户或内部公差依据');
      break;
    case 'development:fee':
      need(approval.targetType === 'BillingItem' && approval.targetId === payload.billingItemId, '开发收费记录关联');
      need(payload.schemaVersion === 1 && payload.kind === 'development_fee', '开发费用审批类型');
      need(present(payload.itemNo) && present(payload.caseId) && present(payload.expenseReviewId), '开发案、收费项和费用核齐依据');
      need(/^[a-f0-9]{64}$/.test(text(payload.expenseReviewFingerprint)), '费用核齐冻结校验值');
      need(/^[a-f0-9]{64}$/.test(text(payload.contentFingerprint)), '开发收费提案校验值');
      need(Number.isSafeInteger(payload.workflowVersion) && payload.workflowVersion > 0, '费用工作流版本');
      need(Number.isFinite(Number(payload.amount)) && Number(payload.amount) >= 0
        && Number.isFinite(Number(payload.waivedAmount)) && Number(payload.waivedAmount) >= 0, '拟收费金额和减免金额');
      need(present(payload.currency) && payload.bearerType === 'customer' && present(payload.bearerRelationId) && present(payload.bearerName), '币种与客户承担方');
      need(present(payload.financeUserId) && present(payload.reason), '财务接收人和收费说明');
      break;
    case 'order:confirmation_sign':
    case 'contract:sign': {
      const snapshot = getApprovalSignDocumentSnapshot(approval);
      need(!!snapshot, '完整冻结文档、原始精确金额及模板依据');
      if (snapshot?.kind === 'OrderConfirmation') {
        need(Array.isArray(snapshot.data.lines) && snapshot.data.lines.length > 0, '订单确认书完整订单明细');
        need(present(snapshot.exporterProfile.nameEn) && present(snapshot.exporterProfile.addressEn), '签署卖方名称和地址');
      } else if (snapshot?.kind === 'Contract') {
        need(snapshot.sourceIds.length >= 2 && Array.isArray(snapshot.data.orders) && snapshot.data.orders.length >= 2,
          '销售合同完整关联订单');
        need(Array.isArray(snapshot.data.lines) && snapshot.data.lines.length > 0, '销售合同完整订单明细');
        need(!!snapshot.clauses?.entries?.length && snapshot.clauses.entries.every(clause => present(clause.title) && present(clause.body)),
          '销售合同固定条款全文');
        need(present(snapshot.exporterProfile.nameEn) && present(snapshot.exporterProfile.addressEn), '签署卖方名称和地址');
      }
      break;
    }
    default:
      // Unknown actions and historical internal paths retain their existing domain contract.
      return [];
  }
  return missing;
}

function statusFields(source: Record<string, any> | null, labels: Record<string, string>): ApprovalReviewField[] {
  if (!source) return [];
  return Object.entries(labels).filter(([key]) => source[key] !== undefined).map(([key, label]) => ({ key, label, value: scalar(source[key]) }));
}

export function buildApprovalReviewDetail(approval: ReviewApproval, options: {
  currentSource?: { status: ApprovalReviewDetail['currentSource']['status']; label: string; fields: ApprovalReviewField[] };
  decisionHistory?: ApprovalReviewHistoryEntry[];
  decisionHistoryStatus?: ApprovalReviewDetail['decisionHistoryStatus'];
} = {}): ApprovalReviewDetail {
  const payload = object(approval.payload);
  const attachments = attachmentEntries(payload);
  const documentSnapshot = getApprovalSignDocumentSnapshot(approval);
  const fields = documentSnapshot ? approvalSignDocumentPreviewFields(documentSnapshot) : flatten(payload);
  if (!fields.length) fields.push({ key: 'basis', label: '申请依据', value: '未提供可核对的冻结内容' });
  const missing = missingFrozenBasis(approval);
  const requestVersion = approvalReviewContentVersion(approval as any);
  return {
    schemaVersion: 1,
    approvalId: approval.id,
    actionType: approval.actionType,
    targetType: approval.targetType,
    targetId: approval.targetId,
    title: titleFor(approval),
    reviewContentVersion: requestVersion,
    frozen: {
      label: '本次申请冻结内容', fields, attachments,
      attachmentStatus: attachments.length ? 'available' : hasAttachmentReference(payload) ? 'unavailable' : 'not_applicable',
      attachmentStatusLabel: attachments.length ? '已提供可授权查看的附件' : hasAttachmentReference(payload) ? '申请包含附件，但附件原件入口尚未授权核验' : '本次申请未附带附件',
      sourceReference: sourceReference(approval, payload),
      previewDigest: previewDigestFor(approval, fields, sourceReference(approval, payload)),
    },
    currentSource: options.currentSource ?? { status: 'unavailable', label: '当前业务状态暂未读取', fields: [] },
    decisionHistory: options.decisionHistory ?? [],
    decisionHistoryStatus: options.decisionHistoryStatus ?? 'available',
    approvalBlockers: missing,
    canApprove: missing.length === 0,
  };
}

export function approvalReviewPreviewDigest(approval: ReviewApproval): string {
  return buildApprovalReviewDetail(approval).frozen.previewDigest;
}

function currentSourceQuery(prisma: any, approval: ReviewApproval): Promise<any> | null {
  const payload = object(approval.payload);
  switch (approval.actionType) {
    case 'finance:payment_request':
      return approval.targetType === 'PaymentRequest' && approval.targetId ? prisma.paymentRequest.findUnique({ where: { id: approval.targetId },
        select: { id: true, requestNumber: true, payeeType: true, supplierName: true, customerName: true, totalAmount: true, currency: true,
          paymentCategory: true, requestDate: true, expectedPaymentDate: true, status: true, remark: true, attachments: true } }) : null;
    case 'order:moq-exemption':
      return approval.targetType === 'Order' && approval.targetId ? prisma.order.findUnique({ where: { id: approval.targetId },
        include: { lines: { orderBy: { lineNumber: 'asc' } } } }) : null;
    case 'order:short-ship-exemption':
      return approval.targetType === 'OrderLine' && approval.targetId ? prisma.orderLine.findUnique({ where: { id: approval.targetId },
        select: { id: true, itemNo: true, orderId: true, quantity: true, shipmentQuantity: true, unit: true,
          tolerancePercent: true, toleranceSource: true } }) : null;
    case 'order:internal_trade_price':
      return approval.targetType === 'OrderInternalTransfer' && approval.targetId ? prisma.orderInternalTransfer.findUnique({ where: { id: approval.targetId },
        select: { id: true, orderId: true, memo: true, transferAmount: true, transferCurrency: true } }) : null;
    case 'order:change':
      return approval.targetType === 'OrderChangeRequest' ? prisma.orderChangeRequest.findFirst({ where: { approvalRequestId: approval.id },
        select: { id: true, requestNumber: true, orderId: true, status: true, beforeSnapshot: true, afterDelta: true,
          changeTypes: true, changeReason: true, finalContentFingerprint: true, requesterId: true, notes: true, deletedAt: true } }) : null;
    case 'quotation:line_approve':
    case 'quotation:total_approve':
    case 'quotation:price-deviation':
    case 'quotation:moq-exemption': {
      const quotationId = text(payload.quotationId || approval.targetId);
      return quotationId ? prisma.quotation.findUnique({ where: { id: quotationId }, include: { lines: { orderBy: { lineNumber: 'asc' } } } }) : null;
    }
    case 'order:dr013-exception':
      return approval.targetType === 'Dr013ExceptionRequest' && approval.targetId ? prisma.dr013ExceptionRequest.findUnique({ where: { id: approval.targetId },
        select: { id: true, exceptionNumber: true, exceptionCategory: true, status: true, exceptionReason: true, riskMitigationPlan: true,
          subCategory: true, requesterId: true, reviewerId: true, approvalRequestId: true, deletedAt: true, attachments: true,
          bypassedApprovalIds: true, updatedAt: true } }) : null;
    case 'aftersales:claim-disposition':
      return approval.targetType === 'ClaimDisposition' && approval.targetId ? prisma.claimDisposition.findUnique({ where: { id: approval.targetId },
        select: { id: true, claimCaseId: true, kind: true, amount: true, currency: true, quantity: true, unit: true, returnDisposition: true,
          status: true, notes: true } }) : null;
    case 'development:fee':
      return approval.targetType === 'BillingItem' && approval.targetId ? prisma.billingItem.findUnique({ where: { id: approval.targetId },
        select: { id: true, itemNo: true, sourceType: true, sourceId: true, chargeType: true, bearerType: true, bearerRelationId: true,
          bearerName: true, amount: true, waivedAmount: true, currency: true, status: true, developmentWorkflowState: true,
          developmentWorkflowVersion: true, developmentExpenseReviewId: true, developmentApprovalId: true, offsetAmount: true } }) : null;
    case 'order:confirmation_sign': {
      const snapshot = getApprovalSignDocumentSnapshot(approval);
      return snapshot?.kind === 'OrderConfirmation'
        ? readCurrentApprovalSignDocumentSnapshot(prisma, approval) : null;
    }
    case 'contract:sign': {
      const snapshot = getApprovalSignDocumentSnapshot(approval);
      return snapshot?.kind === 'Contract'
        ? readCurrentApprovalSignDocumentSnapshot(prisma, approval) : null;
    }
    default:
      return null;
  }
}

const LIVE_SOURCE_REQUIRED = new Set(['finance:payment_request', 'order:change', 'quotation:line_approve', 'quotation:total_approve',
  'quotation:price-deviation', 'quotation:moq-exemption', 'order:moq-exemption', 'order:dr013-exception',
  'order:short-ship-exemption', 'order:internal_trade_price', 'aftersales:claim-disposition', 'development:fee',
  'order:confirmation_sign', 'contract:sign']);

async function validateLiveDecisionBasis(prisma: any, approval: ReviewApproval, source: Record<string, any> | null) {
  if (!LIVE_SOURCE_REQUIRED.has(approval.actionType) || approval.status !== 'pending') return [] as string[];
  if (!source) return ['原业务当前依据不可读取'];
  const payload = object(approval.payload);
  try {
    switch (approval.actionType) {
      case 'order:confirmation_sign':
      case 'contract:sign': {
        await assertCurrentApprovalSignDocumentSnapshot(prisma, approval);
        break;
      }
      case 'finance:payment_request':
        if (payload.schemaVersion === 1 && object(payload.content).paymentRequest) break; // Native refund gate rechecks refund and receivable facts in its lock order.
        if (!approval.targetId) return ['付款申请关联记录缺失'];
        const current = await prisma.paymentRequest.findUnique({ where: { id: approval.targetId }, select: {
          id: true, requestNumber: true, totalAmount: true, currency: true, paymentCategory: true, status: true,
          approvalRequestId: true, supplierId: true, supplierName: true, customerRelationId: true, customerName: true,
        } });
        if (!current || current.status !== 'Pending' || current.approvalRequestId !== approval.id
          || current.requestNumber !== payload.requestNumber || String(current.totalAmount) !== String(payload.totalAmount)
          || current.currency !== payload.currency || current.paymentCategory !== payload.paymentCategory
          || (present(payload.supplierId) && current.supplierId !== payload.supplierId)
          || (present(payload.supplierName) && current.supplierName !== payload.supplierName)
          || (present(payload.customerRelationId) && current.customerRelationId !== payload.customerRelationId)
          || (present(payload.customerName) && current.customerName !== payload.customerName)) return ['当前付款对象、金额、币种或待审批状态与冻结申请不一致'];
        break;
      case 'quotation:line_approve':
      case 'quotation:total_approve': {
        const state = quotationApprovalSourceState(approval, source);
        if (state !== 'current') return ['当前报价内容与申请时冻结版本不一致'];
        if (approval.actionType === 'quotation:total_approve') {
          const frozen = getApprovalSignDocumentSnapshot(approval);
          const current = source.documentSnapshot ?? await buildQuotationApprovalSignDocumentSnapshot(prisma, source);
          if (!frozen || !current || current.contentFingerprint !== frozen.contentFingerprint)
            return ['报价单正文、条款、卖方档案或模板与签署冻结版本不一致'];
        }
        break;
      }
      case 'quotation:price-deviation': {
        const frozen = object(payload.quotationSnapshot);
        const current = buildQuotationSnapshot(source);
        const expectedFingerprint = sha256({ actionType: approval.actionType, targetType: approval.targetType,
          targetId: approval.targetId, quotationSnapshot: frozen });
        const sameDecimal = (left: unknown, right: unknown) => {
          if (left == null || right == null || left === '') return (left == null || left === '') && (right == null || right === '');
          try { return new Prisma.Decimal(String(left)).equals(new Prisma.Decimal(String(right))); } catch { return false; }
        };
        if (approval.targetType !== 'Quotation' || approval.targetId !== payload.quotationId
          || source.id !== approval.targetId || source.deletedAt != null || source.priceApprovalId !== approval.id
          || payload.policyKey !== 'price_approval' || !/^[a-f0-9]{64}$/.test(text(payload.contentFingerprint))
          || payload.contentFingerprint !== expectedFingerprint
          || canonicalQuotationJson(current) !== canonicalQuotationJson(frozen)
          || !sameDecimal(source.trackAMedianUsd, payload.trackAMedianUsd)
          || (source.trackAUnit ?? null) !== (payload.trackAUnit ?? null)
          || !sameDecimal(source.trackBFinalUsd, payload.trackBFinalUsd)
          || !sameDecimal(source.priceDeviationPercent, payload.deviationPercent)
          || source.priceDeviationLevel !== payload.level)
          return ['当前报价版本或双轨价格偏差依据与冻结申请不一致'];
        break;
      }
      case 'order:change': {
        const order = await prisma.order.findUnique({ where: { id: source.orderId } });
        const orderLines = await prisma.orderLine.findMany({ where: { orderId: source.orderId }, orderBy: { id: 'asc' } });
        const basis = captureOrderChangeReviewBasis(order, orderLines);
        const result = buildOrderChangeFinalVersion({ changeRequest: source, order, orderLines,
          approval: { ...approval, status: 'pending' }, requireApproved: false });
        if (source.status !== 'Pending' || !result.sourceMatchesFrozen
          || canonicalCustomerConfirmationJson(basis) !== canonicalCustomerConfirmationJson(payload.orderChangeReviewBasis))
          return ['当前订单或订单行已变化，不能按旧申请批准'];
        break;
      }
      case 'order:short-ship-exemption':
        if (source.id !== approval.targetId || source.orderId !== payload.orderId || source.itemNo !== payload.itemNo
          || source.unit !== payload.unit) return ['短装审批关联的订单行或单位已变化'];
        {
          const order = await prisma.order.findUnique({ where: { id: source.orderId }, select: { customerRelationId: true } });
          const shipment = await prisma.shipment.findUnique({ where: { id: payload.shipmentId }, select: { id: true, status: true, deletedAt: true, shipmentNumber: true } });
          const allocation = await prisma.shipmentOrderAllocation.findFirst({ where: {
            shipmentId: payload.shipmentId, orderLineId: source.id, orderId: source.orderId, status: { not: 'Cancelled' },
          }, select: { id: true } });
          if (!shipment || shipment.deletedAt != null || isShipmentCancelled(shipment.status) || !allocation)
            return ['关联运单或订单行分配已撤销，不能按旧短装申请批准'];
          const standards = await loadToleranceStandards(prisma, { customerRelationId: order?.customerRelationId ?? null });
          const resolved = resolveLineTolerance(source as any, standards, { measure: Number(source.quantity) });
          const gate = gateToleranceOf(resolved);
          const remaining = await loadLineRemainingPlan(prisma, source.id, payload.shipmentId, false);
          const result = decideShortShipment({ contractQty: Number(source.quantity), shippedQty: Number(source.shipmentQuantity ?? 0),
            tolerancePct: gate.pct, hasRemainingUnshipped: remaining.hasRemaining });
          const sameNumber = (left: unknown, right: unknown) => {
            try { return new Prisma.Decimal(String(left)).equals(new Prisma.Decimal(String(right))); } catch { return false; }
          };
          if (result.kind !== 'blocked' || remaining.hasRemaining
            || !sameNumber(source.quantity, payload.contractQty) || !sameNumber(source.shipmentQuantity ?? 0, payload.shippedQty)
            || !sameNumber(gate.pct, payload.tolerancePct) || gate.source !== payload.toleranceSource
            || !sameNumber(result.allowedMin, payload.allowedMin) || !sameNumber(result.shortage, payload.shortage))
            return ['订单行、运单分配或当前公差计算与短装冻结依据不一致'];
          source.shipmentNumber = shipment.shipmentNumber;
          source.shipmentStatus = shipment.status;
          source.currentTolerancePct = gate.pct;
          source.currentToleranceSource = gate.source;
        }
        break;
      case 'order:dr013-exception': {
        const scope = object(payload.scope);
        const currentScope = object(object(source.attachments).scope);
        if (source.id !== approval.targetId || source.deletedAt != null || source.status !== 'Pending'
          || source.approvalRequestId !== approval.id || source.requesterId !== approval.requesterId
          || source.exceptionNumber !== payload.exceptionNumber || source.exceptionCategory !== payload.exceptionCategory
          || (source.subCategory ?? null) !== (payload.subCategory ?? null)
          || source.exceptionReason !== payload.exceptionReason || source.riskMitigationPlan !== payload.riskMitigationPlan
          || canonicalCustomerConfirmationJson(source.bypassedApprovalIds ?? []) !== canonicalCustomerConfirmationJson(payload.bypassedApprovalIds ?? [])
          || currentScope.targetType !== scope.targetType || currentScope.targetId !== scope.targetId || currentScope.action !== scope.action
          || (currentScope.validUntil ?? null) !== (scope.validUntil ?? null) || currentScope.maxUses !== scope.maxUses
          || currentScope.responsibleOwnerId !== payload.responsibleOwnerId || currentScope.usedCount !== 0
          || !Array.isArray(currentScope.consumptions) || currentScope.consumptions.length !== 0)
          return ['例外申请不再待审批，关联编号或批准适用范围与冻结申请不一致'];
        if (Array.isArray(payload.bypassedApprovalIds) && payload.bypassedApprovalIds.length) {
          const bypassed = await prisma.approvalRequest.findMany({ where: { id: { in: payload.bypassedApprovalIds } },
            select: { id: true, status: true, bypassedApprovalId: true } });
          if (bypassed.length !== payload.bypassedApprovalIds.length
            || bypassed.some((row: any) => row.status !== 'rejected' || row.bypassedApprovalId !== approval.id))
            return ['被绕过的历史审批与本例外关联已变化'];
        }
        break;
      }
        break;
      case 'order:internal_trade_price': {
        const { decodeInternalTransferPayload, internalTransferFingerprint } = await import('../internalTrade/internalTransferService');
        const current = decodeInternalTransferPayload(source.memo);
        const content = object(payload.content);
        if (!current || current.status !== 'PendingConfirm' || current.masterId !== source.id
          || current.settlementApprovalId !== approval.id || current.contentFingerprint !== payload.contentFingerprint
          || internalTransferFingerprint(content) !== payload.contentFingerprint
          || internalTransferFingerprint(current.priceContent ?? current) !== payload.contentFingerprint)
          return ['内部供料原单或价格已变化'];
        break;
      }
      case 'order:moq-exemption':
      case 'quotation:moq-exemption':
        await assertCurrentMoqApproval(prisma, approval);
        break;
      case 'aftersales:claim-disposition': {
        const disposition = await prisma.claimDisposition.findUnique({ where: { id: approval.targetId } });
        const claimCase = disposition ? await prisma.claimCase.findUnique({ where: { id: disposition.claimCaseId } }) : null;
        if (!disposition || !claimCase || disposition.status !== 'Draft') return ['售后处置或原案件已变化，不能按旧申请批准'];
        assertClaimSnapshot(approval, disposition, claimCase);
        break;
      }
      case 'development:fee':
        if (source.id !== payload.billingItemId || source.status === 'cancelled'
          || source.developmentWorkflowVersion !== payload.workflowVersion
          || source.developmentExpenseReviewId !== payload.expenseReviewId
          || String(source.amount) !== String(payload.amount) || String(source.waivedAmount) !== String(payload.waivedAmount)
          || source.currency !== payload.currency || source.bearerType !== 'customer'
          || source.bearerRelationId !== payload.bearerRelationId || source.bearerName !== payload.bearerName)
          return ['开发收费当前记录与本次冻结提案不一致'];
        if (source.developmentApprovalId !== approval.id || source.developmentWorkflowState !== 'approval_pending'
          || !/^([a-f0-9]{64})$/.test(text(payload.expenseReviewFingerprint))
          || !/^([a-f0-9]{64})$/.test(text(payload.contentFingerprint))
          || !present(payload.financeUserId) || !present(payload.reason))
          return ['本轮费用核齐、工作流或提交理由未能核验'];
        {
          const { assertDevelopmentExpenseReviewCurrentInTx } = await import('../development/developmentClosureService');
          const expenseReview = await assertDevelopmentExpenseReviewCurrentInTx(prisma, text(payload.caseId), text(payload.expenseReviewId));
          if (expenseReview.fingerprint !== payload.expenseReviewFingerprint)
            return ['当前费用核齐快照已变化，不能按旧开发收费申请批准'];
        }
        break;
    }
  } catch (error: any) {
    const message = typeof error?.message === 'string' ? error.message : '';
    return [message.includes('MOQ') ? '当前 MOQ 规则与冻结申请不一致' :
      message.includes('订单') ? '当前订单或订单行与冻结申请不一致' :
      message.includes('报价') ? '当前报价与冻结申请不一致' :
      message.includes('付款') ? '当前付款申请与冻结内容不一致' : '原业务当前依据未通过校验'];
  }
  return [] as string[];
}

const HISTORY_ACTIONS = new Set(['approve_business_request', 'reject_business_request', 'boss_final_bypass', 'delegate_approval',
  'quotation_approval_amended', 'quotation_approval_superseded', 'approval_sync_completed', 'approval_sync_failed',
  'order_change_approval_synced', 'agent_approval_approved', 'agent_approval_rejected', 'approval_request_cancelled',
  'approval_cancelled', 'cancel_approval']);

export async function readApprovalReviewDetail(prisma: PrismaClient, approval: ReviewApproval, options: {
  /** Caller must check the original target's read scope before returning its live projection. */
  canReadCurrentSource?: boolean;
  /** Caller must check the native file service's permission before exposing download URLs. */
  canReadAttachments?: boolean;
  actor?: TokenPayload | null;
} = {}): Promise<ApprovalReviewDetail> {
  let source: Record<string, any> | null = null;
  let frozenSupplementFields: ApprovalReviewField[] = [];
  let developmentReviewVerified = approval.actionType !== 'development:fee';
  let currentSource: ApprovalReviewDetail['currentSource'] = options.canReadCurrentSource !== true
    ? { status: 'unavailable', label: options.canReadCurrentSource === false ? '当前账号没有原业务读取权限' : '原业务读取权限尚未核验', fields: [] }
    : { status: 'not_applicable', label: '此审批类型没有可读取的当前业务来源', fields: [] };
  const query = options.canReadCurrentSource === true ? currentSourceQuery(prisma, approval) : null;
  if (query) {
    try {
      source = await query;
      if (source && approval.actionType === 'aftersales:claim-disposition' && source.claimCaseId) {
        const claimCase = await (prisma as any).claimCase.findUnique({ where: { id: source.claimCaseId }, select: {
          id: true, caseNumber: true, customerName: true, sourceOrderId: true, sourceInvoiceId: true,
          status: true, category: true, problemDesc: true, reportedAt: true, reportedBy: true,
        } });
        source = { ...source, claimCase };
      }
      if (source && approval.actionType === 'order:dr013-exception') {
        const currentScope = object(object(source.attachments).scope);
        source = { ...source, currentScope, responsibleOwnerId: currentScope.responsibleOwnerId };
      }
      if (source && approval.actionType === 'order:short-ship-exemption') {
        const payload = object(approval.payload);
        const shipment = await (prisma as any).shipment.findUnique({ where: { id: payload.shipmentId },
          select: { id: true, shipmentNumber: true, status: true, deletedAt: true } });
        source = { ...source, shipmentNumber: shipment?.shipmentNumber ?? null, shipmentStatus: shipment?.status ?? null };
      }
      if (source && approval.actionType === 'order:change' && source.orderId) {
        const order = await (prisma as any).order.findUnique({ where: { id: source.orderId } });
        const orderLines = await (prisma as any).orderLine.findMany({ where: { orderId: source.orderId }, orderBy: { id: 'asc' } });
        const orderBasis = captureOrderChangeReviewBasis(order, orderLines);
        source = { ...source, orderBasis, _order: order, _orderLines: orderLines,
          orderBasisMatchesFrozen: canonicalCustomerConfirmationJson(orderBasis)
            === canonicalCustomerConfirmationJson(object(approval.payload).orderChangeReviewBasis) };
      }
      if (source && approval.actionType === 'order:internal_trade_price') {
        const { decodeInternalTransferPayload } = await import('../internalTrade/internalTransferService');
        source = { ...source, payload: decodeInternalTransferPayload(source.memo) };
      }
      if (source && approval.actionType === 'development:fee') {
        const payload = object(approval.payload);
        try {
          const { assertDevelopmentExpenseReviewCurrentInTx } = await import('../development/developmentClosureService');
          const expenseReview = await assertDevelopmentExpenseReviewCurrentInTx(prisma as any, text(payload.caseId), text(payload.expenseReviewId));
          if (expenseReview.fingerprint !== payload.expenseReviewFingerprint) throw new Error('开发费用核齐冻结版本不一致');
          developmentReviewVerified = true;
          frozenSupplementFields = flatten(expenseReview.snapshot, '费用核齐冻结快照');
          source = { ...source, expenseReviewId: expenseReview.id, expenseReviewFingerprint: expenseReview.fingerprint,
            expenseReviewSnapshot: expenseReview.snapshot, expenseReviewNote: expenseReview.note, expenseReviewStatus: 'current' };
        } catch {
          source = { ...source, expenseReviewStatus: 'unavailable' };
        }
      }
      if (source && (approval.actionType === 'order:confirmation_sign' || approval.actionType === 'contract:sign')) {
        source = { documentSnapshot: source };
      }
      if (source && approval.actionType === 'quotation:total_approve') {
        const documentSnapshot = await buildQuotationApprovalSignDocumentSnapshot(prisma, source);
        source = { ...source, documentSnapshot };
      }
      const sourceFields = source ? currentSourceFields(approval, source) : [];
      currentSource = source ? { status: 'available', label: '原业务当前状态', fields: sourceFields }
        : { status: 'missing', label: '关联原业务记录不存在', fields: [] };
    } catch {
      currentSource = { status: 'unavailable', label: '当前业务状态读取失败，不能用冻结快照代替', fields: [] };
    }
  }
  let decisionHistory: ApprovalReviewHistoryEntry[] = [];
  let decisionHistoryStatus: ApprovalReviewDetail['decisionHistoryStatus'] = 'unavailable';
  try {
    const audits = await (prisma as any).auditLog.findMany({
      where: { OR: [{ targetType: 'ApprovalRequest', targetId: approval.id }, { detail: { path: ['approvalId'], equals: approval.id } }] },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], include: { actor: { select: { displayName: true } } },
    });
    decisionHistory = (audits ?? []).filter((audit: any) => HISTORY_ACTIONS.has(audit.action)
      || audit.action === 'reject' || audit.action === 'approve').map((audit: any) => {
      const detail = object(audit.detail);
      const fact = object(detail.approvalDecisionFact);
      const decisionNote = text(detail.decisionNote);
      return {
        id: String(audit.id), action: String(audit.action), actorId: String(audit.actorId),
        actorName: text(audit.actor?.displayName) || null,
        occurredAt: audit.createdAt instanceof Date ? audit.createdAt.toISOString() : String(audit.createdAt ?? ''),
        ...(decisionNote ? { decisionNote } : {}),
        ...(present(fact.status || detail.status || detail.decision) ? { status: text(fact.status || detail.status || detail.decision) } : {}),
      };
    });
    decisionHistoryStatus = 'available';
  } catch { /* History outage does not invent records; caller can display the precise empty/error state. */ }
  const detail = buildApprovalReviewDetail(approval, { currentSource, decisionHistory, decisionHistoryStatus });
  if (frozenSupplementFields.length) {
    detail.frozen.fields.push(...frozenSupplementFields);
    detail.frozen.previewDigest = previewDigestFor(approval, detail.frozen.fields, detail.frozen.sourceReference);
  }
  if (LIVE_SOURCE_REQUIRED.has(approval.actionType) && approval.status === 'pending') {
    const liveBlockers = options.canReadCurrentSource === true && source
      ? [...await validateLiveDecisionBasis(prisma, approval, source), ...(!developmentReviewVerified ? ['开发费用核齐冻结快照缺失或已失效'] : [])]
      : ['原业务读取权限或当前依据未通过核验'];
    if (options.canReadCurrentSource === true && source && approval.actionType === 'finance:payment_request') {
      try { await assertPaymentRequestPayableApproval(prisma, approval, options.actor); }
      catch (error) { liveBlockers.push(error instanceof Error ? error.message : '准确应付当前依据未通过核验'); }
    }
    detail.approvalBlockers = [...new Set([...detail.approvalBlockers, ...liveBlockers])];
    detail.canApprove = detail.approvalBlockers.length === 0;
  }
  if (options.canReadAttachments !== true) {
    if (detail.frozen.attachments.length || hasAttachmentReference(approval.payload)) {
      detail.frozen.attachments = [];
      detail.frozen.attachmentStatus = 'unavailable';
      detail.frozen.attachmentStatusLabel = options.canReadAttachments === false
        ? '附件权限未通过，无法查看原件' : '附件权限尚未核验，无法查看原件';
    }
  }
  return detail;
}

function currentSourceFields(approval: ReviewApproval, source: Record<string, any>): ApprovalReviewField[] {
  if (approval.actionType === 'quotation:total_approve' && source.documentSnapshot) {
    return approvalSignDocumentPreviewFields(source.documentSnapshot).map(field => ({ ...field, label: `当前 · ${field.label}` }));
  }
  if (approval.actionType === 'order:confirmation_sign' || approval.actionType === 'contract:sign') {
    const snapshot = object(source.documentSnapshot) as any;
    if (snapshot.schemaVersion === 1 && snapshot.data && Array.isArray(snapshot.sourceIds)) {
      return approvalSignDocumentPreviewFields(snapshot).map(field => ({ ...field, label: `当前 · ${field.label}` }));
    }
  }
  const labelsByAction: Record<string, Record<string, string>> = {
    'finance:payment_request': { requestNumber: '申请单号', payeeType: '收款对象类型', supplierName: '供应商', customerName: '客户', totalAmount: '当前金额',
      currency: '当前币种', paymentCategory: '付款类别', requestDate: '申请日期', expectedPaymentDate: '预计付款日', status: '当前状态', remark: '当前用途说明' },
    'order:change': { requestNumber: '变更申请单号', orderId: '订单号', status: '变更状态', beforeSnapshot: '当前记录中的变更前快照',
      afterDelta: '当前记录中的拟变更内容', changeTypes: '变更类型', changeReason: '变更原因' },
    'order:short-ship-exemption': { itemNo: '订单行号', orderId: '订单号', shipmentNumber: '关联运单', shipmentStatus: '运单状态',
      quantity: '当前合同量', shipmentQuantity: '当前已分配出运量', unit: '单位', tolerancePercent: '订单行已录公差',
      toleranceSource: '订单行公差来源', currentTolerancePct: '当前规则公差', currentToleranceSource: '当前规则来源' },
    'order:internal_trade_price': { transferAmount: '当前供料金额', transferCurrency: '币种', orderId: '服装订单' },
    'order:dr013-exception': { exceptionNumber: '例外单号', exceptionCategory: '例外分类', subCategory: '例外子类', status: '当前状态',
      exceptionReason: '例外理由', riskMitigationPlan: '风险应对措施', responsibleOwnerId: '跟进责任人', currentScope: '当前适用范围',
      bypassedApprovalIds: '被绕过的历史审批' },
    'aftersales:claim-disposition': { claimCaseId: '售后案件号', kind: '处置类型', amount: '当前金额', currency: '币种', quantity: '数量', unit: '单位',
      returnDisposition: '退货去向', status: '当前状态', notes: '当前备注' },
    'development:fee': { itemNo: '收费项编号', sourceType: '来源类型', sourceId: '开发来源', chargeType: '收费类型', bearerType: '当前承担方',
      bearerName: '当前承担方名称', amount: '当前收费金额', waivedAmount: '当前减免金额', currency: '币种', status: '收费状态',
      developmentWorkflowState: '当前工作流状态', developmentWorkflowVersion: '当前工作流版本', developmentExpenseReviewId: '当前费用核齐记录' },
  };
  if (approval.actionType === 'quotation:price-deviation') {
    return statusFields(source, { quotationNumber: '报价单号', status: '当前报价状态', customerName: '客户', currency: '当前币种',
      totalAmount: '当前报价总额', version: '当前报价版本', validUntil: '当前有效期', trackAMedianUsd: '当前轨道 A 单价（USD）',
      trackAUnit: '当前轨道 A 计价单位', trackBFinalUsd: '当前轨道 B 单价（USD）', priceDeviationPercent: '当前价格偏差',
      priceDeviationLevel: '当前规则等级', priceApprovalId: '关联审批单' }).concat(
      (Array.isArray(source.lines) ? source.lines : []).flatMap((line: any, index: number) => statusFields(line, {
        lineNumber: `第 ${index + 1} 行`, fabricCode: '面料编号', description: '条目说明', quantity: '数量', unit: '单位', unitPrice: '当前单价', amount: '当前行金额',
      })));
  }
  if (approval.actionType.startsWith('quotation:')) {
    return statusFields(source, { quotationNumber: '报价单号', status: '当前报价状态', customerName: '客户', currency: '当前币种',
      totalAmount: '当前报价总额', version: '当前报价版本', validUntil: '当前有效期' }).concat(
      (Array.isArray(source.lines) ? source.lines : []).flatMap((line: any, index: number) => statusFields(line, {
        lineNumber: `第 ${index + 1} 行`, fabricCode: '面料编号', description: '条目说明', quantity: '数量', unit: '单位', unitPrice: '当前单价', amount: '当前行金额',
      })));
  }
  if (approval.actionType === 'order:moq-exemption') {
    return statusFields(source, { poNumber: '客户订单号', customer: '客户', status: '当前订单状态', type: '业务类型',
      businessLine: '业务线', quantity: '订单数量', unit: '单位', updatedAt: '订单更新时间', dueDate: '订单交期' }).concat(
      (Array.isArray(source.lines) ? source.lines : []).flatMap((line: any, index: number) => statusFields(line, {
        lineNumber: `第 ${index + 1} 行`, itemNo: '订单行号', materialCode: '物料编号', description: '产品说明', quantity: '当前数量', unit: '单位',
      })));
  }
  if (approval.actionType === 'order:change') {
    return statusFields(source, labelsByAction[approval.actionType] ?? {}).concat(
      flatten(object(source.orderBasis), '原订单当前基准'));
  }
  if (approval.actionType === 'order:internal_trade_price') {
    return statusFields(source, labelsByAction[approval.actionType] ?? {}).concat(
      flatten(object(source.payload?.content), '当前内部供料价格内容'));
  }
  if (approval.actionType === 'order:short-ship-exemption') {
    return statusFields(source, labelsByAction[approval.actionType] ?? {});
  }
  if (approval.actionType === 'aftersales:claim-disposition') {
    return statusFields(source, labelsByAction[approval.actionType] ?? {}).concat(statusFields(object(source.claimCase), {
      caseNumber: '售后案件号', customerName: '客户', sourceOrderId: '原订单', sourceInvoiceId: '原发票',
      status: '当前案件状态', category: '客诉类型', problemDesc: '客诉内容', reportedAt: '报诉日期', reportedBy: '登记人',
    }));
  }
  return statusFields(source, labelsByAction[approval.actionType] ?? {});
}

/** Server-side decision gate for known business actions. Unknown action paths keep their native contract. */
export async function assertApprovalReviewReadyForDecision(tx: PrismaClient | any, approval: ReviewApproval, actor?: unknown): Promise<void> {
  const detail = buildApprovalReviewDetail(approval);
  if (detail.approvalBlockers.length) {
    const error = new Error(`批准依据不完整：${detail.approvalBlockers.join('、')}`) as Error & { code: string; statusCode: number };
    error.code = 'APPROVAL_CONTENT_CHANGED'; error.statusCode = 409; throw error;
  }
  if (approval.actionType === 'finance:payment_request' && approval.targetType === 'PaymentRequest' && approval.targetId) {
    const payload = object(approval.payload);
    // The refund kernel already locks and validates its real CN, refund, and
    // PaymentRequest facts in their native lock order before reaching here.
    if (payload.schemaVersion === 1 && object(payload.content).paymentRequest) return;
    await assertPaymentRequestPayableApproval(tx, approval, actor);
    await tx.$queryRaw`SELECT "id" FROM "PaymentRequest" WHERE "id" = ${approval.targetId} FOR UPDATE`;
    const current = await tx.paymentRequest.findUnique({ where: { id: approval.targetId }, select: {
      id: true, requestNumber: true, totalAmount: true, currency: true, paymentCategory: true, status: true, approvalRequestId: true,
      supplierId: true, supplierName: true, customerRelationId: true, customerName: true,
    } });
    if (!current || current.status !== 'Pending' || current.approvalRequestId !== approval.id
      || current.requestNumber !== payload.requestNumber || String(current.totalAmount) !== String(payload.totalAmount)
      || current.currency !== payload.currency || current.paymentCategory !== payload.paymentCategory
      || (present(payload.supplierId) && current.supplierId !== payload.supplierId)
      || (present(payload.supplierName) && current.supplierName !== payload.supplierName)
      || (present(payload.customerRelationId) && current.customerRelationId !== payload.customerRelationId)
      || (present(payload.customerName) && current.customerName !== payload.customerName)) {
      const error = new Error('付款申请当前收款方、金额、币种、用途或待审批状态与冻结依据不一致，请刷新后重新核对。') as Error & { code: string; statusCode: number };
      error.code = 'APPROVAL_CONTENT_CHANGED'; error.statusCode = 409; throw error;
    }
  }
  if (approval.status === 'pending' && LIVE_SOURCE_REQUIRED.has(approval.actionType)) {
    try {
      const query = currentSourceQuery(tx, approval);
      const current = query ? await query : null;
      const blockers = await validateLiveDecisionBasis(tx, approval, current);
      if (blockers.length) {
        const error = new Error(`原业务当前依据已变化或无法核验：${blockers.join('、')}`) as Error & { code: string; statusCode: number };
        error.code = 'APPROVAL_CONTENT_CHANGED'; error.statusCode = 409; throw error;
      }
    } catch (error: any) {
      if (error?.code === 'APPROVAL_CONTENT_CHANGED') throw error;
      const safeMessage = error?.message?.includes('开发') ? '开发收费的当前费用核齐依据无法核验。'
        : error?.message?.includes('短装') ? '短装审批的运单、公差或数量依据无法核验。'
          : '原业务当前依据无法核验，请重新读取后再批准。';
      const unavailable = new Error(safeMessage) as Error & { code: string; statusCode: number };
      unavailable.code = 'APPROVAL_CONTENT_CHANGED'; unavailable.statusCode = 409; throw unavailable;
    }
  }
}
