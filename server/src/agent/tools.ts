import { ActorContext, PolicyDecision, ToolRisk } from './types';
import { createPolicyService } from './policy';
import { PrismaClient } from '@prisma/client';
import { DEFAULT_AGENT_ROLES, DEFAULT_AGENT_TOOLS } from './defaults';

type ToolDefinition = {
  id: string;
  name: string;
  scope: string;
  risk: ToolRisk;
  run: (input: Record<string, unknown>, actor: ActorContext) => Promise<unknown>;
};

type ToolRunRecord = {
  id: string;
  actorId: string;
  toolId: string;
  status: 'success' | 'failed' | 'approval_required';
  input: Record<string, unknown>;
  output?: unknown;
  error?: string;
  decision: PolicyDecision;
  startedAt: Date;
  completedAt?: Date;
};

/**
 * @deprecated 生产环境不再使用此 registry。实际工具分发走 toolDispatchRegistry.ts 的 dispatchFromRegistry()。
 * 保留此导出仅为兼容 services.test.ts，后续应迁移测试后移除。
 */
export function createToolRegistry(options: { policy?: ReturnType<typeof createPolicyService> } = {}) {
  const policy = options.policy ?? createPolicyService();
  const tools = new Map<string, ToolDefinition>();
  const runs: ToolRunRecord[] = [];

  function register(tool: ToolDefinition) {
    tools.set(tool.id, tool);
  }

  async function run(actor: ActorContext, toolId: string, input: Record<string, unknown>) {
    const tool = tools.get(toolId);
    if (!tool) throw new Error(`Tool not registered: ${toolId}`);

    const decision = policy.canUseTool(actor, {
      toolId: tool.id,
      scope: tool.scope,
      risk: tool.risk,
    });
    const record: ToolRunRecord = {
      id: `tool_run_${runs.length + 1}`,
      actorId: actor.userId,
      toolId,
      status: 'failed',
      input,
      decision,
      startedAt: new Date(),
    };

    if (!decision.allowed) {
      record.error = decision.reason || 'TOOL_NOT_ALLOWED';
      runs.push(record);
      throw new Error(record.error);
    }

    if (decision.requiresApproval) {
      record.status = 'approval_required';
      runs.push(record);
      throw new Error(decision.reason || 'APPROVAL_REQUIRED');
    }

    try {
      const output = await tool.run(input, actor);
      record.status = 'success';
      record.output = output;
      record.completedAt = new Date();
      runs.push(record);
      return output;
    } catch (error: any) {
      record.error = String(error?.message || error);
      record.completedAt = new Date();
      runs.push(record);
      throw error;
    }
  }

  function getRuns() {
    return [...runs];
  }

  function stats() {
    return {
      tools: tools.size,
      runs: runs.length,
      approvalRequired: runs.filter(run => run.status === 'approval_required').length,
    };
  }

  return { register, run, getRuns, stats };
}

export async function ensureDefaultAgentTools(prisma: PrismaClient) {
  for (const role of DEFAULT_AGENT_ROLES) {
    await prisma.role.upsert({
      where: { id: role.id },
      create: {
        id: role.id,
        name: role.name,
        description: role.description,
        isSystem: true,
      },
      update: {
        name: role.name,
        description: role.description,
        isSystem: true,
      },
    });
  }

  // 自洽初始化：工具 allowedRoles 可能引用 DEFAULT_AGENT_ROLES 之外的既有业务角色
  // （factory / logistics / production_manager 等）。全新库不保证这些角色已 seed，
  // 若缺失，下方 agentToolPermission.upsert 会 FK 违反。故对引用全集「确保存在」：
  // 已存在的（含业务角色）不动其 name/description，缺失的补一个系统占位角色。
  const referenced = new Set<string>();
  for (const tool of DEFAULT_AGENT_TOOLS) {
    for (const roleId of tool.allowedRoles) referenced.add(roleId);
  }
  const existing = await prisma.role.findMany({
    where: { id: { in: [...referenced] } },
    select: { id: true },
  });
  const existingIds = new Set(existing.map((r) => r.id));
  for (const roleId of referenced) {
    if (existingIds.has(roleId)) continue;
    await prisma.role.create({
      data: { id: roleId, name: roleId, description: 'Agent 默认角色（自动补齐）', isSystem: true },
    });
  }

  for (const tool of DEFAULT_AGENT_TOOLS) {
    await prisma.agentTool.upsert({
      where: { id: tool.id },
      create: {
        id: tool.id,
        name: tool.name,
        scope: tool.scope,
        risk: tool.risk,
        inputSchema: {},
        status: 'active',
      },
      update: {
        name: tool.name,
        scope: tool.scope,
        risk: tool.risk,
        status: 'active',
      },
    });

    for (const roleId of tool.allowedRoles) {
      await prisma.agentToolPermission.upsert({
        where: { toolId_roleId: { toolId: tool.id, roleId } },
        create: {
          id: `tp_${tool.id.replace(/[^a-zA-Z0-9]/g, '_')}_${roleId}`,
          toolId: tool.id,
          roleId,
          access: 'execute',
          riskMode: (tool.risk === 'high' || (tool as any).approvalRoles) ? 'approval' : 'direct',
        },
        update: {
          access: 'execute',
          riskMode: (tool.risk === 'high' || (tool as any).approvalRoles) ? 'approval' : 'direct',
        },
      });
    }
  }
}
