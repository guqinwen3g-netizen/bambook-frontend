import { teamBusinessFamilies } from '../hr/departmentBusinessAttributes';
import { createPermissionService } from '../auth/permissionService';

/** Resolve from live organisation data; neither payload nor browser can nominate a reviewer. */
export async function resolveQuotationBusinessLeader(db: any, quotationId: string) {
  const fail = (message: string): never => { throw Object.assign(new Error(message), { code: 'NO_REVIEWER_RESOLVED', statusCode: 409 }); };
  const quote = await db.quotation.findUnique({ where: { id: quotationId } });
  if (!quote || quote.deletedAt != null) return fail('报价不存在或已归档。');
  const family = quote.quotationType === 'Fabric' ? 'fabric' : quote.quotationType === 'Garment' ? 'garment' : null;
  if (!family) return fail('请先确认报价属于面料或成衣。');
  if (!quote.ownerId) return fail('请先为报价指定负责业务员。');
  const owner = await db.userAccount.findFirst({ where: { id: quote.ownerId, status: 'active', deletedAt: null } });
  if (!owner) return fail('报价负责业务员已停用，请先核对归属。');
  const teams = await db.team.findMany({ where: { status: 'active', deletedAt: null, departmentId: owner.primaryDeptId,
    members: { some: { userId: owner.id, leftAt: null } } }, include: { department: true }, orderBy: { id: 'asc' } });
  const candidates = teams.filter((team: any) => teamBusinessFamilies(team).includes(family));
  const headIds = [...new Set<string>(candidates.map((team: any) => team.leaderId).filter(Boolean))];
  if (headIds.length !== 1 || candidates.some((team: any) => !team.leaderId)) return fail('对应业务团队负责人未配置或不唯一，请先核对负责人。');
  const reviewerId = headIds[0];
  const head = await db.userAccount.findFirst({ where: { id: reviewerId, status: 'active', deletedAt: null } });
  const permissions = head && await createPermissionService({ prisma: db }).getUserPermissionContext(reviewerId);
  if (!head || !permissions?.scopes.includes('quotations:write')) return fail('对应业务负责人已停用或缺少报价权限。');
  return { reviewerId, route: 'QUOTATION_BUSINESS_HEAD', departmentSnapshotId: owner.primaryDeptId, quotationId, family, quotationOwnerId: quote.ownerId };
}

export async function canSelfConfirmQuotation(db: any, approval: any, actorId: string) {
  if (approval.actionType !== 'quotation:total_approve' || approval.targetType !== 'Quotation'
    || approval.requesterId !== actorId || approval.reviewerId !== actorId || !approval.targetId) return false;
  const leader = await resolveQuotationBusinessLeader(db, approval.targetId);
  return leader.reviewerId === actorId && leader.quotationOwnerId === actorId;
}
