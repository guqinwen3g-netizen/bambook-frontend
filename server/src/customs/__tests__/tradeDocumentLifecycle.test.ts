/**
 * 贸易单据生命周期服务单元测试 — Wave A1 单据中心
 *
 * 覆盖：
 *   1. 自动取号：{前缀}-YYYY-NNNN、含软删取 max+1、超 4 位数值比较、非法类型 fail-closed
 *   2. 版本留痕：v1 起始、max+1 递增、审计日志同事务
 *   3. 生成即登记：运单 → 单据草稿（created/skipped 幂等、relationId 解析、missing 透传、装配失败抛错）
 *   4. 批量打包：订单全部单据 + 最新版本快照、Decimal→number、空订单 total=0
 *   5. 快照序列化：BigInt/Decimal → number
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { ciActor, createCiStorage, currentCiOptions, originalCi } from './ciLegacyContractStorage';
import {
  appendTradeDocumentVersion,
  generateTradeDocumentNumber,
  generateTradeDocumentFile,
  generateTradeDocumentsFromShipment,
  packTradeDocumentsByOrder,
  renderTradeDocumentServerHtml,
  toTradeDocumentSnapshot,
  upsertDomainTradeDocument,
  TRADE_DOC_NUMBER_PREFIX,
} from '../tradeDocumentLifecycleService';

// ── Mock 声明（vi.hoisted：vi.mock 工厂提升后在 import 阶段即可安全引用）──
const { assembleMock, pdfMock, invoiceHtmlMock, fsMock } = vi.hoisted(() => ({
  assembleMock: vi.fn(),
  pdfMock: vi.fn(),
  invoiceHtmlMock: vi.fn(),
  fsMock: { existsSync: vi.fn(() => true), mkdirSync: vi.fn(), writeFileSync: vi.fn() },
}));

// ── Mock 装配服务（不触真实 DB，返回固定 documentSet 数据）──
// ★ 按 B64 的口径写：**只替真正要打桩的那一个导出**，其余走真实实现。
//   原先这里是整模块工厂 `() => ({ assembleDocumentSetData })`，那等于把这个模块的每个新导出都静默变成 undefined
//   —— v2.47 同族的坑（`documentSetHttpErrorCode` 就是这样在另一个测试文件里被吞掉的）。
vi.mock('../../shipping/documentSetService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shipping/documentSetService')>();
  return { ...actual, assembleDocumentSetData: (...args: any[]) => assembleMock(...args) };
});

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Mock PDF 渲染（不启 Puppeteer）+ 财务发票模板（CI 真源分支）+ fs 落盘 ──
vi.mock('../../templates/pdf', () => ({
  renderHtmlToPdf: (...args: any[]) => pdfMock(...args),
}));
vi.mock('../../templates/docTemplates/financeInvoice', () => ({
  // B11 收编：财务发票模板从 finance/route.ts 提取至 docTemplates/financeInvoice.ts
  renderFinanceInvoiceDocument: (...args: any[]) => invoiceHtmlMock(...args),
}));
vi.mock('fs', () => ({ ...fsMock, default: fsMock }));

// ── Mock customsService（upsertDomainTradeDocument 动态 import 的域校验；真实语义副本）──
vi.mock('../customsService', () => ({
  docStatusTransitionsFor: (domain: string) => {
    const transitions: Record<string, Record<string, string[]>> = {
      customs: {}, procurement: {}, qc: {}, contract: {}, finance: {}, quotation: {},
    };
    if (!transitions[domain]) throw new Error(`非法单据业务域: ${domain}`);
    return transitions[domain];
  },
}));

const YEAR = new Date().getFullYear();

function makeAssembled(overrides: Record<string, any> = {}) {
  return {
    ok: true,
    data: {
      order: { id: 'ord_1', currency: 'USD' },
      parties: { consignee: { name: 'ACME LTD' }, customer: { name: 'ACME LTD' } },
      customs: { consignor: 'BAMBOOK CO', currency: 'USD' },
      shipment: { portOfLoading: 'SHANGHAI', portOfDischarge: 'HAMBURG' },
      totals: { amount: 12345.67, currency: 'USD' },
      missing: ['缺少毛重'],
      ...overrides,
    },
  };
}

function makePrisma(overrides: Record<string, any> = {}) {
  const tx: any = {
    tradeDocument: {
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, deletedAt: null })),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data })),
      findMany: overrides.docFindMany ?? vi.fn().mockResolvedValue([]),
      findFirst: overrides.docFindFirst ?? vi.fn().mockResolvedValue(null),
    },
    documentVersion: {
      findFirst: overrides.verFindFirst ?? vi.fn().mockResolvedValue(null),
      findMany: overrides.verFindMany ?? vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data })),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}), findFirst: vi.fn().mockResolvedValue(null) },
  };
  const prisma: any = {
    ...tx,
    $transaction: vi.fn(async (fn: any) => fn(tx)),
    order: {
      findUnique: overrides.orderFindUnique ?? vi.fn().mockResolvedValue({ customerRelationId: 'rel_1' }),
      findMany: overrides.orderFindMany ?? vi.fn().mockResolvedValue([]),
    },
    relation: { findUnique: overrides.relationFindUnique ?? vi.fn().mockResolvedValue(null) },
    shipment: { findMany: overrides.shipmentFindMany ?? vi.fn().mockResolvedValue([]) },
    // BusinessSequence mock（统一编号服务依赖，支持 seq 递增）
    businessSequence: overrides.businessSequence ?? {
      upsert: vi.fn().mockImplementation(async ({ where, create }: any) => ({ ...create, seq: 0 })),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => {
        const current = (prisma as any)._seq ?? 0;
        (prisma as any)._seq = current + 1;
        return { seq: current + 1 };
      }),
      findUnique: vi.fn().mockImplementation(async () => ({ seq: (prisma as any)._seq ?? 0 })),
      deleteMany: vi.fn().mockResolvedValue({}),
    },
    _tx: tx,
  };
  return prisma;
}

// Observe actual storage writes without replacing auth/source/producer logic.
function makeCiPrisma(options: Parameters<typeof createCiStorage>[0] = {}) {
  const native = createCiStorage(options), prisma = native.db;
  const writes: any = { tradeDocument: { create: vi.fn(), update: vi.fn() }, documentVersion: { create: vi.fn() }, auditLog: { create: vi.fn() } };
  const transact = prisma.$transaction.bind(prisma), sequence = makePrisma().businessSequence;
  prisma.$transaction = vi.fn((work: any, config: any) => transact(async (tx: any) => {
    tx.businessSequence = sequence;
    // The storage substitute uses simple field matching; adapt Prisma's
    // generated compound unique selector without bypassing source validation.
    const versionFindUnique = tx.documentVersion.findUnique.bind(tx.documentVersion);
    tx.documentVersion.findUnique = (args: any) => args.where?.documentId_version
      ? tx.documentVersion.findFirst({ where: args.where.documentId_version })
      : versionFindUnique(args);
    for (const [model, operations] of Object.entries(writes)) for (const operation of Object.keys(operations as any)) {
      const actual = tx[model][operation].bind(tx[model]);
      tx[model][operation] = (args: any) => { writes[model][operation](args); return actual(args); };
    }
    return work(tx);
  }, config));
  prisma._tx = writes; prisma.auditLog.create = writes.auditLog.create;
  return { native, prisma, writes };
}

beforeEach(() => {
  assembleMock.mockReset();
});

describe('generateTradeDocumentNumber', () => {
  it('无既有编号 → 0001 起始', async () => {
    const prisma = makePrisma();
    const num = await generateTradeDocumentNumber(prisma, 'CommercialInvoice');
    expect(num).toBe(`CI-${YEAR}-0001`);
  });

  it('统一编号服务：同类型 seq 递增（作废不回收）', async () => {
    const prisma = makePrisma();
    const num1 = await generateTradeDocumentNumber(prisma, 'PackingList');
    expect(num1).toBe(`PL-${YEAR}-0001`);
    const num2 = await generateTradeDocumentNumber(prisma, 'PackingList');
    expect(num2).toBe(`PL-${YEAR}-0002`);
  });

  it('降级路径：无 businessSequence 时扫描既有记录（mock 测试场景兼容）', async () => {
    const prisma = makePrisma({
      docFindMany: vi.fn().mockResolvedValue([
        { documentNumber: `CI-${YEAR}-9999` },
        { documentNumber: `CI-${YEAR}-10000` },
      ]),
    });
    // 显式移除 businessSequence，触发降级路径
    delete prisma.businessSequence;
    const num = await generateTradeDocumentNumber(prisma, 'CommercialInvoice');
    expect(num).toBe(`CI-${YEAR}-10001`);
  });

  it('非法类型 fail-closed', async () => {
    const prisma = makePrisma();
    await expect(generateTradeDocumentNumber(prisma, 'Nope' as any)).rejects.toThrow('非法单据类型');
  });

  it('17 类前缀映射齐备（含独立加工合同）', () => {
    expect(Object.keys(TRADE_DOC_NUMBER_PREFIX)).toHaveLength(17);
    expect(TRADE_DOC_NUMBER_PREFIX.BillOfLading).toBe('BL');
    expect(TRADE_DOC_NUMBER_PREFIX.ExportDeclarationProof).toBe('EDP');
    expect(TRADE_DOC_NUMBER_PREFIX.PurchaseOrder).toBe('PO');
    expect(TRADE_DOC_NUMBER_PREFIX.InspectionReport).toBe('IR');
    expect(TRADE_DOC_NUMBER_PREFIX.Quotation).toBe('QT');
    expect(TRADE_DOC_NUMBER_PREFIX.OrderConfirmation).toBe('OC');
    // §10.3-9 Phase B 批次 4：付款申请单（finance 域）
    expect(TRADE_DOC_NUMBER_PREFIX.PaymentRequest).toBe('PAYR');
    expect(TRADE_DOC_NUMBER_PREFIX.Contract).toBe('CT');
  });
});

describe('appendTradeDocumentVersion', () => {
  it('无既有版本 → v1 + 审计', async () => {
    const prisma = makePrisma();
    await appendTradeDocumentVersion(prisma._tx, {
      documentId: 'TD_1',
      content: { a: 1 },
      actorId: 'user_1',
      changeReason: '创建',
    });
    expect(prisma._tx.documentVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ documentId: 'TD_1', version: 1, changedBy: 'user_1', changeReason: '创建' }),
      }),
    );
    expect(prisma._tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'DOCUMENT_VERSION_CREATE' }) }),
    );
  });

  it('既有版本 → max+1 递增', async () => {
    const prisma = makePrisma({ verFindFirst: vi.fn().mockResolvedValue({ version: 3 }) });
    await appendTradeDocumentVersion(prisma._tx, {
      documentId: 'TD_1',
      content: {},
      actorId: 'user_1',
    });
    expect(prisma._tx.documentVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ version: 4 }) }),
    );
  });

  it('changeReason 空白 → null', async () => {
    const prisma = makePrisma();
    await appendTradeDocumentVersion(prisma._tx, {
      documentId: 'TD_1',
      content: {},
      actorId: 'user_1',
      changeReason: '   ',
    });
    expect(prisma._tx.documentVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ changeReason: null }) }),
    );
  });
});

describe('generateTradeDocumentsFromShipment', () => {
  it('批量创建 Draft 单据：自动取号 + v1 快照 + relationId 解析 + missing 透传', async () => {
    assembleMock.mockResolvedValue(makeAssembled());
    const { native, prisma } = makeCiPrisma();
    const sourceOptions = await currentCiOptions(native);
    const result = await generateTradeDocumentsFromShipment(prisma, {
      ...sourceOptions,
      types: ['CommercialInvoice', 'PackingList'],
      actorId: ciActor.userId,
    });

    expect(result.created).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
    expect(result.missing).toEqual(['缺少毛重']);
    expect(result.created[0].documentNumber).toBe(native.tables.invoice[0].invoiceNumber);
    expect(result.created[1].documentNumber).toBe(`PL-${YEAR}-0001`);

    // 单据字段：装配数据映射 + relationId + Draft
    const createData = prisma._tx.tradeDocument.create.mock.calls.find(([{ data }]: any) => data.type === 'PackingList')[0].data;
    expect(createData.status).toBe('Draft');
    expect(createData.shipmentId).toBe('shp_1');
    expect(createData.orderId).toBe('ord_1');
    expect(createData.portOfLoading).toBe('SHANGHAI');
    const ciCreateData = prisma._tx.tradeDocument.create.mock.calls.find(([{ data }]: any) => data.type === 'CommercialInvoice')[0].data;
    expect(ciCreateData.relationId).toBe('rel_1');
    expect(ciCreateData.consignee).toBe('ACME LTD');
    expect(Number(ciCreateData.totalAmount)).toBeCloseTo(12345.67);

    // PL 使用当前受控的来源快照，不再消费旧 generic documentSet。
    const verData = prisma._tx.documentVersion.create.mock.calls.find(([{ data }]: any) => data.documentId === result.created[1].id)[0].data;
    expect(verData.version).toBe(1);
    expect(verData.content.packingList).toBeDefined();
    expect(verData.changeReason).toBe('原运单逐箱来源登记');
    const ciDocument = native.tables.tradeDocument.find(row => row.type === 'CommercialInvoice');
    const ciVersion = native.tables.documentVersion.find(row => row.documentId === ciDocument.id);
    expect(ciDocument.sourceInvoiceId).toBe(native.tables.invoice[0].id);
    expect(ciVersion.content.ciSourceSnapshot.invoice.id).toBe(native.tables.invoice[0].id);
    expect(ciVersion.content.ciSource.sourceFingerprint).toBe(sourceOptions.expectedSourceFingerprint);
    expect(native.tables.auditLog.filter(row => row.transactionId === 'CI:' + ciDocument.id).map(row => row.action).sort()).toEqual(['DOCUMENT_VERSION_CREATE', 'TRADE_DOCUMENT_CREATE']);
  });

  it('同 shipmentId+type 已存在 → skipped 幂等不重复登记', async () => {
    assembleMock.mockResolvedValue(makeAssembled());
    const { native, prisma } = makeCiPrisma();
    const original = await originalCi(native);
    prisma._tx.tradeDocument.create.mockClear();
    const result = await generateTradeDocumentsFromShipment(prisma, {
      ...await currentCiOptions(native),
      types: ['CommercialInvoice'],
      actorId: ciActor.userId,
    });
    expect(result.created).toHaveLength(0);
    expect(result.skipped).toEqual([{ type: 'CommercialInvoice', id: original.document.id, documentNumber: original.document.documentNumber, reason: 'EXISTS' }]);
    expect(native.tables.tradeDocument).toHaveLength(1); expect(native.tables.documentVersion).toHaveLength(1);
    expect(native.tables.auditLog.map(row => row.action).sort()).toEqual(['DOCUMENT_VERSION_CREATE', 'TRADE_DOCUMENT_CREATE']);
    expect(prisma._tx.tradeDocument.create).not.toHaveBeenCalled();
  });

  it('types 空数组 / 非法类型 → 400 语义抛错', async () => {
    const prisma = makePrisma();
    await expect(
      generateTradeDocumentsFromShipment(prisma, { shipmentId: 'shp_1', types: [], actorId: 'u' }),
    ).rejects.toThrow('types 必填');
    await expect(
      generateTradeDocumentsFromShipment(prisma, { shipmentId: 'shp_1', types: ['Nope' as any], actorId: 'u' }),
    ).rejects.toThrow('非法单据类型');
  });

  it('从出运生成只允许我方 CI / PL；外部方单据必须上传归档', async () => {
    const prisma = makePrisma();
    await expect(
      generateTradeDocumentsFromShipment(prisma, { shipmentId: 'shp_1', types: ['BillOfLading'], actorId: 'u' }),
    ).rejects.toThrow('外部方出具的文件请上传归档');
    await expect(
      generateTradeDocumentsFromShipment(prisma, { shipmentId: 'shp_1', types: ['InsuranceCert'], actorId: 'u' }),
    ).rejects.toThrow('外部方出具的文件请上传归档');
    expect(prisma._tx.tradeDocument.create).not.toHaveBeenCalled();
  });

  it('装配失败（运单不存在）→ 抛错不建档', async () => {
    assembleMock.mockResolvedValue({ ok: false, error: { code: 'SHIPMENT_NOT_FOUND', message: '运单 shp_x 不存在' } });
    const { native, prisma } = makeCiPrisma();
    const sourceOptions = await currentCiOptions(native);
    await expect(
      generateTradeDocumentsFromShipment(prisma, { shipmentId: 'shp_1', types: ['CommercialInvoice'], actorId: ciActor.userId, ...sourceOptions }),
    ).rejects.toThrow('运单 shp_x 不存在');
    expect(prisma._tx.tradeDocument.create).not.toHaveBeenCalled();
  });
});

describe('packTradeDocumentsByOrder', () => {
  it('订单全部单据 + 最新版本快照，Decimal→number', async () => {
    const prisma = makePrisma({
      docFindMany: vi.fn().mockResolvedValue([
        {
          id: 'TD_1',
          documentNumber: `CI-${YEAR}-0001`,
          type: 'CommercialInvoice',
          status: 'Issued',
          issueDate: '2026-08-01',
          consignee: 'ACME',
          consignor: 'BAMBOOK',
          totalAmount: new Prisma.Decimal(999.5),
          currency: 'USD',
          fileName: null,
        },
        {
          id: 'TD_2',
          documentNumber: `PL-${YEAR}-0002`,
          type: 'PackingList',
          status: 'Draft',
          issueDate: null,
          consignee: null,
          consignor: null,
          totalAmount: null,
          currency: null,
          fileName: 'pl.pdf',
        },
      ]),
      verFindFirst: vi
        .fn()
        .mockResolvedValueOnce({ version: 3, content: { documentSet: { x: 1 } } })
        .mockResolvedValueOnce(null),
    });
    const { items, total } = await packTradeDocumentsByOrder(prisma, 'ord_1');
    expect(total).toBe(2);
    expect(items[0].latestVersion).toBe(3);
    expect(items[0].content).toEqual({ documentSet: { x: 1 } });
    expect(items[0].totalAmount).toBe(999.5);
    expect(items[1].latestVersion).toBeNull();
    expect(items[1].content).toBeNull();
  });

  it('空订单 → total=0；orderId 缺失 → 抛错', async () => {
    const prisma = makePrisma();
    const { items, total } = await packTradeDocumentsByOrder(prisma, 'ord_empty');
    expect(total).toBe(0);
    expect(items).toEqual([]);
    await expect(packTradeDocumentsByOrder(prisma, '')).rejects.toThrow('orderId 必填');
  });
});

describe('toTradeDocumentSnapshot', () => {
  it('BigInt/Decimal → number，其余原样', () => {
    const snap = toTradeDocumentSnapshot({
      id: 'TD_1',
      createdAt: BigInt(1723000000000),
      totalAmount: new Prisma.Decimal('12.34'),
      notes: null,
      status: 'Draft',
    });
    expect(snap.createdAt).toBe(1723000000000);
    expect(snap.totalAmount).toBe(12.34);
    expect(snap.notes).toBeNull();
    expect(snap.status).toBe('Draft');
  });
});

describe('generateTradeDocumentFile', () => {
  const DOC_HTML = '<!doctype html><html><head><style>body{}</style></head><body>PACKING LIST CONTENT</body></html>';

  beforeEach(() => {
    pdfMock.mockReset().mockResolvedValue({ pdf: Buffer.from('%PDF-1.4 fake'), sha: 'abc123', bytes: 20 });
    invoiceHtmlMock.mockReset().mockResolvedValue('<!doctype html><html>COMMERCIAL INVOICE FROM FINANCE</html>');
    fsMock.writeFileSync.mockReset();
    fsMock.existsSync.mockReset().mockReturnValue(true);
    fsMock.mkdirSync.mockReset();
  });

  function makeDocPrisma(doc: any) {
    const update = vi.fn().mockImplementation(async ({ data }: any) => ({ id: doc.id, ...data }));
    const prisma = makePrisma({
      docFindFirst: vi.fn().mockResolvedValue(doc),
      verFindFirst: vi.fn().mockResolvedValue({ version: 2, content: {} }),
    });
    prisma.tradeDocument.update = update;
    return { prisma, update };
  }

  it('CI 带财务回链 → 服务端财务真源模板自渲染（忽略入参 html）+ 落盘 + 回写 + 审计', async () => {
    const { native, prisma, writes } = makeCiPrisma({ invoiceId: 'INV_9', invoiceNumber: `CI-${YEAR}-0001` });
    native.tables.tradeDocument.push({ id: 'TD_CI_1', documentNumber: `CI-${YEAR}-0001`, type: 'CommercialInvoice', sourceInvoiceId: 'INV_9', shipmentId: 'shp_1', status: 'Draft', deletedAt: null });
    native.tables.documentVersion.push({ id: 'OLD-V1', documentId: 'TD_CI_1', version: 1, content: {} }, { id: 'OLD-V2', documentId: 'TD_CI_1', version: 2, content: {} });
    const update = writes.tradeDocument.update, sourceOptions = await currentCiOptions(native);
    const result = await generateTradeDocumentFile(prisma, {
      id: 'TD_CI_1',
      html: '<!doctype html><html>前端伪造模板</html>', // 应被忽略——单一真源防双模板漂移
      version: 2,
      actorId: ciActor.userId, trustedActor: ciActor,
    });
    // B1 起 renderInvoiceDocumentHtml 带 opts 参数（generate 路径 = {} 非 screen；preview.html = { screen: true }）
    expect(invoiceHtmlMock).toHaveBeenCalledWith(prisma, 'INV_9', { trustedActor: ciActor, mode: 'register', documentId: 'TD_CI_1', expectedSourceFingerprint: sourceOptions.expectedSourceFingerprint });
    expect(pdfMock).toHaveBeenCalledWith(
      '<!doctype html><html>COMMERCIAL INVOICE FROM FINANCE</html>',
      { format: 'A4' },
    );
    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
    expect(result.fileName).toBe(`CI-${YEAR}-0001-v2.pdf`);
    expect(result.filePath).toMatch(/^trade-documents\/ci-TD_CI_1-[0-9a-f-]{36}-CI-\d{4}-0001-v2\.pdf$/);
    expect(result.fileSize).toBe(20);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'TD_CI_1' }, data: expect.objectContaining({ fileName: `CI-${YEAR}-0001-v2.pdf` }) }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'TRADE_DOCUMENT_FILE_GENERATED', targetId: 'TD_CI_1' }) }),
    );
    const binding = native.tables.auditLog.find(row => row.action === 'TRADE_DOCUMENT_FILE_GENERATED');
    expect(binding.detail.sourceInvoiceId).toBe('INV_9'); expect(binding.detail.sourceFingerprint).toBe(sourceOptions.expectedSourceFingerprint);
    expect(binding.detail.filePath).toBe(result.filePath); expect(binding.detail.sourceSnapshot.invoice.id).toBe('INV_9');
  });

  it('非 PL/CI 通用类型 → 用入参 html 渲染落盘', async () => {
    const { prisma, update } = makeDocPrisma({
      id: 'TD_OTHER_1',
      documentNumber: `CT-${YEAR}-0003`,
      type: 'Contract',
      sourceInvoiceId: null,
      deletedAt: null,
    });
    const result = await generateTradeDocumentFile(prisma, { id: 'TD_OTHER_1', html: DOC_HTML, version: 1, actorId: 'user_1' });
    expect(invoiceHtmlMock).not.toHaveBeenCalled();
    expect(pdfMock).toHaveBeenCalledWith(DOC_HTML, { format: 'A4' });
    expect(result.fileName).toBe(`CT-${YEAR}-0003-v1.pdf`);
    expect(update).toHaveBeenCalled();
  });

  it('版本号缺省 → 兜底最新版本；单据不存在/无渲染内容 → 抛错', async () => {
    const { prisma } = makeDocPrisma({
      id: 'TD_OTHER_2',
      documentNumber: `CT-${YEAR}-0004`,
      type: 'Contract',
      sourceInvoiceId: null,
      deletedAt: null,
    });
    const r = await generateTradeDocumentFile(prisma, { id: 'TD_OTHER_2', html: DOC_HTML, actorId: 'u' });
    expect(r.fileName).toBe(`CT-${YEAR}-0004-v2.pdf`); // verFindFirst 兜底 version=2

    const missing = makePrisma({ docFindFirst: vi.fn().mockResolvedValue(null) });
    await expect(generateTradeDocumentFile(missing, { id: 'TD_X', html: DOC_HTML, actorId: 'u' })).rejects.toThrow('不存在');

    const noHtml = makeDocPrisma({ id: 'TD_OTHER_3', documentNumber: 'CT-1', type: 'Contract', sourceInvoiceId: null, deletedAt: null });
    await expect(generateTradeDocumentFile(noHtml.prisma, { id: 'TD_OTHER_3', html: '', actorId: 'u' })).rejects.toThrow('无可渲染内容');
  });
});

// ══════════════════════════════════════════════════════════════
// B2 运营域单据登记（upsertDomainTradeDocument）
// ══════════════════════════════════════════════════════════════

describe('upsertDomainTradeDocument', () => {
  it('首次登记 → created：文档号=入参业务单号 + v1 轻量快照（sourceRef 元数据）', async () => {
    const prisma = makePrisma();
    const result = await upsertDomainTradeDocument(prisma, {
      domain: 'quotation',
      type: 'Quotation',
      sourceRef: 'QUOTE_abc123',
      documentNumber: 'QT-20260806-001',
      orderId: 'ord_1',
      totalAmount: 12345.67,
      currency: 'USD',
      issueDate: '2026-08-06',
      actorId: 'user_1',
    });
    expect(result).toEqual({ documentId: expect.any(String), documentNumber: 'QT-20260806-001', outcome: 'created' });

    const create = prisma._tx.tradeDocument.create.mock.calls[0][0].data;
    expect(create.domain).toBe('quotation');
    expect(create.type).toBe('Quotation');
    expect(create.sourceRef).toBe('QUOTE_abc123');
    expect(create.status).toBe('Draft');
    expect(create.totalAmount.toString()).toBe('12345.67');
    // v1 快照记录真源外链（渲染走业务真源实时装配，不复制内容）
    const verCreate = prisma._tx.documentVersion.create.mock.calls[0][0].data;
    expect(verCreate.version).toBe(1);
    expect(verCreate.content).toMatchObject({ source: 'domain', domain: 'quotation', sourceRef: 'QUOTE_abc123' });
  });

  it('文档号缺省 → 自动取号（QT 前缀）', async () => {
    const prisma = makePrisma();
    // Native QC document registration requires a real report, live parent,
    // trusted actor and current grants. This unit test covers the generic
    // domain path's auto-numbering; native QC authority is covered elsewhere.
    const result = await upsertDomainTradeDocument(prisma, {
      domain: 'quotation',
      type: 'Quotation',
      sourceRef: 'QUOTE_abc123',
      actorId: 'user_1',
    });
    expect(result.outcome).toBe('created');
    expect(result.documentNumber).toBe(`QT-${YEAR}-0001`);
  });

  it('重复登记 → updated：不新建文档，刷新头字段 + 审计', async () => {
    const prisma = makePrisma({
      docFindFirst: vi.fn().mockResolvedValue({ id: 'TD_EXIST', documentNumber: 'QT-20260806-001' }),
    });
    const result = await upsertDomainTradeDocument(prisma, {
      domain: 'quotation',
      type: 'Quotation',
      sourceRef: 'QUOTE_abc123',
      documentNumber: 'QT-20260806-001',
      totalAmount: 9999,
      currency: 'USD',
      actorId: 'user_1',
    });
    expect(result).toMatchObject({ documentId: 'TD_EXIST', outcome: 'updated' });
    expect(prisma._tx.tradeDocument.create).not.toHaveBeenCalled();
    expect(prisma._tx.tradeDocument.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'TD_EXIST' }, data: expect.objectContaining({ currency: 'USD' }) }),
    );
    const audit = prisma._tx.auditLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe('TRADE_DOCUMENT_DOMAIN_REFRESH');
  });

  it('未知 domain → fail-closed 抛错（域状态机未注册）', async () => {
    const prisma = makePrisma();
    await expect(upsertDomainTradeDocument(prisma, {
      domain: 'unknown_domain',
      type: 'Quotation',
      sourceRef: 'PO_x',
      actorId: 'user_1',
    })).rejects.toThrow('非法单据业务域');
  });
});

// ────────────────────────────────────────────────────────────────
// 批次 H3：组合单据渲染分支（sourceRef=composite:{kind}:{ids} 实时重装配 + 快照回落）
// ────────────────────────────────────────────────────────────────

/** 组合渲染测试用单运单 documentSet（assembleMergedDocumentSet 逐运单聚合） */
function makeCompositeContractData(description: string) {
  const order = (index: number) => ({ index, orderId: `ORD_${index}`, poNumber: `PO-${index}`, customer: 'ACME', currency: 'USD',
    orderAmount: 1, dueDate: null, shipmentDate: null, insuranceMode: null, claimPeriodDays: null, disputeResolution: null,
    portOfLoading: null, portOfDischarge: null, deliveryTerms: null, paymentTerms: null, salesContractNumber: null,
    finalContractNumber: null, lineCount: 1 });
  return { contractNumber: 'SC-TEST', contractDate: '2026-10-07', customer: null, orders: [order(1), order(2)],
    lines: [{ lineNumber: 1, orderIndex: 1, itemNo: 'SKU-1', description, quantity: 1, unit: 'pcs', unitPrice: 1, netValue: 1, tolerancePercent: null }],
    totals: { currency: 'USD', amount: 1, quantity: 1 } };
}

describe('renderTradeDocumentServerHtml（组合合同实时装配与快照回落）', () => {
  it('composite CONTRACT sourceRef → 实时重装配渲染（register:false 不触发登记）', async () => {
    const prisma = makePrisma({ orderFindUnique: vi.fn().mockImplementation(async ({ where }: any) => ({
      id: where.id, poNumber: `PO-${where.id}`, customer: 'ACME', currency: 'USD', customerRelationId: null,
      deletedAt: null, lines: [{ itemNo: 'SKU-1', description: `Goods ${where.id}`, quantity: 1, unit: 'pcs', unitPrice: 1, netValue: 1 }],
    })) });
    const html = await renderTradeDocumentServerHtml(prisma, {
      id: 'TD_c1', type: 'Contract', sourceInvoiceId: null,
      sourceRef: 'composite:CONTRACT:ORD_1,ORD_2',
    });
    expect(html).toContain('SALES CONTRACT');
    expect(html).toContain('Goods ORD_1');
    // 渲染路径不登记台账（防回环）
    expect(prisma._tx.tradeDocument.create).not.toHaveBeenCalled();
  });

  it('组合合同真源缺失 → 回落最新版本快照的冻结数据渲染（归档语义）', async () => {
    const snapshotData = {
      ...makeCompositeContractData('Frozen Goods'),
    };
    const prisma = makePrisma({
      orderFindUnique: vi.fn().mockResolvedValue(null),
      verFindFirst: vi.fn().mockResolvedValue({
        version: 1,
        content: { source: 'composite', kind: 'CONTRACT', sourceIds: ['ORD_1', 'ORD_2'], data: snapshotData },
      }),
    });
    const html = await renderTradeDocumentServerHtml(prisma, {
      id: 'TD_c2', type: 'Contract', sourceInvoiceId: null,
      sourceRef: 'composite:CONTRACT:ORD_1,ORD_2',
    });
    expect(html).toContain('SALES CONTRACT');
    expect(html).toContain('Frozen Goods');
  });

  it('第三方文件只允许原件归档；合同的非法 composite ref / 快照缺失返回 null', async () => {
    const prisma = makePrisma();
    await expect(renderTradeDocumentServerHtml(prisma, {
      id: 'TD_c3', type: 'Other', sourceInvoiceId: null, sourceRef: 'composite:NOPE:x',
    })).rejects.toThrow('第三方单据只提供归档文件');

    prisma.order.findUnique = vi.fn().mockResolvedValue(null);
    expect(await renderTradeDocumentServerHtml(prisma, {
      id: 'TD_c4', type: 'Contract', sourceInvoiceId: null, sourceRef: 'composite:CONTRACT:ORD_1,ORD_2',
    })).toBeNull(); // 无版本快照可回落
  });
});
