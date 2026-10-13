// Actual PostgreSQL + login HTTP. Fixture setup is an acceptance precondition,
// not evidence that the admin grant UI or the complete HR workflow passed.
import { describe, expect, it, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createAuthService } from '../src/auth/service';
import { createAuthRouter } from '../src/auth/route';
import { createPermissionService } from '../src/auth/permissionService';
const prisma = new PrismaClient();
afterAll(async () => { await prisma.$disconnect(); });
describe('whole-product acceptance: active personal grants at login', () => {
  it('a valid personal grant enters both service context and login token', async () => {
    const auth = createAuthService();
    const id = 'acceptance-personal-grant';
    const password = 'AcceptanceSyntheticPassword123!';
    await prisma.userAccount.create({ data: { id, displayName: 'Acceptance granted HR', email: id + '@example.invalid', passwordHash: await auth.hashPassword(password), status: 'active' } });
    for (const scope of ['hr:salary:read', 'sensitive:salary']) await prisma.userPermissionOverrides.create({ data: { id: id + '-' + scope, userId: id, scope, grantedBy: 'acceptance-authorized-grantor', reason: 'Synthetic preauthorized HR fixture', isActive: true, expiresAt: new Date('2099-01-01') } });
    const current = await createPermissionService({ prisma }).getUserPermissionContext(id);
    expect(current?.scopes).toEqual(expect.arrayContaining(['hr:salary:read', 'sensitive:salary']));
    const app = express(); app.use(express.json());
    app.use('/api/auth', createAuthRouter({ prisma, loginRateLimit: false }));
    const login = await request(app).post('/api/auth/login').send({ email: id + '@example.invalid', password });
    expect(login.status).toBe(200);
    const payload = auth.verifyToken(login.body.token);
    expect(payload.permissions).toEqual(expect.arrayContaining(['hr:salary:read', 'sensitive:salary']));
  });
});
