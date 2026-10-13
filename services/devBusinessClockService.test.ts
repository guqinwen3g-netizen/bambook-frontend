import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ endpoint: 'http://clock.invalid/api' }));
vi.mock('./authService', () => ({ getAuthApiBase: () => native.endpoint }));
import { initializeDevBusinessClock } from './devBusinessClockService';
import { businessNowMs, getBusinessClock, resetBusinessClock, FIXED_BUSINESS_TIME_ISO } from '../lib/businessClock';

const status = () => ({ ok: true, devPanelEnabled: true, currentDb: 'panda_hub_dev', env: { nodeEnv: 'development', devPanel: true },
  businessClock: { mode: 'fixed', nowIso: FIXED_BUSINESS_TIME_ISO, timeZone: 'Asia/Shanghai', database: 'panda_hub_dev' } });
const response = (data: unknown, code = 200) => new Response(JSON.stringify(data), { status: code });
const transport = (data: unknown, code = 200) => vi.fn<typeof fetch>(async () => response(data, code));
beforeEach(() => { native.endpoint = 'http://clock.invalid/api'; resetBusinessClock(); });
afterEach(() => { resetBusinessClock(); vi.restoreAllMocks(); });
describe('development business clock bootstrap handshake', () => {
  it('reads the guarded server clock before a business consumer starts', async () => {
    const fetchImpl = transport(status());
    await initializeDevBusinessClock({ fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith('http://clock.invalid/api/dev/status', expect.objectContaining({ method: 'GET', cache: 'no-store', credentials: 'include' }));
    expect(getBusinessClock()).toEqual(status().businessClock);
    expect(businessNowMs()).toBe(Date.parse(FIXED_BUSINESS_TIME_ISO));
  });
  it('accepts the same fixed clock across actual account switches without using user-supplied dates', async () => {
    await initializeDevBusinessClock({ fetchImpl: transport({ ...status(), account: 'sales' }) }); const salesNow = businessNowMs();
    await initializeDevBusinessClock({ fetchImpl: transport({ ...status(), account: 'qc' }) });
    expect(businessNowMs()).toBe(salesNow);
  });
  it('uses an explicit production 404 as wall time', async () => {
    const value = await initializeDevBusinessClock({ fetchImpl: transport({ error: 'NOT_FOUND' }, 404) });
    expect(value.mode).toBe('wall'); expect(getBusinessClock().mode).toBe('wall');
  });
  it('keeps a 404 wall-clock installation bound to the endpoint that supplied it', async () => {
    await initializeDevBusinessClock({ fetchImpl: transport({ error: 'NOT_FOUND' }, 404) });
    native.endpoint = 'http://other.invalid/api';
    expect(() => getBusinessClock()).toThrow(/地址已变化/);
  });
  it('blocks business consumers during revalidation and after a failed revalidation', async () => {
    await initializeDevBusinessClock({ fetchImpl: transport(status()) });
    let release!: (value: Response) => void;
    const pending = initializeDevBusinessClock({ fetchImpl: vi.fn<typeof fetch>(() => new Promise<Response>(resolve => { release = resolve; })) });
    const rejected = expect(pending).rejects.toThrow(/HTTP 503/);
    expect(() => getBusinessClock()).toThrow(/正在核验/);
    release(response({ error: 'UNAVAILABLE' }, 503)); await rejected;
    expect(() => getBusinessClock()).toThrow(/尚未核验/);
    expect(() => getBusinessClock()).toThrow(/尚未核验/);
    await initializeDevBusinessClock({ fetchImpl: transport(status()) });
    expect(getBusinessClock().mode).toBe('fixed');
  });
  it('invalidates a previously installed clock when the active endpoint changes after bootstrap', async () => {
    await initializeDevBusinessClock({ fetchImpl: transport(status()) });
    native.endpoint = 'http://another-environment.invalid/api';
    expect(() => businessNowMs()).toThrow(/地址已变化/);
    expect(() => businessNowMs()).toThrow(/地址已变化/);
    await initializeDevBusinessClock({ fetchImpl: transport({ error: 'NOT_FOUND' }, 404) });
    expect(getBusinessClock().mode).toBe('wall');
  });
  it.each([401, 403, 500, 503])('rejects HTTP %s instead of mounting a fake frozen business workspace', async code => {
    await expect(initializeDevBusinessClock({ fetchImpl: transport(status(), code) })).rejects.toThrow(/业务时间/);
  });
  it('rejects a network failure instead of silently using the laptop date', async () => {
    await expect(initializeDevBusinessClock({ fetchImpl: vi.fn<typeof fetch>(async () => { throw Error('offline'); }) })).rejects.toThrow(/业务时间/);
  });
  it.each([
    () => ({ ...status(), ok: false }),
    () => ({ ...status(), currentDb: 'panda_hub_empty' }),
    () => ({ ...status(), devPanelEnabled: false }),
    () => ({ ...status(), env: { nodeEnv: 'production', devPanel: true } }),
    () => ({ ...status(), env: { nodeEnv: 'development', devPanel: false } }),
    () => ({ ...status(), businessClock: { ...status().businessClock, nowIso: '2026-10-09T00:18:00.000Z' } }),
    () => ({ ...status(), businessClock: { ...status().businessClock, timeZone: 'UTC' } }),
    () => ({ ...status(), businessClock: null }),
  ])('refuses an unverified fixed status DTO', make => {
    return expect(initializeDevBusinessClock({ fetchImpl: transport(make()) })).rejects.toThrow(/业务时间/);
  });
  it('does not allow an older endpoint response to replace a newer runtime clock', async () => {
    let release!: (value: Response) => void;
    const old = initializeDevBusinessClock({ fetchImpl: vi.fn<typeof fetch>(() => new Promise<Response>(resolve => { release = resolve; })) });
    const rejected = expect(old).rejects.toThrow(/已变化/);
    native.endpoint = 'http://new-clock.invalid/api';
    await initializeDevBusinessClock({ fetchImpl: transport(status()) });
    release(response({ ...status(), businessClock: { mode: 'wall', nowIso: new Date().toISOString(), timeZone: 'Asia/Shanghai', database: 'panda_hub_dev' } }));
    await rejected; expect(getBusinessClock().mode).toBe('fixed');
  });
});
