import { describe, expect, it, vi } from 'vitest';
import { createAgentLoop } from '../src/agent/agentLoop';
import { createIdentityService } from '../src/agent/identity';
import '../src/agent/toolRuntime';

describe('readonly audit of unknown fault logging before safe projection', () => {
  it('actual Loop returns its safe failure for a cyclic unknown object without an additional logging exception', async () => {
    const fault: any = { message: 'SQL /internal/audit-only' }; fault.self = fault;
    const execute = vi.fn(async () => { throw fault; });
    const llm = vi.fn().mockResolvedValueOnce(JSON.stringify({ thought: '只读诊断', action: 'call_tool', toolCalls: [{ toolId: 'orders.query', input: {} }] }))
      .mockResolvedValue(JSON.stringify({ thought: '结束', action: 'final_answer', finalAnswer: '已结束。' }));
    const loop = createAgentLoop({ llm, toolExecutor: execute, availableTools: [{ id: 'orders.query', name: 'Query', scope: 'orders', risk: 'low', description: '合成诊断' }] });
    const actor = await createIdentityService().resolveActorContext({ userId: 'audit-only-operator', roles: ['sales'], permissions: ['orders:read'], authorizationLoaded: true });
    const promise = loop.run({ actor, message: '只读诊断', history: [], attachmentContext: [], signal: new AbortController().signal, emit: () => undefined,
      config: { maxSteps: 2, llmRepairRetries: 0 } });
    await expect(promise).resolves.toMatchObject({ stopReason: 'final_answer' });
    expect(execute).toHaveBeenCalledOnce();
  });
});
