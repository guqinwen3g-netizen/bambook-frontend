import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { createPermissionService, hasScope } from '../auth/permissionService';
import { buildOrderListScopeWhere } from '../orders/orderService';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { PRIVATE_FILES_DIR } from '../lib/privateFiles';
import { createCostEvidenceFiles, inspectCostEvidenceFile } from '../development/developmentCostEvidenceFiles';
import { allReviewEvidenceIds, calculateOrderCostReview, loadOrderCostSources, parseOrderCostReviewInput, reviewHash, reviewJson, reviewReject, reviewText, type ConfirmOrderCostReviewInput, type OrderCostReviewInput } from './orderCostReviewSource';
export { type OrderCostReviewInput, type ConfirmOrderCostReviewInput } from './orderCostReviewSource';

const TX = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000 };
export function isOrderCostReviewConcurrencyConflict(error: any): boolean {
  return error?.code === 'P2002' || error?.code === 'P2034' || error?.code === 'P2010' && String(error?.meta?.code) === '40001';
}
export function createOrderCostReviewFiles(root = path.join(PRIVATE_FILES_DIR, 'order-cost-review-evidence')) { return createCostEvidenceFiles(root); }
export type OrderCostReviewFiles = ReturnType<typeof createOrderCostReviewFiles>;
export type OrderCostReviewCurrent = {
  status: 'pending' | 'stale'; pendingReasons: string[]; reviewId?: string; reviewRevision?: number; sourceFingerprint?: string;
} | {
  status: 'complete'; pendingReasons: string[]; actualCostCny: number; actualRevenueCny: number;
  actualBreakdown: ReturnType<typeof calculateOrderCostReview>['actualBreakdown']; scopeSnapshot: ReturnType<typeof calculateOrderCostReview>['scopeSnapshot'];
  reviewId: string; reviewRevision: number; sourceFingerprint: string; confirmedBy: string; confirmedAt: string;
};
function publicEvidence(row: any) { const { storageKey, requestKey, requestFingerprint, ...dto } = row; return reviewJson(dto); }
function canReadCost(actor: TokenPayload) { return actor.permissions.includes('pricing:read') && actor.permissions.includes('sensitive:cost') && hasScope(actor, 'pricing:read') && hasScope(actor, 'sensitive:cost'); }
async function requestRetirement(db: any, orderId: string, actorId: string, requestKey: string) {
  const row = await db.auditLog.findUnique({ where: { id: `OCRR_${requestKey}` } });
  if (!row) return null;
  const fact = row.detail?.after;
  let command: ConfirmOrderCostReviewInput;
  try { command = parseOrderCostReviewInput(fact?.command, true) as ConfirmOrderCostReviewInput; }
  catch { reviewReject('COST_REVIEW_FACT_INVALID', '原请求结束记录与核对依据不一致'); }
  if (row.actorId !== actorId || row.action !== 'order_cost_review_request_retire' || row.targetType !== 'OrderCostReviewRequest'
      || row.targetId !== requestKey || row.detail?.source !== 'order-cost-review' || fact?.orderId !== orderId
      || fact.actorId !== actorId || fact.status !== 'Retired' || fact.requestId !== command!.requestId
      || fact.requestKey !== reviewHash({ orderId, actorId, requestId: command!.requestId })
      || fact.requestKey !== requestKey || fact.requestFingerprint !== reviewHash(command!)) {
    reviewReject('COST_REVIEW_FACT_INVALID', '原请求结束记录与核对依据不一致');
  }
  return { kind: 'Retired' as const, ...fact, command: command!, auditId: row.id, createdAt: row.createdAt };
}
function publicReview(row: any, visible = true) { return reviewJson({ ...row, actualCostCny: visible ? Number(row.actualCostCny) : null, actualRevenueCny: visible ? Number(row.actualRevenueCny) : null, linesSnapshot: { ...row.linesSnapshot, actualBreakdown: visible ? row.linesSnapshot.actualBreakdown : null } }); }
function auditFact(row: any, kind: 'review' | 'evidence') {
  return kind === 'review'
    ? { id: row.id, orderId: row.orderId, revision: row.revision, actorId: row.confirmedBy, requestFingerprint: row.requestFingerprint, sourceFingerprint: row.sourceFingerprint, actualCostCny: String(row.actualCostCny), actualRevenueCny: String(row.actualRevenueCny), billBindings: row.linesSnapshot?.input?.bills }
    : { id: row.id, orderId: row.orderId, actorId: row.createdBy, requestFingerprint: row.requestFingerprint, sha256: row.sha256, byteSize: row.byteSize, mimeType: row.mimeType };
}
async function assertFactAudit(db: any, row: any, kind: 'review' | 'evidence') {
  const audit = await db.auditLog.findUnique({ where: { id: row.auditId } });
  if (!audit || audit.actorId !== (kind === 'review' ? row.confirmedBy : row.createdBy) || audit.action !== (kind === 'review' ? 'order_cost_review_confirm' : 'order_cost_review_evidence_add') || audit.targetType !== (kind === 'review' ? 'OrderCostReview' : 'OrderCostReviewEvidence') || audit.targetId !== row.id || reviewHash(audit.detail?.after) !== reviewHash(auditFact(row, kind))) reviewReject('COST_REVIEW_FACT_INVALID', '核对事实与必需审计不一致，请核查原记录');
  if (kind === 'evidence' && row.requestFingerprint !== reviewHash({ originalName: row.originalName, mimeType: row.mimeType, byteSize: row.byteSize, sha256: row.sha256, note: row.note })) reviewReject('COST_REVIEW_FACT_INVALID', '附件内容或说明与原核对依据不一致');
  if (kind === 'review' && row.requestFingerprint !== reviewHash({ ...row.linesSnapshot?.input, ...row.linesSnapshot?.request })) reviewReject('COST_REVIEW_FACT_INVALID', '历史核对请求与审计依据不一致');
}
/** Fresh, explicit dual DB grant AND trusted credential ceiling. No legacy or role-name grants. */
export async function authorizeOrderCostReview(db: any, supplied: TokenPayload | null | undefined, mode: 'read' | 'write', orderId?: string, options: { fresh?: boolean } = {}): Promise<TokenPayload> {
  if (!supplied?.userId) reviewReject('UNAUTHORIZED', '请先登录');
  if (!await db.userAccount.findFirst({ where: { id: supplied.userId, status: 'active', deletedAt: null }, select: { id: true } })) reviewReject('FORBIDDEN', '当前账号已失效，无权操作订单成本核对');
  const current = await createPermissionService({ prisma: db }).getUserPermissionContext(supplied.userId);
  if (!current) reviewReject('FORBIDDEN', '当前账号无权操作订单成本核对');
  const actor: TokenPayload = { userId: current.userId, roles: current.legacyRoleCodes, roleIds: current.roleIds, permissions: current.scopes, departmentIds: current.departmentIds, authorizationLoaded: true, ...(supplied.permissionCeiling ? { permissionCeiling: [...supplied.permissionCeiling] } : {}) };
  const scopes = mode === 'read' ? ['pricing:read', 'sensitive:cost'] as const : ['invoices:write', 'invoices:reconcile'] as const;
  if (scopes.some(scope => !current.scopes.includes(scope) || !hasScope(actor, scope))) reviewReject('FORBIDDEN', '当前权限不足以核对或读取订单成本');
  if (orderId) {
    const scope = await buildOrderListScopeWhere(db, actor, options);
    if (!await db.order.findFirst({ where: { id: orderId, deletedAt: null, ...(mode === 'write' ? { status: { not: 'Cancelled' } } : {}), AND: [scope] }, select: { id: true } })) reviewReject('NOT_FOUND', '订单不存在或无权访问');
  }
  return actor;
}
async function lockOrder(db: any, orderId: string) {
  const rows = await db.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id"=${orderId} AND "deletedAt" IS NULL FOR UPDATE`);
  if (!rows.length) reviewReject('NOT_FOUND', '订单不存在或无权访问');
}
/** Internal settlement sources span two real orders. A permission to read the
 * requested order cannot reveal the other team's source through cost evidence. */
export async function assertOrderCostPeerVisibility(db: any, supplied: TokenPayload, sources: unknown) {
  const ids = (sources as { internalOrderIds?: string[] }).internalOrderIds;
  if (!ids?.length) return;
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id)) reviewReject('COST_REVIEW_FACT_INVALID', '内部成本来源标识已损坏');
  if (!supplied?.userId) reviewReject('UNAUTHORIZED', '请先登录');
  if (!await db.userAccount.findFirst({ where: { id: supplied.userId, status: 'active', deletedAt: null }, select: { id: true } })) reviewReject('FORBIDDEN', '当前账号已失效');
  const context = await createPermissionService({ prisma: db }).getUserPermissionContext(supplied.userId);
  if (!context) reviewReject('FORBIDDEN', '无法核对当前订单可见范围');
  const actor: TokenPayload = { userId: context.userId, roles: context.legacyRoleCodes, roleIds: context.roleIds,
    permissions: context.scopes, departmentIds: context.departmentIds, authorizationLoaded: true,
    ...(supplied.permissionCeiling !== undefined ? { permissionCeiling: [...supplied.permissionCeiling] } : {}) };
  const scope = await buildOrderListScopeWhere(db, actor);
  for (const id of ids) {
    if (!await db.order.findFirst({ where: { id, deletedAt: null, AND: [scope] }, select: { id: true } })) reviewReject('NOT_FOUND', '成本来源不存在或无权访问');
  }
}
async function checkedEvidence(db: any, orderId: string, input: OrderCostReviewInput, files: OrderCostReviewFiles) {
  const wanted = allReviewEvidenceIds(input);
  const evidence = await db.orderCostReviewEvidence.findMany({ where: { orderId, id: { in: wanted } } });
  if (evidence.length !== wanted.length) reviewReject('INVALID_EVIDENCE_SOURCE', '核对附件不存在或不属于本订单');
  for (const row of evidence) { await assertFactAudit(db, row, 'evidence'); await files.read(row); }
  return evidence;
}
/** Internal consumer verifies current sources, immutable audit and real bytes; no stale JSON complete flag. */
export async function readCurrentOrderCostReview(db: any, orderId: string, files = createOrderCostReviewFiles(), actor?: TokenPayload): Promise<OrderCostReviewCurrent> {
  // Old unit adapters/older deployment cannot supply a verified review; never fabricate a complete fact.
  if (!db.orderCostReview) return { status: 'pending' as const, pendingReasons: ['ORDER_COST_REVIEW_UNAVAILABLE'] };
  if (typeof db.$transaction === 'function') return db.$transaction((tx: any) => readCurrentOrderCostReview(tx, orderId, files, actor), TX);
  const row = await db.orderCostReview.findFirst({ where: { orderId }, orderBy: { revision: 'desc' } });
  if (!row) return { status: 'pending' as const, pendingReasons: ['ORDER_COST_REVIEW_MISSING'] };
  await assertFactAudit(db, row, 'review');
  const sources = await loadOrderCostSources(db, orderId);
  if (actor) await assertOrderCostPeerVisibility(db, actor, sources);
  if (row.sourceFingerprint !== reviewHash(sources)) return { status: 'stale' as const, pendingReasons: ['ORDER_COST_REVIEW_SOURCE_CHANGED'], reviewId: row.id, reviewRevision: row.revision, sourceFingerprint: row.sourceFingerprint };
  const input = parseOrderCostReviewInput(row.linesSnapshot?.input) as OrderCostReviewInput;
  if (reviewHash({ ...input, ...row.linesSnapshot?.request }) !== row.requestFingerprint) reviewReject('COST_REVIEW_FACT_INVALID', '核对请求与不可覆盖的审计依据不一致');
  const evidence = await checkedEvidence(db, orderId, input, files);
  const calculated = calculateOrderCostReview(sources, input, new Set(evidence.map((item: any) => item.id)));
  const storedEvidence = evidence.map((item: any) => ({ id: item.id, auditId: item.auditId, sha256: item.sha256, byteSize: item.byteSize })).sort((a: any, b: any) => a.id.localeCompare(b.id));
  if (reviewHash(row.evidenceSnapshot) !== reviewHash(storedEvidence) || reviewHash(row.scopeSnapshot) !== reviewHash(calculated.scopeSnapshot) || reviewHash(row.coverageSnapshot) !== reviewHash(input.coverage) || calculated.status !== 'complete' || String(row.actualCostCny) !== String(calculated.actualCostCny) || String(row.actualRevenueCny) !== String(calculated.actualRevenueCny) || reviewHash(row.linesSnapshot?.actualBreakdown) !== reviewHash(calculated.actualBreakdown)) reviewReject('COST_REVIEW_FACT_INVALID', '核对记录的范围或金额与真实来源不一致');
  for (const row of sources.costEvidence) await createCostEvidenceFiles().read(row);
  return { ...calculated, status: 'complete' as const, actualCostCny: calculated.actualCostCny!, actualRevenueCny: calculated.actualRevenueCny!, reviewId: row.id, reviewRevision: row.revision, sourceFingerprint: row.sourceFingerprint, confirmedBy: row.confirmedBy, confirmedAt: String(row.confirmedAt) };
}

export function createOrderCostReviewService(prisma: any, files = createOrderCostReviewFiles()) {
  async function transact<T>(work: (tx: any) => Promise<T>): Promise<T> {
    try { return await prisma.$transaction(work, TX); }
    catch (error) { if (isOrderCostReviewConcurrencyConflict(error)) reviewReject('COST_REVIEW_CONCURRENT_CHANGE', '核对来源或版本并发变化，请使用原请求刷新后重试'); throw error; }
  }
  async function list(actor: TokenPayload, orderId: string) {
    return transact(async tx => {
      await authorizeOrderCostReview(tx, actor, 'read', orderId);
      const sources = await loadOrderCostSources(tx, orderId);
      await assertOrderCostPeerVisibility(tx, actor, sources);
      const history = await tx.orderCostReview.findMany({ where: { orderId }, orderBy: { revision: 'desc' } });
      const evidence = await tx.orderCostReviewEvidence.findMany({ where: { orderId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      for (const row of history) await assertFactAudit(tx, row, 'review');
      for (const row of evidence) await assertFactAudit(tx, row, 'evidence');
      const current = await readCurrentOrderCostReview(tx, orderId, files, actor);
      // Never expose file paths/keys or raw unrelated audit details.
      const safeSources = { ...sources, receiptAudits: sources.receiptAudits.map((row: any) => ({ id: row.id, action: row.action, targetId: row.targetId, detail: row.detail })), costEvidence: sources.costEvidence.map(publicEvidence) };
      return reviewJson({ orderId, sourceFingerprint: reviewHash(sources), currentRevision: history[0]?.revision ?? 0, sources: safeSources, current, history: history.map((row: any) => ({ id: row.id, revision: row.revision, sourceFingerprint: row.sourceFingerprint, requestKey: row.requestKey, requestFingerprint: row.requestFingerprint, command: { ...row.linesSnapshot?.input, ...row.linesSnapshot?.request }, scopeSnapshot: row.scopeSnapshot, actualCostCny: Number(row.actualCostCny), actualRevenueCny: Number(row.actualRevenueCny), confirmedBy: row.confirmedBy, confirmedAt: row.confirmedAt, supersedesId: row.supersedesId, auditId: row.auditId })), evidence: evidence.map(publicEvidence) });
    });
  }
  async function preview(actor: TokenPayload, orderId: string, raw: unknown) {
    const input = parseOrderCostReviewInput(raw) as OrderCostReviewInput;
    return transact(async tx => {
      const current = await authorizeOrderCostReview(tx, actor, 'write', orderId);
      const sources = await loadOrderCostSources(tx, orderId); await assertOrderCostPeerVisibility(tx, current, sources); const evidence = await checkedEvidence(tx, orderId, input, files);
      for (const row of sources.costEvidence) await createCostEvidenceFiles().read(row);
      const result = calculateOrderCostReview(sources, input, new Set(evidence.map((row: any) => row.id)));
      return canReadCost(current) ? result : { status: result.status, pendingReasons: result.pendingReasons, actualCostCny: null, actualRevenueCny: null, actualBreakdown: null };
    });
  }
  async function confirm(actor: TokenPayload, orderId: string, raw: unknown, ip?: string) {
    const parsed = parseOrderCostReviewInput(raw, true) as ConfirmOrderCostReviewInput;
    const { requestId, expectedRevision, note, ...input } = parsed;
    const requestKey = reviewHash({ orderId, actorId: actor.userId, requestId });
    const requestFingerprint = reviewHash(parsed);
    return transact(async tx => {
      const current = await authorizeOrderCostReview(tx, actor, 'write', orderId); await lockOrder(tx, orderId);
      await authorizeOrderCostReview(tx, actor, 'write', orderId);
      const prior = await tx.orderCostReview.findUnique({ where: { requestKey } });
      const retired = await requestRetirement(tx, orderId, current.userId, requestKey);
      if (retired) {
        if (prior) reviewReject('COST_REVIEW_FACT_INVALID', '原请求同时存在确认与结束记录，请核查记录');
        if (retired.requestFingerprint !== requestFingerprint) reviewReject('REQUEST_CONFLICT', '原请求已结束，不能更改原内容');
        reviewReject('COST_REVIEW_REQUEST_RETIRED', '原请求已结束，请重新核对来源后发起新确认');
      }
      if (prior) {
        if (prior.requestFingerprint !== requestFingerprint) reviewReject('REQUEST_CONFLICT', '原请求已确认其他内容，不能篡参重放');
        await assertFactAudit(tx, prior, 'review');
        await assertOrderCostPeerVisibility(tx, current, await loadOrderCostSources(tx, orderId));
        return { item: publicReview(prior, canReadCost(current)), replayed: true };
      }
      const latest = await tx.orderCostReview.findFirst({ where: { orderId }, orderBy: { revision: 'desc' } });
      if ((latest?.revision ?? 0) !== expectedRevision) reviewReject('REVIEW_VERSION_CHANGED', '核对版本已变化，请刷新后重试');
      const sources = await loadOrderCostSources(tx, orderId); await assertOrderCostPeerVisibility(tx, current, sources); const evidence = await checkedEvidence(tx, orderId, input, files);
      for (const row of sources.costEvidence) await createCostEvidenceFiles().read(row);
      const calculated = calculateOrderCostReview(sources, input, new Set(evidence.map((row: any) => row.id)));
      if (calculated.status !== 'complete') reviewReject('COST_REVIEW_INCOMPLETE', `成本或收入范围尚未核齐：${calculated.pendingReasons.join('；')}`);
      const now = BigInt(Date.now()); const id = `OCR_${randomUUID()}`;
      const data = { id, orderId, revision: expectedRevision + 1, requestKey, requestFingerprint, sourceFingerprint: input.sourceFingerprint, scopeSnapshot: calculated.scopeSnapshot, linesSnapshot: { input, actualBreakdown: calculated.actualBreakdown, request: { expectedRevision, requestId, note } }, coverageSnapshot: input.coverage, evidenceSnapshot: evidence.map((row: any) => ({ id: row.id, auditId: row.auditId, sha256: row.sha256, byteSize: row.byteSize })).sort((a: any, b: any) => a.id.localeCompare(b.id)), actualCostCny: new Prisma.Decimal(calculated.actualCostCny!), actualRevenueCny: new Prisma.Decimal(calculated.actualRevenueCny!), confirmedBy: current.userId, confirmedAt: now, supersedesId: latest?.id ?? null };
      const auditId = await writeRouteAuditLog({ prisma: tx, actorId: current.userId, source: 'order-cost-review', operation: 'order_cost_review_confirm', targetType: 'OrderCostReview', targetId: id, after: auditFact(data, 'review'), note, ip });
      const row = await tx.orderCostReview.create({ data: { ...reviewJson(data), confirmedAt: now, actualCostCny: data.actualCostCny, actualRevenueCny: data.actualRevenueCny, auditId } });
      return { item: publicReview(row, canReadCost(current)), replayed: false };
    });
  }
  /** Definitively end an uncommitted command under the same lock as confirm.
   * Existing confirmations return their original receipt and are never undone. */
  async function retire(actor: TokenPayload, orderId: string, raw: unknown, ip?: string) {
    const command = parseOrderCostReviewInput(raw, true) as ConfirmOrderCostReviewInput;
    const requestKey = reviewHash({ orderId, actorId: actor.userId, requestId: command.requestId });
    const requestFingerprint = reviewHash(command);
    return transact(async tx => {
      const current = await authorizeOrderCostReview(tx, actor, 'write', orderId); await lockOrder(tx, orderId);
      await authorizeOrderCostReview(tx, actor, 'write', orderId);
      const prior = await tx.orderCostReview.findUnique({ where: { requestKey } });
      const retired = await requestRetirement(tx, orderId, current.userId, requestKey);
      if (prior) {
        if (retired) reviewReject('COST_REVIEW_FACT_INVALID', '原请求同时存在确认与结束记录，请核查记录');
        if (prior.requestFingerprint !== requestFingerprint) reviewReject('REQUEST_CONFLICT', '原请求已确认其他内容，不能篡参结束');
        await assertFactAudit(tx, prior, 'review');
        await assertOrderCostPeerVisibility(tx, current, await loadOrderCostSources(tx, orderId));
        return { kind: 'Confirmed' as const, item: publicReview(prior, canReadCost(current)), requestId: command.requestId, requestKey, requestFingerprint, replayed: true };
      }
      if (retired) {
        if (retired.requestFingerprint !== requestFingerprint) reviewReject('REQUEST_CONFLICT', '原请求已结束其他内容，不能篡参重放');
        return reviewJson({ ...retired, replayed: true });
      }
      const after = { orderId, actorId: current.userId, requestId: command.requestId, requestKey, requestFingerprint, status: 'Retired', command };
      await tx.auditLog.create({ data: { id: `OCRR_${requestKey}`, actorId: current.userId, action: 'order_cost_review_request_retire', targetType: 'OrderCostReviewRequest', targetId: requestKey, detail: reviewJson({ source: 'order-cost-review', after }), ip: ip ?? null, operationType: 'transition' } });
      return reviewJson({ ...(await requestRetirement(tx, orderId, current.userId, requestKey)), replayed: false });
    });
  }
  async function addEvidence(actor: TokenPayload, orderId: string, input: { bytes: Buffer; originalName: string; requestId: string; note: string }, ip?: string) {
    const requestId = reviewText(input.requestId, '请求标识', 200), note = reviewText(input.note, '凭据说明');
    const metadata = inspectCostEvidenceFile(input.bytes, input.originalName);
    const requestKey = reviewHash({ orderId, actorId: actor.userId, requestId }); const requestFingerprint = reviewHash({ ...metadata, note });
    let storedKey: string | undefined;
    try { return await transact(async tx => {
      const current = await authorizeOrderCostReview(tx, actor, 'write', orderId); await lockOrder(tx, orderId);
      const prior = await tx.orderCostReviewEvidence.findUnique({ where: { requestKey } });
      if (prior) { if (prior.requestFingerprint !== requestFingerprint) reviewReject('REQUEST_CONFLICT', '原请求已保存其他凭据'); await assertFactAudit(tx, prior, 'evidence'); await files.read(prior); return { evidence: { ...publicEvidence(prior), requestId, requestKey, requestFingerprint }, replayed: true }; }
      const stored = await files.put(input.bytes, input.originalName); storedKey = stored.storageKey;
      const data = { id: `OCRE_${randomUUID()}`, orderId, requestKey, requestFingerprint, ...stored, note, createdBy: current.userId, createdAt: BigInt(Date.now()) };
      const auditId = await writeRouteAuditLog({ prisma: tx, actorId: current.userId, source: 'order-cost-review', operation: 'order_cost_review_evidence_add', targetType: 'OrderCostReviewEvidence', targetId: data.id, after: auditFact(data, 'evidence'), ip });
      const row = await tx.orderCostReviewEvidence.create({ data: { ...data, auditId } }); return { evidence: { ...publicEvidence(row), requestId, requestKey, requestFingerprint }, replayed: false };
    }); } catch (error) {
      if (storedKey) {
        // Uncertain commit outcomes preserve a possibly referenced file, like existing cost evidence.
        try { if (!await prisma.orderCostReviewEvidence.findUnique({ where: { storageKey: storedKey } })) await files.removeUnreferenced(storedKey); } catch { /* preserve for reconciliation */ }
      }
      throw error;
    }
  }
  async function download(actor: TokenPayload, orderId: string, id: string) {
    const row = await transact(async tx => {
      await authorizeOrderCostReview(tx, actor, 'read', orderId);
      const row = await tx.orderCostReviewEvidence.findFirst({ where: { id, orderId } });
      if (!row) reviewReject('NOT_FOUND', '附件不存在或无权访问');
      await assertFactAudit(tx, row, 'evidence'); return row;
    });
    return { evidence: publicEvidence(row), bytes: await files.read(row) };
  }
  return { list, preview, confirm, retire, addEvidence, download };
}
