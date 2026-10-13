import { Router, type Request, type Response } from 'express';
import type { TokenPayload } from '../auth/service';
import { extractActorFromRequest } from '../auth/middleware';
import { requirePermission } from '../auth/permissionGuard';
import { safeRouteError } from '../shared/routeError';
import { serializeSettlementValue } from '../lib/serializeSettlementValue';
import { logger } from '../lib/logger';
import multer from 'multer';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { type ClaimCashRefundRouterOptions } from './claimCashRefundRoute';
import { CashRefundError, currentRefundActor, lockCashRefund, refundId, requireRefundVisibility } from './claimCashRefundFact';
import { readCashRefundPaidSource, readCashReturnSourceProof } from './claimCashRefundReturnFact';
import { assertClaimCreditNoteAccount } from './claimCreditNoteVersionService';
import { createClaimCashRefundReturnService } from './claimCashRefundReturnService';
import { createClaimCashRefundRequestService } from './claimCashRefundRequestService';

/** Private original bytes use the same server-owned store as payout proofs.
 * No filesystem path is accepted, and no real bank transfer is executed here. */
export function createClaimCashRefundReturnRouter(options: ClaimCashRefundRouterOptions) {
  const router = Router(), { prisma } = options;
  const privateRoot = path.resolve(options.privateFilesDir), publicRoot = path.resolve(options.uploadDir);
  const inside = (parent: string, child: string) => child === parent || child.startsWith(parent + path.sep);
  const storeRoot = async () => {
    if (inside(publicRoot, privateRoot)) throw new CashRefundError('AUTHORIZATION_UNAVAILABLE', '返款原字节证据不可存于公开目录');
    await fs.mkdir(privateRoot, { recursive: true });
    const actual = await fs.realpath(privateRoot), actualPublic = await fs.realpath(publicRoot).catch(() => publicRoot);
    if (inside(actualPublic, actual)) throw new CashRefundError('AUTHORIZATION_UNAVAILABLE', '返款原字节证据不可存于公开目录');
    return actual;
  };
  const assertEvidence = async (row: any) => {
    if (!/^cash-refunds\/[a-f0-9-]+\.bin$/.test(row.privateStorageKey)) throw new CashRefundError('INVALID_STATE', '返款证据标识已损坏');
    const root = await storeRoot(), actual = await fs.realpath(path.resolve(root, row.privateStorageKey));
    if (!inside(root, actual)) throw new CashRefundError('INVALID_STATE', '返款证据不可跨出私有目录');
    const bytes = await fs.readFile(actual);
    if (bytes.length !== row.fileSize || createHash('sha256').update(bytes).digest('hex') !== row.sha256) throw new CashRefundError('INVALID_STATE', '返款或来源证据内容已改变，不能确认实际返款');
  };
  const service = createClaimCashRefundReturnService({ prisma, assertVisible: options.assertCreditNoteVisible, assertEvidence });
  const protocol = createClaimCashRefundRequestService({ prisma, assertVisible: options.assertCreditNoteVisible, assertReturnEvidence: assertEvidence });
  const actor = (req: Request): TokenPayload => {
    const prior = extractActorFromRequest(req);
    if (!prior?.userId) throw new CashRefundError('UNAUTHORIZED', '实际返款需要登录主体');
    return prior;
  };
  const error = (cause: unknown, res: Response) => {
    logger.error('[claim:cash-return] operation failed', { error: (cause as any)?.message });
    const safe = safeRouteError(cause, { fallbackCode: 'CLAIM_CASH_REFUND_FAILED', fallbackMessage: '实际返款未能确认，请保留原请求并核对；本次响应不代表银行未入账' });
    return res.status(safe.status).json({ error: safe.code, message: safe.message });
  };
  const run = (fn: (req: Request) => Promise<any>, created = false) => async (req: Request, res: Response) => {
    try { const result = await fn(req); return res.status(created && !result.replayed ? 201 : 200).json(serializeSettlementValue(result)); }
    catch (cause) { return error(cause, res); }
  };
  router.get('/credit-note-refunds/:id/returns', run(req => service.list(req.params.id, actor(req))));
  router.get('/credit-note-refunds/:id/return-receipts', run(req => service.listReceiptCandidates(req.params.id, actor(req))));
  router.post('/credit-note-refunds/:id/returns', requirePermission('vouchers:write'), run(req => service.record(req.params.id, req.body, actor(req)), true));
  // Result/retirement check the original action's current DB scope and parent L2
  // inside the common CN lock, including the unchanged six cash actions.
  router.post('/credit-note-refunds/:id/return-request-result', run(req => protocol.result(req.params.id, 'refund', req.body, actor(req))));
  router.post('/credit-note-refunds/:id/return-request-retire', run(req => protocol.retire(req.params.id, 'refund', req.body, actor(req))));
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } }).single('file');
  router.post('/credit-note-refunds/:id/return-evidence', requirePermission('vouchers:write'), (req, res, next) => upload(req, res, cause => {
    if (cause) return error(new CashRefundError('VALIDATION_FAILED', '返款证明仅支持单文件，最大 8 MiB'), res);
    next();
  }), async (req: any, res: Response) => {
    let stored: string | undefined;
    try {
      const prior = actor(req), file = req.file;
      if (!file?.buffer?.length || Object.keys(req.body ?? {}).length) throw new CashRefundError('VALIDATION_FAILED', '仅接受本次实际返款原文件，不接受路径或额外业务字段');
      const bytes: Buffer = file.buffer;
      const mimeType = bytes.subarray(0, 5).toString() === '%PDF-' ? 'application/pdf'
        : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
          : bytes[0] === 255 && bytes[1] === 216 ? 'image/jpeg' : null;
      if (!mimeType) throw new CashRefundError('VALIDATION_FAILED', '返款证明须为真实 PDF、PNG 或 JPEG');
      const result = await (prisma as any).$transaction(async (tx: any) => {
        const { refund, creditNote } = await lockCashRefund(tx, req.params.id);
        const current = await currentRefundActor(tx, prior, 'vouchers:write');
        await requireRefundVisibility(tx, creditNote, current, options.assertCreditNoteVisible);
        await assertClaimCreditNoteAccount(tx, creditNote);
        const source = await readCashRefundPaidSource(tx, creditNote, refund);
        for (const row of await readCashReturnSourceProof(tx, refund.id, source)) await assertEvidence(row);
        const root = await storeRoot(), directory = path.join(root, 'cash-refunds');
        await fs.mkdir(directory, { recursive: true });
        if (!inside(root, await fs.realpath(directory))) throw new CashRefundError('INVALID_STATE', '返款证据不可跨出私有目录');
        const privateStorageKey = 'cash-refunds/' + randomUUID() + '.bin'; stored = path.join(root, privateStorageKey);
        await fs.writeFile(stored, bytes, { flag: 'wx' });
        const sha256 = createHash('sha256').update(bytes).digest('hex'), uploadedAt = BigInt(Date.now()), purpose = 'PaymentReturnProof';
        const evidence = await tx.creditNoteRefundEvidence.create({ data: { id: refundId('CNRE'), refundId: refund.id, purpose,
          privateStorageKey, sha256, fileName: path.basename(file.originalname).slice(0, 240), mimeType, fileSize: bytes.length, uploadedBy: current.userId, uploadedAt } });
        await tx.auditLog.create({ data: { id: refundId('alog'), actorId: current.userId, action: 'CREDIT_NOTE_REFUND_EVIDENCE_ADDED', targetType: 'CreditNoteRefundEvidence',
          targetId: evidence.id, operationType: 'create', detail: { evidence: { schemaVersion: 1, refundId: refund.id, evidenceId: evidence.id, sha256,
            fileSize: bytes.length, uploadedBy: current.userId, uploadedAt: String(uploadedAt), purpose } } } });
        const { privateStorageKey: _private, ...safe } = evidence; return safe;
      });
      stored = undefined;
      return res.status(201).json(serializeSettlementValue(result));
    } catch (cause) { if (stored) await fs.unlink(stored).catch(() => undefined); return error(cause, res); }
  });
  return router;
}
