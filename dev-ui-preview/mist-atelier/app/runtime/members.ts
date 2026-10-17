/** 负责人 / 经手人选择：只列本空间的所有者与被授权成员，按账号 ID 选择（同名账号以编号区分）。服务端仍逐项校验。 */
import type { MistState } from '../../../../server/src/shared/mistWorkspace';
import { MIST_BUSINESS_GROUP_LABEL, accountOwnedObjects, type MistBusinessGroup } from '../../../../server/src/shared/mistAccounts';

export type MistMemberOption = { id: string; name: string; groups: MistBusinessGroup[]; owner: boolean };
type Envelope = { ownerId?: string } | null | undefined;
type Viewer = { id?: string; displayName?: string } | null | undefined;

/** 所有者显示名：本人即当前账号；否则取业务组登记或已有记录里的快照名，最后退回账号编号。 */
function ownerName(state: MistState, ownerId: string, viewer: Viewer): string {
  if (viewer?.id === ownerId && viewer.displayName) return viewer.displayName;
  const fromGroups = state.memberGroups?.find(g => g.userId === ownerId)?.name;
  if (fromGroups) return fromGroups;
  const snapshot = [...(state.customers || []), ...(state.orders || []), ...(state.devs || []), ...(state.fabrics || [])].find(row => row.ownerId === ownerId)?.owner;
  return snapshot || ownerId;
}
export function workspaceMembers(envelope: Envelope, state: MistState | null | undefined, viewer: Viewer): MistMemberOption[] {
  if (!state) return [];
  const groups = (id: string) => state.memberGroups?.find(g => g.userId === id)?.groups ?? [];
  const out: MistMemberOption[] = [];
  if (envelope?.ownerId) out.push({ id: envelope.ownerId, name: ownerName(state, envelope.ownerId, viewer), groups: groups(envelope.ownerId), owner: true });
  for (const m of state.members ?? []) if (!out.some(o => o.id === m.userId)) out.push({ id: m.userId, name: m.name, groups: groups(m.userId), owner: false });
  return out;
}
/** Select 选项：可按业务组过滤；当前值若已不在成员中仍显示（只读保留，服务端不接受新指定）。 */
export function memberSelectOptions(members: MistMemberOption[], options: { group?: MistBusinessGroup; current?: { id?: string; name?: string } } = {}) {
  const list = options.group ? members.filter(m => m.groups.includes(options.group!)) : members;
  const dup = (name: string) => members.filter(m => m.name === name).length > 1;
  const rows = list.map(m => ({ value: m.id, label: dup(m.name) ? `${m.name} · ${m.id}` : m.name }));
  const current = options.current;
  if (current?.id && !rows.some(r => r.value === current.id)) {
    const member = members.find(m => m.id === current.id);
    rows.unshift({ value: current.id, label: `${current.name || member?.name || current.id}（${member && options.group ? '不在' + MIST_BUSINESS_GROUP_LABEL[options.group] + '组' : '已不在本空间成员中'}）` });
  }
  return rows;
}
export function defaultMemberId(members: MistMemberOption[], viewerId?: string | null, group?: MistBusinessGroup) {
  const pool = group ? members.filter(m => m.groups.includes(group)) : members;
  return pool.find(m => m.id === viewerId)?.id ?? (group ? '' : members.find(m => m.id === viewerId)?.id ?? '');
}
export { accountOwnedObjects };
