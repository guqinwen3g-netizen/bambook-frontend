/**
 * 智能邮箱工作空间切片：邮箱账号（非秘密设置）、已同步邮件、标记/关联/跟进、草稿与发送记录。
 * - 收信与发信由服务端邮件服务通过 IMAP / SMTP 真实执行，并经 email.server.* 命令写回；客户端不能直接提交这些命令。
 * - 账号凭据只存在服务端凭据目录，不进入工作空间状态、前端或日志。
 * - 示例邮箱（example）始终标注示例，不能发信，也不冒充真实收件。
 */
import { MistCommandError, type MistContext, type MistState } from './mistWorkspace';

export type EmailAddress = { name: string; address: string };
export type EmailFolder = 'inbox' | 'drafts' | 'outbox' | 'sent' | 'archive' | 'trash';
export type EmailMessageFolder = 'inbox' | 'sent' | 'archive' | 'trash';
export type EmailLinkKind = 'customer' | 'development' | 'order' | 'invoice';
export type EmailLink = { kind: EmailLinkKind; id: string };
export type EmailConnection = 'not_connected' | 'example' | 'connected' | 'syncing' | 'partial' | 'error';
/** 收发服务器设置（非秘密）。smtpSecure=false 表示先明文连接再强制 STARTTLS。 */
export type EmailTransport = { imapHost: string; imapPort: number; imapSecure: boolean; smtpHost: string; smtpPort: number; smtpSecure: boolean; username: string };
export type EmailProblem = { code: string; message: string; at: string };
/** 每个实际同步的远端文件夹：按 UIDVALIDITY + UID 增量同步，失败的文件夹保留上次结果与错误。 */
export type EmailFolderSync = { remote: string; folder: EmailMessageFolder; uidValidity: number; lastUid: number; lastSyncAt: string | null; error?: string };
export type EmailAccount = {
  id: string; address: string; displayName: string; kind: 'personal' | 'shared'; ownerName: string; memberNames: string[]; aliases: string[]; signature: string;
  connection: EmailConnection; lastSyncAt: string | null; failedFolders: string[]; example: boolean;
  /** 真实账号的归属：按用户 ID 控制可见与可操作范围；个人邮箱只有本人，共享邮箱为本人 + 授权成员。 */
  ownerId?: string; memberIds?: string[]; transport?: EmailTransport; credentialSet?: boolean; lastError?: EmailProblem | null; folders?: EmailFolderSync[]; syncStartedAt?: string | null;
};
/** fileId 指向私有附件文件；omitted 说明未保存内容的原因（如超过大小上限）。 */
export type EmailAttachment = { id: string; name: string; size: number; contentType: string; fileId?: string; omitted?: string };
export type EmailCategory = { label: string; source: 'rule' | 'ai' | 'none' | 'failed'; detail: string };
export type EmailMessage = {
  id: string; accountId: string; folder: EmailMessageFolder; previousFolder?: EmailMessageFolder; threadId: string;
  from: EmailAddress; to: EmailAddress[]; cc: EmailAddress[]; subject: string; body: string; at: string; attachments: EmailAttachment[];
  read: boolean; starred: boolean; important: boolean; category: EmailCategory; extracted: Array<{ field: string; value: string }>;
  links: EmailLink[]; followUpTaskIds: string[]; submissions: Array<{ at: string; actor: string; link: EmailLink; taskId: string }>; example: boolean;
  /** 已同步邮件的远端身份（去重键 = 账号 + 文件夹 + UIDVALIDITY + UID）。 */
  remote?: { folder: string; uid: number; uidValidity: number }; messageId?: string; inReplyTo?: string; sendId?: string; forwardOfId?: string;
};
export type EmailSendStatus = 'sending' | 'sent' | 'failed' | 'unknown';
export type EmailSendAttempt = { at: string; actor: string; outcome: 'claimed' | 'accepted' | 'failed' | 'unknown' | 'verified' | 'not_found'; code: string; message: string };
/** 持久发送记录：先落库再投递；结果不确定时保持 unknown，不自动重发。 */
export type EmailSend = {
  id: string; requestKey: string; accountId: string; draftId?: string; replyToId?: string; forwardOfId?: string;
  from: string; to: string; cc: string; bcc: string; subject: string; body: string; links: EmailLink[]; fileIds: string[];
  messageId: string; status: EmailSendStatus; attempts: EmailSendAttempt[]; response: string; sentMessageId?: string;
  createdBy: string; createdById: string; createdAt: string; updatedAt: string;
};
export type EmailDraftInput = { accountId: string; from: string; to: string; cc: string; bcc: string; subject: string; body: string; template: string; links: EmailLink[]; fileIds: string[]; replyToId?: string };
export type EmailDraft = EmailDraftInput & { id: string; createdAt: string; updatedAt: string; updatedBy: string };
export type EmailState = { accounts: EmailAccount[]; messages: EmailMessage[]; drafts: EmailDraft[]; sends: EmailSend[] };
export type EmailAccountInput = { address: string; displayName: string; kind: 'personal' | 'shared'; memberIds: string[]; aliases: string[]; signature: string; transport: EmailTransport };
export type EmailSyncedMessage = {
  remote: { folder: string; uid: number; uidValidity: number }; folder: EmailMessageFolder; messageId: string; inReplyTo: string; references: string[];
  from: EmailAddress; to: EmailAddress[]; cc: EmailAddress[]; subject: string; body: string; at: string; read: boolean; attachments: EmailAttachment[];
};
type StoredFile = { id: string; name: string; mimeType: string; size: number; storageKey: string; createdAt: string; uploadedBy?: string };
export type EmailCommand =
  | { type: 'email.flag'; payload: { id: string; flag: 'read' | 'starred' | 'important'; value: boolean } }
  | { type: 'email.move'; payload: { id: string; folder: 'inbox' | 'archive' | 'trash' | 'restore' } }
  | { type: 'email.link'; payload: { id: string; link: EmailLink } }
  | { type: 'email.unlink'; payload: { id: string; link: EmailLink } }
  | { type: 'email.followUp'; payload: { id: string; owner: string; due: string; note: string } }
  | { type: 'email.submitExtraction'; payload: { id: string; link: EmailLink } }
  | { type: 'email.draft.save'; payload: { id?: string; input: EmailDraftInput } }
  | { type: 'email.draft.delete'; payload: { id: string } }
  | { type: 'email.account.save'; payload: { id?: string; input: EmailAccountInput } }
  // 以下 email.server.* 只能由服务端邮件服务在真实 IMAP / SMTP 操作后提交。
  | { type: 'email.server.account'; payload: { id: string; connection?: EmailConnection; credentialSet?: boolean; lastError?: EmailProblem | null; syncStartedAt?: string | null } }
  | { type: 'email.server.sync'; payload: { accountId: string; at: string; folders: EmailFolderSync[]; messages: EmailSyncedMessage[]; files: StoredFile[]; lastError: EmailProblem | null } }
  | { type: 'email.server.send.begin'; payload: { mode: 'new'; requestKey: string; draftId?: string; input: EmailDraftInput; forwardOfId?: string; messageId: string } | { mode: 'retry'; id: string; confirmUnknown?: boolean } }
  | { type: 'email.server.send.finish'; payload: { id: string; outcome: 'accepted' | 'failed' | 'unknown' | 'verified' | 'not_found'; code: string; message: string; response?: string } };
export const EMAIL_SERVER_COMMAND = /^email\.server\./;
/** 发送中超过该时长仍未写回结果，按"结果待核对"处理（进程中断等）。 */
export const EMAIL_SEND_STALE_MS = 5 * 60 * 1000;

const STATUS: Record<string, number> = { NOT_FOUND: 404, FORBIDDEN: 403, CONFLICT: 409, SEND_RESULT_UNCERTAIN: 409 };
const fail = (message: string, code = 'VALIDATION'): never => { throw new MistCommandError(code, message, STATUS[code] ?? 422); };
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$/;
const FOLDER_LABEL: Record<EmailMessageFolder, string> = { inbox: '收件箱', sent: '已发送', archive: '已归档', trash: '已删除' };
const clip = (value: unknown, max: number) => (typeof value === 'string' ? value : '').slice(0, max);
const text = (value: unknown, label: string, required = false, max = 2000) => { const v = typeof value === 'string' ? value.trim() : ''; if (required && !v) fail(`请填写${label}`); if (v.length > max) fail(`${label}过长`); return v; };
const LINK_KINDS: EmailLinkKind[] = ['customer', 'development', 'order', 'invoice'];
export const EMAIL_LINK_LABEL: Record<EmailLinkKind, string> = { customer: '客户', development: '开发案', order: '订单', invoice: '发票' };

export function createEmailState(_context: MistContext, _root: unknown): EmailState { return { accounts: [], messages: [], drafts: [], sends: [] }; }
/** 示例与旧账号没有 ownerId，沿用工作空间成员可见；真实账号只给本人与授权成员。 */
export function emailAccountAccessible(account: Pick<EmailAccount, 'ownerId' | 'memberIds'>, actorId?: string) {
  if (!account.ownerId || actorId === undefined) return true;
  return account.ownerId === actorId || (account.memberIds || []).includes(actorId);
}
/** 当前账号可见的邮件数据范围（账号、邮件、草稿、发送记录以及它们的 ID）。 */
export function emailVisibleScope(email: EmailState | undefined, actorId?: string) {
  const accounts = (email?.accounts || []).filter(row => emailAccountAccessible(row, actorId)), ids = new Set(accounts.map(row => row.id));
  const messages = (email?.messages || []).filter(row => ids.has(row.accountId)), drafts = (email?.drafts || []).filter(row => ids.has(row.accountId)), sends = (email?.sends || []).filter(row => ids.has(row.accountId));
  return { accounts, messages, drafts, sends, entityIds: new Set([...messages.map(row => row.id), ...sends.map(row => row.id), ...drafts.map(row => row.id), ...accounts.map(row => row.id)]) };
}
/** 发送状态：sending 超时视为结果待核对。 */
export function emailSendEffectiveStatus(send: Pick<EmailSend, 'status' | 'updatedAt'>, now = Date.now()): EmailSendStatus {
  return send.status === 'sending' && now - new Date(send.updatedAt).getTime() > EMAIL_SEND_STALE_MS ? 'unknown' : send.status;
}
/** 个人邮箱由本人以邮件编辑权限接入；共享邮箱涉及他人可见范围，需要邮件账户管理权限（emails:admin）。 */
export function emailCommandPermission(command: EmailCommand) { return command.type === 'email.account.save' && (command.payload as { input?: { kind?: string } })?.input?.kind === 'shared' ? 'emails:admin' : 'emails:write'; }

/** 关联目标必须是当前工作空间里真实存在的对象。 */
export function emailLinkTarget(root: MistState, link: EmailLink): { label: string; view: string; id: string } | null {
  if (link.kind === 'customer') { const row = root.customers.find(item => item.id === link.id); return row ? { label: row.name, view: 'crm', id: row.id } : null; }
  if (link.kind === 'development') { const row = root.devs.find(item => item.id === link.id); return row ? { label: `${row.code} · ${row.name}`, view: 'development/detail', id: row.id } : null; }
  if (link.kind === 'order') { const row = root.orders.find(item => item.id === link.id); return row ? { label: `${row.code} · ${row.customer}`, view: 'orders/detail', id: row.id } : null; }
  const row = root.invoices.find(item => item.id === link.id); return row ? { label: `${row.code} · ${row.customer}`, view: 'payment-vouchers', id: row.id } : null;
}
function link(root: MistState, value: EmailLink): EmailLink {
  if (!value || !LINK_KINDS.includes(value.kind)) fail('关联对象类型无效');
  const id = text(value.id, '关联对象', true, 200); if (!emailLinkTarget(root, { kind: value.kind, id })) fail('关联对象不在当前工作空间', 'NOT_FOUND');
  return { kind: value.kind, id };
}
const sameLink = (a: EmailLink, b: EmailLink) => a.kind === b.kind && a.id === b.id;
function account(root: MistState, id: unknown, context: MistContext) {
  const row = root.email.accounts.find(item => item.id === id);
  if (!row || !emailAccountAccessible(row, context.actorId)) fail('邮箱不存在或当前账号无权使用', 'NOT_FOUND');
  return row!;
}
/** 邮件只能由其所属邮箱的本人或授权成员操作；按用户 ID 判断，不比较显示姓名。 */
function message(root: MistState, id: string, context: MistContext) {
  const row = root.email.messages.find(item => item.id === id), owner = row && root.email.accounts.find(item => item.id === row.accountId);
  if (!row || !owner || !emailAccountAccessible(owner, context.actorId)) fail('邮件不存在或已移除', 'NOT_FOUND');
  return row!;
}
function send(root: MistState, id: unknown, context: MistContext) {
  const row = root.email.sends.find(item => item.id === id);
  if (!row) fail('发送记录不存在', 'NOT_FOUND');
  account(root, row!.accountId, context); return row!;
}
/** 不可见邮箱的私有附件不能被挂进草稿或发送。 */
function privateMailFileIds(root: MistState, actorId?: string) {
  const ids = new Set<string>();
  for (const row of root.email.messages) {
    const owner = root.email.accounts.find(item => item.id === row.accountId);
    if (!owner || !emailAccountAccessible(owner, actorId)) for (const file of row.attachments) if (file.fileId) ids.add(file.fileId);
  }
  return ids;
}
function transportOf(value: unknown): EmailTransport {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const host = (key: string, label: string) => { const h = text(v[key], label, true, 253).toLowerCase(); if (!HOST_RE.test(h)) fail(`${label}格式无效`); return h; };
  const port = (key: string, label: string) => { const n = Number(v[key]); if (!Number.isInteger(n) || n < 1 || n > 65535) fail(`${label}无效`); return n; };
  return { imapHost: host('imapHost', '收信服务器'), imapPort: port('imapPort', '收信端口'), imapSecure: v.imapSecure !== false, smtpHost: host('smtpHost', '发信服务器'), smtpPort: port('smtpPort', '发信端口'), smtpSecure: v.smtpSecure === true, username: text(v.username, '登录用户名', true, 254) };
}
function draftOf(root: MistState, input: EmailDraftInput, context: MistContext) {
  const owner = account(root, input?.accountId, context);
  const from = text(input.from, '发件身份', true, 200); if (from !== owner.address && !owner.aliases.includes(from)) fail('发件身份不在该邮箱允许的别名中');
  const blocked = privateMailFileIds(root, context.actorId);
  const draft = { accountId: owner.id, from, to: addressList(text(input.to, '收件人', false, 2000), '收件人'), cc: addressList(text(input.cc, '抄送', false, 2000), '抄送'), bcc: addressList(text(input.bcc, '密送', false, 2000), '密送'), subject: text(input.subject, '主题', false, 300), body: text(input.body, '正文', false, 20000), template: text(input.template, '模板', false, 40), links: (input.links || []).map(item => link(root, item)), fileIds: [...new Set((input.fileIds || []).map(String))], ...(input.replyToId ? { replyToId: message(root, String(input.replyToId), context).id } : {}) };
  for (const fileId of draft.fileIds) if (!root.files.some(file => file.id === fileId) || blocked.has(fileId)) fail('附件不在当前工作空间', 'NOT_FOUND');
  return { owner, draft };
}
const addressRows = (value: string): EmailAddress[] => value.split(/,\s*/).filter(Boolean).map(address => ({ name: '', address }));
function addressRow(value: unknown): EmailAddress { const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>; return { name: clip(v.name, 200).trim(), address: clip(v.address, 254).trim() }; }
function isoAt(value: unknown, fallback: string) { const t = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(t) ? new Date(t).toISOString() : fallback; }
/** 发送被服务器接收后，在已发送中生成真实记录，保留来源关联与回复线索。 */
function recordSent(root: MistState, row: EmailSend, context: MistContext) {
  if (row.sentMessageId) return row.sentMessageId;
  const owner = root.email.accounts.find(item => item.id === row.accountId)!, parent = row.replyToId ? root.email.messages.find(item => item.id === row.replyToId) : undefined;
  const id = context.id();
  root.email.messages.unshift({
    id, accountId: row.accountId, folder: 'sent', threadId: parent?.threadId || id, from: { name: owner.displayName, address: row.from }, to: addressRows(row.to), cc: addressRows(row.cc), subject: row.subject, body: row.body, at: context.now,
    attachments: row.fileIds.map(fileId => root.files.find(file => file.id === fileId)).filter((file): file is NonNullable<typeof file> => !!file).map(file => ({ id: context.id(), name: file.name, size: file.size, contentType: file.mimeType, fileId: file.id })),
    read: true, starred: false, important: false, category: { label: '', source: 'none', detail: '未配置分类规则' }, extracted: [], links: row.links.map(item => ({ ...item })), followUpTaskIds: [], submissions: [], example: false,
    messageId: row.messageId, sendId: row.id, ...(parent?.messageId ? { inReplyTo: parent.messageId } : {}), ...(row.forwardOfId ? { forwardOfId: row.forwardOfId } : {}),
  });
  row.sentMessageId = id;
  if (row.draftId) root.email.drafts = root.email.drafts.filter(item => item.id !== row.draftId);
  if (parent) log(root, context, parent.id, `已回复：${row.subject}`);
  if (row.forwardOfId) log(root, context, row.forwardOfId, `已转发：${row.subject}`);
  log(root, context, id, `发送成功（服务器已接收）：${row.subject}`);
  return id;
}
function log(root: MistState, context: MistContext, entityId: string, textValue: string) { root.events.unshift({ id: context.id(), entityType: 'email', entityId, actor: context.actorName, at: context.now, text: textValue, fileIds: [] }); }
const addressList = (value: string, label: string) => { const parts = value.split(/[,;，；\s]+/).map(item => item.trim()).filter(Boolean); for (const item of parts) if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(item)) fail(`${label}中的地址格式无效：${item}`); return parts.join(', '); };

export function applyEmailCommand(root: MistState, command: EmailCommand, context: MistContext): { id: string } & Record<string, unknown> {
  const p = command.payload as Record<string, unknown>;
  switch (command.type) {
    case 'email.flag': {
      const row = message(root, String(p.id), context); const flag = command.payload.flag; if (!['read', 'starred', 'important'].includes(flag)) fail('标记类型无效');
      row[flag] = !!command.payload.value; return { id: row.id };
    }
    case 'email.move': {
      const row = message(root, String(p.id), context), target = command.payload.folder;
      if (target === 'restore') { if (row.folder !== 'trash') fail('只有已删除的邮件可以恢复', 'PRECONDITION'); row.folder = row.previousFolder || 'inbox'; delete row.previousFolder; log(root, context, row.id, '恢复邮件 ' + row.subject); return { id: row.id }; }
      if (!['inbox', 'archive', 'trash'].includes(target)) fail('目标文件夹无效');
      if (row.folder === 'sent' && target === 'inbox') fail('已发送邮件不能移到收件箱', 'PRECONDITION');
      if (row.folder === target) return { id: row.id };
      if (target === 'trash') row.previousFolder = row.folder;
      row.folder = target; log(root, context, row.id, (target === 'trash' ? '删除邮件 ' : target === 'archive' ? '归档邮件 ' : '移回收件箱 ') + row.subject); return { id: row.id };
    }
    case 'email.link': {
      const row = message(root, String(p.id), context), value = link(root, command.payload.link);
      if (!row.links.some(item => sameLink(item, value))) { row.links.push(value); log(root, context, row.id, `关联${EMAIL_LINK_LABEL[value.kind]} ${emailLinkTarget(root, value)!.label}`); }
      return { id: row.id };
    }
    case 'email.unlink': {
      const row = message(root, String(p.id), context), value = command.payload.link;
      if (row.submissions.some(item => sameLink(item.link, value))) fail('已向该对象提交过资料，关联不能移除', 'PRECONDITION');
      row.links = row.links.filter(item => !sameLink(item, value)); log(root, context, row.id, '移除邮件关联'); return { id: row.id };
    }
    case 'email.followUp': {
      const row = message(root, String(p.id), context), owner = text(p.owner, '负责人', true, 80), note = text(p.note, '说明', false, 500), due = text(p.due, '截止日', true, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) fail('截止日格式无效');
      const id = context.id(), target = { view: 'emails', id: row.id };
      root.tasks.unshift({ id, title: `跟进邮件：${row.subject}`, due, done: false, kind: 'email-follow-up', target });
      root.calendar.push({ id: context.id(), title: `邮件跟进 · ${row.subject}`, date: due, time: '', note: `${owner}${note ? ' · ' + note : ''} · 来源：${row.from.name || row.from.address}`, target });
      row.followUpTaskIds.push(id); log(root, context, row.id, `生成邮件跟进（${owner}，${due}）`); return { id };
    }
    case 'email.submitExtraction': {
      const row = message(root, String(p.id), context), value = link(root, command.payload.link);
      if (!row.extracted.length) fail('这封邮件没有可提交的抽取资料', 'PRECONDITION');
      if (!row.links.some(item => sameLink(item, value))) fail('请先确认关联该业务对象', 'PRECONDITION');
      if (row.submissions.some(item => sameLink(item.link, value))) fail('已向该对象提交过这份资料', 'PRECONDITION');
      const target = emailLinkTarget(root, value)!, id = context.id();
      root.tasks.unshift({ id, title: `复核邮件资料：${row.extracted.map(item => `${item.field} ${item.value}`).join('，')}`.slice(0, 180), due: context.now.slice(0, 10), done: false, kind: 'email-extraction-review', target: { view: target.view, id: target.id } });
      row.submissions.push({ at: context.now, actor: context.actorName, link: value, taskId: id });
      log(root, context, row.id, `提交邮件抽取资料到${EMAIL_LINK_LABEL[value.kind]} ${target.label}（待复核，不改正式数据）`); return { id: row.id };
    }
    case 'email.draft.save': {
      const { draft } = draftOf(root, command.payload.input || ({} as EmailDraftInput), context);
      const existing = command.payload.id ? root.email.drafts.find(row => row.id === command.payload.id && emailAccountAccessible(root.email.accounts.find(item => item.id === row.accountId) || {}, context.actorId)) || fail('草稿不存在或已删除', 'NOT_FOUND') : undefined;
      if (existing) { Object.assign(existing, draft, { updatedAt: context.now, updatedBy: context.actorName }); if (!draft.replyToId) delete existing.replyToId; return { id: existing.id }; }
      const id = context.id(); root.email.drafts.unshift({ ...draft, id, createdAt: context.now, updatedAt: context.now, updatedBy: context.actorName }); return { id };
    }
    case 'email.draft.delete': {
      const target = root.email.drafts.find(row => row.id === String(p.id));
      if (!target) fail('草稿不存在或已删除', 'NOT_FOUND');
      account(root, target!.accountId, context);
      root.email.drafts = root.email.drafts.filter(row => row.id !== target!.id); return { id: target!.id };
    }
    case 'email.account.save': return saveAccount(root, command.payload, context);
    case 'email.server.account': {
      const row = account(root, p.id, context); if (row.example) fail('示例邮箱没有真实连接', 'PRECONDITION');
      const v = command.payload;
      if (v.connection !== undefined) { if (!['not_connected', 'connected', 'syncing', 'partial', 'error'].includes(v.connection)) fail('连接状态无效'); row.connection = v.connection; }
      if (v.credentialSet !== undefined) row.credentialSet = !!v.credentialSet;
      if (v.lastError !== undefined) row.lastError = v.lastError ? { code: clip(v.lastError.code, 60), message: clip(v.lastError.message, 300), at: isoAt(v.lastError.at, context.now) } : null;
      if (v.syncStartedAt !== undefined) row.syncStartedAt = v.syncStartedAt ? isoAt(v.syncStartedAt, context.now) : null;
      if (v.credentialSet === false) { row.connection = 'not_connected'; log(root, context, row.id, `断开邮箱 ${row.address}`); }
      else if (v.credentialSet === true) log(root, context, row.id, `邮箱 ${row.address} 已通过登录校验并绑定凭据`);
      return { id: row.id };
    }
    case 'email.server.sync': return applySync(root, command.payload, context);
    case 'email.server.send.begin': return beginSend(root, command.payload, context);
    case 'email.server.send.finish': {
      const v = command.payload, row = send(root, v.id, context), outcome = v.outcome;
      const attempt = (value: EmailSendAttempt['outcome']) => row.attempts.push({ at: context.now, actor: context.actorName, outcome: value, code: clip(v.code, 60), message: clip(v.message, 300) });
      if (outcome === 'verified' || outcome === 'not_found') {
        if (emailSendEffectiveStatus(row, Date.parse(context.now)) !== 'unknown') fail('只有结果待核对的发送需要核对', 'PRECONDITION');
        attempt(outcome); row.updatedAt = context.now;
        if (outcome === 'verified') { row.status = 'sent'; row.response = clip(v.response || '已在邮箱中核对到该邮件', 300); return { id: row.id, status: row.status, sentMessageId: recordSent(root, row, context) }; }
        row.status = 'unknown'; log(root, context, row.id, `核对发送结果：未在邮箱中找到 ${row.subject}，仍待确认`); return { id: row.id, status: row.status };
      }
      if (row.status !== 'sending') fail('发送记录不在发送中，不能重复写回结果', 'PRECONDITION');
      if (!['accepted', 'failed', 'unknown'].includes(outcome)) fail('发送结果无效');
      attempt(outcome); row.updatedAt = context.now; row.response = clip(v.response || '', 300);
      if (outcome === 'accepted') { row.status = 'sent'; return { id: row.id, status: row.status, sentMessageId: recordSent(root, row, context) }; }
      row.status = outcome === 'failed' ? 'failed' : 'unknown';
      log(root, context, row.id, outcome === 'failed' ? `发送失败：${row.subject}（${clip(v.message, 120)}）` : `发送结果不确定：${row.subject}，请核对后再决定是否重发`);
      return { id: row.id, status: row.status };
    }
  }
  return fail('未知邮件操作');
}

function saveAccount(root: MistState, payload: { id?: string; input: EmailAccountInput }, context: MistContext): { id: string } {
  if (!context.actorId) fail('需要登录账号才能接入邮箱', 'FORBIDDEN');
  const input = (payload?.input || {}) as EmailAccountInput;
  const address = text(input.address, '邮箱地址', true, 254).toLowerCase(); if (!EMAIL_RE.test(address)) fail('邮箱地址格式无效');
  const displayName = text(input.displayName, '显示名称', true, 80), signature = text(input.signature, '签名', false, 2000);
  const kind = input.kind === 'shared' ? 'shared' : input.kind === 'personal' ? 'personal' : fail('邮箱类型无效');
  const aliases = [...new Set((Array.isArray(input.aliases) ? input.aliases : []).map(item => text(item, '别名', false, 254).toLowerCase()).filter(item => item && item !== address))];
  if (aliases.length > 10) fail('别名最多 10 个'); for (const item of aliases) if (!EMAIL_RE.test(item)) fail(`别名格式无效：${item}`);
  const transport = transportOf(input.transport);
  const roster = Array.isArray((root as any).members) ? (root as any).members as Array<{ userId: string; name: string }> : [];
  const allowed = new Set([...(Array.isArray((root as any).memberIds) ? (root as any).memberIds : []), ...roster.map(item => item.userId)]);
  const memberIds = kind === 'personal' ? [] : [...new Set((Array.isArray(input.memberIds) ? input.memberIds : []).map(String))].filter(id => id !== context.actorId);
  for (const id of memberIds) if (!allowed.has(id)) fail('共享成员必须是本工作空间的成员', 'NOT_FOUND');
  const memberNames = memberIds.map(id => roster.find(item => item.userId === id)?.name || id);
  const existing = payload?.id ? root.email.accounts.find(row => row.id === payload.id) : undefined;
  if (payload?.id && (!existing || !emailAccountAccessible(existing, context.actorId))) fail('邮箱不存在或当前账号无权使用', 'NOT_FOUND');
  if (existing && (existing.example || existing.ownerId !== context.actorId)) fail(existing.example ? '示例邮箱不能改为真实邮箱，请新建账号' : '只有接入该邮箱的本人可以修改账号设置', 'FORBIDDEN');
  if (root.email.accounts.some(row => row.id !== existing?.id && !row.example && row.address === address)) fail('该邮箱已在本工作空间接入', 'CONFLICT');
  if (existing) {
    const before = existing.transport, rebind = !before || before.username !== transport.username || before.imapHost !== transport.imapHost || before.imapPort !== transport.imapPort || before.smtpHost !== transport.smtpHost || before.smtpPort !== transport.smtpPort || existing.address !== address;
    Object.assign(existing, { address, displayName, kind, memberIds, memberNames, aliases, signature, transport });
    if (rebind) Object.assign(existing, { credentialSet: false, connection: 'not_connected', lastError: null, folders: existing.address === address ? existing.folders || [] : [] });
    log(root, context, existing.id, rebind ? `修改邮箱 ${address} 的服务器或登录设置，需要重新校验凭据` : `更新邮箱 ${address} 的设置`);
    return { id: existing.id };
  }
  const id = context.id();
  root.email.accounts.push({ id, address, displayName, kind, ownerId: context.actorId, ownerName: context.actorName, memberIds, memberNames, aliases, signature, transport, connection: 'not_connected', credentialSet: false, lastError: null, lastSyncAt: null, failedFolders: [], folders: [], syncStartedAt: null, example: false });
  log(root, context, id, `接入${kind === 'shared' ? '共享' : '个人'}邮箱 ${address}（待校验凭据）`);
  return { id };
}

function applySync(root: MistState, payload: Extract<EmailCommand, { type: 'email.server.sync' }>['payload'], context: MistContext) {
  const owner = account(root, payload?.accountId, context); if (owner.example) fail('示例邮箱不能同步', 'PRECONDITION');
  const folders = Array.isArray(payload.folders) ? payload.folders : [], incoming = Array.isArray(payload.messages) ? payload.messages : [], files = Array.isArray(payload.files) ? payload.files : [];
  if (incoming.length > 500 || files.length > 1000) fail('单次同步数量超过上限');
  const fileById = new Map<string, StoredFile>();
  for (const f of files) {
    text(f?.id, '文件ID', true, 120); text(f.name, '文件名', true, 240); text(f.mimeType, '文件类型', true, 160);
    if (typeof f.storageKey !== 'string' || !/^[A-Za-z0-9/_-]+$/.test(f.storageKey) || f.storageKey.includes('..') || !Number.isSafeInteger(f.size) || f.size < 0 || f.size > 50 * 1024 * 1024) fail('附件信息无效');
    if (root.files.some(x => x.id === f.id) || fileById.has(f.id)) fail('附件已存在', 'CONFLICT');
    fileById.set(f.id, f);
  }
  const key = (r: { folder: string; uid: number; uidValidity: number }) => `${r.folder}\u0000${r.uidValidity}\u0000${r.uid}`;
  const mine = root.email.messages.filter(row => row.accountId === owner.id);
  const seen = new Set(mine.filter(row => row.remote).map(row => key(row.remote!)));
  const usedFiles = new Set<string>(); let added = 0, merged = 0, skipped = 0;
  for (const m of incoming) {
    const remote = { folder: text(m?.remote?.folder, '远端文件夹', true, 200), uid: Number(m.remote.uid), uidValidity: Number(m.remote.uidValidity) };
    if (!Number.isSafeInteger(remote.uid) || remote.uid < 1 || !Number.isSafeInteger(remote.uidValidity) || remote.uidValidity < 0) fail('远端邮件编号无效');
    if (!(['inbox', 'sent', 'archive', 'trash'] as string[]).includes(m.folder)) fail('邮件文件夹无效');
    if (seen.has(key(remote))) { skipped++; continue; }
    seen.add(key(remote));
    const messageId = clip(m.messageId, 300).trim();
    // 同一封邮件（Message-ID 相同）已在本邮箱同一文件夹中：补上远端身份，不重复入库（例如本系统发出后又在已发送中同步到）。
    // UIDVALIDITY 变化后同一远端文件夹重新编号：按 Message-ID 认回原记录，只更新远端身份。
    const twin = messageId ? mine.find(row => row.messageId === messageId && (row.remote ? row.remote.folder === remote.folder && row.remote.uidValidity !== remote.uidValidity : row.folder === m.folder || row.previousFolder === m.folder)) : undefined;
    if (twin) { twin.remote = remote; merged++; continue; }
    const refs = [clip(m.inReplyTo, 300), ...(Array.isArray(m.references) ? m.references.map(item => clip(item, 300)) : [])].filter(Boolean);
    const parent = refs.length ? mine.find(row => row.messageId && refs.includes(row.messageId)) : undefined;
    const id = context.id();
    const attachments: EmailAttachment[] = (Array.isArray(m.attachments) ? m.attachments : []).slice(0, 50).map(a => {
      if (a.fileId && (!fileById.has(a.fileId) || usedFiles.has(a.fileId))) fail('同步附件与文件记录不一致');
      if (a.fileId) usedFiles.add(a.fileId);
      return { id: context.id(), name: clip(a.name, 240) || '未命名附件', size: Number.isSafeInteger(a.size) && a.size >= 0 ? a.size : 0, contentType: clip(a.contentType, 160) || 'application/octet-stream', ...(a.fileId ? { fileId: a.fileId } : {}), ...(a.omitted ? { omitted: clip(a.omitted, 120) } : {}) };
    });
    const row: EmailMessage = {
      id, accountId: owner.id, folder: m.folder, threadId: parent?.threadId || id, from: addressRow(m.from), to: (Array.isArray(m.to) ? m.to : []).slice(0, 100).map(addressRow), cc: (Array.isArray(m.cc) ? m.cc : []).slice(0, 100).map(addressRow),
      subject: clip(m.subject, 300) || '（无主题）', body: clip(m.body, 100000), at: isoAt(m.at, context.now), attachments, read: m.folder === 'sent' ? true : !!m.read, starred: false, important: false,
      category: { label: '', source: 'none', detail: '未配置分类规则' }, extracted: [], links: [], followUpTaskIds: [], submissions: [], example: false, remote, ...(messageId ? { messageId } : {}), ...(m.inReplyTo ? { inReplyTo: clip(m.inReplyTo, 300) } : {}),
    };
    root.email.messages.push(row); mine.push(row); added++;
  }
  for (const f of fileById.values()) if (usedFiles.has(f.id)) root.files.push({ ...f });
  const stored = owner.folders || (owner.folders = []);
  for (const f of folders) {
    const entry: EmailFolderSync = { remote: text(f?.remote, '远端文件夹', true, 200), folder: (['inbox', 'sent', 'archive', 'trash'] as string[]).includes(f.folder) ? f.folder : fail('邮件文件夹无效'), uidValidity: Number(f.uidValidity) || 0, lastUid: Math.max(0, Number(f.lastUid) || 0), lastSyncAt: f.lastSyncAt ? isoAt(f.lastSyncAt, context.now) : null, ...(f.error ? { error: clip(f.error, 300) } : {}) };
    const index = stored.findIndex(item => item.remote === entry.remote);
    if (index >= 0) stored[index] = entry.error ? { ...stored[index], error: entry.error } : entry; else stored.push(entry);
  }
  const failed = stored.filter(item => item.error);
  owner.failedFolders = [...new Set(failed.map(item => FOLDER_LABEL[item.folder] || item.remote))];
  owner.lastError = payload.lastError ? { code: clip(payload.lastError.code, 60), message: clip(payload.lastError.message, 300), at: isoAt(payload.lastError.at, context.now) } : null;
  const okCount = folders.filter(item => !item.error).length;
  owner.connection = owner.lastError && !okCount ? 'error' : failed.length ? (okCount || stored.length > failed.length ? 'partial' : 'error') : 'connected';
  if (okCount) owner.lastSyncAt = isoAt(payload.at, context.now);
  owner.syncStartedAt = null;
  log(root, context, owner.id, `同步邮箱 ${owner.address}：新增 ${added} 封${merged ? `，合并 ${merged} 封` : ''}${skipped ? `，跳过重复 ${skipped} 封` : ''}${failed.length ? `；${owner.failedFolders.join('、')}同步失败` : ''}`);
  return { id: owner.id, added, merged, skipped, fileIds: [...usedFiles] };
}

function beginSend(root: MistState, payload: Extract<EmailCommand, { type: 'email.server.send.begin' }>['payload'], context: MistContext) {
  if (!context.actorId) fail('需要登录账号才能发送', 'FORBIDDEN');
  if (payload?.mode === 'retry') {
    const row = send(root, payload.id, context), status = emailSendEffectiveStatus(row, Date.parse(context.now));
    if (status === 'sent') fail('该邮件已发送，不能重复发送', 'PRECONDITION');
    if (status === 'sending') fail('该邮件正在发送，请稍后查看结果', 'PRECONDITION');
    if (status === 'unknown' && payload.confirmUnknown !== true) fail('上次发送结果不确定：请先核对对方或已发送中是否已收到，确认未送达后再重发', 'SEND_RESULT_UNCERTAIN');
    row.status = 'sending'; row.updatedAt = context.now;
    row.attempts.push({ at: context.now, actor: context.actorName, outcome: 'claimed', code: status === 'unknown' ? 'RETRY_CONFIRMED_UNDELIVERED' : 'RETRY_AFTER_FAILURE', message: status === 'unknown' ? '已确认未送达，重新发送' : '上次明确失败，重新发送' });
    log(root, context, row.id, `重新发送：${row.subject}`);
    return { id: row.id, status: row.status, existing: false };
  }
  if (payload?.mode !== 'new') fail('发送方式无效');
  const requestKey = text(payload.requestKey, '发送请求编号', true, 80); if (!/^[A-Za-z0-9_-]{8,80}$/.test(requestKey)) fail('发送请求编号无效');
  const prior = root.email.sends.find(row => row.requestKey === requestKey && row.createdById === context.actorId);
  if (prior) { account(root, prior.accountId, context); return { id: prior.id, status: emailSendEffectiveStatus(prior, Date.parse(context.now)), existing: true }; }
  const { owner, draft } = draftOf(root, payload.input || ({} as EmailDraftInput), context);
  if (owner.example) fail('示例邮箱不能发送真实邮件', 'PRECONDITION');
  if (!owner.credentialSet || owner.connection === 'not_connected') fail('该邮箱尚未完成凭据绑定，不能发送', 'PRECONDITION');
  if (!draft.to && !draft.cc && !draft.bcc) fail('请填写收件人');
  if (payload.draftId) { const d = root.email.drafts.find(row => row.id === payload.draftId); if (!d || d.accountId !== owner.id) fail('草稿不存在或已删除', 'NOT_FOUND'); }
  const forwardOfId = payload.forwardOfId ? message(root, String(payload.forwardOfId), context).id : undefined;
  const messageId = text(payload.messageId, 'Message-ID', true, 300); if (!/^<[^<>\s@]{3,200}@[^<>\s@]{1,200}>$/.test(messageId)) fail('Message-ID 无效');
  const id = context.id();
  root.email.sends.unshift({ id, requestKey, accountId: owner.id, ...(payload.draftId ? { draftId: payload.draftId } : {}), ...(draft.replyToId ? { replyToId: draft.replyToId } : {}), ...(forwardOfId ? { forwardOfId } : {}), from: draft.from, to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject || '（无主题）', body: draft.body, links: draft.links, fileIds: draft.fileIds, messageId, status: 'sending', attempts: [{ at: context.now, actor: context.actorName, outcome: 'claimed', code: 'SEND_STARTED', message: '已登记，开始投递' }], response: '', createdBy: context.actorName, createdById: context.actorId!, createdAt: context.now, updatedAt: context.now });
  log(root, context, id, `开始发送：${draft.subject || '（无主题）'}`);
  return { id, status: 'sending' as EmailSendStatus, existing: false };
}

/** 示例空间的合成邮件：全部标注示例、使用 example.invalid 地址，不代表真实收信。 */
export function seedEmailExamples(root: MistState, context: MistContext) {
  const day = (offset: number, time: string) => { const date = new Date(context.now); date.setUTCDate(date.getUTCDate() - offset); return date.toISOString().slice(0, 10) + 'T' + time + ':00Z'; };
  const me = context.actorName || '顾言';
  root.email.accounts.push(
    { id: 'mail-personal', address: 'gu.yan@bambook.example.invalid', displayName: `${me}（示例个人邮箱）`, kind: 'personal', ownerName: me, memberNames: [], aliases: ['sales@bambook.example.invalid'], signature: `${me}\n竹衍服饰 · 业务部\n示例签名`, connection: 'example', lastSyncAt: day(0, '07:40'), failedFolders: [], example: true },
    { id: 'mail-shared', address: 'orders@bambook.example.invalid', displayName: '订单共享邮箱（示例）', kind: 'shared', ownerName: '沈禾', memberNames: [me, '沈禾'], aliases: [], signature: '竹衍服饰 · 订单组', connection: 'example', lastSyncAt: day(0, '07:35'), failedFolders: ['已发送'], example: true },
  );
  const customer = root.customers[0], order = root.orders.find(row => row.code === 'SO-G-2026-018') || root.orders[0], dev = root.devs[0], invoice = root.invoices[0];
  const buyer = { name: 'Emma Clarke', address: 'emma.clarke@cedarcrown.example.invalid' }, ops = { name: 'Sophie Hale', address: 'sophie.hale@cedarcrown.example.invalid' };
  const mine = { name: me, address: 'gu.yan@bambook.example.invalid' }, shared = { name: '订单组', address: 'orders@bambook.example.invalid' };
  const base = (id: string, patch: Partial<EmailMessage>): EmailMessage => ({ id, accountId: 'mail-personal', folder: 'inbox', threadId: id, from: buyer, to: [mine], cc: [], subject: '', body: '', at: day(0, '08:00'), attachments: [], read: false, starred: false, important: false, category: { label: '', source: 'none', detail: '未配置分类规则' }, extracted: [], links: [], followUpTaskIds: [], submissions: [], example: true, ...patch });
  root.email.messages.push(
    base('mail-ex-1', { subject: `PO 确认：${order?.code || '大货订单'} 首批大衣与西装`, body: `Hi ${me},\n\n附件是我方正式 PO CC-PO-88231，请按以下内容安排：\n- 双面羊毛城市大衣 1,200 件，交期 11 月 8 日前离港\n- 雾蓝精纺羊毛西装 800 件\n单价按 10 月报价执行。请回传 PI。\n\nBest,\nEmma\n（示例邮件）`, at: day(0, '08:12'), important: true, attachments: [{ id: 'att-1', name: 'CC-PO-88231.pdf', size: 248000, contentType: 'application/pdf' }], category: { label: '订单确认', source: 'rule', detail: '规则：主题含“PO”且发件人为客户联系人' }, extracted: [{ field: 'PO 号', value: 'CC-PO-88231' }, { field: '数量', value: '大衣 1,200 件；西装 800 件' }, { field: '交期', value: '11 月 8 日前离港' }], links: [...(customer ? [{ kind: 'customer' as const, id: customer.id }] : []), ...(order ? [{ kind: 'order' as const, id: order.id }] : [])] }),
    base('mail-ex-2', { from: ops, subject: `${dev?.code || '开发案'} 二轮样品反馈`, body: `Hi,\n\n二轮样已收到。袖长偏长约 1.2cm，领口挺度可以接受。请确认三轮样寄出日期。\n\nSophie\n（示例邮件）`, at: day(1, '15:20'), read: true, starred: true, attachments: [{ id: 'att-2', name: '二轮样照片.zip', size: 5120000, contentType: 'application/zip' }], category: { label: '样品反馈', source: 'ai', detail: 'AI 结果 · 置信度中，需人工复核' }, extracted: [{ field: '修改意见', value: '袖长偏长约 1.2cm' }], links: dev ? [{ kind: 'development', id: dev.id }] : [] }),
    base('mail-ex-3', { from: { name: 'Sophie Hale', address: 'sophie@cedarcrown.co.uk' }, subject: '付款通知：本周汇出尾款', body: `Hello,\n\n我方本周五会汇出 ${invoice?.code || '发票'} 对应款项，请留意查收。\n\nSophie\n（示例邮件）`, at: day(2, '09:05'), category: { label: '付款', source: 'rule', detail: '规则：正文含“汇出 / 付款”' }, extracted: invoice ? [{ field: '发票号', value: invoice.code }] : [] }),
    base('mail-ex-4', { accountId: 'mail-shared', from: { name: '江南成衣 · 王厂长', address: 'wang@jiangnan-garment.example.invalid' }, to: [shared], subject: '面料到货延迟两天', body: '各位好：\n\n雾蓝精纺面料染厂通知延迟两天到货，西装车缝相应顺延，请业务知悉并评估是否需要告知客户。\n\n王\n（示例邮件）', at: day(0, '07:30'), category: { label: '', source: 'failed', detail: 'AI 分类失败：服务暂不可用，可手动关联' } }),
    base('mail-ex-5', { folder: 'sent', from: mine, to: [buyer], subject: `Re: ${dev?.code || '开发案'} 首样寄出`, body: `Hi Emma,\n\n首样已于今天寄出，运单 SF1234567890（示例）。\n\n${me}\n（示例邮件）`, at: day(5, '10:00'), read: true, category: { label: '样品寄出', source: 'rule', detail: '规则：已发送 · 含运单号' }, links: dev ? [{ kind: 'development', id: dev.id }] : [] }),
  );
}
