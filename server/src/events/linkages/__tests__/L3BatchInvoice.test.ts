import { beforeEach, describe, expect, it, vi } from 'vitest';

const { registerLinkage } = vi.hoisted(() => ({ registerLinkage: vi.fn() }));
vi.mock('../../businessEventBus', () => ({
  businessEventBus: { registerLinkage },
}));

import { registerL3IssueInvoice, issueShipmentInvoiceDrafts } from '../L3IssueInvoice';

describe('L3 ShipmentCompleted finance boundary', () => {
  beforeEach(() => registerLinkage.mockClear());

  it('registers a no-write compatibility handler for ShipmentCompleted', () => {
    registerL3IssueInvoice();
    expect(registerLinkage).toHaveBeenCalledTimes(1);
    expect(registerLinkage.mock.calls[0][0]).toMatchObject({ eventType: 'ShipmentCompleted' });
  });

  it('legacy shipment invoicing helper is read-free and returns no invoice', async () => {
    const prisma = { invoice: { create: vi.fn(), findFirst: vi.fn() }, $transaction: vi.fn() } as any;
    await expect(issueShipmentInvoiceDrafts(prisma, 'legacy-event')).resolves.toMatchObject({ ok: true, created: null });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.invoice.create).not.toHaveBeenCalled();
    expect(prisma.invoice.findFirst).not.toHaveBeenCalled();
  });
});
