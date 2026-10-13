import { describe, expect, it } from 'vitest';
import { assertOrderSampleSource, buildOrderSampleSource, canonicalOrderSampleDecimal, canonicalOrderSampleJson, OrderSampleContractError } from '../orderSampleSourceContract';

function facts() {
  const sourceFingerprint = 'a'.repeat(64), specSnapshot = { quality: 'Q1' };
  return { domain: 'order', sourceId: 'SRC-A', sampleId: 'SMP-A', family: 'fabric_ss', owner: { orderId: 'O1', businessLine: 'fabric', factoryRelationId: 'F1' },
    chainId: 'CH1', round: 1, previousSourceId: null, provenance: 'native_new', specSnapshot,
    sampleFacts: { quantity: '0.2500', unit: 'meter', cuttingDate: '2026-10-04' },
    coverage: [{ orderLineId: 'L1', expectedLineFingerprint: 'c'.repeat(64), productionBatchId: 'B1', expectedBatchRevision: 2, rangeStart: '10.0000', quantity: '100.0000', unit: 'meter' }],
    lines: [{ id: 'L1', orderId: 'O1', factoryRelationId: 'F1', quantity: '1000', unit: 'm', specSnapshot, sourceFingerprint, lineFingerprint: 'c'.repeat(64) }],
    batches: [{ id: 'B1', orderId: 'O1', orderLineId: 'L1', factoryRelationId: 'F1', rangeStart: '10', quantity: '100', unit: 'M', revision: 2, state: 'active', specSnapshot, sourceFingerprint }] };
}
describe('准确订单样品来源', () => {
  it('取样量与代表bulk量独立，规范化不复制数量', () => {
    const source = buildOrderSampleSource(facts());
    expect(source.sampleFacts).toEqual({ quantity: '0.25', unit: 'M', cuttingDate: '2026-10-04' });
    expect(source.coverage[0]).toMatchObject({ productionBatchId: 'B1', productionBatchRevision: 2, rangeStart: '10', quantity: '100', unit: 'M' });
  });
  it('两个真实数量偶然相等合法，但不能缺少独立取样事实', () => {
    const input = facts(); input.sampleFacts.quantity = '100';
    expect(buildOrderSampleSource(input).sampleFacts.quantity).toBe('100');
    expect(() => buildOrderSampleSource({ ...input, sampleFacts: undefined })).toThrow(OrderSampleContractError);
  });
  it('只有PP可使用行范围，TOP/Ship及面料三族须真实batch', () => {
    const input = facts();
    const lineScope = [{ orderLineId: 'L1', expectedLineFingerprint: 'c'.repeat(64), rangeStart: '0', quantity: '10', unit: 'M' }];
    const garment = { ...input, owner: { ...input.owner, businessLine: 'garment' }, family: 'garment_pp', coverage: lineScope };
    expect(buildOrderSampleSource(garment).coverage[0].scopeKind).toBe('order_line');
    for (const family of ['garment_top', 'garment_ship']) expect(() => buildOrderSampleSource({ ...garment, family })).toThrow(/真实生产批次/);
    for (const family of ['fabric_ss', 'fabric_rc', 'fabric_eps']) expect(() => buildOrderSampleSource({ ...input, family, coverage: lineScope })).toThrow(/真实生产批次/);
    expect(buildOrderSampleSource({ ...garment, coverage: input.coverage }).coverage[0].scopeKind).toBe('production_batch');
  });
  it('显式族与owner映射，Case PP和成衣EPS不能混入', () => {
    const input = facts();
    expect(() => buildOrderSampleSource({ ...input, family: 'fabric_eps', owner: { ...input.owner, businessLine: 'garment' } })).toThrow(/业务线/);
    expect(() => buildOrderSampleSource({ ...input, domain: 'case' })).toThrow(/Case来源/);
    expect(() => buildOrderSampleSource({ ...input, family: 'ship' })).toThrow(/业务族/);
  });
  it('大数与最小小数以精确区间比较，超过边界一万分之一拒绝', () => {
    const input = facts(); input.lines[0].quantity = '99999999999999.9999';
    input.batches[0] = { ...input.batches[0], rangeStart: '99999999999999.9998', quantity: '0.0001' };
    input.coverage[0] = { ...input.coverage[0], rangeStart: '99999999999999.9998', quantity: '0.0001' };
    expect(buildOrderSampleSource(input).coverage[0].quantity).toBe('0.0001');
    input.coverage[0].rangeStart = '99999999999999.9999';
    expect(() => buildOrderSampleSource(input)).toThrow(/实际数量|真实生产批次/);
  });
  it('拒绝Number、舍入、科学计数、负数与超过Decimal18,4的数量', () => {
    for (const quantity of [1, '1e3', '-1', '01', '0.00001', '100000000000000', 'NaN', 'Infinity', '0']) {
      expect(() => canonicalOrderSampleDecimal(quantity)).toThrow();
    }
    expect(canonicalOrderSampleDecimal('99999999999999.9999')).toBe('99999999999999.9999');
  });
  it('相同单位别名可以规范，不将M/YD或件数换算为bulk范围', () => {
    const input = facts(); input.sampleFacts.unit = 'piece';
    expect(buildOrderSampleSource(input).sampleFacts.unit).toBe('PC');
    input.coverage[0].unit = 'YD';
    expect(() => buildOrderSampleSource(input)).toThrow(/单位不同/);
  });
  it('拒绝同单异厂、异spec、错行、旧revision及非active批次', () => {
    for (const patch of [{ factoryRelationId: 'F2' }, { specSnapshot: { quality: 'Q2' } }, { orderLineId: 'L2' }, { revision: 3 }, { state: 'split' }, { sourceFingerprint: 'b'.repeat(64) }]) {
      const input = facts(); input.batches[0] = { ...input.batches[0], ...patch };
      expect(() => buildOrderSampleSource(input)).toThrow(/批次归属/);
    }
    const input = facts(); input.lines[0].orderId = 'O2';
    expect(() => buildOrderSampleSource(input)).toThrow(/实际订单行/);
  });
  it('真实相邻区间可组合，重复或重叠不能扩大覆盖，排序与输入顺序无关', () => {
    const input = facts(); const first = { ...input.coverage[0], quantity: '50' };
    const second = { ...input.coverage[0], rangeStart: '60', quantity: '50' };
    const a = buildOrderSampleSource({ ...input, coverage: [second, first] });
    const b = buildOrderSampleSource({ ...input, coverage: [first, second] });
    expect(a.coverageFingerprint).toBe(b.coverageFingerprint);
    expect(() => buildOrderSampleSource({ ...input, coverage: [first, first] })).toThrow(/重复或重叠/);
    expect(() => buildOrderSampleSource({ ...input, coverage: [first, { ...second, rangeStart: '59.9999' }] })).toThrow(/重复或重叠/);
  });
  it('opaque Line身份按稳定序排列，不依赖运行环境collation', () => {
    const input = facts();
    const lines = ['L-a', 'L-A'].map(id => ({ ...input.lines[0], id }));
    const batches = lines.map(line => ({ ...input.batches[0], id: 'B-' + line.id, orderLineId: line.id }));
    const coverage = batches.map(batch => ({ ...input.coverage[0], orderLineId: batch.orderLineId, productionBatchId: batch.id }));
    expect(buildOrderSampleSource({ ...input, lines, batches, coverage }).coverage.map(c => c.orderLineId)).toEqual(['L-A', 'L-a']);
  });
  it('摘要不隐式toJSON或丢不完整JSON，已构建来源改内容不能沿用旧摘要', () => {
    for (const value of [undefined, NaN, new Date(), BigInt(1), [, 'x']]) expect(() => canonicalOrderSampleJson(value)).toThrow();
    const cycle: any = {}; cycle.self = cycle; expect(() => canonicalOrderSampleJson(cycle)).toThrow();
    const source = buildOrderSampleSource(facts()); source.sampleFacts.quantity = '2';
    expect(() => assertOrderSampleSource(source)).toThrow(/摘要已变化/);
  });
  it('冻结来源不能补前轮身份或执行getter制造事实', () => {
    const input = facts();
    expect(() => buildOrderSampleSource({ ...input, previousSourceId: undefined })).toThrow();
    let invoked = false;
    const getters = { ...input, sampleFacts: Object.defineProperty({}, 'quantity', { enumerable: true, get() { invoked = true; return '1'; } }) };
    expect(() => buildOrderSampleSource(getters)).toThrow();
    expect(invoked).toBe(false);
    const array: any[] = ['proof']; array['approval' as any] = 'passed';
    expect(() => canonicalOrderSampleJson(array)).toThrow();
  });
  it('实际Line读取版本须吻合，行数量增长不自动扩大已冻结的batch代表范围', () => {
    const input = facts(); input.coverage[0].expectedLineFingerprint = 'd'.repeat(64);
    expect(() => buildOrderSampleSource(input)).toThrow(/订单行读取版本/);
    input.lines[0].lineFingerprint = 'd'.repeat(64); input.lines[0].quantity = '2000';
    const current = buildOrderSampleSource(input);
    expect(current.coverage[0]).toMatchObject({ lineQuantity: '2000', quantity: '100', batchQuantity: '100', productionBatchRevision: 2 });
    input.coverage[0].quantity = '101';
    expect(() => buildOrderSampleSource(input)).toThrow(/真实生产批次/);
  });
});
