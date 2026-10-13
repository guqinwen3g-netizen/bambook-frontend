/**
 * proformaInvoiceService 单测
 * 覆盖：generateFromQuotation 校验链 / PI 生成 / convertToReceivable 转换 /
 *       原 PI 状态流转 / 审计与事件触发
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── mock 依赖 ──
vi.mock('../../sequence/sequenceService', () => ({
  createSequenceService: vi.fn(() => ({
    nextNumber: vi.fn().mockResolvedValue('INV-2026-0001'),
  })),
}));

vi.mock('../../audit/routeAudit', () => ({
  writeRouteAuditLog: vi.fn().mockResolvedValue('audit_1'),
}));

vi.mock('../../events/businessEventBus', () => ({
  publishBusinessEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { createProformaInvoiceService } from '../proformaInvoiceService';
import { createSequenceService } from '../../sequence/sequenceService';
import { writeRouteAuditLog } from '../../audit/routeAudit';
import { publishBusinessEvent } from '../../events/businessEventBus';

// ── helpers ──
function dec(v: number | string) {
  return { toString: () => String(v) };
}

function makeQuotation(overrides: any = {}) {
  return {
    id: 'QUO__1',
    quotationNumber: 'QUO-2026-0001',
    status: 'Accepted',
    currency: 'USD',
    totalAmount: dec(10000),
    exchangeRate: dec(7.1),
    baseCurrency: 'CNY',
    convertedOrderId: null,
    customerRelationId: 'REL__1',
    customerName: 'Peerless',
    deliveryTerms: 'FOB Shanghai',
    paymentTerms: 'T/T 30 days',
    salesperson: 'Alice',
    deletedAt: null,
    lines: [
      {
        lineNumber: 1,
        fabricCode: 'FAB-001',
        description: 'Cotton Twill',
        quantity: dec(1000),
        unit: 'YD',
        unitPrice: dec(10),
        amount: dec(10000),
        notes: null,
      },
    ],
    ...overrides,
  };
}

function makePI(overrides: any = {}) {
  return {
    id: 'INV__PI1',
    invoiceNumber: 'INV-2026-0001',
    type: 'Proforma',
    status: 'Draft',
    amount: dec(10000),
    currency: 'USD',
    issueDate: '2026-08-01',
    dueDate: null,
    exchangeRate: dec(7.1),
    baseCurrency: 'CNY',
    orderId: null,
    customerRelationId: 'REL__1',
    customerName: 'Peerless',
    notes: '来源报价单: QUO-2026-0001',
    attachments: { quotationId: 'QUO__1', quotationNumber: 'QUO-2026-0001', lines: [] },
    ownerId: null,
    departmentId: null,
    deletedAt: null,
    createdAt: BigInt(0),
    updatedAt: BigInt(0),
    ...overrides,
  };
}

function makePrisma(overrides: {
  quotation?: any;
  invoiceFindFirst?: any;
  invoiceCreate?: any;
  invoiceUpdate?: any;
  seqNumber?: string;
  account?: any;
} = {}) {
  const quotationData = overrides.quotation === undefined ? makeQuotation() : overrides.quotation;
  const invoiceFindFirstData = overrides.invoiceFindFirst === undefined ? makePI() : overrides.invoiceFindFirst;

  const seqMock = {
    nextNumber: vi.fn().mockResolvedValue(overrides.seqNumber ?? 'INV-2026-0001'),
  };
  (createSequenceService as any).mockReturnValue(seqMock);

  const prisma = {
    // Current authorization storage rows, not a bypass of the PI access
    // helper. These synthetic canonical admins have an explicit real-shaped
    // Invoice permission row; native PG covers actual scope/row visibility.
    userAccount: { findUnique: vi.fn(async ({ where }: any) => overrides.account === undefined ? ({ id: where.id, status: 'active', deletedAt: null, primaryDeptId: null,
      roles: [{ departmentId: null, role: { id: 'role-admin', permissions: [{ permission: { scope: 'invoices:write' } }] } }] }) : overrides.account) },
    userPermissionOverrides: { findMany: vi.fn().mockResolvedValue([]) },
    relation: { findFirst: vi.fn(async ({ where }: any) => ({ id: where.id, deletedAt: null, ownerId: 'user_1', salesRepIds: [] })) },
    order: { findFirst: vi.fn(async ({ where }: any) => ({ id: where.id, deletedAt: null, ownerId: 'user_1', customerRelationId: 'REL__1' })) },
    orderLine: { findUnique: vi.fn().mockResolvedValue(null) },
    developmentCase: { findFirst: vi.fn().mockResolvedValue(null) },
    invoiceOrderAllocation: { findMany: vi.fn().mockResolvedValue([]) },
    // Real source locks are mandatory; this storage seam only supplies the SQL result.
    $queryRaw: vi.fn(async (sql: any) => [{ id: sql.values[0] }]),
    quotation: {
      findFirst: vi.fn().mockResolvedValue(quotationData),
    },
    invoice: {
      create: overrides.invoiceCreate === undefined
        ? vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, id: data.id || 'INV__NEW' }))
        : overrides.invoiceCreate,
      findFirst: vi.fn().mockResolvedValue(invoiceFindFirstData),
      update: overrides.invoiceUpdate === undefined
        ? vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data }))
        : overrides.invoiceUpdate,
    },
    creditLimit: { findFirst: vi.fn().mockResolvedValue(null) },
    // Native PI/number/source-state/audit share one transaction; no CreditLimit in this fixture.
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  } as any;
  return { prisma, seqMock };
}

beforeEach(() => { vi.clearAllMocks(); });

// ═══════════════════════════════════════════════════════════════
// generateFromQuotation
// ═══════════════════════════════════════════════════════════════

describe('generateFromQuotation 输入校验', () => {
  it('报价单不存在 → QUOTATION_NOT_FOUND', async () => {
    const { prisma } = makePrisma({ quotation: null });
    const svc = createProformaInvoiceService(prisma);
    const r = await svc.generateFromQuotation({ quotationId: 'NOPE' }, 'user_1', null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('QUOTATION_NOT_FOUND');
  });

  it('报价单状态非 Accepted → QUOTATION_NOT_ACCEPTED', async () => {
    const { prisma } = makePrisma({ quotation: makeQuotation({ status: 'Draft' }) });
    const svc = createProformaInvoiceService(prisma);
    const r = await svc.generateFromQuotation({ quotationId: 'QUO__1' }, 'user_1', null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('QUOTATION_NOT_ACCEPTED');
    expect(r.error!.message).toContain('Draft');
  });

  it('报价单状态为 Sent → QUOTATION_NOT_ACCEPTED', async () => {
    const { prisma } = makePrisma({ quotation: makeQuotation({ status: 'Sent' }) });
    const svc = createProformaInvoiceService(prisma);
    const r = await svc.generateFromQuotation({ quotationId: 'QUO__1' }, 'user_1', null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('QUOTATION_NOT_ACCEPTED');
  });

  it('非法 issueDate 格式 → INVALID_STATUS', async () => {
    const { prisma } = makePrisma();
    const svc = createProformaInvoiceService(prisma);
    const r = await svc.generateFromQuotation({
      quotationId: 'QUO__1',
      issueDate: '2026/08/01',
    }, 'user_1', null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_STATUS');
  });

  it('编号生成失败 → SEQUENCE_FAILED', async () => {
    const { prisma, seqMock } = makePrisma();
    seqMock.nextNumber.mockRejectedValue(new Error('Sequence table missing'));
    const svc = createProformaInvoiceService(prisma);
    const r = await svc.generateFromQuotation({ quotationId: 'QUO__1' }, 'user_1', null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('SEQUENCE_FAILED');
  });
});

describe('generateFromQuotation 成功路径', () => {
  it('从 Accepted 报价单生成 PI：type=Proforma, status=Draft', async () => {
    const { prisma } = makePrisma();
    const svc = createProformaInvoiceService(prisma);
    const r = await svc.generateFromQuotation({ quotationId: 'QUO__1' }, 'user_1', '127.0.0.1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.type).toBe('Proforma');
      expect(r.data.status).toBe('Draft');
      expect(r.data.invoiceNumber).toBe('INV-2026-0001');
      expect(r.data.currency).toBe('USD');
      expect(r.data.customerRelationId).toBe('REL__1');
      expect(r.data.customerName).toBe('Peerless');
    }
  });

  it('报价单行项目快照到 attachments', async () => {
    const { prisma } = makePrisma();
    const svc = createProformaInvoiceService(prisma);
    const r = await svc.generateFromQuotation({ quotationId: 'QUO__1' }, 'user_1', null);
    expect(r.ok).toBe(true);
    const createCall = prisma.invoice.create.mock.calls[0][0];
    expect(createCall.data.attachments.quotationId).toBe('QUO__1');
    expect(createCall.data.attachments.lines).toHaveLength(1);
    expect(createCall.data.attachments.lines[0].fabricCode).toBe('FAB-001');
  });

  it('条款信息快照到 notes', async () => {
    const { prisma } = makePrisma();
    const svc = createProformaInvoiceService(prisma);
    const r = await svc.generateFromQuotation({
      quotationId: 'QUO__1',
      notes: 'Custom note',
    }, 'user_1', null);
    expect(r.ok).toBe(true);
    const createCall = prisma.invoice.create.mock.calls[0][0];
    expect(createCall.data.notes).toContain('来源报价单: QUO-2026-0001');
    expect(createCall.data.notes).toContain('交货条款: FOB Shanghai');
    expect(createCall.data.notes).toContain('付款条款: T/T 30 days');
    expect(createCall.data.notes).toContain('Custom note');
  });

  it('审计日志写入', async () => {
    const { prisma } = makePrisma();
    const svc = createProformaInvoiceService(prisma);
    await svc.generateFromQuotation({ quotationId: 'QUO__1' }, 'user_1', '127.0.0.1');
    expect(writeRouteAuditLog).toHaveBeenCalledTimes(1);
    const auditCall = (writeRouteAuditLog as any).mock.calls[0][0];
    expect(auditCall.actorId).toBe('user_1');
    expect(auditCall.source).toBe('proforma-invoice:generate');
    expect(auditCall.operation).toBe('generate_proforma_from_quotation');
    expect(auditCall.targetType).toBe('Invoice');
    expect(auditCall.ip).toBe('127.0.0.1');
  });

  it('业务事件发布', async () => {
    const { prisma } = makePrisma();
    const svc = createProformaInvoiceService(prisma);
    await svc.generateFromQuotation({ quotationId: 'QUO__1' }, 'user_1', null);
    expect(publishBusinessEvent).toHaveBeenCalledTimes(1);
    const eventCall = (publishBusinessEvent as any).mock.calls[0][0];
    expect(eventCall.type).toBe('ProformaInvoiceGenerated');
    expect(eventCall.sourceEntityType).toBe('Invoice');
    expect(eventCall.actorId).toBe('user_1');
  });
});

// ═══════════════════════════════════════════════════════════════
// convertToReceivable
// ═══════════════════════════════════════════════════════════════

describe('convertToReceivable 输入校验', () => {
  it('PI 不存在 → NOT_FOUND', async () => {
    const { prisma } = makePrisma({ invoiceFindFirst: null });
    const svc = createProformaInvoiceService(prisma);
    const r = await svc.convertToReceivable('NOPE', {}, 'user_1', null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
  });

  it('发票类型非 Proforma → NOT_PROFORMA', async () => {
    const { prisma } = makePrisma({ invoiceFindFirst: makePI({ type: 'Receivable' }) });
    const svc = createProformaInvoiceService(prisma);
    const r = await svc.convertToReceivable('INV__PI1', {}, 'user_1', null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_PROFORMA');
  });

  it('PI 已作废（Cancelled）→ ALREADY_CONVERTED', async () => {
    const { prisma } = makePrisma({ invoiceFindFirst: makePI({ status: 'Cancelled' }) });
    const svc = createProformaInvoiceService(prisma);
    const r = await svc.convertToReceivable('INV__PI1', {}, 'user_1', null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('ALREADY_CONVERTED');
  });

  it('非法 issueDate → INVALID_STATUS', async () => {
    const { prisma } = makePrisma();
    const svc = createProformaInvoiceService(prisma);
    const r = await svc.convertToReceivable('INV__PI1', { issueDate: '08/01/2026' }, 'user_1', null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_STATUS');
  });

  it('编号生成失败 → SEQUENCE_FAILED', async () => {
    const { prisma, seqMock } = makePrisma({ seqNumber: 'INV-2026-0002' });
    seqMock.nextNumber.mockRejectedValue(new Error('DB error'));
    const svc = createProformaInvoiceService(prisma);
    const r = await svc.convertToReceivable('INV__PI1', {}, 'user_1', null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('SEQUENCE_FAILED');
  });
});

describe('convertToReceivable 成功路径', () => {
  it('新建 type=Receivable, status=Issued 发票', async () => {
    const { prisma } = makePrisma({ seqNumber: 'INV-2026-0002' });
    const svc = createProformaInvoiceService(prisma);
    const r = await svc.convertToReceivable('INV__PI1', {}, 'user_1', '127.0.0.1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.type).toBe('Receivable');
      expect(r.data.status).toBe('Issued');
      expect(r.data.invoiceNumber).toBe('INV-2026-0002');
    }
  });

  it('原 PI 状态更新为 Cancelled', async () => {
    const { prisma } = makePrisma({ seqNumber: 'INV-2026-0002' });
    const svc = createProformaInvoiceService(prisma);
    await svc.convertToReceivable('INV__PI1', {}, 'user_1', null);
    // 第一个 update 调用是更新原 PI
    const updateCall = prisma.invoice.update.mock.calls[0][0];
    expect(updateCall.where.id).toBe('INV__PI1');
    expect(updateCall.data.status).toBe('Cancelled');
    expect(updateCall.data.notes).toContain('已转换为正式应收发票');
  });

  it('新发票继承 PI 的金额、币种、客户信息', async () => {
    const { prisma } = makePrisma({ seqNumber: 'INV-2026-0002' });
    const svc = createProformaInvoiceService(prisma);
    const r = await svc.convertToReceivable('INV__PI1', {}, 'user_1', null);
    expect(r.ok).toBe(true);
    const createCall = prisma.invoice.create.mock.calls[0][0];
    expect(createCall.data.type).toBe('Receivable');
    expect(createCall.data.currency).toBe('USD');
    expect(createCall.data.customerRelationId).toBe('REL__1');
    expect(createCall.data.customerName).toBe('Peerless');
  });

  it('attachments 包含 proformaInvoiceId 追溯', async () => {
    const { prisma } = makePrisma({ seqNumber: 'INV-2026-0002' });
    const svc = createProformaInvoiceService(prisma);
    await svc.convertToReceivable('INV__PI1', {}, 'user_1', null);
    const createCall = prisma.invoice.create.mock.calls[0][0];
    expect(createCall.data.attachments.proformaInvoiceId).toBe('INV__PI1');
    expect(createCall.data.attachments.proformaInvoiceNumber).toBe('INV-2026-0001');
  });

  it('审计日志写入', async () => {
    const { prisma } = makePrisma({ seqNumber: 'INV-2026-0002' });
    const svc = createProformaInvoiceService(prisma);
    await svc.convertToReceivable('INV__PI1', {}, 'user_1', '127.0.0.1');
    expect(writeRouteAuditLog).toHaveBeenCalledTimes(1);
    const auditCall = (writeRouteAuditLog as any).mock.calls[0][0];
    expect(auditCall.source).toBe('proforma-invoice:convert');
    expect(auditCall.operation).toBe('convert_proforma_to_receivable');
    expect(auditCall.ip).toBe('127.0.0.1');
  });

  it('业务事件发布', async () => {
    const { prisma } = makePrisma({ seqNumber: 'INV-2026-0002' });
    const svc = createProformaInvoiceService(prisma);
    await svc.convertToReceivable('INV__PI1', {}, 'user_1', null);
    expect(publishBusinessEvent).toHaveBeenCalledTimes(1);
    const eventCall = (publishBusinessEvent as any).mock.calls[0][0];
    expect(eventCall.type).toBe('ProformaInvoiceConverted');
    expect(eventCall.payload.proformaInvoiceId).toBe('INV__PI1');
    expect(eventCall.payload.receivableInvoiceNumber).toBe('INV-2026-0002');
  });
});

// ═══════════════════════════════════════════════════════════════
// 走查·发票站：形式发票这条直写路径也要落 ownerId
//   读侧（financeServiceV2 列表）按 ownerId 过滤；写侧留空 ⇒ self/team 档的人
//   开出的票对自己隐身，且转换出的应收票继承同一个空（convertToReceivable 沿用 pi.ownerId）
// ═══════════════════════════════════════════════════════════════

describe('ownerId 落库（与订单 / 财务单据 / 报价同一规则）', () => {
  it('generateFromQuotation 把操作者写进 ownerId，而不是留空', async () => {
    const { prisma } = makePrisma();
    const svc = createProformaInvoiceService(prisma);
    const r = await svc.generateFromQuotation({ quotationId: 'QUO__1' }, 'user_1', null);
    expect(r.ok).toBe(true);
    expect(prisma.invoice.create.mock.calls[0][0].data.ownerId).toBe('user_1');
  });

  it('拿不到真实操作者时不凭空造 owner（留痕仍按既有兜底记账）', async () => {
    const { prisma } = makePrisma();
    const svc = createProformaInvoiceService(prisma);
    const r = await svc.generateFromQuotation({ quotationId: 'QUO__1' }, null, null, { userId: 'api', roles: [], permissions: [], departmentIds: [] });
    expect(r.ok).toBe(true);
    expect(prisma.invoice.create.mock.calls[0][0].data.ownerId).toBeNull();
    expect((writeRouteAuditLog as any).mock.calls[0][0].actorId).toBe('api');
  });

  it('PI 转应收票：原票没有 owner 时落到当前操作者（不再继承空）', async () => {
    const { prisma } = makePrisma({ seqNumber: 'INV-2026-0002', invoiceFindFirst: makePI({ ownerId: null }) });
    const svc = createProformaInvoiceService(prisma);
    const r = await svc.convertToReceivable('INV__PI1', {}, 'user_2', null);
    expect(r.ok).toBe(true);
    expect(prisma.invoice.create.mock.calls[0][0].data.ownerId).toBe('user_2');
  });

  it('PI 已有 owner 时转换不丢归属（沿用原票，不是改写成人）', async () => {
    const { prisma } = makePrisma({ seqNumber: 'INV-2026-0002', invoiceFindFirst: makePI({ ownerId: 'user_1' }) });
    const svc = createProformaInvoiceService(prisma);
    const r = await svc.convertToReceivable('INV__PI1', {}, 'user_2', null);
    expect(r.ok).toBe(true);
    expect(prisma.invoice.create.mock.calls[0][0].data.ownerId).toBe('user_1');
  });
});

// Transaction identity/precision/event controls. The storage seam does not
// simulate PostgreSQL rollback or row-lock contention; native PG does both.
describe('native PI transaction and exact source boundaries', () => {
  it.each(['generate', 'convert'] as const)('%s uses one transaction for locks, numbering, Invoice and mandatory audit', async mode => {
    const f = makePrisma(), tx = { ...f.prisma };
    f.prisma.$transaction.mockImplementation(async (work: any) => work(tx));
    const svc = createProformaInvoiceService(f.prisma);
    const result = mode === 'generate' ? await svc.generateFromQuotation({ quotationId: 'QUO__1' }, 'user_1')
      : await svc.convertToReceivable('INV__PI1', {}, 'user_1');
    expect(result.ok).toBe(true); expect(f.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(f.prisma.$queryRaw).toHaveBeenCalledTimes(mode === 'generate' ? 1 : 2);
    if (mode === 'convert') {
      const sourceLock = f.prisma.$queryRaw.mock.calls[0][0];
      expect(sourceLock.sql).toContain('"Quotation"'); expect(sourceLock.sql).toContain('FOR UPDATE');
      expect(sourceLock.values).toContain('QUO__1');
    }
    const sql = f.prisma.$queryRaw.mock.calls[mode === 'generate' ? 0 : 1][0];
    expect(sql.sql).toContain(mode === 'generate' ? '"Quotation"' : '"Invoice"'); expect(sql.sql).toContain('FOR UPDATE');
    expect(f.seqMock.nextNumber).toHaveBeenCalledWith(tx, 'invoice', expect.objectContaining({ occupied: expect.any(Function) }));
    expect(writeRouteAuditLog).toHaveBeenCalledWith(expect.objectContaining({ prisma: tx }));
    expect(publishBusinessEvent).toHaveBeenCalledTimes(1);
  });

  it('generation carries exact Decimal header/FX and exact string row snapshot without a Number roundtrip', async () => {
    const f = makePrisma({ quotation: makeQuotation({ totalAmount: dec('9007199254740.1234'), exchangeRate: dec('12345678901.1234'),
      lines: [{ lineNumber: 1, fabricCode: 'EXACT', description: 'Exact source', quantity: dec('1.2345'), unit: 'M',
        unitPrice: dec('9007199254740.1234'), amount: dec('9007199254740.1234'), notes: null }] }) });
    const result = await createProformaInvoiceService(f.prisma).generateFromQuotation({ quotationId: 'QUO__1' }, 'user_1');
    expect(result.ok).toBe(true);
    const data = f.prisma.invoice.create.mock.calls[0][0].data;
    expect(data.amount.toString()).toBe('9007199254740.1234'); expect(data.exchangeRate.toString()).toBe('12345678901.1234');
    expect(data.attachments.lines[0]).toMatchObject({ quantity: '1.2345', unitPrice: '9007199254740.1234', amount: '9007199254740.1234' });
    expect((writeRouteAuditLog as any).mock.calls[0][0].after.amount).toBe('9007199254740.1234');
    expect((publishBusinessEvent as any).mock.calls[0][0].payload.amount).toBe('9007199254740.1234');
  });

  it('conversion preserves exact persistent header/FX and original snapshot fields', async () => {
    const attachments = { quotationId: 'QUO__1', quotationNumber: 'QUO-2026-0001', lines: [{ amount: '9007199254740.1234' }] };
    const f = makePrisma({ invoiceFindFirst: makePI({ amount: dec('9007199254740.1234'), exchangeRate: dec('12345678901.1234'), attachments }) });
    const result = await createProformaInvoiceService(f.prisma).convertToReceivable('INV__PI1', {}, 'user_1');
    expect(result.ok).toBe(true);
    const data = f.prisma.invoice.create.mock.calls[0][0].data;
    expect(data.amount.toString()).toBe('9007199254740.1234'); expect(data.exchangeRate.toString()).toBe('12345678901.1234');
    expect(data.attachments).toEqual({ ...attachments, proformaInvoiceId: 'INV__PI1', proformaInvoiceNumber: 'INV-2026-0001' });
    expect((writeRouteAuditLog as any).mock.calls[0][0].after.amount).toBe('9007199254740.1234');
  });

  it.each(['generate', 'convert'] as const)('%s audit failure is safe and never publishes a successful event', async mode => {
    const f = makePrisma();
    vi.mocked(writeRouteAuditLog).mockRejectedValueOnce(new Error('SQL private-table secret /private/db'));
    const svc = createProformaInvoiceService(f.prisma);
    const result = mode === 'generate' ? await svc.generateFromQuotation({ quotationId: 'QUO__1' }, 'user_1')
      : await svc.convertToReceivable('INV__PI1', {}, 'user_1');
    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(result.error?.message).toContain('结果暂不可确认'); expect(result.error?.message).not.toMatch(/SQL|private|已回滚|未写入/);
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(1); expect(publishBusinessEvent).not.toHaveBeenCalled();
  });

  it.each(['generate', 'convert'] as const)('%s invalid date is rejected before allocating a number or writing', async mode => {
    const f = makePrisma(), svc = createProformaInvoiceService(f.prisma);
    const result = mode === 'generate' ? await svc.generateFromQuotation({ quotationId: 'QUO__1', issueDate: 'invalid' }, 'user_1')
      : await svc.convertToReceivable('INV__PI1', { issueDate: 'invalid' }, 'user_1');
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_STATUS', message: '开票日期不正确，请选择有效日期（YYYY-MM-DD）。' } });
    expect(f.seqMock.nextNumber).not.toHaveBeenCalled(); expect(f.prisma.invoice.create).not.toHaveBeenCalled();
    expect(f.prisma.invoice.update).not.toHaveBeenCalled(); expect(writeRouteAuditLog).not.toHaveBeenCalled();
    expect(publishBusinessEvent).not.toHaveBeenCalled();
  });
});

// Calendar validity, not just a YYYY-MM-DD-shaped string.
describe('PI real calendar dates', () => {
  it.each([
    ['generate', 'issueDate', '2026-13-45'], ['generate', 'dueDate', '2026-02-30'],
    ['convert', 'issueDate', '2026-02-30'], ['convert', 'dueDate', '2026-13-45'],
  ] as const)('%s rejects invalid %s=%s before a number/write', async (mode, field, value) => {
    const f = makePrisma(), svc = createProformaInvoiceService(f.prisma);
    const result = mode === 'generate' ? await svc.generateFromQuotation({ quotationId: 'QUO__1', [field]: value }, 'user_1')
      : await svc.convertToReceivable('INV__PI1', { [field]: value }, 'user_1');
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_STATUS' } });
    expect(result.error?.message).toBe(field === 'issueDate' ? '开票日期不正确，请选择有效日期（YYYY-MM-DD）。' : '到期日期不正确，请选择有效日期（YYYY-MM-DD）。');
    expect(f.seqMock.nextNumber).not.toHaveBeenCalled(); expect(f.prisma.invoice.create).not.toHaveBeenCalled();
    expect(f.prisma.invoice.update).not.toHaveBeenCalled(); expect(writeRouteAuditLog).not.toHaveBeenCalled();
  });
  it.each([undefined, ''] as const)('generation permits omitted/empty dueDate=%s without inventing a date', async dueDate => {
    const f = makePrisma(), result = await createProformaInvoiceService(f.prisma).generateFromQuotation({ quotationId: 'QUO__1', issueDate: '2028-02-29', dueDate }, 'user_1');
    expect(result.ok).toBe(true); expect(f.prisma.invoice.create.mock.calls[0][0].data.issueDate).toBe('2028-02-29');
    expect(f.prisma.invoice.create.mock.calls[0][0].data.dueDate).toBeNull();
  });
});

// Exact service boundary; these are storage-seam checks, not true concurrent
// PG revocation or proof of a real company administrator.
describe('current native PI authorization boundary', () => {
  it('missing both actor id and server credential is 401 and never burns a sequence or document', async () => {
    const f = makePrisma(), result = await createProformaInvoiceService(f.prisma).generateFromQuotation({ quotationId: 'QUO__1' }, null);
    expect(result.ok).toBe(false); expect(result.error).toMatchObject({ code: 'UNAUTHORIZED', statusCode: 401 });
    expect(f.seqMock.nextNumber).not.toHaveBeenCalled(); expect(f.prisma.invoice.create).not.toHaveBeenCalled();
  });
  it('an explicitly empty signed ceiling cannot be replaced by current admin grants', async () => {
    const f = makePrisma(), result = await createProformaInvoiceService(f.prisma).generateFromQuotation({ quotationId: 'QUO__1' }, 'user_1', null,
      { userId: 'user_1', roles: ['admin'], permissions: ['invoices:write'], departmentIds: [], permissionCeiling: [] });
    expect(result.ok).toBe(false); expect(result.error).toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    expect(f.seqMock.nextNumber).not.toHaveBeenCalled(); expect(f.prisma.invoice.create).not.toHaveBeenCalled();
  });
  it('real stored disabled identity and mismatched credential subject cannot authorize a PI', async () => {
    const f = makePrisma({ account: { id: 'user_1', status: 'disabled', deletedAt: null, roles: [], primaryDeptId: null } });
    const disabled = await createProformaInvoiceService(f.prisma).generateFromQuotation({ quotationId: 'QUO__1' }, 'user_1');
    expect(disabled.ok).toBe(false); expect(disabled.error).toMatchObject({ code: 'UNAUTHORIZED', statusCode: 401 });
    const mismatch = await createProformaInvoiceService(f.prisma).generateFromQuotation({ quotationId: 'QUO__1' }, 'user_1', null,
      { userId: 'user_2', roles: ['admin'], permissions: ['invoices:write'], departmentIds: [] });
    expect(mismatch.ok).toBe(false); expect(mismatch.error).toMatchObject({ code: 'UNAUTHORIZED', statusCode: 401 });
    expect(f.seqMock.nextNumber).not.toHaveBeenCalled(); expect(f.prisma.invoice.create).not.toHaveBeenCalled();
  });
});
