/** 客户关系切片：跟进记录与商机。只记录业务员实际登记的事实；商机金额按原币种保存，不跨币种汇总。 */
import { MistCommandError, type MistContext, type MistState } from './mistWorkspace';
import { ownerChangeText, resolveMember } from './mistAccounts';

export type CrmFollowUpMethod = 'call' | 'email' | 'meeting' | 'visit' | 'im' | 'other';
export type CrmLinkKind = 'development' | 'quotation' | 'order' | 'opportunity';
export type CrmLink = { kind: CrmLinkKind; id: string };
export type CrmFollowUp = { id: string; customerId: string; method: CrmFollowUpMethod; content: string; at: string; nextDate: string; nextTaskId: string; link: CrmLink | null; actor: string; createdAt: string };
export type CrmStage = 'intent' | 'sampling' | 'quoting' | 'won' | 'lost';
export type CrmOpportunity = { id: string; customerId: string; title: string; domain: 'garment' | 'fabric'; stage: CrmStage; amount: string; currency: string; expectedDate: string; /** 负责人显示名快照；ownerId 为负责人账号。 */ owner: string; ownerId: string; note: string; lossReason: string; devIds: string[]; quotationIds: string[]; orderIds: string[]; history: Array<{ at: string; actor: string; from: CrmStage | null; to: CrmStage; note: string }>; createdAt: string; updatedAt: string };
export type CrmState = { followUps: CrmFollowUp[]; opportunities: CrmOpportunity[] };
export type CrmOpportunityInput = { customerId: string; title: string; domain: 'garment' | 'fabric'; amount: string; currency: string; expectedDate: string; ownerId: string; note: string; devIds: string[]; quotationIds: string[]; orderIds: string[] };
export type CrmCommand =
  | { type: 'crm.followUp.save'; payload: { customerId: string; method: CrmFollowUpMethod; content: string; at: string; nextDate: string; link: CrmLink | null } }
  | { type: 'crm.opportunity.save'; payload: { id?: string; input: CrmOpportunityInput } }
  | { type: 'crm.opportunity.stage'; payload: { id: string; stage: CrmStage; note: string } };

export const CRM_METHOD_LABEL: Record<CrmFollowUpMethod, string> = { call: '电话', email: '邮件', meeting: '会议', visit: '拜访', im: '即时通讯', other: '其他' };
export const CRM_STAGE_LABEL: Record<CrmStage, string> = { intent: '意向', sampling: '打样', quoting: '报价', won: '已下单', lost: '已流失' };
export const CRM_STAGES: CrmStage[] = ['intent', 'sampling', 'quoting', 'won', 'lost'];
export const CRM_LINK_LABEL: Record<CrmLinkKind, string> = { development: '开发案', quotation: '报价', order: '订单', opportunity: '商机' };
const fail = (message: string, code = 'VALIDATION'): never => { throw new MistCommandError(code, message, code === 'NOT_FOUND' ? 404 : 422); };
const text = (value: unknown, label: string, required = false, max = 2000) => { const v = typeof value === 'string' ? value.trim() : ''; if (required && !v) fail(`请填写${label}`); if (v.length > max) fail(`${label}过长`); return v; };
const day = (value: unknown, label: string, required = false) => { const v = text(value, label, required, 10); if (v && (!/^\d{4}-\d{2}-\d{2}$/.test(v) || new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) !== v)) fail(`${label}格式无效`); return v; };

export function createCrmState(_context: MistContext, _root: unknown): CrmState { return { followUps: [], opportunities: [] }; }
export function crmCommandPermission(_command: CrmCommand) { return 'relations:write'; }

/** 关联对象必须属于同一客户。 */
export function crmLinkTarget(root: MistState, customerId: string, link: CrmLink): { label: string; view: string; id: string } | null {
  if (link.kind === 'development') { const row = root.devs.find(item => item.id === link.id && item.customerId === customerId); return row ? { label: `${row.code} · ${row.name}`, view: 'development/detail', id: row.id } : null; }
  if (link.kind === 'quotation') { const row = root.market.quotations.find(item => item.id === link.id && item.customerId === customerId); return row ? { label: row.code, view: 'quotations', id: row.id } : null; }
  if (link.kind === 'order') { const row = root.orders.find(item => item.id === link.id && item.customerId === customerId); return row ? { label: row.code, view: 'orders/detail', id: row.id } : null; }
  const row = root.crm.opportunities.find(item => item.id === link.id && item.customerId === customerId); return row ? { label: row.title, view: 'crm', id: customerId } : null;
}
function customer(root: MistState, id: unknown) { return root.customers.find(row => row.id === id) || fail('客户不存在', 'NOT_FOUND'); }
function ids(root: MistState, customerId: string, kind: Exclude<CrmLinkKind, 'opportunity'>, value: unknown) {
  if (value !== undefined && !Array.isArray(value)) fail('关联对象格式无效');
  const list = [...new Set(((value as unknown[]) || []).map(String))];
  for (const id of list) if (!crmLinkTarget(root, customerId, { kind, id })) fail(`关联的${CRM_LINK_LABEL[kind]}不属于该客户`, 'NOT_FOUND');
  return list;
}
function log(root: MistState, context: MistContext, entityId: string, value: string) { root.events.unshift({ id: context.id(), entityType: 'customer', entityId, actor: context.actorName, at: context.now, text: value, fileIds: [] }); }

export function applyCrmCommand(root: MistState, command: CrmCommand, context: MistContext): { id: string } {
  switch (command.type) {
    case 'crm.followUp.save': {
      const p = command.payload, c = customer(root, p.customerId);
      if (!Object.keys(CRM_METHOD_LABEL).includes(p.method)) fail('跟进方式无效');
      const content = text(p.content, '跟进内容', true, 4000), at = text(p.at, '跟进时间', true, 40), stamp = Date.parse(at);
      if (!Number.isFinite(stamp)) fail('跟进时间格式无效');
      if (stamp > Date.parse(context.now) + 60000) fail('跟进时间须为已发生的实际时间');
      const nextDate = day(p.nextDate, '下次跟进日');
      if (nextDate && nextDate < context.now.slice(0, 10)) fail('下次跟进日不能早于今天');
      let link: CrmLink | null = null;
      if (p.link) { if (!Object.keys(CRM_LINK_LABEL).includes(p.link.kind)) fail('关联对象类型无效'); link = { kind: p.link.kind, id: text(p.link.id, '关联对象', true, 200) }; if (!crmLinkTarget(root, c.id, link)) fail('关联对象不属于该客户', 'NOT_FOUND'); }
      const id = context.id(); let nextTaskId = '';
      if (nextDate) { nextTaskId = context.id(); root.tasks.unshift({ id: nextTaskId, title: `跟进客户：${c.name}`, due: nextDate, done: false, kind: 'crm-follow-up', target: { view: 'crm', id: c.id, customerId: c.id } }); }
      root.crm.followUps.unshift({ id, customerId: c.id, method: p.method, content, at: new Date(stamp).toISOString(), nextDate, nextTaskId, link, actor: context.actorName, createdAt: context.now });
      log(root, context, c.id, `记录${CRM_METHOD_LABEL[p.method]}跟进${nextDate ? `，下次跟进 ${nextDate}` : ''}`); return { id };
    }
    case 'crm.opportunity.save': {
      const input = command.payload.input || ({} as CrmOpportunityInput), old = command.payload.id ? root.crm.opportunities.find(row => row.id === command.payload.id) || fail('商机不存在', 'NOT_FOUND') : undefined;
      const c = customer(root, input.customerId); if (old && old.customerId !== c.id) fail('商机不能改到其他客户');
      if (old && (old.stage === 'won' || old.stage === 'lost')) fail('已结束的商机不能修改', 'PRECONDITION');
      if (!['garment', 'fabric'].includes(input.domain)) fail('业务板块无效');
      const amount = text(input.amount, '预计金额', true, 20); if (!/^\d{1,12}(\.\d{1,2})?$/.test(amount)) fail('预计金额须为最多两位小数的非负数');
      const currency = text(input.currency, '币种', true, 3).toUpperCase(); if (!/^[A-Z]{3}$/.test(currency)) fail('币种格式无效');
      if ((input as Record<string, unknown>).owner !== undefined) fail('负责人须按账号选择');
      const owner = old && input.ownerId === old.ownerId ? { id: old.ownerId, name: old.owner } : resolveMember(context, input.ownerId, '商机负责人');
      const row: CrmOpportunity = { id: old?.id || context.id(), customerId: c.id, title: text(input.title, '商机名称', true, 160), domain: input.domain, stage: old?.stage || 'intent', amount, currency, expectedDate: day(input.expectedDate, '预计成交日', true), owner: owner.name, ownerId: owner.id, note: text(input.note, '说明', false, 2000), lossReason: old?.lossReason || '', devIds: ids(root, c.id, 'development', input.devIds), quotationIds: ids(root, c.id, 'quotation', input.quotationIds), orderIds: ids(root, c.id, 'order', input.orderIds), history: old?.history || [{ at: context.now, actor: context.actorName, from: null, to: 'intent', note: '建立商机' }], createdAt: old?.createdAt || context.now, updatedAt: context.now };
      const ownerText = old && old.ownerId !== row.ownerId ? ' · ' + ownerChangeText('负责人', old.owner, owner.name) : '';
      if (old) Object.assign(old, row); else root.crm.opportunities.unshift(row);
      log(root, context, c.id, `${old ? '更新' : '建立'}商机 ${row.title}${ownerText}`); return { id: row.id };
    }
    case 'crm.opportunity.stage': {
      const row = root.crm.opportunities.find(item => item.id === command.payload.id) || fail('商机不存在', 'NOT_FOUND'), stage = command.payload.stage, note = text(command.payload.note, '说明', false, 1000);
      if (!CRM_STAGES.includes(stage)) fail('商机阶段无效');
      if (row.stage === 'won' || row.stage === 'lost') fail('商机已结束', 'PRECONDITION');
      if (row.stage === stage) return { id: row.id };
      if (stage === 'lost' && !note) fail('请填写流失原因');
      if (stage === 'won' && !row.orderIds.length) fail('请先关联实际订单，再标记为已下单', 'PRECONDITION');
      if (stage === 'quoting' && !row.quotationIds.length && !note) fail('请关联报价，或说明报价依据');
      row.history.push({ at: context.now, actor: context.actorName, from: row.stage, to: stage, note }); row.stage = stage; if (stage === 'lost') row.lossReason = note; row.updatedAt = context.now;
      log(root, context, row.customerId, `商机 ${row.title} 推进到${CRM_STAGE_LABEL[stage]}`); return { id: row.id };
    }
  }
  return fail('未知客户关系操作');
}