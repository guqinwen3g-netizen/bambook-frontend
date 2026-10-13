import { createPrivateAllocationClients } from './allocationPrivatePgHarness';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';
import { createAllocation } from '../src/finance/allocationMutationService';
const [a, b] = createPrivateAllocationClients(PrismaClient);
const journal: any[] = [];
beforeAll(async () => {
  const rows: any[] = await a.$queryRawUnsafe("SELECT current_database() AS db,current_setting('data_directory') AS dir,inet_server_port() AS port");
  expect(rows[0]).toEqual({ db: process.env.BAMBOOK_ACCEPTANCE_DB_NAME, dir: process.env.BAMBOOK_ACCEPTANCE_DB_DIR, port: Number(process.env.BAMBOOK_ACCEPTANCE_DB_PORT) });
  await a.invoice.create({ data: { id: 'AUDIT-FAIL-i', invoiceNumber: 'AUDIT-FAIL-i', type: 'Receivable', status: 'Issued', amount: 100, currency: 'USD', issueDate: '2026-10-03', createdAt: 1n, updatedAt: 1n } });
  await a.paymentVoucher.create({ data: { id: 'AUDIT-FAIL-v', voucherNumber: 'AUDIT-FAIL-v', type: 'Receipt', amount: 100, currency: 'USD', paymentDate: '2026-10-03', paymentMethod: 'TT', createdAt: 1n, updatedAt: 1n } });
  journal.push({ identity: rows });
});
afterAll(async () => {
  fs.writeFileSync(path.join(process.env.BAMBOOK_ACCEPTANCE_SANDBOX!, 'audit-failure-journal.json'), JSON.stringify(journal, (_key, value) => typeof value === 'bigint' ? String(value) : value, 2));
  await Promise.all([a.$disconnect(), b.$disconnect()]);
});
it('actual mandatory audit foreign-key failure remains safe500 with no ledger or audit write rather than a claimed concurrency409', async () => {
  const native = a.$transaction.bind(a); let ownXid = '', error: any;
  const adapter: any = { auditLog: b.auditLog, $queryRawUnsafe: b.$queryRawUnsafe.bind(b), $transaction: (work: any, options: any) => native(async tx => {
    ownXid = (await tx.$queryRawUnsafe<Array<{ xid: string }>>('SELECT pg_current_xact_id()::text AS xid'))[0]!.xid;
    return work(tx);
  }, options).catch(failure => { error = failure; throw failure; }) };
  // The private database has no actor with this ID: its actual AuditLog FK
  // fails inside the unchanged mandatory producer, after proposed ledger writes.
  const result = await createAllocation({ prisma: adapter, input: { invoiceId: 'AUDIT-FAIL-i', voucherId: 'AUDIT-FAIL-v', appliedAmount: '20' }, actorId: 'AUDIT-FAIL-absent-actor' });
  const state = (await b.$queryRawUnsafe<Array<{ state: string }>>('SELECT pg_xact_status($1::xid8)::text AS state', ownXid))[0]!.state;
  const invoice = await b.invoice.findUniqueOrThrow({ where: { id: 'AUDIT-FAIL-i' } }), voucher = await b.paymentVoucher.findUniqueOrThrow({ where: { id: 'AUDIT-FAIL-v' } });
  const counts = { allocation: await b.invoiceAllocation.count(), audit: await b.auditLog.count() };
  journal.push({ kind: 'actual-audit-fk-failure', ownXid, state, error: { code: error.code, message: error.message, meta: error.meta }, result, invoice, voucher, counts });
  expect(error.code).toBe('P2003'); expect(state).toBe('aborted'); expect(counts).toEqual({ allocation: 0, audit: 0 }); expect(invoice.status).toBe('Issued'); expect(voucher.appliedAmount?.toString() ?? '0').toBe('0');
  expect(result).toEqual({ ok: false, error: { code: 'CREATE_FAILED', message: '核销未能保存，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对发票与凭证数据。' } });
});
it('actual nonconcurrent native query abort reports only proven complete rollback without inventing a concurrency cause or an automatic retry', async () => {
  await a.invoice.create({ data: { id: 'AUDIT-FAIL-query-i', invoiceNumber: 'AUDIT-FAIL-query-i', type: 'Receivable', status: 'Issued', amount: 100, currency: 'USD', issueDate: '2026-10-03', createdAt: 1n, updatedAt: 1n } });
  const native = a.$transaction.bind(a); let ownXid = '', error: any;
  const adapter: any = { auditLog: b.auditLog, $queryRawUnsafe: b.$queryRawUnsafe.bind(b), $transaction: (work: any, options: any) => native(async tx => {
    ownXid = (await tx.$queryRawUnsafe<Array<{ xid: string }>>('SELECT pg_current_xact_id()::text AS xid'))[0]!.xid;
    const observed = new Proxy(tx, { get(target, property) {
      if (property !== 'invoice') return Reflect.get(target, property);
      return new Proxy(tx.invoice, { get(delegate, method) {
        if (method !== 'findUnique') return Reflect.get(delegate, method);
        return async (args: any) => { await tx.invoice.findUnique(args); await tx.$queryRawUnsafe('SELECT id FROM "PrivateAllocationMissingRelation"'); };
      } });
    } }); return work(observed);
  }, options).catch(failure => { error = failure; throw failure; }) };
  const result = await createAllocation({ prisma: adapter, input: { invoiceId: 'AUDIT-FAIL-query-i', voucherId: 'AUDIT-FAIL-v', appliedAmount: '20' }, actorId: 'AUDIT-FAIL-absent-actor' });
  const state = (await b.$queryRawUnsafe<Array<{ state: string }>>('SELECT pg_xact_status($1::xid8)::text AS state', ownXid))[0]!.state;
  journal.push({ kind: 'actual-nonconcurrent-query-abort', ownXid, state, error: { code: error.code, meta: error.meta, message: error.message }, result });
  expect(error.code).toBe('P2010'); expect(error.meta.code).toBe('42P01'); expect(state).toBe('aborted'); expect(await b.invoiceAllocation.count()).toBe(0); expect(await b.auditLog.count()).toBe(0);
  expect(result).toEqual({ ok: false, error: { code: 'CONFLICT', message: '本次核销操作已完整回滚，未保存本次改动。请重新核对发票与凭证后再决定下一步。' } });
  expect(JSON.stringify(result)).not.toMatch(/并发|同时提交|可安全重试|重新提交一次|P2010|42P01|PrivateAllocationMissingRelation/);
});
