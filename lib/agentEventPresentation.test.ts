import { describe, expect, it } from 'vitest';
import { buildAgentTimeline, buildAgentProgressItems, finalizeAgentEvents } from './agentEventPresentation';
import type { AgentWorkEvent } from '../types';

const baseEvent = (overrides: Partial<AgentWorkEvent>): AgentWorkEvent => ({
  id: overrides.id || `evt_${Math.random().toString(36).slice(2, 8)}`,
  phase: overrides.phase || 'start',
  status: overrides.status || 'running',
  title: 'title',
  message: overrides.message || 'msg',
  toolId: overrides.toolId,
  stepId: overrides.stepId,
  summary: overrides.summary,
  metadata: overrides.metadata,
  at: overrides.at,
});

describe('buildAgentTimeline', () => {
  it('returns hasNewLoop=false when only legacy phases are present', () => {
    const events: AgentWorkEvent[] = [
      baseEvent({ phase: 'start', status: 'running' }),
      baseEvent({ phase: 'identity', status: 'complete' }),
      baseEvent({ phase: 'final', status: 'complete' }),
    ];
    const timeline = buildAgentTimeline(events);
    expect(timeline.hasNewLoop).toBe(false);
    expect(timeline.iterations).toHaveLength(0);
    expect(timeline.legacyEvents.length).toBeGreaterThan(0);
  });

  it('aggregates thought/plan/tool_call_start/tool_call_end into a single iteration', () => {
    const events: AgentWorkEvent[] = [
      baseEvent({ phase: 'iteration_start', status: 'running', metadata: { step: 1 } }),
      baseEvent({
        phase: 'thought',
        status: 'complete',
        metadata: { step: 1, thought: '我需要先查询产品档案。' },
      }),
      baseEvent({
        phase: 'plan',
        status: 'complete',
        metadata: {
          step: 1,
          plan: [
            { toolId: 'products.query', input: { query: 'PEER' }, why: '检索候选' },
          ],
        },
      }),
      baseEvent({
        phase: 'tool_call_start',
        status: 'running',
        toolId: 'products.query',
        metadata: { step: 1, callId: 'call_1', input: { query: 'PEER' } },
      }),
      baseEvent({
        phase: 'tool_call_end',
        status: 'complete',
        toolId: 'products.query',
        metadata: {
          step: 1,
          callId: 'call_1',
          ok: true,
          durationMs: 142,
          output: { items: [{ id: 'p1' }] },
        },
      }),
      baseEvent({ phase: 'iteration_end', status: 'complete', metadata: { step: 1 } }),
    ];

    const timeline = buildAgentTimeline(events);
    expect(timeline.hasNewLoop).toBe(true);
    expect(timeline.iterations).toHaveLength(1);

    const iter = timeline.iterations[0];
    expect(iter.step).toBe(1);
    expect(iter.thought).toBe('我需要先查询产品档案。');
    expect(iter.plan).toEqual([
      { toolId: 'products.query', input: { query: 'PEER' }, why: '检索候选' },
    ]);
    expect(iter.toolCalls).toHaveLength(1);
    expect(iter.toolCalls[0].status).toBe('complete');
    expect(iter.toolCalls[0].ok).toBe(true);
    expect(iter.toolCalls[0].durationMs).toBe(142);
    expect(iter.toolCalls[0].output).toEqual({ items: [{ id: 'p1' }] });
    expect(iter.toolCalls[0].input).toEqual({ query: 'PEER' });
    expect(iter.isComplete).toBe(true);
  });

  it('marks failed tool calls and exposes error metadata', () => {
    const events: AgentWorkEvent[] = [
      baseEvent({
        phase: 'tool_call_start',
        status: 'running',
        toolId: 'orders.get',
        metadata: { step: 2, callId: 'call_x' },
      }),
      baseEvent({
        phase: 'tool_call_end',
        status: 'failed',
        toolId: 'orders.get',
        metadata: {
          step: 2,
          callId: 'call_x',
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Order missing' },
        },
      }),
    ];
    const timeline = buildAgentTimeline(events);
    const call = timeline.iterations[0].toolCalls[0];
    expect(call.status).toBe('failed');
    expect(call.ok).toBe(false);
    expect(call.error).toEqual({ code: 'NOT_FOUND', message: 'Order missing' });
  });

  it('falls back to last running tool call when callId is missing', () => {
    const events: AgentWorkEvent[] = [
      baseEvent({
        phase: 'tool_call_start',
        status: 'running',
        toolId: 'products.query',
        metadata: { step: 1 },
      }),
      baseEvent({
        phase: 'tool_call_end',
        status: 'complete',
        toolId: 'products.query',
        metadata: { step: 1, ok: true, durationMs: 99 },
      }),
    ];
    const timeline = buildAgentTimeline(events);
    expect(timeline.iterations[0].toolCalls).toHaveLength(1);
    expect(timeline.iterations[0].toolCalls[0].status).toBe('complete');
    expect(timeline.iterations[0].toolCalls[0].durationMs).toBe(99);
  });

  it('captures final_answer with stopReason and forced flag', () => {
    const events: AgentWorkEvent[] = [
      baseEvent({
        phase: 'final_answer',
        status: 'complete',
        message: '答案文本',
        metadata: {
          step: 3,
          finalAnswer: '答案文本',
          stopReason: 'max_steps_reached',
          forced: true,
        },
      }),
    ];
    const timeline = buildAgentTimeline(events);
    expect(timeline.finalAnswer).toBe('答案文本');
    expect(timeline.stopReason).toBe('max_steps_reached');
    expect(timeline.forced).toBe(true);
    expect(timeline.iterations[0].finalAnswer).toBe('答案文本');
    expect(timeline.iterations[0].isComplete).toBe(true);
  });

  it('extracts legacyTaskGraph from orchestrator-style planning events', () => {
    const events: AgentWorkEvent[] = [
      baseEvent({
        phase: 'planning',
        status: 'complete',
        metadata: {
          steps: [
            { id: 'n1', toolId: 'products.query', objective: '检索产品' },
            { id: 'n2', toolId: 'orders.get', reason: '读取订单' },
          ],
        },
      }),
    ];
    const timeline = buildAgentTimeline(events);
    expect(timeline.hasNewLoop).toBe(false);
    expect(timeline.legacyTaskGraph).toHaveLength(2);
    expect(timeline.legacyTaskGraph?.[0]).toMatchObject({ id: 'n1', toolId: 'products.query', objective: '检索产品' });
    expect(timeline.legacyTaskGraph?.[1]).toMatchObject({ id: 'n2', toolId: 'orders.get', objective: '读取订单' });
  });

  it('sorts iterations by step ascending even if events arrive out of order', () => {
    const events: AgentWorkEvent[] = [
      baseEvent({ phase: 'iteration_start', status: 'running', metadata: { step: 2 } }),
      baseEvent({ phase: 'iteration_start', status: 'running', metadata: { step: 1 } }),
      baseEvent({ phase: 'iteration_start', status: 'running', metadata: { step: 3 } }),
    ];
    const timeline = buildAgentTimeline(events);
    expect(timeline.iterations.map(i => i.step)).toEqual([1, 2, 3]);
  });

  it('flips lingering running tool calls to complete after final_answer arrives', () => {
    const events: AgentWorkEvent[] = [
      baseEvent({
        phase: 'tool_call_start',
        status: 'running',
        toolId: 'products.query',
        metadata: { step: 1, callId: 'never_ends' },
      }),
      baseEvent({
        phase: 'final_answer',
        status: 'complete',
        message: '最终答案',
        metadata: { step: 1, finalAnswer: '最终答案' },
      }),
    ];
    const timeline = buildAgentTimeline(events);
    const call = timeline.iterations[0].toolCalls[0];
    expect(call.status).toBe('complete');
    expect(timeline.iterations[0].isComplete).toBe(true);
  });
});

describe('finalizeAgentEvents', () => {
  it('收敛 iteration_start running 在收到 iteration_end 之后', () => {
    const events: AgentWorkEvent[] = [
      baseEvent({ id: 'a', phase: 'iteration_start', status: 'running', metadata: { step: 1 } }),
      baseEvent({ id: 'b', phase: 'iteration_end', status: 'complete', metadata: { step: 1 } }),
    ];
    const out = finalizeAgentEvents(events);
    expect(out[0].status).toBe('complete');
    expect(out[1].status).toBe('complete');
  });

  it('收敛 tool_call_start running 在收到 tool_call_end 之后（按 callId 配对）', () => {
    const events: AgentWorkEvent[] = [
      baseEvent({
        id: 's', phase: 'tool_call_start', status: 'running',
        toolId: 'products.query', metadata: { step: 1, callId: 'c1' },
      }),
      baseEvent({
        id: 'e', phase: 'tool_call_end', status: 'complete',
        toolId: 'products.query', metadata: { step: 1, callId: 'c1', ok: true },
      }),
    ];
    const out = finalizeAgentEvents(events);
    expect(out[0].status).toBe('complete');
  });

  it('收敛 identity / planning 同 phase running → complete', () => {
    const events: AgentWorkEvent[] = [
      baseEvent({ id: 'i1', phase: 'identity', status: 'running' }),
      baseEvent({ id: 'i2', phase: 'identity', status: 'complete' }),
      baseEvent({ id: 'p1', phase: 'planning', status: 'running' }),
      baseEvent({ id: 'p2', phase: 'planning', status: 'complete', metadata: { steps: [] } }),
    ];
    const out = finalizeAgentEvents(events);
    expect(out[0].status).toBe('complete');
    expect(out[2].status).toBe('complete');
  });

  it('force=true 把所有未配对的 running 强制改为 complete', () => {
    const events: AgentWorkEvent[] = [
      baseEvent({ id: 'a', phase: 'start', status: 'running' }),
      baseEvent({
        id: 'b', phase: 'tool_call_start', status: 'running',
        toolId: 'orders.get', metadata: { step: 2, callId: 'cx' },
      }),
    ];
    const out = finalizeAgentEvents(events, { force: true });
    expect(out.every(e => e.status === 'complete')).toBe(true);
  });

  it('final_answer 出现后视为整轮结束，残留 running 收敛', () => {
    const events: AgentWorkEvent[] = [
      baseEvent({ id: 'a', phase: 'start', status: 'running' }),
      baseEvent({ id: 'b', phase: 'final_answer', status: 'complete', metadata: { finalAnswer: 'ok' } }),
    ];
    const out = finalizeAgentEvents(events);
    expect(out[0].status).toBe('complete');
  });

  it('不修改已经是 complete / failed / blocked 的事件', () => {
    const events: AgentWorkEvent[] = [
      baseEvent({ id: 'a', phase: 'identity', status: 'complete' }),
      baseEvent({ id: 'b', phase: 'tool_call_end', status: 'failed', toolId: 'products.query' }),
      baseEvent({ id: 'c', phase: 'assessment', status: 'blocked' }),
    ];
    const out = finalizeAgentEvents(events, { force: true });
    expect(out[0].status).toBe('complete');
    expect(out[1].status).toBe('failed');
    expect(out[2].status).toBe('blocked');
  });
});

describe('buildAgentProgressItems integration with finalizeAgentEvents', () => {
  it('完成态后不再渲染 isRunning 行（不再卡转圈）', () => {
    const events: AgentWorkEvent[] = [
      baseEvent({
        id: 's1', phase: 'start', status: 'running',
        title: '启动 Agent Runtime', message: '正在启动 Bambook Enterprise Agent OS',
      }),
      baseEvent({
        id: 'p1', phase: 'planning', status: 'running', message: '规划中',
      }),
      baseEvent({
        id: 'p2', phase: 'planning', status: 'complete',
        message: '完成', metadata: { steps: [] },
      }),
      baseEvent({
        id: 'f', phase: 'final', status: 'complete', message: '完成',
      }),
    ];
    const items = buildAgentProgressItems(events);
    // 不应该有任何 isRunning=true 的行
    expect(items.every(item => !item.isRunning)).toBe(true);
  });
});
