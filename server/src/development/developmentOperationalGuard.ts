import { Prisma } from '@prisma/client';
import { businessError, readBusinessErrorMint, type BusinessErrorMint } from '../shared/errorCodes';

/** Identity is established by deliberate native construction, never by a
 * storage error carrying a similarly named code or a caller-chosen status. */
const developmentDomainErrorMints = new WeakMap<object, BusinessErrorMint>();
export function readDevelopmentDomainErrorMint(error: unknown): BusinessErrorMint | null {
  if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return null;
  return developmentDomainErrorMints.get(error as object) ?? null;
}

export class DevelopmentDomainError extends Error {
  readonly statusCode: number;
  readonly status: number;
  readonly httpStatus: number;
  constructor(readonly code: string, message: string) {
    const failure = businessError(code, message);
    super(failure.message);
    this.statusCode = failure.statusCode;
    this.status = this.httpStatus = this.statusCode;
    developmentDomainErrorMints.set(this, readBusinessErrorMint(failure)!);
  }
}

/** Only for operational development changes. Expense facts and physical custody use their own rules. */
export async function assertDevelopmentOperationalWrite(
  tx: any, caseId: string, operation: 'update' | 'stage' | 'delete' | 'sample' | 'convert',
) {
  const reject = (code: string, message: string): never => { throw new DevelopmentDomainError(code, message); };
  const rows = await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id" = ${caseId} AND "deletedAt" IS NULL FOR UPDATE`);
  if (!rows.length) reject('NOT_FOUND', '开发案不存在或已删除');
  const event = await tx.developmentLifecycleEvent.findFirst({
    where: { developmentCaseId: caseId }, orderBy: { revision: 'desc' },
  });
  if (operation === 'delete' && event) reject('LIFECYCLE_HISTORY_EXISTS', '已有暂停、恢复或结案历史，不能删除开发案');
  if (event?.state === 'paused') reject('DEVELOPMENT_PAUSED', '开发已暂停，请先明确恢复后再修改开发内容');
  // Reusing a successfully closed design for an order/asset is a downstream handoff, not reopening development.
  if (event?.state === 'closed' && operation === 'convert' && event.outcome === 'completed') return event;
  if (event?.state === 'closed') reject('DEVELOPMENT_CLOSED', '开发已结案，新增开发工作须走明确变更，不能直接修改历史');
  if (event && event.state !== 'active') reject('INVALID_LIFECYCLE_STATE', '开发管理状态异常，请先核实记录');
  return event;
}
