import { describe, expect, it } from 'vitest';
import { planScenarioMasterData } from './masterData';
import { buildBusinessScenarios, type OrderScenario } from './scenarios';
import type { ScenarioCommandRecord, ScenarioDriverDependencies, ScenarioHttpMethod } from './driverContract';
import { runOrderScenarios, type OrderDriverOptions } from './orderDriver';

const master = planScenarioMasterData({ namespace: 'orders-script', nowMs: Date.parse('2026-10-08T00:18:00.000Z') });
const options = { businessDate: '2026-10-08' };
const scenario = (stopAfter: OrderScenario['stopAfter'], family: OrderScenario['family'] = 'fabric') => {
  const value = buildBusinessScenarios(master).orders.find(row => row.family === family && row.stopAfter === stopAfter)!;
  return { ...value, shipmentGroupKey: undefined };
};

/** A deliberately small HTTP boundary fake, not an alternate business service.
 * Unknown endpoints fail, so a script cannot obtain a conclusion from a loose
 * success stub. The real routes/gates are separately exercised in private PG. */
function httpBoundary() {
  const records = new Map<string, ScenarioCommandRecord>();
  const calls: Array<{ actor: string; method: ScenarioHttpMethod; url: string; body: any }> = [];
  const orders = new Map<string, any>(), lines = new Map<string, any>(), approvals = new Map<string, any>();
  const batches = new Map<string, any>(), samples = new Map<string, any>();
  const releaseScopes = new Map<string, any>(), releaseRequests = new Map<string, any>(), assignments = new Map<string, any>(), reports = new Map<string, any>();
  const stockReceipts = new Map<string, any>(), handoffs = new Map<string, any>();
  const materialAllocations = new Map<string, any>();
  const documents = new Map<string, any>(), versions = new Map<string, any[]>(), sentDocuments = new Map<string, any>();
  const invoices = new Map<string, any>(), payments = new Map<string, any>(), allocations = new Map<string, any>(), cashAccounts = new Map<string, any>();
  let lostCreateAck = false;
  const deps: ScenarioDriverDependencies = {
    runtimeId: 'pure-test', actorIds: Object.fromEntries(Object.values(master.cast).map(actor => [actor.key, actor.id])) as ScenarioDriverDependencies['actorIds'],
    verifyActor: async () => {},
    journal: { read: async key => records.get(key) ?? null, write: async value => { records.set(value.key, structuredClone(value)); } },
    invoke: async (actor, method, url, body: any) => {
      calls.push({ actor, method, url, body: structuredClone(body) });
      if (method === 'post' && url === '/api/v2/orders') {
        const order = { ...body, id: `order-${orders.size + 1}`, status: 'Pending', lines: [] }; orders.set(order.id, order);
        if (lostCreateAck) { lostCreateAck = false; throw Error('committed draft acknowledgement disconnected'); }
        return { status: 200, body: { ok: true, order } };
      }
      if (method === 'post' && url === '/api/v1/order-lines') {
        const line = { ...body, id: `${body.orderId}__${body.itemNo}`, confirmedSourceType: 'ManualOrderLine', confirmedSourceId: `${body.orderId}__${body.itemNo}` };
        lines.set(line.id, line); orders.get(body.orderId).lines.push(line); return { status: 200, body: { ok: true, line } };
      }
      if (method === 'get' && url.startsWith('/api/v1/order-lines?')) {
        const orderId = new URL(url, 'http://pure.invalid').searchParams.get('orderId');
        return { status: 200, body: { ok: true, lines: [...lines.values()].filter(line => line.orderId === orderId) } };
      }
      const editLine = url.match(/^\/api\/v1\/order-lines\/([^/]+)$/);
      if (editLine && method === 'put') {
        const line = lines.get(editLine[1]); Object.assign(line, body); return { status: 200, body: { ok: true, line } };
      }
      const material = url.match(/^\/api\/v1\/orders\/([^/]+)\/lines\/([^/]+)\/fabric-allocation-context$/);
      if (material && method === 'get') return { status: 200, body: { ok: true, data: { orderId: material[1], lineId: material[2],
        fulfillmentMode: lines.get(material[2])?.fulfillmentMode, allocation: structuredClone(materialAllocations.get(material[2]) ?? null) } } };
      const binding = url.match(/^\/api\/v1\/order-lines\/([^/]+)\/version$/);
      if (binding && method === 'patch') {
        const line = lines.get(binding[1]); Object.assign(line, body); return { status: 200, body: { ok: true, line } };
      }
      const main = url.match(/^\/api\/v2\/orders\/([^/]+)\/submit-main-approval$/);
      if (method === 'post' && main) {
        const item = { id: `approval-${approvals.size + 1}`, targetId: main[1], status: 'pending', eligibleReviewerIds: master.approvalAuthorities.fabric };
        approvals.set(item.id, item); return { status: 201, body: { ok: true, item } };
      }
      const detail = url.match(/^\/api\/v2\/orders\/([^/]+)$/);
      if (method === 'get' && detail) return { status: 200, body: { ok: true, order: orders.get(detail[1]) } };
      const approval = url.match(/^\/api\/v1\/approvals\/([^/]+)(?:\/(decide|withdraw))?$/);
      if (approval) {
        const item = approvals.get(approval[1]);
        if (method === 'get') return { status: 200, body: { item: { ...item, reviewContentVersion: 'a'.repeat(64) } } };
        if (method === 'post' && approval[2] === 'decide') {
          item.status = body.status; item.reviewerId = master.cast[actor].id;
          if (body.status === 'approved') orders.get(item.targetId).status = 'Confirmed';
          return { status: 200, body: { item: { ...item, businessSyncStatus: body.status === 'approved' ? 'completed' : 'not_applicable' } } };
        }
        if (method === 'post' && approval[2] === 'withdraw') {
          item.status = 'cancelled'; return { status: 200, body: { ok: true, item, commandAck: { requestKey: body.requestKey, approvalId: item.id, status: 'cancelled' } } };
        }
      }
      const production = url.match(/^\/api\/v1\/production-batches\/orders\/([^/]+)\/lines\/([^/]+)$/);
      if (production) {
        if (method === 'get') {
          const current = [...batches.values()].filter(row => row.orderLineId === production[2]);
          return { status: 200, body: { ok: true, lineFingerprint: 'b'.repeat(64), batches: current, productionCompletion: current[0]?.productionCompletion } };
        }
        const batch = { ...body, id: `batch-${batches.size + 1}`, orderId: production[1], orderLineId: production[2], revision: 1, rangeStart: '0', state: 'active' };
        batches.set(batch.id, batch); return { status: 201, body: { ok: true, batch } };
      }
      const native = '/api/v1/samples/order-native';
      if (method === 'get' && url.startsWith(`${native}/context?`)) {
        const orderId = new URL(url, 'http://pure.invalid').searchParams.get('orderId');
        return { status: 200, body: { ok: true, data: { batches: [...batches.values()].filter(row => row.orderId === orderId).map(row => ({ ...row, selectable: true, lineFingerprint: 'b'.repeat(64) })) } } };
      }
      if (method === 'post' && url === `${native}/preview`) return { status: 200, body: { ok: true, data: { parentFingerprint: 'c'.repeat(64) } } };
      if (method === 'post' && url === `${native}/register`) {
        const coverage = body.coverage.map((row: any) => ({ ...row, orderId: body.orderId, productionBatchRevision: row.expectedBatchRevision,
          ...(body.family === 'garment_pp' && materialAllocations.has(row.orderLineId) ? { materialProof: { schemaVersion: 1,
            fulfillmentMode: lines.get(row.orderLineId).fulfillmentMode, cmtIncludedItems: lines.get(row.orderLineId).cmtIncludedItems,
            allocation: structuredClone(materialAllocations.get(row.orderLineId)) } } : {}) }));
        const sample = { sourceId: `source-${samples.size + 1}`, sampleId: `sample-${samples.size + 1}`, eventId: `event-register-${samples.size + 1}`, eventSequence: 1,
          source: { ...body, coverage, sourceId: `source-${samples.size + 1}`, sampleId: `sample-${samples.size + 1}` }, events: [{ eventType: 'registered', payload: body.sampleFacts }],
          view: { pendingQcRequest: null, qc: null, latestFeedback: null }, qcReportSummary: null };
        samples.set(sample.sourceId, sample); return { status: 200, body: { ok: true, data: { ...sample } } };
      }
      if (method === 'post' && url === `${native}/events`) {
        const sample = samples.get(body.sourceId);
        if (body.expectedHead.eventId !== sample.eventId || body.expectedHead.sequence !== sample.eventSequence) return { status: 409, body: { ok: false, error: 'STALE_SAMPLE_HEAD' } };
        sample.eventSequence++; sample.eventId = `event-${sample.sourceId}-${sample.eventSequence}`;
        let payload = body.payload;
        if (body.eventType === 'qc_requested') sample.view.pendingQcRequest = { eventId: sample.eventId, reason: payload.reason };
        if (body.eventType === 'qc_reviewed') {
          const report = { id: `sample-report-${sample.sourceId}`, revision: sample.eventSequence, requestedEventId: payload.requestedEventId,
            sourceId: sample.sourceId, sampleId: sample.sampleId, result: payload.result === 'pass' ? 'passed' : 'failed' };
          sample.qcReportSummary = { id: report.id, revision: report.revision, result: payload.result };
          sample.view.qc = { ...report, eventId: sample.eventId }; sample.view.pendingQcRequest = null;
          payload = { requestedEventId: payload.requestedEventId, report, reportAudit: { targetId: report.id, actorId: master.cast[actor].id } };
        }
        if (body.eventType === 'customer_feedback') sample.view.latestFeedback = { ...payload, eventId: sample.eventId };
        sample.events.push({ id: sample.eventId, sourceId: sample.sourceId, sampleId: sample.sampleId, actorId: master.cast[actor].id, eventType: body.eventType, payload });
        return { status: 200, body: { ok: true, data: { sourceId: sample.sourceId, sampleId: sample.sampleId, eventId: sample.eventId, eventSequence: sample.eventSequence } } };
      }
      if (method === 'get' && url.startsWith(`${native}/source/`)) return { status: 200, body: { ok: true, data: samples.get(url.slice(`${native}/source/`.length)) } };
      if (method === 'post' && /\/release-scopes$/.test(url)) {
        const scope = { ...body, id: `scope-${releaseScopes.size + 1}`, scopeRevision: 1, state: 'no_release' };
        releaseScopes.set(scope.id, scope); return { status: 201, body: { ok: true, scope } };
      }
      const release = url.match(/^\/api\/v1\/releases\/release-scopes\/([^/]+)\/(requests|eligibility)$/);
      if (release && method === 'get') return { status: 200, body: { ok: true, eligible: releaseScopes.get(release[1]).state === 'ready', releaseId: 'release-1' } };
      if (release && method === 'post') {
        const item = { ...body, id: `release-request-${releaseRequests.size + 1}`, scopeId: release[1], requestRevision: 1 };
        releaseRequests.set(item.id, item); return { status: 201, body: { ok: true, request: item } };
      }
      const signature = url.match(/^\/api\/v1\/releases\/release-requests\/([^/]+)\/(action-context|signatures)$/);
      if (signature) {
        const item = releaseRequests.get(signature[1]), scope = releaseScopes.get(item.scopeId);
        if (method === 'get') return { status: 200, body: { ok: true, item: { request: item, scope, reviewContentFingerprint: 'e'.repeat(64) } } };
        scope.state = 'ready'; return { status: 200, body: { ok: true, signature: { id: 'signature-1' } } };
      }
      if (method === 'get' && url === '/api/v1/production/progress') return { status: 200, body: { ok: true, items: [...orders.values()].map(order => ({ order: { id: order.id }, state: 'in_progress' })) } };
      const scopes = url.match(/^\/api\/v1\/qc\/orders\/([^/]+)\/inspection-scopes$/);
      if (scopes && method === 'get') return { status: 200, body: { scopes: [...batches.values()].filter(row => row.orderId === scopes[1]).map(row => ({ productionBatchId: row.id, scopeFingerprint: 'd'.repeat(64) })) } };
      if (method === 'post' && url === '/api/v1/qc/assignments') {
        const item = { ...body, id: `assignment-${assignments.size + 1}`, status: 'Pending', scopeFingerprint: body.expectedScopeFingerprint };
        assignments.set(item.id, item); return { status: 201, body: { ok: true, item } };
      }
      const inspection = url.match(/^\/api\/v1\/qc\/assignments\/([^/]+)\/(start|complete|inspection-context)$/);
      if (inspection) {
        const item = assignments.get(inspection[1]);
        if (method === 'get') return { status: 200, body: { assignment: item, productionQcIssues: { available: true,
          issues: [...reports.values()].filter(row => row.assignmentId === item.id && row.result === 'fail').map(row => ({ issueId: `issue-${row.id}`, status: 'open' })) } } };
        if (inspection[2] === 'start') { item.status = 'InProgress'; return { status: 200, body: { ok: true, item } }; }
        const report = { ...body.report, id: `report-${reports.size + 1}`, assignmentId: item.id, revision: 1,
          scopeFingerprint: body.expectedScopeFingerprint, contentFingerprint: 'f'.repeat(64), approvedByBusiness: false };
        reports.set(report.id, report); item.status = 'Completed'; return { status: 200, body: { ok: true, item, report } };
      }
      const business = url.match(/^\/api\/v1\/qc\/reports\/([^/]+)\/business-decision$/);
      if (business) { const report = reports.get(business[1]); report.approvedByBusiness = body.decision === 'approved'; return { status: 200, body: { ok: true, item: report } }; }
      const completed = url.match(/^\/api\/v1\/production-batches\/([^/]+)\/complete-production$/);
      if (completed) {
        const batch = batches.get(completed[1]); batch.completion = { id: `complete-${batch.id}`, actualQuantity: body.actualQty };
        batch.productionCompletion = { productionComplete: true, actualQty: body.actualQty,
          status: body.actualQty === batch.quantity ? 'complete' : 'out_of_tolerance' };
        return { status: 201, body: { ok: true, completion: batch.completion, orderLineCompletion: batch.productionCompletion } };
      }
      const stock = url.match(/^\/api\/v1\/production-batches\/([^/]+)\/stock-receipts$/);
      if (stock) {
        if (method === 'get') return { status: 200, body: { ok: true, scopeFingerprint: '1'.repeat(64), receipts: [...stockReceipts.values()] } };
        const receipt = { ...body, id: `stock-receipt-${stockReceipts.size + 1}`, productionBatchId: stock[1], inventoryItemId: `inventory-${stockReceipts.size + 1}` };
        stockReceipts.set(receipt.id, receipt); return { status: 201, body: { ok: true, receipt, inventoryItem: { id: receipt.inventoryItemId, quantity: receipt.quantity } } };
      }
      if (method === 'post' && url === '/api/v1/shipping/handoffs/eligibility') return { status: 200, body: { ok: true, data: { eligible: true } } };
      if (method === 'post' && url === '/api/v1/shipping/handoffs') {
        const prior = [...handoffs.values()].find(row => row.handoff.requestKey === body.requestKey);
        if (prior) return { status: 200, body: { ok: true, data: structuredClone(prior) } };
        const id = `handoff-${handoffs.size + 1}`, shipmentId = `shipment-${handoffs.size + 1}`;
        const bundle = { handoff: { id, requestKey: body.requestKey, status: 'PendingLogistics', expectedUpdatedAt: '1' }, shipment: { id: `shipment-${handoffs.size + 1}`, status: 'Draft', updatedAt: '1', atd: null },
          allocations: body.allocations.map((input: any, index: number) => ({ ...input, id: `allocation-${id}-${index}`, shipmentId,
            expectedUpdatedAt: '1', actualQty: null, productionBatchAllocations: [{ ...input, id: `physical-${id}-${index}`, expectedUpdatedAt: '1', actualQty: null, state: 'reserved' }] })) };
        handoffs.set(id, bundle); return { status: 201, body: { ok: true, data: structuredClone(bundle) } };
      }
      const byOrder = url.match(/^\/api\/v1\/shipping\/allocations\/by-order\/([^/]+)$/);
      if (method === 'get' && byOrder) return { status: 200, body: { items: [...handoffs.values()].flatMap(bundle =>
        bundle.allocations.filter((row: any) => row.orderId === byOrder[1]).map((row: any) => ({ ...structuredClone(row), shipmentStatus: bundle.shipment.status,
          // The actual by-order route returns raw SPA rows. Factory identity
          // lives in their frozen scope, not the enriched handoff DTO field.
          productionBatchAllocations: row.productionBatchAllocations.map((physical: any) => {
            const { factoryRelationId, ...raw } = structuredClone(physical);
            return { ...raw, scopeSnapshot: { scopeSnapshot: { factoryRelationId,
              batch: { id: physical.productionBatchId, revision: physical.productionBatchRevision, factoryRelationId } } } };
          }) }))) } };
      const handoff = url.match(/^\/api\/v1\/shipping\/handoffs\/([^/]+)(?:\/(start|actual-loading|complete|confirm-departure))?$/);
      if (handoff) {
        const bundle = handoffs.get(handoff[1]);
        if (method === 'get') return { status: 200, body: { ok: true, data: handoff[2] === 'actual-loading' ? { bundle: structuredClone(bundle), sources: [] } : structuredClone(bundle) } };
        if (handoff[2] === 'start') { bundle.handoff.status = 'Processing'; bundle.handoff.expectedUpdatedAt = '2'; return { status: 200, body: { ok: true, data: structuredClone(bundle) } }; }
        if (handoff[2] === 'actual-loading') {
          if (bundle.actualLoadingReceipt?.requestKey === body.requestKey) return { status: 200, body: { ok: true, data: structuredClone(bundle) } };
          if (body.expectedUpdatedAt !== bundle.handoff.expectedUpdatedAt) return { status: 409, body: { ok: false, error: 'STALE_HANDOFF' } };
          for (const submitted of body.allocations) {
            const allocation = bundle.allocations.find((row: any) => row.id === submitted.allocationId);
            const actualQty = submitted.productionBatchAllocations[0].factoryLoading.actualQty;
            allocation.actualQty = actualQty; allocation.productionBatchAllocations[0].actualQty = actualQty;
          }
          bundle.handoff.expectedUpdatedAt = '3';
          bundle.actualLoadingReceipt = { requestKey: body.requestKey, requiresBusinessDecision: false };
          return { status: 200, body: { ok: true, data: structuredClone(bundle) } };
        }
        if (handoff[2] === 'complete') {
          const originals = [...documents.values()].filter(row => row.shipmentId === bundle.shipment.id);
          if (!bundle.shipment.exportDeclarationCompletedAt || !['CommercialInvoice', 'PackingList'].every(type => originals.some(row => row.type === type && row.status === 'Issued' && row.filePath)))
            return { status: 409, body: { ok: false, error: 'ORIGINAL_DOCUMENTS_NOT_READY' } };
          bundle.handoff.status = 'ReturnedToBusiness'; bundle.handoff.expectedUpdatedAt = '4';
          return { status: 200, body: { ok: true, data: structuredClone(bundle) } };
        }
        if (handoff[2] === 'confirm-departure') {
          const originals = [...documents.values()].filter(row => row.shipmentId === bundle.shipment.id && ['CommercialInvoice', 'PackingList'].includes(row.type));
          if (bundle.handoff.status !== 'ReturnedToBusiness' || !originals.every(row => [...sentDocuments.values()].some(sent => sent.documentId === row.id)))
            return { status: 409, body: { ok: false, error: 'BUSINESS_HAS_NOT_SENT_CURRENT_ORIGINALS' } };
          bundle.shipment.status = 'Shipped'; bundle.shipment.atd = body.atd; bundle.shipment.updatedAt = '7';
          for (const allocation of bundle.allocations) for (const physical of allocation.productionBatchAllocations) physical.state = 'shipped';
          return { status: 200, body: { ok: true, data: structuredClone(bundle) } };
        }
      }
      const packing = url.match(/^\/api\/v1\/shipping\/([^/]+)\/(packing|physical-context)$/);
      if (packing) {
        const bundle = [...handoffs.values()].find(row => row.shipment.id === packing[1]);
        if (method === 'get') return { status: 200, body: packing[2] === 'physical-context' ? { updatedAt: bundle.shipment.updatedAt, allocationFingerprint: '2'.repeat(64) }
          : { context: { updatedAt: bundle.shipment.updatedAt, allocationFingerprint: '2'.repeat(64) }, lines: bundle.lines ?? [], cartons: bundle.cartons ?? [] } };
        bundle.lines = body.lines.map((row: any, index: number) => ({ ...row, id: `shipment-line-${index + 1}` })); bundle.cartons = body.cartons;
        bundle.shipment.updatedAt = '4'; return { status: 200, body: { ok: true } };
      }
      const shipment = url.match(/^\/api\/v1\/shipping\/([^/]+)$/);
      if (shipment && method === 'patch') {
        const bundle = [...handoffs.values()].find(row => row.shipment.id === shipment[1]);
        Object.assign(bundle.shipment, body, { updatedAt: '5' }); return { status: 200, body: { ok: true, shipment: bundle.shipment } };
      }
      const filing = url.match(/^\/api\/v1\/shipping\/([^/]+)\/export-declaration-completion$/);
      if (filing && method === 'post') {
        const bundle = [...handoffs.values()].find(row => row.shipment.id === filing[1]);
        if (!documents.get(body.evidenceDocumentId)?.filePath) return { status: 409, body: { ok: false, error: 'EXTERNAL_ORIGINAL_NOT_UPLOADED' } };
        bundle.shipment.exportDeclarationCompletedAt = body.completedAt; bundle.shipment.updatedAt = '6';
        return { status: 200, body: { ok: true, shipment: bundle.shipment } };
      }
      if (method === 'get' && /^\/api\/v1\/shipping\/[^/]+\/document-set$/.test(url))
        return { status: 200, body: { source: { kind: 'physical', cartonCoverageComplete: true, fingerprint: '4'.repeat(64) } } };
      const ci = url.match(/^\/api\/v1\/shipping\/([^/]+)\/business-ci\/(source|draft|([^/]+)\/issue)$/);
      if (ci && method === 'post') {
        const bundle = [...handoffs.values()].find(row => row.shipment.id === ci[1]);
        const selected = bundle.lines.filter((row: any) => body.lineIds.includes(row.id));
        const parents = selected.map((row: any) => orders.get(lines.get(row.orderLineId).orderId));
        if (!selected.length || new Set(parents.map((order: any) => order.finalContractNumber)).size !== 1)
          return { status: 409, body: { ok: false, error: 'EXACT_CONTRACT_PACKAGE_REQUIRED' } };
        const order = parents[0], totalAmount = String(selected.reduce((total: number, row: any) => total + Number(row.quantity) * Number(lines.get(row.orderLineId).unitPrice), 0));
        if (ci[2] === 'source') return { status: 200, body: { ok: true, data: { sourceFingerprint: '3'.repeat(64), currency: order.currency,
          totalAmount } } };
        if (ci[2] === 'draft') {
          const item = { id: `doc-${documents.size + 1}`, type: 'CommercialInvoice', shipmentId: ci[1], orderId: order.id, orderIds: parents.map((row: any) => row.id),
            totalAmount, currency: order.currency, customerRelationId: order.customerRelationId, status: 'Draft' };
          documents.set(item.id, item); return { status: 201, body: { ok: true, data: { item } } };
        }
        const item = documents.get(ci[3]); item.status = 'Issued';
        const version = { id: `version-${item.id}`, documentId: item.id, version: 1 }; versions.set(item.id, [version]);
        return { status: 200, body: { ok: true, data: { item, versionId: version.id } } };
      }
      if (method === 'post' && url === '/api/v1/customs/trade-documents/generate-from-shipment') {
        if (body.expectedShipmentSourceFingerprint !== '4'.repeat(64)) return { status: 409, body: { ok: false, error: 'EXACT_PL_SOURCE_REQUIRED' } };
        const prior = [...documents.values()].find(row => row.shipmentId === body.shipmentId && row.type === 'PackingList');
        if (prior) return { status: 201, body: { created: [], skipped: [{ id: prior.id, type: prior.type, reason: 'EXISTS' }], missing: [] } };
        const bundle = [...handoffs.values()].find(row => row.shipment.id === body.shipmentId);
        const item = { id: `doc-${documents.size + 1}`, shipmentId: body.shipmentId, type: 'PackingList',
          orderIds: bundle.allocations.map((row: any) => row.orderId), status: 'Draft' };
        documents.set(item.id, item); versions.set(item.id, [{ id: `version-${item.id}`, documentId: item.id, version: 1 }]);
        return { status: 201, body: { created: [item], skipped: [], missing: [] } };
      }
      if (method === 'post' && url === '/api/v1/customs/trade-documents') {
        const item = { ...body, id: `doc-${documents.size + 1}`, status: 'Draft' }; documents.set(item.id, item);
        return { status: 201, body: { item } };
      }
      const document = url.match(/^\/api\/v1\/customs\/trade-documents\/([^/]+)(?:\/(external-archive|transition|versions|generate-file|download))?(?:\?version=\d+)?$/);
      if (document) {
        const item = documents.get(document[1]);
        if (method === 'get' && document[2] === 'versions') return { status: 200, body: { items: versions.get(item.id) ?? [] } };
        if (method === 'get' && document[2] === 'download') return item.filePath
          ? { status: 200, body: Buffer.from('%PDF-1.4\n% pure boundary original\n%%EOF') } : { status: 409, body: { error: 'NO_ORIGINAL_ARCHIVE' } };
        if (method === 'get') return { status: 200, body: { item: structuredClone(item) } };
        if (document[2] === 'transition') { item.status = body.toStatus; return { status: 200, body: { item } }; }
        if (document[2] === 'external-archive' || document[2] === 'generate-file') {
          item.filePath = `pure-boundary/${item.id}.pdf`; return { status: 201, body: { filePath: item.filePath, fileSize: 40 } };
        }
      }
      const orderDocuments = url.match(/^\/api\/v1\/orders\/([^/]+)\/shipment-documents(?:\/(sent))?$/);
      if (orderDocuments) {
        if (method === 'get') return { status: 200, body: { items: [...documents.values()].filter(row => row.orderId === orderDocuments[1] || row.orderIds?.includes(orderDocuments[1])) } };
        sentDocuments.set(body.requestKey, body); return { status: 201, body: { item: body } };
      }
      const registration = url.match(/^\/api\/v1\/finance\/business-ci\/([^/]+)\/register$/);
      if (registration && method === 'post') {
        if (Object.keys(body).length) return { status: 400, body: { error: 'ORIGINAL_CI_ONLY' } };
        const original = documents.get(registration[1]), prior = [...invoices.values()].find(row => row.sourceId === versions.get(original.id)![0].id);
        if (prior) return { status: 200, body: { item: prior, replayed: true } };
        const item = { id: `ar-${invoices.size + 1}`, sourceType: 'BusinessShipmentCI', sourceId: versions.get(original.id)![0].id,
          type: 'Receivable', status: 'Issued', amount: original.totalAmount, currency: original.currency, customerRelationId: original.customerRelationId };
        invoices.set(item.id, item); return { status: 201, body: { item, replayed: false } };
      }
      const invoice = url.match(/^\/api\/v2\/finance\/invoices\/([^/]+)$/);
      if (invoice && method === 'get') return { status: 200, body: { ok: true, invoice: structuredClone(invoices.get(invoice[1])) } };
      const cash = url.match(/^\/api\/v1\/finance\/cash-accounts\/([^/]+)$/);
      if (cash && method === 'get') return cashAccounts.has(cash[1]) ? { status: 200, body: structuredClone(cashAccounts.get(cash[1])) }
        : { status: 404, body: { error: 'ACTUAL_ACCOUNT_NOT_VISIBLE' } };
      if (url === '/api/v2/finance/payments' && method === 'post') {
        const prior = [...payments.values()].find(row => row.requestKey === body.requestKey);
        if (prior) return { status: 200, body: { ok: true, payment: prior } };
        const account = cashAccounts.get(body.companyAccountId);
        if (account.account.currency !== body.currency) return { status: 409, body: { ok: false, error: 'NO_IMPLICIT_FX' } };
        const payment = { ...body, id: `payment-${payments.size + 1}`, cashEntryId: `cash-entry-${payments.size + 1}`, status: 'Received' };
        payments.set(payment.id, payment); account.account.revision++;
        account.entries.push({ id: payment.cashEntryId, sourceVoucherId: payment.id, amount: payment.actualAccountAmount, kind: 'Receipt' });
        return { status: 200, body: { ok: true, payment } };
      }
      if (url.startsWith('/api/v1/finance/allocations?') && method === 'get') {
        const invoiceId = new URL(url, 'http://pure.invalid').searchParams.get('invoiceId');
        const items = [...allocations.values()].filter(row => row.invoiceId === invoiceId); return { status: 200, body: { items, total: items.length } };
      }
      if (url === '/api/v1/finance/allocations' && method === 'post') {
        const allocation = { ...body, id: `allocation-${allocations.size + 1}` }; allocations.set(allocation.id, allocation);
        const invoice = invoices.get(body.invoiceId), sum = [...allocations.values()].filter(row => row.invoiceId === invoice.id).reduce((amount, row) => amount + Number(row.appliedAmount), 0);
        invoice.status = sum === Number(invoice.amount) ? 'Paid' : 'PartiallyPaid';
        return { status: 201, body: { allocation } };
      }
      return { status: 503, body: { ok: false, error: 'UNEXPECTED_TEST_ENDPOINT', url } };
    },
  };
  return { deps, calls, orders, lines, approvals, batches, samples, releaseScopes, assignments, reports, stockReceipts, handoffs, documents, sentDocuments,
    invoices, payments, allocations, materialAllocations, cashAccounts, records, loseCreateAck: () => { lostCreateAck = true; } };
}

const uploadTransport: NonNullable<OrderDriverOptions['archiveExternalFiling']> = async ctx => {
  const response = await ctx.deps.invoke(ctx.scenario.logistics, 'post', `/api/v1/customs/trade-documents/${ctx.documentId}/external-archive`,
    { pureBoundaryOnly: true });
  if (response.status !== 201) throw Error('Pure protected upload failed');
  return { documentId: ctx.documentId, reference: `${ctx.scenario.key}-actual-external-filing` };
};

/** The independent internalSupplyDriver tests exercise its command pipeline.
 * Here only its callback contract is faked to prove the parent driver does
 * not earn PP from a callback's success flag or an obsolete allocation. */
function internalContinuation(fake: ReturnType<typeof httpBoundary>, input: OrderScenario) {
  let calls = 0;
  const result = { key: input.key, stopReached: true, earnedSteps: ['internalSupply.allocation.both-sides-readback'], ids: {
    internalSupplyOrderId: 'approved-internal-order', internalSupplyLineId: 'approved-internal-line', internalSupplyApprovalId: 'actual-fabric-approval',
    internalSupplyAllocationId: 'actual-material-allocation', internalSupplyAllocationRevision: '1', internalSupplyAllocationAuditId: 'actual-material-audit',
    internalSupplyMetres: '720', internalSupplyTargetOrderId: 'order-1', internalSupplyTargetLineId: 'order-1__0010',
    internalSupplyDemandTeamId: master.businessTeams.find(team => team.key === input.teamKey)!.id,
  } };
  const runOptions: OrderDriverOptions = { ...options,
    prepareCommercialTerms: async ctx => {
      const response = await ctx.deps.invoke(ctx.scenario.owner, 'put', `/api/v1/order-lines/${ctx.lineId}`, { fulfillmentMode: 'full_package', cmtIncludedItems: [] });
      expect(response.status).toBe(200); expect(fake.approvals.size).toBe(calls ? 1 : 0);
    },
    prepareMaterialSupply: async ctx => {
      expect(fake.orders.get(ctx.orderId).status).toBe('Confirmed');
      expect([...fake.approvals.values()][0].status).toBe('approved');
      if (!calls++) expect(fake.batches.size).toBe(0);
      if (!fake.materialAllocations.has(ctx.lineId)) fake.materialAllocations.set(ctx.lineId, {
        id: result.ids.internalSupplyAllocationId, status: 'active', revision: 1, metres: '720', auditId: result.ids.internalSupplyAllocationAuditId,
        fabricOrderId: result.ids.internalSupplyOrderId, fabricOrderLineId: result.ids.internalSupplyLineId,
        garmentOrderId: ctx.orderId, garmentOrderLineId: ctx.lineId, approvalId: result.ids.internalSupplyApprovalId,
        internalDemandTeamId: result.ids.internalSupplyDemandTeamId, internalReceiverId: master.cast[input.owner].id,
      });
      return structuredClone(result);
    },
  };
  return { result, runOptions, get calls() { return calls; } };
}

describe('order scenario HTTP command pipeline (pure boundary, no database)', () => {
  it('earns a real V2 draft plus exact manual line and only then reports the draft stop', async () => {
    const fake = httpBoundary(), input = scenario('draft');
    const [result] = await runOrderScenarios(master, [input], fake.deps, options);
    expect(result).toMatchObject({ key: input.key, stopReached: true });
    expect(result.earnedSteps).toEqual(expect.arrayContaining(['draft.create', 'line.create', 'draft.readback']));
    expect(fake.orders.size).toBe(1); expect(fake.lines.size).toBe(1); expect(fake.approvals.size).toBe(0);
    const line = [...fake.lines.values()][0];
    expect(line.manualSpecification).toMatchObject({ factoryRelationId: input.supplierId });
    expect(line).not.toHaveProperty('confirmedSourceType', 'Asset');
    expect(fake.calls.filter(call => call.method !== 'get').every(call => call.actor === input.owner)).toBe(true);
  });

  it.each(['fabric', 'garment'] as const)('uses actual %s responsibility and frozen review for pending, rejected and withdrawn rounds', async family => {
    const fake = httpBoundary(), inputs = ['approval_pending', 'approval_rejected', 'approval_withdrawn'].map(stop => scenario(stop as OrderScenario['stopAfter'], family));
    const results = await runOrderScenarios(master, inputs, fake.deps, options);
    expect(results.map(row => row.stopReached)).toEqual([true, true, true]);
    expect([...fake.approvals.values()].map(row => row.status)).toEqual(['pending', 'rejected', 'cancelled']);
    expect([...fake.orders.values()].every(row => row.status === 'Pending')).toBe(true);
    const decision = fake.calls.find(call => call.url.endsWith('/decide'))!;
    expect(decision.actor).toBe(inputs[1].reviewer); expect(decision.body).toMatchObject({ status: 'rejected', reviewContentVersion: 'a'.repeat(64) });
    expect(decision.body.rejectionReason).toBeTruthy(); expect(decision.body.requestedChanges).toBeTruthy();
    const withdrawal = fake.calls.find(call => call.url.endsWith('/withdraw'))!;
    expect(withdrawal.actor).toBe(inputs[2].owner); expect(withdrawal.body.requestKey).toMatch(/^[a-f0-9-]{36}$/);
    if (family === 'garment') for (const line of fake.lines.values()) expect(line).toMatchObject({ fulfillmentMode: 'cmt', cmtIncludedItems: [] });
  });

  it('reuses acknowledged creates, reads current state, and rejects changed scenario content on resume', async () => {
    const fake = httpBoundary(), input = scenario('approval_rejected');
    expect((await runOrderScenarios(master, [input], fake.deps, options))[0].stopReached).toBe(true);
    const writes = fake.calls.filter(call => call.method !== 'get').length, reads = fake.calls.filter(call => call.method === 'get').length;
    expect((await runOrderScenarios(master, [input], fake.deps, options))[0].stopReached).toBe(true);
    expect(fake.calls.filter(call => call.method !== 'get')).toHaveLength(writes);
    expect(fake.calls.filter(call => call.method === 'get').length).toBeGreaterThan(reads);
    const [changed] = await runOrderScenarios(master, [{ ...input, quantity: '9999' }], fake.deps, options);
    expect(changed.stopReached).toBe(false); expect(changed.blockedAt).toContain('SCENARIO_COMMAND_CHANGED');
    expect(fake.orders.size).toBe(1);
  });

  it('awaits financial instrument preparation before approval, repeats its fresh hook on resume, and leaves draft targets untouched', async () => {
    const fake = httpBoundary(), input = scenario('approval_pending'), draftOnly = scenario('draft'), invoke = fake.deps.invoke;
    const sequence: string[] = [], prepared: Array<{ orderId: string; lineId: string }> = [];
    fake.deps.invoke = async (actor, method, url, body) => {
      if (method === 'post' && url.endsWith('/submit-main-approval')) sequence.push('approval');
      return invoke(actor, method, url, body);
    };
    const prepareFinancialInstrument: NonNullable<OrderDriverOptions['prepareFinancialInstrument']> = async ctx => {
      await Promise.resolve();
      expect(ctx.master).toBe(master); expect(ctx.scenario).toBe(input); expect(ctx.deps).toBe(fake.deps);
      expect(fake.orders.get(ctx.orderId)?.status).toBe('Pending');
      expect(fake.lines.get(ctx.lineId)?.orderId).toBe(ctx.orderId);
      prepared.push({ orderId: ctx.orderId, lineId: ctx.lineId }); sequence.push('prepare');
    };
    const runOptions = { ...options, prepareFinancialInstrument };
    expect((await runOrderScenarios(master, [draftOnly, input], fake.deps, runOptions)).every(row => row.stopReached)).toBe(true);
    expect(sequence).toEqual(['prepare', 'approval']); expect(prepared).toHaveLength(1);
    expect((await runOrderScenarios(master, [input], fake.deps, runOptions))[0].stopReached).toBe(true);
    expect(sequence).toEqual(['prepare', 'approval', 'prepare']); expect(prepared[1]).toEqual(prepared[0]);
    expect(fake.orders.size).toBe(2); expect(fake.approvals.size).toBe(1);
  });

  it('blocks approval when the real financial instrument preparation fails', async () => {
    const fake = httpBoundary(), input = scenario('approval_pending');
    const [result] = await runOrderScenarios(master, [input], fake.deps, { ...options,
      prepareFinancialInstrument: async () => { throw Error('actual LC original evidence is unavailable'); } });
    expect(result.stopReached).toBe(false);
    expect(result.blockedAt).toContain('financial-instrument.prepare: actual LC original evidence is unavailable');
    expect(fake.approvals.size).toBe(0); expect(fake.batches.size).toBe(0);
    expect(fake.calls.some(call => call.url.endsWith('/submit-main-approval'))).toBe(false);
  });

  it('requires the internal supply continuation after main approval and freezes the same material proof before earning garment PP', async () => {
    const fake = httpBoundary(), input = scenario('production_preparation', 'garment'), hook = internalContinuation(fake, input);
    const [result] = await runOrderScenarios(master, [input], fake.deps, hook.runOptions);
    expect(result, result.blockedAt).toMatchObject({ stopReached: true, ids: hook.result.ids });
    expect(result.earnedSteps).toEqual(expect.arrayContaining(['internalSupply.allocation.both-sides-readback', 'internalSupply.pp-material-proof-readback', 'sample.garment_pp.readback']));
    expect([...fake.samples.values()][0].source.coverage[0].materialProof.allocation).toMatchObject({
      id: hook.result.ids.internalSupplyAllocationId, approvalId: hook.result.ids.internalSupplyApprovalId, metres: '720',
    });
    expect(fake.releaseScopes.size).toBe(1);
    const count = fake.calls.filter(call => call.method === 'post').length;
    expect((await runOrderScenarios(master, [input], fake.deps, hook.runOptions))[0].stopReached).toBe(true);
    expect(fake.calls.filter(call => call.method === 'post')).toHaveLength(count); expect(hook.calls).toBe(2);
    fake.materialAllocations.get('order-1__0010').status = 'cancelled';
    const [cancelled] = await runOrderScenarios(master, [input], fake.deps, hook.runOptions);
    expect(cancelled.stopReached).toBe(false); expect(cancelled.blockedAt).toContain('CURRENT_ALLOCATION_MISMATCH');
    expect(cancelled.earnedSteps).not.toContain('internalSupply.allocation.both-sides-readback');
    expect(fake.calls.filter(call => call.method === 'post')).toHaveLength(count);
  });

  it('does not create a production branch when the exact internal source is blocked or belongs to another garment line', async () => {
    for (const foreign of [false, true]) {
      const fake = httpBoundary(), input = scenario('production_preparation', 'garment'), hook = internalContinuation(fake, input);
      if (foreign) hook.result.ids.internalSupplyTargetLineId = 'another-garment-line';
      else hook.result.stopReached = false;
      const [result] = await runOrderScenarios(master, [input], fake.deps, hook.runOptions);
      expect(result.stopReached).toBe(false);
      expect(result.blockedAt).toContain(foreign ? 'INTERNAL_SUPPLY_ACK_INCOMPLETE' : 'INTERNAL_SUPPLY_STOP_NOT_EARNED');
      expect(fake.batches.size).toBe(0); expect(fake.samples.size).toBe(0); expect(fake.releaseScopes.size).toBe(0);
    }
  });

  it.each(['revision', 'approval', 'batch'] as const)('refuses a %s mismatch in the frozen PP material source even when the callback claims success', async fault => {
    const fake = httpBoundary(), input = scenario('production_preparation', 'garment'), hook = internalContinuation(fake, input), invoke = fake.deps.invoke;
    fake.deps.invoke = async (actor, method, url, body) => {
      const response = await invoke(actor, method, url, body);
      if (method !== 'get' || !url.includes('/samples/order-native/source/')) return response;
      const actual = structuredClone(response.body.data), coverage = actual.source.coverage[0];
      if (fault === 'revision') coverage.materialProof.allocation.revision = 2;
      if (fault === 'approval') coverage.materialProof.allocation.approvalId = 'another-fabric-approval';
      if (fault === 'batch') coverage.productionBatchRevision = 2;
      return { status: 200, body: { ok: true, data: actual } };
    };
    const [result] = await runOrderScenarios(master, [input], fake.deps, hook.runOptions);
    expect(result.stopReached).toBe(false); expect(result.blockedAt).toContain('SCENARIO_PP_INTERNAL_SUPPLY_PROOF_MISMATCH');
    expect(result.earnedSteps).not.toContain('internalSupply.pp-material-proof-readback'); expect(fake.releaseScopes.size).toBe(0);
  });

  it('allows the material continuation to explicitly leave an ordinary CMT scenario unchanged', async () => {
    const fake = httpBoundary(), input = scenario('production_preparation', 'garment');
    let called = false;
    const [result] = await runOrderScenarios(master, [input], fake.deps, { ...options, prepareMaterialSupply: async () => { called = true; return null; } });
    expect(called).toBe(true); expect(result, result.blockedAt).toMatchObject({ stopReached: true });
    expect(result.earnedSteps.some(step => step.startsWith('internalSupply.'))).toBe(false);
    expect([...fake.lines.values()][0].fulfillmentMode).toBe('cmt');
  });

  it('checks the current actual actor for fresh reads and cached ACKs and refuses an actor map from another master', async () => {
    const fake = httpBoundary(), input = scenario('draft'), invoke = fake.deps.invoke;
    let verified: string | null = null;
    fake.deps.verifyActor = async actor => { verified = actor; };
    fake.deps.invoke = async (actor, method, url, body) => {
      if (verified !== actor) throw Error('HTTP was called without fresh actual actor verification'); verified = null;
      return invoke(actor, method, url, body);
    };
    expect((await runOrderScenarios(master, [input], fake.deps, options))[0].stopReached).toBe(true);
    fake.deps.verifyActor = async () => { throw Error('Current account disabled'); };
    const writes = fake.calls.length;
    expect((await runOrderScenarios(master, [input], fake.deps, options))[0].blockedAt).toContain('Current account disabled');
    expect(fake.calls).toHaveLength(writes);
    const foreign = httpBoundary(); foreign.deps.actorIds[input.owner] = 'some-other-actual-user';
    expect((await runOrderScenarios(master, [input], foreign.deps, options))[0].blockedAt).toContain('SCENARIO_RUNTIME_ACTOR_MASTER_MISMATCH');
    expect(foreign.calls).toHaveLength(0);
  });

  it('binds an externally earned exact archive through the real version command instead of claiming a catalog entry passed QC', async () => {
    const fake = httpBoundary(), input = scenario('draft');
    const source = { caseId: 'native-earned-case', assetId: 'native-earned-asset', factoryId: input.supplierId, customerId: input.customerId, family: input.family };
    const [result] = await runOrderScenarios(master, [input], fake.deps, { ...options, resolveConfirmedSource: async () => source });
    expect(result.stopReached).toBe(true);
    expect(fake.calls.find(call => call.url === '/api/v1/order-lines')!.body).not.toHaveProperty('manualSpecification');
    expect(fake.calls.find(call => call.url.endsWith('/version'))).toMatchObject({ actor: input.owner, method: 'patch', body: { confirmedSourceType: 'Asset', confirmedSourceId: source.assetId } });
    expect([...fake.lines.values()][0]).toMatchObject({ confirmedSourceType: 'Asset', confirmedSourceId: source.assetId });
  });

  it('leaves an unknown non-idempotent create for explicit readback instead of creating another order', async () => {
    const fake = httpBoundary(), input = scenario('draft'); fake.loseCreateAck();
    const [unknown] = await runOrderScenarios(master, [input], fake.deps, options);
    expect(unknown.stopReached).toBe(false); expect(unknown.blockedAt).toContain('acknowledgement disconnected');
    const [retry] = await runOrderScenarios(master, [input], fake.deps, options);
    expect(retry.blockedAt).toContain('SCENARIO_ACK_UNKNOWN_RECONCILE_REQUIRED');
    expect(fake.calls.filter(call => call.url === '/api/v2/orders')).toHaveLength(1);
    expect(fake.orders.size).toBe(1); expect(fake.lines.size).toBe(0);
  });

  it('rejects a historical catalog or another customer/factory masquerading as a confirmed development archive', async () => {
    const input = scenario('draft'), fake = httpBoundary();
    const resolveConfirmedSource = async () => ({ caseId: 'earned-case', assetId: input.catalogAssetId, family: input.family,
      customerId: input.customerId, factoryId: input.supplierId });
    const [historical] = await runOrderScenarios(master, [input], fake.deps, { ...options, resolveConfirmedSource });
    expect(historical.blockedAt).toContain('SCENARIO_HISTORICAL_CATALOG_IS_NOT_CONFIRMED_SOURCE');
    const [foreign] = await runOrderScenarios(master, [input], fake.deps, { ...options, resolveConfirmedSource: async () => ({
      ...await resolveConfirmedSource(), assetId: 'earned-asset', customerId: 'foreign-customer' }) });
    expect(foreign.blockedAt).toContain('SCENARIO_CONFIRMED_SOURCE_MISMATCH'); expect(fake.calls).toHaveLength(0);
  });

  it.each(['fabric', 'garment'] as const)('earns exact %s returned-sample QC pending and NOK without claiming production or customer approval', async family => {
    const fake = httpBoundary(), pending = scenario('sample_qc_pending', family), rework = scenario('sample_rework', family);
    const results = await runOrderScenarios(master, [pending, rework], fake.deps, options);
    expect(results.map(row => row.stopReached)).toEqual([true, true]);
    expect([...fake.orders.values()].every(row => row.status === 'Confirmed')).toBe(true);
    expect(fake.batches.size).toBe(2);
    expect([...fake.samples.values()].map(sample => sample.events.map((event: any) => event.eventType))).toEqual([
      ['registered', 'qc_requested'], ['registered', 'qc_requested', 'qc_reviewed'],
    ]);
    const qc = fake.calls.find(call => call.body?.eventType === 'qc_reviewed')!;
    expect(qc.actor).toBe(rework.qc); expect(qc.body.payload.result).toBe('fail');
    expect(fake.calls.some(call => call.body?.eventType === 'customer_feedback')).toBe(false);
  });

  it.each(['command-input-shaped', 'stale-current-report', 'other-qc-actor'] as const)('rejects %s sample readback instead of earning PP from an input-shaped result', async fault => {
    const fake = httpBoundary(), input = scenario('production_preparation', 'garment'), invoke = fake.deps.invoke;
    fake.deps.invoke = async (actor, method, url, body) => {
      const response = await invoke(actor, method, url, body);
      if (method !== 'get' || !url.includes('/samples/order-native/source/')) return response;
      const actual = structuredClone(response.body.data), review = actual.events.find((row: any) => row.eventType === 'qc_reviewed');
      if (fault === 'command-input-shaped') review.payload = { result: 'pass' };
      if (fault === 'stale-current-report') actual.view.qc.id = 'another-actual-report';
      if (fault === 'other-qc-actor') review.actorId = master.cast.fabricQc.id;
      return { status: 200, body: { ok: true, data: actual } };
    };
    const [result] = await runOrderScenarios(master, [input], fake.deps, options);
    expect(result.stopReached).toBe(false); expect(result.blockedAt).toContain('SCENARIO_SAMPLE_QC_STOP_NOT_EARNED');
    expect(result.earnedSteps).not.toContain('sample.garment_pp.readback');
    expect(fake.calls.some(call => call.url.includes('/release-scopes'))).toBe(false);
  });

  it('records actual garment PP, separate leadership release and open production QC issues through the responsible accounts', async () => {
    const fake = httpBoundary(), input = scenario('production_qc_rework', 'garment');
    const [result] = await runOrderScenarios(master, [input], fake.deps, options);
    expect(result, result.blockedAt).toMatchObject({ stopReached: true });
    expect([...fake.releaseScopes.values()][0].state).toBe('ready');
    expect(fake.calls.find(call => call.url.endsWith('/signatures'))).toMatchObject({ actor: input.reviewer, body: { role: 'business', confirmedReviewedContent: true } });
    const report = [...fake.reports.values()][0]; expect(report.result).toBe('fail');
    expect(report.productionSizeChecks.actualSizes.slice().sort()).toEqual(['M', 'S']);
    expect(fake.calls.find(call => /\/qc\/assignments\/[^/]+\/complete$/.test(call.url))?.actor).toBe(input.qc);
    expect(fake.calls.some(call => call.url.endsWith('/business-resume'))).toBe(false);
    expect(fake.batches.values().next().value?.completion).toBeUndefined();
  });

  it.each(['fabric', 'garment'] as const)('earns %s preparation/current branch progress and retains an actual shortfall as unresolved quantity, not shipment completion', async family => {
    const fake = httpBoundary(), inputs = ['production_preparation', 'production_running', 'quantity_shortfall'].map(stop => scenario(stop as OrderScenario['stopAfter'], family));
    const results = await runOrderScenarios(master, inputs, fake.deps, options);
    expect(results.map(row => ({ reached: row.stopReached, blocked: row.blockedAt }))).toEqual([{ reached: true }, { reached: true }, { reached: true }]);
    expect(fake.batches.size).toBe(3);
    const completions = [...fake.batches.values()].filter(row => row.completion);
    expect(completions).toHaveLength(1); expect(completions[0].productionCompletion.status).toBe('out_of_tolerance');
    expect(Number(completions[0].completion.actualQuantity)).toBeLessThan(Number(inputs[2].quantity));
    expect(fake.calls.filter(call => call.url.endsWith('/complete-production'))).toHaveLength(1);
    expect(fake.calls.some(call => call.url.includes('/shipping/'))).toBe(false);
  });

  it('earns actual stock independently of handoff and a separate factory-direct loading without fake Warehouse/Inbound facts', async () => {
    const fake = httpBoundary(), received = scenario('warehouse_handoff'), loaded = scenario('factory_loading', 'garment');
    const results = await runOrderScenarios(master, [received, loaded], fake.deps, options);
    expect(results.map(row => ({ reached: row.stopReached, blocked: row.blockedAt }))).toEqual([{ reached: true }, { reached: true }]);
    expect(fake.stockReceipts.size).toBe(1); expect(fake.handoffs.size).toBe(1);
    const stock = [...fake.stockReceipts.values()][0]; expect(stock).toMatchObject({ quantity: received.quantity, ownership: 'Owned', unitCost: null });
    const loading = fake.calls.find(call => call.url.endsWith('/actual-loading') && call.method === 'post')!;
    expect(loading.actor).toBe(loaded.logistics);
    expect(loading.body.allocations[0].productionBatchAllocations[0]).toMatchObject({ factoryLoading: { actualQty: loaded.quantity }, receiptActuals: [] });
    expect([...fake.handoffs.values()][0].handoff.status).toBe('Processing');
    expect(fake.calls.some(call => call.method === 'put' && call.url.endsWith('/packing'))).toBe(false);
  });

  it('replays the original actual-loading command after commit with a lost ACK, retaining its original CAS and actor', async () => {
    const fake = httpBoundary(), input = scenario('factory_loading'), invoke = fake.deps.invoke;
    let lose = true;
    fake.deps.invoke = async (actor, method, url, body) => {
      const response = await invoke(actor, method, url, body);
      if (lose && method === 'post' && url.endsWith('/actual-loading')) { lose = false; throw Error('actual loading ACK disconnected after commit'); }
      return response;
    };
    expect((await runOrderScenarios(master, [input], fake.deps, options))[0]).toMatchObject({ stopReached: false, blockedAt: expect.stringContaining('ACK disconnected') });
    const original = structuredClone(fake.records.get(`${input.key}:shipment.actual-loading`)!);
    expect(original.state).toBe('intent'); expect((original.body as any).expectedUpdatedAt).toBe('2');
    expect([...fake.handoffs.values()][0].handoff.expectedUpdatedAt).toBe('3');
    expect((await runOrderScenarios(master, [input], fake.deps, options))[0].stopReached).toBe(true);
    const replay = fake.records.get(original.key)!;
    expect(replay).toMatchObject({ hash: original.hash, actorId: master.cast[input.logistics].id, state: 'acknowledged', body: original.body });
    expect(fake.handoffs.size).toBe(1);
    const actuals = fake.calls.filter(call => call.method === 'post' && call.url.endsWith('/actual-loading'));
    expect(actuals).toHaveLength(2); expect(actuals[1].body).toEqual(actuals[0].body);
  });

  it('earns real packing and booking, then stops without inventing an external filing document when no upload transport exists', async () => {
    const fake = httpBoundary(), input = scenario('document_return');
    const [result] = await runOrderScenarios(master, [input], fake.deps, options);
    expect(result.stopReached).toBe(false); expect(result.blockedAt).toContain('SCENARIO_EXTERNAL_FILING_UPLOAD_REQUIRED');
    expect(result.earnedSteps).toEqual(expect.arrayContaining(['shipment.packing-readback', 'shipment.book']));
    expect([...fake.handoffs.values()][0].shipment).toMatchObject({ status: 'Booked', atd: null });
    expect(fake.calls.some(call => call.url === '/api/v1/customs/trade-documents')).toBe(false);
  });

  it.each(['fabric', 'garment'] as const)('returns issued original %s CI/PL to business, without claiming customer send or actual departure', async family => {
    const fake = httpBoundary(), input = scenario('document_return', family);
    const [result] = await runOrderScenarios(master, [input], fake.deps, { ...options, archiveExternalFiling: uploadTransport });
    expect({ reached: result.stopReached, blocked: result.blockedAt }).toEqual({ reached: true });
    expect(result.earnedSteps).toContain('documents.original-ci-pl-download-readback');
    expect([...fake.handoffs.values()][0]).toMatchObject({ handoff: { status: 'ReturnedToBusiness' }, shipment: { status: 'Booked', atd: null } });
    expect(fake.sentDocuments.size).toBe(0);
    expect([...fake.documents.values()].filter(row => row.type !== 'ExportDeclarationProof').every(row => row.status === 'Issued' && row.filePath)).toBe(true);
    expect(fake.calls.some(call => call.url.endsWith('/confirm-departure') || call.url.includes('/finance/'))).toBe(false);
    const originals = fake.calls.filter(call => call.method === 'get' && call.url.includes('/download?'));
    expect(originals).toHaveLength(2); expect(originals.every(call => call.actor === input.owner)).toBe(true);
  });

  it('records partial ATD only after the original business account sends both exact versions; grouped plans remain explicitly blocked', async () => {
    const fake = httpBoundary(), input = scenario('partially_shipped');
    const [result] = await runOrderScenarios(master, [input], fake.deps, { ...options, archiveExternalFiling: uploadTransport });
    expect({ reached: result.stopReached, blocked: result.blockedAt }).toEqual({ reached: true });
    expect(fake.sentDocuments.size).toBe(2); expect([...fake.sentDocuments.values()].every(row => row.versionId && row.version === 1)).toBe(true);
    const bundle = [...fake.handoffs.values()][0];
    expect(bundle.shipment).toMatchObject({ status: 'Shipped', atd: options.businessDate });
    expect(Number(bundle.allocations[0].actualQty)).toBe(Number(input.quantity) / 2);
    expect(fake.orders.get(result.ids.orderId as string).status).toBe('Confirmed');
    const send = fake.calls.findIndex(call => call.url.endsWith('/shipment-documents/sent'));
    const atd = fake.calls.findIndex(call => call.url.endsWith('/confirm-departure'));
    expect(atd).toBeGreaterThan(send); expect(fake.calls[atd].actor).toBe(input.logistics);
    const groupedFake = httpBoundary(), grouped = buildBusinessScenarios(master).orders.find(row => row.family === 'fabric' && row.stopAfter === 'partially_shipped')!;
    const [blocked] = await runOrderScenarios(master, [grouped], groupedFake.deps, { ...options, archiveExternalFiling: uploadTransport });
    expect(blocked.stopReached).toBe(false); expect(blocked.blockedAt).toContain('SCENARIO_CONSOLIDATED_SHIPMENT_COORDINATOR_REQUIRED');
    expect(groupedFake.handoffs.size).toBe(0);
  });

  it.each(['fabric', 'garment'] as const)('earns a real %s two-order shipment with distinct contract CIs, one PL, and independent partial/full readback', async family => {
    const fake = httpBoundary(), pair = buildBusinessScenarios(master).orders.filter(row => row.family === family && row.shipmentGroupKey);
    const results = await runOrderScenarios(master, pair, fake.deps, { ...options, archiveExternalFiling: uploadTransport });
    expect(results.map(row => ({ reached: row.stopReached, blocked: row.blockedAt }))).toEqual([{ reached: true }, { reached: true }]);
    expect(fake.orders.size).toBe(2); expect(fake.handoffs.size).toBe(1);
    const bundle = [...fake.handoffs.values()][0];
    expect(results[0].ids.shipmentId).toBe(results[1].ids.shipmentId);
    expect(bundle.shipment).toMatchObject({ status: 'Shipped', atd: options.businessDate, totalPackages: 2 });
    expect(bundle.allocations.map((row: any) => row.orderId).sort()).toEqual(results.map(row => row.ids.orderId).sort());
    expect(bundle.allocations.map((row: any) => Number(row.actualQty))).toEqual([Number(pair[0].quantity) / 2, Number(pair[1].quantity)]);
    expect(bundle.lines).toHaveLength(2); expect(bundle.cartons).toHaveLength(2);
    for (const line of bundle.lines) {
      expect(line.productCode).toMatch(/^[FG]-\d{3}$/);
      expect(line.productName).not.toMatch(/待复验|出运|审批|QC/);
      expect(line.hsCode).toBeNull();
    }
    const cis = [...fake.documents.values()].filter(row => row.type === 'CommercialInvoice'), pls = [...fake.documents.values()].filter(row => row.type === 'PackingList');
    expect(cis).toHaveLength(2); expect(pls).toHaveLength(1); expect(fake.sentDocuments.size).toBe(3);
    expect(results[0].ids.ciDocumentId).not.toBe(results[1].ids.ciDocumentId);
    expect(results[0].ids.plDocumentId).toBe(results[1].ids.plDocumentId);
    expect(new Set([...fake.orders.values()].map(row => row.finalContractNumber)).size).toBe(2);
    expect(cis.every(row => row.orderIds.length === 1 && row.status === 'Issued' && row.filePath)).toBe(true);
    expect(fake.invoices.size).toBe(1);
    expect([...fake.invoices.values()][0]).toMatchObject({ sourceId: results[1].ids.ciVersionId, amount: String(Number(pair[1].quantity) * Number(pair[1].unitPrice)), status: 'Issued' });
    expect(results[0].earnedSteps).toContain('shipment.partial-order-allocation-readback');
    expect(results[1].earnedSteps).toContain('shipment.full-order-allocation-readback');
    const writes = fake.calls.filter(call => call.method !== 'get' && !call.url.endsWith('/external-archive')).length;
    const resumed = await runOrderScenarios(master, [...pair].reverse(), fake.deps, { ...options, archiveExternalFiling: uploadTransport });
    expect(resumed.every(row => row.stopReached)).toBe(true);
    expect(fake.handoffs.size).toBe(1); expect(fake.invoices.size).toBe(1);
    expect(fake.calls.filter(call => call.method !== 'get' && !call.url.endsWith('/external-archive'))).toHaveLength(writes);
  });

  it('replays one exact two-source handoff after commit with lost ACK without making two shipments', async () => {
    const fake = httpBoundary(), pair = buildBusinessScenarios(master).orders.filter(row => row.family === 'fabric' && row.shipmentGroupKey), invoke = fake.deps.invoke;
    let lose = true;
    fake.deps.invoke = async (actor, method, url, body) => {
      const response = await invoke(actor, method, url, body);
      if (lose && method === 'post' && url === '/api/v1/shipping/handoffs') { lose = false; throw Error('combined handoff ACK disconnected after commit'); }
      return response;
    };
    const runOptions = { ...options, archiveExternalFiling: uploadTransport };
    const failed = await runOrderScenarios(master, pair, fake.deps, runOptions);
    expect(failed.every(row => !row.stopReached && row.blockedAt?.includes('combined handoff ACK disconnected'))).toBe(true);
    expect(fake.handoffs.size).toBe(1); expect(fake.documents.size).toBe(0);
    const original = structuredClone(fake.records.get(`${pair[0].key}:shipment.handoff-create`)!);
    expect(original.state).toBe('intent'); expect((original.body as any).allocations).toHaveLength(2);
    expect((await runOrderScenarios(master, [...pair].reverse(), fake.deps, runOptions)).every(row => row.stopReached)).toBe(true);
    expect(fake.handoffs.size).toBe(1);
    expect(fake.records.get(original.key)).toMatchObject({ hash: original.hash, body: original.body, state: 'acknowledged' });
  });

  it('creates no combined shipment if the partner has not earned current sample QC or has a different business owner', async () => {
    const pair = buildBusinessScenarios(master).orders.filter(row => row.family === 'garment' && row.shipmentGroupKey), fake = httpBoundary(), invoke = fake.deps.invoke;
    fake.deps.invoke = async (actor, method, url, body) => {
      const response = await invoke(actor, method, url, body);
      if (method === 'get' && url.includes('/samples/order-native/source/') && response.body.data?.source.orderId === 'order-2') {
        const data = structuredClone(response.body.data); data.view.qc.id = 'unrelated-report';
        return { status: 200, body: { ok: true, data } };
      }
      return response;
    };
    const failed = await runOrderScenarios(master, pair, fake.deps, { ...options, archiveExternalFiling: uploadTransport });
    expect(failed.every(row => !row.stopReached)).toBe(true); expect(fake.handoffs.size).toBe(0);
    expect(failed[0].blockedAt).toContain('SCENARIO_CONSOLIDATION_PARTNER_NOT_READY');
    expect(failed[1].blockedAt).toContain('SCENARIO_SAMPLE_QC_STOP_NOT_EARNED');
    const foreign = httpBoundary(), team = master.businessTeams.find(row => row.key === pair[1].teamKey)!;
    const another = Object.values(master.cast).find(row => team.memberIds.includes(row.id) && row.key !== pair[1].owner)!.key;
    const mixed = await runOrderScenarios(master, [pair[0], { ...pair[1], owner: another }], foreign.deps, options);
    expect(mixed.every(row => !row.stopReached && row.blockedAt?.includes('SCENARIO_CONSOLIDATION_INCOMPATIBLE'))).toBe(true);
    expect(foreign.handoffs.size).toBe(0);
  });

  it('registers only the frozen issued CI as unpaid AR after actual shipment; missing real cash scope blocks payment', async () => {
    const fake = httpBoundary(), inputs = [scenario('shipped_unpaid'), scenario('partially_settled')];
    const results = await runOrderScenarios(master, inputs, fake.deps, { ...options, archiveExternalFiling: uploadTransport });
    expect({ reached: results[0].stopReached, blocked: results[0].blockedAt }).toEqual({ reached: true });
    expect(results[1].stopReached).toBe(false); expect(results[1].blockedAt).toContain('SCENARIO_ACTUAL_CASH_ACCOUNT_REQUIRED');
    expect(fake.invoices.size).toBe(2); expect(fake.payments.size).toBe(0); expect(fake.allocations.size).toBe(0);
    const registration = fake.calls.filter(call => call.url.endsWith('/register') && call.url.includes('/finance/'));
    expect(registration).toHaveLength(2); expect(registration.every(call => Object.keys(call.body).length === 0)).toBe(true);
    expect(fake.invoices.get(results[0].ids.receivableInvoiceId as string)).toMatchObject({ sourceType: 'BusinessShipmentCI', sourceId: results[0].ids.ciVersionId, status: 'Issued' });
  });

  it('blocks fabric commission before registering the full goods CI as our customer receivable', async () => {
    const fake = httpBoundary(), input = scenario('commission_pending', 'fabric');
    const [result] = await runOrderScenarios(master, [input], fake.deps, { ...options, archiveExternalFiling: uploadTransport });
    expect(result.stopReached).toBe(false); expect(result.blockedAt).toContain('SCENARIO_COMMISSION_SOURCE_PRODUCER_REQUIRED');
    expect(fake.calls.some(call => call.url.includes('/finance/business-ci/') && call.url.endsWith('/register'))).toBe(false);
    expect(result.ids.receivableInvoiceId).toBeUndefined();
    expect(result.earnedSteps).not.toContain('finance.ci-register-ar');
  });

  it('delegates fabric commission only after departure and accepts only its separate unpaid supplier AR evidence', async () => {
    const fake = httpBoundary(), input = scenario('commission_pending', 'fabric');
    const [result] = await runOrderScenarios(master, [input], fake.deps, { ...options, archiveExternalFiling: uploadTransport,
      continueFabricCommission: async current => {
        expect(current.orderId).toBeTruthy(); expect(current.lineId).toBeTruthy();
        expect([...fake.handoffs.values()].some(row => row.shipment.status === 'Shipped')).toBe(true);
        return { key: input.key, earnedSteps: ['commission.original-ci-issued-readback', 'commission.ar.unpaid-readback'],
          stopReached: true, ids: { commissionInvoiceId: 'native-commission-ar' } };
      },
    });
    expect({ reached: result.stopReached, blocked: result.blockedAt }).toEqual({ reached: true });
    expect(result.ids.commissionInvoiceId).toBe('native-commission-ar');
    expect(result.ids.receivableInvoiceId).toBeUndefined(); expect(fake.invoices.size).toBe(0);
    expect(fake.calls.some(call => call.url.includes('/finance/business-ci/') && call.url.endsWith('/register'))).toBe(false);
  });

  it.each(['partially_settled', 'settled'] as const)('earns explicit %s AR cash and allocation, keeps unknown opening, and never claims the missing supplier AP settled', async stop => {
    const fake = httpBoundary(), input = scenario(stop), id = `account-${input.currency}`;
    fake.cashAccounts.set(id, { account: { id, currency: input.currency, revision: 1 }, balance: null, balanceStatus: 'unknown', entries: [] });
    const runOptions = { ...options, archiveExternalFiling: uploadTransport, resolveCashAccount: async () => ({ id }) };
    const [result] = await runOrderScenarios(master, [input], fake.deps, runOptions);
    expect(result.stopReached).toBe(false); expect(result.blockedAt).toContain('SCENARIO_SUPPLIER_AP_SOURCE_PRODUCER_REQUIRED');
    expect(result.earnedSteps).toContain('finance.customer-ar-readback');
    expect(fake.payments.size).toBe(1); expect(fake.allocations.size).toBe(1);
    const payment = [...fake.payments.values()][0], allocation = [...fake.allocations.values()][0], invoice = [...fake.invoices.values()][0];
    expect(Number(payment.amount)).toBe(Number(invoice.amount) * (stop === 'partially_settled' ? 0.5 : 1));
    expect(allocation).toMatchObject({ invoiceId: invoice.id, voucherId: payment.id, appliedAmount: payment.amount });
    expect(fake.cashAccounts.get(id)).toMatchObject({ balance: null, balanceStatus: 'unknown', entries: [{ sourceVoucherId: payment.id }] });
    expect(fake.documents.get(result.ids.ciDocumentId as string).status).toBe('Issued');
    const writes = fake.calls.filter(call => call.method !== 'get' && call.url.includes('/finance/')).length;
    const [resumed] = await runOrderScenarios(master, [input], fake.deps, runOptions);
    expect(resumed.blockedAt).toContain('SCENARIO_SUPPLIER_AP_SOURCE_PRODUCER_REQUIRED');
    expect(fake.payments.size).toBe(1); expect(fake.allocations.size).toBe(1);
    expect(fake.calls.filter(call => call.method !== 'get' && call.url.includes('/finance/'))).toHaveLength(writes);
  });

  it.each(['partially_settled', 'settled', 'supplier_payment_pending'] as const)('continues %s only after real customer cash readback and preserves the supplier producer result', async stop => {
    const fake = httpBoundary(), input = scenario(stop, stop === 'supplier_payment_pending' ? 'garment' : 'fabric'), id = `account-${input.currency}`;
    fake.cashAccounts.set(id, { account: { id, currency: input.currency, revision: 1 }, balance: null, balanceStatus: 'unknown', entries: [] });
    let continued = 0;
    const runOptions: OrderDriverOptions = { ...options, archiveExternalFiling: uploadTransport, resolveCashAccount: async () => ({ id }),
      continueSupplierFinance: async ctx => {
        expect(fake.payments.size).toBe(1); expect(fake.allocations.size).toBe(1);
        expect(ctx).toMatchObject({ orderId: 'order-1', lineId: 'order-1__0010', customerInvoiceId: expect.any(String) });
        continued++;
        return { key: input.key, stopReached: true, ids: { supplierPaymentRequestId: 'PR-ACTUAL' }, earnedSteps: [stop === 'supplier_payment_pending'
          ? 'supplier-finance.payment-request.pending-readback' : `supplier-finance.ap.cash.${stop === 'settled' ? 'fully' : 'partially'}-settled-readback`] };
      } };
    const [result] = await runOrderScenarios(master, [input], fake.deps, runOptions);
    expect(result).toMatchObject({ stopReached: true, ids: { supplierPaymentRequestId: 'PR-ACTUAL' } });
    expect(result.earnedSteps).toContain('finance.customer-ar-readback'); expect(continued).toBe(1);
    expect(Number([...fake.payments.values()][0].amount)).toBe(Number([...fake.invoices.values()][0].amount) * (stop === 'partially_settled' ? 0.5 : 1));
  });

  it('uses the structured payment instrument rather than guessing it from a note', async () => {
    const fake = httpBoundary(), input = { ...scenario('draft'), paymentInstrument: 'T/T' as const, paymentTerms: 'Customer specifically declined L/C; agreed T/T' };
    expect((await runOrderScenarios(master, [input], fake.deps, options))[0].stopReached).toBe(true);
    expect([...fake.orders.values()][0].paymentInstrument).toBe('T/T');
  });

  it('prepares actual commercial terms after exact lines and before financial instruments and main approval', async () => {
    const fake = httpBoundary(), input = scenario('approval_pending'), seen: string[] = [];
    const [result] = await runOrderScenarios(master, [input], fake.deps, { ...options,
      prepareCommercialTerms: async ctx => {
        expect(ctx).toMatchObject({ orderId: 'order-1', lineId: 'order-1__0010', master, deps: fake.deps });
        expect(fake.lines.size).toBe(1); expect(fake.approvals.size).toBe(0); seen.push('commercial');
      },
      prepareFinancialInstrument: async () => { expect(fake.approvals.size).toBe(0); seen.push('financial'); },
    });
    expect(result.stopReached).toBe(true); expect(seen).toEqual(['commercial', 'financial']);
  });
});
