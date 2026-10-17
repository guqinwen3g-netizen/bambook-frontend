/**
 * 风险管理与合规（CAP-risks-01/02 · G69）。
 * - 预警（signal）只从真实记录推出：逾期应收、往来冻结、供应商认证 / 暂停、QC 不通过、生产逾期或风险说明。
 *   预警不改任何来源记录，不自动冻结付款、删单或改 QC / 账务 / 审批；处理回到原记录。
 * - 风险登记：单一主负责人；同一来源预警只允许一条未关闭风险（合并提醒）。
 *   新发现 → 已接手 → 处理中（处置方案）→ 已升级（适用审批人受控授权 / 继续阻断）→ 已关闭（关闭依据，可回读）。
 * - 风险分级权限：业务员只处理来源为本人客户 / 订单的风险（持风险写权限的主管、财务等不受此限）；
 *   低风险（提示 / 警告）由处理人直接关闭；高风险（严重，含来源预警升级后的当前等级）的关闭、豁免、带风险放行
 *   只能提交申请，由申请人所在部门主管在统一审批中答复，结果写回原风险。审批人由服务端按部门路由确定，不能自审。
 */
import { MistCommandError, isActiveMistInvoice, type MistContext, type MistState } from './mistWorkspace';
import { supplierStatusOn } from './mistSupplierStatus';
import type { MistReviewTask } from './mistReview';

export type RiskType = 'credit' | 'fx' | 'compliance' | 'quality' | 'delivery' | 'other';
export type RiskSourceKind = 'order' | 'invoice' | 'customer' | 'supplier' | 'production' | 'relation';
export type RiskState = 'Open' | 'Acknowledged' | 'InProgress' | 'Escalated' | 'Resolved';
/** 申请动作：关闭 / 豁免 / 带风险放行 / 其他受控授权（原“升级”语义，如额外费用）。 */
export type RiskRequestAction = 'close' | 'waive' | 'release' | 'authorize';
/**
 * 处置申请：带 requesterId / reviewerIds / snapshot，进入统一审批，审批人由服务端按部门主管路由冻结。
 */
export type RiskEscalation = {
  id: string; approver: string; reason: string; requestedBy: string; requestedAt: string; decision: 'pending' | 'approved' | 'rejected' | 'withdrawn'; decisionNote: string; decidedBy: string; decidedAt: string;
  action?: RiskRequestAction; requesterId?: string; reviewerIds?: string[]; level?: 'info' | 'warning' | 'critical'; snapshot?: Array<{ label: string; value: string }>; decidedById?: string;
};
export type RiskRecord = {
  id: string; orderId: string; title: string; level: 'info' | 'warning' | 'critical'; basis: string; owner: string; state: RiskState; resolution: string; createdAt: string;
  type?: RiskType; source?: { kind: RiskSourceKind; id: string; label: string }; signalKey?: string; createdBy?: string;
  acknowledgedAt?: string; plan?: string; planDue?: string; escalations?: RiskEscalation[]; closedAt?: string; closedBy?: string; updatedAt?: string;
  /** 关闭方式：经审批关闭 / 豁免；直接关闭的低风险与早期记录不写。 */
  disposition?: 'closed' | 'waived';
  /** 最近一次获批的带风险放行：风险仍未关闭，继续跟进。 */
  release?: { escalationId: string; approvedBy: string; at: string; note: string };
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
export const RISK_ACTION_LABEL: Record<RiskRequestAction, string> = { close: '关闭', waive: '豁免', release: '带风险放行', authorize: '其他受控授权' };
export const RISK_ACTIONS: RiskRequestAction[] = ['close', 'waive', 'release', 'authorize'];
const RISK_LEVEL_LABEL: Record<RiskRecord['level'], string> = { critical: '严重', warning: '警告', info: '提示' };
const LEVEL_RANK: Record<RiskRecord['level'], number> = { critical: 0, warning: 1, info: 2 };
/** 高风险 = 严重。提示 / 警告为低风险，由处理人直接关闭。 */
export function isHighRisk(level: RiskRecord['level']) { return level === 'critical'; }
/** 新申请走统一审批；早期自由填写审批人的升级仍按原规则答复。 */
export function isReviewedEscalation(e: RiskEscalation) { return !!e.requesterId && Array.isArray(e.reviewerIds) && e.reviewerIds.length > 0; }
/** 上海业务日（与平台业务日同口径；此处不反向引用平台模块）。 */
export function riskBusinessDay(instant: string | Date) { const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant)); const get = (k: string) => parts.find(p => p.type === k)!.value; return get('year') + '-' + get('month') + '-' + get('day'); }
/** 当前等级：登记等级与来源预警的当前等级取更严重者（例如逾期从 20 天变为 31 天，警告升为严重），不能靠旧等级绕过审批。 */
export function riskEffectiveLevel(state: MistState | null, r: RiskRecord, day: string): RiskRecord['level'] {
  if (!r.signalKey || r.state === 'Resolved') return r.level;
  const live = riskSignals(state, day).find(s => s.key === r.signalKey);
  return live && LEVEL_RANK[live.level] < LEVEL_RANK[r.level] ? live.level : r.level;
}
/**
 * 来源记录的业务负责人：订单 / 发票 / 生产分支取所属订单负责人；客户取客户负责人；组织取所关联客户的负责人；
 * 供应商没有客户主线负责人。domain 指业务员处理该风险还需持有的现有岗位写权限（订单写 / 客户档案写）。
 */
export type RiskBusinessOwner = { owner: string; /** 负责人的稳定账号；旧资料或指派给他人时为空，不能按姓名认定本人。 */ ownerId: string; domain: 'orders' | 'customers' | null };
export function riskBusinessOwner(state: MistState | null, kind: RiskSourceKind, id: string): RiskBusinessOwner {
  const none = { owner: '', ownerId: '' };
  if (!state) return { ...none, domain: null };
  const of = (row?: { owner: string; ownerId?: string }) => row ? { owner: row.owner || '', ownerId: row.ownerId || '' } : none;
  const order = (orderId: string) => of(state.orders.find(o => o.id === orderId));
  const customer = (customerId: string) => of(state.customers.find(c => c.id === customerId));
  switch (kind) {
    case 'order': return { ...order(id), domain: 'orders' };
    case 'invoice': { const i = state.invoices.find(x => x.id === id); return { ...(i ? order(i.orderId) : none), domain: 'orders' }; }
    case 'production': { const p = state.productions.find(x => x.id === id); return { ...(p ? order(p.orderId) : none), domain: 'orders' }; }
    case 'customer': return { ...customer(id), domain: 'customers' };
    case 'relation': { const r = (state.market?.relations || []).find(x => x.id === id); return { ...(r?.customerId ? customer(r.customerId) : none), domain: 'customers' }; }
    default: return { ...none, domain: null };
  }
}
/**
 * 业务员处理本人来源风险的判定（服务端与界面共用）：来源负责人须已绑定账号且就是当前账号，并持有对应现有写权限。
 * 只比对稳定账号，不比对显示姓名；负责人未绑定账号（旧资料、指派给他人）时明确拒绝，由持风险处理权限的同事办理。
 */
export function riskOwnRefusal(b: RiskBusinessOwner, actorId: string | undefined, rights: { orders: boolean; customers: boolean }): string | false {
  if (!b.domain) return '此来源没有客户或订单负责人，请交持风险处理权限的同事处理';
  if (!b.owner) return '来源记录未指定负责人，请交持风险处理权限的同事处理';
  if (!b.ownerId) return `来源负责人（${b.owner}）尚未绑定账号，无法确认是否为本人；请交持风险处理权限的同事处理，或由负责人本人重新确认订单 / 客户负责人`;
  if (!actorId || b.ownerId !== actorId) return `只有来源负责人（${b.owner}）本人或持风险处理权限的同事可以处理`;
  if (!(b.domain === 'orders' ? rights.orders : rights.customers)) return b.domain === 'orders' ? '需要订单写权限' : '需要客户档案写权限';
  return false;
}

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
    out.push({ key: 'relation-hold:' + r.id, type: 'credit', level: 'warning', title: `${r.name} 往来已冻结`, basis: `冻结原因：${r.hold.reason}（${r.hold.actor} · ${riskBusinessDay(r.hold.at)}）。新报价、订单与采购会被拦截，已有业务需逐项确认。`, source: { kind: 'relation', id: r.id, label: r.name }, orderId: '', since: riskBusinessDay(r.hold.at) });
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
/** 处理权：持风险写权限者（主管、财务等）不限来源；其他账号只能处理来源为本人客户 / 订单、且持有对应现有写权限的风险。 */
function handleRefusal(root: MistState, c: MistContext, kind: RiskSourceKind, id: string): string | false {
  const a = c.authority?.risk; if (!a) return '当前账号没有风险处理权限'; if (a.all) return false;
  return riskOwnRefusal(riskBusinessOwner(root, kind, id), c.actorId, a);
}
function assertHandle(root: MistState, c: MistContext, row: RiskRecord) {
  const src = riskSource(root, row), why = src ? handleRefusal(root, c, src.kind, src.id) : '风险来源未记录';
  if (why) fail('只能处理本人负责的客户或订单上的风险；其他风险由其负责人或持风险处理权限的同事办理。' + why, 'FORBIDDEN');
}
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
  | { type: 'platform.risk.escalate'; payload: { id: string; action: RiskRequestAction; reason: string } }
  | { type: 'platform.risk.withdraw'; payload: { id: string; escalationId: string; reason?: string } }
  | { type: 'platform.risk.decide'; payload: { id: string; escalationId: string; decision: 'approved' | 'rejected'; note: string } };

/**
 * 入口门槛：答复只经统一审批中心（审批人需 risk:write，按冻结的部门主管核验），直接命令须 risk:admin 作为兜底门槛；
 * 其余命令以风险读权限进入，再在命令内按来源负责人与服务端重建的岗位权限核验处理权。
 */
export function riskCommandPermission(command: RiskCommand) { return command.type === 'platform.risk.decide' ? 'risk:admin' : 'risk:read'; }
export const RISK_REVIEW_PERMISSION = 'risk:write';

/** 统一审批：只给提交时冻结的申请快照；撤回的申请不再出现。 */
export function getRiskReviews(root: MistState): MistReviewTask[] {
  return (root.platform?.risks || []).flatMap(r => (r.escalations || []).filter(e => isReviewedEscalation(e) && e.decision !== 'withdrawn').map(e => ({
    id: 'risk:' + e.id, kind: 'risk' as const, entityId: e.id, title: `风险${RISK_ACTION_LABEL[e.action || 'authorize']}审批 · ${r.title}`,
    requesterId: e.requesterId!, reviewerIds: [...e.reviewerIds!], status: e.decision as 'pending' | 'approved' | 'rejected', submittedAt: e.requestedAt,
    requiredPermission: RISK_REVIEW_PERMISSION, target: { view: 'risks', id: r.id }, details: (e.snapshot || []).map(d => ({ ...d })),
  })));
}

export function applyRiskCommand(root: MistState, risks: RiskRecord[], command: RiskCommand, c: MistContext): { id: string } {
  const v: any = command.payload;
  switch (command.type) {
    case 'platform.risk.save': {
      const level = ['info', 'warning', 'critical'].includes(v.level) ? v.level : fail('风险级别无效');
      const type: RiskType = v.type === undefined ? 'other' : RISK_TYPES.includes(v.type) ? v.type : fail('风险类型无效');
      let src: RiskRecord['source'], orderId = '';
      if (v.source) { if (!RISK_SOURCE_KINDS.includes(v.source.kind)) fail('来源类型无效'); const s = sourceOf(root, v.source.kind, text(v.source.id, '来源')); src = { kind: v.source.kind, id: v.source.id, label: s.label }; orderId = s.orderId; }
      else { if (!v.orderId) fail('请选择风险来源记录'); sourceOf(root, 'order', text(v.orderId, '来源订单')); orderId = v.orderId; }
      const kind: RiskSourceKind = src ? src.kind : 'order', sourceId = src ? src.id : orderId;
      const why = handleRefusal(root, c, kind, sourceId);
      if (why) fail('只能登记本人负责的客户或订单上的风险；其他来源请交其负责人或持风险处理权限的同事登记。' + why, 'FORBIDDEN');
      const owner = text(v.owner, '负责人', true, 100);
      if (!c.authority?.risk?.all && owner !== c.actorName) fail('登记本人客户或订单的风险时，负责人须为本人；需要交给他人请由主管转交', 'FORBIDDEN');
      const signalKey = v.signalKey === undefined ? undefined : text(v.signalKey, '预警标识', true, 200);
      if (signalKey) { const dup = risks.find(r => r.signalKey === signalKey && r.state !== 'Resolved'); if (dup) fail(`这条预警已登记为「${dup.title}」（${LABEL[dup.state]}），请在原风险继续处理`, 'CONFLICT'); }
      if (signalKey) {
        // 预警仍存在时，以服务端当前推导为准：来源必须一致，等级不能低于预警等级（防止把严重预警登记成低风险绕过审批）。
        const live = riskSignals(root, riskBusinessDay(c.now)).find(x => x.key === signalKey);
        if (live && (live.source.kind !== kind || live.source.id !== sourceId)) fail('预警来源与登记来源不一致，请从预警重新登记', 'CONFLICT');
        if (live && LEVEL_RANK[level as RiskRecord['level']] > LEVEL_RANK[live.level]) fail(`风险等级不能低于预警等级（${RISK_LEVEL_LABEL[live.level]}）`);
      }
      const row: RiskRecord = { id: c.id(), orderId, title: text(v.title, '风险标题', true, 200), basis: text(v.basis, '风险依据'), owner, level, state: 'Open', resolution: '', createdAt: c.now, type, source: src, signalKey, createdBy: c.actorName, escalations: [], updatedAt: c.now };
      risks.unshift(row); emit(root, c, row.id, `登记风险 ${row.title} · 负责人 ${row.owner}`); return { id: row.id };
    }
    case 'platform.risk.transition': {
      const row = find(risks, v.id);
      if (!['Acknowledged', 'Resolved'].includes(v.state)) fail('状态无效');
      if (row.state === 'Resolved') fail('风险已关闭', 'CONFLICT');
      assertHandle(root, c, row);
      if (v.state === 'Acknowledged') {
        if (row.state !== 'Open') fail('风险已被接手', 'CONFLICT');
        const note = text(v.resolution, '接手说明', false);
        row.state = 'Acknowledged'; row.acknowledgedAt = c.now; if (row.owner !== c.actorName) { emit(root, c, row.id, `负责人由 ${row.owner} 变更为 ${c.actorName}`); row.owner = c.actorName; }
        row.updatedAt = c.now; emit(root, c, row.id, '接手风险' + (note ? '：' + note : '')); return { id: row.id };
      }
      if (row.state === 'Open') fail('请先确认接手风险，再记录关闭依据');
      if (pendingEscalation(row)) fail('升级审批尚未答复，不能关闭', 'CONFLICT');
      const now = riskEffectiveLevel(root, row, riskBusinessDay(c.now));
      if (isHighRisk(now)) fail(`当前为高风险（${RISK_LEVEL_LABEL[now]}），关闭须提交申请，由部门主管审批`, 'PRECONDITION');
      row.state = 'Resolved'; row.resolution = text(v.resolution, '关闭依据'); row.closedAt = c.now; row.closedBy = c.actorName; row.updatedAt = c.now;
      emit(root, c, row.id, '关闭风险：' + row.resolution); return { id: row.id };
    }
    case 'platform.risk.plan': {
      const row = find(risks, v.id);
      assertHandle(root, c, row);
      if (row.state === 'Open') fail('请先接手风险');
      if (row.state === 'Resolved') fail('风险已关闭', 'CONFLICT');
      if (row.state === 'Escalated') fail('升级审批中，答复后再调整处置方案', 'CONFLICT');
      const before = row.plan; row.plan = text(v.plan, '处置方案'); row.planDue = optionalDay(v.planDue, '计划完成日'); row.state = 'InProgress'; row.updatedAt = c.now;
      emit(root, c, row.id, (before ? '更新处置方案：' : '制定处置方案：') + row.plan + (row.planDue ? `（计划 ${row.planDue} 完成）` : '')); return { id: row.id };
    }
    case 'platform.risk.escalate': {
      const row = find(risks, v.id);
      assertHandle(root, c, row);
      if (row.state !== 'InProgress') fail(row.state === 'Escalated' ? '已在升级审批中' : '先制定处置方案，再申请升级', 'CONFLICT');
      if (v.approver !== undefined || v.reviewerIds !== undefined) fail('审批人由系统按申请人所在部门主管确定，不能在申请中指定', 'FORBIDDEN');
      const action: RiskRequestAction = RISK_ACTIONS.includes(v.action) ? v.action : fail('请选择申请事项');
      if (!c.actorId) fail('无法识别申请人', 'FORBIDDEN');
      const reviewerIds = [...new Set((c.authority?.riskReviewerIds || []).filter(id => typeof id === 'string' && id && id !== c.actorId))];
      if (!reviewerIds.length) fail('当前没有可审批风险的部门主管，请联系管理员配置部门主管', 'PRECONDITION');
      const reason = text(v.reason, action === 'close' ? '关闭依据' : action === 'waive' ? '豁免理由' : action === 'release' ? '放行理由与范围' : '申请理由');
      const level = riskEffectiveLevel(root, row, riskBusinessDay(c.now)), src = riskSource(root, row);
      const snapshot = [
        { label: '申请事项', value: RISK_ACTION_LABEL[action] }, { label: '风险', value: row.title }, { label: '当前等级', value: RISK_LEVEL_LABEL[level] + (isHighRisk(level) ? '（高风险）' : '') },
        { label: '来源', value: src ? src.label : '未记录' }, { label: '负责人', value: row.owner }, { label: '事实与依据', value: row.basis },
        { label: '处置方案', value: row.plan ? row.plan + (row.planDue ? `（计划 ${row.planDue}）` : '') : '未制定' }, { label: action === 'close' ? '关闭依据' : '申请理由', value: reason },
      ];
      const e: RiskEscalation = { id: c.id(), approver: '部门主管', reason, requestedBy: c.actorName, requestedAt: c.now, decision: 'pending', decisionNote: '', decidedBy: '', decidedAt: '', action, requesterId: c.actorId, reviewerIds, level, snapshot };
      row.escalations = [...(row.escalations || []), e]; row.state = 'Escalated'; row.updatedAt = c.now;
      emit(root, c, row.id, `申请${RISK_ACTION_LABEL[action]}，待部门主管审批：${reason}`); return { id: row.id };
    }
    case 'platform.risk.withdraw': {
      const row = find(risks, v.id), e = pendingEscalation(row);
      if (!e || e.id !== v.escalationId) fail('这次申请已答复或已变化，请刷新后查看', 'CONFLICT');
      if (!(e!.requesterId ? e!.requesterId === c.actorId : e!.requestedBy === c.actorName)) fail('只有申请人可以撤回申请', 'FORBIDDEN');
      const reason = text(v.reason ?? '', '撤回原因', false, 500);
      e!.decision = 'withdrawn'; e!.decisionNote = reason; e!.decidedBy = c.actorName; e!.decidedById = c.actorId; e!.decidedAt = c.now; row.state = 'InProgress'; row.updatedAt = c.now;
      for (const t of root.tasks) if (t.kind === 'risk-escalation:' + e!.id) t.done = true;
      emit(root, c, row.id, `撤回${RISK_ACTION_LABEL[e!.action || 'authorize']}申请${reason ? '：' + reason : ''}`); return { id: row.id };
    }
    case 'platform.risk.decide': {
      const row = find(risks, v.id), e = pendingEscalation(row);
      if (!e || e.id !== v.escalationId) fail('这次升级已答复或已变化，请刷新后查看', 'CONFLICT');
      if (!['approved', 'rejected'].includes(v.decision)) fail('审批结果无效');
      if (!isReviewedEscalation(e!)) fail('这次申请缺少系统确定的审批主管，请撤回后重新申请', 'CONFLICT');
      // 只认提交时冻结、且此刻仍按申请人部门路由有效的主管；无法换审批人或自审。
      if (!c.actorId || c.actorId === e!.requesterId || !e!.reviewerIds!.includes(c.actorId) || !(c.authority?.riskReviewerIds || []).includes(c.actorId)) fail('当前账号不是本次风险申请的有效审批主管', 'FORBIDDEN');
      const note = text(v.note, '审批意见'), action = e!.action || 'authorize', approved = v.decision === 'approved';
      e!.decision = v.decision; e!.decisionNote = note; e!.decidedBy = c.actorName; e!.decidedById = c.actorId; e!.decidedAt = c.now; row.state = 'InProgress'; row.updatedAt = c.now;
      if (approved && (action === 'close' || action === 'waive')) { row.state = 'Resolved'; row.disposition = action === 'close' ? 'closed' : 'waived'; row.resolution = (action === 'waive' ? '豁免：' : '') + e!.reason; row.closedAt = c.now; row.closedBy = e!.requestedBy; }
      if (approved && action === 'release') row.release = { escalationId: e!.id, approvedBy: c.actorName, at: c.now, note };
      for (const t of root.tasks) if (t.kind === 'risk-escalation:' + e!.id) t.done = true;
      const label = `${RISK_ACTION_LABEL[action]}申请${approved ? '已批准' : '已驳回，继续按原规则处理'}`;
      root.notifications.unshift({ id: c.id(), title: `${row.title} · ${label}`, detail: `${c.actorName}：${note}`, at: c.now, readAt: null, target: { view: 'risks', id: row.id }, category: 'general' });
      const text2 = `${approved ? '批准' : '驳回'}${RISK_ACTION_LABEL[action]}申请${approved && row.state === 'Resolved' ? '（风险已' + (action === 'waive' ? '豁免关闭' : '关闭') + '）' : approved && action === 'release' ? '（带风险放行，风险继续跟进）' : ''}：${note}`;
      emit(root, c, row.id, text2); return { id: row.id };
    }
  }
  return fail('未知风险操作');
}
