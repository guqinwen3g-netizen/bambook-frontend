import { createPrivateAllocationClients } from './allocationPrivatePgHarness';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';
import { createAllocation } from '../src/finance/allocationMutationService';
import { readAllocationAttemptRefusal, runAllocationAttempt } from '../src/finance/allocationAttemptOutcome';

const [a, b] = createPrivateAllocationClients(PrismaClient);
const actorId = 'BORROW-actor';
let borrowed: unknown;
const journal: any[] = [];
const fallback = { ok: false, error: { code: 'CREATE_FAILED', message: '核销未能保存，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对发票与凭证数据。' } };
beforeAll(async () => {
  const rows: any[] = await a.$queryRawUnsafe("SELECT current_database() AS db,current_setting('data_directory') AS dir,inet_server_port() AS port");
  expect(rows[0]).toEqual({ db: process.env.BAMBOOK_ACCEPTANCE_DB_NAME, dir: process.env.BAMBOOK_ACCEPTANCE_DB_DIR, port: Number(process.env.BAMBOOK_ACCEPTANCE_DB_PORT) });
  await a.userAccount.create({ data: { id: actorId, displayName: 'Private borrowed-refusal actor' } });
  await runAllocationAttempt(a, async () => { throw new Error('private aborted callback'); }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }, { actorId, source: 'route:allocation:create', operation: 'create_allocation' }, () => false).catch(error => { borrowed = error; });
  journal.push({ identity: rows, borrowed: readAllocationAttemptRefusal(borrowed) });
});
afterAll(async () => {
  fs.writeFileSync(path.join(process.env.BAMBOOK_ACCEPTANCE_SANDBOX!, 'borrowed-refusal-journal.json'), JSON.stringify(journal, (_key, value) => typeof value === 'bigint' ? String(value) : value, 2));
  await Promise.all([a.$disconnect(), b.$disconnect()]);
});
async function seed(key: string) {
  await a.invoice.create({ data: { id: key, invoiceNumber: key, type: 'Receivable', status: 'Issued', amount: 100, currency: 'USD', issueDate: '2026-10-03', createdAt: 1n, updatedAt: 1n } });
  await a.paymentVoucher.create({ data: { id: key + '-v', voucherNumber: key + '-v', type: 'Receipt', amount: 100, currency: 'USD', paymentDate: '2026-10-03', paymentMethod: 'TT', createdAt: 1n, updatedAt: 1n } });
}
it('a real own native aborted attempt mints its private refusal without public error shape', () => {
  expect(readAllocationAttemptRefusal(borrowed)).toEqual({ code: 'CONFLICT', statusCode: 409, message: '本次核销操作已完整回滚，未保存本次改动。请重新核对发票与凭证后再决定下一步。' });
  expect(Object.getOwnPropertyNames(borrowed)).toEqual([]);
});
it('another genuine private refusal thrown by the actual committed proof read remains unknown without certifying rollback', async () => {
  const key = 'BORROW-committed'; await seed(key);
  let pending: any, ownXid = ''; const native = a.$transaction.bind(a);
  const adapter: any = { auditLog: b.auditLog,
    $queryRawUnsafe: async (sql: string, ...args: any[]) => { const rows: any[] = await b.$queryRawUnsafe(sql, ...args); journal.push({ proofRows: rows }); throw borrowed; },
    $transaction: async (work: any, options: any) => { await native(async tx => { ownXid = (await tx.$queryRawUnsafe<Array<{ xid: string }>>('SELECT pg_current_xact_id()::text AS xid'))[0]!.xid; pending = await work(tx); return pending; }, options); throw new Error('private lost return'); },
  };
  const result = await createAllocation({ prisma: adapter, input: { invoiceId: key, voucherId: key + '-v', appliedAmount: '20' }, actorId });
  const state = (await b.$queryRawUnsafe<Array<{ state: string }>>('SELECT pg_xact_status($1::xid8)::text AS state', ownXid))[0]!.state;
  const allocation = await b.invoiceAllocation.findUniqueOrThrow({ where: { id: pending.allocation.id } }), invoice = await b.invoice.findUniqueOrThrow({ where: { id: key } }), voucher = await b.paymentVoucher.findUniqueOrThrow({ where: { id: key + '-v' } });
  journal.push({ kind: 'borrowed-proof-fault', ownXid, state, pending, result, allocation, invoice, voucher });
  expect(state).toBe('committed'); expect(allocation.appliedAmount.toString()).toBe('20'); expect(voucher.appliedAmount!.toString()).toBe('20'); expect(invoice.status).toBe('PartiallyPaid'); expect(await b.invoiceAllocation.count({ where: { invoiceId: key } })).toBe(1);
  expect(result).toEqual(fallback); expect(JSON.stringify(result)).not.toContain('已整笔回滚');
});
it('another genuine private refusal in the actual callback cannot bypass a missing own xid even when native rollback occurred', async () => {
  const key = 'BORROW-callback'; await seed(key); const native = a.$transaction.bind(a); let ownXid = '';
  const adapter: any = { auditLog: b.auditLog, $queryRawUnsafe: b.$queryRawUnsafe.bind(b),
    $transaction: (work: any, options: any) => native(async tx => {
      const observed = new Proxy(tx, { get(target, property) {
        if (property === '$queryRawUnsafe') return async (sql: string, ...args: any[]) => { const rows: any[] = await tx.$queryRawUnsafe(sql, ...args); if (sql === 'SELECT pg_current_xact_id()::text AS xid') { ownXid = rows[0].xid; return []; } return rows; };
        if (property === 'invoice') return new Proxy(tx.invoice, { get(delegate, method) { if (method === 'findUnique') return async (args: any) => { await tx.invoice.findUnique(args); throw borrowed; }; return Reflect.get(delegate, method); } });
        return Reflect.get(target, property);
      } }); return work(observed);
    }, options),
  };
  const result = await createAllocation({ prisma: adapter, input: { invoiceId: key, voucherId: key + '-v', appliedAmount: '20' }, actorId });
  const state = (await b.$queryRawUnsafe<Array<{ state: string }>>('SELECT pg_xact_status($1::xid8)::text AS state', ownXid))[0]!.state;
  journal.push({ kind: 'borrowed-callback-no-own-proof', ownXid, state, result });
  expect(state).toBe('aborted'); expect(await b.invoiceAllocation.count({ where: { invoiceId: key } })).toBe(0); expect(await b.auditLog.count({ where: { targetId: key } })).toBe(0);
  expect(result).toEqual(fallback); expect(JSON.stringify(result)).not.toContain('已整笔回滚');
});
