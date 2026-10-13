import { businessEventBus } from '../businessEventBus';

/** Preserve the linkage identity and its historical executions. Confirming an
 * order no longer creates ten future workspaces or a production conclusion.
 * Actual batches, samples, formal QC and completions have native producers. */
export function registerL1InitProduction(): void {
  businessEventBus.registerLinkage({
    id: 'L1_init_production',
    eventType: 'OrderConfirmed',
    idempotencyKey: event => `auto:L1:${event.orderId ?? event.sourceEntityId}`,
    execute: async () => ({ ok: true, created: null, reason: 'retired_legacy_pipeline' }),
  });
}
