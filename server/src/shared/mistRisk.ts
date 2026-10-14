/**
 * 风险管理与合规（CAP-risks-01/02 · G69）。
 * - 预警（signal）只从真实记录推出：逾期应收、往来冻结、供应商认证 / 暂停、QC 不通过、生产逾期或风险说明。
 *   预警不改任何来源记录，不自动冻结付款、删单或改 QC / 账务 / 审批；处理回到原记录。
 * - 风险登记：单一主负责人；同一来源预警只允许一条未关闭风险（合并提醒）。
 *   新发现 → 已接手 → 处理中（处置方案）→ 已升级（适用审批人受控授权 / 继续阻断）→ 已关闭（关闭依据，可回读）。
 */
import { MistCommandError, isActiveMistInvoice, type MistContext, type MistState } from './mistWorkspace';
import { supplierStatusOn } from './mistSupplierStatus';

export type RiskType = 'credit' | 'fx' | 'compliance' | 'quality' | 'delivery' | 'other';
export type RiskSourceKind = 'order' | 'invoice' | 'customer' | 'supplier' | 'production' | 'relation';
export type RiskState = 'Open' | 'Acknowledged' | 'InProgress' | 'Escalated' | 'Resolved';
export type RiskEscalation = { id: string; approver: string; reason: string; requestedBy: string; requestedAt: string; decision: 'pending' | 'approved' | 'rejected'; decisionNote: string; decidedBy: string; decidedAt: string };
export type RiskRecord = {
  id: string; orderId: string; title: string; level: 'info' | 'warning' | 'critical'; basis: string; owner: string; state: RiskState; resolution: string; createdAt: string;
  type?: RiskType; source?: { kind: RiskSourceKind; id: string; label: string }; signalKey?: string; createdBy?: string;
  acknowledgedAt?: string; plan?: string; planDue?: string; escalations?: RiskEscalation[]; closedAt?: string; closedBy?: string; updatedAt?: string;
};
export type RiskSignal = { key: string; type: RiskType; level: RiskRecord['level']; title: string; basis: string; source: { kind: RiskSourceKind; id: string; label: string }; orderId: string; since: string };

export const RISK_TYPES: RiskType[] = ['credit', 'fx', 'compliance', 'quality', 'delivery', 'other'];
export const RISK_SOURCE_KINDS: RiskSourceKind[] = ['order', 'invoice', 'customer', 'supplier', 'production', 'relation'];
export const CERT_NEAR_DAYS = 30;
const DAY = 86400000;
const days = (from: string, to: string) => Math.round((Date.parse(to.slice(0, 10) + 'T00:00:00Z') - Date.parse(from.slice(0, 10) + 'T00:00:00Z')) / DAY);
/** 旧记录只有 orderId / Acknowledged / Resolved：按订单来源、其他类型读取，不改写历史。 */
export function riskType(r: RiskRecord): RiskType { return r.type || 'other'; }
export function riskSource(state: MistState | null, r: RiskRecord): { kind: RiskSourceKind; id: string; label: string } | null {
  if (r.source) return r.source;
  if (!r.orderId) return null;
  const o = state?.orders.find(x => x.id === r.orderId);
  return { kind: 'order', id: r.orderId, label: o ? o.code + ' · ' + o.customer : r.orderId };
}
export function pendingEscalation(r: RiskRecord) { return (r.escalations || []).find(e => e.decision === 'pending'); }

/** 当前预警。day = 业务日（上海）。只读，不写入任何记录。 */
export function riskSignals(state: MistState | null, day: string): RiskSignal[] {
  if (!state) return [];
  const out: RiskSignal[] = [];
  for (const i of state.invoices) {
    if (!isActiveMistInvoice(i) || !(i.open > 0) || !i.due || i.due >= day) continue;
    const late = days(i.due, day);
    out.push({ key: 'invoice-overdue:' + i.id, type: 'credit', level: late > 30 ? 'critical' : 'warning', title: `${i.customer} 应收逾期 ${late} 天`, basis: `${i.code} 到期 ${i.due}，未收 ${i.currency} ${i.open.toFixed(2)}（原币，未换算）。`, source: { kind: 'invoice', id: i.id, label: i.code + ' · ' + i.customer }, orderId: i.orderId, since: i.due });
  }
  for (const r of state.market?.relations || []) {
    if (!r.hold || r.status === 'archived') continue;
    out.push({ key: 'relation-hold:' + r.id, type: 'credit', level: 'warning', title: `${r.name} 往来已冻结`, basis: `冻结原因：${r.hold.reason}（${r.hold.actor} · ${r.hold.at.slice(0, 10)}）。新报价、订单与采购会被拦截，已有业务需逐项确认。`, source: { kind: 'relation', id: r.id, label: r.name }, orderId: '', since: r.hold.at.slice(0, 10) });
  }
  for (const s of state.market?.suppliers || []) {
    for (const c of s.certificates || []) {
      const left = days(day, c.validUntil);
      if (left < 0) out.push({ key: `cert-expired:${s.id}:${c.id}`, type: 'compliance', level: 'critical', title: `${s.name} · ${c.name} 已过期 ${-left} 天`, basis: `证书 ${c.number || '未填编号'}（${c.issuer || '未填发证机构'}）有效至 ${c.validUntil}。`, source: { kind: 'supplier', id: s.id, label: s.name }, orderId: '', since: c.validUntil });
      else if (left <= CERT_NEAR_DAYS) out.push({ key: `cert-expiring:${s.id}:${c.id}`, type: 'compliance', level: 'warning', title: `${s.name} · ${c.name} ${left} 天后到期`, basis: `证书 ${c.number || '未填编号'} 有效至 ${c.validUntil}，请供应商提供续期文件。`, source: { kind: 'supplier', id: s.id, label: s.name }, orderId: '', since: day });
    }
    const now = supplierStatusOn(s, day);
    if (now !== 'active') {
      const open = (state.fulfillment?.purchases || []).filter(p => p.supplierId === s.id && p.state !== 'rejected' && p.received < p.quantity).length;
      if (open) out.push({ key: `supplier-${now}:${s.id}`, type: 'compliance', level: now === 'blocked' ? 'critical' : 'warning', title: `${s.name} 已${now === 'blocked' ? '停用' : '暂停'}，仍有 ${open} 张在途采购`, basis: `${s.blockReason || '未填原因'}${s.statusFrom ? `（${s.statusFrom} 起）` : ''}。在途采购需逐张确认继续或转厂。`, source: { kind: 'supplier', id: s.id, label: s.name }, orderId: '', since: s.statusFrom || day });
    }
  }
  for (const p of state.productions) {
    const order = state.orders.find(o => o.id === p.orderId), label = p.code + ' · ' + (order?.code || p.order);
    if (p.risk?.startsWith('QC 不通过')) { out.push({ key: 'qc-nok:' + p.id, type: 'quality', level: 'critical', title: `${p.name} QC 不通过`, basis: p.risk, source: { kind: 'production', id: p.id, label }, orderId: p.orderId, since: day }); continue; }
    if (p.col === 'done') continue;
    const late = /^\d{4}-\d{2}-\d{2}$/.test(p.due) ? days(p.due, day) : 0;
    if (late > 0) out.push({ key: 'production-late:' + p.id, type: 'delivery', level: late > 7 ? 'critical' : 'warning', title: `${p.name} 超过工厂交期 ${late} 天`, basis: `${p.factory} · 交期 ${p.due} · 进度 ${p.pct}%${p.risk ? ' · ' + p.risk : ''}`, source: { kind: 'production', id: p.id, label }, orderId: p.orderId, since: p.due });
    else if (p.risk?.trim()) out.push({ key: 'production-risk:' + p.id, type: 'delivery', level: 'info', title: `${p.name} 生产风险说明`, basis: `${p.factory} · 交期 ${p.due} · ${p.risk}`, source: { kind: 'production', id: p.id, label }, orderId: p.orderId, since: day });
  }
  const rank = { critical: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level] || a.since.localeCompare(b.since));
}

function fail(message: string, code = 'VALIDATION'): never { throw new MistCommandError(code, message); }
function text(v: unknown, label: string, required = true, max = 4000) { if (typeof v !== 'string' || v.length > max || (required && !v.trim())) fail(label + '未填写或格式无效'); return (v as string).trim(); }
function optionalDay(v: unknown, label: string) { if (v === undefined || v === '') return ''; const s = text(v, label); if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) !== s) fail(label + '无效'); return s; }
function find(rows: RiskRecord[], id: string) { const r = rows.find(x => x.id === id); if (!r) fail('风险不存在', 'NOT_FOUND'); return r!; }
function emit(root: MistState, c: MistContext, id: string, message: string) { root.events.unshift({ id: c.id(), entityType: 'risk', entityId: id, at: c.now, actor: c.actorName, text: message, fileIds: [] }); }
function sourceOf(root: MistState, kind: RiskSourceKind, id: string): { label: string; orderId: string } {
  const miss = (l: string): never => fail(l + '不存在', 'NOT_FOUND');
  switch (kind) {
    case 'order': { const o = root.orders.find(x => x.id === id) || miss('来源订单'); return { label: o.code + ' · ' + o.customer, orderId: o.id }; }
    case 'invoice': { const i = root.invoices.find(x => x.id === id) || miss('来源发票'); return { label: i.code + ' · ' + i.customer, orderId: i.orderId }; }
    case 'customer': { const x = root.customers.find(c => c.id === id) || miss('来源客户'); return { label: x.name, orderId: '' }; }
    case 'supplier': { const x = (root.market?.suppliers || []).find(s => s.id === id) || miss('来源供应商'); return { label: x.name, orderId: '' }; }
    case 'relation': { const x = (root.market?.relations || []).find(s => s.id === id) || miss('来源组织'); return { label: x.name, orderId: '' }; }
    case 'production': { const p = root.productions.find(x => x.id === id) || miss('来源生产分支'); const o = root.orders.find(x => x.id === p.orderId); return { label: p.code + ' · ' + (o?.code || p.order), orderId: p.orderId }; }
  }
  return fail('来源类型无效');
}
const LABEL: Record<RiskState, string> = { Open: '新发现', Acknowledged: '已接手', InProgress: '处理中', Escalated: '已升级', Resolved: '已关闭' };
export const RISK_STATE_LABEL = LABEL;

export type RiskCommand =
  | { type: 'platform.risk.save'; payload: { orderId?: string; title: string; level: RiskRecord['level']; basis: string; owner: string; type?: RiskType; source?: { kind: RiskSourceKind; id: string }; signalKey?: string } }
  | { type: 'platform.risk.transition'; payload: { id: string; state: 'Acknowledged' | 'Resolved'; resolution: string } }
  | { type: 'platform.risk.plan'; payload: { id: string; plan: string; planDue?: string } }
  | { type: 'platform.risk.escalate'; payload: { id: string; approver: string; reason: string } }
  | { type: 'platform.risk.decide'; payload: { id: string; escalationId: string; decision: 'approved' | 'rejected'; note: string } };

export function riskCommandPermission(command: RiskCommand) { return command.type === 'platform.risk.decide' ? 'risk:admin' : 'risk:write'; }

export function applyRiskCommand(root: MistState, risks: RiskRecord[], command: RiskCommand, c: MistContext): { id: string } {
  const v: any = command.payload;
  switch (command.type) {
    case 'platform.risk.save': {
      const level = ['info', 'warning', 'critical'].includes(v.level) ? v.level : fail('风险级别无效');
      const type: RiskType = v.type === undefined ? 'other' : RISK_TYPES.includes(v.type) ? v.type : fail('风险类型无效');
      let src: RiskRecord['source'], orderId = '';
      if (v.source) { if (!RISK_SOURCE_KINDS.includes(v.source.kind)) fail('来源类型无效'); const s = sourceOf(root, v.source.kind, text(v.source.id, '来源')); src = { kind: v.source.kind, id: v.source.id, label: s.label }; orderId = s.orderId; }
      else { if (!v.orderId) fail('请选择风险来源记录'); sourceOf(root, 'order', text(v.orderId, '来源订单')); orderId = v.orderId; }
      const signalKey = v.signalKey === undefined ? undefined : text(v.signalKey, '预警标识', true, 200);
      if (signalKey) { const dup = risks.find(r => r.signalKey === signalKey && r.state !== 'Resolved'); if (dup) fail(`这条预警已登记为「${dup.title}」（${LABEL[dup.state]}），请在原风险继续处理`, 'CONFLICT'); }
      const row: RiskRecord = { id: c.id(), orderId, title: text(v.title, '风险标题', true, 200), basis: text(v.basis, '风险依据'), owner: text(v.owner, '负责人', true, 100), level, state: 'Open', resolution: '', createdAt: c.now, type, source: src, signalKey, createdBy: c.actorName, escalations: [], updatedAt: c.now };
      risks.unshift(row); emit(root, c, row.id, `登记风险 ${row.title} · 负责人 ${row.owner}`); return { id: row.id };
    }
    case 'platform.risk.transition': {
      const row = find(risks, v.id);
      if (!['Acknowledged', 'Resolved'].includes(v.state)) fail('状态无效');
      if (row.state === 'Resolved') fail('风险已关闭', 'CONFLICT');
      if (v.state === 'Acknowledged') {
        if (row.state !== 'Open') fail('风险已被接手', 'CONFLICT');
        const note = text(v.resolution, '接手说明', false);
        row.state = 'Acknowledged'; row.acknowledgedAt = c.now; if (row.owner !== c.actorName) { emit(root, c, row.id, `负责人由 ${row.owner} 变更为 ${c.actorName}`); row.owner = c.actorName; }
        row.updatedAt = c.now; emit(root, c, row.id, '接手风险' + (note ? '：' + note : '')); return { id: row.id };
      }
      if (row.state === 'Open') fail('请先确认接手风险，再记录关闭依据');
      if (pendingEscalation(row)) fail('升级审批尚未答复，不能关闭', 'CONFLICT');
      row.state = 'Resolved'; row.resolution = text(v.resolution, '关闭依据'); row.closedAt = c.now; row.closedBy = c.actorName; row.updatedAt = c.now;
      emit(root, c, row.id, '关闭风险：' + row.resolution); return { id: row.id };
    }
    case 'platform.risk.plan': {
      const row = find(risks, v.id);
      if (row.state === 'Open') fail('请先接手风险');
      if (row.state === 'Resolved') fail('风险已关闭', 'CONFLICT');
      if (row.state === 'Escalated') fail('升级审批中，答复后再调整处置方案', 'CONFLICT');
      const before = row.plan; row.plan = text(v.plan, '处置方案'); row.planDue = optionalDay(v.planDue, '计划完成日'); row.state = 'InProgress'; row.updatedAt = c.now;
      emit(root, c, row.id, (before ? '更新处置方案：' : '制定处置方案：') + row.plan + (row.planDue ? `（计划 ${row.planDue} 完成）` : '')); return { id: row.id };
    }
    case 'platform.risk.escalate': {
      const row = find(risks, v.id);
      if (row.state !== 'InProgress') fail(row.state === 'Escalated' ? '已在升级审批中' : '先制定处置方案，再申请升级', 'CONFLICT');
      const e: RiskEscalation = { id: c.id(), approver: text(v.approver, '审批人', true, 100), reason: text(v.reason, '升级原因'), requestedBy: c.actorName, requestedAt: c.now, decision: 'pending', decisionNote: '', decidedBy: '', decidedAt: '' };
      row.escalations = [...(row.escalations || []), e]; row.state = 'Escalated'; row.updatedAt = c.now;
      root.tasks.unshift({ id: c.id(), title: `审批风险升级 · ${row.title}`, due: '', done: false, kind: 'risk-escalation:' + e.id, target: { view: 'risks', id: row.id } });
      emit(root, c, row.id, `申请升级至 ${e.approver}：${e.reason}`); return { id: row.id };
    }
    case 'platform.risk.decide': {
      const row = find(risks, v.id), e = pendingEscalation(row);
      if (!e || e.id !== v.escalationId) fail('这次升级已答复或已变化，请刷新后查看', 'CONFLICT');
      if (!['approved', 'rejected'].includes(v.decision)) fail('审批结果无效');
      if (e!.requestedBy === c.actorName) fail('申请人不能审批自己的升级', 'FORBIDDEN');
      e!.decision = v.decision; e!.decisionNote = text(v.note, '审批意见'); e!.decidedBy = c.actorName; e!.decidedAt = c.now; row.state = 'InProgress'; row.updatedAt = c.now;
      for (const t of root.tasks) if (t.kind === 'risk-escalation:' + e!.id) t.done = true;
      root.notifications.unshift({ id: c.id(), title: `${row.title} · 升级${v.decision === 'approved' ? '已授权' : '未授权，继续按原规则处理'}`, detail: `${c.actorName}：${e!.decisionNote}`, at: c.now, readAt: null, target: { view: 'risks', id: row.id }, category: 'general' });
      emit(root, c, row.id, `${v.decision === 'approved' ? '批准升级（受控授权）' : '驳回升级（继续阻断）'}：${e!.decisionNote}`); return { id: row.id };
    }
  }
  return fail('未知风险操作');
}
