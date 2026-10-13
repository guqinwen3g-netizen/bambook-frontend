import { describe, expect, it } from 'vitest';
import { planScenarioMasterData } from './masterData';
import { buildBusinessScenarios, SCENARIO_BUSINESS_TIME } from './scenarios';
import type { ScenarioCommandRecord, ScenarioDriverDependencies } from './driverContract';
import { runDevelopmentScenarios } from './developmentDriver';

const master = planScenarioMasterData({ namespace: 'driver-protocol', nowMs: Date.parse(SCENARIO_BUSINESS_TIME) });
const scenarios = buildBusinessScenarios(master).developments;

function draftProtocol() {
  const cases = new Map<string, Record<string, unknown>>();
  const records = new Map<string, ScenarioCommandRecord>();
  const calls: Array<{ actor: string; method: string; url: string; body?: unknown }> = [];
  const deps: ScenarioDriverDependencies = {
    runtimeId: 'pure-test', actorIds: Object.fromEntries(Object.values(master.cast).map(actor => [actor.key, actor.id])) as Record<keyof typeof master.cast, string>,
    async verifyActor() {},
    journal: { async read(key) { return records.get(key) ?? null; }, async write(record) { records.set(record.key, structuredClone(record)); } },
    async invoke(actor, method, url, input) {
      calls.push({ actor, method, url, body: input });
      const body = input as Record<string, unknown> | undefined;
      if (method === 'get' && url.startsWith('/api/v1/development?')) return { status: 200, body: { ok: true, cases: [...cases.values()] } };
      if (method === 'post' && url === '/api/v1/development') {
        const item = { ...body, id: `case-${cases.size + 1}` }; cases.set(String(item.id), item);
        return { status: 201, body: { ok: true, case: item } };
      }
      const match = url.match(/^\/api\/v1\/development\/([^/?]+)$/);
      if (match) {
        const item = cases.get(decodeURIComponent(match[1]));
        if (!item) return { status: 404, body: { ok: false } };
        if (method === 'put') Object.assign(item, body);
        return { status: 200, body: { ok: true, case: { ...item } } };
      }
      if (method === 'get' && url.endsWith('/batches')) return { status: 200, body: { ok: true, batches: [] } };
      throw new Error(`Unexpected pure protocol call: ${method} ${url}`);
    },
  };
  return { deps, cases, records, calls };
}

/** A strict protocol simulator, not an acceptance fixture. Facts appear only
 * after their corresponding HTTP producer. Nothing here connects to Prisma. */
function developmentProtocol() {
  const f = draftProtocol(), base = f.deps.invoke;
  const batches = new Map<string, Record<string, unknown>>(), suppliers = new Map<string, Record<string, unknown>[]>();
  const reviews = new Map<string, Record<string, unknown>>(), confirmations = new Map<string, Record<string, unknown>>();
  const cards = new Map<string, Record<string, unknown>>(), loans = new Map<string, Record<string, unknown>>();
  const minors = new Map<string, Record<string, unknown>>(), assets = new Map<string, Record<string, unknown>>();
  const decorated = (batch: Record<string, unknown>) => ({ ...batch,
    developmentQcHistory: [...reviews.values()].filter(row => row.sampleVersionId === batch.sampleVersionId),
    versionConfirmationHistory: [...confirmations.values()].filter(row => row.sampleVersionId === batch.sampleVersionId),
    latestFormalQcReview: [...reviews.values()].reverse().find(row => row.sampleVersionId === batch.sampleVersionId && ['reviewed', 'acknowledged'].includes(String(row.status))) ?? null,
    versionConfirmation: [...confirmations.values()].reverse().find(row => row.sampleVersionId === batch.sampleVersionId) ?? null,
    linkedAsset: [...assets.values()].find(row => row.sourceSampleVersionId === batch.sampleVersionId) ?? null,
    microVersions: [...minors.values()].filter(row => row.parentVersionId === batch.sampleVersionId).map(row => ({ ...row,
      developmentQcHistory: [...reviews.values()].filter(review => review.sampleVersionId === row.id), versionConfirmationHistory: [] })),
  });
  f.deps.invoke = async (actor, method, url, input) => {
    const body = (input ?? {}) as Record<string, unknown>;
    if (/^\/api\/v1\/development(?:\?|$)/.test(url) || /^\/api\/v1\/development\/[^/?]+$/.test(url)) return base(actor, method, url, input);
    f.calls.push({ actor, method, url, body: input });
    let match = url.match(/^\/api\/v1\/development\/([^/]+)\/suppliers$/);
    if (match) {
      const caseId = decodeURIComponent(match[1]);
      if (method === 'get') return { status: 200, body: { ok: true, suppliers: suppliers.get(caseId) ?? [] } };
      const item = { ...body, id: `supplier-${caseId}-${String(body.supplierRelationId)}` };
      suppliers.set(caseId, [...suppliers.get(caseId) ?? [], item]); return { status: 201, body: { ok: true, supplier: item } };
    }
    match = url.match(/^\/api\/v1\/(?:development\/([^/]+)\/batches|samples\/garment\/([^/]+)\/rounds)$/);
    if (match) {
      const caseId = decodeURIComponent(match[1] ?? match[2]);
      if (method === 'get') return { status: 200, body: { ok: true, batches: [...batches.values()].filter(row => row.developmentCaseId === caseId).map(decorated) } };
      const id = `batch-${batches.size + 1}`, garment = Boolean(match[2]);
      const commonRequirements = (garment ? body.notes : body.roundNotes) ?? null;
      const item = { ...body, id, developmentCaseId: caseId, sampleVersionId: `version-${id}`, sampleType: garment ? 'garment-round' : 'yardage',
        roundNotes: commonRequirements, trialTask: { factoryRequirements: body.factoryRequirements, targetCompletionDate: body.targetCompletionDate,
          roundRequirementsSnapshot: commonRequirements, currentRoundRequirements: commonRequirements },
        status: 'pending', updatedAt: 100, attachments: { fabricHistory: { revision: 0 } } };
      batches.set(id, item); return { status: 201, body: { ok: true, [garment ? 'round' : 'batch']: item } };
    }
    match = url.match(/^\/api\/v1\/development\/batches\/([^/]+)\/stage$/);
    if (match) {
      const item = batches.get(decodeURIComponent(match[1]))!;
      Object.assign(item, { status: 'making', updatedAt: 101, attachments: { fabricHistory: { revision: 1 } } });
      return { status: 200, body: { ok: true, batch: { ...item } } };
    }
    match = url.match(/^\/api\/v1\/development\/([^/]+)\/batches\/([^/]+)\/(return-results|qc-review)$/);
    if (match) {
      const item = batches.get(decodeURIComponent(match[2]))!;
      if (match[3] === 'return-results') {
        if (item.status !== 'making') throw Error('QC fixture cannot bypass starting');
        Object.assign(item, body, { returnedAt: 102, returnedBy: master.cast[actor].id, returnRequestKey: body.requestKey, updatedAt: 102 });
        for (let index = 0; index < (item.sampleType === 'garment-round' ? 2 : 1); index++) {
          const id = `card-${item.id}-${index}`;
          cards.set(id, { id, devCaseId: match[1], batchId: item.id, warehouseId: body.warehouseId, location: body.location,
            quantity: 1, availableQty: 1, unit: body.actualUnit, physicalLengthQty: item.sampleType === 'yardage' ? body.actualQuantity : null,
            availableLengthQty: item.sampleType === 'yardage' ? body.actualQuantity : null });
        }
        return { status: 200, body: { ok: true, batch: { ...item } } };
      }
      if (!item.returnedAt || ![...cards.values()].some(card => card.batchId === item.id)) throw Error('QC fixture cannot fabricate receipt');
      const review = { id: `review-${reviews.size + 1}`, sampleBatchId: item.id, developmentCaseId: match[1], sampleVersionId: body.sampleVersionId,
        physicalItems: [...cards.values()].filter(card => card.batchId === item.id).map(card => ({ id: card.id })),
        requestKey: body.requestKey, requestedBy: master.cast[actor].id, startedBy: null, status: 'queued', updatedAt: '200', sourceFingerprint: 'a'.repeat(64) };
      reviews.set(review.id, review); return { status: 201, body: { ok: true, item: { ...review } } };
    }
    match = url.match(/^\/api\/v1\/qc\/development-sample-reviews\/([^/]+)\/(handoff-context|claim|complete)$/);
    if (match) {
      const item = reviews.get(decodeURIComponent(match[1]))!;
      if (match[2] === 'handoff-context') return { status: 200, body: { ok: true, data: { item: { ...item }, actorId: master.cast[actor].id,
        expectedUpdatedAt: item.updatedAt, canClaim: item.startedBy == null, canExecute: item.startedBy === master.cast[actor].id && item.status === 'in_progress' } } };
      if (match[2] === 'claim') Object.assign(item, { startedBy: master.cast[actor].id, status: 'in_progress', updatedAt: '201' });
      else {
        if (item.status !== 'in_progress' || item.startedBy !== master.cast[actor].id || item.requestedBy === master.cast[actor].id) throw Error('Actual QC execution required');
        const { requestKey, ...report } = body;
        Object.assign(item, report, { completionRequestKey: requestKey, reviewedBy: master.cast[actor].id, reviewedAt: 202, status: 'reviewed', updatedAt: '202' });
      }
      return { status: 200, body: { ok: true, ...(match[2] === 'claim' ? { data: { item: { ...item } } } : { item: { ...item } }) } };
    }
    match = url.match(/^\/api\/v1\/development\/([^/]+)\/qc-reviews\/([^/]+)\/acknowledge$/);
    if (match) {
      const item = reviews.get(decodeURIComponent(match[2]))!;
      if (item.status !== 'reviewed' || item.reviewedBy === master.cast[actor].id) throw Error('Separate actual business acknowledgment required');
      Object.assign(item, { status: 'acknowledged', acknowledgedBy: master.cast[actor].id, acknowledgedAt: 203 });
      return { status: 200, body: { ok: true, item: { ...item } } };
    }
    match = url.match(/^\/api\/v1\/development\/([^/]+)\/sample-versions\/([^/]+)\/(confirmations|minors)$/);
    if (match) {
      if (match[3] === 'minors') {
        const item = { ...body, id: `minor-${minors.size + 1}`, parentVersionId: match[2], versionKind: 'minor' };
        minors.set(item.id, item); return { status: 201, body: { ok: true, item } };
      }
      const item = { ...body, id: `confirmation-${confirmations.size + 1}`, sampleVersionId: match[2], developmentCaseId: match[1], recordedBy: master.cast[actor].id };
      confirmations.set(item.id, item); return { status: 201, body: { ok: true, item } };
    }
    if (method === 'get' && url.includes('/version-confirmations?')) {
      const versionId = new URL(url, 'http://pure.invalid').searchParams.get('versionIds');
      return { status: 200, body: { ok: true, items: [...confirmations.values()].filter(item => item.sampleVersionId === versionId) } };
    }
    match = url.match(/^\/api\/v1\/development\/([^/]+)\/convert-to-asset$/);
    if (match) {
      const passed = [...reviews.values()].some(item => item.sampleVersionId === body.sourceVersionId && item.result === 'pass' && ['reviewed', 'acknowledged'].includes(String(item.status)));
      if (!passed) throw Error('Archive fixture cannot fabricate QC');
      const asset = { id: `asset-${assets.size + 1}`, sourceSampleVersionId: body.sourceVersionId, sourceDevelopmentCaseId: match[1] };
      assets.set(asset.id, asset);
      return { status: 200, body: { ok: true, asset, conversionReceipt: { requestKey: body.requestKey, caseId: match[1], sampleVersionId: body.sourceVersionId,
        sourceSampleBatchId: body.sourceRoundId, sourceType: body.sourceType, sourceId: body.sourceId, productAssetId: asset.id, auditId: `audit-${asset.id}` } } };
    }
    if (method === 'get' && url.startsWith('/api/v1/samples/room/items?')) {
      const caseId = new URL(url, 'http://pure.invalid').searchParams.get('devCaseId');
      return { status: 200, body: { ok: true, items: [...cards.values()].filter(card => card.devCaseId === caseId) } };
    }
    match = url.match(/^\/api\/v1\/samples\/room\/items\/([^/]+)\/loans$/);
    if (match) {
      const card = cards.get(decodeURIComponent(match[1]))!, id = `loan-${loans.size + 1}`;
      const loan = { ...body, id, itemId: card.id, loanType: 'borrow', operatorId: master.cast[actor].id, returnedAt: null, meterRequestKey: body.requestKey };
      loans.set(id, loan);
      if (body.loanLength) card.availableLengthQty = String(Number(card.availableLengthQty) - Number(body.loanLength)); else card.availableQty = 0;
      return { status: 201, body: { ok: true, loan: { ...loan }, item: { ...card } } };
    }
    if (method === 'get' && url.startsWith('/api/v1/samples/room/loans?')) {
      const itemId = new URL(url, 'http://pure.invalid').searchParams.get('itemId');
      return { status: 200, body: { ok: true, loans: [...loans.values()].filter(loan => loan.itemId === itemId) } };
    }
    throw Error(`Unimplemented producer ${method} ${url}`);
  };
  const native = f.deps.invoke, receipts = new Map<string, { body: string; response: Awaited<ReturnType<typeof native>> }>();
  f.deps.invoke = async (actor, method, url, input) => {
    const requestKey = input && typeof input === 'object' && 'requestKey' in input ? input.requestKey : undefined;
    const key = typeof requestKey === 'string' ? `${actor}:${method}:${url}:${requestKey}` : null;
    const prior = key ? receipts.get(key) : undefined;
    if (prior) {
      f.calls.push({ actor, method, url, body: input });
      if (prior.body !== JSON.stringify(input)) return { status: 409, body: { ok: false, error: { code: 'REQUEST_CONFLICT' } } };
      return structuredClone(prior.response);
    }
    const response = await native(actor, method, url, input);
    if (key && response.status < 300) receipts.set(key, { body: JSON.stringify(input), response: structuredClone(response) });
    return response;
  };
  return { ...f, batches, reviews, confirmations, cards, loans, minors, assets };
}

describe('development scenario driver (pure HTTP protocol, no database)', () => {
  it('earns draft and planning through the actual owner commands without making sampling, QC or stock facts', async () => {
    const f = draftProtocol();
    const selected = scenarios.filter(row => row.stopAfter === 'draft' || row.stopAfter === 'planning');
    const result = await runDevelopmentScenarios(master, selected, f.deps);
    expect(result.executions).toHaveLength(4);
    expect(result.executions.every(row => row.stopReached)).toBe(true);
    expect(result.archives).toEqual([]);
    expect(f.calls.filter(row => row.method === 'post')).toHaveLength(4);
    expect(f.calls.filter(row => row.method === 'put')).toHaveLength(2);
    for (const scenario of selected) {
      const item = [...f.cases.values()].find(row => row.code === scenario.key)!;
      expect(item.ownerId).toBe(master.cast[scenario.owner].id);
      expect(item.name).toBe(scenario.family === 'fabric' ? '羊毛斜纹 · 280gsm · AW26开发' : '羊毛单排扣西装 · AW26开发');
      expect(item.nextAction).toBe(scenario.description);
      if (scenario.stopAfter === 'planning') {
        expect(item.developmentDirection).not.toContain(scenario.description);
        expect(scenario.family === 'fabric' ? item.specComposition : item.styleSpec).toBe(scenario.family === 'fabric' ? '100% Wool' : 'Tailored blazer');
      }
      expect(item.customerRelationId).toBe(scenario.customerId);
      const execution = result.executions.find(row => row.key === scenario.key)!;
      expect(execution.ids.caseId).toBe(item.id);
      expect(execution.earnedSteps).toContain('case_created');
      expect(execution.earnedSteps.includes('planning_saved')).toBe(scenario.stopAfter === 'planning');
      if (scenario.stopAfter === 'planning') expect(item.targetDate).toBe(scenario.plannedReturnDate);
    }
  });

  it('earns 24 distinct stops through real endpoint contracts and exports only independently approved exact archives', async () => {
    const f = developmentProtocol(), result = await runDevelopmentScenarios(master, scenarios, f.deps);
    expect(result.executions).toHaveLength(24);
    expect(result.executions.filter(row => row.stopReached)).toHaveLength(22);
    expect(result.executions.filter(row => !row.stopReached).map(row => row.blockedAt)).toEqual(['development_ci_finance', 'development_ci_finance']);
    expect(result.archives).toHaveLength(8);
    expect(f.minors.size).toBe(2);
    for (const archive of result.archives) {
      const confirmation = f.confirmations.get(archive.confirmationId)!;
      const review = f.reviews.get(archive.reviewId)!;
      expect(review.result).toBe('pass'); expect(review.reviewedBy).not.toBe(confirmation.recordedBy);
      expect(confirmation.result).toBe('approved'); expect(confirmation.sampleVersionId).toBe(archive.versionId);
      expect(f.assets.get(archive.assetId)?.sourceSampleVersionId).toBe(archive.versionId);
      if (!archive.customerId) expect(confirmation.confirmerUserId).not.toBe(confirmation.recordedBy);
    }
    expect(f.calls.filter(row => row.url.endsWith('/complete')).every(row => (row.body as Record<string, unknown>).inspectionDate === '2026-10-08')).toBe(true);
    expect(f.calls.some(row => row.url.includes('sample-nodes') || row.url.includes('/register-received'))).toBe(false);
    for (const scenario of scenarios.filter(row => row.stopAfter === 'multi_factory_sampling')) {
      const execution = result.executions.find(row => row.key === scenario.key)!;
      const versions = execution.ids.versionIds as string[];
      expect(new Set(versions).size).toBe(2);
      expect([...f.batches.values()].filter(row => row.developmentCaseId === execution.ids.caseId).every(row => row.status === 'making' && !row.returnedAt)).toBe(true);
    }
    for (const scenario of scenarios.filter(row => row.stopAfter === 'minor_version_review')) {
      const execution = result.executions.find(row => row.key === scenario.key)!;
      const minorReview = f.reviews.get(String(execution.ids.minorReviewId))!;
      expect(minorReview.sampleVersionId).toBe(execution.ids.minorVersionId);
      expect(minorReview.status).toBe('queued'); expect(minorReview.result).toBeUndefined();
    }
  });

  it('sends garment common round requirements using the actual notes field and checks its exact factory version snapshot', async () => {
    const f = developmentProtocol(), scenario = scenarios.find(s => s.family === 'garment' && s.stopAfter === 'multi_factory_sampling')!;
    const result = await runDevelopmentScenarios(master, [scenario], f.deps);
    expect(result.executions[0].stopReached).toBe(true);
    const common = '本轮共同核对成分、手感、版型与制作要求，各工厂要求独立保存。';
    const plans = f.calls.filter(c => c.method === 'post' && c.url.endsWith('/rounds'));
    expect(plans).toHaveLength(2);
    for (const plan of plans) {
      expect(plan.body).toMatchObject({ notes: common }); expect(plan.body).not.toHaveProperty('roundNotes');
    }
    for (const batch of f.batches.values()) expect(batch.trialTask).toMatchObject({ roundRequirementsSnapshot: common, currentRoundRequirements: common });
  });

  for (const family of ['fabric', 'garment'] as const) {
    it(`blocks ${family} before sampling when a successful plan ACK has lost the current version's common requirements`, async () => {
      const f = developmentProtocol(), native = f.deps.invoke;
      const scenario = scenarios.find(s => s.family === family && s.stopAfter === 'multi_factory_sampling')!;
      f.deps.invoke = async (...args) => {
        const response = await native(...args);
        if (args[1] === 'get' && args[2].endsWith('/batches')) {
          const body = response.body as Record<string, unknown>;
          for (const batch of body.batches as Array<Record<string, unknown>>) (batch.trialTask as Record<string, unknown>).roundRequirementsSnapshot = null;
        }
        return response;
      };
      const result = await runDevelopmentScenarios(master, [scenario], f.deps);
      expect(result.executions[0]).toMatchObject({ stopReached: false, blockedAt: 'factory_tasks_planned', blockedReason: 'SOURCE_MISMATCH: exact version common round requirements' });
      expect(f.calls.filter(c => c.url.endsWith('/stage'))).toHaveLength(0); expect(f.cards.size).toBe(0);
    });
  }

  it('resumes every earned case with fresh reads and no duplicate create, QC, confirmation, archive or borrow commands', async () => {
    const f = developmentProtocol();
    const first = await runDevelopmentScenarios(master, scenarios, f.deps);
    const writesBefore = f.calls.filter(row => row.method !== 'get').length;
    const readsBefore = f.calls.filter(row => row.method === 'get').length;
    const second = await runDevelopmentScenarios(master, scenarios, f.deps);
    expect(second).toEqual(first);
    expect(f.calls.filter(row => row.method !== 'get')).toHaveLength(writesBefore);
    expect(f.calls.filter(row => row.method === 'get').length).toBeGreaterThan(readsBefore);
  });

  it('recovers a committed QC report with its original key and unchanged content after its ACK was lost', async () => {
    const f = developmentProtocol(), native = f.deps.invoke;
    const scenario = scenarios.find(row => row.family === 'fabric' && row.stopAfter === 'archived_and_borrowed')!;
    let loseAck = true;
    f.deps.invoke = async (...input) => {
      const response = await native(...input);
      if (loseAck && input[1] === 'post' && input[2].endsWith('/complete')) { loseAck = false; throw Error('ACK_LOST_AFTER_COMMIT'); }
      return response;
    };
    const first = await runDevelopmentScenarios(master, [scenario], f.deps);
    expect(first.executions[0].stopReached).toBe(false);
    expect(first.executions[0].blockedAt).toBe('qc_completed');
    expect(first.archives).toEqual([]); expect(f.reviews.size).toBe(1);
    const second = await runDevelopmentScenarios(master, [scenario], f.deps);
    expect(second.executions[0].stopReached).toBe(true);
    expect(second.archives).toHaveLength(1); expect(f.reviews.size).toBe(1); expect(f.cards.size).toBe(1); expect(f.loans.size).toBe(1);
    const submits = f.calls.filter(row => row.url.endsWith('/complete'));
    expect(submits).toHaveLength(2); expect(submits[1].body).toEqual(submits[0].body);
    expect(f.calls.filter(row => row.method === 'post' && row.url === '/api/v1/development')).toHaveLength(1);
    expect(f.calls.filter(row => row.method === 'post' && row.url.endsWith('/batches'))).toHaveLength(1);
  });

  it('reconciles a committed non-idempotent plan by unique real source readback without replaying its create', async () => {
    const f = developmentProtocol(), native = f.deps.invoke;
    const scenario = scenarios.find(row => row.family === 'garment' && row.stopAfter === 'qc_queued')!;
    let loseAck = true;
    f.deps.invoke = async (...input) => {
      const response = await native(...input);
      if (loseAck && input[1] === 'post' && input[2].endsWith('/rounds')) { loseAck = false; throw Error('PLAN_ACK_LOST_AFTER_COMMIT'); }
      return response;
    };
    const first = await runDevelopmentScenarios(master, [scenario], f.deps);
    expect(first.executions[0].blockedAt).toBe('factory_tasks_planned');
    expect(f.batches.size).toBe(1); expect(f.cards.size).toBe(0);
    const second = await runDevelopmentScenarios(master, [scenario], f.deps);
    expect(second.executions[0].stopReached).toBe(true); expect(f.batches.size).toBe(1); expect(f.cards.size).toBe(2);
    expect(f.calls.filter(row => row.method === 'post' && row.url.endsWith('/rounds'))).toHaveLength(1);
  });

  it('leaves an unknown non-idempotent create blocked when no real record can be read back', async () => {
    const f = draftProtocol(), native = f.deps.invoke, scenario = scenarios.find(row => row.stopAfter === 'draft')!;
    let attempts = 0;
    f.deps.invoke = async (...input) => {
      if (input[1] === 'post' && input[2] === '/api/v1/development') { attempts++; throw Error('TRANSPORT_UNKNOWN_NO_RECORD'); }
      return native(...input);
    };
    const first = await runDevelopmentScenarios(master, [scenario], f.deps), second = await runDevelopmentScenarios(master, [scenario], f.deps);
    expect(first.executions[0].stopReached).toBe(false); expect(second.executions[0].stopReached).toBe(false);
    expect(second.executions[0].blockedReason).toContain('SCENARIO_ACK_UNKNOWN_RECONCILE_REQUIRED');
    expect(attempts).toBe(1); expect(f.cases.size).toBe(0); expect(second.executions[0].ids).toEqual({});
  });

  it('keeps unknown QC intent and its original content when current actual account verification is revoked', async () => {
    const f = developmentProtocol(), native = f.deps.invoke;
    const scenario = scenarios.find(row => row.stopAfter === 'internal_request' && row.family === 'garment')!;
    let lost = false;
    f.deps.invoke = async (...input) => {
      const response = await native(...input);
      if (!lost && input[2].endsWith('/complete')) { lost = true; throw Error('ACK_LOST_AFTER_COMMIT'); }
      return response;
    };
    await runDevelopmentScenarios(master, [scenario], f.deps);
    const pending = [...f.records.values()].find(row => row.url.endsWith('/complete'))!;
    expect(pending.state).toBe('intent');
    f.deps.verifyActor = async actor => { if (actor === scenario.qc) throw Error('ACTUAL_QC_ACCOUNT_REVOKED'); };
    const resumed = await runDevelopmentScenarios(master, [scenario], f.deps);
    expect(resumed.executions[0].stopReached).toBe(false); expect(resumed.archives).toEqual([]);
    expect(resumed.executions[0].blockedReason).toContain('ACTUAL_QC_ACCOUNT_REVOKED');
    expect(f.records.get(pending.key)).toEqual(pending); expect(f.confirmations.size).toBe(0);
  });

  it('refuses prior journal facts from another runtime or a different actual account even when source IDs still exist', async () => {
    const f = draftProtocol(), scenario = scenarios.find(row => row.stopAfter === 'planning')!;
    expect((await runDevelopmentScenarios(master, [scenario], f.deps)).executions[0].stopReached).toBe(true);
    const writes = f.calls.filter(row => row.method !== 'get').length;
    const second = await runDevelopmentScenarios(master, [scenario], { ...f.deps, runtimeId: 'another-database-epoch' });
    expect(second.executions[0].stopReached).toBe(false); expect(second.executions[0].blockedReason).toContain('SCENARIO_COMMAND_CHANGED');
    const third = await runDevelopmentScenarios(master, [scenario], { ...f.deps, actorIds: { ...f.deps.actorIds, [scenario.owner]: 'unrelated-actual-user' } });
    expect(third.executions[0].stopReached).toBe(false); expect(f.calls.filter(row => row.method !== 'get')).toHaveLength(writes);
  });

  it('reports known first-factory IDs when a second factory plan is rejected, and never declares the multi-factory stop earned', async () => {
    const f = developmentProtocol(), native = f.deps.invoke;
    const scenario = scenarios.find(row => row.stopAfter === 'multi_factory_sampling')!;
    f.deps.invoke = async (...input) => {
      const body = input[3] as Record<string, unknown> | undefined;
      if (input[1] === 'post' && input[2].endsWith('/batches') && body?.supplierRelationId === scenario.supplierIds[1]) return { status: 403, body: { ok: false, error: { code: 'FORBIDDEN' } } };
      return native(...input);
    };
    const result = await runDevelopmentScenarios(master, [scenario], f.deps), execution = result.executions[0];
    expect(execution.stopReached).toBe(false); expect(execution.blockedAt).toBe('factory_tasks_planned');
    expect(execution.ids.batchIds).toHaveLength(1); expect(execution.ids.versionIds).toHaveLength(1);
    expect(execution.earnedSteps).not.toContain('factory_tasks_planned'); expect(f.cards.size).toBe(0); expect(f.reviews.size).toBe(0);
  });

  it('blocks a QC response for another version and does not substitute parent or historical pass facts', async () => {
    const f = developmentProtocol(), native = f.deps.invoke, scenario = scenarios.find(row => row.stopAfter === 'qc_queued')!;
    f.deps.invoke = async (...input) => {
      const response = await native(...input);
      if (input[1] === 'post' && input[2].endsWith('/qc-review')) {
        const body = response.body as { ok: boolean; item: Record<string, unknown> };
        return { ...response, body: { ...body, item: { ...body.item, sampleVersionId: 'different-version' } } };
      }
      return response;
    };
    const result = await runDevelopmentScenarios(master, [scenario], f.deps);
    expect(result.executions[0].stopReached).toBe(false); expect(result.executions[0].blockedAt).toBe('qc_requested');
    expect(result.executions[0].blockedReason).toContain('formal QC exact version'); expect(result.archives).toEqual([]);
    expect(f.calls.some(row => row.url.endsWith('/claim') || row.url.endsWith('/complete'))).toBe(false);
  });

  it('does not rewrite a completed NOK report when a later recipe asks the same key for PASS', async () => {
    const f = developmentProtocol(), scenario = scenarios.find(row => row.stopAfter === 'qc_rework')!;
    expect((await runDevelopmentScenarios(master, [scenario], f.deps)).executions[0].stopReached).toBe(true);
    const result = await runDevelopmentScenarios(master, [{ ...scenario, stopAfter: 'archived_and_borrowed' }], f.deps);
    expect(result.executions[0].stopReached).toBe(false); expect(result.executions[0].blockedReason).toContain('SCENARIO_COMMAND_CHANGED');
    expect([...f.reviews.values()].map(row => row.result)).toEqual(['reject']); expect(f.assets.size).toBe(0);
  });

  it('does not export a previously archived version when current readback has a later formal NOK result', async () => {
    const f = developmentProtocol(), native = f.deps.invoke, scenario = scenarios.find(row => row.stopAfter === 'internal_request')!;
    f.deps.invoke = async (...input) => {
      const response = await native(...input);
      if (input[1] === 'get' && input[2].endsWith('/batches') && f.assets.size) {
        const body = response.body as { ok: boolean; batches: Record<string, unknown>[] };
        return { ...response, body: { ...body, batches: body.batches.map(batch => ({ ...batch,
          latestFormalQcReview: { id: 'new-formal-review', sampleVersionId: batch.sampleVersionId, result: 'reject', status: 'reviewed' } })) } };
      }
      return response;
    };
    const result = await runDevelopmentScenarios(master, [scenario], f.deps);
    expect(result.executions[0].stopReached).toBe(false); expect(result.executions[0].ids.assetId).toBeDefined();
    expect(result.archives).toEqual([]); expect(result.executions[0].blockedReason).toContain('latest formal QC');
  });
});
