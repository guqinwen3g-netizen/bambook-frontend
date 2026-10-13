import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../shared/businessClock', () => ({ businessNowDate: () => new Date('2026-10-08T00:18:00.000Z') }));
vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { SchedulerService } from '../schedulerService';

afterEach(() => vi.useRealTimers());
describe('fixed business calendar and advancing operational scheduler time', () => {
  it('keeps reminders on the scenario date while real polling and cleanup continue after weeks pass', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-03-01T10:00:00Z'));
    const scheduler = new SchedulerService({} as any, 1000);
    const businessSeen: string[] = [], wallSeen: string[] = [];
    let businessBucket = '', wallBucket = '';
    const businessRun = vi.fn(async () => undefined), wallRun = vi.fn(async () => undefined);
    scheduler.register({ id: 'overdue-reminder', shouldRun: now => {
      businessSeen.push(now.toISOString());
      const bucket = now.toISOString().slice(0, 10);
      if (bucket === businessBucket) return false;
      businessBucket = bucket; return true;
    }, run: businessRun });
    scheduler.register({ id: 'operational-cleanup', timeDomain: 'wall', shouldRun: now => {
      wallSeen.push(now.toISOString());
      const bucket = now.toISOString().slice(0, 10);
      if (bucket === wallBucket) return false;
      wallBucket = bucket; return true;
    }, run: wallRun });
    try {
      scheduler.start();
      await vi.advanceTimersByTimeAsync(1000);
      vi.setSystemTime(new Date('2027-04-01T10:00:00Z'));
      await vi.advanceTimersByTimeAsync(1000);
      expect(new Set(businessSeen)).toEqual(new Set(['2026-10-08T00:18:00.000Z']));
      expect(wallSeen.some(value => value.startsWith('2027-04-01'))).toBe(true);
      expect(businessRun).toHaveBeenCalledTimes(1);
      expect(wallRun).toHaveBeenCalledTimes(2);
    } finally { scheduler.stop(); }
  });
});
