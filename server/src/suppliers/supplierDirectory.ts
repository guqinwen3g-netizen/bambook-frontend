import { Prisma, PrismaClient } from '@prisma/client';
import { isLatinNameSearch, matchesNameSearch } from '../utils/nameSearch';

export function supplierDirectoryItem(relation: any, storedProfile: any) {
  const profile = storedProfile?.deletedAt == null ? storedProfile : null;
  return {
    id: profile?.id || relation.id, relationId: relation.id, relation,
    specialties: [], qualityScore: 0, deliveryScore: 0, totalOrders: 0, totalAmount: 0,
    createdAt: new Date(relation.createdAt).getTime(), updatedAt: Number(relation.lastInteraction || 0),
    ...profile,
    productionProfileId: profile?.id || null,
    productionArchived: !!storedProfile && !profile,
  };
}

export async function listSupplierDirectory(prisma: PrismaClient, query: any) {
  const column = ({quality:'qualityScore',delivery:'deliveryScore',orders:'totalOrders',amount:'totalAmount'} as Record<string,string>)[query.sort] || 'qualityScore';
  const direction = query.order === 'asc' ? 'ASC' : 'DESC';
  const limitValue = Number(query.limit), offsetValue = Number(query.offset);
  const take = Number.isFinite(limitValue) ? Math.min(200, Math.max(1, Math.floor(limitValue))) : 20;
  const offset = Number.isFinite(offsetValue) ? Math.max(0, Math.floor(offsetValue)) : 0;
  const search = String(query.search || '');
  const conditions = [Prisma.sql`r.category = 'Supplier' AND r."isOrganization" = true AND r."deletedAt" IS NULL`];
  if (query.blacklisted !== undefined) {
    const wanted = query.blacklisted === true || query.blacklisted === 'true';
    conditions.push(Prisma.sql`(f."blacklistedAt" IS NOT NULL AND f."deletedAt" IS NULL) = ${wanted}`);
  }
  if (isLatinNameSearch(search)) {
    // Read only names across the filtered directory, before SQL pagination.
    const candidates = await prisma.$queryRaw<{id: string; name: string}[]>(Prisma.sql`
      SELECT r.id, r.name FROM "Relation" r
      LEFT JOIN "FactoryProfile" f ON f."relationId" = r.id
      WHERE ${Prisma.join(conditions, ' AND ')}`);
    const ids = candidates.filter(candidate => matchesNameSearch(candidate.name, search)).map(candidate => candidate.id);
    if (!ids.length) return {items: [], total: 0};
    conditions.push(Prisma.sql`r.id IN (${Prisma.join(ids)})`);
  } else if (search) {
    // strpos treats SQL wildcard characters as literal name characters.
    conditions.push(Prisma.sql`strpos(lower(r.name), lower(${search})) > 0`);
  }
  const where = Prisma.join(conditions, ' AND ');
  const [rows, count] = await Promise.all([
    prisma.$queryRaw<any[]>(Prisma.sql`SELECT to_jsonb(r) AS relation, to_jsonb(f) AS profile
      FROM "Relation" r LEFT JOIN "FactoryProfile" f ON f."relationId" = r.id
      WHERE ${where} ORDER BY CASE WHEN f."deletedAt" IS NULL THEN ${Prisma.raw(`f."${column}"`)} END ${Prisma.raw(direction)} NULLS LAST, r.name ASC, r.id ASC
      LIMIT ${take} OFFSET ${offset}`),
    prisma.$queryRaw<any[]>(Prisma.sql`SELECT count(*)::int AS total FROM "Relation" r LEFT JOIN "FactoryProfile" f ON f."relationId" = r.id WHERE ${where}`),
  ]);
  return {items:rows.map(row=>supplierDirectoryItem(row.relation,row.profile)),total:count[0]?.total || 0};
}
