import type { TokenPayload } from '../auth/service';
import { readCostEvidence } from './costEvidence';
import { readCurrentOrderCostReview } from './orderCostReviewService';
import { Prisma } from '@prisma/client';

/** Stored projections may outlive their invoices, receipts or private evidence.
 * Revalidate the immutable review on every read before displaying actual profit. */
export async function withCurrentCostEvidence<T extends { orderId: string; details?: unknown; salesRevenue?: unknown; grossProfit?: unknown; grossMargin?: unknown }>(db: any, sheet: T, actor?: TokenPayload): Promise<T> {
  const prior = readCostEvidence(sheet.details);
  const current = await readCurrentOrderCostReview(db, sheet.orderId, undefined, actor);
  const details = sheet.details && typeof sheet.details === 'object' && !Array.isArray(sheet.details) ? sheet.details as Record<string, any> : {};
  const costEvidence: any = {
    version: 2, calculatedAt: prior?.calculatedAt || '',
    committedAmountCny: prior?.committedAmountCny ?? null,
    acceptedAmountCny: prior?.acceptedAmountCny ?? null,
    paidPrincipalCny: prior?.paidPrincipalCny ?? null,
    status: 'pending', actualCostCny: null, actualProfitCny: null,
    actualRevenueCny: null, actualBreakdown: null,
    pendingReasons: current.pendingReasons,
    ...('reviewId' in current ? { reviewId: current.reviewId, reviewRevision: current.reviewRevision,
      sourceFingerprint: current.sourceFingerprint } : {}),
  };
  let profit: number | null = null, margin: number | null = null;
  if (current.status === 'complete') {
    const profitAmount = new Prisma.Decimal(current.actualRevenueCny!).minus(current.actualCostCny!);
    profit = profitAmount.toDecimalPlaces(4).toNumber();
    margin = current.actualRevenueCny! > 0
      ? profitAmount.dividedBy(current.actualRevenueCny!).times(100).toDecimalPlaces(4).toNumber()
      : null;
    Object.assign(costEvidence, { status: 'complete', actualCostCny: current.actualCostCny, actualProfitCny: profit,
      actualRevenueCny: current.actualRevenueCny, actualBreakdown: current.actualBreakdown, pendingReasons: [],
      sourceFingerprint: current.sourceFingerprint, confirmedBy: current.confirmedBy, confirmedAt: current.confirmedAt });
  }
  // A pending review cannot create valid historical evidence for unknown stages.
  const safeDetails = { ...details, costEvidence: current.status === 'complete' || prior ? costEvidence : null,
    ...(details.internalTrade ? { internalTrade: { ...details.internalTrade, departmentProfit: profit } } : {}) };
  return { ...sheet, details: safeDetails, grossProfit: profit, grossMargin: margin };
}
