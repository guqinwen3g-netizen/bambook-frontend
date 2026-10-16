import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMistLocalRuntime } from '../local';
import { createMistServer } from '../server';
import { composeMail, classifySmtpError, describeMailError, type MailImapSession, type MailTransport } from './transport';
import { pickMailFolders } from './service';

/**
 * 智能邮箱收发：用内存 IMAP/SMTP 替身覆盖服务端全链路（凭据、同步去重、附件隔离、发送幂等与安全重试）。
 * 真实协议另在服务器内部测试邮箱上实测，见交付记录。
 */
type Box = { uidValidity: number; nextUid: number; attribs: string[]; messages: Array<{ uid: number; raw: Buffer; seen: boolean }>; fail?: boolean };
type Mailbox = { password: string; boxes: Map<string, Box> };
const SECRET = 'S3cret-only-in-test';
class FakeMail {
  boxes = new Map<string, Mailbox>(); deliveries: Array<{ from: string; to: string[]; raw: Buffer }> = []; attemptsSeen: string[][] = []; smtpMode: 'ok' | 'reject-login' | 'drop-after-data' | 'deliver-then-drop' = 'ok';
  /** 服务器在 RCPT 阶段拒收的地址（550 原文）；全部被拒时与真实 SMTP 一样以信封错误结束，不提交正文。 */
  rejectRcpt = new Set<string>();
  add(address: string, password = SECRET) { this.boxes.set(address, { password, boxes: new Map([['INBOX', { uidValidity: 7, nextUid: 1, attribs: [], messages: [] }], ['Sent', { uidValidity: 9, nextUid: 1, attribs: ['\\Sent'], messages: [] }], ['Trash', { uidValidity: 3, nextUid: 1, attribs: ['\\Trash'], messages: [] }]]) }); }
  put(address: string, folder: string, raw: Buffer, seen = false) { const box = this.boxes.get(address)!.boxes.get(folder)!; box.messages.push({ uid: box.nextUid++, raw, seen }); }
  login(user: string, password: string) { const box = this.boxes.get(user); if (!box || box.password !== password) throw Object.assign(new Error('Invalid credentials (Failure)'), { textCode: 'AUTHENTICATIONFAILED', source: 'authentication' }); return box; }
  transport(): MailTransport {
    const self = this;
    return {
      async imap(_config, secret) {
        const mailbox = self.login(secret.username, secret.password); let open: Box | undefined;
        const session: MailImapSession = {
          async folders() { return [...mailbox.boxes.entries()].map(([p, b]) => ({ path: p, attribs: b.attribs })); },
          async open(p) { const box = mailbox.boxes.get(p); if (!box || box.fail) throw Object.assign(new Error('Mailbox unavailable'), { textCode: 'UNAVAILABLE' }); open = box; return { uidValidity: box.uidValidity, uidNext: box.nextUid }; },
          async uidsAfter(after) { return open!.messages.filter(m => m.uid > after).map(m => m.uid); },
          async fetch(uids) { return open!.messages.filter(m => uids.includes(m.uid)).map(m => ({ uid: m.uid, seen: m.seen, raw: m.raw })); },
          async hasMessageId(id) { return open!.messages.some(m => m.raw.toString('utf8').includes(id)); },
          async append(p, raw) { const box = mailbox.boxes.get(p)!; box.messages.push({ uid: box.nextUid++, raw, seen: true }); },
          async close() { /* noop */ },
        };
        return session;
      },
      async smtpVerify(_config, secret) { if (self.smtpMode === 'reject-login') throw Object.assign(new Error('Invalid login'), { code: 'EAUTH', mailStage: 'login', mailReplied: true }); self.login(secret.username, secret.password); },
      async smtpSend(_config, secret, _insecure, envelope, raw) {
        if (self.smtpMode === 'reject-login') throw Object.assign(new Error('Invalid login: 535'), { code: 'EAUTH', responseCode: 535, mailStage: 'login', mailReplied: true });
        self.login(secret.username, secret.password);
        if (self.smtpMode === 'drop-after-data') throw Object.assign(new Error('Connection closed unexpectedly'), { code: 'ECONNECTION', command: 'CONN', mailStage: 'send', mailReplied: false });
        const rejected = envelope.to.filter(to => self.rejectRcpt.has(to)), accepted = envelope.to.filter(to => !self.rejectRcpt.has(to));
        const rejectedErrors = rejected.map(to => Object.assign(new Error('Recipient command failed'), { recipient: to, responseCode: 550, response: `550 5.1.1 <${to}>: Recipient address rejected: User unknown` }));
        self.attemptsSeen.push([...envelope.to]);
        if (!accepted.length) throw Object.assign(new Error("Can't send mail - all recipients were rejected"), { code: 'EENVELOPE', responseCode: 550, response: rejectedErrors[0]?.response, rejected, rejectedErrors, mailStage: 'send', mailReplied: true });
        self.deliveries.push({ from: envelope.from, to: accepted, raw });
        for (const to of accepted) if (self.boxes.has(to)) self.put(to, 'INBOX', raw);
        if (self.smtpMode === 'deliver-then-drop') throw Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT', command: 'CONN', mailStage: 'send', mailReplied: false });
        return { response: '250 2.0.0 Ok: queued as TEST', accepted, rejected, rejectedReplies: rejected.map((address, i) => ({ address, reply: rejectedErrors[i].response })) };
      },
    };
  }
}
const transport = (host = '127.0.0.1') => ({ imapHost: host, imapPort: 993, imapSecure: true, smtpHost: host, smtpPort: 587, smtpSecure: false });
const raw = (subject: string, opts: { from?: string; to?: string; messageId?: string; inReplyTo?: string; attachment?: { name: string; body: string } } = {}) => composeMail({ from: { name: 'Buyer Demo', address: opts.from || 'customer-demo@sylway.cloud' }, to: [opts.to || 'sales@sylway.cloud'], cc: [], subject, text: `正文：${subject}`, messageId: opts.messageId || `<${subject.replace(/\W/g, '')}-${Math.random().toString(36).slice(2)}@sylway.cloud>`, date: new Date('2026-10-16T08:00:00Z'), inReplyTo: opts.inReplyTo, attachments: opts.attachment ? [{ filename: opts.attachment.name, contentType: 'text/plain', content: Buffer.from(opts.attachment.body) }] : [] });

let directory: string, fake: FakeMail, n = 0;
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mist-mail-')); vi.stubEnv('MIST_LOCAL_WORKSPACE', '1'); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('MIST_MAIL_ALLOWED_HOSTS', '127.0.0.1'); vi.stubEnv('MIST_MAIL_INSECURE_TLS_HOSTS', '127.0.0.1'); fake = new FakeMail(); fake.add('sales@sylway.cloud'); fake.add('customer-demo@sylway.cloud'); fake.add('finance@sylway.cloud'); });
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(directory, { recursive: true, force: true }); });
const W = '/api/mist/workspaces/';
async function setup() {
  const local = createMistLocalRuntime({ directory }), app = createMistServer(undefined, { local, mailTransport: fake.transport() });
  const owner = request.agent(app); await owner.get('/api/mist/session').expect(200);
  let ws = (await owner.get(W + 'default').expect(200)).body.workspace;
  const latest = async (client = owner) => (ws = (await client.get(W + ws.id).expect(200)).body.workspace);
  const command = async (type: string, payload: unknown, client = owner, status = 200) => { await latest(client); const r = await client.post(W + ws.id + '/commands').send({ requestId: 'mail-test-' + (++n), expectedRevision: ws.revision, command: { type, payload } }).expect(status); if (status === 200) ws = r.body.workspace; return r.body; };
  const account = async (address: string, kind: 'personal' | 'shared' = 'personal', memberIds: string[] = [], client = owner) => {
    const body = await command('email.account.save', { input: { address, displayName: address.split('@')[0], kind, memberIds, aliases: [], signature: '', transport: { ...transport(), username: address } } }, client);
    return body.receipt.result.id as string;
  };
  const bind = async (id: string, password = SECRET, client = owner, status = 200) => { const r = await client.put(W + ws.id + "/email/accounts/" + id + "/credential").send({ password }); if (r.status !== status) throw new Error(JSON.stringify(r.body)); return r; };
  const sync = (id: string, client = owner, status = 200) => client.post(W + ws.id + '/email/accounts/' + id + '/sync').send({}).expect(status);
  return { app, local, owner, get ws() { return ws; }, latest, command, account, bind, sync };
}
const realMessages = (ws: any, accountId: string) => ws.state.email.messages.filter((m: any) => m.accountId === accountId);

describe('智能邮箱真实收发（服务端）', () => {
  it('凭据只在登录校验成功后写入服务端私有文件，绝不回传或进入工作空间', async () => {
    const t = await setup(), id = await t.account('sales@sylway.cloud');
    const wrong = await t.bind(id, 'wrong-password', t.owner, 422);
    expect(wrong.body.error.code).toBe('MAIL_AUTH_FAILED');
    await expect(fs.stat(path.join(directory, 'mail-credentials', t.ws.id, id + '.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    let ws = await t.latest();
    expect(ws.state.email.accounts.find((a: any) => a.id === id)).toMatchObject({ connection: 'error', credentialSet: false, lastError: { code: 'MAIL_AUTH_FAILED' } });
    const ok = await t.bind(id);
    expect(ok.body.workspace.state.email.accounts.find((a: any) => a.id === id)).toMatchObject({ connection: 'connected', credentialSet: true, lastError: null });
    const stat = await fs.stat(path.join(directory, 'mail-credentials', t.ws.id, id + '.json'));
    expect(stat.mode & 0o777).toBe(0o600);
    ws = await t.latest();
    const store = await fs.readFile(path.join(directory, 'store.json'), 'utf8');
    for (const text of [JSON.stringify(ok.body), JSON.stringify(ws), store]) expect(text).not.toContain(SECRET);
    // 共享邮箱接入需要邮件账户管理权限；成员只能是本空间成员（按用户 ID）。
    await t.command('email.account.save', { input: { address: 'orders@sylway.cloud', displayName: 'orders', kind: 'shared', memberIds: ['someone-else'], aliases: [], signature: '', transport: { ...transport(), username: 'orders@sylway.cloud' } } }, t.owner, 404);
  });

  it('客户端不能直接写入收信/发信结果；不在允许范围的服务器被拒绝', async () => {
    const t = await setup(), id = await t.account('sales@sylway.cloud');
    const forged = await t.command('email.server.sync', { accountId: id, at: new Date().toISOString(), folders: [], messages: [], files: [], lastError: null }, t.owner, 400);
    expect(forged.error.code).toBe('INVALID_COMMAND');
    await t.command('email.server.send.finish', { id: 'x', outcome: 'accepted', code: '', message: '' }, t.owner, 400);
    await t.command('email.account.save', { id, input: { address: 'sales@sylway.cloud', displayName: 'sales', kind: 'personal', memberIds: [], aliases: [], signature: '', transport: { ...transport('10.0.0.8'), username: 'sales@sylway.cloud' } } });
    expect((await t.bind(id, SECRET, t.owner, 422)).body.error.code).toBe('MAIL_HOST_NOT_ALLOWED');
  });

  it('按 UIDVALIDITY + UID 增量同步，不重复入库；附件写入私有文件并可下载；部分文件夹失败单独记录', async () => {
    const t = await setup(), id = await t.account('sales@sylway.cloud'); await t.bind(id);
    fake.put('sales@sylway.cloud', 'INBOX', await raw('PO 确认', { attachment: { name: 'po.txt', body: 'PO-88231 内容' } }));
    fake.put('sales@sylway.cloud', 'Sent', await raw('样品寄出', { from: 'sales@sylway.cloud', to: 'customer-demo@sylway.cloud' }), true);
    fake.put('sales@sylway.cloud', 'Trash', await raw('垃圾'));
    const first = await t.sync(id);
    expect(first.body.sync).toMatchObject({ added: 2, skipped: 0 });
    let ws = first.body.workspace, rows = realMessages(ws, id);
    expect(rows.map((m: any) => [m.folder, m.subject, m.example]).sort()).toEqual([['inbox', 'PO 确认', false], ['sent', '样品寄出', false]]);
    const po = rows.find((m: any) => m.subject === 'PO 确认');
    expect(po.remote).toEqual({ folder: 'INBOX', uid: 1, uidValidity: 7 });
    expect(po.attachments[0]).toMatchObject({ name: 'po.txt', fileId: expect.any(String) });
    const download = await t.owner.get(W + ws.id + '/files/' + po.attachments[0].fileId).buffer(true).expect(200);
    expect(Buffer.from(download.body).toString('utf8')).toBe('PO-88231 内容');
    // 再同步：没有新邮件，不重复
    const again = await t.sync(id);
    expect(again.body.sync).toMatchObject({ added: 0 }); expect(realMessages(again.body.workspace, id)).toHaveLength(2);
    // 新邮件只增量拉取；已发送文件夹失败时其余照常，并保留失败记录
    fake.put('sales@sylway.cloud', 'INBOX', await raw('付款通知'));
    fake.boxes.get('sales@sylway.cloud')!.boxes.get('Sent')!.fail = true;
    const partial = await t.sync(id);
    ws = partial.body.workspace;
    expect(realMessages(ws, id)).toHaveLength(3);
    expect(ws.state.email.accounts.find((a: any) => a.id === id)).toMatchObject({ connection: 'partial', failedFolders: ['已发送'] });
    fake.boxes.get('sales@sylway.cloud')!.boxes.get('Sent')!.fail = false;
    // UIDVALIDITY 变化：重新编号的同一封邮件按 Message-ID 认回，不重复
    const inbox = fake.boxes.get('sales@sylway.cloud')!.boxes.get('INBOX')!; inbox.uidValidity = 8; inbox.messages.forEach((m, i) => { m.uid = 100 + i; }); inbox.nextUid = 200;
    const reset = await t.sync(id);
    expect(reset.body.sync.added).toBe(0); expect(reset.body.sync.merged).toBe(2);
    expect(realMessages(reset.body.workspace, id)).toHaveLength(3);
    expect(reset.body.workspace.state.email.accounts.find((a: any) => a.id === id)).toMatchObject({ connection: 'connected', failedFolders: [] });
  });

  it('连接或认证失败时同步记录错误，不改动已同步邮件', async () => {
    const t = await setup(), id = await t.account('sales@sylway.cloud'); await t.bind(id);
    fake.put('sales@sylway.cloud', 'INBOX', await raw('第一封'));
    await t.sync(id);
    fake.boxes.get('sales@sylway.cloud')!.password = 'rotated';
    const failed = await t.sync(id);
    expect(failed.body.sync.error).toContain('用户名或密码不正确');
    expect(failed.body.workspace.state.email.accounts.find((a: any) => a.id === id)).toMatchObject({ connection: 'error', lastError: { code: 'MAIL_AUTH_FAILED' } });
    expect(realMessages(failed.body.workspace, id)).toHaveLength(1);
  });

  it('按用户 ID 隔离：成员看不到他人个人邮箱的邮件与附件，也不能操作；共享邮箱只给授权成员', async () => {
    const t = await setup(), personal = await t.account('sales@sylway.cloud'); await t.bind(personal);
    fake.put('sales@sylway.cloud', 'INBOX', await raw('私人报价', { attachment: { name: 'secret.txt', body: 'private' } }));
    const synced = (await t.sync(personal)).body.workspace, mail = realMessages(synced, personal)[0];
    await t.command('email.followUp', { id: mail.id, owner: '本地操作员', due: '2026-10-20', note: '' });
    await request(t.app).get('/api/mist/session');
    // 授权 local-sales 进入工作空间
    await t.latest();
    await t.owner.post(W + t.ws.id + '/members').send({ requestId: 'mail-member-' + (++n), expectedRevision: t.ws.revision, action: 'add', account: 'local-sales' }).expect(200);
    const shared = await t.account('finance@sylway.cloud', 'shared', ['local-sales']); await t.bind(shared);
    fake.put('finance@sylway.cloud', 'INBOX', await raw('共享来信', { to: 'finance@sylway.cloud' }));
    await t.sync(shared);
    const sales = request.agent(t.app); await sales.get('/api/mist/session').expect(200); await sales.post('/api/mist/session').send({ profileId: 'local-sales' }).expect(200);
    const seen = (await sales.get(W + t.ws.id).expect(200)).body.workspace;
    const text = JSON.stringify(seen);
    expect(seen.state.email.accounts.map((a: any) => a.address)).toContain('finance@sylway.cloud');
    expect(seen.state.email.accounts.map((a: any) => a.address)).not.toContain('sales@sylway.cloud');
    expect(text).not.toContain('私人报价'); expect(text).not.toContain(mail.id);
    expect(seen.state.email.messages.map((m: any) => m.subject)).toContain('共享来信');
    await sales.get(W + t.ws.id + '/files/' + mail.attachments[0].fileId).expect(404);
    const flag = await sales.post(W + t.ws.id + '/commands').send({ requestId: 'mail-test-' + (++n), expectedRevision: seen.revision, command: { type: 'email.flag', payload: { id: mail.id, flag: 'starred', value: true } } }).expect(404);
    expect(flag.body.error.code).toBe('NOT_FOUND');
    await sales.post(W + t.ws.id + '/email/accounts/' + personal + '/sync').send({}).expect(404);
    // 成员不能把他人邮件的附件挂进草稿
    await sales.post(W + t.ws.id + '/commands').send({ requestId: 'mail-test-' + (++n), expectedRevision: seen.revision, command: { type: 'email.draft.save', payload: { input: { accountId: shared, from: 'finance@sylway.cloud', to: 'x@sylway.cloud', cc: '', bcc: '', subject: 's', body: '', template: '', links: [], fileIds: [mail.attachments[0].fileId] } } } }).expect(404);
    // 共享成员不是接入人：不能改账号设置或绑定凭据
    await sales.put(W + t.ws.id + '/email/accounts/' + shared + '/credential').send({ password: SECRET }).expect(403);
  });

  it('回复经 SMTP 真实投递，生成已发送记录并保留来源；同一请求重放不重复投递', async () => {
    const t = await setup(), id = await t.account('sales@sylway.cloud'); await t.bind(id);
    const original = '<po-thread-1@sylway.cloud>';
    fake.put('sales@sylway.cloud', 'INBOX', await raw('询价', { messageId: original, attachment: { name: 'spec.txt', body: 'spec' } }));
    let ws = (await t.sync(id)).body.workspace; const parent = realMessages(ws, id)[0];
    const customer = ws.state.customers[0];
    await t.command('email.link', { id: parent.id, link: { kind: 'customer', id: customer.id } });
    const draft = (await t.command('email.draft.save', { input: { accountId: id, from: 'sales@sylway.cloud', to: 'customer-demo@sylway.cloud', cc: '', bcc: 'finance@sylway.cloud', subject: 'Re: 询价', body: '报价见附件', template: '', links: [{ kind: 'customer', id: customer.id }], fileIds: [parent.attachments[0].fileId], replyToId: parent.id } })).receipt.result.id;
    ws = await t.latest();
    const input = { ...ws.state.email.drafts.find((d: any) => d.id === draft) }; delete input.id; delete input.createdAt; delete input.updatedAt; delete input.updatedBy;
    const body = { requestKey: 'send-key-0001', draftId: draft, input };
    const sent = await t.owner.post(W + ws.id + '/email/sends').send(body).expect(200);
    expect(sent.body.send.status).toBe('sent');
    expect(fake.deliveries).toHaveLength(1);
    expect(fake.deliveries[0].to.sort()).toEqual(['customer-demo@sylway.cloud', 'finance@sylway.cloud']);
    const mime = fake.deliveries[0].raw.toString('utf8');
    expect(mime).toContain(`In-Reply-To: ${original}`); expect(mime).toContain('spec.txt'); expect(mime).not.toMatch(/^Bcc:/mi);
    ws = sent.body.workspace;
    const record = ws.state.email.sends[0];
    expect(record).toMatchObject({ status: 'sent', response: expect.stringContaining('250') });
    const copy = ws.state.email.messages.find((m: any) => m.id === record.sentMessageId);
    expect(copy).toMatchObject({ folder: 'sent', threadId: parent.threadId, links: [{ kind: 'customer', id: customer.id }], example: false });
    expect(ws.state.email.drafts.some((d: any) => d.id === draft)).toBe(false);
    // 已发送远端副本：再同步按 Message-ID 合并，不重复
    const resync = await t.sync(id);
    expect(realMessages(resync.body.workspace, id).filter((m: any) => m.folder === 'sent')).toHaveLength(1);
    // 同一 requestKey 重放：返回原记录，不再投递
    const replay = await t.owner.post(W + ws.id + '/email/sends').send(body).expect(200);
    expect(replay.body.send).toMatchObject({ id: record.id, status: 'sent', replayed: true });
    expect(fake.deliveries).toHaveLength(1);
    // 收件方真实收到
    expect(fake.boxes.get('customer-demo@sylway.cloud')!.boxes.get('INBOX')!.messages).toHaveLength(1);
  });

  it('明确失败可重发；结果不确定不自动重发，必须核对或确认未送达后才重发', async () => {
    const t = await setup(), id = await t.account('sales@sylway.cloud'); await t.bind(id);
    const input = { accountId: id, from: 'sales@sylway.cloud', to: 'customer-demo@sylway.cloud', cc: '', bcc: '', subject: '出货通知', body: '已出运', template: '', links: [], fileIds: [] };
    fake.smtpMode = 'reject-login';
    const failed = await t.owner.post(W + t.ws.id + '/email/sends').send({ requestKey: 'send-key-fail1', input }).expect(200);
    expect(failed.body.send.status).toBe('failed');
    const sendId = failed.body.send.id;
    fake.smtpMode = 'ok';
    const retried = await t.owner.post(W + t.ws.id + '/email/sends/' + sendId + '/retry').send({}).expect(200);
    expect(retried.body.send.status).toBe('sent'); expect(fake.deliveries).toHaveLength(1);
    await t.owner.post(W + t.ws.id + '/email/sends/' + sendId + '/retry').send({}).expect(422);

    fake.smtpMode = 'drop-after-data';
    const unknown = await t.owner.post(W + t.ws.id + '/email/sends').send({ requestKey: 'send-key-unk1', input: { ...input, subject: '不确定' } }).expect(200);
    expect(unknown.body.send.status).toBe('unknown');
    const uid = unknown.body.send.id;
    const blind = await t.owner.post(W + t.ws.id + '/email/sends/' + uid + '/retry').send({}).expect(409);
    expect(blind.body.error.code).toBe('SEND_RESULT_UNCERTAIN');
    const check = await t.owner.post(W + t.ws.id + '/email/sends/' + uid + '/verify').send({}).expect(200);
    expect(check.body.send.status).toBe('unknown');
    fake.smtpMode = 'ok';
    const confirmed = await t.owner.post(W + t.ws.id + '/email/sends/' + uid + '/retry').send({ confirmUnknown: true }).expect(200);
    expect(confirmed.body.send.status).toBe('sent'); expect(fake.deliveries).toHaveLength(2);
    const record = confirmed.body.workspace.state.email.sends.find((s: any) => s.id === uid);
    expect(record.attempts.map((a: any) => a.outcome)).toEqual(['claimed', 'unknown', 'not_found', 'claimed', 'accepted']);

    // 发给自己且已送达但连接中断：核对按 Message-ID 找到后确认已发送，不重发
    fake.smtpMode = 'deliver-then-drop';
    const self = await t.owner.post(W + t.ws.id + '/email/sends').send({ requestKey: 'send-key-self1', input: { ...input, to: 'sales@sylway.cloud', subject: '抄给自己' } }).expect(200);
    expect(self.body.send.status).toBe('unknown');
    const verified = await t.owner.post(W + t.ws.id + '/email/sends/' + self.body.send.id + '/verify').send({}).expect(200);
    expect(verified.body.send.status).toBe('sent'); expect(fake.deliveries).toHaveLength(3);
  });

  it('部分收件人被拒：记录收件人级结果；只对被拒收件人重发，已接收者不会再收到；全部被拒为失败', async () => {
    const t = await setup(), id = await t.account('sales@sylway.cloud'); await t.bind(id);
    const send = (key: string, patch: Record<string, string> = {}) => t.owner.post(W + t.ws.id + '/email/sends').send({ requestKey: key, input: { accountId: id, from: 'sales@sylway.cloud', to: 'customer-demo@sylway.cloud, bounce@sylway.cloud', cc: 'finance@sylway.cloud', bcc: '', subject: '装箱单', body: '见附件', template: '', links: [], fileIds: [], ...patch } }).expect(200);
    const sentBox = () => fake.boxes.get('sales@sylway.cloud')!.boxes.get('Sent')!.messages;
    fake.rejectRcpt.add('bounce@sylway.cloud');
    const first = await send('send-key-part1');
    expect(first.body.send.status).toBe('partial');
    let ws = first.body.workspace, record = ws.state.email.sends.find((s: any) => s.id === first.body.send.id);
    expect(record.recipients.map((r: any) => [r.address, r.role, r.status])).toEqual([['customer-demo@sylway.cloud', 'to', 'accepted'], ['bounce@sylway.cloud', 'to', 'rejected'], ['finance@sylway.cloud', 'cc', 'accepted']]);
    expect(record.recipients[1].reply).toContain('550 5.1.1 <bounce@sylway.cloud>');
    expect(record.attempts.map((a: any) => a.outcome)).toEqual(['claimed', 'partial']);
    // 已发送副本只生成一份并如实关联发送记录；远端"已发送"只写一次
    const copies = () => realMessages(ws, id).filter((m: any) => m.folder === 'sent' && m.sendId === record.id);
    expect(copies()).toHaveLength(1); expect(sentBox()).toHaveLength(1);
    expect(ws.state.events.some((e: any) => e.text.includes('部分收件人'))).toBe(true);
    // 同一请求重放：返回部分接收状态，不再投递
    const replay = await send('send-key-part1');
    expect(replay.body.send).toMatchObject({ id: record.id, status: 'partial', replayed: true }); expect(fake.attemptsSeen).toHaveLength(1);
    // 重发：信封只含被拒收件人；仍被拒 → 仍为部分接收
    const again = await t.owner.post(W + t.ws.id + '/email/sends/' + record.id + '/retry').send({}).expect(200);
    expect(fake.attemptsSeen[1]).toEqual(['bounce@sylway.cloud']); expect(again.body.send.status).toBe('partial');
    // 修复后重发：只投给被拒者，整封变为已发送；已接收者收件箱仍只有一封
    fake.rejectRcpt.clear();
    const fixed = await t.owner.post(W + t.ws.id + '/email/sends/' + record.id + '/retry').send({}).expect(200);
    expect(fake.attemptsSeen[2]).toEqual(['bounce@sylway.cloud']); expect(fixed.body.send.status).toBe('sent');
    ws = fixed.body.workspace; record = ws.state.email.sends.find((s: any) => s.id === record.id);
    expect(record.recipients.every((r: any) => r.status === 'accepted')).toBe(true);
    expect(record.attempts.map((a: any) => a.outcome)).toEqual(['claimed', 'partial', 'claimed', 'failed', 'claimed', 'accepted']);
    expect(fake.boxes.get('customer-demo@sylway.cloud')!.boxes.get('INBOX')!.messages).toHaveLength(1);
    expect(fake.boxes.get('finance@sylway.cloud')!.boxes.get('INBOX')!.messages).toHaveLength(1);
    expect(copies()).toHaveLength(1); expect(sentBox()).toHaveLength(1);
    await t.owner.post(W + t.ws.id + '/email/sends/' + record.id + '/retry').send({}).expect(422);

    // 全部被拒：失败、不生成已发送副本；修复后安全重发
    fake.rejectRcpt.add('nobody@sylway.cloud');
    const all = await send('send-key-allrj', { to: 'nobody@sylway.cloud', cc: '' });
    expect(all.body.send.status).toBe('failed');
    let rec = all.body.workspace.state.email.sends.find((s: any) => s.id === all.body.send.id);
    expect(rec.recipients).toMatchObject([{ address: 'nobody@sylway.cloud', status: 'rejected', reply: expect.stringContaining('550') }]); expect(rec.sentMessageId).toBeUndefined();
    fake.rejectRcpt.clear();
    const ok = await t.owner.post(W + t.ws.id + '/email/sends/' + rec.id + '/retry').send({}).expect(200);
    expect(ok.body.send.status).toBe('sent');
    rec = ok.body.workspace.state.email.sends.find((s: any) => s.id === rec.id); expect(rec.sentMessageId).toEqual(expect.any(String));

    // 全部接收：每个收件人都记为已接收
    const full = await send('send-key-full1', { to: 'customer-demo@sylway.cloud' });
    expect(full.body.send.status).toBe('sent');
    expect(full.body.workspace.state.email.sends.find((s: any) => s.id === full.body.send.id).recipients.map((r: any) => r.status)).toEqual(['accepted', 'accepted']);
  });

  it('多收件人结果不确定时，在本邮箱找到副本不能确认其他收件人；只有收件人全是本邮箱自身时才确认', async () => {
    const t = await setup(), id = await t.account('sales@sylway.cloud'); await t.bind(id);
    fake.smtpMode = 'deliver-then-drop';
    const multi = await t.owner.post(W + t.ws.id + '/email/sends').send({ requestKey: 'send-key-mult1', input: { accountId: id, from: 'sales@sylway.cloud', to: 'sales@sylway.cloud, customer-demo@sylway.cloud', cc: '', bcc: '', subject: '多收件人中断', body: '', template: '', links: [], fileIds: [] } }).expect(200);
    expect(multi.body.send.status).toBe('unknown');
    const check = await t.owner.post(W + t.ws.id + '/email/sends/' + multi.body.send.id + '/verify').send({}).expect(200);
    expect(check.body.send).toMatchObject({ status: 'unknown', found: true, confirmed: false });
    const rec = check.body.workspace.state.email.sends.find((s: any) => s.id === multi.body.send.id);
    expect(rec.recipients.map((r: any) => r.status)).toEqual(['unknown', 'unknown']); expect(rec.attempts.at(-1).outcome).toBe('copy_found'); expect(rec.sentMessageId).toBeUndefined();
    // 仍不能盲目重发
    await t.owner.post(W + t.ws.id + '/email/sends/' + rec.id + '/retry').send({}).expect(409);
    expect(fake.deliveries).toHaveLength(1);
  });

  it('重绑到新收信来源：清空旧游标、换代际，新来源同号 UID 正常入库；旧邮件保留；仅改发信设置不重置', async () => {
    const t = await setup(), id = await t.account('sales@sylway.cloud'); await t.bind(id);
    for (let i = 1; i <= 42; i++) fake.put('sales@sylway.cloud', 'INBOX', await raw(`旧来源 ${i}`));
    let ws = (await t.sync(id)).body.workspace;
    expect(ws.state.email.accounts.find((a: any) => a.id === id).folders.find((f: any) => f.remote === 'INBOX')).toMatchObject({ uidValidity: 7, lastUid: 42 });
    const oldIds = realMessages(ws, id).map((m: any) => m.id), ownerId = ws.state.email.accounts.find((a: any) => a.id === id).ownerId;
    // 新来源（不同地址与服务器），同样 UIDVALIDITY=7，UID 从 1 开始
    fake.add('factory-demo@sylway.cloud');
    fake.put('factory-demo@sylway.cloud', 'INBOX', await raw('新来源第一封', { to: 'factory-demo@sylway.cloud', messageId: '<new-source-1@sylway.cloud>' }));
    await t.command('email.account.save', { id, input: { address: 'factory-demo@sylway.cloud', displayName: 'factory', kind: 'personal', memberIds: [], aliases: [], signature: '', transport: { ...transport('127.0.0.1'), imapPort: 143, imapSecure: false, username: 'factory-demo@sylway.cloud' } } });
    let acct = t.ws.state.email.accounts.find((a: any) => a.id === id);
    expect(acct).toMatchObject({ sourceGeneration: 2, folders: [], credentialSet: false, connection: 'not_connected', ownerId, memberIds: [] });
    await t.bind(id);
    const fresh = await t.sync(id);
    expect(fresh.body.sync.added).toBe(1); expect(fresh.body.sync.skipped).toBe(0);
    ws = fresh.body.workspace;
    const added = realMessages(ws, id).find((m: any) => m.subject === '新来源第一封');
    expect(added).toMatchObject({ source: 2, remote: { folder: 'INBOX', uid: 1, uidValidity: 7 } });
    expect(oldIds.every((oid: string) => realMessages(ws, id).some((m: any) => m.id === oid))).toBe(true);
    expect(realMessages(ws, id)).toHaveLength(43);
    // 重复同步不重复入库
    expect((await t.sync(id)).body.sync).toMatchObject({ added: 0, merged: 0 });
    // 仅改发信设置：需重新校验凭据，但代际与收信游标不变，重新同步不重复导入
    await t.command('email.account.save', { id, input: { address: 'factory-demo@sylway.cloud', displayName: '工厂', kind: 'personal', memberIds: [], aliases: [], signature: '新签名', transport: { ...transport('127.0.0.1'), imapPort: 143, imapSecure: false, smtpPort: 465, smtpSecure: true, username: 'factory-demo@sylway.cloud' } } });
    acct = t.ws.state.email.accounts.find((a: any) => a.id === id);
    expect(acct).toMatchObject({ sourceGeneration: 2, credentialSet: false }); expect(acct.folders.find((f: any) => f.remote === 'INBOX')).toMatchObject({ lastUid: 1 });
    await t.bind(id);
    expect((await t.sync(id)).body.sync).toMatchObject({ added: 0 });
    // 只改显示名：不需要重新绑定
    await t.command('email.account.save', { id, input: { address: 'factory-demo@sylway.cloud', displayName: '工厂邮箱', kind: 'personal', memberIds: [], aliases: [], signature: '新签名', transport: { ...transport('127.0.0.1'), imapPort: 143, imapSecure: false, smtpPort: 465, smtpSecure: true, username: 'factory-demo@sylway.cloud' } } });
    expect(t.ws.state.email.accounts.find((a: any) => a.id === id)).toMatchObject({ sourceGeneration: 2, credentialSet: true });
  });

  it('设置允许投递域名时拒绝外部收件人，不登记发送；示例邮箱不能发送', async () => {
    vi.stubEnv('MIST_MAIL_ALLOWED_RECIPIENT_DOMAINS', 'sylway.cloud');
    const t = await setup(), id = await t.account('sales@sylway.cloud'); await t.bind(id);
    const blocked = await t.owner.post(W + t.ws.id + '/email/sends').send({ requestKey: 'send-key-ext01', input: { accountId: id, from: 'sales@sylway.cloud', to: 'buyer@example.com', cc: '', bcc: '', subject: 'x', body: '', template: '', links: [], fileIds: [] } }).expect(422);
    expect(blocked.body.error.code).toBe('MAIL_RECIPIENT_NOT_ALLOWED');
    expect((await t.latest()).state.email.sends).toHaveLength(0); expect(fake.deliveries).toHaveLength(0);
    const example = t.ws.state.email.accounts.find((a: any) => a.example);
    if (example) await t.owner.post(W + t.ws.id + '/email/sends').send({ requestKey: 'send-key-ex001', input: { accountId: example.id, from: example.address, to: 'sales@sylway.cloud', cc: '', bcc: '', subject: 'x', body: '', template: '', links: [], fileIds: [] } }).expect(422);
  });

  it('收件人按共享规则逐个拆分并检查域名：分号、全角分隔、空白、大写的 CC/BCC 外部地址都在登记前拒绝', async () => {
    vi.stubEnv('MIST_MAIL_ALLOWED_RECIPIENT_DOMAINS', 'sylway.cloud');
    const t = await setup(), id = await t.account('sales@sylway.cloud'); await t.bind(id);
    const base = { accountId: id, from: 'sales@sylway.cloud', to: 'customer-demo@sylway.cloud', cc: '', bcc: '', subject: '域名检查', body: '', template: '', links: [], fileIds: [] };
    const cases = [{ to: 'external@outside.test; customer-demo@sylway.cloud' }, { to: 'customer-demo@sylway.cloud；external@outside.test' }, { to: 'customer-demo@sylway.cloud external@outside.test' }, { cc: 'finance@sylway.cloud，EXTERNAL@OUTSIDE.TEST' }, { bcc: 'External@Outside.Test' }];
    for (const [i, patch] of cases.entries()) {
      const r = await t.owner.post(W + t.ws.id + '/email/sends').send({ requestKey: 'send-key-dom0' + i, input: { ...base, ...patch } }).expect(422);
      expect(r.body.error.code).toBe('MAIL_RECIPIENT_NOT_ALLOWED'); expect(r.body.error.message).toContain('external@outside.test');
    }
    expect((await t.latest()).state.email.sends).toHaveLength(0); expect(fake.deliveries).toHaveLength(0); expect(fake.attemptsSeen).toHaveLength(0);
    // 同一规则拆分的允许地址可正常投递，信封逐个地址
    const ok = await t.owner.post(W + t.ws.id + '/email/sends').send({ requestKey: 'send-key-dom-ok', input: { ...base, to: 'customer-demo@sylway.cloud；finance@sylway.cloud' } }).expect(200);
    expect(ok.body.send.status).toBe('sent'); expect(fake.attemptsSeen[0]).toEqual(['customer-demo@sylway.cloud', 'finance@sylway.cloud']);
  });

  it('发送意图：同一请求改内容被拒；同草稿/同内容的未决发送换新请求或重启后只回到原记录，不重复投递', async () => {
    const t = await setup(), id = await t.account('sales@sylway.cloud'); await t.bind(id);
    const input = { accountId: id, from: 'sales@sylway.cloud', to: 'customer-demo@sylway.cloud', cc: '', bcc: '', subject: '报价确认', body: '请确认报价', template: '', links: [], fileIds: [] };
    const draftId = (await t.command('email.draft.save', { input })).receipt.result.id as string;
    const post = (client: any, key: string, patch: Record<string, unknown> = {}, extra: Record<string, unknown> = { draftId }, status = 200) => client.post(W + t.ws.id + '/email/sends').send({ requestKey: key, ...extra, input: { ...input, ...patch } }).expect(status);
    // 同一意图改 To / 主题 / 正文：明确冲突，不投递；同内容重放仍只投递一次
    fake.smtpMode = 'ok';
    const first = await post(t.owner, 'send-key-int01', {}, {});
    expect(first.body.send.status).toBe('sent'); expect(fake.attemptsSeen).toHaveLength(1);
    for (const patch of [{ to: 'finance@sylway.cloud' }, { subject: '报价确认（改）' }, { body: '改过的正文' }]) {
      const r = await post(t.owner, 'send-key-int01', patch, {}, 409); expect(r.body.error.code).toBe('SEND_INTENT_CONFLICT');
    }
    expect((await post(t.owner, 'send-key-int01', { to: 'Customer-Demo@sylway.cloud' }, {})).body.send).toMatchObject({ id: first.body.send.id, replayed: true });
    expect(fake.attemptsSeen).toHaveLength(1);

    // 草稿发送：服务器已投递但连接中断 → 结果待核对
    fake.smtpMode = 'deliver-then-drop';
    const unknown = await post(t.owner, 'send-key-drf01');
    expect(unknown.body.send.status).toBe('unknown'); expect(fake.deliveries).toHaveLength(2);
    fake.smtpMode = 'ok';
    // 刷新后换新请求编号再发同一草稿：回到原记录，不投递
    const again = await post(t.owner, 'send-key-drf02');
    expect(again.body.send).toMatchObject({ id: unknown.body.send.id, status: 'unknown', replayed: true, recovered: true });
    // 服务重启（新运行时，同一数据目录）后仍回到原记录
    const restarted = createMistServer(undefined, { local: createMistLocalRuntime({ directory }), mailTransport: fake.transport() });
    const client = request.agent(restarted); await client.get('/api/mist/session').expect(200);
    const after = await post(client, 'send-key-drf03');
    expect(after.body.send).toMatchObject({ id: unknown.body.send.id, recovered: true });
    // 没有草稿、内容相同的新请求也不能绕过核对
    expect((await post(t.owner, 'send-key-drf04', {}, {})).body.send).toMatchObject({ id: unknown.body.send.id, recovered: true });
    // 同草稿改了内容：要求先处理原记录
    const changed = await post(t.owner, 'send-key-drf05', { body: '补充说明' }, { draftId }, 409);
    expect(changed.body.error.code).toBe('SEND_PENDING_VERIFY');
    expect(fake.deliveries).toHaveLength(2); expect(fake.attemptsSeen).toHaveLength(2);
    const ws = await t.latest();
    expect(ws.state.email.sends.filter((s: any) => s.draftId === draftId)).toHaveLength(1);

    // 明确失败后同草稿重新发送：新记录取代旧记录，旧记录不能再重发
    const draft2 = (await t.command('email.draft.save', { input: { ...input, subject: '样品寄送' } })).receipt.result.id as string;
    fake.smtpMode = 'reject-login';
    const failed = await post(t.owner, 'send-key-fai01', { subject: '样品寄送' }, { draftId: draft2 });
    expect(failed.body.send.status).toBe('failed');
    fake.smtpMode = 'ok';
    const resent = await post(t.owner, 'send-key-fai02', { subject: '样品寄送', body: '更新后的正文' }, { draftId: draft2 });
    expect(resent.body.send.status).toBe('sent'); expect(resent.body.send.id).not.toBe(failed.body.send.id);
    const old = resent.body.workspace.state.email.sends.find((s: any) => s.id === failed.body.send.id);
    expect(old.supersededById).toBe(resent.body.send.id);
    expect((await t.owner.post(W + t.ws.id + '/email/sends/' + old.id + '/retry').send({}).expect(422)).body.error.message).toContain('取代');
  });

  it('只在已发送中找到旧副本不能确认任何收件人：部分接收后补发自身断线，核对仍待确认', async () => {
    const t = await setup(), id = await t.account('sales@sylway.cloud'); await t.bind(id);
    fake.rejectRcpt.add('sales@sylway.cloud');
    const first = await t.owner.post(W + t.ws.id + '/email/sends').send({ requestKey: 'send-key-cpy01', input: { accountId: id, from: 'sales@sylway.cloud', to: 'customer-demo@sylway.cloud', cc: 'sales@sylway.cloud', bcc: '', subject: '副本核对', body: '', template: '', links: [], fileIds: [] } }).expect(200);
    expect(first.body.send.status).toBe('partial');
    expect(fake.boxes.get('sales@sylway.cloud')!.boxes.get('Sent')!.messages).toHaveLength(1);
    // 只补发给本邮箱自身，提交正文后断线且未投递
    fake.rejectRcpt.clear(); fake.smtpMode = 'drop-after-data';
    const retry = await t.owner.post(W + t.ws.id + '/email/sends/' + first.body.send.id + '/retry').send({}).expect(200);
    expect(retry.body.send.status).toBe('unknown');
    expect(fake.boxes.get('sales@sylway.cloud')!.boxes.get('INBOX')!.messages).toHaveLength(0);
    const check = await t.owner.post(W + t.ws.id + '/email/sends/' + first.body.send.id + '/verify').send({}).expect(200);
    expect(check.body.send).toMatchObject({ status: 'unknown', found: true, foundIn: ['sent'], confirmed: false });
    const rec = check.body.workspace.state.email.sends.find((s: any) => s.id === first.body.send.id);
    expect(rec.recipients.map((r: any) => [r.address, r.status])).toEqual([['customer-demo@sylway.cloud', 'accepted'], ['sales@sylway.cloud', 'unknown']]);
    expect(rec.attempts.at(-1)).toMatchObject({ outcome: 'copy_found', message: expect.stringContaining('已发送') });
  });

  it('文件夹选择与 SMTP 结果分类', () => {
    expect(pickMailFolders([{ path: 'INBOX', attribs: [] }, { path: 'Sent', attribs: ['\\Sent'] }, { path: 'Junk', attribs: ['\\Junk'] }, { path: 'Trash', attribs: ['\\Trash'] }])).toEqual([{ remote: 'INBOX', folder: 'inbox' }, { remote: 'Sent', folder: 'sent' }]);
    expect(classifySmtpError({ mailStage: 'connect', code: 'ECONNECTION' })).toBe('failed');
    expect(classifySmtpError({ mailStage: 'login', code: 'EAUTH' })).toBe('failed');
    expect(classifySmtpError({ mailStage: 'send', mailReplied: true, responseCode: 550 })).toBe('failed');
    expect(classifySmtpError({ mailStage: 'send', mailReplied: false, code: 'ETIMEDOUT', command: 'CONN' })).toBe('unknown');
    expect(classifySmtpError({ code: 'ESOCKET' })).toBe('unknown');
    expect(describeMailError({ responseCode: 550, response: '550 5.1.1 <x@y.test>: Recipient address rejected\r\n' }, 'smtp')).toEqual({ code: 'SMTP_REJECTED', message: '发信服务器拒绝（550：550 5.1.1 <x@y.test>: Recipient address rejected）' });
    expect(describeMailError({ responseCode: 451, response: '451 try later' }, 'smtp').code).toBe('SMTP_TEMPORARY_FAILURE');
    expect(describeMailError({ code: 'EAUTH', responseCode: 535 }, 'smtp').code).toBe('MAIL_AUTH_FAILED');
  });
});
