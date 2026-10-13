/**
 * 阶段 P0 回补 — 业务线注册与订单业务线标记服务（PRD 6.2）
 *
 * 职责：
 *   1. 业务线注册表（BusinessLine）：code 为 @unique 注册真源，
 *      Order.businessLine 为其 snapshot 引用（不强制外键，与全库一致）。
 *   2. 订单业务线标记 setOrderBusinessLine：仅允许指向存在且 isActive 的业务线。
 *   3. MOQ 软校验 checkOrderMoq：产出合规结论与违规明细，不阻断业务流程。
 *
 * 设计原则（与 seasons/risk 模块一致）：
 *   - 服务工厂模式 createBusinessLineService(prisma)
 *   - 软删除（deletedAt BigInt）；code 不可修改（snapshot 关联真源）
 *   - 当前数据库授权、父订单范围、同事务必要审计；使用已注册业务错误
 */

import { PrismaClient, Prisma, BusinessLine } from '@prisma/client';
import { logger } from '../lib/logger';
import crypto from 'crypto';
import type { TokenPayload } from '../auth/service';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { serializeValue } from '../lib/serializeValue';
import { businessError } from '../shared/errorCodes';
import { BUSINESS_LINE_READ_SCOPES, businessLineOrderAccess, currentBusinessLineActor } from './businessLineAccess';

// ────────────────────────────────────────────────────────────────
// 类型定义
// ────────────────────────────────────────────────────────────────

export interface BusinessLineInput {
  code: string; // 归一化为小写；fabric | garment | capsule 之外不限制，但须符合 CODE_RE
  name: string;
  description?: string | null;
  moqValue?: number | null;
  moqUnit?: string | null; // M | PC
  productionCycleDays?: number | null;
  paymentTermsHint?: string | null;
  isActive?: boolean;
  sortOrder?: number;
}

export type BusinessLinePatch = Partial<Omit<BusinessLineInput, 'code'>>;

export interface MoqViolation {
  rule: 'moq';
  expected: number;
  actual: number;
  unit: string | null;
}

export type MoqCheckResult =
  | { checked: false; reason: string }
  | {
      checked: true;
      businessLine: string;
      moqValue: number;
      moqUnit: string | null;
      quantity: number;
      compliant: boolean;
      violations: MoqViolation[];
    };

const CODE_RE = /^[a-z][a-z0-9_]*$/;

function generateId(prefix: string): string {
  return `${prefix}__${crypto.randomBytes(6).toString('base64url').toUpperCase()}`;
}

// ────────────────────────────────────────────────────────────────
// 服务工厂
// ────────────────────────────────────────────────────────────────

export function createBusinessLineService(prisma: PrismaClient) {
  const db = prisma as any;
  const now = () => Date.now();

  async function getBusinessLineOrThrow(tx: any, id: string): Promise<BusinessLine> {
    const rows = await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "BusinessLine" WHERE "id" = ${id} FOR UPDATE`);
    const bl = rows.length ? await tx.businessLine.findUnique({ where: { id } }) : null;
    if (!bl || bl.deletedAt !== null) throw businessError('NOT_FOUND', '业务线不存在');
    return bl;
  }

  async function write<T>(work: (tx: any) => Promise<T>): Promise<T> {
    try { return await db.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }); }
    catch (error: any) {
      if (error?.code === 'P2034' || (error?.code === 'P2010' && error?.meta?.code === '40001')) {
        throw businessError('CONFLICT', '业务线或订单正在变化，请刷新后核对。');
      }
      throw error;
    }
  }

  function audit(tx: any, actor: TokenPayload, operation: string, targetType: string, targetId: string,
    before: any, after: any) {
    return writeRouteAuditLog({ prisma: tx, actorId: actor.userId, source: 'business-lines', operation,
      targetType, targetId, before: before == null ? null : serializeValue(before),
      after: after == null ? null : serializeValue(after) });
  }

  async function createBusinessLine(input: BusinessLineInput, prior: TokenPayload) {
    if (typeof input?.code !== 'string' || !input.code.trim()) throw businessError('VALIDATION_FAILED', '业务线代码必填');
    const code = input.code.trim().toLowerCase();
    if (!CODE_RE.test(code)) {
      throw businessError('VALIDATION_FAILED', `非法业务线代码：${input.code}（须为小写字母开头的小写字母/数字/下划线）`);
    }
    if (typeof input.name !== 'string' || !input.name.trim()) throw businessError('VALIDATION_FAILED', '业务线名称必填');

    try { return await write(async tx => {
      const actor = await currentBusinessLineActor(tx, prior, 'dictionary:write');
      const dup = await tx.businessLine.findUnique({ where: { code } });
      if (dup) throw businessError('VALIDATION_FAILED', '业务线代码已存在');

      const ts = now();
      const bl = await tx.businessLine.create({
        data: {
          id: generateId('BL'),
          code,
          name: input.name.trim(),
          description: input.description ?? null,
          moqValue: input.moqValue ?? null,
          moqUnit: input.moqUnit ?? null,
          productionCycleDays: input.productionCycleDays ?? null,
          paymentTermsHint: input.paymentTermsHint ?? null,
          isActive: input.isActive ?? true,
          sortOrder: input.sortOrder ?? 0,
          createdAt: BigInt(ts),
          updatedAt: BigInt(ts),
          deletedAt: null,
        },
      });
      const auditId = await audit(tx, actor, 'create_business_line', 'BusinessLine', bl.id, null, bl);
      return { ...bl, auditId };
    }); } catch (error: any) {
      // The same unique-code rejection also covers concurrent registration.
      if (error?.code === 'P2002' && Array.isArray(error.meta?.target) && error.meta.target.includes('code')) {
        throw businessError('VALIDATION_FAILED', '业务线代码已存在');
      }
      throw error;
    }
  }

  async function listBusinessLines(query: { includeInactive?: boolean }, prior: TokenPayload) {
    return db.$transaction(async (tx: any) => {
      await currentBusinessLineActor(tx, prior, BUSINESS_LINE_READ_SCOPES);
      const where: any = { deletedAt: null };
      if (!query.includeInactive) where.isActive = true;
      const [items, total] = await Promise.all([
        tx.businessLine.findMany({ where, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] }),
        tx.businessLine.count({ where }),
      ]);
      return { items, total };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  const PATCH_FIELDS = [
    'name', 'description', 'moqValue', 'moqUnit',
    'productionCycleDays', 'paymentTermsHint', 'isActive', 'sortOrder',
  ] as const;

  async function updateBusinessLine(id: string, patch: BusinessLinePatch, prior: TokenPayload) {
    return write(async tx => {
      await currentBusinessLineActor(tx, prior, 'dictionary:write');
      const bl = await getBusinessLineOrThrow(tx, id);
      const actor = await currentBusinessLineActor(tx, prior, 'dictionary:write');
      // code 是 snapshot 关联真源（Order.businessLine 等值匹配），禁止修改
      if ((patch as any).code !== undefined) throw businessError('VALIDATION_FAILED', '业务线代码不可修改');
      if (patch.name !== undefined && (typeof patch.name !== 'string' || !patch.name.trim())) throw businessError('VALIDATION_FAILED', '业务线名称必填');

      const data: Record<string, unknown> = { updatedAt: BigInt(now()) };
      for (const f of PATCH_FIELDS) {
        if ((patch as any)[f] !== undefined) {
          data[f] = f === 'name' ? patch.name!.trim() : (patch as any)[f];
        }
      }
      const before = serializeValue({ ...bl });
      const updated = await tx.businessLine.update({ where: { id: bl.id }, data });
      const auditId = await audit(tx, actor, 'update_business_line', 'BusinessLine', bl.id, before, updated);
      return { ...updated, auditId };
    });
  }

  async function deleteBusinessLine(id: string, prior: TokenPayload) {
    return write(async tx => {
      await currentBusinessLineActor(tx, prior, 'dictionary:write');
      const bl = await getBusinessLineOrThrow(tx, id);
      const actor = await currentBusinessLineActor(tx, prior, 'dictionary:write');
      const refs = await tx.order.count({ where: { deletedAt: null, businessLine: bl.code } });
      if (refs > 0) throw businessError('VALIDATION_FAILED', '仍有订单引用此业务线，不可删除');
      const before = serializeValue({ ...bl });
      const deleted = await tx.businessLine.update({
        where: { id: bl.id },
        data: { deletedAt: BigInt(now()), updatedAt: BigInt(now()) },
      });
      return { auditId: await audit(tx, actor, 'delete_business_line', 'BusinessLine', bl.id, before, deleted) };
    });
  }

  /**
   * 订单业务线标记：code 为 null / 空串表示清除标记；
   * 非空时须指向存在且 isActive 的业务线（code 归一化小写）。
   */
  async function setOrderBusinessLine(orderId: string, code: string | null, prior: TokenPayload) {
    if (code !== null && typeof code !== 'string') throw businessError('VALIDATION_FAILED', 'businessLine 必须为业务线代码或 null');
    return write(async tx => {
      const { actor, order } = await businessLineOrderAccess(tx, orderId, prior, 'write');

      let normalized: string | null = null;
      if (code !== null && code !== undefined && String(code).trim() !== '') {
        normalized = String(code).trim().toLowerCase();
        const rows = await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "BusinessLine" WHERE "code" = ${normalized} FOR UPDATE`);
        const bl = rows.length ? await tx.businessLine.findUnique({ where: { code: normalized } }) : null;
        if (!bl || bl.deletedAt !== null) throw businessError('NOT_FOUND', '业务线不存在');
        if (!bl.isActive) throw businessError('VALIDATION_FAILED', '业务线已停用');
      }

      // Waiting for the registry lock may outlive an authorization change.
      // ReadCommitted reloads the real current subject/L2 before mutation.
      await businessLineOrderAccess(tx, orderId, prior, 'write');

      const before = { id: order.id, businessLine: order.businessLine, updatedAt: order.updatedAt };
      const updated = await tx.order.update({
        where: { id: orderId },
        data: { businessLine: normalized, updatedAt: BigInt(now()) },
      });
      // This command never returns the complete Order (including sensitive cost).
      const item = { id: updated.id, businessLine: updated.businessLine, updatedAt: updated.updatedAt };
      const auditId = await audit(tx, actor, 'set_order_business_line', 'Order', orderId, before, item);
      return { ...item, auditId };
    });
  }

  /**
   * MOQ 软校验（PRD 6.2）：不阻断，仅产出合规结论与违规明细。
   * 未标记业务线 / 业务线未配置 MOQ 时返回 checked: false 及原因。
   */
  async function checkOrderMoq(orderId: string, prior: TokenPayload): Promise<MoqCheckResult> {
    return db.$transaction(async (tx: any) => {
      const { order } = await businessLineOrderAccess(tx, orderId, prior, 'read');

      if (!order.businessLine) return { checked: false, reason: '未标记业务线' };
      const bl = await tx.businessLine.findUnique({ where: { code: order.businessLine } });
      if (!bl || bl.deletedAt !== null) return { checked: false, reason: '业务线不存在' };
      if (bl.moqValue === null || bl.moqValue === undefined) {
        return { checked: false, reason: '该业务线未配置 MOQ' };
      }

      const moqValue = Number(bl.moqValue);
      // Order.quantity is required in storage; an invalid source is not zero.
      if (order.quantity == null || !Number.isFinite(Number(order.quantity))) {
        return { checked: false, reason: '订单数量未确认' };
      }
      const quantity = Number(order.quantity);
      const compliant = quantity >= moqValue;
      return {
        checked: true,
        businessLine: bl.code,
        moqValue,
        moqUnit: bl.moqUnit ?? null,
        quantity,
        compliant,
        violations: compliant
          ? []
          : [{ rule: 'moq', expected: moqValue, actual: quantity, unit: bl.moqUnit ?? null }],
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  return {
    createBusinessLine,
    listBusinessLines,
    updateBusinessLine,
    deleteBusinessLine,
    setOrderBusinessLine,
    checkOrderMoq,
  };
}

export type BusinessLineService = ReturnType<typeof createBusinessLineService>;

// ────────────────────────────────────────────────────────────────
// 启动种子：三大默认业务线（PRD 6.2）
//   fabric  面料大货 — MOQ 800M / 70 天生产周期 / T/T 30 天
//   garment 成衣大货 — T/T 60 天
//   capsule 成衣 Capsule — 设计师小单业务（主业务组成部分，不拆分独立模块）
// 幂等口径与 seedStandardEmailTemplates 一致：按 code 查重，存在即跳过。
// ────────────────────────────────────────────────────────────────

const DEFAULT_BUSINESS_LINES: Array<{
  code: string;
  name: string;
  description: string;
  moqValue: number | null;
  moqUnit: string | null;
  productionCycleDays: number | null;
  paymentTermsHint: string | null;
  sortOrder: number;
}> = [
  {
    code: 'fabric',
    name: '面料大货',
    description: '面料大货订单业务线，按单生产',
    moqValue: 800,
    moqUnit: 'M',
    productionCycleDays: 70,
    paymentTermsHint: 'T/T 30 天',
    sortOrder: 10,
  },
  {
    code: 'garment',
    name: '成衣大货',
    description: '成衣大货订单业务线',
    moqValue: null,
    moqUnit: 'PC',
    productionCycleDays: null,
    paymentTermsHint: 'T/T 60 天',
    sortOrder: 20,
  },
  {
    code: 'capsule',
    name: '成衣 Capsule',
    description: '设计师小单 / Capsule 业务线（主业务组成部分）',
    moqValue: null,
    moqUnit: 'PC',
    productionCycleDays: null,
    paymentTermsHint: null,
    sortOrder: 30,
  },
];

export async function ensureBusinessLineSeed(
  prisma: PrismaClient,
  actorId?: string,
): Promise<{ created: number; skipped: number; total: number }> {
  const db = prisma as any;
  const now = Date.now();
  let created = 0;
  let skipped = 0;
  for (const line of DEFAULT_BUSINESS_LINES) {
    // code 为 @unique 注册真源：含软删记录在内存在即跳过，避免撞唯一约束
    const existing = await db.businessLine.findUnique({ where: { code: line.code } });
    if (existing) {
      skipped += 1;
      continue;
    }
    await db.businessLine.create({
      data: {
        id: generateId('BL'),
        code: line.code,
        name: line.name,
        description: line.description,
        moqValue: line.moqValue,
        moqUnit: line.moqUnit,
        productionCycleDays: line.productionCycleDays,
        paymentTermsHint: line.paymentTermsHint,
        isActive: true,
        sortOrder: line.sortOrder,
        createdAt: BigInt(now),
        updatedAt: BigInt(now),
        deletedAt: null,
      },
    });
    created += 1;
  }
  if (created > 0) {
    logger.info('[BusinessLineService] default business lines seeded', { created, skipped, actorId });
  }
  return { created, skipped, total: DEFAULT_BUSINESS_LINES.length };
}
