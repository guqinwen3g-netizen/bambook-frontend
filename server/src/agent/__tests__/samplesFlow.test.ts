import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  buildSampleRoundCreateDraft,
  commitSampleRoundCreate,
  buildSampleSubmitToCustomerDraft,
  commitSampleSubmitToCustomer,
  buildSampleCustomerConfirmationDraft,
  commitSampleCustomerConfirmation,
  validateSampleRoundCreateDraftSemantics,
  validateSampleSubmitToCustomerDraftSemantics,
  validateSampleCustomerConfirmationDraftSemantics,
  buildSamplesFlowError,
  type SamplesFlowErrorCode,
} from '../samplesFlow';

const mocks = vi.hoisted(() => ({
  createRound: vi.fn(),
  submitToCustomer: vi.fn(),
  registerCustomerConfirmation: vi.fn(),
}));

vi.mock('../../samples/garmentSampleGateService', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    createGarmentSampleGateService: () => ({
      createRound: mocks.createRound,
      submitToCustomer: mocks.submitToCustomer,
      registerCustomerConfirmation: mocks.registerCustomerConfirmation,
    }),
  };
});

const roundInput = { purpose: '初样', version: 'V1', materialConfig: '全棉府绸 40s' };
const submitInput = { courier: 'DHL', trackingNumber: '1234567890', recipientName: '客户跟单' };
const confirmInput = { result: 'approved', confirmationDate: '2026-08-17', channel: 'email' };

describe('samplesFlow create_round/submit/confirm draft + commit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create_round draft 含 ProcessDraft 六字段 + toolId/action', () => {
    const draft = buildSampleRoundCreateDraft({ caseId: 'CASE_1', input: roundInput, actorId: 'usr_1' });
    expect(draft.subOperations[0].toolId).toBe('samples.create_round');
    expect(draft.subOperations[0].action).toBe('create_garment_sample_round');
    expect(draft.beforeAfterDiff).toContainEqual({ entity: 'garmentSampleRound', entityId: 'CASE_1', field: 'status', before: null, after: 'in_progress' });
    expect(draft.impactScope).toEqual(['samples', 'development', 'audit']);
    expect(draft.irreversible).toBe(false);
    expect(draft.idempotencyKey).toContain('samples.create_round:CASE_1:pd:');
  });

  it('create_round commit 成功复用 createRound service', async () => {
    const draft = buildSampleRoundCreateDraft({ caseId: 'CASE_1', input: roundInput, actorId: 'usr_1' });
    mocks.createRound.mockResolvedValue({ ok: true, data: { round: { id: 'GSR_1', developmentCaseId: 'CASE_1', status: 'in_progress' } } });
    const r = await commitSampleRoundCreate({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.feedback.roundId).toBe('GSR_1');
      expect(r.feedback.caseId).toBe('CASE_1');
    }
    expect(mocks.createRound).toHaveBeenCalledWith(expect.objectContaining({
      caseId: 'CASE_1', actorId: 'usr_1',
      input: expect.objectContaining({ purpose: '初样', version: 'V1', materialConfig: '全棉府绸 40s' }),
    }));
  });

  it('create_round hash 篡改 → PROCESS_DRAFT_HASH_MISMATCH，service 不被调', async () => {
    const draft = buildSampleRoundCreateDraft({ caseId: 'CASE_1', input: roundInput, actorId: 'usr_1' });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { ...(draft.subOperations[0].after as any), version: 'V9' } }] };
    const r = await commitSampleRoundCreate({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: tampered } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.feedback.error.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
    expect(mocks.createRound).not.toHaveBeenCalled();
  });

  it('create_round 缺 processDraft → PROCESS_DRAFT_MISSING', async () => {
    const r = await commitSampleRoundCreate({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.feedback.error.code).toBe('PROCESS_DRAFT_MISSING');
  });

  it('create_round 语义校验：缺 purpose/version/materialConfig → SEMANTIC_VALIDATION_FAILED', () => {
    expect(validateSampleRoundCreateDraftSemantics(buildSampleRoundCreateDraft({ caseId: 'CASE_1', input: { ...roundInput, purpose: '' }, actorId: 'usr_1' })).ok).toBe(false);
    expect(validateSampleRoundCreateDraftSemantics(buildSampleRoundCreateDraft({ caseId: 'CASE_1', input: { ...roundInput, version: '' }, actorId: 'usr_1' })).ok).toBe(false);
    expect(validateSampleRoundCreateDraftSemantics(buildSampleRoundCreateDraft({ caseId: 'CASE_1', input: { ...roundInput, materialConfig: '' }, actorId: 'usr_1' })).ok).toBe(false);
  });

  it('create_round service 返回 NOT_GARMENT_CASE → failed + 错误码透传', async () => {
    const draft = buildSampleRoundCreateDraft({ caseId: 'CASE_1', input: roundInput, actorId: 'usr_1' });
    mocks.createRound.mockResolvedValue({ ok: false, error: { code: 'NOT_GARMENT_CASE', message: '仅 garment 适用', status: 400 } });
    const r = await commitSampleRoundCreate({ prisma: {} as any, approvalId: 'AP-1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.feedback.error.code).toBe('NOT_GARMENT_CASE');
  });

  it('submit_to_customer draft 含 status diff + 寄送字段', () => {
    const draft = buildSampleSubmitToCustomerDraft({ roundId: 'GSR_1', input: submitInput, actorId: 'usr_1' });
    expect(draft.subOperations[0].toolId).toBe('samples.submit_to_customer');
    expect(draft.beforeAfterDiff[0]).toMatchObject({ entity: 'garmentSampleRound', entityId: 'GSR_1', field: 'status', before: 'qc_passed', after: 'submitted' });
    expect(draft.idempotencyKey).toContain('samples.submit_to_customer:GSR_1:pd:');
  });

  it('submit_to_customer commit 成功复用 submitToCustomer service', async () => {
    const draft = buildSampleSubmitToCustomerDraft({ roundId: 'GSR_1', input: submitInput, actorId: 'usr_1' });
    mocks.submitToCustomer.mockResolvedValue({ ok: true, data: { round: { id: 'GSR_1', developmentCaseId: 'CASE_1', status: 'submitted' } } });
    const r = await commitSampleSubmitToCustomer({ prisma: {} as any, approvalId: 'AP-2', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    expect(mocks.submitToCustomer).toHaveBeenCalledWith(expect.objectContaining({
      roundId: 'GSR_1',
      input: expect.objectContaining({ courier: 'DHL', trackingNumber: '1234567890', recipientName: '客户跟单' }),
    }));
  });

  it('submit_to_customer 语义校验：缺 courier / 非法 sentDate → SEMANTIC_VALIDATION_FAILED', () => {
    expect(validateSampleSubmitToCustomerDraftSemantics(buildSampleSubmitToCustomerDraft({ roundId: 'GSR_1', input: { ...submitInput, courier: '' }, actorId: 'usr_1' })).ok).toBe(false);
    expect(validateSampleSubmitToCustomerDraftSemantics(buildSampleSubmitToCustomerDraft({ roundId: 'GSR_1', input: { ...submitInput, sentDate: '20260817' }, actorId: 'usr_1' })).ok).toBe(false);
  });

  it('submit_to_customer service 返回 QC_GATE_NOT_PASSED → failed + 错误码透传', async () => {
    const draft = buildSampleSubmitToCustomerDraft({ roundId: 'GSR_1', input: submitInput, actorId: 'usr_1' });
    mocks.submitToCustomer.mockResolvedValue({ ok: false, error: { code: 'QC_GATE_NOT_PASSED', message: 'QC 未通过', status: 409 } });
    const r = await commitSampleSubmitToCustomer({ prisma: {} as any, approvalId: 'AP-2', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.feedback.error.code).toBe('QC_GATE_NOT_PASSED');
  });

  it('register_customer_confirmation draft 含 status/customerStatus diff', () => {
    const draft = buildSampleCustomerConfirmationDraft({ roundId: 'GSR_1', input: confirmInput, actorId: 'usr_1' });
    expect(draft.subOperations[0].toolId).toBe('samples.register_customer_confirmation');
    expect(draft.beforeAfterDiff[0]).toMatchObject({ entity: 'garmentSampleRound', entityId: 'GSR_1', field: 'status', before: 'submitted', after: 'confirmed' });
    expect(draft.beforeAfterDiff[1]).toMatchObject({ entity: 'garmentSampleRound', entityId: 'GSR_1', field: 'customerStatus', before: 'pending', after: 'approved' });
    expect(draft.idempotencyKey).toContain('samples.register_customer_confirmation:GSR_1:pd:');
  });

  it('register_customer_confirmation commit 成功复用 registerCustomerConfirmation service', async () => {
    const draft = buildSampleCustomerConfirmationDraft({ roundId: 'GSR_1', input: confirmInput, actorId: 'usr_1' });
    mocks.registerCustomerConfirmation.mockResolvedValue({ ok: true, data: { round: { id: 'GSR_1', developmentCaseId: 'CASE_1', status: 'confirmed' } } });
    const r = await commitSampleCustomerConfirmation({ prisma: {} as any, approvalId: 'AP-3', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.feedback.roundStatus).toBe('confirmed');
    expect(mocks.registerCustomerConfirmation).toHaveBeenCalledWith(expect.objectContaining({
      roundId: 'GSR_1',
      input: expect.objectContaining({ result: 'approved', confirmationDate: '2026-08-17', channel: 'email' }),
    }));
  });

  it('register_customer_confirmation 语义校验：非法 result / 缺 channel → SEMANTIC_VALIDATION_FAILED', () => {
    expect(validateSampleCustomerConfirmationDraftSemantics(buildSampleCustomerConfirmationDraft({ roundId: 'GSR_1', input: { ...confirmInput, result: 'bogus' }, actorId: 'usr_1' })).ok).toBe(false);
    expect(validateSampleCustomerConfirmationDraftSemantics(buildSampleCustomerConfirmationDraft({ roundId: 'GSR_1', input: { ...confirmInput, channel: '' }, actorId: 'usr_1' })).ok).toBe(false);
  });

  it('register_customer_confirmation service 返回 SEALED_IMMUTABLE → failed + 错误码透传', async () => {
    const draft = buildSampleCustomerConfirmationDraft({ roundId: 'GSR_1', input: confirmInput, actorId: 'usr_1' });
    mocks.registerCustomerConfirmation.mockResolvedValue({ ok: false, error: { code: 'SEALED_IMMUTABLE', message: '封存不可变', status: 409 } });
    const r = await commitSampleCustomerConfirmation({ prisma: {} as any, approvalId: 'AP-3', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.feedback.error.code).toBe('SEALED_IMMUTABLE');
  });

  it('所有 error code 有 userAction', () => {
    const codes: SamplesFlowErrorCode[] = [
      'APPROVAL_ID_MISSING', 'APPROVAL_NOT_FOUND', 'APPROVAL_MODIFIED_UNSUPPORTED',
      'PROCESS_DRAFT_MISSING', 'PROCESS_DRAFT_HASH_MISMATCH', 'SEMANTIC_VALIDATION_FAILED',
      'INVALID_INPUT', 'NOT_FOUND', 'NOT_GARMENT_CASE', 'QC_REPORT_NOT_FOUND',
      'SEALED_IMMUTABLE', 'INVALID_TRANSITION', 'QC_GATE_NOT_PASSED', 'CREATE_FAILED', 'UPDATE_FAILED',
    ];
    for (const code of codes) expect(buildSamplesFlowError(code, 'x').userAction.length).toBeGreaterThan(0);
  });
});
