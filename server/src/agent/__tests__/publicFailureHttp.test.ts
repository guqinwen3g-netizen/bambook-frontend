import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAgentRouter } from '../route';
import { createAiRouter } from '../../ai/route';
import { createAiRuntime } from '../../ai/runtime';
import { createAuthService } from '../../auth/service';
import { createIdentityService } from '../identity';
import { createAgentLoop } from '../agentLoop';
import { executeAgentTool, runAgentToolCalls } from '../toolRuntime';
import { refreshToolActor } from '../../ai/refreshToolActor';
import { buildOrderConfirmGateError } from '../feedbackContract';
import { resetMeloCircuitForTesting } from '../../ai/tts';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetMeloCircuitForTesting(); });

const secretText = 'SQL private table /internal/path';
const userId = 'public-failure-operator';
function token(permissions = ['ai:chat', 'relations:read']) {
  return createAuthService().signToken({ userId, roles: ['sales'], departmentIds: ['test-sales'], permissions, authorizationLoaded: true });
}
function storage(scopes = ['ai:chat', 'relations:read']) {
  let session: any = { id: 'own-session', userId, title: '查询', metadata: {}, deletedAt: null };
  const runs: any[] = []; const audits: any[] = []; const sessionWrites: any[] = [];
  const account = { id: userId, status: 'active', deletedAt: null, primaryDeptId: 'test-sales',
    primaryDepartment: { id: 'test-sales', status: 'active', name: '合成团队' },
    roles: [{ roleId: 'role-sales', departmentId: 'test-sales', role: { id: 'role-sales',
      permissions: scopes.map(scope => ({ permission: { scope } })) } }] };
  const db = {
    userAccount: { findFirst: vi.fn(async (args: any) => args.select?.id ? { id: userId } : account), findMany: vi.fn(async () => []) },
    userPermissionOverrides: { findMany: vi.fn(async () => []) },
    agentSession: { findFirst: vi.fn(async () => session), findMany: vi.fn(async (_args: any) => []),
      create: vi.fn(async (args: any) => (session = { ...args.data })),
      update: vi.fn(async (args: any) => { session = { ...session, ...args.data }; sessionWrites.push(structuredClone(args)); return session; }) },
    agentMessage: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})) },
    agentTool: { upsert: vi.fn(async () => ({})) },
    agentToolRun: { create: vi.fn(async (args: any) => { runs.push(args.data); return args.data; }),
      findUnique: vi.fn(async (args: any) => runs.find(row => row.id === args.where.id) ?? null) },
    auditLog: { create: vi.fn(async (args: any) => { audits.push(args.data); return args.data; }) },
    relation: { findMany: vi.fn(async () => { throw new Error(secretText); }), count: vi.fn(async () => 0) },
    agentMemory: { findMany: vi.fn(async (_args: any) => { throw new Error(secretText); }) },
    approvalRequest: { findUnique: vi.fn(async () => null) },
  };
  return { db, account, runs, audits, sessionWrites };
}
function agentApp(db: any) {
  const app = express(); app.use(express.json());
  app.use('/api/agent', createAgentRouter({ prisma: db, requireAuth: true, apiKeys: new Set(), getRuntimeMetrics: () => ({}), dataSource: {} as any }));
  return app;
}
async function currentActor(db: any) {
  const prior = await createIdentityService().resolveActorContext({ userId, roles: ['sales'], departmentIds: ['test-sales'],
    permissions: ['ai:chat', 'relations:read'], authorizationLoaded: true });
  return refreshToolActor(db, prior, { userId, requestSource: 'user-session' });
}

describe('actual Agent HTTP and public persisted failure boundary', () => {
  it.each(['ordinary', 'code/status impersonation'])('outer chat %s fault is safe in actual SSE and original runtime failure metadata', async shape => {
    const h = storage(); const fault = new Error(secretText);
    if (shape !== 'ordinary') Object.assign(fault, { code: 'FORBIDDEN', statusCode: 403, details: secretText });
    const runner = vi.fn(async () => { throw fault; });
    const runtime = createAiRuntime({ chatRunner: runner });
    const app = express(); app.use(express.json());
    app.use('/api/ai', createAiRouter({ runtime, prisma: h.db as any, requireAuth: true, apiKeys: new Set() }));
    const res = await request(app).post('/api/ai/chat').set('Authorization', `Bearer ${token()}`).send({ sessionId: 'own-session', message: '查询' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('event: error');
    expect(res.text).toContain('"ok":false');
    expect(res.text).not.toContain('event: final');
    expect(res.text).not.toContain('/internal/path');
    expect(runner).toHaveBeenCalledOnce();
    const failed = h.sessionWrites.map(v => v.data.metadata?.agentRuntime?.currentRun).find(v => v?.status === 'failed');
    expect(failed?.error).toEqual(expect.any(String));
    expect(JSON.stringify(h.sessionWrites)).not.toContain('/internal/path');
  });
  it.each(['ordinary', 'code/status impersonation'])('actual Agent router %s fault retains its HTTP500 envelope without raw message', async shape => {
    const h = storage(); const fault = new Error(secretText);
    if (shape !== 'ordinary') Object.assign(fault, { code: 'FORBIDDEN', statusCode: 403 });
    h.db.agentSession.findMany.mockRejectedValue(fault);
    const res = await request(agentApp(h.db)).get('/api/agent/sessions').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ ok: false, error: 'AGENT_ROUTE_FAILED' });
    expect(res.body.message).toEqual(expect.any(String));
    expect(JSON.stringify(res.body)).not.toContain('/internal/path');
    expect(h.db.agentSession.findMany.mock.calls[0][0].where).toMatchObject({ userId, deletedAt: null });
  });
  it('legacy failed ToolRun string is safe on HTTP read while original native output and human decision note remain', async () => {
    const h = storage();
    const output = { ok: false, errorFeedback: buildOrderConfirmGateError({ gateCode: 'MOQ_VIOLATION', userMessage: '数量不够。', approvalRequestId: 'exception-original' }) };
    h.runs.push({ id: 'legacy-run', toolId: 'order.confirm', userId, status: 'failed', output, error: secretText,
      approvalId: 'approval-original', input: { poNumber: 'PO-ORIGINAL' }, startedAt: new Date('2026-10-03T00:00:00Z'), completedAt: null });
    const note = '人类原话 SQL /user/path';
    h.db.approvalRequest.findUnique.mockResolvedValue({ id: 'approval-original', status: 'rejected', decisionNote: note } as any);
    const res = await request(agentApp(h.db)).get('/api/agent/tool-runs/legacy-run').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200); expect(res.body.toolRun.status).toBe('failed');
    expect(res.body.toolRun.output).toEqual(output);
    expect(res.body.toolRun.approval.decisionNote).toBe(note);
    expect(JSON.stringify(res.body)).not.toContain('/internal/path');
    expect(h.runs[0].error).toBe(secretText);
    expect(h.db.agentToolRun.create).not.toHaveBeenCalled();
  });
  it.each(['memory-specialized', 'ordinary-runtime', 'legacy-runtime'])('actual %s catch stores only a safe public ToolRun/audit error and HTTP read stays safe', async branch => {
    const h = storage(); const actor = await currentActor(h.db);
    const toolId = branch === 'ordinary-runtime' ? 'relations.query' : 'memory.recall';
    const promise = branch === 'legacy-runtime'
      ? runAgentToolCalls({ prisma: h.db as any, actor, calls: [{ toolId, input: {}, reason: '原只读查询' }] })
      : executeAgentTool({ prisma: h.db as any, actor, toolId, toolInput: {}, actorUserId: userId, requestSource: 'user-session' });
    await expect(promise).rejects.toThrow(secretText);
    expect(h.runs).toHaveLength(1); expect(h.audits).toHaveLength(1);
    expect(h.runs[0].status).toBe('failed'); expect(h.runs[0].actorId).toBe(userId);
    expect(JSON.stringify([h.runs, h.audits])).not.toContain('/internal/path');
    const res = await request(agentApp(h.db)).get(`/api/agent/tool-runs/${h.runs[0].id}`).set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200); expect(res.body.toolRun.status).toBe('failed');
    expect(JSON.stringify(res.body)).not.toContain('/internal/path');
    if (toolId === 'memory.recall') {
      expect(h.db.agentMemory.findMany).toHaveBeenCalledOnce();
      expect(h.db.agentMemory.findMany.mock.calls[0][0].where.scope.in).toContain(`personal:${userId}`);
    } else expect(h.db.relation.findMany).toHaveBeenCalledOnce();
  });
  it.each(['revoked', 'storage unknown', 'API-key ceiling'])('actual current %s cannot execute the originally permitted tool or publish storage text', async cause => {
    const h = storage(cause === 'revoked' ? [] : ['relations:read']);
    const prior = await createIdentityService().resolveActorContext({ userId, roles: ['sales'], permissions: ['relations:read'], authorizationLoaded: true });
    if (cause === 'storage unknown') h.db.userAccount.findFirst.mockRejectedValue(new Error(secretText));
    const seen: any[] = [];
    const tool = vi.fn(async (input: any) => {
      const actor = await refreshToolActor(h.db as any, prior, { userId, requestSource: cause === 'API-key ceiling' ? 'api-key' : 'user-session', permissionCeiling: [] });
      seen.push(actor);
      return executeAgentTool({ prisma: h.db as any, actor, toolId: input.toolId, toolInput: {}, actorUserId: userId });
    });
    const llm = vi.fn().mockResolvedValueOnce(JSON.stringify({ thought: '查询', action: 'call_tool', toolCalls: [{ toolId: 'relations.search', input: {} }] }))
      .mockResolvedValue(JSON.stringify({ thought: '结束', action: 'final_answer', finalAnswer: '查询未完成。' }));
    const events: any[] = [];
    const loop = createAgentLoop({ llm, toolExecutor: tool, availableTools: [{ id: 'relations.search', name: 'Search', scope: 'relations', risk: 'low', description: 'Read' }] });
    const result = await loop.run({ actor: prior, message: '查关系', history: [], attachmentContext: [], signal: new AbortController().signal,
      emit: (type, payload) => events.push({ type, payload }), config: { maxSteps: 2, llmRepairRetries: 0 } });
    expect(tool).toHaveBeenCalledOnce(); expect(h.db.relation.findMany).not.toHaveBeenCalled();
    expect(result.iterations[0].toolCalls[0].ok).toBe(false);
    expect(JSON.stringify([result, events])).not.toContain('/internal/path');
    if (cause !== 'storage unknown') { expect(seen[0].permissionScopes).toEqual([]); expect(seen[0].permissionsAuthoritative).toBe(true); }
    else expect(h.runs).toHaveLength(0);
  });
  it('actual JWT scope denial and anonymous HTTP contracts stop before any runner or data delegate', async () => {
    const h = storage(); const runner = vi.fn(async () => ({ text: 'unused' }));
    const app = express(); app.use(express.json());
    app.use('/api/ai', createAiRouter({ runtime: createAiRuntime({ chatRunner: runner }), prisma: h.db as any, requireAuth: true, apiKeys: new Set() }));
    expect((await request(app).post('/api/ai/chat').send({ message: '查询' })).status).toBe(401);
    expect((await request(app).post('/api/ai/chat').set('Authorization', `Bearer ${token([])}`).send({ message: '查询' })).status).toBe(403);
    expect(runner).not.toHaveBeenCalled(); expect(h.db.userAccount.findFirst).not.toHaveBeenCalled();
    expect(h.sessionWrites).toHaveLength(0);
    expect((await request(agentApp(h.db)).get('/api/agent/tool-runs/unknown')).status).toBe(401);
    expect(h.db.agentToolRun.findUnique).not.toHaveBeenCalled();
  });
  it.each(['ordinary', 'code/status impersonation'])('actual chat TTS %s synthesis fault produces a safe step and keeps the successful text stream', async shape => {
    const fault = new Error(secretText); if (shape !== 'ordinary') Object.assign(fault, { code: 'FORBIDDEN', statusCode: 403 });
    const synthesize = vi.fn(async () => { throw fault; });
    const text = '原成功回答，不擦除。';
    const runtime = createAiRuntime({ chatRunner: async input => { input.emit('delta', { text }); return { text }; } });
    const app = express(); app.use(express.json());
    app.use('/api/ai', createAiRouter({ runtime, requireAuth: true, apiKeys: new Set(), ttsSynthesizer: synthesize }));
    const res = await request(app).post('/api/ai/chat').set('Authorization', `Bearer ${token()}`)
      .send({ message: '说出来', tts: { enabled: true, voice: 'melo' } });
    expect(res.status).toBe(200); expect(synthesize).toHaveBeenCalled();
    expect(res.text).toContain('event: step'); expect(res.text).toContain('已降级为纯文本');
    expect(res.text).toContain('event: final'); expect(res.text).toContain(text);
    expect(res.text).not.toContain('/internal/path');
  });
  it.each(['ordinary', 'code/status impersonation'])('actual TTS speech %s network-boundary fault retains HTTP502/TTS_FAILED with safe public message', async shape => {
    resetMeloCircuitForTesting(); vi.stubEnv('BAMBOOK_MELO_URL', 'http://127.0.0.1:9/synthetic-unused');
    const fault = new Error(secretText); if (shape !== 'ordinary') Object.assign(fault, { code: 'FORBIDDEN', statusCode: 403 });
    const fetchSeam = vi.fn(async (_url: unknown, _init?: RequestInit) => { throw fault; }); vi.stubGlobal('fetch', fetchSeam);
    const app = express(); app.use(express.json());
    app.use('/api/ai', createAiRouter({ runtime: createAiRuntime({ chatRunner: async () => ({ text: 'unused' }) }), requireAuth: true, apiKeys: new Set() }));
    const res = await request(app).post('/api/ai/tts/speech').set('Authorization', `Bearer ${token()}`).send({ input: '原始输入', provider: 'melo' });
    expect(fetchSeam).toHaveBeenCalledOnce();
    expect(res.status).toBe(502); expect(res.body).toMatchObject({ ok: false, error: 'TTS_FAILED' });
    expect(JSON.stringify(res.body)).not.toContain('/internal/path');
    expect(JSON.parse(fetchSeam.mock.calls[0][1]!.body as string).input).toBe('原始输入');
  });
  it('actual unconfigured TTS keeps the original fixed HTTP503/TTS_NOT_CONFIGURED response', async () => {
    resetMeloCircuitForTesting(); vi.stubEnv('BAMBOOK_MELO_URL', '');
    const app = express(); app.use(express.json());
    app.use('/api/ai', createAiRouter({ runtime: createAiRuntime({ chatRunner: async () => ({ text: 'unused' }) }), requireAuth: true, apiKeys: new Set() }));
    const res = await request(app).post('/api/ai/tts/speech').set('Authorization', `Bearer ${token()}`).send({ input: '原始输入', provider: 'melo' });
    expect(res.status).toBe(503); expect(res.body).toEqual({ ok: false, error: 'TTS_NOT_CONFIGURED', message: 'TTS 服务未配置（BAMBOOK_MELO_URL 缺失）' });
  });
  it('actual TTS circuit after a network fault keeps fixed HTTP503/TTS_UNAVAILABLE without its stored driver text', async () => {
    resetMeloCircuitForTesting(); vi.stubEnv('BAMBOOK_MELO_URL', 'http://127.0.0.1:9/synthetic-unused');
    const fetchSeam = vi.fn(async () => { throw new Error(secretText); }); vi.stubGlobal('fetch', fetchSeam);
    const app = express(); app.use(express.json());
    app.use('/api/ai', createAiRouter({ runtime: createAiRuntime({ chatRunner: async () => ({ text: 'unused' }) }), requireAuth: true, apiKeys: new Set() }));
    await request(app).post('/api/ai/tts/speech').set('Authorization', `Bearer ${token()}`).send({ input: '原始输入', provider: 'melo' });
    const res = await request(app).post('/api/ai/tts/speech').set('Authorization', `Bearer ${token()}`).send({ input: '原始输入', provider: 'melo' });
    expect(fetchSeam).toHaveBeenCalledOnce();
    expect(res.status).toBe(503); expect(res.body).toEqual({ ok: false, error: 'TTS_UNAVAILABLE', message: 'TTS 服务暂不可用（熔断冷却中），请稍后重试' });
    expect(JSON.stringify(res.body)).not.toContain('/internal/path');
  });
});
