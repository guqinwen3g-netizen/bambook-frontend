
import {createQuotationConversionCommandRouter} from '../orders/orderConversionCommandRoute';
/**
 * 报价管理 API — /api/v1/quotations
 *
 * 端点：
 *   GET    /              — 列表（支持 status/customer/date/search 过滤）
 *   GET    /:id           — 详情（含行明细）
 *   POST   /              — 创建报价单（Draft 状态）
 *   PUT    /:id           — 更新报价单（仅 Draft）
 *   DELETE /:id           — 软删除报价单（仅 Draft）
 *   POST   /:id/send      — 发送报价单（Draft → Sent + 发布 QuotationIssued 事件）
 *   POST   /:id/accept    — 接受报价单（Sent → Accepted + 发布 QuotationAccepted 事件）
 *   POST   /:id/reject    — 拒绝报价单（Sent → Rejected）
 *   POST   /:id/expire    — 标记过期（Draft/Sent → Expired）
 *
 * 鉴权：统一 createModuleAuthGuard（JWT 或 API-Key）；写操作必须 JWT（requireJwtForWrite，API-Key 不足）
 *       ＋ requirePermission('quotations:write') scope 授权门（W-C 批三-E 族B 收口；
 *       持有面 = SALES/SALES_MANAGER＋SuperAdmin 特判，见 _shared/rolePermissionMatrix）；
 *       读操作挂 quotations:read scope 门（R678 收口，S3-γ CRM 同惯例：JWT 登录用户必须持 scope；
 *       无 actor 的 API-Key/dev 通道走旧口径放行——认证已由 moduleGuard 把关，
 *       moduleApiKeyHeader 契约：API-Key 读不得 401）
 * 审计：所有 mutation 写入 AuditLog（字段级审计）
 */

import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { extractActorFromRequest, pickRequestToken } from '../auth/middleware';
import { createAuthService, type TokenPayload } from '../auth/service';
import { businessError } from '../shared/errorCodes';
import { isInsideDir } from '../lib/privateFiles';
import { actorIdFromRequest, writeRouteAuditLog } from '../audit/routeAudit';
import { logger } from '../lib/logger';
import { safeRouteError } from '../shared/routeError';
import { statusFromError } from '../shared/bizStatus';
import { createQuotationService, CreateQuotationInput, UpdateQuotationInput } from './quotationService';
import { currentQuotationRouteActor, quotationRouteReadScope, assertQuotationRouteRead,
  assertQuotationRouteWrite, assertQuotationRouteCustomer, quotationScopedReadClient } from './quotationRouteAccess';
import { assertOrderConversionCustomerRead } from '../orders/orderConversionReadAuthority';
import { createQuotationImportService, HistoricalQuotationRow } from './quotationImportService';
import { createQuotationApprovalService } from './quotationApproval';
import { createApprovalRoutingService } from '../approvals/approvalRoutingService';
import { createApprovalCreateService } from '../approvals/approvalCreateService';
import { renderServerDocument } from '../templates/docTemplates/registry';
import { loadQuotationDocData, assembleQuotationVersionDocData } from '../templates/docTemplates/quotation';
import { buildXlsx, xlsxDownloadHeaders, type XlsxSheet } from '../templates/xlsxExport';
import { upsertDomainTradeDocument, generateTradeDocumentFile } from '../customs/tradeDocumentLifecycleService';
import { resolveDocumentSigner } from '../seal/documentSigner';
import { todayLocalKey } from '../shared/localDate';


/**
 * convertToOrder still has a few legacy business errors without statusCode.
 * Adapt only its exact rejection templates; unknown errors (including native
 * TypeError/Prisma errors) must go through safeRouteError as server failures.
 */
/** Read the actual signature, before a global snapshot guard's DB hydration. */
function originalQuotationActor(req:Request):TokenPayload {
  let actor:TokenPayload;
  try{actor=createAuthService().verifyToken(pickRequestToken(req));}catch{throw businessError('UNAUTHORIZED','请登录后核对报价转单。');}
  if(!actor?.userId||(actor as any).kind==='customer'||!Array.isArray(actor.roles)||actor.userId!==(req as any).actor?.userId)throw businessError('UNAUTHORIZED','原凭据与当前主体不一致。');
  return actor;
}
function conversionRouteError(error: unknown, quotationId: string): unknown {
  if (!(error instanceof Error) || error.constructor !== Error) return error;
  const legacy = error as Error & { code?: string; statusCode?: number; approvalRequestId?: string };
  if (typeof legacy.code === 'string' && typeof legacy.statusCode === 'number') return error;
  if (legacy.code === 'QUOTATION_APPROVAL_PENDING' && legacy.approvalRequestId
      && legacy.message.endsWith('，需审批通过后方可转换订单（门禁：quotation-approval）')) {
    return Object.assign(new Error(legacy.message), { code: legacy.code, statusCode: 400 });
  }
  if (legacy.code !== undefined || legacy.statusCode !== undefined) return error;

  const prefix = `报价单 ${quotationId}`;
  let statusCode: number | undefined;
  if (legacy.message === `${prefix} 不存在`) {
    statusCode = 404;
  } else if ((legacy.message.startsWith(`${prefix} 状态为 `)
      && legacy.message.endsWith('，仅 Accepted 可转为订单'))
      || (legacy.message.startsWith(`${prefix} 已转为订单 `)
        && legacy.message.endsWith('，不可重复转换'))
      // The failed transaction claim uses quotationNumber instead of its id.
      || /^报价单 [^\r\n]+ 已转为订单，不可重复转换$/.test(legacy.message)) {
    statusCode = 409;
  } else if (/^报价单 [^\r\n]+ 存在低于 MOQ 的行（行 \d+ 数量 [0-9.eE+-]+ < MOQ [0-9.eE+-]+，缺口 [0-9.eE+-]+%）且无有效 MOQ 豁免审批（门禁：moq-exemption），转换中止$/.test(legacy.message)) {
    statusCode = 400;
  }
  return statusCode === undefined ? error : Object.assign(new Error(legacy.message), {
    code: 'QUOTATION_CONVERSION_REJECTED', statusCode,
  });
}

/** 报价状态 → 台账中文标签（与 QuotationManager 展示口径一致） */
const QUOTATION_STATUS_LABEL: Record<string, string> = {
  Draft: '草稿', Sent: '已发客户', Accepted: '客户已接受', Rejected: '客户已拒绝', Expired: '已过期',
};

export interface QuotationRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
  /** 上传根目录（index.ts UPLOAD_DIR；行图片落 quotations/ 子目录） */
  uploadDir?: string;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
}

export function createQuotationRouter(options: QuotationRouterOptions): Router {
  const router = Router();
  const { prisma, requireAuth, apiKeys, onDataChange } = options;
  const service = createQuotationService(prisma);
  const importService = createQuotationImportService(prisma);

  // ── 报价审批层级服务（DR：复用 ApprovalRequest 平台；条目级 + 总价合并规则） ──
  const approvalCreateService = createApprovalCreateService({
    prisma,
    routingService: createApprovalRoutingService({ prisma }),
  });
  const approvalService = createQuotationApprovalService({ prisma, approvalCreateService });

  // ── 统一模块鉴权（JWT 或 API-Key；写操作另行要求 JWT + quotations:write scope） ──
  router.use(createModuleAuthGuard({ requireAuth, apiKeys }));
  router.use(createQuotationConversionCommandRouter({prisma,onDataChange}));
  const requireWrite = requireJwtForWrite({ requireAuth, apiKeys });
  const requireQuotationWrite = requirePermission('quotations:write');

  // ── R678 读端点 scope 门（S3-γ CRM 同惯例）：JWT 登录用户必须持 quotations:read；
  //    无 actor（API-Key / dev 模式）调用走旧口径放行——认证已由 moduleGuard 把关，
  //    moduleApiKeyHeader 契约：API-Key 读不得 401 ──
  const requireQuotationReadScope = requirePermission('quotations:read');
  const requireQuotationRead = (req: Request, res: Response, next: NextFunction) => {
    const actor = (req as any).actor ?? extractActorFromRequest(req);
    if (!actor?.userId) return next();
    (req as any).actor = actor;
    return requireQuotationReadScope(req, res, next);
  };

  const currentActor = async (req: Request, write: boolean) => {
    const prior = (req as any).actor ?? extractActorFromRequest(req);
    // Preserve authenticated, unbound API-key/dev read compatibility. Writes
    // already require a JWT through requireWrite and never take this branch.
    if (!prior?.userId) {
      if (write) throw businessError('UNAUTHORIZED', '请登录后处理报价。');
      return null;
    }
    const credential = (req as any).authSource === 'api-key' ? prior : originalQuotationActor(req);
    const actor = await currentQuotationRouteActor(prisma, credential, write);
    (req as any).actor = actor;
    return actor;
  };
  const objectAccess = (write: boolean) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actor = await currentActor(req, write);
      if (actor) {
        const quotation = write ? await assertQuotationRouteWrite(prisma, actor, req.params.id)
          : await assertQuotationRouteRead(prisma, actor, req.params.id);
        if (write && req.method === 'PUT') {
          // updateQuotation currently retains a null customer patch. Every
          // actual new customer binding must be writable as well as the source.
          await assertQuotationRouteCustomer(prisma, actor, req.body?.customerRelationId, quotation.ownerId ?? actor.userId);
        }
      } else {
        const quotation = await prisma.quotation.findUnique({ where: { id: req.params.id } });
        if (!quotation || quotation.deletedAt != null) throw businessError('NOT_FOUND', '报价单不存在。');
      }
      next();
    } catch (error) {
      const safe = safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '报价权限暂时无法核验，请稍后重试。' });
      res.status(safe.status).json({ error: safe.code, message: safe.message });
    }
  };
  const requireObjectRead = objectAccess(false), requireObjectWrite = objectAccess(true);

  // ── REQ2-12 报价行图片上传（DR-053：multer 落盘 quotations/，URL 由前端随行 imageUrl 提交） ──
  const quotationsUploadDir = () => path.join(options.uploadDir ?? path.join(process.cwd(), 'uploads'), 'quotations');
  const lineImageUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, file, cb) => {
        fs.mkdirSync(quotationsUploadDir(), { recursive: true });
        cb(null, quotationsUploadDir());
      },
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname) || '.jpg';
        cb(null, `qt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
      },
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
      else cb(new Error('仅支持 jpeg/png/webp/gif 图片'));
    },
  });

  // POST /line-image — 上传面料照片/色卡图 → { url }（行级 imageUrl 提交时携带）。
  // P0-3 安全收口：/api/uploads/quotations 静态子树已 fail-closed 404，返回 scoped 下载端点 URL
  //（前端 <img> 同源带 cookie / Bearer 读取，需 quotations:read）。
  router.post('/line-image', requireWrite, requireQuotationWrite, lineImageUpload.single('file'), (req: Request, res: Response) => {
    const f = req.file;
    if (!f) return res.status(400).json({ error: { code: 'NO_FILE', message: '未提供图片文件' } });
    const url = `/api/v1/quotations/line-image/${encodeURIComponent(f.filename)}`;
    logger.info('[QuotationRoute] line image uploaded', { url, size: f.size, actor: actorIdFromRequest(req) });
    res.status(201).json({ ok: true, url });
  });

  // GET /line-image/:filename — 报价行图片下载（P0-3 安全收口：静态直读已 404，读取统一收敛到
  // 本端点，quotations:read scope 门 + basename/isInsideDir 防穿越）。
  router.get('/line-image/:filename', requireQuotationRead, (req: Request, res: Response) => {
    try {
      const filename = path.basename(String(req.params.filename || ''));
      if (!filename || filename === '.' || filename === '..') {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: '图片不存在' } });
      }
      const dir = path.resolve(quotationsUploadDir());
      const abs = path.resolve(dir, filename);
      if (!isInsideDir(dir, abs) || !fs.existsSync(abs)) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: '图片不存在' } });
      }
      res.sendFile(abs);
    } catch (e: any) {
      logger.error('[QuotationRoute] line image download failed', { error: e?.message });
      res.status(500).json({ error: { code: 'INTERNAL', message: 'failed to load image' } });
    }
  });

  // ── GET / — 列表（format=xlsx → 全量台账 Excel 导出） ──
  router.get('/', requireQuotationRead, async (req: Request, res: Response) => {
    try {
      const { status, customerRelationId, dateFrom, dateTo, search, limit, offset } = req.query;
      const exportAll = req.query.format === 'xlsx';
      // P2 行级数据范围（对齐 orders buildOrderListScopeWhere 口径；无 actor 的 API-Key/dev 读走旧口径放行）
      const scopeWhere = await quotationRouteReadScope(prisma, await currentActor(req, false));
      const result = await service.listQuotations({
        status: status as string | undefined,
        customerRelationId: customerRelationId as string | undefined,
        dateFrom: dateFrom as string | undefined,
        dateTo: dateTo as string | undefined,
        search: search as string | undefined,
        limit: exportAll || !limit ? undefined : parseInt(limit as string, 10),
        offset: exportAll || !offset ? undefined : parseInt(offset as string, 10),
        ...(exportAll ? { exportAll: true } : {}),
        scopeWhere,
      });
      if (exportAll) {
        const sheet: XlsxSheet = {
          name: '报价台账',
          columnLabels: ['报价号', '客户', '状态', '币种', '金额', '版本', '报价日期', '有效期至', '业务员'],
          columns: ['quotationNumber', 'customerName', 'status', 'currency', 'totalAmount', 'version', 'issueDate', 'validUntil', 'salesperson'],
          rows: result.items.map(q => ({
            quotationNumber: q.quotationNumber,
            customerName: q.customerName,
            status: QUOTATION_STATUS_LABEL[q.status] ?? q.status,
            currency: q.currency,
            totalAmount: q.totalAmount != null ? Number(q.totalAmount) : null,
            version: q.version,
            issueDate: q.issueDate,
            validUntil: q.validUntil,
            salesperson: q.salesperson,
          })),
        };
        const today = todayLocalKey();
        res.set(xlsxDownloadHeaders(`报价台账_${today}.xlsx`)).send(buildXlsx([sheet]));
        return;
      }
      res.json(result);
    } catch (e: any) {
      logger.error('[QuotationRoute] GET list failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to list quotations' });
    }
  });

  // ── REQ2-19（DR-060-②）：GET /price-profile?relationId= — 客户砍价画像 ──
  // 字面路由：必须在参数路由 GET /:id 之前注册（否则被当作 id 吞掉）
  router.get('/price-profile', requireQuotationRead, async (req: Request, res: Response) => {
    try {
      const relationId = typeof req.query.relationId === 'string' ? req.query.relationId : '';
      if (!relationId) {
        return res.status(400).json({ error: 'relationId 必填（客户砍价画像按客户维度聚合）' });
      }
      const actor = await currentActor(req, false);
      if (actor) await assertOrderConversionCustomerRead(prisma, actor, relationId, null);
      const profile = await service.getPriceProfile(relationId);
      res.json(profile);
    } catch (e: any) {
      logger.error('[QuotationRoute] GET price-profile failed', { error: e?.message });
      const safe = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '客户报价画像暂时无法读取。' });
      res.status(safe.status).json({ error: safe.code, message: safe.message });
    }
  });

  // ── GET /by-target — 报价反查（G1-3：按开发案/订单/条目查关联报价，product/order 维可见） ──
  router.get('/by-target', requireQuotationRead, async (req: Request, res: Response) => {
    try {
      const { developmentCaseId, orderId, orderLineId } = req.query;
      const actor = await currentActor(req, false);
      const scope = await quotationRouteReadScope(prisma, actor);
      const scopedService = createQuotationService(quotationScopedReadClient(prisma, scope));
      const result = await scopedService.listQuotationsByTarget({
        developmentCaseId: typeof developmentCaseId === 'string' ? developmentCaseId : undefined,
        orderId: typeof orderId === 'string' ? orderId : undefined,
        orderLineId: typeof orderLineId === 'string' ? orderLineId : undefined,
      });
      return res.json({ ok: true, data: result });
    } catch (e: any) {
      logger.error('[quotation] GET /by-target 列表查询失败', { error: e?.message ?? String(e), query: req.query });
      const safe = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '报价单列表加载失败；请稍后重试，持续失败请联系管理员查看服务日志。' });
      return res.status(safe.status).json({ error: { code: safe.code, message: safe.message } });
    }
  });

  // ── GET /:id — 详情 ──
  router.get('/:id', requireQuotationRead, requireObjectRead, async (req: Request, res: Response) => {
    try {
      const quotation = await service.getQuotation(req.params.id);
      if (!quotation) {
        return res.status(404).json({ error: '报价单不存在' });
      }
      res.json({ quotation });
    } catch (e: any) {
      logger.error('[QuotationRoute] GET detail failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to get quotation' });
    }
  });

  // ── GET /:id/preview.html — 报价单服务端模板预览（B7：实时装配渲染，与生成 PDF
  //    同源排版——所见即所得，无需先登记文档；前端 buildQuotationPrintHtml 同构退役） ──
  router.get('/:id/preview.html', requireQuotationRead, requireObjectRead, async (req: Request, res: Response) => {
    try {
      const data = await loadQuotationDocData(prisma, req.params.id);
      if (!data) return res.status(404).json({ error: '报价单不存在' });
      // §10.3-9：报价已批准（quotation:total_approve 等）→ 按审批人取章盖入签名区
      const signer = await resolveDocumentSigner(prisma, { targetType: 'Quotation', targetId: req.params.id });
      const html = await renderServerDocument(prisma, 'QUOT', data, { screen: true }, {
        id: req.params.id, type: 'Quotation', sourceRef: req.params.id, signer,
      });
      if (!html) return res.status(500).json({ error: 'QUOT 模板渲染失败' });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (e: any) {
      logger.error('[QuotationRoute] GET preview.html failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to preview quotation' });
    }
  });

  router.get('/:id/versions/:version/preview.html', requireQuotationRead, requireObjectRead, async (req: Request, res: Response) => {
    try {
      const number = Number(req.params.version);
      if(!Number.isSafeInteger(number) || number < 1) return res.status(400).json({error:'版本号无效'});
      const version = await prisma.quotationVersion.findFirst({where:{quotationId:req.params.id,version:number}});
      if(!version) return res.status(404).json({error:'报价版本不存在'});
      const data = assembleQuotationVersionDocData(version);
      const html = await renderServerDocument(prisma,'QUOT',data,{screen:true},{id:version.id,type:'Quotation',sourceRef:req.params.id});
      if(!html) throw new Error('历史报价模板渲染失败');
      res.type('html').send(html);
    } catch(e:any) { res.status(409).json({error:e?.message || '历史报价预览失败'}); }
  });

  // ── POST /:id/generate-document — 登记域单据 + 服务端渲染 PDF 落盘归档（B7）
  //    幂等：domain+type+sourceRef 唯一定位；重复生成刷新头字段并覆盖 PDF（真源实时渲染） ──
  router.post('/:id/generate-document', requireWrite, requireQuotationWrite, requireObjectWrite, async (req: Request, res: Response) => {
    try {
      const actorId = actorIdFromRequest(req);
      const qt = await prisma.quotation.findFirst({ where: { id: req.params.id, deletedAt: null } });
      if (!qt) return res.status(404).json({ error: '报价单不存在' });

      const reg = await upsertDomainTradeDocument(prisma, {
        domain: 'quotation',
        type: 'Quotation',
        sourceRef: qt.id,
        documentNumber: qt.quotationNumber, // 文档号=业务单号裁决（与 PO/CI 财务回链同语义）
        relationId: qt.customerRelationId,
        totalAmount: qt.totalAmount != null ? Number(qt.totalAmount) : null,
        currency: qt.currency,
        issueDate: qt.issueDate,
        actorId,
      });
      const file = await generateTradeDocumentFile(prisma, { id: reg.documentId, actorId });
      res.json({ document: reg, file });
    } catch (e: any) {
      logger.error('[QuotationRoute] POST generate-document failed', { error: e?.message });
      const status = e?.message?.includes('不存在') ? 404 : 500;
      res.status(status).json({ error: e?.message || 'failed to generate quotation document' });
    }
  });

  // ── POST / — 创建 ──
  router.post('/', requireWrite, requireQuotationWrite, async (req: Request, res: Response) => {
    try {
      const input = req.body as CreateQuotationInput;

      // 基本校验
      if (!input.currency) {
        return res.status(400).json({ error: '缺少必填字段：currency' });
      }
      if (!input.lines || input.lines.length === 0) {
        return res.status(400).json({ error: '至少需要一行报价明细' });
      }
      for (const line of input.lines) {
        if (!line.description || !line.unit || line.quantity == null || line.unitPrice == null) {
          return res.status(400).json({ error: '报价行缺少必填字段：description / unit / quantity / unitPrice' });
        }
      }

      const actor = await currentActor(req, true);
      await assertQuotationRouteCustomer(prisma, actor!, input.customerRelationId, actor!.userId);

      // 检查报价号唯一性（仅在传入报价号时检查；未传入时由服务端自动生成 QT-YYYY-NNNN）
      if (input.quotationNumber) {
        const existing = await prisma.quotation.findUnique({ where: { quotationNumber: input.quotationNumber } });
        if (existing) {
          return res.status(409).json({ error: `报价号 ${input.quotationNumber} 已存在` });
        }
      }

      const quotation = await service.createQuotation(input, actor?.userId || 'system');

      onDataChange?.({ entity: 'Quotation', action: 'create', ids: [quotation.id] });

      res.status(201).json({ quotation });
    } catch (e: any) {
      logger.error('[QuotationRoute] POST create failed', { error: e?.message });
      // P1-3 专属面料阻断等业务冲突 → 透传 statusCode（默认 500）
      res.status(e?.statusCode ?? 500).json({ error: e?.message || 'failed to create quotation' });
    }
  });

  // ── POST /import — 历史报价导入（阶段 P3c，PRD 16.1；mode=preview 只校验，mode=commit 导入合法行）──
  // 注意：须注册在 /:id 之前，避免 'import' 被 :id 捕获
  router.post('/import', requireWrite, requireQuotationWrite, async (req: Request, res: Response) => {
    try {
      const rows = req.body?.rows as HistoricalQuotationRow[];
      const mode = req.body?.mode === 'commit' ? 'commit' : 'preview';
      if (!Array.isArray(rows)) {
        return res.status(400).json({ error: 'rows 须为数组' });
      }
      const actor = await currentActor(req, true);
      // Imports resolve a real customer by name. Check all matching objects
      // before preview/commit so a name cannot bypass customer write authority.
      const names = [...new Set(rows.map(row => String(row?.customerName ?? '').trim()).filter(Boolean))];
      if (names.length) {
        const customers = await prisma.relation.findMany({ where: { deletedAt: null, name: { in: names } }, select: { id: true } });
        for (const customer of customers) await assertQuotationRouteCustomer(prisma, actor!, customer.id, actor!.userId);
      }
      const result = await importService.importHistoricalQuotations(rows, mode, actor?.userId || 'system');
      if (mode === 'commit' && result.created > 0) {
        onDataChange?.({ entity: 'Quotation', action: 'import', ids: [] });
      }
      res.json(result);
    } catch (e: any) {
      logger.error('[QuotationRoute] POST import failed', { error: e?.message });
      const msg = e?.message || '';
      res.status(e?.statusCode ?? (msg.includes('为空') || msg.includes('不可超过') || msg.includes('数组') ? 400 : 500))
        .json({ error: msg || 'failed to import quotations' });
    }
  });

  // ── PUT /:id — 更新（仅 Draft） ──
  router.put('/:id', requireWrite, requireQuotationWrite, requireObjectWrite, async (req: Request, res: Response) => {
    try {
      const actor = (req as any).actor;
      const input = req.body as UpdateQuotationInput;
      const quotation = await service.updateQuotation(req.params.id, input, actor?.userId || 'system');

      onDataChange?.({ entity: 'Quotation', action: 'update', ids: [quotation.id] });

      res.json({ quotation });
    } catch (e: any) {
      logger.error('[QuotationRoute] PUT update failed', { error: e?.message });
      // P1-3 专属面料阻断等显式 statusCode 优先；否则按既有语义映射
      const status = e?.statusCode ?? (e?.message?.includes('不存在') ? 404 : e?.message?.includes('仅 Draft') ? 409 : 400);
      res.status(status).json({ error: e?.message || 'failed to update quotation' });
    }
  });

  // ── DELETE /:id — 软删除（仅 Draft） ──
  router.delete('/:id', requireWrite, requireQuotationWrite, requireObjectWrite, async (req: Request, res: Response) => {
    try {
      const actor = (req as any).actor;
      await service.deleteQuotation(req.params.id, actor?.userId || 'system');

      onDataChange?.({ entity: 'Quotation', action: 'delete', ids: [req.params.id] });

      res.json({ ok: true });
    } catch (e: any) {
      logger.error('[QuotationRoute] DELETE failed', { error: e?.message });
      const status = e?.message?.includes('不存在') ? 404 : e?.message?.includes('仅 Draft') ? 409 : 400;
      res.status(status).json({ error: e?.message || 'failed to delete quotation' });
    }
  });

  // ── 报价审批层级：条目级申请 / 总价申请（含合并规则）/ 审批状态 ──
  // 条目级：业务员申请某条目报价审批（quotation:line_approve）
  router.post('/:id/lines/:lineId/request-approval', requireWrite, requireQuotationWrite, requireObjectWrite, async (req: Request, res: Response) => {
    try {
      const actorId = (req as any).actor?.userId ?? actorIdFromRequest(req);
      const result = await approvalService.requestLineApproval({
        quotationId: String(req.params.id),
        lineId: String(req.params.lineId),
        actorId,
      });
      await writeRouteAuditLog({
        prisma, actorId, source: 'route:quotation:approval', operation: 'request_quotation_line_approval',
        targetType: 'QuotationLine', targetId: String(req.params.lineId), after: { approvalId: result.approval.id },
        ip: req.ip || null,
      }).catch((e: any) => {
        // 审批单已创建成功：审计写失败不得把它伪装成 500（否则调用方重试会重复建单）。fail-open + 留痕。
        logger.error('[quotation] 行级审批审计写入失败（审批单已创建，须人工补录）', {
          quotationId: String(req.params.id), lineId: String(req.params.lineId), error: e?.message ?? String(e),
        });
      });
      return res.json({ ok: true, data: { approvalId: result.approval.id, lineId: result.line.id } });
    } catch (e: any) {
      if (e?.code === 'NOT_FOUND') return res.status(404).json({ error: { code: 'NOT_FOUND', message: e.message } });
      logger.error('[quotation] POST /:id/lines/:lineId/request-approval 失败（审批单是否已建不可从本行判断）', { error: e?.message ?? String(e), quotationId: String(req.params.id), lineId: String(req.params.lineId) });
      // ★ 档位这一半**已走真尺**（v3.06 修 B124 ①）：`statusFromError` 第 2 档按 `e.code` 查注册表
      //   ⇒ `NO_REVIEWER_RESOLVED` 从「500＝服务端故障」改判 **409**（`errorCodes.ts:157`）。
      //   ⚠️ 说清楚"用户看到什么变了"（v3.06 复核 BLOCKER-1 纠正了我第一版的过度声明）：
      //     **只有状态码变了**。屏上那句话改前改后**逐字相同**，都是裸原文 `NO_REVIEWER_RESOLVED: 申请人 …
      //     解析不到任何审批人 — …`（因为它本来就含"解析不到任何审批人"，用户一直看得到）；
      //     注册表里那句更友好的"未能为这次操作解析出审批人，请先…"**今天仍然不可达**（＝B123，未修）。
      //     ⇒ 所以本批的收益是"调用方终于能按 409 分支处理/重试策略"，不是"文案变好了"。
      //   ⚠️ 兜底**必须显式写 500**：真尺默认兜底是 400，直接 `statusFromError(e)` 会把数据库故障答成用户错
      //     （`quotationApprovalAuditFailOpen.test.ts` 那条"审批服务失败仍 500"的对照例正是这条的守卫）。
      //   ⚠️ 换道的**一般后果**（v3.06 复核 IMPORTANT-2 指出我第一版把它说成"只动一枚码"是不准确的）：
      //     档位从此由真尺决定 ⇒ 任何带业务关键词的裸抛（消息含 不存在 / 已存在 / 不可 / 超过）
      //     都会从 500 变成 404/409。今天这条路上只有 `NO_REVIEWER_RESOLVED` 会命中
      //     （`APPROVAL_CREATE_FAILED` 没登记进注册表 ⇒ 第 2 档拿不到它；`NOT_FOUND` 在上面那行已被短路），
      //     但**"今天只中一枚" ≠ "改动本身只动一枚"** ⇒ 该一般后果由
      //     `quotationApprovalTierB124.test.ts` 的"关键词档"那一格钉住，不是留白。
      // ⚠️ 文案这一半**仍刻意不接真源**（B123 未修，别把两半混成一句"已收口"）：`noReviewerError()`
      //   （`approvalRoutingService.ts:63-68`）只挂 `err.code`、没有 `statusCode` ⇒ 真源的 `isBusinessError`
      //   （`shared/errorCodes.ts:233`）判它不是业务错，接 `safeRouteError` 会把可操作文案换成通用话，
      //   而前端 `services/apiService.ts:412` 把 `error.message` 原样上 toast ⇒ 用户从此不知道要去配审批人。
      //   ⇒ 本站原文仍上屏（B42/B22 账上仍在）。响应体 `code` 仍写 `APPROVAL_CREATE_FAILED`、**没跟着档位改**：
      //     那是对外契约的字符串（改它属于另一笔账），真实原因已由 `message` 原文带上。
      return res.status(statusFromError(e, 500)).json({ error: { code: 'APPROVAL_CREATE_FAILED', message: String(e?.message ?? e) } });
    }
  });

  // 总价：提交时按合并规则——全条已批→默认全批；有未批→连带审批并提示"仅剩此条"
  router.post('/:id/request-total-approval', requireWrite, requireQuotationWrite, requireObjectWrite, async (req: Request, res: Response) => {
    try {
      const actorId = (req as any).actor?.userId ?? actorIdFromRequest(req);
      const result = await approvalService.requestTotalApproval({ quotationId: String(req.params.id), actorId });
      await writeRouteAuditLog({
        prisma, actorId, source: 'route:quotation:approval', operation: result.autoApproved ? 'quotation_total_auto_approved' : 'request_quotation_total_approval',
        targetType: 'Quotation', targetId: String(req.params.id),
        after: { autoApproved: result.autoApproved, totalStatus: result.totalStatus, totalApprovalId: result.totalApproval?.id ?? null },
        ip: req.ip || null,
      }).catch((e: any) => {
        // 同条目级：总价审批单已创建/已自动批，审计失败不转 500，留痕补录。
        logger.error('[quotation] 总价审批审计写入失败（审批单已创建，须人工补录）', {
          quotationId: String(req.params.id), autoApproved: result.autoApproved, error: e?.message ?? String(e),
        });
      });
      return res.json({
        ok: true,
        data: {
          autoApproved: result.autoApproved,
          totalStatus: result.totalStatus,
          totalApprovalId: result.totalApproval?.id ?? null,
          lineStatuses: result.lineStatuses,
        },
      });
    } catch (e: any) {
      if (e?.code === 'NOT_FOUND') return res.status(404).json({ error: { code: 'NOT_FOUND', message: e.message } });
      logger.error('[quotation] POST /:id/request-total-approval 失败（是否已建/已自动批不可从本行判断）', { error: e?.message ?? String(e), quotationId: String(req.params.id) });
      // ★ 档位同条目级：已走真尺（v3.06 修 B124 ①）⇒ `NO_REVIEWER_RESOLVED` 判 409，兜底显式 500（默认 400 会把故障答成用户错）。
      // ⚠️ 文案这一半仍刻意不接真源（B123 未修）：`noReviewerError()` 只挂 `code` 无 `statusCode`
      //   ⇒ `isBusinessError` 判否，接 `safeRouteError` 会把可操作文案换成通用话，而前端把 message 原样上 toast。
      //   ⇒ 本站原文仍上屏（B42/B22 账上仍在）。响应体 `code` 仍写 `APPROVAL_CREATE_FAILED`、**没跟着档位改**：
      //     那是对外契约的字符串（改它属于另一笔账），真实原因已由 `message` 原文带上。
      return res.status(statusFromError(e, 500)).json({ error: { code: 'APPROVAL_CREATE_FAILED', message: String(e?.message ?? e) } });
    }
  });

  // 审批状态：报价单各条目审批态 + 总价态（含 auto-approved / not-submitted）
  router.get('/:id/approval-status', requireQuotationRead, requireObjectRead, async (req: Request, res: Response) => {
    try {
      const result = await approvalService.getApprovalStatus({ quotationId: String(req.params.id) });
      return res.json({ ok: true, data: result });
    } catch (e: any) {
      if (e?.code === 'NOT_FOUND') return res.status(404).json({ error: { code: 'NOT_FOUND', message: e.message } });
      logger.error('[quotation] GET /:id/approval-status 失败', { error: e?.message ?? String(e), quotationId: String(req.params.id) });
      const safe = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '审批状态加载失败；请稍后重试，持续失败请联系管理员查看服务日志。' });
      return res.status(safe.status).json({ error: { code: safe.code, message: safe.message } });
    }
  });

  // ── POST /:id/send — 发送报价单（Draft → Sent） ──
  router.post('/:id/send', requireWrite, requireQuotationWrite, requireObjectWrite, async (req: Request, res: Response) => {
    try {
      const actor = (req as any).actor;
      const quotation = await service.sendQuotation(req.params.id, actor?.userId || 'system');

      onDataChange?.({ entity: 'Quotation', action: 'send', ids: [quotation.id] });

      res.json({ quotation });
    } catch (e: any) {
      logger.error('[QuotationRoute] POST send failed', { error: e?.message });
      const msg = e?.message || '';
      const status = msg.includes('不存在') ? 404 : msg.includes('非法') || msg.includes('门禁') ? 409 : 400;
      // DE-6 统一透传：门禁已发起审批单时回传 id，供前端提示「请至审批中心处理」
      res.status(status).json({
        error: msg || 'failed to send quotation',
        ...(e?.code ? { code: e.code } : {}),
        ...(e?.approvalRequestId ? { approvalRequestId: e.approvalRequestId } : {}),
      });
    }
  });

  // ── POST /:id/accept — 接受报价单（Sent → Accepted） ──
  router.post('/:id/accept', requireWrite, requireQuotationWrite, async (req: Request, res: Response) => {
    try {
      const actor = (req as any).actor;
      const { note } = req.body;
      const quotation = await service.acceptQuotation(req.params.id, actor?.userId || 'system', note, {mode:'verified_actor',actor:originalQuotationActor(req)});

      onDataChange?.({ entity: 'Quotation', action: 'accept', ids: [quotation.id] });

      res.json({ quotation });
    } catch (e: any) {
      logger.error('[QuotationRoute] POST accept failed', { error: e?.message });
      if(typeof e?.statusCode==='number'){const safe=safeRouteError(e,{fallbackCode:'INTERNAL_ERROR'});res.status(safe.status).json({error:safe.message,code:safe.code});return;}
      if(e?.message?.startsWith('非法状态转换')) {res.status(409).json({error:e.message});return;}
      const safe=safeRouteError(e,{fallbackCode:'INTERNAL_ERROR',fallbackMessage:'报价接受暂未完成，请稍后重试。'});
      res.status(safe.status).json({error:safe.message,code:safe.code});
    }
  });

  // ── POST /:id/reject — 拒绝报价单（Sent → Rejected） ──
  router.post('/:id/reject', requireWrite, requireQuotationWrite, requireObjectWrite, async (req: Request, res: Response) => {
    try {
      const actor = (req as any).actor;
      const { note } = req.body;
      const quotation = await service.rejectQuotation(req.params.id, actor?.userId || 'system', note);

      onDataChange?.({ entity: 'Quotation', action: 'reject', ids: [quotation.id] });

      res.json({ quotation });
    } catch (e: any) {
      logger.error('[QuotationRoute] POST reject failed', { error: e?.message });
      const status = e?.message?.includes('不存在') ? 404 : e?.message?.includes('非法') ? 409 : 400;
      res.status(status).json({ error: e?.message || 'failed to reject quotation' });
    }
  });

  // ── POST /:id/expire — 标记过期 ──
  router.post('/:id/expire', requireWrite, requireQuotationWrite, requireObjectWrite, async (req: Request, res: Response) => {
    try {
      const actor = (req as any).actor;
      const quotation = await service.expireQuotation(req.params.id, actor?.userId || 'system');

      onDataChange?.({ entity: 'Quotation', action: 'expire', ids: [quotation.id] });

      res.json({ quotation });
    } catch (e: any) {
      logger.error('[QuotationRoute] POST expire failed', { error: e?.message });
      const status = e?.message?.includes('不存在') ? 404 : 400;
      res.status(status).json({ error: e?.message || 'failed to expire quotation' });
    }
  });

  // ── REQ2-19（DR-060-①）：POST /:id/revise — 显式修订（砍价重报：快照当前版 + version+1 + 回 Draft） ──
  router.post('/:id/revise', requireWrite, requireQuotationWrite, requireObjectWrite, async (req: Request, res: Response) => {
    try {
      const actor = (req as any).actor;
      const { changeReason } = req.body || {};
      const quotation = await service.reviseQuotation(req.params.id, changeReason, actor?.userId || 'system');
      onDataChange?.({ entity: 'Quotation', action: 'revise', ids: [quotation.id] });
      res.json({ quotation });
    } catch (e: any) {
      logger.error('[QuotationRoute] POST revise failed', { error: e?.message });
      const status = e?.message?.includes('不存在') ? 404 : e?.message?.includes('仅 Draft/Sent') ? 409 : 400;
      res.status(status).json({ error: e?.message || 'failed to revise quotation' });
    }
  });

  // ── REQ2-19（DR-060-②）：GET /:id/versions — 版本历史（append-only 正序） ──
  router.get('/:id/versions', requireQuotationRead, requireObjectRead, async (req: Request, res: Response) => {
    try {
      const versions = await service.listQuotationVersions(req.params.id);
      res.json({ versions });
    } catch (e: any) {
      logger.error('[QuotationRoute] GET versions failed', { error: e?.message });
      res.status(500).json({ error: e?.message || 'failed to list versions' });
    }
  });

  // ── POST /:id/convert-to-order — 转为正式订单（Accepted → Order） ──
  router.post('/:id/convert-to-order', requireWrite, requireQuotationWrite, async (req: Request, res: Response) => {
    try {
      const actor = (req as any).actor;
      // ★ A19（§9 B51）：`paymentInstrument` 也要能由转单界面覆盖 —— 不加进这里，
      //   前端传了也会被静默丢掉（= B51「跨层边界上把字段销毁」那一族的同一形状）。
      const { poNumber, millName, type, dueDate, paymentInstrument } = req.body || {};
      const result = await service.convertToOrder(
        req.params.id,
        actor?.userId || 'system',
        { poNumber, millName, type, dueDate, paymentInstrument },
        {mode:'verified_actor',actor:originalQuotationActor(req)},
      );

      onDataChange?.({ entity: 'Quotation', action: 'convert', ids: [result.quotation.id] });
      onDataChange?.({ entity: 'orders', action: 'create', ids: [result.orderId] });

      res.status(201).json(result);
    } catch (e: any) {
      logger.error('[QuotationRoute] POST convert-to-order failed', { error: e?.message ?? String(e) });
      const safe = safeRouteError(conversionRouteError(e, req.params.id), {
        fallbackCode: 'INTERNAL_ERROR',
        fallbackMessage: '报价转单失败，请稍后重试或联系管理员查看服务日志。',
      });
      // Preserve the credit gate's flat { error, code } contract, and the old
      // { error } shape for legacy state/MOQ/approval-pending rejections.
      return res.status(safe.status).json({
        error: safe.message,
        ...(typeof e?.code === 'string' && typeof e?.statusCode === 'number' ? { code: safe.code } : {}),
        ...(typeof e?.approvalRequestId==='string'?{approvalRequestId:e.approvalRequestId}:{}),
        ...(typeof e?.blockCode==='string'?{blockCode:e.blockCode}:{}),
      });
    }
  });

  return router;
}
