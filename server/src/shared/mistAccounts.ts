/**
 * 账号引用与业务组（供应商/关系 包 A）。
 *
 * 负责人、经手人一律保存“账号 ID + 当时显示名”：ID 用于判断与查询，显示名只是快照，同名账号也按 ID 区分。
 * 是否为本工作区有效成员、属于哪个业务组，由服务端按本次执行时的成员目录（context.members）判断，
 * 命令 payload 只能提交账号 ID，不能提交或改写显示名。目录缺失时一律拒绝（失败关闭）。
 */
import { MistCommandError, type MistContext, type MistState } from './mistWorkspace';

export type MistBusinessGroup = 'fabric' | 'garment';
export const MIST_BUSINESS_GROUPS: readonly MistBusinessGroup[] = ['fabric', 'garment'];
export const MIST_BUSINESS_GROUP_LABEL: Record<MistBusinessGroup, string> = { fabric: '面料', garment: '成衣' };
export type MistAccountRef = { id: string; name: string };
/** 服务端构建的成员目录：所有者 + 被授权成员；active=false 表示账号已停用或已删除。 */
export type MistMemberDirectoryEntry = { id: string; name: string; active: boolean; groups: MistBusinessGroup[] };
/** 工作区成员的业务组（所有者在成员管理设置）；name 为设置时的显示名快照。 */
export type MistMemberGroupAssignment = { userId: string; name: string; groups: MistBusinessGroup[]; updatedAt: string; updatedBy: string };

const fail = (message: string, code = 'VALIDATION', status = 422): never => { throw new MistCommandError(code, message, status); };

export function isBusinessGroup(value: unknown): value is MistBusinessGroup { return value === 'fabric' || value === 'garment'; }
export function memberGroups(state: Pick<MistState, 'memberGroups'>, userId: string): MistBusinessGroup[] {
  return (state.memberGroups || []).find(row => row.userId === userId)?.groups.filter(isBusinessGroup) || [];
}
/** 由所有者、成员列表、业务组与账号状态构建目录（仓储层使用；不在目录里的账号都不是成员）。 */
export function buildMemberDirectory(input: { ownerId: string; state: Pick<MistState, 'memberIds' | 'members' | 'memberGroups'>; accounts: Map<string, { name: string; active: boolean }> }): MistMemberDirectoryEntry[] {
  const ids = [input.ownerId, ...(Array.isArray(input.state.memberIds) ? input.state.memberIds : [])].filter((id, index, all) => typeof id === 'string' && id && all.indexOf(id) === index);
  const listed = new Map((input.state.members || []).map(m => [m.userId, m.name]));
  return ids.map(id => {
    const account = input.accounts.get(id);
    return { id, name: account?.name || listed.get(id) || id, active: !!account?.active, groups: memberGroups(input.state, id) };
  });
}
/**
 * 按账号 ID 解析成员引用。非成员、已停用、（指定业务组时）不属于该组 → 拒绝。
 * 返回服务端目录里的当前显示名，作为快照写入业务记录。
 */
export function resolveMember(context: Pick<MistContext, 'members'> & Partial<Pick<MistContext, 'actorId' | 'actorName'>>, value: unknown, label: string, group?: MistBusinessGroup): MistAccountRef {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) fail(`请按账号选择${label}`);
  const id = (value as string).trim();
  // 未带成员目录时只接受执行人本人（已由仓储层核验登录与成员身份）且不限业务组；指定他人一律无法核对、拒绝。
  if (!context.members && !group && context.actorId && id === context.actorId) return { id, name: context.actorName || id };
  if (!context.members) fail(`无法核对${label}是否为本工作区成员，请刷新后重试`, 'PRECONDITION');
  const entry = context.members!.find(row => row.id === id);
  if (!entry) fail(`${label}须为本工作区的成员账号`);
  if (!entry!.active) fail(`${label}（${entry!.name}）的账号已停用，不能指定`);
  if (group && !entry!.groups.includes(group)) fail(`${label}（${entry!.name}）不属于${MIST_BUSINESS_GROUP_LABEL[group]}业务组`);
  return { id: entry!.id, name: entry!.name };
}
/** 负责人变更事件文本，例如“负责人：顾言→沈禾”。 */
export function ownerChangeText(label: string, before: string | undefined, after: string | undefined): string {
  return `${label}：${before || '未指定'}→${after || '未指定'}`;
}

export type MistOwnedObject = { kind: 'customer' | 'order' | 'development' | 'fabric' | 'opportunity' | 'supplier'; id: string; label: string; role: string };
/** 按账号列出其负责/经手的全部对象（客户、订单、开发案、面料寻样、商机、供应商经手）。 */
export function accountOwnedObjects(state: MistState, accountId: string): MistOwnedObject[] {
  if (!accountId) return [];
  const out: MistOwnedObject[] = [];
  for (const c of state.customers || []) if (c.ownerId === accountId) out.push({ kind: 'customer', id: c.id, label: `${c.code} · ${c.name}`, role: '客户负责人' });
  for (const o of state.orders || []) if (o.ownerId === accountId) out.push({ kind: 'order', id: o.id, label: `${o.code} · ${o.customer}`, role: '订单负责人' });
  for (const d of state.devs || []) if (d.ownerId === accountId) out.push({ kind: 'development', id: d.id, label: `${d.code} · ${d.name}`, role: '开发负责人' });
  for (const f of state.fabrics || []) if (f.ownerId === accountId) out.push({ kind: 'fabric', id: f.id, label: `${f.code} · ${f.name}`, role: '寻样负责人' });
  for (const o of state.crm?.opportunities || []) if (o.ownerId === accountId) out.push({ kind: 'opportunity', id: o.id, label: o.title, role: '商机负责人' });
  for (const s of state.market?.suppliers || []) for (const group of MIST_BUSINESS_GROUPS) if (s.handlers?.[group]?.id === accountId) out.push({ kind: 'supplier', id: s.id, label: `${s.code} · ${s.name}`, role: `${MIST_BUSINESS_GROUP_LABEL[group]}经手人` });
  return out;
}
/** 设置成员业务组（所有者在成员管理办理）。 */
export function setMemberGroups(state: MistState, payload: { userId?: unknown; groups?: unknown }, context: MistContext): { userId: string; groups: MistBusinessGroup[] } {
  if (!payload || typeof payload !== 'object' || Object.keys(payload).some(key => key !== 'userId' && key !== 'groups')) fail('业务组设置格式无效');
  if (typeof payload.userId !== 'string' || !payload.userId) fail('请选择成员');
  if (!Array.isArray(payload.groups) || payload.groups.length > MIST_BUSINESS_GROUPS.length || payload.groups.some(g => !isBusinessGroup(g))) fail('业务组只能选择面料、成衣');
  if (!context.members) fail('无法核对成员，请刷新后重试', 'PRECONDITION');
  const entry = context.members!.find(row => row.id === payload.userId);
  if (!entry) fail('该账号不是本工作区成员');
  const groups = MIST_BUSINESS_GROUPS.filter(g => (payload.groups as unknown[]).includes(g));
  const before = memberGroups(state, entry!.id);
  if (before.length === groups.length && before.every(g => groups.includes(g))) return { userId: entry!.id, groups };
  const rest = (state.memberGroups || []).filter(row => row.userId !== entry!.id);
  state.memberGroups = groups.length ? [...rest, { userId: entry!.id, name: entry!.name, groups, updatedAt: context.now, updatedBy: context.actorName }] : rest;
  const label = (list: MistBusinessGroup[]) => list.length ? list.map(g => MIST_BUSINESS_GROUP_LABEL[g]).join('、') : '无';
  state.events.unshift({ id: context.id(), entityType: 'workspace', entityId: entry!.id, actor: context.actorName, at: context.now, text: `业务组（${entry!.name}）：${label(before)}→${label(groups)}`, fileIds: [] });
  return { userId: entry!.id, groups };
}
/** 演示工作区的示例人物（只用于生成示例数据；不是可登录账号，也不会写入成员授权）。 */
export const MIST_DEMO_ACCOUNTS: MistMemberDirectoryEntry[] = [
  { id: 'demo-sales', name: '顾言', active: true, groups: ['garment'] },
  { id: 'demo-buyer', name: '沈禾', active: true, groups: ['fabric', 'garment'] },
  { id: 'demo-reviewer', name: '周敏', active: true, groups: ['fabric', 'garment'] },
  { id: 'demo-qc', name: '许言', active: true, groups: [] },
  { id: 'demo-warehouse', name: '陈晓', active: true, groups: [] },
];
export function demoAccountRef(name: string): MistAccountRef {
  const row = MIST_DEMO_ACCOUNTS.find(a => a.name === name);
  if (!row) throw new Error('演示人物不存在：' + name);
  return { id: row.id, name: row.name };
}
/** 需要成员目录的命令（会写入负责人 / 经手人 / 业务组）。仓储层只为这些命令查询账号状态。 */
export const MIST_MEMBER_DIRECTORY_COMMANDS: readonly string[] = ['customer.update', 'market.customer.update', 'market.customer.create', 'order.create', 'order.update', 'order.governance.saveDraft', 'fabric.create', 'crm.opportunity.save', 'market.supplier.save', 'market.quotation.convert', 'market.lead.convertToCrm', 'development.submit', 'member.groups.set'];
