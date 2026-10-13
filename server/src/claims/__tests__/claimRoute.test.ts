/**
 * claimRoute 单测 —— 口径 A7（审批接线）· B1（审批码是 UI 标签）· 权限门禁
 *
 * 承重项：
 *   · 未登录 401 / 缺 `aftersales:read|write` 403
 *   · ★ **处置提交必须创建审批单**；审批单创建失败 → **处置撤回 + 报错**（绝不允许"没审批就往下走"）
 *   · ★ `NO_REVIEWER_RESOLVED`（解析不到审批人）→ **409**（fail-closed，不是静默通过）
 *   · ★ `approve` 端点**不做 scope 强制**（口径 B1：`aftersales:approve` 只是 UI 能力标签）
 */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClaimRouter } from '../claimRoute';
import { DEFAULT_ROLE_PERMISSION_MATRIX } from '../../_shared/rolePermissionMatrix';

let mockActor: { userId: string; roles: string[]; permissions?: string[] } | null = null;
vi.mock('../../auth/middleware', () => ({ extractActorFromRequest: () => mockActor }));

/** 权限门禁：只认 mockActor.permissions */
vi.mock('../../auth/permissionGuard', () => ({
  hasScopeOnRequest: (req: any, scope: string) => {
    const perms: string[] = (req as any).actor?.permissions ?? [];
    return perms.includes(scope);
  },
}));

vi.mock('../../audit/routeAudit', () => ({ writeRouteAuditLog: vi.fn(async () => 'alog_1') }));
vi.mock('../../approvals/approvalRoutingService', () => ({ createApprovalRoutingService: () => ({ resolveReviewerByDepartment: vi.fn() }) }));

/** 审批单创建可控 */
const approvalCreate = vi.fn();
vi.mock('../../approvals/approvalCreateService', () => ({
  createApprovalCreateService: () => ({ createBusinessApproval: approvalCreate }),
}));

/** 服务层全部 mock（本套件只验路由契约） */
const addDispositionMock = vi.fn();
const createClaimCaseMock = vi.fn();
const approveDispositionMock = vi.fn();
const cancelClaimCaseMock = vi.fn();
const getClaimCaseMock = vi.fn();
const listClaimCasesMock = vi.fn();
vi.mock('../claimCaseService', async () => {
  const actual = await vi.importActual<any>('../claimCaseService');
  return {
    ...actual,
    addDisposition: async (...a: any[]) => {
      const result = await addDispositionMock(...a);
      if (result.ok) a[0]._dispositions.push(result.data.disposition);
      return result;
    },
    createClaimCase: (...a: any[]) => createClaimCaseMock(...a),
    approveDisposition: (...a: any[]) => approveDispositionMock(...a),
    cancelClaimCase: (...a: any[]) => cancelClaimCaseMock(...a),
    getClaimCase: (...a: any[]) => getClaimCaseMock(...a),
    listClaimCases: (...a: any[]) => listClaimCasesMock(...a),
  };
});
const executeDispositionMock = vi.fn();
vi.mock('../claimSettlement', () => ({ executeDisposition: (...a: any[]) => executeDispositionMock(...a) }));
const resubmitApprovalMock = vi.fn();
vi.mock('../claimReapprovalService', () => ({ resubmitClaimApproval: (...a: any[]) => resubmitApprovalMock(...a) }));
const receiveReturnMock = vi.fn();
const scrapReturnMock = vi.fn();
vi.mock('../claimReturnFulfillmentService', () => ({ receiveClaimReturn: (...a: any[]) => receiveReturnMock(...a),
  scrapClaimReturn: (...a: any[]) => scrapReturnMock(...a) }));
const startRepairMock = vi.fn(), completeRepairMock = vi.fn(), inspectRepairMock = vi.fn();
vi.mock('../claimRepairFulfillmentService', () => ({ startClaimRepair: (...a: any[]) => startRepairMock(...a),
  completeClaimRepair: (...a: any[]) => completeRepairMock(...a), recordClaimRepairInspection: (...a: any[]) => inspectRepairMock(...a) }));
const returnShipmentMock = vi.fn(), bindShipmentStockMock = vi.fn();
vi.mock('../claimShipmentFulfillmentService', () => ({ createClaimRepairReturnShipment: (...a: any[]) => returnShipmentMock(...a),
  bindClaimShipmentStock: (...a: any[]) => bindShipmentStockMock(...a) }));
vi.mock('../creditNoteService', async () => {
  const actual = await vi.importActual<any>('../creditNoteService');
  return { ...actual, listOpenCreditNotes: vi.fn(), applyCreditNote: vi.fn(), cancelCreditNote: vi.fn() };
});

const getClaimCreditNoteMock = vi.fn(), getCreditNoteVersionsMock = vi.fn(), issueCreditNoteMock = vi.fn();
vi.mock('../claimCreditNoteVersionService', async () => {
  const actual = await vi.importActual<any>('../claimCreditNoteVersionService');
  return { ...actual, getClaimCreditNote: (...a: any[]) => getClaimCreditNoteMock(...a),
    getCreditNoteVersions: (...a: any[]) => getCreditNoteVersionsMock(...a),
    issueClaimCreditNoteVersion: (...a: any[]) => issueCreditNoteMock(...a) };
});

const prisma: any = {
  _dispositions: [] as any[],
  // These are explicit current identity/parent storage seams, not L2 isolation
  // proof. Actor-specific scopes remain authoritative and all original denials
  // are preserved. The new real-PG suite verifies actual row visibility.
  userAccount: { findFirst: vi.fn(async () => ({ id: mockActor!.userId, status: 'active', deletedAt: null,
    roles: [{ roleId: mockActor!.roles.includes('finance') ? 'role-finance' : mockActor!.roles.includes('sales') ? 'role-sales' : 'role-admin',
      role: { permissions: [] } }] })) },
  userPermissionOverrides: { findMany: vi.fn(async () => (mockActor?.permissions ?? []).map(scope => ({ scope }))) },
  teamMember: { findMany: vi.fn(async () => []) }, teamDataGrant: { findMany: vi.fn(async () => []) },
  relation: { findMany: vi.fn(async () => []) }, order: { findMany: vi.fn(async () => []) }, invoice: {
    findMany: vi.fn(async () => []),
    findFirst: vi.fn(async ({where}:any) => where.id === 'INV_1' ? {id:'INV_1',type:'Receivable',deletedAt:null,ownerId:'u1',customerRelationId:null,orderId:null} : null),
  },
  claimDisposition: { update: vi.fn(async ({ data }: any) => data),
    findFirst: vi.fn(async ({ where }: any) => ({ id: where.id, claimCaseId: 'C1', deletedAt: null })),
    findMany: vi.fn(async () => [{ id: 'D1', claimCaseId: 'C1', replacementShipmentId: 'SH', deletedAt: null }]) },
  claimCase: { findUnique: vi.fn(async () => ({ id: 'C1', caseNumber: 'CLM-2026-0001', problemDesc: 'x', reportedAt: '2026-10-01', reportedBy: 'u1', createdAt: BigInt(1) })),
    findFirst: vi.fn(async () => ({ id: 'C1', reportedBy: 'u1', deletedAt: null })), findMany: vi.fn(async () => [{ id: 'C1' }]) },
  returnReceipt: { findFirst: vi.fn(async () => ({ id: 'RR', claimCaseId: 'C1', deletedAt: null })) },
  returnReceiptLine: { findUnique: vi.fn(async () => ({ id: 'LINE', returnReceiptId: 'RR', claimDispositionId: 'D1' })) },
  repairWorkOrder: { findFirst: vi.fn(async () => ({ id: 'RW', claimCaseId: 'C1', deletedAt: null })), findMany: vi.fn(async () => []) },
  creditNote: { findFirst: vi.fn(async () => ({ id: 'CN_1', claimCaseId: 'C1', deletedAt: null, customerRelationId: null })) },
  $queryRawUnsafe: vi.fn(async () => []),
  // Routing/transaction boundary evidence only, not PostgreSQL rollback proof.
  $transaction: vi.fn(async (fn: any) => {
    const before = prisma._dispositions.slice();
    try { return await fn(prisma); } catch (error) { prisma._dispositions = before; throw error; }
  }),
};

function makeApp() {
  const app = express();
  // index.ts installs the production BigInt serialization seam; this small route host
  // must also serialize the persisted timestamps introduced by complete snapshot fixtures.
  app.set('json replacer', (_key: string, value: unknown) => typeof value === 'bigint' ? Number(value) : value);
  app.use(express.json());
  app.use('/api/v1', createClaimRouter({ prisma, requireAuth: true }));
  return app;
}

const WRITER = { userId: 'u1', roles: [], permissions: ['aftersales:read', 'aftersales:write'] };

describe('claimRoute：鉴权与权限门禁', () => {
  beforeEach(() => { mockActor = null; vi.clearAllMocks(); });

  it('未登录 → 401', async () => {
    expect((await request(makeApp()).get('/api/v1/claims')).status).toBe(401);
  });

  it('缺 aftersales:read → 403', async () => {
    mockActor = { userId: 'u1', roles: [], permissions: [] };
    expect((await request(makeApp()).get('/api/v1/claims')).status).toBe(403);
  });

  it('缺 aftersales:write → 登记案件 403', async () => {
    mockActor = { userId: 'u1', roles: [], permissions: ['aftersales:read'] };
    expect((await request(makeApp()).post('/api/v1/claims').send({ problemDesc: 'x' })).status).toBe(403);
  });

  it('有 read → 列表 200', async () => {
    mockActor = { userId: 'u1', roles: [], permissions: ['aftersales:read'] };
    listClaimCasesMock.mockResolvedValue({ ok: true, data: { items: [] } });
    const res = await request(makeApp()).get('/api/v1/claims');
    expect(res.status).toBe(200);
  });
});

describe('★★ 口径 A7：处置提交必须创建审批单（fail-closed）', () => {
  beforeEach(() => { mockActor = WRITER; vi.clearAllMocks(); prisma._dispositions = []; });

  it('★ 承重：提交成功 → 返回 approvalRequestId，且审批单带正确的 targetType/targetId', async () => {
    addDispositionMock.mockResolvedValue({
      ok: true,
      data: { disposition: { id: 'D1', claimCaseId: 'C1', createdAt: BigInt(1), kind: 'Allowance', amount: 500, currency: 'USD', returnDisposition: null } },
    });
    approvalCreate.mockResolvedValue({ id: 'APR_1' });

    const res = await request(makeApp())
      .post('/api/v1/claims/C1/dispositions')
      .send({ kind: 'Allowance', amount: 500, currency: 'USD' });

    expect(res.status).toBe(201);
    expect(res.body.approvalRequestId).toBe('APR_1');
    expect(approvalCreate).toHaveBeenCalledWith(expect.objectContaining({
      requesterId: 'u1',
      actionType: 'aftersales:claim-disposition',
      targetType: 'ClaimDisposition',
      targetId: 'D1',
      client: prisma,
      payload: expect.objectContaining({ schemaVersion: 1, contentFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        content: expect.objectContaining({ disposition: expect.objectContaining({ id: 'D1', amount: '500', materialCode: null, unit: null }),
          claimCase: expect.objectContaining({ id: 'C1', reportedBy: 'u1' }) }) }),
    }));
  });

  it('★★ 承重：审批单创建失败 → **处置撤回 + 报错**（绝不"没审批就往下走"）', async () => {
    addDispositionMock.mockResolvedValue({
      ok: true,
      data: { disposition: { id: 'D1', claimCaseId: 'C1', createdAt: BigInt(1), kind: 'Allowance', amount: 500, currency: 'USD' } },
    });
    approvalCreate.mockRejectedValue(Object.assign(new Error('boom'), { code: 'APPROVAL_CREATE_FAILED' }));

    const res = await request(makeApp())
      .post('/api/v1/claims/C1/dispositions')
      .send({ kind: 'Allowance', amount: 500, currency: 'USD' });

    expect(res.status).toBe(500);
    // Atomic creation replaces historical best-effort compensation: no orphan Draft/Cancelled row.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma._dispositions).toHaveLength(0);
    expect(prisma.claimDisposition.update).not.toHaveBeenCalled();
    expect(res.body.message).not.toContain('boom');
  });

  it('★ NO_REVIEWER_RESOLVED（解析不到审批人）→ **409 fail-closed**', async () => {
    addDispositionMock.mockResolvedValue({
      ok: true,
      data: { disposition: { id: 'D1', claimCaseId: 'C1', createdAt: BigInt(1), kind: 'Allowance', amount: 500, currency: 'USD' } },
    });
    approvalCreate.mockRejectedValue(Object.assign(new Error('no reviewer'), { code: 'NO_REVIEWER_RESOLVED' }));

    const res = await request(makeApp())
      .post('/api/v1/claims/C1/dispositions')
      .send({ kind: 'Allowance', amount: 500, currency: 'USD' });
    expect(res.status).toBe(409);
    expect(prisma._dispositions).toHaveLength(0);
  });

  it('服务层拒绝（如一期不支持的 kind）→ 422', async () => {
    addDispositionMock.mockResolvedValue({ ok: false, error: { code: 'UNSUPPORTED_KIND', message: '二期' } });
    const res = await request(makeApp())
      .post('/api/v1/claims/C1/dispositions')
      .send({ kind: 'Replace' });
    expect(res.status).toBe(422);
    expect(approvalCreate).not.toHaveBeenCalled();
  });
});

describe('★ 口径 B1：approve 端点不做 scope 强制（审批码只是 UI 能力标签）', () => {
  beforeEach(() => { mockActor = null; vi.clearAllMocks(); });

  it('★ 承重：无任何 aftersales 权限也能调 approve（"谁能批"由 approvals 内核决定）', async () => {
    mockActor = { userId: 'boss', roles: [], permissions: [] };
    approveDispositionMock.mockResolvedValue({ ok: true, data: { disposition: { id: 'D1', status: 'Approved' } } });

    const res = await request(makeApp()).post('/api/v1/claims/dispositions/D1/approve').send({});
    expect(res.status).toBe(200); // 不是 403
  });

  it('未登录仍 401（B1 不等于免鉴权）', async () => {
    const res = await request(makeApp()).post('/api/v1/claims/dispositions/D1/approve').send({});
    expect(res.status).toBe(401);
  });
});

describe('★ 执行处置走收口点', () => {
  beforeEach(() => { mockActor = WRITER; vi.clearAllMocks(); });

  it('execute → 调 claimSettlement.executeDisposition，并把 warehouseId 透传', async () => {
    executeDispositionMock.mockResolvedValue({
      ok: true,
      data: { disposition: { id: 'D1' }, creditNote: { id: 'CN_1' }, returnReceipt: { id: 'RT_1' } },
    });
    const res = await request(makeApp())
      .post('/api/v1/claims/dispositions/D1/execute')
      .send({ warehouseId: 'WH_1' });
    expect(res.status).toBe(200);
    // ★ A-3 二期：选项对象多了 workStationId / sourceShipmentId / notes（各 kind 按需用）
    expect(executeDispositionMock).toHaveBeenCalledWith(prisma, 'D1', 'u1', expect.objectContaining({
      warehouseId: 'WH_1',
      workStationId: null,
      sourceShipmentId: null,
    }));
  });

  it('收口点拒绝（未审批）→ 409', async () => {
    executeDispositionMock.mockResolvedValue({ ok: false, error: { code: 'INVALID_STATE', message: '先审批' } });
    const res = await request(makeApp()).post('/api/v1/claims/dispositions/D1/execute').send({});
    expect(res.status).toBe(409);
  });
});

describe('人工续办重送审路由', () => {
  beforeEach(() => { mockActor = WRITER; vi.clearAllMocks(); });

  it('没有写权限拒绝续办，不把审批能力标签当提交权限', async () => {
    mockActor = { userId: 'u1', roles: [], permissions: ['aftersales:approve'] };
    expect((await request(makeApp()).post('/api/v1/claims/dispositions/OLD/resubmit-approval')
      .send({ reason: '补充资料', clientRequestId: 'request-1' })).status).toBe(403);
    expect(resubmitApprovalMock).not.toHaveBeenCalled();
  });

  it('原处置 ID/稳定请求/完整参数/真实调用者透传；返回新版本与审批入口', async () => {
    const body = { reason: '补充资料', clientRequestId: 'request-1', changes: { amount: '525.25' } };
    resubmitApprovalMock.mockResolvedValue({ ok: true, data: { previousDisposition: { id: 'OLD', status: 'Cancelled' },
      disposition: { id: 'NEW', status: 'Draft' }, approvalRequestId: 'NEW_APPROVAL', snapshotVersion: 1, contentFingerprint: 'HASH', businessEventId: 'EVENT' } });
    const result = await request(makeApp()).post('/api/v1/claims/dispositions/OLD/resubmit-approval').send(body);
    expect(result.status).toBe(201);
    expect(resubmitApprovalMock).toHaveBeenCalledWith(prisma, 'OLD', body, 'u1');
    expect(result.body).toMatchObject({ disposition: { id: 'NEW', status: 'Draft' }, approvalRequestId: 'NEW_APPROVAL', businessEventId: 'EVENT' });
  });

  it('已有/孤立产出冲突返回 409，未知内部错误安全 500', async () => {
    resubmitApprovalMock.mockResolvedValueOnce({ ok: false, error: { code: 'INVALID_STATE', message: '先人工核对孤立钱货' } });
    const path = '/api/v1/claims/dispositions/OLD/resubmit-approval';
    expect((await request(makeApp()).post(path).send({ reason: 'x', clientRequestId: 'ID' })).status).toBe(409);
    resubmitApprovalMock.mockRejectedValueOnce(new TypeError('private-internal-detail'));
    const result = await request(makeApp()).post(path).send({ reason: 'x', clientRequestId: 'ID' });
    expect(result.status).toBe(500);
    expect(result.body.message).not.toContain('private-internal-detail');
  });
});

describe('真实退货收货与报废路由（scope/服务seam，不代替库存验收）', () => {
  beforeEach(() => { mockActor = WRITER; vi.clearAllMocks(); });
  it.each(['receive', 'scrap'])('仅售后写权限不能%s真实库存，必须inventory:write', async action => {
    expect((await request(makeApp()).post(`/api/v1/return-receipt-lines/LINE/${action}`).send({})).status).toBe(403);
    expect(receiveReturnMock).not.toHaveBeenCalled(); expect(scrapReturnMock).not.toHaveBeenCalled();
  });
  it('后勤实收真实line/item/qty/unit/request/actor参数完整透传', async () => {
    mockActor = { userId: 'warehouse', roles: [], permissions: ['inventory:write'] };
    const body = { itemId: 'ITEM', quantity: '4.00', unit: 'PCS', clientRequestId: 'R1' };
    receiveReturnMock.mockResolvedValue({ ok: true, data: { receivedEventId: 'ACTUAL', movements: [{ type: 'Inbound' }, { type: 'Lock' }] } });
    const result = await request(makeApp()).post('/api/v1/return-receipt-lines/LINE/receive').send(body);
    expect(result.status).toBe(200); expect(result.body.receivedEventId).toBe('ACTUAL');
    expect(receiveReturnMock).toHaveBeenCalledWith(prisma, 'LINE', body, 'warehouse');
  });
  it('报废只透传实际batch/理由/request，不从前端状态推定完成', async () => {
    mockActor = { userId: 'warehouse', roles: [], permissions: ['inventory:write'] };
    const body = { receivedEventId: 'ACTUAL', reason: '批准报废执行', clientRequestId: 'S1' };
    scrapReturnMock.mockResolvedValue({ ok: false, error: { code: 'INVALID_STATE', message: '批准去向不匹配' } });
    expect((await request(makeApp()).post('/api/v1/return-receipt-lines/LINE/scrap').send(body)).status).toBe(409);
    expect(scrapReturnMock).toHaveBeenCalledWith(prisma, 'LINE', body, 'warehouse');
  });
  it('实收内部异常安全500，不泄露SQL或内部文本', async () => {
    mockActor = { userId: 'warehouse', roles: [], permissions: ['inventory:write'] };
    receiveReturnMock.mockRejectedValueOnce(new TypeError('private-stock-SQL'));
    const result = await request(makeApp()).post('/api/v1/return-receipt-lines/LINE/receive').send({});
    expect(result.status).toBe(500); expect(result.body.message).not.toContain('private-stock-SQL');
  });
});

describe('返修真实进度与QC路由（角色scope/seam，服务事实独立验证）', () => {
  beforeEach(() => { mockActor = WRITER; vi.clearAllMocks(); });
  it.each(['start', 'complete', 'inspections'])('仅售后write不允许%s车间/质检动作', async action => {
    expect((await request(makeApp()).post(`/api/v1/repair-work-orders/RW/${action}`).send({})).status).toBe(403);
    expect(startRepairMock).not.toHaveBeenCalled(); expect(completeRepairMock).not.toHaveBeenCalled(); expect(inspectRepairMock).not.toHaveBeenCalled();
  });
  it('production:write 完工完整原数量单位与稳定id透传', async () => {
    mockActor = { userId: 'worker', roles: [], permissions: ['production:write'] };
    const body = { clientRequestId: 'COMPLETE1', completedQuantity: '10', unit: 'PCS' };
    completeRepairMock.mockResolvedValue({ ok: true, data: { workOrder: { id: 'RW', status: 'Completed' }, batchFingerprint: 'BATCH' } });
    const r = await request(makeApp()).post('/api/v1/repair-work-orders/RW/complete').send(body);
    expect(r.status).toBe(200); expect(r.body.batchFingerprint).toBe('BATCH');
    expect(completeRepairMock).toHaveBeenCalledWith(prisma, 'RW', body, 'worker');
  });
  it('真实QC scope登记201；当前DB撤权拒403而非500或虚报报告成功', async () => {
    mockActor = { userId: 'qa', roles: [], permissions: ['qc:write'] };
    const body = { clientRequestId: 'QC1', inspectedQuantity: '10', passedQuantity: '10', unit: 'PCS', result: 'pass' };
    inspectRepairMock.mockResolvedValueOnce({ ok: true, data: { inspection: { id: 'QC', inspectedBy: 'qa' }, inspectionEventId: 'FACT' } });
    expect((await request(makeApp()).post('/api/v1/repair-work-orders/RW/inspections').send(body)).status).toBe(201);
    expect(inspectRepairMock).toHaveBeenCalledWith(prisma, 'RW', body, 'qa');
    inspectRepairMock.mockRejectedValueOnce(Object.assign(new Error('private-authority-query'), { code: 'INSUFFICIENT_PERMISSION' }));
    const r = await request(makeApp()).post('/api/v1/repair-work-orders/RW/inspections').send(body);
    expect(r.status).toBe(403); expect(r.body.message).not.toContain('private-authority-query');
  });
});


describe('售后真实物流接口路由合同（服务替身）', () => {
  beforeEach(() => { mockActor = null; vi.clearAllMocks(); });
  it('返还草稿需要shipments:write，库存选择需要inventory:write，不用售后写标签越权', async () => {
    mockActor = WRITER;
    expect((await request(makeApp()).post('/api/v1/repair-work-orders/RW/return-shipment').send({ clientRequestId: 'R' })).status).toBe(403);
    expect((await request(makeApp()).post('/api/v1/claim-shipments/SH/stock').send({ clientRequestId: 'S' })).status).toBe(403);
    expect(returnShipmentMock).not.toHaveBeenCalled(); expect(bindShipmentStockMock).not.toHaveBeenCalled();
  });
  it('稳定请求/版本/实际批次完整透传，实际actor取登录主体', async () => {
    mockActor = { userId: 'logistics', roles: [], permissions: ['shipments:write', 'inventory:write'] };
    returnShipmentMock.mockResolvedValue({ ok: true, data: { shipment: { id: 'SH' }, replayed: false } });
    bindShipmentStockMock.mockResolvedValue({ ok: true, data: { shipmentId: 'SH', revision: 1 } });
    const body = { clientRequestId: 'R', shippingMethod: 'Pickup' };
    expect((await request(makeApp()).post('/api/v1/repair-work-orders/RW/return-shipment').send(body)).status).toBe(201);
    expect(returnShipmentMock).toHaveBeenCalledWith(prisma, 'RW', body, 'logistics');
    const selection = { clientRequestId: 'S', expectedRevision: 0, items: [{ itemId: 'ITEM', quantity: '10', unit: 'PCS' }] };
    expect((await request(makeApp()).post('/api/v1/claim-shipments/SH/stock').send(selection)).body.revision).toBe(1);
    expect(bindShipmentStockMock).toHaveBeenCalledWith(prisma, 'SH', selection, 'logistics');
  });
});

describe('invoice reconciliation is the financial execution gate, using current default scope definitions', () => {
  beforeEach(() => { mockActor = null; vi.clearAllMocks(); });
  it('Finance default scopes reach actual apply dispatch; Sales default scopes cannot execute it', async () => {
    const permissions = (role: 'role-finance' | 'role-sales') => Object.entries(DEFAULT_ROLE_PERMISSION_MATRIX[role]).filter(([, allowed]) => allowed === true).map(([scope]) => scope);
    const { applyCreditNote } = await import('../creditNoteService');
    vi.mocked(applyCreditNote).mockResolvedValue({ ok: true, data: { creditNote: { id: 'CN_1' }, applied: '10', replayed: true } } as any);
    mockActor = { userId: 'finance', roles: ['finance'], permissions: permissions('role-finance') };
    const allowed = await request(makeApp()).post('/api/v1/credit-notes/CN_1/apply').send({ appliedAmount: '10' });
    expect(allowed.status).toBe(200); expect(applyCreditNote).toHaveBeenCalledTimes(1);
    mockActor = { userId: 'u1', roles: ['sales'], permissions: permissions('role-sales') };
    const denied = await request(makeApp()).post('/api/v1/credit-notes/CN_1/apply').send({ appliedAmount: '10' });
    expect(denied.status).toBe(403); expect(applyCreditNote).toHaveBeenCalledTimes(1);
  });
});


describe('CN 账户与准确版本路由契约（服务替身，不代表财务事实验证）', () => {
  beforeEach(() => { mockActor = WRITER; vi.clearAllMocks(); });
  it('读取案件账户使用 aftersales:read；未登录和无读取权限拒绝', async () => {
    getClaimCreditNoteMock.mockResolvedValue({ ok: true, data: { creditNote: { id: 'CN_1' }, currentVersion: { id: 'V1' }, versions: [{ id: 'V1' }] } });
    expect((await request(makeApp()).get('/api/v1/claims/C1/credit-note')).status).toBe(200);
    expect(getClaimCreditNoteMock).toHaveBeenCalledWith(prisma, 'C1');
    mockActor = null; expect((await request(makeApp()).get('/api/v1/claims/C1/credit-note')).status).toBe(401);
    mockActor = { userId: 'u1', roles: [], permissions: [] };
    expect((await request(makeApp()).get('/api/v1/claims/C1/credit-note')).status).toBe(403);
  });
  it('准确 versionId 交给版本服务；未发行或外来版本保留409业务拒绝', async () => {
    getCreditNoteVersionsMock.mockResolvedValue({ ok: true, data: { versions: [{ id: 'V1' }], printVersion: { id: 'V1' } } });
    const r = await request(makeApp()).get('/api/v1/credit-notes/CN_1/versions?versionId=V1');
    expect(r.status).toBe(200); expect(r.body.printVersion.id).toBe('V1');
    expect(getCreditNoteVersionsMock).toHaveBeenCalledWith(prisma, 'CN_1', { versionId: 'V1' });
    getCreditNoteVersionsMock.mockResolvedValue({ ok: false, error: { code: 'INVALID_STATE', message: '正式版本未发行' } });
    expect((await request(makeApp()).get('/api/v1/credit-notes/CN_1/versions?versionId=DRAFT')).status).toBe(409);
  });
  it('发行绑定真实actor与稳定请求ID/预期版本，缺写权限403', async () => {
    const body = { clientRequestId: 'ISSUE_1', expectedVersion: 2 };
    issueCreditNoteMock.mockResolvedValue({ ok: true, data: { version: { id: 'V2' }, replayed: false } });
    expect((await request(makeApp()).post('/api/v1/credit-notes/CN_1/issue').send(body)).status).toBe(200);
    expect(issueCreditNoteMock).toHaveBeenCalledWith(prisma, 'CN_1', body, 'u1');
    mockActor = { userId: 'u1', roles: [], permissions: ['aftersales:read'] };
    expect((await request(makeApp()).post('/api/v1/credit-notes/CN_1/issue').send(body)).status).toBe(403);
  });
  it('核销传稳定ID，读取重放不再补写路由审计；内部异常不回显', async () => {
    mockActor = { ...WRITER, permissions: [...WRITER.permissions, 'invoices:reconcile'] };
    const service = await import('../creditNoteService');
    vi.mocked(service.applyCreditNote).mockResolvedValue({ ok: true, data: { creditNote: { id: 'CN_1', openAmount: '0', status: 'Closed' }, applied: '500', replayed: true } });
    const audit = await import('../../audit/routeAudit');
    const body = { appliedAmount: 500, toInvoiceId: 'INV_1', clientRequestId: 'OFFSET_1' };
    const r = await request(makeApp()).post('/api/v1/credit-notes/CN_1/apply').send(body);
    expect(r.status).toBe(200);
    expect(service.applyCreditNote).toHaveBeenCalledWith(prisma, 'CN_1', { ...body, refund: false }, 'u1');
    expect(audit.writeRouteAuditLog).not.toHaveBeenCalled();
    issueCreditNoteMock.mockRejectedValue(new Error('private-database-password'));
    const failed = await request(makeApp()).post('/api/v1/credit-notes/CN_1/issue').send({ clientRequestId: 'ISSUE', expectedVersion: 1 });
    expect(failed.status).toBe(500); expect(JSON.stringify(failed.body)).not.toContain('private-database-password');
  });
});
