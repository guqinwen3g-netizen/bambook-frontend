import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import crypto from 'crypto';
import request from 'supertest';
import { createAgentLoop } from '../agentLoop';
import { InMemoryCheckpointManager, type AgentCheckpoint } from '../checkpoint';
import { executeAgentTool } from '../toolRuntime';
import { createIdentityService } from '../identity';
import { refreshToolActor } from '../../ai/refreshToolActor';
import { createAiRouter } from '../../ai/route';
import { createAiRuntime, type AiEventType } from '../../ai/runtime';
import { createAgentRouter } from '../route';
import { createAuthService } from '../../auth/service';
import { TemplateNotFoundError, TemplateRenderError } from '../../templates/render';
import { GENERIC_ROUTE_ERROR_MESSAGE } from '../../shared/routeError';

const faultState = vi.hoisted(() => ({ error: undefined as unknown, launches: 0 }));
vi.mock('playwright', () => ({ chromium: { launch: async () => { faultState.launches++; throw faultState.error; } } }));
afterEach(() => { faultState.error = undefined; faultState.launches = 0; });
const privateText = 'SQL private table /internal/path';
const userId = 'returned-failure-operator';
const scopes = ['ai:chat', 'invoices:reconcile', 'relations:write', 'tools:execute'];
const inputs: Record<string, any> = {
  'finance.apply_voucher_to_invoice': { invoiceId: 'invoice', voucherId: 'voucher', appliedAmount: '20' },
  'relations.create': { id: 'own-relation', name: '本人 SQL /user/path', category: 'Customer' },
  'template.render': { templateId: 'invoice.sample.pdas', data: { invoiceNumber: 'own-invoice', invoiceDate: '2026-10-03', items: Object.assign([], { reduce: () => { throw new Error(privateText); } }) } },
  'template.render_pdf': { templateId: 'invoice.sample.pdas', data: { invoiceNumber: 'own-invoice', invoiceDate: '2026-10-03', items: [] } },
};
class ObservedCheckpoint extends InMemoryCheckpointManager {
  saved: AgentCheckpoint[] = [];
  async save(point: AgentCheckpoint) { this.saved.push(point); return super.save(point); }
}
function storage(error: unknown, nativeInvoiceMissing = false) {
  const runs: any[] = [], audits: any[] = [], approvals: any[] = [];
  const account: any = { id: userId, status: 'active', deletedAt: null, primaryDeptId: 'own-department',
    primaryDepartment: { id: 'own-department', name: '合成团队', status: 'active' },
    roles: [{ roleId: 'role-sales', departmentId: 'own-department', role: { id: 'role-sales', permissions: scopes.map(scope => ({ permission: { scope } })) } }] };
  const tx = { $queryRawUnsafe: vi.fn(async (_sql: string, _id: string) => []),
    creditNoteRefundReturn: { findUnique: vi.fn(async () => null) }, creditNoteRefund: { findUnique: vi.fn(async () => null) },
    invoice: { findUnique: vi.fn(async () => null) } };
  const db: any = {
    userAccount: { findFirst: vi.fn(async (args: any) => args.where.id === 'own-reviewer' ? { id: 'own-reviewer' } : args.select?.id ? { id: userId, primaryDeptId: 'own-department' } : account), findMany: vi.fn(async () => []) },
    userPermissionOverrides: { findMany: vi.fn(async () => []) },
    department: { findUnique: vi.fn(async () => ({ id: 'own-department', status: 'active', headId: 'own-reviewer', parentId: null })) },
    approvalRequest: { create: vi.fn(async (args: any) => { const row = { ...args.data, createdAt: new Date(), decidedAt: null }; approvals.push(row); return row; }), findUnique: vi.fn(async (args: any) => approvals.find(row => row.id === args.where.id) ?? null) },
    agentTool: { upsert: vi.fn(async () => ({})) },
    agentToolRun: { create: vi.fn(async (args: any) => { runs.push(args.data); return args.data; }), findUnique: vi.fn(async (args: any) => runs.find(r => r.id === args.where.id) ?? null) },
    auditLog: { create: vi.fn(async (args: any) => { audits.push(args.data); return args.data; }) },
    $transaction: vi.fn(async (callback: any) => { if (nativeInvoiceMissing) return callback(tx); throw error; }),
  };
  return { db, account, runs, audits, approvals, tx };
}
async function executeChain(toolId: string, error: unknown, options: { nativeInvoiceMissing?: boolean; revoke?: boolean; storageUnknown?: boolean; inactive?: boolean; ceiling?: boolean; humanNote?: string; validHtml?: boolean } = {}) {
  const h = storage(error, options.nativeInvoiceMissing);
  const prior = await createIdentityService().resolveActorContext({ userId, roles: ['sales'], departmentIds: ['own-department'], permissions: scopes, authorizationLoaded: true });
  const checkpoint = new ObservedCheckpoint(), events: any[] = [];
  // Getter stays in the actual executor input; the LLM plan carries only public data.
  const llm = vi.fn().mockResolvedValueOnce(JSON.stringify({ thought: '执行本人操作', action: 'call_tool', toolCalls: [{ toolId, input: toolId === 'template.render' ? { templateId: 'invoice.sample.pdas', data: {} } : inputs[toolId] }] }))
    .mockResolvedValue(JSON.stringify({ thought: '结束', action: 'final_answer', finalAnswer: '本轮结束。' }));
  const execute = vi.fn(async (input: any) => {
    const actor = await refreshToolActor(h.db, prior, { userId, requestSource: options.ceiling ? 'api-key' : 'user-session', permissionCeiling: options.ceiling ? ['ai:chat'] : undefined });
    return executeAgentTool({ ...input, prisma: h.db, actor, actorUserId: userId, requestSource: 'user-session', toolInput: options.validHtml ? { ...inputs[toolId], data: { invoiceNumber: 'own-invoice', invoiceDate: '2026-10-03', items: [] } } : inputs[toolId] });
  });
  const loop = createAgentLoop({ llm, toolExecutor: execute, availableTools: [{ id: toolId, name: toolId, scope: toolId.split('.')[0], risk: 'high', description: '原工具' }], checkpointManager: checkpoint,
    approvalResolver: async () => {
      if (options.revoke) h.account.roles[0].role.permissions = [];
      if (options.inactive) h.account.status = 'inactive';
      if (options.storageUnknown) h.db.userAccount.findFirst.mockImplementation(async () => { throw new Error(privateText); });
      return options.humanNote ? { status: 'rejected', decisionNote: options.humanNote } : { status: 'approved' };
    } });
  let result: Awaited<ReturnType<typeof loop.run>> | undefined;
  const runtime = createAiRuntime({ chatRunner: async input => {
    expect(input.userId).toBe(userId); expect(input.actorUserId).toBe(userId); expect(input.requestSource).toBe('user-session');
    result = await loop.run({ actor: prior, conversationId: 'own-chain', message: input.message, history: [], attachmentContext: [], signal: input.signal,
      emit: (type, payload) => { events.push({ type, payload }); input.emit(type as AiEventType, payload); }, config: { maxSteps: 2, llmRepairRetries: 0 } });
    return { text: result.text, thoughtProcess: result.thoughtProcess, sources: result.sources, stopReason: result.stopReason };
  } });
  const app = express(); app.use(express.json()); app.use('/api/ai', createAiRouter({ runtime, requireAuth: true, apiKeys: new Set() }));
  const token = createAuthService().signToken({ userId, roles: ['sales'], departmentIds: ['own-department'], permissions: scopes, authorizationLoaded: true });
  const response = await request(app).post('/api/ai/chat').set('Authorization', `Bearer ${token}`).send({ message: '本人 SQL /user/path' });
  return { ...h, checkpoint, events, result, execute, llm, response, token };
}
describe('actual returned failure native execution and public carrier', () => {
  it.each(Object.keys(inputs))('unknown %s stays safe through original approval, actual handler, ToolRun, audit, Loop, checkpoint, LLM and HTTP SSE', async toolId => {
    faultState.error = Object.assign(new Error(privateText), { code: 'CURRENCY_MISMATCH', statusCode: 400, name: 'TemplateRenderError' });
    const h = await executeChain(toolId, faultState.error);
    expect(h.response.status).toBe(200); expect(h.response.text).toContain('event: agent_event'); expect(h.response.text).toContain('event: final');
    expect(h.approvals).toHaveLength(toolId.startsWith('template.') ? 0 : 1); if (!toolId.startsWith('template.')) expect(h.approvals[0]).toMatchObject({ requesterId: userId, reviewerId: 'own-reviewer', reviewerResolverRoute: 'DEPT_HEAD', departmentSnapshotId: 'own-department', status: 'pending' });
    expect(h.execute).toHaveBeenCalledTimes(toolId.startsWith('template.') ? 1 : 2); if (!toolId.startsWith('template.')) expect(h.execute.mock.calls[1][0]).toMatchObject({ skipApprovalCheck: true, approvalId: h.approvals[0].id });
    const failed = h.runs.find(row => row.status === 'failed'); expect(failed).toBeTruthy(); expect(failed.output.ok).toBe(false);
    if (toolId === 'finance.apply_voucher_to_invoice') expect(failed.output).toEqual({ ok: false, error: 'ALLOCATION_FAILED', message: GENERIC_ROUTE_ERROR_MESSAGE });
    if (toolId === 'relations.create') expect(failed.output).toEqual({ ok: false, error: 'CREATE_FAILED', message: GENERIC_ROUTE_ERROR_MESSAGE, dataSource: 'bambook-data-center' });
    if (toolId.startsWith('template.')) expect(failed.output).toEqual({ ok: false, error: GENERIC_ROUTE_ERROR_MESSAGE });
    expect(h.events.filter(e => e.payload.phase === 'tool_call_end' && e.payload.status === 'complete')).toEqual([]);
    for (const surface of [h.response.text, JSON.stringify(h.result), JSON.stringify(h.checkpoint.saved), JSON.stringify(h.llm.mock.calls), JSON.stringify(h.runs), JSON.stringify(h.audits)]) expect(surface).not.toContain('/internal/path');
    expect(h.response.text).toContain('/user/path');
    const app = express(); app.use(express.json()); app.use('/api/agent', createAgentRouter({ prisma: h.db, requireAuth: true, apiKeys: new Set(), getRuntimeMetrics: () => ({}), dataSource: {} as any }));
    const read = await request(app).get(`/api/agent/tool-runs/${failed.id}`).set('Authorization', `Bearer ${h.token}`);
    expect(read.status).toBe(200); expect(JSON.stringify(read.body)).not.toContain('/internal/path'); expect(JSON.stringify(read.body)).toContain('"ok":false');
    if (toolId === 'template.render_pdf') expect(faultState.launches).toBe(1);
  });
  it.each([
    ['ordinary', () => new Error(privateText)],
    ['shape', () => ({ code: 'FORBIDDEN', statusCode: 403, message: privateText })],
    ['constructed missing class', () => new TemplateNotFoundError(privateText)],
    ['constructed render class tampered', () => Object.assign(new TemplateRenderError('invoice.sample.pdas', new Error(privateText)), { message: privateText })],
    ['prototype/name impersonation', () => Object.assign(Object.create(TemplateRenderError.prototype), { name: 'TemplateRenderError', message: privateText })],
  ])('actual PDF fault %s cannot gain template provenance or leak through native HTTP/records', async (_name, make) => {
    faultState.error = make();
    const h = await executeChain('template.render_pdf', faultState.error);
    expect(h.response.status).toBe(200); expect(faultState.launches).toBe(1);
    const failed = h.runs.find(row => row.status === 'failed'); expect(failed.output).toEqual({ ok: false, error: GENERIC_ROUTE_ERROR_MESSAGE });
    expect(h.approvals).toEqual([]); expect(h.execute).toHaveBeenCalledOnce();
    for (const value of [h.response.text, JSON.stringify(h.runs), JSON.stringify(h.audits), JSON.stringify(h.result), JSON.stringify(h.checkpoint.saved), JSON.stringify(h.llm.mock.calls)]) expect(value).not.toContain('/internal/path');
  });
  it('actual post-render hash dependency fault stays safe in HTML handler and native SSE/records', async () => {
    const spy = vi.spyOn(crypto, 'createHash').mockImplementationOnce((() => { throw Object.assign(new Error(privateText), { code: 'FORBIDDEN', statusCode: 403 }); }) as any);
    try {
      const h = await executeChain('template.render', undefined, { validHtml: true });
      expect(h.response.status).toBe(200); expect(spy).toHaveBeenCalled();
      const failed = h.runs.find(row => row.status === 'failed'); expect(failed.output).toEqual({ ok: false, error: GENERIC_ROUTE_ERROR_MESSAGE });
      expect(h.execute).toHaveBeenCalledOnce(); expect(h.approvals).toEqual([]);
      for (const value of [h.response.text, JSON.stringify(h.result), JSON.stringify(h.runs), JSON.stringify(h.audits), JSON.stringify(h.checkpoint.saved), JSON.stringify(h.llm.mock.calls)]) expect(value).not.toContain('/internal/path');
    } finally { spy.mockRestore(); }
  });
  it('actual applyAllocation with missing invoice preserves native refusal and original lock/FK order in every public carrier', async () => {
    const h = await executeChain('finance.apply_voucher_to_invoice', undefined, { nativeInvoiceMissing: true });
    const copy = '发票不存在或已删除，请重新选择来源单据。';
    expect(h.db.$transaction).toHaveBeenCalledOnce(); expect(h.tx.invoice.findUnique).toHaveBeenCalledOnce();
    expect(h.tx.$queryRawUnsafe.mock.calls.map(v => v[0])).toEqual([
      'SELECT * FROM "MaterialReturn" WHERE "claimInvoiceId" = $1 AND "deletedAt" IS NULL ORDER BY id',
      'SELECT id FROM "Invoice" WHERE id = $1 FOR UPDATE', 'SELECT id FROM "PaymentVoucher" WHERE id = $1 FOR UPDATE']);
    const failed = h.runs.find(r => r.status === 'failed'); expect(failed.output).toEqual({ ok: false, error: 'INVOICE_NOT_FOUND', message: copy });
    expect(h.response.text).toContain('INVOICE_NOT_FOUND'); expect(h.result?.thoughtProcess).toContain('INVOICE_NOT_FOUND');
    expect(JSON.stringify(h.result)).toContain('INVOICE_NOT_FOUND'); expect(JSON.stringify(h.runs)).toContain(copy);
  });
  it.each(['revoke', 'inactive', 'storageUnknown', 'ceiling'] as const)('actual current %s denial cannot reach the original write handler after approval', async kind => {
    const h = await executeChain('finance.apply_voucher_to_invoice', new Error(privateText), { [kind]: true });
    expect(h.db.$transaction).not.toHaveBeenCalled();
    expect(h.runs.filter(r => r.status === 'success')).toEqual([]);
    expect(h.events.filter(e => e.payload.phase === 'tool_call_end' && e.payload.status === 'complete')).toEqual([]);
    expect(JSON.stringify([h.result, h.events, h.runs])).not.toContain('/internal/path');
    expect(h.execute).toHaveBeenCalledTimes(kind === 'ceiling' ? 1 : 2);
  });
  it('original human rejection note and input remain exact without executing a business writer', async () => {
    const note = '本人决定 SQL /user/path';
    const h = await executeChain('finance.apply_voucher_to_invoice', new Error(privateText), { humanNote: note });
    expect(h.db.$transaction).not.toHaveBeenCalled(); expect(h.execute).toHaveBeenCalledOnce(); expect(h.result?.thoughtProcess).toContain(note);
    expect(h.checkpoint.saved.map(p => p.message).every(message => message === '本人 SQL /user/path')).toBe(true);
  });
});
