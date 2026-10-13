import nodemailer, { Transporter } from 'nodemailer';
import { logger } from '../lib/logger';

export type EmailMessage = {
  to: string;
  subject: string;
  text?: string;
  html?: string;
};

export type EmailService = {
  send: (msg: EmailMessage) => Promise<void>;
  isReal: boolean;
  describe: () => string;
};

type SmtpOptions = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
};

type ResendOptions = {
  apiKey: string;
  from: string;
};

function readResendFromEnv(): ResendOptions | null {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM?.trim() || process.env.SMTP_FROM?.trim();
  if (!apiKey || !from) return null;
  return { apiKey, from };
}

function readSmtpFromEnv(): SmtpOptions | null {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  const portRaw = process.env.SMTP_PORT?.trim();
  const from = process.env.SMTP_FROM?.trim() || user;
  if (!host || !user || !pass || !from) return null;
  const port = portRaw ? parseInt(portRaw, 10) : 465;
  const secure = process.env.SMTP_SECURE
    ? /^(1|true|yes)$/i.test(process.env.SMTP_SECURE.trim())
    : port === 465;
  return { host, port, secure, user, pass, from };
}

function createResendService(opts: ResendOptions): EmailService {
  let clientPromise: Promise<any> | null = null;
  async function getClient(): Promise<any> {
    if (!clientPromise) {
      clientPromise = (async () => {
        try {
          const mod: any = await import('resend');
          const Ctor = mod.Resend || mod.default?.Resend;
          if (!Ctor) throw new Error('resend module loaded but Resend export not found');
          return new Ctor(opts.apiKey);
        } catch (err: any) {
          clientPromise = null;
          throw new Error(`Resend SDK not available: ${err?.message || err}. Run "npm install resend" on the server.`);
        }
      })();
    }
    return clientPromise;
  }

  return {
    isReal: true,
    describe: () => `resend (from=${opts.from})`,
    async send(msg) {
      const client = await getClient();
      const payload: any = {
        from: opts.from,
        to: [msg.to],
        subject: msg.subject,
      };
      if (msg.html) payload.html = msg.html;
      if (msg.text) payload.text = msg.text;
      if (!msg.html && !msg.text) payload.text = '';
      const result = await client.emails.send(payload);
      if ((result as any)?.error) {
        const err: any = new Error((result as any).error.message || 'Resend send failed');
        err.detail = (result as any).error;
        throw err;
      }
    },
  };
}

function createSmtpService(cfg: SmtpOptions): EmailService {
  let transporter: Transporter | null = null;
  function getTransporter(): Transporter {
    if (!transporter) {
      transporter = nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        auth: { user: cfg.user, pass: cfg.pass },
      });
    }
    return transporter;
  }
  return {
    isReal: true,
    describe: () => `smtp://${cfg.user}@${cfg.host}:${cfg.port}${cfg.secure ? ' (TLS)' : ''}`,
    async send(msg) {
      await getTransporter().sendMail({
        from: cfg.from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      });
    },
  };
}

function createConsoleService(): EmailService {
  return {
    isReal: false,
    describe: () => 'console (no RESEND_API_KEY / SMTP_* env vars)',
    async send(msg) {
      logger.info('[email:console]', { to: msg.to, subject: msg.subject, text: msg.text });
    },
  };
}

/**
 * 是否允许「无真实邮件通道时降级放行」。
 * 仅用于本地开发/联调（console 通道下把验证码回显到响应，才能跑通注册流程）。
 * 生产严禁开启——开启后验证码不会真正送达，却会返回成功。
 */
export function isDevEmailFallbackAllowed(): boolean {
  return /^(1|true|yes)$/i.test((process.env.AUTH_ALLOW_DEV_EMAIL_FALLBACK || '').trim());
}

let consoleFallbackWarned = false;

export function createEmailService(): EmailService {
  const resend = readResendFromEnv();
  if (resend) return createResendService(resend);
  const smtp = readSmtpFromEnv();
  if (smtp) return createSmtpService(smtp);
  if (!consoleFallbackWarned) {
    consoleFallbackWarned = true;
    logger.warn(
      '[email] 未配置 RESEND_API_KEY / SMTP_*，邮件只写日志不会真正发出；凭证类邮件（注册验证码/重置密码）将被拒绝。' +
        '本地开发如需放行请设 AUTH_ALLOW_DEV_EMAIL_FALLBACK=1，生产请配置真实通道。',
    );
  }
  return createConsoleService();
}

export function buildApprovalApprovedEmail(params: {
  displayName?: string | null;
  roles?: string[];
  department?: string | null;
}): EmailMessage {
  const name = (params.displayName || '').trim() || '同事';
  const rolesLabel = (params.roles || []).filter(Boolean).join('、') || '基础访问';
  const deptLabel = params.department?.trim() || '未分配';
  const text = [
    `您好 ${name}：`,
    '',
    '您在 Bambook Neural 提交的注册申请已通过审核，现在可以使用同一邮箱登录系统。',
    '',
    `分配角色：${rolesLabel}`,
    `所属部门：${deptLabel}`,
    '',
    '如需调整角色或部门，请联系您的管理员。',
    '',
    '— Bambook Neural 团队',
  ].join('\n');
  const html = `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#1f2937">
    <div style="text-align:center;margin-bottom:24px">
      <div style="font-size:14px;letter-spacing:2px;color:#4A90E2;font-weight:500">BAMBOOK NEURAL</div>
      <div style="font-size:11px;color:#94a3b8;margin-top:4px">Enterprise Agent OS</div>
    </div>
    <p style="font-size:14px;line-height:1.7">您好 <strong>${name}</strong>，</p>
    <p style="font-size:14px;line-height:1.7">您在 Bambook Neural 提交的注册申请<strong style="color:#10b981">已通过审核</strong>，现在可以使用同一邮箱登录系统。</p>
    <div style="margin:20px 0;padding:16px 20px;background:#f1f5f9;border-radius:12px">
      <div style="font-size:12px;color:#64748b">分配角色</div>
      <div style="font-size:14px;color:#0f172a;font-weight:500;margin-top:2px">${rolesLabel}</div>
      <div style="font-size:12px;color:#64748b;margin-top:10px">所属部门</div>
      <div style="font-size:14px;color:#0f172a;font-weight:500;margin-top:2px">${deptLabel}</div>
    </div>
    <p style="font-size:12px;color:#64748b;line-height:1.7">如需调整角色或部门，请联系您的管理员。</p>
    <p style="font-size:12px;color:#94a3b8;line-height:1.7;margin-top:24px">— Bambook Neural 团队</p>
  </div>`;
  return { to: '', subject: 'Bambook 注册审核已通过', text, html };
}

export function buildVerificationEmail(code: string, purpose: 'register' | 'reset_password' = 'register'): EmailMessage {
  const purposeLabel = purpose === 'register' ? '注册' : '重置密码';
  return {
    to: '',
    subject: `Bambook ${purposeLabel}验证码：${code}`,
    text: `您正在进行 Bambook ${purposeLabel}操作。\n\n验证码：${code}\n\n该验证码 10 分钟内有效，请勿泄露给他人。\n\n如果不是您本人操作，请忽略此邮件。`,
    html: `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#1f2937">
      <div style="text-align:center;margin-bottom:24px">
        <div style="font-size:14px;letter-spacing:2px;color:#4A90E2;font-weight:500">BAMBOOK NEURAL</div>
        <div style="font-size:11px;color:#94a3b8;margin-top:4px">Enterprise Agent OS</div>
      </div>
      <p style="font-size:14px;line-height:1.6">您正在进行 Bambook <strong>${purposeLabel}</strong>操作，验证码如下：</p>
      <div style="margin:24px 0;padding:18px 24px;background:#f1f5f9;border-radius:12px;text-align:center">
        <span style="font-size:28px;letter-spacing:8px;font-weight:600;color:#0f172a;font-family:Menlo,Consolas,monospace">${code}</span>
      </div>
      <p style="font-size:12px;color:#64748b;line-height:1.6">该验证码 <strong>10 分钟</strong>内有效，请勿泄露给他人。<br/>如非您本人操作，请忽略此邮件。</p>
    </div>`,
  };
}
