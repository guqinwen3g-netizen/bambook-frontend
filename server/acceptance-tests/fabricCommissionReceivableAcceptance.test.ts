/** Dedicated fresh isolated batch. All approval/QC/production/ATD, CI, AR and
 * actual bank/allocation facts are earned through native HTTP producers. Only
 * canonical accounts/catalogs/policies are master fixture data. */
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertIsolatedAcceptanceDatabase } from './isolatedDatabase';
import { seedScenarioMasterData, type ScenarioActorKey, type ScenarioMasterData } from '../scripts/full-business-sim/masterData';
import { buildBusinessScenarios, type OrderScenario } from '../scripts/full-business-sim/scenarios';
import { createScenarioRehearsalApp } from '../scripts/full-business-sim/scenarioApp';
import { createPrivateScenarioJournal } from '../scripts/full-business-sim/privateJournal';
import { configureSimulationBusinessPolicy } from '../scripts/full-business-sim/scenarioConfiguration';
import { simulationEvidencePdf } from '../scripts/full-business-sim/simulationEvidencePdf';
import { scenarioCommand, type ScenarioDriverDependencies } from '../scripts/full-business-sim/driverContract';
import { runOrderScenarios, type OrderDriverOptions } from '../scripts/full-business-sim/orderDriver';
import { prepareFabricCommissionTerms, runFabricCommissionScenario } from '../scripts/full-business-sim/fabricCommissionDriver';
import { createScenarioCashResolver } from '../scripts/full-business-sim/fullSimulation';
import { createAuthService } from '../src/auth/service';
import { settleFabricCommission } from '../src/finance/fabricCommissionService';
import { todayLocalKey } from '../src/shared/localDate';

const prisma = new PrismaClient({ datasources: { db: { url: process.env.BAMBOOK_ACCEPTANCE_DATABASE_URL
  ?? 'postgresql://disabled:disabled@127.0.0.1:1/disabled' } } });
let master: ScenarioMasterData, app: ReturnType<typeof createScenarioRehearsalApp>, deps: ScenarioDriverDependencies;
const tokens = {} as Record<ScenarioActorKey, string>;
let loseSettlementAck = false;
const ok = (response: { status: number; body: unknown }, expected: number, label: string) => {
  expect(response.status, `${label}: ${JSON.stringify(response.body)}`).toBe(expected); return response.body as Record<string, unknown>;
};
beforeAll(async () => {
  await assertIsolatedAcceptanceDatabase(prisma);
  expect(await prisma.order.count()).toBe(0);
  master = await seedScenarioMasterData(prisma, { namespace: `commission-native-${randomUUID().slice(0, 8)}`, nowMs: Date.now(), mode: 'apply' });
  const client = new Proxy(prisma, { get(target, key) {
    if (key === '$transaction') return async (...args: unknown[]) => {
      const result = await Reflect.apply(target.$transaction, target, args);
      if (loseSettlementAck && result?.receipt?.settlementId && result.replayed === false) {
        loseSettlementAck = false; throw Error('PRIVATE COMMITTED COMMISSION ACK DISCONNECTED');
      }
      return result;
    };
    const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  app = createScenarioRehearsalApp(client, path.join(process.env.BAMBOOK_ACCEPTANCE_SANDBOX!, 'commission-private-files'));
  for (const actor of Object.values(master.cast)) {
    const response = await supertest(app).post('/api/auth/login').send({ identifier: actor.email, password: actor.password });
    expect(response.status, `login ${actor.key}`).toBe(200); expect(response.body.user.id).toBe(actor.id); tokens[actor.key] = response.body.token;
  }
  deps = { runtimeId: `commission-private:${master.namespace}`,
    actorIds: Object.fromEntries(Object.values(master.cast).map(actor => [actor.key, actor.id])) as ScenarioDriverDependencies['actorIds'],
    verifyActor: async actor => {
      const me = await supertest(app).get('/api/auth/me').set('Authorization', `Bearer ${tokens[actor]}`);
      if (me.status !== 200 || me.body.user?.id !== master.cast[actor].id) throw Error('ACTUAL_ACCOUNT_REVOKED');
    },
    journal: await createPrivateScenarioJournal(path.join(process.env.BAMBOOK_ACCEPTANCE_SANDBOX!, 'commission-native-journal')),
    invoke: async (actor, method, url, body) => {
      let call = supertest(app)[method](url).set('Authorization', `Bearer ${tokens[actor]}`);
      if (body !== undefined) {
        if (body && typeof body === 'object') call = call.send(body);
        else if (typeof body === 'string') call = call.send(body);
        else throw Error('NATIVE_HTTP_BODY_INVALID');
      }
      if (/\/download(?:\?|$)/.test(url)) call = call.buffer(true).parse((response, done) => {
        const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => done(null, Buffer.concat(chunks))); response.on('error', done);
      });
      const response = await call; return { status: response.status, body: response.body };
    } };
  await configureSimulationBusinessPolicy(master, deps);
}, 180_000);
afterAll(async () => { await prisma.$disconnect(); });
const archiveExternalFiling: NonNullable<OrderDriverOptions['archiveExternalFiling']> = async ({ scenario, shipmentId, documentId }) => {
  const reference = `SIM-COMMISSION-${scenario.key}`, bytes = simulationEvidencePdf(reference, shipmentId);
  const url = `/api/v1/customs/trade-documents/${encodeURIComponent(documentId)}/external-archive`;
  const upload: ScenarioDriverDependencies = { ...deps, invoke: async (actor, method, target) => {
    if (method !== 'post' || target !== url) throw Error('ACTUAL_UPLOAD_TARGET_CHANGED');
    await deps.verifyActor(actor);
    const response = await supertest(app).post(url).set('Authorization', `Bearer ${tokens[actor]}`)
      .attach('file', bytes, { filename: `${reference}.pdf`, contentType: 'application/pdf' });
    return { status: response.status, body: response.body };
  } };
  await scenarioCommand(upload, { key: `${scenario.key}:external-upload`, actor: scenario.logistics, method: 'post', url,
    body: { sha256: createHash('sha256').update(bytes).digest('hex'), documentId, filename: `${reference}.pdf` } });
  return { documentId, reference };
};
async function actualOrder(scenario: OrderScenario) {
  const [result] = await runOrderScenarios(master, [scenario], deps, { businessDate: todayLocalKey(), archiveExternalFiling,
    prepareCommercialTerms: context => prepareFabricCommissionTerms(context, { rate: '5' }) });
  expect(result.earnedSteps, result.blockedAt).toContain('shipment.actual-departure-readback');
  return result;
}
describe.sequential('native supplier-to-us fabric commission', () => {
  it('C01 preserves one actual whole-order settlement after a lost ACK, registers commission AR, and allocates actual supplier cash only', async () => {
    const scenario = buildBusinessScenarios(master).orders.find(row => row.family === 'fabric' && row.stopAfter === 'commission_pending')!;
    const order = await actualOrder(scenario), orderId = String(order.ids.orderId), lineId = String(order.ids.lineId);
    expect(order.stopReached).toBe(false); expect(order.blockedAt).toContain('COMMISSION_SOURCE_PRODUCER_REQUIRED');
    const base = `/api/v1/orders/${orderId}/fabric-commission`;
    const source = (await deps.invoke(scenario.owner, 'get', base)).body.source;
    expect(source.groups[0]).toMatchObject({ supplierId: scenario.supplierId });
    const outsider = buildBusinessScenarios(master).orders.find(row => row.family === 'fabric' && row.teamKey !== scenario.teamKey)!.owner;
    ok(await deps.invoke(outsider, 'get', base), 404, 'actual foreign business group cannot read commission source');
    const frozenMutation = await deps.invoke(scenario.owner, 'put', `/api/v1/order-lines/${lineId}`, { fabricCommissionRate: '99' });
    expect(frozenMutation.status, JSON.stringify(frozenMutation.body)).toBe(409);
    // Real DB authority has orders:write, but this actual credential context
    // has a narrower ceiling. The native service may not restore that scope.
    const actualActor = createAuthService().verifyToken(tokens[scenario.owner]);
    await expect(settleFabricCommission(prisma, { ...actualActor, permissionCeiling: ['orders:read'] }, orderId,
      { requestKey: randomUUID(), expectedSourceFingerprint: source.sourceFingerprint })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    loseSettlementAck = true;
    const context = { master, scenario, orderId, lineId, deps };
    const first = await runFabricCommissionScenario(context, { rate: '5', businessDate: todayLocalKey() });
    expect(first.stopReached).toBe(false); expect(first.blockedAt).toContain('commission.settle');
    expect(await prisma.auditLog.count({ where: { action: 'settle_fabric_order_commission', targetId: orderId } })).toBe(1);
    const resumed = await runFabricCommissionScenario(context, { rate: '5', businessDate: todayLocalKey() });
    expect(resumed.stopReached, resumed.blockedAt).toBe(true); expect(resumed.earnedSteps).toContain('commission.ar.unpaid-readback');
    expect(await prisma.invoice.count({ where: { orderId, sourceType: 'BusinessShipmentCI' } })).toBe(0);
    const ordinary = await deps.invoke(scenario.finance, 'post', `/api/v1/finance/business-ci/${order.ids.ciDocumentId}/register`, {});
    expect(ordinary.status, JSON.stringify(ordinary.body)).toBe(409);
    const manual = await deps.invoke(scenario.finance, 'post', '/api/v1/finance', { sourceType: 'FabricCommissionCI', sourceId: resumed.ids.commissionDocumentVersionId,
      type: 'Receivable', status: 'Issued', amount: '999999', currency: scenario.currency, orderId });
    expect(manual.status, JSON.stringify(manual.body)).toBe(409);
    ok(await deps.invoke(scenario.owner, 'post', `${base}/settle`, { requestKey: randomUUID(), expectedSourceFingerprint: source.sourceFingerprint }), 409, 'one order cannot settle twice');
    const originalCommand = await deps.journal.read(`${scenario.key}:commission.settle`);
    ok(await deps.invoke(scenario.owner, 'post', `${base}/settle`, { ...originalCommand!.body as object, note: 'changed content' }), 409, 'original key cannot change settlement input');
    const cash = await createScenarioCashResolver(master, deps)(scenario.currency);
    const paid = await runFabricCommissionScenario(context, { rate: '5', businessDate: todayLocalKey(),
      paymentPlan: { amount: '10', cashAccountId: cash.id, bankReference: `${scenario.key}-ACTUAL-SUPPLIER-10` } });
    expect(paid.stopReached, paid.blockedAt).toBe(true); expect(paid.earnedSteps).toContain('commission.ar.supplier-cash-allocation-readback');
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: String(paid.ids.commissionInvoiceId) } });
    expect(invoice).toMatchObject({ customerRelationId: scenario.supplierId, sourceType: 'FabricCommissionCI', status: 'PartiallyPaid' });
    const payment = await prisma.paymentVoucher.findUniqueOrThrow({ where: { id: String(paid.ids.commissionReceiptVoucherId) } });
    expect(payment.customerRelationId).toBe(scenario.supplierId); expect(payment.customerRelationId).not.toBe(scenario.customerId);
    const html = await supertest(app).get(`${base}/documents/${paid.ids.commissionDocumentId}/html`).set('Authorization', `Bearer ${tokens[scenario.owner]}`);
    expect(html.status).toBe(200); expect(html.text).toContain('FABRIC COMMISSION');
    await prisma.userAccount.update({ where: { id: master.cast[scenario.owner].id }, data: { status: 'disabled' } });
    const revoked = await deps.invoke(scenario.owner, 'post', `${base}/settle`, originalCommand!.body);
    expect(revoked.status).toBe(401);
  }, 600_000);
  it('C02 refuses first-part shipment settlement and ordinary commission goods AR without manufacturing completion', async () => {
    const base = buildBusinessScenarios(master).orders.find(row => row.family === 'fabric' && row.stopAfter === 'partially_shipped')!;
    const scenario = { ...base, key: `${base.key}-commission`, shipmentGroupKey: undefined };
    const result = await actualOrder(scenario), orderId = String(result.ids.orderId);
    expect(result.stopReached, result.blockedAt).toBe(true);
    const refusal = await deps.invoke(scenario.owner, 'get', `/api/v1/orders/${orderId}/fabric-commission`);
    expect(refusal.status, JSON.stringify(refusal.body)).toBe(409);
    expect(await prisma.tradeDocument.count({ where: { orderId, sourceRef: { startsWith: 'fabric-commission:v1:' } } })).toBe(0);
    const ordinary = await deps.invoke(scenario.finance, 'post', `/api/v1/finance/business-ci/${result.ids.ciDocumentId}/register`, {});
    expect(ordinary.status, JSON.stringify(ordinary.body)).toBe(409);
  }, 600_000);
});
