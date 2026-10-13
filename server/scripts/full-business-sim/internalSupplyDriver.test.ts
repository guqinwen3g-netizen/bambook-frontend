import { describe, expect, it } from 'vitest';
import { planScenarioMasterData } from './masterData';
import { buildBusinessScenarios } from './scenarios';
import type { ScenarioCommandRecord, ScenarioDriverDependencies, ScenarioHttpMethod } from './driverContract';
import { prepareInternalSupplyTerms, runInternalSupplyScenario, type InternalSupplyOptions } from './internalSupplyDriver';

const master = planScenarioMasterData({ namespace: 'internal-driver', nowMs: Date.parse('2026-10-08T00:18:00.000Z') });
const scenario = buildBusinessScenarios(master).orders.find(row => row.family === 'garment' && row.stopAfter === 'production_preparation')!;
const fabricTeam = master.businessTeams.find(team => team.key === 'fabric1')!;
const factory = master.catalog.factories.fabric.find(row => fabricTeam.supplierIds.includes(row.id))!;
const options: InternalSupplyOptions = { businessDate: '2026-10-08', fabricOwner: 'fabric1Lead', fabricSupplierId: factory.id,
  sourceQuantity: '1000', unitPrice: '3.20', currency: 'CNY', metres: '720' };

/** Deliberately bounded transport fake. The real route's team authorization,
 * MOQ, source/approval facts and locks still require isolated HTTP/PG proof. */
function boundary() {
  const orderId = 'GARMENT-ORDER', lineId = 'GARMENT-LINE';
  const target = { id: orderId, ownerId: master.cast[scenario.owner].id, status: 'Pending', businessLine: 'garment',
    customerRelationId: scenario.customerId, lines: [{ id: lineId, orderId, quantity: scenario.quantity, unit: 'PC', fulfillmentMode: 'cmt', cmtIncludedItems: [] }] };
  const records = new Map<string, ScenarioCommandRecord>(), orders = new Map<string, any>(), approvals = new Map<string, any>();
  const nativeReceipts = new Map<string, any>(), calls: Array<{ actor: string; method: ScenarioHttpMethod; url: string; body: any }> = [];
  let allocation: any = null, lostSourceAck = false, lostAllocationAck = false, disabled = false, wrongCandidate = false, wrongRemaining = false;
  let sourceCreates = 0, allocationCreates = 0;
  const personnel = { canWrite: true, creatorFamilies: ['fabric'], teams: master.businessTeams.map(team => ({ id: team.id,
    businessFamily: team.businessFamily, members: team.memberIds.map(id => ({ id })) })) };
  const deps: ScenarioDriverDependencies = {
    runtimeId: 'pure-internal-supply', actorIds: Object.fromEntries(Object.values(master.cast).map(actor => [actor.key, actor.id])) as ScenarioDriverDependencies['actorIds'],
    verifyActor: async () => { if (disabled) throw Error('actual actor disabled'); },
    journal: { read: async key => records.get(key) ?? null, write: async value => { records.set(value.key, structuredClone(value)); } },
    invoke: async (actor, method, url, body: any) => {
      calls.push({ actor, method, url, body: structuredClone(body) });
      if (method === 'get' && url === `/api/v2/orders/${orderId}`) return { status: 200, body: { ok: true, order: structuredClone(target) } };
      if (method === 'get' && url === `/api/v1/order-lines?orderId=${orderId}`) return { status: 200, body: { ok: true, lines: structuredClone(target.lines) } };
      if (method === 'put' && url === `/api/v1/order-lines/${lineId}`) {
        Object.assign(target.lines[0], body); return { status: 200, body: { ok: true, line: structuredClone(target.lines[0]) } };
      }
      if (method === 'get' && url === '/api/v1/orders/internal-demand/personnel') return { status: 200, body: { ok: true, data: structuredClone(personnel) } };
      if (method === 'post' && url === '/api/v2/orders') {
        const order = { ...body, id: `FABRIC-${orders.size + 1}`, lines: [] };
        sourceCreates++; orders.set(order.id, order);
        if (lostSourceAck) { lostSourceAck = false; throw Error('source created but ACK lost'); }
        return { status: 200, body: { ok: true, order: structuredClone(order) } };
      }
      if (method === 'post' && url === '/api/v1/order-lines') {
        const line = { ...body, id: `${body.orderId}__${body.itemNo}`, confirmedSourceType: 'ManualOrderLine', confirmedSourceId: `${body.orderId}__${body.itemNo}` };
        orders.get(body.orderId).lines.push(line); return { status: 200, body: { ok: true, line: structuredClone(line) } };
      }
      const source = url.match(/^\/api\/v2\/orders\/(FABRIC-\d+)(?:\/(submit-main-approval))?$/);
      if (source) {
        const order = orders.get(source[1]);
        if (method === 'get') return { status: 200, body: { ok: true, order: structuredClone(order) } };
        if (method === 'post' && source[2]) {
          const approval = { id: `APP-${approvals.size + 1}`, status: 'pending', requesterId: master.cast[actor].id, targetId: order.id,
            actionType: 'order:main_approval', reviewContentVersion: 'b'.repeat(64), payload: { snapshot: { order: structuredClone(order) } } };
          approvals.set(approval.id, approval); return { status: 201, body: { ok: true, item: structuredClone(approval) } };
        }
      }
      const review = url.match(/^\/api\/v1\/approvals\/(APP-\d+)(?:\/decide)?$/);
      if (review) {
        const approval = approvals.get(review[1]);
        if (method === 'get') return { status: 200, body: { item: structuredClone(approval) } };
        approval.status = body.status; approval.reviewerId = master.cast[actor].id; orders.get(approval.targetId).status = 'Confirmed';
        return { status: 200, body: { item: { ...structuredClone(approval), businessSyncStatus: 'completed' } } };
      }
      const material = url.match(/^\/api\/v1\/orders\/([^/]+)\/lines\/([^/]+)\/(fabric-allocation-context|fabric-allocations)$/);
      if (material) {
        const sourceOrder = orders.values().next().value, sourceLine = sourceOrder?.lines[0];
        if (method === 'get' && material[3] === 'fabric-allocation-context') {
          const used = allocation?.status === 'active' ? Number(allocation.metres) : 0;
          const remaining = wrongRemaining ? '1000' : String(Number(sourceLine.quantity) - used);
          if (material[1] === orderId) return { status: 200, body: { ok: true, data: { orderId, lineId, fulfillmentMode: target.lines[0].fulfillmentMode,
            canWrite: true, allocation: structuredClone(allocation), candidates: sourceOrder.status === 'Confirmed' ? [{ orderId: wrongCandidate ? 'FOREIGN-FABRIC' : sourceOrder.id,
              lineId: sourceLine.id, unit: 'M', quantity: sourceLine.quantity, allocated: String(used), remaining,
              internalDemandTeamId: sourceOrder.internalDemandTeamId, internalReceiverId: sourceOrder.internalReceiverId }] : [] } } };
          return { status: 200, body: { ok: true, data: { orderId: sourceOrder.id, lineId: sourceLine.id, sourceQuantity: sourceLine.quantity,
            remaining, outgoingAllocations: allocation?.status === 'active' ? [structuredClone(allocation)] : [] } } };
        }
        if (method === 'post' && material[3] === 'fabric-allocations') {
          const prior = nativeReceipts.get(body.requestKey);
          if (prior) return { status: 200, body: { ok: true, data: structuredClone(prior) } };
          allocation = { id: 'ALLOC-1', fabricOrderId: sourceOrder.id, fabricOrderLineId: sourceLine.id, garmentOrderId: orderId,
            garmentOrderLineId: lineId, metres: body.metres, revision: 1, status: 'active', auditId: 'ALLOC-AUDIT' };
          allocationCreates++;
          const data = { allocation: structuredClone(allocation), commandAck: { protocolVersion: 1, operation: 'allocate', actorId: master.cast[actor].id,
            requestKey: body.requestKey, allocationId: allocation.id, auditId: allocation.auditId, revision: 1, status: 'active' } };
          nativeReceipts.set(body.requestKey, data);
          if (lostAllocationAck) { lostAllocationAck = false; throw Error('allocation committed but ACK lost'); }
          return { status: 200, body: { ok: true, data: structuredClone(data) } };
        }
      }
      throw Error(`Unexpected internal supply endpoint: ${method} ${url}`);
    },
  };
  return { target, orders, approvals, calls, deps, records, personnel, context: { master, scenario, orderId, lineId, deps },
    get allocation() { return allocation; }, get sourceCreates() { return sourceCreates; }, get allocationCreates() { return allocationCreates; },
    approveTarget: () => { target.status = 'Confirmed'; target.lines[0].fulfillmentMode = 'full_package'; },
    loseSource: () => { lostSourceAck = true; }, loseAllocation: () => { lostAllocationAck = true; }, disable: () => { disabled = true; },
    corruptCandidate: () => { wrongCandidate = true; }, corruptRemaining: () => { wrongRemaining = true; } };
}

describe('actual internal fabric planning scenario', () => {
  it('sets explicit full-package terms through the exact draft line and rechecks the current readback', async () => {
    const f = boundary(); await prepareInternalSupplyTerms(f.context);
    expect(f.target.lines[0]).toMatchObject({ fulfillmentMode: 'full_package', cmtIncludedItems: [] });
    expect(f.calls.filter(row => row.method === 'put')).toEqual([{ actor: scenario.owner, method: 'put', url: '/api/v1/order-lines/GARMENT-LINE',
      body: { fulfillmentMode: 'full_package', cmtIncludedItems: [] } }]);
    await prepareInternalSupplyTerms(f.context); expect(f.calls.filter(row => row.method === 'put')).toHaveLength(1);
    f.target.lines[0].fulfillmentMode = 'cmt'; await expect(prepareInternalSupplyTerms(f.context)).rejects.toThrow('DRAFT_TERMS_READBACK_MISMATCH');
  });

  it('earns a fabric-group internal order, original approval and exact two-sided metre planning without warehouse or finance facts', async () => {
    const f = boundary(); f.approveTarget();
    const result = await runInternalSupplyScenario(f.context, options);
    expect(result, result.blockedAt).toMatchObject({ stopReached: true, ids: { internalSupplyOrderId: 'FABRIC-1', internalSupplyLineId: 'FABRIC-1__0010',
      internalSupplyTargetOrderId: 'GARMENT-ORDER', internalSupplyAllocationId: 'ALLOC-1', internalSupplyMetres: '720', internalSupplyRemainingMetres: '280' } });
    expect(result.earnedSteps).toContain('internalSupply.allocation.both-sides-readback');
    expect(f.calls.find(row => row.method === 'post' && row.url === '/api/v2/orders')).toMatchObject({ actor: 'fabric1Lead', body: {
      orderPurpose: 'internal_fabric_supply', internalDemandTeamId: master.businessTeams.find(team => team.key === scenario.teamKey)!.id,
      internalReceiverId: master.cast[scenario.owner].id, customerRelationId: null, poNumber: null, unit: 'M', quantity: '1000', quoteAmount: '3200' } });
    expect(f.calls.find(row => row.url.endsWith('/decide'))?.actor).toBe('fabricManager');
    expect(f.calls.find(row => row.url.endsWith('/fabric-allocations'))).toMatchObject({ actor: scenario.owner, body: { fabricOrderLineId: 'FABRIC-1__0010', metres: '720', expectedRevision: 0 } });
    expect(f.calls.some(row => /inventory|stock-receipt|finance|production-complete/.test(row.url))).toBe(false);
    expect(f.orders.size).toBe(1); expect(f.approvals.size).toBe(1);
  });

  it('recovers a committed allocation with its exact original key/body and never recreates the source or approval', async () => {
    const f = boundary(); f.approveTarget(); f.loseAllocation();
    expect((await runInternalSupplyScenario(f.context, options)).stopReached).toBe(false);
    const resumed = await runInternalSupplyScenario(f.context, options);
    expect(resumed, resumed.blockedAt).toMatchObject({ stopReached: true });
    const requests = f.calls.filter(row => row.url.endsWith('/fabric-allocations'));
    expect(requests).toHaveLength(2); expect(requests[1].body).toEqual(requests[0].body);
    expect(f.allocationCreates).toBe(1); expect(f.sourceCreates).toBe(1); expect(f.approvals.size).toBe(1);
    f.allocation.status = 'cancelled';
    expect((await runInternalSupplyScenario(f.context, options)).blockedAt).toContain('BOTH_SIDES_SOURCE_MISMATCH');
    expect(f.allocationCreates).toBe(1);
  });

  it('retains an unknown generic source-create ACK for explicit reconciliation', async () => {
    const f = boundary(); f.approveTarget(); f.loseSource();
    expect((await runInternalSupplyScenario(f.context, options)).stopReached).toBe(false);
    expect((await runInternalSupplyScenario(f.context, options)).blockedAt).toContain('ACK_UNKNOWN_RECONCILE_REQUIRED');
    expect(f.sourceCreates).toBe(1); expect(f.approvals.size).toBe(0);
  });

  it('rejects foreign responsibility, over-allocation and current membership loss before creating a source', async () => {
    for (const patch of [{ fabricOwner: scenario.owner }, { sourceQuantity: '719.9999' }, { fabricSupplierId: scenario.supplierId }]) {
      const f = boundary(); f.approveTarget();
      expect((await runInternalSupplyScenario(f.context, { ...options, ...patch })).stopReached).toBe(false);
      expect(f.sourceCreates).toBe(0);
    }
    const f = boundary(); f.approveTarget(); f.personnel.creatorFamilies = [];
    expect((await runInternalSupplyScenario(f.context, options)).blockedAt).toContain('CURRENT_MEMBERSHIP_MISMATCH');
    expect(f.sourceCreates).toBe(0);
  });

  it('does not accept a foreign candidate, inconsistent remaining metres or a stale/disabled actor on replay', async () => {
    const foreign = boundary(); foreign.approveTarget(); foreign.corruptCandidate();
    expect((await runInternalSupplyScenario(foreign.context, options)).blockedAt).toContain('CURRENT_CANDIDATE_MISMATCH');
    expect(foreign.allocationCreates).toBe(0);
    const f = boundary(); f.approveTarget();
    expect((await runInternalSupplyScenario(f.context, options)).stopReached).toBe(true);
    f.corruptRemaining(); expect((await runInternalSupplyScenario(f.context, options)).blockedAt).toContain('REMAINING_NOT_CONSERVED');
    f.disable(); const calls = f.calls.length;
    expect((await runInternalSupplyScenario(f.context, options)).blockedAt).toContain('actual actor disabled'); expect(f.calls).toHaveLength(calls);
  });
});
