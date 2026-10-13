/**
 * paymentRequestRoute.ts — DR-017 付款申请 API
 *
 * 挂载：createPaymentRequestRouter({ prisma, requireAuth })
 * 建议路径：/api/v1/payment-requests（由主代理在 index.ts 收口）
 *
 * 端点：
 *   POST /              — 创建付款申请（scope finance:payment_request:create；创建即 Pending + 生成审批单）
 *   GET  /              — 列表（按 status / paymentCategory / applicantId / search 过滤，附 total）
 *   GET  /:id           — 详情（附 approvalRequest / paymentVoucher 关联快照）
 *   POST /:id/record-payment — 财务显式登记本次实际付款（vouchers:write；原键/版本/证据）
 *   POST /:id/issue-voucher — 同一显式实际命令的兼容路径，不由批准自动执行
 *   POST /:id/cancel    — 申请人作废（仅 Draft/Pending，仅本人）
 *
 * 鉴权：JWT fail-closed（无 token 401，无 scope 403）
 */

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { extractActorFromRequest } from '../auth/middleware';
import { hasScopeOnRequest } from '../auth/permissionGuard';
import { createApprovalRoutingService } from '../approvals/approvalRoutingService';
import { createApprovalCreateService } from '../approvals/approvalCreateService';
import {
  createPaymentRequestService,
  PAYMENT_REQUEST_SOURCE_TYPES,
  paymentRequestCreateCommandInput,
  type PaymentRequestSourceType,
} from './paymentRequestService';
import { logger } from '../lib/logger';
// ★ 未预期异常不再把原始错误（Prisma 原文/表名列名）返回前端；业务错误（code+statusCode）仍透传。
//   本文件各处已有 `if (!result.ok) return res.status(result.error.statusCode)…` 处理**业务错误**，
//   故下面的 catch 只接**未预期异常** ⇒ 兜底文案即可，不需要回显 e.message。
import { safeRouteError } from '../shared/routeError';
// ★ 口径 B3：付款申请三档数据范围（含「被指派审批人恒可见」豁免）
import { createPermissionService } from '../auth/permissionService';
import { buildPaymentRequestScope, canSeePaymentRequest } from './paymentRequestScope';
import { renderServerDocument } from '../templates/docTemplates/registry';
import { loadPaymentRequestDocData } from '../templates/docTemplates/paymentRequest';
import { resolveDocumentSignerByDoc } from '../seal/documentSigner';
import { upsertDomainTradeDocument, generateTradeDocumentFile } from '../customs/tradeDocumentLifecycleService';
import { ciJson } from '../development/developmentCiSource';
import { readSupplierPaymentFacts } from './supplierPaymentExecutionService';
import { assertPaymentRequestPayableRead, hasPaymentRequestPayableBasis, listPaymentRequestPayableCandidates } from './paymentRequestPayableSource';

export interface PaymentRequestRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
}

export function createPaymentRequestRouter(options: PaymentRequestRouterOptions): Router {
  const router = Router();
  const { prisma, requireAuth } = options;

  const routingService = createApprovalRoutingService({ prisma });
  const approvalCreateService = createApprovalCreateService({ prisma, routingService });
  const paymentRequestService = createPaymentRequestService({ prisma, approvalCreateService });
  // ★ 口径 B3（2026-09-17 业务方拍板）：付款申请套**三档数据范围**。
  const permSvc = createPermissionService({ prisma });

  /**
   * 解析当前请求者的付款申请数据范围（三档）。
   *
   * ★ 取代原先的「`finance:read` 二元档」（有 → 全看，无 → 只看自己）——
   *   二元档的后果：**业务员档实测可读财务/后勤/其他业务员名下的全部付款申请**
   *   （含供应商名与金额，最大一笔 166,864.00，P4-1 #18）。
   *   三档后：业务员看「自己提的 + 同组经手的」，主管看本组，财务/领导看全部；
   *   **被指派的审批人 `reviewerId` 恒可见**（否则跨组审批人看不到要批的单）。
   */
  const resolveScope = async (req: Request, userId: string) =>
    buildPaymentRequestScope(
      await permSvc.getDataScopeResolver(extractActorFromRequest(req), 'paymentRequests'),
      userId,
    );

  // ── 鉴权：JWT fail-closed ──
  const authenticate = (req: Request, res: Response): { userId: string; roles: string[] } | null => {
    const actor = extractActorFromRequest(req);
    if (!actor?.userId) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Login required.' });
      return null;
    }
    (req as any).actor = actor; // 供 hasScopeOnRequest 使用（permissionGuard 从 req.actor 取权限）
    return { userId: actor.userId, roles: actor.roles ?? [] };
  };

  const requireScope = (req: Request, res: Response, scope: string): boolean => {
    if (!requireAuth) return true;
    if (!hasScopeOnRequest(req, scope as any)) {
      res.status(403).json({ error: 'FORBIDDEN', message: `INSUFFICIENT_SCOPE: ${scope}` });
      return false;
    }
    return true;
  };

  // P4-1 #18（2026-09-15）— 行级收口：持 finance:read 全档；否则仅申请人本人。
  //   矩阵六角色（owner/admin/manager/finance/sales_base 等）均持有 finance:read → 全档行为不变；
  //   仅拦住自定义角色 / 受限 API-Key 等无财务域权限的主体。返回 true=已持有 finance:read。
  const isFinanceReader = (req: Request): boolean =>
    hasScopeOnRequest(req, 'finance:read' as any);

  // Explicit static path precedes /:id. Actual source L2 filtering happens
  // before the result's visible-page cursor is determined, without totals.
  router.get('/payable-candidates', async (req: Request, res: Response) => {
    if (!authenticate(req, res)) return;
    if (!requireScope(req, res, 'finance:payment_request:create') || !requireScope(req, res, 'invoices:read')) return;
    try {
      const data = await prisma.$transaction(tx => listPaymentRequestPayableCandidates(tx, extractActorFromRequest(req), {
        supplierId: req.query.supplierId, currency: req.query.currency, search: req.query.search, cursor: req.query.cursor, limit: req.query.limit,
      }));
      return res.json(data);
    } catch (error) {
      const result = safeRouteError(error, { fallbackCode: 'PAYABLE_CANDIDATES_FAILED', fallbackMessage: '暂时无法核对可申请的供应商应付原票' });
      return res.status(result.status).json({ error: result.code, message: result.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // POST / — 创建付款申请（创建即提交审批）
  // ══════════════════════════════════════════════════════════════════
  router.post('/', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!requireScope(req, res, 'finance:payment_request:create')) return;

    try {
      const body = req.body || {};
      const sourceTypeRaw = body.sourceType ? String(body.sourceType).trim() : undefined;
      const sourceType = sourceTypeRaw && (PAYMENT_REQUEST_SOURCE_TYPES as readonly string[]).includes(sourceTypeRaw)
        ? (sourceTypeRaw as PaymentRequestSourceType)
        : undefined;

      const result = await paymentRequestService.createPaymentRequest({
        supplierId: body.supplierId ? String(body.supplierId).trim() : undefined,
        supplierName: body.supplierName ? String(body.supplierName).trim() : undefined,
        totalAmount: body.totalAmount,
        currency: String(body.currency ?? '').trim(),
        paymentCategory: body.paymentCategory ? String(body.paymentCategory).trim() : undefined,
        requestDate: body.requestDate ? String(body.requestDate).trim() : undefined,
        expectedPaymentDate: body.expectedPaymentDate ? String(body.expectedPaymentDate).trim() : undefined,
        sourceType,
        sourceId: body.sourceId ? String(body.sourceId).trim() : undefined,
        remark: body.remark ? String(body.remark).trim() : undefined,
        attachments: body.attachments,
        payableSelections: body.payableSelections,
        // The stable AP receipt hashes the actual whitelisted public body;
        // trim/default handling happens inside the business service. Never
        // include caller-authored actor/applicant/reviewer fields in that hash.
        ...(sourceType === 'supplier_payable' && body.requestKey !== undefined ? paymentRequestCreateCommandInput(body) : {}),
        actor: extractActorFromRequest(req),
        applicantId: auth.userId,
        // 前端传入的 reviewerId 绝不用于审批路由，仅透传审计（DR7-A2）
        clientSuppliedReviewerId: body.reviewerId ? String(body.reviewerId).trim() : null,
      });

      if (!result.ok) {
        return res.status(result.error.statusCode).json({ error: result.error.code, message: result.error.message });
      }
      return res.status(201).json(result.data);
    } catch (e: any) {
      logger.error('[PaymentRequestRoute] POST / failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '创建付款申请失败' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // GET / — 列表（status / paymentCategory / applicantId / search 过滤；附 total 供截断透明披露）
  //
  // P4-1 #18（2026-09-15，业务口径拍板）：
  //   · 持 finance:read → 全档（矩阵六角色基座全部持有 → 零回归）；
  //   · 未持 finance:read → 强制 applicantId === 自己，且忽略 query.applicantId 防绕过。
  //
  // 注：此前 P1-#12（commit 21feb30）以 `requireScope('finance:read')` gate 兜底——
  // 无财务域权限主体 403。但 gate 与本口径的 row narrowing 会互斥：gate 先 403 掉，
  // row narrowing 永远不触发（死代码）。本次按口径废 gate，以 row narrowing 为唯一
  // 访问控制：自定义角色 / 受限 API-Key / 无角色账号若没 finance:read 也能至少看自己的。
  // ══════════════════════════════════════════════════════════════════
  router.get('/', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    try {
      const where: any = { deletedAt: null };
      if (req.query.status) where.status = String(req.query.status);
      if (req.query.paymentCategory) where.paymentCategory = String(req.query.paymentCategory);
      // ★ 口径 B3（2026-09-17）：**三档数据范围**取代原「finance:read 二元档」。
      //   业务员只看「自己提的 + 同组经手的」，主管看本组，财务/领导看全部；
      //   被指派的审批人恒可见。见 paymentRequestScope.ts 与决策单 B3。
      const scope = await resolveScope(req, auth.userId);
      if (scope.unrestricted) {
        if (req.query.applicantId) where.applicantId = String(req.query.applicantId);
      } else {
        // AND 语义：与上面的 status/category 筛选并存（不覆盖）
        where.AND = [scope.where];
      }
      if(typeof req.query.warehouseId==='string')where.AND=[...(where.AND||[]),{attachments:{path:['sourceDocument','type'],equals:'warehouse'}},{attachments:{path:['sourceDocument','id'],equals:req.query.warehouseId}}];
      // search：申请编号 / 收款方 / 事由 三字段模糊匹配（与 finance route 同一 contains+insensitive 惯例）
      if (req.query.search) {
        const q = String(req.query.search).trim();
        if (q) {
          const qInsensitive = { contains: q, mode: 'insensitive' as const };
          where.OR = [
            { requestNumber: qInsensitive },
            { supplierName: qInsensitive },
            { remark: qInsensitive },
          ];
        }
      }
      const take = Math.min(Number(req.query.limit ?? 100), 500);
      const candidates = await prisma.paymentRequest.findMany({ where, orderBy: { createdAt: 'desc' } });
      const visible = [];
      for (const item of candidates) {
        if (hasPaymentRequestPayableBasis(item)) {
          try { await prisma.$transaction(tx => assertPaymentRequestPayableRead(tx, item, extractActorFromRequest(req))); }
          catch (error) {
            if ([403, 404].includes(safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR' }).status)) continue;
            throw error;
          }
        }
        visible.push(item);
      }
      return res.json({ items: visible.slice(0, take), total: visible.length });
    } catch (e: any) {
      logger.error('[PaymentRequestRoute] GET / failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '查询付款申请列表失败' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // GET /:id — 详情
  // P4-1 #18 续：finance:read 全档；未持 → applicantId === 自己才能看；不符 → 404 防存在性泄露
  //   （去掉 P1-#12 的 finance:read gate，与 GET / 同源规则）
  // ══════════════════════════════════════════════════════════════════
  router.get('/:id', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    try {
      const item = await prisma.paymentRequest.findUnique({ where: { id: req.params.id } });
      if (!item || item.deletedAt) {
        return res.status(404).json({ error: 'NOT_FOUND', message: `付款申请 ${req.params.id} 不存在` });
      }
      // ★ 口径 B3（2026-09-17）：三档数据范围取代原「finance:read 二元档」。
      //   越权 → 404（**与"不存在"同响应，不暴露存在性**）。
      //   ★ 判据走**共用内核** `canSeePaymentRequest`（与列表 where 同源，防两处漂移）。
      const scope = await resolveScope(req, auth.userId);
      if (!canSeePaymentRequest(item, scope)) {
        return res.status(404).json({ error: 'NOT_FOUND', message: `付款申请 ${req.params.id} 不存在` });
      }
      if (hasPaymentRequestPayableBasis(item))
        await prisma.$transaction(tx => assertPaymentRequestPayableRead(tx, item, extractActorFromRequest(req)));
      // 关联数据单独查询（PaymentRequest 模型无 @relation，禁用 include）
      const [approvalRequest, paymentVoucher] = await Promise.all([
        item.approvalRequestId
          ? prisma.approvalRequest.findUnique({
              where: { id: item.approvalRequestId },
              select: { id: true, status: true, reviewerId: true, decidedAt: true, decisionNote: true },
            }).catch(() => null)
          : Promise.resolve(null),
        item.paymentVoucherId
          ? prisma.paymentVoucher.findUnique({
              where: { id: item.paymentVoucherId },
              select: { id: true, voucherNumber: true, type: true, voucherCategory: true, amount: true, currency: true, status: true },
            }).catch(() => null)
          : Promise.resolve(null),
      ]);
      const actualPayments = item.payeeType === 'Customer' ? null : await readSupplierPaymentFacts(prisma, item);
      return res.json({ item: { ...item, approvalRequest, paymentVoucher, actualPayments } });
    } catch (e: any) {
      logger.error('[PaymentRequestRoute] GET /:id failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '查询付款申请详情失败' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // GET /:id/preview.html — 付款申请单 A4 预览（§10.3-9 Phase B 批次 4）
  //   服务端模板实时装配（与生成 PDF 同源排版）；审批通过后按签署人取章盖入审批人签章位。
  // P4-1 #18 续：与详情同门——finance:read 全档；未持 → applicantId === 自己；不符 404
  //   （预览含收款方+金额+签章位，单据全文，保护面与详情同级）
  // ══════════════════════════════════════════════════════════════════
  router.get('/:id/preview.html', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    try {
      // #18 行级收口：先查 applicantId → 不符则 404（防存在性泄露）
      const item = await prisma.paymentRequest.findUnique({
        where: { id: req.params.id },
        // ★ 口径 B3：必须 select 出 `reviewerId` 才能施加「被指派的审批人恒可见」豁免
      });
      if (!item || item.deletedAt) {
        return res.status(404).json({ error: 'NOT_FOUND', message: `付款申请 ${req.params.id} 不存在` });
      }
      // ★ 口径 B3：三档范围（取代原二元档）；越权 → 404（不暴露存在性）。
      //   判据走**共用内核** `canSeePaymentRequest`。
      const scope = await resolveScope(req, auth.userId);
      if (!canSeePaymentRequest(item, scope)) {
        return res.status(404).json({ error: 'NOT_FOUND', message: `付款申请 ${req.params.id} 不存在` });
      }
      if (hasPaymentRequestPayableBasis(item))
        await prisma.$transaction(tx => assertPaymentRequestPayableRead(tx, item, extractActorFromRequest(req)));
      const data = await loadPaymentRequestDocData(prisma, req.params.id);
      if (!data) return res.status(404).json({ error: 'NOT_FOUND', message: `付款申请 ${req.params.id} 不存在` });
      // 付款申请已批准（finance:payment_request 审批）→ 按审批人身份取章盖入
      const signer = await resolveDocumentSignerByDoc(prisma, { type: 'PaymentRequest', sourceRef: req.params.id });
      const html = await renderServerDocument(prisma, 'PAYREQ', data, { screen: true }, {
        id: req.params.id, type: 'PaymentRequest', sourceRef: req.params.id, signer,
      });
      if (!html) return res.status(500).json({ error: 'RENDER_FAILED', message: 'PAYREQ 模板渲染失败' });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (e: any) {
      logger.error('[PaymentRequestRoute] GET preview.html failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '预览付款申请单失败' });
      res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // POST /:id/generate-document — 登记单据中心 + 渲染 PDF 落盘归档（§10.3-9 Phase B 批次 4）
  //   幂等：domain+type+sourceRef 唯一定位；重复生成刷新头字段并覆盖 PDF（真源实时渲染）。
  // ══════════════════════════════════════════════════════════════════
  router.post('/:id/generate-document', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!requireScope(req, res, 'finance:payment_request:create')) return;
    try {
      const item = await prisma.paymentRequest.findUnique({ where: { id: req.params.id } });
      if (!item || item.deletedAt) {
        return res.status(404).json({ error: 'NOT_FOUND', message: `付款申请 ${req.params.id} 不存在` });
      }
      const scope = await resolveScope(req, auth.userId);
      if (!canSeePaymentRequest(item, scope)) {
        return res.status(404).json({ error: 'NOT_FOUND', message: `付款申请 ${req.params.id} 不存在` });
      }
      if (hasPaymentRequestPayableBasis(item))
        await prisma.$transaction(tx => assertPaymentRequestPayableRead(tx, item, extractActorFromRequest(req)));
      const reg = await upsertDomainTradeDocument(prisma, {
        domain: 'finance',
        type: 'PaymentRequest',
        sourceRef: item.id,
        documentNumber: item.requestNumber,
        relationId: item.payeeType === 'Customer' ? item.customerRelationId : item.supplierId,
        totalAmount: item.totalAmount != null ? Number(item.totalAmount) : null,
        currency: item.currency,
        issueDate: item.requestDate,
        actorId: auth.userId,
      });
      const file = await generateTradeDocumentFile(prisma, { id: reg.documentId, actorId: auth.userId });
      return res.json({ ok: true, document: reg, file });
    } catch (e: any) {
      logger.error('[PaymentRequestRoute] POST generate-document failed', { error: e?.message });
      // ⚠️ 已知反模式（未在本批修）：404 判定**靠匹配文案** `includes('不存在')`，
      //    正确做法是让 service 抛带 code 的错误（如 NOT_FOUND）。此处**保持原分支不变**，只止血。
      const notFound = Boolean(e?.message?.includes('不存在'));
      const r = safeRouteError(e, {
        fallbackCode: 'GENERATE_FAILED',
        fallbackMessage: '生成付款申请单失败',
        status: notFound ? 404 : 500,
      });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // POST /:id/record-payment — 财务登记本次实际付款（原键可重试）
  //   issue-voucher 保留兼容路由，但采用同一显式真实付款契约。
  // ══════════════════════════════════════════════════════════════════
  router.post(['/:id/record-payment', '/:id/issue-voucher'], async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    if (!requireScope(req, res, 'vouchers:write')) return;
    try {
      const result = await paymentRequestService.recordActualPayment({
        paymentRequestId: req.params.id,
        actorId: auth.userId,
        actor: extractActorFromRequest(req), input: req.body || {},
      });
      if (!result.ok) {
        return res.status(result.error.statusCode).json({ error: result.error.code, message: result.error.message });
      }
      return res.status(result.data.replayed ? 200 : 201).json(ciJson(result.data));
    } catch (e: any) {
      logger.error('[PaymentRequestRoute] POST /:id/issue-voucher failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '生成付款凭证失败' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // POST /:id/cancel — 申请人作废（仅 Draft/Pending，仅本人）
  // ══════════════════════════════════════════════════════════════════
  router.post('/:id/cancel', async (req: Request, res: Response) => {
    const auth = authenticate(req, res);
    if (!auth) return;
    try {
      const result = await paymentRequestService.cancelPaymentRequest({
        paymentRequestId: req.params.id,
        actorId: auth.userId,
      });
      if (!result.ok) {
        return res.status(result.error.statusCode).json({ error: result.error.code, message: result.error.message });
      }
      return res.json(result.data);
    } catch (e: any) {
      logger.error('[PaymentRequestRoute] POST /:id/cancel failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '作废付款申请失败' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  return router;
}
