/** 智能邮箱：三栏收件箱（邮箱与文件夹 / 邮件列表 / 阅读区）。只记录标记、关联、跟进与草稿；收信与发信服务尚未接入，不伪造同步或发送结果。 */
import React from 'react';
import { AlertTriangle, Archive, ArchiveRestore, CalendarPlus, Download, Forward, Inbox, Link2, Mail, MailOpen, Paperclip, PenLine, Reply, ReplyAll, RotateCcw, SearchX, Send, Settings2, Sparkles, Star, Trash2, Unlink, Upload } from 'lucide-react';
import { Banner, Button, Card, Checkbox, DataTable, Dialog, Drawer, Dropdown, EmptyState, Facts, Field, FormGrid, MistPage, PageHeader, Pill, SearchField, Select, TextArea, TextInput, TextLink, Toolbar, useToast, type Column, type Tone } from '../../../../../components/mist';
import type { MistCommand, MistState } from '../../../../../server/src/shared/mistWorkspace';
import { EMAIL_LINK_LABEL, emailLinkTarget, type EmailAccount, type EmailDraft, type EmailDraftInput, type EmailLink, type EmailLinkKind, type EmailMessage } from '../../../../../server/src/shared/mistEmail';
import { useMistWorkspace } from '../../runtime/workspace';
import { useMistSession } from '../../runtime/auth';
import { useNav, type RouteTarget } from '../../nav';
import { Events } from './fulfillmentKit';
import { ActionBar, DetailBlock, DetailBody, ListDetail, shortWhen, todayIso, type ReasonedAction } from './pageKit';

export type MailFolder = 'inbox' | 'drafts' | 'outbox' | 'sent' | 'archive' | 'trash';
export type MailView = 'unread' | 'starred' | 'important' | 'followup' | 'unlinked';
export type MailScope = { kind: 'folder'; value: MailFolder } | { kind: 'view'; value: MailView };
type Row = { kind: 'message'; id: string; message: EmailMessage } | { kind: 'draft'; id: string; draft: EmailDraft };
type Exec = (command: MistCommand, done?: string) => Promise<unknown>;
const FOLDERS: Array<{ value: MailFolder; label: string; icon: typeof Inbox }> = [
  { value: 'inbox', label: '收件箱', icon: Inbox }, { value: 'drafts', label: '草稿', icon: PenLine }, { value: 'outbox', label: '待发送', icon: Upload },
  { value: 'sent', label: '已发送', icon: Send }, { value: 'archive', label: '已归档', icon: Archive }, { value: 'trash', label: '已删除', icon: Trash2 },
];
const VIEWS: Array<{ value: MailView; label: string }> = [{ value: 'unread', label: '未读' }, { value: 'starred', label: '星标' }, { value: 'important', label: '重要' }, { value: 'followup', label: '待跟进' }, { value: 'unlinked', label: '未关联业务' }];
const FOLDER_FOR_FAILURE: Record<string, MailFolder> = { 收件箱: 'inbox', 已发送: 'sent', 已归档: 'archive', 已删除: 'trash' };
const SEND_BLOCKED = '该邮箱尚未接入发信服务 · 管理后台 › 邮箱账号';
const SOURCE_LABEL: Record<EmailMessage['category']['source'], { label: string; tone: Tone }> = { rule: { label: '规则分类', tone: 'accent' }, ai: { label: 'AI 分类', tone: 'ai' }, none: { label: '未分类', tone: 'neutral' }, failed: { label: '分类失败', tone: 'warn' } };
export const EMAIL_TEMPLATES: Array<{ value: string; label: string; subject: string; body: string }> = [
  { value: '询价回复', label: '询价回复', subject: '询价回复：【款号 / 品名】', body: '您好，\n\n感谢询价。【款号 / 品名】的报价如下：\n- 单价：【币种 单价 / 计价单位】\n- 起订量：【数量 单位】\n- 交期：【日期】\n报价有效期至【日期】。\n\n如有问题请随时联系。' },
  { value: '样品寄出通知', label: '样品寄出通知', subject: '样品寄出：【开发案编号】', body: '您好，\n\n【开发案编号】【版本】样品已于【日期】寄出，快递【承运商】运单号【运单号】。\n请收到后确认样品状态与修改意见。' },
  { value: 'PI 发送', label: 'PI 发送', subject: 'PI：【订单号】', body: '您好，\n\n附件为【订单号】的形式发票（PI），请核对数量、单价、贸易条款与付款条件，确认后回签。' },
  { value: '出货通知', label: '出货通知', subject: '出货通知：【出运编号】', body: '您好，\n\n【订单号】已于【日期】出运，【运输方式】【装运港 → 目的港】，预计到港【日期】。\n提单与装箱单见附件。' },
];
const isFollowUp = (state: MistState, m: EmailMessage) => m.followUpTaskIds.some(id => state.tasks.some(task => task.id === id && !task.done));
const addressText = (rows: Array<{ name: string; address: string }>) => rows.map(row => row.name ? `${row.name} <${row.address}>` : row.address).join('，');
const when = (at: string) => { const date = new Date(at); return Number.isFinite(date.getTime()) ? `${shortWhen(at)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` : '—'; };
const sizeText = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const problemText = (problem: unknown, fallback: string) => problem instanceof Error ? problem.message : fallback;
const linkKey = (link: EmailLink) => `${link.kind}:${link.id}`;

/** 发件人与已有联系人邮箱完全一致、且尚未关联该客户时，给出需人工确认的关联建议。 */
export function contactSuggestion(state: MistState, m: EmailMessage) {
  const address = m.from.address.toLowerCase(), contact = state.contacts.find(row => row.email && row.email.toLowerCase() === address);
  const customer = contact && state.customers.find(row => row.id === contact.customerId);
  if (!contact || !customer || m.links.some(link => link.kind === 'customer' && link.id === customer.id)) return null;
  return { contact, customer };
}
export function mailMatches(state: MistState, m: EmailMessage, scope: MailScope) {
  if (scope.kind === 'folder') return m.folder === scope.value;
  if (m.folder === 'trash') return false;
  if (scope.value === 'unread') return !m.read;
  if (scope.value === 'starred') return m.starred;
  if (scope.value === 'important') return m.important;
  if (scope.value === 'followup') return isFollowUp(state, m);
  return !m.links.length;
}

export function EmailsPage() {
  const { state, run, error, refresh, loading, saving, pending } = useMistWorkspace(), session = useMistSession(), { go, route } = useNav(), toast = useToast();
  const can = session.hasPermission('emails:write'), locked = saving || !!pending;
  const email = state?.email || { accounts: [], messages: [], drafts: [] };
  const [accountId, setAccountId] = React.useState<string>('all'), [scope, setScope] = React.useState<MailScope>({ kind: 'folder', value: 'inbox' });
  const [query, setQuery] = React.useState(''), [category, setCategory] = React.useState('all');
  const [picked, setPicked] = React.useState<string | null>(route.id || null), [drawer, setDrawer] = React.useState(!!route.id);
  const [compose, setCompose] = React.useState<{ id?: string; input: EmailDraftInput } | null>(null), [followUp, setFollowUp] = React.useState<EmailMessage | null>(null);
  const [failure, setFailure] = React.useState('');
  const ready = !!state;
  React.useEffect(() => {
    if (!route.id || !state) return;
    const m = state.email?.messages.find(row => row.id === route.id);
    if (m) { setScope({ kind: 'folder', value: m.folder }); setAccountId('all'); } else if (state.email?.drafts.some(row => row.id === route.id)) setScope({ kind: 'folder', value: 'drafts' });
    setPicked(route.id); setDrawer(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.id, ready]);
  const accounts = email.accounts, inAccount = (id: string) => accountId === 'all' || id === accountId;
  const messages = email.messages.filter(m => inAccount(m.accountId)), drafts = email.drafts.filter(d => inAccount(d.accountId));
  const count = (s: MailScope) => s.kind === 'folder' && s.value === 'drafts' ? drafts.length : s.kind === 'folder' && s.value === 'outbox' ? 0 : state ? messages.filter(m => mailMatches(state, m, s)).length : 0;
  const needle = query.trim().toLowerCase();
  const categories = [...new Set(email.messages.map(m => m.category.label).filter(Boolean))];
  const isDrafts = scope.kind === 'folder' && scope.value === 'drafts', isOutbox = scope.kind === 'folder' && scope.value === 'outbox';
  const scoped: Row[] = isDrafts ? drafts.map(d => ({ kind: 'draft' as const, id: d.id, draft: d }))
    : isOutbox || !state ? [] : messages.filter(m => mailMatches(state, m, scope)).map(m => ({ kind: 'message' as const, id: m.id, message: m }));
  const stamp = (row: Row) => row.kind === 'draft' ? row.draft.updatedAt : row.message.at;
  const rows = scoped.filter(row => {
    if (row.kind === 'draft') return !needle || `${row.draft.subject} ${row.draft.to} ${row.draft.body}`.toLowerCase().includes(needle);
    const m = row.message;
    if (category !== 'all' && (category === 'none' ? !!m.category.label : m.category.label !== category)) return false;
    return !needle || `${m.subject} ${m.from.name} ${m.from.address} ${addressText(m.to)} ${m.body} ${m.extracted.map(item => item.value).join(' ')}`.toLowerCase().includes(needle);
  }).sort((a, b) => stamp(b).localeCompare(stamp(a)));
  const find = (id: string | null): Row | undefined => {
    if (!id) return undefined;
    const m = email.messages.find(row => row.id === id); if (m) return { kind: 'message', id: m.id, message: m };
    const d = email.drafts.find(row => row.id === id); return d ? { kind: 'draft', id: d.id, draft: d } : undefined;
  };
  const selected = rows.find(row => row.id === picked) || find(picked);
  const exec: Exec = async (command, done) => { setFailure(''); try { const receipt = await run(command); if (done) toast(done); return receipt; } catch (problem) { setFailure(problemText(problem, '操作未保存，请重试')); return null; } };
  const pick = (row: Row) => {
    setPicked(row.id); setDrawer(true); go('emails', row.id);
    if (row.kind === 'message' && !row.message.read && can && !locked) void exec({ type: 'email.flag', payload: { id: row.id, flag: 'read', value: true } });
  };
  const changeScope = (next: MailScope) => { setScope(next); setPicked(null); setDrawer(false); setCategory('all'); };
  const changeAccount = (id: string) => { setAccountId(id); setPicked(null); setDrawer(false); };
  const blankInput = (account?: EmailAccount): EmailDraftInput => ({ accountId: account?.id || '', from: account?.address || '', to: '', cc: '', bcc: '', subject: '', body: account?.signature ? `\n\n--\n${account.signature}` : '', template: '', links: [], fileIds: [] });
  const defaultAccount = accounts.find(a => a.id === accountId) || accounts.find(a => a.kind === 'personal') || accounts[0];
  const respond = (m: EmailMessage, mode: 'reply' | 'all' | 'forward') => {
    const account = accounts.find(a => a.id === m.accountId) || defaultAccount;
    const mine = new Set([account?.address || '', ...(account?.aliases || [])].filter(Boolean).map(value => value.toLowerCase()));
    const others = [...m.to, ...m.cc].map(row => row.address).filter(address => !mine.has(address.toLowerCase()) && address !== m.from.address);
    const quoted = `\n\n--\n${account?.signature || ''}\n\n——— 原邮件 ———\n发件人：${addressText([m.from])}\n时间：${when(m.at)}\n主题：${m.subject}\n\n${m.body}`;
    const to = mode === 'forward' ? '' : m.folder === 'sent' ? m.to.map(row => row.address).join(', ') : m.from.address;
    setCompose({ input: { ...blankInput(account), to, cc: mode === 'all' ? others.join(', ') : '', subject: `${mode === 'forward' ? 'Fwd' : 'Re'}: ${m.subject.replace(/^(Re|Fwd):\s*/i, '')}`, body: quoted, links: m.links, replyToId: m.id } });
  };
  const failedAccounts = accounts.filter(a => a.failedFolders.length && inAccount(a.id));
  const scopeLabel = scope.kind === 'folder' ? FOLDERS.find(f => f.value === scope.value)!.label : VIEWS.find(v => v.value === scope.value)!.label;
  const scopeFailed = scope.kind === 'folder' && failedAccounts.some(a => a.failedFolders.some(name => FOLDER_FOR_FAILURE[name] === scope.value));
  const toAccounts = () => go('admin-panel', undefined, { section: 'mail-accounts' } as RouteTarget);

  const columns: Column<Row>[] = [
    { key: 'from', header: scope.kind === 'folder' && (scope.value === 'sent' || isDrafts) ? '收件人' : '发件人', width: 'minmax(130px,1fr)', hideOnMobile: true, render: row => {
      if (row.kind === 'draft') return <div className="mist-col" style={{ gap: 2 }}><span>{row.draft.to || '未填写收件人'}</span><small className="mist-muted">草稿 · {row.draft.from}</small></div>;
      const m = row.message, name = m.folder === 'sent' ? addressText(m.to) : m.from.name || m.from.address;
      return <div className="mist-col" style={{ gap: 2 }}><span className="mist-mail-strong" data-unread={!m.read || undefined}>{name}</span><small className="mist-muted">{accounts.find(a => a.id === m.accountId)?.kind === 'shared' ? '共享邮箱' : '个人邮箱'}</small></div>;
    } },
    { key: 'subject', header: '主题', width: 'minmax(200px,2.4fr)', render: row => {
      if (row.kind === 'draft') return <div className="mist-col" style={{ gap: 2 }}><span>{row.draft.subject || '（无主题）'}</span><small className="mist-muted mist-mail-snippet">{row.draft.body.trim().split('\n')[0] || '正文为空'}</small></div>;
      const m = row.message;
      return <div className="mist-col" style={{ gap: 3 }}>
        <small className="mist-muted mist-mail-mobile-meta">{m.folder === 'sent' ? `致 ${m.to.map(item => item.name || item.address).join('、')}` : m.from.name || m.from.address} · {when(m.at)}</small>
        <span className="mist-row" style={{ gap: 6 }}>{m.starred && <Star size={13} aria-label="星标" className="mist-mail-star" />}<span className="mist-mail-strong" data-unread={!m.read || undefined}>{m.subject}</span></span>
        <small className="mist-muted mist-mail-snippet">{m.body.replace(/\s+/g, ' ').slice(0, 80)}</small>
        <span className="mist-row" style={{ gap: 4, flexWrap: 'wrap' }}>
          {m.important && <Pill tone="warn">重要</Pill>}
          {m.category.label ? <Pill tone={SOURCE_LABEL[m.category.source].tone}>{m.category.label}</Pill> : m.category.source === 'failed' ? <Pill tone="warn">分类失败</Pill> : null}
          {!m.links.length && <Pill>未关联业务</Pill>}
          {state && isFollowUp(state, m) && <Pill tone="accent">待跟进</Pill>}
          {m.attachments.length > 0 && <small className="mist-muted mist-row" style={{ gap: 2 }}><Paperclip size={12} />{m.attachments.length}</small>}
        </span>
      </div>;
    } },
    { key: 'at', header: '时间', width: '92px', hideOnMobile: true, render: row => <small className="mist-muted">{when(stamp(row))}</small> },
  ];

  const navItem = (key: string, active: boolean, onClick: () => void, icon: React.ReactNode, label: React.ReactNode, badge?: number, title?: string) =>
    <button key={key} type="button" className="mist-mail-navitem" data-active={active || undefined} onClick={onClick} title={title}>{icon}<span className="mist-mail-navlabel">{label}</span>{badge ? <b>{badge}</b> : null}</button>;
  const nav = <Card as="nav" className="mist-mail-nav" aria-label="邮箱与文件夹">
    <div className="mist-mail-navgroup">
      <span className="mist-eyebrow">邮箱</span>
      {navItem('all', accountId === 'all', () => changeAccount('all'), <Mail size={15} />, '全部邮箱', email.messages.filter(m => m.folder === 'inbox' && !m.read).length)}
      {accounts.map(a => navItem(a.id, accountId === a.id, () => changeAccount(a.id), <span className="mist-mail-dot" data-tone={a.failedFolders.length ? 'warn' : a.connection === 'example' ? 'ok' : 'neutral'} />,
        <span className="mist-col" style={{ gap: 0, minWidth: 0 }}><span className="mist-mail-ellipsis">{a.displayName}</span><small className="mist-muted mist-mail-ellipsis">{a.connection === 'example' ? `示例 · 同步于 ${a.lastSyncAt ? when(a.lastSyncAt) : '—'}` : '未接入'}</small></span>, undefined, a.address))}
    </div>
    <div className="mist-mail-navgroup">
      <span className="mist-eyebrow">文件夹</span>
      {FOLDERS.map(f => navItem(f.value, scope.kind === 'folder' && scope.value === f.value, () => changeScope({ kind: 'folder', value: f.value }), <f.icon size={15} />, f.label, f.value === 'inbox' ? messages.filter(m => m.folder === 'inbox' && !m.read).length : count({ kind: 'folder', value: f.value })))}
    </div>
    <div className="mist-mail-navgroup">
      <span className="mist-eyebrow">视图</span>
      {VIEWS.map(v => navItem(v.value, scope.kind === 'view' && scope.value === v.value, () => changeScope({ kind: 'view', value: v.value }), <span className="mist-mail-dot" data-tone={v.value === 'followup' ? 'accent' : v.value === 'important' ? 'warn' : 'neutral'} />, v.label, count({ kind: 'view', value: v.value })))}
    </div>
  </Card>;

  const emptyList = isOutbox
    ? <EmptyState icon={Upload} title="没有待发送邮件" description="发信服务尚未接入；写好的邮件保存在草稿中，不会进入待发送。" />
    : scoped.length ? <EmptyState icon={SearchX} title="没有符合条件的邮件" description="换个关键词或清除分类筛选。" action={<Button onClick={() => { setQuery(''); setCategory('all'); }}>清除筛选</Button>} />
    : <EmptyState icon={isDrafts ? PenLine : Inbox} title={`${scopeLabel}为空`} description={isDrafts ? '写邮件后保存草稿，会出现在这里。' : '当前邮箱在这里没有邮件。'} />;
  const editDraft = (d: EmailDraft) => { const { id, createdAt: _c, updatedAt: _u, updatedBy: _b, ...input } = d; setCompose({ id, input }); };
  const deleteDraft = async (id: string) => { if (await exec({ type: 'email.draft.delete', payload: { id } }, '草稿已删除')) { setPicked(null); setDrawer(false); } };
  const detail = selected && state
    ? selected.kind === 'draft'
      ? <DraftDetail draft={selected.draft} state={state} can={can} locked={locked} onEdit={() => editDraft(selected.draft)} onDelete={() => void deleteDraft(selected.id)} />
      : <MessageDetail message={selected.message} state={state} can={can} locked={locked} exec={exec} onOpen={(view, id) => go(view, id)} onRespond={mode => respond(selected.message, mode)} onFollowUp={() => setFollowUp(selected.message)} />
    : <EmptyState icon={MailOpen} title="阅读邮件" description={loading ? '正在读取邮箱' : '从列表选择一封邮件，查看正文、附件、业务关联与跟进'} compact />;
  const saveDraft = async (input: EmailDraftInput, id?: string) => { const receipt = await exec({ type: 'email.draft.save', payload: { ...(id ? { id } : {}), input } }, '草稿已保存'); if (receipt) setCompose(null); };
  const createFollowUp = async (owner: string, due: string, note: string) => { if (followUp && await exec({ type: 'email.followUp', payload: { id: followUp.id, owner, due, note } }, '已生成跟进待办，并写入日历')) setFollowUp(null); };

  return <MistPage width="wide">
    <PageHeader eyebrow="我的事务" title="智能邮箱" description="个人与共享邮箱的来往邮件；可标记、关联客户 / 开发案 / 订单 / 发票，生成跟进待办，并把抽取资料提交给业务对象复核。"
      actions={<>
        <Button icon={RotateCcw} disabled title="收信服务尚未接入">同步</Button>
        <Button icon={Settings2} onClick={toAccounts}>邮箱账号</Button>
        {can && <Button variant="primary" icon={PenLine} disabled={!accounts.length || locked} title={accounts.length ? undefined : '尚未接入任何邮箱'} onClick={() => setCompose({ input: blankInput(defaultAccount) })}>写邮件</Button>}
      </>} />
    {!can && <div className="mist-section"><Banner tone="neutral" title="只读查看">你的账号没有邮件编辑权限，可以阅读邮件与业务关联，不能标记、关联、跟进或写邮件。</Banner></div>}
    {error && <div className="mist-section"><Banner tone="bad" title="邮箱未读取" actions={<Button onClick={() => void refresh()}>重试</Button>}>{error}</Banner></div>}
    {failure && <div className="mist-section"><Banner tone="bad" title="操作未完成">{failure}</Banner></div>}
    {!loading && state && !accounts.length
      ? <Card><EmptyState icon={Mail} title="未接入任何邮箱" description="管理员在管理后台 › 邮箱账号中接入个人或共享邮箱后，邮件会出现在这里。本空间目前没有邮件数据。" action={<Button icon={Settings2} onClick={toAccounts}>前往邮箱账号</Button>} /></Card>
      : <>
        {accounts.some(a => a.example) && <p className="mist-note mist-section">示例邮箱：邮件为示例空间的合成数据，收信与发信服务尚未接入；标记、关联、跟进与草稿会真实保存到工作空间。</p>}
        {failedAccounts.length > 0 && <div className="mist-section"><Banner tone="warn" icon={AlertTriangle} title={scopeFailed ? `${scopeLabel}同步失败` : '部分文件夹同步失败'}>{failedAccounts.map(a => `${a.displayName}：${a.failedFolders.join('、')}未能同步，显示的是上次同步结果`).join('；')}。</Banner></div>}
        <div className="mist-mail">
          {nav}
          <div className="mist-col" style={{ gap: 12, minWidth: 0 }}>
            <Toolbar>
              <SearchField value={query} onChange={setQuery} placeholder="搜索主题、发件人、正文或抽取资料" />
              {!isDrafts && <Dropdown<string> label="分类" value={category} onChange={setCategory} options={[{ value: 'all', label: '全部分类' }, ...categories.map(value => ({ value, label: value })), { value: 'none', label: '未分类' }]} />}
            </Toolbar>
            <ListDetail drawerOpen={drawer && !!selected} onDrawerClose={() => setDrawer(false)}
              drawerTitle={selected ? (selected.kind === 'draft' ? selected.draft.subject || '（无主题草稿）' : selected.message.subject) : '邮件'}
              drawerSub={selected?.kind === 'message' ? addressText([selected.message.from]) : selected ? '草稿' : undefined}
              list={<Card><DataTable ariaLabel={`${scopeLabel}邮件`} loading={loading} rows={rows} rowKey={row => row.id} selectedKey={selected?.id} density="comfy" onRowClick={pick} columns={columns} empty={emptyList} /></Card>}
              detail={detail} />
          </div>
        </div>
      </>}
    {compose && state && <ComposeDrawer key={compose.id || 'new'} state={state} initial={compose} locked={locked} onClose={() => setCompose(null)} onSave={saveDraft} />}
    {followUp && <FollowUpDialog message={followUp} owner={session.user?.displayName || state?.settings.profileName || ''} locked={locked} onClose={() => setFollowUp(null)} onSubmit={createFollowUp} />}
  </MistPage>;
}

function MessageDetail({ message: m, state, can, locked, exec, onOpen, onRespond, onFollowUp }: {
  message: EmailMessage; state: MistState; can: boolean; locked: boolean; exec: Exec; onOpen: (view: string, id: string) => void; onRespond: (mode: 'reply' | 'all' | 'forward') => void; onFollowUp: () => void;
}) {
  const account = state.email.accounts.find(a => a.id === m.accountId), suggestion = contactSuggestion(state, m), source = SOURCE_LABEL[m.category.source];
  const noWrite = can ? false : '需要邮件编辑权限';
  const [kind, setKind] = React.useState<EmailLinkKind>('order'), [target, setTarget] = React.useState(''), [submitTo, setSubmitTo] = React.useState('');
  React.useEffect(() => { setTarget(''); setSubmitTo(''); }, [m.id]);
  const options: Record<EmailLinkKind, Array<{ value: string; label: string }>> = {
    customer: state.customers.map(row => ({ value: row.id, label: row.name })), development: state.devs.map(row => ({ value: row.id, label: `${row.code} · ${row.name}` })),
    order: state.orders.map(row => ({ value: row.id, label: `${row.code} · ${row.customer}` })), invoice: state.invoices.filter(row => !row.voidedAt).map(row => ({ value: row.id, label: `${row.code} · ${row.customer}` })),
  };
  const submittable = m.links.filter(link => !m.submissions.some(s => linkKey(s.link) === linkKey(link)) && emailLinkTarget(state, link));
  const tasks = m.followUpTaskIds.map(id => state.tasks.find(task => task.id === id)).filter((task): task is MistState['tasks'][number] => !!task);
  const actions: ReasonedAction[] = [
    { label: '回复', icon: Reply, onClick: () => onRespond('reply'), primary: true, reason: noWrite, hidden: m.folder === 'trash' },
    { label: '全部回复', icon: ReplyAll, onClick: () => onRespond('all'), reason: noWrite, hidden: m.folder === 'trash' || m.folder === 'sent' },
    { label: '转发', icon: Forward, onClick: () => onRespond('forward'), reason: noWrite, hidden: m.folder === 'trash' },
    { label: '归档', icon: Archive, onClick: () => void exec({ type: 'email.move', payload: { id: m.id, folder: 'archive' } }, '已归档'), reason: noWrite, hidden: m.folder !== 'inbox' && m.folder !== 'sent' },
    { label: '移回收件箱', icon: ArchiveRestore, onClick: () => void exec({ type: 'email.move', payload: { id: m.id, folder: 'inbox' } }, '已移回收件箱'), reason: noWrite, hidden: m.folder !== 'archive' },
    { label: '删除', icon: Trash2, onClick: () => void exec({ type: 'email.move', payload: { id: m.id, folder: 'trash' } }, '已移到已删除'), reason: noWrite, hidden: m.folder === 'trash' },
    { label: '恢复', icon: RotateCcw, onClick: () => void exec({ type: 'email.move', payload: { id: m.id, folder: 'restore' } }, '邮件已恢复'), primary: true, reason: noWrite, hidden: m.folder !== 'trash' },
  ];
  const link = async (value: EmailLink, done: string) => { if (await exec({ type: 'email.link', payload: { id: m.id, link: value } }, done)) setTarget(''); };
  const submit = async () => { const value = submittable.find(row => linkKey(row) === submitTo); if (value && await exec({ type: 'email.submitExtraction', payload: { id: m.id, link: value } }, '已提交，等待业务对象负责人复核')) setSubmitTo(''); };
  return <DetailBody data-email-detail={m.id} heading={<div>
      <span className="mist-mono mist-muted">{account?.displayName || '邮箱不可用'}</span>
      <div className="mist-h2" style={{ fontSize: 19, marginTop: 4 }}>{m.subject}</div>
    </div>}>
    <div className="mist-row" style={{ flexWrap: 'wrap' }}>
      {m.example && <Pill>示例邮件</Pill>}{m.important && <Pill tone="warn">重要</Pill>}{m.starred && <Pill tone="accent">星标</Pill>}
      {m.folder === 'trash' && <Pill tone="neutral">已删除</Pill>}{m.folder === 'archive' && <Pill tone="neutral">已归档</Pill>}{m.folder === 'sent' && <Pill tone="neutral">已发送</Pill>}
    </div>
    <ActionBar busy={locked} actions={can ? actions : actions.slice(0, 1)} />
    {can && <div className="mist-row mist-mail-flags" aria-label="邮件标记">
      <Button size="sm" icon={MailOpen} disabled={locked} onClick={() => void exec({ type: 'email.flag', payload: { id: m.id, flag: 'read', value: !m.read } })}>{m.read ? '标为未读' : '标为已读'}</Button>
      <Button size="sm" icon={Star} disabled={locked} aria-pressed={m.starred} onClick={() => void exec({ type: 'email.flag', payload: { id: m.id, flag: 'starred', value: !m.starred } })}>{m.starred ? '取消星标' : '星标'}</Button>
      <Button size="sm" icon={AlertTriangle} disabled={locked} aria-pressed={m.important} onClick={() => void exec({ type: 'email.flag', payload: { id: m.id, flag: 'important', value: !m.important } })}>{m.important ? '取消重要' : '标为重要'}</Button>
    </div>}
    <Facts items={[
      { label: '发件人', value: <Addresses rows={[m.from]} /> }, { label: '收件人', value: m.to.length ? <Addresses rows={m.to} /> : '—' },
      ...(m.cc.length ? [{ label: '抄送', value: <Addresses rows={m.cc} /> }] : []), { label: '时间', value: when(m.at) },
    ]} />
    {m.folder === 'sent' && <Banner tone="neutral" title="发送记录">{m.example ? '示例已发送邮件，没有真实投递或回执记录。' : '发信服务尚未接入，没有投递回执。'}</Banner>}
    <div className="mist-mail-body">{m.body}</div>
    {m.attachments.length > 0 && <DetailBlock title={`附件（${m.attachments.length}）`}>
      {m.attachments.map(file => <div key={file.id} className="mist-row mist-mail-attachment"><Paperclip size={14} /><span className="mist-mail-ellipsis">{file.name}</span><small className="mist-muted">{sizeText(file.size)}</small><span className="mist-spacer" /><Button size="sm" icon={Download} disabled title={m.example ? '示例附件没有文件内容' : '附件下载尚未接入'}>下载</Button></div>)}
      <span className="mist-note">{m.example ? '示例附件无文件，不能下载。' : '附件下载尚未接入。'}</span>
    </DetailBlock>}
    <DetailBlock title="业务关联">
      {suggestion && <Banner tone="accent" icon={Link2} title="建议关联客户" actions={can ? <Button size="sm" disabled={locked} onClick={() => void link({ kind: 'customer', id: suggestion.customer.id }, `已关联客户 ${suggestion.customer.name}`)}>确认关联</Button> : undefined}>发件人 {m.from.address} 是 {suggestion.customer.name} 的联系人 {suggestion.contact.name}。确认后才会关联。</Banner>}
      {m.links.length ? <div className="mist-col" style={{ gap: 6 }}>{m.links.map(row => {
        const t = emailLinkTarget(state, row), submitted = m.submissions.some(s => linkKey(s.link) === linkKey(row));
        return <div key={linkKey(row)} className="mist-row mist-mail-link">
          <Pill>{EMAIL_LINK_LABEL[row.kind]}</Pill>{t ? <TextLink onClick={() => onOpen(t.view, t.id)}>{t.label}</TextLink> : <span className="mist-muted">对象已不可用</span>}<span className="mist-spacer" />
          {can && <Button size="sm" icon={Unlink} disabled={locked || submitted} title={submitted ? '已向该对象提交过资料，关联不能移除' : undefined} onClick={() => void exec({ type: 'email.unlink', payload: { id: m.id, link: row } }, '已移除关联')}>移除</Button>}
        </div>;
      })}</div> : <span className="mist-note">尚未关联业务对象。</span>}
      {can && <div className="mist-row mist-mail-picker">
        <Select aria-label="关联类型" value={kind} onChange={event => { setKind(event.target.value as EmailLinkKind); setTarget(''); }} options={(Object.keys(EMAIL_LINK_LABEL) as EmailLinkKind[]).map(value => ({ value, label: EMAIL_LINK_LABEL[value] }))} />
        <Select aria-label="关联对象" value={target} onChange={event => setTarget(event.target.value)} placeholder={options[kind].length ? `选择${EMAIL_LINK_LABEL[kind]}` : `没有可关联的${EMAIL_LINK_LABEL[kind]}`} options={options[kind].filter(option => !m.links.some(row => row.kind === kind && row.id === option.value))} />
        <Button icon={Link2} disabled={locked || !target} onClick={() => void link({ kind, id: target }, '已关联')}>关联</Button>
      </div>}
    </DetailBlock>
    <DetailBlock title="分类与抽取" aside={<Pill tone={source.tone}>{source.label}</Pill>}>
      <span className="mist-sub">{m.category.label ? `${m.category.label} · ` : ''}{m.category.detail}</span>
      {m.extracted.length ? <Facts items={m.extracted.map(item => ({ label: item.field, value: item.value }))} /> : <span className="mist-note">没有抽取到结构化资料。</span>}
      {m.extracted.length > 0 && can && <div className="mist-row mist-mail-picker">
        <Select aria-label="提交到业务对象" value={submitTo} onChange={event => setSubmitTo(event.target.value)} placeholder={submittable.length ? '选择已关联对象' : m.links.length ? '已全部提交' : '请先关联业务对象'} options={submittable.map(row => ({ value: linkKey(row), label: `${EMAIL_LINK_LABEL[row.kind]} · ${emailLinkTarget(state, row)!.label}` }))} />
        <Button icon={Sparkles} disabled={locked || !submitTo} onClick={() => void submit()}>提交到业务对象</Button>
      </div>}
      {m.extracted.length > 0 && <span className="mist-note">提交只生成复核待办，不直接改写客户、订单或发票数据。</span>}
      {m.submissions.map(s => <span key={s.taskId} className="mist-note">{shortWhen(s.at)} {s.actor} 提交到{EMAIL_LINK_LABEL[s.link.kind]} {emailLinkTarget(state, s.link)?.label || '对象已不可用'} · {state.tasks.find(task => task.id === s.taskId)?.done ? '已复核' : '待复核'}</span>)}
    </DetailBlock>
    <DetailBlock title="跟进" aside={can ? <Button size="sm" icon={CalendarPlus} disabled={locked || m.folder === 'trash'} title={m.folder === 'trash' ? '已删除的邮件不能生成跟进' : undefined} onClick={onFollowUp}>生成跟进</Button> : undefined}>
      {tasks.length ? tasks.map(task => <div key={task.id} className="mist-row" style={{ flexWrap: 'wrap' }}><Pill tone={task.done ? 'ok' : 'accent'}>{task.done ? '已完成' : '待跟进'}</Pill><span>{task.title}</span><span className="mist-spacer" /><small className="mist-muted">截止 {task.due}</small></div>) : <span className="mist-note">还没有跟进待办。</span>}
    </DetailBlock>
    <DetailBlock title="处理记录"><Events entity="email" id={m.id} /></DetailBlock>
  </DetailBody>;
}

function Addresses({ rows }: { rows: Array<{ name: string; address: string }> }) {
  return <span className="mist-col" style={{ gap: 2 }}>{rows.map(row => <span key={row.address} className="mist-mail-addr">{row.name && <span>{row.name}</span>}<small className="mist-muted">{row.address}</small></span>)}</span>;
}

function DraftDetail({ draft: d, state, can, locked, onEdit, onDelete }: { draft: EmailDraft; state: MistState; can: boolean; locked: boolean; onEdit: () => void; onDelete: () => void }) {
  const account = state.email.accounts.find(a => a.id === d.accountId), noWrite = can ? false : '需要邮件编辑权限';
  return <DetailBody data-email-draft={d.id} heading={<div><span className="mist-mono mist-muted">草稿 · {account?.displayName || '邮箱不可用'}</span><div className="mist-h2" style={{ fontSize: 19, marginTop: 4 }}>{d.subject || '（无主题）'}</div></div>}>
    <ActionBar busy={locked} actions={[
      { label: '继续编辑', icon: PenLine, onClick: onEdit, primary: true, reason: noWrite },
      { label: '发送', icon: Send, onClick: () => undefined, reason: SEND_BLOCKED },
      { label: '删除草稿', icon: Trash2, onClick: onDelete, reason: noWrite },
    ]} />
    <Facts items={[{ label: '发件身份', value: d.from }, { label: '收件人', value: d.to || '未填写' }, ...(d.cc ? [{ label: '抄送', value: d.cc }] : []), ...(d.bcc ? [{ label: '密送', value: d.bcc }] : []), { label: '模板', value: d.template || '未使用' }, { label: '最后保存', value: `${d.updatedBy} · ${when(d.updatedAt)}` }]} />
    <div className="mist-mail-body">{d.body || '正文为空'}</div>
    {(d.links.length > 0 || d.fileIds.length > 0) && <DetailBlock title="关联与附件">
      {d.links.map(row => <span key={linkKey(row)} className="mist-sub">{EMAIL_LINK_LABEL[row.kind]} · {emailLinkTarget(state, row)?.label || '对象已不可用'}</span>)}
      {d.fileIds.map(id => <span key={id} className="mist-sub mist-row" style={{ gap: 4 }}><Paperclip size={12} />{state.files.find(file => file.id === id)?.name || '文件不可用'}</span>)}
    </DetailBlock>}
  </DetailBody>;
}

function ComposeDrawer({ state, initial, locked, onClose, onSave }: { state: MistState; initial: { id?: string; input: EmailDraftInput }; locked: boolean; onClose: () => void; onSave: (input: EmailDraftInput, id?: string) => Promise<void> }) {
  const [v, setV] = React.useState<EmailDraftInput>(initial.input), [showCc, setShowCc] = React.useState(!!(initial.input.cc || initial.input.bcc));
  const set = <K extends keyof EmailDraftInput>(key: K, value: EmailDraftInput[K]) => setV(prev => ({ ...prev, [key]: value }));
  const account = state.email.accounts.find(a => a.id === v.accountId), identities = account ? [account.address, ...account.aliases] : [];
  const contacts = state.contacts.filter(c => c.email).map(c => ({ email: c.email, label: `${c.name} · ${state.customers.find(row => row.id === c.customerId)?.name || ''}` }));
  const applyTemplate = (value: string) => {
    const t = EMAIL_TEMPLATES.find(row => row.value === value);
    if (!t) { set('template', ''); return; }
    setV(prev => { const quote = prev.body.indexOf('\n\n——— 原邮件'); return { ...prev, template: value, subject: prev.subject || t.subject, body: `${t.body}${account?.signature ? `\n\n--\n${account.signature}` : ''}${quote >= 0 ? prev.body.slice(quote) : ''}` }; });
  };
  const toggleFile = (id: string, on: boolean) => set('fileIds', on ? [...v.fileIds, id] : v.fileIds.filter(row => row !== id));
  const title = initial.id ? '编辑草稿' : v.replyToId ? (v.subject.startsWith('Fwd') ? '转发' : '回复') : '写邮件';
  return <Drawer open onClose={onClose} title={title} sub={account?.displayName} size="lg"
    footer={<div className="mist-col" style={{ gap: 6, width: '100%' }}>
      <div className="mist-row" style={{ flexWrap: 'wrap' }}><span className="mist-spacer" /><Button onClick={onClose}>取消</Button><Button icon={PenLine} disabled={locked || !account} onClick={() => void onSave(v, initial.id)}>保存草稿</Button><Button variant="primary" icon={Send} disabled title={SEND_BLOCKED}>发送</Button></div>
      <span className="mist-note">发送：{SEND_BLOCKED}</span>
    </div>}>
    <FormGrid>
      <Field label="发件邮箱" required><Select aria-label="发件邮箱" value={v.accountId} onChange={event => { const next = state.email.accounts.find(a => a.id === event.target.value); setV(prev => ({ ...prev, accountId: event.target.value, from: next?.address || '' })); }} options={state.email.accounts.map(a => ({ value: a.id, label: `${a.displayName} · ${a.address}` }))} /></Field>
      <Field label="发件身份" required hint="只能使用该邮箱允许的地址或别名"><Select aria-label="发件身份" value={v.from} onChange={event => set('from', event.target.value)} options={identities} /></Field>
      <Field label="收件人" full hint="多个地址用逗号分隔；可从已有联系人中选择"><TextInput aria-label="收件人" list="mist-mail-contacts" value={v.to} onChange={event => set('to', event.target.value)} placeholder="name@example.com" /></Field>
      {showCc ? <>
        <Field label="抄送"><TextInput aria-label="抄送" list="mist-mail-contacts" value={v.cc} onChange={event => set('cc', event.target.value)} /></Field>
        <Field label="密送"><TextInput aria-label="密送" value={v.bcc} onChange={event => set('bcc', event.target.value)} /></Field>
      </> : <div className="mist-mail-cc"><TextLink onClick={() => setShowCc(true)}>添加抄送 / 密送</TextLink></div>}
      <Field label="模板"><Select aria-label="模板" value={v.template} onChange={event => applyTemplate(event.target.value)} placeholder="不使用模板" options={EMAIL_TEMPLATES.map(t => ({ value: t.value, label: t.label }))} /></Field>
      <Field label="主题" full><TextInput aria-label="主题" value={v.subject} onChange={event => set('subject', event.target.value)} /></Field>
      <Field label="正文" full hint="模板中【】处请替换为实际内容；签名取自邮箱账号设置"><TextArea aria-label="正文" rows={12} value={v.body} onChange={event => set('body', event.target.value)} /></Field>
    </FormGrid>
    <datalist id="mist-mail-contacts">{contacts.map(c => <option key={c.email} value={c.email}>{c.label}</option>)}</datalist>
    <div className="mist-col" style={{ gap: 6, marginTop: 16 }}>
      <span className="mist-eyebrow">附件（来自工作空间文件）</span>
      {state.files.length ? <div className="mist-col mist-mail-files">{state.files.slice(0, 30).map(file => <Checkbox key={file.id} checked={v.fileIds.includes(file.id)} onChange={on => toggleFile(file.id, on)} label={file.name} />)}</div> : <span className="mist-note">工作空间还没有文件；请先在业务对象中上传。</span>}
    </div>
    {v.links.length > 0 && <div className="mist-col" style={{ gap: 6, marginTop: 16 }}>
      <span className="mist-eyebrow">关联业务（随原邮件）</span>
      {v.links.map(row => <span key={linkKey(row)} className="mist-sub">{EMAIL_LINK_LABEL[row.kind]} · {emailLinkTarget(state, row)?.label || '对象已不可用'}</span>)}
    </div>}
  </Drawer>;
}

function FollowUpDialog({ message: m, owner: initialOwner, locked, onClose, onSubmit }: { message: EmailMessage; owner: string; locked: boolean; onClose: () => void; onSubmit: (owner: string, due: string, note: string) => Promise<void> }) {
  const [owner, setOwner] = React.useState(initialOwner), [due, setDue] = React.useState(todayIso()), [note, setNote] = React.useState('');
  return <Dialog open onClose={onClose} title="生成跟进" description={`为「${m.subject}」建立待办，同时写入日历。`} icon={CalendarPlus}
    footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={locked || !owner.trim() || !due} onClick={() => void onSubmit(owner.trim(), due, note.trim())}>生成跟进</Button></>}>
    <FormGrid cols={1}>
      <Field label="负责人" required><TextInput aria-label="负责人" value={owner} onChange={event => setOwner(event.target.value)} /></Field>
      <Field label="截止日" required><TextInput aria-label="截止日" type="date" value={due} onChange={event => setDue(event.target.value)} /></Field>
      <Field label="说明"><TextArea aria-label="跟进说明" value={note} onChange={event => setNote(event.target.value)} placeholder="例如：确认三轮样寄出日期" /></Field>
    </FormGrid>
  </Dialog>;
}