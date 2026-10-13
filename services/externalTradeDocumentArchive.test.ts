// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiService } from './apiService';

const BASE = 'http://native-external-doc.invalid:8081/api';
let transport: ReturnType<typeof vi.fn>;
const response = (data: unknown, status = 201) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('bambook_auth_token', 'synthetic-customs-token');
  transport = vi.fn();
  vi.stubGlobal('fetch', transport);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

it('uploads the third-party original as browser multipart without overriding the boundary and validates the receipt', async () => {
  const file = new File(['%PDF-1.7\noriginal'], 'draft-bl.pdf', { type: 'application/pdf' });
  const receipt = { ok: true, documentId: 'DOC/1', archive: { version: 4, fileName: file.name, mimeType: 'application/pdf',
    byteSize: file.size, sha256: 'a'.repeat(64), uploadedAt: 1000, uploadedBy: 'user-1' } };
  transport.mockResolvedValue(response(receipt));
  expect(await apiService.uploadExternalTradeDocumentArchive('DOC/1', file, BASE)).toEqual(receipt);

  expect(transport).toHaveBeenCalledExactlyOnceWith(BASE + '/v1/customs/trade-documents/DOC%2F1/external-archive', expect.objectContaining({ method: 'POST' }));
  const init = transport.mock.calls[0][1] as RequestInit;
  expect(init.body).toBeInstanceOf(FormData);
  expect((init.body as FormData).get('file')).toMatchObject({ name: 'draft-bl.pdf', size: file.size });
  expect(new Headers(init.headers).get('Authorization')).toBe('Bearer synthetic-customs-token');
  expect(new Headers(init.headers).has('Content-Type')).toBe(false);
});

it('does not accept a server receipt that names a different file version or byte size', async () => {
  const file = new File(['%PDF-1.7\noriginal'], 'draft-bl.pdf', { type: 'application/pdf' });
  transport.mockResolvedValue(response({ ok: true, documentId: 'DOC1', archive: { version: 1, fileName: file.name,
    mimeType: 'application/pdf', byteSize: file.size + 1, sha256: 'b'.repeat(64), uploadedAt: 1000, uploadedBy: 'user-1' } }));
  await expect(apiService.uploadExternalTradeDocumentArchive('DOC1', file, BASE)).rejects.toThrow('归档回执与所选原文件不一致');
});

it('downloads the exact requested historical original version', async () => {
  transport.mockResolvedValue({ ok: true, status: 200, blob: async () => new Blob(['original v4']) });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:external-original');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  await apiService.downloadExternalTradeDocumentArchive('DOC/1', 4, 'draft-bl.pdf', BASE);
  expect(transport).toHaveBeenCalledOnce();
  expect(transport.mock.calls[0][0]).toBe(BASE + '/v1/customs/trade-documents/DOC%2F1/download?version=4');
  expect((transport.mock.calls[0][1] as RequestInit).method).toBeUndefined();
  await expect(apiService.downloadExternalTradeDocumentArchive('DOC/1', 0, 'draft-bl.pdf', BASE)).rejects.toThrow('单据版本无效');
  expect(transport).toHaveBeenCalledTimes(1);
});
