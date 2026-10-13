import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { businessError } from '../shared/errorCodes';
const calls = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('../customs/businessShipmentCi', () => ({ readBusinessShipmentCiSource: calls.read, writeBusinessShipmentCi: calls.write }));
import { createBusinessCiRouter } from './businessCiRoute';

function app(permission = true, authSource = 'user-session') {
  const server = express(); server.use(express.json());
  server.use((req: any, _res, next) => {
    req.actor = { userId: 'U1', roles: [], authorizationLoaded: true, permissions: permission ? ['customs:write'] : [] };
    req.authSource = authSource; next();
  });
  const requireWrite = (req: any, res: any, next: any) => req.authSource === 'user-session' ? next() : res.status(401).json({ error: 'UNAUTHORIZED' });
  server.use('/shipping', createBusinessCiRouter({} as any, requireWrite)); return server;
}
describe('business CI routes', () => {
  beforeEach(() => { vi.resetAllMocks(); calls.read.mockResolvedValue({ sourceFingerprint: 'fingerprint' }); calls.write.mockResolvedValue({ item: { id: 'CI1' } }); });
  it('passes exact shipment selection and authenticated actor to the source service', async () => {
    const response = await request(app()).post('/shipping/S1/business-ci/source').send({ lineIds: ['SL1'] });
    expect(response.status).toBe(200); expect(response.body.data.sourceFingerprint).toBe('fingerprint');
    expect(calls.read.mock.calls[0].slice(1, 3)).toEqual(['S1', { lineIds: ['SL1'] }]);
    expect(calls.read.mock.calls[0][3].userId).toBe('U1');
  });
  it.each(['source', 'draft', 'CI1/issue'])('protects %s with actual customs scope and JWT middleware', async path => {
    expect((await request(app(false)).post(`/shipping/S1/business-ci/${path}`).send({})).status).toBe(403);
    expect((await request(app(true, 'api-key')).post(`/shipping/S1/business-ci/${path}`).send({})).status).toBe(401);
    expect(calls.read).not.toHaveBeenCalled(); expect(calls.write).not.toHaveBeenCalled();
  });
  it('sends issue to the selected document and safely returns business conflicts', async () => {
    calls.write.mockRejectedValue(businessError('CONFLICT', '来源变化'));
    const response = await request(app()).post('/shipping/S1/business-ci/CI1/issue').send({ requestKey: 'r1' });
    expect(response.status).toBe(409); expect(response.body.error.code).toBe('CONFLICT');
    expect(calls.write.mock.calls[0].slice(4)).toEqual(['issue', 'CI1']);
  });
});
