// ============================================================================
// LLM 决策层（agentLoop 的"大脑皮层"）—— 不是规则化 planner
// ============================================================================
// 本文件虽名为 llmPlanner，但它不是 mcp/planner.ts 那种"关键词正则→工具"
// 的规则化 planner。它的职责是把"用户消息+历史+scratchpad"喂给 LLM，
// 让 LLM 自己决定调什么工具 / 给最终回答 / 发起表单交互。
//
// ⚠️ 防侵蚀红线（system prompt 构造原则）：
//   buildAgentSystemPrompt 里只允许写"能力描述"（你有这些工具/这些 action），
//   禁止写"行为规则触发条件"（如"当用户说X时必须用Y"）——后者是规则化
//   planner 思维的变体，会退化 LLM 的自主决策能力。
//   例外：客观业务契约（如"category 必须是 7 选 1"、"金额用 Decimal"）
//   属于事实陈述，可以写——但要写在工具描述里，不是行为规则段落里。
//
// 不依赖 zod——schema 极简，直接手写校验更稳。

import {
  AgentLoopInput,
  LLMCompleter,
  LLMTurnResult,
  PlannedLLMToolCall,
  Scratchpad,
  ToolDescriptor,
  ToolExecutionRecord,
} from './agentLoopTypes';
import { AGENT_LOOP_LIMITS } from './defaults';

const MAX_THOUGHT_LEN = 2000;
const MAX_FINAL_ANSWER_LEN = 8000;

/**
 * 构造给 LLM 的 system prompt。
 * 关键点：把工具清单、JSON schema、行为规则、引用约束都写明。
 *
 * 风格保持与 runner.ts callModelApi 的现有 system prompt 一致：
 *   - 强调工具优先、不能编造
 *   - 强调 ToolResult 优先级
 *   - 强调 ambiguous / found=false 时不能猜
 */
export function buildAgentSystemPrompt(input: {
  actor: AgentLoopInput['actor'];
  tools: ToolDescriptor[];
  maxToolsPerStep: number;
  /** 跨会话记忆（可选）：recall 注入，供个性化回答参考；空数组/缺省不渲染该段 */
  memories?: Array<{ scope: string; memoryType: string; content: string }>;
}): string {
  const toolsBlock = input.tools.map(tool => {
    const lines = [
      `- ${tool.id}（${tool.name}, scope=${tool.scope}, risk=${tool.risk}）`,
      `  作用：${tool.description}`,
    ];
    if (tool.inputHint) lines.push(`  入参形态：${tool.inputHint}`);
    return lines.join('\n');
  }).join('\n');

  const memoriesBlock = (input.memories || []).length
    ? [
        '## 已知用户记忆（跨会话，个性化参考）',
        ...(input.memories || []).slice(0, 20).map(memory =>
          `- （${memory.scope} · ${memory.memoryType}）${memory.content}`),
        '用户明确要求记住新信息时用 memory.write 工具写入。',
        '',
      ]
    : [];

  return [
    '你是 Bambook Enterprise Agent OS，运行在 Mac mini 数据中心。',
    '你不是一个聊天机器人——你是一个会规划、会调用真实业务工具、会观察工具结果再决定下一步的 Agent。',
    `当前用户：${input.actor.displayName || input.actor.userId}；角色：${input.actor.roles.join(', ')}；部门：${input.actor.departmentIds.join(', ') || '无'}。`,
    ...memoriesBlock,
    '',
    '## 你的工作循环',
    '系统会反复调用你做"单步决策"。每一步你只做两件事之一：',
    `  1. 决定调用 1 ~ ${input.maxToolsPerStep} 个工具（同步执行后结果会回灌给你）`,
    '  2. 给出最终回答（结束循环）',
    '',
    '调用工具后，下一轮你会在 messages 末尾收到一段 `[OBSERVATION step=N]` 文本，里面是上一步每个工具的结构化输出。基于 observation 决定下一步。',
    '',
    '## 输出格式（严格）',
    '你必须只输出一段 JSON，不要带 Markdown 代码块、不要带任何额外文字。JSON 形态二选一：',
    '',
    '形态 A（要调工具）：',
    '{',
    '  "thought": "<= 2000 字符。这一步你的思考：用户想要什么、你打算如何拆解、为什么要调下面这些工具。",',
    '  "action": "call_tool",',
    '  "toolCalls": [',
    '    { "toolId": "<工具清单里的 id>", "input": { ... }, "why": "为什么调这个工具，<= 200 字" }',
    '  ]',
    '}',
    '',
    '形态 B（给最终答案）：',
    '{',
    '  "thought": "<= 2000 字符。本轮的总结：你拿到了哪些 observation、为什么足够回答。",',
    '  "action": "final_answer",',
    '  "finalAnswer": "<= 8000 字符。给用户的最终回答，企业软件风格，不用 Markdown 大粗体。"',
    '}',
    '',
    '形态 C（向用户发起表单交互——收集你还需要的信息）：',
    '{',
    '  "thought": "<= 2000 字符。说明你需要向用户收集什么信息、为什么需要。",',
    '  "action": "request_form",',
    '  "formTitle": "表单标题，如「客户档案信息」",',
    '  "formDescription": "可选，给用户的说明文字",',
    '  "fields": [',
    '    { "key": "companyName", "label": "公司全称", "type": "text", "required": true, "placeholder": "如 ABC Trading Co., Ltd." },',
    '    { "key": "contactName", "label": "主联系人", "type": "text", "required": true },',
    '    { "key": "customerType", "label": "客户类型", "type": "select", "options": ["Customer", "Supplier", "Carrier"], "required": true },',
    '    { "key": "paymentTerms", "label": "付款条件", "type": "text", "placeholder": "如 T/T 30 days" }',
    '  ],',
    '  "submitLabel": "可选，按钮文字，默认「提交」"',
    '}',
    '表单提交后，系统会把用户填写的内容作为 observation 回灌给你，你继续工作循环。',
    '',
    '## 行为规则',
    '- 必须基于工具结果回答。如果一个事实你没有从工具拿到证据，就不要写到 finalAnswer 里。',
    '- 不要编造数据；如果工具结果说 found=false 或 ambiguous=true，就在最终回答里说明需要更精确标识。',
    '- ToolResult 的结构化字段（total / count / items / full_record）优先于文本样本。',
    '- 如果工具数据已经足够，就立刻 final_answer，不要为了显得勤奋而多查。',
    '- 如果你已经走了多步还是不够，可以 final_answer 说明缺口和下一步建议，而不是死循环。',
    '- 同一个 toolId + 同一个 input 不要重复调（会被去重，浪费一步）。',
    '',
    '## 创建/写入操作规则（重要）',
    '- 当用户要求"创建/新建/添加"一个实体时，你应该：',
    '  1. 先用对应的 query 工具检索确认无重名（例如 relations.query）。',
    '  2. 如果确认无重名，**立刻在下一步调用对应的 create 工具**（例如 relations.create），不要只描述操作而结束循环。',
    '  3. 不要在 final_answer 里用 JSON 代码块描述"应该调什么工具"——那不是给用户的回答。你应该真正执行工具调用（action: "call_tool"）。',
    '- high risk 工具（如 relations.create）会走审批流；你照常发起 toolCall，系统会在审批通过后执行。',
    '- 不要因为工具是 high risk 就跳过调用。你的职责是规划并发起调用，审批由人和系统处理。',
    '',
    '## 交互能力',
    '- 你有三种 action：call_tool（调工具）、final_answer（给最终回答）、request_form（向用户发起结构化表单收集信息）。',
    '- request_form 让你能在对话里弹出表单卡片，用户填写后内容会回灌给你继续工作。',
    '- 何时用哪种 action 完全由你判断——你有足够的企业业务理解来决定最优交互方式。',
    '',
    '## 入参合约（关键，违反会导致 0 命中）',
    '- 仔细阅读每个工具的"入参形态"——里面已经写明了 filters 下有哪些字段，每个字段的语义和示例。',
    '- `query` 字段是**字面文本子串匹配**，不是语义检索、不是 SQL where：',
    '    ✅ 正确：query="<实体名>"、query="<SKU或PO号>"、query="<品类关键词>"',
    '    ❌ 错误：query="帮我查一下 <客户名> 这个客户的所有订单"（整句中文绝不会命中任何字段）',
    '- 维度筛选（客户、供应商、状态、日期、品类、缺失字段）一律走 `filters`：',
    '    ✅ 客户=<客户名> ⇒ orders.query({ filters: { customer: "<客户名>" } })',
    '    ✅ 状态=Pending ⇒ orders.query({ filters: { statuses: ["Pending"] } })',
    '    ❌ 不要 orders.query({ query: "<客户名> 客户 pending 订单" })',
    '- 既能用 filters 又能用 query 时，**优先 filters**。filters.customer 是结构化精确匹配，全句 query 等同于全文检索失败。',
    '- 用户输入是中文长句时，先在脑子里抽出实体（人/公司/编号/日期/状态），然后映射到对应的 filters 字段；不要把原句塞进 query。',
    '',
    '## 可用工具',
    toolsBlock,
    '',
    '现在等待用户消息。请严格按上面 JSON 形态输出，不要包裹 ```json``` 代码块。',
  ].join('\n');
}

/**
 * 构造给 LLM 的对话 messages（system 之外的部分）。
 *
 * 包括：
 *   - 历史最后 8 轮
 *   - 当前用户消息（带附件块）
 *   - 已累积的 scratchpad，按 step 分组：每步 = 一条 assistant（thought + plan）+ 一条 user（observation）
 */
export function buildAgentUserMessages(input: {
  message: string;
  history: AgentLoopInput['history'];
  attachmentContext: AgentLoopInput['attachmentContext'];
  scratchpad: Scratchpad;
}): Array<{ role: 'user' | 'assistant'; content: string }> {
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  for (const item of input.history.slice(-AGENT_LOOP_LIMITS.historyWindowSize)) {
    messages.push({
      role: item.role === 'user' ? 'user' : 'assistant',
      content: item.content,
    });
  }

  const attachmentBlock = input.attachmentContext.length
    ? input.attachmentContext.map((hit, idx) => `[附件${idx + 1}] ${hit.title} (${hit.source}/${hit.category})\n${hit.content}`).join('\n\n')
    : '';
  const userBlock = attachmentBlock
    ? `${attachmentBlock}\n\n用户问题:\n${input.message}`
    : input.message;
  messages.push({ role: 'user', content: userBlock });

  const grouped = groupScratchpadByStep(input.scratchpad);
  for (const group of grouped) {
    messages.push({
      role: 'assistant',
      content: JSON.stringify({
        thought: group.thought,
        action: 'call_tool',
        toolCalls: group.calls.map(c => ({ toolId: c.toolId, input: c.input, why: c.why })),
      }),
    });
    messages.push({
      role: 'user',
      content: formatObservationBlock(group.step, group.calls),
    });
  }

  return messages;
}

function groupScratchpadByStep(scratchpad: Scratchpad) {
  const map = new Map<number, { step: number; thought: string; calls: ToolExecutionRecord[] }>();
  for (const t of scratchpad.thoughts) {
    if (!map.has(t.step)) map.set(t.step, { step: t.step, thought: t.content, calls: [] });
    else map.get(t.step)!.thought = t.content;
  }
  for (const call of scratchpad.toolCalls) {
    if (!map.has(call.step)) map.set(call.step, { step: call.step, thought: '', calls: [call] });
    else map.get(call.step)!.calls.push(call);
  }
  return Array.from(map.values()).sort((a, b) => a.step - b.step);
}

function formatObservationBlock(step: number, calls: ToolExecutionRecord[]): string {
  const lines = [`[OBSERVATION step=${step}]`];
  for (const call of calls) {
    lines.push(`# ${call.toolId} (callId=${call.callId}, ok=${call.ok}, ${call.durationMs}ms)`);
    if (call.ok) {
      lines.push(safeStringify(call.output));
    } else {
      lines.push(`ERROR: ${call.error || 'unknown error'}`);
    }
  }
  return lines.join('\n');
}

function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2);
    const limit = AGENT_LOOP_LIMITS.observationCharLimit;
    if (json.length <= limit) return json;
    return json.slice(0, limit) + '\n... [truncated]';
  } catch {
    return '[unserializable output]';
  }
}

/**
 * 调用 LLM 做一步决策。
 *
 * 流程：
 *   1. 调一次 LLM，尝试解析 JSON。
 *   2. 失败时给一次"修复提示"再调一次。
 *   3. 仍失败 → 抛 LLM_PARSE_FAILED；调用方应当走 forceFinalAnswer。
 */
export async function planNextStep(input: {
  systemPrompt: string;
  userMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  llm: LLMCompleter;
  model?: string;
  temperature?: number;
  signal: AbortSignal;
  toolWhitelist: Set<string>;
  maxToolsPerStep: number;
  repairRetries: number;
  onThoughtDelta?: (chunk: string) => void;
  onAnswerDelta?: (chunk: string) => void;
}): Promise<LLMTurnResult> {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: input.systemPrompt },
    ...input.userMessages,
  ];

  let lastError: string | null = null;
  const totalAttempts = 1 + Math.max(0, input.repairRetries);

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const repairHint =
      attempt > 1 && lastError
        ? `\n\n[上一次输出无法解析，原因：${lastError}。请只输出严格 JSON，不要任何包裹文字、代码块或注释。]`
        : '';
    const finalMessages = repairHint
      ? [...messages, { role: 'user' as const, content: repairHint }]
      : messages;

    const extractor = createIncrementalFieldExtractor({
      onThoughtDelta: input.onThoughtDelta,
      onAnswerDelta: input.onAnswerDelta,
    });

    const raw = await input.llm({
      systemPrompt: input.systemPrompt,
      messages: finalMessages,
      model: input.model,
      temperature: input.temperature,
      signal: input.signal,
      jsonMode: true,
      onDelta: (input.onThoughtDelta || input.onAnswerDelta)
        ? (chunk: string) => extractor.feed(chunk)
        : undefined,
    });

    const parsed = parseAndValidate(raw, {
      toolWhitelist: input.toolWhitelist,
      maxToolsPerStep: input.maxToolsPerStep,
    });
    if (parsed.ok === true) return parsed.value;
    lastError = parsed.error;
  }

  throw new Error(`LLM_PARSE_FAILED: ${lastError || 'unknown'}`);
}
/**
 * 增量 JSON 字段提取器：从流式 delta 提取 "thought"/"finalAnswer" 字段值。
 */
function createIncrementalFieldExtractor(callbacks: {
  onThoughtDelta?: (chunk: string) => void;
  onAnswerDelta?: (chunk: string) => void;
}) {
  let buffer = '';
  let thoughtEmitted = 0;
  let answerEmitted = 0;
  let inThought = false;
  let inAnswer = false;

  function feed(chunk: string) {
    buffer += chunk;
    scan();
  }

  function scan() {
    while (true) {
      if (!inThought && !inAnswer) {
        const thoughtIdx = findFieldStart(buffer, '"thought"');
        const answerIdx = findFieldStart(buffer, '"finalAnswer"');
        if (thoughtIdx !== -1 && (answerIdx === -1 || thoughtIdx < answerIdx)) {
          inThought = true; buffer = buffer.slice(thoughtIdx); continue;
        }
        if (answerIdx !== -1) {
          inAnswer = true; buffer = buffer.slice(answerIdx); continue;
        }
        break;
      }
      if (inThought) {
        const { value, rest, complete } = extractStringValue(buffer);
        if (value.length > thoughtEmitted && callbacks.onThoughtDelta) {
          callbacks.onThoughtDelta(value.slice(thoughtEmitted));
          thoughtEmitted = value.length;
        }
        if (complete) { inThought = false; buffer = rest; thoughtEmitted = 0; continue; }
        break;
      }
      if (inAnswer) {
        const { value, rest, complete } = extractStringValue(buffer);
        if (value.length > answerEmitted && callbacks.onAnswerDelta) {
          callbacks.onAnswerDelta(value.slice(answerEmitted));
          answerEmitted = value.length;
        }
        if (complete) { inAnswer = false; buffer = rest; answerEmitted = 0; continue; }
        break;
      }
    }
  }
  return { feed };
}

function findFieldStart(text: string, fieldKey: string): number {
  const idx = text.indexOf(fieldKey);
  if (idx === -1) return -1;
  let pos = idx + fieldKey.length;
  while (pos < text.length && (text[pos] === ' ' || text[pos] === '\t' || text[pos] === '\n')) pos++;
  if (text[pos] !== ':') return -1;
  pos++;
  while (pos < text.length && (text[pos] === ' ' || text[pos] === '\t' || text[pos] === '\n')) pos++;
  if (text[pos] !== '"') return -1;
  return pos + 1;
}

function extractStringValue(text: string): { value: string; rest: string; complete: boolean } {
  let value = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) {
      const next = text[i + 1];
      const m: Record<string, string> = { '"':'"','\\':'\\','/':'/','b':'\b','f':'\f','n':'\n','r':'\r','t':'\t' };
      if (m[next]) { value += m[next]; i += 2; continue; }
      if (next === 'u' && i + 5 < text.length) {
        value += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16)); i += 6; continue;
      }
      value += next; i += 2; continue;
    }
    if (ch === '"') return { value, rest: text.slice(i + 1), complete: true };
    value += ch; i++;
  }
  return { value, rest: text, complete: false };
}


/**
 * 强制收尾：当达到 maxSteps / 总预算耗尽 / LLM 持续无法输出合规 JSON 时调用。
 *
 * 让 LLM 用最后一次机会基于 scratchpad 给一段自然语言收尾，不再尝试调用工具。
 * 如果连这次也失败，就用本地兜底字符串。
 */
export async function forceFinalAnswer(input: {
  systemPrompt: string;
  userMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  llm: LLMCompleter;
  model?: string;
  temperature?: number;
  signal: AbortSignal;
  reason: string;
  onAnswerDelta?: (chunk: string) => void;
}): Promise<string> {
  const closingHint =
    `\n\n[系统强制收尾。原因：${input.reason}。请基于已经获得的 observation 直接用自然语言（不要 JSON）给出对用户问题的最终回答；如果信息不足，明确说明缺口和下一步可以做什么。]`;
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: input.systemPrompt },
    ...input.userMessages,
    { role: 'user', content: closingHint },
  ];

  try {
    const raw = await input.llm({
      systemPrompt: input.systemPrompt,
      messages,
      model: input.model,
      temperature: input.temperature,
      signal: input.signal,
      jsonMode: false,
      onDelta: input.onAnswerDelta,
    });
    const trimmed = String(raw || '').trim();
    if (trimmed) return trimmed;
  } catch {
    // ignore
  }
  return '本轮 Agent 未能完成有效推理；请检查 Agent 日志或更换提问方式后重试。';
}

// ─────────────────────────── 解析与校验 ───────────────────────────

function parseAndValidate(
  raw: string,
  options: { toolWhitelist: Set<string>; maxToolsPerStep: number },
): { ok: true; value: LLMTurnResult } | { ok: false; error: string } {
  const text = stripCodeFences(String(raw || '').trim());
  if (!text) return { ok: false, error: 'empty_output' };

  // 容错：模型可能在 JSON 前后多输出文字。截取第一个 { 到最后一个 } 的范围。
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, error: 'no_json_object' };
  const slice = text.slice(start, end + 1);

  let parsed: any;
  try {
    parsed = JSON.parse(slice);
  } catch (err: any) {
    return { ok: false, error: `json_parse_error: ${err?.message || err}` };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'not_an_object' };
  }
  const thought = typeof parsed.thought === 'string' ? parsed.thought.trim().slice(0, MAX_THOUGHT_LEN) : '';
  if (!thought) return { ok: false, error: 'missing_thought' };

  if (parsed.action === 'final_answer') {
    const finalAnswer = typeof parsed.finalAnswer === 'string' ? parsed.finalAnswer.trim().slice(0, MAX_FINAL_ANSWER_LEN) : '';
    if (!finalAnswer) return { ok: false, error: 'missing_finalAnswer' };
    return { ok: true, value: { action: 'final_answer', thought, finalAnswer } };
  }

  if (parsed.action === 'call_tool') {
    if (!Array.isArray(parsed.toolCalls) || parsed.toolCalls.length === 0) {
      return { ok: false, error: 'missing_toolCalls' };
    }
    const calls: PlannedLLMToolCall[] = [];
    for (const raw of parsed.toolCalls.slice(0, options.maxToolsPerStep)) {
      const validated = validateToolCall(raw, options.toolWhitelist);
      if (validated.ok === false) return { ok: false, error: validated.error };
      calls.push(validated.value);
    }
    if (calls.length === 0) return { ok: false, error: 'no_valid_toolCalls' };
    return { ok: true, value: { action: 'call_tool', thought, toolCalls: calls } };
  }

  if (parsed.action === 'request_form') {
    const formTitle = typeof parsed.formTitle === 'string' ? parsed.formTitle.trim().slice(0, 200) : '';
    if (!formTitle) return { ok: false, error: 'missing_formTitle' };
    if (!Array.isArray(parsed.fields) || parsed.fields.length === 0) {
      return { ok: false, error: 'missing_form_fields' };
    }
    const validTypes = new Set(['text', 'textarea', 'select', 'multiselect']);
    const fields = parsed.fields.slice(0, 20).map((f: any) => ({
      key: String(f?.key || '').trim().slice(0, 60),
      label: String(f?.label || '').trim().slice(0, 120),
      type: validTypes.has(f?.type) ? f.type : 'text',
      required: Boolean(f?.required),
      placeholder: typeof f?.placeholder === 'string' ? f.placeholder.slice(0, 200) : undefined,
      options: Array.isArray(f?.options) ? f.options.map(String).slice(0, 20) : undefined,
      helpText: typeof f?.helpText === 'string' ? f.helpText.slice(0, 300) : undefined,
    })).filter((f: any) => f.key && f.label);
    if (fields.length === 0) return { ok: false, error: 'no_valid_form_fields' };
    const formDescription = typeof parsed.formDescription === 'string' ? parsed.formDescription.trim().slice(0, 500) : undefined;
    const submitLabel = typeof parsed.submitLabel === 'string' ? parsed.submitLabel.trim().slice(0, 30) : undefined;
    return { ok: true, value: { action: 'request_form', thought, formTitle, formDescription, fields, submitLabel } };
  }

  return { ok: false, error: `unknown_action: ${parsed.action}` };
}

function validateToolCall(
  raw: any,
  whitelist: Set<string>,
): { ok: true; value: PlannedLLMToolCall } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'toolCall_not_an_object' };
  const toolId = typeof raw.toolId === 'string' ? raw.toolId.trim() : '';
  if (!toolId) return { ok: false, error: 'toolCall_missing_toolId' };
  if (!whitelist.has(toolId)) return { ok: false, error: `toolCall_unknown_toolId: ${toolId}` };
  const inputObj = raw.input;
  const isPlainObject = inputObj && typeof inputObj === 'object' && !Array.isArray(inputObj);
  if (!isPlainObject) return { ok: false, error: `toolCall_invalid_input: ${toolId}` };
  const why = typeof raw.why === 'string' ? raw.why.trim().slice(0, 400) : undefined;
  return { ok: true, value: { toolId, input: { ...(inputObj as Record<string, unknown>) }, why } };
}

function stripCodeFences(text: string): string {
  // 去掉 ```json ... ``` 或 ``` ... ``` 包裹。
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return fenced ? fenced[1].trim() : text;
}
