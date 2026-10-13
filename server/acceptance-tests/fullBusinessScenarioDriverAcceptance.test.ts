/** Dedicated, fresh private panda_hub_dev rehearsal with the actual frozen
 * business clock. Run only through --working-source + dev-scenario-rehearsal. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import supertest from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { assertScenarioRehearsalDatabase } from './scenarioRehearsalDatabase';
import { seedScenarioMasterData, type ScenarioActorKey } from '../scripts/full-business-sim/masterData';
import { SCENARIO_BUSINESS_TIME } from '../scripts/full-business-sim/scenarios';
import { createScenarioRehearsalApp } from '../scripts/full-business-sim/scenarioApp';
import { createPrivateScenarioJournal } from '../scripts/full-business-sim/privateJournal';
import { scenarioCommand, type ScenarioDriverDependencies, type ScenarioHttpMethod } from '../scripts/full-business-sim/driverContract';
import { simulationEvidencePdf } from '../scripts/full-business-sim/simulationEvidencePdf';
import { runFullBusinessSimulation } from '../scripts/full-business-sim/fullSimulation';
import { assertBusinessClockConfiguration, getBusinessClock } from '../src/shared/businessClock';
import { readDevelopmentClockEvidence } from '../scripts/full-business-sim/developmentClockEvidence';

const prisma = new PrismaClient({ datasources: { db: { url: process.env.BAMBOOK_ACCEPTANCE_DATABASE_URL
  ?? 'postgresql://disabled:disabled@127.0.0.1:1/disabled' } } });
afterAll(async () => { await prisma.$disconnect(); });

describe('full real-account business simulation rehearsal', () => {
  it('earns all 24 development and 36 order scenario stops through native producers', async () => {
    // The native guard is always before the first fixture or business mutation.
    await assertScenarioRehearsalDatabase(prisma);
    assertBusinessClockConfiguration();
    expect(getBusinessClock()).toMatchObject({ mode: 'fixed', nowIso: SCENARIO_BUSINESS_TIME, database: 'panda_hub_dev' });
    expect(await prisma.userAccount.count()).toBe(0);
    expect(await prisma.order.count()).toBe(0);
    const wallStartedAtMs = Date.now();
    const sandbox = process.env.BAMBOOK_ACCEPTANCE_SANDBOX!;
    const master = await seedScenarioMasterData(prisma, { namespace: 'sim-' + randomUUID().slice(0, 8),
      nowMs: Date.parse(SCENARIO_BUSINESS_TIME), mode: 'apply' });
    await fs.writeFile(path.join(sandbox, 'scenario-cast.private.json'), JSON.stringify(master), { mode: 0o600, flag: 'wx' });
    const app = createScenarioRehearsalApp(prisma, path.join(sandbox, 'private-files'));
    const tokens = {} as Record<ScenarioActorKey, string>;
    const sessions: Array<{ key: string; id: string; roles: string[] }> = [];
    for (const actor of Object.values(master.cast)) {
      const response = await supertest(app).post('/api/auth/login').send({ identifier: actor.email, password: actor.password });
      expect(response.status, `actual login ${actor.key}: ${JSON.stringify(response.body)}`).toBe(200);
      expect(response.body.user.id).toBe(actor.id);
      tokens[actor.key] = response.body.token;
      sessions.push({ key: actor.key, id: actor.id, roles: response.body.user.roleIds });
    }
    const verifyActor = async (actor: ScenarioActorKey) => {
      const me = await supertest(app).get('/api/auth/me').set('Authorization', `Bearer ${tokens[actor]}`);
      if (me.status !== 200 || me.body.user?.id !== master.cast[actor].id) throw Error(`SCENARIO_ACTOR_REVOKED: ${actor}`);
    };
    const invoke = async (actor: ScenarioActorKey, method: ScenarioHttpMethod, url: string, body?: unknown) => {
      await verifyActor(actor);
      let call = supertest(app)[method](url).set('Authorization', `Bearer ${tokens[actor]}`);
      if (body !== undefined) call = call.send(body as any);
      if (/\/download(?:\?|$)/.test(url)) call = call.buffer(true).parse((response: any, done: any) => {
        const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => done(null, Buffer.concat(chunks))); response.on('error', done);
      });
      const response = await call;
      return { status: response.status, body: response.body };
    };
    const deps: ScenarioDriverDependencies = { invoke, verifyActor,
      runtimeId: `private-scenario:${process.env.BAMBOOK_SCENARIO_REHEARSAL_NONCE}`,
      actorIds: Object.fromEntries(Object.values(master.cast).map(actor => [actor.key, actor.id])) as Record<ScenarioActorKey, string>,
      journal: await createPrivateScenarioJournal(path.join(sandbox, 'scenario-command-journal')) };
    const { configuration, development, orders: orderResults } = await runFullBusinessSimulation(master, deps, {
      archiveExternalFiling: async ({ scenario, shipmentId, documentId }) => {
        const reference = `SIM-FILING-${scenario.key}`, bytes = simulationEvidencePdf(reference, shipmentId);
        const url = `/api/v1/customs/trade-documents/${encodeURIComponent(documentId)}/external-archive`;
        // Multipart transport binds the exact actual bytes into the ordinary
        // private intent protocol. A lost non-idempotent ACK cannot reupload.
        const uploadDeps: ScenarioDriverDependencies = { ...deps, invoke: async (actor, method, target) => {
          if (method !== 'post' || target !== url) throw Error('SCENARIO_UPLOAD_TARGET_CHANGED');
          await verifyActor(actor);
          const response = await supertest(app).post(url).set('Authorization', `Bearer ${tokens[actor]}`)
            .attach('file', bytes, { filename: `${reference}.pdf`, contentType: 'application/pdf' });
          return { status: response.status, body: response.body };
        } };
        await scenarioCommand(uploadDeps, { key: `${scenario.key}:external-upload`, actor: scenario.logistics, method: 'post', url,
          body: { sha256: createHash('sha256').update(bytes).digest('hex'), documentId, filename: `${reference}.pdf` } });
        return { documentId, reference };
      },
    });
    let clockEvidence: unknown, clockEvidenceError: string | undefined;
    try {
      clockEvidence = await readDevelopmentClockEvidence(prisma, {
        caseIds: development.executions.map(row => row.ids.caseId).filter((id): id is string => typeof id === 'string'),
        expectedBusinessTimeIso: SCENARIO_BUSINESS_TIME, wallStartedAtMs, wallEndedAtMs: Date.now(),
      });
    } catch (error) { clockEvidenceError = error instanceof Error ? error.message : 'Development clock readback failed'; }
    const [developmentFamilies, orderFamilies, archiveFamilies, customers, suppliers] = await Promise.all([
      prisma.developmentCase.groupBy({ by: ['type'], _count: { _all: true } }),
      prisma.order.groupBy({ by: ['businessLine'], _count: { _all: true } }),
      prisma.productAsset.groupBy({ by: ['mainCategory'], where: { deletedAt: null }, _count: { _all: true } }),
      prisma.relation.count({ where: { category: 'Customer', isOrganization: true, deletedAt: null } }),
      prisma.relation.count({ where: { category: 'Supplier', isOrganization: true, deletedAt: null } }),
    ]);
    const count = (rows: any[], field: string, value: string) => rows.find(row => row[field] === value)?._count._all ?? 0;
    const report = { businessTime: getBusinessClock(), clockEvidence, clockEvidenceError, configuration, sessions, expected: { development: 24, orders: 36 }, development, orders: orderResults,
      counts: { developmentCases: developmentFamilies.reduce((sum, row) => sum + row._count._all, 0),
        orders: orderFamilies.reduce((sum, row) => sum + row._count._all, 0), customers, suppliers,
        fabricOrders: count(orderFamilies, 'businessLine', 'fabric'), garmentOrders: count(orderFamilies, 'businessLine', 'garment'),
        fabricDevelopments: count(developmentFamilies, 'type', 'fabric'), garmentDevelopments: count(developmentFamilies, 'type', 'garment'),
        fabricArchives: count(archiveFamilies, 'mainCategory', 'Fabric'), garmentArchives: count(archiveFamilies, 'mainCategory', 'Garment') },
      claims: { allStopsReached: development.executions.every(row => row.stopReached) && orderResults.every(row => row.stopReached),
        wholeProductPassed: false, uiPassed: false, currentDevRebuilt: false } };
    await fs.writeFile(path.join(sandbox, 'scenario-execution.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    for (const key of ['fabricOrders', 'garmentOrders'] as const) expect(report.counts[key]).toBeGreaterThanOrEqual(15);
    for (const key of ['fabricDevelopments', 'garmentDevelopments'] as const) expect(report.counts[key]).toBeGreaterThanOrEqual(10);
    for (const key of ['customers', 'suppliers', 'fabricArchives', 'garmentArchives'] as const) expect(report.counts[key]).toBeGreaterThanOrEqual(30);
    const blocks = [...development.executions, ...orderResults].filter(row => !row.stopReached).map(row => ({ key: row.key, at: row.blockedAt }));
    expect(development.executions).toHaveLength(24); expect(orderResults).toHaveLength(36);
    expect(clockEvidenceError, 'fixed development business-event time and actual wall-clock audit readback').toBeUndefined();
    expect(blocks, `actual producer blockers; private report ${path.join(sandbox, 'scenario-execution.json')}`).toEqual([]);
  }, 900_000);
});
