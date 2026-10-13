import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { approvalEventBus } from '../../agent/events';
import { SYSTEM_ROLE_IDS } from '../../_shared/rolePermissionMatrix';
import { approvalReviewContentVersion, createApprovalDecisionService } from '../approvalDecisionService';
import { approvalReviewPreviewDigest } from '../approvalReviewDetailService';
import { buildQuotationApprovalSnapshot, buildQuotationSnapshot, canonicalQuotationJson, ACTION_LINE_APPROVE } from '../../quotations/quotationApprovalSnapshot';
import { publishNotificationEvent } from '../../realtime';
import { buildApprovalSignDocumentSnapshot } from '../approvalSignDocumentSnapshotService';
import { ACTION_TOTAL_APPROVE } from '../../quotations/quotationApprovalSnapshot';

vi.mock('../../realtime', () => ({ publishNotificationEvent: vi.fn(), publishDataChange: vi.fn() }));

/** Transaction-model unit probes only; real PG rollback/concurrency belongs to acceptance tests. */
const decisionQuotation = { id: 'q1', quotationNumber: 'QT-1', status: 'Draft', deletedAt: null, version: 1,
  currency: 'USD', totalAmount: '100', notes: null, customerRelationId: null, customerName: 'Buyer', customerCode: null,
  developmentCaseId: null, orderId: null, orderLineId: null, issueDate: '2026-10-01', validUntil: null,
  deliveryTerms: null, paymentTerms: null, paymentInstrument: null, baseCurrency: 'USD', exchangeRate: null,
  trackAMedianUsd: '1', trackAUnit: 'M', trackBFinalUsd: '1.2', priceDeviationPercent: 20,
  priceDeviationLevel: 'warn', priceApprovalId: 'a1', lines: [{ id: 'line-1', lineNumber: 1, description: 'Cloth',
    quantity: '10', unit: 'M', unitPrice: '10', amount: '100', fabricCode: 'FAB-1', notes: null, imageUrl: null, moqOverride: null }] };
const decisionQuotationSnapshot = buildQuotationSnapshot(decisionQuotation);
const decisionQuotationFingerprint = createHash('sha256').update(canonicalQuotationJson({ actionType: 'quotation:price-deviation',
  targetType: 'Quotation', targetId: 'q1', quotationSnapshot: decisionQuotationSnapshot })).digest('hex');
function fixture(options: { row?: Record<string, any>; auditFail?: boolean; loseCas?: boolean; notificationFail?: boolean; quotation?: Record<string, any> } = {}) {
  let row: any = { id: 'a1', requesterId: 'requester', reviewerId: 'reviewer', status: 'pending',
    actionType: 'quotation:price-deviation', targetType: 'Quotation', targetId: 'q1', risk: 'high',
    payload: { policyKey: 'price_approval', quotationId: 'q1', quotationNumber: 'QT-1',
      quotationSnapshot: decisionQuotationSnapshot, contentFingerprint: decisionQuotationFingerprint,
      trackAMedianUsd: 1, trackAUnit: 'M', trackBFinalUsd: 1.2, deviationPercent: 20,
      source: 'quotation-dual-track', hitConditions: ['dual_track_deviation'], level: 'warn',
      requestedAt: '2026-10-01T00:00:00.000Z', ruleFindings: [{ rule: 'dual_track_deviation' }] }, decidedAt: null, decisionNote: null,
    bossFinalBypassBy: null, ...options.row };
  const audits: any[] = [];
  const notifications: any[] = [];
  const trace: string[] = [];
  const read = async () => { trace.push('read'); return { ...row }; };
  const prisma: any = {
    approvalRequest: {
      findUnique: vi.fn(read), findUniqueOrThrow: vi.fn(read),
      updateMany: vi.fn(async ({ where, data }: any) => {
        trace.push('write');
        if (options.loseCas) return { count: 0 };
        for (const key of ['id', 'status', 'requesterId', 'reviewerId', 'actionType', 'targetType', 'targetId']) {
          if (where[key] !== row[key]) return { count: 0 };
        }
        if (JSON.stringify(where.payload.equals) !== JSON.stringify(row.payload)) return { count: 0 };
        row = { ...row, ...data }; return { count: 1 };
      }),
    },
    userRole: { findMany: vi.fn(async () => [{ roleId: SYSTEM_ROLE_IDS.SALES_MANAGER }]) },
    quotation: { findUnique: vi.fn(async () => options.quotation ?? decisionQuotation) },
    userAccount: { findFirst: vi.fn(async ({ where }: any) => ({ id: where.id })) },
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        trace.push('audit');
        if (options.auditFail) throw Object.assign(new Error('SQL fault sentinel'), { code: 'P2003' });
        const audit = { ...data, createdAt: new Date() }; audits.push(audit); return audit;
      }),
      findMany: vi.fn(async () => [...audits]),
      findFirst: vi.fn(async ({ where }: any) => audits.find(audit => audit.action === where.action && audit.targetId === where.targetId
        && audit.detail.decisionAuditId === where.detail.equals) ?? null),
    },
    notification: {
      createMany: vi.fn(async ({ data }: any) => {
        trace.push('receipt');
        if (options.notificationFail) throw Object.assign(new Error('notification storage fault'), { code: 'P2003' });
        let count = 0;
        for (const item of data) if (!notifications.some(existing => existing.id === item.id)) { notifications.push(item); count++; }
        return { count };
      }),
    },
    $queryRaw: vi.fn(async () => { trace.push('lock'); return [{ id: 'a1' }]; }),
    $queryRawUnsafe: vi.fn(async () => { trace.push('source-lock'); return [{ id: 'q1' }]; }),
    systemConfig: { findUnique: vi.fn(async () => null) },
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (callback: any) => {
      const before = row; const auditCount = audits.length; const notificationCount = notifications.length;
      try { const result = await callback(prisma); trace.push('commit'); return result; }
      catch (error) { row = before; audits.splice(auditCount); notifications.splice(notificationCount); trace.push('rollback'); throw error; }
    }),
  };
  return { prisma, audits, notifications, trace, getRow: () => row };
}
const baseReview = { id: 'a1', requesterId: 'requester', reviewerId: 'reviewer', actionType: 'quotation:price-deviation',
  targetType: 'Quotation', targetId: 'q1', payload: { policyKey: 'price_approval', quotationId: 'q1', quotationNumber: 'QT-1',
    quotationSnapshot: decisionQuotationSnapshot, contentFingerprint: decisionQuotationFingerprint,
    trackAMedianUsd: 1, trackAUnit: 'M', trackBFinalUsd: 1.2, deviationPercent: 20, source: 'quotation-dual-track',
    hitConditions: ['dual_track_deviation'], level: 'warn', requestedAt: '2026-10-01T00:00:00.000Z', ruleFindings: [{ rule: 'dual_track_deviation' }] } };
const review = (override: Record<string, unknown> = {}) => {
  const approval = { ...baseReview, ...override } as any;
  return { reviewContentVersion: approvalReviewContentVersion(approval), reviewPreviewDigest: approvalReviewPreviewDigest(approval), confirmedReviewedContent: true };
};
const input = { id: 'a1', actor: { userId: 'reviewer', roles: ['manager'] }, decision: 'approved' as const,
  source: 'api:approvals' as const, ...review() };

describe('shared approval decision atomic boundary', () => {
  it.each(['supplier:commitment', 'order:main_approval'])('requires the native domain decision for %s, including boss and modified paths', async actionType => {
    for (const variant of [{ decision: 'approved', mode: 'normal' }, { decision: 'approved', mode: 'boss' }, { decision: 'modified', mode: 'normal' }] as const) {
      const f = fixture({ row: { actionType, targetType: actionType === 'supplier:commitment' ? 'SupplierCommitmentRevision' : 'Order', payload: {} } });
      await expect(createApprovalDecisionService(f.prisma).decide({ ...input, ...variant, source: 'api:admin',
        actor: { userId: 'reviewer', roles: ['owner'] }, bossReason: 'A sufficiently detailed reason cannot replace the domain approval authority.' }))
        .rejects.toMatchObject({ code: 'DOMAIN_APPROVAL_REQUIRED', statusCode: 409 });
      expect(f.getRow().status).toBe('pending'); expect(f.prisma.approvalRequest.updateMany).not.toHaveBeenCalled(); expect(f.audits).toHaveLength(0);
    }
  });

  it.each(['supplier:commitment', 'order:main_approval'])('does not delegate an explicitly configured native domain approval: %s', async actionType => {
    const f = fixture({ row: { actionType, payload: {} } });
    await expect(createApprovalDecisionService(f.prisma).delegate({ id: 'a1', actor: input.actor, toUserId: 'delegate', reason: 'This is a sufficiently detailed delegation reason.' }))
      .rejects.toMatchObject({ code: 'DOMAIN_APPROVAL_REQUIRED', statusCode: 409 });
    expect(f.prisma.approvalRequest.updateMany).not.toHaveBeenCalled(); expect(f.audits).toHaveLength(0);
  });

  it('locks before reading, writes complete snapshot CAS, records actual authority and fact before resolved', async () => {
    const f = fixture(); const resolved = vi.fn(() => expect(f.trace[f.trace.length - 1]).toBe('commit'));
    approvalEventBus.on('resolved', resolved);
    try {
      const result = await createApprovalDecisionService(f.prisma).decide(input);
      expect(f.trace).toEqual(['read', 'lock', 'lock', 'read', 'write', 'audit', 'read', 'receipt', 'commit']);
      expect(result.updated).toMatchObject({ status: 'approved', reviewerId: 'reviewer' });
      expect(f.prisma.approvalRequest.updateMany.mock.calls[0][0].where).toMatchObject({
        status: 'pending', requesterId: 'requester', reviewerId: 'reviewer', actionType: 'quotation:price-deviation',
        payload: { equals: { contentFingerprint: decisionQuotationFingerprint } },
      });
      expect(f.audits[0]).toMatchObject({ actorId: 'reviewer', action: 'approve_business_request', detail: {
        decisionActorAuthority: { userId: 'reviewer', roleIds: [SYSTEM_ROLE_IDS.SALES_MANAGER], roles: ['manager'], authorizationLoaded: true },
        approvalDecisionFact: { schemaVersion: 1, status: 'approved', actionType: 'quotation:price-deviation', targetType: 'Quotation',
          targetId: 'q1', decisionActorId: 'reviewer', contentFingerprint: decisionQuotationFingerprint, decidedAt: result.updated.decidedAt!.toISOString() },
      } });
      expect(resolved).toHaveBeenCalledOnce();
    } finally { approvalEventBus.off('resolved', resolved); }
  });

  it('exposes the exact transaction kernel without committing or emitting; caller publishes only after commit', async () => {
    const f = fixture(); const resolved = vi.fn(); approvalEventBus.on('resolved', resolved);
    try {
      const service = createApprovalDecisionService(f.prisma);
      const committed = await service.decideInTransaction(f.prisma, input);
      expect(committed.updated.status).toBe('approved');
      expect(f.trace).not.toContain('commit');
      expect(f.prisma.$transaction).not.toHaveBeenCalled();
      expect(resolved).not.toHaveBeenCalled();
      await service.publishCommittedDecision(committed, input);
      expect(resolved).toHaveBeenCalledOnce();
    } finally { approvalEventBus.off('resolved', resolved); }
  });

  it('persists a minimal applicant result receipt atomically and sends the scoped SSE only after commit', async () => {
    vi.mocked(publishNotificationEvent).mockReset();
    const f = fixture(); const service = createApprovalDecisionService(f.prisma);
    const committed = await f.prisma.$transaction((tx: any) => service.decideInTransaction(tx, input));
    expect(f.notifications).toHaveLength(1);
    expect(f.notifications[0]).toMatchObject({ id: `ntf_approval_decision_${committed.decisionAuditId}`,
      userId: 'requester', type: 'approval_decided', title: '报价偏差审批 QT-1 已通过',
      metadata: { approvalId: 'a1', decisionAuditId: committed.decisionAuditId, decisionStatus: 'approved' } });
    expect(f.notifications[0].body).not.toContain('amount');
    expect(f.notifications[0].body).not.toContain('decisionNote');
    expect(publishNotificationEvent).not.toHaveBeenCalled();
    expect(f.trace.slice(-2)).toEqual(['receipt', 'commit']);

    await service.publishCommittedDecision(committed, input);
    expect(f.trace.at(-1)).toBe('commit');
    expect(publishNotificationEvent).toHaveBeenCalledOnce();
    expect(publishNotificationEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventId: f.notifications[0].id, eventType: 'approval_decided', recipientIds: ['requester'],
      metadata: expect.objectContaining({ approvalId: 'a1', decisionAuditId: committed.decisionAuditId }),
    }));
  });

  it('notification storage failure rolls back the decision and its audit', async () => {
    const f = fixture({ notificationFail: true });
    await expect(createApprovalDecisionService(f.prisma).decide(input)).rejects.toMatchObject({ code: 'P2003' });
    expect(f.getRow()).toMatchObject({ status: 'pending', decidedAt: null });
    expect(f.audits).toHaveLength(0); expect(f.notifications).toHaveLength(0);
  });

  it('SSE failure leaves the committed offline receipt readable', async () => {
    vi.mocked(publishNotificationEvent).mockReset().mockImplementationOnce(() => { throw new Error('SSE write failed'); });
    const f = fixture();
    const result = await createApprovalDecisionService(f.prisma).decide(input);
    expect(result.updated.status).toBe('approved');
    expect(f.notifications).toHaveLength(1);
    expect(f.notifications[0].metadata.approvalId).toBe('a1');
  });

  it('runs the native quotation amendment hook in the same transaction before decision CAS and audit', async () => {
    const quotation = { id: 'q1', quotationNumber: 'QT-1', status: 'Draft', deletedAt: null, version: 1,
      currency: 'USD', totalAmount: '10', notes: null, lines: [{ id: 'line-1', lineNumber: 1, description: 'Cloth',
        quantity: '1', unit: 'M', unitPrice: '10', amount: '10' }] };
    const payload = { quotationId: 'q1', ...buildQuotationApprovalSnapshot(quotation, ACTION_LINE_APPROVE, 'line-1') };
    const row = { id: 'a1', requesterId: 'requester', reviewerId: 'reviewer', status: 'pending',
      actionType: ACTION_LINE_APPROVE, targetType: 'QuotationLine', targetId: 'line-1', risk: 'medium', payload,
      decidedAt: null, decisionNote: null, bossFinalBypassBy: null };
    const f = fixture({ row, quotation });
    const amendment = { reason: '按客户最新报价意见完成单价调整', previewVersion: 'a'.repeat(64), finalContentVersion: 'b'.repeat(64) };
    const amendmentResult = { approvalId: 'a1', amendmentAuditId: 'amend-audit', finalVersion: 2,
      finalContentVersion: amendment.finalContentVersion, finalFingerprint: amendment.finalContentVersion };
    const applyInTransaction = vi.fn(async () => amendmentResult);
    const reviewContentVersion = approvalReviewContentVersion(row as any);
    const amendedInput = { ...input, reviewContentVersion, quotationAmendment: amendment };
    const result = await createApprovalDecisionService(f.prisma, {
      quotationAmendmentService: { applyInTransaction } as any,
    }).decide(amendedInput);
    expect(applyInTransaction).toHaveBeenCalledWith(f.prisma, expect.objectContaining({ actionType: ACTION_LINE_APPROVE }),
      'reviewer', amendment, reviewContentVersion);
    expect(f.prisma.approvalRequest.updateMany).toHaveBeenCalledOnce();
    expect(f.audits[0].detail.approvalDecisionFact).toMatchObject({
      finalContentVersion: amendment.finalContentVersion, finalQuotationVersion: 2, quotationAmendmentAuditId: 'amend-audit',
    });
    expect(result.quotationAmendment).toEqual(amendmentResult);
  });

  it('mandatory audit failure rolls back decision and emits no resolved or business hook', async () => {
    const f = fixture({ auditFail: true }); const resolved = vi.fn(); const onDecided = vi.fn();
    approvalEventBus.on('resolved', resolved);
    try {
      await expect(createApprovalDecisionService(f.prisma, { onDecided }).decide(input)).rejects.toMatchObject({ code: 'P2003' });
      expect(f.getRow()).toMatchObject({ status: 'pending', reviewerId: 'reviewer', decidedAt: null, decisionNote: null });
      expect(f.audits).toHaveLength(0); expect(onDecided).not.toHaveBeenCalled(); expect(resolved).not.toHaveBeenCalled();
    } finally { approvalEventBus.off('resolved', resolved); }
  });

  it('a lost conditional update refuses stale content rather than auditing a phantom decision', async () => {
    const f = fixture({ loseCas: true });
    await expect(createApprovalDecisionService(f.prisma).decide(input)).rejects.toMatchObject({ code: 'APPROVAL_CONCURRENT_CHANGE', statusCode: 409 });
    expect(f.getRow().status).toBe('pending'); expect(f.audits).toHaveLength(0);
  });

  it('locks and rechecks the current quotation snapshot before approving a price-deviation request', async () => {
    const f = fixture({ quotation: { ...decisionQuotation, totalAmount: '101' } });
    await expect(createApprovalDecisionService(f.prisma).decide(input)).rejects.toMatchObject({ code: 'APPROVAL_CONTENT_CHANGED', statusCode: 409 });
    expect(f.trace.slice(0, 2)).toEqual(['read', 'lock']);
    expect(f.prisma.approvalRequest.updateMany).not.toHaveBeenCalled();
  });

  it('locks the complete quotation document and records its exact reviewed signature version', async () => {
    const quotation = { ...decisionQuotation, quotationType:'Fabric', ownerId:'requester', quotationNumber: 'QT-1', salesperson: 'Mia', inquiryRef: 'INQ-1',
      deliveryTerms: 'FOB Shanghai', paymentTerms: '30 days', customerName: 'Buyer', customerCode: 'B-1' };
    const documentSnapshot = await buildApprovalSignDocumentSnapshot({ quotation: { findUnique: vi.fn(async () => quotation) },
      systemConfig: { findUnique: vi.fn(async () => null) } } as any, { kind: 'Quotation', quotationId: 'q1' });
    const commercial = buildQuotationApprovalSnapshot(quotation, ACTION_TOTAL_APPROVE, 'q1');
    const row = { id: 'a1', requesterId: 'requester', reviewerId: 'reviewer', status: 'pending',
      actionType: ACTION_TOTAL_APPROVE, targetType: 'Quotation', targetId: 'q1', risk: 'high',
      payload: { quotationId: 'q1', quotationNumber: 'QT-1', ...commercial, documentSnapshot },
      decidedAt: null, decisionNote: null, bossFinalBypassBy: null };
    const f = fixture({ quotation, row });
    f.prisma.userAccount.findFirst.mockImplementation(async ({where}:any)=>({id:where.id,primaryDeptId:'fabric-dept',status:'active'}));
    f.prisma.userAccount.findUnique=vi.fn(async()=>({id:'reviewer',status:'active',primaryDeptId:'fabric-dept',primaryDepartment:{id:'fabric-dept',metadata:{businessAttributes:['fabric_business']}},roles:[{departmentId:'fabric-dept',role:{id:SYSTEM_ROLE_IDS.SALES_MANAGER,permissions:[{permission:{scope:'quotations:write'}}]}}]}));
    f.prisma.userPermissionOverrides={findMany:vi.fn(async()=>[])};
    f.prisma.department={findMany:vi.fn(async()=>[])};
    f.prisma.team={findMany:vi.fn(async()=>[{id:'fabric-team',leaderId:'reviewer',status:'active',deletedAt:null,department:{id:'fabric-dept',parentId:'company',status:'active',metadata:{businessAttributes:['fabric_business']}}}])};
    const bindings = { reviewContentVersion: approvalReviewContentVersion(row as any),
      reviewPreviewDigest: approvalReviewPreviewDigest(row as any), confirmedReviewedContent: true };
    const result = await createApprovalDecisionService(f.prisma).decide({ ...input, ...bindings });
    expect(f.prisma.$queryRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('QuotationLine'), 'q1');
    expect(result.updated.status).toBe('approved');
    expect(f.audits[0].detail.approvalDecisionFact.documentSnapshot).toMatchObject({
      kind: 'Quotation', sourceRef: 'q1', templateVersion: documentSnapshot.templateVersion,
      sourceFingerprint: documentSnapshot.sourceFingerprint, contentFingerprint: documentSnapshot.contentFingerprint,
    });
  });

  it('refuses a quote decision when the frozen seller profile changed after the reviewer preview', async () => {
    const quotation = { ...decisionQuotation, quotationNumber: 'QT-1', salesperson: 'Mia', inquiryRef: 'INQ-1',
      deliveryTerms: 'FOB Shanghai', paymentTerms: '30 days', customerName: 'Buyer', customerCode: 'B-1' };
    const documentSnapshot = await buildApprovalSignDocumentSnapshot({ quotation: { findUnique: vi.fn(async () => quotation) },
      systemConfig: { findUnique: vi.fn(async () => null) } } as any, { kind: 'Quotation', quotationId: 'q1' });
    const commercial = buildQuotationApprovalSnapshot(quotation, ACTION_TOTAL_APPROVE, 'q1');
    const row = { id: 'a1', requesterId: 'requester', reviewerId: 'reviewer', status: 'pending',
      actionType: ACTION_TOTAL_APPROVE, targetType: 'Quotation', targetId: 'q1', risk: 'high',
      payload: { quotationId: 'q1', quotationNumber: 'QT-1', ...commercial, documentSnapshot },
      decidedAt: null, decisionNote: null, bossFinalBypassBy: null };
    const f = fixture({ quotation, row });
    f.prisma.systemConfig.findUnique.mockResolvedValue({ id: 'global::company.exporterProfile', version: 3,
      updatedAt: new Date('2026-10-05T00:00:00Z'), encrypted: false,
      value: { nameEn: 'Changed Seller', addressEn: 'New Address' } });
    const bindings = { reviewContentVersion: approvalReviewContentVersion(row as any),
      reviewPreviewDigest: approvalReviewPreviewDigest(row as any), confirmedReviewedContent: true };
    await expect(createApprovalDecisionService(f.prisma).decide({ ...input, ...bindings }))
      .rejects.toMatchObject({ code: 'APPROVAL_CONTENT_CHANGED', statusCode: 409 });
    expect(f.prisma.approvalRequest.updateMany).not.toHaveBeenCalled();
    expect(f.audits).toHaveLength(0);
  });

  it('locks the DR013 source and refuses approval when the current allowed scope changed', async () => {
    const payload = { exceptionNumber: 'EXC-2026-001', exceptionCategory: 'process', subCategory: null,
      bypassedApprovalIds: [], exceptionReason: '客户书面确认本批次可以按当前规格先行处理，并补齐后续资料后完成复核。',
      riskMitigationPlan: '负责人收到客户确认后跟进补件并在七日内完成复核',
      scope: { targetType: 'Order', targetId: 'ORD-1', action: 'ship', validUntil: null, maxUses: 1 },
      responsibleOwnerId: 'staff-7' };
    const row = { id: 'a1', requesterId: 'requester', reviewerId: 'reviewer', status: 'pending',
      actionType: 'order:dr013-exception', targetType: 'Dr013ExceptionRequest', targetId: 'EXC-ID-1', risk: 'high', payload,
      decidedAt: null, decisionNote: null, bossFinalBypassBy: null };
    const f = fixture({ row });
    f.prisma.dr013ExceptionRequest = { findUnique: vi.fn(async () => ({ id: 'EXC-ID-1', exceptionNumber: payload.exceptionNumber,
      exceptionCategory: payload.exceptionCategory, subCategory: null, status: 'Pending', exceptionReason: payload.exceptionReason,
      riskMitigationPlan: payload.riskMitigationPlan, requesterId: 'requester', reviewerId: 'reviewer', approvalRequestId: 'a1',
      deletedAt: null, bypassedApprovalIds: [], attachments: { files: [], scope: { ...payload.scope,
        targetId: 'ORD-2', responsibleOwnerId: 'staff-7', usedCount: 0, consumptions: [] } } })) };
    await expect(createApprovalDecisionService(f.prisma).decide({ ...input, ...review(row) }))
      .rejects.toMatchObject({ code: 'APPROVAL_CONTENT_CHANGED', statusCode: 409 });
    expect(f.trace).toEqual(['read', 'lock', 'lock', 'read', 'rollback']);
    expect(f.prisma.dr013ExceptionRequest.findUnique).toHaveBeenCalledOnce();
    expect(f.prisma.approvalRequest.updateMany).not.toHaveBeenCalled();
    expect(f.audits).toHaveLength(0);
  });

  it('rejects an approval whose reviewed content version no longer matches the locked row', async () => {
    const f = fixture();
    await expect(createApprovalDecisionService(f.prisma).decide({ ...input, reviewContentVersion: 'f'.repeat(64) }))
      .rejects.toMatchObject({ code: 'APPROVAL_CONTENT_CHANGED', statusCode: 409 });
    expect(f.prisma.approvalRequest.updateMany).not.toHaveBeenCalled();
    expect(f.audits).toHaveLength(0);
  });

  it('requires explicit reviewed-content confirmation before approval', async () => {
    const f = fixture();
    await expect(createApprovalDecisionService(f.prisma).decide({ ...input, confirmedReviewedContent: false }))
      .rejects.toMatchObject({ code: 'REVIEW_CONFIRMATION_REQUIRED', statusCode: 400 });
    expect(f.prisma.approvalRequest.updateMany).not.toHaveBeenCalled();
  });

  it.each(['api:approvals', 'api:admin', 'api:agent'] as const)('%s cannot replace the assigned reviewer with an unrelated admin', async source => {
    const f = fixture();
    await expect(createApprovalDecisionService(f.prisma).decide({ ...input, source, actor: { userId: 'other', roles: ['admin'] } }))
      .rejects.toMatchObject({ code: 'APPROVAL_NOT_ASSIGNED', statusCode: 403 });
    expect(f.prisma.approvalRequest.updateMany).not.toHaveBeenCalled(); expect(f.audits).toHaveLength(0);
  });

  it('owner with long boss reason remains unable to approve their own application', async () => {
    const f = fixture({ row: { requesterId: 'owner' } });
    await expect(createApprovalDecisionService(f.prisma).decide({ ...input, ...review({ requesterId: 'owner' }), mode: 'boss', source: 'api:approvals-kernel',
      actor: { userId: 'owner', roles: ['owner'] }, bossReason: 'a'.repeat(40) })).rejects.toMatchObject({ code: 'SELF_APPROVAL_FORBIDDEN', statusCode: 403 });
    expect(f.audits).toHaveLength(0); expect(f.getRow().status).toBe('pending');
  });

  it('a revoked owner in an old JWT cannot claim the ownership or boss exception', async () => {
    const f = fixture(); const service = createApprovalDecisionService(f.prisma);
    // DB still assigns only manager: the old token's owner text must not overrule it.
    const staleOwner = { userId: 'old-owner', roles: ['owner'] };
    await expect(service.decide({ ...input, actor: staleOwner })).rejects.toMatchObject({ code: 'APPROVAL_NOT_ASSIGNED', statusCode: 403 });
    await expect(service.decide({ ...input, actor: staleOwner, mode: 'boss', source: 'api:approvals-kernel', bossReason: 'a'.repeat(40) }))
      .rejects.toMatchObject({ code: 'BOSS_BYPASS_REQUIRES_OWNER', statusCode: 403 });
    expect(f.getRow().status).toBe('pending'); expect(f.audits).toHaveLength(0);
  });

  it('boss preserves assigned reviewer but callback/fact name the actual deciding boss', async () => {
    const f = fixture(); const onDecided = vi.fn(async () => undefined);
    f.prisma.userRole.findMany.mockResolvedValue([{ roleId: SYSTEM_ROLE_IDS.SUPER_ADMIN }]);
    const result = await createApprovalDecisionService(f.prisma, { onDecided }).decide({ ...input, mode: 'boss',
      source: 'api:approvals-kernel', actor: { userId: 'boss', roles: ['owner'] }, bossReason: 'a'.repeat(40) });
    expect(result.updated).toMatchObject({ reviewerId: 'reviewer', bossFinalBypassBy: 'boss' });
    expect(f.audits[0]).toMatchObject({ actorId: 'boss', action: 'boss_final_bypass', detail: { approvalDecisionFact: { decisionActorId: 'boss' } } });
    expect(onDecided).toHaveBeenCalledWith(expect.objectContaining({ reviewerId: 'boss', actualDecisionActor: 'boss' }));
  });

  it('post-commit delivery failure is explicit; retry replays the fact without deciding or emitting again', async () => {
    const f = fixture(); const resolved = vi.fn(); const onDecided = vi.fn().mockRejectedValueOnce(new Error('projection unavailable')).mockResolvedValue(undefined);
    const service = createApprovalDecisionService(f.prisma, { onDecided });
    approvalEventBus.on('resolved', resolved);
    try {
      const result = await service.decide(input);
      expect(result.updated.status).toBe('approved');
      expect(result.sync).toEqual({ status: 'failed', retryable: true, code: 'APPROVAL_SYNC_FAILED' });
      const before = { ...f.getRow() };
      expect((await service.retrySync('a1', input.actor)).sync).toEqual({ status: 'completed', retryable: false });
      expect(f.getRow()).toEqual(before); expect(f.prisma.approvalRequest.updateMany).toHaveBeenCalledOnce();
      expect(resolved).toHaveBeenCalledOnce(); expect(onDecided).toHaveBeenCalledTimes(2);
      // Completed delivery trace makes a later retry a no-op.
      await service.retrySync('a1', input.actor); expect(onDecided).toHaveBeenCalledTimes(2);
    } finally { approvalEventBus.off('resolved', resolved); }
  });

  it('retry owner exception also checks current DB authority rather than an old owner token', async () => {
    const f = fixture(); const onDecided = vi.fn().mockRejectedValue(new Error('projection unavailable'));
    const service = createApprovalDecisionService(f.prisma, { onDecided });
    await service.decide(input);
    await expect(service.retrySync('a1', { userId: 'revoked-owner', roles: ['owner'] }))
      .rejects.toMatchObject({ code: 'APPROVAL_NOT_ASSIGNED', statusCode: 403 });
    expect(onDecided).toHaveBeenCalledOnce(); expect(f.prisma.approvalRequest.updateMany).toHaveBeenCalledOnce();
  });

  it('a synchronous resolved listener failure is visible after commit and cannot turn an approved row into a misleading 500', async () => {
    const f = fixture(); const listener = () => { throw new Error('listener fault'); };
    approvalEventBus.on('resolved', listener);
    try {
      const result = await createApprovalDecisionService(f.prisma).decide(input);
      expect(result.updated.status).toBe('approved');
      expect(result.eventDelivery).toEqual({ status: 'failed', retryable: false, code: 'APPROVAL_EVENT_DELIVERY_FAILED' });
      expect(f.audits).toHaveLength(1);
    } finally { approvalEventBus.off('resolved', listener); }
  });

  it('retry refuses missing/tampered decision facts and unrelated admin identities', async () => {
    const f = fixture(); const service = createApprovalDecisionService(f.prisma, { onDecided: vi.fn(async () => undefined) });
    await service.decide(input);
    await expect(service.retrySync('a1', { userId: 'other', roles: ['admin'] })).rejects.toMatchObject({ statusCode: 403 });
    f.audits[0].detail.approvalDecisionFact.contentFingerprint = 'changed-content';
    await expect(service.retrySync('a1', input.actor)).rejects.toMatchObject({ code: 'APPROVAL_DECISION_FACT_MISSING', statusCode: 409 });
  });
});
