import { GENERIC_ROUTE_ERROR_MESSAGE } from '../shared/routeError';
import { logger } from '../lib/logger';

type AgentControlCode = 'APPROVAL_ABORTED' | 'APPROVAL_WAIT_TIMEOUT' | 'APPROVAL_STATE_UNAVAILABLE'
  | 'AGENT_ABORTED' | 'TOOL_TIMEOUT';
const controlCopies = new WeakMap<Error, string>();

/** Only the Loop's own control failures carry a public token; caught error shapes do not. */
export function createAgentControlFailure(code: AgentControlCode, durationMs?: number): Error {
  const copy = code === 'TOOL_TIMEOUT' ? `${code}: ${durationMs}ms` : code;
  const error = new Error(copy);
  controlCopies.set(error, copy);
  return error;
}

/** Public records, recovery observations and transports must never copy an unknown caught value. */
export function publicAgentFailure(error: unknown): string {
  return typeof error === 'object' && error !== null
    ? controlCopies.get(error as Error) ?? GENERIC_ROUTE_ERROR_MESSAGE : GENERIC_ROUTE_ERROR_MESSAGE;
}

/** A diagnostic failure must never replace the execution outcome. */
export function logAgentFailure(message: string, error: unknown): void {
  try {
    logger.error(message, { error });
  } catch {
    // Unknown values can fail during log serialization; keep the original outcome.
  }
}
