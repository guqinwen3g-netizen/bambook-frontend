import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { loadUserWithRoles, buildLoadedAuthTokenPayload } from '../auth/tokenHelpers';
import { hasScope } from '../auth/permissionService';
import { SYSTEM_ROLE_IDS } from '../_shared/rolePermissionMatrix';
import { freshOrderLineScope, lockedOrderLine } from '../orders/orderLineWriteAccess';
import { lockOrderReleaseSources } from './releaseService';
import { productionBatchLineFingerprint, resolveCurrentProductionBatchFacts } from './productionBatchFacts';
import { loadToleranceStandards, resolveLineTolerance } from '../orders/toleranceStandardService';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { businessError, isBusinessError } from '../shared/errorCodes';
import { safeRouteError } from '../shared/routeError';
import { exactJsonValue } from '../lib/exactJsonValue';
import { logger } from '../lib/logger';
import { normalizeGarmentSizeBreakdown } from '../orders/garmentSizeBreakdown';
import { garmentSizeBranchesCoverLine } from './garmentSizeAllocation';
import { resolveTolerancePct } from '../orders/toleranceStandardService';

type CompletionCommand = { expectedRevision: number; expectedLineFingerprint: string; actualQty: string; actualQtyBySize?: Record<string, number>; requestKey: string };
type CompletionResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; status: number } };
type ProductionLine = 'garment' | 'fabric';
type ToleranceSummary = { status: 'pending' | 'within_tolerance' | 'over_tolerance' | 'under_tolerance' | 'unresolved';
  comparisonBasis: 'line_total' | 'per_size' | 'unknown'; source: string | null; percent: number | null;
  allowedMin: string | null; allowedMax: string | null; reason: string | null;
  perSize?: Array<{ size: string; contractQty: number; actualQty: number; status: 'within_tolerance' | 'over_tolerance' | 'under_tolerance' | 'unresolved';
    source: string | null; percent: number | null; allowedMin: string | null; allowedMax: string | null; reason: string | null }> };

const json = (value: unknown): any => JSON.parse(JSON.stringify(exactJsonValue(value)));
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const conflict = (message: string): never => { throw businessError('CONFLICT', message); };
const invalid = (message: string): never => { throw businessError('INVALID_INPUT', message); };
const actorRoles = new Set<string>([SYSTEM_ROLE_IDS.SALES, SYSTEM_ROLE_IDS.SALES_MANAGER, SYSTEM_ROLE_IDS.ADMIN, SYSTEM_ROLE_IDS.SUPER_ADMIN]);

function parseInput(value: unknown): CompletionCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('请提交生产完成数量。');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => ['sizeActualQuantities', 'sizeQuantities'].includes(key)))
    return invalid('逐尺码实际数量字段名称为 actualQtyBySize。');
  if (Object.keys(body).some(key => !['expectedRevision', 'expectedLineFingerprint', 'actualQty', 'actualQtyBySize', 'requestKey'].includes(key)))
    return invalid('生产完成命令包含不可提交字段。');
  if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) return invalid('请提交当前生产批次修订号。');
  if (typeof body.expectedLineFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedLineFingerprint))
    return invalid('请读取当前订单行依据后再登记生产完成。');
  if (typeof body.actualQty !== 'string' || !/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(body.actualQty))
    return invalid('最终实际生产数量须为最多四位小数的非负十进制字符串。');
  let actualQtyBySize: Record<string, number> | undefined;
  if (body.actualQtyBySize !== undefined) {
    try { actualQtyBySize = normalizeGarmentSizeBreakdown(body.actualQtyBySize, body.actualQty) ?? undefined; }
    catch (error) { return invalid(error instanceof Error ? error.message : '逐尺码实际数量无效。'); }
    if (!actualQtyBySize) return invalid('逐尺码实际数量不能为空。');
  }
  if (typeof body.requestKey !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(body.requestKey))
    return invalid('生产完成请求键须为 UUID，并在网络重试时复用。');
  return { expectedRevision: Number(body.expectedRevision), expectedLineFingerprint: body.expectedLineFingerprint,
    actualQty: new Prisma.Decimal(body.actualQty).toString(), ...(actualQtyBySize ? { actualQtyBySize } : {}), requestKey: body.requestKey.toLowerCase() };
}

function businessLineOf(order: any): ProductionLine | null {
  const line = String(order?.businessLine ?? order?.type ?? '').trim().toLowerCase();
  if (line === 'fabric') return 'fabric';
  if (line === 'garment') return 'garment';
  return null;
}

/** Completion is a business fact. SALES is explicitly allowed here even
 * though the older production-range writer uses a narrower legacy helper. */
async function currentBusinessActor(tx: any, prior: TokenPayload | null | undefined): Promise<TokenPayload> {
  if (!prior?.userId) throw businessError('UNAUTHORIZED', '登记生产完成需要有效的用户主体。');
  let user: any, actor: TokenPayload;
  try {
    user = await loadUserWithRoles(tx, prior.userId);
    if (!user || user.status !== 'active' || user.deletedAt != null) throw businessError('ACCOUNT_DISABLED', '当前账号不可用。');
    actor = await buildLoadedAuthTokenPayload(tx, user);
  } catch (error) {
    if (isBusinessError(error)) throw error;
    throw businessError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验当前账号和权限。');
  }
  if (prior.permissionCeiling !== undefined) actor.permissionCeiling = [...prior.permissionCeiling];
  if (!actor.roleIds?.some(roleId => actorRoles.has(roleId)) || !hasScope(actor, 'orders:write'))
    throw businessError('FORBIDDEN', '当前账号没有业务订单生产完成登记权限。');
  return actor;
}

async function scopedOrder(tx: any, orderId: string, actor: TokenPayload) {
  const scope = await freshOrderLineScope(tx, actor);
  let order: any;
  try { order = await tx.order.findFirst({ where: { id: orderId, deletedAt: null, AND: [scope] } }); }
  catch { throw businessError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验订单数据范围。'); }
  if (!order) throw businessError('ORDER_NOT_FOUND', '订单不存在或不在当前业务操作范围。');
  return order;
}

function requestKeyConflict(message = '生产完成事实或请求键已存在，请核对原请求。'): never { return conflict(message); }

/**
 * The current tolerance editor only writes aggregate qtyTolerance bands. Keep
 * raw JSON inspection here because normalization intentionally drops unknown
 * keys; if a newer/imported customer agreement explicitly scopes quantity
 * tolerance by size, do not silently interpret it as a line-total rule.
 */
function customerToleranceUsesSizeBasis(raw: unknown): boolean {
  let value: any = raw;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return false; } }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const basisKeys = new Set(['qtytolerancebasis', 'quantitytolerancebasis', 'qtytolerancescope', 'quantitytolerancescope',
    'qtytolerancemode', 'quantitytolerancemode', 'quantitycomparisonbasis', 'qtycomparisonbasis']);
  const sizeValues = /^(?:size|per[_ -]?size|by[_ -]?size|size[_ -]?matrix|尺码|尺碼|按尺码|按尺碼)$/i;
  const visit = (node: any): boolean => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
    for (const [key, child] of Object.entries(node)) {
      const normalized = key.replace(/[_ -]/g, '').toLowerCase();
      if ((basisKeys.has(normalized) || /(?:qty|quantity|tolerance|short|excess|允差|短产|超产).*?(?:size|尺码|尺碼)|(?:size|尺码|尺碼).*?(?:qty|quantity|tolerance|允差)/i.test(key))
        && (typeof child === 'string' ? sizeValues.test(child.trim()) : child !== false && child != null)) return true;
      if (child && typeof child === 'object' && visit(child)) return true;
    }
    return false;
  };
  return visit(value);
}

async function customerSizeToleranceBasis(tx: any, order: any): Promise<boolean | null> {
  if (!order.customerRelationId) return false;
  try {
    const customer = await tx.relation.findUnique({ where: { id: order.customerRelationId }, select: { customerAgreementTolerance: true } });
    return customerToleranceUsesSizeBasis(customer?.customerAgreementTolerance ?? null);
  } catch { return null; }
}

function perSizeToleranceSummary(line: any, contractSizes: Record<string, number>, actualSizes: Record<string, number>, loaded: any): ToleranceSummary {
  const expected = Object.keys(contractSizes).sort(), actualKeys = Object.keys(actualSizes).sort();
  if (expected.length !== actualKeys.length || expected.some((size, index) => size !== actualKeys[index]))
    return { status: 'unresolved', comparisonBasis: 'per_size', source: 'customer_standard', percent: null, allowedMin: null, allowedMax: null,
      reason: '逐尺码实际数量与订单行尺码不一致，暂不能核验。' };
  const perSize: NonNullable<ToleranceSummary['perSize']> = [];
  for (const size of expected) {
    const contractQty = contractSizes[size], actualQty = actualSizes[size];
    if (contractQty === 0) {
      const status = actualQty === 0 ? 'within_tolerance' : 'over_tolerance';
      perSize.push({ size, contractQty, actualQty, status, source: 'customer_standard', percent: null,
        allowedMin: '0', allowedMax: '0', reason: status === 'within_tolerance' ? null : `订单未订购 ${size} 码，不允许生产该尺码数量。` });
      continue;
    }
    // An explicitly size-based customer rule uses that size's contract quantity
    // to pick the existing customer qtyTolerance band; internal defaults never
    // stand in for a missing customer band on this P0 comparison.
    const resolved = resolveTolerancePct({ subject: 'qtyTolerance', measure: contractQty,
      lineOverride: { pct: line.tolerancePercent, source: line.toleranceSource ?? null },
      customerStandard: loaded.customerStandard, customerStandardUnavailable: loaded.customerStandardUnavailable,
      internalStandard: null, internalStandardUnavailable: false, allowInternalDefault: false });
    if (resolved.pct == null || resolved.unresolvedReason || resolved.ambiguousBands.length) {
      perSize.push({ size, contractQty, actualQty, status: 'unresolved', source: resolved.source === 'none' ? null : resolved.source,
        percent: resolved.pct, allowedMin: null, allowedMax: null,
        reason: resolved.unresolvedReason ?? (resolved.ambiguousBands.length ? '客户允差档位重叠，需先修正标准。' : '该尺码没有可用客户允差标准。') });
      continue;
    }
    const tolerance = new Prisma.Decimal(String(resolved.pct)).div(100), contract = new Prisma.Decimal(contractQty);
    const allowedMin = contract.mul(new Prisma.Decimal(1).minus(tolerance)).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
    const allowedMax = contract.mul(new Prisma.Decimal(1).plus(tolerance)).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
    const actual = new Prisma.Decimal(actualQty), status = actual.lt(allowedMin) ? 'under_tolerance' : actual.gt(allowedMax) ? 'over_tolerance' : 'within_tolerance';
    perSize.push({ size, contractQty, actualQty, status, source: resolved.source, percent: resolved.pct,
      allowedMin: allowedMin.toString(), allowedMax: allowedMax.toString(),
      reason: status === 'within_tolerance' ? null : status === 'under_tolerance' ? `${size} 码完工数量低于客户允差下限。` : `${size} 码完工数量高于客户允差上限。` });
  }
  const unresolved = perSize.some(row => row.status === 'unresolved');
  const over = perSize.some(row => row.status === 'over_tolerance'), under = perSize.some(row => row.status === 'under_tolerance');
  const status = unresolved ? 'unresolved' : over ? 'over_tolerance' : under ? 'under_tolerance' : 'within_tolerance';
  const sources = [...new Set(perSize.map(row => row.source).filter(Boolean))];
  const percentages = [...new Set(perSize.map(row => row.percent).filter((value): value is number => value != null))];
  const reason = unresolved ? perSize.find(row => row.status === 'unresolved')?.reason ?? '逐尺码客户允差无法确认。'
    : over || under ? perSize.filter(row => row.status === 'over_tolerance' || row.status === 'under_tolerance').map(row => row.reason).filter(Boolean).join('；')
      : null;
  return { status, comparisonBasis: 'per_size', source: sources.length === 1 ? sources[0] : sources.length ? 'mixed' : 'customer_standard',
    percent: percentages.length === 1 ? percentages[0] : null, allowedMin: null, allowedMax: null, reason, perSize };
}

async function toleranceForCompletedLine(tx: any, order: any, line: any, actualQty: Prisma.Decimal,
  actualSizeBreakdown?: Record<string, number> | null): Promise<ToleranceSummary> {
  const contractQty = new Prisma.Decimal(line.quantity);
  if (!contractQty.isFinite() || contractQty.lte(0) || !line.unit)
    return { status: 'unresolved', comparisonBasis: 'unknown', source: null, percent: null, allowedMin: null, allowedMax: null, reason: '订单合同数量或单位无效。' };
  const numericMeasure = Number(contractQty.toString());
  if (!Number.isFinite(numericMeasure) || !new Prisma.Decimal(String(numericMeasure)).eq(contractQty))
    return { status: 'unresolved', comparisonBasis: 'unknown', source: null, percent: null, allowedMin: null, allowedMax: null, reason: '合同数量超出公差规则可精确选档的范围。' };
  let rawCustomerStandard: any = null;
  if (order.customerRelationId) {
    try {
      const customer = await (tx as any).relation.findUnique({ where: { id: order.customerRelationId }, select: { customerAgreementTolerance: true } });
      rawCustomerStandard = customer?.customerAgreementTolerance ?? null;
    } catch {
      return { status: 'unresolved', comparisonBasis: 'unknown', source: 'customer_standard', percent: null, allowedMin: null, allowedMax: null,
        reason: '无法核对客户允差的比较维度，不可按订单总量推断。' };
    }
  }
  let contractSizes: Record<string, number> | null = null;
  try { contractSizes = normalizeGarmentSizeBreakdown(line.sizeBreakdown, line.quantity instanceof Prisma.Decimal ? line.quantity.toString() : line.quantity); }
  catch (error) { return { status: 'unresolved', comparisonBasis: 'unknown', source: null, percent: null, allowedMin: null, allowedMax: null,
    reason: error instanceof Error ? `订单行尺码矩阵无效：${error.message}` : '订单行尺码矩阵无效。' }; }
  const perSizeBasis = customerToleranceUsesSizeBasis(rawCustomerStandard);
  if (perSizeBasis && (!contractSizes || !actualSizeBreakdown))
    return { status: 'unresolved', comparisonBasis: 'per_size', source: 'customer_standard', percent: null, allowedMin: null, allowedMax: null,
      reason: '客户标准明确要求按尺码核验，但订单缺少准确尺码矩阵或逐尺码实际数量，不能按总量放行。' };
  let loaded: any;
  try { loaded = await loadToleranceStandards(tx, { customerRelationId: order.customerRelationId ?? null }); }
  catch { return { status: 'unresolved', comparisonBasis: 'unknown', source: null, percent: null, allowedMin: null, allowedMax: null, reason: '客户或内部数量允差标准暂不可读取。' }; }
  if (perSizeBasis) return perSizeToleranceSummary(line, contractSizes!, actualSizeBreakdown!, loaded);
  const customerBands = loaded.customerStandard?.qtyTolerance;
  if (!loaded.customerStandardUnavailable && Array.isArray(customerBands) && customerBands.length) {
    const hits = customerBands.filter((band: any) => numericMeasure >= band.minQty && (band.maxQty == null || numericMeasure <= band.maxQty));
    if (!hits.length && !(line.toleranceSource === 'line_override' && line.tolerancePercent != null))
      return { status: 'unresolved', comparisonBasis: 'line_total', source: 'customer_standard', percent: null, allowedMin: null, allowedMax: null,
        reason: '客户已有数量允差标准，但合同数量落在未配置档位；不降级使用内部标准。' };
    if (hits.length > 1) return { status: 'unresolved', comparisonBasis: 'line_total', source: 'customer_standard', percent: null, allowedMin: null, allowedMax: null,
      reason: '客户数量允差档位重叠，需先修正规则。' };
  }
  const resolved = resolveLineTolerance(line, loaded, { measure: numericMeasure });
  if (resolved.pct == null || resolved.unresolvedReason)
    return { status: 'unresolved', comparisonBasis: 'line_total', source: resolved.source ?? null, percent: null, allowedMin: null, allowedMax: null,
      reason: resolved.unresolvedReason ?? '未找到适用的客户或公司内部数量允差标准。' };
  if (resolved.ambiguousBands?.length)
    return { status: 'unresolved', comparisonBasis: 'line_total', source: resolved.source, percent: resolved.pct, allowedMin: null, allowedMax: null,
      reason: '适用数量允差档位存在重叠，需先修正规则。' };
  const tolerance = new Prisma.Decimal(String(resolved.pct)).div(100);
  const allowedMin = contractQty.mul(new Prisma.Decimal(1).minus(tolerance)).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
  const allowedMax = contractQty.mul(new Prisma.Decimal(1).plus(tolerance)).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
  const status = actualQty.lt(allowedMin) ? 'under_tolerance' : actualQty.gt(allowedMax) ? 'over_tolerance' : 'within_tolerance';
  return { status, comparisonBasis: 'line_total', source: resolved.source, percent: resolved.pct, allowedMin: allowedMin.toString(), allowedMax: allowedMax.toString(),
    reason: status === 'within_tolerance' ? null : status === 'under_tolerance' ? '最终完工量低于当前允差下限，须由业务按客户处理规则继续处理。' : '最终完工量高于当前允差上限，须由业务按客户处理规则继续处理。' };
}

function branchCoverage(active: any[], line: any, businessLine: ProductionLine | null): { covered: boolean; reason: string | null } {
  const quantity = new Prisma.Decimal(line.quantity);
  if (!businessLine) return { covered: false, reason: '订单业务板块未知，无法验证生产分支形状。' };
  if (!active.length) return { covered: false, reason: '尚未建立有效生产工厂分支。' };
  if (businessLine === 'fabric') {
    if (active.length !== 1 || active[0].parentBatchId != null
      || !new Prisma.Decimal(active[0].rangeStart).eq(0)
      || !new Prisma.Decimal(active[0].quantity).eq(quantity))
      return { covered: false, reason: '面料订单行必须只有一个工厂的一条完整生产分支；当前分支形状不符合该规则。' };
    return { covered: true, reason: null };
  }
  const sorted = [...active].sort((a, b) => new Prisma.Decimal(a.rangeStart).comparedTo(new Prisma.Decimal(b.rangeStart)));
  let next = new Prisma.Decimal(0);
  for (const batch of sorted) {
    const start = new Prisma.Decimal(batch.rangeStart), planned = new Prisma.Decimal(batch.quantity);
    if (!start.eq(next) || !planned.gt(0)) return { covered: false, reason: '成衣工厂分支尚未无缺口地覆盖整个订单行数量范围。' };
    next = next.plus(planned);
  }
  if (!next.eq(quantity)) return { covered: false, reason: '成衣仍有未分配给工厂分支的订单数量，不能推断生产已全部完成。' };
  let sizeMatrix: Record<string, number> | null;
  try { sizeMatrix = normalizeGarmentSizeBreakdown(line.sizeBreakdown, line.quantity instanceof Prisma.Decimal ? line.quantity.toString() : line.quantity); }
  catch (error) { return { covered: false, reason: error instanceof Error ? `订单行尺码矩阵无效：${error.message}` : '订单行尺码矩阵无效。' }; }
  if (sizeMatrix && !garmentSizeBranchesCoverLine(sizeMatrix, sorted))
    return { covered: false, reason: '成衣工厂分支的逐尺码计划尚未精确覆盖订单行尺码数量；缺少或超分配的尺码不能放行。' };
  return { covered: true, reason: null };
}

/** Read only the authoritative active branch revisions and immutable
 * completion facts. Shipment allocations and planned batch quantities never
 * contribute to actualQty. Used by the order row and shipment eligibility. */
export async function readOrderLineProductionCompletion(tx: any, order: any, line: any) {
  const fingerprint = productionBatchLineFingerprint(order, line);
  const businessLine = businessLineOf(order);
  const requiresPerSizeActuals = await customerSizeToleranceBasis(tx, order);
  const active = await tx.productionBatch.findMany({ where: { orderId: order.id, orderLineId: line.id, state: 'active' },
    orderBy: [{ rangeStart: 'asc' }, { factoryRelationId: 'asc' }, { id: 'asc' }] });
  const coverage = branchCoverage(active, line, businessLine);
  const ids = active.map((batch: any) => batch.id);
  const records = ids.length ? await tx.productionBatchCompletion.findMany({ where: { productionBatchId: { in: ids } },
    orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }] }) : [];
  const byRevision = new Map(records.map((row: any) => [`${row.productionBatchId}:${row.productionBatchRevision}`, row]));
  const branches: any[] = [];
  let sourceConflict: string | null = null;
  let contractSizes: Record<string, number> | null = null;
  if (businessLine === 'garment') {
    try { contractSizes = normalizeGarmentSizeBreakdown(line.sizeBreakdown, line.quantity instanceof Prisma.Decimal ? line.quantity.toString() : line.quantity); }
    catch (error: any) { sourceConflict = error?.message ? `订单行尺码矩阵无效：${error.message}` : '订单行尺码矩阵无效。'; }
  }
  for (const batch of active) {
    let current: any;
    try { current = await resolveCurrentProductionBatchFacts(tx, batch); }
    catch (error: any) { sourceConflict = error?.message ?? '当前生产分支依据无法核验。'; }
    if (current && current.line.id !== line.id) sourceConflict = '生产分支已不属于当前订单行。';
    if (current && current.batch.unit !== line.unit) sourceConflict = '生产分支单位与订单行单位不一致。';
    const record = byRevision.get(`${batch.id}:${batch.revision}`) as any;
    let actualSizeBreakdown: Record<string, number> | null = null;
    let validSizes = !contractSizes && record?.actualSizeBreakdown == null;
    if (contractSizes) {
      if (record?.actualSizeBreakdown == null) validSizes = requiresPerSizeActuals === false;
      else try {
        actualSizeBreakdown = normalizeGarmentSizeBreakdown(record.actualSizeBreakdown, record.actualQuantity instanceof Prisma.Decimal ? record.actualQuantity.toString() : record.actualQuantity);
        const expected = Object.keys(contractSizes).sort(), actualKeys = Object.keys(actualSizeBreakdown ?? {}).sort();
        validSizes = !!actualSizeBreakdown && expected.length === actualKeys.length && expected.every((size, index) => size === actualKeys[index]);
      } catch { validSizes = false; }
    }
    const validRecord = record && record.orderId === order.id && record.orderLineId === line.id && record.unit === line.unit
      && record.lineFingerprint === fingerprint && new Prisma.Decimal(record.actualQuantity).isFinite() && validSizes;
    branches.push({ productionBatchId: batch.id, productionBatchRevision: batch.revision, parentBatchId: batch.parentBatchId ?? null,
      factoryRelationId: batch.factoryRelationId, plannedQty: new Prisma.Decimal(batch.quantity).toString(), unit: batch.unit,
      plannedSizeBreakdown: batch.sizeBreakdown ?? null,
      actualQty: validRecord ? new Prisma.Decimal(record.actualQuantity).toString() : null,
      actualQtyBySize: validRecord ? actualSizeBreakdown : null,
      completedAt: validRecord ? String(record.recordedAt) : null, completionId: validRecord ? record.id : null,
      completionCurrent: !!validRecord });
    if (record && !validRecord) sourceConflict = '已登记完工事实与当前订单行依据或单位不一致。';
  }
  const allBranchesCompleted = coverage.covered && !sourceConflict && branches.length > 0 && branches.every(branch => branch.completionCurrent);
  let actualQty: string | null = null, tolerance: ToleranceSummary = { status: 'pending', comparisonBasis: 'unknown', source: null, percent: null, allowedMin: null, allowedMax: null, reason: null };
  if (allBranchesCompleted) {
    const completedQuantity = branches.reduce((sum, branch) => sum.plus(branch.actualQty), new Prisma.Decimal(0));
    actualQty = completedQuantity.toString();
    let completedSizes: Record<string, number> | null = null;
    if (contractSizes && branches.every(branch => branch.actualQtyBySize != null)) {
      const aggregate: Record<string, number> = {}; let safe = true;
      for (const size of Object.keys(contractSizes)) {
        const total = branches.reduce((sum, branch) => sum + BigInt(branch.actualQtyBySize[size]), BigInt(0));
        if (total > BigInt(Number.MAX_SAFE_INTEGER)) { safe = false; break; }
        aggregate[size] = Number(total);
      }
      if (safe) completedSizes = aggregate;
    }
    tolerance = await toleranceForCompletedLine(tx, order, line, completedQuantity, completedSizes);
  }
  const blockers: Array<{ code: string; message: string }> = [];
  if (sourceConflict) blockers.push({ code: 'PRODUCTION_COMPLETION_SOURCE_STALE', message: sourceConflict });
  if (!coverage.covered && active.length) blockers.push({ code: 'PRODUCTION_BRANCH_COVERAGE_INCOMPLETE', message: coverage.reason! });
  if (tolerance.status === 'unresolved') blockers.push({ code: 'PRODUCTION_TOLERANCE_UNRESOLVED', message: tolerance.reason ?? '数量允差无法确认。' });
  if (tolerance.status === 'over_tolerance' || tolerance.status === 'under_tolerance')
    blockers.push({ code: 'PRODUCTION_TOLERANCE_REQUIRES_CUSTOMER_DECISION', message: tolerance.reason! });
  const status = sourceConflict || (active.length > 0 && !coverage.covered) ? 'unresolved'
    : !allBranchesCompleted ? (active.length ? 'incomplete' : 'not_started')
      : tolerance.status === 'unresolved' ? 'unresolved'
        : tolerance.status === 'over_tolerance' || tolerance.status === 'under_tolerance' ? 'out_of_tolerance' : 'complete';
  return { status, productionComplete: allBranchesCompleted, productionCompletionQuantity: actualQty, actualQty, unit: line.unit ?? null,
    requiresPerSizeActuals,
    expectedBranchCount: active.length, completedBranchCount: branches.filter(branch => branch.completionCurrent).length,
    contractQty: new Prisma.Decimal(line.quantity).toString(), coverageComplete: coverage.covered,
    tolerance, branches, blockers, lineFingerprint: fingerprint };
}

async function completionActorCanReadLine(tx: any, prior: TokenPayload | null | undefined, orderId: string, lineId: string) {
  const actor = await currentBusinessActor(tx, prior);
  const order = await scopedOrder(tx, orderId, actor);
  const line = await tx.orderLine.findUnique({ where: { id: lineId } });
  if (!line || line.orderId !== order.id) throw businessError('ORDER_LINE_NOT_FOUND', '订单行不存在或不属于当前订单。');
  return { actor, order, line };
}

async function completionReader(tx: any, prior: TokenPayload | null | undefined, orderId: string, lineId: string) {
  if (!prior?.userId) throw businessError('UNAUTHORIZED', '查看生产完成状态需要有效的用户主体。');
  let user: any, actor: TokenPayload;
  try {
    user = await loadUserWithRoles(tx, prior.userId);
    if (!user || user.status !== 'active' || user.deletedAt != null) throw businessError('ACCOUNT_DISABLED', '当前账号不可用。');
    actor = await buildLoadedAuthTokenPayload(tx, user);
  } catch (error) {
    if (isBusinessError(error)) throw error;
    throw businessError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验当前账号和权限。');
  }
  if (prior.permissionCeiling !== undefined) actor.permissionCeiling = [...prior.permissionCeiling];
  if (!hasScope(actor, 'orders:read')) throw businessError('FORBIDDEN', '当前账号没有订单读取权限。');
  const order = await scopedOrder(tx, orderId, actor);
  const line = await tx.orderLine.findUnique({ where: { id: lineId } });
  if (!line || line.orderId !== order.id) throw businessError('ORDER_LINE_NOT_FOUND', '订单行不存在或不属于当前订单。');
  return { order, line };
}

export async function completeProductionBatch(params: { prisma: PrismaClient; batchId: string; actor: TokenPayload | null; input: unknown; ip?: string | null }) {
  try {
    const input = parseInput(params.input);
    const result = await params.prisma.$transaction(async (tx: any) => {
      const initialActor = await currentBusinessActor(tx, params.actor);
      const hint = await tx.productionBatch.findUnique({ where: { id: params.batchId } });
      if (!hint) throw businessError('NOT_FOUND', '生产工厂分支不存在或不可查看。');
      await scopedOrder(tx, hint.orderId, initialActor);
      await lockOrderReleaseSources(tx, hint.orderId);
      await lockedOrderLine(tx, hint.orderLineId, hint.orderId);
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ProductionBatch" WHERE "id"=${params.batchId} FOR UPDATE`);
      const { actor, order, line } = await completionActorCanReadLine(tx, params.actor, hint.orderId, hint.orderLineId);
      const batch = await tx.productionBatch.findUnique({ where: { id: params.batchId } });
      if (!batch || batch.orderId !== order.id || batch.orderLineId !== line.id || batch.state !== 'active'
        || batch.revision !== input.expectedRevision) throw businessError('CONFLICT', '生产工厂分支或修订已变化，请刷新后确认。');
      const lineFingerprint = productionBatchLineFingerprint(order, line);
      if (lineFingerprint !== input.expectedLineFingerprint) throw businessError('CONFLICT', '订单行规格、数量或来源依据已变化，请重新核对后登记。');
      const facts = await resolveCurrentProductionBatchFacts(tx, batch);
      if (facts.line.unit !== line.unit || batch.unit !== line.unit || !line.unit)
        throw businessError('CONFLICT', '完工数量单位必须与当前订单行单位一致。');
      const businessLine = businessLineOf(order);
      if (!businessLine) throw businessError('CONFLICT', '订单业务板块未知，暂不能登记生产完成。');
      let lineSizes: Record<string, number> | null = null;
      if (businessLine === 'garment') {
        try { lineSizes = normalizeGarmentSizeBreakdown(line.sizeBreakdown, line.quantity instanceof Prisma.Decimal ? line.quantity.toString() : line.quantity); }
        catch (error) { throw businessError('CONFLICT', error instanceof Error ? `订单行尺码矩阵无效：${error.message}` : '订单行尺码矩阵无效。'); }
      }
      if (input.actualQtyBySize && lineSizes) {
        const expectedSizes = Object.keys(lineSizes).sort(), actualSizes = Object.keys(input.actualQtyBySize).sort();
        if (expectedSizes.length !== actualSizes.length || expectedSizes.some((size, index) => size !== actualSizes[index]))
          throw businessError('INVALID_INPUT', '逐尺码实际数量必须与订单行尺码完全一致；没有生产的尺码填 0。');
      } else if (input.actualQtyBySize) throw businessError('INVALID_INPUT', '当前订单行没有尺码矩阵，不能提交逐尺码完工数量。');
      if (lineSizes && batch.sizeBreakdown == null) throw businessError('CONFLICT', '本工厂分支缺少逐尺码计划分配；请先重新核对工厂分支。');
      if (order.customerRelationId) {
        let rawCustomerStandard: unknown;
        try {
          const customer = await tx.relation.findUnique({ where: { id: order.customerRelationId }, select: { customerAgreementTolerance: true } });
          rawCustomerStandard = customer?.customerAgreementTolerance ?? null;
        } catch {
          throw businessError('AUTHORIZATION_UNAVAILABLE', '无法核对客户数量允差的比较维度，暂不能保存总量完工记录。');
        }
        if (customerToleranceUsesSizeBasis(rawCustomerStandard) && (!lineSizes || !input.actualQtyBySize))
          throw businessError('CONFLICT', '客户标准明确要求按尺码核验数量允差；缺少订单行尺码矩阵或逐尺码实际数量，不能保存完工记录。');
      }
      if (businessLine === 'fabric') {
        const active = await tx.productionBatch.findMany({ where: { orderId: order.id, orderLineId: line.id, state: 'active' } });
        const shape = branchCoverage(active, line, businessLine);
        if (!shape.covered) throw businessError('CONFLICT', shape.reason ?? '面料生产分支形状不符合业务规则。');
      }
      const commandHash = hash({ operation: 'complete_production_batch', batchId: batch.id, orderId: order.id, orderLineId: line.id,
        actorId: actor.userId, revision: batch.revision, lineFingerprint, actualQty: input.actualQty, actualQtyBySize: input.actualQtyBySize ?? null });
      const priorKey = await tx.productionBatchCompletion.findFirst({ where: { recordedBy: actor.userId, requestKey: input.requestKey } });
      if (priorKey) {
        if (priorKey.commandHash !== commandHash || priorKey.productionBatchId !== batch.id)
          requestKeyConflict('生产完成请求键已用于不同分支或数量，请保留原请求。');
        const orderLineCompletion = await readOrderLineProductionCompletion(tx, order, line);
        return { completion: json(priorKey), orderLineCompletion, replayed: true };
      }
      const existing = await tx.productionBatchCompletion.findUnique({ where: { productionBatchId_productionBatchRevision: {
        productionBatchId: batch.id, productionBatchRevision: batch.revision } } });
      if (existing) throw businessError('CONFLICT', '该生产分支当前修订已登记最终完工数量，不能覆盖历史事实。');
      const actualQuantity = new Prisma.Decimal(input.actualQty);
      const now = BigInt(Date.now());
      const commandSnapshot = { protocolVersion: 1, operation: 'complete_production_batch', actorId: actor.userId,
        batchId: batch.id, orderId: order.id, orderLineId: line.id, productionBatchRevision: batch.revision,
        expectedLineFingerprint: lineFingerprint, actualQty: actualQuantity.toString(), actualQtyBySize: input.actualQtyBySize ?? null,
        unit: line.unit, requestKey: input.requestKey };
      const completion = await tx.productionBatchCompletion.create({ data: { id: `PBC__${randomUUID()}`,
        productionBatchId: batch.id, productionBatchRevision: batch.revision, orderId: order.id, orderLineId: line.id,
        actualQuantity, actualSizeBreakdown: input.actualQtyBySize ?? null, unit: line.unit, lineFingerprint, scopeSnapshot: json({ orderId: order.id, orderLineId: line.id,
          businessLine, contractQty: line.quantity, unit: line.unit, plannedBatchQty: batch.quantity, factoryRelationId: batch.factoryRelationId,
          contractSizeBreakdown: lineSizes, plannedSizeBreakdown: batch.sizeBreakdown ?? null,
          productionBatchId: batch.id, productionBatchRevision: batch.revision }), requestKey: input.requestKey,
        commandHash, commandSnapshot, recordedBy: actor.userId, recordedAt: now } });
      await writeRouteAuditLog({ prisma: tx, actorId: actor.userId, source: 'route:production:complete-batch',
        operation: 'complete_production_batch', targetType: 'ProductionBatchCompletion', targetId: completion.id,
        operationType: 'create', transactionId: completion.id, ip: params.ip,
        after: { completion: json(completion), commandSnapshot } });
      const orderLineCompletion = await readOrderLineProductionCompletion(tx, order, line);
      return { completion: json(completion), orderLineCompletion, replayed: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20_000 });
    return { ok: true, data: result } as CompletionResult<any>;
  } catch (error: any) {
    logger.error('[ProductionCompletion] 完工登记失败', { error });
    const safe = safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '生产完成结果暂不可确认，请保留原请求并刷新核对。' });
    return { ok: false, error: { code: safe.code, message: safe.message, status: safe.status } } as CompletionResult<never>;
  }
}

export async function readOrderLineCompletion(params: { prisma: PrismaClient; orderId: string; lineId: string; actor: TokenPayload | null }) {
  try {
    const productionCompletion = await params.prisma.$transaction(async (tx: any) => {
      const { order, line } = await completionReader(tx, params.actor, params.orderId, params.lineId);
      return json(await readOrderLineProductionCompletion(tx, order, line));
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    return { ok: true, data: { productionCompletion } } as CompletionResult<{ productionCompletion: typeof productionCompletion }>;
  } catch (error: any) {
    logger.error('[ProductionCompletion] 完工状态读取失败', { error });
    const safe = safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR' });
    return { ok: false, error: { code: safe.code, message: safe.message, status: safe.status } } as CompletionResult<never>;
  }
}
