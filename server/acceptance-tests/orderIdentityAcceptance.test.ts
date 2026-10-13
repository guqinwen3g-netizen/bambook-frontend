import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrdersRouter } from '../src/orders/route';
import { createOrdersV2Router } from '../src/orders/routeV2';
import { createOrderLinesRouter } from '../src/orders/orderLinesRoute';
import { createApprovalRouter } from '../src/approvals/approvalRoute';
import { createOrderMainApprovalService } from '../src/orders/orderMainApprovalService';
import { createGlobalBusinessHttpFixture, requireHttpSuccess, type GlobalBusinessHttpFixture } from './globalBusinessFixtures';
import { assertIsolatedAcceptanceDatabase } from './isolatedDatabase';

const prisma = new PrismaClient();
let fixture: GlobalBusinessHttpFixture;
beforeAll(async () => {
  await assertIsolatedAcceptanceDatabase(prisma);
  fixture = await createGlobalBusinessHttpFixture(prisma, { prefix: `identity-${randomUUID().slice(0, 8)}`, mountAdditionalRoutes(app) {
    app.set('json replacer', (_key: string, value: unknown) => typeof value === 'bigint' ? String(value) : value);
    const options = { prisma, requireAuth: true, apiKeys: new Set<string>() };
    app.use('/api/v1/orders', createOrdersRouter(options));
    app.use('/api/v2/orders', createOrdersV2Router(options));
    app.use('/api/v1/order-lines', createOrderLinesRouter(options));
    app.use('/api/v1/approvals', createApprovalRouter({ prisma, requireAuth: true }));
  } });
  for (const businessLine of ['fabric', 'garment'] as const) await createOrderMainApprovalService(prisma).replaceAuthorityConfig({
    businessLine, userIds: [fixture.actors.manager.id], actorId: fixture.actors.superAdmin.id,
  });
}, 120_000);
afterAll(async () => { await fixture?.close(); await prisma.$disconnect(); });

async function draft(type: 'Fabric' | 'Garment', poNumber?: string, businessLine?: 'fabric' | 'garment') {
  const response = await fixture.request('salesOwner', 'post', '/api/v1/orders', {
    customer: fixture.customer.name, customerRelationId: fixture.customer.id, product: `Synthetic ${type}`,
    type, businessLine, quantity: type === 'Fabric' ? '1000' : '500', unit: type === 'Fabric' ? 'm' : 'pcs',
    dueDate: '2099-01-01', quoteAmount: '2500', poNumber, currency: 'USD', paymentInstrument: 'T/T',
    millName: fixture.factory.name, millRelationId: fixture.factory.id,
  });
  requireHttpSuccess(response, `create ${type} manual draft`);
  return response.body.order;
}
async function line(order: any, extra: Record<string, unknown> = {}) {
  const response = await fixture.request('salesOwner', 'post', '/api/v1/order-lines', {
    orderId: order.id, description: order.product, quantity: order.quantity, unit: order.unit, unitPrice: '2.5', ...extra,
  });
  requireHttpSuccess(response, 'create exact draft product line');
  expect(response.body.line.orderId).toBe(order.id);
  return response.body.line;
}

describe('native shared external PO and internal order identities', () => {
  it('creates separate fabric/garment contracts, precise product lines and independent frozen main approvals', async () => {
    const po = `${fixture.prefix}-CUSTOMER-PO`;
    const fabric = await draft('Fabric', po, 'fabric'), garment = await draft('Garment', po, 'garment');
    expect(fabric.id).not.toBe(garment.id);
    expect(fabric.code).toMatch(/^ORD-/); expect(garment.code).toMatch(/^ORD-/);
    expect(fabric.code).not.toBe(garment.code);
    expect(fabric.poNumber).toBe(po); expect(garment.poNumber).toBe(po);
    for (const [order, businessLine] of [[fabric, 'fabric'], [garment, 'garment']] as const) {
      expect(order.businessLine).toBe(businessLine);
      expect(order.ownerId).toBe(fixture.actors.salesOwner.id);
      const read = await fixture.request('salesOwner', 'get', `/api/v1/orders/${order.id}`);
      requireHttpSuccess(read, `read persisted V1 ${businessLine} business line`);
      expect(read.body.order).toMatchObject({ id: order.id, businessLine, ownerId: fixture.actors.salesOwner.id });
    }
    await line(fabric); await line(garment, { styleNo: 'ISO-STYLE', colorName: 'Black', sizeBreakdown: { S: 200, M: 300 }, fulfillmentMode: 'cmt', cmtIncludedItems: [] });
    const ambiguous = await fixture.request('salesOwner', 'get', `/api/v1/orders/${encodeURIComponent(po)}`);
    expect(ambiguous.status).toBe(409); expect(ambiguous.body.error.code).toBe('AMBIGUOUS_ORDER_REFERENCE');
    const ambiguousLine = await fixture.request('salesOwner', 'post', '/api/v1/order-lines', { poNumber: po, quantity: '1', unit: 'm' });
    expect(ambiguousLine.status).toBe(409); expect(ambiguousLine.body.error.code).toBe('AMBIGUOUS_ORDER_REFERENCE');
    const byCode = await fixture.request('salesOwner', 'get', `/api/v1/orders/${fabric.code}`);
    requireHttpSuccess(byCode, 'internal order code readback'); expect(byCode.body.order.id).toBe(fabric.id);
    const approvals = [];
    for (const order of [fabric, garment]) {
      const submitted = await fixture.request('salesOwner', 'post', `/api/v2/orders/${order.id}/submit-main-approval`, {});
      requireHttpSuccess(submitted, 'submit independent main approval', 201); approvals.push(submitted.body.item);
    }
    expect(approvals[0].id).not.toBe(approvals[1].id);
    const reviewed = await fixture.request('manager', 'get', `/api/v1/approvals/${approvals[0].id}`);
    requireHttpSuccess(reviewed, 'review fabric approval', 200, false);
    const rejected = await fixture.request('manager', 'post', `/api/v1/approvals/${approvals[0].id}/decide`, {
      status: 'rejected', rejectionReason: 'The fabric commercial details need correction', requestedChanges: 'Add the agreed special instructions', confirmedReviewedContent: true,
      reviewContentVersion: reviewed.body.item.reviewContentVersion,
    });
    requireHttpSuccess(rejected, 'return fabric draft for correction', 200, false);
    expect(rejected.body.item.id).toBe(approvals[0].id); expect(rejected.body.item.status).toBe('rejected');
    const corrected = await fixture.request('salesOwner', 'put', `/api/v1/orders/${fabric.id}`, { specialInstructions: 'Corrected the returned fabric draft' });
    requireHttpSuccess(corrected, 'edit returned fabric draft');
    const frozen = await fixture.request('salesOwner', 'put', `/api/v1/orders/${garment.id}`, { specialInstructions: 'Must remain frozen' });
    expect(frozen.status).toBe(409);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: garment.id } })).specialInstructions).toBeNull();
    const frozenBusinessLine = await fixture.request('salesOwner', 'put', `/api/v1/orders/${garment.id}`, { businessLine: 'fabric' });
    expect(frozenBusinessLine.status).toBe(409); expect(frozenBusinessLine.body.error.code).toBe('CONFLICT');
    const garmentReview = await fixture.request('manager', 'get', `/api/v1/approvals/${approvals[1].id}`);
    requireHttpSuccess(garmentReview, 'review exact garment approval after denied domain change', 200, false);
    const approved = await fixture.request('manager', 'post', `/api/v1/approvals/${approvals[1].id}/decide`, {
      status: 'approved', confirmedReviewedContent: true, reviewContentVersion: garmentReview.body.item.reviewContentVersion,
    });
    requireHttpSuccess(approved, 'approve actual garment contract', 200, false);
    expect(approved.body.item).toMatchObject({ id: approvals[1].id, status: 'approved', businessSyncStatus: 'completed' });
    const confirmedBusinessLine = await fixture.request('salesOwner', 'put', `/api/v1/orders/${garment.id}`, { businessLine: 'fabric' });
    expect(confirmedBusinessLine.status).toBe(409); expect(confirmedBusinessLine.body.error.code).toBe('CONFLICT');
    const confirmed = await fixture.request('salesOwner', 'get', `/api/v1/orders/${garment.id}`);
    requireHttpSuccess(confirmed, 'read confirmed contract after denied domain change');
    expect(confirmed.body.order).toMatchObject({ id: garment.id, status: 'Confirmed', businessLine: 'garment' });
  });

  it('keeps an omitted business line unknown, permits explicit draft completion and rejects invalid values without writes', async () => {
    const order = await draft('Fabric');
    expect(order.poNumber).toBeNull(); expect(order.code).toMatch(/^ORD-/); expect(order.businessLine).toBeNull();
    await line(order);
    const read = await fixture.request('salesOwner', 'get', `/api/v1/orders/${order.id}`);
    requireHttpSuccess(read, 'no-PO internal identity readback');
    expect(read.body.order.poNumber).toBeNull(); expect(read.body.order.lines).toHaveLength(1); expect(read.body.order.businessLine).toBeNull();
    const completed = await fixture.request('salesOwner', 'put', `/api/v1/orders/${order.id}`, { businessLine: 'fabric' });
    requireHttpSuccess(completed, 'complete unknown draft business line explicitly');
    expect(completed.body.order.businessLine).toBe('fabric');
    const current = await fixture.request('salesOwner', 'get', `/api/v1/orders/${order.id}`);
    requireHttpSuccess(current, 'read persisted explicit draft business line');
    expect(current.body.order).toMatchObject({ id: order.id, businessLine: 'fabric', status: 'Pending' });
    const before = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    const countBefore = await prisma.order.count({ where: { customerRelationId: fixture.customer.id } });
    const auditsBefore = await prisma.auditLog.count({ where: { targetType: 'Order', targetId: order.id } });
    for (const businessLine of ['textile', 'Fabric', '', null, 42, {}, ['fabric']]) {
      const invalidCreate = await fixture.request('salesOwner', 'post', '/api/v1/orders', {
        customer: fixture.customer.name, customerRelationId: fixture.customer.id, product: 'Invalid domain draft',
        type: 'Fabric', businessLine, quantity: '1000', unit: 'm',
      });
      expect(invalidCreate.status).toBe(400); expect(invalidCreate.body.error.code).toBe('INVALID_INPUT');
      const invalidPatch = await fixture.request('salesOwner', 'put', `/api/v1/orders/${order.id}`, { businessLine });
      expect(invalidPatch.status).toBe(400); expect(invalidPatch.body.error.code).toBe('INVALID_INPUT');
    }
    expect(await prisma.order.count({ where: { customerRelationId: fixture.customer.id } })).toBe(countBefore);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.businessLine).toBe('fabric'); expect(after.updatedAt).toBe(before.updatedAt); expect(after.fieldSources).toEqual(before.fieldSources);
    expect(await prisma.auditLog.count({ where: { targetType: 'Order', targetId: order.id } })).toBe(auditsBefore);
  });

  it('denies other business accounts and a disabled prior session before changing a header', async () => {
    const order = await draft('Fabric', `${fixture.prefix}-PRIVATE`);
    const outsiderSubmit = await fixture.request('salesOutsider', 'post', `/api/v1/orders/${order.id}/submit-main-approval`, {});
    expect(outsiderSubmit.status).toBe(404);
    expect(await prisma.approvalRequest.count({ where: { targetId: order.id } })).toBe(0);
    const outsider = await fixture.request('salesOutsider', 'put', `/api/v1/orders/${order.id}`, { specialInstructions: 'Other owner cannot write', businessLine: 'fabric' });
    expect(outsider.status).toBe(404);
    await prisma.userAccount.update({ where: { id: fixture.actors.salesOwner.id }, data: { status: 'disabled' } });
    const disabled = await fixture.request('salesOwner', 'put', `/api/v1/orders/${order.id}`, { specialInstructions: 'Disabled account cannot write', businessLine: 'fabric' });
    expect(disabled.status).toBe(401);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).specialInstructions).toBeNull();
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).businessLine).toBeNull();
  });
});
