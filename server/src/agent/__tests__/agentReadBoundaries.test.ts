import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIdentityService } from '../identity';
import { executeAgentTool, runAgentToolCalls } from '../toolRuntime';

// Real identity/policy/dispatch/domain services with in-memory storage adapters.
// These establish action + row/output boundaries, not PG transactions, company
// special approval policy, or a complete human-role business handoff.
const USER = 'read-boundary-user';
const account = () => ({ id: USER, status: 'active', deletedAt: null, primaryDepartment: { id: 'dept-current', status: 'active' }, roles: [{ roleId: 'role-sales', department: { id: 'dept-current', status: 'active' } }] });
function dbMatch(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([key, value]: any) => {
    if (key === 'AND') return value.every((part: any) => dbMatch(row, part));
    if (key === 'OR') return value.some((part: any) => dbMatch(row, part));
    if (value && typeof value === 'object') {
      if ('in' in value) return value.in.includes(row[key]);
      if ('notIn' in value) return !value.notIn.includes(row[key]);
      if ('has' in value) return row[key]?.includes(value.has);
    }
    return row[key] === value;
  });
}
function storage() {
  const state = { account: account() as any, payments: [] as any[], links: [] as any[], products: [{ id: 'product-source', sku: 'SKU-SOURCE', deletedAt: null }, { id: 'product-allowed', sku: 'SKU-ALLOWED', deletedAt: null }], orders: [] as any[] };
  const prisma: any = {
    userAccount: { findFirst: vi.fn(async ({ where }: any) => state.account?.id === where.id ? state.account : null) },
    userRole: { findMany: vi.fn().mockResolvedValue([]) },
    agentTool: { upsert: vi.fn().mockResolvedValue({}) }, agentToolRun: { create: vi.fn(async ({ data }: any) => data) },
    approvalRequest: { findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]), create: vi.fn() },
    paymentVoucher: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
    paymentRequest: { findUnique: vi.fn(async ({ where }: any) => state.payments.find(row => row.id === where.id) ?? null), findMany: vi.fn(async ({ where, take }: any) => state.payments.filter(row => dbMatch(row, where)).slice(0, take)), update: vi.fn() },
    productAsset: { findFirst: vi.fn(async ({ where }: any) => state.products.find(row => dbMatch(row, where)) ?? null), update: vi.fn() },
    order: { findFirst: vi.fn(async ({ where }: any) => state.orders.find(row => dbMatch(row, where)) ?? null), findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
    relation: { findMany: vi.fn().mockResolvedValue([]) }, teamMember: { findMany: vi.fn().mockResolvedValue([]) }, teamDataGrant: { findMany: vi.fn().mockResolvedValue([]) },
    entityLink: { findMany: vi.fn(async ({ where, take }: any) => state.links.filter(row => dbMatch(row, where)).slice(0, take)) }, entityReference: { findMany: vi.fn() },
    agentMemory: { create: vi.fn(async ({ data }: any) => data), findMany: vi.fn().mockResolvedValue([]) },
    dr013ExceptionRequest: { findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]), update: vi.fn(), updateMany: vi.fn() },
    auditLog: { create: vi.fn() }, $transaction: vi.fn(),
  };
  return { prisma, state };
}
function actor(scopes: string[] = [], roles = ['viewer'], departmentIds = ['dept-current']) {
  return createIdentityService().resolveActorContext({ userId: USER, roles: roles as any, departmentIds, permissions: scopes, authorizationLoaded: true });
}
const pay = (id: string, applicantId: string, reviewerId: string | null = null) => ({ id, applicantId, reviewerId, requestNumber: `PAYR-${id}`, status: 'Pending', totalAmount: 10, currency: 'CNY', approvalRequestId: 'approval-private', paymentVoucherId: 'voucher-private', deletedAt: null });
const link = (toType: string, toId: string, other: any = {}) => ({ fromType: 'product', fromId: 'product-source', toType, toId, linkKind: 'aboutProduct', status: 'active', deletedAt: null, updatedAt: BigInt(1), ...other });
function noBusinessWrites(prisma: any) {
  for (const fn of [prisma.$transaction, prisma.paymentRequest.update, prisma.paymentVoucher.create, prisma.order.update, prisma.productAsset.update, prisma.dr013ExceptionRequest.update, prisma.dr013ExceptionRequest.updateMany, prisma.approvalRequest.create]) expect(fn).not.toHaveBeenCalled();
  // Normal read/denial tool audit is legitimate. No business projection audit.
  for (const [call] of prisma.auditLog.create.mock.calls) expect(call.data).toMatchObject({ targetType: 'AgentTool', action: expect.stringMatching(/^agent_tool_/) });
}
beforeEach(() => { vi.stubEnv('BAMBOOK_AGENT_DATA_API_BASE', ''); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External action prohibited in read-boundary probe'); })); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('Agent legal reads and shared memory (storage substitutes)', () => {
  it('empty trusted scopes may read own payment request under the actual authenticated + self contract', async () => {
    const { prisma, state } = storage(); state.payments.push(pay('own', USER));
    const result = await executeAgentTool({ prisma, actor: await actor(), toolId: 'payment_requests.query', toolInput: { id: 'own' } });
    expect(result).toMatchObject({ ok: true, item: { id: 'own', applicantId: USER } }); noBusinessWrites(prisma);
  });
  it('guessed other payment id returns same not-found and never reads its approval/voucher', async () => {
    const { prisma, state } = storage(); state.payments.push(pay('other', 'other-user'));
    const result = await executeAgentTool({ prisma, actor: await actor(), toolId: 'payment_requests.query', toolInput: { id: 'other', actor: { roles: ['owner'], userId: 'other-user' } } });
    expect(result).toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
    expect(prisma.approvalRequest.findUnique).not.toHaveBeenCalled(); expect(prisma.paymentVoucher.findUnique).not.toHaveBeenCalled(); noBusinessWrites(prisma);
  });
  it('appointed cross-team reviewer may read without expanding to other requests', async () => {
    const { prisma, state } = storage(); state.payments.push(pay('review', 'other-user', USER), pay('hidden', 'other-user', 'other-reviewer'));
    await executeAgentTool({ prisma, actor: await actor(), toolId: 'payment_requests.query', toolInput: {} });
    expect(prisma.paymentRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { deletedAt: null, AND: [{ OR: [{ applicantId: { in: [USER] } }, { reviewerId: USER }] }] } }));
    expect(prisma.agentToolRun.create).toHaveBeenCalledWith({ data: expect.objectContaining({ output: expect.objectContaining({ items: [expect.objectContaining({ id: 'review' })], total: 1 }) }) }); noBusinessWrites(prisma);
  });
  it('caller applicant filter intersects allowed rows; input actor cannot turn it into all', async () => {
    const { prisma, state } = storage(); state.payments.push(pay('hidden', 'other-user'));
    const result = await executeAgentTool({ prisma, actor: await actor(), toolId: 'payment_requests.query', toolInput: { applicantId: 'other-user', actor: { roles: ['owner'] } } });
    expect(result).toMatchObject({ ok: true, total: 0, items: [] });
    expect(prisma.paymentRequest.findMany.mock.calls[0][0].where).toMatchObject({ applicantId: 'other-user', AND: expect.any(Array) }); noBusinessWrites(prisma);
  });
  it('real team resolver includes current teammates; loop forwards the trusted actor', async () => {
    const { prisma, state } = storage(); state.payments.push(pay('team', 'teammate'), pay('outside', 'outsider'));
    prisma.teamMember.findMany.mockImplementation(async ({ where }: any) => where.userId ? [{ teamId: 'team-live' }] : [{ userId: USER }, { userId: 'teammate' }]);
    const hits = await runAgentToolCalls({ prisma, actor: await actor([], ['sales']), calls: [{ toolId: 'payment_requests.query', input: {}, reason: 'current team requests' }] });
    expect(hits).toHaveLength(1); expect(prisma.paymentRequest.findMany.mock.calls[0][0].where.AND[0].OR[0]).toEqual({ applicantId: { in: [USER, 'teammate'] } }); noBusinessWrites(prisma);
  });
  it('finance current human data-scope resolver allows all payment requests', async () => {
    const { prisma, state } = storage(); state.payments.push(pay('other', 'other-user'));
    const result = await executeAgentTool({ prisma, actor: await actor(['finance:read'], ['finance']), toolId: 'payment_requests.query', toolInput: { id: 'other' } });
    expect(result).toMatchObject({ ok: true, item: { id: 'other' } }); noBusinessWrites(prisma);
  });
  it('product links disclose authorized product identifiers; deny unrelated financial/payroll neighbors and never load snapshots', async () => {
    const { prisma, state } = storage(); state.links.push(link('product', 'product-allowed'), link('invoice', 'invoice-private'), link('Salary', 'salary-private', { metadata: { salary: 90000 }, source: 'secret salary 90000' }));
    const result = await executeAgentTool({ prisma, actor: await actor(['products:read']), toolId: 'links.expand_neighbors', toolInput: { type: 'product', id: 'product-source' } });
    expect(result).toEqual({ ok: true, type: 'product', id: 'product-source', total: 1, neighbors: { aboutProduct: [{ direction: 'out', type: 'product', id: 'product-allowed', label: 'SKU-ALLOWED', updatedAt: 1 }] } });
    expect(JSON.stringify(result)).not.toMatch(/invoice-private|salary-private|90000/); expect(prisma.entityReference.findMany).not.toHaveBeenCalled(); noBusinessWrites(prisma);
  });
  it('outgoing input returns the actual neighbor; untrusted linkKind/source/snapshot content is not output', async () => {
    const { prisma, state } = storage(); state.links.push(link('product', 'product-allowed', { linkKind: 'secret_salary_90000', source: 'private bank account', metadata: { amount: 90000 } }));
    const result = await executeAgentTool({ prisma, actor: await actor(['products:read']), toolId: 'links.query', toolInput: { fromType: 'product', fromId: 'product-source' } });
    expect(result).toEqual({ ok: true, total: 1, links: [{ direction: 'out', linkKind: 'related', otherType: 'product', otherId: 'product-allowed', label: 'SKU-ALLOWED', updatedAt: 1 }] }); noBusinessWrites(prisma);
  });
  it('missing source permission denies before graph/storage access even if input forges an owner', async () => {
    const { prisma } = storage();
    await expect(executeAgentTool({ prisma, actor: await actor(['products:read']), toolId: 'links.query', toolInput: { type: 'order', id: 'order-private', actor: { roles: ['owner'] } } })).rejects.toThrow('INSUFFICIENT_SCOPE: orders:read');
    expect(prisma.order.findFirst).not.toHaveBeenCalled(); expect(prisma.entityLink.findMany).not.toHaveBeenCalled(); noBusinessWrites(prisma);
  });
  it('valid module scope cannot bypass actual order row scope', async () => {
    const { prisma } = storage();
    const result = await executeAgentTool({ prisma, actor: await actor(['orders:read']), toolId: 'links.query', toolInput: { type: 'order', id: 'other-order' } });
    expect(result).toMatchObject({ ok: false, reason: 'ENTITY_NOT_FOUND_OR_NOT_VISIBLE' });
    expect(prisma.order.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'other-order', deletedAt: null, OR: expect.any(Array) }) }));
    expect(prisma.entityLink.findMany).not.toHaveBeenCalled(); noBusinessWrites(prisma);
  });
  it('exception query displays committed approved fact while keeping Pending row and audits untouched', async () => {
    const { prisma } = storage(); prisma.dr013ExceptionRequest.findUnique.mockResolvedValue({ id: 'exception-1', status: 'Pending', approvalRequestId: 'approval-1', deletedAt: null }); prisma.approvalRequest.findUnique.mockResolvedValue({ id: 'approval-1', status: 'approved', reviewerId: 'actual-reviewer' });
    const result = await executeAgentTool({ prisma, actor: await actor(), toolId: 'exceptions.query', toolInput: { id: 'exception-1' } });
    expect(result).toMatchObject({ ok: true, item: { status: 'ReviewerApproved', approvalProjectionPending: true } }); noBusinessWrites(prisma);
  });
  it.each(['company', 'department:dept-current', 'role:sales'])('shared memory %s restores legal current membership and records one tool run', async scope => {
    const { prisma } = storage();
    const result = await executeAgentTool({ prisma, actor: await actor([], ['sales']), toolId: 'memory.write', toolInput: { scope, content: 'Explicitly requested shared operating reminder.' } });
    expect(result).toMatchObject({ ok: true, memory: { scope } }); expect(prisma.agentMemory.create).toHaveBeenCalledTimes(1); expect(prisma.agentToolRun.create).toHaveBeenCalledTimes(1);
    expect(prisma.userAccount.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: USER, status: 'active', deletedAt: null }, select: expect.objectContaining({ roles: expect.any(Object), primaryDepartment: expect.any(Object) }) }));
  });
  it.each(['missing', 'inactive', 'moved', 'inactive-department', 'removed-role', 'spoofed-role', 'query-fault'])('shared memory %s denies before persistence', async scenario => {
    const { prisma, state } = storage(); const subject = await actor([], ['sales']); let scope = 'company';
    if (scenario === 'missing') state.account = null;
    if (scenario === 'inactive') state.account.status = 'disabled';
    if (scenario === 'moved') { scope = 'department:dept-current'; state.account.primaryDepartment.id = 'dept-new'; state.account.roles = []; }
    if (scenario === 'inactive-department') { scope = 'department:dept-current'; state.account.primaryDepartment.status = 'inactive'; state.account.roles[0].department.status = 'inactive'; }
    if (scenario === 'removed-role') { scope = 'role:sales'; state.account.roles = []; }
    if (scenario === 'spoofed-role') { scope = 'role:sales'; state.account.roles = [{ roleId: 'custom-role', role: { name: 'sales' } }]; }
    if (scenario === 'query-fault') prisma.userAccount.findFirst.mockRejectedValue(new Error('SQL credential/private schema error'));
    await expect(executeAgentTool({ prisma, actor: subject, toolId: 'memory.write', toolInput: { scope, content: 'Explicit shared note', actor: { userId: USER, roles: ['owner'] } } })).rejects.toThrow(/MEMORY_/);
    expect(prisma.agentMemory.create).not.toHaveBeenCalled(); expect(JSON.stringify(prisma.agentToolRun.create.mock.calls)).not.toContain('SQL credential/private schema error');
  });
  it('loop memory write uses same active-membership boundary and one tool run', async () => {
    const { prisma } = storage(); const hits = await runAgentToolCalls({ prisma, actor: await actor([], ['sales']), sessionId: 'memory-session', calls: [{ toolId: 'memory.write', input: { scope: 'company', content: 'Explicitly remember this shared rule.' }, reason: 'explicit user remember request' }] });
    expect(hits).toHaveLength(1); expect(prisma.agentMemory.create).toHaveBeenCalledWith({ data: expect.objectContaining({ scope: 'company', sourceId: 'memory-session' }) }); expect(prisma.agentToolRun.create).toHaveBeenCalledTimes(1);
  });
});
