/** 客户档案补充：跟进记录、商机与邮件（只读汇总）。全部来自工作空间状态，命令写入服务端。 */
import React from 'react';
import { ArrowRight, CalendarClock, FilePlus2, Flag, Mail, MessageSquarePlus, Pencil, Plus, Receipt, Target, XCircle } from 'lucide-react';
import { Banner, Button, Card, CardHeader, DataTable, Drawer, EmptyState, Facts, Pill, StageProgress, SummaryBar, Timeline, type Tone } from '../../../../components/mist';
import type { MistCustomer, MistState } from '../../../../server/src/shared/mistWorkspace';
import { CRM_LINK_LABEL, CRM_METHOD_LABEL, CRM_STAGE_LABEL, crmLinkTarget, type CrmFollowUp, type CrmLink, type CrmOpportunity, type CrmStage } from '../../../../server/src/shared/mistCrm';
import { ModuleEditorDialog, type ModuleEditorSpec } from './modules/ModuleWorkbench';
import { emptyOption, field, localNow, text } from './modules/fulfillmentKit';
import { useMistWorkspace } from '../runtime/workspace';
import { useOptionalMistSession } from '../runtime/auth';
import { defaultMemberId, memberSelectOptions, workspaceMembers } from '../runtime/members';
import { useNav } from '../nav';
import { fmt } from '../data';

const STAGE_TONE: Record<CrmStage, Tone> = { intent: 'neutral', sampling: 'accent', quoting: 'ai', won: 'ok', lost: 'bad' };
const OPEN: CrmStage[] = ['intent', 'sampling', 'quoting'];
const when = (at: string) => { const d = new Date(at); return Number.isFinite(d.getTime()) ? d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'; };
const linkValue = (link: CrmLink | null) => link ? `${link.kind}:${link.id}` : '';
const parseLink = (value: string): CrmLink | null => { const [kind, ...rest] = value.split(':'); return kind && rest.length ? { kind: kind as CrmLink['kind'], id: rest.join(':') } : null; };

/** 未结束商机按币种分别合计，绝不跨币种相加。 */
export function openOpportunityTotals(rows: CrmOpportunity[]) {
  const totals = new Map<string, { cents: bigint; count: number }>();
  for (const row of rows) if (OPEN.includes(row.stage)) {
    const [whole, frac = ''] = row.amount.split('.'), cents = BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
    const prev = totals.get(row.currency) || { cents: 0n, count: 0 }; totals.set(row.currency, { cents: prev.cents + cents, count: prev.count + 1 });
  }
  return [...totals.entries()].map(([currency, value]) => ({ currency, amount: Number(value.cents) / 100, count: value.count }));
}

function linkOptions(state: MistState, customerId: string, withOpportunity = true) {
  return [
    ...(withOpportunity ? state.crm.opportunities.filter(row => row.customerId === customerId).map(row => ({ value: `opportunity:${row.id}`, label: `商机 · ${row.title}` })) : []),
    ...state.devs.filter(row => row.customerId === customerId).map(row => ({ value: `development:${row.id}`, label: `开发案 · ${row.code} ${row.name}` })),
    ...state.market.quotations.filter(row => row.customerId === customerId).map(row => ({ value: `quotation:${row.id}`, label: `报价 · ${row.code}` })),
    ...state.orders.filter(row => row.customerId === customerId).map(row => ({ value: `order:${row.id}`, label: `订单 · ${row.code}` })),
  ];
}

export function FollowUpPanel({ customer, state, can, compact }: { customer: MistCustomer; state: MistState; can: boolean; compact?: boolean }) {
  const { run } = useMistWorkspace(), { go } = useNav();
  const [dialog, setDialog] = React.useState<ModuleEditorSpec | null>(null);
  const rows = state.crm.followUps.filter(row => row.customerId === customer.id);
  const nextOpen = rows.map(row => state.tasks.find(task => task.id === row.nextTaskId)).filter(task => task && !task.done).sort((a, b) => a!.due.localeCompare(b!.due))[0];
  const spec = (): ModuleEditorSpec => ({ title: '记录跟进', submitLabel: '保存跟进', description: `${customer.name} · 记录实际发生的沟通；填写下次跟进日会生成待办。`,
    fields: [field('method', '方式', 'select', true, Object.entries(CRM_METHOD_LABEL).map(([value, label]) => ({ value, label }))), field('at', '实际时间', 'datetime-local'), field('content', '跟进内容', 'textarea'), { ...field('nextDate', '下次跟进日', 'date', false), hint: '留空表示暂不安排' }, field('link', '关联对象', 'select', false, [{ value: '', label: '不关联' }, ...linkOptions(state, customer.id)])],
    initialValues: { method: 'call', at: localNow(), content: '', nextDate: '', link: '' },
    submit: v => run({ type: 'crm.followUp.save', payload: { customerId: customer.id, method: text(v, 'method') as CrmFollowUp['method'], content: text(v, 'content'), at: new Date(text(v, 'at')).toISOString(), nextDate: text(v, 'nextDate'), link: parseLink(text(v, 'link')) } }) });
  const shown = compact ? rows.slice(0, 4) : rows;
  const target = (row: CrmFollowUp) => row.link ? crmLinkTarget(state, customer.id, row.link) : null;
  return <Card>
    <CardHeader title="跟进记录" sub={nextOpen ? `下次跟进 ${nextOpen.due}` : rows.length ? '没有待跟进安排' : undefined} tools={can ? <Button size="sm" icon={MessageSquarePlus} onClick={() => setDialog(spec())}>记录跟进</Button> : undefined} />
    {shown.length ? <Timeline events={shown.map(row => { const t = target(row); return { who: `${row.actor} · ${CRM_METHOD_LABEL[row.method]}`, when: when(row.at), text: <span className="mist-col" style={{ gap: 4 }}><span style={{ whiteSpace: 'pre-wrap' }}>{row.content}</span>{(t || row.nextDate) && <span className="mist-row" style={{ gap: 6, flexWrap: 'wrap' }}>{t && row.link && <Pill tone="accent">{CRM_LINK_LABEL[row.link.kind]} · {t.label}</Pill>}{row.nextDate && <Pill tone={state.tasks.find(task => task.id === row.nextTaskId)?.done ? 'ok' : 'warn'}><CalendarClock size={12} /> 下次 {row.nextDate}</Pill>}</span>}</span> }; })} />
      : <EmptyState compact icon={MessageSquarePlus} title="还没有跟进记录" description="记录电话、邮件、会议或拜访的实际沟通内容。" />}
    {compact && rows.length > shown.length && <div style={{ padding: '0 20px 16px' }}><Button variant="quiet" size="sm" onClick={() => go('crm', customer.id, { customerId: customer.id, section: 'followups' })}>查看全部 {rows.length} 条</Button></div>}
    <ModuleEditorDialog spec={dialog} onClose={() => setDialog(null)} />
  </Card>;
}

export function OpportunityPanel({ customer, state, can }: { customer: MistCustomer; state: MistState; can: boolean }) {
  const { run, saving, workspace } = useMistWorkspace(), { go } = useNav(), session = useOptionalMistSession();
  const members = workspaceMembers(workspace, state, session?.user);
  const [dialog, setDialog] = React.useState<ModuleEditorSpec | null>(null), [picked, setPicked] = React.useState<string | null>(null);
  const rows = state.crm.opportunities.filter(row => row.customerId === customer.id).sort((a, b) => Number(OPEN.includes(b.stage)) - Number(OPEN.includes(a.stage)) || a.expectedDate.localeCompare(b.expectedDate));
  const selected = rows.find(row => row.id === picked);
  const totals = openOpportunityTotals(rows);
  const pickOptions = (kind: 'development' | 'quotation' | 'order') => [emptyOption, ...linkOptions(state, customer.id, false).filter(option => option.value.startsWith(kind + ':')).map(option => ({ value: option.value.split(':').slice(1).join(':'), label: option.label }))];
  const editSpec = (row?: CrmOpportunity): ModuleEditorSpec => ({ title: row ? '编辑商机' : '新建商机', submitLabel: row ? '保存商机' : '建立商机', description: `${customer.name} · 金额按原币种记录，不与其他币种合计。`,
    fields: [field('title', '商机名称'), field('domain', '业务板块', 'select', true, [{ value: 'garment', label: '成衣' }, { value: 'fabric', label: '面料' }]), { ...field('amount', '预计金额'), hint: '最多两位小数' }, field('currency', '币种', 'select', true, [...new Set([customer.currency, 'USD', 'EUR', 'GBP', 'CNY', 'HKD'])].map(value => ({ value, label: value }))), field('expectedDate', '预计成交日', 'date'), { ...field('ownerId', '负责人', 'select', true, memberSelectOptions(members, { current: row ? { id: row.ownerId, name: row.owner } : undefined })), hint: '按账号选择本空间成员' },
      { ...field('devId', '关联开发案', 'select', false, pickOptions('development')), hint: '从商机发起的开发，建好后在这里关联' }, field('quotationId', '关联报价', 'select', false, pickOptions('quotation')), { ...field('orderId', '关联订单', 'select', false, pickOptions('order')), hint: '标记“已下单”前须关联实际订单' }, field('note', '说明', 'textarea', false)],
    initialValues: { title: row?.title || '', domain: row?.domain || 'garment', amount: row?.amount || '', currency: row?.currency || customer.currency, expectedDate: row?.expectedDate || '', ownerId: row?.ownerId || (members.some(m => m.id === customer.ownerId) ? customer.ownerId : defaultMemberId(members, session?.user?.id)), devId: row?.devIds[0] || '', quotationId: row?.quotationIds[0] || '', orderId: row?.orderIds[0] || '', note: row?.note || '' },
    submit: async v => { const one = (key: string, keep: string[] = []) => { const value = text(v, key), rest = keep.slice(1); return value ? [value, ...rest.filter(id => id !== value)] : rest; }; const receipt = await run({ type: 'crm.opportunity.save', payload: { ...(row ? { id: row.id } : {}), input: { customerId: customer.id, title: text(v, 'title'), domain: text(v, 'domain') as CrmOpportunity['domain'], amount: text(v, 'amount'), currency: text(v, 'currency'), expectedDate: text(v, 'expectedDate'), ownerId: text(v, 'ownerId'), note: text(v, 'note'), devIds: one('devId', row?.devIds), quotationIds: one('quotationId', row?.quotationIds), orderIds: one('orderId', row?.orderIds) } } }); const id = receipt.result.id; if (typeof id === 'string') setPicked(id); } });
  const stageSpec = (row: CrmOpportunity, stage: CrmStage): ModuleEditorSpec => ({ title: `${row.title} · ${stage === 'lost' ? '标记流失' : `推进到${CRM_STAGE_LABEL[stage]}`}`, submitLabel: stage === 'lost' ? '确认流失' : '确认推进', description: stage === 'won' ? '已关联实际订单，确认后商机结束。' : stage === 'lost' ? '流失后商机结束，原因会保留在阶段记录中。' : '阶段变更会留下记录。',
    fields: [{ ...field('note', stage === 'lost' ? '流失原因' : '说明', 'textarea', stage === 'lost' || (stage === 'quoting' && !row.quotationIds.length)), ...(stage === 'quoting' && !row.quotationIds.length ? { hint: '未关联报价时须说明报价依据' } : {}) }], initialValues: { note: '' },
    submit: v => run({ type: 'crm.opportunity.stage', payload: { id: row.id, stage, note: text(v, 'note') } }) });
  const next = (row: CrmOpportunity): CrmStage | null => row.stage === 'intent' ? 'sampling' : row.stage === 'sampling' ? 'quoting' : row.stage === 'quoting' ? 'won' : null;
  return <Card>
    <CardHeader title="商机" sub={rows.length ? `${rows.filter(row => OPEN.includes(row.stage)).length} 个进行中` : undefined} tools={can ? <Button size="sm" icon={Plus} onClick={() => setDialog(editSpec())}>新建商机</Button> : undefined} />
    {totals.length > 0 && <div style={{ padding: '0 20px 12px' }}><SummaryBar items={totals.map(t => ({ label: `进行中 · ${t.currency}`, value: fmt(t.amount, 2), unit: t.currency, hint: `${t.count} 个商机` }))} /></div>}
    <DataTable ariaLabel="客户商机" rows={rows} rowKey={row => row.id} selectedKey={selected?.id} onRowClick={row => setPicked(row.id)} density="comfy"
      empty={<EmptyState compact icon={Target} title="还没有商机" description="记录意向 → 打样 → 报价 → 下单 / 流失，金额按原币种保存。" />}
      columns={[
        { key: 'title', header: '商机', width: 'minmax(180px,2fr)', render: row => <div className="mist-col" style={{ gap: 2 }}><b className="mist-cell-strong">{row.title}</b><small className="mist-muted">{row.domain === 'fabric' ? '面料' : '成衣'} · {row.owner}</small></div> },
        { key: 'stage', header: '阶段', width: '130px', render: row => <div className="mist-col" style={{ gap: 6 }}>{row.stage !== 'lost' && <StageProgress total={4} current={Math.min(3, OPEN.indexOf(row.stage) + (row.stage === 'won' ? 4 : 0))} />}<Pill tone={STAGE_TONE[row.stage]}>{CRM_STAGE_LABEL[row.stage]}</Pill></div> },
        { key: 'amount', header: '预计金额', width: '130px', align: 'right', render: row => <b className="mist-num">{fmt(Number(row.amount), 2)} <span className="mist-muted">{row.currency}</span></b> },
        { key: 'date', header: '预计成交', width: '96px', hideOnMobile: true, render: row => row.expectedDate },
      ]} />
    <Drawer open={!!selected} onClose={() => setPicked(null)} title={selected?.title || '商机'} sub={selected ? `${customer.name} · ${CRM_STAGE_LABEL[selected.stage]}` : undefined} size="lg">
      {selected && <OpportunityDetail row={selected} state={state} customer={customer} can={can} busy={saving} next={next(selected)}
        onEdit={() => setDialog(editSpec(selected))} onStage={stage => setDialog(stageSpec(selected, stage))}
        onDevelop={() => go('development/new', undefined, { customerId: customer.id })} onQuote={() => go('quotations', undefined, { customerId: customer.id })} onOpen={(view, id) => go(view, id)} />}
    </Drawer>
    <ModuleEditorDialog spec={dialog} onClose={() => setDialog(null)} />
  </Card>;
}

function OpportunityDetail({ row, state, customer, can, busy, next, onEdit, onStage, onDevelop, onQuote, onOpen }: { row: CrmOpportunity; state: MistState; customer: MistCustomer; can: boolean; busy: boolean; next: CrmStage | null; onEdit: () => void; onStage: (stage: CrmStage) => void; onDevelop: () => void; onQuote: () => void; onOpen: (view: string, id: string) => void }) {
  const open = OPEN.includes(row.stage);
  const links: CrmLink[] = [...row.devIds.map(id => ({ kind: 'development' as const, id })), ...row.quotationIds.map(id => ({ kind: 'quotation' as const, id })), ...row.orderIds.map(id => ({ kind: 'order' as const, id }))];
  const wonReason = next === 'won' && !row.orderIds.length ? '请先在编辑中关联实际订单' : '';
  return <div className="mist-col" style={{ gap: 16 }}>
    <div className="mist-row" style={{ flexWrap: 'wrap' }}><Pill tone={STAGE_TONE[row.stage]}>{CRM_STAGE_LABEL[row.stage]}</Pill><Pill>{row.domain === 'fabric' ? '面料业务' : '成衣业务'}</Pill></div>
    {!open && <Banner tone={row.stage === 'won' ? 'ok' : 'neutral'} title={row.stage === 'won' ? '已下单 · 商机结束' : '已流失 · 商机结束'}>{row.stage === 'lost' ? `流失原因：${row.lossReason}` : '后续请在关联订单中跟进。'}</Banner>}
    {can && open && <div className="mist-col" style={{ gap: 6 }}>
      <div className="mist-row mist-module-actions" style={{ flexWrap: 'wrap' }}>
        {next && <Button variant="primary" icon={ArrowRight} disabled={busy || !!wonReason} title={wonReason || undefined} onClick={() => onStage(next)}>推进到{CRM_STAGE_LABEL[next]}</Button>}
        <Button icon={Pencil} disabled={busy} onClick={onEdit}>编辑 / 关联</Button>
        <Button icon={FilePlus2} onClick={onDevelop}>发起开发</Button>
        <Button icon={Receipt} onClick={onQuote}>发起报价</Button>
        <Button icon={XCircle} disabled={busy} onClick={() => onStage('lost')}>标记流失</Button>
      </div>
      {wonReason && <span className="mist-note">推进到已下单：{wonReason}</span>}
      <span className="mist-note">发起开发 / 报价会带入客户 {customer.name}；建好后回到这里关联。</span>
    </div>}
    <Facts items={[{ label: '预计金额', value: `${fmt(Number(row.amount), 2)} ${row.currency}` }, { label: '预计成交日', value: row.expectedDate }, { label: '负责人', value: row.owner }, { label: '最后更新', value: when(row.updatedAt) }]} />
    {row.note && <p className="mist-sub" style={{ whiteSpace: 'pre-wrap' }}>{row.note}</p>}
    <section className="mist-col" style={{ gap: 6 }}>
      <span className="mist-eyebrow">关联业务</span>
      {links.length ? links.map(link => { const t = crmLinkTarget(state, customer.id, link); return <div key={link.kind + link.id} className="mist-row" style={{ gap: 8 }}><Pill>{CRM_LINK_LABEL[link.kind]}</Pill>{t ? <Button variant="quiet" size="sm" onClick={() => onOpen(t.view, t.id)}>{t.label}</Button> : <span className="mist-muted">对象已不可用</span>}</div>; }) : <span className="mist-note">尚未关联开发案、报价或订单。</span>}
    </section>
    <section className="mist-col" style={{ gap: 6 }}>
      <span className="mist-eyebrow">阶段记录</span>
      <Timeline events={[...row.history].reverse().map(h => ({ who: h.actor, when: when(h.at), text: `${h.from ? `${CRM_STAGE_LABEL[h.from]} → ` : ''}${CRM_STAGE_LABEL[h.to]}${h.note ? ` · ${h.note}` : ''}` }))} />
    </section>
  </div>;
}

export function CustomerMailPanel({ customer, state }: { customer: MistCustomer; state: MistState }) {
  const { go } = useNav();
  const emails = new Set(state.contacts.filter(c => c.customerId === customer.id && c.email).map(c => c.email.toLowerCase()));
  const rows = (state.email?.messages || []).filter(m => m.folder !== 'trash' && (m.links.some(link => link.kind === 'customer' && link.id === customer.id) || emails.has(m.from.address.toLowerCase()) || m.to.some(to => emails.has(to.address.toLowerCase())))).sort((a, b) => b.at.localeCompare(a.at));
  const connected = (state.email?.accounts || []).length > 0;
  return <Card><CardHeader title="邮件" sub="已关联该客户、或与其联系人往来的邮件" tools={<Button size="sm" variant="quiet" icon={Mail} onClick={() => go('emails')}>打开智能邮箱</Button>} />
    <DataTable ariaLabel="客户邮件" rows={rows} rowKey={m => m.id} onRowClick={m => go('emails', m.id)} density="comfy"
      empty={<EmptyState compact icon={Mail} title={connected ? '还没有往来邮件' : '未接入任何邮箱'} description={connected ? '在智能邮箱中把邮件关联到该客户，或为联系人填写邮箱。' : '管理员接入邮箱后，与该客户联系人的往来邮件会出现在这里。'} />}
      columns={[
        { key: 'subject', header: '主题', width: 'minmax(200px,2fr)', render: m => <div className="mist-col" style={{ gap: 2 }}><span className="mist-mail-strong" data-unread={!m.read || undefined}>{m.subject}</span><small className="mist-muted">{m.folder === 'sent' ? `致 ${m.to.map(to => to.name || to.address).join('、')}` : m.from.name || m.from.address}</small></div> },
        { key: 'state', header: '关联', width: '110px', hideOnMobile: true, render: m => m.links.some(link => link.kind === 'customer' && link.id === customer.id) ? <Pill tone="ok">已关联</Pill> : <Pill tone="warn"><Flag size={12} /> 待确认</Pill> },
        { key: 'at', header: '时间', width: '96px', render: m => <small className="mist-muted">{when(m.at)}</small> },
      ]} />
  </Card>;
}