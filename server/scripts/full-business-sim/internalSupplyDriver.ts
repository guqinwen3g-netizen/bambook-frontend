/** Native internal fabric planning only. An allocation is not stock, a fabric
 * production completion, an internal invoice or an actual payment. */
import { createHash } from 'node:crypto';
import type { ScenarioActorKey, ScenarioMasterData } from './masterData';
import type { OrderScenario } from './scenarios';
import { scenarioCommand, type ScenarioDriverDependencies, type ScenarioExecution, type ScenarioHttpMethod } from './driverContract';

export interface InternalSupplyContext {
  master: ScenarioMasterData; scenario: OrderScenario; orderId: string; lineId: string; deps: ScenarioDriverDependencies;
}
export interface InternalSupplyOptions {
  businessDate: string;
  /** Actual fabric-group operator and one of that group's actual factories. */
  fabricOwner: ScenarioActorKey; fabricSupplierId: string;
  /** Explicit synthetic internal requirement and quotation, never inferred
   * from garment piece count, sales price or historical product archives. */
  sourceQuantity: string; unitPrice: string; currency: 'CNY' | 'USD' | 'EUR'; metres: string;
}

const enc = encodeURIComponent, SCALE = BigInt(10000), ZERO = BigInt(0);
function ensure(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
function metres(value: unknown): bigint {
  ensure(typeof value === 'string' && /^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(value), 'INTERNAL_SUPPLY_DECIMAL_INVALID');
  const [whole, fraction = ''] = value.split('.'); return BigInt(whole) * SCALE + BigInt(fraction.padEnd(4, '0'));
}
function decimal(value: bigint) {
  const fraction = String(value % SCALE).padStart(4, '0').replace(/0+$/, '');
  return `${value / SCALE}${fraction ? `.${fraction}` : ''}`;
}
function uuid(value: string) { const hash = createHash('sha256').update(`bambook-internal-supply:${value}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`; }
function validate(c: InternalSupplyContext) {
  ensure(c.scenario.family === 'garment' && c.scenario.key.startsWith(`${c.master.namespace}-`) && c.orderId && c.lineId
    && c.deps.runtimeId?.trim() && Object.values(c.master.cast).every(actor => c.deps.actorIds[actor.key] === actor.id),
  'INTERNAL_SUPPLY_ACTUAL_SOURCE_OR_ACTOR_MISMATCH');
  const team = c.master.businessTeams.find(row => row.key === c.scenario.teamKey);
  ensure(team?.businessFamily === 'garment' && team.memberIds.includes(c.master.cast[c.scenario.owner].id)
    && team.customerIds.includes(c.scenario.customerId), 'INTERNAL_SUPPLY_DEMAND_TEAM_MISMATCH');
  return team;
}
async function read(c: InternalSupplyContext, actor: ScenarioActorKey, url: string) {
  await c.deps.verifyActor(actor); const response = await c.deps.invoke(actor, 'get', url);
  ensure(response.status === 200 && response.body?.ok !== false,
    `INTERNAL_SUPPLY_READ_REJECTED: ${url}: HTTP ${response.status}: ${JSON.stringify(response.body)}`);
  return response.body;
}
function lineFrom(order: any, lineId: string) { return order?.lines?.find((line: any) => line.id === lineId); }
function assertTarget(c: InternalSupplyContext, order: any, formal: boolean) {
  const line = lineFrom(order, c.lineId);
  ensure(order?.id === c.orderId && String(order.businessLine || order.type).toLowerCase() === 'garment'
    && order.customerRelationId === c.scenario.customerId && order.ownerId === c.master.cast[c.scenario.owner].id
    && line?.orderId === c.orderId && line.unit === 'PC' && metres(String(line.quantity)) === metres(c.scenario.quantity),
  'INTERNAL_SUPPLY_TARGET_LINE_MISMATCH');
  if (formal) ensure(['Confirmed', 'Production', 'Shipping', 'Delivered', 'Alert'].includes(order.status)
    && line.fulfillmentMode === 'full_package' && Array.isArray(line.cmtIncludedItems), 'INTERNAL_SUPPLY_TARGET_NOT_FORMAL_FULL_PACKAGE');
  return line;
}

/** Use the normal draft-line producer before the main approval freezes the
 * selected mode. Unknown generic PUT acknowledgements require reconciliation;
 * they are never relabelled as a native idempotent command. */
export async function prepareInternalSupplyTerms(c: InternalSupplyContext): Promise<void> {
  validate(c);
  assertTarget(c, (await read(c, c.scenario.owner, `/api/v2/orders/${enc(c.orderId)}`)).order, false);
  await scenarioCommand(c.deps, { key: `${c.scenario.key}:internalSupply.terms`, actor: c.scenario.owner, method: 'put',
    url: `/api/v1/order-lines/${enc(c.lineId)}`, body: { fulfillmentMode: 'full_package', cmtIncludedItems: [] } });
  const actual = (await read(c, c.scenario.owner, `/api/v1/order-lines?orderId=${enc(c.orderId)}`)).lines?.find((row: any) => row.id === c.lineId);
  ensure(actual?.orderId === c.orderId && actual.fulfillmentMode === 'full_package' && Array.isArray(actual.cmtIncludedItems)
    && actual.cmtIncludedItems.length === 0, 'INTERNAL_SUPPLY_DRAFT_TERMS_READBACK_MISMATCH');
}

/** An extra fabric source is reported as an auxiliary order, not a replacement
 * for any of the 36 planned customer orders or 24 development stopping points.
 * Existing producers enforce permissions, MOQ, actual approval and capacity. */
export async function runInternalSupplyScenario(c: InternalSupplyContext, options: InternalSupplyOptions): Promise<ScenarioExecution> {
  const { master, scenario: s, deps } = c;
  const result: ScenarioExecution = { key: s.key, stopReached: false, earnedSteps: [], ids: {} };
  let at = 'internalSupply.validate';
  const earn = (step: string) => { if (!result.earnedSteps.includes(step)) result.earnedSteps.push(step); };
  const write = async (step: string, actor: ScenarioActorKey, method: ScenarioHttpMethod, url: string,
    body: unknown | (() => Promise<unknown>), idempotent = false): Promise<any> => {
    at = `internalSupply.${step}`;
    const key = `${s.key}:internalSupply.${step}`, previous = await deps.journal.read(key);
    const input = typeof body === 'function' ? previous ? previous.body : await body() : body;
    at = `internalSupply.${step}`;
    const ack = await scenarioCommand(deps, { key, actor, method, url, body: input, idempotent }); earn(at); return ack;
  };
  try {
    const demandTeam = validate(c), sourceQty = metres(options.sourceQuantity), allocatedQty = metres(options.metres), price = metres(options.unitPrice);
    ensure(sourceQty > ZERO && allocatedQty > ZERO && allocatedQty <= sourceQty && price > ZERO
      && sourceQty * price % SCALE === ZERO && ['CNY', 'USD', 'EUR'].includes(options.currency), 'INTERNAL_SUPPLY_EXPLICIT_QUANTITY_PRICE_REQUIRED');
    ensure(/^\d{4}-\d{2}-\d{2}$/.test(options.businessDate)
      && new Date(`${options.businessDate}T00:00:00.000Z`).toISOString().slice(0, 10) === options.businessDate, 'INTERNAL_SUPPLY_BUSINESS_DATE_REQUIRED');
    const fabricActor = master.cast[options.fabricOwner], fabricSupplier = master.catalog.suppliers.find(row => row.id === options.fabricSupplierId);
    const fabricTeam = master.businessTeams.find(row => row.businessFamily === 'fabric' && fabricActor && row.memberIds.includes(fabricActor.id)
      && row.supplierIds.includes(options.fabricSupplierId));
    ensure(fabricTeam && fabricSupplier?.kind === 'fabric_mill' && fabricSupplier.factoryProfileId
      && master.approvalAuthorities.fabric.includes(master.cast.fabricManager.id), 'INTERNAL_SUPPLY_FABRIC_TEAM_OR_FACTORY_MISMATCH');
    at = 'internalSupply.current-target';
    assertTarget(c, (await read(c, s.owner, `/api/v2/orders/${enc(c.orderId)}`)).order, true);
    const personnel = await read(c, options.fabricOwner, '/api/v1/orders/internal-demand/personnel');
    ensure(personnel.data?.canWrite === true && personnel.data.creatorFamilies?.includes('fabric')
      && personnel.data.teams?.some((row: any) => row.id === fabricTeam.id && row.businessFamily === 'fabric'
        && row.members?.some((member: any) => member.id === fabricActor.id))
      && personnel.data.teams.some((row: any) => row.id === demandTeam.id && row.businessFamily === 'garment'
        && row.members?.some((member: any) => member.id === master.cast[s.owner].id)), 'INTERNAL_SUPPLY_CURRENT_MEMBERSHIP_MISMATCH');
    earn('internalSupply.current-responsibilities-readback');

    const fabricAsset = master.catalog.fabricAssets.find(asset => asset.factoryRelationId === fabricSupplier.id);
    ensure(fabricAsset, 'INTERNAL_SUPPLY_FABRIC_CATALOG_REQUIRED');
    const purpose = `${s.key} 的准确成衣行 ${c.lineId} 全包面料需求；分配 ${options.metres} M，余量保持未分配。`;
    const made = await write('draft.create', options.fabricOwner, 'post', '/api/v2/orders', () => ({
      type: 'fabric', businessLine: 'fabric', orderPurpose: 'internal_fabric_supply', internalPurpose: purpose,
      internalDemandTeamId: demandTeam.id, internalReceiverId: master.cast[s.owner].id, customer: demandTeam.name, customerRelationId: null, poNumber: null,
      product: fabricAsset.name, quantity: options.sourceQuantity, unit: 'M', quoteAmount: decimal(sourceQty * price / SCALE), status: 'Pending',
      ownerId: fabricActor.id, departmentId: fabricActor.departmentId, salesPerson: fabricActor.name, dueDate: s.dueDate,
      contractDate: s.contractDate, currency: options.currency, millRelationId: fabricSupplier.id, millName: fabricSupplier.name,
      finalContractNumber: `${s.key}-internal-supply`, source: 'bambook-full-business-simulation-internal-supply',
    }));
    const orderId = made.order?.id;
    ensure(typeof orderId === 'string' && made.order.orderPurpose === 'internal_fabric_supply'
      && made.order.customerRelationId === null && made.order.poNumber === null, 'INTERNAL_SUPPLY_DRAFT_ACK_MISSING');
    result.ids.internalSupplyOrderId = orderId;
    const created = await write('line.create', options.fabricOwner, 'post', '/api/v1/order-lines', {
      orderId, itemNo: '0010', materialCode: fabricAsset.sku, description: fabricAsset.name, colorCode: fabricAsset.colorCode,
      quantity: options.sourceQuantity, unit: 'M', unitPrice: options.unitPrice, requiredSampleFamilies: ['fabric_eps', 'fabric_ss'],
      partialShipmentAllowed: true, tolerancePercent: '5', toleranceSource: 'line_override',
      manualSpecification: { factoryRelationId: fabricSupplier.id, specification: `${fabricAsset.name}；色号 ${fabricAsset.colorCode} ${fabricAsset.colorDescription}；按内部需求的面料规格供给。`,
        agreementBasis: `实际需求组 ${demandTeam.name} 及接收负责人 ${master.cast[s.owner].name} 的演练书面需求；不冒充开发QC、库存或付款。`,
        evidence: [`simulation:${s.key}:internal-fabric-written-requirement`] },
    });
    const lineId = created.line?.id;
    ensure(typeof lineId === 'string' && created.line.orderId === orderId && created.line.confirmedSourceType === 'ManualOrderLine'
      && created.line.confirmedSourceId === lineId, 'INTERNAL_SUPPLY_MANUAL_SOURCE_NOT_EARNED');
    result.ids.internalSupplyLineId = lineId;
    const orderUrl = `/api/v2/orders/${enc(orderId)}`;
    const assertSource = (order: any) => {
      const line = lineFrom(order, lineId);
      ensure(order?.id === orderId && order.orderPurpose === 'internal_fabric_supply' && String(order.businessLine || order.type).toLowerCase() === 'fabric'
        && order.internalDemandTeamId === demandTeam.id && order.internalReceiverId === master.cast[s.owner].id
        && order.internalPurpose === purpose && order.customerRelationId === null && order.poNumber === null && order.ownerId === fabricActor.id
        && order.currency === options.currency && line?.orderId === orderId && line.unit === 'M'
        && metres(String(line.quantity)) === sourceQty && metres(String(line.unitPrice)) === price
        && line.confirmedSourceType === 'ManualOrderLine' && line.confirmedSourceId === lineId, 'INTERNAL_SUPPLY_SOURCE_READBACK_MISMATCH');
      return order;
    };
    assertSource((await read(c, options.fabricOwner, orderUrl)).order);
    const submitted = await write('approval.submit', options.fabricOwner, 'post', `${orderUrl}/submit-main-approval`, {});
    const approvalId = submitted.item?.id;
    ensure(typeof approvalId === 'string', 'INTERNAL_SUPPLY_APPROVAL_ACK_MISSING');
    result.ids.internalSupplyApprovalId = approvalId;
    const approvalUrl = `/api/v1/approvals/${enc(approvalId)}`, review = (await read(c, 'fabricManager', approvalUrl)).item;
    ensure(review?.id === approvalId && review.targetId === orderId && review.actionType === 'order:main_approval'
      && review.requesterId === fabricActor.id && /^[a-f0-9]{64}$/.test(review.reviewContentVersion), 'INTERNAL_SUPPLY_ORIGINAL_REVIEW_MISMATCH');
    assertSource(review.payload?.snapshot?.order);
    const decided = await write('approval.decide', 'fabricManager', 'post', `${approvalUrl}/decide`, async () => ({
      status: 'approved', confirmedReviewedContent: true, reviewContentVersion: review.reviewContentVersion,
      decisionNote: '核对面料组经办、内部成衣需求组/接收人、准确行米数和手录规格；批准不制造库存或内部票款。',
    }));
    ensure(decided.item?.id === approvalId && decided.item.status === 'approved' && decided.item.reviewerId === master.cast.fabricManager.id
      && decided.item.businessSyncStatus === 'completed', 'INTERNAL_SUPPLY_APPROVAL_NOT_EARNED');
    const sourceOrder = assertSource((await read(c, options.fabricOwner, orderUrl)).order);
    const currentApproval = (await read(c, 'fabricManager', approvalUrl)).item;
    ensure(['Confirmed', 'Production', 'Shipping', 'Delivered', 'Alert'].includes(sourceOrder.status)
      && currentApproval?.status === 'approved' && currentApproval.targetId === orderId
      && currentApproval.reviewerId === master.cast.fabricManager.id, 'INTERNAL_SUPPLY_APPROVAL_READBACK_MISMATCH');
    earn('internalSupply.approved-source-readback');

    const targetContextUrl = `/api/v1/orders/${enc(c.orderId)}/lines/${enc(c.lineId)}/fabric-allocation-context`;
    const requestKey = uuid(`${s.key}:allocate-internal-fabric`);
    const saved = (await write('allocation.save', s.owner, 'post',
      `/api/v1/orders/${enc(c.orderId)}/lines/${enc(c.lineId)}/fabric-allocations`, async () => {
        const target = (await read(c, s.owner, targetContextUrl)).data;
        const selected = target?.candidates?.find((row: any) => row.lineId === lineId);
        ensure(target?.orderId === c.orderId && target.lineId === c.lineId && target.fulfillmentMode === 'full_package'
          && target.canWrite === true && target.allocation === null && selected?.orderId === orderId && selected.unit === 'M'
          && selected.internalDemandTeamId === demandTeam.id && selected.internalReceiverId === master.cast[s.owner].id
          && metres(String(selected.remaining)) >= allocatedQty, 'INTERNAL_SUPPLY_CURRENT_CANDIDATE_MISMATCH');
        return { requestKey, fabricOrderLineId: lineId, metres: options.metres, expectedRevision: 0 };
      }, true)).data;
    const allocation = saved?.allocation, command = saved?.commandAck;
    ensure(allocation?.id && allocation.status === 'active' && allocation.fabricOrderId === orderId && allocation.fabricOrderLineId === lineId
      && allocation.garmentOrderId === c.orderId && allocation.garmentOrderLineId === c.lineId && metres(String(allocation.metres)) === allocatedQty
      && Number.isSafeInteger(allocation.revision) && allocation.revision > 0 && allocation.auditId
      && command?.protocolVersion === 1 && command.operation === 'allocate' && command.actorId === master.cast[s.owner].id
      && command.requestKey === requestKey && command.allocationId === allocation.id && command.auditId === allocation.auditId
      && command.revision === allocation.revision && command.status === 'active', 'INTERNAL_SUPPLY_ALLOCATION_ACK_MISMATCH');
    Object.assign(result.ids, { internalSupplyAllocationId: allocation.id, internalSupplyAllocationRevision: String(allocation.revision),
      internalSupplyAllocationAuditId: allocation.auditId, internalSupplyMetres: decimal(allocatedQty), internalSupplySourceQuantity: decimal(sourceQty),
      internalSupplyTargetOrderId: c.orderId, internalSupplyTargetLineId: c.lineId, internalSupplyDemandTeamId: demandTeam.id });
    at = 'internalSupply.allocation.both-sides-readback';
    const target = (await read(c, s.owner, targetContextUrl)).data;
    const supply = (await read(c, options.fabricOwner,
      `/api/v1/orders/${enc(orderId)}/lines/${enc(lineId)}/fabric-allocation-context`)).data;
    const outgoing = supply?.outgoingAllocations, selected = target?.candidates?.find((row: any) => row.lineId === lineId);
    ensure(target?.orderId === c.orderId && target.lineId === c.lineId && target.fulfillmentMode === 'full_package'
      && target.allocation?.id === allocation.id && target.allocation.status === 'active' && target.allocation.revision === allocation.revision
      && target.allocation.auditId === allocation.auditId && target.allocation.fabricOrderId === orderId && target.allocation.fabricOrderLineId === lineId
      && target.allocation.garmentOrderId === c.orderId && target.allocation.garmentOrderLineId === c.lineId
      && metres(String(target.allocation.metres)) === allocatedQty && supply?.orderId === orderId && supply.lineId === lineId
      && Array.isArray(outgoing) && outgoing.some((row: any) => row.id === allocation.id && row.status === 'active'
        && row.garmentOrderId === c.orderId && row.garmentOrderLineId === c.lineId && row.revision === allocation.revision
        && row.auditId === allocation.auditId && metres(String(row.metres)) === allocatedQty), 'INTERNAL_SUPPLY_BOTH_SIDES_SOURCE_MISMATCH');
    const used = outgoing.reduce((sum: bigint, row: any) => {
      ensure(row.status === 'active' && row.fabricOrderId === orderId && row.fabricOrderLineId === lineId, 'INTERNAL_SUPPLY_OUTGOING_RANGE_MISMATCH');
      return sum + metres(String(row.metres));
    }, ZERO);
    ensure(used <= sourceQty && metres(String(supply.sourceQuantity)) === sourceQty && metres(String(supply.remaining)) === sourceQty - used
      && selected?.orderId === orderId && selected.unit === 'M' && metres(String(selected.quantity)) === sourceQty
      && metres(String(selected.allocated)) === used && metres(String(selected.remaining)) === sourceQty - used,
    'INTERNAL_SUPPLY_REMAINING_NOT_CONSERVED');
    result.ids.internalSupplyRemainingMetres = decimal(sourceQty - used); earn(at); result.stopReached = true;
  } catch (error) { result.blockedAt = `${at}: ${error instanceof Error ? error.message : String(error)}`; }
  return result;
}
