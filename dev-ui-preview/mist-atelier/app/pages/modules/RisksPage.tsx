/**
 * 风险管理与合规：预警只从真实记录推出、回到原记录处置；登记后单一负责人推进 接手 → 处置方案 → 审批申请 → 关闭回读。
 * 风险分级权限：持风险写权限者不限来源；业务员只处理本人负责的客户 / 订单上的风险（服务端同口径核验），可直接关闭提示 / 警告；
 * 严重风险的关闭、豁免、带风险放行与其他受控授权提交申请，由申请人所在部门主管在审批中心答复，结果回到本风险。
 */
import React from 'react';
import { AlertTriangle, ArrowUpRight, Check, Download, FileText, Gavel, Plus, ShieldAlert, Undo2, ShieldCheck, UserCheck, X } from 'lucide-react';
import { Banner, Button, Card, Checklist, DataTable, EmptyState, Facts, MistPage, ObjectCell, PageHeader, Pill, Segmented, SummaryBar, Timeline, type Column, type Tone } from '../../../../../components/mist';
import type { MistState } from '../../../../../server/src/shared/mistWorkspace';
import { platformBusinessDate } from '../../../../../server/src/shared/mistPlatform';
import { RISK_ACTIONS, RISK_ACTION_LABEL, RISK_STATE_LABEL, isHighRisk, isReviewedEscalation, pendingEscalation, riskBusinessOwner, riskEffectiveLevel, riskSignals, riskSource, riskType, type RiskEscalation, type RiskRecord, type RiskRequestAction, type RiskSignal, type RiskSourceKind, type RiskType } from '../../../../../server/src/shared/mistRisk';
import { useMistWorkspace } from '../../runtime/workspace';
import { useMistSession } from '../../runtime/auth';
import { useNav } from '../../nav';
import { ModuleEditorDialog, downloadModuleCsv, type ModuleEditorSpec } from './ModuleWorkbench';
import { useRouteDraft } from './useRouteDraft';
import { ActionBar, DetailBlock, DetailBody, ListDetail, shortWhen } from './pageKit';

type Tab = 'signals' | 'ledger';
type LedgerFilter = 'open' | 'escalated' | 'closed' | 'all';
type TypeFilter = 'all' | RiskType;
export const RISK_TYPE_LABEL: Record<RiskType, string> = { credit: '信用', fx: '汇率', compliance: '合规', quality: '质量', delivery: '交期', other: '其他' };
const LEVEL: Record<RiskRecord['level'], { label: string; tone: Tone }> = { critical: { label: '严重', tone: 'bad' }, warning: { label: '警告', tone: 'warn' }, info: { label: '提示', tone: 'neutral' } };
const STATE_TONE: Record<RiskRecord['state'], Tone> = { Open: 'warn', Acknowledged: 'accent', InProgress: 'accent', Escalated: 'warn', Resolved: 'ok' };
const SOURCE_LABEL: Record<RiskSourceKind, string> = { order: '订单', invoice: '发票', customer: '客户', supplier: '供应商', production: '生产分支', relation: '组织' };
const levelRank = { critical: 0, warning: 1, info: 2 } as const;
const DECISION_LABEL: Record<RiskEscalation['decision'], string> = { pending: '待审批', approved: '已批准', rejected: '已驳回', withdrawn: '已撤回' };
type Go = (view: string, id?: string, extra?: Record<string, string | undefined>) => void;

/** 原记录直达：风险模块不替原模块办理业务。 */
export function openRiskSource(go: Go, kind: RiskSourceKind, id: string) {
  if (kind === 'order') go('orders/detail', id);
  else if (kind === 'invoice') go('invoices', id);
  else if (kind === 'customer') go('crm', id, { customerId: id });
  else if (kind === 'supplier') go('suppliers', id);
  else if (kind === 'relation') go('relations', id);
  else go('production-board', undefined, { productionId: id });
}

export function RisksPage() {
  const { state, run, error, refresh, loading, saving, pending } = useMistWorkspace(), session = useMistSession(), { go, route } = useNav();
  const day = platformBusinessDate(new Date());
  const risks = state?.platform?.risks || [];
  const signals = React.useMemo(() => riskSignals(state, day), [state, day]);
  const openByKey = new Map(risks.filter(r => r.signalKey && r.state !== 'Resolved').map(r => [r.signalKey!, r]));
  const routeTab = (): Tab => route.section === 'ledger' || (route.section !== 'signals' && !!route.id && risks.some(r => r.id === route.id)) ? 'ledger' : 'signals';
  const [tab, setTab] = React.useState<Tab>(routeTab);
  const [picked, setPicked] = React.useState<string | null>(route.id || null), [drawer, setDrawer] = React.useState(!!route.id);
  React.useEffect(() => { setTab(routeTab()); }, [route.section, route.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [ledgerFilter, setLedgerFilter] = React.useState<LedgerFilter>(() => risks.find(r => r.id === route.id)?.state === 'Resolved' ? 'all' : 'open'), [typeFilter, setTypeFilter] = React.useState<TypeFilter>('all');
  const [dialog, setDialog] = useRouteDraft<ModuleEditorSpec | null>(null);
  React.useEffect(() => { if (route.id) setPicked(route.id); }, [route.id]);
  const canAll = session.hasPermission('risk:write'), canOrders = session.hasPermission('orders:write'), canCustomers = session.hasPermission('relations:write');
  const canDecide = session.hasPermission('risk:admin'), me = session.user?.displayName || '', meId = session.user?.id || '';
  const can = canAll || canOrders || canCustomers;
  const locked = saving || !!pending;
  /** 处理权（与服务端同口径的前端提示；以服务端核验为准）：风险写权限不限来源，否则须是来源负责人且持对应岗位写权限。 */
  const handleReason = (kind: RiskSourceKind, id: string): string | false => {
    if (canAll) return false;
    const b = riskBusinessOwner(state, kind, id);
    if (!b.domain) return '供应商来源的风险需要风险处理权限';
    if (!b.owner || b.owner !== me) return `只有来源负责人（${b.owner || '未指定'}）或持风险处理权限的同事可以处理`;
    if (b.domain === 'orders' && !canOrders) return '需要订单写权限';
    if (b.domain === 'customers' && !canCustomers) return '需要客户档案写权限';
    return false;
  };
  const riskReason = (r: RiskRecord) => { const src = riskSource(state, r); return src ? handleReason(src.kind, src.id) : '来源未记录，需要风险处理权限'; };
  const ownOrders = (state?.orders || []).filter(o => canAll || (canOrders && o.owner === me));
  const switchTab = (t: Tab) => { setTab(t); setPicked(null); setDrawer(false); go('risks', undefined, { section: t }); };
  const openRisk = (id: string) => { setTab('ledger'); if (risks.find(r => r.id === id)?.state === 'Resolved') setLedgerFilter('all'); setPicked(id); setDrawer(true); go('risks', id, { section: 'ledger' }); };
  const pick = (id: string) => { setPicked(id); setDrawer(true); go('risks', id, { section: tab }); };

  const unregistered = signals.filter(s => !openByKey.has(s.key));
  const open = risks.filter(r => r.state !== 'Resolved'), escalated = risks.filter(r => pendingEscalation(r));
  const monthClosed = risks.filter(r => r.state === 'Resolved' && (r.closedAt || '').slice(0, 7) === day.slice(0, 7));
  const signalRows = signals.filter(s => typeFilter === 'all' || s.type === typeFilter);
  const ledgerRows = risks.filter(r => (typeFilter === 'all' || riskType(r) === typeFilter) && (ledgerFilter === 'all' || (ledgerFilter === 'open' ? r.state !== 'Resolved' : ledgerFilter === 'closed' ? r.state === 'Resolved' : !!pendingEscalation(r))))
    .sort((a, b) => Number(a.state === 'Resolved') - Number(b.state === 'Resolved') || Number(!pendingEscalation(a)) - Number(!pendingEscalation(b)) || levelRank[a.level] - levelRank[b.level] || (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
  const typeCounts = (list: Array<{ type: RiskType }>) => (['credit', 'compliance', 'quality', 'delivery'] as RiskType[]).map(t => ({ value: t, label: `${RISK_TYPE_LABEL[t]} ${list.filter(x => x.type === t).length}` }));

  const registerSpec = (s?: RiskSignal): ModuleEditorSpec => ({
    title: s ? '登记风险' : '手工登记风险', submitLabel: '登记',
    description: s ? `来源：${SOURCE_LABEL[s.source.kind]} ${s.source.label}。登记后由负责人接手推进；预警本身不会冻结付款、删单或修改原记录。` : '只能挂在真实订单上；其他来源请从“预警”页登记，保留准确来源。',
    initialValues: s ? { title: s.title, level: s.level, owner: me, basis: s.basis } : { orderId: ownOrders[0]?.id || '', type: 'delivery', title: '', level: 'warning', owner: me, basis: '' },
    fields: [...(s ? [] : [{ key: 'orderId', label: '来源订单', type: 'select' as const, required: true, hint: canAll ? undefined : '只能选择你负责的订单', options: ownOrders.map(o => ({ value: o.id, label: `${o.code} · ${o.customer}` })) }, { key: 'type', label: '风险类型', type: 'select' as const, options: (Object.keys(RISK_TYPE_LABEL) as RiskType[]).map(t => ({ value: t, label: RISK_TYPE_LABEL[t] })) }]),
      { key: 'title', label: '风险标题', required: true }, { key: 'level', label: '风险等级', type: 'select', hint: s ? '不能低于预警等级；严重为高风险，关闭须经部门主管审批' : '严重为高风险，关闭须经部门主管审批', options: (['critical', 'warning', 'info'] as const).filter(l => !s || levelRank[l] <= levelRank[s.level]).map(l => ({ value: l, label: LEVEL[l].label })) },
      { key: 'owner', label: '负责人', required: true, readonly: !canAll, hint: canAll ? '单一主负责人，统筹各岗位处理' : '登记本人客户或订单的风险，负责人为本人；需转交请联系主管' }, { key: 'basis', label: '事实与依据', type: 'textarea', required: true }],
    submit: async v => {
      const base = { title: String(v.title ?? ''), level: String(v.level) as RiskRecord['level'], owner: canAll ? String(v.owner ?? '') : me, basis: String(v.basis ?? '') };
      const r = await run(s ? { type: 'platform.risk.save', payload: { ...base, type: s.type, source: { kind: s.source.kind, id: s.source.id }, signalKey: s.key } } : { type: 'platform.risk.save', payload: { ...base, type: String(v.type) as RiskType, source: { kind: 'order', id: String(v.orderId ?? '') } } });
      const id = (r as { result?: { id?: string } } | undefined)?.result?.id; if (id) openRisk(id);
    },
  });
  const ackSpec = (r: RiskRecord): ModuleEditorSpec => ({ title: `接手 ${r.title}`, submitLabel: '确认接手', description: r.owner === me ? '确认由你负责推进。' : `负责人将由 ${r.owner} 变更为你（${me}），变更写入记录。`, initialValues: { note: '' }, fields: [{ key: 'note', label: '接手说明', type: 'textarea' }], submit: v => run({ type: 'platform.risk.transition', payload: { id: r.id, state: 'Acknowledged', resolution: String(v.note ?? '') } }) });
  const planSpec = (r: RiskRecord): ModuleEditorSpec => ({ title: r.plan ? '更新处置方案' : '制定处置方案', submitLabel: '保存', description: '写明谁、做什么、何时完成；需要其他岗位办理的，请到对应原记录发起，风险模块不替代原业务操作。', initialValues: { plan: r.plan || '', planDue: r.planDue || '' }, fields: [{ key: 'plan', label: '处置方案', type: 'textarea', required: true }, { key: 'planDue', label: '计划完成日', type: 'date' }], submit: v => run({ type: 'platform.risk.plan', payload: { id: r.id, plan: String(v.plan ?? ''), planDue: String(v.planDue ?? '') } }) });
  const escalateSpec = (r: RiskRecord, action: RiskRequestAction = 'waive'): ModuleEditorSpec => ({
    title: action === 'close' ? `申请关闭 ${r.title}` : '申请审批', submitLabel: '提交审批',
    description: '由你所在部门的主管在审批中心答复（审批人由系统确定，不能自选），结果回到本风险。批准关闭 / 豁免后风险关闭；批准带风险放行后风险仍保持处理中继续跟进；驳回则继续按原规则处理。风险模块不会替原记录解冻或放行，实际操作仍在原记录完成。',
    initialValues: { action, reason: '' },
    fields: [{ key: 'action', label: '申请事项', type: 'select', required: true, options: RISK_ACTIONS.map(a => ({ value: a, label: RISK_ACTION_LABEL[a] })) }, { key: 'reason', label: '依据与申请范围', type: 'textarea', required: true, hint: '关闭写明问题如何解决；豁免写明为何可以不处理；放行写明放行范围与条件' }],
    submit: v => run({ type: 'platform.risk.escalate', payload: { id: r.id, action: String(v.action) as RiskRequestAction, reason: String(v.reason ?? '') } }),
  });
  const withdrawSpec = (r: RiskRecord): ModuleEditorSpec => { const e = pendingEscalation(r)!; return { title: '撤回申请', submitLabel: '撤回', description: `撤回「${RISK_ACTION_LABEL[e.action || 'authorize']}」申请后，审批中心不再显示这条申请，风险回到处理中。`, initialValues: { reason: '' }, fields: [{ key: 'reason', label: '撤回原因', type: 'textarea' }], submit: v => run({ type: 'platform.risk.withdraw', payload: { id: r.id, escalationId: e.id, reason: String(v.reason ?? '') } }) }; };
  const decideSpec = (r: RiskRecord, decision: 'approved' | 'rejected'): ModuleEditorSpec => { const e = pendingEscalation(r)!; return { title: decision === 'approved' ? '批准升级（受控授权）' : '驳回升级（继续阻断）', submitLabel: decision === 'approved' ? '批准' : '驳回', description: `${e.requestedBy} 申请：${e.reason}`, initialValues: { note: '' }, fields: [{ key: 'note', label: '审批意见', type: 'textarea', required: true }], submit: v => run({ type: 'platform.risk.decide', payload: { id: r.id, escalationId: e.id, decision, note: String(v.note ?? '') } }) }; };
  const closeSpec = (r: RiskRecord): ModuleEditorSpec => ({ title: `关闭 ${r.title}`, submitLabel: '确认关闭', description: '写明业务问题如何解决、依据是什么。忽略提醒不等于问题已解决；关闭后只读，可回看。', initialValues: { resolution: '' }, fields: [{ key: 'resolution', label: '关闭依据', type: 'textarea', required: true }], submit: v => run({ type: 'platform.risk.transition', payload: { id: r.id, state: 'Resolved', resolution: String(v.resolution ?? '') } }) });

  const signalCols: Column<RiskSignal>[] = [
    { key: 'title', header: '预警', width: 'minmax(220px,1.6fr)', render: s => <ObjectCell name={s.title} meta={`${SOURCE_LABEL[s.source.kind]} · ${s.source.label}`} /> },
    { key: 'type', header: '类型', width: '64px', render: s => <Pill>{RISK_TYPE_LABEL[s.type]}</Pill> },
    { key: 'level', header: '等级', width: '64px', render: s => <Pill tone={LEVEL[s.level].tone}>{LEVEL[s.level].label}</Pill> },
    { key: 'risk', header: '处理', width: 'minmax(96px,0.7fr)', hideOnMobile: true, render: s => { const r = openByKey.get(s.key); return r ? <span className="mist-col" style={{ gap: 2 }}><span>{r.owner}</span><small className="mist-muted">{RISK_STATE_LABEL[r.state]}</small></span> : <span className="mist-tone-warn">未登记</span>; } },
  ];
  const ledgerCols: Column<RiskRecord>[] = [
    { key: 'title', header: '风险', width: 'minmax(220px,1.6fr)', render: r => { const src = riskSource(state, r); return <ObjectCell name={r.title} meta={src ? `${SOURCE_LABEL[src.kind]} · ${src.label}` : '来源未记录'} />; } },
    { key: 'type', header: '类型', width: '64px', render: r => <Pill>{RISK_TYPE_LABEL[riskType(r)]}</Pill> },
    { key: 'owner', header: '负责人', width: '84px', hideOnMobile: true, render: r => r.owner },
    { key: 'state', header: '状态', width: 'minmax(96px,0.7fr)', render: r => { const late = r.state !== 'Resolved' && r.planDue && r.planDue < day, lv = riskEffectiveLevel(state, r, day); return <span className="mist-col" style={{ gap: 2 }}><span><Pill tone={STATE_TONE[r.state]}>{r.disposition === 'waived' ? '已豁免' : RISK_STATE_LABEL[r.state]}</Pill> <Pill tone={LEVEL[lv].tone}>{LEVEL[lv].label}</Pill></span>{late && <small className="mist-tone-warn">方案逾期 · {r.planDue}</small>}</span>; } },
  ];

  const selSignal = tab === 'signals' ? signals.find(s => s.key === picked) : undefined, selRisk = tab === 'ledger' ? risks.find(r => r.id === picked) : undefined;
  const detail = selSignal ? <SignalDetail s={selSignal} risk={openByKey.get(selSignal.key)} registerReason={handleReason(selSignal.source.kind, selSignal.source.id)} locked={locked} onRegister={() => setDialog(registerSpec(selSignal))} onOpenRisk={openRisk} onSource={() => openRiskSource(go, selSignal.source.kind, selSignal.source.id)} />
    : selRisk ? <RiskDetail r={selRisk} state={state} day={day} me={me} meId={meId} canDecide={canDecide} locked={locked} writeReason={riskReason(selRisk)}
      onAck={() => setDialog(ackSpec(selRisk))} onPlan={() => setDialog(planSpec(selRisk))} onEscalate={a => setDialog(escalateSpec(selRisk, a))} onWithdraw={() => setDialog(withdrawSpec(selRisk))} onDecide={d => setDialog(decideSpec(selRisk, d))} onClose={() => setDialog(closeSpec(selRisk))} onSource={(k, id) => openRiskSource(go, k, id)} onApprovals={() => go('approvals')} /> : null;
  const placeholder = <EmptyState icon={tab === 'signals' ? ShieldAlert : ShieldCheck} title={tab === 'signals' ? '预警详情' : '风险详情'} description={tab === 'signals' ? '选择一条预警，查看依据与原记录；需要统筹处理时登记为风险。' : '选择一条风险，查看处置进度、升级审批与关闭依据。'} />;
  const exportRows = () => tab === 'signals'
    ? downloadModuleCsv('风险预警.csv', ['预警', '类型', '等级', '来源', '依据', '登记状态'], signalRows.map(s => [s.title, RISK_TYPE_LABEL[s.type], LEVEL[s.level].label, `${SOURCE_LABEL[s.source.kind]} ${s.source.label}`, s.basis, openByKey.get(s.key) ? RISK_STATE_LABEL[openByKey.get(s.key)!.state] : '未登记']))
    : downloadModuleCsv('风险台账.csv', ['风险', '类型', '等级', '来源', '负责人', '状态', '依据', '处置方案', '计划完成日', '审批申请', '关闭依据', '登记时间', '关闭时间'], ledgerRows.map(r => { const src = riskSource(state, r); return [r.title, RISK_TYPE_LABEL[riskType(r)], LEVEL[r.level].label, src ? `${SOURCE_LABEL[src.kind]} ${src.label}` : '', r.owner, RISK_STATE_LABEL[r.state], r.basis, r.plan || '', r.planDue || '', (r.escalations || []).map(e => `${RISK_ACTION_LABEL[e.action || 'authorize']}:${e.decidedBy || e.approver}:${DECISION_LABEL[e.decision]}`).join('; '), r.resolution, r.createdAt, r.closedAt || '']; }));

  return <MistPage>
    <PageHeader eyebrow="财务与成本 · 风险" title="风险管理与合规" description="预警来自逾期应收、往来冻结、供应商认证与状态、QC 与生产交期；登记后由一位负责人推进到关闭。"
      actions={<><Button icon={Download} onClick={exportRows}>导出</Button>{(canAll || canOrders) && <Button variant="primary" icon={Plus} disabled={locked || !ownOrders.length} title={ownOrders.length ? undefined : canAll ? '还没有订单' : '你还没有负责的订单'} onClick={() => setDialog(registerSpec())}>手工登记</Button>}</>} />
    {!can && <div className="mist-section"><Banner tone="neutral" title="只读查看">你的账号没有风险处理权限，可查看预警与台账，不能登记或推进。</Banner></div>}
    {can && !canAll && <div className="mist-section"><Banner tone="neutral" title="按负责人处理">你可以登记和推进本人负责的客户 / 订单上的风险，并直接关闭提示、警告级风险；严重风险的关闭、豁免与带风险放行需提交部门主管审批。</Banner></div>}
    {error && <div className="mist-section"><Banner tone="bad" title="数据未加载" actions={<Button onClick={() => void refresh()}>重试</Button>}>{error}</Banner></div>}
    <div className="mist-section" data-risk-summary><SummaryBar items={[
      { label: '未登记预警', value: unregistered.length, hint: unregistered.filter(s => s.level === 'critical').length ? `其中严重 ${unregistered.filter(s => s.level === 'critical').length}` : undefined, hintTone: 'bad' },
      { label: '未关闭风险', value: open.length, hint: open.filter(r => r.planDue && r.planDue < day).length ? `方案逾期 ${open.filter(r => r.planDue && r.planDue < day).length}` : undefined, hintTone: 'warn' },
      { label: '待审批申请', value: escalated.length, hint: escalated.some(r => { const e = pendingEscalation(r)!; return isReviewedEscalation(e) ? e.reviewerIds!.includes(meId) : canDecide && e.requestedBy !== me; }) ? '需要你答复' : undefined, hintTone: 'warn' },
      { label: '本月关闭', value: monthClosed.length },
    ]} /></div>
    <div className="mist-section mist-row" style={{ flexWrap: 'wrap', gap: 12 }}>
      <Segmented<Tab> ariaLabel="内容" value={tab} onChange={switchTab} options={[{ value: 'signals', label: `预警 · ${signals.length}` }, { value: 'ledger', label: `风险台账 · ${risks.length}` }]} />
      <Segmented<TypeFilter> ariaLabel="风险类型" value={typeFilter} onChange={setTypeFilter} options={[{ value: 'all', label: '全部类型' }, ...typeCounts(tab === 'signals' ? signals : risks.map(r => ({ type: riskType(r) })))]} />
      {tab === 'ledger' && <Segmented<LedgerFilter> ariaLabel="状态" value={ledgerFilter} onChange={setLedgerFilter} options={[{ value: 'open', label: `未关闭 ${open.length}` }, { value: 'escalated', label: `待审批 ${escalated.length}` }, { value: 'closed', label: `已关闭 ${risks.length - open.length}` }, { value: 'all', label: '全部' }]} />}
    </div>
    {tab === 'signals' && <p className="mist-note mist-section">汇率风险尚未接入汇率数据源：外币应收与采购按原币显示，不做换算或敞口估算。</p>}
    <ListDetail drawerOpen={drawer && !!detail} onDrawerClose={() => setDrawer(false)} drawerTitle={selSignal?.title || selRisk?.title || ''}
      list={<Card>{tab === 'signals'
        ? <DataTable ariaLabel="风险预警" loading={loading} rows={signalRows} rowKey={s => s.key} selectedKey={selSignal?.key} density="comfy" onRowClick={s => pick(s.key)} columns={signalCols} empty={<EmptyState icon={ShieldCheck} title="当前没有预警" description="逾期应收、往来冻结、认证到期、供应商暂停、QC 不通过与生产逾期会自动出现在这里。" />} />
        : <DataTable ariaLabel="风险台账" loading={loading} rows={ledgerRows} rowKey={r => r.id} selectedKey={selRisk?.id} density="comfy" onRowClick={r => pick(r.id)} columns={ledgerCols} empty={<EmptyState icon={ShieldCheck} title={risks.length ? '没有符合筛选的风险' : '还没有登记风险'} description={risks.length ? '换一个状态或类型筛选。' : '从预警登记，或手工登记订单风险。'} />} />}</Card>}
      detail={detail || placeholder} />
    <ModuleEditorDialog spec={dialog} onClose={() => setDialog(null)} />
  </MistPage>;
}

function SignalDetail({ s, risk, registerReason, locked, onRegister, onOpenRisk, onSource }: { s: RiskSignal; risk?: RiskRecord; registerReason: string | false; locked: boolean; onRegister: () => void; onOpenRisk: (id: string) => void; onSource: () => void }) {
  return <DetailBody data-signal-detail={s.key} heading={<div><span className="mist-muted">{RISK_TYPE_LABEL[s.type]}预警 · {SOURCE_LABEL[s.source.kind]}</span><div className="mist-h2" style={{ fontSize: 19, marginTop: 4 }}>{s.title}</div></div>}>
    <div className="mist-row" style={{ flexWrap: 'wrap' }}><Pill tone={LEVEL[s.level].tone}>{LEVEL[s.level].label}</Pill><Pill>{RISK_TYPE_LABEL[s.type]}</Pill>{risk ? <Pill tone={STATE_TONE[risk.state]}>已登记 · {RISK_STATE_LABEL[risk.state]}</Pill> : <Pill tone="warn">未登记</Pill>}</div>
    <DetailBlock title="依据"><p className="mist-sub">{s.basis}</p></DetailBlock>
    <Facts items={[{ label: '来源', value: `${SOURCE_LABEL[s.source.kind]} · ${s.source.label}` }, { label: '起始', value: s.since }]} />
    <ActionBar busy={locked} actions={[
      { label: '打开原记录', icon: ArrowUpRight, onClick: onSource, primary: !!risk },
      risk ? { label: `查看风险（${risk.owner}）`, icon: FileText, onClick: () => onOpenRisk(risk.id) } : { label: '登记风险', icon: Plus, onClick: onRegister, primary: true, reason: registerReason },
    ]} />
    <p className="mist-note">预警只读：来源记录改变后自动消失或更新。它不冻结付款、不删单、不改 QC / 账务 / 审批；实际处理在原记录完成。</p>
  </DetailBody>;
}

function RiskDetail({ r, state, day, me, meId, canDecide, locked, writeReason, onAck, onPlan, onEscalate, onWithdraw, onDecide, onClose, onSource, onApprovals }: { r: RiskRecord; state: MistState | null; day: string; me: string; meId: string; canDecide: boolean; locked: boolean; writeReason: string | false; onAck: () => void; onPlan: () => void; onEscalate: (action?: RiskRequestAction) => void; onWithdraw: () => void; onDecide: (d: 'approved' | 'rejected') => void; onClose: () => void; onSource: (k: RiskSourceKind, id: string) => void; onApprovals: () => void }) {
  const src = riskSource(state, r), esc = pendingEscalation(r), done = r.state === 'Resolved';
  const level = riskEffectiveLevel(state, r, day), high = isHighRisk(level), raised = level !== r.level;
  const decided = (r.escalations || []).filter(e => e.decision !== 'pending');
  const events = (state?.events || []).filter(e => e.entityId === r.id);
  const reviewed = !!esc && isReviewedEscalation(esc), mine = !!esc && (esc.requesterId ? esc.requesterId === meId : esc.requestedBy === me);
  const decideReason = !canDecide ? '需要风险审批权限（负责人）' : esc && esc.requestedBy === me ? '申请人不能审批自己的升级' : false;
  const decisionText = (e: RiskEscalation) => e.decision === 'withdrawn' ? `${e.decidedBy}撤回` : `${e.decidedBy}${e.decision === 'approved' ? '批准' : '驳回'}`;
  const steps = [
    { label: '登记', done: true, note: `${r.createdBy || '—'} · ${shortWhen(r.createdAt)}` },
    { label: '接手', done: r.state !== 'Open', note: r.acknowledgedAt ? `${r.owner} · ${shortWhen(r.acknowledgedAt)}` : '等待负责人接手' },
    { label: '制定方案', done: !!r.plan, note: r.plan ? (r.planDue ? `计划 ${r.planDue}${!done && r.planDue < day ? '（已逾期）' : ''}` : '未设计划完成日') : '未制定', noteTone: !done && r.planDue && r.planDue < day ? 'bad' as const : undefined },
    ...(r.escalations?.length ? [{ label: '审批申请', done: !esc, note: esc ? `${RISK_ACTION_LABEL[esc.action || 'authorize']} · 待 ${esc.approver} 答复` : decided.map(decisionText).join('、') }] : []),
    { label: '关闭', done, note: done ? `${r.closedBy || '—'} · ${shortWhen(r.closedAt || '')}${r.disposition === 'waived' ? ' · 豁免' : r.disposition === 'closed' ? ' · 经审批关闭' : ''}` : high ? '严重风险关闭须经部门主管审批' : '未关闭' },
  ];
  const stepReason = writeReason || (r.state !== 'InProgress' ? '先制定处置方案' : false);
  return <DetailBody data-risk-detail={r.id} heading={<div><span className="mist-muted">{RISK_TYPE_LABEL[riskType(r)]} · {src ? `${SOURCE_LABEL[src.kind]} ${src.label}` : '来源未记录'}</span><div className="mist-h2" style={{ fontSize: 19, marginTop: 4 }}>{r.title}</div></div>}>
    <div className="mist-row" style={{ flexWrap: 'wrap' }}><Pill tone={STATE_TONE[r.state]}>{r.disposition === 'waived' ? '已豁免' : RISK_STATE_LABEL[r.state]}</Pill><Pill tone={LEVEL[level].tone}>{LEVEL[level].label}{high && !done ? ' · 高风险' : ''}</Pill><Pill>负责人 {r.owner}</Pill>{r.release && !done && <Pill tone="warn">已获准带风险放行</Pill>}</div>
    {raised && !done && <p className="mist-note">登记时为{LEVEL[r.level].label}，来源预警当前已升为{LEVEL[level].label}，按当前等级处理。</p>}
    {esc && (reviewed ? <div className="mist-col" data-risk-escalation>
      <Banner tone="warn" title={`待部门主管审批 · ${RISK_ACTION_LABEL[esc.action || 'authorize']}`}>{esc.requestedBy} · {shortWhen(esc.requestedAt)}：{esc.reason}</Banner>
      <ActionBar busy={locked} actions={[{ label: '到审批中心', icon: ArrowUpRight, onClick: onApprovals }, { label: '撤回申请', icon: Undo2, onClick: onWithdraw, hidden: !mine }]} />
    </div> : <div className="mist-col" data-risk-escalation>
      <Banner tone="warn" title={`待 ${esc.approver} 审批升级`}>{esc.requestedBy} · {shortWhen(esc.requestedAt)}：{esc.reason}</Banner>
      <ActionBar busy={locked} actions={[{ label: '批准', icon: Check, onClick: () => onDecide('approved'), reason: decideReason }, { label: '驳回', icon: X, onClick: () => onDecide('rejected'), reason: decideReason }]} />
    </div>)}
    {!done && <ActionBar busy={locked} actions={[
      { label: '接手', icon: UserCheck, onClick: onAck, primary: true, hidden: r.state !== 'Open', reason: writeReason },
      { label: r.plan ? '更新处置方案' : '制定处置方案', icon: FileText, onClick: onPlan, primary: r.state === 'Acknowledged', hidden: r.state === 'Open' || !!esc, reason: writeReason },
      { label: '申请审批', icon: Gavel, onClick: () => onEscalate(high ? 'waive' : 'release'), hidden: r.state === 'Open' || !!esc, reason: stepReason },
      high
        ? { label: '申请关闭', icon: ShieldCheck, onClick: () => onEscalate('close'), primary: r.state === 'InProgress' && !esc, hidden: r.state === 'Open' || !!esc, reason: stepReason }
        : { label: '关闭风险', icon: ShieldCheck, onClick: onClose, primary: r.state === 'InProgress' && !esc, hidden: r.state === 'Open', reason: writeReason || (esc ? '审批申请尚未答复' : false) },
    ]} />}
    <DetailBlock title="进度"><Checklist items={steps.map(s => ({ label: s.label, done: s.done, note: s.note, noteTone: s.noteTone }))} /></DetailBlock>
    <DetailBlock title="事实与依据" aside={src && <Button variant="quiet" icon={ArrowUpRight} onClick={() => onSource(src.kind, src.id)}>打开原记录</Button>}><p className="mist-sub" style={{ whiteSpace: 'pre-line' }}>{r.basis}</p></DetailBlock>
    {r.plan && <DetailBlock title="处置方案"><p className="mist-sub" style={{ whiteSpace: 'pre-line' }}>{r.plan}</p></DetailBlock>}
    {r.release && <DetailBlock title="带风险放行"><p className="mist-sub">{r.release.approvedBy} · {shortWhen(r.release.at)} 批准：{r.release.note}</p><p className="mist-note">放行只记在本风险上，原记录的冻结、出运等仍在原模块办理；风险继续跟进到关闭。</p></DetailBlock>}
    {decided.length > 0 && <DetailBlock title="审批记录"><div className="mist-col" style={{ gap: 0 }}>{decided.map(e => <div key={e.id} className="mist-col mist-quote-line" style={{ gap: 4, padding: '8px 0' }}>
      <div className="mist-row" style={{ gap: 8 }}><Pill tone={e.decision === 'approved' ? 'ok' : 'neutral'}>{isReviewedEscalation(e) ? DECISION_LABEL[e.decision] : e.decision === 'approved' ? '已授权' : DECISION_LABEL[e.decision]}</Pill>{e.action && <Pill>{RISK_ACTION_LABEL[e.action]}</Pill>}<span className="mist-muted">{e.requestedBy} → {e.decidedBy} · {shortWhen(e.decidedAt)}</span></div>
      <small className="mist-muted">申请：{e.reason}</small>{e.decisionNote && <small>{e.decision === 'withdrawn' ? '撤回原因' : '意见'}：{e.decisionNote}</small>}</div>)}</div></DetailBlock>}
    {done && <DetailBlock title={r.disposition === 'waived' ? '豁免依据' : '关闭依据'}><p className="mist-sub" style={{ whiteSpace: 'pre-line' }}>{r.resolution}</p></DetailBlock>}
    <DetailBlock title="操作记录">{events.length ? <Timeline events={events.map(e => ({ who: e.actor, when: new Date(e.at).toLocaleString('zh-CN'), text: e.text }))} /> : <span className="mist-muted">暂无记录。</span>}</DetailBlock>
    {!r.type && <span className="mist-note"><AlertTriangle size={12} /> 早期登记的风险，未记录类型与来源类别，按订单来源显示。</span>}
  </DetailBody>;
}
