import { PrismaClient } from '@prisma/client';
import { syncDevelopmentCaseReferences } from '../src/entities/sync';

(async () => {
  const prisma = new PrismaClient();
  const cases = await prisma.developmentCase.findMany({ where: { deletedAt: null } });
  console.log(`Found ${cases.length} development cases`);
  for (const c of cases) {
    await syncDevelopmentCaseReferences(prisma, c as any, { source: 'backfill' });
    console.log(`  synced ${c.code} (${c.id})`);
  }
  const linkCount = await (prisma as any).entityLink.count({
    where: { fromType: 'development-case', deletedAt: null },
  });
  console.log(`development-case EntityLinks: ${linkCount}`);
  await prisma.$disconnect();
})();
