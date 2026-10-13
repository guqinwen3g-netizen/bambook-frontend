/** QC 工作台：先选面料 / 成衣专业板块，再分样品评审 / 生产检验；任务按工厂与检查地点分组，详情承接报告、门禁与业务恢复。 */
import React from 'react';
import { CalendarClock, ChevronDown, ChevronRight, ClipboardCheck, Columns3, FlaskConical, Layers, List, Plus, RefreshCw, Repeat2, SearchX, Shirt, UserRoundCheck } from 'lucide-react';
import { BackLink, Banner, Button, Card, CardBody, CardButton, CardHeader, DataTable, Dialog, Dropdown, EmptyState, Facts, Field, FormGrid, Icon, Kanban, MeasurementTable, MistPage, Mono, PageHeader, Pill, Pipeline, SearchField, Segmented, Select, Tabs, TextArea, TextInput, Tile, Toolbar, UploadZone, type Tone } from '../../../../../components/mist';
import type { MistQc, MistState } from '../../../../../server/src/shared/mistWorkspace';
import type { FulfillmentCommand, FulfillmentQcReport, FulfillmentQcTask } from '../../../../../server/src/shared/mistFulfillment';
import { fulfillmentSampleRoleLabel, fulfillmentSourceLabel } from '../../../../../server/src/shared/mistFulfillment';
import { useMistWorkspace } from '../../runtime/workspace';
import { useMistSession } from '../../runtime/auth';
import { useNav } from '../../nav';
import { ModuleEditorDialog, type ModuleEditorSpec } from './ModuleWorkbench';
import { emptyOption, Events, field, localNow, parseSource, RecordFiles, SourceLink, sourceOptions, text, today, useEditor } from './fulfillmentKit';
import { useRouteDraft } from './useRouteDraft';
import { ActionBar, DetailBlock, DetailBody, ListDetail, shortWhen } from './pageKit';

type Domain = FulfillmentQcTask['domain'];
type Kind = FulfillmentQcTask['kind'];
type QcState = FulfillmentQcTask['state'];
type StateFilter = 'all' | QcState;
type Owner = 'all' | 'mine' | 'unclaimed';

export const QC_STATE_LABEL: Record<QcState, string> = { pending: '待认领', working: '处理中', reported: '报告已回传', blocked: '质量阻断', awaiting_business: '待业务恢复' };
const QC_STATE_TONE: Record<QcState, Tone> = { pending: 'warn', working: 'neutral', reported: 'ok', blocked: 'bad', awaiting_business: 'warn' };
const RESULT_LABEL: Record<MistQc['result'], string> = { pass: '通过', conditional: '有保留通过', reject: '不通过' };
const RESULT_TONE: Record<MistQc['result'], Tone> = { pass: 'ok', conditional: 'warn', reject: 'bad' };
const DOMAIN_LABEL: Record<Domain, string> = { fabric: '面料QC', garment: '成衣QC' };
const KIND_LABEL: Record<Kind, string> = { sample: '样品评审', production: '生产检验' };
const isNok = (task: FulfillmentQcTask) => task.state === 'blocked' || task.state === 'awaiting_business';
const isOpen = (task: FulfillmentQcTask) => task.state !== 'reported';
const isOverdue = (task: FulfillmentQcTask, day: string) => (task.state === 'pending' || task.state === 'working') && !!task.due && task.due < day;
const branchKey = (task: FulfillmentQcTask) => task.source.kind === 'orderLine' && task.source.productionId ? task.source.productionId : task.id;

/** Entry-card numbers per professional domain; never a mixed fabric + garment total. */
export function qcDomainMetrics(tasks: FulfillmentQcTask[], domain: Domain) {
  const scoped = tasks.filter(task => task.domain === domain);
  return {
    samples: scoped.filter(task => task.kind === 'sample' && (task.state === 'pending' || task.state === 'working')).length,
    branches: new Set(scoped.filter(task => task.kind === 'production' && isOpen(task)).map(branchKey)).size,
    nok: scoped.filter(isNok).length,
    total: scoped.length,
  };
}

/** What the source module may do next, derived only from the task's recorded state and decisions. */
function qcGate(task: FulfillmentQcTask): { tone: Tone; title: string; text: string } {
  switch (task.state) {
    case 'pending': return { tone: 'warn', title: '等待QC认领', text: `${DOMAIN_LABEL[task.domain]}认领后安排现场检查；报告回传前，来源的下一步保持锁定。` };
    case 'working': return { tone: 'accent', title: `${task.assignee || 'QC'} 检查中`, text: '提交报告后结论回到来源；测量偏差不会自动决定结论。' };
    case 'blocked': return { tone: 'bad', title: '质量阻断', text: task.kind === 'production' ? '最新报告不通过，生产分支已标记风险。整改后由当前QC追加复验报告。' : '最新报告不通过。整改或重新打样后，由当前QC追加复验报告。' };
    case 'awaiting_business': return { tone: 'warn', title: '复验已回传 · 待业务恢复', text: '业务员核对整改与复验结论后，确认继续生产。' };
    case 'reported':
      if (task.kind === 'production') return task.businessContinued ? { tone: 'ok', title: '业务已恢复生产', text: task.businessContinued.note } : { tone: 'ok', title: '检验已回传', text: '生产分支按计划继续，后续检查在本任务追加报告。' };
      if (task.source.kind === 'version') return { tone: 'ok', title: '报告已回到开发版本', text: '业务员在开发案记录需求方意见，并决定是否进入下一轮。' };
      if (task.businessContinued) return { tone: 'ok', title: '业务已继续', text: task.businessContinued.note };
      if (task.businessConfirmation?.result === 'approved') return { tone: 'accent', title: '需求方已确认采用', text: '等待业务员确认继续。' };
      if (task.businessConfirmation?.result === 'rejected') return { tone: 'bad', title: '需求方不采用', text: task.businessConfirmation.note };
      return { tone: 'accent', title: '报告已回传', text: '等待业务员记录需求方确认。' };
  }
}

type TaskGroup = { key: string; factory: string; location: string; tasks: FulfillmentQcTask[]; open: number; earliest: string; contacts: string[] };
/** Factory × inspection site groups: open work first, earliest planned inspection first. */
function groupTasks(tasks: FulfillmentQcTask[]): TaskGroup[] {
  const groups = new Map<string, TaskGroup>();
  for (const task of tasks) {
    const key = `${task.factory}\u0000${task.location}`;
    const group = groups.get(key) || { key, factory: task.factory || '工厂未记录', location: task.location || '地点未记录', tasks: [], open: 0, earliest: '', contacts: [] };
    group.tasks.push(task);
    if (isOpen(task)) { group.open++; if (task.due && (!group.earliest || task.due < group.earliest)) group.earliest = task.due; }
    if (task.contact && !group.contacts.includes(task.contact)) group.contacts.push(task.contact);
    groups.set(key, group);
  }
  for (const group of groups.values()) group.tasks.sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)) || (isOpen(a) ? (a.due || '9').localeCompare(b.due || '9') : b.createdAt.localeCompare(a.createdAt)));
  return [...groups.values()].sort((a, b) => Number(b.open > 0) - Number(a.open > 0) || (a.earliest || '9').localeCompare(b.earliest || '9') || a.factory.localeCompare(b.factory));
}

function taskSubject(state: MistState, task: FulfillmentQcTask) {
  const sample = state.fulfillment.samples.find(item => item.id === task.sampleId);
  if (sample) return `${sample.code} · ${sample.role ? fulfillmentSampleRoleLabel(sample.role) : '开发样'}${sample.size ? ' · ' + sample.size : ''}`;
  if (task.source.kind === 'version') return '开发返样';
  const production = state.productions.find(item => task.source.kind === 'orderLine' && item.id === task.source.productionId);
  return production ? `生产分支 ${production.code}` : '订单条目';
}

export function QcWorkbenchPage() {
  const { state, run, error, refresh, loading, saving, pending } = useMistWorkspace(), session = useMistSession(), { route, go } = useNav(), editor = useEditor();
  const [domain, setDomain] = React.useState<Domain>('garment'), [kind, setKind] = React.useState<Kind>('sample');
  const [query, setQuery] = React.useState(''), [stateFilter, setStateFilter] = React.useState<StateFilter>('all'), [owner, setOwner] = React.useState<Owner>('all'), [mode, setMode] = React.useState<'groups' | 'board'>('groups');
  const [selected, setSelected] = useRouteDraft(route.id || ''), [reportTaskId, setReportTaskId] = useRouteDraft(''), [failure, setFailure] = useRouteDraft('');
  const [dialog, setDialog] = useRouteDraft<ModuleEditorSpec | null>(null), [drawer, setDrawer] = React.useState(!!route.id), [collapsed, setCollapsed] = React.useState<string[]>([]), [busy, setBusy] = React.useState(false);
  const all = state?.fulfillment.qcTasks || [], day = today();
  React.useEffect(() => {
    const task = all.find(t => t.id === route.id);
    if (task) { setSelected(task.id); setDomain(task.domain); setKind(task.kind); return; }
    if (route.id) return;
    setSelected('');
    if (route.section === 'sample' || route.section === 'production') setKind(route.section);
    if (route.versionId) { const dev = state?.devs.find(d => d.id === state.versions.find(v => v.id === route.versionId)?.devId); if (dev) setDomain(dev.values.category.includes('面料') ? 'fabric' : 'garment'); }
    else if (route.orderLineId) { const orderId = state?.orderLines.find(l => l.id === route.orderLineId)?.orderId; const order = state?.orders.find(o => o.id === orderId); if (order) setDomain(order.type); }
  }, [route.id, route.section, route.versionId, route.orderLineId, route.productionId, state?.fulfillment.qcTasks]);
  const scoped = all.filter(t => t.domain === domain && t.kind === kind);
  const needle = query.trim().toLowerCase();
  const searched = scoped.filter(t => (!needle || `${t.code} ${t.factory} ${t.location} ${t.contact} ${t.requestedBy} ${t.assignee} ${state ? fulfillmentSourceLabel(state, t.source) : ''} ${state ? taskSubject(state, t) : ''}`.toLowerCase().includes(needle))
    && (owner === 'all' || (owner === 'mine' ? t.assigneeId === session.user?.id : !t.assigneeId)));
  const rows = searched.filter(t => stateFilter === 'all' || t.state === stateFilter);
  const current = all.find(t => t.id === selected);
  const canQc = (d: Domain) => session.hasPermission(`qc:${d}_chain:write`);
  const canRequest = session.hasPermission('orders:write') || session.hasPermission('products:write');
  const locked = busy || saving || !!pending;
  const reportTask = all.find(t => t.id === reportTaskId);
  if (reportTask) return <QcReportEditor task={reportTask} onClose={() => setReportTaskId('')} />;
  if (editor.spec) return editor.view;

  const pick = (task: FulfillmentQcTask) => { setSelected(task.id); setDrawer(true); go('qc-workbench', task.id, { section: task.kind }); };
  const changeDomain = (value: Domain) => { setDomain(value); setSelected(''); setStateFilter('all'); go('qc-workbench', undefined, { section: kind }); };
  const changeKind = (value: Kind) => { setKind(value); setSelected(''); setStateFilter('all'); go('qc-workbench', undefined, { section: value }); };
  const act = async (command: FulfillmentCommand) => { setFailure(''); setBusy(true); try { await run(command); } catch (e) { setFailure(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const qcSources = [emptyOption, ...(state?.fulfillment.samples || []).filter(sample => sample.source.kind !== 'manual').map(sample => ({ value: 'sample:' + sample.id, label: `${sample.code} · ${sample.name} · ${sample.role ? fulfillmentSampleRoleLabel(sample.role) : '开发样'} · ${sample.size}` })), ...sourceOptions(state).filter(option => option.value.startsWith('version:') || option.value.startsWith('production:'))];
  const request = () => editor.open({
    title: '从准确来源发起QC', submitLabel: '发起QC',
    description: '选择已返样的开发版本、订单样品实物或生产分支。QC 认领后到现场检查并回传报告；结论只解锁来源的下一步，不替来源推进业务。',
    sections: [
      { id: 'source', label: '来源与类别', description: '样品评审对应开发返样或订单样品实物；生产检验必须对应准确生产分支。', fields: ['source', 'kind'] },
      { id: 'site', label: '现场安排', description: '同一工厂与检查地点的任务会在工作台合并显示，便于QC一次到场。', fields: ['factory', 'location', 'contact', 'due'] },
    ],
    fields: [field('source', '送检来源', 'select', true, qcSources.filter(option => !option.value || (option.value.startsWith('version:') ? session.hasPermission('products:write') : session.hasPermission('orders:write')))), field('kind', '任务类别', 'select', true, [{ value: 'sample', label: '样品评审' }, { value: 'production', label: '生产检验' }]), field('factory', '工厂'), field('location', '实际检查地点'), field('contact', '现场联系人', 'text', false), field('due', '预计检查日', 'date')],
    initialValues: { source: route.productionId ? 'production:' + route.productionId : route.versionId ? 'version:' + route.versionId : route.orderLineId ? 'line:' + route.orderLineId : '', kind, factory: state?.productions.find(p => p.id === route.productionId)?.factory || state?.versions.find(v => v.id === route.versionId)?.factory || '', location: '', contact: '', due: today() },
    submit: async values => {
      if (!state) return;
      const sample = text(values, 'source').startsWith('sample:') ? state.fulfillment.samples.find(item => item.id === text(values, 'source').slice(7)) : undefined;
      const source = sample ? sample.source : parseSource(state, text(values, 'source'));
      if (source.kind === 'manual') throw new Error('请选择准确系统实物');
      const taskDomain = source.kind === 'version' ? (state.devs.find(d => d.id === source.devId)?.values.category.includes('面料') ? 'fabric' : 'garment') : state.orders.find(o => o.id === source.orderId)!.type;
      const taskKind = text(values, 'kind') as Kind;
      const saved = await run({ type: 'fulfillment.qc.request', payload: { source, ...(sample ? { sampleId: sample.id } : {}), domain: taskDomain, kind: taskKind, factory: text(values, 'factory'), location: text(values, 'location'), contact: text(values, 'contact'), due: text(values, 'due') } });
      setDomain(taskDomain); setKind(taskKind); setSelected(String(saved.result.id || '')); go('qc-workbench', String(saved.result.id || ''));
    },
  });
  const confirmSpec = (task: FulfillmentQcTask): ModuleEditorSpec => ({ title: '记录需求方样品确认', submitLabel: '记录确认', fields: [field('result', '需求方决定', 'select', true, [emptyOption, { value: 'approved', label: '确认采用' }, { value: 'rejected', label: '不采用' }]), field('note', '需求方确认依据', 'textarea')], initialValues: { result: '', note: '' }, submit: values => run({ type: 'fulfillment.qc.confirm', payload: { id: task.id, result: text(values, 'result') as 'approved' | 'rejected', note: text(values, 'note') } }) });
  const continueSpec = (task: FulfillmentQcTask): ModuleEditorSpec => ({ title: task.kind === 'production' ? '确认继续生产' : '业务确认继续', submitLabel: task.kind === 'production' ? '确认继续生产' : '确认继续', fields: [field('note', '业务处理与恢复依据', 'textarea')], initialValues: { note: '' }, submit: values => run({ type: 'fulfillment.qc.continue', payload: { id: task.id, note: text(values, 'note') } }) });

  const metrics = { fabric: qcDomainMetrics(all, 'fabric'), garment: qcDomainMetrics(all, 'garment') };
  const stateCount = (value: StateFilter) => value === 'all' ? searched.length : searched.filter(t => t.state === value).length;
  const groups = groupTasks(rows);
  const toggleGroup = (key: string) => setCollapsed(keys => keys.includes(key) ? keys.filter(item => item !== key) : [...keys, key]);
  const clearFilters = () => { setQuery(''); setStateFilter('all'); setOwner('all'); };
  const sourceSample = current ? state?.fulfillment.samples.find(sample => sample.id === current.sampleId) : undefined;
  const empty = scoped.length
    ? <EmptyState icon={SearchX} title="没有符合条件的QC任务" description="换个关键词或清除筛选。" action={<Button onClick={clearFilters}>清除筛选</Button>} />
    : <EmptyState icon={ClipboardCheck} title={loading ? '正在读取QC任务' : `还没有${DOMAIN_LABEL[domain]}的${KIND_LABEL[kind]}任务`} description={kind === 'sample' ? '业务员在已返样的开发版本或订单样品实物上发起送检后，任务会出现在这里。' : '业务员在准确生产分支发起生产检验后，任务会出现在这里。'} action={canRequest ? <Button icon={Plus} onClick={request}>从来源发起QC</Button> : undefined} />;

  const list = mode === 'board'
    ? (rows.length ? <Kanban columns={[
        { id: 'pending', title: '待认领', color: 'var(--mist-ink-3)', items: rows.filter(t => t.state === 'pending') },
        { id: 'working', title: '处理中', color: 'var(--mist-accent)', items: rows.filter(t => t.state === 'working') },
        { id: 'blocked', title: '质量问题', color: 'var(--mist-bad)', items: rows.filter(isNok) },
        { id: 'reported', title: '报告已回传', color: 'var(--mist-ok)', items: rows.filter(t => t.state === 'reported') },
      ]} itemKey={t => t.id} onOpen={pick} renderCard={t => <><Mono>{t.code}</Mono><div>{state ? fulfillmentSourceLabel(state, t.source) : t.code}</div><div>{t.factory} · {t.location}</div><div className="mist-kb-card-foot"><Pill tone={QC_STATE_TONE[t.state]}>{QC_STATE_LABEL[t.state]}</Pill><span className="mist-spacer" />{t.due}</div></>} /> : <Card>{empty}</Card>)
    : <div className="mist-col" data-qc-groups>
        {!groups.length && <Card>{empty}</Card>}
        {groups.map(group => { const open = !collapsed.includes(group.key); return <Card key={group.key} data-qc-group={group.key}>
          <CardHeader title={`${group.factory} · ${group.location}`} sub={[group.open ? `${group.open} 条待办` : '全部已回传', group.earliest ? `最早 ${shortWhen(group.earliest)}` : '', group.contacts.length ? `联系人 ${group.contacts.join('、')}` : '现场联系人未记录'].filter(Boolean).join(' · ')}
            leading={<Tile icon={domain === 'fabric' ? Layers : Shirt} tone={group.open ? 'accent' : undefined} />}
            tools={<Button size="sm" variant="quiet" icon={open ? ChevronDown : ChevronRight} aria-expanded={open} aria-label={`${open ? '收起' : '展开'} ${group.factory} · ${group.location}`} onClick={() => toggleGroup(group.key)}>{group.tasks.length} 条</Button>} />
          {open && <div className="mist-tasks">{group.tasks.map(task => <button key={task.id} type="button" className="mist-task" data-workbench-item aria-pressed={task.id === current?.id} onClick={() => pick(task)}>
            <span className="mist-task-when" data-urgent={isOverdue(task, day) || undefined}>{task.due ? shortWhen(task.due) : '未排期'}</span>
            <div style={{ minWidth: 0 }}>
              <div className="mist-task-t"><Mono>{task.code}</Mono> · {state ? fulfillmentSourceLabel(state, task.source) : ''}</div>
              <div className="mist-task-d">{state ? taskSubject(state, task) : ''} · 发起 {task.requestedBy}{isOverdue(task, day) ? ' · 已过预计检查日' : ''}</div>
            </div>
            <Pill tone={QC_STATE_TONE[task.state]}>{QC_STATE_LABEL[task.state]}</Pill>
            <span className="mist-note">{task.assignee || '未认领'}</span>
            <span className="mist-go"><Icon icon={ChevronRight} size="sm" /></span>
          </button>)}</div>}
        </Card>; })}
      </div>;

  const detail = current && state
    ? <QcTaskDetail task={current} state={state} me={session.user?.id || ''} canQc={canQc(current.domain)} canBusiness={session.hasPermission('orders:write')} locked={locked}
        onClaim={() => void act({ type: 'fulfillment.qc.claim', payload: { id: current.id, domain: current.domain } })}
        onReport={() => setReportTaskId(current.id)}
        onConfirm={() => setDialog(confirmSpec(current))}
        onContinue={() => setDialog(continueSpec(current))}
        onBack={sourceSample ? () => go('samples', sourceSample.id, sourceSample.role === 'shipping' && sourceSample.shipmentId ? { section: 'shipment:' + sourceSample.shipmentId, productionId: sourceSample.source.kind === 'orderLine' ? sourceSample.source.productionId : undefined } : {}) : undefined}
        backLabel={sourceSample?.role === 'shipping' ? '返回本票船样' : '返回实物样品'} />
    : <EmptyState icon={ClipboardCheck} title="任务详情" description={loading ? '正在读取QC任务' : '从左侧选择一条任务，查看来源、现场与报告'} compact />;

  return <MistPage width="wide">
    <PageHeader eyebrow="订单履约 · 专业检验" title="QC 工作台" description="先选专业板块，再处理准确样品与生产分支。报告回到业务来源，由业务员继续主线。"
      actions={<>
        <Button icon={RefreshCw} disabled={loading} onClick={() => void refresh()}>刷新</Button>
        <Button variant="primary" icon={Plus} disabled={!canRequest} title={canRequest ? undefined : '送检由业务员在准确来源发起'} onClick={request}>从来源发起QC</Button>
      </>} />
    {(error || failure) && <div className="mist-section"><Banner tone="bad" title="QC操作未完成" actions={error ? <Button onClick={() => void refresh()}>重试</Button> : undefined}>{failure || error}</Banner></div>}
    <div className="mist-domains" role="tablist" aria-label="QC 专业板块">
      {(['fabric', 'garment'] as const).map(value => { const m = metrics[value]; return <CardButton key={value} role="tab" aria-selected={domain === value} className="mist-domain" onClick={() => changeDomain(value)}>
        <span className="mist-domain-h"><Tile icon={value === 'fabric' ? Layers : Shirt} tone={domain === value ? 'accent' : undefined} /><b>{DOMAIN_LABEL[value]}</b><span className="mist-spacer" /><span className="mist-note">{canQc(value) ? '可处理' : '只读'} · 共 {m.total} 条</span></span>
        <span className="mist-domain-nums">
          <span><small>待处理样品</small><b>{m.samples}</b></span>
          <span><small>未结生产检验</small><b>{m.branches}</b></span>
          <span><small>NOK 待恢复</small><b className={m.nok ? 'mist-tone-bad' : undefined}>{m.nok}</b></span>
        </span>
      </CardButton>; })}
    </div>
    <Tabs<Kind> value={kind} onChange={changeKind} options={[{ value: 'sample', label: '样品评审', count: all.filter(t => t.domain === domain && t.kind === 'sample').length }, { value: 'production', label: '生产检验', count: all.filter(t => t.domain === domain && t.kind === 'production').length }]} />
    <Toolbar right={<Segmented ariaLabel="视图" value={mode} onChange={value => setMode(value as 'groups' | 'board')} options={[{ value: 'groups', icon: List, ariaLabel: '按工厂分组' }, { value: 'board', icon: Columns3, ariaLabel: '看板视图' }]} />}>
      <SearchField value={query} onChange={setQuery} placeholder="搜索任务号、来源、工厂或检查地点" />
      <Dropdown<Owner> label="负责人" value={owner} onChange={setOwner} options={[{ value: 'all', label: '全部负责人' }, { value: 'mine', label: '我认领的' }, { value: 'unclaimed', label: '待认领' }]} />
    </Toolbar>
    <Pipeline<StateFilter> value={stateFilter} onChange={setStateFilter} items={[
      { value: 'all', label: '全部', count: stateCount('all'), color: 'var(--mist-ink-2)' },
      { value: 'pending', label: '待认领', count: stateCount('pending'), color: 'var(--mist-warn)' },
      { value: 'working', label: '处理中', count: stateCount('working'), color: 'var(--mist-accent)' },
      { value: 'blocked', label: '质量阻断', count: stateCount('blocked'), color: 'var(--mist-bad)' },
      { value: 'awaiting_business', label: '待业务恢复', count: stateCount('awaiting_business'), color: 'var(--mist-warn)' },
      { value: 'reported', label: '报告已回传', count: stateCount('reported'), color: 'var(--mist-ok)' },
    ]} />
    <ListDetail list={list} detail={detail} drawerOpen={drawer && !!current} onDrawerClose={() => setDrawer(false)} drawerTitle={current ? `${current.code} · ${KIND_LABEL[current.kind]}` : 'QC任务'} drawerSub={current ? `${current.factory} · ${current.location}` : undefined} />
    <ModuleEditorDialog spec={dialog} onClose={() => setDialog(null)} />
  </MistPage>;
}

function QcTaskDetail({ task, state, me, canQc, canBusiness, locked, onClaim, onReport, onConfirm, onContinue, onBack, backLabel }: {
  task: FulfillmentQcTask; state: MistState; me: string; canQc: boolean; canBusiness: boolean; locked: boolean;
  onClaim: () => void; onReport: () => void; onConfirm: () => void; onContinue: () => void; onBack?: () => void; backLabel: string;
}) {
  const reports = state.fulfillment.qcReports.filter(report => report.taskId === task.id).slice().reverse();
  const gate = qcGate(task), mine = !!task.assigneeId && task.assigneeId === me;
  const production = task.source.kind === 'orderLine' ? state.productions.find(item => item.id === (task.source as { productionId?: string }).productionId) : undefined;
  const line = task.source.kind === 'orderLine' ? state.orderLines.find(item => item.id === (task.source as { lineId: string }).lineId) : undefined;
  const fact = production ? state.fulfillment.productionFacts?.find(item => item.productionId === production.id) : undefined;
  const sizes = fact?.completion?.sizeQuantities || fact?.sizes || [];
  const sample = state.fulfillment.samples.find(item => item.id === task.sampleId);
  const claimReason = !canQc ? `需要${DOMAIN_LABEL[task.domain]}权限` : task.assigneeId && !mine ? `已由 ${task.assignee} 认领` : false;
  const reportReason = !canQc ? `需要${DOMAIN_LABEL[task.domain]}权限` : !task.assigneeId ? '请先认领任务' : !mine ? `仅当前QC（${task.assignee}）可提交` : false;
  const confirmable = task.kind === 'sample' && task.source.kind === 'orderLine' && task.state === 'reported';
  const continuable = task.state === 'awaiting_business' || (task.kind === 'sample' && task.businessConfirmation?.result === 'approved' && !task.businessContinued);
  return <DetailBody data-qc-detail={task.id} heading={<div>
      <span className="mist-mono mist-muted">{task.code}</span>
      <div className="mist-h2" style={{ fontSize: 19, marginTop: 4 }}>{fulfillmentSourceLabel(state, task.source)}</div>
    </div>}>
    <div className="mist-row" style={{ flexWrap: 'wrap' }}><Pill tone={QC_STATE_TONE[task.state]}>{QC_STATE_LABEL[task.state]}</Pill><Pill>{DOMAIN_LABEL[task.domain]}</Pill><Pill tone="accent">{KIND_LABEL[task.kind]}</Pill></div>
    <Banner tone={gate.tone} title={gate.title}>{gate.text}</Banner>
    <DetailBlock title="来源与送审实物">
      <Facts items={[
        { label: '准确来源', value: <SourceLink source={task.source} /> },
        { label: task.kind === 'production' ? '生产分支' : '准确实物', value: sample ? `${sample.code} · ${sample.role ? fulfillmentSampleRoleLabel(sample.role) : '开发样'}` : production ? `${production.code} · ${production.qty} ${line?.unit || ''}`.trim() : task.source.kind === 'version' ? '开发版本返样' : '订单条目' },
        { label: '业务发起人', value: task.requestedBy || '未记录' },
        { label: '发起', value: shortWhen(task.createdAt) },
        ...(task.kind === 'production' && sizes.length ? [{ label: '生产尺码', value: sizes.map(size => `${size.size} ${size.quantity}`).join(' · ') }] : []),
        { label: task.kind === 'production' ? '业务恢复记录' : '样品业务继续', value: task.businessContinued ? task.businessContinued.note : '尚未记录' },
      ]} />
      {task.businessConfirmation && <span className="mist-note">需求方{task.businessConfirmation.result === 'approved' ? '确认采用' : '不采用'} · {task.businessConfirmation.actor} · {shortWhen(task.businessConfirmation.at)} · {task.businessConfirmation.note}</span>}
      {onBack && <Button block onClick={onBack}>{backLabel}</Button>}
    </DetailBlock>
    <DetailBlock title="现场信息">
      <Facts items={[
        { label: '工厂', value: task.factory || '未记录' },
        { label: '检查地点', value: task.location || '未记录' },
        { label: '现场联系人', value: task.contact || '未记录' },
        { label: '预计检查日', value: <span className={isOverdue(task, today()) ? 'mist-tone-bad' : undefined}>{task.due || '未排期'}{isOverdue(task, today()) ? ' · 已过期' : ''}</span> },
        { label: '当前QC', value: task.assignee || '待认领' },
      ]} />
    </DetailBlock>
    <DetailBlock title="QC 操作">
      <ActionBar busy={locked} actions={[
        { label: '认领任务', icon: UserRoundCheck, onClick: onClaim, reason: claimReason, hidden: mine, primary: task.state === 'pending' },
        { label: '提交 / 追加复验报告', icon: ClipboardCheck, onClick: onReport, reason: reportReason, primary: mine && task.state !== 'reported' },
        { label: '转交', icon: Repeat2, onClick: () => undefined, reason: '转交（接收人与原因）尚未接入服务端，暂由当前QC继续处理', hidden: !canQc },
        { label: '改期', icon: CalendarClock, onClick: () => undefined, reason: '改期（新日期与原因）尚未接入服务端', hidden: !canQc },
      ]} />
    </DetailBlock>
    {(confirmable || continuable) && <DetailBlock title="业务接续">
      <ActionBar busy={locked} actions={[
        { label: '记录需求方确认', onClick: onConfirm, reason: canBusiness ? false : '由业务员记录需求方决定', hidden: !confirmable },
        { label: task.kind === 'production' ? '确认继续生产' : '业务确认继续', onClick: onContinue, reason: canBusiness ? false : '由业务员确认恢复', hidden: !continuable, primary: true },
      ]} />
    </DetailBlock>}
    <DetailBlock title={task.kind === 'production' ? `持续检查记录（${reports.length}）` : `评审报告（${reports.length}）`}>
      {reports.length ? reports.map((report, index) => <QcReportCard key={report.id} report={report} production={task.kind === 'production'} latest={index === 0} />) : <span className="mist-note">还没有报告。认领后到现场检查，提交报告即回到来源。</span>}
    </DetailBlock>
    <DetailBlock title="第三方测试">
      <span className="mist-note"><Icon icon={FlaskConical} size="xs" />送检机构、项目与预计出报告日的登记尚未接入服务端；外部报告可先作为附件随QC报告上传，由QC判读。</span>
    </DetailBlock>
    <DetailBlock title="处理记录"><Events entity="qc" id={task.id} /></DetailBlock>
  </DetailBody>;
}

function QcReportCard({ report, production, latest }: { report: FulfillmentQcReport; production: boolean; latest: boolean }) {
  return <div className="mist-col" data-qc-report={report.id}>
    <div className="mist-row" style={{ flexWrap: 'wrap' }}><b>{report.report}</b><Pill tone={RESULT_TONE[report.result]}>{RESULT_LABEL[report.result]}</Pill>{report.previousReportId && <span className="mist-note">复验</span>}{latest && <span className="mist-note">当前</span>}<span className="mist-spacer" /><span className="mist-note">{report.reviewer} · {new Date(report.reviewedAt).toLocaleString()}</span></div>
    {report.opinion && <p className="mist-sub">{report.opinion}</p>}
    {production && <DataTable ariaLabel={`${report.report} · 生产尺码检查`} rows={report.sizeChecks || []} rowKey={check => check.size} columns={[{ key: 'size', header: '实际尺码', render: check => check.size }, { key: 'inspected', header: '实际检查件数', align: 'right', render: check => check.inspected }, { key: 'result', header: '各码结论', render: check => check.result === 'pass' ? '通过' : '不通过' }, { key: 'basis', header: '检查依据', render: check => check.evidence }]} empty={<EmptyState title="未记录本次实际尺码检查" compact />} />}
    {report.measurements.length > 0 && <MeasurementTable rows={report.measurements} />}
    <RecordFiles key={report.id} ids={report.fileIds} />
  </div>;
}

type SizeCheck = { size: string; inspected: number; result: string; evidence: string };
type Measurement = { point: string; standard: number; actual: number; tolerance: number };
/** Full-page report form with a side guide; submission is confirmed because the conclusion is appended permanently to the source. */
export function QcReportEditor({ task, onClose }: { task: FulfillmentQcTask; onClose: () => void }) {
  const { state, run, uploadFile, pending, saving } = useMistWorkspace();
  const [result, setResult] = React.useState<MistQc['result'] | ''>(''), [report, setReport] = React.useState(''), [opinion, setOpinion] = React.useState(''), [at, setAt] = React.useState(localNow());
  const [measurements, setMeasurements] = React.useState<Measurement[]>([]), [ids, setIds] = React.useState<string[]>([]), [failure, setFailure] = useRouteDraft(''), [busy, setBusy] = React.useState(false), [confirming, setConfirming] = React.useState(false);
  const fact = state?.fulfillment.productionFacts?.find(item => task.source.kind === 'orderLine' && item.productionId === task.source.productionId);
  const garmentProduction = task.kind === 'production' && task.domain === 'garment';
  const [sizeChecks, setSizeChecks] = React.useState<SizeCheck[]>((fact?.completion?.sizeQuantities || fact?.sizes || []).map(size => ({ size: size.size, inspected: 0, result: '', evidence: '' })));
  const blocked = busy || saving || !!pending;
  const previous = state?.fulfillment.qcReports.filter(item => item.taskId === task.id) || [];
  const resultOptions = task.kind === 'production'
    ? [emptyOption, { value: 'pass', label: '通过（OK）' }, { value: 'conditional', label: '有保留通过 · 待业务确认' }, { value: 'reject', label: '不通过（NOK）' }]
    : [emptyOption, { value: 'pass', label: '通过' }, { value: 'conditional', label: '有保留通过' }, { value: 'reject', label: '不通过' }];
  const validate = () => {
    if (!result) return '请选择本次专业结论';
    if (!report.trim()) return '请填写报告编号';
    if (!opinion.trim()) return '请填写专业意见与影响范围';
    const checked = sizeChecks.filter(check => check.result);
    if (garmentProduction && !checked.length) return '请至少记录一个本次实际检查尺码';
    for (const check of checked) if (!(check.inspected > 0) || !check.evidence.trim()) return `尺码 ${check.size} 需填写实际检查件数和检查依据`;
    if (checked.some(check => check.result === 'reject') && result !== 'reject') return '存在尺码不通过时，总结论必须选择不通过';
    if (measurements.some(item => !item.point.trim())) return '请填写每个测量点的名称，或移除空白测量点';
    return '';
  };
  const review = () => { const problem = validate(); setFailure(problem); if (!problem) setConfirming(true); };
  const save = async () => {
    if (!result) return;
    setBusy(true); setFailure('');
    try {
      await run({ type: 'fulfillment.qc.report', payload: { id: task.id, domain: task.domain, result, report, opinion, reviewedAt: new Date(at).toISOString(), measurements, fileIds: ids, sizeChecks: sizeChecks.filter(check => check.result).map(check => ({ ...check, result: check.result as 'pass' | 'reject' })) } });
      onClose();
    } catch (e) { setFailure(e instanceof Error ? e.message : '报告未保存'); setConfirming(false); }
    finally { setBusy(false); }
  };
  const updateSize = (index: number, patch: Partial<SizeCheck>) => setSizeChecks(rows => rows.map((row, i) => i === index ? { ...row, ...patch } : row));
  const consequence = !result ? '' : result === 'reject'
    ? (task.kind === 'production' ? '生产分支将标记“QC 不通过”风险并阻断；整改后需在本任务追加复验报告。' : '来源保持锁定；整改或重新打样后需追加复验报告。')
    : result === 'conditional' ? (task.kind === 'production' ? '任务转为待业务恢复，由业务员确认后继续生产。' : '结论回到来源，由业务员结合需求方意见决定。')
    : (task.kind === 'production' && (task.state === 'blocked' || task.state === 'awaiting_business') ? '复验通过后转为待业务恢复，由业务员确认继续生产。' : '结论回到来源，解锁来源的下一步。');
  return <MistPage>
    <BackLink onClick={onClose}>返回QC工作台</BackLink>
    <PageHeader eyebrow={`${DOMAIN_LABEL[task.domain]} · ${KIND_LABEL[task.kind]}`} title="提交专业QC报告" description={`${task.code} · ${state ? fulfillmentSourceLabel(state, task.source) : ''}`} />
    {failure && <div className="mist-section"><Banner tone="bad" title="报告未保存">{failure}</Banner></div>}
    <div className="mist-detail" data-layout="main-rail">
      <div>
        <Card>
          <CardHeader title="结论与报告" sub="结论由实际检查人选择，测量偏差不会自动决定结论。" />
          <CardBody><FormGrid>
            <Field label="本次结论" required><Select aria-label="本次结论" value={result} onChange={e => setResult(e.target.value as MistQc['result'])} options={resultOptions} /></Field>
            <Field label="报告编号" required><TextInput aria-label="报告编号" value={report} onChange={e => setReport(e.target.value)} /></Field>
            <Field label="实际检查时间" required><TextInput aria-label="实际检查时间" type="datetime-local" value={at} onChange={e => setAt(e.target.value)} /></Field>
            <Field label="专业意见与影响范围" full required><TextArea aria-label="专业意见与影响范围" value={opinion} onChange={e => setOpinion(e.target.value)} /></Field>
          </FormGrid></CardBody>
        </Card>
        {task.kind === 'production' && sizeChecks.length > 0 && <Card>
          <CardHeader title="本次实际尺码检查" sub={garmentProduction ? '逐次追加检查事实；未检尺码选“本次未检”。最终放行要求覆盖全部实际生产尺码。' : '按实际检查的规格记录。'} />
          <CardBody><div className="mist-col">{sizeChecks.map((check, index) => <FormGrid key={check.size}>
            <Field label={`尺码 ${check.size} · 本次结论`}><Select aria-label={`尺码 ${check.size} · 本次结论`} value={check.result} onChange={event => updateSize(index, { result: event.target.value })} options={[{ value: '', label: '本次未检' }, { value: 'pass', label: '通过' }, { value: 'reject', label: '不通过' }]} /></Field>
            <Field label="实际检查件数"><TextInput aria-label={`尺码 ${check.size} · 实际检查件数`} type="number" min={0} value={check.inspected} disabled={!check.result} onChange={event => updateSize(index, { inspected: Number(event.target.value) })} /></Field>
            <Field label="尺码检查依据" full><TextInput aria-label={`尺码 ${check.size} · 检查依据`} value={check.evidence} disabled={!check.result} onChange={event => updateSize(index, { evidence: event.target.value })} /></Field>
          </FormGrid>)}</div></CardBody>
        </Card>}
        <Card>
          <CardHeader title="测量记录" sub="可选。标准、实测与容差只作记录。" tools={<Button size="sm" icon={Plus} onClick={() => setMeasurements(rows => [...rows, { point: '', standard: 0, actual: 0, tolerance: 0 }])}>增加测量点</Button>} />
          <CardBody>{measurements.length ? <div className="mist-col">{measurements.map((item, i) => <FormGrid key={i}>
            {(['point', 'standard', 'actual', 'tolerance'] as const).map((key, j) => <Field key={key} label={['测量点', '标准', '实测', '容差'][j]}><TextInput aria-label={`${['测量点', '标准', '实测', '容差'][j]} ${i + 1}`} type={key === 'point' ? 'text' : 'number'} step="0.0001" value={item[key]} onChange={e => setMeasurements(rows => rows.map((row, n) => n === i ? { ...row, [key]: key === 'point' ? e.target.value : Number(e.target.value) } : row))} /></Field>)}
            <Button size="sm" variant="quiet" onClick={() => setMeasurements(rows => rows.filter((_, n) => n !== i))}>移除本点</Button>
          </FormGrid>)}</div> : <span className="mist-note">还没有测量点</span>}</CardBody>
        </Card>
        <Card>
          <CardHeader title="现场照片与完整报告" sub="外部实验室报告也在这里上传，由QC判读后写入结论。" />
          <CardBody>
            <UploadZone hint="上传现场照片或完整报告" onFiles={files => { if (blocked) return; setBusy(true); void (async () => { try { for (const file of files) { const added = await uploadFile(file); setIds(old => [...old, added.id]); } } catch (e) { setFailure(String(e)); } finally { setBusy(false); } })(); }} />
            <RecordFiles ids={ids} />
          </CardBody>
          <div className="mist-sticky-foot"><span className="mist-note">实际检查人由当前登录账号记录</span><span className="mist-spacer" /><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={blocked} onClick={review}>提交报告</Button></div>
        </Card>
      </div>
      <div>
        <Card>
          <CardHeader title="本次检查" sub={`${task.factory} · ${task.location}`} />
          <CardBody><div className="mist-col">
            <Facts cols={2} items={[{ label: '任务', value: <Mono>{task.code}</Mono> }, { label: '预计检查日', value: task.due || '未排期' }, { label: '现场联系人', value: task.contact || '未记录' }, { label: '已有报告', value: `${previous.length} 份` }]} />
            <span className="mist-note">来源：{state ? fulfillmentSourceLabel(state, task.source) : ''}</span>
          </div></CardBody>
        </Card>
        <Card>
          <CardHeader title="填写要点" />
          <CardBody><div className="mist-col">
            <span className="mist-note">· 结论由你判断，系统不会根据偏差自动给结论。</span>
            {task.kind === 'production' && <span className="mist-note">· 任一尺码不通过时，总结论必须为不通过（NOK）。</span>}
            <span className="mist-note">· 复验请在本任务追加报告，历史报告保留不可改写。</span>
            <span className="mist-note">· 报告只解锁来源的下一步，业务推进由业务员完成。</span>
          </div></CardBody>
        </Card>
      </div>
    </div>
    <Dialog open={confirming} title="确认提交QC报告" tone={result === 'reject' ? 'bad' : 'accent'} onClose={() => { if (!busy) setConfirming(false); }}
      footer={<><Button disabled={busy} onClick={() => setConfirming(false)}>返回修改</Button><Button variant="primary" loading={busy} disabled={blocked} onClick={() => void save()}>确认提交</Button></>}>
      <div className="mist-col">
        <Facts cols={2} items={[{ label: '结论', value: result ? RESULT_LABEL[result] : '' }, { label: '报告编号', value: report }, { label: '检查时间', value: at.replace('T', ' ') }, { label: '本次检查尺码', value: sizeChecks.filter(check => check.result).map(check => `${check.size} ${check.inspected}件`).join(' · ') || '—' }]} />
        <span className="mist-note">{consequence}</span>
        <span className="mist-note">提交后报告不可改写，如需更正请追加复验报告。</span>
      </div>
    </Dialog>
  </MistPage>;
}
