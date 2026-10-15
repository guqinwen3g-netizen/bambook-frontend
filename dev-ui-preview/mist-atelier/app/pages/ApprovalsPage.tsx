/** 审批与放行（菜单外，从我的工作和顶栏进入）：待我审批 / 我发起的 / 已处理。
 *  只展示服务端派生的提交快照；批准、退回都写回原业务命令（采购、报价偏差、订单、付款申请、索赔方案），不另设审批引擎。 */
import React from 'react';
import { ArrowUpRight, Check, CornerUpLeft, Forward, Paperclip, RefreshCw } from 'lucide-react';
import { Banner, Button, Card, DataTable, EmptyState, Facts, Field, KeyValue, MistPage, ObjectCell, PageHeader, Pill, SearchField, Segmented, Tabs, TextArea, Toolbar, type Column, type Tone } from '../../../../components/mist';
import { getMistReviewTasks } from '../../../../server/src/shared/mistWorkspace';
import type { MistReviewTask } from '../../../../server/src/shared/mistReview';
import { platformBusinessDate } from '../../../../server/src/shared/mistPlatform';
import type { View } from '../../../../types';
import { useNav } from '../nav';
import { useMistSession } from '../runtime/auth';
import { useMistWorkspace } from '../runtime/workspace';
import { useMistReviews, type MistReview } from '../runtime/reviews';
import { ActionBar, DetailBlock, DetailBody, ListDetail } from './modules/pageKit';

export type ApprovalTab = 'mine' | 'sent' | 'done' | 'others';
type Kind = MistReviewTask['kind'];
type Row = MistReview & { local?: boolean };
export const APPROVAL_KIND_LABEL: Record<Kind, string> = { order: '订单审批', quotation: '报价偏差', procurement: '采购审批', payment: '付款申请', claim: '索赔方案' };
const STATUS: Record<MistReviewTask['status'], { tone: Tone; label: string }> = { pending: { tone: 'warn', label: '待审批' }, approved: { tone: 'ok', label: '已批准' }, rejected: { tone: 'bad', label: '已退回' } };
/** 统一审批尚未覆盖、仍在原业务页按原流程办理的类型（没有服务端放行规则时不在这里假装可审批）。 */
export const APPROVAL_NOT_CONNECTED = ['生产与出运放行', '受控例外'];
export const TRANSFER_UNAVAILABLE = '审批人由审批配置决定，暂不支持转交；需更换审批人请联系管理员调整审批配置';
const rowKey = (r: Pick<Row, 'workspaceId' | 'id'>) => r.workspaceId + '|' + r.id;
const day = (at: string) => { try { return platformBusinessDate(at); } catch { return at.slice(0, 10); } };

/** 按页签筛选：待我审批 = 我能决定的待审；我发起的 = 我提交的（含当前空间里仅本人可见的）；已处理 = 已批准 / 已退回；空间内其他 = 我是所有者但不由我审批的待审。 */
export function approvalRows(rows: Row[], tab: ApprovalTab, me: string) {
  if (tab === 'mine') return rows.filter(r => r.status === 'pending' && r.canDecide);
  if (tab === 'sent') return rows.filter(r => r.requesterId === me);
  if (tab === 'done') return rows.filter(r => r.status !== 'pending');
  return rows.filter(r => r.status === 'pending' && !r.canDecide && r.requesterId !== me);
}

export function ApprovalsPage() {
  const reviews = useMistReviews(), workspace = useMistWorkspace(), session = useMistSession(), { route, go } = useNav();
  const me = session.user?.id ?? '', state = workspace.state, current = workspace.workspace;
  const tab: ApprovalTab = (['mine', 'sent', 'done', 'others'] as const).find(t => t === route.section) ?? 'mine';
  const [kind, setKind] = React.useState<'all' | Kind>('all'), [query, setQuery] = React.useState(''), [drawer, setDrawer] = React.useState(false);
  const [note, setNote] = React.useState(''), [local, setLocal] = React.useState('');
  /** 服务端只返回我是所有者或审批人的空间；我在当前空间提交、但不是审批人的事项从当前空间状态补齐（只读）。 */
  const all = React.useMemo<Row[]>(() => {
    const server: Row[] = reviews.rows;
    if (!state || !current) return server;
    const seen = new Set(server.map(rowKey));
    const mine = getMistReviewTasks(state).filter(t => t.requesterId === me && !seen.has(current.id + '|' + t.id))
      .map(t => ({ ...t, workspaceId: current.id, workspaceName: current.name, revision: current.revision, canDecide: false, local: true }));
    return [...server, ...mine].sort((a, b) => (b.submittedAt || '').localeCompare(a.submittedAt || ''));
  }, [reviews.rows, state, current?.id, current?.revision, current?.name, me]);
  const counts = { mine: approvalRows(all, 'mine', me).length, sent: approvalRows(all, 'sent', me).length, done: approvalRows(all, 'done', me).length, others: approvalRows(all, 'others', me).length };
  const inTab = approvalRows(all, tab, me);
  const kinds = [...new Set(inTab.map(r => r.kind))];
  const q = query.trim().toLowerCase();
  const shown = inTab.filter(r => (kind === 'all' || r.kind === kind) && (!q || [r.title, r.workspaceName, APPROVAL_KIND_LABEL[r.kind], ...r.details.map(d => d.value)].some(v => v.toLowerCase().includes(q))));
  const selected = all.find(r => rowKey(r) === route.id) ?? null;
  React.useEffect(() => { setNote(''); setLocal(''); }, [route.id]);
  React.useEffect(() => { if (kind !== 'all' && !kinds.includes(kind)) setKind('all'); }, [tab, kinds.join(',')]);
  const open = (r: Row) => { setDrawer(true); go('approvals', rowKey(r), { section: tab }); };
  const requester = (r: Row) => r.requesterId === me ? '我' : state?.members?.find(m => m.userId === r.requesterId)?.name ?? (current && r.workspaceId === current.id && current.ownerId === r.requesterId ? '空间所有者' : '其他成员');
  const decide = async (decision: 'approved' | 'rejected') => {
    if (!selected) return;
    if (!note.trim()) { setLocal(decision === 'rejected' ? '退回必须写明理由，申请人会看到这条意见。' : '请填写批准依据，例如核对了哪些单据。'); return; }
    if (note.trim().length > 4000) { setLocal('审批意见不能超过 4000 字。'); return; }
    setLocal('');
    if (await reviews.decide(selected, decision, note)) setNote('');
  };
  const columns: Column<Row>[] = [
    { key: 'title', header: '事项', width: 'minmax(220px,2fr)', render: r => <ObjectCell name={r.title} meta={APPROVAL_KIND_LABEL[r.kind] + ' · ' + r.workspaceName} /> },
    { key: 'requester', header: '发起人', width: '110px', hideOnMobile: true, render: r => requester(r) },
    { key: 'at', header: '提交', width: '110px', hideOnMobile: true, render: r => <span className="mist-num">{day(r.submittedAt)}</span> },
    { key: 'status', header: '状态', width: '96px', render: r => <Pill tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Pill> },
  ];
  const targetBase = selected?.target.view.split('/')[0] ?? '';
  const sameSpace = !!selected && selected.workspaceId === current?.id;
  const openReason = !selected ? '' : !sameSpace ? `该审批属于工作空间“${selected.workspaceName}”，请先切换到该空间再打开原业务` : !session.canAccessView(targetBase as View) ? '当前账号没有原业务的查看权限' : undefined;
  const decideReason = !selected ? '' : selected.status !== 'pending' ? '这项审批已处理' : selected.local ? '你是发起人，不能审批本人提交的事项' : !selected.canDecide ? '你不在本次审批人名单中，或缺少该类审批权限' : reviews.intent ? '上一次审批结果待核对，请先核对原请求' : undefined;
  const detail = selected ? <DetailBody data-approval={selected.id} heading={<h2 className="mist-h2">{selected.title}</h2>}>
    <div className="mist-row" style={{ flexWrap: 'wrap' }}><Pill tone={STATUS[selected.status].tone}>{STATUS[selected.status].label}</Pill><Pill tone="neutral">{APPROVAL_KIND_LABEL[selected.kind]}</Pill><span className="mist-note">{selected.workspaceName}</span></div>
    <Facts items={[{ label: '发起人', value: requester(selected) }, { label: '提交时间', value: day(selected.submittedAt) }, { label: '审批人', value: selected.reviewerIds.includes(me) ? (selected.reviewerIds.length > 1 ? `我及另外 ${selected.reviewerIds.length - 1} 人（任一人决定）` : '我') : `${selected.reviewerIds.length} 人` }, { label: '所需权限', value: <span className="mist-mono">{selected.requiredPermission}</span> }]} />
    <DetailBlock title="提交时的快照">{selected.details.length ? <KeyValue items={selected.details} /> : <span className="mist-note">提交时没有附带快照字段。</span>}
      <span className="mist-note">以上是提交那一刻的内容；原业务之后若有修改，服务端会拒绝按旧版本作出的决定，需要刷新后重新核对。</span></DetailBlock>
    {!!selected.files?.length && <DetailBlock title="随附依据">{selected.files.map(f => <div className="mist-row" key={f.id}><Button size="sm" icon={Paperclip} onClick={() => void reviews.download(selected, f)}>{f.name}</Button></div>)}</DetailBlock>}
    {selected.status === 'pending' && !decideReason && <Field label="审批意见" required hint="批准写明核对依据；退回写明理由，申请人会看到。"><TextArea aria-label="审批意见" rows={3} maxLength={4000} value={note} disabled={reviews.busy} onChange={e => setNote(e.target.value)} /></Field>}
    {local && <Banner tone="bad" title="还不能保存决定">{local}</Banner>}
    <ActionBar busy={reviews.busy} actions={[
      { label: '批准', icon: Check, primary: true, onClick: () => void decide('approved'), reason: decideReason, hidden: selected.status !== 'pending' },
      { label: '退回', icon: CornerUpLeft, onClick: () => void decide('rejected'), reason: decideReason, hidden: selected.status !== 'pending' },
      { label: '转交', icon: Forward, onClick: () => undefined, reason: TRANSFER_UNAVAILABLE, hidden: selected.status !== 'pending' },
      { label: '打开原业务', icon: ArrowUpRight, onClick: () => go(selected.target.view, selected.target.id), reason: openReason },
    ]} />
  </DetailBody> : <EmptyState title="选择一项审批" description="左侧列表按当前账号的授权显示；选中后核对提交快照再决定。" />;
  return <MistPage>
    <PageHeader eyebrow="我的事务 · 审批与放行" title="审批与放行" description="订单、报价偏差、采购、付款申请与索赔方案的审批集中在这里；决定写回原业务，原业务页同步更新。" actions={<Button icon={RefreshCw} disabled={reviews.busy} onClick={() => void reviews.refresh()}>刷新</Button>} />
    {reviews.error && <Banner tone="bad" title={reviews.error} actions={<Button size="sm" onClick={reviews.clearError}>知道了</Button>} />}
    {reviews.intent && <Banner tone="warn" title="有审批结果待核对" actions={<Button size="sm" loading={reviews.busy} onClick={() => void reviews.recover()}>核对原请求</Button>}>上次保存审批决定时没有收到明确结果。核对会查询同一请求编号，不会重复决定。</Banner>}
    <Banner tone="neutral" title={APPROVAL_NOT_CONNECTED.join('、') + '尚未接入统一审批'}>这些事项还没有服务端放行规则，仍在原业务页按原流程办理，不在这里显示。</Banner>
    <Tabs<ApprovalTab> value={tab} onChange={next => { setDrawer(false); go('approvals', undefined, { section: next }); }} options={[
      { value: 'mine', label: '待我审批', count: counts.mine }, { value: 'sent', label: '我发起的', count: counts.sent }, { value: 'done', label: '已处理', count: counts.done },
      ...(counts.others ? [{ value: 'others' as const, label: '空间内其他待审', count: counts.others }] : []),
    ]} />
    <Toolbar right={kinds.length > 1 ? <Segmented<'all' | Kind> ariaLabel="审批类型" value={kind} onChange={setKind} options={[{ value: 'all', label: '全部' }, ...kinds.map(k => ({ value: k, label: APPROVAL_KIND_LABEL[k] }))]} /> : undefined}>
      <SearchField value={query} onChange={setQuery} placeholder="搜索单号、供应商、客户或空间" />
    </Toolbar>
    <ListDetail drawerOpen={drawer && !!selected} drawerTitle={selected?.title || '审批详情'} onDrawerClose={() => setDrawer(false)} detail={detail}
      list={<Card><DataTable ariaLabel="审批事项" rows={shown} columns={columns} loading={!reviews.loaded && !reviews.error} rowKey={rowKey} selectedKey={selected ? rowKey(selected) : undefined} onRowClick={open}
        empty={<EmptyState title={inTab.length ? '没有符合条件的审批' : tab === 'mine' ? '没有待你审批的事项' : tab === 'sent' ? '你还没有发起审批' : tab === 'done' ? '暂无已处理的审批' : '没有其他待审事项'} description="审批按当前账号与实际授权显示。" action={inTab.length ? <Button onClick={() => { setQuery(''); setKind('all'); }}>清除筛选</Button> : undefined} />} /></Card>} />
  </MistPage>;
}
