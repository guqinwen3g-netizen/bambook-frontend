import type { Order, OrderLineLite } from '../types';
import type { FieldMeta, OrderClusterMeta } from './orderSchema';
import { getNextItemNo } from './orderLineItems';

export interface ManualOrderEntryItem { key: string; order: Partial<Order>; line: Partial<OrderLineLite>; }
export const MANUAL_ITEM_KEYS = new Set(['itemNo', 'productColorCode', 'clientCode', 'product', 'quantity', 'unit', 'fabricCode', 'fabricContent', 'width', 'gsm', 'materialCategory', 'materialSpecNotes', 'salesPrice', 'contractAmount', 'productionDate', 'clientDate']);
export function isManualItemField(field: FieldMeta): boolean { return field.level === 'line' || MANUAL_ITEM_KEYS.has(String(field.key)); }
export function newManualEntryItem(type: string, existing: ManualOrderEntryItem[] = []): ManualOrderEntryItem {
  return { key: crypto.randomUUID(), order: { itemNo: getNextItemNo(existing.map(item => item.order.itemNo)), unit: type === 'Garment' ? 'Pcs' : 'Meter' }, line: {} };
}
export function manualEntryLine(item: ManualOrderEntryItem): Partial<OrderLineLite> {
  const order = item.order;
  const extraNotes = [order.fabricCode && `面料编号：${order.fabricCode}`, order.materialSpecNotes].filter(Boolean).join('\n');
  return { ...item.line, itemNo: String(order.itemNo ?? '').trim(),
    materialCode: order.clientCode || undefined, millQuality: order.productColorCode || undefined,
    description: order.product || undefined, cloth: order.fabricContent || undefined, width: order.width || undefined,
    weight: order.gsm || undefined, category: order.materialCategory || undefined, notes: extraNotes || undefined,
    quantity: Number(order.quantity), unit: order.unit as OrderLineLite['unit'], unitPrice: order.salesPrice ?? undefined,
    netValue: order.contractAmount ?? undefined, exMillDate: order.clientDate || undefined, deliveryDate: order.productionDate || undefined };
}

export function mergeManualBasicSections(sections: Array<{ cluster: OrderClusterMeta; fields: FieldMeta[] }>) {
  const delivery = sections.find(section => section.cluster.id === 'delivery');
  return sections.filter(section => section.cluster.id !== 'delivery').map(section => section.cluster.id === 'basic'
    ? { ...section, fields: [...section.fields, ...(delivery?.fields ?? [])] } : section);
}
