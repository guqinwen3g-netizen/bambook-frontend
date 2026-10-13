/**
 * 阶段 P3b — 品牌线 / 沟通日志服务（PRD 6.2 BrandLine + PRD 12.3 CommunicationLog）
 *
 * 职责：
 *   1. BrandLine：客户品牌下的产品线 CRUD（同客户下名称唯一，service 层校验未删记录）
 *   2. CommunicationLog：全渠道沟通流水 CRUD（方向/渠道/摘要 + 邮件/订单/报价关联）
 *
 * 设计原则：
 *   - 软删除（deletedAt BigInt）
 *   - snapshot FK（relationId/contactId 不加 DB 外键，与 CommissionRule 同口径）
 *   - relationId 存在性校验（fail-closed：客户不存在或已删拒绝挂线/挂日志）
 *   - 事务内写审计日志
 */

import { PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';

// ────────────────────────────────────────────────────────────────
// 类型
// ────────────────────────────────────────────────────────────────

export interface BrandLineInput {
  name: string;
  code?: string;
  description?: string;
  isActive?: boolean;
  notes?: string;
}

export type CommunicationType = 'Email' | 'Call' | 'WeChat' | 'Visit' | 'Meeting' | 'Other';
export type CommunicationDirection = 'Inbound' | 'Outbound';

export interface CommunicationLogInput {
  contactId?: string;
  type: CommunicationType;
  direction?: CommunicationDirection;
  subject?: string;
  summary: string;
  occurredAt: string;
  emailMessageId?: string;
  orderId?: string;
  quotationId?: string;
  notes?: string;
}

const VALID_COMM_TYPES: CommunicationType[] = ['Email', 'Call', 'WeChat', 'Visit', 'Meeting', 'Other'];
const VALID_DIRECTIONS: CommunicationDirection[] = ['Inbound', 'Outbound'];

const now = (): bigint => BigInt(Date.now());

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ════════════════════════════════════════════════════════════════
// Service Factory
// ════════════════════════════════════════════════════════════════

export function createBrandLineService(prisma: PrismaClient) {
  const db = prisma as any;

  async function assertRelationExists(relationId: string) {
    const rel = await db.relation.findFirst({ where: { id: relationId, deletedAt: null }, select: { id: true } });
    if (!rel) throw new Error(`客户 ${relationId} 不存在`);
  }

  // ────────────────────────────────────────────────────────────
  // 1. BrandLine（品牌线）
  // ────────────────────────────────────────────────────────────

  async function listBrandLines(relationId: string, includeInactive = false) {
    await assertRelationExists(relationId);
    const where: any = { relationId, deletedAt: null };
    if (!includeInactive) where.isActive = true;
    const items = await db.brandLine.findMany({ where, orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }] });
    return { items, total: items.length };
  }

  async function createBrandLine(relationId: string, input: BrandLineInput, actorId: string) {
    await assertRelationExists(relationId);
    if (!input.name?.trim()) throw new Error('品牌线名称必填');
    const dup = await db.brandLine.findFirst({
      where: { relationId, name: input.name.trim(), deletedAt: null },
      select: { id: true },
    });
    if (dup) throw new Error(`品牌线 ${input.name.trim()} 已存在`);

    const ts = now();
    const item = await db.$transaction(async (tx: any) => {
      const created = await tx.brandLine.create({
        data: {
          id: generateId('BL'),
          relationId,
          name: input.name.trim(),
          code: input.code?.trim() || null,
          description: input.description?.trim() || null,
          isActive: input.isActive ?? true,
          notes: input.notes?.trim() || null,
          createdAt: ts,
          updatedAt: ts,
        },
      });
      await tx.auditLog.create({
        data: {
          id: generateId('AUD'),
          action: 'BRAND_LINE_CREATE',
          actorId,
          targetType: 'BrandLine',
          targetId: created.id,
          detail: { relationId, name: created.name },
        },
      });
      return created;
    });
    logger.info('[BrandLine] created', { id: item.id, relationId, actorId });
    return item;
  }

  async function updateBrandLine(id: string, patch: Partial<BrandLineInput>, actorId: string) {
    const existing = await db.brandLine.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new Error(`品牌线 ${id} 不存在`);
    if (patch.name !== undefined) {
      if (!patch.name.trim()) throw new Error('品牌线名称不可为空');
      if (patch.name.trim() !== existing.name) {
        const dup = await db.brandLine.findFirst({
          where: { relationId: existing.relationId, name: patch.name.trim(), deletedAt: null, id: { not: id } },
          select: { id: true },
        });
        if (dup) throw new Error(`品牌线 ${patch.name.trim()} 已存在`);
      }
    }
    const item = await db.$transaction(async (tx: any) => {
      const updated = await tx.brandLine.update({
        where: { id },
        data: {
          ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
          ...(patch.code !== undefined ? { code: patch.code?.trim() || null } : {}),
          ...(patch.description !== undefined ? { description: patch.description?.trim() || null } : {}),
          ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
          ...(patch.notes !== undefined ? { notes: patch.notes?.trim() || null } : {}),
          updatedAt: now(),
        },
      });
      await tx.auditLog.create({
        data: {
          id: generateId('AUD'),
          action: 'BRAND_LINE_UPDATE',
          actorId,
          targetType: 'BrandLine',
          targetId: id,
          detail: { patch: Object.keys(patch) },
        },
      });
      return updated;
    });
    logger.info('[BrandLine] updated', { id, actorId });
    return item;
  }

  async function deleteBrandLine(id: string, actorId: string) {
    const existing = await db.brandLine.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new Error(`品牌线 ${id} 不存在`);
    await db.$transaction(async (tx: any) => {
      await tx.brandLine.update({ where: { id }, data: { deletedAt: now(), updatedAt: now() } });
      await tx.auditLog.create({
        data: {
          id: generateId('AUD'),
          action: 'BRAND_LINE_DELETE',
          actorId,
          targetType: 'BrandLine',
          targetId: id,
          detail: { relationId: existing.relationId, name: existing.name },
        },
      });
    });
    logger.info('[BrandLine] deleted', { id, actorId });
  }

  // ────────────────────────────────────────────────────────────
  // 2. CommunicationLog（沟通日志）
  // ────────────────────────────────────────────────────────────

  async function listCommunicationLogs(relationId: string, filter: { type?: string; direction?: string; limit?: number; offset?: number } = {}) {
    await assertRelationExists(relationId);
    const where: any = { relationId, deletedAt: null };
    if (filter.type) where.type = filter.type;
    if (filter.direction) where.direction = filter.direction;
    const take = Math.min(filter.limit ?? 100, 500);
    const skip = filter.offset ?? 0;
    const [items, total] = await Promise.all([
      db.communicationLog.findMany({ where, orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }], take, skip }),
      db.communicationLog.count({ where }),
    ]);
    return { items, total, limit: take, offset: skip };
  }

  async function createCommunicationLog(relationId: string, input: CommunicationLogInput, actorId: string) {
    await assertRelationExists(relationId);
    if (!VALID_COMM_TYPES.includes(input.type)) throw new Error(`非法沟通类型: ${input.type}`);
    const direction = input.direction ?? 'Outbound';
    if (!VALID_DIRECTIONS.includes(direction)) throw new Error(`非法沟通方向: ${direction}`);
    if (!input.summary?.trim()) throw new Error('沟通摘要必填');
    if (!input.occurredAt || !DATE_RE.test(input.occurredAt)) throw new Error('沟通日期格式须为 YYYY-MM-DD');
    if (input.contactId) {
      // 联系人统一（写路径收敛）：Contact 表为联系人写真源（CRM 联系人 CRUD 与
      // /api/v1/relations/:id/contacts 同源），历史 FollowUp/沟通记录的 contactId
      // 仍引用 Relation 人物 id——校验双源兼容：Contact 表优先，未命中回退人物轨。
      const contactRow = await db.contact.findFirst({
        where: { id: input.contactId, relationId, deletedAt: null },
        select: { id: true },
      });
      const person = contactRow ? null : await db.relation.findFirst({
        where: { id: input.contactId, parentId: relationId, isOrganization: false, deletedAt: null },
        select: { id: true },
      });
      // 输入校验失败语义为 400（非目标资源缺失），措辞避开路由的“不存在→404”映射
      if (!contactRow && !person) throw new Error(`联系人 ${input.contactId} 不属于该客户或已删除`);
    }

    const ts = now();
    const item = await db.$transaction(async (tx: any) => {
      const created = await tx.communicationLog.create({
        data: {
          id: generateId('CL'),
          relationId,
          contactId: input.contactId ?? null,
          type: input.type,
          direction,
          subject: input.subject?.trim() || null,
          summary: input.summary.trim(),
          occurredAt: input.occurredAt,
          emailMessageId: input.emailMessageId ?? null,
          orderId: input.orderId ?? null,
          quotationId: input.quotationId ?? null,
          loggedBy: actorId,
          notes: input.notes?.trim() || null,
          createdAt: ts,
          updatedAt: ts,
        },
      });
      await tx.auditLog.create({
        data: {
          id: generateId('AUD'),
          action: 'COMMUNICATION_LOG_CREATE',
          actorId,
          targetType: 'CommunicationLog',
          targetId: created.id,
          detail: { relationId, type: input.type, direction, occurredAt: input.occurredAt },
        },
      });
      return created;
    });
    logger.info('[CommunicationLog] created', { id: item.id, relationId, type: input.type, actorId });
    return item;
  }

  async function updateCommunicationLog(id: string, patch: Partial<CommunicationLogInput>, actorId: string) {
    const existing = await db.communicationLog.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new Error(`沟通日志 ${id} 不存在`);
    if (patch.type !== undefined && !VALID_COMM_TYPES.includes(patch.type)) throw new Error(`非法沟通类型: ${patch.type}`);
    if (patch.direction !== undefined && !VALID_DIRECTIONS.includes(patch.direction)) throw new Error(`非法沟通方向: ${patch.direction}`);
    if (patch.summary !== undefined && !patch.summary.trim()) throw new Error('沟通摘要不可为空');
    if (patch.occurredAt !== undefined && !DATE_RE.test(patch.occurredAt)) throw new Error('沟通日期格式须为 YYYY-MM-DD');
    if (patch.contactId) {
      const contact = await db.contact.findFirst({
        where: { id: patch.contactId, relationId: existing.relationId, deletedAt: null },
        select: { id: true },
      });
      if (!contact) throw new Error(`联系人 ${patch.contactId} 不属于该客户或已删除`);
    }

    const item = await db.$transaction(async (tx: any) => {
      const updated = await tx.communicationLog.update({
        where: { id },
        data: {
          ...(patch.contactId !== undefined ? { contactId: patch.contactId || null } : {}),
          ...(patch.type !== undefined ? { type: patch.type } : {}),
          ...(patch.direction !== undefined ? { direction: patch.direction } : {}),
          ...(patch.subject !== undefined ? { subject: patch.subject?.trim() || null } : {}),
          ...(patch.summary !== undefined ? { summary: patch.summary.trim() } : {}),
          ...(patch.occurredAt !== undefined ? { occurredAt: patch.occurredAt } : {}),
          ...(patch.emailMessageId !== undefined ? { emailMessageId: patch.emailMessageId || null } : {}),
          ...(patch.orderId !== undefined ? { orderId: patch.orderId || null } : {}),
          ...(patch.quotationId !== undefined ? { quotationId: patch.quotationId || null } : {}),
          ...(patch.notes !== undefined ? { notes: patch.notes?.trim() || null } : {}),
          updatedAt: now(),
        },
      });
      await tx.auditLog.create({
        data: {
          id: generateId('AUD'),
          action: 'COMMUNICATION_LOG_UPDATE',
          actorId,
          targetType: 'CommunicationLog',
          targetId: id,
          detail: { patch: Object.keys(patch) },
        },
      });
      return updated;
    });
    logger.info('[CommunicationLog] updated', { id, actorId });
    return item;
  }

  async function deleteCommunicationLog(id: string, actorId: string) {
    const existing = await db.communicationLog.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new Error(`沟通日志 ${id} 不存在`);
    await db.$transaction(async (tx: any) => {
      await tx.communicationLog.update({ where: { id }, data: { deletedAt: now(), updatedAt: now() } });
      await tx.auditLog.create({
        data: {
          id: generateId('AUD'),
          action: 'COMMUNICATION_LOG_DELETE',
          actorId,
          targetType: 'CommunicationLog',
          targetId: id,
          detail: { relationId: existing.relationId, type: existing.type },
        },
      });
    });
    logger.info('[CommunicationLog] deleted', { id, actorId });
  }

  return {
    listBrandLines,
    createBrandLine,
    updateBrandLine,
    deleteBrandLine,
    listCommunicationLogs,
    createCommunicationLog,
    updateCommunicationLog,
    deleteCommunicationLog,
  };
}
