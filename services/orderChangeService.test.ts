import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ORDER_CHANGE_REASON_MIN,
  ORDER_CHANGE_IMPACT_MIN,
  buildChangeRequestDraft,
  collectControlledFieldEdits,
  isApprovedOrderStatus,
  isGuardedOrderStatus,
  orderChangeService,
  readOrderCapsuleExemption,
  readOrderMoqSnapshot,
  resolveOrderChangeType,
} from './orderChangeService';

/**
 * ERP-P3-order-change-service: DR-010 变更审批链 + MOQ dry-run 服务封装行为测试。
 * fetch 全部 mock；契约真源 server/src/orderChanges/orderChangeRoute.ts、
 * server/src/moq/moqRoute.ts（{ items } / { item } / { changeRequest, approvalRequestId } /
 * 非 2xx { error, message }）。
 */

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    clear: vi.fn(() => {
      values.clear();
    }),
  };
}

function mockFetchOnce(payload: unknown, init: { ok?: boolean; status?: number } = {}) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => payload,
  })));
}

beforeEach(() => {
  vi.stubGlobal('localStorage', createStorage());
  vi.stubGlobal('sessionStorage', createStorage());
});

// ───────────────────────────────────────────────────────────────────
// fetch 行为：六个端点全部经 apiService 统一通道
// ───────────────────────────────────────────────────────────────────

describe('orderChangeService fetch 行为', () => {
  it('listChangeRequests: GET /v1/order-changes?orderId=… 并解包 { items }', async () => {
    mockFetchOnce({ items: [{ id: 'CR1', orderId: 'O1', changeTypes: ['quantity'], status: 'Pending' }] });
    const list = await orderChangeService.listChangeRequests({ orderId: 'O1' });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/order-changes?orderId=O1'),
      expect.objectContaining({ headers: expect.any(Object) }),
    );
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('CR1');
  });

  it('listChangeRequests: 可选 status/requesterId/limit 进 query', async () => {
    mockFetchOnce({ items: [] });
    await orderChangeService.listChangeRequests({ orderId: 'O1', status: 'Pending', requesterId: 'U1', limit: 20 });
    const url = (fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('orderId=O1');
    expect(url).toContain('status=Pending');
    expect(url).toContain('requesterId=U1');
    expect(url).toContain('limit=20');
  });

  it('listChangeRequests: items 非数组时回落 []（不炸 UI）', async () => {
    mockFetchOnce({ items: null });
    const list = await orderChangeService.listChangeRequests({ orderId: 'O1' });
    expect(list).toEqual([]);
  });

  it('getChangeRequest: GET /v1/order-changes/:id（id 经 encodeURIComponent）并解包 { item }', async () => {
    mockFetchOnce({ item: { id: 'CR/1', orderId: 'O1', changeTypes: ['other'], status: 'Approved', approvalRequest: { id: 'AR1', status: 'approved' } } });
    const detail = await orderChangeService.getChangeRequest('CR/1');
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/order-changes/CR%2F1'),
      expect.anything(),
    );
    expect(detail.approvalRequest?.status).toBe('approved');
  });

  it('createChangeRequest: POST /v1/order-changes 带完整 body', async () => {
    mockFetchOnce({ changeRequest: { id: 'CR1', requestNumber: 'OCR-1' }, approvalRequestId: 'AR1' }, { status: 201 });
    const input = {
      orderId: 'O1',
      changeType: 'quantity' as const,
      beforeSnapshot: { quantity: 100 },
      afterDelta: { quantity: 180 },
      changeReason: '客户追加订单数量，需重排产',
      impactSummary: '交期顺延五天，成本微增',
    };
    const res = await orderChangeService.createChangeRequest(input);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/order-changes'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(input),
      }),
    );
    expect(res.approvalRequestId).toBe('AR1');
  });

  it('withdrawChangeRequest: POST /v1/order-changes/:id/withdraw', async () => {
    mockFetchOnce({ changeRequest: { id: 'CR1', status: 'Cancelled' } });
    const res = await orderChangeService.withdrawChangeRequest('CR1');
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/order-changes/CR1/withdraw'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(res.changeRequest.status).toBe('Cancelled');
  });

  it('applyChangeRequest: POST /v1/order-changes/:id/apply', async () => {
    mockFetchOnce({ changeRequest: { id: 'CR1', status: 'Applied' }, applied: 'applied' });
    const res = await orderChangeService.applyChangeRequest('CR1');
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/order-changes/CR1/apply'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(res.applied).toBe('applied');
  });

  it('reviseRejectedChangeRequest: posts an immutable successor proposal to the rejected source', async () => {
    mockFetchOnce({ changeRequest: { id: 'CR2', revisionOfId: 'CR1' }, approvalRequestId: 'AR2', revisionOfId: 'CR1' }, { status: 201 });
    const input = { afterDelta: { unitPrice: '12.40' }, changeReason: '客户重新核对后请求调整单价', impactSummary: '新的价格需同步合同和应收金额' };
    const result = await orderChangeService.reviseRejectedChangeRequest('CR1', input);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/v1/order-changes/CR1/revise'), expect.objectContaining({
      method: 'POST', body: JSON.stringify(input),
    }));
    expect(result.revisionOfId).toBe('CR1');
  });

  it('previewChangeRequestAmendment and amendAndApproveChangeRequest carry the server proposal fingerprint', async () => {
    mockFetchOnce({ finalProposalFingerprint: 'a'.repeat(64), proposal: {} });
    const previewInput = { afterDelta: { unitPrice: '12.40' }, changeReason: '客户重新核对后请求调整拟定单价',
      impactSummary: '新的价格需同步合同和应收金额', reviewContentVersion: 'b'.repeat(64) };
    await orderChangeService.previewChangeRequestAmendment('CR1', previewInput);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/v1/order-changes/CR1/amend-preview'), expect.objectContaining({
      method: 'POST', body: JSON.stringify(previewInput),
    }));
    mockFetchOnce({ changeRequest: { id: 'CR2', revisionOfId: 'CR1' }, approvalRequestId: 'AR2', revisionOfId: 'CR1' });
    const input = { afterDelta: { unitPrice: '12.40' }, changeReason: '客户重新核对后请求调整单价',
      impactSummary: '新的价格需同步合同和应收金额', decisionNote: '已核对差异', reviewContentVersion: 'b'.repeat(64),
      expectedFinalProposalFingerprint: 'a'.repeat(64), confirmedReviewedContent: true as const };
    await orderChangeService.amendAndApproveChangeRequest('CR1', input);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/v1/order-changes/CR1/amend-and-approve'), expect.objectContaining({
      method: 'POST', body: JSON.stringify(input),
    }));
  });

  it('validateMoq: POST /v1/moq/validate 带 lines/snapshot/capsuleExemption', async () => {
    mockFetchOnce({ ok: true, capsuleActive: false, lines: [], blockedLineIndexes: [], snapshot: {} });
    await orderChangeService.validateMoq({
      type: 'Garment',
      businessLine: 'capsule',
      capsuleExemption: true,
      snapshot: null,
      lines: [{ quantity: 30, unit: '件' }],
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/moq/validate'),
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"capsuleExemption":true'),
      }),
    );
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0].quantity).toBe(30);
  });

  it('错误契约: 非 2xx { error, message } → 抛带 code 的 Error(CODE：message)', async () => {
    mockFetchOnce(
      { error: 'ORDER_CHANGE_ALREADY_PENDING', message: '存在进行中的变更申请' },
      { ok: false, status: 409 },
    );
    const err = await orderChangeService.listChangeRequests({ orderId: 'O1' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('ORDER_CHANGE_ALREADY_PENDING：存在进行中的变更申请');
    expect((err as Error & { code?: string }).code).toBe('ORDER_CHANGE_ALREADY_PENDING');
  });

  it('错误契约: 非 2xx 无 message 时回落 HTTP 状态码文案', async () => {
    mockFetchOnce({}, { ok: false, status: 500 });
    const err = await orderChangeService.applyChangeRequest('CR1').catch((e) => e);
    expect(err.message).toContain('500');
  });
});

// ───────────────────────────────────────────────────────────────────
// 纯函数：buildChangeRequestDraft（客户端校验镜像服务端 fail-closed 下限）
// ───────────────────────────────────────────────────────────────────

const ORDER_CTX = {
  id: 'O1',
  status: 'Confirmed',
  quantity: 100,
  quoteAmount: 50000,
  dueDate: '2026-09-01',
  customer: 'ACME',
  customerRelationId: 'R1',
  product: '全棉斜纹',
};

const REASON = 'a'.repeat(ORDER_CHANGE_REASON_MIN);
const IMPACT = 'b'.repeat(ORDER_CHANGE_IMPACT_MIN);

describe('buildChangeRequestDraft', () => {
  it('quantity: requires an exact per-line plan instead of guessing from the order header', () => {
    const quantityPlanDraft = {
      orderId: 'O1', expectedUpdatedAt: '1', rows: [{
        lineId: 'L1', beforeQuantity: '100', unit: 'PC', beforeUnitPrice: '500', beforeNetValue: '50000',
        afterQuantity: '180', afterNetValue: '90000',
      }],
    };
    const r = buildChangeRequestDraft(ORDER_CTX, { changeType: 'quantity', quantityPlanDraft, changeReason: REASON, impactSummary: IMPACT });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.beforeSnapshot).toEqual({ quantity: 100 });
      expect(r.payload.afterDelta).toEqual({ lineQuantityPlan: {
        version: 2, orderId: 'O1', expectedUpdatedAt: '1', lines: [{ lineId: 'L1', beforeQuantity: '100', unit: 'PC', afterQuantity: '180', beforeUnitPrice: '500', beforeNetValue: '50000', afterNetValue: '90000' }],
      } });
      expect(r.payload.orderId).toBe('O1');
      expect(r.payload.changeType).toBe('quantity');
    }
  });

  it('price: unitPrice 键（镜像服务端 ORDER_FIELD_MAP）', () => {
    const r = buildChangeRequestDraft(ORDER_CTX, { changeType: 'price', afterAmount: '52000', changeReason: REASON, impactSummary: IMPACT });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.beforeSnapshot).toEqual({ unitPrice: 50000 });
      expect(r.payload.afterDelta).toEqual({ unitPrice: 52000 });
    }
  });

  it('delivery: 交期 YYYY-MM-DD', () => {
    const r = buildChangeRequestDraft(ORDER_CTX, { changeType: 'delivery', afterDeliveryDate: '2026-09-20', changeReason: REASON, impactSummary: IMPACT });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.afterDelta).toEqual({ deliveryDate: '2026-09-20' });
  });

  it('customer: 客户 + customerRelationId 缺省按名称', () => {
    const r = buildChangeRequestDraft(ORDER_CTX, { changeType: 'customer', afterCustomer: 'BETA', changeReason: REASON, impactSummary: IMPACT });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.beforeSnapshot).toEqual({ customer: 'ACME', customerRelationId: 'R1' });
      expect(r.payload.afterDelta).toEqual({ customer: 'BETA', customerRelationId: 'BETA' });
    }
  });

  it('product: 产品描述', () => {
    const r = buildChangeRequestDraft(ORDER_CTX, { changeType: 'product', afterProduct: '涤棉府绸', changeReason: REASON, impactSummary: IMPACT });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.afterDelta).toEqual({ product: '涤棉府绸' });
  });

  it('cancel: before 状态 → after Cancelled', () => {
    const r = buildChangeRequestDraft(ORDER_CTX, { changeType: 'cancel', changeReason: REASON, impactSummary: IMPACT });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.beforeSnapshot).toEqual({ status: 'Confirmed' });
      expect(r.payload.afterDelta).toEqual({ status: 'Cancelled' });
    }
  });

  it('pause: 三要素（原因/责任人/恢复日期）全部进 payload', () => {
    const r = buildChangeRequestDraft(ORDER_CTX, {
      changeType: 'pause',
      pauseReason: '客户资金链核查',
      pauseOwnerId: 'U9',
      expectedResumeDate: '2099-01-01',
      changeReason: REASON,
      impactSummary: IMPACT,
    }, { today: '2026-08-16' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.afterDelta).toEqual({ status: 'Paused' });
      expect(r.payload.pauseReason).toBe('客户资金链核查');
      expect(r.payload.pauseOwnerId).toBe('U9');
      expect(r.payload.expectedResumeDate).toBe('2099-01-01');
    }
  });

  it('变更理由不足下限 → fail-closed', () => {
    const r = buildChangeRequestDraft(ORDER_CTX, { changeType: 'cancel', changeReason: '太短', impactSummary: IMPACT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(String(ORDER_CHANGE_REASON_MIN));
  });

  it('影响说明不足下限 → fail-closed', () => {
    const r = buildChangeRequestDraft(ORDER_CTX, { changeType: 'cancel', changeReason: REASON, impactSummary: '短' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(String(ORDER_CHANGE_IMPACT_MIN));
  });

  it('quantity: 非正数 → fail-closed', () => {
    const r = buildChangeRequestDraft(ORDER_CTX, { changeType: 'quantity', afterQuantity: '0', changeReason: REASON, impactSummary: IMPACT });
    expect(r.ok).toBe(false);
  });

  it('delivery: 非法日期格式 → fail-closed', () => {
    const r = buildChangeRequestDraft(ORDER_CTX, { changeType: 'delivery', afterDeliveryDate: '09/20/2026', changeReason: REASON, impactSummary: IMPACT });
    expect(r.ok).toBe(false);
  });

  it('customer: 空客户 → fail-closed', () => {
    const r = buildChangeRequestDraft(ORDER_CTX, { changeType: 'customer', afterCustomer: '  ', changeReason: REASON, impactSummary: IMPACT });
    expect(r.ok).toBe(false);
  });

  it('pause: 恢复日期早于今天 → fail-closed', () => {
    const r = buildChangeRequestDraft(ORDER_CTX, {
      changeType: 'pause',
      pauseReason: 'x',
      pauseOwnerId: 'U9',
      expectedResumeDate: '2026-01-01',
      changeReason: REASON,
      impactSummary: IMPACT,
    }, { today: '2026-08-16' });
    expect(r.ok).toBe(false);
  });

  it('pause: 缺责任人 → fail-closed', () => {
    const r = buildChangeRequestDraft(ORDER_CTX, {
      changeType: 'pause',
      pauseReason: 'x',
      expectedResumeDate: '2099-01-01',
      changeReason: REASON,
      impactSummary: IMPACT,
    }, { today: '2026-08-16' });
    expect(r.ok).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────
// 纯函数：受控字段侦测（DR-010 编辑门禁）
// ───────────────────────────────────────────────────────────────────

describe('collectControlledFieldEdits', () => {
  it('检出数量/金额/交期/客户/产品五类受控改动', () => {
    const edits = collectControlledFieldEdits(
      { quantity: 100, salesPrice: 5, dueDate: '2026-09-01', customer: 'ACME', product: 'A' },
      { quantity: 180, salesPrice: 6, dueDate: '2026-09-20', customer: 'BETA', product: 'B' },
    );
    const types = edits.map((e) => e.changeType);
    expect(types).toContain('quantity');
    expect(types).toContain('price');
    expect(types).toContain('delivery');
    expect(types).toContain('customer');
    expect(types).toContain('product');
    expect(edits.find((e) => e.field === 'quantity')?.after).toBe(180);
  });

  it('非受控字段改动不检出', () => {
    const edits = collectControlledFieldEdits(
      { season: 'SS26', merchandiser: '甲' },
      { season: 'FW26', merchandiser: '乙' },
    );
    expect(edits).toEqual([]);
  });

  it('数字等价（180 vs "180"）不误判', () => {
    const edits = collectControlledFieldEdits({ quantity: 180 }, { quantity: '180' });
    expect(edits).toEqual([]);
  });

  it('空串与 undefined 视为相等，不误判', () => {
    const edits = collectControlledFieldEdits({ customer: undefined }, { customer: '' });
    expect(edits).toEqual([]);
  });

  it('受控字段未变 → 空结果', () => {
    const edits = collectControlledFieldEdits(
      { quantity: 100, customer: 'ACME' },
      { quantity: 100, customer: 'ACME' },
    );
    expect(edits).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────
// 纯函数：订单扩展字段运行时收窄读取
// ───────────────────────────────────────────────────────────────────

describe('readOrderMoqSnapshot', () => {
  it('合法快照完整解析（三档 + snapshotAt + configId + source）', () => {
    const s = readOrderMoqSnapshot({
      moqSnapshot: {
        fabricDefaultMoq: 800,
        garmentDefaultMoq: 200,
        capsuleMoq: 20,
        snapshotAt: '2026-08-01T00:00:00.000Z',
        configId: 'CFG1',
        source: 'moq_config',
      },
    });
    expect(s).toEqual({
      fabricDefaultMoq: 800,
      garmentDefaultMoq: 200,
      capsuleMoq: 20,
      snapshotAt: '2026-08-01T00:00:00.000Z',
      configId: 'CFG1',
      source: 'moq_config',
    });
  });

  it('缺 snapshotAt → null（防半截快照误展示）', () => {
    expect(readOrderMoqSnapshot({ moqSnapshot: { fabricDefaultMoq: 800, garmentDefaultMoq: 200, capsuleMoq: 20 } })).toBeNull();
  });

  it('非对象 / 缺失 → null', () => {
    expect(readOrderMoqSnapshot({ moqSnapshot: 'junk' })).toBeNull();
    expect(readOrderMoqSnapshot({})).toBeNull();
    expect(readOrderMoqSnapshot(null)).toBeNull();
  });

  it('未知 source 归一为 moq_config；fallback_constant 保留', () => {
    const base = { fabricDefaultMoq: 1, garmentDefaultMoq: 1, capsuleMoq: 1, snapshotAt: '2026-08-01T00:00:00.000Z' };
    expect(readOrderMoqSnapshot({ moqSnapshot: { ...base, source: 'fallback_constant' } })?.source).toBe('fallback_constant');
    expect(readOrderMoqSnapshot({ moqSnapshot: { ...base, source: 'unknown_xyz' } })?.source).toBe('moq_config');
  });
});

describe('readOrderCapsuleExemption', () => {
  it('仅严格 true 生效', () => {
    expect(readOrderCapsuleExemption({ capsuleExemption: true })).toBe(true);
    expect(readOrderCapsuleExemption({ capsuleExemption: false })).toBe(false);
    expect(readOrderCapsuleExemption({ capsuleExemption: 'true' })).toBe(false);
    expect(readOrderCapsuleExemption({})).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────
// 纯函数：变更类型反推 + 状态守卫
// ───────────────────────────────────────────────────────────────────

describe('resolveOrderChangeType', () => {
  it('schema changeTypes[0] → 业务类型', () => {
    expect(resolveOrderChangeType({ changeTypes: ['unitPrice'] })).toBe('price');
    expect(resolveOrderChangeType({ changeTypes: ['quantity'] })).toBe('quantity');
    expect(resolveOrderChangeType({ changeTypes: ['deliveryDate'] })).toBe('delivery');
    expect(resolveOrderChangeType({ changeTypes: ['customer'] })).toBe('customer');
    expect(resolveOrderChangeType({ changeTypes: ['product_spec'] })).toBe('product');
  });

  it('other 由 attachments.pause 区分 pause/cancel', () => {
    expect(resolveOrderChangeType({ changeTypes: ['other'], attachments: { pause: { expectedResumeDate: '2099-01-01' } } })).toBe('pause');
    expect(resolveOrderChangeType({ changeTypes: ['other'], attachments: null })).toBe('cancel');
    expect(resolveOrderChangeType({ changeTypes: [] })).toBe('cancel');
  });
});

describe('状态守卫', () => {
  it('isApprovedOrderStatus: 已批准四态', () => {
    for (const s of ['Confirmed', 'Production', 'Shipping', 'Delivered']) {
      expect(isApprovedOrderStatus(s)).toBe(true);
    }
    for (const s of ['Pending', 'Alert', 'Paused', 'Cancelled', null, undefined, '']) {
      expect(isApprovedOrderStatus(s)).toBe(false);
    }
  });

  it('isGuardedOrderStatus: DR-010 守卫四态', () => {
    for (const s of ['CancelRequested', 'PauseRequested', 'Closing', 'Paused']) {
      expect(isGuardedOrderStatus(s)).toBe(true);
    }
    for (const s of ['Confirmed', 'Pending', null, undefined]) {
      expect(isGuardedOrderStatus(s)).toBe(false);
    }
  });
});
