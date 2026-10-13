export interface FabricSampleInvoiceItem {
  id: string;
  zroh: string;
  fabric: string;
  awb: string;
  shipToAddress: string;
  qty: number;
  unitPrice: number;
}

export interface SampleInvoiceTemplateConfig {
  logoDataUrl: string;
  stampDataUrl: string;
  logoScale: number;
  logoOffsetX: number;
  logoOffsetY: number;
  stampScale: number;
  stampOffsetX: number;
  stampOffsetY: number;
  companyName: string;
  companyAddress: string;
  paymentTerms: string;
  bankName: string;
  swiftCode: string;
  bankAddress: string;
  beneficiary: string;
  usdAccountNumber: string;
}

export interface SampleInvoiceDocument {
  invoiceNumber: string;
  invoiceDate: string;
  billToName: string;
  billToAddress: string;
  poNumber: string;
  items: FabricSampleInvoiceItem[];
  template: SampleInvoiceTemplateConfig;
}

export const DEFAULT_SAMPLE_INVOICE_TEMPLATE: SampleInvoiceTemplateConfig = {
  logoDataUrl: '',
  stampDataUrl: '',
  logoScale: 1,
  logoOffsetX: 0,
  logoOffsetY: 0,
  stampScale: 2,
  stampOffsetX: 0,
  stampOffsetY: 0,
  companyName: 'Jiangsu Panda Clothing Co.,Ltd.',
  companyAddress: 'ROOM A1028 WUYUE PLAZA,\nZHANGJIAGANG CITY,215600 PR\nCHINA',
  paymentTerms: 'AS PER AGREEMENT',
  bankName: 'BANK OF CHINA ZHANGJIAGANG SUB-BRANCH',
  swiftCode: 'BKCHCNBJ95L',
  bankAddress: '111 MIDDLE RENMIN ROAD, ZHANGJIAGANG CITY, SUZHOU, JIANGSU PROV., P.R.CHINA.',
  beneficiary: 'JIANGSU PANDA CLOTHING CO.,LTD.',
  usdAccountNumber: '467668133096',
};

export const createEmptyFabricInvoiceItem = (): FabricSampleInvoiceItem => ({
  id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
  zroh: '',
  fabric: '',
  awb: '',
  shipToAddress: '',
  qty: 0,
  unitPrice: 0,
});

export const calculateInvoiceTotal = (items: FabricSampleInvoiceItem[]) =>
  items.reduce(
    (acc, item) => {
      const qty = Number(item.qty) || 0;
      const amount = qty * (Number(item.unitPrice) || 0);
      return {
        qty: acc.qty + qty,
        amount: acc.amount + amount,
      };
    },
    { qty: 0, amount: 0 }
  );

const escapeHtml = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const linesToHtml = (value: string): string =>
  escapeHtml(value)
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0)
    .join('<br>');

const formatDate = (dateValue: string): string => {
  if (!dateValue) return '';
  const date = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(date.getTime())) return escapeHtml(dateValue);
  const months = [
    'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
    'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
  ];
  return `${date.getFullYear()} ${months[date.getMonth()]} ${String(date.getDate()).padStart(2, '0')}`;
};

const money = (value: number): string => (Number(value) || 0).toFixed(1);

const numberValue = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const generateFabricSampleInvoiceHtml = (doc: SampleInvoiceDocument): string => {
  const totals = calculateInvoiceTotal(doc.items);
  const template = { ...DEFAULT_SAMPLE_INVOICE_TEMPLATE, ...doc.template };
  const rows = doc.items.length > 0 ? doc.items : [createEmptyFabricInvoiceItem()];
  const logoScale = numberValue(template.logoScale, DEFAULT_SAMPLE_INVOICE_TEMPLATE.logoScale);
  const logoOffsetX = numberValue(template.logoOffsetX, DEFAULT_SAMPLE_INVOICE_TEMPLATE.logoOffsetX);
  const logoOffsetY = numberValue(template.logoOffsetY, DEFAULT_SAMPLE_INVOICE_TEMPLATE.logoOffsetY);
  const stampScale = numberValue(template.stampScale, DEFAULT_SAMPLE_INVOICE_TEMPLATE.stampScale);
  const stampOffsetX = numberValue(template.stampOffsetX, DEFAULT_SAMPLE_INVOICE_TEMPLATE.stampOffsetX);
  const stampOffsetY = numberValue(template.stampOffsetY, DEFAULT_SAMPLE_INVOICE_TEMPLATE.stampOffsetY);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Invoice - ${escapeHtml(doc.invoiceNumber || 'Sample')}</title>
  <style>
    @page { size: A5 landscape; margin: 5mm; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #f3f4f6; }
    body {
      font-family: Arial, Helvetica, sans-serif;
      color: #111;
      font-size: 9px;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .sheet {
      width: 200mm;
      min-height: 137mm;
      margin: 12px auto;
      background: #fff;
      border: 2px solid #111;
      position: relative;
      padding: 5mm 1.5mm 2.5mm;
    }
    .top {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      align-items: start;
      min-height: 24mm;
      padding: 0 1.5mm;
    }
    .logo {
      width: 33mm;
      max-height: 12mm;
      object-fit: contain;
      object-position: left center;
      display: block;
      margin-bottom: 2mm;
      cursor: pointer;
      transform: translate(${logoOffsetX}mm, ${logoOffsetY}mm) scale(${logoScale});
      transform-origin: left center;
    }
    .logo-text {
      font-size: 16px;
      line-height: 1;
      letter-spacing: -1px;
      font-weight: 400;
      margin-bottom: 2.5mm;
    }
    .company-lines {
      font-size: 6.4px;
      line-height: 1.28;
      font-weight: 700;
      text-transform: uppercase;
      max-width: 50mm;
    }
    .title {
      text-align: center;
      padding-top: 18mm;
      font-size: 9.5px;
      font-weight: 700;
      text-decoration: underline;
      letter-spacing: .2px;
    }
    .bill {
      margin: 0 0 2mm 1.5mm;
      min-height: 14mm;
      font-size: 6.4px;
      line-height: 1.35;
      font-weight: 700;
    }
    .bill-title { margin-bottom: 1.2mm; }
    .meta {
      display: grid;
      grid-template-columns: 25mm 26mm;
      gap: 3mm;
      margin: 0 0 1.5mm 1.5mm;
      font-size: 6.4px;
      font-weight: 700;
    }
    .items {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      font-size: 6.2px;
    }
    .items th,
    .items td {
      border: 1px solid #333;
      padding: 2.2mm 1mm;
      vertical-align: middle;
    }
    .items th {
      text-align: center;
      font-weight: 400;
      line-height: 1.15;
    }
    .items td {
      height: 7mm;
      font-weight: 400;
      line-height: 1.2;
    }
    .right { text-align: right; }
    .center { text-align: center; }
    .summary {
      display: grid;
      grid-template-columns: 1fr 12mm 22mm;
      align-items: center;
      margin-top: 12mm;
      padding: 0 13mm 0 112mm;
      font-size: 6.4px;
      font-weight: 400;
    }
    .footer {
      position: absolute;
      left: 1.5mm;
      right: 1.5mm;
      bottom: 3mm;
      display: grid;
      grid-template-columns: 108mm 1fr;
      gap: 7mm;
      align-items: end;
      font-size: 6.3px;
      line-height: 1.25;
      font-weight: 700;
    }
    .bank-row {
      display: grid;
      grid-template-columns: 28mm 1fr;
      gap: 1.5mm;
      margin-top: 1.5mm;
    }
    .stamp-area {
      position: relative;
      height: 31mm;
      display: flex;
      justify-content: flex-end;
      align-items: flex-end;
      padding-right: 6mm;
    }
    .stamp {
      max-width: 54mm;
      max-height: 28mm;
      object-fit: contain;
      cursor: pointer;
      transform: translate(${stampOffsetX}mm, ${stampOffsetY}mm) scale(${stampScale});
      transform-origin: bottom right;
    }
    .stamp-placeholder {
      width: 48mm;
      height: 25mm;
      border: 1px dashed #cbd5e1;
      border-radius: 50%;
      color: #94a3b8;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 400;
      font-size: 6px;
    }
    @media print {
      html, body { background: #fff; }
      .sheet { margin: 0; width: 100%; min-height: 137mm; border: 2px solid #111; }
    }
  </style>
</head>
<body>
  <main class="sheet">
    <section class="top">
      <div>
        ${template.logoDataUrl
          ? `<img class="logo" src="${template.logoDataUrl}" alt="Company Logo">`
          : `<div class="logo-text">panda</div>`}
        <div class="company-lines">
          ${escapeHtml(template.companyName)}<br>
          ${linesToHtml(template.companyAddress)}
        </div>
      </div>
      <div class="title">INVOICE</div>
      <div></div>
    </section>

    <section class="bill">
      <div class="bill-title">BILL TO</div>
      <div>${escapeHtml(doc.billToName || ' ')}</div>
      <div>${linesToHtml(doc.billToAddress || ' ')}</div>
    </section>

    <section class="meta">
      <div>
        <div>Invoice Number</div>
        <div>Invoice Date</div>
      </div>
      <div>
        <div>${escapeHtml(doc.invoiceNumber)}</div>
        <div>${formatDate(doc.invoiceDate)}</div>
      </div>
    </section>

    <table class="items">
      <colgroup>
        <col style="width: 11%">
        <col style="width: 11%">
        <col style="width: 12%">
        <col style="width: 16%">
        <col style="width: 17%">
        <col style="width: 7%">
        <col style="width: 9%">
        <col style="width: 17%">
      </colgroup>
      <thead>
        <tr>
          <th>PO NUMBER</th>
          <th>CLIENT CODE</th>
          <th>FABRIC</th>
          <th>AWB</th>
          <th>SHIP TO ADDRESS</th>
          <th>QTY&nbsp;&nbsp;(M)</th>
          <th>Unit Price<br>(USD)</th>
          <th>Amount<br>(USD)</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(item => {
          const amount = (Number(item.qty) || 0) * (Number(item.unitPrice) || 0);
          return `<tr>
          <td class="center">${escapeHtml(doc.poNumber)}</td>
          <td class="center">${escapeHtml(item.zroh)}</td>
          <td class="center">${escapeHtml(item.fabric)}</td>
          <td class="center">${escapeHtml(item.awb)}</td>
          <td class="center">${escapeHtml(item.shipToAddress)}</td>
          <td class="center">${Number(item.qty) || ''}</td>
          <td class="center">${money(Number(item.unitPrice) || 0)}</td>
          <td class="center">${money(amount)}</td>
        </tr>`;
        }).join('')}
      </tbody>
    </table>

    <section class="summary">
      <div>TOTAL:</div>
      <div class="center">${totals.qty || ''}</div>
      <div class="right">${money(totals.amount)}</div>
    </section>

    <section class="footer">
      <div>
        <div class="bank-row">
          <div>Payment terms:</div>
          <div>${escapeHtml(template.paymentTerms)}</div>
        </div>
        <div class="bank-row">
          <div>BANK INFORMATION :</div>
          <div>${escapeHtml(template.bankName)}</div>
        </div>
        <div class="bank-row">
          <div>SWIFT CODE:</div>
          <div>${escapeHtml(template.swiftCode)}</div>
        </div>
        <div class="bank-row">
          <div>ADDRESS:</div>
          <div>${escapeHtml(template.bankAddress)}</div>
        </div>
        <div class="bank-row">
          <div>BENEFICIARY</div>
          <div>${escapeHtml(template.beneficiary)}</div>
        </div>
        <div class="bank-row">
          <div>USD ACCOUNT NUMBER</div>
          <div style="font-size: 10px;">${escapeHtml(template.usdAccountNumber)}</div>
        </div>
      </div>
      <div class="stamp-area">
        ${template.stampDataUrl
          ? `<img class="stamp" src="${template.stampDataUrl}" alt="Company stamp">`
          : `<div class="stamp-placeholder">UPLOAD STAMP</div>`}
      </div>
    </section>
  </main>
</body>
</html>`;
};
