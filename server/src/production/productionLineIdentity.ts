import { createHash } from 'node:crypto';
import { businessError } from '../shared/errorCodes';

export type ProductionLineChoice = { mode: 'factory_single' } | { mode: 'named_line'; productionLineId: string };
export type ProductionLineIdentity = {
  schemaVersion: 1; mode: ProductionLineChoice['mode']; factoryRelationId: string;
  productionLineId: string | null; lineRevision: number | null; name: string | null; location: string | null;
  declaredBy: string; declaredAt: string; fingerprint: string;
};
type LineDb = { factoryProductionLine?: { findUnique(args: { where: { id: string } }): PromiseLike<unknown> } };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value && !/[\u0000-\u001f]/.test(value);
const conflict = (message: string): never => { throw businessError('CONFLICT', message); };
const invalid = (message: string): never => { throw businessError('INVALID_INPUT', message); };
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
export const productionLineDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function parseProductionLineChoice(value: unknown): ProductionLineChoice | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || !['factory_single', 'named_line'].includes(String(value.mode))) return invalid('请明确本工厂实际按单线整体履约，或选择真实生产线。');
  if (value.mode === 'factory_single') {
    if (Object.keys(value).some(key => key !== 'mode')) return invalid('工厂单线声明不能附带虚拟生产线身份。');
    return { mode: 'factory_single' };
  }
  if (Object.keys(value).some(key => !['mode', 'productionLineId'].includes(key)) || !id(value.productionLineId)) return invalid('须明确选择真实生产线 ID。');
  return { mode: 'named_line', productionLineId: value.productionLineId };
}
export function assertProductionLineIdentity(value: unknown): asserts value is ProductionLineIdentity {
  if (!record(value) || Object.keys(value).some(key => !['schemaVersion', 'mode', 'factoryRelationId', 'productionLineId', 'lineRevision', 'name', 'location', 'declaredBy', 'declaredAt', 'fingerprint'].includes(key))
    || value.schemaVersion !== 1 || !id(value.factoryRelationId) || !id(value.declaredBy) || typeof value.declaredAt !== 'string'
    || !Number.isFinite(Date.parse(value.declaredAt)) || new Date(value.declaredAt).toISOString() !== value.declaredAt) return conflict('生产组织声明来源不完整，不能推断实际生产线。');
  if (value.mode === 'factory_single') {
    if (value.productionLineId !== null || value.lineRevision !== null || value.name !== null || value.location !== null) return conflict('工厂单线声明不能伪造额外生产线。');
  } else if (value.mode !== 'named_line' || !id(value.productionLineId) || !Number.isSafeInteger(value.lineRevision) || Number(value.lineRevision) < 1 || !id(value.name)
    || value.location !== null && (typeof value.location !== 'string' || !value.location.trim() || value.location.length > 500)) return conflict('真实生产线身份或修订无法核对。');
  const { fingerprint, ...body } = value;
  if (typeof fingerprint !== 'string' || fingerprint !== productionLineDigest(body)) return conflict('生产线声明指纹已变化，请重新核对原记录。');
}
async function actualLine(db: LineDb, lineId: string, factoryRelationId: string) {
  if (!db.factoryProductionLine?.findUnique) throw businessError('AUTHORIZATION_UNAVAILABLE', '暂无法核验实际生产线，请稍后重试。');
  const row = await db.factoryProductionLine.findUnique({ where: { id: lineId } });
  if (!record(row) || row.id !== lineId || row.factoryRelationId !== factoryRelationId || row.state !== 'active' || !id(row.name)
    || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || row.location != null && (typeof row.location !== 'string' || !row.location.trim()))
    return conflict('所选实际生产线不存在、已停用或不属于本工厂。');
  return { id: lineId, name: row.name, revision: Number(row.revision), location: typeof row.location === 'string' ? row.location : null };
}
export async function freezeProductionLineIdentity(db: LineDb, factoryRelationId: string, choice: ProductionLineChoice, actorId: string, now: Date): Promise<ProductionLineIdentity> {
  if (!id(factoryRelationId) || !id(actorId) || !Number.isFinite(now.getTime())) return conflict('生产线声明缺少真实工厂、录入人或时间。');
  const line = choice.mode === 'named_line' ? await actualLine(db, choice.productionLineId, factoryRelationId) : null;
  const body = { schemaVersion: 1 as const, mode: choice.mode, factoryRelationId, productionLineId: line?.id ?? null,
    lineRevision: line?.revision ?? null, name: line?.name ?? null, location: line?.location ?? null, declaredBy: actorId, declaredAt: now.toISOString() };
  return { ...body, fingerprint: productionLineDigest(body) };
}
/** Neutral readers retain unknown. Consumers decide whether the actual lane
 * requires a declared organization; this utility never fills missing facts. */
export async function readBatchProductionLineIdentity(db: LineDb, batch: { factoryRelationId: string; productionLineId?: string | null; productionLineSnapshot?: unknown }): Promise<ProductionLineIdentity | null> {
  if (batch.productionLineSnapshot == null && batch.productionLineId == null) return null;
  const value = batch.productionLineSnapshot; assertProductionLineIdentity(value);
  if (value.factoryRelationId !== batch.factoryRelationId || value.productionLineId !== (batch.productionLineId ?? null)) return conflict('批次与冻结的实际工厂或生产线不一致。');
  if (value.mode === 'named_line') {
    const row = await actualLine(db, value.productionLineId!, value.factoryRelationId);
    if (row.revision !== value.lineRevision || row.name !== value.name || row.location !== value.location) return conflict('实际生产线修订已变化，原 PP 不能替代当前生产线依据。');
  }
  return value;
}
export function productionLineCoverageMatches(coverage: { scopeKind: string; productionLineIdentity?: unknown }, scope: { productionLineMode: string | null; productionLineFingerprint: string | null }): boolean {
  if (scope.productionLineMode === 'factory_single' && coverage.scopeKind === 'order_line') return true;
  if (!scope.productionLineMode || !scope.productionLineFingerprint || !coverage.productionLineIdentity) return false;
  try { assertProductionLineIdentity(coverage.productionLineIdentity); return coverage.productionLineIdentity.mode === scope.productionLineMode && coverage.productionLineIdentity.fingerprint === scope.productionLineFingerprint; }
  catch { return false; }
}
