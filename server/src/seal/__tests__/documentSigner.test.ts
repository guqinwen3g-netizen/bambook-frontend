/**
 * §10.3-9 Phase B 批次 2 — 签署人解析测试（单测）。
 *
 * 覆盖：已批准审批 → 签署人；无审批/未批准/无 reviewer → null；查询异常 fail-open；
 * 单据类型映射（未登记类型不误盖）。
 */

import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { buildQuotationApprovalSnapshot, readQuotationApprovalState } from '../../quotations/quotationApprovalSnapshot';
import { buildApprovalSignDocumentSnapshot } from '../../approvals/approvalSignDocumentSnapshotService';
import { approvalReviewContentVersion } from '../../approvals/approvalReviewContent';
import { approvalReviewPreviewDigest } from '../../approvals/approvalReviewDetailService';
import {
  resolveDocumentSigner,
  resolveDocumentSignerByDoc,
  SIGN_TARGET_BY_DOC_TYPE,
} from '../documentSigner';

const makePrisma = async (approval: any, role: any = null, targetId = 'QT_1') => {
  const quotation: any = { id: targetId, quotationNumber: 'QT-1', status: 'Draft', version: 1, currency: 'USD', totalAmount: '10',
    issueDate: '2026-10-05', validUntil: '2026-10-31', deliveryTerms: 'FOB', paymentTerms: 'T/T', salesperson: 'Mia',
    inquiryRef: 'INQ-7', notes: 'Sample quote', customerName: 'Buyer', customerCode: 'B-1', customerRelationId: null,
    lines: [{ id: 'line-1', lineNumber: 1, fabricCode: 'FAB-1', unit: 'm', description: 'Cotton', quantity: '2.000',
      unitPrice: '5.0000', amount: '10.0000', notes: null, imageUrl: null }] };
  let row: any = null;
  let audit: any = null;
  const prisma: any = { approvalRequest: { findFirst: vi.fn(async () => row) },
    quotation: { findUnique: vi.fn(async () => quotation) },
    systemConfig: { findUnique: vi.fn(async () => null) },
    auditLog: { findMany: vi.fn(async () => audit ? [audit] : []) },
    userRole: { findFirst: vi.fn(async () => role) } };
  if (approval) {
    const commercial = buildQuotationApprovalSnapshot(quotation, 'quotation:total_approve', targetId);
    const documentSnapshot = await buildApprovalSignDocumentSnapshot(prisma, { kind: 'Quotation', quotationId: targetId });
    row = { id: 'approval-1', requesterId: 'sales', reviewerId: 'u-leader', actionType: 'quotation:total_approve',
      targetType: 'Quotation', targetId, status: 'approved', decidedAt: new Date('2026-10-05T00:00:00Z'),
      ...approval, payload: { quotationId: targetId, quotationNumber: quotation.quotationNumber, ...commercial, documentSnapshot,
        ...(approval?.payload ?? {}) } };
    const actorId = row.bossFinalBypassBy ?? row.reviewerId;
    const reviewed = { ...row, reviewerId: row.reviewerId };
    audit = { action: row.bossFinalBypassBy ? 'boss_final_bypass' : 'approve_business_request', actorId,
      targetType: 'ApprovalRequest', targetId: row.id, detail: { source: 'api:approvals',
        decisionActorAuthority: { userId: actorId, authorizationLoaded: true, roles: row.bossFinalBypassBy ? ['owner'] : ['manager'] },
        approvalDecisionFact: { schemaVersion: 1, status: 'approved', actionType: row.actionType, targetType: row.targetType,
          targetId, contentFingerprint: commercial.contentFingerprint, decisionActorId: actorId,
          decidedAt: row.decidedAt.toISOString(), frozenReviewerId: reviewed.reviewerId, reviewedContentConfirmed: true,
          reviewContentVersion: approvalReviewContentVersion(reviewed), reviewPreviewDigest: approvalReviewPreviewDigest(reviewed),
          documentSnapshot: { kind: documentSnapshot.kind, sourceRef: documentSnapshot.sourceRef,
            templateVersion: documentSnapshot.templateVersion, sourceFingerprint: documentSnapshot.sourceFingerprint,
            contentFingerprint: documentSnapshot.contentFingerprint } } } };
  }
  return prisma as PrismaClient;
};

function stableJson(value: any): any {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, stableJson(value[key])]));
  return value;
}

describe('resolveDocumentSigner', () => {
  it('报价批准后价格发生变化，不再取旧签署人的章', async () => {
    const prisma = await makePrisma({ reviewerId: 'u-leader' });
    const quotation = await (prisma as any).quotation.findUnique();
    quotation.lines[0].unitPrice = '6'; quotation.lines[0].amount = '12'; quotation.totalAmount = '12';
    expect(await resolveDocumentSigner(prisma, { targetType: 'Quotation', targetId: 'QT_1' })).toBeNull();
    expect((prisma as any).userRole.findFirst).not.toHaveBeenCalled();
  });

  it('报价批准状态缺少真实审批审计，不作为盖章依据', async () => {
    const prisma = await makePrisma({ reviewerId: 'u-leader' });
    (prisma as any).auditLog.findMany.mockResolvedValue([]);
    expect(await resolveDocumentSigner(prisma, { targetType: 'Quotation', targetId: 'QT_1' })).toBeNull();
  });
  it('有效旧版模板签署事实即使自洽也不能继续取章', async () => {
    const prisma = await makePrisma({ reviewerId: 'u-leader' });
    const approval = await (prisma as any).approvalRequest.findFirst();
    const audit = (await (prisma as any).auditLog.findMany())[0];
    const current = approval.payload.documentSnapshot;
    const prior = { ...current, templateVersion: 'quotation-template-v0',
      clauses: { ...current.clauses, version: 'quotation-template-v0' } };
    const { contentFingerprint: _currentFingerprint, ...priorContent } = prior;
    prior.contentFingerprint = createHash('sha256').update(JSON.stringify(stableJson(priorContent))).digest('hex');
    approval.payload.documentSnapshot = prior;
    audit.detail.approvalDecisionFact.reviewContentVersion = approvalReviewContentVersion(approval);
    audit.detail.approvalDecisionFact.reviewPreviewDigest = approvalReviewPreviewDigest(approval);
    audit.detail.approvalDecisionFact.documentSnapshot = { kind: prior.kind, sourceRef: prior.sourceRef,
      templateVersion: prior.templateVersion, sourceFingerprint: prior.sourceFingerprint,
      contentFingerprint: prior.contentFingerprint };

    // Business approval remains historical, but the current official template
    // no longer accepts that old rendered document as a usable signature.
    const quotation = await (prisma as any).quotation.findUnique();
    expect(await readQuotationApprovalState(prisma as any, approval, quotation)).toBe('approved');
    expect(await resolveDocumentSigner(prisma, { targetType: 'Quotation', targetId: 'QT_1' })).toBeNull();
    expect((prisma as any).userRole.findFirst).not.toHaveBeenCalled();
  });
  it('历史签署快照中的图片仍是可变 URL 时不再显示有效签章', async () => {
    const prisma = await makePrisma({ reviewerId: 'u-leader' });
    const approval = await (prisma as any).approvalRequest.findFirst();
    const audit = (await (prisma as any).auditLog.findMany())[0];
    const current = approval.payload.documentSnapshot;
    const legacy = { ...current, data: { ...current.data, lines: current.data.lines.map((line: any) => ({
      ...line, imageUrl: 'https://images.example.test/changed-later.jpg',
    })) } };
    const { contentFingerprint: _currentFingerprint, ...legacyContent } = legacy;
    legacy.contentFingerprint = createHash('sha256').update(JSON.stringify(stableJson(legacyContent))).digest('hex');
    approval.payload.documentSnapshot = legacy;
    const fact = audit.detail.approvalDecisionFact;
    fact.reviewContentVersion = approvalReviewContentVersion(approval);
    fact.reviewPreviewDigest = approvalReviewPreviewDigest(approval);
    fact.documentSnapshot = { kind: legacy.kind, sourceRef: legacy.sourceRef, templateVersion: legacy.templateVersion,
      sourceFingerprint: legacy.sourceFingerprint, contentFingerprint: legacy.contentFingerprint };

    const quotation = await (prisma as any).quotation.findUnique();
    expect(await readQuotationApprovalState(prisma as any, approval, quotation)).toBe('approved');
    expect(await resolveDocumentSigner(prisma, { targetType: 'Quotation', targetId: 'QT_1' })).toBeNull();
    expect((prisma as any).userRole.findFirst).not.toHaveBeenCalled();
  });
  it('老板最终批准时取实际决定人的章，不代用原指派领导的章', async () => {
    const prisma = await makePrisma({ reviewerId: 'original-reviewer', bossFinalBypassBy: 'actual-boss' });
    expect(await resolveDocumentSigner(prisma, { targetType: 'Quotation', targetId: 'QT_1' }))
      .toMatchObject({ userId: 'actual-boss', roleId: null });
    expect((prisma as any).userRole.findFirst.mock.calls[0][0].where.userId).toBe('actual-boss');
  });

  it('报价偏差风控批准不能作为报价签章，即使目标相同', async () => {
    const prisma = await makePrisma({ reviewerId: 'u-leader', actionType: 'quotation:price-deviation' });
    expect(await resolveDocumentSigner(prisma, { targetType: 'Quotation', targetId: 'QT_1' })).toBeNull();
    expect((prisma as any).userRole.findFirst).not.toHaveBeenCalled();
  });

  it('已批准审批 → 返回 reviewerId + 其首个角色', async () => {
    const prisma = await makePrisma({ reviewerId: 'u-leader' }, { roleId: 'role-admin' });
    const approval = await (prisma as any).approvalRequest.findFirst();
    const quotation = await (prisma as any).quotation.findUnique();
    expect(await readQuotationApprovalState(prisma as any, approval, quotation)).toBe('approved');
    const signer = await resolveDocumentSigner(prisma, { targetType: 'Quotation', targetId: 'QT_1' });
    expect(signer).toMatchObject({ userId: 'u-leader', roleId: 'role-admin' });
  });

  it('签署人无角色记录 → roleId 为 null（仍按人解析章）', async () => {
    const prisma = await makePrisma({ reviewerId: 'u-x' }, null);
    expect(await resolveDocumentSigner(prisma, { targetType: 'Quotation', targetId: 'QT_1' }))
      .toMatchObject({ userId: 'u-x', roleId: null });
  });

  it('无已批准审批 → null', async () => {
    expect(await resolveDocumentSigner(await makePrisma(null), { targetType: 'Quotation', targetId: 'QT_1' }))
      .toBeNull();
  });

  it('审批查询异常 → fail-open 返回 null（不抛）', async () => {
    const prisma = {
      approvalRequest: { findFirst: vi.fn().mockRejectedValue(new Error('db down')) },
      userRole: { findFirst: vi.fn() },
    } as unknown as PrismaClient;
    expect(await resolveDocumentSigner(prisma, { targetType: 'Quotation', targetId: 'QT_1' }))
      .toBeNull();
  });

  it('只认 approved + reviewerId 非空（查询条件硬约束）', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { approvalRequest: { findFirst }, userRole: { findFirst: vi.fn() } } as unknown as PrismaClient;
    await resolveDocumentSigner(prisma, { targetType: 'Quotation', targetId: 'QT_1' });
    const where = findFirst.mock.calls[0][0].where;
    expect(where.actionType).toBe('quotation:total_approve');
    expect(where.status).toBe('approved');
    expect(where.OR).toEqual([{ reviewerId: { not: null } }, { bossFinalBypassBy: { not: null } }]);
    expect(where.targetType).toBe('Quotation');
    expect(where.targetId).toBe('QT_1');
  });
});

describe('resolveDocumentSignerByDoc', () => {
  it('未登记签署审批的类型（Order）→ null，不误盖', async () => {
    // 防误盖核心：订单上的风控审批（order:moq-exemption 等）获批 ≠ 订单确认书已签，
    // 故 Order 目标不得进白名单，否则会把风控审批当签署。
    const prisma = await makePrisma({ reviewerId: 'u-leader' }, { roleId: 'role-admin' });
    expect(await resolveDocumentSignerByDoc(prisma, { type: 'Order', sourceRef: 'SO_1' })).toBeNull();
    expect((prisma as any).approvalRequest.findFirst).not.toHaveBeenCalled();
  });

  it('历史订单签署缺少完整冻结内容时不取章', async () => {
    const prisma = await makePrisma({ reviewerId: 'u-leader', actionType: 'order:confirmation_sign' }, { roleId: 'role-admin' });
    const signer = await resolveDocumentSignerByDoc(prisma, { type: 'OrderConfirmation', sourceRef: 'SO_9' });
    expect(signer).toBeNull();
    expect((prisma as any).userRole.findFirst).not.toHaveBeenCalled();
    expect((prisma as any).approvalRequest.findFirst.mock.calls[0][0].where.targetId).toBe('SO_9');
    expect((prisma as any).approvalRequest.findFirst.mock.calls[0][0].where.targetType).toBe('OrderConfirmation');
  });

  it('无 sourceRef → null', async () => {
    const prisma = await makePrisma({ reviewerId: 'u-leader' });
    expect(await resolveDocumentSignerByDoc(prisma, { type: 'Quotation', sourceRef: null })).toBeNull();
  });

  it('已登记类型（Quotation）→ 委托按 Quotation 目标解析', async () => {
    const prisma = await makePrisma({ reviewerId: 'u-leader' }, { roleId: 'role-admin' }, 'QT_9');
    const signer = await resolveDocumentSignerByDoc(prisma, { type: 'Quotation', sourceRef: 'QT_9' });
    expect(signer).toMatchObject({ userId: 'u-leader', roleId: 'role-admin' });
    expect((prisma as any).approvalRequest.findFirst.mock.calls[0][0].where.targetId).toBe('QT_9');
  });

  it('映射表只登记已有签署审批流的类型（防误盖护栏）', () => {
    expect(Object.keys(SIGN_TARGET_BY_DOC_TYPE))
      .toEqual(['Quotation', 'OrderConfirmation', 'PaymentRequest', 'Contract']);
  });
});
