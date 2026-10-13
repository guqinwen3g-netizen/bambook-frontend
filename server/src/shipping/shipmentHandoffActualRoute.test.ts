import { beforeEach, describe, expect, it, vi } from 'vitest';
import { businessError } from '../shared/errorCodes';
const handlers = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('./shipmentHandoffService', () => ({ readShipmentHandoffActualLoading: handlers.read,
  recordShipmentHandoffActualLoading: handlers.write, shipmentHandoffJson: (value: any) => value }));
import { createShipmentHandoffActualRouter } from './shipmentHandoffActualRoute';

function app(scopes = ['shipments:read', 'shipments:write', 'orders:read'], authSource = 'user-session') {
  const requireWrite = (req: any, res: any, next: any) => req.authSource === 'user-session' ? next() : res.status(401).json({ ok: false });
  const router = createShipmentHandoffActualRouter({} as any, requireWrite);
  return async (method: 'get' | 'post', body: any = {}) => {
    const route = (router as any).stack.find((entry: any) => entry.route?.path === '/handoffs/:handoffId/actual-loading' && entry.route.methods[method]).route;
    const response: any = { status: 200, body: undefined };
    const res: any = { status: (value: number) => { response.status = value; return res; }, json: (value: any) => { response.body = value; return res; } };
    const req: any = { actor: { userId: 'L1', roles: [], permissions: scopes, authorizationLoaded: true }, authSource,
      params: { handoffId: 'H1' }, body, ip: 'mock', method: method.toUpperCase() };
    for (const layer of route.stack) {
      let continued = false;
      await layer.handle(req, res, () => { continued = true; });
      if (!continued) break;
    }
    return response;
  };
}
beforeEach(() => { vi.resetAllMocks(); handlers.read.mockResolvedValue({ bundle: { handoff: { id: 'H1' } }, sources: [] });
  handlers.write.mockResolvedValue({ handoff: { id: 'H1', shipmentId: 'S1' } }); });
describe('handoff actual-loading route contract', () => {
  it('uses the exact handoff, authenticated actor and unchanged request body', async () => {
    expect((await app()('get')).status).toBe(200);
    const input = { expectedUpdatedAt: '9007199254740999', requestKey: 'original', allocations: [] };
    expect((await app()('post', input)).status).toBe(200);
    expect(handlers.read.mock.calls[0][0]).toMatchObject({ handoffId: 'H1', actor: { userId: 'L1' } });
    expect(handlers.write.mock.calls[0][0]).toMatchObject({ handoffId: 'H1', actor: { userId: 'L1' }, input });
  });
  it('rejects unauthenticated write channels and missing source/write scopes before service invocation', async () => {
    expect((await app(undefined, 'api-key')('post')).status).toBe(401);
    expect((await app(['orders:read'])('post')).status).toBe(403);
    expect((await app(['shipments:read'])('get')).status).toBe(403);
    expect(handlers.write).not.toHaveBeenCalled(); expect(handlers.read).not.toHaveBeenCalled();
  });
  it('returns a safe CAS conflict without substituting another handoff', async () => {
    handlers.write.mockRejectedValue(businessError('CONFLICT', '原交接已更新'));
    const response = await app()('post', { requestKey: 'original' });
    expect(response.status).toBe(409); expect(response.body.error).toMatchObject({ code: 'CONFLICT', message: '原交接已更新' });
  });
});
