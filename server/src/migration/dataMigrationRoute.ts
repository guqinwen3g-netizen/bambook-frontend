/**
 * dataMigrationRoute.ts — REQ2-07 历史数据批量迁移路由
 *
 * 挂载点：/api/v1/data-migration（跨 relations/orders/invoices 独立域，DR-049-③）
 *
 * 端点：
 *   GET  /templates/:type — 下载四类 CSV 模板（表头+中文示例，BOM 防 Excel 乱码）
 *   POST /validate        — multipart {file, type} 逐行校验（零落库，错误行号+原因）
 *   POST /commit          — multipart {file, type} 确认导入（二次校验，valid 落库+批次留痕）
 *   GET  /batches         — 批次列表（倒序 100）
 *   POST /batches/:id/rollback — 整批软删回滚
 *
 * 守卫：createModuleAuthGuard（认证门）+ requirePermission('data:import')（W-C 权限收口：
 * 全端点统一挂数据导入 scope——REQ2-07 导入通道整体按高危写操作对待；
 * data:import 属写类 scope，permissionGuard 强制 JWT user-session，API-Key 拒）；
 * requireJwtForWrite 继续保留在写端点上（与 scope 门冗余一致，双保险）。
 * 上传：multer memoryStorage（.xlsx/.csv，≤10MB）。
 */
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import multer from 'multer';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { logger } from '../lib/logger';
import { serializeValue } from '../lib/serializeValue';
import { createDataMigrationService, MigrationResult } from './dataMigrationService';
// ★ 未预期异常不再回显原始错误；业务错误（code+statusCode）仍透传。
//   安全前提（已核对）：同域目录 `throw new Error(` 为 0 处 ⇒ catch 只接未预期异常。
import { safeRouteError } from '../shared/routeError';

export interface DataMigrationRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
}

export function createDataMigrationRouter(options: DataMigrationRouterOptions): Router {
  const { prisma, requireAuth, apiKeys, onDataChange } = options;
  const router = Router();
  const service = createDataMigrationService(prisma);

  router.use(createModuleAuthGuard({ requireAuth, apiKeys }));
  const requireWrite = requireJwtForWrite({ requireAuth, apiKeys });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (/\.(xlsx|csv)$/i.test(file.originalname)) cb(null, true);
      else cb(new Error('仅支持 .xlsx / .csv 文件'));
    },
  });

  const handle = <T>(
    res: Response,
    result: MigrationResult<T>,
    successStatus: number,
    wrap: (data: T) => Record<string, unknown>,
  ) => {
    if (!result.ok) {
      return res.status(result.error.status).json({ error: { code: result.error.code, message: result.error.message } });
    }
    res.status(successStatus).json(serializeValue(wrap(result.data)) as any);
  };

  // 模板下载（attachment CSV）
  router.get('/templates/:type', requirePermission('data:import'), (req: Request, res: Response) => {
    const result = service.getTemplateCsv(req.params.type);
    if (!result.ok) {
      return res.status(result.error.status).json({ error: { code: result.error.code, message: result.error.message } });
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${result.data.fileName}"`);
    return res.send(result.data.csv);
  });

  // 逐行校验（零落库）
  router.post('/validate', requireWrite, requirePermission('data:import'), upload.single('file'), (req: Request, res: Response) => {
    (async () => {
      const file = req.file;
      if (!file) return res.status(400).json({ error: { code: 'NO_FILE', message: '未收到文件' } });
      const type = String(req.body?.type ?? '');
      const result = await service.validateFile(type, file.buffer);
      handle(res, result, 200, (d) => ({ ok: true, ...d }));
    })().catch((e: any) => {
      logger.error('[DataMigration] validate failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'VALIDATE_FAILED', fallbackMessage: '校验失败' });
      res.status(r.status).json({ error: { code: r.code, message: r.message } });
    });
  });

  // 确认导入（二次校验 + 落库 + 批次留痕）
  router.post('/commit', requireWrite, requirePermission('data:import'), upload.single('file'), (req: Request, res: Response) => {
    (async () => {
      const file = req.file;
      if (!file) return res.status(400).json({ error: { code: 'NO_FILE', message: '未收到文件' } });
      const type = String(req.body?.type ?? '');
      const result = await service.commitFile(type, file.buffer, file.originalname);
      if (result.ok) {
        onDataChange?.({ entity: 'data-migration', action: 'commit', ids: [result.data.batch.id] });
      }
      handle(res, result, 201, (d) => ({ ok: true, batch: d.batch, imported: d.imported, skipped: d.skipped }));
    })().catch((e: any) => {
      logger.error('[DataMigration] commit failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'COMMIT_FAILED', fallbackMessage: '导入失败' });
      res.status(r.status).json({ error: { code: r.code, message: r.message } });
    });
  });

  // 批次列表
  router.get('/batches', requirePermission('data:import'), async (_req: Request, res: Response) => {
    const result = await service.listBatches();
    handle(res, result, 200, (d) => ({ ok: true, ...d }));
  });

  // 整批回滚（软删）
  router.post('/batches/:id/rollback', requireWrite, requirePermission('data:import'), (req: Request, res: Response) => {
    (async () => {
      const result = await service.rollbackBatch(req.params.id);
      if (result.ok) {
        onDataChange?.({ entity: 'data-migration', action: 'rollback', ids: [req.params.id] });
      }
      handle(res, result, 200, (d) => ({ ok: true, rolledBack: d.rolledBack }));
    })().catch((e: any) => {
      logger.error('[DataMigration] rollback failed', { error: e?.message });
      const r = safeRouteError(e, { fallbackCode: 'ROLLBACK_FAILED', fallbackMessage: '回滚失败' });
      res.status(r.status).json({ error: { code: r.code, message: r.message } });
    });
  });

  return router;
}
