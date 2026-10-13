import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentWorkdayGreeting, workdayGreeting, workdaySummary } from './workdayGreeting';
import { installBusinessClock, resetBusinessClock, beginBusinessClockVerification, FIXED_BUSINESS_TIME_ISO } from './businessClock';

afterEach(() => { resetBusinessClock(); vi.useRealTimers(); });

describe('workday greeting', () => {
    it('greets the fixed simulation at Shanghai 08:18 even when the computer is in the afternoon', () => {
        vi.useFakeTimers();
        vi.setSystemTime('2026-10-11T08:30:00.000Z');
        installBusinessClock({ mode: 'fixed', nowIso: FIXED_BUSINESS_TIME_ISO, timeZone: 'Asia/Shanghai', database: 'panda_hub_dev' });
        expect(currentWorkdayGreeting()).toBe('上午好');
        vi.advanceTimersByTime(12 * 60 * 60 * 1000);
        expect(currentWorkdayGreeting()).toBe('上午好');
    });
    it('projects wall-clock greetings into the business timezone, not the browser timezone', () => {
        vi.useFakeTimers();
        vi.setSystemTime('2026-10-08T00:18:00.000Z');
        expect(currentWorkdayGreeting()).toBe('上午好');
        vi.setSystemTime('2026-10-08T07:18:00.000Z');
        expect(currentWorkdayGreeting()).toBe('下午好');
    });
    it('uses a neutral greeting when business clock verification is pending', () => {
        beginBusinessClockVerification();
        expect(currentWorkdayGreeting()).toBe('你好');
    });
    it.each([[0, '夜深了'], [5, '夜深了'], [6, '上午好'], [11, '上午好'], [12, '中午好'], [13, '中午好'], [14, '下午好'], [17, '下午好'], [18, '晚上好'], [23, '晚上好']])('uses business hour %i', (hour, expected) => {
        expect(workdayGreeting(Number(hour))).toBe(expected);
    });
    const base = { loading: false, stale: false, partial: false, total: 6, overdue: 0, today: 0, todo: 2 };
    it('prioritizes stale and loading states over cached counts', () => {
        expect(workdaySummary({ ...base, stale: true, overdue: 2 })).toContain('需要更新');
        expect(workdaySummary({ ...base, loading: true, overdue: 2 })).toContain('正在整理');
    });
    it('prioritizes overdue, then today, then actions', () => {
        expect(workdaySummary({ ...base, overdue: 2, today: 3 })).toContain('2 项已逾期');
        expect(workdaySummary({ ...base, today: 3 })).toContain('3 项今天到期');
        expect(workdaySummary(base)).toContain('2 项待你处理');
    });
    it('never describes incomplete empty sources as no work', () => {
        expect(workdaySummary({ ...base, total: 0, todo: 0, partial: true })).toContain('无法确认');
        expect(workdaySummary({ ...base, partial: true })).toContain('已读取的事项中');
        expect(workdaySummary({ ...base, total: 0, todo: 0 })).toContain('当前读取范围内');
    });
});
