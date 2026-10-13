/**
 * financeServiceV2.ts — Phase 1-03 财务/成本域统一服务
 *
 * 接入 Phase 0 平台域 4 大能力，覆盖 3 类财务单据：
 *   1. Quotation（报价单）— Sequence quotation → QT-2026-0001
 *   2. Invoice（发票）— Sequence invoice → INV-2026-0001（应收/应付）
 *   3. PaymentVoucher（收付款凭证）— Sequence payment → PAY-2026-0001
 *
 * 每类单据统一提供：
 *   · list   — 列表（行级权限 scope + 筛选 + 分页）
 *   · get    — 详情（scope 校验）
 *   · create — 创建（编号 + 字典 + 配置默认值 + ownerId 自动填充）
 *   · update — 更新（scope + 字典校验）
 *   · delete — 软删除（scope 校验）
 *
 * 另提供财务看板聚合：
 *   · getArApSummary — 应收/应付/已收/已付汇总
 */
import type { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { createPermissionService } from '../auth/permissionService';
import { createSequenceService } from '../sequence/sequenceService';
import { getDataDictionaryService } from '../dictionaries/dataDictionaryService';
import { getSystemConfigService } from '../config/systemConfigService';
import { logger } from '../lib/logger';
import { createInvoice, updateInvoice, type InvoiceMutationErrorCode } from './invoiceMutationService';
import { createPaymentVoucher, updatePaymentVoucher } from './paymentVoucherMutationService';
import { deleteInvoice, deleteVoucher } from './voidDeleteService';
import { visibleFinanceObjectWhere, requireFinanceObjectAccess } from './financeSourceAccess';
import { readFinanceBalanceProjection } from './financeBalanceProjection';
import { safeRouteError } from '../shared/routeError';

import { buildScopeWhereFromResolver } from '../auth/dataScopeWhere';
// ────────────────────────────────────────────────────────────────────
// 通用类型
// ────────────────────────────────────────────────────────────────────
export type FinanceDocType = 'quotation' | 'invoice' | 'payment';

export interface FinanceListFilter {
  status?: string;
  type?: string;            // Invoice: Receivable/Payable; Payment: Receipt/Disbursement
  ownerId?: string;
  departmentId?: string;
  customerRelationId?: string;
  orderId?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  offset?: number;
  sort?: string;
}

export interface FinanceListResult {
  items: any[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export type ArApSummary = Awaited<ReturnType<typeof readFinanceBalanceProjection>>;

export type FinanceV2Error =
  | 'UNAUTHORIZED' | 'FORBIDDEN' | 'VALIDATION_FAILED'
  | 'NOT_FOUND' | 'SEQUENCE_FAILED' | 'INTERNAL_ERROR' | InvoiceMutationErrorCode;

export interface FinanceV2Result<T = any> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
}

const SEQ_TYPE_MAP: Record<FinanceDocType, 'quotation' | 'invoice' | 'voucher'> = {
  quotation: 'quotation',
  invoice: 'invoice',
  payment: 'voucher',
};

const PRISMA_MODEL_MAP: Record<FinanceDocType, string> = {
  quotation: 'quotation',
  invoice: 'invoice',
  payment: 'paymentVoucher',
};

const NUMBER_FIELD_MAP: Record<FinanceDocType, string> = {
  quotation: 'quotationNumber',
  invoice: 'invoiceNumber',
  payment: 'voucherNumber',
};

// ────────────────────────────────────────────────────────────────────
// 服务工厂
// ────────────────────────────────────────────────────────────────────
export function createFinanceServiceV2(prisma: PrismaClient) {
  const permSvc = createPermissionService({ prisma });
  const seqSvc = createSequenceService(prisma);
  const dictSvc = getDataDictionaryService(prisma);
  const configSvc = getSystemConfigService(prisma);

  // ── 行级权限 where ──
  async function buildScopeWhere(actor: TokenPayload | null | undefined): Promise<Record<string, unknown>> {
    if (!actor) return { ownerId: '__NOBODY__' };
    const resolver = await permSvc.getDataScopeResolver(actor, 'finance');
    if (resolver.rule.kind === 'all') return {};
    // §10.4.1：team 档同样按「解析后的用户集」拼装，不再按 rule.kind 硬分支
    return buildScopeWhereFromResolver(resolver, actor.userId);
  }

  // ── 字典校验 ──
  async function validateDictField(dictCode: string, value: string | undefined): Promise<string | null> {
    if (!value) return null;
    const entries = await dictSvc.getEntries(dictCode, { enabledOnly: false });
    if (entries.length === 0) return null;
    const found = entries.find((e) => e.key === value);
    if (!found) return `值 "${value}" 不在字典 ${dictCode} 的合法枚举中`;
    if (found.disabled) return `值 "${value}" 已被禁用`;
    return null;
  }

  // ── 编号生成 ──
  async function generateNumber(docType: FinanceDocType): Promise<string | null> {
    try {
      const seqType = SEQ_TYPE_MAP[docType];
      return await seqSvc.nextNumber(prisma as any, seqType);
    } catch (e: any) {
      logger.error('[FinanceV2] 编号生成失败', { docType, error: e?.message });
      return null;
    }
  }

  // ── BigInt 序列化 ──
  function serialize(row: any): any {
    const out: any = { ...row };
    for (const k of Object.keys(out)) {
      if (typeof out[k] === 'bigint') out[k] = Number(out[k]);
    }
    // Decimal fields
    for (const k of ['amount', 'totalAmount', 'unitPrice', 'exchangeRate', 'bankFee', 'appliedAmount',
      'trackAMedianUsd', 'trackBFinalUsd', 'salesPrice', 'contractAmount', 'quoteAmount']) {
      if (out[k] && typeof out[k] === 'object' && out[k].toString) {
        out[k] = Number(out[k].toString());
      }
    }
    if (out.priceDeviationPercent != null) out.priceDeviationPercent = Number(out.priceDeviationPercent);
    return out;
  }

  function getModel(docType: FinanceDocType): any {
    return (prisma as any)[PRISMA_MODEL_MAP[docType]];
  }

  // ══════════════════════════════════════════════════════════════════
  // 通用 list / get / create / update / delete（按 docType 分派）
  // ══════════════════════════════════════════════════════════════════
  async function list(
    docType: FinanceDocType,
    actor: TokenPayload | null | undefined,
    filter: FinanceListFilter = {},
  ): Promise<FinanceV2Result<FinanceListResult>> {
    try {
      const filterWhere: Record<string, unknown> = { deletedAt: null };
      let where = filterWhere;
      if (filter.status) where.status = filter.status;
      if (filter.type) where.type = filter.type;
      if (filter.ownerId) where.ownerId = filter.ownerId;
      if (filter.departmentId) where.departmentId = filter.departmentId;
      if (filter.customerRelationId) where.customerRelationId = filter.customerRelationId;
      if (filter.orderId) where.orderId = filter.orderId;
      if (filter.search) {
        const s = filter.search.trim();
        if (s) {
          const numField = NUMBER_FIELD_MAP[docType];
          (where as any).OR = [
            { [numField]: { contains: s, mode: 'insensitive' } },
            { customerName: { contains: s, mode: 'insensitive' } },
          ];
        }
      }
      const visible = await visibleFinanceObjectWhere(prisma, actor, docType === 'payment' ? 'voucher' : docType, filterWhere);
      where = visible.where;

      const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
      const offset = Math.max(filter.offset ?? 0, 0);
      const model = getModel(docType);
      const [items, total] = await Promise.all([
        model.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: offset }),
        model.count({ where }),
      ]);
      await visible.access.finish();
      return { ok: true, data: { items: items.map(serialize), total, limit, offset, hasMore: offset + items.length < total } };
    } catch (e: any) {
      logger.error('[FinanceV2] list failed', { docType, error: e?.message });
      const safe = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR' }); return { ok: false, error: { code: safe.code, message: safe.message } };
    }
  }

  async function get(
    docType: FinanceDocType,
    actor: TokenPayload | null | undefined,
    id: string,
  ): Promise<FinanceV2Result<any>> {
    try {
      const { row } = await requireFinanceObjectAccess(prisma, actor, docType === 'payment' ? 'voucher' : docType, id,
        [docType === 'payment' ? 'vouchers:read' : docType === 'quotation' ? 'quotations:read' : 'invoices:read']);
      return { ok: true, data: serialize(row) };
    } catch (e: any) {
      const safe = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR' }); return { ok: false, error: { code: safe.code, message: safe.message } };
    }
  }

  async function create(
    docType: FinanceDocType,
    actor: TokenPayload | null | undefined,
    input: Record<string, unknown>,
    context: { ip?: string | null } = {},
  ): Promise<FinanceV2Result<any>> {
    try {
      if (!actor) return { ok: false, error: { code: 'UNAUTHORIZED', message: '创建单据需登录' } };
      if (docType === 'payment') {
        const result = await createPaymentVoucher({ prisma, actor, actorId: actor.userId, input: { ...input }, ip: context.ip });
        return result.ok ? { ok: true, data: serialize({...result.data.voucher,financeCommand:result.data.financeCommand}) } : { ok: false, error: result.error };
      }

      if (docType === 'invoice') {
        if (!actor.userId) return { ok: false, error: { code: 'UNAUTHORIZED', message: '创建发票需有效登录主体' } };
        // Invoice numbering, source checks, status rules and mandatory audit
        // belong to the original transaction. Never consume a V2 sequence first.
        const canonicalInput = { ...input };
        if (!canonicalInput.currency) canonicalInput.currency = await configSvc.getString('finance.defaultTradeCurrency', 'USD');
        const result = await createInvoice({ prisma, input: canonicalInput, actor, actorId: actor.userId, ip: context.ip ?? null });
        if (!result.ok) return { ok: false, error: result.error };
        return { ok: true, data: serialize(result.data!.invoice) };
      }

      // 编号生成
      const numField = NUMBER_FIELD_MAP[docType];
      let number = (input as any)[numField] || null;
      if (!number) number = await generateNumber(docType);

      // ownerId / departmentId 自动填充
      const ownerId = (input as any).ownerId || actor.userId;
      const departmentId = (input as any).departmentId || actor.departmentIds?.[0] || null;

      // 默认币种
      if (!(input as any).currency) {
        (input as any).currency = await configSvc.getString('finance.defaultTradeCurrency', 'USD');
      }

      const now = BigInt(Date.now());
      const payload: Record<string, unknown> = {
        ...input,
        [numField]: number,
        ownerId,
        departmentId,
        createdAt: now,
        updatedAt: now,
      };

      // 确保有 id
      if (!payload.id) {
        const prefix = docType === 'quotation' ? 'QT' : 'PAY';
        payload.id = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      }

      const row = await getModel(docType).create({ data: payload });
      logger.info('[FinanceV2] created', { docType, id: row.id, number });
      return { ok: true, data: serialize(row) };
    } catch (e: any) {
      logger.error('[FinanceV2] create failed', { docType, error: e?.message });
      const failure = safeRouteError(e, {fallbackCode: 'INTERNAL_ERROR'}); return {ok:false,error:{code:failure.code,message:failure.message}};
    }
  }

  async function update(
    docType: FinanceDocType,
    actor: TokenPayload | null | undefined,
    id: string,
    input: Record<string, unknown>,
    context: { ip?: string | null } = {},
  ): Promise<FinanceV2Result<any>> {
    try {
      if (!actor) return { ok: false, error: { code: 'UNAUTHORIZED', message: '更新单据需登录' } };
      if (docType === 'payment') {
        const result = await updatePaymentVoucher({ prisma, actor, actorId: actor.userId, voucherId: id, input: { ...input }, ip: context.ip });
        return result.ok ? { ok: true, data: serialize({...result.data.voucher,financeCommand:result.data.financeCommand}) } : { ok: false, error: result.error };
      }
      if (docType === 'invoice' && !actor.userId) return { ok: false, error: { code: 'UNAUTHORIZED', message: '更新发票需有效登录主体' } };
      if (docType === 'invoice') {
        await requireFinanceObjectAccess(prisma, actor, 'invoice', id, ['invoices:write']);
        const result = await updateInvoice({ prisma, invoiceId: id, input: { ...input }, actor, actorId: actor.userId, ip: context.ip ?? null });
        return result.ok ? {ok:true,data:serialize(result.data!.invoice)} : {ok:false,error:result.error};
      }
      const scopeWhere = await buildScopeWhere(actor);
      const model = getModel(docType);
      const existing = await model.findFirst({ where: { id, deletedAt: null, ...scopeWhere } });
      if (!existing) return { ok: false, error: { code: 'NOT_FOUND', message: '单据不存在或无权限操作' } };

      // 不允许修改编号
      const numField = NUMBER_FIELD_MAP[docType];
      delete (input as any)[numField];
      delete (input as any).id;
      (input as any).updatedAt = BigInt(Date.now());

      const updated = await model.update({ where: { id }, data: input });
      logger.info('[FinanceV2] updated', { docType, id, fields: Object.keys(input) });
      return { ok: true, data: serialize(updated) };
    } catch (e: any) {
      logger.error('[FinanceV2] update failed', { docType, id, error: e?.message });
      const failure = safeRouteError(e, {fallbackCode: 'INTERNAL_ERROR'}); return {ok:false,error:{code:failure.code,message:failure.message}};
    }
  }

  async function softDelete(
    docType: FinanceDocType,
    actor: TokenPayload | null | undefined,
    id: string,
    command: { requestKey?: string; expectedUpdatedAt?: string } = {},
  ): Promise<FinanceV2Result<any>> {
    try {
      if (!actor) return { ok: false, error: { code: 'UNAUTHORIZED', message: '删除单据需登录' } };
      if (docType === 'invoice') return deleteInvoice({ prisma, invoiceId: id, actorId: actor.userId, actor, ...command });
      if (docType === 'payment') return deleteVoucher({ prisma, voucherId: id, actorId: actor.userId, actor, ...command });
      const scopeWhere = await buildScopeWhere(actor);
      const model = getModel(docType);
      const existing = await model.findFirst({ where: { id, deletedAt: null, ...scopeWhere }, select: { id: true } });
      if (!existing) return { ok: false, error: { code: 'NOT_FOUND', message: '单据不存在或无权限操作' } };

      const del = await model.update({ where: { id }, data: { deletedAt: BigInt(Date.now()) } });
      logger.info('[FinanceV2] soft-deleted', { docType, id });
      return { ok: true, data: serialize(del) };
    } catch (e: any) {
      const failure = safeRouteError(e, {fallbackCode: 'INTERNAL_ERROR'}); return {ok:false,error:{code:failure.code,message:failure.message}};
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // AR/AP 看板聚合
  // ══════════════════════════════════════════════════════════════════
  async function getArApSummary(actor: TokenPayload | null | undefined): Promise<FinanceV2Result<ArApSummary>> {
    try {
      const data = await prisma.$transaction(async (tx: any) => readFinanceBalanceProjection(tx, actor), { isolationLevel: 'RepeatableRead' });
      return { ok: true, data };
    } catch (error) {
      const safe = safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR' });
      return { ok: false, error: { code: safe.code, message: safe.message } };
    }
  }

  return {
    list,
    get,
    create,
    update,
    softDelete,
    getArApSummary,
    buildScopeWhere,
  };
}

// ────────────────────────────────────────────────────────────────────
// 单例
// ────────────────────────────────────────────────────────────────────
let _defaultService: ReturnType<typeof createFinanceServiceV2> | null = null;
export function getFinanceServiceV2(prisma: PrismaClient): ReturnType<typeof createFinanceServiceV2> {
  if (!_defaultService) _defaultService = createFinanceServiceV2(prisma);
  return _defaultService;
}
