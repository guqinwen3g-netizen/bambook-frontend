import type { PlannedToolCall } from './toolRuntime';
import type { AgentTaskFrame } from './taskFrame';
import { hasTaskIntent } from './taskFrame';

export type AgentLoopDecisionStatus = 'continue' | 'complete' | 'blocked';

export type ToolResultCardinality = 'zero' | 'one' | 'many' | 'unknown';
export type ToolResultResolution = 'unique' | 'ambiguous' | 'not_found' | 'unknown';

export type ToolResultObservation = {
  toolId: string;
  cardinality: ToolResultCardinality;
  resolution: ToolResultResolution;
  candidate?: Record<string, any>;
};

export type AgentLoopDecision = {
  status: AgentLoopDecisionStatus;
  reason: string;
  nextCalls: PlannedToolCall[];
  evidenceSatisfied: string[];
  evidenceMissing: string[];
  observation?: ToolResultObservation;
};

type ContinuationRule = {
  fromToolId: string;
  requiresEvidence: string[];
  inputFlag?: string;
  buildNextCalls: (input: {
    previousCall: PlannedToolCall;
    observation: ToolResultObservation;
  }) => PlannedToolCall[];
};

const CONTINUATION_RULES: ContinuationRule[] = [
  {
    fromToolId: 'relations.query',
    requiresEvidence: ['full relation profile', 'profile contacts', 'people directory'],
    inputFlag: 'followUp.getFullProfile',
    buildNextCalls: ({ observation }) => {
      const id = observation.candidate?.id;
      if (!id) return [];
      return [{
        toolId: 'relations.get',
        input: { id: String(id) },
        reason: '关系候选已唯一命中，继续读取完整档案和联系人明细',
      }, {
        toolId: 'relations.expand',
        input: { id: String(id), include: ['profile', 'contacts', 'people'], limit: 10 },
        reason: '关系候选已唯一命中，继续展开档案联系人和关联人物',
      }];
    },
  },
  {
    fromToolId: 'products.get',
    requiresEvidence: ['expanded product context'],
    inputFlag: 'followUp.expand',
    buildNextCalls: ({ previousCall, observation }) => {
      const id = observation.candidate?.id;
      if (!id) return [];
      return [{
        toolId: 'products.expand',
        input: {
          id: String(id),
          include: Array.isArray((previousCall.input.followUp as any)?.include)
            ? (previousCall.input.followUp as any).include
            : defaultProductExpandInclude(),
        },
        reason: '数字档案已唯一命中，继续展开关联上下文',
      }];
    },
  },
  {
    fromToolId: 'orders.get',
    requiresEvidence: ['expanded order context'],
    inputFlag: 'followUp.expand',
    buildNextCalls: ({ previousCall, observation }) => {
      const item = observation.candidate || {};
      if (!item.id && !item.poNumber) return [];
      return [{
        toolId: 'orders.expand',
        input: {
          id: item.id ? String(item.id) : undefined,
          poNumber: item.poNumber ? String(item.poNumber) : undefined,
          include: Array.isArray((previousCall.input.followUp as any)?.include)
            ? (previousCall.input.followUp as any).include
            : defaultOrderExpandInclude(),
        },
        reason: '订单已唯一命中，继续展开关联上下文',
      }];
    },
  },
];

export function assessAgentLoopStep(input: {
  taskFrame?: AgentTaskFrame;
  call: PlannedToolCall;
  output: unknown;
  completedCalls?: PlannedToolCall[];
}): AgentLoopDecision {
  if (!input.output || typeof input.output !== 'object') {
    return {
      status: 'blocked',
      reason: `${input.call.toolId} did not return structured output`,
      nextCalls: [],
      evidenceSatisfied: [],
      evidenceMissing: input.taskFrame?.evidenceRequired || [],
    };
  }

  const output = input.output as Record<string, any>;
  const observation = observeToolResult(input.call, output);
  const nextCalls = planNextCalls({
    taskFrame: input.taskFrame,
    previousCall: input.call,
    output,
    observation,
  });
  const evidenceSatisfied = inferSatisfiedEvidence(input.call, output);
  const evidenceMissing = missingEvidence(input.taskFrame, [
    ...inferSatisfiedEvidenceFromCompletedCalls(input.completedCalls || []),
    ...evidenceSatisfied,
    ...inferEvidenceFromPlannedCalls(nextCalls),
  ]);

  if (nextCalls.length) {
    return {
      status: 'continue',
      reason: `Next executable evidence steps: ${nextCalls.map(call => call.toolId).join(', ')}`,
      nextCalls,
      evidenceSatisfied,
      evidenceMissing,
      observation,
    };
  }

  if ((observation.resolution === 'ambiguous' || observation.resolution === 'not_found') && evidenceMissing.length) {
    // 创建意图特例：relations.query 返回 not_found 是预期中的"确认无重名"结果，
    // 不应阻塞循环——LLM 应基于 query 结果继续生成回答（告知审批已发起或继续创建流程）。
    if (observation.resolution === 'not_found'
      && input.call.toolId === 'relations.query'
      && input.taskFrame
      && hasTaskIntent(input.taskFrame, 'create')) {
      return {
        status: 'complete',
        reason: 'relations.query 确认无重名，创建意图的前置查询已完成',
        nextCalls: [],
        evidenceSatisfied,
        evidenceMissing,
        observation,
      };
    }
    return {
      status: 'blocked',
      reason: observation.resolution === 'ambiguous'
        ? 'Tool result has multiple candidates and no unique continuation target'
        : 'Tool result has no candidate to continue from',
      nextCalls: [],
      evidenceSatisfied,
      evidenceMissing,
      observation,
    };
  }

  return {
    status: 'complete',
    reason: evidenceMissing.length
      ? `No executable continuation for missing evidence: ${evidenceMissing.join(', ')}`
      : 'Current tool evidence is sufficient for this step',
    nextCalls: [],
    evidenceSatisfied,
    evidenceMissing,
    observation,
  };
}

function planNextCalls(input: {
  taskFrame?: AgentTaskFrame;
  previousCall: PlannedToolCall;
  output: Record<string, any>;
  observation: ToolResultObservation;
}): PlannedToolCall[] {
  if (input.previousCall.toolId === 'dictionary.query') {
    return planDictionaryFollowUp(input.previousCall, input.output);
  }

  if (input.observation.resolution !== 'unique') return [];
  return CONTINUATION_RULES
    .filter(rule => rule.fromToolId === input.previousCall.toolId)
    .filter(rule => shouldContinueForRule(rule, input.previousCall, input.taskFrame))
    .flatMap(rule => rule.buildNextCalls({
      previousCall: input.previousCall,
      observation: input.observation,
    }));
}

function shouldContinueForRule(rule: ContinuationRule, call: PlannedToolCall, taskFrame?: AgentTaskFrame) {
  return getNestedBoolean(call.input, rule.inputFlag)
    || taskFrameNeedsAnyEvidence(taskFrame, rule.requiresEvidence)
    || Boolean(taskFrame?.shouldContinueAfterFirstHit && rule.requiresEvidence.length);
}

function observeToolResult(call: PlannedToolCall, output: Record<string, any>): ToolResultObservation {
  const candidates = extractCandidates(output);
  const explicitResolution = explicitToolResolution(output);
  const cardinality = candidates.length === 0
    ? explicitResolution === 'unique' ? 'one' : 'zero'
    : candidates.length === 1 ? 'one' : 'many';
  const resolution = explicitResolution !== 'unknown'
    ? explicitResolution
    : cardinality === 'one' ? 'unique'
      : cardinality === 'many' ? 'ambiguous'
        : cardinality === 'zero' ? 'not_found'
          : 'unknown';

  return {
    toolId: call.toolId,
    cardinality,
    resolution,
    candidate: resolution === 'unique' ? candidates[0] || output.item || output.relation || output.order || output.product : undefined,
  };
}

function explicitToolResolution(output: Record<string, any>): ToolResultResolution {
  if (output.ambiguous === true) return 'ambiguous';
  if (output.found === false) return 'not_found';
  if (output.found === true) return 'unique';
  return 'unknown';
}

function extractCandidates(output: Record<string, any>): Array<Record<string, any>> {
  const arrays = [
    output.items,
    output.relations,
    output.orders,
    output.products,
    output.entities,
  ];
  for (const value of arrays) {
    if (Array.isArray(value)) return value.filter(item => item && typeof item === 'object');
  }
  for (const key of ['item', 'relation', 'order', 'product', 'entity']) {
    if (output[key] && typeof output[key] === 'object') return [output[key]];
  }
  const count = Number(output.count ?? output.total);
  if (count === 0) return [];
  return [];
}

function inferSatisfiedEvidence(call: PlannedToolCall, output: Record<string, any>) {
  const evidence: string[] = [];
  if (call.toolId === 'relations.query') evidence.push('relation candidates');
  if (call.toolId === 'relations.get' && output.found !== false) evidence.push('full relation profile');
  if (call.toolId === 'relations.expand') {
    if (Array.isArray(output.profileContacts)) evidence.push('profile contacts');
    if (Array.isArray(output.people)) evidence.push('people directory');
    evidence.push('full relation profile');
  }
  if (call.toolId === 'products.query' || call.toolId === 'products.get') evidence.push('product candidates');
  if (call.toolId === 'products.expand') evidence.push('expanded product context');
  if (call.toolId === 'orders.query' || call.toolId === 'orders.get') evidence.push('order candidates');
  if (call.toolId === 'orders.expand') evidence.push('expanded order context');
  if (call.toolId === 'knowledge.search') evidence.push('knowledge sources');
  if (call.toolId === 'entities.search' || call.toolId === 'entities.hydrate') evidence.push('entity links');
  return Array.from(new Set(evidence));
}

function inferSatisfiedEvidenceFromCompletedCalls(calls: PlannedToolCall[]) {
  return calls.flatMap(call => {
    if (call.toolId === 'relations.query') return ['relation candidates'];
    if (call.toolId === 'relations.get') return ['full relation profile'];
    if (call.toolId === 'relations.expand') return ['full relation profile', 'profile contacts', 'people directory'];
    if (call.toolId === 'products.query' || call.toolId === 'products.get') return ['product candidates'];
    if (call.toolId === 'products.expand') return ['expanded product context'];
    if (call.toolId === 'orders.query' || call.toolId === 'orders.get') return ['order candidates'];
    if (call.toolId === 'orders.expand') return ['expanded order context'];
    if (call.toolId === 'knowledge.search') return ['knowledge sources'];
    if (call.toolId === 'entities.search' || call.toolId === 'entities.hydrate') return ['entity links'];
    return [];
  });
}

function inferEvidenceFromPlannedCalls(calls: PlannedToolCall[]) {
  return inferSatisfiedEvidenceFromCompletedCalls(calls);
}

function missingEvidence(taskFrame: AgentTaskFrame | undefined, evidence: string[]) {
  if (!taskFrame) return [];
  const satisfied = new Set(evidence);
  return taskFrame.evidenceRequired.filter(item => !satisfied.has(item));
}

function taskFrameNeedsAnyEvidence(taskFrame: AgentTaskFrame | undefined, evidence: string[]) {
  if (!taskFrame) return false;
  return evidence.some(item => taskFrame.evidenceRequired.includes(item));
}

function getNestedBoolean(input: Record<string, unknown>, path?: string) {
  if (!path) return false;
  const value = path.split('.').reduce<any>((current, part) => (
    current && typeof current === 'object' ? current[part] : undefined
  ), input);
  return Boolean(value);
}

function planDictionaryFollowUp(call: PlannedToolCall, output: Record<string, any>): PlannedToolCall[] {
  if (
    call.input.intent === 'resolve_product_subcategory_for_count'
    && output.dictionary === 'productSubCategory'
    && Array.isArray(output.items)
    && output.items.length === 1
  ) {
    const item = output.items[0];
    return [{
      toolId: 'records.query',
      input: {
        entity: 'ProductAsset',
        aggregate: 'count',
        filters: {
          fieldFilters: [
            { path: 'mainCategory', operator: 'equals', value: item.mainCategory || call.input.mainCategory || 'Fabric' },
            { path: 'subCategoryId', operator: 'equals', value: item.id },
          ],
        },
      },
      reason: '字典唯一命中标准子分类，继续按子分类统计数字档案数量',
    }];
  }

  if (
    call.input.intent === 'resolve_product_subcategory_for_count'
    && output.dictionary === 'productSubCategory'
    && Array.isArray(output.items)
    && output.items.length === 0
  ) {
    const fallbackQuery = cleanCategoryQuery(call.input.query).replace(/面料$/g, '').trim() || cleanIdentifier(call.input.query);
    if (!fallbackQuery) return [];
    return [{
      toolId: 'records.query',
      input: {
        entity: 'ProductAsset',
        aggregate: 'count',
        query: fallbackQuery,
        mainCategory: call.input.mainCategory || 'Fabric',
        filters: {},
      },
      reason: '字典未命中标准子分类，继续按产品档案内容关键词统计，避免把字典空结果误判为业务记录为 0',
    }];
  }

  return [];
}

function defaultProductExpandInclude() {
  return ['profile', 'pricing', 'certifications', 'composition', 'images', 'customerCodes', 'relations'];
}

function defaultOrderExpandInclude() {
  return ['summary', 'lines', 'parties', 'dates', 'invoices', 'samples', 'production', 'missingFields', 'currencies'];
}

function cleanCategoryQuery(value: unknown) {
  return cleanIdentifier(value)
    .replace(/^(有多少|多少|几个|统计|查一下|查询|查|找|看看)\s*/i, '')
    .replace(/(有多少|多少|几个|数量|count|统计|产品|档案|记录)$/gi, '')
    .trim();
}

function cleanIdentifier(value: unknown) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}
