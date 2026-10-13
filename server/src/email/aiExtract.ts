// ════════════════════════════════════════════════════════════════════
// Email AI Extract Service — Phase 4b
// ════════════════════════════════════════════════════════════════════
// 用途：调用 LLM 从一封邮件中抽取结构化业务字段（询盘 / 报价 / 出运通知等），
//       结果写入 Email.aiExtractedJson + aiSummary + aiModel + aiExtractedAt。
//
// 设计原则：
//   - LLM 输出严格 JSON（response_format=json_object），失败回退到容错解析。
//   - 不依赖前端，纯后端服务，可被 Agent 工具或 cron 触发。
//   - 抽取字段以"贸易公司询盘流"为核心：意图、产品、数量、价格、交期、客户信号。
//   - 失败时写入 aiExtractError，下次重试可读出原因；成功时清零。
//   - Prompt 中文双语，因为 Bambook 邮件混合中英文场景多。
// ════════════════════════════════════════════════════════════════════

import { PrismaClient } from '@prisma/client';

export type EmailExtractedPayload = {
  intent: 'inquiry' | 'quotation' | 'order' | 'shipment_notice' | 'invoice' | 'complaint' | 'follow_up' | 'other';
  language: 'zh' | 'en' | 'mixed' | 'other';
  summary: string;
  customerSignal: 'positive' | 'neutral' | 'urgent' | 'risk' | 'unknown';
  products: Array<{ name: string; sku?: string; description?: string }>;
  quantities: Array<{ productName?: string; value: number; unit: string }>;
  prices: Array<{ productName?: string; value: number; currency: string; unit?: string }>;
  deadlines: Array<{ purpose: string; date: string }>;
  poNumbers: string[];
  questions: string[];
  actionItems: string[];
};

const SYSTEM_PROMPT = [
  '你是 Bambook 外贸 ERP 的邮件结构化抽取器。',
  '输入是一封邮件（含发件人、主题、正文），你的任务是抽取贸易场景的关键字段并输出严格 JSON。',
  '',
  '抽取字段定义：',
  '- intent: inquiry/quotation/order/shipment_notice/invoice/complaint/follow_up/other',
  '- language: zh/en/mixed/other',
  '- summary: 一句话中文摘要（≤80字）',
  '- customerSignal: positive/neutral/urgent/risk/unknown',
  '- products: [{name, sku?, description?}]',
  '- quantities: [{productName?, value, unit}] (unit 用 pcs/kg/m/yard/box/set 等)',
  '- prices: [{productName?, value, currency ISO三字符, unit?}]',
  '- deadlines: [{purpose, date YYYY-MM-DD}]',
  '- poNumbers / questions / actionItems: string[]',
  '',
  '输出规则：',
  '- 必须是合法 JSON，不要 markdown 围栏，不要解释',
  '- 没有的字段填空数组 [] 或 unknown，不要编造',
  '- 数字字段必须是 number 类型',
  '- 日期必须 YYYY-MM-DD；模糊时间跳过',
].join('\n');

function stripJsonFence(text: string): string {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (m) return m[1].trim();
  return text.trim();
}

function safeParseJson(text: string): any {
  try { return JSON.parse(text); } catch {}
  try { return JSON.parse(stripJsonFence(text)); } catch {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  return null;
}

function normalizeExtracted(raw: any): EmailExtractedPayload {
  const arr = (v: any) => (Array.isArray(v) ? v : []);
  return {
    intent: ['inquiry', 'quotation', 'order', 'shipment_notice', 'invoice', 'complaint', 'follow_up', 'other'].includes(raw?.intent)
      ? raw.intent : 'other',
    language: ['zh', 'en', 'mixed', 'other'].includes(raw?.language) ? raw.language : 'other',
    summary: String(raw?.summary || '').slice(0, 200),
    customerSignal: ['positive', 'neutral', 'urgent', 'risk', 'unknown'].includes(raw?.customerSignal)
      ? raw.customerSignal : 'unknown',
    products: arr(raw?.products).map((p: any) => ({
      name: String(p?.name || '').slice(0, 200),
      sku: p?.sku ? String(p.sku).slice(0, 100) : undefined,
      description: p?.description ? String(p.description).slice(0, 300) : undefined,
    })).filter((p: any) => p.name),
    quantities: arr(raw?.quantities).map((q: any) => ({
      productName: q?.productName ? String(q.productName).slice(0, 200) : undefined,
      value: Number(q?.value) || 0,
      unit: String(q?.unit || 'pcs').slice(0, 20),
    })).filter((q: any) => q.value > 0),
    prices: arr(raw?.prices).map((p: any) => ({
      productName: p?.productName ? String(p.productName).slice(0, 200) : undefined,
      value: Number(p?.value) || 0,
      currency: String(p?.currency || 'USD').slice(0, 8).toUpperCase(),
      unit: p?.unit ? String(p.unit).slice(0, 20) : undefined,
    })).filter((p: any) => p.value > 0),
    deadlines: arr(raw?.deadlines).map((d: any) => ({
      purpose: String(d?.purpose || 'unknown').slice(0, 50),
      date: String(d?.date || '').slice(0, 10),
    })).filter((d: any) => /^\d{4}-\d{2}-\d{2}$/.test(d.date)),
    poNumbers: arr(raw?.poNumbers).map((s: any) => String(s).slice(0, 50)).filter(Boolean),
    questions: arr(raw?.questions).map((s: any) => String(s).slice(0, 300)).filter(Boolean),
    actionItems: arr(raw?.actionItems).map((s: any) => String(s).slice(0, 300)).filter(Boolean),
  };
}

export type LlmCompleter = (input: {
  systemPrompt: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  model?: string;
  temperature?: number;
  signal: AbortSignal;
  jsonMode?: boolean;
}) => Promise<string>;

/** 默认 LLM 调用器（ARK chat completions）。 */
export function createDefaultEmailLlm(): LlmCompleter {
  return async function complete(input) {
    const apiKey =
      process.env.ARK_API_KEY ||
      process.env.VOLCENGINE_API_KEY ||
      process.env.TENCENT_API_KEY ||
      process.env.ZHIPU_API_KEY;
    const baseUrl = (process.env.BAMBOOK_MODEL_BASE_URL || 'https://ark.cn-beijing.volces.com/api/coding/v3').replace(/\/$/, '');
    const model = input.model || process.env.BAMBOOK_MODEL_NAME || 'ark-code-latest';
    if (!apiKey) {
      throw new Error('Model API key is not configured for email AI extract');
    }
    const messages = [
      { role: 'system' as const, content: input.systemPrompt },
      ...input.messages,
    ];
    const body: Record<string, unknown> = {
      model,
      temperature: input.temperature ?? 0.1,
      stream: false,
      messages,
    };
    if (input.jsonMode) {
      body.response_format = { type: 'json_object' };
    }
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: input.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data: any = await res.json().catch(() => ({}));
      throw new Error(data?.error?.message || data?.message || `LLM API failed with ${res.status}`);
    }
    const data: any = await res.json().catch(() => ({}));
    return String(data?.choices?.[0]?.message?.content || '').trim();
  };
}

export type ExtractEmailInput = {
  prisma: PrismaClient;
  emailId: string;
  llm?: LlmCompleter;
  model?: string;
  signal?: AbortSignal;
  /** 当邮件已经有 aiExtractedJson 时，是否强制重新抽取。默认 false。 */
  force?: boolean;
};

export type ExtractEmailResult = {
  ok: boolean;
  emailId: string;
  reused?: boolean;
  payload?: EmailExtractedPayload;
  model?: string;
  extractedAt?: number;
  error?: string;
};

/** 截断邮件正文，避免超过模型上下文。 */
function truncateBody(text: string, max = 8000): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n... [truncated, total ${text.length} chars]`;
}

function buildUserPrompt(email: any): string {
  const lines: string[] = [];
  lines.push(`From: ${email.fromName ? email.fromName + ' <' + email.fromAddress + '>' : email.fromAddress || '(unknown)'}`);
  if (email.toAddresses) {
    try {
      const parsed = typeof email.toAddresses === 'string' ? JSON.parse(email.toAddresses) : email.toAddresses;
      if (Array.isArray(parsed) && parsed.length) lines.push(`To: ${parsed.slice(0, 5).join(', ')}`);
    } catch {
      lines.push(`To: ${email.toAddresses}`);
    }
  }
  if (email.subject) lines.push(`Subject: ${email.subject}`);
  if (email.sentAt) lines.push(`Date: ${email.sentAt}`);
  if (email.relationName) lines.push(`关联客户/联系人: ${email.relationName}`);
  if (email.orderPo) lines.push(`关联订单 PO: ${email.orderPo}`);
  lines.push('');
  lines.push('--- Body ---');
  const body = String(email.bodyText || email.snippet || '');
  lines.push(truncateBody(body));
  lines.push('');
  lines.push('请输出 JSON。');
  return lines.join('\n');
}

/** 对一封邮件执行 AI 结构化抽取，并把结果写回 DB。 */
export async function extractEmailAi(input: ExtractEmailInput): Promise<ExtractEmailResult> {
  const { prisma, emailId } = input;
  const emailModel = (prisma as any).email;
  if (!emailModel?.findUnique) {
    return { ok: false, emailId, error: 'email model unavailable' };
  }

  const email = await emailModel.findUnique({ where: { id: emailId } });
  if (!email || email.deletedAt) {
    return { ok: false, emailId, error: 'email not found' };
  }

  // 已有结果且不强制重抽 → 直接返回缓存
  if (!input.force && email.aiExtractedJson && email.aiExtractedAt) {
    return {
      ok: true,
      emailId,
      reused: true,
      payload: email.aiExtractedJson as EmailExtractedPayload,
      model: email.aiModel || undefined,
      extractedAt: typeof email.aiExtractedAt === 'bigint' ? Number(email.aiExtractedAt) : email.aiExtractedAt,
    };
  }

  const llm = input.llm || createDefaultEmailLlm();
  const signal = input.signal || new AbortController().signal;
  const model = input.model || process.env.BAMBOOK_MODEL_NAME || 'ark-code-latest';

  let rawText = '';
  try {
    rawText = await llm({
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(email) }],
      model,
      temperature: 0.1,
      jsonMode: true,
      signal,
    });
  } catch (err: any) {
    const errorMsg = String(err?.message || err).slice(0, 500);
    await emailModel.update({
      where: { id: emailId },
      data: {
        aiExtractError: errorMsg,
        updatedAt: BigInt(Date.now()),
      },
    });
    return { ok: false, emailId, error: errorMsg };
  }

  const parsed = safeParseJson(rawText);
  if (!parsed || typeof parsed !== 'object') {
    const errorMsg = `LLM returned non-JSON content: ${rawText.slice(0, 200)}`;
    await emailModel.update({
      where: { id: emailId },
      data: {
        aiExtractError: errorMsg,
        updatedAt: BigInt(Date.now()),
      },
    });
    return { ok: false, emailId, error: errorMsg };
  }

  const payload = normalizeExtracted(parsed);
  const now = BigInt(Date.now());

  await emailModel.update({
    where: { id: emailId },
    data: {
      aiExtractedJson: payload as any,
      aiSummary: payload.summary || null,
      aiModel: model,
      aiExtractedAt: now,
      aiExtractError: null,
      updatedAt: now,
    },
  });

  return {
    ok: true,
    emailId,
    reused: false,
    payload,
    model,
    extractedAt: Number(now),
  };
}
