import { randomUUID } from 'node:crypto';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import type { TokenPayload } from '../../auth/service';
import { fail } from '../errors';
import type { MistRepository } from '../repository';
import type { MistStoredFile } from '../files';
import { MIST_FILE_MAX_BYTES } from '../files';
import { emailAddresses, emailSendEffectiveStatus, emailSendRecipients, type EmailAccount, type EmailAddress, type EmailDraftInput, type EmailFolderSync, type EmailMessageFolder, type EmailProblem, type EmailSend, type EmailSyncedMessage } from '../../shared/mistEmail';
import type { MistState } from '../../shared/mistWorkspace';
import { MistMailCredentials, type MistMailSecret } from './credentials';
import { classifySmtpError, composeMail, describeMailError, imapSmtpTransport, smtpRejectedReplies, type MailFolderInfo, type MailImapSession, type MailTransport } from './transport';

/** 每次同步每个文件夹最多拉取的邮件数；剩余部分下次同步继续（按 UID 递增，不重复）。 */
export const MAIL_SYNC_BATCH = 100;
const BODY_LIMIT = 100_000;
const MAIL_PORTS = new Set([143, 465, 587, 993]);
const list = (value: string | undefined) => (value || '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);

type Policy = { allowedHosts: string[]; insecureTlsHosts: string[]; allowedRecipientDomains: string[] };
export function mailPolicy(env: NodeJS.ProcessEnv = process.env): Policy {
  return { allowedHosts: list(env.MIST_MAIL_ALLOWED_HOSTS), insecureTlsHosts: list(env.MIST_MAIL_INSECURE_TLS_HOSTS), allowedRecipientDomains: list(env.MIST_MAIL_ALLOWED_RECIPIENT_DOMAINS) };
}

/** 选择实际同步的远端文件夹：收件箱、已发送（特殊用途标记或常见名称）、归档；垃圾箱/垃圾邮件不同步。 */
export function pickMailFolders(folders: MailFolderInfo[]): Array<{ remote: string; folder: EmailMessageFolder }> {
  const has = (f: MailFolderInfo, flag: string) => f.attribs.some(item => item.toLowerCase() === flag.toLowerCase());
  const leaf = (f: MailFolderInfo) => f.path.split(/[/.]/).pop()!.toLowerCase();
  const inbox = folders.find(f => f.path.toUpperCase() === 'INBOX');
  const sent = folders.find(f => has(f, '\\Sent')) || folders.find(f => ['sent', 'sent messages', 'sent items', '已发送'].includes(leaf(f)));
  const archive = folders.find(f => has(f, '\\Archive')) || folders.find(f => ['archive', 'archives', '归档', '已归档'].includes(leaf(f)));
  return [...(inbox ? [{ remote: inbox.path, folder: 'inbox' as const }] : []), ...(sent ? [{ remote: sent.path, folder: 'sent' as const }] : []), ...(archive && archive !== sent ? [{ remote: archive.path, folder: 'archive' as const }] : [])];
}
const addresses = (value: AddressObject | AddressObject[] | undefined): EmailAddress[] => (Array.isArray(value) ? value : value ? [value] : []).flatMap(item => item.value).filter(item => item.address).map(item => ({ name: item.name || '', address: String(item.address).toLowerCase() }));
const problem = (code: string, message: string): EmailProblem => ({ code, message, at: new Date().toISOString() });
const domainOf = (address: string) => address.split('@').pop()!.toLowerCase();
/** 与草稿保存/指纹共用同一解析规则：逗号、分号（含全角）、空白均为分隔符。 */
const recipients = (value: string, label = '收件人') => emailAddresses(value || '', label);

export class MistMailService {
  private readonly busy = new Map<string, true>();
  constructor(private readonly repository: MistRepository, private readonly credentials: MistMailCredentials, private readonly transport: MailTransport = imapSmtpTransport, private readonly env: NodeJS.ProcessEnv = process.env, private readonly now = () => new Date()) {}

  private policy() { return mailPolicy(this.env); }
  private exclusive<T>(key: string, label: string, run: () => Promise<T>): Promise<T> {
    if (this.busy.has(key)) fail('MAIL_BUSY', `${label}正在进行，请稍后查看结果`, 409);
    this.busy.set(key, true);
    return run().finally(() => this.busy.delete(key));
  }
  /** 只在本人/授权成员可见范围内找真实账号；示例邮箱没有收发能力。 */
  private async account(prior: TokenPayload, workspaceId: string, accountId: string) {
    const snapshot = await this.repository.mailSnapshot(prior, workspaceId);
    const account = snapshot.state.email.accounts.find(row => row.id === accountId);
    if (!account) fail('NOT_FOUND', '邮箱不存在或当前账号无权使用', 404);
    if (account!.example || !account!.transport) fail('PRECONDITION', '示例邮箱没有真实收发服务', 422);
    return { ...snapshot, account: account! };
  }
  private checkHosts(account: EmailAccount) {
    const policy = this.policy(), t = account.transport!;
    for (const [host, port, label] of [[t.imapHost, t.imapPort, '收信'], [t.smtpHost, t.smtpPort, '发信']] as const) {
      if (policy.allowedHosts.length ? !policy.allowedHosts.includes(host) : !MAIL_PORTS.has(port)) fail('MAIL_HOST_NOT_ALLOWED', `${label}服务器 ${host}:${port} 不在允许范围内`, 422);
    }
  }
  private insecure(host: string) { return this.policy().insecureTlsHosts.includes(host.toLowerCase()); }
  private async secret(workspaceId: string, account: EmailAccount): Promise<MistMailSecret> {
    if (!account.credentialSet) fail('MAIL_CREDENTIAL_MISSING', '该邮箱尚未完成凭据绑定', 422);
    const secret = await this.credentials.load(workspaceId, account.id);
    if (!secret || secret.username !== account.transport!.username) fail('MAIL_CREDENTIAL_MISSING', '服务器上没有该邮箱的有效凭据，请重新绑定', 422);
    return secret!;
  }
  private async imap(account: EmailAccount, secret: MistMailSecret) { return this.transport.imap(account.transport!, secret, this.insecure(account.transport!.imapHost)); }
  private write(prior: TokenPayload, workspaceId: string, type: string, payload: Record<string, unknown>) { return this.repository.executeMail(prior, workspaceId, { type, payload }); }

  /** 绑定凭据：先真实登录收信与发信服务器，成功才写入服务端凭据目录；密码不回传、不落工作空间。 */
  async bindCredential(prior: TokenPayload, workspaceId: string, accountId: string, password: unknown) {
    if (typeof password !== 'string' || !password || password.length > 1024) fail('INVALID_INPUT', '请填写邮箱密码或授权码', 400);
    const { account } = await this.account(prior, workspaceId, accountId);
    if (account.ownerId !== prior.userId) fail('FORBIDDEN', '只有接入该邮箱的本人可以绑定凭据', 403);
    this.checkHosts(account);
    const secret = { username: account.transport!.username, password: password as string };
    return this.exclusive(`${workspaceId}:${accountId}`, '该邮箱的连接操作', async () => {
      let stage: 'imap' | 'smtp' = 'imap';
      try {
        const session = await this.imap(account, secret);
        try { await session.folders(); } finally { await session.close(); }
        stage = 'smtp';
        await this.transport.smtpVerify(account.transport!, secret, this.insecure(account.transport!.smtpHost));
      } catch (error) {
        const reason = describeMailError(error, stage);
        await this.write(prior, workspaceId, 'email.server.account', { id: accountId, lastError: problem(reason.code, reason.message), ...(account.credentialSet ? {} : { connection: 'error' }) });
        fail(reason.code, `${reason.message}；凭据未保存`, 422);
      }
      await this.credentials.save(workspaceId, accountId, secret);
      return this.write(prior, workspaceId, 'email.server.account', { id: accountId, credentialSet: true, connection: 'connected', lastError: null });
    });
  }
  async disconnect(prior: TokenPayload, workspaceId: string, accountId: string) {
    const { account } = await this.account(prior, workspaceId, accountId);
    if (account.ownerId !== prior.userId) fail('FORBIDDEN', '只有接入该邮箱的本人可以断开', 403);
    await this.credentials.remove(workspaceId, accountId);
    return this.write(prior, workspaceId, 'email.server.account', { id: accountId, credentialSet: false, lastError: null });
  }

  /** 增量同步：逐文件夹按 UIDVALIDITY + UID 拉取，附件先写私有文件再随同步结果一次落库；失败文件夹单独记录。 */
  async sync(prior: TokenPayload, workspaceId: string, accountId: string) {
    const { account } = await this.account(prior, workspaceId, accountId);
    this.checkHosts(account);
    const secret = await this.secret(workspaceId, account);
    return this.exclusive(`${workspaceId}:${accountId}`, '该邮箱的同步', async () => {
      await this.write(prior, workspaceId, 'email.server.account', { id: accountId, connection: 'syncing', syncStartedAt: this.now().toISOString() });
      const files: MistStoredFile[] = [], storage = this.repository.mailFiles();
      const cleanup = async (keep: Set<string>) => { for (const file of files) if (!keep.has(file.id)) await storage.remove(workspaceId, file).catch(() => undefined); };
      let session: MailImapSession | undefined;
      const folders: EmailFolderSync[] = [], messages: EmailSyncedMessage[] = []; let lastError: EmailProblem | null = null, remaining = 0;
      try {
        try { session = await this.imap(account, secret); } catch (error) { const reason = describeMailError(error, 'imap'); lastError = problem(reason.code, reason.message); }
        if (session) {
          let targets: Array<{ remote: string; folder: EmailMessageFolder }> = [];
          try { targets = pickMailFolders(await session.folders()); } catch (error) { const reason = describeMailError(error, 'imap'); lastError = problem(reason.code, `读取文件夹列表失败：${reason.message}`); }
          for (const target of targets) {
            const known = (account.folders || []).find(item => item.remote === target.remote), at = this.now().toISOString();
            try {
              const box = await session.open(target.remote);
              const after = known && known.uidValidity === box.uidValidity ? known.lastUid : 0;
              const uids = await session.uidsAfter(after), batch = uids.slice(0, MAIL_SYNC_BATCH);
              remaining += uids.length - batch.length;
              let lastUid = after;
              for (const row of await session.fetch(batch)) {
                messages.push(await this.parse(workspaceId, row.raw, row.uid, row.seen, target, box.uidValidity, files));
                lastUid = Math.max(lastUid, row.uid);
              }
              folders.push({ remote: target.remote, folder: target.folder, uidValidity: box.uidValidity, lastUid, lastSyncAt: at });
            } catch (error) {
              const reason = describeMailError(error, 'imap');
              folders.push({ remote: target.remote, folder: target.folder, uidValidity: known?.uidValidity || 0, lastUid: known?.lastUid || 0, lastSyncAt: known?.lastSyncAt || null, error: reason.message });
            }
          }
          if (!targets.length && !lastError) lastError = problem('MAIL_NO_FOLDERS', '收信服务器没有可同步的收件箱');
        }
        const result = await this.write(prior, workspaceId, 'email.server.sync', { accountId, source: account.sourceGeneration || 1, at: this.now().toISOString(), folders, messages, files, lastError });
        await cleanup(new Set(((result.receipt as any)?.result?.fileIds || []) as string[]));
        return { ...result, sync: { ...(result.receipt as any)?.result, remaining, failedFolders: folders.filter(f => f.error).map(f => f.remote), error: lastError?.message || null } };
      } catch (error) {
        await cleanup(new Set());
        // 写回失败时把"同步中"复位，避免账号停在同步中。
        await this.write(prior, workspaceId, 'email.server.account', { id: accountId, connection: account.connection === 'syncing' ? 'connected' : account.connection, syncStartedAt: null }).catch(() => undefined);
        throw error;
      } finally { await session?.close(); }
    });
  }
  private async parse(workspaceId: string, raw: Buffer, uid: number, seen: boolean, target: { remote: string; folder: EmailMessageFolder }, uidValidity: number, files: MistStoredFile[]): Promise<EmailSyncedMessage> {
    let mail: ParsedMail | undefined;
    try { mail = await simpleParser(raw, { skipHtmlToText: false, skipTextLinks: true }); } catch { mail = undefined; }
    const base = { remote: { folder: target.remote, uid, uidValidity }, folder: target.folder, read: seen };
    if (!mail) return { ...base, messageId: '', inReplyTo: '', references: [], from: { name: '', address: '' }, to: [], cc: [], subject: '（邮件无法解析）', body: '这封邮件的内容无法解析，请在原邮箱中查看。', at: this.now().toISOString(), attachments: [] };
    const attachments: EmailSyncedMessage['attachments'] = [];
    for (const item of mail.attachments || []) {
      const name = (item.filename || '未命名附件').slice(0, 240), size = item.size || item.content?.length || 0, contentType = item.contentType || 'application/octet-stream';
      if (!item.content?.length) continue;
      if (size > MIST_FILE_MAX_BYTES) { attachments.push({ id: randomUUID(), name, size, contentType, omitted: '超过 50MiB，未保存，请在原邮箱中查看' }); continue; }
      const stored = await this.repository.mailFiles().write(workspaceId, { bytes: item.content, name, mimeType: contentType }, this.now().toISOString());
      files.push(stored);
      attachments.push({ id: randomUUID(), name: stored.name, size: stored.size, contentType, fileId: stored.id });
    }
    const references = Array.isArray(mail.references) ? mail.references : mail.references ? [mail.references] : [];
    const body = (mail.text || (typeof mail.html === 'string' ? mail.html.replace(/<[^>]+>/g, ' ') : '') || '').slice(0, BODY_LIMIT);
    return { ...base, messageId: mail.messageId || '', inReplyTo: mail.inReplyTo || '', references, from: addresses(mail.from)[0] || { name: '', address: '' }, to: addresses(mail.to), cc: addresses(mail.cc), subject: mail.subject || '（无主题）', body, at: (mail.date || this.now()).toISOString(), attachments };
  }

  private checkRecipients(send: Pick<EmailSend, 'to' | 'cc' | 'bcc'>) {
    // 在登记发送意图之前按共享规则拆分 To/CC/BCC，每个地址都按小写域名检查；未配置白名单时不限制。
    const allowed = this.policy().allowedRecipientDomains, all = [...recipients(send.to, '收件人'), ...recipients(send.cc, '抄送'), ...recipients(send.bcc, '密送')].map(item => item.toLowerCase());
    if (!all.length) fail('VALIDATION', '请填写收件人', 422);
    if (allowed.length) for (const address of all) if (!allowed.includes(domainOf(address))) fail('MAIL_RECIPIENT_NOT_ALLOWED', `收件人 ${address} 不在允许投递的域名内`, 422);
  }
  /** 发送：先持久化"发送中"记录（同一 requestKey 只登记一次），再投递；结果按 accepted / failed / unknown 写回。 */
  async send(prior: TokenPayload, workspaceId: string, body: { requestKey?: unknown; draftId?: unknown; input?: unknown; forwardOfId?: unknown }) {
    const input = (body.input && typeof body.input === 'object' ? body.input : {}) as EmailDraftInput;
    const { account } = await this.account(prior, workspaceId, String(input.accountId || ''));
    this.checkHosts(account); this.checkRecipients({ to: String(input.to || ''), cc: String(input.cc || ''), bcc: String(input.bcc || '') });
    const begun = await this.write(prior, workspaceId, 'email.server.send.begin', { mode: 'new', requestKey: body.requestKey, ...(body.draftId ? { draftId: String(body.draftId) } : {}), input, ...(body.forwardOfId ? { forwardOfId: String(body.forwardOfId) } : {}), messageId: `<${randomUUID()}@${domainOf(account.address)}>` });
    const started = (begun.receipt as any).result as { id: string; status: string; existing: boolean; recovered?: boolean; recoveredFor?: string };
    // 同一意图重放或同草稿/同内容的未决发送：返回原记录，不再投递；recoveredFor 表示服务端已把本次 requestKey 登记为原记录的别名。
    if (started.existing) return { ...begun, send: { id: started.id, status: started.status, replayed: true, ...(started.recovered ? { recovered: true } : {}), ...(started.recoveredFor ? { recoveredFor: started.recoveredFor } : {}) } };
    return this.deliver(prior, workspaceId, started.id);
  }
  async retry(prior: TokenPayload, workspaceId: string, sendId: string, confirmUnknown: unknown) {
    const snapshot = await this.repository.mailSnapshot(prior, workspaceId), record = snapshot.state.email.sends.find(row => row.id === sendId);
    if (!record) fail('NOT_FOUND', '发送记录不存在', 404);
    const account = snapshot.state.email.accounts.find(row => row.id === record!.accountId)!;
    this.checkHosts(account); this.checkRecipients(record!); await this.secret(workspaceId, account);
    await this.write(prior, workspaceId, 'email.server.send.begin', { mode: 'retry', id: sendId, confirmUnknown: confirmUnknown === true });
    return this.deliver(prior, workspaceId, sendId);
  }
  private async deliver(prior: TokenPayload, workspaceId: string, sendId: string) {
    return this.exclusive(`send:${workspaceId}:${sendId}`, '该邮件的发送', async () => {
      const { state } = await this.repository.mailSnapshot(prior, workspaceId);
      const record = state.email.sends.find(row => row.id === sendId)!, account = state.email.accounts.find(row => row.id === record.accountId)!;
      const finish = (outcome: string, code: string, message: string, response = '', accepted: string[] = [], rejected: Array<{ address: string; reply: string }> = []) => this.write(prior, workspaceId, 'email.server.send.finish', { id: sendId, outcome, code, message, response, accepted, rejected });
      let raw: Buffer, secret: MistMailSecret;
      try {
        secret = await this.secret(workspaceId, account);
        raw = await this.compose(prior, workspaceId, state, record, account);
      } catch (error: any) {
        const result = await finish('failed', String(error?.code || 'MAIL_PREPARE_FAILED'), String(error?.message || '邮件准备失败，未发送'));
        return { ...result, send: { id: sendId, status: 'failed', message: String(error?.message || '邮件准备失败，未发送') } };
      }
      // 只投递给本次待投递的收件人（新发送为全部；重发时只含之前未被接收的收件人）。
      const envelope = emailSendRecipients(record).filter(row => row.status === 'pending').map(row => row.address);
      if (!envelope.length) { const result = await finish('failed', 'MAIL_NO_PENDING_RECIPIENTS', '没有需要投递的收件人'); return { ...result, send: { id: sendId, status: (result.receipt as any)?.result?.status || 'failed', message: '没有需要投递的收件人' } }; }
      let outcome: 'accepted' | 'failed' | 'unknown', code = 'SMTP_ACCEPTED', message = '发信服务器已接收', response = '';
      let accepted: string[] = [], rejected: Array<{ address: string; reply: string }> = [];
      try {
        const info = await this.transport.smtpSend(account.transport!, secret!, this.insecure(account.transport!.smtpHost), { from: record.from, to: envelope }, raw!);
        outcome = 'accepted'; response = info.response; accepted = info.accepted.map(item => item.toLowerCase());
        rejected = info.rejectedReplies?.length ? info.rejectedReplies : info.rejected.map(address => ({ address: address.toLowerCase(), reply: '' }));
        if (rejected.length) { code = 'SMTP_PARTIAL'; message = `发信服务器只接收了部分收件人；被拒：${rejected.map(item => item.address).join('、')}`; }
      } catch (error: any) {
        outcome = classifySmtpError(error); const reason = describeMailError(error, 'smtp');
        code = outcome === 'failed' ? reason.code : 'SEND_RESULT_UNCERTAIN';
        message = outcome === 'failed' ? `${reason.message}，邮件未发出` : '与发信服务器的连接在投递过程中中断，无法确认对方是否收到；请先核对，勿直接重发';
        response = String(error?.response || (error?.responseCode ? error?.message : '') || '').slice(0, 300);
        if (outcome === 'failed') rejected = smtpRejectedReplies(error);
      }
      // 写回失败时记录仍是"发送中"，超时后显示为"结果待核对"，不会被自动重发。
      const result = await finish(outcome, code, message, response, accepted, rejected), done = (result.receipt as any)?.result || {};
      // 远端"已发送"只在第一次有收件人被接收时写入一次，重发被拒收件人不再重复写入。
      if (done.firstCopy) await this.appendSent(account, secret!, raw!).catch(() => undefined);
      return { ...result, send: { id: sendId, status: done.status || (outcome === 'accepted' ? 'sent' : outcome), message, recipients: done.recipients || [] } };
    });
  }
  private async compose(prior: TokenPayload, workspaceId: string, state: MistState, record: EmailSend, account: EmailAccount) {
    const storage = this.repository.mailFiles(), attachments = [];
    for (const fileId of record.fileIds) {
      const file = state.files.find(row => row.id === fileId);
      if (!file) fail('MAIL_ATTACHMENT_UNAVAILABLE', '附件不存在或当前账号无权使用，邮件未发出', 422);
      attachments.push({ filename: file!.name, contentType: file!.mimeType, content: await storage.read(workspaceId, file as MistStoredFile) });
    }
    const parent = record.replyToId ? state.email.messages.find(row => row.id === record.replyToId) : undefined;
    void prior;
    return composeMail({ from: { name: account.displayName, address: record.from }, to: recipients(record.to), cc: recipients(record.cc), subject: record.subject, text: record.body, messageId: record.messageId, date: new Date(record.createdAt), inReplyTo: parent?.messageId, references: parent?.messageId ? [parent.messageId] : [], attachments });
  }
  /** 与常见邮件客户端一致：投递成功后把同一份原文写入远端"已发送"，便于之后核对与同步合并。 */
  private async appendSent(account: EmailAccount, secret: MistMailSecret, raw: Buffer) {
    const session = await this.imap(account, secret);
    try { const sent = pickMailFolders(await session.folders()).find(item => item.folder === 'sent'); if (sent) await session.append(sent.remote, raw); } finally { await session.close(); }
  }
  /** 核对结果不确定的发送：只在本邮箱自身的文件夹中按 Message-ID 查找，不读其他邮箱。找到副本只在待确认收件人全是本邮箱地址时才确认已接收；否则仅记录"本邮箱有副本"。 */
  async verify(prior: TokenPayload, workspaceId: string, sendId: string) {
    const snapshot = await this.repository.mailSnapshot(prior, workspaceId), record = snapshot.state.email.sends.find(row => row.id === sendId);
    if (!record) fail('NOT_FOUND', '发送记录不存在', 404);
    if (emailSendEffectiveStatus(record!, this.now().getTime()) !== 'unknown') fail('PRECONDITION', '只有结果待核对的发送需要核对', 422);
    const account = snapshot.state.email.accounts.find(row => row.id === record!.accountId)!, secret = await this.secret(workspaceId, account);
    const foundIn: EmailMessageFolder[] = [];
    const session = await this.imap(account, secret).catch(error => { const reason = describeMailError(error, 'imap'); return fail(reason.code, `${reason.message}，无法核对`, 422); });
    try {
      // 逐个查本邮箱自身的收件箱/已发送/归档，记录副本出现在哪里；只有收件箱副本才可能确认"本邮箱作为收件人已收到"。
      for (const target of pickMailFolders(await session.folders())) { await session.open(target.remote); if (await session.hasMessageId(record!.messageId)) foundIn.push(target.folder); }
    } finally { await session.close(); }
    const found = foundIn.length > 0;
    // 只读本邮箱自身的文件夹；找到副本能否确认由共享规则决定（仅收件箱副本且待确认收件人全是本邮箱地址时才确认）。
    const result = await this.write(prior, workspaceId, 'email.server.send.finish', { id: sendId, outcome: found ? 'verified' : 'not_found', code: found ? 'MESSAGE_ID_FOUND' : 'MESSAGE_ID_NOT_FOUND', message: found ? '已在本邮箱中找到该邮件' : '本邮箱中未找到该邮件', response: found ? '按 Message-ID 在本邮箱中核对到' : '', foundIn });
    const done = (result.receipt as any)?.result || {};
    return { ...result, send: { id: sendId, status: done.status || 'unknown', found, foundIn, confirmed: !!done.confirmed, recipients: done.recipients || [] } };
  }
}
