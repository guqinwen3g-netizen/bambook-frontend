import { afterEach, describe, expect, it, vi } from 'vitest';
import { setOrderLineConfirmedSource } from './orderLineService';
vi.mock('./apiService', () => ({ apiService: {
  buildApiUrl: (path: string) => `http://native.invalid/api${path}`,
  getAuthHeaders: () => ({ Authorization: 'Bearer synthetic-current-token', 'Content-Type': 'application/json' }),
} }));
const source = { confirmedSourceType: 'SealSample', confirmedSourceId: 'SEAL-1' } as const;
afterEach(() => vi.unstubAllGlobals());
function response(status: number, body: unknown) {
  const transport = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', transport); return transport;
}
describe('confirmed source transport denial preserves the real version contract', () => {
  it('the actual legacy role 403 gives a manager handoff rather than a generic retry', async () => {
    const transport = response(403, { error: 'FORBIDDEN', message: 'Insufficient role.' });
    await expect(setOrderLineConfirmedSource('LINE-1', source)).rejects.toMatchObject({
      status: 403, code: 'FORBIDDEN', message: '当前账号不能确认来源，请交由主管确认。',
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]).toEqual([expect.stringContaining('/order-lines/LINE-1/version'), expect.objectContaining({ method: 'PATCH', body: JSON.stringify(source) })]);
  });
  it.each([
    [403, 'FORBIDDEN', '当前账号无权操作该订单。'],
    [400, 'SOURCE_NOT_CONFIRMED', '该样品尚未确认，不能作为订单行来源。'],
  ])('structured HTTP %s retains the actual business refusal', async (status, code, message) => {
    response(status as number, { ok: false, error: { code, message } });
    await expect(setOrderLineConfirmedSource('LINE-1', source)).rejects.toMatchObject({ status, code, message });
  });
  it('503 retains its safe message even if a response also contains matching success-looking data', async () => {
    response(503, { ok: true, line: { id: 'LINE-1', ...source }, error: { code: 'AUTHORIZATION_UNAVAILABLE', message: '当前授权暂时无法核验，请稍后核对。' } });
    await expect(setOrderLineConfirmedSource('LINE-1', source)).rejects.toMatchObject({ status: 503, code: 'AUTHORIZATION_UNAVAILABLE', message: '当前授权暂时无法核验，请稍后核对。' });
  });
  it('a flat scope denial keeps the actual reason instead of redirecting an already-authorized manager', async () => {
    response(403, { error: 'FORBIDDEN', message: 'Missing required permission: orders:write' });
    await expect(setOrderLineConfirmedSource('LINE-1', source)).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN', message: 'Missing required permission: orders:write' });
  });
  it('a successful HTTP response with another source still cannot be treated as the requested write', async () => {
    response(200, { ok: true, line: { id: 'LINE-1', ...source, confirmedSourceId: 'OTHER-SEAL' } });
    await expect(setOrderLineConfirmedSource('LINE-1', source)).rejects.toThrow('确认来源的保存结果暂时无法核对');
  });
});
