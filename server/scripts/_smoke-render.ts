import { renderTemplate, listTemplates } from '../src/templates/render';

console.log('## Templates:', listTemplates().map(t => `${t.id} v${t.schemaVersion}`));

const pdas = renderTemplate('invoice.sample.pdas', {
  invoiceNumber: 'PDAS26061501',
  invoiceDate: '2026-06-15',
  poNumber: 'PO-TEST-001',
  customer: {
    label: 'ACME Trading LLC',
    billingAddress: '123 Market St\nNew York, NY 10001\nUSA',
    shippingAddress: '500 Warehouse Ave\nNewark, NJ 07102\nUSA',
  },
  items: [
    { id: '1', zroh: 'ZR001', description: 'Cotton Sample 60s', qty: 5, unitPrice: 12.5 },
    { id: '2', zroh: 'ZR002', description: 'Linen Blend 40s',  qty: 3, unitPrice: 18.0 },
  ],
});
console.log('## PDAS:', { sha: pdas.sha, bytes: pdas.bytes, schemaVersion: pdas.schemaVersion });

const fabric = renderTemplate('invoice.sample.fabric', {
  invoiceNumber: 'FAB26061501',
  invoiceDate: '2026-06-15',
  billToName: 'ACME Trading LLC',
  billToAddress: '123 Market St\nNew York, NY 10001',
  poNumber: 'PO-FAB-001',
  items: [
    { id: '1', zroh: 'ZR-F-001', fabric: 'Twill 200gsm', awb: 'AWB-12345', shipToAddress: 'NJ Warehouse', qty: 50, unitPrice: 4.5 },
  ],
  template: {
    logoDataUrl: '', stampDataUrl: '', logoScale: 1, logoOffsetX: 0, logoOffsetY: 0,
    stampScale: 2, stampOffsetX: 0, stampOffsetY: 0,
    companyName: 'Jiangsu Panda Clothing Co.,Ltd.',
    companyAddress: 'ROOM A1028 WUYUE PLAZA,\nZHANGJIAGANG CITY,215600 PR\nCHINA',
    paymentTerms: 'AS PER AGREEMENT',
    bankName: 'BANK OF CHINA',
    swiftCode: 'BKCHCNBJ95L',
    bankAddress: '111 MIDDLE RENMIN ROAD, ZHANGJIAGANG CITY',
    beneficiary: 'JIANGSU PANDA CLOTHING CO.,LTD.',
    usdAccountNumber: '467668133096',
  },
});
console.log('## Fabric:', { sha: fabric.sha, bytes: fabric.bytes, schemaVersion: fabric.schemaVersion });

import * as fs from 'fs';
fs.writeFileSync('/tmp/_pdas.html', pdas.html);
fs.writeFileSync('/tmp/_fabric.html', fabric.html);
console.log('Written /tmp/_pdas.html & /tmp/_fabric.html');
