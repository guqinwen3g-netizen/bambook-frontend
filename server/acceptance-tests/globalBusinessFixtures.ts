import { randomUUID } from 'node:crypto';
import path from 'node:path';
import express, { type Express } from 'express';
import supertest from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createAuthService } from '../src/auth/service';
import { createAuthRouter } from '../src/auth/route';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { SYSTEM_ROLE_IDS, SYSTEM_ROLE_META, getDatabaseSeedScopeListForRole } from '../src/_shared/rolePermissionMatrix';
import { createDevelopmentRouter } from '../src/development/route';
import { createSampleRouter } from '../src/samples/sampleRoute';
import { createQcRouter } from '../src/qc/qcRoute';
import { assertIsolatedAcceptanceDatabase } from './isolatedDatabase';

export type BusinessFixtureActor = { id: string; name: string; email: string; token: string; roleId: string };
export type BusinessFixtureActorName = 'salesOwner' | 'salesOutsider' | 'qc' | 'qcOutsider' | 'actualRequester'
  | 'manager' | 'admin' | 'superAdmin' | 'finance' | 'logistics';
export type HttpMethod = 'get' | 'post' | 'patch' | 'put' | 'delete';

export interface GlobalBusinessHttpFixture {
  prisma: PrismaClient;
  app: Express;
  prefix: string;
  actors: Record<BusinessFixtureActorName, BusinessFixtureActor>;
  customer: { id: string; name: string };
  factory: { id: string; name: string };
  secondFactory: { id: string; name: string };
  warehouse: { id: string; name: string };
  teamIds: { fabric: string; garment: string };
  request(actor: BusinessFixtureActor | BusinessFixtureActorName, method: HttpMethod, url: string, body?: unknown): Promise<supertest.Response>;
  close(): Promise<void>;
}

/** Master data and current authorization only. All business conclusions, sample
 * stock, QC reports, version confirmations and archives are created via HTTP. */
export async function createGlobalBusinessHttpFixture(prisma: PrismaClient, options: {
  prefix?: string; mountAdditionalRoutes?: (app: Express) => void;
} = {}): Promise<GlobalBusinessHttpFixture> {
  await assertIsolatedAcceptanceDatabase(prisma);
  const prefix = (options.prefix ?? `accept-${randomUUID().slice(0, 8)}`).replace(/[^a-zA-Z0-9_-]/g, '-');
  const apiKeys = new Set<string>();
  for (const roleId of Object.values(SYSTEM_ROLE_IDS)) {
    const meta = SYSTEM_ROLE_META[roleId];
    await prisma.role.upsert({ where: { id: roleId }, update: {}, create: { id: roleId, name: meta.name, description: meta.description } });
    for (const scope of getDatabaseSeedScopeListForRole(roleId)) {
      const permission = await prisma.permission.upsert({ where: { scope }, update: {}, create: { id: `perm_${scope.replace(/[:./]/g, '_')}`, scope } });
      await prisma.rolePermission.upsert({ where: { roleId_permissionId: { roleId, permissionId: permission.id } }, update: {},
        create: { id: `${roleId}_${permission.id}`, roleId, permissionId: permission.id } });
    }
  }
  const department = await prisma.department.create({ data: { id: `${prefix}-department`, name: `${prefix} 业务部` } });
  const password = `Acceptance-${randomUUID()}`;
  const passwordHash = await createAuthService().hashPassword(password);
  const accountRoles: Record<BusinessFixtureActorName, string> = {
    salesOwner: SYSTEM_ROLE_IDS.SALES, salesOutsider: SYSTEM_ROLE_IDS.SALES,
    qc: SYSTEM_ROLE_IDS.QC, qcOutsider: SYSTEM_ROLE_IDS.QC, actualRequester: SYSTEM_ROLE_IDS.SALES,
    manager: SYSTEM_ROLE_IDS.SALES_MANAGER, admin: SYSTEM_ROLE_IDS.ADMIN,
    superAdmin: SYSTEM_ROLE_IDS.SUPER_ADMIN, finance: SYSTEM_ROLE_IDS.FINANCE, logistics: SYSTEM_ROLE_IDS.LOGISTICS,
  };
  const actors = {} as Record<BusinessFixtureActorName, BusinessFixtureActor>;
  for (const [name, roleId] of Object.entries(accountRoles) as Array<[BusinessFixtureActorName, string]>) {
    const user = await prisma.userAccount.create({ data: { id: `${prefix}-${name}`, displayName: `${prefix} ${name}`,
      email: `${prefix}.${name.toLowerCase()}@acceptance.bambook.local`, passwordHash, status: 'active', primaryDeptId: department.id } });
    await prisma.userRole.create({ data: { id: `${user.id}-role`, userId: user.id, roleId, departmentId: department.id } });
    actors[name] = { id: user.id, name: user.displayName, email: user.email!, token: '', roleId };
  }
  const masterRelation = async (kind: 'customer' | 'factory', suffix: string) => prisma.relation.create({ data: {
    id: `${prefix}-${suffix}`, code: `${prefix}-${suffix}`, name: `${prefix} ${suffix}`,
    category: kind === 'customer' ? 'Customer' : 'Supplier', type: 'company', isOrganization: true,
    tags: ['ISOLATED_ACCEPTANCE'], contactInfo: '{}', lastInteraction: BigInt(Date.now()), ownerId: actors.salesOwner.id,
    departmentId: department.id, salesRepIds: [actors.salesOwner.id], factoryAddresses: [],
  } });
  const customer = await masterRelation('customer', 'customer');
  const factory = await masterRelation('factory', 'factory');
  const secondFactory = await masterRelation('factory', 'factory-2');
  const teamIds = { fabric: `${prefix}-fabric-team`, garment: `${prefix}-garment-team` };
  for (const family of ['fabric', 'garment'] as const) {
    const teamId = teamIds[family];
    await prisma.team.create({ data: { id: teamId, name: `${prefix} ${family === 'fabric' ? '面料' : '成衣'}业务组`,
      departmentId: department.id, leaderId: actors.manager.id, metadata: { businessFamily: family } } });
    for (const actorName of ['salesOwner', 'actualRequester', 'manager', 'qc', 'finance', 'logistics'] as const) {
      await prisma.teamMember.create({ data: { id: `${teamId}-${actorName}`, teamId, userId: actors[actorName].id,
        role: actorName === 'manager' ? 'leader' : 'member' } });
    }
    await prisma.teamDataGrant.create({ data: { teamId, entityType: 'relation', entityId: customer.id,
      permission: 'read+followup', grantedBy: actors.manager.id } });
  }
  const warehouse = await prisma.warehouse.create({ data: { id: `${prefix}-warehouse`, code: `${prefix}-WH`, name: `${prefix} 样品间`,
    type: 'Auxiliary', isActive: true, createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) } });
  const app = express();
  app.use(express.json());
  app.use('/api', createAuthorizationSnapshotGuard({ prisma, apiKeys }));
  app.use('/api/auth', createAuthRouter({ prisma, loginRateLimit: false }));
  app.use('/api/v1/development', createDevelopmentRouter({ prisma, requireAuth: true, apiKeys }));
  const privateFilesDir = path.join(process.env.BAMBOOK_ACCEPTANCE_SANDBOX!, `${prefix}-private-files`);
  app.use('/api/v1/samples', createSampleRouter({ prisma, requireAuth: true, apiKeys, privateFilesDir }));
  app.use('/api/v1/qc', createQcRouter({ prisma, requireAuth: true, apiKeys, privateFilesDir }));
  options.mountAdditionalRoutes?.(app);
  for (const actor of Object.values(actors)) {
    const response = await supertest(app).post('/api/auth/login').send({ identifier: actor.email, password });
    requireHttpSuccess(response, `login ${actor.roleId}`, 200);
    if (response.body.user?.id !== actor.id || typeof response.body.token !== 'string') throw new Error('Login did not resolve the fixture account.');
    actor.token = response.body.token;
  }
  return { prisma, app, prefix, actors, customer, factory, secondFactory, warehouse, teamIds,
    async request(actor, method, url, body) {
      const actual = typeof actor === 'string' ? actors[actor] : actor;
      let call = supertest(app)[method](url).set('Authorization', `Bearer ${actual.token}`);
      if (body === null) call = call.set('Content-Type', 'application/json').send('null');
      else if (typeof body === 'string' || body && typeof body === 'object') call = call.send(body);
      else if (body !== undefined) call = call.set('Content-Type', 'application/json').send(JSON.stringify(body));
      return await call;
    },
    // supertest uses a bounded listener per request; the owning suite closes Prisma.
    async close() {},
  };
}

export function requireHttpSuccess(response: supertest.Response, context: string, expectedStatus = 200, requireOk = true) {
  if (response.status !== expectedStatus || requireOk && response.body?.ok !== true) {
    throw new Error(`${context}: expected ${expectedStatus}, got ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

export interface ReturnedDevelopmentSample {
  caseId: string; batchId: string; versionId: string; batch: any; physicalCardIds: string[]; physicalCards: any[];
}

export async function createReturnedDevelopmentSample(f: GlobalBusinessHttpFixture, options: {
  key?: string; type?: 'fabric' | 'garment'; quantity?: number; lengthMeters?: string; internal?: boolean;
  warehouseId?: string; location?: string;
} = {}): Promise<ReturnedDevelopmentSample> {
  const key = options.key ?? randomUUID().slice(0, 8);
  const type = options.type ?? 'fabric';
  const created = requireHttpSuccess(await f.request('salesOwner', 'post', '/api/v1/development', {
    code: `${f.prefix}-${key}`, name: `${type} 连续验收 ${key}`, type, ownerId: f.actors.salesOwner.id,
    initiator: options.internal ? 'internal' : 'customer', customerInput: 'spec-direction',
    ...(options.internal ? {} : { customerRelationId: f.customer.id, customerName: f.customer.name }),
    departmentId: (await f.prisma.userAccount.findUniqueOrThrow({ where: { id: f.actors.salesOwner.id } })).primaryDeptId,
    developmentDirection: '依据准确工厂版本复核样品，保留独立事实',
    specComposition: '100% Wool', specWeight: '280', specWidth: '150', specWeave: 'Twill', specFinish: 'Soft',
    styleSpec: 'Blazer', sizeSpec: 'M', fabricSpec: 'Wool', processSpec: 'Tailored', source: 'customer-request',
  }), 'create development', 201);
  const caseId = created.case.id;
  let batch: any;
  if (type === 'fabric') {
    requireHttpSuccess(await f.request('salesOwner', 'post', `/api/v1/development/${encodeURIComponent(caseId)}/suppliers`, {
      supplierRelationId: f.factory.id, supplierName: f.factory.name,
    }), 'add factory', 201);
    const planned = requireHttpSuccess(await f.request('salesOwner', 'post', `/api/v1/development/${encodeURIComponent(caseId)}/batches`, {
      sampleTypes: ['yardage'], supplierRelationId: f.factory.id, supplierName: f.factory.name, round: 1,
      roundNotes: '本轮比较手感与规格', factoryRequirements: '按要求返样，保留真实批次',
      samplePlans: [{ sampleType: 'yardage', quantity: Number(options.lengthMeters ?? '10.5'), unit: '米' }],
    }), 'plan fabric sample', 201);
    batch = planned.batch;
  } else {
    const planned = requireHttpSuccess(await f.request('salesOwner', 'post', `/api/v1/samples/garment/${encodeURIComponent(caseId)}/rounds`, {
      purpose: '版型与工艺确认', version: 'V1', materialConfig: 'Wool/Tailored', round: 1,
      supplierRelationId: f.factory.id, supplierName: f.factory.name, factoryRequirements: '保留逐件样衣身份',
      plannedQuantity: options.quantity ?? 2, plannedUnit: '件',
    }), 'plan garment sample', 201);
    batch = planned.round;
  }
  const batchId = batch.id;
  const versionId = batch.sampleVersionId;
  if (!versionId) throw new Error('Native planning did not return an exact sample version.');
  const started = requireHttpSuccess(await f.request('salesOwner', 'patch', `/api/v1/development/batches/${encodeURIComponent(batchId)}/stage`, {
    action: 'start', requestKey: `${f.prefix}-${key}-start`, expectedRevision: 0, expectedRound: 1,
  }), 'start sampling');
  batch = started.batch;
  const returned = requireHttpSuccess(await f.request('salesOwner', 'post', `/api/v1/development/${encodeURIComponent(caseId)}/batches/${encodeURIComponent(batchId)}/return-results`, {
    requestKey: `${f.prefix}-${key}-return`, expectedBatchUpdatedAt: String(batch.updatedAt),
    actualQuantity: type === 'fabric' ? options.lengthMeters ?? '10.5' : String(options.quantity ?? 2), actualUnit: type === 'fabric' ? '米' : '件',
    notes: '已实际收到工厂返样', ...(options.warehouseId ? { warehouseId: options.warehouseId } : {}),
    ...(options.location ? { location: options.location } : {}),
  }), 'record actual sample return');
  const library = requireHttpSuccess(await f.request('salesOwner', 'get', `/api/v1/samples/room/items?devCaseId=${encodeURIComponent(caseId)}`), 'read synchronized sample library');
  const physicalCards = library.items ?? library.list ?? [];
  if (physicalCards.length !== (type === 'garment' ? options.quantity ?? 2 : 1)) throw new Error('Returned physical sample set differs from the Sample Library.');
  if (physicalCards.some((item: any) => item.batchId !== batchId || item.devCaseId !== caseId)) throw new Error('Sample Library source identity changed.');
  return { caseId, batchId, versionId, batch: returned.batch, physicalCards, physicalCardIds: physicalCards.map((item: any) => item.id) };
}

export async function completeExactDevelopmentQc(f: GlobalBusinessHttpFixture, source: Pick<ReturnedDevelopmentSample, 'caseId' | 'batchId' | 'versionId'>, options: {
  key?: string; result?: 'pass' | 'reject' | 'needs_adjustment';
} = {}) {
  const key = options.key ?? `${f.prefix}-${randomUUID().slice(0, 8)}`;
  const requested = requireHttpSuccess(await f.request('salesOwner', 'post', `/api/v1/development/${encodeURIComponent(source.caseId)}/batches/${encodeURIComponent(source.batchId)}/qc-review`, {
    requestKey: `${key}-request`, sampleVersionId: source.versionId,
  }), 'request exact version QC', 201);
  if (requested.item.sampleVersionId !== source.versionId) throw new Error('QC request returned another version.');
  const reviewId = requested.item.id;
  requireHttpSuccess(await f.request('qc', 'post', `/api/v1/qc/development-sample-reviews/${encodeURIComponent(reviewId)}/start`, {}), 'professional QC starts task');
  const completed = requireHttpSuccess(await f.request('qc', 'post', `/api/v1/qc/development-sample-reviews/${encodeURIComponent(reviewId)}/complete`, {
    requestKey: `${key}-complete`, result: options.result ?? 'pass', opinion: options.result === 'reject' ? '准确版本不符合本轮要求' : '按准确版本要求复核实物及规格',
    inspectionDate: new Date().toISOString().slice(0, 10), inspectorOrg: 'Bambook QC', criticalDefects: 0, majorDefects: 0, minorDefects: 0, evidence: [],
  }), 'professional QC completes exact version');
  if (completed.item.sampleVersionId !== source.versionId || completed.item.reviewedBy !== f.actors.qc.id) throw new Error('Formal QC completion identity changed.');
  return { reviewId, request: requested.item, review: completed.item, requestKey: `${key}-request`, completionRequestKey: `${key}-complete` };
}

export async function convertExactDevelopmentArchive(f: GlobalBusinessHttpFixture, source: Pick<ReturnedDevelopmentSample, 'caseId' | 'batchId' | 'versionId'>, options: {
  key?: string; type?: 'fabric' | 'garment';
} = {}) {
  const requestKey = options.key ?? `${f.prefix}-${randomUUID().slice(0, 8)}-archive`;
  const listed = requireHttpSuccess(await f.request('salesOwner', 'get', `/api/v1/development/${encodeURIComponent(source.caseId)}/batches`), 'read current version before archive');
  const batch = listed.batches.find((item: any) => item.id === source.batchId);
  if (!batch) throw new Error('Archive source batch was not read back.');
  const body = { sourceType: options.type === 'garment' ? 'node' : 'batch', sourceId: options.type === 'garment' ? 'confirmation' : source.batchId,
    sourceRoundId: source.batchId, sourceVersionId: source.versionId, requestKey,
    expectedRevision: batch.attachments?.fabricHistory?.revision ?? 0, expectedRound: batch.round };
  const response = requireHttpSuccess(await f.request('salesOwner', 'post', `/api/v1/development/${encodeURIComponent(source.caseId)}/convert-to-asset`, body), 'archive exact QC-passed version');
  if (response.asset?.sourceSampleVersionId !== source.versionId || response.conversionReceipt?.sampleVersionId !== source.versionId
    || response.conversionReceipt?.requestKey !== requestKey) throw new Error('Archive did not return the exact version command receipt.');
  return { assetId: response.asset.id as string, asset: response.asset, conversionReceipt: response.conversionReceipt, command: body };
}

export async function createQcPassedFabricArchive(f: GlobalBusinessHttpFixture, options: Parameters<typeof createReturnedDevelopmentSample>[1] = {}) {
  const source = await createReturnedDevelopmentSample(f, { ...options, type: 'fabric' });
  const qc = await completeExactDevelopmentQc(f, source, { key: `${f.prefix}-${options.key ?? randomUUID().slice(0, 8)}-qc` });
  const archive = await convertExactDevelopmentArchive(f, source, { type: 'fabric' });
  return { ...source, ...qc, ...archive };
}

/** Deliberately separate from QC/archive: caller explicitly records the actual
 * demand-side selection through the native append-only HTTP producer. */
export async function recordExactDevelopmentConfirmation(f: GlobalBusinessHttpFixture,
  source: Pick<ReturnedDevelopmentSample, 'caseId' | 'batchId' | 'versionId'>, options: {
    key?: string; type?: 'customer' | 'internal'; result?: 'approved' | 'rejected' | 'needs_adjustment';
    confirmerName?: string; confirmedAt?: string; basis?: string;
  } = {}) {
  const type = options.type ?? 'customer';
  const command = { requestKey: options.key ?? `${f.prefix}-${randomUUID().slice(0, 8)}-actual-confirmation`,
    confirmerType: type, confirmerName: options.confirmerName ?? (type === 'customer' ? 'Isolated actual customer reviewer' : f.actors.actualRequester.name),
    ...(type === 'customer' ? { confirmerRelationId: f.customer.id, confirmerOrganization: f.customer.name }
      : { confirmerUserId: f.actors.actualRequester.id, confirmerOrganization: 'Isolated internal requester' }),
    confirmedAt: options.confirmedAt ?? String(Date.now() - 1), result: options.result ?? 'approved',
    basis: options.basis ?? `Synthetic written selection of exact version ${source.versionId}`,
    evidence: [`isolated-acceptance:${source.versionId}:actual-selection`], sampleBatchId: source.batchId };
  const response = requireHttpSuccess(await f.request('salesOwner', 'post',
    `/api/v1/development/${encodeURIComponent(source.caseId)}/sample-versions/${encodeURIComponent(source.versionId)}/confirmations`, command),
  'record exact actual requester selection', 201);
  if (response.item.sampleVersionId !== source.versionId || response.item.recordedBy !== f.actors.salesOwner.id
    || response.item.confirmerName !== command.confirmerName || response.item.confirmerType !== type)
    throw new Error('Actual requester confirmation did not preserve version/confirmer/recorder identity.');
  const read = requireHttpSuccess(await f.request('salesOwner', 'get',
    `/api/v1/development/${encodeURIComponent(source.caseId)}/version-confirmations?versionIds=${encodeURIComponent(source.versionId)}`), 'read exact requester choice');
  if (!read.items.some((item: { id: string }) => item.id === response.item.id)) throw new Error('Exact requester confirmation did not read back.');
  return { confirmation: response.item, confirmationCommand: command };
}
