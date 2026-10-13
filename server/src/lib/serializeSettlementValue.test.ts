import { expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { serializeSettlementValue } from './serializeSettlementValue';
it('serializes the full database monetary precision and nested facts without numeric rounding', () => {
  const fact = { amount: new Prisma.Decimal('99999999999999.1234'), createdAt: 1790850000000n,
    event: { items: [new Prisma.Decimal('0.0001'), null, 0n] }, date: new Date('2026-10-01T00:00:00Z') };
  expect(JSON.parse(JSON.stringify(serializeSettlementValue(fact)))).toEqual({ amount: '99999999999999.1234', createdAt: '1790850000000', event: { items: ['0.0001', null, '0'] }, date: '2026-10-01T00:00:00.000Z' });
});
