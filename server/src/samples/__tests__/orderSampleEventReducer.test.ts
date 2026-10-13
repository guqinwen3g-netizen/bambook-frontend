import { describe, expect, it } from 'vitest';
import { buildOrderSampleSource, OrderSampleFamily, OrderSampleProvenance, OrderSampleSource } from '../orderSampleSourceContract';
import { reduceOrderSampleEvents } from '../orderSampleEventReducer';

function source(family: OrderSampleFamily = 'fabric_ss', provenance: OrderSampleProvenance = 'native_new'): OrderSampleSource {
  const specSnapshot = { quality: 'Q1' }, sourceFingerprint = 'a'.repeat(64);
  return buildOrderSampleSource({ domain: 'order', sourceId: 'S1', sampleId: 'P1', family,
    owner: { orderId: 'O1', businessLine: family.startsWith('fabric_') ? 'fabric' : 'garment', factoryRelationId: 'F1' },
    chainId: 'C1', round: 1, previousSourceId: null, provenance, specSnapshot,
    sampleFacts: { quantity: '0.25', unit: 'M', cuttingDate: '2026-10-04' },
    lines: [{ id: 'L1', orderId: 'O1', factoryRelationId: 'F1', quantity: '100', unit: 'M', specSnapshot, sourceFingerprint, lineFingerprint: 'c'.repeat(64) }],
    batches: [{ id: 'B1', orderId: 'O1', orderLineId: 'L1', factoryRelationId: 'F1', rangeStart: '0', quantity: '100', unit: 'M', revision: 1, state: 'active', specSnapshot, sourceFingerprint }],
    coverage: [{ orderLineId: 'L1', expectedLineFingerprint: 'c'.repeat(64), productionBatchId: 'B1', expectedBatchRevision: 1, rangeStart: '0', quantity: '100', unit: 'M' }] });
}
function chain(s: OrderSampleSource) {
  const events: any[] = [];
  const append = (eventType: string, payload: any) => {
    const fact = { id: 'E' + (events.length + 1), sourceId: s.sourceId, sampleId: s.sampleId,
      sequence: events.length + 1, previousEventId: events.length ? events[events.length - 1].id : null,
      actorId: 'A1', recordedAt: String(1000 + events.length), occurredAt: '2026-10-04', eventType,
      contentFingerprint: s.contentFingerprint, coverageFingerprint: s.coverageFingerprint, payload };
    const event = { ...fact, audit: { auditId: 'AU' + fact.id, protocol: 'order_sample_native_v1', source: 'route:samples:order-source:event',
      operation: 'order_sample_' + eventType, actorId: 'A1', targetType: 'OrderSampleEvent', targetId: fact.id, after: structuredClone(fact) } };
    events.push(event); return event;
  };
  const read = () => reduceOrderSampleEvents(s, events, { eventId: events[events.length - 1].id, sequence: events.length });
  append('registered', s.sampleFacts);
  return { events, append, read };
}
const shipment = { sentDate: '2026-10-04', courier: 'DHL', trackingNumber: 'DHL-1' };
const feedback = (shippedEventId: string, result = 'approved') => ({ shippedEventId, result, channel: 'email', confirmationDate: '2026-10-04', evidenceRefs: ['email:client-1'] });
function review(c: ReturnType<typeof chain>, s: OrderSampleSource, result = 'passed') {
  const request = c.append('qc_requested', { reason: '客户寄样前准确检验' });
  const report = { id: 'IR-' + request.id, revision: 1, requestedEventId: request.id, sourceId: s.sourceId, sampleId: s.sampleId, round: s.round,
    contentFingerprint: s.contentFingerprint, coverageFingerprint: s.coverageFingerprint, result, opinion: '按该源冻结规格核对' };
  return c.append('qc_reviewed', { requestedEventId: request.id, report,
    reportAudit: { auditId: 'QC-AU-' + request.id, protocol: 'order_sample_native_v1', source: 'route:qc:order-sample-review',
      operation: 'order_sample_qc_review', actorId: 'A1', targetType: 'InspectionReport', targetId: report.id, after: structuredClone(report) } });
}
function refreshAudit(event: any): void {
  const { audit, ...fact } = event;
  audit.after = structuredClone(fact);
}

describe('准确订单样品原生事件链', () => {
  it('SS登记→寄送→客户反馈回显同源事实，无消费者放行', () => {
    const c = chain(source()); const sent = c.append('shipped', shipment);
    c.append('customer_feedback', feedback(sent.id));
    const view = c.read();
    expect(view.latestFeedback).toMatchObject({ eventId: 'E3', shippedEventId: 'E2', result: 'approved' });
    expect(view.shipments).toHaveLength(1);
    for (const key of ['releaseEligible', 'shipmentEligible', 'productionApproved', 'status']) expect(view).not.toHaveProperty(key);
  });
  it('PP/TOP须同源原生QC先通过；没有QC或最新QC失败不能寄客户', () => {
    for (const family of ['garment_pp', 'garment_top'] as const) {
      const s = source(family), missing = chain(s); missing.append('shipped', shipment);
      expect(() => missing.read()).toThrow(/QC通过/);
      const passed = chain(s); review(passed, s); passed.append('shipped', shipment);
      expect(passed.read().qc).toMatchObject({ result: 'passed', sourceId: s.sourceId, round: 1 });
      for (const result of ['failed', 'direct_reject']) {
        const failed = chain(s); review(failed, s); review(failed, s, result); failed.append('shipped', shipment);
        expect(() => failed.read()).toThrow(/QC通过/);
      }
    }
  });
  it('current-link与legacy只可记录关联观察，不能恢复客户/QC原生资格', () => {
    for (const provenance of ['current_link_recorded', 'legacy_recorded'] as const) {
      const s = source('fabric_ss', provenance), historical = chain(s); historical.events.length = 0;
      historical.append('legacy_linked', { subjectType: 'FSS', subjectId: 'OLD-FSS-1', evidenceAuditIds: ['OLD-AUDIT-1'] });
      expect(historical.read()).toMatchObject({ proofTier: 'historical_observation', shipments: [], latestFeedback: null, qc: null, rcScopeEnabled: false });
      historical.append('shipped', shipment);
      expect(() => historical.read()).toThrow(/历史关联/);
      const cast = chain(s); cast.append('shipped', shipment); cast.append('customer_feedback', feedback('E2'));
      expect(() => cast.read()).toThrow(/历史关联/);
    }
    const native = chain(source()); native.append('legacy_linked', { subjectType: 'FSS', subjectId: 'OLD', evidenceAuditIds: ['OLD-AUDIT'] });
    expect(() => native.read()).toThrow(/原生链/);
  });
  it('retained只确认当前客户通过的业务留存，旧寄送反馈不能冒充当前结果', () => {
    const c = chain(source()); const sent = c.append('shipped', shipment); const confirmed = c.append('customer_feedback', feedback(sent.id));
    c.append('retained', { location: '业务档案柜 A' });
    expect(c.read().retained).toMatchObject({ location: '业务档案柜 A', customerFeedbackEventId: confirmed.id, shippedEventId: sent.id });
    for (const key of ['inventory', 'quantity', 'loan', 'sealTag']) expect(c.read().retained).not.toHaveProperty(key);
    const pending = chain(source()); pending.append('shipped', shipment); pending.append('retained', { location: 'A' });
    expect(() => pending.read()).toThrow(/当前客户/);
    const stale = chain(source()); const old = stale.append('shipped', shipment);
    stale.append('customer_feedback', feedback(old.id)); stale.append('shipped', { ...shipment, trackingNumber: 'DHL-2' });
    stale.append('customer_feedback', feedback(old.id)); stale.append('retained', { location: 'A' });
    expect(() => stale.read()).toThrow(/当前客户/);
  });
  it('失效保留真实寄送/反馈历史和RC已寄出事实，此轮不再追加业务动作', () => {
    const c = chain(source('fabric_rc')); const sent = c.append('shipped', shipment); c.append('customer_feedback', feedback(sent.id));
    c.append('invalidated', { reason: '新规格需另建准确来源轮次' });
    expect(c.read()).toMatchObject({ invalidated: { eventId: 'E4' }, rcScopeEnabled: true, shipments: [{ eventId: 'E2' }], latestFeedback: { eventId: 'E3' } });
    c.append('shipped', { ...shipment, trackingNumber: 'DHL-2' });
    expect(() => c.read()).toThrow(/失效/);
  });
  it('RC寄出才启用该源范围；fabric三族不先强制QC，EPS反馈不生成停产指令', () => {
    const rc = chain(source('fabric_rc')); expect(rc.read().rcScopeEnabled).toBe(false);
    rc.append('shipped', shipment); expect(rc.read().rcScopeEnabled).toBe(true);
    for (const family of ['fabric_ss', 'fabric_eps', 'garment_ship'] as const) {
      const c = chain(source(family)); const sent = c.append('shipped', shipment);
      c.append('customer_feedback', feedback(sent.id, family === 'fabric_eps' ? 'adjust_and_resend' : 'needs_revision'));
      expect(c.read().qc).toBeNull();
      for (const key of ['productionPaused', 'productionDirective', 'shipmentEligible']) expect(c.read()).not.toHaveProperty(key);
    }
    const ss = chain(source()); ss.append('shipped', shipment); ss.append('customer_feedback', feedback('E2', 'adjust_and_resend'));
    expect(() => ss.read()).toThrow(/业务族/);
  });
  it('反馈必须引用此前同源寄送，外源拼接、未来/不存在寄送及倒退日期拒绝', () => {
    for (const shippedEventId of ['OTHER-SOURCE-E2', 'E3']) {
      const c = chain(source()); c.append('customer_feedback', feedback(shippedEventId)); c.append('shipped', shipment);
      expect(() => c.read()).toThrow(/此前同源/);
    }
    const alien = chain(source()); const event = alien.append('shipped', shipment); event.sourceId = 'S2'; refreshAudit(event);
    expect(() => alien.read()).toThrow(/跨来源/);
    const earlier = chain(source()); earlier.append('shipped', shipment);
    const received = earlier.append('customer_feedback', { ...feedback('E2'), confirmationDate: '2026-10-03' });
    received.occurredAt = '2026-10-03'; refreshAudit(received);
    expect(() => earlier.read()).toThrow(/早于寄送/);
  });
  it('完整链要求准确head、连续seq/prev及唯一事件/审计，不能重排或截断', () => {
    const s = source(), c = chain(s); c.append('shipped', shipment); c.append('customer_feedback', feedback('E2'));
    const head = { eventId: 'E3', sequence: 3 };
    for (const events of [c.events.slice(0, 2), [c.events[0], c.events[2], c.events[1]], []]) {
      expect(() => reduceOrderSampleEvents(s, events, head)).toThrow();
    }
    for (const change of [
      (events: any[]) => { events[1].sequence = 3; refreshAudit(events[1]); },
      (events: any[]) => { events[1].previousEventId = 'OTHER'; refreshAudit(events[1]); },
      (events: any[]) => { events[1].id = 'E1'; events[1].audit.targetId = 'E1'; refreshAudit(events[1]); },
      (events: any[]) => { events[1].audit.auditId = events[0].audit.auditId; },
      (events: any[]) => { events[1].recordedAt = '999'; refreshAudit(events[1]); },
    ]) {
      const events = structuredClone(c.events); change(events);
      expect(() => reduceOrderSampleEvents(s, events, head)).toThrow();
    }
    expect(() => reduceOrderSampleEvents(s, c.events, { eventId: 'OTHER', sequence: 3 })).toThrow(/head/);
  });
  it('不能用id-only/Case审计或被改after冒充完整原生事件；旧摘要不能消费新内容', () => {
    const s = source(), c = chain(s); c.append('shipped', shipment);
    for (const change of [
      (event: any) => { event.audit = { auditId: 'ID-ONLY' }; },
      (event: any) => { event.audit.source = 'route:development:gate'; },
      (event: any) => { event.audit.actorId = 'OTHER-ACTOR'; },
      (event: any) => { event.audit.after.payload.trackingNumber = 'DIFFERENT'; },
      (event: any) => { event.coverageFingerprint = 'b'.repeat(64); refreshAudit(event); },
      (event: any) => { event.contentFingerprint = 'b'.repeat(64); refreshAudit(event); },
    ]) {
      const events = structuredClone(c.events); change(events[1]);
      expect(() => reduceOrderSampleEvents(s, events, { eventId: 'E2', sequence: 2 })).toThrow();
    }
    const changed = structuredClone(s); changed.sampleFacts.quantity = '2';
    expect(() => reduceOrderSampleEvents(changed, c.events, { eventId: 'E2', sequence: 2 })).toThrow(/摘要/);
  });
  it('QC须完整报告和原生报告审计，旧轮/异源/异范围通过都不能供PP寄送', () => {
    const s = source('garment_pp'), c = chain(s); review(c, s); c.append('shipped', shipment);
    for (const patch of [{ sourceId: 'S-OTHER' }, { round: 2 }, { coverageFingerprint: 'b'.repeat(64) }]) {
      const events = structuredClone(c.events); Object.assign(events[2].payload.report, patch);
      events[2].payload.reportAudit.after = structuredClone(events[2].payload.report); refreshAudit(events[2]);
      expect(() => reduceOrderSampleEvents(s, events, { eventId: 'E4', sequence: 4 })).toThrow(/QC报告跨/);
    }
    for (const change of [
      (event: any) => { event.payload.reportAudit = { auditId: 'ID-ONLY' }; },
      (event: any) => { event.payload.reportAudit.source = 'route:development:gate'; },
      (event: any) => { event.payload.reportAudit.after.result = 'failed'; },
      (event: any) => { event.payload.requestedEventId = 'OTHER-REQUEST'; },
    ]) {
      const events = structuredClone(c.events); change(events[2]); refreshAudit(events[2]);
      expect(() => reduceOrderSampleEvents(s, events, { eventId: 'E4', sequence: 4 })).toThrow();
    }
    const pending = chain(s); review(pending, s); pending.append('qc_requested', { reason: '复查' }); pending.append('shipped', shipment);
    expect(() => pending.read()).toThrow(/QC通过/);
  });
  it('严格typed payload拒绝generic status/隐式实物库存与无证据客户批准', () => {
    const s = source(), c = chain(s); c.append('shipped', shipment);
    const sent = structuredClone(c.events); sent[1].payload.status = 'approved'; refreshAudit(sent[1]);
    expect(() => reduceOrderSampleEvents(s, sent, { eventId: 'E2', sequence: 2 })).toThrow(/未定义字段/);
    c.append('customer_feedback', { ...feedback('E2'), evidenceRefs: [] });
    expect(() => c.read()).toThrow(/证据引用/);
    const retained = chain(s); retained.append('shipped', shipment); retained.append('customer_feedback', feedback('E2'));
    retained.append('retained', { location: 'A', inventoryQuantity: '100' });
    expect(() => retained.read()).toThrow(/未定义字段/);
  });
  it('新QC请求不能套用上一请求已通过的报告，即使事件审计自洽', () => {
    const s = source('garment_top'), c = chain(s); const prior = review(c, s);
    const request = c.append('qc_requested', { reason: '客户要求复查' });
    c.append('qc_reviewed', { ...structuredClone(prior.payload), requestedEventId: request.id,
      reportAudit: { ...structuredClone(prior.payload.reportAudit), auditId: 'QC-DIFFERENT-AUDIT' } });
    c.append('shipped', shipment);
    expect(() => c.read()).toThrow(/QC报告.*请求/);
  });
  it('同一个QC报告重新服务新请求须真实增加revision，不能复用旧修订通过事实', () => {
    const s = source('garment_pp'), c = chain(s); const prior = review(c, s);
    const request = c.append('qc_requested', { reason: '复查同一报告' });
    const report = { ...structuredClone(prior.payload.report), requestedEventId: request.id };
    const repeated = c.append('qc_reviewed', { requestedEventId: request.id, report,
      reportAudit: { ...structuredClone(prior.payload.reportAudit), auditId: 'QC-NEW-AUDIT', after: structuredClone(report) } });
    c.append('shipped', shipment);
    expect(() => c.read()).toThrow(/报告修订/);
    repeated.payload.report.revision = 2; repeated.payload.reportAudit.after.revision = 2; refreshAudit(repeated);
    expect(c.read().qc?.revision).toBe(2);
  });
});
