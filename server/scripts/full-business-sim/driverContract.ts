import { createHash } from 'node:crypto';
import type { ScenarioActorKey } from './masterData';

export type ScenarioHttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
export interface ScenarioHttpResponse { status: number; body: any }
export type ScenarioInvoke = (actor: ScenarioActorKey, method: ScenarioHttpMethod, url: string, body?: unknown) => Promise<ScenarioHttpResponse>;
export interface ScenarioCommandRecord {
  key: string; actor: ScenarioActorKey; method: ScenarioHttpMethod; url: string; hash: string;
  runtimeId: string; actorId: string; retryPolicy: 'native-idempotent' | 'read' | 'reconcile-create';
  state: 'intent' | 'acknowledged'; body?: unknown; response?: ScenarioHttpResponse;
}
/** Persist intents before sending and acknowledgements afterwards. The caller
 * stores this journal privately; it can contain commercially sensitive data. */
export interface ScenarioCommandJournal {
  read(key: string): Promise<ScenarioCommandRecord | null>;
  write(record: ScenarioCommandRecord): Promise<void>;
}
export interface ScenarioDriverDependencies {
  invoke: ScenarioInvoke; journal: ScenarioCommandJournal;
  runtimeId: string; actorIds: Record<ScenarioActorKey, string>;
  verifyActor(actor: ScenarioActorKey): Promise<void>;
}
export interface ScenarioExecution {
  key: string; earnedSteps: string[]; stopReached: boolean; blockedAt?: string;
  ids: Record<string, string | string[]>;
}

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
/** Native idempotent commands may recover an unknown acknowledgement with the
 * original payload. Non-idempotent creates require explicit readback before
 * the caller can reconcile the intent; never silently create a duplicate. */
export async function scenarioCommand(deps: ScenarioDriverDependencies, input: {
  key: string; actor: ScenarioActorKey; method: ScenarioHttpMethod; url: string; body?: unknown;
  idempotent?: boolean; expectedStatus?: number | number[];
}): Promise<any> {
  const actorId = deps.actorIds[input.actor], runtimeId = deps.runtimeId;
  if (!runtimeId?.trim() || !actorId?.trim()) throw Error('SCENARIO_RUNTIME_IDENTITY_REQUIRED');
  await deps.verifyActor(input.actor);
  const retryPolicy = input.method === 'get' ? 'read' : input.idempotent ? 'native-idempotent' : 'reconcile-create';
  const hash = createHash('sha256').update(JSON.stringify(canonical({ runtimeId, actorId, retryPolicy,
    actor: input.actor, method: input.method, url: input.url, body: input.body ?? null }))).digest('hex');
  const expected = input.expectedStatus == null ? [200, 201] : Array.isArray(input.expectedStatus) ? input.expectedStatus : [input.expectedStatus];
  const checked = (response: ScenarioHttpResponse) => {
    if (!expected.includes(response.status) || response.body?.ok === false) {
      throw Error(`SCENARIO_HTTP_REJECTED: ${input.key}: HTTP ${response.status}: ${JSON.stringify(response.body)}`);
    }
    return response.body;
  };
  if (input.method === 'get') return checked(await deps.invoke(input.actor, input.method, input.url, input.body));
  const previous = await deps.journal.read(input.key);
  if (previous && (previous.hash !== hash || previous.actor !== input.actor || previous.url !== input.url || previous.method !== input.method)) {
    throw Error(`SCENARIO_COMMAND_CHANGED: ${input.key}`);
  }
  if (previous?.state === 'acknowledged') return previous.response!.body;
  if (previous?.state === 'intent' && !input.idempotent) {
    throw Error(`SCENARIO_ACK_UNKNOWN_RECONCILE_REQUIRED: ${input.key}`);
  }
  const intent: ScenarioCommandRecord = { key: input.key, actor: input.actor, actorId, runtimeId, retryPolicy,
    method: input.method, url: input.url, body: input.body, hash, state: 'intent' };
  await deps.journal.write(intent);
  const response = await deps.invoke(input.actor, input.method, input.url, input.body);
  checked(response);
  await deps.journal.write({ ...intent, state: 'acknowledged', response });
  return response.body;
}
