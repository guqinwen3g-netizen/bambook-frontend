import { Prisma, type PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import type { TokenPayload } from '../auth/service';
import { loadUserWithRoles, buildLoadedAuthTokenPayload } from '../auth/tokenHelpers';
import { hasScope } from '../auth/permissionService';
import { SYSTEM_ROLE_IDS } from '../_shared/rolePermissionMatrix';
import { freshOrderLineScope } from '../orders/orderLineWriteAccess';
import { createShipment, updateShipment } from './shipmentMutationService';
import { writePhysicalShipmentAllocation, verifyOriginalProductionReceipt } from './shipmentPhysicalAllocationService';
import { resolveQcCoverage } from '../qc/qcPhysicalCoverage';
import { syncShipmentReferences } from '../entities/sync';
import { businessError, isBusinessError } from '../shared/errorCodes';
import { exactJsonValue } from '../lib/exactJsonValue';
import { missingRequiredShipmentFields } from './shipmentFieldRules';
import { assertShipmentExportDeclarationProof } from './shipmentExportDeclaration';
import { lockShipmentDocumentSourcesInTx } from './shipmentDocumentSource';
import { isBusinessShipmentCi, readBusinessShipmentCiVersionInTx } from '../customs/businessShipmentCiSnapshot';
import { buildBusinessShipmentCiSnapshot } from '../customs/businessShipmentCi';
import { readPackingListVersionInTx } from '../customs/shipmentPackingListCommand';
import { assertCurrentShipmentDocumentsSentInTx } from '../orders/orderShipmentDocumentsService';
import { readRequiredSampleFamilies } from '../orders/orderRequiredSampleFamilies';
import { resolveOrderSampleConsumerProof } from '../samples/orderSampleConsumerProof';
import { readBatchProductionLineIdentity } from '../production/productionLineIdentity';
import { readOrderLineProductionCompletion } from '../production/productionCompletionService';
import { readProductionQcIssueProjection } from '../qc/productionQcIssueService';
import { readProductionQcReleaseCoverage } from '../qc/productionQcSizeCoverage';
import { createFactoryLoadingReceiptInTx, verifyFactoryLoadingReceiptInTx, type FactoryLoadingFact } from './factoryLoadingReceiptService';
import { lockShipmentPhysicalConsumer } from './shipmentPhysicalConsumerService';
import { isValidLocalDateKey } from '../shared/localDate';

export const SHIPMENT_HANDOFF_STATUS = Object.freeze({
  PENDING_LOGISTICS: 'PendingLogistics',
  PROCESSING: 'Processing',
  NEEDS_BUSINESS_DECISION: 'NeedsBusinessDecision',
  RETURNED_TO_BUSINESS: 'ReturnedToBusiness',
  CANCELLED: 'Cancelled',
} as const);

export type ShipmentHandoffStatus = typeof SHIPMENT_HANDOFF_STATUS[keyof typeof SHIPMENT_HANDOFF_STATUS];

type SourceInput = {
  orderId: string;
  orderLineId: string;
  productionBatchId: string;
  productionBatchRevision: number;
  factoryRelationId: string;
  plannedQty: string;
  unit: string;
};
type CreateInput = { shippingMethod: 'Sea' | 'Air'; allocations: SourceInput[]; note?: string | null; requestKey: string };
type HandoffAction = 'start' | 'return-to-business' | 'return-to-logistics' | 'complete' | 'cancel';

const allowedStatuses = new Set<string>(Object.values(SHIPMENT_HANDOFF_STATUS));
const id = (prefix: string) => `${prefix}__${randomUUID()}`;
const json = (value: any) => JSON.parse(JSON.stringify(value));
const text = (value: unknown, label: string, max = 200): string => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw businessError('INVALID_INPUT', `${label}不能为空或超过${max}字。`);
  return value.trim();
};
const optionalText = (value: unknown, label: string, max = 2000): string | null => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > max) throw businessError('INVALID_INPUT', `${label}不能超过${max}字。`);
  return value.trim() || null;
};
const decimal = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(value))
    throw businessError('INVALID_INPUT', `${label}须为最多四位小数的非负十进制字符串。`);
  const parsed = new Prisma.Decimal(value);
  if (!parsed.gt(0)) throw businessError('INVALID_INPUT', `${label}必须大于零。`);
  return parsed.toString();
};
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
/** Exact wire serialization: BigInt timestamps and Prisma Decimal quantities
 * must remain strings so clients can send concurrency tokens back losslessly. */
export const shipmentHandoffJson = (value: unknown): any => JSON.parse(JSON.stringify(exactJsonValue(value)));
const identity = (relationId: unknown, label: unknown): string | null => {
  const idValue = typeof relationId === 'string' ? relationId.trim() : '';
  if (idValue) return `id:${idValue}`;
  const name = typeof label === 'string' ? label.trim().replace(/\s+/g, ' ').toLocaleLowerCase() : '';
  return name ? `name:${name}` : null;
};

export function parseShipmentHandoffCreateInput(value: unknown): CreateInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw businessError('INVALID_INPUT', '请提交出运交接内容。');
  const body = value as Record<string, any>;
  if (Object.keys(body).some(key => !['shippingMethod', 'allocations', 'note', 'requestKey'].includes(key)))
    throw businessError('INVALID_INPUT', '出运交接包含不可提交字段。');
  if (body.shippingMethod !== 'Sea' && body.shippingMethod !== 'Air') throw businessError('INVALID_INPUT', '运输方式请选择海运或空运。');
  if (!Array.isArray(body.allocations) || body.allocations.length < 1 || body.allocations.length > 100)
    throw businessError('INVALID_INPUT', '出运交接须包含一至一百条生产工厂分支。');
  const allocations: SourceInput[] = body.allocations.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw businessError('INVALID_INPUT', '生产工厂分支内容无效。');
    const row = raw as Record<string, any>;
    if (Object.keys(row).some(key => !['orderId', 'orderLineId', 'productionBatchId', 'productionBatchRevision', 'factoryRelationId', 'plannedQty', 'unit'].includes(key)))
      throw businessError('INVALID_INPUT', '生产工厂分支包含不可提交字段。');
    if (!Number.isSafeInteger(row.productionBatchRevision) || row.productionBatchRevision < 1)
      throw businessError('INVALID_INPUT', '请提交当前生产批次修订号。');
    return {
      orderId: text(row.orderId, '订单', 160), orderLineId: text(row.orderLineId, '订单行', 160),
      productionBatchId: text(row.productionBatchId, '生产批次', 160), productionBatchRevision: row.productionBatchRevision,
      factoryRelationId: text(row.factoryRelationId, '生产工厂', 160), plannedQty: decimal(row.plannedQty, '本次计划出运数量'),
      unit: text(row.unit, '数量单位', 24),
    };
  });
  const branchKeys = allocations.map(row => JSON.stringify([row.orderId, row.orderLineId, row.productionBatchId]));
  if (new Set(branchKeys).size !== branchKeys.length) throw businessError('INVALID_INPUT', '同一订单行和工厂批次只能提交一次，请合并数量后重试。');
  const requestKey = text(body.requestKey, '原请求键', 160);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(requestKey))
    throw businessError('INVALID_INPUT', '请为本次出运交接提交 UUID 请求键，并在网络重试时复用。');
  return { shippingMethod: body.shippingMethod, allocations, note: optionalText(body.note, '交接备注'), requestKey };
}

async function currentActor(tx: any, prior: TokenPayload | null | undefined, requiredScope: 'orders:read' | 'orders:write' | 'shipments:read' | 'shipments:write'): Promise<TokenPayload> {
  if (!prior?.userId) throw businessError('UNAUTHORIZED', '请使用当前登录账号操作。');
  let user: any;
  try { user = await loadUserWithRoles(tx, prior.userId); }
  catch { throw businessError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验当前账号和权限。'); }
  if (!user || user.status !== 'active' || user.deletedAt != null) throw businessError('ACCOUNT_DISABLED', '当前账号不可用，请重新登录。');
  let actor: TokenPayload;
  try { actor = await buildLoadedAuthTokenPayload(tx, user); }
  catch { throw businessError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验当前账号和权限。'); }
  if (prior.permissionCeiling !== undefined) actor.permissionCeiling = [...prior.permissionCeiling];
  if (!hasScope(actor, requiredScope)) throw businessError('FORBIDDEN', `当前账号缺少 ${requiredScope} 权限。`);
  return actor;
}

async function requireLogisticsActor(tx: any, prior: TokenPayload | null | undefined, write = true): Promise<TokenPayload> {
  const actor = await currentActor(tx, prior, write ? 'shipments:write' : 'shipments:read');
  if (!actor.roleIds?.some(roleId => [SYSTEM_ROLE_IDS.LOGISTICS, SYSTEM_ROLE_IDS.ADMIN, SYSTEM_ROLE_IDS.SUPER_ADMIN].includes(roleId as any)))
    throw businessError('FORBIDDEN', '当前账号没有后勤出运专业操作职责。');
  return actor;
}

async function visibleOrderMap(tx: any, orderIds: string[], actor: TokenPayload): Promise<Map<string, any>> {
  if (!hasScope(actor, 'orders:read')) throw businessError('FORBIDDEN', '当前账号没有来源订单读取权限。');
  const scope = await freshOrderLineScope(tx, actor);
  let orders: any[];
  try { orders = await tx.order.findMany({ where: { id: { in: orderIds }, deletedAt: null, AND: [scope] } }); }
  catch { throw businessError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验来源订单范围。'); }
  if (orders.length !== orderIds.length) throw businessError('ORDER_NOT_FOUND', '一个或多个来源订单不存在或不在当前可操作范围。');
  return new Map(orders.map((row: any) => [row.id, row]));
}

function assertConsolidation(orders: any[]) {
  const first = orders[0];
  const customer = identity(first.customerRelationId, first.customer);
  const consignee = identity(first.consigneeRelationId, first.consigneeName ?? first.shipToName);
  if (!customer || !consignee) throw businessError('INVALID_INPUT', '订单必须已有明确客户和收货方后才能发起出运。');
  const businessLine = typeof first.businessLine === 'string' ? first.businessLine.trim().toLowerCase() : '';
  if (!businessLine) throw businessError('INVALID_INPUT', '订单业务板块未明确，暂不能发起出运。');
  for (const order of orders.slice(1)) {
    if (identity(order.customerRelationId, order.customer) !== customer) throw businessError('CONFLICT', '一次出运只能包含同一客户的订单。');
    if (identity(order.consigneeRelationId, order.consigneeName ?? order.shipToName) !== consignee) throw businessError('CONFLICT', '一次出运只能包含同一收货方的订单。');
    if (String(order.businessLine ?? '').trim().toLowerCase() !== businessLine) throw businessError('CONFLICT', '面料与成衣订单必须分开出运；不同业务板块不能合并。');
  }
  return { customer, consignee, businessLine };
}

function groupByLine(rows: SourceInput[]) {
  const groups = new Map<string, SourceInput[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.orderId, row.orderLineId]);
    const group = groups.get(key) ?? [];
    group.push(row); groups.set(key, group);
  }
  return [...groups.values()];
}

type ResolvedSource = { input: SourceInput; order: any; orderLine: any; batch: any; factoryName: string | null;
  scopeFingerprint: string; productionCompletion?: any; businessBlockers?: Array<{ code: string; message: string }> };

function completionBlockers(orderLine: any, completion: any): Array<{ code: string; message: string }> {
  const blockers: Array<{ code: string; message: string }> = [];
  if (orderLine.partialShipmentAllowed !== true && orderLine.partialShipmentAllowed !== false)
    blockers.push({ code: 'SPLIT_SHIPMENT_RULE_UNKNOWN', message: '订单行尚未人工登记是否允许分批出运，不能按默认值推断。' });
  if (completion?.status === 'unresolved')
    blockers.push({ code: 'PRODUCTION_COMPLETION_UNRESOLVED', message: completion.blockers?.[0]?.message ?? '生产完成数量或适用允差无法核验。' });
  else if (completion?.status === 'out_of_tolerance')
    blockers.push({ code: 'PRODUCTION_TOLERANCE_REQUIRES_CUSTOMER_DECISION', message: completion.tolerance?.reason ?? '最终生产数量超出适用允差，须先完成业务/客户处理。' });
  if (orderLine.partialShipmentAllowed === false && completion?.status !== 'complete')
    blockers.push({ code: 'PRODUCTION_COMPLETION_REQUIRED', message: '合同/信用证禁止分批；须待该订单行所有生产工厂分支完成并登记最终数量、通过允差判断后再发起。' });
  return blockers;
}

async function completedBranchQuantityBlocker(tx: any, source: ResolvedSource, excludedShipmentId?: string) {
  const branch = source.productionCompletion?.branches?.find((item: any) => item.productionBatchId === source.batch.id
    && item.productionBatchRevision === source.batch.revision);
  if (!branch?.completionCurrent || branch.actualQty == null) return null;
  const rows = await tx.shipmentProductionAllocation.findMany({ where: { productionBatchId: source.batch.id, state: { in: ['reserved', 'shipped'] } } });
  let alreadyUsed = new Prisma.Decimal(0);
  for (const row of rows) {
    if (excludedShipmentId && row.shipmentId === excludedShipmentId) continue;
    if (row.state === 'reserved') {
      if (row.plannedQty == null || !new Prisma.Decimal(row.plannedQty).isFinite())
        return { code: 'PRODUCTION_ALLOCATION_AUTHORITY_UNAVAILABLE', message: '无法精确核对该生产分支已有出运预留。' };
      alreadyUsed = alreadyUsed.plus(row.actualQty == null ? row.plannedQty : Prisma.Decimal.max(row.plannedQty, row.actualQty));
    } else if (row.state === 'shipped') {
      if (row.actualQty == null || !new Prisma.Decimal(row.actualQty).isFinite())
        return { code: 'PRODUCTION_ALLOCATION_AUTHORITY_UNAVAILABLE', message: '已出运分支缺少实际装运数量，不能推断剩余可出运量。' };
      alreadyUsed = alreadyUsed.plus(row.actualQty);
    }
  }
  const remaining = new Prisma.Decimal(branch.actualQty).minus(alreadyUsed);
  if (remaining.lt(0) || new Prisma.Decimal(source.input.plannedQty).gt(remaining))
    return { code: 'PRODUCTION_QTY_EXCEEDS_FINAL_ACTUAL', message: '本次计划出运量超过该工厂分支最终完工量扣除既有有效出运/预留后的余额。' };
  return null;
}

async function resolveHandoffSources(tx: any, input: CreateInput, actor: TokenPayload): Promise<{ sourceRows: ResolvedSource[]; businessLine: string }> {
  const orderIds = [...new Set(input.allocations.map(row => row.orderId))].sort();
  const orders = await visibleOrderMap(tx, orderIds, actor);
  const orderRows = orderIds.map(orderId => orders.get(orderId));
  const { businessLine } = assertConsolidation(orderRows);
  const sourceRows: ResolvedSource[] = [];
  for (const row of input.allocations) {
    const order = orders.get(row.orderId);
    const orderLine = await tx.orderLine.findUnique({ where: { id: row.orderLineId } });
    if (!orderLine || orderLine.orderId !== row.orderId) throw businessError('ORDER_LINE_NOT_FOUND', '订单行不存在或不属于所选订单。');
    if (!orderLine.unit || orderLine.unit !== row.unit) throw businessError('CONFLICT', '出运计划单位必须与订单行单位一致，不进行隐式换算。');
    const batch = await tx.productionBatch.findUnique({ where: { id: row.productionBatchId } });
    if (!batch || batch.orderId !== row.orderId || batch.orderLineId !== row.orderLineId || batch.state !== 'active')
      throw businessError('CONFLICT', '所选生产批次不是该订单行的有效生产工厂分支。');
    if (batch.revision !== row.productionBatchRevision || batch.factoryRelationId !== row.factoryRelationId)
      throw businessError('CONFLICT', '生产批次修订或工厂归属已变化，请刷新来源后重试。');
    if (batch.unit !== row.unit || !new Prisma.Decimal(row.plannedQty).lte(batch.quantity))
      throw businessError('CONFLICT', '计划出运量或单位超出所选工厂生产分支范围。');
    const factory = await tx.relation.findUnique({ where: { id: batch.factoryRelationId }, select: { id: true, name: true, deletedAt: true } });
    if (!factory || factory.deletedAt != null) throw businessError('CONFLICT', '生产工厂资料不存在或已停用，请核对批次来源。');
    // This scope fingerprint is the existing physical-allocation source identity
    // only. It is NOT evidence that QC/customer approval gates have passed.
    const coverage = await resolveQcCoverage(tx, row.orderId, { scopeType: 'production_batch', productionBatchId: batch.id });
    sourceRows.push({ input: row, order, orderLine, batch, factoryName: factory.name ?? null, scopeFingerprint: coverage.scopeFingerprint });
  }
  for (const group of groupByLine(input.allocations)) {
    const first = group[0], source = sourceRows.find(row => row.input.orderId === first.orderId && row.input.orderLineId === first.orderLineId)!;
    const lineSources = sourceRows.filter(row => row.input.orderId === first.orderId && row.input.orderLineId === first.orderLineId);
    const completion = await readOrderLineProductionCompletion(tx, source.order, source.orderLine);
    for (const item of lineSources) item.productionCompletion = completion;
    const rule = source.orderLine.partialShipmentAllowed;
    const blockers = completionBlockers(source.orderLine, completion);
    for (const item of lineSources) item.businessBlockers = [...(item.businessBlockers ?? []), ...blockers];
    if (rule === true) {
      for (const item of lineSources) {
        const quantityBlocker = await completedBranchQuantityBlocker(tx, item);
        if (quantityBlocker) item.businessBlockers = [...(item.businessBlockers ?? []), quantityBlocker];
      }
    }
    if (rule === false) {
      if (completion.status === 'complete') {
        const activeBranches = completion.branches ?? [];
        const requestedByBatch = new Map(lineSources.map(item => [item.batch.id, item.input.plannedQty]));
        const allBranchesIncluded = activeBranches.length === requestedByBatch.size
          && activeBranches.every((branch: any) => requestedByBatch.has(branch.productionBatchId));
        const exactFinalQty = allBranchesIncluded && activeBranches.every((branch: any) =>
          branch.actualQty != null && new Prisma.Decimal(requestedByBatch.get(branch.productionBatchId)!).eq(branch.actualQty));
        if (!allBranchesIncluded || !exactFinalQty) for (const item of lineSources) item.businessBlockers = [...(item.businessBlockers ?? []),
          { code: 'NO_SPLIT_SHIPMENT_MUST_COVER_FINAL_PRODUCTION', message: '禁止分批出运时，本次出运必须覆盖全部有效工厂分支并与各分支最终完工数量一致。' }];
      }
      const priorAllocations = await tx.shipmentOrderAllocation.findMany({ where: { orderId: first.orderId, orderLineId: first.orderLineId,
        status: { not: 'Cancelled' } }, select: { shipmentId: true } });
      const priorShipmentIds = [...new Set<string>(priorAllocations.map((row: any) => row.shipmentId))];
      const priorShipments = priorShipmentIds.length ? await tx.shipment.findMany({ where: { id: { in: priorShipmentIds }, deletedAt: null,
        status: { not: 'Cancelled' } }, select: { id: true } }) : [];
      if (priorShipments.length) {
        for (const item of lineSources) item.businessBlockers = [...(item.businessBlockers ?? []),
          { code: 'SPLIT_SHIPMENT_ALREADY_STARTED', message: '订单行已存在未取消的出运分配；合同/信用证禁止分批，不能再次创建出运。' }];
      }
    }
  }
  return { sourceRows, businessLine };
}

const FAMILY_LABEL: Record<string, string> = {
  garment_pp: '产前样', garment_ship: '船样', fabric_eps: '先锋样', fabric_ss: '船样', fabric_rc: '匹头样',
};

async function sampleFamilyBlockers(tx: any, source: ResolvedSource) {
  const families = readRequiredSampleFamilies(source.orderLine.requiredSampleFamilies, source.order);
  if (!families?.length) return { families: null, evidence: [], blockers: [{ code: 'REQUIRED_SAMPLE_CONFIG_MISSING', message: '订单行未冻结有效的必需样品族配置，请补齐后再发起出运。' }] };
  const blockers: Array<{ code: string; message: string; family?: string }> = [];
  const evidence: Array<{ family: string; proofFingerprint: string | null }> = [];
  for (const family of families) {
    let proof: any;
    try {
      proof = await resolveOrderSampleConsumerProof(tx, { kind: 'production_batch', id: source.batch.id }, family);
    } catch {
      evidence.push({ family, proofFingerprint: null });
      blockers.push({ code: 'REQUIRED_SAMPLE_PROOF_UNAVAILABLE', family,
        message: `${FAMILY_LABEL[family] ?? family}的当前样品评审与需求方确认依据暂不可读取。` });
      continue;
    }
    if (!proof?.qualified || proof.mode !== 'native' || !proof.proof) {
      evidence.push({ family, proofFingerprint: null });
      blockers.push({ code: 'REQUIRED_SAMPLE_NOT_APPROVED', family,
        message: `${FAMILY_LABEL[family] ?? family}未完成当前工厂批次的样品送审与需求方确认（${proof?.reason ?? proof?.mode ?? '资格未知'}）。` });
      continue;
    }
    const scope = proof.proof.scope;
    const report: any = proof.proof.qcReport;
    const reportFact = report?.fact ?? report;
    // The resolver already revalidates the accurate current parents, sample
    // source, QC/audit and actual requester events above. Its parentFingerprint
    // also contains Order.updatedAt, a concurrency stamp changed by unrelated
    // shipment status projections. Freeze every business evidence field here,
    // without mistaking that stamp (or its enclosing digest) for new sample
    // facts. A changed source, scope, QC, head, feedback or audit still differs.
    const { parentFingerprint: _parentStamp, proofFingerprint: _resolverDigest, ...sampleBusinessEvidence } = proof.proof;
    evidence.push({ family, proofFingerprint: hash(sampleBusinessEvidence) });
    if (scope?.orderLineId !== source.input.orderLineId || scope?.productionBatchId !== source.batch.id
      || scope?.productionBatchRevision !== source.batch.revision) {
      blockers.push({ code: 'REQUIRED_SAMPLE_SCOPE_STALE', family,
        message: `${FAMILY_LABEL[family] ?? family}评审依据不是当前订单行、工厂批次和修订。` });
    } else if (reportFact?.result !== 'passed') {
      blockers.push({ code: 'REQUIRED_SAMPLE_QC_NOT_PASSED', family,
        message: `${FAMILY_LABEL[family] ?? family}必须先有当前版本 QC 通过，再由需求方确认。` });
    }
    if (family === 'garment_pp') {
      let productionLineIdentity;
      try { productionLineIdentity = await readBatchProductionLineIdentity(tx, source.batch); }
      catch {
        blockers.push({ code: 'PP_PRODUCTION_LINE_SCOPE_STALE', family,
          message: '当前实际生产线与冻结声明已变化或暂不可核验，请重新核对本线的产前样依据。' });
        continue;
      }
      if (!productionLineIdentity) {
        blockers.push({ code: 'PP_PRODUCTION_LINE_IDENTITY_MISSING', family,
          message: '请明确本工厂按单线整体履约，或选择实际生产线，再核对对应产前样 QC 与需求方确认；旧批次未知声明不能自动推算。' });
      } else if (scope?.productionLineMode !== productionLineIdentity.mode
        || scope?.productionLineId !== productionLineIdentity.productionLineId
        || scope?.productionLineRevision !== productionLineIdentity.lineRevision
        || scope?.productionLineFingerprint !== productionLineIdentity.fingerprint) {
        blockers.push({ code: 'PP_PRODUCTION_LINE_SCOPE_STALE', family,
          message: '产前样评审没有覆盖当前实际生产线，请重新按该生产线送审。' });
      }
    }
  }
  return { families, evidence, blockers };
}

async function productionQcIssueBlockers(tx: any, source: ResolvedSource) {
  const projection = await readProductionQcIssueProjection(tx, { orderId: source.input.orderId, orderLineId: source.input.orderLineId,
    productionBatchId: source.batch.id, productionBatchRevision: source.batch.revision });
  if (!projection.available) return { evidence: null, blockers: [{ code: 'PRODUCTION_QC_AUTHORITY_UNAVAILABLE',
    message: `${projection.error ?? '生产 QC 问题台账暂不可读取'}，不能确认当前工厂批次没有未解除 NOK。` }] };
  const blockers: Array<{ code: string; message: string }> = [];
  for (const issue of projection.issues) {
    if (issue.status !== 'resumed') {
      blockers.push({ code: issue.status === 'waiting_business_resume' ? 'PRODUCTION_QC_WAITING_BUSINESS_RESUME'
        : issue.status === 'unknown' ? 'PRODUCTION_QC_AUTHORITY_UNAVAILABLE' : 'PRODUCTION_QC_ISSUE_OPEN',
        message: issue.status === 'waiting_business_resume'
          ? '该工厂批次的 QC 复验已通过，仍须业务员明确确认继续生产。'
          : issue.status === 'unknown' ? '生产 QC 问题历史或复验报告无法核实，不能出运。'
            : '该工厂批次存在未解除的生产 QC NOK，不能出运。' });
    }
  }
  return { evidence: projection.issues, blockers };
}

async function gateBlockersForSource(tx: any, source: ResolvedSource) {
  const samples = await sampleFamilyBlockers(tx, source), qc = await productionQcIssueBlockers(tx, source);
  return { requiredSampleFamilies: samples.families, blockers: [...samples.blockers, ...qc.blockers, ...(source.businessBlockers ?? [])],
    eligibilityFingerprint: hash({ orderId: source.input.orderId, orderLineId: source.input.orderLineId,
      productionBatchId: source.batch.id, productionBatchRevision: source.batch.revision,
      requiredSampleFamilies: samples.families, sampleEvidence: samples.evidence, productionQcIssueEvidence: qc.evidence,
      partialShipmentAllowed: source.orderLine.partialShipmentAllowed,
      productionCompletion: source.productionCompletion ? { status: source.productionCompletion.status,
        productionComplete: source.productionCompletion.productionComplete, actualQty: source.productionCompletion.actualQty,
        tolerance: source.productionCompletion.tolerance, branches: source.productionCompletion.branches?.map((branch: any) => ({
          productionBatchId: branch.productionBatchId, productionBatchRevision: branch.productionBatchRevision,
          actualQty: branch.actualQty, completionCurrent: branch.completionCurrent })) } : null }) };
}

/** Preview the current per-factory eligibility blockers without writing a Shipment. */
export async function evaluateShipmentHandoffEligibility(params: { prisma: PrismaClient; actor: TokenPayload | null; input: unknown }) {
  const input = parseShipmentHandoffCreateInput(params.input);
  return params.prisma.$transaction(async (tx: any) => {
    const actor = await currentActor(tx, params.actor, 'orders:write');
    const { sourceRows } = await resolveHandoffSources(tx, input, actor);
    const branches = await Promise.all(sourceRows.map(async source => {
      const gate = await gateBlockersForSource(tx, source);
      return { orderId: source.input.orderId, orderLineId: source.input.orderLineId,
        productionBatchId: source.batch.id, productionBatchRevision: source.batch.revision,
        factoryRelationId: source.batch.factoryRelationId, plannedQty: source.input.plannedQty, unit: source.input.unit,
        requiredSampleFamilies: gate.requiredSampleFamilies, eligibilityFingerprint: gate.eligibilityFingerprint,
        partialShipmentAllowed: source.orderLine.partialShipmentAllowed,
        productionCompletion: source.productionCompletion ?? { status: 'unknown', actualQty: null, unit: source.input.unit }, blockers: gate.blockers };
    }));
    return { eligible: branches.length > 0 && branches.every(branch => branch.blockers.length === 0), branches };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

async function readBundle(tx: any, handoffId: string, actor: TokenPayload) {
  const handoff = await tx.shipmentHandoff.findUnique({ where: { id: handoffId } });
  if (!handoff) throw businessError('NOT_FOUND', '出运交接不存在或不可查看。');
  const lines = await tx.shipmentHandoffLine.findMany({ where: { handoffId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const orderIds = [...new Set<string>(lines.map((line: any) => line.orderId))].sort();
  const visibleOrders = orderIds.length ? await visibleOrderMap(tx, orderIds, actor) : new Map<string, any>();
  const productionCompletionByLine = new Map<string, any>();
  for (const line of lines) {
    const key = JSON.stringify([line.orderId, line.orderLineId]);
    if (productionCompletionByLine.has(key)) continue;
    const order = visibleOrders.get(line.orderId);
    const orderLine = await tx.orderLine.findUnique({ where: { id: line.orderLineId } });
    if (!order || !orderLine || orderLine.orderId !== line.orderId) throw businessError('ORDER_LINE_NOT_FOUND', '出运交接来源订单行不存在或不可查看。');
    productionCompletionByLine.set(key, await readOrderLineProductionCompletion(tx, order, orderLine));
  }
  const shipment = await tx.shipment.findUnique({ where: { id: handoff.shipmentId } });
  if (!shipment || shipment.deletedAt != null) throw businessError('NOT_FOUND', '关联出运记录不存在或不可查看。');
  const allocationIds = [...new Set<string>(lines.map((line: any) => line.allocationId))];
  const allocations = allocationIds.length ? await tx.shipmentOrderAllocation.findMany({ where: { id: { in: allocationIds } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }) : [];
  const physicalRows = allocationIds.length ? await tx.shipmentProductionAllocation.findMany({ where: { allocationId: { in: allocationIds } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }) : [];
  const batchIds = [...new Set<string>(physicalRows.map((row: any) => row.productionBatchId))];
  const batches = batchIds.length ? await tx.productionBatch.findMany({ where: { id: { in: batchIds } }, select: { id: true, factoryRelationId: true } }) : [];
  const factoryByBatch = new Map<string, string>(batches.map((row: any) => [row.id, row.factoryRelationId]));
  const productionByAllocation = new Map<string, any[]>();
  for (const row of physicalRows) {
    const branch = productionByAllocation.get(row.allocationId) ?? [];
    branch.push(row); productionByAllocation.set(row.allocationId, branch);
  }
  const events = await tx.shipmentHandoffEvent.findMany({ where: { handoffId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return { handoff: { ...handoff, expectedUpdatedAt: String(handoff.updatedAt) }, shipment,
    allocations: allocations.map((allocation: any) => ({ ...allocation, expectedUpdatedAt: String(allocation.updatedAt),
      productionBatchAllocations: (productionByAllocation.get(allocation.id) ?? []).map((row: any) => ({ ...row,
        expectedUpdatedAt: String(row.updatedAt), factoryRelationId: factoryByBatch.get(row.productionBatchId) ?? null,
        scopeFingerprint: row.scopeSnapshot?.scopeFingerprint ?? null,
    stockReceiptAllocations: Array.isArray(row.scopeSnapshot?.receiptAllocations) ? row.scopeSnapshot.receiptAllocations : [] })) })), lines: lines.map((line: any) => ({ ...line,
    productionCompletion: productionCompletionByLine.get(JSON.stringify([line.orderId, line.orderLineId])) ?? { status: 'unknown', actualQty: null, unit: line.unit } })), events };
}

export async function createShipmentHandoff(params: { prisma: PrismaClient; actor: TokenPayload | null; input: unknown; ip?: string | null }) {
  const input = parseShipmentHandoffCreateInput(params.input), businessActorId = params.actor?.userId;
  if (!businessActorId) throw businessError('UNAUTHORIZED', '请使用当前登录账号发起出运。');
  const commandHash = hash(input);
  const create = async (tx: any) => {
    const actor = await currentActor(tx, params.actor, 'orders:write');
    const prior = input.requestKey ? await tx.shipmentHandoff.findFirst({ where: { businessActorId, requestKey: input.requestKey } }) : null;
    if (prior) {
      if (prior.commandHash !== commandHash) throw businessError('REQUEST_CONFLICT', '原请求键已用于不同出运范围，请核对原请求。');
      return readBundle(tx, prior.id, actor);
    }

    const { sourceRows, businessLine } = await resolveHandoffSources(tx, input, actor);
    const gateEntries = await Promise.all(sourceRows.map(async source => ({ source, gate: await gateBlockersForSource(tx, source) })));
    const gateBranches = gateEntries.map(({ source, gate }) => ({ orderId: source.input.orderId, orderLineId: source.input.orderLineId,
      productionBatchId: source.batch.id, productionBatchRevision: source.batch.revision,
      factoryRelationId: source.batch.factoryRelationId, plannedQty: source.input.plannedQty, unit: source.input.unit,
      requiredSampleFamilies: gate.requiredSampleFamilies, eligibilityFingerprint: gate.eligibilityFingerprint,
      partialShipmentAllowed: source.orderLine.partialShipmentAllowed,
      productionCompletion: source.productionCompletion ?? { status: 'unknown', actualQty: null, unit: source.input.unit }, blockers: gate.blockers }));
    if (gateBranches.some(branch => branch.blockers.length)) {
      const blocked = businessError('GATE_BLOCKED', '出运交接资格无法安全确认，请先补齐订单行必需样品门禁和生产 QC 问题解除事实。');
      (blocked as any).details = { eligible: false, branches: gateBranches };
      throw blocked;
    }
    const orderIds = [...new Set(input.allocations.map(row => row.orderId))].sort();
    const orderRows = orderIds.map(orderId => sourceRows.find(row => row.input.orderId === orderId)!.order);

    const firstOrder = orderRows[0];
    const shipmentResult = await createShipment({ prisma: params.prisma, tx, actor, businessHandoffDraft: true, actorId: actor.userId, ip: params.ip,
      auditSource: 'route:shipping:handoff-create', auditOperation: 'create_shipment_handoff', syncSource: 'route:shipping:handoff-create',
      input: { type: 'Export', status: 'Draft', shippingMethod: input.shippingMethod, orderId: null, businessLine,
        customerRelationId: firstOrder.customerRelationId ?? null, customerName: firstOrder.customer ?? null,
        consigneeRelationId: firstOrder.consigneeRelationId ?? null, consigneeName: firstOrder.consigneeName ?? firstOrder.shipToName ?? null,
        notes: input.note ?? null },
    });
    if (!shipmentResult.ok) throw businessError(shipmentResult.error?.code ?? 'CREATE_FAILED', shipmentResult.error?.message ?? '创建出运交接失败。');
    const shipmentId = shipmentResult.data!.shipment.id as string;
    const handoffId = id('SHH'), now = BigInt(Date.now());
    const handoff = await tx.shipmentHandoff.create({ data: { id: handoffId, shipmentId,
      status: SHIPMENT_HANDOFF_STATUS.PENDING_LOGISTICS, businessActorId: actor.userId, logisticsActorId: null,
      requestKey: input.requestKey ?? null, commandHash, note: input.note ?? null,
      discrepancyReason: null, businessResponse: null, returnedToBusinessAt: null, businessRespondedAt: null,
      completedAt: null, createdAt: now, updatedAt: now } });

    const handoffLines: any[] = [];
    for (const group of groupByLine(sourceRows.map(row => row.input))) {
      const first = group[0];
      const branchRows = group.map(row => sourceRows.find(source => source.input.orderId === row.orderId
        && source.input.orderLineId === row.orderLineId && source.input.productionBatchId === row.productionBatchId)!).map(source => ({
        productionBatchId: source.batch.id, expectedRevision: source.batch.revision, expectedScopeFingerprint: source.scopeFingerprint,
        stockReceiptId: null, plannedQty: source.input.plannedQty, actualQty: null, unit: source.input.unit,
      }));
      const total = branchRows.reduce((sum, row) => sum.plus(row.plannedQty!), new Prisma.Decimal(0)).toString();
      const allocation = await writePhysicalShipmentAllocation({ prisma: params.prisma, tx, shipmentId, actor,
        handoffAuthorization: { handoffId, operation: 'create' },
        input: { requestKey: `handoff:${handoffId}:${hash([first.orderId, first.orderLineId]).slice(0, 40)}`,
          orderId: first.orderId, orderLineId: first.orderLineId, plannedQty: total, actualQty: null,
          unit: first.unit, status: 'Planned', productionBatchAllocations: branchRows } });
      if (!allocation.ok) throw businessError(allocation.error.code, allocation.error.message);
      const allocationId = allocation.data!.allocation.id as string;
      for (const row of group) {
        const source = sourceRows.find(value => value.input.orderId === row.orderId
          && value.input.orderLineId === row.orderLineId && value.input.productionBatchId === row.productionBatchId)!;
        const gate = gateEntries.find(value => value.source === source)!.gate;
        const line = await tx.shipmentHandoffLine.create({ data: { id: id('SHHL'), handoffId, allocationId,
          orderId: row.orderId, orderLineId: row.orderLineId, productionBatchId: row.productionBatchId,
          productionBatchRevision: source.batch.revision, factoryRelationId: source.batch.factoryRelationId,
          factoryName: source.factoryName, scopeFingerprint: source.scopeFingerprint,
          partialShipmentAllowed: source.orderLine.partialShipmentAllowed,
          requiredSampleFamilies: gate.requiredSampleFamilies as any,
          eligibilityFingerprint: gate.eligibilityFingerprint,
          plannedQty: new Prisma.Decimal(row.plannedQty), unit: row.unit, createdAt: now } });
        handoffLines.push(line);
      }
    }
    await tx.shipmentHandoffEvent.create({ data: { id: id('SHHE'), handoffId, fromStatus: null,
      toStatus: SHIPMENT_HANDOFF_STATUS.PENDING_LOGISTICS, actorId: actor.userId, note: input.note ?? '业务员发起出运交接。', createdAt: now } });
    const shipment = await tx.shipment.findUnique({ where: { id: shipmentId } });
    await syncShipmentReferences(params.prisma, shipment, { source: 'route:shipping:handoff-create' }, tx);
    return readBundle(tx, handoff.id, actor);
  };

  try { return await params.prisma.$transaction(create, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20_000 }); }
  catch (error) {
    if (isBusinessError(error)) throw error;
    // A concurrent retry key collision is resolved to the committed identical
    // result; the losing transaction has rolled back all shipment/allocations.
    if (input.requestKey) {
      const existing = await (params.prisma as any).shipmentHandoff.findFirst({ where: { businessActorId, requestKey: input.requestKey } });
      if (existing && existing.commandHash === commandHash) return params.prisma.$transaction(async tx => {
        const actor = await currentActor(tx, params.actor, 'orders:read'); return readBundle(tx, existing.id, actor);
      });
      if (existing) throw businessError('REQUEST_CONFLICT', '原请求键已用于不同出运范围，请核对原请求。');
    }
    throw error;
  }
}

async function assertHandoffReadable(tx: any, idValue: string, actor: TokenPayload) {
  const handoff = await tx.shipmentHandoff.findUnique({ where: { id: idValue } });
  if (!handoff) throw businessError('NOT_FOUND', '出运交接不存在或不可查看。');
  const lines = await tx.shipmentHandoffLine.findMany({ where: { handoffId: handoff.id } });
  const orderIds = [...new Set<string>(lines.map((row: any) => row.orderId))].sort();
  if (orderIds.length) await visibleOrderMap(tx, orderIds, actor);
  return handoff;
}

export async function readShipmentHandoff(params: { prisma: PrismaClient; handoffId: string; actor: TokenPayload | null }) {
  return params.prisma.$transaction(async (tx: any) => {
    const actor = await currentActor(tx, params.actor, 'shipments:read');
    if (!hasScope(actor, 'orders:read')) throw businessError('FORBIDDEN', '当前账号没有来源订单读取权限。');
    await assertHandoffReadable(tx, params.handoffId, actor);
    return readBundle(tx, params.handoffId, actor);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function listShipmentHandoffs(params: { prisma: PrismaClient; actor: TokenPayload | null; status?: string }) {
  return params.prisma.$transaction(async (tx: any) => {
    const actor = await currentActor(tx, params.actor, 'shipments:read');
    if (!hasScope(actor, 'orders:read')) throw businessError('FORBIDDEN', '当前账号没有来源订单读取权限。');
    if (params.status && !allowedStatuses.has(params.status)) throw businessError('INVALID_INPUT', '出运交接状态筛选值无效。');
    const rows = await tx.shipmentHandoff.findMany({ where: params.status ? { status: params.status } : {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 });
    const result: any[] = [];
    for (const handoff of rows) {
      try { await assertHandoffReadable(tx, handoff.id, actor); result.push(await readBundle(tx, handoff.id, actor)); }
      catch (error) { if (isBusinessError(error) && ['ORDER_NOT_FOUND', 'NOT_FOUND'].includes(error.code)) continue; throw error; }
    }
    return result;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

function parseCursor(value: unknown): { createdAt: bigint; id: string } | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 300) throw businessError('INVALID_INPUT', '出运交接分页游标无效。');
  let decoded: string;
  try { decoded = Buffer.from(value, 'base64url').toString('utf8'); } catch { throw businessError('INVALID_INPUT', '出运交接分页游标无效。'); }
  const separator = decoded.indexOf(':');
  const timestamp = separator < 0 ? '' : decoded.slice(0, separator), cursorId = separator < 0 ? '' : decoded.slice(separator + 1);
  if (!/^(?:0|[1-9]\d*)$/.test(timestamp) || !cursorId || cursorId.length > 160
    || Buffer.from(decoded).toString('base64url') !== value) throw businessError('INVALID_INPUT', '出运交接分页游标无效。');
  return { createdAt: BigInt(timestamp), id: cursorId };
}

const makeCursor = (row: { createdAt: bigint; id: string }) => Buffer.from(`${row.createdAt.toString()}:${row.id}`).toString('base64url');

/** Stable cursor page. An order-specific query first resolves exact source
 * handoffs from the immutable line snapshots, avoiding the former latest-100
 * scan that could omit older business returns. */
export async function listShipmentHandoffsPage(params: { prisma: PrismaClient; actor: TokenPayload | null; status?: string;
  orderId?: string; cursor?: string; limit?: number }) {
  return params.prisma.$transaction(async (tx: any) => {
    const actor = await currentActor(tx, params.actor, 'shipments:read');
    if (!hasScope(actor, 'orders:read')) throw businessError('FORBIDDEN', '当前账号没有来源订单读取权限。');
    if (params.status && !allowedStatuses.has(params.status)) throw businessError('INVALID_INPUT', '出运交接状态筛选值无效。');
    const limit = params.limit ?? 30;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw businessError('INVALID_INPUT', '每页条数须在 1 至 100 之间。');
    const cursor = parseCursor(params.cursor);
    const orderId = params.orderId?.trim();
    let handoffIds: string[] | undefined;
    if (orderId) {
      await visibleOrderMap(tx, [orderId], actor);
      const sourceRows = await tx.shipmentHandoffLine.findMany({ where: { orderId }, select: { handoffId: true }, distinct: ['handoffId'] });
      handoffIds = sourceRows.map((row: any) => row.handoffId).sort();
      if (!handoffIds?.length) return { items: [], page: { limit, nextCursor: null as string | null } };
    }
    const clauses: any[] = [];
    if (params.status) clauses.push({ status: params.status });
    if (handoffIds) clauses.push({ id: { in: handoffIds } });
    if (cursor) clauses.push({ OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] });
    const rows = await tx.shipmentHandoff.findMany({ where: clauses.length ? { AND: clauses } : {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1 });
    const hasMore = rows.length > limit, pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items: any[] = [];
    for (const handoff of pageRows) {
      try { await assertHandoffReadable(tx, handoff.id, actor); items.push(await readBundle(tx, handoff.id, actor)); }
      catch (error) { if (isBusinessError(error) && ['ORDER_NOT_FOUND', 'NOT_FOUND'].includes(error.code)) continue; throw error; }
    }
    const lastScanned = pageRows[pageRows.length - 1];
    return { items, page: { limit, nextCursor: hasMore && lastScanned ? makeCursor(lastScanned) : null } };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

function gateBlocked(message: string): never { throw businessError('GATE_BLOCKED', message); }

/** Compare the mutable Shipment/SOA/physical set with the immutable handoff
 * branch snapshots plus append-only approved plan revisions. This prevents a
 * legacy writer or an out-of-band insert from adding carton scope after the
 * handoff was created. */
async function assertLiveHandoffAllocationSnapshot(tx: any, handoffId: string, shipmentId: string) {
  const lines = await tx.shipmentHandoffLine.findMany({ where: { handoffId }, orderBy: [{ allocationId: 'asc' }, { productionBatchId: 'asc' }] });
  if (!lines.length) gateBlocked('出运交接缺少不可变订单行/工厂分支快照。');
  const allocationIds = [...new Set<string>(lines.map((line: any) => line.allocationId))].sort();
  const [allocations, physical, events] = await Promise.all([
    tx.shipmentOrderAllocation.findMany({ where: { shipmentId }, orderBy: [{ id: 'asc' }] }),
    tx.shipmentProductionAllocation.findMany({ where: { shipmentId }, orderBy: [{ allocationId: 'asc' }, { productionBatchId: 'asc' }, { id: 'asc' }] }),
    tx.shipmentHandoffEvent.findMany({ where: { handoffId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
  ]);
  const liveAllocationIds = allocations.filter((row: any) => row.status !== 'Cancelled').map((row: any) => row.id).sort();
  if (JSON.stringify(liveAllocationIds) !== JSON.stringify(allocationIds)) gateBlocked('本票订单行分配集合与交接快照不一致；不能把快照外装运行加入本票。');

  const revisedPlan = new Map<string, string>();
  for (const event of events) {
    const revisions = event?.payload?.allocationRevisions;
    if (Array.isArray(revisions)) for (const revision of revisions) {
      if (typeof revision?.allocationId !== 'string' || !Array.isArray(revision.productionBatchAllocations)) continue;
      const branchPlans = new Map<string, Prisma.Decimal>();
      for (const branch of revision.productionBatchAllocations) {
        if (typeof branch?.productionBatchId === 'string' && branch.revisedPlannedQty != null) {
          const key = `${revision.allocationId}\u0000${branch.productionBatchId}`;
          branchPlans.set(key, (branchPlans.get(key) ?? new Prisma.Decimal(0)).plus(String(branch.revisedPlannedQty)));
        }
      }
      for (const [key, quantity] of branchPlans) revisedPlan.set(key, quantity.toString());
    }
  }
  const byAllocation = new Map<string, any>(allocations.map((row: any) => [row.id, row]));
  const branchRows = new Map<string, any[]>();
  for (const row of physical) {
    const key = `${row.allocationId}\u0000${row.productionBatchId}`, rows = branchRows.get(key) ?? [];
    rows.push(row); branchRows.set(key, rows);
  }
  const snapshotKeys = new Set<string>();
  for (const line of lines) {
    const allocation = byAllocation.get(line.allocationId);
    if (!allocation || allocation.orderId !== line.orderId || allocation.orderLineId !== line.orderLineId || allocation.unit !== line.unit)
      gateBlocked('交接订单行分配身份、单位与冻结来源不一致。');
    const batch = await tx.productionBatch.findUnique({ where: { id: line.productionBatchId } });
    if (!batch || batch.orderId !== line.orderId || batch.orderLineId !== line.orderLineId
      || batch.revision !== line.productionBatchRevision || batch.factoryRelationId !== line.factoryRelationId)
      gateBlocked('交接工厂分支已变化，请重新评估出运资格。');
    const key = `${line.allocationId}\u0000${line.productionBatchId}`;
    snapshotKeys.add(key);
    const rows = branchRows.get(key) ?? [];
    if (!rows.length || rows.some((row: any) => row.state !== 'reserved' || row.productionBatchRevision !== line.productionBatchRevision))
      gateBlocked('本票物理分支缺失、已释放或修订号与交接快照不一致。');
    const planned = rows.reduce((sum: Prisma.Decimal, row: any) => {
      if (row.plannedQty == null) return gateBlocked('本票物理分支计划量不完整。');
      return sum.plus(String(row.plannedQty));
    }, new Prisma.Decimal(0)).toString();
    const expected = revisedPlan.get(key) ?? new Prisma.Decimal(String(line.plannedQty)).toString();
    if (planned !== expected) gateBlocked('本票物理分支计划量与原交接或已审计修订不一致。');
  }
  if ([...branchRows.keys()].some(key => !snapshotKeys.has(key))) gateBlocked('本票存在交接快照以外的额外工厂分支。');
  for (const allocationId of allocationIds) {
    const allocation = byAllocation.get(allocationId), group = lines.filter((line: any) => line.allocationId === allocationId);
    const expectedTotal = group.reduce((sum: Prisma.Decimal, line: any) => sum.plus(
      revisedPlan.get(`${allocationId}\u0000${line.productionBatchId}`) ?? String(line.plannedQty)), new Prisma.Decimal(0));
    if (allocation.plannedQty == null || !new Prisma.Decimal(String(allocation.plannedQty)).equals(expectedTotal))
      gateBlocked('订单行汇总计划量与其全部冻结工厂分支不一致。');
  }
}

async function cancelHandoffShipment(params: { tx: any; prisma: PrismaClient; shipment: any; handoff: any; actor: TokenPayload; ip?: string | null }) {
  const { tx, prisma, shipment, handoff, actor } = params;
  if (shipment.status !== 'Draft' || shipment.atd != null || shipment.type !== 'Export')
    throw businessError('INVALID_STATE', '只有尚未订舱、未实际出运的出口草稿票可以取消交接。');
  const externalFields = ['bookingDate', 'bookingNo', 'soNumber', 'spaceConfirmedAt', 'cutOffAt', 'docCutOffAt', 'etd',
    'vesselOrFlight', 'voyageNumber', 'portOfLoading', 'portOfDischarge', 'customsDeclarationNumber',
    'exportDeclarationCompletedAt', 'exportDeclarationReference', 'exportDeclarationEvidenceDocumentId'];
  if (externalFields.some(key => shipment[key] !== null && shipment[key] !== undefined && shipment[key] !== ''))
    throw businessError('INVALID_STATE', '本票已有订舱、运输或出口申报事实，不能直接取消；请先按相关单据作废流程处理。');
  const docs = await tx.tradeDocument.findMany({ where: { shipmentId: shipment.id, domain: 'customs', type: { in: ['CommercialInvoice', 'PackingList'] },
    status: { not: 'Cancelled' }, deletedAt: null }, select: { id: true, type: true, status: true } });
  if (docs.length) throw businessError('INVALID_STATE', '本票已有 CI 或 Packing List 单据记录，不能直接取消；请先按单据作废流程处理。');
  const declarationProof = await tx.tradeDocument.findFirst({ where: { shipmentId: shipment.id, domain: 'customs', type: 'ExportDeclarationProof', deletedAt: null } });
  if (declarationProof) throw businessError('INVALID_STATE', '本票已有出口申报凭证，不能直接取消；请先按凭证作废流程处理。');
  const [source] = await lockShipmentDocumentSourcesInTx(tx, [shipment.id], { trustedActor: actor, extraScopes: ['customs:read'] });
  if (!source || source.kind !== 'physical') throw businessError('CONFLICT', '本票物理批次预留来源不完整，不能安全取消。');
  const result = await updateShipment({ prisma, tx, shipmentId: shipment.id, actor, actorId: actor.userId, ip: params.ip,
    patch: { status: 'Cancelled' }, hasStatus: true, auditSource: 'route:shipping:handoff-cancel', syncSource: 'route:shipping:handoff-cancel',
    handoffCancellationId: handoff.id,
    physicalCommand: { requestKey: `handoff-cancel:${handoff.id}:${handoff.updatedAt}`, expectedShipmentUpdatedAt: String(shipment.updatedAt),
      expectedPhysicalAllocationFingerprint: source.allocationFingerprint } });
  if (!result.ok) throw businessError(result.error?.code ?? 'CANCEL_FAILED', result.error?.message ?? '出运草稿取消失败。');
  return { shipment: result.data!.shipment, releasedAllocationIds: source.allocations.map((row: any) => row.id) };
}

/** Validate current business CI and native PL evidence before returning a
 * logistics packet to business. This never marks a shipment as departed. */
async function assertHandoffDocumentsReady(tx: any, shipmentId: string, actor: TokenPayload): Promise<any> {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Shipment" WHERE "id" = ${shipmentId} FOR UPDATE`);
  const shipment = await tx.shipment.findUnique({ where: { id: shipmentId } });
  if (!shipment || shipment.deletedAt != null) throw businessError('NOT_FOUND', '关联出运记录不存在或不可查看。');
  if (shipment.type !== 'Export') gateBlocked('仅出口出运资料可以通过后勤单证完成交接。');
  if (shipment.status !== 'Booked') gateBlocked('订舱尚未完成，后勤单证不能把出运资料交回业务。');
  const handoff = await tx.shipmentHandoff.findUnique({ where: { shipmentId } });
  if (!handoff || !['Processing', 'NeedsBusinessDecision', 'ReturnedToBusiness'].includes(handoff.status)) gateBlocked('本票没有可完成的有效出运交接。');
  await assertLiveHandoffAllocationSnapshot(tx, handoff.id, shipmentId);
  const missingFields = missingRequiredShipmentFields(shipment);
  if (missingFields.length) gateBlocked(`运输资料尚未完整：${missingFields.join('、')}。`);
  await assertShipmentExportDeclarationProof(tx, shipment);

  const [source] = await lockShipmentDocumentSourcesInTx(tx, [shipment.id], { trustedActor: actor, extraScopes: ['customs:read'] });
  if (!source || source.kind !== 'physical' || !source.lines.length || !source.cartonCoverageComplete)
    gateBlocked('本票尚无完整的真实装箱来源，不能交回出运资料。');
  // These document-source locks also serialize native QC/completion writers.
  // Recheck current observations before return/departure: a later inspection
  // can complete missing size coverage without rebuilding the handoff's frozen
  // business-source fingerprint, but an old packed carton cannot supply it.
  const qualityBranches = await tx.shipmentHandoffLine.findMany({ where: { handoffId: handoff.id },
    orderBy: [{ productionBatchId: 'asc' }] });
  const checked = new Set<string>();
  for (const branch of qualityBranches) {
    if (checked.has(branch.productionBatchId)) continue;
    const quality = await readProductionQcReleaseCoverage(tx, { orderId: branch.orderId,
      productionBatchId: branch.productionBatchId, expectedBatchRevision: branch.productionBatchRevision });
    if (!quality.satisfied) gateBlocked(`生产分支 ${branch.productionBatchId} 尚不能交回出运资料：${quality.failureReasons.join('；')}`);
    checked.add(branch.productionBatchId);
  }
  const shipmentLineIds = source.lines.map((line: any) => line.id).sort();
  const currentShipmentLineSet = new Set(shipmentLineIds);
  const orderIds = source.orderIds;
  if (!orderIds.length) gateBlocked('本票没有可核验的销售合同/信用证来源，不能完成出运单据交接。');

  const ciRows = await tx.tradeDocument.findMany({ where: { shipmentId: shipment.id, domain: 'customs', type: 'CommercialInvoice',
    sourceInvoiceId: null, status: 'Issued', deletedAt: null }, orderBy: [{ id: 'asc' }] });
  const ciDocs = ciRows.filter((row: any) => isBusinessShipmentCi(row));
  if (!ciDocs.length) gateBlocked('本票缺少已签发的业务 Commercial Invoice。');
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "TradeDocument" WHERE "id" IN (${Prisma.join(ciDocs.map((row: any) => row.id))}) ORDER BY "id" FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DocumentVersion" WHERE "documentId" IN (${Prisma.join(ciDocs.map((row: any) => row.id))}) ORDER BY "documentId", "version" FOR UPDATE`);
  const credits = await tx.letterOfCredit.findMany({ where: { orderId: { in: orderIds } }, orderBy: { id: 'asc' } });
  const coveredByCi = new Set<string>();
  for (const row of ciDocs) {
    const ci = await readBusinessShipmentCiVersionInTx(tx, row.id, actor, { requiredScopes: ['customs:read'] });
    if (ci.document.shipmentId !== shipment.id || ci.document.status !== 'Issued' || ci.snapshot.shipmentId !== shipment.id
      || !ci.snapshot.issuedAt || !Number.isSafeInteger(ci.version.version) || ci.version.version !== ci.latestVersion.version)
      gateBlocked('存在商业 CI 不是本票当前已签发版本，请先完成正确版本签发。');
    const lineIds = ci.snapshot.lines.map((line: any) => line.shipmentLineId);
    if (!lineIds.length || new Set(lineIds).size !== lineIds.length || lineIds.some((lineId: string) => !currentShipmentLineSet.has(lineId)))
      gateBlocked('商业 CI 行与本票当前装运行不一致。');
    const currentCi = buildBusinessShipmentCiSnapshot(source, { lineIds }, credits);
    if (currentCi.sourceFingerprint !== ci.snapshot.sourceFingerprint)
      gateBlocked('商业 CI 来源已过期，请按当前订单、分配与装箱资料重新签发。');
    for (const lineId of lineIds) {
      if (coveredByCi.has(lineId)) gateBlocked('本票有装运行被多张商业 CI 重复覆盖。');
      coveredByCi.add(lineId);
    }
  }
  if (coveredByCi.size !== currentShipmentLineSet.size || shipmentLineIds.some(lineId => !coveredByCi.has(lineId)))
    gateBlocked('已签发商业 CI 未完整覆盖本票全部应开票装运行。');

  const plDocs = await tx.tradeDocument.findMany({ where: { shipmentId: shipment.id, domain: 'customs', type: 'PackingList',
    status: 'Issued', deletedAt: null }, orderBy: [{ id: 'asc' }] });
  if (!plDocs.length) gateBlocked('本票缺少已签发 Packing List。');
  const coveredByPl = new Set<string>();
  for (const plDoc of plDocs) {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "TradeDocument" WHERE "id" = ${plDoc.id} FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DocumentVersion" WHERE "documentId" = ${plDoc.id} ORDER BY "version" FOR UPDATE`);
    const pl = await readPackingListVersionInTx(tx, { documentId: plDoc.id, trustedActor: actor });
    const snapshot = (pl.envelope as any)?.packingListSource;
    const plLineIds = Array.isArray(snapshot?.lines) ? snapshot.lines.map((line: any) => line.shipmentLineId).sort() : [];
    if (pl.document.shipmentId !== shipment.id || pl.document.status !== 'Issued' || pl.protocol !== 2 || pl.provenance !== 'native'
      || pl.warnings.length || snapshot?.source?.shipmentId !== shipment.id || snapshot?.source?.kind !== 'physical'
      || snapshot?.source?.cartonCoverageComplete !== true || snapshot?.source?.fingerprint !== source.fingerprint
      || !plLineIds.length || new Set(plLineIds).size !== plLineIds.length
      || plLineIds.some((lineId: string) => !currentShipmentLineSet.has(lineId)))
      gateBlocked('存在 Packing List 不是当前本票完整装箱来源的正式 native v2 已签发版本。');
    for (const lineId of plLineIds) {
      if (coveredByPl.has(lineId)) gateBlocked('本票有装运行被多份 Packing List 重复覆盖。');
      coveredByPl.add(lineId);
    }
  }
  if (coveredByPl.size !== currentShipmentLineSet.size || shipmentLineIds.some(lineId => !coveredByPl.has(lineId)))
    gateBlocked('已签发 Packing List 集合未完整且无重复地覆盖本票全部装运行。');
  return shipment;
}

/** Re-evaluate exact source gates at logistics return and actual-departure
 * boundaries. The handoff line stores the source's required-family snapshot
 * and a proof fingerprint; any changed requirement, proof head, batch revision
 * or production-QC issue state makes that eligibility snapshot stale. */
async function assertCurrentHandoffEligibility(tx: any, handoffId: string) {
  const handoff = await tx.shipmentHandoff.findUnique({ where: { id: handoffId } });
  if (!handoff) gateBlocked('出运交接已不存在。');
  const lines = await tx.shipmentHandoffLine.findMany({ where: { handoffId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  if (!lines.length) gateBlocked('本次交接缺少原始工厂分支快照。');
  const grouped = new Map<string, any[]>();
  for (const line of lines) {
    const key = JSON.stringify([line.orderId, line.orderLineId]);
    const group = grouped.get(key) ?? []; group.push(line); grouped.set(key, group);
  }
  for (const group of grouped.values()) {
    const first = group[0];
    const [order, orderLine] = await Promise.all([
      tx.order.findUnique({ where: { id: first.orderId } }),
      tx.orderLine.findUnique({ where: { id: first.orderLineId } }),
    ]);
    if (!order || order.deletedAt != null || !orderLine || orderLine.orderId !== first.orderId)
      gateBlocked('订单行或生产工厂分支已变化，原出运资格快照已失效。');
    const completion = await readOrderLineProductionCompletion(tx, order, orderLine);
    const sources: ResolvedSource[] = [];
    for (const line of group) {
      const batch = await tx.productionBatch.findUnique({ where: { id: line.productionBatchId } });
      if (!batch || batch.orderId !== line.orderId || batch.orderLineId !== line.orderLineId || batch.state !== 'active'
        || batch.revision !== line.productionBatchRevision || batch.factoryRelationId !== line.factoryRelationId)
        gateBlocked('订单行或生产工厂分支已变化，原出运资格快照已失效。');
      const currentFamilies = readRequiredSampleFamilies(orderLine.requiredSampleFamilies, order);
      if (!currentFamilies || JSON.stringify(currentFamilies) !== JSON.stringify(line.requiredSampleFamilies))
        gateBlocked('订单行必需样品族配置与本次交接冻结依据不一致，请重新核对订单条款。');
      const currentScope = await resolveQcCoverage(tx, line.orderId, { scopeType: 'production_batch', productionBatchId: batch.id });
      if (currentScope.scopeFingerprint !== line.scopeFingerprint)
        gateBlocked('订单行或工厂批次范围已变化，原出运资格快照已失效。');
      sources.push({ input: { orderId: line.orderId, orderLineId: line.orderLineId,
        productionBatchId: line.productionBatchId, productionBatchRevision: line.productionBatchRevision,
        factoryRelationId: line.factoryRelationId, plannedQty: String(line.plannedQty), unit: line.unit },
        order, orderLine, batch, factoryName: line.factoryName, scopeFingerprint: currentScope.scopeFingerprint,
        productionCompletion: completion, businessBlockers: completionBlockers(orderLine, completion) });
    }
    if (orderLine.partialShipmentAllowed === true) {
      for (const source of sources) {
        const blocker = await completedBranchQuantityBlocker(tx, source, handoff.shipmentId);
        if (blocker) source.businessBlockers = [...(source.businessBlockers ?? []), blocker];
      }
    }
    if (orderLine.partialShipmentAllowed === false && completion.status === 'complete') {
      const finalBranches = completion.branches ?? [];
      const requestsByBatch = new Map(sources.map(source => [source.batch.id, source.input.plannedQty]));
      const exactCoverage = finalBranches.length === requestsByBatch.size && finalBranches.every((branch: any) =>
        branch.completionCurrent && requestsByBatch.has(branch.productionBatchId)
          && new Prisma.Decimal(requestsByBatch.get(branch.productionBatchId)!).eq(branch.actualQty));
      if (!exactCoverage) for (const source of sources) source.businessBlockers = [...(source.businessBlockers ?? []),
        { code: 'NO_SPLIT_SHIPMENT_MUST_COVER_FINAL_PRODUCTION', message: '禁止分批出运时，本次出运必须覆盖全部有效工厂分支并与各分支最终完工数量一致。' }];
      const priorAllocations = await tx.shipmentOrderAllocation.findMany({ where: { orderId: first.orderId, orderLineId: first.orderLineId,
        status: { not: 'Cancelled' } }, select: { shipmentId: true } });
      const priorIds = [...new Set<string>(priorAllocations.map((row: any) => row.shipmentId).filter((id: string) => id !== handoff.shipmentId))];
      const priorShipments = priorIds.length ? await tx.shipment.findMany({ where: { id: { in: priorIds }, deletedAt: null,
        status: { not: 'Cancelled' } }, select: { id: true } }) : [];
      if (priorShipments.length) for (const source of sources) source.businessBlockers = [...(source.businessBlockers ?? []),
        { code: 'SPLIT_SHIPMENT_ALREADY_STARTED', message: '该订单行已存在另一票有效出运，合同/信用证禁止再次出运。' }];
    }
    for (let index = 0; index < group.length; index++) {
      const line = group[index], source = sources[index];
      const currentGate = await gateBlockersForSource(tx, source);
      if (currentGate.blockers.length) {
        const blocked = businessError('GATE_BLOCKED', '当前生产工厂分支的订单数量、样品或生产 QC 门禁已变化/未解除，不能完成出运交接。');
        (blocked as any).details = { orderId: line.orderId, orderLineId: line.orderLineId, productionBatchId: line.productionBatchId,
          productionBatchRevision: line.productionBatchRevision, blockers: currentGate.blockers };
        throw blocked;
      }
      if (!line.eligibilityFingerprint || currentGate.eligibilityFingerprint !== line.eligibilityFingerprint)
        gateBlocked('生产完工量、允差、样品评审或生产 QC 问题事实已变化，本次交接的资格版本已失效；请重新核对并重建出运交接。');
    }
  }
}

type RevisionInput = { allocationId: string; expectedAllocationUpdatedAt: string; requestKey: string; plannedQty: string;
  productionBatchAllocations: Array<{ productionBatchId: string; productionBatchRevision: number; factoryRelationId: string;
    stockReceiptId: string | null; factoryLoadingReceiptId?: string; plannedQty: string | null }> };

function parseRevisionInputs(value: unknown): RevisionInput[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw businessError('INVALID_INPUT', '修改计划须提交一至一百条准确的原出运行。');
  return value.map((raw: any) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).some(key => !['allocationId', 'expectedAllocationUpdatedAt', 'requestKey', 'plannedQty', 'productionBatchAllocations'].includes(key)))
      throw businessError('INVALID_INPUT', '出运计划修订行包含无效字段。');
    const allocationId = text(raw.allocationId, '原出运分配', 160), expectedAllocationUpdatedAt = text(raw.expectedAllocationUpdatedAt, '原出运分配版本', 40);
    if (!/^(?:0|[1-9]\d*)$/.test(expectedAllocationUpdatedAt)) throw businessError('INVALID_INPUT', '请提交原出运分配的精确更新时间。');
    const requestKey = text(raw.requestKey, '分配修订请求键', 160);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(requestKey)) throw businessError('INVALID_INPUT', '出运分配修订请求键须为 UUID。');
    const plannedQty = decimal(raw.plannedQty, '修订后计划出运数量');
    if (!Array.isArray(raw.productionBatchAllocations) || !raw.productionBatchAllocations.length || raw.productionBatchAllocations.length > 100)
      throw businessError('INVALID_INPUT', '请完整提交该订单行原有的工厂批次/实物来源明细。');
    const productionBatchAllocations = raw.productionBatchAllocations.map((item: any) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)
        || Object.keys(item).some(key => !['productionBatchId', 'productionBatchRevision', 'factoryRelationId', 'stockReceiptId', 'factoryLoadingReceiptId', 'plannedQty'].includes(key)))
        throw businessError('INVALID_INPUT', '工厂批次修订明细包含无效字段。');
      const qty = item.plannedQty === null ? null : actualQuantity(item.plannedQty);
      if (!Number.isSafeInteger(item.productionBatchRevision) || item.productionBatchRevision < 1) throw businessError('INVALID_INPUT', '工厂生产批次修订无效。');
      return { productionBatchId: text(item.productionBatchId, '生产批次', 160), productionBatchRevision: item.productionBatchRevision,
        factoryRelationId: text(item.factoryRelationId, '生产工厂', 160),
        stockReceiptId: item.stockReceiptId === null ? null : text(item.stockReceiptId, '实物收货凭据', 160),
        ...(item.factoryLoadingReceiptId !== undefined ? { factoryLoadingReceiptId: text(item.factoryLoadingReceiptId, '工厂实装凭据', 160) } : {}), plannedQty: qty };
    });
    if (new Set(productionBatchAllocations.map((item: RevisionInput['productionBatchAllocations'][number]) => JSON.stringify([item.productionBatchId, item.stockReceiptId, item.factoryLoadingReceiptId ?? null]))).size !== productionBatchAllocations.length)
      throw businessError('INVALID_INPUT', '同一批次实物来源修订不能重复。');
    return { allocationId, expectedAllocationUpdatedAt, requestKey, plannedQty, productionBatchAllocations };
  });
}

async function applyAllocationRevisions(params: { tx: any; prisma: PrismaClient; actor: TokenPayload; handoffId: string;
  revisions: RevisionInput[]; ip?: string | null }) {
  const { tx, prisma, actor } = params;
  const handoffLines = await tx.shipmentHandoffLine.findMany({ where: { handoffId: params.handoffId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const ownedAllocationIds = new Set<string>(handoffLines.map((line: any) => line.allocationId));
  if (new Set(params.revisions.map(row => row.allocationId)).size !== params.revisions.length
    || params.revisions.some(row => !ownedAllocationIds.has(row.allocationId)))
    throw businessError('INVALID_INPUT', '只能修订本次交接原有的订单行分配，且每条分配只能提交一次。');
  const issuedExternalDocs = await tx.tradeDocument.findMany({ where: { shipmentId: (await tx.shipmentHandoff.findUnique({ where: { id: params.handoffId } })).shipmentId,
    domain: 'customs', type: { in: ['CommercialInvoice', 'PackingList'] }, status: 'Issued', deletedAt: null }, select: { id: true } });
  if (issuedExternalDocs.length) throw businessError('INVALID_STATE', '本票已有正式签发 CI/PL；请先按原单据修订/作废流程处理，再修订出运计划。');

  const auditChanges: any[] = [];
  for (const revision of params.revisions) {
    const allocation = await tx.shipmentOrderAllocation.findUnique({ where: { id: revision.allocationId } });
    if (!allocation || !ownedAllocationIds.has(allocation.id)) throw businessError('NOT_FOUND', '原订单行出运分配不存在或不属于本次交接。');
    if (String(allocation.updatedAt) !== revision.expectedAllocationUpdatedAt) throw businessError('CONFLICT', '原出运分配已变化，请刷新后重新核对修订。');
    const branchSnapshots = handoffLines.filter((line: any) => line.allocationId === allocation.id);
    const physicalRows = await tx.shipmentProductionAllocation.findMany({ where: { allocationId: allocation.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    if (!physicalRows.length || physicalRows.some((row: any) => row.state !== 'reserved'))
      throw businessError('CONFLICT', '本行工厂批次预留状态已变化，不能按原交接直接修订。');
    const snapshotBatches = [...new Set<string>(branchSnapshots.map((row: any) => row.productionBatchId))].sort();
    const physicalBatches = physicalRows.map((row: any) => row.productionBatchId).sort();
    if (JSON.stringify(snapshotBatches) !== JSON.stringify(physicalBatches))
      throw businessError('CONFLICT', '本行工厂批次范围与原交接快照不一致。');
    const batches = await tx.productionBatch.findMany({ where: { id: { in: physicalBatches } }, orderBy: [{ id: 'asc' }] });
    if (batches.length !== physicalBatches.length) throw businessError('CONFLICT', '原工厂生产批次缺失，不能修订出运计划。');
    const batchById = new Map<string, any>(batches.map((row: any) => [row.id, row]));
    const priorReceiptRows: Array<{ physical: any; receipt: any }> = physicalRows.flatMap((physical: any) => {
      const receipts = physical.scopeSnapshot?.receiptAllocations;
      if (!Array.isArray(receipts) || !receipts.length) throw businessError('CONFLICT', '原实物来源明细缺失，不能安全修订数量。');
      return receipts.map((receipt: any) => ({ physical, receipt }));
    });
    const expectedIdentity = priorReceiptRows.map(({ physical, receipt }) => JSON.stringify([physical.productionBatchId, receipt.stockReceiptId, receipt.factoryLoadingReceiptId ?? null])).sort();
    const suppliedIdentity = revision.productionBatchAllocations.map(row => JSON.stringify([row.productionBatchId, row.stockReceiptId, row.factoryLoadingReceiptId ?? null])).sort();
    if (JSON.stringify(expectedIdentity) !== JSON.stringify(suppliedIdentity))
      throw businessError('CONFLICT', '工厂批次或实物收货明细与原出运预留不一致；不能增删来源或替换工厂。');
    const currentScopeByBatch = new Map<string, string>();
    for (const row of revision.productionBatchAllocations) {
      const batch = batchById.get(row.productionBatchId);
      const snapshot = branchSnapshots.find((line: any) => line.productionBatchId === row.productionBatchId);
      if (!batch || !snapshot || batch.orderId !== allocation.orderId || batch.orderLineId !== allocation.orderLineId
        || batch.revision !== row.productionBatchRevision || batch.revision !== snapshot.productionBatchRevision
        || batch.factoryRelationId !== row.factoryRelationId || batch.unit !== allocation.unit)
        throw businessError('CONFLICT', '修订中的工厂批次、修订号或单位与原交接分支不一致。');
      if (!currentScopeByBatch.has(batch.id)) {
        const currentScope = await resolveQcCoverage(tx, allocation.orderId, { scopeType: 'production_batch', productionBatchId: batch.id });
        currentScopeByBatch.set(batch.id, currentScope.scopeFingerprint);
      }
    }
    const physicalCommands = revision.productionBatchAllocations.map(row => {
      const match = priorReceiptRows.find(({ physical, receipt }) => physical.productionBatchId === row.productionBatchId
        && receipt.stockReceiptId === row.stockReceiptId && (receipt.factoryLoadingReceiptId ?? null) === (row.factoryLoadingReceiptId ?? null))!;
      return { productionBatchId: row.productionBatchId, expectedRevision: row.productionBatchRevision,
        expectedScopeFingerprint: currentScopeByBatch.get(row.productionBatchId)!, stockReceiptId: row.stockReceiptId,
        ...(row.factoryLoadingReceiptId ? { factoryLoadingReceiptId: row.factoryLoadingReceiptId } : {}),
        plannedQty: row.plannedQty, actualQty: match.receipt.actualQty == null ? null : new Prisma.Decimal(String(match.receipt.actualQty)).toString(),
        unit: allocation.unit };
    });
    const plannedTotal = physicalCommands.reduce((sum: Prisma.Decimal, row: any) => row.plannedQty === null ? sum : sum.plus(row.plannedQty), new Prisma.Decimal(0));
    if (physicalCommands.some((row: any) => row.plannedQty === null) || !plannedTotal.equals(revision.plannedQty))
      throw businessError('INVALID_INPUT', '工厂批次修订计划量之和须精确等于该订单行修订计划量。');
    const actualTotal = physicalCommands.some((row: any) => row.actualQty === null) ? null
      : physicalCommands.reduce((sum: Prisma.Decimal, row: any) => sum.plus(row.actualQty), new Prisma.Decimal(0)).toString();
    const currentActual = allocation.actualQty == null ? null : new Prisma.Decimal(String(allocation.actualQty)).toString();
    if (actualTotal !== currentActual) throw businessError('CONFLICT', '修订不能改写物流已核实的实际装箱数量。');
    const previousPlannedQty = new Prisma.Decimal(String(allocation.plannedQty)).toString();
    const result = await writePhysicalShipmentAllocation({ prisma, tx, shipmentId: allocation.shipmentId, allocationId: allocation.id, actor,
      ip: params.ip, handoffAuthorization: { handoffId: params.handoffId, operation: 'revise' },
      input: { requestKey: revision.requestKey, expectedAllocationUpdatedAt: revision.expectedAllocationUpdatedAt,
        orderId: allocation.orderId, orderLineId: allocation.orderLineId, plannedQty: revision.plannedQty,
        actualQty: currentActual, unit: allocation.unit, status: allocation.status,
        batchOrCartonNote: allocation.batchOrCartonNote ?? null, exception: allocation.exception ?? null,
        productionBatchAllocations: physicalCommands } });
    if (!result.ok) throw businessError(result.error.code, result.error.message);
    auditChanges.push({ allocationId: allocation.id, orderId: allocation.orderId, orderLineId: allocation.orderLineId,
      previousPlannedQty, revisedPlannedQty: revision.plannedQty, unchangedActualQty: currentActual,
      productionBatchAllocations: physicalCommands.map((row: any) => ({ productionBatchId: row.productionBatchId,
        productionBatchRevision: row.expectedRevision, factoryRelationId: batchById.get(row.productionBatchId).factoryRelationId,
        stockReceiptId: row.stockReceiptId, ...(row.factoryLoadingReceiptId ? { factoryLoadingReceiptId: row.factoryLoadingReceiptId } : {}), previousPlannedQty: priorReceiptRows.find(({ physical, receipt }) => physical.productionBatchId === row.productionBatchId
          && receipt.stockReceiptId === row.stockReceiptId && (receipt.factoryLoadingReceiptId ?? null) === (row.factoryLoadingReceiptId ?? null))!.receipt.plannedQty == null ? null : String(priorReceiptRows.find(({ physical, receipt }) => physical.productionBatchId === row.productionBatchId
          && receipt.stockReceiptId === row.stockReceiptId && (receipt.factoryLoadingReceiptId ?? null) === (row.factoryLoadingReceiptId ?? null))!.receipt.plannedQty), revisedPlannedQty: row.plannedQty, unchangedActualQty: row.actualQty })) });
  }
  return auditChanges;
}

function requestUuid(value: unknown, label: string): string {
  const result = text(value, label, 160);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(result))
    throw businessError('INVALID_INPUT', `${label}须为 UUID。`);
  return result;
}

type ActualLoadingBranch = { physicalAllocationId: string; expectedPhysicalUpdatedAt: string; productionBatchId: string;
  productionBatchRevision: number; factoryRelationId: string; unit: string;
  factoryLoading?: FactoryLoadingFact;
  receiptActuals: Array<{ stockReceiptId: string | null; actualQty: string }> };
export type ShipmentHandoffActualLoadingInput = { expectedUpdatedAt: string; requestKey: string; reason: string | null;
  allocations: Array<{ allocationId: string; expectedAllocationUpdatedAt: string; orderId: string; orderLineId: string;
    unit: string; productionBatchAllocations: ActualLoadingBranch[] }> };

function exactTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) throw businessError('INVALID_INPUT', `${label}须为精确时间字符串。`);
  return value;
}
function actualQuantity(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(value))
    throw businessError('INVALID_INPUT', '请完整核实每项实际数量；未录不是零，数量须为非负十进制字符串。');
  return new Prisma.Decimal(value).toString();
}
function actualObject(value: unknown, keys: string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)))
    throw businessError('INVALID_INPUT', '实装核量命令含无效或不可提交字段。');
  return value as Record<string, any>;
}
function actualArray(value: unknown, label: string): any[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw businessError('INVALID_INPUT', `${label}须有一至一百项准确来源。`);
  return value;
}
export function parseShipmentHandoffActualLoadingInput(value: unknown): ShipmentHandoffActualLoadingInput {
  const body = actualObject(value, ['expectedUpdatedAt', 'requestKey', 'reason', 'allocations']);
  const allocations = actualArray(body.allocations, '订单行实装').map(raw => {
    const row = actualObject(raw, ['allocationId', 'expectedAllocationUpdatedAt', 'orderId', 'orderLineId', 'unit', 'productionBatchAllocations']);
    const productionBatchAllocations = actualArray(row.productionBatchAllocations, '工厂分支实装').map(rawBranch => {
      const branch = actualObject(rawBranch, ['physicalAllocationId', 'expectedPhysicalUpdatedAt', 'productionBatchId', 'productionBatchRevision', 'factoryRelationId', 'unit', 'receiptActuals', 'factoryLoading']);
      if (!Number.isSafeInteger(branch.productionBatchRevision) || branch.productionBatchRevision < 1) throw businessError('INVALID_INPUT', '工厂批次修订号无效。');
      let factoryLoading: FactoryLoadingFact | undefined;
      if (branch.factoryLoading !== undefined) {
        const loading = actualObject(branch.factoryLoading, ['actualQty', 'loadingDate', 'reference']);
        if (!isValidLocalDateKey(loading.loadingDate)) throw businessError('INVALID_INPUT', '请填写真实有效的工厂装运日期。');
        factoryLoading = { actualQty: actualQuantity(loading.actualQty), loadingDate: loading.loadingDate, reference: text(loading.reference, '工厂实装核验依据', 2000) };
      }
      const nativeRows = branch.receiptActuals;
      if (!Array.isArray(nativeRows) || nativeRows.length > 100 || !nativeRows.length && !factoryLoading)
        throw businessError('INVALID_INPUT', '请逐来源核实仓库收货或工厂直出实际数量。');
      const receiptActuals = nativeRows.map(rawReceipt => {
        const receipt = actualObject(rawReceipt, ['stockReceiptId', 'actualQty']);
        const stockReceiptId = receipt.stockReceiptId === null ? null : text(receipt.stockReceiptId, '原生收货凭据', 160);
        const actualQty = actualQuantity(receipt.actualQty);
        if (!stockReceiptId && !new Prisma.Decimal(actualQty).isZero()) throw businessError('INVALID_INPUT', '正数实装须选择该工厂批次的真实收货凭据。');
        return { stockReceiptId, actualQty };
      }).sort((a, b) => (a.stockReceiptId ?? '').localeCompare(b.stockReceiptId ?? ''));
      if (new Set(receiptActuals.map(receipt => receipt.stockReceiptId)).size !== receiptActuals.length) throw businessError('INVALID_INPUT', '同一实物来源不能重复核量。');
      return { physicalAllocationId: text(branch.physicalAllocationId, '原工厂分配', 160),
        expectedPhysicalUpdatedAt: exactTimestamp(branch.expectedPhysicalUpdatedAt, '原工厂分配版本'), productionBatchId: text(branch.productionBatchId, '生产批次', 160),
        productionBatchRevision: branch.productionBatchRevision, factoryRelationId: text(branch.factoryRelationId, '生产工厂', 160),
        unit: text(branch.unit, '单位', 24), receiptActuals, ...(factoryLoading ? { factoryLoading } : {}) };
    }).sort((a, b) => a.physicalAllocationId.localeCompare(b.physicalAllocationId));
    if (new Set(productionBatchAllocations.map(branch => branch.physicalAllocationId)).size !== productionBatchAllocations.length) throw businessError('INVALID_INPUT', '同一工厂分支不能重复核量。');
    return { allocationId: text(row.allocationId, '原订单行分配', 160), expectedAllocationUpdatedAt: exactTimestamp(row.expectedAllocationUpdatedAt, '原订单行分配版本'),
      orderId: text(row.orderId, '原订单', 160), orderLineId: text(row.orderLineId, '原订单行', 160), unit: text(row.unit, '单位', 24), productionBatchAllocations };
  }).sort((a, b) => a.allocationId.localeCompare(b.allocationId));
  if (new Set(allocations.map(row => row.allocationId)).size !== allocations.length) throw businessError('INVALID_INPUT', '同一订单行不能重复核量。');
  return { expectedUpdatedAt: exactTimestamp(body.expectedUpdatedAt, '原交接版本'), requestKey: requestUuid(body.requestKey, '实装核量请求键'),
    reason: optionalText(body.reason, '实装差异说明'), allocations };
}

/** Only exact native receipt identities are offered. Private cost, command and
 * audit snapshots stay on the server; every selected receipt is verified again
 * under the physical allocator's stock locks when recording actual loading. */
export async function readShipmentHandoffActualLoading(params: { prisma: PrismaClient; handoffId: string; actor: TokenPayload | null }) {
  return params.prisma.$transaction(async (tx: any) => {
    const actor = await requireLogisticsActor(tx, params.actor, false);
    await assertHandoffReadable(tx, params.handoffId, actor);
    const bundle = await readBundle(tx, params.handoffId, actor), sources: any[] = [];
    for (const line of bundle.lines) {
      const allocation = bundle.allocations.find((row: any) => row.id === line.allocationId);
      const physical = allocation?.productionBatchAllocations.find((row: any) => row.productionBatchId === line.productionBatchId);
      if (!allocation || !physical) throw businessError('CONFLICT', '原交接缺少准确工厂实物分配，请核对来源。');
      const batch = await tx.productionBatch.findUnique({ where: { id: line.productionBatchId } });
      if (!batch || batch.revision !== line.productionBatchRevision || batch.factoryRelationId !== line.factoryRelationId
        || batch.orderId !== line.orderId || batch.orderLineId !== line.orderLineId || batch.unit !== line.unit)
        throw businessError('CONFLICT', '工厂批次身份、修订或单位已变化，请重新核对交接。');
      const scope = await resolveQcCoverage(tx, line.orderId, { scopeType: 'production_batch', productionBatchId: batch.id });
      if (scope.scopeFingerprint !== line.scopeFingerprint || physical.scopeFingerprint !== scope.scopeFingerprint)
        throw businessError('CONFLICT', '工厂批次当前范围已变化，请重新核对交接。');
      const receipts = await tx.productionStockReceipt.findMany({ where: { productionBatchId: batch.id,
        productionBatchRevision: batch.revision, orderId: line.orderId, orderLineId: line.orderLineId, unit: line.unit,
        scopeFingerprint: scope.scopeFingerprint }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      const candidates: any[] = [], unavailableReceiptIds: string[] = [];
      for (const receipt of receipts) {
        try {
          const verified = await verifyOriginalProductionReceipt(tx, receipt.id, batch, scope.scopeFingerprint);
          candidates.push({ stockReceiptId: receipt.id, reference: receipt.receiptReference || receipt.id,
            warehouseId: verified.identity.warehouseId, receivedQty: String(verified.receipt.quantity), availableQty: verified.available.toString(), unit: line.unit });
        } catch (error) { if (isBusinessError(error) && error.code === 'CONFLICT') unavailableReceiptIds.push(receipt.id); else throw error; }
      }
      const factoryLoadings: any[] = [];
      for (const receipt of physical.stockReceiptAllocations.filter((row: any) => row.factoryLoadingReceiptId)) {
        const verified = await verifyFactoryLoadingReceiptInTx(tx, receipt.factoryLoadingReceiptId, batch, scope.scopeFingerprint,
          { shipmentId: bundle.shipment.id, allocationId: allocation.id, handoffId: bundle.handoff.id });
        factoryLoadings.push({ factoryLoadingReceiptId: verified.receipt.id, actualQty: String(verified.receipt.quantity),
          loadingDate: verified.receipt.loadingDate, reference: verified.receipt.reference, unit: verified.receipt.unit });
      }
      sources.push({ allocationId: allocation.id, orderId: line.orderId, orderLineId: line.orderLineId,
        physicalAllocationId: physical.id, productionBatchId: batch.id, productionBatchRevision: batch.revision,
        factoryRelationId: line.factoryRelationId, unit: line.unit, candidates, unavailableReceiptIds, factoryLoadings });
    }
    await requireLogisticsActor(tx, params.actor, false);
    return shipmentHandoffJson({ bundle, sources });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

/** Record verified facts, not a second plan. This one transaction covers every
 * original source, the existing allocator audit and the return-to-business
 * event. A retry reads the original command receipt before any mutable CAS. */
export async function recordShipmentHandoffActualLoading(params: { prisma: PrismaClient; handoffId: string; actor: TokenPayload | null; input: unknown; ip?: string | null }) {
  const input = parseShipmentHandoffActualLoadingInput(params.input);
  return params.prisma.$transaction(async (tx: any) => {
    let actor = await requireLogisticsActor(tx, params.actor);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ShipmentHandoff" WHERE "id"=${params.handoffId} FOR UPDATE`);
    const handoff = await assertHandoffReadable(tx, params.handoffId, actor);
    const commandHash = hash({ schemaVersion: 1, action: 'record-actual-loading', handoffId: handoff.id, actorId: actor.userId, input });
    const prior = await tx.shipmentHandoffEvent.findFirst({ where: { handoffId: handoff.id, requestKey: input.requestKey } });
    if (prior) {
      if (prior.actorId !== actor.userId || prior.commandHash !== commandHash || prior.payload?.action !== 'record-actual-loading'
        || hash(prior.payload.command) !== hash(input)) throw businessError('REQUEST_CONFLICT', '原请求键已绑定不同的实装核量内容。');
      return { ...await readBundle(tx, handoff.id, actor), actualLoadingReceipt: { requestKey: input.requestKey, commandHash,
        command: prior.payload.command, replayed: true, requiresBusinessDecision: prior.toStatus === SHIPMENT_HANDOFF_STATUS.NEEDS_BUSINESS_DECISION } };
    }
    if (handoff.status !== SHIPMENT_HANDOFF_STATUS.PROCESSING) throw businessError('INVALID_STATE', '只有已接手、后勤处理中的交接可以核实实际装运量。');
    if (String(handoff.updatedAt) !== input.expectedUpdatedAt) throw businessError('CONFLICT', '交接已更新，请刷新后核对实装；不要覆盖原处理。');
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ShipmentHandoffLine" WHERE "handoffId"=${handoff.id} ORDER BY "id" FOR UPDATE`);
    await lockShipmentPhysicalConsumer(tx, { shipmentId: handoff.shipmentId, actor, mode: 'packing' });
    await assertLiveHandoffAllocationSnapshot(tx, handoff.id, handoff.shipmentId);
    const before = await readBundle(tx, handoff.id, actor), shipment = before.shipment;
    if (!['Draft', 'Booked', 'Loading'].includes(shipment.status) || shipment.atd != null || handoff.completedAt != null)
      throw businessError('INVALID_STATE', '本票已完成、已实际出运或已取消，不能覆盖已核实事实。');
    const docs = await tx.tradeDocument.findMany({ where: { shipmentId: shipment.id, deletedAt: null, status: { not: 'Cancelled' },
      OR: [{ status: 'Issued' }, { filePath: { not: null } }] }, select: { id: true, status: true, filePath: true } });
    if (docs.some((doc: any) => doc.status === 'Issued' || doc.filePath) || await tx.shipmentLine.count({ where: { shipmentId: shipment.id } }))
      throw businessError('INVALID_STATE', '本票已有装箱或正式/归档单据事实；请先处理原装箱与单据，不能直接覆盖实装。');
    const ownedIds = before.allocations.map((row: any) => row.id).sort();
    if (JSON.stringify(ownedIds) !== JSON.stringify(input.allocations.map(row => row.allocationId))) throw businessError('CONFLICT', '请完整核实本次交接原有的全部订单行，不能增删来源。');
    let differs = false;
    const prepared: Array<{ allocation: any; rows: any[]; actualQty: string }> = [];
    for (const submitted of input.allocations) {
      const allocation = before.allocations.find((row: any) => row.id === submitted.allocationId)!;
      if (allocation.orderId !== submitted.orderId || allocation.orderLineId !== submitted.orderLineId || allocation.unit !== submitted.unit
        || allocation.expectedUpdatedAt !== submitted.expectedAllocationUpdatedAt) throw businessError('CONFLICT', '原订单行分配身份、单位或版本已变化。');
      const physical = allocation.productionBatchAllocations;
      if (JSON.stringify(physical.map((row: any) => row.id).sort()) !== JSON.stringify(submitted.productionBatchAllocations.map(row => row.physicalAllocationId).sort()))
        throw businessError('CONFLICT', '须完整核实原工厂分支，不能增删或替换分支。');
      const rows: any[] = [];
      const order = await tx.order.findUnique({ where: { id: submitted.orderId } }), orderLine = await tx.orderLine.findUnique({ where: { id: submitted.orderLineId } });
      const completion = await readOrderLineProductionCompletion(tx, order, orderLine);
      for (const branch of submitted.productionBatchAllocations) {
        const current = physical.find((row: any) => row.id === branch.physicalAllocationId), line = before.lines.find((row: any) => row.allocationId === allocation.id && row.productionBatchId === branch.productionBatchId);
        if (!current || !line || current.state !== 'reserved' || current.productionBatchId !== branch.productionBatchId
          || current.productionBatchRevision !== branch.productionBatchRevision || line.productionBatchRevision !== branch.productionBatchRevision
          || line.factoryRelationId !== branch.factoryRelationId || current.expectedUpdatedAt !== branch.expectedPhysicalUpdatedAt
          || current.unit !== branch.unit || branch.unit !== allocation.unit) throw businessError('CONFLICT', '工厂分支、修订、单位或原分配版本已变化。');
        const batch = await tx.productionBatch.findUnique({ where: { id: branch.productionBatchId } });
        const coverage = await resolveQcCoverage(tx, allocation.orderId, { scopeType: 'production_batch', productionBatchId: branch.productionBatchId });
        if (!batch || batch.state !== 'active' || batch.revision !== branch.productionBatchRevision || batch.factoryRelationId !== branch.factoryRelationId
          || batch.orderId !== allocation.orderId || batch.orderLineId !== allocation.orderLineId || batch.unit !== branch.unit
          || coverage.scopeFingerprint !== line.scopeFingerprint || coverage.scopeFingerprint !== current.scopeFingerprint) throw businessError('CONFLICT', '原工厂生产范围已变化，请重新核对交接。');
        const actualQty = branch.receiptActuals.reduce((sum, row) => sum.plus(row.actualQty), new Prisma.Decimal(branch.factoryLoading?.actualQty ?? '0')).toString();
        const quantityBlocker = await completedBranchQuantityBlocker(tx, { input: { orderId: allocation.orderId, orderLineId: allocation.orderLineId,
          productionBatchId: batch.id, productionBatchRevision: batch.revision, factoryRelationId: batch.factoryRelationId,
          plannedQty: actualQty, unit: branch.unit }, order, orderLine, batch, factoryName: line.factoryName,
          scopeFingerprint: coverage.scopeFingerprint, productionCompletion: completion }, shipment.id);
        if (quantityBlocker) throw businessError('CONFLICT', quantityBlocker.message);
        if (new Prisma.Decimal(actualQty).gt(batch.quantity)) throw businessError('CONFLICT', '实装超过原工厂批次受控物理数量。');
        if (!new Prisma.Decimal(actualQty).eq(current.plannedQty)) differs = true;
        const oldReceipts = current.stockReceiptAllocations;
        const bound = oldReceipts.filter((row: any) => row.stockReceiptId !== null);
        const oldDirect = oldReceipts.filter((row: any) => row.factoryLoadingReceiptId);
        if (oldDirect.length && !branch.factoryLoading) throw businessError('CONFLICT', '已核实的工厂直出来源须明确续办，不能静默删除或转换为仓库来源。');
        if (bound.some((row: any) => !branch.receiptActuals.some(item => item.stockReceiptId === row.stockReceiptId)))
          throw businessError('CONFLICT', '已绑定的原生实物来源须保留，不能在核量时静默替换或删除。');
        // Bind an unassigned plan to real receipts without changing the branch
        // plan. Unused plan stays as a zero-actual unbound reservation; no
        // warehouse or receipt is fabricated for a planned remainder.
        let unboundPlan = oldReceipts.filter((row: any) => row.stockReceiptId === null).reduce((sum: Prisma.Decimal, row: any) => sum.plus(String(row.plannedQty)), new Prisma.Decimal(0));
        const common = { productionBatchId: batch.id, expectedRevision: batch.revision, expectedScopeFingerprint: coverage.scopeFingerprint, unit: branch.unit };
        for (const receipt of branch.receiptActuals.filter(row => row.stockReceiptId !== null)) {
          const original = bound.find((row: any) => row.stockReceiptId === receipt.stockReceiptId);
          const planned = original ? new Prisma.Decimal(String(original.plannedQty)) : Prisma.Decimal.min(unboundPlan, receipt.actualQty);
          if (!original) unboundPlan = unboundPlan.minus(planned);
          rows.push({ ...common, stockReceiptId: receipt.stockReceiptId, plannedQty: planned.toString(), actualQty: receipt.actualQty });
        }
        if (branch.factoryLoading) {
          const receipt = await createFactoryLoadingReceiptInTx(tx, { handoffId: handoff.id, allocationId: allocation.id, batchId: batch.id,
            actor, requestKey: input.requestKey, expectedHandoffUpdatedAt: input.expectedUpdatedAt, fact: branch.factoryLoading,
            previousFactoryLoadingReceiptIds: oldDirect.map((row: any) => row.factoryLoadingReceiptId), ip: params.ip });
          const planned = Prisma.Decimal.min(unboundPlan, branch.factoryLoading.actualQty);
          unboundPlan = unboundPlan.minus(planned);
          rows.push({ ...common, stockReceiptId: null, factoryLoadingReceiptId: receipt.id, plannedQty: planned.toString(), actualQty: branch.factoryLoading.actualQty });
        }
        if (unboundPlan.gt(0) || !branch.factoryLoading && !branch.receiptActuals.some(row => row.stockReceiptId !== null))
          rows.push({ ...common, stockReceiptId: null, plannedQty: unboundPlan.toString(), actualQty: '0' });
      }
      prepared.push({ allocation, rows, actualQty: rows.reduce((sum, row) => sum.plus(row.actualQty), new Prisma.Decimal(0)).toString() });
    }
    if (differs && !input.reason) throw businessError('INVALID_INPUT', '实装与业务计划有差异，请填写核实说明后退回原业务员确认。');
    for (const entry of prepared) {
      const result = await writePhysicalShipmentAllocation({ prisma: params.prisma, tx, shipmentId: shipment.id, allocationId: entry.allocation.id,
        actor, ip: params.ip, handoffAuthorization: { handoffId: handoff.id, operation: 'record-actual' }, input: {
          requestKey: `handoff-actual:${input.requestKey}:${entry.allocation.id}`, expectedAllocationUpdatedAt: entry.allocation.expectedUpdatedAt,
          orderId: entry.allocation.orderId, orderLineId: entry.allocation.orderLineId, plannedQty: String(entry.allocation.plannedQty),
          actualQty: entry.actualQty, unit: entry.allocation.unit, status: entry.allocation.status,
          batchOrCartonNote: entry.allocation.batchOrCartonNote ?? null, exception: entry.allocation.exception ?? null, productionBatchAllocations: entry.rows } });
      if (!result.ok) throw businessError(result.error.code, result.error.message);
    }
    // The allocator has now acquired source/Shipment/stock locks. A packing
    // or document writer that committed while we waited must not be covered
    // by an earlier empty read. Throwing also rolls back every allocation.
    const lockedShipment = await tx.shipment.findUnique({ where: { id: shipment.id } });
    const lockedDocs = await tx.tradeDocument.findMany({ where: { shipmentId: shipment.id, deletedAt: null, status: { not: 'Cancelled' },
      OR: [{ status: 'Issued' }, { filePath: { not: null } }] }, select: { id: true, status: true, filePath: true } });
    if (!lockedShipment || lockedShipment.atd != null || !['Draft', 'Booked', 'Loading'].includes(lockedShipment.status)
      || lockedDocs.some((doc: any) => doc.status === 'Issued' || doc.filePath) || await tx.shipmentLine.count({ where: { shipmentId: shipment.id } }))
      throw businessError('INVALID_STATE', '等待来源锁时，本票已有装箱、归档或实际出运事实；本次核量未确认，请重新读取。');
    actor = await requireLogisticsActor(tx, params.actor);
    await visibleOrderMap(tx, [...new Set(input.allocations.map(row => row.orderId))].sort(), actor);
    const clock = BigInt(Date.now()), now = clock > handoff.updatedAt ? clock : handoff.updatedAt + BigInt(1);
    const target = differs ? SHIPMENT_HANDOFF_STATUS.NEEDS_BUSINESS_DECISION : SHIPMENT_HANDOFF_STATUS.PROCESSING;
    const saved = await tx.shipmentHandoff.updateMany({ where: { id: handoff.id, status: SHIPMENT_HANDOFF_STATUS.PROCESSING, updatedAt: BigInt(input.expectedUpdatedAt) },
      data: { updatedAt: now, ...(differs ? { status: target, discrepancyReason: input.reason, returnedToBusinessAt: now } : {}) } });
    if (saved.count !== 1) throw businessError('CONFLICT', '交接已被其他操作更新，本次核量未确认；请保留原请求核对。');
    await tx.shipmentHandoffEvent.create({ data: { id: `SHHE_ACTUAL_${hash([handoff.id, actor.userId, input.requestKey])}`, handoffId: handoff.id,
      requestKey: input.requestKey, commandHash, actorId: actor.userId, fromStatus: handoff.status, toStatus: target,
      note: input.reason ?? '后勤已逐工厂分支核实本次实际装运量，与本次计划一致。', decision: null, createdAt: now,
      payload: shipmentHandoffJson({ schemaVersion: 1, action: 'record-actual-loading', command: input,
        previousAllocations: before.allocations, recordedAllocations: prepared.map(entry => ({ allocationId: entry.allocation.id,
          orderId: entry.allocation.orderId, orderLineId: entry.allocation.orderLineId, unchangedPlannedQty: String(entry.allocation.plannedQty),
          actualQty: entry.actualQty, unit: entry.allocation.unit, productionBatchAllocations: entry.rows })) }) } });
    return { ...await readBundle(tx, handoff.id, actor), actualLoadingReceipt: { requestKey: input.requestKey, commandHash, command: input,
      replayed: false, requiresBusinessDecision: differs } };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20_000 });
}

/** The business can accept the packed amount only after logistics has recorded
 * an exact amount at both the existing SOA and physical factory-branch levels. */
async function assertActualAllocationsRecorded(tx: any, handoffId: string) {
  const lines = await tx.shipmentHandoffLine.findMany({ where: { handoffId }, orderBy: [{ allocationId: 'asc' }, { productionBatchId: 'asc' }] });
  const allocationIds = [...new Set<string>(lines.map((row: any) => row.allocationId))];
  const allocations = await tx.shipmentOrderAllocation.findMany({ where: { id: { in: allocationIds } }, orderBy: [{ id: 'asc' }] });
  const allocationById = new Map<string, any>(allocations.map((row: any) => [row.id, row]));
  const physical = await tx.shipmentProductionAllocation.findMany({ where: { allocationId: { in: allocationIds } }, orderBy: [{ allocationId: 'asc' }, { productionBatchId: 'asc' }] });
  const physicalByKey = new Map<string, any>(physical.map((row: any) => [`${row.allocationId}\u0000${row.productionBatchId}`, row]));
  const branches: any[] = [];
  for (const line of lines) {
    const allocation = allocationById.get(line.allocationId), branch = physicalByKey.get(`${line.allocationId}\u0000${line.productionBatchId}`);
    if (!allocation || !branch || branch.state !== 'reserved' || branch.productionBatchRevision !== line.productionBatchRevision)
      gateBlocked('本次交接的工厂实际出运分配缺失或来源修订已变化，请物流核对原分配。');
    if (branch.actualQty == null) gateBlocked('物流尚未登记每个生产工厂分支的实际装箱/出运数量，业务不能确认差异。');
    const receipts = branch.scopeSnapshot?.receiptAllocations;
    if (!Array.isArray(receipts) || !receipts.length || receipts.some((row: any) => row.actualQty == null))
      gateBlocked('物流尚未登记该工厂分支的准确实物来源实际数量。');
    const receiptActual = receipts.reduce((sum: Prisma.Decimal, row: any) => sum.plus(String(row.actualQty)), new Prisma.Decimal(0));
    if (!receiptActual.equals(String(branch.actualQty))) gateBlocked('工厂分支实物来源实际数量与批次汇总数量不一致，请物流修正。');
    branches.push({ allocationId: allocation.id, orderId: line.orderId, orderLineId: line.orderLineId,
      productionBatchId: line.productionBatchId, productionBatchRevision: line.productionBatchRevision,
      factoryRelationId: line.factoryRelationId, actualQty: new Prisma.Decimal(String(branch.actualQty)).toString(), unit: line.unit });
  }
  for (const allocationId of allocationIds) {
    const allocation = allocationById.get(allocationId), children = lines.filter((line: any) => line.allocationId === allocationId)
      .map((line: any) => physicalByKey.get(`${allocationId}\u0000${line.productionBatchId}`));
    if (allocation.actualQty == null || children.some((row: any) => !row || row.actualQty == null))
      gateBlocked('物流尚未登记本订单行的汇总实际装箱/出运数量。');
    const summed = children.reduce((sum: Prisma.Decimal, row: any) => sum.plus(String(row.actualQty)), new Prisma.Decimal(0));
    if (!summed.equals(String(allocation.actualQty))) gateBlocked('本订单行汇总实际数量与各工厂分支实际数量不一致，请物流修正。');
  }
  return branches;
}

function parseTransitionBody(action: HandoffAction, value: unknown): Record<string, any> & { expectedUpdatedAt: string } {
  const body = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
  const allowedByAction: Record<HandoffAction, string[]> = {
    start: ['expectedUpdatedAt', 'note'],
    'return-to-business': ['expectedUpdatedAt', 'reason'],
    'return-to-logistics': ['expectedUpdatedAt', 'decision', 'response', 'allocationRevisions', 'requestKey'],
    complete: ['expectedUpdatedAt', 'note'],
    cancel: ['expectedUpdatedAt', 'requestKey', 'response'],
  };
  if (Object.keys(body).some(key => !allowedByAction[action].includes(key))) throw businessError('INVALID_INPUT', '交接操作含不可提交字段。');
  if (typeof body.expectedUpdatedAt !== 'string' || !/^(?:0|[1-9]\d*)$/.test(body.expectedUpdatedAt))
    throw businessError('INVALID_INPUT', '请提交当前交接更新时间，以防覆盖他人刚完成的处理。');
  if (action === 'return-to-logistics' && !['accept_actual', 'revise_plan', 'cancel'].includes(body.decision))
    throw businessError('INVALID_INPUT', '请选择接受已核实实装、修订本次计划或取消本次出运。');
  if (action === 'return-to-logistics' && body.decision !== 'revise_plan' && body.allocationRevisions !== undefined)
    throw businessError('INVALID_INPUT', '只有修订计划时可以提交分配修订明细。');
  if (action === 'return-to-logistics' && body.decision === 'revise_plan' && body.allocationRevisions === undefined)
    throw businessError('INVALID_INPUT', '修订本次计划时必须提交准确的工厂分支修订明细。');
  if (action === 'cancel') requestUuid(body.requestKey, '取消请求键');
  if (action === 'return-to-logistics' && body.decision === 'cancel') requestUuid(body.requestKey, '取消请求键');
  if (action === 'return-to-logistics' && body.decision !== 'cancel' && body.requestKey !== undefined)
    throw businessError('INVALID_INPUT', '只有取消本次出运时可以提交取消请求键。');
  return { ...body, expectedUpdatedAt: body.expectedUpdatedAt as string };
}

export async function transitionShipmentHandoff(params: { prisma: PrismaClient; handoffId: string; actor: TokenPayload | null;
  action: HandoffAction; input: unknown; ip?: string | null }) {
  const body = parseTransitionBody(params.action, params.input);
  const note = params.action === 'return-to-business' ? text(body.reason, '差异原因', 2000)
    : params.action === 'return-to-logistics' || params.action === 'cancel' ? text(body.response, '业务说明', 2000)
      : optionalText(body.note, '处理备注');
  return params.prisma.$transaction(async (tx: any) => {
    const logisticsAction = params.action === 'start' || params.action === 'return-to-business' || params.action === 'complete';
    const actor = logisticsAction ? await requireLogisticsActor(tx, params.actor)
      : await currentActor(tx, params.actor, 'orders:write');
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ShipmentHandoff" WHERE "id" = ${params.handoffId} FOR UPDATE`);
    const handoff = await assertHandoffReadable(tx, params.handoffId, actor);
    if ((params.action === 'return-to-logistics' || params.action === 'cancel') && handoff.businessActorId !== actor.userId)
      throw businessError('FORBIDDEN', '只有原业务发起人可以处理本次交接的差异或取消待办。');
    const fromStatus = handoff.status as ShipmentHandoffStatus;
    const expectedFrom: Record<HandoffAction, ShipmentHandoffStatus> = {
      start: SHIPMENT_HANDOFF_STATUS.PENDING_LOGISTICS,
      'return-to-business': SHIPMENT_HANDOFF_STATUS.PROCESSING,
      'return-to-logistics': SHIPMENT_HANDOFF_STATUS.NEEDS_BUSINESS_DECISION,
      complete: SHIPMENT_HANDOFF_STATUS.PROCESSING,
      cancel: SHIPMENT_HANDOFF_STATUS.PENDING_LOGISTICS,
    };
    const businessCancelDecision = params.action === 'return-to-logistics' && body.decision === 'cancel';
    const isCancellation = params.action === 'cancel' || businessCancelDecision;
    const cancellationRequestKey = isCancellation ? requestUuid(body.requestKey, '取消请求键') : null;
    const cancellationCommandHash = isCancellation ? hash({ handoffId: handoff.id, action: params.action,
      decision: businessCancelDecision ? 'cancel' : null, response: note, expectedUpdatedAt: body.expectedUpdatedAt }) : null;
    if (isCancellation) {
      const prior = await tx.shipmentHandoffEvent.findFirst({ where: { handoffId: handoff.id, requestKey: cancellationRequestKey } });
      if (prior) {
        if (prior.commandHash !== cancellationCommandHash || prior.toStatus !== SHIPMENT_HANDOFF_STATUS.CANCELLED)
          throw businessError('CONFLICT', '该取消请求键已绑定不同命令，不能重复执行。');
        return readBundle(tx, handoff.id, actor);
      }
    }
    if (businessCancelDecision && fromStatus !== SHIPMENT_HANDOFF_STATUS.NEEDS_BUSINESS_DECISION)
      throw businessError('INVALID_STATE', '只有已退回业务待处理的交接可以由业务决定取消。');
    if (fromStatus !== expectedFrom[params.action] && !businessCancelDecision)
      throw businessError('INVALID_STATE', '出运交接已变化，当前步骤不能执行；请刷新查看最新状态。');
    if (String(handoff.updatedAt) !== body.expectedUpdatedAt) throw businessError('CONFLICT', '出运交接已被其他操作更新，请刷新后核对再提交。');
    const shipment = await tx.shipment.findUnique({ where: { id: handoff.shipmentId } });
    if (!shipment || shipment.deletedAt != null) throw businessError('NOT_FOUND', '关联出运记录不存在或不可查看。');
    if (shipment.status === 'Shipped' || shipment.atd != null) throw businessError('INVALID_STATE', '本票已有实际出运事实，不能再变更交接流程。');

    const decision = params.action === 'return-to-logistics' ? body.decision as 'accept_actual' | 'revise_plan' | 'cancel' | undefined : undefined;
    let decisionPayload: Record<string, any> = {};
    if (decision === 'accept_actual') {
      decisionPayload = { branches: await assertActualAllocationsRecorded(tx, handoff.id) };
    } else if (decision === 'revise_plan') {
      const revisions = parseRevisionInputs(body.allocationRevisions);
      decisionPayload = { allocationRevisions: await applyAllocationRevisions({ tx, prisma: params.prisma, actor, handoffId: handoff.id, revisions, ip: params.ip }) };
    } else if (decision === 'cancel' || params.action === 'cancel') {
      const cancellation = await cancelHandoffShipment({ tx, prisma: params.prisma, shipment, handoff, actor, ip: params.ip });
      decisionPayload = { ...(body.requestKey ? { requestKey: body.requestKey } : {}), shipmentId: cancellation.shipment.id,
        shipmentStatus: cancellation.shipment.status, releasedAllocationIds: cancellation.releasedAllocationIds };
    }
    let completion: any = null;
    if (params.action === 'complete') {
      await assertCurrentHandoffEligibility(tx, handoff.id);
      completion = await assertHandoffDocumentsReady(tx, shipment.id, actor);
    }

    const wallClock = BigInt(Date.now()), now = wallClock > handoff.updatedAt ? wallClock : handoff.updatedAt + BigInt(1);
    const targetStatus: ShipmentHandoffStatus = params.action === 'return-to-business' ? SHIPMENT_HANDOFF_STATUS.NEEDS_BUSINESS_DECISION
      : params.action === 'complete' ? SHIPMENT_HANDOFF_STATUS.RETURNED_TO_BUSINESS
        : params.action === 'cancel' || decision === 'cancel' ? SHIPMENT_HANDOFF_STATUS.CANCELLED : SHIPMENT_HANDOFF_STATUS.PROCESSING;
    const patch: Record<string, any> = { status: targetStatus, updatedAt: now };
    if (params.action === 'start' && !handoff.logisticsActorId) patch.logisticsActorId = actor.userId;
    if (params.action === 'return-to-business') { patch.discrepancyReason = note; patch.returnedToBusinessAt = now; }
    if (params.action === 'return-to-logistics') { patch.businessResponse = note; patch.businessRespondedAt = now; }
    if (params.action === 'complete') patch.completedAt = now;
    const updated = await tx.shipmentHandoff.updateMany({ where: { id: handoff.id, status: fromStatus, updatedAt: BigInt(body.expectedUpdatedAt) }, data: patch });
    if (updated.count !== 1) throw businessError('CONFLICT', '出运交接已被其他操作更新，请刷新后核对。');
    await tx.shipmentHandoffEvent.create({ data: { id: id('SHHE'), handoffId: handoff.id,
      ...(isCancellation ? { requestKey: cancellationRequestKey, commandHash: cancellationCommandHash } : {}),
      fromStatus, toStatus: targetStatus, actorId: actor.userId, note,
      decision: decision ?? (params.action === 'cancel' ? 'cancel' : null),
      payload: shipmentHandoffJson({ schemaVersion: 1, action: params.action, ...decisionPayload,
        ...(isCancellation ? { requestKey: cancellationRequestKey, commandHash: cancellationCommandHash } : {}),
        ...(completion ? { returnedDocuments: { shipmentId: completion.id, shipmentStatus: completion.status, atd: completion.atd ?? null } } : {}) }),
      createdAt: now } });
    // `/complete` records only the logistics handoff back to business. Actual
    // vessel departure and Shipment.status=Shipped remain separate operations.
    return readBundle(tx, handoff.id, actor);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20_000 });
}

/** Logistics-side actual departure confirmation. ETD/Draft BL are not departure
 * facts; this command writes ATD + Shipment.status only after the current native
 * CI/PL versions have existing business-send receipts. */
export async function confirmShipmentHandoffDeparture(params: { prisma: PrismaClient; handoffId: string; actor: TokenPayload | null;
  input: unknown; ip?: string | null }) {
  const body: any = params.input;
  const fields = ['expectedUpdatedAt', 'requestKey', 'atd', 'expectedShipmentUpdatedAt', 'expectedPhysicalAllocationFingerprint'];
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !fields.includes(key)))
    throw businessError('INVALID_INPUT', '实际出运确认命令字段无效。');
  if (typeof body.expectedUpdatedAt !== 'string' || !/^(?:0|[1-9]\d*)$/.test(body.expectedUpdatedAt)
    || typeof body.expectedShipmentUpdatedAt !== 'string' || !/^(?:0|[1-9]\d*)$/.test(body.expectedShipmentUpdatedAt))
    throw businessError('INVALID_INPUT', '请提交当前交接和运单的精确版本号。');
  const requestKey = requestUuid(body.requestKey, '实际出运确认请求键');
  if (typeof body.expectedPhysicalAllocationFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedPhysicalAllocationFingerprint))
    throw businessError('INVALID_INPUT', '请读取当前准确物理分配范围后再确认出运。');
  if (typeof body.atd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.atd) || !Number.isFinite(Date.parse(`${body.atd}T00:00:00.000Z`)))
    throw businessError('INVALID_INPUT', '实际离港时间须为真实发生的 ISO 日期 ATD。');
  return params.prisma.$transaction(async (tx: any) => {
    const actor = await requireLogisticsActor(tx, params.actor);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ShipmentHandoff" WHERE "id" = ${params.handoffId} FOR UPDATE`);
    const handoff = await assertHandoffReadable(tx, params.handoffId, actor);
    const commandHash = hash({ handoffId: handoff.id, action: 'confirm-departure', requestKey, atd: body.atd,
      expectedUpdatedAt: body.expectedUpdatedAt, expectedShipmentUpdatedAt: body.expectedShipmentUpdatedAt,
      expectedPhysicalAllocationFingerprint: body.expectedPhysicalAllocationFingerprint });
    const prior = await tx.shipmentHandoffEvent.findFirst({ where: { handoffId: handoff.id, requestKey } });
    if (prior) {
      if (prior.commandHash !== commandHash || prior.payload?.action !== 'confirm-departure')
        throw businessError('CONFLICT', '该请求键已绑定不同的出运确认命令。');
      return readBundle(tx, handoff.id, actor);
    }
    if (handoff.status !== SHIPMENT_HANDOFF_STATUS.RETURNED_TO_BUSINESS)
      throw businessError('INVALID_STATE', '后勤单证尚未完成并交回业务，不能确认实际出运。');
    if (String(handoff.updatedAt) !== body.expectedUpdatedAt) throw businessError('CONFLICT', '出运交接已变化，请刷新并核对后再确认。');
    const shipment = await tx.shipment.findUnique({ where: { id: handoff.shipmentId } });
    if (!shipment || shipment.status !== 'Booked' || shipment.atd != null)
      throw businessError('INVALID_STATE', '运单须保持已订舱且尚未有实际 ATD。');
    await assertCurrentHandoffEligibility(tx, handoff.id);
    await assertHandoffDocumentsReady(tx, shipment.id, actor);
    await assertCurrentShipmentDocumentsSentInTx(tx, shipment.id);
    const result = await updateShipment({ prisma: params.prisma, tx, shipmentId: shipment.id, actor, actorId: actor.userId, ip: params.ip,
      patch: { status: 'Shipped', atd: body.atd }, hasStatus: true,
      handoffDepartureConfirmationId: handoff.id,
      physicalCommand: { requestKey, expectedShipmentUpdatedAt: body.expectedShipmentUpdatedAt,
        expectedPhysicalAllocationFingerprint: body.expectedPhysicalAllocationFingerprint },
      auditSource: 'route:shipping:handoff-departure', syncSource: 'route:shipping:handoff-departure' });
    if (!result.ok) throw businessError(result.error?.code ?? 'SHIPMENT_UPDATE_FAILED', result.error?.message ?? '实际出运事实未能保存。');
    const nowWall = BigInt(Date.now()), now = nowWall > handoff.updatedAt ? nowWall : handoff.updatedAt + BigInt(1);
    const updated = await tx.shipmentHandoff.updateMany({ where: { id: handoff.id, status: handoff.status, updatedAt: BigInt(body.expectedUpdatedAt) },
      data: { updatedAt: now } });
    if (updated.count !== 1) throw businessError('CONFLICT', '出运交接已被其他操作更新，请刷新后核对。');
    await tx.shipmentHandoffEvent.create({ data: { id: id('SHHE'), handoffId: handoff.id, requestKey, commandHash,
      fromStatus: handoff.status, toStatus: handoff.status, actorId: actor.userId, decision: 'actual_departure',
      note: '后勤核验当前 CI/PL 已由业务发送，登记真实 ATD。', payload: shipmentHandoffJson({ schemaVersion: 1, action: 'confirm-departure',
        shipmentId: shipment.id, shipmentStatus: result.data!.shipment.status, atd: result.data!.shipment.atd, requestKey, commandHash }), createdAt: now } });
    return readBundle(tx, handoff.id, actor);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20_000 });
}
