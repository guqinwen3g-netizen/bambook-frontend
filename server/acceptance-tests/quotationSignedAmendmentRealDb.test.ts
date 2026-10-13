/** Real PostgreSQL acceptance for quotation amendment, decision audit, and frozen signed-document readback. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createAuthService, type TokenPayload } from '../src/auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createAccountStatusGuard } from '../src/auth/accountStatusGuard';
import { getDatabaseSeedScopeListForRole, SYSTEM_ROLE_IDS, type SystemRoleId } from '../src/_shared/rolePermissionMatrix';
import { createApprovalRouter } from '../src/approvals/approvalRoute';
import { createQuotationRouter } from '../src/quotations/quotationRoute';
import { resolveDocumentSigner } from '../src/seal/documentSigner';
import { createSealService } from '../src/seal/sealService';
import { EXPORTER_PROFILE_CONFIG_ID } from '../src/config/systemConfigRoute';
import { serializeValue } from '../src/lib/serializeValue';

const prefix = `acceptance-quotation-sign-${randomUUID()}`;
const auth = createAuthService();
let prisma: PrismaClient | undefined;
let sequence = 0;
let uploadRoot = '';
let originalExporterConfig: any = null;
let originalUploadDir: string | undefined;
let originalPublicBaseUrl: string | undefined;
const seededUserIds: string[] = [];
const seededRelationIds: string[] = [];
const seededQuotationIds: string[] = [];
const seededApprovalIds: string[] = [];
const seededSealIds: string[] = [];
const imageFixtures = new Map<string, Buffer>();

const sourceImage = Buffer.from([0xff, 0xd8, 0xff, 0x11, 0x22, 0x33, 0xff, 0xd9]);
const changedImage = Buffer.from([0xff, 0xd8, 0xff, 0x44, 0x55, 0x66, 0xff, 0xd9]);
const sealImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nm4sAAAAASUVORK5CYII=';

function db(): PrismaClient {
  if (!prisma) throw Error('Reviewed isolated PostgreSQL required');
  return prisma;
}

const diagnostic = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
type ActorFixture = { id: string; roleId: SystemRoleId; actor: TokenPayload; token: string };

beforeAll(async () => {
  const { DATABASE_URL, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name,
    BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!DATABASE_URL || !sandbox || !name || !directory || !port)
    throw Error('Reviewed isolated PostgreSQL runner is required');
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

  uploadRoot = path.join(sandboxRoot, 'quotation-sign-uploads');
  mkdirSync(path.join(uploadRoot, 'quotations'), { recursive: true });
  originalUploadDir = process.env.BAMBOOK_UPLOAD_DIR;
  originalPublicBaseUrl = process.env.BAMBOOK_PUBLIC_BASE_URL;
  process.env.BAMBOOK_UPLOAD_DIR = uploadRoot;
  process.env.BAMBOOK_PUBLIC_BASE_URL = 'http://127.0.0.1:8081';

  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  expect(await db().$queryRaw`SELECT current_database() AS name,current_setting('data_directory') AS directory,inet_server_port() AS port`)
    .toEqual([{ name, directory, port: Number(port) }]);
  originalExporterConfig = await db().systemConfig.findUnique({ where: { id: EXPORTER_PROFILE_CONFIG_ID } });

  // Seed permissions with the production role-to-scope helper; reviewers and
  // requesters below receive only canonical membership, no user-level override.
  const roleIds = Object.values(SYSTEM_ROLE_IDS) as SystemRoleId[];
  for (const roleId of roleIds) {
    await db().role.upsert({ where: { id: roleId }, update: {},
      create: { id: roleId, name: `Synthetic canonical ${roleId}`, isSystem: true } });
  }
  const scopes = [...new Set(roleIds.flatMap(roleId => getDatabaseSeedScopeListForRole(roleId)))];
  await db().permission.createMany({ data: scopes.map(scope => ({ id: `${prefix}-permission-${scope}`, scope })), skipDuplicates: true });
  const permissions = await db().permission.findMany({ where: { scope: { in: scopes } }, select: { id: true, scope: true } });
  const permissionIds = new Map(permissions.map(permission => [permission.scope, permission.id]));
  await db().rolePermission.createMany({ data: roleIds.flatMap(roleId => getDatabaseSeedScopeListForRole(roleId).map(scope => ({
    id: `${prefix}-role-grant-${roleId}-${scope}`, roleId, permissionId: permissionIds.get(scope)!,
  }))), skipDuplicates: true });
});

async function actor(roleId: SystemRoleId, label: string): Promise<ActorFixture> {
  const id = `${prefix}-${++sequence}-${label}`;
  await db().userAccount.create({ data: { id, displayName: `Synthetic ${roleId} ${id}`, status: 'active' } });
  seededUserIds.push(id);
  await db().userRole.create({ data: { id: `${id}-membership`, userId: id, roleId } });
  const loaded = await loadUserWithRoles(db(), id);
  if (!loaded) throw Error(`Synthetic canonical actor ${id} did not load`);
  const current = await buildLoadedAuthTokenPayload(db(), loaded);
  expect(current.roleIds).toContain(roleId);
  expect(current.permissions).toEqual(expect.arrayContaining(getDatabaseSeedScopeListForRole(roleId)));
  expect(await db().userPermissionOverrides.count({ where: { userId: id } })).toBe(0);
  return { id, roleId, actor: current, token: auth.signToken(current) };
}

function application() {
  const app = express();
  app.use(express.json());
  app.set('json replacer', (_key: string, value: unknown) => serializeValue(value));
  app.use(createAccountStatusGuard(db()));
  app.use('/api', createAuthorizationSnapshotGuard({ prisma: db(), apiKeys: new Set() }));
  app.use('/api/v1/quotations', createQuotationRouter({ prisma: db(), requireAuth: true, apiKeys: new Set(), uploadDir: uploadRoot }));
  app.use('/api/v1/approvals', createApprovalRouter({ prisma: db(), requireAuth: true }));
  return app;
}

async function restoreExporterConfig() {
  if (!prisma) return;
  if (originalExporterConfig) {
    const { id: _id, ...data } = originalExporterConfig;
    await db().systemConfig.upsert({ where: { id: EXPORTER_PROFILE_CONFIG_ID }, create: originalExporterConfig, update: data });
  } else {
    await db().systemConfig.deleteMany({ where: { id: EXPORTER_PROFILE_CONFIG_ID } });
  }
}

async function setSyntheticExporterProfile(nameEn: string) {
  const previous = await db().systemConfig.findUnique({ where: { id: EXPORTER_PROFILE_CONFIG_ID } });
  const data = { scope: 'global', key: 'company.exporterProfile', group: 'company', label: 'Acceptance seller profile',
    valueType: 'json', value: { nameEn, addressEn: 'Acceptance-only address, Zhangjiagang, China' }, encrypted: false,
    version: (previous?.version ?? 0) + 1, updatedBy: null, auditReason: 'isolated document-signing acceptance fixture',
    updatedAt: BigInt(Date.now()) };
  await db().systemConfig.upsert({ where: { id: EXPORTER_PROFILE_CONFIG_ID }, create: { id: EXPORTER_PROFILE_CONFIG_ID, ...data }, update: data });
}

async function createQuotationFixture(app: express.Express, requester: ActorFixture, label: string) {
  // The approval router resolves its reviewer from canonical active role membership.
  // Keep this test's candidate synthetic so revocation never mutates a seeded account.
  await actor(SYSTEM_ROLE_IDS.ADMIN, `${label}-reviewer`);
  const customerId = `${prefix}-customer-${++sequence}-${label}`;
  seededRelationIds.push(customerId);
  await db().relation.create({ data: { id: customerId, name: `Synthetic ${label} customer`, category: 'customer',
    type: 'company', isOrganization: true, ownerId: requester.id, tags: [], contactInfo: '{}', lastInteraction: BigInt(Date.now()) } });

  const uploaded = await request(app).post('/api/v1/quotations/line-image')
    .set('Authorization', `Bearer ${requester.token}`)
    .attach('file', sourceImage, { filename: `synthetic-${label}.jpg`, contentType: 'image/jpeg' });
  expect(uploaded.status, diagnostic(uploaded.body)).toBe(201);
  const imageUrl = String(uploaded.body.url);
  const fileName = decodeURIComponent(imageUrl.split('/').pop() ?? '');
  const imagePath = path.join(uploadRoot, 'quotations', fileName);
  imageFixtures.set(imagePath, sourceImage);

  const created = await request(app).post('/api/v1/quotations')
    .set('Authorization', `Bearer ${requester.token}`)
    .send({ quotationNumber: `QT-${prefix}-${label}-${sequence}`, customerRelationId: customerId,
      customerName: `Synthetic ${label} customer`, currency: 'USD', issueDate: '2026-10-05',
      validUntil: '2099-12-31', deliveryTerms: 'FOB Shanghai', paymentTerms: 'T/T 30% deposit, balance before shipment',
      salesperson: 'Synthetic Salesperson', inquiryRef: `INQ-${label}`, notes: '初始报价备注',
      lines: [{ description: `Synthetic ${label} reviewed cotton`, quantity: 10000, unit: 'M', unitPrice: 2.5001,
        notes: '原始行备注', imageUrl }] });
  expect(created.status, diagnostic(created.body)).toBe(201);
  const quotation = created.body.quotation;
  seededQuotationIds.push(quotation.id);

  const submitted = await request(app).post(`/api/v1/quotations/${quotation.id}/request-total-approval`)
    .set('Authorization', `Bearer ${requester.token}`).send({});
  expect(submitted.status, diagnostic(submitted.body)).toBe(200);
  const approvalId = String(submitted.body.data.totalApprovalId ?? '');
  expect(approvalId).toMatch(/.+/);
  seededApprovalIds.push(approvalId);
  const approval = await db().approvalRequest.findUniqueOrThrow({ where: { id: approvalId } });
  expect(approval.status).toBe('pending');
  expect(approval.actionType).toBe('quotation:total_approve');
  expect(approval.targetType).toBe('Quotation');
  expect(approval.targetId).toBe(quotation.id);
  return { quotation, approval, lineId: quotation.lines[0].id, imagePath, imageUrl };
}

async function reviewerFor(approval: { reviewerId: string | null }): Promise<ActorFixture> {
  if (!approval.reviewerId) throw Error('Canonical approval routing did not assign a reviewer');
  if (!seededUserIds.includes(approval.reviewerId))
    throw Error(`Isolated approval routing selected non-fixture reviewer ${approval.reviewerId}`);
  const loaded = await loadUserWithRoles(db(), approval.reviewerId);
  if (!loaded) throw Error(`Routed reviewer ${approval.reviewerId} is unavailable`);
  const reviewer = await buildLoadedAuthTokenPayload(db(), loaded);
  expect(reviewer.roles?.some(role => ['admin', 'manager', 'owner'].includes(role))).toBe(true);
  return { id: approval.reviewerId, roleId: (reviewer.roleIds?.[0] ?? SYSTEM_ROLE_IDS.ADMIN) as SystemRoleId,
    actor: reviewer, token: auth.signToken(reviewer) };
}

async function readReview(app: express.Express, approvalId: string, reviewer: ActorFixture) {
  const response = await request(app).get(`/api/v1/approvals/${approvalId}/detail`)
    .set('Authorization', `Bearer ${reviewer.token}`);
  expect(response.status, diagnostic(response.body)).toBe(200);
  expect(response.body.detail.canApprove, diagnostic(response.body)).toBe(true);
  expect(response.body.detail.frozen.previewDigest).toMatch(/^[a-f0-9]{64}$/);
  return response.body.detail;
}

function proposal(lineId: string, unitPrice = '2.7501') {
  return { lineUnitPrices: [{ lineId, unitPrice }], notes: '按最终核价更新后的交货与付款备注',
    reason: '根据客户确认的最终采购数量重新核算单价及交货付款条款' };
}

async function previewAmendment(app: express.Express, approvalId: string, reviewer: ActorFixture,
  detail: any, amendment: ReturnType<typeof proposal>) {
  const response = await request(app).post(`/api/v1/approvals/${approvalId}/quotation-amendment/preview`)
    .set('Authorization', `Bearer ${reviewer.token}`)
    .send({ reviewContentVersion: detail.reviewContentVersion, amendment });
  expect(response.status, diagnostic(response.body)).toBe(200);
  expect(response.body.preview.finalContentVersion).toMatch(/^[a-f0-9]{64}$/);
  expect(response.body.preview.previewVersion).toMatch(/^[a-f0-9]{64}$/);
  return response.body.preview;
}

afterEach(async () => {
  if (!prisma) return;
  for (const [file, bytes] of imageFixtures) writeFileSync(file, bytes);
  imageFixtures.clear();
  await restoreExporterConfig();
});

afterAll(async () => {
  if (!prisma) return;
  try {
    const approvalAuditFilter = seededApprovalIds.length
      ? [{ targetType: 'ApprovalRequest', targetId: { in: seededApprovalIds } }] : [];
    const sealAuditFilter = seededSealIds.length ? [{ targetType: 'Seal', targetId: { in: seededSealIds } }] : [];
    await db().auditLog.deleteMany({ where: { OR: [
      ...(seededUserIds.length ? [{ actorId: { in: seededUserIds } }] : []), ...approvalAuditFilter, ...sealAuditFilter,
    ] } });
    await db().notification.deleteMany({ where: { userId: { in: seededUserIds } } });
    await db().approvalRequest.deleteMany({ where: { id: { in: seededApprovalIds } } });
    await db().quotationLine.deleteMany({ where: { quotationId: { in: seededQuotationIds } } });
    await db().quotationVersion.deleteMany({ where: { quotationId: { in: seededQuotationIds } } });
    await db().quotation.deleteMany({ where: { id: { in: seededQuotationIds } } });
    await db().relation.deleteMany({ where: { id: { in: seededRelationIds } } });
    await db().seal.deleteMany({ where: { id: { in: seededSealIds } } });
    await db().userRole.deleteMany({ where: { userId: { in: seededUserIds } } });
    await db().userAccount.deleteMany({ where: { id: { in: seededUserIds } } });
    await db().rolePermission.deleteMany({ where: { id: { startsWith: `${prefix}-role-grant-` } } });
    await db().permission.deleteMany({ where: { id: { startsWith: `${prefix}-permission-` } } });
    await restoreExporterConfig();
  } finally {
    if (originalUploadDir === undefined) delete process.env.BAMBOOK_UPLOAD_DIR;
    else process.env.BAMBOOK_UPLOAD_DIR = originalUploadDir;
    if (originalPublicBaseUrl === undefined) delete process.env.BAMBOOK_PUBLIC_BASE_URL;
    else process.env.BAMBOOK_PUBLIC_BASE_URL = originalPublicBaseUrl;
    if (uploadRoot) rmSync(uploadRoot, { recursive: true, force: true });
    await prisma.$disconnect();
  }
});

describe.sequential('isolated real-PG quotation signed amendment', () => {
  it('approves a reviewed final amendment atomically and reads that exact frozen document with the actual signer', async () => {
    await setSyntheticExporterProfile('Acceptance Seller Original');
    const app = application();
    const requester = await actor(SYSTEM_ROLE_IDS.SALES_MANAGER, 'amendment-requester');
    const fixture = await createQuotationFixture(app, requester, 'amendment');
    const reviewer = await reviewerFor(fixture.approval);
    const seal = await createSealService(db()).createSeal({ name: 'Acceptance reviewer seal', type: 'company_seal',
      ownerUserId: reviewer.id, imageDataUrl: sealImage }, reviewer.id);
    seededSealIds.push(seal.id);

    const detail = await readReview(app, fixture.approval.id, reviewer);
    const amendment = proposal(fixture.lineId);
    const preview = await previewAmendment(app, fixture.approval.id, reviewer, detail, amendment);
    expect(preview.diff).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: expect.stringContaining('unitPrice'), before: '2.5001', after: '2.7501' }),
      expect.objectContaining({ field: 'notes', after: amendment.notes }),
    ]));

    const beforeMissingDigest = await db().quotation.findUniqueOrThrow({ where: { id: fixture.quotation.id }, include: { lines: true } });
    const beforeMissingDigestVersionCount = await db().quotationVersion.count({ where: { quotationId: fixture.quotation.id } });
    const beforeMissingDigestAuditCount = await db().auditLog.count({ where: { targetType: 'ApprovalRequest', targetId: fixture.approval.id } });
    const missingDigest = await request(app).post(`/api/v1/approvals/${fixture.approval.id}/quotation-amendment/confirm`)
      .set('Authorization', `Bearer ${reviewer.token}`)
      .send({ reviewContentVersion: detail.reviewContentVersion, confirmedReviewedContent: true,
        amendment: { ...amendment, previewVersion: preview.previewVersion, finalContentVersion: preview.finalContentVersion } });
    expect(missingDigest.status, diagnostic(missingDigest.body)).toBe(409);
    expect((await db().approvalRequest.findUniqueOrThrow({ where: { id: fixture.approval.id } })).status).toBe('pending');
    const afterMissingDigest = await db().quotation.findUniqueOrThrow({ where: { id: fixture.quotation.id }, include: { lines: true } });
    expect(afterMissingDigest.version).toBe(beforeMissingDigest.version);
    expect(String(afterMissingDigest.totalAmount)).toBe(String(beforeMissingDigest.totalAmount));
    expect(String(afterMissingDigest.lines[0].unitPrice)).toBe(String(beforeMissingDigest.lines[0].unitPrice));
    expect(await db().quotationVersion.count({ where: { quotationId: fixture.quotation.id } })).toBe(beforeMissingDigestVersionCount);
    expect(await db().auditLog.count({ where: { targetType: 'ApprovalRequest', targetId: fixture.approval.id } }))
      .toBe(beforeMissingDigestAuditCount);

    const confirmed = await request(app).post(`/api/v1/approvals/${fixture.approval.id}/quotation-amendment/confirm`)
      .set('Authorization', `Bearer ${reviewer.token}`)
      .send({ reviewContentVersion: detail.reviewContentVersion,
        // This binds the frozen request and the final amendment preview in the same decision.
        reviewPreviewDigest: detail.frozen.previewDigest,
        confirmedReviewedContent: true,
        amendment: { ...amendment, previewVersion: preview.previewVersion, finalContentVersion: preview.finalContentVersion } });
    expect(confirmed.status, diagnostic(confirmed.body)).toBe(200);
    expect(confirmed.body.item.status).toBe('approved');
    expect(confirmed.body.amendment.finalContentVersion).toBe(preview.finalContentVersion);

    const approval = await db().approvalRequest.findUniqueOrThrow({ where: { id: fixture.approval.id } });
    const quote = await db().quotation.findUniqueOrThrow({ where: { id: fixture.quotation.id }, include: { lines: true } });
    expect(quote.version).toBe(preview.finalVersion);
    expect(String(quote.lines[0].unitPrice)).toBe('2.7501');
    expect(String(quote.lines[0].amount)).toBe('27501');
    expect(String(quote.totalAmount)).toBe('27501');
    expect(approval.status).toBe('approved');

    const audits = await db().auditLog.findMany({ where: { targetType: 'ApprovalRequest', targetId: approval.id } });
    const decisionAudit = audits.find((row: any) => row.action === 'approve_business_request'
      && (row.detail as any)?.approvalDecisionFact?.schemaVersion === 1);
    expect(decisionAudit, diagnostic(audits)).toBeTruthy();
    expect(decisionAudit!.actorId).toBe(reviewer.id);
    const fact = (decisionAudit!.detail as any).approvalDecisionFact;
    expect(fact.reviewedContentConfirmed).toBe(true);
    expect(fact.reviewContentVersion).toBe(detail.reviewContentVersion);
    expect(fact.reviewPreviewDigest).toBe(detail.frozen.previewDigest);
    expect(fact.finalContentVersion).toBe(preview.finalContentVersion);
    expect(fact.quotationAmendmentAuditId).toBeTruthy();

    const amendmentAudit = await db().auditLog.findUniqueOrThrow({ where: { id: fact.quotationAmendmentAuditId } });
    expect(amendmentAudit.action).toBe('quotation_approval_amended');
    expect(amendmentAudit.actorId).toBe(reviewer.id);
    const amendmentFact = amendmentAudit.detail as any;
    expect(amendmentFact.finalContentVersion).toBe(preview.finalContentVersion);
    expect(amendmentFact.finalVersion).toBe(quote.version);
    expect(amendmentFact.finalDocumentSnapshot.data.qt.totalAmount).toBe(27501);
    expect(amendmentFact.finalDocumentSnapshot.data.lines[0].unitPrice).toBe(2.7501);
    expect(amendmentFact.finalDocumentSnapshot.data.lines[0].imageUrl).toBe(`data:image/jpeg;base64,${sourceImage.toString('base64')}`);
    expect(fact.documentSnapshot.contentFingerprint).toBe(amendmentFact.finalDocumentSnapshot.contentFingerprint);

    const signer = await resolveDocumentSigner(db(), { targetType: 'Quotation', targetId: fixture.quotation.id });
    expect(signer?.userId).toBe(reviewer.id);
    expect(signer?.documentSnapshot?.contentFingerprint).toBe(amendmentFact.finalDocumentSnapshot.contentFingerprint);
    expect(signer?.quotationData?.lines[0].unitPrice).toBe(2.7501);

    const signedDocument = await request(app).get(`/api/v1/quotations/${fixture.quotation.id}/preview.html`)
      .set('Authorization', `Bearer ${reviewer.token}`);
    expect(signedDocument.status, diagnostic(signedDocument.body)).toBe(200);
    expect(signedDocument.headers['content-type']).toContain('text/html');
    expect(signedDocument.text).toContain('Acceptance Seller Original');
    expect(signedDocument.text).toContain('按最终核价更新后的交货与付款备注');
    expect(signedDocument.text).toContain('2.7501');
    expect(signedDocument.text).toContain('27,501.00 USD');
    expect(signedDocument.text).toContain(`data:image/jpeg;base64,${sourceImage.toString('base64')}`);
    expect(signedDocument.text).toContain('class="doc-stamp"');

    // Same URL and filename, different private bytes: no previously approved stamp may survive.
    writeFileSync(fixture.imagePath, changedImage);
    expect(await resolveDocumentSigner(db(), { targetType: 'Quotation', targetId: fixture.quotation.id })).toBeNull();
    const changedImageDocument = await request(app).get(`/api/v1/quotations/${fixture.quotation.id}/preview.html`)
      .set('Authorization', `Bearer ${reviewer.token}`);
    expect(changedImageDocument.status).toBe(200);
    expect(changedImageDocument.text).toContain(`data:image/jpeg;base64,${changedImage.toString('base64')}`);
    expect(changedImageDocument.text).not.toContain('class="doc-stamp"');
    writeFileSync(fixture.imagePath, sourceImage);
    expect((await resolveDocumentSigner(db(), { targetType: 'Quotation', targetId: fixture.quotation.id }))?.userId).toBe(reviewer.id);

    // A seller profile version/value change also makes the old reviewed document ineligible for a stamp.
    await setSyntheticExporterProfile('Acceptance Seller Changed');
    expect(await resolveDocumentSigner(db(), { targetType: 'Quotation', targetId: fixture.quotation.id })).toBeNull();
    const changedSellerDocument = await request(app).get(`/api/v1/quotations/${fixture.quotation.id}/preview.html`)
      .set('Authorization', `Bearer ${reviewer.token}`);
    expect(changedSellerDocument.status).toBe(200);
    expect(changedSellerDocument.text).toContain('Acceptance Seller Changed');
    expect(changedSellerDocument.text).not.toContain('class="doc-stamp"');
  });

  it('blocks a previously issued reviewer JWT after role withdrawal and commits no amendment, decision, or audit writes', async () => {
    await setSyntheticExporterProfile('Acceptance Seller Revocation');
    const app = application();
    const requester = await actor(SYSTEM_ROLE_IDS.SALES_MANAGER, 'revocation-requester');
    const fixture = await createQuotationFixture(app, requester, 'revocation');
    const reviewer = await reviewerFor(fixture.approval);
    const detail = await readReview(app, fixture.approval.id, reviewer);
    const amendment = proposal(fixture.lineId, '2.6001');
    const preview = await previewAmendment(app, fixture.approval.id, reviewer, detail, amendment);
    const beforeQuote = await db().quotation.findUniqueOrThrow({ where: { id: fixture.quotation.id }, include: { lines: true } });
    const beforeVersionCount = await db().quotationVersion.count({ where: { quotationId: fixture.quotation.id } });
    const beforeApprovalAuditCount = await db().auditLog.count({ where: { targetType: 'ApprovalRequest', targetId: fixture.approval.id } });
    const beforeDecisionCount = await db().auditLog.count({ where: { targetType: 'ApprovalRequest', targetId: fixture.approval.id,
      action: { in: ['approve_business_request', 'reject_business_request'] } } });

    await db().userRole.deleteMany({ where: { userId: reviewer.id } });
    const denied = await request(app).post(`/api/v1/approvals/${fixture.approval.id}/quotation-amendment/confirm`)
      .set('Authorization', `Bearer ${reviewer.token}`)
      .send({ reviewContentVersion: detail.reviewContentVersion, reviewPreviewDigest: detail.frozen.previewDigest,
        confirmedReviewedContent: true,
        amendment: { ...amendment, previewVersion: preview.previewVersion, finalContentVersion: preview.finalContentVersion } });
    expect(denied.status, diagnostic(denied.body)).toBe(403);

    const afterQuote = await db().quotation.findUniqueOrThrow({ where: { id: fixture.quotation.id }, include: { lines: true } });
    const afterApproval = await db().approvalRequest.findUniqueOrThrow({ where: { id: fixture.approval.id } });
    expect(afterApproval.status).toBe('pending');
    expect(afterQuote.version).toBe(beforeQuote.version);
    expect(String(afterQuote.totalAmount)).toBe(String(beforeQuote.totalAmount));
    expect(String(afterQuote.lines[0].unitPrice)).toBe(String(beforeQuote.lines[0].unitPrice));
    expect(await db().quotationVersion.count({ where: { quotationId: fixture.quotation.id } })).toBe(beforeVersionCount);
    expect(await db().auditLog.count({ where: { targetType: 'ApprovalRequest', targetId: fixture.approval.id } })).toBe(beforeApprovalAuditCount);
    expect(await db().auditLog.count({ where: { targetType: 'ApprovalRequest', targetId: fixture.approval.id,
      action: { in: ['approve_business_request', 'reject_business_request'] } } })).toBe(beforeDecisionCount);
  });
});
