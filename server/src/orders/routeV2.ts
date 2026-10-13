import { displayItemNo } from '../shared/orderItemNo';

import {serializeValue} from '../lib/serializeValue';
import {parseOrderQuantity} from '../shared/orderQuantitySummary';
import {guardOrderHeaderQuantity,orderQuantityDto} from '../shared/orderQuantityWriteGuard';
import { assertOrderHeaderEditable } from './orderHeaderMutationPolicy';
import { authorizeOrderLineWrite, currentOrderLineWriteActor, freshOrderLineScope } from './orderLineWriteAccess';
/**
 * routeV2.ts — Phase 1-02 订单/履约域 V2 路由
 *
 * 挂载点：/api/v2/orders
 *
 * 路由表：
 *   GET    /                  — 列表（带 scope + 筛选 + 分页）
 *   GET    /kanban            — 看板聚合（按 status 分组 count）
 *   GET    /:id               — 详情（带 scope 校验）
 *   POST   /                  — 创建（编号 + 字典 + 配置默认值）
 *   PUT    /:id               — 更新（scope + 字典校验）
 *   PATCH  /:id/status        — 状态流转（状态机校验 + 留痕）
 *   DELETE /:id               — 软删除（scope 校验）
 */
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { extractActorFromRequest } from '../auth/middleware';
import { writeRouteAuditLog, actorIdFromRequest } from '../audit/routeAudit';
import { extractPdfText } from '../import/extractText';
import { parseTechPackText } from './techPackParser';
import { createOrderServiceV2 } from './orderServiceV2';
import { createOrderMainApprovalService, OrderMainApprovalError } from './orderMainApprovalService';
import { createOrderResponsibilityService } from './orderResponsibility';
import { createCurrentWriteActor } from '../auth/currentWriteActor';
import { renderServerDocument } from '../templates/docTemplates/registry';
import { loadOrderConfirmationDocData } from '../templates/docTemplates/orderConfirmation';
import { buildXlsx, xlsxDownloadHeaders, type XlsxSheet } from '../templates/xlsxExport';
import { upsertDomainTradeDocument, generateTradeDocumentFile } from '../customs/tradeDocumentLifecycleService';
import { resolveDocumentSignerByDoc } from '../seal/documentSigner';
import { assertApprovalReviewSourceRead } from '../approvals/approvalReviewSourceAccess';
import { buildApprovalSignDocumentSnapshot } from '../approvals/approvalSignDocumentSnapshotService';
import { createApprovalCreateService } from '../approvals/approvalCreateService';
import { createApprovalRoutingService } from '../approvals/approvalRoutingService';
// ★ 未预期异常不再回显原始错误；业务错误（code+statusCode）仍透传。
//   安全前提（已核对）：同域目录 `throw new Error(` 为 0 处 ⇒ catch 只接未预期异常。
import { safeRouteError } from '../shared/routeError';
import { orderAmountOrNull } from '../shared/orderAmount';
import { orderStatusLabel, orderTypeLabel } from '../shared/orderDisplayLabels';
import { httpStatusOfCode, lookupErrorCode } from '../shared/errorCodes';
import { statusFromError } from '../shared/bizStatus';
import { localDateKey, todayLocalKey } from '../shared/localDate';


/** 上传根目录（与静态服务根同源：BAMBOOK_UPLOAD_DIR 或 apps/Bambook/uploads——
 *  index.ts 静态服务 /api/uploads 的根；本文件在 server/src/orders/ 下需三级回溯） */
const UPLOAD_DIR = process.env.BAMBOOK_UPLOAD_DIR || path.join(__dirname, '../../../uploads');

export interface OrdersV2RouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
}

export function createOrdersV2Router(opts: OrdersV2RouterOptions): Router {
  const router = Router();

  const guard = createModuleAuthGuard({ requireAuth: opts.requireAuth, apiKeys: opts.apiKeys });
  router.use(guard);

  const requireWrite = requireJwtForWrite({ requireAuth: opts.requireAuth, apiKeys: opts.apiKeys });
  const svc = createOrderServiceV2(opts.prisma);
  const mainApproval = createOrderMainApprovalService(opts.prisma);
  /** §10.3-9 电子签：订单确认书「提交签署」建审批单（复用 DR-007 审批路由解析审批人） */
  const approvalCreateService = createApprovalCreateService({
    prisma: opts.prisma,
    routingService: createApprovalRoutingService({ prisma: opts.prisma }),
  });

  function actorOf(req: Request) {
    return extractActorFromRequest(req);
  }

  const responsibility = createOrderResponsibilityService(opts.prisma);
  const currentResponsibilityJwt = createCurrentWriteActor(opts.prisma);
  const responsibilityError = (error: unknown, res: Response) => {
    const result = safeRouteError(error, {fallbackCode:'AUTHORIZATION_UNAVAILABLE',fallbackMessage:'订单责任暂时无法核对，请稍后重试。'});
    return res.status(result.status).json({ok:false,error:result.code,message:result.message});
  };
  router.get('/:id/responsibility', requirePermission('orders:read'), async(req,res)=>{
    try { return res.json({ok:true,...await responsibility.get(actorOf(req),req.params.id)}); }
    catch(error) { return responsibilityError(error,res); }
  });
  router.patch('/:id/responsibility', currentResponsibilityJwt, requirePermission('orders:write'), async(req,res)=>{
    try { return res.json({ok:true,...await responsibility.patch(actorOf(req),req.params.id,req.body)}); }
    catch(error) { return responsibilityError(error,res); }
  });

  // Main order approval is distinct from OrderConfirmation electronic signing,
  // MOQ, and credit exception approvals.
  router.post('/:id/submit-main-approval', requireWrite, requirePermission('orders:write'), async (req, res) => {
    const actor = actorOf(req);
    if (!actor?.userId) return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED', message: '需要登录后提交订单审批。' });
    try {
      const item = await mainApproval.submit(req.params.id, actor.userId, actor);
      return res.status(201).json({ ok: true, item });
    } catch (error: any) {
      if (error instanceof OrderMainApprovalError) return res.status(error.statusCode).json({ ok: false, error: error.code, message: error.message });
      const safe = safeRouteError(error, { fallbackCode: 'ORDER_APPROVAL_SUBMIT_FAILED', fallbackMessage: '订单审批提交失败。' });
      return res.status(safe.status).json({ ok: false, error: safe.code, message: safe.message });
    }
  });
  router.get('/:id/main-approvals', requirePermission('orders:read'), async (req, res) => {
    const actor = actorOf(req);
    if (!actor?.userId) return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED', message: '需要登录。' });
    const order = await svc.getOrder(actor, req.params.id);
    if (!order.ok) return res.status(order.error?.code === 'NOT_FOUND' ? 404 : 403).json({ ok: false, error: order.error?.code, message: order.error?.message });
    try { return res.json({ ok: true, items: await mainApproval.listHistory(req.params.id) }); }
    catch (error: any) { const safe = safeRouteError(error, { fallbackCode: 'ORDER_APPROVAL_HISTORY_FAILED', fallbackMessage: '订单审批历史读取失败。' }); return res.status(safe.status).json({ ok: false, error: safe.code, message: safe.message }); }
  });
  router.post('/:id/responsibility/cancellations', currentResponsibilityJwt, requirePermission('orders:write'), async(req,res)=>{
    try { return res.json({ok:true,...await responsibility.cancel(actorOf(req),req.params.id,req.body)}); }
    catch(error) { return responsibilityError(error,res); }
  });
  router.get('/:id/responsibility/receipts/:clientRequestId', currentResponsibilityJwt, requirePermission('orders:read'), async(req,res)=>{
    try { return res.json({ok:true,...await responsibility.readReceipt(actorOf(req),req.params.id,req.params.clientRequestId)}); }
    catch(error) { return responsibilityError(error,res); }
  });

  // ── GET / 列表（format=xlsx → 全量台账 Excel 导出） ──
  router.get('/', requirePermission('orders:read'), async (req, res) => {
    const actor = actorOf(req);
    const exportAll = req.query.format === 'xlsx';
    const itemExport = exportAll && req.query.ledgerView === 'items';
    const filter = {
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      type: typeof req.query.type === 'string' ? req.query.type : undefined,
      ownerId: typeof req.query.ownerId === 'string' ? req.query.ownerId : undefined,
      departmentId: typeof req.query.departmentId === 'string' ? req.query.departmentId : undefined,
      customerCode: typeof req.query.customerCode === 'string' ? req.query.customerCode : undefined,
      customerRelationId: typeof req.query.customerRelationId === 'string' ? req.query.customerRelationId : undefined,
      businessLine: typeof req.query.businessLine === 'string' ? req.query.businessLine : undefined,
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      limit: exportAll || !req.query.limit ? undefined : Number(req.query.limit),
      offset: exportAll || !req.query.offset ? undefined : Number(req.query.offset),
      sort: typeof req.query.sort === 'string' ? req.query.sort : undefined,
      ...(exportAll ? { exportAll: true } : {}),
    };
    // Item exports filter lines after the normal permission-scoped order read.
    const result = await svc.listOrders(actor, itemExport ? { ...filter, status: undefined, search: undefined } : filter);
    if (!result.ok) return res.status(500).json({ error: result.error!.code, message: result.error!.message });
    if (exportAll) {
      const items: any[] = result.data?.items ?? [];
      // 「负责人」列给人看的是人名，不是内部账号 id（B230）。取不到 ⇒ 留空，不许把 id 当名字落进文件。
      const ownerIds = [...new Set(items.map((o: any) => o.ownerId).filter((v: any): v is string => typeof v === 'string' && v.length > 0))];
      const ownerName = new Map<string, string>();
      if (ownerIds.length) {
        const users = await opts.prisma.userAccount.findMany({
          where: { id: { in: ownerIds } },
          select: { id: true, displayName: true },
        });
        for (const u of users) if (u.displayName) ownerName.set(u.id, u.displayName);
      }
      const sheet: XlsxSheet = {
        name: '订单台账',
        columnLabels: ['订单号', '客户', '品名', '类型', '状态', '数量', '单位', '金额', '币种', '出厂交期范围', '负责人'],
        columns: ['poNumber', 'customer', 'product', 'type', 'status', 'quantity', 'unit', 'orderAmount', 'currency', 'dueDate', 'owner'],
        rows: items.map((o: any) => ({
          poNumber: o.poNumber,
          customer: o.customer,
          product: o.product,
          // 类型/状态与屏面同一格同串（共享标签表是唯一出处；查不到留空，不把英文枚举落进给工厂/客户的文件）
          type: orderTypeLabel(o.type),
          status: orderStatusLabel(o.status),
          quantity: o.quantity,
          unit: o.lines?.[0]?.unit ?? null,
          orderAmount: orderAmountOrNull(o), // 表头写的是「金额」⇒ 必须给真源，不能抄报价额（E 批）
          // 币种与销售金额配对 ⇒ 走销售侧口径 `salesCurrency ?? currency`，与屏面（resolveCurrency('sales')）、
          // 驾驶舱/简报（`salesCcyOf`）**同一优先序**。旧写法 `currency || salesCurrency` 是全仓唯一的反序出口（B227）。
          currency: o.salesCurrency ?? o.currency ?? null,
          dueDate: (() => {
            const dates = (o.lines || []).map((line: any) => line.exMillDate || o.clientDate || o.dueDate || '').filter(Boolean).sort();
            return dates.length ? dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} 至 ${dates[dates.length - 1]}` : null;
          })(),
          owner: o.ownerId ? (ownerName.get(String(o.ownerId)) ?? null) : null,
        })),
      };
      if (itemExport) {
        const query = filter.search?.trim().toLowerCase() || '';
        const rows = items.flatMap((o: any) => (o.lines || []).map((line: any) => {
          const itemNo = displayItemNo(line.itemNo || String((line.lineNumber || 1) * 10));
          return { poNumber: o.poNumber || o.code || o.id, itemNo, customer: o.customer,
            code: o.code, clientCode: o.clientCode,
            materialCode: line.materialCode || o.clientCode, product: line.description || line.cloth || o.product,
            color: line.millQuality || o.productColorCode, quantity: line.quantity, unit: line.unit,
            orderAmount: line.netValue ?? (line.unitPrice != null ? Number(line.unitPrice) * Number(line.quantity) : null),
            currency: o.salesCurrency ?? o.currency ?? null,
            dueDate: line.exMillDate || o.clientDate || o.dueDate,
            rawStatus: line.status || o.status, status: orderStatusLabel(line.status || o.status),
            owner: o.ownerId ? (ownerName.get(String(o.ownerId)) ?? null) : null };
        })).filter((row: any) => (!filter.status || row.rawStatus === filter.status) && (!query ||
          [row.poNumber, row.itemNo, `PO ${row.poNumber} / ${row.itemNo}`, row.code, row.clientCode, row.customer, row.materialCode, row.product, row.color]
            .some(value => String(value ?? '').toLowerCase().includes(query))));
        sheet.name = '订单条目台账';
        sheet.columnLabels = ['PO号', '条目号', '客户', '品号', '产品', '色号', '数量', '单位', '金额', '币种', '出厂交期', '状态', '负责人'];
        sheet.columns = ['poNumber', 'itemNo', 'customer', 'materialCode', 'product', 'color', 'quantity', 'unit', 'orderAmount', 'currency', 'dueDate', 'status', 'owner'];
        sheet.rows = rows;
      }
      const today = todayLocalKey();
      return res.set(xlsxDownloadHeaders(`${itemExport ? '订单条目台账' : '订单台账'}_${today}.xlsx`)).send(buildXlsx([sheet]));
    }
    return res.json({ ok: true, ...result.data });
  });

  // ── GET /kanban 看板聚合 ──
  router.get('/kanban', requirePermission('orders:read'), async (req, res) => {
    const actor = actorOf(req);
    const filter = {
      type: typeof req.query.type === 'string' ? req.query.type : undefined,
      businessLine: typeof req.query.businessLine === 'string' ? req.query.businessLine : undefined,
    };
    const result = await svc.getKanban(actor, filter);
    if (!result.ok) return res.status(500).json({ error: result.error!.code, message: result.error!.message });
    return res.json({ ok: true, ...result.data });
  });

  // ── GET /:id 详情 ──
  router.get('/:id', requirePermission('orders:read'), async (req, res) => {
    const actor = actorOf(req);
    const result = await svc.getOrder(actor, req.params.id);
    if (!result.ok) {
      const status = result.error!.code === 'NOT_FOUND' ? 404 : 500;
      return res.status(status).json({ error: result.error!.code, message: result.error!.message });
    }
    return res.json({ ok: true, order: result.data });
  });

  // ── GET /:id/preview.html — 订单确认书服务端模板预览（B8：实时装配渲染，与生成
  //    PDF 同源排版——所见即所得，无需先登记文档） ──
  router.get('/:id/preview.html', requirePermission('orders:read'), async (req, res) => {
    try {
      const data = await loadOrderConfirmationDocData(opts.prisma, req.params.id);
      if (!data) return res.status(404).json({ error: 'NOT_FOUND', message: '订单不存在' });
      // §10.3-9：订单确认书已签署时按签署人取章（签署审批流待批次 2c 登记 → 当前恒不出章）
      const signer = await resolveDocumentSignerByDoc(opts.prisma, { type: 'OrderConfirmation', sourceRef: req.params.id });
      const html = await renderServerDocument(opts.prisma, 'OC', data, { screen: true }, {
        id: req.params.id, type: 'OrderConfirmation', sourceRef: req.params.id, signer,
      });
      if (!html) return res.status(500).json({ error: 'RENDER_FAILED', message: 'OC 模板渲染失败' });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (e: any) {
      const r = safeRouteError(e, { fallbackCode: 'OC_PREVIEW_FAILED', fallbackMessage: 'failed to preview order confirmation' });
      res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // ── POST /:id/generate-document — 登记域单据 + 服务端渲染 PDF 落盘归档（B8）
  //    幂等：domain+type+sourceRef 唯一定位；重复生成刷新头字段并覆盖 PDF（真源实时渲染） ──
  router.post('/:id/generate-document', requireWrite, requirePermission('orders:write'), async (req, res) => {
    try {
      const actor = actorOf(req);
      const order = await opts.prisma.order.findFirst({
        where: { id: req.params.id, deletedAt: null },
        // ★ 必须带 lines：登记头字段与 PDF 正文**同口径**（正文由 loadOrderConfirmationDocData
        //   实时装配、走真源 ①）。不带的话 orderAmountOrNull 落到 ②totalNet，
        //   一张 totalNet ≠ Σ明细行 的单就会在「单据中心列表的金额」与「PDF 合计」上给两个数。
        include: { lines: true },
      });
      if (!order) return res.status(404).json({ error: 'NOT_FOUND', message: '订单不存在' });

      const actorId = actor?.userId || 'system';
      const reg = await upsertDomainTradeDocument(opts.prisma, {
        domain: 'orders',
        type: 'OrderConfirmation',
        sourceRef: order.id,
        documentNumber: order.poNumber || undefined, // 文档号=客户 PO 业务单号（缺省 OC- 前缀自动取号）
        orderId: order.id,
        relationId: order.customerRelationId,
        totalAmount: orderAmountOrNull(order), // 登记头字段：真源（原抄 quoteAmount ⇒ 单据中心显示的金额与 PDF 正文可以不一致）
        currency: order.currency || order.salesCurrency,
        issueDate: order.createdAt ? localDateKey(new Date(Number(order.createdAt))) : undefined,
        actorId,
      });
      const file = await generateTradeDocumentFile(opts.prisma, { id: reg.documentId, actorId });
      return res.json({ ok: true, document: reg, file });
    } catch (e: any) {
      // ⚠️ 已知反模式（未在本批修）：404 判定**靠匹配文案** `includes('不存在')`，
      //    正确做法是让 service 抛带 code 的错误（与 paymentRequestRoute 同款）。此处**保持原分支不变**，只止血。
      const notFound = Boolean(e?.message?.includes('不存在'));
      const r = safeRouteError(e, {
        fallbackCode: 'OC_GENERATE_FAILED',
        fallbackMessage: 'failed to generate order confirmation document',
        status: notFound ? 404 : 500,
      });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // ── POST /:id/request-sign — 订单确认书「提交签署」（§10.3-9 电子签）──
  //    业务员提交 → DR-007 解析领导/老板 → 审批中心「阅览并签署」→ 阅至文末点签字确认
  //    → 一步完成盖章 + 批准；后续渲染按签署人（= 审批人本人，禁代签）取章盖入 PDF。
  router.post('/:id/request-sign', requireWrite, currentResponsibilityJwt, requirePermission('orders:write'), async (req, res) => {
    try {
      const actorId = actorIdFromRequest(req);
      await assertApprovalReviewSourceRead(opts.prisma, { actionType: 'order:confirmation_sign', targetType: 'OrderConfirmation', targetId: req.params.id, payload: {} }, actorOf(req)!);
      const source = await svc.getOrder(actorOf(req), req.params.id);
      if (!source.ok) return res.status(httpStatusOfCode(source.error?.code ?? 'INTERNAL_ERROR')).json({ error: source.error?.code, message: source.error?.message });
      const order = source.data!;
      const documentSnapshot = await buildApprovalSignDocumentSnapshot(opts.prisma, { kind: 'OrderConfirmation', orderId: req.params.id });

      const approval = await approvalCreateService.createBusinessApproval({
        requesterId: actorId,
        actionType: 'order:confirmation_sign',
        targetType: 'OrderConfirmation',
        targetId: order.id,
        risk: 'medium',
        payload: { orderId: order.id, poNumber: order.poNumber ?? null, customer: order.customer ?? null, documentSnapshot },
      });
      return res.status(201).json({ ok: true, approvalId: approval.id, status: approval.status });
    } catch (e: any) {
      const msg = String(e?.message || e);
      // 无审批人可解析（DR-007 fail-closed）→ 409 语义：需先配置组织归属，不是服务端故障
      // B129 收口（v3.12）。★ 改前这一行是**用异常文本猜档**（msg.includes('NO_REVIEWER_RESOLVED')），
      //   正是 B68 立账的病灶：文本是判据里最不可信的一档，却排在最前面。真尺的顺序是
      //   自带档位 > 已登记码 > 数据层码族 > 系统故障文案 > 业务关键词 > 兜底，
      //   所以同一枚错误在这里第一次是**按 code** 判成 409，而不是按消息里有没有那串码名。
      const status = statusFromError(e, 500);
      return res.status(status).json({ error: 'SIGN_REQUEST_FAILED', message: msg });
    }
  });

  // ── POST / 创建 ──
  router.post('/', requireWrite, requirePermission('orders:write'), async (req, res) => {
    const actor = actorOf(req);
    const result = await svc.createOrder(actor, req.body || {});
    if (!result.ok) {
      const statusMap: Record<string, number> = {
        UNAUTHORIZED: 401, FORBIDDEN: 403, VALIDATION_FAILED: 400, SEQUENCE_FAILED: 500, INTERNAL_ERROR: 500,
        CREDIT_FROZEN_60_DAYS: 403, CREDIT_REVOKED: 403, OVERDUE_60_DAYS: 403, CREDIT_CHECK_FAILED: 500,
      };
      return res.status(statusMap[result.error!.code] ?? httpStatusOfCode(result.error!.code)).json({
        error: result.error!.code,
        message: result.error!.message,
        // DE-6 统一透传：门禁已自动发起审批单时回传 id（信用例外/豁免审批），供前端跳转审批中心
        ...(result.error!.approvalRequestId ? { approvalRequestId: result.error!.approvalRequestId } : {}),
      });
    }
    return res.json({ ok: true, order: result.data });
  });

  // ── PUT /:id 更新 ──
  router.put('/:id', requireWrite, requirePermission('orders:write'), async (req, res) => {
    const actor = actorOf(req);
    const result = await svc.updateOrder(actor, req.params.id, req.body || {});
    if (!result.ok) {
      const statusMap: Record<string, number> = {
        UNAUTHORIZED: 401, FORBIDDEN: 403, VALIDATION_FAILED: 400, NOT_FOUND: 404, INTERNAL_ERROR: 500, CONFLICT: 409,
      };
      return res.status(statusMap[result.error!.code] ?? httpStatusOfCode(result.error!.code)).json({ error: result.error!.code, message: result.error!.message });
    }
    return res.json({ ok: true, order: result.data });
  });

  // ── PATCH /:id/status 状态流转 ──
  router.patch('/:id/status', requireWrite, requirePermission('orders:write'), async (req, res) => {
    const actor = actorOf(req);
    const newStatus = typeof req.body?.status === 'string' ? req.body.status.trim() : '';
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : undefined;
    if (!newStatus) return res.status(400).json({ error: 'VALIDATION_FAILED', message: 'body.status 必填' });
    const result = await svc.transitionStatus(actor, req.params.id, newStatus, reason);
    if (!result.ok) {
      // W-A 走查 DE-6 修复：MOQ_VIOLATION 此前缺映射回落 500 且丢 approvalRequestId，
      // 前端无法跳转豁免审批单；信用门禁码族（403）一并补齐
      const statusMap: Record<string, number> = {
        UNAUTHORIZED: 401, FORBIDDEN: 403, VALIDATION_FAILED: 400, NOT_FOUND: 404, INVALID_TRANSITION: 409, INTERNAL_ERROR: 500,
        MOQ_VIOLATION: 409,
        CREDIT_FROZEN_60_DAYS: 403, CREDIT_REVOKED: 403, OVERDUE_60_DAYS: 403, CREDIT_CHECK_FAILED: 500,
      };
      // ★ 表里没有的码去查注册表真源，而不是直接兜 500。本表是 §9 B32 冻结的本地映射（只减不增），
      //   新码的加法是登记进 shared/errorCodes —— G-4 的 LC_GATE_BLOCKED / LC_EXCEPTION_CHECK_FAILED 即如此。
      //   上面 DE-6 那条注释记的就是"漏加码 ⇒ 兜 500"这个坑（本批复核实测：不补这一步，
      //   V2 上 LC 阻断会变成 INTERNAL_ERROR + 500，与 V1 的 403 各说各话）。
      const status = statusMap[result.error!.code] ?? lookupErrorCode(result.error!.code)?.status ?? 500;
      return res.status(status).json({
        error: result.error!.code,
        message: result.error!.message,
        ...(result.error!.approvalRequestId ? { approvalRequestId: result.error!.approvalRequestId } : {}),
      });
    }
    return res.json({ ok: true, order: result.data });
  });

  // ── POST /:id/settle 订单结案（绿）——业务员手动确认结清（G3-4，复用现有核销，UI 侧进度满才可点） ──
  router.post('/:id/settle', requireWrite, requirePermission('orders:write'), async (req, res) => {
    const actor = actorOf(req);
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : undefined;
    const result = await svc.settleOrder(actor, req.params.id, note);
    if (!result.ok) {
      const statusMap: Record<string, number> = { UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, ALREADY_SETTLED: 409, INTERNAL_ERROR: 500 };
      return res.status(statusMap[result.error!.code] || 500).json({ error: result.error!.code, message: result.error!.message });
    }
    return res.json({ ok: true, order: result.data });
  });

  // ── DELETE /:id 软删除 ──
  router.delete('/:id', requireWrite, requirePermission('orders:delete'), async (req, res) => {
    const actor = actorOf(req);
    const result = await svc.deleteOrder(actor, req.params.id);
    if (!result.ok) {
      const statusMap: Record<string, number> = {
        UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, HAS_DEPENDENTS: 409,
        // B14：依赖校验没结论 ⇒ 拒删（503 可重试）。少了这行就兜成 500（本仓第 4 次同一坑）。
        DEPENDENCY_CHECK_FAILED: 503, INTERNAL_ERROR: 500,
      };
      return res.status(statusMap[result.error!.code] || 500).json({ error: result.error!.code, message: result.error!.message });
    }
    return res.json({ ok: true, order: result.data });
  });

  // ══════════════════════════════════════════════════════════════════
  // REQ2-18 Tech Pack 结构化解析（DR-059）：上传 PDF（或粘贴文本）→ 规则解析
  // → 预览确认 → 显式勾选回填订单字段。守卫 orders:write。
  // ══════════════════════════════════════════════════════════════════
  const techPackDir = path.join(UPLOAD_DIR, 'techpacks');
  const techPackUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        const orderDir = path.join(techPackDir, String(_req.params.id ?? 'unassigned'));
        fs.mkdirSync(orderDir, { recursive: true });
        cb(null, orderDir);
      },
      filename: (_req, file, cb) => {
        const rand = Math.random().toString(36).slice(2, 8);
        cb(null, `${Date.now()}-${rand}${path.extname(file.originalname) || '.pdf'}`);
      },
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const isPdf = file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname);
      if (!isPdf) return cb(new Error('UNSUPPORTED_FILE_TYPE'));
      cb(null, true);
    },
  });

  async function parseTechPackForOrder(orderId: string, source: { file?: Express.Multer.File; text?: string }) {
    let text: string;
    let pages = 1;
    let fileName: string | null = null;
    if (source.file) {
      const extracted = await extractPdfText(source.file.buffer ?? await fs.promises.readFile(source.file.path));
      text = extracted.text;
      pages = extracted.pages;
      // multipart 通道：先落盘（destination 已按 orderId 分目录），fileName 供保存时登记
      fileName = source.file.filename;
    } else if (typeof source.text === 'string' && source.text.trim()) {
      text = source.text;
    } else {
      return { status: 400, body: { error: 'VALIDATION_FAILED', message: 'multipart file 或 text 二选一必填' } };
    }
    const parsed = parseTechPackText(text);
    if (!parsed.ok) {
      return { status: 422, body: { error: parsed.error!.code, message: parsed.error!.message } };
    }
    return {
      status: 200,
      body: { ok: true, parsed: { ...parsed.snapshot, pages }, fileName, sourceType: source.file ? 'pdf' : 'text' },
    };
  }

  // ── POST /:id/techpack/parse（multipart PDF 或 JSON { text }：解析预览，不落库不回填） ──
  router.post('/:id/techpack/parse', requireWrite, requirePermission('orders:write'), (req, res) => {
    const contentType = String(req.headers['content-type'] ?? '');
    const isMultipart = contentType.includes('multipart/form-data');
    const handler = async () => {
      const actor = await currentOrderLineWriteActor(opts.prisma,actorOf(req),'update');
      const scope = await freshOrderLineScope(opts.prisma,actor);
      const order = await (opts.prisma as any).order.findFirst({ where: { id: req.params.id, deletedAt: null, AND:[scope] } });
      if (!order) return res.status(404).json({ error: 'NOT_FOUND', message: `订单 ${req.params.id} 不存在` });

      let result: { status: number; body: any };
      if (isMultipart) {
        result = await new Promise(resolve => {
          techPackUpload.single('file')(req, res, async (err: any) => {
            if (err) {
              const code = err.message === 'UNSUPPORTED_FILE_TYPE' ? 'UNSUPPORTED_FILE_TYPE' : 'UPLOAD_FAILED';
              return resolve({ status: 400, body: { error: code, message: err.message } });
            }
            const r = await parseTechPackForOrder(req.params.id, { file: req.file as Express.Multer.File });
            if (r.status !== 200 && req.file?.path) { try { fs.unlinkSync(req.file.path); } catch { /* 孤儿清理尽力 */ } }
            resolve(r as any);
          });
        });
      } else {
        result = await parseTechPackForOrder(req.params.id, { text: req.body?.text });
      }
      return res.status(result.status).json(result.body);
    };
    handler().catch((e: any) => { const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '解析失败' }); res.status(r.status).json({ error: r.code, message: r.message }); });
  });

  // ── POST /:id/techpack（保存快照 + 显式 apply 回填） ──
  router.post('/:id/techpack', requireWrite, requirePermission('orders:write'), async (req, res) => {
    try {
      const parsed = req.body?.parsed;
      if (!parsed || typeof parsed !== 'object') {
        return res.status(400).json({ error: 'VALIDATION_FAILED', message: 'parsed（解析快照）必填' });
      }
      const fileName = typeof req.body?.fileName === 'string' ? req.body.fileName : null;
      const apply = req.body?.apply && typeof req.body.apply === 'object' ? req.body.apply : {};

      const data: Record<string, unknown> = {
        techPack: { ...parsed, uploadedAt: Date.now() },
        techPackFileName: fileName,
      };
      const applied: string[] = [];
      if (apply.product && typeof apply.product === 'string' && apply.product.trim()) { data.product = apply.product.trim(); applied.push('product'); }
      if (apply.quantity != null) { data.quantity = parseOrderQuantity(apply.quantity); applied.push('quantity'); }
      if(apply.unit!==undefined){data.unit=apply.unit;applied.push('unit');}
      if (apply.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(String(apply.dueDate))) { data.dueDate = String(apply.dueDate); applied.push('dueDate'); }
      if (apply.fabricContent && typeof apply.fabricContent === 'string' && apply.fabricContent.trim()) { data.fabricContent = apply.fabricContent.trim(); applied.push('fabricContent'); }
      if (apply.productColorCode && typeof apply.productColorCode === 'string' && apply.productColorCode.trim()) { data.productColorCode = apply.productColorCode.trim(); applied.push('productColorCode'); }

      const updated = await opts.prisma.$transaction(async tx=>{
      const authorized = await authorizeOrderLineWrite(tx, req.params.id, actorOf(req), 'update');
      const fresh = authorized.order;
      assertOrderHeaderEditable(fresh as unknown as Record<string, unknown>, data);
      await guardOrderHeaderQuantity(tx,fresh,data,req.body?.expectedUpdatedAt);
      const saved=await tx.order.update({where:{id:req.params.id},data,include:{lines:true}});
      await writeRouteAuditLog({
        prisma: tx,
        actorId: authorized.actor.userId,
        source: 'orders-techpack',
        operation: 'techpack_save',
        targetType: 'Order',
        targetId: req.params.id,
        before: { techPack: fresh.techPack ?? null, quantity: fresh.quantity, dueDate: fresh.dueDate, product: fresh.product },
        after: { fileName, applied, totalQty: parsed.totalQty ?? null },
        ip: req.ip ?? null,
        operationType: 'update',
      });
      return saved;});
      return res.json({ ok: true, order: serializeValue(orderQuantityDto(updated)), applied });
    } catch (e: any) {
      const r = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '保存失败' });
      return res.status(r.status).json({ error: r.code, message: r.message });
    }
  });

  // ── GET /:id/techpack（现快照） ──
  router.get('/:id/techpack', requirePermission('orders:read'), async (req, res) => {
    const result = await svc.getOrder(actorOf(req),req.params.id);
    if (!result.ok) return res.status(httpStatusOfCode(result.error!.code)).json({error:result.error!.code,message:result.error!.message});
    const order = result.data;
    return res.json({ ok: true, techPack: order.techPack ?? null, techPackFileName: order.techPackFileName ?? null });
  });

  // ── GET /:id/techpack/file（附件下载） ──
  router.get('/:id/techpack/file', requirePermission('orders:read'), async (req, res) => {
    const result = await svc.getOrder(actorOf(req),req.params.id);
    if (!result.ok) return res.status(httpStatusOfCode(result.error!.code)).json({error:result.error!.code,message:result.error!.message});
    const order = result.data;
    if (!order || !order.techPackFileName) {
      return res.status(404).json({ error: 'NOT_FOUND', message: '该订单无 Tech Pack 附件' });
    }
    const abs = path.join(techPackDir, String(req.params.id), path.basename(order.techPackFileName));
    if (!fs.existsSync(abs)) {
      return res.status(404).json({ error: 'NOT_FOUND', message: '附件文件缺失（可能已被清理）' });
    }
    return res.download(abs, order.techPackFileName.endsWith('.pdf') ? order.techPackFileName : `${order.techPackFileName}.pdf`);
  });

  return router;
}
