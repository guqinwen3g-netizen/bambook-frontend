import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./apiService', () => ({ apiService: { getStoredConfig: () => ({ cloudEndpoint: 'http://private.invalid/api' }), buildApiUrl: (path: string, base: string) => base + path, getAuthHeaders: () => ({ Authorization: 'Bearer synthetic-not-native' }) } }));
import { sampleService } from './sampleService';
const group = { cardType: 'fabric', unit: 'M', inventoryState: 'active', cardRows: '351', quantity: '9007199254740993', availableQty: '9007199254740992', borrowedQty: '1' };
const body = (groups: any[] = [group]) => ({ complete: true, snapshotAt: '2026-10-04T06:00:00.000Z', sampleIds: ['S1'], summaries: [{ sampleId: 'S1', groups }] });
const respond = (data: unknown) => vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => data })));
afterEach(() => vi.unstubAllGlobals());
describe('S3C client complete stock response guards', () => {
  it('complete grouped snapshot keeps large counts as exact strings and native request headers', async () => { respond(body()); expect(await sampleService.getInventorySummary(['S1'])).toEqual(body()); expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer synthetic-not-native' } }); expect(new URL(String(vi.mocked(fetch).mock.calls[0][0])).searchParams.get('sampleIds')).toBe('S1'); });
  it('complete empty group is evidence of no cards', async () => { respond(body([])); expect((await sampleService.getInventorySummary(['S1'])).summaries[0].groups).toEqual([]); });
  it.each([{}, { ...body(), complete: false }, { ...body(), sampleIds: ['OTHER'] }, { ...body(), summaries: [] }, { ...body(), summaries: [{ sampleId: 'S1', groups: [{ ...group, borrowedQty: '-1' }] }] }, { ...body(), summaries: [{ sampleId: 'S1', groups: [{ ...group, quantity: 9007199254740992 }] }] }].map(value => [value]))('partial/mismatched/unsafe response cannot be called complete: %j', async value => { respond(value); await expect(sampleService.getInventorySummary(['S1'])).rejects.toThrow('库存汇总响应不完整'); });
  it('invalid or repeated request refuses before fetch', async () => { respond(body()); await expect(sampleService.getInventorySummary(['S1', 'S1'])).rejects.toThrow('样品编号'); expect(fetch).not.toHaveBeenCalled(); });
});
