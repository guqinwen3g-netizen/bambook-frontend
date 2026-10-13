// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { developmentService } from './developmentService';

vi.mock('./authService', () => ({ getAuthState: () => ({ user: { id: 'recorder' } }), subscribe: () => () => {} }));
vi.mock('./apiService', () => ({ apiService: {
  getStoredConfig: () => ({ cloudEndpoint: 'http://synthetic.invalid' }),
  buildApiUrl: (path: string, base: string) => base + path,
  getAuthHeaders: () => ({ Authorization: 'Bearer synthetic' }),
} }));
afterEach(() => vi.unstubAllGlobals());
const response = (body: unknown) => ({ ok: true, json: async () => body });
const confirmation = { requestKey: 'original-confirmation', confirmerType: 'internal' as const, confirmerName: '实际需求人',
  confirmerOrganization: '设计组', confirmedAt: '1791244800000', result: 'needs_adjustment' as const,
  basis: '电话实际意见', evidence: ['https://synthetic.invalid/evidence'], sampleBatchId: 'batch' };
const fact = { ...confirmation, id: 'fact', developmentCaseId: 'case', sampleVersionId: 'minor', recordedBy: 'recorder', recordedAt: '1791244800100' };

it('starts QC for the selected minor, preserves the original key and requires its exact returned version', async () => {
  const fetcher = vi.fn().mockResolvedValue(response({ ok: true, item: { id: 'review', requestKey: 'original-qc', sampleVersionId: 'minor', status: 'queued', result: 'pending' } }));
  vi.stubGlobal('fetch', fetcher);
  const item = await developmentService.initiateDevelopmentBatchQcReview('case', 'batch', { requestKey: 'original-qc', sampleVersionId: 'minor' });
  expect(item.sampleVersionId).toBe('minor');
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ requestKey: 'original-qc', sampleVersionId: 'minor' });
  fetcher.mockResolvedValue(response({ ok: true, item: { id: 'other-review', requestKey: 'original-qc', sampleVersionId: 'major', status: 'queued' } }));
  await expect(developmentService.initiateDevelopmentBatchQcReview('case', 'batch', { requestKey: 'original-qc', sampleVersionId: 'minor' })).rejects.toThrow('准确版本');
});
it('records actual demand-side identity independently from the authenticated recorder', async () => {
  const fetcher = vi.fn().mockResolvedValue(response({ ok: true, item: fact })); vi.stubGlobal('fetch', fetcher);
  expect(await developmentService.recordDevelopmentVersionConfirmation('case', 'minor', confirmation)).toEqual(fact);
  expect(fetcher.mock.calls[0][0]).toBe('http://synthetic.invalid/v1/development/case/sample-versions/minor/confirmations');
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(confirmation);
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).not.toHaveProperty('recordedBy');
});
it.each([
  { sampleVersionId: 'major' }, { developmentCaseId: 'other' }, { requestKey: 'other' },
  { confirmerName: 'recorder' }, { recordedBy: 'other' }, { confirmedAt: '1791244800100' }, { basis: '' },
])('does not accept a mismatched or incomplete confirmation receipt %j', async mutation => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ok: true, item: { ...fact, ...mutation } })));
  await expect(developmentService.recordDevelopmentVersionConfirmation('case', 'minor', confirmation)).rejects.toThrow('确认回执');
});
it('reads only confirmations bound to requested exact versions and rejects unknown identity in that list', async () => {
  const fetcher = vi.fn().mockResolvedValue(response({ ok: true, items: [fact] })); vi.stubGlobal('fetch', fetcher);
  expect(await developmentService.listDevelopmentVersionConfirmations('case', ['minor'])).toEqual([fact]);
  expect(fetcher.mock.calls[0][0]).toContain('versionIds=minor');
  fetcher.mockResolvedValue(response({ ok: true, items: [{ ...fact, sampleVersionId: null }] }));
  await expect(developmentService.listDevelopmentVersionConfirmations('case', ['minor'])).rejects.toThrow('确认记录');
});
it('minor creation sends a stable command and accepts only metadata bound to its actual parent', async () => {
  const fetcher = vi.fn().mockResolvedValue(response({ ok: true, item: { id: 'minor', versionLabel: 'R1-A.1', versionKind: 'minor', parentVersionId: 'major', minorChangeNote: '实际微调' } }));
  vi.stubGlobal('fetch', fetcher);
  const input = { requestKey: 'original-minor', note: '实际微调' };
  expect(await developmentService.createDevelopmentSampleMinorVersion('case', 'major', input)).toMatchObject({ id: 'minor', parentVersionId: 'major' });
  expect(fetcher.mock.calls[0][0]).toBe('http://synthetic.invalid/v1/development/case/sample-versions/major/minors');
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(input);
  fetcher.mockResolvedValue(response({ ok: true, item: { id: 'minor', versionLabel: 'R1-B.1', versionKind: 'minor', parentVersionId: 'other', minorChangeNote: '实际微调' } }));
  await expect(developmentService.createDevelopmentSampleMinorVersion('case', 'major', input)).rejects.toThrow('小版回执');
});
it('conversion receipt must link back to the selected version and physical batch', async () => {
  const fetcher = vi.fn().mockResolvedValue(response({ asset: { id: 'asset', sourceSampleVersionId: 'major', sourceSampleBatchId: 'batch' }, case: { id: 'case' } }));
  vi.stubGlobal('fetch', fetcher);
  const command = { sourceRoundId: 'batch', sourceVersionId: 'minor', requestKey: 'original-conversion' };
  await expect(developmentService.convertToAsset('case', 'node', 'confirmation', undefined, command)).rejects.toThrow('准确版本');
  fetcher.mockResolvedValue(response({ asset: { id: 'asset', sourceSampleVersionId: 'minor', sourceSampleBatchId: 'batch' }, case: { id: 'case' }, conversionReceipt:{schemaVersion:1,requestKey:'original-conversion',caseId:'case',sampleVersionId:'minor',sourceSampleBatchId:'batch',sourceType:'node',sourceId:'confirmation',productAssetId:'asset',auditId:'audit'} }));
  expect(await developmentService.convertToAsset('case', 'node', 'confirmation', undefined, command)).toMatchObject({ asset: { sourceSampleVersionId: 'minor' } });
});
