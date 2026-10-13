import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../orderCostReviewService', () => ({ readCurrentOrderCostReview: vi.fn() }));
import { readCurrentOrderCostReview } from '../orderCostReviewService';
import { withCurrentCostEvidence } from '../currentCostEvidence';
import { readCostEvidence } from '../costEvidence';
const current = vi.mocked(readCurrentOrderCostReview);
const base = { orderId: 'order-1', salesRevenue: 9999, grossProfit: 9988, grossMargin: 99, details: { internalTrade: { departmentProfit: 9988 }, costEvidence: { version: 2, calculatedAt: '2026-10-01', status: 'pending', committedAmountCny: 9999, acceptedAmountCny: 8000, paidPrincipalCny: 5000, actualCostCny: null, actualProfitCny: null, pendingReasons: ['OLDER_PROJECTED_INPUT'] } } };
const proof = { status: 'complete', actualCostCny: 90.0099, actualRevenueCny: 100.01, actualBreakdown: { procurement: 80, companySupply: 0, logistics: 10.0099, otherExpenses: 0, bankFees: 0, allowances: 0 }, pendingReasons: [], reviewId: 'review-1', reviewRevision: 1, sourceFingerprint: 'a'.repeat(64), confirmedBy: 'actual-actor', confirmedAt: '1790840000000' };
describe('Current immutable cost review consumers', () => {
 beforeEach(() => { current.mockReset(); });
 it('fresh missing review clears apparent actual profit while keeping independently known stages', async () => {
  current.mockResolvedValue({ status: 'pending', pendingReasons: ['ORDER_COST_REVIEW_MISSING'] } as any);
  const original = structuredClone(base), result = await withCurrentCostEvidence({}, original);
  expect(current).toHaveBeenCalledWith({}, 'order-1', undefined, undefined); expect(result.grossProfit).toBeNull(); expect(result.grossMargin).toBeNull();
  expect(result.details.costEvidence).toMatchObject({ status: 'pending', actualCostCny: null, actualProfitCny: null, committedAmountCny: 9999, acceptedAmountCny: 8000, paidPrincipalCny: 5000 });
  expect(result.details.internalTrade.departmentProfit).toBeNull(); expect(original).toEqual(base);
 });
 it('source change keeps a readable pending evidence contract instead of exposing old completeness', async () => {
  current.mockResolvedValue({ status: 'stale', reviewId: 'old-review', reviewRevision: 1, sourceFingerprint: 'a'.repeat(64), pendingReasons: ['ORDER_COST_REVIEW_SOURCE_CHANGED'] } as any);
  const result = await withCurrentCostEvidence({}, structuredClone(base));
  expect(readCostEvidence(result.details)).toMatchObject({ status: 'pending', reviewId: 'old-review', actualCostCny: null }); expect(result.grossProfit).toBeNull();
 });
 it('a missing review cannot turn invalid old completeness into known historical stages', async () => {
  current.mockResolvedValue({ status: 'pending', pendingReasons: ['ORDER_COST_REVIEW_MISSING'] } as any);
  const original = { ...structuredClone(base), details: { costEvidence: { ...base.details.costEvidence, status: 'complete', pendingReasons: [], actualCostCny: 11, actualProfitCny: 9988 } } };
  const result = await withCurrentCostEvidence({}, original);
  expect(result.details.costEvidence).toBeNull(); expect(result.grossProfit).toBeNull();
  expect(original.details.costEvidence.status).toBe('complete');
 });
 it('actual revenue, six costs and exact decimal profit follow the new proof, not stored revenue or projections', async () => {
  current.mockResolvedValue(proof as any); const original = structuredClone(base); const result = await withCurrentCostEvidence({}, original);
  expect(result.details.costEvidence).toMatchObject({ status: 'complete', actualRevenueCny: 100.01, actualCostCny: 90.0099, actualProfitCny: 10.0001, actualBreakdown: proof.actualBreakdown });
  expect(result.grossProfit).toBe(10.0001); expect(result.grossMargin).toBe(9.9991); expect(result.details.internalTrade.departmentProfit).toBe(10.0001);
  expect(readCostEvidence(result.details)?.status).toBe('complete'); expect(original).toEqual(base);
 });
 it('audit or actual private-byte failure propagates and cannot fall back to stored complete profit', async () => {
  const failure = new Error('COST_REVIEW_FACT_INVALID'); current.mockRejectedValue(failure);
  let caught: unknown;
  try { await withCurrentCostEvidence({}, structuredClone(base)); } catch (error) { caught = error; }
  expect(caught).toBe(failure);
 });
});
