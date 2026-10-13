import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createImportRouter, ImportRouterOptions } from '../route';

const DIR = '/Users/qinwengu/WorkBuddy/Claw/BusinessDocu/00-Entities/Peerless/面料/BULK PO';
const PEERLESS = `${DIR}/PO#-4500159423-0001.pdf`;
const PEERLESS_SMALL = `${DIR}/PO#-4500158987-0001.pdf`;

function makeApp(opts?: Partial<ImportRouterOptions>) {
  const app = express();
  app.use(
    '/api/v1/import',
    createImportRouter({
      requireAuth: false,
      apiKeys: new Set<string>(),
      ...opts,
    }),
  );
  return app;
}

describe('POST /api/v1/import/order', () => {
  it('parses one Peerless PDF', async () => {
    const res = await request(makeApp())
      .post('/api/v1/import/order')
      .attach('files', PEERLESS);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    const r = res.body.results[0];
    expect(r.detection.customerId).toBe('peerless');
    expect(r.order.poNumber).toBe('4500159423');
    expect(r.order.lines).toHaveLength(4);
    expect(r.error).toBeNull();
  });

  it('parses multiple PDFs and reports each', async () => {
    const res = await request(makeApp())
      .post('/api/v1/import/order')
      .attach('files', PEERLESS)
      .attach('files', PEERLESS_SMALL);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    const pos = res.body.results.map((r: any) => r.order.poNumber).sort();
    expect(pos).toEqual(['4500158987', '4500159423']);
  });

  it('400 when no file is attached', async () => {
    const res = await request(makeApp()).post('/api/v1/import/order');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('NO_FILES');
  });

  // Auth middleware runs before multer; sending a file body would just race with
  // the early-reject and trigger a flaky EPIPE. The auth check itself does not
  // depend on the body, so we omit it.
  it('401 when auth required and key missing', async () => {
    const res = await request(makeApp({ requireAuth: true, apiKeys: new Set(['k1']) }))
      .post('/api/v1/import/order');
    expect(res.status).toBe(401);
  });

  it('403 when key is wrong', async () => {
    const res = await request(makeApp({ requireAuth: true, apiKeys: new Set(['k1']) }))
      .post('/api/v1/import/order')
      .set('X-Bambook-API-Key', 'wrong');
    expect(res.status).toBe(403);
  });

  it('200 when auth required and key matches', async () => {
    const res = await request(makeApp({ requireAuth: true, apiKeys: new Set(['k1']) }))
      .post('/api/v1/import/order')
      .set('X-Bambook-API-Key', 'k1')
      .attach('files', PEERLESS);
    expect(res.status).toBe(200);
    expect(res.body.results[0].order.poNumber).toBe('4500159423');
  });
});
