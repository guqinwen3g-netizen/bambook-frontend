import { businessNowMs } from '../shared/businessClock';
import crypto from 'crypto';
import { createPermissionService, hasScope } from '../auth/permissionService';
import type { TokenPayload } from '../auth/service';
import type {
  CustomerConfirmationCommand,
  CustomerConfirmationTargetAdapter,
  CustomerConfirmationTargetRegistry,
  PreparedCustomerEvidence,
} from './customerConfirmationTypes';

const FINGERPRINT = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export type CustomerConfirmationErrorCode =
  | 'UNAUTHORIZED' | 'ACCOUNT_DISABLED' | 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID_INPUT'
  | 'VERSION_MISMATCH' | 'VERSION_ALREADY_CONFIRMED' | 'IDEMPOTENCY_KEY_REUSED'
  | 'INVALID_CORRECTION' | 'CUSTOMER_CONFIRMATION_REQUIRED' | 'AUTHORIZATION_UNAVAILABLE';

export class CustomerConfirmationError extends Error {
  constructor(readonly code: CustomerConfirmationErrorCode, message: string, readonly statusCode: number) {
    super(message);
    this.name = 'CustomerConfirmationError';
  }
}

function refuse(code: CustomerConfirmationErrorCode, message: string, status: number): never {
  throw new CustomerConfirmationError(code, message, status);
}

function normalize(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, normalize(record[key])]));
  }
  return value;
}

export function canonicalCustomerConfirmationJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function customerConfirmationSha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function createCustomerConfirmationTargetRegistry(
  adapters: CustomerConfirmationTargetAdapter[] = [],
): CustomerConfirmationTargetRegistry {
  const byType = new Map<string, CustomerConfirmationTargetAdapter>();
  for (const adapter of adapters) {
    if (!adapter.targetType || byType.has(adapter.targetType)) throw new Error('Duplicate or invalid customer confirmation target adapter');
    byType.set(adapter.targetType, adapter);
  }
  return {
    get: targetType => byType.get(targetType),
    list: () => [...byType.values()],
  };
}

/** Resolve current DB grants every time; a signed JWT is identity, never current authority. */
export async function currentCustomerConfirmationActor(
  prisma: any,
  prior: TokenPayload | null | undefined,
  requiredScope?: string,
): Promise<TokenPayload> {
  if (!prior?.userId) refuse('UNAUTHORIZED', '请登录后登记或查看客户确认。', 401);
  let context: any;
  try {
    context = await createPermissionService({ prisma }).getUserPermissionContext(prior.userId);
  } catch {
    refuse('AUTHORIZATION_UNAVAILABLE', '当前账号权限暂时无法核验，请稍后重试。', 503);
  }
  if (!context) refuse('ACCOUNT_DISABLED', '当前账号已失效，请重新登录。', 401);
  const actor: TokenPayload = {
    userId: context.userId,
    roles: context.legacyRoleCodes,
    roleIds: context.roleIds,
    permissions: context.scopes,
    departmentIds: context.departmentIds,
    authorizationLoaded: true,
    ...(prior.permissionCeiling === undefined ? {} : { permissionCeiling: [...prior.permissionCeiling] }),
  };
  if (requiredScope && !hasScope(actor, requiredScope as any))
    refuse('FORBIDDEN', `当前账号没有 ${requiredScope} 权限。`, 403);
  return actor;
}

export function validateCustomerConfirmationCommand(command: CustomerConfirmationCommand): void {
  if (!command || typeof command !== 'object' || Array.isArray(command)) refuse('INVALID_INPUT', '客户确认数据不完整。', 400);
  if (typeof command.targetType !== 'string' || !command.targetType.trim()
    || typeof command.targetId !== 'string' || !command.targetId.trim()) refuse('INVALID_INPUT', '必须选择具体业务事项。', 400);
  if (!FINGERPRINT.test(command.finalContentFingerprint) || !FINGERPRINT.test(command.scopeFingerprint))
    refuse('INVALID_INPUT', '客户确认版本或范围无法核验，请重新打开当前最终版本。', 400);
  if (command.internalApprovalId !== null && (typeof command.internalApprovalId !== 'string' || !command.internalApprovalId.trim()))
    refuse('INVALID_INPUT', '内部审批关联无效。', 400);
  if (!['accepted', 'rejected', 'partial'].includes(command.outcome)) refuse('INVALID_INPUT', '请选择客户实际答复结果。', 400);
  if (command.scope === undefined || canonicalCustomerConfirmationJson(command.scope).length > 200_000)
    refuse('INVALID_INPUT', '客户确认范围缺失或过大。', 400);
  if (command.outcome === 'partial') {
    if (command.decisionScope == null || canonicalCustomerConfirmationJson(command.decisionScope).length > 100_000)
      refuse('INVALID_INPUT', '部分接受必须列明客户已确认与仍待确认的范围。', 400);
  } else if (command.decisionScope != null) {
    refuse('INVALID_INPUT', '只有部分确认可以携带逐项确认范围。', 400);
  }
  if (!['email', 'screenshot', 'phone', 'meeting', 'other'].includes(command.channel)) refuse('INVALID_INPUT', '客户沟通渠道无效。', 400);
  if (typeof command.customerName !== 'string' || !command.customerName.trim() || command.customerName.trim().length > 200)
    refuse('INVALID_INPUT', '请登记作出答复的客户联系人。', 400);
  if (command.customerAddress != null && (typeof command.customerAddress !== 'string' || command.customerAddress.length > 320))
    refuse('INVALID_INPUT', '客户联系方式过长或无效。', 400);
  const confirmed = Date.parse(command.confirmedAt);
  if (!Number.isFinite(confirmed) || confirmed > businessNowMs() + 5 * 60_000) refuse('INVALID_INPUT', '客户答复时间无法核验。', 400);
  if (!UUID.test(command.idempotencyKey)) refuse('INVALID_INPUT', '本次提交编号无效，请重新提交。', 400);
  if (command.supersedesConfirmationId != null && typeof command.supersedesConfirmationId !== 'string')
    refuse('INVALID_CORRECTION', '要更正的历史客户确认编号无效。', 400);
  if (command.correctionReason != null && (typeof command.correctionReason !== 'string' || command.correctionReason.trim().length > 2000))
    refuse('INVALID_CORRECTION', '更正说明无效。', 400);
}

export function assertCustomerConfirmationMatchesTarget(command: CustomerConfirmationCommand, snapshot: any): void {
  if (!snapshot?.eligible
    || command.finalContentFingerprint !== snapshot.finalContentFingerprint
    || command.internalApprovalId !== (snapshot.internalApprovalId ?? null)
    || command.scopeFingerprint !== snapshot.scopeFingerprint
    || canonicalCustomerConfirmationJson(command.scope) !== canonicalCustomerConfirmationJson(snapshot.scope)) {
    refuse('VERSION_MISMATCH', '客户答复证据对应的内容或范围与当前内部最终版本不一致，请重新核对并取得客户对当前版本的答复。', 409);
  }
}

export interface RecordCustomerConfirmationInTxInput {
  command: CustomerConfirmationCommand;
  actor: TokenPayload;
  evidence: PreparedCustomerEvidence;
  ip?: string | null;
  now?: number;
}

/**
 * Append a confirmation and bind all source material in the same DB transaction.
 * A caller must already have run its registered target adapter's current
 * authorization/version check inside this transaction.
 */
export async function recordBusinessConfirmationInTx(tx: any, input: RecordCustomerConfirmationInTxInput) {
  const { command, actor, evidence } = input;
  validateCustomerConfirmationCommand(command);
  if (!actor?.userId || actor.authorizationLoaded !== true) refuse('UNAUTHORIZED', '客户确认登记必须使用服务端核验过的当前账号。', 401);
  if (!evidence?.sourceFingerprint || !FINGERPRINT.test(evidence.sourceFingerprint)) refuse('INVALID_INPUT', '证据原件版本无法核验。', 400);

  const requestFingerprint = customerConfirmationSha256(canonicalCustomerConfirmationJson({
    targetType: command.targetType, targetId: command.targetId,
    finalContentFingerprint: command.finalContentFingerprint, internalApprovalId: command.internalApprovalId,
    scopeFingerprint: command.scopeFingerprint, scope: command.scope, outcome: command.outcome,
    decisionScope: command.decisionScope ?? null,
    customerName: command.customerName.trim(), customerAddress: command.customerAddress?.trim() || null,
    confirmedAt: new Date(command.confirmedAt).toISOString(), channel: command.channel,
    sourceFingerprint: evidence.sourceFingerprint, selectionSnapshot: evidence.selectionSnapshot,
    supersedesConfirmationId: command.supersedesConfirmationId ?? null,
    correctionReason: command.correctionReason?.trim() || null,
  }));

  const findReplay = async () => {
    const prior = await tx.businessConfirmation.findUnique({
      where: { recordedBy_requestKey: { recordedBy: actor.userId, requestKey: command.idempotencyKey } },
    });
    if (!prior) return null;
    if (prior.requestFingerprint !== requestFingerprint)
      refuse('IDEMPOTENCY_KEY_REUSED', '本次提交编号已用于不同内容，请刷新后重新核对。', 409);
    const link = await tx.businessConfirmationEvidence.findFirst({
      where: { confirmationId: prior.id }, include: { evidence: true },
    });
    return { confirmation: prior, evidence: link?.evidence ?? null, replayed: true as const };
  };
  const existingReplay = await findReplay();
  if (existingReplay) return existingReplay;

  const versionLockKey = `customer-confirmation-version:${command.targetType}:${command.targetId}:${command.finalContentFingerprint}:${command.scopeFingerprint}`;
  await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text', versionLockKey);

  // A concurrent exact retry may have committed while this transaction waited
  // for the version lock. Return its append-only fact instead of a duplicate
  // version conflict; changed reuse of the same key still fails above.
  const replayAfterLock = await findReplay();
  if (replayAfterLock) return replayAfterLock;

  const latest = await tx.businessConfirmation.findFirst({
    where: {
      targetType: command.targetType, targetId: command.targetId,
      finalContentFingerprint: command.finalContentFingerprint, scopeFingerprint: command.scopeFingerprint,
    }, orderBy: { revision: 'desc' },
  });
  let revision = 1;
  if (latest) {
    const correction = command.supersedesConfirmationId === latest.id && !!command.correctionReason?.trim();
    if (!correction) refuse('VERSION_ALREADY_CONFIRMED', '该业务版本与确认范围已有记录；如需更正，请引用原记录并说明原因。', 409);
    revision = latest.revision + 1;
  } else if (command.supersedesConfirmationId || command.correctionReason?.trim()) {
    refuse('INVALID_CORRECTION', '找不到本次要更正的原客户确认记录。', 409);
  }

  const confirmationId = `BCF__${crypto.randomUUID()}`;
  const auditId = `alog_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;
  const now = input.now ?? Date.now();
  const confirmation = await tx.businessConfirmation.create({ data: {
    id: confirmationId,
    targetType: command.targetType,
    targetId: command.targetId,
    finalContentFingerprint: command.finalContentFingerprint,
    internalApprovalId: command.internalApprovalId,
    scopeFingerprint: command.scopeFingerprint,
    scope: command.scope as any,
    decisionScope: command.decisionScope == null ? undefined : command.decisionScope as any,
    outcome: command.outcome,
    customerName: command.customerName.trim(),
    customerAddress: command.customerAddress?.trim() || null,
    confirmedAt: BigInt(new Date(command.confirmedAt).getTime()),
    channel: command.channel,
    recordedBy: actor.userId,
    recordedAt: BigInt(now),
    requestKey: command.idempotencyKey,
    requestFingerprint,
    revision,
    supersedesId: latest?.id ?? null,
    correctionReason: latest ? command.correctionReason!.trim() : null,
    auditId,
  } });

  await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text', `customer-evidence-source:${evidence.sourceFingerprint}`);
  let evidenceRow = await tx.customerEvidence.findUnique({ where: { sourceFingerprint: evidence.sourceFingerprint } });
  if (!evidenceRow) {
    evidenceRow = await tx.customerEvidence.create({ data: {
      id: `CEV__${crypto.randomUUID()}`,
      sourceType: evidence.sourceType,
      sourceFingerprint: evidence.sourceFingerprint,
      sourceSnapshot: evidence.sourceSnapshot as any,
      originTargetType: command.targetType,
      originTargetId: command.targetId,
      originConfirmationId: confirmationId,
      createdBy: actor.userId,
      createdAt: BigInt(now),
    } });
  } else if (evidenceRow.sourceType !== evidence.sourceType
    || canonicalCustomerConfirmationJson(evidenceRow.sourceSnapshot) !== canonicalCustomerConfirmationJson(evidence.sourceSnapshot)) {
    // A digest match must never silently substitute a different source snapshot.
    refuse('VERSION_MISMATCH', '证据原件摘要冲突，未保存本次客户确认。', 409);
  }

  for (const blob of evidence.blobs) {
    const storedBlob = await tx.customerEvidenceFile.findUnique({ where: { sha256: blob.sha256 } });
    if (!storedBlob || storedBlob.storageKey !== blob.storageKey || storedBlob.byteSize !== blob.byteSize)
      refuse('VERSION_MISMATCH', '证据文件原件尚未在本次事务内完成核验，未保存本次客户确认。', 409);
    const linkExists = await tx.customerEvidenceFileLink.findFirst({
      where: { evidenceId: evidenceRow.id, fileId: storedBlob.id, purpose: blob.purpose, sourceAttachmentId: blob.sourceAttachmentId ?? null },
    });
    if (!linkExists) await tx.customerEvidenceFileLink.create({ data: {
      id: `CEFL__${crypto.randomUUID()}`, evidenceId: evidenceRow.id, fileId: storedBlob.id,
      purpose: blob.purpose, sourceAttachmentId: blob.sourceAttachmentId ?? null,
      fileName: blob.fileName, mimeType: blob.mimeType, metadataSnapshot: blob.metadataSnapshot as any,
    } });
  }

  const attachedEvidence = await tx.businessConfirmationEvidence.findFirst({
    where: { confirmationId, evidenceId: evidenceRow.id },
  });
  if (!attachedEvidence) await tx.businessConfirmationEvidence.create({ data: {
    id: `BCFE__${crypto.randomUUID()}`, confirmationId, evidenceId: evidenceRow.id,
    selectionSnapshot: evidence.selectionSnapshot as any,
  } });

  await tx.auditLog.create({ data: {
    id: auditId, actorId: actor.userId, action: 'business_customer_confirmation_recorded',
    targetType: 'BusinessConfirmation', targetId: confirmationId,
    detail: {
      targetType: command.targetType, targetId: command.targetId,
      finalContentFingerprint: command.finalContentFingerprint, internalApprovalId: command.internalApprovalId,
      scopeFingerprint: command.scopeFingerprint, outcome: command.outcome,
      decisionScope: command.decisionScope ?? null,
      evidenceId: evidenceRow.id, sourceType: evidence.sourceType, requestFingerprint,
      supersedesId: latest?.id ?? null, correctionReason: latest ? command.correctionReason!.trim() : null,
    } as any,
    ip: input.ip ?? null, operationType: latest ? 'update' : 'create',
    transactionId: command.idempotencyKey,
  } });
  return { confirmation, evidence: evidenceRow, replayed: false };
}

export interface AssertFinalCustomerConfirmationInput {
  targetType: string;
  targetId: string;
  actor: TokenPayload;
  finalContentFingerprint: string;
  internalApprovalId: string | null;
  scopeFingerprint: string;
  requiredScope?: unknown;
}

/** A native apply transaction calls this after locking and re-reading its own target facts. */
export async function assertFinalCustomerConfirmationInTx(tx: any, input: AssertFinalCustomerConfirmationInput) {
  if (!input.actor?.userId || input.actor.authorizationLoaded !== true) refuse('UNAUTHORIZED', '生效前必须重新核验当前账号权限。', 401);
  const latest = await tx.businessConfirmation.findFirst({
    where: {
      targetType: input.targetType, targetId: input.targetId,
      finalContentFingerprint: input.finalContentFingerprint,
      scopeFingerprint: input.scopeFingerprint,
    }, orderBy: { revision: 'desc' },
  });
  if (!latest || latest.outcome !== 'accepted' || latest.internalApprovalId !== input.internalApprovalId
    || (input.requiredScope !== undefined && canonicalCustomerConfirmationJson(latest.scope) !== canonicalCustomerConfirmationJson(input.requiredScope))) {
    refuse('CUSTOMER_CONFIRMATION_REQUIRED', '该内部批准版本尚无匹配的客户接受证据，订单未应用本次变更。', 409);
  }
  const links = await tx.businessConfirmationEvidence.findMany({
    where: { confirmationId: latest.id }, include: { evidence: { include: { files: true } } },
  });
  if (!links.length || links.some((link: any) => !link.evidence?.sourceFingerprint || !link.evidence?.sourceSnapshot))
    refuse('CUSTOMER_CONFIRMATION_REQUIRED', '客户确认原件关联不完整，订单未应用本次变更。', 409);
  if (links.some((link: any) => link.evidence.sourceType === 'screenshot'
    && !link.evidence.files?.some((fileLink: any) => fileLink.purpose === 'screenshot')))
    refuse('CUSTOMER_CONFIRMATION_REQUIRED', '客户截图原件无法核对，订单未应用本次变更。', 409);
  const audit = await tx.auditLog.findUnique({ where: { id: latest.auditId } });
  if (!audit || audit.action !== 'business_customer_confirmation_recorded' || audit.targetId !== latest.id || audit.actorId !== latest.recordedBy)
    refuse('CUSTOMER_CONFIRMATION_REQUIRED', '客户确认审计事实无法核对，订单未应用本次变更。', 409);
  return { confirmation: latest, evidence: links.map((link: any) => link.evidence) };
}
