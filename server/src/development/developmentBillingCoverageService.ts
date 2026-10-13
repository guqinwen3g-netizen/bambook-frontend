import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { assertDevelopmentExpenseReviewCurrentInTx } from './developmentClosureService';
import { writeRouteAuditLog } from '../audit/routeAudit';

function reject(code: string, message: string): never {
  throw Object.assign(new Error(message), { code, status: 409, httpStatus: 409, statusCode: 409 });
}
export type DevelopmentBillingContext = {
  prisma: any; actorId: string;
  authorize: (tx: any, caseId: string, billingItemId: string) => Promise<unknown>;
};
export type DevelopmentBillingBinding = { caseId: string; billingItemId: string; reviewId: string; submissionVersion?:number };
/** Atomic reusable operation: callers creating a draft can bind coverage in the same transaction. */
export async function bindDevelopmentBillingCoverageInTx(tx: any, context: DevelopmentBillingContext, input: DevelopmentBillingBinding) {
  const { caseId, billingItemId, reviewId } = input;
  if (![context.actorId, caseId, billingItemId, reviewId].every(v => typeof v === 'string' && v.trim())) reject('INVALID_INPUT', '缺少操作人、开发案、收费事项或核齐记录');
    await context.authorize(tx, caseId, billingItemId);
    const cases = await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id"=${caseId} AND "deletedAt" IS NULL FOR UPDATE`);
    if (!cases.length) reject('NOT_FOUND', '开发案不存在');
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "BillingItem" WHERE "id"=${billingItemId} FOR UPDATE`);
    await context.authorize(tx, caseId, billingItemId);
    const item = await tx.billingItem.findFirst({ where: { id: billingItemId, deletedAt: null } });
    if (!item || item.sourceType !== 'DevelopmentCase' || item.sourceId !== caseId) reject('INVALID_BILLING_SOURCE', '收费事项不属于本开发案');
    if (item.status !== 'draft') reject('BILLING_NOT_DRAFT', '只能为未确认收费草稿绑定核齐依据');
    if (item.developmentExpenseReviewId && item.developmentExpenseReviewId !== reviewId) reject('REVIEW_CONFLICT', '收费事项已有其他核齐依据，须明确撤销或调整');
    const review = await assertDevelopmentExpenseReviewCurrentInTx(tx, caseId, reviewId);
    const records = review.snapshot?.costs?.records;
    if (!Array.isArray(records) || records.some((r: any) => !r.id) || new Set(records.map((r: any) => r.id)).size !== records.length) reject('INVALID_REVIEW', '核齐费用明细异常');
    const ids = records.map((r: any) => r.id).sort();
    // Shared cost locks permit future direct/legacy billing writers to join the same protocol.
    for (const id of ids) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "CostRecord" WHERE "id"=${id} FOR UPDATE`);
    const parallel = await tx.billingItem.findFirst({ where: {
      id: { not: billingItemId }, sourceType: 'DevelopmentCase', sourceId: caseId,
      developmentExpenseReviewId: { not: null }, deletedAt: null, status: { not: 'cancelled' },
    } });
    if (parallel) reject('CASE_ALREADY_BILLED', '本案已有未取消的综合收费事项');
    const [coverage, legacy, invoice] = ids.length ? await Promise.all([
      tx.billingItemCostCoverage.findMany({ where: { costRecordId: { in: ids }, releasedAt: null } }),
      tx.billingItem.findFirst({ where: { id: { not: billingItemId }, costRecordId: { in: ids }, deletedAt: null, status: { not: 'cancelled' } } }),
      tx.invoiceLine.findFirst({ where: { sourceType: 'CostRecord', sourceId: { in: ids } } }),
    ]) : [[], null, null];
    if (legacy || invoice || coverage.some((r: any) => r.billingItemId !== billingItemId)) reject('COST_ALREADY_BILLED', '整案费用已有收费或发票占用，请先核实原记录');
    const own = await tx.billingItemCostCoverage.findMany({ where: { billingItemId, submissionVersion:input.submissionVersion??0 } });
    if (own.some((r: any) => r.releasedAt !== null || !ids.includes(r.costRecordId))) reject('COVERAGE_CONFLICT', '已有覆盖记录与当前核齐范围不同');
    if (item.developmentExpenseReviewId === reviewId && own.length === ids.length) return { billingItemId, reviewId, costCount: ids.length, recovered: true };
    const now = BigInt(Date.now());
    for (const row of records) {
      if (!own.some((r: any) => r.costRecordId === row.id)) await tx.billingItemCostCoverage.create({ data: {
        id: randomUUID(), billingItemId, costRecordId: row.id,
        costAmount: new Prisma.Decimal(row.amount), costCurrency: row.currency, createdAt: now, submissionVersion:input.submissionVersion??0,
      } });
    }
    await tx.billingItem.update({ where: { id: billingItemId }, data: { developmentExpenseReviewId: reviewId, updatedAt: now } });
    await writeRouteAuditLog({ prisma: tx, actorId: context.actorId, source: 'development:billing-coverage', operation: 'bind_development_billing_coverage',
      targetType: 'BillingItem', targetId: billingItemId, after: { caseId, reviewId, costIds: ids } });
    return { billingItemId, reviewId, costCount: ids.length, recovered: false };
}

export async function bindDevelopmentBillingCoverage(context: DevelopmentBillingContext, input: DevelopmentBillingBinding) {
  return context.prisma.$transaction((tx: any) => bindDevelopmentBillingCoverageInTx(tx, context, input));
}

/** Caller owns case and billing locks for the entire consuming write transaction. */
export async function assertDevelopmentBillingCoverageCurrentInTx(tx: any, item: any) {
  if (item.sourceType !== 'DevelopmentCase' || !item.developmentExpenseReviewId) reject('INVALID_BILLING_SOURCE', '缺少本案核齐依据');
  const review = await assertDevelopmentExpenseReviewCurrentInTx(tx, item.sourceId, item.developmentExpenseReviewId);
  const costs = review.snapshot.costs.records;
  const coverage = await tx.billingItemCostCoverage.findMany({ where: { billingItemId: item.id, releasedAt: null } });
  if (coverage.length !== costs.length || costs.some((cost: any) => !coverage.some((line: any) =>
    line.costRecordId === cost.id && line.costCurrency === cost.currency && new Prisma.Decimal(line.costAmount).eq(cost.amount)))) {
    reject('COVERAGE_CONFLICT', '收费覆盖与核齐费用不一致，请重新核对');
  }
  return review;
}
