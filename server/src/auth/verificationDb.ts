/**
 * verificationDb.ts — 验证码落库版 VerificationStore（B5-1 持久化）。
 *
 * 与 createVerificationStore（内存版）接口/语义等价（cooldown、每小时限次、
 * 尝试上限、TTL、sha256 哈希），但状态存 `UserVerificationCode` 表：
 *   - 后端重启不丢码（此前重启 = 全部验证码失效，注册流程断）；
 *   - 多实例部署可用（进程内存 Map 在多实例下互不相通）。
 * 同邮箱同用途仅一条活跃码（@@unique([email,purpose])，重发即覆盖）——与内存版「键覆盖」一致。
 */
import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { VerificationPurpose, VerificationStore, IssueResult, VerifyResult } from './verification';

export interface DbVerificationStoreOptions {
  prisma: PrismaClient;
  codeTtlMs?: number;
  cooldownMs?: number;
  maxPerHour?: number;
  maxAttempts?: number;
}

function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function generateCode(): string {
  const buf = crypto.randomBytes(4);
  const num = buf.readUInt32BE(0) % 1_000_000;
  return num.toString().padStart(6, '0');
}

export function createDbVerificationStore(options: DbVerificationStoreOptions): VerificationStore {
  const prisma = options.prisma;
  const codeTtlMs = options.codeTtlMs ?? 10 * 60 * 1000;
  const cooldownMs = options.cooldownMs ?? 60 * 1000;
  const maxPerHour = options.maxPerHour ?? 5;
  const maxAttempts = options.maxAttempts ?? 5;

  async function loadActive(email: string, purpose: VerificationPurpose) {
    return prisma.userVerificationCode.findUnique({
      where: { email_purpose: { email: email.toLowerCase(), purpose } },
    });
  }

  async function countRecent(email: string, purpose: VerificationPurpose): Promise<number> {
    const since = new Date(Date.now() - 60 * 60 * 1000);
    return prisma.userVerificationCode.count({
      where: { email: email.toLowerCase(), purpose, issuedAt: { gte: since } },
    });
  }

  return {
    async issueCode(email, purpose): Promise<IssueResult> {
      const mail = email.toLowerCase();
      const now = Date.now();
      const existing = await loadActive(mail, purpose);

      if (existing && now - existing.issuedAt.getTime() < cooldownMs) {
        const retryAfterMs = cooldownMs - (now - existing.issuedAt.getTime());
        return {
          ok: false,
          error: 'COOLDOWN',
          message: `验证码已发送，请 ${Math.ceil(retryAfterMs / 1000)} 秒后再试。`,
          retryAfterMs,
        };
      }

      const recent = await countRecent(mail, purpose);
      if (recent >= maxPerHour) {
        return {
          ok: false,
          error: 'RATE_LIMITED',
          message: `已达每小时最多 ${maxPerHour} 次发送上限，请稍后再试。`,
          retryAfterMs: 60 * 60 * 1000,
        };
      }

      const code = generateCode();
      // upsert：同邮箱同用途覆盖（语义=旧码立即作废）
      await prisma.userVerificationCode.upsert({
        where: { email_purpose: { email: mail, purpose } },
        create: {
          id: `vcode__${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`,
          email: mail,
          purpose,
          codeHash: hashCode(code),
          expiresAt: new Date(now + codeTtlMs),
        },
        update: {
          codeHash: hashCode(code),
          issuedAt: new Date(now),
          expiresAt: new Date(now + codeTtlMs),
          attempts: 0,
          consumedAt: null,
        },
      });

      return { ok: true, code, expiresAt: new Date(now + codeTtlMs), cooldownMs };
    },

    async verifyCode(email, code, purpose): Promise<VerifyResult> {
      const mail = email.toLowerCase();
      const entry = await loadActive(mail, purpose);
      if (!entry || entry.consumedAt) {
        return { ok: false, error: 'CODE_NOT_FOUND', message: '请先发送验证码。' };
      }
      // 惰性清理：过期/耗尽尝试即删行（表保持小）
      if (entry.expiresAt.getTime() < Date.now()) {
        await prisma.userVerificationCode.delete({ where: { id: entry.id } }).catch(() => {});
        return { ok: false, error: 'CODE_EXPIRED', message: '验证码已过期，请重新发送。' };
      }
      if (entry.attempts >= maxAttempts) {
        await prisma.userVerificationCode.delete({ where: { id: entry.id } }).catch(() => {});
        return { ok: false, error: 'TOO_MANY_ATTEMPTS', message: '验证码错误次数过多，请重新发送。' };
      }
      const ok = entry.codeHash === hashCode(code.trim());
      if (!ok) {
        await prisma.userVerificationCode.update({
          where: { id: entry.id },
          data: { attempts: { increment: 1 } },
        });
        return { ok: false, error: 'CODE_MISMATCH', message: `验证码错误（剩余 ${maxAttempts - entry.attempts - 1} 次机会）。` };
      }
      await prisma.userVerificationCode.delete({ where: { id: entry.id } }).catch(() => {});
      return { ok: true };
    },

    async hasActiveCode(email, purpose): Promise<boolean> {
      const entry = await loadActive(email.toLowerCase(), purpose);
      return !!entry && !entry.consumedAt && entry.expiresAt.getTime() > Date.now();
    },
  };
}
