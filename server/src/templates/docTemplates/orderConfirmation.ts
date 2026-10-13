/**
 * Order Confirmation 订单确认书 — 服务端单据模板（2026-08-22 B8 订单域单据）。
 *
 * 架构裁决：
 *   - 模板真源服务端（docTemplates/ 注册表体系），真源回链式（同 PO/QUOT）：
 *     数据真源=Order 业务实时装配（不复制进版本快照）——改业务侧即改文档
 *   - sourceRef=Order.id，单据中心登记归档（domain=orders）
 *   - 文档号=poNumber 业务单号直用（客户 PO 唯一；缺省走 OC- 前缀自动取号）
 *   - 多订单合并合同走 CONTRACT 组合模板（compositeDocumentService，B8），
 *     单订单正式确认场景用本模板——两者互补不重叠
 */

import { PrismaClient } from '@prisma/client';
import { esc, renderDocStamp, type DocSeal } from '../docPrintBase';
import { orderAmountOrNull } from '../../shared/orderAmount';
import type { DocExporterProfile } from './packingList';
import { localDateKey } from '../../shared/localDate';


/** Bump when the rendered order-confirmation layout or fixed wording changes. */
export const ORDER_CONFIRMATION_TEMPLATE_VERSION = 'oc-template-v1';

// ────────────────────────────────────────────────────────────────
// 数据形状（loadOrderConfirmationDocData 装配输出）
// ────────────────────────────────────────────────────────────────

export interface OrderConfirmationDocLine {
  lineNumber: number;
  itemNo: string | null;
  description: string | null;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  netValue: number | null;
  deliveryDate: string | null;
  tolerancePercent: number | null;
}

export interface OrderConfirmationDocData {
  order: {
    id: string;
    poNumber: string | null;
    customer: string;
    status: string;
    dueDate: string | null;
    currency: string;
    /**
     * 单据「TOTAL 合计」那一格的值 —— 订单金额**真源**（① 明细行 → ② totalNet → ③ 报价额）。
     * ★ 原名 `quoteAmount`（= 直接抄主档报价额），与同页明细行渲染的 `l.netValue` 是两个口径
     *   ⇒ 一张 `totalNet ≠ quoteAmount` 的单，客户拿到的 PDF 上「合计」与「明细行加起来」不等
     *   （E 批 2026-09-26 修，判据见 docs/S4验收结论与新增项-2026-09-26.md §F1-a）。
     * 取不到数时为 `null`（模板渲染成「—」），**不回落 0**。
     */
    orderAmount: number | null;
    deliveryTerms: string | null;
    paymentTerms: string | null;
    salesContractNumber: string | null;
    finalContractNumber: string | null;
    shipToAddress: string | null;
    createdAt: number;
  };
  /** 客户档案（Relation，可空——缺档案时抬头回落 order.customer 冗余名） */
  customer: {
    name: string;
    englishName: string | null;
    chineseName: string | null;
    contactInfo: string | null;
  } | null;
  lines: OrderConfirmationDocLine[];
}

// ────────────────────────────────────────────────────────────────
// 数据装配（业务真源实时读取）
// ────────────────────────────────────────────────────────────────

/**
 * 按 Order.id 装配订单确认书数据（含行明细 + 客户档案）。
 * 单据不存在/软删返回 null（调用方 404）。
 */
export async function loadOrderConfirmationDocData(prisma: PrismaClient, orderId: string): Promise<OrderConfirmationDocData | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { lines: { orderBy: { lineNumber: 'asc' } } },
  });
  if (!order || order.deletedAt) return null;

  const relation = order.customerRelationId
    ? await prisma.relation.findUnique({ where: { id: order.customerRelationId } })
    : null;

  const shipToParts = [
    order.shipToName,
    order.shipToAddress1,
    order.shipToAddress2,
    order.shipToCountry,
  ].filter((p): p is string => Boolean(p));

  return {
    order: {
      id: order.id,
      poNumber: order.poNumber,
      customer: order.customer,
      status: order.status,
      dueDate: order.dueDate,
      currency: String(order.currency || order.salesCurrency || 'USD'),
      orderAmount: orderAmountOrNull(order), // 真源：上面 :70 的 include 已带 lines ⇒ ① 可达
      deliveryTerms: order.deliveryTerms,
      paymentTerms: order.paymentTerms,
      salesContractNumber: order.salesContractNumber,
      finalContractNumber: order.finalContractNumber,
      shipToAddress: shipToParts.length > 0 ? shipToParts.join(', ') : null,
      createdAt: Number(order.createdAt ?? 0),
    },
    customer: relation
      ? {
          name: relation.name,
          englishName: relation.englishName,
          chineseName: relation.chineseName,
          contactInfo: relation.contactInfo,
        }
      : null,
    lines: order.lines.map(l => ({
      lineNumber: l.lineNumber,
      itemNo: l.itemNo,
      description: l.description,
      quantity: l.quantity != null ? Number(l.quantity) : null,
      unit: l.unit,
      unitPrice: l.unitPrice != null ? Number(l.unitPrice) : null,
      netValue: l.netValue != null ? Number(l.netValue) : null,
      deliveryDate: l.deliveryDate,
      tolerancePercent: l.tolerancePercent != null ? Number(l.tolerancePercent) : null,
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

/** 订单确认书渲染（body 片段，中英文对照） */
export function renderOrderConfirmationBody(data: OrderConfirmationDocData, exporter: DocExporterProfile, seal?: DocSeal | null): string {
  const { order } = data;
  const cur = order.currency;
  const docNo = order.poNumber || order.finalContractNumber || order.salesContractNumber || '—';
  const orderDate = order.createdAt > 0
    ? localDateKey(new Date(order.createdAt))
    : '—';

  const rows = data.lines.map(l => `
    <tr>
      <td style="text-align:center">${l.lineNumber}</td>
      <td>${dash(l.itemNo)}</td>
      <td>${dash(l.description)}</td>
      <td style="text-align:right">${qty(l.quantity)}${l.unit ? ' ' + esc(l.unit) : ''}${l.tolerancePercent != null && l.tolerancePercent > 0 ? `<br><span style="color:#718096;font-size:10px">±${l.tolerancePercent}%</span>` : ''}</td>
      <td style="text-align:right">${l.unitPrice == null ? '—' : Number(l.unitPrice).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td>
      <td style="text-align:right">${money(l.netValue, cur)}</td>
      <td>${dash(l.deliveryDate)}</td>
    </tr>`).join('');

  const customerName = data.customer
    ? (data.customer.englishName || data.customer.chineseName || data.customer.name)
    : order.customer;

  return `
  <div class="doc-header">
    <div class="doc-title-block">
      <h1>ORDER CONFIRMATION</h1>
      <div class="subtitle">订单确认书</div>
    </div>
    <div class="doc-meta">
      <div class="doc-no">${esc(docNo)}</div>
      <div>Date 确认日期: ${esc(orderDate)}</div>
      ${order.salesContractNumber ? `<div>S/C No. 合同号: ${esc(order.salesContractNumber)}</div>` : ''}
      ${order.finalContractNumber ? `<div>Final Contract 最终合同号: ${esc(order.finalContractNumber)}</div>` : ''}
    </div>
  </div>

  <div class="doc-party-grid">
    <div class="doc-party">
      <div class="label">Seller 卖方</div>
      <div class="name">${esc(exporter.nameEn)}</div>
      <div class="detail">${linesToHtml(exporter.addressEn)}</div>
    </div>
    <div class="doc-party">
      <div class="label">Buyer 买方</div>
      <div class="name">${esc(customerName)}</div>
      ${data.customer?.contactInfo ? `<div class="detail">${linesToHtml(data.customer.contactInfo)}</div>` : ''}
    </div>
  </div>

  <div class="doc-section">
    <div class="doc-section-title">Order Lines 订单明细</div>
    <table class="doc-table">
      <thead>
        <tr>
          <th style="text-align:center">#</th>
          <th>Item No.</th>
          <th>Description 品名描述</th>
          <th style="text-align:right">Quantity 数量</th>
          <th style="text-align:right">Unit Price 单价</th>
          <th style="text-align:right">Amount 金额</th>
          <th>Delivery 交期</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td colspan="5">TOTAL 合计</td>
          <td style="text-align:right">${money(order.orderAmount, cur)}</td>
          <td></td>
        </tr>
      </tfoot>
    </table>
  </div>

  <div class="doc-section">
    <div class="doc-section-title">Terms &amp; Conditions 条款</div>
    <table class="doc-table">
      <tbody>
        <tr>
          <td style="width:25%"><strong>Delivery Terms 交货条款</strong></td>
          <td style="width:25%">${dash(order.deliveryTerms)}</td>
          <td style="width:25%"><strong>Payment Terms 付款条款</strong></td>
          <td style="width:25%">${dash(order.paymentTerms)}</td>
        </tr>
        <tr>
          <td><strong>Due Date 交货日期</strong></td>
          <td>${dash(order.dueDate)}</td>
          <td><strong>Currency 币种</strong></td>
          <td>${esc(cur)}</td>
        </tr>
        ${order.shipToAddress ? `
        <tr>
          <td><strong>Ship To 收货地址</strong></td>
          <td colspan="3">${esc(order.shipToAddress)}</td>
        </tr>` : ''}
      </tbody>
    </table>
  </div>

  <div class="doc-footer">
    <div class="doc-signature">
      <div class="sig-label">For and on behalf of ${esc(exporter.nameEn)} (Seller 卖方签章)</div>
      ${renderDocStamp(seal)}
      <div class="sig-line">&nbsp;</div>
      <div class="sig-name">Authorized Signature</div>
    </div>
    <div class="doc-signature">
      <div class="sig-label">Buyer's Confirmation 买方确认</div>
      <div class="sig-line">&nbsp;</div>
      <div class="sig-name">Authorized Signature</div>
    </div>
  </div>`;
}
