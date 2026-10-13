import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { loadUserWithRoles, buildLoadedAuthTokenPayload } from '../auth/tokenHelpers';
import { hasScope } from '../auth/permissionService';
import { freshOrderLineScope } from '../orders/orderLineWriteAccess';
import { businessError as registeredBusinessError } from '../shared/errorCodes';
import { safeRouteError } from '../shared/routeError';
import { exactJsonValue } from '../lib/exactJsonValue';
import { ProductionBatchFactsError, resolveCurrentProductionBatchFacts } from './productionBatchFacts';

export type ReleaseBatchBindingErrorCode = 'CONFLICT' | 'INVALID_INPUT' | 'UNAUTHORIZED'
  | 'AUTHORIZATION_UNAVAILABLE' | 'ACCOUNT_DISABLED' | 'FORBIDDEN' | 'ORDER_NOT_FOUND';
/** Only this actual producer establishes public business-message provenance. */
export class ReleaseBatchBindingError extends Error {
  public readonly statusCode: number;
  constructor(public readonly code: ReleaseBatchBindingErrorCode, message: string) {
    const canonical = registeredBusinessError(code, message);
    super(canonical.message); this.name = 'ReleaseBatchBindingError'; this.statusCode = canonical.statusCode;
  }
}
const businessError = (code: ReleaseBatchBindingErrorCode, message: string) => new ReleaseBatchBindingError(code, message);
const conflict = (message: string): never => { throw businessError('CONFLICT', message); };
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(exactJsonValue(a))) === JSON.stringify(canonical(exactJsonValue(b)));

/** Only the bounded historical numeric input seam is accepted; new native
 * coordinates are Decimal strings. No Number conversion or DB rounding. */
export function releaseQuantity(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') throw businessError('INVALID_INPUT', '数量须为正的十进制数，最多四位小数。');
  const text = String(value);
  if (!/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(text)) throw businessError('INVALID_INPUT', '数量须为正的十进制数，最多四位小数。');
  const [integer, fraction = ''] = text.split('.');
  const scaled = BigInt(integer) * BigInt(10000) + BigInt(fraction.padEnd(4, '0'));
  if (scaled <= BigInt(0) || (typeof value === 'number' && scaled > BigInt(Number.MAX_SAFE_INTEGER)))
    throw businessError('INVALID_INPUT', '数量须精确且大于零；大数量请提交十进制字符串。');
  return new Prisma.Decimal(text).toString();
}
export async function currentReleaseActor(tx: any, prior: TokenPayload | null | undefined, cap: string, orderId: string) {
  if (!prior?.userId) throw businessError('UNAUTHORIZED', '放行操作需要可信的当前登录主体。');
  let actor: TokenPayload, user: any;
  try { user = await loadUserWithRoles(tx, prior.userId); }
  catch { throw businessError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验放行权限，请稍后重试。'); }
  if (!user || user.status !== 'active' || user.deletedAt != null) throw businessError('ACCOUNT_DISABLED', '当前账号不可用。');
  try { actor = await buildLoadedAuthTokenPayload(tx, user); }
  catch { throw businessError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验放行权限，请稍后重试。'); }
  if (prior.permissionCeiling !== undefined) actor!.permissionCeiling = [...prior.permissionCeiling];
  // The exact original operation capability, never the OrderLine leadership
  // helper: sign-only authority does not require orders:write or orders:read.
  if (!hasScope(actor!, cap as any)) throw businessError('FORBIDDEN', '当前账号没有本次放行操作权限。');
  const scope = await freshOrderLineScope(tx, actor!);
  let order;
  try { order = await tx.order.findFirst({ where: { id: orderId, deletedAt: null, AND: [scope] } }); }
  catch { throw businessError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验放行订单范围，请稍后重试。'); }
  if (!order) throw businessError('ORDER_NOT_FOUND', '订单不存在或不可查看。');
  return actor!;
}
/** Caller has acquired Source→Order→Line→existing Scope. Sorting batches
 * follows all existing native consumers; this function never locks a foreign
 * guessed batch merely because an input names it. */
export async function lockReleaseBatchRows(tx: any, orderId: string) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ProductionBatch" WHERE "orderId"=${orderId} ORDER BY "id" FOR UPDATE`);
}
export type ReleaseBatchBinding = {
  schemaVersion: 1; id: string; orderId: string; orderLineId: string; revision: number;
  rangeStart: string; quantity: string; unit: string; factoryRelationId: string;
  confirmedSourceType: string; confirmedSourceId: string; specSnapshot: unknown; sourceFingerprint: string;
};
export async function resolveReleaseBatchBinding(tx: any, input: {
  orderId: string; orderLineId: string; productionBatchId: unknown; expectedBatchRevision: unknown;
  quantity?: unknown; unit?: unknown; factoryRelationId?: unknown;
  confirmedSourceType?: unknown; confirmedSourceId?: unknown; specSnapshot?: unknown;
}): Promise<ReleaseBatchBinding> {
  if (typeof input.productionBatchId !== 'string' || !input.productionBatchId.trim()) return conflict('须选择真实生产批次。');
  if (!Number.isSafeInteger(input.expectedBatchRevision) || (input.expectedBatchRevision as number) < 0) return conflict('须提交读取到的真实批次修订。');
  const batch = await tx.productionBatch.findFirst({ where: { id: input.productionBatchId, orderId: input.orderId, orderLineId: input.orderLineId } });
  if (!batch || batch.state !== 'active' || batch.revision !== input.expectedBatchRevision) return conflict('实际生产批次不存在、归属不符或修订已变化，请刷新当前范围。');
  const { batch: actual } = await resolveCurrentProductionBatchFacts(tx, batch);
  const quantity = releaseQuantity(actual.quantity.toString());
  if (!actual.factoryRelationId || !actual.unit) return conflict('实际批次单位或工厂未知，不能补造放行依据。');
  const binding: ReleaseBatchBinding = { schemaVersion: 1, id: actual.id, orderId: actual.orderId, orderLineId: actual.orderLineId,
    revision: actual.revision, rangeStart: actual.rangeStart.toString(), quantity, unit: actual.unit, factoryRelationId: actual.factoryRelationId,
    confirmedSourceType: actual.confirmedSourceType, confirmedSourceId: actual.confirmedSourceId,
    specSnapshot: actual.specSnapshot, sourceFingerprint: actual.sourceFingerprint };
  if (input.quantity !== undefined && releaseQuantity(input.quantity) !== quantity) return conflict('放行范围须完整对应本批次；部分范围请先按真实批次拆分。');
  for (const field of ['unit','factoryRelationId','confirmedSourceType','confirmedSourceId','specSnapshot'] as const) {
    if (Object.prototype.hasOwnProperty.call(input, field) && !same(input[field], binding[field])) return conflict('提交的批次单位、工厂、来源或规格与真实批次不一致。');
  }
  return binding;
}
/** A physical batch alone does not switch the historical whole-line policy.
 * Only an actual batch release range adopts batch mode for this exact line. */
export async function hasBatchReleaseMode(tx: any, orderId: string, orderLineId: string): Promise<boolean> {
  return Boolean(await tx.releaseScope.findFirst({ where: { orderId, orderLineId, productionBatchId: { not: null }, deletedAt: null }, select: { id: true } }));
}
export async function readReleaseBatchBinding(tx: any, scope: any): Promise<ReleaseBatchBinding | null> {
  if (scope.productionBatchId == null) {
    if (await hasBatchReleaseMode(tx, scope.orderId, scope.orderLineId)) return conflict('原整行范围已退出，由实际批次范围承接；不能沿用原整行批准。');
    return null;
  }
  if (scope.productionBatchRevision == null) return conflict('历史范围未记录真实批次修订，不能补造新的批准依据。');
  return resolveReleaseBatchBinding(tx, { orderId: scope.orderId, orderLineId: scope.orderLineId,
    productionBatchId: scope.productionBatchId, expectedBatchRevision: scope.productionBatchRevision,
    quantity: scope.quantity.toString(), unit: scope.unit, factoryRelationId: scope.factoryRelationId,
    confirmedSourceType: scope.confirmedSourceType, confirmedSourceId: scope.confirmedSourceId, specSnapshot: scope.specSnapshot });
}
export function assertReleaseBatchProof(binding: ReleaseBatchBinding | null, snapshot: any) {
  if (binding && !same(binding, snapshot?.productionBatchBinding)) return conflict('原请求或批准缺少一致的真实批次依据，请按当前范围重新送审。');
}
export async function classifyReleaseScope(tx: any, scope: any): Promise<{ classification: 'current' | 'historical'; historyReason?: string; currentConflict?: string }> {
  const last = scope.state === 'invalidated' ? await tx.releaseEvent.findFirst({ where: { scopeId: scope.id }, orderBy: { sequence: 'desc' }, select: { kind: true } }) : null;
  if (last?.kind === 'superseded') return { classification: 'historical', historyReason: '原整行范围已退出，由实际批次承接' };
  {
    try { await readReleaseBatchBinding(tx, scope); }
    catch (error) {
      if ((error instanceof ReleaseBatchBindingError || error instanceof ProductionBatchFactsError) && ['CONFLICT','INVALID_INPUT'].includes(error.code)) {
        // An active batch that no longer fits the line is work to reconcile,
        // not exited history. Excluding it can report the whole order ready.
        const batch=scope.productionBatchId?await tx.productionBatch.findUnique({where:{id:scope.productionBatchId},select:{state:true}}):null;
        if(batch&&['split','cancelled'].includes(batch.state))return {classification:'historical',historyReason:'实际批次已拆分或取消，原范围已退出'};
        return {classification:'current',currentConflict:safeRouteError(error,{fallbackCode:'INTERNAL_ERROR'}).message};
      }
      throw error;
    }
  }
  return { classification: 'current' };
}
