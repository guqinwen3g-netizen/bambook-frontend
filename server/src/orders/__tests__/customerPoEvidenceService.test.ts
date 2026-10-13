import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCustomerPoEvidenceService } from '../customerPoEvidenceService';

vi.mock('../orderService', () => ({ buildOrderListScopeWhere: vi.fn(async () => ({})) }));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'customer-po-evidence-'));
  const rows: any[] = [], audits: any[] = [];
  const prisma: any = {
    order: { findFirst: vi.fn(async ({ where }: any) => where.id === 'ORDER-1' ? { id: 'ORDER-1' } : null) },
    customerPoEvidence: {
      findMany: vi.fn(async () => rows.slice().sort((a, b) => b.version - a.version)),
      findFirst: vi.fn(async ({ where, orderBy }: any) => {
        const matches = rows.filter(row => row.orderId === where.orderId && (!where.requestKey || row.requestKey === where.requestKey)
          && (!where.id || row.id === where.id));
        if (orderBy) return matches.sort((a, b) => b.version - a.version)[0] ?? null;
        return matches[0] ?? null;
      }),
      create: vi.fn(async ({ data }: any) => { rows.push(data); return data; }),
    },
    auditLog: { create: vi.fn(async ({ data }: any) => { audits.push(data); }) },
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (work: (tx: any) => Promise<any>) => work(prisma)),
  };
  return { root, rows, audits, prisma, service: createCustomerPoEvidenceService(prisma, { privateFilesDir: root }) };
}

const actor: any = { userId: 'sales-1' };
const pdf = (name = 'customer-po.pdf', text = 'PO evidence') => {
  const buffer = Buffer.from(`%PDF-1.7\n${text}`);
  return { buffer, originalName: name, size: buffer.length };
};
const requestKeyA = '11111111-1111-4111-8111-111111111111';
const requestKeyB = '22222222-2222-4222-8222-222222222222';

afterEach(() => { vi.clearAllMocks(); });

describe('customer PO evidence archive', () => {
  it('appends immutable versions, idempotently replays the same upload, and downloads the exact private original', async () => {
    const f = fixture();
    try {
      const first = await f.service.upload(actor, 'ORDER-1', pdf(), requestKeyA);
      expect(first).toMatchObject({ orderId: 'ORDER-1', version: 1, fileName: 'customer-po.pdf', replayed: false });
      expect(f.service.list).toBeTypeOf('function');
      const replay = await f.service.upload(actor, 'ORDER-1', pdf(), requestKeyA);
      expect(replay.id).toBe(first.id);
      expect(replay.replayed).toBe(true);
      const second = await f.service.upload(actor, 'ORDER-1', pdf('customer-po-revised.pdf', 'revised'), requestKeyB);
      expect(second.version).toBe(2);

      const downloaded = await f.service.download(actor, 'ORDER-1', first.id);
      expect(downloaded.bytes.toString()).toContain('PO evidence');
      expect(downloaded.evidence.version).toBe(1);
      expect(f.audits).toHaveLength(2);
      expect(f.audits[0].action).toBe('archive_customer_po_evidence');
      expect((await f.service.list(actor, 'ORDER-1')).items.map(item => item.version)).toEqual([2, 1]);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  it('rejects a replay key bound to different file bytes and rejects unknown orders', async () => {
    const f = fixture();
    try {
      await f.service.upload(actor, 'ORDER-1', pdf(), requestKeyA);
      await expect(f.service.upload(actor, 'ORDER-1', pdf('different.pdf', 'different'), requestKeyA)).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(f.service.list(actor, 'ORDER-MISSING')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(f.rows).toHaveLength(1);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  it('accepts only non-empty supported original files whose signature matches their extension', async () => {
    const f = fixture();
    try {
      await expect(f.service.upload(actor, 'ORDER-1', { buffer: Buffer.from('not pdf'), originalName: 'bad.pdf', size: 7 }, requestKeyA))
        .rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(f.service.upload(actor, 'ORDER-1', { buffer: Buffer.alloc(0), originalName: 'empty.pdf', size: 0 }, requestKeyA))
        .rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(f.rows).toHaveLength(0);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
});
