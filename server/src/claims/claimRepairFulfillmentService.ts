import { isValidLocalDateKey, todayLocalKey } from '../shared/localDate';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { createPermissionService, hasScope, legacyAgentRoleForId } from '../auth/permissionService';
import { nextBusinessNumber } from '../shared/businessNumberService';

import { parsePositiveDecimal, parseNonNegativeDecimal } from '../shared/moneyInput';
import type { ClaimResult } from './claimCaseService';
import { canonicalClaimJson, ClaimTransactionError, claimRefusal } from './claimApprovalFact';
import { lockClaimReturnContext, loadAllClaimReturnBatches } from './claimReturnFulfillmentService';

const digest = (value: unknown) => createHash('sha256').update(canonicalClaimJson(value)).digest('hex');
const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
function invalid(message: string): never { throw new ClaimTransactionError({ code: 'VALIDATION_FAILED', message }); }
export interface RepairActionInput { clientRequestId: string; notes?: string | null }
export interface CompleteClaimRepairInput extends RepairActionInput { completedQuantity: number | string; unit: string }
export interface ClaimRepairInspectionInput extends RepairActionInput {
  inspectedQuantity: number | string; passedQuantity: number | string; unit: string;
  result: 'pass' | 'conditional' | 'fail'; inspectionDate?: string | null; reportFile?: string | null; defectSummary?: string | null;
}
function parameters(input: any, keys: string[]) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) invalid('返修参数不完整或含未开放的状态、质检人、来源字段');
  if (typeof input.clientRequestId !== 'string' || !input.clientRequestId.trim() || input.clientRequestId.length > 200) invalid('返修必须有稳定 clientRequestId（1–200字符）');
  if (input.notes != null && typeof input.notes !== 'string') invalid('返修备注须为文本');
  return { notes: input.notes ?? null };
}
function positive(value: any, field: string) { const parsed = parsePositiveDecimal(value, field); if (!parsed.ok) invalid(parsed.message); return new Prisma.Decimal(parsed.value).toString(); }

/** A work order can only operate on its executed, fully approved physical return batch. */
export async function lockClaimRepairContext(tx: any, workOrderId: string) {
  const hint = await tx.repairWorkOrder.findUnique({ where: { id: workOrderId } });
  if (!hint || hint.deletedAt) throw new ClaimTransactionError({ code: 'NOT_FOUND', message: '返修工单不存在' });
  const lines = await tx.returnReceiptLine.findMany({ where: { claimDispositionId: hint.dispositionId } });
  if (!hint.dispositionId || lines.length !== 1) claimRefusal('返修工单缺少唯一、真实处置和退货明细');
  const context = await lockClaimReturnContext(tx, lines[0].id);
  await tx.$queryRawUnsafe('SELECT id FROM "RepairWorkOrder" WHERE id = $1 FOR UPDATE', workOrderId);
  const workOrder = await tx.repairWorkOrder.findUnique({ where: { id: workOrderId } });
  const { line, disposition, claimCase, fact } = context;
  if (!workOrder || workOrder.deletedAt || workOrder.status === 'Cancelled' || disposition.kind !== 'Repair'
      || disposition.repairWorkOrderId !== workOrder.id || workOrder.dispositionId !== disposition.id || workOrder.claimCaseId !== claimCase.id
      || workOrder.materialCode !== line.materialCode || workOrder.unit !== line.unit || !new Prisma.Decimal(workOrder.quantity).equals(line.expectedQuantity)) claimRefusal('返修工单的真实物料、数量、单位或处置关联不一致');
  const batches = await loadAllClaimReturnBatches(tx, line, fact.contentFingerprint);
  if (!new Prisma.Decimal(line.receivedQuantity).equals(workOrder.quantity) || !batches.length) claimRefusal('该返修批次尚未完整实际收货，不可开工、完工或质检');
  const binding = { schemaVersion: 1, workOrderId, claimDispositionId: disposition.id, returnReceiptId: line.returnReceiptId,
    returnReceiptLineId: line.id, contentFingerprint: fact.contentFingerprint, quantity: String(workOrder.quantity), unit: workOrder.unit,
    workStationId: workOrder.workStationId, needsReinspection: workOrder.needsReinspection,
    sourceShipmentId: workOrder.sourceShipmentId ?? null, sourceProductionPlanId: workOrder.sourceProductionPlanId ?? null,
    batches: batches.map(batch => ({ receivedEventId: batch.audit.id, inboundMovementId: batch.inbound.id, holdMovementId: batch.hold.id,
      itemId: batch.item.id, batchNumber: batch.fact.batch.batchNumber, warehouseId: batch.item.warehouseId, materialCode: batch.item.materialCode,
      quantity: batch.fact.parameters.quantity, unit: line.unit, stockQuantity: String(batch.inbound.quantity), stockUnit: batch.item.unit,
      ownership: batch.item.ownership })).sort((a, b) => a.receivedEventId.localeCompare(b.receivedEventId)) };
  return { ...context, workOrder, batches, binding, bindingFingerprint: digest(binding) };
}

function inspectionSnapshot(report: any) {
  return { id: report.id, inspectedBy: report.inspectedBy, inspectedQuantity: String(report.inspectedQuantity),
    passedQuantity: String(report.passedQuantity), unit: report.unit, result: report.result, inspectionDate: report.inspectionDate,
    reportFile: report.reportFile ?? null, defectSummary: report.defectSummary ?? null, notes: report.notes ?? null, createdAt: String(report.createdAt) };
}

async function retry(tx: any, workOrderId: string, action: string, input: any, actorId: string, params: any, bindingFingerprint: string) {
  const rows = await tx.auditLog.findMany({ where: { targetType: 'RepairWorkOrder', targetId: workOrderId, action } });
  const matches = rows.filter((row: any) => row.detail?.claimRepair?.requestId === input.clientRequestId);
  if (!matches.length) return null;
  const row = matches[0], fact = row.detail?.claimRepair;
  if (matches.length !== 1 || row.actorId !== actorId || fact.actorId !== actorId || fact.schemaVersion !== 1
      || fact.parametersHash !== digest(params) || canonicalClaimJson(fact.parameters) !== canonicalClaimJson(params)
      || fact.bindingFingerprint !== bindingFingerprint || digest(fact.binding) !== bindingFingerprint) claimRefusal('相同返修请求的调用者、完整参数或实际批次范围不同');
  return row;
}
function auditData(actorId: string, workOrderId: string, action: string, input: any, params: any, context: any, extra: any = {}) {
  return { id: newId('alog'), actorId, action, targetType: 'RepairWorkOrder', targetId: workOrderId, operationType: 'transition',
    detail: { source: 'claim', claimRepair: { schemaVersion: 1, actorId, requestId: input.clientRequestId,
      parameters: params, parametersHash: digest(params), binding: context.binding, bindingFingerprint: context.bindingFingerprint, ...extra } } };
}
export async function startClaimRepair(prisma: PrismaClient, workOrderId: string, input: RepairActionInput,
  actorId: string): Promise<ClaimResult<{ workOrder: any; repairEventId: string; batchFingerprint: string; replayed: boolean }>> {
  try {
    const params = parameters(input, ['clientRequestId', 'notes']);
    return await prisma.$transaction(async (tx: any) => {
      const context = await lockClaimRepairContext(tx, workOrderId);
      const previous = await retry(tx, workOrderId, 'CLAIM_REPAIR_STARTED', input, actorId, params, context.bindingFingerprint);
      if (previous) return { ok: true, data: { workOrder: context.workOrder, repairEventId: previous.id, batchFingerprint: context.bindingFingerprint, replayed: true } };
      if (context.workOrder.status !== 'Draft') claimRefusal('返修只允许已实际收货的 Draft 工单开工');
      const station = await tx.workStation.findUnique({ where: { id: context.workOrder.workStationId } });
      if (!station || station.deletedAt || !station.isActive) claimRefusal('实际返修工位不存在或已停用');
      const workOrder = await tx.repairWorkOrder.update({ where: { id: workOrderId }, data: { status: 'InRepair', startedAt: todayLocalKey(), updatedAt: BigInt(Date.now()) } });
      const audit = await tx.auditLog.create({ data: auditData(actorId, workOrderId, 'CLAIM_REPAIR_STARTED', input, params, context, { fromStatus: 'Draft', toStatus: 'InRepair' }) });
      return { ok: true, data: { workOrder, repairEventId: audit.id, batchFingerprint: context.bindingFingerprint, replayed: false } };
    });
  } catch (error) { if (error instanceof ClaimTransactionError) return { ok: false, error: error.claimError }; throw error; }
}
export async function completeClaimRepair(prisma: PrismaClient, workOrderId: string, input: CompleteClaimRepairInput,
  actorId: string): Promise<ClaimResult<{ workOrder: any; repairEventId: string; batchFingerprint: string; replayed: boolean }>> {
  try {
    const base = parameters(input, ['clientRequestId', 'notes', 'completedQuantity', 'unit']);
    const params = { ...base, completedQuantity: positive(input.completedQuantity, '实际修完数量'), unit: input.unit };
    return await prisma.$transaction(async (tx: any) => {
      const context = await lockClaimRepairContext(tx, workOrderId);
      const previous = await retry(tx, workOrderId, 'CLAIM_REPAIR_COMPLETED', input, actorId, params, context.bindingFingerprint);
      if (previous) return { ok: true, data: { workOrder: context.workOrder, repairEventId: previous.id, batchFingerprint: context.bindingFingerprint, replayed: true } };
      if (context.workOrder.status !== 'InRepair' || input.unit !== context.line.unit
          || !new Prisma.Decimal(params.completedQuantity).equals(context.workOrder.quantity)) claimRefusal('实际完工必须依次从 InRepair 推进，并覆盖准确批次数量和单位');
      const started = await tx.auditLog.findMany({ where: { targetType: 'RepairWorkOrder', targetId: workOrderId, action: 'CLAIM_REPAIR_STARTED' } });
      if (started.length !== 1 || started[0].detail?.claimRepair?.bindingFingerprint !== context.bindingFingerprint
          || digest(started[0].detail?.claimRepair?.binding) !== context.bindingFingerprint) claimRefusal('返修缺少准确实际批次的开工事实，日期字段不能替代');
      const workOrder = await tx.repairWorkOrder.update({ where: { id: workOrderId }, data: { status: 'Completed', completedAt: todayLocalKey(), updatedAt: BigInt(Date.now()) } });
      const audit = await tx.auditLog.create({ data: auditData(actorId, workOrderId, 'CLAIM_REPAIR_COMPLETED', input, params, context, { fromStatus: 'InRepair', toStatus: 'Completed', startedEventId: started[0].id }) });
      return { ok: true, data: { workOrder, repairEventId: audit.id, batchFingerprint: context.bindingFingerprint, replayed: false } };
    });
  } catch (error) { if (error instanceof ClaimTransactionError) return { ok: false, error: error.claimError }; throw error; }
}

export async function recordClaimRepairInspection(prisma: PrismaClient, workOrderId: string, input: ClaimRepairInspectionInput,
  actorId: string): Promise<ClaimResult<{ inspection: any; inspectionEventId: string; batchFingerprint: string; replayed: boolean }>> {
  try {
    const base = parameters(input, ['clientRequestId', 'notes', 'inspectedQuantity', 'passedQuantity', 'unit', 'result', 'inspectionDate', 'reportFile', 'defectSummary']);
    const passed = parseNonNegativeDecimal(input.passedQuantity, '实际通过数量'); if (!passed.ok) invalid(passed.message);
    if (!['pass', 'conditional', 'fail'].includes(input.result)) invalid('返修实际复检结果须为 pass/conditional/fail');
    for (const key of ['inspectionDate', 'reportFile', 'defectSummary']) if ((input as any)[key] != null && typeof (input as any)[key] !== 'string') invalid('复检日期、报告和疵点摘要须为文本');
    if (input.inspectionDate != null && (!isValidLocalDateKey(input.inspectionDate))) invalid('实际复检日期无效');
    const params = { ...base, inspectedQuantity: positive(input.inspectedQuantity, '实际复检数量'), passedQuantity: new Prisma.Decimal(passed.value).toString(),
      unit: input.unit, result: input.result, inspectionDate: input.inspectionDate ?? null, reportFile: input.reportFile ?? null, defectSummary: input.defectSummary ?? null };
    return await prisma.$transaction(async (tx: any) => {
      const context = await lockClaimRepairContext(tx, workOrderId);
      const previous = await retry(tx, workOrderId, 'CLAIM_REPAIR_INSPECTED', input, actorId, params, context.bindingFingerprint);
      if (previous) {
        const inspection = await tx.repairInspection.findUnique({ where: { id: previous.detail.claimRepair.inspectionId } });
        if (!inspection || inspection.deletedAt || inspection.inspectedBy !== actorId || inspection.repairWorkOrderId !== workOrderId
            || inspection.result !== params.result || !new Prisma.Decimal(inspection.inspectedQuantity).equals(params.inspectedQuantity)
            || !new Prisma.Decimal(inspection.passedQuantity).equals(params.passedQuantity) || inspection.unit !== params.unit
            || canonicalClaimJson(previous.detail.claimRepair.inspectionFact) !== canonicalClaimJson(inspectionSnapshot(inspection))) claimRefusal('原复检行和不可变审计不一致');
        return { ok: true, data: { inspection, inspectionEventId: previous.id, batchFingerprint: context.bindingFingerprint, replayed: true } };
      }
      if (context.workOrder.status !== 'Completed' || params.unit !== context.workOrder.unit
          || !new Prisma.Decimal(params.inspectedQuantity).equals(context.workOrder.quantity)
          || new Prisma.Decimal(params.passedQuantity).gt(params.inspectedQuantity)
          || (params.result === 'pass' && !new Prisma.Decimal(params.passedQuantity).equals(params.inspectedQuantity))) claimRefusal('复检必须针对已实际完工的准确返修批量；全部通过不能少记通过数量');
      const completed = await tx.auditLog.findMany({ where: { targetType: 'RepairWorkOrder', targetId: workOrderId, action: 'CLAIM_REPAIR_COMPLETED' } });
      if (completed.length !== 1 || completed[0].detail?.claimRepair?.bindingFingerprint !== context.bindingFingerprint
          || digest(completed[0].detail?.claimRepair?.binding) !== context.bindingFingerprint) claimRefusal('复检缺少完整实际完工事实');
      const authority = await createPermissionService({ prisma: tx }).getUserPermissionContext(actorId);
      if (!authority || !hasScope({ userId: actorId, roles: authority.legacyRoleCodes, permissions: authority.scopes, authorizationLoaded: true } as any, 'qc:write')) {
        throw Object.assign(new Error('实际质检登记人当前没有 qc:write 权限'), { code: 'INSUFFICIENT_PERMISSION', statusCode: 403 });
      }
      const inspectionNumber = await nextBusinessNumber(tx, 'IR', undefined, { occupied: async number => Boolean(await tx.repairInspection.findFirst({ where: { inspectionNumber: number }, select: { id: true } })) });
      const existing = await tx.repairInspection.findMany({ where: { repairWorkOrderId: workOrderId }, select: { createdAt: true } });
      const max = existing.reduce((value: bigint, row: any) => BigInt(row.createdAt) > value ? BigInt(row.createdAt) : value, BigInt(0));
      const now = BigInt(Date.now()) > max ? BigInt(Date.now()) : max + BigInt(1);
      const inspection = await tx.repairInspection.create({ data: { id: newId('RINS'), repairWorkOrderId: workOrderId, inspectionNumber,
        inspectedQuantity: new Prisma.Decimal(params.inspectedQuantity), passedQuantity: new Prisma.Decimal(params.passedQuantity), unit: params.unit,
        result: params.result, inspectedBy: actorId, inspectionDate: params.inspectionDate ?? todayLocalKey(), reportFile: params.reportFile,
        defectSummary: params.defectSummary, notes: params.notes, createdAt: now, updatedAt: now } });
      const audit = await tx.auditLog.create({ data: auditData(actorId, workOrderId, 'CLAIM_REPAIR_INSPECTED', input, params, context,
        { inspectionId: inspection.id, completedEventId: completed[0].id,
          qualityActorAuthority: { userId: actorId, roleIds: authority.roleIds, scopes: authority.scopes,
            authorizationLoaded: true, requiredScope: 'qc:write', allowed: true },
          inspectionFact: inspectionSnapshot(inspection) }) });
      return { ok: true, data: { inspection, inspectionEventId: audit.id, batchFingerprint: context.bindingFingerprint, replayed: false } };
    });
  } catch (error) { if (error instanceof ClaimTransactionError) return { ok: false, error: error.claimError }; throw error; }
}

/** Historical QC authority is consumed as an immutable fact, not replaced by current role labels. */
export async function readClaimRepairReleaseFact(tx: any, context: Awaited<ReturnType<typeof lockClaimRepairContext>>) {
  if (context.workOrder.status !== 'Completed') claimRefusal('返修尚未实际完工，不可返还');
  const completed = await tx.auditLog.findMany({ where: { targetType: 'RepairWorkOrder', targetId: context.workOrder.id, action: 'CLAIM_REPAIR_COMPLETED' } });
  if (completed.length !== 1 || completed[0].detail?.claimRepair?.bindingFingerprint !== context.bindingFingerprint
      || digest(completed[0].detail?.claimRepair?.binding) !== context.bindingFingerprint) claimRefusal('缺少准确实际完工事实');
  if (!context.workOrder.needsReinspection) return { completedEventId: completed[0].id, inspectionId: null, inspectionEventId: null };
  const reports = await tx.repairInspection.findMany({ where: { repairWorkOrderId: context.workOrder.id, deletedAt: null } });
  reports.sort((a: any, b: any) => BigInt(a.createdAt) < BigInt(b.createdAt) ? 1 : BigInt(a.createdAt) > BigInt(b.createdAt) ? -1 : 0);
  const report = reports[0];
  if (!report || (reports[1] && String(reports[1].createdAt) === String(report.createdAt)) || report.result !== 'pass'
      || report.unit !== context.workOrder.unit || !new Prisma.Decimal(report.inspectedQuantity).equals(context.workOrder.quantity)
      || !new Prisma.Decimal(report.passedQuantity).equals(context.workOrder.quantity)) claimRefusal('返修需真实复检；当前完整批次未全部通过，不能选历史通过报告');
  const audits = await tx.auditLog.findMany({ where: { targetType: 'RepairWorkOrder', targetId: context.workOrder.id, action: 'CLAIM_REPAIR_INSPECTED', actorId: report.inspectedBy } });
  const matching = audits.filter((row: any) => {
    const fact = row.detail?.claimRepair, authority = fact?.qualityActorAuthority;
    return fact?.inspectionId === report.id && fact.bindingFingerprint === context.bindingFingerprint
      && digest(fact.binding) === context.bindingFingerprint && authority?.userId === report.inspectedBy
      && authority.authorizationLoaded === true && authority.requiredScope === 'qc:write' && authority.allowed === true
      && Array.isArray(authority.roleIds) && Array.isArray(authority.scopes)
      && hasScope({ userId: authority.userId, roles: authority.roleIds.map(legacyAgentRoleForId).filter(Boolean),
        permissions: authority.scopes, authorizationLoaded: true } as any, 'qc:write')
      && fact.parametersHash === digest(fact.parameters)
      && canonicalClaimJson(fact.inspectionFact) === canonicalClaimJson(inspectionSnapshot(report));
  });
  if (matching.length !== 1) claimRefusal('当前复检缺少唯一完整批次和真实质检权威审计');
  return { completedEventId: completed[0].id, inspectionId: report.id, inspectionEventId: matching[0].id };
}
