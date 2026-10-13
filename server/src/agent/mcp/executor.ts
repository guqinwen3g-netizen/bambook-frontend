import { PrismaClient } from '@prisma/client';
import { ActorContext, KnowledgeHit } from '../types';
import { AiEmit } from '../../ai/runtime';
import { PlannedToolCall, runAgentToolCalls } from '../toolRuntime';
import { AgentPlan, AgentPlanStep } from './types';
import { AgentTaskFrame } from '../taskFrame';
import { logger } from '../../lib/logger';

export async function runMcpPlan(input: {
  prisma: PrismaClient;
  actor: ActorContext;
  plan: AgentPlan;
  sessionId?: string;
  actorUserId?: string;
  requestSource?: 'user-session' | 'api-key' | 'dev';
  taskFrame?: AgentTaskFrame;
  emitStep?: (message: string) => void;
  emit?: AiEmit;
}): Promise<KnowledgeHit[]> {
  const calls = input.plan.steps
    .slice(0, 6)
    .map(stepToToolCall)
    .filter(Boolean) as PlannedToolCall[];

  // ── Diagnostic: log planned tool calls ──
  logger.debug(`[runMcpPlan] plan.steps=${input.plan.steps.length} calls=${calls.length} toolIds=[${calls.map(c => c.toolId).join(',')}] source=${input.requestSource || '?'} userId=${input.actorUserId || '?'}`);

  return runAgentToolCalls({
    prisma: input.prisma,
    actor: input.actor,
    calls,
    sessionId: input.sessionId,
    actorUserId: input.actorUserId,
    requestSource: input.requestSource,
    taskFrame: input.taskFrame,
    emitStep: input.emitStep,
    emit: input.emit,
  });
}

function stepToToolCall(step: AgentPlanStep): PlannedToolCall | null {
  if (!step.toolId || !step.input || typeof step.input !== 'object') return null;
  return {
    toolId: step.toolId,
    input: step.input,
    reason: step.reason || step.expectedUse || `Agent plan step ${step.id}`,
  };
}
