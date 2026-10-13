import { PrismaClient } from '@prisma/client';
(async () => {
  const prisma = new PrismaClient();
  const contacts = await prisma.relation.findMany({
    where: { deletedAt: null, type: 'contact' },
    select: { id: true, name: true, parentId: true, reportsToId: true, isOrganization: true, role: true, department: true },
    take: 5,
  });
  console.log('Sample contacts:');
  for (const c of contacts) console.log(JSON.stringify(c));

  const total = await prisma.relation.count({ where: { deletedAt: null, type: 'contact' } });
  const withParent = await prisma.relation.count({ where: { deletedAt: null, type: 'contact', parentId: { not: null } } });
  const withReportsTo = await prisma.relation.count({ where: { deletedAt: null, type: 'contact', reportsToId: { not: null } } });
  console.log('Total contacts: ' + total + ', withParent: ' + withParent + ', withReportsTo: ' + withReportsTo);

  await prisma.$disconnect();
})();
