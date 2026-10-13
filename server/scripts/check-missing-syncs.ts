import { PrismaClient } from '@prisma/client';
(async () => {
  const prisma = new PrismaClient();

  // OrderLine → product (material)
  const lines = await prisma.orderLine.findMany({
    where: { OR: [{ materialCode: { not: null } }, { description: { not: null } }] },
    select: { id: true, orderId: true, materialCode: true, description: true, lineNumber: true },
  });
  console.log('OrderLines with material info: ' + lines.length);

  // Contact → organization (belongs_to)
  const contacts = await prisma.relation.findMany({
    where: { deletedAt: null, type: 'contact', organizationId: { not: null } },
    select: { id: true, name: true, organizationId: true },
  });
  console.log('Contacts with org: ' + contacts.length);

  await prisma.$disconnect();
})();
