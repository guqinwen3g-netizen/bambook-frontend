import { createHash } from 'node:crypto';
import { canonicalClaimJson } from '../claims/claimApprovalFact';

export function hashMoqBasis(basis: unknown): string {
  return createHash('sha256').update(canonicalClaimJson(basis)).digest('hex');
}

export function actualMoqFamily(document: any): string | undefined {
  const family = String(document.businessLine ?? document.type ?? '').toLowerCase();
  return ['garment','apparel'].includes(family) ? 'garment' : ['fabric','capsule'].includes(family) ? family : undefined;
}

/** Authoritative product hints, never a description guessed to be an asset ID. */
export async function buildActualMoqLines(db: any, lines: any[], family?: string | null) {
  try {
  return await Promise.all(lines.map(async (line: any) => {
    const code = line.materialCode ?? line.fabricCode ?? null;
    let productAssetId: string | null = line.confirmedSourceType === 'Asset' ? line.confirmedSourceId ?? null : null;
    if (!productAssetId && code) {
      const assets = await db.productAsset.findMany({ where: { sku: code, deletedAt: null }, select: { id: true }, take: 2 });
      if (assets.length === 1) productAssetId = assets[0].id;
    }
    return {
      quantity: line.quantity?.toString() ?? null,
      unit: line.unit ?? undefined,
      moqOverride: line.moqOverride ?? null,
      productAssetId,
      businessLine: family ?? (['PC', 'PCS', 'SET'].includes(String(line.unit).toUpperCase()) ? 'garment' : 'fabric'),
      sourceFacts: {
        materialCode: code,
        confirmedSourceType: line.confirmedSourceType ?? null,
        confirmedSourceId: line.confirmedSourceId ?? null,
        specSnapshot: line.specSnapshot ?? null,
      },
    };
  }));

  } catch { throw Object.assign(new Error('MOQ 实际商品来源暂时无法核验'), { code: 'MOQ_SOURCE_UNAVAILABLE' }); }
}

/** Legacy approvals without a verifiable frozen basis never acquire one retroactively. */
export async function findCurrentMoqApproval(db: any, targetType: 'Order' | 'Quotation', targetId: string, check: any, options?: {plannedReference?: any}): Promise<string | null> {
  try {
  if (check.lines.some((line: any) => line.unresolvedReason)) return null;
  const approvals = await db.approvalRequest.findMany({
    where: { targetType, targetId, actionType: targetType === 'Order' ? 'order:moq-exemption' : 'quotation:moq-exemption', status: 'approved' },
    orderBy: { createdAt: 'desc' },
  });
  for (const approval of approvals) {
    const payload = approval.payload;
    if (payload?.moqBasisVersion !== 1 || !payload.moqBasis || payload.moqBasisHash !== check.basisHash
      || hashMoqBasis(payload.moqBasis) !== payload.moqBasisHash) continue;
    // Preserve approval ownership policy; active stored assignee is the fact,
    // never a fresh actor supplied by the caller or an invented writing scope.
    const actorId = approval.bossFinalBypassBy ?? approval.reviewerId;
    const {moqApprovalFingerprint}=await import('../orderChanges/quantityPlanMoqGate');
    const fingerprint=moqApprovalFingerprint(payload);
    if (!actorId || !approval.decidedAt || payload.contentFingerprint !== fingerprint) continue;
    if(payload.plannedQuantityChange){
      const ref=payload.plannedQuantityChange;const cr=await db.orderChangeRequest.findUnique({where:{id:ref.changeRequestId}});
      if(!cr||cr.deletedAt||cr.orderId!==targetId||cr.requesterId!==approval.requesterId||cr.afterDelta?.lineQuantityPlanHash!==ref.lineQuantityPlanHash)continue;
      const originalDecision=await db.approvalRequest.findUnique({where:{id:cr.approvalRequestId}});
      try{const {assertOriginalQuantityDecision,assertPlannedMoqRequestFact}=await import('../orderChanges/quantityPlanMoqGate');await assertOriginalQuantityDecision(db,originalDecision);await assertPlannedMoqRequestFact(db,approval,cr);}catch(e:any){if(e?.code==='CONFLICT')continue;throw e;}
      if(options?.plannedReference){if(cr.status!=='Approved'||canonicalClaimJson(ref)!==canonicalClaimJson(options.plannedReference))continue;}else if(cr.status!=='Applied')continue;
    }
    const audits = await db.auditLog.findMany({ where: { targetType: 'ApprovalRequest', targetId: approval.id } });
    const decisions = audits.filter((audit: any) => { const fact = audit.detail?.approvalDecisionFact; return audit.actorId === actorId && fact?.schemaVersion === 1 && fact.decisionActorId === actorId && fact.status === 'approved' && fact.actionType === approval.actionType && fact.targetType === targetType && fact.targetId === targetId && fact.decidedAt === approval.decidedAt.toISOString() && fact.contentFingerprint === fingerprint; });
    if (decisions.length !== 1) continue;
    if (approval.bossFinalBypassBy) { const { legacyAgentRoleForId } = await import('../auth/permissionService'); const roles = await db.userRole.findMany({ where: { userId: actorId }, select: { roleId: true } }); if (!roles.some((row: any) => legacyAgentRoleForId(row.roleId) === 'owner')) continue; }
    const reviewer = await db.userAccount.findUnique({ where: { id: actorId }, select: { status: true, deletedAt: true } });
    if (reviewer?.status !== 'active' || reviewer.deletedAt != null) continue;
    return approval.id;
  }
  if (targetType === 'Order') {
    const quote = await db.quotation.findFirst({ where: { convertedOrderId: targetId, deletedAt: null }, select: { id: true } });
    if (quote) return findCurrentMoqApproval(db, 'Quotation', quote.id, check);
  }
  return null;

  } catch { throw Object.assign(new Error('MOQ 原批准依据暂时无法核验'), { code: 'MOQ_SOURCE_UNAVAILABLE' }); }
}

export function isMoqExemptionApproval(approval: any): boolean {
  return (approval.targetType === 'Order' && approval.actionType === 'order:moq-exemption')
    || (approval.targetType === 'Quotation' && approval.actionType === 'quotation:moq-exemption');
}

export async function lockMoqApprovalSource(tx: any, approval: any): Promise<void> {
  if (!isMoqExemptionApproval(approval) || approval.status !== 'pending' || !approval.targetId) return;
  const { Prisma } = await import('@prisma/client');
  if (approval.targetType === 'Order') {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "Order" WHERE id = ${approval.targetId} FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "OrderLine" WHERE "orderId" = ${approval.targetId} ORDER BY id FOR UPDATE`);
  } else {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "Quotation" WHERE id = ${approval.targetId} FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "QuotationLine" WHERE "quotationId" = ${approval.targetId} ORDER BY id FOR UPDATE`);
  }
}

export async function lockMoqBasisRows(tx: any, lines: any[], customerRelationId?: string | null): Promise<void> {
  try {
  const { Prisma } = await import('@prisma/client');
  const ids = [...new Set(lines.map(line => line.productAssetId).filter(Boolean))].sort() as string[];
  if (ids.length) {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "ProductAsset" WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "FabricProfile" WHERE "productAssetId" IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "GarmentProfile" WHERE "productAssetId" IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`);
  }
  if (customerRelationId) await tx.$queryRaw(Prisma.sql`SELECT id FROM "Relation" WHERE id = ${customerRelationId} FOR UPDATE`);

  } catch { throw Object.assign(new Error('MOQ 来源暂时无法锁定核验'), { code: 'MOQ_SOURCE_UNAVAILABLE' }); }
}

export async function assertCurrentMoqApproval(tx: any, approval: any): Promise<void> {
  if (!isMoqExemptionApproval(approval)) return;
  const payload = approval.payload;
  if(payload?.plannedQuantityChange){const {assertPlannedMoqApproval}=await import('../orderChanges/quantityPlanMoqGate');return assertPlannedMoqApproval(tx,approval);}
  const fail = () => { throw Object.assign(new Error('MOQ 审批依据已变化或旧审批缺少可验证依据，请核对当前行后重新申请'), { code: 'MOQ_APPROVAL_SOURCE_CHANGED', statusCode: 409, status: 409 }); };
  if (payload?.moqBasisVersion !== 1 || !payload.moqBasis || payload.contentFingerprint !== payload.moqBasisHash || hashMoqBasis(payload.moqBasis) !== payload.moqBasisHash) fail();
  const order = approval.targetType === 'Order';
  const document = order
    ? await tx.order.findUnique({ where: { id: approval.targetId }, include: { lines: { orderBy: { lineNumber: 'asc' } } } })
    : await tx.quotation.findUnique({ where: { id: approval.targetId }, include: { lines: { orderBy: { lineNumber: 'asc' } } } });
  if (!document || document.deletedAt != null) fail();
  const { createMoqConfigService } = await import('./moqConfigService');
  const { createMoqResolutionService } = await import('./moqResolutionService');
  const { createMoqValidationService } = await import('./moqValidationService');
  const { loadUserWithRoles, buildLoadedAuthTokenPayload } = await import('../auth/tokenHelpers');
  const storedUser = await loadUserWithRoles(tx, approval.requesterId);
  if (!storedUser || storedUser.status !== 'active' || storedUser.deletedAt != null) fail();
  const actor = await buildLoadedAuthTokenPayload(tx, storedUser);
  const configService = createMoqConfigService({ prisma: tx });
  const validation = createMoqValidationService({ prisma: tx, configService, resolutionService: createMoqResolutionService({ prisma: tx, configService }) });
  const lines = await buildActualMoqLines(tx, document.lines, order ? actualMoqFamily(document) : undefined);
  await lockMoqBasisRows(tx, lines, document.customerRelationId);
  const check = await validation.validateCreate({
    ...(order ? { type: document.type, businessLine: document.businessLine, capsuleExemption: document.capsuleExemption === true } : {}),
    customerRelationId: document.customerRelationId ?? null,
    snapshot: document.moqSnapshot,
    lines,
  }, { actor });
  if (check.lines.some(line => line.unresolvedReason) || check.basisHash !== payload.moqBasisHash) fail();
}
