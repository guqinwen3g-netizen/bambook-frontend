/** 智能邮箱：三栏收件箱（邮箱与文件夹 / 邮件列表 / 阅读区）。真实邮箱经 IMAP 增量同步、SMTP 发送；发送结果分为已接受 / 失败 / 不确定，不确定时不自动重发。示例邮箱只用合成数据。 */
import React from 'react';
import { AlertTriangle, Archive, ArchiveRestore, CalendarPlus, Download, Forward, Inbox, KeyRound, Link2, Mail, MailOpen, Paperclip, PenLine, Plus, Reply, ReplyAll, RotateCcw, SearchCheck, SearchX, Send, Settings2, Sparkles, Star, Trash2, Unlink, Upload } from 'lucide-react';
import { Banner, Button, Card, Checkbox, DataTable, Dialog, Drawer, Dropdown, EmptyState, Facts, Field, FormGrid, MistPage, PageHeader, Pill, SearchField, Select, TextArea, TextInput, TextLink, Toolbar, useToast, type Column, type Tone } from '../../../../../components/mist';
import type { MistCommand, MistState } from '../../../../../server/src/shared/mistWorkspace';
import { EMAIL_LINK_LABEL, emailAddresses, emailLinkTarget, emailSendEffectiveStatus, emailSendRecipients, emailSendRetryTargets, type EmailRecipientStatus, type EmailAccount, type EmailAccountInput, type EmailDraft, type EmailDraftInput, type EmailLink, type EmailLinkKind, type EmailMessage, type EmailSend, type EmailSendStatus } from '../../../../../server/src/shared/mistEmail';
import { useMistWorkspace, type MistMailAction, type MistMailResult } from '../../runtime/workspace';
import { useMistSession } from '../../runtime/auth';
import { useNav } from '../../nav';
import { Events } from './fulfillmentKit';
import { ActionBar, DetailBlock, DetailBody, ListDetail, shortWhen, todayIso, type ReasonedAction } from './pageKit';

export type MailFolder = 'inbox' | 'drafts' | 'outbox' | 'sent' | 'archive' | 'trash';
export type MailView = 'unread' | 'starred' | 'important' | 'followup' | 'unlinked';
export type MailScope = { kind: 'folder'; value: MailFolder } | { kind: 'view'; value: MailView };
type Row = { kind: 'message'; id: string; message: EmailMessage } | { kind: 'draft'; id: string; draft: EmailDraft } | { kind: 'send'; id: string; send: EmailSend };
type Mail = (action: MistMailAction) => Promise<MistMailResult>;
type Compose = { id?: string; input: EmailDraftInput; forwardOfId?: string };
type PendingSend = { input: EmailDraftInput; requestKey: string; draftId?: string; forwardOfId?: string; source: 'compose' | 'draft' };
type Exec = (command: MistCommand, done?: string) => Promise<unknown>;
const FOLDERS: Array<{ value: MailFolder; label: string; icon: typeof Inbox }> = [
  { value: 'inbox', label: '收件箱', icon: Inbox }, { value: 'drafts', label: '草稿', icon: PenLine }, { value: 'outbox', label: '待发送', icon: Upload },
  { value: 'sent', label: '已发送', icon: Send }, { value: 'archive', label: '已归档', icon: Archive }, { value: 'trash', label: '已删除', icon: Trash2 },
];
const VIEWS: Array<{ value: MailView; label: string }> = [{ value: 'unread', label: '未读' }, { value: 'starred', label: '星标' }, { value: 'important', label: '重要' }, { value: 'followup', label: '待跟进' }, { value: 'unlinked', label: '未关联业务' }];
const FOLDER_FOR_FAILURE: Record<string, MailFolder> = { 收件箱: 'inbox', 已发送: 'sent', 已归档: 'archive', 已删除: 'trash' };
const SEND_STATUS: Record<EmailSendStatus, { label: string; tone: Tone }> = { sending: { label: '发送中', tone: 'accent' }, sent: { label: '已发送', tone: 'ok' }, partial: { label: '部分未接收', tone: 'warn' }, failed: { label: '发送失败', tone: 'bad' }, unknown: { label: '结果不确定', tone: 'warn' } };
const ATTEMPT_LABEL: Record<EmailSend['attempts'][number]['outcome'], string> = { claimed: '开始投递', accepted: '服务器已接受', partial: '部分接受', failed: '明确失败', unknown: '结果不确定', verified: '已在本邮箱找到', copy_found: '本邮箱有副本', not_found: '本邮箱未找到' };
const RECIPIENT_STATUS: Record<EmailRecipientStatus, { label: string; tone: Tone }> = { pending: { label: '投递中', tone: 'accent' }, accepted: { label: '服务器已接受', tone: 'ok' }, rejected: { label: '被拒收', tone: 'bad' }, failed: { label: '未送出', tone: 'bad' }, unknown: { label: '无法确认', tone: 'warn' } };
const ROLE_LABEL = { to: '收件人', cc: '抄送', bcc: '密送' } as const;
const draftRequestKey = (d: EmailDraft) => `draft-${d.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 40)}-${d.updatedAt.replace(/\D/g, '').slice(0, 20)}`.slice(0, 80);
/** 确认弹窗与服务端使用同一地址拆分规则；格式有误时原样列出，由服务端拒绝。 */
const parseAddresses = (value: string) => { try { return emailAddresses(value || '').map(item => item.toLowerCase()); } catch { return (value || '').split(/[,;，；\s]+/).filter(Boolean); } };
const newRequestKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
/** 真实邮箱（非示例、已有服务器设置）；发送还要求已绑定凭据。 */
const isReal = (a?: EmailAccount) => !!a && !a.example && !!a.transport;
export function sendBlocked(a?: EmailAccount): string | false {
  if (!a) return '请选择发件邮箱';
  if (a.example) return '示例邮箱只用于演示，不能发送真实邮件';
  if (!a.transport || !a.credentialSet || a.connection === 'not_connected') return '该邮箱尚未绑定凭据 · 邮箱账号中绑定后可发送';
  return false;
}
export function connectionLabel(a: EmailAccount): { label: string; tone: Tone } {
  if (a.example || a.connection === 'example') return { label: `示例 · 同步于 ${a.lastSyncAt ? when(a.lastSyncAt) : '—'}`, tone: 'neutral' };
  if (!a.credentialSet || a.connection === 'not_connected') return { label: '未绑定凭据', tone: 'neutral' };
  if (a.connection === 'syncing') return { label: '同步中', tone: 'accent' };
  if (a.connection === 'error') return { label: '连接失败', tone: 'bad' };
  if (a.connection === 'partial' || a.failedFolders.length) return { label: '部分文件夹失败', tone: 'warn' };
  return { label: a.lastSyncAt ? `已连接 · 同步于 ${when(a.lastSyncAt)}` : '已连接 · 尚未同步', tone: 'ok' };
}
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
  const { state, run, error, refresh, recover, loading, saving, pending, mail: mailAction, closeMailReview, downloadFile } = useMistWorkspace(), session = useMistSession(), { go, route } = useNav(), toast = useToast();
  const can = session.hasPermission('emails:write'), canAdmin = session.hasPermission('emails:admin'), locked = saving || !!pending;
  const me = session.user?.id != null ? String(session.user.id) : '';
  const email = state?.email || { accounts: [], messages: [], drafts: [], sends: [] };
  const mail: Mail = mailAction || (async () => { throw new Error('邮件收发服务不可用'); });
  const [accountId, setAccountId] = React.useState<string>('all'), [scope, setScope] = React.useState<MailScope>({ kind: 'folder', value: 'inbox' });
  const [query, setQuery] = React.useState(''), [category, setCategory] = React.useState('all');
  const [picked, setPicked] = React.useState<string | null>(route.id || null), [drawer, setDrawer] = React.useState(!!route.id);
  const [compose, setCompose] = React.useState<Compose | null>(null), [followUp, setFollowUp] = React.useState<EmailMessage | null>(null);
  const [failure, setFailure] = React.useState(''), [notice, setNotice] = React.useState<{ tone: Tone; title: string; text: string } | null>(null);
  const [accountsOpen, setAccountsOpen] = React.useState(false), [confirmResend, setConfirmResend] = React.useState<EmailSend | null>(null);
  /** 发送确认：新建 / 回复 / 转发 / 草稿发送都先在这里核对收件人与附件，确认后才投递；取消不发送、不关闭写信、不丢草稿。 */
  const [pendingSend, setPendingSend] = React.useState<PendingSend | null>(null);
  const ready = !!state;
  React.useEffect(() => {
    if (!route.id || !state) return;
    const m = state.email?.messages.find(row => row.id === route.id);
    if (m) { setScope({ kind: 'folder', value: m.folder }); setAccountId('all'); } else if (state.email?.drafts.some(row => row.id === route.id)) setScope({ kind: 'folder', value: 'drafts' });
    else if (state.email?.sends?.some(row => row.id === route.id)) setScope({ kind: 'folder', value: 'outbox' });
    setPicked(route.id); setDrawer(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.id, ready]);
  const accounts = email.accounts, inAccount = (id: string) => accountId === 'all' || id === accountId;
  const messages = email.messages.filter(m => inAccount(m.accountId)), drafts = email.drafts.filter(d => inAccount(d.accountId));
  // 被新发送取代的失败记录只保留在历史中，不在待发送重复出现。
  const outbox = (email.sends || []).filter(row => inAccount(row.accountId) && !row.supersededById && emailSendEffectiveStatus(row) !== 'sent');
  const count = (s: MailScope) => s.kind === 'folder' && s.value === 'drafts' ? drafts.length : s.kind === 'folder' && s.value === 'outbox' ? outbox.length : state ? messages.filter(m => mailMatches(state, m, s)).length : 0;
  const needle = query.trim().toLowerCase();
  const categories = [...new Set(email.messages.map(m => m.category.label).filter(Boolean))];
  const isDrafts = scope.kind === 'folder' && scope.value === 'drafts', isOutbox = scope.kind === 'folder' && scope.value === 'outbox';
  const scoped: Row[] = isDrafts ? drafts.map(d => ({ kind: 'draft' as const, id: d.id, draft: d }))
    : isOutbox ? outbox.map(row => ({ kind: 'send' as const, id: row.id, send: row })) : !state ? [] : messages.filter(m => mailMatches(state, m, scope)).map(m => ({ kind: 'message' as const, id: m.id, message: m }));
  const fileNames = (ids: string[]) => (state?.files || []).filter(file => ids.includes(file.id)).map(file => file.name).join(' ');
  const stamp = (row: Row) => row.kind === 'draft' ? row.draft.updatedAt : row.kind === 'send' ? row.send.updatedAt : row.message.at;
  const rows = scoped.filter(row => {
    if (row.kind === 'send') return !needle || `${row.send.subject} ${row.send.to} ${row.send.cc} ${row.send.body} ${fileNames(row.send.fileIds)}`.toLowerCase().includes(needle);
    if (row.kind === 'draft') return !needle || `${row.draft.subject} ${row.draft.to} ${row.draft.body} ${fileNames(row.draft.fileIds)}`.toLowerCase().includes(needle);
    const m = row.message;
    if (category !== 'all' && (category === 'none' ? !!m.category.label : m.category.label !== category)) return false;
    return !needle || `${m.subject} ${m.from.name} ${m.from.address} ${addressText(m.to)} ${m.body} ${m.attachments.map(item => item.name).join(' ')} ${m.extracted.map(item => item.value).join(' ')}`.toLowerCase().includes(needle);
  }).sort((a, b) => stamp(b).localeCompare(stamp(a)));
  const find = (id: string | null): Row | undefined => {
    if (!id) return undefined;
    const m = email.messages.find(row => row.id === id); if (m) return { kind: 'message', id: m.id, message: m };
    const d = email.drafts.find(row => row.id === id); if (d) return { kind: 'draft', id: d.id, draft: d };
    const sent = (email.sends || []).find(row => row.id === id); return sent ? { kind: 'send', id: sent.id, send: sent } : undefined;
  };
  const selected = rows.find(row => row.id === picked) || find(picked);
  const exec: Exec = async (command, done) => { setFailure(''); try { const receipt = await run(command); if (done) toast(done); return receipt; } catch (problem) { setFailure(problemText(problem, '操作未保存，请重试')); return null; } };
  const pick = (row: Row) => {
    setPicked(row.id); setDrawer(true); go('emails', row.id);
    if (row.kind === 'message' && !row.message.read && can && !locked) void exec({ type: 'email.flag', payload: { id: row.id, flag: 'read', value: true } });
  };
  const changeScope = (next: MailScope) => { setScope(next); setPicked(null); setDrawer(false); setCategory('all'); };
  const changeAccount = (id: string) => { setAccountId(id); setPicked(null); setDrawer(false); };
  /** 调用收发服务：服务端错误原样提示；返回结果供调用方区分已发送 / 失败 / 不确定。 */
  const callMail = async (action: MistMailAction): Promise<MistMailResult | null> => { setFailure(''); try { return await mail(action); } catch (problem) { setFailure(problemText(problem, '操作未完成，请重试')); return null; } };
  const reportSend = (result: MistMailResult | null, again = false) => {
    const sent = result?.send; if (!sent) return false;
    if (sent.replayed && sent.recoveredFor && sent.status === 'sent') {
      setNotice({ tone: 'neutral', title: '已有发送记录，未重复投递', text: '服务端确认这次发送请求对应原发送记录（已发送），没有再次投递。已打开原记录。' });
      openSend(sent.id); return true;
    }
    if (sent.replayed && sent.status !== 'sent') {
      setNotice({ tone: 'warn', title: '已有发送记录，未重复投递', text: sent.recovered
        ? '这封邮件（同一草稿或相同内容）上次的发送还没有确定结果，已回到原发送记录，没有再次投递。请在待发送中核对或处理原记录。'
        : '这次发送此前已登记，已回到原发送记录，没有再次投递。请在待发送中查看结果。' });
      openSend(sent.id); return true;
    }
    if (sent.status === 'sent') { setNotice(null); toast(sent.replayed ? '该邮件此前已发送，未重复投递' : again ? '已核对：邮件已在本邮箱中找到' : '邮件已发送：发信服务器已接受全部收件人'); return true; }
    const missing = (sent.recipients || []).filter(item => item.status !== 'accepted').map(item => item.address);
    if (sent.status === 'partial') setNotice({ tone: 'warn', title: '部分收件人未被接收', text: `发信服务器接受了其余收件人，${missing.length ? `以下收件人未被接收：${missing.join('、')}` : '部分收件人被拒'}。已接受的收件人不会再收到第二封；可在待发送中查看拒收原因，修正后仅对未接收的收件人重发。` });
    else if (sent.status === 'failed') setNotice({ tone: 'bad', title: '发送失败', text: `${sent.message || '服务器拒绝了这封邮件'}。邮件保留在待发送，可修正后重发。` });
    else if (sent.status === 'unknown') setNotice(again && sent.found && !(sent.foundIn || []).includes('inbox')
      ? { tone: 'warn', title: '只在已发送 / 归档中找到副本', text: '这封邮件只出现在本邮箱的已发送或归档中（可能是发件时保存的副本），不能证明任何收件人已收到。系统不会自动重发；请向收件人确认后再决定是否重发。' }
      : again && sent.found
      ? { tone: 'warn', title: '本邮箱有副本，其他收件人仍无法确认', text: '在本邮箱中找到了这封邮件，但这只能说明本邮箱收到，不能证明其他收件人收到。系统不会自动重发；请向收件人确认后再决定是否重发。' }
      : again
      ? { tone: 'warn', title: '仍无法确认是否送达', text: '本邮箱的收件箱、已发送和归档中都没有找到这封邮件。系统不会自动重发；请向收件人确认未收到后，再选择“确认未送达后重发”。' }
      : { tone: 'warn', title: '发送结果不确定', text: `${sent.message || '连接在投递过程中中断'}。系统不会自动重发；请在待发送中核对，确认未送达后再重发。` });
    else setNotice({ tone: 'neutral', title: '正在发送', text: '这封邮件正在投递，稍后在待发送或已发送中查看结果。' });
    return true;
  };
  // 不改路由：页面按路由重建，改路由会丢掉刚给出的“未重复投递”说明。
  const openSend = (id: string) => { setScope({ kind: 'folder', value: 'outbox' }); setCategory('all'); setPicked(id); setDrawer(true); };
  const sendInput = async (input: EmailDraftInput, requestKey: string, draftId?: string, forwardOfId?: string) => {
    const result = await callMail({ kind: 'send', requestKey, ...(draftId ? { draftId } : {}), input: input as unknown as Record<string, unknown>, ...(forwardOfId ? { forwardOfId } : {}) });
    if (!result) return null;
    reportSend(result);
    if (result.send?.status !== 'sent' && !result.send?.replayed) changeScope({ kind: 'folder', value: 'outbox' });
    return result;
  };
  /** 上次发送未收到回执时，写信抽屉保持打开；核对出结果后再关闭对应写信。 */
  const unsettledCompose = React.useRef<string | null>(null);
  const confirmSend = async () => {
    const p = pendingSend; if (!p) return;
    const result = await sendInput(p.input, p.requestKey, p.draftId, p.forwardOfId);
    setPendingSend(null);
    if (!result && p.source === 'compose') unsettledCompose.current = p.requestKey;
    // 服务端拒绝（如意图冲突）时保留写信内容与草稿，便于修改后再发。
    if (!result) return;
    if (p.source === 'compose') setCompose(null);
    else if (!result.send?.replayed) { setPicked(null); setDrawer(false); }
  };
  /** 草稿发送的请求编号由草稿与其最后修改时间确定：刷新或重开后再点发送仍是同一发送意图，不会另建发送记录。 */
  const sendDraft = (d: EmailDraft) => {
    const { id, createdAt: _c, updatedAt: _u, updatedBy: _b, ...input } = d;
    setPendingSend({ input, requestKey: draftRequestKey(d), draftId: id, source: 'draft' });
  };
  /** 丢失回执的发送意图：用本机保存的原 requestKey 与原内容核对；服务端已登记只回原记录，不重复投递。 */
  const mailPending = pending?.kind === 'mail-send' && pending.mail ? pending.mail : null;
  const checkPendingSend = async () => {
    const key = mailPending?.requestKey; setFailure('');
    try {
      const receipt = await recover(); const sent = (receipt?.result as { send?: NonNullable<MistMailResult['send']> } | undefined)?.send;
      if (!sent) return;
      if (key && unsettledCompose.current === key) { unsettledCompose.current = null; setCompose(null); }
      reportSend({ send: sent });
      if (sent.status !== 'sent' && !sent.replayed) openSend(sent.id);
    } catch (problem) { setFailure(problemText(problem, '发送结果仍待核对，请稍后再试')); }
  };
  /** 待人工核对的发送：只关闭本机记录，不发送；关闭前由本人在已发送 / 待发送中核对。 */
  const closeReview = async () => { setFailure(''); try { await closeMailReview?.(); toast('已关闭待人工核对记录，未发送任何邮件'); } catch (problem) { setFailure(problemText(problem, '记录未关闭，请重试')); } };
  const retrySend = async (row: EmailSend, confirmUnknown = false) => { const result = await callMail({ kind: 'retry', sendId: row.id, ...(confirmUnknown ? { confirmUnknown: true } : {}) }); if (result) reportSend(result); setConfirmResend(null); };
  const verifySend = async (row: EmailSend) => { const result = await callMail({ kind: 'verify', sendId: row.id }); if (result) reportSend(result, true); };
  const syncable = accounts.filter(a => isReal(a) && a.credentialSet && a.connection !== 'not_connected' && inAccount(a.id));
  const syncNow = async () => {
    setNotice(null); const problems: string[] = []; let remaining = 0;
    for (const a of syncable) {
      const result = await callMail({ kind: 'sync', accountId: a.id }); if (!result) return;
      if (result.sync?.error || result.sync?.failedFolders?.length) problems.push(`${a.displayName}：${result.sync.error || `${result.sync.failedFolders!.join('、')}未能同步`}`);
      remaining += Number(result.sync?.remaining || 0);
    }
    if (problems.length) setNotice({ tone: 'warn', title: '部分邮箱未完成同步', text: problems.join('；') });
    else toast(remaining ? `已同步一批，还有约 ${remaining} 封待同步，可再次同步` : '同步完成');
  };
  const downloadAttachment = async (fileId: string) => { const file = state?.files.find(row => row.id === fileId); if (!file) { setFailure('附件文件不可用，请重新同步'); return; } setFailure(''); try { await downloadFile(file); } catch (problem) { setFailure(problemText(problem, '附件下载失败，请重试')); } };
  const blankInput = (account?: EmailAccount): EmailDraftInput => ({ accountId: account?.id || '', from: account?.address || '', to: '', cc: '', bcc: '', subject: '', body: account?.signature ? `\n\n--\n${account.signature}` : '', template: '', links: [], fileIds: [] });
  const defaultAccount = accounts.find(a => a.id === accountId) || accounts.find(a => a.kind === 'personal') || accounts[0];
  const respond = (m: EmailMessage, mode: 'reply' | 'all' | 'forward') => {
    const account = accounts.find(a => a.id === m.accountId) || defaultAccount;
    const mine = new Set([account?.address || '', ...(account?.aliases || [])].filter(Boolean).map(value => value.toLowerCase()));
    const others = [...m.to, ...m.cc].map(row => row.address).filter(address => !mine.has(address.toLowerCase()) && address !== m.from.address);
    const quoted = `\n\n--\n${account?.signature || ''}\n\n——— 原邮件 ———\n发件人：${addressText([m.from])}\n时间：${when(m.at)}\n主题：${m.subject}\n\n${m.body}`;
    const to = mode === 'forward' ? '' : m.folder === 'sent' ? m.to.map(row => row.address).join(', ') : m.from.address;
    const forwarded = mode === 'forward' ? m.attachments.map(file => file.fileId).filter((id): id is string => !!id && !!state?.files.some(row => row.id === id)) : [];
    const base = { ...blankInput(account), to, cc: mode === 'all' ? others.join(', ') : '', subject: `${mode === 'forward' ? 'Fwd' : 'Re'}: ${m.subject.replace(/^(Re|Fwd):\s*/i, '')}`, body: quoted, links: m.links, fileIds: forwarded };
    setCompose(mode === 'forward' ? { input: base, forwardOfId: m.id } : { input: { ...base, replyToId: m.id } });
  };
  const failedAccounts = accounts.filter(a => a.failedFolders.length && inAccount(a.id));
  const scopeLabel = scope.kind === 'folder' ? FOLDERS.find(f => f.value === scope.value)!.label : VIEWS.find(v => v.value === scope.value)!.label;
  const scopeFailed = scope.kind === 'folder' && failedAccounts.some(a => a.failedFolders.some(name => FOLDER_FOR_FAILURE[name] === scope.value));
  const toAccounts = () => setAccountsOpen(true);

  const columns: Column<Row>[] = [
    { key: 'from', header: scope.kind === 'folder' && (scope.value === 'sent' || isDrafts || isOutbox) ? '收件人' : '发件人', width: 'minmax(130px,1fr)', hideOnMobile: true, render: row => {
      if (row.kind === 'send') return <div className="mist-col" style={{ gap: 2 }}><span>{row.send.to || row.send.cc || '密送收件人'}</span><small className="mist-muted">{row.send.from}</small></div>;
      if (row.kind === 'draft') return <div className="mist-col" style={{ gap: 2 }}><span>{row.draft.to || '未填写收件人'}</span><small className="mist-muted">草稿 · {row.draft.from}</small></div>;
      const m = row.message, name = m.folder === 'sent' ? addressText(m.to) : m.from.name || m.from.address;
      return <div className="mist-col" style={{ gap: 2 }}><span className="mist-mail-strong" data-unread={!m.read || undefined}>{name}</span><small className="mist-muted">{accounts.find(a => a.id === m.accountId)?.kind === 'shared' ? '共享邮箱' : '个人邮箱'}</small></div>;
    } },
    { key: 'subject', header: '主题', width: 'minmax(200px,2.4fr)', render: row => {
      if (row.kind === 'draft') return <div className="mist-col" style={{ gap: 2 }}><span>{row.draft.subject || '（无主题）'}</span><small className="mist-muted mist-mail-snippet">{row.draft.body.trim().split('\n')[0] || '正文为空'}</small></div>;
      if (row.kind === 'send') { const status = SEND_STATUS[emailSendEffectiveStatus(row.send)]; return <div className="mist-col" style={{ gap: 3 }}><span>{row.send.subject}</span><span className="mist-row" style={{ gap: 4 }}><Pill tone={status.tone}>{status.label}</Pill><small className="mist-muted mist-mail-snippet">{row.send.attempts[row.send.attempts.length - 1]?.message || ''}</small></span></div>; }
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
  const nav = <Card as="nav" className="mist-mail-nav" aria-label="邮箱与文件夹" data-mist-scroll="x">
    <div className="mist-mail-navgroup">
      <span className="mist-eyebrow">邮箱</span>
      {navItem('all', accountId === 'all', () => changeAccount('all'), <Mail size={15} />, '全部邮箱', email.messages.filter(m => m.folder === 'inbox' && !m.read).length)}
      {accounts.map(a => { const c = connectionLabel(a); return navItem(a.id, accountId === a.id, () => changeAccount(a.id), <span className="mist-mail-dot" data-tone={c.tone} />,
        <span className="mist-col" style={{ gap: 0, minWidth: 0 }}><span className="mist-mail-ellipsis">{a.displayName}</span><small className="mist-muted mist-mail-ellipsis">{c.label}</small></span>, undefined, a.address); })}
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
    ? <EmptyState icon={Upload} title="没有待发送邮件" description="发送失败或结果不确定的邮件会停留在这里，供核对与重发。" />
    : scoped.length ? <EmptyState icon={SearchX} title="没有符合条件的邮件" description="换个关键词或清除分类筛选。" action={<Button onClick={() => { setQuery(''); setCategory('all'); }}>清除筛选</Button>} />
    : <EmptyState icon={isDrafts ? PenLine : Inbox} title={`${scopeLabel}为空`} description={isDrafts ? '写邮件后保存草稿，会出现在这里。' : '当前邮箱在这里没有邮件。'} />;
  const editDraft = (d: EmailDraft) => { const { id, createdAt: _c, updatedAt: _u, updatedBy: _b, ...input } = d; setCompose({ id, input }); };
  const deleteDraft = async (id: string) => { if (await exec({ type: 'email.draft.delete', payload: { id } }, '草稿已删除')) { setPicked(null); setDrawer(false); } };
  const detail = selected && state
    ? selected.kind === 'draft'
      ? <DraftDetail draft={selected.draft} state={state} can={can} locked={locked} onEdit={() => editDraft(selected.draft)} onDelete={() => void deleteDraft(selected.id)} onSend={() => sendDraft(selected.draft)} />
      : selected.kind === 'send'
        ? <SendDetail send={selected.send} state={state} can={can} me={me} locked={locked} onRetry={row => void retrySend(row)} onVerify={row => void verifySend(row)} onConfirmResend={setConfirmResend} />
        : <MessageDetail message={selected.message} state={state} can={can} locked={locked} exec={exec} onOpen={(view, id) => go(view, id)} onRespond={mode => respond(selected.message, mode)} onFollowUp={() => setFollowUp(selected.message)} onDownload={id => void downloadAttachment(id)} />
    : <EmptyState icon={MailOpen} title="阅读邮件" description={loading ? '正在读取邮箱' : '从列表选择一封邮件，查看正文、附件、业务关联与跟进'} compact />;
  const sendCompose = async (input: EmailDraftInput, requestKey: string) => { if (compose) setPendingSend({ input, requestKey, ...(compose.id ? { draftId: compose.id } : {}), ...(compose.forwardOfId ? { forwardOfId: compose.forwardOfId } : {}), source: 'compose' }); };
  const saveDraft = async (input: EmailDraftInput, id?: string) => { const receipt = await exec({ type: 'email.draft.save', payload: { ...(id ? { id } : {}), input } }, '草稿已保存'); if (receipt) setCompose(null); };
  const createFollowUp = async (owner: string, due: string, note: string) => { if (followUp && await exec({ type: 'email.followUp', payload: { id: followUp.id, owner, due, note } }, '已生成跟进待办，并写入日历')) setFollowUp(null); };

  return <MistPage width="wide">
    <PageHeader eyebrow="我的事务" title="智能邮箱" description="个人与共享邮箱的真实收发；可标记、关联客户 / 开发案 / 订单 / 发票，生成跟进待办，并把抽取资料提交给业务对象复核。"
      actions={<>
        <Button icon={RotateCcw} disabled={!can || locked || !syncable.length} title={!syncable.length ? '没有已绑定凭据的真实邮箱可同步' : undefined} onClick={() => void syncNow()}>同步</Button>
        <Button icon={Settings2} onClick={toAccounts}>邮箱账号</Button>
        {can && <Button variant="primary" icon={PenLine} disabled={!accounts.length || locked} title={accounts.length ? undefined : '尚未接入任何邮箱'} onClick={() => setCompose({ input: blankInput(defaultAccount) })}>写邮件</Button>}
      </>} />
    {!can && <div className="mist-section"><Banner tone="neutral" title="只读查看">你的账号没有邮件编辑权限，可以阅读邮件与业务关联，不能标记、关联、跟进或写邮件。</Banner></div>}
    {error && <div className="mist-section"><Banner tone="bad" title="邮箱未读取" actions={<Button onClick={() => void refresh()}>重试</Button>}>{error}</Banner></div>}
    {mailPending?.review && <div className="mist-section"><Banner tone="bad" icon={AlertTriangle} title={`发送「${String(mailPending.input.subject || '（无主题）')}」待人工核对`} actions={<Button size="sm" loading={saving} disabled={saving || !closeMailReview} onClick={() => void closeReview()}>已人工核对，关闭记录</Button>}>
      {mailPending.review}。这次发送不会被算作已发送，系统也不会再自动核对或重发。请在待发送 / 已发送中按发件账号、主题与收件人核对这封邮件；关闭记录不会发送任何邮件。
    </Banner></div>}
    {mailPending && !mailPending.review && <div className="mist-section"><Banner tone="warn" icon={AlertTriangle} title={`上次发送「${String(mailPending.input.subject || '（无主题）')}」未收到服务器回执`} actions={<Button size="sm" variant="primary" loading={saving} disabled={saving} onClick={() => void checkPendingSend()}>核对发送结果</Button>}>
      收件人：{[mailPending.input.to, mailPending.input.cc, mailPending.input.bcc].map(value => String(value || '').trim()).filter(Boolean).join('；') || '未填写'}。邮件可能已发出，也可能没有到达服务器。核对时使用原发送请求：已登记的只显示原记录、不会重复投递；服务器从未收到时才按原内容发送一次。核对完成前不能发起其他邮件操作。
    </Banner></div>}
    {failure && <div className="mist-section"><Banner tone="bad" title="操作未完成">{failure}</Banner></div>}
    {notice && <div className="mist-section"><Banner tone={notice.tone} title={notice.title} actions={<Button size="sm" onClick={() => setNotice(null)}>知道了</Button>}>{notice.text}</Banner></div>}
    {!loading && state && !accounts.length
      ? <Card><EmptyState icon={Mail} title="未接入任何邮箱" description="在邮箱账号中接入个人邮箱（共享邮箱需邮件账户管理权限）并绑定凭据后，同步的邮件会出现在这里。本空间目前没有邮件数据。" action={<Button icon={Settings2} onClick={toAccounts}>打开邮箱账号</Button>} /></Card>
      : <>
        {accounts.some(a => a.example) && <p className="mist-note mist-section">示例邮箱：邮件为示例空间的合成数据，不连接邮件服务器、不能发送；标记、关联、跟进与草稿会真实保存到工作空间。</p>}
        {failedAccounts.length > 0 && <div className="mist-section"><Banner tone="warn" icon={AlertTriangle} title={scopeFailed ? `${scopeLabel}同步失败` : '部分文件夹同步失败'}>{failedAccounts.map(a => `${a.displayName}：${a.failedFolders.join('、')}未能同步，显示的是上次同步结果`).join('；')}。</Banner></div>}
        <div className="mist-mail">
          {nav}
          <div className="mist-col" style={{ gap: 12, minWidth: 0 }}>
            <Toolbar>
              <SearchField value={query} onChange={setQuery} placeholder="搜索主题、发件人、正文、附件名或抽取资料" />
              {!isDrafts && <Dropdown<string> label="分类" value={category} onChange={setCategory} options={[{ value: 'all', label: '全部分类' }, ...categories.map(value => ({ value, label: value })), { value: 'none', label: '未分类' }]} />}
            </Toolbar>
            <ListDetail drawerOpen={drawer && !!selected} onDrawerClose={() => setDrawer(false)}
              drawerTitle={selected ? (selected.kind === 'draft' ? selected.draft.subject || '（无主题草稿）' : selected.kind === 'send' ? selected.send.subject : selected.message.subject) : '邮件'}
              drawerSub={selected?.kind === 'message' ? addressText([selected.message.from]) : selected?.kind === 'send' ? '待发送' : selected ? '草稿' : undefined}
              list={<Card><DataTable ariaLabel={`${scopeLabel}邮件`} loading={loading} rows={rows} rowKey={row => row.id} selectedKey={selected?.id} density="comfy" onRowClick={pick} columns={columns} empty={emptyList} /></Card>}
              detail={detail} />
          </div>
        </div>
      </>}
    {compose && state && <ComposeDrawer key={compose.id || 'new'} state={state} initial={compose} locked={locked} onClose={() => setCompose(null)} onSave={saveDraft} onSend={sendCompose} />}
    {accountsOpen && state && <AccountsDrawer state={state} me={me} can={can} canAdmin={canAdmin} locked={locked} run={run} mail={mail} onClose={() => setAccountsOpen(false)} />}
    {confirmResend && <Dialog open onClose={() => setConfirmResend(null)} title="确认未送达后重发" icon={AlertTriangle} tone="warn" description={`「${confirmResend.subject}」上次发送结果不确定。`}
      footer={<><Button onClick={() => setConfirmResend(null)}>取消</Button><Button variant="primary" disabled={locked} onClick={() => void retrySend(confirmResend, true)}>确认未送达，重新发送</Button></>}>
      <p className="mist-sub">请先点“核对”在本邮箱的已发送中查找，或向收件人确认未收到。只会发给尚未被服务器接受的收件人（{emailSendRetryTargets(confirmResend).map(item => item.address).join('、')}）；若对方其实已收到，会收到两封相同邮件。</p>
    </Dialog>}
    {pendingSend && state && <SendConfirmDialog pending={pendingSend} state={state} locked={locked} onCancel={() => setPendingSend(null)} onConfirm={() => void confirmSend()} />}
    {followUp && <FollowUpDialog message={followUp} owner={session.user?.displayName || state?.settings.profileName || ''} locked={locked} onClose={() => setFollowUp(null)} onSubmit={createFollowUp} />}
  </MistPage>;
}

function MessageDetail({ message: m, state, can, locked, exec, onOpen, onRespond, onFollowUp, onDownload }: {
  message: EmailMessage; state: MistState; can: boolean; locked: boolean; exec: Exec; onOpen: (view: string, id: string) => void; onRespond: (mode: 'reply' | 'all' | 'forward') => void; onFollowUp: () => void; onDownload: (fileId: string) => void;
}) {
  const record = m.sendId ? (state.email.sends || []).find(row => row.id === m.sendId) : undefined;
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
    {m.folder === 'sent' && <Banner tone={record ? (emailSendEffectiveStatus(record) === 'sent' ? 'ok' : 'warn') : 'neutral'} title="发送记录">{m.example ? '示例已发送邮件，没有真实投递或回执记录。'
      : record && emailSendEffectiveStatus(record) !== 'sent' ? sentPartialText(record)
      : record ? `${record.createdBy} 于 ${when(record.updatedAt)} 发送，发件服务器已接受全部收件人${record.response ? `（${record.response}）` : ''}。“已接受”表示发件服务器收下，不代表对方最终收到或已阅读。`
      : '从邮箱服务器的已发送文件夹同步，不是经本系统发出，没有投递回执。'}</Banner>}
    <div className="mist-mail-body">{m.body}</div>
    {m.attachments.length > 0 && <DetailBlock title={`附件（${m.attachments.length}）`}>
      {m.attachments.map(file => { const stored = !!file.fileId && state.files.some(row => row.id === file.fileId);
        return <div key={file.id} className="mist-row mist-mail-attachment"><Paperclip size={14} /><span className="mist-mail-ellipsis">{file.name}</span><small className="mist-muted">{sizeText(file.size)}</small><span className="mist-spacer" />
          <Button size="sm" icon={Download} disabled={!stored} title={stored ? undefined : m.example ? '示例附件没有文件内容' : file.omitted || '附件内容未保存，请重新同步'} onClick={() => stored && onDownload(file.fileId!)}>下载</Button></div>; })}
      {m.example ? <span className="mist-note">示例附件无文件，不能下载。</span> : m.attachments.filter(file => file.omitted).map(file => <span key={file.id} className="mist-note">{file.name}：{file.omitted}</span>)}
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

function DraftDetail({ draft: d, state, can, locked, onEdit, onDelete, onSend }: { draft: EmailDraft; state: MistState; can: boolean; locked: boolean; onEdit: () => void; onDelete: () => void; onSend: () => void }) {
  const account = state.email.accounts.find(a => a.id === d.accountId), noWrite = can ? false : '需要邮件编辑权限', blocked = sendBlocked(account);
  return <DetailBody data-email-draft={d.id} heading={<div><span className="mist-mono mist-muted">草稿 · {account?.displayName || '邮箱不可用'}</span><div className="mist-h2" style={{ fontSize: 19, marginTop: 4 }}>{d.subject || '（无主题）'}</div></div>}>
    <ActionBar busy={locked} actions={[
      { label: '继续编辑', icon: PenLine, onClick: onEdit, primary: true, reason: noWrite },
      { label: '发送', icon: Send, onClick: onSend, reason: noWrite || blocked || (!d.to.trim() && !d.cc.trim() && !d.bcc.trim() ? '请先填写收件人' : false) },
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

/** 已发送副本如实说明：只有部分收件人被服务器接受时，列出未接收者并指向待发送。 */
function sentPartialText(record: EmailSend) {
  const rows = emailSendRecipients(record), ok = rows.filter(item => item.status === 'accepted').map(item => item.address), open = rows.filter(item => item.status !== 'accepted');
  return `${record.createdBy} 于 ${when(record.updatedAt)} 发送。发件服务器已接受：${ok.join('、') || '无'}；未接收或无法确认：${open.map(item => `${item.address}（${RECIPIENT_STATUS[item.status].label}）`).join('、')}。未接收的收件人可在待发送中处理。`;
}

function SendDetail({ send: row, state, can, me, locked, onRetry, onVerify, onConfirmResend }: { send: EmailSend; state: MistState; can: boolean; me: string; locked: boolean; onRetry: (row: EmailSend) => void; onVerify: (row: EmailSend) => void; onConfirmResend: (row: EmailSend) => void }) {
  const account = state.email.accounts.find(a => a.id === row.accountId), status = emailSendEffectiveStatus(row), tone = SEND_STATUS[status];
  const recipients = emailSendRecipients(row), accepted = recipients.filter(item => item.status === 'accepted'), open = recipients.filter(item => item.status !== 'accepted');
  const mine = !me || row.createdById === me, noWrite = !can ? '需要邮件编辑权限' : !mine ? '只有发起人可以重发或核对' : false;
  const actions: ReasonedAction[] = [
    { label: '重发', icon: Send, onClick: () => onRetry(row), primary: true, reason: noWrite, hidden: status !== 'failed' },
    { label: '仅重发未接收的收件人', icon: Send, onClick: () => onRetry(row), primary: true, reason: noWrite, hidden: status !== 'partial' },
    { label: '核对是否已发出', icon: SearchCheck, onClick: () => onVerify(row), primary: true, reason: noWrite, hidden: status !== 'unknown' },
    { label: '确认未送达后重发', icon: RotateCcw, onClick: () => onConfirmResend(row), reason: noWrite, hidden: status !== 'unknown' },
  ];
  return <DetailBody data-email-send={row.id} heading={<div><span className="mist-mono mist-muted">待发送 · {account?.displayName || '邮箱不可用'}</span><div className="mist-h2" style={{ fontSize: 19, marginTop: 4 }}>{row.subject}</div></div>}>
    <div className="mist-row"><Pill tone={tone.tone}>{tone.label}</Pill></div>
    {status !== 'sending' && <ActionBar busy={locked} actions={actions} />}
    {status === 'unknown' && <Banner tone="warn" title="不会自动重发">投递过程中连接中断或没有收到服务器的明确答复，对方可能已经收到。可先核对本邮箱的已发送；仍不确定时请向收件人确认后再重发。</Banner>}
    {status === 'partial' && <Banner tone="warn" title="部分收件人未被接收">发信服务器接受了 {accepted.length} 位收件人，{open.length} 位被拒或未送出。重发只发给未接收的收件人，已接受的不会再收到第二封。“已接受”表示发信服务器收下，不代表对方最终收到或阅读。</Banner>}
    {status === 'failed' && <Banner tone="bad" title="服务器明确拒绝或未能连接">{row.response || row.attempts[row.attempts.length - 1]?.message || '发送失败'}。修正邮箱设置或收件人后可重发。</Banner>}
    {status === 'sending' && <Banner tone="neutral" title="正在发送">稍后刷新查看结果；超过 5 分钟仍无结果会转为“结果不确定”。</Banner>}
    <Facts items={[{ label: '发件身份', value: row.from }, { label: '发起人', value: `${row.createdBy} · ${when(row.createdAt)}` }]} />
    <DetailBlock title={`收件人结果（${recipients.length}）`}>{recipients.map(item => <div key={item.address} className="mist-row" data-recipient={item.address} style={{ flexWrap: 'wrap' }}><Pill tone={RECIPIENT_STATUS[item.status].tone}>{RECIPIENT_STATUS[item.status].label}</Pill><span className="mist-sub">{item.address}</span><small className="mist-muted">{ROLE_LABEL[item.role]}</small>{item.reply && <small className="mist-muted" style={{ flexBasis: '100%', overflowWrap: 'anywhere' }}>{item.reply}</small>}</div>)}</DetailBlock>
    <div className="mist-mail-body">{row.body || '正文为空'}</div>
    {row.fileIds.length > 0 && <DetailBlock title={`附件（${row.fileIds.length}）`}>{row.fileIds.map(id => <span key={id} className="mist-sub mist-row" style={{ gap: 4 }}><Paperclip size={12} />{state.files.find(file => file.id === id)?.name || '文件不可用'}</span>)}</DetailBlock>}
    <DetailBlock title="投递记录">{row.attempts.map((attempt, index) => <div key={index} className="mist-row" style={{ flexWrap: 'wrap' }}><Pill tone={attempt.outcome === 'accepted' || attempt.outcome === 'verified' ? 'ok' : attempt.outcome === 'failed' ? 'bad' : attempt.outcome === 'unknown' || attempt.outcome === 'not_found' || attempt.outcome === 'partial' || attempt.outcome === 'copy_found' ? 'warn' : 'neutral'}>{ATTEMPT_LABEL[attempt.outcome]}</Pill><span className="mist-sub">{attempt.message}</span><span className="mist-spacer" /><small className="mist-muted">{attempt.actor} · {when(attempt.at)}</small></div>)}</DetailBlock>
  </DetailBody>;
}

function ComposeDrawer({ state, initial, locked, onClose, onSave, onSend }: { state: MistState; initial: Compose; locked: boolean; onClose: () => void; onSave: (input: EmailDraftInput, id?: string) => Promise<void>; onSend: (input: EmailDraftInput, requestKey: string) => Promise<void> }) {
  const [v, setV] = React.useState<EmailDraftInput>(initial.input), [showCc, setShowCc] = React.useState(!!(initial.input.cc || initial.input.bcc));
  /** 同一次编辑的发送请求编号保持不变：网络中断后再点发送，服务端按编号识别为同一封，不会重复投递。 */
  const [requestKey] = React.useState(newRequestKey);
  const set = <K extends keyof EmailDraftInput>(key: K, value: EmailDraftInput[K]) => setV(prev => ({ ...prev, [key]: value }));
  const account = state.email.accounts.find(a => a.id === v.accountId), identities = account ? [account.address, ...account.aliases] : [];
  const contacts = state.contacts.filter(c => c.email).map(c => ({ email: c.email, label: `${c.name} · ${state.customers.find(row => row.id === c.customerId)?.name || ''}` }));
  const applyTemplate = (value: string) => {
    const t = EMAIL_TEMPLATES.find(row => row.value === value);
    if (!t) { set('template', ''); return; }
    setV(prev => { const quote = prev.body.indexOf('\n\n——— 原邮件'); return { ...prev, template: value, subject: prev.subject || t.subject, body: `${t.body}${account?.signature ? `\n\n--\n${account.signature}` : ''}${quote >= 0 ? prev.body.slice(quote) : ''}` }; });
  };
  const toggleFile = (id: string, on: boolean) => set('fileIds', on ? [...v.fileIds, id] : v.fileIds.filter(row => row !== id));
  const title = initial.id ? '编辑草稿' : initial.forwardOfId ? '转发' : v.replyToId ? '回复' : '写邮件';
  const blocked = sendBlocked(account) || (!v.to.trim() && !v.cc.trim() && !v.bcc.trim() ? '请填写收件人' : false);
  const files = [...state.files.filter(file => v.fileIds.includes(file.id)), ...state.files.filter(file => !v.fileIds.includes(file.id)).slice(0, 30)];
  return <Drawer open onClose={onClose} title={title} sub={account?.displayName} size="lg"
    footer={<div className="mist-col" style={{ gap: 6, width: '100%' }}>
      <div className="mist-row" style={{ flexWrap: 'wrap' }}><span className="mist-spacer" /><Button onClick={onClose}>取消</Button><Button icon={PenLine} disabled={locked || !account} onClick={() => void onSave(v, initial.id)}>保存草稿</Button><Button variant="primary" icon={Send} disabled={locked || !!blocked} title={blocked || undefined} onClick={() => void onSend(v, requestKey)}>发送</Button></div>
      <span className="mist-note">{blocked ? `发送：${blocked}` : '发送后由发件服务器投递；结果不确定时会留在待发送，不会自动重发。'}</span>
    </div>}>
    <FormGrid>
      <Field label="发件邮箱" required><Select aria-label="发件邮箱" value={v.accountId} onChange={event => { const next = state.email.accounts.find(a => a.id === event.target.value); setV(prev => ({ ...prev, accountId: event.target.value, from: next?.address || '' })); }} options={state.email.accounts.map(a => ({ value: a.id, label: `${a.displayName} · ${a.address}` }))} /></Field>
      <Field label="发件身份" required hint="只能使用该邮箱允许的地址或别名"><Select aria-label="发件身份" value={v.from} onChange={event => set('from', event.target.value)} options={identities} /></Field>
      <Field label="收件人" full hint="多个地址用逗号、分号或空格分隔；可从已有联系人中选择"><TextInput aria-label="收件人" list="mist-mail-contacts" value={v.to} onChange={event => set('to', event.target.value)} placeholder="name@example.com" /></Field>
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
      {files.length ? <div className="mist-col mist-mail-files">{files.map(file => <Checkbox key={file.id} checked={v.fileIds.includes(file.id)} onChange={on => toggleFile(file.id, on)} label={file.name} />)}</div> : <span className="mist-note">工作空间还没有文件；请先在业务对象中上传。</span>}
    </div>
    {v.links.length > 0 && <div className="mist-col" style={{ gap: 6, marginTop: 16 }}>
      <span className="mist-eyebrow">关联业务（随原邮件）</span>
      {v.links.map(row => <span key={linkKey(row)} className="mist-sub">{EMAIL_LINK_LABEL[row.kind]} · {emailLinkTarget(state, row)?.label || '对象已不可用'}</span>)}
    </div>}
  </Drawer>;
}

const PORT_ROW: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(64px, 96px) minmax(0, 1fr)', gap: 8, minWidth: 0 };
type AccountForm = EmailAccountInput & { password: string; aliasText: string };
const blankAccount = (): AccountForm => ({ address: '', displayName: '', kind: 'personal', memberIds: [], aliases: [], aliasText: '', signature: '', password: '', transport: { imapHost: '', imapPort: 993, imapSecure: true, smtpHost: '', smtpPort: 587, smtpSecure: false, username: '' } });
const accountForm = (a: EmailAccount): AccountForm => ({ address: a.address, displayName: a.displayName, kind: a.kind, memberIds: a.memberIds || [], aliases: a.aliases, aliasText: a.aliases.join(', '), signature: a.signature, password: '', transport: a.transport || blankAccount().transport });

/** 邮箱账号：本人接入个人邮箱、有权限者接入共享邮箱并选择成员；密码只提交给服务端校验并加密保存，不回显、不进入工作空间数据。 */
function AccountsDrawer({ state, me, can, canAdmin, locked, run, mail, onClose }: { state: MistState; me: string; can: boolean; canAdmin: boolean; locked: boolean; run: (command: MistCommand) => Promise<{ result: { id?: string } }>; mail: Mail; onClose: () => void }) {
  const toast = useToast(), [editing, setEditing] = React.useState<{ id?: string; form: AccountForm } | null>(null), [problem, setProblem] = React.useState(''), [binding, setBinding] = React.useState<{ id: string; password: string } | null>(null);
  const members = ((state as MistState & { members?: Array<{ userId: string; name: string }> }).members || []).filter(row => row.userId !== me);
  const attempt = async (work: () => Promise<unknown>, done: string) => { setProblem(''); try { await work(); toast(done); return true; } catch (failure) { setProblem(problemText(failure, '操作未完成，请重试')); return false; } };
  const save = async () => {
    if (!editing) return; const { password, aliasText, ...input } = editing.form;
    const payload = { ...input, aliases: aliasText.split(/[,，\s]+/).map(item => item.trim()).filter(Boolean), memberIds: input.kind === 'shared' ? input.memberIds : [], transport: { ...input.transport, username: input.transport.username.trim() || input.address.trim() } };
    let id = editing.id;
    const saved = await attempt(async () => { const receipt = await run({ type: 'email.account.save', payload: { ...(id ? { id } : {}), input: payload } } as MistCommand); id = String(receipt.result.id || id || ''); if (password) await mail({ kind: 'bind', accountId: id, password }); }, password ? '邮箱已保存，凭据验证通过' : '邮箱设置已保存');
    if (saved) setEditing(null); else if (id && !editing.id) setEditing(prev => prev ? { ...prev, id } : prev);
  };
  const set = <K extends keyof AccountForm>(key: K, value: AccountForm[K]) => setEditing(prev => prev ? { ...prev, form: { ...prev.form, [key]: value } } : prev);
  const setT = <K extends keyof AccountForm['transport']>(key: K, value: AccountForm['transport'][K]) => setEditing(prev => prev ? { ...prev, form: { ...prev.form, transport: { ...prev.form.transport, [key]: value } } } : prev);
  const f = editing?.form;
  return <Drawer open onClose={onClose} title={editing ? (editing.id ? '修改邮箱设置' : '接入邮箱') : '邮箱账号'} sub={editing ? undefined : '个人邮箱仅本人可见；共享邮箱对接入人与所选成员可见'} size="lg"
    footer={editing ? <div className="mist-row" style={{ width: '100%' }}><span className="mist-spacer" /><Button onClick={() => setEditing(null)}>返回</Button><Button variant="primary" disabled={locked || !f!.address.trim() || !f!.displayName.trim() || !f!.transport.imapHost.trim() || !f!.transport.smtpHost.trim() || (!editing.id && !f!.password)} onClick={() => void save()}>{f!.password ? '保存并验证登录' : '保存设置'}</Button></div>
      : <div className="mist-row" style={{ width: '100%' }}><span className="mist-spacer" /><Button onClick={onClose}>关闭</Button>{can && <Button variant="primary" icon={Plus} disabled={locked} onClick={() => { setProblem(''); setEditing({ form: blankAccount() }); }}>接入邮箱</Button>}</div>}>
    {problem && <Banner tone="bad" title="未完成">{problem}</Banner>}
    {editing && f ? <FormGrid>
      <Field label="邮箱地址" required><TextInput aria-label="邮箱地址" type="email" value={f.address} onChange={event => set('address', event.target.value)} placeholder="name@company.com" /></Field>
      <Field label="显示名称" required><TextInput aria-label="显示名称" value={f.displayName} onChange={event => set('displayName', event.target.value)} /></Field>
      <Field label="类型" required hint={canAdmin ? '共享邮箱对所选成员可见' : '接入共享邮箱需要邮件账户管理权限'}><Select aria-label="邮箱类型" value={f.kind} onChange={event => set('kind', event.target.value as AccountForm['kind'])} options={[{ value: 'personal', label: '个人邮箱' }, ...(canAdmin || f.kind === 'shared' ? [{ value: 'shared', label: '共享邮箱' }] : [])]} /></Field>
      <Field label="别名" hint="可用作发件身份的其他地址，逗号分隔"><TextInput aria-label="别名" value={f.aliasText} onChange={event => set('aliasText', event.target.value)} /></Field>
      {f.kind === 'shared' && <Field label="共享成员" full hint="只能选择本工作空间已授权的账号">{members.length ? <div className="mist-col">{members.map(row => <Checkbox key={row.userId} checked={f.memberIds.includes(row.userId)} onChange={on => set('memberIds', on ? [...f.memberIds, row.userId] : f.memberIds.filter(id => id !== row.userId))} label={row.name} />)}</div> : <span className="mist-note">本工作空间还没有其他成员。</span>}</Field>}
      <Field label="收信服务器（IMAP）" required><TextInput aria-label="IMAP 服务器" value={f.transport.imapHost} onChange={event => setT('imapHost', event.target.value)} placeholder="imap.company.com" /></Field>
      <Field label="IMAP 端口与加密"><span style={PORT_ROW}><TextInput aria-label="IMAP 端口" type="number" value={String(f.transport.imapPort)} onChange={event => setT('imapPort', Number(event.target.value))} /><Select aria-label="IMAP 加密" value={f.transport.imapSecure ? 'ssl' : 'starttls'} onChange={event => setT('imapSecure', event.target.value === 'ssl')} options={[{ value: 'ssl', label: 'SSL/TLS' }, { value: 'starttls', label: 'STARTTLS' }]} /></span></Field>
      <Field label="发信服务器（SMTP）" required><TextInput aria-label="SMTP 服务器" value={f.transport.smtpHost} onChange={event => setT('smtpHost', event.target.value)} placeholder="smtp.company.com" /></Field>
      <Field label="SMTP 端口与加密"><span style={PORT_ROW}><TextInput aria-label="SMTP 端口" type="number" value={String(f.transport.smtpPort)} onChange={event => setT('smtpPort', Number(event.target.value))} /><Select aria-label="SMTP 加密" value={f.transport.smtpSecure ? 'ssl' : 'starttls'} onChange={event => setT('smtpSecure', event.target.value === 'ssl')} options={[{ value: 'starttls', label: 'STARTTLS' }, { value: 'ssl', label: 'SSL/TLS' }]} /></span></Field>
      <Field label="登录用户名" hint="留空则使用邮箱地址"><TextInput aria-label="登录用户名" value={f.transport.username} onChange={event => setT('username', event.target.value)} autoComplete="off" /></Field>
      <Field label={editing.id ? '密码 / 授权码（重新绑定时填写）' : '密码 / 授权码'} required={!editing.id} hint="保存时先真实登录收信与发信服务器，成功后才保存；不会回显"><TextInput aria-label="密码或授权码" type="password" value={f.password} onChange={event => set('password', event.target.value)} autoComplete="new-password" /></Field>
      <Field label="签名" full><TextArea aria-label="签名" rows={3} value={f.signature} onChange={event => set('signature', event.target.value)} /></Field>
    </FormGrid>
    : state.email.accounts.length ? <div className="mist-col" style={{ gap: 12 }}>{state.email.accounts.map(a => {
      const c = connectionLabel(a), owner = !a.example && (!me || a.ownerId === me);
      return <Card key={a.id} className="mist-col" style={{ gap: 8 }} data-email-account={a.id}>
        <div className="mist-row" style={{ flexWrap: 'wrap' }}><b>{a.displayName}</b><small className="mist-muted">{a.address}</small><span className="mist-spacer" /><Pill>{a.kind === 'shared' ? '共享邮箱' : '个人邮箱'}</Pill><Pill tone={c.tone}>{c.label}</Pill></div>
        {a.lastError && <span className="mist-note" data-tone="bad">{a.lastError.message}（{when(a.lastError.at)}）</span>}
        {(a.folders || []).filter(row => row.error).map(row => <span key={row.remote} className="mist-note">{row.remote}：{row.error}</span>)}
        <small className="mist-muted">{a.example ? '示例空间合成数据，不连接服务器' : `接入人 ${a.ownerName}${a.kind === 'shared' ? ` · 成员 ${a.memberNames.join('、') || '无'}` : ''}${a.transport ? ` · ${a.transport.imapHost}:${a.transport.imapPort} / ${a.transport.smtpHost}:${a.transport.smtpPort}` : ''}`}</small>
        {owner && can && (binding?.id === a.id
          ? <div className="mist-row" style={{ flexWrap: 'wrap' }}><TextInput aria-label={`${a.displayName} 密码或授权码`} type="password" autoComplete="new-password" value={binding.password} onChange={event => setBinding({ id: a.id, password: event.target.value })} /><Button onClick={() => setBinding(null)}>取消</Button><Button variant="primary" disabled={locked || !binding.password} onClick={() => void attempt(() => mail({ kind: 'bind', accountId: a.id, password: binding.password }), '凭据验证通过，已绑定').then(ok => { if (ok) setBinding(null); })}>验证并绑定</Button></div>
          : <div className="mist-row" style={{ flexWrap: 'wrap' }}>
            <Button size="sm" icon={Settings2} disabled={locked} onClick={() => { setProblem(''); setEditing({ id: a.id, form: accountForm(a) }); }}>修改设置</Button>
            <Button size="sm" icon={KeyRound} disabled={locked || !a.transport} onClick={() => setBinding({ id: a.id, password: '' })}>{a.credentialSet ? '重新绑定凭据' : '绑定凭据'}</Button>
            {a.credentialSet && <Button size="sm" icon={Unlink} disabled={locked} onClick={() => void attempt(() => mail({ kind: 'disconnect', accountId: a.id }), '已断开，凭据已删除')}>断开</Button>}
          </div>)}
        {!owner && !a.example && <span className="mist-note">由 {a.ownerName} 接入；只有接入人可以修改设置或凭据。</span>}
      </Card>; })}</div>
    : <EmptyState icon={Mail} title="还没有邮箱" description={can ? '接入个人邮箱后可以真实收发邮件。' : '你的账号没有邮件编辑权限，不能接入邮箱。'} compact />}
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
function SendConfirmDialog({ pending, state, locked, onCancel, onConfirm }: { pending: PendingSend; state: MistState; locked: boolean; onCancel: () => void; onConfirm: () => void }) {
  const v = pending.input, account = state.email.accounts.find(a => a.id === v.accountId);
  const files = v.fileIds.map(id => state.files.find(file => file.id === id)).filter((file): file is NonNullable<typeof file> => !!file);
  const groups = ([['收件人', v.to], ['抄送', v.cc], ['密送', v.bcc]] as const).map(([label, value]) => [label, parseAddresses(value)] as const).filter(([, list]) => list.length);
  const total = groups.reduce((sum, [, list]) => sum + list.length, 0), size = files.reduce((sum, file) => sum + (file.size || 0), 0);
  return <Dialog open onClose={onCancel} title="确认发送" icon={Send} width={560} description={`「${v.subject || '（无主题）'}」将由发件服务器投递给 ${total} 位收件人。发出后无法撤回。`}
    footer={<><Button onClick={onCancel}>取消</Button><Button variant="primary" icon={Send} disabled={locked} onClick={onConfirm}>确认发送</Button></>}>
    <Facts items={[
      { label: '发件邮箱', value: account ? `${account.displayName} · ${account.address}` : '邮箱不可用' },
      { label: '发件身份', value: v.from },
      ...groups.map(([label, list]) => ({ label: `${label}（${list.length}）`, value: list.join('、') })),
      { label: `附件（${files.length}）`, value: files.length ? `${files.map(file => `${file.name}（${sizeText(file.size || 0)}）`).join('、')}，共 ${sizeText(size)}` : '无附件' },
    ]} />
    <p className="mist-note" style={{ marginTop: 10 }}>结果不确定时邮件会留在待发送，不会自动重发；取消不会发送，写信内容与草稿保持不变。</p>
  </Dialog>;
}
