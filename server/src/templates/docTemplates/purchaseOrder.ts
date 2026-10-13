/**
 * Purchase Order 采购订单 — 服务端单据模板（2026-08-22 B2 运营域单据）。
 *
 * 架构裁决：
 *   - 模板真源服务端（docTemplates/ 注册表体系），与 PL/发票同一 doc-* 基座气质
 *   - 数据真源=PurchaseOrder 业务实时装配（不复制进版本快照）——文档号=poNumber，
 *     与 CI 财务回链同语义（改业务侧即改文档，重新生成文件幂等覆盖）
 *   - sourceRef=PurchaseOrder.id，单据中心登记归档（domain=procurement）
 */

import { PrismaClient } from '@prisma/client';
import { esc } from '../docPrintBase';
import type { DocExporterProfile } from './packingList';
import type { ServerSupplierContractDocumentData } from './types';
import { renderSupplierCommitmentBody } from './processingContract';

// ────────────────────────────────────────────────────────────────
// 数据形状（loadPurchaseOrderDocData 装配输出）
// ────────────────────────────────────────────────────────────────

export interface PurchaseOrderDocLine {
  lineNumber: number;
  materialCode: string | null;
  description: string;
  category: string | null;
  specification: string | null;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  amount: number | null;
}

export interface PurchaseOrderDocData {
  po: {
    id: string;
    poNumber: string;
    status: string;
    orderDate: string | null;
    expectedDeliveryDate: string | null;
    currency: string;
    totalAmount: number;
    deliveryTerms: string | null;
    paymentTerms: string | null;
    shipToAddress: string | null;
    buyer: string | null;
    notes: string | null;
  };
  supplier: {
    name: string;
    code: string | null;
    englishName: string | null;
    chineseName: string | null;
    /** Relation.contactInfo 原文（联系人/电话等多行文本） */
    contactInfo: string | null;
  } | null;
  /** 关联销售订单（客户单号，可空） */
  salesOrder: { poNumber: string | null; customer: string } | null;
  lines: PurchaseOrderDocLine[];
}

const CATEGORY_LABEL: Record<string, string> = {
  Fabric: '面料 Fabric',
  Trimmings: '辅料 Trimmings',
  Accessories: '配件 Accessories',
  Other: '其他 Other',
};

const STATUS_LABEL: Record<string, string> = {
  Draft: '草稿 Draft',
  Sent: '已发送 Sent',
  Confirmed: '供应商已确认 Confirmed',
  PartiallyReceived: '部分收料 Partially Received',
  Received: '已收料 Received',
  Closed: '已关闭 Closed',
  Cancelled: '已取消 Cancelled',
};

// ────────────────────────────────────────────────────────────────
// 数据装配（业务真源实时读取）
// ────────────────────────────────────────────────────────────────

/**
 * 按 PurchaseOrder.id 装配文档数据（含行明细 + 供应商档案 + 关联销售订单）。
 * 单据不存在/软删返回 null（调用方 404）。
 */
export async function loadPurchaseOrderDocData(prisma: PrismaClient, poId: string): Promise<PurchaseOrderDocData | null> {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    include: { lines: { orderBy: { lineNumber: 'asc' } } },
  });
  if (!po || po.deletedAt || po.businessOwnerId || po.approvedCommitmentRevisionId) return null;

  const [supplier, salesOrder] = await Promise.all([
    po.supplierRelationId
      ? prisma.relation.findUnique({ where: { id: po.supplierRelationId } })
      : Promise.resolve(null),
    po.orderId
      ? prisma.order.findUnique({ where: { id: po.orderId }, select: { poNumber: true, customer: true } })
      : Promise.resolve(null),
  ]);

  return {
    po: {
      id: po.id,
      poNumber: po.poNumber,
      status: po.status,
      orderDate: po.orderDate,
      expectedDeliveryDate: po.expectedDeliveryDate,
      currency: po.currency,
      totalAmount: Number(po.totalAmount),
      deliveryTerms: po.deliveryTerms,
      paymentTerms: po.paymentTerms,
      shipToAddress: po.shipToAddress,
      buyer: po.buyer,
      notes: po.notes,
    },
    supplier: supplier
      ? {
          name: supplier.name,
          code: supplier.code,
          englishName: supplier.englishName,
          chineseName: supplier.chineseName,
          contactInfo: supplier.contactInfo,
        }
      : null,
    salesOrder: salesOrder ? { poNumber: salesOrder.poNumber, customer: salesOrder.customer } : null,
    lines: po.lines.map(l => ({
      lineNumber: l.lineNumber,
      materialCode: l.materialCode,
      description: l.description,
      category: l.category,
      specification: l.specification,
      quantity: l.quantity != null ? Number(l.quantity) : null,
      unit: l.unit,
      unitPrice: l.unitPrice != null ? Number(l.unitPrice) : null,
      amount: l.amount != null ? Number(l.amount) : null,
    })),
  };
}

// ────────────────────────────────────────────────────────────────
// 渲染（body 片段；经 buildServerDocument 组装）
// ────────────────────────────────────────────────────────────────

const money = (v: number | null, currency: string): string =>
  v == null ? '—' : `${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

const qty = (v: number | null): string =>
  v == null ? '—' : Number(v).toLocaleString('en-US');

const dash = (v: string | null | undefined): string => (v ? esc(v) : '—');

const linesToHtml = (text: string | null | undefined): string =>
  text ? String(text).split(/\r?\n/).map(esc).join('<br>') : '';

function supplierBlock(data: PurchaseOrderDocData): string {
  const s = data.supplier;
  if (!s) {
    return `
  <div class="doc-party">
    <div class="label">Supplier 供应商</div>
    <div class="name">${esc(data.po.poNumber ? '—' : '—')}</div>
  </div>`;
  }
  const name = s.englishName || s.chineseName || s.name;
  return `
  <div class="doc-party">
    <div class="label">Supplier 供应商</div>
    <div class="name">${esc(name)}${s.code ? ` <span style="font-weight:400;color:#718096">(${esc(s.code)})</span>` : ''}</div>
    <div class="detail">${s.chineseName && s.englishName ? esc(s.chineseName) + '<br>' : ''}${linesToHtml(s.contactInfo)}</div>
  </div>`;
}

/** PO 采购订单渲染（body 片段） */
export function renderPurchaseOrderBody(data: PurchaseOrderDocData | ServerSupplierContractDocumentData, exporter: DocExporterProfile): string {
  if ('supplierContractDocumentProtocol' in data) return renderSupplierCommitmentBody(data, exporter, 'purchase');
  const { po } = data;
  const cur = po.currency;

  const rows = data.lines.map(l => `
    <tr>
      <td style="text-align:center">${l.lineNumber}</td>
      <td>${esc(l.description)}${l.specification ? `<br><span style="color:#718096;font-size:10px">${esc(l.specification)}</span>` : ''}</td>
      <td>${l.category ? esc(CATEGORY_LABEL[l.category] ?? l.category) : '—'}</td>
      <td>${dash(l.materialCode)}</td>
      <td style="text-align:right">${qty(l.quantity)}${l.unit ? ' ' + esc(l.unit) : ''}</td>
      <td style="text-align:right">${l.unitPrice == null ? '—' : Number(l.unitPrice).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td>
      <td style="text-align:right">${money(l.amount, cur)}</td>
    </tr>`).join('');

  const receivedNote = data.lines.some(l => l.quantity != null)
    ? ''
    : '';

  return `
  <div class="doc-header">
    <div class="doc-title-block">
      <h1>PURCHASE ORDER</h1>
      <div class="subtitle">采购订单</div>
    </div>
    <div class="doc-meta">
      <div class="doc-no">${esc(po.poNumber)}</div>
      <div>Date: ${dash(po.orderDate)}</div>
      <div>Status: ${esc(STATUS_LABEL[po.status] ?? po.status)}</div>
      ${data.salesOrder?.poNumber ? `<div>Ref S/O: ${esc(data.salesOrder.poNumber)}</div>` : ''}
    </div>
  </div>

  <div class="doc-party-grid">
    ${supplierBlock(data)}
    <div class="doc-party">
      <div class="label">Buyer 采购方</div>
      <div class="name">${esc(exporter.nameEn)}</div>
      <div class="detail">${linesToHtml(exporter.addressEn)}${po.buyer ? '<br>Attn: ' + esc(po.buyer) : ''}</div>
    </div>
  </div>

  <div class="doc-section">
    <div class="doc-section-title">Terms &amp; Delivery 条款与交期</div>
    <table class="doc-table">
      <tbody>
        <tr>
          <td style="width:25%"><strong>Expected Delivery 预计交期</strong></td>
          <td style="width:25%">${dash(po.expectedDeliveryDate)}</td>
          <td style="width:25%"><strong>Delivery Terms 交货条款</strong></td>
          <td style="width:25%">${dash(po.deliveryTerms)}</td>
        </tr>
        <tr>
          <td><strong>Payment Terms 付款条款</strong></td>
          <td>${dash(po.paymentTerms)}</td>
          <td><strong>Currency 币种</strong></td>
          <td>${esc(cur)}</td>
        </tr>
        ${po.shipToAddress ? `
        <tr>
          <td><strong>Ship To 收货地址</strong></td>
          <td colspan="3">${linesToHtml(po.shipToAddress)}</td>
        </tr>` : ''}
      </tbody>
    </table>
  </div>

  <div class="doc-section">
    <div class="doc-section-title">Line Items 采购明细</div>
    <table class="doc-table">
      <thead>
        <tr>
          <th style="text-align:center">#</th>
          <th>Description 品名</th>
          <th>Category 类别</th>
          <th>Material Code</th>
          <th style="text-align:right">Quantity 数量</th>
          <th style="text-align:right">Unit Price</th>
          <th style="text-align:right">Amount 金额</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td colspan="6">TOTAL 合计</td>
          <td style="text-align:right">${money(po.totalAmount, cur)}</td>
        </tr>
      </tfoot>
    </table>
  </div>

  ${po.notes ? `
  <div class="doc-notes">
    <div class="notes-title">Notes 备注</div>
    ${linesToHtml(po.notes)}
  </div>` : ''}

  <div class="doc-footer">
    <div class="doc-signature">
      <div class="sig-label">For and on behalf of ${esc(exporter.nameEn)} (Buyer 采购方签章)</div>
      <div class="sig-line">&nbsp;</div>
      <div class="sig-name">Authorized Signature</div>
    </div>
    <div class="doc-signature">
      <div class="sig-label">Supplier Confirmation 供应商确认</div>
      <div class="sig-line">&nbsp;</div>
      <div class="sig-name">Authorized Signature</div>
    </div>
  </div>`;
}
