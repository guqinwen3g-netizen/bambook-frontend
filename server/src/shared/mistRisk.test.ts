import { describe, it, expect } from 'vitest';
import { applyMistCommand, createMistState, type MistContext, type MistState } from './mistWorkspace';
import { riskSignals, pendingEscalation, getRiskReviews, riskEffectiveLevel } from './mistRisk';
import { platformCommandPermission } from './mistPlatform';
import { platformBusinessDate } from './mistPlatform';

type Access = { all?: boolean; orders?: boolean; customers?: boolean; reviewers?: string[] };
/** 默认是持风险写权限的处理人（主管 / 财务）；业务员用 all:false 并只给订单 / 客户写权限。 */
function ctx(actorName = '顾言', now = '2026-10-14T02:00:00.000Z', access: Access = {}): MistContext {
  let n = 0;
  return { id: () => `risk-${actorName}-${++n}`, now, actorName, actorId: 'id-' + actorName, authority: { supplier: {}, risk: { all: access.all ?? true, orders: access.orders ?? true, customers: access.customers ?? true }, riskReviewerIds: access.reviewers ?? ['id-周经理'] } } as MistContext;
}
const sales = (name: string, access: Access = {}) => ctx(name, undefined, { all: false, orders: true, customers: true, ...access });
const run = (s: MistState, command: any, c: MistContext) => applyMistCommand(s, command, c);
function demo() { const c = ctx(); return { c, state: createMistState(c, 'demo'), day: platformBusinessDate(c.now) }; }

describe('风险预警只从真实记录推出', () => {
  it('演示空间：逾期应收、往来冻结、认证过期都能识别，且不改来源记录', () => {
    const { state, day } = demo(); const before = JSON.stringify(state);
    const s = riskSignals(state, day);
    expect(s.some(x => x.type === 'credit' && x.source.kind === 'relation')).toBe(true);
    expect(s.some(x => x.type === 'compliance' && x.key.startsWith('cert-expired:'))).toBe(true);
    expect(new Set(s.map(x => x.key)).size).toBe(s.length);
    expect(JSON.stringify(state)).toBe(before);
  });
  it('发票逾期按原币写依据，超过 30 天为严重', () => {
    const { state } = demo(); const inv = state.invoices.find(i => i.open > 0)!; expect(inv).toBeTruthy();
    inv.due = '2026-09-01';
    const sig = riskSignals(state, '2026-10-14').find(x => x.key === 'invoice-overdue:' + inv.id)!;
    expect(sig.level).toBe('critical'); expect(sig.basis).toContain(inv.currency); expect(sig.orderId).toBe(inv.orderId);
    inv.open = 0; expect(riskSignals(state, '2026-10-14').some(x => x.key === 'invoice-overdue:' + inv.id)).toBe(false);
  });
});

describe('风险登记与处理闭环', () => {
  it('同一预警只允许一条未关闭风险；关闭后可再次登记', () => {
    const { state, c, day } = demo(); const sig = riskSignals(state, day).find(x => x.level !== 'critical' && !state.platform!.risks.some(r => r.signalKey === x.key))!;
    const save = { type: 'platform.risk.save', payload: { title: sig.title, level: sig.level, basis: sig.basis, owner: '顾言', type: sig.type, source: { kind: sig.source.kind, id: sig.source.id }, signalKey: sig.key } };
    const a = run(state, save, c); const id = a.result.id!;
    const row = a.state.platform!.risks.find(r => r.id === id)!;
    expect(row.source?.label).toBe(sig.source.label); expect(row.orderId).toBe(sig.orderId); expect(row.state).toBe('Open');
    expect(() => run(a.state, save, c)).toThrow(/已登记/);
    let s = run(a.state, { type: 'platform.risk.transition', payload: { id, state: 'Acknowledged', resolution: '' } }, c).state;
    s = run(s, { type: 'platform.risk.transition', payload: { id, state: 'Resolved', resolution: '客户已付款，银行水单已核对' } }, c).state;
    expect(s.platform!.risks.find(r => r.id === id)!.closedBy).toBe('顾言');
    expect(() => run(s, save, c)).not.toThrow();
  });
});

/** 演示订单：负责人即业务员；另一位业务员不负责该订单。 */
/** 合成订单：负责人已绑定稳定账号（服务端在负责人本人建单 / 改为本人时绑定，见 bindSourceOwners）。 */
function owned() {
  const { state } = demo(); const order = state.orders.find(o => o.owner)!; const owner = order.owner, other = '另一业务员';
  expect(order).toBeTruthy(); expect(state.orders.some(o => o.owner === other)).toBe(false);
  order.ownerId = 'id-' + owner;
  return { state, order, owner, other };
}
const save = (orderId: string, owner: string, level = 'warning') => ({ type: 'platform.risk.save', payload: { orderId, title: level === 'critical' ? '尾款逾期严重' : '交期风险', level, basis: '厂方回复延误', owner, type: 'delivery' } });
function inProgress(s: MistState, id: string, c: MistContext) {
  s = run(s, { type: 'platform.risk.transition', payload: { id, state: 'Acknowledged', resolution: '我来跟' } }, c).state;
  return run(s, { type: 'platform.risk.plan', payload: { id, plan: '与客户确认付款计划', planDue: '2026-10-20' } }, c).state;
}

describe('风险分级权限：业务员只管理本人客户 / 订单的风险', () => {
  it('业务员可登记、接手、推进并直接关闭本人订单的低风险', () => {
    const { state, order, owner } = owned(), me = sales(owner);
    let s = run(state, save(order.id, owner), me).state; const id = s.platform!.risks[0].id;
    s = inProgress(s, id, me);
    s = run(s, { type: 'platform.risk.transition', payload: { id, state: 'Resolved', resolution: '工厂加班追回交期，客户确认' } }, me).state;
    expect(s.platform!.risks[0]).toMatchObject({ state: 'Resolved', closedBy: owner }); expect(s.platform!.risks[0].disposition).toBeUndefined();
  });
  it('他人订单、缺少订单写权限、指定他人为负责人、无客户主线的供应商来源，都在服务端拒绝', () => {
    const { state, order, owner, other } = owned();
    expect(() => run(state, save(order.id, other), sales(other))).toThrow(/本人负责/);
    expect(() => run(state, save(order.id, owner), sales(owner, { orders: false }))).toThrow(/本人负责/);
    expect(() => run(state, save(order.id, other), sales(owner))).toThrow(/负责人须为本人/);
    const supplier = state.market!.suppliers[0];
    expect(() => run(state, { type: 'platform.risk.save', payload: { title: '供应商认证', level: 'warning', basis: 'x', owner, source: { kind: 'supplier', id: supplier.id } } }, sales(owner))).toThrow(/本人负责/);
    // 主管登记后，他人不能接手抢走、推进或关闭本人以外订单的风险。
    let s = run(state, save(order.id, owner), ctx('周经理')).state; const id = s.platform!.risks[0].id;
    for (const cmd of [{ type: 'platform.risk.transition', payload: { id, state: 'Acknowledged', resolution: '' } }, { type: 'platform.risk.plan', payload: { id, plan: 'x' } }]) expect(() => run(s, cmd, sales(other))).toThrow(/本人负责/);
    s = inProgress(s, id, sales(owner));
    for (const cmd of [{ type: 'platform.risk.transition', payload: { id, state: 'Resolved', resolution: 'x' } }, { type: 'platform.risk.escalate', payload: { id, action: 'waive', reason: 'x' } }]) expect(() => run(s, cmd, sales(other))).toThrow(/本人负责/);
    expect(s.platform!.risks[0].owner).toBe(owner);
  });
  it('客户来源按客户负责人判断，需要客户档案写权限', () => {
    const { state } = demo(); const cu = state.customers.find(x => x.owner)!; cu.ownerId = 'id-' + cu.owner;
    const cmd = { type: 'platform.risk.save', payload: { title: '客户信用', level: 'warning', basis: 'x', owner: cu.owner, type: 'credit', source: { kind: 'customer', id: cu.id } } };
    expect(run(state, cmd, sales(cu.owner)).state.platform!.risks[0].source).toMatchObject({ kind: 'customer', id: cu.id });
    expect(() => run(state, cmd, sales(cu.owner, { customers: false }))).toThrow(/本人负责/);
  });
});

describe('高风险关闭、豁免、带风险放行走部门主管审批，结果回到原风险', () => {
  const setup = () => { const { state, order, owner } = owned(), me = sales(owner); let s = run(state, save(order.id, owner, 'critical'), me).state; const id = s.platform!.risks[0].id; s = inProgress(s, id, me); return { s, id, me, owner }; };
  it('高风险不能直接关闭（业务员和主管都不行），申请不能指定审批人、不能没有主管、不能自审', () => {
    const { s, id, me } = setup();
    expect(() => run(s, { type: 'platform.risk.transition', payload: { id, state: 'Resolved', resolution: 'x' } }, me)).toThrow(/高风险/);
    expect(() => run(s, { type: 'platform.risk.transition', payload: { id, state: 'Resolved', resolution: 'x' } }, ctx('周经理'))).toThrow(/高风险/);
    expect(() => run(s, { type: 'platform.risk.escalate', payload: { id, action: 'close', reason: 'x', approver: '好说话的同事' } }, me)).toThrow(/不能在申请中指定/);
    expect(() => run(s, { type: 'platform.risk.escalate', payload: { id, action: 'close', reason: 'x', reviewerIds: ['id-x'] } }, me)).toThrow(/不能在申请中指定/);
    expect(() => run(s, { type: 'platform.risk.escalate', payload: { id, action: 'nope', reason: 'x' } }, me)).toThrow(/申请事项/);
    expect(() => run(s, { type: 'platform.risk.escalate', payload: { id, action: 'close', reason: 'x' } }, sales(me.actorName, { reviewers: [] }))).toThrow(/没有可审批/);
    expect(() => run(s, { type: 'platform.risk.escalate', payload: { id, action: 'close', reason: 'x' } }, sales(me.actorName, { reviewers: [me.actorId!] }))).toThrow(/没有可审批/);
  });
  it('关闭申请：统一审批任务冻结快照；申请人、非审批人、已失效主管都不能答复；批准后原风险关闭', () => {
    const { s: s0, id, me, owner } = setup();
    const s = run(s0, { type: 'platform.risk.escalate', payload: { id, action: 'close', reason: '客户已付清，银行水单已核对' } }, me).state;
    const e = pendingEscalation(s.platform!.risks[0])!; expect(e).toMatchObject({ action: 'close', requesterId: me.actorId, reviewerIds: ['id-周经理'], level: 'critical' });
    const [task] = getRiskReviews(s).filter(t => t.target.id === id);
    expect(task).toMatchObject({ id: 'risk:' + e.id, kind: 'risk', entityId: e.id, requesterId: me.actorId, reviewerIds: ['id-周经理'], status: 'pending', requiredPermission: 'risk:write', target: { view: 'risks', id } });
    expect(task.details.find(d => d.label === '关闭依据')!.value).toBe('客户已付清，银行水单已核对');
    expect(task.details.find(d => d.label === '当前等级')!.value).toContain('高风险');
    expect(() => run(s, { type: 'platform.risk.transition', payload: { id, state: 'Resolved', resolution: 'x' } }, me)).toThrow(/尚未答复/);
    const decide = { type: 'platform.risk.decide', payload: { id, escalationId: e.id, decision: 'approved', note: '核对水单无误' } };
    expect(() => run(s, decide, me)).toThrow(/有效审批主管/);
    expect(() => run(s, decide, ctx('旁观主管'))).toThrow(/有效审批主管/);
    expect(() => run(s, decide, ctx('周经理', undefined, { reviewers: ['id-新主管'] }))).toThrow(/有效审批主管/);
    const after = run(s, decide, ctx('周经理')).state, r = after.platform!.risks[0];
    expect(r).toMatchObject({ state: 'Resolved', disposition: 'closed', resolution: '客户已付清，银行水单已核对', closedBy: owner });
    expect(r.escalations![0]).toMatchObject({ decision: 'approved', decidedBy: '周经理', decidedById: 'id-周经理' });
    expect(getRiskReviews(after).find(t => t.target.id === id)!.status).toBe('approved');
    expect(after.notifications[0]).toMatchObject({ target: { view: 'risks', id } }); expect(after.notifications[0].title).toContain('关闭申请已批准');
    expect(() => run(after, decide, ctx('周经理'))).toThrow(/已答复/);
  });
  it('豁免批准后以“豁免”关闭；带风险放行批准后风险仍在跟进；驳回回到处理中可再申请', () => {
    const boss = ctx('周经理');
    { const { s: s0, id, me } = setup(); const s = run(s0, { type: 'platform.risk.escalate', payload: { id, action: 'waive', reason: '客户为长期合作方，已签分期协议' } }, me).state; const e = pendingEscalation(s.platform!.risks[0])!;
      const r = run(s, { type: 'platform.risk.decide', payload: { id, escalationId: e.id, decision: 'approved', note: '同意豁免' } }, boss).state.platform!.risks[0];
      expect(r).toMatchObject({ state: 'Resolved', disposition: 'waived' }); expect(r.resolution).toContain('豁免'); }
    { const { s: s0, id, me } = setup(); const s = run(s0, { type: 'platform.risk.escalate', payload: { id, action: 'release', reason: '收到首期后放行一票已备货出运' } }, me).state; const e = pendingEscalation(s.platform!.risks[0])!;
      const after = run(s, { type: 'platform.risk.decide', payload: { id, escalationId: e.id, decision: 'approved', note: '只放行这一票' } }, boss).state, r = after.platform!.risks[0];
      expect(r.state).toBe('InProgress'); expect(r.release).toMatchObject({ escalationId: e.id, approvedBy: '周经理', note: '只放行这一票' });
      expect(() => run(after, { type: 'platform.risk.transition', payload: { id, state: 'Resolved', resolution: 'x' } }, me)).toThrow(/高风险/);
      expect(after.orders).toEqual(s.orders); }
    { const { s: s0, id, me } = setup(); const s = run(s0, { type: 'platform.risk.escalate', payload: { id, action: 'close', reason: '证据不足' } }, me).state; const e = pendingEscalation(s.platform!.risks[0])!;
      const after = run(s, { type: 'platform.risk.decide', payload: { id, escalationId: e.id, decision: 'rejected', note: '未见银行水单' } }, boss).state;
      expect(after.platform!.risks[0].state).toBe('InProgress'); expect(after.notifications[0].title).toContain('已驳回');
      expect(() => run(after, { type: 'platform.risk.escalate', payload: { id, action: 'close', reason: '已补水单' } }, me)).not.toThrow(); }
  });
  it('申请人可撤回待审批申请，撤回后不再出现在统一审批；他人不能撤回', () => {
    const { s: s0, id, me } = setup(); const s = run(s0, { type: 'platform.risk.escalate', payload: { id, action: 'waive', reason: 'x' } }, me).state; const e = pendingEscalation(s.platform!.risks[0])!;
    expect(() => run(s, { type: 'platform.risk.withdraw', payload: { id, escalationId: e.id } }, ctx('周经理'))).toThrow(/只有申请人/);
    const after = run(s, { type: 'platform.risk.withdraw', payload: { id, escalationId: e.id, reason: '客户已付款，改为直接处理' } }, me).state;
    expect(after.platform!.risks[0].state).toBe('InProgress'); expect(getRiskReviews(after).filter(t => t.target.id === id)).toEqual([]);
    expect(() => run(after, { type: 'platform.risk.decide', payload: { id, escalationId: e.id, decision: 'approved', note: 'x' } }, ctx('周经理'))).toThrow(/已答复/);
  });
  it('预警等级不能被调低；来源预警升为严重后按高风险处理', () => {
    const { state, c, day } = demo(); const inv = state.invoices.find(i => i.open > 0 && i.orderId)!; inv.due = '2026-09-20';
    const sig = riskSignals(state, day).find(x => x.key === 'invoice-overdue:' + inv.id)!; expect(sig.level).toBe('warning');
    const reg = (level: string) => ({ type: 'platform.risk.save', payload: { title: sig.title, level, basis: sig.basis, owner: '顾言', type: sig.type, source: { kind: sig.source.kind, id: sig.source.id }, signalKey: sig.key } });
    expect(() => run(state, reg('info'), c)).toThrow(/不能低于预警等级/);
    expect(() => run(state, { ...reg('warning'), payload: { ...reg('warning').payload, source: { kind: 'order', id: inv.orderId } } }, c)).toThrow(/来源不一致/);
    let s = run(state, reg('warning'), c).state; const id = s.platform!.risks[0].id; s = inProgress(s, id, c);
    s.invoices.find(i => i.id === inv.id)!.due = '2026-09-01';
    expect(riskEffectiveLevel(s, s.platform!.risks[0], day)).toBe('critical');
    expect(() => run(s, { type: 'platform.risk.transition', payload: { id, state: 'Resolved', resolution: 'x' } }, c)).toThrow(/高风险/);
  });
  it('缺少系统审批主管的升级不能答复；新建升级不接受自由填写审批人', () => {
    const { state, order, owner } = owned(), boss = ctx('周经理');
    let s = run(state, save(order.id, owner), boss).state; const id = s.platform!.risks[0].id; s = inProgress(s, id, boss);
    const bare = structuredClone(s); const row = bare.platform!.risks[0];
    row.state = 'Escalated'; row.escalations = [{ id: 'bare-e', approver: '周经理', reason: '空运费超预算', requestedBy: '顾言', requestedAt: '2026-10-01T00:00:00.000Z', decision: 'pending', decisionNote: '', decidedBy: '', decidedAt: '' }];
    expect(getRiskReviews(bare).filter(t => t.target.id === id)).toEqual([]);
    expect(() => run(bare, { type: 'platform.risk.decide', payload: { id, escalationId: 'bare-e', decision: 'approved', note: '同意空运' } }, boss)).toThrow(/撤回后重新申请/);
    expect(() => run(s, { type: 'platform.risk.escalate', payload: { id, approver: '周经理', reason: 'x' } }, boss)).toThrow(/不能在申请中指定/);
  });
});

describe('权限', () => {
  it('直接答复命令须 risk:admin 兜底（正常经统一审批中心）；其余命令以风险读权限进入，处理权在命令内核验', () => {
    expect(platformCommandPermission({ type: 'platform.risk.decide', payload: { id: 'x', escalationId: 'e', decision: 'approved', note: 'n' } } as any)).toBe('risk:admin');
    for (const type of ['platform.risk.save', 'platform.risk.transition', 'platform.risk.plan', 'platform.risk.escalate', 'platform.risk.withdraw']) expect(platformCommandPermission({ type, payload: {} } as any)).toBe('risk:read');
  });
  it('没有服务端重建的处理权时一律拒绝', () => {
    const { state, order, owner } = owned(); const bare = { ...sales(owner), authority: { supplier: {} } } as MistContext;
    expect(() => run(state, save(order.id, owner), bare)).toThrow(/本人负责/);
  });
});

describe('来源负责人按稳定账号判断，不按显示姓名', () => {
  /** 与来源负责人同显示名、但是另一个账号；仅有订单写 / 客户档案写，没有风险写。 */
  const twin = (name: string, access: Access = {}) => ({ ...sales(name, access), actorId: 'id-twin-' + name });
  it('同名不同账号：登记、接手、方案、关闭、申请都在服务端拒绝；来源负责人本人仍可办理', () => {
    const { state, order, owner } = owned(), me = sales(owner), impostor = twin(owner);
    expect(impostor.actorName).toBe(me.actorName); expect(impostor.actorId).not.toBe(me.actorId);
    expect(() => run(state, save(order.id, owner), impostor)).toThrow(/本人负责/);
    let s = run(state, save(order.id, owner), ctx('周经理')).state; const id = s.platform!.risks[0].id;
    const tryAll = (st: MistState) => [
      { type: 'platform.risk.transition', payload: { id, state: 'Acknowledged', resolution: '' } },
      { type: 'platform.risk.plan', payload: { id, plan: 'x' } },
      { type: 'platform.risk.transition', payload: { id, state: 'Resolved', resolution: 'x' } },
      { type: 'platform.risk.escalate', payload: { id, action: 'waive', reason: 'x' } },
    ].forEach(cmd => expect(() => run(st, cmd, impostor)).toThrow(/本人负责/));
    tryAll(s);
    s = inProgress(s, id, me); tryAll(s);
    expect(s.platform!.risks[0]).toMatchObject({ owner, state: 'InProgress' });
    // 本人账号：低风险直接关闭不受影响。
    s = run(s, { type: 'platform.risk.transition', payload: { id, state: 'Resolved', resolution: '客户确认' } }, me).state;
    expect(s.platform!.risks[0]).toMatchObject({ state: 'Resolved', closedBy: owner });
  });
  it('同名不同账号不能撤回本人的审批申请；客户来源同样按账号判断', () => {
    const { state, order, owner } = owned(), me = sales(owner), impostor = twin(owner);
    let s = run(state, save(order.id, owner, 'critical'), me).state; const id = s.platform!.risks[0].id;
    s = inProgress(s, id, me); s = run(s, { type: 'platform.risk.escalate', payload: { id, action: 'close', reason: '已付清' } }, me).state;
    const escalationId = pendingEscalation(s.platform!.risks[0])!.id;
    expect(() => run(s, { type: 'platform.risk.withdraw', payload: { id, escalationId } }, impostor)).toThrow(/只有申请人/);
    const cu = state.customers.find(x => x.owner)!; cu.ownerId = 'id-' + cu.owner;
    const cmd = { type: 'platform.risk.save', payload: { title: '客户信用', level: 'warning', basis: 'x', owner: cu.owner, type: 'credit', source: { kind: 'customer', id: cu.id } } };
    expect(() => run(state, cmd, twin(cu.owner))).toThrow(/本人负责/);
    expect(run(state, cmd, sales(cu.owner)).state.platform!.risks[0].owner).toBe(cu.owner);
  });
  it('旧资料负责人未绑定账号：即使姓名一致也拒绝并说明原因，不按姓名猜测；持风险写权限的主管仍可办理', () => {
    const { state, order, owner } = owned(); delete order.ownerId;
    expect(() => run(state, save(order.id, owner), sales(owner))).toThrow(/尚未绑定账号/);
    expect(run(state, save(order.id, owner), ctx('周经理')).state.platform!.risks).toHaveLength(state.platform!.risks.length + 1);
  });
  it('失去来源写权限后，本人账号也被拒绝', () => {
    const { state, order, owner } = owned(), me = sales(owner);
    let s = run(state, save(order.id, owner), me).state; const id = s.platform!.risks[0].id;
    expect(() => run(s, { type: 'platform.risk.transition', payload: { id, state: 'Acknowledged', resolution: '' } }, sales(owner, { orders: false }))).toThrow(/需要订单写权限/);
    s = inProgress(s, id, me);
    expect(() => run(s, { type: 'platform.risk.plan', payload: { id, plan: 'y' } }, sales(owner, { orders: false }))).toThrow(/本人负责/);
  });
  it('负责人按账号 ID 选择：同名账号不会互相冒用；非成员 / 已停用被拒且数据不变；负责人不变的修改保留原账号', () => {
    const members = [
      { id: 'id-业务甲', name: '业务甲', active: true, groups: ['garment' as const] },
      { id: 'id-twin-业务甲', name: '业务甲', active: true, groups: [] },
      { id: 'id-业务乙', name: '业务乙', active: true, groups: [] },
      { id: 'id-离职', name: '离职', active: false, groups: [] },
    ];
    const withMembers = (c: MistContext): MistContext => ({ ...c, members });
    const c0 = ctx('顾言'), base = createMistState(c0, 'empty');
    const boss = withMembers(ctx('周经理')), me = withMembers(sales('业务甲')), impostor = withMembers(twin('业务甲'));
    let s = run(base, { type: 'market.customer.create', payload: { input: { name: '合成客户', country: '', city: '', industry: '', ownerId: 'id-业务甲', grade: '', currency: 'USD', terms: '', incoterm: '', categories: '', creditLimit: 0, since: '2026-10-14' } } }, me).state;
    const cu = s.customers.find(x => x.name === '合成客户')!; expect(cu).toMatchObject({ ownerId: 'id-业务甲', owner: '业务甲' });
    // 只给姓名文本不再被接受。
    expect(() => run(s, { type: 'market.customer.update', payload: { id: cu.id, patch: { owner: '业务乙' } as any } }, boss)).toThrow(/按账号选择/);
    // 非成员 / 已停用账号：服务端拒绝，数据不变。
    const before = JSON.stringify(s);
    expect(() => run(s, { type: 'market.customer.update', payload: { id: cu.id, patch: { ownerId: 'id-外人' } } }, boss)).toThrow(/须为本工作区的成员账号/);
    expect(() => run(s, { type: 'market.customer.update', payload: { id: cu.id, patch: { ownerId: 'id-离职' } } }, boss)).toThrow(/已停用/);
    expect(JSON.stringify(s)).toBe(before);
    // 改派给业务乙：写入账号与显示名快照，并留下“负责人：A→B”。
    s = run(s, { type: 'market.customer.update', payload: { id: cu.id, patch: { ownerId: 'id-业务乙' } } }, boss).state;
    expect(s.customers.find(x => x.id === cu.id)).toMatchObject({ ownerId: 'id-业务乙', owner: '业务乙' });
    expect(s.events.some(e => e.text.includes('负责人：业务甲→业务乙'))).toBe(true);
    // 同名的两个账号按 ID 区分。
    const t = run(s, { type: 'market.customer.update', payload: { id: cu.id, patch: { ownerId: 'id-twin-业务甲' } } }, impostor).state;
    expect(t.customers.find(x => x.id === cu.id)!.ownerId).toBe('id-twin-业务甲');
    s = run(s, { type: 'market.customer.update', payload: { id: cu.id, patch: { ownerId: 'id-业务甲' } } }, boss).state;
    expect(s.customers.find(x => x.id === cu.id)!.ownerId).toBe('id-业务甲');
    // 负责人不变的其他修改保留原账号。
    s = run(s, { type: 'market.customer.update', payload: { id: cu.id, patch: { city: '苏州' } } }, me).state;
    expect(s.customers.find(x => x.id === cu.id)!.ownerId).toBe('id-业务甲');
  });
});
