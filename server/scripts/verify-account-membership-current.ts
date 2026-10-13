import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { addExistingTeamMember, listTeamMemberCandidates } from '../src/hr/teamMembershipService';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { createPermissionService } from '../src/auth/permissionService';
import { assertActorBusinessTeam } from '../src/orders/internalOrderFacts';
const prisma = new PrismaClient();
const marker = `verify-${randomUUID()}`;
let checks = 0;
async function main() {
 try {
  await prisma.$transaction(async tx => {
   const company = await tx.department.findFirst({ where: { parentId: null, status: 'active' } }); assert(company);
   const department = await tx.department.create({ data: { id: `${marker}-dept`, name: marker, parentId: company.id, metadata: { businessAttributes: ['fabric_business'] } } });
   const team = await tx.team.create({ data: { id: `${marker}-team`, name: marker, departmentId: department.id } });
   const other = await tx.team.create({ data: { id: `${marker}-other`, name: marker, departmentId: department.id } });
   const user = await tx.userAccount.create({ data: { id: `${marker}-user`, displayName: marker, primaryDeptId: department.id, passwordHash: 'test-only-not-a-real-credential', status: 'active' } });
   const role = await tx.role.findUnique({ where: { id: 'role-sales' } }); assert(role);
   await tx.userRole.create({ data: { id: `${marker}-role`, userId: user.id, roleId: role.id } });
   const db = new Proxy(tx, { get(target, key) { if (key === '$transaction') return (fn: any) => fn(tx); return Reflect.get(target, key); } }) as any;
   assert((await listTeamMemberCandidates(db, team.id)).some(row => row.id === user.id)); checks++;
   const before = await tx.userAccount.count();
   await addExistingTeamMember(db, team.id, user.id);
   assert.equal(await tx.userAccount.count(), before); checks++;
   assert(!(await listTeamMemberCandidates(db, other.id)).some(row => row.id === user.id)); checks++;
   await assert.rejects(addExistingTeamMember(db, other.id, user.id), /已分配小组/); checks++;
   assert.equal((await addExistingTeamMember(db, team.id, user.id)).userId, user.id); checks++;
   let actor = await buildLoadedAuthTokenPayload(db, await loadUserWithRoles(db, user.id));
   assert(actor.permissions.includes('orders:write')); assert(!actor.permissions.includes('qc:inspect')); checks++;
   await assertActorBusinessTeam(db, actor, 'fabric'); await assert.rejects(assertActorBusinessTeam(db, actor, 'garment')); checks++;
   await tx.department.update({ where: { id: department.id }, data: { name: 'renamed', metadata: { businessAttributes: ['garment_business'] } } });
   actor = await buildLoadedAuthTokenPayload(db, await loadUserWithRoles(db, user.id));
   await assertActorBusinessTeam(db, actor, 'garment'); await assert.rejects(assertActorBusinessTeam(db, actor, 'fabric')); checks++;
   const context = await createPermissionService({ prisma: db }).getUserPermissionContext(user.id);
   assert.deepEqual(context?.scopes, actor.permissions); checks++;
   await tx.teamMember.updateMany({ where: { userId: user.id }, data: { leftAt: new Date() } });
   assert((await listTeamMemberCandidates(db, other.id)).some(row => row.id === user.id));
   await addExistingTeamMember(db, other.id, user.id); checks++;
   throw new Error('EXPECTED_ROLLBACK');
  }, { timeout: 30000 });
 } catch (error) { if ((error as Error).message !== 'EXPECTED_ROLLBACK') throw error; }
 assert.equal(await prisma.userAccount.count({ where: { id: { startsWith: marker } } }), 0); checks++;
 console.log(JSON.stringify({ checks, transaction: 'rolled_back', identityMembershipDepartmentAuthorization: 'passed' }));
}
main().finally(() => prisma.$disconnect());
