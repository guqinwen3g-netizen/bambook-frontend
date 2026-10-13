import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Response } from 'express';
import supertest from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createAuthService } from '../src/auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { assertIsolatedAcceptanceDatabase } from './isolatedDatabase';
import { businessNowMs } from '../src/shared/businessClock';
import { convertExactDevelopmentArchive, createGlobalBusinessHttpFixture, createReturnedDevelopmentSample, requireHttpSuccess,
  type BusinessFixtureActor, type GlobalBusinessHttpFixture } from './globalBusinessFixtures';

const prisma = new PrismaClient({ datasources: { db: { url: process.env.BAMBOOK_ACCEPTANCE_DATABASE_URL
  ?? 'postgresql://acceptance_disabled:disabled@127.0.0.1:1/acceptance_disabled' } } });
let f: GlobalBusinessHttpFixture, loseHandoffAck: string | null = null, loseFileAck: string | null = null;
const enc = encodeURIComponent, root = (id: string) => `/api/v1/qc/development-sample-reviews/${enc(id)}`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYZkAAAAASUVORK5CYII=', 'base64');
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const ok = requireHttpSuccess;
beforeAll(async () => {
  await assertIsolatedAcceptanceDatabase(prisma);
  f = await createGlobalBusinessHttpFixture(prisma, { prefix: 'development-qc-handoff-native' });
  // Simulate only transport ACK loss after the genuine service transaction
  // returned. Do not throw out of Prisma after commit or fabricate any fact.
  const originalJson = f.app.response.json;
  f.app.response.json = function (this: Response, body: unknown) {
    const data = isRecord(body) && isRecord(body.data) ? body.data : null;
    const receipt = data && isRecord(data.receipt) ? data.receipt : null;
    if (loseHandoffAck && receipt?.requestKey === loseHandoffAck || loseFileAck && data?.requestKey === loseFileAck && data.file) {
      if (receipt?.requestKey === loseHandoffAck) loseHandoffAck = null;
      if (data?.requestKey === loseFileAck) loseFileAck = null;
      this.status(500); return Reflect.apply(originalJson, this, [{ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Acceptance transport dropped the committed ACK' } }]);
    }
    return Reflect.apply(originalJson, this, [body]);
  };
}, 60000);
afterAll(async () => { await f?.close(); await prisma.$disconnect(); });

async function requestReview(key: string) {
  const source = await createReturnedDevelopmentSample(f, { key, lengthMeters: '4.25' });
  const review = ok(await f.request('salesOwner', 'post', `/api/v1/development/${enc(source.caseId)}/batches/${enc(source.batchId)}/qc-review`,
    { requestKey: `${f.prefix}-${key}-request`, sampleVersionId: source.versionId }), 'business requests exact native QC', 201).item;
  expect(review).toMatchObject({ sampleVersionId: source.versionId, status: 'queued', startedBy: null });
  return { source, review };
}
async function context(id: string, actor: 'qc' | 'qcOutsider' = 'qc') {
  return ok(await f.request(actor, 'get', `${root(id)}/handoff-context`), 'read current exact native handoff').data;
}
const command = (value: any, reason: string) => ({ requestKey: randomUUID(), expectedStartedBy: value.item.startedBy ?? null,
  expectedUpdatedAt: value.expectedUpdatedAt, sourceFingerprint: value.item.sourceFingerprint, reason });
function upload(id: string, actor: BusinessFixtureActor, requestKey: string, fingerprint: string, bytes = png, filename = '真实现场.png') {
  return supertest(f.app).post(`${root(id)}/evidence`).set('Authorization', `Bearer ${actor.token}`)
    .field('requestKey', requestKey).field('sourceFingerprint', fingerprint).attach('file', bytes, { filename });
}
const completion = (key: string, ids: string[] = []) => ({ requestKey: key, result: 'pass', opinion: '实际接手 QC 核验本准确版本及原实物，通过并提交现场图片与完整意见',
  inspectionDate: new Date().toISOString().slice(0, 10), inspectorOrg: 'Bambook QC', criticalDefects: 0, majorDefects: 0, minorDefects: 0, evidenceFileIds: ids });

describe('Native development QC actual inspectors, handoffs and private report bytes', () => {
  it('persists business event times independently of original wall-clock receipt/audit proof through the full native QC handoff', async () => {
    // Ordinary isolated acceptance keeps its existing clock guards. A fixed
    // dev-clock proof is collected separately by the private full rehearsal.
    const wallStart = Date.now(), businessStart = businessNowMs();
    const { source, review } = await requestReview('business-event-clock');
    const initial = await context(review.id), claimInput = command(initial, '实际到厂认领，业务发生时间与系统登记时间分别留存');
    const claimed = ok(await f.request('qc', 'post', `${root(review.id)}/claim`, claimInput), 'claim current real task with separate event time').data;
    const transferInput = { ...command(await context(review.id), '由实际同厂接手人员继续检验'), toUserId: f.actors.qcOutsider.id };
    const transferred = ok(await f.request('qc', 'post', `${root(review.id)}/transfer`, transferInput), 'transfer current real task with separate event time').data;
    expect(ok(await f.request('qc', 'post', `${root(review.id)}/claim`, claimInput), 'recover original claim without re-dating history').data).toEqual({ ...claimed, replayed: true });
    const input = { ...completion(randomUUID()), inspectionDate: '2026-09-30' };
    const completed = ok(await f.request('qcOutsider', 'post', `${root(review.id)}/complete`, input), 'record actual report without replacing its explicit historical inspection date').item;
    expect(completed).toMatchObject({ id: review.id, inspectionDate: '2026-09-30', reviewedBy: f.actors.qcOutsider.id });
    const ackInput = { requestKey: randomUUID() };
    const acknowledged = ok(await f.request('salesOwner', 'post', `/api/v1/development/${enc(source.caseId)}/qc-reviews/${enc(review.id)}/acknowledge`, ackInput), 'source business reads the exact native report').item;
    expect(ok(await f.request('salesOwner', 'post', `/api/v1/development/${enc(source.caseId)}/qc-reviews/${enc(review.id)}/acknowledge`, ackInput), 'recover original business acknowledgment without re-dating it').item).toEqual(acknowledged);
    const readback = ok(await f.request('salesOwner', 'get', `/api/v1/development/${enc(source.caseId)}/batches`), 'read all actual business events from source').batches.find((row: { id: string }) => row.id === source.batchId);
    expect(readback).toMatchObject({ id: source.batchId, latestFormalQcReview: { id: review.id, status: 'acknowledged', inspectionDate: '2026-09-30' } });
    const library = ok(await f.request('salesOwner', 'get', `/api/v1/samples/room/items?devCaseId=${enc(source.caseId)}`), 'verify original physical receipt with independent recorded time').items;
    const card = await prisma.sampleCardItem.findUniqueOrThrow({ where: { id: source.physicalCardIds[0] } });
    const receipt = card.receiptSnapshot;
    if (!isRecord(receipt)) throw Error('Native development return did not persist its original receipt.');
    expect(library.find((row: { id: string }) => row.id === card.id)).toMatchObject({ id: card.id, receiptStatus: 'verified',
      receiptSnapshot: { receivedAt: receipt.receivedAt, recordedAt: String(card.createdAt) } });
    const stored = await prisma.developmentSampleQualityReview.findUniqueOrThrow({ where: { id: review.id } });
    const audits = await prisma.auditLog.findMany({ where: { targetId: { in: [review.id, card.id, source.batchId] }, action: { in: [
      'sample_card_create', 'record_development_sample_return', 'request_development_sample_qc', 'development_qc_handoff', 'complete_development_sample_qc', 'acknowledge_development_sample_qc',
    ] } } });
    const businessEnd = businessNowMs(), wallEnd = Date.now();
    for (const value of [readback.returnedAt, stored.requestedAt, stored.startedAt, stored.reviewedAt, stored.acknowledgedAt, receipt.receivedAt, claimed.receipt.occurredAt, transferred.receipt.occurredAt]) {
      expect(Number.isSafeInteger(Number(value))).toBe(true); expect(Number(value)).toBeGreaterThanOrEqual(businessStart); expect(Number(value)).toBeLessThanOrEqual(businessEnd);
    }
    expect(receipt.recordedAt).toBe(String(card.createdAt));
    for (const value of [card.createdAt, card.updatedAt, stored.createdAt, stored.updatedAt, ...audits.map(audit => audit.createdAt.getTime())]) {
      expect(Number(value)).toBeGreaterThanOrEqual(wallStart); expect(Number(value)).toBeLessThanOrEqual(wallEnd);
    }
    expect(Number(transferred.item.updatedAt)).toBeGreaterThan(Number(claimed.item.updatedAt));
    expect(audits.filter(row => row.action === 'development_qc_handoff')).toHaveLength(2);
    const completionAudit = audits.find(row => row.action === 'complete_development_sample_qc');
    if (!isRecord(completionAudit?.detail) || !isRecord(completionAudit.detail.after)) throw Error('Native report completion audit is missing.');
    expect(completionAudit.detail.after.reviewedAt).toBe(String(stored.reviewedAt));
  }, 180000);

  it('recovers committed claim/upload ACKs, transfers to another actual QC and returns the exact report/files to source business', async () => {
    const { source, review } = await requestReview('actual-execution'), initial = await context(review.id), claim = command(initial, '实际到厂 QC 认领该准确版本');
    expect(initial).toMatchObject({ canClaim: true, canExecute: false, currentExecutor: null });
    expect(initial.users.map((row: { id: string }) => row.id)).toContain(f.actors.qcOutsider.id); // Canonical professional all-company scope is legitimate.
    loseHandoffAck = claim.requestKey;
    expect((await f.request('qc', 'post', `${root(review.id)}/claim`, claim)).status).toBe(500);
    expect((await prisma.developmentSampleQualityReview.findUniqueOrThrow({ where: { id: review.id } })).startedBy).toBe(f.actors.qc.id);
    const [one, two] = await Promise.all([f.request('qc', 'post', `${root(review.id)}/claim`, claim), f.request('qc', 'post', `${root(review.id)}/claim`, claim)]);
    const original = ok(one, 'recover original committed claim').data;
    expect(ok(two, 'concurrent original claim readback').data).toEqual(original); expect(original.replayed).toBe(true);
    expect(original.receipt).toMatchObject({ reviewId: review.id, actorId: f.actors.qc.id, sampleVersionId: source.versionId, requestKey: claim.requestKey });
    expect(await prisma.auditLog.count({ where: { action: 'development_qc_handoff', targetId: review.id } })).toBe(1);
    expect((await f.request('qc', 'post', `${root(review.id)}/claim`, { ...claim, reason: '不同内容' })).status).toBe(409);
    expect((await f.request('qcOutsider', 'post', `${root(review.id)}/start`, {})).status).toBe(403);
    expect((await f.request('qcOutsider', 'post', `${root(review.id)}/complete`, completion(randomUUID()))).status).toBe(403);
    const uploadKey = randomUUID(); loseFileAck = uploadKey;
    expect((await upload(review.id, f.actors.qc, uploadKey, review.sourceFingerprint)).status).toBe(500);
    const uploaded = ok(await upload(review.id, f.actors.qc, uploadKey, review.sourceFingerprint), 'recover original committed actual file').data;
    expect(uploaded.replayed).toBe(true);
    expect(uploaded.file).toMatchObject({ sourceId: review.id, sourceFingerprint: review.sourceFingerprint, sourceKind: 'development_review',
      uploadedBy: f.actors.qc.id, sha256: createHash('sha256').update(png).digest('hex'), size: png.length });
    expect(await prisma.auditLog.count({ where: { action: 'upload_qc_evidence', targetId: review.id } })).toBe(1);
    expect((await upload(review.id, f.actors.qc, randomUUID(), review.sourceFingerprint, png, '伪装.pdf')).status).toBe(400);
    const started = await context(review.id), transfer = { ...command(started, '由实际同厂接手 QC 完成检验'), toUserId: f.actors.qcOutsider.id };
    const handed = ok(await f.request('qc', 'post', `${root(review.id)}/transfer`, transfer), 'formally hand to actual second QC').data;
    expect(handed.receipt).toMatchObject({ fromUserId: f.actors.qc.id, toUserId: f.actors.qcOutsider.id, sampleVersionId: source.versionId });
    expect((await context(review.id, 'qcOutsider')).canExecute).toBe(true);
    expect((await context(review.id)).canExecute).toBe(false);
    expect(ok(await upload(review.id, f.actors.qc, uploadKey, review.sourceFingerprint), 'original uploader reads old upload ACK after transfer').data.file.id).toBe(uploaded.file.id);
    expect((await upload(review.id, f.actors.qc, randomUUID(), review.sourceFingerprint)).status).toBe(403);
    const other = await requestReview('foreign-evidence'), otherContext = await context(other.review.id, 'qcOutsider');
    ok(await f.request('qcOutsider', 'post', `${root(other.review.id)}/claim`, command(otherContext, '实际认领另一准确版本')), 'claim other real task');
    const foreign = ok(await upload(other.review.id, f.actors.qcOutsider, randomUUID(), other.review.sourceFingerprint), 'upload real file to the other exact task').data.file;
    expect((await f.request('qcOutsider', 'post', `${root(review.id)}/complete`, completion(randomUUID(), [foreign.id]))).status).toBe(400);
    const input = completion(randomUUID(), [uploaded.file.id]);
    const report = ok(await f.request('qcOutsider', 'post', `${root(review.id)}/complete`, input), 'current actual inspector completes exact report').item;
    expect(report).toMatchObject({ id: review.id, status: 'reviewed', startedBy: f.actors.qcOutsider.id, reviewedBy: f.actors.qcOutsider.id,
      sampleVersionId: source.versionId, evidence: [{ id: uploaded.file.id, uploadedBy: f.actors.qc.id }] });
    expect(ok(await f.request('qcOutsider', 'post', `${root(review.id)}/complete`, input), 'replay exact completed report').item).toEqual(report);
    const readback = ok(await f.request('salesOwner', 'get', `/api/v1/development/${enc(source.caseId)}/batches`), 'source business reads actual report').batches[0].latestFormalQcReview;
    expect(readback).toMatchObject({ id: review.id, reviewedBy: f.actors.qcOutsider.id, result: 'pass', evidence: [{ id: uploaded.file.id }] });
    const fileResponse = await f.request('salesOwner', 'get', `${root(review.id)}/evidence/${enc(uploaded.file.id)}`);
    expect(fileResponse.status).toBe(200); expect(fileResponse.headers['content-type']).toContain('image/png'); expect(Buffer.from(fileResponse.body)).toEqual(png);
    expect((await f.request('salesOwner', 'get', `${root(other.review.id)}/evidence/${enc(uploaded.file.id)}`)).status).toBe(404);
    expect((await f.request('salesOutsider', 'get', `${root(review.id)}/handoff-context`)).status).toBe(404);
    expect(await prisma.notification.count({ where: { userId: f.actors.salesOwner.id, type: 'development_sample_qc_report', metadata: { path: ['reviewId'], equals: review.id } } })).toBe(1);
    expect(await prisma.developmentVersionConfirmation.count({ where: { sampleVersionId: source.versionId } })).toBe(0);
    const asset = await convertExactDevelopmentArchive(f, source, { key: `${f.prefix}-report-archive` }); expect(asset.assetId).toBeTruthy();
    const businessContext = ok(await f.request('salesOwner', 'get', `${root(review.id)}/handoff-context`), 'business reads immutable execution history').data;
    expect(businessContext.history.map((row: { operation: string }) => row.operation)).toEqual(['claim', 'transfer', 'complete']);
    expect(businessContext).toMatchObject({ canExecute: false, users: [], files: [{ id: uploaded.file.id }] });
    const uploadAudit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'upload_qc_evidence', targetId: review.id } });
    const detail = uploadAudit.detail as { after: { relativePath: string } };
    await fs.writeFile(path.join(process.env.BAMBOOK_ACCEPTANCE_SANDBOX!, `${f.prefix}-private-files`, detail.after.relativePath), Buffer.from('fault-injected tampered original'));
    expect((await f.request('salesOwner', 'get', `${root(review.id)}/evidence/${enc(uploaded.file.id)}`)).status).toBe(409);
  }, 180000);

  it('uses current professional scopes, ceiling, concurrent ownership and account status; GET never repairs facts', async () => {
    const { review } = await requestReview('fresh-authority'), initial = await context(review.id), claim = command(initial, '按实际到厂安排认领');
    const currentQc = await buildLoadedAuthTokenPayload(prisma, (await loadUserWithRoles(prisma, f.actors.qc.id))!);
    const limited = { ...f.actors.qc, token: createAuthService().signToken({ ...currentQc, permissionCeiling: ['qc:read'] }) };
    expect((await f.request(limited, 'post', `${root(review.id)}/claim`, claim)).status).toBe(403);
    expect((await f.request('salesOwner', 'post', `${root(review.id)}/claim`, claim)).status).toBe(403);
    expect((await f.request('admin', 'post', `${root(review.id)}/claim`, claim)).status).toBe(403);
    const competing = { ...claim, requestKey: randomUUID(), reason: '另一实际 QC 同时认领' };
    const [a, b] = await Promise.all([f.request('qc', 'post', `${root(review.id)}/claim`, claim), f.request('qcOutsider', 'post', `${root(review.id)}/claim`, competing)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const won = a.status === 200 ? a : b, winner = a.status === 200 ? f.actors.qc : f.actors.qcOutsider, originalCommand = a.status === 200 ? claim : competing;
    expect(ok(won, 'one actual concurrent claimant').data.receipt.actorId).toBe(winner.id);
    expect(await prisma.auditLog.count({ where: { action: 'development_qc_handoff', targetId: review.id } })).toBe(1);
    const before = { audit: await prisma.auditLog.count(), notification: await prisma.notification.count(), samples: await prisma.sampleCardItem.count(),
      review: await prisma.developmentSampleQualityReview.findUniqueOrThrow({ where: { id: review.id } }) };
    ok(await f.request(winner, 'get', `${root(review.id)}/handoff-context`), 'read current executor once');
    ok(await f.request(winner, 'get', `${root(review.id)}/handoff-context`), 'read current executor twice');
    expect({ audit: await prisma.auditLog.count(), notification: await prisma.notification.count(), samples: await prisma.sampleCardItem.count(),
      review: await prisma.developmentSampleQualityReview.findUniqueOrThrow({ where: { id: review.id } }) }).toEqual(before);
    const grants = await prisma.userRole.findMany({ where: { userId: winner.id } });
    try {
      await prisma.userRole.deleteMany({ where: { userId: winner.id } });
      expect((await f.request(winner, 'post', `${root(review.id)}/claim`, originalCommand)).status).toBe(403);
    } finally { await prisma.userRole.createMany({ data: grants, skipDuplicates: true }); }
    try {
      await prisma.userAccount.update({ where: { id: winner.id }, data: { status: 'suspended' } });
      expect((await f.request(winner, 'post', `${root(review.id)}/claim`, originalCommand)).status).toBe(401);
    } finally { await prisma.userAccount.update({ where: { id: winner.id }, data: { status: 'active' } }); }
    expect(await prisma.auditLog.count({ where: { action: 'development_qc_handoff', targetId: review.id } })).toBe(1);
  }, 180000);
});
