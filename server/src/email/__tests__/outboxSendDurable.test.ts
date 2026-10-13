/** Actual producer with serial transactional synthetic storage and an injected
 * SMTP collector. These controls require durable fences, not transport retries. */
import { describe, expect, it, vi } from 'vitest';
import { sendOutboxEmail } from '../outboxSend';
import { readDurableOutboxContext } from '../outboxSendAttemptService';

function fixture() {
  const state: any = { email: { id: 'E-durable', direction: 'outbound', mailbox: 'Outbox',
    fromAddress: 'synthetic@bambook.local', fromName: 'Synthetic', toAddresses: '["recipient@bambook.local"]',
    ccAddresses: null, bccAddresses: null, subject: 'Synthetic', bodyText: 'Synthetic', bodyHtml: null,
    messageId: null, sentAt: null, updatedAt: 10n, deletedAt: null, hasAttachments: false, attachmentCount: 0 },
    attempt: null, audits: [], active: true, granted: true };
  const fault = { claim: false, persist: false, audit: false, authorization: false };
  let queue = Promise.resolve(), calls = 0;
  const match = (row: any, where: any) => !!row && Object.entries(where || {}).every(([k, v]: any) =>
    v && typeof v === 'object' && 'in' in v ? v.in.includes(row[k]) : row[k] === v);
  const models: any = {
    email: { findUnique: async () => ({ ...state.email }), findFirst: async () => ({ ...state.email }),
      update: async ({ data }: any) => Object.assign(state.email, data),
      updateMany: async ({ where, data }: any) => match(state.email, where) ? (Object.assign(state.email, data), { count: 1 }) : { count: 0 } },
    userAccount: { findUnique: async () => { if (fault.authorization) throw Error('synthetic authorization SQL failure');
      return { id: 'actor', status: state.active ? 'active' : 'inactive', deletedAt: null,
        roles: [{ role: { id: 'synthetic-writer', permissions: state.granted ? [{ permission: { scope: 'emails:write' } }] : [] } }] }; } },
    userPermissionOverrides: { findMany: async () => [] },
    emailSendAttempt: {
      findUnique: async () => state.attempt && { ...state.attempt },
      create: async ({ data }: any) => { if (fault.claim) throw Error('synthetic claim failure');
        if (state.attempt) throw Object.assign(Error('duplicate'), { code: 'P2002' }); state.attempt = { ...data }; return state.attempt; },
      update: async ({ data }: any) => { if (fault.persist) throw Error('synthetic receipt failure'); return Object.assign(state.attempt, data); },
      updateMany: async ({ where, data }: any) => { if (fault.persist) throw Error('synthetic receipt failure');
        return match(state.attempt, where) ? (Object.assign(state.attempt, data), { count: 1 }) : { count: 0 }; },
    },
    auditLog: { create: async ({ data }: any) => { if (fault.audit) throw Error('synthetic audit failure'); state.audits.push(data); return data; },
      findUnique: async ({ where }: any) => state.audits.find((a: any) => a.id === where.id) || null },
    $queryRaw: async () => [], $executeRaw: async () => 1,
  };
  const prisma: any = { ...models, $transaction: async (fn: any) => {
    const previous = queue; let release!: () => void; queue = new Promise<void>(r => release = r); await previous;
    const before = structuredClone(state);
    try { return await fn(models); } catch (e) { Object.assign(state, before); throw e; } finally { release(); }
  } };
  const collector = vi.fn(async (_mail?: any): Promise<any> => ({ messageId: `<synthetic-${++calls}@bambook.local>`,
    accepted: ['recipient@bambook.local'], rejected: [], pending: [] }));
  const factory: any = () => ({ sendMail: collector });
  const send = (overrides: any = {}) => sendOutboxEmail({ prisma, emailId: state.email.id, actorId: 'actor',
    credentials: { user: state.email.fromAddress, pass: 'synthetic-only' }, createTransporter: factory, ...overrides });
  const context = () => readDurableOutboxContext({ prisma, emailId: state.email.id, actorId: 'actor' });
  return { state, fault, collector, send, context, calls: () => collector.mock.calls.length };
}

describe('Durable native Outbox submission and recovery', () => {
  it('reads the server-native approval context without claiming or transmitting', async () => {
    const f = fixture(), opened = await f.context();
    expect(opened).toMatchObject({ok:true,data:{sendContextVersion:1,emailId:'E-durable',contentHash:expect.stringMatching(/^[a-f0-9]{64}$/),content:{bodyText:'Synthetic'}}});
    expect(f.state.attempt).toBeNull(); expect(f.calls()).toBe(0); expect(JSON.stringify(opened)).not.toContain('synthetic-only');
  });
  it('checks the approved original body hash inside the claim transaction', async () => {
    const f = fixture(), opened = await f.context(); if (!opened.ok) throw Error('context unavailable');
    f.state.email.bodyText = 'Changed after approval';
    expect(await f.send({expectedContentHash:opened.data.contentHash})).toMatchObject({ok:false,error:{code:'SEND_CONTENT_CHANGED'}});
    expect(f.state.attempt).toBeNull();expect(f.calls()).toBe(0);
  });
  it('does not change the approved SMTP identity before transmitting', async () => {
    const f=fixture();expect(await f.send({expectedSmtpUser:'other@bambook.local'})).toMatchObject({ok:false,error:{code:'SEND_CONTENT_CHANGED'}});
    expect(f.state.attempt).toBeNull();expect(f.calls()).toBe(0);
  });
  it('does not manufacture a send claim from a legacy approval recovery hint', async () => {
    const f=fixture();expect(await f.send({recoveryOnly:true})).toMatchObject({ok:false,error:{code:'SEND_RESULT_UNCERTAIN'}});
    expect(f.state.attempt).toBeNull();expect(f.calls()).toBe(0);expect(f.state.audits).toHaveLength(0);
  });
  it('recovers an accepted original receipt without fresh SMTP credentials but retains approval CAS', async () => {
    const f=fixture(),opened=await f.context();if(!opened.ok)throw Error('context unavailable');
    const expected={expectedContentHash:opened.data.contentHash,expectedSmtpUser:f.state.email.fromAddress};
    f.fault.audit=true;expect((await f.send(expected)).ok).toBe(false);f.fault.audit=false;
    expect((await f.send({...expected,recoveryOnly:true,credentials:{user:'',pass:''}})).ok).toBe(true);expect(f.calls()).toBe(1);
    expect((await f.send({...expected,expectedContentHash:'0'.repeat(64),recoveryOnly:true})).ok).toBe(false);expect(f.calls()).toBe(1);
  });
  it('claims before SMTP and prevents another process from submitting the same email', async () => {
    const f = fixture(); let entered!: () => void, release!: () => void;
    const started = new Promise<void>(r => entered = r), held = new Promise<void>(r => release = r);
    f.collector.mockImplementationOnce(async () => { entered(); await held; return { messageId: '<first@bambook.local>', accepted: ['recipient@bambook.local'], rejected: [], pending: [] }; });
    const first = f.send(); await started; const second = await f.send(); release(); const original = await first;
    expect(original.ok).toBe(true); expect(second.ok).toBe(false); expect(f.calls()).toBe(1);
    expect(f.state.attempt.status).toBe('sent'); expect(f.state.audits).toHaveLength(1);
  });
  it('reconciles a durable accepted receipt after native audit rollback without another SMTP call', async () => {
    const f = fixture(); f.fault.audit = true; const first = await f.send();
    expect(first.ok).toBe(false); expect(f.state.email.mailbox).toBe('Outbox'); expect(f.state.attempt?.status).toBe('accepted');
    f.fault.audit = false; const recovered = await f.send();
    expect(recovered.ok).toBe(true); expect(f.calls()).toBe(1); expect(f.state.email.mailbox).toBe('Sent');
    expect(f.state.audits).toHaveLength(1);
  });
  it('does not contact SMTP if the durable claim cannot be committed', async () => {
    const f = fixture(); f.fault.claim = true;
    expect((await f.send()).ok).toBe(false); expect(f.calls()).toBe(0); expect(f.state.email.mailbox).toBe('Outbox');
  });
  it('retains the claim when accepted SMTP receipt persistence fails and refuses retransmission', async () => {
    const f = fixture(); f.fault.persist = true; expect((await f.send()).ok).toBe(false);
    f.fault.persist = false; expect((await f.send()).ok).toBe(false); expect(f.calls()).toBe(1);
    expect(f.state.email.mailbox).toBe('Outbox'); expect(f.state.audits).toHaveLength(0);
  });
  it('treats an ambiguous SMTP exception as unresolved rather than safe to resend', async () => {
    const f = fixture(); f.collector.mockRejectedValueOnce(Error('synthetic disconnected after DATA'));
    expect((await f.send()).ok).toBe(false); expect((await f.send()).ok).toBe(false);
    expect(f.calls()).toBe(1); expect(f.state.email.mailbox).toBe('Outbox');
  });
  it('does not resend after an SMTP response without a trustworthy message ID', async () => {
    const f = fixture(); f.collector.mockResolvedValueOnce({ messageId: '' });
    expect((await f.send()).ok).toBe(false); expect((await f.send()).ok).toBe(false); expect(f.calls()).toBe(1);
  });
  it.each([
    { messageId: '<partial@bambook.local>', accepted: ['recipient@bambook.local'], rejected: ['other@bambook.local'] },
    { messageId: '<none@bambook.local>', accepted: [] },
  ])('does not claim complete delivery or resend after incomplete recipient acceptance', async receipt => {
    const f = fixture(); f.collector.mockResolvedValueOnce(receipt);
    expect((await f.send()).ok).toBe(false); expect((await f.send()).ok).toBe(false);
    expect(f.calls()).toBe(1); expect(f.state.attempt.status).toBe('unknown'); expect(f.state.email.mailbox).toBe('Outbox');
  });
  it.each([
    { messageId: '<no-proof@bambook.local>' },
    { messageId: '<wrong-shape@bambook.local>', accepted: 'recipient@bambook.local', rejected: [], pending: [] },
    { messageId: '<pending@bambook.local>', accepted: ['recipient@bambook.local'], rejected: [], pending: ['recipient@bambook.local'] },
  ])('does not publish SMTP acceptance without complete structured recipient evidence', async receipt => {
    const f = fixture(); f.collector.mockResolvedValueOnce(receipt);
    expect((await f.send()).ok).toBe(false); expect((await f.send()).ok).toBe(false); expect(f.calls()).toBe(1);
  });
  it('includes hidden-copy recipients in the frozen acceptance proof', async () => {
    const f = fixture(); f.state.email.bccAddresses = '["hidden@bambook.local"]';
    expect((await f.send()).ok).toBe(false); expect(f.calls()).toBe(1); expect(f.state.email.mailbox).toBe('Outbox');
  });
  it('accepts complete To, CC and BCC proof and replays the same native receipt', async () => {
    const f = fixture(); f.state.email.ccAddresses = '["copy@bambook.local"]'; f.state.email.bccAddresses = '["hidden@bambook.local"]';
    f.collector.mockResolvedValueOnce({ messageId: '<complete@bambook.local>', accepted: ['hidden@bambook.local', 'recipient@bambook.local', 'copy@bambook.local'], rejected: [], pending: [] });
    const first = await f.send(), replay = await f.send();
    expect(first.ok).toBe(true); expect(replay).toEqual(first); expect(f.calls()).toBe(1);
    expect(f.collector.mock.calls[0][0]).toMatchObject({ cc: ['copy@bambook.local'], bcc: ['hidden@bambook.local'] });
    expect(f.state.attempt.smtpReceipt.expected).toEqual(['copy@bambook.local', 'hidden@bambook.local', 'recipient@bambook.local']);
  });
  it('refuses corrupted stored recipient proof without contacting SMTP again', async () => {
    const f = fixture(); f.fault.audit = true; await f.send(); f.fault.audit = false;
    f.state.attempt.smtpReceipt.accepted = ['other@bambook.local'];
    expect((await f.send()).ok).toBe(false); expect(f.calls()).toBe(1); expect(f.state.email.mailbox).toBe('Outbox');
  });
  it('blocks a changed native message from consuming an older accepted receipt', async () => {
    const f = fixture(); f.collector.mockImplementationOnce(async () => { f.state.email.subject = 'Changed after claim'; return { messageId: '<original@bambook.local>', accepted: ['recipient@bambook.local'], rejected: [], pending: [] }; });
    expect((await f.send()).ok).toBe(false); expect((await f.send()).ok).toBe(false); expect(f.calls()).toBe(1);
    expect(f.state.email.subject).toBe('Changed after claim'); expect(f.state.email.mailbox).toBe('Outbox');
  });
  it('does not claim or transmit for a currently inactive actor', async () => {
    const f = fixture(); f.state.active = false;
    expect((await f.send()).ok).toBe(false); expect(f.state.attempt).toBeNull(); expect(f.calls()).toBe(0);
  });
  it('does not transmit after current database permissions are revoked', async () => {
    const f = fixture(); f.state.granted = false;
    expect((await f.send()).ok).toBe(false); expect(f.calls()).toBe(0); expect(f.state.attempt).toBeNull();
  });
  it('does not treat authorization SQL failure as permission to transmit', async () => {
    const f = fixture(); f.fault.authorization = true;
    expect((await f.send()).ok).toBe(false); expect(f.calls()).toBe(0); expect(f.state.attempt).toBeNull();
  });
  it('does not return a malformed stored receipt as success or resend it', async () => {
    const f = fixture(); f.fault.audit = true; await f.send(); f.fault.audit = false;
    if (f.state.attempt) f.state.attempt.smtpMessageId = '';
    expect((await f.send()).ok).toBe(false); expect(f.calls()).toBe(1); expect(f.state.email.mailbox).toBe('Outbox');
  });
});
