import { describe, it, expect } from 'vitest';
import { applyMistCommand, createMistState, type DevelopmentValues, type MistCommand, type MistContext } from '../../../../server/src/shared/mistWorkspace';
import { developmentVersionLinks } from './DevVersionLinks';

/** 同一开发案 R1-A / R1-B 两版均 QC 通过、转产品档案，并进入同一报价（两条目各引用一版），报价走到客户已接受。 */
function fixture() {
  let n = 0; const ctx: MistContext = { id: () => `dl-${++n}`, now: '2026-10-16T09:00:00Z', actorName: '测试业务员', actorId: 'sales', authority: { supplier: {}, businessReviewerId: 'leader' } };
  let state = createMistState(ctx, 'empty');
  state.customers.push({ id: 'c', name: '测试客户', code: 'C', country: '', city: '', industry: '', owner: '', grade: '', currency: 'USD', terms: '', incoterm: '', categories: '', creditLimit: 0, since: '' });
  const run = (command: MistCommand, c: MistContext = ctx) => { const r = applyMistCommand(state, command, c); state = r.state; return r.result as Record<string, any>; };
  const values: DevelopmentValues = { initiator: 'customer', requestType: 'replicate', name: '双厂来样复刻', customer: 'c', style: 'ST-2', season: 'AW', category: '大衣', kind: 'new', fabric: '羊毛', color: '灰', target: '', sizeBase: 'M', goal: '按来样复刻', factories: ['A厂', 'B厂'], due: '2026-10-30', collaborators: [], sampleQuantity: 1 };
  const devId = run({ type: 'development.submit', payload: { values, fileIds: [] } }).devId as string;
  const [a, b] = ['A厂', 'B厂'].map(factory => state.versions.find(v => v.devId === devId && v.factory === factory)!);
  const lines = [a, b].map((version, index) => {
    run({ type: 'development.recordSample', payload: { devId, versionId: version.id, sample: `S-${index}`, quantity: 1, returnedAt: ctx.now } });
    run({ type: 'development.recordQc', payload: { devId, versionId: version.id, qc: { result: 'pass', reviewer: 'QC', reviewedAt: ctx.now, report: `QC-${index}`, opinion: '通过', measurements: [] } } });
    const productId = run({ type: 'market.product.fromVersion', payload: { devId, versionId: version.id, sku: `GA-DL-${index}` } }).id as string;
    return { productId, sourceDevId: devId, sourceVersionId: version.id, name: `大衣${version.label}`, style: `GA-DL-${index}`, specification: '', qty: '10', unit: '件', price: '50.00', cost: '30.00' };
  });
  const quoteId = run({ type: 'market.quotation.save', payload: { input: { customerId: 'c', currency: 'USD', season: 'AW26', validUntil: '2026-11-01', deliveryTerms: 'FOB', paymentTerms: 'T/T', lines } } }).id as string;
  run({ type: 'market.quotation.submit', payload: { id: quoteId } });
  if (state.market.quotations.find(q => q.id === quoteId)!.approval?.status === 'pending') run({ type: 'market.quotation.decide', payload: { id: quoteId, decision: 'approved', note: 'ok' } }, { ...ctx, actorId: 'leader' });
  run({ type: 'market.quotation.status', payload: { id: quoteId, status: 'Sent', evidence: '交付' } });
  run({ type: 'market.quotation.status', payload: { id: quoteId, status: 'Accepted', evidence: '接受' } });
  const quote = () => state.market.quotations.find(q => q.id === quoteId)!;
  const lineOf = (versionId: string) => quote().lines.find(line => line.sourceVersionId === versionId)!.id;
  const convert = (versionIds: string[]) => run({ type: 'market.quotation.convert', payload: { id: quoteId, type: 'garment', due: '2026-12-01', owner: '业务员', lineIds: versionIds.map(lineOf) } }).orderId as string;
  const links = (versionId: string) => developmentVersionLinks(state, state.versions.find(v => v.id === versionId));
  return { a, b, quoteId, quote, convert, links, get state() { return state; } };
}

describe('BB-DEV-10 开发版本的订单关联按准确条目来源', () => {
  it('A 条目已转单、B 条目未转：B 只关联报价，不关联 A 的订单', () => {
    const f = fixture();
    const orderA = f.convert([f.a.id]);
    expect(f.quote().convertedOrderId).toBe(orderA);
    expect(f.links(f.a.id).orders.map(o => o.id)).toEqual([orderA]);
    expect(f.links(f.b.id).quotations.map(q => q.id)).toEqual([f.quoteId]);
    expect(f.links(f.b.id).orders).toEqual([]);
  });
  it('A、B 分别转入不同订单：每版只显示自己的订单', () => {
    const f = fixture();
    const orderA = f.convert([f.a.id]), orderB = f.convert([f.b.id]);
    expect(orderB).not.toBe(orderA);
    expect(f.quote().convertedOrderId).toBe(orderA);
    expect(f.links(f.a.id).orders.map(o => o.id)).toEqual([orderA]);
    expect(f.links(f.b.id).orders.map(o => o.id)).toEqual([orderB]);
  });
  it('历史整单转单（无条目级去向）仍按全部已转回退关联', () => {
    const f = fixture();
    const order = f.convert([f.a.id, f.b.id]);
    for (const line of f.quote().lines) delete (line as { conversion?: unknown }).conversion;
    f.state.orderLines = f.state.orderLines.filter(line => line.orderId !== order);
    expect(f.links(f.a.id).orders.map(o => o.id)).toEqual([order]);
    expect(f.links(f.b.id).orders.map(o => o.id)).toEqual([order]);
  });
});
