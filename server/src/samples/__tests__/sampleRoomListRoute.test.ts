import express from 'express';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { createSampleRouter } from '../sampleRoute';
import { authHeader } from '../../__tests__/authTestHelper';
import { storage } from './sampleRoomListFixture';
function app() { const s = storage({ cases: [{ id: 'G', type: 'garment', deletedAt: null }], items: [{ id: 'C', name: '参考面料', code: 'SC-C', cardType: 'fabric', devCaseId: 'G', createdAt: 100, quantity: 1, availableQty: 1, deletedAt: null }] }); const server = express(); server.use(express.json()); server.use('/samples', createSampleRouter({ prisma: s.db, requireAuth: false })); return { server, s }; }
it('real GET applies scope and echoes actual page/filter; fabric-reference card stays garment', async () => { const { server, s } = app(); const before = structuredClone(s.state); const r = await request(server).get('/samples/room/items?scope=garment&limit=50&offset=0&devCaseId=G').set(authHeader()); expect(r.status).toBe(200); expect(r.body).toMatchObject({ listVersion: 2, scope: 'garment', total: 1, pagination: { limit: 50, offset: 0 }, filters: { devCaseId: 'G' }, items: [{ businessContext: { status: 'resolved', businessLine: 'garment' } }] }); expect(s.state).toEqual(before); });
it.each(['scope=fabric&scope=garment', 'scope=wrong', 'limit=2.5', 'limit=-1', 'limit[]=2', 'offset=true', 'offset=9007199254740992', 'lowStock=garbage', 'devCaseId[]=G', 'sampleIds='])('raw malformed query is 400 instead of coerced broad read: %s', async query => { const { server, s } = app(); const r = await request(server).get('/samples/room/items?' + query); expect(r.status).toBe(400); expect(s.options).toEqual([]); });
it('limit zero returns count-only and legacy omitted scope remains valid', async () => { const { server } = app(); const r = await request(server).get('/samples/room/items?scope=garment&limit=0').set(authHeader()); expect(r.body).toMatchObject({ items: [], total: 1, scope: 'garment', pagination: { limit: 0, offset: 0 } }); const legacy = await request(server).get('/samples/room/items?limit=6').set(authHeader()); expect(legacy.status).toBe(200); expect(legacy.body.total).toBe(1); });
it('source query failure returns 500, not successful empty classified page', async () => { const { server, s } = app(); s.fail('developmentCase'); const r = await request(server).get('/samples/room/items?scope=garment').set(authHeader()); expect(r.status).toBe(500); expect(r.body.items).toBeUndefined(); });

it('anonymous valid custody query does not expose records even requireAuth=false', async()=>{const{server}=app();const r=await request(server).get('/samples/room/items?scope=garment');expect(r.status).toBe(401);expect(r.body.items).toBeUndefined();});

it('withdrawn actual read grant denies custody listing and leaks no items',async()=>{
  const{server,s}=app();s.state.users[0].roles[0].role.permissions=[];
  const r=await request(server).get('/samples/room/items?scope=garment').set(authHeader());expect(r.status).toBe(403);expect(r.body.items).toBeUndefined();
});
