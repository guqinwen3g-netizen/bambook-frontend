import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { buildInvoiceIssueDraft, buildInvoiceIssueError, commitInvoiceIssue } from '../invoiceIssueFlow';
import { executeTool } from '../toolRuntime';
import { toolActorToken } from '../toolActorContext';
import type { ActorContext } from '../types';
import { lookupErrorCode } from '../../shared/errorCodes';
import { __clearTeamShareCacheForTests } from '../../teams/teamShareService';

// Storage-only controls execute the real authority, ceiling, L2, source-lock,
// dispatch and audit helpers. The transaction substitute models rollback; it
// does not prove PostgreSQL locking, isolation, rollback or concurrent replay.
const actor: ActorContext = { userId: 'issue-executor-current', roles: ['finance'], departmentIds: [],
  permissionScopes: ['invoices:write', 'orders:read', 'emails:write'], permissionsAuthoritative: true,
  permissionCeiling: ['invoices:write', 'orders:read', 'emails:write'], memoryScopes: [],
  knowledgeScopes: ['company'], toolScopes: ['finance'] };
function fixture(orderId: string | null = null, withEmail = false, amount = 12.3456) {
  const state = { shared: true, stagedInvoices: [] as any[], stagedEmails: [] as any[], stagedAudits: [] as any[],
    invoices: [] as any[], emails: [] as any[], audits: [] as any[], rolledBack: false,
    otherAccounts: [] as any[], onReceiptClaim: null as (() => void) | null,
    allocations: [] as any[], onOrderLock: null as (() => void) | null,
    onInvoiceLock: null as (() => void) | null, afterInvoice: null as (() => void) | null };
  // A custom role carries the actual scopes without granting all-company L2
  // through a Finance/Admin label. Only the real team grant makes this Order visible.
  const account: any = { id: actor.userId, status: 'active', deletedAt: null, primaryDeptId: null,
    roles: [{ roleId: 'role-issue-scopes', departmentId: null, role: { id: 'role-issue-scopes',
      permissions: actor.permissionScopes.map(scope => ({ permission: { scope } })) } }] };
  const order = { id: 'order-source-current', customerRelationId: 'customer-shared', ownerId: 'other-owner',
    status: 'Pending', deletedAt: null, paymentInstrument: 'T/T' };
  const draft = buildInvoiceIssueDraft({ invoiceNumber: 'INV-ISSUE-CURRENT', amount, currency: 'USD',
    orderId: orderId ?? undefined, customerRelationId: 'customer-shared',
    ...(withEmail ? { email: { to: ['synthetic@example.invalid'], subject: '合成开票', bodyText: '仅测试 Outbox，不发送' } } : {}) });
  const approval = { id: 'approval-issue-current', requesterId: 'requester-original', actionType: 'tool:invoice.issue',
    status: 'approved', payload: { processDraft: draft, actor: { userId: 'payload-owner', permissions: ['*'] } } };
  const receipts = new Map<string, any>();
  const db: any = {
    userAccount: {
      findUnique: vi.fn(async ({ where }: any) => [account, ...state.otherAccounts].find(row => row.id === where.id && row.deletedAt == null) ?? null),
      findFirst: vi.fn(async ({ where }: any) => [account, ...state.otherAccounts].find(row => row.id === where.id && row.deletedAt == null) ?? null),
    },
    userPermissionOverrides: { findMany: vi.fn(async () => []) },
    relation: { findMany: vi.fn(async () => []) },
    teamMember: { findMany: vi.fn(async () => [{ teamId: 'current-shared-team' }]) },
    teamDataGrant: { findMany: vi.fn(async () => state.shared ? [{ entityId: order.customerRelationId }] : []) },
    order: { findUnique: vi.fn(async ({ where }: any) => where.id === order.id && order.deletedAt == null ? order : null), findFirst: vi.fn(async ({ where }: any) => {
      if (where.id !== order.id || order.deletedAt != null) return null;
      const scopes = Array.isArray(where.AND) ? where.AND : [];
      return scopes.every((scope: any) => !scope.OR || scope.OR.some((branch: any) =>
        branch.customerRelationId?.in?.includes(order.customerRelationId))) ? order : null;
    }) },
    orderLine: { findMany: vi.fn(async () => []) }, releaseScope: { findMany: vi.fn(async () => []) },
    sample: { findMany: vi.fn(async () => []) }, orderShipmentBatch: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async (sql: any) => {
      const statement = sql.strings.join('');
      if (statement.includes('INSERT INTO "AgentCommitReceipt"')) {
        const [id, key, approvalId] = sql.values;
        const acquired = !receipts.has(key);
        if (acquired) receipts.set(key, { id, idempotencyKey: key, toolId: 'invoice.issue', approvalId, status: 'committing', result: null });
        state.onReceiptClaim?.(); return acquired ? [{ id }] : [];
      }
      if (statement.includes('FROM "AgentCommitReceipt"')) {
        const row = receipts.get(sql.values[0]); return row ? [{ id: row.id }] : [];
      }
      if (statement.includes('FROM "ApprovalRequest"')) return [{ id: approval.id }];
      if (statement.includes('FROM "Order"') && state.onOrderLock) state.onOrderLock();
      if (statement.includes('FROM "Invoice"')) {
        state.onInvoiceLock?.(); return state.invoices.filter(row => row.deletedAt == null).map(row => ({ id: row.id }));
      }
      if (statement.includes('FROM "InvoiceOrderAllocation"')) return state.allocations.map(row => ({ id: row.id }));
      if (statement.includes('FROM "Email"')) return state.emails.map(row => ({ id: row.id }));
      return [{ id: order.id }];
    }),
    invoice: { findUnique: vi.fn(async ({ where }: any) => state.invoices.find(row => row.id === where.id) ?? null),
      create: vi.fn(async ({ data }: any) => { const row = { ...data }; state.stagedInvoices.push(row);
      state.afterInvoice?.(); return row; }) },
    invoiceOrderAllocation: { findMany: vi.fn(async () => state.allocations) },
    email: { findUnique: vi.fn(async ({ where }: any) => state.emails.find(row => row.id === where.id) ?? null),
      create: vi.fn(async ({ data }: any) => { const row = { ...data }; state.stagedEmails.push(row); return row; }) },
    entityReference: { upsert: vi.fn(async () => ({})) }, entityLink: { upsert: vi.fn(async () => ({})) },
    auditLog: { findUnique: vi.fn(async ({ where }: any) => state.audits.find(row => row.id === where.id) ?? null),
      create: vi.fn(async ({ data }: any) => { const row = JSON.parse(JSON.stringify(data)); state.stagedAudits.push(row); return row; }) },
    approvalRequest: { findUnique: vi.fn(async () => approval),
      create: vi.fn(() => { throw Error('original approval must not be recreated'); }),
      update: vi.fn(() => { throw Error('original approval must not be rewritten'); }) },
    agentCommitReceipt: {
      create: vi.fn(async ({ data }: any) => { if (receipts.has(data.idempotencyKey)) throw Object.assign(Error('unique receipt'), { code: 'P2002' });
        receipts.set(data.idempotencyKey, { ...data }); return data; }),
      findUnique: vi.fn(async ({ where }: any) => receipts.get(where.idempotencyKey) ?? null),
      update: vi.fn(async ({ where, data }: any) => { const row = { ...receipts.get(where.idempotencyKey), ...data,
        ...(data.result !== undefined ? { result: JSON.parse(JSON.stringify(data.result)) } : {}) }; receipts.set(where.idempotencyKey, row); return row; }),
      delete: vi.fn(async ({ where }: any) => { const row = receipts.get(where.idempotencyKey); receipts.delete(where.idempotencyKey); return row; }),
    },
  };
  // This queue models storage transaction serialization and complete rollback;
  // it is not evidence of PostgreSQL claim waiting or lock isolation.
  let transactionQueue = Promise.resolve();
  db.$transaction = vi.fn((work: any) => {
    const run = async () => {
    const originalReceipts = new Map([...receipts].map(([key, row]) => [key, JSON.parse(JSON.stringify(row))]));
    state.stagedInvoices = []; state.stagedEmails = []; state.stagedAudits = [];
    try { const result = await work(db); state.invoices.push(...state.stagedInvoices);
      state.emails.push(...state.stagedEmails); state.audits.push(...state.stagedAudits); return result;
    } catch (error) { state.rolledBack = true; state.stagedInvoices = []; state.stagedEmails = []; state.stagedAudits = [];
      receipts.clear(); for (const [key, row] of originalReceipts) receipts.set(key, row); throw error; }
    };
    const result = transactionQueue.then(run, run); transactionQueue = result.then(() => undefined, () => undefined); return result;
  });
  const direct = (trustedActor: any = toolActorToken(actor), scalar = actor.userId) => commitInvoiceIssue({ prisma: db,
    approvalId: approval.id, approvalPayload: approval.payload, actorId: scalar, trustedActor, requesterId: approval.requesterId });
  const run = (current: ActorContext | null = actor, input: any = {}) => executeTool(db,
    { toolId: 'invoice.issue', approvalId: approval.id, input }, current ? { actor: current, actorId: current.userId } : { actorId: actor.userId });
  return { db, state, account, order, approval, receipts, direct, run };
}
function refusedWithoutWrite(f: ReturnType<typeof fixture>) {
  expect(f.db.invoice.create).not.toHaveBeenCalled(); expect(f.db.email.create).not.toHaveBeenCalled();
  expect(f.db.auditLog.create).not.toHaveBeenCalled(); expect(f.state.invoices).toEqual([]);
  expect(f.state.emails).toEqual([]); expect(f.state.audits).toEqual([]);
  expect(f.db.approvalRequest.create).not.toHaveBeenCalled(); expect(f.db.approvalRequest.update).not.toHaveBeenCalled();
}
function code(result: any) { return result.errorFeedback?.code ?? result.feedback?.error?.code; }
// An independent recipe; tests never call the production digest helper.
function independentHash(value: any): string {
  const sorted = (v: any): any => typeof v === 'bigint' ? v.toString() : Prisma.Decimal.isDecimal(v) ? v.toString()
    : Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map(key => [key, sorted(v[key])])) : v;
  return createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');
}
beforeEach(() => { __clearTeamShareCacheForTests(); });

describe('invoice.issue actual current authority', () => {
  it('cannot use scalar actor, approved requester or payload identity without a trusted executor', async () => {
    const f = fixture(), result: any = await f.run(null, { actor: actor, actorId: actor.userId, permissionCeiling: ['*'] });
    expect(result.ok).toBe(false); expect(code(result)).toBe('UNAUTHORIZED'); refusedWithoutWrite(f);
    expect(f.db.agentCommitReceipt.create).not.toHaveBeenCalled();
  });
  it('direct flow refuses a mismatched scalar executor instead of auditing the requester', async () => {
    const f = fixture(), result = await f.direct(toolActorToken(actor), f.approval.requesterId);
    expect(result.ok).toBe(false); expect(code(result)).toBe('UNAUTHORIZED'); refusedWithoutWrite(f);
  });
  it('retains an explicitly empty credential ceiling despite current stored grants', async () => {
    const f = fixture(), result: any = await f.run({ ...actor, permissionCeiling: [] });
    expect(result.ok).toBe(false); expect(code(result)).toBe('FORBIDDEN'); refusedWithoutWrite(f);
  });
  it.each(['revoked', 'disabled', 'deleted'] as const)('refuses current %s executor without a business write', async mode => {
    const f = fixture();
    if (mode === 'revoked') f.account.roles[0].role.permissions = [];
    if (mode === 'disabled') f.account.status = 'disabled';
    if (mode === 'deleted') f.account.deletedAt = BigInt(Date.now());
    const result = await f.direct(); expect(result.ok).toBe(false);
    expect(code(result)).toBe(mode === 'revoked' ? 'FORBIDDEN' : 'UNAUTHORIZED'); refusedWithoutWrite(f);
  });
  it('missing current authority storage is a safe dependency failure, never a compatible bypass', async () => {
    const f = fixture(); delete f.db.userAccount;
    const result = await f.direct(); expect(result.ok).toBe(false); expect(code(result)).toBe('AUTHORIZATION_UNAVAILABLE'); refusedWithoutWrite(f);
    expect(JSON.stringify(result)).not.toContain('findUnique');
  });
  it('standalone native issue preserves Issued, Outbox and mandatory audit in the same transaction', async () => {
    const f = fixture(null, true), approvalBefore = JSON.stringify(f.approval), result = await f.direct();
    expect(result.ok).toBe(true); expect(f.state.invoices).toHaveLength(1); expect(f.state.emails).toHaveLength(1);
    expect(f.state.invoices[0]).toMatchObject({ status: 'Issued', amount: 12.3456, currency: 'USD' });
    expect(f.state.emails[0]).toMatchObject({ mailbox: 'Outbox', direction: 'outbound', sentAt: null, messageId: null });
    expect(f.state.audits[0]).toMatchObject({ actorId: actor.userId,
      detail: { after: { approvalId: f.approval.id, approvalRequesterId: f.approval.requesterId, executionActorId: actor.userId } } });
    expect(JSON.stringify(f.approval)).toBe(approvalBefore);
    const statements = f.db.$queryRaw.mock.calls.map(([sql]: any[]) => sql.strings.join(''));
    expect(statements.some((sql: string) => sql.includes('FROM "ApprovalRequest"') && sql.includes('FOR UPDATE'))).toBe(true);
    expect(statements.some((sql: string) => sql.includes('FROM "AgentCommitReceipt"') && sql.includes('FOR UPDATE'))).toBe(true);
    expect(statements.some((sql: string) => sql.includes('FROM "Order"'))).toBe(false);
    expect(f.db.order.findUnique).not.toHaveBeenCalled(); expect(f.db.order.findFirst).not.toHaveBeenCalled();
    expect(f.db.teamDataGrant.findMany).not.toHaveBeenCalled();
  });
  it('lawful whole-order issue locks the actual source and uses fresh shared-customer visibility without inventing a batch', async () => {
    const f = fixture('order-source-current'), result = await f.direct(); expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(f.db.$queryRaw).toHaveBeenCalled(); expect(f.db.orderShipmentBatch.findMany).not.toHaveBeenCalled();
    expect(f.state.invoices[0].orderId).toBe(f.order.id); expect(f.db.teamDataGrant.findMany).toHaveBeenCalled();
  });
  it('removed shared-customer grant cannot borrow a signed Finance label or approved draft to view the source', async () => {
    const f = fixture('order-source-current'); f.state.shared = false;
    const result = await f.direct(); expect(result.ok).toBe(false); expect(code(result)).toBe('ORDER_NOT_FOUND'); refusedWithoutWrite(f);
  });
  it.each(['grant', 'share'] as const)('rechecks %s withdrawn while acquiring the Order source lock', async withdrawal => {
    const f = fixture('order-source-current'); f.state.onOrderLock = () => {
      if (withdrawal === 'grant') f.account.roles[0].role.permissions = [];
      else f.state.shared = false;
    };
    const result = await f.direct(); expect(result.ok).toBe(false);
    expect(code(result)).toBe(withdrawal === 'grant' ? 'FORBIDDEN' : 'ORDER_NOT_FOUND'); refusedWithoutWrite(f);
  });
  it('source SQL failure is not converted into an absent source or leaked driver text', async () => {
    const f = fixture('order-source-current'); f.db.$queryRaw.mockRejectedValue(Error('SQL secret_relation /private/driver'));
    const result = await f.direct(); expect(result.ok).toBe(false); expect(code(result)).toBe('AUTHORIZATION_UNAVAILABLE'); refusedWithoutWrite(f);
    expect(JSON.stringify(result)).not.toContain('secret_relation'); expect(JSON.stringify(result)).not.toContain('/private/driver');
  });
  it('current grant is checked again before mandatory audit, rolling back a staged Invoice', async () => {
    const f = fixture(); f.state.afterInvoice = () => { f.account.roles[0].role.permissions = []; };
    const result = await f.direct(); expect(result.ok).toBe(false); expect(code(result)).toBe('FORBIDDEN');
    expect(f.db.invoice.create).toHaveBeenCalledTimes(1); expect(f.db.auditLog.create).not.toHaveBeenCalled();
    expect(f.state.rolledBack).toBe(true); expect(f.state.invoices).toEqual([]); expect(f.state.audits).toEqual([]);
  });
  it('mandatory audit failure cannot commit the Invoice or Outbox in the storage transaction', async () => {
    const f = fixture(null, true); f.db.auditLog.create.mockRejectedValue(Error('audit storage unavailable'));
    const result = await f.direct(); expect(result.ok).toBe(false); expect(code(result)).toBe('COMMIT_TRANSACTION_FAILED');
    expect(f.state.rolledBack).toBe(true); expect(f.state.invoices).toEqual([]); expect(f.state.emails).toEqual([]); expect(f.state.audits).toEqual([]);
  });
  it('unknown Invoice, reference or audit faults retain the original transaction code without exposing driver text', async () => {
    const secret = 'SQLSTATE P2003 /private/driver/customer_ledger';
    for (const delegate of ['invoice', 'entityReference', 'auditLog'] as const) {
      const f = fixture(null, true);
      const operation = delegate === 'entityReference' ? 'upsert' : 'create';
      f.db[delegate][operation].mockRejectedValue(Error(secret));
      const result = await f.direct(); expect(result.ok).toBe(false); expect(code(result)).toBe('COMMIT_TRANSACTION_FAILED');
      expect(JSON.stringify(result)).not.toContain(secret); expect(JSON.stringify(result)).not.toContain('/private/driver');
      expect(f.state.invoices).toEqual([]); expect(f.state.emails).toEqual([]); expect(f.state.audits).toEqual([]);
    }
  });
  it('registered commit carries the actual executor and preserves original requester provenance', async () => {
    const f = fixture(), result: any = await f.run(); expect(result.ok).toBe(true);
    expect(f.state.audits[0].actorId).toBe(actor.userId);
    expect(f.state.audits[0].detail.after.approvalRequesterId).toBe(f.approval.requesterId);
    expect([...f.receipts.values()][0]).toMatchObject({ status: 'committed', approvalId: f.approval.id });
  });
  it('still-authorized receipt replay returns the original result without another Invoice, Outbox or audit', async () => {
    const f = fixture(), first: any = await f.run(); expect(first.ok).toBe(true); vi.clearAllMocks();
    const replay: any = await f.run(); expect(replay).toMatchObject({ ...first, replayed: true });
    expect(f.db.invoice.create).not.toHaveBeenCalled(); expect(f.db.email.create).not.toHaveBeenCalled();
    expect(f.db.auditLog.create).not.toHaveBeenCalled(); expect(f.state.invoices).toHaveLength(1);
  });
  it('shared Order receipt replay cannot expose its original result after current source sharing is withdrawn', async () => {
    const f = fixture('order-source-current'); expect((await f.run() as any).ok).toBe(true);
    f.state.shared = false; vi.clearAllMocks();
    const result: any = await f.run(); expect(result.ok).toBe(false); expect(code(result)).toBe('ORDER_NOT_FOUND');
    expect(result).not.toHaveProperty('replayed'); expect(f.db.invoice.create).not.toHaveBeenCalled();
    expect(f.db.agentCommitReceipt.update).not.toHaveBeenCalled(); expect(f.db.agentCommitReceipt.delete).not.toHaveBeenCalled();
  });
  it('shared Order replay checks visibility again after the actual Invoice lock', async () => {
    const f = fixture('order-source-current'); expect((await f.run() as any).ok).toBe(true);
    f.state.onInvoiceLock = () => { f.state.shared = false; }; vi.clearAllMocks();
    const result: any = await f.run(); expect(result.ok).toBe(false); expect(code(result)).toBe('ORDER_NOT_FOUND');
    expect(result).not.toHaveProperty('replayed'); expect(f.db.invoice.create).not.toHaveBeenCalled();
    expect(f.db.agentCommitReceipt.delete).not.toHaveBeenCalled();
  });
  it.each(['orderId', 'customerRelationId', 'currency', 'amount', 'deleted', 'missing', 'allocation-parent'] as const)(
    'refuses cached issue result when the actual Invoice has %s source drift without replacing its receipt', async field => {
      const f = fixture('order-source-current'); expect((await f.run() as any).ok).toBe(true);
      if (field === 'deleted') f.state.invoices[0].deletedAt = BigInt(Date.now());
      else if (field === 'missing') f.state.invoices = [];
      else if (field === 'allocation-parent') f.state.allocations = [{ id: 'IOA-foreign', invoiceId: f.state.invoices[0].id,
        orderId: 'order-foreign', batchId: null, allocatedAmount: '12.3456', deletedAt: null }];
      else f.state.invoices[0][field] = field === 'amount' ? '12.3457' : 'changed-source';
      vi.clearAllMocks(); const result: any = await f.run(); expect(result.ok).toBe(false);
      expect(code(result)).toBe(field === 'missing' || field === 'deleted' ? 'NOT_FOUND' : 'CONFLICT');
      expect(result).not.toHaveProperty('replayed'); expect(f.db.invoice.create).not.toHaveBeenCalled();
      expect(f.db.auditLog.create).not.toHaveBeenCalled(); expect(f.db.agentCommitReceipt.update).not.toHaveBeenCalled();
      expect(f.db.agentCommitReceipt.delete).not.toHaveBeenCalled();
    });
  it.each(['Paid', 'Cancelled'] as const)('returns the unchanged historical issue ACK for a same-source %s Invoice', async status => {
    const f = fixture('order-source-current'), first: any = await f.run(); expect(first.ok).toBe(true);
    f.state.invoices[0].status = status; f.state.invoices[0].notes = 'later lawful note'; vi.clearAllMocks();
    const replay: any = await f.run(); expect(replay).toMatchObject({ ...first, replayed: true });
    expect(f.state.invoices[0].status).toBe(status); expect(f.db.invoice.create).not.toHaveBeenCalled();
    expect(f.db.invoice.findUnique).toHaveBeenCalled(); expect(f.db.auditLog.create).not.toHaveBeenCalled();
  });
  it('receipt replay uses exact Decimal equality rather than truncating a changed money fact', async () => {
    // Both values fit Decimal(18,4), but Number would collapse their difference.
    const f = fixture('order-source-current', false, 9_999_999_999_999.125); expect((await f.run() as any).ok).toBe(true);
    f.state.invoices[0].amount = '9999999999999.1251'; vi.clearAllMocks();
    const result: any = await f.run(); expect(result.ok).toBe(false); expect(code(result)).toBe('CONFLICT');
    expect(result).not.toHaveProperty('replayed'); expect(f.db.agentCommitReceipt.delete).not.toHaveBeenCalled();
  });
  it('receipt replay source storage fault remains unknown and never leaks SQL or removes the original fact', async () => {
    const f = fixture('order-source-current'); expect((await f.run() as any).ok).toBe(true);
    f.db.invoice.findUnique.mockRejectedValue(Error('SQL secret_receipt /private/driver')); vi.clearAllMocks();
    const result: any = await f.run(); expect(result.ok).toBe(false); expect(code(result)).toBe('AUTHORIZATION_UNAVAILABLE');
    expect(JSON.stringify(result)).not.toContain('secret_receipt'); expect(JSON.stringify(result)).not.toContain('/private/driver');
    expect(f.db.invoice.create).not.toHaveBeenCalled(); expect(f.db.agentCommitReceipt.delete).not.toHaveBeenCalled();
  });
  it('revoked current authority cannot expose an old committed receipt', async () => {
    const f = fixture(); expect((await f.run() as any).ok).toBe(true); f.account.roles[0].role.permissions = []; vi.clearAllMocks();
    const result: any = await f.run(); expect(result.ok).toBe(false); expect(code(result)).toBe('FORBIDDEN');
    expect(result).not.toHaveProperty('replayed'); expect(f.db.invoice.create).not.toHaveBeenCalled();
    expect(f.db.agentCommitReceipt.create).not.toHaveBeenCalled(); expect(f.db.agentCommitReceipt.update).not.toHaveBeenCalled();
  });
  it('receipt collision rechecks a just-revoked current grant before returning cached success', async () => {
    const f = fixture(); expect((await f.run() as any).ok).toBe(true); vi.clearAllMocks();
    f.state.onReceiptClaim = () => { f.account.roles[0].role.permissions = []; };
    const result: any = await f.run(); expect(result.ok).toBe(false); expect(code(result)).toBe('FORBIDDEN');
    expect(result).not.toHaveProperty('replayed'); expect(f.db.invoice.create).not.toHaveBeenCalled();
  });
  it('receipt write failure rolls back Invoice, Outbox, mandatory audit and its new claim together', async () => {
    const f = fixture(null, true); f.db.agentCommitReceipt.update.mockRejectedValue(Error('receipt SQL /private/internal'));
    const result = await f.direct(); expect(result.ok).toBe(false); expect(code(result)).toBe('COMMIT_TRANSACTION_FAILED');
    expect(f.db.invoice.create).toHaveBeenCalledTimes(1); expect(f.db.email.create).toHaveBeenCalledTimes(1);
    expect(f.db.auditLog.create).toHaveBeenCalledTimes(1); expect(f.state.rolledBack).toBe(true);
    expect(f.state.invoices).toEqual([]); expect(f.state.emails).toEqual([]); expect(f.state.audits).toEqual([]);
    expect(f.receipts.size).toBe(0); expect(JSON.stringify(result)).not.toContain('/private/internal');
  });
  it('one failed claim can retry the exact original request without a stuck technical receipt or duplicate business facts', async () => {
    const f = fixture(null, true); f.db.agentCommitReceipt.update.mockRejectedValueOnce(Error('receipt failure'));
    expect((await f.run() as any).ok).toBe(false); expect(f.receipts.size).toBe(0);
    const retry: any = await f.run(); expect(retry.ok).toBe(true); expect(f.state.invoices).toHaveLength(1);
    expect(f.state.emails).toHaveLength(1); expect(f.state.audits).toHaveLength(1); expect(f.receipts.size).toBe(1);
  });
  it('a stored Decimal differing from the approved amount cannot commit a successful receipt before replay', async () => {
    const f = fixture(null, true, 12.34567);
    // Storage-shaped quantization, not a claim that this mock proves the real
    // Decimal column's precision or PostgreSQL rollback.
    f.db.invoice.create.mockImplementation(async ({ data }: any) => {
      const row = { ...data, amount: new Prisma.Decimal(data.amount).toDecimalPlaces(4) };
      f.state.stagedInvoices.push(row); return row;
    });
    const result: any = await f.run(); expect(result.ok).toBe(false); expect(code(result)).toBe('CONFLICT');
    expect(f.state.rolledBack).toBe(true); expect(f.state.invoices).toEqual([]); expect(f.state.emails).toEqual([]);
    expect(f.state.audits).toEqual([]); expect(f.receipts.size).toBe(0);
    expect(f.db.agentCommitReceipt.update).not.toHaveBeenCalled();
  });
  it('legacy committing without immutable proof remains unknown and cannot create another Invoice', async () => {
    const f = fixture(), key = `commit:invoice.issue:${f.approval.id}`;
    f.receipts.set(key, { id: 'old-unknown', idempotencyKey: key, toolId: 'invoice.issue', approvalId: f.approval.id,
      status: 'committing', result: null });
    const before = JSON.stringify([...f.receipts.values()]), result: any = await f.run();
    expect(result.ok).toBe(false); expect(code(result)).toBe('COMMIT_REPLAY_BLOCKED'); refusedWithoutWrite(f);
    expect(JSON.stringify([...f.receipts.values()])).toBe(before); expect(f.db.agentCommitReceipt.update).not.toHaveBeenCalled();
    expect(f.db.agentCommitReceipt.delete).not.toHaveBeenCalled();
  });
  it('legacy committed reads preserve their old ACK and cannot be relabelled as a version-one audit', async () => {
    const f = fixture(), first: any = await f.run(); expect(first.ok).toBe(true);
    const row = [...f.receipts.values()][0]; row.result = { ...row.result.acknowledgement };
    const before = JSON.stringify(row); vi.clearAllMocks(); const replay: any = await f.run();
    expect(replay).toMatchObject({ ...first, replayed: true }); expect(JSON.stringify([...f.receipts.values()][0])).toBe(before);
    expect(f.db.agentCommitReceipt.update).not.toHaveBeenCalled(); expect(f.db.auditLog.create).not.toHaveBeenCalled();
    expect([...f.receipts.values()][0].result).not.toHaveProperty('schemaVersion');
  });
  it.each(['missing', 'actor', 'source', 'target', 'command', 'outbox-reference'] as const)(
    'version-one replay refuses actual mandatory audit %s damage even if its cached hashes remain internally consistent', async damage => {
      const f = fixture(null, true); expect((await f.run() as any).ok).toBe(true);
      if (damage === 'missing') f.state.audits = [];
      else if (damage === 'actor') f.state.audits[0].actorId = f.approval.requesterId;
      else if (damage === 'source') f.state.audits[0].detail.source = 'other:source';
      else if (damage === 'target') f.state.audits[0].targetId = 'foreign-invoice';
      else if (damage === 'command') f.state.audits[0].detail.after.commandSnapshot.source.amount = '12.3457';
      else f.state.audits[0].detail.after.outboxEmailId = 'foreign-email';
      const original = JSON.stringify([...f.receipts.values()]); vi.clearAllMocks(); const result: any = await f.run();
      expect(result.ok).toBe(false); expect(code(result)).toBe('CONFLICT'); expect(result).not.toHaveProperty('replayed');
      expect(f.db.invoice.create).not.toHaveBeenCalled(); expect(f.db.email.create).not.toHaveBeenCalled();
      expect(f.db.agentCommitReceipt.update).not.toHaveBeenCalled(); expect(JSON.stringify([...f.receipts.values()])).toBe(original);
    });
  it.each(['missing', 'body', 'recipient', 'invoice-parent'] as const)(
    'version-one replay consumes the real Outbox and refuses its %s damage', async damage => {
      const f = fixture(null, true); expect((await f.run() as any).ok).toBe(true);
      if (damage === 'missing') f.state.emails = [];
      else if (damage === 'body') f.state.emails[0].bodyText = 'changed actual body';
      else if (damage === 'recipient') f.state.emails[0].toAddresses = '["foreign@example.invalid"]';
      else f.state.emails[0].relationId = 'foreign-customer';
      vi.clearAllMocks(); const result: any = await f.run(); expect(result.ok).toBe(false); expect(code(result)).toBe('CONFLICT');
      expect(result).not.toHaveProperty('replayed'); expect(f.db.invoice.create).not.toHaveBeenCalled();
      expect(f.db.agentCommitReceipt.delete).not.toHaveBeenCalled();
    });
  it('recomputing a corrupted cached ACK hash cannot replace its real immutable audit core', async () => {
    const f = fixture(); expect((await f.run() as any).ok).toBe(true);
    const envelope = [...f.receipts.values()][0].result; envelope.acknowledgement.transactionId = 'forged-transaction';
    envelope.ackHash = independentHash(envelope.acknowledgement); vi.clearAllMocks();
    const result: any = await f.run(); expect(result.ok).toBe(false); expect(code(result)).toBe('CONFLICT');
    expect(result).not.toHaveProperty('replayed'); expect(f.db.invoice.create).not.toHaveBeenCalled();
  });
  it('another genuinely authorized operator cannot silently become the original executor or acquire a second issue', async () => {
    const f = fixture('order-source-current'); expect((await f.run() as any).ok).toBe(true);
    const other = { ...actor, userId: 'other-current-executor' };
    f.state.otherAccounts.push({ ...f.account, id: other.userId }); vi.clearAllMocks();
    const result: any = await f.run(other, { actorId: actor.userId, requesterId: actor.userId });
    expect(result.ok).toBe(false); expect(code(result)).toBe('CONFLICT'); expect(result).not.toHaveProperty('replayed');
    expect(f.db.invoice.create).not.toHaveBeenCalled(); expect(f.db.agentCommitReceipt.update).not.toHaveBeenCalled();
  });
  it('same approval with changed complete draft/source never creates a second issue even when its new hash is valid', async () => {
    const f = fixture(); expect((await f.run() as any).ok).toBe(true);
    f.approval.payload.processDraft = buildInvoiceIssueDraft({ invoiceNumber: 'INV-ISSUE-CHANGED', amount: 13, currency: 'USD' });
    vi.clearAllMocks(); const result: any = await f.run(); expect(result.ok).toBe(false); expect(code(result)).toBe('CONFLICT');
    expect(f.db.invoice.create).not.toHaveBeenCalled(); expect(f.state.invoices).toHaveLength(1); expect(f.receipts.size).toBe(1);
  });
  it('storage claim serialization permits exactly one business result for simultaneous equal approved requests', async () => {
    const f = fixture(null, true); const results: any[] = await Promise.all([f.run(), f.run()]);
    expect(results.every(result => result.ok)).toBe(true); expect(results.filter(result => result.replayed)).toHaveLength(1);
    expect(f.state.invoices).toHaveLength(1); expect(f.state.emails).toHaveLength(1); expect(f.state.audits).toHaveLength(1);
    expect(f.receipts.size).toBe(1); expect(f.db.invoice.create).toHaveBeenCalledTimes(1);
  });
  it('version-one command and ACK use independently verifiable SHA with native Decimal/BigInt exact despite global toJSON overrides', async () => {
    const previousDecimal = Prisma.Decimal.prototype.toJSON, previousBigInt = Object.getOwnPropertyDescriptor(BigInt.prototype, 'toJSON');
    try {
      Prisma.Decimal.prototype.toJSON = function () { return Number(this.toString()); } as any;
      Object.defineProperty(BigInt.prototype, 'toJSON', { configurable: true, value: function () { return Number(this); } });
      const f = fixture(null, false, 9_999_999_999_999.125);
      f.db.invoice.create.mockImplementation(async ({ data }: any) => { const row = { ...data, amount: new Prisma.Decimal(data.amount) };
        f.state.stagedInvoices.push(row); return row; });
      const result: any = await f.run(); expect(result.ok).toBe(true); const value = [...f.receipts.values()][0].result;
      expect(value.facts.invoice.amount).toBe('9999999999999.125'); expect(typeof value.facts.invoice.createdAt).toBe('string');
      expect(value.command.source.amount).toBe('9999999999999.125');
      expect(value.commandHash).toBe(independentHash({ schemaVersion: 1, command: value.command }));
      expect(value.ackHash).toBe(independentHash(value.acknowledgement));
      const replay: any = await f.run(); expect(replay).toMatchObject({ ...result, replayed: true });
    } finally {
      Prisma.Decimal.prototype.toJSON = previousDecimal;
      if (previousBigInt) Object.defineProperty(BigInt.prototype, 'toJSON', previousBigInt); else delete (BigInt.prototype as any).toJSON;
    }
  });
  it('each new public access error has a registered status and actionable user copy', () => {
    const statuses = { UNAUTHORIZED: 401, ACCOUNT_DISABLED: 401, FORBIDDEN: 403, AUTHORIZATION_UNAVAILABLE: 503,
      ORDER_NOT_FOUND: 404, NOT_FOUND: 404, CONFLICT: 409 } as const;
    for (const [value, status] of Object.entries(statuses)) {
      expect(lookupErrorCode(value)?.status).toBe(status);
      expect(buildInvoiceIssueError(value as keyof typeof statuses, '受控业务拒绝').userAction.length).toBeGreaterThan(0);
    }
  });
});
