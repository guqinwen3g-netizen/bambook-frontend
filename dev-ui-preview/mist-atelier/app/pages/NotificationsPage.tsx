/** 通知中心（菜单外，从顶栏通知抽屉进入）：未读 / 全部、按类型筛选、全部已读、直达对象；订阅设置跳到设置 · 通知。
 *  通知来自当前工作空间的业务记录；按当前账号可查看的模块和已开启的通知类别显示，不发送邮件或外部消息。 */
import React from 'react';
import { ArrowUpRight, CheckCheck, Settings2 } from 'lucide-react';
import { Banner, Button, Card, DataTable, EmptyState, MistPage, ObjectCell, PageHeader, Pill, SearchField, Segmented, Tabs, Toolbar, useToast, type Column, type Tone } from '../../../../components/mist';
import type { MistNotification } from '../../../../server/src/shared/mistWorkspace';
import type { View } from '../../../../types';
import { useNav } from '../nav';
import { useMistSession } from '../runtime/auth';
import { useMistWorkspace } from '../runtime/workspace';
import { visibleMistNotifications } from '../runtime/notificationPreferences';

export type NotificationTab = 'unread' | 'all';
type Category = NonNullable<MistNotification['category']>;
export const NOTIFICATION_CATEGORY_LABEL: Record<Category, string> = { qc: 'QC 报告', shipping: '出运', suggestion: '小竹建议', general: '工作' };
const TONE: Record<Category, Tone> = { qc: 'accent', shipping: 'ok', suggestion: 'neutral', general: 'neutral' };
const category = (n: MistNotification): Category => n.category ?? 'general';
const when = (at: string) => { const d = new Date(at); return Number.isNaN(d.getTime()) ? at : d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); };

export function notificationRows(rows: MistNotification[], tab: NotificationTab, kind: 'all' | Category, query: string) {
  const q = query.trim().toLowerCase();
  return rows.filter(n => (tab === 'all' || !n.readAt) && (kind === 'all' || category(n) === kind) && (!q || (n.title + ' ' + n.detail).toLowerCase().includes(q)))
    .slice().sort((a, b) => b.at.localeCompare(a.at));
}

export function NotificationsPage() {
  const workspace = useMistWorkspace(), session = useMistSession(), { route, go } = useNav(), toast = useToast(), state = workspace.state;
  const tab: NotificationTab = route.section === 'all' ? 'all' : 'unread';
  const [kind, setKind] = React.useState<'all' | Category>('all'), [query, setQuery] = React.useState(''), [error, setError] = React.useState('');
  const visible = visibleMistNotifications(state, view => session.canAccessView(view as View));
  const unread = visible.filter(n => !n.readAt).length;
  const shown = notificationRows(visible, tab, kind, query);
  const kinds = (Object.keys(NOTIFICATION_CATEGORY_LABEL) as Category[]).filter(c => visible.some(n => category(n) === c));
  const prefs = state?.settings.notifications, off = prefs ? [!prefs.qc && 'QC 报告回传', !prefs.shipping && '出运准备提醒', !prefs.suggestions && '小竹主动建议'].filter(Boolean) as string[] : [];
  const busy = workspace.saving || !!workspace.pending;
  const report = (failure: unknown) => { const message = failure instanceof Error ? failure.message : '操作未完成，请重试'; setError(message); toast(message, 'bad'); };
  const canOpen = (n: MistNotification) => !!n.target?.view && session.canAccessView(n.target.view.split('/')[0] as View);
  const open = (n: MistNotification) => {
    if (busy) return;
    void (n.readAt ? Promise.resolve() : workspace.run({ type: 'notification.read', payload: { id: n.id } }))
      .then(() => { if (canOpen(n)) go(n.target.view, n.target.id, n.target); }).catch(report);
  };
  const readAll = () => { setError(''); void workspace.run({ type: 'notification.readAll', payload: {} }).then(() => toast('已全部标为已读')).catch(report); };
  const columns: Column<MistNotification>[] = [
    { key: 'title', header: '通知', width: 'minmax(240px,3fr)', render: n => <ObjectCell name={n.readAt ? n.title : <strong>{n.title}</strong>} meta={n.detail} /> },
    { key: 'kind', header: '类型', width: '104px', hideOnMobile: true, render: n => <Pill tone={TONE[category(n)]}>{NOTIFICATION_CATEGORY_LABEL[category(n)]}</Pill> },
    { key: 'at', header: '时间', width: '120px', hideOnMobile: true, render: n => <span className="mist-num">{when(n.at)}</span> },
    { key: 'state', header: '状态', width: '88px', render: n => <Pill tone={n.readAt ? 'neutral' : 'warn'}>{n.readAt ? '已读' : '未读'}</Pill> },
    { key: 'open', header: '', width: '96px', render: n => <Button size="sm" variant="quiet" iconRight={ArrowUpRight} disabled={busy || !canOpen(n)} title={canOpen(n) ? undefined : '当前账号没有该对象的查看权限'} onClick={event => { event.stopPropagation(); open(n); }}>{canOpen(n) ? '打开' : '无权限'}</Button> },
  ];
  return <MistPage>
    <PageHeader eyebrow="我的事务 · 通知" title="通知中心" description="当前工作空间的业务提醒。打开一条会标为已读并直达对应对象；不发送邮件或外部消息。"
      actions={<><Button icon={Settings2} onClick={() => go('settings', undefined, { section: 'notify' })}>通知订阅</Button>
        <Button variant="primary" icon={CheckCheck} disabled={busy || !unread} loading={workspace.saving} onClick={readAll}>全部标为已读</Button></>} />
    {error && <Banner tone="bad" title={error} actions={<Button size="sm" onClick={() => setError('')}>知道了</Button>} />}
    {!!off.length && <Banner tone="neutral" title={`已关闭：${off.join('、')}`} actions={<Button size="sm" onClick={() => go('settings', undefined, { section: 'notify' })}>去设置</Button>}>这些类别的通知不在这里显示，重新开启后会恢复显示。</Banner>}
    <Tabs<NotificationTab> value={tab} onChange={next => go('notifications', undefined, { section: next })} options={[{ value: 'unread', label: '未读', count: unread }, { value: 'all', label: '全部', count: visible.length }]} />
    <Toolbar right={kinds.length > 1 ? <Segmented<'all' | Category> ariaLabel="通知类型" value={kind} onChange={setKind} options={[{ value: 'all', label: '全部' }, ...kinds.map(c => ({ value: c, label: NOTIFICATION_CATEGORY_LABEL[c] }))]} /> : undefined}>
      <SearchField value={query} onChange={setQuery} placeholder="搜索通知标题或内容" />
    </Toolbar>
    <Card><DataTable ariaLabel="通知" rows={shown} columns={columns} loading={!state && workspace.loading} rowKey={n => n.id} onRowClick={open}
      empty={<EmptyState title={query || kind !== 'all' ? '没有符合条件的通知' : tab === 'unread' ? '没有未读通知' : '暂无通知'} description="通知按当前账号可查看的模块显示。"
        action={query || kind !== 'all' ? <Button onClick={() => { setQuery(''); setKind('all'); }}>清除筛选</Button> : tab === 'unread' && visible.length ? <Button onClick={() => go('notifications', undefined, { section: 'all' })}>查看全部</Button> : undefined} />} /></Card>
  </MistPage>;
}
