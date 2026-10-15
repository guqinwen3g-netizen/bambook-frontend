/**
 * 工具注册表。每个工具声明风险等级与确认策略；harness 据此决定直接执行还是先请人确认。
 * P0 只内置无副作用的工具；业务读写（bambook_*）、邮箱、文件、文档工具按分期接入。
 */
import type { ToolSpec } from './types';

export type ToolRisk = 'read' | 'draft' | 'local_write' | 'write' | 'external';
export type ConfirmPolicy = 'never' | 'grouped' | 'each';

export type ToolContext = { signal: AbortSignal; sessionId: string; now: () => Date };

export type ToolDefinition = ToolSpec & {
  risk: ToolRisk;
  /** never：直接执行；grouped：同一表单 / 任务 / 业务对象合并为一次确认；each：逐条确认。 */
  confirm: ConfirmPolicy;
  timeoutMs?: number;
  /** grouped 工具用于合并确认的对象键（如 dev:123）；缺省按工具名分组。 */
  groupKey?: (args: Record<string, unknown>) => string;
  /** 确认卡片上展示给人的摘要。 */
  describe?: (args: Record<string, unknown>) => string;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
};

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(definitions: ToolDefinition[] = []) { for (const d of definitions) this.register(d); }

  register(definition: ToolDefinition) {
    if (!TOOL_NAME.test(definition.name)) throw new Error(`invalid tool name ${definition.name}`);
    if (this.tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`);
    if ((definition.risk === 'write' || definition.risk === 'external') && definition.confirm === 'never') throw new Error(`tool ${definition.name} must require confirmation`);
    if (definition.risk === 'external' && definition.confirm !== 'each') throw new Error(`external tool ${definition.name} must confirm each call`);
    this.tools.set(definition.name, definition);
  }

  get(name: string) { return this.tools.get(name); }
  specs(): ToolSpec[] { return [...this.tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters })); }
  list() { return [...this.tools.values()]; }
}

/** 轻量参数校验：只检查对象形状与必填字段，类型细节交给工具自身。 */
export function parseToolArguments(raw: string, spec: ToolSpec): Record<string, unknown> {
  let value: unknown;
  try { value = raw.trim() ? JSON.parse(raw) : {}; } catch { throw new Error('工具参数不是有效 JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('工具参数须为对象');
  const required = Array.isArray((spec.parameters as any)?.required) ? (spec.parameters as any).required as string[] : [];
  const missing = required.filter(key => (value as Record<string, unknown>)[key] === undefined);
  if (missing.length) throw new Error(`缺少参数：${missing.join('、')}`);
  return value as Record<string, unknown>;
}

export const builtinTools = (): ToolDefinition[] => [
  {
    name: 'current_time',
    description: '读取业务员本机的当前日期、时间与时区。需要判断今天、截止日或时间先后时使用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    risk: 'read',
    confirm: 'never',
    run: async (_args, ctx) => {
      const now = ctx.now();
      return { iso: now.toISOString(), local: now.toLocaleString('zh-CN', { hour12: false }), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    },
  },
];
