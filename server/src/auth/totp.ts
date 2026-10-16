/**
 * 两步验证（TOTP，RFC 6238：HMAC-SHA1 · 30 秒 · 6 位），兼容常见验证器 App（Google Authenticator、Microsoft Authenticator、1Password 等）。
 * 密钥以 AES-256-GCM 加密后存入 UserAccount.metadata.mfa；加密密钥由 JWT_SECRET 派生（轮换 JWT_SECRET 需让用户重新绑定）。
 */
import crypto from 'crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of clean) { const idx = B32.indexOf(ch); if (idx < 0) throw new Error('INVALID_BASE32'); value = (value << 5) | idx; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
export const generateTotpSecret = () => base32Encode(crypto.randomBytes(20));
export function totpAt(secret: string, counter: number): string {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const bin = ((h[off] & 127) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}
export const totpCounter = (nowMs = Date.now()) => Math.floor(nowMs / 30_000);
/** 允许前后各 1 个时间片（±30 秒）的时钟偏差；返回匹配的时间片序号，用于拒绝重放。 */
export function verifyTotp(secret: string, code: unknown, nowMs = Date.now(), afterCounter = -1): number | null {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return null;
  const c = totpCounter(nowMs), want = Buffer.from(code.trim());
  for (const k of [c - 1, c, c + 1]) {
    if (k <= afterCounter) continue;
    if (crypto.timingSafeEqual(Buffer.from(totpAt(secret, k)), want)) return k;
  }
  return null;
}
export function otpauthUri(secret: string, account: string, issuer = 'Bambook') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

function key() { return crypto.createHash('sha256').update('bambook-mfa-v1:' + (process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars')).digest(); }
export function sealSecret(secret: string): string {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}
export function openSecret(sealed: string): string {
  const [v, iv, tag, enc] = String(sealed).split('.');
  if (v !== 'v1' || !iv || !tag || !enc) throw new Error('INVALID_SEALED_SECRET');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}

/** 恢复码：10 个一次性码，格式 xxxx-xxxx；只存 SHA-256。 */
export function generateRecoveryCodes(n = 10): string[] {
  return Array.from({ length: n }, () => { const s = crypto.randomBytes(5).toString('hex'); return s.slice(0, 5) + '-' + s.slice(5); });
}
export const hashRecoveryCode = (code: string) => crypto.createHash('sha256').update(code.trim().toLowerCase()).digest('hex');

export type MfaState = { enabled: boolean; secret?: string; enabledAt?: string; lastCounter?: number; recovery?: string[]; pendingSecret?: string; pendingAt?: string };
export const mfaOf = (metadata: unknown): MfaState => {
  const m = (metadata as any)?.mfa;
  return m && typeof m === 'object' ? { enabled: m.enabled === true, ...m } : { enabled: false };
};
