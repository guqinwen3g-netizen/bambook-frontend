/**
 * 出运制单数据装配服务单元测试
 *
 * 覆盖：
 *   1. 运单不存在 → SHIPMENT_NOT_FOUND
 *   2. 完整装配：shipment lines + order lines 回退链（单价取自订单行、箱规取自装运行）
 *   3. 无装运行时回退订单行构造骨架
 *   4. 无订单/无报关单时仍返回可用骨架 + missing 提示
 *   5. 合计回退：行合计缺失时取 shipment/customs 级字段
 *   6. 收货方回退：无 consigneeRelation 时回退客户
 */

import { describe, expect, it, vi } from 'vitest';
import { assembleDocumentSetData } from '../documentSetService';

function makePrisma(overrides: Record<string, any> = {}) {
  return {
    shipment: {
      findUnique: vi.fn().mockResolvedValue(null),
      ...overrides.shipment,
    },
    shipmentLine: {
      findMany: vi.fn().mockResolvedValue([]),
      ...overrides.shipmentLine,
    },
    order: {
      findUnique: vi.fn().mockResolvedValue(null),
      ...overrides.order,
    },
    customsDeclaration: {
      findFirst: vi.fn().mockResolvedValue(null),
      ...overrides.customsDeclaration,
    },
    relation: {
      findUnique: vi.fn().mockResolvedValue(null),
      ...overrides.relation,
    },
    // 阶段 D / D4：关联信用证装配（受益人证明/保险单引用）
    letterOfCredit: {
      findFirst: vi.fn().mockResolvedValue(null),
      ...overrides.letterOfCredit,
    },
  } as any;
}

const BASE_SHIPMENT = {
  id: 'SHP_1',
  shipmentNumber: 'SHP-2026-001',
  status: 'Booked',
  type: 'Export',
  shippingMethod: 'Sea',
  vesselOrFlight: 'COSCO GLORY',
  voyageNumber: 'V.088E',
  portOfLoading: 'SHANGHAI',
  portOfDischarge: 'SURABAYA',
  containerNumber: 'CSNU1234567',
  sealNumber: 'SL-9988',
  bookingDate: '2026-08-01',
  etd: '2026-08-10',
  atd: null,
  eta: '2026-08-25',
  totalPackages: 100,
  grossWeight: '5200.5',
  netWeight: '5000',
  volume: '68.5',
  hsCode: '5407520000',
  customsDeclarationNumber: null,
  notes: null,
  orderId: 'ORD_1',
  customerRelationId: 'REL_C',
  carrierRelationId: 'REL_K',
  customerName: 'ACME TEXTILE',
  carrierName: 'COSCO',
  deletedAt: null,
};

describe('documentSetService · assembleDocumentSetData', () => {
  it('运单不存在 → SHIPMENT_NOT_FOUND', async () => {
    const prisma = makePrisma();
    const res = await assembleDocumentSetData(prisma, 'SHP_MISSING');
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('SHIPMENT_NOT_FOUND');
  });

  it('运单已软删 → SHIPMENT_NOT_FOUND', async () => {
    const prisma = makePrisma({
      shipment: { findUnique: vi.fn().mockResolvedValue({ ...BASE_SHIPMENT, deletedAt: 123 }) },
    });
    const res = await assembleDocumentSetData(prisma, 'SHP_1');
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('SHIPMENT_NOT_FOUND');
  });

  it('完整装配：装运行 + 订单行回退链正确解析', async () => {
    const prisma = makePrisma({
      shipment: { findUnique: vi.fn().mockResolvedValue(BASE_SHIPMENT) },
      shipmentLine: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'SHPL_1', shipmentId: 'SHP_1', lineNumber: 1, orderLineId: 'OL_1',
            productCode: 'FAB-001', productName: '100% POLYESTER SATIN',
            colorCode: null, quantity: 5000, unit: 'YD',
            cartons: 60, grossWeight: '3100', netWeight: '3000', volume: '40',
            hsCode: null, countryOfOrigin: 'CHINA',
          },
          {
            id: 'SHPL_2', shipmentId: 'SHP_1', lineNumber: 2, orderLineId: 'OL_2',
            productCode: 'FAB-002', productName: 'COTTON POPLIN',
            colorCode: null, quantity: 3000, unit: 'YD',
            cartons: 40, grossWeight: '2100.5', netWeight: '2000', volume: '28.5',
            hsCode: '5208520090', countryOfOrigin: null,
          },
        ]),
      },
      order: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'ORD_1', poNumber: 'PO-2026-001', customer: 'ACME TEXTILE',
          currency: 'USD', salesCurrency: 'USD',
          deliveryTerms: 'FOB SHANGHAI', paymentTerms: 'T/T 30 DAYS',
          salesContractNumber: 'SC-001', finalContractNumber: null,
          invoiceNumber: 'INV-001', invoiceDate: '2026-08-05',
          totalNet: '12500', quoteAmount: '12500',
          billToName: null, billToAddress: null, billToContact: null,
          consigneeName: null, consigneeAddress: null, consigneeContact: null,
          consigneeRelationId: null, customerAddress: null,
          lines: [
            { id: 'OL_1', lineNumber: 1, itemNo: 'IT-1', description: '100% POLYESTER SATIN', quantity: '5000', unit: 'YD', unitPrice: '1.5', netValue: '7500' },
            { id: 'OL_2', lineNumber: 2, itemNo: 'IT-2', description: 'COTTON POPLIN', quantity: '3000', unit: 'YD', unitPrice: '1.6667', netValue: '5000.1' },
          ],
        }),
      },
      customsDeclaration: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'CD_1', declarationNumber: '222520260001234567', declarationDate: '2026-08-08',
          declarationPort: 'SHANGHAI', tradeTerms: 'FOB', totalValue: '12500', currency: 'USD',
          originCountry: 'CHINA', destinationCountry: 'INDONESIA',
          consignee: 'ACME TEXTILE', consignor: 'PANDA',
          lines: [
            { id: 'CDL_1', lineNumber: 1, productName: '100% POLYESTER SATIN', hsCode: '5407520000', quantity: '5000', unit: 'YD', unitPrice: '1.5', totalAmount: '7500', grossWeight: null, netWeight: null, originCountry: 'CHINA', productCode: null },
            { id: 'CDL_2', lineNumber: 2, productName: 'COTTON POPLIN', hsCode: '5208520090', quantity: '3000', unit: 'YD', unitPrice: '1.6667', totalAmount: '5000.1', grossWeight: null, netWeight: null, originCountry: 'CHINA', productCode: null },
          ],
        }),
      },
      relation: {
        findUnique: vi.fn().mockImplementation(({ where }: any) => {
          if (where.id === 'REL_C') return Promise.resolve({ id: 'REL_C', englishName: 'ACME TEXTILE CO., LTD.', officialAddress: 'SURABAYA, INDONESIA', primaryContactName: 'Mr. Budi' });
          if (where.id === 'REL_K') return Promise.resolve({ id: 'REL_K', englishName: 'COSCO SHIPPING' });
          return Promise.resolve(null);
        }),
      },
    });

    const res = await assembleDocumentSetData(prisma, 'SHP_1');
    expect(res.ok).toBe(true);
    const d = res.data!;

    // 运单级字段
    expect(d.shipment.shipmentNumber).toBe('SHP-2026-001');
    expect(d.shipment.containerNumber).toBe('CSNU1234567');
    // 报关单号回退自 customs
    expect(d.shipment.customsDeclarationNumber).toBe('222520260001234567');

    // 行 1：hsCode 回退自报关行；单价/金额回退自订单行
    expect(d.lines).toHaveLength(2);
    expect(d.lines[0].description).toBe('100% POLYESTER SATIN');
    expect(d.lines[0].hsCode).toBe('5407520000');
    expect(d.lines[0].unitPrice).toBe(1.5);
    expect(d.lines[0].amount).toBe(7500);
    expect(d.lines[0].cartons).toBe(60);
    expect(d.lines[0].grossWeight).toBe(3100);
    expect(d.lines[1].hsCode).toBe('5208520090');
    expect(d.lines[1].originCountry).toBe('CHINA'); // 回退自报关行

    // 合计
    expect(d.totals.quantity).toBe(8000);
    expect(d.totals.amount).toBeCloseTo(12500.1, 4);
    expect(d.totals.cartons).toBe(100);
    expect(d.totals.grossWeight).toBeCloseTo(5200.5, 4);
    expect(d.totals.volume).toBeCloseTo(68.5, 4);
    expect(d.totals.currency).toBe('USD');

    // 当事方
    expect(d.parties.customer?.name).toBe('ACME TEXTILE CO., LTD.');
    expect(d.parties.customer?.address).toBe('SURABAYA, INDONESIA');
    expect(d.parties.consignee?.name).toBe('ACME TEXTILE'); // 报关单 consignee 快照优先于客户回退
    expect(d.parties.carrier?.name).toBe('COSCO SHIPPING');

    // 完整度：无缺失
    expect(d.missing).toHaveLength(0);
  });

  it('D2：订单条款与报关成交方式**不一致**时 → 不静默取其一，missing 报出告警', async () => {
    const prisma = makePrisma({
      shipment: { findUnique: vi.fn().mockResolvedValue(BASE_SHIPMENT) },
      shipmentLine: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'SHPL_1', shipmentId: 'SHP_1', lineNumber: 1, orderLineId: 'OL_1',
            productCode: 'FAB-001', productName: '100% POLYESTER SATIN',
            colorCode: null, quantity: 5000, unit: 'YD',
            cartons: 60, grossWeight: '3100', netWeight: '3000', volume: '40',
            hsCode: null, countryOfOrigin: 'CHINA',
          },
          {
            id: 'SHPL_2', shipmentId: 'SHP_1', lineNumber: 2, orderLineId: 'OL_2',
            productCode: 'FAB-002', productName: 'COTTON POPLIN',
            colorCode: null, quantity: 3000, unit: 'YD',
            cartons: 40, grossWeight: '2100.5', netWeight: '2000', volume: '28.5',
            hsCode: '5208520090', countryOfOrigin: null,
          },
        ]),
      },
      order: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'ORD_1', poNumber: 'PO-2026-001', customer: 'ACME TEXTILE',
          currency: 'USD', salesCurrency: 'USD',
          deliveryTerms: 'FOB SHANGHAI', paymentTerms: 'T/T 30 DAYS',
          salesContractNumber: 'SC-001', finalContractNumber: null,
          invoiceNumber: 'INV-001', invoiceDate: '2026-08-05',
          totalNet: '12500', quoteAmount: '12500',
          billToName: null, billToAddress: null, billToContact: null,
          consigneeName: null, consigneeAddress: null, consigneeContact: null,
          consigneeRelationId: null, customerAddress: null,
          lines: [
            { id: 'OL_1', lineNumber: 1, itemNo: 'IT-1', description: '100% POLYESTER SATIN', quantity: '5000', unit: 'YD', unitPrice: '1.5', netValue: '7500' },
            { id: 'OL_2', lineNumber: 2, itemNo: 'IT-2', description: 'COTTON POPLIN', quantity: '3000', unit: 'YD', unitPrice: '1.6667', netValue: '5000.1' },
          ],
        }),
      },
      customsDeclaration: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'CD_1', declarationNumber: '222520260001234567', declarationDate: '2026-08-08',
          declarationPort: 'SHANGHAI', tradeTerms: 'CIF', totalValue: '12500', currency: 'USD',
          originCountry: 'CHINA', destinationCountry: 'INDONESIA',
          consignee: 'ACME TEXTILE', consignor: 'PANDA',
          lines: [
            { id: 'CDL_1', lineNumber: 1, productName: '100% POLYESTER SATIN', hsCode: '5407520000', quantity: '5000', unit: 'YD', unitPrice: '1.5', totalAmount: '7500', grossWeight: null, netWeight: null, originCountry: 'CHINA', productCode: null },
            { id: 'CDL_2', lineNumber: 2, productName: 'COTTON POPLIN', hsCode: '5208520090', quantity: '3000', unit: 'YD', unitPrice: '1.6667', totalAmount: '5000.1', grossWeight: null, netWeight: null, originCountry: 'CHINA', productCode: null },
          ],
        }),
      },
      relation: {
        findUnique: vi.fn().mockImplementation(({ where }: any) => {
          if (where.id === 'REL_C') return Promise.resolve({ id: 'REL_C', englishName: 'ACME TEXTILE CO., LTD.', officialAddress: 'SURABAYA, INDONESIA', primaryContactName: 'Mr. Budi' });
          if (where.id === 'REL_K') return Promise.resolve({ id: 'REL_K', englishName: 'COSCO SHIPPING' });
          return Promise.resolve(null);
        }),
      },
    });

    const res = await assembleDocumentSetData(prisma, 'SHP_1');
    expect(res.ok).toBe(true);
    const d = res.data!;

    // 运单级字段
    expect(d.shipment.shipmentNumber).toBe('SHP-2026-001');
    expect(d.shipment.containerNumber).toBe('CSNU1234567');
    // 报关单号回退自 customs
    expect(d.shipment.customsDeclarationNumber).toBe('222520260001234567');

    // 行 1：hsCode 回退自报关行；单价/金额回退自订单行
    expect(d.lines).toHaveLength(2);
    expect(d.lines[0].description).toBe('100% POLYESTER SATIN');
    expect(d.lines[0].hsCode).toBe('5407520000');
    expect(d.lines[0].unitPrice).toBe(1.5);
    expect(d.lines[0].amount).toBe(7500);
    expect(d.lines[0].cartons).toBe(60);
    expect(d.lines[0].grossWeight).toBe(3100);
    expect(d.lines[1].hsCode).toBe('5208520090');
    expect(d.lines[1].originCountry).toBe('CHINA'); // 回退自报关行

    // 合计
    expect(d.totals.quantity).toBe(8000);
    expect(d.totals.amount).toBeCloseTo(12500.1, 4);
    expect(d.totals.cartons).toBe(100);
    expect(d.totals.grossWeight).toBeCloseTo(5200.5, 4);
    expect(d.totals.volume).toBeCloseTo(68.5, 4);
    expect(d.totals.currency).toBe('USD');

    // 当事方
    expect(d.parties.customer?.name).toBe('ACME TEXTILE CO., LTD.');
    expect(d.parties.customer?.address).toBe('SURABAYA, INDONESIA');
    expect(d.parties.consignee?.name).toBe('ACME TEXTILE'); // 报关单 consignee 快照优先于客户回退
    expect(d.parties.carrier?.name).toBe('COSCO SHIPPING');

    // D2：订单 FOB SHANGHAI（代码 FOB）vs 报关 CIF → 跨组不一致，应报 missing 告警
    //（且单据仍按订单条款出 —— 订单条款是商业合同依据）
    expect(d.missing.some(m => m.includes('不一致'))).toBe(true);
    expect(d.missing.some(m => m.includes('FOB') && m.includes('CIF'))).toBe(true);
  });

  it('无装运行 → 从订单行构造骨架（箱规留空）', async () => {
    const prisma = makePrisma({
      shipment: { findUnique: vi.fn().mockResolvedValue({ ...BASE_SHIPMENT, totalPackages: 50 }) },
      order: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'ORD_1', poNumber: 'PO-1', customer: 'ACME',
          currency: 'USD', salesCurrency: null,
          deliveryTerms: null, paymentTerms: null,
          salesContractNumber: null, finalContractNumber: null,
          invoiceNumber: null, invoiceDate: null,
          totalNet: '9000', quoteAmount: '9000',
          billToName: null, billToAddress: null, billToContact: null,
          consigneeName: null, consigneeAddress: null, consigneeContact: null,
          consigneeRelationId: null, customerAddress: null,
          lines: [
            { id: 'OL_1', lineNumber: 1, itemNo: 'IT-1', description: 'GREIGE FABRIC', quantity: '10000', unit: 'M', unitPrice: '0.9', netValue: '9000' },
          ],
        }),
      },
    });

    const res = await assembleDocumentSetData(prisma, 'SHP_1');
    expect(res.ok).toBe(true);
    const d = res.data!;
    expect(d.lines).toHaveLength(1);
    expect(d.lines[0].description).toBe('GREIGE FABRIC');
    expect(d.lines[0].quantity).toBe(10000);
    expect(d.lines[0].cartons).toBeNull(); // 箱规无来源
    expect(d.totals.cartons).toBe(50); // 回退 shipment.totalPackages
    expect(d.totals.grossWeight).toBeCloseTo(5200.5, 4); // 回退 shipment 级
    expect(d.missing).toContain('未关联报关单（缺少申报要素）');
  });

  it('无订单/无报关单 → 返回骨架 + missing 提示', async () => {
    const prisma = makePrisma({
      shipment: {
        findUnique: vi.fn().mockResolvedValue({ ...BASE_SHIPMENT, orderId: null, customerRelationId: null, carrierRelationId: null }),
      },
    });
    const res = await assembleDocumentSetData(prisma, 'SHP_1');
    expect(res.ok).toBe(true);
    const d = res.data!;
    expect(d.order).toBeNull();
    expect(d.customs).toBeNull();
    expect(d.lines).toHaveLength(0);
    expect(d.missing).toContain('未关联订单（缺少价格/条款来源）');
    expect(d.missing).toContain('无行明细（装运行与订单行均为空）');
    // 客户快照回退 shipment.customerName
    expect(d.parties.customer?.name).toBe('ACME TEXTILE');
    // 金额回退 null（无行无订单无报关）
    expect(d.totals.amount).toBeNull();
    expect(d.missing).toContain('缺少金额（订单行无单价/净值）');
  });

  it('收货方 Relation 存在时优先于客户回退', async () => {
    const prisma = makePrisma({
      shipment: { findUnique: vi.fn().mockResolvedValue(BASE_SHIPMENT) },
      order: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'ORD_1', poNumber: 'PO-1', customer: 'ACME',
          currency: 'USD', salesCurrency: null,
          deliveryTerms: null, paymentTerms: null,
          salesContractNumber: null, finalContractNumber: null,
          invoiceNumber: null, invoiceDate: null,
          totalNet: null, quoteAmount: null,
          billToName: null, billToAddress: null, billToContact: null,
          consigneeName: 'PT. MAJU BERSAMA', consigneeAddress: 'JAKARTA', consigneeContact: null,
          consigneeRelationId: 'REL_CONS', customerAddress: null,
          lines: [],
        }),
      },
      relation: {
        findUnique: vi.fn().mockImplementation(({ where }: any) => {
          if (where.id === 'REL_C') return Promise.resolve({ id: 'REL_C', englishName: 'ACME TEXTILE CO., LTD.' });
          if (where.id === 'REL_CONS') return Promise.resolve({ id: 'REL_CONS', englishName: 'PT. MAJU BERSAMA', officialAddress: 'JAKARTA UTARA' });
          return Promise.resolve(null);
        }),
      },
    });

    const res = await assembleDocumentSetData(prisma, 'SHP_1');
    expect(res.ok).toBe(true);
    expect(res.data!.parties.consignee?.name).toBe('PT. MAJU BERSAMA');
    expect(res.data!.parties.consignee?.address).toBe('JAKARTA UTARA');
    expect(res.data!.parties.customer?.name).toBe('ACME TEXTILE CO., LTD.');
  });

  // ── 阶段 D / D4：extras（Form A / 保险单 / 受益人证明） ──

  it('extras：默认原产地标准 P；FOB 条款不推断保额；无 LC → letterOfCredit 为 null', async () => {
    const prisma = makePrisma({
      shipment: { findUnique: vi.fn().mockResolvedValue(BASE_SHIPMENT) },
      order: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'ORD_1', poNumber: 'PO-1', customer: 'ACME',
          currency: 'USD', salesCurrency: null,
          deliveryTerms: 'FOB SHANGHAI', paymentTerms: null,
          salesContractNumber: null, finalContractNumber: null,
          invoiceNumber: null, invoiceDate: null,
          totalNet: '9000', quoteAmount: '9000',
          billToName: null, billToAddress: null, billToContact: null,
          consigneeName: null, consigneeAddress: null, consigneeContact: null,
          consigneeRelationId: null, customerAddress: null,
          lines: [
            { id: 'OL_1', lineNumber: 1, itemNo: 'IT-1', description: 'GREIGE', quantity: '10000', unit: 'M', unitPrice: '0.9', netValue: '9000' },
          ],
        }),
      },
    });
    const res = await assembleDocumentSetData(prisma, 'SHP_1');
    expect(res.ok).toBe(true);
    const ex = res.data!.extras;
    expect(ex.originCriterion).toBe('P');
    expect(ex.insurance.insuredAmount).toBeNull(); // FOB 卖方不投保
    expect(ex.insurance.coverage).toContain('ALL RISKS');
    expect(ex.letterOfCredit).toBeNull();
  });

  it('extras：CIF 条款按货值 ×110% 推断保额；LC 摘要装配', async () => {
    const prisma = makePrisma({
      shipment: {
        findUnique: vi.fn().mockResolvedValue({
          ...BASE_SHIPMENT,
          insuranceAmount: '68.75', insuranceCurrency: 'USD',
        }),
      },
      order: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'ORD_1', poNumber: 'PO-1', customer: 'ACME',
          currency: 'USD', salesCurrency: null,
          deliveryTerms: 'CIF SURABAYA', paymentTerms: 'L/C AT SIGHT',
          salesContractNumber: null, finalContractNumber: null,
          invoiceNumber: null, invoiceDate: null,
          totalNet: '12500', quoteAmount: '12500',
          billToName: null, billToAddress: null, billToContact: null,
          consigneeName: null, consigneeAddress: null, consigneeContact: null,
          consigneeRelationId: null, customerAddress: null,
          lines: [
            { id: 'OL_1', lineNumber: 1, itemNo: 'IT-1', description: 'SATIN', quantity: '5000', unit: 'YD', unitPrice: '2.5', netValue: '12500' },
          ],
        }),
      },
      letterOfCredit: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'LC_1', lcNumber: 'LC-2026-7788', issueBank: 'BANK CENTRAL ASIA',
          issueDate: '2026-07-20', applicant: 'PT. MAJU BERSAMA',
        }),
      },
    });
    const res = await assembleDocumentSetData(prisma, 'SHP_1');
    expect(res.ok).toBe(true);
    const ex = res.data!.extras;
    expect(ex.insurance.insuredAmount).toBe(13750); // 12500 × 1.1
    expect(ex.insurance.currency).toBe('USD');
    expect(ex.insurance.premium).toBe(68.75);
    expect(ex.insurance.premiumCurrency).toBe('USD');
    expect(ex.letterOfCredit?.lcNumber).toBe('LC-2026-7788');
    expect(ex.letterOfCredit?.issueBank).toBe('BANK CENTRAL ASIA');
    expect(ex.letterOfCredit?.applicant).toBe('PT. MAJU BERSAMA');
  });

  it('extras：CIF 但无货值 → 保额 null + missing 提示', async () => {
    const prisma = makePrisma({
      shipment: { findUnique: vi.fn().mockResolvedValue(BASE_SHIPMENT) },
      order: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'ORD_1', poNumber: 'PO-1', customer: 'ACME',
          currency: 'USD', salesCurrency: null,
          deliveryTerms: 'CIF SURABAYA', paymentTerms: null,
          salesContractNumber: null, finalContractNumber: null,
          invoiceNumber: null, invoiceDate: null,
          totalNet: null, quoteAmount: null,
          billToName: null, billToAddress: null, billToContact: null,
          consigneeName: null, consigneeAddress: null, consigneeContact: null,
          consigneeRelationId: null, customerAddress: null,
          lines: [],
        }),
      },
    });
    const res = await assembleDocumentSetData(prisma, 'SHP_1');
    expect(res.ok).toBe(true);
    expect(res.data!.extras.insurance.insuredAmount).toBeNull();
    expect(res.data!.missing).toContain('CIF/CIP 条款下缺少货值（无法推断投保金额）');
  });

  // ── 行级部分和不可作合计（P0-5：少算且不告警 = 报关/箱单差错风险） ──

  it('部分行缺毛净重/体积 → 合计回退运单级权威数据 + missing 告警（不再采用少算的部分和）', async () => {
    const prisma = makePrisma({
      shipment: {
        findUnique: vi.fn().mockResolvedValue({
          ...BASE_SHIPMENT, orderId: null, customerRelationId: null, carrierRelationId: null,
        }),
      },
      shipmentLine: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'SHPL_1', shipmentId: 'SHP_1', lineNumber: 1, orderLineId: null, quantity: 5000, unit: 'YD', cartons: 60, grossWeight: '3100', netWeight: '3000', volume: '40' },
          { id: 'SHPL_2', shipmentId: 'SHP_1', lineNumber: 2, orderLineId: null, quantity: 3000, unit: 'YD', cartons: 40, grossWeight: null, netWeight: null, volume: null },
        ]),
      },
    });
    const res = await assembleDocumentSetData(prisma, 'SHP_1');
    expect(res.ok).toBe(true);
    const d = res.data!;

    // 旧行为：毛重合计 = 3100（部分和少算且看似权威）；新行为：回退运单级 5200.5
    expect(d.totals.grossWeight).toBeCloseTo(5200.5, 4);
    expect(d.totals.netWeight).toBeCloseTo(5000, 4);
    expect(d.totals.volume).toBeCloseTo(68.5, 4);
    // 全行都有值的字段不受影响
    expect(d.totals.quantity).toBe(8000);
    expect(d.totals.cartons).toBe(100);
    // 完整度告警：部分行缺值可见
    expect(d.missing).toContain('部分行缺少毛重（合计已回退运单级数据）');
    expect(d.missing).toContain('部分行缺少净重（合计已回退运单级数据）');
    expect(d.missing).toContain('部分行缺少体积（合计已回退运单级数据）');
    expect(d.missing).not.toContain('缺少毛重'); // 合计非空时不重复告缺
  });

  it('运单级也无毛重 → 合计 null + 部分行/缺少双告警（宁缺勿错）', async () => {
    const prisma = makePrisma({
      shipment: {
        findUnique: vi.fn().mockResolvedValue({
          ...BASE_SHIPMENT, orderId: null, customerRelationId: null, carrierRelationId: null,
          grossWeight: null, netWeight: null, volume: null,
        }),
      },
      shipmentLine: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'SHPL_1', shipmentId: 'SHP_1', lineNumber: 1, orderLineId: null, quantity: 5000, unit: 'YD', cartons: 60, grossWeight: '3100', netWeight: null, volume: null },
          { id: 'SHPL_2', shipmentId: 'SHP_1', lineNumber: 2, orderLineId: null, quantity: 3000, unit: 'YD', cartons: 40, grossWeight: null, netWeight: '2000', volume: '28' },
        ]),
      },
    });
    const res = await assembleDocumentSetData(prisma, 'SHP_1');
    expect(res.ok).toBe(true);
    const d = res.data!;
    expect(d.totals.grossWeight).toBeNull(); // 不再显示少算的 3100
    expect(d.missing).toContain('部分行缺少毛重（合计已回退运单级数据）');
    expect(d.missing).toContain('缺少毛重');
  });

  it('部分行缺数量 → 合计留空 + 告警（数量无运单级回退，宁缺勿错）', async () => {
    const prisma = makePrisma({
      shipment: {
        findUnique: vi.fn().mockResolvedValue({
          ...BASE_SHIPMENT, orderId: null, customerRelationId: null, carrierRelationId: null,
        }),
      },
      shipmentLine: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'SHPL_1', shipmentId: 'SHP_1', lineNumber: 1, orderLineId: null, quantity: 5000, unit: 'YD', cartons: 60, grossWeight: '3100', netWeight: '3000', volume: '40' },
          { id: 'SHPL_2', shipmentId: 'SHP_1', lineNumber: 2, orderLineId: null, quantity: null, unit: 'YD', cartons: 40, grossWeight: '2100', netWeight: '2000', volume: '28' },
        ]),
      },
    });
    const res = await assembleDocumentSetData(prisma, 'SHP_1');
    expect(res.ok).toBe(true);
    const d = res.data!;
    expect(d.totals.quantity).toBeNull(); // 不再显示少算的 5000
    expect(d.missing).toContain('部分行缺少数量（合计不可信，已留空，请补齐行数据）');
  });
});
