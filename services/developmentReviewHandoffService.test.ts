import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
const state = vi.hoisted(() => ({ identity: 'qc-1-current', actorId: 'qc-1', permissions: ['qc:read', 'qc:inspect'] }));
vi.mock('./authService', () => ({ getAuthState: () => ({ user: { id: state.actorId, permissions: state.permissions } }),
  hasPermission: (scope: string) => state.permissions.includes(scope), subscribe: () => () => {} }));
vi.mock('./dashboardTaskService', () => ({ dashboardReadIdentity: () => state.identity }));
vi.mock('./apiService', () => ({ apiService: { buildApiUrl: (path: string, endpoint: string) => endpoint + path,
  getStoredConfig: () => ({ cloudEndpoint: 'https://bambook.invalid/api' }), getAuthHeaders: () => ({ Authorization: 'Bearer current-user', 'Content-Type': 'application/json' }) } }));
import { developmentReviewHandoffService as service, developmentReviewPayloadHash, type DevelopmentReviewHandoffInput } from './developmentReviewHandoffService';
import { qcService } from './qcService';
const fp = 'a'.repeat(64), fileId = 'qef_00000000-0000-4000-8000-000000000001';
const fetcher = vi.fn();
const review = () => ({ id: 'review-1', status: 'in_progress' as const, developmentCaseId: 'case-1', sampleBatchId: 'batch-1', sampleVersionId: 'version-1',
  sourceFingerprint: fp, startedBy: 'qc-1', startedAt: '101', updatedAt: '101', caseCode: 'DEV-1', caseName: 'Fabric development', customerName: 'Actual customer',
  round: 1, versionLabel: 'R1-A', supplierName: 'Actual factory', sampleType: 'lab-dip', batchCode: 'SB-A', specNote: null, returnedAt: '100',
  results: { dyeLotNo: null, colorRating: null, sideDiff: null, endDiff: null, defectCauses: [], notes: null, actualQuantity: '1', actualUnit: '份' } });
const json = (data: unknown) => new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const context = () => ({ item: review(), actorId: state.actorId, expectedUpdatedAt: '101', currentExecutor: { id: 'qc-1', displayName: 'Actual QC' },
  canClaim: false, canTransfer: true, canExecute: true, users: [{ id: 'qc-2', displayName: 'Second QC', departmentName: null }], history: [], files: [] });
beforeEach(() => { state.identity = 'qc-1-current'; state.actorId = 'qc-1'; state.permissions = ['qc:read', 'qc:inspect']; fetcher.mockReset();
  vi.stubGlobal('fetch', fetcher); vi.stubGlobal('crypto', webcrypto);
  if (!File.prototype.arrayBuffer) Object.defineProperty(File.prototype, 'arrayBuffer', { configurable: true, value: function (this: File) {
    return new Promise<ArrayBuffer>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.onerror = () => reject(reader.error); reader.readAsArrayBuffer(this); });
  } });
});
afterEach(() => vi.unstubAllGlobals());

describe('exact development QC handoff client acknowledgements', () => {
  it('rejects mismatched executor/attachment context and preserves unknown historical executor facts', async () => {
    fetcher.mockResolvedValueOnce(json({ ...context(), currentExecutor: { id: 'qc-2', displayName: 'Other QC' } }));
    await expect(service.read('review-1')).rejects.toThrow('执行人');
    fetcher.mockResolvedValueOnce(json({ ...context(), item: { ...review(), sampleVersionId: null, startedBy: null }, currentExecutor: null, canClaim: false, canTransfer: false, canExecute: false }));
    expect(await service.read('review-1')).toMatchObject({ item: { sampleVersionId: null, startedBy: null }, currentExecutor: null, canExecute: false });
    fetcher.mockResolvedValueOnce(json({ ...context(), files: [{ id: fileId, sourceKind: 'development_review', sourceId: 'other-review' }] }));
    await expect(service.read('review-1')).rejects.toThrow('归属');
  });

  it('verifies the exact original handoff hash, actor, source, recipient and audit before accepting an ACK', async () => {
    const input: DevelopmentReviewHandoffInput = { requestKey: 'stable-transfer', expectedStartedBy: 'qc-1', expectedUpdatedAt: '101', sourceFingerprint: fp, reason: '正式转交', toUserId: 'qc-2' };
    const parameterHash = await developmentReviewPayloadHash({ reviewId: 'review-1', actorId: 'qc-1', operation: 'transfer', command: input });
    const receipt = { protocolVersion: 1, operation: 'transfer', requestKey: input.requestKey, parameterHash, auditId: 'actual-audit', actorId: 'qc-1', reviewId: 'review-1',
      developmentCaseId: 'case-1', sampleBatchId: 'batch-1', sampleVersionId: 'version-1', sourceFingerprint: fp, fromUserId: 'qc-1', toUserId: 'qc-2', reason: input.reason, occurredAt: '102' };
    fetcher.mockResolvedValueOnce(json({ item: { ...review(), startedBy: 'qc-2', updatedAt: '102' }, receipt, replayed: true }));
    expect(await service.mutate(review(), 'transfer', input)).toMatchObject({ receipt: { auditId: 'actual-audit' }, replayed: true });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(input);
    fetcher.mockResolvedValueOnce(json({ item: { ...review(), startedBy: 'qc-2' }, receipt: { ...receipt, sampleVersionId: 'different-version' }, replayed: true }));
    await expect(service.mutate(review(), 'transfer', input)).rejects.toThrow('回执');
  });

  it('does not accept late replies after account, authority or endpoint identity changes', async () => {
    fetcher.mockImplementationOnce(async () => { state.identity = 'different-current-identity'; return json(context()); });
    await expect(service.read('review-1')).rejects.toThrow('已变化');
    state.identity = 'qc-1-current'; state.permissions = ['qc:read', 'qc:write']; fetcher.mockClear();
    await expect(service.mutate(review(), 'claim', { requestKey: 'claim-key', expectedStartedBy: null, expectedUpdatedAt: '101', sourceFingerprint: fp, reason: '实际认领' })).rejects.toThrow('专业权限');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses multipart real bytes and validates actual uploader, file hash and precise review identity', async () => {
    const file = new File(['actual-report-bytes'], '现场.png', { type: 'image/png' }), sha256 = await developmentReviewPayloadHash('unused');
    const bytes = await file.arrayBuffer();
    const fileHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(byte => byte.toString(16).padStart(2, '0')).join('');
    const metadata = { id: fileId, name: file.name, size: file.size, mimeType: 'image/png', sha256: fileHash, uploadedBy: 'qc-1', uploadedAt: '102',
      sourceKind: 'development_review', sourceId: 'review-1', sourceFingerprint: fp };
    fetcher.mockResolvedValueOnce(json({ ok: true, file: metadata, requestKey: 'upload-original', replayed: true }));
    expect(await service.upload(review(), 'upload-original', file)).toEqual(metadata);
    expect(fetcher.mock.calls[0][1].body).toBeInstanceOf(FormData); expect(fetcher.mock.calls[0][1].headers.has('Content-Type')).toBe(false);
    fetcher.mockResolvedValueOnce(json({ ok: true, file: { ...metadata, uploadedBy: 'qc-2', sha256 }, requestKey: 'upload-original', replayed: true }));
    await expect(service.upload(review(), 'upload-original', file)).rejects.toThrow('上传回执');
  });

  it('requires qc:inspect and the actual report author/key/file ACK when completing the old route', async () => {
    const requestKey = '00000000-0000-4000-8000-000000000002';
    const input = { requestKey, result: 'pass' as const, opinion: '实际检验通过', criticalDefects: 0, majorDefects: 0, minorDefects: 0, evidenceFileIds: [] };
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, item: { ...review(), status: 'reviewed', result: 'pass', opinion: input.opinion, reviewedBy: 'qc-1', completionRequestKey: requestKey, evidence: [] } })));
    expect(await qcService.completeDevelopmentSampleReview('review-1', input)).toMatchObject({ reviewedBy: 'qc-1' });
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, item: { ...review(), status: 'reviewed', result: 'pass', opinion: input.opinion, reviewedBy: 'qc-2', completionRequestKey: requestKey, evidence: [] } })));
    await expect(qcService.completeDevelopmentSampleReview('review-1', input)).rejects.toThrow('回执');
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, item: { ...review(), startedBy: 'qc-2' } })));
    await expect(qcService.startDevelopmentSampleReview('review-1')).rejects.toThrow('不一致');
  });
});


it('accepts configured head assignment queued ACK and head transfer without claiming that head executed', async () => {
  const unclaimed = { ...review(), status: 'queued', startedBy: null, startedAt: null, responsibleHeadId: 'qc-1', routingTeamId: 'team-1' };
  fetcher.mockResolvedValueOnce(json({ ...context(), item: unclaimed, currentExecutor: null, canClaim: true, canAssign: true, canTransfer: false, canExecute: false }));
  expect(await service.read('review-1')).toMatchObject({ canAssign: true, canExecute: false });
  const input = { requestKey: 'assign-original', expectedStartedBy: null, expectedUpdatedAt: '101', sourceFingerprint: fp, reason: '负责人分配', toUserId: 'qc-2' };
  const parameterHash = await developmentReviewPayloadHash({ reviewId: 'review-1', actorId: 'qc-1', operation: 'assign', command: input });
  const receipt = { protocolVersion: 1, operation: 'assign', requestKey: input.requestKey, parameterHash, auditId: 'assign-audit', actorId: 'qc-1', reviewId: 'review-1', developmentCaseId: 'case-1', sampleBatchId: 'batch-1', sampleVersionId: 'version-1', sourceFingerprint: fp, fromUserId: null, toUserId: 'qc-2', reason: input.reason, occurredAt: '102' };
  fetcher.mockResolvedValueOnce(json({ item: { ...unclaimed, startedBy: 'qc-2' }, receipt, replayed: false }));
  expect(await service.mutate(unclaimed as any, 'assign', input)).toMatchObject({ item: { status: 'queued', startedBy: 'qc-2' }, receipt: { operation: 'assign' } });
  fetcher.mockResolvedValueOnce(json({ ...context(), item: { ...review(), startedBy: 'qc-2', responsibleHeadId: 'qc-1' }, currentExecutor: { id: 'qc-2', displayName: 'Actual executor' }, canAssign: false, canTransfer: true, canExecute: false }));
  expect(await service.read('review-1')).toMatchObject({ canTransfer: true, canExecute: false, currentExecutor: { id: 'qc-2' } });
});

it('accepts conditional conclusions with exact normalized measurements and rejects tampered measurement ACK', async () => {
  const input = { requestKey: '00000000-0000-4000-8000-000000000033', result: 'conditional_pass' as const, opinion: '袖口问题仍需告知', criticalDefects: 0, majorDefects: 0, minorDefects: 0, measurements: [{ piece: '衣1', size: null, position: '胸宽', value: '040.00', unit: 'cm' }] };
  const item = { ...review(), status: 'reviewed', result: input.result, opinion: input.opinion, reviewedBy: 'qc-1', completionRequestKey: input.requestKey, measurements: [{ unit: 'cm', value: '040.00', position: '胸宽', size: null, piece: '衣1' }] };
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, item })));
  expect(await qcService.completeDevelopmentSampleReview('review-1', input)).toMatchObject({ result: 'conditional_pass' });
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, item: { ...item, measurements: [{ ...input.measurements[0], value: '40' }] } })));
  await expect(qcService.completeDevelopmentSampleReview('review-1', input)).rejects.toThrow('实测回执');
});
