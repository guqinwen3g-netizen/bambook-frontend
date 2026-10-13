
import { createCurrentWriteActor } from '../auth/currentWriteActor';
import { assertApprovalReviewSourceRead } from '../approvals/approvalReviewSourceAccess';
import { buildApprovalSignDocumentSnapshot } from '../approvals/approvalSignDocumentSnapshotService';
import { readMergedPackingListSelection, saveMergedPackingListDraft, readOwnMergedPackingListCommand } from './mergedPackingListCommand';
import { readPackingListArchive, recheckPackingListArchive, isPackingListArchiveCandidate, pinPackingListArchiveVersion } from './packingListArchiveService';
import { readPackingListDraftSource, readOwnPackingListCommand, appendPackingListDraftVersion, readPackingListDocument, readPackingListVersion, listPackingListVersions, isPackingListCandidateInTx, packingListFileUnavailable, packingListHttpFailure, isPackingListFailure } from './shipmentPackingListCommand';
/**
 * 外贸与报关 API — /api/v1/customs
 *
 * @deprecated（G6 新旧接口收敛，2026-08-28）前端四大域（报关单/HS 编码/信用证/出口退税）已统一走
 *   /api/v2/customs（带 customs:read/customs:write 细粒度权限守卫），本路由对应端点逐步废弃、新代码请勿调用。
 *   注意：trade-documents 系列端点（单据中心/出运制单在用）暂未迁移，仍由本路由服务。
 *
 * 端点：
 *   ── 报关单 CustomsDeclaration ──
 *   GET    /declarations              — 报关单列表（支持 type/status/shipmentId/orderId/relationId/search 过滤）
 *   GET    /declarations/:id          — 报关单详情（含明细行）
 *   POST   /declarations              — 创建报关单（含明细行）
 *   PUT    /declarations/:id           — 更新报关单（仅 Draft）
 *   DELETE /declarations/:id          — 软删除报关单（仅 Draft/Cancelled）
 *   POST   /declarations/:id/transition — 状态流转
 *
 *   ── HS 编码 HsCode ──
 *   GET    /hs-codes                  — HS 编码列表（支持 category/search/isActive 过滤）
 *   GET    /hs-codes/:code             — 按 code 查询 HS 编码
 *   POST   /hs-codes                   — 创建 HS 编码
 *   PUT    /hs-codes/:id               — 更新 HS 编码
 *   DELETE /hs-codes/:id               — 停用 HS 编码（deactivate）
 *
 *   ── 信用证 LetterOfCredit ──
 *   GET    /letters-of-credit          — 信用证列表（支持 status/relationId/orderId/search 过滤）
 *   GET    /letters-of-credit/:id      — 信用证详情
 *   POST   /letters-of-credit          — 创建信用证
 *   PUT    /letters-of-credit/:id      — 更新信用证（仅 Issued）
 *   DELETE /letters-of-credit/:id      — 软删除信用证（仅 Issued/Cancelled）
 *   POST   /letters-of-credit/:id/transition — 状态流转
 *   GET    /letters-of-credit/:id/events    — 节点时间轴（F1 LcEvent 升序全量）
 *
 *   ── 出口退税 TaxRefund ──
 *   GET    /tax-refunds                — 退税列表（支持 status/declarationId/orderId/relationId/search 过滤）
 *   GET    /tax-refunds/:id            — 退税详情
 *   POST   /tax-refunds                — 创建退税记录（自动计算退税额）
 *   POST   /tax-refunds/from-declaration/:declarationId — 从报关单自动核算生成退税草稿（L10 同一入口）
 *   PUT    /tax-refunds/:id            — 更新退税记录（仅 Draft）
 *   DELETE /tax-refunds/:id            — 软删除退税记录（仅 Draft/Cancelled）
 *   POST   /tax-refunds/:id/transition — 状态流转
 *   POST   /tax-refunds/:id/review     — 审核（Approved/Rejected）
 *
 *   ── 贸易单据 TradeDocument ──
 *   GET    /trade-documents           — 单据列表（支持 type/status/shipmentId/declarationId/orderId/relationId/search 过滤）
 *   GET    /trade-documents/pack?orderId= — 订单单据批量打包（最新版本快照，L/C 交单场景；Wave A1）
 *   GET    /trade-documents/:id       — 单据详情
 *   POST   /trade-documents           — 创建单据（documentNumber 留空自动取号，Wave A1）
 *   POST   /trade-documents/generate-from-shipment — 运单批量生成单据草稿（生成即登记+v1 快照，幂等；Wave A1）
 *   PUT    /trade-documents/:id       — 更新单据（仅 Draft，服务端强制版本留痕）
 *   DELETE /trade-documents/:id       — 软删除单据（仅 Draft/Cancelled）
 *   POST   /trade-documents/:id/transition — 状态流转
 *   GET    /trade-documents/:id/versions   — 版本列表
 *   GET    /trade-documents/:id/versions/:version — 指定版本快照
 *   POST   /trade-documents/:id/versions   — 手动追加版本（编辑内容快照）
 *
 *   ── 概览 ──
 *   GET    /overview                   — 外贸报关概览统计
 */

import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { extractActorFromRequest } from '../auth/middleware';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { isInsideDir } from '../lib/privateFiles';
import { logger } from '../lib/logger';
import {
  createCustomsService,
  CustomsDeclarationInput,
  CustomsDeclarationLineInput,
  HsCodeInput,
  LetterOfCreditInput,
  TaxRefundInput,
  TaxRefundReviewInput,
  TradeDocumentInput,
  CustomsDeclarationStatus,
  LetterOfCreditStatus,
  TaxRefundStatus,
  TradeDocumentStatus,
  TradeDocumentType,
} from './customsService';
import { createDocumentTemplateService } from './documentTemplateService';
import { generateTradeDocumentsFromShipment, generateTradeDocumentFile, renderTradeDocumentServerHtml, isNativeQcDocument, isQcReportDocumentCandidate, loadAuthorizedQcDocumentSource, assertQcTradeDocumentArchive, assertCiTradeDocumentArchive } from './tradeDocumentLifecycleService';
import { assembleCompositeDocument, isCompositeDocKind, buildCompositeSourceRef, COMPOSITE_TRADE_DOC_TYPE } from './compositeDocumentService';
import { createApprovalCreateService } from '../approvals/approvalCreateService';
import { createApprovalRoutingService } from '../approvals/approvalRoutingService';
import { resolveDocumentSignerByDoc } from '../seal/documentSigner';
import { renderServerDocument, isShipmentDocKind, serverKindForType } from '../templates/docTemplates/registry';
import { renderHtmlToPdf } from '../templates/pdf';
import { assembleDocumentSetData } from '../shipping/documentSetService';
import { readCiInvoiceSource, readHistoricalCiDocument } from './ciInvoiceSource';
import { documentSourceFingerprint } from '../shipping/shipmentDocumentSource';
import { isBusinessShipmentCi, readBusinessShipmentCiVersion } from './businessShipmentCiSnapshot';
import { businessError } from '../shared/errorCodes';
import { archiveExternalTradeDocumentFile, isExternalCustomsTradeDocument, readExternalTradeDocumentArchive } from './externalTradeDocumentArchiveService';
import { listCiVisibleTradeDocuments, packCiVisibleTradeDocumentsByOrder } from './ciDocumentCollection';
import { isSupplierContractDocumentCandidate, rejectGenericSupplierDocumentWrite } from './supplierContractDocumentPolicy';
import { readSupplierContractArchive, renderSupplierContractTradeDocument } from './supplierContractDocumentArchive';
import { readSupplierDocumentHistoryInTx } from './supplierContractDocumentHistory';
import { createExternalTradeDocumentUpload } from './externalTradeDocumentUpload';
import crypto from 'crypto';
import JSZip from 'jszip';
import path from 'path';
import fs from 'fs';

import { resolveVisibleOrderIds, resolveVisibleShipmentIds } from '../auth/orderVisibility';
import { statusFromError } from '../shared/bizStatus';
import type { TokenPayload } from '../auth/service';
import { QcReportError, loadAuthorizedQcReportSource, qcReportFailure } from '../qc/qcReportAuthority';
import { safeRouteError } from '../shared/routeError';
import { EXTERNAL_DECLARATION_REQUIRED } from './externalDeclarationContract';
import { todayLocalKey } from '../shared/localDate';

export interface CustomsRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
}

const VALID_DECLARATION_STATUSES: CustomsDeclarationStatus[] = ['Draft', 'Submitted', 'Declared', 'Inspecting', 'Released', 'Exception', 'Cancelled'];
const VALID_LC_STATUSES: LetterOfCreditStatus[] = ['Issued', 'Presented', 'Accepted', 'Discrepant', 'Settled', 'Expired', 'Cancelled'];
const VALID_TAX_REFUND_STATUSES: TaxRefundStatus[] = ['Draft', 'Submitted', 'Reviewing', 'Approved', 'Rejected', 'Refunded', 'Cancelled'];
const VALID_DOC_STATUSES: TradeDocumentStatus[] = ['Draft', 'Issued', 'Submitted', 'Accepted', 'Rejected', 'Cancelled'];

export function createCustomsRouter(options: CustomsRouterOptions): Router {
  const router = Router();
  const { prisma, requireAuth, apiKeys, onDataChange } = options;
  const service = createCustomsService(prisma);
  const currentSignDocumentActor = createCurrentWriteActor(prisma);
  const docTemplates = createDocumentTemplateService(prisma);

  const authenticate = (req: Request, res: Response): boolean => {
    if (!requireAuth) return true;
    const apiKey = (req.query.apiKey as string) || (req.headers['x-bambook-api-key'] as string);
    if (apiKey && apiKeys.has(apiKey)) return true;
    const actor = extractActorFromRequest(req);
    if (actor?.userId) return true;
    res.status(401).json({ error: 'authentication required' });
    return false;
  };

  const actorOf = (req: Request): string => {
    const actor = extractActorFromRequest(req);
    return actor?.userId || 'system';
  };

  const nativeQcActor = (req: Request, write = false) => {
    const request = req as Request & { actor?: TokenPayload; authSource?: string };
    if (write && request.authSource !== 'user-session') throw new QcReportError('UNAUTHORIZED', '验货报告写操作需要用户登录。');
    return request.actor ?? extractActorFromRequest(req);
  };
  const nativeQcError = (res: Response, error: unknown) => {
    const result = safeRouteError(qcReportFailure(error), { fallbackCode: 'QC_REPORT_DOCUMENT_FAILED',
      fallbackMessage: '验货报告文档处理结果暂不可确认，请刷新记录后重试。' });
    return res.status(result.status).json({ error: result.code, message: result.message });
  };

  // This actor is attached by the original module credential extractor. Body
  // actor/roles/ceilings are never authority; CI writes retain user-session policy.
  const ciActor = (req: Request, write = false): TokenPayload | null => {
    const request = req as Request & { actor?: TokenPayload; authSource?: string };
    if (write && request.authSource !== 'user-session') throw businessError('UNAUTHORIZED', '商业发票写操作需要用户登录。');
    return request.actor ?? extractActorFromRequest(req);
  };
  const ciOptions = (req: Request, write = false) => {
    const body = req.body ?? {}, fingerprint = body.expectedSourceFingerprint ?? body.expectedFingerprint;
    if (typeof body.sourceInvoiceId !== 'string' || !body.sourceInvoiceId.trim()) throw businessError('VALIDATION_FAILED', '请选择原财务应收票。');
    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)
      || body.expectedFingerprint !== undefined && body.expectedSourceFingerprint !== undefined && body.expectedFingerprint !== body.expectedSourceFingerprint)
      throw businessError('VALIDATION_FAILED', '请刷新并核对选定原发票来源。');
    if (body.expectedShipmentSourceFingerprint !== undefined && (typeof body.expectedShipmentSourceFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedShipmentSourceFingerprint)))
      throw businessError('VALIDATION_FAILED', '运单来源凭据无效。');
    return { trustedActor: ciActor(req, write), sourceInvoiceId: body.sourceInvoiceId,
      ...(typeof body.shipmentId === 'string' ? { shipmentId: body.shipmentId } : {}), expectedSourceFingerprint: fingerprint,
      ...(body.expectedShipmentSourceFingerprint !== undefined ? { expectedShipmentSourceFingerprint: body.expectedShipmentSourceFingerprint } : {}) };
  };
  const packingListRequests = new WeakSet<Request>();
  const plFailure = (res: Response, error: unknown) => { const safe = packingListHttpFailure(error); return res.status(safe.status).json({ error: safe.code, message: safe.message }); };
  const markPackingList = async (req: Request, doc: any) => { const candidate = await isPackingListCandidateInTx(prisma, doc); if (candidate) packingListRequests.add(req); return candidate; };
  const markPackingListArchive = async (req: Request, doc: any) => { try { const candidate = await isPackingListArchiveCandidate(prisma, doc); if (candidate) packingListRequests.add(req); return candidate; } catch (error) { packingListRequests.add(req); throw error; } };
  const historyCi = async (req: Request, doc: any, version?: number) => {
    if (isSupplierContractDocumentCandidate(doc)) {
      const history = await prisma.$transaction(tx => readSupplierDocumentHistoryInTx(tx, doc.id, ciActor(req), version));
      doc.supplierDocumentProof = history.proofState;
    }
    else if (isBusinessShipmentCi(doc)) await readBusinessShipmentCiVersion(prisma, doc.id, ciActor(req),
      { ...(version !== undefined ? { version } : {}), requiredScopes: ['customs:read'] });
    else if (doc?.type === 'CommercialInvoice') await readHistoricalCiDocument(prisma, doc.id, { trustedActor: ciActor(req), ...(version !== undefined ? { version } : {}) });
  };
  const selectedVersion = (value: unknown): number | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' && typeof value !== 'number' || !/^[1-9]\d*$/.test(String(value))) throw businessError('VALIDATION_FAILED', '非法版本号。');
    const version = Number(value);
    if (!Number.isSafeInteger(version) || version < 1) throw businessError('VALIDATION_FAILED', '非法版本号。');
    return version;
  };
  const plArchiveReads = new WeakSet<Request>();
  const plSelectedVersions = new WeakMap<Request, Map<string, number>>();
  const plBatchVersion = (req: Request, id: string) => {
    const versions = req.body?.versions;
    if (versions !== undefined && (!versions || typeof versions !== 'object' || Array.isArray(versions))) throw businessError('VALIDATION_FAILED', '请按单据保留明确的版本选择。');
    return selectedVersion(versions?.[id]);
  };
  const ciArchiveReads = new WeakSet<Request>();
  const ciArchiveCandidate = async (doc: any): Promise<boolean> => {
    if (doc?.type === 'CommercialInvoice' || doc?.filePath?.startsWith('trade-documents/ci-')) return true;
    if (!doc?.filePath) return false;
    const audits = await prisma.auditLog.findMany({ where: { action: 'TRADE_DOCUMENT_FILE_GENERATED', detail: { path: ['filePath'], equals: doc.filePath } } });
    return audits.some(row => typeof (row.detail as any)?.sourceInvoiceId === 'string');
  };
  const batchDocumentAccess = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ids = [...new Set<string>(Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown): id is string => typeof id === 'string' && !!id) : [])];
      const docs = ids.length ? await prisma.tradeDocument.findMany({ where: { id: { in: ids }, deletedAt: null } }) : [];
      if (docs.length === ids.length && docs.length > 0 && docs.every(isSupplierContractDocumentCandidate)) {
        for (const doc of docs) await readSupplierContractArchive(prisma, { documentId: doc.id, actor: ciActor(req), version: plBatchVersion(req, doc.id) });
        return next();
      }
      if (docs.length === ids.length && docs.length > 0 && docs.every(doc => doc.type === 'CommercialInvoice' && doc.filePath)) {
        for (const doc of docs) await assertCiTradeDocumentArchive(prisma, doc, ciActor(req));
        ciArchiveReads.add(req); return next();
      }
      if (docs.length === ids.length && docs.length > 0 && docs.every(isExternalCustomsTradeDocument)) {
        const uploadRoot = process.env.BAMBOOK_UPLOAD_DIR || path.join(__dirname, '../../../uploads');
        for (const doc of docs) await readExternalTradeDocumentArchive(prisma, { documentId: doc.id, uploadRoot });
        return requirePermission('customs:read')(req, res, next);
      }
      const plCandidates = await Promise.all(docs.map(doc => markPackingList(req, doc).then(found => found || markPackingListArchive(req, doc))));
      if (docs.length === ids.length && plCandidates.some(Boolean)) {
        const fixed = new Map<string, number>(); let allArchived = docs.length > 0;
        for (let index = 0; index < docs.length; index++) {
          const doc = docs[index];
          if (plCandidates[index]) {
            const version = await pinPackingListArchiveVersion(prisma, { documentId: doc.id, version: plBatchVersion(req, doc.id), trustedActor: ciActor(req) });
            fixed.set(doc.id, version);
            if (!await readPackingListArchive(prisma, { documentId: doc.id, version, trustedActor: ciActor(req), allowMissing: true })) allArchived = false;
          } else if (doc.type === 'CommercialInvoice' && doc.filePath) await assertCiTradeDocumentArchive(prisma, doc, ciActor(req));
          else allArchived = false;
        }
        plSelectedVersions.set(req, fixed);
        if (allArchived) { plArchiveReads.add(req); return requirePermission('customs:read')(req, res, next); }
      }
      return requireWrite(req, res, () => requireCustomsWrite(req, res, next));
    } catch (error) {
      const safe = safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR' });
      return res.status(safe.status).json({ error: safe.code, message: safe.message });
    }
  };
  const ciBytes = async (req: Request, doc: any, bytes: Buffer) => {
    await assertCiTradeDocumentArchive(prisma, doc, ciActor(req));
    if (doc.type !== 'CommercialInvoice') return;
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    const audits = await prisma.auditLog.findMany({ where: { action: 'TRADE_DOCUMENT_FILE_GENERATED', targetType: 'TradeDocument', targetId: doc.id } });
    if (!audits.some(row => { const detail = row.detail as any; return detail?.fileName === doc.fileName
      && (!detail.filePath || detail.filePath === doc.filePath) && detail.sha === sha && detail.fileSize === bytes.length; }))
      throw businessError('CONFLICT', '归档文件字节与原生成审计不一致。');
    await assertCiTradeDocumentArchive(prisma, doc, ciActor(req));
  };
  const renderHistoricalNonCiVersion = async (req: Request, doc: any, version: number) => {
    if (isSupplierContractDocumentCandidate(doc)) return renderSupplierContractTradeDocument(prisma, { documentId: doc.id, actor: ciActor(req), version });
    if (await markPackingList(req, doc)) return renderTradeDocumentServerHtml(prisma, doc, { screen: true, version, trustedActor: ciActor(req) });
    if (isQcReportDocumentCandidate(doc)) await loadAuthorizedQcDocumentSource(prisma, nativeQcActor(req), doc);
    const selected = await docTemplates.getVersion(doc.id, version), content = selected.content as any;
    const kind = serverKindForType(doc.type);
    if (!kind) return null;
    const data = content?.documentSet ?? content?.data ?? (kind === 'OTHER' ? { source: 'doc', doc: content } : null);
    if (!data) return null;
    const html = await renderServerDocument(prisma, kind, data, { screen: true }, { id: doc.id, type: doc.type, sourceRef: doc.sourceRef ?? null });
    const final = await docTemplates.getVersion(doc.id, version);
    if (documentSourceFingerprint(final) !== documentSourceFingerprint(selected)) throw businessError('CONFLICT', '历史版本在读取时变化。');
    if (isQcReportDocumentCandidate(doc)) await loadAuthorizedQcDocumentSource(prisma, nativeQcActor(req), doc);
    return html;
  };

  // 统一认证守卫
  router.use(createModuleAuthGuard({ requireAuth, apiKeys }));
  // 写操作必须 JWT
  const requireWrite = requireJwtForWrite({ requireAuth, apiKeys });
  // S3-γ：写端点在 JWT 之上叠加 customs:write scope 门（与 /api/v2/customs 守卫口径对齐；
  // LOGISTICS 持有，SuperAdmin/owner 全通；读端点不动）
  const requireCustomsWrite = requirePermission('customs:write');
  const externalArchiveUpload = createExternalTradeDocumentUpload();
  /** §10.3-9 电子签：合同「提交签署」建审批单（复用 DR-007 审批路由解析审批人） */
  const approvalCreateService = createApprovalCreateService({
    prisma,
    routingService: createApprovalRoutingService({ prisma }),
  });

  // ════════════════════════════════════════════════════════════
  // 1. CustomsDeclaration（报关单）
  // ════════════════════════════════════════════════════════════

  router.get('/declarations', async (req: Request, res: Response) => {
    if (!authenticate(req, res)) return;
    try {
      // §10.4.2：报关单随关联订单可见（无 orderId 的按运单维兜底）
      const visDecl = await resolveVisibleOrderIds(prisma, (req as any).actor ?? null);
      const result = await service.listDeclarations({
        visibleOrderIds: visDecl,
        visibleShipmentIds: visDecl ? await resolveVisibleShipmentIds(prisma, visDecl) : undefined,
        type: req.query.type as string | undefined,
        status: req.query.status as string | undefined,
        shipmentId: req.query.shipmentId as string | undefined,
        orderId: req.query.orderId as string | undefined,
        relationId: req.query.relationId as string | undefined,
        search: req.query.search as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      res.json(result);
    } catch (e: any) {
      logger.error('[CustomsRoute] GET declarations failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to list declarations' });
    }
  });

  router.get('/declarations/:id', async (req: Request, res: Response) => {
    if (!authenticate(req, res)) return;
    try {
      const item = await service.getDeclaration(req.params.id);
      // §10.4.2：详情防「猜 id 直读」——关联订单或所属运单任一可见即可
      const visDetail = await resolveVisibleOrderIds(prisma, (req as any).actor ?? null);
      if (visDetail) {
        const visShipments = await resolveVisibleShipmentIds(prisma, visDetail);
        const byOrder = item?.orderId ? visDetail.includes(item.orderId) : false;
        const byShipment = item?.shipmentId ? visShipments.includes(item.shipmentId) : false;
        if (!byOrder && !byShipment) {
          return res.status(404).json({ error: 'DECLARATION_NOT_FOUND' });
        }
      }
      res.json({ item });
    } catch (e: any) {
      logger.error('[CustomsRoute] GET declaration failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to get declaration' });
    }
  });

  router.post('/declarations', requireWrite, requireCustomsWrite, async (req: Request, res: Response) => {
    return res.status(410).json(EXTERNAL_DECLARATION_REQUIRED);
  });

  router.put('/declarations/:id', requireWrite, requireCustomsWrite, async (req: Request, res: Response) => {
    return res.status(410).json(EXTERNAL_DECLARATION_REQUIRED);
  });

  router.delete('/declarations/:id', requireWrite, requireCustomsWrite, async (req: Request, res: Response) => {
    return res.status(410).json(EXTERNAL_DECLARATION_REQUIRED);
  });

  router.post('/declarations/:id/transition', requireWrite, requireCustomsWrite, async (req: Request, res: Response) => {
    return res.status(410).json(EXTERNAL_DECLARATION_REQUIRED);
  });

  // ════════════════════════════════════════════════════════════
  // 2. HsCode（HS 编码库）
  // ════════════════════════════════════════════════════════════

  router.get('/hs-codes', async (req: Request, res: Response) => {
    if (!authenticate(req, res)) return;
    try {
      const result = await service.listHsCodes({
        category: req.query.category as string | undefined,
        search: req.query.search as string | undefined,
        isActive: req.query.isActive === 'true' ? true : req.query.isActive === 'false' ? false : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      res.json(result);
    } catch (e: any) {
      logger.error('[CustomsRoute] GET hs-codes failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to list hs-codes' });
    }
  });

  router.get('/hs-codes/:code', async (req: Request, res: Response) => {
    if (!authenticate(req, res)) return;
    try {
      const item = await service.getHsCodeByCode(req.params.code);
      res.json({ item });
    } catch (e: any) {
      logger.error('[CustomsRoute] GET hs-code failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to get hs-code' });
    }
  });

  router.post('/hs-codes', requireWrite, requireCustomsWrite, async (req: Request, res: Response) => {
    try {
      const input = req.body as HsCodeInput;
      if (!input.code || !input.description || !input.category) {
        return res.status(400).json({ error: 'code, description and category are required' });
      }
      const item = await service.createHsCode(input, actorOf(req));
      onDataChange?.({ entity: 'HsCode', action: 'create', ids: [item.id] });
      res.status(201).json({ item });
    } catch (e: any) {
      logger.error('[CustomsRoute] POST hs-code failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to create hs-code' });
    }
  });

  router.put('/hs-codes/:id', requireWrite, requireCustomsWrite, async (req: Request, res: Response) => {
    try {
      const input = req.body as Partial<HsCodeInput>;
      const item = await service.updateHsCode(req.params.id, input, actorOf(req));
      onDataChange?.({ entity: 'HsCode', action: 'update', ids: [item.id] });
      res.json({ item });
    } catch (e: any) {
      logger.error('[CustomsRoute] PUT hs-code failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to update hs-code' });
    }
  });

  router.delete('/hs-codes/:id', requireWrite, requireCustomsWrite, async (req: Request, res: Response) => {
    try {
      const result = await service.deleteHsCode(req.params.id, actorOf(req));
      onDataChange?.({ entity: 'HsCode', action: 'delete', ids: [result.id] });
      res.json(result);
    } catch (e: any) {
      logger.error('[CustomsRoute] DELETE hs-code failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to delete hs-code' });
    }
  });

  // ════════════════════════════════════════════════════════════
  // 3. LetterOfCredit（信用证）
  // ════════════════════════════════════════════════════════════

  router.get('/letters-of-credit', async (req: Request, res: Response) => {
    if (!authenticate(req, res)) return;
    try {
      const result = await service.listLettersOfCredit({
        status: req.query.status as string | undefined,
        relationId: req.query.relationId as string | undefined,
        orderId: req.query.orderId as string | undefined,
        search: req.query.search as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      res.json(result);
    } catch (e: any) {
      logger.error('[CustomsRoute] GET letters-of-credit failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to list letters-of-credit' });
    }
  });

  router.get('/letters-of-credit/:id', async (req: Request, res: Response) => {
    if (!authenticate(req, res)) return;
    try {
      const item = await service.getLetterOfCredit(req.params.id);
      res.json({ item });
    } catch (e: any) {
      logger.error('[CustomsRoute] GET letter-of-credit failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to get letter-of-credit' });
    }
  });

  router.post('/letters-of-credit', requireWrite, requireCustomsWrite, async (req: Request, res: Response) => {
    try {
      const input = req.body as LetterOfCreditInput;
      if (!input.lcNumber || !input.type || input.amount == null) {
        return res.status(400).json({ error: 'lcNumber, type and amount are required' });
      }
      const item = await service.createLetterOfCredit(input, actorOf(req));
      onDataChange?.({ entity: 'LetterOfCredit', action: 'create', ids: [item.id] });
      res.status(201).json({ item });
    } catch (e: any) {
      logger.error('[CustomsRoute] POST letter-of-credit failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to create letter-of-credit' });
    }
  });

  router.put('/letters-of-credit/:id', requireWrite, requireCustomsWrite, async (req: Request, res: Response) => {
    try {
      const input = req.body as Partial<LetterOfCreditInput>;
      const item = await service.updateLetterOfCredit(req.params.id, input, actorOf(req));
      onDataChange?.({ entity: 'LetterOfCredit', action: 'update', ids: [item.id] });
      res.json({ item });
    } catch (e: any) {
      logger.error('[CustomsRoute] PUT letter-of-credit failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to update letter-of-credit' });
    }
  });

  router.delete('/letters-of-credit/:id', requireWrite, requireCustomsWrite, async (req: Request, res: Response) => {
    try {
      const result = await service.deleteLetterOfCredit(req.params.id, actorOf(req));
      onDataChange?.({ entity: 'LetterOfCredit', action: 'delete', ids: [result.id] });
      res.json(result);
    } catch (e: any) {
      logger.error('[CustomsRoute] DELETE letter-of-credit failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to delete letter-of-credit' });
    }
  });

  router.post('/letters-of-credit/:id/transition', requireWrite, requireCustomsWrite, async (req: Request, res: Response) => {
    try {
      const { toStatus, discrepancies } = req.body as { toStatus: LetterOfCreditStatus; discrepancies?: string };
      if (!toStatus || !VALID_LC_STATUSES.includes(toStatus)) {
        return res.status(400).json({ error: `非法信用证状态: ${toStatus}` });
      }
      const item = await service.transitionLcStatus(req.params.id, toStatus, actorOf(req), discrepancies);
      onDataChange?.({ entity: 'LetterOfCredit', action: 'transition', ids: [item.id] });
      res.json({ item });
    } catch (e: any) {
      logger.error('[CustomsRoute] POST letter-of-credit transition failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to transition letter-of-credit' });
    }
  });

  // F1：信用证节点时间轴（LcEvent 全量升序）
  router.get('/letters-of-credit/:id/events', async (req: Request, res: Response) => {
    if (!authenticate(req, res)) return;
    try {
      const result = await service.listLcEvents(req.params.id);
      res.json(result);
    } catch (e: any) {
      logger.error('[CustomsRoute] GET letter-of-credit events failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to list lc events' });
    }
  });

  // ════════════════════════════════════════════════════════════
  // 4. TaxRefund（出口退税）
  // ════════════════════════════════════════════════════════════

  router.get('/tax-refunds', async (req: Request, res: Response) => {
    if (!authenticate(req, res)) return;
    try {
      const result = await service.listTaxRefunds({
        status: req.query.status as string | undefined,
        declarationId: req.query.declarationId as string | undefined,
        orderId: req.query.orderId as string | undefined,
        relationId: req.query.relationId as string | undefined,
        search: req.query.search as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      res.json(result);
    } catch (e: any) {
      logger.error('[CustomsRoute] GET tax-refunds failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to list tax-refunds' });
    }
  });

  router.get('/tax-refunds/:id', async (req: Request, res: Response) => {
    if (!authenticate(req, res)) return;
    try {
      const item = await service.getTaxRefund(req.params.id);
      res.json({ item });
    } catch (e: any) {
      logger.error('[CustomsRoute] GET tax-refund failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to get tax-refund' });
    }
  });

  router.post('/tax-refunds', requireWrite, requireCustomsWrite, async (req: Request, res: Response) => {
    try {
      const input = req.body as TaxRefundInput;
      if (!input.refundNumber) {
        return res.status(400).json({ error: 'refundNumber is required' });
      }
      const item = await service.createTaxRefund(input, actorOf(req));
      onDataChange?.({ entity: 'TaxRefund', action: 'create', ids: [item.id] });
      res.status(201).json({ item });
    } catch (e: any) {
      logger.error('[CustomsRoute] POST tax-refund failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to create tax-refund' });
    }
  });

  router.post('/tax-refunds/from-declaration/:declarationId', requireWrite, requireCustomsWrite, async (req: Request, res: Response) => {
    try {
      const item = await service.createTaxRefundFromDeclaration(req.params.declarationId, actorOf(req));
      onDataChange?.({ entity: 'TaxRefund', action: 'create', ids: [item.id] });
      res.status(201).json({ item });
    } catch (e: any) {
      logger.error('[CustomsRoute] POST tax-refund from-declaration failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to create tax-refund from declaration' });
    }
  });

  router.put('/tax-refunds/:id', requireWrite, requireCustomsWrite, async (req: Request, res: Response) => {
    try {
      const input = req.body as Partial<TaxRefundInput>;
      const item = await service.updateTaxRefund(req.params.id, input, actorOf(req));
      onDataChange?.({ entity: 'TaxRefund', action: 'update', ids: [item.id] });
      res.json({ item });
    } catch (e: any) {
      logger.error('[CustomsRoute] PUT tax-refund failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to update tax-refund' });
    }
  });

  router.delete('/tax-refunds/:id', requireWrite, requireCustomsWrite, async (req: Request, res: Response) => {
    try {
      const result = await service.deleteTaxRefund(req.params.id, actorOf(req));
      onDataChange?.({ entity: 'TaxRefund', action: 'delete', ids: [result.id] });
      res.json(result);
    } catch (e: any) {
      logger.error('[CustomsRoute] DELETE tax-refund failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to delete tax-refund' });
    }
  });

  router.post('/tax-refunds/:id/transition', requireWrite, requireCustomsWrite, async (req: Request, res: Response) => {
    try {
      const { toStatus } = req.body as { toStatus: TaxRefundStatus };
      if (!toStatus || !VALID_TAX_REFUND_STATUSES.includes(toStatus)) {
        return res.status(400).json({ error: `非法退税状态: ${toStatus}` });
      }
      const item = await service.transitionTaxRefundStatus(req.params.id, toStatus, actorOf(req));
      onDataChange?.({ entity: 'TaxRefund', action: 'transition', ids: [item.id] });
      res.json({ item });
    } catch (e: any) {
      logger.error('[CustomsRoute] POST tax-refund transition failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to transition tax-refund' });
    }
  });

  router.post('/tax-refunds/:id/review', requireWrite, requireCustomsWrite, async (req: Request, res: Response) => {
    try {
      const input = req.body as TaxRefundReviewInput;
      if (!input.decision || !['Approved', 'Rejected'].includes(input.decision)) {
        return res.status(400).json({ error: 'decision must be Approved or Rejected' });
      }
      // G3：reviewedBy 不再要求请求体传入——审核人取真实登录人（actorOf 解析 JWT 身份），由 service 层落留痕
      const item = await service.reviewTaxRefund(req.params.id, input, actorOf(req));
      onDataChange?.({ entity: 'TaxRefund', action: 'review', ids: [item.id] });
      res.json({ item });
    } catch (e: any) {
      logger.error('[CustomsRoute] POST tax-refund review failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to review tax-refund' });
    }
  });

  // ════════════════════════════════════════════════════════════
  // 5. TradeDocument（贸易单据）
  // ════════════════════════════════════════════════════════════

  router.get('/trade-documents', async (req: Request, res: Response) => {
    if (!authenticate(req, res)) return;
    try {
      const result = await listCiVisibleTradeDocuments(prisma, {
        type: req.query.type as string | undefined,
        status: req.query.status as string | undefined,
        domain: req.query.domain as string | undefined,
        shipmentId: req.query.shipmentId as string | undefined,
        declarationId: req.query.declarationId as string | undefined,
        orderId: req.query.orderId as string | undefined,
        relationId: req.query.relationId as string | undefined,
        sourceInvoiceId: req.query.sourceInvoiceId as string | undefined,
        search: req.query.search as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      }, ciActor(req));
      res.json(result);
    } catch (e: any) {
      return plFailure(res, e);
    }
  });

  // Wave A1：批量打包须注册在 /trade-documents/:id 之前，避免 'pack' 被当作 id 捕获
  router.get('/trade-documents/pack', async (req: Request, res: Response) => {
    if (!authenticate(req, res)) return;
    try {
      const orderId = (req.query.orderId as string) || '';
      if (!orderId) return res.status(400).json({ error: 'orderId 必填' });
      const result = await packCiVisibleTradeDocumentsByOrder(prisma, orderId, ciActor(req));
      res.json(result);
    } catch (e: any) {
      return plFailure(res, e);
    }
  });

  router.post('/trade-documents/merged-packing-list-source', async (req: Request, res: Response) => {
    if (!authenticate(req, res)) return;
    try { res.json(await readMergedPackingListSelection(prisma, req.body?.sourceIds, ciActor(req))); }
    catch (error) { return plFailure(res, error); }
  });
  router.post('/trade-documents/merged-packing-lists', requireWrite, requireCustomsWrite, async (req: Request, res: Response) => {
    try { res.status(201).json(await saveMergedPackingListDraft(prisma, { trustedActor: ciActor(req, true), input: req.body })); }
    catch (error) { return plFailure(res, error); }
  });
  router.get('/trade-documents/merged-packing-list-commands/:requestKey', async (req: Request, res: Response) => {
    if (!authenticate(req, res)) return;
    try { res.json(await readOwnMergedPackingListCommand(prisma, { requestKey: req.params.requestKey, trustedActor: ciActor(req) })); }
    catch (error) { return plFailure(res, error); }
  });
  router.get('/trade-documents/:id/packing-list-commands/:requestKey', requirePermission('customs:read'), async (req, res) => {
    try { res.json(await readOwnPackingListCommand(prisma, { documentId: req.params.id, requestKey: req.params.requestKey, trustedActor: ciActor(req) })); }
    catch (error) { return plFailure(res, error); }
  });
  router.get('/trade-documents/:id/packing-list-source', requirePermission('customs:read'), async (req, res) => {
    try { res.json(await readPackingListDraftSource(prisma, req.params.id, ciActor(req))); }
    catch (error) { return plFailure(res, error); }
  });
  router.post('/trade-documents/:id/packing-list-versions', requireWrite, requireCustomsWrite, async (req, res) => {
    try { const result = await appendPackingListDraftVersion(prisma, { documentId: req.params.id, trustedActor: ciActor(req, true), input: req.body });
      onDataChange?.({ entity: 'TradeDocument', action: 'create_version', ids: [req.params.id] }); res.status(201).json(result); }
    catch (error) { return plFailure(res, error); }
  });
  router.get('/trade-documents/:id/packing-list-versions/:version', requirePermission('customs:read'), async (req, res) => {
    try { const version = selectedVersion(req.params.version)!;
      const result = await readPackingListVersion(prisma, { documentId: req.params.id, version, trustedActor: ciActor(req) });
      res.json({ item: result.item, protocol: result.protocol, provenance: result.provenance, envelope: result.envelope, receipt: result.receipt, warnings: result.warnings }); }
    catch (error) { return plFailure(res, error); }
  });
  router.get('/trade-documents/:id', async (req: Request, res: Response) => {
    if (!authenticate(req, res)) return;
    try {
      const item = await service.getTradeDocument(req.params.id);
      if (await markPackingList(req, item)) { const selected = await readPackingListDocument(prisma, item.id, ciActor(req));
        return res.json({ item: { ...selected.document, totalAmount: null, currency: null }, protocol: selected.protocol, provenance: selected.provenance, warnings: selected.warnings }); }
      await historyCi(req, item);
      res.json({ item });
    } catch (e: any) {
      if (packingListRequests.has(req) || isPackingListFailure(e) || req.body?.type === 'PackingList' || req.body?.kind === 'MERGED_PL') return plFailure(res, e);
      logger.error('[CustomsRoute] GET trade-document failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to get trade-document' });
    }
  });

  // Wave A1：运单 → 单据草稿批量生成（生成即登记 + v1 快照，同 shipmentId+type 幂等）
  router.post('/trade-documents/generate-from-shipment', requireWrite, requireCustomsWrite, async (req: Request, res: Response) => {
    try {
      if (Array.isArray(req.body?.types) && req.body.types.includes('PackingList')) packingListRequests.add(req);
      const { shipmentId, types } = req.body as { shipmentId?: string; types?: TradeDocumentType[] };
      if (typeof shipmentId !== 'string' || !shipmentId.trim() || !Array.isArray(types) || types.length === 0) {
        return res.status(400).json({ error: 'shipmentId 与 types（非空数组）必填' });
      }
      const sourceOptions = types.includes('CommercialInvoice') ? ciOptions(req, true) : { trustedActor: ciActor(req), expectedShipmentSourceFingerprint: req.body?.expectedShipmentSourceFingerprint };
      const result = await generateTradeDocumentsFromShipment(prisma, { shipmentId, types, actorId: actorOf(req), ...sourceOptions });
      if (result.created.length > 0) {
        onDataChange?.({ entity: 'TradeDocument', action: 'create', ids: result.created.map((c) => c.id) });
      }
      res.status(201).json(result);
    } catch (e: any) {
      if (packingListRequests.has(req) || isPackingListFailure(e) || req.body?.type === 'PackingList' || req.body?.kind === 'MERGED_PL') return plFailure(res, e);
      logger.error('[CustomsRoute] POST trade-documents generate-from-shipment failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to generate trade-documents' });
    }
  });

  // 一键生成文件：服务端模板优先（CI 财务回链/注册表 PL 等），其余前端渲染 HTML 传入
  // → 服务端 Puppeteer 转 PDF 落盘 uploads/trade-documents/ → 回写 filePath/fileName
  router.post('/trade-documents/:id/generate-file', requireWrite, requireCustomsWrite, async (req: Request, res: Response) => {
    let nativeQc = false;
    let nativeCi = false;
    try {
      const sourceDoc = await prisma.tradeDocument.findFirst({ where: { id: req.params.id, deletedAt: null } });
      if (isSupplierContractDocumentCandidate(sourceDoc)) {
        rejectGenericSupplierDocumentWrite(sourceDoc);
      }
      if (await markPackingList(req, sourceDoc) || await markPackingListArchive(req, sourceDoc)) {
        const result = await generateTradeDocumentFile(prisma, { id: req.params.id, version: selectedVersion(req.body?.version), actorId: actorOf(req), trustedActor: ciActor(req, true) });
        onDataChange?.({ entity: 'TradeDocument', action: 'update', ids: [req.params.id] }); return res.status(201).json(result);
      }
      nativeQc = isQcReportDocumentCandidate(sourceDoc);
      nativeCi = sourceDoc?.type === 'CommercialInvoice';
      const trustedActor = nativeQc ? nativeQcActor(req, true) : sourceDoc?.type === 'CommercialInvoice' ? ciActor(req, true) : undefined;
      const { html, version } = req.body as { html?: string; version?: number };
      const result = await generateTradeDocumentFile(prisma, {
        id: req.params.id,
        html: html ?? '',
        version: sourceDoc?.type === 'CommercialInvoice' ? selectedVersion(version) : typeof version === 'number' ? version : undefined,
        actorId: nativeQc ? trustedActor!.userId : actorOf(req),
        ...(nativeQc || sourceDoc?.type === 'CommercialInvoice' ? { trustedActor } : {}),
      });
      onDataChange?.({ entity: 'TradeDocument', action: 'update', ids: [req.params.id] });
      res.status(201).json(result);
    } catch (e: any) {
      if (packingListRequests.has(req) || isPackingListFailure(e) || req.body?.type === 'PackingList' || req.body?.kind === 'MERGED_PL') return plFailure(res, e);
      if (nativeQc || e instanceof QcReportError) return nativeQcError(res, e);
      if (nativeCi) {
        logger.error('[CustomsRoute] native CI file publication failed', { error: e?.message });
        const safe = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '商业发票生成结果暂不可确认，请刷新原记录后核对。' });
        return res.status(safe.status).json({ error: safe.code, message: safe.message });
      }
      logger.error('[CustomsRoute] POST trade-documents generate-file failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to generate trade-document file' });
    }
  });

  // 第三方签发单据只能归档原文件：上传写入每版本独立的受保护文件，并将文件凭据写入 DocumentVersion。
  router.post('/trade-documents/:id/external-archive', requireWrite, requireCustomsWrite, (req: Request, res: Response, next: NextFunction) => {
    externalArchiveUpload(req, res, (error: any) => {
      if (!error) return next();
      const tooLarge = error?.code === 'LIMIT_FILE_SIZE';
      return res.status(tooLarge ? 413 : 400).json({
        error: tooLarge ? 'FILE_TOO_LARGE' : 'INVALID_UPLOAD',
        message: tooLarge ? '外部单据文件不能超过 20 MiB。' : '请上传单个 PDF、PNG、JPG/JPEG 或 WEBP 文件。',
      });
    });
  }, async (req: Request, res: Response) => {
    try {
      if (!req.file) throw businessError('VALIDATION_FAILED', '请选择外部单据文件。');
      const uploadRoot = process.env.BAMBOOK_UPLOAD_DIR || path.join(__dirname, '../../../uploads');
      const archive = await archiveExternalTradeDocumentFile(prisma, {
        documentId: req.params.id,
        actorId: actorOf(req),
        file: { buffer: req.file.buffer, originalName: req.file.originalname, size: req.file.size },
        uploadRoot,
      });
      onDataChange?.({ entity: 'TradeDocument', action: 'external_archive', ids: [req.params.id] });
      res.status(201).json({ ok: true, documentId: req.params.id, archive });
    } catch (e: any) {
      logger.error('[CustomsRoute] POST external trade-document archive failed', { error: e?.message });
      const safe = safeRouteError(e, { fallbackCode: 'EXTERNAL_DOCUMENT_ARCHIVE_FAILED', fallbackMessage: '外部单据归档失败，请核对后重试。' });
      res.status(safe.status).json({ error: safe.code, message: safe.message });
    }
  });

  // 单据归档文件下载（安全收口：uploads/trade-documents 子树已从 /api/uploads 静态服务
  // 排除（index.ts fail-closed 404），商业发票/箱单/提单等归档 PDF 只能经本端点读取。
  // 与 email 附件下载同模式：requirePermission('customs:read')——所有业务角色默认持有
  // （矩阵 SALES/SM/FINANCE/ADMIN/QC/LOGISTICS 全列 customs:read），单据中心/各域
  // generate-document 的浏览器下载链路不受影响）。路径解析 isInsideDir 防目录穿越。
  router.get('/trade-documents/:id/download', requirePermission('customs:read'), async (req: Request, res: Response) => {
    let nativeQc = false;
    try {
      const doc = await prisma.tradeDocument.findFirst({ where: { id: req.params.id, deletedAt: null } });
      if (!doc) return res.status(404).json({ error: `贸易单据 ${req.params.id} 不存在` });
      if (isSupplierContractDocumentCandidate(doc)) {
        const archive = await readSupplierContractArchive(prisma, { documentId: doc.id, actor: ciActor(req), version: selectedVersion(req.query.version) });
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(archive.proof.fileName)}`);
        res.setHeader('Content-Type', 'application/pdf'); return res.send(archive.bytes);
      }
      if (isExternalCustomsTradeDocument(doc)) {
        const version = selectedVersion(req.query.version);
        const uploadRoot = process.env.BAMBOOK_UPLOAD_DIR || path.join(__dirname, '../../../uploads');
        const archive = await readExternalTradeDocumentArchive(prisma, { documentId: doc.id, ...(version !== undefined ? { version } : {}), uploadRoot });
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(archive.archive.fileName)}`);
        res.setHeader('Content-Type', archive.archive.mimeType);
        return res.send(archive.bytes);
      }
      if (await markPackingList(req, doc) || await markPackingListArchive(req, doc)) {
        const archive = await readPackingListArchive(prisma, { documentId: doc.id, version: selectedVersion(req.query.version), trustedActor: ciActor(req) });
        if (!archive) throw businessError('NOT_FOUND', '所选装箱单版本尚未归档。');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(archive.proof.fileName)}`);
        res.setHeader('Content-Type', 'application/pdf'); return res.send(archive.bytes);
      }
      nativeQc = isQcReportDocumentCandidate(doc);
      await assertQcTradeDocumentArchive(prisma, doc, nativeQcActor(req));
      const nativeCi = await ciArchiveCandidate(doc);
      if (nativeCi) await assertCiTradeDocumentArchive(prisma, doc, ciActor(req));
      if (!doc.filePath) return res.status(404).json({ error: '该单据尚未生成归档文件' });

      const uploadRoot = process.env.BAMBOOK_UPLOAD_DIR || path.join(__dirname, '../../../uploads');
      const absPath = path.resolve(uploadRoot, doc.filePath);
      if (!isInsideDir(path.resolve(uploadRoot, 'trade-documents'), absPath)) {
        logger.error('[CustomsRoute] trade-document download path escaped subtree (rejected)', { id: doc.id, filePath: doc.filePath });
        return res.status(404).json({ error: '归档路径非法' });
      }
      if (!fs.existsSync(absPath)) return res.status(404).json({ error: '归档文件缺失（可重新生成）' });

      if (nativeCi) {
        if (!isInsideDir(fs.realpathSync(path.resolve(uploadRoot, 'trade-documents')), fs.realpathSync(absPath))) throw businessError('CONFLICT', '归档文件路径不属于原单据目录。');
        const bytes = fs.readFileSync(absPath); await ciBytes(req, doc, bytes);
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(doc.fileName || `${doc.documentNumber}.pdf`)}`);
        res.setHeader('Content-Type', 'application/pdf'); return res.send(bytes);
      }
      const safeFilename = encodeURIComponent(doc.fileName || `${doc.documentNumber}.pdf`);
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${safeFilename}`);
      res.setHeader('Content-Type', 'application/pdf');
      res.sendFile(absPath);
    } catch (e: any) {
      if (packingListRequests.has(req) || isPackingListFailure(e) || req.body?.type === 'PackingList' || req.body?.kind === 'MERGED_PL') return plFailure(res, e);
      if (nativeQc || e instanceof QcReportError) return nativeQcError(res, e);
      logger.error('[CustomsRoute] GET trade-documents download failed', { error: e?.message });
      res.status(statusFromError(e, 500)).json({ error: e?.message || 'failed to download trade-document file' });
    }
  });

  // 单据服务端预览（2026-08-22 B1 架构底座）：服务端模板类型（CI 财务回链 / PL 注册表）
  // 返回 screen 模式 A4 纸张画布 HTML（与 generate-file PDF 同源渲染，所见即所得）；
  // 其余类型（模板真源暂在前端）返回 501——前端走本地渲染器
  router.get('/trade-documents/:id/preview.html', async (req: Request, res: Response) => {
    let nativeQc = false;
    try {
      const doc = await prisma.tradeDocument.findFirst({ where: { id: req.params.id, deletedAt: null } });
      if (!doc) return res.status(404).json({ error: `贸易单据 ${req.params.id} 不存在` });
      if (isSupplierContractDocumentCandidate(doc)) {
        const html = await renderSupplierContractTradeDocument(prisma, { documentId: doc.id, actor: ciActor(req), version: selectedVersion(req.query.version) });
        res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.send(html);
      }
      if (isExternalCustomsTradeDocument(doc)) throw businessError('CONFLICT', '第三方单据只提供归档文件，不从订单数据预览或生成模板。');
      await markPackingList(req, doc);
      nativeQc = isQcReportDocumentCandidate(doc);
      const version = selectedVersion(req.query.version);
      const html = doc.type !== 'CommercialInvoice' && version !== undefined
        ? await renderHistoricalNonCiVersion(req, doc, version)
        : await renderTradeDocumentServerHtml(prisma, doc, { screen: true, ...(version !== undefined ? { version } : {}),
          ...(nativeQc ? { trustedActor: nativeQcActor(req) } : doc.type === 'CommercialInvoice' || packingListRequests.has(req) ? { trustedActor: ciActor(req) } : {}) });
      if (!html) return res.status(501).json({ error: 'SERVER_TEMPLATE_NOT_AVAILABLE', message: '该单据类型暂无服务端模板（前端本地渲染）' });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (e: any) {
      if (packingListRequests.has(req) || isPackingListFailure(e) || req.body?.type === 'PackingList' || req.body?.kind === 'MERGED_PL') return plFailure(res, e);
      if (nativeQc || e instanceof QcReportError) return nativeQcError(res, e);
      logger.error('[CustomsRoute] GET trade-documents preview.html failed', { error: e?.message });
      res.status(statusFromError(e, 500)).json({ error: e?.message || 'failed to preview trade-document' });
    }
  });

  // POST /trade-documents/batch-download — 多选单据 ZIP 打包下载（B4 批量操作）：
  // 已归档文件直读；filePath 缺失的单据现场生成（幂等覆盖）保证打包完整。
  router.post('/trade-documents/batch-download', batchDocumentAccess, async (req: Request, res: Response) => {
    let nativeQc = false;
    try {
      const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.filter((v: unknown) => typeof v === 'string' && v) : [];
      if (ids.length === 0) return res.status(400).json({ error: 'ids 必填（至少一个单据）' });

      // ★ 原写法 `(req as any).user?.userId || 'system'` —— `req.user` 在本仓**从未被赋值**
      //   （真源是 `req.actor`，见 auth/middleware.ts:40）⇒ 恒走兜底、真 actor 从不记录。
      const actorId = extractActorFromRequest(req)?.userId || 'system';
      // Pre-authorize every requested native QC source before generating any
      // files/ZIP. A mixed customs batch cannot borrow another report's access.
      for (const id of ids) {
        const doc = await prisma.tradeDocument.findFirst({ where: { id, deletedAt: null } });
        if (isSupplierContractDocumentCandidate(doc)) {
          await readSupplierContractArchive(prisma, { documentId: id, actor: ciActor(req), version: plBatchVersion(req, id) }); continue;
        }
        if (doc && isExternalCustomsTradeDocument(doc)) {
          const uploadRoot = process.env.BAMBOOK_UPLOAD_DIR || path.join(__dirname, '../../../uploads');
          await readExternalTradeDocumentArchive(prisma, { documentId: doc.id, uploadRoot });
          continue;
        }
        if (await markPackingList(req, doc) || await markPackingListArchive(req, doc)) {
          let fixed = plSelectedVersions.get(req); if (!fixed) { fixed = new Map(); plSelectedVersions.set(req, fixed); }
          if (!fixed.has(doc!.id)) fixed.set(doc!.id, await pinPackingListArchiveVersion(prisma, { documentId: doc!.id, version: plBatchVersion(req, doc!.id), trustedActor: ciActor(req) }));
          await readPackingListArchive(prisma, { documentId: doc!.id, version: fixed.get(doc!.id), trustedActor: ciActor(req), allowMissing: true }); continue;
        }
        if (doc?.filePath || (doc?.domain === 'qc' && !isNativeQcDocument(doc))) {
          await assertQcTradeDocumentArchive(prisma, doc, nativeQcActor(req));
        }
        if (doc && await ciArchiveCandidate(doc)) {
          if (doc.filePath) await assertCiTradeDocumentArchive(prisma, doc, ciActor(req));
          else if (isBusinessShipmentCi(doc)) await readBusinessShipmentCiVersion(prisma, doc.id, ciActor(req, true), { requiredScopes: ['customs:write'] });
          else { if (!doc.sourceInvoiceId) throw businessError('CONFLICT', '无原票的历史单据不能新生成文件。'); await readCiInvoiceSource(prisma, { trustedActor: ciActor(req, true), sourceInvoiceId: doc.sourceInvoiceId, mode: 'register', ...(doc.shipmentId ? { shipmentId: doc.shipmentId } : {}) }); }
        }
        if (!isQcReportDocumentCandidate(doc)) continue;
        nativeQc = true;
        if (doc!.filePath) await assertQcTradeDocumentArchive(prisma, doc, nativeQcActor(req));
        else await loadAuthorizedQcDocumentSource(prisma, nativeQcActor(req, true), doc, 'qc:write');
      }
      const ciArchives: Array<{ doc: any; bytes: Buffer }> = [];
      const plArchives: Array<{ id: string; archive: NonNullable<Awaited<ReturnType<typeof readPackingListArchive>>> }> = [];
      const supplierArchives: Array<{ id: string; proof: Awaited<ReturnType<typeof readSupplierContractArchive>>['proof'] }> = [];
      const zip = new JSZip();
      const usedNames = new Set<string>();
      const skipped: Array<{ id: string; reason: string }> = [];
      let packed = 0;

      for (const id of ids) {
        const doc = await prisma.tradeDocument.findFirst({ where: { id, deletedAt: null } });
        if (!doc) { skipped.push({ id, reason: '不存在' }); continue; }
        try {
          if (isSupplierContractDocumentCandidate(doc)) {
            const archive = await readSupplierContractArchive(prisma, { documentId: doc.id, actor: ciActor(req), version: plBatchVersion(req, doc.id) });
            let entryName = archive.proof.fileName, suffix = 2;
            while (usedNames.has(entryName)) entryName = archive.proof.fileName.replace(/(\.[^.]+)$/, `_${suffix++}$1`);
            usedNames.add(entryName); zip.file(entryName, archive.bytes); supplierArchives.push({ id: doc.id, proof: archive.proof }); packed++; continue;
          }
          if (isExternalCustomsTradeDocument(doc)) {
            const uploadRoot = process.env.BAMBOOK_UPLOAD_DIR || path.join(__dirname, '../../../uploads');
            const archive = await readExternalTradeDocumentArchive(prisma, { documentId: doc.id, uploadRoot });
            let entryName = archive.archive.fileName; let suffix = 2;
            while (usedNames.has(entryName)) entryName = archive.archive.fileName.replace(/(\.[^.]+)$/, `_${suffix++}$1`);
            usedNames.add(entryName); zip.file(entryName, archive.bytes); packed += 1; continue;
          }
          if (await markPackingList(req, doc) || await markPackingListArchive(req, doc)) {
            const version = plSelectedVersions.get(req)?.get(doc.id);
            if (version === undefined) throw businessError('CONFLICT', '装箱单原版本选择已失去，请重新核对。');
            let archive = await readPackingListArchive(prisma, { documentId: doc.id, version, trustedActor: ciActor(req), allowMissing: true });
            if (!archive) {
              if (plArchiveReads.has(req)) throw businessError('CONFLICT', '装箱单归档在读取时变化；本次只读打包不能新建文件。');
              await generateTradeDocumentFile(prisma, { id: doc.id, version, actorId, trustedActor: ciActor(req, true) });
              archive = await readPackingListArchive(prisma, { documentId: doc.id, version, trustedActor: ciActor(req) });
            }
            if (!archive) throw businessError('CONFLICT', '装箱单归档结果暂不可确认。');
            let entryName = archive.proof.fileName; let suffix = 2;
            while (usedNames.has(entryName)) entryName = archive.proof.fileName.replace(/(\.[^.]+)$/, `_${suffix++}$1`);
            usedNames.add(entryName); zip.file(entryName, archive.bytes); plArchives.push({ id: doc.id, archive }); packed += 1; continue;
          }
          // filePath 缺失 → 现场生成（服务端模板优先，幂等覆盖）；已有归档直读
          if (!doc.filePath) {
            if (ciArchiveReads.has(req)) throw businessError('CONFLICT', '归档文件在读取时变化；本次历史读取不能生成新文件。');
            await generateTradeDocumentFile(prisma, { id: doc.id, actorId,
              ...(isQcReportDocumentCandidate(doc) ? { trustedActor: nativeQcActor(req, true) } : doc.type === 'CommercialInvoice' ? { trustedActor: ciActor(req, true) } : {}) });
          }
          const fresh = await prisma.tradeDocument.findUnique({ where: { id: doc.id }, select: { id: true, domain: true, type: true, sourceRef: true, orderId: true, filePath: true, fileName: true } });
          if (fresh) await assertQcTradeDocumentArchive(prisma, fresh, nativeQcActor(req));
          if (!fresh?.filePath) { skipped.push({ id, reason: '生成失败' }); continue; }
          const absPath = path.join(process.env.BAMBOOK_UPLOAD_DIR || path.join(__dirname, '../../../uploads'), fresh.filePath);
          if (!fs.existsSync(absPath)) { skipped.push({ id, reason: '归档文件缺失' }); continue; }
          // zip 内文件名去重（同号多版本场景加序号后缀）
          let entryName = fresh.fileName || `${doc.documentNumber}.pdf`;
          let i = 2;
          while (usedNames.has(entryName)) entryName = entryName.replace(/(\.[^.]+)$/, `_${i++}$1`);
          usedNames.add(entryName);
          if (await ciArchiveCandidate(fresh)) {
            const archiveRoot = path.resolve(process.env.BAMBOOK_UPLOAD_DIR || path.join(__dirname, '../../../uploads'), 'trade-documents');
            if (!isInsideDir(fs.realpathSync(archiveRoot), fs.realpathSync(absPath))) throw businessError('CONFLICT', '归档文件路径不属于原单据目录。');
            const bytes = fs.readFileSync(absPath); await ciBytes(req, fresh, bytes); ciArchives.push({ doc: fresh, bytes }); zip.file(entryName, bytes);
          } else zip.file(entryName, fs.readFileSync(absPath));
          packed += 1;
        } catch (e: any) {
      if (packingListRequests.has(req) || isPackingListFailure(e) || req.body?.type === 'PackingList' || req.body?.kind === 'MERGED_PL') return plFailure(res, e);
          if (doc.type === 'CommercialInvoice' || isSupplierContractDocumentCandidate(doc) || isQcReportDocumentCandidate(doc) || e instanceof QcReportError) throw e;
          skipped.push({ id, reason: e?.message || '生成失败' });
        }
      }

      if (packed === 0) {
        return res.status(404).json({ error: `无文件可打包（${skipped.length} 条失败：${skipped.map(s => `${s.id}:${s.reason}`).join('；')}）` });
      }

      const buffer = await zip.generateAsync({ type: 'nodebuffer' });
      for (const entry of supplierArchives) {
        const final = await readSupplierContractArchive(prisma, { documentId: entry.id, actor: ciActor(req), version: 1 });
        if (documentSourceFingerprint(final.proof) !== documentSourceFingerprint(entry.proof)) throw businessError('CONFLICT', '采购或加工原件在打包期间变化。');
      }
      for (const archive of ciArchives) await ciBytes(req, archive.doc, archive.bytes);
      for (const entry of plArchives) await recheckPackingListArchive(prisma, { documentId: entry.id, version: entry.archive.version, trustedActor: ciActor(req) }, entry.archive);
      const today = todayLocalKey();
      const fileName = `trade-documents_${today}.zip`;
      const encoded = encodeURIComponent(fileName);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`);
      res.send(buffer);
      logger.info('[CustomsRoute] batch-download zip packed', { packed, skipped: skipped.length, ids: ids.length });
    } catch (e: any) {
      if (packingListRequests.has(req) || isPackingListFailure(e) || req.body?.type === 'PackingList' || req.body?.kind === 'MERGED_PL') return plFailure(res, e);
      if (nativeQc || e instanceof QcReportError) return nativeQcError(res, e);
      logger.error('[CustomsRoute] POST batch-download failed', { error: e?.message });
      res.status(statusFromError(e, 500)).json({ error: e?.message || 'failed to batch download trade-documents' });
    }
  });

  // POST /trade-documents/render-by-shipment — 按运单渲染我方出运单据。
  // 当前 MVP 只生成 CI / PL；第三方单据通过单据台账上传归档，不从订单数据自动伪制。
  // §10.7 复扫：装配数据含订单/客户/金额——挂 customs:read（所有业务角色默认持有，见 :601 同模式）
  router.post('/trade-documents/render-by-shipment', requirePermission('customs:read'), async (req: Request, res: Response) => {
    try {
      if (req.body?.kind === 'PL') { packingListRequests.add(req); packingListFileUnavailable(); }
      const { shipmentId, kind } = req.body ?? {};
      if (!shipmentId || typeof shipmentId !== 'string') return res.status(400).json({ error: 'shipmentId 必填' });
      if (!isShipmentDocKind(kind)) return res.status(400).json({ error: `非法单据类型: ${kind}` });
      if (kind !== 'CI' && kind !== 'PL') return res.status(400).json({ error: '当前 MVP 只生成商业发票和装箱单；外部方出具的文件请上传归档。' });
      const trustedActor = ciActor(req);
      if (kind === 'CI') {
        const sourceOptions = ciOptions(req);
        const html = await renderServerDocument(prisma, kind, null, { screen: true }, { id: '', type: 'CommercialInvoice', sourceRef: null, ...sourceOptions });
        if (!html) throw businessError('CONFLICT', '原发票没有可预览内容。');
        res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.send(html);
      }
      const result = await assembleDocumentSetData(prisma, shipmentId, { trustedActor, expectedSourceFingerprint: req.body?.expectedShipmentSourceFingerprint });
      if (!result.ok || !result.data) {
        return res.status(404).json({ error: (result.error as { message?: string } | undefined)?.message || '运单制单数据装配失败' });
      }
      const html = await renderServerDocument(prisma, kind, result.data);
      await assembleDocumentSetData(prisma, shipmentId, { trustedActor, expectedSourceFingerprint: result.data.source.fingerprint });
      if (!html) return res.status(500).json({ error: `单据 ${kind} 渲染失败` });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (e: any) {
      if (packingListRequests.has(req) || isPackingListFailure(e) || req.body?.type === 'PackingList' || req.body?.kind === 'MERGED_PL') return plFailure(res, e);
      logger.error('[CustomsRoute] POST render-by-shipment failed', { error: e?.message });
      res.status(statusFromError(e, 500)).json({ error: e?.message || 'failed to render shipment document' });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // B3 组合文档（多对一数据聚合：多运单合并 PL / 多报告合并 IR 汇总）
  // 批次 H3 起 MERGED_PL/CONTRACT 装配默认幂等登记 TradeDocument 台账（写库，
  // 登记失败 warn 不阻断输出）→ 两端点按同文件写端点口径挂 requireWrite + scope 写门；
  // MERGED_IR 不登记仍走同一端点级门禁（口径一致，不按 kind 分裂门禁）
  // ══════════════════════════════════════════════════════════════

  // POST /trade-documents/composite/preview.html — 组合文档 A4 预览（与生成 PDF 同源渲染）
  router.post('/trade-documents/composite/preview.html', requireWrite, requireCustomsWrite, async (req: Request, res: Response) => {
    try {
      const { kind, sourceIds } = req.body ?? {};
      if (!isCompositeDocKind(kind)) return res.status(400).json({ error: `非法组合文档类型: ${kind}` });
      const { kind: resolvedKind, data } = await assembleCompositeDocument(prisma, { kind, sourceIds }, { actorId: actorOf(req) });
      // §10.3-9 电子签：组合单据（合同）已签署时按签署人取章盖入签章位
      const sourceRef = buildCompositeSourceRef(resolvedKind, sourceIds);
      const docType = COMPOSITE_TRADE_DOC_TYPE[resolvedKind] ?? '';
      const signer = await resolveDocumentSignerByDoc(prisma, { type: docType, sourceRef });
      const html = await renderServerDocument(prisma, resolvedKind, data, { screen: true }, {
        id: '', type: docType, sourceRef, signer,
      });
      if (!html) return res.status(500).json({ error: '组合文档渲染失败' });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (e: any) {
      if (packingListRequests.has(req) || isPackingListFailure(e) || req.body?.type === 'PackingList' || req.body?.kind === 'MERGED_PL') return plFailure(res, e);
      logger.error('[CustomsRoute] POST composite preview.html failed', { error: e?.message });
      // B68-1（v2.46）：档位由服务层自带的 code/statusCode 决定，路由不再猜文本
      res.status(statusFromError(e, 500)).json({ error: e?.message || 'failed to preview composite document' });
    }
  });

  // POST /trade-documents/composite/generate.pdf — 组合文档生成 PDF（流式下载，PDF 不落盘归档；台账登记见上）
  router.post('/trade-documents/composite/generate.pdf', requireWrite, requireCustomsWrite, async (req: Request, res: Response) => {
    try {
      const { kind, sourceIds } = req.body ?? {};
      if (!isCompositeDocKind(kind)) return res.status(400).json({ error: `非法组合文档类型: ${kind}` });
      const { kind: resolvedKind, data } = await assembleCompositeDocument(prisma, { kind, sourceIds }, { actorId: actorOf(req) });
      // §10.3-9 电子签：同 preview——合同已签署时按签署人取章
      const sourceRef = buildCompositeSourceRef(resolvedKind, sourceIds);
      const docType = COMPOSITE_TRADE_DOC_TYPE[resolvedKind] ?? '';
      const signer = await resolveDocumentSignerByDoc(prisma, { type: docType, sourceRef });
      const html = await renderServerDocument(prisma, resolvedKind, data, {}, {
        id: '', type: docType, sourceRef, signer,
      });
      if (!html) return res.status(500).json({ error: '组合文档渲染失败' });
      const pdf = await renderHtmlToPdf(html, { format: 'A4' });
      const label = resolvedKind === 'MERGED_PL' ? 'Consolidated-Packing-List' : 'Consolidated-Inspection-Summary';
      const today = todayLocalKey();
      const fileName = `${label}_${today}.pdf`;
      const encoded = encodeURIComponent(fileName);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`);
      res.send(pdf.pdf);
    } catch (e: any) {
      if (packingListRequests.has(req) || isPackingListFailure(e) || req.body?.type === 'PackingList' || req.body?.kind === 'MERGED_PL') return plFailure(res, e);
      logger.error('[CustomsRoute] POST composite generate.pdf failed', { error: e?.message });
      // B68-1（v2.46）：同 preview —— 校验 400 / 目标不存在 404 / 装配故障 500 都由抛出方声明
      res.status(statusFromError(e, 500)).json({ error: e?.message || 'failed to generate composite document pdf' });
    }
  });

  // POST /trade-documents/composite/request-sign — 合同「提交签署」（§10.3-9 电子签）
  //   业务员在单据中心生成合并销售合同时提交签署 → DR-007 解析领导/老板 →
  //   审批中心「阅览并签署销售合同」→ 阅至文末点签字确认 → 一步完成盖章 + 批准。
  //   targetId = composite 回链（与台账登记 / 渲染解析同一把钥匙，保证章盖在同一份合同上）。
  router.post('/trade-documents/composite/request-sign', requireWrite, currentSignDocumentActor, requireCustomsWrite, async (req: Request, res: Response) => {
    try {
      const { kind, sourceIds: rawSourceIds } = req.body ?? {};
      const sourceIds = Array.isArray(rawSourceIds) ? rawSourceIds.map(id => typeof id === 'string' ? id.trim() : id) : rawSourceIds;
      if (kind !== 'CONTRACT') {
        return res.status(400).json({ error: '仅合并销售合同（CONTRACT）支持电子签提交' });
      }
      if (!Array.isArray(sourceIds) || sourceIds.length < 2 || sourceIds.some(id => typeof id !== 'string' || !id) || new Set(sourceIds).size !== sourceIds.length) {
        return res.status(400).json({ error: '合并合同至少需要 2 个不同的有效订单' });
      }
      await assertApprovalReviewSourceRead(prisma, { actionType: 'contract:sign', targetType: 'Contract', targetId: buildCompositeSourceRef('CONTRACT', sourceIds), payload: { sourceIds } }, extractActorFromRequest(req)!);
      const documentSnapshot = await buildApprovalSignDocumentSnapshot(prisma, { kind: 'Contract', sourceIds });
      const sourceRef = documentSnapshot.sourceRef;
      const approval = await approvalCreateService.createBusinessApproval({
        requesterId: actorOf(req),
        actionType: 'contract:sign',
        targetType: 'Contract',
        targetId: sourceRef,
        risk: 'medium',
        payload: { sourceIds: documentSnapshot.sourceIds, sourceRef, documentSnapshot },
      });
      return res.status(201).json({ ok: true, approvalId: approval.id, status: approval.status, sourceRef });
    } catch (e: any) {
      logger.error('[CustomsRoute] POST composite request-sign failed', { error: e?.message });
      // B68-1（v2.46）：DR-007 的 NO_REVIEWER_RESOLVED 已登记进 errorCodes（409）⇒ 第 2 档直接命中，
      //   不再靠 msg.includes 认码；其余按抛出方自带的码/档，兜底 500。
      return res.status(statusFromError(e, 500)).json({ error: 'SIGN_REQUEST_FAILED', message: String(e?.message || e) });
    }
  });

  router.post('/trade-documents', requireWrite, requireCustomsWrite, async (req: Request, res: Response) => {
    try {
      if (req.body?.type === 'PackingList') packingListRequests.add(req);
      const input = req.body as TradeDocumentInput;
      if (!input.type) {
        return res.status(400).json({ error: 'type is required（documentNumber 留空自动取号）' });
      }
      let item;
      if (input.type === 'CommercialInvoice') {
        if (Object.keys(req.body).some(key => !['type', 'shipmentId', 'sourceInvoiceId', 'expectedFingerprint', 'expectedSourceFingerprint', 'expectedShipmentSourceFingerprint'].includes(key))) throw businessError('CONFLICT', '商业发票只能引用原财务发票，不能手工复制内容。');
        const sourceOptions = ciOptions(req, true);
        item = await service.createTradeDocument({ type: input.type, ...(input.shipmentId ? { shipmentId: input.shipmentId } : {}) }, sourceOptions.trustedActor!.userId, sourceOptions);
      } else item = await service.createTradeDocument(input, actorOf(req));
      onDataChange?.({ entity: 'TradeDocument', action: 'create', ids: [item.id] });
      res.status(201).json({ item });
    } catch (e: any) {
      if (packingListRequests.has(req) || isPackingListFailure(e) || req.body?.type === 'PackingList' || req.body?.kind === 'MERGED_PL') return plFailure(res, e);
      logger.error('[CustomsRoute] POST trade-document failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to create trade-document' });
    }
  });

  router.put('/trade-documents/:id', requireWrite, requireCustomsWrite, async (req: Request, res: Response) => {
    try {
      const sourceDoc = await prisma.tradeDocument.findFirst({ where: { id: req.params.id, deletedAt: null } });
      await markPackingList(req, sourceDoc);
      rejectGenericSupplierDocumentWrite(sourceDoc);
      if (isBusinessShipmentCi(sourceDoc)) throw businessError('CONFLICT', '业务 CI 内容来自订单与实际装运快照；草稿请使用专用修订操作，不能直接改单据字段。');
      if (sourceDoc?.domain === 'qc') {
        await loadAuthorizedQcReportSource(prisma, nativeQcActor(req, true), sourceDoc.sourceRef!, 'qc:write');
        if (req.body?.type !== undefined && req.body.type !== 'InspectionReport') {
          throw new QcReportError('CONFLICT', '原生验货报告类型不可修改，请从业务来源重新生成。', 'source_changed');
        }
      }
      const input = req.body as Partial<TradeDocumentInput>;
      const item = await service.updateTradeDocument(req.params.id, input, actorOf(req));
      onDataChange?.({ entity: 'TradeDocument', action: 'update', ids: [item.id] });
      res.json({ item });
    } catch (e: any) {
      if (packingListRequests.has(req) || isPackingListFailure(e) || req.body?.type === 'PackingList' || req.body?.kind === 'MERGED_PL') return plFailure(res, e);
      if (e instanceof QcReportError) return nativeQcError(res, e);
      logger.error('[CustomsRoute] PUT trade-document failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to update trade-document' });
    }
  });

  router.delete('/trade-documents/:id', requireWrite, requireCustomsWrite, async (req: Request, res: Response) => {
    try {
      await markPackingList(req, await prisma.tradeDocument.findFirst({ where: { id: req.params.id, deletedAt: null } }));
      const result = await service.deleteTradeDocument(req.params.id, actorOf(req), { trustedActor: (req as any).actor ?? extractActorFromRequest(req), trustedAuthSource: (req as any).authSource });
      onDataChange?.({ entity: 'TradeDocument', action: 'delete', ids: [result.id] });
      res.json(result);
    } catch (e: any) {
      if (packingListRequests.has(req) || isPackingListFailure(e) || req.body?.type === 'PackingList' || req.body?.kind === 'MERGED_PL') return plFailure(res, e);
      logger.error('[CustomsRoute] DELETE trade-document failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to delete trade-document' });
    }
  });

  router.post('/trade-documents/:id/transition', requireWrite, requireCustomsWrite, async (req: Request, res: Response) => {
    try {
      const sourceDoc = await prisma.tradeDocument.findFirst({ where: { id: req.params.id, deletedAt: null } });
      await markPackingList(req, sourceDoc);
      if (isBusinessShipmentCi(sourceDoc)) throw businessError('CONFLICT', '业务 CI 只能通过出运模块的专用签发操作进入已签发状态。');
      const { toStatus } = req.body as { toStatus: TradeDocumentStatus };
      if (!toStatus || !VALID_DOC_STATUSES.includes(toStatus)) {
        return res.status(400).json({ error: `非法单据状态: ${toStatus}` });
      }
      const item = await service.transitionTradeDocumentStatus(req.params.id, toStatus, actorOf(req), { trustedActor: (req as any).actor ?? extractActorFromRequest(req), trustedAuthSource: (req as any).authSource });
      onDataChange?.({ entity: 'TradeDocument', action: 'transition', ids: [item.id] });
      res.json({ item });
    } catch (e: any) {
      if (packingListRequests.has(req) || isPackingListFailure(e) || req.body?.type === 'PackingList' || req.body?.kind === 'MERGED_PL') return plFailure(res, e);
      logger.error('[CustomsRoute] POST trade-document transition failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to transition trade-document' });
    }
  });

  // ─── 单据版本留痕（阶段 P3a，PRD 11.3 DocumentVersion）───

  router.get('/trade-documents/:id/versions', async (req: Request, res: Response) => {
    if (!authenticate(req, res)) return;
    try {
      const sourceDoc = await prisma.tradeDocument.findFirst({ where: { id: req.params.id, deletedAt: null } });
      if (await markPackingList(req, sourceDoc)) return res.json(await listPackingListVersions(prisma, req.params.id, ciActor(req)));
      await historyCi(req, sourceDoc);
      const result = await docTemplates.listVersions(req.params.id);
      if (sourceDoc?.type === 'CommercialInvoice') for (const version of (Array.isArray(result) ? result : result.items ?? [])) await historyCi(req, sourceDoc, version.version);
      res.json(result);
    } catch (e: any) {
      if (packingListRequests.has(req) || isPackingListFailure(e) || req.body?.type === 'PackingList' || req.body?.kind === 'MERGED_PL') return plFailure(res, e);
      logger.error('[CustomsRoute] GET trade-document versions failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to list document versions' });
    }
  });

  router.get('/trade-documents/:id/versions/:version', async (req: Request, res: Response) => {
    if (!authenticate(req, res)) return;
    try {
      const version = Number(req.params.version);
      if (!Number.isInteger(version) || version < 1) {
        return res.status(400).json({ error: '非法版本号' });
      }
      const sourceDoc = await prisma.tradeDocument.findFirst({ where: { id: req.params.id, deletedAt: null } });
      if (await markPackingList(req, sourceDoc)) { const selected = await readPackingListVersion(prisma, { documentId: req.params.id, version: selectedVersion(req.params.version)!, trustedActor: ciActor(req) });
        return res.json({ item: selected.item, protocol: selected.protocol, provenance: selected.provenance, warnings: selected.warnings }); }
      await historyCi(req, sourceDoc, selectedVersion(req.params.version));
      const item = await docTemplates.getVersion(req.params.id, version);
      res.json({ item });
    } catch (e: any) {
      if (packingListRequests.has(req) || isPackingListFailure(e) || req.body?.type === 'PackingList' || req.body?.kind === 'MERGED_PL') return plFailure(res, e);
      logger.error('[CustomsRoute] GET trade-document version failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to get document version' });
    }
  });

  router.post('/trade-documents/:id/versions', requireWrite, requireCustomsWrite, async (req: Request, res: Response) => {
    try {
      const sourceDoc = await prisma.tradeDocument.findFirst({ where: { id: req.params.id, deletedAt: null } });
      rejectGenericSupplierDocumentWrite(sourceDoc);
      await markPackingList(req, sourceDoc);
      if (sourceDoc?.type === 'CommercialInvoice') throw businessError('CONFLICT', '商业发票版本只由原财务发票产生，不能提交任意内容。');
      const item = await docTemplates.createVersion(req.params.id, req.body ?? {}, actorOf(req));
      onDataChange?.({ entity: 'TradeDocument', action: 'create_version', ids: [req.params.id] });
      res.status(201).json({ item });
    } catch (e: any) {
      if (packingListRequests.has(req) || isPackingListFailure(e) || req.body?.type === 'PackingList' || req.body?.kind === 'MERGED_PL') return plFailure(res, e);
      logger.error('[CustomsRoute] POST trade-document version failed', { error: e?.message });
      res.status(statusFromError(e)).json({ error: e?.message || 'failed to create document version' });
    }
  });

  // ════════════════════════════════════════════════════════════
  // Overview
  // ════════════════════════════════════════════════════════════

  router.get('/overview', async (req: Request, res: Response) => {
    if (!authenticate(req, res)) return;
    try {
      const overview = await service.getCustomsOverview();
      const documents = await listCiVisibleTradeDocuments(prisma, { limit: 0 }, ciActor(req));
      overview.tradeDocuments.total = documents.total;
      res.json(overview);
    } catch (e: any) {
      return plFailure(res, e);
    }
  });

  return router;
}
