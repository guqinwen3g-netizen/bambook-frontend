/** Actual HTTP router and scope decisions; identities, L2 lookups and domain
 * producers are explicit substitutes. This only proves error-response contracts,
 * not account/L2 enforcement, approval authority or SQL rollback. */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const doubles = vi.hoisted(() => ({
  actor: { userId: 'claim-error-actor', roles: [], permissions: [
    'aftersales:read', 'aftersales:write', 'inventory:write', 'production:write', 'qc:write', 'shipments:write',
  ], authorizationLoaded: true },
  currentActor: vi.fn(), sources: vi.fn(), parent: vi.fn(),
  services: { approval: vi.fn(), addDisposition: vi.fn(), resubmit: vi.fn(), receive: vi.fn(), scrap: vi.fn(),
    returnReceipt: vi.fn(), repairOrder: vi.fn(), start: vi.fn(), complete: vi.fn(), inspection: vi.fn(),
    returnShipment: vi.fn(), stockRead: vi.fn(), stockBind: vi.fn(), creditNote: vi.fn(), versions: vi.fn(), issue: vi.fn() },
}));
vi.mock('../../auth/middleware', () => ({ extractActorFromRequest: () => doubles.actor }));
vi.mock('../claimVisibility', async importOriginal => ({ ...await importOriginal<any>(), createClaimVisibility: () => ({
  currentActor: doubles.currentActor, requireCase: doubles.parent, requireChild: doubles.parent,
  requireCreditNote: doubles.parent, requireInvoice: doubles.parent,
  candidateCustomers: doubles.sources, candidateOrders: doubles.sources, candidateInvoices: doubles.sources,
}) }));
vi.mock('../../approvals/approvalCreateService', () => ({ createApprovalCreateService: () => ({ createBusinessApproval: doubles.services.approval }) }));
vi.mock('../claimCaseService', async importOriginal => ({ ...await importOriginal<any>(), addDisposition: doubles.services.addDisposition }));
vi.mock('../claimReapprovalService', () => ({ resubmitClaimApproval: doubles.services.resubmit }));
vi.mock('../claimReturnFulfillmentService', async importOriginal => ({ ...await importOriginal<any>(),
  receiveClaimReturn: doubles.services.receive, scrapClaimReturn: doubles.services.scrap }));
vi.mock('../returnReceiptService', async importOriginal => ({ ...await importOriginal<any>(), getReturnReceipt: doubles.services.returnReceipt }));
vi.mock('../repairWorkOrderService', async importOriginal => ({ ...await importOriginal<any>(), getRepairWorkOrder: doubles.services.repairOrder }));
vi.mock('../claimRepairFulfillmentService', async importOriginal => ({ ...await importOriginal<any>(),
  startClaimRepair: doubles.services.start, completeClaimRepair: doubles.services.complete, recordClaimRepairInspection: doubles.services.inspection }));
vi.mock('../claimShipmentFulfillmentService', async importOriginal => ({ ...await importOriginal<any>(),
  createClaimRepairReturnShipment: doubles.services.returnShipment, getClaimShipmentStockBinding: doubles.services.stockRead,
  bindClaimShipmentStock: doubles.services.stockBind }));
vi.mock('../claimCreditNoteVersionService', async importOriginal => ({ ...await importOriginal<any>(),
  getClaimCreditNote: doubles.services.creditNote, getCreditNoteVersions: doubles.services.versions, issueClaimCreditNoteVersion: doubles.services.issue }));
import { createClaimRouter } from '../claimRoute';

function host() {
  const prisma: any = {
    claimCase: { findUnique: vi.fn(async () => ({ id: 'CASE', caseNumber: 'CLM-error', problemDesc: 'Synthetic issue',
      reportedAt: '2026-10-01', reportedBy: doubles.actor.userId, createdAt: 1n, deletedAt: null })) },
    auditLog: { create: vi.fn(async ({ data }: any) => data) },
  };
  prisma.$transaction = vi.fn(async (work: any) => work(prisma));
  const app = express(); app.use(express.json());
  app.set('json replacer', (_key: string, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
  app.use('/api/v1', createClaimRouter({ prisma, requireAuth: true }));
  return { app, prisma };
}
const unknownExits = [
  { method: 'post', path: '/claims/CASE/dispositions', mock: 'approval', code: 'APPROVAL_CREATE_FAILED', message: '添加处置失败，处置与审批均未提交' },
  { method: 'post', path: '/claims/dispositions/D/resubmit-approval', mock: 'resubmit', code: 'INTERNAL_ERROR', message: '重新送审失败，未确认新增续办；请刷新核对原处置并使用相同请求标识重试' },
  { method: 'post', path: '/return-receipt-lines/L/receive', mock: 'receive', code: 'INTERNAL_ERROR', message: '实际收货未确认提交，请刷新核对并使用相同请求标识重试' },
  { method: 'post', path: '/return-receipt-lines/L/scrap', mock: 'scrap', code: 'INTERNAL_ERROR', message: '报废未确认提交，请刷新核对并使用相同请求标识重试' },
  { method: 'get', path: '/return-receipts/R', mock: 'returnReceipt', code: 'INTERNAL_ERROR', message: '读取退货单失败' },
  { method: 'get', path: '/repair-work-orders/RW', mock: 'repairOrder', code: 'INTERNAL_ERROR', message: '读取返修工单失败' },
  { method: 'post', path: '/repair-work-orders/RW/start', mock: 'start', code: 'INTERNAL_ERROR', message: '返修进度未确认提交，请刷新核对并使用相同请求标识重试' },
  { method: 'post', path: '/repair-work-orders/RW/return-shipment', mock: 'returnShipment', code: 'INTERNAL_ERROR', message: '返还草稿未确认提交，请刷新核对并使用相同请求标识重试' },
  { method: 'get', path: '/claim-shipments/S/stock', mock: 'stockRead', code: 'INTERNAL_ERROR', message: '读取实际库存选择失败，请刷新重试' },
  { method: 'post', path: '/claim-shipments/S/stock', mock: 'stockBind', code: 'INTERNAL_ERROR', message: '实际库存选择未确认提交，请刷新核对并使用相同请求标识重试' },
  { method: 'get', path: '/claims/CASE/credit-note', mock: 'creditNote', code: 'INTERNAL_ERROR', message: '查询案件退款账户失败' },
  { method: 'get', path: '/credit-notes/CN/versions', mock: 'versions', code: 'INTERNAL_ERROR', message: '查询退款单版本失败' },
  { method: 'post', path: '/credit-notes/CN/issue', mock: 'issue', code: 'INTERNAL_ERROR', message: '发行退款单版本失败' },
] as const;
beforeEach(() => {
  doubles.currentActor.mockReset().mockResolvedValue(doubles.actor);
  doubles.sources.mockReset().mockResolvedValue({ items: [], total: 0 }); doubles.parent.mockReset().mockResolvedValue(undefined);
  for (const mock of Object.values(doubles.services)) mock.mockReset().mockResolvedValue({ ok: true, data: { id: 'output' } });
  doubles.services.addDisposition.mockResolvedValue({ ok: true, data: { disposition: { id: 'D', claimCaseId: 'CASE',
    kind: 'Allowance', amount: '10', currency: 'CNY', createdAt: 1n } } });
  doubles.services.approval.mockResolvedValue({ id: 'APPROVAL' });
});

describe('the twenty changed claim error exits keep their public contracts', () => {
  it.each(unknownExits)('$method $path unknown fault preserves safe 500, code and original public copy', async exit => {
    const f = host(), fault = Object.assign(new Error('不存在 SQL SELECT private_claim /private/path'), {
      // A wrapping approval failure retains its opaque code, not its raw cause.
      code: exit.mock === 'approval' ? 'APPROVAL_CREATE_FAILED' : 'P2022',
    });
    doubles.services[exit.mock].mockRejectedValueOnce(fault);
    const response = await (request(f.app) as any)[exit.method](`/api/v1${exit.path}`).send({ clientRequestId: 'stable-original' });
    expect(response.status).toBe(500); expect(response.body).toEqual({ error: exit.code, message: exit.message });
    expect(response.body.message).not.toMatch(/SQL|private_claim|\/private\/|不存在/);
    expect(doubles.services[exit.mock]).toHaveBeenCalledTimes(1);
    if (exit.mock === 'approval') expect(f.prisma.auditLog.create).not.toHaveBeenCalled();
  });
  it('unexpected parent/scope lookup failure is a public dependency 503, never empty success', async () => {
    const f = host(); doubles.parent.mockRejectedValueOnce(Error('SQL private parent'));
    const response = await request(f.app).get('/api/v1/claims/CASE/credit-note');
    expect(response.status).toBe(503); expect(response.body).toEqual({ error: 'DEPENDENCY_CHECK_FAILED', message: '暂时无法核验售后数据范围，请稍后重试' });
    expect(doubles.services.creditNote).not.toHaveBeenCalled();
  });
  it('unexpected candidate lookup failure preserves dependency 503 without an empty candidate list', async () => {
    const f = host(); doubles.sources.mockRejectedValueOnce(Error('SQL private source'));
    const response = await request(f.app).get('/api/v1/claims/sources/customers');
    expect(response.status).toBe(503); expect(response.body).toEqual({ error: 'DEPENDENCY_CHECK_FAILED', message: '暂时无法读取真实业务来源，请稍后重试' });
    expect(response.body.items).toBeUndefined();
  });
  it.each([
    { path: '/claims/CASE/dispositions', mock: 'approval', code: 'NO_REVIEWER_RESOLVED', message: '处置未提交：索赔须配置有效且明确的总领导，配置后重新提交' },
    { path: '/claims/dispositions/D/resubmit-approval', mock: 'resubmit', code: 'NO_REVIEWER_RESOLVED', message: '重送审未提交：须配置有效且明确的总领导后重新提交' },
    { path: '/claims/CASE/dispositions', mock: 'approval', code: 'APPROVAL_PENDING_CONTENT_CHANGED', message: '处置未提交：未决审批内容已变化，请处理原审批后重新提交' },
    { path: '/claims/dispositions/D/resubmit-approval', mock: 'resubmit', code: 'APPROVAL_PENDING_CONTENT_CHANGED', message: '重送审未提交：未决审批内容已变化' },
  ] as const)('$path $code retains approval 409 and its exact route copy', async exit => {
    const f = host(); doubles.services[exit.mock].mockRejectedValueOnce(Object.assign(Error('private approval cause'), { code: exit.code, statusCode: 409 }));
    const response = await request(f.app).post(`/api/v1${exit.path}`).send({ clientRequestId: 'stable-original' });
    expect(response.status).toBe(409); expect(response.body).toEqual({ error: exit.code, message: exit.message });
    expect(f.prisma.auditLog.create).not.toHaveBeenCalled();
  });
  it('actual QC permission error contract retains 403, code and its original public copy', async () => {
    const f = host(); doubles.services.inspection.mockRejectedValueOnce(Object.assign(Error('private authority query'), { code: 'INSUFFICIENT_PERMISSION', statusCode: 403 }));
    const response = await request(f.app).post('/api/v1/repair-work-orders/RW/inspections').send({ clientRequestId: 'QC-original' });
    expect(response.status).toBe(403); expect(response.body).toEqual({ error: 'INSUFFICIENT_PERMISSION', message: '实际质检登记人当前没有质检写权限' });
  });
  it('the positive creation control reaches its original 201 and mandatory audit', async () => {
    const f = host(); const response = await request(f.app).post('/api/v1/claims/CASE/dispositions').send({ kind: 'Allowance', amount: '10', currency: 'CNY' });
    expect(response.status).toBe(201); expect(response.body.approvalRequestId).toBe('APPROVAL'); expect(f.prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });
  it('the positive candidate control still returns its source list', async () => {
    const f = host(); const response = await request(f.app).get('/api/v1/claims/sources/customers');
    expect(response.status).toBe(200); expect(response.body).toEqual({ items: [], total: 0 });
  });
});
