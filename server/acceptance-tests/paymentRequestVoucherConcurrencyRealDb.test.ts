/**
 * DR-017: independent concurrent issuance calls must converge to one persisted
 * PaymentVoucher, one PaymentRequest link, and an idempotent loser response.
 * Requires the runner-owned private PostgreSQL sandbox; no shared DB is allowed.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import { createPaymentRequestService } from '../src/paymentRequests/paymentRequestService';

const marker = `acceptance-payment-request-voucher-${randomUUID()}`;
let prisma: PrismaClient | undefined;
const db = () => { if (!prisma) throw new Error('private payment-request fixture not initialized'); return prisma; };

describe.sequential('DR-017 payment request voucher concurrency in isolated PostgreSQL', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || '');
    const name = process.env.BAMBOOK_ACCEPTANCE_DB_NAME;
    const directory = process.env.BAMBOOK_ACCEPTANCE_DB_DIR;
    const port = process.env.BAMBOOK_ACCEPTANCE_DB_PORT;
    expect(Boolean(process.env.BAMBOOK_ACCEPTANCE_SANDBOX)).toBe(true);
    expect(url.protocol).toBe('postgresql:');
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.port).toBe(port);
    expect(url.pathname).toBe(`/${name}`);
    expect(url.pathname).toMatch(/^\/bambook_acceptance_[a-f0-9]+$/);
    expect(Boolean(directory)).toBe(true);
    expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
    prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    const identity = await db().$queryRaw<Array<{ name: string; directory: string; port: number }>>`
      SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port
    `;
    expect(identity, 'verify private PG identity before writing fixtures').toEqual([{ name, directory, port: Number(port) }]);
  });

  afterAll(async () => { await prisma?.$disconnect(); });

  it('two callers that both read Approved create one voucher and both receive the same result', async () => {
    const actorId = `${marker}-finance`;
    const requestId = `${marker}-request`;
    await db().userAccount.create({ data: { id: actorId, displayName: 'Synthetic finance acceptance actor', status: 'active' } });
    await db().paymentRequest.create({ data: {
      id: requestId,
      requestNumber: `${marker}-number`,
      supplierId: `${marker}-supplier`,
      supplierName: 'Synthetic supplier',
      requestDate: '2026-10-05',
      totalAmount: new Prisma.Decimal('1000.0000'),
      currency: 'CNY',
      applicantId: actorId,
      reviewerId: actorId,
      status: 'Approved',
      approvalRequestId: `${marker}-approval`,
      paymentCategory: 'normal',
      ownerId: actorId,
    } });

    let released!: () => void;
    let preflightReaders = 0;
    const bothReadApproved = new Promise<void>(resolve => { released = resolve; });
    const client = new Proxy(db(), { get(target, key) {
      if (key === 'paymentRequest') {
        const delegate = Reflect.get(target, key, target);
        return new Proxy(delegate, { get(model, method) {
          const value = Reflect.get(model, method, model);
          if (method === 'findUnique' && typeof value === 'function') return async (args: any) => {
            const row = await value.call(model, args);
            if (args?.where?.id === requestId && preflightReaders < 2) {
              preflightReaders += 1;
              if (preflightReaders === 2) released();
              await bothReadApproved;
            }
            return row;
          };
          return typeof value === 'function' ? value.bind(model) : value;
        } });
      }
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as PrismaClient;

    const service = createPaymentRequestService({ prisma: client });
    const results = await Promise.all([
      service.issueVoucherForApprovedRequest({ paymentRequestId: requestId, actorId }),
      service.issueVoucherForApprovedRequest({ paymentRequestId: requestId, actorId }),
    ]);

    expect(preflightReaders).toBe(2);
    expect(results.every(result => result.ok), JSON.stringify(results)).toBe(true);
    const successData = results.flatMap(result => result.ok ? [result.data] : []);
    expect(successData).toHaveLength(2);
    if (successData.length !== 2) return;
    expect(successData.map(result => result.idempotent).sort()).toEqual([false, true]);
    const voucherIds = new Set(successData.map(result => result.voucher.id));
    expect(voucherIds.size).toBe(1);

    const linkedRequest = await db().paymentRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(linkedRequest.status).toBe('VoucherIssued');
    expect(linkedRequest.paymentVoucherId).toBe([...voucherIds][0]);
    const matchingVouchers = await db().$queryRaw<Array<{ id: string; voucherNumber: string }>>`
      SELECT "id", "voucherNumber" FROM "PaymentVoucher"
      WHERE "attachments"->>'paymentRequestId' = ${requestId}
    `;
    expect(matchingVouchers).toHaveLength(1);
    expect(matchingVouchers[0].id).toBe(linkedRequest.paymentVoucherId);
    const createAudits = await db().auditLog.findMany({ where: { targetType: 'PaymentVoucher', targetId: linkedRequest.paymentVoucherId } });
    expect(createAudits).toHaveLength(1);
  });
});
