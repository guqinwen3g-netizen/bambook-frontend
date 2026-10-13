import { afterEach, expect, it, vi } from 'vitest';
import { resolveCustomerConfirmationEmailFromMailbox, searchCustomerConfirmationTargets } from './customerConfirmationService';

const mailSource = { mailbox: 'INBOX', uid: 77, subject: 'Re: PO-2030-4', sender: 'Mina <mina@example.invalid>',
  date: '2030-03-04T05:06:07.000Z' };
const persistedEmail = { id: 'EML__persisted', direction: 'inbound', mailbox: 'INBOX', uid: 77,
  subject: 'Re: PO-2030-4', fromAddress: 'mina@example.invalid', sentAt: '2030-03-04T05:06:07.000Z',
  bodyText: 'Please confirm the final order version.', attachments: [] };

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => { vi.unstubAllGlobals(); });

it('resolves a unique inbound source by exact mailbox+UID and then returns only the persisted body', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ ok: true, items: [{ id: 'EML__persisted', uid: 77 }] }))
    .mockResolvedValueOnce(jsonResponse({ ok: true, data: persistedEmail }));
  vi.stubGlobal('fetch', fetchMock);

  const row = await resolveCustomerConfirmationEmailFromMailbox(mailSource);
  expect(row).toEqual(persistedEmail);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const mapUrl = new URL(String(fetchMock.mock.calls[0][0]));
  expect(mapUrl.pathname).toMatch(/\/v1\/email\/intents$/);
  expect(mapUrl.searchParams.get('mailbox')).toBe('INBOX');
  expect(mapUrl.searchParams.get('uids')).toBe('77');
  expect(String(fetchMock.mock.calls[1][0])).toContain('/v1/email/EML__persisted');
});

it('fails closed when mailbox UID is absent or ambiguous and never reads an arbitrary DB row', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ ok: true, items: [] }));
  vi.stubGlobal('fetch', fetchMock);
  await expect(resolveCustomerConfirmationEmailFromMailbox(mailSource)).rejects.toThrow('尚未同步');
  expect(fetchMock).toHaveBeenCalledTimes(1);

  fetchMock.mockReset().mockResolvedValueOnce(jsonResponse({ ok: true, items: [
    { id: 'EML__one', uid: 77 }, { id: 'EML__two', uid: 77 },
  ] }));
  await expect(resolveCustomerConfirmationEmailFromMailbox(mailSource)).rejects.toThrow('多条已同步记录');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('rejects outbound, reused-UID, or header-mismatched mail rows', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ ok: true, items: [{ id: 'EML__persisted', uid: 77 }] }))
    .mockResolvedValueOnce(jsonResponse({ ok: true, data: { ...persistedEmail, direction: 'outbound' } }));
  vi.stubGlobal('fetch', fetchMock);
  await expect(resolveCustomerConfirmationEmailFromMailbox(mailSource)).rejects.toThrow('身份不一致');

  fetchMock.mockReset()
    .mockResolvedValueOnce(jsonResponse({ ok: true, items: [{ id: 'EML__persisted', uid: 77 }] }))
    .mockResolvedValueOnce(jsonResponse({ ok: true, data: { ...persistedEmail, subject: 'Different message' } }));
  await expect(resolveCustomerConfirmationEmailFromMailbox(mailSource)).rejects.toThrow('身份不一致');
});

it('loads exact or linked candidates from the registered target search route and requires a verified version', async () => {
  const candidate = { targetType: 'OrderChangeRequest', targetId: 'OCR__1', businessLabel: '订单变更申请',
    businessReference: 'OCR-2030-1', finalContentFingerprint: 'a'.repeat(64), internalApprovalId: 'APPROVAL__1',
    scopeFingerprint: 'b'.repeat(64), scope: { fields: [] }, nativeStatus: { canConfirm: true } };
  const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ ok: true, emailId: persistedEmail.id,
    searchMode: 'exact-reference', candidates: [candidate] }));
  vi.stubGlobal('fetch', fetchMock);

  await expect(searchCustomerConfirmationTargets(persistedEmail.id, ' OCR-2030-1 ')).resolves.toEqual([candidate]);
  const url = new URL(String(fetchMock.mock.calls[0][0]));
  expect(url.pathname).toMatch(/\/v1\/customer-confirmations\/targets$/);
  expect(url.searchParams.get('emailId')).toBe(persistedEmail.id);
  expect(url.searchParams.get('businessReference')).toBe('OCR-2030-1');

  fetchMock.mockReset().mockResolvedValueOnce(jsonResponse({ ok: true, emailId: persistedEmail.id,
    candidates: [{ ...candidate, scopeFingerprint: 'invalid' }] }));
  await expect(searchCustomerConfirmationTargets(persistedEmail.id)).rejects.toThrow('缺少当前版本或确认范围');
});
