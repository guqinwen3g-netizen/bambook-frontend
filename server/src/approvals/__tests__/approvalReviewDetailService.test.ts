import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { approvalReviewContentVersion } from '../approvalReviewContent';
import { buildApprovalReviewDetail, readApprovalReviewDetail } from '../approvalReviewDetailService';
import { buildQuotationSnapshot, canonicalQuotationJson } from '../../quotations/quotationApprovalSnapshot';
import { buildApprovalSignDocumentSnapshot } from '../approvalSignDocumentSnapshotService';
import { ACTION_TOTAL_APPROVE, buildQuotationApprovalSnapshot } from '../../quotations/quotationApprovalSnapshot';

const sha = 'a'.repeat(64);
function paymentApproval(overrides: Record<string, any> = {}) {
  const row = {
    id: 'APR-PAY-1', requesterId: 'seller-1', reviewerId: 'manager-1', status: 'pending',
    actionType: 'finance:payment_request', targetType: 'PaymentRequest', targetId: 'PR-1',
    payload: { requestNumber: 'PAY-2026-001', totalAmount: '120.00', currency: 'USD', paymentCategory: '样品费',
      supplierId: 'SUP-1', supplierName: '织造供应商', attachments: [
        { id: 'mail-1', fileName: '对账邮件.eml', href: '/api/v1/email/attachments/mail-1/download' },
        { id: 'unsafe', fileName: '本地路径', href: '/Users/anyone/private.pdf' },
      ] },
    ...overrides,
  };
  return { ...row, reviewContentVersion: approvalReviewContentVersion(row as any) };
}
function paymentPrisma(options: { current?: any; audit?: any[]; currentError?: boolean } = {}) {
  const current = options.current ?? { id: 'PR-1', requestNumber: 'PAY-2026-001', payeeType: 'supplier',
    supplierId: 'SUP-1', supplierName: '织造供应商', totalAmount: '120.00', currency: 'USD', paymentCategory: '样品费',
    requestDate: '2026-10-01', expectedPaymentDate: '2026-10-08', status: 'Pending', approvalRequestId: 'APR-PAY-1',
    customerRelationId: null, customerName: null, remark: '样品测试', attachments: [] };
  return {
    paymentRequest: { findUnique: vi.fn(async () => { if (options.currentError) throw new Error('permission denied'); return current; }) },
    auditLog: { findMany: vi.fn(async () => options.audit ?? []) },
  } as any;
}

describe('approval review detail projection', () => {
  it('requires and rechecks the same complete quotation document before total approval', async () => {
    const quotation: any = { id: 'QT-SIGN-1', quotationNumber: 'QT-2026-88', status: 'Draft', version: 2,
      currency: 'USD', totalAmount: '123.4500', issueDate: '2026-10-05', validUntil: '2026-10-31',
      deliveryTerms: 'FOB Shanghai', paymentTerms: '30% deposit', salesperson: 'Mia', inquiryRef: 'INQ-9', notes: 'Navy shade',
      customerName: 'Buyer', customerCode: 'B-9', customerRelationId: 'C-9', deletedAt: null,
      lines: [{ id: 'QL-SIGN-1', lineNumber: 1, fabricCode: 'FAB-9', description: 'Cotton twill', quantity: '3.000',
        unit: 'M', unitPrice: '41.1500', amount: '123.4500', notes: null, imageUrl: null }] };
    const prisma: any = { quotation: { findUnique: vi.fn(async () => quotation) },
      systemConfig: { findUnique: vi.fn(async () => null) }, auditLog: { findMany: vi.fn(async () => []) } };
    const documentSnapshot = await buildApprovalSignDocumentSnapshot(prisma, { kind: 'Quotation', quotationId: quotation.id });
    const approval = { id: 'APR-QT-SIGN-1', requesterId: 'seller-1', reviewerId: 'manager-1', status: 'pending',
      actionType: ACTION_TOTAL_APPROVE, targetType: 'Quotation', targetId: quotation.id,
      payload: { quotationId: quotation.id, quotationNumber: quotation.quotationNumber,
        ...buildQuotationApprovalSnapshot(quotation, ACTION_TOTAL_APPROVE, quotation.id), documentSnapshot } };

    const detail = await readApprovalReviewDetail(prisma, approval as any, { canReadCurrentSource: true });
    expect(detail.canApprove).toBe(true);
    expect(detail.currentSource.status).toBe('available');
    expect(detail.frozen.fields).toContainEqual({ key: 'quotation.inquiryRef', label: '询价参考', value: 'INQ-9' });
    expect(detail.frozen.fields).toContainEqual({ key: 'quotation.lines.1.unitPrice', label: '第 1 行精确单价', value: '41.1500' });
    expect(detail.frozen.fields).toContainEqual({ key: 'quotation.clauses.1', label: 'Delivery 交货', value: 'FOB Shanghai' });

    prisma.systemConfig.findUnique.mockResolvedValue({ id: 'global::company.exporterProfile', version: 2,
      updatedAt: new Date('2026-10-04T00:00:00Z'), encrypted: false,
      value: { nameEn: 'Changed Seller', addressEn: 'New Address' } });
    const changed = await readApprovalReviewDetail(prisma, approval as any, { canReadCurrentSource: true });
    expect(changed.canApprove).toBe(false);
    expect(changed.approvalBlockers).toContain('报价单正文、条款、卖方档案或模板与签署冻结版本不一致');
  });

  it('blocks legacy total-approval rows without a frozen quote document and does not claim failed current reads', async () => {
    const approval = { id: 'APR-QT-OLD', requesterId: 'seller-1', reviewerId: 'manager-1', status: 'pending',
      actionType: ACTION_TOTAL_APPROVE, targetType: 'Quotation', targetId: 'QT-OLD',
      payload: { quotationId: 'QT-OLD', quotationNumber: 'QT-OLD', contentFingerprint: sha,
        quotationSnapshot: { schemaVersion: 2, quotationId: 'QT-OLD', currency: 'USD', totalAmount: '1', lines: [{ id: 'L-1' }] } } };
    const prisma: any = { quotation: { findUnique: vi.fn(async () => { throw new Error('db unavailable'); }) },
      systemConfig: { findUnique: vi.fn(async () => null) }, auditLog: { findMany: vi.fn(async () => []) } };
    const detail = await readApprovalReviewDetail(prisma, approval as any, { canReadCurrentSource: true });
    expect(detail.currentSource.status).toBe('unavailable');
    expect(detail.currentSource.label).toContain('不能用冻结快照代替');
    expect(detail.canApprove).toBe(false);
    expect(detail.approvalBlockers).toContain('完整冻结报价单、原生条款、卖方档案和模板依据');
  });

  it('checks short-ship basis under the actual creator action and accepts its complete frozen payload', () => {
    const row = { id: 'APR-SHORT-1', requesterId: 'shipper-1', reviewerId: 'manager-1', status: 'pending',
      actionType: 'order:short-ship-exemption', targetType: 'OrderLine', targetId: 'OL-1', payload: {
        policyKey: 'short_ship_exemption', shipmentId: 'SHIP-1', orderId: 'ORD-1', itemNo: '001', contractQty: 10000,
        shippedQty: 9000, allowedMin: 9500, shortage: 500, tolerancePct: 5, toleranceSource: 'internal_standard',
      } };
    const valid = buildApprovalReviewDetail({ ...row } as any);
    expect(valid.approvalBlockers).toEqual([]);
    const missing = buildApprovalReviewDetail({ ...row, payload: { ...row.payload, allowedMin: null, toleranceSource: null } } as any);
    expect(missing.canApprove).toBe(false);
    expect(missing.approvalBlockers).toContain('订单行编号、合同量、已出运量和短装计算依据');
    expect(missing.approvalBlockers).toContain('客户或内部公差依据');
  });

  it('does not query or claim current business facts until the caller verifies original read scope', async () => {
    const prisma = paymentPrisma();
    const detail = await readApprovalReviewDetail(prisma, paymentApproval() as any);
    expect(prisma.paymentRequest.findUnique).not.toHaveBeenCalled();
    expect(detail.currentSource).toMatchObject({ status: 'unavailable', label: '原业务读取权限尚未核验', fields: [] });
    expect(detail.canApprove).toBe(false);
    expect(detail.approvalBlockers).toContain('原业务读取权限或当前依据未通过核验');
  });

  it('requires a creator-shaped DR013 snapshot and confirms its pending row, approval link, and exact scope live', async () => {
    const payload = { exceptionNumber: 'EXC-2026-001', exceptionCategory: 'process', subCategory: null,
      bypassedApprovalIds: [], exceptionReason: '客户书面确认本批次可以按当前规格先行处理，并补齐后续资料后完成复核。',
      riskMitigationPlan: '负责人收到客户确认后跟进补件并在七日内完成复核',
      scope: { targetType: 'Order', targetId: 'ORD-1', action: 'ship', validUntil: null, maxUses: 1 },
      responsibleOwnerId: 'staff-7' };
    const approval = { id: 'APR-EXC-1', requesterId: 'requester-1', reviewerId: 'manager-1', status: 'pending',
      actionType: 'order:dr013-exception', targetType: 'Dr013ExceptionRequest', targetId: 'EXC-ID-1', payload };
    const current = { id: 'EXC-ID-1', exceptionNumber: payload.exceptionNumber, exceptionCategory: payload.exceptionCategory,
      subCategory: null, status: 'Pending', exceptionReason: payload.exceptionReason, riskMitigationPlan: payload.riskMitigationPlan,
      requesterId: 'requester-1', reviewerId: 'manager-1', approvalRequestId: 'APR-EXC-1', deletedAt: null,
      bypassedApprovalIds: [], attachments: { files: [], scope: { ...payload.scope, responsibleOwnerId: 'staff-7', usedCount: 0, consumptions: [] } } };
    const prisma: any = { dr013ExceptionRequest: { findUnique: vi.fn(async () => current) }, auditLog: { findMany: vi.fn(async () => []) } };
    const detail = await readApprovalReviewDetail(prisma, approval as any, { canReadCurrentSource: true });
    expect(detail.currentSource.status).toBe('available');
    expect(detail.canApprove).toBe(true);

    const changed = await readApprovalReviewDetail({ ...prisma, dr013ExceptionRequest: { findUnique: vi.fn(async () => ({ ...current,
      attachments: { ...current.attachments, scope: { ...current.attachments.scope, targetId: 'ORD-2' } } })) } } as any,
      approval as any, { canReadCurrentSource: true });
    expect(changed.canApprove).toBe(false);
    expect(changed.approvalBlockers).toContain('例外申请不再待审批，关联编号或批准适用范围与冻结申请不一致');
  });

  it('binds price-deviation approval to the complete quotation snapshot and blocks any live-source change', async () => {
    const quotation = { id: 'Q-1', quotationNumber: 'QT-2026-1', status: 'Draft', version: 3, currency: 'USD', totalAmount: '100',
      notes: '付款条款见合同', customerRelationId: 'C-1', customerName: 'Buyer', customerCode: 'B-01', developmentCaseId: null,
      orderId: null, orderLineId: null, issueDate: '2026-10-01', validUntil: '2026-10-30', deliveryTerms: 'FOB', paymentTerms: 'T/T',
      paymentInstrument: 'T/T', baseCurrency: 'CNY', exchangeRate: '7.1', trackAMedianUsd: '1', trackAUnit: 'M', trackBFinalUsd: '1.2',
      priceDeviationPercent: 20, priceDeviationLevel: 'warn', priceApprovalId: 'APR-Q-1', deletedAt: null,
      lines: [{ id: 'QL-1', lineNumber: 1, fabricCode: 'FAB-1', description: 'Cotton', quantity: '10', unit: 'M', unitPrice: '10',
        amount: '100', notes: null, imageUrl: null, moqOverride: null }] };
    const quotationSnapshot = buildQuotationSnapshot(quotation);
    const contentFingerprint = createHash('sha256').update(canonicalQuotationJson({ actionType: 'quotation:price-deviation',
      targetType: 'Quotation', targetId: 'Q-1', quotationSnapshot })).digest('hex');
    const approval = { id: 'APR-Q-1', requesterId: 'seller-1', reviewerId: 'manager-1', status: 'pending',
      actionType: 'quotation:price-deviation', targetType: 'Quotation', targetId: 'Q-1', payload: {
        policyKey: 'price_approval', quotationId: 'Q-1', quotationNumber: quotation.quotationNumber, quotationSnapshot, contentFingerprint,
        trackAMedianUsd: 1, trackAUnit: 'M', trackBFinalUsd: 1.2, deviationPercent: 20, level: 'warn',
        hitConditions: ['dual_track_deviation'], ruleFindings: [{ rule: 'dual_track_deviation' }], requestedAt: '2026-10-01T10:00:00.000Z',
        source: 'quotation-dual-track' } };
    const prisma: any = { quotation: { findUnique: vi.fn(async () => quotation) }, auditLog: { findMany: vi.fn(async () => []) } };
    const detail = await readApprovalReviewDetail(prisma, approval as any, { canReadCurrentSource: true });
    expect(detail.canApprove).toBe(true);
    expect(detail.currentSource.fields).toContainEqual({ key: 'version', label: '当前报价版本', value: '3' });

    const changed = await readApprovalReviewDetail({ ...prisma, quotation: { findUnique: vi.fn(async () => ({ ...quotation, totalAmount: '101' })) } } as any,
      approval as any, { canReadCurrentSource: true });
    expect(changed.canApprove).toBe(false);
    expect(changed.approvalBlockers).toContain('当前报价版本或双轨价格偏差依据与冻结申请不一致');
  });

  it('reuses the native short-shipment calculation and blocks a changed order-line quantity', async () => {
    const approval = { id: 'APR-SHORT-2', requesterId: 'shipper-1', reviewerId: 'manager-1', status: 'pending',
      actionType: 'order:short-ship-exemption', targetType: 'OrderLine', targetId: 'OL-1', payload: {
        policyKey: 'short_ship_exemption', shipmentId: 'SHIP-1', orderId: 'ORD-1', itemNo: '001', unit: 'PCS',
        contractQty: 10000, shippedQty: 9000, allowedMin: 9500, shortage: 500, tolerancePct: 5, toleranceSource: 'line_override',
      } };
    const line = { id: 'OL-1', itemNo: '001', orderId: 'ORD-1', quantity: '10000', shipmentQuantity: '9000', unit: 'PCS',
      tolerancePercent: 5, toleranceSource: 'line_override' };
    const prisma: any = { orderLine: { findUnique: vi.fn(async () => line) }, order: { findUnique: vi.fn(async () => ({ customerRelationId: null })) },
      shipment: { findUnique: vi.fn(async () => ({ id: 'SHIP-1', shipmentNumber: 'S-1', status: 'Loading', deletedAt: null })),
        findMany: vi.fn(async () => [{ id: 'SHIP-1', status: 'Loading' }]) },
      shipmentOrderAllocation: { findFirst: vi.fn(async () => ({ id: 'SOA-1' })),
        findMany: vi.fn(async () => [{ shipmentId: 'SHIP-1', plannedQty: '9000', actualQty: '9000' }]) },
      systemConfig: { findUnique: vi.fn(async () => null) }, auditLog: { findMany: vi.fn(async () => []) } };
    const detail = await readApprovalReviewDetail(prisma, approval as any, { canReadCurrentSource: true });
    expect(detail.canApprove).toBe(true);
    expect(detail.currentSource.fields).toContainEqual({ key: 'shipmentNumber', label: '关联运单', value: 'S-1' });

    prisma.orderLine.findUnique.mockResolvedValue({ ...line, quantity: '10001' });
    const changed = await readApprovalReviewDetail(prisma, approval as any, { canReadCurrentSource: true });
    expect(changed.canApprove).toBe(false);
    expect(changed.approvalBlockers).toContain('订单行、运单分配或当前公差计算与短装冻结依据不一致');
  });

  it('compares the actual payment row, exposes only authenticated attachment routes, and preserves cancelled history', async () => {
    const prisma = paymentPrisma({ audit: [
      { id: 'audit-cancel', action: 'approval_request_cancelled', actorId: 'seller-1', actor: { displayName: '申请人' },
        createdAt: new Date('2026-10-02T00:00:00.000Z'), detail: { approvalId: 'APR-PAY-1', status: 'cancelled', decisionNote: '已由新申请替代' } },
      { id: 'audit-decision', action: 'approve_business_request', actorId: 'manager-1', actor: { displayName: '审批人' },
        createdAt: new Date('2026-10-03T00:00:00.000Z'), detail: { approvalDecisionFact: { status: 'approved' }, decisionNote: '收款资料已核对' } },
    ] });
    const detail = await readApprovalReviewDetail(prisma, paymentApproval() as any, {
      canReadCurrentSource: true, canReadAttachments: true,
    });
    expect(detail.currentSource.status).toBe('available');
    expect(detail.currentSource.fields).toContainEqual({ key: 'status', label: '当前状态', value: 'Pending' });
    expect(detail.canApprove).toBe(true);
    expect(detail.frozen.attachments).toEqual([{ id: 'mail-1', fileName: '对账邮件.eml', href: '/api/v1/email/attachments/mail-1/download' }]);
    expect(detail.frozen.attachmentStatus).toBe('available');
    expect(detail.decisionHistory.map(entry => entry.status)).toEqual(['cancelled', 'approved']);
    expect(detail.decisionHistory[0]).toMatchObject({ actorId: 'seller-1', actorName: '申请人', decisionNote: '已由新申请替代' });
    expect(detail.decisionHistoryStatus).toBe('available');
  });

  it('blocks approval when the authorized live source differs from the frozen payment facts', async () => {
    const prisma = paymentPrisma({ current: { id: 'PR-1', requestNumber: 'PAY-2026-001', supplierId: 'SUP-1',
      supplierName: '织造供应商', totalAmount: '121.00', currency: 'USD', paymentCategory: '样品费', status: 'Pending',
      approvalRequestId: 'APR-PAY-1' } });
    const detail = await readApprovalReviewDetail(prisma, paymentApproval() as any, { canReadCurrentSource: true });
    expect(detail.currentSource.status).toBe('available');
    expect(detail.canApprove).toBe(false);
    expect(detail.approvalBlockers).toContain('当前付款对象、金额、币种或待审批状态与冻结申请不一致');
  });

  it('does not turn an unknown business path into a blanket rejection', () => {
    const detail = buildApprovalReviewDetail({ id: 'APR-UNKNOWN', requesterId: 'u1', reviewerId: 'u2', status: 'pending',
      actionType: 'legacy:custom-review', targetType: 'CustomRecord', targetId: 'C-1',
      payload: { arbitraryLegacyShape: { value: 'kept as display-only text' }, attachmentPath: '/tmp/private.pdf' } } as any);
    expect(detail.approvalBlockers).toEqual([]);
    expect(detail.canApprove).toBe(true);
    expect(detail.frozen.fields).toContainEqual(expect.objectContaining({ value: 'kept as display-only text' }));
    expect(detail.frozen.attachments).toEqual([]);
  });
});
