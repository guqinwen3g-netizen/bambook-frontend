import { Prisma } from '@prisma/client';
import { readDevelopmentExpenseSnapshot } from './developmentExpenseSnapshot';
import { ciConflict, ciHash, developmentCiCaseWhere, developmentCiSnapshot } from './developmentCiSource';

export const SUPPLEMENTAL_BILLING_ACTION = 'create_development_supplemental_billing';
export const supplementalBillingAuditId = (caseId: string, actorId: string, requestKey: string) => `devcis_${ciHash([caseId, actorId, requestKey])}`;
export const developmentCostTotals = (records: any[]) => {
  const totals = new Map<string, Prisma.Decimal>();
  for (const record of records) totals.set(record.currency, (totals.get(record.currency) ?? new Prisma.Decimal(0)).plus(record.amount));
  return [...totals.keys()].sort().map(currency => ({ currency, amount: totals.get(currency)!.toFixed(4) }));
};

/** Immutable issued snapshots remain occupied even if a legacy writer releases coverage rows. */
export async function readDevelopmentUncoveredCostsInTx(tx: any, caseId: string, customerRelationId: string) {
  const expenses = await readDevelopmentExpenseSnapshot(tx, caseId);
  if (expenses.unresolvedProductionExpenses.length || expenses.unsupportedCurrencies.length)
    ciConflict('本案费用归属或币种尚未核清，请先核对实际费用。');
  return readDevelopmentCostAvailabilityInTx(tx, caseId, customerRelationId, expenses.records);
}

/** Occupancy is shared; only the legacy full-case caller imposes full-case expense completion. */
export async function readDevelopmentCostAvailabilityInTx(tx: any, caseId: string, customerRelationId: string, records: any[]) {
  const documents = await tx.tradeDocument.findMany({ where: { ...developmentCiCaseWhere(caseId), status: 'Issued', deletedAt: null }, orderBy: { id: 'asc' } });
  const issued: any[] = [], immutableCosts = new Set<string>();
  for (const document of documents) {
    const version = await tx.documentVersion.findFirst({ where: { documentId: document.id }, orderBy: { version: 'desc' } });
    const snapshot = developmentCiSnapshot(version, document);
    if (snapshot.caseId !== caseId || snapshot.customerRelationId !== customerRelationId || !snapshot.issuedAt)
      ciConflict('本案已签发原票的客户或来源无法核验。');
    for (const cost of snapshot.costs) immutableCosts.add(cost.id);
    issued.push({ documentId: document.id, versionId: version.id, snapshotFingerprint: snapshot.snapshotFingerprint });
  }
  const ids = records.map((row: any) => row.id);
  const [coverage, billings, lines] = ids.length ? await Promise.all([
    tx.billingItemCostCoverage.findMany({ where: { costRecordId: { in: ids }, releasedAt: null }, orderBy: { id: 'asc' } }),
    tx.billingItem.findMany({ where: { costRecordId: { in: ids }, deletedAt: null, status: { not: 'cancelled' } }, orderBy: { id: 'asc' } }),
    tx.invoiceLine.findMany({ where: { sourceType: 'CostRecord', sourceId: { in: ids } }, orderBy: { id: 'asc' } }),
  ]) : [[], [], []];
  const occupied = new Set<string>([...immutableCosts, ...coverage.map((row: any) => row.costRecordId),
    ...billings.map((row: any) => row.costRecordId), ...lines.map((row: any) => row.sourceId)]);
  const costs = records.filter((row: any) => !occupied.has(row.id));
  return { caseId, customerRelationId, costs, totals: developmentCostTotals(costs), occupiedCount: records.length - costs.length,
    issued, immutableCostRecordIds: [...immutableCosts].sort(), sourceFingerprint: ciHash({ caseId, customerRelationId, records, issued,
      coverage, billings: billings.map((row: any) => ({ id: row.id, costRecordId: row.costRecordId, status: row.status })),
      lines: lines.map((row: any) => ({ id: row.id, sourceId: row.sourceId, invoiceId: row.invoiceId })) }) };
}

/** Validate only the business's exact selected private costs, never turn case spend into customer price. */
export async function readDevelopmentCommercialCostSelectionInTx(tx: any, caseId: string, customerRelationId: string,
  billingId: string, costIds: string[], expenses: Awaited<ReturnType<typeof readDevelopmentExpenseSnapshot>>) {
  const costs = expenses.records.filter((row: any) => costIds.includes(row.id));
  if (costs.length !== costIds.length || costs.some((cost: any) => !['CNY', 'USD'].includes(cost.currency)))
    ciConflict('明确选中的成本归属、金额或币种尚未核清，不能使用该成本依据。');
  const available = await readDevelopmentCostAvailabilityInTx(tx, caseId, customerRelationId, costs);
  const active = await tx.billingItemCostCoverage.findMany({ where: { billingItemId: billingId, releasedAt: null }, orderBy: { costRecordId: 'asc' } });
  if (costIds.some(id => available.immutableCostRecordIds.includes(id)
    || !available.costs.some((row: any) => row.id === id) && !active.some((row: any) => row.costRecordId === id)))
    ciConflict('准确成本依据已由原签发票据或另一收费项占用。');
  const occupied = await tx.billingItemCostCoverage.findMany({ where: { costRecordId: { in: costIds }, releasedAt: null } });
  const [legacy, invoiced] = costIds.length ? await Promise.all([
    tx.billingItem.findFirst({ where: { id: { not: billingId }, costRecordId: { in: costIds }, deletedAt: null, status: { not: 'cancelled' } } }),
    tx.invoiceLine.findFirst({ where: { sourceType: 'CostRecord', sourceId: { in: costIds } } }),
  ]) : [null, null];
  if (legacy || invoiced || occupied.some((row: any) => row.billingItemId !== billingId)) ciConflict('准确成本依据已被其他收费或原票覆盖。');
  return { costs, active };
}

/** Supplemental scope is an explicit original decision, never inferred from whatever is still unbilled now. */
export async function readDevelopmentCiCostSelectionInTx(tx: any, caseId: string, billingId: string, currentRecords: any[]) {
  const audit = await tx.auditLog.findFirst({ where: { action: SUPPLEMENTAL_BILLING_ACTION, targetType: 'BillingItem', targetId: billingId } });
  if (!audit) return null;
  const selection = audit.detail?.selection, receipt = audit.detail?.receipt, command = audit.detail?.command;
  if (!selection || selection.caseId !== caseId || selection.billingItemId !== billingId || !Array.isArray(selection.costs)
    || !selection.costs.length || new Set(selection.costs.map((row: any) => row.id)).size !== selection.costs.length
    || receipt?.billingItemId !== billingId || receipt.caseId !== caseId || receipt.auditId !== audit.id
    || audit.actorId !== receipt.actorId || audit.transactionId !== receipt.requestKey
    || audit.id !== supplementalBillingAuditId(caseId, receipt.actorId, receipt.requestKey)
    || !command || ciHash(command) !== receipt.commandHash || command.requestKey !== receipt.requestKey
    || command.expectedSourceFingerprint !== receipt.expectedSourceFingerprint || !Array.isArray(command.costRecordIds)
    || ciHash(command.costRecordIds) !== ciHash(receipt.costRecordIds)
    || ciHash([...command.costRecordIds].sort()) !== ciHash(selection.costs.map((row: any) => row.id).sort())
    || !Array.isArray(selection.precedingIssued) || !selection.precedingIssued.length
    || ciHash(selection.costs) !== selection.costFingerprint) ciConflict('补充收费缺少可核验的原始费用选择。');
  const records = selection.costs.map((old: any) => {
    const current = currentRecords.find((row: any) => row.id === old.id);
    if (!current || ciHash(current) !== ciHash(old)) ciConflict('本票所选费用事实已变化，请取消原补充草稿后重新核对，不能静默替换来源。');
    return current;
  });
  const coverage = await tx.billingItemCostCoverage.findMany({ where: { billingItemId: billingId, releasedAt: null } });
  if (coverage.length !== records.length || records.some((record: any) => !coverage.some((row: any) => row.costRecordId === record.id
    && row.costCurrency === record.currency && new Prisma.Decimal(row.costAmount).eq(record.amount))))
    ciConflict('补充收费的费用预留与原始选择不一致，请核实原方案。');
  return { records, totals: developmentCostTotals(records), selectionFingerprint: selection.costFingerprint };
}
