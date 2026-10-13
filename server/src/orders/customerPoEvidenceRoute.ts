import type { Request, Response, Router, RequestHandler } from 'express';
import type { PrismaClient } from '@prisma/client';
import multer from 'multer';
import type { TokenPayload } from '../auth/service';
import { requirePermission } from '../auth/permissionGuard';
import { PRIVATE_FILES_DIR } from '../lib/privateFiles';
import { businessError } from '../shared/errorCodes';
import { safeRouteError } from '../shared/routeError';
import { CUSTOMER_PO_EVIDENCE_MAX_BYTES, createCustomerPoEvidenceService } from './customerPoEvidenceService';

/** Customer PO file evidence only. This route never parses a file or writes order fields. */
export function mountCustomerPoEvidenceRoutes(router: Router, params: {
  prisma: PrismaClient;
  requireWrite: RequestHandler;
  privateFilesDir?: string;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
}): void {
  const service = createCustomerPoEvidenceService(params.prisma, { privateFilesDir: params.privateFilesDir ?? PRIVATE_FILES_DIR });
  const actor = (req: Request) => (req as Request & { actor?: TokenPayload }).actor ?? null;
  const respondError = (res: Response, cause: unknown, fallback: string) => {
    const safe = safeRouteError(cause, { fallbackCode: 'CUSTOMER_PO_EVIDENCE_FAILED', fallbackMessage: fallback });
    return res.status(safe.status).json({ ok: false, error: { code: safe.code, message: safe.message } });
  };
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: CUSTOMER_PO_EVIDENCE_MAX_BYTES, files: 1, fields: 1, fieldSize: 128, parts: 2 } }).single('file');

  router.get('/:orderId/customer-po-evidence', requirePermission('orders:read'), async (req, res) => {
    try {
      const result = await service.list(actor(req), req.params.orderId);
      return res.json({ ok: true, ...result });
    } catch (cause) { return respondError(res, cause, '客户 PO 原件暂时无法读取，请重试。'); }
  });

  router.post('/:orderId/customer-po-evidence', params.requireWrite, requirePermission('orders:write'), (req, res, next) => {
    upload(req, res, error => {
      if (error) {
        const message = (error as any)?.code === 'LIMIT_FILE_SIZE' ? '客户 PO 文件不能超过 20 MiB。' : '请选择一个有效的客户 PO 文件。';
        respondError(res, businessError('INVALID_INPUT', message), '客户 PO 上传失败。');
        return;
      }
      next();
    });
  }, async (req, res) => {
    try {
      if (!req.file) throw businessError('INVALID_INPUT', '请选择一个客户 PO 原件。');
      if (Object.keys(req.body ?? {}).some(key => key !== 'requestKey')) throw businessError('INVALID_INPUT', '客户 PO 上传只接受文件与请求编号。');
      const item = await service.upload(actor(req), req.params.orderId, {
        buffer: req.file.buffer, originalName: req.file.originalname, size: req.file.size,
      }, String(req.body?.requestKey ?? ''), req.ip);
      params.onDataChange?.({ entity: 'orders.customer-po-evidence', action: 'archive', ids: [req.params.orderId, item.id] });
      return res.status(201).json({ ok: true, item });
    } catch (cause) { return respondError(res, cause, '客户 PO 原件未能归档，请刷新后核对。'); }
  });

  router.get('/:orderId/customer-po-evidence/:evidenceId/download', requirePermission('orders:read'), async (req, res) => {
    try {
      const result = await service.download(actor(req), req.params.orderId, req.params.evidenceId);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.attachment(result.evidence.fileName).type('application/octet-stream').send(result.bytes);
    } catch (cause) { return respondError(res, cause, '客户 PO 原件暂时无法下载，请重试。'); }
  });
}
