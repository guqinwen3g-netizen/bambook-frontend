// Real PostgreSQL segment of S05/S08. Starts with an approved case fixture.
// Fabric readiness is established through native batch recognition/conversion,
// not an approved flag or a substituted readiness service.
// Authorization callbacks are fixture constraints; this does not prove real role
// grants, two rounds of UI development, finance handoff, invoice or receipt flows.
import { describe, expect, it, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { createCostRecordInTx } from '../src/finance/billingItemService';
import { registerPendingDevelopmentExpense, completePendingDevelopmentExpense } from '../src/development/developmentPendingExpenseService';
import { previewDevelopmentClosure, recordDevelopmentLifecycle, previewDevelopmentExpenseReview, confirmDevelopmentExpenseReview, assertDevelopmentExpenseReviewCurrentInTx } from '../src/development/developmentClosureService';
import { createDevelopmentBillingDraft } from '../src/development/developmentBillingDraftService';
import { createSampleBatch, advanceSampleBatchStage, submitBatchCustomerFeedback, convertToFabricAsset } from '../src/development/fabricDevelopmentService';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
const prisma = new PrismaClient();
afterAll(async () => { await prisma.$disconnect(); });
describe('whole-product acceptance: independent fabric and garment cost segments', () => {
  it.each(['fabric', 'garment'])('%s: pending cost, explicit closure, concurrent completion and charge basis', async type => {
    const id = 'acceptance-cost-' + type;
    const actorId = id + '-sales';
    await prisma.userAccount.create({ data: { id: actorId, displayName: 'Acceptance sales ' + type, status: 'active' } });
    await prisma.relation.create({ data: { id: id + '-customer', name: 'Acceptance customer ' + type, ownerId: actorId, category: 'customer', type: 'company', isOrganization: true, tags: [], contactInfo: '{}', lastInteraction: BigInt(Date.now()) } });
    await prisma.developmentCase.create({ data: { id, code: id, name: 'Acceptance two-round fixture ' + type, type, stage: 'approved', currentRound: 2, customerRelationId: id + '-customer', tags: [], createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } });
    if (type === 'fabric') {
      const roleId = id + '-native-role', supplierId = id + '-native-supplier';
      await prisma.role.create({ data: { id: roleId, name: 'Private native development operator', isSystem: false } });
      await prisma.userRole.create({ data: { id: id + '-native-membership', userId: actorId, roleId } });
      for (const scope of ['products:read', 'products:write']) await prisma.userPermissionOverrides.create({ data: { id: id + '-' + scope, userId: actorId, scope, grantedBy: actorId, isActive: true, reason: 'Explicit private native source fixture grant' } });
      await prisma.relation.create({ data: { id: supplierId, name: 'Private native mill', category: 'supplier', type: 'company', isOrganization: true, ownerId: actorId, tags: [], contactInfo: '{}', lastInteraction: BigInt(Date.now()) } });
      const trustedActor = await buildLoadedAuthTokenPayload(prisma, await loadUserWithRoles(prisma, actorId));
      const registered = await createSampleBatch({ prisma, caseId: id, actorId, input: { sampleType: 'lab-dip', supplierRelationId: supplierId, supplierName: 'Private native mill' } });
      expect(registered.ok).toBe(true); if (!registered.ok) throw new Error('Native cost fixture registration failed');
      const batchId = registered.data.batch.id;
      expect((await advanceSampleBatchStage({ prisma, batchId, actorId, trustedActor, action: 'start', input: {} })).ok).toBe(true);
      expect((await advanceSampleBatchStage({ prisma, batchId, actorId, trustedActor, action: 'send', input: { courier: 'DHL', trackingNumber: id + '-native-tracking' } })).ok).toBe(true);
      expect((await submitBatchCustomerFeedback({ prisma, batchId, actorId, trustedActor, input: { status: 'approved', note: 'Actual customer source acceptance for this financial segment' } })).ok).toBe(true);
      expect((await advanceSampleBatchStage({ prisma, batchId, actorId, trustedActor, action: 'approve', input: { feedback: 'Native current round recognition' } })).ok).toBe(true);
      const converted = await convertToFabricAsset({ prisma, caseId: id, sourceType: 'batch', sourceId: batchId, actorId, trustedActor });
      expect(converted.ok).toBe(true); if (!converted.ok) throw new Error('Native cost fixture conversion failed');
      expect((await prisma.sampleBatch.findUniqueOrThrow({ where: { id: batchId } })).convertedProductAssetId).toBe(converted.data.asset.id);
    }
    const context = { prisma, actorId, authorize: async (_tx: any, caseId: string) => { expect(caseId).toBe(id); }, authorizeAssignee: async (_tx: any, caseId: string, userId: string) => { expect([caseId, userId]).toEqual([id, actorId]); } };
    const cost = async (amount: string, costType = 'development') => prisma.$transaction(tx => createCostRecordInTx(tx, { actorId, input: { sourceType: 'DevelopmentCase', sourceId: id, costType, amount, currency: 'CNY', incurredAt: '2026-09-30' } }));
    await cost('100'); await cost('20', 'shipping');
    const input = { requestKey: 'pending-test-fee', sourceType: 'DevelopmentCase', sourceId: id, costType: 'testing', description: 'Actual testing bill not received yet', ownerId: actorId, expectedDate: '2026-10-01' };
    const pending = await registerPendingDevelopmentExpense(context, id, input);
    expect(await prisma.costRecord.count({ where: { sourceType: 'DevelopmentCase', sourceId: id } })).toBe(2);
    expect((await registerPendingDevelopmentExpense(context, id, input)).id).toBe(pending.id);
    const close = await previewDevelopmentClosure(context, id);
    expect(close.state).toBe('active');
    await recordDevelopmentLifecycle(context, id, { action: 'close', outcome: 'completed', reason: 'Development fixture approved', disposition: 'Testing bill remains assigned to sales', expectedRevision: close.revision, expectedFingerprint: close.fingerprint, requestKey: 'close' });
    const before = await previewDevelopmentExpenseReview(context, id);
    await expect(confirmDevelopmentExpenseReview(context, id, { expectedFingerprint: before.fingerprint, requestKey: 'blocked-review', note: 'Attempt with unknown testing fee' })).rejects.toMatchObject({ code: 'EXPENSES_PENDING' });
    expect(await prisma.developmentExpenseReview.count({ where: { developmentCaseId: id } })).toBe(0);
    const resolution = { requestKey: 'complete-test-fee', expectedVersion: 1, outcome: 'resolved' as const, note: 'Received testing bill CNY30', amount: '30', currency: 'CNY', incurredAt: '2026-09-30' };
    const completed = await Promise.all([completePendingDevelopmentExpense(context, id, pending.id, resolution), completePendingDevelopmentExpense(context, id, pending.id, resolution)]);
    expect(completed[0].costRecordId).toBe(completed[1].costRecordId);
    expect(await prisma.costRecord.count({ where: { sourceType: 'DevelopmentCase', sourceId: id } })).toBe(3);
    const preview = await previewDevelopmentExpenseReview(context, id);
    const review = await confirmDevelopmentExpenseReview(context, id, { expectedFingerprint: preview.fingerprint, requestKey: 'review', note: 'All case expenses received and checked' });
    expect(new Prisma.Decimal(review.snapshot.costs.totals.find((total: any) => total.currency === 'CNY').amount).equals(150)).toBe(true);
    const body = { requestKey: 'charge', reviewId: review.id, amount: '120', waivedAmount: '0', currency: 'CNY', note: 'Independent whole-case customer charge CNY120' };
    const draft = await createDevelopmentBillingDraft(context, id, body);
    expect(draft.billingItem.amount.toString()).toBe('120');
    expect((await createDevelopmentBillingDraft(context, id, body)).billingItem.id).toBe(draft.billingItem.id);
    expect(await prisma.billingItem.count({ where: { sourceType: 'DevelopmentCase', sourceId: id } })).toBe(1);
    await cost('5');
    await expect(assertDevelopmentExpenseReviewCurrentInTx(prisma, id, review.id)).rejects.toMatchObject({ code: 'REVIEW_STALE' });
    expect(await prisma.developmentExpenseReview.count({ where: { developmentCaseId: id } })).toBe(1);
  });
});
