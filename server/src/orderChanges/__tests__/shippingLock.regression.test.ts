import { describe, expect, it, vi } from 'vitest';
import {
  createOrderChangeRequestService,
  ORDER_CHANGE_ERRORS,
} from '../orderChangeRequestService';

/**
 * W1 交期锁死显式错误码回归测试（新增独立文件，禁止修改既有文件）
 *
 * 覆盖点（增量于既有 orderChangeRequestService.test.ts）：
 *   1. 申请时一次校验：Shipping/Delivered 状态 + changeType=delivery → ORDER_SHIPPING_LOCKED 409
 *   2. apply 前二次校验：审批期间订单推进到 Shipping/Delivered → ORDER_SHIPPING_LOCKED 409
 *   3. 负向边界：非 delivery 类型（quantity/customer/product/cancel/pause）不受 Shipping/Delivered 拦截
 *   4. 负向边界：Confirmed/Production 状态改交期 → 允许
 */

const VALID_REASON = '客户延迟确认产前样，需要调整订单内容';
const VALID_IMPACT = 'BOM 成本变化，回款延迟风险需评估';

function makePrisma(opts: { order?: any; changeRequest?: any } = {}) {
  const order =
    opts.order === undefined
      ? {
          id: 'ORD__1',
          status: 'Confirmed',
          deletedAt: null,
          quantity: 200,
          quoteAmount: 10000,
          totalNet: 10000,
          dueDate: '2026-10-05',
          customer: 'ABC',
          customerRelationId: 'REL_A',
          customerCode: 'ABC',
          product: 'Garment-X',
          poNumber: 'PO-001',
          salesContractNumber: null,
          finalContractNumber: null,
          createdAt: BigInt(0),
          updatedAt: BigInt(0),
        }
      : opts.order;

  const prisma: any = {
    order: {
      findUnique: vi.fn(
        async ({ where }: any) =>
          order && order.id === where.id ? order : null,
      ),
      update: vi.fn(
        async ({ where, data }: any) => ({ ...order, ...data, id: where.id }),
      ),
      findMany: vi.fn(async () => []),
    },
    orderChangeRequest: {
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }: any) => ({
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
      findUnique: vi.fn(
        async ({ where }: any) =>
          opts.changeRequest && opts.changeRequest.id === where.id
            ? opts.changeRequest
            : null,
      ),
      update: vi.fn(
        async ({ where, data }: any) => ({
          ...(opts.changeRequest ?? {}),
          ...data,
          id: where.id,
        }),
      ),
      findMany: vi.fn(async () =>
        opts.changeRequest ? [opts.changeRequest] : [],
      ),
    },
    orderStatusTransition: { create: vi.fn(async () => ({})) },
    approvalRequest: { updateMany: vi.fn(async () => ({ count: 1 })) },
    auditLog: { create: vi.fn(async () => ({ id: 'AL-1' })) },
    purchaseOrder: { count: vi.fn(async () => 0) },
    developmentCase: { findMany: vi.fn(async () => []) },
    productionStage: { count: vi.fn(async () => 0) },
    invoice: { count: vi.fn(async () => 0) },
    paymentVoucher: { count: vi.fn(async () => 0) },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  };
  return { prisma, order };
}

function makeService(prisma: any) {
  const createBusinessApproval = vi.fn(async (input: any) => ({
    id: 'ar_1',
    reviewerId: 'u_supervisor',
    status: 'pending',
    ...input,
  }));
  const service = createOrderChangeRequestService({
    prisma,
    approvalCreateService: { createBusinessApproval } as any,
  });
  return { service, createBusinessApproval };
}

describe('交期锁死回归测试（ORDER_SHIPPING_LOCKED 409）', () => {
  const baseCreateInput = {
    orderId: 'ORD__1',
    changeType: 'delivery' as const,
    beforeSnapshot: { dueDate: '2026-09-15' },
    afterDelta: { dueDate: '2026-09-25' },
    changeReason: VALID_REASON,
    impactSummary: VALID_IMPACT,
    requesterId: 'u_sales',
  };

  // ═══════════════════════════════════════════════════════════════
  // 申请时一次校验
  // ═══════════════════════════════════════════════════════════════
  describe('createChangeRequest — 申请时一次校验', () => {
    it('Shipping 状态改交期 → ORDER_SHIPPING_LOCKED 409', async () => {
      const { prisma } = makePrisma({
        order: { id: 'ORD__1', status: 'Shipping', deletedAt: null },
      });
      const { service } = makeService(prisma);
      const res = await service.createChangeRequest(baseCreateInput);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ORDER_CHANGE_ERRORS.ORDER_SHIPPING_LOCKED);
        expect(res.error.statusCode).toBe(409);
      }
    });

    it('Delivered 状态改交期 → ORDER_SHIPPING_LOCKED 409', async () => {
      const { prisma } = makePrisma({
        order: { id: 'ORD__1', status: 'Delivered', deletedAt: null },
      });
      const { service } = makeService(prisma);
      const res = await service.createChangeRequest(baseCreateInput);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ORDER_CHANGE_ERRORS.ORDER_SHIPPING_LOCKED);
        expect(res.error.statusCode).toBe(409);
      }
    });

    it('Confirmed 状态改交期 → 允许（不拦截）', async () => {
      const { prisma } = makePrisma({
        order: { id: 'ORD__1', status: 'Confirmed', deletedAt: null },
      });
      const { service } = makeService(prisma);
      const res = await service.createChangeRequest(baseCreateInput);
      expect(res.ok).toBe(true);
    });

    it('Production 状态改交期 → 允许（不拦截）', async () => {
      const { prisma } = makePrisma({
        order: { id: 'ORD__1', status: 'Production', deletedAt: null },
      });
      const { service } = makeService(prisma);
      const res = await service.createChangeRequest(baseCreateInput);
      expect(res.ok).toBe(true);
    });

    /**
     * ⓘ 标题修正（2026-09-18 · B3）：原题「锁死仅拦截 delivery 类型」**已过期** ——
     *   B3 把硬锁从「只锁交期」扩到 **delivery / price / quantity**（货已发还能改价改量 = 静默错账）。
     *   但**改量的判据不是「已出运就拒」**，而是「**改后数量 < 已出运量** 才拒」——
     *   减到不低于已出运量是**合法业务**（剩下的不发了）。
     *   本用例（无任何出运分配 ⇒ 已出运量 0；200 → 180）正属后者 ⇒ 仍应放行。
     *   新口径的完整守卫见 `changeRequestShippingLock.test.ts`（9 例，含「低于已出运量 → 拒」）。
     */
    it('Shipping 状态改数量（200 → 180，未低于已出运量）→ 允许（B3 判据：低于已出运量才拒）', async () => {
      const { prisma } = makePrisma({
        order: { id: 'ORD__1', status: 'Shipping', deletedAt: null },
      });
      const { service } = makeService(prisma);
      const res = await service.createChangeRequest({
        ...baseCreateInput,
        changeType: 'quantity',
        beforeSnapshot: { quantity: 200 },
        afterDelta: { quantity: 180 },
      });
      expect(res.ok).toBe(true);
    });

    it('Shipping 状态改客户（非 delivery）→ 允许', async () => {
      const { prisma } = makePrisma({
        order: { id: 'ORD__1', status: 'Shipping', deletedAt: null },
      });
      const { service } = makeService(prisma);
      const res = await service.createChangeRequest({
        ...baseCreateInput,
        changeType: 'customer',
        beforeSnapshot: { customerRelationId: 'REL_A' },
        afterDelta: { customerRelationId: 'REL_B' },
      });
      expect(res.ok).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // apply 前二次校验
  // ═══════════════════════════════════════════════════════════════
  describe('applyChangeRequest — apply 前二次校验', () => {
    const approvedDeliveryCr = {
      id: 'OCR_1',
      orderId: 'ORD__1',
      requestNumber: 'OCR-20260816-001',
      status: 'Approved',
      changeTypes: ['deliveryDate'],
      beforeSnapshot: { dueDate: '2026-09-15' },
      afterDelta: { dueDate: '2026-09-25' },
      approvalRequestId: 'ar_1',
      requesterId: 'u_sales',
      deletedAt: null,
      attachments: null,
    };

    it('审批期间订单推进到 Shipping → apply 被 ORDER_SHIPPING_LOCKED 409 拦截', async () => {
      const { prisma } = makePrisma({
        order: { id: 'ORD__1', status: 'Shipping', deletedAt: null },
        changeRequest: approvedDeliveryCr,
      });
      const { service } = makeService(prisma);
      const res = await service.applyChangeRequest({
        changeRequestId: 'OCR_1',
        appliedBy: 'u_supervisor',
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ORDER_CHANGE_ERRORS.ORDER_SHIPPING_LOCKED);
        expect(res.error.statusCode).toBe(409);
      }
    });

    it('审批期间订单推进到 Delivered → apply 被 ORDER_SHIPPING_LOCKED 409 拦截', async () => {
      const { prisma } = makePrisma({
        order: { id: 'ORD__1', status: 'Delivered', deletedAt: null },
        changeRequest: approvedDeliveryCr,
      });
      const { service } = makeService(prisma);
      const res = await service.applyChangeRequest({
        changeRequestId: 'OCR_1',
        appliedBy: 'u_supervisor',
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(ORDER_CHANGE_ERRORS.ORDER_SHIPPING_LOCKED);
        expect(res.error.statusCode).toBe(409);
      }
    });

    it('审批期间订单仍在 Confirmed → apply 允许（不拦截）', async () => {
      const { prisma } = makePrisma({
        order: { id: 'ORD__1', status: 'Confirmed', deletedAt: null },
        changeRequest: approvedDeliveryCr,
      });
      const { service } = makeService(prisma);
      const res = await service.applyChangeRequest({
        changeRequestId: 'OCR_1',
        appliedBy: 'u_supervisor',
      });
      expect(res.ok).toBe(true);
    });

    it('apply 前二次校验仅拦截 delivery 类型：quantity 变更不受 Shipping 状态影响', async () => {
      const { prisma } = makePrisma({
        order: { id: 'ORD__1', status: 'Shipping', deletedAt: null },
        changeRequest: {
          ...approvedDeliveryCr,
          changeTypes: ['quantity'],
          beforeSnapshot: { quantity: 200 },
          afterDelta: { quantity: 180 },
        },
      });
      const { service } = makeService(prisma);
      const res = await service.applyChangeRequest({
        changeRequestId: 'OCR_1',
        appliedBy: 'u_supervisor',
      });
      expect(res.ok).toBe(true);
    });
  });
});
