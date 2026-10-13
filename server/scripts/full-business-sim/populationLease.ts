import type { PrismaClient } from '@prisma/client';

/** The caller must use connection_limit=1. This session-level lease covers
 * the complete generator, including HTTP commands between SQL observations. */
export async function acquireScenarioPopulationLease(prisma: PrismaClient) {
  const lease = await prisma.$queryRaw<Array<{ acquired: boolean; pid: number }>>`
    SELECT pg_try_advisory_lock(hashtextextended('bambook:current-dev-scenario-population',0)) AS acquired,
      pg_backend_pid() AS pid`;
  if (lease.length !== 1 || !lease[0].acquired || !Number.isInteger(lease[0].pid)) throw Error('SCENARIO_POPULATION_ALREADY_RUNNING');
  const leasePid = lease[0].pid;
  return {
    async assertHeld() {
      const rows = await prisma.$queryRaw<Array<{ pid: number; held: boolean }>>`SELECT pg_backend_pid() AS pid,
        EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted AND objsubid=1
          AND classid::bigint=((hashtextextended('bambook:current-dev-scenario-population',0) >> 32) & 4294967295)
          AND objid::bigint=(hashtextextended('bambook:current-dev-scenario-population',0) & 4294967295)) AS held`;
      if (rows.length !== 1 || rows[0].pid !== leasePid || !rows[0].held) throw Error('SCENARIO_POPULATION_LEASE_LOST');
    },
    async release() {
      const connection = await prisma.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      if (connection.length === 1 && connection[0].pid === leasePid)
        await prisma.$queryRaw`SELECT pg_advisory_unlock(hashtextextended('bambook:current-dev-scenario-population',0))`;
    },
  };
}
