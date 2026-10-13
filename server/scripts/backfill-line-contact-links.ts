/**
 * Backfill orderLine→product and contact→organization links/references
 * that were lost when legacy DEMO-LINK-* rows were removed.
 */
import { PrismaClient } from '@prisma/client';
import {
  syncOrderLineEntityReferences,
  syncRelationEntityReferences,
} from '../src/entities/sync';

(async () => {
  const prisma = new PrismaClient();

  console.log('=== Backfilling OrderLine → Product ===');
  const lines = await prisma.orderLine.findMany({
    where: { materialCode: { not: null } },
  });
  console.log('Lines with materialCode: ' + lines.length);
  let lineCount = 0;
  for (const l of lines) {
    await syncOrderLineEntityReferences(prisma, l as any, { source: 'backfill' });
    lineCount++;
  }
  console.log('  synced ' + lineCount + ' lines');

  console.log('\n=== Backfilling Contact → Organization ===');
  const contacts = await prisma.relation.findMany({
    where: {
      deletedAt: null,
      isOrganization: false,
      parentId: { not: null },
    },
  });
  console.log('Contacts with parent: ' + contacts.length);
  let contactCount = 0;
  for (const c of contacts) {
    await syncRelationEntityReferences(prisma, c as any, { source: 'backfill' });
    contactCount++;
  }
  console.log('  synced ' + contactCount + ' contacts');

  // Final
  const totalLinks = await (prisma as any).entityLink.count({
    where: { deletedAt: null, status: 'active' },
  });
  const totalRefs = await (prisma as any).entityReference.count({
    where: { deletedAt: null, status: 'active' },
  });
  console.log('\n=== Final ===');
  console.log('Total links: ' + totalLinks);
  console.log('Total refs: ' + totalRefs);

  const byKind = await (prisma as any).entityLink.groupBy({
    by: ['linkKind'],
    where: { deletedAt: null, status: 'active' },
    _count: { id: true },
  });
  console.log('linkKind distribution:');
  for (const g of byKind) console.log('  ' + g.linkKind + ': ' + g._count.id);

  await prisma.$disconnect();
})();
