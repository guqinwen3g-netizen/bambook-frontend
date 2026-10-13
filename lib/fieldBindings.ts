import type { Order } from '../types';
import type { EntityType } from './entityRegistry';

export type FillStrategy = 'empty-only' | 'confirm-overwrite';

export interface FieldBinding {
  fieldKey: keyof Order;
  schemaVersion: number;
  entityTypes: EntityType[];
  fillGroup: string;
  fillStrategy: FillStrategy;
  preserveUserEdited: boolean;
  description: string;
}

export const FIELD_BINDINGS_VERSION = '2026-05-09';

export const ORDER_FIELD_BINDINGS: FieldBinding[] = [
  {
    fieldKey: 'customer',
    schemaVersion: 1,
    entityTypes: ['relation.organization'],
    fillGroup: 'customerParty',
    fillStrategy: 'empty-only',
    preserveUserEdited: true,
    description: 'Customer organization source; fills customer address, contact, terms, and sales currency.',
  },
  {
    fieldKey: 'millName',
    schemaVersion: 1,
    entityTypes: ['relation.organization'],
    fillGroup: 'millParty',
    fillStrategy: 'empty-only',
    preserveUserEdited: true,
    description: 'Supplier/mill organization source; fills mill contact and address.',
  },
  {
    fieldKey: 'consigneeName',
    schemaVersion: 1,
    entityTypes: ['relation.organization'],
    fillGroup: 'consigneeParty',
    fillStrategy: 'empty-only',
    preserveUserEdited: true,
    description: 'Ship-to organization source; fills consignee address and contact.',
  },
  {
    fieldKey: 'billToName',
    schemaVersion: 1,
    entityTypes: ['relation.organization'],
    fillGroup: 'billToParty',
    fillStrategy: 'empty-only',
    preserveUserEdited: true,
    description: 'Bill-to organization source; fills billing address, contact, and terms.',
  },
  {
    fieldKey: 'salesPerson',
    schemaVersion: 1,
    entityTypes: ['relation.person'],
    fillGroup: 'internalTeam',
    fillStrategy: 'empty-only',
    preserveUserEdited: true,
    description: 'Internal sales person source.',
  },
  {
    fieldKey: 'merchandiser',
    schemaVersion: 1,
    entityTypes: ['relation.person'],
    fillGroup: 'internalTeam',
    fillStrategy: 'empty-only',
    preserveUserEdited: true,
    description: 'Internal merchandiser source.',
  },
  {
    fieldKey: 'supervisor',
    schemaVersion: 1,
    entityTypes: ['relation.person'],
    fillGroup: 'internalTeam',
    fillStrategy: 'empty-only',
    preserveUserEdited: true,
    description: 'Internal supervisor source.',
  },
  {
    fieldKey: 'clientCode',
    schemaVersion: 1,
    entityTypes: ['product.customerCode', 'product.asset', 'product.fabricProfile', 'order.line'],
    fillGroup: 'fabricIdentity',
    fillStrategy: 'empty-only',
    preserveUserEdited: true,
    description: 'Customer-owned product/fabric code; FabricCustomerCode is source of truth and order lines are hints.',
  },
  {
    fieldKey: 'productColorCode',
    schemaVersion: 1,
    entityTypes: ['product.fabricProfile', 'product.customerCode', 'product.asset', 'order.line'],
    fillGroup: 'fabricIdentity',
    fillStrategy: 'empty-only',
    preserveUserEdited: true,
    description: 'Mill quality or color code; FabricProfile is source of truth and order lines are hints.',
  },
  {
    fieldKey: 'fabricCode',
    schemaVersion: 1,
    entityTypes: ['product.fabricProfile', 'product.asset', 'product.customerCode', 'order.line'],
    fillGroup: 'fabricIdentity',
    fillStrategy: 'empty-only',
    preserveUserEdited: true,
    description: 'Fabric article/code source through FabricProfile/ProductAsset.',
  },
];

const BINDINGS_BY_FIELD = new Map(ORDER_FIELD_BINDINGS.map((binding) => [String(binding.fieldKey), binding]));

export function getFieldBinding(fieldKey: keyof Order | string): FieldBinding | undefined {
  return BINDINGS_BY_FIELD.get(String(fieldKey));
}

export function applyFillPatch<T extends Record<string, unknown>>(
  draft: T,
  patch: Record<string, unknown>,
  options: { overwrite?: boolean; fieldSources?: Record<string, string> } = {},
): Partial<T> {
  const next: Partial<T> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null || value === '') continue;
    const sourceTag = options.fieldSources?.[key];
    const current = draft[key];
    const hasCurrent = current !== undefined && current !== null && current !== '';
    const userEdited = sourceTag === 'manual' || sourceTag === 'imported-then-edited' || sourceTag === 'manual-overridden';
    if (!options.overwrite && (hasCurrent || userEdited)) continue;
    (next as Record<string, unknown>)[key] = value;
  }
  return next;
}
