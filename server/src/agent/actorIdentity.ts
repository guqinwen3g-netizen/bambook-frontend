import { PrismaClient } from '@prisma/client';

export type ActorIdentityInput = {
  userId?: string | null;
  displayName?: string | null;
};

export async function resolveActorUserAccountId(prisma: PrismaClient, input: ActorIdentityInput) {
  const actorUserId = String(input.userId || '').trim();
  const displayName = String(input.displayName || '').trim();
  if (!actorUserId || actorUserId === 'default-user') return null;

  try {
    const byId = await prisma.userAccount.findFirst({
      where: { id: actorUserId, deletedAt: null },
      select: { id: true },
    });
    if (byId?.id) return byId.id;

    const candidates = [
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(actorUserId)
        ? { email: { equals: actorUserId, mode: 'insensitive' as const } }
        : null,
      displayName
        ? { displayName: { equals: displayName, mode: 'insensitive' as const } }
        : null,
      actorUserId
        ? { displayName: { equals: actorUserId, mode: 'insensitive' as const } }
        : null,
    ].filter(Boolean) as any[];

    if (!candidates.length) return null;
    const matches = await prisma.userAccount.findMany({
      where: {
        deletedAt: null,
        status: 'active',
        OR: candidates,
      },
      select: { id: true },
      take: 2,
    });
    return matches.length === 1 ? matches[0].id : null;
  } catch {
    return null;
  }
}
