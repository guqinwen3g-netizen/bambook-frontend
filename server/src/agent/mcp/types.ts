import { ToolRisk } from '../types';

export type ToolManifestSafety = {
  /**
   * 是否需要审批后才能执行。
   * - 'never'：只读工具，绝不进入审批队列
   * - 'risk_based'：根据 risk 字段判定（high/critical 必走 ApprovalRequest）
   * - 'always'：哪怕 low 也强制审批（保留给将来的写动作）
   */
  approval: 'never' | 'risk_based' | 'always';
  /** 该工具是否会修改外部系统 / 写库 / 发邮件等。runtime 用来兜底拦截。 */
  sideEffects: boolean;
  /** 哪些参数允许在审批"修改参数"时被覆盖，未列出的字段会被拒绝。 */
  editableFields?: string[];
  /** gap-closure: dispatch fail-closed, no pseudo-success. */
  failClosed?: boolean;
  /** stable error code returned when fail-closed (e.g. NOT_IMPLEMENTED). */
  failClosedCode?: string;
};

export type ToolManifest = {
  id: string;
  /** LLM/UI 友好的可读名（与 ToolDescriptor.name 对齐）。 */
  name: string;
  /** 业务域（products / orders / relations / knowledge / entities）。 */
  domain: string;
  risk: ToolRisk;
  description: string;
  /** 简短的 input 形态提示，与 LLM ToolDescriptor.inputHint 同源。 */
  inputHint?: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  permissions: {
    scope: string;
    allowedRoles: string[];
  };
  safety: ToolManifestSafety;
  examples: Array<{
    user: string;
    input: Record<string, unknown>;
  }>;
};

export type AgentPlanStep = {
  id: string;
  toolId: string;
  input: Record<string, unknown>;
  reason: string;
  dependsOn: string[];
  expectedUse: string;
};

export type AgentPlan = {
  planner: 'rules' | 'model-json' | 'fallback';
  degraded: boolean;
  steps: AgentPlanStep[];
};
