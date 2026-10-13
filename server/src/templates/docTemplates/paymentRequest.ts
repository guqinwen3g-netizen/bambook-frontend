/**
 * Payment Request 付款申请单 — 服务端单据模板（2026-09-12 §10.3-9 Phase B 批次 4）。
 *
 * 业务口径（业务方 2026-09-12 定案）：**付款申请单每张对应一份 PDF**（属「有文件」类单据
 * → 走电子签盖章链，与报价单/订单确认书/合同同规格）；订单变更单**不做 PDF**（纯程序内过权限）。
 *
 * 架构裁决：
 *   - 模板真源服务端（docTemplates 注册表体系），真源回链式：数据真源=PaymentRequest 业务
 *     实时装配（不复制进版本快照）——改业务侧即改文档
 *   - sourceRef=PaymentRequest.id，单据中心登记归档（domain=finance，type=PaymentRequest）
 *   - 单据号=requestNumber 业务申请号直用
 *   - 盖章位在**审批人**签字区：审批人签署后按签署人身份取章（§10.3-9 电子签）
 *   - 本模型**无行明细**（付款申请是「一笔款」的头单据）→ 明细区呈现单笔付款要素
 *     （付款性质 / 关联来源单据 / 金额），不做伪行表
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { esc, renderDocStamp, type DocSeal } from '../docPrintBase';
import { amountInWords } from './customsDocs';
import type { DocExporterProfile } from './packingList';
import { assertRefundHistory, cashRefundApprovalPayload, refundRefusal } from '../../claims/claimCashRefundFact';
import { localDateKey } from '../../shared/localDate';


// ────────────────────────────────────────────────────────────────
// 数据形状（loadPaymentRequestDocData 装配输出）
// ────────────────────────────────────────────────────────────────

export interface PaymentRequestDocData {
  pr: {
    id: string;
    requestNumber: string;
    status: string;
    requestDate: string;
    expectedPaymentDate: string | null;
    supplierName: string | null;
    supplierCode: string | null;
    totalAmount: number | string;
    customerRefund?: { customerName: string; creditNoteNumber: string; version: number; accountHolder: string };
    currency: string;
    paymentCategory: string;
    remark: string | null;
    /** 关联来源单据（持久化于 attachments.sourceDocument） */
    sourceType: string | null;
    sourceId: string | null;
    /** 来源单据业务号（可解析时给出，否则回落 sourceId） */
    sourceNumber: string | null;
    applicantName: string | null;
    reviewerName: string | null;
    approvalStatus: string | null;
    decidedAt: string | null;
    decisionNote: string | null;
    voucherNumber: string | null;
  };
}

/** 付款申请状态中文标签（与 FinancePaymentRequestsPanel 展示口径一致） */
export const PAYMENT_REQUEST_STATUS_LABEL: Record<string, string> = {
  Draft: '草稿',
  Pending: '审批中',
  Approved: '已批准',
  Rejected: '已驳回',
  VoucherIssued: '已生成付款凭证',
  Executing: '银行付款执行中',
  Paid: '已付款',
  Cancelled: '已作废',
};

/** 付款性质中文标签（真源同 PaymentVoucher.voucherCategory） */
export const PAYMENT_CATEGORY_LABEL: Record<string, string> = {
  normal: '常规',
  advance: '预收/预付',
  deposit: '保证金',
  sample_express: '样品快递费',
  customer_reimburse: '客户报销',
  business_cost: '业务成本',
};

const SOURCE_TYPE_LABEL: Record<string, string> = {
  purchase_order: '采购订单',
  order: '销售订单',
  expense: '费用单',
  other: '其他',
  credit_note: '客户贷项账户',
};

// ────────────────────────────────────────────────────────────────
// 数据装配（业务真源实时读取）
// ────────────────────────────────────────────────────────────────

/** 来源单据业务号解析（best-effort；解析失败回落 sourceId，不阻断出单） */
async function resolveSourceNumber(prisma: PrismaClient, type: string | null, id: string | null): Promise<string | null> {
  if (!type || !id) return null;
  const db = prisma as any;
  try {
    if (type === 'purchase_order') {
      const row = await db.purchaseOrder?.findUnique({ where: { id }, select: { poNumber: true } });
      return row?.poNumber ?? null;
    }
    if (type === 'order') {
      const row = await db.order?.findUnique({ where: { id }, select: { poNumber: true } });
      return row?.poNumber ?? null;
    }
  } catch {
    /* 来源单据读取失败 → 回落 sourceId */
  }
  return null;
}

/**
 * 按 PaymentRequest.id 装配文档数据。
 * 单据不存在/软删返回 null（调用方 404）。
 * PaymentRequest 模型无 @relation → 关联数据单独查询（与 paymentRequestRoute 同约定）。
 */
export async function loadPaymentRequestDocData(prisma: PrismaClient, id: string): Promise<PaymentRequestDocData | null> {
  const pr = await prisma.paymentRequest.findUnique({ where: { id } });
  if (!pr || pr.deletedAt) return null;

  const db = prisma as any;
  let customerRefund: PaymentRequestDocData['pr']['customerRefund'];
  if (pr.payeeType === 'Customer') {
    const refund = await db.creditNoteRefund.findUnique({ where: { paymentRequestId: pr.id } });
    if (!refund) refundRefusal('客户付款申请缺少真实退款来源');
    await assertRefundHistory(db, refund);
    const payload = await cashRefundApprovalPayload(db, refund, pr);
    const note = await db.creditNote.findUnique({ where: { id: refund.creditNoteId } });
    if (!note?.creditNoteNumber) refundRefusal('客户付款申请缺少真实贷项账户单号');
    customerRefund = { customerName: pr.customerName!, creditNoteNumber: note.creditNoteNumber,
      version: payload.content.version.version, accountHolder: payload.content.refund.payeeSnapshot.accountHolder };
  }
  const [supplier, applicant, reviewer, approval, voucher] = await Promise.all([
    pr.supplierId ? db.relation?.findUnique({ where: { id: pr.supplierId } }).catch(() => null) : Promise.resolve(null),
    db.userAccount?.findUnique({ where: { id: pr.applicantId }, select: { displayName: true } }).catch(() => null),
    db.userAccount?.findUnique({ where: { id: pr.reviewerId }, select: { displayName: true } }).catch(() => null),
    pr.approvalRequestId
      ? db.approvalRequest?.findUnique({
          where: { id: pr.approvalRequestId },
          select: { status: true, decidedAt: true, decisionNote: true },
        }).catch(() => null)
      : Promise.resolve(null),
    pr.paymentVoucherId
      ? db.paymentVoucher?.findUnique({ where: { id: pr.paymentVoucherId }, select: { voucherNumber: true } }).catch(() => null)
      : Promise.resolve(null),
  ]);

  const att = (pr.attachments ?? {}) as any;
  const src = att?.sourceDocument ?? null;
  const sourceType: string | null = customerRefund ? 'credit_note' : src?.type ?? null;
  const sourceId: string | null = customerRefund ? null : src?.id ?? null;

  return {
    pr: {
      id: pr.id,
      requestNumber: pr.requestNumber,
      status: pr.status,
      requestDate: pr.requestDate,
      expectedPaymentDate: pr.expectedPaymentDate,
      supplierName: supplier?.englishName || supplier?.chineseName || supplier?.name || pr.supplierName || null,
      supplierCode: supplier?.code ?? null,
      totalAmount: customerRefund ? String(pr.totalAmount) : Number(pr.totalAmount),
      ...(customerRefund ? { customerRefund } : {}),
      currency: pr.currency || 'CNY',
      paymentCategory: pr.paymentCategory || 'normal',
      remark: pr.remark,
      sourceType,
      sourceId,
      sourceNumber: customerRefund ? `${customerRefund.creditNoteNumber} / v${customerRefund.version}` : await resolveSourceNumber(prisma, sourceType, sourceId),
      applicantName: applicant?.displayName ?? null,
      reviewerName: reviewer?.displayName ?? null,
      approvalStatus: approval?.status ?? null,
      decidedAt: approval?.decidedAt ? localDateKey(new Date(approval.decidedAt)) : null,
      decisionNote: approval?.decisionNote ?? null,
      voucherNumber: voucher?.voucherNumber ?? null,
    },
  };
}

// ────────────────────────────────────────────────────────────────
// 渲染（body 片段；经 buildServerDocument 组装）
// ────────────────────────────────────────────────────────────────

const money = (v: number | string, currency: string): string => {
  const value = new Prisma.Decimal(v);
  if (!value.isFinite() || value.lt(0) || value.decimalPlaces() > 4 || value.gte('100000000000000')) refundRefusal('付款单金额无法按真实精度出单');
  const [integer, fraction] = value.toFixed(4).split('.');
  const decimals = fraction.replace(/0+$/, '').padEnd(2, '0');
  return `${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimals} ${esc(currency)}`;
};

/** Decimal fractions beyond cents must not be rounded in the written amount. */
function exactAmountInWords(value: number | string, currency: string): string {
  const [integer, fraction] = new Prisma.Decimal(value).toFixed(4).split('.');
  const words = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE'];
  if (integer.length <= 11 && fraction.slice(2) === '00') return amountInWords(Number(value), currency);
  return `SAY TOTAL ${currency} ${integer.split('').map(digit => words[Number(digit)]).join(' ')} POINT ${fraction.split('').map(digit => words[Number(digit)]).join(' ')} ONLY`;
}

const dash = (v: string | null | undefined): string => (v ? esc(v) : '—');

const linesToHtml = (text: string | null | undefined): string =>
  text ? String(text).split(/\r?\n/).map(esc).join('<br>') : '';

/** 付款申请单渲染（body 片段，中英文对照——付款要素 + 金额大写 + 双签） */
export function renderPaymentRequestBody(
  data: PaymentRequestDocData,
  exporter: DocExporterProfile,
  seal?: DocSeal | null,
): string {
  const { pr } = data;
  const cur = pr.currency || 'CNY';
  const statusLabel = PAYMENT_REQUEST_STATUS_LABEL[pr.status] ?? pr.status;
  const categoryLabel = PAYMENT_CATEGORY_LABEL[pr.paymentCategory] ?? pr.paymentCategory;
  const sourceText = pr.sourceType
    // B271：来源单号取不到就只留类型名，宁缺格也不把内部 sourceId 印到发出去的单子上
    ? `${SOURCE_TYPE_LABEL[pr.sourceType] ?? pr.sourceType}${pr.sourceNumber ? ` · ${esc(pr.sourceNumber)}` : ''}`
    : '—';

  return `
  <div class="doc-header">
    <div class="doc-title-block">
      <h1>PAYMENT REQUEST</h1>
      <div class="subtitle">付 款 申 请 单</div>
    </div>
    <div class="doc-meta">
      <div class="doc-no">${esc(pr.requestNumber)}</div>
      <div>Date 申请日期: ${esc(pr.requestDate)}</div>
      ${pr.expectedPaymentDate ? `<div>Expected 预期付款: ${esc(pr.expectedPaymentDate)}</div>` : ''}
      <div>Status 状态: ${esc(statusLabel)}</div>
    </div>
  </div>

  <div class="doc-party-grid">
    <div class="doc-party">
      <div class="label">Applicant 申请人</div>
      <div class="name">${dash(pr.applicantName)}</div>
      <div class="detail">Reviewer 审批人: ${dash(pr.reviewerName)}</div>
    </div>
    <div class="doc-party">
      <div class="label">Payee 收款方</div>
      <div class="name">${dash(pr.customerRefund?.customerName ?? pr.supplierName)}</div>
      ${pr.customerRefund ? `<div class="detail">Account Holder 收款户名: ${dash(pr.customerRefund.accountHolder)}</div>` : ''}
      ${pr.supplierCode ? `<div class="detail">Code 编码: ${esc(pr.supplierCode)}</div>` : ''}
    </div>
  </div>

  <div class="doc-section">
    <div class="doc-section-title">Payment Detail 付款明细</div>
    <table class="doc-table">
      <thead>
        <tr>
          <th>Category 付款性质</th>
          <th>Source Document 关联来源单据</th>
          <th style="text-align:right">Amount 申请金额 (${esc(cur)})</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>${esc(categoryLabel)}</td>
          <td>${esc(sourceText)}</td>
          <td style="text-align:right">${money(pr.totalAmount, cur)}</td>
        </tr>
      </tbody>
      <tfoot>
        <tr>
          <td colspan="2">TOTAL 合计</td>
          <td style="text-align:right">${money(pr.totalAmount, cur)}</td>
        </tr>
      </tfoot>
    </table>
    <div class="doc-notes">
      <div class="notes-title">Amount in Words 金额大写</div>
      ${esc(exactAmountInWords(pr.totalAmount, cur))}
    </div>
  </div>

  <div class="doc-section">
    <div class="doc-section-title">Approval 审批</div>
    <table class="doc-table">
      <tbody>
        <tr>
          <td style="width:25%"><strong>Approval 审批结果</strong></td>
          <td style="width:25%">${dash(pr.approvalStatus === 'approved' ? '已批准 Approved' : pr.approvalStatus === 'rejected' ? '已驳回 Rejected' : pr.approvalStatus ? '审批中 Pending' : null)}</td>
          <td style="width:25%"><strong>Decided 审批日期</strong></td>
          <td style="width:25%">${dash(pr.decidedAt)}</td>
        </tr>
        ${pr.voucherNumber ? `
        <tr>
          <td><strong>Voucher 付款凭证</strong></td>
          <td colspan="3">${esc(pr.voucherNumber)}</td>
        </tr>` : ''}
        ${pr.decisionNote ? `
        <tr>
          <td><strong>Note 审批意见</strong></td>
          <td colspan="3">${linesToHtml(pr.decisionNote)}</td>
        </tr>` : ''}
      </tbody>
    </table>
  </div>

  ${pr.remark ? `
  <div class="doc-notes">
    <div class="notes-title">Remarks 备注</div>
    ${linesToHtml(pr.remark)}
  </div>` : ''}

  <div class="doc-footer">
    <div class="doc-signature">
      <div class="sig-label">Applicant 申请人签字</div>
      <div class="sig-line">&nbsp;</div>
      <div class="sig-name">${dash(pr.applicantName)}</div>
    </div>
    <div class="doc-signature">
      <div class="sig-label">For and on behalf of ${esc(exporter.nameEn)} (Approver 审批人签章)</div>
      ${renderDocStamp(seal)}
      <div class="sig-line">&nbsp;</div>
      <div class="sig-name">${dash(pr.reviewerName)}</div>
    </div>
  </div>`;
}
