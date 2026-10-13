// agentLoop：真 Agent 的核心循环。
//
//   plan → tool call → observe → reflect → ...（直到 final_answer / 用尽预算）
//
// 与旧 orchestrator 的区别：
//   - orchestrator 是"识别身份 → 检索 → 单轮回答"（无循环）。
//   - agentLoop 是"LLM 驱动的多步循环"，LLM 自己决定每步要查什么。
//
// 与 toolRuntime.runAgentToolCalls 的区别：
//   - runAgentToolCalls 用关键词正则做 plan + 硬编码 follow-up 规则。
//   - agentLoop 把 plan 完全交给 LLM；这里只负责调度、超时、policy、事件流。

import {
  AgentLoopConfig,
  AgentLoopInput,
  AgentLoopResult,
  IterationTrace,
  LLMCompleter,
  Scratchpad,
  ToolDescriptor,
  ToolExecutionRecord,
  ToolExecutor,
} from './agentLoopTypes';
import { AGENT_LOOP_LIMITS } from './defaults';
import { AgentCheckpoint, CheckpointManager, generateCheckpointId, PendingApprovalRecord } from './checkpoint';
import { emitAgentWorkEvent, approvalEventBus, formEventBus } from './events';
import { buildOrderConfirmError } from './feedbackContract';
import { buildAgentSystemPrompt, buildAgentUserMessages, forceFinalAnswer, planNextStep } from './llmPlanner';
import { getToolOutcome } from './toolOutcome';
import { createAgentControlFailure, logAgentFailure, publicAgentFailure } from './publicFailure';

function caughtFailure(error: unknown): string {
  const failure = publicAgentFailure(error);
  logAgentFailure('[agent-loop] execution failed', error);
  return failure;
}

/**
 * 创建一个 agentLoop 实例。
 *
 * 依赖通过参数注入（LLMCompleter / ToolExecutor），方便测试中替换为 stub。
 */
/**
 * 批次 2b：审批决议快照——resume 时从 ApprovalRequest（决议真源）读取。
 * status 即 ApprovalRequest.status（'pending' | 'approved' | 'rejected' | 'modified'）。
 */
export type ApprovalResolutionSnapshot = {
  status: string;
  decisionNote?: string | null;
  modifiedInput?: Record<string, unknown>;
};

/**
 * 挂起等待审批决议（进程内 eventBus 订阅 + 超时）。
 * 挂起点与 resume 重挂起点共用同一等待语义。
 */
function awaitApprovalResolution(approvalId: string, signal: AbortSignal,
  resolver: ((id: string) => Promise<ApprovalResolutionSnapshot | null>) | undefined,
  timeoutMs = 15 * 60 * 1000): Promise<ApprovalResolutionSnapshot> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let reading = false;
    let reread = false;
    const cleanup = () => {
      settled = true; clearTimeout(timeoutId);
      approvalEventBus.off('resolved', handler);
      signal.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error) => { if (!settled) { cleanup(); reject(error); } };
    const onAbort = () => fail(createAgentControlFailure('APPROVAL_ABORTED'));
    const timeoutId = setTimeout(() => {
      fail(createAgentControlFailure('APPROVAL_WAIT_TIMEOUT'));
    }, timeoutMs);
    const check = async () => {
      if (settled) return;
      if (reading) { reread = true; return; }
      if (!resolver) { fail(createAgentControlFailure('APPROVAL_STATE_UNAVAILABLE')); return; }
      reading = true;
      try {
        do {
          reread = false;
          const snapshot = await resolver(approvalId);
          if (settled) return;
          if (signal.aborted) { onAbort(); return; }
          if (!snapshot || !['pending', 'approved', 'rejected', 'modified'].includes(snapshot.status)) {
            fail(createAgentControlFailure('APPROVAL_STATE_UNAVAILABLE')); return;
          }
          if (snapshot.status !== 'pending') { cleanup(); resolve(snapshot); return; }
        } while (reread && !settled);
      } catch (error) {
        const failure = createAgentControlFailure('APPROVAL_STATE_UNAVAILABLE');
        logAgentFailure('[agent-loop] approval state read failed', error);
        fail(failure);
      } finally {
        reading = false;
      }
    };
    // Events only wake this reader. Subscribe before reading to close the query/subscription race.
    const handler = (id: string) => { if (id === approvalId) void check(); };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort);
    approvalEventBus.on('resolved', handler);
    void check();
  });
}

export function createAgentLoop(deps: {
  llm: LLMCompleter;
  toolExecutor: ToolExecutor;
  /** 暴露给 LLM 的工具白名单——agentLoop 只会让 LLM 选择这里面的工具。 */
  availableTools: ToolDescriptor[];
  /** 可选：checkpoint 管理器，启用断点续传。不传则无 checkpoint 能力（向后兼容）。 */
  checkpointManager?: CheckpointManager;
  /** 可选：跨会话记忆装载器——run 开始时 recall 注入系统提示词。异常降级为空（不阻断对话）。 */
  memoryLoader?: (actor: AgentLoopInput['actor']) => Promise<Array<{ scope: string; memoryType: string; content: string }>>;
  /**
   * 批次 2b：可选审批决议查询器——resume 时查 ApprovalRequest（决议真源）。
   * 返回 null 或 status='pending' 表示未决议（重新挂起等待）。
   */
  approvalResolver?: (approvalId: string) => Promise<ApprovalResolutionSnapshot | null>;
  /** Only actual canonical receipt gates may retry a previously suspended tool. */
  canResumeApprovalTool?: (toolId: string) => boolean;
}) {
  const toolWhitelist = new Set(deps.availableTools.map(t => t.id));

  async function run(input: AgentLoopInput): Promise<AgentLoopResult> {
    const config = resolveConfig(input.config);
    const scratchpad: Scratchpad = { thoughts: [], toolCalls: [] };
    const iterations: IterationTrace[] = [];
    const startedAt = Date.now();
    const seenSignatures = new Set<string>();
    const emitStructuredFailure = (toolId: string, step: number, callId: string, output: unknown, error: string) => {
      const value = output as { errorFeedback?: Record<string, unknown> };
      const original = value?.errorFeedback && typeof value.errorFeedback === 'object' ? value.errorFeedback : {};
      const feedback = { ...original, code: typeof original.code === 'string' ? original.code : 'TOOL_FAILED',
        message: typeof original.message === 'string' ? original.message : error };
      emitAgentWorkEvent(input.emit, { phase: 'tool_call_end', status: 'failed', toolId,
        title: `${humanizeToolName(toolId)}未完成`, message: error, metadata: { step, callId, toolId, ok: false,
          error: feedback, ...(toolId === 'order.confirm' ? { errorPreview: feedback } : {}), output } });
    };
    const halt = (reason: string, stopReason: AgentLoopResult['stopReason'] = 'recovery_required'): AgentLoopResult => {
      const text = `结果待核对：${reason}。本轮已停止后续工具；请核对原审批及实际业务结果。`;
      emitAgentWorkEvent(input.emit, { phase: 'final_answer', status: 'failed', title: '结果待核对', message: text,
        metadata: { stopReason } });
      return { text, iterations, sources: buildSourcesFromScratchpad(scratchpad),
        thoughtProcess: buildThoughtProcess(input, scratchpad, text, stopReason), stopReason };
    };

    // ── checkpoint resume：尝试恢复上次中断的状态 ──
    let resumeStep = 1;
    let resumedPendingApproval: PendingApprovalRecord | null = null;
    const conversationId = input.conversationId;
    if (deps.checkpointManager && conversationId) {
      let ckpt: AgentCheckpoint | null;
      try { ckpt = await deps.checkpointManager.load(conversationId); }
      catch { return halt('恢复点读取未获确认', 'outcome_unknown'); }
      if (ckpt && ckpt.step >= 1) {
        scratchpad.thoughts = ckpt.scratchpad.thoughts || [];
        scratchpad.toolCalls = (ckpt.scratchpad.toolCalls as ToolExecutionRecord[] || []).map(call =>
          call.ok === false && typeof call.error === 'string' ? { ...call, error: publicAgentFailure(call.error) } : call);
        resumeStep = ckpt.step + 1;
        resumedPendingApproval = ckpt.pendingApproval ?? null;
        emitAgentWorkEvent(input.emit, {
          phase: 'checkpoint_resumed',
          status: 'running',
          title: `从第 ${ckpt.step} 步恢复`,
          message: `检测到上次中断的 checkpoint，从第 ${resumeStep} 步继续。`,
          metadata: { resumedFromStep: ckpt.step, resumeStep },
        });
      }
    }

    // ══ 批次 2b：挂起审批恢复 ══
    // 挂起期间进程崩溃/重启：pendingApproval 已随 checkpoint 落库。
    // 恢复时查 ApprovalRequest（决议真源）：
    //   已决议 → 补执行（approved/modified 执行工具，rejected 记失败）进 scratchpad
    //   未决议 → 重建 eventBus 订阅重新挂起（重启后内存订阅已丢失）
    if (resumedPendingApproval) {
      const pa = resumedPendingApproval;
      emitAgentWorkEvent(input.emit, {
        phase: 'approval_resume',
        status: 'running',
        title: '恢复挂起中的审批',
        message: `检测到未完成的审批（挂起于第 ${pa.step} 步，工具 ${humanizeToolName(pa.toolId)}），正在检查决议状态。`,
        metadata: { approvalId: pa.approvalId, step: pa.step, toolId: pa.toolId },
      });

      let snapshot: ApprovalResolutionSnapshot;
      try { snapshot = await awaitApprovalResolution(pa.approvalId, input.signal, deps.approvalResolver); }
      catch (err: any) { return halt(caughtFailure(err)); }

      if (snapshot && snapshot.status !== 'pending') {
        // 已决议 → 补执行并记录进 scratchpad（LLM 上下文完整）
        const replayT0 = Date.now();
        if (snapshot.status === 'rejected') {
          scratchpad.toolCalls.push({
            callId: `resume_appr_${pa.approvalId}`,
            step: pa.step,
            toolId: pa.toolId,
            input: pa.toolInput,
            why: pa.why,
            ok: false,
            error: `APPROVAL_REJECTED: ${snapshot.decisionNote || 'User rejected the operation'}`,
            durationMs: Date.now() - replayT0,
            startedAt: pa.suspendedAt,
          });
        } else {
          if (!deps.canResumeApprovalTool?.(pa.toolId)) return halt('旧审批工具没有可核验的提交回执门禁');
          const replayInput = snapshot.status === 'modified' && snapshot.modifiedInput
            ? snapshot.modifiedInput
            : pa.toolInput;
          try {
            const replayOutput = await runWithTimeout(
              signal => deps.toolExecutor({
                toolId: pa.toolId,
                input: replayInput,
                actor: input.actor,
                signal,
                skipApprovalCheck: true,
                approvalId: pa.approvalId,
              }),
              config.perToolTimeoutMs,
              input.signal,
            );
            const outcome = getToolOutcome(replayOutput, pa.toolId);
            const failure = outcome.status === 'failed' ? outcome.error : null;
            scratchpad.toolCalls.push({
              callId: `resume_appr_${pa.approvalId}`,
              step: pa.step,
              toolId: pa.toolId,
              input: replayInput,
              why: pa.why,
              ok: !failure,
              ...(failure ? { error: failure } : {}),
              output: replayOutput,
              durationMs: Date.now() - replayT0,
              startedAt: pa.suspendedAt,
            } as ToolExecutionRecord);
            if (failure) { emitStructuredFailure(pa.toolId, pa.step, `resume_appr_${pa.approvalId}`, replayOutput, failure); return halt(failure); }
          } catch (err: any) {
            scratchpad.toolCalls.push({
              callId: `resume_appr_${pa.approvalId}`,
              step: pa.step,
              toolId: pa.toolId,
              input: replayInput,
              why: pa.why,
              ok: false,
              error: caughtFailure(err),
              durationMs: Date.now() - replayT0,
              startedAt: pa.suspendedAt,
            } as ToolExecutionRecord);
            return halt('已批准工具的执行结果未获确认', 'outcome_unknown');
          }
        }
        emitAgentWorkEvent(input.emit, {
          phase: 'approval_resume',
          status: 'complete',
          title: '挂起审批已恢复',
          message: `审批决议为 ${snapshot.status}，已按决议${snapshot.status === 'rejected' ? '记录拒绝结果' : '补执行工具'}。`,
          metadata: { approvalId: pa.approvalId, decision: snapshot.status, step: pa.step },
        });
      }
      // Save the actual result before any following plan/tool can overwrite the pending point.
      try {
        await deps.checkpointManager!.save({ id: generateCheckpointId(), conversationId: conversationId!, step: pa.step,
          message: input.message, scratchpad: { thoughts: scratchpad.thoughts, toolCalls: scratchpad.toolCalls as any },
          iterations: iterations as any, pendingApproval: null, createdAt: new Date().toISOString() });
      } catch { return halt('原工具结果的恢复记录未获确认', 'outcome_unknown'); }
    }

    const systemPrompt = buildAgentSystemPrompt({
      actor: input.actor,
      tools: deps.availableTools,
      maxToolsPerStep: config.maxToolsPerStep,
      memories: deps.memoryLoader
        ? await deps.memoryLoader(input.actor).catch(() => [])
        : [],
    });

    const emit = input.emit;
    let stopReason: AgentLoopResult['stopReason'] = 'max_steps';
    let finalText: string | null = null;

    // 流式 delta seq——整个会话单调递增
    let deltaSeq = 0;
    const nextSeq = () => deltaSeq++;

    for (let step = resumeStep; step <= config.maxSteps; step++) {
      // 预算检查：在每一步开始时判断
      if (Date.now() - startedAt > config.totalBudgetMs) {
        stopReason = 'budget_exhausted';
        break;
      }
      if (input.signal.aborted) {
        stopReason = 'aborted';
        break;
      }

      const stepStartedAt = new Date().toISOString();
      emitAgentWorkEvent(emit, {
        phase: 'iteration_start',
        status: 'running',
        title: `第 ${step} 步开始`,
        message: `Agent 进入第 ${step} 步推理。`,
        metadata: { step },
      });

      const userMessages = buildAgentUserMessages({
        message: input.message,
        history: input.history,
        attachmentContext: input.attachmentContext,
        scratchpad,
      });

      // ── 让 LLM 决定本步做什么 ──
      let turn;
      try {
        turn = await planNextStep({
          systemPrompt,
          userMessages,
          llm: deps.llm,
          model: input.model,
          temperature: input.temperature,
          signal: input.signal,
          toolWhitelist,
          maxToolsPerStep: config.maxToolsPerStep,
          repairRetries: config.llmRepairRetries,
          onThoughtDelta: emit ? (chunk) => {
            emitAgentWorkEvent(emit, {
              phase: 'thought_delta', status: 'running',
              title: `第 ${step} 步思考中`, message: chunk,
              metadata: { step, delta: chunk, seq: nextSeq() },
            });
          } : undefined,
          onAnswerDelta: emit ? (chunk) => {
            emitAgentWorkEvent(emit, {
              phase: 'answer_delta', status: 'running',
              title: '生成回答中', message: chunk,
              metadata: { step, delta: chunk, seq: nextSeq() },
            });
          } : undefined,
        });
      } catch (err: any) {
        const failure = caughtFailure(err);
        emitAgentWorkEvent(emit, {
          phase: 'error',
          status: 'failed',
          title: 'LLM 决策失败',
          message: failure,
          metadata: { step, error: { code: 'llm_failure', message: failure } },
        });
        stopReason = 'llm_failure';
        break;
      }

      // ── 落 thought 到 scratchpad + emit ──
      scratchpad.thoughts.push({ step, content: turn.thought });
      emitAgentWorkEvent(emit, {
        phase: 'thought',
        status: 'complete',
        title: `第 ${step} 步思考`,
        message: turn.thought,
        summary: truncate(turn.thought, 120),
        metadata: { step, thought: turn.thought },
      });
      // thought 段结束标记
      if (emit) {
        emitAgentWorkEvent(emit, {
          phase: 'thought_end', status: 'complete',
          title: `第 ${step} 步思考完成`, message: '思考段结束',
          metadata: { step, seq: nextSeq() },
        });
      }

      // ── 终止：LLM 决定收尾 ──
      if (turn.action === 'final_answer') {
        finalText = turn.finalAnswer;
        emitAgentWorkEvent(emit, {
          phase: 'final_answer',
          status: 'complete',
          title: '生成最终回答',
          message: truncate(turn.finalAnswer, 240),
          summary: truncate(turn.finalAnswer, 120),
          metadata: { step, finalAnswer: turn.finalAnswer },
        });
        // answer 段结束标记
        if (emit) {
          emitAgentWorkEvent(emit, {
            phase: 'answer_end', status: 'complete',
            title: '回答生成完成', message: '回答段结束',
            metadata: { step, seq: nextSeq() },
          });
        }
        iterations.push({
          step,
          startedAt: stepStartedAt,
          endedAt: new Date().toISOString(),
          thought: turn.thought,
          action: 'final_answer',
          toolCalls: [],
          finalAnswer: turn.finalAnswer,
        });
        emitAgentWorkEvent(emit, {
          phase: 'iteration_end',
          status: 'complete',
          title: `第 ${step} 步结束`,
          message: '本步完成。',
          metadata: { step },
        });
        stopReason = 'final_answer';
        break;
      }

      // ── action='request_form'：向用户发起表单交互 ──
      if (turn.action === 'request_form') {
        const formId = `form_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        emitAgentWorkEvent(emit, {
          phase: 'form_request',
          status: 'blocked',
          title: turn.formTitle,
          message: turn.formDescription || '请填写以下信息',
          metadata: {
            step,
            formId,
            fields: turn.fields,
            submitLabel: turn.submitLabel,
          },
        });

        // 挂起等待用户提交
        let formSubmission: Record<string, unknown> | null = null;
        try {
          formSubmission = await new Promise((resolve, reject) => {
            const onAbort = () => {
              clearTimeout(timeoutId);
              formEventBus.off('submitted', handler);
              reject(new Error('ABORTED'));
            };
            const timeoutId = setTimeout(() => {
              formEventBus.off('submitted', handler);
              input.signal.removeEventListener('abort', onAbort);
              resolve(null);
            }, 15 * 60 * 1000);
            const handler = (id: string, values: Record<string, unknown>) => {
              if (id === formId) {
                clearTimeout(timeoutId);
                formEventBus.off('submitted', handler);
                input.signal.removeEventListener('abort', onAbort);
                resolve(values);
              }
            };
            if (input.signal.aborted) { onAbort(); return; }
            input.signal.addEventListener('abort', onAbort);
            formEventBus.on('submitted', handler);
          });
        } catch {
          stopReason = 'aborted';
          break;
        }

        if (formSubmission === null) {
          // 超时，继续循环让 LLM 用已有信息收尾
          scratchpad.thoughts.push({ step, content: `${turn.thought}\n[表单交互超时，用户未提交]` });
        } else {
          // 把用户提交的值作为 observation 灌入 scratchpad
          const fieldSummary = turn.fields.map(f => {
            const val = formSubmission[f.key];
            return val != null && String(val).trim() ? `${f.label}: ${String(val)}` : `${f.label}: (未填)`;
          }).join('\n');
          scratchpad.thoughts.push({ step, content: `${turn.thought}\n[用户通过表单提交了以下信息]\n${fieldSummary}` });
          scratchpad.toolCalls.push({
            callId: `form_${formId}`,
            step,
            toolId: 'user_form_input',
            input: formSubmission,
            why: '用户通过交互式表单提交的信息',
            ok: true,
            output: formSubmission,
            durationMs: 0,
            startedAt: new Date().toISOString(),
          });
        }

        emitAgentWorkEvent(emit, {
          phase: 'iteration_end',
          status: 'complete',
          title: `第 ${step} 步结束`,
          message: '表单交互完成，继续工作。',
          metadata: { step },
        });
        continue;
      }

      // ── action='call_tool' ──
      emitAgentWorkEvent(emit, {
        phase: 'plan',
        status: 'running',
        title: `第 ${step} 步计划`,
        message: `我准备${turn.toolCalls.map(c => humanizeToolName(c.toolId)).join('、')}`,
        metadata: {
          step,
          plan: turn.toolCalls.map(c => ({ toolId: c.toolId, input: c.input, why: c.why })),
        },
      });

      const stepRecords: ToolExecutionRecord[] = [];
      for (const call of turn.toolCalls) {
        if (input.signal.aborted) break;
        if (Date.now() - startedAt > config.totalBudgetMs) break;

        // 去重：同一 toolId + 同一 input 不重复执行
        const signature = `${call.toolId}:${stableStringify(call.input)}`;
        if (seenSignatures.has(signature)) {
          const callId = newCallId(step);
          const record: ToolExecutionRecord = {
            callId,
            step,
            toolId: call.toolId,
            input: call.input,
            why: call.why,
            ok: false,
            error: 'DEDUPED: 该工具+入参组合本轮已经调用过',
            durationMs: 0,
            startedAt: new Date().toISOString(),
          };
          scratchpad.toolCalls.push(record);
          stepRecords.push(record);
            emitAgentWorkEvent(emit, {
              phase: 'tool_call_end',
              status: 'failed',
              title: `${humanizeToolName(call.toolId)}跳过（已执行过）`,
              message: '同一工具+入参组合本轮已经调用过；基于已有结果推进。',
              toolId: call.toolId,
              metadata: { step, callId, toolId: call.toolId, ok: false, durationMs: 0, error: { code: 'deduped', message: 'duplicate tool call' } },
            });
          continue;
        }
        seenSignatures.add(signature);

        const callId = newCallId(step);
        const callStartedAtIso = new Date().toISOString();
        emitAgentWorkEvent(emit, {
          phase: 'tool_call_start',
          status: 'running',
          title: `正在${humanizeToolName(call.toolId)}`,
          message: call.why || humanizeToolName(call.toolId),
          toolId: call.toolId,
          metadata: { step, callId, toolId: call.toolId, input: call.input, why: call.why },
        });

        const t0 = Date.now();
        try {
          const output = await runWithTimeout(
            signal => deps.toolExecutor({
              toolId: call.toolId,
              input: call.input,
              actor: input.actor,
              signal,
            }),
            config.perToolTimeoutMs,
            input.signal,
          );
          const durationMs = Date.now() - t0;

          // ── 审批拦截检测 ──
          // executeAgentTool 对 high-risk 工具返回 { approvalRequired: true, approvalId, risk }
          // 而不是 throw。这里检测到后 emit blocked + approval block，然后提前结束循环。
          const outputObj = output as any;
          if (outputObj && outputObj.approvalRequired) {
            if (!deps.checkpointManager || !conversationId || typeof outputObj.approvalId !== 'string' || !outputObj.approvalId.trim()) {
              return halt('审批恢复点的持久化条件未获确认', 'outcome_unknown');
            }
            // 批次 2b：挂起先落库——pendingApproval 随 checkpoint 持久化，
            // 进程崩溃/重启后 resume 据此查 ApprovalRequest 决议补执行或重新等待
            if (deps.checkpointManager && conversationId) {
              try { await deps.checkpointManager.save({
                id: generateCheckpointId(),
                conversationId,
                step,
                message: input.message,
                scratchpad: {
                  thoughts: scratchpad.thoughts,
                  toolCalls: scratchpad.toolCalls as any,
                },
                iterations: iterations as any,
                pendingApproval: {
                  approvalId: String(outputObj.approvalId),
                  step,
                  toolId: call.toolId,
                  toolInput: call.input,
                  why: call.why,
                  suspendedAt: new Date().toISOString(),
                },
                createdAt: new Date().toISOString(),
              }); } catch { return halt('审批恢复点保存未获确认', 'outcome_unknown'); }
            }

            // emit blocked 事件（events.ts 会据此发射 approval block）
            emitAgentWorkEvent(emit, {
              phase: 'tool_call',
              status: 'blocked',
              title: `${humanizeToolName(call.toolId)}需要审批确认`,
              message: outputObj.message || `${humanizeToolName(call.toolId)}需要审批后才能执行。`,
              toolId: call.toolId,
              summary: '等待审批确认',
              metadata: {
                step,
                callId,
                toolId: call.toolId,
                input: call.input,
                reason: call.why,
                risk: outputObj.risk || 'high',
                approvalId: outputObj.approvalId,
                editableFields: outputObj.editableFields,
              },
            }, { legacyStep: false });

            // 挂起等待审批结果（helper 与 resume 重挂起共用同一等待语义）
            let resolution: ApprovalResolutionSnapshot;
            try {
              resolution = await awaitApprovalResolution(outputObj.approvalId, input.signal, deps.approvalResolver);
            } catch (err: any) {
              const record: ToolExecutionRecord = {
                callId,
                step,
                toolId: call.toolId,
                input: call.input,
                why: call.why,
                ok: false,
                error: `APPROVAL_FAILED: ${caughtFailure(err)}`,
                durationMs: Date.now() - t0,
                startedAt: callStartedAtIso,
              };
              scratchpad.toolCalls.push(record);
              stepRecords.push(record);
              return halt(caughtFailure(err));
            }

            if (resolution.status === 'rejected') {
              const record: ToolExecutionRecord = {
                callId,
                step,
                toolId: call.toolId,
                input: call.input,
                why: call.why,
                ok: false,
                error: `APPROVAL_REJECTED: ${resolution.decisionNote || 'User rejected the operation'}`,
                durationMs: Date.now() - t0,
                startedAt: callStartedAtIso,
              };
              scratchpad.toolCalls.push(record);
              stepRecords.push(record);
              
              emitAgentWorkEvent(emit, {
                phase: 'tool_call_end',
                status: 'failed',
                title: `${humanizeToolName(call.toolId)}被拒绝`,
                message: '用户拒绝了此操作',
                toolId: call.toolId,
                metadata: { step, callId, toolId: call.toolId, ok: false, error: record.error ? { message: record.error } : undefined },
              });
              try { await deps.checkpointManager.save({ id: generateCheckpointId(), conversationId, step, message: input.message,
                scratchpad: { thoughts: scratchpad.thoughts, toolCalls: scratchpad.toolCalls as any }, iterations: iterations as any,
                pendingApproval: null, createdAt: new Date().toISOString() }); }
              catch { return halt('拒绝结果的恢复记录未获确认', 'outcome_unknown'); }
              continue;
            }

            // 被批准或修改参数后，继续执行！
            const finalInput = resolution.status === 'modified' && resolution.modifiedInput ? resolution.modifiedInput : call.input;
            try {
              const actualOutput = await runWithTimeout(
                signal => deps.toolExecutor({
                  toolId: call.toolId,
                  input: finalInput,
                  actor: input.actor,
                  signal,
                  skipApprovalCheck: true,
                  // P1-A: 显式携带 approvalId，commitTransaction 从 payload 恢复已审批 ProcessDraft
                  approvalId: outputObj.approvalId,
                }),
                config.perToolTimeoutMs,
                input.signal,
              );
              
              const durationMs = Date.now() - t0;
              const outcome = getToolOutcome(actualOutput, call.toolId);
              const failure = outcome.status === 'failed' ? outcome.error : null;
              const record: ToolExecutionRecord = {
                callId,
                step,
                toolId: call.toolId,
                input: finalInput,
                why: call.why,
                ok: !failure,
                ...(failure ? { error: failure } : {}),
                output: actualOutput,
                durationMs,
                startedAt: callStartedAtIso,
              };
              scratchpad.toolCalls.push(record);
              stepRecords.push(record);
              if (failure) { emitStructuredFailure(call.toolId, step, callId, actualOutput, failure); return halt(failure); }
              try { await deps.checkpointManager.save({ id: generateCheckpointId(), conversationId, step, message: input.message,
                scratchpad: { thoughts: scratchpad.thoughts, toolCalls: scratchpad.toolCalls as any }, iterations: iterations as any,
                pendingApproval: null, createdAt: new Date().toISOString() }); }
              catch { return halt('原工具结果的恢复记录未获确认', 'outcome_unknown'); }
              emitAgentWorkEvent(emit, {
                phase: 'tool_call_end',
                status: 'complete',
                title: `${humanizeToolName(call.toolId)}完成`,
                message: summarizeOutput(actualOutput),
                toolId: call.toolId,
                summary: summarizeOutput(actualOutput),
                metadata: { step, callId, toolId: call.toolId, ok: true, durationMs, output: actualOutput, outputPreview: actualOutput },
              });
            } catch (err: any) {
              const durationMs = Date.now() - t0;
              const errorMsg = caughtFailure(err);
              const record: ToolExecutionRecord = {
                callId,
                step,
                toolId: call.toolId,
                input: finalInput,
                why: call.why,
                ok: false,
                error: errorMsg,
                durationMs,
                startedAt: callStartedAtIso,
              };
              scratchpad.toolCalls.push(record);
              stepRecords.push(record);
              // P1-C: 仅 order.confirm 用专用 errorFeedback/errorPreview，其他工具保留通用 tool_error
              const isOrderConfirm = call.toolId === 'order.confirm';
              const orderConfirmErr = isOrderConfirm ? buildOrderConfirmError(errorMsg) : null;
              emitAgentWorkEvent(emit, {
                phase: 'tool_call_end',
                status: 'failed',
                title: `${humanizeToolName(call.toolId)}失败`,
                message: errorMsg,
                toolId: call.toolId,
                summary: '执行失败',
                metadata: isOrderConfirm ? {
                  step, callId, toolId: call.toolId, ok: false, durationMs,
                  error: { code: orderConfirmErr!.code, message: errorMsg, userAction: orderConfirmErr!.userAction, details: orderConfirmErr!.details } as any,
                  errorPreview: orderConfirmErr,
                } : {
                  step, callId, toolId: call.toolId, ok: false, durationMs,
                  error: { code: 'tool_error', message: errorMsg },
                },
              });
              return halt('已批准工具的执行结果未获确认', 'outcome_unknown');
            }

            continue; // 跳过后续普通的 push 逻辑，因为挂起后已经执行完毕
          }

          const outcome = getToolOutcome(output, call.toolId);
          const failure = outcome.status === 'failed' ? outcome.error : null;
          const record: ToolExecutionRecord = {
            callId,
            step,
            toolId: call.toolId,
            input: call.input,
            why: call.why,
            ok: !failure,
            ...(failure ? { error: failure } : {}),
            output,
            durationMs,
            startedAt: callStartedAtIso,
          };
          scratchpad.toolCalls.push(record);
          stepRecords.push(record);
          emitAgentWorkEvent(emit, {
            phase: 'tool_call_end',
            status: failure ? 'failed' : 'complete',
            title: `${humanizeToolName(call.toolId)}${failure ? '未完成' : '完成'}`,
            message: failure || summarizeOutput(output),
            toolId: call.toolId,
            summary: summarizeOutput(output),
            metadata: { step, callId, toolId: call.toolId, ok: !failure, durationMs, output, outputPreview: output,
              ...(failure ? { error: { code: 'TOOL_FAILED', message: failure } } : {}) },
          });
          // A framework refusal does not prove an earlier commit never happened.
          // Preserve the original recovery point and stop the remaining plan.
          if (failure) return halt(failure);
        } catch (err: any) {
          const durationMs = Date.now() - t0;
          const errorMsg = caughtFailure(err);
          const record: ToolExecutionRecord = {
            callId,
            step,
            toolId: call.toolId,
            input: call.input,
            why: call.why,
            ok: false,
            error: errorMsg,
            durationMs,
            startedAt: callStartedAtIso,
          };
          scratchpad.toolCalls.push(record);
          stepRecords.push(record);
          // P1-C: 仅 order.confirm 用专用 errorFeedback/errorPreview，其他工具保留通用 tool_error
          const isOrderConfirmTool = call.toolId === 'order.confirm';
          const orderConfirmErr = isOrderConfirmTool ? buildOrderConfirmError(errorMsg) : null;
          emitAgentWorkEvent(emit, {
            phase: 'tool_call_end',
            status: 'failed',
            title: `${humanizeToolName(call.toolId)}失败`,
            message: errorMsg,
            toolId: call.toolId,
            metadata: isOrderConfirmTool ? {
              step, callId, toolId: call.toolId, ok: false, durationMs,
              error: { message: errorMsg, code: orderConfirmErr!.code, userAction: orderConfirmErr!.userAction, details: orderConfirmErr!.details } as any,
              errorPreview: orderConfirmErr,
            } : {
              step, callId, toolId: call.toolId, ok: false, durationMs,
              error: { code: 'tool_error', message: errorMsg },
            },
          });
        }
      }

      iterations.push({
        step,
        startedAt: stepStartedAt,
        endedAt: new Date().toISOString(),
        thought: turn.thought,
        action: 'call_tool',
        toolCalls: stepRecords,
      });
      emitAgentWorkEvent(emit, {
        phase: 'iteration_end',
        status: 'complete',
        title: `第 ${step} 步结束`,
        message: `本步完成 ${stepRecords.length} 次工具调用。`,
        metadata: { step, toolCount: stepRecords.length },
      });

      // checkpoint 保存：每步执行后持久化状态
      if (deps.checkpointManager && conversationId) {
        try { await deps.checkpointManager.save({
          id: generateCheckpointId(),
          conversationId,
          step,
          message: input.message,
          scratchpad: {
            thoughts: scratchpad.thoughts,
            toolCalls: scratchpad.toolCalls as any,
          },
          iterations: iterations as any,
          createdAt: new Date().toISOString(),
        }); } catch { return halt('本步结果的恢复记录未获确认', 'outcome_unknown'); }
      }

      // 审批拦截：跳出主循环，不再继续执行
      if ((stopReason as string) === 'approval_blocked') break;
    }

    // ── 强制收尾（LLM 没主动 final，或 LLM 解析失败，或预算耗尽）──
    if (finalText == null) {
      const closingMessages = buildAgentUserMessages({
        message: input.message,
        history: input.history,
        attachmentContext: input.attachmentContext,
        scratchpad,
      });
      finalText = await forceFinalAnswer({
        systemPrompt,
        userMessages: closingMessages,
        llm: deps.llm,
        model: input.model,
        temperature: input.temperature,
        signal: input.signal,
        reason: stopReason,
      });
      emitAgentWorkEvent(emit, {
        phase: 'final_answer',
        status: 'complete',
        title: '强制收尾',
        message: truncate(finalText, 240),
        summary: truncate(finalText, 120),
        metadata: { step: iterations.length + 1, finalAnswer: finalText, stopReason, forced: true },
      });
    }

    // checkpoint 清理：正常完成后删除
    if (deps.checkpointManager && conversationId && stopReason === 'final_answer') {
      try { await deps.checkpointManager.clear(conversationId); }
      catch { return halt('恢复点清理结果未获确认', 'outcome_unknown'); }
    }

    return {
      text: finalText,
      iterations,
      sources: buildSourcesFromScratchpad(scratchpad),
      thoughtProcess: buildThoughtProcess(input, scratchpad, finalText, stopReason),
      stopReason,
    };
  }

  return { run };
}

// ─────────────────────────── helpers ───────────────────────────

function resolveConfig(override: Partial<AgentLoopConfig> | undefined): AgentLoopConfig {
  return {
    maxSteps: override?.maxSteps ?? AGENT_LOOP_LIMITS.maxSteps,
    maxToolsPerStep: override?.maxToolsPerStep ?? AGENT_LOOP_LIMITS.maxToolsPerStep,
    perToolTimeoutMs: override?.perToolTimeoutMs ?? AGENT_LOOP_LIMITS.perToolTimeoutMs,
    totalBudgetMs: override?.totalBudgetMs ?? AGENT_LOOP_LIMITS.totalBudgetMs,
    llmRepairRetries: override?.llmRepairRetries ?? AGENT_LOOP_LIMITS.llmRepairRetries,
  };
}

function newCallId(step: number) {
  return `call_${step}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function runWithTimeout<T>(
  task: (signal: AbortSignal) => Promise<T>,
  ms: number,
  parentSignal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', onParentAbort);
    };
    const resolveOnce = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abortWith = (reason: Error) => {
      if (!controller.signal.aborted) controller.abort(reason);
    };
    const onParentAbort = () => {
      const error = parentSignal.reason instanceof Error
        ? parentSignal.reason
        : createAgentControlFailure('AGENT_ABORTED');
      abortWith(error);
      rejectOnce(error);
    };
    const timer = setTimeout(() => {
      const error = createAgentControlFailure('TOOL_TIMEOUT', ms);
      abortWith(error);
      rejectOnce(error);
    }, ms);

    if (parentSignal.aborted) {
      onParentAbort();
      return;
    }
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
    task(controller.signal).then(
      resolveOnce,
      error => rejectOnce(error),
    );
  });
}

function truncate(text: string, max: number) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, max - 1) + '…';
}

function summarizeOutput(output: unknown): string {
  if (!output || typeof output !== 'object') return '工具已返回结果';
  const obj = output as Record<string, unknown>;
  const total = obj.total ?? obj.count;
  if (typeof total === 'number') {
    if (total === 0) return '没有找到匹配记录';
    if (total === 1) return '找到 1 条匹配记录';
    return `找到 ${total} 条匹配记录`;
  }
  if (obj.found === true) return '找到匹配记录';
  if (obj.found === false) return '未找到匹配记录';
  return '已返回结果';
}

function stableStringify(value: unknown): string {
  // 仅做一层稳定化（按 key 排序），避免 LLM 同义入参换 key 顺序导致去重失效。
  if (!value || typeof value !== 'object' || Array.isArray(value)) return JSON.stringify(value);
  const obj = value as Record<string, unknown>;
  const sorted = Object.keys(obj).sort().reduce<Record<string, unknown>>((acc, key) => {
    acc[key] = obj[key];
    return acc;
  }, {});
  return JSON.stringify(sorted);
}

function buildSourcesFromScratchpad(scratchpad: Scratchpad) {
  return scratchpad.toolCalls
    .filter(call => call.ok)
    .map(call => ({
      title: `Agent 工具结果: ${call.toolId}`,
      category: 'ToolResult',
      source: `agent-tool/${call.toolId}`,
      excerpt: truncate(safeOutputExcerpt(call.output), 240),
    }));
}

function safeOutputExcerpt(output: unknown): string {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output);
  } catch {
    return '[unserializable]';
  }
}

// 把 toolId 翻译成自然语言动词短语，用于事件标题
const TOOL_VERB_MAP: Record<string, string> = {
  'relations.query': '检索客户档案',
  'relations.get': '读取档案',
  'relations.expand': '展开档案',
  'relations.create': '创建档案',
  'orders.query': '检索订单',
  'orders.get': '读取订单',
  'orders.expand': '展开订单',
  'products.query': '检索产品',
  'products.get': '读取产品',
  'products.expand': '展开产品',
  'products.describe_schema': '读取数据结构',
  'knowledge.search': '搜索知识库',
  'entities.search': '解析实体',
  'entities.hydrate': '获取实体详情',
  'finance.list_invoices': '检索发票',
  'finance.list_vouchers': '检索凭证',
  'shipping.list_shipments': '检索发货记录',
  'development.query': '检索开发案例',
  'email.list': '检索邮件',
  'template.list': '列出模板',
  'template.render': '渲染模板',
  'template.render_pdf': '渲染PDF',
};

function humanizeToolName(toolId: string): string {
  return TOOL_VERB_MAP[toolId] || toolId;
}
function buildThoughtProcess(
  input: AgentLoopInput,
  scratchpad: Scratchpad,
  finalText: string,
  stopReason: AgentLoopResult['stopReason'],
): string {
  const lines: string[] = [];
  lines.push(`我理解你想做的是：${truncate(input.message, 160)}`);
  lines.push('');
  if (scratchpad.toolCalls.length === 0) {
    lines.push('这个问题不需要查数据库，我直接根据已知信息回答了。');
  } else {
    lines.push('我做了以下操作：');
    for (const call of scratchpad.toolCalls.slice(0, 12)) {
      const toolLabel = humanizeToolName(call.toolId);
      if (call.ok) {
        lines.push(`- ${toolLabel}（${call.durationMs}ms）`);
      } else if (call.error?.startsWith('APPROVAL_REQUIRED')) {
        lines.push(`- ${toolLabel} → 需要审批确认`);
      } else {
        lines.push(`- ${toolLabel} → 失败：${call.error}`);
      }
    }
  }
  lines.push('');
  if (stopReason === 'final_answer') {
    lines.push('工具结果足以回答你的问题，以上回答基于实际数据。');
  } else if ((stopReason as string) === 'approval_blocked') {
    lines.push('有一个操作需要你审批后才能继续，请在审批面板确认。');
  } else if (stopReason === 'budget_exhausted' || stopReason === 'max_steps') {
    lines.push('达到了推理预算上限，我用已有信息做了收尾。如果信息不全，可以换个角度再问。');
  } else if (stopReason === 'llm_failure') {
    lines.push('推理过程中遇到了问题，可能需要换个方式提问。');
  }
  return lines.join('\n');
}
