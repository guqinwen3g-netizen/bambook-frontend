import { describe, expect, it, vi } from 'vitest';
import { createAgentOrchestrator } from '../orchestrator';
import { createIdentityService } from '../identity';
import { createPolicyService } from '../policy';
import { DEFAULT_AGENT_ROLES, DEFAULT_AGENT_TOOLS } from '../defaults';
import { readFileSync } from 'fs';
import path from 'path';

describe('Enterprise Agent OS foundation', () => {
  it('rejects an actor context without trusted roles', async () => {
    const identity = createIdentityService();

    await expect(identity.resolveActorContext({
      userId: 'untrusted-user',
      displayName: 'Untrusted',
    })).rejects.toThrow('ACTOR_ROLES_REQUIRED');
  });

  it('applies role based policy before knowledge access and tool execution', async () => {
    const policy = createPolicyService();
    const financeActor = await createIdentityService().resolveActorContext({
      userId: 'finance-1',
      roles: ['finance'],
      departmentIds: ['finance'],
    });
    const viewerActor = await createIdentityService().resolveActorContext({
      userId: 'viewer-1',
      roles: ['viewer'],
      departmentIds: ['sales'],
    });

    expect(policy.canAccessKnowledge(financeActor, { scopes: ['finance'] })).toBe(true);
    expect(policy.canAccessKnowledge(viewerActor, { scopes: ['finance'] })).toBe(false);
    expect(policy.canUseTool(financeActor, { toolId: 'invoice.generate', scope: 'finance', risk: 'medium' })).toEqual({
      allowed: true,
      requiresApproval: false,
    });
    expect(policy.canUseTool(viewerActor, { toolId: 'invoice.generate', scope: 'finance', risk: 'medium' })).toEqual({
      allowed: false,
      requiresApproval: false,
      reason: 'ROLE_NOT_ALLOWED',
    });
  });

  it('runs the orchestrator with actor context, policy filtered knowledge, and sources', async () => {
    const orchestrator = createAgentOrchestrator({
      identity: createIdentityService(),
      policy: createPolicyService(),
      knowledge: {
        search: async ({ actor, query }) => [
          {
            title: `Finance result for ${query}`,
            category: 'Finance',
            content: `visible to ${actor.userId}`,
            source: 'knowledge',
            scopes: ['finance'],
          },
          {
            title: 'Hidden owner note',
            category: 'Admin',
            content: 'not visible',
            source: 'knowledge',
            scopes: ['owner'],
          },
        ],
      },
      model: {
        complete: async ({ actor, context }) => `Hello ${actor.userId}: ${context.map(item => item.title).join(', ')}`,
      },
    });

    const result = await orchestrator.run({
      sessionId: 's1',
      userId: 'finance-1',
      roles: ['finance'],
      departmentIds: ['finance'],
      message: 'invoice',
    });

    expect(result.text).toBe('Hello finance-1: Finance result for invoice');
    expect(result.sources).toEqual([
      expect.objectContaining({
        title: 'Finance result for invoice',
        source: 'knowledge',
      }),
    ]);
    expect(result.thoughtProcess).toContain('我的理解');
    expect(result.thoughtProcess).toContain('我先把这个问题理解为');
    expect(result.thoughtProcess).toContain('我的做法');
    expect(result.thoughtProcess).toContain('我会先使用 Bambook 后端可访问的数据');
    expect(result.thoughtProcess).toContain('我拿到的依据');
    expect(result.thoughtProcess).toContain('knowledge/Finance');
    expect(result.thoughtProcess).toContain('我的结论方式');
  });

  it('uses recent user history when retrieving context for follow-up messages', async () => {
    const search = vi.fn(async ({ query }) => [
      {
        title: `Result for ${query}`,
        category: 'ToolResult',
        content: 'tool_id = records.query; output.entity = ProductAsset; output.aggregate = count; output.count = 18367',
        source: 'agent-tool/records.query',
        scopes: ['company', 'products'],
      },
    ]);
    const orchestrator = createAgentOrchestrator({
      identity: createIdentityService(),
      policy: createPolicyService(),
      knowledge: { search },
      model: {
        complete: async ({ context }) => context[0]?.content || '',
      },
    });

    const result = await orchestrator.run({
      sessionId: 's-followup',
      userId: 'kevin',
      displayName: 'Kevin',
      roles: ['owner'],
      departmentIds: ['company'],
      message: '现在也一样',
      history: [
        { role: 'user', content: '系统里一共有多少条面料信息？' },
        { role: 'model', content: '上下文不足。' },
      ],
    });

    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.stringContaining('系统里一共有多少条面料信息？'),
    }));
    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.stringContaining('现在也一样'),
    }));
    expect(result.text).toBe('tool_id = records.query; output.entity = ProductAsset; output.aggregate = count; output.count = 18367');
    expect(result.thoughtProcess).toContain('我再查业务记录 ProductAsset，统计方式是 count，结果是 18367。');
    expect(result.thoughtProcess).not.toContain('tool_id = records.query');
  });

  it('surfaces Agent Runtime capabilities as normal context for identity questions', async () => {
    const orchestrator = createAgentOrchestrator({
      identity: createIdentityService(),
      policy: createPolicyService(),
      knowledge: {
        search: async () => [
          {
            title: 'Bambook Agent Runtime Tool Capability',
            category: 'ToolCapability',
            content: '当前 Agent Runtime 已接入真实 handler 的可调用工具: products.query, products.get, records.query',
            source: 'agent-runtime',
            scopes: ['company'],
          },
        ],
      },
      model: {
        complete: async ({ context }) => context.map(item => `${item.source}/${item.category}: ${item.content}`).join('\n'),
      },
    });

    const result = await orchestrator.run({
      sessionId: 's-capability',
      userId: 'kevin',
      displayName: 'Kevin',
      roles: ['owner'],
      departmentIds: ['company'],
      message: '你是谁？你可以访问哪些 Bambook 数据和工具？',
    });

    expect(result.text).toContain('agent-runtime/ToolCapability');
    expect(result.text).toContain('products.query');
    expect(result.thoughtProcess).toContain('agent-runtime/ToolCapability');
  });

  it('declares the first enterprise roles and auditable Bambook tool definitions', () => {
    expect(DEFAULT_AGENT_ROLES.map(role => role.id)).toEqual([
      'owner',
      'admin',
      'manager',
      'merchandiser',
      'finance',
      'sales',
      'viewer',
      'agent_operator',
    ]);
    expect(DEFAULT_AGENT_TOOLS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'orders.search', risk: 'low' }),
        expect.objectContaining({ id: 'email.send', risk: 'high', approvalRoles: ['owner', 'admin', 'manager'] }),
      ]),
    );
  });

  it('keeps the Agent OS database foundation in the Prisma schema', () => {
    const schema = readFileSync(path.resolve(__dirname, '../../../prisma/schema.prisma'), 'utf8');
    [
      'model UserAccount',
      'model Department',
      'model Role',
      'model AgentSession',
      'model AgentMemory',
      'model KnowledgeDocument',
      'model KnowledgeAcl',
      'model AgentToolRun',
      'model ApprovalRequest',
    ].forEach(modelName => {
      expect(schema).toContain(modelName);
    });
  });
});
