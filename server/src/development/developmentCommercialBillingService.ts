import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { businessError } from '../shared/errorCodes';
import { createBillingItemInTx } from '../finance/billingItemService';
import { readDevelopmentExpenseSnapshot } from './developmentExpenseSnapshot';
import { readDevelopmentCommercialCostSelectionInTx, readDevelopmentCostAvailabilityInTx } from './developmentCiCostSelection';
import { authorizeDevelopmentCiCase, ciConflict, ciHash, ciJson, developmentCiCaseWhere, developmentCiBillingItemIds,
  developmentCiSnapshot } from './developmentCiSource';

export type DevelopmentChargeLineInput = { id?: string; displayOrder: number; purpose: string; description: string;
  sourceType: 'DevelopmentCase' | 'DevelopmentSampleRound' | 'DevelopmentSampleVersion' | 'SampleBatch'; sourceId: string;
  roundId?: string | null; amount: string; currency: string };
type Context = { prisma: any; actor: TokenPayload | null | undefined };
const clean = (value: unknown, label: string, max = 4000) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw businessError('INVALID_INPUT', `${label}未填写或过长。`);
  return value.trim();
};
export function commercialMoney(value: unknown, label: string, positive = false) {
  if (typeof value !== 'string' && typeof value !== 'number' || !/^\d+(?:\.\d{1,4})?$/.test(String(value)))
    throw businessError('INVALID_AMOUNT', `${label}须为明确的非负金额，最多四位小数。`);
  const amount = new Prisma.Decimal(String(value));
  if (amount.gte('100000000000000') || positive && !amount.gt(0)) throw businessError('INVALID_AMOUNT', `${label}金额或范围无效。`);
  return amount.toFixed(4);
}
const idsOf = (value: unknown) => {
  if (!Array.isArray(value) || value.length > 500) throw businessError('INVALID_INPUT', '请选择准确的成本依据，可以明确不关联成本。');
  const ids = value.map(id => clean(id, '成本依据', 200)).sort();
  if (new Set(ids).size !== ids.length) throw businessError('INVALID_INPUT', '成本依据不得重复。');
  return ids;
};
const decision = (row: any) => ({ id: row.id, amount: String(row.amount), waivedAmount: String(row.waivedAmount),
  offsetAmount: String(row.offsetAmount), currency: row.currency, bearerType: row.bearerType, bearerRelationId: row.bearerRelationId,
  approvalId: row.developmentApprovalId ?? null });
export const commercialLineFact = (line: any) => ({ id: line.id, billingItemId: line.billingItemId, displayOrder: line.displayOrder,
  purpose: line.purpose, description: line.description, sourceType: line.sourceType, sourceId: line.sourceId,
  sourceLabel: line.sourceLabel, roundId: line.roundId ?? null, roundNumber: line.roundNumber ?? null, roundLabel: line.roundLabel,
  amount: new Prisma.Decimal(line.amount).toFixed(4), currency: line.currency });
export const commercialBillingFingerprint = (billing: any, lines: any[], selection: any) => ciHash({
  decision: decision(billing), chargeLines: lines.map(commercialLineFact), costSelection: selection,
});

/** Receipt identity is independent of generated line IDs and JSON property order. */
export function normalizeDevelopmentCommercialCommand(billingId: string | null, input: any) {
  const action = billingId ? input?.action : 'create', requestKey = clean(input?.requestKey, '请求标识', 200);
  if (!(billingId ? ['save', 'confirm'] : ['create']).includes(action) || billingId && (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0))
    throw businessError('INVALID_INPUT', '商业收费操作或版本无效。');
  if (billingId && ['amount', 'waivedAmount', 'offsetAmount', 'currency', 'note'].some(key => input[key] !== undefined))
    throw businessError('INVALID_INPUT', '金额或减免变更请沿原收费编辑和审批处理，商业资料保存仅确认本次明细。');
  if (action === 'confirm' && (input.chargeLines !== undefined || input.costRecordIds !== undefined))
    throw businessError('INVALID_INPUT', '确认原资料不接受替换明细，请使用明确保存操作。');
  let chargeLines: any[] | null = null;
  if (action !== 'confirm') {
    if (!Array.isArray(input.chargeLines) || !input.chargeLines.length || input.chargeLines.length > 500)
      throw businessError('INVALID_INPUT', '请明确填写客户收费明细。');
    chargeLines = input.chargeLines.map((line: any) => {
      if (!line || !Number.isSafeInteger(line.displayOrder) || line.displayOrder < 0 || !['DevelopmentCase', 'DevelopmentSampleRound', 'DevelopmentSampleVersion', 'SampleBatch'].includes(line.sourceType))
        throw businessError('INVALID_INPUT', '商业明细顺序或来源类型无效。');
      return { id: line.id == null ? null : clean(line.id, '商业明细标识', 200), displayOrder: line.displayOrder,
        purpose: clean(line.purpose, '收费用途', 400), description: clean(line.description, '商业明细'),
        sourceType: line.sourceType, sourceId: clean(line.sourceId, '收费来源', 200), roundId: line.roundId == null ? null : clean(line.roundId, '准确轮次', 200),
        amount: commercialMoney(line.amount, '客户商业净额', true), currency: clean(line.currency, '币种', 10) };
    }).sort((a: any, b: any) => a.displayOrder - b.displayOrder || (a.id ?? '').localeCompare(b.id ?? ''));
  }
  return { action, requestKey, billingItemId: billingId, expectedVersion: billingId ? input.expectedVersion : null,
    amount: billingId ? null : commercialMoney(input.amount, '拟收金额', true), waivedAmount: billingId ? null : commercialMoney(input.waivedAmount ?? '0', '减免金额'),
    currency: billingId ? null : clean(input.currency, '币种', 10), note: billingId ? null : clean(input.note, '收费依据'),
    chargeLines, costRecordIds: action === 'confirm' ? null : idsOf(input.costRecordIds ?? []) };
}

/** Labels are server-derived from real case/round/version/sample identities. */
async function resolveCommercialSource(tx: any, caseId: string, input: DevelopmentChargeLineInput) {
  const type = input.sourceType, id = clean(input.sourceId, '收费来源', 200);
  let row: any, round: any;
  if (type === 'DevelopmentCase') {
    row = await tx.developmentCase.findFirst({ where: { id, deletedAt: null } });
    if (!row || id !== caseId) ciConflict('商业收费来源不属于本案。');
    return { sourceType: type, sourceId: id, sourceLabel: row.code, roundId: null, roundNumber: null, roundLabel: '整案' };
  }
  if (type === 'DevelopmentSampleRound') {
    round = await tx.developmentSampleRound.findFirst({ where: { id, developmentCaseId: caseId, deletedAt: null } }); row = round;
  } else if (type === 'DevelopmentSampleVersion') {
    row = await tx.developmentSampleVersion.findFirst({ where: { id, developmentCaseId: caseId, deletedAt: null } });
    if (row) round = await tx.developmentSampleRound.findFirst({ where: { id: row.roundId, developmentCaseId: caseId, deletedAt: null } });
  } else if (type === 'SampleBatch') {
    row = await tx.sampleBatch.findFirst({ where: { id, developmentCaseId: caseId, deletedAt: null } });
    if (row?.sampleVersionId) {
      const version = await tx.developmentSampleVersion.findFirst({ where: { id: row.sampleVersionId, developmentCaseId: caseId, deletedAt: null } });
      if (!version) ciConflict('实物收费来源的准确版本缺失。');
      round = await tx.developmentSampleRound.findFirst({ where: { id: version.roundId, developmentCaseId: caseId, deletedAt: null } });
    }
  } else throw businessError('INVALID_INPUT', '商业收费来源类型无效。');
  if (!row || type !== 'SampleBatch' && !round || row.sampleVersionId && !round) ciConflict('商业收费的准确轮次或来源不存在。');
  const roundNumber = round?.round ?? row.round;
  if (!Number.isSafeInteger(roundNumber) || roundNumber < 1 || input.roundId && input.roundId !== round?.id)
    ciConflict('商业收费轮次与准确来源不一致。');
  return { sourceType: type, sourceId: id, sourceLabel: row.versionLabel || row.batchCode || `R${roundNumber}`,
    roundId: round?.id ?? null, roundNumber, roundLabel: `R${roundNumber}` };
}

/** All callers hold case and sorted BillingItem locks before looking for reservations. */
export async function assertDevelopmentBillingNotClaimedInTx(tx: any, caseId: string, billingIds: string[], allowedDocumentId?: string, allowedInvoiceId?: string) {
  const claims = await tx.developmentCiBillingClaim.findMany({ where: { billingItemId: { in: billingIds }, releasedAt: null }, orderBy: { id: 'asc' } });
  if (claims.some((claim: any) => claim.documentId !== allowedDocumentId)) ciConflict('收费项已被另一张开发 CI 草稿或原票占用，请继续原票或明确取消草稿。');
  // Old immutable invoices and drafts remain occupied without invented migration claims.
  const documents = await tx.tradeDocument.findMany({ where: { ...developmentCiCaseWhere(caseId), deletedAt: null,
    status: { in: ['Draft', 'Issued'] } }, orderBy: { id: 'asc' } });
  for (const document of documents) {
    if (document.id === allowedDocumentId) continue;
    const version = await tx.documentVersion.findFirst({ where: { documentId: document.id }, orderBy: { version: 'desc' } });
    const snapshot = developmentCiSnapshot(version, document);
    if (developmentCiBillingItemIds(snapshot).some(id => billingIds.includes(id))) ciConflict('收费项已由原开发 CI 占用，不能重复收费。');
  }
  const line = await tx.invoiceLine.findFirst({ where: { sourceType: 'BillingItem', sourceId: { in: billingIds },
    ...(allowedInvoiceId ? { invoiceId: { not: allowedInvoiceId } } : {}) } });
  if (line) ciConflict('收费项已有财务发票行占用，请核对原账。');
}

export async function lockDevelopmentCiDocumentsInTx(tx: any, caseId: string) {
  const documents = await tx.tradeDocument.findMany({ where: { ...developmentCiCaseWhere(caseId), deletedAt: null,
    status: { in: ['Draft', 'Issued'] } }, orderBy: { id: 'asc' } });
  for (const document of documents) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "TradeDocument" WHERE "id"=${document.id} FOR UPDATE`);
}

export async function readDevelopmentCommercialBillingInTx(tx: any, billing: any, currentCosts?: any[]) {
  const lines = await tx.developmentBillingChargeLine.findMany({ where: { billingItemId: billing.id }, orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }] });
  const selection = billing.developmentCommercialCostSelection;
  if (!lines.length || !selection || !Array.isArray(selection.costs) || selection.caseId !== billing.sourceId || selection.billingItemId !== billing.id)
    ciConflict('请由业务明确补足本收费项的用途、准确轮次和客户商业净价，不从成本猜价。');
  const total = lines.reduce((sum: Prisma.Decimal, line: any) => sum.plus(line.amount), new Prisma.Decimal(0));
  const net = new Prisma.Decimal(billing.amount).minus(billing.waivedAmount).minus(billing.offsetAmount);
  if (!net.gt(0) || !total.eq(net) || lines.some((line: any) => line.currency !== billing.currency || !new Prisma.Decimal(line.amount).gt(0))
    || new Set(lines.map((line: any) => line.id)).size !== lines.length || new Set(lines.map((line: any) => line.displayOrder)).size !== lines.length)
    ciConflict('商业收费明细净额或币种与本收费项不一致。');
  if (selection.costFingerprint !== ciHash(selection.costs) || new Set(selection.costs.map((cost: any) => cost.id)).size !== selection.costs.length)
    ciConflict('明确成本选择已损坏，请重新核对收费依据。');
  if (currentCosts && selection.costs.some((cost: any) => !currentCosts.some(row => row.id === cost.id && ciHash(row) === ciHash(cost))))
    ciConflict('本收费项明确关联的成本依据已变化，请由业务重新核对现值。');
  for (const line of lines) {
    const reference = await resolveCommercialSource(tx, billing.sourceId, line);
    if (Object.entries(reference).some(([key, value]) => (line[key] ?? null) !== value))
      ciConflict('商业明细的准确轮次或来源标签已变化，请由业务重新明确保存现值。');
  }
  const fingerprint = commercialBillingFingerprint(billing, lines, selection);
  if (!billing.developmentCommercialConfirmedAt || !billing.developmentCommercialConfirmedBy || billing.developmentCommercialFingerprint !== fingerprint)
    ciConflict('商业收费资料或金额已变化，请由业务明确确认本次明细。');
  return { lines: lines.map(commercialLineFact), costs: selection.costs, fingerprint, totalAmount: net.toFixed(4) };
}

async function saveCommercialFacts(tx: any, caseId: string, billing: any, rawLines: DevelopmentChargeLineInput[], costIds: string[], actorId: string) {
  if (!Array.isArray(rawLines) || !rawLines.length || rawLines.length > 500) throw businessError('INVALID_INPUT', '请明确填写客户收费明细。');
  const oldLines = await tx.developmentBillingChargeLine.findMany({ where: { billingItemId: billing.id } });
  const normalized: any[] = [];
  for (const input of rawLines) {
    if (!input || !Number.isSafeInteger(input.displayOrder) || input.displayOrder < 0) throw businessError('INVALID_INPUT', '商业明细顺序无效。');
    const id = input.id == null ? randomUUID() : clean(input.id, '商业明细标识', 200);
    const foreign = await tx.developmentBillingChargeLine.findUnique({ where: { id } });
    if (foreign && foreign.billingItemId !== billing.id) ciConflict('商业明细标识已属于另一收费项。');
    if (input.currency !== billing.currency) ciConflict('商业明细须使用本收费项币种。');
    normalized.push({ id, billingItemId: billing.id, displayOrder: input.displayOrder, purpose: clean(input.purpose, '收费用途', 400),
      description: clean(input.description, '商业明细'), ...await resolveCommercialSource(tx, caseId, input),
      amount: commercialMoney(input.amount, '客户商业净额', true), currency: input.currency });
  }
  normalized.sort((a, b) => a.displayOrder - b.displayOrder || a.id.localeCompare(b.id));
  if (new Set(normalized.map(line => line.id)).size !== normalized.length || new Set(normalized.map(line => line.displayOrder)).size !== normalized.length)
    throw businessError('INVALID_INPUT', '商业明细标识或顺序不得重复。');
  const net = new Prisma.Decimal(billing.amount).minus(billing.waivedAmount).minus(billing.offsetAmount);
  if (!normalized.reduce((sum, line) => sum.plus(line.amount), new Prisma.Decimal(0)).eq(net))
    ciConflict('请明确分配客户商业净价；明细合计须等于收费项原净额，不自动分摊减免或成本。');
  const oldCoverage = await tx.billingItemCostCoverage.findMany({ where: { billingItemId: billing.id, releasedAt: null } });
  const lockIds = [...new Set<string>([...costIds, ...oldCoverage.map((row: any) => row.costRecordId)])].sort();
  for (const id of lockIds) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "CostRecord" WHERE "id"=${id} FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCiBillingClaim" WHERE "billingItemId"=${billing.id} ORDER BY "id" FOR UPDATE`);
  const linkedDocs = await tx.tradeDocument.findMany({ where: { ...developmentCiCaseWhere(caseId), status: { in: ['Draft', 'Issued'] }, deletedAt: null }, orderBy: { id: 'asc' } });
  for (const document of linkedDocs) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "TradeDocument" WHERE "id"=${document.id} FOR UPDATE`);
  const lockedBilling = await tx.billingItem.findFirst({ where: { id: billing.id, deletedAt: null } });
  if (!lockedBilling || ciHash(lockedBilling) !== ciHash(billing)) ciConflict('收费项在取得锁时变化，请重新读取本次资料。');
  const claims = await tx.developmentCiBillingClaim.findMany({ where: { billingItemId: billing.id, releasedAt: null } });
  if (claims.some((claim: any) => claim.issuedVersionId)) ciConflict('已签发商业资料不可覆盖。');
  for (const document of linkedDocs) {
    const current = await tx.tradeDocument.findFirst({ where: { id: document.id, deletedAt: null } });
    const version = await tx.documentVersion.findFirst({ where: { documentId: document.id }, orderBy: { version: 'desc' } });
    if (current?.status === 'Issued' && developmentCiBillingItemIds(developmentCiSnapshot(version, current)).includes(billing.id)) ciConflict('旧签发原票的商业资料不可覆盖。');
  }
  const expenses = await readDevelopmentExpenseSnapshot(tx, caseId, { commercialSelection: true });
  const { costs, active } = await readDevelopmentCommercialCostSelectionInTx(tx, caseId, billing.bearerRelationId, billing.id, costIds, expenses);
  if (billing.developmentExpenseReviewId && ciHash(active.map((row: any) => row.costRecordId).sort()) !== ciHash(costIds))
    ciConflict('原费用核齐覆盖须独立保留，请明确使用原成本成员，不通过商业资料修改费用核齐范围。');
  const now = BigInt(Date.now());
  const removed = active.filter((row: any) => !costIds.includes(row.costRecordId));
  if (removed.length) await tx.billingItemCostCoverage.updateMany({ where: { id: { in: removed.map((row: any) => row.id) }, releasedAt: null }, data: { releasedAt: now, releaseReason: '业务明确调整商业收费的成本依据' } });
  for (const cost of costs) if (!active.some((row: any) => row.costRecordId === cost.id)) await tx.billingItemCostCoverage.create({ data: {
    id: randomUUID(), billingItemId: billing.id, costRecordId: cost.id, costAmount: new Prisma.Decimal(cost.amount), costCurrency: cost.currency,
    submissionVersion: billing.developmentWorkflowVersion + 1, createdAt: now,
  } });
  // Replace transactionally so changing display order cannot collide with the old ordering.
  await tx.developmentBillingChargeLine.deleteMany({ where: { billingItemId: billing.id } });
  for (const line of normalized) await tx.developmentBillingChargeLine.create({ data: { ...line, amount: new Prisma.Decimal(line.amount),
    createdAt: oldLines.find((old: any) => old.id === line.id)?.createdAt ?? now, updatedAt: now } });
  const selection = ciJson({ caseId, billingItemId: billing.id, costs, costFingerprint: ciHash(costs) });
  const fingerprint = commercialBillingFingerprint(billing, normalized, selection);
  const saved = await tx.billingItem.update({ where: { id: billing.id }, data: { developmentCommercialCostSelection: selection,
    developmentCommercialFingerprint: fingerprint, developmentCommercialConfirmedAt: now, developmentCommercialConfirmedBy: actorId,
    ...(!billing.developmentWorkflowState ? { developmentWorkflowState: new Prisma.Decimal(billing.waivedAmount).isZero() ? 'business_ci_draft' : 'draft' } : {}),
    developmentWorkflowVersion: billing.developmentWorkflowVersion + 1, updatedAt: now } });
  return { billingItem: ciJson(saved), chargeLines: normalized, commercialFingerprint: fingerprint, costRecordIds: costIds };
}

export async function listDevelopmentCommercialBillings(context: Context, caseId: string) {
  return context.prisma.$transaction(async (tx: any) => {
    await authorizeDevelopmentCiCase(tx, context.actor, caseId, 'business-read');
    const rows = await tx.billingItem.findMany({ where: { sourceType: 'DevelopmentCase', sourceId: caseId, chargeType: 'development_fee', deletedAt: null }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] });
    const billingItems = [];
    for (const row of rows) {
      const lines = await tx.developmentBillingChargeLine.findMany({ where: { billingItemId: row.id }, orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }] });
      const claims = await tx.developmentCiBillingClaim.findMany({ where: { billingItemId: row.id, releasedAt: null } });
      billingItems.push({ ...ciJson(row), chargeLines: lines.map(commercialLineFact),
        commercialConfirmed: !!row.developmentCommercialConfirmedAt && row.developmentCommercialFingerprint === commercialBillingFingerprint(row, lines, row.developmentCommercialCostSelection),
        costRecordIds: row.developmentCommercialCostSelection?.costs?.map((cost: any) => cost.id) ?? [], activeCiClaims: ciJson(claims),
        netAmount: new Prisma.Decimal(row.amount).minus(row.waivedAmount).minus(row.offsetAmount).toFixed(4) });
    }
    await authorizeDevelopmentCiCase(tx, context.actor, caseId, 'business-read');
    return { caseId, billingItems };
  });
}

/** Authorized choices use exact real references and separately owned private cost facts. */
export async function readDevelopmentCommercialOptions(context: Context, caseId: string, billingId?: string) {
  return context.prisma.$transaction(async (tx: any) => {
    const access = await authorizeDevelopmentCiCase(tx, context.actor, caseId, 'business-read');
    if (billingId && !await tx.billingItem.findFirst({ where: { id: billingId, sourceType: 'DevelopmentCase', sourceId: caseId, deletedAt: null } }))
      ciConflict('收费项不属于本案。');
    const [rounds, versions, batches] = await Promise.all([
      tx.developmentSampleRound.findMany({ where: { developmentCaseId: caseId, deletedAt: null }, orderBy: { round: 'asc' } }),
      tx.developmentSampleVersion.findMany({ where: { developmentCaseId: caseId, deletedAt: null }, orderBy: { versionLabel: 'asc' } }),
      tx.sampleBatch.findMany({ where: { developmentCaseId: caseId, deletedAt: null }, orderBy: { batchCode: 'asc' } }),
    ]);
    const sources: any[] = [{ sourceType: 'DevelopmentCase', sourceId: caseId, sourceLabel: access.development.code, roundId: null, roundNumber: null, roundLabel: '整案' }];
    const unresolvedSources: any[] = [];
    for (const [type, rows] of [['DevelopmentSampleRound', rounds], ['DevelopmentSampleVersion', versions], ['SampleBatch', batches]] as const)
      for (const row of rows) {
        try { sources.push(await resolveCommercialSource(tx, caseId, { sourceType: type, sourceId: row.id } as DevelopmentChargeLineInput)); }
        catch (error: any) { if (error?.code !== 'CONFLICT') throw error; unresolvedSources.push({ sourceType: type, sourceId: row.id, reason: error.message }); }
      }
    const expenses = await readDevelopmentExpenseSnapshot(tx, caseId, { commercialSelection: true });
    const available = await readDevelopmentCostAvailabilityInTx(tx, caseId, access.customer.id, expenses.records);
    const own = billingId ? await tx.billingItemCostCoverage.findMany({ where: { billingItemId: billingId, releasedAt: null } }) : [];
    const selectable = new Set([...available.costs.map((row: any) => row.id), ...own.map((row: any) => row.costRecordId)]);
    const choices = [...expenses.records.map((row: any) => ({ ...row,
      unavailableReason: ['CNY', 'USD'].includes(row.currency) ? null : '该成本币种尚未支持，不能选为准确成本依据。' })),
      ...expenses.unresolvedProductionExpenses.map((row: any) => ({ ...row, sourceType: 'Sample', unavailableReason: '历史生产样成本归属尚未核清。' })),
      ...(expenses.unavailableExpenses ?? [])];
    const costs = choices.sort((a, b) => a.id.localeCompare(b.id)).map((row: any) => ({ ...row,
      selectable: !row.unavailableReason && selectable.has(row.id) && !available.immutableCostRecordIds.includes(row.id),
      selected: own.some((coverage: any) => coverage.costRecordId === row.id), immutableIssued: available.immutableCostRecordIds.includes(row.id) }));
    await authorizeDevelopmentCiCase(tx, context.actor, caseId, 'business-read');
    return ciJson({ caseId, billingItemId: billingId ?? null, sources, unresolvedSources, costs });
  });
}

/** Saving is the business's explicit confirmation of these exact commercial facts, not a new approval step. */
export async function commandDevelopmentCommercialBilling(context: Context, caseId: string, billingId: string | null, input: any) {
  const command = normalizeDevelopmentCommercialCommand(billingId, input), { action, requestKey } = command, commandHash = ciHash(command);
  return context.prisma.$transaction(async (tx: any) => {
    let access = await authorizeDevelopmentCiCase(tx, context.actor, caseId, 'business-write');
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id"=${caseId} AND "deletedAt" IS NULL FOR UPDATE`);
    if (billingId) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "BillingItem" WHERE "id"=${billingId} FOR UPDATE`);
    access = await authorizeDevelopmentCiCase(tx, context.actor, caseId, 'business-write');
    const auditId = `devcommercial_${ciHash([caseId, access.actor.userId, requestKey])}`;
    const prior = await tx.auditLog.findUnique({ where: { id: auditId } });
    if (prior) {
      const receipt = prior.detail?.receipt, result = prior.detail?.result;
      if (prior.action !== 'development_commercial_billing' || prior.actorId !== access.actor.userId || receipt?.commandHash !== commandHash
        || prior.transactionId !== requestKey || ciHash(prior.detail?.command) !== commandHash || receipt.auditId !== auditId
        || receipt.actorId !== access.actor.userId || receipt.caseId !== caseId || receipt.requestKey !== requestKey
        || receipt.billingItemId !== result?.billingItem?.id || billingId && receipt.billingItemId !== billingId
        || receipt.commercialFingerprint !== result?.commercialFingerprint || receipt.version !== result?.billingItem?.developmentWorkflowVersion
        || commercialBillingFingerprint(result.billingItem, result.chargeLines, result.billingItem.developmentCommercialCostSelection) !== receipt.commercialFingerprint)
        ciConflict('原请求已用于不同商业收费内容，请核对原回执。');
      return { ...prior.detail.result, receipt: prior.detail.receipt, replayed: true };
    }
    let billing: any;
    if (!billingId) {
      const amount = command.amount!, waivedAmount = command.waivedAmount!;
      if (!['CNY', 'USD'].includes(command.currency!) || new Prisma.Decimal(waivedAmount).gte(amount)) ciConflict('商业收费须有明确币种与正数客户净额。');
      billing = await createBillingItemInTx(tx, { actorId: access.actor.userId, trustedActor: access.actor, input: {
        sourceType: 'DevelopmentCase', sourceId: caseId, chargeType: 'development_fee', amount, waivedAmount,
        currency: command.currency!, bearerType: 'customer', bearerRelationId: access.customer.id, notes: command.note!,
      } });
      billing = await tx.billingItem.update({ where: { id: billing.id }, data: { developmentWorkflowState: new Prisma.Decimal(waivedAmount).isZero() ? 'business_ci_draft' : 'draft' } });
    } else {
      billing = await tx.billingItem.findFirst({ where: { id: billingId, sourceType: 'DevelopmentCase', sourceId: caseId, chargeType: 'development_fee', deletedAt: null } });
      if (!billing || billing.bearerType !== 'customer' || billing.bearerRelationId !== access.customer.id || billing.status === 'cancelled' || billing.invoiceId || billing.developmentWorkflowState === 'business_ci_issued')
        ciConflict('收费项不属于本案客户或已签发/取消，不能覆盖商业资料。');
      if (billing.developmentWorkflowVersion !== input.expectedVersion || ['submitted', 'approval_pending'].includes(billing.developmentWorkflowState))
        ciConflict('收费版本或审批状态已变化，请继续原处理后再补商业资料。');
      const claims = await tx.developmentCiBillingClaim.findMany({ where: { billingItemId: billingId, releasedAt: null } });
      if (claims.some((claim: any) => claim.issuedVersionId)) ciConflict('已签发商业资料不可覆盖。');
      const oldDocs = await tx.tradeDocument.findMany({ where: { ...developmentCiCaseWhere(caseId), status: 'Issued', deletedAt: null } });
      for (const doc of oldDocs) {
        const version = await tx.documentVersion.findFirst({ where: { documentId: doc.id }, orderBy: { version: 'desc' } });
        if (developmentCiBillingItemIds(developmentCiSnapshot(version, doc)).includes(billingId)) ciConflict('旧签发原票的商业资料不可覆盖。');
      }
    }
    let result: any;
    if (action === 'confirm') {
      const lines = await tx.developmentBillingChargeLine.findMany({ where: { billingItemId: billing.id }, orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }] });
      for (const line of lines) {
        const reference = await resolveCommercialSource(tx, caseId, line);
        if (Object.entries(reference).some(([key, value]) => (line[key] ?? null) !== value)) ciConflict('原商业资料的准确来源已变化，请明确保存本次资料后确认。');
      }
      result = await saveCommercialFacts(tx, caseId, billing, lines, idsOf(billing.developmentCommercialCostSelection?.costs?.map((cost: any) => cost.id) ?? []), access.actor.userId);
    } else result = await saveCommercialFacts(tx, caseId, billing, command.chargeLines!, command.costRecordIds!, access.actor.userId);
    const receipt = { operation: 'development_commercial_billing', actorId: access.actor.userId, caseId, billingItemId: billing.id,
      requestKey, commandHash, auditId, commercialFingerprint: result.commercialFingerprint, version: result.billingItem.developmentWorkflowVersion };
    await authorizeDevelopmentCiCase(tx, context.actor, caseId, 'business-write');
    await tx.auditLog.create({ data: { id: auditId, actorId: access.actor.userId, action: 'development_commercial_billing', targetType: 'BillingItem', targetId: billing.id,
      transactionId: requestKey, detail: ciJson({ command, receipt, result }) } });
    return { ...result, receipt, replayed: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }).catch((error: any) => {
    if (error?.code === 'P2002' || error?.code === 'P2034' || error?.meta?.code === '40001') ciConflict('收费或成本成员刚被另一操作更新，本次未提交，请保留原请求核对。');
    throw error;
  });
}
