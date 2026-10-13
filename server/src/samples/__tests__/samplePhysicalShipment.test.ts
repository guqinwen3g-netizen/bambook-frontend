import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), lock: vi.fn(), stable: vi.fn(), audit: vi.fn() }));
vi.mock('../sampleCustodyAuthorization', () => ({ authorizeSampleCustody: mocks.authorize,
  lockSampleCustodyGraph: mocks.lock, assertSampleCustodyGuardStable: mocks.stable }));
vi.mock('../../audit/routeAudit', () => ({ writeRouteAuditLog: mocks.audit }));
import { shipPhysicalSampleInTransaction } from '../samplePhysicalShipment';

const actor: any = { userId: 'user-1' };
function fixture(length = '2.7500') {
  const card: any = { id: 'card-1', batchId: 'batch-1', devCaseId: 'case-1', unit: '米', status: 'in_stock',
    sealedStatus: 'unsealed', quantity: 1, availableQty: 1, physicalLengthQty: length, availableLengthQty: length };
  const tx: any = { sampleCardItem: { findFirst: vi.fn(async () => card), update: vi.fn(async ({ data }: any) => Object.assign(card, data)) },
    sampleCardLoan: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null), create: vi.fn(async ({ data }: any) => data) } };
  const guard = { version: 1, actorId: 'user-1' };
  mocks.authorize.mockResolvedValue({ actor, guard, lockRefs: [], visibility: 'full' });
  mocks.lock.mockResolvedValue(undefined); mocks.stable.mockReturnValue(undefined); mocks.audit.mockResolvedValue('audit-1');
  return { tx, card, context: { source: { devCaseId: 'case-1', batchId: 'batch-1' }, eventId: 'dev-send-1' } };
}

describe('development physical shipment meter stock', () => {
  beforeEach(() => vi.clearAllMocks());
  it('deducts decimal meters and records a matching append-only loan in the same transaction', async () => {
    const f = fixture();
    const result = await shipPhysicalSampleInTransaction(f.tx, actor, { itemId: 'card-1', quantity: '1.25', recipientName: '客户' }, f.context);
    expect(result).toMatchObject({ quantity: '1.25', unit: '米', quantityAfter: '1.5', availableAfter: '1.5', archived: false });
    expect(f.tx.sampleCardLoan.create).toHaveBeenCalledWith({ data: expect.objectContaining({ loanType: 'ship', loanQuantity: 0, loanLength: '1.25' }) });
    expect(f.tx.sampleCardItem.update).toHaveBeenCalledWith({ where: { id: 'card-1' }, data: expect.objectContaining({ physicalLengthQty: '1.5', availableLengthQty: '1.5' }) });
    expect(f.card.physicalLengthQty).toBe('1.5');
    expect(f.card.availableLengthQty).toBe('1.5');
    expect(mocks.audit).toHaveBeenCalledOnce();
  });
  it('keeps meter total equal to available plus borrowed after a business shipment', async () => {
    const f = fixture('2.7500');
    await shipPhysicalSampleInTransaction(f.tx, actor, { itemId: 'card-1', quantity: '1.25', recipientName: '客户' }, f.context);
    expect(f.card.physicalLengthQty).toBe('1.5');
    expect(f.card.availableLengthQty).toBe('1.5');
  });
  it('rejects a meter shipment above the exact remaining length without creating an outflow', async () => {
    const f = fixture('0.5');
    await expect(shipPhysicalSampleInTransaction(f.tx, actor, { itemId: 'card-1', quantity: '0.5001', recipientName: '客户' }, f.context))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_QTY' });
    expect(f.tx.sampleCardLoan.create).not.toHaveBeenCalled();
    expect(f.tx.sampleCardItem.update).not.toHaveBeenCalled();
  });
  it.each([
    { label: 'legacy M unit', unit: 'M' },
    { label: 'stored length field', unit: 'PC', physicalLengthQty: '2.7500' },
  ])('uses meter stock for $label cards', async ({ unit, physicalLengthQty }) => {
    const f = fixture();
    f.card.unit = unit;
    if (physicalLengthQty) f.card.physicalLengthQty = f.card.availableLengthQty = physicalLengthQty;
    const result = await shipPhysicalSampleInTransaction(f.tx, actor, { itemId: 'card-1', quantity: '1.25', recipientName: '客户' }, f.context);
    expect(result).toMatchObject({ unit: '米', quantityAfter: '1.5', availableAfter: '1.5' });
    expect(f.tx.sampleCardLoan.create).toHaveBeenCalledWith({ data: expect.objectContaining({ loanType: 'ship', loanQuantity: 0, loanLength: '1.25' }) });
    expect(f.tx.sampleCardItem.update).toHaveBeenCalledWith({ where: { id: 'card-1' }, data: expect.objectContaining({ physicalLengthQty: '1.5', availableLengthQty: '1.5' }) });
  });
});
