import { isValidLocalDateKey } from '../shared/localDate';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { createCostRecordInTx, COST_TYPES } from '../finance/billingItemService';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { DEVELOPMENT_SAMPLE_TYPES } from './developmentSampleScope';

// Internal service: all callers must supply live, transaction-scoped authorization.
type Context = {
  prisma: any; actorId: string;
  authorize: (tx: any, caseId: string) => Promise<unknown>;
  authorizeAssignee: (tx: any, caseId: string, userId: string) => Promise<unknown>;
};
function reject(code: string, message: string, status = 400): never {
  throw Object.assign(new Error(message), { code, status, httpStatus: status, statusCode: status });
}
function required(value: unknown, name: string, max = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) reject('INVALID_INPUT', `${name}未填写或过长`);
  return value.trim();
}
function date(value: unknown, name: string, optional = false): string | null {
  if (optional && (value === undefined || value === null || value === '')) return null;
  const text = required(value, name, 10);
  if (!isValidLocalDateKey(text)) reject('INVALID_INPUT', `${name}无效`);
  return text;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function locked<T>(context: Context, caseId: string, action: (tx: any) => Promise<T>): Promise<T> {
  required(context.actorId, '操作人', 200);
  required(caseId, '开发案', 200);
  return context.prisma.$transaction(async (tx: any) => {
    // Authorization before lookup, and again after the lock to catch changes to customer linkage.
    await context.authorize(tx, caseId);
    const rows = await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id" = ${caseId} AND "deletedAt" IS NULL FOR UPDATE`);
    if (!rows.length) reject('NOT_FOUND', '开发案不存在或不可访问', 404);
    await context.authorize(tx, caseId);
    return action(tx);
  });
}
async function assertSource(tx: any, caseId: string, type: string, id: string) {
  if (type === 'DevelopmentCase' && id === caseId) return;
  const source = type === 'SampleBatch' ? await tx.sampleBatch.findFirst({ where: { id, developmentCaseId: caseId, deletedAt: null } })
    : type === 'Sample' ? await tx.sample.findFirst({ where: { id, sourceCaseId: caseId, type: { in: DEVELOPMENT_SAMPLE_TYPES }, deletedAt: null } })
    : type === 'SealSample' ? await tx.sealSample.findFirst({ where: { id, developmentCaseId: caseId, deletedAt: null } }) : null;
  if (!source) reject('INVALID_SOURCE', '费用来源不属于当前开发案');
}
async function audit(tx: any, actorId: string, operation: string, row: any) {
  await writeRouteAuditLog({ prisma: tx, actorId, source: 'development:pending-expense', operation,
    targetType: 'DevelopmentPendingExpense', targetId: row.id,
    after: { developmentCaseId: row.developmentCaseId, status: row.status, version: row.version,
      costRecordId: row.costRecordId ?? null, ownerId: row.ownerId, resolutionNote: row.resolutionNote ?? null } });
}

export async function registerPendingDevelopmentExpense(context: Context, caseId: string, input: {
  requestKey: string; sourceType: string; sourceId: string; costType: string; description: string;
  ownerId: string; expectedDate?: string | null;
}) {
  const data = {
    sourceType: required(input.sourceType, '费用来源类型', 40), sourceId: required(input.sourceId, '费用来源', 200),
    costType: required(input.costType, '费用类型', 40), description: required(input.description, '费用说明'),
    ownerId: required(input.ownerId, '负责人', 200), expectedDate: date(input.expectedDate, '预计到达日', true),
  };
  if (!COST_TYPES.includes(data.costType as any)) reject('INVALID_COST_TYPE', '费用类型无效');
  const requestKey = required(input.requestKey, '请求标识', 200);
  const requestFingerprint = hash(data);
  return locked(context, caseId, async tx => {
    const existing = await tx.developmentPendingExpense.findUnique({ where: { developmentCaseId_requestKey: { developmentCaseId: caseId, requestKey } } });
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) reject('REQUEST_CONFLICT', '请求标识已用于其他内容', 409);
      return existing;
    }
    await assertSource(tx, caseId, data.sourceType, data.sourceId);
    await context.authorizeAssignee(tx, caseId, data.ownerId);
    const now = BigInt(Date.now());
    const row = await tx.developmentPendingExpense.create({ data: { id: randomUUID(), developmentCaseId: caseId,
      ...data, status: 'pending', version: 1, requestKey, requestFingerprint, createdBy: context.actorId, createdAt: now, updatedAt: now } });
    await audit(tx, context.actorId, 'register_pending_expense', row);
    return row;
  });
}

export async function completePendingDevelopmentExpense(context: Context, caseId: string, id: string, input: {
  requestKey: string; expectedVersion: number; outcome: 'resolved' | 'cancelled'; note: string;
  amount?: number | string; currency?: string; incurredAt?: string;
}) {
  required(id, '待到事项', 200);
  const requestKey = required(input.requestKey, '请求标识', 200);
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) reject('INVALID_INPUT', '事项版本无效');
  if (!['resolved', 'cancelled'].includes(input.outcome)) reject('INVALID_INPUT', '处理结果无效');
  const note = required(input.note, '处理依据');
  if (input.outcome === 'cancelled' && [input.amount, input.currency, input.incurredAt].some(x => x !== undefined)) reject('INVALID_INPUT', '取消待到事项不能附带账单金额');
  const currency = input.outcome === 'resolved' ? required(input.currency, '币种', 3) : null;
  if (currency && !['CNY', 'USD'].includes(currency)) reject('INVALID_CURRENCY', '新账单仅支持人民币和美元');
  const incurredAt = input.outcome === 'resolved' ? date(input.incurredAt, '费用日期') : null;
  // Preserve original decimal text; the shared cost writer performs numeric validation.
  const completionFingerprint = hash({ outcome: input.outcome, note, amount: input.amount === undefined ? null : String(input.amount), currency, incurredAt, expectedVersion: input.expectedVersion });
  return locked(context, caseId, async tx => {
    const row = await tx.developmentPendingExpense.findFirst({ where: { id, developmentCaseId: caseId } });
    if (!row) reject('NOT_FOUND', '待到费用不存在或不可访问', 404);
    if (row.status !== 'pending') {
      if (row.completionRequestKey === requestKey && row.completionFingerprint === completionFingerprint) return row;
      reject('REQUEST_CONFLICT', '事项已处理，请刷新后查看', 409);
    }
    if (row.version !== input.expectedVersion) reject('STALE_VERSION', '事项已更新，请刷新后重试', 409);
    // A removed sample must not strand its historical pending item. Cancellation preserves the reason.
    if (input.outcome === 'resolved') await assertSource(tx, caseId, row.sourceType, row.sourceId);
    let costRecordId: string | null = null;
    if (input.outcome === 'resolved') {
      const cost = await createCostRecordInTx(tx, { actorId: context.actorId, input: {
        sourceType: row.sourceType, sourceId: row.sourceId, costType: row.costType,
        amount: input.amount as number | string, currency: currency!, incurredAt: incurredAt!,
        // This is the company's actual cost, not a decision that the customer owes it.
        bearerType: 'internal', notes: `${row.description}\n${note}`,
      } });
      costRecordId = cost.id;
    }
    const now = BigInt(Date.now());
    const saved = await tx.developmentPendingExpense.update({ where: { id }, data: {
      status: input.outcome, version: row.version + 1, costRecordId, resolutionNote: note,
      completionRequestKey: requestKey, completionFingerprint, completedBy: context.actorId, completedAt: now, updatedAt: now,
    } });
    await audit(tx, context.actorId, 'complete_pending_expense', saved);
    return saved;
  });
}
