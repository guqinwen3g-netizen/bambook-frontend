import { Prisma } from '@prisma/client';

export type SampleBusinessLine = 'fabric' | 'garment';
export type SampleBusinessContext = {
  status: 'resolved' | 'unresolved' | 'conflict';
  businessLine: SampleBusinessLine | null;
  reasons: string[];
};
export type SampleBusinessSource = {
  sourceCaseId?: string | null;
  sourceOrderId?: string | null;
  productAssetId?: string | null;
};

const idOf = (value: unknown) => String(value ?? '').trim();
const distinct = (values: unknown[]) => [...new Set(values.map(idOf).filter(Boolean))].sort();
const lineOf = (value: unknown): SampleBusinessLine | null => {
  const valueText = idOf(value).toLowerCase();
  return valueText === 'fabric' || valueText === 'garment' ? valueText : null;
};
const live = (row: any) => row && row.deletedAt == null;

/** Source parents precede the Sample row lock. Callers must re-read the sample
 * and reject changed source IDs after taking its lock. No classification is
 * inferred from sample stage, subtype, a name, or a client-supplied lane. */
export async function lockSampleBusinessSources(tx: any, samples: SampleBusinessSource[]): Promise<void> {
  const cases = distinct(samples.map(sample => sample.sourceCaseId));
  const orders = distinct(samples.map(sample => sample.sourceOrderId));
  const assets = distinct(samples.map(sample => sample.productAssetId));
  for (const id of cases) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id" = ${id} FOR UPDATE`);
  for (const id of orders) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id" = ${id} FOR UPDATE`);
  for (const id of assets) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ProductAsset" WHERE "id" = ${id} FOR UPDATE`);
}

/** At most three batched lookups for the whole page; missing/deleted/unknown
 * references stay visible as unresolved instead of silently choosing a lane. */
export async function resolveSampleBusinessContexts(db: any, samples: SampleBusinessSource[]): Promise<SampleBusinessContext[]> {
  const caseIds = distinct(samples.map(sample => sample.sourceCaseId));
  const orderIds = distinct(samples.map(sample => sample.sourceOrderId));
  const assetIds = distinct(samples.map(sample => sample.productAssetId));
  const [cases, orders, assets] = await Promise.all([
    caseIds.length ? db.developmentCase.findMany({ where: { id: { in: caseIds } }, select: { id: true, type: true, deletedAt: true } }) : [],
    orderIds.length ? db.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, businessLine: true, type: true, deletedAt: true } }) : [],
    assetIds.length ? db.productAsset.findMany({ where: { id: { in: assetIds } }, select: {
      id: true, mainCategory: true, deletedAt: true,
      fabricProfile: { select: { id: true, deletedAt: true } },
      garmentProfile: { select: { id: true, deletedAt: true } },
    } }) : [],
  ]);
  const byId = (rows: any[]) => new Map(rows.map(row => [row.id, row]));
  const caseMap = byId(cases), orderMap = byId(orders), assetMap = byId(assets);
  return samples.map(sample => {
    const reasons: string[] = [];
    const lines: SampleBusinessLine[] = [];
    let conflict = false;
    const caseId = idOf(sample.sourceCaseId), orderId = idOf(sample.sourceOrderId), assetId = idOf(sample.productAssetId);
    if (caseId) {
      const row = caseMap.get(caseId);
      if (!live(row)) reasons.push('CASE_MISSING_OR_DELETED');
      else {
        const line = lineOf(row.type);
        if (line) lines.push(line); else reasons.push('CASE_LINE_UNSUPPORTED');
      }
    }
    if (orderId) {
      const row = orderMap.get(orderId);
      if (!live(row)) reasons.push('ORDER_MISSING_OR_DELETED');
      else {
        const declared = lineOf(row.businessLine), typed = lineOf(row.type);
        if (declared && typed && declared !== typed) {
          conflict = true; reasons.push('ORDER_LINE_CONFLICT');
        }
        if (idOf(row.businessLine) && !declared) reasons.push('ORDER_LINE_UNSUPPORTED');
        if (idOf(row.type) && !typed) reasons.push('ORDER_TYPE_UNSUPPORTED');
        if (declared) lines.push(declared);
        if (typed) lines.push(typed);
        if (!declared && !typed && !idOf(row.businessLine) && !idOf(row.type)) reasons.push('ORDER_LINE_UNKNOWN');
      }
    }
    if (assetId) {
      const row = assetMap.get(assetId);
      if (!live(row)) reasons.push('ASSET_MISSING_OR_DELETED');
      else {
        const category = lineOf(row.mainCategory);
        const fabric = live(row.fabricProfile), garment = live(row.garmentProfile);
        if (category) lines.push(category); else reasons.push('ASSET_LINE_UNSUPPORTED');
        if (fabric) lines.push('fabric');
        if (garment) lines.push('garment');
        if (fabric && garment || category === 'fabric' && garment || category === 'garment' && fabric) {
          conflict = true; reasons.push('ASSET_PROFILE_CONFLICT');
        }
      }
    }
    if (!caseId && !orderId && !assetId) reasons.push('NO_AUTHORITATIVE_SOURCE');
    const uniqueLines = [...new Set(lines)];
    if (uniqueLines.length > 1) { conflict = true; reasons.push('SOURCE_LINE_CONFLICT'); }
    if (conflict) return { status: 'conflict', businessLine: null, reasons: [...new Set(reasons)] };
    if (reasons.length || uniqueLines.length !== 1) return { status: 'unresolved', businessLine: null, reasons: [...new Set(reasons)] };
    return { status: 'resolved', businessLine: uniqueLines[0], reasons: [] };
  });
}

export async function resolveSampleBusinessContext(
  db: any, sample: SampleBusinessSource, options: { lockSources?: boolean } = {},
): Promise<SampleBusinessContext> {
  if (options.lockSources) await lockSampleBusinessSources(db, [sample]);
  return (await resolveSampleBusinessContexts(db, [sample]))[0];
}

/** A consistency check, never production-release or approval authorization. */
export function assertSampleBusinessContext(context: SampleBusinessContext, allowUnresolved = false): void {
  if (context.status === 'conflict') throw Object.assign(new Error('样品的开发案、订单或产品档案业务线冲突，请先核对来源，不能继续操作。'), { code: 'SAMPLE_BUSINESS_CONFLICT', statusCode: 409 });
  if (!allowUnresolved && context.status !== 'resolved') throw Object.assign(new Error('样品业务线尚未确认，请先核对有效来源，不能继续业务操作。'), { code: 'SAMPLE_BUSINESS_UNRESOLVED', statusCode: 409 });
}
