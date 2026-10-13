import type { PrismaClient } from '@prisma/client';
import { getEntityTypeDefinition, isEntityType, type EntityType } from './registry';

const MAX_ENTITY_SEARCH_OFFSET = 4970;
const MAX_ENTITY_SEARCH_SCAN_LIMIT = 5000;

export interface EntitySearchRequest {
  query: string;
  fieldKey?: string;
  entityTypes?: string[];
  ownerContext?: {
    ownerType?: string;
    ownerId?: string;
    customerRelationId?: string;
  };
  limit?: number;
  offset?: number;
  include?: {
    fillPatch?: boolean;
    links?: boolean;
  };
}

export interface EntityRefInput {
  entityType: string;
  id: string;
  targetPath?: string;
}

export interface EntityHydrateRequest {
  refs: EntityRefInput[];
  include?: {
    fillPatch?: boolean;
    links?: boolean;
  };
}

export interface EntitySearchItem {
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

export async function searchEntities(prisma: PrismaClient, request: EntitySearchRequest): Promise<EntitySearchItem[]> {
  const query = request.query.trim();
  if (!query) return [];

  const requestedTypes = normalizeEntityTypes(request.entityTypes);
  const limit = getEntitySearchLimit(request);
  const offset = getEntitySearchOffset(request);
  const buckets = await Promise.all([
    requestedTypes.includes('relation.organization') ? searchOrganizations(prisma, query, request) : [],
    requestedTypes.includes('relation.person') ? searchPeople(prisma, query, request) : [],
    requestedTypes.includes('product.customerCode') ? searchCustomerCodes(prisma, query, request) : [],
    requestedTypes.includes('product.fabricProfile') || requestedTypes.includes('product.asset')
      ? searchProductAssets(prisma, query, request)
      : [],
    requestedTypes.includes('order.line') ? searchOrderLines(prisma, query, request) : [],
  ]);

  return buckets
    .flat()
    .sort((a, b) => b.confidence - a.confidence || a.title.localeCompare(b.title))
    .slice(offset, offset + limit);
}

export async function countEntities(prisma: PrismaClient, request: EntitySearchRequest): Promise<number> {
  const query = request.query.trim();
  if (!query) return 0;

  const requestedTypes = normalizeEntityTypes(request.entityTypes);
  const counts = await Promise.all([
    requestedTypes.includes('relation.organization')
      ? countModel((prisma as any).relation, {
        deletedAt: null,
        isOrganization: true,
        OR: relationSearchWhere(query),
      })
      : 0,
    requestedTypes.includes('relation.person')
      ? countModel((prisma as any).relation, {
        deletedAt: null,
        isOrganization: false,
        OR: relationSearchWhere(query),
      })
      : 0,
    requestedTypes.includes('product.customerCode')
      ? countModel((prisma as any).fabricCustomerCode, {
        deletedAt: null,
        clientCode: { contains: query, mode: 'insensitive' },
        ...(request.ownerContext?.customerRelationId ? { customerOrganizationId: request.ownerContext.customerRelationId } : {}),
      })
      : 0,
    requestedTypes.includes('product.asset')
      ? countModel((prisma as any).productAsset, productAssetSearchWhere(query))
      : 0,
    requestedTypes.includes('product.fabricProfile')
      ? countModel((prisma as any).productAsset, {
        ...productAssetSearchWhere(query),
        fabricProfile: { isNot: null },
      })
      : 0,
    requestedTypes.includes('order.line')
      ? countModel((prisma as any).orderLine, orderLineSearchWhere(query))
      : 0,
  ]);

  return counts.reduce((sum, count) => sum + count, 0);
}

export async function hydrateEntities(prisma: PrismaClient, request: EntityHydrateRequest): Promise<EntitySearchItem[]> {
  const includeFillPatch = request.include?.fillPatch !== false;
  const items: EntitySearchItem[] = [];

  for (const ref of request.refs || []) {
    if (!isEntityType(ref.entityType)) continue;
    if (ref.entityType === 'relation.organization' || ref.entityType === 'relation.person') {
      const relation = await (prisma as any).relation?.findFirst?.({
        where: { id: ref.id, deletedAt: null },
      });
      if (relation) items.push(toRelationItem(ref.entityType, relation, undefined, includeFillPatch));
    }
    if (ref.entityType === 'product.customerCode') {
      const code = await (prisma as any).fabricCustomerCode?.findFirst?.({
        where: { id: ref.id, deletedAt: null },
        include: productCodeInclude(),
      });
      if (code) items.push(toCustomerCodeItem(code, includeFillPatch));
    }
    if (ref.entityType === 'product.asset') {
      const asset = await (prisma as any).productAsset?.findFirst?.({
        where: { id: ref.id, deletedAt: null },
        include: productAssetInclude(),
      });
      if (asset) items.push(toProductAssetItem(asset, includeFillPatch));
    }
    if (ref.entityType === 'product.fabricProfile') {
      const asset = await (prisma as any).productAsset?.findFirst?.({
        where: { fabricProfile: { is: { id: ref.id, deletedAt: null } }, deletedAt: null },
        include: productAssetInclude(),
      });
      if (asset) items.push(toFabricProfileItem(asset, includeFillPatch));
    }
  }

  return items;
}

function normalizeEntityTypes(types: string[] | undefined): EntityType[] {
  const valid = (types || []).filter(isEntityType);
  if (valid.length > 0) return valid;
  return ['relation.organization', 'relation.person', 'product.customerCode', 'product.fabricProfile', 'product.asset', 'order.line'];
}

function getEntitySearchLimit(request: EntitySearchRequest): number {
  return Math.max(1, Math.min(Number(request.limit || 10), 30));
}

function getEntitySearchOffset(request: EntitySearchRequest): number {
  return Math.max(0, Math.min(Number(request.offset || 0), MAX_ENTITY_SEARCH_OFFSET));
}

function getEntitySearchScanLimit(request: EntitySearchRequest): number {
  return Math.max(1, Math.min(getEntitySearchOffset(request) + getEntitySearchLimit(request), MAX_ENTITY_SEARCH_SCAN_LIMIT));
}

async function searchOrganizations(prisma: PrismaClient, query: string, request: EntitySearchRequest): Promise<EntitySearchItem[]> {
  const rows = await ((prisma as any).relation?.findMany?.({
    where: {
      deletedAt: null,
      isOrganization: true,
      OR: relationSearchWhere(query),
    },
    orderBy: [{ lastInteraction: 'desc' }, { id: 'asc' }],
    take: getEntitySearchScanLimit(request),
  }) ?? Promise.resolve([]));
  return rows.map((row: any) => toRelationItem('relation.organization', row, request.fieldKey, request.include?.fillPatch !== false));
}

async function searchPeople(prisma: PrismaClient, query: string, request: EntitySearchRequest): Promise<EntitySearchItem[]> {
  const rows = await ((prisma as any).relation?.findMany?.({
    where: {
      deletedAt: null,
      isOrganization: false,
      OR: relationSearchWhere(query),
    },
    orderBy: [{ lastInteraction: 'desc' }, { id: 'asc' }],
    take: getEntitySearchScanLimit(request),
  }) ?? Promise.resolve([]));
  return rows.map((row: any) => toRelationItem('relation.person', row, request.fieldKey, request.include?.fillPatch !== false));
}

function relationSearchWhere(query: string) {
  return [
    { name: { contains: query, mode: 'insensitive' as const } },
    { chineseName: { contains: query, mode: 'insensitive' as const } },
    { englishName: { contains: query, mode: 'insensitive' as const } },
    { summary: { contains: query, mode: 'insensitive' as const } },
    { contactInfo: { contains: query, mode: 'insensitive' as const } },
  ];
}

function toRelationItem(entityType: 'relation.organization' | 'relation.person', relation: any, fieldKey?: string, includeFillPatch = true): EntitySearchItem {
  const def = getEntityTypeDefinition(entityType)!;
  const title = relation.name || relation.englishName || relation.chineseName || relation.id;
  return {
    entityType,
    id: relation.id,
    title,
    subtitle: [relation.category, relation.role, relation.department].filter(Boolean).join(' · ') || undefined,
    snippet: [relation.summary, relation.officialAddress, relation.contactInfo].filter(Boolean).join('; ') || undefined,
    confidence: 0.92,
    sourceModel: def.sourceModel,
    ...(includeFillPatch ? { fillPatch: relationFillPatch(fieldKey, relation, title) } : {}),
  };
}

function relationFillPatch(fieldKey: string | undefined, relation: any, title: string): Record<string, unknown> {
  const address = relation.officialAddress || relation.shippingAddress || relation.billingAddress || firstAddress(relation.factoryAddresses) || firstShipToAddress(relation.shipToAddresses);
  const contactName = relation.primaryContactName || relation.name;
  const phone = relation.primaryContactPhone || relation.phone || relation.mobile || relation.contactInfo;
  const common = compactPatch({
    paymentTerms: relation.paymentTerms,
    salesCurrency: relation.currency,
  });
  if (fieldKey === 'millName') {
    return compactPatch({
      millName: title,
      millRelationId: relation.id,
      millAddress: address,
      millContact: contactName,
      millPhone: phone,
      ...common,
    });
  }
  if (fieldKey === 'consigneeName') {
    return compactPatch({
      consigneeName: title,
      consigneeRelationId: relation.id,
      consigneeAddress: address,
      consigneeContact: contactName,
      ...common,
    });
  }
  if (fieldKey === 'billToName') {
    return compactPatch({
      billToName: title,
      billToRelationId: relation.id,
      billToAddress: relation.billingAddress || address,
      billToContact: contactName,
      ...common,
    });
  }
  if (fieldKey === 'salesPerson' || fieldKey === 'merchandiser' || fieldKey === 'supervisor') {
    return compactPatch({
      [fieldKey]: title,
      [`${fieldKey}RelationId`]: relation.id,
    });
  }
  return compactPatch({
    customer: title,
    customerRelationId: relation.id,
    customerAddress: address,
    contactPerson: contactName,
    contactTelephone: phone,
    ...common,
  });
}

async function searchCustomerCodes(prisma: PrismaClient, query: string, request: EntitySearchRequest): Promise<EntitySearchItem[]> {
  const rows = await ((prisma as any).fabricCustomerCode?.findMany?.({
    where: {
      deletedAt: null,
      clientCode: { contains: query, mode: 'insensitive' },
      ...(request.ownerContext?.customerRelationId ? { customerOrganizationId: request.ownerContext.customerRelationId } : {}),
    },
    include: productCodeInclude(),
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    take: getEntitySearchScanLimit(request),
  }) ?? Promise.resolve([]));
  return rows.map((row: any) => toCustomerCodeItem(row, request.include?.fillPatch !== false));
}

function toCustomerCodeItem(code: any, includeFillPatch = true): EntitySearchItem {
  const def = getEntityTypeDefinition('product.customerCode')!;
  const asset = code.productAsset || {};
  const profile = asset.fabricProfile || {};
  return {
    entityType: 'product.customerCode',
    id: code.id,
    title: code.clientCode || code.id,
    subtitle: [asset.name, code.customerNameSnapshot].filter(Boolean).join(' · ') || undefined,
    snippet: [profile.millQuality, profile.articleNo, profile.millColorCode].filter(Boolean).join('; ') || undefined,
    confidence: 0.96,
    sourceModel: def.sourceModel,
    ...(includeFillPatch ? { fillPatch: productFillPatch(asset, profile, code) } : {}),
    links: [{ targetType: 'product.asset', targetId: code.productAssetId, linkKind: 'codesProduct' }],
  };
}

async function searchProductAssets(prisma: PrismaClient, query: string, request: EntitySearchRequest): Promise<EntitySearchItem[]> {
  const rows = await ((prisma as any).productAsset?.findMany?.({
    where: productAssetSearchWhere(query),
    include: productAssetInclude(),
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    take: getEntitySearchScanLimit(request),
  }) ?? Promise.resolve([]));

  return rows.flatMap((asset: any) => {
    const items: EntitySearchItem[] = [];
    const types = normalizeEntityTypes(request.entityTypes);
    if (types.includes('product.asset')) items.push(toProductAssetItem(asset, request.include?.fillPatch !== false));
    if (types.includes('product.fabricProfile') && asset.fabricProfile) items.push(toFabricProfileItem(asset, request.include?.fillPatch !== false));
    return items;
  });
}

function toProductAssetItem(asset: any, includeFillPatch = true): EntitySearchItem {
  const def = getEntityTypeDefinition('product.asset')!;
  return {
    entityType: 'product.asset',
    id: asset.id,
    title: asset.name || asset.sku || asset.id,
    subtitle: asset.sku,
    snippet: asset.fabricProfile?.millQuality,
    confidence: 0.88,
    sourceModel: def.sourceModel,
    ...(includeFillPatch ? { fillPatch: productFillPatch(asset, asset.fabricProfile || {}, undefined) } : {}),
  };
}

function toFabricProfileItem(asset: any, includeFillPatch = true): EntitySearchItem {
  const def = getEntityTypeDefinition('product.fabricProfile')!;
  const profile = asset.fabricProfile || {};
  return {
    entityType: 'product.fabricProfile',
    id: profile.id,
    title: profile.millQuality || profile.articleNo || asset.name || profile.id,
    subtitle: [asset.name, profile.millColorCode].filter(Boolean).join(' · ') || undefined,
    snippet: [profile.articleNo, profile.widthValue && `${profile.widthValue} ${profile.widthUnit || ''}`, profile.weightValue && `${profile.weightValue} ${profile.weightUnit || ''}`].filter(Boolean).join('; ') || undefined,
    confidence: 0.9,
    sourceModel: def.sourceModel,
    ...(includeFillPatch ? { fillPatch: productFillPatch(asset, profile, undefined) } : {}),
    links: [{ targetType: 'product.asset', targetId: asset.id, linkKind: 'belongsToProduct' }],
  };
}

function productFillPatch(asset: any, profile: any, code: any | undefined): Record<string, unknown> {
  return compactPatch({
    clientCode: code?.clientCode,
    product: asset?.name,
    fabricCode: profile?.articleNo,
    productColorCode: profile?.millQuality || profile?.millColorCode,
    width: formatMeasure(profile?.widthValue, profile?.widthUnit),
    gsm: formatMeasure(profile?.weightValue, profile?.weightUnit),
  });
}

async function searchOrderLines(prisma: PrismaClient, query: string, request: EntitySearchRequest): Promise<EntitySearchItem[]> {
  const rows = await ((prisma as any).orderLine?.findMany?.({
    where: orderLineSearchWhere(query),
    include: { order: { select: { id: true, poNumber: true, customer: true } } },
    orderBy: [{ orderId: 'desc' }, { lineNumber: 'asc' }, { id: 'asc' }],
    take: getEntitySearchScanLimit(request),
  }) ?? Promise.resolve([]));
  return rows.map((line: any) => ({
    entityType: 'order.line',
    id: line.id,
    title: line.materialCode || line.millQuality || line.description || line.id,
    subtitle: [line.order?.poNumber, line.order?.customer].filter(Boolean).join(' · ') || undefined,
    snippet: [line.description, line.cloth, line.width, line.weight].filter(Boolean).join('; ') || undefined,
    confidence: 0.65,
    sourceModel: 'OrderLine',
    fillPatch: compactPatch({
      clientCode: line.materialCode,
      productColorCode: line.millQuality,
      fabricContent: line.cloth || line.description,
      width: line.width,
      gsm: line.weight,
    }),
  }));
}

async function countModel(model: any, where: Record<string, unknown>): Promise<number> {
  if (typeof model?.count !== 'function') return 0;
  return Number(await model.count({ where })) || 0;
}

function productAssetSearchWhere(query: string) {
  return {
    deletedAt: null,
    OR: [
      { sku: { contains: query, mode: 'insensitive' as const } },
      { name: { contains: query, mode: 'insensitive' as const } },
      { fabricProfile: { is: { articleNo: { contains: query, mode: 'insensitive' as const } } } },
      { fabricProfile: { is: { millQuality: { contains: query, mode: 'insensitive' as const } } } },
      { fabricProfile: { is: { millColorCode: { contains: query, mode: 'insensitive' as const } } } },
    ],
  };
}

function orderLineSearchWhere(query: string) {
  return {
    OR: [
      { materialCode: { contains: query, mode: 'insensitive' as const } },
      { millQuality: { contains: query, mode: 'insensitive' as const } },
      { description: { contains: query, mode: 'insensitive' as const } },
    ],
    order: { deletedAt: null },
  };
}

function productCodeInclude() {
  return {
    productAsset: {
      include: {
        fabricProfile: true,
        compositionLines: { include: { term: true } },
      },
    },
  };
}

function productAssetInclude() {
  return {
    fabricProfile: true,
    fabricCustomerCodes: { where: { deletedAt: null } },
    compositionLines: { include: { term: true } },
  };
}

function compactPatch(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

function formatMeasure(value: unknown, unit: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return [String(value), typeof unit === 'string' ? unit : ''].filter(Boolean).join(' ');
}

function firstAddress(value: unknown): string | undefined {
  return Array.isArray(value) ? value.find((item) => typeof item === 'string' && item.trim()) : undefined;
}

function firstShipToAddress(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const first = value.find((item) => item && typeof item === 'object') as any;
  return first?.address || first?.text;
}
