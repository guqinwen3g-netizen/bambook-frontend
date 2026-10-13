/**
 * Backfill EntityReference rows for existing demo orders + dev cases.
 * The seed script only created EntityLink rows; references are needed for
 * snapshot-driven one-click autofill.
 */
import { PrismaClient } from '@prisma/client';
import { syncOrderEntityReferences, syncDevelopmentCaseReferences } from '../src/entities/sync';

(async () => {
  const prisma = new PrismaClient();

  console.log('=== Backfilling EntityReferences ===\n');

  // 1. Orders
  const orders = await prisma.order.findMany({ where: { deletedAt: null } });
  console.log('Found ' + orders.length + ' orders');
  for (const o of orders) {
    await syncOrderEntityReferences(prisma, o as any, { source: 'backfill' });
  }
  const orderRefCount = await (prisma as any).entityReference.count({
    where: { ownerType: 'order', deletedAt: null, status: 'active' },
  });
  console.log('  Order references after backfill: ' + orderRefCount);

  // 2. Dev cases
  const cases = await prisma.developmentCase.findMany({ where: { deletedAt: null } });
  console.log('\nFound ' + cases.length + ' development cases');
  for (const c of cases) {
    await syncDevelopmentCaseReferences(prisma, c as any, { source: 'backfill' });
  }
  const devRefCount = await (prisma as any).entityReference.count({
    where: { ownerType: 'development-case', deletedAt: null, status: 'active' },
  });
  console.log('  Dev-case references after backfill: ' + devRefCount);

  // 3. Final summary
  const totalRefs = await (prisma as any).entityReference.count({
    where: { deletedAt: null, status: 'active' },
  });
  const totalLinks = await (prisma as any).entityLink.count({
    where: { deletedAt: null, status: 'active' },
  });
  console.log('\n=== Summary ===');
  console.log('Total active EntityReferences: ' + totalRefs);
  console.log('Total active EntityLinks: ' + totalLinks);

  await prisma.$disconnect();
})();
