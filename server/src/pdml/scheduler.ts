import type { PrismaClient } from '@prisma/client';
import { syncPdmlRawFabricCache } from './route';
import { logger } from '../lib/logger';
import type { TokenPayload } from '../auth/service';
import { currentPdmlActor, loadPdmlSchedulerActor, PDML_SYNC_SCOPES } from './pdmlAccess';

interface PdmlSyncSchedulerOptions {
  prisma: PrismaClient;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
  /** Trusted server loader; never derives identity from the bridge key. */
  resolveActor?: () => Promise<TokenPayload | null>;
}

const minutes = (value: number) => value * 60 * 1000;

const parseIntervalMs = () => {
  const raw = process.env.PDML_SYNC_INTERVAL_MS || process.env.PDML_SYNC_INTERVAL_MINUTES;
  if (!raw) return minutes(15);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return minutes(15);
  return process.env.PDML_SYNC_INTERVAL_MINUTES ? minutes(parsed) : parsed;
};

export function startPdmlSyncScheduler(opts: PdmlSyncSchedulerOptions) {
  if (process.env.BAMBOOK_NO_SCHEDULER === '1') {
    logger.info('[pdml-sync] disabled by BAMBOOK_NO_SCHEDULER=1');
    return;
  }
  if (process.env.PDML_SYNC_DISABLED === 'true') {
    logger.info('[pdml-sync] disabled by PDML_SYNC_DISABLED=true');
    return;
  }
  if (process.env.NODE_ENV !== 'production' && process.env.PDML_SYNC_ENABLED !== 'true') {
    logger.info('[pdml-sync] skipped outside production; set PDML_SYNC_ENABLED=true to enable locally');
    return;
  }
  const actorId = String(process.env.PDML_SYNC_ACTOR_ID || '').trim();
  if (!actorId && !opts.resolveActor) {
    logger.warn('[pdml-sync] disabled: PDML_SYNC_ACTOR_ID is not configured');
    return;
  }
  const resolveActor = opts.resolveActor || (() => loadPdmlSchedulerActor(opts.prisma, actorId));

  const intervalMs = parseIntervalMs();
  let running = false;

  const run = async (reason: string) => {
    if (running) {
      logger.debug(`[pdml-sync] skipped ${reason}; previous sync still running`);
      return;
    }
    running = true;
    const started = Date.now();
    try {
      const principal = await resolveActor();
      if (!principal) { logger.warn('[pdml-sync] skipped: configured account is unavailable'); return; }
      const actor = await currentPdmlActor(opts.prisma, principal, PDML_SYNC_SCOPES);
      // Scheduling this cache import does not create a general owner session.
      actor.permissionCeiling = principal.permissionCeiling && !principal.permissionCeiling.includes('*')
        ? principal.permissionCeiling.filter(scope => scope === 'data:import') : ['data:import'];
      const result = await syncPdmlRawFabricCache({
        prisma: opts.prisma,
        trustedActor: actor,
        pageSize: Number(process.env.PDML_SYNC_PAGE_SIZE || 500),
        onDataChange: opts.onDataChange,
      });
      logger.info(
        `[pdml-sync] ${reason} ok: fetched=${result.fetched} created=${result.created} updated=${result.updated} unchanged=${result.unchanged} ms=${Date.now() - started}`,
      );
    } catch (error: any) {
      logger.error(`[pdml-sync] ${reason} failed`, { error: error?.message || String(error) });
    } finally {
      running = false;
    }
  };

  logger.info(`[pdml-sync] scheduler enabled; interval=${Math.round(intervalMs / 1000)}s`);
  setTimeout(() => void run('startup'), minutes(1));
  setInterval(() => void run('interval'), intervalMs);
}
