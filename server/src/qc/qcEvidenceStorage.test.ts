import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { identifyQcEvidenceFile, normalizeQcEvidenceIds, stageQcEvidenceInTx, readQcEvidenceInTx } from './qcEvidenceStorage';
let root: string;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYZkAAAAASUVORK5CYII=', 'base64');
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'bambook-qc-evidence-unit-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
function fixture() {
  const audits: any[] = [];
  const tx = { auditLog: { create: async ({ data }: any) => { audits.push(data); return data; },
    findFirst: async ({ where }: any) => audits.find(row => row.action === where.action && (!where.actorId || row.actorId === where.actorId)
      && (!where.targetId || row.targetId === where.targetId) && where.detail.path.reduce((value: any, key: string) => value?.[key], row.detail) === where.detail.equals) ?? null } };
  const input = { root, actorId: 'actual-qc', sourceKind: 'assignment' as const, sourceId: 'task-1', sourceFingerprint: 'a'.repeat(64),
    requestKey: 'stable-file-key', file: { originalname: '现场.png', buffer: png } };
  return { tx, audits, input };
}
describe('native QC private evidence', () => {
  it('identifies actual image, PDF and Word bytes instead of accepting a supplied extension', async () => {
    expect(await identifyQcEvidenceFile({ originalname: '现场.png', buffer: png })).toMatchObject({ mimeType: 'image/png', size: png.length });
    expect(await identifyQcEvidenceFile({ originalname: '报告.pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n') })).toMatchObject({ mimeType: 'application/pdf' });
    const zip = new JSZip(); zip.file('[Content_Types].xml', '<Types/>'); zip.file('word/document.xml', '<w:document/>');
    expect(await identifyQcEvidenceFile({ originalname: '报告.docx', buffer: await zip.generateAsync({ type: 'nodebuffer' }) })).toMatchObject({ mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    await expect(identifyQcEvidenceFile({ originalname: '假报告.pdf', buffer: png })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(identifyQcEvidenceFile({ originalname: '无内容.png', buffer: Buffer.alloc(0) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
  it('replays the original upload receipt and never duplicates bytes or audit facts', async () => {
    const f = fixture();
    const first = await stageQcEvidenceInTx(f.tx, f.input, () => {});
    const replay = await stageQcEvidenceInTx(f.tx, f.input, () => { throw Error('must not write another file'); });
    expect(replay.file).toEqual(first.file); expect(replay.replayed).toBe(true); expect(f.audits).toHaveLength(1);
    await expect(stageQcEvidenceInTx(f.tx, { ...f.input, sourceId: 'other-task' }, () => {})).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('binds report evidence to its exact task, actual uploader and original file hash', async () => {
    const f = fixture(); const uploaded = await stageQcEvidenceInTx(f.tx, f.input, () => {});
    const read = { root, sourceKind: 'assignment' as const, sourceId: 'task-1', sourceFingerprint: 'a'.repeat(64), ids: [uploaded.file.id] };
    expect(await readQcEvidenceInTx(f.tx, read)).toEqual([uploaded.file]);
    await expect(readQcEvidenceInTx(f.tx, { ...read, sourceId: 'task-2' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(readQcEvidenceInTx(f.tx, { ...read, sourceFingerprint: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    f.audits[0].actorId = 'forged';
    await expect(readQcEvidenceInTx(f.tx, read)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    f.audits[0].actorId = 'actual-qc';
    await fs.writeFile(path.join(root, f.audits[0].detail.after.relativePath), Buffer.from('changed actual original'));
    await expect(readQcEvidenceInTx(f.tx, read)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('rejects arbitrary URLs, duplicate attachments and private path escape', async () => {
    expect(() => normalizeQcEvidenceIds(['https://invalid/report.pdf'])).toThrow();
    const f = fixture(); const uploaded = await stageQcEvidenceInTx(f.tx, f.input, () => {});
    expect(() => normalizeQcEvidenceIds([uploaded.file.id, uploaded.file.id])).toThrow();
    f.audits[0].detail.after.relativePath = '../outside.png';
    await expect(stageQcEvidenceInTx(f.tx, f.input, () => {})).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
