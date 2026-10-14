/** T1 工作台：保留 Mist 的问候、统计、焦点、简报、任务与日程构图。 */
import React from 'react';
import { ArrowRight, BadgeCheck, FileText, Layers, Plus, Ship, SlidersHorizontal, Sparkles, Wallet, ArrowUpRight, RefreshCw } from 'lucide-react';
import { AIBrief, Agenda, Banner, Button, Card, CardBody, CardHeader, Dialog, Dropdown, EmptyState, Field, FormGrid, HeroFocus, KeyValue, MistPage, PageHeader, Segmented, Select, Skeleton, StatCard, StatGrid, Switch, TaskList, TextLink, WeekStrip, useToast, type TaskItem } from '../../../../components/mist';
import type { MistTarget } from '../../../../server/src/shared/mistWorkspace';
import { IMG, STAGES } from '../data';
import { useNav } from '../nav';
import { useMistSession } from '../runtime/auth';
import { useMistWorkspace } from '../runtime/workspace';
import { visibleMistNotifications } from '../runtime/notificationPreferences';
import type { View } from '../../../../types';

function dateKey(value: Date) { return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`; }
function weekDays(date: string) {
  const start = new Date(`${date}T12:00:00`); start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  return Array.from({ length: 7 }, (_, index) => { const day = new Date(start); day.setDate(start.getDate() + index); return { key: dateKey(day), weekday: ['一', '二', '三', '四', '五', '六', '日'][index], day: day.getDate() }; });
}
const money = (value: number) => value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function HomePage() {
  const { go, openAI } = useNav(), toast = useToast(), session = useMistSession(), workspace = useMistWorkspace();
  const { state, loading, saving, pending } = workspace;
  const [range, setRange] = React.useState<'today' | 'week'>('today');
  const [today, setToday] = React.useState(() => dateKey(new Date()));
  const [day, setDay] = React.useState(today);
  const [sort, setSort] = React.useState<'due' | 'title'>('due');
  const [taskDialog, setTaskDialog] = React.useState(false), [selectedTask, setSelectedTask] = React.useState(''), [taskDone, setTaskDone] = React.useState(false);
  const [reportVersion, setReportVersion] = React.useState<string | null>(null), [error, setError] = React.useState('');
  const [statView,setStatView]=React.useState<'development'|'qc'|'shipping'|'invoices'|null>(null);
  const hidden = new Set(workspace.workspace?.access?.hidden?.map(section => section.key) ?? []);
  const hiddenStats = { development: hidden.has('products'), qc: hidden.has('products') || hidden.has('qc'), shipping: hidden.has('shipments'), invoices: hidden.has('receivables') };
  React.useEffect(() => { if (statView && hiddenStats[statView]) setStatView(null); }, [statView, hiddenStats.development, hiddenStats.qc, hiddenStats.shipping, hiddenStats.invoices]);
  const scope = `${session.sessionKey}:${workspace.workspace?.id ?? ''}`, activeScope = React.useRef(scope); activeScope.current = scope;
  const alive=React.useRef(true);React.useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const busy = loading || saving || !!pending, operation = React.useRef(false);
  React.useEffect(() => { setTaskDialog(false); setSelectedTask(''); setReportVersion(null); setStatView(null); setError(''); operation.current = false; }, [scope]);
  React.useEffect(() => { const update = () => setToday(dateKey(new Date())); const timer = window.setInterval(update, 60000); window.addEventListener('focus', update); return () => { window.clearInterval(timer); window.removeEventListener('focus', update); }; }, []);
  const days = weekDays(today), weekStart = days[0].key, weekEnd = days[6].key;
  const allTasks = (state?.tasks ?? []).filter(task => !task.done);
  const inRange = (date: string) => !date || (range === 'today' ? date <= today : date <= weekEnd);
  const tasks = allTasks.filter(task => inRange(task.due)).slice().sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title, 'zh-CN') : (a.due || '9999').localeCompare(b.due || '9999') || a.title.localeCompare(b.title, 'zh-CN'));
  const focus = tasks[0];
  const dev = state?.devs.find(item => item.id === focus?.target.id);
  const version = dev ? state?.versions.find(item => item.devId===dev.id&&item.id === (focus?.target.versionId || dev.currentVersionId)) : undefined;
  const report = state?.versions.find(item => item.id === reportVersion);
  const openTarget = (target: MistTarget) => { if (!busy) go(target.view, target.id, target); };
  const run = async (work: () => Promise<unknown>, success?: string) => {
    if (busy || operation.current) return;
    operation.current = true; const current = scope; setError('');
    try { await work(); if (alive.current && activeScope.current === current && success) toast(success); }
    catch (failure) { if (alive.current && activeScope.current === current) { const message = failure instanceof Error ? failure.message : '操作未完成，请重试'; setError(message); toast(message, 'bad'); } }
    finally { if (alive.current && activeScope.current === current) operation.current = false; }
  };
  const taskRows: TaskItem[] = tasks.map(task => ({ id: task.id, when: !task.due ? '未定期限' : task.due < today ? '已逾期' : task.due === today ? '今天' : task.due.slice(5), urgent: !!task.due && task.due <= today,
    title: task.title, meta: [task.kind === 'development' ? '开发事项' : '工作事项', state?.devs.find(dev=>dev.id===task.target.id)?.code||state?.orders.find(order=>order.id===task.target.id)?.code, task.target.versionId ? state?.versions.find(v => v.id === task.target.versionId)?.label : undefined].filter(Boolean).join(' · '),
    status: { tone: task.due && task.due < today ? 'warn' : 'accent', label: task.due && task.due < today ? '已逾期' : '待处理' } }));
  const outstanding = new Map<string, number>();
  state?.invoices.forEach(invoice => { if (invoice.open > 0) outstanding.set(invoice.currency, (outstanding.get(invoice.currency) ?? 0) + invoice.open); });
  const currencies = [...outstanding.entries()].sort(([a], [b]) => a.localeCompare(b));
  const preferredCurrency=state?.settings.companyProfile?.defaultCurrency;
  const mainCurrency = currencies.find(([currency]) => currency===preferredCurrency) ?? currencies.find(([currency]) => currency === 'USD') ?? currencies[0];
  const activeDevs=state?.devs.filter(item=>item.stage<4)||[];
  const qcTasks=state?.fulfillment.qcTasks.filter(task=>task.state==='pending'||task.state==='working')||[];
  const qcVersions=state?.versions.filter(version=>version.returnedAt&&!version.qc&&!qcTasks.some(task=>task.source.kind==='version'&&task.source.versionId===version.id))||[];
  const weekShipments=state?.fulfillment.shipments.filter(shipment=>shipment.state!=='cancelled'&&[shipment.plannedDate,shipment.departedAt?.slice(0,10)].some(date=>date&&date>=weekStart&&date<=weekEnd))||[];
  const statTitles={development:'在途开发案',qc:'待 QC 评审',shipping:'本周出运',invoices:'应收待核销'};
  const statRows:Array<{id:string;label:string;detail:string;target:MistTarget}>=statView==='development'?activeDevs.map(dev=>({id:dev.id,label:dev.code,detail:dev.name,target:{view:'development/detail',id:dev.id}})):statView==='qc'?[...qcTasks.map(task=>({id:task.id,label:task.code,detail:`${task.factory} · ${task.kind==='production'?'生产检验':'样品评审'}`,target:{view:'qc-workbench',id:task.id}})),...qcVersions.map(version=>({id:version.id,label:`${state?.devs.find(dev=>dev.id===version.devId)?.code||''} · ${version.label}`,detail:version.factory,target:{view:'development/detail',id:version.devId,versionId:version.id}}))]:statView==='shipping'?weekShipments.map(shipment=>({id:shipment.id,label:shipment.code,detail:`${shipment.customer} · ${shipment.plannedDate||shipment.departedAt?.slice(0,10)||''}`,target:{view:'shipments',id:shipment.id}})):(state?.invoices.filter(invoice=>invoice.open>0)||[]).map(invoice=>({id:invoice.id,label:invoice.code,detail:`${invoice.customer} · ${money(invoice.open)} ${invoice.currency}`,target:{view:'payment-vouchers',id:invoice.id}}));
  const hour = new Date().getHours(), greeting = hour < 6 ? '夜深了' : hour < 12 ? '上午好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
  const unread = visibleMistNotifications(state,view=>session.canAccessView(view as View)).filter(notification=>!notification.readAt);
  const brief: Array<{ strong: React.ReactNode; text: React.ReactNode; onClick?: () => void }> = unread.slice(0, 3).map(notification => ({ strong: notification.title, text: notification.detail,
    onClick: () => void run(async () => { const bound=scope;await workspace.run({ type: 'notification.read', payload: { id: notification.id } }); if(alive.current&&activeScope.current===bound)go(notification.target.view, notification.target.id, notification.target); }) }));
  if (!brief.length) (state?.events.slice().sort((a, b) => b.at.localeCompare(a.at)).slice(0, 3) ?? []).forEach(event => brief.push({ strong: event.actor, text: event.text, onClick: () => openAI(`说明这条工作记录：${event.text}`) }));
  if (!brief.length) brief.push({ strong: '暂无工作动态', text: '创建开发案或推进工作后，这里会显示对应记录。', onClick: () => go('development/new') });
  const beginTask = () => { const task = tasks[0] ?? state?.tasks[0]; setSelectedTask(task?.id ?? ''); setTaskDone(task?.done ?? false); setTaskDialog(true); };
  const chosenTask = state?.tasks.find(task => task.id === selectedTask);
  const dateLabel = new Date(`${today}T12:00:00`).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  return (
    <MistPage>
      <PageHeader variant="greeting" eyebrow={`${dateLabel} · ${workspace.workspace?.name ?? '工作空间'}`} title={<>{greeting}，<em>{state?.settings.profileName?.trim() || session.user?.displayName || '同事'}</em></>}
        description={!state ? (loading ? '正在读取你的工作空间…' : '工作空间尚未读取成功，请重试。') : `${hidden.size ? '当前可见' : '当前有'} ${allTasks.length} 件事等你推进，其中 ${allTasks.filter(task => task.due === today).length} 件今天到期。`}
        actions={<><Segmented<'today' | 'week'> ariaLabel="时间范围" value={range} onChange={setRange} options={[{ value: 'today', label: '今天' }, { value: 'week', label: '本周' }]} />
          <Button variant="primary" icon={Plus} disabled={busy || !state || !session.hasPermission('products:write')} onClick={() => go('development/new')}>新建</Button></>} />
      {(error || workspace.error) && <Banner tone="bad" title={error || workspace.error} actions={<Button size="sm" icon={RefreshCw} onClick={() => { setError(''); void workspace.refresh(); }}>重新读取</Button>} />}
      {pending && !saving && <Banner tone="warn" title="上一次操作结果待核对" actions={<Button size="sm" disabled={saving} onClick={() => void workspace.recover().catch(problem=>setError(problem instanceof Error?problem.message:'原请求核对失败'))}>核对原请求</Button>}>核对完成前，暂停提交新的操作。</Banner>}
      <StatGrid>
        <StatCard icon={Layers} label="在途开发案" value={hiddenStats.development ? '已隐藏' : state ? activeDevs.length : '—'} unit={hiddenStats.development ? undefined : '个'} foot={hiddenStats.development ? '无查看权限，不代表没有开发案' : '当前工作区的进行中开发'} onClick={hiddenStats.development ? undefined : () => setStatView('development')} />
        <StatCard icon={BadgeCheck} label="待 QC 评审" value={hiddenStats.qc ? '已隐藏' : state ? qcTasks.length+qcVersions.length : '—'} unit={hiddenStats.qc ? undefined : '项'} foot={hiddenStats.qc ? '部分来源不可见，不能统计完整数量' : '待专业评审的任务与返样'} onClick={hiddenStats.qc ? undefined : () => setStatView('qc')} />
        <StatCard icon={Ship} label="本周出运" value={hiddenStats.shipping ? '已隐藏' : state ? weekShipments.length : '—'} unit={hiddenStats.shipping ? undefined : '票'} foot={hiddenStats.shipping ? '无查看权限，不代表没有出运' : '按实际出运请求与记录'} onClick={hiddenStats.shipping ? undefined : () => setStatView('shipping')} />
        <StatCard icon={Wallet} label="应收待核销" value={hiddenStats.invoices ? '已隐藏' : state ? money(mainCurrency?.[1] ?? 0) : '—'} unit={hiddenStats.invoices ? undefined : mainCurrency?.[0] ?? ''} foot={hiddenStats.invoices ? '无查看权限，不代表应收为零' : currencies.length > 1 ? currencies.filter(([currency]) => currency !== mainCurrency?.[0]).map(([currency, value]) => `${currency} ${money(value)}`).join(' · ') : (state ? `${state.invoices.filter(item => item.open > 0).length} 张未结发票` : '等待工作区数据')} onClick={hiddenStats.invoices ? undefined : () => setStatView('invoices')} />
      </StatGrid>
      <section className="mist-grid">
        <HeroFocus className="mist-col-8" meta={focus ? [<span className="mist-mono">{dev?.code ?? focus.target.id}</span>, dev?.customer ?? focus.kind] : []} media={dev ? { src: IMG[dev.img], alt: dev.name } : undefined}
          title={loading ? '正在读取当前焦点' : focus ? <>{dev?.name ?? focus.title}<br />{version ? `${version.label} · ${dev?.state ?? '待处理'}` : focus.title}</> : '当前没有待处理事项'} description={dev?.goal ?? (focus ? '打开原事项，继续完成下一步工作。' : '可以查看工作动态，或创建新的开发案。')}
          steps={dev ? STAGES.map((label, index) => ({ label, state: index < dev.stage ? 'done' : index === dev.stage ? 'now' : 'todo' })) : undefined}
          actions={<><Button variant="white" disabled={busy || !focus} iconRight={ArrowRight} onClick={() => focus && openTarget(focus.target)}>打开事项</Button><Button variant="glass" disabled={busy || !version?.qc} icon={FileText} onClick={() => setReportVersion(version?.id ?? null)}>QC 报告</Button></>} />
        <AIBrief className="mist-col-4" icon={Sparkles} sub="工作区通知与记录 · 事实摘要" onAsk={() => openAI('请根据当前工作区记录，整理下一步行动建议。')} items={state?.settings.notifications.suggestions===false?[{strong:'主动建议已关闭',text:'仍可手动打开小竹。',onClick:()=>openAI('请根据当前工作区记录，整理下一步行动建议。')}]:brief} />
        <Card className="mist-col-8">
          <CardHeader title="接着完成" tools={<><Dropdown<'due' | 'title'> label="排序" value={sort} onChange={setSort} options={[{ value: 'due', label: '按期限' }, { value: 'title', label: '按名称' }]} /><Button variant="quiet" size="sm" icon={SlidersHorizontal} disabled={busy || !state?.tasks.length} onClick={beginTask}>管理任务</Button></>}><span className="mist-muted" style={{ fontSize: 13 }}>{tasks.length} 项</span></CardHeader>
          {loading ? <CardBody><Skeleton height={72} /><Skeleton height={72} /></CardBody> : taskRows.length ? <TaskList items={taskRows} onOpen={item => { const task = tasks.find(task => task.id === item.id); if (task) openTarget(task.target); }} /> : <EmptyState compact title="这个时间范围没有待办" description="可以切换本周，或查看工作区其他事项。" />}
        </Card>
        <Card className="mist-col-4">
          <CardHeader title={day===today?'今日安排':`${day.slice(5)} 安排`} tools={<TextLink iconRight={ArrowUpRight} onClick={() => go('calendar',undefined,{section:day})}>日历</TextLink>} />
          <WeekStrip days={days.map(value => ({ ...value, dots: state?.calendar.filter(event => event.date === value.key).length ?? 0 }))} value={day} onChange={setDay} />
          <Agenda events={(state?.calendar.filter(event => event.date === day).slice().sort((a, b) => a.time.localeCompare(b.time)) ?? []).map(event => ({ time: event.time, title: event.target ? <TextLink onClick={() => openTarget(event.target!)}>{event.title}</TextLink> : event.title, meta: event.note }))} />
          {!loading && !state?.calendar.some(event => event.date === day) && <EmptyState compact title="这一天没有安排" action={<TextLink onClick={() => go('calendar',undefined,{section:day})}>添加日程</TextLink>} />}
        </Card>
      </section>
      <Dialog open={taskDialog} onClose={() => setTaskDialog(false)} title="任务状态" footer={<><Button variant="quiet" onClick={() => setTaskDialog(false)}>关闭</Button><Button variant="primary" disabled={busy || !chosenTask || chosenTask.done === taskDone} onClick={() => void run(async () => { await workspace.run({ type: 'task.complete', payload: { id: selectedTask, done: taskDone } }); if (alive.current && activeScope.current === scope) setTaskDialog(false); }, taskDone ? '已完成事项' : '已重新打开事项')}>保存状态</Button></>}>
        <FormGrid cols={1}><Field label="事项"><Select aria-label="选择事项" value={selectedTask} onChange={event => { const task = state?.tasks.find(item => item.id === event.target.value); setSelectedTask(event.target.value); setTaskDone(task?.done ?? false); }} options={(state?.tasks ?? []).map(task => ({ value: task.id, label: task.title }))} /></Field><Switch label="已完成" checked={taskDone} disabled={busy} onChange={setTaskDone} /></FormGrid>
      </Dialog>
      <Dialog open={!!reportVersion} onClose={() => setReportVersion(null)} title={report?.qc?.report || 'QC 评审'}>
        {report?.qc ? <KeyValue items={[{ label: '版本', value: report.label }, { label: '评审人', value: report.qc.reviewer }, { label: '结论', value: ({ pass: '通过', conditional: '有保留通过', reject: '不通过' })[report.qc.result] }, { label: '评审时间', value: report.qc.reviewedAt }, { label: '意见', value: report.qc.opinion }]} /> : <EmptyState compact title="此版本没有可读取的评审记录" />}
      </Dialog>
      <Dialog open={!!statView && !hiddenStats[statView]} onClose={()=>setStatView(null)} title={statView?statTitles[statView]:'统计明细'}>
        {statRows.length?statRows.map(row=><Button key={row.id} block onClick={()=>{setStatView(null);openTarget(row.target);}}>{row.label} · {row.detail}</Button>):<EmptyState compact title="当前范围没有记录"/>}
      </Dialog>
    </MistPage>
  );
}
