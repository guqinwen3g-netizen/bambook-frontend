import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';

const pdfFault = vi.hoisted(() => ({ value: undefined as unknown, calls: 0 }));
vi.mock('playwright', () => ({ chromium: { launch: async () => { pdfFault.calls++; throw pdfFault.value; } } }));
const loggers: Array<{ close: () => unknown }> = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  pdfFault.value = undefined; pdfFault.calls = 0;
  for (const logger of loggers.splice(0)) logger.close();
});
const secret = 'SQL /internal/logging-only';
const operatorId = 'logging-only-operator';
const scopes = ['ai:chat', 'orders:read', 'invoices:reconcile', 'relations:write', 'tools:execute'];
const shapes = {
  cycle: () => { const value: any = { message: secret }; value.self = value; return value; },
  getter: () => Object.defineProperty(new Error(secret), 'unserializable', { enumerable: true, get() { throw new Error('SQL /internal/getter'); } }),
  proxy: () => new Proxy(new Error(secret), { ownKeys() { throw new Error('SQL /internal/proxy'); } }),
  bigint: () => ({ message: secret, unserializable: 1n }),
  toJSON: () => ({ message: secret, toJSON() { throw new Error('SQL /internal/toJSON'); } }),
};
async function fresh() {
  // Winston's serializer can leave a failed stream unusable. Each actual-shape
  // control gets the unmodified real logger in a fresh module instance.
  vi.resetModules();
  const [loop, identity, checkpoint, runtime, ai, auth, tool, refresh, log, template, tts] = await Promise.all([
    import('../agentLoop'), import('../identity'), import('../checkpoint'), import('../../ai/runtime'),
    import('../../ai/route'), import('../../auth/service'), import('../toolRuntime'), import('../../ai/refreshToolActor'),
    import('../../lib/logger'), import('../../templates/render'), import('../../ai/tts'),
  ]);
  loggers.push(log.logger); tts.resetMeloCircuitForTesting();
  return { ...loop, ...identity, ...checkpoint, ...runtime, ...ai, ...auth, ...tool, ...refresh, ...log, ...template, ...tts };
}
type Modules = Awaited<ReturnType<typeof fresh>>;
async function actor(m: Modules) {
  return m.createIdentityService().resolveActorContext({ userId: operatorId, roles: ['sales'], departmentIds: ['own-department'], permissions: scopes, authorizationLoaded: true });
}
function jwt(m: Modules) {
  return m.createAuthService().signToken({ userId: operatorId, roles: ['sales'], departmentIds: ['own-department'], permissions: scopes, authorizationLoaded: true });
}
async function direct(m: Modules, fault: unknown, options: { llmFault?: boolean; timeout?: boolean } = {}) {
  const events: any[] = [];
  const execute = vi.fn(async (input: any) => {
    if (options.timeout) return new Promise((_resolve, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }));
    throw fault;
  });
  const llm = options.llmFault ? vi.fn(async () => { throw fault; }) : vi.fn()
    .mockResolvedValueOnce(JSON.stringify({ thought: '只读诊断', action: 'call_tool', toolCalls: [{ toolId: 'orders.query', input: {} }] }))
    .mockResolvedValue(JSON.stringify({ thought: '结束', action: 'final_answer', finalAnswer: '已结束。' }));
  const loop = m.createAgentLoop({ llm, toolExecutor: execute, availableTools: [{ id: 'orders.query', name: 'Query', scope: 'orders', risk: 'low', description: '合成诊断' }] });
  const result = await loop.run({ actor: await actor(m), message: '本人原话 SQL /user/path', history: [], attachmentContext: [], signal: new AbortController().signal,
    emit: (type, payload) => events.push({ type, payload }), config: { maxSteps: 2, llmRepairRetries: 0, perToolTimeoutMs: options.timeout ? 5 : 5000 } });
  return { result, events, execute, llm };
}
function storage(fault: unknown, nativeMissing = false) {
  const runs: any[] = [], audits: any[] = [], approvals: any[] = [], documents: any[] = [];
  const account = { id: operatorId, status: 'active', deletedAt: null, primaryDeptId: 'own-department',
    primaryDepartment: { id: 'own-department', name: '合成团队', status: 'active' },
    roles: [{ roleId: 'role-sales', departmentId: 'own-department', role: { id: 'role-sales', permissions: scopes.map(scope => ({ permission: { scope } })) } }] };
  const tx = { $queryRawUnsafe: vi.fn(async (_sql: string, _id: string) => []),
    creditNoteRefundReturn: { findUnique: vi.fn(async () => null) }, creditNoteRefund: { findUnique: vi.fn(async () => null) }, invoice: { findUnique: vi.fn(async () => null) } };
  const db: any = {
    userAccount: { findFirst: vi.fn(async (args: any) => args.where.id === 'own-reviewer' ? { id: 'own-reviewer' } : args.select?.id ? { id: operatorId, primaryDeptId: 'own-department' } : account), findMany: vi.fn(async () => []) },
    userPermissionOverrides: { findMany: vi.fn(async () => []) },
    department: { findUnique: vi.fn(async () => ({ id: 'own-department', status: 'active', headId: 'own-reviewer', parentId: null })) },
    approvalRequest: { create: vi.fn(async (args: any) => { const row = { ...args.data, createdAt: new Date(), decidedAt: null }; approvals.push(row); return row; }), findUnique: vi.fn(async (args: any) => approvals.find(row => row.id === args.where.id) ?? null) },
    agentTool: { upsert: vi.fn(async () => ({})) },
    agentToolRun: { create: vi.fn(async (args: any) => { runs.push(args.data); return args.data; }) },
    auditLog: { create: vi.fn(async (args: any) => { audits.push(args.data); return args.data; }) },
    renderedDoc: { create: vi.fn(async (args: any) => { const row = { id: 'own-rendered', ...args.data }; documents.push(row); return row; }) },
    $transaction: vi.fn(async (callback: any) => nativeMissing ? callback(tx) : Promise.reject(fault)),
  };
  return { db, account, runs, audits, approvals, documents, tx };
}
const toolInputs: Record<string, any> = {
  'finance.apply_voucher_to_invoice': { invoiceId: 'invoice', voucherId: 'voucher', appliedAmount: '20' },
  'relations.create': { id: 'own-relation', name: '本人原话 SQL /user/path', category: 'Customer' },
  'template.render': { templateId: 'invoice.sample.pdas', data: { invoiceNumber: 'own-invoice', invoiceDate: '2026-10-03', items: [] } },
  'template.render_pdf': { templateId: 'invoice.sample.pdas', data: { invoiceNumber: 'own-invoice', invoiceDate: '2026-10-03', items: [] } },
};
async function native(m: Modules, toolId: string, fault: unknown, options: { htmlHashFault?: boolean; nativeMissing?: boolean; renderFault?: boolean } = {}) {
  const h = storage(fault, options.nativeMissing), events: any[] = [];
  const prior = await actor(m), checkpoint = new m.InMemoryCheckpointManager();
  const input = options.renderFault ? { ...toolInputs[toolId], data: { ...toolInputs[toolId].data, items: Object.assign([], { reduce: () => { throw fault; } }) } } : toolInputs[toolId];
  const llm = vi.fn().mockResolvedValueOnce(JSON.stringify({ thought: '执行本人操作', action: 'call_tool', toolCalls: [{ toolId, input }] }))
    .mockResolvedValue(JSON.stringify({ thought: '结束', action: 'final_answer', finalAnswer: '已结束。' }));
  const execute = vi.fn(async (call: any) => {
    const current = await m.refreshToolActor(h.db, prior, { userId: operatorId, requestSource: 'user-session' });
    const hash = options.htmlHashFault ? vi.spyOn(crypto, 'createHash').mockImplementationOnce((() => { throw fault; }) as any) : undefined;
    try {
      return await m.executeAgentTool({ ...call, prisma: h.db, actor: current, actorUserId: operatorId, requestSource: 'user-session', toolInput: input });
    } finally { hash?.mockRestore(); }
  });
  const loop = m.createAgentLoop({ llm, toolExecutor: execute, availableTools: [{ id: toolId, name: toolId, scope: toolId.split('.')[0], risk: 'high', description: '原工具' }], checkpointManager: checkpoint,
    // The original decision resolver seam is explicit; this is not a proof of
    // the real approval writer or a PG commit, which this lease excludes.
    approvalResolver: async () => ({ status: 'approved' }) });
  const result = await loop.run({ actor: prior, conversationId: 'own-logging-chain', message: '本人原话 SQL /user/path', history: [], attachmentContext: [], signal: new AbortController().signal,
    emit: (type, payload) => events.push({ type, payload }), config: { maxSteps: 2, llmRepairRetries: 0 } });
  return { ...h, result, checkpoint, execute, llm, events };
}
function safeSurfaces(h: { result?: unknown; events?: unknown; runs?: unknown; audits?: unknown; llm?: any }) {
  for (const value of [h.result, h.events, h.runs, h.audits, h.llm?.mock.calls]) {
    if (value !== undefined) expect(JSON.stringify(value)).not.toContain('/internal/');
  }
}

describe('actual logging failure does not replace Agent outcomes', () => {
  it.each(Object.keys(shapes) as Array<keyof typeof shapes>)('actual Loop and real Winston keep the failed execution result for unknown %s', async shape => {
    const m = await fresh(), h = await direct(m, shapes[shape]());
    expect(h.execute).toHaveBeenCalledOnce(); expect(h.result.stopReason).toBe('final_answer');
    expect(h.result.iterations[0].toolCalls[0].ok).toBe(false);
    expect(h.result.iterations[0].toolCalls[0].error).toBe('服务器内部错误，请稍后重试。');
    expect(h.events.find(e => e.payload.phase === 'tool_call_end').payload.status).toBe('failed');
    safeSurfaces(h); expect(h.result.thoughtProcess).toContain('/user/path');
  });
  it('actual LLM cyclic fault keeps llm_failure and safe event metadata with the real logger', async () => {
    const m = await fresh(), h = await direct(m, shapes.cycle(), { llmFault: true });
    expect(h.execute).not.toHaveBeenCalled(); expect(h.result.stopReason).toBe('llm_failure');
    expect(h.events.find(e => e.payload.phase === 'error').payload.metadata.error.code).toBe('llm_failure'); safeSurfaces(h);
  });
  it('actual approval read cyclic fault preserves the original pending checkpoint and own control token', async () => {
    const m = await fresh(), checkpoint = new m.InMemoryCheckpointManager();
    const seed = { id: 'own-point', conversationId: 'own-pending', step: 1, message: '本人操作', scratchpad: { thoughts: [], toolCalls: [] }, iterations: [],
      pendingApproval: { approvalId: 'own-approval', step: 1, toolId: 'order.confirm', toolInput: {}, suspendedAt: '2026-10-03T00:00:00.000Z' }, createdAt: '2026-10-03T00:00:00.000Z' };
    await checkpoint.save(seed); const execute = vi.fn(), llm = vi.fn(), events: any[] = [];
    const loop = m.createAgentLoop({ llm, toolExecutor: execute, availableTools: [], checkpointManager: checkpoint, approvalResolver: async () => { throw shapes.cycle(); } });
    const result = await loop.run({ actor: await actor(m), conversationId: seed.conversationId, message: '本人操作', history: [], attachmentContext: [], signal: new AbortController().signal,
      emit: (type, payload) => events.push({ type, payload }), config: { maxSteps: 1, llmRepairRetries: 0 } });
    expect(result.stopReason).toBe('recovery_required'); expect(result.text).toContain('APPROVAL_STATE_UNAVAILABLE');
    expect((await checkpoint.load(seed.conversationId))?.pendingApproval?.approvalId).toBe('own-approval');
    expect(execute).not.toHaveBeenCalled(); expect(llm).not.toHaveBeenCalled(); safeSurfaces({ result, events });
  });
  it('actual own timeout token and AbortSignal survive a diagnostic logger that throws', async () => {
    const m = await fresh(); const log = vi.spyOn(m.logger, 'error').mockImplementation(() => { throw new Error('SQL /internal/logger'); });
    const h = await direct(m, undefined, { timeout: true });
    expect(log).toHaveBeenCalledWith('[agent-loop] execution failed', expect.anything());
    expect(h.execute.mock.calls[0][0].signal.reason.message).toBe('TOOL_TIMEOUT: 5ms');
    expect(h.result.iterations[0].toolCalls[0].error).toBe('TOOL_TIMEOUT: 5ms'); safeSurfaces(h);
  });
  it('logger method getter failure is guarded before it can replace the actual Loop failure', async () => {
    const m = await fresh(); Object.defineProperty(m.logger, 'error', { configurable: true, get() { throw new Error('SQL /internal/logger-getter'); } });
    const h = await direct(m, new Error(secret));
    expect(h.result.stopReason).toBe('final_answer'); expect(h.result.iterations[0].toolCalls[0].ok).toBe(false); safeSurfaces(h);
  });
  it('actual chat HTTP SSE retains the original outer failure event for a cyclic runner fault', async () => {
    const m = await fresh(), runner = vi.fn(async () => { throw shapes.cycle(); });
    const app = express(); app.use(express.json()); app.use('/api/ai', m.createAiRouter({ runtime: m.createAiRuntime({ chatRunner: runner }), requireAuth: true, apiKeys: new Set() }));
    const res = await request(app).post('/api/ai/chat').set('Authorization', `Bearer ${jwt(m)}`).send({ message: '本人原话 SQL /user/path' }).timeout({ deadline: 2500 });
    expect(res.status).toBe(200); expect(res.text).toContain('event: error'); expect(res.text).toContain('"ok":false');
    expect(res.text).not.toContain('event: final'); expect(res.text).not.toContain('/internal/'); expect(runner).toHaveBeenCalledOnce();
  });
  it('actual TTS speech HTTP keeps HTTP502/TTS_FAILED when real logging encounters a cyclic network fault', async () => {
    const m = await fresh(); vi.stubEnv('BAMBOOK_MELO_URL', 'http://127.0.0.1:9/synthetic-unused');
    const fetch = vi.fn(async () => { throw shapes.cycle(); }); vi.stubGlobal('fetch', fetch);
    const app = express(); app.use(express.json()); app.use('/api/ai', m.createAiRouter({ runtime: m.createAiRuntime(), requireAuth: true, apiKeys: new Set() }));
    const res = await request(app).post('/api/ai/tts/speech').set('Authorization', `Bearer ${jwt(m)}`).send({ text: '本人文本', voice: 'melo' }).timeout({ deadline: 2500 });
    expect(res.status).toBe(502); expect(res.body).toMatchObject({ ok: false, error: 'TTS_FAILED', message: '服务器内部错误，请稍后重试。' });
    expect(JSON.stringify(res.body)).not.toContain('/internal/'); expect(fetch).toHaveBeenCalledOnce();
  });
  it('actual chat TTS HTTP still emits one downgrade and its unchanged successful text after a cyclic synthesis fault', async () => {
    const m = await fresh(), text = '本人成功回答。', synthesize = vi.fn(async () => { throw shapes.cycle(); });
    const runtime = m.createAiRuntime({ chatRunner: async input => { input.emit('delta', { text }); return { text }; } });
    const app = express(); app.use(express.json()); app.use('/api/ai', m.createAiRouter({ runtime, requireAuth: true, apiKeys: new Set(), ttsSynthesizer: synthesize }));
    const res = await request(app).post('/api/ai/chat').set('Authorization', `Bearer ${jwt(m)}`).send({ message: '本人文本', tts: { enabled: true, voice: 'melo' } }).timeout({ deadline: 2500 });
    expect(res.status).toBe(200); expect(res.text).toContain('event: final'); expect(res.text).toContain(text);
    expect(res.text.match(/已降级为纯文本/g)).toHaveLength(1); expect(res.text).not.toContain('/internal/'); expect(synthesize).toHaveBeenCalled();
  });
  it.each(Object.keys(toolInputs))('actual returned %s failure stays safe through ToolRun/audit/Loop when the diagnostic logger throws', async toolId => {
    const m = await fresh(), fault = new Error(secret); pdfFault.value = fault;
    const log = vi.spyOn(m.logger, 'error').mockImplementation(() => { throw new Error('SQL /internal/logger'); });
    const h = await native(m, toolId, fault, { htmlHashFault: toolId === 'template.render' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining(toolId.startsWith('template.') ? 'template render failed' : toolId.startsWith('finance.') ? 'apply voucher allocation failed' : 'relation create failed'), expect.anything());
    const failed = h.runs.find(r => r.status === 'failed'); expect(failed).toBeTruthy(); expect(failed.output.ok).toBe(false);
    if (toolId.startsWith('template.')) expect(failed.output).toEqual({ ok: false, error: '服务器内部错误，请稍后重试。' });
    else expect(failed.output).toMatchObject({ ok: false, error: toolId.startsWith('finance.') ? 'ALLOCATION_FAILED' : 'CREATE_FAILED', message: '服务器内部错误，请稍后重试。' });
    expect(h.events.filter(e => e.payload.phase === 'tool_call_end' && e.payload.status === 'complete')).toEqual([]);
    safeSurfaces(h); expect(h.execute).toHaveBeenCalledTimes(toolId.startsWith('template.') ? 1 : 2);
  });
  it.each(Object.keys(toolInputs))('actual returned %s failure handles real Winston cyclic serialization without changing its original carrier', async toolId => {
    const m = await fresh(), fault = shapes.cycle(); pdfFault.value = fault;
    const h = await native(m, toolId, fault, { htmlHashFault: toolId === 'template.render' });
    const failed = h.runs.find(r => r.status === 'failed'); expect(failed).toBeTruthy();
    if (toolId.startsWith('template.')) expect(failed.output).toEqual({ ok: false, error: '服务器内部错误，请稍后重试。' });
    else expect(failed.output).toMatchObject({ ok: false, error: toolId.startsWith('finance.') ? 'ALLOCATION_FAILED' : 'CREATE_FAILED', message: '服务器内部错误，请稍后重试。' });
    safeSurfaces(h); expect(h.events.filter(e => e.payload.phase === 'tool_call_end' && e.payload.status === 'complete')).toEqual([]);
  });
  it('real registered template render refusal keeps its private copy when diagnostic logging fails', async () => {
    const m = await fresh(); const log = vi.spyOn(m.logger, 'error').mockImplementation(() => { throw new Error('SQL /internal/logger'); });
    const h = await native(m, 'template.render', new Error(secret), { renderFault: true });
    const calls = log.mock.calls as unknown as Array<[string, { error: unknown }]>;
    const caught = calls.find(c => c[0] === '[agent] template render failed')?.[1];
    expect(caught).toBeDefined();
    expect(m.readTemplateRefusal(caught!.error)).toBe('服务器内部错误，请稍后重试。');
    expect(h.runs.find(r => r.status === 'failed').output).toEqual({ ok: false, error: '服务器内部错误，请稍后重试。' }); safeSurfaces(h);
  });
  it('real allocation refusal keeps INVOICE_NOT_FOUND, locks and zero allocation writes before any diagnostic fallback', async () => {
    const m = await fresh(); const log = vi.spyOn(m.logger, 'error').mockImplementation(() => { throw new Error('SQL /internal/logger'); });
    const h = await native(m, 'finance.apply_voucher_to_invoice', undefined, { nativeMissing: true });
    expect(h.runs.find(r => r.status === 'failed').output).toEqual({ ok: false, error: 'INVOICE_NOT_FOUND', message: '发票不存在或已删除，请重新选择来源单据。' });
    expect(h.tx.$queryRawUnsafe.mock.calls.map(c => c[0])).toEqual(['SELECT * FROM "MaterialReturn" WHERE "claimInvoiceId" = $1 AND "deletedAt" IS NULL ORDER BY id', 'SELECT id FROM "Invoice" WHERE id = $1 FOR UPDATE', 'SELECT id FROM "PaymentVoucher" WHERE id = $1 FOR UPDATE']);
    expect(h.db.$transaction).toHaveBeenCalledOnce(); expect(log).not.toHaveBeenCalled(); safeSurfaces(h);
  });
  it('successful template keeps original html and saved RenderedDoc metadata while the error logger is unavailable', async () => {
    const m = await fresh(); const log = vi.spyOn(m.logger, 'error').mockImplementation(() => { throw new Error('SQL /internal/logger'); });
    const h = await native(m, 'template.render', undefined);
    const output = h.runs.find(r => r.status === 'success').output;
    expect(output).toMatchObject({ ok: true, templateId: 'invoice.sample.pdas', schemaVersion: 1, renderedDocId: 'pending' });
    expect(output.html).toContain('own-invoice'); expect(output.sha).toMatch(/^[a-f0-9]{16}$/); expect(output.bytes).toBe(Buffer.byteLength(output.html, 'utf8'));
    expect(h.documents).toHaveLength(1); expect(h.documents[0]).toMatchObject({ templateId: 'invoice.sample.pdas', schemaVersion: 1, inputJson: toolInputs['template.render'].data, htmlSha: output.sha, htmlBytes: output.bytes, source: 'agent' });
    expect(log).not.toHaveBeenCalled();
  });
});
