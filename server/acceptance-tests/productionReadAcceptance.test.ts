import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrdersRouter } from '../src/orders/route';
import { createProductionRouter } from '../src/production/route';
import { createProductionV2Router } from '../src/production/routeV2';
import { createProductionBatchRouter } from '../src/production/productionBatchRoute';
import { createOrderLinesRouter } from '../src/orders/orderLinesRoute';
import { createGlobalBusinessHttpFixture, requireHttpSuccess, type GlobalBusinessHttpFixture } from './globalBusinessFixtures';
import { assertIsolatedAcceptanceDatabase } from './isolatedDatabase';

const prisma = new PrismaClient();
let fixture: GlobalBusinessHttpFixture;
let own: any, foreign: any;
beforeAll(async () => {
  await assertIsolatedAcceptanceDatabase(prisma);
  fixture = await createGlobalBusinessHttpFixture(prisma, { prefix: `production-read-${randomUUID().slice(0, 8)}`, mountAdditionalRoutes(app) {
    app.set('json replacer', (_key: string, value: unknown) => typeof value === 'bigint' ? String(value) : value);
    const options = { prisma, requireAuth: true, apiKeys: new Set<string>() };
    app.use('/api/v1/orders', createOrdersRouter(options));
    app.use('/api/v1/production', createProductionRouter(options));
    app.use('/api/v2/production', createProductionV2Router(options));
    app.use('/api/v1/production-batches', createProductionBatchRouter(options));
    app.use('/api/v1/order-lines', createOrderLinesRouter(options));
  } });
  for (const actor of ['salesOwner', 'salesOutsider'] as const) {
    const result = requireHttpSuccess(await fixture.request(actor, 'post', '/api/v1/orders', {
      id: `${fixture.prefix}-${actor}-order`, customer: `${fixture.prefix} private ${actor}`, type: 'Fabric',
      product: 'Synthetic undecided draft', quantity: '1000', unit: 'M', dueDate: '2000-01-01',
      currency: 'USD', quoteAmount: '2500', paymentInstrument: 'T/T',
    }), 'create actual owner-scoped draft');
    if (actor === 'salesOwner') own = result.order; else foreign = result.order;
  }
}, 120_000);
afterAll(async () => { await fixture?.close(); await prisma.$disconnect(); });

describe('native production reads preserve unknown progress and current order scope', () => {
  it('keeps fresh drafts without manufactured stages or read-time business writes in both API versions', async () => {
    expect(await prisma.productionStage.count({ where: { orderId: { in: [own.id, foreign.id] } } })).toBe(0);
    const before = await prisma.auditLog.count();
    for (const api of ['v1', 'v2']) {
      const board = requireHttpSuccess(await fixture.request('salesOwner', 'get', `/api/${api}/production/board`), `${api} current-owner board`);
      const items = api === 'v1' ? board.items : board.board.items;
      expect(items.map((item: any) => item.order.id)).toContain(own.id);
      expect(items.map((item: any) => item.order.id)).not.toContain(foreign.id);
      expect(items.find((item: any) => item.order.id === own.id)).toMatchObject({ stages: [], currentStageKey: null });
      requireHttpSuccess(await fixture.request('salesOwner', 'get', `/api/${api}/production/${own.id}`), `${api} own history read`);
      const hidden = await fixture.request('salesOwner', 'get', `/api/${api}/production/${foreign.id}`);
      expect(hidden.status).toBe(404);
    }
    expect(await prisma.productionStage.count({ where: { orderId: { in: [own.id, foreign.id] } } })).toBe(0);
    expect(await prisma.auditLog.count()).toBe(before);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: own.id } })).status).toBe('Pending');
    expect(await prisma.releaseScope.count({ where: { orderId: own.id } })).toBe(0);
  });

  it('scopes dashboard, warning scan and capacity detail to the same exact current order range', async () => {
    const stats = requireHttpSuccess(await fixture.request('salesOwner', 'get', '/api/v1/production/stats/dashboard'), 'scoped production dashboard');
    expect(stats.stats.totalActive).toBe(1);
    expect(stats.stats.fullyCompleted).toBe(0);
    const scan = requireHttpSuccess(await fixture.request('salesOwner', 'get', '/api/v1/production/alerts/scan'), 'scoped production warnings');
    expect(scan.alerts.map((alert: any) => alert.orderId)).toContain(own.id);
    expect(scan.alerts.map((alert: any) => alert.orderId)).not.toContain(foreign.id);
    expect((await fixture.request('salesOwner', 'get', `/api/v1/production/${foreign.id}/capacity-coverage`)).status).toBe(404);
    const before = await prisma.productionStage.count();
    const coverage = await fixture.request('salesOwner', 'get', `/api/v1/production/${own.id}/capacity-coverage`);
    expect(coverage.status).toBe(200);
    expect(await prisma.productionStage.count()).toBe(before);
  });

  it('projects actual source uncertainty without creating production stages, and retires legacy writers in both API versions', async () => {
    const auditCount = await prisma.auditLog.count();
    const endpoints = [['post', 'advance/order_placed'], ['post', 'block/order_placed'], ['post', 'sign/order_placed'], ['put', 'checklist'], ['put', 'inspection']] as const;
    for (const api of ['v1', 'v2']) {
      const progress = requireHttpSuccess(await fixture.request('salesOwner', 'get', `/api/${api}/production/progress`), `${api} exact progress`);
      expect(progress.items.map((item: any) => item.order.id)).toEqual([own.id]);
      expect(progress.stats.fullyCompleted).toBe(0); expect(progress.stats.actualBranchCount).toBe(0);
      expect(progress.items[0].lines.every((line: any) => line.productionComplete === false)).toBe(true);
      for (const [method, suffix] of endpoints) {
        const current = await fixture.request('salesOwner', method, `/api/${api}/production/${own.id}/${suffix}`, { ownerOverride: { reason: 'bypass' }, result: 'pass', approvedByBusiness: true });
        expect(current.status).toBe(409); expect(current.body.error.code).toBe('EXACT_PRODUCTION_COMMAND_REQUIRED');
        const hidden = await fixture.request('salesOwner', method, `/api/${api}/production/${foreign.id}/${suffix}`, {});
        expect(hidden.status).toBe(404);
      }
    }
    expect(await prisma.productionStage.count({ where: { orderId: own.id } })).toBe(0);
    expect(await prisma.inspectionReport.count({ where: { orderId: own.id } })).toBe(0);
    expect(await prisma.auditLog.count()).toBe(auditCount);
  });

  it('reads the exact line completion envelope through HTTP without manufacturing completion or crossing owner scope', async () => {
    const line = requireHttpSuccess(await fixture.request('salesOwner', 'post', '/api/v1/order-lines', {
      orderId: own.id, itemNo: 'completion-read', description: 'Accurate draft line with no production facts',
      quantity: '1000', unit: 'M', unitPrice: '2.5',
    }), 'create actual draft line').line;
    const before = { completions: await prisma.productionBatchCompletion.count(), audit: await prisma.auditLog.count() };
    const url = `/api/v1/production-batches/orders/${own.id}/lines/${line.id}/completion`;
    const result = requireHttpSuccess(await fixture.request('salesOwner', 'get', url), 'read scoped native line completion');
    expect(result.productionCompletion).toMatchObject({ status: 'not_started', productionComplete: false,
      actualQty: null, expectedBranchCount: 0, completedBranchCount: 0 });
    expect((await fixture.request('salesOutsider', 'get', url)).status).toBe(404);
    expect((await fixture.request('salesOwner', 'get', `/api/v1/production-batches/orders/${own.id}/lines/not-this-order/completion`)).status).toBe(404);
    expect(await prisma.productionBatchCompletion.count()).toBe(before.completions);
    expect(await prisma.auditLog.count()).toBe(before.audit);
  });

  it('rejects a disabled account using its previously valid session before returning production data', async () => {
    await prisma.userAccount.update({ where: { id: fixture.actors.salesOwner.id }, data: { status: 'disabled' } });
    for (const api of ['v1', 'v2']) expect((await fixture.request('salesOwner', 'get', `/api/${api}/production/board`)).status).toBe(401);
    expect(await prisma.productionStage.count({ where: { orderId: own.id } })).toBe(0);
  });
});
