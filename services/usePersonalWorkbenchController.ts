import { useCallback, useEffect, useRef, useState } from 'react';
import { currentWorkdayGreeting, workdaySummary } from '../lib/workdayGreeting';
import { getAuthState, subscribe } from './authService';
import { dashboardReadIdentity, dashboardTaskService, type PersonalWorkbench, type WorkbenchGroup, type WorkbenchItem, type WorkbenchTarget } from './dashboardTaskService';

export interface PersonalWorkbenchControllerProps {
    readIdentity: string;
    readRevision?: number;
    onOpenTarget: (target: WorkbenchTarget) => void | Promise<void>;
}
export type QueueFilter = 'all' | 'today' | 'action' | 'risk' | 'follow-up';
export type WorkbenchSectionKey = 'todo' | 'waiting' | 'risk' | 'in-hand' | 'team';
export const workbenchSections: Array<{ key: WorkbenchSectionKey; label: string }> = [
    { key: 'todo', label: '轮到我处理' },
    { key: 'waiting', label: '等待协作' },
    { key: 'risk', label: '异常与逾期' },
    { key: 'in-hand', label: '在手业务' },
    { key: 'team', label: '团队可见与专业待领取' },
];
export const filterLabels: Record<QueueFilter, string> = { all: '全部事项', today: '今天与逾期', action: '我的待办', risk: '异常与风险', 'follow-up': '业务跟进' };
const RESPONSIBILITY_RANK: Record<WorkbenchItem['responsibility']['kind'], number> = { 'assigned-to-me': 0, 'my-review-step': 1, 'owned-by-me': 2, 'scope-visible': 3, 'unknown': 4 };
const TIME_RANK: Record<WorkbenchItem['timeBucket'], number> = { overdue: 0, today: 1, later: 2, undated: 3 };
const priority: Record<string, string[]> = {
    'role-sales': ['development-expenses', 'development', 'samples', 'quotations', 'orders'],
    'role-sales-manager': ['workflow', 'approvals', 'orders', 'development', 'development-expenses'],
    'role-qc': ['qc', 'orders', 'samples'],
    'role-logistics': ['shipments', 'inventory', 'orders'],
    'role-finance': ['finance-handoffs', 'invoices', 'workflow'],
    'role-admin': ['approvals', 'workflow', 'orders', 'claims'],
    'role-super-admin': ['orders', 'invoices', 'approvals', 'workflow', 'claims'],
};
export function workbenchSectionsFor(item: WorkbenchItem): WorkbenchSectionKey[] {
    const sections: WorkbenchSectionKey[] = [];
    if (item.bucket === 'follow-up') sections.push('waiting');
    if (item.responsibility.kind === 'assigned-to-me' || item.responsibility.kind === 'my-review-step') sections.push('todo');
    else if (item.responsibility.kind === 'owned-by-me') {
        if (item.bucket === 'action' && item.target && !item.blockedReason) sections.push('todo');
        else sections.push('in-hand');
    }
    else if (item.responsibility.kind === 'scope-visible') {
        if (item.bucket === 'action' && item.target && !item.blockedReason && !item.kind.endsWith('-pool')) sections.push('todo');
        else sections.push('team');
    }
    if (item.bucket === 'risk' || item.timeBucket === 'overdue' || item.responsibility.kind === 'unknown') sections.push('risk');
    return sections;
}
function matches(item: WorkbenchItem, filter: QueueFilter) {
    return filter === 'all'
        || filter === 'today' && ['overdue', 'today'].includes(item.timeBucket)
        || filter === 'action' && workbenchSectionsFor(item).includes('todo')
        || filter === 'risk' && workbenchSectionsFor(item).includes('risk')
        || filter === 'follow-up' && item.bucket === 'follow-up';
}
function sourceKey(item: WorkbenchItem) { return JSON.stringify([item.source.type, item.source.id]); }
function urgencyCompare(a: WorkbenchItem, b: WorkbenchItem) {
    const urgencyRank = (item: WorkbenchItem) => item.timeBucket === 'overdue' ? 0 : item.timeBucket === 'today' ? 1 : item.blockedReason ? 2 : 3;
    const priorityDiff = urgencyRank(a) - urgencyRank(b);
    if (priorityDiff) return priorityDiff;
    const timeDiff = TIME_RANK[a.timeBucket] - TIME_RANK[b.timeBucket];
    if (timeDiff) return timeDiff;
    if (a.dueDate !== b.dueDate) {
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return a.dueDate.localeCompare(b.dueDate);
    }
    if (!!a.blockedReason !== !!b.blockedReason) return a.blockedReason ? 1 : -1;
    return RESPONSIBILITY_RANK[a.responsibility.kind] - RESPONSIBILITY_RANK[b.responsibility.kind];
}
function searchable(item: WorkbenchItem) {
    return [item.title, item.kind, item.reason, item.blockedReason, item.source.type, item.source.id, item.source.state, item.source.version,
        item.reference?.type, item.reference?.id, item.reference?.label,
        ...item.amounts.flatMap(amount => [amount.meaning, amount.currency, amount.amount])]
        .filter(Boolean).join(' ').toLocaleLowerCase();
}
function uniqueSourceItems(groups: WorkbenchGroup[]) {
    const selected = new Map<string, { item: WorkbenchItem; groupIndex: number; itemIndex: number }>();
    groups.forEach((group, groupIndex) => (group.items ?? []).forEach((item, itemIndex) => {
        const key = sourceKey(item), current = selected.get(key);
        if (!current || urgencyCompare(item, current.item) < 0 || urgencyCompare(item, current.item) === 0 && RESPONSIBILITY_RANK[item.responsibility.kind] < RESPONSIBILITY_RANK[current.item.responsibility.kind]) {
            selected.set(key, { item, groupIndex, itemIndex });
        }
    }));
    return [...selected.values()];
}
/** Owns the original workbench GET, actor fence, pagination and exact native navigation. */
export function usePersonalWorkbenchController({ readIdentity, readRevision = 0, onOpenTarget }: PersonalWorkbenchControllerProps) {
    const [data, setData] = useState<PersonalWorkbench | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
    const [stale, setStale] = useState(false), [identityInvalid, setIdentityInvalid] = useState(false), [filter, setFilter] = useState<QueueFilter>('all');
    const [greeting, setGreeting] = useState(currentWorkdayGreeting);
    useEffect(() => {
        const update = () => setGreeting(currentWorkdayGreeting());
        const timer = window.setInterval(update, 60000);
        window.addEventListener('focus', update);
        return () => { window.clearInterval(timer); window.removeEventListener('focus', update); };
    }, []);
    const [search, setSearch] = useState('');
    const [groupBusy, setGroupBusy] = useState<string | null>(null), [opening, setOpening] = useState<string | null>(null);
    const live = useRef(false), generation = useRef(0), invalidated = useRef(false), controller = useRef<AbortController | null>(null);
    const originalIdentity = useRef(dashboardReadIdentity()), renderedIdentity = useRef(readIdentity);
    const observedReadRevision = useRef(readRevision);
    renderedIdentity.current = readIdentity;
    const current = (run: number) => live.current && !invalidated.current && generation.current === run && renderedIdentity.current === readIdentity && dashboardReadIdentity() === originalIdentity.current;
    const load = useCallback(async (group?: WorkbenchGroup) => {
        if (invalidated.current || dashboardReadIdentity() !== originalIdentity.current)
            return;
        const run = ++generation.current;
        controller.current?.abort();
        const request = new AbortController();
        controller.current = request;
        if (group)
            setGroupBusy(group.key);
        else
            setLoading(true);
        setError('');
        try {
            const next = await dashboardTaskService.read(group ? { group: group.key, ...(group.nextCursor ? { cursor: group.nextCursor } : {}) } : {}, { signal: request.signal });
            if (!current(run))
                return;
            if (next.subject.userId !== getAuthState().user?.id)
                throw Error('账号已变化，请重新读取。');
            if (group) {
                const result = next.groups.find(g => g.key === group.key);
                if (!result)
                    throw Error('事项分组响应不完整，请重试。');
                setData(previous => previous ? { ...previous, generatedAt: next.generatedAt, groups: previous.groups.map(g => g.key === group.key ? result.status === 'ready' && group.nextCursor ? { ...result, items: [...(g.items ?? []), ...(result.items ?? []).filter(i => !g.items?.some(old => old.id === i.id))] } : result : g) } : previous);
            }
            else
                setData(next);
            if (!group)
                setStale(false);
        }
        catch (failure) {
            if (current(run)) {
                setError(failure instanceof Error ? failure.message : '个人工作台暂时无法读取，请重试。');
                setStale(true);
            }
        }
        finally {
            if (current(run)) {
                setLoading(false);
                setGroupBusy(null);
            }
        }
    }, [readIdentity]);
    useEffect(() => {
        live.current = true;
        invalidated.current = false;
        originalIdentity.current = dashboardReadIdentity();
        observedReadRevision.current = readRevision;
        generation.current++;
        setData(null);
        setIdentityInvalid(false);
        setStale(false);
        setError('');
        setOpening(null);
        setGroupBusy(null);
        const watch = () => { if (dashboardReadIdentity() !== originalIdentity.current && !invalidated.current) {
            invalidated.current = true;
            generation.current++;
            controller.current?.abort();
            setData(null);
            setLoading(false);
            setGroupBusy(null);
            setOpening(null);
            setIdentityInvalid(true);
            setError('账号、权限或服务地址已变化，请重新进入我的工作。');
        } };
        const stop = subscribe(watch);
        window.addEventListener('storage', watch);
        window.addEventListener('focus', watch);
        void load();
        return () => { live.current = false; generation.current++; controller.current?.abort(); stop(); window.removeEventListener('storage', watch); window.removeEventListener('focus', watch); };
    }, [readIdentity, load]);
    useEffect(() => {
        if (observedReadRevision.current === readRevision) return;
        observedReadRevision.current = readRevision;
        setStale(true);
        setOpening(null);
        void load();
    }, [readRevision, load]);
    const open = async (item: WorkbenchItem) => {
        if (!item.target || item.blockedReason || stale || loading || groupBusy || opening || invalidated.current)
            return;
        const run = generation.current;
        setOpening(item.id);
        setError('');
        try {
            if (!current(run))
                return;
            await onOpenTarget(item.target);
        }
        catch {
            if (current(run))
                setError('原事项暂时无法打开，请重试；来源或权限需要核对时请在原业务模块处理。');
        }
        finally {
            if (current(run))
                setOpening(null);
        }
    };
    const preferred = [...new Set((data?.subject.roleIds ?? []).flatMap(role => priority[role] ?? []))];
    const roleRank = (key: string) => { const index = preferred.indexOf(key); return index < 0 ? preferred.length : index; };
    const ordered = (data?.groups ?? []).slice().sort((a, b) => roleRank(a.key) - roleRank(b.key));
    const ready = ordered.filter(group => group.status === 'ready');
    const failed = ordered.filter(group => group.status === 'failed');
    const candidates = uniqueSourceItems(ready).filter(({ item }) => matches(item, filter) && (!search.trim() || searchable(item).includes(search.trim().toLocaleLowerCase())));
    candidates.sort((a, b) => urgencyCompare(a.item, b.item) || a.groupIndex - b.groupIndex || a.itemIndex - b.itemIndex);
    const itemsBySection = Object.fromEntries(workbenchSections.map(section => [section.key, candidates.filter(entry => workbenchSectionsFor(entry.item).includes(section.key))])) as Record<WorkbenchSectionKey, typeof candidates>;
    const readHasFailures = failed.length > 0;
    const loadedItems = uniqueSourceItems(ready).map(entry => entry.item);
    const partial = readHasFailures || ready.some(group => group.hasMore);
    const counts = {
        total: loadedItems.length,
        overdue: loadedItems.filter(item => item.timeBucket === 'overdue').length,
        today: loadedItems.filter(item => item.timeBucket === 'today').length,
        todo: loadedItems.filter(item => workbenchSectionsFor(item).includes('todo')).length,
        waiting: loadedItems.filter(item => workbenchSectionsFor(item).includes('waiting')).length,
        risk: loadedItems.filter(item => workbenchSectionsFor(item).includes('risk')).length,
    };
    const summary = data && !loading && !stale && !ready.length && !readHasFailures
        ? '当前账号没有已开放的工作来源。'
        : workdaySummary({ ...counts, partial, loading, stale });
    const focus = candidates.find(({ item }) => workbenchSectionsFor(item).includes('todo') && item.target && !item.blockedReason)?.item ?? null;
    const disabled = stale || loading || !!groupBusy || !!opening || identityInvalid;
    return { data, loading, error, stale, identityInvalid, greeting, filter, setFilter, search, setSearch, groupBusy, opening,
        load, open, ordered, ready, failed, candidates, itemsBySection, readHasFailures, partial, counts, summary, focus, disabled, loadedItems };
}
export type PersonalWorkbenchController = ReturnType<typeof usePersonalWorkbenchController>;
