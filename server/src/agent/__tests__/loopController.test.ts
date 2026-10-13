import { describe, expect, it } from 'vitest';
import { assessAgentLoopStep } from '../loopController';
import { buildAgentTaskFrame } from '../taskFrame';

describe('Agent loop controller', () => {
  it('continues relation evidence gathering from the task frame even without a followUp flag', () => {
    const taskFrame = buildAgentTaskFrame('帮我查一下通用测试供应商有限公司。我想知道有没有相关联系人或对接人，最后告诉我现在最适合先联系谁。');
    const decision = assessAgentLoopStep({
      taskFrame,
      call: {
        toolId: 'relations.query',
        input: { query: '通用测试供应商有限公司', limit: 5 },
        reason: '查询公司关系档案',
      },
      output: {
        total: 1,
        count: 1,
        items: [{ id: 'relation_supplier_1', name: 'Generic Test Supplier Ltd.', chineseName: '通用测试供应商有限公司' }],
      },
    });

    expect(decision.status).toBe('continue');
    expect(decision.nextCalls.map(call => call.toolId)).toEqual(['relations.get', 'relations.expand']);
    expect(decision.observation).toMatchObject({ cardinality: 'one', resolution: 'unique' });
    expect(decision.evidenceMissing).not.toContain('people directory');
  });

  it('does not expand broad relation lists that are already candidate-list tasks', () => {
    const taskFrame = buildAgentTaskFrame('查看 Bambook 关系智库，列出 5 个客户或供应商关系档案，并说明来源。');
    const decision = assessAgentLoopStep({
      taskFrame,
      call: {
        toolId: 'relations.query',
        input: { query: '', limit: 5 },
        reason: '列出关系档案',
      },
      output: {
        total: 5,
        count: 5,
        items: [
          { id: 'relation_1', name: 'Customer One' },
          { id: 'relation_2', name: 'Supplier Two' },
        ],
      },
    });

    expect(decision.status).toBe('complete');
    expect(decision.nextCalls).toEqual([]);
    expect(decision.observation).toMatchObject({ cardinality: 'many', resolution: 'ambiguous' });
  });

  it('blocks when a task needs object-level evidence but the result has no unique continuation target', () => {
    const taskFrame = buildAgentTaskFrame('帮我查一下测试供应商的联系人，并判断应该先联系谁。');
    const decision = assessAgentLoopStep({
      taskFrame,
      call: {
        toolId: 'relations.query',
        input: { query: '测试供应商', limit: 5 },
        reason: '查询关系候选',
      },
      output: {
        total: 2,
        count: 2,
        items: [
          { id: 'relation_supplier_1', name: 'Test Supplier One' },
          { id: 'relation_supplier_2', name: 'Test Supplier Two' },
        ],
      },
    });

    expect(decision.status).toBe('blocked');
    expect(decision.nextCalls).toEqual([]);
    expect(decision.evidenceMissing).toEqual(expect.arrayContaining(['full relation profile', 'profile contacts']));
  });
});
