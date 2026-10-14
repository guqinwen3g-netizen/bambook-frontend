import { describe, expect, it } from 'vitest';
import { createMistState, type MistContext } from './mistWorkspace';
import { DEMO_SEED_VERSION } from './mistDemoSeed';
import { isDemoFile, renderDemoFile } from './mistDemoFiles';

const context = (): MistContext => { let n = 0; return { id: () => `demo-${++n}`, now: '2026-10-14T02:00:00.000Z', actorName: '演示' }; };
const demo = () => { let failures: unknown[] = []; const state = createMistState(context(), 'demo', f => { failures = f; }); return { state, failures }; };

describe('演示工作区数据', () => {
  it('所有示例数据都经由真实业务命令生成，没有失败步骤并记录种子版本', () => {
    const { state, failures } = demo();
    expect(failures).toEqual([]);
    expect(state.settings.demoSeed).toEqual({ version: DEMO_SEED_VERSION, seededAt: '2026-10-14T02:00:00.000Z' });
  });
  it('每个已完成前端的页面都有内容', () => {
    const { state } = demo(), m = state.market, f = state.fulfillment;
    const slices: Record<string, unknown[]> = {
      products: m.products, suppliers: m.suppliers, relations: m.relations, seasons: m.seasons, quotations: m.quotations, leads: m.leads, campaigns: m.campaigns, lookbooks: m.lookbooks,
      opportunities: state.crm.opportunities, followUps: state.crm.followUps, samples: f.samples, qcTasks: f.qcTasks, qcReports: f.qcReports,
      purchases: f.purchases, receipts: f.receipts, stock: f.stock, shipments: f.shipments, packing: f.packing, customs: f.customs, documents: f.documents,
      payments: state.payments, funding: state.orderFunding.assignments, mail: state.email.messages, orders: state.orders,
    };
    for (const [name, rows] of Object.entries(slices)) expect(rows.length, name).toBeGreaterThan(0);
    expect(state.orders.every(o => o.governance?.status === 'approved')).toBe(true);
    expect(new Set(state.payments.map(p => p.currency)).size).toBeGreaterThan(1);
    expect(state.payments.every(p => p.ref.includes('软件演示付款记录'))).toBe(true);
    expect(new Set(state.orders.map(o => o.state)).size).toBeGreaterThan(2);
    expect(m.quotations.some(q => q.status === 'Accepted') && m.quotations.some(q => q.status === 'Draft')).toBe(true);
    expect(f.shipments[0].state).toBe('departed');
    expect(m.leads.some(l => l.source === 'show' && l.status === 'Converted' && l.opportunityId) && m.seasons.some(x => x.status === 'Closed' && x.review) && m.trends.length >= 3).toBe(true);
    expect(m.campaigns.some(c => c.status === 'Paused' && Number(c.actualCost) > Number(c.budget))).toBe(true);
    expect(m.lookbooks.some(b => b.status === 'Prepared' && b.snapshots.length > 0)).toBe(true);
    expect(m.leads.some(l => l.source === 'campaign' && l.status === 'Converted' && l.opportunityId)).toBe(true);
    expect(m.relations.some(r => r.customerId && r.supplierId) && m.relations.some(r => r.hold)).toBe(true);
    expect(m.suppliers.some(x => x.status === 'paused') && m.suppliers.some(x => x.certificates?.some(c => c.validUntil < '2026-10-14')) && m.suppliers.filter(x => x.ratings?.length).length).toBeTruthy();
  });
  it('示例附件生成为可下载的英文 PDF，并标明演示用途', () => {
    const { state } = demo(), files = state.files.filter(isDemoFile);
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const file of files) {
      const text = Buffer.from(renderDemoFile(state, file)).toString('latin1');
      expect(text.startsWith('%PDF-1.4')).toBe(true);
      expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
      expect(text).toContain('Bambook demo workspace');
      expect(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(text)).toBe(true);
    }
  });
  it('示例 PDF 的港口、供应商等中文信息换成英文而不是留空', () => {
    const { state } = demo(), text = (template: string) => Buffer.from(renderDemoFile(state, state.files.find(f => f.storageKey.startsWith(`demo-seed/${template}/`))!)).toString('latin1');
    expect(text('commercial-invoice')).toContain('From: Shanghai Yangshan');
    expect(text('commercial-invoice')).toContain('To: Gothenburg');
    expect(text('supplier-contract')).toMatch(/Supplier: \w/);
  });
  it('空白工作区不带任何示例数据', () => {
    const state = createMistState(context(), 'empty');
    expect(state.settings.demoSeed).toBeUndefined();
    expect(state.orders).toEqual([]); expect(state.market.products).toEqual([]); expect(state.fulfillment.samples).toEqual([]); expect(state.files).toEqual([]);
  });
});
