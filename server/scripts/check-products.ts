import { PrismaClient } from '@prisma/client';
(async () => {
  const prisma = new PrismaClient();
  // ProductAsset has a `type` enum
  const products = await prisma.productAsset.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, type: true },
  });
  const groups: Record<string, string[]> = {};
  for (const p of products) {
    groups[p.type] = groups[p.type] || [];
    groups[p.type].push(p.name);
  }
  for (const [t, names] of Object.entries(groups)) {
    console.log(t + ' (' + names.length + '):');
    for (const n of names) console.log('  - ' + n);
  }
  await prisma.$disconnect();
})();
