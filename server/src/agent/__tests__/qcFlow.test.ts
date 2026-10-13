import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  buildQcGarmentReviewDraft,
  commitQcGarmentReview,
  buildQcFabricReviewDraft,
  commitQcFabricReview,
  buildQcSignReportDraft,
  commitQcSignReport,
  validateQcGarmentReviewDraftSemantics,
  validateQcFabricReviewDraftSemantics,
  validateQcSignReportDraftSemantics,
  buildQcFlowError,
  type QcFlowErrorCode,
} from '../qcFlow';

import { QcReportError } from '../../qc/qcReportAuthority';
import type { ActorContext } from '../types';
const qcActor = (userId: string): ActorContext => ({ userId, roles: ['sales'], departmentIds: [],
  permissionScopes: ['qc:read', 'qc:write'], permissionsAuthoritative: true, memoryScopes: [], knowledgeScopes: [], toolScopes: ['qc'] });

const mocks = vi.hoisted(() => ({
  reviewGarmentSample: vi.fn(),
  reviewFabricSample: vi.fn(),
  signReport: vi.fn(),
}));

vi.mock('../../qc/qcChainService', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    createQcChainService: () => ({
      reviewGarmentSample: mocks.reviewGarmentSample,
      reviewFabricSample: mocks.reviewFabricSample,
    }),
  };
});
vi.mock('../../qc/qcService', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    createQcService: () => ({
      signReport: mocks.signReport,
    }),
  };
});

const garmentInput = { sampleLevel: 'pp', round: 1, conclusion: 'pass', opinion: '做工合格', criticalDefects: 0, majorDefects: 1, minorDefects: 2 };
const fabricInput = { sampleKind: 'SS', sampleId: 'FSS_1', conclusion: 'conditional', opinion: '色差需调整', factoryAdjustment: { requirement: '回修染色' } };

describe('qcFlow garment/fabric review + sign draft + commit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('garment review draft 含 ProcessDraft 六字段 + toolId/action + 确定性 reportKey', () => {
    const draft = buildQcGarmentReviewDraft({ orderId: 'ORD_1', input: garmentInput, actorId: 'usr_qc' });
    expect(draft.subOperations[0].toolId).toBe('qc.review_garment_sample');
    expect(draft.subOperations[0].action).toBe('review_garment_sample');
    expect(draft.subOperations[0].entityId).toBe('INR__ORD_1__smp__pp__r1');
    expect(draft.beforeAfterDiff).toContainEqual({ entity: 'inspectionReport', entityId: 'INR__ORD_1__smp__pp__r1', field: 'result', before: null, after: 'pass' });
    expect(draft.impactScope).toEqual(['qc', 'orders', 'audit']);
    expect(draft.irreversible).toBe(false);
    expect(draft.idempotencyKey).toContain('qc.review_garment_sample:INR__ORD_1__smp__pp__r1:pd:');
  });

  it('garment review commit 成功复用 reviewGarmentSample service', async () => {
    const draft = buildQcGarmentReviewDraft({ orderId: 'ORD_1', input: garmentInput, actorId: 'usr_qc' });
    mocks.reviewGarmentSample.mockResolvedValue({ ok: true, data: { report: { id: 'INR__ORD_1__smp__pp__r1', result: 'pass' }, gate: null } });
    const r = await commitQcGarmentReview({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.feedback.reportId).toBe('INR__ORD_1__smp__pp__r1');
      expect(r.feedback.conclusion).toBe('pass');
    }
    expect(mocks.reviewGarmentSample).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'ORD_1', actorId: 'usr_qc',
      input: expect.objectContaining({ sampleLevel: 'pp', round: 1, conclusion: 'pass', opinion: '做工合格' }),
    }));
  });

  it('garment review hash 篡改 → PROCESS_DRAFT_HASH_MISMATCH，service 不被调', async () => {
    const draft = buildQcGarmentReviewDraft({ orderId: 'ORD_1', input: garmentInput, actorId: 'usr_qc' });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { ...(draft.subOperations[0].after as any), conclusion: 'fail' } }] };
    const r = await commitQcGarmentReview({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: tampered } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.feedback.error.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
    expect(mocks.reviewGarmentSample).not.toHaveBeenCalled();
  });

  it('garment review 缺 processDraft → PROCESS_DRAFT_MISSING', async () => {
    const r = await commitQcGarmentReview({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.feedback.error.code).toBe('PROCESS_DRAFT_MISSING');
  });

  it('garment review 语义校验：非法 sampleLevel / 缺 opinion / directReject 缺 rejectReason → SEMANTIC_VALIDATION_FAILED', () => {
    expect(validateQcGarmentReviewDraftSemantics(buildQcGarmentReviewDraft({ orderId: 'ORD_1', input: { ...garmentInput, sampleLevel: 'fit' }, actorId: 'usr_qc' })).ok).toBe(false);
    expect(validateQcGarmentReviewDraftSemantics(buildQcGarmentReviewDraft({ orderId: 'ORD_1', input: { ...garmentInput, opinion: '' }, actorId: 'usr_qc' })).ok).toBe(false);
    expect(validateQcGarmentReviewDraftSemantics(buildQcGarmentReviewDraft({ orderId: 'ORD_1', input: { ...garmentInput, directReject: true, rejectReason: '' }, actorId: 'usr_qc' })).ok).toBe(false);
  });

  it('garment review service 返回 ROUND_ALREADY_REVIEWED → failed + 错误码透传', async () => {
    const draft = buildQcGarmentReviewDraft({ orderId: 'ORD_1', input: garmentInput, actorId: 'usr_qc' });
    mocks.reviewGarmentSample.mockResolvedValue({ ok: false, error: { code: 'ROUND_ALREADY_REVIEWED', message: '该轮已有报告', status: 409 } });
    const r = await commitQcGarmentReview({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.feedback.error.code).toBe('ROUND_ALREADY_REVIEWED');
  });

  it('fabric review draft 含 disposition diff（非 pass → REQUIRES_FACTORY_TECH_ADJUST）', () => {
    const draft = buildQcFabricReviewDraft({ orderId: 'ORD_F1', input: fabricInput, actorId: 'usr_qc' });
    expect(draft.subOperations[0].toolId).toBe('qc.review_fabric_sample');
    expect(draft.subOperations[0].entityId).toBe('ORD_F1:FSS_1');
    expect(draft.beforeAfterDiff).toContainEqual({ entity: 'inspectionReport', entityId: 'ORD_F1:FSS_1', field: 'disposition', before: null, after: 'REQUIRES_FACTORY_TECH_ADJUST' });
    expect(draft.idempotencyKey).toContain('qc.review_fabric_sample:ORD_F1:FSS_1:pd:');
  });

  it('fabric review commit 成功复用 reviewFabricSample service', async () => {
    const draft = buildQcFabricReviewDraft({ orderId: 'ORD_F1', input: fabricInput, actorId: 'usr_qc' });
    mocks.reviewFabricSample.mockResolvedValue({ ok: true, data: { report: { id: 'INR__ORD_F1__fqc__FSS_1__1', result: 'conditional' } } });
    const r = await commitQcFabricReview({ prisma: {} as any, approvalId: 'AP-2', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.feedback.reportId).toBe('INR__ORD_F1__fqc__FSS_1__1');
    expect(mocks.reviewFabricSample).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'ORD_F1',
      input: expect.objectContaining({ sampleKind: 'SS', sampleId: 'FSS_1', conclusion: 'conditional' }),
    }));
  });

  it('fabric review 语义校验：非法 sampleKind / 非 pass 缺 factoryAdjustment.requirement → SEMANTIC_VALIDATION_FAILED', () => {
    expect(validateQcFabricReviewDraftSemantics(buildQcFabricReviewDraft({ orderId: 'ORD_F1', input: { ...fabricInput, sampleKind: 'bogus' }, actorId: 'usr_qc' })).ok).toBe(false);
    expect(validateQcFabricReviewDraftSemantics(buildQcFabricReviewDraft({ orderId: 'ORD_F1', input: { ...fabricInput, factoryAdjustment: {} }, actorId: 'usr_qc' })).ok).toBe(false);
  });

  it('fabric review service 返回 SAMPLE_ORDER_MISMATCH → failed + 错误码透传', async () => {
    const draft = buildQcFabricReviewDraft({ orderId: 'ORD_F1', input: fabricInput, actorId: 'usr_qc' });
    mocks.reviewFabricSample.mockResolvedValue({ ok: false, error: { code: 'SAMPLE_ORDER_MISMATCH', message: '样品不属于订单', status: 400 } });
    const r = await commitQcFabricReview({ prisma: {} as any, approvalId: 'AP-2', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.feedback.error.code).toBe('SAMPLE_ORDER_MISMATCH');
  });

  it('sign draft 含 signatures diff + irreversible=true', () => {
    const draft = buildQcSignReportDraft({ reportId: 'INR_1', role: 'qc', actorId: 'usr_qc' });
    expect(draft.subOperations[0].toolId).toBe('qc.sign_report');
    expect(draft.subOperations[0].action).toBe('sign_report_qc');
    expect(draft.beforeAfterDiff[0]).toMatchObject({ entity: 'inspectionReport', entityId: 'INR_1', field: 'signatures.qcSignedAt', before: null, after: '<signed>' });
    expect(draft.irreversible).toBe(true);
    expect(draft.idempotencyKey).toContain('qc.sign_report:INR_1:qc:pd:');
  });

  it('sign commit 成功复用 signReport service（异常式接口）', async () => {
    const draft = buildQcSignReportDraft({ reportId: 'INR_1', role: 'business', actorId: 'usr_biz' });
    mocks.signReport.mockResolvedValue({ id: 'INR_1', orderId: 'ORD_1' });
    const r = await commitQcSignReport({ prisma: {} as any, approvalId: 'AP-3', approvalPayload: { processDraft: draft }, actor: qcActor(String(draft.subOperations[0].after.actorId)) });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.feedback.reportId).toBe('INR_1');
      expect(r.feedback.signRole).toBe('business');
    }
    expect(mocks.signReport).toHaveBeenCalledWith('INR_1', 'business', 'usr_biz', null, expect.objectContaining({ userId: 'usr_biz', authorizationLoaded: true }), { delegationReason: undefined });
  });

  it('sign 语义校验：缺 reportId / 非法 role → SEMANTIC_VALIDATION_FAILED', () => {
    expect(validateQcSignReportDraftSemantics(buildQcSignReportDraft({ reportId: '', role: 'qc', actorId: 'usr_qc' })).ok).toBe(false);
    expect(validateQcSignReportDraftSemantics(buildQcSignReportDraft({ reportId: 'INR_1', role: 'boss', actorId: 'usr_qc' })).ok).toBe(false);
  });

  it('sign service throw 重复签署 → ALREADY_SIGNED（异常消息映射）', async () => {
    const draft = buildQcSignReportDraft({ reportId: 'INR_1', role: 'qc', actorId: 'usr_qc' });
    mocks.signReport.mockRejectedValue(new QcReportError('VALIDATION_FAILED', '该报告 QC侧已签署，不可重复签署（签署留痕不可改写）', 'already_signed'));
    const r = await commitQcSignReport({ prisma: {} as any, approvalId: 'AP-3', approvalPayload: { processDraft: draft }, actor: qcActor(String(draft.subOperations[0].after.actorId)) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.feedback.error.code).toBe('ALREADY_SIGNED');
  });

  it('sign service throw 业务签身份不符 → PP_SIGN_BUSINESS_ROLE_REQUIRED（异常消息映射）', async () => {
    const draft = buildQcSignReportDraft({ reportId: 'INR_1', role: 'business', actorId: 'usr_qc' });
    mocks.signReport.mockRejectedValue(new QcReportError('FORBIDDEN', '业务签字仅限订单负责人或部门主管（PP_SIGN_BUSINESS_ROLE_REQUIRED）', 'business_role'));
    const r = await commitQcSignReport({ prisma: {} as any, approvalId: 'AP-3', approvalPayload: { processDraft: draft }, actor: qcActor(String(draft.subOperations[0].after.actorId)) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.feedback.error.code).toBe('PP_SIGN_BUSINESS_ROLE_REQUIRED');
  });

  it('sign hash 篡改 → PROCESS_DRAFT_HASH_MISMATCH，service 不被调', async () => {
    const draft = buildQcSignReportDraft({ reportId: 'INR_1', role: 'qc', actorId: 'usr_qc' });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { reportId: 'INR_2', role: 'qc', actorId: 'usr_qc' } }] };
    const r = await commitQcSignReport({ prisma: {} as any, approvalId: 'AP-3', approvalPayload: { processDraft: tampered } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.feedback.error.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
    expect(mocks.signReport).not.toHaveBeenCalled();
  });

  it('所有 error code 有 userAction', () => {
    const codes: QcFlowErrorCode[] = [
      'APPROVAL_ID_MISSING', 'APPROVAL_NOT_FOUND', 'APPROVAL_MODIFIED_UNSUPPORTED',
      'PROCESS_DRAFT_MISSING', 'PROCESS_DRAFT_HASH_MISMATCH', 'SEMANTIC_VALIDATION_FAILED',
      'INVALID_INPUT', 'ORDER_NOT_FOUND', 'INVALID_CHAIN_SCOPE', 'DEV_SAMPLE_EXCLUDED',
      'REJECT_REASON_REQUIRED', 'ROUND_ALREADY_REVIEWED', 'FACTORY_ADJUSTMENT_REQUIRED',
      'SAMPLE_NOT_FOUND', 'SAMPLE_ORDER_MISMATCH', 'CREATE_FAILED',
      'REPORT_ID_REQUIRED', 'REPORT_NOT_FOUND', 'INVALID_SIGN_ROLE', 'ALREADY_SIGNED',
      'PP_SIGN_BUSINESS_ROLE_REQUIRED', 'SIGN_FAILED',
    ];
    for (const code of codes) expect(buildQcFlowError(code, 'x').userAction.length).toBeGreaterThan(0);
  });
  it('trusted actor is mandatory and cannot be supplied by the approved actorId snapshot', async () => {
    const draft = buildQcSignReportDraft({ reportId: 'INR_1', role: 'qc', actorId: 'usr_qc' });
    for (const actor of [undefined, qcActor('other')]) {
      const result = await commitQcSignReport({ prisma: {} as any, approvalId: 'AP-3', approvalPayload: { processDraft: draft }, actor });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.feedback.error.code).toBe('SIGN_FAILED');
    }
    expect(mocks.signReport).not.toHaveBeenCalled();
  });
  it('unknown SQL is a safe failure, never business permission text or raw details', async () => {
    const draft = buildQcSignReportDraft({ reportId: 'INR_1', role: 'qc', actorId: 'usr_qc' });
    mocks.signReport.mockRejectedValue(Object.assign(new Error('SELECT secret password; 不存在 必填 ROLE_REQUIRED'), { code: 'P2003' }));
    const result = await commitQcSignReport({ prisma: {} as any, approvalId: 'AP-3', approvalPayload: { processDraft: draft }, actor: qcActor('usr_qc') });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.feedback.error.code).toBe('SIGN_FAILED');
      expect(result.feedback.error.message).not.toMatch(/SELECT|secret|password|ROLE_REQUIRED|P2003/);
    }
  });
  it('explicit delegation reason is inside the immutable approval hash', () => {
    const first = buildQcSignReportDraft({ reportId: 'INR_1', role: 'qc', actorId: 'usr_qc', delegationReason: '本次现场管理代签' });
    const second = buildQcSignReportDraft({ reportId: 'INR_1', role: 'qc', actorId: 'usr_qc', delegationReason: '另一明确原因' });
    expect(first.subOperations[0].after.delegationReason).toBe('本次现场管理代签');
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
  });

});
