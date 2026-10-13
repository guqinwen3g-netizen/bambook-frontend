/**
 * 阶段 C6 — vatInvoiceService 单测
 * 覆盖：createVatInvoice 校验链 / 金额三栏服务端校验（精确 + 尾差容差）/ 全电票查重 /
 *       状态机转换（Received→Verified→Declared→RedFlushed / Cancelled）/ 退税联动硬校验 /
 *       编辑守卫（Declared/RedFlushed/Cancelled 不可改）/ 删除守卫（Declared 禁删）
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  createVatInvoice,
  updateVatInvoice,
  transitionVatInvoiceStatus,
  deleteVatInvoice,
  listVatInvoices,
  getVatInvoice,
} from '../vatInvoiceService';

// ── mock helpers ──
function dec(v: number | string) {
  return { toString: () => String(v) };
}

const BASE_INPUT = {
  vatCode: '044032100111',
  vatNumber: '12345678',
  sellerName: '绍兴某织造有限公司',
  buyerName: '本公司',
  issueDate: '2026-08-01',
  netAmount: 100000,
  taxRate: 13,
  taxAmount: 13000,
  totalAmount: 113000,
};

const EXISTING_RECEIVED = {
  id: 'VAT__1', vatCode: '044032100111', vatNumber: '12345678',
  direction: 'Input', invoiceType: 'Special', status: 'Received',
  netAmount: dec(100000), taxRate: dec(13), taxAmount: dec(13000), totalAmount: dec(113000),
  orderId: 'ORD__1', relationId: 'REL__M1', invoiceId: 'INV__1', taxRefundId: null,
  deletedAt: null,
};

function makeTx(overrides: {
  existing?: any;
  dup?: any;
  taxRefund?: any;
  createFail?: boolean;
} = {}) {
  const vatInvoiceCreate = overrides.createFail
    ? vi.fn().mockRejectedValue(new Error('DB_DOWN'))
    : vi.fn().mockImplementation(async ({ data }: any) => ({ ...data }));
  const tx = {
    vatInvoice: {
      findFirst: vi.fn().mockResolvedValue(overrides.dup ?? null),
      findUnique: vi.fn().mockResolvedValue(overrides.existing === undefined ? EXISTING_RECEIVED : overrides.existing),
      create: vatInvoiceCreate,
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ ...EXISTING_RECEIVED, id: where.id, ...data })),
    },
    taxRefund: {
      findFirst: vi.fn().mockResolvedValue(overrides.taxRefund === undefined ? { id: 'TR__1' } : overrides.taxRefund),
    },
    entityReference: {
      upsert: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([{ id: 'R1' }]),
      update: vi.fn().mockResolvedValue({}),
    },
    entityLink: {
      upsert: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([{ id: 'L1' }]),
      update: vi.fn().mockResolvedValue({}),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit_1' }) },
  };
  return { tx, vatInvoiceCreate };
}

function makePrisma(tx: any) {
  return { $transaction: vi.fn(async (fn: any) => fn(tx)) } as any;
}

beforeEach(() => { vi.clearAllMocks(); });

describe('C6 createVatInvoice 输入校验（fail closed）', () => {
  it('缺 vatNumber → INVALID_INPUT', async () => {
    const r = await createVatInvoice({ prisma: {} as any, input: { ...BASE_INPUT, vatNumber: '' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_INPUT');
  });

  it('缺 sellerName/buyerName → INVALID_INPUT', async () => {
    const r = await createVatInvoice({ prisma: {} as any, input: { ...BASE_INPUT, sellerName: ' ' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_INPUT');
  });

  it('非法 issueDate → INVALID_DATE', async () => {
    const r = await createVatInvoice({ prisma: {} as any, input: { ...BASE_INPUT, issueDate: '2026/08/01' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_DATE');
  });

  it('非法 direction → INVALID_INPUT', async () => {
    const r = await createVatInvoice({ prisma: {} as any, input: { ...BASE_INPUT, direction: 'Sideways' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_INPUT');
  });
});

describe('C6 createVatInvoice 金额三栏校验', () => {
  it('totalAmount ≠ net + tax → AMOUNT_MISMATCH', async () => {
    const r = await createVatInvoice({ prisma: {} as any, input: { ...BASE_INPUT, totalAmount: 113001 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('AMOUNT_MISMATCH');
  });

  it('taxAmount 与 net×rate 偏差 > 0.02 → TAX_MISMATCH', async () => {
    // 100000 × 13% = 13000；改 taxAmount=13000.05 且 total 同步保持精确 → 触发税额容差
    const r = await createVatInvoice({ prisma: {} as any, input: { ...BASE_INPUT, taxAmount: 13000.05, totalAmount: 113000.05 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('TAX_MISMATCH');
  });

  it('税额尾差 ≤ 0.02 放行（开票尾差容差）', async () => {
    const { tx } = makeTx();
    const r = await createVatInvoice({ prisma: makePrisma(tx), input: { ...BASE_INPUT, taxAmount: 13000.01, totalAmount: 113000.01 } });
    expect(r.ok).toBe(true);
  });

  it('netAmount ≤ 0 → INVALID_AMOUNT', async () => {
    const r = await createVatInvoice({ prisma: {} as any, input: { ...BASE_INPUT, netAmount: 0, taxAmount: 0, totalAmount: 0 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_AMOUNT');
  });
});

describe('C6 createVatInvoice 查重与创建', () => {
  it('同 vatCode+vatNumber 已存在 → DUPLICATE_VAT_INVOICE', async () => {
    const { tx } = makeTx({ dup: { id: 'VAT__DUP' } });
    const r = await createVatInvoice({ prisma: makePrisma(tx), input: BASE_INPUT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('DUPLICATE_VAT_INVOICE');
  });

  it('全电票（无 vatCode）查重同样生效（应用层兜底 NULL 语义）', async () => {
    const { tx, vatInvoiceCreate } = makeTx({ dup: { id: 'VAT__DUP2' } });
    const r = await createVatInvoice({ prisma: makePrisma(tx), input: { ...BASE_INPUT, vatCode: undefined, vatNumber: '25312000000012345678' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('DUPLICATE_VAT_INVOICE');
    expect(vatInvoiceCreate).not.toHaveBeenCalled();
  });

  it('正常创建：默认 direction=Input / invoiceType=Special / status=Received', async () => {
    const { tx, vatInvoiceCreate } = makeTx();
    const r = await createVatInvoice({ prisma: makePrisma(tx), input: BASE_INPUT });
    expect(r.ok).toBe(true);
    const created = vatInvoiceCreate.mock.calls[0][0].data;
    expect(created.direction).toBe('Input');
    expect(created.invoiceType).toBe('Special');
    expect(created.status).toBe('Received');
    expect(created.currency).toBe('CNY');
  });
});

describe('C6 transitionVatInvoiceStatus 状态机', () => {
  it('Received → Verified：缺省 verifiedDate=当日', async () => {
    const { tx } = makeTx();
    const r = await transitionVatInvoiceStatus({ prisma: makePrisma(tx), vatInvoiceId: 'VAT__1', input: { toStatus: 'Verified', deductionPeriod: '2026-08' } });
    expect(r.ok).toBe(true);
    const updated = tx.vatInvoice.update.mock.calls[0][0].data;
    expect(updated.status).toBe('Verified');
    expect(updated.verifiedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(updated.deductionPeriod).toBe('2026-08');
  });

  it('非法 deductionPeriod → INVALID_DATE', async () => {
    const { tx } = makeTx();
    const r = await transitionVatInvoiceStatus({ prisma: makePrisma(tx), vatInvoiceId: 'VAT__1', input: { toStatus: 'Verified', deductionPeriod: '2026-13-01' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_DATE');
  });

  it('Verified → Declared：挂有效 taxRefundId → 成功', async () => {
    const { tx } = makeTx({ existing: { ...EXISTING_RECEIVED, status: 'Verified' } });
    const r = await transitionVatInvoiceStatus({ prisma: makePrisma(tx), vatInvoiceId: 'VAT__1', input: { toStatus: 'Declared', taxRefundId: 'TR__1' } });
    expect(r.ok).toBe(true);
    const updated = tx.vatInvoice.update.mock.calls[0][0].data;
    expect(updated.status).toBe('Declared');
    expect(updated.taxRefundId).toBe('TR__1');
  });

  it('Verified → Declared：缺 taxRefundId → TAX_REFUND_REQUIRED', async () => {
    const { tx } = makeTx({ existing: { ...EXISTING_RECEIVED, status: 'Verified', taxRefundId: null } });
    const r = await transitionVatInvoiceStatus({ prisma: makePrisma(tx), vatInvoiceId: 'VAT__1', input: { toStatus: 'Declared' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('TAX_REFUND_REQUIRED');
  });

  it('Verified → Declared：taxRefund 不存在 → TAX_REFUND_NOT_FOUND', async () => {
    const { tx } = makeTx({ existing: { ...EXISTING_RECEIVED, status: 'Verified' }, taxRefund: null });
    const r = await transitionVatInvoiceStatus({ prisma: makePrisma(tx), vatInvoiceId: 'VAT__1', input: { toStatus: 'Declared', taxRefundId: 'TR__X' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('TAX_REFUND_NOT_FOUND');
  });

  it('Output 销项票 → Declared → NOT_INPUT_SPECIAL（退税仅进项专票）', async () => {
    const { tx } = makeTx({ existing: { ...EXISTING_RECEIVED, status: 'Verified', direction: 'Output' } });
    const r = await transitionVatInvoiceStatus({ prisma: makePrisma(tx), vatInvoiceId: 'VAT__1', input: { toStatus: 'Declared', taxRefundId: 'TR__1' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_INPUT_SPECIAL');
  });

  it('普票（Normal）→ Declared → NOT_INPUT_SPECIAL', async () => {
    const { tx } = makeTx({ existing: { ...EXISTING_RECEIVED, status: 'Verified', invoiceType: 'Normal' } });
    const r = await transitionVatInvoiceStatus({ prisma: makePrisma(tx), vatInvoiceId: 'VAT__1', input: { toStatus: 'Declared', taxRefundId: 'TR__1' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_INPUT_SPECIAL');
  });

  it('Received → Declared 跳级 → INVALID_TRANSITION', async () => {
    const { tx } = makeTx();
    const r = await transitionVatInvoiceStatus({ prisma: makePrisma(tx), vatInvoiceId: 'VAT__1', input: { toStatus: 'Declared', taxRefundId: 'TR__1' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_TRANSITION');
  });

  it('Declared → RedFlushed：红冲成功（写入红冲日期）', async () => {
    const { tx } = makeTx({ existing: { ...EXISTING_RECEIVED, status: 'Declared', taxRefundId: 'TR__1' } });
    const r = await transitionVatInvoiceStatus({ prisma: makePrisma(tx), vatInvoiceId: 'VAT__1', input: { toStatus: 'RedFlushed', redFlushNumber: 'RED0001' } });
    expect(r.ok).toBe(true);
    const updated = tx.vatInvoice.update.mock.calls[0][0].data;
    expect(updated.status).toBe('RedFlushed');
    expect(updated.redFlushNumber).toBe('RED0001');
    expect(updated.redFlushDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('RedFlushed 终态 → 任何转换 INVALID_TRANSITION', async () => {
    const { tx } = makeTx({ existing: { ...EXISTING_RECEIVED, status: 'RedFlushed' } });
    const r = await transitionVatInvoiceStatus({ prisma: makePrisma(tx), vatInvoiceId: 'VAT__1', input: { toStatus: 'Verified' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_TRANSITION');
  });

  it('非法 toStatus → INVALID_STATUS', async () => {
    const r = await transitionVatInvoiceStatus({ prisma: {} as any, vatInvoiceId: 'VAT__1', input: { toStatus: 'Flying' as any } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_STATUS');
  });
});

describe('C6 updateVatInvoice 编辑守卫', () => {
  it('Received 可修正票面（金额重校验）', async () => {
    const { tx } = makeTx();
    const r = await updateVatInvoice({ prisma: makePrisma(tx), vatInvoiceId: 'VAT__1', patch: { sellerName: '新销售方', deductionPeriod: '2026-08' } });
    expect(r.ok).toBe(true);
    const updated = tx.vatInvoice.update.mock.calls[0][0].data;
    expect(updated.sellerName).toBe('新销售方');
  });

  it('Declared → INVALID_STATUS（不可改）', async () => {
    const { tx } = makeTx({ existing: { ...EXISTING_RECEIVED, status: 'Declared' } });
    const r = await updateVatInvoice({ prisma: makePrisma(tx), vatInvoiceId: 'VAT__1', patch: { sellerName: 'X' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_STATUS');
  });

  it('patch 破坏三栏勾稽 → AMOUNT_MISMATCH', async () => {
    const { tx } = makeTx();
    const r = await updateVatInvoice({ prisma: makePrisma(tx), vatInvoiceId: 'VAT__1', patch: { totalAmount: 999999 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('AMOUNT_MISMATCH');
  });

  it('不存在 → NOT_FOUND', async () => {
    const { tx } = makeTx({ existing: null });
    const r = await updateVatInvoice({ prisma: makePrisma(tx), vatInvoiceId: 'VAT__X', patch: { sellerName: 'X' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
  });
});

describe('C6 deleteVatInvoice 删除守卫', () => {
  it('Received → 软删成功', async () => {
    const { tx } = makeTx();
    const r = await deleteVatInvoice({ prisma: makePrisma(tx), vatInvoiceId: 'VAT__1' });
    expect(r.ok).toBe(true);
    expect(tx.vatInvoice.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ deletedAt: expect.any(BigInt) }),
    }));
  });

  it('Declared → DELETE_FORBIDDEN（税务留痕，仅可红冲）', async () => {
    const { tx } = makeTx({ existing: { ...EXISTING_RECEIVED, status: 'Declared' } });
    const r = await deleteVatInvoice({ prisma: makePrisma(tx), vatInvoiceId: 'VAT__1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('DELETE_FORBIDDEN');
  });

  it('不存在 → NOT_FOUND', async () => {
    const { tx } = makeTx({ existing: null });
    const r = await deleteVatInvoice({ prisma: makePrisma(tx), vatInvoiceId: 'VAT__X' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
  });
});

describe('C6 listVatInvoices / getVatInvoice', () => {
  it('list：状态/方向/退税/期间组合过滤', async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: 'VAT__1' }]);
    const prisma: any = { vatInvoice: { findMany } };
    const r = await listVatInvoices(prisma, { status: 'Verified', direction: 'Input', taxRefundId: 'TR__1', from: '2026-08-01', to: '2026-08-31' });
    expect(r.total).toBe(1);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: 'Verified', direction: 'Input', taxRefundId: 'TR__1', deletedAt: null,
        issueDate: { gte: '2026-08-01', lte: '2026-08-31' },
      }),
    }));
  });

  it('get：存在返回，软删视为不存在', async () => {
    const prisma: any = { vatInvoice: { findUnique: vi.fn().mockResolvedValue({ ...EXISTING_RECEIVED, deletedAt: BigInt(1) }) } };
    const r = await getVatInvoice(prisma, 'VAT__1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
  });
});
