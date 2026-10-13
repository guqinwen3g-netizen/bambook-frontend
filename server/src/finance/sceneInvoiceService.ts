/**
 * sceneInvoiceService.ts — DR-054 阶段 F：场景化开票（财务域统一入口）
 *
 * 设计真源：docs/design/04-模块设计/03-订单与生产/Development-开发/样品-开发-费用-开票-全局综合设计.md
 *
 * 原则：开票统一在财务域按场景完成；样品/开发域不出现开票动作。
 * 场景（scene）：
 *   - dev_cost  开发费：sourceId=DevelopmentCase.id，候选=开发案下全部 CostRecord（含批次/样品/封样）
 *   - fabric    面料开发&大货：sourceId=面料 DevelopmentCase.id，候选=面料案下 CostRecord（同 dev_cost 聚合）
 *   - sample    样品及邮寄：sourceId=Sample.id，候选=该样品 CostRecord
 *   - order     大货货款：sourceId=Order.id，候选=订单 CostRecord（含大货样品费用行）
 *
 * 行级唯一：所选 CostRecord 写入 InvoiceLine（@@unique([sourceType,sourceId])），数据库兜底防一费用行两张票。
 * 幂等：create 失败可重试；已占用行被 LINE_ALREADY_ALLOCATED 拦截（409）。
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { createInvoice } from '../finance/invoiceMutationService';
import { listCostCandidateRows, abortManualInvoice, currentManualInvoiceActor, lockManualInvoiceSources, manualInvoiceFailure } from './billingItemService';
import type { TokenPayload } from '../auth/service';
import { developmentBillingReadWhere, assertDevelopmentBillingSourceAccess } from '../development/developmentBillingRouteAccess';
import { httpStatusOfCode } from '../shared/errorCodes';
import { logger } from '../lib/logger';
import { todayLocalKey } from '../shared/localDate';

type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; status: number } };
const fail = (code: string, message: string, status = 400): Result<never> => ({ ok: false, error: { code, message, status } });
const ok = <T>(data: T): Result<T> => ({ ok: true, data });

export const SCENE_TYPES = ['dev_cost', 'fabric', 'sample', 'order'] as const;
const SCENE_LABELS: Record<string, string> = {
  dev_cost: '开发费', fabric: '面料开发&大货', sample: '样品及邮寄', order: '大货货款',
};

/** 场景 → 费用候选行查询维度（与 listCostCandidateRows 对齐） */
function sceneQuery(scene: string, sourceId: string): { caseId?: string; sampleId?: string; orderId?: string } {
  if (scene === 'dev_cost' || scene === 'fabric') return { caseId: sourceId };
  if (scene === 'sample') return { sampleId: sourceId };
  return { orderId: sourceId };
}

/** 场景来源摘要（客户/标题） */
async function resolveSceneSource(prisma: PrismaClient, scene: string, sourceId: string, strict = false): Promise<{
  customerRelationId?: string | null;
  customerName?: string | null;
  title: string;
}> {
  const row = async (model: string) => (prisma as any)[model]?.findFirst?.({ where: { id: sourceId, deletedAt: null } }).catch(() => null) ?? null;
  if (scene === 'dev_cost' || scene === 'fabric') {
    const c = await row('developmentCase');
    if (!c) return { title: `开发案 ${sourceId}` };
    return {
      customerRelationId: c.customerRelationId ?? null,
      customerName: c.customerName ?? null,
      title: `开发案 ${c.code}${c.name ? `（${c.name}）` : ''}`,
    };
  }
  if (scene === 'sample') {
    const s = await row('sample');
    if (!s) return { title: `样品 ${sourceId}` };
    let customerName: string | null = s.customerName ?? null;
    if (!customerName && s.customerRelationId) {
      const rel = await (prisma as any).relation?.findFirst?.({ where: { id: s.customerRelationId } }).catch(() => null) ?? null;
      customerName = rel?.name ?? null;
    }
    return { customerRelationId: s.customerRelationId ?? null, customerName, title: `样品 ${s.code || s.id}` };
  }
  const o = await row('order');
  if (!o) return { title: `订单 ${sourceId}` };
  return {
    customerRelationId: o.customerRelationId ?? null,
    customerName: o.customerName ?? null,
    title: `订单 ${o.code || o.poNumber || o.id}`,
  };
}

/** preview：候选费用行 + 汇总 + 客户/标题（只读） */
export async function previewSceneInvoice(params: {
  prisma: PrismaClient;
  accessWhere?:Record<string,unknown>;
  scene: string;
  sourceId: string;
}): Promise<Result<{
  scene: string; sceneLabel: string; title: string;
  customerRelationId?: string | null; customerName?: string | null;
  rows: any[]; total: number;
  /** 兼容字段：仅单币种有效（多币种恒为 0/''）；请优先读 summaryByCurrency */
  summaryAmount: number; summaryCurrency: string;
  /** T7-②：按币种分组的汇总（多币种场景的真源，不再显示 0） */
  summaryByCurrency: Array<{ currency: string; amount: number }>;
  /** T7-②：是否多币种（true 时前端应提示「请按币种分开开票」，与 create 的 MULTI_CURRENCY 同口径） */
  multiCurrency: boolean;
}>> {
  const { prisma, scene, sourceId } = params;
  if (!SCENE_TYPES.includes(scene as any)) return fail('INVALID_SCENE', `scene 必须是 ${SCENE_TYPES.join('|')}`, 400);
  const source = await resolveSceneSource(prisma, scene, sourceId);
  const r = await listCostCandidateRows({ prisma, query: sceneQuery(scene, sourceId), accessWhere:params.accessWhere });
  if (!r.ok) return fail(r.error.code, r.error.message, r.error.status);
  const rows = r.data.rows;
  // T7-②：汇总**按币种分组**。旧实现多币种时把 summaryAmount 直接置 0 →
  // 用户在预览页看到「合计 0」以为没有费用可选，点下去才被 create 的
  // MULTI_CURRENCY 拦住（preview 与 create 口径自相矛盾）。
  const byCurrency = new Map<string, number>();
  for (const x of rows) {
    const cur = String(x.currency ?? '').trim() || 'CNY';
    byCurrency.set(cur, (byCurrency.get(cur) ?? 0) + Number(x.amount || 0));
  }
  const summaryByCurrency = [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amount]) => ({ currency, amount: Math.round(amount * 10000) / 10000 }));
  const multiCurrency = summaryByCurrency.length > 1;
  // 兼容字段：仅在**单币种**时有效；多币种请读 summaryByCurrency（前端已按此改造）
  const summaryCurrency = summaryByCurrency.length === 1 ? summaryByCurrency[0].currency : '';
  const summaryAmount = summaryByCurrency.length === 1 ? summaryByCurrency[0].amount : 0;
  return ok({
    scene, sceneLabel: SCENE_LABELS[scene] ?? scene,
    title: source.title,
    customerRelationId: source.customerRelationId,
    customerName: source.customerName,
    rows,
    total: r.data.total,
    summaryAmount,
    summaryCurrency,
    summaryByCurrency,
    multiCurrency,
  });
}

/** create：选费用行子集 → 发票（含 InvoiceLine 行级） */
export async function createSceneInvoice(params: {
  prisma: PrismaClient;
  accessWhere?:Record<string,unknown>;
  scene: string;
  sourceId: string;
  lineIds: string[];
  input?: { invoiceNumber?: string; type?: string; status?: string; currency?: string; issueDate?: string; dueDate?: string; notes?: string; customerRelationId?: string; customerName?: string; exchangeRate?: number };
  actorId: string;
  trustedActor?: TokenPayload | null;
  ip?: string | null;
}): Promise<Result<{ invoice: any; lines: any[] }>> {
  const { prisma, scene, sourceId, lineIds, actorId, ip } = params;
  if (!SCENE_TYPES.includes(scene as any)) return fail('INVALID_SCENE', `scene 必须是 ${SCENE_TYPES.join('|')}`, 400);
  const effects: Array<() => Promise<void>> = [];
  try {
    const data = await prisma.$transaction(async (tx: any) => {
      let actor = await currentManualInvoiceActor(tx, actorId, params.trustedActor);
      const sourceType = scene === 'sample' ? 'Sample' : scene === 'order' ? 'Order' : 'DevelopmentCase';
      // Load dependencies before touching sources. Explicit candidate failures keep
      // the public contract; no candidate facts are returned until access is checked.
      const preflight = await listCostCandidateRows({ prisma: tx, query: sceneQuery(scene, sourceId), accessWhere: params.accessWhere });
      if (!preflight.ok) abortManualInvoice(preflight.error.code, preflight.error.message, preflight.error.status);
      await assertDevelopmentBillingSourceAccess(tx, actor, sourceType, sourceId, 'write', { fresh: true });
      const scope = await developmentBillingReadWhere(tx, actor, { fresh: true });
      const scoped = await listCostCandidateRows({ prisma: tx, query: sceneQuery(scene, sourceId), accessWhere: scope });
      if (!scoped.ok) abortManualInvoice(scoped.error.code, scoped.error.message, scoped.error.status);
      const chosen = new Set(lineIds ?? []);
      if (!chosen.size) abortManualInvoice('NO_LINES_SELECTED', '请至少选择一条费用行', 400);
      const hinted = scoped.data.rows.filter((row: any) => chosen.has(row.id));
      if (hinted.length !== chosen.size) abortManualInvoice('LINE_NOT_AVAILABLE', '部分费用行不存在，请刷新后重新选择', 409);
      await lockManualInvoiceSources(tx, [{ type: sourceType, id: sourceId }, ...hinted.map((row: any) => ({ type: 'CostRecord', id: row.id }))]);
      actor = await currentManualInvoiceActor(tx, actorId, params.trustedActor);
      await assertDevelopmentBillingSourceAccess(tx, actor, sourceType, sourceId, 'write', { fresh: true });
      const currentScope = await developmentBillingReadWhere(tx, actor, { fresh: true });
      const r = await listCostCandidateRows({ prisma: tx, query: sceneQuery(scene, sourceId), accessWhere: currentScope });
      if (!r.ok) abortManualInvoice(r.error.code, r.error.message, r.error.status);
      const source = await resolveSceneSource(tx, scene, sourceId, true);
      const rows = r.data.rows;
      const selectedAll = rows.filter((x: any) => chosen.has(x.id));
      if (selectedAll.length !== chosen.size) abortManualInvoice('LINE_NOT_AVAILABLE', '部分费用行不存在，请刷新后重新选择', 409);
      // §10.7 开票互斥口径：同一费用行只能有一张有效票——占用行硬拦截并报占用来源（作废票已释放，可重开）
      const occupiedRows = selectedAll.filter((x: any) => x.occupied);
      if (occupiedRows.length > 0) {
        const detail = occupiedRows.map((x: any) => `${x.recordNo}（已被${x.occupiedBy ?? '其他发票'}占用）`).join('、');
        abortManualInvoice('LINES_OCCUPIED', `所选费用行已开过票：${detail}。如需更正请先作废原发票再重开`, 409);
      }
      // Candidate DTO amounts are display numbers. Consume the exact stored
      // CostRecord values only after their original rows and parents are locked.
      const exactRows: any[] = await tx.costRecord.findMany({ where: { id: { in: [...chosen] }, deletedAt: null }, orderBy: { id: 'asc' } });
      const exactById = new Map<string, any>(exactRows.map(row => [row.id, row]));
      if (exactRows.length !== chosen.size) abortManualInvoice('LINE_NOT_AVAILABLE', '部分费用行不存在，请刷新后重新选择', 409);
      const selected = selectedAll.map((row: any) => {
        const actual = exactById.get(row.id);
        if (!actual || actual.sourceType !== row.sourceType || actual.sourceId !== row.sourceId)
          abortManualInvoice('LINE_NOT_AVAILABLE', '费用来源已变化，请刷新后重新选择', 409);
        return { ...row, currency: actual.currency, amountExact: new Prisma.Decimal(actual.amount).toString() };
      });

      // 同币种校验（发票单币种；不同币种请按币种分开开票）
      const currencies = [...new Set(selected.map((x: any) => x.currency))];
      const currency = params.input?.currency || currencies[0] || 'CNY';
      if (currencies.length > 1) abortManualInvoice('MULTI_CURRENCY', '所选费用行币种不一致，请按币种分开开票，指定币种不代表已换算', 400);
      if (!currencies[0] || currency !== currencies[0]) abortManualInvoice('CURRENCY_MISMATCH', '开票币种必须与所选费用币种一致，不能直接修改币种代替换算', 400);

      const amount = selected.reduce((sum: Prisma.Decimal, row: any) => sum.plus(row.amountExact), new Prisma.Decimal(0)).toString();
      const type = params.input?.type || 'Receivable';
      const status = params.input?.status || 'Issued';
      const notes = [
        params.input?.notes ? String(params.input.notes) : null,
        `场景开票 · ${SCENE_LABELS[scene] ?? scene} · ${source.title}`,
      ].filter(Boolean).join('；');

      const r2 = await createInvoice({
        prisma,
        transaction: { tx, deferAfterCommit: work => { effects.push(work); } },
        actor,
        input: {
          invoiceNumber: params.input?.invoiceNumber,
          type,
          status,
          amount,
          currency,
          issueDate: params.input?.issueDate || todayLocalKey(),
          dueDate: params.input?.dueDate,
          customerRelationId: params.input?.customerRelationId || (source.customerRelationId ?? undefined),
          customerName: params.input?.customerName || (source.customerName ?? undefined),
          notes: notes || undefined,
          exchangeRate: params.input?.exchangeRate,
          sourceType: 'Scene',
          sourceId: `${scene}:${sourceId}`,
          // 行级开票：费用行为开票唯一来源（一费用行一张票）
          invoiceLines: selected.map((x: any) => ({
            sourceType: 'CostRecord',
            sourceId: x.id,
            amount: x.amountExact,
            currency: x.currency,
            description: `费用 ${x.recordNo}（${x.costType}）${x.sourceLabel ? ` · ${x.sourceLabel}` : ''}`,
          })),
        },
        actorId,
        ip: ip ?? null,
      });
      if (!r2.ok) {
        const original = r2.error?.code ?? 'INVOICE_CREATE_FAILED';
        const code = ['LINE_ALREADY_ALLOCATED', 'INVALID_AMOUNT', 'UNAUTHORIZED', 'FORBIDDEN', 'AUTHORIZATION_UNAVAILABLE', 'DEPENDENCY_CHECK_FAILED', 'NOT_FOUND', 'CONFLICT'].includes(original) ? original : 'INVOICE_CREATE_FAILED';
        abortManualInvoice(code, r2.error?.message ?? '创建发票失败', code === 'INVOICE_CREATE_FAILED' ? 400 : httpStatusOfCode(code));
      }
      const invoice = r2.data!.invoice;
      await writeRouteAuditLog({
        prisma: tx, actorId, source: 'route:scene-invoice', operation: 'create_scene_invoice',
        targetType: 'Invoice', targetId: invoice.id,
        after: { invoiceNumber: invoice.invoiceNumber, scene, sourceId, lineCount: selected.length, amount, currency, status },
        ip: ip ?? null,
      });
      await currentManualInvoiceActor(tx, actorId, params.trustedActor);
      return { invoice, lines: selectedAll };
    });
    for (const effect of effects) await effect().catch(error => logger.error('[SceneInvoice] post-commit effect failed', { scene, sourceId, error }));
    return ok(data);
  } catch (error) {
    logger.error('[SceneInvoice] transaction failed', { scene, sourceId, error });
    return manualInvoiceFailure(error, 'SCENE_INVOICE_CREATE_FAILED', '场景开票未能完成，请核对原费用后重试。');
  }
}
