import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAgentLoop } from '../agentLoop';
import { InMemoryCheckpointManager, type AgentCheckpoint } from '../checkpoint';
import { createIdentityService } from '../identity';
import { createAiRouter } from '../../ai/route';
import { createAiRuntime, type AiEventType } from '../../ai/runtime';
import { createAuthService } from '../../auth/service';
import { approvalEventBus } from '../events';
import { buildOrderConfirmGateError } from '../feedbackContract';
import { isReceiptGuardedCommitTool } from '../toolDispatchRegistry';
import { GENERIC_ROUTE_ERROR_MESSAGE } from '../../shared/routeError';
import '../toolRuntime';

const privateError = 'SQL private table /internal/path';
const tools = [{ id: 'orders.query', name: 'Query', scope: 'orders', risk: 'low' as const, description: 'Query' }];
const plan = JSON.stringify({ thought: '查询', action: 'call_tool', toolCalls: [{ toolId: 'orders.query', input: {} }] });
const final = JSON.stringify({ thought: '结束', action: 'final_answer', finalAnswer: '本轮结束。' });
class ObservedCheckpoint extends InMemoryCheckpointManager {
  saved: AgentCheckpoint[] = [];
  async save(value: AgentCheckpoint) { this.saved.push(value); return super.save(value); }
}
async function operator() {
  return createIdentityService().resolveActorContext({ userId: 'public-failure-operator', roles: ['sales'],
    departmentIds: ['test-sales'], permissions: ['orders:read', 'ai:chat'], authorizationLoaded: true });
}
function jwt(permissions = ['ai:chat']) {
  return createAuthService().signToken({ userId: 'public-failure-operator', roles: ['sales'],
    departmentIds: ['test-sales'], permissions, authorizationLoaded: true });
}
async function runDirect(options: { fault?: unknown; output?: unknown; checkpoint?: ObservedCheckpoint; seed?: AgentCheckpoint;
  toolId?: string; resolver?: () => Promise<any>; approved?: boolean; llmFault?: boolean; message?: string; timeout?: boolean } = {}) {
  const toolId = options.toolId ?? 'orders.query';
  const events: any[] = [];
  const checkpoint = options.checkpoint ?? new ObservedCheckpoint();
  if (options.seed) await checkpoint.save(options.seed);
  const llm = options.llmFault ? vi.fn(async () => { throw options.fault; }) : vi.fn()
    .mockResolvedValueOnce(JSON.stringify({ thought: '查询', action: 'call_tool', toolCalls: [{ toolId, input: {} }] }))
    .mockResolvedValue(final);
  const execute = vi.fn(async (input: any) => {
    if (options.approved && !input.skipApprovalCheck) return { approvalRequired: true, approvalId: 'original-approval', risk: 'high' };
    if (options.timeout) return new Promise((_resolve, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }));
    if (options.output !== undefined) return options.output;
    throw options.fault;
  });
  const loop = createAgentLoop({ llm, toolExecutor: execute, availableTools: [{ ...tools[0], id: toolId }], checkpointManager: checkpoint,
    approvalResolver: options.resolver ?? (async () => ({ status: 'approved' })), canResumeApprovalTool: isReceiptGuardedCommitTool });
  const result = await loop.run({ actor: await operator(), conversationId: 'own-bound-checkpoint', message: options.message ?? '查订单',
    history: [], attachmentContext: [], signal: new AbortController().signal, emit: (type, payload) => events.push({ type, payload }),
    config: { maxSteps: 2, llmRepairRetries: 0, perToolTimeoutMs: options.timeout ? 5 : 5000 } });
  return { result, events, execute, llm, checkpoint };
}
function pendingCheckpoint(): AgentCheckpoint {
  return { id: 'original-point', conversationId: 'own-bound-checkpoint', step: 1, message: '查订单',
    scratchpad: { thoughts: [], toolCalls: [] }, iterations: [],
    pendingApproval: { approvalId: 'original-approval', step: 1, toolId: 'order.confirm', toolInput: {}, suspendedAt: '2026-10-03T00:00:00.000Z' },
    createdAt: '2026-10-03T00:00:00.000Z' };
}

describe('actual Agent public failure boundary', () => {
  it('ordinary tool fault stays safe through actual Loop, observation, checkpoint, events and HTTP SSE', async () => {
    const checkpoint = new ObservedCheckpoint();
    const llm = vi.fn().mockResolvedValueOnce(plan).mockResolvedValue(final);
    const execute = vi.fn(async () => { throw new Error(privateError); });
    const loop = createAgentLoop({ llm, toolExecutor: execute, availableTools: tools, checkpointManager: checkpoint });
    let result: Awaited<ReturnType<typeof loop.run>> | undefined;
    const runtime = createAiRuntime({ chatRunner: async input => {
      result = await loop.run({ actor: await operator(), conversationId: 'own-bound-checkpoint',
        message: input.message, history: [], attachmentContext: [], signal: input.signal, emit: (type, payload) => input.emit(type as AiEventType, payload),
        config: { maxSteps: 2, llmRepairRetries: 0 } });
      return { text: result.text, thoughtProcess: result.thoughtProcess, sources: result.sources, stopReason: result.stopReason };
    } });
    const app = express(); app.use(express.json());
    app.use('/api/ai', createAiRouter({ runtime, requireAuth: true, apiKeys: new Set() }));
    const response = await request(app).post('/api/ai/chat').set('Authorization', `Bearer ${jwt()}`).send({ message: '查订单' });
    expect(response.status).toBe(200);
    expect(response.text).toContain('event: agent_event');
    expect(response.text).toContain('event: block_start');
    expect(response.text).toContain('event: final');
    expect(response.text).toContain('"status":"failed"');
    expect(execute).toHaveBeenCalledOnce();
    expect(result?.stopReason).toBe('final_answer');
    expect(checkpoint.saved).toHaveLength(1);
    expect(checkpoint.saved[0].message).toBe('查订单');
    for (const surface of [response.text, JSON.stringify(result), JSON.stringify(checkpoint.saved), JSON.stringify(llm.mock.calls)]) {
      expect(surface).not.toContain(privateError);
      expect(surface).not.toContain('/internal/path');
    }
  });
  it.each([
    ['known code-only', () => Object.assign(new Error(privateError), { code: 'FORBIDDEN' })],
    ['shared business shape', () => Object.assign(new Error(privateError), { code: 'FORBIDDEN', statusCode: 403, details: [privateError] })],
    ['typed-name impersonation', () => Object.assign(new Error(privateError), { name: 'CreditExceptionConsumptionError', code: 'CREDIT_BLOCKED' })],
    ['legacy commit keyword', () => new Error(`${privateError} STATUS_DRIFT`) ],
    ['timeout token impersonation', () => new Error(`TOOL_TIMEOUT: 5ms ${privateError}`)],
    ['plain object', () => ({ message: privateError, cause: privateError, stack: privateError })],
    ['plain string', () => privateError],
    ['null', () => null],
  ])('unknown %s cannot copy text or details into any Loop public surface', async (_name, fault) => {
    const h = await runDirect({ fault: fault() });
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.result.stopReason).toBe('final_answer');
    expect(h.events.find(e => e.payload.phase === 'tool_call_end').payload.status).toBe('failed');
    expect(h.result.iterations[0].toolCalls[0].error).toBe(GENERIC_ROUTE_ERROR_MESSAGE);
    for (const surface of [h.result, h.events, h.checkpoint.saved, h.llm.mock.calls]) expect(JSON.stringify(surface)).not.toContain('/internal/path');
  });
  it('actual LLM fault has safe event metadata and final thoughtProcess', async () => {
    const h = await runDirect({ fault: new Error(privateError), llmFault: true });
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.result.stopReason).toBe('llm_failure');
    expect(h.events.find(e => e.payload.phase === 'error').payload.metadata.error.code).toBe('llm_failure');
    expect(JSON.stringify([h.result, h.events])).not.toContain('/internal/path');
  });
  it('approved ordinary executor fault preserves pending journal and outcome_unknown without raw feedback', async () => {
    const h = await runDirect({ fault: new Error(privateError), approved: true, toolId: 'order.confirm' });
    expect(h.execute).toHaveBeenCalledTimes(2);
    expect(h.execute.mock.calls[1][0]).toMatchObject({ skipApprovalCheck: true, approvalId: 'original-approval' });
    expect(h.result.stopReason).toBe('outcome_unknown');
    expect((await h.checkpoint.load('own-bound-checkpoint'))?.pendingApproval?.approvalId).toBe('original-approval');
    const failed = h.events.find(e => e.payload.phase === 'tool_call_end' && e.payload.status === 'failed');
    expect(failed.payload.metadata.errorPreview.code).toBe('UNKNOWN_ERROR');
    expect(JSON.stringify([h.result, h.events, h.checkpoint.saved])).not.toContain('/internal/path');
  });
  it('resume executor ordinary fault cannot leak its record or erase the original pending point', async () => {
    const h = await runDirect({ seed: pendingCheckpoint(), toolId: 'order.confirm', fault: new Error(privateError) });
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.llm).not.toHaveBeenCalled();
    expect(h.result.stopReason).toBe('outcome_unknown');
    expect((await h.checkpoint.load('own-bound-checkpoint'))?.pendingApproval?.approvalId).toBe('original-approval');
    expect(JSON.stringify([h.result, h.events])).not.toContain('/internal/path');
  });
  it('old checkpoint failure string is projected safely without mutating the stored original', async () => {
    const seed = { ...pendingCheckpoint(), pendingApproval: null, scratchpad: { thoughts: [], toolCalls: [
      { callId: 'old', step: 1, toolId: 'orders.query', input: {}, ok: false, error: privateError, durationMs: 1 },
    ] } };
    const h = await runDirect({ seed, output: { ok: true } });
    expect(seed.scratchpad.toolCalls[0].error).toBe(privateError);
    expect(JSON.stringify([h.result, h.events, h.llm.mock.calls])).not.toContain('/internal/path');
  });
  it('actual approval-state read fault keeps its own safe token and starts no tool', async () => {
    const h = await runDirect({ seed: pendingCheckpoint(), resolver: async () => { throw new Error(privateError); } });
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.result.text).toContain('APPROVAL_STATE_UNAVAILABLE');
    expect(h.result.stopReason).toBe('recovery_required');
    expect((await h.checkpoint.load('own-bound-checkpoint'))?.pendingApproval?.approvalId).toBe('original-approval');
    expect(JSON.stringify([h.result, h.events])).not.toContain('/internal/path');
  });
  it('actual own timeout token and AbortSignal remain meaningful without trusting an ordinary same-name Error', async () => {
    const h = await runDirect({ timeout: true });
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.execute.mock.calls[0][0].signal.reason.message).toBe('TOOL_TIMEOUT: 5ms');
    expect(h.result.iterations[0].toolCalls[0].error).toBe('TOOL_TIMEOUT: 5ms');
    expect(JSON.stringify(h.events)).toContain('TOOL_TIMEOUT: 5ms');
  });
  it('native gate refusal preserves all structured business fields and never becomes a success event', async () => {
    const native = buildOrderConfirmGateError({ gateCode: 'MOQ_VIOLATION', userMessage: '数量低于已登记门槛。', approvalRequestId: 'original-exception' });
    const output = { ok: false, errorFeedback: { ...native, retryable: false } };
    const h = await runDirect({ toolId: 'order.confirm', approved: true, output });
    expect(h.result.stopReason).toBe('recovery_required');
    expect(h.execute).toHaveBeenCalledTimes(2);
    const failed = h.events.find(e => e.payload.phase === 'tool_call_end' && e.payload.status === 'failed');
    expect(failed.payload.metadata.errorPreview).toEqual(output.errorFeedback);
    expect(h.events.filter(e => e.payload.phase === 'tool_call_end' && e.payload.status === 'complete')).toEqual([]);
    expect((await h.checkpoint.load('own-bound-checkpoint'))?.pendingApproval?.approvalId).toBe('original-approval');
  });
  it('ordinary business row with failed status is still a successful tool output', async () => {
    const output = { id: 'business-row', status: 'failed', comment: '原业务字段' };
    const h = await runDirect({ output });
    expect(h.result.iterations[0].toolCalls[0]).toMatchObject({ ok: true, output });
    expect(h.result.stopReason).toBe('final_answer');
  });
  it('actual current human rejection note and original user text are preserved even when they mention SQL', async () => {
    const note = '用户原话 SQL /user/path';
    const h = await runDirect({ approved: true, toolId: 'order.confirm', message: note,
      resolver: async () => ({ status: 'rejected', decisionNote: note }) });
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.result.iterations[0].toolCalls[0].error).toContain(note);
    expect(h.result.thoughtProcess).toContain(note);
    expect(h.checkpoint.saved.map(v => v.message)).toEqual([note, note, note]);
  });
});
