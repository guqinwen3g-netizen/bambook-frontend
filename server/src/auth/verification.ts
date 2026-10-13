import crypto from 'node:crypto';

export type VerificationPurpose = 'register' | 'reset_password';

export type VerifyResult =
  | { ok: true }
  | { ok: false; error: 'CODE_NOT_FOUND' | 'CODE_EXPIRED' | 'CODE_MISMATCH' | 'TOO_MANY_ATTEMPTS'; message: string };

export type IssueResult =
  | { ok: true; code: string; expiresAt: Date; cooldownMs: number }
  | { ok: false; error: 'COOLDOWN' | 'RATE_LIMITED'; message: string; retryAfterMs: number };

export type VerificationStore = {
  // B5-1：方法签名异步化——落库实现（verificationDb.ts）与内存实现同接口。
  // 内存版返回值本身就是同步值，Promise 包裹对调用方透明。
  issueCode: (email: string, purpose: VerificationPurpose) => Promise<IssueResult>;
  verifyCode: (email: string, code: string, purpose: VerificationPurpose) => Promise<VerifyResult>;
  hasActiveCode: (email: string, purpose: VerificationPurpose) => Promise<boolean>;
};

type Entry = {
  email: string;
  purpose: VerificationPurpose;
  codeHash: string;
  issuedAt: number;
  expiresAt: number;
  attempts: number;
  consumedAt: number | null;
};

type WindowEntry = {
  startedAt: number;
  count: number;
};

type StoreOptions = {
  codeTtlMs?: number;
  cooldownMs?: number;
  maxPerHour?: number;
  maxAttempts?: number;
};

function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function generateCode(): string {
  const buf = crypto.randomBytes(4);
  const num = buf.readUInt32BE(0) % 1_000_000;
  return num.toString().padStart(6, '0');
}

export function createVerificationStore(options: StoreOptions = {}): VerificationStore {
  const codeTtlMs = options.codeTtlMs ?? 10 * 60 * 1000;
  const cooldownMs = options.cooldownMs ?? 60 * 1000;
  const maxPerHour = options.maxPerHour ?? 5;
  const maxAttempts = options.maxAttempts ?? 5;

  const codes = new Map<string, Entry>();
  const windows = new Map<string, WindowEntry>();

  function key(email: string, purpose: VerificationPurpose): string {
    return `${purpose}:${email.toLowerCase()}`;
  }

  function gc(now: number) {
    for (const [k, v] of codes) {
      if (v.expiresAt < now) codes.delete(k);
    }
    for (const [k, v] of windows) {
      if (now - v.startedAt > 60 * 60 * 1000) windows.delete(k);
    }
  }

  return {
    async issueCode(email, purpose) {
      const now = Date.now();
      gc(now);
      const k = key(email, purpose);
      const existing = codes.get(k);
      if (existing && !existing.consumedAt && now - existing.issuedAt < cooldownMs) {
        return {
          ok: false,
          error: 'COOLDOWN',
          message: `验证码已发送，请 ${Math.ceil((cooldownMs - (now - existing.issuedAt)) / 1000)} 秒后再试。`,
          retryAfterMs: cooldownMs - (now - existing.issuedAt),
        };
      }

      const win = windows.get(k);
      if (win && now - win.startedAt < 60 * 60 * 1000 && win.count >= maxPerHour) {
        const waitMs = 60 * 60 * 1000 - (now - win.startedAt);
        return {
          ok: false,
          error: 'RATE_LIMITED',
          message: `已达每小时最多 ${maxPerHour} 次发送上限，请稍后再试。`,
          retryAfterMs: waitMs,
        };
      }

      const code = generateCode();
      const expiresAt = now + codeTtlMs;
      codes.set(k, {
        email: email.toLowerCase(),
        purpose,
        codeHash: hashCode(code),
        issuedAt: now,
        expiresAt,
        attempts: 0,
        consumedAt: null,
      });

      if (!win || now - win.startedAt >= 60 * 60 * 1000) {
        windows.set(k, { startedAt: now, count: 1 });
      } else {
        win.count += 1;
      }

      return { ok: true, code, expiresAt: new Date(expiresAt), cooldownMs };
    },

    async verifyCode(email, code, purpose) {
      const now = Date.now();
      gc(now);
      const k = key(email, purpose);
      const entry = codes.get(k);
      if (!entry || entry.consumedAt) {
        return { ok: false, error: 'CODE_NOT_FOUND', message: '请先发送验证码。' };
      }
      if (entry.expiresAt < now) {
        codes.delete(k);
        return { ok: false, error: 'CODE_EXPIRED', message: '验证码已过期，请重新发送。' };
      }
      if (entry.attempts >= maxAttempts) {
        codes.delete(k);
        return { ok: false, error: 'TOO_MANY_ATTEMPTS', message: '验证码错误次数过多，请重新发送。' };
      }
      entry.attempts += 1;
      if (entry.codeHash !== hashCode(code.trim())) {
        return { ok: false, error: 'CODE_MISMATCH', message: `验证码错误（剩余 ${maxAttempts - entry.attempts} 次机会）。` };
      }
      entry.consumedAt = now;
      codes.delete(k);
      return { ok: true };
    },

    async hasActiveCode(email, purpose) {
      const entry = codes.get(key(email, purpose));
      return !!entry && !entry.consumedAt && entry.expiresAt > Date.now();
    },
  };
}
