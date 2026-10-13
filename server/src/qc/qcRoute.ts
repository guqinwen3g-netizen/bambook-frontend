
/**
 * 阶段 P0 回补 — QC 模块路由（PRD 6.2 / 4.2 QC 工作台），挂载于 /api/v1/qc
 *
 * 端点：
 *   驻地：
 *   - GET    /locations                 — 驻地列表（全量未删除）
 *   - POST   /locations                 — 新建驻地 {code, name, region?, focus?, address?, notes?}
 *   - PATCH  /locations/:id             — 更新驻地（code 不可改）
 *   - DELETE /locations/:id             — 软删（仍有任务引用时拒绝）
 *
 *   验货任务：
 *   - GET    /assignments               — 任务列表（?qcUserId&status&orderId&locationId&dueBefore&limit&offset）
 *   - POST   /assignments               — 派单 {orderId, inspectionType, qcUserId, locationId?, dueDate?, notes?}
 *   - PATCH  /assignments/:id           — 更新（notes/dueDate/locationId/qcUserId；已完结不可改）
 *   - DELETE /assignments/:id           — 软删
 *   - POST   /assignments/:id/start     — Assigned → InProgress
 *   - POST   /assignments/:id/complete  — → Completed {reportId?}
 *   - POST   /assignments/:id/cancel    — → Cancelled（Completed 不可取消）
 *
 *   工作台（字面路由先于参数路由）：
 *   - GET    /workbench                 — 按状态分组（?qcUserId=；completed 仅近 30 天限 20 条）
 *
 *   DR-029 双链样品 QC（链 scope 双闸门 + JWT fail-closed）：
 *   - POST   /chain/garment/:orderId/review        — 服装链评审（qc:garment_chain:write）
 *   - POST   /chain/garment/:orderId/direct-reject — 直接打回工厂重做（qc:garment_chain:write，QC-29-A4）
 *   - POST   /chain/fabric/:orderId/review         — 面料链评审（qc:fabric_chain:write）
 *   - GET    /chain/garment/:orderId/gate          — 寄送门禁查询（qc:read；?sampleLevel=&round=）
 *   - GET    /chain/:orderId/reports               — 链报告列表（qc:read；?chain=garment|fabric）
 *
 *   DR-014 出运资格 + 报告双签：
 *   - GET    /orders/:orderId/shipment-eligibility — 面料出运三条件并行视图（qc:read，QC-014-C2）
 *   - GET    /orders/:orderId/reports              — 订单全部验货报告（qc:read）
 *   - GET    /reports/:reportId                    — 单条报告（qc:read）
 *   - POST   /reports/:reportId/sign               — 双签 {role: qc|business}（qc:write + JWT）
 *
 *   REQ2-04 第三方测试管理（qc:read 读 / qc:write 写）：
 *   - POST   /test-requests                        — 登记委托 {orderId, testItems[], agency, ...}
 *   - GET    /test-requests?orderId=               — 订单维度全景（附件+整改+summary，3 击数据源）
 *   - PATCH  /test-requests/:id                    — 结论登记（fail 门禁：failItems+≥1 open 整改）
 *   - DELETE /test-requests/:id                    — 软删（仅 pending）
 *   - POST   /test-requests/:id/files              — 报告 PDF 上传（multer，PDF only ≤10MB）
 *   - GET    /test-requests/:id/files/:fileId      — 报告下载/预览
 *   - POST   /test-requests/:id/corrective-actions — 追加整改 {failItem, action, ...}
 *   - POST   /test-requests/corrective-actions/:caId/close — 整改闭环 {closeNote?}
 *
 * 守卫口径与 seasons/risk 模块一致：读走 JWT 或 API-Key，写必须 JWT（requireJwtForWrite）。
 * 驻地/验货任务写端点与 sign/test-requests 一致：requireWrite + requirePermission('qc:write') 双闸。
 * 链写 scope（:write 后缀）由 requirePermission 强制 JWT user-session，API key 通道 401。
 */

import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { actorIdFromRequest } from '../audit/routeAudit';
import { logger } from '../lib/logger';
import { serializeValue } from '../lib/serializeValue';
import { createQcService, QCLocationInput, QCAssignmentInput } from './qcService';
import {
  createQcChainService,
  parseChainInspectionType,
  GarmentSampleReviewInput,
  FabricSampleReviewInput,
  ChainResult,
} from './qcChainService';
import { createTestRequestService, TestRequestResult } from './testRequestService';
import { buildXlsx, xlsxDownloadHeaders, type XlsxSheet } from '../templates/xlsxExport';
import { renderServerDocument } from '../templates/docTemplates/registry';
import { QcReportError, currentQcReportActor, qcReportFailure, loadAuthorizedQcReportSource } from './qcReportAuthority';
import { upsertDomainTradeDocument, generateTradeDocumentFile } from '../customs/tradeDocumentLifecycleService';
import { PRIVATE_FILES_DIR } from '../lib/privateFiles';

import { extractActorFromRequest } from '../auth/middleware';
import type { TokenPayload } from '../auth/service';
import { currentQcAssignmentActor, QcAssignmentError, qcAssignmentFailure } from './qcAssignmentAccess';
import { createQcScopedService } from './qcScopedService';
import { listQcAssignmentUsers } from './qcAssignmentUsers';
import { safeRouteError } from '../shared/routeError';
import { completeDevelopmentSampleQualityReview, listDevelopmentSampleQualityReviews, startDevelopmentSampleQualityReview } from '../development/developmentSampleQualityService';
import { resumeProductionQcIssues } from './productionQcIssueService';
import { publishNotificationEvent } from '../realtime';
import { createQcAssignmentHandoffService } from './qcAssignmentHandoffService';
import { createQcEvidenceService } from './qcEvidenceService';
import { QC_EVIDENCE_MAX_SIZE } from './qcEvidenceStorage';
import { createDevelopmentReviewHandoffRouter } from '../development/developmentReviewHandoffRoute';
import { todayLocalKey, localDateKey } from '../shared/localDate';

export interface QcRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
  /** REQ2-04 报告 PDF 附件落盘根目录（私有根，绝不位于 /api/uploads 静态服务之下） */
  privateFilesDir?: string;
  /** 旧版落盘根（/api/uploads 静态根）——仅用于迁移前存量文件的回读兜底 */
  uploadDir?: string;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
}

export function createQcRouter(options: QcRouterOptions): Router {
  const { prisma, requireAuth, apiKeys, onDataChange } = options;
  const privateFilesDir = options.privateFilesDir ?? PRIVATE_FILES_DIR;
  const router = Router();
  const service = createQcService(prisma);
  const scoped = createQcScopedService(prisma, { privateFilesDir });
  const handoffs = createQcAssignmentHandoffService(prisma);
  const evidence = createQcEvidenceService(prisma, privateFilesDir);
  const chainService = createQcChainService(prisma);
  const testRequestService = createTestRequestService(prisma);

  router.use(createModuleAuthGuard({ requireAuth, apiKeys }));
  router.use(createDevelopmentReviewHandoffRouter({ prisma, privateFilesDir, apiKeys, onDataChange }));
  const requireWrite = requireJwtForWrite({ requireAuth, apiKeys });
  const notify = (action: string, ids?: string[]) => onDataChange?.({ entity: 'qc', action, ids });

  const handleError = (res: Response, e: any, code: string) => {
    const msg = e?.message || 'operation failed';
    logger.error(`[QcRoute] ${code}`, { error: msg });
    const failure = qcReportFailure(e);
    const result = safeRouteError(failure, { fallbackCode: code,
      fallbackMessage: 'QC 操作结果暂不可确认，请刷新记录后重试。', status: 500 });
    const publicCode = failure instanceof QcReportError && (failure.code === 'VALIDATION_FAILED' || failure.code === 'NOT_FOUND')
      ? code : result.code;
    return res.status(result.status).json({ error: { code: publicCode, message: result.message } });
  };

  const handleAssignmentError = (res: Response, error: unknown, fallbackCode: string) => {
    logger.error(`[QcRoute] ${fallbackCode}`, { error });
    const failure = qcAssignmentFailure(error);
    const result = safeRouteError(failure, { fallbackCode, fallbackMessage: '验货任务处理结果暂不可确认，请刷新记录后重试。' });
    // Preserve original assignment envelopes; scoped report failures retain
    // their finite public codes so clients can distinguish invalid observation.
    if (fallbackCode === 'QC_AUTHORIZATION_FAILED' && result.code === 'FORBIDDEN') {
      return res.status(result.status).json({ error: result.code, message: result.message });
    }
    const code = failure instanceof QcAssignmentError && !(failure instanceof QcReportError)
      && (failure.code === 'VALIDATION_FAILED' || failure.code === 'NOT_FOUND')
      ? fallbackCode : result.code;
    return res.status(result.status).json({ error: { code, message: result.message } });
  };
  const assignmentActor = (scope: 'qc:read' | 'qc:write' | 'qc:inspect') => async (req: Request, res: Response, next: NextFunction) => {
    try {
      const request = req as Request & { actor?: TokenPayload };
      request.actor = await currentQcAssignmentActor(prisma, request.actor ?? extractActorFromRequest(req), scope);
      return next();
    } catch (error) { return handleAssignmentError(res, error, 'QC_AUTHORIZATION_FAILED'); }
  };
  const trustedAssignmentActor = (req: Request) => (req as Request & { actor: TokenPayload }).actor;

  const handleReportError = (res: Response, error: unknown, fallbackCode: string) => {
    const failure = qcReportFailure(error);
    const result = safeRouteError(failure, { fallbackCode, fallbackMessage: '验货报告处理结果暂不可确认，请刷新记录后重试。' });
    const code = failure instanceof QcReportError && (failure.code === 'VALIDATION_FAILED' || failure.code === 'NOT_FOUND')
      ? fallbackCode : result.code;
    return res.status(result.status).json({ error: { code, message: result.message } });
  };
  const reportActor = (scope: 'qc:read' | 'qc:write' | 'qc:inspect') => async (req: Request, res: Response, next: NextFunction) => {
    try {
      const request = req as Request & { actor?: TokenPayload; authSource?: string };
      if (scope !== 'qc:read' && request.authSource !== 'user-session') {
        throw new QcReportError('UNAUTHORIZED', '验货报告写操作需要用户登录。');
      }
      request.actor = await currentQcReportActor(prisma, request.actor ?? extractActorFromRequest(req), scope);
      return next();
    } catch (error) { return handleReportError(res, error, 'QC_AUTHORIZATION_FAILED'); }
  };
  const trustedReportActor = (req: Request) => (req as Request & { actor: TokenPayload }).actor;

  /** ChainResult → HTTP 响应（双链服务结构化错误码直透，fail-closed） */
  const handleChainResult = <T>(
    res: Response,
    result: ChainResult<T>,
    successStatus: number,
    wrap: (data: T) => Record<string, unknown>,
  ) => {
    if (!result.ok) {
      return res.status(result.error.status).json({ error: { code: result.error.code, message: result.error.message } });
    }
    res.status(successStatus).json(serializeValue(wrap(result.data)));
  };

  // ══════════════════════════════════════════════════════════════
  // 驻地
  // ══════════════════════════════════════════════════════════════

  // P3-1（2026-09-13 定案）：读端点补 qc:read 守卫——此前任何登录用户都能看驻地/验货任务/工作台。
  // API-Key 通道不旁路：Agent 主体权限来自其绑定账号的角色（auth/agentPrincipal），
  // 给该账号配含 qc:read 的角色即可（§10.4.1「把 AI 当员工看」）。
  router.get('/locations', requirePermission('qc:read'), async (_req: Request, res: Response) => {
    try {
      const items = await service.listLocations();
      res.json(serializeValue({ items, total: items.length }));
    } catch (e: any) {
      handleError(res, e, 'QC_LOCATION_LIST_FAILED');
    }
  });

  router.post('/locations', requireWrite, requirePermission('qc:write'), async (req: Request, res: Response) => {
    try {
      const loc = await service.createLocation(req.body as QCLocationInput, actorIdFromRequest(req));
      notify('create_location', [loc.id]);
      res.status(201).json(serializeValue({ ok: true, item: loc }));
    } catch (e: any) {
      handleError(res, e, 'QC_LOCATION_CREATE_FAILED');
    }
  });

  router.patch('/locations/:id', requireWrite, requirePermission('qc:write'), async (req: Request, res: Response) => {
    try {
      const loc = await service.updateLocation(req.params.id, req.body ?? {}, actorIdFromRequest(req));
      notify('update_location', [loc.id]);
      res.json(serializeValue({ ok: true, item: loc }));
    } catch (e: any) {
      handleError(res, e, 'QC_LOCATION_UPDATE_FAILED');
    }
  });

  router.delete('/locations/:id', requireWrite, requirePermission('qc:write'), async (req: Request, res: Response) => {
    try {
      await service.deleteLocation(req.params.id, actorIdFromRequest(req));
      notify('delete_location', [req.params.id]);
      res.json({ ok: true });
    } catch (e: any) {
      handleError(res, e, 'QC_LOCATION_DELETE_FAILED');
    }
  });

  // ══════════════════════════════════════════════════════════════
  // 验货任务
  // ══════════════════════════════════════════════════════════════

  router.get('/assignments', assignmentActor('qc:read'), requirePermission('qc:read'), async (req: Request, res: Response) => {
    try {
      const exportAll = req.query.format === 'xlsx';
      const result = await service.listAssignments({
        qcUserId: req.query.qcUserId ? String(req.query.qcUserId) : undefined,
        status: req.query.status ? String(req.query.status) : undefined,
        orderId: req.query.orderId ? String(req.query.orderId) : undefined,
        locationId: req.query.locationId ? String(req.query.locationId) : undefined,
        dueBefore: req.query.dueBefore ? String(req.query.dueBefore) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
        ...(exportAll ? { exportAll: true } : {}),
      }, trustedAssignmentActor(req));
      if (exportAll) {
        const sheet: XlsxSheet = {
          name: 'QC任务台账',
          columnLabels: ['客户单号', '客户', '品名', '验货类型', '驻地', '状态', '要求完成日', '分派时间', '完成时间', '报告ID'],
          columns: ['poNumber', 'customer', 'product', 'inspectionType', 'locationName', 'status', 'dueDate', 'assignedAt', 'completedAt', 'reportId'],
          rows: result.items.map((a: any) => ({
            poNumber: a.order?.poNumber ?? '',
            customer: a.order?.customer ?? '',
            product: a.order?.product ?? '',
            inspectionType: a.inspectionType === 'final' ? '最终验货' : '中期验货',
            locationName: a.location?.name ?? '',
            status: a.status,
            dueDate: a.dueDate,
            assignedAt: a.assignedAt != null ? localDateKey(new Date(Number(a.assignedAt))) : '',
            completedAt: a.completedAt != null ? localDateKey(new Date(Number(a.completedAt))) : '',
            reportId: a.reportId ?? '',
          })),
        };
        const today = todayLocalKey();
        res.set(xlsxDownloadHeaders(`QC任务台账_${today}.xlsx`)).send(buildXlsx([sheet]));
        return;
      }
      res.json(serializeValue(result));
    } catch (e: any) {
      handleAssignmentError(res, e, 'QC_ASSIGNMENT_LIST_FAILED');
    }
  });

  router.get('/assignment-users', requireWrite, assignmentActor('qc:write'), requirePermission('qc:write'), async (req, res) => {
    try {
      if ((req as Request & { authSource?: string }).authSource !== 'user-session') {
        throw new QcAssignmentError('UNAUTHORIZED', '选择执行人员需要用户登录。');
      }
      res.json(await listQcAssignmentUsers(prisma, trustedAssignmentActor(req)));
    } catch (error) { handleAssignmentError(res, error, 'QC_ASSIGNMENT_USERS_FAILED'); }
  });

  router.post('/assignments', requireWrite, assignmentActor('qc:write'), requirePermission('qc:write'), async (req: Request, res: Response) => {
    try {
      if (req.body?.scopeType !== undefined) {
        const result = await scoped.create(req.body, trustedAssignmentActor(req));
        if (!result.replayed) notify('create_assignment', [result.item.id]);
        return res.status(201).json(serializeValue({ ok: true, ...result }));
      }
      const assignment = await service.createAssignment(req.body as QCAssignmentInput, trustedAssignmentActor(req));
      notify('create_assignment', [assignment.id]);
      res.status(201).json(serializeValue({ ok: true, item: assignment }));
    } catch (e: any) {
      handleAssignmentError(res, e, 'QC_ASSIGNMENT_CREATE_FAILED');
    }
  });

  router.get('/orders/:orderId/inspection-scopes', reportActor('qc:read'), requirePermission('qc:read'), async (req, res) => {
    try { res.json(serializeValue(await scoped.scopes(req.params.orderId, trustedReportActor(req)))); }
    catch (error) { handleReportError(res, error, 'QC_INSPECTION_SCOPES_FAILED'); }
  });

  // QC pass resolves quality only. The responsible business account must
  // explicitly resume the exact production branch before its shipment gate
  // considers those issue facts released.
  router.post('/production-batches/:batchId/business-resume', requireWrite, requirePermission('orders:write'), async (req, res) => {
    try {
      const result = await resumeProductionQcIssues({ prisma, productionBatchId: req.params.batchId,
        actor: extractActorFromRequest(req), input: req.body });
      if (!result.replayed) notify('resume_production_after_qc', [req.params.batchId]);
      res.json(serializeValue({ ok: true, ...result }));
    } catch (error: any) {
      const result = safeRouteError(error, { fallbackCode: 'QC_PRODUCTION_RESUME_FAILED',
        fallbackMessage: '生产恢复确认结果暂不可确认，请刷新当前批次后重试。' });
      return res.status(result.status).json({ error: { code: result.code, message: result.message } });
    }
  });

  router.post('/reports/:reportId/business-decision', requireWrite, reportActor('qc:write'), requirePermission('qc:write'), async (req, res) => {
    try {
      const result = await scoped.decision(req.params.reportId, req.body, trustedReportActor(req));
      if (!result.replayed) notify('decide_report', [result.item.id]);
      res.json(serializeValue({ ok: true, ...result }));
    } catch (error) { handleReportError(res, error, 'QC_REPORT_BUSINESS_DECISION_FAILED'); }
  });

  router.get('/assignments/:id/inspection-context', assignmentActor('qc:read'), requirePermission('qc:read'), async (req, res) => {
    try { res.json(serializeValue(await service.getInspectionContext(req.params.id, trustedAssignmentActor(req)))); }
    catch (error) { handleAssignmentError(res, error, 'QC_INSPECTION_CONTEXT_FAILED'); }
  });

  router.get('/assignments/:id/handoff-candidates', assignmentActor('qc:inspect'), requirePermission('qc:inspect'), async (req, res) => {
    try { res.json(await handoffs.candidates(req.params.id, trustedAssignmentActor(req))); }
    catch (error) { handleAssignmentError(res, error, 'QC_HANDOFF_CANDIDATES_FAILED'); }
  });
  for (const operation of ['claim', 'transfer'] as const) router.post(`/assignments/:id/${operation}`, requireWrite,
    assignmentActor('qc:inspect'), requirePermission('qc:inspect'), async (req, res) => {
      try {
        const result = await handoffs[operation](req.params.id, req.body, trustedAssignmentActor(req));
        if (!result.replayed) notify(`assignment_${operation}`, [req.params.id]);
        res.json(serializeValue(result));
      } catch (error) { handleAssignmentError(res, error, 'QC_HANDOFF_FAILED'); }
    });
  const evidenceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: QC_EVIDENCE_MAX_SIZE, files: 1, fields: 3 } }).single('file');
  router.post('/assignments/:id/evidence-files', requireWrite, assignmentActor('qc:inspect'), requirePermission('qc:inspect'),
    (req, res, next) => evidenceUpload(req, res, error => error ? handleAssignmentError(res, new QcAssignmentError('VALIDATION_FAILED', '附件须为单个不超过 15 MB 的文件。'), 'QC_EVIDENCE_UPLOAD_FAILED') : next()),
    async (req, res) => {
      try {
        if (!req.file) throw new QcAssignmentError('VALIDATION_FAILED', '请选择实际图片或 DOC/PDF 文件。');
        const result = await evidence.upload(req.params.id, { requestKey: req.body?.requestKey,
          expectedScopeFingerprint: req.body?.expectedScopeFingerprint, file: req.file }, trustedAssignmentActor(req));
        res.status(201).json(result);
      } catch (error) { handleAssignmentError(res, error, 'QC_EVIDENCE_UPLOAD_FAILED'); }
    });
  router.get('/assignments/:id/evidence-files', assignmentActor('qc:read'), requirePermission('qc:read'), async (req, res) => {
    try { res.json(await evidence.list(req.params.id, trustedAssignmentActor(req))); }
    catch (error) { handleAssignmentError(res, error, 'QC_EVIDENCE_READ_FAILED'); }
  });
  router.get('/reports/:reportId/evidence-files/:fileId', reportActor('qc:read'), requirePermission('qc:read'), async (req, res) => {
    try {
      const result = await evidence.downloadReport(req.params.reportId, req.params.fileId, trustedReportActor(req));
      res.setHeader('Content-Type', result.file.mimeType); res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.file.name)}`);
      res.send(result.bytes);
    } catch (error) { handleReportError(res, error, 'QC_EVIDENCE_DOWNLOAD_FAILED'); }
  });

  router.patch('/assignments/:id', requireWrite, assignmentActor('qc:write'), requirePermission('qc:write'), async (req: Request, res: Response) => {
    try {
      const assignment = await service.updateAssignment(req.params.id, req.body ?? {}, trustedAssignmentActor(req));
      notify('update_assignment', [assignment.id]);
      res.json(serializeValue({ ok: true, item: assignment }));
    } catch (e: any) {
      handleAssignmentError(res, e, 'QC_ASSIGNMENT_UPDATE_FAILED');
    }
  });

  router.delete('/assignments/:id', requireWrite, assignmentActor('qc:write'), requirePermission('qc:write'), async (req: Request, res: Response) => {
    try {
      await service.deleteAssignment(req.params.id, trustedAssignmentActor(req));
      notify('delete_assignment', [req.params.id]);
      res.json({ ok: true });
    } catch (e: any) {
      handleAssignmentError(res, e, 'QC_ASSIGNMENT_DELETE_FAILED');
    }
  });

  router.post('/assignments/:id/start', requireWrite, assignmentActor('qc:inspect'), requirePermission('qc:inspect'), async (req: Request, res: Response) => {
    try {
      const assignment = await service.startAssignment(req.params.id, trustedAssignmentActor(req));
      notify('start_assignment', [assignment.id]);
      res.json(serializeValue({ ok: true, item: assignment }));
    } catch (e: any) {
      handleAssignmentError(res, e, 'QC_ASSIGNMENT_START_FAILED');
    }
  });

  router.post('/assignments/:id/complete', requireWrite, assignmentActor('qc:inspect'), requirePermission('qc:inspect'), async (req: Request, res: Response) => {
    try {
      const candidate = await prisma.qCAssignment.findUnique({ where: { id: req.params.id } });
      if (candidate?.scopeFingerprint) {
        const result = await scoped.complete(req.params.id, req.body, trustedAssignmentActor(req));
        if (!result.replayed) {
          notify('complete_assignment', [result.item.id]);
          for (const event of result.productionQcNotifications ?? []) publishNotificationEvent(event);
        }
        return res.json(serializeValue({ ok: true, item: result.item, report: result.report,
          receipt: result.receipt, replayed: result.replayed }));
      }
      const assignment = await service.completeAssignment(
        req.params.id,
        {
          reportId: req.body?.reportId ?? null,
          // 缺口修复：支持携带 report 数据自动创建大货验货报告（final 锚定 INR__{orderId} 出运门禁锚点）
          report: req.body?.report ?? undefined,
        },
        trustedAssignmentActor(req),
      );
      notify('complete_assignment', [assignment.id]);
      res.json(serializeValue({ ok: true, item: assignment }));
    } catch (e: any) {
      handleAssignmentError(res, e, 'QC_ASSIGNMENT_COMPLETE_FAILED');
    }
  });

  router.post('/assignments/:id/cancel', requireWrite, assignmentActor('qc:write'), requirePermission('qc:write'), async (req: Request, res: Response) => {
    try {
      const assignment = await service.cancelAssignment(req.params.id, trustedAssignmentActor(req));
      notify('cancel_assignment', [assignment.id]);
      res.json(serializeValue({ ok: true, item: assignment }));
    } catch (e: any) {
      handleAssignmentError(res, e, 'QC_ASSIGNMENT_CANCEL_FAILED');
    }
  });

  // ══════════════════════════════════════════════════════════════
  // 工作台
  // ══════════════════════════════════════════════════════════════

  router.get('/workbench', assignmentActor('qc:read'), requirePermission('qc:read'), async (req: Request, res: Response) => {
    try {
      const result = await service.getWorkbench({
        qcUserId: req.query.qcUserId ? String(req.query.qcUserId) : undefined,
      }, trustedAssignmentActor(req));
      res.json(serializeValue(result));
    } catch (e: any) {
      handleAssignmentError(res, e, 'QC_WORKBENCH_FAILED');
    }
  });

  // Development samples are pre-order physical sample forms, not order Sample
  // rows. They use a separate frozen-source review record rather than either
  // order-bound InspectionReport or the order-only fabric sample chain.
  router.get('/development-sample-reviews', requirePermission('qc:read'), async (req: Request, res: Response) => {
    const result = await listDevelopmentSampleQualityReviews({ prisma,
      trustedActor: extractActorFromRequest(req) ?? undefined,
      status: req.query.status ? String(req.query.status) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    if (!result.ok) { res.status(result.error.status).json({ ok: false, error: result.error }); return; }
    res.json({ ok: true, items: result.data.items });
  });
  router.post('/development-sample-reviews/:id/start', requireWrite, requirePermission('qc:inspect'), async (req: Request, res: Response) => {
    const result = await startDevelopmentSampleQualityReview({ prisma, reviewId: req.params.id,
      actorId: actorIdFromRequest(req) || '', trustedActor: extractActorFromRequest(req) ?? undefined, ip: req.ip ?? null });
    if (!result.ok) { res.status(result.error.status).json({ ok: false, error: result.error }); return; }
    notify('start_development_sample_review', [req.params.id]);
    onDataChange?.({ entity: 'development', action: 'sample-qc-started', ids: [result.data.item.developmentCaseId, result.data.item.sampleBatchId, req.params.id] });
    res.json({ ok: true, item: result.data.item });
  });
  router.post('/development-sample-reviews/:id/complete', requireWrite, requirePermission('qc:inspect'), async (req: Request, res: Response) => {
    const result = await completeDevelopmentSampleQualityReview({ prisma, reviewId: req.params.id,
      input: req.body ?? {}, privateFilesDir, actorId: actorIdFromRequest(req) || '', trustedActor: extractActorFromRequest(req) ?? undefined, ip: req.ip ?? null });
    if (!result.ok) { res.status(result.error.status).json({ ok: false, error: result.error }); return; }
    notify('complete_development_sample_review', [req.params.id]);
    onDataChange?.({ entity: 'development', action: 'sample-qc-reviewed', ids: [result.data.item.developmentCaseId, result.data.item.sampleBatchId, req.params.id] });
    res.json({ ok: true, item: result.data.item });
  });

  // ══════════════════════════════════════════════════════════════
  // DR-029 双链样品 QC 评审（服装链 / 面料链 强制边界，QC-29-B3）
  //   写端点：requireWrite（JWT fail-closed）+ 链 scope 双闸门
  // ══════════════════════════════════════════════════════════════

  router.post(
    '/chain/garment/:orderId/review',
    requireWrite,
    requirePermission('qc:inspect'),
    requirePermission('qc:garment_chain:write'),
    async (req: Request, res: Response) => {
      const result = await chainService.reviewGarmentSample({
        orderId: req.params.orderId,
        input: (req.body ?? {}) as GarmentSampleReviewInput,
        actorId: actorIdFromRequest(req),
        trustedActor: extractActorFromRequest(req) ?? undefined,
        ip: req.ip ?? null,
      });
      if (result.ok) notify('review_garment_sample', [result.data.report.id]);
      handleChainResult(res, result, 201, (d) => ({ ok: true, report: d.report, gate: d.gate }));
    },
  );

  // QC-29-A4：直接打回工厂重做（结论=fail + disposition=DIRECT_REJECT，通知业务员）
  router.post(
    '/chain/garment/:orderId/direct-reject',
    requireWrite,
    requirePermission('qc:inspect'),
    requirePermission('qc:garment_chain:write'),
    async (req: Request, res: Response) => {
      const result = await chainService.directlyRejectGarmentSample({
        orderId: req.params.orderId,
        input: (req.body ?? {}) as GarmentSampleReviewInput,
        actorId: actorIdFromRequest(req),
        trustedActor: extractActorFromRequest(req) ?? undefined,
        ip: req.ip ?? null,
      });
      if (result.ok) notify('direct_reject_garment_sample', [result.data.report.id]);
      handleChainResult(res, result, 201, (d) => ({ ok: true, report: d.report, gate: d.gate }));
    },
  );

  router.post(
    '/chain/fabric/:orderId/review',
    requireWrite,
    requirePermission('qc:inspect'),
    requirePermission('qc:fabric_chain:write'),
    async (req: Request, res: Response) => {
      const result = await chainService.reviewFabricSample({
        orderId: req.params.orderId,
        input: (req.body ?? {}) as FabricSampleReviewInput,
        actorId: actorIdFromRequest(req),
        trustedActor: extractActorFromRequest(req) ?? undefined,
        ip: req.ip ?? null,
      });
      if (result.ok) notify('review_fabric_sample', [result.data.report.id]);
      handleChainResult(res, result, 201, (d) => ({ ok: true, report: d.report }));
    },
  );

  // DR-008 / QC-29-A3 服装样品寄送门禁查询（样品域 Track C 消费）
  router.get(
    '/chain/garment/:orderId/gate',
    requirePermission('qc:read'),
    async (req: Request, res: Response) => {
      const result = await chainService.getGarmentSampleGate({
        orderId: req.params.orderId,
        sampleLevel: req.query.sampleLevel ? String(req.query.sampleLevel) : undefined,
        round: Number(req.query.round),
      });
      handleChainResult(res, result, 200, (d) => d);
    },
  );

  // 链报告列表（样品链与大货 final/midline 天然隔离，REL-14-A4）
  router.get(
    '/chain/:orderId/reports',
    reportActor('qc:read'),
    requirePermission('qc:read'),
    async (req: Request, res: Response) => {
      const chain = req.query.chain ? String(req.query.chain) : undefined;
      if (chain !== undefined && chain !== 'garment' && chain !== 'fabric') {
        return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'chain 仅允许 garment | fabric' } });
      }
      try {
        const visible = await service.listReportsByOrder(req.params.orderId, trustedReportActor(req));
        const items = visible.items.flatMap(item => {
          const parsed = parseChainInspectionType(item.inspectionType);
          return parsed && (!chain || parsed.chain === chain) ? [{ ...item, ...parsed }] : [];
        });
        res.json(serializeValue({ items }));
      } catch (error) { handleReportError(res, error, 'QC_ORDER_REPORTS_FAILED'); }
    },
  );

  // ══════════════════════════════════════════════════════════════
  // DR-014 面料出运资格视图（QC ∥ S/S ∥ RC 三条件并行，QC-014-C2）
  // ══════════════════════════════════════════════════════════════

  router.get(
    '/orders/:orderId/shipment-eligibility',
    requirePermission('qc:read'),
    async (req: Request, res: Response) => {
      try {
        const view = await service.checkShipmentEligibility(req.params.orderId);
        res.json(serializeValue(view));
      } catch (e: any) {
        handleError(res, e, 'QC_SHIPMENT_ELIGIBILITY_FAILED');
      }
    },
  );

  // ══════════════════════════════════════════════════════════════
  // InspectionReport 读取 + signatures 双签（质量门禁 §9.3-②）
  // ══════════════════════════════════════════════════════════════

  router.get(
    '/orders/:orderId/reports',
    reportActor('qc:read'),
    requirePermission('qc:read'),
    async (req: Request, res: Response) => {
      try {
        const result = await service.listReportsByOrder(req.params.orderId, trustedReportActor(req));
        res.json(serializeValue(result));
      } catch (e: any) {
        handleReportError(res, e, 'QC_ORDER_REPORTS_FAILED');
      }
    },
  );

  router.get(
    '/reports/:reportId',
    reportActor('qc:read'),
    requirePermission('qc:read'),
    async (req: Request, res: Response) => {
      try {
        const report = await service.getReport(req.params.reportId, trustedReportActor(req));
        res.json(serializeValue({ item: report }));
      } catch (e: any) {
        handleReportError(res, e, 'QC_REPORT_GET_FAILED');
      }
    },
  );

  // GET /reports — 验货报告台账（全局分页列表；质量复盘入口，附订单快照）
  // 字面路由 /reports 与 /reports/:reportId 无段冲突；?inspectionType=final|midline&result=&orderId=&limit=&offset=
  router.get(
    '/reports',
    reportActor('qc:read'),
    requirePermission('qc:read'),
    async (req: Request, res: Response) => {
      try {
        const result = await service.listReports({
          orderId: req.query.orderId ? String(req.query.orderId) : undefined,
          inspectionType: req.query.inspectionType ? String(req.query.inspectionType) : undefined,
          result: req.query.result ? String(req.query.result) : undefined,
          limit: req.query.limit ? Number(req.query.limit) : undefined,
          offset: req.query.offset ? Number(req.query.offset) : undefined,
        }, trustedReportActor(req));
        res.json(serializeValue(result));
      } catch (e: any) {
        handleReportError(res, e, 'QC_REPORT_LIST_FAILED');
      }
    },
  );

  router.post(
    '/reports/:reportId/sign',
    requireWrite,
    (req: Request, res: Response, next: NextFunction) => {
      if (req.body?.role !== 'qc' && req.body?.role !== 'business') {
        return handleReportError(res, new QcReportError('VALIDATION_FAILED', '非法签署角色（允许 qc | business）', 'invalid_role'), 'QC_REPORT_SIGN_FAILED');
      }
      return reportActor(req.body.role === 'qc' ? 'qc:inspect' : 'qc:write')(req, res, next);
    },
    (req: Request, res: Response, next: NextFunction) =>
      requirePermission(req.body.role === 'qc' ? 'qc:inspect' : 'qc:write')(req, res, next),
    async (req: Request, res: Response) => {
      try {
        const report = await service.signReport(
          req.params.reportId,
          req.body?.role,
          actorIdFromRequest(req),
          req.ip ?? null,
          trustedReportActor(req),
          { delegationReason: typeof req.body?.delegationReason === 'string' ? req.body.delegationReason : undefined },
        );
        notify('sign_report', [report.id]);
        res.json(serializeValue({ ok: true, item: report }));
      } catch (e: any) {
        handleReportError(res, e, 'QC_REPORT_SIGN_FAILED');
      }
    },
  );

  // ══════════════════════════════════════════════════════════════
  // B2 运营域单据：验货报告文档（模板真源服务端，单据中心统一归档）
  // ══════════════════════════════════════════════════════════════

  // GET /reports/:reportId/preview.html — IR 服务端模板预览（实时装配渲染，
  // 与生成 PDF 同源排版——所见即所得，无需先登记文档）
  router.get(
    '/reports/:reportId/preview.html',
    reportActor('qc:read'),
    requirePermission('qc:read'),
    async (req: Request, res: Response) => {
      try {
        const { data } = await loadAuthorizedQcReportSource(prisma, trustedReportActor(req), req.params.reportId);
        const html = await renderServerDocument(prisma, 'IR', data, { screen: true });
        if (!html) return res.status(500).json({ error: { code: 'QC_IR_RENDER_FAILED', message: '验货报告模板渲染失败' } });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
      } catch (e: any) {
        handleReportError(res, e, 'QC_REPORT_PREVIEW_FAILED');
      }
    },
  );

  // POST /reports/:reportId/generate-document — 登记域单据（domain=qc）+
  // 服务端渲染 PDF 落盘归档。幂等：domain+type+sourceRef 唯一定位；重复生成
  // 刷新头字段，PDF 每次独立归档（真源实时渲染）。文档号 IR-YYYY-NNNN 自动取号。
  router.post(
    '/reports/:reportId/generate-document',
    requireWrite,
    reportActor('qc:write'),
    requirePermission('qc:write'),
    async (req: Request, res: Response) => {
      try {
        const { report } = await loadAuthorizedQcReportSource(prisma, trustedReportActor(req), req.params.reportId, 'qc:write');
        const actorId = trustedReportActor(req).userId;
        const reg = await upsertDomainTradeDocument(prisma, {
          domain: 'qc',
          type: 'InspectionReport',
          sourceRef: report.id,
          orderId: report.orderId,
          issueDate: report.inspectionDate,
          actorId,
          trustedActor: trustedReportActor(req),
        });
        const file = await generateTradeDocumentFile(prisma, { id: reg.documentId, actorId, trustedActor: trustedReportActor(req) });
        notify('generate_report_document', [reg.documentId]);
        res.json(serializeValue({ ok: true, document: reg, file }));
      } catch (e: any) {
        handleReportError(res, e, 'QC_REPORT_DOCUMENT_GENERATE_FAILED');
      }
    },
  );

  // ══════════════════════════════════════════════════════════════
  // REQ2-04 第三方测试管理（TestRequest — 订单级实验室检测委托）
  // 读 qc:read / 写 qc:write；报告 PDF multer 落盘私有根（安全收口：
  // 不落 /api/uploads 静态服务根，只经本路由 qc:read 门下载）
  // ══════════════════════════════════════════════════════════════

  /** TestRequestResult → HTTP（结构化错误码直透，与 handleChainResult 同构） */
  const handleTrResult = <T>(
    res: Response,
    result: TestRequestResult<T>,
    successStatus: number,
    wrap: (data: T) => Record<string, unknown>,
  ) => {
    if (!result.ok) {
      return res.status(result.error.status).json({ error: { code: result.error.code, message: result.error.message } });
    }
    res.status(successStatus).json(serializeValue(wrap(result.data)));
  };

  // 报告 PDF 上传（PDF only ≤10MB，多文件；落盘私有根 test-reports/{requestId}/）
  const reportUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, file, cb) => {
        const dir = path.join(privateFilesDir, 'test-reports', _req.params.id);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname) || '.pdf';
        cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
      },
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname)) cb(null, true);
      else cb(new Error('仅支持 PDF 报告文件'));
    },
  });

  // 登记委托
  router.post(
    '/test-requests',
    requireWrite,
    requirePermission('qc:write'),
    async (req: Request, res: Response) => {
      const result = await testRequestService.createTestRequest((req.body ?? {}) as any);
      if (result.ok) notify('create_test_request', [result.data.request.id]);
      handleTrResult(res, result, 201, (d) => ({ ok: true, request: d.request }));
    },
  );

  // 订单维度全景（3 击数据源：含附件 + 整改 + summary）
  router.get(
    '/test-requests',
    requirePermission('qc:read'),
    async (req: Request, res: Response) => {
      const result = await testRequestService.listTestRequests(String(req.query.orderId ?? ''));
      handleTrResult(res, result, 200, (d) => ({ ok: true, ...d }));
    },
  );

  // 附件下载/预览（sendFile 绝对路径；filePath 相对落盘根——私有根优先，
  // 旧版静态根（options.uploadDir）兜底回读迁移前存量文件）
  router.get(
    '/test-requests/:id/files/:fileId',
    requirePermission('qc:read'),
    async (req: Request, res: Response) => {
      try {
        const file = await (prisma as any).testReportFile.findFirst({
          where: { id: req.params.fileId, testRequestId: req.params.id, deletedAt: null },
        });
        if (!file) {
          return res.status(404).json({ error: { code: 'FILE_NOT_FOUND', message: '报告附件不存在' } });
        }
        const candidates = [
          path.join(privateFilesDir, file.filePath),
          ...(options.uploadDir ? [path.join(options.uploadDir, file.filePath)] : []),
        ];
        const abs = candidates.find((p) => fs.existsSync(p));
        if (!abs) {
          return res.status(404).json({ error: { code: 'FILE_MISSING', message: '附件文件已丢失（磁盘无此文件）' } });
        }
        return res.download(abs, file.fileName);
      } catch (e: any) {
        logger.error('[QcRoute] TEST_FILE_DOWNLOAD_FAILED', { error: e?.message });
        return res.status(500).json({ error: { code: 'TEST_FILE_DOWNLOAD_FAILED', message: '附件下载失败' } });
      }
    },
  );

  // 上传报告 PDF
  router.post(
    '/test-requests/:id/files',
    requireWrite,
    requirePermission('qc:write'),
    reportUpload.array('files', 10),
    async (req: Request, res: Response) => {
      const files = req.files as Express.Multer.File[] | undefined;
      if (!files || files.length === 0) {
        return res.status(400).json({ error: { code: 'NO_FILES', message: '未收到 PDF 文件' } });
      }
      const result = await testRequestService.attachFiles(req.params.id, files.map((f) => ({
        filePath: path.join('test-reports', req.params.id, f.filename),
        fileName: f.originalname,
        mimeType: f.mimetype,
        fileSize: f.size,
      })));
      if (!result.ok) {
        // 委托单不存在等场景：清理已落盘文件，不留孤儿
        for (const f of files) { try { fs.unlinkSync(f.path); } catch { /* best-effort */ } }
      } else {
        notify('upload_test_report', [req.params.id]);
      }
      handleTrResult(res, result, 201, (d) => ({ ok: true, files: d.files }));
    },
  );

  // 结论登记 / 委托修正（fail 门禁在 service）
  router.patch(
    '/test-requests/:id',
    requireWrite,
    requirePermission('qc:write'),
    async (req: Request, res: Response) => {
      const result = await testRequestService.updateTestRequest(req.params.id, (req.body ?? {}) as any);
      if (result.ok) notify('update_test_request', [req.params.id]);
      handleTrResult(res, result, 200, (d) => ({ ok: true, request: d.request }));
    },
  );

  // 软删委托（仅 pending）
  router.delete(
    '/test-requests/:id',
    requireWrite,
    requirePermission('qc:write'),
    async (req: Request, res: Response) => {
      const result = await testRequestService.deleteTestRequest(req.params.id);
      if (result.ok) notify('delete_test_request', [req.params.id]);
      handleTrResult(res, result, 200, (d) => ({ ok: true, id: d.id }));
    },
  );

  // 追加整改记录（fail 单）
  router.post(
    '/test-requests/:id/corrective-actions',
    requireWrite,
    requirePermission('qc:write'),
    async (req: Request, res: Response) => {
      const result = await testRequestService.addCorrectiveAction(req.params.id, (req.body ?? {}) as any);
      if (result.ok) notify('add_test_corrective_action', [req.params.id]);
      handleTrResult(res, result, 201, (d) => ({ ok: true, correctiveAction: d.correctiveAction }));
    },
  );

  // 整改闭环（open→closed；字面段路由先于参数路由不冲突——段数不同）
  router.post(
    '/test-requests/corrective-actions/:caId/close',
    requireWrite,
    requirePermission('qc:write'),
    async (req: Request, res: Response) => {
      const result = await testRequestService.closeCorrectiveAction(
        req.params.caId, (req.body ?? {}).closeNote);
      if (result.ok) notify('close_test_corrective_action', [req.params.caId]);
      handleTrResult(res, result, 200, (d) => ({ ok: true, correctiveAction: d.correctiveAction }));
    },
  );

  return router;
}
