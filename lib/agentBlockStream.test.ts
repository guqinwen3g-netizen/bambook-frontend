import { describe, expect, it } from 'vitest';
import type { AgentResponseBlock } from '../types';
import { normalizeAgentBlockStreamEvent, reduceAgentBlocks } from './agentBlockStream';

describe('agentBlockStream', () => {
  it('reduces markdown block start, delta and end events', () => {
    const blocks = reduceAgentBlocks([], {
      event: 'block_start',
      messageId: 'message_1',
      block: {
        id: 'block_1',
        type: 'markdown',
        content: '',
      },
    });

    const withDelta = reduceAgentBlocks(blocks, {
      event: 'block_delta',
      messageId: 'message_1',
      blockId: 'block_1',
      delta: '结论',
    });

    const completed = reduceAgentBlocks(withDelta, {
      event: 'block_end',
      messageId: 'message_1',
      blockId: 'block_1',
    });

    expect(completed).toEqual([
      {
        id: 'block_1',
        type: 'markdown',
        content: '结论',
        status: 'complete',
      },
    ] satisfies AgentResponseBlock[]);
  });

  it('applies table patches without touching unrelated blocks', () => {
    const started = reduceAgentBlocks([], {
      event: 'block_start',
      messageId: 'message_1',
      block: {
        id: 'block_table',
        type: 'table',
        columns: [],
        rows: [],
      },
    });

    const withColumns = reduceAgentBlocks(started, {
      event: 'block_patch',
      messageId: 'message_1',
      blockId: 'block_table',
      patch: {
        op: 'set_columns',
        columns: [{ key: 'name', label: '名称' }],
      },
    });

    const withRow = reduceAgentBlocks(withColumns, {
      event: 'block_patch',
      messageId: 'message_1',
      blockId: 'block_table',
      patch: {
        op: 'append_row',
        row: { name: '示例对象' },
      },
    });

    expect(withRow[0]).toMatchObject({
      id: 'block_table',
      type: 'table',
      columns: [{ key: 'name', label: '名称' }],
      rows: [{ name: '示例对象' }],
      status: 'streaming',
    });
  });

  it('normalizes complete SSE block payloads only', () => {
    expect(normalizeAgentBlockStreamEvent({ event: 'block_delta', messageId: 'message_1', blockId: 'block_1', delta: 'A' })).toEqual({
      event: 'block_delta',
      messageId: 'message_1',
      blockId: 'block_1',
      delta: 'A',
    });
    expect(normalizeAgentBlockStreamEvent({ event: 'block_delta', messageId: 'message_1' })).toBeNull();
  });

  it('handles approval block lifecycle: pending → approved via set_approval_status patch', () => {
    const blocks = reduceAgentBlocks([], {
      event: 'block_start',
      messageId: 'message_1',
      block: {
        id: 'block_approval_call_0',
        type: 'approval',
        title: '需要审批',
        approvalId: 'ar_test_001',
        risk: 'high',
        proposedAction: '读取订单数据',
        toolId: 'orders.query',
        approvalStatus: 'pending',
        editableFields: ['filters.customer'],
      } as AgentResponseBlock,
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'approval',
      approvalId: 'ar_test_001',
      approvalStatus: 'pending',
      status: 'streaming',
    });

    // 模拟前端乐观更新：用户点"批准"后立即 patch
    const approved = reduceAgentBlocks(blocks, {
      event: 'block_patch',
      messageId: 'message_1',
      blockId: 'block_approval_call_0',
      patch: { op: 'set_approval_status', approvalStatus: 'approved' },
    });

    expect(approved[0]).toMatchObject({
      type: 'approval',
      approvalId: 'ar_test_001',
      approvalStatus: 'approved',
      status: 'complete',
    });

    // pending 继续保持 streaming（用于失败回滚）
    const rolledBack = reduceAgentBlocks(approved, {
      event: 'block_patch',
      messageId: 'message_1',
      blockId: 'block_approval_call_0',
      patch: { op: 'set_approval_status', approvalStatus: 'pending' },
    });

    expect(rolledBack[0]).toMatchObject({
      approvalStatus: 'pending',
      status: 'streaming',
    });
  });

  it('ignores set_approval_status patch on non-approval blocks', () => {
    const blocks = reduceAgentBlocks([], {
      event: 'block_start',
      messageId: 'message_1',
      block: {
        id: 'block_md',
        type: 'markdown',
        content: '某段文字',
      } as AgentResponseBlock,
    });
    const next = reduceAgentBlocks(blocks, {
      event: 'block_patch',
      messageId: 'message_1',
      blockId: 'block_md',
      patch: { op: 'set_approval_status', approvalStatus: 'approved' },
    });
    // markdown block 不该被 approval patch 改动
    expect(next[0]).toMatchObject({ type: 'markdown', content: '某段文字' });
    expect((next[0] as any).approvalStatus).toBeUndefined();
  });

  it('preserves processDraft on approval block_start (P1-A ProcessDraft passthrough)', () => {
    const blocks = reduceAgentBlocks([], {
      event: 'block_start',
      messageId: 'message_1',
      block: {
        id: 'block_approval_draft_0',
        type: 'approval',
        title: '批量修改订单状态',
        approvalId: 'ar_draft_001',
        risk: 'high',
        proposedAction: '将 3 个订单标记为已发货',
        toolId: 'orders.batchUpdate',
        approvalStatus: 'pending',
        processDraft: {
          subOperations: [
            { toolId: 'orders.update', entityId: 'ord_001', action: 'status→shipped', before: { status: 'confirmed' }, after: { status: 'shipped' } },
            { toolId: 'orders.update', entityId: 'ord_002', action: 'status→shipped', before: { status: 'confirmed' }, after: { status: 'shipped' } },
          ],
          beforeAfterDiff: [
            { entity: 'Order', entityId: 'ord_001', field: 'status', before: 'confirmed', after: 'shipped' },
          ],
          impactScope: ['订单', '库存', '物流'],
          irreversible: false,
          postCommitHooks: [
            { type: 'email', payload: { to: 'ops@bambook.com' } },
          ],
          idempotencyKey: 'draft_hash_abc123',
        },
      } as AgentResponseBlock,
    });

    expect(blocks).toHaveLength(1);
    const approval = blocks[0] as Extract<AgentResponseBlock, { type: 'approval' }>;
    expect(approval.type).toBe('approval');
    expect(approval.processDraft).toBeDefined();
    expect(approval.processDraft!.subOperations).toHaveLength(2);
    expect(approval.processDraft!.beforeAfterDiff[0]).toMatchObject({ field: 'status', before: 'confirmed', after: 'shipped' });
    expect(approval.processDraft!.impactScope).toEqual(['订单', '库存', '物流']);
    expect(approval.processDraft!.irreversible).toBe(false);
    expect(approval.processDraft!.postCommitHooks[0].type).toBe('email');
    expect(approval.processDraft!.idempotencyKey).toBe('draft_hash_abc123');

    // approval patch 后 processDraft 应保留（审批状态变更不应丢失 draft 数据）
    const approved = reduceAgentBlocks(blocks, {
      event: 'block_patch',
      messageId: 'message_1',
      blockId: 'block_approval_draft_0',
      patch: { op: 'set_approval_status', approvalStatus: 'approved' },
    });
    const approvedBlock = approved[0] as Extract<AgentResponseBlock, { type: 'approval' }>;
    expect(approvedBlock.approvalStatus).toBe('approved');
    expect(approvedBlock.processDraft).toBeDefined();
    expect(approvedBlock.processDraft!.idempotencyKey).toBe('draft_hash_abc123');
  });
});
