/**
 * C7 知识库深化：SOP 标准作业程序模板服务。
 *
 * 模板是「可复用的流程知识骨架」：title + category + summary + content（markdown 正文）
 * + steps（结构化步骤）。实例化 = 把模板渲染成一篇知识文档，复用 ingestKnowledgeDocument
 * 管线（分块 / checksum 幂等 / 审计），sourceType='sop'，metadata 带模板 id 与版本。
 */
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { ingestKnowledgeDocument } from '../ai/knowledgeIngestService';

export type SopTemplateErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'ARCHIVED'
  | 'CREATE_FAILED'
  | 'UPDATE_FAILED'
  | 'DELETE_FAILED'
  | 'INSTANTIATE_FAILED'
  | 'AUDIT_FAILED';

export interface SopTemplateError {
  code: SopTemplateErrorCode;
  message: string;
}

type Outcome<T> = { ok: true; result: T } | { ok: false; error: SopTemplateError };

export interface SopStep {
  title: string;
  detail?: string;
}

export interface SopTemplateRecord {
  id: string;
  title: string;
  category: string;
  summary: string | null;
  content: string;
  steps: SopStep[];
  version: number;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export interface SopTemplateInput {
  title?: string;
  category?: string;
  summary?: string | null;
  content?: string;
  steps?: SopStep[];
  status?: string;
}

const MAX_TITLE_LEN = 200;
const MAX_CONTENT_BYTES = 200_000;
const MAX_STEPS = 100;
const VALID_STATUSES = new Set(['active', 'archived']);

const now = () => BigInt(Date.now());
const newId = () => `sop_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;

function toNumber(v: unknown): number {
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.getTime();
  return Number(v);
}

function toRecord(row: any): SopTemplateRecord {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    summary: row.summary ?? null,
    content: row.content,
    steps: Array.isArray(row.steps) ? (row.steps as SopStep[]) : [],
    version: row.version,
    status: row.status,
    createdAt: toNumber(row.createdAt),
    updatedAt: toNumber(row.updatedAt),
  };
}

function normalizeSteps(raw: unknown): SopStep[] | null {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return null;
  if (raw.length > MAX_STEPS) return null;
  const steps: SopStep[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const title = String((item as any).title ?? '').trim();
    if (!title) return null;
    const detail = (item as any).detail != null ? String((item as any).detail).trim() : '';
    steps.push({ title, ...(detail ? { detail } : {}) });
  }
  return steps;
}

function validateWrite(input: { title?: string; category?: string; content?: string }, partial: boolean): SopTemplateError | null {
  if (!partial || input.title !== undefined) {
    const title = (input.title || '').trim();
    if (!title) return { code: 'INVALID_INPUT', message: 'title is required' };
    if (title.length > MAX_TITLE_LEN) return { code: 'INVALID_INPUT', message: `title exceeds ${MAX_TITLE_LEN} chars` };
  }
  if (!partial || input.category !== undefined) {
    const category = (input.category || '').trim();
    if (!category) return { code: 'INVALID_INPUT', message: 'category is required' };
  }
  if (!partial || input.content !== undefined) {
    const content = (input.content || '').trim();
    if (!content) return { code: 'INVALID_INPUT', message: 'content is required' };
    if (Buffer.byteLength(content, 'utf-8') > MAX_CONTENT_BYTES) {
      return { code: 'INVALID_INPUT', message: `content exceeds ${MAX_CONTENT_BYTES} bytes` };
    }
  }
  return null;
}

export async function listSopTemplates(
  prisma: PrismaClient,
  filter?: { category?: string; status?: string },
): Promise<SopTemplateRecord[]> {
  const where: any = { deletedAt: null };
  // 默认只返回 active；显式 status='all' 返回全部（含 archived）
  if (filter?.status && filter.status !== 'all') where.status = filter.status;
  else if (!filter?.status) where.status = 'active';
  if (filter?.category) where.category = filter.category;
  const rows = await (prisma as any).sopTemplate.findMany({ where, orderBy: [{ updatedAt: 'desc' }] });
  return (rows as any[]).map(toRecord);
}

export async function createSopTemplate(params: {
  prisma: PrismaClient;
  input: SopTemplateInput;
  actorId?: string;
  ip?: string | null;
}): Promise<Outcome<SopTemplateRecord>> {
  const { prisma, input, actorId, ip } = params;
  const valErr = validateWrite(input, false);
  if (valErr) return { ok: false, error: valErr };
  const steps = normalizeSteps(input.steps);
  if (steps === null) return { ok: false, error: { code: 'INVALID_INPUT', message: `steps must be an array of {title, detail?} (max ${MAX_STEPS})` } };
  if (input.status !== undefined && !VALID_STATUSES.has(input.status)) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: `status must be one of: ${[...VALID_STATUSES].join(', ')}` } };
  }

  try {
    const row = await (prisma as any).sopTemplate.create({
      data: {
        id: newId(),
        title: input.title!.trim(),
        category: input.category!.trim(),
        summary: input.summary?.trim() || null,
        content: input.content!.trim(),
        steps,
        version: 1,
        status: input.status || 'active',
        createdAt: now(),
        updatedAt: now(),
      },
    });
    try {
      await writeRouteAuditLog({
        prisma,
        actorId: actorId || 'system',
        operation: 'sop_template_create',
        targetType: 'SopTemplate',
        targetId: row.id,
        source: 'route:knowledge:sop-template:create',
        after: { id: row.id, title: row.title, category: row.category, version: row.version },
        ip: ip ?? null,
      });
    } catch (auditErr: any) {
      return { ok: false, error: { code: 'AUDIT_FAILED', message: String(auditErr?.message ?? auditErr) } };
    }
    return { ok: true, result: toRecord(row) };
  } catch (e: any) {
    return { ok: false, error: { code: 'CREATE_FAILED', message: String(e?.message ?? e) } };
  }
}

export async function updateSopTemplate(params: {
  prisma: PrismaClient;
  id: string;
  input: SopTemplateInput;
  actorId?: string;
  ip?: string | null;
}): Promise<Outcome<SopTemplateRecord>> {
  const { prisma, id, input, actorId, ip } = params;
  const valErr = validateWrite(input, true);
  if (valErr) return { ok: false, error: valErr };
  if (input.status !== undefined && !VALID_STATUSES.has(input.status)) {
    return { ok: false, error: { code: 'INVALID_INPUT', message: `status must be one of: ${[...VALID_STATUSES].join(', ')}` } };
  }
  let steps: SopStep[] | undefined;
  if (input.steps !== undefined) {
    const normalized = normalizeSteps(input.steps);
    if (normalized === null) return { ok: false, error: { code: 'INVALID_INPUT', message: `steps must be an array of {title, detail?} (max ${MAX_STEPS})` } };
    steps = normalized;
  }

  try {
    const existing = await (prisma as any).sopTemplate.findFirst({ where: { id, deletedAt: null } });
    if (!existing) return { ok: false, error: { code: 'NOT_FOUND', message: `sop template not found: ${id}` } };

    // 内容/步骤变化才递增版本；纯元数据（分类/摘要/状态）不动版本
    const contentChanged = (input.content !== undefined && input.content.trim() !== existing.content) || steps !== undefined;
    const row = await (prisma as any).sopTemplate.update({
      where: { id },
      data: {
        ...(input.title !== undefined ? { title: input.title.trim() } : {}),
        ...(input.category !== undefined ? { category: input.category.trim() } : {}),
        ...(input.summary !== undefined ? { summary: input.summary?.trim() || null } : {}),
        ...(input.content !== undefined ? { content: input.content.trim() } : {}),
        ...(steps !== undefined ? { steps } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        version: contentChanged ? existing.version + 1 : existing.version,
        updatedAt: now(),
      },
    });
    try {
      await writeRouteAuditLog({
        prisma,
        actorId: actorId || 'system',
        operation: 'sop_template_update',
        targetType: 'SopTemplate',
        targetId: id,
        source: 'route:knowledge:sop-template:update',
        before: { title: existing.title, version: existing.version },
        after: { title: row.title, version: row.version, status: row.status },
        ip: ip ?? null,
      });
    } catch (auditErr: any) {
      return { ok: false, error: { code: 'AUDIT_FAILED', message: String(auditErr?.message ?? auditErr) } };
    }
    return { ok: true, result: toRecord(row) };
  } catch (e: any) {
    return { ok: false, error: { code: 'UPDATE_FAILED', message: String(e?.message ?? e) } };
  }
}

export async function deleteSopTemplate(params: {
  prisma: PrismaClient;
  id: string;
  actorId?: string;
  ip?: string | null;
}): Promise<Outcome<{ id: string }>> {
  const { prisma, id, actorId, ip } = params;
  try {
    const existing = await (prisma as any).sopTemplate.findFirst({ where: { id, deletedAt: null } });
    if (!existing) return { ok: false, error: { code: 'NOT_FOUND', message: `sop template not found: ${id}` } };
    await (prisma as any).sopTemplate.update({ where: { id }, data: { deletedAt: now(), updatedAt: now() } });
    try {
      await writeRouteAuditLog({
        prisma,
        actorId: actorId || 'system',
        operation: 'sop_template_delete',
        targetType: 'SopTemplate',
        targetId: id,
        source: 'route:knowledge:sop-template:delete',
        before: { title: existing.title, version: existing.version },
        ip: ip ?? null,
      });
    } catch (auditErr: any) {
      return { ok: false, error: { code: 'AUDIT_FAILED', message: String(auditErr?.message ?? auditErr) } };
    }
    return { ok: true, result: { id } };
  } catch (e: any) {
    return { ok: false, error: { code: 'DELETE_FAILED', message: String(e?.message ?? e) } };
  }
}

/** 模板 → 知识文档正文（单一渲染来源，实例化与预置种子共用） */
export function renderSopTemplateText(tpl: { title: string; summary?: string | null; content: string; steps?: SopStep[] | null }): string {
  const parts: string[] = [];
  if (tpl.summary?.trim()) parts.push(tpl.summary.trim());
  const steps = Array.isArray(tpl.steps) ? tpl.steps : [];
  if (steps.length > 0) {
    parts.push(steps.map((s, i) => `${i + 1}. ${s.title}${s.detail ? `\n   ${s.detail}` : ''}`).join('\n'));
  }
  parts.push(tpl.content.trim());
  return parts.filter(Boolean).join('\n\n');
}

export async function instantiateSopTemplate(params: {
  prisma: PrismaClient;
  id: string;
  actorId?: string;
  ip?: string | null;
}): Promise<Outcome<{ documentId: string; checksum: string; chunkCount: number; templateVersion: number }>> {
  const { prisma, id, actorId, ip } = params;
  const tpl = await (prisma as any).sopTemplate.findFirst({ where: { id, deletedAt: null } });
  if (!tpl) return { ok: false, error: { code: 'NOT_FOUND', message: `sop template not found: ${id}` } };
  if (tpl.status !== 'active') return { ok: false, error: { code: 'ARCHIVED', message: 'archived template cannot be instantiated' } };

  const text = renderSopTemplateText({ title: tpl.title, summary: tpl.summary, content: tpl.content, steps: tpl.steps as SopStep[] | null });
  const outcome = await ingestKnowledgeDocument({
    prisma,
    input: {
      title: `SOP：${tpl.title}`,
      text,
      sourceType: 'sop',
      metadata: { category: tpl.category, sopTemplateId: tpl.id, sopTemplateVersion: tpl.version },
    },
    actorId,
    ip,
    auditSource: 'route:knowledge:sop-template:instantiate',
    auditOperation: 'sop_template_instantiate',
  });
  if (!outcome.ok) {
    return { ok: false, error: { code: outcome.error.code === 'DUPLICATE_CHECKSUM' ? 'INVALID_INPUT' : 'INSTANTIATE_FAILED', message: outcome.error.message } };
  }
  return { ok: true, result: { ...outcome.result, templateVersion: tpl.version } };
}

// ─── 预置种子：纺织外贸核心 SOP（仅当表为空时写入，幂等） ───

const SEED_TEMPLATES: Array<{ title: string; category: string; summary: string; content: string; steps: SopStep[] }> = [
  {
    title: '大货跟单标准流程',
    category: 'Production',
    summary: '从订单确认到出货的贸易侧跟单节点与责任要点（不含工厂内部加工管理）。',
    content: '适用范围：面料与成衣大货订单。跟单员需在订单确认后建立跟单档案，按节点推进并留存凭证；任何交期/数量/质量异常须 24 小时内上报并记录处理结果。',
    steps: [
      { title: '订单确认', detail: '核对 PO 条款、价格、交期、付款方式；确认订单状态进入 Production。' },
      { title: '物料落实', detail: '确认面辅料采购/到位计划，关键物料留样。' },
      { title: '产前样确认', detail: '产前样客户确认后方可上大货；留存确认记录。' },
      { title: '中期跟进', detail: '生产中期核对进度与品质，必要时现场查货。' },
      { title: '尾期验货', detail: '按验货 SOP 安排尾期验货，不合格不得出运。' },
      { title: '出运衔接', detail: '确认船期/订舱，转入出运 SOP；同步更新订单节点。' },
    ],
  },
  {
    title: '验货标准流程',
    category: 'Production',
    summary: '尾期验货（FRI）与中期验货（DUPRO）的抽样、判定与报告要求。',
    content: '抽样标准：AQL 2.5/4.0（客户另有约定从其约定）。验货报告须含缺陷统计、照片、判定结果；Critical 缺陷零容忍，Major 超限即判不合格并启动返工/复验流程。',
    steps: [
      { title: '验货预约', detail: '出货前 7-10 天与工厂/客户确认验货日期与方式（自检/第三方/客户现场）。' },
      { title: '资料准备', detail: 'PO、确认样、规格书、装箱要求、既往质量记录。' },
      { title: '现场抽样', detail: '按 AQL 抽样表抽取箱数与件数，覆盖全部色号尺码。' },
      { title: '缺陷判定', detail: '按 Critical/Major/Minor 分级记录，拍照留证。' },
      { title: '报告签发', detail: '24 小时内出具报告；不合格项明确返工期限与复验安排。' },
    ],
  },
  {
    title: '出运标准流程',
    category: 'Policy',
    summary: '订舱、装箱、单证、报关到放行的出运全节点。',
    content: '出运前两周确认船样（Separates 产品提前一周确认头件）；单证遵循外贸单证体系（发票/箱单/提单等），报关信息须与订单、装箱明细一致。',
    steps: [
      { title: '订舱', detail: '按交期倒排订舱，录入运单（运输方式/ETD/ETA/承运人）。' },
      { title: '装箱确认', detail: '维护装箱明细（装运行 + 逐箱分配），核对件毛体。' },
      { title: '单证制作', detail: '生成商业发票、装箱单等，关联运单与订单。' },
      { title: '报关申报', detail: '创建报关单并关联运单；放行后回填报关单号与放行日期。' },
      { title: '物流跟踪', detail: '录入跟踪号与承运商查询链接，节点状态随时间轴更新。' },
    ],
  },
  {
    title: '出口报关标准流程',
    category: 'Policy',
    summary: '报关资料准备、申报、查验应对与放行归档。',
    content: 'HS 编码与申报要素须与商品档案一致；退税关联的单证（报关单/发票/收汇凭证）按退税时效归档。查验异常须当日上报并记录处理过程。',
    steps: [
      { title: '资料准备', detail: '合同/发票/箱单/报关要素/许可证件（如需）。' },
      { title: '申报', detail: '单一窗口或报关行申报，记录报关单号。' },
      { title: '查验应对', detail: '查验通知后配合开箱/取样，补充说明资料。' },
      { title: '放行归档', detail: '放行日期回填运单；单证归档并关联退税申报。' },
    ],
  },
];

/** 幂等种子：仅当 SopTemplate 表为空时写入预置 SOP。返回是否执行了写入。 */
export async function ensureSopTemplateSeed(prisma: PrismaClient): Promise<boolean> {
  const count = await (prisma as any).sopTemplate.count();
  if (count > 0) return false;
  const ts = now();
  for (const tpl of SEED_TEMPLATES) {
    await (prisma as any).sopTemplate.create({
      data: {
        id: newId(),
        title: tpl.title,
        category: tpl.category,
        summary: tpl.summary,
        content: tpl.content,
        steps: tpl.steps,
        status: 'active',
        createdAt: ts,
        updatedAt: ts,
      },
    });
  }
  return true;
}
