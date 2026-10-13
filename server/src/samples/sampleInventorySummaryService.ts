import { Prisma, PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import type { TokenPayload } from '../auth/service';
import { authorizeSampleCustodyBatch, recheckSampleCustodyBatchAuthorization, SampleCustodyAuthorizationError, type SampleCustodyGuard } from './sampleCustodyAuthorization';

export interface SampleInventoryGroup {
  cardType: string;
  unit: string | null;
  inventoryState: 'active' | 'shipped' | 'retired' | 'other';
  /** Decimal strings preserve exact PostgreSQL aggregate integers. */
  cardRows: string;
  quantity: string;
  availableQty: string;
  borrowedQty: string;
}
export interface SampleInventorySummary {
  complete: true;
  snapshotAt: string;
  sampleIds: string[];
  summaries: Array<{ sampleId: string; groups: SampleInventoryGroup[] }>;
}
type Result = { ok: true; data: SampleInventorySummary } | { ok: false; error: { code: string; message: string; status: number } };
const fail = (code: string, message: string, status: number): Result => ({ ok: false, error: { code, message, status } });
const unsignedInteger = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);

/** Read-only physical ledger snapshot, not a Sample approval or business lane.
 * Card material/unit remain separate; terminal ledger rows are never active stock. */
export async function getSampleInventorySummary(prisma: PrismaClient, input: unknown, actor?: TokenPayload | null): Promise<Result> {
  if (!Array.isArray(input) || !input.length || input.length > 200 || input.some(id => typeof id !== 'string' || !id.trim())) {
    return fail('VALIDATION_FAILED', 'sampleIds 须为 1 至 200 个唯一有效样品编号', 400);
  }
  const sampleIds = input.map(id => String(id).trim());
  if (new Set(sampleIds).size !== sampleIds.length) return fail('VALIDATION_FAILED', 'sampleIds 不可重复', 400);
  try {
    const guards: SampleCustodyGuard[] = [];
    const result = await prisma.$transaction(async (tx): Promise<Result> => {
      await authorizeSampleCustodyBatch({ db: tx, actor, subjects: [] });
      const snapshotAt = new Date().toISOString();
      const samples = await tx.sample.findMany({ where: { id: { in: sampleIds }, deletedAt: null }, select: { id: true } });
      if (samples.length !== sampleIds.length) return fail('SAMPLE_NOT_FOUND', '请求的样品不存在、已归档或不可用，不能确认库存为空', 404);
      // A complete summary cannot silently exclude a foreign-parent Card attached
      // to a visible Sample. Qualify every real parent before publishing totals.
      const sampleAccess = await authorizeSampleCustodyBatch({ db: tx, actor,
        subjects: sampleIds.map(id => ({ kind: 'sample' as const, id })) });
      for (const entry of sampleAccess) {
        if (!entry.ok || entry.authorization.visibility !== 'full') return fail('SAMPLE_NOT_FOUND', '请求的样品或完整实物归属不可见，不能确认库存为空', 404);
        guards.push(entry.authorization.guard);
      }
      let cursor: string | undefined;
      for (;;) {
        const cards = await tx.sampleCardItem.findMany({ where: { sampleId: { in: sampleIds }, deletedAt: null },
          select: { id: true }, orderBy: { id: 'asc' }, take: 200,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
        if (!cards.length) break;
        const access = await authorizeSampleCustodyBatch({ db: tx, actor,
          subjects: cards.map(card => ({ kind: 'card' as const, id: card.id })) });
        for (const entry of access) {
          if (!entry.ok || entry.authorization.visibility !== 'full') return fail('SAMPLE_NOT_FOUND', '请求的样品或完整实物归属不可见，不能确认库存为空', 404);
          guards.push(entry.authorization.guard);
        }
        cursor = cards[cards.length - 1].id;
        if (cards.length < 200) break;
      }
      // Aggregate cards before joining loan totals, so multiple loans cannot
      // multiply card quantity. All matching rows stay in PostgreSQL; no take,
      // pagination or large card-ID transport is involved.
      const aggregates = await tx.$queryRaw<Array<SampleInventoryGroup & { sampleId: string; invalidStock?: boolean; invalidBorrow?: boolean }>>(Prisma.sql`
        WITH selected_cards AS (
          SELECT "id", "sampleId", "cardType", "unit", "quantity", "availableQty",
            CASE WHEN "status" IN ('in_stock', 'borrowed') THEN 'active'
              WHEN "status" IN ('shipped', 'retired') THEN "status" ELSE 'other' END AS "inventoryState"
          FROM "SampleCardItem" WHERE "sampleId" IN (${Prisma.join(sampleIds)}) AND "deletedAt" IS NULL
        ), card_totals AS (
          SELECT "sampleId", "cardType", "unit", "inventoryState", COUNT(*)::text AS "cardRows",
            SUM("quantity"::bigint)::text AS "quantity", SUM("availableQty"::bigint)::text AS "availableQty",
            BOOL_OR("quantity" < 0 OR "availableQty" < 0 OR "availableQty" > "quantity") AS "invalidStock"
          FROM selected_cards GROUP BY "sampleId", "cardType", "unit", "inventoryState"
        ), borrow_by_card AS (
          SELECT l."itemId", SUM(l."loanQuantity"::bigint) AS "borrowedQty", BOOL_OR(l."loanQuantity" <= 0) AS "invalidBorrow"
          FROM "SampleCardLoan" l JOIN selected_cards c ON c."id" = l."itemId"
          WHERE l."loanType" = 'borrow' AND l."returnedAt" IS NULL
          GROUP BY l."itemId"
        ), borrow_totals AS (
          SELECT c."sampleId", c."cardType", c."unit", c."inventoryState", SUM(b."borrowedQty")::text AS "borrowedQty",
            BOOL_OR(b."invalidBorrow" OR (c."inventoryState" = 'active' AND b."borrowedQty" + c."availableQty" > c."quantity")) AS "invalidBorrow"
          FROM borrow_by_card b JOIN selected_cards c ON c."id" = b."itemId"
          GROUP BY c."sampleId", c."cardType", c."unit", c."inventoryState"
        )
        SELECT c.*, COALESCE(b."borrowedQty", '0') AS "borrowedQty", COALESCE(b."invalidBorrow", false) AS "invalidBorrow"
        FROM card_totals c LEFT JOIN borrow_totals b ON b."sampleId" = c."sampleId" AND b."cardType" = c."cardType"
          AND b."unit" IS NOT DISTINCT FROM c."unit" AND b."inventoryState" = c."inventoryState"
        ORDER BY c."sampleId", c."cardType", c."unit" NULLS FIRST, c."inventoryState"
      `);
      const groupsBySample = new Map(sampleIds.map(id => [id, [] as SampleInventoryGroup[]]));
      const seen = new Set<string>();
      for (const row of aggregates) {
        const target = groupsBySample.get(row.sampleId);
        const key = JSON.stringify([row.sampleId, row.cardType, row.unit, row.inventoryState]);
        if (!target || seen.has(key) || typeof row.cardType !== 'string' || !(row.unit === null || typeof row.unit === 'string')
          || !['active', 'shipped', 'retired', 'other'].includes(row.inventoryState) || row.invalidStock || row.invalidBorrow
          || ![row.cardRows, row.quantity, row.availableQty, row.borrowedQty].every(unsignedInteger)) throw new Error('Invalid sample inventory aggregate');
        seen.add(key);
        target.push({ cardType: row.cardType, unit: row.unit, inventoryState: row.inventoryState,
          cardRows: row.cardRows, quantity: row.quantity, availableQty: row.availableQty, borrowedQty: row.borrowedQty });
      }
      return { ok: true, data: { complete: true, snapshotAt, sampleIds, summaries: sampleIds.map(sampleId => ({ sampleId, groups: groupsBySample.get(sampleId)! })) } };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5000, timeout: 30000 });
    if (result.ok) {
      // CURRENT root connection after RR; a grant/parent change aborts the whole
      // completeness claim. Kernel batches are bounded, no stale tx is reused.
      for (let offset = 0; offset < guards.length; offset += 10000) {
        await recheckSampleCustodyBatchAuthorization({ currentPrisma: prisma, actor, guards: guards.slice(offset, offset + 10000) });
      }
    }
    return result;
  } catch (error) {
    if (error instanceof SampleCustodyAuthorizationError) return fail(error.code, error.message, error.status);
    logger.error('[sample-inventory-summary] read failed', { error: error instanceof Error ? error.message : 'unknown' });
    return fail('INVENTORY_SUMMARY_UNAVAILABLE', '完整库存汇总暂不可用，请稍后刷新或打开实物明细核对', 500);
  }
}
