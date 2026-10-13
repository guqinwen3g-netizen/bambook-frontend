import { normalizeGarmentSizeBreakdown } from '../orders/garmentSizeBreakdown';
import { Prisma } from '@prisma/client';

export class GarmentSizeAllocationError extends Error {
  constructor(message: string) { super(message); this.name = 'GarmentSizeAllocationError'; }
}

export type GarmentSizeMap = Record<string, number>;

export function normalizeBranchSizeBreakdown(value: unknown, quantity: unknown, contract: GarmentSizeMap): GarmentSizeMap {
  let normalized: GarmentSizeMap | null;
  // Stored native branches carry Prisma Decimal values. Convert only that
  // actual persistence type; request objects must still fail strict parsing.
  try { normalized = normalizeGarmentSizeBreakdown(value, quantity instanceof Prisma.Decimal ? quantity.toString() : quantity); }
  catch (error) { throw new GarmentSizeAllocationError(error instanceof Error ? error.message : '工厂尺码数量无效。'); }
  if (!normalized) throw new GarmentSizeAllocationError('含尺码的成衣生产分支必须逐码登记计划数量。');
  const expected = Object.keys(contract).sort(), actual = Object.keys(normalized).sort();
  if (expected.length !== actual.length || expected.some((size, index) => size !== actual[index]))
    throw new GarmentSizeAllocationError('工厂尺码必须与订单行尺码完全一致；没有生产的尺码填 0。');
  return Object.fromEntries(expected.map(size => [size, normalized[size]]));
}

export function assertGarmentSizeAllocationAvailable(
  contract: GarmentSizeMap,
  existingBranches: Array<{ quantity: unknown; sizeBreakdown?: unknown }>,
  incoming: GarmentSizeMap,
  incomingQuantity: unknown,
) {
  const allocated = Object.fromEntries(Object.keys(contract).map(size => [size, 0])) as GarmentSizeMap;
  for (const branch of existingBranches) {
    const map = normalizeBranchSizeBreakdown(branch.sizeBreakdown, branch.quantity, contract);
    for (const size of Object.keys(contract)) allocated[size] += map[size];
  }
  const next = normalizeBranchSizeBreakdown(incoming, incomingQuantity, contract);
  for (const size of Object.keys(contract)) {
    if (allocated[size] + next[size] > contract[size])
      throw new GarmentSizeAllocationError(`工厂尺码 ${size} 的累计分配量不能超过订单数量 ${contract[size]}。`);
  }
  return next;
}

export function assertGarmentSizeSplit(
  parent: { quantity: unknown; sizeBreakdown?: unknown },
  children: Array<{ quantity: unknown; sizeBreakdown?: unknown }>,
  contract: GarmentSizeMap,
) {
  const parentMap = normalizeBranchSizeBreakdown(parent.sizeBreakdown, parent.quantity, contract);
  const sums = Object.fromEntries(Object.keys(contract).map(size => [size, 0])) as GarmentSizeMap;
  for (const child of children) {
    const childMap = normalizeBranchSizeBreakdown(child.sizeBreakdown, child.quantity, contract);
    for (const size of Object.keys(contract)) sums[size] += childMap[size];
  }
  for (const size of Object.keys(contract)) {
    if (sums[size] !== parentMap[size])
      throw new GarmentSizeAllocationError(`拆分后的 ${size} 码数量必须与父分支完全一致。`);
  }
}

/** Returns true only when the active branches exactly cover the order-line
 * matrix; malformed, legacy-unknown or overallocated maps fail closed. */
export function garmentSizeBranchesCoverLine(
  contract: GarmentSizeMap,
  branches: Array<{ quantity: unknown; sizeBreakdown?: unknown }>,
) {
  if (!branches.length) return false;
  const totals = Object.fromEntries(Object.keys(contract).map(size => [size, 0])) as GarmentSizeMap;
  try {
    for (const branch of branches) {
      const map = normalizeBranchSizeBreakdown(branch.sizeBreakdown, branch.quantity, contract);
      for (const size of Object.keys(contract)) totals[size] += map[size];
    }
  } catch { return false; }
  return Object.keys(contract).every(size => totals[size] === contract[size]);
}
