import { businessNowDate, BUSINESS_TIME_ZONE } from './businessClock';

/** Follow the installed business clock, including the simulation's frozen time. */
export function currentWorkdayGreeting(): string {
    try {
        const hour = Number(new Intl.DateTimeFormat('en-GB', {
            timeZone: BUSINESS_TIME_ZONE, hour: '2-digit', hourCycle: 'h23',
        }).format(businessNowDate()));
        return workdayGreeting(hour);
    } catch {
        // Clock verification belongs to bootstrap; never guess a local-time greeting.
        return '你好';
    }
}

/** Receives an hour already projected into the business timezone. */
export function workdayGreeting(hour: number): string {
    if (hour < 6) return '夜深了';
    if (hour < 12) return '上午好';
    if (hour < 14) return '中午好';
    if (hour < 18) return '下午好';
    return '晚上好';
}

export function workdaySummary({ loading, stale, partial, total, overdue, today, todo }: {
    loading: boolean; stale: boolean; partial: boolean; total: number; overdue: number; today: number; todo: number;
}): string {
    if (stale) return '工作清单需要更新，重新读取后再继续。';
    if (loading) return '正在整理你的工作事项…';
    const scope = partial ? '已读取的事项中，' : '';
    if (overdue) return `${scope}有 ${overdue} 项已逾期，先关注这些事项。`;
    if (today) return `${scope}有 ${today} 项今天到期，可以从这里开始。`;
    if (todo) return `${scope}有 ${todo} 项待你处理，按自己的节奏逐项推进。`;
    if (total) return `${scope}暂时没有待办，可以看看在手业务的新进展。`;
    if (partial) return '还有部分来源尚未读取完整，暂时无法确认全部工作。';
    return '当前读取范围内没有待处理事项。愿你今天从容有序。';
}
