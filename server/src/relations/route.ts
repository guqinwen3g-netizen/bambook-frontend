import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { resolveRelationCoordinates } from './geoResolve';
import { expandRelation, getRelation, queryRelations } from './query';
import { actorIdFromRequest, writeRouteAuditLog } from '../audit/routeAudit';
import { createRelation, updateRelation, deleteRelation } from './relationMutationService';
import { syncOrganizationPrimaryContact } from './contactSync';
// ★ 未预期异常不再把原始错误（Prisma 原文/表名列名）返回前端；业务错误（code+statusCode）仍透传。
//   安全前提（已核对 2026-09-17）：`relations/*.ts` 全域 **`throw new Error(` 为 0 处**
//   ⇒ 本文件各 catch 只接**未预期异常**，不存在「业务文案被吞」的风险。
import { safeRouteError } from '../shared/routeError';
import { requirePermission } from '../auth/permissionGuard';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { logger } from '../lib/logger';

// task_mqy2aqkz: category 7 选 1 合法枚举（与 Agent relation.create 对齐）
const VALID_CATEGORIES = new Set(['Customer', 'Supplier', 'Agent', 'Partner', 'Government', 'Internal', 'Other']);

export interface RelationsRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
}

export function createRelationsRouter(opts: RelationsRouterOptions): Router {
  const router = Router();

  // Shared module-level auth guard: JWT (cookie/Bearer) or API-key header.
  const guard = createModuleAuthGuard({ requireAuth: opts.requireAuth, apiKeys: opts.apiKeys });
  router.use(guard);


  // 写操作需要 JWT 认证（API key 仅用于只读）
  const requireWrite = requireJwtForWrite({ requireAuth: opts.requireAuth, apiKeys: opts.apiKeys });

  router.get('/', async (_req, res) => {
    try {
      const rows = await (opts.prisma as any).relation.findMany({
        where: { deletedAt: null },
        orderBy: [
          { isOrganization: 'desc' },
          { lastInteraction: 'desc' },
          { name: 'asc' },
          { id: 'asc' },
        ],
      });
      // 联系人计数徽标真源：Contact 表存活行（_count 不支持 deletedAt 过滤，
      // 改 groupBy 分组聚合映射；组织规模 ~20 家，性能可接受）
      const orgIds = rows.filter((r: any) => r.isOrganization).map((r: any) => r.id);
      const counts = orgIds.length
        ? await (opts.prisma as any).contact.groupBy({
            by: ['relationId'],
            where: { deletedAt: null, relationId: { in: orgIds } },
            _count: { relationId: true },
          })
        : [];
      const contactCountByRelation = new Map<string, number>(
        counts.map((c: any) => [c.relationId as string, Number(c._count?.relationId ?? 0)]),
      );
      return res.json({ ok: true, relations: rows.map((row: any) => serializeRelation(row, contactCountByRelation)) });
    } catch (e: any) {
      logger.error('[relations/list] failed', { error: e?.message || String(e) });
      const r = safeRouteError(e, { fallbackCode: 'LIST_FAILED' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  router.post('/query', async (req, res) => {
    try {
      const result = await queryRelations(opts.prisma, req.body || {});
      return res.json({ ok: true, ...result });
    } catch (e: any) {
      logger.error('[relations/query] failed', { error: e?.message || String(e) });
      const r = safeRouteError(e, { fallbackCode: 'QUERY_FAILED' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  router.get('/:id/expand', async (req, res) => {
    try {
      const include = typeof req.query.include === 'string'
        ? req.query.include.split(',').map(item => item.trim()).filter(Boolean)
        : undefined;
      const result = await expandRelation(opts.prisma, {
        id: req.params.id,
        include,
        limit: req.query.limit,
      });
      if (!(result as any).found) return res.status(404).json({ error: 'NOT_FOUND', message: 'Relation context not found' });
      return res.json({ ok: true, ...result });
    } catch (e: any) {
      logger.error('[relations/expand] failed', { error: e?.message || String(e) });
      const r = safeRouteError(e, { fallbackCode: 'EXPAND_FAILED' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const result = await getRelation(opts.prisma, { id: req.params.id });
      if (!(result as any).found) return res.status(404).json({ error: 'NOT_FOUND', message: 'Relation not found' });
      return res.json({ ok: true, relation: (result as any).item });
    } catch (e: any) {
      logger.error('[relations/detail] failed', { error: e?.message || String(e) });
      const r = safeRouteError(e, { fallbackCode: 'DETAIL_FAILED' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // ── 联系人体系统一：Contact 表 CRUD ─────────────────────────────
  // 联系人唯一真源为 Contact 表（种子数据/completeness「联系人」维度同源）；
  // Relation 人物子行仅为旧数据读兜底，不再作为联系人写入口。
  // 守卫对齐本文件口径：读=模块级 auth guard（同 GET /）；写=requireWrite(JWT) + relations:write。
  // 写纪律与 relationMutationService 一致：业务写 + AuditLog 同 $transaction。

  router.get('/:id/contacts', async (req, res) => {
    try {
      const rows = await (opts.prisma as any).contact.findMany({
        where: { relationId: req.params.id, deletedAt: null },
        orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
      });
      return res.json({ ok: true, contacts: rows.map(serializeContact) });
    } catch (e: any) {
      logger.error('[relations/contacts/list] failed', { error: e?.message || String(e) });
      const r = safeRouteError(e, { fallbackCode: 'LIST_FAILED' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  router.post('/:id/contacts', requireWrite, requirePermission('relations:write'), async (req, res) => {
    try {
      const input = req.body || {};
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!name) return res.status(400).json({ error: 'VALIDATION_FAILED', message: 'body.name 必填（联系人姓名）' });
      const prisma: any = opts.prisma;
      const relation = await prisma.relation.findFirst({ where: { id: req.params.id, deletedAt: null } });
      if (!relation) return res.status(404).json({ error: 'NOT_FOUND', message: 'Relation not found' });
      const created = await prisma.$transaction(async (tx: any) => {
        const now = BigInt(Date.now());
        const row = await tx.contact.create({
          data: {
            id: `CTC_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            relationId: req.params.id,
            name,
            ...contactWritableData(input),
            createdAt: now,
            updatedAt: now,
          },
        });
        await writeRouteAuditLog({
          prisma: tx,
          actorId: actorIdFromRequest(req),
          source: 'route:relation:contacts',
          operation: 'create_relation_contact',
          targetType: 'Contact',
          targetId: row.id,
          after: { relationId: req.params.id, name },
          ip: req.ip ?? null,
          operationType: 'create',
        });
        // 联系人真源回写：组织主联系人冗余字段同事务刷新（邮箱匹配/单据模板/订单预填等消费点即时保鲜）
        await syncOrganizationPrimaryContact(tx, req.params.id);
        return row;
      });
      opts.onDataChange?.({ entity: 'relations', action: 'upsert', ids: [req.params.id] });
      return res.json({ ok: true, contact: serializeContact(created) });
    } catch (e: any) {
      logger.error('[relations/contacts/create] failed', { error: e?.message || String(e) });
      const r = safeRouteError(e, { fallbackCode: 'CREATE_FAILED' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  router.patch('/:id/contacts/:contactId', requireWrite, requirePermission('relations:write'), async (req, res) => {
    try {
      const input = req.body || {};
      const patch = contactWritableData(input);
      if (input.name !== undefined) {
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        if (!name) return res.status(400).json({ error: 'VALIDATION_FAILED', message: 'body.name 不能为空' });
        patch.name = name;
      }
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'VALIDATION_FAILED', message: 'body 无可更新字段' });
      const prisma: any = opts.prisma;
      const existing = await prisma.contact.findFirst({
        where: { id: req.params.contactId, relationId: req.params.id, deletedAt: null },
      });
      if (!existing) return res.status(404).json({ error: 'NOT_FOUND', message: 'Contact not found' });
      const updated = await prisma.$transaction(async (tx: any) => {
        // 离职/停用（status 变为非 Active）自动让出主联系人标记——与 crmService.updateContact 同规约
        const patchData = { ...patch };
        if (patchData.status !== undefined && patchData.status !== 'Active' && existing.isPrimary) {
          patchData.isPrimary = false;
        }
        const row = await tx.contact.update({
          where: { id: existing.id },
          data: { ...patchData, updatedAt: BigInt(Date.now()) },
        });
        await writeRouteAuditLog({
          prisma: tx,
          actorId: actorIdFromRequest(req),
          source: 'route:relation:contacts',
          operation: 'update_relation_contact',
          targetType: 'Contact',
          targetId: row.id,
          before: { name: existing.name, title: existing.title, email: existing.email, phone: existing.phone, mobile: existing.mobile, isPrimary: existing.isPrimary, isDecisionMaker: existing.isDecisionMaker },
          after: patch,
          ip: req.ip ?? null,
          operationType: 'update',
        });
        // 联系人真源回写：主联系人变更/离职/资料修正后同事务刷新组织冗余字段
        await syncOrganizationPrimaryContact(tx, req.params.id);
        return row;
      });
      opts.onDataChange?.({ entity: 'relations', action: 'update', ids: [req.params.id] });
      return res.json({ ok: true, contact: serializeContact(updated) });
    } catch (e: any) {
      logger.error('[relations/contacts/update] failed', { error: e?.message || String(e) });
      const r = safeRouteError(e, { fallbackCode: 'UPDATE_FAILED' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  router.delete('/:id/contacts/:contactId', requireWrite, requirePermission('relations:write'), async (req, res) => {
    try {
      const prisma: any = opts.prisma;
      const existing = await prisma.contact.findFirst({
        where: { id: req.params.contactId, relationId: req.params.id, deletedAt: null },
      });
      if (!existing) return res.status(404).json({ error: 'NOT_FOUND', message: 'Contact not found' });
      const deleted = await prisma.$transaction(async (tx: any) => {
        const now = BigInt(Date.now());
        const row = await tx.contact.update({
          where: { id: existing.id },
          data: { deletedAt: now, updatedAt: now },
        });
        await writeRouteAuditLog({
          prisma: tx,
          actorId: actorIdFromRequest(req),
          source: 'route:relation:contacts',
          operation: 'delete_relation_contact',
          targetType: 'Contact',
          targetId: row.id,
          before: { name: existing.name, relationId: req.params.id },
          ip: req.ip ?? null,
          operationType: 'delete',
        });
        // 联系人真源回写：删除后组织主联系人可能易主/清空，同事务刷新冗余字段
        await syncOrganizationPrimaryContact(tx, req.params.id);
        return row;
      });
      opts.onDataChange?.({ entity: 'relations', action: 'delete', ids: [req.params.id] });
      return res.json({ ok: true, contact: serializeContact(deleted) });
    } catch (e: any) {
      logger.error('[relations/contacts/delete] failed', { error: e?.message || String(e) });
      const r = safeRouteError(e, { fallbackCode: 'DELETE_FAILED' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  router.post('/', requireWrite, requirePermission('relations:write'), async (req, res) => {
    const result = await createRelation({
      prisma: opts.prisma,
      input: req.body || {},
      actorId: actorIdFromRequest(req),
      ip: req.ip || null,
    });
    if (!result.ok) {
      const statusCodeMap: Record<string, number> = { INVALID_CATEGORY: 400, VALIDATION_FAILED: 400, NOT_FOUND: 404, CREATE_FAILED: 500, UPDATE_FAILED: 500, DELETE_FAILED: 500 };
      return res.status(statusCodeMap[result.error!.code] || 500).json({ error: result.error!.code, message: result.error!.message });
    }
    const saved = result.data!.relation;
    opts.onDataChange?.({ entity: 'relations', action: 'upsert', ids: [saved.id] });
    return res.json({ ok: true, relation: serializeRelation(saved) });
  });

  router.put('/:id', requireWrite, requirePermission('relations:write'), async (req, res) => {
    const result = await updateRelation({
      prisma: opts.prisma,
      relationId: req.params.id,
      input: req.body || {},
      actorId: actorIdFromRequest(req),
      ip: req.ip || null,
    });
    if (!result.ok) {
      const statusCodeMap: Record<string, number> = { INVALID_CATEGORY: 400, VALIDATION_FAILED: 400, NOT_FOUND: 404, CREATE_FAILED: 500, UPDATE_FAILED: 500, DELETE_FAILED: 500 };
      return res.status(statusCodeMap[result.error!.code] || 500).json({ error: result.error!.code, message: result.error!.message });
    }
    const saved = result.data!.relation;
    opts.onDataChange?.({ entity: 'relations', action: 'update', ids: [saved.id] });
    return res.json({ ok: true, relation: serializeRelation(saved) });
  });

  router.delete('/:id', requireWrite, requirePermission('business:delete'), async (req, res) => {
    const result = await deleteRelation({
      prisma: opts.prisma,
      relationId: req.params.id,
      actorId: actorIdFromRequest(req),
      ip: req.ip || null,
    });
    if (!result.ok) {
      const statusCodeMap: Record<string, number> = { INVALID_CATEGORY: 400, VALIDATION_FAILED: 400, NOT_FOUND: 404, CREATE_FAILED: 500, UPDATE_FAILED: 500, DELETE_FAILED: 500 };
      return res.status(statusCodeMap[result.error!.code] || 500).json({ error: result.error!.code, message: result.error!.message });
    }
    const saved = result.data!.relation;
    opts.onDataChange?.({ entity: 'relations', action: 'delete', ids: [saved.id] });
    return res.json({ ok: true, relation: serializeRelation(saved) });
  });

  return router;
}

function toDbPayload(input: any): Record<string, unknown> {
  const coordinates = input.coordinates || {};

  // Auto-resolve coordinates when not provided
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
    tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
    contactInfo: String(input.contactInfo || ''),
    rating: Number(input.rating || 3),
    lastInteraction: BigInt(Number(input.lastInteraction || Date.now())),
    preferences: input.preferences || '',
    deletedAt: input.deletedAt ? BigInt(Number(input.deletedAt)) : null,
    website: input.website || null,
    chineseName: input.chineseName || null,
    englishName: input.englishName || null,
    creditLevel: null,
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
  };
}

function normalizeJsonArray(value: unknown): unknown[] {
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

function serializeRelation(row: any, contactCountByRelation?: Map<string, number>) {
  const out: any = { ...row };
  if (typeof out.lastInteraction === 'bigint') out.lastInteraction = Number(out.lastInteraction);
  if (typeof out.deletedAt === 'bigint') out.deletedAt = Number(out.deletedAt);
  if (out.coordinatesLat !== null && out.coordinatesLat !== undefined && out.coordinatesLng !== null && out.coordinatesLng !== undefined) {
    out.coordinates = { lat: out.coordinatesLat, lng: out.coordinatesLng };
  }
  delete out.coordinatesLat;
  delete out.coordinatesLng;
  // 联系人计数徽标（Contact 表存活行聚合，GET / 列表注入）；人物子行无该字段
  if (out.isOrganization && contactCountByRelation) {
    out.contactCount = contactCountByRelation.get(out.id) ?? 0;
  }
  return out;
}

// Contact 表可写字段白名单（POST/PATCH 共用）：title/department/email/phone/mobile/wechat/whatsapp/
// birthday/personalNote/status + tags + isPrimary/isDecisionMaker；name 由端点单独校验。
// 空 string 归一为 null（Contact 表语义：未填=NULL）。
const CONTACT_WRITABLE_TEXT_FIELDS = ['title', 'department', 'email', 'phone', 'mobile', 'wechat', 'whatsapp', 'birthday', 'personalNote', 'status'] as const;

function contactWritableData(input: any): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const key of CONTACT_WRITABLE_TEXT_FIELDS) {
    if (input[key] === undefined) continue;
    const value = typeof input[key] === 'string' ? input[key].trim() : input[key];
    data[key] = value === '' || value == null ? null : String(value);
  }
  if (Array.isArray(input.tags)) data.tags = input.tags.map(String).filter(Boolean);
  if (input.isPrimary !== undefined) data.isPrimary = Boolean(input.isPrimary);
  if (input.isDecisionMaker !== undefined) data.isDecisionMaker = Boolean(input.isDecisionMaker);
  return data;
}

function serializeContact(row: any) {
  const out: any = { ...row };
  for (const key of ['createdAt', 'updatedAt', 'deletedAt']) {
    if (typeof out[key] === 'bigint') out[key] = Number(out[key]);
  }
  return out;
}
