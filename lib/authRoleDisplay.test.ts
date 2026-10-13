import { expect, it } from 'vitest';
import { displayAuthRoles } from './authRoleDisplay';

for (const [id, name] of [
  ['role-sales', '业务员'], ['role-sales-manager', '销售主管'], ['role-finance', '财务'],
  ['role-admin', '领导'], ['role-qc', 'QC'], ['role-logistics', '后勤'], ['role-super-admin', '老板'],
]) it(`displays existing builtin metadata for ${id}`, () => {
  expect(displayAuthRoles({ roleIds: [id], roles: ['viewer'] })).toBe(name);
});
it('prefers the actual current database name for builtin and custom roles', () => {
  expect(displayAuthRoles({ roles: ['viewer'], roleIds: ['role-qc', 'custom-quality'], roleLabels: [{ id: 'role-qc', name: '本公司质检' }, { id: 'custom-quality', name: '品质复核负责人' }] })).toBe('本公司质检, 品质复核负责人');
});
it('deduplicates actual canonical ids without projecting owner plus admin twice', () => {
  expect(displayAuthRoles({ roles: ['owner', 'admin'], roleIds: ['role-super-admin', 'role-super-admin', 'role-qc'] })).toBe('老板, QC');
});
it('explicit empty current roles cannot fall back to claimed legacy owner or unrelated labels', () => {
  expect(displayAuthRoles({ roles: ['owner'], roleIds: [], roleLabels: [{ id: 'role-super-admin', name: 'Boss' }] })).toBe('未分配角色');
});
it('preserves the existing absent-canonical legacy display without guessing QC', () => {
  expect(displayAuthRoles({ roles: ['viewer'] })).toBe('viewer'); expect(displayAuthRoles({ roles: [] })).toBe('-');
});
it('unknown canonical ids and invalid names remain explicit rather than borrowing other roles', () => {
  expect(displayAuthRoles({ roles: ['owner'], roleIds: ['unregistered', '__proto__'], roleLabels: [{ id: 'role-super-admin', name: 'Boss' }, { id: 'unregistered', name: ' ' }] })).toBe('unregistered（名称待核对）, __proto__（名称待核对）');
});
it('does not mutate role identity labels or permissions and treats malformed canonical ids as unassigned', () => {
  const user: any = { roles: ['owner'], roleIds: ['role-qc'], roleLabels: [{ id: 'role-qc', name: ' QC ' }], permissions: ['qc:write'], permissionCeiling: [] };
  const before = structuredClone(user); expect(displayAuthRoles(user)).toBe('QC'); expect(user).toEqual(before);
  expect(displayAuthRoles({ roles: ['owner'], roleIds: [null, 42, ''] } as any)).toBe('未分配角色');
});
