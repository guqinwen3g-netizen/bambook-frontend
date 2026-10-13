/**
 * §9 **B39** · `paymentRequests/paymentRequestService.ts` 两处出口的**执行覆盖**（R3 / §6 S1）
 *
 * 本批把这两处 ``fail(CODE, `…失败: ${String(e?.message ?? e)}`, 500)`` 换成字面中文。
 * 该文件**本来就有 `logger.error`**（实测 5 处）⇒ 与 shipping/samples 那几份不同，本批**不需要补日志**。
 *
 * ★★ **D52（形状相同 ≠ 文案相同）在本文件体现得最极端**：
 *   · `cancelPaymentRequest`（catch 在 `:517`）：`try` 内**唯一写**就是 `$transaction`（`:498`），
 *     之后只有 `logger.info` + `return` ⇒ **可以**承诺「本次未确认任何改动」；
 *   · `issueVoucherForApprovedRequest`（catch 在 `:415`）：这个 `try`（`:393`）里**根本没有 `$transaction`** ——
 *     凭证创建 `createPaymentVoucher`（`:367`）是**独立事务且已提交**，本 try 只做「回读 + 审计留痕」。
 *     ⇒ ① **绝对不许承诺零写入**（凭证确实已生成）；② **原文案「凭证关联事务失败」本身就是假结论**
 *     （不存在那个事务），本批改成如实告知「凭证已生成，仅关联登记未完成」，并说明重试安全
 *     （`:352` 命中既有凭证即幂等返回）。
 *
 * 出口链已核：`paymentRequestRoute.ts` 转发 `result.error.message`（与既有 `paymentRequestRoute.test.ts` 同口径）。
 *
 * 为什么单开文件：本用例需要 `vi.mock` 掉 `audit/routeAudit`（让 `:404` 那一次审计写抛错）
 * 与 `finance/paymentVoucherMutationService`（让凭证创建"成功"）—— 放进既有
 * `paymentRequestService.test.ts` 会改变该文件所有用例的行为。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../audit/routeAudit', () => ({ writeRouteAuditLog: vi.fn() }));
vi.mock('../../finance/paymentVoucherMutationService', () => ({
  createPaymentVoucher: vi.fn(),
  VALID_VOUCHER_CATEGORIES: [],
}));
vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { createPaymentRequestService, PAYMENT_REQUEST_ERRORS } from '../paymentRequestService';
import { writeRouteAuditLog } from '../../audit/routeAudit';
import { createPaymentVoucher } from '../../finance/paymentVoucherMutationService';
import { logger } from '../../lib/logger';

const B39_RAW = 'PrismaClientKnownRequestError: Invalid `prisma.$transaction()` invocation in '
  + '/srv/app/server/src/paymentRequests/paymentRequestService.ts:498 — '
  + 'Unique constraint failed on the fields: (`requestNumber`)';
const B39_FRAGMENTS = ['PrismaClient', 'prisma.$transaction', 'paymentRequestService.ts:498', 'Unique constraint', '/srv/app', 'P2002'];

const PR = {
  id: 'PAYR__1', requestNumber: 'PAYR-20260816-001', supplierId: 'REL_SUP1', supplierName: '供应商A',
  requestDate: '2026-08-16', expectedPaymentDate: null, totalAmount: '1000', currency: 'CNY',
  applicantId: 'u_sales', reviewerId: 'u_head', status: 'Approved', approvalRequestId: 'ar_1',
  paymentVoucherId: null, paymentCategory: 'normal', ownerId: 'u_sales', departmentId: null,
  remark: null, attachments: null, deletedAt: null,
};

function makePrisma(over: any = {}) {
  const row = { ...PR, ...over };
  const prisma: any = {
    // Preserve the ordinary supplier-payment scenario through the refund-source guard.
    creditNoteRefund: { findUnique: vi.fn().mockResolvedValue(null) },
    paymentRequest: {
      findUnique: async () => row,
      update: async ({ data }: any) => ({ ...row, ...data }),
    },
    paymentVoucher: { findUnique: async () => null },
    approvalRequest: { updateMany: async () => ({ count: 1 }) },
    $transaction: async (fn: any) => fn(prisma),
  };
  return prisma;
}

function expectCopy(msg: unknown, mustMention: string) {
  expect(typeof msg).toBe('string');
  const s = msg as string;
  expect(s.length, `文案过短（${s.length} 字）：${s}`).toBeGreaterThanOrEqual(20);
  expect(s, '必须含中文').toMatch(/[\u4e00-\u9fa5]/);
  expect(s, `必须说清对象：${s}`).toContain(mustMention);
  expect(s, `必须给下一步：${s}`).toMatch(/(稍后重试|联系管理员)/);
  expect(s.match(/[A-Za-z]{3,}/g) ?? [], `混入拉丁词（疑似原文上屏）：${s}`).toEqual([]);
}

describe('§9 B39 · 付款申请出口：内部原文不上屏', () => {
  it('★ issueVoucher 的后置步骤失败：**凭证已生成**，不得谎称"事务失败/零写入"，且要说明重试安全', async () => {
    const prisma = makePrisma({ status: 'Approved', paymentVoucherId: null });
    (createPaymentVoucher as any).mockResolvedValue({
      ok: true, data: { voucher: { id: 'PAY__NEW', voucherNumber: 'PV-2026-0001' } },
    });
    // 让 try（:393）里那一次审计写抛错 ⇒ 精确落在 B39 那处 catch（:415）
    (writeRouteAuditLog as any).mockRejectedValue(new Error(B39_RAW));

    const svc = createPaymentRequestService({ prisma } as any);
    const r = await svc.issueVoucherForApprovedRequest({ paymentRequestId: 'PAYR__1', actorId: 'u_sales' });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code, '码名不得随文案一起改').toBe(PAYMENT_REQUEST_ERRORS.VOUCHER_ISSUE_FAILED);
    const raw = JSON.stringify(r.error);
    for (const frag of B39_FRAGMENTS) expect(raw, `泄漏了「${frag}」`).not.toContain(frag);
    expectCopy(r.error.message, '凭证');
    // ★ D52：凭证是**独立事务、已提交**（createPaymentVoucher 在 :367）⇒ 不许承诺零写入
    expect(r.error.message, '凭证已生成 ⇒ 不得承诺零写入')
      .not.toMatch(/(没有写入任何数据|本次未确认任何改动|本次改动未生效)/);
    // ★ 而且要**纠正原文案的假结论**（原文案说"凭证关联事务失败"，那里根本没有事务）
    expect(r.error.message, '必须如实告知凭证已生成').toContain('已生成');
    expect(r.error.message, '必须说明重试安全（避免重复开凭证）').toMatch(/重试/);
    expect(logger.error, '原文必须仍进日志').toHaveBeenCalledWith(
      expect.stringContaining('[PaymentRequest]'), expect.objectContaining({ error: B39_RAW }));
  });

  it('★ cancelPaymentRequest 事务失败：可承诺零改动，且零原文', async () => {
    const prisma = makePrisma({ status: 'Pending', applicantId: 'u_sales' });
    prisma.$transaction = async () => { throw new Error(B39_RAW); };

    const svc = createPaymentRequestService({ prisma } as any);
    const r = await svc.cancelPaymentRequest({ paymentRequestId: 'PAYR__1', actorId: 'u_sales' });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe(PAYMENT_REQUEST_ERRORS.CREATE_FAILED);
    const raw = JSON.stringify(r.error);
    for (const frag of B39_FRAGMENTS) expect(raw, `泄漏了「${frag}」`).not.toContain(frag);
    expectCopy(r.error.message, '作废');
    expect(r.error.message, '唯一写是 $transaction ⇒ 可以承诺').toContain('本次未确认任何改动');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('[PaymentRequest]'), expect.objectContaining({ error: B39_RAW }));
  });
});
