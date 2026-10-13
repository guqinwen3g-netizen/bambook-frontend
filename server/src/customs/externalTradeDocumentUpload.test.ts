import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createExternalTradeDocumentUpload } from './externalTradeDocumentUpload';

async function receive(parts: string[]) {
  const boundary = 'native-external-upload-boundary';
  const body = Buffer.from(parts.map(part => `--${boundary}\r\n${part}\r\n`).join('') + `--${boundary}--\r\n`);
  const request = Readable.from([body]) as Readable & { headers: object; file?: { buffer: Buffer; mimetype: string }; body?: unknown };
  request.headers = { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length), 'transfer-encoding': 'chunked' };
  await new Promise<void>((resolve, reject) => createExternalTradeDocumentUpload()(request as any, {} as any, error => error ? reject(error) : resolve()));
  return request.file;
}
const file = 'Content-Disposition: form-data; name="file"; filename="external.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4 actual external original';
describe('external original upload transport', () => {
  it('accepts exactly one valid file part for the actual archive service to inspect', async () => {
    const actual = await receive([file]);
    expect(actual?.mimetype).toBe('application/pdf');
    expect(actual?.buffer.toString()).toContain('%PDF-1.4');
  });
  it('rejects a second file', async () => {
    await expect(receive([file, file])).rejects.toMatchObject({ code: 'LIMIT_FILE_COUNT' });
  });
  it('rejects extra form fields', async () => {
    await expect(receive([file, 'Content-Disposition: form-data; name="actorId"\r\n\r\nforged-user'])).rejects.toMatchObject({ code: 'LIMIT_FIELD_COUNT' });
  });
});
