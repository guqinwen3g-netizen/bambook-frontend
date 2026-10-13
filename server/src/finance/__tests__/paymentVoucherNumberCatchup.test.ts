/**
 * 走查·收款：屏面「新建凭证」当场 500（Unique constraint failed on `voucherNumber`）
 *
 * 真库实测（2026-09-28，:8090 走查实例，账号 usr_demo_finance）：
 *   POST /api/v1/finance/vouchers {type:'Receipt', amount:'1000.0000', currency:'USD', ...} → 500 CREATE_FAILED
 *   server/logs/bambook-error-2026-09-28.log ⇒ `tx.paymentVoucher.create()` …
 *     Unique constraint failed on the fields: (`voucherNumber`)
 *   库里已有 PV-2026-0001（09-27 走查造的演示数据），而 BusinessSequence **没有** SEQ_PV_2026 行
 *   ⇒ 取号从 seq=1 起 ⇒ 恒发 PV-2026-0001 ⇒ 撞号 ⇒ 整笔事务回滚 ⇒ 那行 seq 也没落库 ⇒ **永久 brick**
 *
 * 族：`nextBusinessNumber` 的「占用追平」（opts.occupied）在报价／发票／报关单／运单等 15 处已经做过
 * （先例注释见 customsService.ts:441「真库实测 100% 复现」），凭证这一处从未带上 —— 同族另 5 处见
 * businessNumberCallSiteCensus.test.ts。
 * 本件用**带 businessSequence 的假库**跑真取号实现（不能像 paymentVoucherOwner.test.ts 那样不给模型：
 * 不给模型会走 NODE_ENV=test 的时间戳降级，那一格恒不撞号，测不到东西）。
 */
import { describe, expect, it, vi } from 'vitest';
import { createPaymentVoucher } from '../../finance/paymentVoucherMutationService';

/** 假库：模拟「业务表已有 PV-2026-0001、序列表却是空的」这一真库状态 */
function makePrismaWithSequence(occupiedNumbers: string[]) {
  const seq: Record<string, number> = {};
  const voucherCreate = vi.fn(async ({ data }: any) => ({ ...data }));
  const findFirst = vi.fn(async ({ where }: any) =>
    occupiedNumbers.includes(String(where.voucherNumber)) ? { id: 'PAY__OCCUPIED' } : null,
  );
  const prisma: any = {
    businessSequence: {
      upsert: vi.fn(async ({ where, create }: any) => {
        if (seq[where.id] === undefined) seq[where.id] = create.seq;
        return { seq: seq[where.id] };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        seq[where.id] = (seq[where.id] ?? 0) + data.seq.increment;
        return { seq: seq[where.id] };
      }),
      findUnique: vi.fn(async ({ where }: any) => (seq[where.id] === undefined ? null : { seq: seq[where.id] })),
    },
    paymentVoucher: { create: voucherCreate, findFirst },
    paymentRequest: {
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    auditLog: { create: vi.fn(async () => ({ id: 'AL-1' })) },
    entityReference: { upsert: vi.fn(async () => ({})) },
    entityLink: { upsert: vi.fn(async () => ({})), findMany: vi.fn(async () => []), update: vi.fn(async () => ({})) },
  };
  prisma.$transaction = vi.fn(async (fn: any) => fn(prisma));
  return { prisma, voucherCreate, findFirst, seq };
}

const year = new Date().getFullYear();
const base = {
  type: 'Receipt',
  amount: '1000.0000',
  currency: 'USD',
  paymentDate: '2026-09-28',
  paymentMethod: 'TT',
};

describe('createPaymentVoucher 取号必须做占用追平（否则收款流程恒 500）', () => {
  it('PV-2026-0001 已被业务表占了 → 发下一号，而不是撞唯一键', async () => {
    const { prisma, voucherCreate } = makePrismaWithSequence([`PV-${year}-0001`]);
    const res = await createPaymentVoucher({ prisma, input: base as any, actorId: 'usr_demo_finance' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(voucherCreate.mock.calls[0][0].data.voucherNumber).toBe(`PV-${year}-0002`);
  });

  it('★ 追平时必须真去查过业务表（没查＝守卫没牙，恒发 0001 也照样"成功"）', async () => {
    const { prisma, findFirst } = makePrismaWithSequence([`PV-${year}-0001`]);
    const res = await createPaymentVoucher({ prisma, input: base as any, actorId: 'usr_demo_finance' });
    expect(res.ok).toBe(true);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ voucherNumber: `PV-${year}-0001` }) }),
    );
  });

  it('连续占号（0001、0002 都被占）→ 追到 0003', async () => {
    const { prisma, voucherCreate } = makePrismaWithSequence([`PV-${year}-0001`, `PV-${year}-0002`]);
    const res = await createPaymentVoucher({ prisma, input: base as any, actorId: 'usr_demo_finance' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(voucherCreate.mock.calls[0][0].data.voucherNumber).toBe(`PV-${year}-0003`);
  });
});
