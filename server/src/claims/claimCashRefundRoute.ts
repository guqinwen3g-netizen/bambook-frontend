import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { extractActorFromRequest } from '../auth/middleware';
import { safeRouteError } from '../shared/routeError';
import { logger } from '../lib/logger';
import { serializeSettlementValue } from '../lib/serializeSettlementValue';
import { hasScope } from '../auth/permissionService';
import { requirePermission } from '../auth/permissionGuard';
import { createClaimCashRefundService } from './claimCashRefundService';
import { createClaimCashRefundRequestService } from './claimCashRefundRequestService';
import { CashRefundError, type CashRefundVisibility, currentRefundActor, lockCashRefund,
  refundId, requireRefundVisibility, assertRefundHistory, assertCashRefundEvidence } from './claimCashRefundFact';

export interface ClaimCashRefundRouterOptions {
  prisma: PrismaClient;
  /** Must be outside the public uploads root; no route accepts a filesystem path. */
  privateFilesDir: string;
  uploadDir: string;
  assertCreditNoteVisible?: CashRefundVisibility;
}
export function createClaimCashRefundRouter(options: ClaimCashRefundRouterOptions): Router {
  const router = Router(), { prisma } = options;
  const privateRoot = path.resolve(options.privateFilesDir), publicRoot = path.resolve(options.uploadDir);
  const inside = (parent: string, child: string) => child === parent || child.startsWith(parent + path.sep);
  const storeRoot = async () => {
    if (inside(publicRoot, privateRoot)) throw new CashRefundError('AUTHORIZATION_UNAVAILABLE', '付款证据存储不可处于公开上传目录');
    await fs.mkdir(privateRoot, { recursive: true });
    const actual = await fs.realpath(privateRoot);
    const actualPublic = await fs.realpath(publicRoot).catch(() => publicRoot);
    if (inside(actualPublic, actual)) throw new CashRefundError('AUTHORIZATION_UNAVAILABLE', '付款证据存储不可处于公开上传目录');
    return actual;
  };
  const evidenceBytes = async (row: any) => {
    if (!/^cash-refunds\/[a-f0-9-]+\.bin$/.test(row.privateStorageKey)) throw new CashRefundError('INVALID_STATE', '付款证据存储标识已损坏');
    const root = await storeRoot(), absolute = path.resolve(root, row.privateStorageKey);
    const actual = await fs.realpath(absolute);
    if (!inside(root, actual)) throw new CashRefundError('INVALID_STATE', '付款证据不可跨出私有目录');
    const bytes = await fs.readFile(actual);
    if (bytes.length !== row.fileSize || createHash('sha256').update(bytes).digest('hex') !== row.sha256) throw new CashRefundError('INVALID_STATE', '付款证据内容已变化，不可确认为原实付证据');
    return bytes;
  };
  const service = createClaimCashRefundService({ prisma, assertVisible: options.assertCreditNoteVisible,
    assertEvidence: async row => { await evidenceBytes(row); } });
  const requestResult = createClaimCashRefundRequestService({ prisma, assertVisible: options.assertCreditNoteVisible });
  const actor = (req: Request): TokenPayload => {
    const prior = extractActorFromRequest(req);
    if (!prior?.userId) throw new CashRefundError('UNAUTHORIZED', '客户退款需要登录主体');
    return prior;
  };
  const sendError = (error: unknown, res: Response) => {
    logger.error('[claim:cash-refund] operation failed', { error: (error as any)?.message });
    const safe = safeRouteError(error, { fallbackCode: 'CLAIM_CASH_REFUND_FAILED', fallbackMessage: '客户退款未能完成，本次未确认任何改动，请稍后重试' });
    // A refusal describes this attempt only: it cannot clear a prior saved
    // intent whose result is unknown. Never claim not_applied from list absence.
    return res.status(safe.status).json({ error: safe.code, message: safe.message });
  };
  const run = (fn: (req: Request) => Promise<any>, created = false) => async (req: Request, res: Response) => {
    try { const result = await fn(req); return res.status(created && !result.replayed ? 201 : 200).json(serializeSettlementValue(result)); }
    catch (error) { return sendError(error, res); }
  };
  router.get('/credit-notes/:id/refunds', run(req => service.list(req.params.id, actor(req))));
  // Current DB action-specific scope and L2 are checked inside the same parent
  // transaction. Body.action is validated before selecting its real scope.
  router.post('/credit-notes/:id/refund-request-result', run(req => requestResult.result(req.params.id, 'note', req.body, actor(req))));
  router.post('/credit-notes/:id/refund-request-retire', run(req => requestResult.retire(req.params.id, 'note', req.body, actor(req))));
  router.post('/credit-note-refunds/:id/request-result', run(req => requestResult.result(req.params.id, 'refund', req.body, actor(req))));
  router.post('/credit-note-refunds/:id/request-retire', run(req => requestResult.retire(req.params.id, 'refund', req.body, actor(req))));
  router.post('/credit-notes/:id/refunds', requirePermission('finance:payment_request:create'), run(req => service.create(req.params.id, req.body, actor(req)), true));
  router.get('/credit-note-refunds/:id', run(req => service.get(req.params.id, actor(req))));
  router.post('/credit-note-refunds/:id/start', requirePermission('vouchers:write'), run(req => service.start(req.params.id, req.body, actor(req))));
  router.post('/credit-note-refunds/:id/cancel', requirePermission('finance:payment_request:create'), run(req => service.cancel(req.params.id, req.body, actor(req))));
  router.post('/credit-note-refunds/:id/confirm', requirePermission('vouchers:write'), run(req => service.confirm(req.params.id, req.body, actor(req))));
  router.post('/credit-note-refunds/:id/failure', requirePermission('vouchers:write'), run(req => service.failure(req.params.id, req.body, actor(req))));
  router.post('/credit-note-refunds/:id/resubmit', requirePermission('finance:payment_request:create'), run(async req => {
    const prior = actor(req), current = await service.get(req.params.id, prior);
    return service.create(current.creditNote.id, req.body, prior, req.params.id);
  }, true));

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } }).single('file');
  router.post('/credit-note-refunds/:id/evidence', requirePermission('vouchers:write'), (req, res, next) => upload(req, res, error => {
    if (error) return sendError(new CashRefundError('VALIDATION_FAILED', '付款证据仅支持单文件，最大 8 MiB'), res);
    next();
  }), async (req: any, res: Response) => {
    let stored: string | undefined;
    try {
      const prior = actor(req), file = req.file;
      const purpose = req.body?.purpose ?? 'PaymentProof';
      if (!file?.buffer?.length || Object.keys(req.body ?? {}).some(key => key !== 'purpose') || !['PaymentProof', 'PaymentFailure'].includes(purpose)) throw new CashRefundError('VALIDATION_FAILED', '仅接受真实付款证据及适用证明种类，不接受路径或额外业务字段');
      const bytes: Buffer = file.buffer;
      const mimeType = bytes.subarray(0, 5).toString() === '%PDF-' ? 'application/pdf'
        : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
          : bytes[0] === 255 && bytes[1] === 216 ? 'image/jpeg' : null;
      if (!mimeType) throw new CashRefundError('VALIDATION_FAILED', '付款证据须为真实 PDF、PNG 或 JPEG 文件');
      const result = await (prisma as any).$transaction(async (tx: any) => {
        const { refund, creditNote } = await lockCashRefund(tx, req.params.id);
        const current = await currentRefundActor(tx, prior, 'vouchers:write');
        await requireRefundVisibility(tx, creditNote, current, options.assertCreditNoteVisible);
        await assertRefundHistory(tx, refund);
        if (!['Approved', 'Executing'].includes(refund.status)) throw new CashRefundError('INVALID_STATE', '仅已批准或执行中的退款可登记实付证据');
        const root = await storeRoot();
        await fs.mkdir(path.join(root, 'cash-refunds'), { recursive: true });
        const actualDirectory = await fs.realpath(path.join(root, 'cash-refunds'));
        if (!inside(root, actualDirectory)) throw new CashRefundError('INVALID_STATE', '付款证据不可跨出私有目录');
        const privateStorageKey = 'cash-refunds/' + randomUUID() + '.bin';
        stored = path.join(root, privateStorageKey);
        await fs.writeFile(stored, bytes, { flag: 'wx' });
        const sha256 = createHash('sha256').update(bytes).digest('hex'), uploadedAt = BigInt(Date.now());
        const evidence = await tx.creditNoteRefundEvidence.create({ data: { id: refundId('CNRE'), refundId: refund.id,
          purpose, privateStorageKey, sha256, fileName: path.basename(file.originalname).slice(0, 240),
          mimeType, fileSize: bytes.length, uploadedBy: current.userId, uploadedAt } });
        await tx.auditLog.create({ data: { id: refundId('alog'), actorId: current.userId, action: 'CREDIT_NOTE_REFUND_EVIDENCE_ADDED',
          targetType: 'CreditNoteRefundEvidence', targetId: evidence.id, operationType: 'create',
          detail: { evidence: { schemaVersion: 1, refundId: refund.id, evidenceId: evidence.id, sha256, fileSize: bytes.length,
            uploadedBy: current.userId, uploadedAt: String(uploadedAt), purpose } } } });
        const { privateStorageKey: _private, ...safe } = evidence;
        return safe;
      });
      stored = undefined;
      return res.status(201).json(serializeSettlementValue(result));
    } catch (error) {
      if (stored) await fs.unlink(stored).catch(() => undefined);
      return sendError(error, res);
    }
  });
  router.get('/credit-note-refunds/:id/evidence/:evidenceId', async (req, res) => {
    try {
      const prior = actor(req);
      const row = await (prisma as any).$transaction(async (tx: any) => {
        const { creditNote, refund } = await lockCashRefund(tx, req.params.id);
        const current = await currentRefundActor(tx, prior);
        if (!['aftersales:read', 'finance:read', 'vouchers:read'].some(scope => hasScope(current, scope as any))) throw new CashRefundError('FORBIDDEN', '需要付款证据读取权限');
        await requireRefundVisibility(tx, creditNote, current, options.assertCreditNoteVisible);
        await assertRefundHistory(tx, refund);
        const evidence = await tx.creditNoteRefundEvidence.findUnique({ where: { id: req.params.evidenceId } });
        if (!evidence || evidence.refundId !== refund.id) throw new CashRefundError('NOT_FOUND', '付款证据不存在');
        await assertCashRefundEvidence(tx, evidence);
        return evidence;
      });
      const bytes = await evidenceBytes(row);
      res.setHeader('Content-Type', row.mimeType); res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.fileName)}`);
      return res.send(bytes);
    } catch (error) { return sendError(error, res); }
  });
  return router;
}
