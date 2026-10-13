import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { assertGarmentSizeAllocationAvailable, assertGarmentSizeSplit, garmentSizeBranchesCoverLine } from '../garmentSizeAllocation';

const contract = { S: 40, M: 60 };

describe('garment production branch size allocation', () => {
  it('allows partial factory allocations while preserving exact order-size totals', () => {
    const first = assertGarmentSizeAllocationAvailable(contract, [], { S: 20, M: 30 }, '50');
    const second = assertGarmentSizeAllocationAvailable(contract, [{ quantity: '50', sizeBreakdown: first }], { S: 20, M: 30 }, '50');
    expect(first).toEqual({ M: 30, S: 20 });
    expect(second).toEqual({ M: 30, S: 20 });
    expect(garmentSizeBranchesCoverLine(contract, [
      { quantity: '50', sizeBreakdown: first }, { quantity: '50', sizeBreakdown: second },
    ])).toBe(true);
  });

  it('rejects missing sizes, a size sum that differs from the planned branch, and cumulative over-allocation', () => {
    expect(() => assertGarmentSizeAllocationAvailable(contract, [], { S: 40 }, '40'))
      .toThrow('工厂尺码必须与订单行尺码完全一致');
    expect(() => assertGarmentSizeAllocationAvailable(contract, [], { S: 20, M: 30 }, '40'))
      .toThrow('尺码数量合计 50 必须等于订单条目数量 40');
    expect(() => assertGarmentSizeAllocationAvailable(contract, [{ quantity: '30', sizeBreakdown: { S: 30, M: 0 } }], { S: 20, M: 50 }, '70'))
      .toThrow('工厂尺码 S 的累计分配量不能超过订单数量 40');
  });

  it('does not accept unknown legacy branch allocation as confirmed size coverage', () => {
    expect(garmentSizeBranchesCoverLine(contract, [{ quantity: '100', sizeBreakdown: null }])).toBe(false);
  });

  it('reads native Decimal branch quantities without coercing arbitrary objects into quantities', () => {
    const first = { quantity: new Prisma.Decimal('50'), sizeBreakdown: { S: 20, M: 30 } };
    const second = assertGarmentSizeAllocationAvailable(contract, [first], { S: 20, M: 30 }, '50');
    expect(garmentSizeBranchesCoverLine(contract, [first, { quantity: new Prisma.Decimal('50'), sizeBreakdown: second }])).toBe(true);
    expect(() => assertGarmentSizeSplit({ quantity: new Prisma.Decimal('100'), sizeBreakdown: contract }, [first, first], contract)).not.toThrow();
    expect(() => assertGarmentSizeAllocationAvailable(contract, [{ ...first, quantity: { toString: () => '50' } }], second, '50'))
      .toThrow('不能转换空值或其他类型');
  });

  it('requires children to preserve every parent size quantity during a split', () => {
    const parent = { quantity: '100', sizeBreakdown: contract };
    expect(() => assertGarmentSizeSplit(parent, [
      { quantity: '50', sizeBreakdown: { S: 20, M: 30 } },
      { quantity: '50', sizeBreakdown: { S: 20, M: 30 } },
    ], contract)).not.toThrow();
    expect(() => assertGarmentSizeSplit(parent, [
      { quantity: '50', sizeBreakdown: { S: 30, M: 20 } },
      { quantity: '50', sizeBreakdown: { S: 15, M: 35 } },
    ], contract)).toThrow('拆分后的 S 码数量必须与父分支完全一致');
  });
});
