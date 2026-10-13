/** Real producer orchestration only. The caller owns login, target verification,
 * business clock, persistence and transport. No client, environment or seed writes. */
import { createHash } from 'node:crypto';
import { scenarioCommand, type ScenarioDriverDependencies, type ScenarioExecution, type ScenarioHttpMethod } from './driverContract';
import type { ScenarioActorKey, ScenarioMasterData } from './masterData';
import type { DevelopmentScenario } from './scenarios';
import { SCENARIO_BUSINESS_TIME } from './scenarios';

type Row = Record<string, unknown>;
export interface DevelopmentConfirmedArchive {
  scenarioKey: string; family: 'fabric' | 'garment'; caseId: string; batchId: string; versionId: string;
  assetId: string; reviewId: string; confirmationId: string; factoryId: string; customerId: string | null;
  ownerActorKey: ScenarioActorKey; physicalCardIds: string[];
}
export interface DevelopmentScenarioExecution extends ScenarioExecution {
  family: 'fabric' | 'garment'; blockedReason?: string; archive?: DevelopmentConfirmedArchive;
}
export interface DevelopmentDriverResult {
  executions: DevelopmentScenarioExecution[]; archives: DevelopmentConfirmedArchive[];
}

const object = (value: unknown, context: string): Row => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`INVALID_READBACK: ${context}`);
  return value as Row;
};
const objects = (value: unknown, context: string): Row[] => {
  if (!Array.isArray(value)) throw Error(`INVALID_READBACK: ${context} must be a list`);
  return value.map(item => object(item, context));
};
const text = (value: unknown, context: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw Error(`INVALID_READBACK: ${context} is missing`);
  return value;
};
const same = (actual: unknown, expected: unknown, context: string) => {
  if (actual !== expected) throw Error(`SOURCE_MISMATCH: ${context}`);
};
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const commandKey = (scenario: DevelopmentScenario, step: string): string => `devsim:${scenario.key}:${createHash('sha256').update(step).digest('hex').slice(0, 24)}`;
const route = (caseId: string) => `/api/v1/development/${encodeURIComponent(caseId)}`;

function scenarioContext(master: ScenarioMasterData, scenario: DevelopmentScenario) {
  const team = master.businessTeams.find(row => row.key === scenario.teamKey && row.businessFamily === scenario.family);
  const owner = master.cast[scenario.owner], qc = master.cast[scenario.qc];
  if (!team || !owner || !qc || !team.memberIds.includes(owner.id) || owner.id === qc.id) throw Error('SCENARIO_RESPONSIBILITY_INVALID');
  const customer = scenario.customerId ? master.catalog.customers.find(row => row.id === scenario.customerId
    && row.businessFamily === scenario.family && team.customerIds.includes(row.id)) : null;
  if (scenario.customerId && !customer) throw Error('SCENARIO_CUSTOMER_INVALID');
  const factories = scenario.supplierIds.map(id => {
    const factory = master.catalog.suppliers.find(row => row.id === id && row.businessFamily === scenario.family
      && row.kind === (scenario.family === 'fabric' ? 'fabric_mill' : 'garment_factory') && team.supplierIds.includes(row.id));
    if (!factory) throw Error('SCENARIO_FACTORY_INVALID');
    return factory;
  });
  if (!factories.length || new Set(scenario.supplierIds).size !== factories.length) throw Error('SCENARIO_FACTORY_INVALID');
  const requester = Object.values(master.cast).find(row => row.id === (owner.id === team.salespersonId ? team.leaderId : team.salespersonId));
  if (!requester || requester.id === owner.id || !team.memberIds.includes(requester.id)) throw Error('SCENARIO_INTERNAL_REQUESTER_INVALID');
  return { team, owner, qc, customer, factories, requester };
}

async function runOne(master: ScenarioMasterData, scenario: DevelopmentScenario, deps: ScenarioDriverDependencies): Promise<DevelopmentScenarioExecution> {
  const result: DevelopmentScenarioExecution = { key: scenario.key, family: scenario.family, earnedSteps: [], stopReached: false, ids: {} };
  let currentStep = 'validate_scenario';
  const earn = (step: string) => { if (!result.earnedSteps.includes(step)) result.earnedSteps.push(step); };
  const read = async (actor: ScenarioActorKey, url: string): Promise<Row> => {
    if (!deps.runtimeId?.trim() || deps.actorIds[actor] !== master.cast[actor].id) throw Error('SCENARIO_RUNTIME_IDENTITY_MISMATCH');
    await deps.verifyActor(actor);
    const response = await deps.invoke(actor, 'get', url);
    const body = object(response.body, url);
    if (response.status !== 200 || body.ok !== true) throw Error(`READBACK_REJECTED: ${url}: HTTP ${response.status}: ${JSON.stringify(body)}`);
    return body;
  };
  const command = async (step: string, actor: ScenarioActorKey, method: ScenarioHttpMethod, url: string, body: Row,
    idempotent: boolean, casFields: string[] = [], expectedStatus: number | number[] = [200, 201]): Promise<Row> => {
    const key = commandKey(scenario, step), prior = await deps.journal.read(key);
    let originalBody: unknown = body;
    if (prior) {
      const withoutCas = (value: unknown) => Object.fromEntries(Object.entries(object(value, `${step} original command`)).filter(([field]) => !casFields.includes(field)));
      if (JSON.stringify(canonical(withoutCas(prior.body))) !== JSON.stringify(canonical(withoutCas(body)))) throw Error(`SCENARIO_COMMAND_CHANGED: ${key}`);
      originalBody = prior.body;
    }
    return object(await scenarioCommand(deps, { key, actor, method, url, body: originalBody, idempotent, expectedStatus }), step);
  };
  const checkCreateIntent = async (step: string, actor: ScenarioActorKey, method: ScenarioHttpMethod, url: string, body: Row, expectedStatus: number) => {
    if (!await deps.journal.read(commandKey(scenario, step))) return;
    // The shared verifier checks runtime, actual user, unchanged payload and
    // retry policy before accepting an ACK or refusing an unknown create.
    try { await command(step, actor, method, url, body, false, [], expectedStatus); }
    catch (error) { if (!(error instanceof Error) || !error.message.startsWith('SCENARIO_ACK_UNKNOWN_RECONCILE_REQUIRED:')) throw error; }
  };
  try {
    const context = scenarioContext(master, scenario), { owner, customer, team } = context;
    currentStep = 'case_created';
    const productName = scenario.family === 'fabric' ? '羊毛斜纹 · 280gsm' : '羊毛单排扣西装';
    const createBody: Row = { code: scenario.key, name: `${productName} · AW26开发`, nextAction: scenario.description,
      type: scenario.family, ownerId: owner.id, departmentId: team.departmentId, initiator: customer ? 'customer' : 'internal',
      customerInput: 'spec-direction', ...(customer ? { customerRelationId: customer.id, customerName: customer.name } : {}),
      source: customer ? 'customer-request' : 'internal-request' };
    const priorCreate = await deps.journal.read(commandKey(scenario, 'create-case'));
    await checkCreateIntent('create-case', scenario.owner, 'post', '/api/v1/development', createBody, 201);
    let development: Row;
    if (priorCreate?.state === 'acknowledged') {
      const saved = object(object(priorCreate.response?.body, 'create case ACK').case, 'created case');
      development = object((await read(scenario.owner, route(text(saved.id, 'case id')))).case, 'current case');
    } else {
      const listed = await read(scenario.owner, `/api/v1/development?type=${scenario.family}&search=${encodeURIComponent(scenario.key)}&limit=200`);
      const matches = objects(listed.cases, 'case candidates').filter(row => row.code === scenario.key);
      if (matches.length > 1) throw Error('AMBIGUOUS_CASE_READBACK');
      if (matches.length === 1) development = object((await read(scenario.owner, route(text(matches[0].id, 'case id')))).case, 'current case');
      else {
        const created = await command('create-case', scenario.owner, 'post', '/api/v1/development', createBody, false, [], 201);
        const saved = object(created.case, 'created case'); result.ids.caseId = text(saved.id, 'case id');
        development = object((await read(scenario.owner, route(result.ids.caseId))).case, 'current case');
      }
    }
    same(development.code, scenario.key, 'case code'); same(development.type, scenario.family, 'case family');
    same(development.ownerId, owner.id, 'actual owner'); same(development.customerRelationId ?? null, scenario.customerId, 'actual customer');
    const caseId = text(development.id, 'case id'); result.ids.caseId = caseId; earn('case_created');
    if (scenario.stopAfter === 'draft') { result.stopReached = true; return result; }

    currentStep = 'planning_saved';
    const plan: Row = { targetDate: scenario.plannedReturnDate, developmentDirection: scenario.family === 'fabric' ? '100%羊毛斜纹，280gsm，门幅150cm；柔软整理，核对手感与尺寸稳定性。' : '羊毛单排扣西装，M码；核对肩宽、胸围及驳头工艺。',
      ...(scenario.family === 'fabric' ? { specComposition: '100% Wool', specWeight: '280', specWidth: '150', specWeave: 'Twill', specFinish: 'Soft' }
        : { styleSpec: 'Tailored blazer', sizeSpec: 'M', fabricSpec: '100% Wool / 280gsm', processSpec: 'Tailored construction' }) };
    await checkCreateIntent('save-plan', scenario.owner, 'put', route(caseId), plan, 200);
    if (!Object.entries(plan).every(([field, value]) => development[field] === value)) {
      await command('save-plan', scenario.owner, 'put', route(caseId), plan, false, [], 200);
      development = object((await read(scenario.owner, route(caseId))).case, 'saved plan');
    }
    for (const [field, value] of Object.entries(plan)) same(development[field], value, `plan ${field}`);
    earn('planning_saved');
    if (scenario.stopAfter === 'planning') { result.stopReached = true; return result; }
    currentStep = 'factory_tasks_planned';
    const listBatches = async () => objects((await read(scenario.owner, `${route(caseId)}/batches`)).batches, 'current sample batches');
    const currentBatch = async (id: string) => {
      const matches = (await listBatches()).filter(row => row.id === id);
      if (matches.length !== 1) throw Error('EXACT_BATCH_READBACK_REQUIRED');
      return matches[0];
    };
    const batches: Row[] = [];
    result.ids.factoryIds = context.factories.map(row => row.id); result.ids.batchIds = []; result.ids.versionIds = [];
    for (const factory of context.factories) {
      await checkCreateIntent(`add-factory:${factory.id}`, scenario.owner, 'post', `${route(caseId)}/suppliers`,
        { supplierRelationId: factory.id, supplierName: factory.name }, 201);
      const suppliers = objects((await read(scenario.owner, `${route(caseId)}/suppliers`)).suppliers, 'participating factories');
      if (!suppliers.some(row => row.supplierRelationId === factory.id)) {
        await command(`add-factory:${factory.id}`, scenario.owner, 'post', `${route(caseId)}/suppliers`,
          { supplierRelationId: factory.id, supplierName: factory.name }, false, [], 201);
        if (!objects((await read(scenario.owner, `${route(caseId)}/suppliers`)).suppliers, 'saved factory').some(row => row.supplierRelationId === factory.id)) throw Error('FACTORY_READBACK_REQUIRED');
      }
      const factoryRequirements = `${factory.name}：${plan.developmentDirection} 按本厂要求独立试样，保留实际数量与本厂版本。`;
      const roundRequirements = '本轮共同核对成分、手感、版型与制作要求，各工厂要求独立保存。';
      const planBody: Row = { round: 1, supplierRelationId: factory.id, supplierName: factory.name,
        factoryRequirements,
        targetCompletionDate: scenario.plannedReturnDate,
        ...(scenario.family === 'fabric' ? { roundNotes: roundRequirements, sampleTypes: ['yardage'], samplePlans: [{ sampleType: 'yardage', quantity: 10.5, unit: '米' }] }
          : { notes: roundRequirements, purpose: '版型与工艺确认', version: 'V1', materialConfig: '100% Wool / Tailored', plannedQuantity: 2, plannedUnit: '件' }) };
      const step = `plan-factory:${factory.id}`, prior = await deps.journal.read(commandKey(scenario, step));
      const planUrl = scenario.family === 'fabric' ? `${route(caseId)}/batches` : `/api/v1/samples/garment/${encodeURIComponent(caseId)}/rounds`;
      await checkCreateIntent(step, scenario.owner, 'post', planUrl, planBody, 201);
      let matches = (await listBatches()).filter(row => row.supplierRelationId === factory.id && Number(row.round) === 1
        && row.sampleType === (scenario.family === 'fabric' ? 'yardage' : 'garment-round'));
      if (prior?.state === 'acknowledged') {
        const ack = object(prior.response?.body, 'sample planning ACK');
        const saved = object(ack.batch ?? ack.round, 'planned source'); matches = matches.filter(row => row.id === saved.id);
      }
      if (matches.length > 1) throw Error('AMBIGUOUS_FACTORY_VERSION_READBACK');
      let batch: Row;
      if (matches.length) batch = matches[0];
      else {
        const planned = await command(step, scenario.owner, 'post', planUrl, planBody, false, [], 201);
        const saved = object(planned.batch ?? planned.round, 'planned sample');
        result.ids.batchIds = [...batches.map(row => text(row.id, 'batch id')), text(saved.id, 'batch id')];
        if (typeof saved.sampleVersionId === 'string') result.ids.versionIds = [...batches.map(row => text(row.sampleVersionId, 'version id')), saved.sampleVersionId];
        batch = await currentBatch(text(saved.id, 'batch id'));
      }
      same(batch.developmentCaseId, caseId, 'batch case'); same(batch.supplierRelationId, factory.id, 'batch factory');
      text(batch.sampleVersionId, 'accurate factory version');
      const task = object(batch.trialTask, 'accurate factory task');
      same(task.roundRequirementsSnapshot, roundRequirements, 'exact version common round requirements');
      same(task.currentRoundRequirements, roundRequirements, 'current common round requirements');
      same(task.factoryRequirements, factoryRequirements, 'factory task requirements');
      same(task.targetCompletionDate, scenario.plannedReturnDate, 'factory task planned return date');
      batches.push(batch);
      result.ids.batchIds = batches.map(row => text(row.id, 'batch id')); result.ids.versionIds = batches.map(row => text(row.sampleVersionId, 'version id'));
    }
    result.ids.factoryIds = context.factories.map(row => row.id);
    result.ids.batchIds = batches.map(row => text(row.id, 'batch id'));
    result.ids.versionIds = batches.map(row => text(row.sampleVersionId, 'version id'));
    if (new Set(result.ids.versionIds).size !== batches.length) throw Error('FACTORY_VERSIONS_NOT_INDEPENDENT');
    earn('factory_tasks_planned');
    currentStep = 'sampling_started';
    const revision = (batch: Row): number => {
      const attachments = batch.attachments == null ? {} : object(batch.attachments, 'batch attachments');
      const history = attachments.fabricHistory == null ? {} : object(attachments.fabricHistory, 'fabric history');
      const value = history.revision ?? 0;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw Error('BATCH_REVISION_UNKNOWN');
      return value;
    };
    for (let index = 0; index < batches.length; index++) {
      const batch = batches[index], batchId = text(batch.id, 'batch id'), step = `start:${batchId}`;
      await command(step, scenario.owner, 'patch', `/api/v1/development/batches/${encodeURIComponent(batchId)}/stage`,
        { action: 'start', requestKey: commandKey(scenario, step), expectedRevision: revision(batch), expectedRound: Number(batch.round) }, true, ['expectedRevision'], 200);
      batches[index] = await currentBatch(batchId);
      same(batches[index].status, 'making', 'started sample status');
    }
    earn('sampling_started');
    if (scenario.stopAfter === 'multi_factory_sampling') {
      if (batches.length < 2 || batches.some(row => row.returnedAt != null)) throw Error('MULTI_FACTORY_SAMPLING_STOP_CHANGED');
      result.stopReached = true; return result;
    }

    currentStep = 'returned_and_library_synced';
    if (batches.length !== 1) throw Error('SINGLE_EXACT_SOURCE_REQUIRED');
    let batch = batches[0]; const batchId = text(batch.id, 'batch id'), versionId = text(batch.sampleVersionId, 'version id');
    result.ids.batchId = batchId; result.ids.versionId = versionId;
    const sampleWarehouses = master.catalog.warehouses.filter(row => row.code === `${master.namespace}-WH-SAMPLE`);
    const locations = master.catalog.locations.filter(row => row.businessFamily === scenario.family && sampleWarehouses.some(warehouse => warehouse.id === row.warehouseId));
    if (locations.length !== 1) throw Error('EXPLICIT_SAMPLE_LOCATION_REQUIRED');
    const placement = locations[0], returnStep = `return:${batchId}`;
    if (typeof batch.updatedAt !== 'number' && typeof batch.updatedAt !== 'string') throw Error('BATCH_UPDATED_AT_UNKNOWN');
    await command(returnStep, scenario.owner, 'post', `${route(caseId)}/batches/${encodeURIComponent(batchId)}/return-results`, {
      requestKey: commandKey(scenario, returnStep), expectedBatchUpdatedAt: String(batch.updatedAt), actualQuantity: scenario.family === 'fabric' ? '10.5' : '2',
      actualUnit: scenario.family === 'fabric' ? '米' : '件', notes: `${scenario.description}；实际收到本厂返样，按实物登记。`,
      warehouseId: placement.warehouseId, location: placement.location, locationDetail: placement.locationDetail,
    }, true, ['expectedBatchUpdatedAt'], 200);
    batch = await currentBatch(batchId);
    same(batch.sampleVersionId, versionId, 'returned version');
    same(batch.returnRequestKey, commandKey(scenario, returnStep), 'actual return command'); same(batch.returnedBy, owner.id, 'actual receiving business account');
    if (batch.returnedAt == null) throw Error('ACTUAL_RETURN_NOT_READ_BACK');
    const libraryCards = async () => objects((await read(scenario.owner, `/api/v1/samples/room/items?devCaseId=${encodeURIComponent(caseId)}&limit=200`)).items, 'physical samples')
      .filter(row => row.batchId === batchId);
    const physical = await libraryCards();
    if (physical.length !== (scenario.family === 'garment' ? 2 : 1)) throw Error('PHYSICAL_SAMPLE_CARDINALITY_MISMATCH');
    for (const card of physical) {
      same(card.devCaseId, caseId, 'physical sample case'); same(card.warehouseId, placement.warehouseId, 'physical warehouse'); same(card.location, placement.location, 'physical location');
      same(card.unit, scenario.family === 'fabric' ? '米' : '件', 'physical unit'); same(Number(card.quantity), 1, 'independent physical object');
      if (scenario.family === 'fabric') same(Number(card.physicalLengthQty), 10.5, 'actual returned metres');
    }
    const physicalCardIds = physical.map(row => text(row.id, 'physical card id')).sort(); result.ids.physicalCardIds = physicalCardIds;
    earn('returned_and_library_synced');
    const assertReviewIdentity = (review: Row, exactVersionId: string) => {
      same(review.developmentCaseId, caseId, 'current formal QC case'); same(review.sampleBatchId, batchId, 'current formal QC physical batch');
      same(review.sampleVersionId, exactVersionId, 'current formal QC exact version');
      same(JSON.stringify(objects(review.physicalItems, 'QC actual physical objects').map(row => text(row.id, 'QC physical id')).sort()),
        JSON.stringify(physicalCardIds), 'QC actual physical objects');
    };

    const requestQc = async (exactVersionId: string, step: string) => {
      const requested = await command(step, scenario.owner, 'post', `${route(caseId)}/batches/${encodeURIComponent(batchId)}/qc-review`,
        { requestKey: commandKey(scenario, step), sampleVersionId: exactVersionId }, true, [], 201);
      const item = object(requested.item, 'formal QC request');
      same(item.sampleVersionId, exactVersionId, 'formal QC exact version'); same(item.sampleBatchId, batchId, 'formal QC physical source');
      same(item.requestKey, commandKey(scenario, step), 'formal QC original request');
      return text(item.id, 'review id');
    };
    const reviewContext = async (actor: ScenarioActorKey, id: string) => object((await read(actor,
      `/api/v1/qc/development-sample-reviews/${encodeURIComponent(id)}/handoff-context`)).data, 'QC task context');
    currentStep = 'qc_requested';
    const reviewId = await requestQc(versionId, `qc-request:${versionId}`); result.ids.reviewId = reviewId;
    let qcContext = await reviewContext(scenario.qc, reviewId), review = object(qcContext.item, 'current exact QC');
    assertReviewIdentity(review, versionId);
    earn('qc_requested');
    if (scenario.stopAfter === 'qc_queued') {
      same(review.status, 'queued', 'queued stop'); same(review.startedBy ?? null, null, 'queued task unclaimed'); result.stopReached = true; return result;
    }
    currentStep = 'qc_claimed';
    const claimStep = `qc-claim:${reviewId}`;
    await command(claimStep, scenario.qc, 'post', `/api/v1/qc/development-sample-reviews/${encodeURIComponent(reviewId)}/claim`, {
      requestKey: commandKey(scenario, claimStep), expectedStartedBy: null,
      expectedUpdatedAt: text(qcContext.expectedUpdatedAt, 'QC task revision'), sourceFingerprint: text(review.sourceFingerprint, 'QC source fingerprint'),
      reason: `${context.qc.name}实际认领本厂准确版本检验。`,
    }, true, ['expectedUpdatedAt'], 200);
    qcContext = await reviewContext(scenario.qc, reviewId); review = object(qcContext.item, 'claimed QC task');
    assertReviewIdentity(review, versionId);
    same(qcContext.actorId, context.qc.id, 'actual QC login'); same(review.startedBy, context.qc.id, 'actual QC executor');
    earn('qc_claimed');
    if (scenario.stopAfter === 'qc_in_progress') { same(review.status, 'in_progress', 'executing QC stop'); result.stopReached = true; return result; }
    currentStep = 'qc_completed';
    const qcResult = scenario.stopAfter === 'qc_rework' ? 'reject' : 'pass', completeStep = `qc-complete:${reviewId}`;
    await command(completeStep, scenario.qc, 'post', `/api/v1/qc/development-sample-reviews/${encodeURIComponent(reviewId)}/complete`, {
      requestKey: commandKey(scenario, completeStep), result: qcResult,
      opinion: qcResult === 'reject' ? '本厂准确版本未符合约定手感或工艺要求，保留正式NOK报告，待新样复验。' : '已按本厂准确版本要求核对实际返样，质量符合本轮要求。',
      inspectionDate: '2026-10-08', inspectorOrg: `${scenario.family === 'fabric' ? '面料' : '成衣'} QC`,
      criticalDefects: 0, majorDefects: qcResult === 'reject' ? 1 : 0, minorDefects: 0, evidence: [], evidenceFileIds: [],
    }, true, [], 200);
    review = object((await reviewContext(scenario.owner, reviewId)).item, 'business returned formal report');
    assertReviewIdentity(review, versionId); same(review.result, qcResult, 'actual formal QC result');
    same(review.reviewedBy, context.qc.id, 'actual QC reporter'); same(review.completionRequestKey, commandKey(scenario, completeStep), 'QC completion original request');
    if (!['reviewed', 'acknowledged'].includes(String(review.status)) || review.reviewedAt == null) throw Error('FORMAL_QC_COMPLETION_NOT_READ_BACK');
    earn(qcResult === 'reject' ? 'qc_completed_reject' : 'qc_completed_pass');
    if (scenario.stopAfter === 'qc_rework') { result.stopReached = true; return result; }
    if (scenario.stopAfter === 'business_ack_pending') { same(review.status, 'reviewed', 'business unread stop'); result.stopReached = true; return result; }

    currentStep = 'business_acknowledged';
    const ackStep = `business-ack:${reviewId}`;
    await command(ackStep, scenario.owner, 'post', `${route(caseId)}/qc-reviews/${encodeURIComponent(reviewId)}/acknowledge`,
      { requestKey: commandKey(scenario, ackStep) }, true, [], 200);
    review = object((await reviewContext(scenario.owner, reviewId)).item, 'business acknowledged report');
    assertReviewIdentity(review, versionId);
    same(review.status, 'acknowledged', 'business acknowledgment'); same(review.acknowledgedBy, owner.id, 'actual business reader'); earn('business_acknowledged');
    if (scenario.stopAfter === 'requester_confirmation_pending') {
      const confirmations = objects((await read(scenario.owner, `${route(caseId)}/version-confirmations?versionIds=${encodeURIComponent(versionId)}`)).items, 'requester confirmations');
      if (confirmations.length) throw Error('REQUESTER_CONFIRMATION_PENDING_STOP_CHANGED');
      result.stopReached = true; return result;
    }
    currentStep = 'requester_confirmed';
    const confirmationStep = `confirm:${versionId}`, confirmationBody: Row = {
      requestKey: commandKey(scenario, confirmationStep), confirmerType: customer ? 'customer' : 'internal',
      confirmerName: customer ? customer.primaryContactName : context.requester.name,
      confirmerOrganization: customer ? customer.name : team.name,
      ...(customer ? { confirmerRelationId: customer.id } : { confirmerUserId: context.requester.id }),
      confirmedAt: String(Date.parse(SCENARIO_BUSINESS_TIME)), result: 'approved',
      basis: `业务剧本 ${scenario.key}：实际需求方书面选择本厂准确版本 ${versionId}，业务负责人如实录入。`,
      evidence: [`simulation:${scenario.key}:written-selection:${versionId}`], sampleBatchId: batchId,
    };
    const confirmed = object((await command(confirmationStep, scenario.owner, 'post', `${route(caseId)}/sample-versions/${encodeURIComponent(versionId)}/confirmations`,
      confirmationBody, true, [], 201)).item, 'actual requester selection');
    const confirmationId = text(confirmed.id, 'confirmation id'); result.ids.confirmationId = confirmationId;
    const confirmationMatches = objects((await read(scenario.owner, `${route(caseId)}/version-confirmations?versionIds=${encodeURIComponent(versionId)}`)).items, 'requester selection readback')
      .filter(row => row.id === confirmationId);
    if (confirmationMatches.length !== 1) throw Error('ACTUAL_CONFIRMATION_READBACK_REQUIRED');
    const actualConfirmation = confirmationMatches[0];
    for (const field of ['sampleVersionId', 'recordedBy', 'confirmerType', 'confirmerName', 'result', 'basis', 'confirmedAt'])
      same(actualConfirmation[field], field === 'sampleVersionId' ? versionId : field === 'recordedBy' ? owner.id : confirmationBody[field], `actual confirmation ${field}`);
    if (customer) same(actualConfirmation.confirmerRelationId, customer.id, 'actual customer confirmer organization');
    else { same(actualConfirmation.confirmerUserId, context.requester.id, 'actual internal requester'); if (actualConfirmation.confirmerUserId === actualConfirmation.recordedBy) throw Error('INTERNAL_CONFIRMER_IS_RECORDER'); }
    earn('requester_confirmed');
    currentStep = 'version_archived'; batch = await currentBatch(batchId);
    const archiveStep = `archive:${versionId}`, archiveBody: Row = { requestKey: commandKey(scenario, archiveStep), sourceVersionId: versionId,
      sourceType: scenario.family === 'fabric' ? 'batch' : 'node', sourceId: scenario.family === 'fabric' ? batchId : 'confirmation',
      sourceRoundId: batchId, expectedRound: Number(batch.round), expectedRevision: revision(batch) };
    const archived = await command(archiveStep, scenario.owner, 'post', `${route(caseId)}/convert-to-asset`, archiveBody, true, ['expectedRevision'], 200);
    const asset = object(archived.asset, 'exact archive'), receipt = object(archived.conversionReceipt, 'exact archive command receipt'), assetId = text(asset.id, 'asset id');
    result.ids.assetId = assetId;
    same(asset.sourceSampleVersionId, versionId, 'archived version'); same(receipt.sampleVersionId, versionId, 'archive receipt version');
    same(receipt.requestKey, commandKey(scenario, archiveStep), 'archive original request'); same(receipt.caseId, caseId, 'archive receipt case');
    same(receipt.sourceSampleBatchId, batchId, 'archive receipt physical batch'); same(receipt.productAssetId, assetId, 'archive receipt asset');
    same(receipt.sourceType, archiveBody.sourceType, 'archive receipt source type'); same(receipt.sourceId, archiveBody.sourceId, 'archive receipt source id'); text(receipt.auditId, 'archive audit id');
    batch = await currentBatch(batchId); same(object(batch.linkedAsset, 'version archive backlink').id, assetId, 'accurate version archive backlink');
    const latestQc = object(batch.latestFormalQcReview, 'latest formal QC'), latestConfirmation = object(batch.versionConfirmation, 'latest actual requester selection');
    same(latestQc.id, reviewId, 'latest formal QC id'); same(latestQc.sampleVersionId, versionId, 'latest formal QC version');
    same(latestQc.result, 'pass', 'latest formal QC result');
    if (!['reviewed', 'acknowledged'].includes(String(latestQc.status))) throw Error('LATEST_FORMAL_QC_NOT_COMPLETED');
    same(latestConfirmation.id, confirmationId, 'latest actual requester selection id');
    same(latestConfirmation.sampleVersionId, versionId, 'latest actual requester selection version'); same(latestConfirmation.result, 'approved', 'latest actual requester selection result');
    same(JSON.stringify((await libraryCards()).map(row => text(row.id, 'physical card id')).sort()), JSON.stringify(physicalCardIds), 'archive preserves original physical objects');
    result.ids.assetId = assetId; earn('version_archived');
    result.archive = { scenarioKey: scenario.key, family: scenario.family, caseId, batchId, versionId, assetId, reviewId, confirmationId,
      factoryId: context.factories[0].id, customerId: scenario.customerId, ownerActorKey: scenario.owner, physicalCardIds };

    if (scenario.stopAfter === 'archived_and_borrowed') {
      currentStep = 'sample_borrowed';
      const itemId = physicalCardIds[0], borrowStep = `borrow:${itemId}`, isFabric = scenario.family === 'fabric';
      const borrowed = await command(borrowStep, scenario.owner, 'post', `/api/v1/samples/room/items/${encodeURIComponent(itemId)}/loans`, {
        requestKey: commandKey(scenario, borrowStep), loanType: 'borrow', ...(isFabric ? { loanLength: '1.5' } : { loanQuantity: 1 }),
        borrowerName: context.requester.name, borrowerUserId: context.requester.id, dueAt: Date.parse('2026-10-15T12:00:00+08:00'),
      }, true, [], 201);
      const loanId = text(object(borrowed.loan, 'physical loan').id, 'loan id'); result.ids.loanId = loanId;
      const matches = objects((await read(scenario.owner, `/api/v1/samples/room/loans?itemId=${encodeURIComponent(itemId)}&limit=200`)).loans, 'actual loans').filter(row => row.id === loanId);
      if (matches.length !== 1) throw Error('ACTUAL_LOAN_READBACK_REQUIRED');
      const loan = matches[0]; same(loan.itemId, itemId, 'borrowed actual physical object'); same(loan.operatorId, owner.id, 'actual loan operator');
      same(loan.meterRequestKey, commandKey(scenario, borrowStep), 'original loan request'); same(loan.returnedAt ?? null, null, 'loan still outstanding');
      if (isFabric) same(Number(loan.loanLength), 1.5, 'actual borrowed metres'); else same(loan.loanQuantity, 1, 'actual borrowed piece');
      const card = (await libraryCards()).find(row => row.id === itemId);
      if (!card || (isFabric ? Number(card.availableLengthQty) !== 9 : card.availableQty !== 0)) throw Error('BORROW_STOCK_READBACK_MISMATCH');
      earn('sample_borrowed'); result.stopReached = true; return result;
    }
    if (scenario.stopAfter === 'minor_version_review') {
      currentStep = 'minor_created'; const minorStep = `minor:${versionId}`;
      const minor = object((await command(minorStep, scenario.owner, 'post', `${route(caseId)}/sample-versions/${encodeURIComponent(versionId)}/minors`,
        { requestKey: commandKey(scenario, minorStep), note: '同一实物的点号修订：更新工艺/规格备注，正式QC与需求确认独立。' }, true, [], 201)).item, 'minor version');
      const minorId = text(minor.id, 'minor version id'); result.ids.minorVersionId = minorId; same(minor.parentVersionId, versionId, 'minor parent');
      const readMinor = objects((await currentBatch(batchId)).microVersions, 'minor versions').find(row => row.id === minorId);
      if (!readMinor) throw Error('EXACT_MINOR_READBACK_REQUIRED');
      const inheritedConfirmations = objects(readMinor.versionConfirmationHistory ?? [], 'minor actual confirmations');
      if (inheritedConfirmations.length || readMinor.versionConfirmation) throw Error('MINOR_INHERITED_REQUESTER_CONFIRMATION');
      same(JSON.stringify((await libraryCards()).map(row => text(row.id, 'physical card id')).sort()), JSON.stringify(physicalCardIds), 'minor reuses original physical objects'); earn('minor_created');
      currentStep = 'minor_qc_requested'; const minorReviewId = await requestQc(minorId, `minor-qc-request:${minorId}`); result.ids.minorReviewId = minorReviewId;
      const minorReview = object((await reviewContext(scenario.qc, minorReviewId)).item, 'minor formal QC');
      assertReviewIdentity(minorReview, minorId); same(minorReview.status, 'queued', 'minor independent review stop');
      if (minorReview.result != null) throw Error('MINOR_INHERITED_QC_PASS');
      earn('minor_qc_requested'); result.stopReached = true; return result;
    }
    if (scenario.stopAfter === 'internal_request') { result.stopReached = true; return result; }
    currentStep = 'development_ci_finance';
    throw Error('DEVELOPMENT_CI_FINANCE_HANDOFF_REQUIRED: exact confirmed archive is ready; CI issuance and finance registration are not earned by this driver');
  } catch (error) {
    result.blockedAt = currentStep; result.blockedReason = error instanceof Error ? error.message : String(error);
    return result;
  }
}

/** Cases run independently: one rejected producer never fabricates its stop or
 * prevents other actual responsibilities from reaching their own planned stops. */
export async function runDevelopmentScenarios(master: ScenarioMasterData, scenarios: DevelopmentScenario[], deps: ScenarioDriverDependencies): Promise<DevelopmentDriverResult> {
  const executions: DevelopmentScenarioExecution[] = [];
  for (const scenario of scenarios) executions.push(await runOne(master, scenario, deps));
  return { executions, archives: executions.flatMap(row => row.archive ? [row.archive] : []) };
}
