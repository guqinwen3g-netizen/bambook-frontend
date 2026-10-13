import { describe, it, expect, vi } from 'vitest';
import { createAgentLoop } from '../agentLoop';
import type { ToolDescriptor } from '../agentLoopTypes';

const TEST_TOOLS: ToolDescriptor[] = [
  { id: 'orders.query', name: 'Query Orders', scope: 'orders', risk: 'low',
    description: '查询订单', inputHint: '{ limit?: number }' },
];

async function ownerActor() {
  const { createIdentityService } = await import('../identity');
  return createIdentityService().resolveActorContext({
    userId: 'u1', displayName: '评测用户', roles: ['owner'], departmentIds: ['company'],
  });
}

describe('P0-A 流式 Harness 单测', () => {
  it('聚合：onDelta chunk 聚合后等于完整文本', async () => {
    const chunks = ['{"thought":"查', '订单","action', '":"final_answer","', 'finalAnswer":"最近3个订单"}'];
    const llm = vi.fn(async (input: any) => {
      if (input.onDelta) { for (const c of chunks) input.onDelta(c); }
      return chunks.join('');
    });
    const loop = createAgentLoop({
      llm: llm as any,
      toolExecutor: vi.fn(async () => ({ ok: true })) as any,
      availableTools: TEST_TOOLS,
    });
    const actor = await ownerActor();
    const result = await loop.run({
      actor, message: '查订单', history: [], attachmentContext: [],
      signal: new AbortController().signal,
    });
    expect(result.stopReason).toBe('final_answer');
    expect(result.text).toContain('最近3个订单');
  });

  it('fallback：流式失败时降级到非流式', async () => {
    let callCount = 0;
    const llm = vi.fn(async (input: any) => {
      callCount++;
      if (input.onDelta && callCount === 1) throw new Error('STREAM_FAILED');
      return '{"thought":"fallback","action":"final_answer","finalAnswer":"非流式降级成功"}';
    });
    const loop = createAgentLoop({
      llm: llm as any,
      toolExecutor: vi.fn(async () => ({ ok: true })) as any,
      availableTools: TEST_TOOLS,
    });
    const actor = await ownerActor();
    const result = await loop.run({
      actor, message: '测试', history: [], attachmentContext: [],
      signal: new AbortController().signal,
    });
    expect(result.stopReason).toBe('final_answer');
    expect(result.text).toContain('非流式降级成功');
  });

  it('seq 顺序：delta 事件 seq 单调递增', async () => {
    const llm = vi.fn(async (input: any) => {
      if (input.onDelta) {
        input.onDelta('{"thought":"思考');
        input.onDelta('中","action":"final_answer","finalAnswer":"回答"}');
      }
      return '{"thought":"思考中","action":"final_answer","finalAnswer":"回答"}';
    });
    const events: Array<{ phase: string; seq?: number }> = [];
    const loop = createAgentLoop({
      llm: llm as any,
      toolExecutor: vi.fn(async () => ({ ok: true })) as any,
      availableTools: TEST_TOOLS,
    });
    const actor = await ownerActor();
    await loop.run({
      actor, message: '测试 seq', history: [], attachmentContext: [],
      signal: new AbortController().signal,
      emit: (_type: string, payload: any) => {
        if (payload?.phase?.includes('delta') || payload?.phase?.includes('end')) {
          events.push({ phase: payload.phase, seq: payload.metadata?.seq });
        }
      },
    });
    const seqs = events.map(e => e.seq).filter((s): s is number => typeof s === 'number');
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  it('非流式兼容：无 onDelta 时保持 Promise<string> 行为', async () => {
    const llm = vi.fn(async (input: any) => {
      expect(input.onDelta).toBeUndefined();
      return '{"thought":"兼容","action":"final_answer","finalAnswer":"非流式兼容正常"}';
    });
    const loop = createAgentLoop({
      llm: llm as any,
      toolExecutor: vi.fn(async () => ({ ok: true })) as any,
      availableTools: TEST_TOOLS,
    });
    const actor = await ownerActor();
    const result = await loop.run({
      actor, message: '兼容测试', history: [], attachmentContext: [],
      signal: new AbortController().signal,
    });
    expect(result.text).toContain('非流式兼容正常');
  });

  it('完整序列：thought_delta -> thought_end -> answer_delta -> answer_end 存在且有序', async () => {
    const llm = vi.fn(async (input: any) => {
      if (input.onDelta) {
        input.onDelta('{"thought":"先查');
        input.onDelta('订单","action":"final_answer","finalAnswer":"这是回答"}');
      }
      return '{"thought":"先查订单","action":"final_answer","finalAnswer":"这是回答"}';
    });
    const phases: string[] = [];
    const loop = createAgentLoop({
      llm: llm as any,
      toolExecutor: vi.fn(async () => ({ ok: true })) as any,
      availableTools: TEST_TOOLS,
    });
    const actor = await ownerActor();
    await loop.run({
      actor, message: '完整序列', history: [], attachmentContext: [],
      signal: new AbortController().signal,
      emit: (_type: string, payload: any) => {
        const ph = payload?.phase;
        if (ph === 'thought_delta' || ph === 'thought_end' ||
            ph === 'answer_delta' || ph === 'answer_end') {
          phases.push(ph);
        }
      },
    });
    // 四类事件都存在
    expect(phases).toContain('thought_delta');
    expect(phases).toContain('thought_end');
    expect(phases).toContain('answer_delta');
    expect(phases).toContain('answer_end');
    // 顺序契约：delta 在对应 end 前（thought_delta<thought_end, answer_delta<answer_end）
    // 注：流式下 thought_delta/answer_delta 可能在 planNextStep 内交错（LLM JSON 增量），
    // thought_end/answer_end 是 planNextStep 返回后的同步标记，故只断言 delta<end 配对。
    const tdi = phases.indexOf('thought_delta');
    const tei = phases.indexOf('thought_end');
    const adi = phases.indexOf('answer_delta');
    const aei = phases.indexOf('answer_end');
    expect(tdi).toBeLessThan(tei);
    expect(adi).toBeLessThan(aei);
  });
});
