/**
 * Phase 7 / Task 59 — 前端 Agent 工具 manifest 类型与拉取 helper
 *
 * 后端 GET /api/agent/mcp/manifest 返回 schemaVersion: '2026-06-runtime-2.0'，
 * 包含 tools: ToolManifest[] + summary。本文件保持类型与后端 server/src/agent/mcp/types.ts
 * 同源，但只 re-declare 前端真正用到的字段，避免把后端模块图引入前端 bundle。
 */

export type AgentToolRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type AgentToolManifestSafety = {
  approval: 'never' | 'risk_based' | 'always';
  sideEffects: boolean;
  editableFields?: string[];
};

export type AgentToolManifestEntry = {
  id: string;
  name: string;
  domain: string;
  risk: AgentToolRiskLevel;
  description: string;
  inputHint?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  permissions?: { scope: string; allowedRoles: string[] };
  safety: AgentToolManifestSafety;
  examples?: Array<{ user: string; input: Record<string, unknown> }>;
};

export type AgentToolManifestSummary = {
  total: number;
  byDomain: Record<string, number>;
  byRisk: Record<string, number>;
  approvalRequired: string[];
};

export type AgentToolCatalog = {
  schemaVersion: string;
  generatedAt: string;
  tools: AgentToolManifestEntry[];
  summary: AgentToolManifestSummary;
  /** 派生字段：按 domain 聚合 + 按 risk 排序，UI 直接消费。 */
  groupedByDomain: Array<{
    domain: string;
    tools: AgentToolManifestEntry[];
  }>;
};

const DOMAIN_ORDER = ['orders', 'products', 'relations', 'entities', 'knowledge'] as const;
const RISK_ORDER: AgentToolRiskLevel[] = ['critical', 'high', 'medium', 'low'];

export function groupToolsByDomain(tools: AgentToolManifestEntry[]): AgentToolCatalog['groupedByDomain'] {
  const buckets = new Map<string, AgentToolManifestEntry[]>();
  for (const tool of tools) {
    const list = buckets.get(tool.domain) || [];
    list.push(tool);
    buckets.set(tool.domain, list);
  }
  for (const list of buckets.values()) {
    list.sort((a, b) => {
      const ra = RISK_ORDER.indexOf(a.risk);
      const rb = RISK_ORDER.indexOf(b.risk);
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name, 'zh-Hans-CN');
    });
  }
  const known = DOMAIN_ORDER.filter(domain => buckets.has(domain)).map(domain => ({
    domain,
    tools: buckets.get(domain)!,
  }));
  const unknown = Array.from(buckets.keys())
    .filter(domain => !(DOMAIN_ORDER as readonly string[]).includes(domain))
    .sort()
    .map(domain => ({ domain, tools: buckets.get(domain)! }));
  return [...known, ...unknown];
}

export function normalizeAgentManifestResponse(payload: any): AgentToolCatalog | null {
  if (!payload || typeof payload !== 'object') return null;
  const tools = Array.isArray(payload.tools) ? payload.tools : null;
  if (!tools) return null;
  const cleaned: AgentToolManifestEntry[] = tools
    .map((raw: any): AgentToolManifestEntry | null => {
      if (!raw || typeof raw.id !== 'string') return null;
      const safety = raw.safety && typeof raw.safety === 'object' ? raw.safety : { approval: 'never', sideEffects: false };
      return {
        id: raw.id,
        name: typeof raw.name === 'string' && raw.name ? raw.name : raw.id,
        domain: typeof raw.domain === 'string' ? raw.domain : 'unknown',
        risk: (RISK_ORDER as readonly string[]).includes(raw.risk) ? raw.risk : 'low',
        description: typeof raw.description === 'string' ? raw.description : '',
        inputHint: typeof raw.inputHint === 'string' ? raw.inputHint : undefined,
        inputSchema: raw.inputSchema && typeof raw.inputSchema === 'object' ? raw.inputSchema : undefined,
        outputSchema: raw.outputSchema && typeof raw.outputSchema === 'object' ? raw.outputSchema : undefined,
        permissions: raw.permissions && typeof raw.permissions === 'object' ? raw.permissions : undefined,
        safety: {
          approval: safety.approval === 'always' || safety.approval === 'risk_based' ? safety.approval : 'never',
          sideEffects: Boolean(safety.sideEffects),
          editableFields: Array.isArray(safety.editableFields) ? safety.editableFields.filter((f: any) => typeof f === 'string') : undefined,
        },
        examples: Array.isArray(raw.examples) ? raw.examples.filter((e: any) => e && typeof e.user === 'string') : undefined,
      };
    })
    .filter((tool: AgentToolManifestEntry | null): tool is AgentToolManifestEntry => Boolean(tool));

  const summary: AgentToolManifestSummary = {
    total: cleaned.length,
    byDomain: payload.summary?.byDomain && typeof payload.summary.byDomain === 'object' ? payload.summary.byDomain : {},
    byRisk: payload.summary?.byRisk && typeof payload.summary.byRisk === 'object' ? payload.summary.byRisk : {},
    approvalRequired: Array.isArray(payload.summary?.approvalRequired) ? payload.summary.approvalRequired : [],
  };

  return {
    schemaVersion: typeof payload.schemaVersion === 'string' ? payload.schemaVersion : 'unknown',
    generatedAt: typeof payload.generatedAt === 'string' ? payload.generatedAt : new Date().toISOString(),
    tools: cleaned,
    summary,
    groupedByDomain: groupToolsByDomain(cleaned),
  };
}

export const AGENT_DOMAIN_LABELS: Record<string, { label: string; hint: string }> = {
  orders: { label: '订单', hint: '查订单 / PO 详情 / 跨期对比' },
  products: { label: '商品 / 面料', hint: 'SKU / 品名 / 认证 / 成分' },
  relations: { label: '关系网', hint: '客户 / 供应商 / 联系人' },
  entities: { label: '实体检索', hint: '跨域统一搜索 + 详情拉取' },
  knowledge: { label: '业务知识', hint: '规则 / SOP / 历史经验' },
  unknown: { label: '其他', hint: '尚未归类的工具' },
};

export function getDomainLabel(domain: string): { label: string; hint: string } {
  return AGENT_DOMAIN_LABELS[domain] || { label: domain || '未知', hint: '' };
}
