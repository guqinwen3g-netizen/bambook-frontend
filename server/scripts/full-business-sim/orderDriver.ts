/** Executable simulation commands, always through the caller's actual HTTP
 * identity. No database, environment discovery, terminal-state seed or bypass.
 * A returned stop is earned by producer acknowledgements and current readback.
 * Persist the shared private journal before every command and on every ACK. */
import { createHash } from 'node:crypto';
import type { ScenarioActorKey, ScenarioMasterData } from './masterData';
import type { OrderScenario } from './scenarios';
import { scenarioCommand, type ScenarioDriverDependencies, type ScenarioExecution, type ScenarioHttpMethod } from './driverContract';

export interface ConfirmedOrderScenarioSource {
  caseId: string; assetId: string; factoryId: string; customerId: string; family: 'fabric' | 'garment';
}
export interface OrderDriverOptions {
  /** Explicit local business day supplied by the safe driver/clock. */
  businessDate: string;
  /** Supply an already earned exact QC+requester-confirmed archive. The native
   * version-binding endpoint remains authoritative; flags are never accepted. */
  resolveConfirmedSource?: (scenario: OrderScenario) => Promise<ConfirmedOrderScenarioSource | null>;
  resolveCashAccount?: (scenario: OrderScenario) => Promise<{ id: string }>;
  /** Record actual line-level commercial modes before they are frozen by the
   * main approval. The caller uses native line producers and owns recovery. */
  prepareCommercialTerms?: (context: { master: ScenarioMasterData; scenario: OrderScenario; orderId: string;
    lineId: string; deps: ScenarioDriverDependencies }) => Promise<void>;
  /** Prepare an actual LC or other financial instrument after the exact draft
   * readback and before main approval. Called again on resume; the caller owns
   * its native commands, original-key journal and fresh evidence checks. */
  prepareFinancialInstrument?: (context: { master: ScenarioMasterData; scenario: OrderScenario; orderId: string;
    lineId: string; deps: ScenarioDriverDependencies }) => Promise<void>;
  /** A real, approved internal fabric source and exact allocation must be
   * earned after main approval and before PP. Null explicitly means this
   * scenario does not use the optional continuation. */
  prepareMaterialSupply?: (context: { master: ScenarioMasterData; scenario: OrderScenario; orderId: string;
    lineId: string; deps: ScenarioDriverDependencies }) => Promise<ScenarioExecution | null>;
  /** The independent supplier driver must earn its own original AP, approval,
   * actual cash and allocation facts. Customer AR alone cannot complete these
   * stops. The pending stop instead earns an unapproved exact AP request. */
  continueSupplierFinance?: (context: { master: ScenarioMasterData; scenario: OrderScenario; orderId: string;
    lineId: string; customerInvoiceId: string; deps: ScenarioDriverDependencies }) => Promise<ScenarioExecution>;
  /** Fabric-only supplier-to-us commission, after actual whole-order departure.
   * It must not register the goods value as our customer receivable. */
  continueFabricCommission?: (context: { master: ScenarioMasterData; scenario: OrderScenario; orderId: string;
    lineId: string; deps: ScenarioDriverDependencies }) => Promise<ScenarioExecution>;
  /** Binary external evidence is a caller-owned transport boundary. The
   * callback must use real protected upload producers and its private journal;
   * the returned document is subsequently rechecked by the native filing gate. */
  archiveExternalFiling?: (context: { master: ScenarioMasterData; scenario: OrderScenario; orderId: string;
    shipmentId: string; documentId: string; deps: ScenarioDriverDependencies }) => Promise<{ documentId: string; reference: string }>;
}

const enc = encodeURIComponent, SCALE = BigInt(10000);
function ensure(condition: unknown, message: string): asserts condition { if (!condition) throw Error(message); }
function quantity(value: unknown): bigint {
  ensure(typeof value === 'string' && /^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(value), 'SCENARIO_DECIMAL_INVALID');
  const [whole, fraction = ''] = value.split('.'); return BigInt(whole) * SCALE + BigInt(fraction.padEnd(4, '0'));
}
function decimal(value: bigint): string {
  const whole = value / SCALE, fraction = String(value % SCALE).padStart(4, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
}
function money(qty: string, price: string) {
  const product = quantity(qty) * quantity(price);
  ensure(product % SCALE === BigInt(0), 'SCENARIO_MONEY_PRECISION_EXCEEDED'); return decimal(product / SCALE);
}
function uuid(key: string) {
  const hash = createHash('sha256').update(`bambook-simulation-order:${key}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
function garmentSizes(qty: string): Record<string, number> {
  const value = quantity(qty);
  ensure(value % SCALE === BigInt(0) && value / SCALE >= BigInt(2) && value / SCALE <= BigInt(Number.MAX_SAFE_INTEGER), 'SCENARIO_GARMENT_QUANTITY_INVALID');
  const total = Number(value / SCALE); return { S: Math.floor(total / 2), M: total - Math.floor(total / 2) };
}

type Context = ReturnType<typeof context>;
function context(scenario: OrderScenario, deps: ScenarioDriverDependencies, result: ScenarioExecution) {
  let at = 'scenario.validate';
  const earned = (step: string) => { if (!result.earnedSteps.includes(step)) result.earnedSteps.push(step); };
  const read = async (actor: ScenarioActorKey, url: string, body?: unknown, method: ScenarioHttpMethod = 'get'): Promise<any> => {
    at = `read ${url}`;
    await deps.verifyActor(actor);
    const response = await deps.invoke(actor, method, url, body);
    ensure(response.status === 200 && response.body?.ok !== false,
      `SCENARIO_READ_REJECTED: HTTP ${response.status}: ${JSON.stringify(response.body)}`);
    return response.body;
  };
  const write = async (step: string, actor: ScenarioActorKey, method: ScenarioHttpMethod, url: string,
    body: unknown | (() => Promise<unknown>), idempotent = false): Promise<any> => {
    at = step;
    const key = `${scenario.key}:${step}`, original = await deps.journal.read(key);
    // Static inputs are always rehashed (a changed scenario must conflict).
    // Dynamic CAS commands recover their original exact body after an unknown
    // ACK; rereading a changed timestamp and minting a new command is unsafe.
    const input = typeof body === 'function'
      ? original ? original.body : await (body as () => Promise<unknown>)() : body;
    at = step;
    const ack = await scenarioCommand(deps, { key, actor, method, url, body: input, idempotent });
    earned(step); return ack;
  };
  return { scenario, deps, result, read, write, earned, enter: (step: string) => { at = step; }, get at() { return at; } };
}

function verifyScenario(master: ScenarioMasterData, scenario: OrderScenario, options: OrderDriverOptions, deps: ScenarioDriverDependencies) {
  ensure(deps.runtimeId?.trim() && Object.values(master.cast).every(actor => deps.actorIds[actor.key] === actor.id),
    'SCENARIO_RUNTIME_ACTOR_MASTER_MISMATCH');
  ensure(/^\d{4}-\d{2}-\d{2}$/.test(options.businessDate)
    && new Date(`${options.businessDate}T00:00:00.000Z`).toISOString().slice(0, 10) === options.businessDate, 'SCENARIO_BUSINESS_DATE_INVALID');
  ensure(scenario.key.startsWith(`${master.namespace}-`) && scenario.key.length <= 140, 'SCENARIO_KEY_INVALID');
  const team = master.businessTeams.find(row => row.key === scenario.teamKey);
  const customer = master.catalog.customers.find(row => row.id === scenario.customerId);
  const supplier = master.catalog.suppliers.find(row => row.id === scenario.supplierId);
  ensure(team && team.businessFamily === scenario.family && customer && supplier
    && team.memberIds.includes(master.cast[scenario.owner]?.id) && team.customerIds.includes(customer.id)
    && team.supplierIds.includes(supplier.id) && supplier.factoryProfileId
    && supplier.kind === (scenario.family === 'fabric' ? 'fabric_mill' : 'garment_factory'), 'SCENARIO_ACTUAL_TEAM_SOURCE_MISMATCH');
  ensure(master.approvalAuthorities[scenario.family].includes(master.cast[scenario.reviewer]?.id), 'SCENARIO_REVIEWER_NOT_CONFIGURED');
  ensure(master.cast[scenario.qc] && master.cast[scenario.finance] && master.cast[scenario.logistics], 'SCENARIO_ACTOR_MISSING');
  ensure(quantity(scenario.quantity) > BigInt(0) && quantity(scenario.unitPrice) > BigInt(0), 'SCENARIO_QUANTITY_PRICE_REQUIRED');
  ensure(scenario.paymentInstrument === 'T/T' || scenario.paymentInstrument === 'L/C', 'SCENARIO_PAYMENT_INSTRUMENT_REQUIRED');
  return { team, customer, supplier };
}

async function draft(master: ScenarioMasterData, c: Context, options: OrderDriverOptions) {
  const s = c.scenario, { customer, supplier } = verifyScenario(master, s, options, c.deps);
  const asset = [...master.catalog.fabricAssets, ...master.catalog.garmentAssets].find(row => row.id === s.catalogAssetId);
  ensure(asset && asset.businessFamily === s.family, 'SCENARIO_PRODUCT_ASSET_MISSING');
  const scenarioNumber = s.key.match(/-(\d{2})$/)?.[1];
  ensure(scenarioNumber, 'SCENARIO_ORDER_NUMBER_MISSING');
  const orderPrefix = s.family === 'fabric' ? 'F' : 'G';
  let source: ConfirmedOrderScenarioSource | null = null;
  if (options.resolveConfirmedSource) {
    source = await options.resolveConfirmedSource(s);
    if (source) {
      ensure(source.caseId && source.assetId && source.customerId === s.customerId && source.factoryId === s.supplierId && source.family === s.family,
        'SCENARIO_CONFIRMED_SOURCE_MISMATCH');
      ensure(![...master.catalog.fabricAssets, ...master.catalog.garmentAssets].some(asset => asset.id === source!.assetId),
        'SCENARIO_HISTORICAL_CATALOG_IS_NOT_CONFIRMED_SOURCE');
    }
  }
  const made = await c.write('draft.create', s.owner, 'post', '/api/v2/orders', {
    poNumber: `PO-${orderPrefix}-2026-${scenarioNumber}`, customer: customer.name, customerRelationId: customer.id, product: asset.name,
    type: s.family, businessLine: s.family, quantity: s.quantity, unit: s.unit, quoteAmount: money(s.quantity, s.unitPrice), status: 'Pending',
    ownerId: master.cast[s.owner].id, departmentId: master.cast[s.owner].departmentId, salesPerson: master.cast[s.owner].name,
    dueDate: s.dueDate, clientDate: s.dueDate, contractDate: s.contractDate, currency: s.currency, paymentTerms: s.paymentTerms,
    paymentInstrument: s.paymentInstrument, deliveryTerms: 'FOB',
    finalContractNumber: `SC-${orderPrefix}-2026-${scenarioNumber}`, millRelationId: supplier.id, millName: supplier.name,
    billToRelationId: customer.id, billToName: customer.name, billToAddress: customer.address,
    consigneeRelationId: customer.id, consigneeName: customer.name, shipToName: customer.name, shipToAddress1: customer.address, shipToCountry: 'GB',
    source: 'bambook-full-business-simulation', ...(source ? { sourceCaseId: source.caseId } : {}),
  });
  ensure(made.order?.id, 'SCENARIO_DRAFT_ACK_INCOMPLETE');
  const orderId = String(made.order.id); c.result.ids.orderId = orderId;
  const sizeBreakdown = s.family === 'garment' ? garmentSizes(s.quantity) : null;
  const created = await c.write('line.create', s.owner, 'post', '/api/v1/order-lines', {
    orderId, itemNo: '0010', exMillDate: s.dueDate, materialCode: asset.sku, millQuality: `${asset.colorCode} ${asset.colorDescription}`,
    description: asset.name, quantity: s.quantity, unit: s.unit, unitPrice: s.unitPrice,
    requiredSampleFamilies: s.family === 'fabric' ? ['fabric_eps', 'fabric_ss'] : ['garment_pp', 'garment_ship'],
    partialShipmentAllowed: true, tolerancePercent: '5', toleranceSource: 'line_override',
    ...(sizeBreakdown ? { sizeBreakdown, fulfillmentMode: 'cmt', cmtIncludedItems: [] } : {}),
    ...(!source ? { manualSpecification: { factoryRelationId: supplier.id,
      specification: `${asset.name}；${s.family === 'garment' ? `CMT工艺与逐码数量 ${JSON.stringify(sizeBreakdown)}` : '面料织造与颜色手感规格'}；合同数量 ${s.quantity}${s.unit}`,
      agreementBasis: '演练客户书面合同逐行规格，业务账号明确录入；本依据不代表开发QC或客户选样结论。', evidence: [`simulation:${s.key}:manual-contract-specification`] } } : {}),
  });
  ensure(created.line?.id && created.line.orderId === orderId, 'SCENARIO_LINE_ACK_INCOMPLETE');
  const lineId = String(created.line.id); c.result.ids.lineId = lineId;
  if (source) await c.write('line.bind-confirmed-source', s.owner, 'patch', `/api/v1/order-lines/${enc(lineId)}/version`, {
    confirmedSourceType: 'Asset', confirmedSourceId: source.assetId, millRelationId: supplier.id,
  });
  const actual = (await c.read(s.owner, `/api/v2/orders/${enc(orderId)}`)).order;
  const actualLines = (await c.read(s.owner, `/api/v1/order-lines?orderId=${enc(orderId)}`)).lines;
  const line = actualLines?.find((row: any) => row.id === lineId);
  ensure(actual?.id === orderId && actual.customerRelationId === customer.id && actual.ownerId === master.cast[s.owner].id
    && line?.orderId === orderId && quantity(String(line.quantity)) === quantity(s.quantity), 'SCENARIO_DRAFT_READBACK_MISMATCH');
  ensure(source ? line.confirmedSourceType === 'Asset' && line.confirmedSourceId === source.assetId
    : line.confirmedSourceType === 'ManualOrderLine' && line.confirmedSourceId === line.id, 'SCENARIO_EXACT_SOURCE_NOT_EARNED');
  c.earned('draft.readback'); return { orderId, lineId, sizeBreakdown };
}

async function approval(master: ScenarioMasterData, c: Context, orderId: string) {
  const s = c.scenario;
  const submitted = await c.write('approval.submit', s.owner, 'post', `/api/v2/orders/${enc(orderId)}/submit-main-approval`, {});
  ensure(submitted.item?.id, 'SCENARIO_APPROVAL_ACK_INCOMPLETE');
  const approvalId = String(submitted.item.id); c.result.ids.approvalId = approvalId;
  const current = (await c.read(s.reviewer, `/api/v1/approvals/${enc(approvalId)}`)).item;
  ensure(current?.targetId === orderId && /^[a-f0-9]{64}$/.test(current.reviewContentVersion), 'SCENARIO_APPROVAL_REVIEW_MISSING');
  if (s.stopAfter === 'approval_pending') { ensure(current.status === 'pending', 'SCENARIO_APPROVAL_NO_LONGER_PENDING'); return false; }
  if (s.stopAfter === 'approval_withdrawn') {
    const cancelled = await c.write('approval.withdraw', s.owner, 'post', `/api/v1/approvals/${enc(approvalId)}/withdraw`, async () => ({
      requestKey: uuid(`${s.key}:approval.withdraw`), reviewContentVersion: current.reviewContentVersion, reason: '业务实际撤回本轮合同，准备重新核对交期和规格。',
    }), true);
    ensure(cancelled.item?.status === 'cancelled' && cancelled.commandAck?.approvalId === approvalId, 'SCENARIO_WITHDRAWAL_NOT_EARNED');
  } else {
    const reject = s.stopAfter === 'approval_rejected';
    const decided = await c.write('approval.decide', s.reviewer, 'post', `/api/v1/approvals/${enc(approvalId)}/decide`, async () => ({
      status: reject ? 'rejected' : 'approved', confirmedReviewedContent: true, reviewContentVersion: current.reviewContentVersion,
      decisionNote: '主管实际核对当前冻结合同、工厂、数量和准确规格。',
      ...(reject ? { rejectionReason: '当前交期与价格依据不足，暂不批准。', requestedChanges: '请业务核对客户书面交期和工厂报价后再重新提交。' } : {}),
    }));
    ensure(decided.item?.status === (reject ? 'rejected' : 'approved') && decided.item.reviewerId === master.cast[s.reviewer].id,
      'SCENARIO_APPROVAL_DECISION_NOT_EARNED');
    if (!reject) ensure(decided.item.businessSyncStatus === 'completed', 'SCENARIO_APPROVAL_BUSINESS_SYNC_NOT_COMPLETED');
  }
  const final = (await c.read(s.reviewer, `/api/v1/approvals/${enc(approvalId)}`)).item;
  const order = (await c.read(s.owner, `/api/v2/orders/${enc(orderId)}`)).order;
  const negative = s.stopAfter === 'approval_rejected' || s.stopAfter === 'approval_withdrawn';
  ensure(final?.status === (s.stopAfter === 'approval_withdrawn' ? 'cancelled' : negative ? 'rejected' : 'approved')
    && (negative ? order?.status === 'Pending' : ['Confirmed', 'Production', 'Shipping', 'Delivered', 'Alert'].includes(order?.status)),
  'SCENARIO_APPROVAL_READBACK_MISMATCH');
  c.earned('approval.readback'); return !negative;
}

type Production = { orderId: string; lineId: string; base: string; batch: any; sizeBreakdown: Record<string, number> | null };
type ShippingMember = { c: Context; p: Production; planned: string };
function plannedShipmentQuantity(s: OrderScenario) {
  const full = quantity(s.quantity);
  if (s.stopAfter !== 'partially_shipped') return s.quantity;
  ensure(full % BigInt(2) === BigInt(0), 'SCENARIO_EXACT_PARTIAL_SHIPMENT_PRECISION_REQUIRED');
  return decimal(full / BigInt(2));
}
async function branch(c: Context, p: { orderId: string; lineId: string; sizeBreakdown: Record<string, number> | null }): Promise<Production> {
  const s = c.scenario, base = `/api/v1/production-batches/orders/${enc(p.orderId)}/lines/${enc(p.lineId)}`;
  const created = await c.write('branch.create', s.owner, 'post', base, async () => {
    const current = await c.read(s.owner, base);
    ensure(/^[a-f0-9]{64}$/.test(current.lineFingerprint), 'SCENARIO_CURRENT_LINE_FINGERPRINT_MISSING');
    return { batchCode: `${s.key}-factory-1`, quantity: s.quantity, unit: s.unit, factoryRelationId: s.supplierId,
      expectedLineFingerprint: current.lineFingerprint, requestKey: uuid(`${s.key}:branch.create`),
      ...(p.sizeBreakdown ? { sizeBreakdown: p.sizeBreakdown, productionLineChoice: { mode: 'factory_single' } } : {}) };
  }, true);
  ensure(created.batch?.id && created.batch.orderId === p.orderId && created.batch.orderLineId === p.lineId
    && created.batch.factoryRelationId === s.supplierId && Number.isSafeInteger(created.batch.revision), 'SCENARIO_FACTORY_BRANCH_ACK_MISMATCH');
  c.result.ids.productionBatchId = created.batch.id;
  const current = await c.read(s.owner, base), batch = current.batches?.find((row: any) => row.id === created.batch.id);
  ensure(batch?.state === 'active' && batch.revision === created.batch.revision, 'SCENARIO_FACTORY_BRANCH_CHANGED');
  c.earned('branch.readback'); return { ...p, base, batch };
}

async function nativeSample(c: Context, p: Production, family: string, date: string, stop: 'pending' | 'fail' | 'approved' = 'approved') {
  const s = c.scenario, root = '/api/v1/samples/order-native', step = `sample.${family}`;
  let ack = (await c.write(`${step}.register`, s.owner, 'post', `${root}/register`, async () => {
    const current = (await c.read(s.owner, `${root}/context?orderId=${enc(p.orderId)}&family=${enc(family)}`)).data;
    const selected = current?.batches?.find((row: any) => row.id === p.batch.id);
    ensure(selected?.selectable === true && selected.revision === p.batch.revision, 'SCENARIO_SAMPLE_CURRENT_BRANCH_UNSELECTABLE');
    const range = { family, orderId: p.orderId, factoryRelationId: s.supplierId, coverage: [{ orderLineId: p.lineId,
      expectedLineFingerprint: selected.lineFingerprint, productionBatchId: p.batch.id, expectedBatchRevision: p.batch.revision,
      rangeStart: selected.rangeStart, quantity: selected.quantity, unit: selected.unit }] };
    const preview = (await c.read(s.owner, `${root}/preview`, range, 'post')).data;
    ensure(preview?.parentFingerprint, 'SCENARIO_SAMPLE_PARENT_MISSING');
    return { ...range, protocolVersion: 1, requestKey: uuid(`${s.key}:${step}.register`), expectedParentFingerprint: preview.parentFingerprint,
      sampleFacts: { quantity: s.family === 'fabric' ? '0.25' : '1', unit: s.family === 'fabric' ? 'M' : 'PC', cuttingDate: date }, previousSourceId: null };
  }, true)).data;
  ensure(ack?.sourceId && ack.sampleId && ack.eventId && Number.isSafeInteger(ack.eventSequence), 'SCENARIO_SAMPLE_ACK_INCOMPLETE');
  c.result.ids[`${family}SourceId`] = ack.sourceId; c.result.ids[`${family}SampleId`] = ack.sampleId;
  const append = async (event: string, actor: ScenarioActorKey, payload: () => unknown) => {
    ack = (await c.write(`${step}.${event}`, actor, 'post', `${root}/events`, async () => ({ protocolVersion: 1,
      requestKey: uuid(`${s.key}:${step}.${event}`), sourceId: ack.sourceId,
      expectedHead: { eventId: ack.eventId, sequence: ack.eventSequence }, eventType: event, occurredAt: date, payload: payload(),
    }), true)).data;
    ensure(ack?.sourceId && ack.eventId, 'SCENARIO_SAMPLE_EVENT_ACK_INCOMPLETE'); return ack;
  };
  const requested = await append('qc_requested', s.owner, () => ({ reason: '演练实际工厂返样，申请检验当前准确生产分支与人工规格。' }));
  if (stop !== 'pending') {
    const fail = stop === 'fail';
    await append('qc_reviewed', s.qc, () => ({ requestedEventId: requested.eventId, result: fail ? 'fail' : 'pass',
      opinion: fail ? '实物检验发现色差/工艺不符，工厂须重做当前准确样品。' : '实物检验满足当前准确规格。',
      inspectionDate: date, inspectorOrg: 'Bambook 专业QC（模拟演练）', totalUnits: 1, passedUnits: fail ? 0 : 1,
      sampleSize: 1, criticalDefects: fail ? 1 : 0, majorDefects: 0, minorDefects: 0, defectSummary: fail ? '当前实样与约定规格不符' : '', reportFile: null }));
    if (!fail) {
      const sent = await append('shipped', s.owner, () => ({ sentDate: date, courier: '工厂实样直寄', trackingNumber: `${s.key}-${family}`, directShipment: true }));
      await append('customer_feedback', s.owner, () => ({ shippedEventId: sent.eventId, result: 'approved', channel: 'written',
        confirmationDate: date, evidenceRefs: [`simulation:${s.key}:${family}:actual-written-requester-choice`] }));
    }
  }
  const actual = (await c.read(s.owner, `${root}/source/${enc(ack.sourceId)}`)).data;
  ensure(actual?.source?.family === family && actual.source.sourceId === ack.sourceId && actual.source.sampleId === ack.sampleId
    && actual.events?.some((row: any) => row.id === requested.eventId && row.eventType === 'qc_requested'), 'SCENARIO_SAMPLE_READBACK_MISMATCH');
  if (family === 'garment_pp' && c.result.ids.internalSupplyAllocationId) {
    const scope = actual.source.coverage?.find((row: any) => row.orderId === p.orderId && row.orderLineId === p.lineId
      && row.productionBatchId === p.batch.id && row.productionBatchRevision === p.batch.revision);
    const material = scope?.materialProof, allocation = material?.allocation;
    ensure(material?.fulfillmentMode === 'full_package' && allocation?.id === c.result.ids.internalSupplyAllocationId
      && String(allocation.revision) === c.result.ids.internalSupplyAllocationRevision
      && quantity(String(allocation.metres)) === quantity(String(c.result.ids.internalSupplyMetres))
      && allocation.fabricOrderId === c.result.ids.internalSupplyOrderId && allocation.fabricOrderLineId === c.result.ids.internalSupplyLineId
      && allocation.auditId === c.result.ids.internalSupplyAllocationAuditId && allocation.approvalId === c.result.ids.internalSupplyApprovalId
      && allocation.internalDemandTeamId === c.result.ids.internalSupplyDemandTeamId && allocation.internalReceiverId === c.deps.actorIds[s.owner],
    'SCENARIO_PP_INTERNAL_SUPPLY_PROOF_MISMATCH');
    c.earned('internalSupply.pp-material-proof-readback');
  }
  const reviews = actual.events.filter((row: any) => row.eventType === 'qc_reviewed');
  if (stop === 'pending') {
    ensure(reviews.length === 0 && actual.view?.pendingQcRequest?.eventId === requested.eventId && actual.view.qc === null,
      'SCENARIO_SAMPLE_QC_STOP_NOT_EARNED');
  } else {
    // The command accepts pass/fail, but its native producer creates an actual
    // InspectionReport and stores report.result=passed/failed in the event.
    // Read the exact report and current reducer view, never the command input.
    const review = reviews[reviews.length - 1], report = review?.payload?.report, current = actual.view?.qc;
    ensure(review?.actorId === c.deps.actorIds[s.qc] && review.payload.requestedEventId === requested.eventId
      && report?.id && report.requestedEventId === requested.eventId && report.sourceId === ack.sourceId && report.sampleId === ack.sampleId
      && report.result === (stop === 'fail' ? 'failed' : 'passed') && review.payload.reportAudit?.actorId === c.deps.actorIds[s.qc]
      && review.payload.reportAudit.targetId === report.id && actual.view.pendingQcRequest === null
      && current?.id === report.id && current.eventId === review.id && current.result === report.result
      && actual.qcReportSummary?.id === report.id && actual.qcReportSummary.result === (stop === 'fail' ? 'fail' : 'pass'),
    'SCENARIO_SAMPLE_QC_STOP_NOT_EARNED');
  }
  if (stop === 'approved') ensure(actual.events.some((row: any) => row.id === ack.eventId && row.eventType === 'customer_feedback'
    && row.payload?.result === 'approved') && actual.view?.latestFeedback?.eventId === ack.eventId && actual.view.latestFeedback.result === 'approved',
  'SCENARIO_SAMPLE_REQUESTER_CHOICE_NOT_EARNED');
  c.earned(`${step}.readback`); return ack;
}

async function materialSupply(master: ScenarioMasterData, c: Context, p: { orderId: string; lineId: string }, options: OrderDriverOptions) {
  if (!options.prepareMaterialSupply) return;
  c.enter('internalSupply.prepare');
  const result = await options.prepareMaterialSupply({ master, scenario: c.scenario, ...p, deps: c.deps });
  if (result == null) return;
  ensure(c.scenario.family === 'garment' && result.key === c.scenario.key
    && result.earnedSteps.every(step => step.startsWith('internalSupply.'))
    && Object.keys(result.ids).every(key => key.startsWith('internalSupply')), 'SCENARIO_INTERNAL_SUPPLY_CONTINUATION_SOURCE_MISMATCH');
  ensure(result.stopReached, result.blockedAt ?? 'SCENARIO_INTERNAL_SUPPLY_STOP_NOT_EARNED');
  ensure(result.earnedSteps.includes('internalSupply.allocation.both-sides-readback')
    && result.ids.internalSupplyTargetOrderId === p.orderId && result.ids.internalSupplyTargetLineId === p.lineId
    && result.ids.internalSupplyDemandTeamId === master.businessTeams.find(team => team.key === c.scenario.teamKey)?.id
    && ['internalSupplyOrderId', 'internalSupplyLineId', 'internalSupplyApprovalId', 'internalSupplyAllocationId',
      'internalSupplyAllocationAuditId', 'internalSupplyAllocationRevision', 'internalSupplyMetres'].every(key => typeof result.ids[key] === 'string' && result.ids[key]),
  'SCENARIO_INTERNAL_SUPPLY_ACK_INCOMPLETE');
  const current = (await c.read(c.scenario.owner,
    `/api/v1/orders/${enc(p.orderId)}/lines/${enc(p.lineId)}/fabric-allocation-context`)).data;
  const allocation = current?.allocation;
  ensure(current?.orderId === p.orderId && current.lineId === p.lineId && current.fulfillmentMode === 'full_package'
    && allocation?.id === result.ids.internalSupplyAllocationId && allocation.status === 'active'
    && allocation.fabricOrderId === result.ids.internalSupplyOrderId && allocation.fabricOrderLineId === result.ids.internalSupplyLineId
    && allocation.garmentOrderId === p.orderId && allocation.garmentOrderLineId === p.lineId
    && String(allocation.revision) === result.ids.internalSupplyAllocationRevision
    && quantity(String(allocation.metres)) === quantity(String(result.ids.internalSupplyMetres))
    && allocation.auditId === result.ids.internalSupplyAllocationAuditId, 'SCENARIO_INTERNAL_SUPPLY_CURRENT_ALLOCATION_MISMATCH');
  for (const step of result.earnedSteps) c.earned(step);
  Object.assign(c.result.ids, result.ids);
}

async function ppRelease(c: Context, p: Production, sampleId: string) {
  const s = c.scenario, root = '/api/v1/releases';
  const scope = (await c.write('pp.scope', s.owner, 'post', `${root}/orders/${enc(p.orderId)}/lines/${enc(p.lineId)}/release-scopes`, {
    quantity: s.quantity, unit: s.unit, productionBatchId: p.batch.id, expectedBatchRevision: p.batch.revision,
  })).scope;
  ensure(scope?.id, 'SCENARIO_PP_SCOPE_ACK_MISSING'); c.result.ids.releaseScopeId = scope.id;
  const request = (await c.write('pp.request', s.owner, 'post', `${root}/release-scopes/${enc(scope.id)}/requests`, {
    sampleId, expectedScopeRevision: scope.scopeRevision,
  })).request;
  ensure(request?.id, 'SCENARIO_PP_REQUEST_ACK_MISSING'); c.result.ids.releaseRequestId = request.id;
  await c.write('pp.business-signature', s.reviewer, 'post', `${root}/release-requests/${enc(request.id)}/signatures`, async () => {
    const action = (await c.read(s.reviewer, `${root}/release-requests/${enc(request.id)}/action-context`)).item;
    ensure(action?.request?.id === request.id && action.scope?.id === scope.id && action.reviewContentFingerprint, 'SCENARIO_PP_ORIGINAL_REVIEW_MISSING');
    return { role: 'business', confirmedReviewedContent: true, expectedRequestRevision: action.request.requestRevision,
      expectedScopeRevision: action.scope.scopeRevision, reviewContentFingerprint: action.reviewContentFingerprint };
  });
  const current = await c.read(s.owner, `${root}/release-scopes/${enc(scope.id)}/eligibility`);
  ensure(current.eligible === true && current.releaseId, `SCENARIO_PP_RELEASE_NOT_CURRENT: ${JSON.stringify(current.reasons ?? [])}`);
  c.earned('pp.current-eligibility');
}

async function productionQc(master: ScenarioMasterData, c: Context, p: Production, date: string, fail = false) {
  const s = c.scenario, step = fail ? 'production-qc.nok' : 'production-qc.final', root = '/api/v1/qc';
  const assignment = (await c.write(`${step}.assign`, s.owner, 'post', `${root}/assignments`, async () => {
    const scopes = (await c.read(s.owner, `${root}/orders/${enc(p.orderId)}/inspection-scopes`)).scopes;
    const scope = scopes?.find((row: any) => row.productionBatchId === p.batch.id);
    ensure(scope?.scopeFingerprint, 'SCENARIO_EXACT_INSPECTION_SCOPE_MISSING');
    return { orderId: p.orderId, inspectionType: fail ? 'midline' : 'final', qcUserId: master.cast[s.qc].id, dueDate: s.dueDate,
      scopeType: 'production_batch', productionBatchId: p.batch.id, expectedBatchRevision: p.batch.revision,
      expectedScopeFingerprint: scope.scopeFingerprint, requestKey: uuid(`${s.key}:${step}.assign`) };
  }, true)).item;
  ensure(assignment?.id && assignment.scopeFingerprint, 'SCENARIO_QC_ASSIGNMENT_ACK_MISSING');
  c.result.ids[fail ? 'failedQcAssignmentId' : 'finalQcAssignmentId'] = assignment.id;
  await c.write(`${step}.start`, s.qc, 'post', `${root}/assignments/${enc(assignment.id)}/start`, {});
  const report = (await c.write(`${step}.complete`, s.qc, 'post', `${root}/assignments/${enc(assignment.id)}/complete`, async () => ({
    requestKey: uuid(`${s.key}:${step}.complete`), expectedScopeFingerprint: assignment.scopeFingerprint,
    report: { result: fail ? 'fail' : 'pass', inspectionDate: date, totalUnits: 10, passedUnits: fail ? 8 : 10, sampleSize: 10,
      lotSize: Number(s.quantity), criticalDefects: 0, majorDefects: fail ? 1 : 0, minorDefects: 0,
      defectSummary: fail ? '生产现场发现当前工厂分支缝线/色差问题，等待整改复验和业务明确恢复。' : '',
      ...(p.sizeBreakdown ? { productionSizeChecks: { schemaVersion: 1, actualSizes: Object.keys(p.sizeBreakdown).sort(), scopeComplete: true,
        basis: '现场逐项核对本准确分支的实际生产清单与各尺码实物；不由计划自动判定通过。',
        checks: Object.keys(p.sizeBreakdown).sort().map((size, index) => ({ size, inspectedUnits: 2, result: fail && index === 0 ? 'fail' : 'pass',
          evidence: [`simulation:${s.key}:${step}:actual-${size}-inspection`] })) } } : {}) },
  }), true)).report;
  ensure(report?.id && report.result === (fail ? 'fail' : 'pass'), 'SCENARIO_QC_REPORT_ACK_MISSING');
  c.result.ids[fail ? 'failedQcReportId' : 'finalQcReportId'] = report.id;
  if (!fail) {
    const decided = (await c.write(`${step}.business-read`, s.owner, 'post', `${root}/reports/${enc(report.id)}/business-decision`, async () => ({
      decision: 'approved', expectedRevision: report.revision, expectedScopeFingerprint: report.scopeFingerprint,
      expectedContentFingerprint: report.contentFingerprint, requestKey: uuid(`${s.key}:${step}.business-read`), reason: '业务实际核对当前准确分支专业Final报告。',
    }), true)).item;
    ensure(decided?.id === report.id && decided.approvedByBusiness === true, 'SCENARIO_QC_BUSINESS_READ_NOT_EARNED');
  }
  const current = await c.read(s.qc, `${root}/assignments/${enc(assignment.id)}/inspection-context`);
  ensure(current.productionQcIssues?.available === true, 'SCENARIO_QC_ISSUE_SOURCE_UNAVAILABLE');
  ensure(fail ? current.productionQcIssues.issues.some((row: any) => row.status === 'open')
    : current.productionQcIssues.issues.every((row: any) => row.status === 'resumed'), 'SCENARIO_QC_ISSUE_STOP_NOT_EARNED');
  c.earned(`${step}.readback`);
}

async function completion(c: Context, p: Production, shortfall: boolean) {
  const s = c.scenario, actual = shortfall ? quantity(s.quantity) * BigInt(80) / BigInt(100) : quantity(s.quantity), actualQty = decimal(actual);
  const made = await c.write('production.complete', s.owner, 'post', `/api/v1/production-batches/${enc(p.batch.id)}/complete-production`, async () => {
    const current = await c.read(s.owner, p.base);
    return { expectedRevision: p.batch.revision, expectedLineFingerprint: current.lineFingerprint, actualQty,
      ...(p.sizeBreakdown ? { actualQtyBySize: garmentSizes(actualQty) } : {}), requestKey: uuid(`${s.key}:production.complete`) };
  }, true);
  ensure(made.completion?.id && quantity(String(made.completion.actualQuantity)) === actual, 'SCENARIO_COMPLETION_ACK_MISMATCH');
  c.result.ids.productionCompletionId = made.completion.id;
  const current = (await c.read(s.owner, p.base)).productionCompletion;
  ensure(current && (shortfall ? current.status === 'out_of_tolerance' && current.productionComplete === true
    : current.productionComplete === true), `SCENARIO_COMPLETION_STOP_NOT_EARNED: ${JSON.stringify(current)}`);
  c.earned('production.completion-readback');
}

async function stockReceipt(master: ScenarioMasterData, c: Context, p: Production, date: string) {
  const s = c.scenario, root = `/api/v1/production-batches/${enc(p.batch.id)}/stock-receipts`;
  const warehouse = master.catalog.warehouses.find(row => row.type === 'Main');
  ensure(warehouse, 'SCENARIO_ACTUAL_WAREHOUSE_MISSING');
  const made = await c.write('stock.receive', s.logistics, 'post', root, async () => {
    const current = await c.read(s.logistics, root);
    return { expectedBatchRevision: p.batch.revision, expectedScopeFingerprint: current.scopeFingerprint,
      warehouseId: warehouse.id, quantity: s.quantity, unit: s.unit, movementDate: date,
      receiptReference: `实际仓库收货 ${s.key}，本批逐项核实入库`, ownership: 'Owned', unitCost: null, currency: s.currency,
      requestKey: uuid(`${s.key}:stock.receive`) };
  }, true);
  ensure(made.receipt?.id && made.inventoryItem?.id && quantity(String(made.receipt.quantity)) === quantity(s.quantity), 'SCENARIO_PHYSICAL_RECEIPT_ACK_MISMATCH');
  c.result.ids.stockReceiptId = made.receipt.id; c.result.ids.inventoryItemId = made.inventoryItem.id;
  const current = await c.read(s.logistics, root);
  ensure(current.receipts?.some((row: any) => (row.receipt ?? row).id === made.receipt.id), 'SCENARIO_PHYSICAL_RECEIPT_READBACK_MISSING');
  c.earned('stock.readback');
}

const shipmentUrl = (id: string) => `/api/v1/shipping/${enc(id)}`;
const handoffUrl = (id: string) => `/api/v1/shipping/handoffs/${enc(id)}`;
async function physicalContext(c: Context, shipmentId: string, actor: ScenarioActorKey) {
  const current = await c.read(actor, `${shipmentUrl(shipmentId)}/physical-context`);
  ensure(current.updatedAt != null && current.allocationFingerprint, 'SCENARIO_PHYSICAL_CURRENT_SOURCE_MISSING');
  return { expectedShipmentUpdatedAt: String(current.updatedAt), expectedPhysicalAllocationFingerprint: current.allocationFingerprint };
}
async function loading(c: Context, p: Production, date: string, group?: ShippingMember[]) {
  const s = c.scenario;
  ensure(!s.shipmentGroupKey || group, `SCENARIO_CONSOLIDATED_SHIPMENT_COORDINATOR_REQUIRED: ${s.shipmentGroupKey}`);
  const planned = plannedShipmentQuantity(s), members = group ?? [{ c, p, planned }];
  const input = { shippingMethod: 'Sea', requestKey: uuid(`${s.key}:shipment.handoff-create`), note: `业务提交实际出运基础资料 ${s.key}`,
    allocations: members.map(member => ({ orderId: member.p.orderId, orderLineId: member.p.lineId, productionBatchId: member.p.batch.id,
      productionBatchRevision: member.p.batch.revision, factoryRelationId: member.c.scenario.supplierId,
      plannedQty: member.planned, unit: member.c.scenario.unit })) };
  const checkEligibility = async () => {
    const gate = (await c.read(s.owner, '/api/v1/shipping/handoffs/eligibility', input, 'post')).data;
    ensure(gate?.eligible === true, `SCENARIO_SHIPMENT_NOT_ELIGIBLE: ${JSON.stringify(gate)}`);
    return input;
  };
  // A group command hashes both immutable draft sources on every resume. Do
  // not rerun pre-reservation eligibility after the original create committed.
  if (group && !await c.deps.journal.read(`${s.key}:shipment.handoff-create`)) await checkEligibility();
  const initial = (await c.write('shipment.handoff-create', s.owner, 'post', '/api/v1/shipping/handoffs', group ? input : checkEligibility, true)).data;
  ensure(initial?.handoff?.id && initial.shipment?.id, 'SCENARIO_HANDOFF_ACK_MISSING');
  const handoffId = String(initial.handoff.id), shipmentId = String(initial.shipment.id);
  for (const member of members) { member.c.result.ids.handoffId = handoffId; member.c.result.ids.shipmentId = shipmentId; }
  await c.write('shipment.logistics-start', s.logistics, 'post', `${handoffUrl(handoffId)}/start`, async () => {
    const current = (await c.read(s.logistics, handoffUrl(handoffId))).data;
    return { expectedUpdatedAt: current.handoff.expectedUpdatedAt };
  });
  const verified = (await c.write('shipment.actual-loading', s.logistics, 'post', `${handoffUrl(handoffId)}/actual-loading`, async () => {
    const current = (await c.read(s.logistics, `${handoffUrl(handoffId)}/actual-loading`)).data?.bundle;
    ensure(current?.handoff?.status === 'Processing', 'SCENARIO_LOADING_NOT_ACCEPTED_BY_LOGISTICS');
    return { expectedUpdatedAt: current.handoff.expectedUpdatedAt, requestKey: uuid(`${s.key}:shipment.actual-loading`),
      reason: '后勤在模拟工厂现场逐行核实真实直装数量；不是入我方仓库的收货事实。',
      allocations: current.allocations.map((allocation: any) => {
        const member = members.find(row => row.p.orderId === allocation.orderId && row.p.lineId === allocation.orderLineId);
        ensure(member && allocation.unit === member.c.scenario.unit && allocation.productionBatchAllocations.length === 1,
          'SCENARIO_LOADING_EXACT_GROUP_SOURCE_MISMATCH');
        return { allocationId: allocation.id, expectedAllocationUpdatedAt: allocation.expectedUpdatedAt,
          orderId: allocation.orderId, orderLineId: allocation.orderLineId, unit: allocation.unit,
          productionBatchAllocations: allocation.productionBatchAllocations.map((actual: any) => {
            ensure(actual.productionBatchId === member.p.batch.id && actual.productionBatchRevision === member.p.batch.revision
              && actual.factoryRelationId === member.c.scenario.supplierId && actual.unit === member.c.scenario.unit,
            'SCENARIO_LOADING_EXACT_GROUP_BRANCH_MISMATCH');
            return { physicalAllocationId: actual.id,
          expectedPhysicalUpdatedAt: actual.expectedUpdatedAt, productionBatchId: actual.productionBatchId, productionBatchRevision: actual.productionBatchRevision,
          factoryRelationId: actual.factoryRelationId, unit: actual.unit, receiptActuals: [],
              factoryLoading: { actualQty: member.planned, loadingDate: date, reference: `工厂实际装货记录 ${member.c.scenario.key}` } };
          }) };
      }) };
  }, true)).data;
  ensure(verified?.handoff?.status === 'Processing' && verified.actualLoadingReceipt?.requiresBusinessDecision === false,
    'SCENARIO_LOADING_REQUIRES_ORIGINAL_BUSINESS_DECISION');
  const current = (await c.read(s.logistics, handoffUrl(handoffId))).data;
  ensure(current?.allocations?.length === members.length && members.every(member => {
    const row = current.allocations.find((allocation: any) => allocation.orderId === member.p.orderId && allocation.orderLineId === member.p.lineId);
    return row && quantity(String(row.plannedQty)) === quantity(member.planned) && quantity(String(row.actualQty)) === quantity(member.planned);
  }), 'SCENARIO_LOADING_CURRENT_FACT_MISMATCH');
  for (const member of members) member.c.earned('shipment.actual-loading-readback');
  return { handoffId, shipmentId, planned };
}

async function packing(c: Context, p: Production, shipmentId: string, planned: string, group?: ShippingMember[]) {
  const s = c.scenario, members = group ?? [{ c, p, planned }];
  const products = new Map<string, { code: string; name: string }>();
  for (const member of members) {
    const actual = await member.c.read(member.c.scenario.logistics, `/api/v1/order-lines?orderId=${enc(member.p.orderId)}`);
    const line = actual.lines?.find((row: any) => row.id === member.p.lineId);
    ensure(line?.materialCode && line?.description, 'SCENARIO_PACKING_PRODUCT_SOURCE_MISSING');
    products.set(member.p.lineId, { code: line.materialCode, name: line.description });
  }
  await c.write('shipment.packing', s.logistics, 'put', `${shipmentUrl(shipmentId)}/packing`, async () => {
    const current = await c.read(s.logistics, `${shipmentUrl(shipmentId)}/packing`);
    return { requestKey: uuid(`${s.key}:shipment.packing`), expectedShipmentUpdatedAt: String(current.context.updatedAt),
      expectedPhysicalAllocationFingerprint: current.context.allocationFingerprint,
      lines: members.map((member, index) => ({ clientLineKey: group ? `actual-line-${index + 1}` : 'actual-line', orderLineId: member.p.lineId,
        productCode: products.get(member.p.lineId)!.code, productName: products.get(member.p.lineId)!.name,
        quantity: member.planned, unit: member.c.scenario.unit, cartons: 1, grossWeight: '10', netWeight: '9', volume: '0.125',
        hsCode: null, countryOfOrigin: 'CN' })),
      cartons: members.map((member, index) => ({ cartonNo: `A-${index + 1}`, description: '实测包件', length: '50', width: '50', height: '50',
        grossWeight: '10', netWeight: '9', volume: '0.125', items: [{ lineKey: group ? `actual-line-${index + 1}` : 'actual-line', quantity: member.planned }] })) };
  }, true);
  const current = await c.read(s.logistics, `${shipmentUrl(shipmentId)}/packing`);
  ensure(current.lines?.length === members.length && members.every(member => {
    const row = current.lines.find((line: any) => line.orderLineId === member.p.lineId);
    return row && quantity(String(row.quantity)) === quantity(member.planned);
  }) && current.cartons?.length === members.length,
    'SCENARIO_PACKING_READBACK_MISMATCH');
  for (const member of members) {
    member.c.result.ids.shipmentLineIds = current.lines.filter((row: any) => row.orderLineId === member.p.lineId).map((row: any) => String(row.id));
    member.c.earned('shipment.packing-readback');
  }
}

async function book(c: Context, shipmentId: string, date: string, packages = 1) {
  const s = c.scenario;
  await c.write('shipment.book', s.logistics, 'patch', shipmentUrl(shipmentId), async () => ({
    ...await physicalContext(c, shipmentId, s.logistics), requestKey: uuid(`${s.key}:shipment.book`),
    status: 'Booked', bookingDate: date, shippingMethod: 'Sea', loadType: 'LCL', bookingNo: `${s.key}-BOOK`,
    vesselOrFlight: 'MV Nordic Pioneer', voyageNumber: 'SIM-01', portOfLoading: 'Shanghai', portOfDischarge: 'London',
    etd: date, totalPackages: packages, grossWeight: String(10 * packages), netWeight: String(9 * packages), volume: decimal(BigInt(1250 * packages)),
  }), true);
}

type IssuedScenarioDocument = { documentId: string; versionId: string; version: number };
type LoadedShipment = { handoffId: string; shipmentId: string; planned: string };
const documentUrl = (id: string) => `/api/v1/customs/trade-documents/${enc(id)}`;
async function issuedVersion(c: Context, documentId: string, expectedVersionId?: string): Promise<IssuedScenarioDocument> {
  const current = await c.read(c.scenario.logistics, `${documentUrl(documentId)}/versions`);
  const versions = current.items;
  ensure(Array.isArray(versions) && versions.length > 0, 'SCENARIO_ISSUED_DOCUMENT_VERSION_MISSING');
  const version = expectedVersionId ? versions.find((row: any) => row.id === expectedVersionId)
    : [...versions].sort((a, b) => b.version - a.version)[0];
  ensure(version?.id && version.documentId === documentId && Number.isSafeInteger(version.version) && version.version > 0,
    'SCENARIO_ISSUED_DOCUMENT_VERSION_MISMATCH');
  return { documentId, versionId: version.id, version: version.version };
}

async function commercialInvoice(c: Context, shipmentId: string, planned: string): Promise<IssuedScenarioDocument> {
  const s = c.scenario, path = shipmentUrl(shipmentId);
  const selection = { lineIds: c.result.ids.shipmentLineIds };
  const ciDraft = (await c.write('documents.ci-draft', s.logistics, 'post', `${path}/business-ci/draft`, async () => {
    const source = (await c.read(s.logistics, `${path}/business-ci/source`, selection, 'post')).data;
    ensure(source?.sourceFingerprint && source.currency === s.currency && quantity(String(source.totalAmount)) === quantity(money(planned, s.unitPrice)),
      'SCENARIO_CI_CURRENT_SOURCE_MISMATCH');
    return { ...selection, requestKey: uuid(`${s.key}:documents.ci-draft`), expectedSourceFingerprint: source.sourceFingerprint };
  }, true)).data;
  ensure(ciDraft?.item?.id, 'SCENARIO_CI_DRAFT_ACK_MISSING');
  const ci = (await c.write('documents.ci-issue', s.logistics, 'post', `${path}/business-ci/${enc(ciDraft.item.id)}/issue`, async () => {
    const source = (await c.read(s.logistics, `${path}/business-ci/source`, selection, 'post')).data;
    ensure(source?.sourceFingerprint, 'SCENARIO_CI_CURRENT_SOURCE_MISSING');
    return { ...selection, requestKey: uuid(`${s.key}:documents.ci-issue`), expectedSourceFingerprint: source.sourceFingerprint };
  }, true)).data;
  ensure(ci?.item?.id === ciDraft.item.id && ci.item.status === 'Issued' && ci.versionId, 'SCENARIO_CI_ISSUED_ACK_MISSING');
  c.result.ids.ciDocumentId = ci.item.id; c.result.ids.ciVersionId = ci.versionId;
  return issuedVersion(c, ci.item.id, ci.versionId);
}

async function returnedDocuments(master: ScenarioMasterData, c: Context, p: Production, shipment: LoadedShipment, options: OrderDriverOptions,
  group?: ShippingMember[]) {
  const s = c.scenario, { shipmentId, handoffId } = shipment, path = shipmentUrl(shipmentId);
  const members = group ?? [{ c, p, planned: shipment.planned }];
  await book(c, shipmentId, options.businessDate, members.length);
  ensure(options.archiveExternalFiling, 'SCENARIO_EXTERNAL_FILING_UPLOAD_REQUIRED');
  const external = (await c.write('documents.external-register', s.logistics, 'post', '/api/v1/customs/trade-documents', {
    type: 'ExportDeclarationProof', shipmentId, orderId: p.orderId, relationId: s.customerId,
    notes: `第三方提供的实际申报完成凭据 ${s.key}，由后勤上传原文件；不代替外部申报。`,
  })).item;
  ensure(external?.id, 'SCENARIO_EXTERNAL_DOCUMENT_ACK_MISSING');
  const uploaded = await options.archiveExternalFiling({ master, scenario: s, orderId: p.orderId, shipmentId, documentId: external.id, deps: c.deps });
  ensure(uploaded.documentId === external.id && uploaded.reference?.trim(), 'SCENARIO_EXTERNAL_FILING_UPLOAD_MISMATCH');
  const original = (await c.read(s.logistics, documentUrl(external.id))).item;
  ensure(original?.id === external.id && original.type === 'ExportDeclarationProof' && original.shipmentId === shipmentId && original.filePath,
    'SCENARIO_EXTERNAL_ARCHIVE_READBACK_MISSING');
  for (const member of members) { member.c.result.ids.externalFilingDocumentId = external.id; member.c.earned('documents.external-archive-readback'); }
  await c.write('documents.external-filing-complete', s.logistics, 'post', `${path}/export-declaration-completion`, async () => ({
    ...await physicalContext(c, shipmentId, s.logistics), requestKey: uuid(`${s.key}:documents.external-filing-complete`),
    completedAt: `${options.businessDate}T00:00:00.000Z`, evidenceDocumentId: external.id, reference: uploaded.reference,
  }), true);
  // The native CI producer enforces contract/LC packages. A combined shipment
  // keeps the two original contracts and earns their two independent CIs.
  const cis: IssuedScenarioDocument[] = [];
  for (const member of members) cis.push(await commercialInvoice(member.c, shipmentId, member.planned));
  const generated = await c.write('documents.pl-register', s.logistics, 'post', '/api/v1/customs/trade-documents/generate-from-shipment', async () => {
    const current = await c.read(s.logistics, `${path}/document-set`);
    ensure(current.source?.kind === 'physical' && current.source.cartonCoverageComplete === true
      && /^[a-f0-9]{64}$/.test(current.source.fingerprint), 'SCENARIO_PL_CURRENT_PHYSICAL_SOURCE_MISSING');
    return { shipmentId, types: ['PackingList'], expectedShipmentSourceFingerprint: current.source.fingerprint };
  }, true);
  const pl = [...(generated.created ?? []), ...(generated.skipped ?? [])].find(row => row.type === 'PackingList');
  ensure(pl?.id && !(generated.missing?.length), 'SCENARIO_NATIVE_PL_ACK_MISSING');
  const issued = (await c.write('documents.pl-issue', s.logistics, 'post', `${documentUrl(pl.id)}/transition`, { toStatus: 'Issued' })).item;
  ensure(issued?.id === pl.id && issued.status === 'Issued', 'SCENARIO_PL_ISSUED_ACK_MISSING');
  const packingList = await issuedVersion(c, pl.id), documents = [...cis, packingList];
  for (const member of members) { member.c.result.ids.plDocumentId = pl.id; member.c.result.ids.plVersionId = packingList.versionId; }
  for (const [index, document] of documents.entries()) {
    // The CI generator publishes a new audited file per invocation; it has no
    // stable native key. A lost ACK requires readback, never blind regeneration.
    const member = index < cis.length ? members[index] : members[0], kind = index < cis.length ? 'ci' : 'pl';
    await member.c.write(`documents.${kind}-archive`, member.c.scenario.logistics, 'post', `${documentUrl(document.documentId)}/generate-file`,
      { version: document.version }, kind === 'pl');
    const bytes = await member.c.read(member.c.scenario.owner, `${documentUrl(document.documentId)}/download?version=${document.version}`);
    ensure(typeof bytes === 'string' ? bytes.startsWith('%PDF-')
      : (Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) && Buffer.from(bytes).subarray(0, 5).toString() === '%PDF-',
    'SCENARIO_ORIGINAL_DOCUMENT_DOWNLOAD_NOT_PDF');
  }
  for (const member of members) member.c.earned('documents.original-ci-pl-download-readback');
  const returned = (await c.write('documents.return-to-business', s.logistics, 'post', `${handoffUrl(handoffId)}/complete`, async () => {
    const current = (await c.read(s.logistics, handoffUrl(handoffId))).data;
    return { expectedUpdatedAt: current.handoff.expectedUpdatedAt, note: '后勤核对当前已签发CI、PL及外部凭据，交回原业务负责人。' };
  })).data;
  ensure(returned?.handoff?.status === 'ReturnedToBusiness' && returned.shipment?.status === 'Booked' && returned.shipment.atd == null,
    'SCENARIO_DOCUMENT_RETURN_IS_NOT_DEPARTURE');
  const current = (await c.read(s.owner, handoffUrl(handoffId))).data;
  const originalDeparture = await c.deps.journal.read(`${s.key}:shipment.actual-departure-logistics`);
  const laterEarnedDeparture = s.stopAfter !== 'document_return' && originalDeparture
    && current?.shipment?.status === 'Shipped' && current.shipment.atd === options.businessDate;
  ensure(current?.handoff?.status === 'ReturnedToBusiness' && (current.shipment?.atd == null || laterEarnedDeparture),
    'SCENARIO_RETURNED_DOCUMENT_READBACK_MISSING');
  for (const [index, member] of members.entries()) {
    const visible = await member.c.read(member.c.scenario.owner, `/api/v1/orders/${enc(member.p.orderId)}/shipment-documents`);
    ensure([cis[index], packingList].every(document => JSON.stringify(visible).includes(document.documentId)),
      'SCENARIO_RETURNED_DOCUMENT_READBACK_MISSING');
    member.c.earned('documents.returned-readback');
  }
  return documents;
}

async function depart(master: ScenarioMasterData, c: Context, p: Production, shipment: LoadedShipment, documents: IssuedScenarioDocument[], date: string,
  group?: ShippingMember[]) {
  const s = c.scenario, customer = master.catalog.customers.find(row => row.id === s.customerId)!;
  const members = group ?? [{ c, p, planned: shipment.planned }];
  for (const document of documents) {
    const ownCi = members.find(member => member.c.result.ids.ciDocumentId === document.documentId), member = ownCi ?? members[0];
    const kind = ownCi ? 'ci' : 'pl';
    await member.c.write(`documents.${kind}-send`, member.c.scenario.owner, 'post', `/api/v1/orders/${enc(member.p.orderId)}/shipment-documents/sent`, {
      requestKey: uuid(`${member.c.scenario.key}:documents.${kind}-send`), shipmentId: shipment.shipmentId,
      documentId: document.documentId, versionId: document.versionId, version: document.version, recipient: customer.primaryContactEmail,
    }, true);
  }
  const departed = (await c.write('shipment.actual-departure-logistics', s.logistics, 'post', `${handoffUrl(shipment.handoffId)}/confirm-departure`, async () => {
    const current = (await c.read(s.logistics, handoffUrl(shipment.handoffId))).data;
    return { ...await physicalContext(c, shipment.shipmentId, s.logistics), requestKey: uuid(`${s.key}:shipment.actual-departure-logistics`),
      expectedUpdatedAt: current.handoff.expectedUpdatedAt, atd: date };
  }, true)).data;
  ensure(departed?.shipment?.status === 'Shipped' && departed.shipment.atd === date, 'SCENARIO_ATD_ACK_MISSING');
  const current = (await c.read(s.owner, handoffUrl(shipment.handoffId))).data;
  ensure(current?.shipment?.status === 'Shipped' && current.shipment.atd === date, 'SCENARIO_ACTUAL_DEPARTURE_READBACK_MISSING');
  for (const member of members) member.c.earned('shipment.actual-departure-readback');
}

async function finance(master: ScenarioMasterData, c: Context, shipment: LoadedShipment, ci: IssuedScenarioDocument, options: OrderDriverOptions) {
  const s = c.scenario;
  // Ledger §5.4: the supplier owes only the earned fabric commission. The
  // ordinary goods CI must never create our full-price customer receivable.
  if (s.stopAfter === 'commission_pending') {
    ensure(s.family === 'fabric', 'SCENARIO_GARMENT_COMMISSION_MODE_NOT_CONFIRMED');
    ensure(options.continueFabricCommission, 'SCENARIO_COMMISSION_SOURCE_PRODUCER_REQUIRED');
    c.enter('commission.continue');
    const earned = await options.continueFabricCommission({ master, scenario: s, orderId: String(c.result.ids.orderId),
      lineId: String(c.result.ids.lineId), deps: c.deps });
    ensure(earned.key === s.key && earned.earnedSteps.every(step => step.startsWith('commission.'))
      && Object.keys(earned.ids).every(key => key.startsWith('commission')), 'SCENARIO_COMMISSION_CONTINUATION_SOURCE_MISMATCH');
    for (const step of earned.earnedSteps) c.earned(step);
    Object.assign(c.result.ids, earned.ids);
    ensure(earned.stopReached, earned.blockedAt ?? 'SCENARIO_COMMISSION_STOP_NOT_EARNED');
    ensure(earned.earnedSteps.includes('commission.ar.unpaid-readback'), 'SCENARIO_COMMISSION_UNPAID_AR_READBACK_MISSING');
    return true;
  }
  const invoice = (await c.write('finance.ci-register-ar', s.finance, 'post',
    `/api/v1/finance/business-ci/${enc(ci.documentId)}/register`, {}, true)).item;
  const expectedAmount = quantity(money(shipment.planned, s.unitPrice));
  ensure(invoice?.id && invoice.type === 'Receivable' && invoice.sourceType === 'BusinessShipmentCI' && invoice.sourceId === ci.versionId
    && invoice.customerRelationId === s.customerId && invoice.currency === s.currency && quantity(String(invoice.amount)) === expectedAmount,
  'SCENARIO_REGISTERED_AR_ORIGINAL_CI_MISMATCH');
  c.result.ids.receivableInvoiceId = invoice.id;
  const currentAr = async () => {
    const current = (await c.read(s.finance, `/api/v2/finance/invoices/${enc(invoice.id)}`)).invoice;
    const allocations = await c.read(s.finance, `/api/v1/finance/allocations?invoiceId=${enc(invoice.id)}`);
    ensure(current?.id === invoice.id && current.sourceId === ci.versionId && current.currency === s.currency
      && quantity(String(current.amount)) === expectedAmount && Array.isArray(allocations.items)
      && allocations.total === allocations.items.length, 'SCENARIO_AR_CURRENT_SOURCE_OR_ALLOCATION_SET_CHANGED');
    const applied = allocations.items.reduce((sum: bigint, row: any) => sum + quantity(String(row.appliedAmount)), BigInt(0));
    return { invoice: current, allocations: allocations.items, applied };
  };
  if (s.stopAfter === 'shipped_unpaid') {
    const current = await currentAr();
    ensure(current.applied === BigInt(0) && current.invoice.status === 'Issued', 'SCENARIO_SHIPPED_AR_IS_NOT_UNPAID');
    c.earned('finance.unpaid-ar-readback'); return true;
  }
  ensure(s.stopAfter === 'partially_settled' || s.stopAfter === 'settled' || s.stopAfter === 'supplier_payment_pending', 'SCENARIO_UNKNOWN_FINANCE_STOP');
  ensure(options.resolveCashAccount, 'SCENARIO_ACTUAL_CASH_ACCOUNT_REQUIRED');
  const paid = s.stopAfter === 'partially_settled' ? expectedAmount / BigInt(2) : expectedAmount;
  ensure(paid > BigInt(0) && (s.stopAfter !== 'partially_settled' || paid * BigInt(2) === expectedAmount), 'SCENARIO_EXACT_PART_PAYMENT_PRECISION_REQUIRED');
  const payment = (await c.write('finance.actual-customer-receipt', s.finance, 'post', '/api/v2/finance/payments', async () => {
    const resolved = await options.resolveCashAccount!(s);
    ensure(resolved?.id, 'SCENARIO_ACTUAL_CASH_ACCOUNT_REQUIRED');
    const account = (await c.read(s.finance, `/api/v1/finance/cash-accounts/${enc(resolved.id)}`)).account;
    ensure(account?.id === resolved.id && account.currency === s.currency && Number.isSafeInteger(account.revision),
      'SCENARIO_ACTUAL_CASH_ACCOUNT_CURRENCY_OR_REVISION_MISMATCH');
    return { requestKey: uuid(`${s.key}:finance.actual-customer-receipt`), companyAccountId: account.id, expectedAccountRevision: account.revision,
      bankReference: `${s.key}-ACTUAL-RECEIPT`, type: 'Receipt', amount: decimal(paid), actualAccountAmount: decimal(paid), bankFee: '0', feeBearer: 'OUR',
      currency: s.currency, paymentDate: options.businessDate, paymentMethod: 'TT', customerRelationId: s.customerId,
      customerName: master.catalog.customers.find(row => row.id === s.customerId)!.name,
      notes: `已核实票款 ${decimal(paid)} ${s.currency}，银行实际净入账同额且无手续费；非由审批或账期自动生成。` };
  }, true)).payment;
  ensure(payment?.id && payment.cashEntryId && payment.companyAccountId && payment.type === 'Receipt' && payment.currency === s.currency
    && quantity(String(payment.amount)) === paid, 'SCENARIO_ACTUAL_RECEIPT_CASH_ACK_MISSING');
  c.result.ids.receiptVoucherId = payment.id; c.result.ids.cashEntryId = payment.cashEntryId; c.result.ids.cashAccountId = payment.companyAccountId;
  const allocation = (await c.write('finance.allocate-customer-receipt', s.finance, 'post', '/api/v1/finance/allocations', {
    invoiceId: invoice.id, voucherId: payment.id, appliedAmount: decimal(paid), appliedDate: options.businessDate,
  })).allocation;
  ensure(allocation?.id && allocation.invoiceId === invoice.id && allocation.voucherId === payment.id
    && quantity(String(allocation.appliedAmount)) === paid, 'SCENARIO_RECEIPT_ALLOCATION_ACK_MISSING');
  c.result.ids.receiptAllocationId = allocation.id;
  const current = await currentAr(), account = await c.read(s.finance, `/api/v1/finance/cash-accounts/${enc(payment.companyAccountId)}`);
  ensure(current.applied === paid && current.invoice.status === (paid === expectedAmount ? 'Paid' : 'PartiallyPaid')
    && current.allocations.some((row: any) => row.id === allocation.id)
    && account.entries?.some((row: any) => row.id === payment.cashEntryId && row.sourceVoucherId === payment.id
      && row.kind === 'Receipt' && quantity(String(row.amount)) === paid), 'SCENARIO_CUSTOMER_AR_CASH_READBACK_MISMATCH');
  // Unknown Opening remains unknown. This pipeline records an actual bank
  // transaction; it never infers a zero Opening or manufactures a cash balance.
  c.earned('finance.customer-ar-readback');
  // These named scenarios include supplier AP and company settlement. AR paid
  // alone cannot earn that target without the actual contract/AP/payment chain.
  ensure(options.continueSupplierFinance, 'SCENARIO_SUPPLIER_AP_SOURCE_PRODUCER_REQUIRED');
  c.enter('supplier-finance.continue');
  const supplier = await options.continueSupplierFinance({ master, scenario: s, orderId: String(c.result.ids.orderId),
    lineId: String(c.result.ids.lineId), customerInvoiceId: invoice.id, deps: c.deps });
  ensure(supplier.key === s.key && supplier.earnedSteps.every(step => step.startsWith('supplier-finance.'))
    && Object.keys(supplier.ids).every(key => key.startsWith('supplier')), 'SCENARIO_SUPPLIER_CONTINUATION_SOURCE_MISMATCH');
  for (const step of supplier.earnedSteps) c.earned(step);
  Object.assign(c.result.ids, supplier.ids);
  ensure(supplier.stopReached, supplier.blockedAt ?? 'SCENARIO_SUPPLIER_FINANCE_STOP_NOT_EARNED');
  ensure(supplier.earnedSteps.includes(s.stopAfter === 'supplier_payment_pending' ? 'supplier-finance.payment-request.pending-readback'
    : `supplier-finance.ap.cash.${s.stopAfter === 'settled' ? 'fully' : 'partially'}-settled-readback`), 'SCENARIO_SUPPLIER_FINANCE_READBACK_MISSING');
  return true;
}

async function continueProduction(master: ScenarioMasterData, c: Context, p: Production, options: OrderDriverOptions,
  onShippingReady?: (production: Production) => void) {
  const s = c.scenario, primary = s.family === 'fabric' ? 'fabric_eps' : 'garment_pp';
  const sample = await nativeSample(c, p, primary, options.businessDate,
    s.stopAfter === 'sample_qc_pending' ? 'pending' : s.stopAfter === 'sample_rework' ? 'fail' : 'approved');
  if (s.stopAfter === 'sample_qc_pending' || s.stopAfter === 'sample_rework') return true;
  if (s.family === 'garment') await ppRelease(c, p, sample.sampleId);
  if (s.stopAfter === 'production_preparation') return true;
  if (s.stopAfter === 'production_running') {
    const progress = await c.read(s.owner, '/api/v1/production/progress');
    ensure(progress.items?.some((row: any) => row.order?.id === p.orderId && row.state === 'in_progress'), 'SCENARIO_ACTUAL_BRANCH_PROGRESS_NOT_CURRENT');
    c.earned('production.current-progress'); return true;
  }
  if (s.stopAfter === 'production_qc_rework') { await productionQc(master, c, p, options.businessDate, true); return true; }
  await completion(c, p, s.stopAfter === 'quantity_shortfall');
  if (s.stopAfter === 'quantity_shortfall') return true;
  await productionQc(master, c, p, options.businessDate);
  await nativeSample(c, p, s.family === 'fabric' ? 'fabric_ss' : 'garment_ship', options.businessDate);
  if (s.stopAfter === 'warehouse_handoff') { await stockReceipt(master, c, p, options.businessDate); return true; }
  if (s.shipmentGroupKey && onShippingReady) {
    onShippingReady(p); c.earned('shipment.group-source-ready'); return false;
  }
  const shipped = await loading(c, p, options.businessDate);
  if (s.stopAfter === 'factory_loading') {
    ensure((await c.read(s.logistics, `${shipmentUrl(shipped.shipmentId)}/packing`)).lines?.length === 0, 'SCENARIO_FACTORY_LOADING_ALREADY_PACKED');
    return true;
  }
  await packing(c, p, shipped.shipmentId, shipped.planned);
  const documents = await returnedDocuments(master, c, p, shipped, options);
  if (s.stopAfter === 'document_return') return true;
  await depart(master, c, p, shipped, documents, options.businessDate);
  if (s.stopAfter === 'partially_shipped') return true;
  return finance(master, c, shipped, documents[0], options);
}

function assertShipmentPair(rows: OrderScenario[], groupKey: string) {
  ensure(rows.length === 2 && new Set(rows.map(row => row.key)).size === 2,
    `SCENARIO_CONSOLIDATED_SHIPMENT_COORDINATOR_REQUIRED: ${groupKey}: both original scenarios are required`);
  const first = rows[0];
  ensure(rows.every(row => row.shipmentGroupKey === groupKey && row.customerId === first.customerId && row.owner === first.owner
    && row.family === first.family && row.currency === first.currency && row.unit === first.unit && row.teamKey === first.teamKey)
    && rows.some(row => row.stopAfter === 'partially_shipped') && rows.some(row => row.stopAfter === 'shipped_unpaid'),
  `SCENARIO_CONSOLIDATION_INCOMPATIBLE: ${groupKey}: this script needs one same-customer/owner/family partial + full unpaid pair`);
}

async function consolidatedShipment(master: ScenarioMasterData, members: ShippingMember[], options: OrderDriverOptions) {
  // Stable ordering gives the same original journal/key even if the caller
  // resumes the two scenarios in a different array order.
  members.sort((a, b) => a.c.scenario.key.localeCompare(b.c.scenario.key));
  const anchor = members[0];
  const shipped = await loading(anchor.c, anchor.p, options.businessDate, members);
  await packing(anchor.c, anchor.p, shipped.shipmentId, anchor.planned, members);
  const documents = await returnedDocuments(master, anchor.c, anchor.p, shipped, options, members);
  await depart(master, anchor.c, anchor.p, shipped, documents, options.businessDate, members);
  for (const member of members) {
    const { c, p, planned } = member, s = c.scenario;
    const current = await c.read(s.owner, `/api/v1/shipping/allocations/by-order/${enc(p.orderId)}`);
    ensure(Array.isArray(current.items), 'SCENARIO_CONSOLIDATED_ORDER_ALLOCATION_SOURCE_MISSING');
    const exact = current.items.filter((row: any) => row.shipmentId === shipped.shipmentId && row.orderLineId === p.lineId);
    const actual = exact[0], branch = actual?.productionBatchAllocations?.[0];
    const physicalScope = branch?.scopeSnapshot?.scopeSnapshot;
    ensure(exact.length === 1 && actual.orderId === p.orderId && actual.shipmentStatus === 'Shipped' && actual.unit === s.unit
      && quantity(String(actual.actualQty)) === quantity(planned) && actual.productionBatchAllocations.length === 1
      && branch.productionBatchId === p.batch.id && branch.productionBatchRevision === p.batch.revision
      && physicalScope?.factoryRelationId === s.supplierId && physicalScope.batch?.factoryRelationId === s.supplierId
      && physicalScope.batch.id === p.batch.id && physicalScope.batch.revision === p.batch.revision
      && branch.state === 'shipped' && branch.unit === s.unit
      && quantity(String(branch.actualQty)) === quantity(planned), 'SCENARIO_CONSOLIDATED_CURRENT_BRANCH_NOT_SHIPPED');
    const totalShipped = current.items.filter((row: any) => row.orderLineId === p.lineId && row.status !== 'Cancelled' && row.shipmentStatus === 'Shipped')
      .reduce((sum: bigint, row: any) => sum + quantity(String(row.actualQty)), BigInt(0));
    ensure(totalShipped === quantity(planned) && (s.stopAfter === 'partially_shipped' ? totalShipped < quantity(s.quantity)
      : totalShipped === quantity(s.quantity)), 'SCENARIO_CONSOLIDATED_PARTIAL_FULL_READBACK_MISMATCH');
    c.earned(s.stopAfter === 'partially_shipped' ? 'shipment.partial-order-allocation-readback' : 'shipment.full-order-allocation-readback');
    if (s.stopAfter === 'partially_shipped') c.result.stopReached = true;
    else {
      const ownCi = documents.find(document => document.documentId === c.result.ids.ciDocumentId);
      ensure(ownCi, 'SCENARIO_CONSOLIDATED_ORIGINAL_CONTRACT_CI_MISSING');
      // Register the exact original CI once. Never split a combined CI into
      // duplicate financial invoices according to the number of source orders.
      c.result.stopReached = await finance(master, c, { ...shipped, planned }, ownCi, options);
    }
  }
}

/** The caller supplies authenticated HTTP and private durable journaling.
 * Each scenario fails independently; an HTTP/gate/unknown ACK never becomes a
 * reached target, and no later step executes after that failure. */
export async function runOrderScenarios(master: ScenarioMasterData, scenarios: OrderScenario[], deps: ScenarioDriverDependencies,
  options: OrderDriverOptions): Promise<ScenarioExecution[]> {
  const results: ScenarioExecution[] = [];
  const ready = new Map<string, ShippingMember[]>();
  for (const s of scenarios) {
    const result: ScenarioExecution = { key: s.key, earnedSteps: [], stopReached: false, ids: {} }, c = context(s, deps, result);
    try {
      if (s.shipmentGroupKey) assertShipmentPair(scenarios.filter(row => row.shipmentGroupKey === s.shipmentGroupKey), s.shipmentGroupKey);
      const p = await draft(master, c, options);
      if (s.stopAfter === 'draft') {
        ensure((await c.read(s.owner, `/api/v2/orders/${enc(p.orderId)}`)).order.status === 'Pending', 'SCENARIO_DRAFT_ALREADY_ADVANCED');
        result.stopReached = true;
      } else {
        if (options.prepareCommercialTerms) {
          c.enter('commercial-terms.prepare');
          await options.prepareCommercialTerms({ master, scenario: s, orderId: p.orderId, lineId: p.lineId, deps });
        }
        if (options.prepareFinancialInstrument) {
          c.enter('financial-instrument.prepare');
          await options.prepareFinancialInstrument({ master, scenario: s, orderId: p.orderId, lineId: p.lineId, deps });
        }
        if (!await approval(master, c, p.orderId)) result.stopReached = true;
        else {
          await materialSupply(master, c, p, options);
          result.stopReached = await continueProduction(master, c, await branch(c, p), options, production => {
            const groupKey = s.shipmentGroupKey!;
            ready.set(groupKey, [...(ready.get(groupKey) ?? []), { c, p: production, planned: plannedShipmentQuantity(s) }]);
          });
        }
      }
    } catch (error) { result.blockedAt = `${c.at}: ${error instanceof Error ? error.message : String(error)}`; }
    results.push(result);
  }
  for (const [groupKey, members] of ready) {
    if (members.length !== 2) {
      const missing = scenarios.filter(row => row.shipmentGroupKey === groupKey && !members.some(member => member.c.scenario.key === row.key));
      for (const member of members) member.c.result.blockedAt = `SCENARIO_CONSOLIDATION_PARTNER_NOT_READY: ${missing.map(row => row.key).join(', ')}`;
      continue;
    }
    try { await consolidatedShipment(master, members, options); }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      for (const member of members) if (!member.c.result.stopReached)
        member.c.result.blockedAt = `consolidated ${groupKey} (${members.map(row => row.c.at).join('; ')}): ${reason}`;
    }
  }
  return results;
}
