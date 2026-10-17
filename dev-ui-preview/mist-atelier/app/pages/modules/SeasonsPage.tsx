/** 季节性与趋势：季节时间线（SS / AW + 年份，里程碑与今日），本季实时业务；趋势标签关联面料档案与（由报价推出的）客户；展会线索一键转 CRM 客户或商机。 */
import React from 'react';
import { CalendarRange, Download, Flag, Pencil, Plus, RefreshCw, Sparkles, Tent, UserCheck, UserPlus, UserX } from 'lucide-react';
import { Banner, Button, Card, Checklist, DataTable, EmptyState, Facts, MistPage, Mono, ObjectCell, PageHeader, Pill, Segmented, Timeline, type Column, type Tone } from '../../../../../components/mist';
import type { MistState } from '../../../../../server/src/shared/mistWorkspace';
import { marketBusinessDate, type MarketLead, type MarketSeason, type MarketShow, type MarketTrend } from '../../../../../server/src/shared/mistMarket';
import { useMistWorkspace } from '../../runtime/workspace';
import { useMistSession } from '../../runtime/auth';
import { useNav } from '../../nav';
import { ModuleEditorDialog, downloadModuleCsv, type ModuleEditorSpec } from './ModuleWorkbench';
import { useRouteDraft } from './useRouteDraft';
import { ActionBar, DetailBlock, DetailBody, ListDetail, shortWhen } from './pageKit';
import { quotationStage } from './QuotationsPage';

type Tab = 'seasons' | 'trends' | 'shows';
const SEASON_STATUS: Record<MarketSeason['status'], { label: string; tone: Tone }> = { Planning: { label: '规划中', tone: 'neutral' }, Active: { label: '进行中', tone: 'accent' }, Closed: { label: '已结束', tone: 'neutral' } };
const SHOW_STATUS: Record<MarketShow['status'], { label: string; tone: Tone }> = { Planned: { label: '计划中', tone: 'neutral' }, Ongoing: { label: '展会中', tone: 'accent' }, Completed: { label: '已结束', tone: 'ok' }, Cancelled: { label: '已取消', tone: 'neutral' } };
const LEAD_STATUS: Record<MarketLead['status'], { label: string; tone: Tone }> = { New: { label: '新线索', tone: 'accent' }, Contacted: { label: '已联系', tone: 'neutral' }, Qualified: { label: '已确认需求', tone: 'neutral' }, Following: { label: '跟进中', tone: 'neutral' }, Converted: { label: '已转 CRM', tone: 'ok' }, Lost: { label: '已流失', tone: 'neutral' } };
const TREND_TYPE: Record<MarketTrend['type'], string> = { fabric: '面料', color: '颜色', craft: '工艺', composition: '成分' };
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);
const dayNum = (d: string) => Date.parse(d + 'T00:00:00Z');

/** 本季实时业务（按季节编码匹配）：订单按币种分别合计、开发、数字档案、未关闭报价、趋势与展会。 */
export function seasonBusiness(state: MistState | null, s: MarketSeason) {
  const code = s.code.toUpperCase(), same = (v: string) => (v || '').toUpperCase() === code;
  const orders = (state?.orders || []).filter(o => same(o.season));
  const amounts = new Map<string, number>(); for (const o of orders) amounts.set(o.currency, Math.round(((amounts.get(o.currency) || 0) + o.amount) * 100) / 100);
  return {
    orders, amounts: [...amounts.entries()],
    devs: (state?.devs || []).filter(d => same(d.values.season)),
    products: (state?.market.products || []).filter(p => same(p.season)),
    quotations: (state?.market.quotations || []).filter(q => same(q.season) && ['draft', 'pending', 'sent', 'accepted'].includes(quotationStage(q))),
    trends: (state?.market.trends || []).filter(t => t.seasonId === s.id),
    shows: (state?.market.shows || []).filter(x => x.seasonId === s.id),
  };
}
/** 趋势关联的客户：报价条目引用了该趋势关联档案的客户（推导，不另行登记）。 */
export function trendCustomers(state: MistState | null, t: MarketTrend) {
  const ids = new Set(t.productIds), hits = new Map<string, string[]>();
  for (const q of state?.market.quotations || []) if (q.lines.some(l => ids.has(l.productId))) hits.set(q.customerId, [...(hits.get(q.customerId) || []), q.code]);
  return [...hits.entries()].map(([id, codes]) => ({ id, name: state?.customers.find(c => c.id === id)?.name || '未知客户', codes }));
}

export function SeasonTimeline({ seasons, day, selected, onPick }: { seasons: MarketSeason[]; day: string; selected?: string; onPick: (s: MarketSeason) => void }) {
  if (!seasons.length) return null;
  const rows = [...seasons].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const start = Math.min(...rows.map(s => dayNum(s.startDate)), dayNum(day)), end = Math.max(...rows.map(s => dayNum(s.endDate)), dayNum(day)), span = Math.max(end - start, 86400000);
  const pos = (d: string) => `${((dayNum(d) - start) / span) * 100}%`;
  const months: string[] = []; { const c = new Date(start); c.setUTCDate(1); while (c.getTime() <= end) { if (c.getTime() >= start) months.push(c.toISOString().slice(0, 10)); c.setUTCMonth(c.getUTCMonth() + 3); } }
  return <Card><div className="mist-card-body mist-season-timeline" data-season-timeline aria-label="季节时间线">
    <div className="mist-season-axis">{months.map(m => <span key={m} style={{ left: pos(m) }}>{m.slice(0, 7).replace('-', '/')}</span>)}<i className="mist-season-today" style={{ left: pos(day) }} title={`今天 ${day}`}><b>今天</b></i></div>
    {rows.map(s => <button key={s.id} type="button" className="mist-season-row" aria-pressed={s.id === selected} onClick={() => onPick(s)}>
      <span className="mist-season-label"><Mono>{s.code}</Mono><small className="mist-muted">{SEASON_STATUS[s.status].label}</small></span>
      <span className="mist-season-track"><span className="mist-season-bar" data-status={s.status} style={{ left: pos(s.startDate), width: `calc(${pos(s.endDate)} - ${pos(s.startDate)})` }} />
        {s.milestones.map(m => <span key={m.label + m.date} className="mist-season-dot" data-done={m.date < day || undefined} style={{ left: pos(m.date) }} title={`${m.label} · ${m.date}`} />)}
        <i className="mist-season-today" style={{ left: pos(day) }} /></span>
    </button>)}
  </div></Card>;
}

export type SeasonWorkbenchProps = { attachments: (kind: 'season' | 'trend' | 'show' | 'showLead', row: { id: string; fileIds: string[] }, locked: boolean) => React.ReactNode; history: (id: string) => React.ReactNode };

export function SeasonWorkbench({ attachments, history }: SeasonWorkbenchProps) {
  const { state, run, error, refresh, loading, saving, pending } = useMistWorkspace(), session = useMistSession(), { go, route } = useNav();
  const legacyShow = route.section?.startsWith('show-leads:') ? route.section.slice('show-leads:'.length) : '';
  const tab: Tab = legacyShow || route.section === 'shows' ? 'shows' : route.section === 'trends' ? 'trends' : 'seasons';
  const [picked, setPicked] = React.useState<string | null>(legacyShow || route.id || null), [drawer, setDrawer] = React.useState(!!(legacyShow || route.id));
  const [dialog, setDialog] = useRouteDraft<ModuleEditorSpec | null>(null);
  React.useEffect(() => { if (route.id) setPicked(route.id); }, [route.id]);
  const day = marketBusinessDate(new Date());
  const m = state?.market, seasons = m?.seasons || [], trends = m?.trends || [], shows = m?.shows || [], leads = m?.leads || [];
  const can = session.hasPermission('seasons:write'), canCrm = session.hasPermission('relations:write'), locked = saving || !!pending;
  const seasonName = (id: string) => { const s = seasons.find(x => x.id === id); return s ? s.code : '未关联季节'; };
  const seasonOptions = [{ value: '', label: '未关联季节' }, ...seasons.map(s => ({ value: s.id, label: `${s.code} · ${s.name}` }))];
  const switchTab = (t: Tab) => { setPicked(null); setDrawer(false); go('seasons', undefined, { section: t }); };
  const pick = (id: string) => { setPicked(id); setDrawer(true); go('seasons', id, { section: tab }); };
  const seasonSpec = (s?: MarketSeason): ModuleEditorSpec => ({
    title: s ? `编辑 ${s.code}` : '新建季节', submitLabel: '保存',
    initialValues: s ? { code: s.code, name: s.name, startDate: s.startDate, endDate: s.endDate, status: s.status, milestones: s.milestones.map(x => `${x.label} | ${x.date}`).join('\n'), note: s.note } : { code: '', name: '', startDate: '', endDate: '', status: 'Planning', milestones: '', note: '' },
    fields: [{ key: 'code', label: '季节编码', required: true, readonly: !!s, hint: 'SS27 或 AW27；保存后不可改，订单、开发、报价按此编码归季' }, { key: 'name', label: '季节名称', required: true },
      { key: 'startDate', label: '开始日期', type: 'date', required: true }, { key: 'endDate', label: '结束日期', type: 'date', required: true },
      { key: 'status', label: '状态', type: 'select', options: (['Planning', 'Active', 'Closed'] as const).map(v => ({ value: v, label: SEASON_STATUS[v].label })) },
      { key: 'milestones', label: '里程碑', type: 'textarea', hint: '每行一个：名称 | YYYY-MM-DD，须在季节日期内' }, { key: 'note', label: '备注', type: 'textarea' }],
    submit: v => { const milestones = String(v.milestones ?? '').split('\n').map(x => x.trim()).filter(Boolean).map(line => { const [label, date] = line.split('|').map(x => x.trim()); if (!label || !date) throw new Error(`里程碑格式应为“名称 | 日期”：${line}`); return { label, date }; });
      return run({ type: 'market.season.save', payload: { id: s?.id, input: { code: String(v.code ?? ''), name: String(v.name ?? ''), startDate: String(v.startDate ?? ''), endDate: String(v.endDate ?? ''), status: String(v.status) as MarketSeason['status'], milestones, note: String(v.note ?? ''), fileIds: s?.fileIds || [] } } }); },
  });
  const fabricProducts = (m?.products || []).filter(p => p.category === 'fabric');
  const trendSpec = (t?: MarketTrend): ModuleEditorSpec => ({
    title: t ? `编辑趋势 ${t.name}` : '记录趋势', submitLabel: '保存',
    initialValues: t ? { name: t.name, type: t.type, seasonId: t.seasonId, source: t.source, products: t.productIds.map(id => m?.products.find(p => p.id === id)?.sku || '').filter(Boolean).join('、'), note: t.note } : { name: '', type: 'fabric', seasonId: seasons.find(s => s.status === 'Active')?.id || seasons[0]?.id || '', source: '', products: '', note: '' },
    fields: [{ key: 'name', label: '趋势名称', required: true }, { key: 'type', label: '类别', type: 'select', options: (Object.keys(TREND_TYPE) as MarketTrend['type'][]).map(k => ({ value: k, label: TREND_TYPE[k] })) },
      { key: 'seasonId', label: '季节', type: 'select', required: true, options: seasonOptions.slice(1) }, { key: 'source', label: '来源依据', required: true, hint: '例如展会趋势区、色彩报告、客户简报' },
      { key: 'products', label: '关联面料档案', hint: `填写面料档案编码，用顿号分隔${fabricProducts.length ? '；可选：' + fabricProducts.slice(0, 6).map(p => p.sku).join('、') : ''}` }, { key: 'note', label: '观察内容', type: 'textarea' }],
    submit: v => { const skus = String(v.products ?? '').split(/[、,\s]+/).map(x => x.trim()).filter(Boolean); const productIds = skus.map(sku => { const p = m?.products.find(x => x.sku.toLowerCase() === sku.toLowerCase()); if (!p) throw new Error(`找不到数字档案 ${sku}`); if (p.category !== 'fabric') throw new Error(`${sku} 不是面料档案，趋势只关联面料`); return p.id; });
      return run({ type: 'market.trend.save', payload: { id: t?.id, input: { name: String(v.name ?? ''), type: String(v.type) as MarketTrend['type'], seasonId: String(v.seasonId ?? ''), source: String(v.source ?? ''), productIds, note: String(v.note ?? ''), fileIds: t?.fileIds || [] } } }); },
  });
  const showSpec = (x?: MarketShow): ModuleEditorSpec => ({
    title: x ? `编辑 ${x.name}` : '新建展会', submitLabel: '保存',
    initialValues: x ? { name: x.name, location: x.location, seasonId: x.seasonId, startDate: x.startDate, endDate: x.endDate, booth: x.booth, attendees: x.attendees, cost: x.cost, currency: x.currency, status: x.status, note: x.note } : { name: '', location: '', seasonId: '', startDate: '', endDate: '', booth: '', attendees: '', cost: '0', currency: 'USD', status: 'Planned', note: '' },
    fields: [{ key: 'name', label: '展会名称', required: true }, { key: 'location', label: '地点', required: true }, { key: 'seasonId', label: '季节', type: 'select', options: seasonOptions },
      { key: 'startDate', label: '开始日期', type: 'date', required: true }, { key: 'endDate', label: '结束日期', type: 'date', required: true }, { key: 'booth', label: '展位' }, { key: 'attendees', label: '参与人' },
      { key: 'cost', label: '费用', required: true, hint: '最多两位小数' }, { key: 'currency', label: '币种', required: true }, { key: 'status', label: '状态', type: 'select', options: (Object.keys(SHOW_STATUS) as MarketShow['status'][]).map(k => ({ value: k, label: SHOW_STATUS[k].label })) }, { key: 'note', label: '备注', type: 'textarea' }],
    submit: v => run({ type: 'market.show.save', payload: { id: x?.id, input: { name: String(v.name ?? ''), location: String(v.location ?? ''), seasonId: String(v.seasonId ?? ''), startDate: String(v.startDate ?? ''), endDate: String(v.endDate ?? ''), booth: String(v.booth ?? ''), attendees: String(v.attendees ?? ''), cost: String(v.cost ?? ''), currency: String(v.currency ?? '').toUpperCase(), status: String(v.status) as MarketShow['status'], note: String(v.note ?? ''), fileIds: x?.fileIds || [] } } }),
  });
  const leadSpec = (show: MarketShow, l?: MarketLead): ModuleEditorSpec => ({
    title: l ? `编辑线索 ${l.name}` : `录入 ${show.name} 线索`, submitLabel: '保存',
    initialValues: l ? { name: l.name, company: l.company, email: l.email, phone: l.phone, demand: l.demand, followUpDate: l.followUpDate, estimatedValue: l.estimatedValue, currency: l.currency, note: l.note } : { name: '', company: '', email: '', phone: '', demand: '', followUpDate: '', estimatedValue: '0', currency: show.currency, note: '' },
    fields: [{ key: 'name', label: '联系人', required: true }, { key: 'company', label: '公司', required: true }, { key: 'email', label: '邮箱' }, { key: 'phone', label: '电话' }, { key: 'demand', label: '采购需求', type: 'textarea', required: true },
      { key: 'followUpDate', label: '下次跟进日期', type: 'date' }, { key: 'estimatedValue', label: '预计金额', required: true }, { key: 'currency', label: '币种', required: true }, { key: 'note', label: '跟进说明', type: 'textarea' }],
    submit: v => run({ type: 'market.showLead.save', payload: { id: l?.id, input: { name: String(v.name ?? ''), company: String(v.company ?? ''), email: String(v.email ?? ''), phone: String(v.phone ?? ''), demand: String(v.demand ?? ''), customerId: l?.customerId || '', followUpDate: String(v.followUpDate ?? ''), estimatedValue: String(v.estimatedValue ?? ''), actualValue: l?.actualValue || '0', currency: String(v.currency ?? '').toUpperCase(), note: String(v.note ?? ''), source: 'show', parentId: show.id, fileIds: l?.fileIds || [] } } }),
  });
  const convertSpec = (l: MarketLead): ModuleEditorSpec => {
    const same = state?.customers.find(c => c.name.trim().toLowerCase() === l.company.trim().toLowerCase());
    return { title: `把 ${l.name} · ${l.company} 转入 CRM`, submitLabel: '转入 CRM', description: same ? `已有同名客户 ${same.name}，默认关联该客户，不重复建档。` : '选择“新建客户”会按线索公司建立客户档案，并把联系人一并登记。',
      initialValues: { customerId: same?.id || '', withOpportunity: true, title: `${l.company} · ${l.demand.slice(0, 24)}`, domain: /面料|米|码|fabric/i.test(l.demand) ? 'fabric' : 'garment', amount: l.estimatedValue || '0', currency: l.currency, expectedDate: new Date(dayNum(day) + 30 * 86400000).toISOString().slice(0, 10) },
      fields: [{ key: 'customerId', label: '客户', type: 'select', options: [...(same ? [] : [{ value: '', label: `新建客户：${l.company}` }]), ...(state?.customers || []).map(c => ({ value: c.id, label: `${c.name} · ${c.code}` }))] },
        { key: 'withOpportunity', label: '同时建立商机', type: 'checkbox' }, { key: 'title', label: '商机名称' }, { key: 'domain', label: '业务板块', type: 'select', options: [{ value: 'garment', label: '成衣' }, { value: 'fabric', label: '面料' }] },
        { key: 'amount', label: '预计金额' }, { key: 'currency', label: '币种' }, { key: 'expectedDate', label: '预计成交日', type: 'date' }],
      submit: async v => { const opp = v.withOpportunity ? { title: String(v.title ?? '').trim(), domain: String(v.domain) as 'garment' | 'fabric', amount: String(v.amount ?? ''), currency: String(v.currency ?? '').toUpperCase(), expectedDate: String(v.expectedDate ?? '') } : null;
        if (opp && (!opp.title || !opp.expectedDate)) throw new Error('建立商机须填写商机名称与预计成交日');
        await run({ type: 'market.lead.convertToCrm', payload: { id: l.id, customerId: String(v.customerId ?? '') || undefined, opportunity: opp } }); } };
  };
  const progressSpec = (l: MarketLead, next: 'Following' | 'Lost'): ModuleEditorSpec => ({ title: next === 'Lost' ? `标记 ${l.name} 已流失` : `记录 ${l.name} 跟进`, submitLabel: '保存', initialValues: { note: '' }, fields: [{ key: 'note', label: next === 'Lost' ? '流失原因' : '跟进内容', type: 'textarea', required: true }], submit: v => run({ type: 'market.showLead.transition', payload: { id: l.id, status: next, note: String(v.note ?? '') } }) });

  const seasonRows = [...seasons].sort((a, b) => ({ Active: 0, Planning: 1, Closed: 2 })[a.status] - ({ Active: 0, Planning: 1, Closed: 2 })[b.status] || a.startDate.localeCompare(b.startDate));
  const trendRows = [...trends].sort((a, b) => seasonName(a.seasonId).localeCompare(seasonName(b.seasonId)) || a.type.localeCompare(b.type));
  const showLeads = (x: MarketShow) => leads.filter(l => l.source === 'show' && l.parentId === x.id);
  const showRows = [...shows].sort((a, b) => b.startDate.localeCompare(a.startDate));
  const selSeason = tab === 'seasons' ? seasons.find(s => s.id === picked) : undefined, selTrend = tab === 'trends' ? trends.find(t => t.id === picked) : undefined, selShow = tab === 'shows' ? shows.find(s => s.id === picked) : undefined;
  const seasonCols: Column<MarketSeason>[] = [
    { key: 'code', header: '季节', width: 'minmax(150px,1fr)', render: s => <ObjectCell name={<><Mono>{s.code}</Mono> {s.name}</>} meta={`${s.startDate} — ${s.endDate}`} /> },
    { key: 'next', header: '下一个里程碑', width: 'minmax(130px,1fr)', hideOnMobile: true, render: s => { const n = [...s.milestones].sort((a, b) => a.date.localeCompare(b.date)).find(x => x.date >= day); return n ? <span className="mist-col" style={{ gap: 2 }}><span>{n.label}</span><small className={daysBetween(day, n.date) <= 7 ? 'mist-tone-warn' : 'mist-muted'}>{daysBetween(day, n.date) === 0 ? '今天' : `${daysBetween(day, n.date)} 天后`} · {n.date.slice(5)}</small></span> : <span className="mist-muted">—</span>; } },
    { key: 'biz', header: '订单 / 开发', width: '96px', align: 'right', render: s => { const b = seasonBusiness(state, s); return <span className="mist-num">{b.orders.length} / {b.devs.length}</span>; } },
    { key: 'status', header: '状态', width: '84px', render: s => <Pill tone={SEASON_STATUS[s.status].tone}>{SEASON_STATUS[s.status].label}</Pill> },
  ];
  const trendCols: Column<MarketTrend>[] = [
    { key: 'name', header: '趋势', width: 'minmax(170px,1.3fr)', render: t => <ObjectCell name={t.name} meta={t.source} /> },
    { key: 'type', header: '类别', width: '72px', render: t => <Pill>{TREND_TYPE[t.type]}</Pill> },
    { key: 'season', header: '季节', width: '64px', render: t => <Mono>{seasonName(t.seasonId)}</Mono> },
    { key: 'links', header: '档案 / 客户', width: '96px', align: 'right', render: t => <span className="mist-num">{t.productIds.length} / {trendCustomers(state, t).length}</span> },
  ];
  const showCols: Column<MarketShow>[] = [
    { key: 'name', header: '展会', width: 'minmax(170px,1.3fr)', render: x => <ObjectCell name={x.name} meta={`${x.location}${x.booth ? ' · ' + x.booth : ''}`} /> },
    { key: 'date', header: '日期', width: '104px', render: x => <span className="mist-col" style={{ gap: 2 }}><span className="mist-num">{x.startDate.slice(5)} — {x.endDate.slice(5)}</span><small className="mist-muted">{seasonName(x.seasonId)}</small></span> },
    { key: 'leads', header: '线索 / 转化', width: '96px', align: 'right', render: x => { const ls = showLeads(x); return <span className="mist-num">{ls.length} / {ls.filter(l => l.status === 'Converted').length}</span>; } },
    { key: 'status', header: '状态', width: '84px', render: x => <Pill tone={SHOW_STATUS[x.status].tone}>{SHOW_STATUS[x.status].label}</Pill> },
  ];
  const detail = tab === 'seasons' ? (selSeason && <SeasonDetail s={selSeason} state={state} day={day} can={can} locked={locked} onEdit={() => setDialog(seasonSpec(selSeason))} onReview={() => void run({ type: 'market.season.review', payload: { id: selSeason.id } })} onOpen={(view, id, extra) => go(view, id, extra)} onTab={(t, id) => { go('seasons', id, { section: t }); setPicked(id); }} attachments={attachments('season', selSeason, !can)} history={history(selSeason.id)} />)
    : tab === 'trends' ? (selTrend && <TrendDetail t={selTrend} state={state} season={seasonName(selTrend.seasonId)} can={can} locked={locked} onEdit={() => setDialog(trendSpec(selTrend))} onOpen={(view, id, extra) => go(view, id, extra)} attachments={attachments('trend', selTrend, !can)} history={history(selTrend.id)} />)
    : (selShow && <ShowDetail x={selShow} leads={showLeads(selShow)} day={day} season={seasonName(selShow.seasonId)} can={can} canCrm={canCrm} locked={locked} onEdit={() => setDialog(showSpec(selShow))} onLead={l => setDialog(leadSpec(selShow, l))} onConvert={l => setDialog(convertSpec(l))} onProgress={(l, n) => setDialog(progressSpec(l, n))} onOpen={(view, id, extra) => go(view, id, extra)} attachments={attachments('show', selShow, !can)} history={history(selShow.id)} />);
  const placeholder = <EmptyState icon={tab === 'seasons' ? CalendarRange : tab === 'trends' ? Sparkles : Tent} title={tab === 'seasons' ? '季节详情' : tab === 'trends' ? '趋势详情' : '展会与线索'} description={tab === 'seasons' ? '从时间线或列表选择一个季节，查看里程碑与本季业务。' : tab === 'trends' ? '选择一条趋势，查看关联面料与客户。' : '选择一个展会，查看线索并转入 CRM。'} compact />;
  const exportRows = () => tab === 'seasons' ? downloadModuleCsv('季节.csv', ['编码', '名称', '开始', '结束', '状态', '订单', '开发', '数字档案', '订单金额（原币）'], seasonRows.map(s => { const b = seasonBusiness(state, s); return [s.code, s.name, s.startDate, s.endDate, SEASON_STATUS[s.status].label, b.orders.length, b.devs.length, b.products.length, b.amounts.map(([c, v]) => `${c} ${v}`).join(' / ')]; }))
    : tab === 'trends' ? downloadModuleCsv('趋势.csv', ['趋势', '类别', '季节', '来源', '关联档案', '关联客户'], trendRows.map(t => [t.name, TREND_TYPE[t.type], seasonName(t.seasonId), t.source, t.productIds.map(id => m?.products.find(p => p.id === id)?.sku).join('、'), trendCustomers(state, t).map(c => c.name).join('、')]))
    : downloadModuleCsv('展会线索.csv', ['展会', '联系人', '公司', '邮箱', '需求', '下次跟进', '预计金额', '币种', '状态'], showRows.flatMap(x => showLeads(x).map(l => [x.name, l.name, l.company, l.email, l.demand, l.followUpDate, l.estimatedValue, l.currency, LEAD_STATUS[l.status].label])));
  const createLabel = tab === 'seasons' ? '新建季节' : tab === 'trends' ? '记录趋势' : '新建展会';
  return <MistPage>
    <PageHeader eyebrow="客户与市场 · 季节与趋势" title="季节性与趋势" description="订单、开发与报价按季节编码归季；趋势有来源依据并关联面料档案；展会线索可一键转入 CRM。"
      actions={<><Button icon={Download} onClick={exportRows}>导出</Button>{can && <Button variant="primary" icon={Plus} disabled={locked} onClick={() => setDialog(tab === 'seasons' ? seasonSpec() : tab === 'trends' ? trendSpec() : showSpec())}>{createLabel}</Button>}</>} />
    {!can && <div className="mist-section"><Banner tone="neutral" title="只读查看">你的账号没有季节与趋势写权限。</Banner></div>}
    {error && <div className="mist-section"><Banner tone="bad" title="数据未加载" actions={<Button onClick={() => void refresh()}>重试</Button>}>{error}</Banner></div>}
    <div className="mist-section"><Segmented<Tab> ariaLabel="内容" value={tab} onChange={switchTab} options={[{ value: 'seasons', label: `季节 · ${seasons.length}` }, { value: 'trends', label: `趋势 · ${trends.length}` }, { value: 'shows', label: `展会与线索 · ${shows.length}` }]} /></div>
    {tab === 'seasons' && <div className="mist-section"><SeasonTimeline seasons={seasons} day={day} selected={selSeason?.id} onPick={s => pick(s.id)} /></div>}
    <ListDetail drawerOpen={drawer && !!detail} onDrawerClose={() => setDrawer(false)} drawerTitle={selSeason ? `${selSeason.code} · ${selSeason.name}` : selTrend?.name || selShow?.name || ''}
      list={<Card>{tab === 'seasons' ? <DataTable ariaLabel="季节列表" loading={loading} rows={seasonRows} rowKey={s => s.id} selectedKey={selSeason?.id} density="comfy" onRowClick={s => pick(s.id)} columns={seasonCols} empty={<EmptyState icon={CalendarRange} title="还没有季节" description="按 SS / AW + 年份建立季节，订单、开发与报价会按编码自动归季。" />} />
        : tab === 'trends' ? <DataTable ariaLabel="趋势列表" loading={loading} rows={trendRows} rowKey={t => t.id} selectedKey={selTrend?.id} density="comfy" onRowClick={t => pick(t.id)} columns={trendCols} empty={<EmptyState icon={Sparkles} title="还没有趋势记录" description="记录趋势时写明来源依据，并关联面料档案。" />} />
        : <DataTable ariaLabel="展会列表" loading={loading} rows={showRows} rowKey={x => x.id} selectedKey={selShow?.id} density="comfy" onRowClick={x => pick(x.id)} columns={showCols} empty={<EmptyState icon={Tent} title="还没有展会" description="登记参展计划与费用，展会线索在展会详情中录入。" />} />}</Card>}
      detail={detail || placeholder} />
    <ModuleEditorDialog spec={dialog} onClose={() => setDialog(null)} />
  </MistPage>;
}

function SeasonDetail({ s, state, day, can, locked, onEdit, onReview, onOpen, onTab, attachments, history }: { s: MarketSeason; state: MistState | null; day: string; can: boolean; locked: boolean; onEdit: () => void; onReview: () => void; onOpen: (view: string, id?: string, extra?: Record<string, string | undefined>) => void; onTab: (t: Tab, id: string) => void; attachments: React.ReactNode; history: React.ReactNode }) {
  const b = seasonBusiness(state, s), left = daysBetween(day, s.endDate), toStart = daysBetween(day, s.startDate);
  const writeReason = !can ? '没有季节写权限' : false;
  return <DetailBody data-season-detail={s.id} heading={<div><span className="mist-mono mist-muted">{s.code}</span><div className="mist-h2" style={{ fontSize: 19, marginTop: 4 }}>{s.name}</div></div>}>
    <div className="mist-row" style={{ flexWrap: 'wrap' }}><Pill tone={SEASON_STATUS[s.status].tone}>{SEASON_STATUS[s.status].label}</Pill><Pill>{toStart > 0 ? `${toStart} 天后开始` : left >= 0 ? `还剩 ${left} 天` : `已结束 ${-left} 天`}</Pill></div>
    {s.status === 'Active' && left < 0 && <Banner tone="warn" title="季节已过结束日">状态仍为进行中；确认收尾后改为已结束，并生成季末回顾。</Banner>}
    <ActionBar busy={locked} actions={[{ label: '编辑季节', icon: Pencil, onClick: onEdit, reason: writeReason }, { label: s.review ? '更新回顾' : '生成回顾', icon: RefreshCw, onClick: onReview, reason: writeReason, primary: s.status === 'Closed' && !s.review }]} />
    <Facts items={[{ label: '期间', value: `${s.startDate} — ${s.endDate}` }, { label: '订单（进行中 + 已完成）', value: <span className="mist-num">{b.orders.length} 单</span> },
      { label: '订单金额（原币）', value: <span className="mist-num">{b.amounts.length ? b.amounts.map(([c, v]) => `${c} ${v.toLocaleString('en-US', { minimumFractionDigits: 2 })}`).join(' · ') : '—'}</span> },
      { label: '开发 / 数字档案', value: <span className="mist-num">{b.devs.length} / {b.products.length}</span> }, { label: '未关闭报价', value: <span className="mist-num">{b.quotations.length}</span> }, { label: '趋势 / 展会', value: <span className="mist-num">{b.trends.length} / {b.shows.length}</span> }]} />
    {s.note && <p className="mist-sub">{s.note}</p>}
    <DetailBlock title="里程碑">{s.milestones.length ? <Checklist items={[...s.milestones].sort((a, c) => a.date.localeCompare(c.date)).map(x => ({ label: x.label, done: x.date < day, note: x.date < day ? x.date : `${x.date} · ${daysBetween(day, x.date) === 0 ? '今天' : daysBetween(day, x.date) + ' 天后'}` }))} /> : <span className="mist-muted">未设里程碑。</span>}</DetailBlock>
    {!!(b.orders.length || b.quotations.length) && <DetailBlock title="本季业务">
      <div className="mist-col" style={{ gap: 0 }} data-season-business>
        {b.orders.slice(0, 6).map(o => <div key={o.id} className="mist-row mist-quote-line" style={{ gap: 8, padding: '8px 0' }}><Pill tone="accent">订单</Pill><Mono>{o.code}</Mono><span style={{ flex: '1 1 8em', minWidth: 0 }} className="mist-muted">{o.customer} · {o.state}</span><Button variant="quiet" onClick={() => onOpen('orders/detail', o.id)}>打开</Button></div>)}
        {b.quotations.map(q => <div key={q.id} className="mist-row mist-quote-line" style={{ gap: 8, padding: '8px 0' }}><Pill>报价</Pill><Mono>{q.code}</Mono><span style={{ flex: '1 1 8em', minWidth: 0 }} className="mist-muted mist-num">{q.currency} {q.total}</span><Button variant="quiet" onClick={() => onOpen('quotations', q.id)}>打开</Button></div>)}
      </div>
    </DetailBlock>}
    {!!(b.trends.length || b.shows.length) && <DetailBlock title="趋势与展会"><div className="mist-row" style={{ gap: 6, flexWrap: 'wrap' }}>
      {b.trends.map(t => <Button key={t.id} variant="quiet" icon={Sparkles} onClick={() => onTab('trends', t.id)}>{t.name}</Button>)}
      {b.shows.map(x => <Button key={x.id} variant="quiet" icon={Tent} onClick={() => onTab('shows', x.id)}>{x.name}</Button>)}
    </div></DetailBlock>}
    <DetailBlock title="季末回顾">{s.review ? <><Facts cols={3} items={[{ label: '订单', value: s.review.orderCount }, { label: '开发', value: s.review.developmentCount }, { label: '数字档案', value: s.review.productCount }]} /><span className="mist-note">金额（原币，分别合计）：{s.review.amounts.map(x => `${x.currency} ${x.amount}`).join(' · ') || '无'}；快照生成于 {new Date(s.review.at).toLocaleString('zh-CN')}，之后的变化需点“更新回顾”。</span></> : <span className="mist-muted">尚未生成。回顾会保存生成时刻的订单、开发、档案数量与原币金额快照。</span>}</DetailBlock>
    <DetailBlock title="附件">{attachments}</DetailBlock>
    <DetailBlock title="处理记录">{history}</DetailBlock>
  </DetailBody>;
}

function TrendDetail({ t, state, season, can, locked, onEdit, onOpen, attachments, history }: { t: MarketTrend; state: MistState | null; season: string; can: boolean; locked: boolean; onEdit: () => void; onOpen: (view: string, id?: string, extra?: Record<string, string | undefined>) => void; attachments: React.ReactNode; history: React.ReactNode }) {
  const products = t.productIds.map(id => state?.market.products.find(p => p.id === id)).filter(Boolean) as NonNullable<MistState['market']['products'][number]>[];
  const customers = trendCustomers(state, t);
  return <DetailBody data-trend-detail={t.id} heading={<div><span className="mist-muted">{TREND_TYPE[t.type]} · {season}</span><div className="mist-h2" style={{ fontSize: 19, marginTop: 4 }}>{t.name}</div></div>}>
    <ActionBar busy={locked} actions={[{ label: '编辑趋势', icon: Pencil, onClick: onEdit, reason: !can ? '没有季节写权限' : false }]} />
    <Facts items={[{ label: '来源依据', value: t.source }, { label: '季节', value: season }]} />
    {t.note && <p className="mist-sub">{t.note}</p>}
    <DetailBlock title={`关联面料档案 · ${products.length}`}>{products.length ? <div className="mist-row" style={{ gap: 6, flexWrap: 'wrap' }}>{products.map(p => <Button key={p.id} variant="quiet" onClick={() => onOpen('products', p.id)}><Mono>{p.sku}</Mono> {p.name}</Button>)}</div> : <span className="mist-muted">未关联面料档案。</span>}</DetailBlock>
    <DetailBlock title={`关联客户 · ${customers.length}`}>{customers.length ? <div className="mist-col" style={{ gap: 0 }} data-trend-customers>{customers.map(c => <div key={c.id} className="mist-row mist-quote-line" style={{ gap: 8, padding: '8px 0' }}><span style={{ flex: 1, minWidth: 0 }}>{c.name}<small className="mist-cell-sub">报价 {c.codes.join('、')}</small></span><Button variant="quiet" onClick={() => onOpen('crm', c.id, { customerId: c.id })}>客户业务</Button></div>)}</div> : <span className="mist-muted">还没有客户的报价引用这些面料。</span>}
      <span className="mist-note">由报价条目引用的关联档案推出，不另行登记。</span></DetailBlock>
    <DetailBlock title="附件">{attachments}</DetailBlock>
    <DetailBlock title="处理记录">{history}</DetailBlock>
  </DetailBody>;
}

function ShowDetail({ x, leads, day, season, can, canCrm, locked, onEdit, onLead, onConvert, onProgress, onOpen, attachments, history }: { x: MarketShow; leads: MarketLead[]; day: string; season: string; can: boolean; canCrm: boolean; locked: boolean; onEdit: () => void; onLead: (l?: MarketLead) => void; onConvert: (l: MarketLead) => void; onProgress: (l: MarketLead, n: 'Following' | 'Lost') => void; onOpen: (view: string, id?: string, extra?: Record<string, string | undefined>) => void; attachments: React.ReactNode; history: React.ReactNode }) {
  const converted = leads.filter(l => l.status === 'Converted').length, overdue = leads.filter(l => l.status !== 'Converted' && l.status !== 'Lost' && l.followUpDate && l.followUpDate < day).length;
  const writeReason = !can ? '没有季节写权限' : false, convertReason = !canCrm ? '没有客户关系写权限' : false;
  const order: Record<MarketLead['status'], number> = { New: 0, Following: 1, Contacted: 1, Qualified: 1, Converted: 2, Lost: 3 };
  return <DetailBody data-show-detail={x.id} heading={<div><span className="mist-muted">{x.location}</span><div className="mist-h2" style={{ fontSize: 19, marginTop: 4 }}>{x.name}</div></div>}>
    <div className="mist-row" style={{ flexWrap: 'wrap' }}><Pill tone={SHOW_STATUS[x.status].tone}>{SHOW_STATUS[x.status].label}</Pill><Pill>{season}</Pill>{overdue > 0 && <Pill tone="warn">{overdue} 条线索跟进逾期</Pill>}</div>
    <ActionBar busy={locked} actions={[{ label: '录入线索', icon: UserPlus, onClick: () => onLead(), reason: writeReason, primary: x.status !== 'Planned' }, { label: '编辑展会', icon: Pencil, onClick: onEdit, reason: writeReason }]} />
    <Facts items={[{ label: '日期', value: `${x.startDate} — ${x.endDate}` }, { label: '展位', value: x.booth || '—' }, { label: '参与人', value: x.attendees || '—' }, { label: '费用', value: <span className="mist-num">{x.currency} {x.cost}</span> }, { label: '线索 / 已转 CRM', value: <span className="mist-num">{leads.length} / {converted}</span> }, { label: '转化率', value: leads.length ? `${Math.round(converted / leads.length * 100)}%` : '—' }]} />
    {x.note && <p className="mist-sub">{x.note}</p>}
    <DetailBlock title={`展会线索 · ${leads.length}`}>
      {leads.length ? <div className="mist-col" style={{ gap: 0 }} role="list" aria-label="展会线索" data-show-leads>{[...leads].sort((a, b) => order[a.status] - order[b.status] || (a.followUpDate || '9').localeCompare(b.followUpDate || '9')).map(l => { const late = l.status !== 'Converted' && l.status !== 'Lost' && l.followUpDate && l.followUpDate < day; const open = l.status !== 'Converted' && l.status !== 'Lost'; return <div key={l.id} role="listitem" className="mist-col mist-quote-line" style={{ gap: 4, padding: '10px 0' }}>
        <div className="mist-row" style={{ gap: 8 }}><strong>{l.name}</strong><span className="mist-muted">{l.company}</span><span className="mist-spacer" /><Pill tone={LEAD_STATUS[l.status].tone}>{LEAD_STATUS[l.status].label}</Pill></div>
        <small className="mist-muted">{l.demand} · 预计 <span className="mist-num">{l.currency} {l.estimatedValue}</span>{l.email ? ' · ' + l.email : ''}</small>
        {open && <small className={late ? 'mist-tone-warn' : 'mist-muted'}>{l.followUpDate ? `下次跟进 ${l.followUpDate}${late ? `（逾期 ${daysBetween(l.followUpDate, day)} 天）` : ''}` : '未计划跟进'}</small>}
        <div className="mist-row" style={{ gap: 4, flexWrap: 'wrap' }}>
          {open && <Button variant="secondary" icon={UserCheck} disabled={locked || !!convertReason} title={convertReason || undefined} onClick={() => onConvert(l)}>转入 CRM</Button>}
          {open && can && <Button variant="quiet" icon={Flag} disabled={locked} onClick={() => onProgress(l, 'Following')}>记录跟进</Button>}
          {open && can && <Button variant="quiet" icon={UserX} disabled={locked} onClick={() => onProgress(l, 'Lost')}>已流失</Button>}
          {open && can && <Button variant="quiet" disabled={locked} onClick={() => onLead(l)}>编辑</Button>}
          {l.status === 'Converted' && <Button variant="quiet" onClick={() => onOpen('crm', l.customerId, { customerId: l.customerId })}>客户业务{l.opportunityId ? ' · 商机' : ''}</Button>}
        </div>
        {l.note && <small className="mist-note" style={{ whiteSpace: 'pre-line' }}>{l.note}</small>}
      </div>; })}</div> : <span className="mist-muted">还没有线索。展会现场交换的名片可在这里录入。</span>}
      {!canCrm && <span className="mist-note">转入 CRM 需要客户关系写权限。</span>}
    </DetailBlock>
    <DetailBlock title="附件">{attachments}</DetailBlock>
    <DetailBlock title="处理记录">{history}</DetailBlock>
  </DetailBody>;
}
