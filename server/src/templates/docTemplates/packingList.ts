/**
 * Packing List 装箱单 — 服务端单据模板（2026-08-22 B1 架构底座：首个从前端迁移的真源模板）。
 *
 * 模板真源裁决：服务端统一。本函数为 PL 唯一渲染真源——前端 EXPORT_DOC_RENDERERS.PL
 * 将在 B6 退役；数据装配真源在 shipping/documentSetService（单一回退链）。
 * 版式：doc-* 基座（templates/docPrintBase.ts），与发票/合同同一气质。
 */

import { formatDocumentDecimal } from './customsDocs';
import { esc } from '../docPrintBase';
import type { ServerDocumentSetData } from './types';
import { assertPackingListEnvelope, type PackingListEnvelope } from './packingListSource';
import { businessNowDate } from '../../shared/businessClock';


/** 出口方档案（与 DEFAULT_EXPORTER_PROFILE 同构） */
export interface DocExporterProfile {
  nameEn: string;
  addressEn: string;
  beneficiary?: string;
  bankName?: string;
  swiftCode?: string;
  bankAddress?: string;
  usdAccountNumber?: string;
}

// ── 共用辅助（与前端 renderPackingListHtml 同语义迁移） ──

const linesToHtml = (text: string | null | undefined): string =>
  text ? String(text).split(/\r?\n/).map(esc).join('<br>') : '';

const dash = (v: string | null | undefined): string => (v ? esc(v) : '—');

const fmtQty = (n: number | string | null | undefined): string => {
  if (typeof n === 'string') return formatDocumentDecimal(n);
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n === null || n === undefined) return '—';
  const fixed = n % 1 === 0 ? n.toFixed(0) : n.toFixed(2);
  return Number(fixed).toLocaleString('en-US');
};

const fmtW = (n: number | string | null | undefined): string => {
  if (typeof n === 'string') return formatDocumentDecimal(n, 2, 2);
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
};

const fmtVol = (n: number | string | null | undefined): string => {
  if (typeof n === 'string') return formatDocumentDecimal(n, 3, 3);
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 }));
};

const formatDate = (d: Date): string => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** 默认唛头（数据模型无唛头字段时的通用占位） */
function shippingMarks(data: ServerDocumentSetData): string {
  const po = data.order?.poNumber;
  const dest = data.shipment.portOfDischarge;
  const pkgs = data.totals.cartons ?? data.shipment.totalPackages;
  if (!po && !dest) return 'N/M';
  return [po, dest ? `${dest}` : null, pkgs ? `C/NO. 1-${pkgs}` : null].filter(Boolean).map(esc).join('<br>');
}

function partyBlock(label: string, name: string | null | undefined, address?: string | null, contact?: string | null): string {
  return `
  <div class="doc-party">
    <div class="label">${esc(label)}</div>
    <div class="name">${name ? esc(name) : '—'}</div>
    <div class="detail">
      ${address ? linesToHtml(address) + '<br>' : ''}
      ${contact ? 'Attn: ' + esc(contact) : ''}
    </div>
  </div>`;
}

function exporterBlock(label: string, exporter: DocExporterProfile): string {
  return `
  <div class="doc-party">
    <div class="label">${esc(label)}</div>
    <div class="name">${esc(exporter.nameEn)}</div>
    <div class="detail">${linesToHtml(exporter.addressEn)}</div>
  </div>`;
}

const resolvedInvoiceNo = (data: ServerDocumentSetData): string =>
  data.order?.invoiceNumber || `INV-${data.shipment.shipmentNumber}`;

const resolvedInvoiceDate = (data: ServerDocumentSetData): string =>
  data.order?.invoiceDate || formatDate(businessNowDate());

/** PL 装箱单渲染（body 片段；经 buildServerDocument 组装完整文档） */
export function renderPackingListBody(data: ServerDocumentSetData | PackingListEnvelope, exporter: DocExporterProfile): string {
  if (data && Object.prototype.hasOwnProperty.call(data, 'plSourceProtocol')) return renderPackingListV2Body(assertPackingListEnvelope(data));
  return renderLegacyPackingListBody(data as ServerDocumentSetData, exporter);
}

function renderLegacyPackingListBody(data: ServerDocumentSetData, exporter: DocExporterProfile): string {
  const invoiceNo = resolvedInvoiceNo(data);
  const invoiceDate = resolvedInvoiceDate(data);

  const rows = data.lines.map((l) => `
    <tr>
      <td>${esc(l.description)}${l.productCode ? `<br><span style="color:#718096;font-size:10px">${esc(l.productCode)}</span>` : ''}</td>
      <td style="text-align:right">${fmtQty(l.quantity)}${l.unit ? ' ' + esc(l.unit) : ''}</td>
      <td style="text-align:right">${l.cartons ?? '—'}</td>
      <td style="text-align:right">${fmtW(l.grossWeight)}</td>
      <td style="text-align:right">${fmtW(l.netWeight)}</td>
      <td style="text-align:right">${fmtVol(l.volume)}</td>
    </tr>`).join('');

  return `
  <div class="doc-header">
    <div class="doc-title-block">
      <h1>PACKING LIST</h1>
      <div class="subtitle">装箱单</div>
    </div>
    <div class="doc-meta">
      <div class="doc-no">${esc(invoiceNo)}</div>
      <div>Date: ${esc(invoiceDate)}</div>
      ${data.order?.poNumber ? `<div>P/O No.: ${esc(data.order.poNumber)}</div>` : ''}
      ${data.shipment.customsDeclarationNumber ? `<div>报关单号: ${esc(data.shipment.customsDeclarationNumber)}</div>` : ''}
    </div>
  </div>

  <div class="doc-party-grid">
    ${exporterBlock('Shipper / Exporter 发货人', exporter)}
    ${partyBlock('Consignee 收货人', data.parties.consignee?.name, data.parties.consignee?.address, data.parties.consignee?.contact)}
  </div>

  <div class="doc-section">
    <div class="doc-section-title">Shipment 运输信息</div>
    <table class="doc-table">
      <tbody>
        <tr>
          <td style="width:25%"><strong>Vessel/Voyage 船名航次</strong></td>
          <td style="width:25%">${dash(data.shipment.vesselOrFlight)}${data.shipment.voyageNumber ? ' ' + esc(data.shipment.voyageNumber) : ''}</td>
          <td style="width:25%"><strong>Container/Seal 柜号/封号</strong></td>
          <td style="width:25%">${dash(data.shipment.containerNumber)} / ${dash(data.shipment.sealNumber)}</td>
        </tr>
        <tr>
          <td><strong>From 起运港</strong></td>
          <td>${dash(data.shipment.portOfLoading)}</td>
          <td><strong>To 目的港</strong></td>
          <td>${dash(data.shipment.portOfDischarge)}</td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="doc-section">
    <div class="doc-section-title">Packing Details 装箱明细</div>
    <table class="doc-table">
      <thead>
        <tr><th>Marks &amp; Nos.</th></tr>
      </thead>
      <tbody><tr><td>${shippingMarks(data)}</td></tr></tbody>
    </table>
    <table class="doc-table">
      <thead>
        <tr>
          <th>Description 品名</th>
          <th style="text-align:right">Quantity 数量</th>
          <th style="text-align:right">Cartons 箱数</th>
          <th style="text-align:right">G.W. (KGS)</th>
          <th style="text-align:right">N.W. (KGS)</th>
          <th style="text-align:right">Meas. (CBM)</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td>TOTAL 合计</td>
          <td style="text-align:right">${fmtQty(data.totals.quantity)}</td>
          <td style="text-align:right">${data.totals.cartons ?? '—'}</td>
          <td style="text-align:right">${fmtW(data.totals.grossWeight)}</td>
          <td style="text-align:right">${fmtW(data.totals.netWeight)}</td>
          <td style="text-align:right">${fmtVol(data.totals.volume)}</td>
        </tr>
      </tfoot>
    </table>
  </div>

  <div class="doc-footer">
    <div class="doc-signature">
      <div class="sig-label">For and on behalf of ${esc(exporter.nameEn)} (签章)</div>
      <div class="sig-line">&nbsp;</div>
      <div class="sig-name">Authorized Signature</div>
    </div>
  </div>`;
}

/** The selected version supplies every printed fact, including exporter and
 * date. Sparse carton numbers and unknown measurements remain explicit. */
function renderPackingListV2Body(envelope: PackingListEnvelope): string {
  const s = envelope.packingListSource;
  const exact = (v: string | null, places: number): string => v === null ? '—' : formatDocumentDecimal(v, 0, places);
  const lines = new Map(s.lines.map(line => [line.shipmentLineId, line]));
  const orders = new Map(s.orders.map(order => [order.id, order]));
  const rows = s.cartons.map(carton => {
    const items = carton.items.length ? carton.items : [null];
    return items.map((item, index) => {
      const line = item ? lines.get(item.shipmentLineId)! : null;
      const po = line?.orderId ? orders.get(line.orderId)?.poNumber : null;
      return `<tr>
        ${index === 0 ? `<td rowspan="${items.length}">${esc(carton.cartonNo)}</td>` : ''}
        <td>${dash(line?.description ?? carton.description)}${line?.productCode ? `<br>${esc(line.productCode)}` : ''}${line ? `<br>P/O: ${dash(po)}` : ''}</td>
        <td style="text-align:right">${item ? exact(item.quantity, 4) + (item.unit !== null ? ' ' + esc(item.unit) : ' —') : '—'}</td>
        ${index === 0 ? `<td rowspan="${items.length}">${exact(carton.length, 2)} × ${exact(carton.width, 2)} × ${exact(carton.height, 2)}</td>
        <td rowspan="${items.length}" style="text-align:right">${exact(carton.grossWeight, 3)}</td>
        <td rowspan="${items.length}" style="text-align:right">${exact(carton.netWeight, 3)}</td>
        <td rowspan="${items.length}" style="text-align:right">${exact(carton.volume, 4)}</td>` : ''}
      </tr>`;
    }).join('');
  }).join('');
  const summary = (label: string, row: typeof s.summaries.header) => `<tr><td>${label}</td><td style="text-align:right">${row.packages ?? '—'}</td>
    <td style="text-align:right">${exact(row.grossWeight, 3)}</td><td style="text-align:right">${exact(row.netWeight, 3)}</td><td style="text-align:right">${exact(row.volume, 4)}</td></tr>`;
  return `
  <div class="doc-header">
    <div class="doc-title-block"><h1>PACKING LIST</h1><div class="subtitle">装箱单</div></div>
    <div class="doc-meta"><div class="doc-no">${esc(s.document.documentNumber)}</div><div>Date: ${dash(s.document.issueDate)}</div>
      ${s.orders.filter(order => order.poNumber !== null).map(order => `<div>P/O No.: ${esc(order.poNumber!)}</div>`).join('')}
      ${s.shipment.customsDeclarationNumber ? `<div>报关单号: ${esc(s.shipment.customsDeclarationNumber)}</div>` : ''}
    </div>
  </div>
  <div class="doc-party-grid">${exporterBlock('Shipper / Exporter 发货人', s.exporter)}${partyBlock('Consignee 收货人', s.consignee.name)}</div>
  <div class="doc-section"><div class="doc-section-title">Shipment 运输信息</div><table class="doc-table"><tbody>
    <tr><td><strong>Vessel/Voyage 船名航次</strong></td><td>${dash(s.shipment.vesselOrFlight)} ${dash(s.shipment.voyageNumber)}</td>
      <td><strong>Container/Seal 柜号/封号</strong></td><td>${dash(s.shipment.containerNumber)} / ${dash(s.shipment.sealNumber)}</td></tr>
    <tr><td><strong>From 起运港</strong></td><td>${dash(s.shipment.portOfLoading)}</td><td><strong>To 目的港</strong></td><td>${dash(s.shipment.portOfDischarge)}</td></tr>
  </tbody></table></div>
  <div class="doc-section"><div class="doc-section-title">Packing Details 装箱明细</div><table class="doc-table">
    <thead><tr><th>Carton No. 箱号</th><th>Description 品名 / P/O</th><th>Quantity 数量</th><th>Size (CM)</th><th>G.W. (KGS)</th><th>N.W. (KGS)</th><th>Meas. (CBM)</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7">尚未登记逐箱包装资料。</td></tr>'}</tbody>
  </table></div>
  <div class="doc-section"><div class="doc-section-title">Summary 汇总</div><table class="doc-table">
    <thead><tr><th>Source 来源</th><th>Cartons 箱数</th><th>G.W. (KGS)</th><th>N.W. (KGS)</th><th>Meas. (CBM)</th></tr></thead><tbody>
      ${summary('Carton records 逐箱汇总', s.summaries.cartons)}${summary('Shipment header 原运单汇总', s.summaries.header)}
    </tbody></table>
    <div>${s.summaries.quantities.map(q => exact(q.quantity, 4) + (q.unit !== null ? ' ' + esc(q.unit) : ' 单位待核对')).join(' / ') || '数量待核对'}</div>
    ${s.warnings.map(w => `<div>${esc(w)}</div>`).join('')}
  </div>
  <div class="doc-footer"><div class="doc-signature"><div class="sig-label">For and on behalf of ${esc(s.exporter.nameEn)} (签章)</div>
    <div class="sig-line">&nbsp;</div><div class="sig-name">Authorized Signature</div></div></div>`;
}
