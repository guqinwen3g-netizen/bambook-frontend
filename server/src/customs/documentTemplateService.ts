import { rejectGenericPackingListWrite } from './shipmentPackingListCommand';
import { rejectGenericSupplierDocumentWrite } from './supplierContractDocumentPolicy';
/**
 * 阶段 P3a — 单据模板与版本服务（PRD 11.3）
 *
 * 职责：
 *   1. DocumentTemplate：单据模板 CRUD（type/language/默认模板唯一性/变量自动解析/软删）
 *   2. DocumentVersion：TradeDocument 内容变更留痕（版本号按 documentId 单调递增，只增不删）
 *
 * 设计原则：
 *   - 软删除（deletedAt BigInt），版本不留 deletedAt（随主单软删隐藏）
 *   - isDefault 同 type+language 下唯一（事务内清除其他默认），fail-closed
 *   - variables 创建/更新时自动从 content 解析（共享 lib/templateVariables，与邮件模板同口径）
 *   - 版本号 max+1 事务内计算，防并发跳号；content 为变更后整行字段快照（Json）
 */

import { PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import { extractTemplateVariables } from '../lib/templateVariables';

// ────────────────────────────────────────────────────────────────
// 类型
// ────────────────────────────────────────────────────────────────

export type DocumentTemplateType =
  | 'Quotation'
  | 'SalesConfirmation'
  | 'ProformaInvoice'
  | 'CommercialInvoice'
  | 'PackingList'
  | 'BillOfLading'
  | 'AirWaybill'
  | 'CertificateOfOrigin'
  | 'InsuranceCert'
  | 'InspectionCert'
  | 'InspectionReport'
  | 'Statement'
  | 'Other';

export type DocumentTemplateLanguage = 'zh' | 'en' | 'bilingual';

export interface DocumentTemplateInput {
  type: DocumentTemplateType;
  name: string;
  language?: DocumentTemplateLanguage;
  content: string;
  isDefault?: boolean;
  isActive?: boolean;
  notes?: string;
}

export interface DocumentTemplatePatch {
  name?: string;
  language?: DocumentTemplateLanguage;
  content?: string;
  isDefault?: boolean;
  isActive?: boolean;
  notes?: string;
}

export interface DocumentVersionInput {
  content: Record<string, unknown>;
  changeReason?: string;
  changedBy?: string;
}

const VALID_TYPES: DocumentTemplateType[] = [
  'Quotation', 'SalesConfirmation', 'ProformaInvoice', 'CommercialInvoice',
  'PackingList', 'BillOfLading', 'AirWaybill', 'CertificateOfOrigin',
  'InsuranceCert', 'InspectionCert', 'InspectionReport', 'Statement', 'Other',
];
const VALID_LANGUAGES: DocumentTemplateLanguage[] = ['zh', 'en', 'bilingual'];

const now = (): bigint => BigInt(Date.now());

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function validateType(type: string): asserts type is DocumentTemplateType {
  if (!VALID_TYPES.includes(type as DocumentTemplateType)) throw new Error(`非法单据模板类型: ${type}`);
}
function validateLanguage(lang: string): asserts lang is DocumentTemplateLanguage {
  if (!VALID_LANGUAGES.includes(lang as DocumentTemplateLanguage)) throw new Error(`非法模板语言: ${lang}`);
}

// ════════════════════════════════════════════════════════════════
// Service Factory
// ════════════════════════════════════════════════════════════════

export function createDocumentTemplateService(prisma: PrismaClient) {
  const db = prisma as any;

  // ────────────────────────────────────────────────────────────
  // 1. DocumentTemplate（单据模板）
  // ────────────────────────────────────────────────────────────

  async function listTemplates(filter: { type?: string; language?: string; includeInactive?: boolean }) {
    const where: any = { deletedAt: null };
    if (filter.type) where.type = filter.type;
    if (filter.language) where.language = filter.language;
    if (!filter.includeInactive) where.isActive = true;
    const items = await db.documentTemplate.findMany({
      where,
      orderBy: [{ type: 'asc' }, { isDefault: 'desc' }, { updatedAt: 'desc' }],
    });
    return { items, total: items.length };
  }

  async function getTemplate(id: string) {
    const item = await db.documentTemplate.findFirst({ where: { id, deletedAt: null } });
    if (!item) throw new Error(`单据模板 ${id} 不存在`);
    return item;
  }

  /** 事务内保证同 type+language 默认模板唯一：设默认时清除其他默认 */
  async function applyDefaultUniqueness(tx: any, type: string, language: string, excludeId: string | null) {
    await tx.documentTemplate.updateMany({
      where: {
        type,
        language,
        isDefault: true,
        deletedAt: null,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      data: { isDefault: false, updatedAt: now() },
    });
  }

  async function createTemplate(input: DocumentTemplateInput, actorId: string) {
    validateType(input.type);
    const language = input.language ?? 'bilingual';
    validateLanguage(language);
    if (!input.name?.trim()) throw new Error('模板名称必填');
    if (!input.content?.trim()) throw new Error('模板内容必填');

    const ts = now();
    const item = await db.$transaction(async (tx: any) => {
      if (input.isDefault) await applyDefaultUniqueness(tx, input.type, language, null);
      const created = await tx.documentTemplate.create({
        data: {
          id: generateId('DTPL'),
          type: input.type,
          name: input.name.trim(),
          language,
          content: input.content,
          variables: extractTemplateVariables(input.content),
          isDefault: input.isDefault ?? false,
          isActive: input.isActive ?? true,
          notes: input.notes?.trim() || null,
          createdBy: actorId,
          createdAt: ts,
          updatedAt: ts,
        },
      });
      await tx.auditLog.create({
        data: {
          id: generateId('AUD'),
          action: 'DOCUMENT_TEMPLATE_CREATE',
          actorId,
          targetType: 'DocumentTemplate',
          targetId: created.id,
          detail: { type: input.type, name: input.name.trim(), language, isDefault: created.isDefault },
        },
      });
      return created;
    });
    logger.info('[DocumentTemplate] created', { id: item.id, type: input.type, actorId });
    return item;
  }

  async function updateTemplate(id: string, patch: DocumentTemplatePatch, actorId: string) {
    const existing = await db.documentTemplate.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new Error(`单据模板 ${id} 不存在`);
    if (patch.language !== undefined) validateLanguage(patch.language);
    if (patch.name !== undefined && !patch.name.trim()) throw new Error('模板名称不可为空');
    if (patch.content !== undefined && !patch.content.trim()) throw new Error('模板内容不可为空');

    const nextLanguage = patch.language ?? existing.language;
    const nextContent = patch.content ?? existing.content;

    const item = await db.$transaction(async (tx: any) => {
      if (patch.isDefault === true) await applyDefaultUniqueness(tx, existing.type, nextLanguage, id);
      const updated = await tx.documentTemplate.update({
        where: { id },
        data: {
          ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
          ...(patch.language !== undefined ? { language: patch.language } : {}),
          ...(patch.content !== undefined
            ? { content: patch.content, variables: extractTemplateVariables(nextContent) }
            : {}),
          ...(patch.isDefault !== undefined ? { isDefault: patch.isDefault } : {}),
          ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
          ...(patch.notes !== undefined ? { notes: patch.notes?.trim() || null } : {}),
          updatedAt: now(),
        },
      });
      await tx.auditLog.create({
        data: {
          id: generateId('AUD'),
          action: 'DOCUMENT_TEMPLATE_UPDATE',
          actorId,
          targetType: 'DocumentTemplate',
          targetId: id,
          detail: { patch: Object.keys(patch) },
        },
      });
      return updated;
    });
    logger.info('[DocumentTemplate] updated', { id, actorId });
    return item;
  }

  async function deleteTemplate(id: string, actorId: string) {
    const existing = await db.documentTemplate.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new Error(`单据模板 ${id} 不存在`);
    await db.$transaction(async (tx: any) => {
      await tx.documentTemplate.update({ where: { id }, data: { deletedAt: now(), updatedAt: now() } });
      await tx.auditLog.create({
        data: {
          id: generateId('AUD'),
          action: 'DOCUMENT_TEMPLATE_DELETE',
          actorId,
          targetType: 'DocumentTemplate',
          targetId: id,
          detail: { type: existing.type, name: existing.name },
        },
      });
    });
    logger.info('[DocumentTemplate] deleted', { id, actorId });
  }

  // ────────────────────────────────────────────────────────────
  // 2. DocumentVersion（单据版本留痕）
  // ────────────────────────────────────────────────────────────

  async function listVersions(documentId: string) {
    const doc = await db.tradeDocument.findFirst({ where: { id: documentId, deletedAt: null }, select: { id: true } });
    if (!doc) throw new Error(`单据 ${documentId} 不存在`);
    const items = await db.documentVersion.findMany({
      where: { documentId },
      orderBy: { version: 'desc' },
    });
    return { items, total: items.length };
  }

  async function getVersion(documentId: string, version: number) {
    const item = await db.documentVersion.findUnique({
      where: { documentId_version: { documentId, version } },
    });
    if (!item) throw new Error(`单据 ${documentId} 版本 ${version} 不存在`);
    return item;
  }

  /** 版本号 max+1 事务内计算，防并发跳号；content 为变更后整行字段快照 */
  async function createVersion(documentId: string, input: DocumentVersionInput, actorId: string) {
    if (!input.content || typeof input.content !== 'object' || Array.isArray(input.content)) {
      throw new Error('版本快照 content 必填且须为对象');
    }
    const item = await db.$transaction(async (tx: any) => {
      const doc = await tx.tradeDocument.findFirst({ where: { id: documentId, deletedAt: null }, select: { id: true } });
      if (!doc) throw new Error(`单据 ${documentId} 不存在`);
      rejectGenericSupplierDocumentWrite(await tx.tradeDocument.findFirst({ where: { id: documentId, deletedAt: null } }));
      await rejectGenericPackingListWrite(tx, await tx.tradeDocument.findFirst({ where: { id: documentId, deletedAt: null } }), input.content);
      const last = await tx.documentVersion.findFirst({
        where: { documentId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const nextVersion = (last?.version ?? 0) + 1;
      const created = await tx.documentVersion.create({
        data: {
          id: generateId('DVER'),
          documentId,
          version: nextVersion,
          content: input.content,
          changeReason: input.changeReason?.trim() || null,
          changedBy: input.changedBy?.trim() || actorId,
          createdAt: now(),
        },
      });
      await tx.auditLog.create({
        data: {
          id: generateId('AUD'),
          action: 'DOCUMENT_VERSION_CREATE',
          actorId,
          targetType: 'DocumentVersion',
          targetId: created.id,
          detail: { documentId, version: nextVersion, changeReason: input.changeReason ?? null },
        },
      });
      return created;
    });
    logger.info('[DocumentVersion] created', { id: item.id, documentId, version: item.version, actorId });
    return item;
  }

  return {
    listTemplates,
    getTemplate,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    listVersions,
    getVersion,
    createVersion,
  };
}
