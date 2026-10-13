/** Real native route + actual client, with synthetic storage/SMTP seams.
 * No company mailbox, database or external transmission is used. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createEmailRouter } from '../route';
import { emailOutboxService } from '../../../../services/emailOutboxService';
import { durableFixture } from './outboxDurableFixture';

const transport = vi.hoisted(() => ({ calls: 0 }));
vi.mock('nodemailer', () => ({ default: { createTransport: () => ({ sendMail: async () => {
  transport.calls++; return { messageId: '<isolated-contract@bambook.local>', accepted: ['recipient@bambook.local'], rejected: [], pending: [] };
} }) } }));
const token = jwt.sign({ userId: 'synthetic-email-actor', roles: ['owner'] }, process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars');
vi.mock('../../../../services/apiService', () => ({ apiService: {
  getStoredConfig: () => ({ cloudEndpoint: 'http://private-contract.invalid' }),
  buildApiUrl: (p: string, base: string) => base + '/api' + p,
  getAuthHeaders: () => ({ 'Content-Type': 'application/json', Cookie: `bambook_token=${token}` }),
} }));
afterEach(() => vi.unstubAllGlobals());

function actualRoute(auditFail = false) {
  transport.calls = 0;
  const state: any = { id: 'E-contract', direction: 'outbound', mailbox: 'Outbox',
    fromAddress: 'synthetic@bambook.local', fromName: 'Synthetic', toAddresses: '["recipient@bambook.local"]',
    ccAddresses: null, subject: 'Isolated contract', bodyText: 'Synthetic body', bodyHtml: null, messageId: null, sentAt: null };
  const {prisma,audits} = durableFixture(state, {actorId:'synthetic-email-actor',auditFail});

  const app = express(); app.use(express.json());
  app.use((req: any, _res: any, next: any) => { req.cookies = {}; (req.headers.cookie || '').split(';').forEach((c: string) => {
    const separator = c.indexOf('='); if (separator >= 0) req.cookies[c.slice(0, separator).trim()] = c.slice(separator + 1);
  }); next(); });
  app.use('/api/v1/email', createEmailRouter({ prisma, requireAuth: true, apiKeys: new Set() }));
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const response = await request(app).post(new URL(url).pathname).set(init.headers as any).send(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetcher);
  return { state, audits, fetcher };
}

describe('Native outbox send client contract', () => {
  it('consumes the real flat success response into the actual UI service data contract', async () => {
    const f = actualRoute();
    const result = await emailOutboxService.sendOutboxEmail('E-contract', { user: 'synthetic@bambook.local', pass: 'synthetic-only' });
    expect(result).toMatchObject({ ok: true, data: { emailId: 'E-contract', messageId: '<isolated-contract@bambook.local>', auditId: expect.any(String) } });
    expect(f.state.mailbox).toBe('Sent'); expect(f.audits).toHaveLength(1); expect(transport.calls).toBe(1); expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it('preserves the real post-SMTP audit failure and never retries the transport automatically', async () => {
    const f = actualRoute(true);
    const result = await emailOutboxService.sendOutboxEmail('E-contract', { user: 'synthetic@bambook.local', pass: 'synthetic-only' });
    expect(result).toMatchObject({ ok: false, error: { code: 'DB_UPDATE_FAILED', statusCode: 500 } });
    expect(result.error?.message).toContain('不要重复发送');
    expect(f.state.mailbox).toBe('Outbox'); expect(f.audits).toHaveLength(0); expect(transport.calls).toBe(1); expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ok: true, emailId: 'wrong-email', messageId: '<m>', sentAt: '2026-10-04 01:00:00', auditId: 'a' },
    { ok: true, emailId: 'E-contract', messageId: '', sentAt: '2026-10-04 01:00:00', auditId: 'a' },
    { ok: true, emailId: 'E-contract', messageId: '<m>', sentAt: 'invalid', auditId: 'a' },
    { ok: true, emailId: 'E-contract', messageId: '<m>', sentAt: '2026-10-04 01:00:00' },
  ])('does not publish a malformed or different-email receipt as successful', async body => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })); vi.stubGlobal('fetch', fetcher);
    const result = await emailOutboxService.sendOutboxEmail('E-contract', { user: 'synthetic', pass: 'synthetic' });
    expect(result.ok).toBe(false); expect(result.data).toBeUndefined(); expect(result.error?.message).toContain('勿重复'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not trust an ok:true payload returned with a failed HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, emailId: 'E-contract', messageId: '<m>', sentAt: '2026-10-04 01:00:00', auditId: 'a' }), { status: 503 })));
    expect((await emailOutboxService.sendOutboxEmail('E-contract', { user: 'synthetic', pass: 'synthetic' })).ok).toBe(false);
  });
});
