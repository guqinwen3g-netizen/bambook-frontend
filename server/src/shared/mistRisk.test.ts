import { describe, it, expect } from 'vitest';
import { applyMistCommand, createMistState, type MistContext, type MistState } from './mistWorkspace';
import { riskSignals, pendingEscalation } from './mistRisk';
import { platformCommandPermission } from './mistPlatform';
import { platformBusinessDate } from './mistPlatform';

function ctx(actorName = '顾言', now = '2026-10-14T02:00:00.000Z'): MistContext { let n = 0; return { id: () => `risk-${actorName}-${++n}`, now, actorName, actorId: actorName } as MistContext; }
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
    const { state, c, day } = demo(); const sig = riskSignals(state, day).find(x => !state.platform!.risks.some(r => r.signalKey === x.key))!;
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
  it('接手 → 处置方案 → 升级 → 审批 → 关闭，申请人不能自审，审批中不能关闭', () => {
    const { state, c } = demo(); const order = state.orders[0];
    let s = run(state, { type: 'platform.risk.save', payload: { orderId: order.id, title: '交期风险', level: 'warning', basis: '厂方回复延误', owner: '沈禾' } }, c).state;
    const id = s.platform!.risks[0].id;
    expect(() => run(s, { type: 'platform.risk.plan', payload: { id, plan: 'x' } }, c)).toThrow(/先接手/);
    s = run(s, { type: 'platform.risk.transition', payload: { id, state: 'Acknowledged', resolution: '我来跟' } }, c).state;
    expect(s.platform!.risks[0].owner).toBe('顾言');
    expect(() => run(s, { type: 'platform.risk.escalate', payload: { id, approver: '经理', reason: 'r' } }, c)).toThrow(/先制定处置方案/);
    s = run(s, { type: 'platform.risk.plan', payload: { id, plan: '空运补交 200 件', planDue: '2026-10-20' } }, c).state;
    s = run(s, { type: 'platform.risk.escalate', payload: { id, approver: '周经理', reason: '空运费超出订单预算' } }, c).state;
    const r = s.platform!.risks[0], e = pendingEscalation(r)!;
    expect(r.state).toBe('Escalated'); expect(s.tasks.some(t => t.kind === 'risk-escalation:' + e.id && !t.done)).toBe(true);
    expect(() => run(s, { type: 'platform.risk.transition', payload: { id, state: 'Resolved', resolution: 'x' } }, c)).toThrow(/尚未答复/);
    expect(() => run(s, { type: 'platform.risk.decide', payload: { id, escalationId: e.id, decision: 'approved', note: 'ok' } }, c)).toThrow(/不能审批自己/);
    const boss = ctx('周经理');
    s = run(s, { type: 'platform.risk.decide', payload: { id, escalationId: e.id, decision: 'approved', note: '同意空运，费用记入本单' } }, boss).state;
    const after = s.platform!.risks[0];
    expect(after.state).toBe('InProgress'); expect(after.escalations![0]).toMatchObject({ decision: 'approved', decidedBy: '周经理' });
    expect(s.tasks.find(t => t.kind === 'risk-escalation:' + e.id)!.done).toBe(true);
    expect(s.notifications[0].target).toEqual({ view: 'risks', id });
    expect(() => run(s, { type: 'platform.risk.decide', payload: { id, escalationId: e.id, decision: 'rejected', note: 'x' } }, boss)).toThrow(/已答复/);
    s = run(s, { type: 'platform.risk.transition', payload: { id, state: 'Resolved', resolution: '空运到港，客户确认' } }, c).state;
    expect(s.platform!.risks[0].state).toBe('Resolved');
    expect(s.events.filter(x => x.entityId === id).length).toBeGreaterThanOrEqual(6);
    expect(s.orders.find(o => o.id === order.id)).toEqual(state.orders.find(o => o.id === order.id));
  });
});

describe('权限', () => {
  it('审批升级需要 risk:admin，其余风险操作需要 risk:write', () => {
    expect(platformCommandPermission({ type: 'platform.risk.decide', payload: { id: 'x', escalationId: 'e', decision: 'approved', note: 'n' } } as any)).toBe('risk:admin');
    for (const type of ['platform.risk.save', 'platform.risk.transition', 'platform.risk.plan', 'platform.risk.escalate']) expect(platformCommandPermission({ type, payload: {} } as any)).toBe('risk:write');
  });
});
