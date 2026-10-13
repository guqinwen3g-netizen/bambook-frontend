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
}

export interface EntityRef {
  entityType: EntityType;
  id: string;
  targetPath?: string;
  title?: string;
}

export interface EntityCandidate {
  entityType: EntityType;
  id: string;
  targetPath?: string;
  title: string;
  subtitle?: string;
  snippet?: string;
  confidence: number;
  sourceModel: string;
  fillPatch?: Record<string, unknown>;
  links?: Array<{ targetType: string; targetId: string; linkKind: string }>;
}

export const ENTITY_TYPES: EntityTypeDefinition[] = [
  { type: 'relation.organization', schemaVersion: 1, sourceModel: 'Relation', label: 'Organization', description: '组织档案：客户、供应商、代理、合作伙伴。', supportsTargetPath: false, canCreateInSourceModule: true },
  { type: 'relation.person', schemaVersion: 1, sourceModel: 'Relation', label: 'Person', description: '人员档案：内部员工、客户联系人、供应商联系人。', supportsTargetPath: false, canCreateInSourceModule: true },
  { type: 'relation.address', schemaVersion: 1, sourceModel: 'Relation', label: 'Address', description: '组织档案内的稳定地址引用。', supportsTargetPath: true, canCreateInSourceModule: true },
  { type: 'relation.contactPoint', schemaVersion: 1, sourceModel: 'Relation', label: 'Contact Point', description: '组织/人员档案内的联系方式引用。', supportsTargetPath: true, canCreateInSourceModule: true },
  { type: 'product.asset', schemaVersion: 1, sourceModel: 'ProductAsset', label: 'Product Asset', description: '产品/物料资产档案。', supportsTargetPath: false, canCreateInSourceModule: true },
  { type: 'product.fabricProfile', schemaVersion: 1, sourceModel: 'FabricProfile', label: 'Fabric Profile', description: '面料档案。', supportsTargetPath: false, canCreateInSourceModule: true },
  { type: 'product.customerCode', schemaVersion: 1, sourceModel: 'FabricCustomerCode', label: 'Customer Code', description: '客户给产品/面料的编码档案。', supportsTargetPath: false, canCreateInSourceModule: true },
  { type: 'order', schemaVersion: 1, sourceModel: 'Order', label: 'Order', description: '订单抬头。', supportsTargetPath: false, canCreateInSourceModule: false },
  { type: 'order.line', schemaVersion: 1, sourceModel: 'OrderLine', label: 'Order Line', description: '订单行快照。', supportsTargetPath: false, canCreateInSourceModule: false },
  { type: 'knowledge.document', schemaVersion: 1, sourceModel: 'KnowledgeDocument', label: 'Knowledge Document', description: '知识库文档。', supportsTargetPath: false, canCreateInSourceModule: false },
  { type: 'knowledge.chunk', schemaVersion: 1, sourceModel: 'KnowledgeChunk', label: 'Knowledge Chunk', description: '知识库片段。', supportsTargetPath: false, canCreateInSourceModule: false },
  { type: 'business.tool', schemaVersion: 1, sourceModel: 'BusinessTool', label: 'Business Tool', description: '业务工具输出。', supportsTargetPath: false, canCreateInSourceModule: false },
];

export function isEntityType(value: string): value is EntityType {
  return ENTITY_TYPES.some((item) => item.type === value);
}
