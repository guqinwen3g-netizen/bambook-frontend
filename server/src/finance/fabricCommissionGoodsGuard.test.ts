import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { assertGenericFabricGoodsReceivable, assertBusinessCiGoodsResponsibility } from './fabricCommissionGoodsGuard';

const normal = { id: 'normal', orderId: 'order', quantity: new Prisma.Decimal('100'), unitPrice: new Prisma.Decimal('2'),
  fabricSupplyMode: 'finished_purchase', fabricCommissionRate: null, fabricCommissionSupplierId: null };
const commission = { ...normal, id: 'commission', fabricSupplyMode: 'commission', fabricCommissionRate: '5', fabricCommissionSupplierId: 'supplier' };
const db = () => ({ orderLine: { findMany: async (input: { where: { id?: { in: string[] } } }) => input.where.id ? [normal, commission].filter(row => input.where.id!.in.includes(row.id)) : [normal, commission] } } as unknown as Prisma.TransactionClient);
describe('fabric commission goods AR boundary', () => {
  it('allows an accurately selected normal CI in the same mixed main order', async () => {
    await expect(assertBusinessCiGoodsResponsibility(db(), [{ orderLineId: 'normal', orderId: 'order', fabricSupplyMode: 'finished_purchase' }])).resolves.toBeUndefined();
  });
  it.each([{ ids: ['commission'] }, { ids: ['normal', 'commission'] }])('refuses selected commission trade goods %j', async ({ ids }) => {
    await expect(assertBusinessCiGoodsResponsibility(db(), ids.map(orderLineId => ({ orderLineId, orderId: 'order' })))).rejects.toMatchObject({ code: 'HANDOFF_CONFLICT' });
  });
  it('refuses stale or forged legacy CI terms that hide the live commission obligation', async () => {
    await expect(assertBusinessCiGoodsResponsibility(db(), [{ orderLineId: 'commission', orderId: 'order', fabricSupplyMode: null }])).rejects.toMatchObject({ code: 'HANDOFF_CONFLICT' });
    await expect(assertBusinessCiGoodsResponsibility(db(), [{ orderLineId: 'normal', orderId: 'another-order' }])).rejects.toMatchObject({ code: 'HANDOFF_CONFLICT' });
  });
  it('refuses opaque whole-order goods AR but allows exact normal line amount', async () => {
    await expect(assertGenericFabricGoodsReceivable(db(), { type: 'Receivable', orderId: 'order', amount: '400' })).rejects.toMatchObject({ code: 'HANDOFF_CONFLICT' });
    await expect(assertGenericFabricGoodsReceivable(db(), { type: 'Receivable', orderId: 'order', amount: '200', invoiceLines: [{ sourceType: 'OrderLine', sourceId: 'normal', amount: '200' }] })).resolves.toBeUndefined();
  });
  it.each([
    { invoiceLines: [{ sourceType: 'OrderLine', sourceId: 'commission', amount: '200' }] },
    { invoiceLines: [{ sourceType: 'Manual', sourceId: 'pretend-normal', amount: '200' }] },
    { invoiceLines: [{ sourceType: 'OrderLine', sourceId: 'normal', amount: '400' }] },
  ])('does not let %j disguise commission goods', async ({ invoiceLines }) => {
    await expect(assertGenericFabricGoodsReceivable(db(), { type: 'Receivable', orderId: 'order', amount: invoiceLines[0].amount, invoiceLines })).rejects.toMatchObject({ code: 'HANDOFF_CONFLICT' });
  });
});
