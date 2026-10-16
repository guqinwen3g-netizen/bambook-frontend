import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, generateRecoveryCodes, hashRecoveryCode, openSecret, sealSecret, totpAt, verifyTotp } from '../totp';

// RFC 6238 附录 B（SHA-1，密钥 "12345678901234567890"），取 8 位值的末 6 位。
const RFC = base32Encode(Buffer.from('12345678901234567890'));
describe('TOTP', () => {
  it('matches the RFC 6238 SHA-1 vectors', () => {
    expect(totpAt(RFC, Math.floor(59 / 30))).toBe('287082');
    expect(totpAt(RFC, Math.floor(1111111109 / 30))).toBe('081804');
    expect(totpAt(RFC, Math.floor(1234567890 / 30))).toBe('005924');
    expect(totpAt(RFC, Math.floor(2000000000 / 30))).toBe('279037');
  });
  it('round-trips base32 and accepts ±1 step, rejecting replays and malformed codes', () => {
    expect(base32Decode(base32Encode(Buffer.from('hello world'))).toString()).toBe('hello world');
    const now = 1_700_000_000_000, c = Math.floor(now / 30_000);
    expect(verifyTotp(RFC, totpAt(RFC, c - 1), now)).toBe(c - 1);
    expect(verifyTotp(RFC, totpAt(RFC, c + 1), now)).toBe(c + 1);
    expect(verifyTotp(RFC, totpAt(RFC, c - 2), now)).toBeNull();
    expect(verifyTotp(RFC, totpAt(RFC, c), now, c)).toBeNull();
    expect(verifyTotp(RFC, '12345', now)).toBeNull();
  });
  it('seals secrets with AES-GCM and hashes recovery codes case-insensitively', () => {
    const sealed = sealSecret(RFC);
    expect(sealed).not.toContain(RFC); expect(openSecret(sealed)).toBe(RFC);
    expect(() => openSecret(sealed.replace(/.$/, c => c === 'A' ? 'B' : 'A'))).toThrow();
    const codes = generateRecoveryCodes();
    expect(new Set(codes).size).toBe(10); expect(codes[0]).toMatch(/^[0-9a-f]{5}-[0-9a-f]{5}$/);
    expect(hashRecoveryCode(codes[0].toUpperCase())).toBe(hashRecoveryCode(codes[0]));
  });
});
