import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({ active: 'panda_hub_dev' }));
vi.mock('../../devPanel/activeDb', () => ({ getActiveDb: () => database.active }));
import { assertBusinessClockConfiguration, businessNowDate, businessNowMs, getBusinessClock, FIXED_BUSINESS_TIME_ISO } from '../businessClock';
import { localDateKey, todayLocalKey } from '../localDate';

beforeEach(() => {
  database.active = 'panda_hub_dev';
  vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('BAMBOOK_DEV_PANEL', '1');
  vi.stubEnv('DATABASE_URL', 'postgresql://clock-test:unused@127.0.0.1:1/panda_hub_dev');
  vi.stubEnv('BAMBOOK_DEV_BUSINESS_TIME', '2026-10-08T00:18:00.000Z');
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('dev business clock stays separate from process time and stored facts', () => {
  it('freezes only the approved instant in the exact guarded development database', () => {
    expect(() => assertBusinessClockConfiguration()).not.toThrow();
    expect(getBusinessClock()).toEqual({ mode: 'fixed', nowIso: FIXED_BUSINESS_TIME_ISO, timeZone: 'Asia/Shanghai', database: 'panda_hub_dev' });
    expect(businessNowMs()).toBe(Date.parse(FIXED_BUSINESS_TIME_ISO));
    expect(todayLocalKey()).toBe('2026-10-08');
  });
  it('returns fresh Date objects and does not rewrite the meaning of Date(value)', () => {
    const old = new Date('2026-09-20T04:30:00.000Z');
    const frozen = businessNowDate(); frozen.setFullYear(2001);
    expect(businessNowDate().toISOString()).toBe(FIXED_BUSINESS_TIME_ISO);
    expect(old.toISOString()).toBe('2026-09-20T04:30:00.000Z');
    expect(localDateKey(old)).toBe('2026-09-20');
  });
  it('lets real process time advance while the business instant remains fixed', async () => {
    const dateConstructor = Date, before = Date.now();
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(Date).toBe(dateConstructor); expect(Date.now()).toBeGreaterThan(before);
    expect(businessNowMs()).toBe(Date.parse(FIXED_BUSINESS_TIME_ISO));
  });
  it('projects 08:18 in Shanghai after guarded startup even if the process began in UTC', () => {
    vi.stubEnv('TZ', 'UTC'); const old = new Date('2026-09-19T17:00:00.000Z'), epoch = old.getTime();
    expect(localDateKey(old)).toBe('2026-09-20');
    assertBusinessClockConfiguration();
    expect(process.env.TZ).toBe('Asia/Shanghai');
    expect(businessNowDate().getHours()).toBe(8); expect(businessNowDate().getMinutes()).toBe(18);
    expect(old.getTime()).toBe(epoch); expect(old.toISOString()).toBe('2026-09-19T17:00:00.000Z');
  });
  it('does not change timezone for a wall-clock runtime or a refused old database configuration', () => {
    vi.stubEnv('TZ', 'UTC'); vi.stubEnv('BAMBOOK_DEV_BUSINESS_TIME', '');
    assertBusinessClockConfiguration(); expect(process.env.TZ).toBe('UTC');
    vi.stubEnv('BAMBOOK_DEV_BUSINESS_TIME', FIXED_BUSINESS_TIME_ISO); database.active = 'panda_hub_local';
    expect(getBusinessClock().mode).toBe('wall');
    expect(() => assertBusinessClockConfiguration()).toThrow(); expect(process.env.TZ).toBe('UTC');
  });
  it.each(['panda_hub_local', 'panda_hub_empty', 'panda_hub_dev_copy'])('never freezes %s even when a fixed value is configured', active => {
    database.active = active;
    const before = Date.now(), clock = getBusinessClock();
    expect(clock.mode).toBe('wall'); expect(clock.database).toBe(active);
    expect(Date.parse(clock.nowIso)).toBeGreaterThanOrEqual(before);
    expect(() => assertBusinessClockConfiguration()).toThrow(/panda_hub_dev/);
  });
  it('never freezes production and explicitly rejects an attempted production freeze at startup', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(getBusinessClock().mode).toBe('wall');
    expect(() => assertBusinessClockConfiguration()).toThrow(/production/);
  });
  it('leaves an unconfigured development process on wall time', () => {
    vi.stubEnv('BAMBOOK_DEV_BUSINESS_TIME', '');
    expect(() => assertBusinessClockConfiguration()).not.toThrow();
    expect(getBusinessClock().mode).toBe('wall');
  });
  it.each([
    ['BAMBOOK_DEV_PANEL', '0'],
    ['DATABASE_URL', 'postgresql://clock-test:unused@remote.invalid:1/panda_hub_dev'],
    ['DATABASE_URL', 'postgresql://clock-test:unused@127.0.0.1:1/panda_hub_local'],
    ['DATABASE_URL', 'postgresql://clock-test:unused@127.0.0.1:1/panda_hub_dev?host=remote.invalid'],
    ['DATABASE_URL', 'not-a-database-url'],
    ['BAMBOOK_DEV_BUSINESS_TIME', '2026-10-09T00:18:00.000Z'],
  ])('rejects invalid %s without falling back to a pretend frozen clock', (key, value) => {
    vi.stubEnv(key, value);
    expect(() => assertBusinessClockConfiguration()).toThrow();
    expect(() => getBusinessClock()).toThrow();
  });
});
