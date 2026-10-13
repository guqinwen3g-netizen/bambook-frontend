import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '../types';

// The canonical producer is a boundary spy for identity propagation. Actual
// permission/account storage and approval/receipt dispatch run unmocked here.
// Native finance/storage tests qualify monetary writes and PostgreSQL locks.
const routing = vi.hoisted(() => ({ fallback: new Set<string>() }));
vi.mock('../toolDispatchRegistry', async importOriginal => {
  const real = await importOriginal<typeof import('../toolDispatchRegistry')>();
  return { ...real, dispatchFromRegistry: vi.fn((prisma, call, context) => routing.fallback.has(call.toolId)
    ? Promise.resolve({ hit: false }) : real.dispatchFromRegistry(prisma, call, context)) };
});
vi.mock('../../finance/invoiceMutationService', () => ({
  createInvoice: vi.fn(), updateInvoice: vi.fn(),
  INVOICE_CREATE_FIELDS: ['invoiceNumber', 'type', 'status', 'amount', 'currency', 'issueDate', 'notes', 'orderAllocations'],
  INVOICE_PATCH_FIELDS: ['status', 'amount', 'notes', 'orderAllocations'],
}));
vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
import { executeTool } from '../toolRuntime';
import { getToolHandler } from '../toolDispatchRegistry';
import { buildInvoiceCreateDraft, buildInvoiceUpdateDraft, commitInvoiceCreate, commitInvoiceUpdate } from '../invoiceMutationFlow';
import { toolActorToken } from '../toolActorContext';
import { createInvoice, updateInvoice } from '../../finance/invoiceMutationService';

const actor: ActorContext = { userId: 'operator-current', roles: ['admin'], departmentIds: [], permissionScopes: ['invoices:write'],
  permissionsAuthoritative: true, permissionCeiling: ['invoices:write'], memoryScopes: [], knowledgeScopes: ['company'], toolScopes: ['finance'] };
const invoiceInput = { invoiceNumber: 'INV-NATIVE', type: 'Receivable', amount: '12.3456', currency: 'USD', issueDate: '2026-10-02',
  orderAllocations: [{ orderId: 'order-actual', batchId: 'osb-actual', allocatedAmount: '12.3456' }] };
function fixture(toolId = 'invoice.create') {
  const draft = toolId === 'invoice.update' ? buildInvoiceUpdateDraft({ invoiceId: 'invoice-original', patch: { status: 'Issued' }, currentSnapshot: { status: 'Draft' } })
    : buildInvoiceCreateDraft({ input: invoiceInput });
  const approval: any = { id: 'approval-original', actionType: `tool:${toolId}`, status: 'approved', requesterId: 'requester-original',
    reviewerId: 'reviewer-original', decision: 'approved', payload: { processDraft: draft, actor: { userId: 'body-impostor', permissionCeiling: ['*'] } } };
  const account: any = { id: actor.userId, status: 'active', deletedAt: null, primaryDeptId: null,
    roles: [{ roleId: 'role-admin', departmentId: null, role: { id: 'role-admin', permissions: [{ permission: { scope: 'invoices:write' } }] } }] };
  const receipts = new Map<string, any>();
  const prisma: any = {
    userAccount: { findUnique: vi.fn(async ({ where }: any) => where.id === account.id && account.deletedAt == null ? account : null) },
    userPermissionOverrides: { findMany: vi.fn(async () => []) },
    approvalRequest: { findUnique: vi.fn(async ({ where }: any) => where.id === approval.id ? approval : null),
      create: vi.fn(() => { throw Error('existing approval must not be recreated'); }),
      update: vi.fn(() => { throw Error('existing approval history must not be rewritten'); }),
      delete: vi.fn(() => { throw Error('existing approval history must not be erased'); }) },
    agentCommitReceipt: {
      create: vi.fn(async ({ data }: any) => { if (receipts.has(data.idempotencyKey)) throw Object.assign(Error('receipt unique'), { code: 'P2002' });
        receipts.set(data.idempotencyKey, { ...data }); return { ...data }; }),
      findUnique: vi.fn(async ({ where }: any) => receipts.get(where.idempotencyKey) ?? null),
      update: vi.fn(async ({ where, data }: any) => { const row = receipts.get(where.idempotencyKey); if (!row) throw Error('missing receipt'); Object.assign(row, data); return { ...row }; }),
      delete: vi.fn(async ({ where }: any) => { const row = receipts.get(where.idempotencyKey); receipts.delete(where.idempotencyKey); return row; }),
    },
  };
  const call: any = { toolId, approvalId: approval.id, input: toolId === 'finance.create_invoice' ? { ...invoiceInput } : {} };
  const run = (trustedActor: ActorContext | null = actor, input: any = call.input) => executeTool(prisma, { ...call, input },
    trustedActor ? { actorId: 'scalar-actor-is-not-authority', actor: trustedActor } : { actorId: actor.userId });
  return { prisma, account, approval, receipts, call, run, draft };
}
function noProducerWrites(f: ReturnType<typeof fixture>) {
  expect(createInvoice).not.toHaveBeenCalled(); expect(updateInvoice).not.toHaveBeenCalled();
  expect(f.prisma.agentCommitReceipt.create).not.toHaveBeenCalled(); expect(f.prisma.agentCommitReceipt.update).not.toHaveBeenCalled();
  expect(f.prisma.approvalRequest.create).not.toHaveBeenCalled(); expect(f.prisma.approvalRequest.update).not.toHaveBeenCalled();
}
beforeEach(() => {
  vi.clearAllMocks(); routing.fallback.clear();
  vi.mocked(createInvoice).mockResolvedValue({ ok: true, data: { invoice: { id: 'invoice-created' }, auditId: 'audit-created' } });
  vi.mocked(updateInvoice).mockResolvedValue({ ok: true, data: { invoice: { id: 'invoice-original' }, auditId: 'audit-updated' } });
});

for (const mode of ['registered', 'fallback'] as const) describe(`actual ${mode} invoice dispatch authority`, () => {
  beforeEach(() => { if (mode === 'fallback') routing.fallback = new Set(['invoice.create', 'invoice.update', 'finance.create_invoice']); });
  it.each(['invoice.create', 'invoice.update', 'finance.create_invoice'])('%s cannot derive authority from scalar actor, body, draft or approval requester', async toolId => {
    const f = fixture(toolId);
    const result: any = await f.run(null, { actor: { ...actor, userId: 'body-impostor' }, actorId: actor.userId, permissionCeiling: ['*'] });
    expect(result.ok).toBe(false); expect(result.errorFeedback?.code ?? result.error?.code ?? result.error).toBe('UNAUTHORIZED'); noProducerWrites(f);
  });
  it.each(['invoice.create', 'invoice.update', 'finance.create_invoice'])('%s retains an explicitly empty signed ceiling despite current stored Admin grant', async toolId => {
    const f = fixture(toolId), result: any = await f.run({ ...actor, permissionCeiling: [] });
    expect(result.ok).toBe(false); expect(result.errorFeedback?.code ?? result.error?.code ?? result.error).toBe('FORBIDDEN'); noProducerWrites(f);
  });
  it.each(['invoice.create', 'invoice.update', 'finance.create_invoice'])('%s reaches the canonical producer with the actual operator and unmodified credential ceiling', async toolId => {
    const f = fixture(toolId), originalApproval = JSON.stringify(f.approval);
    const result: any = await f.run(); expect(result.ok).toBe(true);
    const producer = toolId === 'invoice.update' ? updateInvoice : createInvoice;
    expect(producer).toHaveBeenCalledTimes(1);
    expect(vi.mocked(producer).mock.calls[0][0]).toMatchObject({ actorId: actor.userId, actor: toolActorToken(actor) });
    expect(vi.mocked(producer).mock.calls[0][0].actor).not.toHaveProperty('requesterId');
    if (toolId !== 'invoice.update') expect(vi.mocked(producer).mock.calls[0][0].input.orderAllocations).toEqual(invoiceInput.orderAllocations);
    expect(JSON.stringify(f.approval)).toBe(originalApproval);
    expect(f.prisma.approvalRequest.create).not.toHaveBeenCalled(); expect(f.prisma.approvalRequest.update).not.toHaveBeenCalled();
    if (mode === 'registered' && toolId !== 'finance.create_invoice') expect([...f.receipts.values()][0]).toMatchObject({ approvalId: f.approval.id, status: 'committed' });
  });
  it.each(['invoice.create', 'invoice.update'])('%s retains the approved draft hash and refuses a tampered monetary/status command', async toolId => {
    const f = fixture(toolId); f.approval.payload.processDraft.subOperations[0].after = { ...f.approval.payload.processDraft.subOperations[0].after, amount: '999' };
    const result: any = await f.run(); expect(result.ok).toBe(false);
    expect(result.errorFeedback?.code ?? result.error?.code ?? result.error).toBe('PROCESS_DRAFT_HASH_MISMATCH');
    expect(createInvoice).not.toHaveBeenCalled(); expect(updateInvoice).not.toHaveBeenCalled();
    expect(f.prisma.approvalRequest.update).not.toHaveBeenCalled();
  });
});

describe('real registered invoice receipt replay checks current authority', () => {
  it.each(['invoice.create', 'invoice.update'])('%s refuses a previously successful receipt after the Invoice grant is revoked', async toolId => {
    const f = fixture(toolId); expect((await f.run() as any).ok).toBe(true);
    const original = [...f.receipts.values()][0]; f.account.roles[0].role.permissions = [];
    vi.clearAllMocks();
    const result: any = await f.run(); expect(result.ok).toBe(false); expect(result.errorFeedback.code).toBe('FORBIDDEN');
    expect(result).not.toHaveProperty('replayed'); noProducerWrites(f); expect([...f.receipts.values()][0]).toBe(original);
  });
  it('a grant revoked during receipt collision is rechecked before returning the cached result', async () => {
    const f = fixture(); expect((await f.run() as any).ok).toBe(true); vi.clearAllMocks();
    f.prisma.agentCommitReceipt.create.mockImplementation(async () => { f.account.roles[0].role.permissions = []; throw Object.assign(Error('receipt unique'), { code: 'P2002' }); });
    const result: any = await f.run(); expect(result.ok).toBe(false); expect(result.errorFeedback.code).toBe('FORBIDDEN');
    expect(result).not.toHaveProperty('replayed'); expect(createInvoice).not.toHaveBeenCalled(); expect(f.prisma.agentCommitReceipt.update).not.toHaveBeenCalled();
  });
  it('a still-authorized replay preserves the original receipt without creating another Invoice or approval', async () => {
    const f = fixture(); const first: any = await f.run(); vi.clearAllMocks();
    const replay: any = await f.run(); expect(replay).toMatchObject({ ...first, replayed: true });
    expect(createInvoice).not.toHaveBeenCalled(); expect(f.prisma.approvalRequest.create).not.toHaveBeenCalled(); expect(f.prisma.approvalRequest.update).not.toHaveBeenCalled();
    expect(f.prisma.agentCommitReceipt.update).not.toHaveBeenCalled(); expect(f.receipts.size).toBe(1);
  });
  it('a disabled current account cannot recover a cached successful receipt', async () => {
    const f = fixture(); expect((await f.run() as any).ok).toBe(true); f.account.status = 'disabled'; vi.clearAllMocks();
    const result: any = await f.run(); expect(result.ok).toBe(false); expect(result.errorFeedback.code).toBe('UNAUTHORIZED'); noProducerWrites(f);
  });
  it('missing live account storage is an authorization dependency failure rather than a missing-mock bypass', async () => {
    const f = fixture(); delete f.prisma.userAccount;
    const result: any = await f.run(); expect(result.ok).toBe(false); expect(result.errorFeedback.code).toBe('AUTHORIZATION_UNAVAILABLE'); noProducerWrites(f);
  });
});

describe('direct invoice flow boundary cannot consume bare audit identity', () => {
  it.each(['create', 'update'] as const)('%s requires the trusted actor even with a valid approved draft and body actor', async mode => {
    const f = fixture(`invoice.${mode}`);
    const params: any = { prisma: f.prisma, approvalId: f.approval.id, approvalPayload: f.approval.payload, actorId: actor.userId };
    const result = mode === 'create' ? await commitInvoiceCreate(params) : await commitInvoiceUpdate(params);
    expect(result.ok).toBe(false); if (!result.ok) expect(result.feedback.error.code).toBe('UNAUTHORIZED'); noProducerWrites(f);
  });
  it.each(['create', 'update'] as const)('%s passes the actual prior token without substituting requester identity', async mode => {
    const f = fixture(`invoice.${mode}`), trustedActor = toolActorToken(actor);
    const params: any = { prisma: f.prisma, approvalId: f.approval.id, approvalPayload: f.approval.payload, actorId: actor.userId, trustedActor };
    const result = mode === 'create' ? await commitInvoiceCreate(params) : await commitInvoiceUpdate(params);
    expect(result.ok).toBe(true);
    expect(vi.mocked(mode === 'create' ? createInvoice : updateInvoice).mock.calls[0][0].actor).toBe(trustedActor);
  });
});

it('actual runtime keeps the finance direct handler registered', () => { expect(getToolHandler('finance.create_invoice')).toBeTypeOf('function'); });
