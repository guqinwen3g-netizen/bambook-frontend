/**
 * Opt-in EXC storage/transaction acceptance; never run against a shared DB.
 * Independent basis: 审批与human-in-the-loop.md §15.3 DR013-B2/B5 and
 * §15.4 DR013-C6/C7: exact object/action/deadline, bounded reuse, and consumption
 * + audit in the business transaction. No company bypass policy is invented.
 *
 * Evidence: real service, actual PG row locks/CAS/FKs/rollback/audits. Approved
 * rows below are minimal synthetic committed-fact fixtures, NOT proof of a
 * lawful company approval, HTTP/JWT, actual Shipped business action, or UAT.
 * Expiration-fault probe injects ONLY a failed audit sink within real PG tx;
 * all rows/queries/rollback remain actual PG. No model/MCP/external action runs.
 */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createExceptionService } from '../src/exceptions/exceptionService';

const prefix = `acceptance-exception-consume-${randomUUID()}`;
const consumerId = `${prefix}-consumer`, reviewerId = `${prefix}-reviewer`;
let prisma: PrismaClient | undefined;
let sequence = 0;
const db = () => { if (!prisma) throw Error('Isolated EXC client not initialized'); return prisma; };
const service = (client: PrismaClient = db()) => createExceptionService({ prisma: client, approvalCreateService: {} as any });

beforeAll(async () => {
  const { DATABASE_URL, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name,
    BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!DATABASE_URL || !sandbox || !name || !directory || !port) throw Error('Reviewed independent acceptance sandbox is required');
  const url = new URL(DATABASE_URL);
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/);
  expect(url.protocol).toBe('postgresql:'); expect(['127.0.0.1', 'localhost']).toContain(url.hostname);
  expect(url.pathname).toBe(`/${name}`); expect(url.port).toBe(port);
  expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/);
  expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres'));
  expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const identity = await db().$queryRaw<Array<{ name: string; directory: string; port: number }>>`
    SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port
  `;
  expect(identity, 'independent PG identity before ANY fixture mutation').toEqual([{ name, directory, port: Number(port) }]);
  await db().userAccount.createMany({ data: [{ id: consumerId, displayName: 'Synthetic EXC consumer', status: 'active' }, { id: reviewerId, displayName: 'Synthetic EXC committed reviewer', status: 'active' }] });
});
afterAll(async () => { await prisma?.$disconnect(); });

async function fixture(label: string, scopePatch: Record<string, unknown> = {}, status = 'ReviewerApproved') {
  const id = `${prefix}-${++sequence}-${label}`, targetId = `${id}-target`, approvalId = `${id}-approval`;
  const scope: any = { targetType: 'Shipment', targetId, action: 'shipment:release', responsibleOwnerId: consumerId,
    validUntil: new Date(Date.now() + 60_000).toISOString(), maxUses: 1, usedCount: 0, consumptions: [], ...scopePatch };
  await db().$transaction(async tx => {
    await tx.approvalRequest.create({ data: { id: approvalId, requesterId: consumerId, reviewerId, status: 'approved', actionType: 'order:dr013-exception', targetType: 'Dr013ExceptionRequest', targetId: id, risk: 'high', payload: { syntheticCommittedFactFixture: true }, decidedAt: new Date() } });
    await tx.dr013ExceptionRequest.create({ data: { id, exceptionNumber: id, exceptionCategory: 'shipment_release', bypassedApprovalIds: [], exceptionReason: 'Synthetic isolated transaction fixture; not company approval policy.', riskMitigationPlan: 'Synthetic boundary probe only', requesterId: consumerId, reviewerId, approvalRequestId: approvalId, status,
      attachments: { files: ['synthetic-evidence'], extra: 'preserve-history', scope } } });
  });
  return { id, targetId, approvalId, input: { exceptionId: id, targetType: 'Shipment', targetId, action: 'shipment:release', consumedBy: consumerId } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function snapshot(item: Fixture) {
  return { row: await db().dr013ExceptionRequest.findUniqueOrThrow({ where: { id: item.id } }),
    approval: await db().approvalRequest.findUniqueOrThrow({ where: { id: item.approvalId } }),
    audits: await db().auditLog.findMany({ where: { targetType: 'Dr013ExceptionRequest', targetId: item.id }, orderBy: { id: 'asc' } }) };
}
function errorCode(result: any) { return result.ok ? 'OK' : result.error.code; }
function interceptClient(options: { failAudit?: boolean; afterInitialRead?: () => void }): PrismaClient {
  const client = db();
  return new Proxy(client, { get(target, property) {
    if (property === 'dr013ExceptionRequest' && options.afterInitialRead) return new Proxy(target.dr013ExceptionRequest, { get(model, method) {
      if (method === 'findUnique') return async (...args: any[]) => { const row = await (model.findUnique as any)(...args); options.afterInitialRead!(); return row; };
      return Reflect.get(model, method);
    } });
    if (property === '$transaction' && options.failAudit) return (work: any, config?: any) => target.$transaction(async tx => work(new Proxy(tx, { get(transaction, key) {
      if (key === 'auditLog') return { create: async () => { throw Error('Injected EXC expiration audit sink unavailable'); } };
      const value = Reflect.get(transaction, key); return typeof value === 'function' ? value.bind(transaction) : value;
    } })), config);
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
}

describe.sequential('EXC real PG consumption boundary', () => {
  it('bounded window reuse spends exactly maxUses and preserves original approval/evidence', async () => {
    const item = await fixture('bounded', { maxUses: 2 }); const before = await snapshot(item);
    expect(errorCode(await service().consumeException(item.input))).toBe('OK');
    expect((await snapshot(item)).row.status).toBe('ReviewerApproved');
    expect(errorCode(await service().consumeException(item.input))).toBe('OK');
    expect(errorCode(await service().consumeException(item.input))).toBe('EXCEPTION_ALREADY_CONSUMED');
    const after = await snapshot(item);
    expect(after.row.status).toBe('Consumed'); expect(after.row.attachments).toMatchObject({ files: ['synthetic-evidence'], extra: 'preserve-history', scope: { usedCount: 2, maxUses: 2, consumptions: [expect.objectContaining({ consumedBy: consumerId }), expect.objectContaining({ consumedBy: consumerId })] } });
    expect(after.audits).toHaveLength(2); for (const audit of after.audits) expect(audit).toMatchObject({ actorId: consumerId, action: 'dr013_exception_consumed' }); expect(after.approval).toEqual(before.approval);
  });
  it('two real concurrent PG consumers cannot spend a one-use quota twice', async () => {
    const item = await fixture('concurrent');
    const result = await Promise.all([service().consumeException(item.input), service().consumeException(item.input)]);
    expect(result.map(errorCode).sort()).toEqual(['EXCEPTION_ALREADY_CONSUMED', 'OK']);
    const after = await snapshot(item); expect(after.row.status).toBe('Consumed'); expect((after.row.attachments as any).scope.usedCount).toBe(1); expect((after.row.attachments as any).scope.consumptions).toHaveLength(1); expect(after.audits).toHaveLength(1);
  });
  it('actual audit FK failure rolls status/quota back; a valid actor retry succeeds once', async () => {
    const item = await fixture('audit-fk'); const before = await snapshot(item);
    expect(errorCode(await service().consumeException({ ...item.input, consumedBy: `${prefix}-missing-audit-actor` }))).toBe('EXCEPTION_CONSUME_FAILED');
    expect(await snapshot(item)).toEqual(before);
    expect(errorCode(await service().consumeException(item.input))).toBe('OK'); expect((await snapshot(item)).audits).toHaveLength(1);
  });
  it('passed deadline still denies when expiration audit fails inside actual PG transaction', async () => {
    const item = await fixture('expired-fault', { validUntil: new Date(Date.now() - 1_000).toISOString() }); const before = await snapshot(item);
    const withFault = service(interceptClient({ failAudit: true }));
    expect(await withFault.hasActiveException(item.input)).toEqual({ active: false, reason: 'EXCEPTION_EXPIRED' });
    expect(errorCode(await withFault.consumeException(item.input))).toBe('EXCEPTION_EXPIRED'); expect(await snapshot(item)).toEqual(before);
  });
  it.each([{ maxUses: 0 }, { usedCount: -1 }, { validUntil: 'invalid' }, { consumptions: {} }])('corrupt stored range %j opens no gate and consumes nothing', async patch => {
    const item = await fixture('invalid-range', patch); const before = await snapshot(item);
    expect((await service().hasActiveException(item.input)).active).toBe(false); expect(errorCode(await service().consumeException(item.input))).toBe('EXCEPTION_SCOPE_INVALID'); expect(await snapshot(item)).toEqual(before);
  });
  it('different target/action rejects without changing approved history or quota', async () => {
    const item = await fixture('wrong-target'); const before = await snapshot(item);
    for (const patch of [{ targetId: 'other-target' }, { action: 'shipment:book' }]) expect(errorCode(await service().consumeException({ ...item.input, ...patch }))).toBe('EXCEPTION_NOT_FOR_THIS_ENTITY');
    expect(await snapshot(item)).toEqual(before);
  });
  it('scope changed while consumer waits on row lock is re-read and denied', async () => {
    const item = await fixture('wait-recheck'); let releaseInitial!: () => void; const initialRead = new Promise<void>(resolve => { releaseInitial = resolve; }); let pending!: ReturnType<ReturnType<typeof service>['consumeException']>;
    const checkedService = service(interceptClient({ afterInitialRead: releaseInitial }));
    await db().$transaction(async holder => {
      await holder.$queryRaw`SELECT "id" FROM "Dr013ExceptionRequest" WHERE "id" = ${item.id} FOR UPDATE`;
      pending = checkedService.consumeException(item.input); await initialRead;
      const row = await holder.dr013ExceptionRequest.findUniqueOrThrow({ where: { id: item.id } }); const attachments: any = row.attachments;
      await holder.dr013ExceptionRequest.update({ where: { id: item.id }, data: { attachments: { ...attachments, scope: { ...attachments.scope, action: 'shipment:book' } } } });
    });
    expect(errorCode(await pending)).toBe('EXCEPTION_NOT_FOR_THIS_ENTITY'); const after = await snapshot(item); expect((after.row.attachments as any).scope.usedCount).toBe(0); expect(after.audits).toEqual([]);
  });
  it('external caller transaction failure rolls consumption and audit back together', async () => {
    const item = await fixture('outer-rollback'); const before = await snapshot(item);
    await expect(db().$transaction(async tx => {
      const result = await service().consumeException({ ...item.input, tx }); if (!result.ok) throw Error(result.error.code);
      throw Error('Injected downstream business failure after consumption');
    })).rejects.toThrow('Injected downstream business failure');
    expect(await snapshot(item)).toEqual(before);
    await db().$transaction(async tx => { const result = await service().consumeException({ ...item.input, tx }); if (!result.ok) throw Error(result.error.code); }); expect((await snapshot(item)).audits).toHaveLength(1);
  });
});
