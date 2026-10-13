import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as fs from 'fs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { createOrdersRouter, OrdersRouterOptions } from '../route';
import { parseOrderPdf } from '../../import/parseOrderPdf';
import { ParsedOrder } from '../../import/types';

const DIR = '/Users/qinwengu/WorkBuddy/Claw/BusinessDocu/00-Entities/Peerless/面料/BULK PO';
const FIXTURES = [
  'PO#-4500159423-0001.pdf',
  'PO#-4500158987-0001.pdf',
];

const prisma = new PrismaClient();

// JWT mock for write-op auth guard (requireRole + requireJwtForWrite).
// Signed with the same default secret as auth/service.ts.
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const ownerToken = jwt.sign({ userId: 'u1', roles: ['owner'] }, JWT_SECRET);
function auth() {
  return { Authorization: `Bearer ${ownerToken}` };
}

function makeApp(opts?: Partial<OrdersRouterOptions>) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(
    '/api/v1/orders',
    createOrdersRouter({
      prisma,
      requireAuth: false,
      apiKeys: new Set<string>(),
      ...opts,
    }),
  );
  return app;
}

async function loadParsed(): Promise<ParsedOrder[]> {
  const out: ParsedOrder[] = [];
  for (const f of FIXTURES) {
    const r = await parseOrderPdf(fs.readFileSync(`${DIR}/${f}`));
    if (!r.order) throw new Error(`fixture ${f} did not parse`);
    out.push(r.order);
  }
  return out;
}

// Test fixtures only — do NOT broad-delete by source, since real migrated
// rows (po_database.db → Postgres) also use source='pdf-import'.
const FIXTURE_PO_NUMBERS = ['4500159423', '4500158987'];
const TEST_PO_NUMBERS = [...FIXTURE_PO_NUMBERS, 'MANUAL-UI-ONLY'];

async function wipe() {
  // POST /（手工建单）会 initProductionStages 生成 10 行阶段（route.ts），
  // Order 删除后阶段成孤儿残留 dev 库（2026-09-03 审计 FAB-UI-ONLY 复现源），须一并清理
  await prisma.productionStage.deleteMany({
    where: { orderId: 'FAB-UI-ONLY' },
  });
  await prisma.orderLine.deleteMany({
    where: { order: { poNumber: { in: TEST_PO_NUMBERS } } },
  });
  await prisma.order.deleteMany({
    where: { poNumber: { in: TEST_PO_NUMBERS } },
  });
}

// Ensure the JWT-mocked actor (userId='u1') exists in UserAccount, since
// AuditLog.actorId has a FK to UserAccount.id (P2003 if missing).
async function ensureTestActor() {
  await prisma.userAccount.upsert({
    where: { id: 'u1' },
    update: {},
    create: { id: 'u1', displayName: 'Test Owner', email: 'u1@test.local' },
  });
}

describe('POST /api/v1/orders/import', () => {
  beforeAll(async () => {
    const url = process.env.DATABASE_URL ?? '';
    if (!/localhost|127\.0\.0\.1/.test(url)) {
      throw new Error('Refusing to run: DATABASE_URL is not localhost');
    }
    await ensureTestActor();
  });
  beforeEach(wipe);
  afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
  });

  it('persists parsed orders and returns hydrated rows', async () => {
    const orders = await loadParsed();
    const res = await request(makeApp())
      .post('/api/v1/orders/import')
      .set(auth())
      .send({ orders });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.created).toBe(2);
    expect(res.body.updated).toBe(0);
    expect(res.body.orders).toHaveLength(2);
    const sample = res.body.orders.find((o: any) => o.poNumber === '4500159423');
    expect(sample).toBeTruthy();
    expect(sample.lines.length).toBe(4);
    expect(sample.customerCode).toBe('peerless');
  });

  it('idempotent: same payload twice → second call reports updates, no duplicates', async () => {
    const orders = await loadParsed();
    await request(makeApp()).post('/api/v1/orders/import').set(auth()).send({ orders });

    const res = await request(makeApp())
      .post('/api/v1/orders/import')
      .set(auth())
      .send({ orders });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(0);
    expect(res.body.updated).toBe(2);

    const total = await prisma.order.count({
      where: { poNumber: { in: FIXTURE_PO_NUMBERS } },
    });
    expect(total).toBe(2);
  });

  it('400 on empty or missing orders array', async () => {
    const r1 = await request(makeApp()).post('/api/v1/orders/import').set(auth()).send({});
    expect(r1.status).toBe(400);
    expect(r1.body.error.code).toBe('NO_ORDERS');

    const r2 = await request(makeApp())
      .post('/api/v1/orders/import')
      .set(auth())
      .send({ orders: [] });
    expect(r2.status).toBe(400);
  });

  it('400 when a row is missing poNumber', async () => {
    const orders = await loadParsed();
    (orders[0] as any).poNumber = '';
    const res = await request(makeApp())
      .post('/api/v1/orders/import')
      .set(auth())
      .send({ orders });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_ORDER');
  });

  it('401 without API key when auth required', async () => {
    const res = await request(makeApp({ requireAuth: true, apiKeys: new Set(['k1']) }))
      .post('/api/v1/orders/import')
      .send({ orders: [] });
    expect(res.status).toBe(401);
  });

  it('PUT /:id ignores UI-only fields and maps contactTelephone to contactPhone', async () => {
    const orders = await loadParsed();
    await request(makeApp()).post('/api/v1/orders/import').set(auth()).send({ orders });

    const res = await request(makeApp())
      .put('/api/v1/orders/PO-4500159423')
      .set(auth())
      .send({
        customer: 'Peerless Clothing',
        contactTelephone: '+1 514 111 2222',
        factoryLat: 31.2,
        factoryLon: 121.5,
        paymentMethod: 'Legacy Text',
        lines: [{ id: 'client-only' }],
      });

    expect(res.status).toBe(200);
    expect(res.body.order.contactPhone).toBe('+1 514 111 2222');
    expect(res.body.order).not.toHaveProperty('factoryLat');
    expect(res.body.order).not.toHaveProperty('factoryLon');
  });

  it('POST / ignores UI-only fields during manual order creation', async () => {
    const res = await request(makeApp())
      .post('/api/v1/orders')
      .set(auth())
      .send({
        id: 'FAB-UI-ONLY',
        poNumber: 'MANUAL-UI-ONLY',
        customer: 'Peerless Clothing',
        millName: 'Panda Mill',
        product: 'Navy wool twill',
        quantity: 0,
        contactTelephone: '+1 514 111 2222',
        factoryLat: 31.2,
        factoryLon: 121.5,
        paymentMethod: 'Legacy Text',
        needShipmentSample: true,
        needHeaderSample: true,
        lines: [{ id: 'client-only' }],
      });

    expect(res.status).toBe(200);
    expect(res.body.order.poNumber).toBe('MANUAL-UI-ONLY');
    expect(res.body.order.contactPhone).toBe('+1 514 111 2222');
    expect(res.body.order.quantity).toBe(0);
    expect(res.body.order).not.toHaveProperty('factoryLat');
    expect(res.body.order).not.toHaveProperty('needShipmentSample');
  });
});

describe('GET /api/v1/orders', () => {
  beforeEach(wipe);
  afterAll(async () => {
    await wipe();
  });

  it('returns active orders with line items, BigInts serialised as numbers', async () => {
    const orders = await loadParsed();
    await request(makeApp()).post('/api/v1/orders/import').set(auth()).send({ orders });

    const res = await request(makeApp()).get('/api/v1/orders');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.orders)).toBe(true);
    expect(res.body.orders.length).toBeGreaterThanOrEqual(2);

    const sample = res.body.orders.find((o: any) => o.poNumber === '4500159423');
    expect(sample).toBeTruthy();
    expect(Array.isArray(sample.lines)).toBe(true);
    expect(sample.lines.length).toBe(4);
    // BigInt fields must come back as plain numbers (Express JSON can't carry BigInts).
    if (sample.updatedAt != null) expect(typeof sample.updatedAt).toBe('number');
    if (sample.importedAt != null) expect(typeof sample.importedAt).toBe('number');
  });

  it('excludes tombstoned (deletedAt != null) orders', async () => {
    const orders = await loadParsed();
    await request(makeApp()).post('/api/v1/orders/import').set(auth()).send({ orders });
    // Soft-delete one PO directly in DB.
    await prisma.order.update({
      where: { poNumber: '4500159423' },
      data: { deletedAt: BigInt(Date.now()) },
    });

    const res = await request(makeApp()).get('/api/v1/orders');
    expect(res.status).toBe(200);
    const ids = res.body.orders.map((o: any) => o.poNumber);
    expect(ids).not.toContain('4500159423');
  });
});
