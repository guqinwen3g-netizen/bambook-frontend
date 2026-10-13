import { PrismaClient } from '@prisma/client';

(async () => {
  const prisma = new PrismaClient();

  console.log('=== EntityLink graph verification ===');
  const total = await (prisma as any).entityLink.count({ where: { deletedAt: null, status: 'active' } });
  console.log(`Total active links: ${total}`);

  const byFromType = await (prisma as any).entityLink.groupBy({
    by: ['fromType'],
    where: { deletedAt: null, status: 'active' },
    _count: { id: true },
  });
  console.log('\nLinks by fromType:');
  for (const g of byFromType) console.log(`  ${g.fromType}: ${g._count.id}`);

  const byKind = await (prisma as any).entityLink.groupBy({
    by: ['linkKind'],
    where: { deletedAt: null, status: 'active' },
    _count: { id: true },
  });
  console.log('\nLinks by linkKind:');
  for (const g of byKind) console.log(`  ${g.linkKind}: ${g._count.id}`);

  console.log('\n=== Dev case relationship check ===');
  const dev = await prisma.developmentCase.findFirst({ where: { deletedAt: null } });
  if (dev) {
    const links = await (prisma as any).entityLink.findMany({
      where: { fromType: 'development-case', fromId: dev.id, status: 'active', deletedAt: null },
    });
    console.log(`Dev case ${dev.code} (id=${dev.id}) has ${links.length} outgoing links:`);
    for (const l of links) console.log(`  ${l.linkKind} -> ${l.toType}::${l.toId}`);
  }

  await prisma.$disconnect();
})();
