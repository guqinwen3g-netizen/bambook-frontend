/** Original V2 custody → an existing, proven direct Sample. No inventory or approval writes. */
import { Prisma } from '@prisma/client';
import { authorizeSampleCustody, assertSampleCustodyGuardStable, SampleCustodyAuthorizationError } from './sampleCustodyAuthorization';
import type { TokenPayload } from '../auth/service';
import { createPermissionService, hasScope } from '../auth/permissionService';
import { createTeamShareService } from '../teams/teamShareService';
import { resolveWriteKind } from '../_shared/rolePermissionMatrix';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { exactJsonValue } from '../lib/exactJsonValue';
import { safeRouteError } from '../shared/routeError';
import { logger } from '../lib/logger';
import { DevelopmentDomainError } from '../development/developmentOperationalGuard';
import { readBatchReceiptSnapshot, batchReceiptRecordedAt } from './sampleBatchReceipt';
import { sampleOriginFingerprint, sampleProjectionKey, sealProjectionKey } from './sampleOriginService';
import { resolveSampleBusinessContext } from './sampleBusinessContext';
import { resolvePhysicalSampleBusinessContexts } from './samplePhysicalBusinessContext';
import { authorizeRegistrationCase, currentRegistrationActor, registrationDigest, registrationError, registrationId } from './sampleRegistrationContextService';

export const SAMPLE_CARD_SAMPLE_LINK_PROTOCOL = { linkVersion: 1, operation: 'link_received_card_to_sample', mode: 'v2-receipt-exact-origin',
  persistentReceipt: true, supportsBorrowed: true, createsInventory: false, autoApproval: false, matchedComponentOnly: true,
  directSourcesOnly: true, inheritedSourcesSupported: false } as const;
const OP = SAMPLE_CARD_SAMPLE_LINK_PROTOCOL.operation;
const SOURCE = 'route:samples:card-sample-link';
const LINK = 'link_sample_card_to_sample';
const RECEIPT = 'sample_card_sample_link_receipt';
const fields = ['linkVersion', 'requestKey', 'targetSampleId', 'matchedSampleSourceId', 'expectedCardUpdatedAt', 'expectedReceiptHash', 'expectedTargetIdentityHash', 'expectedBindingSetHash'];
const plain = (v: any): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const sortedIds = (v: any[]) => [...new Set(v.filter(Boolean).map(String))].sort();
const equal = (a: any, b: any) => registrationDigest(a) === registrationDigest(b);
const conflict = (message: string): never => registrationError('CONFLICT', message);
const unavailable = (): never => registrationError('NOT_FOUND', '实物或目标样品不存在或不可见。');
function key(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) registrationError('INVALID_INPUT', '请保留一个稳定的关联请求标识（8–128 个字符）。');
  return value as string;
}
function parse(raw: unknown): Record<string, any> {
  if (!plain(raw) || Object.keys(raw).some(f => !fields.includes(f)) || fields.some(f => !Object.prototype.hasOwnProperty.call(raw, f)) || raw.linkVersion !== 1)
    registrationError('INVALID_INPUT', '原卡关联须使用版本 1 完整协议，不能降级或修改库存字段。');
  key(raw.requestKey); registrationId(raw.targetSampleId, '目标样品'); registrationId(raw.matchedSampleSourceId, '准确来源');
  if (typeof raw.expectedCardUpdatedAt !== 'string' || !/^\d+$/.test(raw.expectedCardUpdatedAt)
    || ['expectedReceiptHash', 'expectedTargetIdentityHash', 'expectedBindingSetHash'].some(f => typeof raw[f] !== 'string' || !/^[a-f0-9]{64}$/.test(raw[f])))
    registrationError('INVALID_INPUT', '须保留当前原卡版本和服务器核对的完整来源指纹。');
  return exactJsonValue(raw);
}
function receiptId(actorId: string, requestKey: string) { return `sample-card-link:${registrationDigest({ linkVersion: 1, operation: OP, actorId, requestKey })}`; }
function command(actorId: string, cardId: string, input: any) { return { linkVersion: 1, operation: OP, actorId, requestKey: input.requestKey, cardId, input }; }
async function actorNow(tx: any, actor: TokenPayload, write = false) {
  const fresh = await currentRegistrationActor(tx, actor, 'read');
  if (write && !hasScope({ ...fresh, roles: [] }, 'sample:room:write')) registrationError('FORBIDDEN', '当前账号没有实物台账关联权限；已有请求结果可通过只读恢复核对。');
  return fresh;
}
async function authorize(tx: any, actor: TokenPayload, sample: any, caseId: string, historical = false) {
  const result = await authorizeRegistrationCase(tx, actor, caseId, 'read', historical);
  if (sample.customerRelationId && sample.customerRelationId !== result.development.customerRelationId) {
    const customer = await tx.relation.findFirst({ where: { id: sample.customerRelationId, deletedAt: null } });
    if (!customer || await createTeamShareService(tx).resolveRelationAccess(result.actor, customer.id, { fresh: true }) === 'none') unavailable();
  }
  return result.actor;
}
async function custodyWrite(tx: any, actor: TokenPayload, cardId: string, sampleId: string) {
  try {
    return [await authorizeSampleCustody({ db: tx, actor, subject: { kind: 'card', id: cardId }, mode: 'write' }),
      await authorizeSampleCustody({ db: tx, actor, subject: { kind: 'sample', id: sampleId }, mode: 'write' })];
  } catch (error) {
    if (error instanceof SampleCustodyAuthorizationError) registrationError(error.code, error.message);
    throw error;
  }
}
async function cardRead(tx: any, actor: TokenPayload, cardId: string, historical = false) {
  const card = await tx.sampleCardItem.findUnique({ where: { id: cardId } });
  if (!card || !historical && card.deletedAt != null) unavailable();
  const caseId = card.devCaseId;
  if (caseId) await authorizeRegistrationCase(tx, actor, caseId, 'read', historical);
  else {
    const fresh = await actorNow(tx, actor);
    const scope = await createPermissionService({ prisma: tx }).getDataScopeResolver(fresh, 'relations');
    if (resolveWriteKind(scope.rule) !== 'all') unavailable();
  }
  return card;
}
async function cardProof(tx: any, card: any) {
  const receipt = readBatchReceiptSnapshot(card.receiptSnapshot);
  if (!receipt) return conflict('该实物缺少可验证的原 V2 收样记录；不能从今天的批次补写历史来源。');
  if (card.batchId !== receipt.batchId || card.devCaseId !== receipt.developmentCaseId || card.cardType !== receipt.cardType
    || card.unit !== receipt.physicalUnit || String(card.createdAt) !== batchReceiptRecordedAt(receipt)) conflict('原实物与冻结收样身份不一致。');
  const audits = await tx.auditLog.findMany({ where: { action: 'sample_card_create', targetType: 'SampleCardItem', targetId: card.id } });
  const audit = audits[0]; const after = audit?.detail?.after;
  if (audits.length !== 1 || audit.actorId !== receipt.receivedBy || audit.operationType !== 'create' || audit.detail?.source !== 'sample-room:batch-received'
    || after?.code !== card.code || typeof after.name !== 'string' || after.cardType !== receipt.cardType || after.unit !== receipt.physicalUnit
    || after.devCaseId !== receipt.developmentCaseId || after.batchId !== receipt.batchId || after.quantity !== receipt.initialPhysicalCardCount
    || after.availableQty !== receipt.initialPhysicalCardCount || !equal(after.receiptSnapshot, card.receiptSnapshot)) conflict('原收样创建审计缺失、重复或不完整，不能确认准确关联。');
  return { receipt, receiptHash: registrationDigest(card.receiptSnapshot), createAudit: { id: audit.id, hash: registrationDigest(audit) } };
}
const sourceFact = (row: any) => exactJsonValue({ sampleBatchId: row.sampleBatchId, sourceRound: row.sourceRound, sourceSealId: row.sourceSealId ?? null,
  sourceSnapshot: row.sourceSnapshot, sourceFingerprint: row.sourceFingerprint, provenance: row.provenance });
const factsSorted = (facts: any[]) => facts.map(f => exactJsonValue(f)).sort((a, b) => registrationDigest(a).localeCompare(registrationDigest(b)));
function sourceValid(row: any): boolean {
  const s = row.sourceSnapshot; const b = s?.batch; const v = s?.version;
  return typeof row.id === 'string' && !!row.id && typeof row.sampleId === 'string' && !!row.sampleId
    && /^\d+$/.test(String(row.boundAt)) && (row.sourceSealId == null || typeof row.sourceSealId === 'string' && !!row.sourceSealId) && s?.schemaVersion === 1 && plain(s.content) && plain(b) && plain(v)
    && ['id', 'code', 'caseId', 'factoryId', 'sampleType'].every(f => typeof b[f] === 'string' && !!b[f])
    && b.id === row.sampleBatchId && b.sourceRound === row.sourceRound && Number.isSafeInteger(row.sourceRound) && row.sourceRound > 0
    && typeof v.updatedAt === 'string' && /^\d+$/.test(v.updatedAt) && v.updatedAt === String(row.sourceUpdatedAt)
    && (v.historyRevision === null || Number.isSafeInteger(v.historyRevision) && v.historyRevision >= 0)
    && (v.eventId === null || typeof v.eventId === 'string' && !!v.eventId)
    && v.historyRevision === (row.sourceHistoryRevision ?? null) && v.eventId === (row.sourceEventId ?? null)
    && typeof row.evidenceAuditId === 'string' && !!row.evidenceAuditId && typeof row.boundBy === 'string' && !!row.boundBy
    && typeof row.sourceFingerprint === 'string' && /^[a-f0-9]{64}$/.test(row.sourceFingerprint)
    && ['native', 'recorded_exact', 'current_link_recorded'].includes(row.provenance) && sampleOriginFingerprint(s) === row.sourceFingerprint;
}
async function completeTargetProof(tx: any, sample: any) {
  const rows = (await tx.sampleSource.findMany({ where: { sampleId: sample.id }, orderBy: { id: 'asc' } })).sort((a: any, b: any) => a.id.localeCompare(b.id));
  if (!rows.length || rows.some((row: any) => !sourceValid(row)) || new Set(rows.map((r: any) => `${r.sampleBatchId}:${r.sourceRound}`)).size !== rows.length
    || new Set(rows.map((r: any) => r.provenance)).size !== 1 || new Set(rows.map((r: any) => r.evidenceAuditId)).size !== 1)
    conflict('目标样品的完整直接来源证明未能核对；继承来源尚不支持原卡关联。');
  const caseIds = sortedIds(rows.map((r: any) => r.sourceSnapshot.batch.caseId)); const factories = sortedIds(rows.map((r: any) => r.sourceSnapshot.batch.factoryId));
  if (caseIds.length !== 1 || factories.length !== 1 || sample.sourceCaseId !== caseIds[0] || sample.supplierRelationId !== factories[0]) conflict('目标样品与完整来源的开发案、工厂不一致。');
  const seals = sortedIds(rows.map((r: any) => r.sourceSealId));
  if (seals.length > 1 || seals.length && rows.some((r: any) => r.sourceSealId !== seals[0])) conflict('目标组合来源的封样集合不完整。');
  if (sample.projectionKey != null) {
    const expected = seals.length ? sealProjectionKey(seals[0]) : rows.length === 1 ? sampleProjectionKey(rows[0].sourceSnapshot.batch.sampleType === 'garment-round' ? 'garment_pp' : 'fabric_output', rows[0].sampleBatchId, rows[0].sourceRound) : null;
    if (!expected || sample.projectionKey !== expected) conflict('目标样品的原生投影身份不一致。');
  }
  const audits = await tx.auditLog.findMany({ where: { action: 'bind_sample_origins', targetType: 'Sample', targetId: sample.id } });
  const audit = audits[0]; const after = audit?.detail?.after;
  if (audits.length !== 1 || audit.id !== rows[0].evidenceAuditId || audit.detail?.source !== 'route:samples:origin' || audit.operationType != null
    || rows.some((r: any) => r.boundBy !== audit.actorId) || after?.sampleId !== sample.id || (after.projectionKey ?? null) !== (sample.projectionKey ?? null)
    || !Array.isArray(after.origins) || !equal(factsSorted(after.origins), factsSorted(rows.map(sourceFact)))) conflict('目标样品的原始完整绑定审计缺失、重复或被改动。');
  const bindings = exactJsonValue(rows);
  const bindingSetHash = registrationDigest(bindings);
  const identity = exactJsonValue(Object.fromEntries(['sourceCaseId', 'sourceOrderId', 'productAssetId', 'supplierRelationId', 'customerRelationId', 'projectionKey'].map(f => [f, sample[f] ?? null])));
  return { rows, bindings, bindingSetHash, targetIdentityHash: registrationDigest({ ...identity, bindings }), identity,
    bindAudit: { id: audit.id, hash: registrationDigest(audit) }, seals };
}
function matchReceipt(proof: Awaited<ReturnType<typeof completeTargetProof>>, receipt: any) {
  const matches = proof.rows.filter((r: any) => equal(r.sourceSnapshot.batch, receipt.sourceSnapshot.batch) && r.sourceFingerprint === receipt.sourceFingerprint);
  if (matches.length !== 1) conflict('目标样品没有唯一匹配原收样轮次和内容的来源。');
  return { ...proof, matched: matches[0] };
}
async function targetProof(tx: any, sample: any, receipt: any) { return matchReceipt(await completeTargetProof(tx, sample), receipt); }
async function graph(tx: any, card: any, sample: any, proof: any) {
  const sealIds = proof.seals;
  const seals = sealIds.length ? await tx.sealSample.findMany({ where: { id: { in: sealIds } } }) : [];
  const links = sealIds.length ? await tx.sealSampleBatch.findMany({ where: { sealSampleId: { in: sealIds } }, orderBy: { sampleBatchId: 'asc' } }) : [];
  const batchIds = sortedIds([card.batchId, ...proof.rows.map((r: any) => r.sampleBatchId), ...links.map((l: any) => l.sampleBatchId)]);
  const batches = await tx.sampleBatch.findMany({ where: { id: { in: batchIds } } });
  const orderIds = sortedIds([card.orderId, sample.sourceOrderId]);
  const orders = orderIds.length ? await tx.order.findMany({ where: { id: { in: orderIds } } }) : [];
  const caseIds = sortedIds([card.devCaseId, sample.sourceCaseId, ...proof.rows.map((r: any) => r.sourceSnapshot.batch.caseId),
    ...seals.map((s: any) => s.developmentCaseId), ...batches.map((b: any) => b.developmentCaseId), ...orders.map((o: any) => o.sourceCaseId)]);
  const cases = await tx.developmentCase.findMany({ where: { id: { in: caseIds } } });
  const factoryIds = sortedIds([...proof.rows.map((r: any) => r.sourceSnapshot.batch.factoryId), ...batches.map((b: any) => b.supplierRelationId), ...seals.map((s: any) => s.supplierRelationId)]);
  const factories = factoryIds.length ? await tx.relation.findMany({ where: { id: { in: factoryIds } } }) : [];
  const customerIds = sortedIds([sample.customerRelationId, ...cases.map((c: any) => c.customerRelationId), ...orders.map((o: any) => o.customerRelationId)]);
  const relationIds = sortedIds([...factoryIds, ...customerIds]);
  const customers = customerIds.length ? await tx.relation.findMany({ where: { id: { in: customerIds } } }) : [];
  const assetIds = sortedIds([card.productAssetId, sample.productAssetId]);
  const assets = assetIds.length ? await tx.productAsset.findMany({ where: { id: { in: assetIds } } }) : [];
  const warehouseIds = sortedIds([card.warehouseId]);
  const warehouses = warehouseIds.length ? await tx.warehouse.findMany({ where: { id: { in: warehouseIds } } }) : [];
  const locks = { caseIds, factoryIds, relationIds, sealIds, batchIds, orderIds, assetIds, warehouseIds, sampleIds: sortedIds([sample.id, card.sampleId]), cardIds: [card.id] };
  const signature = registrationDigest({ locks, bindings: proof.bindings, identity: proof.identity,
    card: Object.fromEntries(['id', 'batchId', 'devCaseId', 'orderId', 'productAssetId', 'warehouseId', 'sampleId', 'receiptSnapshot'].map(f => [f, card[f] ?? null])),
    cases: cases.map((c: any) => ({ id: c.id, type: c.type, customerRelationId: c.customerRelationId ?? null })).sort((a: any, b: any) => a.id.localeCompare(b.id)),
    customers: customers.map((c: any) => ({ id: c.id, deletedAt: c.deletedAt ?? null, ownerId: c.ownerId ?? null, departmentId: c.departmentId ?? null, salesRepIds: sortedIds(c.salesRepIds ?? []) })).sort((a: any, b: any) => a.id.localeCompare(b.id)),
    batches: batches.map((b: any) => ({ id: b.id, caseId: b.developmentCaseId, factoryId: b.supplierRelationId, sampleType: b.sampleType })).sort((a: any, b: any) => a.id.localeCompare(b.id)),
    seals: seals.map((s: any) => ({ id: s.id, caseId: s.developmentCaseId, factoryId: s.supplierRelationId })).sort((a: any, b: any) => a.id.localeCompare(b.id)),
    links: links.map((l: any) => ({ sealId: l.sealSampleId, batchId: l.sampleBatchId })).sort((a: any, b: any) => registrationDigest(a).localeCompare(registrationDigest(b))),
    orders: orders.map((o: any) => ({ id: o.id, sourceCaseId: o.sourceCaseId ?? null, type: o.type, businessLine: o.businessLine ?? null })).sort((a: any, b: any) => a.id.localeCompare(b.id)) });
  return { locks, signature, cases, batches, orders, factories, seals, links, assets, warehouses };
}
function parentCheck(card: any, sample: any, proof: any, g: any, historical = false) {
  const live = (row: any) => !!row && (historical || row.deletedAt == null);
  if (!historical && (sample.deletedAt != null || card.deletedAt != null)) unavailable();
  for (const [names, rows] of [['caseIds', g.cases], ['batchIds', g.batches], ['orderIds', g.orders], ['assetIds', g.assets], ['warehouseIds', g.warehouses], ['sealIds', g.seals]] as any)
    if (g.locks[names].some((id: string) => !live(rows.find((r: any) => r.id === id)))) conflict('准确来源的父记录缺失或不可用，不能确认关联。');
  if (!historical && g.locks.factoryIds.some((id: string) => !live(g.factories.find((r: any) => r.id === id)))) conflict('原来源工厂缺失或已删除。');
  if (!historical && g.warehouses.some((w: any) => w.isActive !== true)) conflict('实物所在样品仓当前不可用。');
  for (const row of proof.rows) {
    const b = g.batches.find((v: any) => v.id === row.sampleBatchId); const c = g.cases.find((v: any) => v.id === row.sourceSnapshot.batch.caseId); const frozen = row.sourceSnapshot.batch;
    if (!b || b.developmentCaseId !== frozen.caseId || b.supplierRelationId !== frozen.factoryId || b.sampleType !== frozen.sampleType
      || b.batchCode !== frozen.code || !c || c.type !== (frozen.sampleType === 'garment-round' ? 'garment' : 'fabric')
      || !['garment-round', 'lab-dip', 'handloom', 'yardage'].includes(frozen.sampleType)) conflict('当前父身份与原冻结来源不一致。');
  }
  for (const order of g.orders) {
    if (order.sourceCaseId && order.sourceCaseId !== sample.sourceCaseId) conflict('实物或目标订单属于不同开发案。');
    const ownerLine = g.cases.find((c: any) => c.id === sample.sourceCaseId)?.type;
    for (const declared of [order.type, order.businessLine]) if (['fabric', 'garment'].includes(declared) && declared !== ownerLine) conflict('实物或目标订单属于不同业务线。');
  }
  for (const seal of g.seals) {
    const ids = sortedIds(g.links.filter((l: any) => l.sealSampleId === seal.id).map((l: any) => l.sampleBatchId));
    if (g.cases.find((c: any) => c.id === sample.sourceCaseId)?.type !== 'fabric' || proof.rows.some((r: any) => !['lab-dip', 'handloom', 'yardage'].includes(r.sourceSnapshot.batch.sampleType))
      || seal.developmentCaseId !== sample.sourceCaseId || seal.supplierRelationId !== sample.supplierRelationId
      || !equal(ids, sortedIds(proof.rows.map((r: any) => r.sampleBatchId))) || g.links.filter((l: any) => l.sealSampleId === seal.id).length !== ids.length) conflict('原组合封样身份或完整成员已改变。');
  }
}
async function lockGraph(tx: any, g: any) {
  const recipe = [['caseIds', 'DevelopmentCase'], ['relationIds', 'Relation'], ['sealIds', 'SealSample'], ['batchIds', 'SampleBatch'],
    ['orderIds', 'Order'], ['assetIds', 'ProductAsset'], ['warehouseIds', 'Warehouse'], ['sampleIds', 'Sample'], ['cardIds', 'SampleCardItem']];
  for (const [kind, table] of recipe) for (const id of g.locks[kind]) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${table}"`)} WHERE "id"=${id} FOR UPDATE`);
}
async function requestLock(tx: any, id: string) { await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${id},0))::text`); }
async function traces(tx: any, actorId: string, requestKey: string, id: string) {
  return tx.auditLog.findMany({ where: { OR: [{ transactionId: id }, { actorId, action: { in: [LINK, RECEIPT] }, detail: { path: ['after', 'command', 'requestKey'], equals: requestKey } }] } });
}
async function verifyCommitted(tx: any, actor: TokenPayload, cardId: string, requestKey: string, row: any, input?: any) {
  const id = receiptId(actor.userId, requestKey); const after = row?.detail?.after; const cmd = after?.command; const ack = after?.ack;
  if (row?.id !== id || row.actorId !== actor.userId || row.action !== RECEIPT || row.targetType !== 'SampleCardItem' || row.targetId !== cardId
    || row.transactionId !== id || row.detail?.source !== SOURCE || row.operationType !== 'link' || !plain(cmd) || cmd.actorId !== actor.userId || cmd.cardId !== cardId
    || cmd.operation !== OP || cmd.linkVersion !== 1 || cmd.requestKey !== requestKey || !plain(cmd.input) || after.commandHash !== registrationDigest(cmd)) conflict('原关联请求回执不完整或不属于当前请求。');
  const storedInput = parse(cmd.input);
  if (storedInput.requestKey !== requestKey || input && !equal(cmd, command(actor.userId, cardId, input))) conflict('同一关联请求标识不能更换原卡或目标。');
  if (!plain(ack) || after.ackHash !== registrationDigest(ack) || ack.linkVersion !== 1 || ack.operation !== OP || ack.receiptAuditId !== id || ack.actorId !== actor.userId
    || ack.requestKey !== requestKey || ack.cardId !== cardId || ack.targetSampleId !== storedInput.targetSampleId || ack.matchedSampleSourceId !== storedInput.matchedSampleSourceId
    || ack.commandHash !== after.commandHash || !plain(ack.preservedCardFields) || ack.originalCard?.sampleId !== storedInput.targetSampleId
    || ack.originalCard?.id !== cardId || ack.originalCardHash !== registrationDigest(ack.originalCard)) conflict('原关联成功事实不完整，请保留原请求核对。');
  const card = await cardRead(tx, actor, cardId, true);
  const sample = await tx.sample.findUnique({ where: { id: storedInput.targetSampleId } }); if (!sample) unavailable();
  await authorize(tx, actor, sample, sample.sourceCaseId, true);
  const cp = await cardProof(tx, card); const tp = await targetProof(tx, sample, cp.receipt);
  const g = await graph(tx, card, sample, tp); parentCheck(card, sample, tp, g, true);
  if (card.sampleId !== sample.id || cp.receiptHash !== storedInput.expectedReceiptHash || tp.bindingSetHash !== storedInput.expectedBindingSetHash
    || tp.targetIdentityHash !== storedInput.expectedTargetIdentityHash || tp.matched.id !== storedInput.matchedSampleSourceId
    || !equal(ack.sourceBindings, tp.bindings) || !equal(ack.auditProof?.create, cp.createAudit) || !equal(ack.auditProof?.binding, tp.bindAudit)) conflict('原关联业务事实或原来源证明已缺失，不能确认成功。');
  const link = await tx.auditLog.findUnique({ where: { id: ack.auditProof?.link?.id ?? '' } });
  if (!link || registrationDigest(link) !== ack.auditProof?.link?.hash || link.actorId !== actor.userId || link.action !== LINK || link.targetType !== 'SampleCardItem'
    || link.targetId !== cardId || link.transactionId !== id || link.operationType !== 'link' || link.fieldPath !== 'sampleId' || link.detail?.source !== SOURCE
    || link.detail?.before?.sampleId !== null || link.detail?.after?.sampleId !== sample.id || link.detail?.before?.updatedAt !== storedInput.expectedCardUpdatedAt || String(link.detail?.after?.updatedAt) !== String(ack.originalCard.updatedAt)
    || BigInt(ack.originalCard.updatedAt) <= BigInt(storedInput.expectedCardUpdatedAt) || !equal(link.detail?.after?.command, cmd)
    || !equal(link.detail?.after?.preservedCardFields, ack.preservedCardFields) || !equal(link.detail?.after?.originalCard, ack.originalCard)
    || !equal(ack.preservedCardFields, Object.fromEntries(Object.entries(ack.originalCard).filter(([f]) => !['sampleId', 'updatedAt'].includes(f))))) conflict('原关联字段审计不完整或被改动。');
  const all = await traces(tx, actor.userId, requestKey, id);
  if (!equal(sortedIds(all.map((a: any) => a.id)), sortedIds([id, link.id])) || all.length !== 2) conflict('原关联请求存在缺失或额外残留审计，不能确认结果。');
  return { ...SAMPLE_CARD_SAMPLE_LINK_PROTOCOL, state: 'committed' as const, ack, currentCard: exactJsonValue(card), currentSample: exactJsonValue(sample) };
}
async function result<T>(label: string, fn: () => Promise<T>) {
  try { return { ok: true as const, data: await fn() }; }
  catch (error) { logger.error(`[sample-card-link:${label}] failed`, { error }); const s = safeRouteError(error, { fallbackCode: 'SAMPLE_CARD_LINK_FAILED', fallbackMessage: '原卡关联暂时无法核对，请保留原请求后重试。' });
    return { ok: false as const, error: { code: s.code, message: s.message, status: s.status } }; }
}
export async function getSampleCardSampleLinkContext(p: { prisma: any; actor: TokenPayload; cardId: unknown }) {
  return result('context', async () => { const cardId = registrationId(p.cardId, '原实物'); return p.prisma.$transaction(async (tx: any) => {
    const actor = await actorNow(tx, p.actor); const card = await cardRead(tx, actor, cardId);
    let proof: any; const reasons: string[] = [];
    try { proof = await cardProof(tx, card); } catch (e) { if (!(e instanceof DevelopmentDomainError)) throw e; reasons.push(e.code === 'CONFLICT' ? 'RECEIPT_OR_CREATE_AUDIT_UNVERIFIED' : e.code); }
    if (card.sampleId) reasons.push('CARD_ALREADY_LINKED'); if (!['in_stock', 'borrowed'].includes(card.status)) reasons.push('CARD_TERMINAL');
    const writable = hasScope({ ...actor, roles: [] }, 'sample:room:write'); if (!writable) reasons.push('ROOM_WRITE_REQUIRED');
    return { ...SAMPLE_CARD_SAMPLE_LINK_PROTOCOL, card: exactJsonValue(card), eligible: !reasons.length, reasons,
      expectedCardUpdatedAt: String(card.updatedAt), expectedReceiptHash: proof?.receiptHash ?? null, receipt: proof?.receipt ?? null };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }); });
}
export async function listSampleCardSampleLinkCandidates(p: { prisma: any; actor: TokenPayload; cardId: unknown; limit?: unknown; cursor?: unknown }) {
  return result('candidates', async () => { const cardId = registrationId(p.cardId, '原实物');
    const limit = p.limit === undefined ? 20 : typeof p.limit === 'string' && /^\d+$/.test(p.limit) ? Number(p.limit) : p.limit;
    if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100) registrationError('INVALID_INPUT', '候选页大小须为 1–100 整数。');
    const cursor = p.cursor == null ? null : registrationId(p.cursor, '候选游标');
    return p.prisma.$transaction(async (tx: any) => {
      const actor = await actorNow(tx, p.actor); const card = await cardRead(tx, actor, cardId); const cp = await cardProof(tx, card);
      const sources = await tx.sampleSource.findMany({ where: { sampleBatchId: cp.receipt.batchId, sourceRound: cp.receipt.sourceRound, sourceFingerprint: cp.receipt.sourceFingerprint } });
      const samples = await tx.sample.findMany({ where: { id: { in: sortedIds(sources.map((s: any) => s.sampleId)) }, deletedAt: null }, orderBy: { id: 'asc' } });
      const candidates: any[] = [];
      for (const sample of samples) {
        try {
          await authorize(tx, actor, sample, sample.sourceCaseId); const tp = await targetProof(tx, sample, cp.receipt);
          const g = await graph(tx, card, sample, tp); parentCheck(card, sample, tp, g);
          const business = await resolveSampleBusinessContext(tx, sample); if (business.status !== 'resolved') continue;
          candidates.push({ sample: exactJsonValue(sample), matchedSampleSourceId: tp.matched.id, expectedTargetIdentityHash: tp.targetIdentityHash, expectedBindingSetHash: tp.bindingSetHash,
            frozenSourceRound: tp.matched.sourceRound, currentBatchRound: g.batches.find((b: any) => b.id === tp.matched.sampleBatchId)?.round ?? null, matchedComponentOnly: true });
        } catch (e) { if (!(e instanceof DevelopmentDomainError) || !['CONFLICT', 'NOT_FOUND', 'DEVELOPMENT_SOURCE_CHANGED'].includes(e.code)) throw e; }
      }
      candidates.sort((a, b) => a.sample.id.localeCompare(b.sample.id));
      const visible = candidates.filter(c => cursor === null || c.sample.id.localeCompare(cursor) > 0); const items = visible.slice(0, Number(limit));
      return { ...SAMPLE_CARD_SAMPLE_LINK_PROTOCOL, items, hasMore: visible.length > Number(limit), nextCursor: visible.length > Number(limit) ? items[items.length - 1]?.sample.id ?? null : null,
        expectedCardUpdatedAt: String(card.updatedAt), expectedReceiptHash: cp.receiptHash };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }); });
}
export async function linkReceivedCardToSample(p: { prisma: any; actor: TokenPayload; cardId: unknown; input: unknown; ip?: string | null }) {
  return result('exact', async () => { const cardId = registrationId(p.cardId, '原实物'); const input = parse(p.input);
    return p.prisma.$transaction(async (tx: any) => {
      const actor = await actorNow(tx, p.actor, true); const id = receiptId(actor.userId, input.requestKey); const cmd = command(actor.userId, cardId, input);
      const existing = await tx.auditLog.findUnique({ where: { id } });
      if (existing) { const data = await verifyCommitted(tx, actor, cardId, input.requestKey, existing, input); await actorNow(tx, actor, true); return { ...data, replayed: true }; }
      let card = await cardRead(tx, actor, cardId);
      // A new request must never lock an already-linked Sample without first
      // discovering its parents; reject it before taking any domain row lock.
      if (card.sampleId || !['in_stock', 'borrowed'].includes(card.status)) conflict('原卡已关联或处于终态，不能执行新的关联。');
      let cp = await cardProof(tx, card);
      let sample = await tx.sample.findUnique({ where: { id: input.targetSampleId } }); if (!sample || sample.deletedAt != null) unavailable();
      await authorize(tx, actor, sample, sample.sourceCaseId); let tp = await targetProof(tx, sample, cp.receipt);
      const before = await graph(tx, card, sample, tp);
      parentCheck(card, sample, tp, before);
      const custodyBefore = await custodyWrite(tx, actor, cardId, sample.id);
      await lockGraph(tx, before);
      card = await cardRead(tx, actor, cardId); cp = await cardProof(tx, card); sample = await tx.sample.findUnique({ where: { id: input.targetSampleId } }); if (!sample) unavailable();
      tp = await targetProof(tx, sample, cp.receipt); const after = await graph(tx, card, sample, tp);
      await requestLock(tx, id); const committed = await tx.auditLog.findUnique({ where: { id } });
      if (committed) { const data = await verifyCommitted(tx, actor, cardId, input.requestKey, committed, input); await actorNow(tx, actor, true); return { ...data, replayed: true }; }
      if (before.signature !== after.signature) conflict('关联父图或完整来源在锁定期间发生变化，请重新核对，不会追锁新父。');
      if ((await traces(tx, actor.userId, input.requestKey, id)).length) conflict('原请求存在残留关联审计，不能再次执行。');
      parentCheck(card, sample, tp, after); await authorize(tx, actor, sample, sample.sourceCaseId);
      const custodyAfter = await custodyWrite(tx, actor, cardId, sample.id);
      for (let i = 0; i < custodyBefore.length; i++) {
        try { assertSampleCustodyGuardStable(custodyBefore[i].guard, custodyAfter[i].guard); }
        catch (error) { if (error instanceof SampleCustodyAuthorizationError) registrationError(error.code, error.message); throw error; }
      }
      const business = await resolveSampleBusinessContext(tx, sample); if (business.status !== 'resolved') conflict('目标真实业务主体存在冲突或尚未核对，不能按实物材料猜测。');
      if (card.sampleId || !['in_stock', 'borrowed'].includes(card.status)) conflict('原卡已关联或处于终态，不能执行新的关联。');
      if (String(card.updatedAt) !== input.expectedCardUpdatedAt || cp.receiptHash !== input.expectedReceiptHash || tp.targetIdentityHash !== input.expectedTargetIdentityHash
        || tp.bindingSetHash !== input.expectedBindingSetHash || tp.matched.id !== input.matchedSampleSourceId) conflict('打开时的原卡版本或准确来源已变化，请刷新核对。');
      const oldVersion = BigInt(card.updatedAt); const now = BigInt(Date.now()); const updatedAt = now > oldVersion ? now : oldVersion + BigInt(1);
      const originalCard = exactJsonValue({ ...card, sampleId: sample.id, updatedAt });
      const preservedCardFields = exactJsonValue(Object.fromEntries(Object.entries(card).filter(([f]) => !['sampleId', 'updatedAt'].includes(f))));
      const updated = await tx.sampleCardItem.updateMany({ where: { id: cardId, sampleId: null, deletedAt: null, updatedAt: card.updatedAt }, data: { sampleId: sample.id, updatedAt } });
      if (updated.count !== 1) conflict('原卡已被另一操作修改，请刷新核对。');
      const linkId = await writeRouteAuditLog({ prisma: tx, actorId: actor.userId, source: SOURCE, operation: LINK, targetType: 'SampleCardItem', targetId: cardId,
        before: { sampleId: null, updatedAt: String(oldVersion) }, after: { sampleId: sample.id, updatedAt: String(updatedAt), command: cmd, preservedCardFields, originalCard },
        operationType: 'link', fieldPath: 'sampleId', afterValue: sample.id, transactionId: id, ip: p.ip });
      const linkAudit = await tx.auditLog.findUnique({ where: { id: linkId } }); if (!linkAudit) conflict('必需关联审计未能核对。');
      const ack = { ...SAMPLE_CARD_SAMPLE_LINK_PROTOCOL, actorId: actor.userId, requestKey: input.requestKey, receiptAuditId: id, commandHash: registrationDigest(cmd), cardId,
        targetSampleId: sample.id, matchedSampleSourceId: tp.matched.id, originalCard, originalCardHash: registrationDigest(originalCard), preservedCardFields,
        sourceBindings: tp.bindings, auditProof: { create: cp.createAudit, binding: tp.bindAudit, link: { id: linkId, hash: registrationDigest(linkAudit) } } };
      await actorNow(tx, actor, true); await authorize(tx, actor, sample, sample.sourceCaseId);
      await custodyWrite(tx, actor, cardId, sample.id);
      await tx.auditLog.create({ data: { id, actorId: actor.userId, action: RECEIPT, targetType: 'SampleCardItem', targetId: cardId, transactionId: id, operationType: 'link', fieldPath: 'sampleId',
        detail: exactJsonValue({ source: SOURCE, after: { command: cmd, commandHash: registrationDigest(cmd), ack, ackHash: registrationDigest(ack) } }), ip: p.ip ?? null } });
      return { ...SAMPLE_CARD_SAMPLE_LINK_PROTOCOL, state: 'committed' as const, ack, currentCard: originalCard, currentSample: exactJsonValue(sample), replayed: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }); });
}
export async function recoverSampleCardSampleLink(p: { prisma: any; actor: TokenPayload; cardId: unknown; requestKey: unknown }) {
  return result('recover', async () => { const cardId = registrationId(p.cardId, '原实物'); const requestKey = key(p.requestKey);
    return p.prisma.$transaction(async (tx: any) => {
      const actor = await actorNow(tx, p.actor); const id = receiptId(actor.userId, requestKey); const row = await tx.auditLog.findUnique({ where: { id } });
      if (row) return verifyCommitted(tx, actor, cardId, requestKey, row);
      const card = await cardRead(tx, actor, cardId); await cardProof(tx, card);
      if (card.sampleId || (await traces(tx, actor.userId, requestKey, id)).length) conflict('原卡已关联或存在残留请求证明，不能认定原请求未执行。');
      return { ...SAMPLE_CARD_SAMPLE_LINK_PROTOCOL, state: 'not_confirmed' as const, retryOriginalRequest: true as const, cardId, requestKey };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }); });
}

/** Custody reads use real owners, not exact-registration eligibility or material type. */
async function custodyAccess(tx: any, actor: TokenPayload, sources: { caseIds?: any[]; orderIds?: any[]; batchIds?: any[]; customerIds?: any[]; assetIds?: any[]; requireAnchor?: boolean }) {
  let all: boolean | undefined; const records: any[] = [];
  const remember = (type: string, id: string, row: any, fields: string[]) => records.push({ type, id, value: row ? Object.fromEntries(fields.map(f => [f, row[f] ?? null])) : null });
  const requireAll = async () => {
    if (all === undefined) all = resolveWriteKind((await createPermissionService({ prisma: tx }).getDataScopeResolver(actor, 'relations')).rule) === 'all';
    if (!all) unavailable();
  };
  const refs = (values: any[] = []) => {
    if (values.some(v => v != null && (typeof v !== 'string' || !v.trim() || v.trim() !== v))) unavailable();
    return sortedIds(values);
  };
  const cases = refs(sources.caseIds), orders = refs(sources.orderIds), batches = refs(sources.batchIds), customers = refs(sources.customerIds), assets = refs(sources.assetIds);
  if (sources.requireAnchor && !cases.length && !orders.length && !customers.length) await requireAll();
  for (const id of batches) {
    const row = await tx.sampleBatch.findUnique({ where: { id } });
    remember('batch', id, row, ['developmentCaseId', 'supplierRelationId', 'sampleType', 'deletedAt']);
    if (!row || row.deletedAt != null) await requireAll();
    if (row?.developmentCaseId) cases.push(...refs([row.developmentCaseId])); else await requireAll();
  }
  for (const id of orders) {
    const row = await tx.order.findUnique({ where: { id } });
    remember('order', id, row, ['sourceCaseId', 'customerRelationId', 'type', 'businessLine', 'deletedAt']);
    if (!row || row.deletedAt != null) await requireAll();
    if (row?.customerRelationId) customers.push(...refs([row.customerRelationId]));
    if (row?.sourceCaseId) cases.push(...refs([row.sourceCaseId]));
    if (!row?.customerRelationId && !row?.sourceCaseId) await requireAll();
  }
  for (const id of sortedIds(cases)) {
    const row = await tx.developmentCase.findUnique({ where: { id } });
    remember('case', id, row, ['customerRelationId', 'type', 'deletedAt']);
    if (!row || row.deletedAt != null) await requireAll();
    if (row?.customerRelationId) customers.push(...refs([row.customerRelationId])); else await requireAll();
  }
  for (const id of sortedIds(customers)) {
    const row = await tx.relation.findFirst({ where: { id, deletedAt: null } });
    remember('customer', id, row, ['ownerId', 'salesRepIds', 'deletedAt']);
    if (!row) { await requireAll(); continue; }
    if (await createTeamShareService(tx).resolveRelationAccess(actor, id, { fresh: true }) === 'none') unavailable();
  }
  for (const id of assets) {
    const row = await tx.productAsset.findUnique({ where: { id }, select: { id: true, mainCategory: true, deletedAt: true, fabricProfile: { select: { id: true, deletedAt: true } }, garmentProfile: { select: { id: true, deletedAt: true } } } });
    remember('business-asset', id, row, ['mainCategory', 'fabricProfile', 'garmentProfile', 'deletedAt']);
    if (!row || row.deletedAt != null) await requireAll();
  }
  return registrationDigest(records.sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`)));
}
async function custodySample(tx: any, actor: TokenPayload, sampleId: string) {
  const sample = await tx.sample.findFirst({ where: { id: sampleId, deletedAt: null } });
  if (!sample) unavailable();
  const accessHash = await custodyAccess(tx, actor, { caseIds: [sample.sourceCaseId], orderIds: [sample.sourceOrderId], customerIds: [sample.customerRelationId], assetIds: [sample.productAssetId], requireAnchor: true });
  return { sample, accessHash };
}
async function custodyCard(tx: any, actor: TokenPayload, card: any) {
  return custodyAccess(tx, actor, { caseIds: [card.devCaseId], orderIds: [card.orderId], batchIds: [card.batchId] });
}
const sampleReadIdentity = (sample: any) => registrationDigest(Object.fromEntries(['id', 'createdAt', 'sourceCaseId', 'sourceOrderId', 'productAssetId', 'customerRelationId', 'supplierRelationId', 'projectionKey', 'deletedAt'].map(f => [f, sample[f] ?? null])));
const cardReadIdentity = (card: any) => registrationDigest(Object.fromEntries(['id', 'createdAt', 'code', 'cardType', 'unit', 'sampleId', 'devCaseId', 'batchId', 'orderId', 'productAssetId', 'warehouseId', 'receiptSnapshot', 'deletedAt'].map(f => [f, card[f] ?? null])));
type ReadGuard = { sampleId: string; sampleHash: string; sampleAccessHash: string; cards: Array<{ id: string; identityHash: string; accessHash: string }> };
/** Outside RR: current authority cannot be certified by rereading its old snapshot. */
async function finishCustodyRead(prisma: any, originalActor: TokenPayload, guard: ReadGuard) {
  const actor = await actorNow(prisma, originalActor); const current = await custodySample(prisma, actor, guard.sampleId);
  if (sampleReadIdentity(current.sample) !== guard.sampleHash || current.accessHash !== guard.sampleAccessHash) conflict('读取期间目标样品来源或权限父图已改变，请重新核对。');
  for (const frozen of guard.cards) {
    const card = await prisma.sampleCardItem.findUnique({ where: { id: frozen.id } });
    if (!card || cardReadIdentity(card) !== frozen.identityHash) conflict('读取期间原实物归属或身份已改变，请重新核对。');
    if (await custodyCard(prisma, actor, card) !== frozen.accessHash) conflict('读取期间原实物的来源父图已改变，请重新核对。');
  }
  await actorNow(prisma, originalActor);
}
function readPage(p: { limit?: unknown; cursor?: unknown }) {
  const limit = p.limit === undefined ? 20 : typeof p.limit === 'string' && /^\d+$/.test(p.limit) ? Number(p.limit) : p.limit;
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100) registrationError('INVALID_INPUT', '候选页大小须为 1–100 整数。');
  return { limit: Number(limit), cursor: p.cursor == null ? null : registrationId(p.cursor, '实物游标') };
}
const cardFields = ['id', 'code', 'name', 'cardType', 'location', 'status', 'quantity', 'availableQty', 'unit', 'minStock', 'maxStock', 'sealedStatus', 'sealedAt', 'sealedBy',
  'standardBatchNo', 'notes', 'createdAt', 'updatedAt', 'deletedAt', 'warehouseId', 'devCaseId', 'batchId', 'orderId', 'productAssetId', 'sampleId', 'receiptSnapshot'];
async function custodyItem(tx: any, card: any, sample: any, businessContext: any, snapshotAt: string) {
  const loans = await tx.sampleCardLoan.findMany({ where: { itemId: card.id, loanType: 'borrow', returnedAt: null }, orderBy: { loanedAt: 'desc' } });
  const activeLoans = loans.map((loan: any) => ({ ...exactJsonValue(loan), active: true, overdue: loan.dueAt != null && BigInt(loan.dueAt) < BigInt(snapshotAt) }));
  const [development, order, warehouse] = await Promise.all([
    card.devCaseId ? tx.developmentCase.findUnique({ where: { id: card.devCaseId } }) : null,
    card.orderId ? tx.order.findUnique({ where: { id: card.orderId } }) : null,
    card.warehouseId ? tx.warehouse.findUnique({ where: { id: card.warehouseId } }) : null,
  ]);
  return { card: exactJsonValue(Object.fromEntries(cardFields.map(f => [f, card[f] ?? null]))), businessContext,
    activeLoans, overdue: activeLoans.some((loan: any) => loan.overdue), links: {
      sample: exactJsonValue({ id: sample.id, code: sample.code ?? null, type: sample.type ?? null }),
      devCase: development ? exactJsonValue({ id: development.id, code: development.code ?? null, name: development.name ?? null }) : null,
      order: order ? exactJsonValue({ id: order.id, poNumber: order.poNumber ?? null, customer: order.customer ?? null }) : null,
      warehouse: warehouse ? exactJsonValue({ id: warehouse.id, code: warehouse.code ?? null, name: warehouse.name ?? null }) : null,
    } };
}
function invisibleOrUnqualified(error: unknown) {
  return error instanceof DevelopmentDomainError && ['NOT_FOUND', 'CONFLICT', 'DEVELOPMENT_SOURCE_CHANGED'].includes(error.code);
}
export async function listReceivedCardsForSample(p: { prisma: any; actor: TokenPayload; sampleId: unknown; limit?: unknown; cursor?: unknown }) {
  return result('received-cards', async () => { const sampleId = registrationId(p.sampleId, '当前样品'); const page = readPage(p); let guard!: ReadGuard;
    const data = await p.prisma.$transaction(async (tx: any) => {
      const actor = await actorNow(tx, p.actor); const anchor = await custodySample(tx, actor, sampleId); const sample = anchor.sample; const snapshotAt = String(Date.now());
      guard = { sampleId, sampleHash: sampleReadIdentity(sample), sampleAccessHash: anchor.accessHash, cards: [] };
      const business = await resolveSampleBusinessContext(tx, sample); const reasons: string[] = [];
      if (business.status !== 'resolved') reasons.push('TARGET_BUSINESS_UNRESOLVED');
      let target: Awaited<ReturnType<typeof completeTargetProof>> | undefined;
      try { target = await completeTargetProof(tx, sample); } catch (error) { if (!(error instanceof DevelopmentDomainError) || error.code !== 'CONFLICT') throw error; reasons.push('TARGET_DIRECT_SOURCE_UNVERIFIED'); }
      const items: any[] = []; let hasMore = false;
      if (!reasons.length && target) {
        let scanCursor = page.cursor;
        while (true) {
          const cards = await tx.sampleCardItem.findMany({ where: { deletedAt: null, sampleId: null, batchId: { in: sortedIds(target.rows.map((r: any) => r.sampleBatchId)) },
            status: { in: ['in_stock', 'borrowed'] }, ...(scanCursor ? { id: { gt: scanCursor } } : {}) }, orderBy: { id: 'asc' }, take: 200 });
          for (const card of cards) {
            try {
              const accessHash = await custodyCard(tx, actor, card); const cp = await cardProof(tx, card); const tp = matchReceipt(target, cp.receipt);
              const g = await graph(tx, card, sample, tp); parentCheck(card, sample, tp, g);
              const context = (await resolvePhysicalSampleBusinessContexts(tx, [card]))[0]; if (context.status !== 'resolved') continue;
              guard.cards.push({ id: card.id, identityHash: cardReadIdentity(card), accessHash });
              if (items.length === page.limit) { hasMore = true; break; }
              items.push({ ...await custodyItem(tx, card, sample, context, snapshotAt), receiptStatus: 'verified', receipt: cp.receipt,
                expectedCardUpdatedAt: String(card.updatedAt), expectedReceiptHash: cp.receiptHash, matchedSampleSourceId: tp.matched.id,
                expectedTargetIdentityHash: tp.targetIdentityHash, expectedBindingSetHash: tp.bindingSetHash, frozenSourceRound: tp.matched.sourceRound,
                currentBatchRound: g.batches.find((b: any) => b.id === tp.matched.sampleBatchId)?.round ?? null, matchedComponentOnly: true });
            } catch (error) { if (!invisibleOrUnqualified(error)) throw error; }
          }
          if (hasMore || cards.length < 200) break;
          scanCursor = cards[cards.length - 1].id;
        }
      }
      return { ...SAMPLE_CARD_SAMPLE_LINK_PROTOCOL, readerVersion: 1, queryMode: 'target-sample-exact-unlinked-v2', anchorSampleId: sampleId, snapshotAt, pagination: page,
        targetEligibility: { eligible: !reasons.length, reasons }, expectedTargetIdentityHash: !reasons.length ? target?.targetIdentityHash ?? null : null, expectedBindingSetHash: !reasons.length ? target?.bindingSetHash ?? null : null,
        items, hasMore, nextCursor: hasMore && items.length ? items[items.length - 1].card.id : null };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5000, timeout: 30000 });
    await finishCustodyRead(p.prisma, p.actor, guard); return data;
  });
}

export async function listSampleLinkedReviewCards(p: { prisma: any; actor: TokenPayload; sampleId: unknown; limit?: unknown; cursor?: unknown }) {
  return result('linked-review', async () => { const sampleId = registrationId(p.sampleId, '当前样品'); const page = readPage(p); let guard!: ReadGuard;
    const data = await p.prisma.$transaction(async (tx: any) => {
      const actor = await actorNow(tx, p.actor); const anchor = await custodySample(tx, actor, sampleId); const sample = anchor.sample; const snapshotAt = String(Date.now());
      guard = { sampleId, sampleHash: sampleReadIdentity(sample), sampleAccessHash: anchor.accessHash, cards: [] };
      const items: any[] = []; let hasMore = false; let scanCursor = page.cursor;
      while (true) {
        const cards = await tx.sampleCardItem.findMany({ where: { deletedAt: null, sampleId, ...(scanCursor ? { id: { gt: scanCursor } } : {}) }, orderBy: { id: 'asc' }, take: 200 });
        const contexts = await resolvePhysicalSampleBusinessContexts(tx, cards);
        for (let i = 0; i < cards.length; i++) {
          const card = cards[i], context = contexts[i]; if (context.status === 'resolved') continue;
          try {
            const accessHash = await custodyCard(tx, actor, card);
            guard.cards.push({ id: card.id, identityHash: cardReadIdentity(card), accessHash });
            if (items.length === page.limit) { hasMore = true; break; }
            let verified = false; const reasons = ['CARD_ALREADY_LINKED'];
            try { await cardProof(tx, card); verified = true; }
            catch (error) { if (!(error instanceof DevelopmentDomainError) || error.code !== 'CONFLICT') throw error; reasons.push('RECEIPT_OR_CREATE_AUDIT_UNVERIFIED'); }
            if (!['in_stock', 'borrowed'].includes(card.status)) reasons.push('CARD_TERMINAL');
            items.push({ ...await custodyItem(tx, card, sample, context, snapshotAt),
              receiptStatus: card.batchId ? verified ? 'verified' : 'legacyUnverified' : 'manual', linkEligibility: { eligible: false, reasons } });
          } catch (error) { if (!(error instanceof DevelopmentDomainError) || error.code !== 'NOT_FOUND') throw error; }
        }
        if (hasMore || cards.length < 200) break;
        scanCursor = cards[cards.length - 1].id;
      }
      return { ...SAMPLE_CARD_SAMPLE_LINK_PROTOCOL, readerVersion: 1, queryMode: 'same-sample-linked-review', anchorSampleId: sampleId, snapshotAt, pagination: page, items,
        hasMore, nextCursor: hasMore && items.length ? items[items.length - 1].card.id : null };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5000, timeout: 30000 });
    await finishCustodyRead(p.prisma, p.actor, guard); return data;
  });
}
