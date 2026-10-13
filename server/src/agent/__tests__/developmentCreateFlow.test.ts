import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  buildDevCreateDraft,
  validateDevCreateDraftSemantics,
  verifyDevCreateDraftHash,
  commitDevCreate,
  buildDevCreateError,
  type DevCreateFlowErrorCode,
} from '../developmentCreateFlow';

vi.mock('../../development/developmentCaseMutationService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../development/developmentCaseMutationService')>();
  return { ...actual, createDevelopmentCase: vi.fn() };
});
import { createDevelopmentCase } from '../../development/developmentCaseMutationService';
import type { TokenPayload } from '../../auth/service';

const actualActor: TokenPayload = { userId: 'actual-executor', roles: [], roleIds: [], departmentIds: [],
  permissions: ['products:read', 'products:write'], permissionCeiling: ['products:read', 'products:write'] };

const VALID_INPUT = {
  code: 'DEV-2608-001',
  name: '全棉斜纹手刮样',
  type: 'fabric',
  customerName: 'Peerless',
  sampleType: '手刮样',
  sampleQuantity: 5,
  sampleUnit: 'meter',
  targetDate: '2026-08-20',
};

describe('task dev-create-flow: buildDevCreateDraft（what-you-approve-is-what-you-commit）', () => {
  it('生成含 code/name/type + 样品字段的 ProcessDraft', () => {
    const draft = buildDevCreateDraft(VALID_INPUT);
    expect(draft.subOperations).toHaveLength(1);
    expect(draft.subOperations[0].toolId).toBe('development.create');
    const after = draft.subOperations[0].after as any;
    expect(after.code).toBe('DEV-2608-001');
    expect(after.name).toBe('全棉斜纹手刮样');
    expect(after.type).toBe('fabric');
    expect(after.customerName).toBe('Peerless');
    expect(after.sampleType).toBe('手刮样');
    expect(after.sampleQuantity).toBe(5);
    expect(draft.impactScope).toEqual(['development']);
    expect(draft.irreversible).toBe(false);
    expect(draft.idempotencyKey.startsWith('development.create:DEV-2608-001:')).toBe(true);
  });

  it('未传可选字段不进 after payload（不隐式补默认值）', () => {
    const draft = buildDevCreateDraft({ code: 'C1', name: 'N1', type: 'garment', customerRelationId: 'R1' });
    const after = draft.subOperations[0].after as any;
    expect(after.customerRelationId).toBe('R1');
    expect('sampleType' in after).toBe(false);
    expect('notes' in after).toBe(false);
    expect('supplierName' in after).toBe(false);
  });

  it('beforeAfterDiff 记录 stage none→developing（默认）', () => {
    const draft = buildDevCreateDraft({ code: 'C1', name: 'N1', type: 'fabric', customerName: 'X' });
    expect(draft.beforeAfterDiff[0].before).toBe('none');
    expect(draft.beforeAfterDiff[0].after).toBe('developing');
  });
});

describe('task dev-create-flow: hash 防篡改', () => {
  it('原始 draft hash 通过', () => {
    const draft = buildDevCreateDraft(VALID_INPUT);
    expect(verifyDevCreateDraftHash(draft).ok).toBe(true);
  });
  it('篡改 customerName → hash 不匹配', () => {
    const draft = buildDevCreateDraft(VALID_INPUT);
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { ...draft.subOperations[0].after, customerName: 'HACKED' } }] };
    expect(verifyDevCreateDraftHash(tampered).ok).toBe(false);
  });
});

describe('task dev-create-flow: validateDevCreateDraftSemantics（fail closed）', () => {
  it('缺 code/name/type → SEMANTIC_VALIDATION_FAILED', () => {
    const draft = { subOperations: [{ after: { code: 'C1' } }], idempotencyKey: 't' } as any;
    const r = validateDevCreateDraftSemantics(draft);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('SEMANTIC_VALIDATION_FAILED');
  });
  it('非法 type → INVALID_TYPE', () => {
    const draft = { subOperations: [{ after: { code: 'C1', name: 'N', type: 'invalid', customerName: 'X' } }], idempotencyKey: 't' } as any;
    const r = validateDevCreateDraftSemantics(draft);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('INVALID_TYPE');
  });
  it('非法 stage → INVALID_STAGE', () => {
    const draft = { subOperations: [{ after: { code: 'C1', name: 'N', type: 'fabric', stage: 'bogus', customerName: 'X' } }], idempotencyKey: 't' } as any;
    const r = validateDevCreateDraftSemantics(draft);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('INVALID_STAGE');
  });
  it('缺客户归属 → CUSTOMER_REQUIRED', () => {
    const draft = { subOperations: [{ after: { code: 'C1', name: 'N', type: 'fabric' } }], idempotencyKey: 't' } as any;
    const r = validateDevCreateDraftSemantics(draft);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('CUSTOMER_REQUIRED');
  });
  it('合法 draft 通过', () => {
    const draft = buildDevCreateDraft(VALID_INPUT);
    expect(validateDevCreateDraftSemantics(draft).ok).toBe(true);
  });
});

describe('task dev-create-flow: error code userAction 覆盖', () => {
  it('所有 code 有 userAction', () => {
    const codes: DevCreateFlowErrorCode[] = ['APPROVAL_ID_MISSING', 'APPROVAL_NOT_FOUND', 'APPROVAL_MODIFIED_UNSUPPORTED', 'PROCESS_DRAFT_MISSING', 'PROCESS_DRAFT_HASH_MISMATCH', 'SEMANTIC_VALIDATION_FAILED', 'CUSTOMER_REQUIRED', 'INVALID_INPUT', 'INVALID_TRANSITION', 'REVIEW_REQUIRED', 'INVALID_STAGE', 'INVALID_TYPE', 'DUPLICATE_CODE', 'NOT_FOUND', 'ALREADY_DELETED', 'CONVERTED_TO_ORDER', 'CREATE_FAILED', 'UPDATE_FAILED', 'STAGE_UPDATE_FAILED', 'DELETE_FAILED', 'UNKNOWN_ERROR'];
    for (const code of codes) expect(buildDevCreateError(code, 'test').userAction.length).toBeGreaterThan(0);
  });
});

describe('task dev-create-flow: commitDevCreate（复用 service，不绕 route）', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('does not replace a missing real executor credential with the approval requester or system account', async () => {
    const draft = buildDevCreateDraft(VALID_INPUT);
    const result = await commitDevCreate({ prisma: {} as never, approvalId: 'AP1', approvalPayload: { processDraft: draft }, actorId: 'approval-requester' });
    expect(result).toMatchObject({ ok: false, feedback: { error: { code: 'UNAUTHORIZED' } } });
    expect(createDevelopmentCase).not.toHaveBeenCalled();
  });

  it('draft 缺失 → PROCESS_DRAFT_MISSING', async () => {
    const r = await commitDevCreate({ prisma: {} as any, approvalId: 'AP1', approvalPayload: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_MISSING');
  });

  it('hash 篡改 → PROCESS_DRAFT_HASH_MISMATCH', async () => {
    const draft = buildDevCreateDraft(VALID_INPUT);
    const tampered = { ...draft, idempotencyKey: 'development.create:DEV-2608-001:pd:bogus' };
    const r = await commitDevCreate({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: tampered } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
  });

  it('成功 commit（service ok）→ committed，输入从 draft.after 恢复', async () => {
    const draft = buildDevCreateDraft(VALID_INPUT);
    (createDevelopmentCase as any).mockResolvedValue({ ok: true, data: { case: { id: 'DEV__1', code: 'DEV-2608-001' }, auditId: 'a1' } });
    const r = await commitDevCreate({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft }, actorId: 'approval-requester', trustedActor: actualActor });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.feedback.status).toBe('committed');
      expect(r.feedback.caseId).toBe('DEV__1');
      expect(r.feedback.code).toBe('DEV-2608-001');
      expect(r.feedback.auditId).toBe('a1');
      expect(r.feedback.idempotencyKey).toBe(draft.idempotencyKey);
    }
    expect(createDevelopmentCase).toHaveBeenCalledTimes(1);
    expect(createDevelopmentCase).toHaveBeenCalledWith(expect.objectContaining({ actorId: actualActor.userId, trustedActor: actualActor }));
    const calledInput = (createDevelopmentCase as any).mock.calls[0][0].input;
    expect(calledInput.code).toBe('DEV-2608-001');
    expect(calledInput.customerName).toBe('Peerless');
    expect(calledInput.sampleQuantity).toBe(5);
  });

  it('service 失败（DUPLICATE_CODE）→ failed，不伪 committed', async () => {
    const draft = buildDevCreateDraft(VALID_INPUT);
    (createDevelopmentCase as any).mockResolvedValue({ ok: false, error: { code: 'DUPLICATE_CODE', message: 'dup' } });
    const r = await commitDevCreate({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft }, trustedActor: actualActor });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('DUPLICATE_CODE');
  });

  it('service 失败（CREATE_FAILED）→ failed', async () => {
    const draft = buildDevCreateDraft(VALID_INPUT);
    (createDevelopmentCase as any).mockResolvedValue({ ok: false, error: { code: 'CREATE_FAILED', message: 'tx rollback' } });
    const r = await commitDevCreate({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft }, trustedActor: actualActor });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('CREATE_FAILED');
  });

  it('no route/service bypass：commit 只调 createDevelopmentCase，不直接 DB mutation', async () => {
    const draft = buildDevCreateDraft(VALID_INPUT);
    (createDevelopmentCase as any).mockResolvedValue({ ok: true, data: { case: { id: 'DEV__1', code: 'DEV-2608-001' }, auditId: 'a1' } });
    const prisma = { developmentCase: { create: vi.fn() } } as any;
    await commitDevCreate({ prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft }, trustedActor: actualActor });
    expect(createDevelopmentCase).toHaveBeenCalledTimes(1);
    expect(prisma.developmentCase.create).not.toHaveBeenCalled();
  });
});
