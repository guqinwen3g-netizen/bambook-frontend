import { Prisma } from '@prisma/client';
import { resolveGarmentMaterialProof } from '../orders/internalFabricGate';
import { DevelopmentDomainError } from '../development/developmentOperationalGuard';
import { productionBatchLineFingerprint, productionBatchSourceFingerprint, resolveCurrentProductionBatchFacts } from '../production/productionBatchFacts';
import { sampleOriginFingerprint, type SampleOriginSnapshot } from './sampleOriginService';
import { assertManualOrderLineSource } from '../orders/manualOrderLineSource';
import { canonicalOrderSampleDecimal, canonicalOrderSampleJson, canonicalOrderSampleUnit, orderSampleDigest,
  type OrderSampleFamily, type OrderSampleOwner, type OrderSampleJson, type OrderSampleCoverageRequest,
  type OrderSampleLineSnapshot, type OrderSampleBatchSnapshot } from './orderSampleSourceContract';

type ParentRow = { id: string; [field: string]: any };
type ByIdRead = { findUnique(args: { where: { id: string } }): PromiseLike<ParentRow | null> };
type LiveRead = { findFirst(args: { where: { id: string; deletedAt: null } }): PromiseLike<ParentRow | null> };
type ListRead<Where> = { findMany(args: { where: Where; take?: number }): PromiseLike<ParentRow[]> };
/** Structural capability matching the actual read queries. Some older local
 * generated clients lack these existing delegates; never invent a revision or
 * generate a new schema to conceal that. Caller supplies its trusted client.
 * No transaction, lock, grant, write or approval capability is accepted. */
export type OrderSampleParentDb = {
  factoryProductionLine?: { findUnique(args: { where: { id: string } }): PromiseLike<unknown> };
  order: ByIdRead & LiveRead; orderLine: ByIdRead; productionBatch: ByIdRead; relation: ByIdRead & LiveRead;
  developmentCase: ByIdRead & ListRead<{ productAssetId: string }>;
  sample: ByIdRead; sampleSource: ListRead<{ sampleId: string }>;
  sampleBatch: ByIdRead & ListRead<{ convertedProductAssetId: string }>;
  sealSample: ByIdRead & ListRead<{ convertedProductAssetId: string }>;
  sealSampleBatch: ListRead<{ sealSampleId: string }>;
  productAsset: { findUnique(args: { where: { id: string }; include: { fabricProfile: true; garmentProfile: true } }): PromiseLike<ParentRow | null> };
  auditLog: ByIdRead & ListRead<{ targetType: 'ProductAsset'; targetId: string; action: { in: string[] } }>;
  fabricLineAllocation?: any; team?: any; teamMember?: any; userAccount?: any; approvalRequest?: any;
};
export type OrderSampleParentRequest = {
  family: OrderSampleFamily; orderId: string; factoryRelationId: string; coverage: OrderSampleCoverageRequest[];
};
export type OrderSampleParentLockRefs = {
  developmentCaseIds: string[]; relationIds: string[]; sealSampleIds: string[]; sealSampleBatchIds: string[];
  sampleBatchIds: string[]; orderIds: string[]; orderLineIds: string[]; productionBatchIds: string[];
  productAssetIds: string[]; fabricProfileIds: string[]; garmentProfileIds: string[];
  sampleIds: string[]; sampleSourceIds: string[]; auditLogIds: string[];
};
export type OrderSampleParentResolution = {
  owner: OrderSampleOwner; specSnapshot: OrderSampleJson; coverage: OrderSampleCoverageRequest[];
  lines: OrderSampleLineSnapshot[]; batches: OrderSampleBatchSnapshot[];
  parentIdentity: { orderId: string; businessLine: OrderSampleOwner['businessLine']; factoryRelationId: string;
    lineIds: string[]; productionBatchIds: string[] };
  parentFingerprint: string; lockRefs: OrderSampleParentLockRefs;
};
export class OrderSampleParentError extends Error {
  constructor(public readonly code: 'ORDER_SAMPLE_PARENT_INVALID'|'ORDER_SAMPLE_PARENT_CONFLICT'|'ORDER_SAMPLE_PARENT_UNRESOLVED', message: string) {
    super(message); this.name = 'OrderSampleParentError';
  }
}
function invalid(message: string): never { throw new OrderSampleParentError('ORDER_SAMPLE_PARENT_INVALID', message); }
function conflict(message: string): never { throw new OrderSampleParentError('ORDER_SAMPLE_PARENT_CONFLICT', message); }
function unresolved(message: string): never { throw new OrderSampleParentError('ORDER_SAMPLE_PARENT_UNRESOLVED', message); }
const familyOwner: Record<OrderSampleFamily, OrderSampleOwner['businessLine']> = {
  fabric_ss: 'fabric', fabric_rc: 'fabric', fabric_eps: 'fabric', garment_pp: 'garment', garment_top: 'garment', garment_ship: 'garment',
};
const sorted = (values: string[]) => [...new Set(values)].sort();
const GRAPH_BUDGET = 128;
function finiteRows<T>(rows: T[]): T[] {
  if (rows.length > GRAPH_BUDGET) unresolved('来源祖先超出有限读取预算，不能截断父图。');
  return rows;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256 || value.trim() !== value || /[\u0000-\u001f]/.test(value)) invalid('须明确选择真实父记录 ID。');
  return value;
}
function object(value: unknown, keys: string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid('来源请求须为明确对象。');
  if (Object.keys(value).some(key => !keys.includes(key))) invalid('来源请求含未定义字段。');
  return value as Record<string, any>;
}
/** The same persisted type/snapshot contract is used by source producers and
 * consumers. A nullable snapshot does not erase a real title-cased V1 type. */
export function orderSampleOrderLane(order: { [key: string]: unknown }): OrderSampleOwner['businessLine'] {
  const typed = typeof order.type === 'string' ? order.type.trim().toLowerCase() : '';
  const declared = typeof order.businessLine === 'string' ? order.businessLine.trim().toLowerCase() : '';
  if (!['fabric','garment'].includes(typed) || declared && !['fabric','garment'].includes(declared)) unresolved('订单真实业务线未能核对。');
  if (declared && declared !== typed) conflict('订单类型与业务线矛盾。');
  return typed as OrderSampleOwner['businessLine'];
}
function plain(value: any): any {
  if (value == null) return null;
  if (typeof value === 'bigint' || Prisma.Decimal.isDecimal(value)) return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === 'object') return Object.fromEntries(Object.keys(value).map(key => [key, plain(value[key])]));
  return value;
}
function fact(row: any, fields: string[]) { return Object.fromEntries(fields.map(key => [key, plain(row[key])])); }
const fields: Record<string, string[]> = {
  order: ['id','type','businessLine','customerRelationId','millRelationId','sourceCaseId','updatedAt','deletedAt'],
  orderLine: ['id','orderId','confirmedSourceType','confirmedSourceId','specSnapshot','quantity','unit'],
  productionBatch: ['id','orderId','orderLineId','factoryRelationId','revision','state','rangeStart','quantity','unit','confirmedSourceType','confirmedSourceId','specSnapshot','sourceFingerprint','productionLineId','productionLineSnapshot'],
  relation: ['id','deletedAt'],
  developmentCase: ['id','type','customerRelationId','supplierRelationId','productAssetId','updatedAt','deletedAt'],
  sample: ['id','sourceCaseId','sourceOrderId','productAssetId','forkedFromSampleId','supplierRelationId','customerRelationId','round','projectionKey','updatedAt','deletedAt'],
  sampleSource: ['id','sampleId','sampleBatchId','sourceRound','sourceSealId','sourceSnapshot','sourceFingerprint','sourceUpdatedAt','sourceHistoryRevision','sourceEventId','evidenceAuditId','boundAt','boundBy','provenance'],
  sampleBatch: ['id','developmentCaseId','supplierRelationId','sampleType','round','convertedProductAssetId','updatedAt','deletedAt'],
  sealSample: ['id','developmentCaseId','supplierRelationId','convertedProductAssetId','updatedAt','deletedAt'],
  sealSampleBatch: ['id','sealSampleId','sampleBatchId'],
  productAsset: ['id','mainCategory','source','updatedAt','deletedAt'],
  auditLog: ['id','action','targetType','targetId','actorId','detail'],
};
const refOf: Record<string, keyof OrderSampleParentLockRefs> = {
  order: 'orderIds', orderLine: 'orderLineIds', productionBatch: 'productionBatchIds', relation: 'relationIds',
  developmentCase: 'developmentCaseIds', sample: 'sampleIds', sampleSource: 'sampleSourceIds', sampleBatch: 'sampleBatchIds',
  sealSample: 'sealSampleIds', sealSampleBatch: 'sealSampleBatchIds', productAsset: 'productAssetIds', auditLog: 'auditLogIds',
};

/** Reads the finite explicit source graph. Historical soft deletion, workflow
 * approval and a later native round do not erase recorded ancestor identity.
 * A missing/ambiguous edge fails closed; this never invents old approval. */
class ParentGraph {
  private rows = new Map<string, any>();
  private facts = new Map<string, any>();
  private visited = new Set<string>();
  private refs: OrderSampleParentLockRefs = { developmentCaseIds: [], relationIds: [], sealSampleIds: [], sealSampleBatchIds: [],
    sampleBatchIds: [], orderIds: [], orderLineIds: [], productionBatchIds: [], productAssetIds: [], fabricProfileIds: [], garmentProfileIds: [], sampleIds: [], sampleSourceIds: [], auditLogIds: [] };
  constructor(private db: OrderSampleParentDb, private lane: OrderSampleOwner['businessLine']) {}
  record(kind: string, row: any): any {
    const rowId = id(row?.id), key = `${kind}:${rowId}`;
    // Nullable additive identity must not change old fabric parent hashes.
    const keys = kind === 'productionBatch' && row.productionLineId == null && row.productionLineSnapshot == null
      ? fields[kind].filter(field => !['productionLineId', 'productionLineSnapshot'].includes(field)) : fields[kind];
    const snapshot = fact(row, keys);
    if (!this.facts.has(key) && this.facts.size >= GRAPH_BUDGET) unresolved('来源祖先超出有限读取预算，须核对来源。');
    if (this.facts.has(key) && orderSampleDigest(this.facts.get(key)) !== orderSampleDigest(snapshot)) conflict('父记录在来源读取期间已变化。');
    this.rows.set(key, row); this.facts.set(key, snapshot); this.refs[refOf[kind]].push(rowId); return row;
  }
  async get(kind: keyof OrderSampleParentDb, rowId: string): Promise<any> {
    const key = `${kind}:${id(rowId)}`;
    if (this.rows.has(key)) return this.rows.get(key);
    const row = kind === 'productAsset'
      ? await this.db.productAsset.findUnique({ where: { id: rowId }, include: { fabricProfile: true, garmentProfile: true } })
      : await (this.db[kind] as any).findUnique({ where: { id: rowId } });
    if (!row) unresolved(`来源祖先 ${kind} 的准确身份记录缺失。`);
    return this.record(kind, row);
  }
  private enter(kind: string, rowId: string): boolean {
    const key = `${kind}:${rowId}`; if (this.visited.has(key)) return false; this.visited.add(key); return true;
  }
  async relation(rowId: string | null | undefined) { if (rowId) await this.get('relation', rowId); }
  async order(rowId: string): Promise<any> {
    const row = await this.get('order', rowId);
    if (orderSampleOrderLane(row) !== this.lane) conflict('来源订单与当前业务线不同。');
    if (this.enter('order', rowId)) {
      await this.relation(row.millRelationId); await this.relation(row.customerRelationId);
      if (row.sourceCaseId) await this.development(row.sourceCaseId);
    }
    return row;
  }
  async development(rowId: string): Promise<any> {
    const row = await this.get('developmentCase', rowId);
    if (row.type !== this.lane) conflict('原绑定开发案与业务线不同。');
    if (this.enter('developmentCase', rowId)) {
      await this.relation(row.supplierRelationId); await this.relation(row.customerRelationId);
      if (row.productAssetId) await this.descriptor(row.productAssetId);
    }
    return row;
  }
  async descriptor(rowId: string): Promise<any> {
    const row = await this.get('productAsset', rowId);
    for (const [profile, ref, factory] of [[row.fabricProfile, 'fabricProfileIds', 'millOrganizationId'], [row.garmentProfile, 'garmentProfileIds', 'factoryRelationId']] as const) {
      if (!profile) continue;
      if (profile.productAssetId !== row.id) conflict('档案规格行不属于真实父档案。');
      const profileId = id(profile.id), key = `${ref}:${profileId}`;
      if (!this.facts.has(key) && this.facts.size >= GRAPH_BUDGET) unresolved('来源祖先超出有限读取预算。');
      this.facts.set(key, fact(profile, ['id','productAssetId',factory,'updatedAt','deletedAt']));
      this.refs[ref].push(profileId); await this.relation(profile[factory]);
    }
    return row;
  }
  async nativeBatch(rowId: string): Promise<any> {
    const row = await this.get('sampleBatch', rowId);
    if (this.enter('sampleBatch', rowId)) {
      await this.development(id(row.developmentCaseId)); await this.relation(id(row.supplierRelationId));
      if (row.convertedProductAssetId) await this.asset(row.convertedProductAssetId);
    }
    return row;
  }
  async seal(rowId: string): Promise<{ row: any; componentIds: string[] }> {
    const row = await this.get('sealSample', rowId);
    const links = finiteRows(await this.db.sealSampleBatch.findMany({ where: { sealSampleId: rowId }, take: GRAPH_BUDGET + 1 }));
    if (!links.length) unresolved('原封样的完整组件身份缺失。');
    const components: string[] = [];
    for (const link of links) {
      if (link.sealSampleId !== rowId) conflict('封样组件父身份矛盾。');
      this.record('sealSampleBatch', link); components.push(id(link.sampleBatchId));
      const batch = await this.get('sampleBatch', link.sampleBatchId);
      if (batch.developmentCaseId !== row.developmentCaseId || batch.supplierRelationId !== row.supplierRelationId) conflict('封样组合跨案或跨厂。');
    }
    if (new Set(components).size !== components.length) conflict('封样组件身份重复。');
    if (this.enter('sealSample', rowId)) {
      await this.development(id(row.developmentCaseId)); await this.relation(id(row.supplierRelationId));
      for (const component of sorted(components)) await this.nativeBatch(component);
      if (row.convertedProductAssetId) await this.asset(row.convertedProductAssetId);
    }
    return { row, componentIds: sorted(components) };
  }
  private async forkChain(rowId: string) {
    const chain = new Set<string>(); let cursor: string | null = rowId;
    while (cursor) {
      if (chain.has(cursor)) unresolved('样品 fork 祖先形成循环，不能猜测原身份。');
      chain.add(cursor); const row = await this.get('sample', cursor); cursor = row.forkedFromSampleId ? id(row.forkedFromSampleId) : null;
    }
  }
  async sample(rowId: string): Promise<string | null> {
    const row = await this.get('sample', rowId); await this.forkChain(rowId);
    if (!this.enter('sample', rowId)) return row.supplierRelationId ?? null;
    const bindings = finiteRows(await this.db.sampleSource.findMany({ where: { sampleId: rowId }, take: GRAPH_BUDGET + 1 }));
    if (!bindings.length && (row.sourceCaseId || row.projectionKey)) unresolved('Case 原生样品缺少原精确绑定，不能推测批次。');
    const factories = new Set<string>(); const seals = new Map<string, string[]>();
    for (const binding of bindings) {
      const snapshot = binding.sourceSnapshot as unknown as SampleOriginSnapshot;
      if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.batch?.id !== binding.sampleBatchId || snapshot.batch.sourceRound !== binding.sourceRound
        || !Number.isSafeInteger(binding.sourceRound) || binding.sourceRound < 1 || !snapshot.batch.caseId || !snapshot.batch.factoryId
        || snapshot.content == null || snapshot.version?.updatedAt !== String(binding.sourceUpdatedAt)
        || snapshot.version.historyRevision !== binding.sourceHistoryRevision || snapshot.version.eventId !== binding.sourceEventId
        || !['native','recorded_exact','current_link_recorded','inherited'].includes(binding.provenance)
        || binding.sourceFingerprint !== sampleOriginFingerprint(snapshot)) conflict('原绑定身份或冻结版本自洽性矛盾。');
      if (binding.sampleId !== rowId || row.sourceCaseId !== snapshot.batch.caseId || row.supplierRelationId && row.supplierRelationId !== snapshot.batch.factoryId) conflict('样品与原绑定案或工厂矛盾。');
      this.record('sampleSource', binding); factories.add(snapshot.batch.factoryId);
      const batch = await this.nativeBatch(binding.sampleBatchId);
      if (batch.developmentCaseId !== snapshot.batch.caseId || batch.supplierRelationId !== snapshot.batch.factoryId || batch.sampleType !== snapshot.batch.sampleType) conflict('原批次的身份主体已变化。');
      await this.get('auditLog', id(binding.evidenceAuditId));
      if (binding.sourceSealId) {
        const group = seals.get(binding.sourceSealId) ?? []; group.push(binding.sampleBatchId); seals.set(binding.sourceSealId, group);
      }
    }
    if (factories.size > 1) conflict('样品精确来源组合跨厂。');
    for (const [sealId, batchIds] of seals) {
      const seal = await this.seal(sealId);
      if (orderSampleDigest(sorted(batchIds)) !== orderSampleDigest(seal.componentIds)) conflict('样品原封样绑定缺少完整组件。');
    }
    await this.relation(row.supplierRelationId); await this.relation(row.customerRelationId);
    if (row.sourceCaseId) await this.development(row.sourceCaseId);
    if (row.sourceOrderId) await this.order(row.sourceOrderId);
    if (row.productAssetId) await this.asset(row.productAssetId);
    if (row.forkedFromSampleId) await this.sample(row.forkedFromSampleId);
    return row.supplierRelationId ?? [...factories][0] ?? null;
  }
  async asset(rowId: string): Promise<string | null> {
    const row = await this.descriptor(rowId);
    const category = typeof row.mainCategory === 'string' ? row.mainCategory.toLowerCase() : '';
    if (category !== this.lane || row.fabricProfile && row.garmentProfile) conflict('真实确认档案与订单业务线矛盾。');
    const profile = this.lane === 'fabric' ? row.fabricProfile : row.garmentProfile;
    const factory = this.lane === 'fabric' ? profile?.millOrganizationId : profile?.factoryRelationId;
    if (!this.enter('assetOrigin', rowId)) return factory ?? null;
    const [audits, reverseBatches, reverseSeals, reverseCases] = await Promise.all([
      this.db.auditLog.findMany({ where: { targetType: 'ProductAsset', targetId: rowId, action: { in: ['convert_fabric_to_asset','convert_garment_to_asset'] } }, take: GRAPH_BUDGET + 1 }),
      this.db.sampleBatch.findMany({ where: { convertedProductAssetId: rowId }, take: GRAPH_BUDGET + 1 }),
      this.db.sealSample.findMany({ where: { convertedProductAssetId: rowId }, take: GRAPH_BUDGET + 1 }),
      this.db.developmentCase.findMany({ where: { productAssetId: rowId }, take: GRAPH_BUDGET + 1 }),
    ]);
    for (const rows of [audits, reverseBatches, reverseSeals, reverseCases]) finiteRows(rows);
    // A Case descriptor pointer is not conversion provenance (a garment Case
    // may point at a fabric reference). Preserve its row/factory lock refs.
    for (const parent of reverseCases) {
      this.record('developmentCase', parent); await this.relation(parent.supplierRelationId); await this.relation(parent.customerRelationId);
    }
    if (!audits.length) {
      if (row.source === 'development' || reverseBatches.length || reverseSeals.length) unresolved('转档父身份缺少准确原生转换审计。');
      return factory ?? null;
    }
    if (audits.length !== 1) unresolved('原生转换来源不唯一，不能选最新记录。');
    const audit = audits[0], after = (audit.detail as any)?.after;
    const expectedAction = this.lane === 'fabric' ? 'convert_fabric_to_asset' : 'convert_garment_to_asset';
    if (audit.action !== expectedAction || !audit.actorId || (audit.detail as any)?.source !== `route:dev:${this.lane}-convert-asset`
      || !after || typeof after.fromCase !== 'string' || !after.fromCase) unresolved('原生转换审计未记录完整父身份。');
    this.record('auditLog', audit); await this.development(after.fromCase);
    if (this.lane === 'fabric') {
      if (!['batch','seal'].includes(after.sourceType) || typeof after.sourceId !== 'string' || !after.sourceId) unresolved('面料转换的准确批次或封样来源缺失。');
      if (reverseBatches.some(parent => after.sourceType !== 'batch' || parent.id !== after.sourceId || parent.developmentCaseId !== after.fromCase)
        || reverseSeals.some(parent => after.sourceType !== 'seal' || parent.id !== after.sourceId || parent.developmentCaseId !== after.fromCase)) conflict('转换审计与实际逆向来源锚点矛盾。');
      const parent = after.sourceType === 'batch' ? await this.nativeBatch(after.sourceId) : (await this.seal(after.sourceId)).row;
      if (parent.developmentCaseId !== after.fromCase || factory && parent.supplierRelationId !== factory) conflict('转换父案或工厂身份矛盾。');
    } else {
      const roundId = after.sourceRoundId || (after.sourceType === 'seal' ? after.sourceId : null);
      if (typeof roundId !== 'string' || !roundId || !['seal','node'].includes(after.sourceType)
        || after.sourceType === 'node' && after.sourceId !== 'confirmation') unresolved('旧成衣转换未记录准确原轮次，不能从同案候选还原。');
      if (after.sourceType === 'seal' && after.sourceId !== roundId) conflict('转换原轮次 ID 矛盾。');
      const round = await this.nativeBatch(roundId);
      if (round.developmentCaseId !== after.fromCase || round.sampleType !== 'garment-round' || factory && round.supplierRelationId !== factory) conflict('成衣转换的真实轮次身份矛盾。');
      if (reverseBatches.some(parent => parent.id !== roundId || parent.developmentCaseId !== after.fromCase) || reverseSeals.length) conflict('成衣转换的逆向来源身份矛盾。');
      if (after.sampleId) {
        await this.sample(id(after.sampleId));
        const bindings = finiteRows(await this.db.sampleSource.findMany({ where: { sampleId: after.sampleId }, take: GRAPH_BUDGET + 1 }));
        if (!bindings.some(binding => binding.sampleBatchId === roundId)) conflict('转换实物不含准确原轮次绑定。');
      }
    }
    return factory ?? null;
  }
  async confirmed(type: unknown, rowId: unknown): Promise<string | null> {
    const sourceId = id(rowId);
    if (type === 'ManualOrderLine') {
      const source = await assertManualOrderLineSource(this.db, sourceId);
      this.record('orderLine', source.line); await this.order(source.order.id); await this.relation(source.factoryRelationId);
      this.record('auditLog', source.producerAudit); this.record('auditLog', source.approvalAudit);
      return source.factoryRelationId;
    }
    if (type === 'Asset') return this.asset(sourceId);
    if (type === 'Sample') return this.sample(sourceId);
    if (type === 'SealSample') return (await this.seal(sourceId)).row.supplierRelationId;
    unresolved('订单行未记录受支持的准确确认来源。');
  }
  result() {
    const refs = Object.fromEntries(Object.entries(this.refs).map(([key, values]) => [key, sorted(values)])) as OrderSampleParentLockRefs;
    const snapshots = [...this.facts.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => ({ key, value }));
    return { lockRefs: refs, snapshots };
  }
}

/** Only current parent facts for the frozen pure builder. Caller owns fresh
 * DB grants, shared graph locking, a second read/CAS, persistence and native
 * event proofs. Partial source coordinates do NOT prove allocation coverage. */
export async function resolveOrderSampleParents(db: OrderSampleParentDb, request: OrderSampleParentRequest): Promise<OrderSampleParentResolution> {
  const input = object(request, ['family','orderId','factoryRelationId','coverage']);
  if (typeof input.family !== 'string' || !Object.prototype.hasOwnProperty.call(familyOwner, input.family)) invalid('须选择明确的订单样品业务族。');
  const family = input.family as OrderSampleFamily, orderId = id(input.orderId), factoryId = id(input.factoryRelationId);
  if (!Array.isArray(input.coverage) || !input.coverage.length || input.coverage.length > 64) invalid('须选择有限且准确的订单行范围。');
  const order = await db.order.findFirst({ where: { id: orderId, deletedAt: null } });
  if (!order) unresolved('当前订单真实父身份不存在或不可用。');
  const lane = orderSampleOrderLane(order);
  if (lane !== familyOwner[family]) conflict('样品业务族不属于真实订单业务线。');
  const factory = await db.relation.findFirst({ where: { id: factoryId, deletedAt: null } });
  if (!factory) unresolved('当前选择工厂 Relation 已不存在或已删除。');
  const graph = new ParentGraph(db, lane); graph.record('order', order); graph.record('relation', factory); await graph.order(orderId);
  const materialProofs: unknown[] = [];
  const coverage: OrderSampleCoverageRequest[] = [], lineSnapshots = new Map<string, OrderSampleLineSnapshot>(), batchSnapshots = new Map<string, OrderSampleBatchSnapshot>();
  let specSnapshot: OrderSampleJson | undefined;
  for (const raw of input.coverage) {
    const item = object(raw, ['orderLineId','expectedLineFingerprint','productionBatchId','expectedBatchRevision','rangeStart','quantity','unit']);
    const lineId = id(item.orderLineId);
    if (typeof item.expectedLineFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(item.expectedLineFingerprint)) invalid('须携带当前完整订单行读取 token。');
    const rangeStart = canonicalOrderSampleDecimal(item.rangeStart, true), quantity = canonicalOrderSampleDecimal(item.quantity), unit = canonicalOrderSampleUnit(item.unit);
    const line = await graph.get('orderLine', lineId);
    if (line.orderId !== orderId || line.specSnapshot == null) conflict('所选行不属于真实订单或未冻结规格。');
    const lineFingerprint = productionBatchLineFingerprint(order, line);
    if (lineFingerprint !== item.expectedLineFingerprint) conflict('完整订单行事实已变化，请重新读取。');
    const lineQuantity = canonicalOrderSampleDecimal(new Prisma.Decimal(line.quantity).toFixed());
    if (canonicalOrderSampleUnit(line.unit) !== unit) conflict('所选范围与真实订单行单位不同，不能换算。');
    const spec = canonicalOrderSampleJson(line.specSnapshot);
    if (specSnapshot !== undefined && orderSampleDigest(specSnapshot) !== orderSampleDigest(spec)) conflict('所选来源跨越不同规格。');
    specSnapshot = spec;
    if (line.confirmedSourceType === 'ManualOrderLine' && line.confirmedSourceId !== line.id) conflict('人工规格不能借另一真实订单行的来源身份。');
    const sourceFactory = await graph.confirmed(line.confirmedSourceType, line.confirmedSourceId);
    // Garment production factories are identified by the exact live branch;
    // the approved design source's factory does not own every later branch.
    if (lane !== 'garment' && (order.millRelationId && order.millRelationId !== factoryId || sourceFactory && sourceFactory !== factoryId)) conflict('当前订单或准确成果工厂与选择不符。');
    if (lane === 'garment' && item.productionBatchId == null) {
      if (!sourceFactory && !order.millRelationId) unresolved('直接行来源缺少可证明的真实工厂身份。');
      if (sourceFactory !== factoryId && order.millRelationId !== factoryId)
        conflict('直接行 PP 的实际工厂缺少明确依据，请先安排准确生产分支。');
    }
    const start = new Prisma.Decimal(rangeStart), end = start.plus(quantity);
    if (end.gt(lineQuantity)) conflict('所选来源范围超出真实订单行。');
    let batchId: string | null = null, batchRevision: number | null = null;
    if (item.productionBatchId != null) {
      batchId = id(item.productionBatchId);
      if (!Number.isSafeInteger(item.expectedBatchRevision) || item.expectedBatchRevision < 1) invalid('真实生产批次须携带准确 revision。');
      batchRevision = item.expectedBatchRevision;
      // Never substitute a locally calculated active/revision/source check.
      const current = await resolveCurrentProductionBatchFacts(db, { id: batchId, revision: batchRevision });
      if (current.order.id !== orderId || current.line.id !== lineId || current.lineFingerprint !== lineFingerprint
        || current.batch.factoryRelationId !== factoryId || orderSampleDigest(fact(current.order, fields.order)) !== orderSampleDigest(fact(order, fields.order))) conflict('实际批次的订单、行、工厂或当前父读取不符。');
      graph.record('orderLine', current.line); graph.record('productionBatch', current.batch);
      const batchStart = canonicalOrderSampleDecimal(new Prisma.Decimal(current.batch.rangeStart).toFixed(), true);
      const batchQuantity = canonicalOrderSampleDecimal(new Prisma.Decimal(current.batch.quantity).toFixed());
      if (start.lt(batchStart) || end.gt(new Prisma.Decimal(batchStart).plus(batchQuantity))) conflict('所选来源范围超出真实生产批次。');
      batchSnapshots.set(batchId, { id: batchId, orderId, orderLineId: lineId, factoryRelationId: factoryId, rangeStart: batchStart,
        quantity: batchQuantity, unit: canonicalOrderSampleUnit(current.batch.unit), revision: current.batch.revision, state: current.batch.state,
        specSnapshot: canonicalOrderSampleJson(current.batch.specSnapshot), sourceFingerprint: current.batch.sourceFingerprint,
        ...(current.productionLineIdentity ? { productionLineIdentity: canonicalOrderSampleJson(current.productionLineIdentity) } : {}) });
    } else {
      if (family !== 'garment_pp' || item.expectedBatchRevision != null) invalid('该业务族须选择真实生产批次；只有订单 PP 可直接取行。');
      if (!order.millRelationId && !sourceFactory) unresolved('直接行来源缺少可证明的真实工厂身份。');
    }
    let materialProof;
    try { materialProof = await resolveGarmentMaterialProof(db, order, line); }
    catch (error) { if (error instanceof DevelopmentDomainError) conflict(error.message); throw error; }
    if (materialProof) materialProofs.push(materialProof);
    lineSnapshots.set(lineId, { id: lineId, orderId, factoryRelationId: factoryId, quantity: lineQuantity, unit,
      specSnapshot: spec, sourceFingerprint: productionBatchSourceFingerprint(order, line, factoryId), lineFingerprint,
      ...(materialProof ? { materialProof: canonicalOrderSampleJson(materialProof) } : {}) });
    coverage.push({ orderLineId: lineId, expectedLineFingerprint: lineFingerprint, productionBatchId: batchId, expectedBatchRevision: batchRevision, rangeStart, quantity, unit });
  }
  coverage.sort((a, b) => a.orderLineId < b.orderLineId ? -1 : a.orderLineId > b.orderLineId ? 1
    : new Prisma.Decimal(a.rangeStart).comparedTo(b.rangeStart)
      || ((a.productionBatchId ?? '') < (b.productionBatchId ?? '') ? -1 : (a.productionBatchId ?? '') > (b.productionBatchId ?? '') ? 1 : 0));
  for (let i = 1; i < coverage.length; i++) {
    const a = coverage[i - 1], b = coverage[i];
    if (a.orderLineId === b.orderLineId && new Prisma.Decimal(a.rangeStart).plus(a.quantity).gt(b.rangeStart)) conflict('来源代表范围重复或重叠。');
  }
  const lines = [...lineSnapshots.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const batches = [...batchSnapshots.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const owner: OrderSampleOwner = { orderId, businessLine: lane, factoryRelationId: factoryId };
  const parentIdentity = { ...owner, lineIds: lines.map(line => line.id), productionBatchIds: batches.map(batch => batch.id) };
  const discovered = graph.result();
  for (const proof of materialProofs as { allocation: { fabricOrderId: string; fabricOrderLineId: string; auditId: string } | null }[]) if (proof.allocation) {
    discovered.lockRefs.orderIds.push(proof.allocation.fabricOrderId);
    discovered.lockRefs.orderLineIds.push(proof.allocation.fabricOrderLineId);
    discovered.lockRefs.auditLogIds.push(proof.allocation.auditId);
  }
  return { owner, specSnapshot: specSnapshot!, coverage, lines, batches, parentIdentity, lockRefs: discovered.lockRefs,
    parentFingerprint: orderSampleDigest({ schemaVersion: 1, parentIdentity, snapshots: discovered.snapshots, coverage, ...(materialProofs.length ? { materialProofs } : {}) }) };
}
