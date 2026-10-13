/**
 * 阶段 P3b — 邮件签名服务（PRD 12.1 EmailSignature）
 *
 * 统一公司签名格式（联系方式/地址/银行信息）；content 支持 {{variable}}（如 {{senderName}}），
 * variables 创建/更新时自动解析（共享 lib/templateVariables，与邮件/单据模板同口径）。
 * 同 language 下 isDefault 唯一（事务内清除其他默认）。
 */

import { PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import { extractTemplateVariables } from '../lib/templateVariables';

export type SignatureLanguage = 'zh' | 'en' | 'bilingual';

export interface EmailSignatureInput {
  name: string;
  language?: SignatureLanguage;
  content: string;
  isDefault?: boolean;
  isActive?: boolean;
  notes?: string;
}

const VALID_LANGUAGES: SignatureLanguage[] = ['zh', 'en', 'bilingual'];

const now = (): bigint => BigInt(Date.now());

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function validateLanguage(lang: string): asserts lang is SignatureLanguage {
  if (!VALID_LANGUAGES.includes(lang as SignatureLanguage)) throw new Error(`非法签名语言: ${lang}`);
}

export function createEmailSignatureService(prisma: PrismaClient) {
  const db = prisma as any;

  async function listSignatures(filter: { language?: string; includeInactive?: boolean } = {}) {
    const where: any = { deletedAt: null };
    if (filter.language) where.language = filter.language;
    if (!filter.includeInactive) where.isActive = true;
    const items = await db.emailSignature.findMany({
      where,
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
    });
    return { items, total: items.length };
  }

  async function getSignature(id: string) {
    const item = await db.emailSignature.findFirst({ where: { id, deletedAt: null } });
    if (!item) throw new Error(`邮件签名 ${id} 不存在`);
    return item;
  }

  /** 事务内保证同 language 默认签名唯一 */
  async function applyDefaultUniqueness(tx: any, language: string, excludeId: string | null) {
    await tx.emailSignature.updateMany({
      where: {
        language,
        isDefault: true,
        deletedAt: null,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      data: { isDefault: false, updatedAt: now() },
    });
  }

  async function createSignature(input: EmailSignatureInput, actorId: string) {
    const language = input.language ?? 'bilingual';
    validateLanguage(language);
    if (!input.name?.trim()) throw new Error('签名名称必填');
    if (!input.content?.trim()) throw new Error('签名内容必填');

    const ts = now();
    const item = await db.$transaction(async (tx: any) => {
      if (input.isDefault) await applyDefaultUniqueness(tx, language, null);
      const created = await tx.emailSignature.create({
        data: {
          id: generateId('ESIG'),
          name: input.name.trim(),
          language,
          content: input.content,
          variables: extractTemplateVariables(input.content),
          isDefault: input.isDefault ?? false,
          isActive: input.isActive ?? true,
          notes: input.notes?.trim() || null,
          createdAt: ts,
          updatedAt: ts,
        },
      });
      await tx.auditLog.create({
        data: {
          id: generateId('AUD'),
          action: 'EMAIL_SIGNATURE_CREATE',
          actorId,
          targetType: 'EmailSignature',
          targetId: created.id,
          detail: { name: created.name, language, isDefault: created.isDefault },
        },
      });
      return created;
    });
    logger.info('[EmailSignature] created', { id: item.id, actorId });
    return item;
  }

  async function updateSignature(id: string, patch: Partial<EmailSignatureInput>, actorId: string) {
    const existing = await db.emailSignature.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new Error(`邮件签名 ${id} 不存在`);
    if (patch.language !== undefined) validateLanguage(patch.language);
    if (patch.name !== undefined && !patch.name.trim()) throw new Error('签名名称不可为空');
    if (patch.content !== undefined && !patch.content.trim()) throw new Error('签名内容不可为空');

    const nextLanguage = patch.language ?? existing.language;
    const nextContent = patch.content ?? existing.content;

    const item = await db.$transaction(async (tx: any) => {
      if (patch.isDefault === true) await applyDefaultUniqueness(tx, nextLanguage, id);
      const updated = await tx.emailSignature.update({
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
          action: 'EMAIL_SIGNATURE_UPDATE',
          actorId,
          targetType: 'EmailSignature',
          targetId: id,
          detail: { patch: Object.keys(patch) },
        },
      });
      return updated;
    });
    logger.info('[EmailSignature] updated', { id, actorId });
    return item;
  }

  async function deleteSignature(id: string, actorId: string) {
    const existing = await db.emailSignature.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new Error(`邮件签名 ${id} 不存在`);
    await db.$transaction(async (tx: any) => {
      await tx.emailSignature.update({ where: { id }, data: { deletedAt: now(), updatedAt: now() } });
      await tx.auditLog.create({
        data: {
          id: generateId('AUD'),
          action: 'EMAIL_SIGNATURE_DELETE',
          actorId,
          targetType: 'EmailSignature',
          targetId: id,
          detail: { name: existing.name },
        },
      });
    });
    logger.info('[EmailSignature] deleted', { id, actorId });
  }

  return {
    listSignatures,
    getSignature,
    createSignature,
    updateSignature,
    deleteSignature,
  };
}
