import { PrismaClient } from '@prisma/client';
import { resolveRelationCoordinates } from './geoResolve';
import { syncRelationEntityReferences, deactivateEntityLinks } from '../entities/sync';
import { writeRouteAuditLog } from '../audit/routeAudit';

export const VALID_RELATION_CATEGORIES = new Set(['Customer', 'Supplier', 'Agent', 'Partner', 'Government', 'Internal', 'Other']);
export const RELATION_UPDATE_FIELDS = ['name', 'category', 'type', 'isOrganization', 'parentId', 'reportsToId', 'role', 'department', 'tags', 'contactInfo', 'rating', 'lastInteraction', 'preferences', 'website', 'chineseName', 'englishName', 'creditLevel', 'summary', 'primaryContactName', 'primaryContactEmail', 'primaryContactPhone', 'backupContacts', 'shipToAddresses', 'financialNotes', 'paymentTerms', 'paymentPreference', 'currency', 'taxId', 'creditLimit', 'officialAddress', 'factoryAddresses', 'warehouseAddress', 'billingAddress', 'shippingAddress', 'coordinates', 'phone', 'mobile', 'wechat', 'whatsapp', 'email', 'otherContacts', 'birthday', 'language', 'timezone', 'personalNote'] as const;

export type RelationMutationErrorCode =
  | 'INVALID_CATEGORY'
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'CREATE_FAILED'
  | 'UPDATE_FAILED'
  | 'DELETE_FAILED';

export interface RelationMutationError {
  code: RelationMutationErrorCode;
  message: string;
}

export interface RelationMutationResult {
  ok: boolean;
  data?: { relation: any; auditId: string };
  error?: RelationMutationError;
}

export function isValidRelationCategory(category: string): boolean {
  return VALID_RELATION_CATEGORIES.has(category);
}

export function validateRelationCategory(input: any): RelationMutationError | null {
  const rawCategory = String((input || {}).category || '').trim();
  if (rawCategory && !isValidRelationCategory(rawCategory)) {
    return { code: 'INVALID_CATEGORY', message: `category must be one of: ${[...VALID_RELATION_CATEGORIES].join(', ')}` };
  }
  return null;
}

export function normalizeJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return trimmed
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => ({ text: line }));
  }
}

export function toRelationDbPayload(input: any): Record<string, unknown> {
  const coordinates = input.coordinates || {};
  let lat: number | null = coordinates.lat ?? null;
  let lng: number | null = coordinates.lng ?? null;

  if (lat == null || lng == null) {
    const resolved = resolveRelationCoordinates({
      officialAddress: input.officialAddress,
      factoryAddresses: Array.isArray(input.factoryAddresses) ? input.factoryAddresses.map(String) : [],
      shipToAddresses: normalizeJsonArray(input.shipToAddresses) as Array<{ city?: string; address?: string }>,
      shippingAddress: input.shippingAddress,
      country: input.country,
    });
    if (resolved) {
      if (lat == null) lat = resolved.lat;
      if (lng == null) lng = resolved.lng;
    }
  }

  return {
    id: String(input.id || `REL-${Date.now()}`),
    name: String(input.name || ''),
    category: String(input.category || 'Other'),
    type: String(input.type || input.category || 'Other'),
    isOrganization: Boolean(input.isOrganization),
    parentId: input.parentId || null,
    reportsToId: input.reportsToId || null,
    role: input.role || null,
    department: input.department || null,
    // 归属三键（v2.1 组为主视野的行级权限锚点）：
    // ownerId=归属人（本人维可见/可写的判定核心）、departmentId=目录归属、
    // stage=销售阶段、code=档案编号。V2 createRelation 传入却被旧白名单丢弃，
    // 导致建档后 ownerId 落空——创建者对自己的客户失去写权限（DR-042 §6.1 判定）。
    ownerId: input.ownerId || null,
    departmentId: input.departmentId || null,
    stage: input.stage || null,
    code: input.code || null,
    // v2.2（DR-042 §4.4）：L1 档案层敏感标记（normal=图书馆全公司可查 / confidential=本人维+管理角色）
    sensitivity: input.sensitivity === 'confidential' ? 'confidential' : 'normal',
    tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
    contactInfo: String(input.contactInfo || ''),
    rating: Number(input.rating || 3),
    lastInteraction: BigInt(Number(input.lastInteraction || Date.now())),
    preferences: input.preferences || '',
    deletedAt: input.deletedAt ? BigInt(Number(input.deletedAt)) : null,
    website: input.website || null,
    chineseName: input.chineseName || null,
    englishName: input.englishName || null,
    creditLevel: input.creditLevel || null,
    summary: input.summary || null,
    primaryContactName: input.primaryContactName || null,
    primaryContactEmail: input.primaryContactEmail || null,
    primaryContactPhone: input.primaryContactPhone || null,
    backupContacts: normalizeJsonArray(input.backupContacts),
    shipToAddresses: normalizeJsonArray(input.shipToAddresses),
    financialNotes: input.financialNotes || null,
    paymentTerms: input.paymentTerms || null,
    paymentPreference: input.paymentPreference || null,
    currency: input.currency || null,
    taxId: input.taxId || null,
    creditLimit: input.creditLimit ? Number(input.creditLimit) : null,
    officialAddress: input.officialAddress || null,
    factoryAddresses: Array.isArray(input.factoryAddresses) ? input.factoryAddresses.map(String) : [],
    warehouseAddress: input.warehouseAddress || null,
    billingAddress: input.billingAddress || null,
    shippingAddress: input.shippingAddress || null,
    coordinatesLat: lat,
    coordinatesLng: lng,
    phone: input.phone || null,
    mobile: input.mobile || null,
    wechat: input.wechat || null,
    whatsapp: input.whatsapp || null,
    email: input.email || null,
    otherContacts: normalizeJsonArray(input.otherContacts),
    birthday: input.birthday || null,
    language: input.language || null,
    timezone: input.timezone || null,
    personalNote: input.personalNote || null,
    // 联系人统一（自 Contact 实体并入）：仅 isOrganization=false 的人物记录消费
    isPrimary: Boolean(input.isPrimary),
    isDecisionMaker: Boolean(input.isDecisionMaker),
    contactStatus: input.contactStatus || null,
  };
}

function hasOwn(input: any, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input || {}, key);
}

export function toRelationUpdatePayload(input: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (hasOwn(input, 'name')) out.name = String(input.name || '');
  if (hasOwn(input, 'category')) out.category = String(input.category || 'Other');
  if (hasOwn(input, 'type')) out.type = String(input.type || input.category || 'Other');
  if (hasOwn(input, 'isOrganization')) out.isOrganization = Boolean(input.isOrganization);
  if (hasOwn(input, 'parentId')) out.parentId = input.parentId || null;
  if (hasOwn(input, 'reportsToId')) out.reportsToId = input.reportsToId || null;
  if (hasOwn(input, 'role')) out.role = input.role || null;
  if (hasOwn(input, 'department')) out.department = input.department || null;
  // 归属键（与 toRelationDbPayload 对齐）：转归属/调部门/改阶段/改编号走更新链路
  if (hasOwn(input, 'ownerId')) out.ownerId = input.ownerId || null;
  if (hasOwn(input, 'departmentId')) out.departmentId = input.departmentId || null;
  if (hasOwn(input, 'stage')) out.stage = input.stage || null;
  if (hasOwn(input, 'code')) out.code = input.code || null;
  // v2.2（DR-042 §4.4）：敏感标记更新（仅 normal/confidential 合法值落库）
  if (hasOwn(input, 'sensitivity')) {
    out.sensitivity = input.sensitivity === 'confidential' ? 'confidential' : 'normal';
  }
  if (hasOwn(input, 'tags')) out.tags = Array.isArray(input.tags) ? input.tags.map(String) : [];
  if (hasOwn(input, 'contactInfo')) out.contactInfo = String(input.contactInfo || '');
  if (hasOwn(input, 'rating')) out.rating = Number(input.rating || 3);
  if (hasOwn(input, 'lastInteraction')) out.lastInteraction = BigInt(Number(input.lastInteraction || Date.now()));
  if (hasOwn(input, 'preferences')) out.preferences = input.preferences || '';
  if (hasOwn(input, 'website')) out.website = input.website || null;
  if (hasOwn(input, 'chineseName')) out.chineseName = input.chineseName || null;
  if (hasOwn(input, 'englishName')) out.englishName = input.englishName || null;
  if (hasOwn(input, 'creditLevel')) out.creditLevel = input.creditLevel || null;
  if (hasOwn(input, 'summary')) out.summary = input.summary || null;
  if (hasOwn(input, 'primaryContactName')) out.primaryContactName = input.primaryContactName || null;
  if (hasOwn(input, 'primaryContactEmail')) out.primaryContactEmail = input.primaryContactEmail || null;
  if (hasOwn(input, 'primaryContactPhone')) out.primaryContactPhone = input.primaryContactPhone || null;
  if (hasOwn(input, 'backupContacts')) out.backupContacts = normalizeJsonArray(input.backupContacts);
  if (hasOwn(input, 'shipToAddresses')) out.shipToAddresses = normalizeJsonArray(input.shipToAddresses);
  if (hasOwn(input, 'financialNotes')) out.financialNotes = input.financialNotes || null;
  if (hasOwn(input, 'paymentTerms')) out.paymentTerms = input.paymentTerms || null;
  if (hasOwn(input, 'paymentPreference')) out.paymentPreference = input.paymentPreference || null;
  if (hasOwn(input, 'currency')) out.currency = input.currency || null;
  if (hasOwn(input, 'taxId')) out.taxId = input.taxId || null;
  if (hasOwn(input, 'creditLimit')) out.creditLimit = input.creditLimit ? Number(input.creditLimit) : null;
  if (hasOwn(input, 'officialAddress')) out.officialAddress = input.officialAddress || null;
  if (hasOwn(input, 'factoryAddresses')) out.factoryAddresses = Array.isArray(input.factoryAddresses) ? input.factoryAddresses.map(String) : [];
  if (hasOwn(input, 'warehouseAddress')) out.warehouseAddress = input.warehouseAddress || null;
  if (hasOwn(input, 'billingAddress')) out.billingAddress = input.billingAddress || null;
  if (hasOwn(input, 'shippingAddress')) out.shippingAddress = input.shippingAddress || null;
  if (hasOwn(input, 'coordinates')) {
    const coordinates = input.coordinates || {};
    out.coordinatesLat = coordinates.lat ?? null;
    out.coordinatesLng = coordinates.lng ?? null;
  }
  if (hasOwn(input, 'phone')) out.phone = input.phone || null;
  if (hasOwn(input, 'mobile')) out.mobile = input.mobile || null;
  if (hasOwn(input, 'wechat')) out.wechat = input.wechat || null;
  if (hasOwn(input, 'whatsapp')) out.whatsapp = input.whatsapp || null;
  if (hasOwn(input, 'email')) out.email = input.email || null;
  if (hasOwn(input, 'otherContacts')) out.otherContacts = normalizeJsonArray(input.otherContacts);
  if (hasOwn(input, 'birthday')) out.birthday = input.birthday || null;
  if (hasOwn(input, 'language')) out.language = input.language || null;
  if (hasOwn(input, 'timezone')) out.timezone = input.timezone || null;
  if (hasOwn(input, 'personalNote')) out.personalNote = input.personalNote || null;
  // 联系人统一（自 Contact 实体并入）：仅 isOrganization=false 的人物记录消费
  if (hasOwn(input, 'isPrimary')) out.isPrimary = Boolean(input.isPrimary);
  if (hasOwn(input, 'isDecisionMaker')) out.isDecisionMaker = Boolean(input.isDecisionMaker);
  if (hasOwn(input, 'contactStatus')) out.contactStatus = input.contactStatus || null;
  return out;
}

export function serializeRelation(row: any) {
  const out: any = { ...row };
  if (typeof out.lastInteraction === 'bigint') out.lastInteraction = Number(out.lastInteraction);
  if (typeof out.deletedAt === 'bigint') out.deletedAt = Number(out.deletedAt);
  if (out.coordinatesLat !== null && out.coordinatesLat !== undefined && out.coordinatesLng !== null && out.coordinatesLng !== undefined) {
    out.coordinates = { lat: out.coordinatesLat, lng: out.coordinatesLng };
  }
  delete out.coordinatesLat;
  delete out.coordinatesLng;
  return out;
}

function toRelationError(e: any, fallback: RelationMutationErrorCode): RelationMutationError {
  if (e?.code === 'INVALID_CATEGORY' || e?.code === 'VALIDATION_FAILED' || e?.code === 'NOT_FOUND') {
    return { code: e.code, message: String(e.message ?? e) };
  }
  return { code: fallback, message: String(e?.message ?? e) };
}

function throwCoded(code: RelationMutationErrorCode, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export async function createRelation(params: {
  prisma: PrismaClient;
  input: any;
  actorId?: string;
  ip?: string | null;
}): Promise<RelationMutationResult> {
  const { prisma, input, actorId, ip } = params;
  const categoryError = validateRelationCategory(input);
  if (categoryError) return { ok: false, error: categoryError };
  const payload = toRelationDbPayload(input || {});
  if (!payload.id || !payload.name) return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'id and name are required' } };
  try {
    const result = await (prisma as any).$transaction(async (tx: any) => {
      const rel = await tx.relation.upsert({ where: { id: payload.id }, update: payload, create: payload });
      await syncRelationEntityReferences(prisma, rel as any, { source: 'relations.upsert' }, tx);
      const auditId = await writeRouteAuditLog({
        prisma: tx, actorId: actorId || 'api', source: 'route:relation:create',
        operation: 'create_relation', targetType: 'Relation', targetId: rel.id,
        after: { id: rel.id, name: rel.name, category: rel.category, type: rel.type },
        ip: ip || null,
      });
      return { relation: rel, auditId };
    });
    return { ok: true, data: result };
  } catch (e: any) {
    return { ok: false, error: toRelationError(e, 'CREATE_FAILED') };
  }
}

export async function updateRelation(params: {
  prisma: PrismaClient;
  relationId: string;
  input: any;
  actorId?: string;
  ip?: string | null;
}): Promise<RelationMutationResult> {
  const { prisma, relationId, input, actorId, ip } = params;
  const categoryError = validateRelationCategory(input);
  if (categoryError) return { ok: false, error: categoryError };
  try {
    const result = await (prisma as any).$transaction(async (tx: any) => {
      const existing = await tx.relation.findUnique({ where: { id: relationId } });
      if (!existing || existing.deletedAt) throwCoded('NOT_FOUND', 'relation not found');
      const payload = toRelationUpdatePayload(input || {});
      const upd = await tx.relation.update({ where: { id: relationId }, data: payload });
      await syncRelationEntityReferences(prisma, upd as any, { source: 'relations.update' }, tx);
      const auditId = await writeRouteAuditLog({
        prisma: tx, actorId: actorId || 'api', source: 'route:relation:update',
        operation: 'update_relation', targetType: 'Relation', targetId: upd.id,
        before: { name: existing.name, category: existing.category, type: existing.type },
        after: { name: upd.name, category: upd.category, type: upd.type },
        ip: ip || null,
      });
      return { relation: upd, auditId };
    });
    return { ok: true, data: result };
  } catch (e: any) {
    return { ok: false, error: toRelationError(e, 'UPDATE_FAILED') };
  }
}

export async function deleteRelation(params: {
  prisma: PrismaClient;
  relationId: string;
  actorId?: string;
  ip?: string | null;
}): Promise<RelationMutationResult> {
  const { prisma, relationId, actorId, ip } = params;
  try {
    const result = await (prisma as any).$transaction(async (tx: any) => {
      const existing = await tx.relation.findUnique({ where: { id: relationId }, select: { id: true, name: true, category: true, type: true, isOrganization: true, deletedAt: true } });
      if (!existing || existing.deletedAt) throwCoded('NOT_FOUND', 'relation not found');
      const now = BigInt(Date.now());
      const del = await tx.relation.update({ where: { id: relationId }, data: { deletedAt: now } });
      await deactivateEntityLinks(tx, 'relation', relationId, now);
      await deactivateEntityLinks(tx, existing.isOrganization ? 'relation.organization' : 'relation.contact', relationId, now);
      const auditId = await writeRouteAuditLog({
        prisma: tx, actorId: actorId || 'api', source: 'route:relation:delete',
        operation: 'delete_relation', targetType: 'Relation', targetId: del.id,
        before: { id: del.id, name: existing.name, category: existing.category, type: existing.type },
        ip: ip || null,
      });
      return { relation: del, auditId };
    });
    return { ok: true, data: result };
  } catch (e: any) {
    return { ok: false, error: toRelationError(e, 'DELETE_FAILED') };
  }
}
