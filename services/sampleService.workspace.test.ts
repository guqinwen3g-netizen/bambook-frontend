import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./apiService', () => ({ apiService: { getStoredConfig: () => ({ cloudEndpoint: 'http://private.invalid/api' }), buildApiUrl: (path: string, base: string) => base + path, getAuthHeaders: () => ({ Authorization: 'Bearer synthetic-not-native' }) } }));
import { sampleService } from './sampleService';
const row = (status: string = 'resolved', businessLine: string | null = 'fabric') => ({ id: 'S1', businessContext: { status, businessLine, reasons: status === 'resolved' ? [] : ['NO_AUTHORITATIVE_SOURCE'] } });
const respond = (body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => body })));
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });
describe('S3B client verifies server scope before publishing a lane', () => {
  it('old backend without classification echo is refused instead of displaying mixed first200', async () => { respond({ samples: [row()], total: 203 }); await expect(sampleService.listSamples({ scope: 'fabric' })).rejects.toThrow('当前后台尚未支持样品分线，请更新测试环境'); });
  it('echo from another lane cannot masquerade as the requested lane', async () => { respond({ scope: 'garment', samples: [row('resolved', 'garment')], total: 1 }); await expect(sampleService.listSamples({ scope: 'fabric' })).rejects.toThrow('分线响应不一致'); });
  it('correct echo but opposite-lane actual record is refused', async () => { respond({ scope: 'fabric', samples: [row('resolved', 'garment')], total: 1 }); await expect(sampleService.listSamples({ scope: 'fabric' })).rejects.toThrow('分线响应不一致'); });
  it('missing metadata is refused even in review; it is not a classified server response', async () => { respond({ scope: 'review', samples: [{ id: 'legacy' }], total: 1 }); await expect(sampleService.listSamples({ scope: 'review' })).rejects.toThrow('分线响应不一致'); });
  it('review includes genuinely unresolved/conflict metadata only', async () => { const rows = [row('unresolved', null), { ...row('conflict', null), id: 'S2' }]; respond({ scope: 'review', samples: rows, total: 207 }); await expect(sampleService.listSamples({ scope: 'review', limit: 50, offset: 100 })).resolves.toMatchObject({ samples: rows, total: 207 }); const url = String(vi.mocked(fetch).mock.calls[0][0]); expect(new URL(url).searchParams.get('scope')).toBe('review'); expect(new URL(url).searchParams.get('offset')).toBe('100'); });
  it('fractional/negative total is never published as complete', async () => { respond({ scope: 'fabric', samples: [row()], total: -1 }); await expect(sampleService.listSamples({ scope: 'fabric' })).rejects.toThrow('分线响应不一致'); });
  it('known lane without exact origin remains its business lane', async () => { const sample = { ...row('resolved', 'garment'), sourceContext: { status: 'unresolved', currentUsable: false } }; respond({ scope: 'garment', samples: [sample], total: 201 }); await expect(sampleService.listSamples({ scope: 'garment', limit: 50, offset: 50 })).resolves.toMatchObject({ samples: [sample], total: 201 }); });
  it('scope absent preserves other existing generic callers', async () => { respond({ samples: [{ id: 'legacy' }], total: 300 }); await expect(sampleService.listSamples({ search: 'legacy' })).resolves.toEqual({ samples: [{ id: 'legacy' }], total: 300 }); });
  it('a Case filter is encoded with scope/page and requires the actual filtered count response', async () => {
    respond({ scope: 'garment', sourceCaseId: 'CASE/source 1', samples: [{ ...row('resolved', 'garment'), sourceCaseId: 'CASE/source 1' }], total: 203 });
    await expect(sampleService.listSamples({ scope: 'garment', sourceCaseId: 'CASE/source 1', limit: 50, offset: 100 })).resolves.toMatchObject({ total: 203 });
    const query = new URL(String(vi.mocked(fetch).mock.calls[0][0])).searchParams;
    expect(query.get('sourceCaseId')).toBe('CASE/source 1'); expect(query.get('scope')).toBe('garment'); expect(query.get('offset')).toBe('100');
  });
  it.each([undefined, 'CASE-other'])('backend Case echo %j cannot masquerade as the requested source', async sourceCaseId => {
    respond({ scope: 'fabric', sourceCaseId, samples: [{ ...row(), sourceCaseId: 'CASE-1' }], total: 101 });
    await expect(sampleService.listSamples({ scope: 'fabric', sourceCaseId: 'CASE-1' })).rejects.toThrow(sourceCaseId ? '开发案筛选响应不一致' : '当前后台尚未支持按开发案筛选');
  });
  it('matching echo does not permit off-source rows or a fabricated count', async () => {
    for (const body of [{ samples: [{ ...row(), sourceCaseId: 'OTHER' }], total: 1 }, { samples: [], total: 1.5 }]) {
      respond({ scope: 'fabric', sourceCaseId: 'CASE-1', ...body });
      await expect(sampleService.listSamples({ scope: 'fabric', sourceCaseId: 'CASE-1' })).rejects.toThrow('开发案筛选响应不一致');
    }
  });
  it('a missing historic Case can be filtered in review without inventing a lane', async () => {
    const sample = { ...row('unresolved', null), sourceCaseId: 'MISSING-CASE' };
    respond({ scope: 'review', sourceCaseId: 'MISSING-CASE', samples: [sample], total: 205 });
    await expect(sampleService.listSamples({ scope: 'review', sourceCaseId: 'MISSING-CASE', offset: 200, limit: 50 })).resolves.toEqual({ samples: [sample], total: 205 });
  });
  it('existing source-only readers also refuse an old backend that ignored the Case filter', async () => {
    respond({ samples: [{ id: 'wrong-source', sourceCaseId: 'OTHER' }], total: 300 });
    await expect(sampleService.listSamples({ sourceCaseId: 'CASE-1' })).rejects.toThrow('当前后台尚未支持按开发案筛选');
  });
});
