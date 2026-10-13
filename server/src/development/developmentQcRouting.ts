import { departmentBusinessAttributes } from '../hr/departmentBusinessAttributes';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../auth/tokenHelpers';
import { hasActualQcScope } from '../qc/qcExecutionScope';
import { authorizeDevelopmentSource } from './developmentConversionAuthority';
import { DevelopmentDomainError } from './developmentOperationalGuard';

const fail = (code: string, message: string): never => { throw new DevelopmentDomainError(code, message); };
/** QC teams use *_qc department attributes; Team.leaderId is their configured
 * responsible head. Business-team heads never stand in for professional QC. */
async function qcTeams(db: any, type: string) {
  if (!['fabric', 'garment'].includes(type)) return fail('QC_ROUTING_SOURCE_UNKNOWN', '来源业务类别未明确，不能路由专业 QC。');
  const teams = await db.team.findMany({ where: { status: 'active', deletedAt: null }, include: { department: true, members: { where: { leftAt: null } } } });
  const attribute = type === 'fabric' ? 'fabric_qc' : 'garment_qc';
  return teams.filter((team: any) => departmentBusinessAttributes(team.department).includes(attribute));
}
export async function developmentQcMember(db: any, input: { caseId: string; type: string; teamId: string; userId: string; requesterId?: string }) {
  const team = (await qcTeams(db, input.type)).find((row: any) => row.id === input.teamId);
  if (!team || !team.members.some((member: any) => member.userId === input.userId)) return null;
  const user = await loadUserWithRoles(db, input.userId);
  if (!user || user.status !== 'active' || user.deletedAt != null || user.primaryDeptId !== team.departmentId || input.requesterId === user.id) return null;
  const actor = await buildLoadedAuthTokenPayload(db, user);
  if (!hasActualQcScope(actor, 'qc:read') || !hasActualQcScope(actor, 'qc:inspect') || !hasActualQcScope(actor, input.type === 'fabric' ? 'qc:fabric_chain:write' : 'qc:garment_chain:write')) return null;
  try { await authorizeDevelopmentSource(db, user.id, actor, input.caseId, { scope: 'qc:inspect', write: false }); }
  catch (error) { if (error instanceof DevelopmentDomainError && ['FORBIDDEN', 'NOT_FOUND'].includes(error.code)) return null; throw error; }
  return { user, actor, team };
}
export async function assertDevelopmentQcMember(db: any, review: any, userId: string, type: string) {
  // Nullable legacy routing preserves existing exact-source authorization.
  if (!review.routingTeamId) return;
  const member = await developmentQcMember(db, { caseId: review.developmentCaseId, type, teamId: review.routingTeamId, userId, requesterId: review.requestedBy });
  if (!member) return fail('FORBIDDEN', '当前账号不属于本任务来源对应的合资格 QC 团队。');
}
export async function resolveDevelopmentQcRouting(db: any, input: { caseId: string; type: string; requesterId: string; routingTeamId?: string }) {
  const teams = await qcTeams(db, input.type);
  const team = input.routingTeamId ? teams.find((row: any) => row.id === input.routingTeamId) : teams.length === 1 ? teams[0] : null;
  if (!team) return fail('QC_ROUTING_TEAM_REQUIRED', teams.length ? '来源对应多个 QC 团队，请明确负责团队。' : '来源对应的专业 QC 团队尚未配置。');
  const head = team.leaderId && await developmentQcMember(db, { ...input, teamId: team.id, userId: team.leaderId });
  if (!head) return fail('QC_ROUTING_HEAD_MISSING', '来源对应的 QC 团队尚未配置合资格负责人，请先完善配置。');
  return { routingTeamId: team.id, responsibleHeadId: head.user.id };
}

/** Extend the existing personnel directory only for an authorized exact case.
 * Choices come from persisted organizational facts, never name inference. */
export async function listDevelopmentQcRoutingTeams(db: any, caseId: string, actorId: string, trustedActor: any) {
  const { development } = await authorizeDevelopmentSource(db, actorId, trustedActor, caseId, { scope: 'products:read', write: false });
  const teams = await qcTeams(db, development.type);
  const choices = [];
  for (const team of teams) {
    const head = team.leaderId && await developmentQcMember(db, { caseId, type: development.type, teamId: team.id, userId: team.leaderId, requesterId: actorId });
    choices.push({ id: team.id, name: team.name, family: development.type, configuredHeadId: team.leaderId ?? null, headId: head ? head.user.id : null, headName: head ? head.user.displayName ?? null : null });
  }
  await authorizeDevelopmentSource(db, actorId, trustedActor, caseId, { scope: 'products:read', write: false });
  return choices;
}
