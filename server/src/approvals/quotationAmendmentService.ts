import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { createMoqConfigService } from '../moq/moqConfigService';
import { createMoqResolutionService } from '../moq/moqResolutionService';
import { createMoqValidationService } from '../moq/moqValidationService';
import { findCurrentMoqApproval, buildActualMoqLines } from '../moq/moqApprovalBasis';
import { createPriceDeviationRuleService } from '../pricing/priceDeviationRuleService';
import { snapshotQuotationVersion } from '../quotations/quotationService';
import { ACTION_LINE_APPROVE, ACTION_TOTAL_APPROVE, buildQuotationApprovalSnapshot,
  buildQuotationSnapshot, canonicalQuotationJson, quotationApprovalSourceState, readQuotationApprovalState } from '../quotations/quotationApprovalSnapshot';
import { approvalReviewContentVersion } from './approvalReviewContent';
import { assertCurrentApprovalSignDocumentSnapshot, buildQuotationApprovalSignDocumentSnapshot,
  getApprovalSignDocumentSnapshot, type ApprovalSignDocumentSnapshot } from './approvalSignDocumentSnapshotService';
import { todayLocalKey, isValidLocalDateKey } from '../shared/localDate';


const APPROVAL_ACTIONS = new Set([ACTION_LINE_APPROVE, ACTION_TOTAL_APPROVE]);
const asObject = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, any> : {};
const id = () => `alog_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
const fingerprint = (value: unknown) => createHash('sha256').update(canonicalQuotationJson(value)).digest('hex');

export interface QuotationLineUnitPriceChange { lineId: string; unitPrice: string | number }
export interface QuotationApprovalAmendment {
  lineUnitPrices?: QuotationLineUnitPriceChange[];
  validUntil?: string | null;
  notes?: string | null;
  reason: string;
  previewVersion?: string;
  finalContentVersion?: string;
}

export interface QuotationAmendmentPreview {
  approvalId: string;
  actionType: string;
  targetType: string;
  targetId: string;
  sourceVersion: number;
  sourceFingerprint: string;
  finalVersion: number;
  finalContentVersion: string;
  previewVersion: string;
  diff: Array<{ field: string; before: unknown; after: unknown }>;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  priceRuleLevel: string;
  priceRuleFindings: unknown;
  moq: { ok: boolean; basisHash: string; currentApprovalId: string | null };
  /** Internal compare value; the previewVersion binds it to the reviewed final document. */
  finalDocumentSnapshot?: ApprovalSignDocumentSnapshot;
}

function error(code: string, message: string, statusCode = 409): never {
  throw Object.assign(new Error(message), { code, statusCode });
}

function amount(value: unknown, label: string): Prisma.Decimal {
  let parsed: Prisma.Decimal;
  try { parsed = new Prisma.Decimal(String(value)); } catch { return error('VALIDATION_FAILED', `${label}不是有效数字`, 400); }
  if (!parsed.isFinite() || parsed.lt(0) || !parsed.eq(parsed.toDecimalPlaces(4)) || parsed.gte('100000000000000'))
    return error('VALIDATION_FAILED', `${label}必须是非负且最多四位小数的有效金额`, 400);
  return parsed;
}

function validateDate(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return error('VALIDATION_FAILED', '有效期必须是 YYYY-MM-DD 或空值', 400);
  if (!isValidLocalDateKey(value))
    return error('VALIDATION_FAILED', '有效期不是有效日期', 400);
  if (value < todayLocalKey()) return error('VALIDATION_FAILED', '有效期不能早于今天', 400);
  return value;
}

function validateNotes(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 4000)
    return error('VALIDATION_FAILED', '报价备注必须是文本，且不超过 4000 字', 400);
  return value;
}

function verifyApprovalSnapshot(approval: any, quotation: any) {
  if (!approval || approval.status !== 'pending' || !APPROVAL_ACTIONS.has(approval.actionType)
    || !quotation || quotation.deletedAt != null || quotation.status !== 'Draft')
    return error('QUOTATION_AMENDMENT_NOT_ALLOWED', '仅 Draft 报价的待审条目/总价审批可修订并批准');
  if ((approval.actionType === ACTION_LINE_APPROVE && approval.targetType !== 'QuotationLine')
    || (approval.actionType === ACTION_TOTAL_APPROVE && approval.targetType !== 'Quotation')
    || approval.targetId == null || (approval.actionType === ACTION_TOTAL_APPROVE && approval.targetId !== quotation.id))
    return error('QUOTATION_APPROVAL_UNVERIFIED', '审批动作与报价目标不匹配');
  if (asObject(approval.payload).quotationId !== quotation.id
    || quotationApprovalSourceState(approval, quotation) !== 'current')
    return error('QUOTATION_APPROVAL_UNVERIFIED', '历史审批缺少完整报价依据或来源版本已变化，不能沿用本次批准');
  if (approvalReviewContentVersion(approval) == null) return error('QUOTATION_APPROVAL_UNVERIFIED', '审批内容版本不可核验');
}

function lineMaps(quotation: any) {
  if (!Array.isArray(quotation.lines) || quotation.lines.length === 0)
    return error('QUOTATION_APPROVAL_UNVERIFIED', '报价缺少可核验条目');
  return new Map(quotation.lines.map((line: any) => [line.id, line]));
}

function finalQuotationAfter(quotation: any, amendment: QuotationApprovalAmendment) {
  const updates = Array.isArray(amendment.lineUnitPrices) ? amendment.lineUnitPrices : [];
  const lines = quotation.lines.map((line: any) => {
    const change = updates.find(candidate => candidate.lineId === line.id);
    if (!change) return line;
    const unitPrice = amount(change.unitPrice, '修订单价');
    return { ...line, unitPrice, amount: new Prisma.Decimal(String(line.quantity)).mul(unitPrice).toDecimalPlaces(4) };
  });
  return { ...quotation, version: quotation.version + 1,
    validUntil: amendment.validUntil === undefined ? quotation.validUntil : validateDate(amendment.validUntil),
    notes: amendment.notes === undefined ? quotation.notes : validateNotes(amendment.notes),
    lines, totalAmount: lines.reduce((sum: Prisma.Decimal, line: any) => sum.add(line.amount), new Prisma.Decimal(0)) };
}

function makePlan(approval: any, quotation: any, amendment: QuotationApprovalAmendment,
  priceRule: any, moq: any, currentMoqApprovalId: string | null): QuotationAmendmentPreview {
  verifyApprovalSnapshot(approval, quotation);
  const requestReason = typeof amendment?.reason === 'string' ? amendment.reason.trim() : '';
  if (requestReason.length < 10 || requestReason.length > 1000)
    return error('VALIDATION_FAILED', '修订理由至少 10 字且不超过 1000 字', 400);
  const linesById = lineMaps(quotation);
  const updates = Array.isArray(amendment.lineUnitPrices) ? amendment.lineUnitPrices : [];
  const seen = new Set<string>();
  if (updates.length > quotation.lines.length) return error('VALIDATION_FAILED', '单次报价修订行数超出当前条目数', 400);
  for (const update of updates) {
    if (!update || typeof update.lineId !== 'string' || seen.has(update.lineId))
      return error('VALIDATION_FAILED', '修订条目必须使用唯一的现有报价行编号', 400);
    seen.add(update.lineId);
    if (!linesById.has(update.lineId)) return error('QUOTATION_APPROVAL_UNVERIFIED', '修订条目不属于当前报价');
    if (approval.actionType === ACTION_LINE_APPROVE && update.lineId !== approval.targetId)
      return error('QUOTATION_AMENDMENT_SCOPE_DENIED', '条目审批只能修订本审批目标对应的报价行', 403);
  }
  if (amendment.validUntil !== undefined) validateDate(amendment.validUntil);
  if (amendment.notes !== undefined) validateNotes(amendment.notes);

  const beforeLines = quotation.lines.map((line: any) => ({ ...line }));
  const after = finalQuotationAfter(quotation, amendment);
  const afterLines = after.lines;
  const diff: QuotationAmendmentPreview['diff'] = [];
  for (const line of afterLines) {
    const old = linesById.get(line.id) as any;
    if (new Prisma.Decimal(String(old.unitPrice)).eq(line.unitPrice)) continue;
    diff.push({ field: `lines.${line.id}.unitPrice`, before: String(old.unitPrice), after: line.unitPrice.toFixed(4) });
    diff.push({ field: `lines.${line.id}.amount`, before: String(old.amount), after: line.amount.toFixed(4) });
  }
  if (String(quotation.validUntil ?? '') !== String(after.validUntil ?? ''))
    diff.push({ field: 'validUntil', before: quotation.validUntil ?? null, after: after.validUntil ?? null });
  if (String(quotation.notes ?? '') !== String(after.notes ?? ''))
    diff.push({ field: 'notes', before: quotation.notes ?? null, after: after.notes ?? null });
  if (!diff.length) return error('VALIDATION_FAILED', '修订内容与当前报价完全相同');

  // Re-run the independent price policy against the proposed final lines. A block-level
  // finding remains a separate price-deviation decision and cannot be consumed here.
  if (priceRule?.level === 'block') return error('PRICE_DEVIATION_BLOCKED', '修订后触发独立价格红线；需先走 price-deviation 审批');
  if (updates.length && quotation.priceDeviationLevel === 'block')
    return error('PRICE_DEVIATION_BLOCKED', '当前报价存在独立价格红线；修价必须重新完成 price-deviation 审批');
  if (!moq || !Array.isArray(moq.lines) || moq.lines.some((line: any) => line.unresolvedReason))
    return error('MOQ_SOURCE_UNAVAILABLE', '报价 MOQ 依据无法重新核验，不能确认修订');
  if (!moq.ok && !currentMoqApprovalId)
    return error('MOQ_APPROVAL_REQUIRED', '当前报价未满足 MOQ 且没有可核验的有效豁免审批');

  const original = buildQuotationSnapshot(quotation);
  const finalSnapshot = buildQuotationSnapshot(after);
  const sourceFingerprint = asObject(approval.payload).contentFingerprint;
  const finalContentVersion = fingerprint(finalSnapshot);
  const before = { version: quotation.version, validUntil: quotation.validUntil ?? null, notes: quotation.notes ?? null,
    totalAmount: String(quotation.totalAmount), lines: beforeLines.map((line: any) => ({ id: line.id,
      lineNumber: line.lineNumber, unitPrice: String(line.unitPrice), amount: String(line.amount) })) };
  const afterView = { version: after.version, validUntil: after.validUntil ?? null, notes: after.notes ?? null,
    totalAmount: after.totalAmount.toFixed(4), lines: afterLines.map((line: any) => ({ id: line.id,
      lineNumber: line.lineNumber, unitPrice: new Prisma.Decimal(String(line.unitPrice)).toFixed(4), amount: new Prisma.Decimal(String(line.amount)).toFixed(4) })) };
  const core = { approvalId: approval.id, actionType: approval.actionType, targetType: approval.targetType,
    targetId: approval.targetId, sourceVersion: quotation.version, sourceFingerprint, finalVersion: after.version,
    finalContentVersion, diff, before, after: afterView, priceRuleLevel: priceRule?.level ?? 'unknown',
    priceRuleFindings: priceRule?.findings ?? null,
    moq: { ok: Boolean(moq.ok), basisHash: String(moq.basisHash ?? ''), currentApprovalId: currentMoqApprovalId } };
  const previewVersion = fingerprint({ ...core, finalSnapshot, reason: requestReason,
    sourceSnapshot: original, amendment: { lineUnitPrices: updates.map(row => ({ lineId: row.lineId, unitPrice: String(row.unitPrice) })),
      validUntil: amendment.validUntil, notes: amendment.notes } });
  return { ...core, previewVersion };
}

export function createQuotationApprovalAmendmentService(opts: { prisma: PrismaClient }) {
  const db = opts.prisma as any;

  async function loadPlan(client: any, approval: any, amendment: QuotationApprovalAmendment, reviewVersion: string) {
    if (!reviewVersion || reviewVersion !== approvalReviewContentVersion(approval))
      return error('APPROVAL_CONTENT_CHANGED', '审批依据已变化，请重新加载并核对最终版本');
    const quotationId = asObject(approval.payload).quotationId;
    if (typeof quotationId !== 'string' || !quotationId) return error('QUOTATION_APPROVAL_UNVERIFIED', '审批缺少精确报价来源');
    const quotation = await client.quotation.findUnique({ where: { id: quotationId }, include: { lines: { orderBy: { lineNumber: 'asc' } } } });
    if (!quotation) return error('SOURCE_CHANGED', '报价来源已不存在');
    verifyApprovalSnapshot(approval, quotation);
    const frozenDocument = approval.actionType === ACTION_TOTAL_APPROVE ? getApprovalSignDocumentSnapshot(approval) : null;
    if (approval.actionType === ACTION_TOTAL_APPROVE) {
      if (!frozenDocument) return error('APPROVAL_CONTENT_CHANGED', '本次总价审批缺少完整冻结报价文件，请重新申请');
      try { await assertCurrentApprovalSignDocumentSnapshot(client, approval); }
      catch { return error('APPROVAL_CONTENT_CHANGED', '报价条款、卖方档案或模板已变化，请重新申请后再修订'); }
    }
    const finalLines = quotation.lines.map((line: any) => {
      const update = (amendment.lineUnitPrices ?? []).find(row => row.lineId === line.id);
      return { fabricCode: line.fabricCode ?? null, unitPrice: update ? amount(update.unitPrice, '修订单价').toNumber() : Number(line.unitPrice), unit: line.unit };
    });
    const priceRule = await createPriceDeviationRuleService(client as PrismaClient).evaluateQuotationRules({
      customerRelationId: quotation.customerRelationId ?? null, currency: quotation.currency,
      exchangeRate: quotation.exchangeRate == null ? null : Number(quotation.exchangeRate), lines: finalLines,
    });
    const configService = createMoqConfigService({ prisma: client as PrismaClient });
    const resolutionService = createMoqResolutionService({ prisma: client as PrismaClient, configService });
    const moqService = createMoqValidationService({ prisma: client as PrismaClient, configService, resolutionService });
    const actualLines = await buildActualMoqLines(client, quotation.lines);
    const moq = await moqService.validateCreate({ customerRelationId: quotation.customerRelationId ?? null,
      snapshot: quotation.moqSnapshot, lines: actualLines });
    const currentMoqApprovalId = moq.ok ? null : await findCurrentMoqApproval(client, 'Quotation', quotation.id, moq);
    const plan = makePlan(approval, quotation, amendment, priceRule, moq, currentMoqApprovalId);
    if (approval.actionType === ACTION_TOTAL_APPROVE) {
      const finalQuotation = finalQuotationAfter(quotation, amendment);
      const finalDocumentSnapshot = await buildQuotationApprovalSignDocumentSnapshot(client, finalQuotation);
      if (!frozenDocument || finalDocumentSnapshot.templateVersion !== frozenDocument.templateVersion
        || canonicalQuotationJson(finalDocumentSnapshot.exporterProfileSource) !== canonicalQuotationJson(frozenDocument.exporterProfileSource)
        || canonicalQuotationJson(finalDocumentSnapshot.exporterProfile) !== canonicalQuotationJson(frozenDocument.exporterProfile))
        return error('APPROVAL_CONTENT_CHANGED', '卖方档案或报价模板已变化，请重新申请后再修订');
      plan.finalDocumentSnapshot = finalDocumentSnapshot;
      plan.previewVersion = fingerprint({ priorPreviewVersion: plan.previewVersion,
        finalDocumentFingerprint: finalDocumentSnapshot.contentFingerprint });
    }
    return { quotation, plan };
  }

  async function preview(input: { approvalId: string; actorId: string; reviewContentVersion: string; amendment: QuotationApprovalAmendment }) {
    const approval = await db.approvalRequest.findUnique({ where: { id: input.approvalId } });
    if (!approval) return error('NOT_FOUND', '审批单不存在', 404);
    if (approval.requesterId === input.actorId || approval.reviewerId !== input.actorId)
      return error('APPROVAL_NOT_ASSIGNED', '仅当前审批人本人可预览并提出本次报价修订', 403);
    const { plan } = await loadPlan(db, approval, input.amendment, input.reviewContentVersion);
    // The full final document can include embedded quotation images. The reviewer
    // already has the frozen original and receives the edited business-field diff;
    // keep the final snapshot server-side and bind it through previewVersion.
    const { finalDocumentSnapshot: _internalSnapshot, ...publicPlan } = plan;
    return publicPlan;
  }

  async function applyInTransaction(tx: any, approval: any, actorId: string, amendment: QuotationApprovalAmendment,
    reviewVersion: string) {
    if (approval.status !== 'pending' || approval.requesterId === actorId || approval.reviewerId !== actorId)
      return error('APPROVAL_NOT_ASSIGNED', '仅当前审批人本人可修订并批准此报价申请', 403);
    const { quotation, plan } = await loadPlan(tx, approval, amendment, reviewVersion);
    if (!amendment.previewVersion || amendment.previewVersion !== plan.previewVersion
      || !amendment.finalContentVersion || amendment.finalContentVersion !== plan.finalContentVersion)
      return error('QUOTATION_AMENDMENT_PREVIEW_STALE', '报价修订预览已变化，请重新预览并核对后确认');
    if (quotation.status !== 'Draft') return error('QUOTATION_AMENDMENT_NOT_ALLOWED', '报价状态已变化，仅 Draft 可修订');

    // Old quote versions remain append-only and are written in the same transaction
    // as the final quotation update and the approval decision fact.
    await snapshotQuotationVersion(tx, quotation, actorId, amendment.reason.trim());
    const changes = amendment.lineUnitPrices ?? [];
    for (const update of changes) {
      const line = quotation.lines.find((row: any) => row.id === update.lineId);
      if (!line) return error('SOURCE_CHANGED', '修订报价行已变化');
      const unitPrice = amount(update.unitPrice, '修订单价');
      const lineAmount = new Prisma.Decimal(String(line.quantity)).mul(unitPrice).toDecimalPlaces(4);
      const changed = await tx.quotationLine.updateMany({ where: { id: line.id, quotationId: quotation.id },
        data: { unitPrice, amount: lineAmount } });
      if (changed.count !== 1) return error('SOURCE_CHANGED', '修订报价行已变化，请重新读取');
    }
    const finalLines = quotation.lines.map((line: any) => {
      const change = changes.find(row => row.lineId === line.id);
      return change ? { ...line, unitPrice: amount(change.unitPrice, '修订单价'),
        amount: new Prisma.Decimal(String(line.quantity)).mul(amount(change.unitPrice, '修订单价')).toDecimalPlaces(4) } : line;
    });
    const totalAmount = finalLines.reduce((sum: Prisma.Decimal, line: any) => sum.add(line.amount), new Prisma.Decimal(0));
    const quoteChange = await tx.quotation.updateMany({ where: { id: quotation.id, version: quotation.version,
      status: 'Draft', deletedAt: null }, data: {
      version: plan.finalVersion, totalAmount,
      validUntil: amendment.validUntil === undefined ? quotation.validUntil : validateDate(amendment.validUntil),
      notes: amendment.notes === undefined ? quotation.notes : validateNotes(amendment.notes),
      // A price-deviation approval is frozen to the old prices. Price edits clear
      // the shortcut link; they never inherit an old independent approval.
      ...(changes.length ? { priceApprovalId: null } : {}), updatedAt: Date.now(),
    } });
    if (quoteChange.count !== 1) return error('SOURCE_CHANGED', '报价版本已变化，请重新预览');
    const finalQuotation = { ...quotation, version: plan.finalVersion, totalAmount,
      validUntil: amendment.validUntil === undefined ? quotation.validUntil : validateDate(amendment.validUntil),
      notes: amendment.notes === undefined ? quotation.notes : validateNotes(amendment.notes), lines: finalLines };
    const finalSnapshot = buildQuotationApprovalSnapshot(finalQuotation, approval.actionType, approval.targetId).quotationSnapshot;
    const finalFingerprint = fingerprint(finalSnapshot);
    let finalDocumentSnapshot: ApprovalSignDocumentSnapshot | null = null;
    if (approval.actionType === ACTION_TOTAL_APPROVE) {
      const persistedQuotation = await tx.quotation.findUnique({ where: { id: quotation.id },
        include: { lines: { orderBy: [{ lineNumber: 'asc' }, { id: 'asc' }] } } });
      if (!persistedQuotation || persistedQuotation.version !== plan.finalVersion)
        return error('SOURCE_CHANGED', '修订后报价未能读取为最终版本');
      finalDocumentSnapshot = await buildQuotationApprovalSignDocumentSnapshot(tx, persistedQuotation);
      if (!plan.finalDocumentSnapshot || finalDocumentSnapshot.contentFingerprint !== plan.finalDocumentSnapshot.contentFingerprint)
        return error('QUOTATION_AMENDMENT_PREVIEW_STALE', '报价单据、卖方档案或模板与最终预览不一致，请重新预览');
    }
    const audit = { id: id(), actorId, action: 'quotation_approval_amended', targetType: 'ApprovalRequest', targetId: approval.id,
      detail: { schemaVersion: 1, approvalId: approval.id, quotationId: quotation.id, requesterId: approval.requesterId,
        decisionActorId: actorId, sourceVersion: quotation.version, sourceFingerprint: plan.sourceFingerprint,
        finalVersion: plan.finalVersion, finalContentVersion: plan.finalContentVersion, finalFingerprint,
        previewVersion: plan.previewVersion, reason: amendment.reason.trim(), diff: plan.diff, finalSnapshot,
        ...(finalDocumentSnapshot ? { finalDocumentSnapshot } : {}) },
      operationType: 'transition', fieldPath: 'quotation', beforeValue: plan.sourceFingerprint,
      afterValue: plan.finalContentVersion, transactionId: null };
    await tx.auditLog.create({ data: audit });
    return { amendmentAuditId: audit.id, approvalId: approval.id, quotationId: quotation.id, sourceVersion: quotation.version,
      finalVersion: plan.finalVersion, sourceFingerprint: plan.sourceFingerprint,
      finalContentVersion: plan.finalContentVersion, finalFingerprint, reason: amendment.reason.trim(), diff: plan.diff,
      ...(finalDocumentSnapshot ? { finalDocumentFingerprint: finalDocumentSnapshot.contentFingerprint,
        finalDocumentKind: finalDocumentSnapshot.kind, finalDocumentSnapshot: {
          kind: finalDocumentSnapshot.kind, sourceRef: finalDocumentSnapshot.sourceRef,
          templateVersion: finalDocumentSnapshot.templateVersion, sourceFingerprint: finalDocumentSnapshot.sourceFingerprint,
          contentFingerprint: finalDocumentSnapshot.contentFingerprint,
        } } : {}),
      priceApprovalInvalidated: changes.length > 0, businessSyncStatus: 'completed' as const };
  }

  async function readResult(input: { approvalId: string; actorId: string; roles?: string[] }) {
    const approval = await db.approvalRequest.findUnique({ where: { id: input.approvalId } });
    if (!approval) return error('NOT_FOUND', '审批单不存在', 404);
    const canRead = approval.requesterId === input.actorId || approval.reviewerId === input.actorId
      || (input.roles ?? []).includes('owner') && approval.bossFinalBypassBy === input.actorId;
    if (!canRead) return error('NOT_FOUND', '审批单不存在或无权查看', 404);
    const audit = await db.auditLog.findFirst({ where: { action: 'quotation_approval_amended',
      targetType: 'ApprovalRequest', targetId: approval.id }, orderBy: { createdAt: 'desc' } });
    if (!audit) return { approvalId: approval.id, amended: false, currentSource: null };
    const detail = asObject(audit.detail);
    if (detail.approvalId !== approval.id || detail.quotationId !== asObject(approval.payload).quotationId
      || detail.requesterId !== approval.requesterId || !detail.finalSnapshot)
      return error('QUOTATION_APPROVAL_UNVERIFIED', '报价修订回执缺少完整审计依据');
    const quotation = await db.quotation.findUnique({ where: { id: detail.quotationId }, include: { lines: { orderBy: { lineNumber: 'asc' } } } });
    if (!quotation) return error('SOURCE_CHANGED', '报价修订记录存在，但当前报价无法读取');
    const current = buildQuotationSnapshot(quotation);
    const currentFingerprint = fingerprint(current);
    if (quotation.version !== detail.finalVersion || currentFingerprint !== detail.finalFingerprint
      || currentFingerprint !== detail.finalContentVersion
      || await readQuotationApprovalState(db, approval, quotation) !== 'approved')
      return error('QUOTATION_AMENDMENT_READBACK_MISMATCH', '报价修改回执与当前业务记录不一致，不能视为修订生效');
    return { approvalId: approval.id, amended: true, decisionStatus: approval.status,
      amendment: { sourceVersion: detail.sourceVersion, finalVersion: detail.finalVersion,
        sourceFingerprint: detail.sourceFingerprint, finalContentVersion: detail.finalContentVersion,
        finalFingerprint: detail.finalFingerprint, reason: detail.reason, diff: detail.diff },
      currentSource: { version: quotation.version, contentFingerprint: currentFingerprint,
        quotationSnapshot: current } };
  }

  return { preview, applyInTransaction, readResult };
}
