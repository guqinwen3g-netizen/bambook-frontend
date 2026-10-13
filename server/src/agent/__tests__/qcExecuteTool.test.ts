import { describe, expect, it, vi, beforeEach } from 'vitest';
import { executeTool } from '../toolRuntime';
import {
  registerQcFlowTools,
  buildQcGarmentReviewDraft,
  buildQcFabricReviewDraft,
  buildQcSignReportDraft,
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

registerQcFlowTools();

const garmentInput = { sampleLevel: 'pp', round: 1, conclusion: 'pass', opinion: '做工合格' };
const fabricInput = { sampleKind: 'SS', sampleId: 'FSS_1', conclusion: 'pass', opinion: '合格' };

describe('qc executeTool commit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('qc.review_garment_sample approved → committed', async () => {
    const draft = buildQcGarmentReviewDraft({ orderId: 'ORD_1', input: garmentInput, actorId: 'usr_qc' });
    mocks.reviewGarmentSample.mockResolvedValue({ ok: true, data: { report: { id: 'INR__ORD_1__smp__pp__r1', result: 'pass' }, gate: null } });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-1', status: 'approved', actionType: 'tool:qc.review_garment_sample', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'qc.review_garment_sample', input: {}, approvalId: 'AP-1' } as any);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
    expect(result.reportId).toBe('INR__ORD_1__smp__pp__r1');
    expect(mocks.reviewGarmentSample).toHaveBeenCalledTimes(1);
  });

  it('qc.review_fabric_sample approved → committed', async () => {
    const draft = buildQcFabricReviewDraft({ orderId: 'ORD_F1', input: fabricInput, actorId: 'usr_qc' });
    mocks.reviewFabricSample.mockResolvedValue({ ok: true, data: { report: { id: 'INR__ORD_F1__fqc__FSS_1__1', result: 'pass' } } });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-2', status: 'approved', actionType: 'tool:qc.review_fabric_sample', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'qc.review_fabric_sample', input: {}, approvalId: 'AP-2' } as any);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
    expect(mocks.reviewFabricSample).toHaveBeenCalledTimes(1);
  });

  it('qc.sign_report approved → committed', async () => {
    const draft = buildQcSignReportDraft({ reportId: 'INR_1', role: 'qc', actorId: 'usr_qc' });
    mocks.signReport.mockResolvedValue({ id: 'INR_1', orderId: 'ORD_1' });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-3', status: 'approved', actionType: 'tool:qc.sign_report', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'qc.sign_report', input: {}, approvalId: 'AP-3' } as any, { actor: qcActor('usr_qc') });
    expect(result.ok).toBe(true);
    expect(result.status).toBe('committed');
    expect(result.signRole).toBe('qc');
    expect(mocks.signReport).toHaveBeenCalledTimes(1);
  });

  it('approval missing → APPROVAL_ID_MISSING，service 不调用', async () => {
    const result: any = await executeTool({} as any, { toolId: 'qc.review_garment_sample', input: {} } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_ID_MISSING');
    expect(mocks.reviewGarmentSample).not.toHaveBeenCalled();
  });

  it('pending approval → APPROVAL_PENDING，service 不调用', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-1', status: 'pending', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'qc.review_garment_sample', input: {}, approvalId: 'AP-1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_PENDING');
    expect(mocks.reviewGarmentSample).not.toHaveBeenCalled();
  });

  it('modified approval → APPROVAL_MODIFIED_UNSUPPORTED，service 不调用', async () => {
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-3', status: 'modified', payload: {} }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'qc.sign_report', input: {}, approvalId: 'AP-3' } as any, { actor: qcActor('usr_qc') });
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('APPROVAL_MODIFIED_UNSUPPORTED');
    expect(mocks.signReport).not.toHaveBeenCalled();
  });

  it('approved 但 draft hash 被篡改 → PROCESS_DRAFT_HASH_MISMATCH，service 不调用', async () => {
    const draft = buildQcGarmentReviewDraft({ orderId: 'ORD_1', input: garmentInput, actorId: 'usr_qc' });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { ...(draft.subOperations[0].after as any), conclusion: 'fail' } }] };
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-1', status: 'approved', actionType: 'tool:qc.review_garment_sample', payload: { processDraft: tampered } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'qc.review_garment_sample', input: {}, approvalId: 'AP-1' } as any);
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
    expect(mocks.reviewGarmentSample).not.toHaveBeenCalled();
  });

  it('sign service throw → 结构化错误码（executeTool 链路）', async () => {
    const draft = buildQcSignReportDraft({ reportId: 'INR_1', role: 'business', actorId: 'usr_qc' });
    mocks.signReport.mockRejectedValue(new QcReportError('FORBIDDEN', '业务签字仅限订单负责人或部门主管（PP_SIGN_BUSINESS_ROLE_REQUIRED）', 'business_role'));
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-3', status: 'approved', actionType: 'tool:qc.sign_report', payload: { processDraft: draft } }) } } as any;
    const result: any = await executeTool(prisma, { toolId: 'qc.sign_report', input: {}, approvalId: 'AP-3' } as any, { actor: qcActor('usr_qc') });
    expect(result.ok).toBe(false);
    expect(result.errorFeedback.code).toBe('PP_SIGN_BUSINESS_ROLE_REQUIRED');
  });
  it('approved draft cannot turn missing/different runtime identity into its snapshot signer', async () => {
    const draft = buildQcSignReportDraft({ reportId: 'INR_1', role: 'qc', actorId: 'usr_qc' });
    const prisma = { approvalRequest: { findUnique: vi.fn().mockResolvedValue({ id: 'AP-3', requesterId: 'usr_qc', status: 'approved',
      actionType: 'tool:qc.sign_report', payload: { processDraft: draft } }) } } as any;
    for (const context of [undefined, { actor: qcActor('another') }]) {
      const result: any = await executeTool(prisma, { toolId: 'qc.sign_report', input: {}, approvalId: 'AP-3' } as any, context);
      expect(result.ok).toBe(false); expect(result.errorFeedback.code).toBe('SIGN_FAILED');
    }
    expect(mocks.signReport).not.toHaveBeenCalled();
  });

});
