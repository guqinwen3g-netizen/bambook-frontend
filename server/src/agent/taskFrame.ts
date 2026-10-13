export type AgentTaskDomain =
  | 'relations'
  | 'products'
  | 'orders'
  | 'knowledge'
  | 'entities';

export type AgentTaskIntent =
  | 'list'
  | 'count'
  | 'schema'
  | 'lookup'
  | 'fullProfile'
  | 'context'
  | 'contacts'
  | 'peopleDirectory'
  | 'recommendation'
  | 'crossEntity'
  | 'rules'
  | 'create';

export type AgentTaskSubject = {
  kind: 'company' | 'person' | 'product' | 'order' | 'knowledge' | 'unknown';
  value: string;
  confidence: 'high' | 'medium' | 'low';
};

export type AgentTaskFrame = {
  objective: string;
  domains: AgentTaskDomain[];
  intents: AgentTaskIntent[];
  subject?: AgentTaskSubject;
  evidenceRequired: string[];
  completionCriteria: string[];
  shouldContinueAfterFirstHit: boolean;
};

export function buildAgentTaskFrame(query: string): AgentTaskFrame {
  const text = cleanText(query);
  const intents = inferIntents(text);
  const domains = inferDomains(text, intents);
  const subject = inferSubject(text, domains);
  const evidenceRequired = inferEvidenceRequired(domains, intents);
  const shouldContinueAfterFirstHit = intents.some(intent => [
    'fullProfile',
    'context',
    'contacts',
    'peopleDirectory',
    'recommendation',
    'crossEntity',
  ].includes(intent));

  return {
    objective: compactText(text, 240),
    domains,
    intents,
    subject,
    evidenceRequired,
    completionCriteria: inferCompletionCriteria(domains, intents, evidenceRequired),
    shouldContinueAfterFirstHit,
  };
}

export function hasTaskIntent(frame: AgentTaskFrame, intent: AgentTaskIntent) {
  return frame.intents.includes(intent);
}

export function hasTaskDomain(frame: AgentTaskFrame, domain: AgentTaskDomain) {
  return frame.domains.includes(domain);
}

export function taskFrameToText(frame: AgentTaskFrame) {
  return [
    `objective=${frame.objective}`,
    `domains=${frame.domains.join(',') || 'none'}`,
    `intents=${frame.intents.join(',') || 'none'}`,
    frame.subject ? `subject=${frame.subject.kind}:${frame.subject.value}; confidence=${frame.subject.confidence}` : 'subject=none',
    `continue_after_first_hit=${frame.shouldContinueAfterFirstHit}`,
    `evidence_required=${frame.evidenceRequired.join(', ') || 'none'}`,
    `completion_criteria=${frame.completionCriteria.join(' | ') || 'none'}`,
  ].join('\n');
}

function inferDomains(query: string, intents: AgentTaskIntent[]): AgentTaskDomain[] {
  const domains: AgentTaskDomain[] = [];
  if (/(客户|供应商|联系人|关系|公司|relation|supplier|customer|vendor|contact|company)/i.test(query)) domains.push('relations');
  if (/(数字档案|产品档案|面料档案|面料库|产品库|产品|面料|sku|article|fabric|product|material)/i.test(query)) domains.push('products');
  if (/(订单|order|po\b|purchase order|交期|出货|发票|样品|生产|大货)/i.test(query)) domains.push('orders');
  if (/(知识库|规则|sop|标准|流程|制度|合规|要求|knowledge|policy|rule)/i.test(query)) domains.push('knowledge');
  if (intents.includes('crossEntity') || /(关联|涉及|对应|相关|entity|graph|上下游|线索)/i.test(query)) domains.push('entities');
  return Array.from(new Set(domains));
}

function inferIntents(query: string): AgentTaskIntent[] {
  const intents: AgentTaskIntent[] = [];
  if (/(创建|新建|添加|新增|录入|帮我加|帮我建|帮我新建|create|add\s+new)/i.test(query)) intents.push('create');
  if (/(列出|清单|列表|有哪些|查看|看一下|最近|top\s*\d+)/i.test(query)) intents.push('list');
  if (/(多少|几个|数量|count|统计)/i.test(query)) intents.push('count');
  if (/(字段|schema|结构|能查什么|怎么查)/i.test(query)) intents.push('schema');
  if (/(查|查询|找|读取|确认|lookup|search|get)/i.test(query)) intents.push('lookup');
  if (/(完整|明细|详情|档案|profile|detail|full)/i.test(query)) intents.push('fullProfile');
  if (/(展开|上下文|相关资料|有哪些资料|context|expand)/i.test(query)) intents.push('context');
  if (/(联系人|对接人|邮箱|电话|手机|contact|email|phone|mobile)/i.test(query)) intents.push('contacts');
  if (/(通讯录|员工|人物|people|directory|personnel|team)/i.test(query)) intents.push('peopleDirectory');
  if (/(推荐|最适合|优先|应该先|判断|负责什么|谁负责|recommend|best|priority)/i.test(query)) intents.push('recommendation');
  if (/(关联|涉及|对应|相关|客户码|订单行|entity|hydrate|graph)/i.test(query)) intents.push('crossEntity');
  if (/(知识库|规则|sop|标准|流程|制度|合规|要求|knowledge|policy|rule)/i.test(query)) intents.push('rules');
  return Array.from(new Set(intents.length ? intents : ['lookup']));
}

function inferSubject(query: string, domains: AgentTaskDomain[]): AgentTaskSubject | undefined {
  const relationSubject = extractRelationSubject(query);
  if (relationSubject) return { kind: 'company', value: relationSubject, confidence: 'high' };

  const po = query.match(/\bPO(?:\s+|[-#：:]+)([A-Z0-9][A-Z0-9._-]*\d[A-Z0-9._-]*)\b/i)?.[1];
  if (po) return { kind: 'order', value: po, confidence: 'high' };

  const sku = query.match(/\b(?:sku|article|article\s*no)\s*[:：#]?\s*([A-Za-z0-9._-]*\d{5,}[A-Za-z0-9._-]*)\b/i)?.[1];
  if (sku) return { kind: 'product', value: sku, confidence: 'high' };

  const labeledCompany = extractValueAfterLabels(query, ['公司', '客户', '供应商', 'company', 'customer', 'supplier']);
  if (labeledCompany && domains.includes('relations')) return { kind: 'company', value: labeledCompany, confidence: 'medium' };

  const proper = query.match(/\b[A-Z][A-Za-z0-9&.' -]{2,50}\b/)?.[0];
  if (proper && domains.includes('relations')) return { kind: 'company', value: proper, confidence: 'low' };

  return undefined;
}

function inferEvidenceRequired(domains: AgentTaskDomain[], intents: AgentTaskIntent[]) {
  const evidence: string[] = [];
  if (domains.includes('relations')) {
    // 创建意图只需要确认无重名（relation candidates），不需要完整的读操作 evidence
    if (intents.includes('create')) {
      evidence.push('relation candidates');
    } else {
      const needsRelationObjectEvidence = intents.some(intent => [
        'context',
        'contacts',
        'peopleDirectory',
        'recommendation',
      ].includes(intent)) || (intents.includes('fullProfile') && !intents.includes('list'));
      evidence.push('relation candidates');
      if (needsRelationObjectEvidence) {
        evidence.push('full relation profile');
      }
      if (intents.some(intent => ['contacts', 'recommendation'].includes(intent))) {
        evidence.push('profile contacts');
      }
      if (intents.some(intent => ['peopleDirectory', 'contacts', 'recommendation'].includes(intent))) {
        evidence.push('people directory');
      }
    }
  }
  if (domains.includes('products')) {
    evidence.push('product candidates');
    if (intents.some(intent => ['fullProfile', 'context'].includes(intent))) evidence.push('expanded product context');
  }
  if (domains.includes('orders')) {
    evidence.push('order candidates');
    if (intents.some(intent => ['fullProfile', 'context'].includes(intent))) evidence.push('expanded order context');
  }
  if (domains.includes('knowledge')) evidence.push('knowledge sources');
  if (domains.includes('entities')) evidence.push('entity links');
  return Array.from(new Set(evidence));
}

function inferCompletionCriteria(domains: AgentTaskDomain[], intents: AgentTaskIntent[], evidence: string[]) {
  const criteria = [
    'answer the user objective directly',
    'cite available Bambook data sources',
  ];
  if (intents.includes('recommendation')) criteria.push('recommend based on retrieved evidence, not guesses');
  if (evidence.includes('people directory')) criteria.push('evaluate profile contacts and people directory before recommending a person');
  if (domains.includes('entities')) criteria.push('report whether cross-entity links were found');
  criteria.push('ask for more input only when required identifiers, permissions, or available tools block progress');
  return criteria;
}

function extractRelationSubject(query: string) {
  const patterns = [
    /(?:帮我|请|麻烦)?\s*(?:查一下|查询|查|找|看一下)?\s*([\u4e00-\u9fa5A-Za-z0-9&.' _\-]{2,80}?有限公司)(?:这个)?(?:公司|客户|供应商)?(?:[，。！？!?]|$)/i,
    /(?:帮我|请|麻烦)?\s*(?:查一下|查询|查|找|看一下)?\s*([A-Za-z0-9&.' _\-\u4e00-\u9fa5]{2,80}?)(?:这个)?(?:公司|客户|供应商)(?:[，。！？!?]|$)/i,
    /(?:公司|客户|供应商)\s*[:：]\s*([A-Za-z0-9&.' _\-\u4e00-\u9fa5]{2,80}?)(?:[，。！？!?]|$)/i,
  ];
  for (const pattern of patterns) {
    const raw = query.match(pattern)?.[1];
    const value = cleanEntityCandidate(raw);
    if (value) return value;
  }
  return '';
}

function extractValueAfterLabels(query: string, labels: string[]) {
  for (const label of labels) {
    const escaped = escapeRegExp(label);
    const match = query.match(new RegExp(`${escaped}\\s*[:：]\\s*([^，。！？!?;；\\n]{2,80})`, 'i'));
    const value = cleanEntityCandidate(match?.[1]);
    if (value) return value;
  }
  return '';
}

function cleanEntityCandidate(value: unknown) {
  return cleanText(value)
    .replace(/^(帮我|请|麻烦|查一下|查询|查|找|看一下)\s*/i, '')
    .replace(/(?:这个|该)(?:公司|客户|供应商|联系人|关系档案)$/i, '')
    .trim();
}

function cleanText(value: unknown) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function compactText(value: string, maxLength: number) {
  const text = cleanText(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
