import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))); });
import express from 'express';
import supertest from 'supertest';
import jwt from 'jsonwebtoken';
import { createDashboardRouter } from '../route';
const secret = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
async function fixture(requireAuth = true) {
    let reads = 0;
    const user = { id: 'me', displayName: 'Worker', status: 'active', deletedAt: null, roles: [{ roleId: 'custom-empty', role: { id: 'custom-empty', name: 'Custom', permissions: [] } }] };
    const db: any = { userAccount: { findFirst: async () => { reads++; return user; } }, userPermissionOverrides: { findMany: async () => [] }, $transaction: async (run: any) => run(db) };
    const app = express();
    app.use(express.json());
    app.use('/dashboard', createDashboardRouter({ prisma: db, requireAuth, apiKeys: new Set(['synthetic-key']) }));
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    return { app: server, user, db, reads: () => reads };
}
const token = (extra: any = {}) => jwt.sign({ userId: 'me', roles: ['owner'], permissions: ['*'], departmentIds: [], ...extra }, secret);
describe('Personal workbench actual HTTP session boundary', () => {
    it('refuses anonymous development access despite module development bypass', async () => { const f = await fixture(false); expect((await supertest(f.app).get('/dashboard/workbench')).status).toBe(401); expect(f.reads()).toBe(0); });
    it('refuses API key as a personal account', async () => { const f = await fixture(); expect((await supertest(f.app).get('/dashboard/workbench').set('X-Bambook-API-Key', 'synthetic-key')).status).toBe(401); expect(f.reads()).toBe(0); });
    it('body actor cannot turn dev or anonymous access into a user session', async () => { const f = await fixture(false); expect((await supertest(f.app).get('/dashboard/workbench').send({ actor: { userId: 'me', roles: ['owner'] } })).status).toBe(401); expect(f.reads()).toBe(0); });
    it('customer portal JWT is not a business employee identity', async () => { const f = await fixture(); expect((await supertest(f.app).get('/dashboard/workbench').set('Authorization', 'Bearer ' + token({ kind: 'customer' }))).status).toBe(401); });
    it('valid real employee session reaches actual stored permission service without cockpit gate', async () => { const f = await fixture(); const r = await supertest(f.app).get('/dashboard/workbench?group=invoices').set('Authorization', 'Bearer ' + token()); expect(r.status).toBe(200); expect(r.body.subject.userId).toBe('me'); expect(r.body.groups[0]).toMatchObject({ status: 'forbidden', total: null }); expect(f.reads()).toBeGreaterThan(0); });
    it('invalid group is refused by the real producer query validation', async () => { const f = await fixture(); const r = await supertest(f.app).get('/dashboard/workbench?group=unknown').set('Authorization', 'Bearer ' + token()); expect(r.status).toBe(400); expect(r.body.error.code).toBe('VALIDATION_FAILED'); });
    it('inactive current stored employee fails even when signed token claims owner', async () => { const f = await fixture(); f.user.status = 'disabled'; const r = await supertest(f.app).get('/dashboard/workbench').set('Authorization', 'Bearer ' + token()); expect(r.status).toBe(401); expect(r.body.error.code).toBe('ACCOUNT_DISABLED'); });
    it('current storage outage returns safe registered error without raw SQL leakage', async () => { const f = await fixture(); f.db.userAccount.findFirst = async () => { throw Error('raw SQL secret-password'); }; const r = await supertest(f.app).get('/dashboard/workbench').set('Authorization', 'Bearer ' + token()); expect(r.status).toBeGreaterThanOrEqual(500); expect(r.body.error.code).toBe('AUTHORIZATION_UNAVAILABLE'); expect(JSON.stringify(r.body)).not.toContain('secret-password'); });
});
