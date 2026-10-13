import { describe, expect, it } from 'vitest';
import { planScenarioMasterData } from './masterData';
import { buildBusinessScenarios } from './scenarios';
import type { ScenarioCommandRecord, ScenarioDriverDependencies } from './driverContract';
import { prepareFabricCommissionTerms, runFabricCommissionScenario } from './fabricCommissionDriver';

const master = planScenarioMasterData({ namespace: 'commission-protocol', nowMs: Date.parse('2026-10-08T00:18:00Z') });
const scenario = buildBusinessScenarios(master).orders.find(row => row.family === 'fabric' && row.stopAfter === 'commission_pending')!;
function protocol() {
  const records = new Map<string, ScenarioCommandRecord>(), calls: Array<{ actor: string; method: string; url: string; body: unknown }> = [];
  let terms: Record<string, unknown> = {}, settled = false, registered = false, lostSettle = false, deny = false, applied = '0', receipt = false;
  const source = { orderId: 'order', customerId: scenario.customerId, currency: scenario.currency, sourceFingerprint: 'a'.repeat(64),
    financialLines: [{ id: 'line', fabricSupplyMode: 'commission', fabricCommissionRate: '5', fabricCommissionSupplierId: scenario.supplierId }] };
  const document = { supplierId: scenario.supplierId, documentId: 'doc', versionId: 'version', amount: '25', currency: scenario.currency };
  const invoice = { id: 'invoice', type: 'Receivable', sourceType: 'FabricCommissionCI', sourceId: 'version', orderId: 'order',
    customerRelationId: scenario.supplierId, currency: scenario.currency, amount: '25', status: 'Issued' };
  const original = { version: { id: 'version' }, snapshot: { source }, group: { supplierId: scenario.supplierId, commissionAmount: '25', party: { name: 'Actual supplier' } } };
  const account = { id: 'cash', currency: scenario.currency, revision: 1 };
  const deps: ScenarioDriverDependencies = { runtimeId: 'pure-commission',
    actorIds: Object.fromEntries(Object.values(master.cast).map(actor => [actor.key, actor.id])) as ScenarioDriverDependencies['actorIds'],
    verifyActor: async () => { if (deny) throw Error('CURRENT_ACCOUNT_REVOKED'); },
    journal: { read: async key => records.get(key) ?? null, write: async record => { records.set(record.key, structuredClone(record)); } },
    invoke: async (actor, method, url, body) => {
      calls.push({ actor, method, url, body: structuredClone(body) });
      if (url === '/api/v1/order-lines/line' && method === 'put') { terms = body as Record<string, unknown>; return { status: 200, body: { ok: true, line: { id: 'line', orderId: 'order', ...terms } } }; }
      if (url === '/api/v1/order-lines?orderId=order') return { status: 200, body: { ok: true, lines: [{ id: 'line', orderId: 'order', ...terms }] } };
      if (url === '/api/v1/orders/order/fabric-commission' && method === 'get') return { status: 200, body: settled
        ? { ok: true, settled: true, receipt: { orderId: 'order', settlementId: 'event', sourceFingerprint: source.sourceFingerprint, documents: [document] }, documents: [original] }
        : { ok: true, source } };
      if (url.endsWith('/fabric-commission/settle')) {
        const row = body as Record<string, unknown>;
        if (row.expectedSourceFingerprint !== source.sourceFingerprint) return { status: 409, body: { ok: false } };
        settled = true;
        if (lostSettle) { lostSettle = false; throw Error('COMMITTED_ACK_DISCONNECTED'); }
        return { status: 201, body: { ok: true, receipt: { orderId: 'order', settlementId: 'event', sourceFingerprint: source.sourceFingerprint, documents: [document] } } };
      }
      if (url === '/api/v1/finance/fabric-commission-cis/doc') {
        if (!settled) throw Error('Original required'); return { status: 200, body: { ok: true, ...original } };
      }
      if (url.endsWith('/fabric-commission-cis/doc/register')) {
        if (!settled) throw Error('Issued original required'); registered = true; return { status: 201, body: { ok: true, invoice } };
      }
      if (url === '/api/v2/finance/invoices/invoice') {
        if (!registered) throw Error('Native AR required'); return { status: 200, body: { ok: true, invoice } };
      }
      if (url === '/api/v1/finance/allocations?invoiceId=invoice') return { status: 200, body: { items: applied === '0' ? [] : [{ appliedAmount: applied }], total: applied === '0' ? 0 : 1 } };
      if (url === '/api/v1/finance/cash-accounts/cash') return { status: 200, body: { account, entries: receipt ? [{ id: 'entry', sourceVoucherId: 'voucher', amount: applied === '0' ? '10' : applied }] : [] } };
      if (url === '/api/v2/finance/payments') {
        const row = body as Record<string, unknown>;
        if (row.customerRelationId !== scenario.supplierId || row.type !== 'Receipt') throw Error('Actual supplier receipt required');
        receipt = true; return { status: 201, body: { payment: { id: 'voucher', cashEntryId: 'entry', ...row } } };
      }
      if (url === '/api/v1/finance/allocations') {
        if (!receipt || !registered) throw Error('Native cash/AR required'); applied = String((body as Record<string, unknown>).appliedAmount);
        invoice.status = applied === '25' ? 'Paid' : 'PartiallyPaid'; return { status: 201, body: { allocation: { id: 'allocation', ...body as object } } };
      }
      throw Error(`UNMODELLED_REAL_ENDPOINT ${method} ${url}`);
    } };
  return { context: { master, scenario, orderId: 'order', lineId: 'line', deps }, calls, records, source, invoice,
    loseAck: () => { lostSettle = true; }, revoke: () => { deny = true; } };
}
const options = { rate: '5', businessDate: '2026-10-08' };
describe('fabric commission HTTP scenario bridge', () => {
  it('prepares exact terms through the real PUT contract and list readback', async () => {
    const f = protocol(); await prepareFabricCommissionTerms(f.context, options);
    expect(f.calls[0]).toMatchObject({ actor: scenario.owner, method: 'put', url: '/api/v1/order-lines/line', body: { fabricSupplyMode: 'commission', fabricCommissionSupplierId: scenario.supplierId, fabricCommissionRate: '5' } });
    expect(f.calls[1].url).toBe('/api/v1/order-lines?orderId=order');
  });
  it('earns unpaid supplier commission AR without touching ordinary goods AR or customer cash', async () => {
    const f = protocol(), result = await runFabricCommissionScenario(f.context, options);
    expect(result.stopReached, result.blockedAt).toBe(true); expect(result.ids.commissionInvoiceId).toBe('invoice');
    expect(result.earnedSteps).toContain('commission.ar.unpaid-readback');
    expect(f.calls.some(call => call.url.includes('business-ci/') || call.url.includes('/payments'))).toBe(false);
  });
  it('records only explicit actual supplier bank cash and partial allocation', async () => {
    const f = protocol(), result = await runFabricCommissionScenario(f.context, { ...options, paymentPlan: { amount: '10', cashAccountId: 'cash', bankReference: 'ACTUAL-BANK' } });
    expect(result.stopReached, result.blockedAt).toBe(true); expect(f.invoice.status).toBe('PartiallyPaid');
    expect(f.calls.find(call => call.url.endsWith('/payments'))).toMatchObject({ body: { customerRelationId: scenario.supplierId, amount: '10', type: 'Receipt' } });
  });
  it('keeps an unknown settle ACK with its original key/content across resume', async () => {
    const f = protocol(); f.loseAck();
    const first = await runFabricCommissionScenario(f.context, options); expect(first.stopReached).toBe(false); expect(first.blockedAt).toContain('ACK_DISCONNECTED');
    const second = await runFabricCommissionScenario(f.context, options); expect(second.stopReached, second.blockedAt).toBe(true);
    const writes = f.calls.filter(call => call.url.endsWith('/settle')); expect(writes).toHaveLength(2); expect(writes[0].body).toEqual(writes[1].body);
  });
  it('does not trust cached ACK after actual identity revocation', async () => {
    const f = protocol(); expect((await runFabricCommissionScenario(f.context, options)).stopReached).toBe(true); f.revoke();
    const result = await runFabricCommissionScenario(f.context, options); expect(result.stopReached).toBe(false); expect(result.blockedAt).toContain('CURRENT_ACCOUNT_REVOKED');
  });
  it('blocks an incorrect exact payer/rate and never invents garment commission', async () => {
    const f = protocol(); f.source.financialLines[0].fabricCommissionRate = '6';
    expect((await runFabricCommissionScenario(f.context, options)).stopReached).toBe(false);
    const garment = { ...f.context, scenario: { ...scenario, family: 'garment' as const } };
    expect((await runFabricCommissionScenario(garment, options)).blockedAt).toContain('SOURCE_OR_ACTOR_MISMATCH');
    expect(f.calls.some(call => call.url.endsWith('/settle'))).toBe(false);
  });
});
