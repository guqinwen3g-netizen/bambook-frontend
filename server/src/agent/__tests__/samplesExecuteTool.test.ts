import { describe, expect, it, vi, beforeEach } from 'vitest';
import { executeTool } from '../toolRuntime';
import {
  registerSamplesFlowTools,
  buildSampleRoundCreateDraft,
  buildSampleSubmitToCustomerDraft,
  buildSampleCustomerConfirmationDraft,
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

registerSamplesFlowTools();

const roundInput = { purpose: '初样', version: 'V1', materialConfig: '全棉府绸 40s' };
const submitInput = { courier: 'DHL', trackingNumber: '1234567890', recipientName: '客户跟单' };
const confirmInput = { result: 'approved', confirmationDate: '2026-08-17', channel: 'email' };

describe('samples executeTool commit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('samples.create_round approved → committed', async () => {
    const draft = buildSampleRoundCreateDraft({ caseId: 'CASE_1', input: roundInput, actorId: 'usr_1' });
    mocks.createRound.mockResolvedValue({ ok: true, data: { round: { id: 'GSR_1', developmentCaseId: 'CASE_1', status: 'in_progress' } } });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-1', status: 'approved', actionType: 'tool:samples.create_round', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'samples.create_round', input: {}, approvalId: 'AP-1' } as any);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
    expect(result.roundId).toBe('GSR_1');
    expect(mocks.createRound).toHaveBeenCalledTimes(1);
  });

  it('samples.submit_to_customer approved → committed', async () => {
    const draft = buildSampleSubmitToCustomerDraft({ roundId: 'GSR_1', input: submitInput, actorId: 'usr_1' });
    mocks.submitToCustomer.mockResolvedValue({ ok: true, data: { round: { id: 'GSR_1', developmentCaseId: 'CASE_1', status: 'submitted' } } });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-2', status: 'approved', actionType: 'tool:samples.submit_to_customer', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'samples.submit_to_customer', input: {}, approvalId: 'AP-2' } as any);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
    expect(mocks.submitToCustomer).toHaveBeenCalledTimes(1);
  });

  it('samples.register_customer_confirmation approved → committed', async () => {
    const draft = buildSampleCustomerConfirmationDraft({ roundId: 'GSR_1', input: confirmInput, actorId: 'usr_1' });
    mocks.registerCustomerConfirmation.mockResolvedValue({ ok: true, data: { round: { id: 'GSR_1', developmentCaseId: 'CASE_1', status: 'confirmed' } } });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-3', status: 'approved', actionType: 'tool:samples.register_customer_confirmation', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'samples.register_customer_confirmation', input: {}, approvalId: 'AP-3' } as any);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
    expect(result.roundStatus).toBe('confirmed');
    expect(mocks.registerCustomerConfirmation).toHaveBeenCalledTimes(1);
  });

  it('approval missing → APPROVAL_ID_MISSING，service 不调用', async () => {
    const result: any = await executeTool({} as any, { toolId: 'samples.create_round', input: {} } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_ID_MISSING');
    expect(mocks.createRound).not.toHaveBeenCalled();
  });

  it('pending approval → APPROVAL_PENDING，service 不调用', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-1', status: 'pending', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'samples.create_round', input: {}, approvalId: 'AP-1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_PENDING');
    expect(mocks.createRound).not.toHaveBeenCalled();
  });

  it('modified approval → APPROVAL_MODIFIED_UNSUPPORTED，service 不调用', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-3', status: 'modified', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'samples.register_customer_confirmation', input: {}, approvalId: 'AP-3' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_MODIFIED_UNSUPPORTED');
    expect(mocks.registerCustomerConfirmation).not.toHaveBeenCalled();
  });

  it('approved 但 draft hash 被篡改 → PROCESS_DRAFT_HASH_MISMATCH，service 不调用', async () => {
    const draft = buildSampleRoundCreateDraft({ caseId: 'CASE_1', input: roundInput, actorId: 'usr_1' });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { ...(draft.subOperations[0].after as any), version: 'V9' } }] };
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-1', status: 'approved', actionType: 'tool:samples.create_round', payload: { processDraft: tampered } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'samples.create_round', input: {}, approvalId: 'AP-1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
    expect(mocks.createRound).not.toHaveBeenCalled();
  });
});
