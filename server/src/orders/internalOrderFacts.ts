import type { TokenPayload } from '../auth/service';
import { teamBusinessFamilies } from '../hr/departmentBusinessAttributes';
export { teamBusinessFamilies } from '../hr/departmentBusinessAttributes';
import { businessError } from '../shared/errorCodes';

export const INTERNAL_ORDER_FIELDS = ['orderPurpose', 'internalPurpose', 'internalDemandTeamId', 'internalReceiverId'] as const;
export const isInternalOrderPurpose = (value: unknown) => value === 'internal_stock' || value === 'internal_fabric_supply';
/** Only use actors freshly resolved from the current account, never request role claims. */
export const hasAllInternalBusinessTeams = (actor: TokenPayload) => actor.authorizationLoaded === true
  && !!actor.roleIds?.includes('role-super-admin');
export function internalBusinessTeamFamily(team: any): 'fabric' | 'garment' | null {
  return teamBusinessFamilies(team)[0] ?? null;
}
export function orderBusinessFamily(order: { businessLine?: unknown; type?: unknown }): 'fabric' | 'garment' {
  const value = String(order.businessLine || order.type || '').trim().toLowerCase();
  if (value === 'fabric' || value === 'garment') return value;
  throw businessError('INVALID_INPUT', '请明确订单业务域。');
}
const required = (value: unknown, label: string) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 500)
    throw businessError('INVALID_INPUT', `请填写${label}。`);
  return value.trim();
};

/** Actual organizational facts only. No names, JWT roles or client member lists grant access. */
export async function currentInternalDemand(db: any, order: any) {
  const purpose = required(order.internalPurpose, '内部用途');
  const teamId = required(order.internalDemandTeamId, '实际需求团队');
  const receiverId = required(order.internalReceiverId, '接收负责人');
  const team = await db.team.findFirst({ where: { id: teamId, status: 'active', deletedAt: null }, include: { department: true } });
  const member = await db.teamMember.findFirst({ where: { teamId, userId: receiverId, leftAt: null } });
  const receiver = await db.userAccount.findFirst({ where: { id: receiverId, status: 'active', deletedAt: null } });
  if (!team || !member || !receiver || receiver.primaryDeptId !== team.departmentId) throw businessError('CONFLICT', '需求团队或接收负责人已失效，请重新选择实际团队成员。');
  const families = teamBusinessFamilies(team);
  if (!families.length) throw businessError('INVALID_INPUT', '内部订单需求团队须为面料或成衣业务组。');
  if (order.orderPurpose === 'internal_fabric_supply' && !families.includes('garment'))
    throw businessError('INVALID_INPUT', '内部面料供给须明确实际成衣需求团队。');
  return { purpose, team, receiver };
}

export async function assertActorBusinessTeam(db: any, actor: TokenPayload, family: 'fabric' | 'garment') {
  if (hasAllInternalBusinessTeams(actor)) return;
  const account = await db.userAccount.findFirst({ where: { id: actor.userId, status: 'active', deletedAt: null }, include: { primaryDepartment: true } });
  const memberships = await db.teamMember.findMany({ where: { userId: actor.userId, leftAt: null }, include: { team: { include: { department: true } } } });
  if (!memberships.some((row: any) => account?.primaryDeptId && row.team?.departmentId === account.primaryDeptId && row.team?.status === 'active' && row.team.deletedAt == null && teamBusinessFamilies(row.team).includes(family)))
    throw businessError('FORBIDDEN', `内部${family === 'fabric' ? '面料' : '成衣'}订单须由实际对应业务组建立。`);
}

/** Run under the caller's fresh order actor + L2 transaction, before persistence. */
export async function normalizeInternalOrderInput(db: any, actor: TokenPayload, input: Record<string, unknown>, previous?: any) {
  const touched = INTERNAL_ORDER_FIELDS.some(key => Object.prototype.hasOwnProperty.call(input, key));
  if (previous && !touched && !isInternalOrderPurpose(previous.orderPurpose)) return {};
  const effective = { ...(previous || {}), ...input };
  const purpose = effective.orderPurpose ?? 'external';
  if (!['external', 'internal_stock', 'internal_fabric_supply'].includes(purpose))
    throw businessError('INVALID_INPUT', '订单用途未识别。');
  if (!isInternalOrderPurpose(purpose)) return { orderPurpose: 'external', internalPurpose: null, internalDemandTeamId: null, internalReceiverId: null };
  const family = orderBusinessFamily(effective);
  if (purpose === 'internal_fabric_supply' && family !== 'fabric') throw businessError('INVALID_INPUT', '内部面料供给单由面料业务建立，成衣订单只引用准确面料行。');
  await assertActorBusinessTeam(db, actor, family);
  const demand = await currentInternalDemand(db, { ...effective, orderPurpose: purpose });
  if (effective.poNumber != null && String(effective.poNumber).trim()) throw businessError('INVALID_INPUT', '内部单不填写外部 PO。');
  if (effective.customerRelationId != null && String(effective.customerRelationId).trim()) throw businessError('INVALID_INPUT', '内部单不绑定虚构客户关系。');
  return { orderPurpose: purpose, internalPurpose: demand.purpose, internalDemandTeamId: demand.team.id,
    internalReceiverId: demand.receiver.id, customer: demand.team.name, customerRelationId: null, poNumber: null,
  };
}
