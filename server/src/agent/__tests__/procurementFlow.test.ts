import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  buildProcurementCreateDraft,
  validateProcurementCreateDraftSemantics,
  verifyProcurementCreateDraftHash,
  commitProcurementCreate,
  buildProcurementUpdateStatusDraft,
  validateProcurementUpdateStatusDraftSemantics,
  commitProcurementUpdateStatus,
  buildProcurementFlowError,
  type ProcurementFlowErrorCode,
} from '../procurementFlow';

vi.mock('../../procurement/procurementService', () => ({
  createProcurementService: vi.fn(),
  MANUAL_PURCHASE_ORDER_TRANSITION_TARGETS: ['Sent', 'Confirmed', 'Cancelled', 'Closed'],
  PURCHASE_ORDER_CREATE_FIELDS: [
    'poNumber', 'currency', 'supplierRelationId', 'supplierName', 'supplierCode', 'orderDate',
    'expectedDeliveryDate', 'deliveryTerms', 'paymentTerms', 'shipToAddress', 'orderId', 'quotationId',
    'bomId', 'buyer', 'exchangeRate', 'baseCurrency', 'notes', 'lines',
  ],
}));
import { createProcurementService } from '../../procurement/procurementService';

const createPurchaseOrder = vi.fn();
const transitionPurchaseOrderStatus = vi.fn();

const createInput = {
  poNumber: 'PO-2026-0001',
  currency: 'USD',
  supplierName: 'Acme Textile',
  orderDate: '2026-08-17',
  lines: [{ description: 'Cotton Fabric', unit: 'm', quantity: 1000, unitPrice: 2.5 }],
};

describe('task procurement-flow: buildProcurementCreateDraft', () => {
  it('生成含六字段的 ProcessDraft（toolId/action/impactScope/idempotencyKey）', () => {
    const draft = buildProcurementCreateDraft({ input: createInput });
    expect(draft.subOperations[0].toolId).toBe('procurement.create');
    expect(draft.subOperations[0].action).toBe('create_purchase_order');
    expect((draft.subOperations[0].after as any).poNumber).toBe('PO-2026-0001');
    expect(draft.beforeAfterDiff.length).toBe(Object.keys(createInput).length);
    expect(draft.impactScope).toEqual(['procurement', 'entity-links', 'audit']);
    expect(draft.irreversible).toBe(false);
    expect(draft.postCommitHooks).toEqual([]);
    expect(draft.idempotencyKey).toContain('procurement.create:PO-2026-0001:');
  });
});

describe('task procurement-flow: buildProcurementUpdateStatusDraft', () => {
  it('生成含 purchaseOrderId+toStatus 的 ProcessDraft（before 用真实 status）', () => {
    const draft = buildProcurementUpdateStatusDraft({ purchaseOrderId: 'PO__1', toStatus: 'Sent', currentStatus: 'Draft' });
    expect(draft.subOperations[0].toolId).toBe('procurement.update_status');
    expect((draft.subOperations[0].after as any).toStatus).toBe('Sent');
    expect(draft.beforeAfterDiff[0]).toMatchObject({ field: 'status', before: 'Draft', after: 'Sent' });
    expect(draft.irreversible).toBe(false);
  });

  it('Cancelled/Closed 目标 → irreversible=true', () => {
    const cancelled = buildProcurementUpdateStatusDraft({ purchaseOrderId: 'PO__1', toStatus: 'Cancelled', reason: '供应商断供' });
    expect(cancelled.irreversible).toBe(true);
    expect((cancelled.subOperations[0].after as any).reason).toBe('供应商断供');
    const closed = buildProcurementUpdateStatusDraft({ purchaseOrderId: 'PO__1', toStatus: 'Closed' });
    expect(closed.irreversible).toBe(true);
  });
});

describe('task procurement-flow: validateProcurementCreateDraftSemantics（fail closed）', () => {
  it('缺 currency → SEMANTIC_VALIDATION_FAILED', () => {
    const draft = { subOperations: [{ after: { ...createInput, currency: '' } }] } as any;
    const r = validateProcurementCreateDraftSemantics(draft);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('SEMANTIC_VALIDATION_FAILED');
  });

  it('lines 为空 → SEMANTIC_VALIDATION_FAILED', () => {
    const draft = { subOperations: [{ after: { ...createInput, lines: [] } }] } as any;
    expect(validateProcurementCreateDraftSemantics(draft).ok).toBe(false);
  });

  it('line 缺 quantity/unitPrice → SEMANTIC_VALIDATION_FAILED', () => {
    const draft = { subOperations: [{ after: { ...createInput, lines: [{ description: 'x', unit: 'm' }] } }] } as any;
    expect(validateProcurementCreateDraftSemantics(draft).ok).toBe(false);
  });

  it('合法 draft → ok', () => {
    const draft = buildProcurementCreateDraft({ input: createInput });
    expect(validateProcurementCreateDraftSemantics(draft).ok).toBe(true);
  });
});

describe('task procurement-flow: validateProcurementUpdateStatusDraftSemantics（fail closed）', () => {
  it('缺 purchaseOrderId → SEMANTIC_VALIDATION_FAILED', () => {
    const draft = { subOperations: [{ after: { toStatus: 'Sent' } }] } as any;
    expect(validateProcurementUpdateStatusDraftSemantics(draft).ok).toBe(false);
  });

  it('缺 toStatus → SEMANTIC_VALIDATION_FAILED', () => {
    const draft = { subOperations: [{ after: { purchaseOrderId: 'PO__1' } }] } as any;
    expect(validateProcurementUpdateStatusDraftSemantics(draft).ok).toBe(false);
  });
});

describe('task procurement-flow: commitProcurementCreate（复用 service）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (createProcurementService as any).mockReturnValue({ createPurchaseOrder, transitionPurchaseOrderStatus });
  });

  it('draft 缺失 → PROCESS_DRAFT_MISSING', async () => {
    const r = await commitProcurementCreate({ prisma: {} as any, approvalId: 'AP1', approvalPayload: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_MISSING');
    expect(createPurchaseOrder).not.toHaveBeenCalled();
  });

  it('hash 篡改 → PROCESS_DRAFT_HASH_MISMATCH，service 不被调', async () => {
    const draft = buildProcurementCreateDraft({ input: createInput });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { ...createInput, currency: 'EUR' } }] };
    const r = await commitProcurementCreate({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: tampered } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
    expect(createPurchaseOrder).not.toHaveBeenCalled();
  });

  it('非法字段 → INVALID_INPUT，service 不被调', async () => {
    const draft = buildProcurementCreateDraft({ input: { ...createInput, deletedAt: 1 } });
    const r = await commitProcurementCreate({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('INVALID_INPUT');
    expect(createPurchaseOrder).not.toHaveBeenCalled();
  });

  it('成功 commit → committed，svc.createPurchaseOrder 带注入的请求人调用一次（★ B58 补漏：位置参数也是身份位）', async () => {
    const draft = buildProcurementCreateDraft({ input: createInput });
    createPurchaseOrder.mockResolvedValue({ id: 'PO__1', poNumber: 'PO-2026-0001' });
    const r = await commitProcurementCreate({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft }, actorId: 'usr_requester'});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.feedback.status).toBe('committed');
      expect(r.feedback.purchaseOrderId).toBe('PO__1');
      expect(r.feedback.poNumber).toBe('PO-2026-0001');
      expect(r.feedback.idempotencyKey).toBe(draft.idempotencyKey);
    }
    expect(createPurchaseOrder).toHaveBeenCalledTimes(1);
    expect(createPurchaseOrder).toHaveBeenCalledWith(expect.objectContaining({ poNumber: 'PO-2026-0001' }), 'usr_requester');
  });

  it('service 抛「已存在」→ DUPLICATE_PO_NUMBER', async () => {
    const draft = buildProcurementCreateDraft({ input: createInput });
    createPurchaseOrder.mockRejectedValue(new Error('采购单号 PO-2026-0001 已存在'));
    const r = await commitProcurementCreate({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('DUPLICATE_PO_NUMBER');
  });

  it('service 抛「已被拉黑」→ SUPPLIER_BLACKLISTED', async () => {
    const draft = buildProcurementCreateDraft({ input: createInput });
    createPurchaseOrder.mockRejectedValue(new Error('供应商 Acme 已被拉黑，禁止新建采购单'));
    const r = await commitProcurementCreate({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('SUPPLIER_BLACKLISTED');
  });

  it('service 抛未知错 → CREATE_FAILED', async () => {
    const draft = buildProcurementCreateDraft({ input: createInput });
    createPurchaseOrder.mockRejectedValue(new Error('db connection lost'));
    const r = await commitProcurementCreate({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('CREATE_FAILED');
  });
});

describe('task procurement-flow: commitProcurementUpdateStatus（状态机校验 + 复用 service）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (createProcurementService as any).mockReturnValue({ createPurchaseOrder, transitionPurchaseOrderStatus });
  });

  it('非手动可设目标（Received）→ STATUS_NOT_MANUAL_SETTABLE，service 不被调', async () => {
    const draft = buildProcurementUpdateStatusDraft({ purchaseOrderId: 'PO__1', toStatus: 'Received', currentStatus: 'Confirmed' });
    const r = await commitProcurementUpdateStatus({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('STATUS_NOT_MANUAL_SETTABLE');
    expect(transitionPurchaseOrderStatus).not.toHaveBeenCalled();
  });

  it('成功 commit → committed，svc.transitionPurchaseOrderStatus 带注入的请求人调用一次（★ B58 补漏：位置参数也是身份位）', async () => {
    const draft = buildProcurementUpdateStatusDraft({ purchaseOrderId: 'PO__1', toStatus: 'Sent', currentStatus: 'Draft' });
    transitionPurchaseOrderStatus.mockResolvedValue({ id: 'PO__1', poNumber: 'PO-2026-0001' });
    const r = await commitProcurementUpdateStatus({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft }, actorId: 'usr_requester'});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.feedback.status).toBe('committed');
    expect(transitionPurchaseOrderStatus).toHaveBeenCalledTimes(1);
    expect(transitionPurchaseOrderStatus).toHaveBeenCalledWith('PO__1', 'Sent', 'usr_requester', undefined);
  });

  it('hash 篡改 → PROCESS_DRAFT_HASH_MISMATCH，service 不被调', async () => {
    const draft = buildProcurementUpdateStatusDraft({ purchaseOrderId: 'PO__1', toStatus: 'Sent', currentStatus: 'Draft' });
    const tampered = { ...draft, subOperations: [{ ...draft.subOperations[0], after: { purchaseOrderId: 'PO__1', toStatus: 'Confirmed' } }] };
    const r = await commitProcurementUpdateStatus({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: tampered } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('PROCESS_DRAFT_HASH_MISMATCH');
    expect(transitionPurchaseOrderStatus).not.toHaveBeenCalled();
  });

  it('service 抛「非法状态转换」→ INVALID_STATUS_TRANSITION', async () => {
    const draft = buildProcurementUpdateStatusDraft({ purchaseOrderId: 'PO__1', toStatus: 'Closed', currentStatus: 'Draft' });
    transitionPurchaseOrderStatus.mockRejectedValue(new Error('非法状态转换：Draft → Closed（允许的目标：Sent, Cancelled）'));
    const r = await commitProcurementUpdateStatus({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('service 抛「不存在」→ NOT_FOUND', async () => {
    const draft = buildProcurementUpdateStatusDraft({ purchaseOrderId: 'PO__X', toStatus: 'Sent' });
    transitionPurchaseOrderStatus.mockRejectedValue(new Error('采购单 PO__X 不存在'));
    const r = await commitProcurementUpdateStatus({ prisma: {} as any, approvalId: 'AP1', approvalPayload: { processDraft: draft } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r.feedback as any).error.code).toBe('NOT_FOUND');
  });
});

describe('task procurement-flow: verifyProcurementCreateDraftHash', () => {
  it('原始 draft hash 自洽', () => {
    const draft = buildProcurementCreateDraft({ input: createInput });
    expect(verifyProcurementCreateDraftHash(draft).ok).toBe(true);
  });
});

describe('task procurement-flow: error code userAction', () => {
  it('所有 code 有 userAction', () => {
    const codes: ProcurementFlowErrorCode[] = [
      'APPROVAL_ID_MISSING', 'APPROVAL_NOT_FOUND', 'APPROVAL_MODIFIED_UNSUPPORTED',
      'PROCESS_DRAFT_MISSING', 'PROCESS_DRAFT_HASH_MISMATCH', 'SEMANTIC_VALIDATION_FAILED',
      'INVALID_INPUT', 'NOT_FOUND', 'DUPLICATE_PO_NUMBER', 'SUPPLIER_BLACKLISTED',
      'NOT_EDITABLE', 'INVALID_STATUS_TRANSITION', 'STATUS_NOT_MANUAL_SETTABLE',
      'CREATE_FAILED', 'TRANSITION_FAILED',
    ];
    for (const code of codes) expect(buildProcurementFlowError(code, 'test').userAction.length).toBeGreaterThan(0);
  });
});
