import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { exactJsonValue } from '../exactJsonValue';
import { physicalShipmentJson } from '../../shipping/shipmentPhysicalCommand';
import { physicalShipmentAllocationFingerprint } from '../../shipping/shipmentPhysicalConsumerService';
import { qcReportSourceFingerprint } from '../../qc/qcReportAuthority';

function applicationNumberJson<T>(work: () => T): T {
  const bigint = Object.getOwnPropertyDescriptor(BigInt.prototype, 'toJSON');
  const decimal = Object.getOwnPropertyDescriptor(Prisma.Decimal.prototype, 'toJSON');
  Object.defineProperty(BigInt.prototype, 'toJSON', { configurable: true, writable: true, value: function (this: bigint) { return Number(this); } });
  Object.defineProperty(Prisma.Decimal.prototype, 'toJSON', { configurable: true, writable: true, value: function (this: Prisma.Decimal) { return Number(this); } });
  try { return work(); }
  finally {
    if (bigint) Object.defineProperty(BigInt.prototype, 'toJSON', bigint);
    else delete (BigInt.prototype as any).toJSON;
    if (decimal) Object.defineProperty(Prisma.Decimal.prototype, 'toJSON', decimal);
    else delete (Prisma.Decimal.prototype as any).toJSON;
  }
}
const native = () => ({ id: 'SOA-1', updatedAt: BigInt('9007199254740993'), amount: new Prisma.Decimal('99999999999999.9999'),
  allocations: [{ actualQty: new Prisma.Decimal('12345678901234.0001'), plannedQty: new Prisma.Decimal('12345678901234.0002') }] });

describe('native source exact JSON under the actual application serialization contract', () => {
  it('preserves unsafe integer versions and four-place Decimal values recursively', () => {
    expect(physicalShipmentJson(native())).toEqual({ id: 'SOA-1', updatedAt: '9007199254740993', amount: '99999999999999.9999',
      allocations: [{ actualQty: '12345678901234.0001', plannedQty: '12345678901234.0002' }] });
  });
  it('produces the same frozen acknowledgement under index.ts Number toJSON overrides', () => {
    const facts = native(), before = physicalShipmentJson(facts);
    applicationNumberJson(() => {
      expect(physicalShipmentJson(facts)).toEqual(before);
      expect(qcReportSourceFingerprint(physicalShipmentJson(facts))).toBe(qcReportSourceFingerprint(before));
    });
    expect(facts.updatedAt).toBe(BigInt('9007199254740993'));
    expect(facts.amount.toString()).toBe('99999999999999.9999');
    expect(facts.allocations[0].actualQty).toBeInstanceOf(Prisma.Decimal);
  });
  it('preserves object omissions, array nulls, dates and ordinary JSON primitives', () => {
    const value = { omitted: undefined, entries: [undefined, null, false, 0, ''], date: new Date('2026-10-02T00:00:00.000Z') };
    applicationNumberJson(() => expect(physicalShipmentJson(value)).toEqual({ entries: [null, null, false, 0, ''], date: '2026-10-02T00:00:00.000Z' }));
    expect(value.omitted).toBeUndefined();
    expect(value.date).toBeInstanceOf(Date);
  });
  it('hashes the same immutable QC/native facts independently of global Decimal serialization', () => {
    const facts = native(), original = qcReportSourceFingerprint(facts);
    applicationNumberJson(() => {
      expect(qcReportSourceFingerprint(facts)).toBe(original);
      expect(qcReportSourceFingerprint(physicalShipmentJson(facts))).toBe(original);
    });
  });
  it('does not collapse distinct exact quantities that Number serialization rounds together', () => {
    const left = new Prisma.Decimal('99999999999999.9998'), right = new Prisma.Decimal('99999999999999.9999');
    expect(Number(left)).toBe(Number(right));
    applicationNumberJson(() => {
      expect(qcReportSourceFingerprint({ quantity: left })).not.toBe(qcReportSourceFingerprint({ quantity: right }));
      expect(exactJsonValue({ left, right })).toEqual({ left: '99999999999999.9998', right: '99999999999999.9999' });
    });
  });
  it('keeps allocation preview and original dispatch projection identical across native and wire values', () => {
    const facts: any = { shipment: { id: 'SH-1' }, orderIds: ['O-1'], allocations: [native()],
      physical: [{ id: 'SPA-1', actualQty: new Prisma.Decimal('0.0001'), updatedAt: BigInt('9007199254740993') }] };
    const original = physicalShipmentAllocationFingerprint(facts);
    applicationNumberJson(() => {
      expect(physicalShipmentAllocationFingerprint(facts)).toBe(original);
      expect(physicalShipmentAllocationFingerprint(physicalShipmentJson(facts))).toBe(original);
    });
  });
});
