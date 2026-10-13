import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { beforeEach, expect, it } from 'vitest';
import { createAuthRouter } from '../route';
import { createAuthService } from '../service';
import { buildAuthTokenPayload, serializeAuthUser } from '../tokenHelpers';

let own: any;
let other: any;
let updates: unknown[];
const scopes = ['qc:read', 'qc:write'];
const assigned = (id: string, name: string) => ({ roleId: id, departmentId: 'company', role: { name, permissions: scopes.map(scope => ({ permission: { scope } })) } });
function storage() {
  const rows = new Map([[own.id, own], [other.id, other]]);
  return {
    userAccount: {
      findUnique: async ({ where }: any) => structuredClone(rows.get(where.id) || null),
      update: async ({ where, data }: any) => { const row = rows.get(where.id); if (!row) throw new Error('missing own user'); updates.push(structuredClone(data)); Object.assign(row, data); return structuredClone(row); },
    },
    userPermissionOverrides: { findMany: async ({ where }: any) => { if (!rows.has(where.userId) || where.isActive !== true || where.deletedAt !== null) throw new Error('unexpected current override query'); return []; } },
    auditLog: { create: async ({ data }: any) => ({ ...data }) },
  };
}
function app() { const a = express(); a.use(cookieParser()); a.use(express.json()); a.use('/auth', createAuthRouter({ prisma: storage() as any, loginRateLimit: false, requireEmailVerification: false })); return a; }
function token() { return createAuthService().signToken({ userId: own.id, displayName: own.displayName, roles: ['owner'], roleIds: ['role-super-admin'], permissions: ['*'], departmentIds: ['company'], permissionCeiling: [], roleLabels: [{ id: 'role-super-admin', name: 'Forged Boss' }] } as any); }
beforeEach(() => {
  own = { id: 'own-profile', displayName: 'Own QC', email: 'own@acceptance.invalid', status: 'active', deletedAt: null, primaryDeptId: 'company', primaryDepartment: { name: 'Company' }, roles: [assigned('role-qc', '质检专员'), assigned('custom-review', '品质复核')] };
  other = { id: 'other-profile', displayName: 'Other', status: 'active', deletedAt: null, roles: [assigned('role-super-admin', 'Other Secret Boss')] };
  updates = [];
});
it('serializes names only from the loaded assigned role tree without changing authorization', () => {
  own.roles.push(assigned('role-qc', 'Duplicate QC'), assigned('not-current', 'Unassigned Extra'));
  const permissions = [...scopes]; const ceiling: string[] = [];
  const dto = serializeAuthUser(own, ['viewer'], permissions, ['company'], { newRoleIds: ['role-qc', 'custom-review', 'role-qc'], permissionCeiling: ceiling });
  expect((dto as any).roleLabels).toEqual([{ id: 'role-qc', name: '质检专员' }, { id: 'custom-review', name: '品质复核' }]);
  expect(dto.roles).toEqual(['viewer']); expect(dto.roleIds).toEqual(['role-qc', 'custom-review', 'role-qc']); expect(dto.permissions).toBe(permissions); expect(dto.permissionCeiling).toEqual([]);
});
it('keeps role labels out of JWT payload and keeps QC legacy viewer mapping', () => {
  const payload = buildAuthTokenPayload(own);
  expect(payload.roles).toEqual(['viewer']); expect(payload.roleIds).toEqual(['role-qc', 'custom-review']); expect(payload.permissions).toEqual(scopes);
  expect(Object.hasOwn(payload, 'roleLabels')).toBe(false);
  expect((serializeAuthUser(own, payload.roles, payload.permissions!, payload.departmentIds!, { newRoleIds: payload.roleIds }) as any).roleLabels).toHaveLength(2);
});
it('actual me projects own current names and ignores signed claimed role labels', async () => {
  const res = await request(app()).get('/auth/me').set('Authorization', `Bearer ${token()}`);
  expect(res.status).toBe(200); expect(res.body.user.id).toBe(own.id);
  expect(res.body.user.roleLabels).toEqual([{ id: 'role-qc', name: '质检专员' }, { id: 'custom-review', name: '品质复核' }]);
  expect(res.body.user.roles).toEqual(['viewer']); expect(res.body.user.roleIds).toEqual(['role-qc', 'custom-review']); expect(res.body.user.permissions).toEqual(scopes); expect(res.body.user.permissionCeiling).toEqual([]);
  expect(JSON.stringify(res.body.user)).not.toContain('Other Secret Boss'); expect(JSON.stringify(res.body.user)).not.toContain('Forged Boss');
});
it('actual profile patch cannot forge role names or another account identity', async () => {
  const res = await request(app()).patch('/auth/me').set('Authorization', `Bearer ${token()}`).send({ displayName: 'Changed Own', userId: other.id, roleLabels: [{ id: 'role-super-admin', name: 'Forged Boss' }], roleIds: ['role-super-admin'], permissions: ['*'] });
  expect(res.status).toBe(200); expect(updates).toEqual([{ displayName: 'Changed Own' }]); expect(other.displayName).toBe('Other');
  expect(res.body.user.roleLabels).toEqual([{ id: 'role-qc', name: '质检专员' }, { id: 'custom-review', name: '品质复核' }]);
  expect(res.body.user.id).toBe(own.id); expect(res.body.user.permissions).toEqual(scopes); expect(res.body.user.permissionCeiling).toEqual([]);
});
it('actual me rereads renamed and withdrawn roles instead of stale token names', async () => {
  const original = token(); own.roles = [assigned('custom-review', '当前复核岗位')];
  const res = await request(app()).get('/auth/me').set('Authorization', `Bearer ${original}`);
  expect(res.status).toBe(200); expect(res.body.user.roleIds).toEqual(['custom-review']); expect(res.body.user.roles).toEqual([]);
  expect(res.body.user.roleLabels).toEqual([{ id: 'custom-review', name: '当前复核岗位' }]); expect(res.body.user.permissionCeiling).toEqual([]);
});
