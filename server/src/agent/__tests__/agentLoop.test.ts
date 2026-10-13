import { describe, expect, it, vi } from 'vitest';
import { createAgentLoop } from '../agentLoop';
import { createIdentityService } from '../identity';
import { ToolDescriptor } from '../agentLoopTypes';

// ─────────────────────────── 测试夹具 ───────────────────────────

const TEST_TOOLS: ToolDescriptor[] = [
  {
    id: 'orders.query',
    name: 'Query Orders',
    scope: 'orders',
    risk: 'low',
    description: '按字段筛选/排序/分页查询订单',
    inputHint: '{ query?: string, limit?: number, sort?: object }',
  },
  {
    id: 'relations.get',
    name: 'Get Relation',
    scope: 'relations',
    risk: 'low',
    description: '按 id/name 读取单条关系档案',
    inputHint: '{ id?: string, name?: string }',
  },
  {
    id: 'products.query',
    name: 'Query Products',
    scope: 'products',
    risk: 'low',
    description: '按筛选条件查询数字档案',
    inputHint: '{ query?: string, limit?: number }',
  },
];

async function ownerActor() {
  return createIdentityService().resolveActorContext({
    userId: 'test-owner',
    displayName: 'Tester',
    roles: ['owner'],
    departmentIds: ['company'],
  });
}

/**
 * 创建一个"按预定脚本输出"的 LLM stub。
 * scripts 是一个数组，每次调用按顺序消费一项；超过数组长度则用 fallback。
 */
function scriptedLLM(scripts: string[], fallback?: string) {
  let i = 0;
  return vi.fn(async () => {
    if (i < scripts.length) return scripts[i++];
    if (fallback != null) return fallback;
    throw new Error('LLM_STUB_EXHAUSTED');
  });
}

function emitCollector() {
  const events: Array<{ type: string; payload: any }> = [];
  return {
    events,
    emit: (type: string, payload: any) => events.push({ type, payload }),
  };
}

const baseInput = async (overrides: Partial<Parameters<ReturnType<typeof createAgentLoop>['run']>[0]> = {}) => ({
  actor: await ownerActor(),
  message: '帮我查一下最近 3 个订单',
  history: [],
  attachmentContext: [],
  signal: new AbortController().signal,
  ...overrides,
});

// ─────────────────────────── 用例 ───────────────────────────

describe('agentLoop', () => {
  it('用例 1：单步直接 final_answer，不调任何工具', async () => {
    const llm = scriptedLLM([
      JSON.stringify({
        thought: '问题很简单，无需查工具',
        action: 'final_answer',
        finalAnswer: '这是直接回答。',
      }),
    ]);
    const toolExecutor = vi.fn();

    const loop = createAgentLoop({ llm, toolExecutor, availableTools: TEST_TOOLS });
    const collector = emitCollector();
    const result = await loop.run(await baseInput({ emit: collector.emit }));

    expect(result.text).toBe('这是直接回答。');
    expect(result.stopReason).toBe('final_answer');
    expect(result.iterations).toHaveLength(1);
    expect(result.iterations[0].action).toBe('final_answer');
    expect(toolExecutor).not.toHaveBeenCalled();
    expect(llm).toHaveBeenCalledTimes(1);

    const phases = collector.events.map(e => e.payload?.phase);
    expect(phases).toContain('iteration_start');
    expect(phases).toContain('thought');
    expect(phases).toContain('final_answer');
    expect(phases).not.toContain('plan');
  });

  it('用例 2：先调 1 个工具，再 final_answer', async () => {
    const llm = scriptedLLM([
      JSON.stringify({
        thought: '需要查订单',
        action: 'call_tool',
        toolCalls: [{ toolId: 'orders.query', input: { limit: 3 }, why: '拉最近订单' }],
      }),
      JSON.stringify({
        thought: '已拿到 3 条订单，可以回答',
        action: 'final_answer',
        finalAnswer: '最近 3 个订单是 PO-A / PO-B / PO-C。',
      }),
    ]);
    const toolExecutor = vi.fn(async () => ({
      total: 3,
      count: 3,
      items: [{ id: 'PO-A' }, { id: 'PO-B' }, { id: 'PO-C' }],
    }));

    const loop = createAgentLoop({ llm, toolExecutor, availableTools: TEST_TOOLS });
    const collector = emitCollector();
    const result = await loop.run(await baseInput({ emit: collector.emit }));

    expect(result.stopReason).toBe('final_answer');
    expect(result.text).toContain('PO-A');
    expect(result.iterations).toHaveLength(2);
    expect(result.iterations[0].toolCalls).toHaveLength(1);
    expect(result.iterations[0].toolCalls[0].ok).toBe(true);
    expect(toolExecutor).toHaveBeenCalledTimes(1);
    expect(toolExecutor).toHaveBeenCalledWith(expect.objectContaining({
      toolId: 'orders.query',
      input: { limit: 3 },
    }));

    const phases = collector.events.map(e => e.payload?.phase);
    expect(phases.filter(p => p === 'tool_call_start')).toHaveLength(1);
    expect(phases.filter(p => p === 'tool_call_end')).toHaveLength(1);
    expect(phases.filter(p => p === 'iteration_end')).toHaveLength(2);
  });

  it('用例 3：单步 LLM 申请 2 个并发工具，按顺序执行', async () => {
    const llm = scriptedLLM([
      JSON.stringify({
        thought: '同时查订单和关系',
        action: 'call_tool',
        toolCalls: [
          { toolId: 'orders.query', input: { limit: 3 } },
          { toolId: 'relations.get', input: { id: 'rel_x' } },
        ],
      }),
      JSON.stringify({
        thought: '完成',
        action: 'final_answer',
        finalAnswer: '已完成两个查询。',
      }),
    ]);
    const callOrder: string[] = [];
    const toolExecutor = vi.fn(async ({ toolId }: { toolId: string }) => {
      callOrder.push(toolId);
      return { ok: true };
    });

    const loop = createAgentLoop({ llm, toolExecutor, availableTools: TEST_TOOLS });
    const result = await loop.run(await baseInput());

    expect(result.stopReason).toBe('final_answer');
    expect(callOrder).toEqual(['orders.query', 'relations.get']);
    expect(result.iterations[0].toolCalls).toHaveLength(2);
  });

  it('用例 4：工具调用超时被捕获，循环不崩，进入下一步', async () => {
    const llm = scriptedLLM([
      JSON.stringify({
        thought: '试一下',
        action: 'call_tool',
        toolCalls: [{ toolId: 'orders.query', input: {} }],
      }),
      JSON.stringify({
        thought: '工具超时了，无法回答',
        action: 'final_answer',
        finalAnswer: '工具超时，未能查到订单。',
      }),
    ]);
    // toolExecutor 返回一个永不 resolve 的 Promise，依赖 perToolTimeoutMs 触发
    const toolExecutor = vi.fn(() => new Promise(() => undefined));

    const loop = createAgentLoop({ llm, toolExecutor, availableTools: TEST_TOOLS });
    const collector = emitCollector();
    const result = await loop.run(await baseInput({
      emit: collector.emit,
      config: { perToolTimeoutMs: 50, totalBudgetMs: 5_000, maxSteps: 4, maxToolsPerStep: 3, llmRepairRetries: 0 },
    }));

    expect(result.stopReason).toBe('final_answer');
    const failedToolEvent = collector.events.find(
      e => e.payload?.phase === 'tool_call_end' && e.payload?.status === 'failed',
    );
    expect(failedToolEvent).toBeDefined();
    expect(String(failedToolEvent!.payload.metadata?.error?.message || '')).toMatch(/TOOL_TIMEOUT/);
  });

  it('用例 4b：工具超时时会取消传给工具的执行信号', async () => {
    const llm = scriptedLLM([
      JSON.stringify({
        thought: '查询订单',
        action: 'call_tool',
        toolCalls: [{ toolId: 'orders.query', input: {} }],
      }),
      JSON.stringify({
        thought: '工具超时，结束回答',
        action: 'final_answer',
        finalAnswer: '工具超时，未能查到订单。',
      }),
    ]);
    let toolSignal: AbortSignal | undefined;
    const toolExecutor = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise(() => {
      toolSignal = signal;
    }));

    const loop = createAgentLoop({ llm, toolExecutor, availableTools: TEST_TOOLS });
    const result = await loop.run(await baseInput({
      config: { perToolTimeoutMs: 20, totalBudgetMs: 5_000, maxSteps: 4, maxToolsPerStep: 3, llmRepairRetries: 0 },
    }));

    expect(result.stopReason).toBe('final_answer');
    expect(toolSignal).toBeDefined();
    expect(toolSignal!.aborted).toBe(true);
    expect(String(toolSignal!.reason)).toMatch(/TOOL_TIMEOUT/);
  });

  it('用例 5：LLM 第一次输出非法 JSON，第二次修复成功', async () => {
    const llm = scriptedLLM([
      'this is not json at all',
      JSON.stringify({
        thought: '已修复',
        action: 'final_answer',
        finalAnswer: '修复后的回答。',
      }),
    ]);
    const toolExecutor = vi.fn();

    const loop = createAgentLoop({ llm, toolExecutor, availableTools: TEST_TOOLS });
    const result = await loop.run(await baseInput({
      config: { llmRepairRetries: 1, maxSteps: 4, maxToolsPerStep: 3, perToolTimeoutMs: 30_000, totalBudgetMs: 90_000 },
    }));

    expect(result.stopReason).toBe('final_answer');
    expect(result.text).toBe('修复后的回答。');
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it('用例 6：超 maxSteps 不死循环，强制收尾', async () => {
    // LLM 永远只输出 call_tool（且每次换不同 input 避开去重）
    let counter = 0;
    const llm = vi.fn(async () => {
      counter++;
      return JSON.stringify({
        thought: `step ${counter}`,
        action: 'call_tool',
        toolCalls: [{ toolId: 'orders.query', input: { limit: counter } }],
      });
    });
    const toolExecutor = vi.fn(async () => ({ total: 0, count: 0 }));

    const loop = createAgentLoop({ llm, toolExecutor, availableTools: TEST_TOOLS });
    const result = await loop.run(await baseInput({
      config: { maxSteps: 3, maxToolsPerStep: 3, perToolTimeoutMs: 30_000, totalBudgetMs: 90_000, llmRepairRetries: 0 },
    }));

    // maxSteps=3 → 3 次决策（全是 call_tool）→ 强制收尾再调一次 LLM
    // forceFinalAnswer 没有脚本，会走兜底字符串。
    expect(result.stopReason).toBe('max_steps');
    expect(result.iterations).toHaveLength(3);
    expect(result.text).toBeTruthy();
    expect(toolExecutor).toHaveBeenCalledTimes(3);
  });

  it('用例 7：LLM 申请白名单外的 toolId → 解析失败 → 修复后 final', async () => {
    const llm = scriptedLLM([
      JSON.stringify({
        thought: '试试调一个不存在的工具',
        action: 'call_tool',
        toolCalls: [{ toolId: 'email.send', input: { to: 'x@y.com' } }],
      }),
      JSON.stringify({
        thought: '不能调那个工具，给最终回答',
        action: 'final_answer',
        finalAnswer: '我没有该工具的权限。',
      }),
    ]);
    const toolExecutor = vi.fn();

    const loop = createAgentLoop({ llm, toolExecutor, availableTools: TEST_TOOLS });
    const result = await loop.run(await baseInput({
      config: { llmRepairRetries: 1, maxSteps: 4, maxToolsPerStep: 3, perToolTimeoutMs: 30_000, totalBudgetMs: 90_000 },
    }));

    expect(result.text).toBe('我没有该工具的权限。');
    // email.send 不在 whitelist，validateToolCall 会拒绝 → repair → 第二次成功
    expect(llm).toHaveBeenCalledTimes(2);
    expect(toolExecutor).not.toHaveBeenCalled();
  });

  it('附加：toolExecutor 抛错时记录到 scratchpad，循环继续', async () => {
    const llm = scriptedLLM([
      JSON.stringify({
        thought: '查一下',
        action: 'call_tool',
        toolCalls: [{ toolId: 'orders.query', input: {} }],
      }),
      JSON.stringify({
        thought: '工具失败了，但我已经知道原因',
        action: 'final_answer',
        finalAnswer: '工具失败：DB 超时。',
      }),
    ]);
    const toolExecutor = vi.fn(async () => {
      throw new Error('DB connection lost');
    });

    const loop = createAgentLoop({ llm, toolExecutor, availableTools: TEST_TOOLS });
    const result = await loop.run(await baseInput());

    expect(result.stopReason).toBe('final_answer');
    expect(result.iterations[0].toolCalls[0].ok).toBe(false);
    expect(result.iterations[0].toolCalls[0].error).toContain('DB connection lost');
  });

  it('附加：去重——同一 toolId+input 第二次会被跳过', async () => {
    const llm = scriptedLLM([
      JSON.stringify({
        thought: '查',
        action: 'call_tool',
        toolCalls: [{ toolId: 'orders.query', input: { limit: 3 } }],
      }),
      JSON.stringify({
        thought: '再查同样的',
        action: 'call_tool',
        toolCalls: [{ toolId: 'orders.query', input: { limit: 3 } }],
      }),
      JSON.stringify({
        thought: '已收到去重提示，结束',
        action: 'final_answer',
        finalAnswer: '完成。',
      }),
    ]);
    const toolExecutor = vi.fn(async () => ({ total: 1, count: 1 }));

    const loop = createAgentLoop({ llm, toolExecutor, availableTools: TEST_TOOLS });
    const result = await loop.run(await baseInput());

    expect(toolExecutor).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe('final_answer');
    // 第二步的工具 record 应该是 ok=false 且 error 含 DEDUPED
    const secondStepCalls = result.iterations[1].toolCalls;
    expect(secondStepCalls).toHaveLength(1);
    expect(secondStepCalls[0].ok).toBe(false);
    expect(secondStepCalls[0].error).toContain('DEDUPED');
  });
});

  it('P1-C: 非 order.confirm 工具失败不带 order.confirm 专用 errorPreview/code/userAction', async () => {
    const llm = scriptedLLM([
      JSON.stringify({
        thought: '查询订单',
        action: 'call_tool',
        toolCalls: [{ toolId: 'orders.query', input: { limit: 3 }, why: '拉订单' }],
      }),
      JSON.stringify({
        thought: '工具失败了，告知用户',
        action: 'final_answer',
        finalAnswer: '查询失败。',
      }),
    ]);
    // toolExecutor 永不 resolve，依赖 perToolTimeoutMs 触发超时失败（普通工具路径）
    const toolExecutor = vi.fn(() => new Promise(() => undefined));
    const loop = createAgentLoop({ llm, toolExecutor, availableTools: TEST_TOOLS });
    const collector = emitCollector();
    await loop.run(await baseInput({
      emit: collector.emit,
      config: { perToolTimeoutMs: 50, totalBudgetMs: 5_000, maxSteps: 4, maxToolsPerStep: 3, llmRepairRetries: 0 },
    }));

    const failedEvent = collector.events.find(
      e => e.payload?.phase === 'tool_call_end' && e.payload?.status === 'failed',
    );
    expect(failedEvent).toBeDefined();
    // 非 order.confirm 工具超时：error.code 应为通用 tool_error，不应映射为 order.confirm 专用 STATUS_DRIFT
    expect(String(failedEvent!.payload.metadata?.error?.code || '')).toBe('tool_error');
    // 不应有 errorPreview（order.confirm 专用结构）
    expect(failedEvent!.payload.metadata?.errorPreview).toBeUndefined();
    // 不应有 userAction（order.confirm 专用字段）
    expect((failedEvent!.payload.metadata?.error as any)?.userAction).toBeUndefined();
  });
