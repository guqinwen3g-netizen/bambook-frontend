/**
 * permissionAgentToolMatrix.test.ts — W-C 批三-C 交付物 3：Agent 工具层「角色 × 风险档」判定矩阵
 *
 * 链路（W-C 批三-F 根修后）：
 *   7 系统角色 → roleIds 经 identity.resolveActorContext 派生 toolScopes
 *     （getDefaultScopeListForRole 前缀域集合 + read + memory；SUPER_ADMIN → 全部已注册工具域）
 *   → ROLE_ID_TO_LEGACY_AGENT_ROLE 映射 legacy AgentRole（HIGH_RISK_APPROVERS 审批闸判定用）
 *   → policy.canUseTool 判定（owner 特判全通 / toolScopes 不含 scope 拒绝 / high risk 非审批人要审批）
 *
 * 抽样：低/中/高三档 risk 各 3 个工具（取自 toolRegistry 权威注册表 P0B_TOOL_DEFINITIONS）：
 *   low:    products.search(products) / order_changes.query(orders) / qc.query_reports(qc)
 *   medium: knowledge.ingest(knowledge) / order_changes.withdraw(orders) / samples.submit_to_customer(samples)
 *   high:   orders.update_status(orders) / payment_voucher.create(finance) / relation.delete(relations)
 *
 * 三条铁律（批三-F 收口后口径）：
 *   1. QC（role-qc）经新链路获得矩阵派生工具域（含 qc 本域 + read/products/memory），
 *      超域工具（samples/automation/credit 等矩阵未授权域）仍 ROLE_NOT_ALLOWED
 *   2. sales 高风险写工具 requiresApproval=true（域内）或 ROLE_NOT_ALLOWED（超域）
 *   3. owner 全通（policy 特判 + identity 全注册域双保险，与 hasPermission SUPER_ADMIN 特判同哲学）
 *
 * 批三-F 修复记录（原 2 红例）：
 *   - owner 对 qc.query_reports / samples.submit_to_customer 曾 ROLE_NOT_ALLOWED
 *     （identity.ROLE_SCOPES 手写清单滞后注册表扩张）→ policy owner 特判 + 派生双修复；
 *   - QC 经 legacy→viewer 映射丢失整个 qc 工具域（qc.query_reports 对本角色也拒）
 *     → identity 新链路矩阵派生修复，本文件 actorFor 携带 roleIds 走新链路。
 * 域门为粗粒度门禁：读工具按域放行；写工具由 HIGH_RISK_APPROVERS 审批闸 +
 * toolRuntime approvalPolicy='always' 兜底（与 route 层 requirePermission 细粒度互补）。
 * 断言保持「正确期望」= 矩阵真源推导结果，不为转绿削弱。
 */
import { describe, it, expect } from 'vitest';
import { createIdentityService } from '../agent/identity';
import { createPolicyService } from '../agent/policy';
import { getToolDefinition, type ToolDefinition } from '../agent/toolRegistry';
import { ROLE_ID_TO_LEGACY_AGENT_ROLE } from '../auth/permissionService';
import {
  SYSTEM_ROLE_IDS,
  type SystemRoleId,
} from '../_shared/rolePermissionMatrix';
import type { ActorContext, PolicyDecision } from '../agent/types';

const identity = createIdentityService();
const policy = createPolicyService();

const SAMPLED_TOOL_IDS = {
  low: ['products.search', 'order_changes.query', 'qc.query_reports'],
  medium: ['knowledge.ingest', 'order_changes.withdraw', 'samples.submit_to_customer'],
  high: ['orders.update_status', 'payment_voucher.create', 'relation.delete'],
} as const;

function tool(id: string): ToolDefinition {
  const def = getToolDefinition(id);
  if (!def) throw new Error(`sampled tool not registered: ${id}`);
  return def;
}

async function actorFor(roleId: SystemRoleId): Promise<ActorContext> {
  const legacy = ROLE_ID_TO_LEGACY_AGENT_ROLE[roleId];
  return identity.resolveActorContext({
    userId: `u_${roleId}`,
    displayName: `AgentMatrix ${roleId}`,
    roles: [legacy],
    roleIds: [roleId], // W-C 批三-F：新链路真源——actor 携带新 roleIds 时 toolScopes 走矩阵派生
  });
}

function decide(actor: ActorContext, toolId: string): PolicyDecision {
  const def = tool(toolId);
  return policy.canUseTool(actor, { toolId: def.id, scope: def.scope, risk: def.risk });
}

const ALL_SAMPLED = [...SAMPLED_TOOL_IDS.low, ...SAMPLED_TOOL_IDS.medium, ...SAMPLED_TOOL_IDS.high];

// ══════════════════════════════════════════════════════════════
// 铁律 1：QC（role-qc）矩阵派生域——qc 本域可用（批三-F 修复），超域仍拒
// ══════════════════════════════════════════════════════════════
describe('Agent 矩阵 · role-qc（矩阵派生域：qc 本域可用 / 超域拒绝 / 高风险审批）', () => {
  it('toolScopes 含 qc/read/products/memory（修复核心），不含矩阵未授权域', async () => {
    const actor = await actorFor(SYSTEM_ROLE_IDS.QC);
    for (const domain of ['qc', 'read', 'products', 'memory', 'orders', 'production', 'bom', 'knowledge']) {
      expect(actor.toolScopes, `QC toolScopes 应含矩阵派生域 ${domain}`).toContain(domain);
    }
    // 矩阵未授权域不得出现（sample(s)/automation/credit/internal_trade/exception(s)/email(s)/inventory）
    // 注：development 经 MATRIX_TO_TOOL_DOMAIN_ALIASES（products→development，VIEW_TO_MAIN_SCOPES 真源
    // Development 属 products 域）对持 products:read 的 QC 放行，属预期不再视为越域
    for (const domain of ['samples', 'sample', 'automation', 'credit', 'internal_trade', 'exceptions', 'exception', 'email', 'emails', 'inventory']) {
      expect(actor.toolScopes, `QC toolScopes 不得含未授权域 ${domain}`).not.toContain(domain);
    }
  });

  it('低风险域内只读工具放行：products/orders/qc 域（qc.query_reports 对 QC 本角色转绿=批三-F 修复）', async () => {
    const actor = await actorFor(SYSTEM_ROLE_IDS.QC);
    expect(decide(actor, 'products.search')).toEqual({ allowed: true, requiresApproval: false });
    expect(decide(actor, 'order_changes.query')).toEqual({ allowed: true, requiresApproval: false });
    expect(decide(actor, 'qc.query_reports')).toEqual({ allowed: true, requiresApproval: false });
  });

  it('中风险域内写工具放行（审批闸在 toolRuntime approvalPolicy=always）；超域 samples 仍 ROLE_NOT_ALLOWED', async () => {
    const actor = await actorFor(SYSTEM_ROLE_IDS.QC);
    expect(decide(actor, 'knowledge.ingest')).toEqual({ allowed: true, requiresApproval: false });
    expect(decide(actor, 'order_changes.withdraw')).toEqual({ allowed: true, requiresApproval: false });
    // QC 矩阵无 sample:* scope（样品提交归业务链）→ 超域拒绝不动摇
    expect(decide(actor, 'samples.submit_to_customer')).toMatchObject({ allowed: false, reason: 'ROLE_NOT_ALLOWED' });
  });

  it('高风险域内写工具 → allowed 且 requiresApproval=true（viewer 非 HIGH_RISK_APPROVERS，审批闸兜底）', async () => {
    const actor = await actorFor(SYSTEM_ROLE_IDS.QC);
    for (const id of SAMPLED_TOOL_IDS.high) {
      const d = decide(actor, id);
      expect(d.allowed, `${id} 域内高风险应放行但需审批`).toBe(true);
      expect(d.requiresApproval, `${id} 必须强制审批`).toBe(true);
      expect(d.reason).toBe('APPROVAL_REQUIRED');
    }
  });
});

// ══════════════════════════════════════════════════════════════
// 铁律 2：sales 低风险直放 / 高风险强制审批 / 超域拒绝
// ══════════════════════════════════════════════════════════════
describe('Agent 矩阵 · role-sales（低风险直放 / 高风险强制审批 / 超域拒绝）', () => {
  it('低/中风险且在矩阵派生域内的工具放行且不需审批', async () => {
    const actor = await actorFor(SYSTEM_ROLE_IDS.SALES);
    expect(decide(actor, 'products.search')).toEqual({ allowed: true, requiresApproval: false });
    expect(decide(actor, 'order_changes.query')).toEqual({ allowed: true, requiresApproval: false });
    expect(decide(actor, 'order_changes.withdraw')).toEqual({ allowed: true, requiresApproval: false });
    // SALES_BASE 含 knowledge:write 与 qc:read/write（矩阵真源）→ 域内放行
    expect(decide(actor, 'knowledge.ingest')).toEqual({ allowed: true, requiresApproval: false });
    expect(decide(actor, 'qc.query_reports')).toEqual({ allowed: true, requiresApproval: false });
  });

  it('samples.submit_to_customer 对 sales 放行（MATRIX_TO_TOOL_DOMAIN_ALIASES sample→samples 归一：SALES 持 sample:* 写 scope，样品提交客户是 S1 主链日常；medium risk 无需审批，流程门禁走 processSpec 审批流）', async () => {
    const actor = await actorFor(SYSTEM_ROLE_IDS.SALES);
    expect(decide(actor, 'samples.submit_to_customer')).toMatchObject({
      allowed: true,
      requiresApproval: false,
    });
  });

  it('高风险写工具域内 → allowed 且 requiresApproval=true（sales 非 HIGH_RISK_APPROVERS）', async () => {
    const actor = await actorFor(SYSTEM_ROLE_IDS.SALES);
    for (const id of SAMPLED_TOOL_IDS.high) {
      const d = decide(actor, id);
      expect(d.allowed, `${id} 对 sales 应放行但需审批`).toBe(true);
      expect(d.requiresApproval, `${id} 对 sales 必须强制审批`).toBe(true);
      expect(d.reason).toBe('APPROVAL_REQUIRED');
    }
  });
});

// ══════════════════════════════════════════════════════════════
// 铁律 3：owner（role-super-admin 映射）全通
// ══════════════════════════════════════════════════════════════
describe('Agent 矩阵 · role-super-admin → owner（全通铁律）', () => {
  for (const risk of ['low', 'medium', 'high'] as const) {
    for (const id of SAMPLED_TOOL_IDS[risk]) {
      it(`${risk}: ${id} → allowed 且不需审批（owner policy 特判 + identity 全注册工具域双保险）`, async () => {
        const actor = await actorFor(SYSTEM_ROLE_IDS.SUPER_ADMIN);
        const d = decide(actor, id);
        expect(
          d.allowed,
          `${id} 对 owner 必须放行；实际=${JSON.stringify(d)} —— 若 ROLE_NOT_ALLOWED 说明 ` +
            `owner 特判/全注册域派生未生效（${tool(id).scope}），为工具层缺口回归`,
        ).toBe(true);
        expect(d.requiresApproval, `${id} 对 owner 不应要求审批`).toBe(false);
      });
    }
  }
});

// ══════════════════════════════════════════════════════════════
// 全角色 × 抽样工具 判定矩阵（按矩阵真源推导期望；域内高风险审批闸兜底）
// ══════════════════════════════════════════════════════════════
describe('Agent 矩阵 · 其余角色抽样判定', () => {
  it('role-sales-manager → manager：域内高风险直放（manager 是审批人），qc/finance 域转绿（矩阵派生）', async () => {
    const actor = await actorFor(SYSTEM_ROLE_IDS.SALES_MANAGER);
    expect(decide(actor, 'orders.update_status')).toEqual({ allowed: true, requiresApproval: false });
    expect(decide(actor, 'relation.delete')).toEqual({ allowed: true, requiresApproval: false });
    expect(decide(actor, 'knowledge.ingest')).toEqual({ allowed: true, requiresApproval: false });
    // SM 矩阵含 finance:read + finance:payment_request:approve 与 qc 链 scope → 域内放行
    expect(decide(actor, 'payment_voucher.create')).toEqual({ allowed: true, requiresApproval: false });
    expect(decide(actor, 'qc.query_reports')).toEqual({ allowed: true, requiresApproval: false });
  });

  it('role-finance → finance：finance 域高风险需审批（finance 非审批人），域内 knowledge 放行', async () => {
    const actor = await actorFor(SYSTEM_ROLE_IDS.FINANCE);
    const d = decide(actor, 'payment_voucher.create');
    expect(d.allowed).toBe(true);
    expect(d.requiresApproval).toBe(true);
    expect(d.reason).toBe('APPROVAL_REQUIRED');
    expect(decide(actor, 'orders.update_status')).toMatchObject({ allowed: true, requiresApproval: true });
    // FINANCE_BASE 含 relations:read → 域内高风险走审批闸（不再是超域拒绝）
    expect(decide(actor, 'relation.delete')).toMatchObject({ allowed: true, requiresApproval: true, reason: 'APPROVAL_REQUIRED' });
    expect(decide(actor, 'knowledge.ingest')).toEqual({ allowed: true, requiresApproval: false });
  });

  it('role-admin → admin：管理域全通且高风险直放（admin 是审批人）', async () => {
    const actor = await actorFor(SYSTEM_ROLE_IDS.ADMIN);
    expect(decide(actor, 'orders.update_status')).toEqual({ allowed: true, requiresApproval: false });
    expect(decide(actor, 'payment_voucher.create')).toEqual({ allowed: true, requiresApproval: false });
    expect(decide(actor, 'relation.delete')).toEqual({ allowed: true, requiresApproval: false });
    expect(decide(actor, 'knowledge.ingest')).toEqual({ allowed: true, requiresApproval: false });
  });

  it('role-logistics → logistics：矩阵派生域内低/中风险放行，高风险强制审批，samples 超域拒绝', async () => {
    const actor = await actorFor(SYSTEM_ROLE_IDS.LOGISTICS);
    // LOGISTICS_BASE 含 products/orders/qc/knowledge/orders 域 → 低中风险域内放行
    expect(decide(actor, 'products.search')).toEqual({ allowed: true, requiresApproval: false });
    expect(decide(actor, 'order_changes.query')).toEqual({ allowed: true, requiresApproval: false });
    expect(decide(actor, 'qc.query_reports')).toEqual({ allowed: true, requiresApproval: false });
    expect(decide(actor, 'knowledge.ingest')).toEqual({ allowed: true, requiresApproval: false });
    expect(decide(actor, 'order_changes.withdraw')).toEqual({ allowed: true, requiresApproval: false });
    // 矩阵无 sample 域 → 超域拒绝不动摇
    expect(decide(actor, 'samples.submit_to_customer')).toMatchObject({ allowed: false, reason: 'ROLE_NOT_ALLOWED' });
    // 域内高风险（orders/finance/relations）→ 审批闸（logistics 非 HIGH_RISK_APPROVERS）
    for (const id of SAMPLED_TOOL_IDS.high) {
      const d = decide(actor, id);
      expect(d.allowed, `${id} 域内高风险应放行但需审批`).toBe(true);
      expect(d.requiresApproval, `${id} 必须强制审批`).toBe(true);
      expect(d.reason).toBe('APPROVAL_REQUIRED');
    }
  });

  it('抽样工具覆盖核对：9 个抽样 id 全部在注册表中（防抽样腐化）', () => {
    for (const id of ALL_SAMPLED) {
      expect(getToolDefinition(id), `抽样工具 ${id} 必须在 P0B_TOOL_DEFINITIONS 注册`).toBeTruthy();
    }
  });
});
