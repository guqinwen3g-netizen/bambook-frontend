import { businessNowDate } from '../shared/businessClock';
/**
 * claimCaseService.ts — 售后案件（ClaimCase）+ 处置明细（ClaimDisposition）服务
 *
 * 口径依据：`docs/业务口径决策单-2026-09-17.md` **A1 · A1-附 · A5 · A7**
 *
 * ★ A1-附 ①：**一次客诉 = 一个案件，案件下可同时有多条处置**
 *   （真实客诉常是"100 件里 30 件退货、70 件折让"，**不是一种客诉对应一种处理**）。
 *
 * ★ 范围（A1 → A-3 二期）：**四种处置全部支持** —— Allowance(折让) · ReturnRefund(退货退款)
 *   · Replace(换货补发) · Repair(返修)。一期（2026-09-17 上午）曾把后两种显式拒绝，A-3 已解除；
 *   —— 若将来再出现"暂不支持"的 kind，仍须**显式拒绝**而不是静默接受，否则用户会以为提交成功了。
 */

import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { nextBusinessNumber } from '../shared/businessNumberService';
import { localDateKey } from '../shared/localDate';
import { parsePositiveDecimal } from '../shared/moneyInput';
import { logger } from '../lib/logger';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { ClaimTransactionError, claimRefusal, lockClaimRows, readClaimApprovedFact } from './claimApprovalFact';
import type { TokenPayload } from '../auth/service';
import { claimPage, ClaimVisibilityError, createClaimVisibility, validateClaimSourceFacts } from './claimVisibility';

export type ClaimCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'INVALID_STATE' | 'UNSUPPORTED_KIND';
export interface ClaimError { code: ClaimCode; message: string }
export interface ClaimResult<T = unknown> { ok: boolean; data?: T; error?: ClaimError }

const fail = <T>(code: ClaimCode, message: string): ClaimResult<T> => ({ ok: false, error: { code, message } });
const ok = <T>(data: T): ClaimResult<T> => ({ ok: true, data });

/**
 * 四种处置方式（口径 A1）
 *
 * ★ A-3 二期已落地 ⇒ **四种全部支持**。
 *   一期（2026-09-17 上午）曾把 `Replace`/`Repair` 显式拒绝（`UNSUPPORTED_KIND`），
 *   因为要牵动车间；二期按行业标准补齐：
 *     · `Replace`（换货补发）→ 复用 `Shipment` 建**补发出运单**（不走钱）
 *     · `Repair`（返修）→ 建**独立返修工单**（复用 `WorkStation`，不套生产订单）
 */
export const DISPOSITION_KINDS = ['Allowance', 'ReturnRefund', 'Replace', 'Repair'] as const;
export type DispositionKind = (typeof DISPOSITION_KINDS)[number];

/** ★ 二期起：**四种全部支持**（保留常量供调用方表达"当前支持的集合"） */
export const SUPPORTED_KINDS: readonly DispositionKind[] = [...DISPOSITION_KINDS];
/** @deprecated 一期遗留名（= SUPPORTED_KINDS）；新代码用 `SUPPORTED_KINDS` */
export const PHASE1_KINDS = SUPPORTED_KINDS;

/** 动钱的两种 */
export const MONEY_KINDS: readonly DispositionKind[] = ['Allowance', 'ReturnRefund'];
/** 动货的三种 */
export const GOODS_KINDS: readonly DispositionKind[] = ['ReturnRefund', 'Replace', 'Repair'];

/** 退货去向（口径 A1-附 ③：**必记**，不记清 ⇒ 货在账上凭空消失） */
export const RETURN_DISPOSITIONS = ['Scrap', 'Replace', 'Repair'] as const;

export interface DispositionInput {
  kind: string;
  materialCode?: string | null;
  quantity?: number | string | null;
  unit?: string | null;
  amount?: number | string | null;
  currency?: string | null;
  returnDisposition?: string | null;
  notes?: string | null;
}

/**
 * ★ **处置输入的纯校验**（无 IO，可单测）。
 *
 * 按「动钱 / 动货」两维校验必填项 —— 这是 A1 那张表（四种处置 × 动不动钱货）的代码化：
 * | kind | 动钱 | 动货 | 必填 |
 * |---|---|---|---|
 * | Allowance | ✓ | | amount + currency |
 * | ReturnRefund | ✓ | ✓ | amount + currency + quantity + unit + returnDisposition |
 * | Replace / Repair | | ✓ | （二期）quantity + unit + returnDisposition |
 */
export function validateDispositionInput(input: DispositionInput): ClaimResult<{ kind: DispositionKind; amount?: string; quantity?: string }> {
  const kind = input?.kind as DispositionKind;
  if (!DISPOSITION_KINDS.includes(kind)) {
    return fail('VALIDATION_FAILED', `非法处置方式：${input?.kind}（合法值：${DISPOSITION_KINDS.join(' / ')}）`);
  }
  // ★ A-3 二期：四种全部支持 ⇒ 原先的「一期范围显式拒绝」已移除。
  //   若将来再出现"暂不支持"的 kind，请在此处加**显式拒绝**（而不是静默接受）。

  const needsMoney = MONEY_KINDS.includes(kind);
  const needsGoods = GOODS_KINDS.includes(kind);

  // ★ v3.14（§2 G3 判据 L-A 第一刀）：这里原先是 `new Prisma.Decimal(input.amount ?? 0)` 再 `lte(0)` ⇒
  //   "没填"和"填了 0"被合并成同一个值，拒绝与否**取决于后面那一句有没有写**；
  //   现在在入口一次读干净，解析结果往下传（写载荷不再自己造 0）。
  let amountValue: string | undefined;
  let quantityValue: string | undefined;
  if (needsMoney) {
    const amount = parsePositiveDecimal(input.amount, `${kind} 的金额`);
    // ★ 口径 A6：拒绝 0 元（0 元处置无意义）
    if (!amount.ok) return fail('VALIDATION_FAILED', amount.message);
    amountValue = amount.value;
    if (!input.currency) return fail('VALIDATION_FAILED', `${kind} 必须指定币种`);
  }
  if (needsGoods) {
    const qty = parsePositiveDecimal(input.quantity, `${kind} 的数量`);
    if (!qty.ok) return fail('VALIDATION_FAILED', qty.message);
    quantityValue = qty.value;
    if (!input.unit) return fail('VALIDATION_FAILED', `${kind} 必须指定单位`);
    // ★ 口径 A1-附 ③：去向必填
    if (!input.returnDisposition || !(RETURN_DISPOSITIONS as readonly string[]).includes(input.returnDisposition)) {
      return fail(
        'VALIDATION_FAILED',
        `${kind} 必须指定退货去向（合法值：${RETURN_DISPOSITIONS.join(' / ')}）—— 不记清去向，货会在账上凭空消失`,
      );
    }
  }
  return ok({ kind, amount: amountValue, quantity: quantityValue });
}

export interface CreateClaimCaseInput {
  customerRelationId?: string | null;
  customerName?: string | null;
  sourceOrderId?: string | null;
  sourceInvoiceId?: string | null;
  category?: string | null;
  problemDesc: string;
  attachments?: unknown;
  reportedAt?: string;
  notes?: string | null;
}

/** 登记一个售后案件（取号 CLM，与退款单共用号段 —— 业务上同属"客诉索赔"族） */
export async function createClaimCase(
  prisma: PrismaClient,
  input: CreateClaimCaseInput,
  actorId: string,
  opts: { actor?: TokenPayload } = {},
): Promise<ClaimResult<{ claimCase: any }>> {
  if (!input?.problemDesc?.trim()) return fail('VALIDATION_FAILED', 'problemDesc（问题描述）必填');
  if (opts.actor && opts.actor.userId !== actorId) throw new ClaimVisibilityError('FORBIDDEN', '登记主体与服务端身份不一致');

  try {
    const claimCase = await prisma.$transaction(async (tx: any) => {
      // Source identifiers are business facts, not trusted client snapshots.
      // A route supplies its server actor for a second fresh check inside the tx.
      const sources = opts.actor ? await createClaimVisibility(tx, opts.actor).assertCreateSources(input)
        : await validateClaimSourceFacts(tx, input);
      const caseNumber = await nextBusinessNumber(tx, 'CLM', undefined, {
        occupied: async (num) => {
          // ⚠️ 含软删行（唯一约束不排除软删行；过滤了会撞号 → P2002 → 整单失败）
          const dup = await tx.claimCase.findFirst({ where: { caseNumber: num }, select: { id: true } });
          return dup != null;
        },
      });
      return tx.claimCase.create({
        data: {
          id: `CLMCASE_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
          caseNumber,
          customerRelationId: sources.customerRelationId,
          customerName: sources.customerName,
          sourceOrderId: sources.sourceOrderId,
          sourceInvoiceId: sources.sourceInvoiceId,
          status: 'Registered',
          category: input.category ?? null,
          problemDesc: input.problemDesc.trim(),
          attachments: (input.attachments ?? null) as any,
          reportedAt: input.reportedAt ?? localDateKey(businessNowDate()),
          reportedBy: actorId,
          createdAt: BigInt(Date.now()),
          updatedAt: BigInt(Date.now()),
        },
      });
    });
    return ok({ claimCase });
  } catch (e: any) {
    if (e instanceof ClaimVisibilityError) throw e;
    logger.error('[ClaimCaseService] createClaimCase failed', { error: e?.message });
    return fail('VALIDATION_FAILED', e?.message ?? '案件登记失败');
  }
}

/** 给案件加一条处置（纯校验先过，再落库） */
export async function addDisposition(
  prisma: PrismaClient,
  caseId: string,
  input: DispositionInput,
  actorId: string,
  opts: { tx?: any } = {},
): Promise<ClaimResult<{ disposition: any }>> {
  const validated = validateDispositionInput(input);
  // ⚠️ 不用 `as ClaimResult<{disposition}>` 强转 —— 泛型不重叠，TS 会报错（也说明语义确实不同）
  if (!validated.ok) return { ok: false, error: validated.error };
  const kind = validated.data!.kind;
  // ★ 校验时读出来的十进制串往下传 ⇒ 下面落库不再出现 `?? 0`（L-A 的这条形状就此消失，而不是被藏起来）
  const amountValue = validated.data!.amount;
  const quantityValue = validated.data!.quantity;
  const runInTx = opts.tx ? (fn: (tx: any) => Promise<any>) => fn(opts.tx) : (fn: (tx: any) => Promise<any>) => prisma.$transaction(fn);
  return runInTx(async (tx: any) => {
  await tx.$queryRawUnsafe('SELECT id FROM "ClaimCase" WHERE id = $1 FOR UPDATE', caseId);
  const claimCase = await tx.claimCase.findUnique({ where: { id: caseId } });
  if (!claimCase || claimCase.deletedAt) return fail('NOT_FOUND', `售后案件 ${caseId} 不存在`);
  if (claimCase.status === 'Cancelled') return fail('INVALID_STATE', '案件已撤销，不可再加处置');
  if (claimCase.status === 'Closed') return fail('INVALID_STATE', '案件已关闭，不可再加处置');
  const needsMoney = MONEY_KINDS.includes(kind);
  const needsGoods = GOODS_KINDS.includes(kind);

  const disposition = await tx.claimDisposition.create({
    data: {
      id: `CLMDISP_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      claimCaseId: caseId,
      kind,
      materialCode: input.materialCode ?? null,
      quantity: needsGoods ? new Prisma.Decimal(quantityValue as string) : null,
      unit: needsGoods ? (input.unit ?? null) : null,
      amount: needsMoney ? new Prisma.Decimal(amountValue as string) : null,
      currency: needsMoney ? (input.currency ?? null) : null,
      returnDisposition: needsGoods ? (input.returnDisposition ?? null) : null,
      status: 'Draft',
      notes: input.notes ?? null,
      createdAt: BigInt(Date.now()),
      updatedAt: BigInt(Date.now()),
    },
  });

  // 案件进入「处理中」（从 Registered 起算；已 Processing 保持）
  if (claimCase.status === 'Registered') {
    await tx.claimCase.update({
      where: { id: caseId },
      data: { status: 'Processing', updatedAt: BigInt(Date.now()) },
    });
  }

  return ok({ disposition });
  });
}

/**
 * 审批处置（口径 A7：**任何金额都汇总领导批**）。
 *
 * ⚠️ 审批**主体**由 `approvals/` 内核按审批策略解析（口径 B1：`aftersales:approve` 只作 UI 能力标签）；
 *   本函数只负责「已获批准」这一状态推进，不自己判"谁能批"。
 */
export async function approveDisposition(
  prisma: PrismaClient,
  dispositionId: string,
  actorId: string,
): Promise<ClaimResult<{ disposition: any }>> {
  try {
    return await prisma.$transaction(async (tx: any) => {
      const { disposition: d, claimCase } = await lockClaimRows(tx, dispositionId);
      if (d.status !== 'Draft' && d.status !== 'Approved') claimRefusal(`处置状态为 ${d.status}，不可审批`);
      const fact = await readClaimApprovedFact(tx, d, claimCase);
      // Hook retries replay a committed decision, and never invent another approver.
      if (d.status === 'Approved') {
        if (d.approverId !== fact.decisionActorId || d.approvedAt !== localDateKey(fact.approval.decidedAt)) claimRefusal('处置批准投影与真实决定不一致，需补审');
        return ok({ disposition: d });
      }
      const advanced = await tx.claimDisposition.updateMany({
        where: { id: dispositionId, status: 'Draft', deletedAt: null },
        data: { status: 'Approved', approverId: fact.decisionActorId, approvedAt: localDateKey(fact.approval.decidedAt), updatedAt: BigInt(Date.now()) },
      });
      if (advanced.count !== 1) claimRefusal('处置已被其他请求推进，请刷新');
      const disposition = await tx.claimDisposition.findUnique({ where: { id: dispositionId } });
      await writeRouteAuditLog({ prisma: tx, source: 'claim', actorId, operation: 'advance-approved', targetType: 'ClaimDisposition', targetId: dispositionId,
        before: { status: 'Draft' }, after: { status: 'Approved', approvalRequestId: fact.approval.id, decisionActorId: fact.decisionActorId,
          decisionAuditId: fact.decisionAuditId, contentFingerprint: fact.contentFingerprint }, operationType: 'transition', fieldPath: 'status' });
      return ok({ disposition });
    });
  } catch (error) {
    if (error instanceof ClaimTransactionError) return { ok: false, error: error.claimError };
    throw error;
  }
}

/**
 * 撤销案件（口径 A5：**能撤销** + 留痕）。
 *
 * ★ 撤销 = 案件置 `Cancelled` + **未执行的处置一并作废** + 留痕。
 *   ⚠️ **已执行（Executed）的处置不能随案件撤销** —— 它已产生退款单/退货入库单，
 *      已执行事实与原产出必须保留，后续处理沿原处置办理。
 */
export async function cancelClaimCase(
  prisma: PrismaClient,
  caseId: string,
  reason: string,
  actorId: string,
): Promise<ClaimResult<{ claimCase: any; cancelledDispositions: number }>> {
  if (!reason?.trim()) return fail('VALIDATION_FAILED', '撤销必须填写理由');
  return prisma.$transaction(async (tx: any): Promise<ClaimResult<{ claimCase: any; cancelledDispositions: number }>> => {
  // Same first lock as execution/approval, so cancellation cannot race their outputs.
  await tx.$queryRawUnsafe('SELECT id FROM "ClaimCase" WHERE id = $1 FOR UPDATE', caseId);
  const claimCase = await tx.claimCase.findUnique({ where: { id: caseId } });
  if (!claimCase || claimCase.deletedAt) return fail('NOT_FOUND', `售后案件 ${caseId} 不存在`);
  if (claimCase.status === 'Cancelled') return fail('INVALID_STATE', '案件已撤销');

  const dispositions = await tx.claimDisposition.findMany({ where: { claimCaseId: caseId, deletedAt: null } });
  const executed = dispositions.filter((d: any) => d.status === 'Executed');
  if (executed.length > 0) {
    return fail(
      'INVALID_STATE',
      `案件已有 ${executed.length} 条已执行处置，不能撤销。已产生的退款、退货与库存记录须保留，后续处理请从原处置继续。`,
    );
  }

  const now = BigInt(Date.now());
  const today = localDateKey(businessNowDate());
  const pending = dispositions.filter((d: any) => d.status !== 'Cancelled');
  for (const d of pending) {
    await tx.claimDisposition.update({
      where: { id: d.id },
      data: { status: 'Cancelled', cancelledAt: today, cancelledBy: actorId, cancelReason: reason.trim(), updatedAt: now },
    });
  }
  const updated = await tx.claimCase.update({
    where: { id: caseId },
    data: { status: 'Cancelled', closedAt: today, notes: `${claimCase.notes ?? ''}\n[撤销] ${reason.trim()}`.trim(), updatedAt: now },
  });

  return ok({ claimCase: updated, cancelledDispositions: pending.length });
  });
}

/** 案件详情（含处置明细） */
export async function getClaimCase(prisma: PrismaClient, id: string): Promise<ClaimResult<{ claimCase: any }>> {
  const claimCase = await prisma.claimCase.findUnique({ where: { id } });
  if (!claimCase || claimCase.deletedAt) return fail('NOT_FOUND', `售后案件 ${id} 不存在`);
  const dispositions = await prisma.claimDisposition.findMany({
    where: { claimCaseId: id, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });
  return ok({ claimCase: { ...claimCase, dispositions } });
}

/** 案件列表 */
export async function listClaimCases(
  prisma: PrismaClient,
  filter: { status?: string; customerRelationId?: string; limit?: number; offset?: number; scopeWhere?: Record<string, unknown> } = {},
): Promise<ClaimResult<{ items: any[]; total: number; limit: number; offset: number }>> {
  const page = claimPage(filter);
  const where: any = { deletedAt: null };
  if (filter.status) where.status = filter.status;
  if (filter.customerRelationId) where.customerRelationId = filter.customerRelationId;
  // 数据范围（与 B3 同思路：由 route 层解析后传入，**AND** 语义）
  if (filter.scopeWhere && Object.keys(filter.scopeWhere).length > 0) where.AND = [filter.scopeWhere];

  const [items, total] = await Promise.all([
    prisma.claimCase.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: page.limit, skip: page.offset }),
    prisma.claimCase.count({ where }),
  ]);
  return ok({ items, total, ...page });
}
