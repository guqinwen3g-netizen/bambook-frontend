import { afterEach, describe, expect, it, vi } from 'vitest';
import { businessDateKey, businessNowDate, businessNowMs, businessTodayKey, getBusinessClock, installBusinessClock, resetBusinessClock, FIXED_BUSINESS_TIME_ISO, localDateKey, todayLocalKey, isValidLocalDateKey } from './businessClock';

const fixed = () => ({ mode: 'fixed' as const, nowIso: FIXED_BUSINESS_TIME_ISO, timeZone: 'Asia/Shanghai' as const, database: 'panda_hub_dev' });
afterEach(() => { resetBusinessClock(); vi.useRealTimers(); vi.unstubAllEnvs(); });
describe('frontend business time', () => {
  it('uses wall time until a trusted runtime clock is installed', () => {
    const before = Date.now(); expect(getBusinessClock().mode).toBe('wall');
    expect(businessNowMs()).toBeGreaterThanOrEqual(before);
  });
  it('freezes all callers at the server instant and business timezone without patching Date', () => {
    const originalDate = Date; installBusinessClock(fixed());
    expect(businessNowDate().toISOString()).toBe(FIXED_BUSINESS_TIME_ISO);
    expect(businessTodayKey()).toBe('2026-10-08');
    expect(businessDateKey(new Date('2026-10-07T16:05:00.000Z'))).toBe('2026-10-08');
    expect(Date).toBe(originalDate);
    expect(new Date('2026-09-01T05:12:00.000Z').toISOString()).toBe('2026-09-01T05:12:00.000Z');
  });
  it('keeps process time running, with fixed business time shared by successive role sessions', async () => {
    installBusinessClock(fixed()); const salesNow = businessNowMs(), before = Date.now();
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(Date.now()).toBeGreaterThan(before);
    expect(businessNowMs()).toBe(salesNow);
    const mutable = businessNowDate(); mutable.setUTCFullYear(1999);
    expect(businessNowMs()).toBe(salesNow);
  });
  it('does not turn the server wall snapshot into a frozen client clock', () => {
    vi.useFakeTimers(); vi.setSystemTime('2031-01-02T00:00:00.000Z');
    installBusinessClock({ mode: 'wall', nowIso: '2020-01-01T00:00:00.000Z', timeZone: 'Asia/Shanghai', database: 'production' });
    expect(businessNowDate().toISOString()).toBe('2031-01-02T00:00:00.000Z');
    vi.advanceTimersByTime(1000); expect(businessNowDate().toISOString()).toBe('2031-01-02T00:00:01.000Z');
  });
  it('keeps frontend-compatible historical date validation independent of the fixed today', () => {
    installBusinessClock(fixed()); const old = new Date(2024, 1, 29, 12);
    expect(todayLocalKey()).toBe('2026-10-08'); expect(localDateKey(old)).toBe('2024-02-29');
    expect(isValidLocalDateKey('2024-02-29')).toBe(true); expect(isValidLocalDateKey('2026-02-29')).toBe(false);
    expect(isValidLocalDateKey('2026-10-08T00:18:00Z')).toBe(false);
  });
  it('uses Shanghai dates even when a browser or test runtime has a different timezone', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles'); installBusinessClock(fixed());
    expect(businessTodayKey()).toBe('2026-10-08');
    expect(localDateKey(new Date('2026-09-19T17:00:00.000Z'))).toBe('2026-09-20');
    expect(isValidLocalDateKey('2024-02-29')).toBe(true);
  });
  it.each([
    { ...fixed(), nowIso: '2026-10-09T00:18:00.000Z' },
    { ...fixed(), timeZone: 'UTC' },
    { ...fixed(), database: 'panda_hub_local' },
    { ...fixed(), mode: 'unknown' },
    { ...fixed(), mode: { toString: () => 'fixed' } },
  ])('rejects invalid clock facts before installing them', value => {
    expect(() => installBusinessClock(value)).toThrow();
    expect(getBusinessClock().mode).toBe('wall');
  });
});
