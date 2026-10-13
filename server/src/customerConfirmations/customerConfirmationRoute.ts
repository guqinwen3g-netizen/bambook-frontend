import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import path from 'path';
import type { PrismaClient } from '@prisma/client';
import { extractActorFromRequest } from '../auth/middleware';
import { logger } from '../lib/logger';
import { safeRouteError } from '../shared/routeError';
import { CustomerConfirmationError, assertCustomerConfirmationMatchesTarget, currentCustomerConfirmationActor,
  recordBusinessConfirmationInTx, validateCustomerConfirmationCommand } from './customerConfirmationService';
import { persistPreparedCustomerEvidenceBlobsInTx, prepareCustomerConfirmationEvidence, readCustomerEvidenceFile,
  removeNewlyCreatedFilesWhileLocked } from './customerEvidenceCapture';
import type { CustomerConfirmationCommand, CustomerConfirmationEvidenceSource, CustomerConfirmationTargetRegistry } from './customerConfirmationTypes';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 1, fields: 8, fieldSize: 2 * 1024 * 1024 } }).single('file');

function parseJson<T>(value: unknown, field: string): T {
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { throw new CustomerConfirmationError('INVALID_INPUT', `${field}格式无效。`, 400); }
  }
  if (value && typeof value === 'object') return value as T;
  throw new CustomerConfirmationError('INVALID_INPUT', `缺少${field}。`, 400);
}

function safeJson(value: any): any {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(safeJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeJson(item)]));
  return value;
}

function actorFromRequest(req: Request, res: Response) {
  const actor = extractActorFromRequest(req);
  if (!actor?.userId) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '请登录后登记或查看客户确认。' } });
    return null;
  }
  if ((req as any).authSource === 'api-key') {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '客户确认操作必须由员工登录账号完成。' } });
    return null;
  }
  return actor;
}

function refusal(error: unknown) {
  if (error instanceof CustomerConfirmationError) return { status: error.statusCode, code: error.code, message: error.message };
  const safe = safeRouteError(error, { fallbackCode: 'CUSTOMER_CONFIRMATION_FAILED', fallbackMessage: '客户确认未能保存或读取，请核对原业务和证据后安全重试。' });
  return { status: safe.status, code: safe.code, message: safe.message };
}

async function dispatchUpload(req: Request, res: Response): Promise<void> {
  await new Promise<void>((resolve, reject) => upload(req, res, error => error ? reject(error) : resolve()));
}

function assertCurrentCommand(command: CustomerConfirmationCommand, adapterSnapshot: any) {
  validateCustomerConfirmationCommand(command);
  assertCustomerConfirmationMatchesTarget(command, adapterSnapshot);
}

export interface CustomerConfirmationRouterOptions {
  prisma: PrismaClient;
  targetAdapters: CustomerConfirmationTargetRegistry;
}

export function createCustomerConfirmationRouter(options: CustomerConfirmationRouterOptions): Router {
  const router = Router();
  const { prisma, targetAdapters } = options;

  // Reverse mail entry: discover registered native targets from a source
  // already persisted in Email. The mail read grant and each adapter's native
  // read scope are reloaded for this request; IDs are never accepted from UI
  // without a fresh inspect.
  router.get('/targets', async (req: Request, res: Response) => {
    const prior = actorFromRequest(req, res);
    if (!prior) return;
    try {
      const emailId = typeof req.query.emailId === 'string' ? req.query.emailId.trim() : '';
      const businessReference = typeof req.query.businessReference === 'string' ? req.query.businessReference.trim() : '';
      if (!emailId || emailId.length > 200 || businessReference.length > 200)
        throw new CustomerConfirmationError('INVALID_INPUT', '请重新选择已同步的客户邮件；业务编号需精确填写。', 400);

      const result = await prisma.$transaction(async (tx: any) => {
        const actor = await currentCustomerConfirmationActor(tx, prior, 'emails:read');
        const email = await tx.email.findFirst({ where: { id: emailId, deletedAt: null }, select: {
          id: true, direction: true, orderId: true, relationId: true,
        } });
        if (!email || email.direction !== 'inbound')
          throw new CustomerConfirmationError('NOT_FOUND', '客户来信不存在、已失效或当前无权读取。', 404);

        const candidates: any[] = [];
        for (const adapter of targetAdapters.list()) {
          if (!adapter.searchTargetIds) continue;
          const ids = await adapter.searchTargetIds(tx, actor, { sourceEmail: email, businessReference: businessReference || undefined });
          for (const targetId of ids.slice(0, 40)) {
            try {
              const snapshot = await adapter.inspect(tx, targetId, actor, 'read');
              if (!snapshot?.eligible) continue;
              candidates.push({ targetType: adapter.targetType, targetId, ...snapshot });
            } catch (error) {
              if (error instanceof CustomerConfirmationError && ['FORBIDDEN', 'NOT_FOUND'].includes(error.code)) continue;
              throw error;
            }
          }
        }
        return candidates.slice(0, 20);
      });
      return res.json({ ok: true, emailId, searchMode: businessReference ? 'exact-reference' : 'linked', candidates: safeJson(result) });
    } catch (error) {
      const failure = refusal(error);
      if (failure.status === 403 || failure.status === 404)
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: '邮件或业务事项不存在，或当前无权查看。' } });
      return res.status(failure.status).json({ error: { code: failure.code, message: failure.message } });
    }
  });

  // All source, target, and proof reads remain behind this current target's native read authority.
  router.get('/by-target/:targetType/:targetId', async (req: Request, res: Response) => {
    const prior = actorFromRequest(req, res);
    if (!prior) return;
    try {
      const adapter = targetAdapters.get(req.params.targetType);
      if (!adapter) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '业务事项不存在或当前无权查看。' } });
      const result = await prisma.$transaction(async (tx: any) => {
        const actor = await currentCustomerConfirmationActor(tx, prior);
        const target = await adapter.inspect(tx, req.params.targetId, actor, 'read');
        const rows = await tx.businessConfirmation.findMany({
          where: { targetType: adapter.targetType, targetId: req.params.targetId },
          orderBy: [{ revision: 'desc' }, { recordedAt: 'desc' }],
          include: { evidence: { include: { evidence: { include: { files: { include: { file: true } } } } } },
            supersedes: { select: { id: true, revision: true, outcome: true } } },
        });
        const confirmations = [];
        for (const row of rows) {
          const evidence = [];
          for (const joined of row.evidence ?? []) {
            const item = joined.evidence;
            let sourceAccessible = false;
            try {
              // The already-authorized current target binding grants this source
              // read. Mail evidence additionally keeps the existing mail scope;
              // it never grants access to other targets or the mailbox itself.
              if (item.sourceType === 'email_selection') await currentCustomerConfirmationActor(tx, actor, 'emails:read');
              sourceAccessible = true;
            } catch { sourceAccessible = false; }
            evidence.push({
              id: item.id, sourceType: item.sourceType, sourceFingerprint: item.sourceFingerprint,
              sourceSnapshot: sourceAccessible ? item.sourceSnapshot : null,
              sourceAccessible,
              selectionSnapshot: sourceAccessible ? joined.selectionSnapshot : null,
              files: sourceAccessible ? (item.files ?? []).map((link: any) => ({
                id: link.file.id, purpose: link.purpose, fileName: link.fileName, mimeType: link.mimeType,
                byteSize: link.file.byteSize, sha256: link.file.sha256,
                url: `/api/v1/customer-confirmations/files/${encodeURIComponent(link.file.id)}`,
              })) : [],
            });
          }
          confirmations.push({ ...row, matchesCurrentVersion: row.finalContentFingerprint === target.finalContentFingerprint
            && row.scopeFingerprint === target.scopeFingerprint, evidence });
        }
        const latest = confirmations.find((item: any) => item.matchesCurrentVersion) ?? null;
        return { target, confirmations, latest };
      });
      return res.json(safeJson({ ok: true, target: result.target, confirmations: result.confirmations,
        latest: result.latest }));
    } catch (error) {
      logger.warn('[customer-confirmation] target read denied or failed', { targetType: req.params.targetType, targetId: req.params.targetId,
        actorId: prior.userId, error: error instanceof CustomerConfirmationError ? error.code : 'READ_FAILED' });
      const failure = refusal(error);
      if (failure.status === 403 || failure.status === 404) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '业务事项不存在或当前无权查看。' } });
      return res.status(failure.status).json({ error: { code: failure.code, message: failure.message } });
    }
  });

  // Save evidence and its exact business confirmation in one command. A screenshot
  // must travel with this request; there is intentionally no unbound upload route.
  router.post('/', async (req: Request, res: Response) => {
    const prior = actorFromRequest(req, res);
    if (!prior) return;
    try {
      await dispatchUpload(req, res);
      const command = parseJson<CustomerConfirmationCommand>(req.body?.command, '客户确认信息');
      const source = parseJson<CustomerConfirmationEvidenceSource>(req.body?.source, '证据来源');
      validateCustomerConfirmationCommand(command);
      const adapter = targetAdapters.get(command.targetType);

      const result = await prisma.$transaction(async (tx: any) => {
        let actor = await currentCustomerConfirmationActor(tx, prior);
        const lockKey = `customer-confirmation-idempotency:${actor.userId}:${command.idempotencyKey}`;
        await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text', lockKey);
        actor = await currentCustomerConfirmationActor(tx, prior);
        const previous = await tx.businessConfirmation.findUnique({
          where: { recordedBy_requestKey: { recordedBy: actor.userId, requestKey: command.idempotencyKey } },
        });
        if (previous && (previous.targetType !== command.targetType || previous.targetId !== command.targetId))
          throw new CustomerConfirmationError('IDEMPOTENCY_KEY_REUSED', '本次提交编号已用于不同业务事项，请刷新后重新核对。', 409);
        if (!adapter)
          throw new CustomerConfirmationError('NOT_FOUND', '当前业务事项尚未开放客户确认登记。', 404);

        if (previous) {
          const native = adapter.inspectReplay
            ? await adapter.inspectReplay(tx, command.targetId, actor)
            : await adapter.inspect(tx, command.targetId, actor, 'confirm');
          const prepared = await prepareCustomerConfirmationEvidence({ tx, actor, source, file: (req as any).file ?? null });
          const recorded = await recordBusinessConfirmationInTx(tx, { command, actor, evidence: prepared, ip: req.ip ?? null, now: Date.now() });
          if (!recorded.replayed)
            throw new CustomerConfirmationError('IDEMPOTENCY_KEY_REUSED', '原客户确认回执已变化，请刷新后核对。', 409);
          return { ...recorded, actor, nativeStatus: native.nativeStatus,
            nativeEffect: { status: 'recorded', replayed: true } };
        }

        const native = await adapter.inspect(tx, command.targetId, actor, 'confirm');
        assertCurrentCommand(command, native);
        if (command.outcome === 'partial') {
          if (!adapter.validateDecisionScope)
            throw new CustomerConfirmationError('INVALID_INPUT', '当前业务事项尚未开放逐项部分确认。', 409);
          await adapter.validateDecisionScope(tx, { targetId: command.targetId, actor, command, snapshot: native });
        }
        const prepared = await prepareCustomerConfirmationEvidence({ tx, actor, source, file: (req as any).file ?? null });
        let persisted: Awaited<ReturnType<typeof persistPreparedCustomerEvidenceBlobsInTx>> | null = null;
        try {
          const now = Date.now();
          persisted = await persistPreparedCustomerEvidenceBlobsInTx(tx, prepared, actor, now);
          const recorded = await recordBusinessConfirmationInTx(tx, { command, actor, evidence: prepared, ip: req.ip ?? null, now });
          const nativeRecord = await adapter.onRecordedInTx(tx, { targetId: command.targetId, actor, command, confirmation: recorded.confirmation });
          return { ...recorded, actor, nativeStatus: nativeRecord.nativeStatus, nativeEffect: nativeRecord.effect };
        } catch (error) {
          if (persisted?.newlyCreatedStorageKeys.length)
            await removeNewlyCreatedFilesWhileLocked(persisted.newlyCreatedStorageKeys);
          throw error;
        }
      });
      if (!adapter) throw new CustomerConfirmationError('NOT_FOUND', '当前业务事项尚未开放客户确认登记。', 404);
      let continuation: { nativeStatus: unknown; effect?: unknown } | null = null;
      let continuationFailure: { code: string; message: string } | null = null;
      if (adapter.continueAfterRecord) {
        try {
          continuation = await adapter.continueAfterRecord({ targetId: command.targetId, actor: result.actor,
            command, confirmation: result.confirmation });
        } catch (error: any) {
          continuationFailure = {
            code: error instanceof CustomerConfirmationError ? error.code : 'NATIVE_CONTINUATION_FAILED',
            message: error instanceof CustomerConfirmationError ? error.message : '客户确认已登记，业务续办尚未完成，可安全重试。',
          };
        }
      }
      const effectStatus = (continuation?.effect as any)?.status;
      const continuationStatus = continuationFailure || effectStatus === 'failed' || effectStatus === 'pending'
        ? 'pending' : adapter.continueAfterRecord ? 'completed' : 'not_applicable';
      return res.status(result.replayed ? 200 : 201).json(safeJson({ ok: true, saved: true, confirmation: result.confirmation,
        evidenceId: (result as any).evidence?.id ?? null, replayed: result.replayed,
        nativeStatus: continuation?.nativeStatus ?? result.nativeStatus,
        effect: continuation?.effect ?? result.nativeEffect ?? null,
        continuationStatus, continuationFailure }));
    } catch (error: any) {
      if (error instanceof multer.MulterError) {
        return res.status(400).json({ error: { code: 'INVALID_FILE', message: '截图超过 12MB 或上传格式无效，请重新选择原件。' } });
      }
      logger.warn('[customer-confirmation] record failed', { actorId: prior.userId, error: error instanceof CustomerConfirmationError ? error.code : 'RECORD_FAILED' });
      if (error?.code === 'P2002') {
        return res.status(409).json({ error: { code: 'VERSION_ALREADY_CONFIRMED', message: '该业务版本刚刚已有确认记录，请刷新当前业务状态后核对。' } });
      }
      const failure = refusal(error);
      return res.status(failure.status).json({ error: { code: failure.code, message: failure.message } });
    }
  });

  // Files remain private. Access requires the current authority of a business
  // target to which this exact source is bound and, for mail, emails:read.
  router.get('/files/:fileId', async (req: Request, res: Response) => {
    const prior = actorFromRequest(req, res);
    if (!prior) return;
    try {
      const found = await prisma.$transaction(async (tx: any) => {
        const actor = await currentCustomerConfirmationActor(tx, prior);
        const file = await tx.customerEvidenceFile.findUnique({ where: { id: req.params.fileId } });
        if (!file) return null;
        const links = await tx.customerEvidenceFileLink.findMany({
          where: { fileId: file.id }, include: { evidence: { include: { confirmations: { include: { confirmation: true } } } } },
        });
        let permitted = false;
        for (const link of links) {
          const evidence = link.evidence;
          if (evidence.sourceType === 'email_selection') {
            try { await currentCustomerConfirmationActor(tx, actor, 'emails:read'); }
            catch { continue; }
          }
          for (const binding of evidence.confirmations ?? []) {
            const confirmation = binding.confirmation;
            const adapter = targetAdapters.get(confirmation.targetType);
            if (!adapter) continue;
            try {
              await adapter.inspect(tx, confirmation.targetId, actor, 'read');
              permitted = true;
              break;
            } catch { /* continue checking another preserved business binding */ }
          }
          if (permitted) break;
        }
        if (!permitted) return null;
        return file;
      });
      if (!found) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '证据原件不存在或当前无权访问。' } });
      const bytes = await readCustomerEvidenceFile(found.storageKey);
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== found.sha256 || bytes.length !== found.byteSize)
        return res.status(409).json({ error: { code: 'EVIDENCE_VERSION_MISMATCH', message: '证据原件与登记版本不一致。' } });
      const name = path.basename(String(found.storageKey).split('/').pop() || 'evidence');
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
      res.setHeader('Cache-Control', 'private, no-store');
      return res.send(bytes);
    } catch (error) {
      const failure = refusal(error);
      if (failure.status === 403 || failure.status === 404) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '证据原件不存在或当前无权访问。' } });
      return res.status(failure.status).json({ error: { code: failure.code, message: failure.message } });
    }
  });

  return router;
}
