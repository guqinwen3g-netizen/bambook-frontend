import { afterEach, expect, it, vi } from 'vitest';
import { developmentService } from './developmentService';
vi.mock('./apiService', () => ({ apiService: {
  getStoredConfig: () => ({ cloudEndpoint: 'http://localhost:3001' }),
  buildApiUrl: (path: string, base: string) => base + '/api' + path,
  getAuthHeaders: () => ({ 'Content-Type': 'application/json' }),
} }));
afterEach(() => vi.unstubAllGlobals());
const response = (data: any) => vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => data }));
it.each(['listDevelopmentCases', 'getCaseOutputs'] as const)('%s preserves verified empty results', async method => {
  response({ ok: true, cases: [], outputs: [] }); expect(await developmentService[method]('CASE')).toEqual([]);
});
it.each(['listDevelopmentCases', 'getCaseOutputs'] as const)('%s rejects malformed success rather than inventing empty business truth', async method => {
  for (const body of [{ ok: true }, { ok: true, cases: {}, outputs: {} }, { ok: false, cases: [], outputs: [] }]) {
    response(body); await expect(developmentService[method]('CASE')).rejects.toThrow();
  }
});
it('confirmed-node conversion preserves its actual round ID independently of the legacy level', async () => {
  response({ ok: true, asset: { id: 'ASSET' }, case: { id: 'CASE' } });
  await developmentService.convertToAsset('CASE', 'node', 'confirmation', undefined, { sourceRoundId: 'REAL_ROUND' });
  expect(JSON.parse((fetch as any).mock.calls[0][1].body)).toEqual({ sourceType: 'node', sourceId: 'confirmation', sourceRoundId: 'REAL_ROUND' });
});
const command = { sourceRoundId: 'ROUND', targetSampleId: 'SAMPLE', existingAssetId: 'ASSET', expectedRoundUpdatedAt: '11', expectedSampleUpdatedAt: '12', expectedAssetUpdatedAt: '13', requestKey: 'KEY' };
const ack = { schemaVersion: 1, sourceRoundId: 'ROUND', sampleId: 'SAMPLE', assetId: 'ASSET', auditId: 'AUDIT', provenance: 'current_link_recorded', historicalApprovalRestored: false,
  caseId: 'CASE /', actorId: 'ACTOR', requestKey: 'KEY', command };
it('source linking sends the complete original command and accepts only its exact immutable receipt', async () => {
  response({ ok: true, sourceBinding: ack }); expect(await developmentService.linkGarmentSource('CASE /', command)).toEqual(ack);
  const [url, options] = (fetch as any).mock.calls[0]; expect(url).toContain('/CASE%20%2F/garment-source-links'); expect(JSON.parse(options.body)).toEqual(command);
});
it.each([{ ...ack, sourceRoundId: 'FOREIGN' }, { ...ack, sampleId: 'FOREIGN' }, { ...ack, assetId: 'FOREIGN' }, { ...ack, historicalApprovalRestored: true }, { ...ack, auditId: '' }])('mismatched or invented historical source receipt is not success: %j', async sourceBinding => {
  response({ ok: true, sourceBinding }); await expect(developmentService.linkGarmentSource('CASE /', command)).rejects.toThrow();
});
it('source candidates require a verified array and complete server versions, preserving legitimate blocked empty', async () => {
  response({ ok: true, items: [], blockedReason: '需核对' }); expect(await developmentService.listGarmentSourceLinks('CASE')).toEqual({ items: [], blockedReason: '需核对' });
  for (const body of [{ ok: true }, { ok: false, items: [] }, { ok: true, items: [{ sampleId: 'SAMPLE' }] }]) {
    response(body); await expect(developmentService.listGarmentSourceLinks('CASE')).rejects.toThrow();
  }
});
