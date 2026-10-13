import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildQuotationApprovalSignDocumentSnapshot } from '../approvalSignDocumentSnapshotService';
import { buildQuotationApprovalSnapshot, ACTION_LINE_APPROVE, ACTION_TOTAL_APPROVE } from '../../quotations/quotationApprovalSnapshot';
import { approvalReviewContentVersion } from '../approvalReviewContent';
import { createQuotationApprovalAmendmentService } from '../quotationAmendmentService';

const mocks = vi.hoisted(() => ({ evaluatePrice: vi.fn(), validateMoq: vi.fn(), findMoq: vi.fn(),
  actualMoqLines: vi.fn(), snapshotVersion: vi.fn() }));
vi.mock('../../pricing/priceDeviationRuleService', () => ({ createPriceDeviationRuleService: () => ({ evaluateQuotationRules: mocks.evaluatePrice }) }));
vi.mock('../../moq/moqConfigService', () => ({ createMoqConfigService: () => ({}) }));
vi.mock('../../moq/moqResolutionService', () => ({ createMoqResolutionService: () => ({}) }));
vi.mock('../../moq/moqValidationService', () => ({ createMoqValidationService: () => ({ validateCreate: mocks.validateMoq }) }));
vi.mock('../../moq/moqApprovalBasis', () => ({ findCurrentMoqApproval: mocks.findMoq, buildActualMoqLines: mocks.actualMoqLines }));
vi.mock('../../quotations/quotationService', () => ({ snapshotQuotationVersion: mocks.snapshotVersion }));

const quote = () => ({ id: 'Q-1', quotationNumber: 'QT-1', version: 4, status: 'Draft', deletedAt: null,
  currency: 'USD', totalAmount: '100.0000', customerRelationId: 'C-1', customerName: 'Customer',
  exchangeRate: '7.1', validUntil: '2026-12-01', notes: 'old note', priceDeviationLevel: 'warn',
  moqSnapshot: { source: 'moq_config' }, lines: [{ id: 'L-1', lineNumber: 1, fabricCode: 'FAB-1',
    description: 'Fabric', quantity: '10', unit: 'M', unitPrice: '10', amount: '100', notes: null, moqOverride: null }] });

function fixture(overrides: { actionType?: string; sourceQuote?: any; status?: string; requesterId?: string; reviewerId?: string } = {}) {
  const source = overrides.sourceQuote ?? quote();
  const actionType = overrides.actionType ?? ACTION_LINE_APPROVE;
  const baseApproval = { id: 'A-1', requesterId: overrides.requesterId ?? 'requester', reviewerId: overrides.reviewerId ?? 'reviewer',
    actionType, targetType: actionType === ACTION_LINE_APPROVE ? 'QuotationLine' : 'Quotation',
    targetId: actionType === ACTION_LINE_APPROVE ? 'L-1' : 'Q-1', status: overrides.status ?? 'pending',
    payload: actionType === ACTION_LINE_APPROVE || actionType === ACTION_TOTAL_APPROVE
      ? { quotationId: 'Q-1', ...buildQuotationApprovalSnapshot(source, actionType,
        actionType === ACTION_LINE_APPROVE ? 'L-1' : 'Q-1') } : { quotationId: 'Q-1' } };
  const state = { quotation: source, approval: baseApproval, writes: [] as any[] };
  const tx: any = {
    approvalRequest: { findUnique: vi.fn(async () => state.approval) },
    quotation: { findUnique: vi.fn(async () => ({ ...state.quotation,
      lines: state.quotation.lines.map((line: any) => ({ ...line })) })),
      updateMany: vi.fn(async (args: any) => { state.writes.push(['quotation.updateMany', args]);
        Object.assign(state.quotation, args.data); return { count: 1 }; }) },
    quotationLine: { updateMany: vi.fn(async (args: any) => { state.writes.push(['line.updateMany', args]);
        const line = state.quotation.lines.find((candidate: any) => candidate.id === args.where.id);
        if (line) Object.assign(line, args.data);
        return { count: 1 }; }) },
    quotationVersion: { create: vi.fn(async (args: any) => { state.writes.push(['version.create', args]); return args.data; }) },
    auditLog: { create: vi.fn(async (args: any) => { state.writes.push(['audit.create', args]); return args.data; }),
      findFirst: vi.fn(async () => null) },
    systemConfig: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  };
  const service = createQuotationApprovalAmendmentService({ prisma: tx });
  return { service, tx, state, approval: baseApproval, reviewVersion: approvalReviewContentVersion(baseApproval) };
}

async function totalFixture(exporterProfile?: { value: Record<string, unknown>; version: number; updatedAt: bigint }) {
  const f = fixture({ actionType: ACTION_TOTAL_APPROVE });
  if (exporterProfile) {
    f.tx.systemConfig.findUnique.mockResolvedValue({
      id: 'global::company.exporterProfile', encrypted: false,
      value: exporterProfile.value, version: exporterProfile.version, updatedAt: exporterProfile.updatedAt,
    });
  }
  const documentSnapshot = await buildQuotationApprovalSignDocumentSnapshot(f.tx, f.state.quotation);
  f.approval.payload.documentSnapshot = documentSnapshot;
  return { ...f, reviewVersion: approvalReviewContentVersion(f.approval) };
}

describe('quotation approval amendment service', () => {
  beforeEach(() => {
    mocks.evaluatePrice.mockReset().mockResolvedValue({ level: 'ok', findings: { hitConditions: [] } });
    mocks.validateMoq.mockReset().mockResolvedValue({ ok: true, basisHash: 'moq-v1', lines: [] });
    mocks.findMoq.mockReset().mockResolvedValue(null);
    mocks.actualMoqLines.mockReset().mockResolvedValue([{ quantity: '10', unit: 'M', businessLine: 'fabric' }]);
    mocks.snapshotVersion.mockReset().mockResolvedValue(undefined);
  });

  it('previews a single exact line price change without writing any business or audit rows', async () => {
    const f = fixture();
    const preview = await f.service.preview({ approvalId: 'A-1', actorId: 'reviewer', reviewContentVersion: f.reviewVersion,
      amendment: { lineUnitPrices: [{ lineId: 'L-1', unitPrice: '9.5' }], reason: '按领导要求调整本条报价并重新核价' } });
    expect(preview).toMatchObject({ approvalId: 'A-1', sourceVersion: 4, finalVersion: 5,
      diff: expect.arrayContaining([{ field: 'lines.L-1.unitPrice', before: '10', after: '9.5000' }]) });
    expect(f.state.writes).toEqual([]);
    expect(f.tx.quotation.updateMany).not.toHaveBeenCalled();
    expect(f.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('confirms through the caller transaction, snapshots old version, updates only whitelisted fields and appends immutable diff/reason', async () => {
    const f = fixture();
    const originalQuote = { ...f.state.quotation, lines: f.state.quotation.lines.map((line: any) => ({ ...line })) };
    const amendment: any = { lineUnitPrices: [{ lineId: 'L-1', unitPrice: '9.5' }], validUntil: '2026-12-31',
      notes: 'final note', reason: '按客户最新谈判意见修正报价单价和有效期' };
    const preview = await f.service.preview({ approvalId: 'A-1', actorId: 'reviewer', reviewContentVersion: f.reviewVersion, amendment });
    amendment.previewVersion = preview.previewVersion;
    amendment.finalContentVersion = preview.finalContentVersion;
    const result = await f.service.applyInTransaction(f.tx, f.approval, 'reviewer', amendment, f.reviewVersion);
    expect(result).toMatchObject({ sourceVersion: 4, finalVersion: 5, priceApprovalInvalidated: true });
    expect(mocks.snapshotVersion).toHaveBeenCalledWith(f.tx, originalQuote, 'reviewer', amendment.reason);
    expect(f.tx.quotationLine.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'L-1', quotationId: 'Q-1' }, data: expect.objectContaining({ unitPrice: expect.anything(), amount: expect.anything() }),
    }));
    expect(f.tx.quotation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'Q-1', version: 4, status: 'Draft', deletedAt: null },
      data: expect.objectContaining({ version: 5, validUntil: '2026-12-31', notes: 'final note', priceApprovalId: null }),
    }));
    expect(f.tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      action: 'quotation_approval_amended', targetId: 'A-1', detail: expect.objectContaining({
        requesterId: 'requester', decisionActorId: 'reviewer', reason: amendment.reason, finalVersion: 5,
        diff: expect.arrayContaining([expect.objectContaining({ field: 'notes', after: 'final note' })]),
      }),
    }) }));
    expect(f.tx.$transaction).not.toHaveBeenCalled();
  });

  it('binds total amendment preview to the exact persisted final document snapshot and audits it in the same transaction', async () => {
    const f = await totalFixture();
    const amendment: any = { lineUnitPrices: [{ lineId: 'L-1', unitPrice: '9.5' }], validUntil: '2026-12-31',
      notes: 'final signed note', reason: '按客户最新谈判意见修正报价单价和有效期' };
    const preview = await f.service.preview({ approvalId: 'A-1', actorId: 'reviewer',
      reviewContentVersion: f.reviewVersion, amendment });
    expect(preview).toMatchObject({ finalVersion: 5, diff: expect.arrayContaining([
      { field: 'lines.L-1.unitPrice', before: '10', after: '9.5000' },
      { field: 'notes', before: 'old note', after: 'final signed note' },
    ]) });
    // The API returns the business diff; potentially large embedded image data stays server-side.
    expect(preview).not.toHaveProperty('finalDocumentSnapshot');
    amendment.previewVersion = preview.previewVersion;
    amendment.finalContentVersion = preview.finalContentVersion;

    const result = await f.service.applyInTransaction(f.tx, f.approval, 'reviewer', amendment, f.reviewVersion);
    const audit = f.tx.auditLog.create.mock.calls[0][0].data;
    const independentlyRebuiltFinalDocument = await buildQuotationApprovalSignDocumentSnapshot(f.tx, f.state.quotation);
    expect(result).toMatchObject({ sourceVersion: 4, finalVersion: 5, priceApprovalInvalidated: true,
      finalDocumentKind: 'Quotation', finalDocumentSnapshot: { templateVersion: expect.any(String),
        contentFingerprint: independentlyRebuiltFinalDocument.contentFingerprint } });
    expect(audit.detail).toMatchObject({ previewVersion: preview.previewVersion, finalVersion: 5,
      finalDocumentSnapshot: independentlyRebuiltFinalDocument });
    expect(f.state.quotation).toMatchObject({ version: 5, validUntil: '2026-12-31', notes: 'final signed note' });
    expect(f.tx.$transaction).not.toHaveBeenCalled();
  });

  it('treats reordered frozen exporter source keys as the same basis but blocks a real exporter value or version change', async () => {
    const frozenExporter = { value: { nameEn: 'Frozen seller', addressEn: 'Frozen address' }, version: 7, updatedAt: BigInt(7000) };
    const f = await totalFixture(frozenExporter);
    const exporterProfileSource = f.approval.payload.documentSnapshot.exporterProfileSource;
    f.approval.payload.documentSnapshot.exporterProfileSource = Object.fromEntries(Object.entries(exporterProfileSource).reverse());
    const amendment = { lineUnitPrices: [{ lineId: 'L-1', unitPrice: '9.5' }], reason: '根据本次谈判调整报价并重新核价' };

    const preview = await f.service.preview({ approvalId: 'A-1', actorId: 'reviewer', reviewContentVersion: f.reviewVersion, amendment });
    expect(preview).toMatchObject({ finalVersion: 5 });
    expect(f.state.writes).toEqual([]);

    f.tx.systemConfig.findUnique.mockResolvedValue({
      id: 'global::company.exporterProfile', encrypted: false,
      value: { nameEn: 'Changed seller', addressEn: 'Frozen address' }, version: 8, updatedAt: BigInt(8000),
    });
    await expect(f.service.preview({ approvalId: 'A-1', actorId: 'reviewer', reviewContentVersion: f.reviewVersion, amendment }))
      .rejects.toMatchObject({ code: 'APPROVAL_CONTENT_CHANGED' });
    expect(f.state.writes).toEqual([]);

    f.tx.systemConfig.findUnique.mockResolvedValue({
      id: 'global::company.exporterProfile', encrypted: false,
      value: frozenExporter.value, version: 8, updatedAt: BigInt(8000),
    });
    await expect(f.service.preview({ approvalId: 'A-1', actorId: 'reviewer', reviewContentVersion: f.reviewVersion, amendment }))
      .rejects.toMatchObject({ code: 'APPROVAL_CONTENT_CHANGED' });
    expect(f.state.writes).toEqual([]);
  });

  it('refuses line amendments outside the approved target, stale previews, old notes-less approvals and non-draft sources', async () => {
    const source = quote();
    source.lines.push({ id: 'L-2', lineNumber: 2, fabricCode: 'FAB-2', description: 'Second fabric', quantity: '2',
      unit: 'M', unitPrice: '10', amount: '20', notes: null, moqOverride: null });
    source.totalAmount = '120';
    const f = fixture({ sourceQuote: source });
    await expect(f.service.preview({ approvalId: 'A-1', actorId: 'reviewer', reviewContentVersion: f.reviewVersion,
      amendment: { lineUnitPrices: [{ lineId: 'L-2', unitPrice: '9' }], reason: '修改越权报价行必须拒绝' } }))
      .rejects.toMatchObject({ code: 'QUOTATION_AMENDMENT_SCOPE_DENIED', statusCode: 403 });
    const amendment: any = { lineUnitPrices: [{ lineId: 'L-1', unitPrice: '9.5' }], reason: '按领导要求调整本条报价并重新核价',
      previewVersion: '0'.repeat(64), finalContentVersion: '1'.repeat(64) };
    await expect(f.service.applyInTransaction(f.tx, f.approval, 'reviewer', amendment, f.reviewVersion))
      .rejects.toMatchObject({ code: 'QUOTATION_AMENDMENT_PREVIEW_STALE' });
    const legacy = fixture();
    legacy.approval.payload.quotationSnapshot = { ...legacy.approval.payload.quotationSnapshot, schemaVersion: 1 };
    legacy.approval.payload.contentFingerprint = '1'.repeat(64);
    legacy.approval.payload.quotationId = 'Q-1';
    const legacyReview = approvalReviewContentVersion(legacy.approval);
    await expect(legacy.service.preview({ approvalId: 'A-1', actorId: 'reviewer', reviewContentVersion: legacyReview,
      amendment: { notes: 'x', reason: '按领导要求补充有效报价备注' } }))
      .rejects.toMatchObject({ code: 'QUOTATION_APPROVAL_UNVERIFIED' });
  });

  it('does not let quote amendment approve the separate price-deviation action or bypass fresh price/MOQ blocks', async () => {
    const priceDeviation = fixture({ actionType: 'quotation:price-deviation' });
    await expect(priceDeviation.service.preview({ approvalId: 'A-1', actorId: 'reviewer', reviewContentVersion: priceDeviation.reviewVersion,
      amendment: { notes: 'x', reason: '修改价格门禁审批不允许走报价修改通道' } })).rejects.toMatchObject({ code: 'QUOTATION_AMENDMENT_NOT_ALLOWED' });
    const priceBlocked = fixture();
    mocks.evaluatePrice.mockResolvedValueOnce({ level: 'block', findings: { belowCost: { hit: true } } });
    await expect(priceBlocked.service.preview({ approvalId: 'A-1', actorId: 'reviewer', reviewContentVersion: priceBlocked.reviewVersion,
      amendment: { lineUnitPrices: [{ lineId: 'L-1', unitPrice: '9.5' }], reason: '把报价改到成本价以下应被红线阻断' } }))
      .rejects.toMatchObject({ code: 'PRICE_DEVIATION_BLOCKED' });
    const moqBlocked = fixture();
    mocks.validateMoq.mockResolvedValueOnce({ ok: false, basisHash: 'moq-v1', lines: [{ unresolvedReason: null }] });
    await expect(moqBlocked.service.preview({ approvalId: 'A-1', actorId: 'reviewer', reviewContentVersion: moqBlocked.reviewVersion,
      amendment: { notes: 'x', reason: '没有当前 MOQ 豁免不能通过修订审批' } })).rejects.toMatchObject({ code: 'MOQ_APPROVAL_REQUIRED' });
  });
});
