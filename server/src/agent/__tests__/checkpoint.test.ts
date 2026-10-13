import { describe, expect, it } from 'vitest';
import { createCheckpointConversationId, InMemoryCheckpointManager, PrismaCheckpointManager, generateCheckpointId, AgentCheckpoint } from '../checkpoint';

describe('InMemoryCheckpointManager', () => {
  it('save + load roundtrip', async () => {
    const mgr = new InMemoryCheckpointManager();
    const ckpt: AgentCheckpoint = {
      id: generateCheckpointId(),
      conversationId: 'conv_test_1',
      step: 3,
      message: '推进生产管线',
      scratchpad: {
        thoughts: [{ step: 1, content: '需要先检查订单状态' }, { step: 2, content: '调用 advance_stage' }],
        toolCalls: [{ toolId: 'production.advance_stage', ok: true }],
      },
      iterations: [{ step: 1, thought: '开始' }],
      createdAt: new Date().toISOString(),
    };

    await mgr.save(ckpt);
    const loaded = await mgr.load('conv_test_1');

    expect(loaded).not.toBeNull();
    expect(loaded!.step).toBe(3);
    expect(loaded!.scratchpad.thoughts).toHaveLength(2);
    expect(loaded!.scratchpad.toolCalls).toHaveLength(1);
    expect(loaded!.scratchpad.thoughts[1].content).toBe('调用 advance_stage');
  });

  it('load nonexistent → null', async () => {
    const mgr = new InMemoryCheckpointManager();
    const loaded = await mgr.load('nonexistent');
    expect(loaded).toBeNull();
  });

  it('save overwrites previous checkpoint for same conversation', async () => {
    const mgr = new InMemoryCheckpointManager();
    const ckpt1: AgentCheckpoint = {
      id: generateCheckpointId(), conversationId: 'conv_2', step: 1, message: 'test',
      scratchpad: { thoughts: [], toolCalls: [] }, iterations: [], createdAt: new Date().toISOString(),
    };
    const ckpt2: AgentCheckpoint = {
      id: generateCheckpointId(), conversationId: 'conv_2', step: 5, message: 'test',
      scratchpad: { thoughts: [{ step: 3, content: 'step3' }], toolCalls: [] }, iterations: [], createdAt: new Date().toISOString(),
    };

    await mgr.save(ckpt1);
    await mgr.save(ckpt2);
    const loaded = await mgr.load('conv_2');

    expect(loaded!.step).toBe(5);
    expect(loaded!.scratchpad.thoughts).toHaveLength(1);
  });

  it('clear removes checkpoint', async () => {
    const mgr = new InMemoryCheckpointManager();
    const ckpt: AgentCheckpoint = {
      id: generateCheckpointId(), conversationId: 'conv_3', step: 2, message: 'x',
      scratchpad: { thoughts: [], toolCalls: [] }, iterations: [], createdAt: new Date().toISOString(),
    };
    await mgr.save(ckpt);
    await mgr.clear('conv_3');
    const loaded = await mgr.load('conv_3');
    expect(loaded).toBeNull();
  });

  it('multiple conversations isolated', async () => {
    const mgr = new InMemoryCheckpointManager();
    await mgr.save({ id: generateCheckpointId(), conversationId: 'conv_a', step: 1, message: 'a', scratchpad: { thoughts: [], toolCalls: [] }, iterations: [], createdAt: new Date().toISOString() });
    await mgr.save({ id: generateCheckpointId(), conversationId: 'conv_b', step: 5, message: 'b', scratchpad: { thoughts: [], toolCalls: [] }, iterations: [], createdAt: new Date().toISOString() });

    expect((await mgr.load('conv_a'))!.step).toBe(1);
    expect((await mgr.load('conv_b'))!.step).toBe(5);
  });
});

describe('PrismaCheckpointManager', () => {
  it('persists, restores, and clears a checkpoint through the database model', async () => {
    const row = new Map<string, any>();
    const agentCheckpoint = {
      upsert: async ({ create, update, where }: any) => {
        const existing = row.get(where.conversationId);
        row.set(where.conversationId, existing ? { ...existing, ...update } : create);
      },
      findUnique: async ({ where }: any) => row.get(where.conversationId) ?? null,
      deleteMany: async ({ where }: any) => {
        row.delete(where.conversationId);
      },
    };
    const mgr = new PrismaCheckpointManager({ agentCheckpoint } as any);
    const checkpoint: AgentCheckpoint = {
      id: 'ckp_prisma', conversationId: 'session_1', step: 2, message: '继续处理订单',
      scratchpad: { thoughts: [{ step: 1, content: '已查询' }], toolCalls: [] },
      iterations: [{ step: 1 }], createdAt: '2026-07-23T00:00:00.000Z',
    };

    await mgr.save(checkpoint);
    expect(await mgr.load('session_1')).toMatchObject(checkpoint);
    await mgr.clear('session_1');
    expect(await mgr.load('session_1')).toBeNull();
  });
});

describe('generateCheckpointId', () => {
  it('generates unique IDs with ckp_ prefix', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const id = generateCheckpointId();
      expect(id.startsWith('ckp_')).toBe(true);
      expect(ids.has(id)).toBe(false);
      ids.add(id);
    }
  });
});

describe('createCheckpointConversationId', () => {
  const actor = (userId: string, departmentIds = ['company']) => ({ userId, departmentIds });

  it('binds an identical client session id to the resolved actor and department scope', () => {
    const alice = createCheckpointConversationId({ sessionId: 'default-session', actor: actor('alice', ['sales']) });
    const bob = createCheckpointConversationId({ sessionId: 'default-session', actor: actor('bob', ['sales']) });
    const otherDepartment = createCheckpointConversationId({ sessionId: 'default-session', actor: actor('alice', ['finance']) });

    expect(alice).not.toBe(bob);
    expect(alice).not.toBe(otherDepartment);
    expect(alice).toMatch(/^ckpt_v1_[A-Za-z0-9_-]+$/);
  });

  it('is stable for the same actor scope regardless of department ordering', () => {
    const first = createCheckpointConversationId({ sessionId: 'session-42', actor: actor('alice', ['sales', 'company']) });
    const second = createCheckpointConversationId({ sessionId: 'session-42', actor: actor('alice', ['company', 'sales']) });

    expect(first).toBe(second);
  });
});
