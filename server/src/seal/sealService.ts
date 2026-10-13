/**
 * §10.3-9 电子签·印章库服务（Seal）
 *
 * 全局印章管理：按公司/角色/用户上传公章图（base64 data URL），渲染单据 PDF 时
 * 按签字人解析出对应章图（resolveSealForSigner）。isDefault 全局唯一（兜底章）。
 *
 * 解析优先级：ownerUserId 精确匹配 > ownerRoleId 匹配 > isDefault 兜底 > null。
 * 软删（deletedAt）；写操作落 auditLog。
 */

import { PrismaClient } from '@prisma/client';
import { SYSTEM_ROLE_IDS } from '../_shared/rolePermissionMatrix';
import { logger } from '../lib/logger';

export const SEAL_TYPES = ['company_seal', 'legal_rep_seal', 'finance_seal', 'other'] as const;
export type SealType = (typeof SEAL_TYPES)[number];

/** 章图上限：base64 data URL 字符数（约 2MB PNG 余量） */
const MAX_IMAGE_LEN = 3_000_000;

/**
 * 允许入局的章图 MIME（PDF 渲染链实测稳定）。
 * 明确**拒绝 SVG**：SVG 可内嵌 <script>/onload，且 PDF 渲染器（无头 Chromium）对 SVG
 * 支持不稳（常渲染成空白或错位）——业务方给的章图可能是 SVG，必须在这里挡掉而不是留到渲染时炸。
 */
const ALLOWED_SEAL_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/**
 * base64 合法字符集。刻意收紧：不含引号 / 尖括号 / 空白 / 换行 ——
 * 章图最终会被原样内联进 `<img src="…">`，只要 payload 里出现一个双引号就能
 * 闭合 src 属性注入 onerror/onload（存储型 XSS：管理员上传、所有看单据的人触发）。
 */
const BASE64_PAYLOAD_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export interface SealInput {
  name: string;
  type?: SealType;
  imageDataUrl: string;
  ownerRoleId?: string | null;
  ownerUserId?: string | null;
  isDefault?: boolean;
  isActive?: boolean;
  notes?: string;
}

export interface ResolvedSeal {
  id: string;
  name: string;
  imageDataUrl: string;
}

/**
 * 校验失败专用错误：标记「这是调用方输入问题，不是服务器故障」。
 * 路由层据此返回 400 —— 此前靠错误消息字符串匹配关键词判状态码，
 * 新增校验文案一旦不含"非法/必填/过大"等词就会误报 500（污染告警、误导前端重试）。
 *
 * S0-A Task 4 核定：补 `code` + `statusCode` 透传契约（sealRoute:73 的 `instanceof` 判定照旧有效，
 * 另一个消费点 `templates/docTemplates/registry` 的 `resolveSealSafe` 自行吞掉不影响渲染），
 * 这样任何接了真源（`safeRouteError` / `globalErrorHandler`）的路径也不会把
 * 「印章图必填」这类业务文案兜成通用 500（当前无活路径 ⇒ 潜在修复）。参数带默认值 ⇒ 抛出点不用改。
 */
export class SealValidationError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(message: string, code = 'SEAL_VALIDATION_FAILED', statusCode = 400) {
    super(message);
    this.name = 'SealValidationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const now = (): bigint => BigInt(Date.now());

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function validateSealType(t: string): asserts t is SealType {
  if (!SEAL_TYPES.includes(t as SealType)) throw new SealValidationError(`非法印章类型: ${t}`);
}

/**
 * 章图校验（2026-09-15 加固）：
 *  ① 必须是 base64 data URL（拒绝 `data:image/svg+xml,<svg onload=…>` 这类非 base64 内联）；
 *  ② MIME 限 PNG/JPEG/GIF/WebP（拒绝 SVG）；
 *  ③ base64 内容限合法字符集（拒绝引号/尖括号/空白 → 杜绝属性闭合注入）；
 *  ④ 长度上限。
 * 任一条不过即拒，绝不放行到渲染层。
 */
function validateImage(dataUrl: string): void {
  if (!dataUrl) throw new SealValidationError('印章图必填');
  const m = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,([\s\S]*)$/.exec(dataUrl);
  if (!m) {
    throw new SealValidationError('非法印章图：须为 base64 编码的 data URL（如 data:image/png;base64,…）；不支持 SVG，也不支持非 base64 的内联图像');
  }
  const mime = m[1].toLowerCase();
  if (!(ALLOWED_SEAL_MIME as readonly string[]).includes(mime)) {
    throw new SealValidationError(`不支持的印章图格式：${mime}（仅支持 PNG / JPEG / GIF / WebP；SVG 可含脚本且 PDF 渲染不稳，已禁用）`);
  }
  const payload = m[2] ?? '';
  if (!payload) throw new SealValidationError('印章图内容为空');
  if (!BASE64_PAYLOAD_RE.test(payload)) {
    throw new SealValidationError('非法印章图：base64 内容含非法字符（可能混入引号 / 尖括号 / 空白 / 换行），请重新导出为纯 PNG/JPEG 后再上传');
  }
  if (dataUrl.length > MAX_IMAGE_LEN) throw new SealValidationError('印章图过大（上限约 2MB，请压缩后重传）');
}

export function createSealService(prisma: PrismaClient) {
  const db = prisma as any;

  async function listSeals(filter: {
    type?: string;
    ownerRoleId?: string;
    ownerUserId?: string;
    includeInactive?: boolean;
  } = {}) {
    const where: any = { deletedAt: null };
    if (filter.type) where.type = filter.type;
    if (filter.ownerRoleId) where.ownerRoleId = filter.ownerRoleId;
    if (filter.ownerUserId) where.ownerUserId = filter.ownerUserId;
    if (!filter.includeInactive) where.isActive = true;
    const items = await db.seal.findMany({
      where,
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
    });
    return { items, total: items.length };
  }

  async function getSeal(id: string) {
    const item = await db.seal.findFirst({ where: { id, deletedAt: null } });
    if (!item) throw new Error(`印章 ${id} 不存在`);
    return item;
  }

  /** 事务内保证全局仅一个默认章 */
  async function applyDefaultUniqueness(tx: any, excludeId: string | null) {
    await tx.seal.updateMany({
      where: { isDefault: true, deletedAt: null, ...(excludeId ? { id: { not: excludeId } } : {}) },
      data: { isDefault: false, updatedAt: now() },
    });
  }

  async function createSeal(input: SealInput, actorId: string) {
    const type = input.type ?? 'company_seal';
    validateSealType(type);
    if (!input.name?.trim()) throw new SealValidationError('印章名称必填');
    if (!input.imageDataUrl) throw new SealValidationError('印章图必填');
    validateImage(input.imageDataUrl);

    const ts = now();
    const item = await db.$transaction(async (tx: any) => {
      if (input.isDefault) await applyDefaultUniqueness(tx, null);
      const created = await tx.seal.create({
        data: {
          id: generateId('SEAL'),
          name: input.name.trim(),
          type,
          imageDataUrl: input.imageDataUrl,
          ownerRoleId: input.ownerRoleId ?? null,
          ownerUserId: input.ownerUserId ?? null,
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
          action: 'SEAL_CREATE',
          actorId,
          targetType: 'Seal',
          targetId: created.id,
          detail: { name: created.name, type, isDefault: created.isDefault },
        },
      });
      return created;
    });
    logger.info('[Seal] created', { id: item.id, actorId });
    return item;
  }

  async function updateSeal(id: string, patch: Partial<SealInput>, actorId: string) {
    const existing = await db.seal.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new Error(`印章 ${id} 不存在`);
    if (patch.type !== undefined) validateSealType(patch.type);
    if (patch.name !== undefined && !patch.name.trim()) throw new SealValidationError('印章名称不可为空');
    if (patch.imageDataUrl !== undefined) {
      if (!patch.imageDataUrl) throw new SealValidationError('印章图不可为空');
      validateImage(patch.imageDataUrl);
    }

    const item = await db.$transaction(async (tx: any) => {
      if (patch.isDefault === true) await applyDefaultUniqueness(tx, id);
      const updated = await tx.seal.update({
        where: { id },
        data: {
          ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
          ...(patch.type !== undefined ? { type: patch.type } : {}),
          ...(patch.imageDataUrl !== undefined ? { imageDataUrl: patch.imageDataUrl } : {}),
          ...(patch.ownerRoleId !== undefined ? { ownerRoleId: patch.ownerRoleId ?? null } : {}),
          ...(patch.ownerUserId !== undefined ? { ownerUserId: patch.ownerUserId ?? null } : {}),
          ...(patch.isDefault !== undefined ? { isDefault: patch.isDefault } : {}),
          ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
          ...(patch.notes !== undefined ? { notes: patch.notes?.trim() || null } : {}),
          updatedAt: now(),
        },
      });
      await tx.auditLog.create({
        data: {
          id: generateId('AUD'),
          action: 'SEAL_UPDATE',
          actorId,
          targetType: 'Seal',
          targetId: id,
          detail: { patch: Object.keys(patch) },
        },
      });
      return updated;
    });
    logger.info('[Seal] updated', { id, actorId });
    return item;
  }

  async function deleteSeal(id: string, actorId: string) {
    const existing = await db.seal.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new Error(`印章 ${id} 不存在`);
    await db.$transaction(async (tx: any) => {
      await tx.seal.update({ where: { id }, data: { deletedAt: now(), updatedAt: now() } });
      await tx.auditLog.create({
        data: {
          id: generateId('AUD'),
          action: 'SEAL_DELETE',
          actorId,
          targetType: 'Seal',
          targetId: id,
          detail: { name: existing.name },
        },
      });
    });
    logger.info('[Seal] deleted', { id, actorId });
  }

  /**
   * 按签字人解析应盖的章。优先级：指定用户 > 指定角色 > 默认兜底。
   * 返回 {id,name,imageDataUrl} 或 null（无可用章时不阻断业务渲染）。
   */
  async function resolveSealForSigner(ctx: { userId?: string | null; roleId?: string | null }): Promise<ResolvedSeal | null> {
    const where = (extra: any) => ({ deletedAt: null, isActive: true, ...extra });
    if (ctx.userId) {
      const byUser = await db.seal.findFirst({ where: where({ ownerUserId: ctx.userId }) });
      if (byUser) return { id: byUser.id, name: byUser.name, imageDataUrl: byUser.imageDataUrl };
    }
    if (ctx.roleId) {
      const byRole = await db.seal.findFirst({ where: where({ ownerRoleId: ctx.roleId }) });
      if (byRole) return { id: byRole.id, name: byRole.name, imageDataUrl: byRole.imageDataUrl };
    }
    const fallback = await db.seal.findFirst({ where: where({ isDefault: true }) });
    if (fallback) return { id: fallback.id, name: fallback.name, imageDataUrl: fallback.imageDataUrl };
    return null;
  }

  return {
    listSeals,
    getSeal,
    createSeal,
    updateSeal,
    deleteSeal,
    resolveSealForSigner,
  };
}

export { SYSTEM_ROLE_IDS };
