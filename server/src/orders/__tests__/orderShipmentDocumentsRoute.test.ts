import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ list: vi.fn(), sent: vi.fn() }));
vi.mock('../../auth/permissionGuard', () => ({ requirePermission: vi.fn(() => (_req: any, _res: any, next: any) => next()) }));
vi.mock('../orderShipmentDocumentsService', () => ({
  listOrderShipmentDocuments: mocks.list,
  recordOrderShipmentDocumentSent: mocks.sent,
}));

import { mountOrderShipmentDocumentsRoutes } from '../orderShipmentDocumentsRoute';

function setup() {
  const routes = new Map<string, { middlewares: any[]; handler: any }>();
  const router: any = {
    get: vi.fn((path: string, ...stack: any[]) => routes.set(`GET ${path}`, { middlewares: stack.slice(0, -1), handler: stack.at(-1) })),
    post: vi.fn((path: string, ...stack: any[]) => routes.set(`POST ${path}`, { middlewares: stack.slice(0, -1), handler: stack.at(-1) })),
  };
  const requireWrite = vi.fn((_req: any, _res: any, next: any) => next());
  mountOrderShipmentDocumentsRoutes(router, { prisma: {} as any, requireWrite });
  return { routes, router, requireWrite };
}

function response() {
  const value: any = { statusCode: 200, body: undefined };
  value.status = vi.fn((code: number) => { value.statusCode = code; return value; });
  value.json = vi.fn((body: unknown) => { value.body = body; return value; });
  return value;
}

describe('order shipment documents HTTP handlers', () => {
  beforeEach(() => { mocks.list.mockReset(); mocks.sent.mockReset(); });

  it('mounts the source-order read path with read scopes and returns the logistics document state', async () => {
    const { routes } = setup();
    const route = routes.get('GET /:id/shipment-documents')!;
    expect(route.middlewares).toHaveLength(3);
    mocks.list.mockResolvedValue({ orderId: 'ORDER_1', documents: [] });
    const res = response();
    await route.handler({ params: { id: 'ORDER_1' }, actor: { userId: 'BUSINESS_USER' } }, res);
    expect(mocks.list).toHaveBeenCalledWith({}, 'ORDER_1', { userId: 'BUSINESS_USER' });
    expect(res.body).toEqual({ ok: true, orderId: 'ORDER_1', documents: [] });
  });

  it('returns 201 for a new offline-send receipt and 200 for an idempotent replay', async () => {
    const { routes, requireWrite } = setup();
    const route = routes.get('POST /:id/shipment-documents/sent')!;
    expect(route.middlewares[0]).toBe(requireWrite);
    expect(route.middlewares).toHaveLength(4);
    const req = { params: { id: 'ORDER_1' }, actor: { userId: 'BUSINESS_USER' }, body: { requestKey: 'key-1' } };
    mocks.sent.mockResolvedValueOnce({ event: { eventId: 'EV1' }, replayed: false })
      .mockResolvedValueOnce({ event: { eventId: 'EV1' }, replayed: true });
    const first = response();
    await route.handler(req, first);
    expect(mocks.sent).toHaveBeenNthCalledWith(1, {}, 'ORDER_1', req.actor, req.body);
    expect(first.statusCode).toBe(201);
    expect(first.body).toEqual({ ok: true, event: { eventId: 'EV1' }, replayed: false });
    const replay = response();
    await route.handler(req, replay);
    expect(replay.statusCode).toBe(200);
  });
});
