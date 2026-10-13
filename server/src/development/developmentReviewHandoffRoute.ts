import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import type { PrismaClient } from '@prisma/client';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { extractActorFromRequest } from '../auth/middleware';
import { exactJsonValue } from '../lib/exactJsonValue';
import { safeRouteError } from '../shared/routeError';
import { QcAssignmentError } from '../qc/qcAssignmentAccess';
import { QC_EVIDENCE_MAX_SIZE } from '../qc/qcEvidenceStorage';
import { DevelopmentDomainError } from './developmentOperationalGuard';
import { createDevelopmentReviewHandoffService } from './developmentReviewHandoffService';

/** Mount inside /api/v1/qc. Every guard applies to an actual path only. */
export function createDevelopmentReviewHandoffRouter(options: { prisma: PrismaClient; privateFilesDir: string; apiKeys?: Set<string>;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void }) {
  const router = Router(), authOptions = { requireAuth: true, apiKeys: options.apiKeys ?? new Set<string>() };
  const auth = createModuleAuthGuard(authOptions), write = requireJwtForWrite(authOptions);
  const service = createDevelopmentReviewHandoffService(options.prisma, options.privateFilesDir);
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: QC_EVIDENCE_MAX_SIZE, files: 1, fields: 2, fieldSize: 256 } }).single('file');
  const prefix = '/development-sample-reviews/:id';
  function handle(res: Response, error: unknown) {
    const failure = error instanceof QcAssignmentError && error.code === 'VALIDATION_FAILED' ? new DevelopmentDomainError('INVALID_INPUT', error.message) : error;
    const safe = safeRouteError(failure, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '开发 QC 操作结果暂不可确认，请保留原请求并重新核对。' });
    res.status(safe.status).json({ ok: false, error: { code: safe.code, message: safe.message } });
  }
  async function send(res: Response, work: () => Promise<unknown>) {
    try { res.json(exactJsonValue({ ok: true, data: await work() })); } catch (error) { handle(res, error); }
  }
  router.get(`${prefix}/handoff-context`, auth, (req, res) => send(res, () => service.context(req.params.id, extractActorFromRequest(req))));
  for (const operation of ['claim', 'transfer', 'assign'] as const) {
    router.post(`${prefix}/${operation}`, auth, write, (req, res) => send(res, async () => {
      const result = await service[operation](req.params.id, req.body, extractActorFromRequest(req), req.ip);
      options.onDataChange?.({ entity: 'development', action: `sample-qc-${operation}`, ids: [result.item.developmentCaseId, result.item.sampleBatchId, req.params.id] });
      return result;
    }));
  }
  router.get(`${prefix}/evidence`, auth, (req, res) => send(res, async () => {
    const result = await service.context(req.params.id, extractActorFromRequest(req));
    return { reviewId: req.params.id, sourceFingerprint: result.item.sourceFingerprint, files: result.files };
  }));
  router.post(`${prefix}/evidence`, auth, write, (req: Request, res: Response) => {
    upload(req, res, error => {
      if (error) { handle(res, new DevelopmentDomainError('INVALID_INPUT', error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE' ? '附件不能超过 15 MB' : '请上传一个实际文件并保留原请求编号')); return; }
      void send(res, async () => {
        if (!req.file || typeof req.body?.requestKey !== 'string' || typeof req.body?.sourceFingerprint !== 'string'
          || Object.keys(req.body ?? {}).some(key => !['requestKey', 'sourceFingerprint'].includes(key)))
          throw new DevelopmentDomainError('INVALID_INPUT', '请提供准确评审来源、稳定原请求键和实际文件');
        const result = await service.upload(req.params.id, { requestKey: req.body.requestKey, sourceFingerprint: req.body.sourceFingerprint,
          file: { originalname: req.file.originalname, buffer: req.file.buffer } }, extractActorFromRequest(req));
        options.onDataChange?.({ entity: 'development', action: 'sample-qc-evidence-uploaded', ids: [req.params.id] });
        return result;
      });
    });
  });
  router.get(`${prefix}/evidence/:fileId`, auth, async (req, res) => {
    try {
      const result = await service.download(req.params.id, req.params.fileId, extractActorFromRequest(req));
      res.setHeader('Content-Type', result.file.mimeType);
      res.setHeader('Content-Length', result.bytes.length);
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.file.name)}`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(result.bytes);
    } catch (error) { handle(res, error); }
  });
  return router;
}
