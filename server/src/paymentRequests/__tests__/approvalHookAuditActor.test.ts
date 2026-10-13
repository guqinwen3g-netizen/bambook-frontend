/**
 * 走查·DR-017 断链（2026-09-28 一手实测，见台账 补 53）：
 *   审批单决议通过 ⇒ 事件钩子回写付款申请 ⇒ 本应自动生成付款凭证。
 *   真库里实际发生的是：钩子把 `actorId: 'system_approval_hook'` 交下去，
 *   而 `AuditLog.actorId` 是 **NOT NULL 且带 FK → UserAccount(id)** 的列 ⇒ 审计写入撞外键，
 *   整段回写抛出，付款申请**永远停在 Pending**、凭证永远不发；
 *   而审批单那边已经是 approved —— 两份真源各说各话，用户端没有任何声音。
 *
 * ★ 这一族（哨兵 actorId vs FK）不是本件要一次改完的：仓里 103 处用哨兵写审计，
 *   持久解要么给 AuditLog 一个服务主体行、要么放开 NOT NULL/FK —— 属结构变更，已另立 §9 等拍。
 *   本件只把**已经当场砖死的钱路径**接回真源：决议人就是这次回写的行为人。
 *
 * 注意：假库不会验 FK，所以"用例绿"在这里不算证人；
 *   证人另有两条 —— 修前真库日志里那条 FK 报错（`AuditLog_actorId_fkey`），
 *   与修后真库重跑一整条链（申请→决议→凭证落地）。见台账 补 53。
 */
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { createPaymentRequestService } from '../paymentRequestService';

const APPROVER = 'usr_demo_boss';

function makePrisma() {
  const pr = {
    id: 'PAYR__1',
    requestNumber: 'PAYR-20260928-001',
    status: 'Pending',
    approvalRequestId: 'ar_1',
    applicantId: 'usr_demo_finance',
    reviewerId: APPROVER,
    ownerId: 'usr_demo_finance',
    supplierId: 'REL_SUP1',
    supplierName: '探针供应商',
    totalAmount: new Prisma.Decimal('777.0000'),
    currency: 'USD',
    paymentCategory: 'normal',
    requestDate: '2026-09-28',
    expectedPaymentDate: null,
    paymentVoucherId: null,
    attachments: null,
    remark: null,
    departmentId: null,
    deletedAt: null,
  };
  const auditCreate = vi.fn(async () => ({ id: 'AL-1' }));
  const prisma: any = {
    // This supplier-payment approval does not originate from a CN cash refund.
    creditNoteRefund: { findUnique: vi.fn().mockResolvedValue(null) },
    paymentRequest: {
      findUnique: vi.fn(async () => pr),
      // ★ 状态转移要如实建模：回写完再读同一行必须已经是新状态，
      //   否则"发凭证"这一步会被假库判成"尚未批准"，测的就不是产品了。
      update: vi.fn(async ({ data }: any) => { Object.assign(pr, data); return { ...pr }; }),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    approvalRequest: {
      // 决议人落在审批单行上（decide 端点写 reviewerId），钩子只拿得到 approvalId
      findUnique: vi.fn(async () => ({ id: 'ar_1', status: 'approved', reviewerId: APPROVER })),
    },
    paymentVoucher: {
      create: vi.fn(async ({ data }: any) => ({ ...data, id: 'PAY__NEW' })),
      findUnique: vi.fn(async () => null),
    },
    auditLog: { create: auditCreate },
    notification: { create: vi.fn(async ({ data }: any) => ({ ...data })) },
    notificationPreference: { findMany: vi.fn(async () => []) },
    entityReference: { upsert: vi.fn(async () => ({})) },
    entityLink: { upsert: vi.fn(async () => ({})), findMany: vi.fn(async () => []), update: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  };
  return { prisma, auditCreate, pr };
}

const stubApproval = { createBusinessApproval: vi.fn(async () => ({ id: 'ar_1' })) } as any;

describe('审批决议回写的审计行为人必须是决议人（不是哨兵字符串）', () => {
  it('钩子传下来的 actorId 是哨兵时，落到审计里的必须是审批单上的决议人', async () => {
    const { prisma, auditCreate } = makePrisma();
    const svc = createPaymentRequestService({ prisma, approvalCreateService: stubApproval });
    const res = await svc.syncApprovalDecision({ paymentRequestId: 'PAYR__1', actorId: 'system_approval_hook' });
    expect(res.ok).toBe(true);
    expect(auditCreate).toHaveBeenCalled();
    for (const call of auditCreate.mock.calls) {
      expect(call[0].data.actorId, '审计行为人不能是哨兵字符串').not.toBe('system_approval_hook');
      expect(call[0].data.actorId).toBe(APPROVER);
    }
  });

  it('★ 顺带把凭证那一路的归属也钉住：自动发的凭证 ownerId 必须是真实用户', async () => {
    const { prisma } = makePrisma();
    const svc = createPaymentRequestService({ prisma, approvalCreateService: stubApproval });
    const res: any = await svc.syncApprovalDecision({ paymentRequestId: 'PAYR__1', actorId: 'system_approval_hook' });
    expect(res.ok).toBe(true);
    expect(res.data.voucher, '审批通过后必须当场发出付款凭证').toBeTruthy();
    expect([APPROVER, 'usr_demo_finance']).toContain(res.data.voucher.ownerId);
  });

  it('★ 反面对照：没有决议人可考时不许伪造一个（宁可保留调用方给的真实 actor）', async () => {
    const { prisma, auditCreate } = makePrisma();
    prisma.approvalRequest.findUnique = vi.fn(async () => ({ id: 'ar_1', status: 'approved', reviewerId: null }));
    const svc = createPaymentRequestService({ prisma, approvalCreateService: stubApproval });
    const res = await svc.syncApprovalDecision({ paymentRequestId: 'PAYR__1', actorId: APPROVER });
    expect(res.ok).toBe(true);
    expect(auditCreate.mock.calls[0][0].data.actorId).toBe(APPROVER);
  });
});
