import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createProcurementService, type CreatePurchaseOrderInput, type MaterialReceiptInput } from './procurementService';
import { createMesService, type OutsourcingOrderInput } from '../mes/mesService';
import { createPurchaseServiceDeliveryService, type ServiceDeliveryInput } from './purchaseServiceDeliveryService';
import { buildProcurementCreateDraft, commitProcurementCreate } from '../agent/procurementFlow';

// A legacy bypass must fail before touching any database delegate. This is not
// a mock approved row, and it cannot silently use the default business database.
const noDatabase = new Proxy({} as PrismaClient, { get() { throw new Error('Legacy supplier writes must not access the database'); } });
describe('retired supplier mutation boundaries', () => {
  it('rejects all old purchase commercial/receipt writers before database work', async () => {
    const service = createProcurementService(noDatabase);
    const calls = [() => service.createPurchaseOrder({} as CreatePurchaseOrderInput, 'business'), () => service.updatePurchaseOrder('po', {}, 'business'),
      () => service.deletePurchaseOrder('po', 'business'), () => service.sendPurchaseOrder('po', 'business'), () => service.confirmPurchaseOrder('po', 'business'),
      () => service.cancelPurchaseOrder('po', 'business'), () => service.closePurchaseOrder('po', 'business'), () => service.transitionPurchaseOrderStatus('po', 'Sent', 'business'),
      () => service.createMaterialReceipt('po', {} as MaterialReceiptInput, 'business'), () => createPurchaseServiceDeliveryService(noDatabase).create('po', {} as ServiceDeliveryInput, 'business', null)];
    for (const call of calls) await expect(call()).rejects.toMatchObject({ code: 'NATIVE_SUPPLIER_COMMAND_REQUIRED', statusCode: 409 });
  });
  it('rejects legacy MES promises and business-filled accepted QC, including agent commit under a generic approval', async () => {
    const service = createMesService(noDatabase);
    const calls = [() => service.createOutsourcingOrder({} as OutsourcingOrderInput, 'business'), () => service.updateOutsourcingOrder('oso', {}, 'business'),
      () => service.deleteOutsourcingOrder('oso', 'business'), () => service.transitionOutsourcingStatus('oso', 'Sent', 'business'),
      () => service.receiveOutsourcing('oso', { qualityAcceptedQty: 100 }, 'business')];
    for (const call of calls) await expect(call()).rejects.toMatchObject({ code: 'NATIVE_SUPPLIER_COMMAND_REQUIRED', statusCode: 409 });
    const draft = buildProcurementCreateDraft({ input: { currency: 'CNY', orderDate: '2026-10-07', lines: [{ description: 'Exact pending material', quantity: 1, unit: 'M', unitPrice: 1 }] } });
    const result = await commitProcurementCreate({ prisma: noDatabase, approvalId: 'generic-tool-approval', approvalPayload: { processDraft: draft }, actorId: 'business' });
    expect(result).toMatchObject({ ok: false, feedback: { status: 'failed', error: { code: 'NATIVE_SUPPLIER_COMMAND_REQUIRED' } } });
  });
});
