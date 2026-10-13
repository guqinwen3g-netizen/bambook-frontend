import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { exactJsonValue } from '../lib/exactJsonValue';
import { safeRouteError } from '../shared/routeError';
import { logger } from '../lib/logger';
import { createSampleInTx, SAMPLE_TYPES } from './sampleManageService';
import { resolveSampleBusinessContext } from './sampleBusinessContext';
import { lockSampleOriginParents, readSampleOriginContexts, loadSampleOriginCommand, loadSealSampleOriginCommand, type SampleOriginCommand, type SampleSealOriginCommand } from './sampleOriginService';
import { authorizeRegistrationCase, currentRegistrationActor, registrationCaseContent, registrationDigest, registrationError, registrationId,
  SAMPLE_REGISTRATION_PROTOCOL } from './sampleRegistrationContextService';

const OPERATION = 'register_ordinary_sample';
const RECEIPT_ACTION = 'sample_registration_receipt';
const SOURCE = 'route:samples:registration-command';
const plain = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const fields = ['registrationVersion', 'requestKey', 'type', 'subType', 'sourceCaseId', 'expectedCaseUpdatedAt', 'expectedCaseContentFingerprint',
  'origin', 'sealOrigin', 'notes', 'attachments'];
function requestKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) registrationError('INVALID_INPUT', '请保留一个稳定的样品登记请求标识（8–128 个字符）。');
  return value as string;
}
function sourceInput(value: unknown): SampleOriginCommand {
  if (!plain(value) || Object.keys(value).some(key => !['batchId', 'sourceRound', 'expectedUpdatedAt', 'expectedFactoryId', 'expectedHistoryRevision', 'expectedEventId', 'expectedContentFingerprint'].includes(key)))
    registrationError('INVALID_INPUT', '准确批次来源字段无效，请重新读取来源。');
  const input = value as Record<string, any>;
  registrationId(input.batchId, '批次'); registrationId(input.expectedFactoryId, '工厂');
  if (!Number.isSafeInteger(input.sourceRound) || input.sourceRound < 1 || typeof input.expectedUpdatedAt !== 'string' || !/^\d+$/.test(input.expectedUpdatedAt)
    || !Object.prototype.hasOwnProperty.call(input, 'expectedHistoryRevision') || input.expectedHistoryRevision !== null && (!Number.isSafeInteger(input.expectedHistoryRevision) || input.expectedHistoryRevision < 0)
    || !Object.prototype.hasOwnProperty.call(input, 'expectedEventId') || input.expectedEventId !== null && (typeof input.expectedEventId !== 'string' || !input.expectedEventId)
    || typeof input.expectedContentFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedContentFingerprint))
    registrationError('INVALID_INPUT', '批次轮次、工厂、历史事件及原内容版本须完整核对。');
  return exactJsonValue(input);
}
function parse(raw: unknown) {
  if (!plain(raw) || Object.keys(raw).some(key => !fields.includes(key)) || raw.registrationVersion !== 2) registrationError('INVALID_INPUT', '准确样品登记须使用版本 2 完整协议，不能降级为普通草稿。');
  const input = raw as Record<string, any>; const key = requestKey(input.requestKey);
  registrationId(input.sourceCaseId, '开发案');
  if (typeof input.type !== 'string' || !(SAMPLE_TYPES as readonly string[]).includes(input.type)
    || typeof input.expectedCaseUpdatedAt !== 'string' || !/^\d+$/.test(input.expectedCaseUpdatedAt)
    || typeof input.expectedCaseContentFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedCaseContentFingerprint)) registrationError('INVALID_INPUT', '样品类型和打开时的开发案版本须明确核对。');
  for (const field of ['subType', 'notes']) if (input[field] !== undefined && input[field] !== null && (typeof input[field] !== 'string' || input[field].length > 10000)) registrationError('INVALID_INPUT', '样品用途与说明字段无效。');
  if (!!input.origin === !!input.sealOrigin) registrationError('INVALID_INPUT', '准确登记须选择一个批次或一套完整封样来源。');
  const normalized: Record<string, any> = exactJsonValue(input);
  if (input.origin) normalized.origin = sourceInput(input.origin);
  if (input.sealOrigin) {
    const seal = input.sealOrigin;
    if (!plain(seal) || Object.keys(seal).some(field => !['sealId', 'expectedUpdatedAt', 'expectedFactoryId', 'components'].includes(field))
      || typeof seal.expectedUpdatedAt !== 'string' || !/^\d+$/.test(seal.expectedUpdatedAt) || !Array.isArray(seal.components) || !seal.components.length || seal.components.length > 1000)
      registrationError('INVALID_INPUT', '组合封样须保留原版本、工厂与全部组件。');
    registrationId(seal.sealId, '封样'); registrationId(seal.expectedFactoryId, '工厂');
    const components = seal.components.map(sourceInput).sort((a: SampleOriginCommand, b: SampleOriginCommand) => a.batchId.localeCompare(b.batchId));
    if (new Set(components.map((component: SampleOriginCommand) => component.batchId)).size !== components.length) registrationError('INVALID_INPUT', '封样组件不能重复。');
    normalized.sealOrigin = { ...seal, components } as SampleSealOriginCommand;
  }
  if (input.attachments !== undefined && (!plain(input.attachments) || JSON.stringify(input.attachments).length > 65536)) registrationError('INVALID_INPUT', '样品明细须为有限的明确 JSON 内容。');
  return { key, input: normalized };
}
function identity(actorId: string, key: string) {
  const hash = registrationDigest({ registrationVersion: 2, operation: OPERATION, actorId, requestKey: key });
  return { receiptId: `sample-register:${hash}`, sampleId: `SMP__register_${hash}` };
}
function commandOf(actorId: string, key: string, input: Record<string, any>) { return { registrationVersion: 2, operation: OPERATION, actorId, requestKey: key, input }; }
async function traces(tx: any, actorId: string, key: string, id: string) {
  return tx.auditLog.findMany({ where: { OR: [{ transactionId: id }, { detail: { path: ['after', 'registrationRequest', 'receiptAuditId'], equals: id } },
    { actorId, action: { in: ['create_sample', 'bind_sample_origins'] }, detail: { path: ['after', 'registrationRequest', 'requestKey'], equals: key } },
    { actorId, action: RECEIPT_ACTION, detail: { path: ['after', 'command', 'requestKey'], equals: key } }] } });
}
function readReceipt(row: any, actorId: string, key: string, input?: Record<string, any>) {
  const { receiptId, sampleId } = identity(actorId, key); const after = row?.detail?.after; const storedCommand = after?.command; const ack = after?.ack;
  if (!row || row.id !== receiptId || row.actorId !== actorId || row.action !== RECEIPT_ACTION || row.targetType !== 'Sample' || row.targetId !== sampleId
    || row.transactionId !== receiptId || row.detail?.source !== SOURCE || !plain(storedCommand) || storedCommand.registrationVersion !== 2 || storedCommand.operation !== OPERATION
    || storedCommand.actorId !== actorId || storedCommand.requestKey !== key || !plain(storedCommand.input) || after.commandHash !== registrationDigest(storedCommand)
    || input && registrationDigest(storedCommand) !== registrationDigest(commandOf(actorId, key, input))) registrationError('CONFLICT', '原样品登记请求与当前参数或历史回执不一致，请保留原请求核对。');
  if (!ack || ack.registrationVersion !== 2 || ack.operation !== OPERATION || ack.actorId !== actorId || ack.requestKey !== key || ack.commandHash !== after.commandHash
    || ack.receiptAuditId !== receiptId || ack.sampleId !== sampleId || ack.originalSample?.id !== sampleId || ack.originalSample.sourceCaseId !== storedCommand.input.sourceCaseId
    || ack.originalSample.type !== storedCommand.input.type || ack.originalSample.projectionKey != null || ack.originalSample.status !== 'draft'
    || ack.originalSampleHash !== registrationDigest(ack.originalSample) || !Array.isArray(ack.sourceBindings) || !ack.sourceBindings.length
    || ack.sourceBindingsHash !== registrationDigest(ack.sourceBindings) || !plain(ack.auditProof?.create) || typeof ack.auditProof.create.id !== 'string' || !/^[a-f0-9]{64}$/.test(ack.auditProof.create.hash) || !Array.isArray(ack.auditProof?.bindings) || !ack.auditProof.bindings.length
    || after.ackHash !== registrationDigest(ack)) registrationError('CONFLICT', '原样品创建回执不完整，请保留原请求核对。');
  return { ack, command: storedCommand };
}
function checkAudit(row: any, proof: any, action: string, source: string, ack: any, command: any) {
  const anchor = row?.detail?.after?.registrationRequest;
  if (!row || typeof proof?.id !== 'string' || row.id !== proof.id || row.actorId !== ack.actorId || row.action !== action || row.targetType !== 'Sample' || row.targetId !== ack.sampleId
    || row.detail?.source !== source || row.transactionId !== ack.receiptAuditId || registrationDigest(row) !== proof.hash || !anchor
    || anchor.registrationVersion !== 2 || anchor.operation !== OPERATION || anchor.actorId !== ack.actorId || anchor.requestKey !== ack.requestKey
    || anchor.receiptAuditId !== ack.receiptAuditId || anchor.commandHash !== ack.commandHash || registrationDigest(anchor.command) !== registrationDigest(command))
    registrationError('CONFLICT', '原样品登记的必需创建或绑定审计无法核对，请保留原请求。');
}
async function replay(tx: any, actor: TokenPayload, key: string, prior: any, input?: Record<string, any>) {
  const { ack, command } = readReceipt(prior, actor.userId, key, input);
  await authorizeRegistrationCase(tx, actor, registrationId(command.input.sourceCaseId, '开发案'), 'read', true);
  const sample = await tx.sample.findUnique({ where: { id: ack.sampleId } });
  if (!sample || sample.sourceCaseId !== command.input.sourceCaseId || sample.projectionKey != null) registrationError('CONFLICT', '原样品创建对象缺失或身份已变化，不能再次登记。');
  const bindings = await tx.sampleSource.findMany({ where: { sampleId: ack.sampleId }, orderBy: { id: 'asc' } });
  if (registrationDigest(exactJsonValue(bindings)) !== ack.sourceBindingsHash) registrationError('CONFLICT', '原样品准确来源绑定无法核对，不能再次登记。');
  const native = await tx.auditLog.findUnique({ where: { id: ack.auditProof.create.id } });
  checkAudit(native, ack.auditProof.create, 'create_sample', 'route:samples:manage', ack, command);
  if (registrationDigest(native.detail.after.registrationSampleFact) !== ack.originalSampleHash) registrationError('CONFLICT', '原样品创建快照与原生创建审计不一致。');
  const expectedIds = new Set([ack.receiptAuditId, ack.auditProof.create.id]);
  for (const proof of ack.auditProof.bindings) {
    if (expectedIds.has(proof.id)) registrationError('CONFLICT', '原登记审计身份重复，请核对原请求。');
    expectedIds.add(proof.id);
    const audit = await tx.auditLog.findUnique({ where: { id: proof.id } });
    checkAudit(audit, proof, 'bind_sample_origins', 'route:samples:origin', ack, command);
    if (!bindings.some((binding: any) => binding.evidenceAuditId === proof.id)) registrationError('CONFLICT', '准确来源与原绑定审计不一致。');
    const facts = bindings.filter((binding: any) => binding.evidenceAuditId === proof.id).map((binding: any) => ({ sampleBatchId: binding.sampleBatchId,
      sourceRound: binding.sourceRound, sourceSealId: binding.sourceSealId ?? null, sourceSnapshot: binding.sourceSnapshot,
      sourceFingerprint: binding.sourceFingerprint, provenance: binding.provenance })).sort((a: any, b: any) => a.sampleBatchId.localeCompare(b.sampleBatchId));
    if (registrationDigest(audit.detail.after.origins) !== registrationDigest(facts)) registrationError('CONFLICT', '准确来源事实与原生绑定审计不一致。');
  }
  if (bindings.some((binding: any) => !ack.auditProof.bindings.some((proof: any) => proof.id === binding.evidenceAuditId))) registrationError('CONFLICT', '准确来源缺少原绑定审计。');
  const residual = await traces(tx, actor.userId, key, ack.receiptAuditId);
  if (residual.length !== expectedIds.size || residual.some((audit: any) => !expectedIds.has(audit.id))) registrationError('CONFLICT', '原请求存在额外或缺失的已提交事实，请核对登记记录。');
  const [sourceContext] = await readSampleOriginContexts(tx, [sample]);
  const businessContext = await resolveSampleBusinessContext(tx, sample);
  await authorizeRegistrationCase(tx, actor, command.input.sourceCaseId, 'read', true);
  return { ...SAMPLE_REGISTRATION_PROTOCOL, acknowledgement: ack, sample: ack.originalSample, replayed: true,
    currentSample: exactJsonValue({ ...sample, businessContext, sourceContext }), sourceContext };
}
async function sourceGraph(tx: any, input: Record<string, any>) {
  const sealId = input.sealOrigin?.sealId; const supplied = input.origin ? [input.origin.batchId] : input.sealOrigin.components.map((component: any) => component.batchId);
  const [batches, seal, links] = await Promise.all([
    tx.sampleBatch.findMany({ where: { id: { in: supplied } } }), sealId ? tx.sealSample.findFirst({ where: { id: sealId } }) : null,
    sealId ? tx.sealSampleBatch.findMany({ where: { sealSampleId: sealId }, orderBy: { sampleBatchId: 'asc' } }) : [],
  ]);
  if (batches.length !== supplied.length || batches.some((batch: any) => batch.deletedAt != null || batch.developmentCaseId !== input.sourceCaseId)
    || sealId && (!seal || seal.deletedAt != null || seal.developmentCaseId !== input.sourceCaseId || registrationDigest(links.map((link: any) => link.sampleBatchId).sort()) !== registrationDigest([...supplied].sort())))
    registrationError('DEVELOPMENT_SOURCE_CHANGED', '批次、封样组件或开发案关系已变化，请保留原请求核对。');
  return { batches, seal, links, signature: registrationDigest({ batches: batches.map((batch: any) => [batch.id, batch.developmentCaseId, batch.supplierRelationId]).sort(),
    seal: seal ? [seal.id, seal.developmentCaseId, seal.supplierRelationId] : null, links: links.map((link: any) => [link.sealSampleId, link.sampleBatchId]).sort() }) };
}
function sourceFactoryIds(graph: Awaited<ReturnType<typeof sourceGraph>>): string[] {
  const values = [...graph.batches.map((batch: any) => batch.supplierRelationId), ...(graph.seal ? [graph.seal.supplierRelationId] : [])];
  if (values.some(id => typeof id !== 'string' || !id.trim())) registrationError('DEVELOPMENT_SOURCE_CHANGED', '来源工厂身份不完整，请核对原请求。');
  return [...new Set<string>(values)].sort();
}
async function assertSourceFactoriesLive(tx: any, graph: Awaited<ReturnType<typeof sourceGraph>>) {
  for (const id of sourceFactoryIds(graph)) {
    const factory = await tx.relation.findFirst({ where: { id, deletedAt: null } });
    if (!factory || factory.id !== id || factory.deletedAt != null) registrationError('DEVELOPMENT_SOURCE_CHANGED', '来源工厂不存在或已删除。');
  }
}
async function createInTx(tx: any, actor: TokenPayload, key: string, input: Record<string, any>, ip?: string | null) {
  const { receiptId, sampleId } = identity(actor.userId, key);
  await authorizeRegistrationCase(tx, actor, input.sourceCaseId, 'write', true);
  await lockSampleOriginParents(tx, { caseIds: [input.sourceCaseId], sealIds: [], batchIds: [] });
  const observedPrior = await tx.auditLog.findUnique({ where: { id: receiptId } });
  // First writes lock the complete existing parent set before the request
  // advisory key. Recovery does not demand today's source CAS or lifecycle.
  let before: Awaited<ReturnType<typeof sourceGraph>> | null = null;
  if (!observedPrior) {
    if ((await traces(tx, actor.userId, key, receiptId)).length || await tx.sample.findUnique({ where: { id: sampleId } })
      || (await tx.sampleSource.findMany({ where: { sampleId } })).length) registrationError('CONFLICT', '原请求仍有已提交或损坏的历史事实，不能当作未执行重新登记。');
    before = await sourceGraph(tx, input);
    // Relation soft-delete does not take the Case/Batch locks. First creation
    // therefore holds Case→sorted factory Relations→Seal→Batch until commit.
    // Recovery reads original committed facts without demanding live factories.
    for (const id of sourceFactoryIds(before)) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Relation" WHERE "id"=${id} FOR UPDATE`);
    await assertSourceFactoriesLive(tx, before);
    await lockSampleOriginParents(tx, { caseIds: [input.sourceCaseId], sealIds: before.seal ? [before.seal.id] : [], batchIds: before.batches.map((batch: any) => batch.id) });
  }
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${receiptId}, 0))::text`);
  const prior = await tx.auditLog.findUnique({ where: { id: receiptId } });
  if (prior) {
    const result = await replay(tx, actor, key, prior, input);
    await authorizeRegistrationCase(tx, actor, input.sourceCaseId, 'write', true);
    return result;
  }
  if (observedPrior) registrationError('CONFLICT', '等待期间原登记回执已失效，请保留原请求核对。');
  if ((await traces(tx, actor.userId, key, receiptId)).length || await tx.sample.findUnique({ where: { id: sampleId } })
    || (await tx.sampleSource.findMany({ where: { sampleId } })).length) registrationError('CONFLICT', '原请求仍有已提交或损坏的历史事实，不能当作未执行重新登记。');
  const current = await sourceGraph(tx, input);
  if (!before || current.signature !== before.signature) registrationError('DEVELOPMENT_SOURCE_CHANGED', '来源父项在等待期间已变化，请保留原请求核对。');
  const { development } = await authorizeRegistrationCase(tx, actor, input.sourceCaseId, 'write');
  if (String(development.updatedAt) !== input.expectedCaseUpdatedAt || registrationDigest(registrationCaseContent(development)) !== input.expectedCaseContentFingerprint)
    registrationError('DEVELOPMENT_SOURCE_CHANGED', '开发案规格与打开时的版本不同，请核对新规格后使用新的明确请求。');
  await assertSourceFactoriesLive(tx, current);
  const command = commandOf(actor.userId, key, input), commandHash = registrationDigest(command);
  const anchor = { registrationVersion: 2, operation: OPERATION, actorId: actor.userId, requestKey: key, receiptAuditId: receiptId, command, commandHash };
  const producerInput: any = { type: input.type, sourceCaseId: input.sourceCaseId, customerRelationId: development.customerRelationId ?? undefined,
    ...(input.subType !== undefined ? { subType: input.subType } : {}), ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...(input.attachments !== undefined ? { attachments: input.attachments } : {}), ...(input.origin ? { origin: input.origin } : { sealOrigin: input.sealOrigin }) };
  const made = await createSampleInTx(tx, { input: producerInput, actorId: actor.userId, trustedActor: actor, ip },
    { sampleId, auditAnchor: { transactionId: receiptId, registrationRequest: anchor } });
  const sample = await tx.sample.findUnique({ where: { id: sampleId } });
  const bindings = await tx.sampleSource.findMany({ where: { sampleId }, orderBy: { id: 'asc' } });
  if (!sample || sample.projectionKey != null || sample.status !== 'draft' || !bindings.length) registrationError('CONFLICT', '准确样品创建事实未能核对。');
  const createAudit = await tx.auditLog.findUnique({ where: { id: made.createAuditId } });
  const bindingAudits = [];
  for (const id of [...new Set<string>(bindings.map((binding: any) => binding.evidenceAuditId))].sort()) {
    const audit = await tx.auditLog.findUnique({ where: { id } });
    if (!audit) registrationError('CONFLICT', '准确样品绑定审计缺失。');
    bindingAudits.push({ id, hash: registrationDigest(audit) });
  }
  const originalSample = exactJsonValue(made.sample), sourceBindings = exactJsonValue(bindings);
  const acknowledgement = { registrationVersion: 2, operation: OPERATION, actorId: actor.userId, requestKey: key, commandHash, receiptAuditId: receiptId, sampleId,
    originalSample, originalSampleHash: registrationDigest(originalSample), sourceBindings, sourceBindingsHash: registrationDigest(sourceBindings),
    auditProof: { create: { id: made.createAuditId, hash: registrationDigest(createAudit) }, bindings: bindingAudits } };
  await tx.auditLog.create({ data: { id: receiptId, actorId: actor.userId, action: RECEIPT_ACTION, targetType: 'Sample', targetId: sampleId,
    detail: { source: SOURCE, after: { command, commandHash, ack: acknowledgement, ackHash: registrationDigest(acknowledgement) } },
    operationType: 'create', transactionId: receiptId, ip: ip ?? null } });
  const checked = await replay(tx, actor, key, await tx.auditLog.findUnique({ where: { id: receiptId } }), input);
  const after = await sourceGraph(tx, input);
  const final = await authorizeRegistrationCase(tx, actor, input.sourceCaseId, 'write');
  if (after.signature !== current.signature || String(final.development.updatedAt) !== input.expectedCaseUpdatedAt
    || registrationDigest(registrationCaseContent(final.development)) !== input.expectedCaseContentFingerprint) registrationError('DEVELOPMENT_SOURCE_CHANGED', '登记提交前来源已变化，请核对原请求。');
  if (input.origin) await loadSampleOriginCommand(tx, input.sourceCaseId, input.origin);
  else await loadSealSampleOriginCommand(tx, input.sourceCaseId, input.sealOrigin);
  await assertSourceFactoriesLive(tx, after);
  return { ...checked, replayed: false };
}
function failure(error: unknown) {
  logger.error('[sample-registration-command] failed', { error });
  const safe = safeRouteError(error, { fallbackCode: 'SAMPLE_REGISTRATION_FAILED', fallbackMessage: '样品登记结果暂时无法确认，请保留原请求并核对回执后重试。' });
  return { ok: false as const, error: { code: safe.code, message: safe.message, status: safe.status } };
}
export async function registerSampleCommand(params: { prisma: any; actor: TokenPayload | null | undefined; input: unknown; ip?: string | null }) {
  try {
    if (!params.actor?.userId) registrationError('UNAUTHORIZED', '请登录后登记准确样品来源。');
    const { key, input } = parse(params.input);
    const data = await params.prisma.$transaction((tx: any) => createInTx(tx, params.actor!, key, input, params.ip), { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    return { ok: true as const, data };
  } catch (error) { return failure(error); }
}
export async function recoverSampleRegistration(params: { prisma: any; actor: TokenPayload | null | undefined; requestKey: unknown }) {
  try {
    const key = requestKey(params.requestKey);
    const data = await params.prisma.$transaction(async (tx: any) => {
      const actor = await currentRegistrationActor(tx, params.actor, 'read'); const { receiptId, sampleId } = identity(actor.userId, key);
      const prior = await tx.auditLog.findUnique({ where: { id: receiptId } });
      if (!prior) {
        if ((await traces(tx, actor.userId, key, receiptId)).length || await tx.sample.findUnique({ where: { id: sampleId } })
          || (await tx.sampleSource.findMany({ where: { sampleId } })).length) registrationError('CONFLICT', '原请求有历史事实但回执缺失，请联系管理员核对，不能重新登记。');
        return { ...SAMPLE_REGISTRATION_PROTOCOL, requestKey: key, state: 'not_confirmed' as const, retryOriginalRequest: true };
      }
      return { ...await replay(tx, actor, key, prior), state: 'committed' as const };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    return { ok: true as const, data };
  } catch (error) { return failure(error); }
}
