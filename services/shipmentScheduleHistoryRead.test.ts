import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ getStoredConfig: vi.fn(), getAuthHeaders: vi.fn(), buildApiUrl: vi.fn() }));
vi.mock('./apiService', () => ({ apiService: api }));
import { shipmentService } from './shipmentService';
const row = { auditId: 'AUD-original', field: 'etd', fieldLabel: '预计离港(ETD)', fromValue: '2026-10-10', toValue: '2026-10-12',
  description: '预计离港(ETD) 2026-10-10 → 2026-10-12', actorId: 'USR-original', at: '2026-10-03T00:00:00.000Z', transactionId: 'TX-original' };
const body = () => ({ shipmentId: 'SH/original', count: 1, changes: [{ ...row }] });
const reply = (data: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
beforeEach(() => { vi.clearAllMocks(); api.getStoredConfig.mockReturnValue({ cloudEndpoint: 'https://history.invalid' }); api.getAuthHeaders.mockReturnValue({ Authorization: 'Bearer synthetic-original' }); api.buildApiUrl.mockImplementation((p: string, base: string) => base + '/api' + p); });
afterEach(() => vi.unstubAllGlobals());
describe('shipment history original-target DTO boundary', () => {
  it('keeps the original endpoint, headers and datesOnly/limit, preserving description actor and time', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(body())));
    expect(await shipmentService.getShipmentScheduleHistory('SH/original', { datesOnly: true, limit: 25 }, 'https://original.invalid')).toEqual(body());
    expect(fetch).toHaveBeenCalledWith('https://original.invalid/api/v1/shipping/SH%2Foriginal/schedule-history?datesOnly=1&limit=25', { headers: { Authorization: 'Bearer synthetic-original' } });
  });
  it('accepts a verified empty history and nullable original fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ shipmentId: 'SH/original', count: 0, changes: [] })));
    expect((await shipmentService.getShipmentScheduleHistory('SH/original')).changes).toEqual([]);
    vi.stubGlobal('fetch', vi.fn(async () => reply({ shipmentId: 'SH/original', count: 1, changes: [{ ...row, actorId: null, at: null, transactionId: null, fromValue: null, toValue: null }] })));
    expect((await shipmentService.getShipmentScheduleHistory('SH/original')).changes[0].actorId).toBeNull();
  });
  it.each(['wrong-target','missing-target','count','negative-count','missing-changes','bad-change','duplicate-audit','actor','at','description','non-json-value','extra-top','extra-row'])(
    'rejects %s data before publishing a history', async kind => {
      const data: any = body();
      if (kind === 'wrong-target') data.shipmentId = 'SH-other'; if (kind === 'missing-target') delete data.shipmentId;
      if (kind === 'count') data.count = 2; if (kind === 'negative-count') data.count = -1; if (kind === 'missing-changes') delete data.changes;
      if (kind === 'bad-change') data.changes = [null]; if (kind === 'duplicate-audit') { data.changes.push({ ...row }); data.count = 2; }
      if (kind === 'actor') data.changes[0].actorId = 10; if (kind === 'at') data.changes[0].at = 'not-a-time'; if (kind === 'description') delete data.changes[0].description;
      if (kind === 'non-json-value') data.changes[0].toValue = BigInt(2); if (kind === 'extra-top') data.internalUsers = ['unrelated']; if (kind === 'extra-row') data.changes[0].internal = 'unrelated';
      vi.stubGlobal('fetch', vi.fn(async () => reply(data))); await expect(shipmentService.getShipmentScheduleHistory('SH/original')).rejects.toThrow();
    });
  it.each([403,404,500,503])('HTTP %s failure cannot become empty success', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ error: { code: 'FAILED', message: 'synthetic denied' } }, status)));
    await expect(shipmentService.getShipmentScheduleHistory('SH/original')).rejects.toThrow(`HTTP ${status}`);
  });
  it('invalid JSON rejects without returning an empty fallback', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw Error('synthetic malformed JSON'); } })));
    await expect(shipmentService.getShipmentScheduleHistory('SH/original')).rejects.toThrow();
  });
});
