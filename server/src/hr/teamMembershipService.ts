import { randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import { OrganizationError } from './organizationService';

async function activeTeam(db: any, teamId: string) {
  const team = await db.team.findUnique({ where: { id: teamId }, include: { department: true } });
  if (!team || team.deletedAt != null || team.status !== 'active' || !team.department?.parentId || team.department.status !== 'active')
    throw new OrganizationError('请选择有效部门下的小组。');
  return team;
}
function realAccount(user: any) {
  return user && user.status === 'active' && user.deletedAt == null && !!user.passwordHash
    && !user.metadata?.personnelOnly && !user.metadata?.erased;
}
export async function listTeamMemberCandidates(prisma: PrismaClient, teamId: string) {
  const team = await activeTeam(prisma, teamId);
  const [users, assigned] = await Promise.all([
    prisma.userAccount.findMany({ where: { primaryDeptId: team.departmentId, status: 'active', deletedAt: null }, orderBy: { displayName: 'asc' } }),
    prisma.teamMember.findMany({ where: { leftAt: null, team: { deletedAt: null, status: 'active' } }, select: { userId: true } }),
  ]);
  const assignedIds = new Set(assigned.map(row => row.userId));
  return users.filter(user => realAccount(user) && !assignedIds.has(user.id)).map(user => ({ id: user.id, displayName: user.displayName, email: user.email }));
}
export async function addExistingTeamMember(prisma: PrismaClient, teamId: string, userId: unknown,
  audit?: (tx: Prisma.TransactionClient, member: any) => Promise<void>) {
  if (typeof userId !== 'string' || !userId) throw new OrganizationError('请选择已有用户。');
  return prisma.$transaction(async tx => {
    // Serializes two simultaneous assignments of the same account to different groups.
    await tx.$queryRaw`SELECT id FROM "UserAccount" WHERE id = ${userId} FOR UPDATE`;
    const team = await activeTeam(tx, teamId);
    const user = await tx.userAccount.findUnique({ where: { id: userId } });
    if (!realAccount(user)) throw new OrganizationError('只能添加已启用且具有登录账号的用户。');
    if (user!.primaryDeptId !== team.departmentId) throw new OrganizationError('用户所属部门与小组不一致，请先在管理后台调整所属部门。', 409);
    const memberships = await tx.teamMember.findMany({ where: { userId, leftAt: null, team: { deletedAt: null, status: 'active' } } });
    if (memberships.some(row => row.teamId !== teamId)) throw new OrganizationError('该用户已分配小组，请先移出原小组。', 409);
    const existing = memberships.find(row => row.teamId === teamId);
    if (existing) return existing;
    const member = await tx.teamMember.upsert({ where: { teamId_userId: { teamId, userId } },
      create: { id: randomUUID(), teamId, userId, role: 'member' }, update: { leftAt: null, joinedAt: new Date(), role: 'member' } });
    if (audit) await audit(tx, member);
    return member;
  });
}
