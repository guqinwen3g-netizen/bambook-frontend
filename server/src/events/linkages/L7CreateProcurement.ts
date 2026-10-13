/** BOM confirmation creates unresolved procurement needs, never purchase quantities. */
import { businessEventBus } from '../businessEventBus';
import { createDemandsFromBOM } from '../../procurement/procurementDemandService';
import { isLinkageEnabled } from '../../config/automationConfig';

export function registerL7CreateProcurement(): void {
  businessEventBus.registerLinkage({
    id: 'L7_create_procurement', eventType: 'BOMConfirmed',
    idempotencyKey: e => `auto:L7:${e.sourceEntityId}`,
    execute: async (prisma, event) => {
      if (!isLinkageEnabled('L7_create_procurement')) return { ok: true, created: null };
      try { return { ok: true, created: await createDemandsFromBOM(prisma, event.sourceEntityId) }; }
      catch (e: any) { return { ok: false, error: e?.message || '采购需求生成失败' }; }
    },
  });
}
