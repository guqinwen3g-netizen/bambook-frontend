import { renderTemplate } from '../src/templates/render';
import { renderHtmlToPdf } from '../src/templates/pdf';
import * as fs from 'fs';

async function main() {
  const pdas = renderTemplate('invoice.sample.pdas', {
    invoiceNumber: 'PDAS26061501',
    invoiceDate: '2026-06-15',
    customer: { label: 'ACME Trading LLC', billingAddress: '123 Market St\nNew York, NY' },
    items: [{ id: '1', zroh: 'ZR001', description: 'Cotton Sample', qty: 5, unitPrice: 12.5 }],
  });
  console.log('PDAS html sha:', pdas.sha, 'bytes:', pdas.bytes);
  const pdfA4 = await renderHtmlToPdf(pdas.html, { format: 'A4' });
  console.log('PDAS pdf sha:', pdfA4.sha, 'bytes:', pdfA4.bytes);
  fs.writeFileSync('/tmp/_pdas.pdf', pdfA4.pdf);

  const fabric = renderTemplate('invoice.sample.fabric', {
    invoiceNumber: 'FAB26061501',
    invoiceDate: '2026-06-15',
    billToName: 'ACME Trading LLC',
    billToAddress: '123 Market St\nNew York, NY 10001',
    poNumber: 'PO-FAB-001',
    items: [{ id: '1', zroh: 'ZR-F-001', fabric: 'Twill 200gsm', awb: 'AWB-12345', shipToAddress: 'NJ Warehouse', qty: 50, unitPrice: 4.5 }],
    template: {
      logoDataUrl: '', stampDataUrl: '', logoScale: 1, logoOffsetX: 0, logoOffsetY: 0,
      stampScale: 2, stampOffsetX: 0, stampOffsetY: 0,
      companyName: 'Jiangsu Panda Clothing Co.,Ltd.',
      companyAddress: 'ROOM A1028 WUYUE PLAZA,\nZHANGJIAGANG CITY,215600 PR\nCHINA',
      paymentTerms: 'AS PER AGREEMENT',
      bankName: 'BANK OF CHINA',
      swiftCode: 'BKCHCNBJ95L',
      bankAddress: '111 MIDDLE RENMIN ROAD',
      beneficiary: 'JIANGSU PANDA CLOTHING CO.,LTD.',
      usdAccountNumber: '467668133096',
    },
  });
  const pdfA5 = await renderHtmlToPdf(fabric.html, { format: 'A5', landscape: true, margin: { top: '5mm', bottom: '5mm', left: '5mm', right: '5mm' } });
  console.log('Fabric pdf sha:', pdfA5.sha, 'bytes:', pdfA5.bytes);
  fs.writeFileSync('/tmp/_fabric.pdf', pdfA5.pdf);

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
