import { businessNowDate } from '../../shared/businessClock';
/**
 * PDAS 样品发票模板（通用版）
 *
 * 来源：抽离自 components/tools/SampleInvoiceGenerator.tsx (85→237 行)。
 * 该前端组件曾是预览渲染的唯一权威，搬到 server 后两边共享同一份逻辑。
 *
 * 触发器：Phase 6 Compiled Templates
 * 维护者：随代码迭代，模板版本 templateVersion 仅在格式破坏性变更时升。
 */

export interface PdasSampleInvoiceItem {
  id: string;
  zroh: string;
  description: string;
  qty: number;
  unitPrice: number;
}

export interface PdasSampleInvoiceCustomer {
  /** 客户显示名（同时作为 BILL TO / SHIP TO 第一行） */
  label: string;
  /** 账单地址（多行用 \n 分隔） */
  billingAddress?: string;
  /** 收货地址（不传则等于账单地址） */
  shippingAddress?: string;
}

export interface PdasSampleInvoiceCompany {
  name: string;
  address: string;
  city: string;
  country: string;
}

export interface PdasSampleInvoiceBank {
  name: string;
  swift: string;
  account: string;
  currency: string;
}

export interface PdasSampleInvoiceDocument {
  invoiceNumber: string;
  /** ISO 日期 yyyy-mm-dd */
  invoiceDate: string;
  poNumber?: string;
  customer?: PdasSampleInvoiceCustomer;
  /** 当 customer 不存在时的回退 BILL TO 文本 */
  fallbackBillTo?: string;
  items: PdasSampleInvoiceItem[];
  company?: Partial<PdasSampleInvoiceCompany>;
  bank?: Partial<PdasSampleInvoiceBank>;
}

export const DEFAULT_PDAS_COMPANY: PdasSampleInvoiceCompany = {
  // 抬头口径与全单据统一：真源 = components/tools/exportDocs/exporterProfile.ts EXPORTER_PROFILE.nameEn
  // （CI/PL、面料样品发票均为全大写；核对脚本 npm run check:exporter-profile 守护）
  name: 'JIANGSU PANDA CLOTHING CO.,LTD.',
  address: 'ROOM A1028 WUYUE PLAZA',
  // 与真源 addressEn 第二行对齐（真源为 'ZHANGJIAGANG CITY, 215600 PR'）
  city: 'ZHANGJIAGANG CITY, 215600 PR',
  country: 'CHINA',
};

export const DEFAULT_PDAS_BANK: PdasSampleInvoiceBank = {
  name: 'BANK OF CHINA ZHANGJIAGANG SUB-BRANCH',
  swift: 'BKCHCNBJ95L',
  account: '467668133096',
  currency: 'USD',
};

const escapeHtml = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const formatLongDate = (value: string): string => {
  if (!value) return '';
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return `${date.getFullYear()} ${months[date.getMonth()]} ${date.getDate()}`;
};

export const calculatePdasInvoiceTotal = (items: PdasSampleInvoiceItem[]): number =>
  items.reduce((sum, item) => sum + (Number(item.qty) || 0) * (Number(item.unitPrice) || 0), 0);

/** 生成 PDAS 编号：PDAS{YY}{MM}{DD}{2-digit-seq} */
export const generatePdasInvoiceNumber = (date: Date = businessNowDate()): string => {
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const seq = String(Math.floor(Math.random() * 90) + 10);
  return `PDAS${yy}${mm}${dd}${seq}`;
};

export const generatePdasSampleInvoiceHtml = (doc: PdasSampleInvoiceDocument): string => {
  const company = { ...DEFAULT_PDAS_COMPANY, ...(doc.company || {}) };
  const bank = { ...DEFAULT_PDAS_BANK, ...(doc.bank || {}) };
  const customer = doc.customer;
  const billTo = customer?.billingAddress || customer?.label || doc.fallbackBillTo || 'N/A';
  const shipTo = customer?.shippingAddress || customer?.billingAddress || customer?.label || 'N/A';
  const total = calculatePdasInvoiceTotal(doc.items);

  const formatAddress = (raw: string): string =>
    escapeHtml(raw).replace(/\n/g, '<br>');

  const renderShipBlock = shipTo !== billTo && shipTo !== 'N/A'
    ? `
  <div class="address-block">
    <span class="info-label">SHIP TO:</span><br>
    ${escapeHtml(customer?.label || '')}<br>
    ${formatAddress(shipTo)}
  </div>`
    : '';

  const renderBillBlock = billTo !== 'N/A' && customer
    ? `
  <div class="address-block">
    <span class="info-label">BILL TO:</span><br>
    ${escapeHtml(customer.label || '')}<br>
    ${formatAddress(billTo)}
  </div>`
    : !customer
      ? `
  <div class="address-block">
    <span class="info-label">BILL TO:</span><br>
    ${formatAddress(billTo)}
  </div>`
      : '';

  const itemsHtml = doc.items.map(item => {
    const qty = Number(item.qty) || 0;
    const unitPrice = Number(item.unitPrice) || 0;
    const amount = qty * unitPrice;
    return `      <tr>
        <td>${escapeHtml(item.zroh) || '-'}</td>
        <td>${escapeHtml(item.description) || '-'}</td>
        <td class="text-right">${qty || '-'}</td>
        <td class="text-right">$${unitPrice.toFixed(2)}</td>
        <td class="text-right">$${amount.toFixed(2)}</td>
      </tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Sample Invoice - ${escapeHtml(doc.invoiceNumber)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 12px; padding: 40px; background: #fff; color: #1a1a1a; }
    .header { text-align: center; margin-bottom: 30px; padding-bottom: 20px; border-bottom: 2px solid #2563eb; }
    .company-name { font-size: 18px; font-weight: bold; }
    .company-address { font-size: 11px; color: #666; margin-top: 8px; }
    .invoice-title { font-size: 18px; font-weight: bold; margin: 20px 0; text-align: center; color: #2563eb; }
    .info-row { display: flex; justify-content: space-between; margin-bottom: 20px; }
    .info-block { margin-bottom: 15px; }
    .info-label { font-weight: bold; color: #333; }
    .address-block { margin-bottom: 15px; padding: 10px; background: #f8f9fa; border-radius: 6px; }
    table { width: 100%; border-collapse: collapse; margin: 15px 0; }
    th, td { border: 1px solid #ddd; padding: 10px; text-align: left; }
    th { background: #f8f9fa; font-weight: bold; color: #333; }
    .text-right { text-align: right; }
    .total { font-size: 16px; font-weight: bold; text-align: right; margin: 20px 0; color: #2563eb; }
    .footer { margin-top: 40px; border-top: 1px solid #ddd; padding-top: 20px; }
    .footer p { margin: 5px 0; font-size: 11px; color: #666; }
    .footer .bank-info { margin-top: 15px; padding: 15px; background: #f8f9fa; border-radius: 8px; }
    @media print { body { padding: 12mm; } }
  </style>
</head>
<body>
  <div class="header">
    <div class="company-name">${escapeHtml(company.name)}</div>
    <div class="company-address">
      ${escapeHtml(company.address)}<br>
      ${escapeHtml(company.city)}<br>
      ${escapeHtml(company.country)}
    </div>
  </div>

  <div class="invoice-title">SAMPLE INVOICE</div>

  <div class="info-row">
    <div>
      <div class="info-block"><span class="info-label">Invoice Number:</span> ${escapeHtml(doc.invoiceNumber)}</div>
      <div class="info-block"><span class="info-label">Date:</span> ${formatLongDate(doc.invoiceDate)}</div>
    </div>
  </div>
${renderBillBlock}${renderShipBlock}
  ${doc.poNumber ? `<div class="info-block"><span class="info-label">PO Number:</span> ${escapeHtml(doc.poNumber)}</div>` : ''}

  <table>
    <thead>
      <tr>
        <th style="width: 15%">ZROH#</th>
        <th style="width: 45%">DESCRIPTION</th>
        <th class="text-right" style="width: 12%">QTY (M)</th>
        <th class="text-right" style="width: 13%">UNIT PRICE (USD)</th>
        <th class="text-right" style="width: 15%">AMOUNT (USD)</th>
      </tr>
    </thead>
    <tbody>
${itemsHtml}
    </tbody>
  </table>

  <div class="total">TOTAL: $${total.toFixed(2)} ${escapeHtml(bank.currency)}</div>

  <div class="footer">
    <p><span class="info-label">Payment Terms:</span> AS PER AGREEMENT</p>
    <div class="bank-info">
      <p><span class="info-label">Bank Information:</span></p>
      <p>${escapeHtml(bank.name)}</p>
      <p>SWIFT CODE: ${escapeHtml(bank.swift)}</p>
      <p>${escapeHtml(bank.currency)} ACCOUNT: ${escapeHtml(bank.account)}</p>
    </div>
  </div>
</body>
</html>`;
};
