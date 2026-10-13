import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  buildDevConvertDraft,
  validateDevConvertDraftSemantics,
  verifyDevConvertDraftHash,
  commitDevConvert,
  buildDevConvertError,
  type DevConvertFlowErrorCode,
} from '../developmentConvertFlow';

vi.mock('../../development/convertService', () => ({
  convertDevCaseToOrder: vi.fn(),
}));
import { convertDevCaseToOrder } from '../../development/convertService';

describe('task dev-convert-flow: buildDevConvertDraft（what-you-approve-is-what-you-commit）', () => {
  it('autoCreate 模式生成含 caseId+mode 的 ProcessDraft', () => {
    const draft = buildDevConvertDraft({ caseId: 'DC__1', mode: 'autoCreate', quantity: 1000 });
    expect(draft.subOperations).toHaveLength(1);
    expect(draft.subOperations[0].toolId).toBe('development.convert_to_order');
    expect((draft.subOperations[0].after as any).caseId).toBe('DC__1');
    expect((draft.subOperations[0].after as any).mode).toBe('autoCreate');
    expect((draft.subOperations[0].after as any).quantity).toBe(1000);
    expect(draft.impactScope).toEqual(['development', 'orders']);
  });

  it('link 模式生成含 caseId+orderId 的 ProcessDraft', () => {
    const draft = buildDevConvertDraft({ caseId: 'DC__1', mode: 'link', orderId: 'ORD-1', orderPo: 'PO-1' });
    const after = draft.subOperations[0].after as any;
    expect(after.mode).toBe('link');
    expect(after.orderId).toBe('ORD-1');
    expect(after.orderPo).toBe('PO-1');
  });
});

describe('task dev-convert-flow: hash 防篡改', () => {
  it('原始 draft hash 通过', () => {
    const draft = buildDevConvertDraft({ caseId: 'DC__1', mode: 'autoCreate' });
    expect(verifyDevConvertDraftHash(draft).ok).toBe(true);
  });
  it('篡改 caseId → hash 不匹配', () => {
    const draft = buildDevConvertDraft({ caseId: 'DC__1', mode: 'autoCreate' });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { ...draft.subOperations[0].after, caseId: 'HACKED' } }] };
    expect(verifyDevConvertDraftHash(tampered).ok).toBe(false);
  });
});

describe('task dev-convert-flow: validateDevConvertDraftSemantics（fail closed）', () => {
  it('缺 caseId → SEMANTIC_VALIDATION_FAILED', () => {
    const draft = { subOperations: [{ after: { mode: 'autoCreate' } }], idempotencyKey: 't' } as any;
    expect(validateDevConvertDraftSemantics(draft).ok).toBe(false);
  });
  it('非法 mode → SEMANTIC_VALIDATION_FAILED', () => {
    const draft = { subOperations: [{ after: { caseId: 'DC__1', mode: 'invalid' } }], idempotencyKey: 't' } as any;
    expect(validateDevConvertDraftSemantics(draft).ok).toBe(false);
  });
  it('link 模式缺 orderId → INVALID_INPUT', () => {
    const draft = { subOperations: [{ after: { caseId: 'DC__1', mode: 'link' } }], idempotencyKey: 't' } as any;
    const r = validateDevConvertDraftSemantics(draft);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('INVALID_INPUT');
  });
});

describe('task dev-convert-flow: 17 error code userAction', () => {
  it('所有 code 有 userAction', () => {
    const codes: DevConvertFlowErrorCode[] = ['APPROVAL_ID_MISSING', 'APPROVAL_NOT_FOUND', 'APPROVAL_MODIFIED_UNSUPPORTED', 'PROCESS_DRAFT_MISSING', 'PROCESS_DRAFT_HASH_MISMATCH', 'SEMANTIC_VALIDATION_FAILED', 'DEV_CASE_NOT_FOUND', 'ORDER_NOT_FOUND', 'INVALID_INPUT', 'CASE_CANCELLED', 'INVALID_STAGE', 'ASSET_REQUIRED', 'CONFIRMED_SOURCE_NOT_FOUND', 'CONFIRMED_SOURCE_NOT_APPROVED', 'MILL_MISMATCH', 'CONVERT_FAILED', 'UNKNOWN_ERROR'];
    for (const code of codes) expect(buildDevConvertError(code, 'test').userAction.length).toBeGreaterThan(0);
  });
});

describe('task dev-convert-flow: commitDevConvert（复用 service，不绕 route）', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('draft 缺失 → PROCESS_DRAFT_MISSING', async () => {
    const prisma = {} as any;
    const r = await commitDevConvert({ trustedActor: { userId: 'u_owner', roles: [] }, prisma, approvalId: 'AP1', approvalPayload: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_MISSING');
  });

  it('hash 篡改 → PROCESS_DRAFT_HASH_MISMATCH', async () => {
    const draft = buildDevConvertDraft({ caseId: 'DC__1', mode: 'autoCreate' });
    const tampered = { ...draft, idempotencyKey: 'dev.convert_to_order:DC__1:autoCreate:pd:bogus' };
    const prisma = {} as any;
    const r = await commitDevConvert({ trustedActor: { userId: 'u_owner', roles: [] }, prisma, approvalId: 'AP1', approvalPayload: { processDraft: tampered } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
  });

  it('成功 commit（service ok）→ committed', async () => {
    const draft = buildDevConvertDraft({ caseId: 'DC__1', mode: 'autoCreate' });
    (convertDevCaseToOrder as any).mockResolvedValue({ ok: true, data: { case: { id: 'DC__1', linkedOrderId: 'ORD-NEW' }, order: { id: 'ORD-NEW' }, auditId: 'a1' } });
    const prisma = {} as any;
    const r = await commitDevConvert({ trustedActor: { userId: 'u_owner', roles: [] }, prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.feedback.status).toBe('committed');
      expect(r.feedback.caseId).toBe('DC__1');
      expect(r.feedback.orderId).toBe('ORD-NEW');
      expect(r.feedback.auditId).toBe('a1');
    }
    expect(convertDevCaseToOrder).toHaveBeenCalledTimes(1);
  });

  it('service 失败（DEV_CASE_NOT_FOUND）→ failed，不伪 committed', async () => {
    const draft = buildDevConvertDraft({ caseId: 'DC__1', mode: 'autoCreate' });
    (convertDevCaseToOrder as any).mockResolvedValue({ ok: false, error: { code: 'DEV_CASE_NOT_FOUND', message: 'not found' } });
    const prisma = {} as any;
    const r = await commitDevConvert({ trustedActor: { userId: 'u_owner', roles: [] }, prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('DEV_CASE_NOT_FOUND');
  });

  it('service 失败（ALREADY_CONVERTED）→ failed', async () => {
    const draft = buildDevConvertDraft({ caseId: 'DC__1', mode: 'autoCreate' });
    (convertDevCaseToOrder as any).mockResolvedValue({ ok: false, error: { code: 'ALREADY_CONVERTED', message: 'already linked', existingOrderId: 'ORD-OLD' } });
    const prisma = {} as any;
    const r = await commitDevConvert({ trustedActor: { userId: 'u_owner', roles: [] }, prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('ALREADY_CONVERTED');
  });

  it('service 失败（CONVERT_FAILED）→ failed', async () => {
    const draft = buildDevConvertDraft({ caseId: 'DC__1', mode: 'autoCreate' });
    (convertDevCaseToOrder as any).mockResolvedValue({ ok: false, error: { code: 'CONVERT_FAILED', message: 'sync reject' } });
    const prisma = {} as any;
    const r = await commitDevConvert({ trustedActor: { userId: 'u_owner', roles: [] }, prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('CONVERT_FAILED');
  });

  it('no route/service bypass：commit 只调 convertDevCaseToOrder，不直接 DB mutation', async () => {
    const draft = buildDevConvertDraft({ caseId: 'DC__1', mode: 'autoCreate' });
    (convertDevCaseToOrder as any).mockResolvedValue({ ok: true, data: { case: { id: 'DC__1', linkedOrderId: 'ORD-NEW' }, order: null, auditId: 'a1' } });
    const prisma = {} as any;
    await commitDevConvert({ trustedActor: { userId: 'u_owner', roles: [] }, prisma, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(convertDevCaseToOrder).toHaveBeenCalledTimes(1);
  });
});

it('missing trusted execution actor cannot borrow an approval requester', async () => {
  const draft = buildDevConvertDraft({ caseId: 'DC__1', mode: 'autoCreate' });
  const result = await commitDevConvert({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft, requesterId: 'u_owner' } });
  expect(result.ok).toBe(false); if (!result.ok) expect(result.feedback.error.code).toBe('FORBIDDEN');
});
