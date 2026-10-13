/**
 * Real PostgreSQL acceptance for the customer-evidence-backed fabric-use grant.
 * The fixture starts with only an exclusive-owner product fact: it does not seed
 * an authorization request, customer confirmation, or active grant version.
 * All writes run inside the isolated acceptance database and private file root.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { deflateSync } from 'node:zlib';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createAuthService, type TokenPayload } from '../src/auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { getDatabaseSeedScopeListForRole, SYSTEM_ROLE_IDS, type SystemRoleId } from '../src/_shared/rolePermissionMatrix';
import { createCustomerConfirmationRouter } from '../src/customerConfirmations/customerConfirmationRoute';
import { createCustomerConfirmationTargetRegistry } from '../src/customerConfirmations/customerConfirmationService';
import { createFabricUseAuthorizationCustomerConfirmationAdapter, FABRIC_USE_ACTIONS,
  FABRIC_USE_AUTHORIZATION_TARGET } from '../src/products/fabricUseAuthorizationService';
import { createProductsRouter } from '../src/products/route';
import { serializeValue } from '../src/lib/serializeValue';

const prefix = `acceptance-fabric-auth-evidence-${randomUUID()}`;
const auth = createAuthService();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(typeName: string, data: Buffer): Buffer {
  const type = Buffer.from(typeName, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  type.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.length);
  return chunk;
}

function syntheticOnePixelPng(): Buffer {
  const color = createHash('sha256').update(prefix).digest();
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8; // 8-bit channels
  header[9] = 6; // RGBA
  const scanline = Buffer.from([0, color[0], color[1], color[2], 255]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(scanline)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const screenshot = syntheticOnePixelPng();
const screenshotSha256 = createHash('sha256').update(screenshot).digest('hex');
const productsRouterPath = '/api/v1/products';
const productPath = '/api/v1/products/assets';
const customerTargetPath = '/api/v1/customer-confirmations';

let prisma: PrismaClient | undefined;
let sequence = 0;
let privateRoot = '';
const seededUserIds: string[] = [];
const seededRelationIds: string[] = [];
const seededProductIds: string[] = [];
const seededRequestIds: string[] = [];
const seededRequestKeys: string[] = [];

type ActorFixture = { id: string; roleId: SystemRoleId; actor: TokenPayload; token: string };
type Fixture = { actor: ActorFixture; productId: string; ownerRelationId: string; granteeRelationId: string };

function db(): PrismaClient {
  if (!prisma) throw new Error('Reviewed isolated PostgreSQL required');
  return prisma;
}

const diagnostic = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);

async function seedCanonicalRolePermissions() {
  const roleIds = Object.values(SYSTEM_ROLE_IDS) as SystemRoleId[];
  for (const roleId of roleIds) {
    await db().role.upsert({ where: { id: roleId }, update: {},
      create: { id: roleId, name: `Synthetic canonical ${roleId}`, isSystem: true } });
  }
  const scopes = [...new Set(roleIds.flatMap(roleId => getDatabaseSeedScopeListForRole(roleId)))];
  await db().permission.createMany({
    data: scopes.map(scope => ({ id: `${prefix}-permission-${scope}`, scope })), skipDuplicates: true,
  });
  const permissions = await db().permission.findMany({ where: { scope: { in: scopes } }, select: { id: true, scope: true } });
  const permissionIds = new Map(permissions.map(permission => [permission.scope, permission.id]));
  await db().rolePermission.createMany({
    data: roleIds.flatMap(roleId => getDatabaseSeedScopeListForRole(roleId).map(scope => ({
      id: `${prefix}-role-grant-${roleId}-${scope}`, roleId, permissionId: permissionIds.get(scope)!,
    }))),
    skipDuplicates: true,
  });
}

async function makeActor(): Promise<ActorFixture> {
  const id = `${prefix}-actor-${++sequence}`;
  await db().userAccount.create({ data: { id, displayName: `Synthetic sales manager ${id}`, status: 'active' } });
  seededUserIds.push(id);
  await db().userRole.create({ data: { id: `${id}-role`, userId: id, roleId: SYSTEM_ROLE_IDS.SALES_MANAGER } });
  const loaded = await loadUserWithRoles(db(), id);
  if (!loaded) throw new Error(`Canonical SALES_MANAGER actor ${id} did not load`);
  const actor = await buildLoadedAuthTokenPayload(db(), loaded);
  expect(actor.roleIds).toContain(SYSTEM_ROLE_IDS.SALES_MANAGER);
  expect(actor.permissions).toContain('products:read');
  expect(actor.permissions).toContain('products:write');
  expect(await db().userPermissionOverrides.count({ where: { userId: id } })).toBe(0);
  return { id, roleId: SYSTEM_ROLE_IDS.SALES_MANAGER, actor, token: auth.signToken(actor) };
}

function application(): Express {
  const app = express();
  app.set('json replacer', (_key: string, value: unknown) => serializeValue(value));
  app.use(express.json());
  app.use(createAccountStatusGuard(db()));
  app.use('/api', createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
  app.use(productsRouterPath, createProductsRouter({ prisma: db(), requireAuth: true, apiKeys: new Set(), uploadDir: privateRoot }));
  const targets = createCustomerConfirmationTargetRegistry([
    createFabricUseAuthorizationCustomerConfirmationAdapter({ prisma: db() }),
  ]);
  app.use(customerTargetPath, createCustomerConfirmationRouter({ prisma: db(), targetAdapters: targets }));
  return app;
}

async function fixture(): Promise<Fixture> {
  const actor = await makeActor();
  const ownerRelationId = `${prefix}-owner-${++sequence}`;
  const granteeRelationId = `${prefix}-grantee-${++sequence}`;
  const ownerName = `${prefix} Synthetic owner A`;
  const granteeName = `${prefix} Synthetic authorized customer B`;
  await db().relation.createMany({ data: [
    { id: ownerRelationId, name: ownerName, category: 'customer', type: 'company', isOrganization: true,
      tags: [], contactInfo: '{}', lastInteraction: BigInt(Date.now()), ownerId: actor.id, salesRepIds: [actor.id] },
    { id: granteeRelationId, name: granteeName, category: 'customer', type: 'company', isOrganization: true,
      tags: [], contactInfo: '{}', lastInteraction: BigInt(Date.now()), ownerId: actor.id, salesRepIds: [actor.id] },
  ] });
  seededRelationIds.push(ownerRelationId, granteeRelationId);

  const productId = `${prefix}-fabric-${++sequence}`;
  seededProductIds.push(productId);
  await db().productAsset.create({ data: {
    id: productId, sku: `${productId}-sku`, name: `${productId} Synthetic Draft wool twill`, mainCategory: 'Fabric',
    subCategoryId: `${prefix}-fabric-category`, season: '2026AW', status: 'Draft', updatedAt: BigInt(Date.now()),
    fabricProfile: { create: { id: `${productId}-profile`, updatedAt: BigInt(Date.now()),
      articleNo: `${productId}-article`, millQuality: `${productId}-quality`,
      millColorCode: 'Navy', construction: 'twill', weightValue: 250, weightUnit: 'gsm' } },
  } });
  await db().fabricCustomerCode.create({ data: { id: `${productId}-exclusive-owner`, productAssetId: productId,
    customerOrganizationId: ownerRelationId, customerNameSnapshot: ownerName, clientCode: `${prefix}-owner-code`,
    isExclusive: true, updatedAt: BigInt(Date.now()) } });
  expect(await db().fabricUseAuthorizationRequest.count({ where: { productAssetId: productId } })).toBe(0);
  expect(await db().fabricUseAuthorizationVersion.count({ where: { productAssetId: productId } })).toBe(0);
  return { actor, productId, ownerRelationId, granteeRelationId };
}

function getCurrentTarget(app: Express, item: Fixture, targetId: string) {
  return request(app).get(`${customerTargetPath}/by-target/${FABRIC_USE_AUTHORIZATION_TARGET}/${encodeURIComponent(targetId)}`)
    .set('Authorization', `Bearer ${item.actor.token}`);
}

function customerCommand(target: any, targetId: string, idempotencyKey: string) {
  return {
    targetType: FABRIC_USE_AUTHORIZATION_TARGET,
    targetId,
    finalContentFingerprint: target.finalContentFingerprint,
    internalApprovalId: null,
    scopeFingerprint: target.scopeFingerprint,
    scope: target.scope,
    outcome: 'accepted',
    customerName: 'Synthetic A customer contact',
    confirmedAt: new Date().toISOString(),
    channel: 'screenshot',
    idempotencyKey,
  };
}

function postScreenshot(app: Express, actor: ActorFixture, command: ReturnType<typeof customerCommand>) {
  return request(app).post(customerTargetPath).set('Authorization', `Bearer ${actor.token}`)
    .field('command', JSON.stringify(command)).field('source', JSON.stringify({ kind: 'screenshot' }))
    .attach('file', screenshot, { filename: 'synthetic-owner-A-confirmation.png', contentType: 'image/png' });
}

async function confirmationCounts(targetId: string) {
  return {
    confirmations: await db().businessConfirmation.count({ where: { targetType: FABRIC_USE_AUTHORIZATION_TARGET, targetId } }),
    evidence: await db().customerEvidence.count({ where: { originTargetType: FABRIC_USE_AUTHORIZATION_TARGET, originTargetId: targetId } }),
    versions: await db().fabricUseAuthorizationVersion.count({ where: { requestId: targetId } }),
    files: await db().customerEvidenceFileLink.count({ where: { evidence: { originTargetType: FABRIC_USE_AUTHORIZATION_TARGET, originTargetId: targetId } } }),
    requestAudits: await db().auditLog.count({ where: { targetType: FABRIC_USE_AUTHORIZATION_TARGET, targetId } }),
  };
}

beforeAll(async () => {
  const { DATABASE_URL, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name,
    BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port, BAMBOOK_PRIVATE_FILES_DIR: privateFiles } = process.env;
  if (!DATABASE_URL || !sandbox || !name || !directory || !port || !privateFiles)
    throw new Error('Reviewed isolated PostgreSQL runner with private evidence storage is required');
  const url = new URL(DATABASE_URL);
  expect(url.protocol).toBe('postgresql:');
  expect(url.hostname).toBe('127.0.0.1');
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/);
  expect(url.pathname).toBe(`/${name}`);
  expect(url.port).toBe(port);
  const sandboxRoot = realpathSync(sandbox);
  expect(path.basename(sandboxRoot)).toMatch(/^bambook-acceptance-/);
  expect(realpathSync(directory)).toBe(path.join(sandboxRoot, 'postgres'));
  expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  privateRoot = path.resolve(privateFiles);
  mkdirSync(privateRoot, { recursive: true });
  expect(realpathSync(privateRoot)).toBe(path.join(sandboxRoot, 'private-files'));

  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const identity = await db().$queryRaw<Array<{ name: string; directory: string; port: number }>>`
    SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port
  `;
  expect(identity.map(row => ({ ...row, port: Number(row.port) })))
    .toEqual([{ name, directory, port: Number(port) }]);
  await seedCanonicalRolePermissions();
});

afterAll(async () => {
  if (!prisma) return;
  try {
    const requestRows = seededUserIds.length && seededRequestKeys.length
      ? await db().fabricUseAuthorizationRequest.findMany({ where: { recordedBy: { in: seededUserIds }, requestKey: { in: seededRequestKeys } }, select: { id: true } })
      : [];
    const ids = [...new Set([...seededRequestIds, ...requestRows.map(row => row.id)])];
    const [confirmations, versions, evidence] = await Promise.all([
      db().businessConfirmation.findMany({ where: { targetType: FABRIC_USE_AUTHORIZATION_TARGET, targetId: { in: ids } }, select: { id: true } }),
      db().fabricUseAuthorizationVersion.findMany({ where: { requestId: { in: ids } }, select: { id: true } }),
      db().customerEvidence.findMany({ where: { originTargetType: FABRIC_USE_AUTHORIZATION_TARGET, originTargetId: { in: ids } }, select: { id: true } }),
    ]);
    const confirmationIds = confirmations.map(row => row.id);
    const versionIds = versions.map(row => row.id);
    const evidenceIds = evidence.map(row => row.id);
    const linkedFiles = evidenceIds.length ? await db().customerEvidenceFileLink.findMany({
      where: { evidenceId: { in: evidenceIds } }, select: { fileId: true },
    }) : [];
    const fileIds = [...new Set(linkedFiles.map(row => row.fileId))];
    await db().businessConfirmationEvidence.deleteMany({ where: { OR: [
      ...(confirmationIds.length ? [{ confirmationId: { in: confirmationIds } }] : []),
      ...(evidenceIds.length ? [{ evidenceId: { in: evidenceIds } }] : []),
    ] } });
    await db().customerEvidenceFileLink.deleteMany({ where: { evidenceId: { in: evidenceIds } } });
    await db().fabricUseAuthorizationVersion.deleteMany({ where: { requestId: { in: ids } } });
    await db().customerEvidence.deleteMany({ where: { id: { in: evidenceIds } } });
    await db().businessConfirmation.deleteMany({ where: { id: { in: confirmationIds } } });
    await db().fabricUseAuthorizationRequest.deleteMany({ where: { id: { in: ids } } });
    for (const fileId of fileIds) {
      if (await db().customerEvidenceFileLink.count({ where: { fileId } }) > 0) continue;
      const file = await db().customerEvidenceFile.findUnique({ where: { id: fileId } });
      if (!file) continue;
      await db().customerEvidenceFile.delete({ where: { id: fileId } });
      const blob = path.resolve(privateRoot, file.storageKey);
      if (blob.startsWith(`${path.resolve(privateRoot)}${path.sep}`) && existsSync(blob)) rmSync(blob, { force: true });
    }
    await db().auditLog.deleteMany({ where: { OR: [
      ...(seededUserIds.length ? [{ actorId: { in: seededUserIds } }] : []),
      ...(ids.length ? [{ targetType: FABRIC_USE_AUTHORIZATION_TARGET, targetId: { in: ids } }] : []),
      ...(versionIds.length ? [{ targetType: 'FabricUseAuthorizationVersion', targetId: { in: versionIds } }] : []),
      ...(confirmationIds.length ? [{ targetType: 'BusinessConfirmation', targetId: { in: confirmationIds } }] : []),
    ] } });
    await db().fabricCustomerCode.deleteMany({ where: { productAssetId: { in: seededProductIds } } });
    await db().fabricProfile.deleteMany({ where: { productAssetId: { in: seededProductIds } } });
    await db().productAsset.deleteMany({ where: { id: { in: seededProductIds } } });
    await db().relation.deleteMany({ where: { id: { in: seededRelationIds } } });
    await db().notification.deleteMany({ where: { userId: { in: seededUserIds } } });
    await db().userRole.deleteMany({ where: { userId: { in: seededUserIds } } });
    await db().userAccount.deleteMany({ where: { id: { in: seededUserIds } } });
    await db().rolePermission.deleteMany({ where: { id: { startsWith: `${prefix}-role-grant-` } } });
    await db().permission.deleteMany({ where: { id: { startsWith: `${prefix}-permission-` } } });
  } finally {
    await prisma.$disconnect();
  }
});

describe.sequential('isolated real-PG customer-authorized fabric evidence', () => {
  it('creates an active grant only from owner A screenshot proof and safely replays the same confirmation key', async () => {
    const item = await fixture();
    const app = application();
    const requestKey = randomUUID();
    seededRequestKeys.push(requestKey);
    const grantInput = { granteeRelationId: item.granteeRelationId, operation: 'grant',
      allowedActions: [FABRIC_USE_ACTIONS.orderLineCreate], requestKey };
    const created = await request(app).post(`${productPath}/${item.productId}/fabric-use-authorizations`)
      .set('Authorization', `Bearer ${item.actor.token}`)
      .send(grantInput);
    expect(created.status, diagnostic(created.body)).toBe(201);
    expect(created.body.replayed).toBe(false);
    const targetId = String(created.body.confirmationTarget.targetId);
    expect(targetId).toMatch(/^FUA__/);
    seededRequestIds.push(targetId);
    expect(await db().fabricUseAuthorizationVersion.count({ where: { requestId: targetId } })).toBe(0);
    const requestReplay = await request(app).post(`${productPath}/${item.productId}/fabric-use-authorizations`)
      .set('Authorization', `Bearer ${item.actor.token}`).send(grantInput);
    expect(requestReplay.status, diagnostic(requestReplay.body)).toBe(200);
    expect(requestReplay.body.replayed).toBe(true);
    expect(requestReplay.body.confirmationTarget.targetId).toBe(targetId);
    expect(await db().fabricUseAuthorizationRequest.count({ where: { productAssetId: item.productId } })).toBe(1);
    expect(await db().auditLog.count({ where: { targetType: FABRIC_USE_AUTHORIZATION_TARGET, targetId,
      action: 'fabric_use_authorization_requested' } })).toBe(1);

    const targetRead = await getCurrentTarget(app, item, targetId);
    expect(targetRead.status, diagnostic(targetRead.body)).toBe(200);
    expect(targetRead.body.target).toMatchObject({ eligible: true, internalApprovalId: null,
      recommendation: { relationId: item.ownerRelationId } });
    const command = customerCommand(targetRead.body.target, targetId, randomUUID());
    const recorded = await postScreenshot(app, item.actor, command);
    expect(recorded.status, diagnostic(recorded.body)).toBe(201);
    expect(recorded.body.saved).toBe(true);
    // The native authorization version is committed by onRecordedInTx; this
    // adapter has no post-commit continuation to run.
    expect(recorded.body.continuationStatus).toBe('not_applicable');
    expect(recorded.body.effect).toMatchObject({ status: 'active', revision: 1 });

    const confirmation = await db().businessConfirmation.findFirstOrThrow({ where: {
      targetType: FABRIC_USE_AUTHORIZATION_TARGET, targetId,
    } });
    expect(confirmation).toMatchObject({ outcome: 'accepted', internalApprovalId: null,
      recordedBy: item.actor.id, channel: 'screenshot' });
    const confirmationAudit = await db().auditLog.findUniqueOrThrow({ where: { id: confirmation.auditId } });
    expect(confirmationAudit.action).toBe('business_customer_confirmation_recorded');
    expect(confirmationAudit.targetId).toBe(confirmation.id);
    expect(confirmationAudit.actorId).toBe(item.actor.id);

    const evidenceJoin = await db().businessConfirmationEvidence.findFirstOrThrow({
      where: { confirmationId: confirmation.id }, include: { evidence: { include: { files: { include: { file: true } } } } },
    });
    expect(evidenceJoin.evidence).toMatchObject({ sourceType: 'screenshot', originTargetType: FABRIC_USE_AUTHORIZATION_TARGET,
      originTargetId: targetId, originConfirmationId: confirmation.id });
    expect(evidenceJoin.evidence.files).toHaveLength(1);
    expect(evidenceJoin.evidence.files[0]).toMatchObject({ purpose: 'screenshot', mimeType: 'image/png' });
    expect(evidenceJoin.evidence.files[0].file).toMatchObject({ sha256: screenshotSha256, byteSize: screenshot.length,
      storageKey: `customer-confirmations/${screenshotSha256}` });

    const version = await db().fabricUseAuthorizationVersion.findUniqueOrThrow({ where: { confirmationId: confirmation.id } });
    expect(version).toMatchObject({ requestId: targetId, productAssetId: item.productId,
      ownerRelationId: item.ownerRelationId, granteeRelationId: item.granteeRelationId,
      state: 'active', revision: 1, confirmationId: confirmation.id });
    expect(version.allowedActions).toEqual([FABRIC_USE_ACTIONS.orderLineCreate]);
    const versionAudit = await db().auditLog.findUniqueOrThrow({ where: { id: version.auditId } });
    expect(versionAudit.action).toBe('fabric_use_authorization_accepted');
    expect(versionAudit.targetId).toBe(version.id);
    expect(versionAudit.actorId).toBe(item.actor.id);
    expect(await db().auditLog.count({ where: { targetType: FABRIC_USE_AUTHORIZATION_TARGET, targetId,
      action: 'fabric_use_authorization_requested' } })).toBe(1);

    const replay = await postScreenshot(app, item.actor, command);
    expect(replay.status, diagnostic(replay.body)).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.confirmation.id).toBe(confirmation.id);
    expect(await confirmationCounts(targetId)).toMatchObject({ confirmations: 1, evidence: 1, versions: 1, files: 1 });

    const history = await request(app).get(`${productPath}/${item.productId}/fabric-use-authorizations`)
      .set('Authorization', `Bearer ${item.actor.token}`);
    expect(history.status, diagnostic(history.body)).toBe(200);
    expect(history.body.ownerRelationId).toBe(item.ownerRelationId);
    expect(history.body.items).toHaveLength(1);
    expect(history.body.items[0]).toMatchObject({ requestId: targetId, status: 'active', ownerRelationId: item.ownerRelationId,
      granteeRelationId: item.granteeRelationId, currentVersionId: version.id });
    expect(history.body.activeGrants).toHaveLength(1);

    const readback = await getCurrentTarget(app, item, targetId);
    expect(readback.status, diagnostic(readback.body)).toBe(200);
    expect(readback.body.confirmations).toHaveLength(1);
    expect(readback.body.latest).toMatchObject({ id: confirmation.id, matchesCurrentVersion: true,
      evidence: [expect.objectContaining({ sourceType: 'screenshot', sourceAccessible: true })] });
    const fileId = evidenceJoin.evidence.files[0].file.id;
    const original = await request(app).get(`${customerTargetPath}/files/${encodeURIComponent(fileId)}`)
      .set('Authorization', `Bearer ${item.actor.token}`);
    expect(original.status, diagnostic(original.body)).toBe(200);
    expect(createHash('sha256').update(original.body).digest('hex')).toBe(screenshotSha256);
    expect(Buffer.from(original.body)).toEqual(screenshot);
  });

  it('rejects an old target fingerprint after product facts change without writing confirmation, evidence, version, or audit', async () => {
    const item = await fixture();
    const app = application();
    const requestKey = randomUUID();
    seededRequestKeys.push(requestKey);
    const created = await request(app).post(`${productPath}/${item.productId}/fabric-use-authorizations`)
      .set('Authorization', `Bearer ${item.actor.token}`)
      .send({ granteeRelationId: item.granteeRelationId, operation: 'grant',
        allowedActions: [FABRIC_USE_ACTIONS.orderLineCreate], requestKey });
    expect(created.status, diagnostic(created.body)).toBe(201);
    const targetId = String(created.body.confirmationTarget.targetId);
    seededRequestIds.push(targetId);

    const targetRead = await getCurrentTarget(app, item, targetId);
    expect(targetRead.status, diagnostic(targetRead.body)).toBe(200);
    const staleCommand = customerCommand(targetRead.body.target, targetId, randomUUID());
    const before = await confirmationCounts(targetId);
    expect(before).toMatchObject({ confirmations: 0, evidence: 0, versions: 0, files: 0, requestAudits: 1 });
    await db().productAsset.update({ where: { id: item.productId }, data: { name: `${prefix} changed product fact` } });

    const stale = await postScreenshot(app, item.actor, staleCommand);
    expect(stale.status, diagnostic(stale.body)).toBe(409);
    expect(stale.body.error?.code).toBe('VERSION_MISMATCH');
    expect(await confirmationCounts(targetId)).toEqual(before);
    expect(await db().businessConfirmation.count({ where: { targetType: FABRIC_USE_AUTHORIZATION_TARGET, targetId } })).toBe(0);
    expect(await db().customerEvidenceFileLink.count({ where: { evidence: { originTargetId: targetId } } })).toBe(0);
  });
});
