import { describe, expect, it } from 'vitest';
import { applyMistCommand, createMistState, type MistContext, type MistState } from './mistWorkspace';

const ctx = (): MistContext => { let n = 0; return { id: () => `lc-${++n}`, now: '2026-10-14T02:00:00.000Z', actorName: '顾言', actorId: 'u-gu' }; };
const demo = () => { const c = ctx(); return { c, s: createMistState(c, 'demo') }; };
const run = (s: MistState, command: any, c: MistContext) => applyMistCommand(s, command, c);

describe('线索一键转 CRM', () => {
  it('按线索公司新建客户与联系人并建立商机，线索记录转化去向', () => {
    const { c, s } = demo(); const lead = s.market.leads.find(l => l.name === 'Anna Rossi')!;
    const r = run(s, { type: 'market.lead.convertToCrm', payload: { id: lead.id, opportunity: { title: 'Rossi 西装面料', domain: 'fabric', amount: '4000.00', currency: 'EUR', expectedDate: '2026-12-01' } } }, c);
    const st = r.state, customerId = String(r.result.customerId);
    expect(st.customers.find(x => x.id === customerId)!.name).toBe('Studio Rossi Milano');
    expect(st.contacts.some(x => x.customerId === customerId && x.name === 'Anna Rossi')).toBe(true);
    const opp = st.crm.opportunities.find(o => o.id === r.result.opportunityId)!;
    expect(opp).toMatchObject({ customerId, stage: 'intent', currency: 'EUR' }); expect(opp.note).toContain('Première Vision Paris');
    expect(st.market.leads.find(l => l.id === lead.id)).toMatchObject({ status: 'Converted', customerId, opportunityId: opp.id });
    expect(() => run(st, { type: 'market.lead.convertToCrm', payload: { id: lead.id } }, c)).toThrow(/已转化/);
  });
  it('同名客户不重复建立；失败时不落下半截数据', () => {
    const { c, s } = demo(); const lead = s.market.leads.find(l => l.name === 'Clara Weiss')!;
    const named = run(s, { type: 'market.customer.create', payload: { input: { name: 'weiss & söhne', country: '', city: '', industry: '', ownerId: 'u-gu', grade: '', currency: 'EUR', terms: '', incoterm: '', categories: '', creditLimit: 0, since: '2026-10-14' } } }, c).state;
    const before = named.customers.length;
    expect(() => run(named, { type: 'market.lead.convertToCrm', payload: { id: lead.id } }, c)).toThrow(/已有同名客户/);
    expect(() => run(s, { type: 'market.lead.convertToCrm', payload: { id: lead.id, opportunity: { title: '', domain: 'fabric', amount: '1', currency: 'EUR', expectedDate: '' } } }, c)).toThrow();
    expect(s.customers.some(x => x.name === 'Weiss & Söhne')).toBe(false); expect(named.customers.length).toBe(before);
    const existing = named.customers.find(x => x.name === 'weiss & söhne')!;
    const r = run(named, { type: 'market.lead.convertToCrm', payload: { id: lead.id, customerId: existing.id } }, c);
    expect(r.state.customers.length).toBe(before); expect(r.state.market.leads.find(l => l.id === lead.id)!.customerId).toBe(existing.id);
  });
});
