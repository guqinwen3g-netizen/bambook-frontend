/**
 * claimSettlement.ts — ★★ **钱/货两条腿的唯一收口点**
 *
 * 口径依据：`docs/业务口径决策单-2026-09-17.md` **A1-附 ②**
 *   「**钱、货分开走，各自只有一张单**：
 *     所有该退客户的钱 → 汇总成一张退款单；所有要退回来的货 → 走一张退货入库单」
 *
 * ════════════════════════════════════════════════════════════════════
 * ★★ 为什么必须收成一个函数（本仓最高产的一类 bug）
 *
 * 「同一个业务动作有多个入口，副作用却只挂在其中一个入口上」—— 本仓反复踩过：
 *   · 作废发票（`updateInvoice` 有批次重算 / `cancelInvoice` 没有）
 *   · 订单结案（挂在 `allocationMutationService` 外层，而 `applyAllocation` 是
 *     route+Agent 三通道共用内核 → Agent 漏）
 *   · 运单取消（库存有回冲 / 订单状态没有）
 *
 * 所以：**执行处置的全部副作用（开退款单、开退货入库单、回填汇总）只在本函数里**；
 * `route` / Agent 工具 / 未来的 UI 批量操作**都调它** —— **不要逐个入口补**（必然再次漂移）。
 * ════════════════════════════════════════════════════════════════════
 */

import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { parsePositiveDecimal } from '../shared/moneyInput';
import { createCreditNote } from './creditNoteService';
import { appendClaimCreditNoteInTx, assertClaimCreditNoteAccount, lockCreditNoteForSettlement } from './claimCreditNoteVersionService';
import { createReturnReceipt } from './returnReceiptService';
// ★ A-3 二期：换货补发 → 复用出运流程（不另造一套）；返修 → 独立返修工单（复用 WorkStation）
import { createReplacementShipment } from './replacementService';
import { createRepairWorkOrder } from './repairWorkOrderService';
import { DISPOSITION_KINDS, GOODS_KINDS, MONEY_KINDS, RETURN_DISPOSITIONS, type ClaimResult } from './claimCaseService';
import { localDateKey } from '../shared/localDate';
import { canonicalClaimJson, ClaimTransactionError, claimRefusal, lockClaimRows, readClaimApprovedFact, requireClaimResult } from './claimApprovalFact';

const fail = <T>(code: any, message: string): ClaimResult<T> => ({ ok: false, error: { code, message } });
const ok = <T>(data: T): ClaimResult<T> => ({ ok: true, data });

export interface ExecuteDispositionOptions {
  /**
   * 动货的处置**必须**指定入哪个仓（`ClaimDisposition` 无仓字段 ——
   * 仓是执行时才确定的，故由调用方传入）。
   */
  warehouseId?: string | null;
  /**
   * ★ A-3 二期：`Repair`（返修）必须指定**工位**（复用 `WorkStation`）。
   * 返修是车间动作，没工位就无法派活。
   */
  workStationId?: string | null;
  /** ★ A-3 二期：`Replace`（换货补发）可指定**原出运单**（继承运输属性 + 追溯） */
  sourceShipmentId?: string | null;
  /**
   * 调用方补充的备注（会拼进产出单据的 `notes`）。
   * ★ 用途之一：**真库演练**靠它把演练标记（如 `DRILL`）写进产出单，
   *   否则回滚按前缀扫时**匹配不到**——表现为「删 0 条 + 复核 0 条」的**空过验证器**。
   */
  notes?: string | null;
  /** Explicit retry contract. Legacy callers without an ID still receive a conflict on replay. */
  clientRequestId?: string | null;
}

/**
 * 执行一条处置（★ 钱/货两条腿的唯一入口）。
 *
 * 前置：处置必须已 **Approved**（口径 A7：任何金额都汇总领导批 ⇒ **未批不可执行**）。
 *
 * 产出（按 kind 自动分流，**不由调用方选**）：
 * | kind | 退款单 | 退货入库单 |
 * |---|---|---|
 * | Allowance（折让） | ✓ | |
 * | ReturnRefund（退货退款） | ✓ | ✓ |
 *
 * 回填：处置的 `creditNoteId` / `returnReceiptId` + `status='Executed'`；
 *      案件的 `totalCreditAmount` / `totalReturnQty` 汇总。
 */
type ExecutionOutputs = { disposition: any; creditNote?: any; returnReceipt?: any; replacementShipment?: any; repairWorkOrder?: any };

function validatedValues(d: any, opts: ExecuteDispositionOptions) {
  if (!(DISPOSITION_KINDS as readonly string[]).includes(d.kind)) claimRefusal('处置类型不可用，不能继续执行');
  const needsMoney = (MONEY_KINDS as readonly string[]).includes(d.kind);
  const needsGoods = (GOODS_KINDS as readonly string[]).includes(d.kind);
  let moneyValue = '';
  if (needsMoney) {
    const parsed = parsePositiveDecimal(d.amount, '该处置的金额');
    if (!parsed.ok) claimRefusal(`处置 ${d.id} 的${parsed.field}不可用（${parsed.message}）`
      + ' —— 处置行是审批通过后才执行的，金额为空说明数据不一致；请先修数据，不许按 0 出退款单');
    moneyValue = parsed.value;
    if (!d.currency?.trim()) claimRefusal('处置币种不可用，请补审');
  }
  let goodsValue = '';
  if (needsGoods) {
    const parsed = parsePositiveDecimal(d.quantity, '该处置的数量');
    if (!parsed.ok) claimRefusal(`处置 ${d.id} 的${parsed.field}不可用（${parsed.message}）`
      + ' —— 数量为空的动货处置不许继续执行（会凭空入库/退料）');
    goodsValue = parsed.value;
    if (!d.unit?.trim() || !(RETURN_DISPOSITIONS as readonly string[]).includes(d.returnDisposition)) claimRefusal('处置单位或退货去向不可用，请补审');
    if (!d.materialCode?.trim()) claimRefusal('动货处置缺少真实物料编码，请重新送审');
  }
  if (needsGoods && !opts.warehouseId) throw new ClaimTransactionError({ code: 'VALIDATION_FAILED', message: '动货处置需指定退货入库的仓库（warehouseId）' });
  if (d.kind === 'Repair' && !opts.workStationId) throw new ClaimTransactionError({ code: 'VALIDATION_FAILED', message: '返修需指定工位（workStationId）—— 没有工位就无法派活' });
  return { needsMoney, needsGoods, moneyValue, goodsValue };
}

function executionParameters(opts: ExecuteDispositionOptions) {
  return { warehouseId: opts.warehouseId ?? null, workStationId: opts.workStationId ?? null,
    sourceShipmentId: opts.sourceShipmentId ?? null, notes: opts.notes ?? null };
}

async function replayOutputs(tx: any, d: any): Promise<ExecutionOutputs> {
  const output: ExecutionOutputs = { disposition: d };
  const names = [['creditNoteId', 'creditNote', 'creditNote'], ['returnReceiptId', 'returnReceipt', 'returnReceipt'],
    ['replacementShipmentId', 'shipment', 'replacementShipment'], ['repairWorkOrderId', 'repairWorkOrder', 'repairWorkOrder']] as const;
  const required = d.kind === 'Allowance' ? ['creditNoteId'] : d.kind === 'ReturnRefund' ? ['creditNoteId', 'returnReceiptId']
    : d.kind === 'Replace' ? ['returnReceiptId', 'replacementShipmentId'] : ['returnReceiptId', 'repairWorkOrderId'];
  for (const [idField, model, key] of names) {
    if (required.includes(idField) !== Boolean(d[idField])) claimRefusal('已执行产出范围不一致，请人工核查');
    if (d[idField]) {
      const row = await tx[model].findUnique({ where: { id: d[idField] } });
      if (!row || row.deletedAt) claimRefusal('已执行产出不存在或已删除，不能返回虚假成功');
      (output as any)[key] = row;
    }
  }
  if (d.creditNoteId) {
    const note = await lockCreditNoteForSettlement(tx, d.creditNoteId);
    const account = await assertClaimCreditNoteAccount(tx, note);
    if (!account || account.lines.filter((line: any) => line.claimDispositionId === d.id).length !== 1) claimRefusal('已执行退款产出缺少准确批准明细，请人工核查');
    output.creditNote = { ...note, currentVersion: account.version };
  }
  if (d.returnReceiptId) {
    const lines = await tx.returnReceiptLine.findMany({ where: { returnReceiptId: d.returnReceiptId } });
    const matching = lines.filter((line: any) => line.claimDispositionId === d.id);
    if (matching.length !== 1 || matching[0].materialCode !== d.materialCode || matching[0].unit !== d.unit
        || matching[0].disposition !== d.returnDisposition || !new Prisma.Decimal(matching[0].expectedQuantity).equals(d.quantity)) claimRefusal('退货产出缺少准确的批准明细，须人工核查');
    output.returnReceipt.lines = lines;
  }
  if (d.replacementShipmentId) {
    const lines = await tx.shipmentLine.findMany({ where: { shipmentId: d.replacementShipmentId } });
    if (lines.length !== 1 || lines[0].orderLineId || lines[0].productCode !== d.materialCode || lines[0].unit !== d.unit
        || !new Prisma.Decimal(lines[0].quantity).equals(d.quantity)) claimRefusal('补发产出与已批准的真实SKU、数量和单位不一致');
    output.replacementShipment.lines = lines;
  }
  if (d.repairWorkOrderId && (output.repairWorkOrder.dispositionId !== d.id || output.repairWorkOrder.claimCaseId !== d.claimCaseId
      || output.repairWorkOrder.materialCode !== d.materialCode || output.repairWorkOrder.unit !== d.unit
      || !new Prisma.Decimal(output.repairWorkOrder.quantity).equals(d.quantity))) claimRefusal('返修工单与已批准处置不一致');
  return output;
}

export async function executeDisposition(
  prisma: PrismaClient,
  dispositionId: string,
  actorId: string,
  opts: ExecuteDispositionOptions = {},
): Promise<ClaimResult<ExecutionOutputs>> {
  try {
    if (opts.clientRequestId != null && (typeof opts.clientRequestId !== 'string' || !opts.clientRequestId.trim() || opts.clientRequestId.length > 200)) {
      return fail('VALIDATION_FAILED', 'clientRequestId 须为 1–200 字符的稳定请求标识');
    }
    // Retain precise invalid persisted amount/quantity diagnostics before fact lookup.
    // These unlocked reads never authorize execution; everything is reread under row locks below.
    const initial = await prisma.claimDisposition.findUnique({ where: { id: dispositionId } });
    if (!initial || initial.deletedAt) return fail('NOT_FOUND', `处置 ${dispositionId} 不存在`);
    if (initial.status !== 'Approved' && !(initial.status === 'Executed' && opts.clientRequestId)) {
      return fail('INVALID_STATE', `处置状态为 ${initial.status} —— 必须**先审批通过**才能执行（口径 A7）`);
    }
    validatedValues(initial, opts);

    return await prisma.$transaction(async (tx: any) => {
      const { disposition: d, claimCase } = await lockClaimRows(tx, dispositionId);
      if (claimCase.status === 'Cancelled') claimRefusal('案件已撤销，不可执行处置');
      if (d.status !== 'Approved' && !(d.status === 'Executed' && opts.clientRequestId)) claimRefusal(`处置状态为 ${d.status} —— 必须**先审批通过**才能执行（口径 A7）`);
      const { needsMoney, needsGoods, moneyValue, goodsValue } = validatedValues(d, opts);
      const fact = await readClaimApprovedFact(tx, d, claimCase);
      if (d.approverId !== fact.decisionActorId || d.approvedAt !== localDateKey(fact.approval.decidedAt)) claimRefusal('处置批准状态没有准确的内核批准事实，请补审');
      const parameters = executionParameters(opts);
      if (d.status === 'Executed') {
        const audits = await tx.auditLog.findMany({ where: { targetType: 'ClaimDisposition', targetId: d.id, action: 'execute' } });
        const matches = audits.filter((a: any) => {
          const execution = a.detail?.claimExecution;
          return a.actorId === actorId && execution?.schemaVersion === 1 && execution.actorId === actorId
            && execution.requestId === opts.clientRequestId && execution.approvalRequestId === fact.approval.id
            && execution.contentFingerprint === fact.contentFingerprint;
        });
        if (matches.length !== 1) claimRefusal('处置已执行；请求标识或调用者不匹配，请查阅原产出');
        if (canonicalClaimJson(matches[0].detail.claimExecution.parameters) !== canonicalClaimJson(parameters)) claimRefusal('相同请求标识的执行参数不同，不可重放');
        const output = await replayOutputs(tx, d);
        const ids = { creditNoteId: d.creditNoteId ?? null, returnReceiptId: d.returnReceiptId ?? null,
          replacementShipmentId: d.replacementShipmentId ?? null, repairWorkOrderId: d.repairWorkOrderId ?? null };
        if (canonicalClaimJson(matches[0].detail.claimExecution.outputs) !== canonicalClaimJson(ids)) claimRefusal('执行审计与当前产出不一致，不能重放');
        return ok(output);
      }

      // Missing context was checked before this point. FK or output errors still escape the tx.
      const claimed = await tx.claimDisposition.updateMany({ where: { id: d.id, status: 'Approved', deletedAt: null }, data: { updatedAt: BigInt(Date.now()) } });
      if (claimed.count !== 1) claimRefusal('处置已由其他请求执行，请刷新');
      let creditNote: any;
      let returnReceipt: any;
      let replacementShipment: any;
      let repairWorkOrder: any;
      if (needsMoney) {
        creditNote = await appendClaimCreditNoteInTx(tx, { disposition: d, claimCase, fact }, actorId, opts.clientRequestId ?? null, async () => requireClaimResult(await createCreditNote(prisma, {
          amount: new Prisma.Decimal(moneyValue).toString(), currency: d.currency,
          customerRelationId: claimCase.customerRelationId, customerName: claimCase.customerName, claimCaseId: claimCase.id,
          sourceInvoiceId: claimCase.sourceInvoiceId, reason: `客诉 ${claimCase.caseNumber} · ${d.kind}`,
        }, actorId, { tx })).creditNote);
      }
      if (needsGoods) {
        returnReceipt = requireClaimResult(await createReturnReceipt(prisma, { claimCaseId: claimCase.id,
          warehouseId: opts.warehouseId!, disposition: d.returnDisposition, notes: `客诉 ${claimCase.caseNumber} · ${d.kind}`,
          claimDispositionId: d.id, materialCode: d.materialCode, quantity: goodsValue, unit: d.unit,
        }, actorId, { tx })).returnReceipt;
      }
      if (d.kind === 'Replace') {
        replacementShipment = requireClaimResult(await createReplacementShipment(prisma, { claimCaseId: claimCase.id,
          claimDispositionId: d.id, claimCaseNumber: claimCase.caseNumber, sourceShipmentId: opts.sourceShipmentId ?? null,
          notes: `${opts.notes ? `${opts.notes} · ` : ''}数量 ${d.quantity}${d.unit} · 去向 ${d.returnDisposition}`,
        }, actorId, { tx })).shipment;
      } else if (d.kind === 'Repair') {
        repairWorkOrder = requireClaimResult(await createRepairWorkOrder(prisma, {
          claimCaseId: claimCase.id, dispositionId: d.id, workStationId: opts.workStationId!, quantity: goodsValue, unit: d.unit,
          materialCode: d.materialCode, needsReinspection: true, repairReason: `客诉 ${claimCase.caseNumber}（退货去向：${d.returnDisposition ?? '未填'}）`, notes: d.notes,
        }, actorId, { tx })).workOrder;
      }

      const now = BigInt(Date.now());
      const outputs = { creditNoteId: creditNote?.id ?? null, returnReceiptId: returnReceipt?.id ?? null,
        replacementShipmentId: replacementShipment?.id ?? null, repairWorkOrderId: repairWorkOrder?.id ?? null };
      const disposition = await tx.claimDisposition.update({ where: { id: d.id }, data: { status: 'Executed', ...outputs, updatedAt: now } });
      const casePatch: any = { updatedAt: now };
      if (needsMoney) { casePatch.totalCreditAmount = { increment: new Prisma.Decimal(moneyValue) }; casePatch.creditCurrency = d.currency ?? claimCase.creditCurrency; }
      if (needsGoods) casePatch.totalReturnQty = { increment: new Prisma.Decimal(goodsValue) };
      await tx.claimCase.update({ where: { id: claimCase.id }, data: casePatch });
      const remaining = await tx.claimDisposition.count({ where: { claimCaseId: claimCase.id, deletedAt: null, status: { notIn: ['Executed', 'Cancelled'] } } });
      if (remaining === 0) await tx.claimCase.update({ where: { id: claimCase.id }, data: { status: 'Handled', updatedAt: now } });
      await tx.auditLog.create({ data: {
        id: `alog_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, actorId, action: 'execute',
        targetType: 'ClaimDisposition', targetId: d.id, operationType: 'transition', fieldPath: 'status',
        detail: { source: 'claim', before: { status: 'Approved' }, after: { status: 'Executed', ...outputs },
          claimExecution: { schemaVersion: 1, actorId, requestId: opts.clientRequestId ?? null, parameters, outputs,
            approvalRequestId: fact.approval.id, decisionActorId: fact.decisionActorId, decisionAuditId: fact.decisionAuditId,
            contentFingerprint: fact.contentFingerprint } },
      } });
      return ok({ disposition, creditNote, returnReceipt, replacementShipment, repairWorkOrder });
    });
  } catch (error) {
    if (error instanceof ClaimTransactionError) return { ok: false, error: error.claimError };
    // Unknown failures remain operational errors: rollback has happened and the route emits a safe 500.
    throw error;
  }
}
