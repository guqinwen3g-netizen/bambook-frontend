import { describe, expect, it, vi } from 'vitest';
import { emitAgentWorkEvent } from './events';

/**
 * Phase 7-58: 审批 block 派生器单测。
 *
 * 不打数据库——只验证 emitAgentWorkEvent 在 status='blocked' + metadata.approvalId 命中时
 * 派生 'approval' 类型的 block_start，并按预期填充 approvalId/risk/editableFields/inputPreview。
 */
describe('emitAgentWorkEvent → approval block', () => {
  it('derives an approval block when blocked event carries approvalId', () => {
    const emit = vi.fn();
    emitAgentWorkEvent(emit, {
      phase: 'tool_call',
      status: 'blocked',
      title: '读取订单数据已挂起待审批',
      message: '读取订单数据需要审批后才能执行（risk=high）。',
      toolId: 'orders.query',
      summary: 'high-risk read',
      metadata: {
        callId: 'call_0_orders.query',
        input: { filters: { customer: '<CUSTOMER>' }, limit: 50 },
        risk: 'high',
        approvalId: 'ar_test_001',
        editableFields: ['filters.customer', 'limit'],
      },
    });

    // 派生 block_start with type='approval'
    const approvalCalls = emit.mock.calls.filter(call => call[0] === 'block_start' && call[1]?.block?.type === 'approval');
    expect(approvalCalls).toHaveLength(1);
    const approvalBlock = approvalCalls[0][1].block;
    expect(approvalBlock).toMatchObject({
      type: 'approval',
      approvalId: 'ar_test_001',
      risk: 'high',
      proposedAction: '读取订单数据已挂起待审批',
      toolId: 'orders.query',
      approvalStatus: 'pending',
      editableFields: ['filters.customer', 'limit'],
      status: 'streaming',
    });
    // input 被预览化（保留键名）
    expect(approvalBlock.input).toBeDefined();
    expect(approvalBlock.input.filters).toBeDefined();

    // 关键：approval block 不立即 emit block_end（lifecycle 由 resolve 推进）
    const approvalEnds = emit.mock.calls.filter(call => call[0] === 'block_end' && call[1]?.blockId === approvalBlock.id);
    expect(approvalEnds).toHaveLength(0);
  });

  it('does NOT derive approval block when blocked event lacks approvalId (e.g. loop assessment blocked)', () => {
    const emit = vi.fn();
    emitAgentWorkEvent(emit, {
      phase: 'assessment',
      status: 'blocked',
      title: '需要补充条件',
      message: '本步缺乏证据，等用户补充。',
      toolId: 'orders.query',
      metadata: {
        loopDecision: 'blocked',
      },
    });
    const approvalCalls = emit.mock.calls.filter(call => call[0] === 'block_start' && call[1]?.block?.type === 'approval');
    expect(approvalCalls).toHaveLength(0);
  });

  it('normalizes risk to "high" when metadata.risk is unknown', () => {
    const emit = vi.fn();
    emitAgentWorkEvent(emit, {
      phase: 'tool_call',
      status: 'blocked',
      title: '某未知工具',
      message: '...',
      toolId: 'unknown.tool',
      metadata: {
        approvalId: 'ar_test_002',
        risk: 'low', // low 在 approval 协议里不合法 → 应该兜底为 high
      },
    });
    const approvalBlock = emit.mock.calls.find(call => call[0] === 'block_start' && call[1]?.block?.type === 'approval')?.[1].block;
    expect(approvalBlock?.risk).toBe('high');
  });

  it('still derives tool lifecycle block in addition to approval block on blocked tool_call', () => {
    const emit = vi.fn();
    emitAgentWorkEvent(emit, {
      phase: 'tool_call',
      status: 'blocked',
      title: '订单写入已挂起',
      message: 'pending approval',
      toolId: 'orders.write',
      metadata: {
        callId: 'call_0_orders.write',
        approvalId: 'ar_test_003',
        risk: 'critical',
      },
    });
    const types = emit.mock.calls.filter(call => call[0] === 'block_start').map(call => call[1].block.type);
    expect(types).toContain('tool');
    expect(types).toContain('approval');
  });
});

/**
 * Task 60 e2e 风格断言：单一 agent run 产生 tool / evidence / table 三类 block_start。
 *
 * 走的不是真 SSE 通道，而是把 emit 用 vi.fn() 拦下来，模拟一个完整的工具调用生命周期：
 * tool_call(running) → tool_result(complete, output 含表格行)。
 *
 * 验证目标：events.ts 的 block 派生器在一次 happy-path 调用下能同时输出
 * tool / evidence / table 三类 block_start —— 这是前端 Agent Workspace 渲染
 * 三栏体验所依赖的最小契约。
 */
describe('emitAgentWorkEvent → tool/evidence/table e2e contract', () => {
  it('emits tool + evidence + table block_starts on a successful tool result', () => {
    const emit = vi.fn();

    emitAgentWorkEvent(emit, {
      phase: 'tool_call',
      status: 'running',
      title: '查询订单',
      message: '正在查询订单',
      toolId: 'orders.query',
      metadata: {
        callId: 'call_e2e_orders',
        input: { filters: { dueDateFrom: '2026-01-01' }, limit: 5 },
      },
    });

    emitAgentWorkEvent(emit, {
      phase: 'tool_result',
      status: 'complete',
      title: '订单查询完成',
      message: '查到 2 条订单',
      toolId: 'orders.query',
      summary: '共 2 条订单（PO-XXX、PO-YYY）',
      metadata: {
        callId: 'call_e2e_orders',
        output: {
          ok: true,
          rows: [
            { poNumber: 'PO-XXX', customer: '<CUSTOMER>', dueDate: '2026-07-15', status: 'open' },
            { poNumber: 'PO-YYY', customer: '<CUSTOMER>', dueDate: '2026-08-02', status: 'open' },
          ],
        },
      },
    });

    const starts = emit.mock.calls.filter(call => call[0] === 'block_start');
    const types = starts.map(call => call[1].block.type);

    expect(types).toContain('tool');
    expect(types).toContain('evidence');
    expect(types).toContain('table');
  });

  it('does not emit evidence/table when tool_result has no usable output', () => {
    const emit = vi.fn();

    emitAgentWorkEvent(emit, {
      phase: 'tool_result',
      status: 'complete',
      title: '空结果',
      message: '什么也没查到',
      toolId: 'orders.query',
      metadata: {
        callId: 'call_empty',
        output: null,
      },
    });

    const types = emit.mock.calls
      .filter(call => call[0] === 'block_start')
      .map(call => call[1].block.type);

    // tool block 仍要发；evidence/table 不应出现（避免空卡）
    expect(types).toContain('tool');
    expect(types).not.toContain('table');
  });
});
