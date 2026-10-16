import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMistLocalRuntime } from '../local';
import { createMistServer } from '../server';
import { composeMail, classifySmtpError, type MailImapSession, type MailTransport } from './transport';
import { pickMailFolders } from './service';

/**
 * 智能邮箱收发：用内存 IMAP/SMTP 替身覆盖服务端全链路（凭据、同步去重、附件隔离、发送幂等与安全重试）。
 * 真实协议另在服务器内部测试邮箱上实测，见交付记录。
 */
type Box = { uidValidity: number; nextUid: number; attribs: string[]; messages: Array<{ uid: number; raw: Buffer; seen: boolean }>; fail?: boolean };
type Mailbox = { password: string; boxes: Map<string, Box> };
const SECRET = 'S3cret-only-in-test';
class FakeMail {
  boxes = new Map<string, Mailbox>(); deliveries: Array<{ from: string; to: string[]; raw: Buffer }> = []; smtpMode: 'ok' | 'reject-login' | 'drop-after-data' | 'deliver-then-drop' = 'ok';
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
        self.deliveries.push({ ...envelope, raw });
        for (const to of envelope.to) if (self.boxes.has(to)) self.put(to, 'INBOX', raw);
        if (self.smtpMode === 'deliver-then-drop') throw Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT', command: 'CONN', mailStage: 'send', mailReplied: false });
        return { response: '250 2.0.0 Ok: queued as TEST', accepted: envelope.to, rejected: [] };
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

  it('设置允许投递域名时拒绝外部收件人，不登记发送；示例邮箱不能发送', async () => {
    vi.stubEnv('MIST_MAIL_ALLOWED_RECIPIENT_DOMAINS', 'sylway.cloud');
    const t = await setup(), id = await t.account('sales@sylway.cloud'); await t.bind(id);
    const blocked = await t.owner.post(W + t.ws.id + '/email/sends').send({ requestKey: 'send-key-ext01', input: { accountId: id, from: 'sales@sylway.cloud', to: 'buyer@example.com', cc: '', bcc: '', subject: 'x', body: '', template: '', links: [], fileIds: [] } }).expect(422);
    expect(blocked.body.error.code).toBe('MAIL_RECIPIENT_NOT_ALLOWED');
    expect((await t.latest()).state.email.sends).toHaveLength(0); expect(fake.deliveries).toHaveLength(0);
    const example = t.ws.state.email.accounts.find((a: any) => a.example);
    if (example) await t.owner.post(W + t.ws.id + '/email/sends').send({ requestKey: 'send-key-ex001', input: { accountId: example.id, from: example.address, to: 'sales@sylway.cloud', cc: '', bcc: '', subject: 'x', body: '', template: '', links: [], fileIds: [] } }).expect(422);
  });

  it('文件夹选择与 SMTP 结果分类', () => {
    expect(pickMailFolders([{ path: 'INBOX', attribs: [] }, { path: 'Sent', attribs: ['\\Sent'] }, { path: 'Junk', attribs: ['\\Junk'] }, { path: 'Trash', attribs: ['\\Trash'] }])).toEqual([{ remote: 'INBOX', folder: 'inbox' }, { remote: 'Sent', folder: 'sent' }]);
    expect(classifySmtpError({ mailStage: 'connect', code: 'ECONNECTION' })).toBe('failed');
    expect(classifySmtpError({ mailStage: 'login', code: 'EAUTH' })).toBe('failed');
    expect(classifySmtpError({ mailStage: 'send', mailReplied: true, responseCode: 550 })).toBe('failed');
    expect(classifySmtpError({ mailStage: 'send', mailReplied: false, code: 'ETIMEDOUT', command: 'CONN' })).toBe('unknown');
    expect(classifySmtpError({ code: 'ESOCKET' })).toBe('unknown');
  });
});
