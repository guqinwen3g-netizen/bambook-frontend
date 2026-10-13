import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { businessError } from '../shared/errorCodes';
import { isValidLocalDateKey, todayLocalKey } from '../shared/localDate';
import { readDevelopmentExpenseSnapshot } from './developmentExpenseSnapshot';
import { currentExporterProfileSnapshot } from '../templates/docTemplates/financeInvoice';
import { readDevelopmentCiCostSelectionInTx } from './developmentCiCostSelection';
import { commandDevelopmentCiV2, type DevelopmentCiV2Command } from './developmentBusinessCiV2Service';
import { authorizeDevelopmentCiCase, ciConflict, ciHash, ciInvisible, ciJson, developmentCiRef,
  readDevelopmentCiVersionInTx } from './developmentCiSource';

type Context = { prisma: any; actor: TokenPayload | null | undefined };
export type DevelopmentCiFields = { issueDate: string; dueDate?: string | null; paymentTerms?: string; note: string;
  billTo: { name: string; address: string }; exporter: { nameEn: string; addressEn: string; beneficiary?: string;
    bankName?: string; swiftCode?: string; bankAddress?: string; usdAccountNumber?: string } };
export type DevelopmentCiCommand = { action: 'save' | 'issue'; requestKey: string; billingItemId: string;
  documentId?: string; expectedVersion: number; expectedSourceFingerprint: string; fields?: DevelopmentCiFields };
const fail = (message: string): never => { throw businessError('INVALID_INPUT', message); };
function text(value: any, label: string, max = 4000, optional = false): string {
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.trim().length > max) return fail(`${label}未填写或过长。`);
  return value.trim();
}
export function normalizeDevelopmentCiFields(value: any): DevelopmentCiFields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('请核对开发 CI 票面资料。');
  const issueDate = text(value.issueDate, '开票日期', 10), dueDate = value.dueDate == null || value.dueDate === '' ? null : text(value.dueDate, '到期日期', 10);
  if (!isValidLocalDateKey(issueDate) || dueDate && (!isValidLocalDateKey(dueDate) || dueDate < issueDate)) return fail('开票或到期日期无效，到期日期不能早于开票日期。');
  return { issueDate, dueDate, paymentTerms: text(value.paymentTerms ?? '', '付款条件', 1000, true), note: text(value.note, '收费说明'),
    billTo: { name: text(value.billTo?.name, '客户抬头', 400), address: text(value.billTo?.address ?? '', '客户地址', 1500, true) },
    exporter: { nameEn: text(value.exporter?.nameEn, '我方抬头', 400), addressEn: text(value.exporter?.addressEn ?? '', '我方地址', 1500, true),
      ...Object.fromEntries(['beneficiary', 'bankName', 'swiftCode', 'bankAddress', 'usdAccountNumber'].map(key => [key, text(value.exporter?.[key] ?? '', '收款银行资料', 1000, true)])) } };
}

async function source(tx: any, actor: Context['actor'], caseId: string, billingItemId: string, writing: boolean) {
  const access = await authorizeDevelopmentCiCase(tx, actor, caseId, writing ? 'business-write' : 'business-read');
  const billing = await tx.billingItem.findFirst({ where: { id: billingItemId, sourceType: 'DevelopmentCase', sourceId: caseId,
    chargeType: 'development_fee', deletedAt: null } });
  if (!billing) ciInvisible();
  if (billing.status === 'cancelled' || billing.bearerType !== 'customer' || billing.bearerRelationId !== access.customer.id) ciConflict('收费来源已取消或客户与本案不一致。');
  const amount = new Prisma.Decimal(billing.amount), waived = new Prisma.Decimal(billing.waivedAmount), offset = new Prisma.Decimal(billing.offsetAmount);
  const total = amount.minus(waived).minus(offset);
  if (![amount, waived, offset, total].every(value => value.isFinite() && value.gte(0) && value.decimalPlaces() <= 4)
    || !total.gt(0) || !['CNY', 'USD'].includes(billing.currency)) ciConflict('本票须有明确、正数、最多四位小数的对客金额与币种；无应收不能伪造 CI。');
  if (!offset.isZero()) ciConflict('当前开发费抵货款尚无可核验冲抵事实，请先按原收费处理，不自动抵扣。');
  const costs = await readDevelopmentExpenseSnapshot(tx, caseId);
  if (costs.unresolvedProductionExpenses.length || costs.unsupportedCurrencies.length) ciConflict('费用归属或币种尚未核清，请核对本案实际费用。');
  const selected = await readDevelopmentCiCostSelectionInTx(tx, caseId, billing.id, costs.records);
  if (billing.developmentWorkflowState === 'business_ci_draft' && !selected) ciConflict('补充收费的原始费用选择缺失，不能退回整案推断范围。');
  const records = selected?.records ?? costs.records, totals = selected?.totals ?? costs.totals;
  const costIds = records.map((row: any) => row.id);
  const [coverage, legacy, billed] = costIds.length ? await Promise.all([
    tx.billingItemCostCoverage.findMany({ where: { costRecordId: { in: costIds }, releasedAt: null } }),
    tx.billingItem.findFirst({ where: { id: { not: billing.id }, costRecordId: { in: costIds }, deletedAt: null, status: { not: 'cancelled' } } }),
    tx.invoiceLine.findFirst({ where: { sourceType: 'CostRecord', sourceId: { in: costIds } } }),
  ]) : [[], null, null];
  if (legacy || billed || coverage.some((row: any) => row.billingItemId !== billing.id)) ciConflict('本案费用已有其他收费或票据占用，请核对原票，不能重复收费。');
  const decision = ciJson({ id: billing.id, amount, waivedAmount: waived, offsetAmount: offset, totalAmount: total,
    currency: billing.currency, bearerRelationId: billing.bearerRelationId, notes: billing.notes, status: billing.status,
    workflowState: billing.developmentWorkflowState, workflowVersion: billing.developmentWorkflowVersion, updatedAt: billing.updatedAt });
  const facts = { caseId, caseCode: access.development.code, customerRelationId: access.customer.id, decision,
    costs: records, totals, ...(selected ? { selectionFingerprint: selected.selectionFingerprint } : {}) };
  return { ...access, billing, facts, fingerprint: ciHash(facts), totalAmount: total.toFixed(4) };
}

export async function previewDevelopmentCiSource(context: Context, caseId: string, billingId: string) {
  return context.prisma.$transaction(async (tx: any) => {
    const existing = await tx.tradeDocument.findFirst({ where: { sourceRef: developmentCiRef(caseId, billingId), deletedAt: null } });
    const latest = existing ? await readDevelopmentCiVersionInTx(tx, existing.id, context.actor) : null;
    // A later supplementary fee must not make the first immutable invoice unreadable.
    if (latest?.document.status === 'Issued') return { caseId, billingItemId: billingId,
      sourceFingerprint: latest.snapshot.sourceFingerprint, totalAmount: latest.snapshot.totalAmount, currency: latest.snapshot.currency,
      costs: latest.snapshot.costs, totals: latest.snapshot.costTotals, sourceDecision: latest.snapshot.sourceDecision,
      document: latest, suggestedFields: latest.snapshot.fields };
    const current = await source(tx, context.actor, caseId, billingId, false);
    return { caseId, billingItemId: billingId, sourceFingerprint: current.fingerprint, totalAmount: current.totalAmount,
      currency: current.billing.currency, costs: current.facts.costs, totals: current.facts.totals,
      sourceDecision: current.facts.decision, document: latest,
      suggestedFields: { issueDate: todayLocalKey(), dueDate: null, paymentTerms: '', note: current.billing.notes ?? '开发费用',
        billTo: { name: current.customer.englishName || current.customer.name, address: current.customer.contactInfo || '' },
        exporter: await currentExporterProfileSnapshot(tx) } };
  });
}

/** New production uses explicit v2 commercial members. Original v1 acknowledgements remain replayable. */
export async function commandDevelopmentCi(context: Context, caseId: string, raw: DevelopmentCiCommand | DevelopmentCiV2Command) {
  if (raw && 'billingItemIds' in raw) return commandDevelopmentCiV2(context, caseId, raw);
  if (!raw || !['save', 'issue'].includes(raw.action) || !Number.isSafeInteger(raw.expectedVersion) || raw.expectedVersion < 0) return fail('开发 CI 操作或版本无效。');
  const requestKey = text(raw.requestKey, '请求标识', 200), billingId = text(raw.billingItemId, '收费来源', 200);
  const normalized = { action: raw.action, requestKey, billingItemId: billingId, expectedVersion: raw.expectedVersion,
    expectedSourceFingerprint: text(raw.expectedSourceFingerprint, '费用来源指纹', 64),
    documentId: raw.documentId == null ? null : text(raw.documentId, '原票', 200),
    fields: raw.action === 'save' ? normalizeDevelopmentCiFields(raw.fields) : null };
  return context.prisma.$transaction(async (tx: any) => {
    const access = await authorizeDevelopmentCiCase(tx, context.actor, caseId, 'business-write');
    const auditId = `devci_${ciHash([caseId, access.actor.userId, requestKey])}`;
    const previous = await tx.auditLog.findUnique({ where: { id: auditId } });
    if (!previous) ciConflict('请由业务明确补足商业明细，并选择客户收费项保存新 CI；旧单来源接口仅恢复原回执。');
    const receipt = previous.detail?.receipt;
    if (previous.actorId !== access.actor.userId || previous.action !== 'development_ci_command'
      || receipt?.caseId !== caseId || receipt.billingItemId !== billingId || receipt.commandHash !== ciHash(normalized)
      || receipt.requestKey !== requestKey || receipt.auditId !== auditId) ciConflict('原请求已用于另一操作或原回执无法核对。');
    const original = await readDevelopmentCiVersionInTx(tx, receipt.documentId, context.actor, { version: receipt.version });
    if (original.version.id !== receipt.versionId) ciConflict('原签发回执与票据版本不一致。');
    return { receipt, document: original, replayed: true };
  });
}
