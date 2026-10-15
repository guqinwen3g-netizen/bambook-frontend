/**
 * 平台 AI 模型配置（第二层：平台侧固定流程）。
 *
 * 报价审阅、自动汇总、需求识别、财务对账、业务问答等都使用同一个平台模型连接，
 * 按功能档位分配推理强度。测试期平台连接为管理员连接的 ChatGPT 订阅；生产期改用企业 API
 * （ARK_* / BAMBOOK_LLM_BACKUP* provider 链）。个人订阅不参与平台 AI。
 */
import { CODEX_REASONING_EFFORTS, type CodexReasoningEffort } from './codexSubscription';

export const PLATFORM_AI_PROFILES = {
  'quote-review': { label: '报价 AI 审阅', reasoning: 'max' },
  'assistant-chat': { label: '业务问答（小竹）', reasoning: 'medium' },
  summary: { label: '自动汇总与需求识别', reasoning: 'medium' },
  reconciliation: { label: '财务对账', reasoning: 'high' },
} as const satisfies Record<string, { label: string; reasoning: CodexReasoningEffort }>;

export type PlatformAiProfile = keyof typeof PLATFORM_AI_PROFILES;

/** 档位推理强度：可用 BAMBOOK_PLATFORM_REASONING_<PROFILE>（如 _QUOTE_REVIEW=high）覆盖。 */
export function platformReasoning(profile: PlatformAiProfile, env: NodeJS.ProcessEnv = process.env): CodexReasoningEffort {
  const override = env[`BAMBOOK_PLATFORM_REASONING_${profile.toUpperCase().replace(/-/g, '_')}`]?.trim() as CodexReasoningEffort | undefined;
  return override && CODEX_REASONING_EFFORTS.includes(override) ? override : PLATFORM_AI_PROFILES[profile].reasoning;
}

export function platformProfileList(env: NodeJS.ProcessEnv = process.env) {
  return (Object.keys(PLATFORM_AI_PROFILES) as PlatformAiProfile[]).map(id => ({ id, label: PLATFORM_AI_PROFILES[id].label, reasoning: platformReasoning(id, env) }));
}
