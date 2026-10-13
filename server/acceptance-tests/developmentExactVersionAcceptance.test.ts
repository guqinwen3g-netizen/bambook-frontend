import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { assertIsolatedAcceptanceDatabase } from './isolatedDatabase';
import { createOrderLinesRouter } from '../src/orders/orderLinesRoute';
import { completeExactDevelopmentQc, convertExactDevelopmentArchive, createGlobalBusinessHttpFixture,
  createReturnedDevelopmentSample, recordExactDevelopmentConfirmation, requireHttpSuccess, type GlobalBusinessHttpFixture } from './globalBusinessFixtures';

// No default database fallback, even if this opt-in file is invoked incorrectly.
const prisma = new PrismaClient({ datasources: { db: { url: process.env.BAMBOOK_ACCEPTANCE_DATABASE_URL
  ?? 'postgresql://acceptance_disabled:disabled@127.0.0.1:1/acceptance_disabled' } } });
let f: GlobalBusinessHttpFixture;
const enc = encodeURIComponent;
const codeOf = (response: any) => typeof response.body.error === 'string' ? response.body.error : response.body.error?.code;

beforeAll(async () => {
  await assertIsolatedAcceptanceDatabase(prisma);
  f = await createGlobalBusinessHttpFixture(prisma, { prefix: 'exact-version-http', mountAdditionalRoutes(app) {
    app.set('json replacer', (_key: string, value: unknown) => typeof value === 'bigint' ? String(value) : value);
    app.use('/api/v1/order-lines', createOrderLinesRouter({ prisma, requireAuth: true, apiKeys: new Set<string>() }));
  } });
}, 60000);
afterAll(async () => { await f?.close(); await prisma.$disconnect(); });

describe('Exact development versions through real accounts, HTTP and PostgreSQL', () => {
  it('requires own actual requester selection to bind an archived dotted version to an order, and preserves the frozen basis after later NOK', async () => {
    const source = await createReturnedDevelopmentSample(f, { key: 'order-source', lengthMeters: '8.5' });
    await completeExactDevelopmentQc(f, source, { key: `${f.prefix}-order-major-qc` });
    await recordExactDevelopmentConfirmation(f, source, { key: `${f.prefix}-order-major-choice` });
    const minor = requireHttpSuccess(await f.request('salesOwner', 'post',
      `/api/v1/development/${enc(source.caseId)}/sample-versions/${enc(source.versionId)}/minors`, {
        requestKey: `${f.prefix}-order-minor`, note: 'Production must consume this exact written finish adjustment',
      }), 'create accurate order minor', 201).item;
    const exact = { ...source, versionId: minor.id };
    await completeExactDevelopmentQc(f, exact, { key: `${f.prefix}-order-minor-qc` });
    const archived = await convertExactDevelopmentArchive(f, exact, { key: `${f.prefix}-order-minor-archive` });
    expect(await prisma.developmentVersionConfirmation.count({ where: { sampleVersionId: minor.id } })).toBe(0);
    const orderId = `${f.prefix}-accurate-order`, lineId = `${f.prefix}-accurate-line`;
    const now = BigInt(Date.now());
    // Only an unapproved draft is a fixture. Its source, both gates and binding
    // are produced through actual authenticated commands.
    await prisma.order.create({ data: { id: orderId, code: `${f.prefix}-ORDER`, poNumber: null,
      customer: f.customer.name, customerRelationId: f.customer.id, product: 'Exact minor source draft',
      type: 'fabric', businessLine: 'fabric', quantity: '1000', unit: 'm', status: 'Pending', dueDate: '2099-01-01', quoteAmount: 2500,
      ownerId: f.actors.salesOwner.id, salesPerson: f.actors.salesOwner.name, sourceCaseId: source.caseId,
      millRelationId: f.factory.id, millName: f.factory.name, source: 'isolated-acceptance-draft', importedAt: now, updatedAt: now } });
    await prisma.orderLine.create({ data: { id: lineId, orderId, lineNumber: 1, itemNo: '0010', materialCode: 'EXACT-MINOR',
      description: 'Exact dotted development source', quantity: '1000', unit: 'm', unitPrice: '2.5', requiredSampleFamilies: ['fabric_eps', 'fabric_ss'] } });
    const command = { confirmedSourceType: 'Asset', confirmedSourceId: archived.assetId, millRelationId: f.factory.id };
    const noOwnChoice = await f.request('salesOwner', 'patch', `/api/v1/order-lines/${enc(lineId)}/version`, command);
    expect(noOwnChoice.status).toBe(409); expect(codeOf(noOwnChoice)).toBe('DEVELOPMENT_NOT_READY');
    expect((await prisma.orderLine.findUniqueOrThrow({ where: { id: lineId } })).confirmedSourceId).toBeNull();
    const selected = await recordExactDevelopmentConfirmation(f, exact, { key: `${f.prefix}-order-minor-choice` });
    const outsider = await f.request('salesOutsider', 'patch', `/api/v1/order-lines/${enc(lineId)}/version`, command);
    expect(outsider.status).toBe(404);
    const bound = requireHttpSuccess(await f.request('salesOwner', 'patch', `/api/v1/order-lines/${enc(lineId)}/version`, command), 'bind accurate selected minor');
    expect(bound.line.specSnapshot.exactDevelopmentVersionProof).toMatchObject({ sampleVersionId: minor.id,
      physicalSampleVersionId: source.versionId, confirmationId: selected.confirmation.id,
      confirmerName: selected.confirmation.confirmerName, recordedBy: f.actors.salesOwner.id });
    const persisted = await prisma.orderLine.findUniqueOrThrow({ where: { id: lineId } });
    expect(persisted.confirmedSourceId).toBe(archived.assetId);
    const frozen = persisted.specSnapshot;
    await completeExactDevelopmentQc(f, exact, { key: `${f.prefix}-order-later-nok`, result: 'reject' });
    const afterNok = await f.request('salesOwner', 'patch', `/api/v1/order-lines/${enc(lineId)}/version`, command);
    expect(afterNok.status).toBe(409); expect(codeOf(afterNok)).toBe('QC_PASS_REQUIRED');
    expect((await prisma.orderLine.findUniqueOrThrow({ where: { id: lineId } })).specSnapshot).toEqual(frozen);
    expect(await prisma.sampleCardItem.count({ where: { devCaseId: source.caseId, deletedAt: null } })).toBe(1);
  }, 60000);

  it('keeps fabric physical receipt, independent QC/confirmation, re-review and archive retries consistent', async () => {
    const source = await createReturnedDevelopmentSample(f, { key: 'fabric', lengthMeters: '10.5',
      warehouseId: f.warehouse.id, location: '样品间 A-02' });
    const base = `/api/v1/development/${enc(source.caseId)}`;
    expect(source.physicalCards).toHaveLength(1);
    expect(source.physicalCards[0]).toMatchObject({ batchId: source.batchId, devCaseId: source.caseId,
      warehouseId: f.warehouse.id, location: '样品间 A-02', physicalLengthQty: '10.5', availableLengthQty: '10.5' });
    const physicalBefore = await prisma.sampleCardItem.findMany({ where: { devCaseId: source.caseId, deletedAt: null } });
    expect(physicalBefore[0].receiptSnapshot).toMatchObject({ warehouseId: f.warehouse.id, location: '样品间 A-02' });
    const initial = requireHttpSuccess(await f.request('salesOwner', 'get', `${base}/batches`), 'read received version').batches[0];
    expect(initial).toMatchObject({ sampleVersionId: source.versionId, versionIdentityStatus: 'recorded_exact',
      latestFormalQcReview: null, versionConfirmation: null });

    const requestBody = { requestKey: `${f.prefix}-fabric-major-qc`, sampleVersionId: source.versionId };
    const requested = requireHttpSuccess(await f.request('salesOwner', 'post', `${base}/batches/${enc(source.batchId)}/qc-review`, requestBody), 'request major QC', 201).item;
    expect(requested).toMatchObject({ sampleVersionId: source.versionId, status: 'queued', reviewSequence: 1 });
    expect(requested.physicalItems.map((item: any) => item.id)).toEqual(source.physicalCardIds);
    const salesAssess = await f.request('salesOwner', 'post', `/api/v1/qc/development-sample-reviews/${enc(requested.id)}/start`, {});
    expect(salesAssess.status).toBe(403); expect(codeOf(salesAssess)).toBe('FORBIDDEN');
    // The current canonical QC role has company-wide professional read scope.
    // Team absence is therefore a valid read, not an invented denial rule.
    const otherQcQueue = requireHttpSuccess(await f.request('qcOutsider', 'get', '/api/v1/qc/development-sample-reviews'), 'read canonical company-wide QC queue');
    expect(otherQcQueue.items.some((item: any) => item.id === requested.id)).toBe(true);
    // Disable the real account after login: its stale token must lose authority
    // on the very next HTTP request. This changes authorization, no QC fact.
    await prisma.userAccount.update({ where: { id: f.actors.qcOutsider.id }, data: { status: 'disabled' } });
    const disabledQc = await f.request('qcOutsider', 'post', `/api/v1/qc/development-sample-reviews/${enc(requested.id)}/start`, {});
    expect(disabledQc.status).toBe(401); expect(codeOf(disabledQc)).toBe('ACCOUNT_DISABLED');
    const outsiderRead = await f.request('salesOutsider', 'get', `${base}/batches`);
    expect(outsiderRead.status).toBe(404);
    expect((await prisma.developmentSampleQualityReview.findUniqueOrThrow({ where: { id: requested.id } })).status).toBe('queued');

    requireHttpSuccess(await f.request('qc', 'post', `/api/v1/qc/development-sample-reviews/${enc(requested.id)}/start`, {}), 'QC starts major');
    const majorPassBody = { requestKey: `${f.prefix}-fabric-major-pass`, result: 'pass', opinion: '按照该准确工厂版本要求核查实物', evidence: [] };
    const passed = requireHttpSuccess(await f.request('qc', 'post', `/api/v1/qc/development-sample-reviews/${enc(requested.id)}/complete`, majorPassBody), 'QC passes major').item;
    expect(passed).toMatchObject({ sampleVersionId: source.versionId, reviewedBy: f.actors.qc.id, result: 'pass', status: 'reviewed' });
    const majorArchive = await convertExactDevelopmentArchive(f, source, { key: `${f.prefix}-fabric-major-archive` });
    expect(majorArchive.asset).toMatchObject({ sourceDevelopmentCaseId: source.caseId, sourceSampleVersionId: source.versionId });
    expect(await prisma.developmentVersionConfirmation.count({ where: { developmentCaseId: source.caseId } })).toBe(0);
    expect(majorArchive.conversionReceipt.sourceSampleBatchId).toBe(source.batchId);
    const customerConfirmedAt = String(Date.now() - 60000);
    const customerFact = { requestKey: `${f.prefix}-major-customer-confirm`, confirmerType: 'customer', confirmerName: '真实需求方 Eleanor',
      confirmerRelationId: f.customer.id, confirmerOrganization: f.customer.name, confirmedAt: customerConfirmedAt,
      result: 'approved', basis: '客户明确确认当前 R1-A 规格与实物，业务员记录其实际意见', evidence: [], sampleBatchId: source.batchId };
    const customerConfirmation = requireHttpSuccess(await f.request('salesOwner', 'post', `${base}/sample-versions/${enc(source.versionId)}/confirmations`, customerFact), 'record actual customer confirmation', 201).item;
    expect(customerConfirmation).toMatchObject({ confirmerName: customerFact.confirmerName, confirmerType: 'customer', confirmedAt: customerConfirmedAt,
      recordedBy: f.actors.salesOwner.id, sampleVersionId: source.versionId });
    expect(Number(customerConfirmation.recordedAt)).toBeGreaterThan(Number(customerConfirmedAt));
    expect(customerConfirmation.confirmerName).not.toBe(f.actors.salesOwner.name);

    const minorBody = { requestKey: `${f.prefix}-fabric-minor`, note: '同一原实物进行手感与整理要求的版本微调，无新增实物' };
    const minor = requireHttpSuccess(await f.request('salesOwner', 'post', `${base}/sample-versions/${enc(source.versionId)}/minors`, minorBody), 'create independent minor', 201).item;
    const minorReplay = requireHttpSuccess(await f.request('salesOwner', 'post', `${base}/sample-versions/${enc(source.versionId)}/minors`, minorBody), 'replay minor command', 201).item;
    expect(minorReplay.id).toBe(minor.id);
    const afterMinor = requireHttpSuccess(await f.request('salesOwner', 'get', `${base}/batches`), 'read minor decisions').batches[0];
    const minorView = afterMinor.microVersions.find((item: any) => item.id === minor.id);
    expect(afterMinor).toMatchObject({ latestFormalQcReview: { id: requested.id, result: 'pass' }, versionConfirmation: { id: customerConfirmation.id } });
    expect(minorView).toMatchObject({ versionIdentityStatus: 'recorded_exact', latestFormalQcReview: null, developmentQcReview: null,
      versionConfirmation: null, developmentQcHistory: [], versionConfirmationHistory: [], linkedAsset: null });
    const minorSource = { ...source, versionId: minor.id };
    const unassessedArchive = await f.request('salesOwner', 'post', `${base}/convert-to-asset`, { sourceType: 'batch', sourceId: source.batchId,
      sourceVersionId: minor.id, requestKey: `${f.prefix}-unassessed-minor`, expectedRevision: afterMinor.attachments.fabricHistory.revision, expectedRound: 1 });
    expect(unassessedArchive.status).toBe(409); expect(codeOf(unassessedArchive)).toBe('QC_PASS_REQUIRED');
    expect(await prisma.sampleCardItem.count({ where: { devCaseId: source.caseId, deletedAt: null } })).toBe(1);
    const nok = await completeExactDevelopmentQc(f, minorSource, { key: `${f.prefix}-minor-nok`, result: 'reject' });
    const nokArchive = await f.request('salesOwner', 'post', `${base}/convert-to-asset`, { sourceType: 'batch', sourceId: source.batchId,
      sourceVersionId: minor.id, requestKey: `${f.prefix}-nok-minor`, expectedRevision: afterMinor.attachments.fabricHistory.revision, expectedRound: 1 });
    expect(nokArchive.status).toBe(409); expect(codeOf(nokArchive)).toBe('QC_PASS_REQUIRED');
    const rereview = await completeExactDevelopmentQc(f, minorSource, { key: `${f.prefix}-minor-rereview`, result: 'pass' });
    expect(rereview.review.reviewSequence).toBe(2);
    const oldRequest = requireHttpSuccess(await f.request('salesOwner', 'post', `${base}/batches/${enc(source.batchId)}/qc-review`, {
      requestKey: nok.requestKey, sampleVersionId: minor.id,
    }), 'replay old NOK request', 201).item;
    expect(oldRequest).toMatchObject({ id: nok.reviewId, result: 'reject', reviewSequence: 1 });
    const oldCompletion = requireHttpSuccess(await f.request('qc', 'post', `/api/v1/qc/development-sample-reviews/${enc(nok.reviewId)}/complete`, {
      requestKey: nok.completionRequestKey, result: 'reject', opinion: '准确版本不符合本轮要求', inspectionDate: new Date().toISOString().slice(0, 10),
      inspectorOrg: 'Bambook QC', criticalDefects: 0, majorDefects: 0, minorDefects: 0, evidence: [],
    }), 'replay original completion').item;
    expect(oldCompletion.id).toBe(nok.reviewId); expect(oldCompletion.result).toBe('reject');
    const beforeInternal = requireHttpSuccess(await f.request('salesOwner', 'get', `${base}/batches`), 'read re-review history').batches[0];
    const minorBeforeInternal = beforeInternal.microVersions.find((item: any) => item.id === minor.id);
    expect(minorBeforeInternal.latestFormalQcReview).toMatchObject({ id: rereview.reviewId, result: 'pass' });
    expect(minorBeforeInternal.developmentQcHistory.map((item: any) => item.id)).toEqual([rereview.reviewId, nok.reviewId]);
    expect(minorBeforeInternal.versionConfirmation).toBeNull();

    const internalConfirmedAt = String(Date.now() - 30000);
    const internalFact = { requestKey: `${f.prefix}-minor-internal-confirm`, confirmerType: 'internal', confirmerName: f.actors.actualRequester.name,
      confirmerUserId: f.actors.actualRequester.id, confirmerOrganization: '内部实际需求组', confirmedAt: internalConfirmedAt,
      result: 'approved', basis: '实际内部需求人确认当前微调版本，业务账号仅负责录入', evidence: [], sampleBatchId: source.batchId };
    const internalConfirmation = requireHttpSuccess(await f.request('salesOwner', 'post', `${base}/sample-versions/${enc(minor.id)}/confirmations`, internalFact), 'record actual internal confirmer', 201).item;
    expect(internalConfirmation).toMatchObject({ sampleVersionId: minor.id, confirmerType: 'internal', confirmerUserId: f.actors.actualRequester.id,
      confirmerName: f.actors.actualRequester.name, confirmedAt: internalConfirmedAt, recordedBy: f.actors.salesOwner.id });
    expect(internalConfirmation.confirmerUserId).not.toBe(internalConfirmation.recordedBy);
    const confirmReplay = requireHttpSuccess(await f.request('salesOwner', 'post', `${base}/sample-versions/${enc(minor.id)}/confirmations`, internalFact), 'replay actual confirmation', 201).item;
    expect(confirmReplay.id).toBe(internalConfirmation.id);
    const confirmConflict = await f.request('salesOwner', 'post', `${base}/sample-versions/${enc(minor.id)}/confirmations`, { ...internalFact, confirmerName: '改写原实际确认人' });
    expect(confirmConflict.status).toBe(409); expect(codeOf(confirmConflict)).toBe('REQUEST_CONFLICT');
    const confirmations = requireHttpSuccess(await f.request('salesOwner', 'get', `${base}/version-confirmations?versionIds=${enc(minor.id)}`), 'read exact confirmation history');
    expect(confirmations.items.map((item: any) => item.id)).toEqual([internalConfirmation.id]);

    const minorArchive = await convertExactDevelopmentArchive(f, minorSource, { key: `${f.prefix}-minor-archive` });
    expect(minorArchive.assetId).not.toBe(majorArchive.assetId);
    expect(minorArchive.asset.sourceSpecSnapshot.physicalCardIds).toEqual(source.physicalCardIds);
    const replay = requireHttpSuccess(await f.request('salesOwner', 'post', `${base}/convert-to-asset`, minorArchive.command), 'retry committed minor archive');
    expect(replay.asset.id).toBe(minorArchive.assetId); expect(replay.conversionReceipt).toEqual(minorArchive.conversionReceipt);
    const conflict = await f.request('salesOwner', 'post', `${base}/convert-to-asset`, { ...minorArchive.command, sourceVersionId: source.versionId });
    expect(conflict.status).toBe(409); expect(codeOf(conflict)).toBe('REQUEST_CONFLICT');
    const unauthorizedReplay = await f.request('salesOutsider', 'post', `${base}/convert-to-asset`, minorArchive.command);
    expect(unauthorizedReplay.status).toBe(404);
    const afterArchive = requireHttpSuccess(await f.request('salesOwner', 'get', `${base}/batches`), 'read exact archive identities').batches[0];
    expect(afterArchive.linkedAsset.id).toBe(majorArchive.assetId);
    expect(afterArchive.microVersions.find((item: any) => item.id === minor.id).linkedAsset.id).toBe(minorArchive.assetId);
    const physicalAfter = await prisma.sampleCardItem.findMany({ where: { devCaseId: source.caseId, deletedAt: null } });
    expect(physicalAfter.map(item => item.id)).toEqual(physicalBefore.map(item => item.id));
    expect(physicalAfter[0].productAssetId).toBe(majorArchive.assetId);
    expect(physicalAfter[0].availableLengthQty?.toString()).toBe('10.5');

    // A later effective NOK blocks new commands, but cannot rewrite the receipt
    // of an already committed, identically retried archive request.
    await completeExactDevelopmentQc(f, minorSource, { key: `${f.prefix}-minor-later-nok`, result: 'reject' });
    const originalReceipt = requireHttpSuccess(await f.request('salesOwner', 'post', `${base}/convert-to-asset`, minorArchive.command), 'resolve original archive after later NOK');
    expect(originalReceipt.conversionReceipt).toEqual(minorArchive.conversionReceipt);
    const newAfterNok = await f.request('salesOwner', 'post', `${base}/convert-to-asset`, { ...minorArchive.command, requestKey: `${f.prefix}-new-after-nok` });
    expect(newAfterNok.status).toBe(409); expect(codeOf(newAfterNok)).toBe('QC_PASS_REQUIRED');
    expect(await prisma.productAsset.count({ where: { sourceDevelopmentCaseId: source.caseId, deletedAt: null } })).toBe(2);
    expect(await prisma.developmentSampleQualityReview.count({ where: { sampleVersionId: minor.id } })).toBe(3);
    expect(await prisma.sampleCardItem.count({ where: { devCaseId: source.caseId, deletedAt: null } })).toBe(1);
    const conversionAudit = await prisma.auditLog.findUniqueOrThrow({ where: { id: minorArchive.conversionReceipt.auditId } });
    expect(conversionAudit).toMatchObject({ actorId: f.actors.salesOwner.id, targetId: minor.id, action: 'acknowledge_development_archive_command' });
  }, 90000);

  it('keeps each returned garment distinct while minor archives reference those same physical pieces', async () => {
    const source = await createReturnedDevelopmentSample(f, { key: 'garment', type: 'garment', quantity: 2 });
    const base = `/api/v1/development/${enc(source.caseId)}`;
    expect(source.physicalCards).toHaveLength(2);
    expect(new Set(source.physicalCardIds).size).toBe(2);
    expect(source.physicalCards.every(item => item.quantity === 1 && item.availableQty === 1 && item.warehouseId == null && item.location == null)).toBe(true);
    const receiptPieces = await prisma.sampleCardItem.findMany({ where: { devCaseId: source.caseId, deletedAt: null }, orderBy: { id: 'asc' } });
    expect(receiptPieces.map(item => (item.receiptSnapshot as any).physicalItemIndex).sort()).toEqual([1, 2]);
    await completeExactDevelopmentQc(f, source, { key: `${f.prefix}-garment-major` });
    const majorArchive = await convertExactDevelopmentArchive(f, source, { type: 'garment', key: `${f.prefix}-garment-major-archive` });
    expect(await prisma.developmentVersionConfirmation.count({ where: { developmentCaseId: source.caseId } })).toBe(0);
    const minor = requireHttpSuccess(await f.request('salesOwner', 'post', `${base}/sample-versions/${enc(source.versionId)}/minors`, {
      requestKey: `${f.prefix}-garment-minor`, note: '原两件样衣不改库存，另记袖长标注微调版本',
    }), 'create garment minor', 201).item;
    const rounds = requireHttpSuccess(await f.request('salesOwner', 'get', `/api/v1/samples/garment/${enc(source.caseId)}/rounds`), 'read garment exact version workflow').items;
    const major = rounds.find((item: any) => item.id === source.batchId);
    expect(major.linkedAsset.id).toBe(majorArchive.assetId);
    expect(major.microVersions.find((item: any) => item.id === minor.id)).toMatchObject({ latestFormalQcReview: null, versionConfirmation: null, linkedAsset: null });
    const minorSource = { ...source, versionId: minor.id };
    const denied = await f.request('salesOwner', 'post', `${base}/convert-to-asset`, { sourceType: 'node', sourceId: 'confirmation',
      sourceRoundId: source.batchId, sourceVersionId: minor.id, requestKey: `${f.prefix}-garment-unassessed` });
    expect(denied.status).toBe(409); expect(codeOf(denied)).toBe('QC_PASS_REQUIRED');
    await completeExactDevelopmentQc(f, minorSource, { key: `${f.prefix}-garment-minor-qc` });
    const minorArchive = await convertExactDevelopmentArchive(f, minorSource, { type: 'garment', key: `${f.prefix}-garment-minor-archive` });
    expect(new Set(minorArchive.asset.sourceSpecSnapshot.physicalCardIds)).toEqual(new Set(source.physicalCardIds));
    const physicalAfter = await prisma.sampleCardItem.findMany({ where: { devCaseId: source.caseId, deletedAt: null } });
    expect(new Set(physicalAfter.map(item => item.id))).toEqual(new Set(source.physicalCardIds));
    expect(physicalAfter.every(item => item.productAssetId === majorArchive.assetId && item.quantity === 1 && item.availableQty === 1)).toBe(true);
    expect(await prisma.productAsset.count({ where: { sourceDevelopmentCaseId: source.caseId, deletedAt: null } })).toBe(2);
    const noSelectionSeal = await f.request('salesOwner', 'post', `/api/v1/samples/garment/${enc(source.batchId)}/seal`, { sampleVersionId: minor.id });
    expect(noSelectionSeal.status).toBe(409); expect(codeOf(noSelectionSeal)).toBe('DEVELOPMENT_NOT_READY');
    await recordExactDevelopmentConfirmation(f, minorSource, { key: `${f.prefix}-garment-minor-selection` });
    const missingVersion = await f.request('salesOwner', 'post', `/api/v1/samples/garment/${enc(source.batchId)}/seal`, {});
    expect(missingVersion.status).toBe(409); expect(codeOf(missingVersion)).toBe('DEVELOPMENT_SOURCE_CHANGED');
    const sealed = requireHttpSuccess(await f.request('salesOwner', 'post', `/api/v1/samples/garment/${enc(source.batchId)}/seal`, {
      sampleVersionId: minor.id, retainLocation: '样品间 B-07',
    }), 'seal the exact approved garment minor').round;
    expect(sealed).toMatchObject({ sealedVersionId: minor.id, retainLocation: '样品间 B-07', sealedDevelopmentVersionProof: { sampleVersionId: minor.id } });
    const pp = await prisma.sample.findUniqueOrThrow({ where: { projectionKey: `v2:garment_pp:${source.batchId}:1:${minor.id}` } });
    expect(pp.productAssetId).toBe(minorArchive.assetId);
    const ancestry = await prisma.sampleSource.findMany({ where: { sampleId: pp.id } });
    expect(ancestry).toHaveLength(1);
    expect(ancestry[0].sourceSnapshot).toMatchObject({ batch: { sampleVersionId: source.versionId, selectedSampleVersionId: minor.id },
      content: { exactDevelopmentVersionProof: { sampleVersionId: minor.id } } });
    expect(await prisma.sampleCardItem.count({ where: { devCaseId: source.caseId, deletedAt: null } })).toBe(2);
    const rawBatch = await prisma.sampleBatch.findUniqueOrThrow({ where: { id: source.batchId } });
    expect(rawBatch.sampleVersionId).toBe(source.versionId);
    expect(rawBatch.qcStatus).toBeNull();
    expect(rawBatch.customerStatus).not.toBe('approved');
  }, 60000);

  it('authorizes an internal development by its real owner/team without manufacturing a customer', async () => {
    const source = await createReturnedDevelopmentSample(f, { key: 'internal', internal: true });
    const base = `/api/v1/development/${enc(source.caseId)}`;
    requireHttpSuccess(await f.request('actualRequester', 'get', `${base}/batches`), 'current responsible team reads internal work');
    expect((await f.request('salesOutsider', 'get', `${base}/batches`)).status).toBe(404);
    const customerFact = await f.request('salesOwner', 'post', `${base}/sample-versions/${enc(source.versionId)}/confirmations`, {
      requestKey: `${f.prefix}-internal-fake-customer`, confirmerType: 'customer', confirmerName: '没有来源的客户',
      confirmedAt: String(Date.now() - 1000), result: 'approved', basis: '该案为内部开发，无客户来源',
    });
    expect(customerFact.status).toBe(400); expect(codeOf(customerFact)).toBe('INVALID_INPUT');
    await completeExactDevelopmentQc(f, source, { key: `${f.prefix}-internal-qc` });
    const archive = await convertExactDevelopmentArchive(f, source, { key: `${f.prefix}-internal-archive` });
    expect(archive.asset.sourceSampleVersionId).toBe(source.versionId);
    const development = await prisma.developmentCase.findUniqueOrThrow({ where: { id: source.caseId } });
    expect(development.customerRelationId).toBeNull(); expect(development.ownerId).toBe(f.actors.salesOwner.id);
    expect(await prisma.developmentVersionConfirmation.count({ where: { developmentCaseId: source.caseId } })).toBe(0);
  }, 60000);
});
