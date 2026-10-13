import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SYSTEM_AUDIT_ACTOR } from '../../audit/routeAudit';

/**
 * task ERP-P1-shipping-mutation-shared-service-foundation:
 * 验证 orderShipFlow.commitOrderShip 复用 createShipment service，
 * 不再直接调 tx.shipment.create / syncShipmentReferences / linkOrderStatusFromShipment / writeRouteAuditLog。
 */

// mock createShipment to observe orderShipFlow 调用
vi.mock('../../shipping/shipmentMutationService', () => ({
  createShipment: vi.fn(),
  updateShipment: vi.fn(),
  deleteShipment: vi.fn(),
  VALID_SHIPMENT_STATUSES: ['Draft', 'Booked', 'Loading', 'Shipped', 'Arrived', 'Cleared', 'Delivered', 'Cancelled'],
  isValidShipmentStatus: (s: string) => ['Draft', 'Booked', 'Loading', 'Shipped', 'Arrived', 'Cleared', 'Delivered', 'Cancelled'].includes(s),
}));

import { commitOrderShip, buildOrderShipDraft } from '../orderShipFlow';
import { createShipment } from '../../shipping/shipmentMutationService';

describe('task_mr1x1qkl: orderShipFlow.commitOrderShip 复用 createShipment（no bypass）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('成功 commit → createShipment 被调 1 次，what-you-approve-is-what-you-commit', async () => {
    const draft = buildOrderShipDraft({
      orderId: 'ORDER-1',
      shipment: { shipmentNumber: 'SHP001', type: 'sea', shippingMethod: 'ocean', status: 'Booked' },
    });
    (createShipment as any).mockResolvedValue({
      ok: true,
      data: { shipment: { id: 'SHP-new', status: 'Booked' }, orderStatus: 'Shipping', auditId: 'AL-1' },
    });
    const prisma: any = { $transaction: vi.fn() }; // 不应被使用（service 内部才有事务）
    // ★ B58：`actorId` 由 `toolDispatchRegistry` 从 `ApprovalRequest.requesterId` 注入进来
    const r = await commitOrderShip({ prisma, approvalId: 'AP-1', approvalPayload: { processDraft: draft }, actorId: 'usr_requester' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.feedback.status).toBe('committed');
      expect(r.feedback.shipmentId).toBe('SHP-new');
      expect(r.feedback.orderStatus).toBe('Shipping');
    }
    expect(createShipment).toHaveBeenCalledTimes(1);
    // 校验参数（what-you-approve-is-what-you-commit：input 从 draft.subOperations.after 恢复）
    const call = (createShipment as any).mock.calls[0][0];
    expect(call.input.orderId).toBe('ORDER-1');
    expect(call.input.shipmentNumber).toBe('SHP001');
    expect(call.input.status).toBe('Booked');
    // ★ B58：注入的请求人要一路传到 service 的审计身份；这里若落回 SYSTEM 就说明注入链断了
    expect(call.actorId).toBe('usr_requester');
    expect(call.actorId).not.toBe(SYSTEM_AUDIT_ACTOR);
    expect(call.auditSource).toBe('agent:order.ship:commit');
    expect(call.auditOperation).toBe('order_ship_committed');
    expect(call.syncSource).toBe('agent:order.ship');
    expect(call.generateIdIfMissing).toBe(true);
    // Agent path 不再自开 $transaction（在 service 内部）
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('service ORDER_NOT_FOUND → OrderShipError ORDER_NOT_FOUND', async () => {
    const draft = buildOrderShipDraft({
      orderId: 'MISSING',
      shipment: { shipmentNumber: 'SHP001', shippingMethod: 'ocean', status: 'Booked' },
    });
    (createShipment as any).mockResolvedValue({ ok: false, error: { code: 'ORDER_NOT_FOUND', message: 'not found' } });
    const r = await commitOrderShip({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('ORDER_NOT_FOUND');
  });

  it('service ORDER_TERMINAL → OrderShipError ORDER_TERMINAL', async () => {
    const draft = buildOrderShipDraft({
      orderId: 'ORDER-1',
      shipment: { shipmentNumber: 'SHP001', shippingMethod: 'ocean', status: 'Booked' },
    });
    (createShipment as any).mockResolvedValue({ ok: false, error: { code: 'ORDER_TERMINAL', message: 'terminal' } });
    const r = await commitOrderShip({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('ORDER_TERMINAL');
  });

  it('service INVALID_CURRENT_ORDER_STATUS → 映射为 OrderShipError 同码', async () => {
    const draft = buildOrderShipDraft({
      orderId: 'ORDER-1',
      shipment: { shipmentNumber: 'SHP001', shippingMethod: 'ocean', status: 'Booked' },
    });
    (createShipment as any).mockResolvedValue({ ok: false, error: { code: 'INVALID_CURRENT_ORDER_STATUS', message: 'bad status' } });
    const r = await commitOrderShip({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('INVALID_CURRENT_ORDER_STATUS');
  });

  it('service COMMIT_TRANSACTION_FAILED → 映射为同码（其余通用错误）', async () => {
    const draft = buildOrderShipDraft({
      orderId: 'ORDER-1',
      shipment: { shipmentNumber: 'SHP001', shippingMethod: 'ocean', status: 'Booked' },
    });
    (createShipment as any).mockResolvedValue({ ok: false, error: { code: 'CREATE_FAILED', message: 'boom' } });
    const r = await commitOrderShip({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('COMMIT_TRANSACTION_FAILED');
  });

  it('draft hash 篡改 → PROCESS_DRAFT_HASH_MISMATCH，createShipment 不被调', async () => {
    const draft = buildOrderShipDraft({
      orderId: 'ORDER-1',
      shipment: { shipmentNumber: 'SHP001', shippingMethod: 'ocean', status: 'Booked' },
    });
    const tampered = { ...draft, idempotencyKey: draft.idempotencyKey.replace(/pd:[0-9a-f]+/, 'pd:HACKED') };
    const r = await commitOrderShip({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: tampered } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
    expect(createShipment).not.toHaveBeenCalled();
  });
});
