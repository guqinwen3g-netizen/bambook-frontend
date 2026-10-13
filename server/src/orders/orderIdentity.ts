import { businessError, ERROR_CODES } from '../shared/errorCodes';
import { nextBusinessNumber } from '../shared/businessNumberService';

interface IdentityStore {
  order: { findMany(args: any): Promise<Array<{ id: string }>> };
}
export interface OrderReference {
  orderId?: string;
  orderCode?: string;
  poNumber?: string;
  businessLine?: string;
  customerRelationId?: string;
}

export function normalizeExternalPoNumber(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw businessError('INVALID_INPUT', '客户 PO/合同引用须为文本。');
  return value.trim() || null;
}

/** Resolve only inside the supplied data scope; an external PO can name several orders. */
export async function resolveOrderId(db: IdentityStore, reference: string | OrderReference,
  scope: Record<string, unknown> = {}): Promise<string | null> {
  const fields: Array<Record<string, string>> = [];
  if (typeof reference === 'string') {
    const value = reference.trim();
    if (!value) return null;
    fields.push({ id: value }, { code: value }, { poNumber: value });
  } else {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)) throw businessError('INVALID_INPUT', '请选择准确的内部订单。');
    for (const key of ['orderId', 'orderCode', 'poNumber', 'businessLine', 'customerRelationId'] as const) {
      if (reference[key] != null && typeof reference[key] !== 'string') throw businessError('INVALID_INPUT', '订单引用字段须为文本。');
    }
    const qualifiers: Record<string, string> = {};
    if (reference.businessLine?.trim()) qualifiers.businessLine = reference.businessLine.trim();
    if (reference.customerRelationId?.trim()) qualifiers.customerRelationId = reference.customerRelationId.trim();
    if (reference.orderId?.trim()) fields.push({ id: reference.orderId.trim() });
    else if (reference.orderCode?.trim()) fields.push({ code: reference.orderCode.trim() });
    else if (reference.poNumber?.trim()) fields.push({ poNumber: reference.poNumber.trim(), ...qualifiers });
  }
  for (const field of fields) {
    const matches = await db.order.findMany({ where: { deletedAt: null, ...field, AND: [scope] }, select: { id: true }, take: 2 });
    if (matches.length > 1) throw businessError('AMBIGUOUS_ORDER_REFERENCE', ERROR_CODES.AMBIGUOUS_ORDER_REFERENCE.message);
    if (matches.length === 1) return matches[0].id;
  }
  return null;
}

/** Called in the creation transaction. Customer PO values never occupy this number pool. */
export function allocateInternalOrderCode(db: Parameters<typeof nextBusinessNumber>[0] & {
  order: { findFirst(args: any): Promise<{ id: string } | null> };
}): Promise<string> {
  return nextBusinessNumber(db, 'ORD', undefined, {
    occupied: async code => (await db.order.findFirst({ where: { code }, select: { id: true } })) !== null,
  });
}
