/**
 * proformaInvoiceService.ts — Phase 1-04 形式发票（PI）服务
 *
 * 业务背景：
 *   外贸标准流程：报价单（Quotation）→ 客户确认 → 卖方开出形式发票（PI）→
 *   客户凭 PI 付预付款（T/T 30% deposit）→ 大货出货后开 Commercial Invoice（正式应收发票）。
 *   PI 不是正式财务发票，不入账，不参与 AR/AP 看板。
 *
 * 设计决策：
 *   - 复用 Invoice 模型，type='Proforma' 标识形式发票（不改 schema，type 是 String 字段）
 *   - PI 状态复用 Invoice 状态机：Draft → Issued → Cancelled
 *   - 转换为正式应收发票时：新建 type='Receivable' Invoice（status=Issued），
 *     原 PI status → 'Cancelled'（notes 标记转换关系，审计可追溯）
 *   - AR/AP 看板排除 type='Proforma'（在 financeServiceV2.getArApSummary 中过滤）
 *   - 报价单行项目快照到 PI attachments（Invoice 模型无 lines 关系）
 *
 * 与现有服务的关系：
 *   - 复用 createSequenceService 生成编号（INV-2026-0001 序列）
 *   - 复用 writeRouteAuditLog 审计日志
 *   - 复用 publishBusinessEvent 业务事件
 */
import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { createSequenceService } from '../sequence/sequenceService';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { publishBusinessEvent } from '../events/businessEventBus';
import { notifyCustomerCreditRecalc } from '../credit/creditService';
import { decideLcGate, LC_INVOICE_ISSUE_ACTION } from '../customs/lcGate';
import { logger } from '../lib/logger';
import { isValidLocalDateKey, todayLocalKey } from '../shared/localDate';
import { safeRouteError } from '../shared/routeError';
import type { TokenPayload } from '../auth/service';
import { lockAuthorizedProformaSource, ProformaAccessError, isProformaAccessCode, type ProformaAccessCode } from './proformaInvoiceAccess';
import { proformaSourceOrderId } from './proformaSourceOrder';
import { resolveOrderAllocations, syncInvoiceOrderAllocations } from './invoiceMutationService';
import { notifyShipmentBatchSettlementRecalc } from './shipmentBatchSettlementHook';
import { isBusinessError } from '../shared/errorCodes';

// ────────────────────────────────────────────────────────────────────
// 类型定义
// ────────────────────────────────────────────────────────────────────

export interface ProformaGenerateInput {
  quotationId: string;
  issueDate?: string; // 缺省当天
  dueDate?: string;
  notes?: string;
}

export interface ProformaConvertInput {
  /** 转换后正式应收发票的开票日期，缺省当天 */
  issueDate?: string;
  /** 转换后正式应收发票的到期日 */
  dueDate?: string;
  /** 附加备注 */
  notes?: string;
}

type ProformaCommandCode = 'NOT_FOUND'
  | 'QUOTATION_NOT_FOUND'
  | 'QUOTATION_NOT_ACCEPTED'
  | 'NOT_PROFORMA'
  | 'ALREADY_CONVERTED'
  | 'INVALID_STATUS'
  | 'SEQUENCE_FAILED'
  // G-4：PI 转正是"正式应收票落库"的另一条写入路径，开票门禁必须在此显式登记，
  //   否则 decideLcGate 的两个码在这里装不进去（= 只能塌成 INTERNAL_ERROR 或被静默丢掉）。
  | 'LC_GATE_BLOCKED'
  | 'LC_EXCEPTION_CHECK_FAILED'
  | 'INTERNAL_ERROR';
export type ProformaError = ProformaAccessCode | ProformaCommandCode;

export interface ProformaResult<T = any> {
  ok: boolean;
  data?: T;
  error?: { code: ProformaError; message: string; statusCode?: number };
}

// ────────────────────────────────────────────────────────────────────
// 服务工厂
// ────────────────────────────────────────────────────────────────────

class ProformaCommandError extends Error {
  constructor(readonly code: ProformaCommandCode, message: string) { super(message); }
}
const SEQUENCE_FAILURE_MESSAGE = '单据编号未能生成（可能与其他单据同时开单），请稍后重试一次；持续失败请联系管理员核对编号序列。';

export function createProformaInvoiceService(prisma: PrismaClient) {
  const db = prisma as any;
  const seqSvc = createSequenceService(prisma);

  function generateId(): string {
    return `INV__${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }
  function decimalString(v: any): string | null {
    if (v === undefined || v === null) return null;
    return typeof v?.toString === 'function' ? v.toString() : String(v);
  }
  // Existing public DTO remains numeric. Persistent amounts, source snapshots
  // and audit facts never pass through Number before their Decimal write.
  function serialize(row: any): any {
    const out: any = { ...row };
    for (const k of Object.keys(out)) if (typeof out[k] === 'bigint') out[k] = Number(out[k]);
    for (const k of ['amount', 'exchangeRate']) {
      if (out[k] && typeof out[k] === 'object' && out[k].toString) out[k] = Number(out[k].toString());
    }
    return out;
  }
  function reject(code: ProformaCommandCode, message: string): never { throw new ProformaCommandError(code, message); }
  function issueDateOf(input: ProformaGenerateInput | ProformaConvertInput): string {
    const issueDate = input.issueDate || todayLocalKey();
    if (!isValidLocalDateKey(issueDate)) reject('INVALID_STATUS', '开票日期不正确，请选择有效日期（YYYY-MM-DD）。');
    if (input.dueDate != null && input.dueDate !== '' && !isValidLocalDateKey(input.dueDate)) {
      reject('INVALID_STATUS', '到期日期不正确，请选择有效日期（YYYY-MM-DD）。');
    }
    return issueDate;
  }
  async function nextInvoiceNumber(tx: any): Promise<string> {
    try {
      return await seqSvc.nextNumber(tx, 'invoice', {
        occupied: async num => (await tx.invoice.findFirst({ where: { invoiceNumber: num }, select: { id: true } })) != null,
      });
    } catch (error: unknown) {
      logger.error('[proforma-invoice] sequence generation failed', { error: error instanceof Error ? error.message : String(error) });
      // Throw across the transaction boundary: an unsuccessful allocation must
      // not commit a sequence increment separately from its document/audit.
      return reject('SEQUENCE_FAILED', SEQUENCE_FAILURE_MESSAGE);
    }
  }
  function failure(error: unknown, mode: 'generate' | 'convert'): ProformaResult {
    logger.error(`[ProformaInvoice] ${mode} failed`, { error: error instanceof Error ? error.message : String(error) });
    if (error instanceof ProformaAccessError) return { ok: false, error: { code: error.code, message: error.message, statusCode: error.statusCode } };
    if (error instanceof ProformaCommandError) return { ok: false, error: { code: error.code, message: error.message } };
    const safe = safeRouteError(undefined, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: mode === 'generate'
      ? '形式发票生成结果暂不可确认，请刷新核对原发票记录后重试。'
      : '形式发票转正结果暂不可确认，请刷新核对原形式发票及正式发票后重试。' });
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: safe.message } };
  }

  /** Accepted quote → Draft PI. Parent quote lock protects the source snapshot;
   * sequence, PI and mandatory audit commit or roll back together. */
  async function generateFromQuotation(input: ProformaGenerateInput, actorId: string | null, ip?: string | null, trustedActor?: TokenPayload | null): Promise<ProformaResult> {
    try {
      const committed = await db.$transaction(async (tx: any) => {
        const authorized = await lockAuthorizedProformaSource(tx, 'quotation', input.quotationId, actorId, trustedActor);
        const quotation = authorized.source, auditActorId = authorized.actor.userId;
        if (!quotation) reject('QUOTATION_NOT_FOUND', '报价单不存在或已删除');
        if (quotation.status !== 'Accepted') reject('QUOTATION_NOT_ACCEPTED', `报价单状态为 ${quotation.status}，仅 Accepted 状态可生成 PI`);
        const sourceOrderIds = authorized.parents?.orderIds ?? [];
        // A native quote conversion creates the financial Order while keeping
        // its original Order/OrderLine as provenance. These are not monetary
        // allocations across two orders. Keep all origins for authorization,
        // but put the real converted order (or unique existing source) in PI.
        if (!quotation.convertedOrderId && sourceOrderIds.length > 1) throw new ProformaAccessError('CONFLICT', '报价来源订单不一致，请先核对原单关联。');
        const sourceOrderId = proformaSourceOrderId(quotation, authorized.parents?.line?.orderId);
        const issueDate = issueDateOf(input);
        const invoiceNumber = await nextInvoiceNumber(tx);
        const linesSnapshot = quotation.lines.map((line: any) => ({
          lineNumber: line.lineNumber, fabricCode: line.fabricCode, description: line.description,
          quantity: decimalString(line.quantity), unit: line.unit, unitPrice: decimalString(line.unitPrice),
          amount: decimalString(line.amount), notes: line.notes,
        }));
        const termsParts: string[] = [`来源报价单: ${quotation.quotationNumber}`];
        if (quotation.deliveryTerms) termsParts.push(`交货条款: ${quotation.deliveryTerms}`);
        if (quotation.paymentTerms) termsParts.push(`付款条款: ${quotation.paymentTerms}`);
        if (quotation.salesperson) termsParts.push(`业务员: ${quotation.salesperson}`);
        if (input.notes) termsParts.push(input.notes);
        const now = BigInt(Date.now());
        const pi = await tx.invoice.create({ data: {
          id: generateId(), invoiceNumber, type: 'Proforma', status: 'Draft',
          amount: new Prisma.Decimal(quotation.totalAmount.toString()), currency: quotation.currency,
          issueDate, dueDate: input.dueDate || null,
          exchangeRate: quotation.exchangeRate == null ? null : new Prisma.Decimal(quotation.exchangeRate.toString()),
          baseCurrency: quotation.baseCurrency || 'CNY', orderId: sourceOrderId,
          customerRelationId: quotation.customerRelationId || null, customerName: quotation.customerName || null,
          notes: termsParts.join('; '),
          attachments: { quotationId: quotation.id, quotationNumber: quotation.quotationNumber, lines: linesSnapshot },
          ownerId: actorId, departmentId: null, createdAt: now, updatedAt: now,
        } });
        const auditId = await writeRouteAuditLog({
          prisma: tx, actorId: auditActorId, source: 'proforma-invoice:generate',
          operation: 'generate_proforma_from_quotation', targetType: 'Invoice', targetId: pi.id,
          before: { quotationId: quotation.id, quotationNumber: quotation.quotationNumber,
            orderId: quotation.orderId ?? null, orderLineId: quotation.orderLineId ?? null, convertedOrderId: quotation.convertedOrderId ?? null },
          after: { invoiceId: pi.id, invoiceNumber: pi.invoiceNumber, type: 'Proforma', orderId: pi.orderId, amount: decimalString(pi.amount), currency: pi.currency },
          ip: ip || null,
        });
        return { pi, quotation, auditId, auditActorId };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10_000, timeout: 30_000 });
      const { pi, quotation, auditId, auditActorId } = committed;
      publishBusinessEvent({
        type: 'ProformaInvoiceGenerated', sourceEntityType: 'Invoice', sourceEntityId: pi.id, orderId: pi.orderId || undefined,
        payload: { invoiceId: pi.id, invoiceNumber: pi.invoiceNumber, quotationId: quotation.id,
          quotationNumber: quotation.quotationNumber, amount: decimalString(pi.amount), currency: pi.currency, customerRelationId: pi.customerRelationId },
        actorId: auditActorId, transactionId: auditId,
      }).catch(() => { /* event publish failure must not fail business */ });
      logger.info('[ProformaInvoice] generated', { invoiceId: pi.id, invoiceNumber: pi.invoiceNumber,
        quotationId: quotation.id, quotationNumber: quotation.quotationNumber, actorId: auditActorId });
      return { ok: true, data: serialize(pi) };
    } catch (error: unknown) { return failure(error, 'generate'); }
  }

  /** Existing native rule: any non-Cancelled Proforma can convert; Draft and
   * Issued are examples, not an additional status allowlist. One Issued
   * Receivable is created and the original PI becomes Cancelled.
   * Lock then reread the PI before deciding; a competing conversion observes
   * its committed Cancelled status, never an earlier transaction's stale Draft. */
  async function convertToReceivable(piId: string, input: ProformaConvertInput, actorId: string | null, ip?: string | null, trustedActor?: TokenPayload | null): Promise<ProformaResult> {
    try {
      const committed = await db.$transaction(async (tx: any) => {
        // This prelude locks and revalidates actual shipment/release sources
        // before the original PI. Allocation creation below must not acquire
        // those parents after holding Invoice/IOA financial locks.
        const authorized = await lockAuthorizedProformaSource(tx, 'invoice', piId, actorId, trustedActor);
        const pi = authorized.source, auditActorId = authorized.actor.userId;
        if (!pi) reject('NOT_FOUND', '发票不存在或已删除');
        if (pi.type !== 'Proforma') reject('NOT_PROFORMA', `发票类型为 ${pi.type}，仅 Proforma 可转换`);
        if (pi.status === 'Cancelled') reject('ALREADY_CONVERTED', '该 PI 已作废（可能已转换），不可重复转换');
        const issueDate = issueDateOf(input);
        // Carry real active allocation facts, never manufacture IOA rows from
        // the header or JSON snapshot. Header-only legacy PI remains valid.
        const sourceAllocations: any[] = authorized.parents?.attachments ?? [];
        if (!pi.orderId && !sourceAllocations.length && authorized.parents?.quotationParents?.orderIds.length) {
          throw new ProformaAccessError('CONFLICT', '旧形式发票未保存来源订单，请从原报价重新生成后继续办理；本次不会自动分配金额。');
        }
        const resolved = resolveOrderAllocations({ orderAllocations: sourceAllocations.map(row => ({
          orderId: row.orderId, batchId: row.batchId, allocatedAmount: decimalString(row.allocatedAmount), note: row.note,
        })) });
        if (!resolved.ok) throw new ProformaAccessError('INVALID_AMOUNT', resolved.error.message);
        const allocations = resolved.allocations ?? [];
        if (allocations.length !== sourceAllocations.length || allocations.some((row, index) =>
          row.orderId !== sourceAllocations[index].orderId || (row.batchId ?? null) !== (sourceAllocations[index].batchId ?? null)))
          throw new ProformaAccessError('INVALID_AMOUNT', '原分配的订单或批次标识不完整，请先核对实际来源。');
        // Preserve the original free-text note exactly; identifiers and money
        // have already passed the same native normalization gate.
        for (let i = 0; i < allocations.length; i++) allocations[i].note = sourceAllocations[i].note;
        const orderIds = authorized.parents?.orderIds ?? [];
        for (const orderId of orderIds) {
          const lcDecision = await decideLcGate({ prisma: tx, orderId, stage: 'invoice:issue', exceptionAction: LC_INVOICE_ISSUE_ACTION });
          if (!lcDecision.allowed) reject(lcDecision.code, lcDecision.code === 'LC_EXCEPTION_CHECK_FAILED'
            ? `信用证门禁未通过（${lcDecision.reasons.join(', ')}），且无法确认是否已有 DR-013 例外 ⇒ 保持阻断，请先排查例外/审批服务`
            : `该订单以信用证结算，但${lcDecision.lcLabel ? `信用证 ${lcDecision.lcLabel} 不满足条款` : '尚未登记信用证'}（${lcDecision.reasons.join(', ')}）；请先登记/核对 L/C，确需例外按 DR-013 申请（action='${LC_INVOICE_ISSUE_ACTION}'）`);
        }
        const receivableNumber = await nextInvoiceNumber(tx);
        const now = BigInt(Date.now()), piAttachments = pi.attachments as any || {};
        const receivable = await tx.invoice.create({ data: {
          id: generateId(), invoiceNumber: receivableNumber, type: 'Receivable', status: 'Issued',
          amount: new Prisma.Decimal(pi.amount.toString()), currency: pi.currency, issueDate,
          dueDate: input.dueDate || pi.dueDate || null,
          exchangeRate: pi.exchangeRate == null ? null : new Prisma.Decimal(pi.exchangeRate.toString()),
          baseCurrency: pi.baseCurrency || 'CNY', orderId: pi.orderId || null,
          customerRelationId: pi.customerRelationId || null, customerName: pi.customerName || null,
          notes: `来源形式发票: ${pi.invoiceNumber}${input.notes ? '; ' + input.notes : ''}`,
          attachments: { ...piAttachments, proformaInvoiceId: pi.id, proformaInvoiceNumber: pi.invoiceNumber },
          ownerId: pi.ownerId || actorId, departmentId: pi.departmentId || null, createdAt: now, updatedAt: now,
        } });
        try { await syncInvoiceOrderAllocations(tx, receivable, allocations); }
        catch (error) {
          // Only the native producer's known typed refusals are public.
          // A database/unknown exception still crosses the outer tx boundary.
          if (isBusinessError(error) && isProformaAccessCode(error.code)
            && ['INVALID_AMOUNT', 'INVOICE_CUSTOMER_MISMATCH', 'INVOICE_CONSOLIDATION_CUSTOMER_MISMATCH'].includes(error.code))
            throw new ProformaAccessError(error.code, String(error.message));
          throw error;
        }
        const carriedAllocations: any[] = allocations.length ? await tx.invoiceOrderAllocation.findMany({
          where: { invoiceId: receivable.id, deletedAt: null }, orderBy: { id: 'asc' },
        }) : [];
        await tx.invoice.update({ where: { id: piId }, data: {
          status: 'Cancelled', notes: (pi.notes || '') + `; 已转换为正式应收发票: ${receivableNumber}`, updatedAt: now,
        } });
        // Preserve the existing customer-credit hook, now using this same tx.
        if (receivable.customerRelationId) await notifyCustomerCreditRecalc(tx, {
          relationId: receivable.customerRelationId, source: 'proforma-invoice:convert', triggerId: receivable.id, triggerBy: auditActorId,
        });
        const auditId = await writeRouteAuditLog({
          prisma: tx, actorId: auditActorId, source: 'proforma-invoice:convert', operation: 'convert_proforma_to_receivable',
          targetType: 'Invoice', targetId: receivable.id,
          before: { proformaInvoiceId: pi.id, proformaInvoiceNumber: pi.invoiceNumber, proformaStatus: pi.status,
            orderAllocations: sourceAllocations.map(row => ({ id: row.id, invoiceId: pi.id, orderId: row.orderId,
              batchId: row.batchId, allocatedAmount: decimalString(row.allocatedAmount), note: row.note })) },
          after: { receivableInvoiceId: receivable.id, receivableInvoiceNumber: receivable.invoiceNumber,
            type: 'Receivable', status: 'Issued', amount: decimalString(receivable.amount),
            orderAllocations: carriedAllocations.map(row => ({ id: row.id, sourceAllocationId: sourceAllocations.find(source => source.orderId === row.orderId)?.id,
              invoiceId: receivable.id, orderId: row.orderId, batchId: row.batchId, allocatedAmount: decimalString(row.allocatedAmount), note: row.note })) }, ip: ip || null,
        });
        return { pi, receivable, auditId, auditActorId };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10_000, timeout: 30_000 });
      const { pi, receivable, auditId, auditActorId } = committed;
      // Complete the existing derived refresh before ack, after the new real
      // IOA and original cancellation have committed together. The hook is
      // best-effort: a refresh failure cannot undo the committed conversion.
      await notifyShipmentBatchSettlementRecalc(prisma, { invoiceId: receivable.id, source: 'proforma-invoice:convert' });
      publishBusinessEvent({
        type: 'ProformaInvoiceConverted', sourceEntityType: 'Invoice', sourceEntityId: receivable.id, orderId: receivable.orderId || undefined,
        payload: { proformaInvoiceId: pi.id, proformaInvoiceNumber: pi.invoiceNumber,
          receivableInvoiceId: receivable.id, receivableInvoiceNumber: receivable.invoiceNumber,
          amount: decimalString(receivable.amount), currency: receivable.currency }, actorId: auditActorId, transactionId: auditId,
      }).catch(() => { /* event publish failure must not fail business */ });
      logger.info('[ProformaInvoice] converted', { proformaInvoiceId: pi.id, proformaInvoiceNumber: pi.invoiceNumber,
        receivableInvoiceId: receivable.id, receivableInvoiceNumber: receivable.invoiceNumber, actorId: auditActorId });
      return { ok: true, data: serialize(receivable) };
    } catch (error: unknown) { return failure(error, 'convert'); }
  }
  return { generateFromQuotation, convertToReceivable };
}

// ────────────────────────────────────────────────────────────────────
// 单例
// ────────────────────────────────────────────────────────────────────

let _defaultService: ReturnType<typeof createProformaInvoiceService> | null = null;
export function getProformaInvoiceService(prisma: PrismaClient): ReturnType<typeof createProformaInvoiceService> {
  if (!_defaultService) _defaultService = createProformaInvoiceService(prisma);
  return _defaultService;
}
