import { businessNowDate } from '../lib/businessClock';
/**
 * Email Intelligence Service — F5 邮件智能化前端服务
 *
 * 覆盖 PRD 19.3 / 12.1 两块能力：
 *   1. 意图可视化：GET /api/v1/email/intents 聚合 AI 抽取的意图徽标（薄覆盖层，叠加在 IMAP 实时流上）
 *   2. 业务场景模板：GET /api/v1/email-templates 拉取模板库 + 纯函数变量渲染（{{var}} 替换）
 *
 * C8 邮件深化扩展：
 *   3. /intents 覆盖层合约演进：已同步邮件（无论是否抽取）都返回，携带 DB id/labels/客户与订单链接；
 *      intent 为 null 表示尚未 AI 抽取（前端只渲染非空意图徽标）。
 *   4. 智能分类：POST /:id/classify（规则+AI 打标，投诉/紧急自动建跟进）
 *   5. 任务关联自动化：POST /:id/create-followup（幂等生成 CRM 跟进任务）
 *   6. 模板智能化：POST /:id/use 使用统计 + POST /ai-generate AI 生成模板草稿
 *
 * 读端点守卫允许 API-Key 通过；写端点（classify/create-followup/ai-generate）必须 JWT。
 */

import { apiService } from './apiService';

/** 写端点统一 POST（统一认证头：API key + 登录会话 JWT + JSON），非 2xx 抛错（message 取服务端） */
async function postWithJwt<T>(path: string, body: unknown, endpoint?: string): Promise<T> {
  const url = apiService.buildApiUrl(path, endpoint);
  const res = await fetch(url, {
    method: 'POST',
    headers: apiService.getAuthHeaders(),
    body: JSON.stringify(body ?? {}),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json?.error?.message || `HTTP ${res.status}`);
  }
  return json as T;
}

// ─── 意图可视化 ─────────────────────────────────────────────

/** 与 server/src/email/aiExtract.ts 的 EmailExtractedPayload.intent 值域对齐 */
export type EmailIntent =
  | 'inquiry' | 'quotation' | 'order' | 'shipment_notice'
  | 'invoice' | 'complaint' | 'follow_up' | 'other';

export type EmailCustomerSignal = 'positive' | 'neutral' | 'urgent' | 'risk' | 'unknown';

/**
 * C8 覆盖层信息：已同步邮件的 DB 投影。
 * intent 为 null = 已同步但未 AI 抽取（不渲染意图徽标，但可用 DB id 调分类/跟进端点）。
 */
export interface EmailIntentInfo {
  intent: EmailIntent | null;
  customerSignal: EmailCustomerSignal | null;
  summary: string | null;
  /** C8：DB 邮件 id（EML__xx），调用 classify/create-followup 端点需要 */
  id: string | null;
  /** C8：业务标签（智能分类结果） */
  labels: string[];
  /** C8：已归档客户/订单链接 */
  relationId: string | null;
  orderId: string | null;
}

/** 意图中文标签（PRD 19.3：询价/订单确认/投诉/催款/一般 + AI 全值域扩展） */
export const EMAIL_INTENT_LABELS: Record<EmailIntent, string> = {
  inquiry: '询价',
  quotation: '报价',
  order: '订单确认',
  shipment_notice: '出运通知',
  invoice: '发票催款',
  complaint: '投诉',
  follow_up: '跟进',
  other: '一般',
};

/** 信号中文标签（仅 urgent/risk 需要显性提醒，其余不渲染避免列表噪音） */
export const EMAIL_SIGNAL_LABELS: Partial<Record<EmailCustomerSignal, string>> = {
  urgent: '紧急',
  risk: '风险',
};

/** C8 业务标签中文映射（智能分类 chips 展示） */
export const EMAIL_LABEL_LABELS: Record<string, string> = {
  inquiry: '询价',
  quotation: '报价',
  order: '订单',
  shipment_notice: '出运',
  invoice: '发票',
  complaint: '投诉',
  follow_up: '跟进',
  urgent: '紧急',
  risk: '风险',
  customer: '客户',
  bulk: '群发',
};

/**
 * 按 mailbox + IMAP uids 批量拉取 DB 覆盖层（意图徽标 + C8 操作上下文）。
 * 仅已同步邮件出现在结果中；未同步的静默缺席（列表无覆盖层）。
 */
export async function fetchEmailIntents(
  mailbox: string,
  uids: Array<string | number>,
  endpoint?: string,
): Promise<Record<string, EmailIntentInfo>> {
  const numericUids = uids
    .map(u => (typeof u === 'number' ? u : parseInt(String(u), 10)))
    .filter(n => Number.isFinite(n))
    .slice(0, 200);
  if (!mailbox || numericUids.length === 0) return {};

  const url = apiService.buildApiUrl(
    `/v1/email/intents?mailbox=${encodeURIComponent(mailbox)}&uids=${numericUids.join(',')}`,
    endpoint,
  );
  const res = await fetch(url, {
    headers: apiService.getAuthHeaders(),
  });
  if (!res.ok) return {}; // 覆盖层是增强层，失败不阻断列表
  const json: any = await res.json().catch(() => null);
  if (!json?.ok || !Array.isArray(json.items)) return {};

  const map: Record<string, EmailIntentInfo> = {};
  for (const item of json.items) {
    if (item?.uid === null || item?.uid === undefined) continue;
    map[String(item.uid)] = {
      intent: item.intent ? (item.intent as EmailIntent) : null,
      customerSignal: item.customerSignal ?? null,
      summary: item.summary ?? null,
      id: item.id ? String(item.id) : null,
      labels: Array.isArray(item.labels) ? item.labels.map(String) : [],
      relationId: item.relationId ?? null,
      orderId: item.orderId ?? null,
    };
  }
  return map;
}

// ─── C8 智能分类 + 任务关联自动化 ──────────────────────────────

export interface EmailClassifyResult {
  changed: boolean;
  added: string[];
  labels: string[];
  followUp: { created: boolean; followUpId?: string };
}

/** 智能分类（规则+AI 打标；默认投诉/紧急自动建跟进任务）。必须 JWT。 */
export async function classifyEmail(
  emailId: string,
  opts: { withAi?: boolean; autoFollowUp?: boolean } = {},
  endpoint?: string,
): Promise<EmailClassifyResult> {
  return postWithJwt<EmailClassifyResult>(`/v1/email/${encodeURIComponent(emailId)}/classify`, opts, endpoint);
}

export interface EmailFollowUpResult {
  reused: boolean;
  followUpId?: string;
  nextFollowUpAt?: string | null;
}

/** 邮件一键生成 CRM 跟进任务（幂等；无客户链接服务端返回 409）。必须 JWT。 */
export async function createFollowUpFromEmail(
  emailId: string,
  overrides: { content?: string; nextFollowUpAt?: string; nextFollowUpTopic?: string } = {},
  endpoint?: string,
): Promise<EmailFollowUpResult> {
  return postWithJwt<EmailFollowUpResult>(`/v1/email/${encodeURIComponent(emailId)}/create-followup`, overrides, endpoint);
}

// ─── 业务场景模板 ───────────────────────────────────────────

export interface EmailTemplate {
  id: string;
  type: string; // quote | payment_reminder | delivery_notice | inspection_report | greeting | general
  name: string;
  subject: string;
  body: string;
  variables: string[];
  /** C8 使用统计 */
  usageCount: number;
  lastUsedAt: number | null;
}

/** 模板类型中文标签（PRD 12.1：报价/催款/交期通知/验货报告/节日问候） */
export const EMAIL_TEMPLATE_TYPE_LABELS: Record<string, string> = {
  quote: '报价',
  payment_reminder: '催款',
  delivery_notice: '交期通知',
  inspection_report: '验货报告',
  greeting: '节日问候',
  general: '通用',
};

export async function fetchEmailTemplates(endpoint?: string, opts: { sort?: 'usage' } = {}): Promise<EmailTemplate[]> {
  const url = apiService.buildApiUrl(`/v1/email-templates${opts.sort === 'usage' ? '?sort=usage' : ''}`, endpoint);
  const res = await fetch(url, {
    headers: apiService.getAuthHeaders(),
  });
  if (!res.ok) return [];
  const json: any = await res.json().catch(() => null);
  if (!json?.ok || !Array.isArray(json.items)) return [];
  return json.items.map((t: any) => ({
    id: String(t.id),
    type: String(t.type || 'general'),
    name: String(t.name || ''),
    subject: String(t.subject || ''),
    body: String(t.body || ''),
    variables: Array.isArray(t.variables) ? t.variables.map(String) : [],
    usageCount: Number(t.usageCount) || 0,
    lastUsedAt: typeof t.lastUsedAt === 'number' ? t.lastUsedAt : null,
  }));
}

/** C8：上报模板使用（插入时调用一次；API-Key 可用的低风险计数端点） */
export async function markEmailTemplateUsed(id: string, endpoint?: string): Promise<void> {
  const url = apiService.buildApiUrl(`/v1/email-templates/${encodeURIComponent(id)}/use`, endpoint);
  try {
    await fetch(url, {
      method: 'POST',
      headers: apiService.getAuthHeaders(),
      body: '{}',
    });
  } catch { /* 使用统计失败不阻断发信主流程 */ }
}

export interface AiTemplateDraft {
  name: string;
  type: string;
  subject: string;
  body: string;
  variables: string[];
}

/** C8：AI 生成模板草稿（不落库；确认后走既有 POST / 保存）。必须 JWT。 */
export async function generateEmailTemplateWithAI(
  input: { scenario: string; type?: string; language?: 'zh' | 'en' | 'auto'; tone?: string; hints?: string },
  endpoint?: string,
): Promise<AiTemplateDraft> {
  const res = await postWithJwt<{ ok: boolean; draft: AiTemplateDraft }>('/v1/email-templates/ai-generate', input, endpoint);
  return res.draft;
}

/** 从模板文本提取 {{var}} 变量（与后端 extractTemplateVariables 同口径） */
export function extractTemplateVariables(...texts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of texts) {
    const re = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        out.push(m[1]);
      }
    }
  }
  return out;
}

/** 变量渲染：{{var}} → vars[var]，缺失变量保留占位符便于用户识别补填 */
export function renderEmailTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (raw, name) => {
    const v = vars[name];
    return v !== undefined && v !== '' ? v : raw;
  });
}

/**
 * 已知变量自动填充（PRD 19.3「变量自动填充」）：
 * 从收件人地址/当前日期等上下文推导，其余变量留空由用户补填。
 */
export function deriveTemplateVars(context: { to?: string; senderName?: string }): Record<string, string> {
  const vars: Record<string, string> = {};
  const nameSource = context.senderName || context.to || '';
  // "Display Name <a@b.com>" → Display Name；裸邮箱 → @ 前缀
  const displayMatch = nameSource.match(/^\s*(?:"?([^"<>]+)"?)\s*<[^>]+>/);
  const customerName = displayMatch?.[1]?.trim()
    || (nameSource.includes('@') ? nameSource.split('@')[0].trim() : nameSource.trim());
  if (customerName) vars.customerName = customerName;
  vars.date = businessNowDate().toISOString().slice(0, 10);
  vars.today = vars.date;
  return vars;
}

export const emailIntelligenceService = {
  fetchEmailIntents,
  fetchEmailTemplates,
  extractTemplateVariables,
  renderEmailTemplate,
  deriveTemplateVars,
};
