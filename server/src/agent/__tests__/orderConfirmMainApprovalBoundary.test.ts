import { describe, expect, it, vi } from 'vitest';
import { buildOrderConfirmProcessDraft } from '../toolRegistry';
import { commitOrderConfirm } from '../commitTransaction';

describe('legacy agent confirmation preserves the main-order approval boundary', () => {
  it('cannot replace business main approval or automatically create its finance invoice', async () => {
    const snapshot = { orderId: 'exact-order', poNumber: 'SHARED-PO', status: 'Pending', amount: 2500,
      currency: 'USD', customerRelationId: 'customer', customerName: 'Synthetic customer', lineCount: 1 };
    const draft = buildOrderConfirmProcessDraft({ poNumber: snapshot.poNumber, previousStatus: 'Pending', newStatus: 'Confirmed', snapshot });
    expect(draft.subOperations[0].entityId).toBe('exact-order');
    const database = { order: { findMany: vi.fn().mockResolvedValue([{ id: snapshot.orderId }]),
      findFirst: vi.fn().mockResolvedValue({ id: snapshot.orderId, deletedAt: null }) },
      approvalRequest: { findFirst: vi.fn().mockResolvedValue(null) }, $transaction: vi.fn() };
    const result = await commitOrderConfirm({ prisma: database as any, approvalId: 'agent-process-approval',
      actorId: 'actual-user', approvalPayload: { processDraft: draft } });
    expect(result).toMatchObject({ ok: false, committed: false });
    expect(result.error).toContain('ORDER_MAIN_APPROVAL_REQUIRED');
    expect(database.$transaction).not.toHaveBeenCalled();
  });
});
