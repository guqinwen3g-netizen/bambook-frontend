import { businessNowDate } from '../shared/businessClock';
/**
 * writeOffService.ts — ★ C7 尾差销账（2026-09-18）
 *
 * ── 为什么需要它（零基础障碍清单 C7）──
 * A3 已经修好「贷项票（CN）抵扣发票」的**内核**（`applyCreditNote` 同事务落
 * `CreditNoteAllocation` + 重算发票状态 ⇒ 发票可到 `Paid` 退出未结清应收）。
 * 但 CN 的**唯一创建入口是索赔处置**（`ClaimCase → ClaimDisposition(折让) → approve → execute`）——
 * 对一笔 **$3.25 的尾差**（客户抹零、汇款手续费差额、汇率尾差）要业务员走 5 步开一张「客户索赔单」，
 * 语义还是错的（客户没索赔，只是不付那几块钱）。
 * ⇒ 实测结果就是：尾差永远挂着 → 发票永远 `PartiallyPaid` → 账龄表天天报警（A3 修内核没解决入口）。
 *
 * 本服务 = **一个动作**：对某张应收票的剩余额开一张 CN 并立即抵扣，全程留痕。
 *
 * ── 三条硬约束 ──
 *  ① **原子**：开 CN 与抵扣在**同一事务**（半途失败不能留一张孤儿 CN）。
 *     为此给 `createCreditNote` / `applyCreditNote` 加了可选外部事务参数（默认行为不变）。
 *  ② **不重复实现状态机**：CN 状态推进、发票侧落明细、授信/订单结案全部复用 A3 的真源，
 *     本服务只做「校验 + 串起来 + 留痕」。
 *  ③ **有上限**：尾差销账是**便利动作**，不能变成「一键销掉整张发票」的后门。
 *     上限 = min(发票金额 × 比例, 等值本位币上限)，见 `checkTailThreshold`（**纯函数**，可单测）。
 *     ⚠️ 两个默认值（5% / 500 CNY）是**我按行业惯例取的默认**，可用环境变量覆盖；
 *        这是**待业务确认的口径**，已在交接文档登记 —— 不静默：拒绝消息里会把两个上限都写出来。
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { localDateKey } from '../shared/localDate';
import { sumAppliedAmount } from './allocationService';
import { createCreditNote, applyCreditNote } from '../claims/creditNoteService';
import { convertViaCny, pickRateOn, type FxRateRow } from './crossCurrency';

// ────────────────────────────────────────────────────────────────
// 上限口径（纯函数，可单测）
// ────────────────────────────────────────────────────────────────

/** 尾差上限①：不超过发票金额的这个比例 */
export const TAIL_MAX_RATIO = (() => {
  const v = Number(process.env.WRITE_OFF_TAIL_MAX_RATIO ?? 0.05);
  return Number.isFinite(v) && v > 0 ? v : 0.05;
})();

/** 尾差上限②：折算成本位币（CNY）后不超过这个数 */
export const TAIL_MAX_BASE_CNY = (() => {
  const v = Number(process.env.WRITE_OFF_TAIL_MAX_BASE_CNY ?? 500);
  return Number.isFinite(v) && v > 0 ? v : 500;
})();

export interface TailThresholdInput {
  /** 本次销账金额（发票币种） */
  writeOffAmount: number;
  /** 发票金额（发票币种） */
  invoiceAmount: number;
  /** 发票币种 → CNY 的汇率（1 外币 = ? CNY）；CNY 传 1；未知传 null */
  rateToCny: number | null;
}

export interface TailThresholdResult {
  ok: boolean;
  /** 允许的最大销账额（发票币种）—— 汇率缺失时按比例口径给值 */
  maxAllowed: number;
  ratioLimit: number;
  baseLimitInInvoiceCurrency: number | null;
  message: string | null;
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * 尾差上限判定。**两个上限都满足**才放行（AND，取更严的那个）。
 * 汇率缺失 → 只用比例口径（不因缺汇率把正常尾差卡死），但消息里说明。
 */
export function checkTailThreshold(input: TailThresholdInput): TailThresholdResult {
  const ratioLimit = round4(input.invoiceAmount * TAIL_MAX_RATIO);
  const baseLimitInInvoiceCurrency = input.rateToCny != null && input.rateToCny > 0
    ? round4(TAIL_MAX_BASE_CNY / input.rateToCny)
    : null;
  const maxAllowed = baseLimitInInvoiceCurrency != null
    ? Math.min(ratioLimit, baseLimitInInvoiceCurrency)
    : ratioLimit;

  if (input.writeOffAmount <= maxAllowed + 1e-9) {
    return { ok: true, maxAllowed, ratioLimit, baseLimitInInvoiceCurrency, message: null };
  }
  return {
    ok: false,
    maxAllowed,
    ratioLimit,
    baseLimitInInvoiceCurrency,
    message:
      `销账金额 ${input.writeOffAmount} 超过尾差上限 ${maxAllowed}` +
      `（发票金额 ${input.invoiceAmount} × ${TAIL_MAX_RATIO * 100}% = ${ratioLimit}` +
      (baseLimitInInvoiceCurrency != null
        ? `；等值上限 ${TAIL_MAX_BASE_CNY} CNY ÷ 汇率 ${input.rateToCny} = ${baseLimitInInvoiceCurrency}`
        : '；本位币汇率缺失，未启用等值上限') +
      `）。超出部分请走「客户索赔」或审批流程，不要用尾差销账处理。`,
  };
}

// ────────────────────────────────────────────────────────────────
// 主流程
// ────────────────────────────────────────────────────────────────

export type WriteOffErrorCode =
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'NO_OPEN_AMOUNT'
  | 'OVER_APPLIED'
  | 'TAIL_LIMIT_EXCEEDED'
  | 'CURRENCY_MISMATCH'
  | 'WRITE_OFF_FAILED';

export interface WriteOffResult<T = unknown> { ok: boolean; data?: T; error?: { code: WriteOffErrorCode; message: string } }

const fail = <T>(code: WriteOffErrorCode, message: string): WriteOffResult<T> => ({ ok: false, error: { code, message } });

/** 事由下限（与 DR-010 的「原因必须写清」同取向；尾差销账是**要留痕**的动作） */
export const WRITE_OFF_REASON_MIN = 10;

export interface WriteOffTailInput {
  invoiceId: string;
  /** 销账金额；缺省 = 该发票当前**剩余未结额**（整笔尾差） */
  amount?: number | string | null;
  /** 事由（必填，≥ WRITE_OFF_REASON_MIN 字） */
  reason: string;
  issueDate?: string;
}

/**
 * 对某张应收票的剩余额做尾差销账：开一张 CN（`claimCaseId=null` 的纯折让）并立即抵扣。
 *
 * 幂等性：**不幂等**（每调用一次就开一张 CN）—— 这是有意的：尾差销账是人工判断动作，
 * 静默幂等会掩盖重复提交。防重靠「剩余额」：销平后 `NO_OPEN_AMOUNT` 直接拒绝。
 */
export async function writeOffInvoiceTail(
  prisma: PrismaClient,
  input: WriteOffTailInput,
  actorId: string,
): Promise<WriteOffResult<{ creditNote: any; appliedAmount: number; invoiceStatusAfter: string | null }>> {
  const reason = (input?.reason ?? '').trim();
  if (!input?.invoiceId) return fail('VALIDATION_FAILED', 'invoiceId 必填');
  if (reason.length < WRITE_OFF_REASON_MIN) {
    return fail('VALIDATION_FAILED', `事由至少 ${WRITE_OFF_REASON_MIN} 字（尾差销账必须留痕，便于事后复核）`);
  }

  try {
    const data = await prisma.$transaction(async (tx: any) => {
      const invoice = await tx.invoice.findUnique({
        where: { id: input.invoiceId },
        select: {
          id: true, invoiceNumber: true, type: true, status: true, deletedAt: true,
          currency: true, amount: true, customerRelationId: true, customerName: true, issueDate: true,
        },
      });
      if (!invoice || invoice.deletedAt) throw Object.assign(new Error(`发票 ${input.invoiceId} 不存在`), { code: 'NOT_FOUND' });
      if (invoice.type !== 'Receivable') {
        throw Object.assign(new Error(`尾差销账只针对应收票（当前 type=${invoice.type}）`), { code: 'VALIDATION_FAILED' });
      }
      if (invoice.status === 'Draft' || invoice.status === 'Cancelled') {
        throw Object.assign(new Error(`发票状态为 ${invoice.status}，不可销账`), { code: 'INVALID_STATE' });
      }

      // 剩余未结额 = 票面 − Σ收款核销 − Σ折让核销（A3 真源，不另算一份）
      const invoiceAmount = new Prisma.Decimal(invoice.amount);
      const applied = await sumAppliedAmount(tx, invoice.id);
      const open = invoiceAmount.minus(applied);
      if (open.lte(0)) {
        throw Object.assign(new Error(`发票 ${invoice.invoiceNumber} 已无未结额（票面 ${invoiceAmount} − 已核销 ${applied}）`), { code: 'NO_OPEN_AMOUNT' });
      }

      const writeOffAmount = input.amount == null || input.amount === ''
        ? open
        : new Prisma.Decimal(input.amount);
      if (writeOffAmount.lte(0)) {
        throw Object.assign(new Error('销账金额须为正数'), { code: 'VALIDATION_FAILED' });
      }
      if (writeOffAmount.gt(open)) {
        throw Object.assign(
          new Error(`销账金额 ${writeOffAmount} 超过发票未结额 ${open}（销账只能抹平，不能多销）`),
          { code: 'OVER_APPLIED' },
        );
      }

      // 上限判定（比例 + 等值本位币；汇率缺失只用比例口径）
      const rateRows: FxRateRow[] = await tx.exchangeRate
        .findMany({ select: { currency: true, rate: true, effectiveDate: true } })
        .catch(() => [] as FxRateRow[]);
      const rateToCny = invoice.currency === 'CNY'
        ? 1
        : pickRateOn(rateRows, invoice.currency, localDateKey(businessNowDate()));
      const threshold = checkTailThreshold({
        writeOffAmount: Number(writeOffAmount),
        invoiceAmount: Number(invoiceAmount),
        rateToCny,
      });
      if (!threshold.ok) {
        throw Object.assign(new Error(threshold.message!), { code: 'TAIL_LIMIT_EXCEEDED' });
      }

      // ① 开 CN（claimCaseId=null = 非客诉的纯折让，schema 明确支持）
      const cnRes = await createCreditNote(prisma, {
        amount: writeOffAmount.toString(),
        currency: invoice.currency,
        customerRelationId: invoice.customerRelationId,
        customerName: invoice.customerName,
        claimCaseId: null,
        sourceInvoiceId: invoice.id,
        issueDate: input.issueDate ?? localDateKey(businessNowDate()),
        reason: `尾差销账：${reason}`,
        notes: `尾差销账（C7）：对发票 ${invoice.invoiceNumber} 未结额 ${open} 抹平 ${writeOffAmount}`,
      }, actorId, { tx });
      if (!cnRes.ok) {
        // ⚠️ 事务回调里**必须 throw**（正常返回 = 提交，半成品会落库）
        throw Object.assign(new Error(`开贷项票失败：${cnRes.error?.message}`), { code: 'WRITE_OFF_FAILED' });
      }
      const creditNote = cnRes.data!.creditNote;

      // ② 立即抵扣该发票（复用 A3 内核：落 CreditNoteAllocation + 重算发票状态 + 授信/结案闭环）
      const applyRes = await applyCreditNote(prisma, creditNote.id, {
        appliedAmount: writeOffAmount.toString(),
        toInvoiceId: invoice.id,
      }, actorId, { tx });
      if (!applyRes.ok) {
        throw Object.assign(new Error(`抵扣失败：${applyRes.error?.message}`), { code: 'WRITE_OFF_FAILED' });
      }

      // ⓘ 回读 CN 的**抵扣后**状态：createCreditNote 返回的是「刚建」快照（openAmount=原额），
      //   直接返回它会让调用方看到过期数据（真库演练 ⑥ 抓到这个不一致）。
      const cnAfter = await tx.creditNote.findUnique({ where: { id: creditNote.id } });
      const after = await tx.invoice.findUnique({ where: { id: invoice.id }, select: { status: true } });

      await writeRouteAuditLog({
        prisma: tx,
        actorId,
        source: 'finance-write-off',
        operation: 'WRITE_OFF_INVOICE_TAIL',
        targetType: 'Invoice',
        targetId: invoice.id,
        before: { invoiceStatus: invoice.status, openAmount: open.toString() },
        after: {
          invoiceStatus: after?.status ?? null,
          writeOffAmount: writeOffAmount.toString(),
          creditNoteId: creditNote.id,
          creditNoteNumber: creditNote.creditNoteNumber,
          reason,
        },
      });

      return {
        creditNote: cnAfter ?? creditNote,
        appliedAmount: Number(writeOffAmount),
        invoiceStatusAfter: after?.status ?? null,
      };
    });

    return { ok: true, data };
  } catch (e: any) {
    logger.error('[WriteOffService] writeOffInvoiceTail failed', { error: e?.message });
    const code: WriteOffErrorCode = (e?.code as WriteOffErrorCode) ?? 'WRITE_OFF_FAILED';
    return fail(code, e?.message ?? '尾差销账失败');
  }
}
