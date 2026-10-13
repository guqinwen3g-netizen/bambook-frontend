import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { businessError } from '../../shared/errorCodes';
import { createOrderChangeRouter } from '../orderChangeRoute';

const mocks = vi.hoisted(() => ({
  actor: null as any,
  signedActor: { userId: 'u_sales', roles: ['sales'], permissions: ['order:change_request:create'] } as any,
  preview: vi.fn(),
}));

vi.mock('../../auth/middleware', () => ({
  extractActorFromRequest: () => mocks.actor,
}));
vi.mock('../quantityPlanCredential', () => ({
  signedQuantityPlanActor: () => mocks.signedActor,
}));
vi.mock('../orderQuantityPlanPreviewService', () => ({
  createOrderQuantityPlanPreviewService: () => ({ preview: mocks.preview }),
}));
vi.mock('../../approvals/approvalRoutingService', () => ({
  createApprovalRoutingService: () => ({}),
}));
vi.mock('../../approvals/approvalCreateService', () => ({
  createApprovalCreateService: () => ({}),
}));
vi.mock('../orderChangeRequestService', () => ({
  ORDER_CHANGE_TYPES: ['quantity', 'price', 'delivery', 'customer', 'product', 'cancel', 'pause'],
  createOrderChangeRequestService: () => ({}),
}));

function app() {
  const server = express();
  server.use(express.json());
  server.use('/api/v1/order-changes', createOrderChangeRouter({ prisma: {} as any, requireAuth: true }));
  return server;
}

describe('POST /api/v1/order-changes/quantity-preview', () => {
  beforeEach(() => {
    mocks.actor = { userId: 'u_sales', roles: ['sales'], permissions: ['order:change_request:create'] };
    mocks.signedActor = { userId: 'u_sales', roles: ['sales'], permissions: ['order:change_request:create'] };
    mocks.preview.mockReset();
  });

  it('requires login and create scope before invoking the preview', async () => {
    mocks.actor = null;
    const noLogin = await request(app()).post('/api/v1/order-changes/quantity-preview').send({ lineQuantityPlan: {} });
    expect(noLogin.status).toBe(401);

    mocks.actor = { userId: 'u_finance', roles: ['finance'], permissions: [] };
    const noScope = await request(app()).post('/api/v1/order-changes/quantity-preview').send({ lineQuantityPlan: {} });
    expect(noScope.status).toBe(403);
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it('passes the exact line plan and signed actor, and labels the response advisory', async () => {
    const lineQuantityPlan = { version: 2, orderId: 'O1', expectedUpdatedAt: '100', lines: [] };
    const result = { orderId: 'O1', expectedUpdatedAt: '100', advisory: true, moq: { lines: [] } };
    mocks.preview.mockResolvedValueOnce(result);
    const response = await request(app()).post('/api/v1/order-changes/quantity-preview').send({ lineQuantityPlan });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, result });
    expect(mocks.preview).toHaveBeenCalledWith(mocks.signedActor, lineQuantityPlan);
  });

  it('preserves fail-closed business errors from the actual-line validator', async () => {
    mocks.preview.mockRejectedValueOnce(businessError('CONFLICT', '订单版本已变化'));
    const response = await request(app()).post('/api/v1/order-changes/quantity-preview').send({ lineQuantityPlan: {} });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('CONFLICT');
  });
});
