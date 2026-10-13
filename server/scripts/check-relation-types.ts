import { PrismaClient } from '@prisma/client';
(async () => {
  const prisma = new PrismaClient();
  const all = await prisma.relation.groupBy({
    by: ['type'],
    where: { deletedAt: null },
    _count: { id: true },
  });
  for (const g of all) console.log(g.type + ': ' + g._count.id);

  const allCat = await prisma.relation.groupBy({
    by: ['category'],
    where: { deletedAt: null },
    _count: { id: true },
  });
  console.log('\nBy category:');
  for (const g of allCat) console.log('  ' + g.category + ': ' + g._count.id);

  // Sample non-organization
  const nonOrg = await prisma.relation.findMany({
    where: { deletedAt: null, isOrganization: false },
    select: { id: true, name: true, type: true, category: true, parentId: true, reportsToId: true, role: true },
    take: 5,
  });
  console.log('\nSample non-org rows:');
  for (const r of nonOrg) console.log(JSON.stringify(r));

  await prisma.$disconnect();
})();
