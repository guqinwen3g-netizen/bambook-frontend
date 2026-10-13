/**
 * L3 ShipmentCompleted deliberately does not create an Invoice.
 *
 * The business process now issues the commercial invoice in Logistics from
 * confirmed packing/shipment facts. Finance then registers that exact issued
 * CI as a receivable from its own inbox. Shipment completion is not financial
 * evidence and must never manufacture a receivable draft.
 *
 * Keep the named exports as a compatibility seam for older callers/tests; both
 * paths are intentionally read-free and write-free.
 */
import { businessEventBus } from '../businessEventBus';
import type { PrismaClient } from '@prisma/client';

const disabledResult = { ok: true, created: null, error: 'Finance registers an issued logistics CI; shipment completion creates no invoice.' };

export function registerL3IssueInvoice(): void {
  businessEventBus.registerLinkage({
    id: 'L3_issue_invoice',
    eventType: 'ShipmentCompleted',
    idempotencyKey: event => `no-finance-write:L3:${event.sourceEntityId}`,
    execute: async () => disabledResult,
  });
}

/** Deprecated compatibility API. It intentionally performs no DB reads/writes. */
export async function issueShipmentInvoiceDrafts(_prisma: PrismaClient, _eventId: string) {
  return disabledResult;
}
