import { teamBusinessFamilies } from '../hr/departmentBusinessAttributes';
import { createPermissionService, hasScope } from '../auth/permissionService';
import type { TokenPayload } from '../auth/service';
import { conversionAuthorityRead, signedConversionCeiling } from './developmentConversionAuthority';

export class DevelopmentWorkError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export const businessFamily = (team: any): 'fabric' | 'garment' | null => teamBusinessFamilies(team)[0] ?? null;

export async function currentDevelopmentActor(db: any, actorId: string, write = false, trustedActor?: TokenPayload | null) {
  if (!trustedActor?.userId || trustedActor.userId !== actorId)
    throw new DevelopmentWorkError('UNAUTHORIZED', '请使用与当前凭据一致的真实员工账号。', 401);
  const ceiling = signedConversionCeiling(trustedActor);
  return conversionAuthorityRead(db, async strict => {
    const user = await strict.userAccount.findFirst({ where: { id: actorId, status: 'active', deletedAt: null },
      select: { id: true, displayName: true, status: true, deletedAt: true } });
    if (!user || user.id !== actorId || user.status !== 'active' || user.deletedAt != null)
      throw new DevelopmentWorkError('UNAUTHORIZED', '请重新登录。', 401);
    const permissions = await createPermissionService({ prisma: strict }).getUserPermissionContext(actorId);
    if (!permissions || permissions.userId !== actorId)
      throw new DevelopmentWorkError('AUTHORIZATION_UNAVAILABLE', '当前权限未能完整核对，请稍后重试。', 503);
    const credential: TokenPayload = { ...trustedActor, roles: permissions.legacyRoleCodes, roleIds: permissions.roleIds,
      permissions: permissions.scopes, departmentIds: permissions.departmentIds, authorizationLoaded: true,
      ...(ceiling === null ? {} : { permissionCeiling: ceiling }) };
    if (!hasScope(credential, write ? 'products:write' : 'products:read'))
      throw new DevelopmentWorkError('FORBIDDEN', '当前账号或凭据没有本次开发事项的权限。', 403);
    return { ...user, permissions, trustedActor: credential, isOwner: permissions.roleIds.includes('role-super-admin') };
  });
}
async function personnelForAuthorizedActor(db: any, actor: Awaited<ReturnType<typeof currentDevelopmentActor>>) {
  const actorId = actor.id;
  const rows = await db.team.findMany({ where: { deletedAt: null, status: 'active' }, include: { department: true, members: { where: { leftAt: null } } }, orderBy: { name: 'asc' } });
  const teams = rows.flatMap((team: any) => teamBusinessFamilies(team).map(family => ({ id: team.id, name: team.name, departmentId: team.departmentId, family, memberIds: team.members.map((member: any) => member.userId) })));
  const ids = [...new Set<string>(teams.flatMap((team: any) => team.memberIds))];
  const accounts = await db.userAccount.findMany({ where: { id: { in: ids }, status: 'active', deletedAt: null }, select: { id: true, displayName: true, primaryDeptId: true }, orderBy: { displayName: 'asc' } });
  const users: { id: string; displayName: string; primaryDeptId?: string | null; teams: { id: string; name: string; family: string }[] }[] = [];
  for (const user of accounts) {
    const permissions = await createPermissionService({ prisma: db }).getUserPermissionContext(user.id);
    if (!permissions?.scopes.includes('products:write')) continue;
    const memberships = teams.filter((team: any) => team.family && team.departmentId === user.primaryDeptId && team.memberIds.includes(user.id));
    if (memberships.length) users.push({ ...user, teams: memberships.map(({ id, name, family }: any) => ({ id, name, family })) });
  }
  return { users, routingTeams: rows.filter((team: any) => teamBusinessFamilies(team).includes('fabric')).map((team: any) => ({ id: team.id, name: team.name, headId: users.some((user: any) => user.id === team.leaderId && user.teams.some((membership: any) => membership.id === team.id)) ? team.leaderId : null })), requestTeams: teams.filter((team: any) => team.family && (actor.isOwner || (team.departmentId === actor.permissions.primaryDeptId && team.memberIds.includes(actorId)))).map(({ id, name, family }: any) => ({ id, name, family })) };
}
export async function listDevelopmentPersonnel(db: any, actorId: string, trustedActor?: TokenPayload | null) {
  const actor = await currentDevelopmentActor(db, actorId, false, trustedActor);
  const directory = await conversionAuthorityRead(db, strict => personnelForAuthorizedActor(strict, actor));
  await currentDevelopmentActor(db, actorId, false, trustedActor);
  return directory;
}
export async function developmentAssignee(db: any, actorId: string, assigneeId: string, family: 'fabric' | 'garment', trustedActor?: TokenPayload | null) {
  const actor = await currentDevelopmentActor(db, actorId, true, trustedActor);
  const directory = await conversionAuthorityRead(db, strict => personnelForAuthorizedActor(strict, actor));
  const user = directory.users.find(user => user.id === assigneeId && user.teams.some((team: any) => team.family === family));
  if (!user) throw new DevelopmentWorkError('INVALID_ASSIGNEE', `请选择仍在职且具有${family === 'fabric' ? '面料' : '成衣'}业务权限的真实账号。`);
  await currentDevelopmentActor(db, actorId, true, trustedActor);
  return user;
}

// Sourcing responsibility uses Team.leaderId, distinct from execution ownership.
// Eligibility remains the authorized primary-department membership contract above.
export async function fabricSearchRouting(db: any, actorId: string, input: { assigneeId?: string | null; routingTeamId?: string | null }, trustedActor?: TokenPayload | null) {
  const directory = await listDevelopmentPersonnel(db, actorId, trustedActor);
  const assignee = input.assigneeId ? await developmentAssignee(db, actorId, input.assigneeId, 'fabric', trustedActor) : null;
  const teamIds = [...new Set(directory.users.flatMap((user: any) => user.teams.filter((team: any) => team.family === 'fabric').map((team: any) => team.id)))];
  const candidates = assignee ? teamIds.filter(id => assignee.teams.some((team: any) => team.id === id)) : teamIds;
  const teamId = input.routingTeamId || (candidates.length === 1 ? candidates[0] : null);
  if (!teamId || !candidates.includes(teamId)) throw new DevelopmentWorkError('ROUTING_TEAM_REQUIRED', '请选择负责此次寻样的面料业务团队。');
  const team = await db.team.findFirst({ where: { id: teamId, status: 'active', deletedAt: null }, select: { id: true, name: true, leaderId: true } });
  const head = team?.leaderId && directory.users.find((user: any) => user.id === team.leaderId && user.teams.some((membership: any) => membership.id === teamId && membership.family === 'fabric'));
  if (!head) throw new DevelopmentWorkError('ROUTING_HEAD_MISSING', '负责此次寻样的面料团队尚未配置合资格业务负责人，请先完善团队负责人配置。');
  return { routingTeamId: team.id, responsibleHeadId: head.id, assigneeId: assignee?.id || null };
}

export async function fabricSearchEligibleTeams(db: any, actorId: string, trustedActor?: TokenPayload | null): Promise<string[]> {
  const directory = await listDevelopmentPersonnel(db, actorId, trustedActor);
  return directory.users.find((user: any) => user.id === actorId)?.teams.filter((team: any) => team.family === 'fabric').map((team: any) => team.id) || [];
}
