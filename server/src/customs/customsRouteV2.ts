import { readMergedPackingListSelection, saveMergedPackingListDraft, readOwnMergedPackingListCommand } from './mergedPackingListCommand';
import { readPackingListDraftSource, readOwnPackingListCommand, appendPackingListDraftVersion, readPackingListDocument, readPackingListVersion, isPackingListCandidateInTx, packingListHttpFailure, isPackingListFailure } from './shipmentPackingListCommand';
/**
 * customsRouteV2.ts — 报关/外贸 V2 路由（权限守卫）
 *
 * 挂载点：/api/v2/customs
 * 业务逻辑复用现有 customsService，叠加 requirePermission 守卫
 *
 * G6 新旧接口收敛（2026-08-28）：四大域（报关单/HS 编码/信用证/出口退税）端点与 v1 全量对齐
 *   （同路径、同查询参数、同 { item } 响应形状），前端已统一切换至本路由；v1 对应端点加 deprecated 逐步废弃。
 *   /documents 系列为 V2 早期只读/创建端点，保持原形状不变。
 */
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { extractActorFromRequest } from '../auth/middleware';
import { logger } from '../lib/logger';
import { readHistoricalCiDocument } from './ciInvoiceSource';
import { listCiVisibleTradeDocuments } from './ciDocumentCollection';
import { checkTripleConsistency } from './tripleDocumentConsistency';
import { describeTaxRefundGaps, recalcTaxRefund } from './taxRefundCalcService';
import { checkIncotermConsistency } from './incotermConsistency';
import { statusFromError } from '../shared/bizStatus';
import { safeRouteError } from '../shared/routeError';
import { resolveVisibleOrderIds, resolveVisibleShipmentIds } from '../auth/orderVisibility';
import { businessError, lookupErrorCode } from '../shared/errorCodes';
import { EXTERNAL_DECLARATION_REQUIRED } from './externalDeclarationContract';
import {
  createCustomsService,
  CustomsDeclarationInput,
  HsCodeInput,
  LetterOfCreditInput,
  TaxRefundInput,
  TaxRefundReviewInput,
  CustomsDeclarationStatus,
  LetterOfCreditStatus,
  TaxRefundStatus,
} from './customsService';

export interface CustomsV2RouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
}

const VALID_DECLARATION_STATUSES: CustomsDeclarationStatus[] = ['Draft', 'Submitted', 'Declared', 'Inspecting', 'Released', 'Exception', 'Cancelled'];
const VALID_LC_STATUSES: LetterOfCreditStatus[] = ['Issued', 'Presented', 'Accepted', 'Discrepant', 'Settled', 'Expired', 'Cancelled'];
const VALID_TAX_REFUND_STATUSES: TaxRefundStatus[] = ['Draft', 'Submitted', 'Reviewing', 'Approved', 'Rejected', 'Refunded', 'Cancelled'];

export function createCustomsV2Router(opts: CustomsV2RouterOptions): Router {
  const router = Router();
  router.use(createModuleAuthGuard({ requireAuth: opts.requireAuth, apiKeys: opts.apiKeys }));
  const requireWrite = requireJwtForWrite({ requireAuth: opts.requireAuth, apiKeys: opts.apiKeys });
  const svc = createCustomsService(opts.prisma);

  const actorId = (req: Request) => extractActorFromRequest(req)?.userId || 'system';
  const ciActor = (req: Request, write = false) => {
    if (write && (req as any).authSource !== 'user-session') throw businessError('UNAUTHORIZED', '商业发票写操作需要用户登录。');
    return (req as any).actor ?? extractActorFromRequest(req);
  };
  const plRequests = new WeakSet<Request>();
  const plFailure = (res: Response, error: unknown) => { const safe = packingListHttpFailure(error); return res.status(safe.status).json({ error: safe.code, message: safe.message }); };
  const markPL = async (req: Request, doc: any) => { const yes = await isPackingListCandidateInTx(opts.prisma, doc); if (yes) plRequests.add(req); return yes; };
  const historyCi = async (req: Request, item: any) => {
    if (item?.type === 'CommercialInvoice') await readHistoricalCiDocument(opts.prisma, item.id, { trustedActor: ciActor(req) });
  };


  function serialize(row: any): any {
    if (!row) return null;
    const out: any = Array.isArray(row) ? [...row] : { ...row };
    for (const k of Object.keys(out)) {
      if (typeof out[k] === 'bigint') out[k] = Number(out[k]);
      if (out[k] && typeof out[k] === 'object' && out[k]._isBigNumber) out[k] = Number(out[k].toString());
    }
    return out;
  }

  // ════ CustomsDeclaration（报关单，与 v1 同路径/同形状） ════
  router.get('/declarations', requirePermission('customs:read'), async (req, res) => {
    try {
      const visibleOrderIds = await resolveVisibleOrderIds(opts.prisma, (req as any).actor ?? extractActorFromRequest(req) ?? null, { fresh: true, strict: true });
      const result = await svc.listDeclarations({
        visibleOrderIds,
        visibleShipmentIds: visibleOrderIds ? await resolveVisibleShipmentIds(opts.prisma, visibleOrderIds, { strict: true }) : undefined,
        type: req.query.type as string | undefined,
        status: req.query.status as string | undefined,
        shipmentId: req.query.shipmentId as string | undefined,
        orderId: req.query.orderId as string | undefined,
        relationId: req.query.relationId as string | undefined,
        search: req.query.search as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      res.json({ items: (result.items || []).map(serialize), total: result.total });
    } catch (e: any) {
      logger.error('[CustomsRouteV2] GET declarations failed', { error: e?.message });
      const result = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR' });
      res.status(result.status).json({ error: result.message });
    }
  });

  router.get('/declarations/:id', requirePermission('customs:read'), async (req, res) => {
    try {
      const item = await svc.getDeclaration(req.params.id);
      const visibleOrderIds = await resolveVisibleOrderIds(opts.prisma, (req as any).actor ?? extractActorFromRequest(req) ?? null, { fresh: true, strict: true });
      if (visibleOrderIds) {
        const visibleShipments = await resolveVisibleShipmentIds(opts.prisma, visibleOrderIds, { strict: true });
        if (!(item.orderId && visibleOrderIds.includes(item.orderId)) && !(item.shipmentId && visibleShipments.includes(item.shipmentId))) {
          throw businessError('DECLARATION_NOT_FOUND', lookupErrorCode('DECLARATION_NOT_FOUND')!.message);
        }
      }
      res.json({ item: serialize(item) });
    } catch (e: any) {
      logger.error('[CustomsRouteV2] GET declaration failed', { error: e?.message });
      const result = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR' });
      res.status(result.status).json({ error: result.message });
    }
  });

  router.post('/declarations', requireWrite, requirePermission('customs:write'), async (req, res) => {
    return res.status(410).json(EXTERNAL_DECLARATION_REQUIRED);
  });

  router.put('/declarations/:id', requireWrite, requirePermission('customs:write'), async (req, res) => {
    return res.status(410).json(EXTERNAL_DECLARATION_REQUIRED);
  });

  router.delete('/declarations/:id', requireWrite, requirePermission('customs:write'), async (req, res) => {
    return res.status(410).json(EXTERNAL_DECLARATION_REQUIRED);
  });

  router.post('/declarations/:id/transition', requireWrite, requirePermission('customs:write'), async (req, res) => {
    return res.status(410).json(EXTERNAL_DECLARATION_REQUIRED);
  });

  // ════ HsCode（HS 编码库，与 v1 同路径/同形状） ════
  router.get('/hs-codes', requirePermission('customs:read'), async (req, res) => {
    try {
      const result = await svc.listHsCodes({
        category: req.query.category as string | undefined,
        search: req.query.search as string | undefined,
        isActive: req.query.isActive === 'true' ? true : req.query.isActive === 'false' ? false : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      res.json({ items: (result.items || []).map(serialize), total: result.total });
    } catch (e: any) {
      logger.error('[CustomsRouteV2] GET hs-codes failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to list hs-codes' });
    }
  });

  router.get('/hs-codes/:code', requirePermission('customs:read'), async (req, res) => {
    try {
      const item = await svc.getHsCodeByCode(req.params.code);
      res.json({ item: serialize(item) });
    } catch (e: any) {
      logger.error('[CustomsRouteV2] GET hs-code failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to get hs-code' });
    }
  });

  router.post('/hs-codes', requireWrite, requirePermission('customs:write'), async (req, res) => {
    try {
      const input = req.body as HsCodeInput;
      if (!input.code || !input.description || !input.category) {
        return res.status(400).json({ error: 'code, description and category are required' });
      }
      const item = await svc.createHsCode(input, actorId(req));
      res.status(201).json({ item: serialize(item) });
    } catch (e: any) {
      logger.error('[CustomsRouteV2] POST hs-code failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to create hs-code' });
    }
  });

  router.put('/hs-codes/:id', requireWrite, requirePermission('customs:write'), async (req, res) => {
    try {
      const item = await svc.updateHsCode(req.params.id, req.body as Partial<HsCodeInput>, actorId(req));
      res.json({ item: serialize(item) });
    } catch (e: any) {
      logger.error('[CustomsRouteV2] PUT hs-code failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to update hs-code' });
    }
  });

  router.delete('/hs-codes/:id', requireWrite, requirePermission('customs:write'), async (req, res) => {
    try {
      const result = await svc.deleteHsCode(req.params.id, actorId(req));
      res.json(result);
    } catch (e: any) {
      logger.error('[CustomsRouteV2] DELETE hs-code failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to delete hs-code' });
    }
  });

  // ════ LetterOfCredit（信用证，与 v1 同路径/同形状） ════
  router.get('/letters-of-credit', requirePermission('customs:read'), async (req, res) => {
    try {
      const result = await svc.listLettersOfCredit({
        status: req.query.status as string | undefined,
        relationId: req.query.relationId as string | undefined,
        orderId: req.query.orderId as string | undefined,
        search: req.query.search as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      res.json({ items: (result.items || []).map(serialize), total: result.total });
    } catch (e: any) {
      logger.error('[CustomsRouteV2] GET letters-of-credit failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to list letters-of-credit' });
    }
  });

  router.get('/letters-of-credit/:id', requirePermission('customs:read'), async (req, res) => {
    try {
      const item = await svc.getLetterOfCredit(req.params.id);
      res.json({ item: serialize(item) });
    } catch (e: any) {
      logger.error('[CustomsRouteV2] GET letter-of-credit failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to get letter-of-credit' });
    }
  });

  router.post('/letters-of-credit', requireWrite, requirePermission('customs:write'), async (req, res) => {
    try {
      const input = req.body as LetterOfCreditInput;
      if (!input.lcNumber || !input.type || input.amount == null) {
        return res.status(400).json({ error: 'lcNumber, type and amount are required' });
      }
      const item = await svc.createLetterOfCredit(input, actorId(req));
      res.status(201).json({ item: serialize(item) });
    } catch (e: any) {
      logger.error('[CustomsRouteV2] POST letter-of-credit failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to create letter-of-credit' });
    }
  });

  router.put('/letters-of-credit/:id', requireWrite, requirePermission('customs:write'), async (req, res) => {
    try {
      const item = await svc.updateLetterOfCredit(req.params.id, req.body as Partial<LetterOfCreditInput>, actorId(req));
      res.json({ item: serialize(item) });
    } catch (e: any) {
      logger.error('[CustomsRouteV2] PUT letter-of-credit failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to update letter-of-credit' });
    }
  });

  router.delete('/letters-of-credit/:id', requireWrite, requirePermission('customs:write'), async (req, res) => {
    try {
      const result = await svc.deleteLetterOfCredit(req.params.id, actorId(req));
      res.json(result);
    } catch (e: any) {
      logger.error('[CustomsRouteV2] DELETE letter-of-credit failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to delete letter-of-credit' });
    }
  });

  router.post('/letters-of-credit/:id/transition', requireWrite, requirePermission('customs:write'), async (req, res) => {
    try {
      const { toStatus, discrepancies } = req.body as { toStatus: LetterOfCreditStatus; discrepancies?: string };
      if (!toStatus || !VALID_LC_STATUSES.includes(toStatus)) {
        return res.status(400).json({ error: `非法信用证状态: ${toStatus}` });
      }
      const item = await svc.transitionLcStatus(req.params.id, toStatus, actorId(req), discrepancies);
      res.json({ item: serialize(item) });
    } catch (e: any) {
      logger.error('[CustomsRouteV2] POST letter-of-credit transition failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to transition letter-of-credit' });
    }
  });

  // F1：信用证节点时间轴（LcEvent 全量升序）
  router.get('/letters-of-credit/:id/events', requirePermission('customs:read'), async (req, res) => {
    try {
      const result = await svc.listLcEvents(req.params.id);
      res.json({ items: (result.items || []).map(serialize), total: result.total });
    } catch (e: any) {
      logger.error('[CustomsRouteV2] GET letter-of-credit events failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to list lc events' });
    }
  });

  // ════ TaxRefund（出口退税，与 v1 同路径/同形状） ════
  router.get('/tax-refunds', requirePermission('customs:read'), async (req, res) => {
    try {
      const result = await svc.listTaxRefunds({
        status: req.query.status as string | undefined,
        declarationId: req.query.declarationId as string | undefined,
        orderId: req.query.orderId as string | undefined,
        relationId: req.query.relationId as string | undefined,
        search: req.query.search as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      res.json({ items: (result.items || []).map(serialize), total: result.total });
    } catch (e: any) {
      logger.error('[CustomsRouteV2] GET tax-refunds failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to list tax-refunds' });
    }
  });

  router.get('/tax-refunds/:id', requirePermission('customs:read'), async (req, res) => {
    try {
      const item = await svc.getTaxRefund(req.params.id);
      res.json({ item: serialize(item) });
    } catch (e: any) {
      logger.error('[CustomsRouteV2] GET tax-refund failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to get tax-refund' });
    }
  });

  router.post('/tax-refunds', requireWrite, requirePermission('customs:write'), async (req, res) => {
    try {
      const input = req.body as TaxRefundInput;
      if (!input.refundNumber) {
        return res.status(400).json({ error: 'refundNumber is required' });
      }
      const item = await svc.createTaxRefund(input, actorId(req));
      res.status(201).json({ item: serialize(item) });
    } catch (e: any) {
      logger.error('[CustomsRouteV2] POST tax-refund failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to create tax-refund' });
    }
  });

  // G4：从报关单自动核算生成退税草稿（L10 同一入口，手动触发）
  router.post('/tax-refunds/from-declaration/:declarationId', requireWrite, requirePermission('customs:write'), async (req, res) => {
    try {
      const item = await svc.createTaxRefundFromDeclaration(req.params.declarationId, actorId(req));
      res.status(201).json({ item: serialize(item) });
    } catch (e: any) {
      logger.error('[CustomsRouteV2] POST tax-refund from-declaration failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to create tax-refund from declaration' });
    }
  });

  router.put('/tax-refunds/:id', requireWrite, requirePermission('customs:write'), async (req, res) => {
    try {
      const item = await svc.updateTaxRefund(req.params.id, req.body as Partial<TaxRefundInput>, actorId(req));
      res.json({ item: serialize(item) });
    } catch (e: any) {
      logger.error('[CustomsRouteV2] PUT tax-refund failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to update tax-refund' });
    }
  });

  router.delete('/tax-refunds/:id', requireWrite, requirePermission('customs:write'), async (req, res) => {
    try {
      const result = await svc.deleteTaxRefund(req.params.id, actorId(req));
      res.json(result);
    } catch (e: any) {
      logger.error('[CustomsRouteV2] DELETE tax-refund failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to delete tax-refund' });
    }
  });

  router.post('/tax-refunds/:id/transition', requireWrite, requirePermission('customs:write'), async (req, res) => {
    try {
      const { toStatus } = req.body as { toStatus: TaxRefundStatus };
      if (!toStatus || !VALID_TAX_REFUND_STATUSES.includes(toStatus)) {
        return res.status(400).json({ error: `非法退税状态: ${toStatus}` });
      }
      const item = await svc.transitionTaxRefundStatus(req.params.id, toStatus, actorId(req));
      res.json({ item: serialize(item) });
    } catch (e: any) {
      logger.error('[CustomsRouteV2] POST tax-refund transition failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to transition tax-refund' });
    }
  });

  // G3：审核人取真实登录人（actorId 来自认证身份），body 无需/不应再传 reviewedBy
  router.post('/tax-refunds/:id/review', requireWrite, requirePermission('customs:write'), async (req, res) => {
    try {
      const input = req.body as TaxRefundReviewInput;
      if (!input.decision || !['Approved', 'Rejected'].includes(input.decision)) {
        return res.status(400).json({ error: 'decision must be Approved or Rejected' });
      }
      const item = await svc.reviewTaxRefund(req.params.id, input, actorId(req));
      res.json({ item: serialize(item) });
    } catch (e: any) {
      logger.error('[CustomsRouteV2] POST tax-refund review failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to review tax-refund' });
    }
  });

  // ════ TradeDocument（V2 早期端点，保持原形状；单据中心仍走 v1 trade-documents） ════
  router.get('/documents', requirePermission('customs:read'), async (req, res) => {
    try {
      const result = await listCiVisibleTradeDocuments(opts.prisma, {
        orderId: typeof req.query.orderId === 'string' ? req.query.orderId : undefined,
        type: typeof req.query.docType === 'string' ? req.query.docType : undefined,
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        limit: req.query.limit ? Number(req.query.limit) : 50,
        offset: req.query.offset ? Number(req.query.offset) : 0,
      }, ciActor(req));
      res.json({ ok: true, items: (result.items || []).map(serialize), total: result.total });
    } catch (e: any) {
      return plFailure(res, e);
    }
  });

  router.post('/documents/merged-packing-list-source', requirePermission('customs:read'), async (req, res) => {
    try { res.json(await readMergedPackingListSelection(opts.prisma, req.body?.sourceIds, ciActor(req))); } catch (error) { return plFailure(res, error); }
  });
  router.post('/documents/merged-packing-lists', requireWrite, requirePermission('customs:write'), async (req, res) => {
    try { res.status(201).json(await saveMergedPackingListDraft(opts.prisma, { trustedActor: ciActor(req, true), input: req.body })); } catch (error) { return plFailure(res, error); }
  });
  router.get('/documents/merged-packing-list-commands/:requestKey', requirePermission('customs:read'), async (req, res) => {
    try { res.json(await readOwnMergedPackingListCommand(opts.prisma, { requestKey: req.params.requestKey, trustedActor: ciActor(req) })); } catch (error) { return plFailure(res, error); }
  });
  router.get('/documents/:id/packing-list-commands/:requestKey', requirePermission('customs:read'), async (req, res) => {
    try { res.json(await readOwnPackingListCommand(opts.prisma, { documentId: req.params.id, requestKey: req.params.requestKey, trustedActor: ciActor(req) })); }
    catch (error) { return plFailure(res, error); }
  });
  router.get('/documents/:id/packing-list-source', requirePermission('customs:read'), async (req, res) => {
    try { res.json(await readPackingListDraftSource(opts.prisma, req.params.id, ciActor(req))); } catch (error) { return plFailure(res, error); }
  });
  router.post('/documents/:id/packing-list-versions', requireWrite, requirePermission('customs:write'), async (req, res) => {
    try { res.status(201).json(await appendPackingListDraftVersion(opts.prisma, { documentId: req.params.id, trustedActor: ciActor(req, true), input: req.body })); } catch (error) { return plFailure(res, error); }
  });
  router.get('/documents/:id/packing-list-versions/:version', requirePermission('customs:read'), async (req, res) => {
    try { if (!/^[1-9]\d*$/.test(req.params.version) || !Number.isSafeInteger(Number(req.params.version))) throw businessError('VALIDATION_FAILED', '非法版本号。');
      const selected = await readPackingListVersion(opts.prisma, { documentId: req.params.id, version: Number(req.params.version), trustedActor: ciActor(req) });
      res.json({ item: selected.item, protocol: selected.protocol, provenance: selected.provenance, envelope: selected.envelope, receipt: selected.receipt, warnings: selected.warnings });
    } catch (error) { return plFailure(res, error); }
  });
  router.get('/documents/:id', requirePermission('customs:read'), async (req, res) => {
    try {
      const item = await svc.getTradeDocument(req.params.id);
      if (await markPL(req, item)) { const selected = await readPackingListDocument(opts.prisma, item.id, ciActor(req)); return res.json({ ok: true, document: serialize({ ...selected.document, totalAmount: null, currency: null }), protocol: selected.protocol, provenance: selected.provenance, warnings: selected.warnings }); }
      await historyCi(req, item);
      res.json({ ok: true, document: serialize(item) });
      // ★ B124 ② 已修（v3.06）：原先把**一切**异常答成 404 + 原文 ⇒ 数据层故障被说成「你要找的东西不存在」，
      //   连档位都是假的。现走真尺 `statusFromError`，兜底 **500**（不是 404：查不到东西才是 404，
      //   认不出来的故障不该伪装成"不存在"）。本站可达的错误集已逐条核过（`getTradeDocument` 全文只有 1 条裸抛）：
      //   ① `贸易单据 X 不存在`（裸抛、无 code）⇒ 关键词档 **404**（与改前一致）；
      //   ② prisma/连接层故障 ⇒ SYSTEM_FAILURE 档 **500**（★ 改前是假的 404，这就是本条要修的）；
      //   ③ 认不出来的其它异常 ⇒ 兜底 **500**（改前也是假的 404）。
      //      （`serialize` 对普通行不会抛 ⇒ ③ 实际由"未来新增的异常"占位，v3.06 复核 B-7 指出我原先
      //       把它写成一条可达类别是不准确的，故这里只保留"其它异常"这一兜底说法。）
      //   ⚠️ 文案这一半仍欠着（B42/B22 账上仍在）：`message: e?.message` 是裸文本上屏，
      //      收它需要 B123（让注册表文案可达）先落地，本批按"只修档位"的范围没动。
      //   ★ `error` 字段跟着档位走：只改状态码会留下「500 + error:NOT_FOUND」这种自相矛盾的应答，
      //     而前端按 `error` 串分支的调用方仍会以为"不存在"。404 那一档**逐字与改前相同**（状态、码、原文都不动）。
      //   ⚠️ 一条**新增的可见后果**（v3.06 复核抓到，别当成"只是修 bug"）：`req.params.id` 没有入口长度校验
      //     ⇒ 超长 id 会被 Prisma 判 `P2000`，其 `code` 命中数据层档 ⇒ 本站现在答 **500**（改前答 404）。
      //     两档都不对（客户端传错应当 400）⇒ 正解是补入口校验，已另立 **B126**，不在本批顺手改。
    } catch (e: any) {
      if (plRequests.has(req)) return plFailure(res, e);
      const status = statusFromError(e, 500);
      if (status >= 500) {
        logger.error('[CustomsRouteV2] GET /documents/:id 失败（已按真尺判档）', {
          error: e?.message ?? String(e), id: String(req.params.id), status,
        });
      }
      res.status(status).json({ error: status === 404 ? 'NOT_FOUND' : status === 403 ? 'FORBIDDEN' : status === 401 ? 'UNAUTHORIZED' : 'INTERNAL_ERROR', message: e?.message });
    }
  });

  router.post('/documents', requireWrite, requirePermission('customs:write'), async (req, res) => {
    try {
      let item;
      if (req.body?.type === 'CommercialInvoice') {
        const body = req.body, fingerprint = body.expectedSourceFingerprint ?? body.expectedFingerprint;
        if (Object.keys(body).some(key => !['type', 'shipmentId', 'sourceInvoiceId', 'expectedFingerprint', 'expectedSourceFingerprint', 'expectedShipmentSourceFingerprint'].includes(key))) throw businessError('CONFLICT', '商业发票只能引用原财务发票，不能手工复制内容。');
        if (typeof body.sourceInvoiceId !== 'string' || !body.sourceInvoiceId.trim() || typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)
          || body.expectedFingerprint !== undefined && body.expectedSourceFingerprint !== undefined && body.expectedFingerprint !== body.expectedSourceFingerprint
          || body.expectedShipmentSourceFingerprint !== undefined && (typeof body.expectedShipmentSourceFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedShipmentSourceFingerprint))) throw businessError('VALIDATION_FAILED', '请选择并刷新原财务应收票来源。');
        const trustedActor = ciActor(req, true);
        item = await svc.createTradeDocument({ type: body.type, ...(body.shipmentId ? { shipmentId: body.shipmentId } : {}) }, trustedActor!.userId,
          { trustedActor, sourceInvoiceId: body.sourceInvoiceId, ...(body.shipmentId ? { shipmentId: body.shipmentId } : {}), expectedSourceFingerprint: fingerprint,
            ...(body.expectedShipmentSourceFingerprint !== undefined ? { expectedShipmentSourceFingerprint: body.expectedShipmentSourceFingerprint } : {}) });
      } else item = await svc.createTradeDocument(req.body, actorId(req));
      res.json({ ok: true, document: serialize(item) });
    } catch (e: any) { if (req.body?.type === 'PackingList' || isPackingListFailure(e)) return plFailure(res, e); res.status(req.body?.type === 'CommercialInvoice' ? statusFromError(e, 500) : 500).json({ error: req.body?.type === 'CommercialInvoice' && typeof e?.code === 'string' ? e.code : 'INTERNAL_ERROR', message: e?.message }); }
  });

  // ─── T7-② 三单一致核对（箱单 / 商业发票 / 报关单）────────────────────────
  // 锚点 = 运单；纯只读；**差异恒为 warning，只预警不阻断**（口径 C）。
  // 设计真源 docs/design/T7-2-三单一致-设计-2026-09-16.md
  router.get('/shipments/:shipmentId/triple-consistency', requirePermission('customs:read'), async (req, res) => {
    try {
      const result = await checkTripleConsistency(opts.prisma, req.params.shipmentId, { trustedActor: ciActor(req) });
      if (!result) {
        res.status(404).json({ error: { code: 'SHIPMENT_NOT_FOUND', message: `运单 ${req.params.shipmentId} 不存在` } });
        return;
      }
      res.json(result);
    } catch (e: any) {
      logger.error('[CustomsV2Route] triple consistency failed', { error: e?.message ?? String(e), shipmentId: req.params.shipmentId });
      const safe = safeRouteError(e, { fallbackCode: 'TRIPLE_CONSISTENCY_FAILED', fallbackMessage: '三单一致核对未完成；请稍后重试，持续失败请联系管理员查看服务日志。' });
      res.status(safe.status).json({ error: { code: safe.code, message: safe.message } });
    }
  });

  // ─── T7-④ 退税报缺 + 补齐后重算 ────────────────────────────────────────
  // 口径 E：**显式报缺 + 补齐后一键重算**（不用市场汇率/默认退税率静默兜底）。
  // gaps 实时计算（不存库）——补齐后自动消失。
  router.get('/declarations/:id/tax-refund/gaps', requirePermission('customs:read'), async (req, res) => {
    try {
      const r = await describeTaxRefundGaps(opts.prisma, req.params.id);
      if (!r.ok) { res.status(r.error.status).json({ error: { code: r.error.code, message: r.error.message } }); return; }
      res.json(serialize(r.data));
    } catch (e: any) {
      logger.error('[CustomsV2Route] tax-refund gaps failed', { error: e?.message ?? String(e), id: req.params.id });
      const safe = safeRouteError(e, { fallbackCode: 'TAX_REFUND_GAPS_FAILED', fallbackMessage: '退税缺口清单未完成；请稍后重试，持续失败请联系管理员查看服务日志。' });
      res.status(safe.status).json({ error: { code: safe.code, message: safe.message } });
    }
  });

  // mode=fill_missing（默认，只填 null 不覆盖人工值）| mode=force（只返回 diff 不落库）
  // 仅 Draft / Rejected 可重算（已提交的申报数据不可悄悄修改）。
  router.post('/declarations/:id/tax-refund/recalc', requireWrite, requirePermission('customs:write'), async (req, res) => {
    try {
      const r = await recalcTaxRefund(opts.prisma, req.params.id, {
        mode: req.body?.mode,
        actorId: actorId(req),
        ip: req.ip || null,
      });
      if (!r.ok) { res.status(r.error.status).json({ error: { code: r.error.code, message: r.error.message } }); return; }
      res.json(serialize(r.data));
    } catch (e: any) {
      logger.error('[CustomsV2Route] tax-refund recalc failed', { error: e?.message ?? String(e), id: req.params.id });
      const safe = safeRouteError(e, { fallbackCode: 'TAX_REFUND_RECALC_FAILED', fallbackMessage: '退税重算未完成；请稍后重试，持续失败请联系管理员查看服务日志。' });
      res.status(safe.status).json({ error: { code: safe.code, message: safe.message } });
    }
  });

  // ─── D2 报关成交方式 ↔ 订单 Incoterms 一致性核对 ──────────────────────
  // 口径：以**订单条款为准**（商业合同依据）；不一致只预警不阻断（沿用 T7 口径）；
  // 逐字归一化比对 + 按矩阵 D2 分组（FOB / CIF(含CFR) / OTHER）区分差异严重程度。
  router.get('/declarations/:id/incoterm-consistency', requirePermission('customs:read'), async (req, res) => {
    try {
      const result = await checkIncotermConsistency(opts.prisma, req.params.id);
      if (!result) {
        res.status(404).json({ error: { code: 'DECLARATION_NOT_FOUND', message: `报关单 ${req.params.id} 不存在` } });
        return;
      }
      res.json(result);
    } catch (e: any) {
      logger.error('[CustomsV2Route] incoterm consistency failed', { error: e?.message ?? String(e), id: req.params.id });
      const safe = safeRouteError(e, { fallbackCode: 'INCOTERM_CONSISTENCY_FAILED', fallbackMessage: '成交方式与订单条款核对未完成；请稍后重试，持续失败请联系管理员查看服务日志。' });
      res.status(safe.status).json({ error: { code: safe.code, message: safe.message } });
    }
  });

  return router;
}
