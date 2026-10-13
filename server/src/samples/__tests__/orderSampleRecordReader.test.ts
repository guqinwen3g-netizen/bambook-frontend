import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { buildOrderSampleSource, orderSampleDigest, type OrderSampleFamily } from '../orderSampleSourceContract';
import { loadOrderSampleRecord, orderSampleCoverageKey } from '../orderSampleRecordReader';
import { buildOrderSampleQcReport, orderSampleQcStoredReport, orderSampleQcReportContentHash } from '../orderSampleQcEvidence';

/** Synthetic persisted delegates; actual Decimal, source contract, reducer and
 * native audit reader. No HTTP, database, authorization or release verdict. */
function fixture(family: OrderSampleFamily = 'fabric_ss') {
  const lane = family.startsWith('garment_') ? 'garment' : 'fabric', unit = lane === 'garment' ? 'PC' : 'M';
  const nativeType = { fabric_ss: 'ship', fabric_rc: 'head', fabric_eps: 'pioneer', garment_pp: 'pp', garment_top: 'top', garment_ship: 'ship' }[family];
  const specSnapshot = { quality: 'Q1' }, sourceFingerprint = 'a'.repeat(64), lineFingerprint = 'c'.repeat(64);
  const source = buildOrderSampleSource({ domain: 'order', sourceId: 'SRC', sampleId: 'SAMPLE', family,
    owner: { orderId: 'ORDER', businessLine: lane, factoryRelationId: 'FACTORY' }, chainId: 'CHAIN', round: 1,
    previousSourceId: null, provenance: 'native_new', specSnapshot, sampleFacts: { quantity: lane === 'garment' ? '1' : '0.25', unit, cuttingDate: '2026-10-04' },
    lines: [{ id: 'LINE', orderId: 'ORDER', factoryRelationId: 'FACTORY', quantity: '100', unit, specSnapshot, sourceFingerprint, lineFingerprint }],
    batches: [{ id: 'BATCH', orderId: 'ORDER', orderLineId: 'LINE', factoryRelationId: 'FACTORY', rangeStart: '0', quantity: '100', unit, revision: 1, state: 'active', specSnapshot, sourceFingerprint }],
    coverage: [{ orderLineId: 'LINE', expectedLineFingerprint: lineFingerprint, productionBatchId: 'BATCH', expectedBatchRevision: 1, rangeStart: '0', quantity: '100', unit }] });
  const state: any = { sources: [{ id: source.sourceId, sampleId: source.sampleId, ...source.owner, family: source.family,
    chainId: source.chainId, round: source.round, previousSourceId: null, provenance: source.provenance, specSnapshot,
    sampleQuantity: new Prisma.Decimal(source.sampleFacts.quantity), sampleUnit: unit, cuttingDate: source.sampleFacts.cuttingDate,
    contentFingerprint: source.contentFingerprint, coverageFingerprint: source.coverageFingerprint, creationAuditId: 'CREATE', createdBy: 'ACTOR', createdAt: BigInt(1000), headSequence: 0, headEventId: null }],
    sample: { id: 'SAMPLE', sourceOrderId: 'ORDER', sourceCaseId: null, projectionKey: null, type: nativeType, status: 'draft', deletedAt: null }, bindings: [],
    coverage: source.coverage.map(c => { const { orderId, factoryRelationId, ...body } = c; return { ...body, id: 'COVERAGE', sourceId: 'SRC', scopeKey: orderSampleCoverageKey(c),
      rangeStart: new Prisma.Decimal(c.rangeStart), quantity: new Prisma.Decimal(c.quantity), lineQuantity: new Prisma.Decimal(c.lineQuantity),
      batchRangeStart: new Prisma.Decimal(c.batchRangeStart!), batchQuantity: new Prisma.Decimal(c.batchQuantity!) }; }), events: [], audits: [] };
  const append = (eventType: string, payload: any) => {
    const index = state.events.length, fact: any = { id: 'EVENT' + (index + 1), sourceId: 'SRC', sampleId: 'SAMPLE', sequence: index + 1,
      previousEventId: index ? state.events[index - 1].id : null, actorId: 'ACTOR', recordedAt: String(1000 + index), occurredAt: '2026-10-04', eventType,
      contentFingerprint: source.contentFingerprint, coverageFingerprint: source.coverageFingerprint, payload };
    const command = { protocolVersion: 1, actorId: 'ACTOR', requestKey: 'REQUEST-' + (index + 1), operation: index ? 'append' : 'register', input: index ? { event: structuredClone(fact) } : { source: structuredClone(source), event: structuredClone(fact) } };
    const auditId = 'AUDIT' + (index + 1), commandHash = orderSampleDigest(command);
    const ack = { protocolVersion: 1, actorId: 'ACTOR', requestKey: command.requestKey, commandHash, sourceId: 'SRC', sampleId: 'SAMPLE', eventId: fact.id,
      eventSequence: fact.sequence, auditId, originalEvent: structuredClone(fact) };
    const { sampleId, ...stored } = fact;
    state.events.push({ ...stored, recordedAt: BigInt(fact.recordedAt), auditId, protocolVersion: 1, requestKey: command.requestKey,
      commandHash, commandSnapshot: command, acknowledgement: ack, ackHash: orderSampleDigest(ack), qcReportId: null, qcReportRevision: null, qcReportAuditId: null });
    state.audits.push({ id: auditId, actorId: 'ACTOR', action: 'order_sample_' + eventType, targetType: 'OrderSampleEvent', targetId: fact.id,
      transactionId: fact.id, createdAt: new Date(Number(fact.recordedAt)), detail: { protocol: 'order_sample_native_v1', source: 'route:samples:order-source:event', after: structuredClone(fact), commandReceipt: { protocolVersion: 1, requestKey: command.requestKey, commandHash, commandSnapshot: structuredClone(command), ackHash: orderSampleDigest(ack), acknowledgement: structuredClone(ack) } } });
    state.sources[0].headSequence = fact.sequence; state.sources[0].headEventId = fact.id;
  };
  append('registered', source.sampleFacts);
  state.audits.push({ id: 'CREATE', actorId: 'ACTOR', action: 'create_order_sample_source', targetType: 'OrderSampleSource', targetId: 'SRC', transactionId: 'EVENT1',
    createdAt: new Date(1000), detail: { protocol: 'order_sample_native_v1', source: 'route:samples:order-source:create', after: { source, coverage: source.coverage } } });
  const db: any = { orderSampleSource: { findUnique: vi.fn(async ({ where }: any) => state.sources.find((s: any) => s.id === where.id) || null) },
    orderSampleCoverage: { findMany: vi.fn(async () => state.coverage) }, orderSampleEvent: { findMany: vi.fn(async () => state.events) },
    sample: { findUnique: vi.fn(async () => state.sample) }, sampleSource: { findMany: vi.fn(async () => state.bindings) },
    auditLog: { findMany: vi.fn(async ({ where }: any) => state.audits.filter((a: any) => where.id.in.includes(a.id))) } };
  return { state, db, source, append, read: () => loadOrderSampleRecord(db, 'SRC') };
}

describe('native persisted source/event/audit/ACK reader', () => {
  it.each(['fabric_ss','fabric_rc','fabric_eps','garment_pp','garment_top','garment_ship'] as OrderSampleFamily[])('reconstructs %s using existing stage types and explicit business family', async family => {
    const f = fixture(family); const r = await f.read(); expect(r.source.family).toBe(family); expect(r.source.owner.businessLine).toBe(family.startsWith('garment_') ? 'garment' : 'fabric');
  });
  it('register→ship→exact feedback reconstructs original receipts and facts, never a release verdict', async () => {
    const f = fixture(); f.append('shipped', { sentDate: '2026-10-04', courier: 'Synthetic', trackingNumber: 'TEST' });
    f.append('customer_feedback', { shippedEventId: 'EVENT2', result: 'approved', channel: 'email', confirmationDate: '2026-10-04', evidenceRefs: ['synthetic-evidence'] });
    const r = await f.read(); expect(r.source).toEqual(f.source); expect(r.acknowledgements).toHaveLength(3);
    expect(r.view.latestFeedback).toMatchObject({ eventId: 'EVENT3', shippedEventId: 'EVENT2', result: 'approved' });
    for (const key of ['releaseEligible', 'shipmentEligible', 'productionApproved']) expect(r.view).not.toHaveProperty(key);
    expect(f.db.auditLog.findMany.mock.calls[0][0].where.id.in.sort()).toEqual(['CREATE', 'AUDIT1', 'AUDIT2', 'AUDIT3'].sort());
  });
  it.each(['missing-source', 'missing-sample', 'wrong-order', 'case-origin', 'case-binding', 'projection', 'wrong-type', 'numeric-quantity', 'empty-coverage', 'cross-coverage', 'scope-key', 'duplicate-coverage', 'content', 'head', 'missing-event', 'extra-event'])('rejects stored %s instead of using generic status', async kind => {
    const f = fixture(); f.state.sample.status = 'approved';
    if (kind === 'missing-source') f.state.sources = []; if (kind === 'missing-sample') f.state.sample = null;
    if (kind === 'wrong-order') f.state.sample.sourceOrderId = 'OTHER'; if (kind === 'case-origin') f.state.sample.sourceCaseId = 'CASE';
    if (kind === 'case-binding') f.state.bindings = [{ id: 'BINDING' }]; if (kind === 'projection') f.state.sample.projectionKey = 'CASE-PP';
    if (kind === 'wrong-type') f.state.sample.type = 'pp'; if (kind === 'numeric-quantity') f.state.sources[0].sampleQuantity = 0.25;
    if (kind === 'empty-coverage') f.state.coverage = []; if (kind === 'cross-coverage') f.state.coverage[0].sourceId = 'OTHER';
    if (kind === 'scope-key') f.state.coverage[0].scopeKey = 'fake'; if (kind === 'duplicate-coverage') f.state.coverage.push(f.state.coverage[0]);
    if (kind === 'content') f.state.sources[0].specSnapshot = { quality: 'OTHER' }; if (kind === 'head') f.state.sources[0].headSequence = 2;
    if (kind === 'missing-event') f.state.events = []; if (kind === 'extra-event') f.state.events.push(f.state.events[0]);
    await expect(f.read()).rejects.toThrow();
  });
  it.each(['missing', 'actor', 'target', 'action', 'source', 'transaction', 'after', 'date'])('rejects actual creation audit %s', async kind => {
    const f = fixture(), a = f.state.audits.find((a: any) => a.id === 'CREATE');
    if (kind === 'missing') f.state.audits = f.state.audits.filter((a: any) => a.id !== 'CREATE');
    if (kind === 'actor') a.actorId = 'OTHER'; if (kind === 'target') a.targetId = 'OTHER'; if (kind === 'action') a.action = 'create_sample';
    if (kind === 'source') a.detail.source = 'client:invented'; if (kind === 'transaction') a.transactionId = 'OTHER';
    if (kind === 'after') a.detail.after.source.owner.orderId = 'OTHER'; if (kind === 'date') a.createdAt = BigInt(1000);
    await expect(f.read()).rejects.toThrow();
  });
  it.each(['missing', 'actor', 'target', 'transaction', 'after', 'time', 'ack-hash', 'ack-event', 'command-hash', 'command-actor', 'audit-reuse'])('rejects event proof %s', async kind => {
    const f = fixture(), a = f.state.audits[0], e = f.state.events[0];
    if (kind === 'missing') f.state.audits.shift(); if (kind === 'actor') a.actorId = 'OTHER'; if (kind === 'target') a.targetType = 'Sample';
    if (kind === 'transaction') a.transactionId = 'OTHER'; if (kind === 'after') a.detail.after.payload.quantity = '50'; if (kind === 'time') a.createdAt = new Date(2000);
    if (kind === 'ack-hash') e.ackHash = '0'.repeat(64);
    if (kind === 'ack-event') { e.acknowledgement.eventId = 'OTHER'; e.ackHash = orderSampleDigest(e.acknowledgement); }
    if (kind === 'command-hash') e.commandHash = '0'.repeat(64); if (kind === 'command-actor') { e.commandSnapshot.actorId = 'OTHER'; e.commandHash = orderSampleDigest(e.commandSnapshot); }
    if (kind === 'audit-reuse') e.auditId = 'CREATE'; await expect(f.read()).rejects.toThrow();
  });
  it('later generic status and soft deletion do not rewrite the original receipt', async () => {
    const f = fixture(), first = await f.read(); f.state.sample.status = 'archived'; f.state.sample.deletedAt = BigInt(5000);
    expect((await f.read()).acknowledgements).toEqual(first.acknowledgements);
  });
  it('loads an audited QC request without granting a QC result', async () => {
    const f = fixture(); f.append('qc_requested', { reason: '检查实际取样' });
    expect((await f.read()).view).toMatchObject({ pendingQcRequest: { eventId: 'EVENT2' }, qc: null });
    const g = fixture(); g.state.events[0].qcReportId = 'IR'; await expect(g.read()).rejects.toThrow(/报告/);
  });
  function qcFixture() {
    const f = fixture('garment_pp'); f.append('qc_requested', { reason: '寄送前检验' });
    const {data, report} = buildOrderSampleQcReport(f.source, { requestedEventId:'EVENT2', result:'pass', opinion:'实测通过', inspectionDate:'2026-10-04', inspectorOrg:'内检', totalUnits:1, passedUnits:1, sampleSize:1, criticalDefects:0, majorDefects:0, minorDefects:0, defectSummary:'无', reportFile:null }, {reportId:'IR', eventId:'EVENT3', actorId:'ACTOR', requestKey:'REQUEST-3', commandHash:'d'.repeat(64), sequence:3, recordedAt:'1002'});
    const reportAudit = {auditId:'QC-AUDIT',protocol:'order_sample_native_v1',source:'route:qc:order-sample-review',operation:'order_sample_qc_review',actorId:'ACTOR',targetType:'InspectionReport',targetId:'IR',after:report};
    f.append('qc_reviewed', {requestedEventId:'EVENT2',report,reportAudit});
    Object.assign(f.state.events[2], {qcReportId:'IR',qcReportRevision:3,qcReportAuditId:'QC-AUDIT'});
    const reviewCommand={protocolVersion:1,operation:'qc_review',actorId:'ACTOR',requestKey:'REQUEST-3',input:{protocolVersion:1,requestKey:'REQUEST-3',sourceId:'SRC',expectedHead:{eventId:'EVENT2',sequence:2},eventType:'qc_reviewed',occurredAt:'2026-10-04',payload:{requestedEventId:'EVENT2',result:'pass',opinion:'实测通过',inspectionDate:'2026-10-04',inspectorOrg:'内检',totalUnits:1,passedUnits:1,sampleSize:1,criticalDefects:0,majorDefects:0,minorDefects:0,defectSummary:'无',reportFile:null}}};
    data.commandHash=orderSampleDigest(reviewCommand);
    data.contentFingerprint=orderSampleQcReportContentHash(data);
    const originalReport=orderSampleQcStoredReport(data);
    const audit={id:'QC-AUDIT',actorId:'ACTOR',action:'order_sample_qc_review',targetType:'InspectionReport',targetId:'IR',transactionId:'EVENT3',createdAt:new Date(1002),detail:{protocol:'order_sample_native_v1',source:'route:qc:order-sample-review',after:report,originalReport,originalReportHash:orderSampleDigest(originalReport),reviewCommand}};
    f.state.audits.push(audit); f.db.inspectionReport={findUnique:vi.fn(async()=>data)};
    f.db.auditLog.findUnique=vi.fn(async({where}:any)=>f.state.audits.find((a:any)=>a.id===where.id)??null);
    return {...f,reportRow:data,reportAuditRow:audit};
  }
  it('reads QC qualification only from the actual report and original audit', async()=>{
    const f=qcFixture(); expect((await f.read()).view.qc).toMatchObject({id:'IR',result:'passed',requestedEventId:'EVENT2'});
    expect(f.db.inspectionReport.findUnique).toHaveBeenCalledWith({where:{id:'IR'}});
  });
  it.each(['missing-report','missing-audit','report-content','wrong-scope','audit-time','inline-report'])('rejects QC proof damage: %s',async attack=>{
    const f=qcFixture();
    if(attack==='missing-report')f.db.inspectionReport.findUnique.mockResolvedValue(null);
    if(attack==='missing-audit')f.state.audits=f.state.audits.filter((a:any)=>a.id!=='QC-AUDIT');
    if(attack==='report-content')f.reportRow.majorDefects=4;
    if(attack==='wrong-scope')f.reportRow.scopeKey='OTHER';
    if(attack==='audit-time')f.reportAuditRow.createdAt=new Date(9999);
    if(attack==='inline-report')f.state.events[2].payload.report.opinion='改写';
    await expect(f.read()).rejects.toThrow();
  });
  it('validates both complete rounds and rejects damaged predecessor audits', async () => {
    const f = fixture(), previous = fixture();
    const rename = (v: any): any => {
      if (v instanceof Date || Prisma.Decimal.isDecimal(v)) return v;
      if (typeof v === 'string') return ({ SRC: 'PREVIOUS', SAMPLE: 'PREVIOUS-SAMPLE', CREATE: 'PREVIOUS-CREATE', EVENT1: 'PREVIOUS-EVENT1', AUDIT1: 'PREVIOUS-AUDIT1', COVERAGE: 'PREVIOUS-COVERAGE' } as any)[v] ?? v;
      if (Array.isArray(v)) return v.map(rename);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rename(x)]));
      return v;
    };
    const ps = rename(previous.state), psource = rename(previous.source);
    const rebuild = (state: any, source: any) => {
      const { coverage, contentFingerprint, coverageFingerprint, ...body } = source;
      source.contentFingerprint = orderSampleDigest(body); state.sources[0].contentFingerprint = source.contentFingerprint;
      const e = state.events[0], a = state.audits[0]; e.contentFingerprint = source.contentFingerprint;
      const fact = { ...a.detail.after, contentFingerprint: source.contentFingerprint };
      e.commandSnapshot.input = { source: structuredClone(source), event: structuredClone(fact) };
      e.commandHash = orderSampleDigest(e.commandSnapshot); e.acknowledgement.originalEvent = fact;
      e.acknowledgement.commandHash = e.commandHash; e.ackHash = orderSampleDigest(e.acknowledgement);
      a.detail.after = structuredClone(fact);
      a.detail.commandReceipt = structuredClone({ protocolVersion: e.protocolVersion, requestKey: e.requestKey, commandHash: e.commandHash, commandSnapshot: e.commandSnapshot, ackHash: e.ackHash, acknowledgement: e.acknowledgement });
      state.audits[1].detail.after = { source, coverage: source.coverage };
    };
    rebuild(ps, psource);
    f.state.sources[0].round = 2; f.state.sources[0].previousSourceId = 'PREVIOUS';
    const next = { ...f.source, round: 2, previousSourceId: 'PREVIOUS' }; rebuild(f.state, next);
    f.state.sources.push(...ps.sources); f.state.coverage.push(...ps.coverage); f.state.events.push(...ps.events); f.state.audits.push(...ps.audits);
    f.db.sample.findUnique.mockImplementation(async ({ where }: any) => where.id === 'SAMPLE' ? f.state.sample : ps.sample);
    f.db.orderSampleCoverage.findMany.mockImplementation(async ({ where }: any) => f.state.coverage.filter((c: any) => c.sourceId === where.sourceId));
    f.db.orderSampleEvent.findMany.mockImplementation(async ({ where }: any) => f.state.events.filter((e: any) => e.sourceId === where.sourceId));
    expect((await f.read()).source.round).toBe(2);
    ps.audits[0].detail.commandReceipt.requestKey = 'FAKE';
    await expect(f.read()).rejects.toThrow(/原审计命令回执/);
  });
  it('rejects a compatible previous header whose original chain is corrupt', async () => {
    const f = fixture(), current = f.state.sources[0]; current.round = 2; current.previousSourceId = 'PREVIOUS';
    const next = { ...f.source, round: 2, previousSourceId: 'PREVIOUS' };
    const { coverage, contentFingerprint, coverageFingerprint, ...body } = next;
    next.contentFingerprint = orderSampleDigest(body); current.contentFingerprint = next.contentFingerprint;
    f.state.sources.push({ ...current, id: 'PREVIOUS', sampleId: 'PREVIOUS-SAMPLE', round: 1, previousSourceId: 'PREVIOUS', headSequence: 0, headEventId: null });
    await expect(f.read()).rejects.toThrow();
  });
  it.each(['request', 'input'])('rejects rehashed forged %s despite unchanged actual audits', async kind => {
    const f = fixture(), e = f.state.events[0];
    if (kind === 'request') { e.requestKey = 'NEVER-EXECUTED'; e.commandSnapshot.requestKey = e.requestKey; e.acknowledgement.requestKey = e.requestKey; }
    else e.commandSnapshot.input.source.sampleFacts.quantity = '99';
    e.commandHash = orderSampleDigest(e.commandSnapshot); e.acknowledgement.commandHash = e.commandHash; e.ackHash = orderSampleDigest(e.acknowledgement);
    await expect(f.read()).rejects.toThrow();
  });
  it('rejects command business mismatch even if its audit receipt also matches forged hashes', async () => {
    const f = fixture(), e = f.state.events[0]; e.commandSnapshot.input.source.sampleFacts.quantity = '99';
    e.commandHash = orderSampleDigest(e.commandSnapshot); e.acknowledgement.commandHash = e.commandHash; e.ackHash = orderSampleDigest(e.acknowledgement);
    f.state.audits[0].detail.commandReceipt = structuredClone({ protocolVersion: e.protocolVersion, requestKey: e.requestKey, commandHash: e.commandHash, commandSnapshot: e.commandSnapshot, ackHash: e.ackHash, acknowledgement: e.acknowledgement });
    await expect(f.read()).rejects.toThrow(/业务内容/);
  });
  it('storage errors propagate and missing protocol delegates have no fallback', async () => {
    const f = fixture(); f.db.auditLog.findMany.mockRejectedValue(Error('synthetic SQL unavailable')); await expect(f.read()).rejects.toThrow('synthetic SQL unavailable');
    const g = fixture(); delete g.db.orderSampleEvent; await expect(g.read()).rejects.toThrow();
  });
});
