/** Marketing workbench: existing workspace commands, reasoned transitions and source-preserving CRM handoff. */
import React from 'react';
import { Download, Pencil, Plus, RefreshCw, Users } from 'lucide-react';
import { Banner, Button, Card, DataTable, EmptyState, Facts, Kanban, MistPage, Mono, ObjectCell, PageHeader, Pill, SearchField, Segmented, Toolbar, type Column, type Tone } from '../../../../../components/mist';
import type { MarketCampaign, MarketLead } from '../../../../../server/src/shared/mistMarket';
import { marketBusinessDate } from '../../../../../server/src/shared/mistMarket';
import { useMistWorkspace } from '../../runtime/workspace';
import { useMistSession } from '../../runtime/auth';
import { useNav } from '../../nav';
import { ModuleEditorDialog, downloadModuleCsv, type ModuleEditorSpec } from './ModuleWorkbench';
import { useRouteDraft } from './useRouteDraft';
import { ActionBar, DetailBlock, DetailBody, ListDetail } from './pageKit';

export const CAMPAIGN_STATUS: Record<MarketCampaign['status'], { label: string; tone: Tone }> = {
  Draft: { label: '策划中', tone: 'neutral' }, Active: { label: '进行中', tone: 'accent' }, Paused: { label: '已暂停', tone: 'warn' }, Completed: { label: '已完成', tone: 'ok' }, Cancelled: { label: '已取消', tone: 'neutral' },
};
/** Mirrors the existing command's transition contract; no drag can skip a gate. Server remains authoritative. */
export const CAMPAIGN_NEXT: Record<MarketCampaign['status'], MarketCampaign['status'][]> = {
  Draft: ['Active', 'Cancelled'], Active: ['Paused', 'Completed', 'Cancelled'], Paused: ['Active', 'Completed', 'Cancelled'], Completed: [], Cancelled: [],
};
const transitionLabel: Partial<Record<MarketCampaign['status'], string>> = { Active: '开始 / 恢复活动', Paused: '暂停活动', Completed: '完成活动', Cancelled: '取消活动' };
export function campaignLeads(leads: MarketLead[], id: string) { return leads.filter(l => l.source === 'campaign' && l.parentId === id); }
export function leadOverdue(l: MarketLead, day: string) { return !['Converted', 'Lost'].includes(l.status) && !!l.followUpDate && l.followUpDate < day; }
export function campaignReminder(c: MarketCampaign, leads: MarketLead[], day: string) {
  const overdue = campaignLeads(leads, c.id).filter(l => leadOverdue(l, day)).length;
  return { overdue, ended: ['Active', 'Paused'].includes(c.status) && c.endDate < day, overBudget: Number(c.actualCost) > Number(c.budget) };
}

export function CampaignWorkbench({ tabs, input, onEdit, products, attachments, history }: {
  tabs: React.ReactNode; input: (c?: MarketCampaign) => ModuleEditorSpec; onEdit: (spec: ModuleEditorSpec) => void;
  products: (c: MarketCampaign, can: boolean) => React.ReactNode;
  attachments: (c: MarketCampaign, locked: boolean) => React.ReactNode; history: (id: string) => React.ReactNode;
}) {
  const w = useMistWorkspace(), session = useMistSession(), { route, go } = useNav();
  const [query, setQuery] = React.useState(''), [stage, setStage] = React.useState<'all' | MarketCampaign['status']>('all'), [mode, setMode] = React.useState<'list' | 'board'>('list');
  const [reminder, setReminder] = React.useState<'all' | 'overdue' | 'ended' | 'budget'>('all');
  const [dialog, setDialog] = useRouteDraft<ModuleEditorSpec | null>(null);
  const [drawer, setDrawer] = React.useState(!!route.id);
  React.useEffect(() => setDrawer(!!route.id), [route.id]);
  const campaigns = w.state?.market.campaigns || [], leads = w.state?.market.leads || [];
  const current = campaigns.find(c => c.id === route.id), day = marketBusinessDate(new Date()), can = session.hasPermission('marketing:write'), busy = w.saving || !!w.pending;
  const shown = campaigns.filter(c => {
    const r = campaignReminder(c, leads, day);
    return (stage === 'all' || c.status === stage) && (reminder === 'all' || (reminder === 'overdue' ? r.overdue > 0 : reminder === 'ended' ? r.ended : r.overBudget)) &&
      (!query.trim() || `${c.name} ${c.code} ${c.target} ${c.owner}`.toLowerCase().includes(query.trim().toLowerCase()));
  }).sort((a, b) => campaignReminder(b, leads, day).overdue - campaignReminder(a, leads, day).overdue || a.endDate.localeCompare(b.endDate));
  const pick = (c: MarketCampaign) => { setDrawer(true); go('marketing', c.id, { section: 'campaigns' }); };
  const reset = () => { setQuery(''); setStage('all'); setReminder('all'); };
  const transition = (c: MarketCampaign, next: MarketCampaign['status']) => {
    if (!can || busy || !CAMPAIGN_NEXT[c.status].includes(next)) return;
    setDialog({ title: `${transitionLabel[next]} · ${c.name}`, submitLabel: '确认', description: next === 'Completed' || next === 'Cancelled' ? '这是活动记录的终态，不能直接恢复。线索与客户业务仍保留；本操作不发送邮件或代表外部推广已执行。' : '只更新当前工作空间的活动状态，不发送邮件或启动外部推广。',
      initialValues: {}, fields: [], submit: () => w.run({ type: 'market.campaign.status', payload: { id: c.id, status: next } }) });
  };
  const columns: Column<MarketCampaign>[] = [
    { key: 'name', header: '活动 / 负责人', width: 'minmax(180px,1.4fr)', render: c => <ObjectCell name={c.name} meta={<><Mono>{c.code}</Mono> · {c.owner}</>} /> },
    { key: 'dates', header: '期间', width: '126px', hideOnMobile: true, render: c => <span className={campaignReminder(c, leads, day).ended ? 'mist-tone-warn' : ''}>{c.startDate} — {c.endDate}</span> },
    { key: 'leads', header: '线索 / 转 CRM', width: '98px', align: 'right', render: c => { const ls = campaignLeads(leads, c.id); return `${ls.length} / ${ls.filter(l => l.status === 'Converted').length}`; } },
    { key: 'status', header: '状态与提醒', width: '130px', render: c => { const r = campaignReminder(c, leads, day); return <span className="mist-col"><Pill tone={CAMPAIGN_STATUS[c.status].tone}>{CAMPAIGN_STATUS[c.status].label}</Pill>{r.overdue > 0 && <small className="mist-tone-bad">{r.overdue} 条跟进逾期</small>}{r.overBudget && <small className="mist-tone-warn">费用超预算</small>}</span>; } },
  ];
  const empty = <EmptyState title={campaigns.length ? '没有符合条件的活动' : '尚无营销活动'} description={campaigns.length ? '调整搜索、状态或提醒筛选。' : '创建活动，登记实际预算、负责人和来源线索。'} action={campaigns.length ? <Button onClick={reset}>清除筛选</Button> : can ? <Button onClick={() => onEdit(input())}>创建活动</Button> : undefined} />;
  const table = <Card><DataTable ariaLabel="营销活动列表" loading={w.loading} rows={shown} columns={columns} rowKey={c => c.id} selectedKey={current?.id} onRowClick={pick} empty={empty} /></Card>;
  const board = <Card>{shown.length ? <Kanban<MarketCampaign> columns={(Object.keys(CAMPAIGN_STATUS) as MarketCampaign['status'][]).map(s => ({ id: s, title: CAMPAIGN_STATUS[s].label, color: s === 'Active' ? 'var(--mist-accent)' : s === 'Completed' ? 'var(--mist-ok)' : 'var(--mist-ink-3)', items: shown.filter(c => c.status === s) }))} itemKey={c => c.id} onOpen={pick}
    renderCard={c => { const r = campaignReminder(c, leads, day); return <><b>{c.name}</b><div className="mist-obj-meta"><Mono>{c.code}</Mono> · {c.owner}</div><p>{c.target}</p><div className="mist-kb-card-foot">{c.endDate} · {campaignLeads(leads, c.id).length} 条线索</div>{r.overdue > 0 && <small className="mist-tone-bad">{r.overdue} 条跟进逾期</small>}</>; }} /> : empty}</Card>;
  const detail = current ? <DetailBody data-campaign-detail={current.id} heading={<div className="mist-col"><span className="mist-eyebrow">{current.code}</span><h2 className="mist-h2">{current.name}</h2></div>}>
    <Pill tone={CAMPAIGN_STATUS[current.status].tone}>{CAMPAIGN_STATUS[current.status].label}</Pill>
    {campaignReminder(current, leads, day).ended && <Banner tone="warn" title="活动已过结束日期">核对费用与线索结果后再完成活动；不会按日期自动结案。</Banner>}
    <ActionBar busy={busy} actions={[
      { label: '编辑活动', icon: Pencil, onClick: () => onEdit(input(current)), reason: !can ? '没有营销写权限' : !['Draft', 'Paused'].includes(current.status) ? '仅策划中或暂停的活动可编辑' : false },
      { label: '管理线索', icon: Users, onClick: () => go('marketing', undefined, { section: `campaign-leads:${current.id}` }) },
      ...CAMPAIGN_NEXT[current.status].map(next => ({ label: transitionLabel[next]!, onClick: () => transition(current, next), reason: !can && '没有营销写权限' })),
      { label: '发送推广邮件', onClick: () => {}, reason: '尚未接入外部推广发送服务；活动状态不代表邮件已发送' },
    ]} />
    <DetailBlock title="实际费用与目标"><Facts items={[{ label: '预算', value: `${current.currency} ${current.budget}` }, { label: '实际费用', value: `${current.currency} ${current.actualCost}` }, { label: '负责人', value: current.owner }, { label: '期间', value: `${current.startDate} — ${current.endDate}` }, { label: '目标客户群', value: current.target }, { label: '说明', value: current.note || '未填写' }]} />
      {campaignReminder(current, leads, day).overBudget && <Banner tone="warn" title="实际费用超出预算">同一活动原币比较；不与其他币种活动合计。</Banner>}
    </DetailBlock>
    <DetailBlock title="来源与产品"><div className="mist-row">{current.seasonId && <Button onClick={() => go('seasons', current.seasonId)}>关联季节</Button>}{current.showId && <Button onClick={() => go('seasons', current.showId, { section: 'shows' })}>关联展会</Button>}</div>{products(current, can && ['Draft', 'Paused'].includes(current.status))}</DetailBlock>
    <DetailBlock title="线索接续"><Facts items={[{ label: '来源线索', value: campaignLeads(leads, current.id).length }, { label: '已转 CRM', value: campaignLeads(leads, current.id).filter(l => l.status === 'Converted').length }, { label: '跟进逾期', value: campaignReminder(current, leads, day).overdue }]} /><span className="mist-note">预计金额不是成交收入；转 CRM 后由客户主线继续跟进。</span></DetailBlock>
    {attachments(current, !can)}{history(current.id)}
  </DetailBody> : <EmptyState compact title="活动详情" description="选择活动，核对费用、线索与下一步操作。" />;
  return <MistPage width="wide"><PageHeader eyebrow="客户与市场 · 营销" title="营销推广" description="活动按事实登记，线索回到客户主线；费用逐活动按原币核对。" actions={<><Button icon={Download} onClick={() => downloadModuleCsv('营销活动.csv', ['活动', '状态', '负责人', '预算', '费用', '币种'], shown.map(c => [c.name, CAMPAIGN_STATUS[c.status].label, c.owner, c.budget, c.actualCost, c.currency]))}>导出</Button><Button icon={RefreshCw} disabled={busy} onClick={() => void w.refresh()}>刷新</Button>{can && <Button variant="primary" icon={Plus} disabled={busy} onClick={() => onEdit(input())}>创建活动</Button>}</>} />
    {tabs}{!can && <Banner tone="neutral" title="只读查看">没有营销写权限，活动和线索仍可阅读。</Banner>}{w.error && <Banner tone="bad" title="读取或操作未完成" actions={<Button onClick={() => void w.refresh()}>重试</Button>}>{w.error}</Banner>}
    <Toolbar><SearchField value={query} onChange={setQuery} placeholder="搜索活动、编号、负责人或目标群体" /><Segmented<'list' | 'board'> value={mode} onChange={setMode} options={[{ value: 'list', label: '列表' }, { value: 'board', label: '看板' }]} /></Toolbar>
    <div className="mist-section mist-col"><Segmented<'all' | MarketCampaign['status']> value={stage} onChange={setStage} options={[{ value: 'all', label: `全部 · ${campaigns.length}` }, ...(Object.keys(CAMPAIGN_STATUS) as MarketCampaign['status'][]).map(s => ({ value: s, label: `${CAMPAIGN_STATUS[s].label} · ${campaigns.filter(c => c.status === s).length}` }))]} />
      <Segmented<'all' | 'overdue' | 'ended' | 'budget'> value={reminder} onChange={setReminder} options={[{ value: 'all', label: '全部提醒' }, { value: 'overdue', label: '跟进逾期' }, { value: 'ended', label: '到期未复盘' }, { value: 'budget', label: '费用超预算' }]} /></div>
    <ListDetail list={mode === 'list' || w.loading ? table : board} detail={detail} drawerOpen={drawer && !!current} drawerTitle={current?.name || '活动详情'} onDrawerClose={() => { setDrawer(false); go('marketing', undefined, { section: 'campaigns' }); }} />
    <ModuleEditorDialog spec={dialog} onClose={() => setDialog(null)} />
  </MistPage>;
}
