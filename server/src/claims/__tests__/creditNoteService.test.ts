/**
 * creditNoteService 单测 —— 口径 A2（一张凭证 + 一次结算）· A3（独立状态）· A5（能撤销）
 *
 * ⚠️ 本套件的**承重**在于：退款单的状态推进**完全不依赖发票的 `Paid`** ——
 *   这正是现状卡死点的解药（`Invoice.amount ≤ 0` 永远到不了 `Paid`，
 *   导致贷项票永久挂在应收里污染账龄/逾期/信用额度）。
 *
 * ★ 2026-09-18（A3 少收销账闭环）：出口一（抵扣发票）同一事务落 `CreditNoteAllocation`
 *   + 经真源 recalcInvoiceStatus 重算发票状态（sumAppliedAmount = 收款 + 折让）。
 */
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  advanceCreditNoteStatus,
  applyCreditNote,
  cancelCreditNote,
  createCreditNote,
  listOpenCreditNotes,
} from '../creditNoteService';

/** 内存 mock：本服务用到的模型 + recalcInvoiceStatus / 授信·结案 helper 触到的最小面 */
function makePrisma(seed: any[] = []) {
  const creditNotes: any[] = [...seed];
  const invoices: any[] = [];
  const receiptAllocs: any[] = []; // InvoiceAllocation（收款核销）
  const cnAllocs: any[] = []; // CreditNoteAllocation（贷项票抵扣）
  const settlementEvents: any[] = [], audits: any[] = [];
  const seqs: Record<string, number> = {};
  const byInvoice = (rows: any[], where: any) =>
    rows.filter(r => (where.invoiceId == null || r.invoiceId === where.invoiceId)
      && (typeof where.creditNoteId === 'string' ? r.creditNoteId === where.creditNoteId : true)
      && (where.creditNoteId?.not != null ? r.creditNoteId !== where.creditNoteId.not : true));
  const matchesNote = (note: any, where: any): boolean => !where || Object.entries(where).every(([key, value]: any) => {
    if (key === 'AND') return value.every((part: any) => matchesNote(note, part));
    if (value && typeof value === 'object' && 'in' in value) return value.in.includes(note[key]);
    return (note[key] ?? null) === (value ?? null);
  });
  const prisma: any = {
    // These standalone CN offset/cancellation fixtures have no reserved or paid cash refunds.
    creditNoteRefund: { findMany: vi.fn().mockResolvedValue([]) },
    creditNote: {
      findFirst: vi.fn(async ({ where }: any) => creditNotes.find(n => n.creditNoteNumber === where.creditNoteNumber) ?? null),
      findUnique: vi.fn(async ({ where }: any) => creditNotes.find(n => n.id === where.id) ?? null),
      findMany: vi.fn(async ({ where, skip = 0, take = creditNotes.length }: any) =>
        creditNotes.filter(n => matchesNote(n, where)).slice(skip, skip + take)),
      count: vi.fn(async ({ where }: any) => creditNotes.filter(n => matchesNote(n, where)).length),
      aggregate: vi.fn(async ({ where }: any) => ({ _sum: { openAmount: creditNotes
        .filter(n => matchesNote(n, where))
        .reduce((sum, note) => sum.plus(note.openAmount), new Prisma.Decimal(0)) } })),
      create: vi.fn(async ({ data }: any) => { creditNotes.push(data); return data; }),
      update: vi.fn(async ({ where, data }: any) => {
        const i = creditNotes.findIndex(n => n.id === where.id);
        creditNotes[i] = { ...creditNotes[i], ...data };
        return creditNotes[i];
      }),
    },
    invoice: {
      findUnique: vi.fn(async ({ where }: any) => invoices.find(n => n.id === where.id) ?? null),
      update: vi.fn(async ({ where, data }: any) => {
        const i = invoices.findIndex(n => n.id === where.id);
        invoices[i] = { ...invoices[i], ...data };
        return invoices[i];
      }),
    },
    invoiceAllocation: {
      findMany: vi.fn(async ({ where }: any) => byInvoice(receiptAllocs, where)),
      upsert: vi.fn(async ({ where, update, create }: any) => {
        const i = receiptAllocs.findIndex(a => a.invoiceId === where.invoiceId_voucherId.invoiceId && a.voucherId === where.invoiceId_voucherId.voucherId);
        if (i >= 0) { receiptAllocs[i] = { ...receiptAllocs[i], ...update }; return receiptAllocs[i]; }
        receiptAllocs.push(create);
        return create;
      }),
    },
    creditNoteAllocation: {
      findMany: vi.fn(async ({ where }: any) => byInvoice(cnAllocs, where)),
      findUnique: vi.fn(async ({ where }: any) =>
        cnAllocs.find(a => a.creditNoteId === where.creditNoteId_invoiceId.creditNoteId && a.invoiceId === where.creditNoteId_invoiceId.invoiceId) ?? null),
      upsert: vi.fn(async ({ where, update, create }: any) => {
        const i = cnAllocs.findIndex(a => a.creditNoteId === where.creditNoteId_invoiceId.creditNoteId && a.invoiceId === where.creditNoteId_invoiceId.invoiceId);
        if (i >= 0) { cnAllocs[i] = { ...cnAllocs[i], ...update }; return cnAllocs[i]; }
        cnAllocs.push(create);
        return create;
      }),
    },
    creditNoteSettlementEvent: {
      findUnique: vi.fn(async ({ where }: any) => settlementEvents.find(row => row.creditNoteId === where.creditNoteId_requestId.creditNoteId && row.requestId === where.creditNoteId_requestId.requestId) ?? null),
      findMany: vi.fn(async ({ where }: any) => settlementEvents.filter(row => row.creditNoteId === where.creditNoteId)),
      create: vi.fn(async ({ data }: any) => { settlementEvents.push(data); return data; }),
    },
    auditLog: {
      findMany: vi.fn(async ({ where }: any) => audits.filter(row => Object.entries(where).every(([key, value]) => row[key] === value))),
      create: vi.fn(async ({ data }: any) => { audits.push(data); return data; }),
    },
    businessSequence: {
      upsert: vi.fn(async ({ where }: any) => {
        const id = where.id;
        seqs[id] = (seqs[id] ?? 0) + 1;
        return { id, seq: seqs[id] };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        seqs[where.id] = typeof data.seq?.increment === 'number' ? (seqs[where.id] ?? 0) + data.seq.increment : seqs[where.id];
        return { id: where.id, seq: seqs[where.id] };
      }),
      findUnique: vi.fn(async ({ where }: any) => (seqs[where.id] != null ? { id: where.id, seq: seqs[where.id] } : null)),
    },
    $queryRawUnsafe: vi.fn(async () => []),
    // Snapshot rollback only; this mock cannot prove PostgreSQL locks or concurrency.
    $transaction: vi.fn(async (fn: any) => {
      const stores = [creditNotes, invoices, receiptAllocs, cnAllocs, settlementEvents, audits];
      const before = stores.map(rows => rows.map(row => ({ ...row })));
      try { return await fn(prisma); } catch (error) {
        stores.forEach((rows, index) => rows.splice(0, rows.length, ...before[index]));
        throw error;
      }
    }),
    _notes: creditNotes,
    _invoices: invoices,
    _receiptAllocs: receiptAllocs,
    _cnAllocs: cnAllocs, _events: settlementEvents, _audits: audits,
  };
  return prisma;
}

describe('★ 口径 A3：余额 → 状态推进（纯函数）', () => {
  it('余额 = 原额 → Open（未核销）', () => {
    expect(advanceCreditNoteStatus('500', '500')).toBe('Open');
  });
  it('0 < 余额 < 原额 → PartiallyApplied（部分核销）', () => {
    expect(advanceCreditNoteStatus('500', '200')).toBe('PartiallyApplied');
  });
  it('★ 余额 = 0 → Closed（已结清）—— **结清判据是余额为 0，不是发票的 Paid**', () => {
    expect(advanceCreditNoteStatus('500', '0')).toBe('Closed');
  });
  it('余额 < 0（异常）→ 仍判 Closed（不让负余额悬空）', () => {
    expect(advanceCreditNoteStatus('500', '-1')).toBe('Closed');
  });
  it('Decimal 精度：0.3 − 0.1 − 0.1 = 0.1 不漂移', () => {
    expect(advanceCreditNoteStatus(new Prisma.Decimal('0.3'), new Prisma.Decimal('0.1'))).toBe('PartiallyApplied');
  });
});

describe('★ 口径 A2/A6：开单', () => {
  it('★ 承重：开单后 未核销余额 = 原额、状态 = Open、号取自 CLM 号段', async () => {
    const prisma = makePrisma();
    const r = await createCreditNote(prisma, { amount: 500, currency: 'USD', customerName: 'ACME' }, 'u1');
    expect(r.ok).toBe(true);
    expect(r.data!.creditNote.status).toBe('Open');
    expect(String(r.data!.creditNote.openAmount)).toBe('500');
    expect(r.data!.creditNote.creditNoteNumber).toMatch(/^CLM-\d{4}-\d{4}$/);
  });

  it('★ 口径 A6：0 元 / 负数 → 拒绝', async () => {
    const prisma = makePrisma();
    expect((await createCreditNote(prisma, { amount: 0, currency: 'USD' }, 'u1')).error?.code).toBe('VALIDATION_FAILED');
    expect((await createCreditNote(prisma, { amount: -5, currency: 'USD' }, 'u1')).error?.code).toBe('VALIDATION_FAILED');
  });

  it('缺币种 → 拒绝', async () => {
    const prisma = makePrisma();
    expect((await createCreditNote(prisma, { amount: 10, currency: '' }, 'u1')).error?.code).toBe('VALIDATION_FAILED');
  });

  it('★ 取号占用校验**含软删行**（同名已在库 ⇒ 递增避开，不撞唯一键）', async () => {
    const prisma = makePrisma([{ id: 'CN_x', creditNoteNumber: 'CLM-2026-0001' }]);
    const r = await createCreditNote(prisma, { amount: 10, currency: 'USD' }, 'u1');
    expect(r.ok).toBe(true);
    expect(r.data!.creditNote.creditNoteNumber).not.toBe('CLM-2026-0001');
  });
});

describe('★ 口径 A2：核销（一张凭证 + 一次结算）', () => {
  const makeInvoice = (prisma: any, over: any = {}) => {
    const inv = {
      id: 'INV_1', type: 'Receivable', status: 'Issued', currency: 'USD',
      amount: new Prisma.Decimal('300'), deletedAt: null, customerRelationId: 'R1',
      settlementDate: null, ...over,
    };
    prisma._invoices.push(inv);
    return inv;
  };
  const seeded = () => {
    const prisma = makePrisma([{
      id: 'CN_1', creditNoteNumber: 'CLM-2026-0001', amount: new Prisma.Decimal('500'),
      openAmount: new Prisma.Decimal('500'), status: 'Open', currency: 'USD', deletedAt: null,
    }]);
    return prisma;
  };

  it('★ 承重：部分核销 → 余额递减 + 状态 PartiallyApplied', async () => {
    const prisma = seeded();
    makeInvoice(prisma);
    const r = await applyCreditNote(prisma, 'CN_1', { appliedAmount: 200, toInvoiceId: 'INV_1' }, 'u1');
    expect(r.ok).toBe(true);
    expect(String(r.data!.creditNote.openAmount)).toBe('300');
    expect(r.data!.creditNote.status).toBe('PartiallyApplied');
    expect(r.data!.creditNote.appliedToInvoiceId).toBe('INV_1');
  });

  it('★ 承重：全额核销 → 余额 0 + 状态 Closed（CN 结清判据 = 余额为 0）', async () => {
    const prisma = seeded();
    makeInvoice(prisma, { amount: new Prisma.Decimal('500') });
    const r = await applyCreditNote(prisma, 'CN_1', { appliedAmount: 500, toInvoiceId: 'INV_1' }, 'u1');
    expect(String(r.data!.creditNote.openAmount)).toBe('0');
    expect(r.data!.creditNote.status).toBe('Closed');
  });

  it('★ 超额核销 → 拒绝（否则余额变负、状态机失去意义）', async () => {
    const prisma = seeded();
    const r = await applyCreditNote(prisma, 'CN_1', { appliedAmount: 600 }, 'u1');
    expect(r.error?.code).toBe('OVER_APPLIED');
  });

  it('已结清 / 已作废 → 不可再核销', async () => {
    const closed = makePrisma([{ id: 'CN_1', amount: new Prisma.Decimal('500'), openAmount: new Prisma.Decimal('0'), status: 'Closed', deletedAt: null }]);
    expect((await applyCreditNote(closed, 'CN_1', { appliedAmount: 1 }, 'u1')).error?.code).toBe('INVALID_STATE');
    const cancelled = makePrisma([{ id: 'CN_1', amount: new Prisma.Decimal('500'), openAmount: new Prisma.Decimal('500'), status: 'Cancelled', deletedAt: null }]);
    expect((await applyCreditNote(cancelled, 'CN_1', { appliedAmount: 1 }, 'u1')).error?.code).toBe('INVALID_STATE');
  });

  it('现金退款出口一期未实现 → 显式拒绝（不是静默忽略）', async () => {
    const prisma = seeded();
    expect((await applyCreditNote(prisma, 'CN_1', { appliedAmount: 100, refund: true }, 'u1')).error?.code).toBe('VALIDATION_FAILED');
  });
});

describe('★ A3 少收销账闭环：抵扣发票必须落发票侧', () => {
  const seeded = () => makePrisma([{
    id: 'CN_1', creditNoteNumber: 'CLM-2026-0001', amount: new Prisma.Decimal('500'),
    openAmount: new Prisma.Decimal('500'), status: 'Open', currency: 'USD', deletedAt: null,
  }]);
  const makeInvoice = (prisma: any, over: any = {}) => {
    const inv = {
      id: 'INV_1', type: 'Receivable', status: 'Issued', currency: 'USD',
      amount: new Prisma.Decimal('500'), deletedAt: null, customerRelationId: 'R1',
      settlementDate: null, ...over,
    };
    prisma._invoices.push(inv);
    return inv;
  };

  it('★ 承重：抵平发票 → 发票变 Paid + 写 CreditNoteAllocation（不再永久 PartiallyPaid）', async () => {
    const prisma = seeded();
    makeInvoice(prisma, { amount: new Prisma.Decimal('300') });
    const r = await applyCreditNote(prisma, 'CN_1', { appliedAmount: 300, toInvoiceId: 'INV_1' }, 'u1');
    expect(r.ok).toBe(true);
    // 发票侧：状态 Paid + 结算日期
    expect(prisma._invoices[0].status).toBe('Paid');
    expect(prisma._invoices[0].settlementDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // 核销明细：CN→发票 落了 CreditNoteAllocation
    expect(prisma._cnAllocs).toHaveLength(1);
    expect(prisma._cnAllocs[0].creditNoteId).toBe('CN_1');
    expect(String(prisma._cnAllocs[0].appliedAmount)).toBe('300');
    // 留痕
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  it('★ 分次抵扣：同对 (CN, 发票) upsert 覆盖累计额，部分抵扣 → 发票 PartiallyPaid', async () => {
    const prisma = seeded();
    makeInvoice(prisma, { amount: new Prisma.Decimal('400') });
    expect((await applyCreditNote(prisma, 'CN_1', { appliedAmount: 150, toInvoiceId: 'INV_1' }, 'u1')).ok).toBe(true);
    expect(prisma._invoices[0].status).toBe('PartiallyPaid');
    expect((await applyCreditNote(prisma, 'CN_1', { appliedAmount: 250, toInvoiceId: 'INV_1' }, 'u1')).ok).toBe(true);
    // 累计 400 = 票面 → Paid；明细仍只有一条（覆盖，不重复插）
    expect(prisma._invoices[0].status).toBe('Paid');
    expect(prisma._cnAllocs).toHaveLength(1);
    expect(String(prisma._cnAllocs[0].appliedAmount)).toBe('400');
    // CN 侧：500 − 150 − 250 = 100 剩余
    expect(String(prisma._notes[0].openAmount)).toBe('100');
    expect(prisma._notes[0].status).toBe('PartiallyApplied');
  });

  it('★ 抵扣超过发票剩余可抵额 → 拒绝 OVER_APPLIED（收款已核的部分同样占用）', async () => {
    const prisma = seeded();
    makeInvoice(prisma, { amount: new Prisma.Decimal('300') });
    prisma._receiptAllocs.push({ invoiceId: 'INV_1', voucherId: 'PAY_1', appliedAmount: new Prisma.Decimal('250') });
    const r = await applyCreditNote(prisma, 'CN_1', { appliedAmount: 100, toInvoiceId: 'INV_1' }, 'u1');
    expect(r.error?.code).toBe('OVER_APPLIED');
    expect(r.error!.message).toContain('剩余可抵');
    // 拒绝必须无副作用
    expect(prisma._cnAllocs).toHaveLength(0);
    expect(String(prisma._notes[0].openAmount)).toBe('500');
  });

  it('目标发票不存在 → 拒绝（出口存在性确认）', async () => {
    const prisma = seeded();
    const r = await applyCreditNote(prisma, 'CN_1', { appliedAmount: 100, toInvoiceId: 'INV_MISSING' }, 'u1');
    expect(r.error?.code).toBe('NOT_FOUND');
  });

  it('草稿 / 作废发票不可抵扣', async () => {
    const prisma = seeded();
    makeInvoice(prisma, { status: 'Draft' });
    expect((await applyCreditNote(prisma, 'CN_1', { appliedAmount: 100, toInvoiceId: 'INV_1' }, 'u1')).error?.code).toBe('INVALID_STATE');
    const p2 = seeded();
    makeInvoice(p2, { status: 'Cancelled' });
    expect((await applyCreditNote(p2, 'CN_1', { appliedAmount: 100, toInvoiceId: 'INV_1' }, 'u1')).error?.code).toBe('INVALID_STATE');
  });

  it('币种不一致 → 拒绝 CURRENCY_MISMATCH', async () => {
    const prisma = seeded();
    makeInvoice(prisma, { currency: 'EUR' });
    const r = await applyCreditNote(prisma, 'CN_1', { appliedAmount: 100, toInvoiceId: 'INV_1' }, 'u1');
    expect(r.error?.code).toBe('CURRENCY_MISMATCH');
  });

  it('应付票 / 形式票不可被贷项票抵扣（只对应收）', async () => {
    const prisma = seeded();
    makeInvoice(prisma, { type: 'Payable' });
    const r = await applyCreditNote(prisma, 'CN_1', { appliedAmount: 100, toInvoiceId: 'INV_1' }, 'u1');
    expect(r.error?.code).toBe('VALIDATION_FAILED');
    expect(r.error!.message).toContain('应收');
  });
});

describe('★ 口径 A5：作废（能撤销 + 留痕）', () => {
  const seeded = (status: string) => makePrisma([{
    id: 'CN_1', amount: new Prisma.Decimal('500'), openAmount: new Prisma.Decimal('500'),
    status, currency: 'USD', deletedAt: null,
  }]);

  it('★ 承重：未核销（Open）可作废 + 留痕（时间/人/理由）', async () => {
    const prisma = seeded('Open');
    const r = await cancelCreditNote(prisma, 'CN_1', '客户撤诉', 'u1');
    expect(r.ok).toBe(true);
    expect(r.data!.creditNote.status).toBe('Cancelled');
    expect(r.data!.creditNote.cancelledBy).toBe('u1');
    expect(r.data!.creditNote.cancelReason).toBe('客户撤诉');
    expect(r.data!.creditNote.cancelledAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('★ 承重：**已发生核销的单不可作废**（必须先反核销，否则账实不符）', async () => {
    const prisma = seeded('PartiallyApplied');
    const r = await cancelCreditNote(prisma, 'CN_1', '试试', 'u1');
    expect(r.error?.code).toBe('INVALID_STATE');
    expect(r.error!.message).toContain('反核销');
  });

  it('作废必须填理由', async () => {
    const prisma = seeded('Open');
    expect((await cancelCreditNote(prisma, 'CN_1', '   ', 'u1')).error?.code).toBe('VALIDATION_FAILED');
  });
});

describe('★ 未结清退款单列表', () => {
  it('只含未结清（Open/PartiallyApplied），已结清与已作废不计入', async () => {
    const prisma = makePrisma([
      { id: 'A', amount: new Prisma.Decimal('500'), openAmount: new Prisma.Decimal('500'), status: 'Open', customerRelationId: 'R1', deletedAt: null },
      { id: 'B', amount: new Prisma.Decimal('500'), openAmount: new Prisma.Decimal('200'), status: 'PartiallyApplied', customerRelationId: 'R1', deletedAt: null },
      { id: 'C', amount: new Prisma.Decimal('500'), openAmount: new Prisma.Decimal('0'), status: 'Closed', customerRelationId: 'R1', deletedAt: null },
      { id: 'D', amount: new Prisma.Decimal('500'), openAmount: new Prisma.Decimal('500'), status: 'Cancelled', customerRelationId: 'R1', deletedAt: null },
    ]);
    const r = await listOpenCreditNotes(prisma, { customerRelationId: 'R1' });
    expect(r.data!.items.map((n: any) => n.id).sort()).toEqual(['A', 'B']);
    expect(r.data!.totalOpen).toBe('700');
  });
});


describe('核销意图、真实出口和不可变事件（存储替身，不代表 PG 并发）', () => {
  function setup() {
    const prisma = makePrisma([{ id: 'CN_1', creditNoteNumber: 'CLM-2026-0100', amount: new Prisma.Decimal(500), openAmount: new Prisma.Decimal(500), status: 'Open', currency: 'USD', deletedAt: null }]);
    prisma._invoices.push({ id: 'INV_1', type: 'Receivable', status: 'Issued', currency: 'USD', amount: new Prisma.Decimal(1000), deletedAt: null });
    return prisma;
  }
  it('没有发票或真实现金出口时拒绝扣余额，不产生金融事件', async () => {
    const prisma = setup();
    expect((await applyCreditNote(prisma, 'CN_1', { appliedAmount: 100 }, 'u1')).error?.code).toBe('VALIDATION_FAILED');
    expect(String(prisma._notes[0].openAmount)).toBe('500');
    expect(prisma._cnAllocs).toHaveLength(0); expect(prisma._events).toHaveLength(0);
  });
  it('同请求在 Closed 后只读返回原事件；改金额、目标、主体拒绝，同新 ID 冲突', async () => {
    const prisma = setup(), input = { appliedAmount: 500, toInvoiceId: 'INV_1', clientRequestId: 'OFFSET_1' };
    const first = await applyCreditNote(prisma, 'CN_1', input, 'u1');
    expect(first.data!.creditNote.status).toBe('Closed');
    const auditCount = prisma._audits.length;
    const replay = await applyCreditNote(prisma, 'CN_1', input, 'u1');
    expect(replay.data!.settlementEvent.id).toBe(first.data!.settlementEvent.id); expect(replay.data!.replayed).toBe(true);
    expect(prisma._events).toHaveLength(1); expect(prisma._audits).toHaveLength(auditCount);
    expect((await applyCreditNote(prisma, 'CN_1', { ...input, appliedAmount: 499 }, 'u1')).error?.code).toBe('INVALID_STATE');
    expect((await applyCreditNote(prisma, 'CN_1', { ...input, toInvoiceId: 'OTHER' }, 'u1')).error?.code).toBe('INVALID_STATE');
    expect((await applyCreditNote(prisma, 'CN_1', input, 'other')).error?.code).toBe('INVALID_STATE');
    expect((await applyCreditNote(prisma, 'CN_1', { ...input, clientRequestId: 'NEW' }, 'u1')).error?.code).toBe('INVALID_STATE');
    expect(String(prisma._notes[0].openAmount)).toBe('0'); expect(String(prisma._cnAllocs[0].appliedAmount)).toBe('500');
  });
  it('同 CN 先前抵扣也占发票余额，不能因排除自己而超额抵扣', async () => {
    const prisma = setup(); prisma._invoices[0].amount = new Prisma.Decimal(300);
    expect((await applyCreditNote(prisma, 'CN_1', { appliedAmount: 200, toInvoiceId: 'INV_1', clientRequestId: 'ONE' }, 'u1')).ok).toBe(true);
    expect((await applyCreditNote(prisma, 'CN_1', { appliedAmount: 150, toInvoiceId: 'INV_1', clientRequestId: 'TWO' }, 'u1')).error?.code).toBe('OVER_APPLIED');
    expect(prisma._events).toHaveLength(1); expect(String(prisma._notes[0].openAmount)).toBe('300');
    expect(String(prisma._cnAllocs[0].appliedAmount)).toBe('200');
  });
  it('必需事件审计失败让账户、事件、净核销和发票状态同时回滚', async () => {
    const prisma = setup(), fault = Object.assign(new Error('required-settlement-audit-failed'), { code: 'P2003' });
    const original = prisma.auditLog.create;
    prisma.auditLog.create = vi.fn(async (args: any) => { if (args.data.action === 'CREDIT_NOTE_SETTLED') throw fault; return original(args); });
    await expect(applyCreditNote(prisma, 'CN_1', { appliedAmount: 500, toInvoiceId: 'INV_1', clientRequestId: 'FAIL' }, 'u1')).rejects.toBe(fault);
    expect(String(prisma._notes[0].openAmount)).toBe('500'); expect(prisma._notes[0].status).toBe('Open');
    expect(prisma._events).toHaveLength(0); expect(prisma._cnAllocs).toHaveLength(0); expect(prisma._audits).toHaveLength(0);
    expect(prisma._invoices[0].status).toBe('Issued');
  });
  it('不可精确存入 Decimal(18,4) 的金额在写事件前拒绝，不靠数据库静默舍入', async () => {
    const prisma = setup();
    expect((await applyCreditNote(prisma, 'CN_1', { appliedAmount: '0.00001', toInvoiceId: 'INV_1', clientRequestId: 'ROUND' }, 'u1')).error?.code).toBe('VALIDATION_FAILED');
    expect(prisma._events).toHaveLength(0); expect(String(prisma._notes[0].openAmount)).toBe('500');
  });
});
