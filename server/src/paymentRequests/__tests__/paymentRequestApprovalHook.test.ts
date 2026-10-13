import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  listeners: [] as Array<(approvalId: string, payload: { decision?: string }) => void>,
  syncApprovalDecision: vi.fn(),
  findPaymentRequest: vi.fn(),
  sendToUser: vi.fn(),
}));

vi.mock('../../agent/events', () => ({ approvalEventBus: {
  on: (event: string, listener: (approvalId: string, payload: { decision?: string }) => void) => {
    if (event === 'resolved') state.listeners.push(listener);
  },
} }));
vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../approvals/approvalRoutingService', () => ({ createApprovalRoutingService: vi.fn(() => ({})) }));
vi.mock('../../approvals/approvalCreateService', () => ({ createApprovalCreateService: vi.fn(() => ({})) }));
vi.mock('../paymentRequestService', () => ({ createPaymentRequestService: vi.fn(() => ({
  syncApprovalDecision: state.syncApprovalDecision,
})) }));
vi.mock('../../notifications/notificationService', () => ({ createNotificationService: vi.fn(() => ({
  sendToUser: state.sendToUser,
})) }));

import { registerPaymentRequestApprovalHook } from '../paymentRequestApprovalHook';

describe('payment request approval projection without actual cash', () => {
  const paymentRequest = { id: 'pr-id', requestNumber: 'PR-2026-001', applicantId: 'applicant',
    supplierName: 'Supplier', payeeType: 'Supplier', totalAmount: '9000.00', currency: 'USD' };
  const prisma: any = { paymentRequest: { findFirst: state.findPaymentRequest } };

  beforeEach(() => {
    state.listeners.length = 0;
    state.syncApprovalDecision.mockReset();
    state.findPaymentRequest.mockReset().mockResolvedValue(paymentRequest);
    state.sendToUser.mockReset().mockResolvedValue(null);
  });

  it('projects the approval without announcing an actual bank movement', async () => {
    state.syncApprovalDecision.mockResolvedValue({ ok: true, data: { synced: true,
      paymentRequest: { status: 'Approved' }, voucher: { id: 'voucher-id' } } });
    registerPaymentRequestApprovalHook({ prisma });

    state.listeners[0]('approval-id', { decision: 'approved' });
    await vi.waitFor(() => expect(state.syncApprovalDecision).toHaveBeenCalledOnce());
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(state.findPaymentRequest).toHaveBeenCalledWith({ where: { approvalRequestId: 'approval-id', deletedAt: null } });
    expect(state.syncApprovalDecision).toHaveBeenCalledWith({ paymentRequestId: 'pr-id', actorId: 'system_approval_hook' });
    expect(state.sendToUser).not.toHaveBeenCalled();
  });

  it('does not send a second decision notice when a rejected request has no voucher', async () => {
    state.syncApprovalDecision.mockResolvedValue({ ok: true, data: { synced: true,
      paymentRequest: { status: 'Rejected' }, voucher: null } });
    registerPaymentRequestApprovalHook({ prisma });

    state.listeners[0]('approval-id', { decision: 'rejected' });
    await vi.waitFor(() => expect(state.syncApprovalDecision).toHaveBeenCalledOnce());
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(state.sendToUser).not.toHaveBeenCalled();
  });
});
