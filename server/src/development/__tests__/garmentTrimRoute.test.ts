import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
const m = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), confirm: vi.fn(), notice: vi.fn(), material: vi.fn() }));
vi.mock('../garmentTrimService', () => ({ readGarmentTrims: m.read, saveGarmentTrimTask: m.save, confirmGarmentTrimTask: m.confirm, readGarmentTrimNotice: m.notice, saveGarmentMaterialUse: m.material }));
import { createGarmentTrimRouter } from '../garmentTrimRoute';
function app(permissions = ['products:read','products:write'], source = 'user-session', actor = true) { const a = express(); a.use(express.json()); a.use((req: any, _res, next) => { if (actor) req.actor = { userId: 'actual-user', permissions, roles: [], departmentIds: [] }; req.authSource = source; next(); }); a.use(createGarmentTrimRouter({ prisma: {} as any })); return a; }
beforeEach(() => { vi.clearAllMocks(); for (const fn of Object.values(m)) fn.mockResolvedValue({ ok: true }); });
describe('garment trim session routes', () => {
 it('requires session identity and write permission', async () => { expect((await request(app([], 'user-session', false)).get('/c/garment-trims')).status).toBe(401); expect((await request(app(undefined, 'api-key')).post('/c/garment-trim-tasks')).status).toBe(401); expect((await request(app(['products:read'])).post('/c/garment-material-uses')).status).toBe(403); expect(m.save).not.toHaveBeenCalled(); expect(m.material).not.toHaveBeenCalled(); });
 it('injects trustworthy actor and routes exact child identifiers', async () => { const body = { actorId: 'spoof', expectedRevision: 3, requestKey: 'original' }; expect((await request(app()).post('/c/garment-trim-tasks/t/confirm').send(body)).status).toBe(200); expect(m.confirm).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'actual-user' }), 'c', 't', body); expect((await request(app()).patch('/c/garment-material-uses/u').send(body)).status).toBe(200); expect(m.material).toHaveBeenCalledWith(expect.anything(), 'c', body, 'u'); });
 it('returns structured conflict and hides unexpected internals', async () => { m.save.mockRejectedValue(Object.assign(Error('记录已变化'), { code: 'DEVELOPMENT_SOURCE_CHANGED', status: 409, statusCode: 409 })); expect((await request(app()).post('/c/garment-trim-tasks').send({})).status).toBe(409); m.read.mockRejectedValue(Error('secret SQL')); const result = await request(app()).get('/c/garment-trims'); expect(result.status).toBe(500); expect(JSON.stringify(result.body)).not.toContain('secret SQL'); });
});
