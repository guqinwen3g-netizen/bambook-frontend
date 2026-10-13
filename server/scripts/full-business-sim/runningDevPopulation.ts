/** Populate an already committed, qualified current-dev rebuild through its
 * running server. The original cast is read back, never seeded or reset here. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { readCommittedDevMaster, type DevMasterCommand, type DevMasterCommittedReceipt } from './provisionDevMaster';
import { createRunningDevTransport } from './runningDevTransport';
import { createPrivateScenarioJournal } from './privateJournal';
import { scenarioCommand, type ScenarioDriverDependencies } from './driverContract';
import { runFullBusinessSimulation } from './fullSimulation';
import { simulationEvidencePdf } from './simulationEvidencePdf';
import { readDevelopmentClockEvidence } from './developmentClockEvidence';
import { SCENARIO_BUSINESS_TIME } from './scenarios';
import { assertMatchingScenarioRuntimeIdentity, readScenarioRuntimeIdentity } from '../../src/devPanel/scenarioIdentity';
import { acquireScenarioPopulationLease } from './populationLease';

export async function assertCurrentDevRuntimeAnchor(prisma: PrismaClient, receipt: DevMasterCommittedReceipt, expectedPort: number) {
  const proof = await readScenarioRuntimeIdentity(prisma, receipt.requestKey, expectedPort);
  try { assertMatchingScenarioRuntimeIdentity(proof, { ...proof, receipt }); }
  catch { throw Error('SCENARIO_RUNTIME_ORIGINAL_RECEIPT_CHANGED'); }
  return proof;
}

export async function runCurrentDevPopulation(prisma: PrismaClient, input: DevMasterCommand & {
  privateDirectory: string; expectedPort: number; assertRuntimeCurrent(): void | Promise<void>;
}) {
  if (typeof input.assertRuntimeCurrent !== 'function') throw Error('SCENARIO_QUALIFIED_RUNTIME_GUARD_REQUIRED');
  await input.assertRuntimeCurrent();
  // A single session must hold the generator lease for the entire batch. The
  // real CLI fixes connection_limit=1. Atomic journal files alone cannot stop
  // two processes from issuing the same non-idempotent create simultaneously.
  const lease = await acquireScenarioPopulationLease(prisma);
  try { return await runCurrentDevPopulationWithLease(prisma, input, () => lease.assertHeld()); }
  finally { await lease.release(); }
}

async function runCurrentDevPopulationWithLease(prisma: PrismaClient, input: DevMasterCommand & {
  privateDirectory: string; expectedPort: number; assertRuntimeCurrent(): void | Promise<void>;
}, assertLease: () => Promise<void>) {
  await assertLease();
  const recovered = await readCommittedDevMaster(prisma, input);
  if (recovered.phase !== 'master_provisioned') throw Error('SCENARIO_ORIGINAL_MASTER_COMMIT_UNKNOWN');
  const { master, receipt } = recovered;
  const anchor = async () => { await input.assertRuntimeCurrent(); await assertLease(); return assertCurrentDevRuntimeAnchor(prisma, receipt, input.expectedPort); };
  await anchor();
  const transport = await createRunningDevTransport(master, { verifyRuntimeAnchor: anchor });
  const journal = await createPrivateScenarioJournal(path.join(input.privateDirectory, 'business-command-journal'));
  const runtimeId = `current-dev:${receipt.transactionId}:${receipt.credentialsSha256}`;
  const markerKey = 'population:original-runtime', previous = await journal.read(markerKey);
  let wallStartedAtMs = Date.now();
  if (previous) {
    if (previous.runtimeId !== runtimeId || previous.actorId !== master.cast.owner.id || previous.state !== 'acknowledged'
      || (previous.body as any)?.transactionId !== receipt.transactionId || !Number.isFinite((previous.body as any)?.wallStartedAtMs)) throw Error('SCENARIO_POPULATION_RUNTIME_CHANGED');
    wallStartedAtMs = (previous.body as any).wallStartedAtMs;
  } else await journal.write({ key: markerKey, actor: 'owner', actorId: master.cast.owner.id, runtimeId,
    method: 'get', url: '/api/dev/status', retryPolicy: 'read', hash: createHash('sha256').update(runtimeId).digest('hex'),
    state: 'acknowledged', body: { transactionId: receipt.transactionId, wallStartedAtMs }, response: { status: 200, body: { prepared: true } } });
  const deps: ScenarioDriverDependencies = { invoke: transport.invoke, verifyActor: transport.verifyActor, runtimeId, journal,
    actorIds: Object.fromEntries(Object.values(master.cast).map(actor => [actor.key, actor.id])) as ScenarioDriverDependencies['actorIds'] };
  const result = await runFullBusinessSimulation(master, deps, { archiveExternalFiling: async ({ scenario, shipmentId, documentId }) => {
    const reference = `SIM-FILING-${scenario.key}`, bytes = simulationEvidencePdf(reference, shipmentId), filename = `${reference}.pdf`;
    const url = `/api/v1/customs/trade-documents/${encodeURIComponent(documentId)}/external-archive`;
    const uploadDeps: ScenarioDriverDependencies = { ...deps, invoke: async (actor, method, target) => {
      if (method !== 'post' || target !== url) throw Error('SCENARIO_UPLOAD_TARGET_CHANGED');
      return transport.upload(actor, url, { bytes, filename });
    } };
    await scenarioCommand(uploadDeps, { key: `${scenario.key}:external-upload`, actor: scenario.logistics, method: 'post', url,
      body: { sha256: createHash('sha256').update(bytes).digest('hex'), documentId, filename } });
    return { documentId, reference };
  } });
  await anchor();
  let clockEvidence: unknown, clockEvidenceError: string | undefined;
  try {
    clockEvidence = await readDevelopmentClockEvidence(prisma, { expectedBusinessTimeIso: SCENARIO_BUSINESS_TIME,
      caseIds: result.development.executions.map(row => row.ids.caseId).filter((id): id is string => typeof id === 'string'),
      wallStartedAtMs, wallEndedAtMs: Date.now() });
  } catch (error) { clockEvidenceError = error instanceof Error ? error.message : 'SCENARIO_CLOCK_READBACK_FAILED'; }
  const [dev, orders, archives, customers, suppliers] = await Promise.all([
    prisma.developmentCase.groupBy({ by: ['type'], _count: { _all: true } }),
    prisma.order.groupBy({ by: ['businessLine'], _count: { _all: true } }),
    prisma.productAsset.groupBy({ by: ['mainCategory'], where: { deletedAt: null }, _count: { _all: true } }),
    prisma.relation.count({ where: { category: 'Customer', isOrganization: true, deletedAt: null } }),
    prisma.relation.count({ where: { category: 'Supplier', isOrganization: true, deletedAt: null } }),
  ]);
  const count = (rows: any[], field: string, value: string) => rows.find(row => row[field] === value)?._count._all ?? 0;
  const executions = [...result.development.executions, ...result.orders];
  const counts = { customers, suppliers, fabricOrders: count(orders, 'businessLine', 'fabric'), garmentOrders: count(orders, 'businessLine', 'garment'),
    fabricDevelopments: count(dev, 'type', 'fabric'), garmentDevelopments: count(dev, 'type', 'garment'),
    fabricArchives: count(archives, 'mainCategory', 'Fabric'), garmentArchives: count(archives, 'mainCategory', 'Garment') };
  const allStopsReached = executions.length === 60 && executions.every(row => row.stopReached && !row.blockedAt);
  const report = { observedAtWallIso: new Date().toISOString(), database: 'panda_hub_dev', businessTime: SCENARIO_BUSINESS_TIME,
    originalMasterReceipt: receipt, configuration: result.configuration, plan: result.plan, development: result.development, orders: result.orders,
    counts, clockEvidence, clockEvidenceError, claims: { currentDevRebuilt: true, allStopsReached, wholeProductPassed: false, uiPassed: false } };
  // This report has no passwords or tokens. Private per-command journal remains
  // private because request/response commercial data can include sensitive facts.
  await fs.writeFile(path.join(input.privateDirectory, 'population-result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  if (!allStopsReached || clockEvidenceError || counts.fabricOrders < 15 || counts.garmentOrders < 15
    || counts.fabricDevelopments < 10 || counts.garmentDevelopments < 10 || customers < 30 || suppliers < 30
    || counts.fabricArchives < 30 || counts.garmentArchives < 30) throw Error('SCENARIO_POPULATION_INCOMPLETE_READ_PRIVATE_REPORT');
  return report;
}
