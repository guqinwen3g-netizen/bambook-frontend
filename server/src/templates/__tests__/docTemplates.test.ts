/**
 * B2 运营域单据模板测试 — PO 采购订单 / IR 验货报告
 *
 * 覆盖：
 *   1. renderPurchaseOrderBody：标题/单号/供应商/条款/行明细/合计/双签区
 *   2. renderInspectionReportBody：标题/结果徽章/抽样与缺陷/双签状态（含未签占位）
 *   3. loadInspectionReportDocData：装配（Decimal→number 不适用此处为 Int；签名时间戳→日期；驻地/订单联查）
 *   4. registry：serverKindForType 映射 + PO/IR loadData 按 sourceRef 装配 + 无 sourceRef fail-closed
 */

import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { renderPurchaseOrderBody, loadPurchaseOrderDocData } from '../docTemplates/purchaseOrder';
import { renderInspectionReportBody, loadInspectionReportDocData } from '../docTemplates/inspectionReport';
import { renderCertificateOfOriginBody, renderBillOfLadingBody, renderInsurancePolicyBody, renderCommercialInvoiceBody, renderFormABody, renderBeneficiaryCertificateBody, amountInWords } from '../docTemplates/customsDocs';
import { serverKindForType, SERVER_DOC_TEMPLATES, isShipmentDocKind } from '../docTemplates/registry';

const EXPORTER = {
  nameEn: 'BAMBOOK TRADING CO., LTD.',
  addressEn: 'No. 88 Nanjing Road, Shanghai, China',
  beneficiary: 'BAMBOOK TRADING',
  bankName: 'Bank of Shanghai',
  swiftCode: 'BOSHCNSH',
  bankAddress: 'Shanghai Main Branch',
  usdAccountNumber: '1234567890',
};

// ── PO 渲染 ──

const PO_DATA = {
  po: {
    id: 'PO_1',
    poNumber: 'PO-20260806-001',
    status: 'Confirmed',
    orderDate: '2026-08-06',
    expectedDeliveryDate: '2026-09-15',
    currency: 'USD',
    totalAmount: 16850.5,
    deliveryTerms: 'FOB Shanghai',
    paymentTerms: 'T/T 30% deposit',
    shipToAddress: 'Hamburg Warehouse, Germany',
    buyer: 'Alice',
    notes: '首单试产，注意色差管控',
  },
  supplier: { name: 'Nantong Textile Mill', code: 'SUP-0001', englishName: 'Nantong Textile Mill Co., Ltd.', chineseName: '南通纺织厂', contactInfo: 'Tel: 0513-8888888' },
  salesOrder: { poNumber: 'CUS-PO-77', customer: 'ACME GmbH' },
  lines: [
    { lineNumber: 1, materialCode: 'FAB-001', description: 'Cotton Poplin 40x40', category: 'Fabric', specification: '110x76 44"', quantity: 12000, unit: 'YD', unitPrice: 1.2, amount: 14400 },
    { lineNumber: 2, materialCode: 'TRM-002', description: 'Sewing Thread', category: 'Trimmings', specification: null, quantity: 500, unit: 'PC', unitPrice: 4.9, amount: 2450.5 },
  ],
};

describe('renderPurchaseOrderBody', () => {
  it('渲染 PO 标题/单号/供应商/条款/行明细/合计/双签区', () => {
    const html = renderPurchaseOrderBody(PO_DATA as any, EXPORTER);
    expect(html).toContain('PURCHASE ORDER');
    expect(html).toContain('采购订单');
    expect(html).toContain('PO-20260806-001');
    expect(html).toContain('Nantong Textile Mill Co., Ltd.');
    expect(html).toContain('南通纺织厂');
    expect(html).toContain('BAMBOOK TRADING CO., LTD.');
    expect(html).toContain('FOB Shanghai');
    expect(html).toContain('Cotton Poplin 40x40');
    expect(html).toContain('面料 Fabric');
    expect(html).toContain('辅料 Trimmings');
    expect(html).toContain('12,000 YD');
    expect(html).toContain('16,850.50 USD'); // 合计
    expect(html).toContain('Ref S/O: CUS-PO-77');
    expect(html).toContain('首单试产，注意色差管控');
    // 双签区：采购方签章 + 供应商确认
    expect(html).toContain('Buyer 采购方签章');
    expect(html).toContain('Supplier Confirmation 供应商确认');
  });

  it('缺供应商/条款 → 破折号占位不渲染报错', () => {
    const html = renderPurchaseOrderBody({ ...PO_DATA, supplier: null, po: { ...PO_DATA.po, deliveryTerms: null, paymentTerms: null } } as any, EXPORTER);
    expect(html).toContain('—');
    expect(html).not.toContain('FOB Shanghai');
  });
});

// ── IR 渲染 ──

const IR_DATA = {
  report: {
    id: 'INR__ord_1',
    inspectionType: 'final',
    inspectionDate: '2026-08-20',
    inspectorOrg: 'SGS',
    aqlLevel: 'AQL 2.5',
    lotSize: 5000,
    sampleSize: 200,
    totalUnits: 200,
    passedUnits: 196,
    criticalDefects: 0,
    majorDefects: 1,
    minorDefects: 3,
    defectSummary: '1 处主要缺陷：袖口缝线跳针\n3 处次要缺陷：线头',
    result: 'pass',
    inspectedBy: 'QC Zhang',
    notes: null,
    qcSignedAt: '2026-08-21',
    businessSignedAt: null,
  },
  order: { poNumber: 'CUS-PO-77', customer: 'ACME GmbH', product: 'Men Shirt', quantity: 5000, dueDate: '2026-09-30' },
  locationName: 'Nantong QC Station',
};

describe('renderInspectionReportBody', () => {
  it('渲染 IR 标题/结果徽章/抽样/缺陷明细/双签状态', () => {
    const html = renderInspectionReportBody(IR_DATA as any, EXPORTER);
    expect(html).toContain('INSPECTION REPORT');
    expect(html).toContain('验货报告');
    expect(html).toContain('Final Inspection 最终验货');
    expect(html).toContain('PASS 合格');
    expect(html).toContain('AQL 2.5');
    expect(html).toContain('5000');
    expect(html).toContain('SGS');
    expect(html).toContain('QC Zhang');
    expect(html).toContain('Nantong QC Station');
    expect(html).toContain('袖口缝线跳针');
    expect(html).toContain('Signed 2026-08-21');      // QC 已签
    expect(html).toContain('Pending 待签');            // 业务未签
    expect(html).toContain('CUS-PO-77');
  });

  it('fail 结果 → FAIL 徽章 + 缺陷红色强调', () => {
    const html = renderInspectionReportBody({
      ...IR_DATA,
      report: { ...IR_DATA.report, result: 'fail', criticalDefects: 2 },
    } as any, EXPORTER);
    expect(html).toContain('FAIL 不合格');
  });

  it('result 为 null → PENDING 兜底徽章不报错', () => {
    const html = renderInspectionReportBody({
      ...IR_DATA,
      report: { ...IR_DATA.report, result: null },
    } as any, EXPORTER);
    expect(html).toContain('PENDING');
  });
});

// ── IR 数据装配（mock prisma 联查） ──

describe('loadInspectionReportDocData', () => {
  function makePrisma(overrides: Record<string, any> = {}): PrismaClient {
    return {
      inspectionReport: { findUnique: vi.fn().mockResolvedValue(overrides.report ?? null) },
      order: { findUnique: vi.fn().mockResolvedValue(overrides.order ?? null) },
      qCAssignment: { findFirst: vi.fn().mockResolvedValue(overrides.assignment ?? null) },
      qCLocation: { findUnique: vi.fn().mockResolvedValue(overrides.location ?? null) },
    } as any;
  }

  it('装配报告 + 订单 + 驻地；签名时间戳（毫秒）→ YYYY-MM-DD', async () => {
    const ts = Date.UTC(2026, 7, 21, 3, 0, 0); // 2026-08-21
    const prisma = makePrisma({
      report: {
        id: 'INR__ord_1', orderId: 'ord_1', inspectionType: 'final',
        totalUnits: 200, passedUnits: 196, criticalDefects: 0, majorDefects: 1, minorDefects: 3,
        defectSummary: null, result: 'pass', inspectedBy: 'QC Zhang', notes: null,
        inspectionDate: '2026-08-20', inspectorOrg: 'SGS', aqlLevel: 'AQL 2.5', lotSize: 5000, sampleSize: 200,
        signatures: { qcSignedAt: ts, businessSignedAt: null },
      },
      order: { poNumber: 'CUS-PO-77', customer: 'ACME', product: 'Shirt', quantity: 5000, dueDate: '2026-09-30' },
      assignment: { locationId: 'QCL_1' },
      location: { name: 'Nantong QC Station' },
    });
    const data = await loadInspectionReportDocData(prisma, 'INR__ord_1');
    expect(data).not.toBeNull();
    expect(data!.report.qcSignedAt).toBe('2026-08-21');
    expect(data!.report.businessSignedAt).toBeNull();
    expect(data!.locationName).toBe('Nantong QC Station');
    expect(data!.order?.customer).toBe('ACME');
  });

  it('报告不存在 → null（调用方 404）', async () => {
    const prisma = makePrisma({ report: null });
    expect(await loadInspectionReportDocData(prisma, 'INR__missing')).toBeNull();
  });
});

// ── PO 数据装配（mock prisma 联查） ──

describe('loadPurchaseOrderDocData', () => {
  function makePrisma(overrides: Record<string, any> = {}): PrismaClient {
    return {
      purchaseOrder: { findUnique: vi.fn().mockResolvedValue(overrides.po ?? null) },
      relation: { findUnique: vi.fn().mockResolvedValue(overrides.supplier ?? null) },
      order: { findUnique: vi.fn().mockResolvedValue(overrides.salesOrder ?? null) },
    } as any;
  }

  it('装配 PO 头 + 行明细 + 供应商 + 销售订单（Decimal→number）', async () => {
    const prisma = makePrisma({
      po: {
        id: 'PO_1', poNumber: 'PO-20260806-001', status: 'Confirmed', deletedAt: null,
        orderDate: '2026-08-06', expectedDeliveryDate: null, currency: 'USD',
        totalAmount: 16850.5,
        deliveryTerms: 'FOB', paymentTerms: null, shipToAddress: null, buyer: 'Alice', notes: null,
        orderId: 'ord_1', supplierRelationId: 'rel_1',
        lines: [
          { lineNumber: 1, materialCode: 'FAB-001', description: 'Poplin', category: 'Fabric', specification: null, quantity: 12000, unit: 'YD', unitPrice: 1.2, amount: 14400 },
        ],
      },
      supplier: { name: 'Nantong Mill', code: 'SUP-1', englishName: null, chineseName: '南通厂', contactInfo: '' },
      salesOrder: { poNumber: 'CUS-PO-77', customer: 'ACME' },
    });
    const data = await loadPurchaseOrderDocData(prisma, 'PO_1');
    expect(data).not.toBeNull();
    expect(data!.po.poNumber).toBe('PO-20260806-001');
    expect(data!.lines).toHaveLength(1);
    expect(data!.lines[0].quantity).toBe(12000);
    expect(data!.supplier?.chineseName).toBe('南通厂');
    expect(data!.salesOrder?.poNumber).toBe('CUS-PO-77');
  });

  it('PO 不存在/软删 → null', async () => {
    const prisma = makePrisma({ po: null });
    expect(await loadPurchaseOrderDocData(prisma, 'PO_missing')).toBeNull();
  });
});

// ── 注册表映射 ──

describe('serverKindForType / SERVER_DOC_TEMPLATES', () => {
  it('PO/IR/PL/CO/BL/AWB/INS 类型映射正确且模板已注册', () => {
    expect(serverKindForType('PurchaseOrder')).toBe('PO');
    expect(serverKindForType('InspectionReport')).toBe('IR');
    expect(serverKindForType('PackingList')).toBe('PL');
    expect(serverKindForType('CertificateOfOrigin')).toBe('CO');
    expect(serverKindForType('BillOfLading')).toBe('BL');
    expect(serverKindForType('InsuranceCert')).toBe('INS');
    expect(serverKindForType('AirWaybill')).toBe('AWB'); // B11 注册（此前前端兜底）
    expect(SERVER_DOC_TEMPLATES.PO.title).toContain('Purchase Order');
    expect(SERVER_DOC_TEMPLATES.IR.title).toContain('Inspection Report');
    expect(SERVER_DOC_TEMPLATES.CO.title).toContain('原产地证');
    expect(SERVER_DOC_TEMPLATES.BL.title).toContain('提单');
    expect(SERVER_DOC_TEMPLATES.AWB.title).toContain('空运单');
    expect(SERVER_DOC_TEMPLATES.INS.title).toContain('保险单');
  });

  it('PO/IR loadData 无 sourceRef → null（fail-closed，无业务真源不渲染）', async () => {
    const prisma = {} as PrismaClient;
    expect(await SERVER_DOC_TEMPLATES.PO.loadData(prisma, { id: 'TD_1', type: 'PurchaseOrder', sourceRef: null })).toBeNull();
    expect(await SERVER_DOC_TEMPLATES.IR.loadData(prisma, { id: 'TD_2', type: 'InspectionReport', sourceRef: null })).toBeNull();
  });
});

// ── B5 customs 域模板（CO / BL / INS）──

function makeCustomsDocSet(overrides: Record<string, any> = {}) {
  return {
    shipment: {
      id: 'SHP_1', shipmentNumber: 'SHP-2026-0001', status: 'Shipped',
      shippingMethod: 'SEA', vesselOrFlight: 'MSC ANNA', voyageNumber: '023W',
      portOfLoading: 'SHANGHAI', portOfDischarge: 'HAMBURG',
      containerNumber: 'MSCU1234567', sealNumber: 'S1234',
      bookingDate: '2026-08-01', etd: '2026-08-10', atd: '2026-08-11', eta: null,
      totalPackages: 100, grossWeight: 1000, netWeight: 900, volume: 2.5,
      notes: 'Handle with care', type: 'Sea', hsCode: null, customsDeclarationNumber: 'CD-1',
    },
    order: { id: 'ord_1', poNumber: 'CUS-PO-77', customer: 'ACME GmbH', currency: 'USD', deliveryTerms: 'CIF HAMBURG', paymentTerms: 'T/T', salesContractNumber: 'SC-1', finalContractNumber: null, invoiceNumber: 'INV-2026-001', invoiceDate: '2026-08-10' },
    customs: { declarationNumber: 'CD-1', declarationDate: '2026-08-09', declarationPort: 'SHANGHAI', tradeTerms: 'CIF HAMBURG', totalValue: 20000, currency: 'USD', originCountry: 'CHINA', destinationCountry: 'GERMANY', consignee: 'ACME', consignor: 'BAMBOOK' },
    parties: { customer: { name: 'ACME GmbH' }, consignee: { name: 'ACME GmbH', address: 'Hamburg, Germany' }, carrier: { name: 'MSC' } },
    lines: [
      { lineNumber: 1, description: 'Men Cotton Shirt', productCode: 'SHIRT-01', hsCode: '6205.20', quantity: 5000, unit: 'PCS', unitPrice: 4, amount: 20000, cartons: 100, grossWeight: 1000, netWeight: 900, volume: 2.5, originCountry: 'CHINA' },
    ],
    totals: { quantity: 5000, amount: 20000, cartons: 100, grossWeight: 1000, netWeight: 900, volume: 2.5, currency: 'USD' },
    missing: [],
    extras: {
      originCriterion: 'P',
      insurance: { insurer: 'PICC', insuredAmount: 22000, currency: 'USD', premium: null, premiumCurrency: null, coverage: 'ALL RISKS' },
      letterOfCredit: { lcNumber: 'LC-2026-88', issueBank: 'Deutsche Bank', issueDate: '2026-07-01', applicant: 'ACME GmbH' },
    },
    ...overrides,
  };
}

describe('B5 customs 域模板（CO / BL / INS，版本快照数据）', () => {
  it('CO 原产地证：标题/出口商/运输路线/HS Code/声明/原产国', () => {
    const html = renderCertificateOfOriginBody(makeCustomsDocSet() as any, EXPORTER);
    expect(html).toContain('CERTIFICATE OF ORIGIN');
    expect(html).toContain('原产地证明书');
    expect(html).toContain('BAMBOOK TRADING CO., LTD.');
    expect(html).toContain('FROM SHANGHAI TO HAMBURG');
    expect(html).toContain('6205.20');
    expect(html).toContain('CHINA');
    expect(html).toContain('中华人民共和国');
    expect(html).toContain('Declaration by the Exporter 出口商声明');
  });

  it('BL 提单补料：CIF → FREIGHT PREPAID；柜号封号/唛头/合计/双签', () => {
    const html = renderBillOfLadingBody(makeCustomsDocSet() as any, EXPORTER);
    expect(html).toContain('BILL OF LADING');
    expect(html).toContain("Shipper's Draft / SI");
    expect(html).toContain('FREIGHT PREPAID 运费预付'); // CIF 条款推断
    expect(html).toContain('MSCU1234567');
    expect(html).toContain('S1234');
    expect(html).toContain('TOTAL 合计');
    expect(html).toContain('SHIPPER\'S LOAD, COUNT AND SEAL');
    expect(html).toContain('For the Carrier');
  });

  it('BL FOB → FREIGHT COLLECT（运费条款推断反向）', () => {
    const data = makeCustomsDocSet();
    data.order.deliveryTerms = 'FOB SHANGHAI';
    data.customs.tradeTerms = 'FOB SHANGHAI';
    const html = renderBillOfLadingBody(data as any, EXPORTER);
    expect(html).toContain('FREIGHT COLLECT 运费到付');
  });

  it('INS 保险单：保额/险别/信用证引用/被保险人', () => {
    const html = renderInsurancePolicyBody(makeCustomsDocSet() as any, EXPORTER);
    expect(html).toContain('INSURANCE POLICY / CERTIFICATE');
    expect(html).toContain('货物运输保险单');
    expect(html).toContain('22,000.00 USD'); // 保险金额（货值 110%）
    expect(html).toContain('PICC');
    expect(html).toContain('ALL RISKS');
    expect(html).toContain('LC-2026-88');
    expect(html).toContain('Deutsche Bank');
    expect(html).toContain('Insured / Beneficiary 被保险人'); // 被保险人=出口商 beneficiary
  });

  it('INS extras 缺失 → 默认险别兜底不报错', () => {
    const data = makeCustomsDocSet({ extras: {} });
    const html = renderInsurancePolicyBody(data as any, EXPORTER);
    expect(html).toContain('INSURANCE POLICY');
    expect(html).toContain('ALL RISKS'); // 默认险别
  });
});

// ── B6 模板迁移收尾（CI 快照版 / FORMA / BC + 出运制单 kind 集合） ──

describe('B6 前端模板退役（CI / FORMA / BC 服务端迁移）', () => {
  it('CI documentSet 快照版：标题/买卖方/收款银行/金额大写/合计', () => {
    const html = renderCommercialInvoiceBody(makeCustomsDocSet() as any, EXPORTER);
    expect(html).toContain('COMMERCIAL INVOICE');
    expect(html).toContain('商业发票');
    expect(html).toContain('INV-2026-001'); // resolvedInvoiceNo
    expect(html).toContain('CIF HAMBURG');
    expect(html).toContain('Men Cotton Shirt');
    expect(html).toContain('TOTAL 合计');
    expect(html).toContain('20,000.00');
    expect(html).toContain('Amount in Words');
    expect(html).toContain('SAY TOTAL US DOLLARS');
    expect(html).toContain('Beneficiary Bank 收款银行');
    expect(html).toContain('Bank of Shanghai');
  });

  it('amountInWords 英文大写金额（整数/小数/零）', () => {
    expect(amountInWords(20000, 'USD')).toContain('TWENTY THOUSAND');
    expect(amountInWords(12345.67, 'USD')).toContain('TWELVE THOUSAND THREE HUNDRED AND FORTY-FIVE AND CENTS SIXTY-SEVEN');
    expect(amountInWords(0, 'EUR')).toContain('ZERO');
    expect(amountInWords(20000, 'CNY')).toContain('CHINESE YUAN');
  });

  it('FORMA 普惠制产地证：12 栏结构/签发地/原产地标准/运输路线', () => {
    const html = renderFormABody(makeCustomsDocSet() as any, EXPORTER);
    expect(html).toContain('GENERALIZED SYSTEM OF PREFERENCES');
    expect(html).toContain('FORM A');
    expect(html).toContain('REPUBLIC OF CHINA'); // esc 后撇号为 &#39;
    expect(html).toContain('Origin criterion');
    expect(html).toContain('Declaration by the exporter');
    expect(html).toContain('FROM SHANGHAI, CHINA TO HAMBURG');
  });

  it('BC 受益人证明：信用证引用/申请人/声明双语/签章', () => {
    const html = renderBeneficiaryCertificateBody(makeCustomsDocSet() as any, EXPORTER);
    expect(html).toContain("BENEFICIARY'S CERTIFICATE");
    expect(html).toContain('受益人证明');
    expect(html).toContain('LC-2026-88 issued by Deutsche Bank dated 2026-07-01');
    expect(html).toContain('ACME GmbH'); // lc.applicant
    expect(html).toContain('HEREBY CERTIFY');
    expect(html).toContain('全套副本装运单据');
    expect(html).toContain("Beneficiary's Authorized Signature");
  });

  it('BC 无信用证 → 退回客户名兜底', () => {
    const data = makeCustomsDocSet({ extras: { originCriterion: 'P', insurance: (makeCustomsDocSet() as any).extras.insurance } });
    const html = renderBeneficiaryCertificateBody(data as any, EXPORTER);
    expect(html).toContain('ACME GmbH'); // parties.customer.name
    expect(html).not.toContain('LC-2026-88');
  });

  it('isShipmentDocKind 出运制单集合（CI/PL/CO/BL/FORMA/INS/BC）', () => {
    for (const k of ['CI', 'PL', 'CO', 'BL', 'FORMA', 'INS', 'BC'] as const) {
      expect(isShipmentDocKind(k)).toBe(true);
    }
    expect(isShipmentDocKind('IR')).toBe(false);
    expect(isShipmentDocKind('MERGED_PL')).toBe(false);
    // 注册表全量可用（render-by-shipment 端点直接渲染）
    expect(SERVER_DOC_TEMPLATES.CI.title).toContain('商业发票');
    expect(SERVER_DOC_TEMPLATES.FORMA.title).toContain('普惠制');
    expect(SERVER_DOC_TEMPLATES.BC.title).toContain('受益人证明');
  });

  it('serverKindForType：CommercialInvoice → CI（快照版；财务回链优先级由 lifecycleService 决定）', () => {
    expect(serverKindForType('CommercialInvoice')).toBe('CI');
  });
});

// ── B7 报价单模板（QUOT：真源回链式，业务实时装配） ──

import { renderQuotationBody, loadQuotationDocData } from '../docTemplates/quotation';

const QT_DATA = {
  qt: {
    id: 'QT_1',
    quotationNumber: 'QT-20260822-001',
    status: 'Sent',
    currency: 'USD',
    totalAmount: 14400,
    issueDate: '2026-08-22',
    validUntil: '2026-09-21',
    deliveryTerms: 'FOB Shanghai',
    paymentTerms: 'T/T 30% deposit',
    salesperson: 'Wen',
    inquiryRef: 'INQ-88',
    notes: '含 3% 佣金',
    customerName: 'ACME GmbH',
    customerCode: 'CUS-0001',
  },
  lines: [
    { lineNumber: 1, fabricCode: 'FAB-001', description: 'Cotton Poplin 40x40', quantity: 12000, unit: 'YD', unitPrice: 1.2, amount: 14400, notes: '色卡 202', imageUrl: 'http://127.0.0.1:8081/api/uploads/quotations/qt-a.jpg' },
    { lineNumber: 2, fabricCode: null, description: 'Sewing Thread', quantity: 100, unit: 'PC', unitPrice: null, amount: null, notes: null, imageUrl: null },
  ],
};

describe('B7 renderQuotationBody', () => {
  it('渲染报价单标题/单号/双抬头/条款/行明细/合计/双签区', () => {
    const html = renderQuotationBody(QT_DATA as any, EXPORTER);
    expect(html).toContain('QUOTATION');
    expect(html).toContain('报 价 单');
    expect(html).toContain('QT-20260822-001');
    expect(html).toContain(EXPORTER.nameEn);
    expect(html).toContain('ACME GmbH');
    expect(html).toContain('CUS-0001');
    expect(html).toContain('Cotton Poplin 40x40');
    expect(html).toContain('FAB-001');
    expect(html).toContain('FOB Shanghai');
    expect(html).toContain('T/T 30% deposit');
    expect(html).toContain('TOTAL 总计 (USD)');
    expect(html).toContain("Seller's Signature 卖方签章");
    expect(html).toContain("Buyer's Confirmation 买方确认");
  });

  it('有图行渲染图片列与缩略图；无价行 → 单价/金额破折号占位', () => {
    const html = renderQuotationBody(QT_DATA as any, EXPORTER);
    expect(html).toContain('Photo 图片');
    expect(html).toContain('/api/uploads/quotations/qt-a.jpg');
    // 无价行（unitPrice null）不渲染数字，破折号占位
    expect(html).toContain('—');
  });

  it('全部行无图 → 不渲染图片列（版式向后兼容）', () => {
    const noImage = { qt: QT_DATA.qt, lines: QT_DATA.lines.map(l => ({ ...l, imageUrl: null })) };
    const html = renderQuotationBody(noImage as any, EXPORTER);
    expect(html).not.toContain('Photo 图片');
  });

  it('条款/备注/有效期缺失 → 条款区块保留标题但内容行不渲染；备注区不渲染', () => {
    const minimal = {
      qt: { ...QT_DATA.qt, validUntil: null, deliveryTerms: null, paymentTerms: null, notes: null, inquiryRef: null, salesperson: null, customerCode: null },
      lines: [],
    };
    const html = renderQuotationBody(minimal as any, EXPORTER);
    // 条款区标题与前端原版一致始终渲染（版式稳定），但内容行全部缺席
    expect(html).toContain('Terms &amp; Conditions');
    expect(html).not.toContain('Delivery 交货');
    expect(html).not.toContain('Payment 付款');
    expect(html).not.toContain('Validity 有效期');
    expect(html).not.toContain('Valid Until');
    expect(html).not.toContain('Remarks 备注');
    expect(html).not.toContain('Inquiry Ref');
  });
});

describe('B7 loadQuotationDocData', () => {
  function makePrisma(overrides: Record<string, any> = {}): PrismaClient {
    return {
      quotation: { findUnique: vi.fn().mockResolvedValue(overrides.qt ?? null) },
    } as any;
  }

  it('装配报价头 + 行明细（Decimal→number；相对图片 URL → 绝对 URL）', async () => {
    const prisma = makePrisma({
      qt: {
        id: 'QT_1', quotationNumber: 'QT-20260822-001', status: 'Sent', deletedAt: null,
        currency: 'USD', totalAmount: 14400, issueDate: '2026-08-22', validUntil: null,
        deliveryTerms: null, paymentTerms: null, salesperson: null, inquiryRef: null, notes: null,
        customerName: 'ACME GmbH', customerCode: null, customerRelationId: 'rel_1',
        lines: [
          { lineNumber: 1, fabricCode: 'FAB-001', description: 'Poplin', quantity: 12000, unit: 'YD', unitPrice: 1.2, amount: 14400, notes: null, imageUrl: '/api/uploads/quotations/qt-a.jpg' },
          { lineNumber: 2, fabricCode: null, description: 'Thread', quantity: 100, unit: 'PC', unitPrice: 0.5, amount: 50, notes: null, imageUrl: 'https://cdn.example.com/img.jpg' },
        ],
      },
    });
    const data = await loadQuotationDocData(prisma, 'QT_1');
    expect(data).not.toBeNull();
    expect(data!.qt.quotationNumber).toBe('QT-20260822-001');
    expect(data!.lines).toHaveLength(2);
    // 相对路径 → 绝对 URL（PDF 管线 page.setContent 无基址）
    expect(data!.lines[0].imageUrl).toMatch(/^https?:\/\/.+\/api\/uploads\/quotations\/qt-a\.jpg$/);
    // 外链保持原样
    expect(data!.lines[1].imageUrl).toBe('https://cdn.example.com/img.jpg');
  });

  it('报价单不存在/软删 → null（调用方 404）', async () => {
    expect(await loadQuotationDocData(makePrisma({ qt: null }), 'QT_missing')).toBeNull();
    expect(await loadQuotationDocData(makePrisma({ qt: { id: 'QT_1', deletedAt: 1 } }), 'QT_1')).toBeNull();
  });

  it('QUOT 注册表映射 + loadData 无 sourceRef fail-closed', async () => {
    expect(serverKindForType('Quotation')).toBe('QUOT');
    expect(SERVER_DOC_TEMPLATES.QUOT.title).toContain('报价单');
    expect(await SERVER_DOC_TEMPLATES.QUOT.loadData({} as PrismaClient, { id: 'TD_1', type: 'Quotation', sourceRef: null })).toBeNull();
  });
});

// ── B8 订单确认书 + 合同模板（OC 真源回链 / CONTRACT 多订单组合） ──

import { renderOrderConfirmationBody, loadOrderConfirmationDocData } from '../docTemplates/orderConfirmation';
import { renderContractBody } from '../docTemplates/contract';
import { assembleContractData, COMPOSITE_DOC_KINDS, isCompositeDocKind } from '../../customs/compositeDocumentService';

const OC_DATA = {
  order: {
    id: 'ord_1', poNumber: 'CUS-PO-2026-77', customer: 'ACME GmbH', status: 'Confirmed',
    dueDate: '2026-09-30', currency: 'USD', orderAmount: 16850.5,
    deliveryTerms: 'FOB Shanghai', paymentTerms: 'T/T 30% deposit',
    salesContractNumber: 'SC-2026-018', finalContractNumber: null,
    shipToAddress: 'Hamburg Warehouse, Germany', createdAt: Date.UTC(2026, 7, 22),
  },
  customer: { name: 'ACME', englishName: 'ACME GmbH', chineseName: '艾克米', contactInfo: 'Tel: +49 40 123456' },
  lines: [
    { lineNumber: 1, itemNo: 'ITEM-1', description: 'Cotton Poplin 40x40', quantity: 12000, unit: 'YD', unitPrice: 1.2, netValue: 14400, deliveryDate: '2026-09-15', tolerancePercent: 5 },
    { lineNumber: 2, itemNo: 'ITEM-2', description: 'Sewing Thread', quantity: 500, unit: 'PC', unitPrice: 4.9, netValue: 2450.5, deliveryDate: null, tolerancePercent: 0 },
  ],
};

describe('B8 renderOrderConfirmationBody', () => {
  it('渲染 OC 标题/PO 号/合同号/双抬头/条款/明细/合计/双签区', () => {
    const html = renderOrderConfirmationBody(OC_DATA as any, EXPORTER);
    expect(html).toContain('ORDER CONFIRMATION');
    expect(html).toContain('订单确认书');
    expect(html).toContain('CUS-PO-2026-77');
    expect(html).toContain('SC-2026-018');
    expect(html).toContain(EXPORTER.nameEn);
    expect(html).toContain('ACME GmbH');
    expect(html).toContain('FOB Shanghai');
    expect(html).toContain('T/T 30% deposit');
    expect(html).toContain('Cotton Poplin 40x40');
    expect(html).toContain('±5%'); // 溢短装容差
    expect(html).toContain('TOTAL 合计');
    expect(html).toContain('Seller 卖方签章');
  });

  it('无 poNumber → 合同号回落，仍可渲染', () => {
    const noPo = { ...OC_DATA, order: { ...OC_DATA.order, poNumber: null, salesContractNumber: 'SC-2026-019' } };
    const html = renderOrderConfirmationBody(noPo as any, EXPORTER);
    expect(html).toContain('SC-2026-019');
  });
});

describe('B8 loadOrderConfirmationDocData', () => {
  function makePrisma(overrides: Record<string, any> = {}): PrismaClient {
    return {
      order: { findUnique: vi.fn().mockResolvedValue(overrides.order ?? null) },
      relation: { findUnique: vi.fn().mockResolvedValue(overrides.relation ?? null) },
    } as any;
  }

  it('装配订单头 + 行明细 + 客户档案（createdAt 毫秒时间戳 → 确认日期）', async () => {
    const prisma = makePrisma({
      order: {
        id: 'ord_1', poNumber: 'CUS-PO-77', customer: 'ACME', status: 'Confirmed', deletedAt: null,
        dueDate: '2026-09-30', currency: 'USD', salesCurrency: null, quoteAmount: 16850.5,
        deliveryTerms: 'FOB', paymentTerms: null, salesContractNumber: 'SC-1', finalContractNumber: null,
        shipToName: 'Hamburg WH', shipToAddress1: 'Street 1', shipToAddress2: null, shipToCountry: 'DE',
        customerRelationId: 'rel_1', createdAt: BigInt(Date.UTC(2026, 7, 22)),
        lines: [
          { lineNumber: 1, itemNo: 'A', description: 'Poplin', quantity: 100, unit: 'YD', unitPrice: 1.2, netValue: 120, deliveryDate: null, tolerancePercent: 5 },
        ],
      },
      relation: { name: 'ACME', englishName: 'ACME GmbH', chineseName: null, contactInfo: null },
    });
    const data = await loadOrderConfirmationDocData(prisma, 'ord_1');
    expect(data).not.toBeNull();
    expect(data!.order.currency).toBe('USD');
    expect(data!.order.shipToAddress).toBe('Hamburg WH, Street 1, DE');
    expect(data!.customer?.englishName).toBe('ACME GmbH');
    expect(data!.lines[0].netValue).toBe(120);
  });

  it('订单不存在/软删 → null（调用方 404）', async () => {
    expect(await loadOrderConfirmationDocData(makePrisma({ order: null }), 'ord_missing')).toBeNull();
    expect(await loadOrderConfirmationDocData(makePrisma({ order: { id: 'ord_1', deletedAt: 1 } }), 'ord_1')).toBeNull();
  });

  it('OC 注册表映射 + loadData 无 sourceRef fail-closed', async () => {
    expect(serverKindForType('OrderConfirmation')).toBe('OC');
    expect(SERVER_DOC_TEMPLATES.OC.title).toContain('订单确认书');
    expect(await SERVER_DOC_TEMPLATES.OC.loadData({} as PrismaClient, { id: 'TD_1', type: 'OrderConfirmation', sourceRef: null })).toBeNull();
  });
});

describe('B8 CONTRACT（多订单合并合同）', () => {
  const CONTRACT_DATA = {
    contractNumber: 'SC-20260822-2',
    contractDate: '2026-08-22',
    customer: { name: 'ACME', englishName: 'ACME GmbH', chineseName: null, contactInfo: null },
    orders: [
      { index: 1, orderId: 'ord_1', poNumber: 'PO-A', customer: 'ACME GmbH', currency: 'USD', orderAmount: 14400, dueDate: '2026-09-30', deliveryTerms: 'FOB Shanghai', paymentTerms: 'T/T', salesContractNumber: null, finalContractNumber: 'SC-88', lineCount: 1 },
      { index: 2, orderId: 'ord_2', poNumber: 'PO-B', customer: 'ACME GmbH', currency: 'USD', orderAmount: 2450.5, dueDate: '2026-10-15', deliveryTerms: 'FOB Shanghai', paymentTerms: 'T/T', salesContractNumber: null, finalContractNumber: null, lineCount: 1 },
    ],
    lines: [
      { lineNumber: 1, orderIndex: 1, itemNo: 'ITEM-1', description: 'Poplin', quantity: 12000, unit: 'YD', unitPrice: 1.2, netValue: 14400 },
      { lineNumber: 2, orderIndex: 2, itemNo: 'ITEM-2', description: 'Thread', quantity: 500, unit: 'PC', unitPrice: 4.9, netValue: 2450.5 },
    ],
    totals: { currency: 'USD', amount: 16850.5, quantity: 12500 },
  };

  it('渲染合同标题/合同号/订单一览/合并明细（O# 来源标注）/合计/双签', () => {
    const html = renderContractBody(CONTRACT_DATA as any, EXPORTER);
    expect(html).toContain('SALES CONTRACT');
    expect(html).toContain('销售合同');
    expect(html).toContain('SC-20260822-2');
    expect(html).toContain('Order Summary 订单一览');
    expect(html).toContain('PO-A');
    expect(html).toContain('PO-B');
    expect(html).toContain('Contract Lines 合并明细');
    expect(html).toContain('>O1<');
    expect(html).toContain('>O2<');
    expect(html).toContain('TOTAL 合计');
    expect(html).toContain('16,850.50 USD');
    expect(html).toContain('Seller 卖方签章');
    expect(html).toContain('Buyer 买方签章');
  });

  it('★★ 2026-09-29：条款 2/3/5/8 印**真实值**（不是「未载明」）——保险/索赔期/争议解决/口岸', () => {
    const withTerms = {
      ...CONTRACT_DATA,
      orders: CONTRACT_DATA.orders.map((o, i) => ({
        ...o,
        shipmentDate: '2026-10-20',
        insuranceMode: '出卖人投保 110%',
        claimPeriodDays: i === 0 ? 30 : 60,
        disputeResolution: '提交中国国际经济贸易仲裁委员会仲裁',
        portOfLoading: 'SHANGHAI',
        portOfDischarge: 'HAMBURG',
      })),
    };
    const html = renderContractBody(withTerms as any, EXPORTER);
    /** 按条款号取出该条正文（渲染形态：`<div><strong>N. 标题:</strong> 正文</div>`） */
    const clauseBody = (no: number): string => {
      const m = html.match(new RegExp(`<div><strong>${no}\\. [^<]*:</strong> ([\\s\\S]*?)</div>`));
      expect(m, `条款 ${no} 未渲染`).not.toBeNull();
      return m![1];
    };
    const NA = '未载明（本合同未记录该项，请以买卖双方书面确认为准）';

    // ② 口岸：从运单取，印「装货港 → 目的港」
    expect(clauseBody(2)).toBe('SHANGHAI → HAMBURG');
    // ③ 保险：印真实值
    expect(clauseBody(3)).toBe('出卖人投保 110%');
    // ⑤ 索赔期：天数印真实值（两单不同 ⇒ 都出现，升序）
    expect(clauseBody(5)).toBe('货到目的口岸 30 天 / 60 天内提出，凭公证机构检验报告');
    // ⑧ 争议解决：印真实值
    expect(clauseBody(8)).toBe('提交中国国际经济贸易仲裁委员会仲裁');
    // ★ 这四条一条都不许落回「未载明」
    for (const no of [2, 3, 5, 8]) expect(clauseBody(no)).not.toBe(NA);
  });

  it('★ 反面对照：四项都取不到 ⇒ 老老实实印「未载明」，不许编', () => {
    // CONTRACT_DATA 的 orders 没有这五个字段（= 迁移前的老形状 / 未录）
    const html = renderContractBody(CONTRACT_DATA as any, EXPORTER);
    const clauseBody = (no: number): string => {
      const m = html.match(new RegExp(`<div><strong>${no}\\. [^<]*:</strong> ([\\s\\S]*?)</div>`));
      return m ? m![1] : '';
    };
    const NA = '未载明（本合同未记录该项，请以买卖双方书面确认为准）';
    // 2/3/5/8 四条全部老实印「未载明」
    for (const no of [2, 3, 5, 8]) {
      expect(clauseBody(no), `条款 ${no} 应在无数据时印「未载明」`).toBe(NA);
    }
    // ★ 不许出现任何编造的值
    expect(html).not.toContain('出卖人投保');
    expect(html).not.toContain('仲裁委员会');
  });

  it('CONTRACT 入组合类型集合 + 注册表', () => {
    expect(isCompositeDocKind('CONTRACT')).toBe(true);
    expect(COMPOSITE_DOC_KINDS).toContain('CONTRACT');
    expect(SERVER_DOC_TEMPLATES.CONTRACT.title).toContain('销售合同');
  });

  it('assembleContractData：≥2 校验 + 合同号取首个 finalContractNumber + 行级金额求和', async () => {
    const makeOrder = (id: string, poNumber: string, finalContractNumber: string | null, netValues: number[]) => ({
      id, poNumber, customer: 'ACME', deletedAt: null,
      currency: null, salesCurrency: 'USD', quoteAmount: netValues.reduce((a, b) => a + b, 0),
      dueDate: null, deliveryTerms: 'FOB', paymentTerms: null,
      salesContractNumber: null, finalContractNumber, customerRelationId: null,
      lines: netValues.map((nv, i) => ({ lineNumber: i + 1, itemNo: `I${i + 1}`, description: 'X', quantity: 1, unit: 'PC', unitPrice: nv, netValue: nv })),
    });
    const prisma = {
      order: { findUnique: vi.fn().mockImplementation(async ({ where }: any) => {
        if (where.id === 'ord_1') return makeOrder('ord_1', 'PO-A', 'SC-88', [100]);
        if (where.id === 'ord_2') return makeOrder('ord_2', 'PO-B', null, [50.5]);
        return null;
      }) },
      relation: { findUnique: vi.fn().mockResolvedValue(null) },
      // ★ 2026-09-29：合同条款要用的装运口岸在**运单**上 ⇒ 装配处会查一次 shipment。
      //   mock 原先只有 order/relation（写它时装配还不查运单）⇒ 补上，返回空表示「没有运单」
      //   （口岸回落成 null，模板印「未载明」—— 这正是要测的诚实路径）。
      shipment: { findMany: vi.fn().mockResolvedValue([]) },
    } as any;

    // 单订单 → 拒绝（引导走 OC）
    await expect(assembleContractData(prisma, ['ord_1'])).rejects.toThrow('至少需要 2 个订单');
    // 任一订单不存在 → fail-closed
    await expect(assembleContractData(prisma, ['ord_1', 'missing'])).rejects.toThrow('不存在');

    const data = await assembleContractData(prisma, ['ord_1', 'ord_2']);
    expect(data.contractNumber).toBe('SC-88'); // 首个非空 finalContractNumber
    expect(data.orders).toHaveLength(2);
    expect(data.lines).toHaveLength(2);
    expect(data.lines[1].orderIndex).toBe(2); // 来源订单序号标注
    expect(data.totals.amount).toBe(150.5); // 行级 netValue 求和
  });
});

// ── B9 客户对账单模板（STMT：财务域报表，多币种分节） ──

import { renderStatementBody } from '../docTemplates/statement';

const STMT_DATA = {
  customerRelationId: 'REL_001',
  customerName: 'ACME GmbH',
  from: '2026-08-01',
  to: '2026-08-31',
  sections: [
    {
      currency: 'USD',
      openingBalance: 12000,
      closingBalance: 14400,
      transactions: [
        { date: '2026-08-05', kind: 'invoice', number: 'INV-2026-001', debit: 14400, credit: 0, balance: 26400 },
        { date: '2026-08-20', kind: 'receipt', number: 'RCP-2026-009', debit: 0, credit: 12000, balance: 14400 },
      ],
    },
    {
      currency: 'EUR',
      openingBalance: 0,
      closingBalance: 0,
      transactions: [],
    },
  ],
};

describe('B9 renderStatementBody', () => {
  it('渲染对账单标题/客户/期间/多币种分节/期初期末/流水/双签', () => {
    const html = renderStatementBody(STMT_DATA as any, EXPORTER);
    expect(html).toContain('STATEMENT OF ACCOUNT');
    expect(html).toContain('客户对账单');
    expect(html).toContain('ACME GmbH');
    expect(html).toContain('2026-08-01 ~ 2026-08-31');
    expect(html).toContain('USD');
    expect(html).toContain('EUR');
    expect(html).toContain('Opening Balance 期初余额');
    expect(html).toContain('Closing Balance 期末余额');
    expect(html).toContain('INV-2026-001');
    expect(html).toContain('RCP-2026-009');
    expect(html).toContain('Invoice 发票');
    expect(html).toContain('Receipt 收款');
    expect(html).toContain('14,400.00 USD');
    expect(html).toContain('Customer Confirmation 客户确认');
  });

  it('空期间流水 → 「本期间无交易」占位；全空 sections → 无账务记录占位', () => {
    const html = renderStatementBody(STMT_DATA as any, EXPORTER);
    expect(html).toContain('No transactions in period 本期间无交易');
    const empty = { ...STMT_DATA, sections: [] };
    const html2 = renderStatementBody(empty as any, EXPORTER);
    expect(html2).toContain('无账务记录');
  });

  it('STMT 注册表登记（周期性报表，finance 路由直喂数据）', () => {
    expect(SERVER_DOC_TEMPLATES.STMT.title).toContain('客户对账单');
  });
});

// ── B11 结构收编：AWB 空运单 + FIN_CI 财务真源注册 ──

import { renderAirWaybillBody } from '../docTemplates/customsDocs';

describe('B11 renderAirWaybillBody', () => {
  it('渲染空运单标题/航班/起降机场/主分单号/明细合计/双签；CIF → PREPAID', () => {
    const data = makeCustomsDocSet({});
    data.shipment.shippingMethod = 'AIR';
    data.shipment.vesselOrFlight = 'CA1234';
    const html = renderAirWaybillBody(data, EXPORTER);
    expect(html).toContain('AIR WAYBILL');
    expect(html).toContain('空运单补料');
    expect(html).toContain('AWB DRAFT-SHP-2026-0001');
    expect(html).toContain('CA1234');
    expect(html).toContain('Flight No. 航班号');
    expect(html).toContain('Airport of Departure 起运机场');
    expect(html).toContain('SHANGHAI');
    expect(html).toContain('Airport of Destination 到达机场');
    expect(html).toContain('HAMBURG');
    expect(html).toContain('MAWB No. 主单号');
    expect(html).toContain('FREIGHT PREPAID'); // customs 基线 CIF 条款
    expect(html).toContain('Issuing Carrier 签发承运人');
  });

  it('非 AIR 运单 → 处理信息区附核对提示（不误拦跨方式打印）', () => {
    const data = makeCustomsDocSet({});
    data.shipment.shippingMethod = 'SEA';
    const html = renderAirWaybillBody(data, EXPORTER);
    expect(html).toContain('运输方式非 AIR');
  });

  it('AWB 入出运制单集合（render-by-shipment 可渲染）', () => {
    expect(isShipmentDocKind('AWB')).toBe(true);
  });
});

describe('B11 FIN_CI 注册（财务真源完整文档模板）', () => {
  it('FIN_CI 已注册且走 renderDocument 形态（无 sourceRef → null fail-closed）', async () => {
    expect(SERVER_DOC_TEMPLATES.FIN_CI.title).toContain('财务真源');
    const html = await SERVER_DOC_TEMPLATES.FIN_CI.renderDocument!(
      {} as any,
      { id: 'TD_1', type: 'CommercialInvoice', sourceRef: null },
      {},
    );
    expect(html).toBeNull();
  });
});

// ── B12 收尾：xlsxExport 空工作簿兜底（生产验证发现：对账单无账务记录 → buildXlsx([]) 500） ──

import { buildXlsx } from '../xlsxExport';

describe('buildXlsx 空数据兜底', () => {
  it('sheets 为空 → 合成「无数据」占位 sheet（不再抛 Workbook is empty）', () => {
    const buffer = buildXlsx([]);
    expect(buffer.length).toBeGreaterThan(100); // 合法 xlsx zip 包
  });

  it('正常多 sheet 构建不受影响', () => {
    const buffer = buildXlsx([
      { name: 'S1', columnLabels: ['A'], columns: ['a'], rows: [{ a: 1 }] },
      { name: 'S2', columnLabels: ['B'], columns: ['b'], rows: [{ b: 'x' }] },
    ]);
    expect(buffer.length).toBeGreaterThan(100);
  });
});

// ── 批次 H2：IC 检验证书 / PC 植检证书 / OTHER 通用单据模板（此前三类只能登记壳出不了文件） ──

import { renderInspectionCertificateBody, renderPhytosanitaryCertBody, renderOtherTradeDocumentBody } from '../docTemplates/customsDocs';

describe('批次 H2 检验证书 / 植检证书 / 通用单据模板', () => {
  it('类型映射：InspectionCert→IC / PhytosanitaryCert→PC / Other→OTHER 且模板已注册', () => {
    expect(serverKindForType('InspectionCert')).toBe('IC');
    expect(serverKindForType('PhytosanitaryCert')).toBe('PC');
    expect(serverKindForType('Other')).toBe('OTHER');
    expect(SERVER_DOC_TEMPLATES.IC.title).toContain('检验证书');
    expect(SERVER_DOC_TEMPLATES.PC.title).toContain('植检证书');
    expect(SERVER_DOC_TEMPLATES.OTHER.title).toContain('通用');
  });

  it('IC 检验证书：标题/双方/受检货物/证明声明/原产国', () => {
    const html = renderInspectionCertificateBody(makeCustomsDocSet() as any, EXPORTER);
    expect(html).toContain('INSPECTION CERTIFICATE');
    expect(html).toContain('检验证书');
    expect(html).toContain('IC-SHP-2026-0001');
    expect(html).toContain('INV-2026-001');
    expect(html).toContain('BAMBOOK TRADING CO., LTD.');
    expect(html).toContain('ACME GmbH');
    expect(html).toContain('Men Cotton Shirt');
    expect(html).toContain('6205.20');
    expect(html).toContain('WE HEREBY CERTIFY');
    expect(html).toContain('CHINA');
    expect(html).toContain('Inspector 检验人');
  });

  it('PC 植检证书：IPPC 声明/出口商/入境口岸/产地/除害处理占位', () => {
    const html = renderPhytosanitaryCertBody(makeCustomsDocSet() as any, EXPORTER);
    expect(html).toContain('PHYTOSANITARY CERTIFICATE');
    expect(html).toContain('植物检疫证书');
    expect(html).toContain('PC-SHP-2026-0001');
    expect(html).toContain('BAMBOOK TRADING CO., LTD.');
    expect(html).toContain('ACME GmbH');
    expect(html).toContain('quarantine pests');
    expect(html).toContain('GERMANY'); // customs.destinationCountry → 入境口岸
    expect(html).toContain('Place of origin 产地');
    expect(html).toContain('REPUBLIC OF CHINA'); // esc 转义撇号，不断言完整串
    expect(html).toContain('除害处理');
    expect(html).toContain('Men Cotton Shirt');
  });

  it('OTHER 运单快照版：通用版式含双方/运输/货物/合计', () => {
    const html = renderOtherTradeDocumentBody({ source: 'set', set: makeCustomsDocSet() as any }, EXPORTER);
    expect(html).toContain('TRADE DOCUMENT');
    expect(html).toContain('外贸单据（通用）');
    expect(html).toContain('DOC-SHP-2026-0001');
    expect(html).toContain('SHANGHAI');
    expect(html).toContain('HAMBURG');
    expect(html).toContain('Men Cotton Shirt');
    expect(html).toContain('20,000.00');
    expect(html).toContain('Handle with care'); // shipment.notes
  });

  it('OTHER 手工登记壳版：登记字段渲染（无快照也能出文件）', () => {
    const html = renderOtherTradeDocumentBody({
      source: 'doc',
      doc: {
        documentNumber: 'DOC-2026-0001', issueDate: '2026-08-28', expiryDate: null,
        consignor: 'BAMBOOK', consignee: 'ACME GmbH',
        portOfLoading: 'SHANGHAI', portOfDischarge: 'HAMBURG',
        totalAmount: 1234.5, currency: 'USD', issuedBy: null, notes: 'Test note 换行\n第二行',
      },
    }, EXPORTER);
    expect(html).toContain('TRADE DOCUMENT');
    expect(html).toContain('DOC-2026-0001');
    expect(html).toContain('ACME GmbH');
    expect(html).toContain('1,234.50 USD');
    expect(html).toContain('Test note 换行<br>第二行');
  });

  it('OTHER loadData：无快照 → 回落 TradeDocument 行（BigInt/Decimal 转 number）；行不存在 → null', async () => {
    const prisma: any = {
      documentVersion: { findFirst: async () => null },
      tradeDocument: {
        findFirst: async ({ where }: any) => (where.id === 'TD_1'
          ? { id: 'TD_1', documentNumber: 'DOC-2026-0002', totalAmount: 100n, createdAt: 1n }
          : null),
      },
    };
    const data = await SERVER_DOC_TEMPLATES.OTHER.loadData(prisma, { id: 'TD_1', type: 'Other', sourceRef: null });
    expect(data.source).toBe('doc');
    expect(data.doc.documentNumber).toBe('DOC-2026-0002');
    expect(typeof data.doc.totalAmount).toBe('number');
    expect(typeof data.doc.createdAt).toBe('number');
    expect(await SERVER_DOC_TEMPLATES.OTHER.loadData(prisma, { id: 'TD_NOPE', type: 'Other', sourceRef: null })).toBeNull();
  });

  it('OTHER loadData：有 documentSet 快照 → 优先快照版式（与 IC/PC 同口径）', async () => {
    const prisma: any = {
      documentVersion: { findFirst: async () => ({ content: { documentSet: { shipment: { shipmentNumber: 'SHP-1' } } } }) },
      tradeDocument: { findFirst: async () => null },
    };
    const data = await SERVER_DOC_TEMPLATES.OTHER.loadData(prisma, { id: 'TD_2', type: 'Other', sourceRef: null });
    expect(data.source).toBe('set');
    expect(data.set.shipment.shipmentNumber).toBe('SHP-1');
  });
});

// ────────────────────────────────────────────────────────────────
// ★ E 批（2026-09-26）：对外单据上的「订单金额」必须等于明细行合计
//
// 病形：OC 的「TOTAL 合计」格与合同的「Amount 金额」列直抄主档 `quoteAmount`，
//       而同页明细行渲染的是 `netValue` ⇒ 一张 `totalNet ≠ quoteAmount` 的单，
//       客户手上的 PDF 两个数对不上（判据源 docs/S4验收结论与新增项-2026-09-26.md §F1-a）。
// 分工：文本尺见 `server/src/__tests__/orderAmountTruth.test.ts` ⑤（E-1/E-2）；
//       下面这几例钉的是**装配之后纸面上真的相等**——文本尺看不见数据流，这一层只能靠行为。
// ────────────────────────────────────────────────────────────────
describe('E 批：对外单据金额 = 明细行合计（不是主档报价额）', () => {
  // 一张「改价只动了主档报价额」的单：明细行合计 13,000，主档三列都是 16,850.5
  const DIVERGENT = {
    id: 'ord_div', poNumber: 'CUS-PO-DIV', customer: 'ACME', status: 'Confirmed', deletedAt: null,
    dueDate: '2026-11-30', currency: 'USD', salesCurrency: null,
    quoteAmount: 16850.5, totalNet: 16850.5, contractAmount: 16850.5,
    deliveryTerms: 'FOB', paymentTerms: null, salesContractNumber: null, finalContractNumber: null,
    shipToName: null, shipToAddress1: null, shipToAddress2: null, shipToCountry: null,
    customerRelationId: null, createdAt: BigInt(Date.UTC(2026, 8, 1)),
    lines: [
      { lineNumber: 1, itemNo: 'A', description: 'Poplin', quantity: 10000, unit: 'YD', unitPrice: 1, netValue: 10000, deliveryDate: null, tolerancePercent: null },
      { lineNumber: 2, itemNo: 'B', description: 'Thread', quantity: 600, unit: 'PC', unitPrice: 5, netValue: 3000, deliveryDate: null, tolerancePercent: null },
    ],
  };
  const stubPrisma = (order: any) => ({
    order: { findUnique: async (args: any) => ({ ...order, id: args?.where?.id ?? order.id }) },
    relation: { findUnique: async () => null },
    // ★ 2026-09-29：assembleContractData 现在按 orderId 查运单取口岸 ⇒ 补 shipment。
    //   默认返回空（= 这些单没有运单），口岸为 null、模板印「未载明」。
    shipment: { findMany: async () => [] },
  } as any);
  const moneyOf = (s: string) => Number(s.replace(/,/g, ''));

  it('装配：主档报价额与明细行分叉时，orderAmount 取明细行合计（① 绝对优先）', async () => {
    const data = await loadOrderConfirmationDocData(stubPrisma(DIVERGENT), 'ord_div');
    expect(data!.order.orderAmount).toBe(13000);
  });

  it('★ PDF 端到端：合计格给的是 13,000.00，整页不再出现报价额 16,850.50', async () => {
    const data = await loadOrderConfirmationDocData(stubPrisma(DIVERGENT), 'ord_div');
    const html = renderOrderConfirmationBody(data!, EXPORTER);
    expect(html).toContain('13,000.00 USD');
    expect(html, '旧写法会把报价额印进合计格 ⇒ 同一页两个数').not.toContain('16,850.50 USD');
  });

  it('★ 恒等式：TOTAL 合计 === 同页明细行 Amount 列逐格相加', async () => {
    const data = await loadOrderConfirmationDocData(stubPrisma(DIVERGENT), 'ord_div');
    const html = renderOrderConfirmationBody(data!, EXPORTER);
    const tbody = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));
    const lineVals = [...tbody.matchAll(/<td style="text-align:right">([\d,]+\.\d{2}) USD<\/td>/g)].map((m) => moneyOf(m[1]));
    const totalCell = html.slice(html.indexOf('<tfoot>')).match(/<td style="text-align:right">([\d,]+\.\d{2}) USD<\/td>/);
    expect(lineVals.length, '分母自检：明细行必须真的渲染出 2 格金额').toBe(2);
    expect(totalCell, 'TOTAL 格必须渲染出金额（不是「—」）').not.toBeNull();
    expect(lineVals.reduce((a, b) => a + b, 0)).toBe(moneyOf(totalCell![1]));
  });

  it('★ 合并合同：订单一览的「Amount 金额」也走真源，合计与明细行同源', async () => {
    const prisma = stubPrisma(DIVERGENT);
    const data = await assembleContractData(prisma, ['ord_a', 'ord_b']);
    expect(data.orders.map((o) => o.orderAmount)).toEqual([13000, 13000]);
    expect(data.totals.amount).toBe(26000); // Σ 明细行（两单各 13,000）
    const html = renderContractBody(data, EXPORTER);
    expect(html).not.toContain('16,850.50 USD');
    expect(html).toContain('13,000.00 USD');
  });

  it('★ 空值诚实：形状是「行没带金额列」（quoteAmount 在 schema 里 NOT NULL ⇒ 整行加载到不了这档），此时合计渲染「—」而不是 0.00', async () => {
    // 这是「装配时 select 被收窄 / 传进来的不是整行」的形状，不是「这张单金额为空」的业务形状
    const empty = { ...DIVERGENT, quoteAmount: null, totalNet: null, contractAmount: null, lines: [] };
    const data = await loadOrderConfirmationDocData(stubPrisma(empty), 'ord_div');
    expect(data!.order.orderAmount).toBeNull();
    const html = renderOrderConfirmationBody(data!, EXPORTER);
    expect(html).not.toContain('0.00 USD');
  });

  it('★ 反面对照：明细行与主档一致时（老单据的常态），合计不变', async () => {
    const ok = { ...DIVERGENT, quoteAmount: 13000, totalNet: 13000, contractAmount: 13000 };
    const data = await loadOrderConfirmationDocData(stubPrisma(ok), 'ord_div');
    expect(data!.order.orderAmount).toBe(13000);
  });
});
