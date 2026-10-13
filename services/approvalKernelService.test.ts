import { beforeEach, describe, expect, it, vi } from 'vitest';
import { approvalKernelService, isFallbackRoute, RESOLVER_ROUTE_LABEL } from './approvalKernelService';

const ENDPOINT = 'https://test.example.com';
const REVIEW_VERSION = 'a'.repeat(64);

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
    clear: vi.fn(() => { values.clear(); }),
  };
}

describe('approvalKernelService（DR-007 审批内核 contract）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('localStorage', createStorage());
    vi.stubGlobal('sessionStorage', createStorage());
  });

  it('listBusinessApprovals GET /v1/approvals?status=pending 并返回 items', async () => {
    const fetchMock = vi.fn(async (..._args: any[]) => ({
      ok: true,
      json: async () => ({ items: [{ id: 'APR__1', status: 'pending' }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const items = await approvalKernelService.listBusinessApprovals('pending', ENDPOINT);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/approvals?status=pending');
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('APR__1');
  });

  it('getBusinessApproval performs one exact permission-scoped native detail read', async () => {
    const fetchMock = vi.fn(async (..._args: any[]) => ({
      ok: true,
      json: async () => ({ item: { id: 'APR/1', status: 'approved', requesterId: 'USR_applicant', businessSyncStatus: 'failed' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const item = await approvalKernelService.getBusinessApproval('APR/1', ENDPOINT);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/approvals/APR%2F1');
    expect(init?.method ?? 'GET').toBe('GET');
    expect(item).toMatchObject({ id: 'APR/1', status: 'approved', businessSyncStatus: 'failed' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('getApprovalReviewDetail reads only the matching typed detail and preserves source/history status', async () => {
    const detail = {
      schemaVersion: 1, approvalId: 'APR/1', actionType: 'finance:payment_request', targetType: 'PaymentRequest', targetId: 'PR-1',
      title: '付款申请 · PR-1', reviewContentVersion: REVIEW_VERSION,
      frozen: { label: '本次申请冻结内容', fields: [{ key: '付款金额', label: '付款金额', value: '120 USD' }], attachments: [],
        attachmentStatus: 'not_applicable', attachmentStatusLabel: '本次申请未附带附件',
        sourceReference: { kind: 'payment_request', id: 'PR-1', label: '付款申请' }, previewDigest: 'b'.repeat(64) },
      currentSource: { status: 'unavailable', label: '当前业务状态读取失败', fields: [] },
      decisionHistory: [], decisionHistoryStatus: 'available', approvalBlockers: [], canApprove: true,
    };
    const fetchMock = vi.fn(async (..._args: any[]) => ({ ok: true, json: async () => ({ detail }) }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await approvalKernelService.getApprovalReviewDetail('APR/1', ENDPOINT);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/approvals/APR%2F1/detail');
    expect(result).toMatchObject({ approvalId: 'APR/1', currentSource: { status: 'unavailable' }, decisionHistoryStatus: 'available' });
  });

  it('rejects malformed or unrelated review detail instead of displaying guessed content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ detail: {
      schemaVersion: 1, approvalId: 'OTHER', actionType: 'x', targetType: 'X', targetId: null, title: 'x', reviewContentVersion: REVIEW_VERSION,
      frozen: { label: 'x', fields: [], attachments: [], attachmentStatus: 'not_applicable', attachmentStatusLabel: '未附附件',
        sourceReference: null, previewDigest: 'b'.repeat(64) },
      currentSource: { status: 'missing', label: 'x', fields: [] }, decisionHistory: [], decisionHistoryStatus: 'available', approvalBlockers: [], canApprove: true,
    } }) })));
    await expect(approvalKernelService.getApprovalReviewDetail('APR-1', ENDPOINT)).rejects.toThrow('无法安全审阅');
  });

  it('does not substitute an unrelated item for an exact detail response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ item: { id: 'other', status: 'approved' } }) })));
    await expect(approvalKernelService.getBusinessApproval('APR__1', ENDPOINT)).rejects.toThrow('编号不一致');
  });

  it('getResolutionTrace GET /v1/approvals-kernel/:id/resolution-trace（id 编码）', async () => {
    const fetchMock = vi.fn(async (..._args: any[]) => ({
      ok: true,
      json: async () => ({
        item: {
          id: 'APR__1',
          reviewerResolverRoute: 'FALLBACK_ADMIN',
          departmentSnapshotId: 'DEPT_NONE',
          reviewerId: 'USR_admin',
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const trace = await approvalKernelService.getResolutionTrace('APR__1', ENDPOINT);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/approvals-kernel/APR__1/resolution-trace');
    expect(init?.method ?? 'GET').toBe('GET');
    expect(trace.reviewerResolverRoute).toBe('FALLBACK_ADMIN');
  });

  it('delegateApproval POST /delegate 携带 toUserId + reason', async () => {
    const fetchMock = vi.fn(async (..._args: any[]) => ({
      ok: true,
      json: async () => ({ item: { id: 'APR__1', reviewerId: 'USR_delegate', delegatedBy: 'USR_head' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await approvalKernelService.delegateApproval('APR__1', { toUserId: 'USR_delegate', reason: '出差十天，转派给同部门同事跟进' }, ENDPOINT);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/approvals-kernel/APR__1/delegate');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ toUserId: 'USR_delegate', reason: '出差十天，转派给同部门同事跟进' });
  });

  it('delegateApproval 透出服务端 403 DELEGATION_NOT_BY_REVIEWER', async () => {
    vi.stubGlobal('fetch', vi.fn(async (..._args: any[]) => ({
      ok: false,
      status: 403,
      json: async () => ({ error: 'DELEGATION_NOT_BY_REVIEWER：仅当前审批人本人可发起转派' }),
    })));

    await expect(
      approvalKernelService.delegateApproval('APR__1', { toUserId: 'USR_x', reason: '超过十个字的委派理由' }, ENDPOINT),
    ).rejects.toThrow('DELEGATION_NOT_BY_REVIEWER');
  });

  it('bossBypassApproval POST /boss-bypass 携带 reason（≥30 字由服务端强制）', async () => {
    const fetchMock = vi.fn(async (..._args: any[]) => ({
      ok: true,
      json: async () => ({ item: { id: 'APR__1', status: 'approved', bossFinalBypassBy: 'USR_boss' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const reason = '客户生产线停线待料，风险已评估并由我承担最终责任，特批放行';
    const item = await approvalKernelService.bossBypassApproval('APR__1', { reason, reviewContentVersion: REVIEW_VERSION, confirmedReviewedContent: true }, ENDPOINT);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/approvals-kernel/APR__1/boss-bypass');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ reason, reviewContentVersion: REVIEW_VERSION, confirmedReviewedContent: true });
    expect(item.bossFinalBypassBy).toBe('USR_boss');
  });

  it('bossBypassApproval 透出 403 BOSS_BYPASS_REQUIRES_OWNER', async () => {
    vi.stubGlobal('fetch', vi.fn(async (..._args: any[]) => ({
      ok: false,
      status: 403,
      json: async () => ({ error: 'BOSS_BYPASS_REQUIRES_OWNER：仅超级管理员（BOSS）可最终兜底特批' }),
    })));

    await expect(
      approvalKernelService.bossBypassApproval('APR__1', { reason: 'x'.repeat(30), reviewContentVersion: REVIEW_VERSION, confirmedReviewedContent: true }, ENDPOINT),
    ).rejects.toThrow('BOSS_BYPASS_REQUIRES_OWNER');
  });

  it('isFallbackRoute：DEPT_HEAD 不算兜底，FALLBACK_* 算兜底', () => {
    expect(isFallbackRoute('DEPT_HEAD')).toBe(false);
    expect(isFallbackRoute('FALLBACK_ADMIN')).toBe(true);
    expect(isFallbackRoute('FALLBACK_DEPT_HEAD_VACANT')).toBe(true);
    expect(isFallbackRoute('FALLBACK_SELF_APPLY_SUPERVISOR')).toBe(true);
    expect(isFallbackRoute(null)).toBe(false);
  });

  it('RESOLVER_ROUTE_LABEL 覆盖全部四条 DR-007 路径', () => {
    expect(Object.keys(RESOLVER_ROUTE_LABEL).sort()).toEqual([
      'DEPT_HEAD',
      'FALLBACK_ADMIN',
      'FALLBACK_DEPT_HEAD_VACANT',
      'FALLBACK_SELF_APPLY_SUPERVISOR',
    ]);
  });

  it('decideApproval POST /v1/approvals/:id/decide carries reviewed-version and separate rejection facts', async () => {
    const fetchMock = vi.fn(async (..._args: any[]) => ({
      ok: true,
      json: async () => ({ item: { id: 'APR__1', status: 'rejected' }, sync: { status: 'failed', retryable: true, code: 'APPROVAL_SYNC_FAILED' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const item = await approvalKernelService.decideApproval('APR__1', 'rejected', {
      reviewContentVersion: REVIEW_VERSION, rejectionReason: '偏差过大不接受', requestedChanges: '重新核算并提交客户确认',
    }, ENDPOINT);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/approvals/APR__1/decide');
    expect(JSON.parse(String(init?.body))).toEqual({ status: 'rejected', reviewContentVersion: REVIEW_VERSION,
      rejectionReason: '偏差过大不接受', requestedChanges: '重新核算并提交客户确认' });
    expect(item.decisionSync).toEqual({ status: 'failed', retryable: true, code: 'APPROVAL_SYNC_FAILED' });
  });

  it('treats a malformed decision response as unverified instead of returning a guessed item', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ item: { id: 'other', status: 'approved' } }) })));
    await expect(approvalKernelService.decideApproval('APR__1', 'approved', {
      reviewContentVersion: REVIEW_VERSION, confirmedReviewedContent: true,
    }, ENDPOINT)).rejects.toThrow('无法核验');
  });

  it('retryBusinessSync posts only the exact approval ID to the idempotent server recovery endpoint', async () => {
    const fetchMock = vi.fn(async (..._args: any[]) => ({
      ok: true,
      json: async () => ({ item: { id: 'APR__1', status: 'approved' }, sync: { status: 'completed', retryable: false } }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await approvalKernelService.retryBusinessSync('APR__1', ENDPOINT);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/approvals/APR__1/retry-sync');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({});
    expect(result.sync).toEqual({ status: 'completed', retryable: false });
  });

  it('does not report malformed retry output as completed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ item: { id: 'APR__1', status: 'approved' }, sync: { status: 'completed' } }) })));
    await expect(approvalKernelService.retryBusinessSync('APR__1', ENDPOINT)).rejects.toThrow('无法核验');
  });

  it('quotation amendment preview posts an exact draft and rejects malformed preview identities', async () => {
    const preview = { approvalId: 'APR__1', actionType: 'quotation:line_approve', targetType: 'QuotationLine', targetId: 'QL__1',
      sourceVersion: 3, sourceFingerprint: 'a'.repeat(64), finalVersion: 4, finalContentVersion: 'b'.repeat(64),
      previewVersion: 'c'.repeat(64), diff: [{ field: 'lines.QL__1.unitPrice', before: '10', after: '9' }],
      before: {}, after: {}, priceRuleLevel: 'ok', priceRuleFindings: {}, moq: { ok: true, basisHash: 'm', currentApprovalId: null } };
    const fetchMock = vi.fn(async (..._args: any[]) => ({ ok: true, json: async () => ({ preview }) }));
    vi.stubGlobal('fetch', fetchMock);
    const body = { lineUnitPrices: [{ lineId: 'QL__1', unitPrice: '9' }], reason: '领导要求调整本行报价' };
    await approvalKernelService.previewQuotationAmendment('APR__1', { reviewContentVersion: REVIEW_VERSION, amendment: body }, ENDPOINT);
    expect(fetchMock.mock.calls[0][0]).toContain('/v1/approvals/APR__1/quotation-amendment/preview');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ reviewContentVersion: REVIEW_VERSION, amendment: body });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ preview: { ...preview, approvalId: 'OTHER' } }) })));
    await expect(approvalKernelService.previewQuotationAmendment('APR__1', { reviewContentVersion: REVIEW_VERSION, amendment: body }, ENDPOINT))
      .rejects.toThrow('编号不一致');
  });

  it('development fee final preview validates identity and preserves exact strings for the locked decision', async () => {
    const preview = { approvalId: 'APR__1', reviewContentVersion: REVIEW_VERSION, sourceBillingItemVersion: 4,
      finalInput: { amount: '1250.1250', waivedAmount: '50.0000', reason: '客户同意承担加急开发费用' },
      diff: [{ field: 'amount', before: '1200.0000', after: '1250.1250' }], previewDigest: 'd'.repeat(64) };
    const fetchMock = vi.fn(async (..._args: any[]) => ({ ok: true, json: async () => ({ preview }) }));
    vi.stubGlobal('fetch', fetchMock);
    const finalInput = { amount: '1250.1250', waivedAmount: '50.0000', reason: '客户同意承担加急开发费用' };
    await approvalKernelService.previewDevelopmentFeeFinalProposal('APR__1', { reviewContentVersion: REVIEW_VERSION, finalInput }, ENDPOINT);
    expect(fetchMock.mock.calls[0][0]).toContain('/v1/approvals/APR__1/development-fee-preview');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ reviewContentVersion: REVIEW_VERSION, finalInput });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ preview: { ...preview, approvalId: 'OTHER' } }) })));
    await expect(approvalKernelService.previewDevelopmentFeeFinalProposal('APR__1', { reviewContentVersion: REVIEW_VERSION, finalInput }, ENDPOINT))
      .rejects.toThrow('编号、内容版本或最终金额');
  });

  it('quotation amendment confirm requires explicit final review and validates approved exact readback shape', async () => {
    const amendment = { lineUnitPrices: [{ lineId: 'QL__1', unitPrice: '9' }], reason: '领导要求调整本行报价',
      previewVersion: 'c'.repeat(64), finalContentVersion: 'b'.repeat(64) };
    const fetchMock = vi.fn(async (..._args: any[]) => ({ ok: true, json: async () => ({ item: { id: 'APR__1', status: 'approved' },
      amendment: { approvalId: 'APR__1', sourceVersion: 3, finalVersion: 4, sourceFingerprint: 'a'.repeat(64), finalFingerprint: 'b'.repeat(64), finalContentVersion: 'b'.repeat(64) } }) }));
    vi.stubGlobal('fetch', fetchMock);
    await approvalKernelService.confirmQuotationAmendment('APR__1', { reviewContentVersion: REVIEW_VERSION, confirmedReviewedContent: true, amendment }, ENDPOINT);
    expect(fetchMock.mock.calls[0][0]).toContain('/v1/approvals/APR__1/quotation-amendment/confirm');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ reviewContentVersion: REVIEW_VERSION, confirmedReviewedContent: true, amendment });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ item: { id: 'APR__1', status: 'approved' },
      amendment: { approvalId: 'OTHER', finalVersion: 4, finalContentVersion: 'b'.repeat(64) } }) })));
    await expect(approvalKernelService.confirmQuotationAmendment('APR__1', { reviewContentVersion: REVIEW_VERSION, confirmedReviewedContent: true, amendment }, ENDPOINT))
      .rejects.toThrow('无法核验');
  });

  it('quotation amendment business readback uses the exact native result endpoint and checks the approval id', async () => {
    const result = { approvalId: 'APR__1', amended: true, decisionStatus: 'approved',
      amendment: { sourceVersion: 3, finalVersion: 4, sourceFingerprint: 'a'.repeat(64), finalFingerprint: 'b'.repeat(64), finalContentVersion: 'b'.repeat(64) }, currentSource: { version: 4, contentFingerprint: 'b'.repeat(64), quotationSnapshot: {} } };
    const fetchMock = vi.fn(async (..._args: any[]) => ({ ok: true, json: async () => ({ result }) }));
    vi.stubGlobal('fetch', fetchMock);
    await approvalKernelService.getQuotationAmendmentResult('APR__1', ENDPOINT);
    expect(fetchMock.mock.calls[0][0]).toContain('/v1/approvals/APR__1/quotation-amendment/result');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ result: { ...result, approvalId: 'OTHER' } }) })));
    await expect(approvalKernelService.getQuotationAmendmentResult('APR__1', ENDPOINT)).rejects.toThrow('编号不一致');
  });
});
