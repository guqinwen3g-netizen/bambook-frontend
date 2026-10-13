import { Prisma } from '@prisma/client';

// A formal main order is a commercial commitment. Changes to that commitment
// belong to the original-order change approval, across both APIs and PDF apply.
const NOTE_AND_CONTACT_FIELDS = new Set([
  'specialInstructions', 'contactPerson', 'contactPhone', 'shipToPhone',
  'millContact', 'millPhone', 'consigneeContact', 'billToContact',
]);
const COMMAND_METADATA_FIELDS = new Set(['updatedAt', 'expectedUpdatedAt', 'fieldSources']);

export function samePersistedOrderField(previous: unknown, next: unknown): boolean {
  if (previous == null || next == null) return previous === next;
  if (Prisma.Decimal.isDecimal(previous)) {
    if (typeof next !== 'number' && typeof next !== 'string' && !Prisma.Decimal.isDecimal(next)) return false;
    if (typeof next === 'string' && !next.trim()) return false;
    try { return previous.equals(next as Prisma.Decimal.Value); } catch { return false; }
  }
  if (previous instanceof Date) {
    const timestamp = next instanceof Date ? next.getTime() : typeof next === 'string' ? Date.parse(next) : NaN;
    return Number.isFinite(timestamp) && previous.getTime() === timestamp;
  }
  if (typeof previous !== 'object' && typeof next !== 'object') return previous === next;
  const stable = (value: any): any => Array.isArray(value) ? value.map(stable)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  return JSON.stringify(stable(previous)) === JSON.stringify(stable(next));
}

export function assertOrderHeaderEditable(current: Record<string, unknown>, patch: Record<string, unknown>): void {
  const changed = Object.keys(patch).filter(field => patch[field] !== undefined
    && !COMMAND_METADATA_FIELDS.has(field) && !samePersistedOrderField(current[field], patch[field]));
  if (changed.includes('status')) throw conflict('订单状态请使用受控的状态流转操作。');
  if (current.status === 'Pending' || current.status === 'Draft') return;
  const commercial = changed.filter(field => !NOTE_AND_CONTACT_FIELDS.has(field));
  if (commercial.length) {
    throw conflict(`正式订单的商业内容须在原订单发起变更审批；本次未保存（${commercial.join('、')}）。`);
  }
}

function conflict(message: string): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(message), { code: 'CONFLICT', statusCode: 409 });
}
