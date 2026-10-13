/**
 * 走查·收付款：屏面「新建凭证」这条路开出来的收款凭证，"谁开的"必须落库
 *
 * 族谱（补 50/51）：B289 报价、B293 形式发票、B294 五族共用开票写口 —— 同一族的第四个落点是**凭证**。
 * `paymentVoucherMutationService` 的白名单 `PAYMENT_VOUCHER_CREATE_FIELDS` 里没有 `ownerId`，
 * 建数据那行也只拼 `{ id, ...normalized.data, voucherNumber, createdAt, updatedAt }` ⇒ 屏面新建的凭证恒无归属。
 * 现在不咬人是**因为凭证列表那份 v1 读口没实行级范围**（见 §9 B298）；一旦那处按 DR-042 补上，
 * 这批凭证会集体对创建者隐身 —— 归属要先落上，别让"看不见"变成补 scope 的代价。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createPaymentVoucher } from '../../finance/paymentVoucherMutationService';

function makePrisma() {
  const voucherCreate = vi.fn(async ({ data }: any) => ({ ...data, id: 'PAY__NEW' }));
  const prisma: any = {
    creditNoteRefund: { findUnique: vi.fn().mockResolvedValue(null) }, // Supplier-payment ownership, no refund source.
    paymentVoucher: {
      create: voucherCreate,
      update: vi.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
      findUnique: vi.fn(async () => ({ id: 'PAY__1', status: 'unreconciled', amount: '100', appliedAmount: null, deletedAt: null })),
    },
    paymentRequest: {
      findUnique: vi.fn(async ({ where }: any) => (where.id === 'PAYR__OK' ? { id: 'PAYR__OK', status: 'Approved', deletedAt: null } : null)),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    auditLog: { create: vi.fn(async () => ({ id: 'AL-1' })) },
    entityReference: { upsert: vi.fn(async () => ({})) },
    entityLink: { upsert: vi.fn(async () => ({})), findMany: vi.fn(async () => []), update: vi.fn(async () => ({})) },
  };
  prisma.$transaction = vi.fn(async (fn: any) => fn(prisma));
  return { prisma, voucherCreate };
}

const base = {
  type: 'Disbursement',
  amount: '100.0000',
  currency: 'CNY',
  paymentDate: '2026-09-28',
  paymentMethod: 'TT',
  paymentRequestId: 'PAYR__OK',
};

beforeEach(() => vi.clearAllMocks());

describe('createPaymentVoucher 落 ownerId（与报价／发票／开票写口同一规则）', () => {
  it('带 actorId → 凭证归属就是这个人的 id', async () => {
    const { prisma, voucherCreate } = makePrisma();
    const res = await createPaymentVoucher({ prisma, input: base as any, actorId: 'usr_demo_finance' });
    expect(res.ok).toBe(true);
    expect(voucherCreate.mock.calls[0][0].data.ownerId).toBe('usr_demo_finance');
  });

  it('没有 actorId（如 agent 路径漏传）→ 落 null，不凭空造归属', async () => {
    const { prisma, voucherCreate } = makePrisma();
    const res = await createPaymentVoucher({ prisma, input: base as any });
    expect(res.ok).toBe(true);
    expect(voucherCreate.mock.calls[0][0].data).toHaveProperty('ownerId', null);
  });

  it('★ actorId 是空串或纯空格 → 也算"没有归属"（不许往归属列写空串）', async () => {
    for (const bad of ['', '   ']) {
      const { prisma, voucherCreate } = makePrisma();
      const res = await createPaymentVoucher({ prisma, input: base as any, actorId: bad });
      expect(res.ok).toBe(true);
      expect(voucherCreate.mock.calls[0][0].data).toHaveProperty('ownerId', null);
    }
  });
});
