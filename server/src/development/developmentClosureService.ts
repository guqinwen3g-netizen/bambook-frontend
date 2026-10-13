import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { readDevelopmentExpenseSnapshot } from './developmentExpenseSnapshot';
import { DEVELOPMENT_SAMPLE_TYPES } from './developmentSampleScope';

/** Shared lifecycle/review operations; callers supply transaction-scoped case authorization. */
export type DevelopmentClosureContext = {
  prisma: any; actorId: string;
  authorize: (tx: any, caseId: string) => Promise<unknown>;
};
const json = (value: unknown): any => JSON.parse(JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? String(v) : v));
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(json(value))).digest('hex');
function reject(code: string, message: string, status = 409): never {
  throw Object.assign(new Error(message), { code, status, httpStatus: status, statusCode: status });
}
function text(value: unknown, label: string, max = 4000): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) reject('INVALID_INPUT', `${label}未填写或过长`, 400);
  return value.trim();
}
async function inCase<T>(context: DevelopmentClosureContext, caseId: string, work: (tx: any) => Promise<T>): Promise<T> {
  text(context.actorId, '操作人', 200); text(caseId, '开发案', 200);
  return context.prisma.$transaction(async (tx: any) => {
    await context.authorize(tx, caseId);
    const rows = await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id" = ${caseId} AND "deletedAt" IS NULL FOR UPDATE`);
    if (!rows.length) reject('NOT_FOUND', '开发案不存在或不可访问', 404);
    await context.authorize(tx, caseId);
    return work(tx);
  });
}
async function latestLifecycle(tx: any, caseId: string) {
  return tx.developmentLifecycleEvent.findFirst({ where: { developmentCaseId: caseId }, orderBy: { revision: 'desc' } });
}
async function lifecycleSnapshot(tx: any, caseId: string) {
  const development = await tx.developmentCase.findFirst({ where: { id: caseId, deletedAt: null },
    select: { id: true, type: true, stage: true, updatedAt: true, customerRelationId: true, productAssetId: true, currentRound: true } });
  if (!development) reject('NOT_FOUND', '开发案不存在或不可访问', 404);
  const [latest, batches, seals, samples, pending] = await Promise.all([
    latestLifecycle(tx, caseId),
    tx.sampleBatch.findMany({ where: { developmentCaseId: caseId, deletedAt: null }, orderBy: { id: 'asc' },
      select: { id: true, batchCode: true, status: true, confirmStatus: true, updatedAt: true } }),
    tx.sealSample.findMany({ where: { developmentCaseId: caseId, deletedAt: null }, orderBy: { id: 'asc' },
      select: { id: true, sealCode: true, status: true, updatedAt: true } }),
    tx.sample.findMany({ where: { sourceCaseId: caseId, type: { in: DEVELOPMENT_SAMPLE_TYPES }, deletedAt: null }, orderBy: { id: 'asc' },
      select: { id: true, code: true, type: true, status: true, updatedAt: true } }),
    tx.developmentPendingExpense.findMany({ where: { developmentCaseId: caseId, status: 'pending' }, orderBy: { id: 'asc' },
      select: { id: true, description: true, ownerId: true, expectedDate: true, version: true } }),
  ]);
  const openItems = [
    ...batches.filter((r: any) => r.status !== 'approved').map((r: any) => ({ type: 'SampleBatch', id: r.id, label: r.batchCode, status: r.status })),
    ...seals.filter((r: any) => r.status === 'draft').map((r: any) => ({ type: 'SealSample', id: r.id, label: r.sealCode, status: r.status })),
    ...samples.filter((r: any) => !['confirmed', 'sealed', 'approved'].includes(r.status)).map((r: any) => ({ type: 'Sample', id: r.id, label: r.code, status: r.status })),
    ...pending.map((r: any) => ({ type: 'PendingExpense', id: r.id, label: r.description, status: 'pending', ownerId: r.ownerId, expectedDate: r.expectedDate })),
  ];
  const snapshot = json({ development, lifecycleEventId: latest?.id ?? null, revision: latest?.revision ?? 0,
    state: latest?.state ?? 'active', batches, seals, samples, pending, openItems });
  return { ...snapshot, fingerprint: fingerprint(snapshot) };
}
export async function previewDevelopmentClosure(context: DevelopmentClosureContext, caseId: string) {
  return inCase(context, caseId, tx => lifecycleSnapshot(tx, caseId));
}

export async function recordDevelopmentLifecycle(context: DevelopmentClosureContext, caseId: string, input: {
  action: 'pause' | 'resume' | 'close'; outcome?: 'completed' | 'stopped'; reason: string; disposition?: string;
  expectedRevision: number; expectedFingerprint: string; requestKey: string;
}) {
  const requestKey = text(input.requestKey, '请求标识', 200);
  const reason = text(input.reason, '原因');
  const disposition = input.disposition === undefined ? null : text(input.disposition, '未完事项安排');
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) reject('INVALID_INPUT', '版本无效', 400);
  text(input.expectedFingerprint, '页面摘要', 64);
  if (!['pause', 'resume', 'close'].includes(input.action)) reject('INVALID_INPUT', '操作无效', 400);
  if (input.action === 'close' ? !['completed', 'stopped'].includes(input.outcome ?? '') : input.outcome !== undefined) reject('INVALID_INPUT', '结案结果无效', 400);
  const normalized = { action: input.action, outcome: input.outcome ?? null, reason, disposition,
    expectedRevision: input.expectedRevision, expectedFingerprint: input.expectedFingerprint };
  const requestFingerprint = fingerprint(normalized);
  return inCase(context, caseId, async tx => {
    const existing = await tx.developmentLifecycleEvent.findUnique({ where: { developmentCaseId_requestKey: { developmentCaseId: caseId, requestKey } } });
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) reject('REQUEST_CONFLICT', '请求标识已用于其他内容');
      return existing;
    }
    const snapshot = await lifecycleSnapshot(tx, caseId);
    if (snapshot.revision !== input.expectedRevision || snapshot.fingerprint !== input.expectedFingerprint) reject('STALE_VERSION', '开发信息或未完事项已变化，请重新核对');
    const allowed = input.action === 'pause' ? snapshot.state === 'active'
      : input.action === 'resume' ? ['paused', 'closed'].includes(snapshot.state) : ['active', 'paused'].includes(snapshot.state);
    if (!allowed) reject('INVALID_LIFECYCLE_TRANSITION', '当前状态不能执行该操作');
    // Closing records the business owner's explicit decision. Product eligibility
    // and customer/QC decisions retain their own gates and are never inferred here.
    if (input.action === 'close' && snapshot.openItems.length && !disposition) reject('DISPOSITION_REQUIRED', '请明确未完样品和待到费用的后续处理安排');
    const row = await tx.developmentLifecycleEvent.create({ data: {
      id: randomUUID(), developmentCaseId: caseId, revision: snapshot.revision + 1,
      action: input.action, state: input.action === 'pause' ? 'paused' : input.action === 'resume' ? 'active' : 'closed',
      outcome: input.outcome ?? null, reason, disposition, snapshot,
      requestKey, requestFingerprint, createdBy: context.actorId, createdAt: BigInt(Date.now()),
    } });
    await writeRouteAuditLog({ prisma: tx, actorId: context.actorId, source: 'development:lifecycle', operation: `development_${input.action}`,
      targetType: 'DevelopmentCase', targetId: caseId,
      before: { state: snapshot.state, revision: snapshot.revision },
      after: { eventId: row.id, state: row.state, revision: row.revision, outcome: row.outcome, reason, disposition } });
    return row;
  });
}

async function reviewSnapshot(tx: any, caseId: string) {
  const [lifecycle, costs, pending] = await Promise.all([
    latestLifecycle(tx, caseId), readDevelopmentExpenseSnapshot(tx, caseId),
    tx.developmentPendingExpense.findMany({ where: { developmentCaseId: caseId }, orderBy: { id: 'asc' },
      select: { id: true, status: true, version: true, costRecordId: true, resolutionNote: true, description: true, ownerId: true, expectedDate: true } }),
  ]);
  const snapshot = json({ lifecycleEventId: lifecycle?.id ?? null, lifecycleState: lifecycle?.state ?? 'active', costs, pending });
  return { snapshot, fingerprint: fingerprint(snapshot), pendingCount: pending.filter((p: any) => p.status === 'pending').length };
}
export async function previewDevelopmentExpenseReview(context: DevelopmentClosureContext, caseId: string) {
  return inCase(context, caseId, async tx => {
    const current = await reviewSnapshot(tx, caseId);
    const rows = await tx.developmentExpenseReview.findMany({ where: { developmentCaseId: caseId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 20,
      select: { id: true, fingerprint: true, note: true, createdBy: true, createdAt: true } });
    const users = rows.length ? await tx.userAccount.findMany({ where: { id: { in: [...new Set(rows.map((row: any) => row.createdBy))] } }, select: { id: true, displayName: true } }) : [];
    const history = rows.map((row: any) => ({ ...row, createdByName: users.find((u: any) => u.id === row.createdBy)?.displayName ?? row.createdBy,
      current: row.fingerprint === current.fingerprint }));
    return { ...current, history: json(history), hasCurrentReview: history.some((row: any) => row.current) };
  });
}
export async function confirmDevelopmentExpenseReview(context: DevelopmentClosureContext, caseId: string, input: {
  expectedFingerprint: string; requestKey: string; note: string;
}) {
  const requestKey = text(input.requestKey, '请求标识', 200), note = text(input.note, '核对说明');
  text(input.expectedFingerprint, '费用摘要', 64);
  const requestFingerprint = fingerprint({ expectedFingerprint: input.expectedFingerprint, note });
  return inCase(context, caseId, async tx => {
    const previous = await tx.developmentExpenseReview.findUnique({ where: { developmentCaseId_requestKey: { developmentCaseId: caseId, requestKey } } });
    if (previous) {
      if (previous.requestFingerprint !== requestFingerprint) reject('REQUEST_CONFLICT', '请求标识已用于其他内容');
      return previous;
    }
    const current = await reviewSnapshot(tx, caseId);
    if (current.snapshot.lifecycleState !== 'closed') reject('CASE_NOT_CLOSED', '请先明确结束开发，再核齐整案费用');
    if (current.pendingCount) reject('EXPENSES_PENDING', '还有待到账单，不能确认费用完整');
    if (current.snapshot.costs.unresolvedProductionExpenses.length) reject('EXPENSE_SCOPE_UNRESOLVED', '关联生产样存在费用，请先核实开发与订单费用归属');
    if (current.snapshot.costs.unsupportedCurrencies.length) reject('UNSUPPORTED_CURRENCY', '存在尚未支持的费用币种，需先明确处理');
    if (current.fingerprint !== input.expectedFingerprint) reject('STALE_VERSION', '费用或处理依据已变化，请重新核对');
    const row = await tx.developmentExpenseReview.create({ data: {
      id: randomUUID(), developmentCaseId: caseId, lifecycleEventId: current.snapshot.lifecycleEventId,
      fingerprint: current.fingerprint, snapshot: current.snapshot, note, requestKey, requestFingerprint,
      createdBy: context.actorId, createdAt: BigInt(Date.now()),
    } });
    await writeRouteAuditLog({ prisma: tx, actorId: context.actorId, source: 'development:expense-review', operation: 'confirm_development_expense_review',
      targetType: 'DevelopmentExpenseReview', targetId: row.id,
      after: { developmentCaseId: caseId, lifecycleEventId: row.lifecycleEventId, fingerprint: row.fingerprint, note } });
    return row;
  });
}
/** Call from the SAME locked transaction that creates/changes a billing decision or invoice. */
export async function assertDevelopmentExpenseReviewCurrentInTx(tx: any, caseId: string, reviewId: string) {
  const review = await tx.developmentExpenseReview.findFirst({ where: { id: reviewId, developmentCaseId: caseId } });
  if (!review) reject('REVIEW_REQUIRED', '缺少本案费用核齐记录');
  const current = await reviewSnapshot(tx, caseId);
  if (current.snapshot.lifecycleState !== 'closed' || current.pendingCount || current.fingerprint !== review.fingerprint || current.snapshot.lifecycleEventId !== review.lifecycleEventId) reject('REVIEW_STALE', '费用核齐依据已变化，请重新核齐');
  return review;
}
