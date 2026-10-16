import imaps from 'imap-simple';
import SMTPConnection from 'nodemailer/lib/smtp-connection';
import MailComposer from 'nodemailer/lib/mail-composer';
import type { EmailTransport } from '../../shared/mistEmail';
import type { MistMailSecret } from './credentials';

/** 远端文件夹与 IMAP 会话；接口刻意很小，测试可注入假实现，生产走 imap-simple / nodemailer。 */
export type MailFolderInfo = { path: string; attribs: string[] };
export type MailFetched = { uid: number; seen: boolean; raw: Buffer };
export interface MailImapSession {
  folders(): Promise<MailFolderInfo[]>;
  open(path: string): Promise<{ uidValidity: number; uidNext: number }>;
  /** 当前打开文件夹中 UID 大于 afterUid 的邮件编号（升序）。 */
  uidsAfter(afterUid: number): Promise<number[]>;
  fetch(uids: number[]): Promise<MailFetched[]>;
  hasMessageId(messageId: string): Promise<boolean>;
  append(path: string, raw: Buffer): Promise<void>;
  close(): Promise<void>;
}
export type MailSendResult = { response: string; accepted: string[]; rejected: string[] };
export interface MailTransport {
  imap(config: EmailTransport, secret: MistMailSecret, insecureTls: boolean): Promise<MailImapSession>;
  smtpVerify(config: EmailTransport, secret: MistMailSecret, insecureTls: boolean): Promise<void>;
  smtpSend(config: EmailTransport, secret: MistMailSecret, insecureTls: boolean, envelope: { from: string; to: string[] }, raw: Buffer): Promise<MailSendResult>;
}

export type MailComposeInput = {
  from: { name: string; address: string }; to: string[]; cc: string[]; subject: string; text: string; messageId: string; date: Date;
  inReplyTo?: string; references?: string[]; attachments: Array<{ filename: string; contentType: string; content: Buffer }>;
};
/** 一次性生成原始 MIME：SMTP 投递与写入"已发送"使用同一份字节与 Message-ID。密送只进投递信封，不写入信头。 */
export async function composeMail(input: MailComposeInput): Promise<Buffer> {
  const composer = new MailComposer({
    from: input.from, to: input.to, cc: input.cc.length ? input.cc : undefined, subject: input.subject, text: input.text, messageId: input.messageId, date: input.date,
    inReplyTo: input.inReplyTo, references: input.references?.length ? input.references : undefined, attachments: input.attachments,
  });
  return new Promise((resolve, reject) => composer.compile().build((error, message) => error ? reject(error) : resolve(message)));
}

function flatten(boxes: Record<string, any>, prefix = '', out: MailFolderInfo[] = []) {
  for (const [name, box] of Object.entries(boxes || {})) {
    const path = prefix ? `${prefix}${box?.delimiter || '/'}${name}` : name;
    out.push({ path, attribs: Array.isArray(box?.attribs) ? box.attribs.map(String) : [] });
    if (box?.children) flatten(box.children, path, out);
  }
  return out;
}
const SEEN = '\\Seen';

class ImapSimpleSession implements MailImapSession {
  constructor(private readonly connection: any) {}
  async folders() { return flatten(await this.connection.getBoxes()); }
  async open(path: string) { const box = await this.connection.openBox(path, true); return { uidValidity: Number(box?.uidvalidity) || 0, uidNext: Number(box?.uidnext) || 0 }; }
  uidsAfter(afterUid: number): Promise<number[]> {
    return new Promise((resolve, reject) => this.connection.imap.search([['UID', `${afterUid + 1}:*`]], (error: Error | null, uids: number[]) => error ? reject(error) : resolve((uids || []).map(Number).filter(uid => uid > afterUid).sort((a, b) => a - b))));
  }
  /** 直接用底层 node-imap 流按字节收集原始邮件，避免按文本拼接损坏 8bit 内容。 */
  fetch(uids: number[]): Promise<MailFetched[]> {
    if (!uids.length) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      const rows: MailFetched[] = [], pending: Promise<void>[] = [];
      const fetch = this.connection.imap.fetch(uids, { bodies: '', markSeen: false });
      fetch.on('message', (message: any) => {
        const chunks: Buffer[] = []; let uid = 0, flags: string[] = [];
        pending.push(new Promise<void>(done => {
          message.on('body', (stream: any) => stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk))));
          message.once('attributes', (attrs: any) => { uid = Number(attrs?.uid); flags = Array.isArray(attrs?.flags) ? attrs.flags : []; });
          message.once('end', () => { if (Number.isSafeInteger(uid) && uid > 0 && chunks.length) rows.push({ uid, seen: flags.includes(SEEN), raw: Buffer.concat(chunks) }); done(); });
        }));
      });
      fetch.once('error', reject);
      fetch.once('end', () => { void Promise.all(pending).then(() => resolve(rows.sort((a, b) => a.uid - b.uid))); });
    });
  }
  hasMessageId(messageId: string): Promise<boolean> {
    return new Promise((resolve, reject) => this.connection.imap.search([['HEADER', 'MESSAGE-ID', messageId]], (error: Error | null, uids: number[]) => error ? reject(error) : resolve((uids || []).length > 0)));
  }
  async append(path: string, raw: Buffer) { await this.connection.append(raw, { mailbox: path, flags: [SEEN] }); }
  async close() { try { this.connection.end(); } catch { /* already closed */ } }
}

const tls = (host: string, insecureTls: boolean) => ({ servername: /^\d+\.\d+\.\d+\.\d+$/.test(host) ? undefined : host, rejectUnauthorized: !insecureTls, minVersion: 'TLSv1.2' as const });

/**
 * SMTP 分阶段执行：连接/STARTTLS/登录阶段的任何失败都证明正文没有提交；
 * 投递阶段只有服务器明确回复拒绝（信封或正文被拒）才算失败，断线、超时等一律"结果不确定"。
 * 底层套接字错误不论阶段都标为 CONN，不能凭错误码判断，所以这里自行记录阶段。
 */
type Stage = 'connect' | 'login' | 'send';
function smtpSession(config: EmailTransport, secret: MistMailSecret, insecureTls: boolean, deliver?: { envelope: { from: string; to: string[] }; raw: Buffer }): Promise<MailSendResult> {
  const connection = new SMTPConnection({ host: config.smtpHost, port: config.smtpPort, secure: config.smtpSecure, requireTLS: !config.smtpSecure, tls: tls(config.smtpHost, insecureTls), connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 60000, logger: false, debug: false } as any);
  let stage: Stage = 'connect', settled = false;
  return new Promise((resolve, reject) => {
    const finish = (error: any, info?: MailSendResult, replied = false) => {
      if (settled) return; settled = true;
      if (error) { const failure = error instanceof Error ? error : new Error(String(error)); Object.assign(failure, { mailStage: stage, mailReplied: replied }); try { connection.close(); } catch { /* closed */ } reject(failure); return; }
      try { connection.quit(); } catch { /* closed */ } resolve(info!);
    };
    connection.on('error', (error: any) => finish(error));
    connection.once('end', () => finish(Object.assign(new Error('Connection closed unexpectedly'), { code: 'ECONNECTION' })));
    connection.connect(() => {
      stage = 'login';
      connection.login({ user: secret.username, pass: secret.password } as any, (error: any) => {
        if (error) return finish(error);
        if (!deliver) return finish(null, { response: '', accepted: [], rejected: [] });
        stage = 'send';
        connection.send(deliver.envelope as any, deliver.raw, (failure: any, info: any) => {
          if (failure) return finish(failure, undefined, !!failure.responseCode || failure.code === 'EENVELOPE');
          finish(null, { response: String(info?.response || ''), accepted: (info?.accepted || []).map(String), rejected: (info?.rejected || []).map(String) });
        });
      });
    });
  });
}

export const imapSmtpTransport: MailTransport = {
  async imap(config, secret, insecureTls) {
    const connection = await imaps.connect({ imap: {
      user: secret.username, password: secret.password, host: config.imapHost, port: config.imapPort, tls: config.imapSecure, autotls: config.imapSecure ? 'never' : 'required',
      authTimeout: 15000, connTimeout: 15000, tlsOptions: tls(config.imapHost, insecureTls),
    } } as any);
    // 断线等异步错误不能让进程退出；当前操作会因连接失效而得到明确错误。
    (connection as any).on?.('error', () => undefined);
    return new ImapSimpleSession(connection);
  },
  async smtpVerify(config, secret, insecureTls) { await smtpSession(config, secret, insecureTls); },
  smtpSend(config, secret, insecureTls, envelope, raw) { return smtpSession(config, secret, insecureTls, { envelope, raw }); },
};

/** 明确未送出 (failed) 与结果不确定 (unknown)：只有连接/登录阶段失败，或投递阶段服务器明确回复拒绝，才算 failed。 */
export function classifySmtpError(error: any): 'failed' | 'unknown' {
  if (error?.mailStage === 'connect' || error?.mailStage === 'login') return 'failed';
  if (error?.mailStage === 'send' && error?.mailReplied === true) return 'failed';
  return 'unknown';
}

/** 把底层协议错误转为可展示的中文原因；不包含凭据。 */
export function describeMailError(error: any, stage: 'imap' | 'smtp'): { code: string; message: string } {
  const code = String(error?.code || ''), text = String(error?.textCode || error?.source || ''), detail = String(error?.message || ''), label = stage === 'imap' ? '收信服务器' : '发信服务器';
  if (code === 'EAUTH' || /AUTHENTICATIONFAILED|authentication/i.test(text) || /auth/i.test(detail) && /fail|invalid/i.test(detail)) return { code: 'MAIL_AUTH_FAILED', message: `${label}拒绝登录：用户名或密码不正确` };
  if (/SELF_SIGNED|CERT|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(code + ' ' + detail)) return { code: 'MAIL_TLS_UNTRUSTED', message: `${label}证书不受信任，连接已中止` };
  if (code === 'ETIMEDOUT' || /timeout/i.test(text + ' ' + detail)) return { code: 'MAIL_TIMEOUT', message: `${label}连接超时` };
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNECTION', 'EHOSTUNREACH', 'ECONNRESET'].includes(code)) return { code: 'MAIL_CONNECT_FAILED', message: `无法连接${label}` };
  return { code: 'MAIL_PROTOCOL_ERROR', message: `${label}操作失败` };
}
