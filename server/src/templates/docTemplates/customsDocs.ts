import { businessNowDate } from '../../shared/businessClock';
/**
 * customs 域单据模板（CO / BL / INS）— 服务端真源（2026-08-22 B5 模板迁移）。
 *
 * 迁移裁决：前端 EXPORT_DOC_RENDERERS 的 CO/BL/INS 三类（有 TradeDocumentType 映射的）
 * 迁服务端注册表——模板真源统一服务端；前端渲染器保留为 501 回退兜底（B6 退役）。
 * FORMA/BC 无 TradeDocumentType 映射（仅运单文档集打印工具使用），暂留前端。
 * 版式与前端模板逐行同构迁移（doc-* 基座）。
 *
 * 2026-08-28 批次 H2 补齐：IC 检验证书 / PC 植检证书 / OTHER 通用单据三类打印模板
 * （此前只能登记壳出不了文件）；AWB 空运单已于 B11 注册。
 */

import { esc } from '../docPrintBase';
import type { DocExporterProfile } from './packingList';
import type { ServerDocumentSetData, ServerDocumentSetLine } from './types';

// ────────────────────────────────────────────────────────────────
// extras 形状（documentSetService 装配的扩展块）
// ────────────────────────────────────────────────────────────────

interface InsuranceExtras {
  insurer: string;
  insuredAmount: number | null;
  currency: string | null;
  premium: number | null;
  premiumCurrency: string | null;
  coverage: string;
}

interface LetterOfCreditExtras {
  lcNumber: string;
  issueBank: string | null;
  issueDate: string | null;
  applicant: string | null;
}

// ────────────────────────────────────────────────────────────────
// 共用辅助（与前端模板同语义迁移）
// ────────────────────────────────────────────────────────────────

const linesToHtml = (text: string | null | undefined): string =>
  text ? String(text).split(/\r?\n/).map(esc).join('<br>') : '';

const dash = (v: string | null | undefined): string => (v ? esc(v) : '—');

/** Strict decimal display boundary. Round magnitude with integer arithmetic;
 * source digits never cross a binary floating point conversion. Unknown values
 * stay unknown. Existing numeric display branches are retained verbatim. */
export function formatDocumentDecimal(value: unknown, minimumFractionDigits = 0, maximumFractionDigits = 2): string {
  if (typeof value !== 'string' || value.length > 64 || !/^[+-]?\d+(?:\.\d+)?$/.test(value)) return '—';
  const negative = value.startsWith('-'), unsigned = value.replace(/^[+-]/, ''), [whole, fraction = ''] = unsigned.split('.');
  const scale = BigInt(10) ** BigInt(maximumFractionDigits);
  let digits = BigInt(whole) * scale + BigInt((fraction + '0'.repeat(maximumFractionDigits)).slice(0, maximumFractionDigits) || '0');
  if (fraction[maximumFractionDigits] && fraction[maximumFractionDigits] >= '5') digits += BigInt(1);
  const integer = (digits / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  let decimal = maximumFractionDigits ? (digits % scale).toString().padStart(maximumFractionDigits, '0') : '';
  while (decimal.length > minimumFractionDigits && decimal.endsWith('0')) decimal = decimal.slice(0, -1);
  return (negative && digits !== BigInt(0) ? '-' : '') + integer + (decimal ? '.' + decimal : '');
}

const fmtQty = (n: number | string | null | undefined): string => {
  if (typeof n === 'string') return formatDocumentDecimal(n);
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n === null || n === undefined) return '—';
  return Number(n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)).toLocaleString('en-US');
};

const fmtW = (n: number | string | null | undefined): string => {
  if (typeof n === 'string') return formatDocumentDecimal(n, 2, 2);
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const fmtVol = (n: number | string | null | undefined): string => {
  if (typeof n === 'string') return formatDocumentDecimal(n, 3, 3);
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
};

const fmtMoney = (n: number | string | null | undefined, currency: string | null): string => {
  if (typeof n === 'string') { const formatted = formatDocumentDecimal(n, 2, 2); return formatted === '—' ? formatted : formatted + (currency ? ' ' + esc(currency) : ''); }
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n === null || n === undefined) return '—';
  return `${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${currency ? ' ' + esc(currency) : ''}`;
};

function localToday(): string {
  const d = businessNowDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

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
  data.order?.invoiceDate || localToday();

// D2：成交方式以**订单条款为准**（订单/合同是与客户谈定的商业合同依据）；
// 报关成交方式是申报数据，申报须与合同一致 —— 不一致由 documentSetService 报进 missing 告警
// （那里同时用它驱动「卖方是否投保」，不一致会产出错误的保险单要求）。
const tradeTerms = (data: ServerDocumentSetData): string =>
  data.order?.deliveryTerms || data.customs?.tradeTerms || 'FOB SHANGHAI';

// ────────────────────────────────────────────────────────────────
// CO — Certificate of Origin 原产地证明书
// ────────────────────────────────────────────────────────────────

export function renderCertificateOfOriginBody(data: ServerDocumentSetData, exporter: DocExporterProfile): string {
  const origin = data.customs?.originCountry || data.lines.find(l => l.originCountry)?.originCountry || 'CHINA';
  const destination = data.customs?.destinationCountry || '';
  const transport = [
    data.shipment.shippingMethod ? `BY ${data.shipment.shippingMethod.toUpperCase() === 'SEA' ? 'SEA' : esc(data.shipment.shippingMethod.toUpperCase())}` : null,
    data.shipment.vesselOrFlight ? esc(data.shipment.vesselOrFlight) + (data.shipment.voyageNumber ? ' ' + esc(data.shipment.voyageNumber) : '') : null,
    data.shipment.portOfLoading && data.shipment.portOfDischarge ? `FROM ${esc(data.shipment.portOfLoading)} TO ${esc(data.shipment.portOfDischarge)}` : null,
  ].filter(Boolean).join(' / ') || '—';

  const rows = data.lines.map((l: ServerDocumentSetLine) => `
    <tr>
      <td>${l.cartons ?? '—'} CTNS</td>
      <td>${esc(l.description)}</td>
      <td>${dash(l.hsCode)}</td>
      <td style="text-align:right">${fmtQty(l.quantity)}${l.unit ? ' ' + esc(l.unit) : ''}</td>
    </tr>`).join('');

  return `
  <div class="doc-header">
    <div class="doc-title-block">
      <h1>CERTIFICATE OF ORIGIN</h1>
      <div class="subtitle">原产地证明书</div>
    </div>
    <div class="doc-meta">
      <div class="doc-no">CO-${esc(data.shipment.shipmentNumber)}</div>
      <div>Date: ${esc(localToday())}</div>
      <div>Invoice No.: ${esc(resolvedInvoiceNo(data))}</div>
    </div>
  </div>

  <div class="doc-party-grid">
    ${exporterBlock('1. Exporter 出口商', exporter)}
    ${partyBlock('2. Consignee 收货人', data.parties.consignee?.name, data.parties.consignee?.address, data.parties.consignee?.contact)}
  </div>

  <div class="doc-section">
    <table class="doc-table">
      <tbody>
        <tr>
          <td style="width:50%"><strong>3. Means of Transport and Route 运输方式及路线</strong><br>${transport}</td>
          <td style="width:50%"><strong>4. Country/Region of Destination 目的国</strong><br>${dash(destination)}</td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="doc-section">
    <div class="doc-section-title">5. Marks &amp; Nos. 唛头</div>
    <div class="doc-party"><div class="detail">${shippingMarks(data)}</div></div>
  </div>

  <div class="doc-section">
    <div class="doc-section-title">6/7/8. Packages, Description, HS Code, Quantity</div>
    <table class="doc-table">
      <thead>
        <tr>
          <th>No. & Kind of Packages</th>
          <th>Description of Goods 品名</th>
          <th>HS Code</th>
          <th style="text-align:right">Quantity 数量</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>

  <div class="doc-section">
    <div class="doc-section-title">Declaration 声明</div>
    <div class="doc-notes" style="color:#2d3748;font-size:11px">
      The undersigned hereby declares that the above details and statements are correct, that all the goods were produced in
      <strong>${esc(origin)}</strong> and that they comply with the origin requirements specified for those goods
      in the Generalized System of Preferences for goods exported to the importing country.
      <br><br>
      兹声明上述货物均产于<strong>${esc(origin === 'CHINA' ? '中华人民共和国' : origin)}</strong>，所列内容属实无误。
    </div>
  </div>

  <div class="doc-footer">
    <div class="doc-signature">
      <div class="sig-label">Declaration by the Exporter 出口商声明</div>
      <div class="sig-line">&nbsp;</div>
      <div class="sig-name">${esc(exporter.nameEn)}</div>
    </div>
    <div class="doc-signature">
      <div class="sig-label">Certification 签证机构证明</div>
      <div class="sig-line">&nbsp;</div>
      <div class="sig-name">Issuing Authority (盖章)</div>
    </div>
  </div>`;
}

// ────────────────────────────────────────────────────────────────
// BL — Bill of Lading 提单补料（Shipper 草稿）
// ────────────────────────────────────────────────────────────────

export function renderBillOfLadingBody(data: ServerDocumentSetData, exporter: DocExporterProfile): string {
  // 运费条款推断：FOB/EXW/FCA → COLLECT；CIF/CIP/CFR/CPT/DDP/DAP → PREPAID
  const terms = (tradeTerms(data) || '').toUpperCase();
  const freightPrepaid = /CIF|CIP|CFR|CPT|DDP|DAP|DPU/.test(terms);

  const rows = data.lines.map((l: ServerDocumentSetLine) => `
    <tr>
      <td>${l.cartons ?? '—'} CTNS</td>
      <td>${esc(l.description)}</td>
      <td style="text-align:right">${fmtW(l.grossWeight)}</td>
      <td style="text-align:right">${fmtVol(l.volume)}</td>
    </tr>`).join('');

  return `
  <div class="doc-header">
    <div class="doc-title-block">
      <h1>BILL OF LADING</h1>
      <div class="subtitle">海运提单补料 (Shipper's Draft / SI)</div>
    </div>
    <div class="doc-meta">
      <div class="doc-no">B/L DRAFT-${esc(data.shipment.shipmentNumber)}</div>
      <div>Booking Date: ${dash(data.shipment.bookingDate)}</div>
      <div>ETD: ${dash(data.shipment.etd)}</div>
    </div>
  </div>

  <div class="doc-party-grid">
    ${exporterBlock('Shipper 托运人', exporter)}
    ${partyBlock('Consignee 收货人', data.parties.consignee?.name, data.parties.consignee?.address, data.parties.consignee?.contact)}
  </div>
  <div class="doc-party-grid">
    ${partyBlock('Notify Party 通知方', data.parties.consignee?.name, data.parties.consignee?.address, data.parties.consignee?.contact)}
    ${partyBlock('Carrier / Forwarder 承运人/货代', data.parties.carrier?.name)}
  </div>

  <div class="doc-section">
    <table class="doc-table">
      <tbody>
        <tr>
          <td style="width:25%"><strong>Vessel/Voyage 船名航次</strong></td>
          <td style="width:25%">${dash(data.shipment.vesselOrFlight)}${data.shipment.voyageNumber ? ' ' + esc(data.shipment.voyageNumber) : ''}</td>
          <td style="width:25%"><strong>Freight 运费条款</strong></td>
          <td style="width:25%"><strong>${freightPrepaid ? 'FREIGHT PREPAID 运费预付' : 'FREIGHT COLLECT 运费到付'}</strong></td>
        </tr>
        <tr>
          <td><strong>Port of Loading 起运港</strong></td>
          <td>${dash(data.shipment.portOfLoading)}</td>
          <td><strong>Port of Discharge 卸货港</strong></td>
          <td>${dash(data.shipment.portOfDischarge)}</td>
        </tr>
        <tr>
          <td><strong>Container No. 柜号</strong></td>
          <td>${dash(data.shipment.containerNumber)}</td>
          <td><strong>Seal No. 封号</strong></td>
          <td>${dash(data.shipment.sealNumber)}</td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="doc-section">
    <div class="doc-section-title">Marks &amp; Nos. 唛头</div>
    <div class="doc-party"><div class="detail">${shippingMarks(data)}</div></div>
  </div>

  <div class="doc-section">
    <div class="doc-section-title">Cargo Particulars 货物明细</div>
    <table class="doc-table">
      <thead>
        <tr>
          <th>No. of Packages 件数</th>
          <th>Description of Goods 货名</th>
          <th style="text-align:right">Gross Weight (KGS)</th>
          <th style="text-align:right">Measurement (CBM)</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td>${data.totals.cartons ?? data.shipment.totalPackages ?? '—'} CTNS</td>
          <td>TOTAL 合计</td>
          <td style="text-align:right">${fmtW(data.totals.grossWeight)}</td>
          <td style="text-align:right">${fmtVol(data.totals.volume)}</td>
        </tr>
      </tfoot>
    </table>
    <div class="doc-notes">
      <div class="notes-title">Remarks 备注</div>
      SHIPPER'S LOAD, COUNT AND SEAL. SAID TO CONTAIN. 托运人自装、自点、自封。
      ${data.shipment.notes ? '<br>' + linesToHtml(data.shipment.notes) : ''}
    </div>
  </div>

  <div class="doc-footer">
    <div class="doc-signature">
      <div class="sig-label">Shipper 托运人 (签章)</div>
      <div class="sig-line">&nbsp;</div>
      <div class="sig-name">${esc(exporter.nameEn)}</div>
    </div>
    <div class="doc-signature">
      <div class="sig-label">Carrier / Agent 承运人/代理 (签章)</div>
      <div class="sig-line">&nbsp;</div>
      <div class="sig-name">For the Carrier</div>
    </div>
  </div>`;
}

// ────────────────────────────────────────────────────────────────
// CI — Commercial Invoice 商业发票（documentSet 快照版——运单制单/无财务回链场景；
// 带财务回链的 CI 走 renderInvoiceDocumentHtml 财务真源模板，优先级见 lifecycleService）
// ────────────────────────────────────────────────────────────────

/** 英文金额大写（CI "SAY TOTAL" 行；支持到 billion，两位小数） */
export function amountInWords(amount: number, currency: string | null): string {
  const ones = ['', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE',
    'TEN', 'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN'];
  const tens = ['', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY'];
  const scales: Array<[number, string]> = [[1e9, 'BILLION'], [1e6, 'MILLION'], [1e3, 'THOUSAND']];

  const twoDigits = (n: number): string => (n < 20 ? ones[n] : `${tens[Math.floor(n / 10)]}${n % 10 ? '-' + ones[n % 10] : ''}`);
  const threeDigits = (n: number): string => {
    const h = Math.floor(n / 100);
    const rest = n % 100;
    return `${h ? ones[h] + ' HUNDRED' : ''}${h && rest ? ' AND ' : ''}${rest ? twoDigits(rest) : ''}`.trim();
  };

  let intPart = Math.floor(amount);
  const cents = Math.round((amount - intPart) * 100);
  const parts: string[] = [];
  for (const [scale, label] of scales) {
    if (intPart >= scale) {
      const chunk = Math.floor(intPart / scale);
      parts.push(`${threeDigits(chunk)} ${label}`);
      intPart %= scale;
    }
  }
  if (intPart > 0) parts.push(threeDigits(intPart));
  const intWords = parts.join(' ').replace(/\s+/g, ' ').trim() || 'ZERO';

  const currencyName = currency === 'USD' ? 'US DOLLARS' : currency === 'EUR' ? 'EUROS' : currency === 'CNY' ? 'CHINESE YUAN' : (currency || '');
  const centsWords = cents > 0 ? ` AND CENTS ${twoDigits(cents)}` : '';
  return `SAY TOTAL ${currencyName} ${intWords}${centsWords} ONLY`.replace(/\s+/g, ' ').trim();
}

const fmtUnitPrice = (n: number | string | null | undefined): string => {
  if (typeof n === 'string') return formatDocumentDecimal(n, 2, 4);
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n === null || n === undefined) return '—';
  const fixed = n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '.00');
  return Number(fixed).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
};

export function renderCommercialInvoiceBody(data: ServerDocumentSetData, exporter: DocExporterProfile): string {
  const currency = data.totals.currency || data.order?.currency || 'USD';
  const invoiceNo = resolvedInvoiceNo(data);
  const invoiceDate = resolvedInvoiceDate(data);

  const rows = data.lines.map((l: ServerDocumentSetLine) => `
    <tr>
      <td>${esc(l.description)}${l.hsCode ? `<br><span style="color:#718096;font-size:10px">HS: ${esc(l.hsCode)}</span>` : ''}</td>
      <td style="text-align:right">${fmtQty(l.quantity)}${l.unit ? ' ' + esc(l.unit) : ''}</td>
      <td style="text-align:right">${fmtUnitPrice(l.unitPrice)}</td>
      <td style="text-align:right">${fmtMoney(l.amount, null)}</td>
    </tr>`).join('');

  return `
  <div class="doc-header">
    <div class="doc-title-block">
      <h1>COMMERCIAL INVOICE</h1>
      <div class="subtitle">商业发票</div>
    </div>
    <div class="doc-meta">
      <div class="doc-no">${esc(invoiceNo)}</div>
      <div>Date: ${esc(invoiceDate)}</div>
      ${data.order?.poNumber ? `<div>P/O No.: ${esc(data.order.poNumber)}</div>` : ''}
      ${data.order?.finalContractNumber || data.order?.salesContractNumber ? `<div>S/C No.: ${esc(data.order.finalContractNumber || data.order.salesContractNumber || '')}</div>` : ''}
    </div>
  </div>

  <div class="doc-party-grid">
    ${exporterBlock('Seller / Exporter 卖方', exporter)}
    ${partyBlock('Buyer / Consignee 买方', data.parties.customer?.name, data.parties.customer?.address, data.parties.customer?.contact)}
  </div>

  <div class="doc-section">
    <div class="doc-section-title">Shipment 运输信息</div>
    <table class="doc-table">
      <tbody>
        <tr>
          <td style="width:25%"><strong>From 起运港</strong></td>
          <td style="width:25%">${dash(data.shipment.portOfLoading)}</td>
          <td style="width:25%"><strong>To 目的港</strong></td>
          <td style="width:25%">${dash(data.shipment.portOfDischarge)}</td>
        </tr>
        <tr>
          <td><strong>Vessel/Voyage 船名航次</strong></td>
          <td>${dash(data.shipment.vesselOrFlight)}${data.shipment.voyageNumber ? ' ' + esc(data.shipment.voyageNumber) : ''}</td>
          <td><strong>ETD 离港日</strong></td>
          <td>${dash(data.shipment.atd || data.shipment.etd)}</td>
        </tr>
        <tr>
          <td><strong>Terms of Delivery 贸易条款</strong></td>
          <td>${esc(tradeTerms(data))}</td>
          <td><strong>Terms of Payment 付款方式</strong></td>
          <td>${dash(data.order?.paymentTerms)}</td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="doc-section">
    <div class="doc-section-title">Goods 货物明细</div>
    <table class="doc-table">
      <thead>
        <tr>
          <th>Marks &amp; Nos.</th>
        </tr>
      </thead>
      <tbody>
        <tr><td>${shippingMarks(data)}</td></tr>
      </tbody>
    </table>
    <table class="doc-table">
      <thead>
        <tr>
          <th>Description of Goods 品名</th>
          <th style="text-align:right">Quantity 数量</th>
          <th style="text-align:right">Unit Price 单价 (${esc(currency)})</th>
          <th style="text-align:right">Amount 金额 (${esc(currency)})</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td colspan="3">TOTAL 合计</td>
          <td style="text-align:right">${fmtMoney(data.totals.amount, null)}</td>
        </tr>
      </tfoot>
    </table>
    ${data.totals.amount != null ? `<div class="doc-notes"><div class="notes-title">Amount in Words</div>${esc(amountInWords(data.totals.amount, currency))}</div>` : ''}
  </div>

  <div class="doc-section">
    <div class="doc-section-title">Beneficiary Bank 收款银行</div>
    <div class="doc-party">
      <div class="detail">
        Beneficiary: ${esc(exporter.beneficiary || exporter.nameEn)}<br>
        Bank: ${esc(exporter.bankName || '')}<br>
        Address: ${esc(exporter.bankAddress || '')}<br>
        SWIFT: ${esc(exporter.swiftCode || '')}<br>
        A/C No.: ${esc(exporter.usdAccountNumber || '')}
      </div>
    </div>
  </div>

  <div class="doc-footer">
    <div class="doc-signature">
      <div class="sig-label">For and on behalf of ${esc(exporter.nameEn)} (签章)</div>
      <div class="sig-line">&nbsp;</div>
      <div class="sig-name">Authorized Signature</div>
    </div>
  </div>`;
}

// ────────────────────────────────────────────────────────────────
// FORMA — GSP 普惠制原产地证（官方 12 栏格式草稿）
// ────────────────────────────────────────────────────────────────

export function renderFormABody(data: ServerDocumentSetData, exporter: DocExporterProfile): string {
  const origin = data.customs?.originCountry || data.lines.find(l => l.originCountry)?.originCountry || 'CHINA';
  const transport = [
    data.shipment.vesselOrFlight ? esc(data.shipment.vesselOrFlight) + (data.shipment.voyageNumber ? ' ' + esc(data.shipment.voyageNumber) : '') : null,
    data.shipment.etd || data.shipment.atd ? `ON/ABOUT ${esc(data.shipment.atd || data.shipment.etd || '')}` : null,
    data.shipment.portOfLoading && data.shipment.portOfDischarge ? `FROM ${esc(data.shipment.portOfLoading)}, CHINA TO ${esc(data.shipment.portOfDischarge)}` : null,
    data.shipment.shippingMethod ? `BY ${data.shipment.shippingMethod.toUpperCase() === 'SEA' ? 'SEA' : esc(data.shipment.shippingMethod.toUpperCase())}` : null,
  ].filter(Boolean).join('<br>') || '—';

  const originCriterion = String((data.extras as Record<string, unknown> | undefined)?.originCriterion ?? '');

  const rows = data.lines.map((l: ServerDocumentSetLine, i: number) => `
    <tr>
      <td style="text-align:center">${i + 1}</td>
      <td>${i === 0 ? shippingMarks(data) : ''}</td>
      <td>${l.cartons ?? '—'} CTNS<br>${esc(l.description)}</td>
      <td style="text-align:center">${esc(originCriterion)}</td>
      <td style="text-align:right">${fmtW(l.grossWeight)} KGS</td>
      <td>${i === 0 ? esc(resolvedInvoiceNo(data)) + '<br>' + esc(resolvedInvoiceDate(data)) : ''}</td>
    </tr>`).join('');

  return `
  <div class="doc-header">
    <div class="doc-title-block">
      <h1>GENERALIZED SYSTEM OF PREFERENCES<br>CERTIFICATE OF ORIGIN</h1>
      <div class="subtitle">FORM A · 普惠制原产地证 (Combined declaration and certificate)</div>
    </div>
    <div class="doc-meta">
      <div class="doc-no">FA-${esc(data.shipment.shipmentNumber)}</div>
      <div>Issued in ${esc(origin === 'CHINA' ? "THE PEOPLE'S REPUBLIC OF CHINA" : origin)}</div>
      <div>Country of destination: ${dash(data.customs?.destinationCountry)}</div>
    </div>
  </div>

  <table class="doc-table">
    <tbody>
      <tr>
        <td style="width:50%;vertical-align:top">
          <strong>1. Goods consigned from (Exporter's business name, address, country)</strong><br><br>
          ${esc(exporter.nameEn)}<br>${linesToHtml(exporter.addressEn)}
        </td>
        <td style="width:50%;vertical-align:top">
          <strong>Reference No.</strong><br>
          FA-${esc(data.shipment.shipmentNumber)}
        </td>
      </tr>
      <tr>
        <td style="vertical-align:top">
          <strong>2. Goods consigned to (Consignee's name, address, country)</strong><br><br>
          ${data.parties.consignee?.name ? esc(data.parties.consignee.name) : '—'}<br>
          ${data.parties.consignee?.address ? linesToHtml(data.parties.consignee.address) : ''}
        </td>
        <td style="vertical-align:top;color:#4a5568">
          <strong>4. For official use</strong><br><br>
          &nbsp;
        </td>
      </tr>
      <tr>
        <td colspan="2" style="vertical-align:top">
          <strong>3. Means of transport and route (as far as known)</strong><br><br>
          ${transport}
        </td>
      </tr>
    </tbody>
  </table>

  <div class="doc-section">
    <table class="doc-table">
      <thead>
        <tr>
          <th style="width:6%">5. Item No.</th>
          <th style="width:16%">6. Marks &amp; Nos.</th>
          <th>7. No. &amp; kind of packages; description of goods</th>
          <th style="width:8%">8. Origin criterion</th>
          <th style="width:14%;text-align:right">9. Gross weight</th>
          <th style="width:14%">10. No. &amp; date of invoices</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>

  <table class="doc-table">
    <tbody>
      <tr>
        <td style="width:50%;vertical-align:top">
          <strong>11. Certification</strong><br>
          It is hereby certified, on the basis of control carried out, that the declaration by the exporter is correct.
          <br><br><br><br>
          <div style="color:#4a5568">Place and date, signature and stamp of certifying authority</div>
        </td>
        <td style="width:50%;vertical-align:top">
          <strong>12. Declaration by the exporter</strong><br>
          The undersigned hereby declares that the above details and statements are correct; that all the goods were produced in
          <strong>${esc(origin === 'CHINA' ? 'CHINA' : origin)}</strong> and that they comply with the origin requirements
          specified for those goods in the Generalized System of Preferences for goods exported to the importing country.
          <br><br><br><br>
          <div style="color:#4a5568">Place and date, signature of authorized signatory</div>
        </td>
      </tr>
    </tbody>
  </table>`;
}

// ────────────────────────────────────────────────────────────────
// BC — Beneficiary's Certificate 受益人证明
// ────────────────────────────────────────────────────────────────

export function renderBeneficiaryCertificateBody(data: ServerDocumentSetData, exporter: DocExporterProfile): string {
  const lc = data.extras?.letterOfCredit as LetterOfCreditExtras | undefined;
  const today = localToday();

  return `
  <div class="doc-header">
    <div class="doc-title-block">
      <h1>BENEFICIARY'S CERTIFICATE</h1>
      <div class="subtitle">受益人证明</div>
    </div>
    <div class="doc-meta">
      <div class="doc-no">BC-${esc(data.shipment.shipmentNumber)}</div>
      <div>Date: ${esc(today)}</div>
      <div>Invoice No.: ${esc(resolvedInvoiceNo(data))}</div>
    </div>
  </div>

  <div class="doc-section">
    <table class="doc-table">
      <tbody>
        <tr>
          <td style="width:25%"><strong>To 致</strong></td>
          <td style="width:75%">${lc?.applicant ? esc(lc.applicant) : data.parties.customer?.name ? esc(data.parties.customer.name) : '—'}</td>
        </tr>
        ${lc ? `
        <tr>
          <td><strong>L/C No. 信用证号</strong></td>
          <td>${esc(lc.lcNumber)}${lc.issueBank ? ` issued by ${esc(lc.issueBank)}` : ''}${lc.issueDate ? ` dated ${esc(lc.issueDate)}` : ''}</td>
        </tr>` : ''}
        <tr>
          <td><strong>S/C or P/O No. 合同/订单号</strong></td>
          <td>${esc(data.order?.finalContractNumber || data.order?.salesContractNumber || data.order?.poNumber || '—')}</td>
        </tr>
        <tr>
          <td><strong>B/L or Shipment 运单号</strong></td>
          <td>${esc(data.shipment.shipmentNumber)}${data.shipment.vesselOrFlight ? ` per ${esc(data.shipment.vesselOrFlight)}` : ''}${data.shipment.voyageNumber ? ' ' + esc(data.shipment.voyageNumber) : ''}</td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="doc-section">
    <div class="doc-section-title">Certification 声明</div>
    <div class="doc-notes" style="color:#2d3748;font-size:12px;line-height:1.9">
      WE, ${esc(exporter.beneficiary || exporter.nameEn)}, HEREBY CERTIFY THAT:
      <br><br>
      1. ONE FULL SET OF NON-NEGOTIABLE SHIPPING DOCUMENTS (INCLUDING COPY OF BILL OF LADING,
      COMMERCIAL INVOICE AND PACKING LIST) HAS BEEN SENT DIRECTLY TO THE APPLICANT BY COURIER
      IMMEDIATELY AFTER SHIPMENT.
      <br>
      2. ALL DOCUMENTS PRESENTED CONFORM TO THE TERMS AND CONDITIONS OF THE RELATIVE LETTER OF CREDIT
      AND THE GOODS SHIPPED ARE IN STRICT ACCORDANCE WITH THE CONTRACT SPECIFICATIONS.
      <br><br>
      我司兹证明：船运后已立即以快递方式向开证申请人直接寄送全套副本装运单据（含提单副本、商业发票与装箱单），
      且所提交单据均符合相关信用证条款，所装货物与合同规格严格相符。
    </div>
  </div>

  <div class="doc-footer">
    <div class="doc-signature">
      <div class="sig-label">For and on behalf of ${esc(exporter.nameEn)} (签章)</div>
      <div class="sig-line">&nbsp;</div>
      <div class="sig-name">Beneficiary's Authorized Signature · ${esc(today)}</div>
    </div>
  </div>`;
}

// ────────────────────────────────────────────────────────────────
// INS — Insurance Policy / Certificate 保险单
// ────────────────────────────────────────────────────────────────

export function renderInsurancePolicyBody(data: ServerDocumentSetData, exporter: DocExporterProfile): string {
  const ins = (data.extras?.insurance ?? { insurer: '', insuredAmount: null, currency: null, premium: null, premiumCurrency: null, coverage: 'ALL RISKS' }) as InsuranceExtras;
  const lc = data.extras?.letterOfCredit as LetterOfCreditExtras | undefined;
  const claimsAt = data.shipment.portOfDischarge || data.customs?.destinationCountry || '—';

  const rows = data.lines.map((l: ServerDocumentSetLine) => `
    <tr>
      <td>${l.cartons ?? '—'} CTNS</td>
      <td>${esc(l.description)}</td>
      <td style="text-align:right">${fmtQty(l.quantity)}${l.unit ? ' ' + esc(l.unit) : ''}</td>
    </tr>`).join('');

  return `
  <div class="doc-header">
    <div class="doc-title-block">
      <h1>INSURANCE POLICY / CERTIFICATE</h1>
      <div class="subtitle">货物运输保险单</div>
    </div>
    <div class="doc-meta">
      <div class="doc-no">POLICY-${esc(data.shipment.shipmentNumber)}</div>
      <div>Invoice No.: ${esc(resolvedInvoiceNo(data))}</div>
      ${lc ? `<div>L/C No.: ${esc(lc.lcNumber)}</div>` : ''}
    </div>
  </div>

  <div class="doc-party-grid">
    <div class="doc-party">
      <div class="label">Insured / Beneficiary 被保险人</div>
      <div class="name">${esc(exporter.beneficiary || exporter.nameEn)}</div>
      <div class="detail">${linesToHtml(exporter.addressEn)}</div>
    </div>
    <div class="doc-party">
      <div class="label">Insurer 保险人</div>
      <div class="name">${dash(ins.insurer)}</div>
      <div class="detail">Claims payable at 赔付地点: ${esc(claimsAt)}</div>
    </div>
  </div>

  <div class="doc-section">
    <table class="doc-table">
      <tbody>
        <tr>
          <td style="width:25%"><strong>Amount Insured 保险金额</strong></td>
          <td style="width:25%"><strong>${fmtMoney(ins.insuredAmount, ins.currency)}</strong></td>
          <td style="width:25%"><strong>Premium 保费</strong></td>
          <td style="width:25%">${ins.premium != null ? fmtMoney(ins.premium, ins.premiumCurrency) : 'PAID 已付'}</td>
        </tr>
        <tr>
          <td><strong>Conveyance 运输工具</strong></td>
          <td>${dash(data.shipment.vesselOrFlight)}${data.shipment.voyageNumber ? ' ' + esc(data.shipment.voyageNumber) : ''}</td>
          <td><strong>Sailing on/about 开航日</strong></td>
          <td>${dash(data.shipment.atd || data.shipment.etd)}</td>
        </tr>
        <tr>
          <td><strong>From 起运港</strong></td>
          <td>${dash(data.shipment.portOfLoading)}</td>
          <td><strong>To 目的港</strong></td>
          <td>${dash(data.shipment.portOfDischarge)}</td>
        </tr>
        <tr>
          <td><strong>Conditions 承保险别</strong></td>
          <td colspan="3">${esc(ins.coverage)}</td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="doc-section">
    <div class="doc-section-title">Subject-matter Insured 保险标的</div>
    <table class="doc-table">
      <thead><tr><th>Marks &amp; Nos.</th></tr></thead>
      <tbody><tr><td>${shippingMarks(data)}</td></tr></tbody>
    </table>
    <table class="doc-table">
      <thead>
        <tr>
          <th>No. of Packages 件数</th>
          <th>Description of Goods 货名</th>
          <th style="text-align:right">Quantity 数量</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>

  ${lc ? `
  <div class="doc-section">
    <div class="doc-section-title">L/C Reference 信用证引用</div>
    <table class="doc-table">
      <tbody>
        <tr>
          <td style="width:25%"><strong>L/C No. 信用证号</strong></td>
          <td style="width:25%">${esc(lc.lcNumber)}</td>
          <td style="width:25%"><strong>Issuing Bank 开证行</strong></td>
          <td style="width:25%">${dash(lc.issueBank)}</td>
        </tr>
      </tbody>
    </table>
  </div>` : ''}

  <div class="doc-footer">
    <div class="doc-signature">
      <div class="sig-label">Insurer / Authorized Agent 保险人签章</div>
      <div class="sig-line">&nbsp;</div>
      <div class="sig-name">Authorized Signature</div>
    </div>
    <div class="doc-signature">
      <div class="sig-label">Insured 被保险人 (签章)</div>
      <div class="sig-line">&nbsp;</div>
      <div class="sig-name">${esc(exporter.nameEn)}</div>
    </div>
  </div>`;
}

/**
 * AWB 空运单（Air Waybill 补料版）— B11 注册（schema TradeDocumentType 枚举已留位）。
 * 空运版式：Shipper/Consignee/Notify/Issuing Carrier 四方 + 航班日期 + 起降机场 +
 * 件数/毛重/体积分计合计；运费条款推断与 BL 同规则（CIF/CIP... → PREPAID）。
 */
export function renderAirWaybillBody(data: ServerDocumentSetData, exporter: DocExporterProfile): string {
  const terms = (tradeTerms(data) || '').toUpperCase();
  const freightPrepaid = /CIF|CIP|CFR|CPT|DDP|DAP|DPU/.test(terms);
  const isAir = (data.shipment.shippingMethod || '').toUpperCase() === 'AIR';

  const rows = data.lines.map((l: ServerDocumentSetLine) => `
    <tr>
      <td>${l.cartons ?? '—'} PCS</td>
      <td>${esc(l.description)}</td>
      <td style="text-align:right">${fmtW(l.grossWeight)}</td>
      <td style="text-align:right">${fmtVol(l.volume)}</td>
    </tr>`).join('');

  return `
  <div class="doc-header">
    <div class="doc-title-block">
      <h1>AIR WAYBILL</h1>
      <div class="subtitle">空运单补料 (AWB Draft)</div>
    </div>
    <div class="doc-meta">
      <div class="doc-no">AWB DRAFT-${esc(data.shipment.shipmentNumber)}</div>
      <div>Booking Date: ${dash(data.shipment.bookingDate)}</div>
      <div>Flight Date: ${dash(data.shipment.atd || data.shipment.etd)}</div>
    </div>
  </div>

  <div class="doc-party-grid">
    ${exporterBlock('Shipper 托运人', exporter)}
    ${partyBlock('Consignee 收货人', data.parties.consignee?.name, data.parties.consignee?.address, data.parties.consignee?.contact)}
  </div>
  <div class="doc-party-grid">
    ${partyBlock('Notify Party 通知方', data.parties.consignee?.name, data.parties.consignee?.address, data.parties.consignee?.contact)}
    ${partyBlock('Issuing Carrier 签发承运人', data.parties.carrier?.name)}
  </div>

  <div class="doc-section">
    <table class="doc-table">
      <tbody>
        <tr>
          <td style="width:25%"><strong>Flight No. 航班号</strong></td>
          <td style="width:25%">${dash(data.shipment.vesselOrFlight)}</td>
          <td style="width:25%"><strong>Freight 运费条款</strong></td>
          <td style="width:25%"><strong>${freightPrepaid ? 'FREIGHT PREPAID 运费预付' : 'FREIGHT COLLECT 运费到付'}</strong></td>
        </tr>
        <tr>
          <td><strong>Airport of Departure 起运机场</strong></td>
          <td>${dash(data.shipment.portOfLoading)}</td>
          <td><strong>Airport of Destination 到达机场</strong></td>
          <td>${dash(data.shipment.portOfDischarge)}</td>
        </tr>
        <tr>
          <td><strong>MAWB No. 主单号</strong></td>
          <td>${dash(data.shipment.containerNumber)}</td>
          <td><strong>HAWB No. 分单号</strong></td>
          <td>${dash(data.shipment.sealNumber)}</td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="doc-section">
    <div class="doc-section-title">Handling Information 处理信息${isAir ? '' : '<span style="color:#718096;font-weight:400">（提示：该运单运输方式非 AIR，请核对）</span>'}</div>
    <div class="doc-party"><div class="detail">${shippingMarks(data)}</div></div>
  </div>

  <div class="doc-section">
    <div class="doc-section-title">Cargo Particulars 货物明细</div>
    <table class="doc-table">
      <thead>
        <tr>
          <th>No. of Packages 件数</th>
          <th>Description of Goods 货名</th>
          <th style="text-align:right">Gross Weight (KGS)</th>
          <th style="text-align:right">Measurement (CBM)</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td>${data.totals.cartons ?? data.shipment.totalPackages ?? '—'} PCS</td>
          <td>TOTAL 合计</td>
          <td style="text-align:right">${fmtW(data.totals.grossWeight)}</td>
          <td style="text-align:right">${fmtVol(data.totals.volume)}</td>
        </tr>
      </tfoot>
    </table>
    <div class="doc-notes">
      <div class="notes-title">Remarks 备注</div>
      SHIPPER'S LOAD AND COUNT. SAID TO CONTAIN. 托运人自装、自点。
      ${data.shipment.notes ? '<br>' + linesToHtml(data.shipment.notes) : ''}
    </div>
  </div>

  <div class="doc-footer">
    <div class="doc-signature">
      <div class="sig-label">For and on behalf of ${esc(exporter.nameEn)} (Shipper 托运人签章)</div>
      <div class="sig-line">&nbsp;</div>
      <div class="sig-name">Authorized Signature</div>
    </div>
    <div class="doc-signature">
      <div class="sig-label">Issuing Carrier 签发承运人</div>
      <div class="sig-line">&nbsp;</div>
      <div class="sig-name">Authorized Signature</div>
    </div>
  </div>`;
}

// ────────────────────────────────────────────────────────────────
// IC — Inspection Certificate 检验证书（批次 H2）
// ────────────────────────────────────────────────────────────────

/**
 * 检验证书（品质/数量证明草稿版）：出口方出具的货物检验证明。
 * 数据=运单 documentSet 快照（与 CO/BL 同真源）；证书号 IC-{运单号}。
 */
export function renderInspectionCertificateBody(data: ServerDocumentSetData, exporter: DocExporterProfile): string {
  const origin = data.customs?.originCountry || data.lines.find(l => l.originCountry)?.originCountry || 'CHINA';

  const rows = data.lines.map((l: ServerDocumentSetLine) => `
    <tr>
      <td>${esc(l.description)}</td>
      <td>${dash(l.hsCode)}</td>
      <td style="text-align:right">${fmtQty(l.quantity)}${l.unit ? ' ' + esc(l.unit) : ''}</td>
      <td style="text-align:right">${fmtW(l.grossWeight)}</td>
    </tr>`).join('');

  return `
  <div class="doc-header">
    <div class="doc-title-block">
      <h1>INSPECTION CERTIFICATE</h1>
      <div class="subtitle">检验证书（品质/数量）</div>
    </div>
    <div class="doc-meta">
      <div class="doc-no">IC-${esc(data.shipment.shipmentNumber)}</div>
      <div>Date: ${esc(localToday())}</div>
      <div>Invoice No.: ${esc(resolvedInvoiceNo(data))}</div>
    </div>
  </div>

  <div class="doc-party-grid">
    ${exporterBlock('Exporter / Seller 出口商', exporter)}
    ${partyBlock('Consignee / Buyer 收货人', data.parties.consignee?.name, data.parties.consignee?.address, data.parties.consignee?.contact)}
  </div>

  <div class="doc-section">
    <table class="doc-table">
      <tbody>
        <tr>
          <td style="width:25%"><strong>S/C or P/O No. 合同/订单号</strong></td>
          <td style="width:25%">${esc(data.order?.finalContractNumber || data.order?.salesContractNumber || data.order?.poNumber || '—')}</td>
          <td style="width:25%"><strong>Shipment 运单号</strong></td>
          <td style="width:25%">${esc(data.shipment.shipmentNumber)}</td>
        </tr>
        <tr>
          <td><strong>Conveyance 运输工具</strong></td>
          <td>${dash(data.shipment.vesselOrFlight)}${data.shipment.voyageNumber ? ' ' + esc(data.shipment.voyageNumber) : ''}</td>
          <td><strong>From → To 起讫港</strong></td>
          <td>${dash(data.shipment.portOfLoading)} → ${dash(data.shipment.portOfDischarge)}</td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="doc-section">
    <div class="doc-section-title">Marks &amp; Nos. 唛头</div>
    <div class="doc-party"><div class="detail">${shippingMarks(data)}</div></div>
  </div>

  <div class="doc-section">
    <div class="doc-section-title">Goods Inspected 受检货物</div>
    <table class="doc-table">
      <thead>
        <tr>
          <th>Description of Goods 品名</th>
          <th>HS Code</th>
          <th style="text-align:right">Quantity 数量</th>
          <th style="text-align:right">Gross Weight (KGS)</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td>TOTAL 合计</td>
          <td>—</td>
          <td style="text-align:right">${fmtQty(data.totals.quantity)}</td>
          <td style="text-align:right">${fmtW(data.totals.grossWeight)}</td>
        </tr>
      </tfoot>
    </table>
  </div>

  <div class="doc-section">
    <div class="doc-section-title">Certification 证明</div>
    <div class="doc-notes" style="color:#2d3748;font-size:11px;line-height:1.8">
      WE HEREBY CERTIFY THAT the goods described above have been duly inspected at the port of loading
      and were found in apparent good order and condition, conforming to the quality, quantity and packing
      requirements stipulated in the relative contract and/or letter of credit. Country of origin:
      <strong>${esc(origin)}</strong>.
      <br><br>
      兹证明上述货物已在装运港经检验，外观状况良好，品质、数量与包装符合相关合同及/或信用证之规定。
      原产国：<strong>${esc(origin === 'CHINA' ? '中华人民共和国' : origin)}</strong>。
    </div>
  </div>

  <div class="doc-footer">
    <div class="doc-signature">
      <div class="sig-label">Inspector 检验人 (签章)</div>
      <div class="sig-line">&nbsp;</div>
      <div class="sig-name">Authorized Inspector</div>
    </div>
    <div class="doc-signature">
      <div class="sig-label">For and on behalf of ${esc(exporter.nameEn)} (签章)</div>
      <div class="sig-line">&nbsp;</div>
      <div class="sig-name">Authorized Signature</div>
    </div>
  </div>`;
}

// ────────────────────────────────────────────────────────────────
// PC — Phytosanitary Certificate 植物检疫证书（批次 H2）
// ────────────────────────────────────────────────────────────────

/**
 * 植物检疫证书（草稿版）：IPPC 标准声明口径，证明货物经官方程序检疫、
 * 无进口缔约方规定的检疫性有害生物。证书号 PC-{运单号}；处理信息无数据真源，留 "—" 待官方填具。
 */
export function renderPhytosanitaryCertBody(data: ServerDocumentSetData, exporter: DocExporterProfile): string {
  const origin = data.customs?.originCountry || data.lines.find(l => l.originCountry)?.originCountry || 'CHINA';
  const destination = data.customs?.destinationCountry || data.shipment.portOfDischarge || '—';

  const rows = data.lines.map((l: ServerDocumentSetLine) => `
    <tr>
      <td>${l.cartons ?? '—'} CTNS</td>
      <td>${esc(l.description)}</td>
      <td style="text-align:right">${fmtQty(l.quantity)}${l.unit ? ' ' + esc(l.unit) : ''}</td>
      <td style="text-align:right">${fmtW(l.grossWeight)}</td>
    </tr>`).join('');

  return `
  <div class="doc-header">
    <div class="doc-title-block">
      <h1>PHYTOSANITARY CERTIFICATE</h1>
      <div class="subtitle">植物检疫证书（草稿）</div>
    </div>
    <div class="doc-meta">
      <div class="doc-no">PC-${esc(data.shipment.shipmentNumber)}</div>
      <div>Date: ${esc(localToday())}</div>
      <div>Invoice No.: ${esc(resolvedInvoiceNo(data))}</div>
    </div>
  </div>

  <table class="doc-table">
    <tbody>
      <tr>
        <td style="width:50%;vertical-align:top">
          <strong>1. Name and address of exporter 出口商名称地址</strong><br><br>
          ${esc(exporter.nameEn)}<br>${linesToHtml(exporter.addressEn)}
        </td>
        <td style="width:50%;vertical-align:top">
          <strong>2. Declared name and address of consignee 收货人名称地址</strong><br><br>
          ${data.parties.consignee?.name ? esc(data.parties.consignee.name) : '—'}<br>
          ${data.parties.consignee?.address ? linesToHtml(data.parties.consignee.address) : ''}
        </td>
      </tr>
      <tr>
        <td style="vertical-align:top">
          <strong>3. Means of conveyance 运输工具</strong><br><br>
          ${dash(data.shipment.vesselOrFlight)}${data.shipment.voyageNumber ? ' ' + esc(data.shipment.voyageNumber) : ''}
        </td>
        <td style="vertical-align:top">
          <strong>4. Declared point of entry 入境口岸</strong><br><br>
          ${esc(destination)}
        </td>
      </tr>
    </tbody>
  </table>

  <div class="doc-section">
    <div class="doc-section-title">5. Marks &amp; Nos. 唛头</div>
    <div class="doc-party"><div class="detail">${shippingMarks(data)}</div></div>
  </div>

  <div class="doc-section">
    <div class="doc-section-title">6/7/8. Packages, Description of Produce, Quantity</div>
    <table class="doc-table">
      <thead>
        <tr>
          <th>No. &amp; Kind of Packages 件数包装</th>
          <th>Description of Produce 品名</th>
          <th style="text-align:right">Quantity 数量</th>
          <th style="text-align:right">Gross Weight (KGS)</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="doc-notes" style="font-size:11px">
      Place of origin 产地: <strong>${esc(origin === 'CHINA' ? "THE PEOPLE'S REPUBLIC OF CHINA" : origin)}</strong>
    </div>
  </div>

  <div class="doc-section">
    <div class="doc-section-title">Declaration 植检声明</div>
    <div class="doc-notes" style="color:#2d3748;font-size:11px;line-height:1.8">
      This is to certify that the plants, plant products or other regulated articles described herein
      have been inspected and/or tested according to appropriate official procedures and are considered
      to be free from the quarantine pests specified by the importing contracting party and to conform
      with the current phytosanitary requirements of the importing contracting party.
      <br><br>
      兹证明上述植物、植物产品或其他限定物已按适当的官方程序检验和/或检测，确认不带进口缔约方规定的
      检疫性有害生物，符合进口缔约方现行植物检疫要求。
      <br><br>
      Disinfestation and/or Disinfection Treatment 除害处理: —
    </div>
  </div>

  <div class="doc-footer">
    <div class="doc-signature">
      <div class="sig-label">For and on behalf of ${esc(exporter.nameEn)} (签章)</div>
      <div class="sig-line">&nbsp;</div>
      <div class="sig-name">Authorized Signature</div>
    </div>
    <div class="doc-signature">
      <div class="sig-label">Issuing Authority 签证机构 (盖章)</div>
      <div class="sig-line">&nbsp;</div>
      <div class="sig-name">Authorized Officer</div>
    </div>
  </div>`;
}

// ────────────────────────────────────────────────────────────────
// OTHER — 通用外贸单据（批次 H2）
// ────────────────────────────────────────────────────────────────

/** OTHER 模板数据：运单 documentSet 快照优先；手工登记的 Other 单据回落 TradeDocument 行字段 */
export type OtherTradeDocumentData =
  | { source: 'set'; set: ServerDocumentSetData }
  | { source: 'doc'; doc: Record<string, unknown> };

const docStr = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * 通用外贸单据：无专用版式的 Other 类单据兜底模板。
 * 运单生成的 Other 单据 → 完整运输/货物版式；手工登记的 Other 单据 → 登记字段版式（壳也能出文件）。
 */
export function renderOtherTradeDocumentBody(data: OtherTradeDocumentData, exporter: DocExporterProfile): string {
  if (data.source === 'doc') {
    const d = data.doc;
    const fieldRow = (label: string, value: string | null): string => `
      <tr>
        <td style="width:30%"><strong>${esc(label)}</strong></td>
        <td style="width:70%">${value ? esc(value) : '—'}</td>
      </tr>`;
    const amount = d.totalAmount != null && d.totalAmount !== ''
      ? `${Number(d.totalAmount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${docStr(d.currency) ? ' ' + esc(docStr(d.currency)!) : ''}`
      : null;
    return `
  <div class="doc-header">
    <div class="doc-title-block">
      <h1>TRADE DOCUMENT</h1>
      <div class="subtitle">外贸单据（通用）</div>
    </div>
    <div class="doc-meta">
      <div class="doc-no">${esc(docStr(d.documentNumber) ?? '—')}</div>
      <div>Issue Date 签发日期: ${esc(docStr(d.issueDate) ?? '—')}</div>
      ${docStr(d.expiryDate) ? `<div>Expiry 有效期至: ${esc(docStr(d.expiryDate)!)}</div>` : ''}
    </div>
  </div>

  <div class="doc-section">
    <div class="doc-section-title">Document Particulars 单据信息</div>
    <table class="doc-table">
      <tbody>
        ${fieldRow('Consignor 发货人', docStr(d.consignor))}
        ${fieldRow('Consignee 收货人', docStr(d.consignee))}
        ${fieldRow('Port of Loading 装运港', docStr(d.portOfLoading))}
        ${fieldRow('Port of Discharge 卸货港', docStr(d.portOfDischarge))}
        ${fieldRow('Total Amount 总金额', amount)}
        ${fieldRow('Issued By 签发人', docStr(d.issuedBy))}
      </tbody>
    </table>
  </div>

  ${docStr(d.notes) ? `
  <div class="doc-section">
    <div class="doc-section-title">Notes 备注</div>
    <div class="doc-notes">${linesToHtml(docStr(d.notes))}</div>
  </div>` : ''}

  <div class="doc-footer">
    <div class="doc-signature">
      <div class="sig-label">For and on behalf of ${esc(exporter.nameEn)} (签章)</div>
      <div class="sig-line">&nbsp;</div>
      <div class="sig-name">Authorized Signature</div>
    </div>
  </div>`;
  }

  const set = data.set;
  const rows = set.lines.map((l: ServerDocumentSetLine) => `
    <tr>
      <td>${esc(l.description)}</td>
      <td>${dash(l.hsCode)}</td>
      <td style="text-align:right">${fmtQty(l.quantity)}${l.unit ? ' ' + esc(l.unit) : ''}</td>
      <td style="text-align:right">${fmtMoney(l.amount, set.totals.currency)}</td>
    </tr>`).join('');

  return `
  <div class="doc-header">
    <div class="doc-title-block">
      <h1>TRADE DOCUMENT</h1>
      <div class="subtitle">外贸单据（通用）</div>
    </div>
    <div class="doc-meta">
      <div class="doc-no">DOC-${esc(set.shipment.shipmentNumber)}</div>
      <div>Date: ${esc(localToday())}</div>
      <div>Invoice No.: ${esc(resolvedInvoiceNo(set))}</div>
    </div>
  </div>

  <div class="doc-party-grid">
    ${exporterBlock('Exporter 出口商', exporter)}
    ${partyBlock('Consignee 收货人', set.parties.consignee?.name, set.parties.consignee?.address, set.parties.consignee?.contact)}
  </div>

  <div class="doc-section">
    <table class="doc-table">
      <tbody>
        <tr>
          <td style="width:25%"><strong>Shipment 运单号</strong></td>
          <td style="width:25%">${esc(set.shipment.shipmentNumber)}</td>
          <td style="width:25%"><strong>Conveyance 运输工具</strong></td>
          <td style="width:25%">${dash(set.shipment.vesselOrFlight)}${set.shipment.voyageNumber ? ' ' + esc(set.shipment.voyageNumber) : ''}</td>
        </tr>
        <tr>
          <td><strong>From 起运港</strong></td>
          <td>${dash(set.shipment.portOfLoading)}</td>
          <td><strong>To 目的港</strong></td>
          <td>${dash(set.shipment.portOfDischarge)}</td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="doc-section">
    <div class="doc-section-title">Marks &amp; Nos. 唛头</div>
    <div class="doc-party"><div class="detail">${shippingMarks(set)}</div></div>
  </div>

  <div class="doc-section">
    <div class="doc-section-title">Goods 货物明细</div>
    <table class="doc-table">
      <thead>
        <tr>
          <th>Description of Goods 品名</th>
          <th>HS Code</th>
          <th style="text-align:right">Quantity 数量</th>
          <th style="text-align:right">Amount 金额</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td colspan="2">TOTAL 合计</td>
          <td style="text-align:right">${fmtQty(set.totals.quantity)}</td>
          <td style="text-align:right">${fmtMoney(set.totals.amount, set.totals.currency)}</td>
        </tr>
      </tfoot>
    </table>
  </div>

  ${set.shipment.notes ? `
  <div class="doc-section">
    <div class="doc-section-title">Notes 备注</div>
    <div class="doc-notes">${linesToHtml(set.shipment.notes)}</div>
  </div>` : ''}

  <div class="doc-footer">
    <div class="doc-signature">
      <div class="sig-label">For and on behalf of ${esc(exporter.nameEn)} (签章)</div>
      <div class="sig-line">&nbsp;</div>
      <div class="sig-name">Authorized Signature</div>
    </div>
  </div>`;
}
