export const ENTITY_REGISTRY_VERSION = '2026-05-09';

export type EntityType =
  | 'relation.organization'
  | 'relation.person'
  | 'relation.address'
  | 'relation.contactPoint'
  | 'product.asset'
  | 'product.fabricProfile'
  | 'product.customerCode'
  | 'order'
  | 'order.line'
  | 'knowledge.document'
  | 'knowledge.chunk'
  | 'business.tool';

export interface EntityTypeDefinition {
  type: EntityType;
  schemaVersion: number;
  sourceModel: string;
  label: string;
  description: string;
  supportsTargetPath: boolean;
  canCreateInSourceModule: boolean;
  defaultSearchFields: string[];
}

export const ENTITY_TYPES: EntityTypeDefinition[] = [
  {
    type: 'relation.organization',
    schemaVersion: 1,
    sourceModel: 'Relation',
    label: 'Organization',
    description: 'Customer, supplier, agent, partner, government, or internal organization profile.',
    supportsTargetPath: false,
    canCreateInSourceModule: true,
    defaultSearchFields: ['name', 'chineseName', 'englishName', 'tags', 'summary'],
  },
  {
    type: 'relation.person',
    schemaVersion: 1,
    sourceModel: 'Relation',
    label: 'Person',
    description: 'Internal staff or external contact stored as a person relation.',
    supportsTargetPath: false,
    canCreateInSourceModule: true,
    defaultSearchFields: ['name', 'role', 'department', 'email', 'phone', 'mobile'],
  },
  {
    type: 'relation.address',
    schemaVersion: 1,
    sourceModel: 'Relation',
    label: 'Address',
    description: 'Stable address reference inside a relation profile.',
    supportsTargetPath: true,
    canCreateInSourceModule: true,
    defaultSearchFields: ['officialAddress', 'billingAddress', 'shippingAddress', 'shipToAddresses'],
  },
  {
    type: 'relation.contactPoint',
    schemaVersion: 1,
    sourceModel: 'Relation',
    label: 'Contact Point',
    description: 'Primary or backup contact point inside a relation profile.',
    supportsTargetPath: true,
    canCreateInSourceModule: true,
    defaultSearchFields: ['primaryContactName', 'primaryContactEmail', 'primaryContactPhone', 'backupContacts'],
  },
  {
    type: 'product.asset',
    schemaVersion: 1,
    sourceModel: 'ProductAsset',
    label: 'Product Asset',
    description: 'Product, material, fabric article, accessory, trim, or merchandise catalog profile.',
    supportsTargetPath: false,
    canCreateInSourceModule: true,
    defaultSearchFields: ['sku', 'name'],
  },
  {
    type: 'product.fabricProfile',
    schemaVersion: 1,
    sourceModel: 'FabricProfile',
    label: 'Fabric Profile',
    description: 'Fabric construction, mill quality, article number, width, weight, and related specs.',
    supportsTargetPath: false,
    canCreateInSourceModule: true,
    defaultSearchFields: ['articleNo', 'millQuality', 'millColorCode', 'colorDescription'],
  },
  {
    type: 'product.customerCode',
    schemaVersion: 1,
    sourceModel: 'FabricCustomerCode',
    label: 'Customer Product Code',
    description: 'Customer-owned product or fabric code linked to a product asset.',
    supportsTargetPath: false,
    canCreateInSourceModule: true,
    defaultSearchFields: ['clientCode', 'customerNameSnapshot'],
  },
  {
    type: 'order',
    schemaVersion: 1,
    sourceModel: 'Order',
    label: 'Order',
    description: 'Persistent PO header and business workflow snapshot.',
    supportsTargetPath: false,
    canCreateInSourceModule: false,
    defaultSearchFields: ['poNumber', 'customer', 'product'],
  },
  {
    type: 'order.line',
    schemaVersion: 1,
    sourceModel: 'OrderLine',
    label: 'Order Line',
    description: 'Imported PO line item snapshot.',
    supportsTargetPath: false,
    canCreateInSourceModule: false,
    defaultSearchFields: ['materialCode', 'millQuality', 'description'],
  },
  {
    type: 'knowledge.document',
    schemaVersion: 1,
    sourceModel: 'KnowledgeDocument',
    label: 'Knowledge Document',
    description: 'Knowledge base document.',
    supportsTargetPath: false,
    canCreateInSourceModule: false,
    defaultSearchFields: ['title', 'metadata'],
  },
  {
    type: 'knowledge.chunk',
    schemaVersion: 1,
    sourceModel: 'KnowledgeChunk',
    label: 'Knowledge Chunk',
    description: 'Searchable knowledge chunk.',
    supportsTargetPath: false,
    canCreateInSourceModule: false,
    defaultSearchFields: ['content', 'summary', 'tags'],
  },
  {
    type: 'business.tool',
    schemaVersion: 1,
    sourceModel: 'BusinessTool',
    label: 'Business Tool',
    description: 'Registered business workflow/tool output.',
    supportsTargetPath: false,
    canCreateInSourceModule: false,
    defaultSearchFields: ['name', 'title'],
  },
];

export function isEntityType(value: string): value is EntityType {
  return ENTITY_TYPES.some((item) => item.type === value);
}

export function getEntityTypeDefinition(type: string): EntityTypeDefinition | undefined {
  return ENTITY_TYPES.find((item) => item.type === type);
}
