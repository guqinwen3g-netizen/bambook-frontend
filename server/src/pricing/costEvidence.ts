import { Prisma } from '@prisma/client';

/** Cost stages are independent: payment and accepted goods do not prove consumption. */
export interface CostEvidence {
  version: 2;
  calculatedAt: string;
  status: 'pending' | 'complete';
  committedAmountCny: number | null;
  acceptedAmountCny: number | null;
  paidPrincipalCny: number | null;
  actualCostCny: number | null;
  actualProfitCny: number | null;
  pendingReasons: string[];
  reviewId?: string;
  reviewRevision?: number;
  sourceFingerprint?: string;
  actualRevenueCny?: number | null;
  actualBreakdown?: { procurement: number; companySupply: number; logistics: number; otherExpenses: number; bankFees: number; allowances: number } | null;
}
export function readCostEvidence(details: unknown): CostEvidence | null {
  const value = (details as any)?.costEvidence;
  if (value?.version !== 2 || !['pending','complete'].includes(value.status) || typeof value.calculatedAt !== 'string' || !Array.isArray(value.pendingReasons) || value.pendingReasons.some((r:unknown)=>typeof r!=='string')) return null;
  for (const key of ['committedAmountCny','acceptedAmountCny','paidPrincipalCny','actualCostCny','actualProfitCny']) {
    if (value[key] !== null && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) return null;
  }
  if (value.status==='complete' && (value.actualCostCny===null || value.actualProfitCny===null || value.pendingReasons.length || value.reviewId===undefined)) return null;
  if (value.reviewId !== undefined) {
    if (typeof value.reviewId !== 'string' || !value.reviewId || !Number.isSafeInteger(value.reviewRevision) || value.reviewRevision < 1 || !/^[a-f0-9]{64}$/.test(value.sourceFingerprint)) return null;
    if (value.actualRevenueCny !== null && (typeof value.actualRevenueCny !== 'number' || !Number.isFinite(value.actualRevenueCny) || value.actualRevenueCny < 0)) return null;
    if (value.status === 'complete') {
      if (!value.actualBreakdown || typeof value.actualRevenueCny !== 'number') return null;
      const rows = ['procurement','companySupply','logistics','otherExpenses','bankFees','allowances'].map(key => value.actualBreakdown[key]);
      if (rows.some(amount => typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0)) return null;
      const total = rows.reduce((sum, amount) => sum.add(amount), new Prisma.Decimal(0));
      if (!total.equals(value.actualCostCny) || !new Prisma.Decimal(value.actualRevenueCny).sub(value.actualCostCny).equals(value.actualProfitCny)) return null;
    }
  }
  return value as CostEvidence;
}
export function maskProfitSheet<T extends {details?: unknown;grossProfit?: unknown;grossMargin?: unknown}>(sheet:T): Omit<T,'grossProfit'|'grossMargin'> & {grossProfit:number|null;grossMargin:number|null} {
  const evidence=readCostEvidence(sheet.details);
  // Complete values must come from the evidence contract; live read boundaries also recheck its immutable fact.
  const complete=evidence?.status==='complete' && typeof evidence.actualCostCny==='number' && Number.isFinite(evidence.actualCostCny) && typeof evidence.actualProfitCny==='number' && Number.isFinite(evidence.actualProfitCny);
  const details=sheet.details as any;
  const safeDetails=details?.internalTrade ? {...details,internalTrade:{...details.internalTrade,departmentProfit:complete?evidence!.actualProfitCny:null}} : details;
  return {...sheet,details:safeDetails,grossProfit:complete ? evidence!.actualProfitCny : null,
    grossMargin:complete && evidence!.actualRevenueCny! > 0 ? Number(new Prisma.Decimal(evidence!.actualProfitCny!).div(evidence!.actualRevenueCny!).mul(100).toDecimalPlaces(4)) : null};
}
