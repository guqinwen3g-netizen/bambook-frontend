import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { evaluateShortShipment } from '../shortShipmentGate';

type Association = { shipmentId: string; orderId: string; orderLineId: string | null;
  plannedQty: unknown; actualQty: unknown };
const allocation = (overrides: Partial<Association> = {}): Association => ({ shipmentId: 'S1',
  orderId: 'O1', orderLineId: 'L1', plannedQty: '100', actualQty: '100', ...overrides });
function storage(current: Association[], remaining: Association[] = []) {
  const lines = [{ id: 'L1', orderId: 'O1', quantity: 100, shipmentQuantity: 100, unit: 'M' },
    { id: 'L2', orderId: 'O2', quantity: 100, shipmentQuantity: 0, unit: 'M' }];
  const tx = {
    shipmentOrderAllocation: { findMany: vi.fn(async (args: any) => args.where.orderLineId
      ? [...current, ...remaining].filter(row => row.orderLineId === args.where.orderLineId) : current) },
    shipment: { findMany: vi.fn(async (args: any) => args.where.id.in.map((id: string) => ({ id, status: 'Booked' }))) },
    orderLine: { findUnique: vi.fn(async (args: any) => lines.find(line => line.id === args.where.id)),
      findMany: vi.fn(async (args: any) => lines.filter(line => args.where.orderId.in.includes(line.orderId))) },
    order: { findUnique: vi.fn(async () => ({ customerRelationId: null })) },
    systemConfig: { findUnique: vi.fn(async () => null) },
    relation: { findUnique: vi.fn(async () => null) },
    approvalRequest: { findFirst: vi.fn(async () => null) },
  };
  return { tx, lines };
}

describe('Modern physical short-shipment boundaries with original historical associations', () => {
  it('keeps a first partial departure independent of final production quantity even without a later draft ticket', async () => {
    const { tx, lines } = storage([allocation({ plannedQty: '5', actualQty: '4' })]);
    lines[0].quantity = 1000; lines[0].shipmentQuantity = 4;
    const result = await evaluateShortShipment(tx, { shipmentId: 'S1', physicalSource: true,
      quantityBasis: 'native_production_facts' });
    expect(result).toEqual({ blocked: [], approved: [], unfilled: [], noAllocationDetail: false, judgedLines: 0 });
    expect(tx.approvalRequest.findFirst).not.toHaveBeenCalled();
    expect(tx.order.findUnique).not.toHaveBeenCalled();
  });
  it('still refuses an unknown actual quantity after the accurate production gate passed', async () => {
    const { tx } = storage([allocation({ plannedQty: '5', actualQty: null })]);
    const result = await evaluateShortShipment(tx, { shipmentId: 'S1', physicalSource: true,
      quantityBasis: 'native_production_facts' });
    expect(result.unfilled.map(line => line.orderLineId)).toEqual(['L1']);
    expect(result.blocked).toEqual([]);
  });
  it('does not close an unrelated order merely retained as an exact zero/zero association', async () => {
    const { tx } = storage([allocation(), allocation({ orderId: 'O2', orderLineId: 'L2', plannedQty: '0.0000', actualQty: new Prisma.Decimal(0) })]);
    const result = await evaluateShortShipment(tx, { shipmentId: 'S1', physicalSource: true });
    expect(result).toEqual({ blocked: [], approved: [], unfilled: [], noAllocationDetail: false, judgedLines: 1 });
    expect(tx.orderLine.findUnique.mock.calls.map(([args]) => args.where.id)).toEqual(['L1']);
  });
  it('zero-only historical associations do not become dispatch detail', async () => {
    const { tx } = storage([allocation({ plannedQty: 0, actualQty: 0 })]);
    const result = await evaluateShortShipment(tx, { shipmentId: 'S1', physicalSource: true });
    expect(result.noAllocationDetail).toBe(true);
    expect(result.judgedLines).toBe(0);
  });
  it('keeps legacy zero actual quantities subject to the original shortage decision', async () => {
    const { tx, lines } = storage([allocation({ plannedQty: 0, actualQty: 0 })]);
    lines[0].shipmentQuantity = 0;
    const result = await evaluateShortShipment(tx, { shipmentId: 'S1' });
    expect(result.blocked.map(line => line.orderLineId)).toEqual(['L1']);
    expect(result.unfilled).toEqual([]);
  });
  it.each(['100', null, undefined, '-1', 'invalid'])('keeps a real or unresolved plan (%s) with zero actual quantity in the shortage gate', async plannedQty => {
    const { tx, lines } = storage([allocation({ plannedQty, actualQty: 0 })]);
    lines[0].shipmentQuantity = 0;
    const result = await evaluateShortShipment(tx, { shipmentId: 'S1', physicalSource: true });
    expect(result.blocked.map(line => line.orderLineId)).toEqual(['L1']);
    expect(result.noAllocationDetail).toBe(false);
  });
  it('keeps unknown actual quantity as missing detail even with a zero plan', async () => {
    const { tx } = storage([allocation({ plannedQty: 0, actualQty: null })]);
    const result = await evaluateShortShipment(tx, { shipmentId: 'S1', physicalSource: true });
    expect(result.unfilled.map(line => line.orderLineId)).toEqual(['L1']);
    expect(result.judgedLines).toBe(0);
  });
  it('does not let a different zero-only draft ticket defer a genuine short-shipment decision', async () => {
    const { tx, lines } = storage([allocation({ actualQty: '90' })], [allocation({ shipmentId: 'S2', plannedQty: '0', actualQty: '0' })]);
    lines[0].shipmentQuantity = 90;
    const result = await evaluateShortShipment(tx, { shipmentId: 'S1', physicalSource: true });
    expect(result.blocked.map(line => line.orderLineId)).toEqual(['L1']);
    expect(result.judgedLines).toBe(1);
  });
  it.each([['10', '0'], ['0', null], [null, '0']])('retains a genuine or unknown remaining draft plan (%s/%s)', async (plannedQty, actualQty) => {
    const { tx, lines } = storage([allocation({ actualQty: '90' })], [allocation({ shipmentId: 'S2', plannedQty, actualQty })]);
    lines[0].shipmentQuantity = 90;
    const result = await evaluateShortShipment(tx, { shipmentId: 'S1', physicalSource: true });
    expect(result.blocked).toEqual([]);
    expect(result.judgedLines).toBe(0);
  });
  it('keeps legacy remaining-ticket semantics unchanged', async () => {
    const { tx, lines } = storage([allocation({ actualQty: '90' })], [allocation({ shipmentId: 'S2', plannedQty: '0', actualQty: '0' })]);
    lines[0].shipmentQuantity = 90;
    const result = await evaluateShortShipment(tx, { shipmentId: 'S1' });
    expect(result.blocked).toEqual([]);
    expect(result.judgedLines).toBe(0);
  });
  it('zero whole-order history cannot expand modern dispatch to all lines of that order', async () => {
    const { tx } = storage([allocation(), allocation({ orderId: 'O2', orderLineId: null, plannedQty: 0, actualQty: 0 })]);
    const result = await evaluateShortShipment(tx, { shipmentId: 'S1', physicalSource: true });
    expect(result.blocked).toEqual([]);
    expect(result.judgedLines).toBe(1);
    expect(tx.orderLine.findMany).not.toHaveBeenCalled();
  });
});
