import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createInternalTradeRouter } from '../internalTradeRoute';
import { encodeInternalTransferPayload, decodeInternalTransferPayload, type InternalTransferPayload } from '../internalTransferService';
import { makePrisma, makeService, decideApproval, VALID_INPUT } from './nativeInternalTransferFixture';

/**
 * DR-033 内部供料单路由契约测试：
 *   POST /            — 401 / 403 scope / 400 必填 / 201
 *   POST /:id/confirm — 403 / 409 未批准结算价 / 200
 *   POST /:id/delivery— 403 / 409 超发 / 200
 *   POST /:id/cancel  — 403 / 200
 *   GET  /            — 401 / 400 非法状态 / 200 过滤
 *   GET  /:id         — 404 / 200
 */

let mockActor: { userId: string; roles: string[]; permissions?: string[]; authorizationLoaded?: boolean; permissionCeiling?: string[] } | null = {
  userId: 'u_sales',
  roles: ['sales'],
  permissions: ['order:internal_trade:write'],
};

vi.mock('../../auth/middleware', () => ({
  extractActorFromRequest: () => mockActor,
}));

const GARMENT_ORDER = { id: 'G1', deletedAt: null, isInternalFabricTrade: false, businessLine: 'garment' };
const FABRIC_ORDER = { id: 'F1', deletedAt: null, isInternalFabricTrade: true, businessLine: 'fabric', internalCounterpartyId: 'CP-INTERNAL' };

function makePayload(overrides: Partial<InternalTransferPayload> = {}): InternalTransferPayload {
  return {
    docType: 'DR033_INTERNAL_FABRIC_SUPPLY',
    role: 'master',
    masterId: 'OIT__M1',
    mirrorId: 'OIT__R1',
    requestDepartmentId: 'dept_garment',
    supplyDepartmentId: 'dept_fabric',
    garmentOrderId: 'G1',
    fabricOrderId: 'F1',
    materialCode: 'M100',
    quantity: 1000,
    unit: 'm',
    settlementPrice: 30,
    settlementApprovalId: 'ar_1',
    dueDate: '2026-09-01',
    status: 'PendingConfirm',
    confirmedQuantity: null,
    confirmedDueDate: null,
    confirmedBy: null,
    confirmedAt: null,
    deliveries: [],
    history: [],
    ...overrides,
  };
}

async function makeApp(opts: { transfers?: any[]; approvals?: any[]; shipments?: any[]; orders?: any[]; requireAuth?: boolean } = {}) {
  // Legacy caller descriptions specify the intended state; actual native services now produce it.
  // The fixture never accepts a hand-written approved flag or confirmation as evidence.
  const ctx = makePrisma({ orders: opts.orders, shipments: opts.shipments }), { service } = makeService(ctx.prisma);
  let id: string | undefined, mirrorId: string | undefined;
  if (opts.transfers?.length) {
    const native = await service.createInternalTransfer(VALID_INPUT);
    if (!native.ok) throw Error(`mock native route create failed: ${native.error.code}`);
    id = native.data.transfer.id; mirrorId = native.data.mirror.id;
    const desired = JSON.parse(opts.transfers[0].memo).status;
    if (opts.approvals?.[0]?.status === 'approved' || desired === 'Effective') await decideApproval(ctx.prisma, native.data.approvalRequestId);
    if (desired === 'Effective') { const result = await service.confirmInternalTransfer({ id: id!, actorId: 'u_sales' }); if (!result.ok) throw Error(`mock native route confirm failed: ${result.error.code}`); }
  }
  const app = express(); app.use(express.json());
  app.use('/api/v1/internal-trade', createInternalTradeRouter({ prisma: ctx.prisma, requireAuth: opts.requireAuth ?? true }));
  return { app, ...ctx, id, mirrorId };
}

const VALID_BODY = {
  requestDepartmentId: 'dept_garment',
  supplyDepartmentId: 'dept_fabric',
  garmentOrderId: 'G1',
  fabricOrderId: 'F1',
  materialCode: 'M100',
  quantity: 1000,
  settlementPrice: 30,
  dueDate: '2026-09-01',
};

beforeEach(() => {
  mockActor = { userId: 'u_sales', roles: ['sales'], permissions: ['order:internal_trade:write'] };
});

describe('POST /api/v1/internal-trade 发起', () => {
  it.each([true, false])('requireAuth=%s retains valid native creation and rejects the empty signed action cap at the HTTP gate', async requireAuth => {
    const ctx = await makeApp({ requireAuth });
    mockActor = { userId: 'u_sales', roles: [], permissions: ['order:internal_trade:write'], authorizationLoaded: true };
    const valid = await request(ctx.app).post('/api/v1/internal-trade').send(VALID_BODY);
    expect(valid.status).toBe(201);
    const before = structuredClone({ transfers: ctx.transfers, approvals: ctx.approvals, audits: ctx.auditLogs });
    mockActor = { ...mockActor, permissionCeiling: [] };
    const denied = await request(ctx.app).post('/api/v1/internal-trade').send(VALID_BODY);
    expect(denied.status).toBe(403); expect(denied.body.error).toBe('FORBIDDEN');
    expect(denied.body.message).toBe('INSUFFICIENT_SCOPE: order:internal_trade:write');
    expect({ transfers: ctx.transfers, approvals: ctx.approvals, audits: ctx.auditLogs }).toEqual(before);
  });
  it('无 JWT → 401（fail-closed）', async () => {
    mockActor = null;
    const { app, id, mirrorId } = await makeApp();
    const res = await request(app).post('/api/v1/internal-trade').send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  it('无 scope → 403 INSUFFICIENT_SCOPE（sales 角色无 permissions 时矩阵不含该 scope）', async () => {
    mockActor = { userId: 'u_qc', roles: ['qc'] };
    const { app, id, mirrorId } = await makeApp();
    const res = await request(app).post('/api/v1/internal-trade').send(VALID_BODY);
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('FORBIDDEN');
  });

  it('必填缺失 → 400 MISSING_REQUIRED_FIELD', async () => {
    const { app, id, mirrorId } = await makeApp();
    const res = await request(app).post('/api/v1/internal-trade').send({ garmentOrderId: 'G1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MISSING_REQUIRED_FIELD');
  });

  it('成功发起 → 201 + transfer + mirror + approvalRequestId', async () => {
    const { app, id, mirrorId } = await makeApp();
    const res = await request(app).post('/api/v1/internal-trade').send(VALID_BODY);
    expect(res.status).toBe(201);
    expect(res.body.transfer).toBeTruthy();
    expect(res.body.mirror).toBeTruthy();
    expect(res.body.approvalRequestId).toBe('ar_1');
    expect(res.body.payload.status).toBe('PendingConfirm');
  });
});

describe('POST /api/v1/internal-trade/:id/confirm 确认生效', () => {
  const pendingTransfer = {
    id: 'OIT__M1', orderId: 'G1', transferDirection: 'incoming', deletedAt: null,
    transferAmount: 30000, transferCurrency: 'CNY', memo: encodeInternalTransferPayload(makePayload()),
  };

  it('无 scope → 403', async () => {
    mockActor = { userId: 'u_sales', roles: ['sales'] };
    const { app, id, mirrorId } = await makeApp({ transfers: [{ ...pendingTransfer }], approvals: [{ id: 'ar_1', status: 'approved' }] });
    const res = await request(app).post(`/api/v1/internal-trade/${id}/confirm`).send({});
    expect(res.status).toBe(403);
  });

  it('结算价未批准 → 409 SETTLEMENT_PRICE_NOT_APPROVED', async () => {
    const { app, id, mirrorId } = await makeApp({ transfers: [{ ...pendingTransfer }], approvals: [{ id: 'ar_1', status: 'pending' }] });
    const res = await request(app).post(`/api/v1/internal-trade/${id}/confirm`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('SETTLEMENT_PRICE_NOT_APPROVED');
  });

  it('审批通过 → 200 Effective', async () => {
    const { app, transfers, id } = await makeApp({
      transfers: [{ ...pendingTransfer }, { ...pendingTransfer, id: 'OIT__R1', orderId: 'F1', transferDirection: 'outgoing', memo: encodeInternalTransferPayload(makePayload({ role: 'mirror' })) }],
      approvals: [{ id: 'ar_1', status: 'approved' }],
    });
    const res = await request(app).post(`/api/v1/internal-trade/${id}/confirm`).send({});
    expect(res.status).toBe(200);
    expect(res.body.payload.status).toBe('Effective');
    expect(transfers.find(t => t.id === id).recognizedBy).toBe('u_sales');
  });
});

describe('POST /api/v1/internal-trade/:id/price-revisions 原生重送审', () => {
  const pending = { id: 'legacy-description', memo: encodeInternalTransferPayload(makePayload()) };
  it('只能由实际JWT主体生成新审批；body actor/reviewer/priceRevision不赋权，原命令重放与改参拒绝', async () => {
    const ctx = await makeApp({ transfers: [pending] });
    const original = decodeInternalTransferPayload(ctx.transfers[0].memo)!;
    const command = { requestId: 'route-native-revision', expectedContentFingerprint: original.contentFingerprint, quantity: '800', settlementPrice: '25', dueDate: '2026-09-15', reason: '通过原生服务重新审批新范围', actorId: 'u_mgr', reviewerId: 'u_sales', priceRevision: 999 };
    const created = await request(ctx.app).post(`/api/v1/internal-trade/${ctx.id}/price-revisions`).send(command);
    expect(created.status).toBe(201); expect(created.body).toMatchObject({ revision: 2, previousApprovalId: 'ar_1', approvalRequestId: 'ar_2', replayed: false });
    expect(ctx.approvals[1]).toMatchObject({ requesterId: 'u_sales', reviewerId: 'u_mgr', status: 'pending', targetId: ctx.id });
    const state = structuredClone({ transfers: ctx.transfers, approvals: ctx.approvals, audits: ctx.auditLogs });
    const replay = await request(ctx.app).post(`/api/v1/internal-trade/${ctx.id}/price-revisions`).send(command);
    expect(replay.status).toBe(200); expect(replay.body).toEqual({ ...created.body, replayed: true });
    const changed = await request(ctx.app).post(`/api/v1/internal-trade/${ctx.id}/price-revisions`).send({ ...command, quantity: 700 });
    expect(changed.status).toBe(409); expect(changed.body.error).toBe('REQUEST_CONFLICT'); expect({ transfers: ctx.transfers, approvals: ctx.approvals, audits: ctx.auditLogs }).toEqual(state);
  });
  it('无scope、空/布尔/非有限数量与缺stable request都拒绝零写', async () => {
    const ctx = await makeApp({ transfers: [pending] }), state = structuredClone({ transfers: ctx.transfers, approvals: ctx.approvals, audits: ctx.auditLogs });
    const body = { requestId: 'invalid-revision', expectedContentFingerprint: decodeInternalTransferPayload(ctx.transfers[0].memo)!.contentFingerprint, quantity: 800, settlementPrice: 25, dueDate: '2026-09-15', reason: '新价格核对' };
    for (const patch of [{ quantity: '' }, { quantity: true }, { quantity: 'Infinity' }, { requestId: '' }]) { const invalid = await request(ctx.app).post(`/api/v1/internal-trade/${ctx.id}/price-revisions`).send({ ...body, ...patch }); expect(invalid.status).toBe(400); }
    mockActor = { userId: 'u_sales', roles: ['sales'] }; expect((await request(ctx.app).post(`/api/v1/internal-trade/${ctx.id}/price-revisions`).send(body)).status).toBe(403);
    expect({ transfers: ctx.transfers, approvals: ctx.approvals, audits: ctx.auditLogs }).toEqual(state);
  });
});

describe('POST /api/v1/internal-trade/:id/delivery 交付登记', () => {
  const effectiveTransfer = {
    id: 'OIT__M1', orderId: 'G1', transferDirection: 'incoming', deletedAt: null,
    transferAmount: 30000, transferCurrency: 'CNY',
    memo: encodeInternalTransferPayload(makePayload({ status: 'Effective', confirmedQuantity: 1000, confirmedDueDate: '2026-09-01' })),
  };
  const shipment = { id: 'SH1', shipmentNumber: 'SHP-1', orderId: 'F1', status: 'Shipped', deletedAt: null };

  it('无 scope → 403', async () => {
    mockActor = { userId: 'u_sales', roles: ['sales'] };
    const { app, id, mirrorId } = await makeApp({ transfers: [{ ...effectiveTransfer }], shipments: [shipment] });
    const res = await request(app).post(`/api/v1/internal-trade/${id}/delivery`).send({ shipmentId: 'SH1', quantity: 100 });
    expect(res.status).toBe(403);
  });

  it('超发 → 409 OVER_DELIVERY', async () => {
    const { app, id, mirrorId } = await makeApp({ transfers: [{ ...effectiveTransfer }], shipments: [shipment] });
    const res = await request(app).post(`/api/v1/internal-trade/${id}/delivery`).send({ shipmentId: 'SH1', quantity: 1001 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('OVER_DELIVERY');
  });

  it('成功登记 → 200 Delivering + delivery 明细', async () => {
    const { app, id, mirrorId } = await makeApp({
      transfers: [{ ...effectiveTransfer }, { ...effectiveTransfer, id: 'OIT__R1', orderId: 'F1', transferDirection: 'outgoing', memo: encodeInternalTransferPayload(makePayload({ role: 'mirror', status: 'Effective', confirmedQuantity: 1000 })) }],
      shipments: [shipment],
    });
    const res = await request(app)
      .post(`/api/v1/internal-trade/${id}/delivery`)
      .send({ shipmentId: 'SH1', quantity: 600, receivedQuantity: 580, deliveryDate: '2026-08-20' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Delivering');
    expect(res.body.cumulativeDelivered).toBe(600);
    expect(res.body.delivery.variance).toBe(-20);
  });
});

describe('POST /api/v1/internal-trade/:id/cancel 取消', () => {
  it('PendingConfirm → 200 Cancelled', async () => {
    const pendingTransfer = {
      id: 'OIT__M1', orderId: 'G1', transferDirection: 'incoming', deletedAt: null,
      transferAmount: 30000, memo: encodeInternalTransferPayload(makePayload()),
    };
    const mirror = { ...pendingTransfer, id: 'OIT__R1', orderId: 'F1', transferDirection: 'outgoing', memo: encodeInternalTransferPayload(makePayload({ role: 'mirror' })) };
    const { app, id, mirrorId } = await makeApp({ transfers: [pendingTransfer, mirror], approvals: [{ id: 'ar_1', status: 'pending' }] });
    const res = await request(app).post(`/api/v1/internal-trade/${id}/cancel`).send({ reason: '需求取消' });
    expect(res.status).toBe(200);
    expect(res.body.payload.status).toBe('Cancelled');
  });
});

describe('GET /api/v1/internal-trade 列表与详情', () => {
  it('无 JWT → 401', async () => {
    mockActor = null;
    const { app, id, mirrorId } = await makeApp();
    const res = await request(app).get('/api/v1/internal-trade');
    expect(res.status).toBe(401);
  });

  it('非法 status → 400', async () => {
    const { app, id, mirrorId } = await makeApp();
    const res = await request(app).get('/api/v1/internal-trade?status=Bogus');
    expect(res.status).toBe(400);
  });

  it('按状态过滤 → 200 items', async () => {
    const pendingTransfer = {
      id: 'OIT__M1', orderId: 'G1', transferDirection: 'incoming', deletedAt: null,
      ourDepartmentId: 'dept_garment', counterpartyId: 'dept_fabric',
      transferAmount: 30000, memo: encodeInternalTransferPayload(makePayload()), createdAt: new Date(),
    };
    const { app, id, mirrorId } = await makeApp({ transfers: [pendingTransfer] });
    const res = await request(app).get('/api/v1/internal-trade?status=PendingConfirm&departmentId=dept_garment');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    const res2 = await request(app).get('/api/v1/internal-trade?status=Effective');
    expect(res2.body.total).toBe(0);
  });

  it('详情不存在 → 404；存在 → 200（item + mirror + payload）', async () => {
    const pendingTransfer = {
      id: 'OIT__M1', orderId: 'G1', transferDirection: 'incoming', deletedAt: null,
      transferAmount: 30000, memo: encodeInternalTransferPayload(makePayload()),
    };
    const mirror = { ...pendingTransfer, id: 'OIT__R1', orderId: 'F1', transferDirection: 'outgoing' };
    const { app, id, mirrorId } = await makeApp({ transfers: [pendingTransfer, mirror] });
    const missing = await request(app).get('/api/v1/internal-trade/OIT__X');
    expect(missing.status).toBe(404);
    const res = await request(app).get(`/api/v1/internal-trade/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.item.id).toBe(id);
    expect(res.body.mirror.id).toBe(mirrorId);
    expect(res.body.payload.garmentOrderId).toBe('G1');
  });
});
