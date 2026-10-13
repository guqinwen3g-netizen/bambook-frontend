import { PrismaClient } from '@prisma/client';

(async () => {
  const prisma = new PrismaClient();

  console.log('=== 组织 → 联系人覆盖度 ===');
  const orgs = await prisma.relation.findMany({
    where: { deletedAt: null, type: 'organization' },
    select: { id: true, name: true },
  });
  for (const org of orgs) {
    const contacts = await prisma.relation.count({
      where: { deletedAt: null, type: 'contact', organizationId: org.id },
    });
    const orderCount = await prisma.order.count({
      where: { deletedAt: null, customerRelationId: org.id },
    });
    const supplyOrderCount = await prisma.order.count({
      where: { deletedAt: null, millRelationId: org.id },
    });
    const flag = contacts >= 2 && (orderCount + supplyOrderCount) >= 1 ? 'OK' : 'WARN';
    const padName = (org.name + '                              ').slice(0, 30);
    console.log('  [' + flag + '] ' + padName + ' contacts=' + contacts + ' customerOrders=' + orderCount + ' supplyOrders=' + supplyOrderCount);
  }

  console.log('\n=== EntityReference vs EntityLink ===');
  const refByOwner = await (prisma as any).entityReference.groupBy({
    by: ['ownerType'],
    where: { deletedAt: null, status: 'active' },
    _count: { id: true },
  });
  console.log('References by ownerType:');
  for (const g of refByOwner) console.log('  ' + g.ownerType + ': ' + g._count.id);

  const linkByFrom = await (prisma as any).entityLink.groupBy({
    by: ['fromType'],
    where: { deletedAt: null, status: 'active' },
    _count: { id: true },
  });
  console.log('Links by fromType:');
  for (const g of linkByFrom) console.log('  ' + g.fromType + ': ' + g._count.id);

  console.log('\n=== Order EntityReference 检查 ===');
  const orderCount = await prisma.order.count({ where: { deletedAt: null } });
  const orderRefCount = await (prisma as any).entityReference.count({ where: { ownerType: 'order', deletedAt: null, status: 'active' } });
  console.log('Orders: ' + orderCount + ', Order References: ' + orderRefCount);

  console.log('\n=== Product 分类分布 ===');
  const productByType = await prisma.productAsset.groupBy({
    by: ['type'],
    where: { deletedAt: null },
    _count: { id: true },
  });
  for (const g of productByType) console.log('  ' + g.type + ': ' + g._count.id);

  await prisma.$disconnect();
})();
