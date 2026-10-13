/**
 * Remove the legacy hand-rolled demo EntityLinks (DEMO-LINK-* ids) that
 * predate the canonical syncOrderEntityReferences / syncDevelopmentCaseReferences
 * helpers. The canonical helpers have already backfilled the proper LINK__*
 * rows with the right linkKinds (orderedBy / suppliedBy / shipsTo / billTo).
 *
 * Hard delete (not soft delete) — these are duplicates we never want to see again.
 */
import { PrismaClient } from '@prisma/client';

(async () => {
  const prisma = new PrismaClient();

  const before = await (prisma as any).entityLink.count();
  console.log('EntityLinks before cleanup: ' + before);

  // Identify rows that use the legacy hand-rolled id scheme.
  const legacy = await (prisma as any).entityLink.findMany({
    where: { id: { startsWith: 'DEMO-LINK-' } },
    select: { id: true, linkKind: true, fromType: true, toType: true },
  });
  console.log('Legacy DEMO-LINK-* rows: ' + legacy.length);
  const byKind: Record<string, number> = {};
  for (const r of legacy) byKind[r.linkKind] = (byKind[r.linkKind] || 0) + 1;
  for (const [k, v] of Object.entries(byKind)) console.log('  kind=' + k + ' count=' + v);

  const result = await (prisma as any).entityLink.deleteMany({
    where: { id: { startsWith: 'DEMO-LINK-' } },
  });
  console.log('Deleted ' + result.count + ' legacy rows');

  const after = await (prisma as any).entityLink.count();
  console.log('EntityLinks after cleanup: ' + after);

  // Verify canonical coverage is intact
  const canonByKind = await (prisma as any).entityLink.groupBy({
    by: ['linkKind'],
    where: { deletedAt: null, status: 'active' },
    _count: { id: true },
  });
  console.log('\nCanonical linkKind distribution:');
  for (const g of canonByKind) console.log('  ' + g.linkKind + ': ' + g._count.id);

  await prisma.$disconnect();
})();
