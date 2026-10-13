import type { ScenarioActorKey, ScenarioMasterData } from './masterData';
import type { ScenarioInvoke, ScenarioHttpMethod } from './driverContract';
import { SCENARIO_BUSINESS_TIME } from './scenarios';
import { assertMatchingScenarioRuntimeIdentity, normalizeScenarioRuntimeIdentity, type ScenarioRuntimeIdentity } from '../../src/devPanel/scenarioIdentity';

const LOCAL_DEV_ORIGIN = 'http://127.0.0.1:8081';
/** Real HTTP transport shared by current-dev population and its subsequent
 * readback. Credentials stay in this closure, outside the command journal. */
export async function createRunningDevTransport(master: ScenarioMasterData, options: {
  baseUrl?: string; fetcher?: typeof fetch; verifyRuntimeAnchor?: () => Promise<ScenarioRuntimeIdentity>;
} = {}): Promise<{
  invoke: ScenarioInvoke; verifyActor(actor: ScenarioActorKey): Promise<void>;
  assertTarget(): Promise<void>; upload(actor: ScenarioActorKey, url: string, file: { bytes: Buffer; filename: string }): Promise<{ status: number; body: any }>;
}> {
  const baseUrl = options.baseUrl ?? LOCAL_DEV_ORIGIN;
  if (baseUrl !== LOCAL_DEV_ORIGIN) throw Error('SCENARIO_LOCAL_DEV_ORIGIN_REQUIRED');
  const fetcher = options.fetcher ?? fetch, tokens = new Map<ScenarioActorKey, string>();
  const targetUrl = (value: string): string => {
    if (!value.startsWith('/api/') || value.startsWith('//')) throw Error('SCENARIO_API_PATH_REQUIRED');
    const url = new URL(value, baseUrl);
    if (url.origin !== baseUrl || !url.pathname.startsWith('/api/') || url.hash) throw Error('SCENARIO_API_PATH_REQUIRED');
    return url.toString();
  };
  const call = (url: string, init: RequestInit = {}) => fetcher(targetUrl(url), {
    ...init, redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  const assertTarget = async () => {
    const response = await call('/api/dev/status'), body = await response.json();
    const clock = body.businessClock;
    if (response.status !== 200 || body.ok !== true || body.devPanelEnabled !== true
      || body.currentDb !== 'panda_hub_dev' || body.env?.nodeEnv !== 'development'
      || clock?.mode !== 'fixed' || clock.database !== 'panda_hub_dev' || clock.timeZone !== 'Asia/Shanghai'
      || clock.nowIso !== SCENARIO_BUSINESS_TIME) throw Error('SCENARIO_RUNNING_DEV_TARGET_CHANGED');
    if (options.verifyRuntimeAnchor) {
      const expected = normalizeScenarioRuntimeIdentity(await options.verifyRuntimeAnchor());
      const proofResponse = await call(`/api/dev/scenario-identity?requestKey=${encodeURIComponent(expected.receipt.requestKey)}`);
      const proof = await proofResponse.json();
      if (proofResponse.status !== 200 || proof?.ok !== true) throw Error('SCENARIO_RUNTIME_IDENTITY_CHANGED');
      assertMatchingScenarioRuntimeIdentity(proof.identity, expected);
    }
  };
  const verifyActor = async (actor: ScenarioActorKey) => {
    await assertTarget();
    const token = tokens.get(actor);
    if (!token || !master.cast[actor]?.id) throw Error(`SCENARIO_ACTOR_REVOKED: ${actor}`);
    const response = await call('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } }), body = await response.json();
    if (response.status !== 200 || body.user?.id !== master.cast[actor].id) throw Error(`SCENARIO_ACTOR_REVOKED: ${actor}`);
  };
  await assertTarget();
  for (const actor of Object.values(master.cast)) {
    // Recheck the database before sending even the next account's credentials.
    await assertTarget();
    const response = await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: actor.email, password: actor.password }) });
    const body = await response.json();
    if (response.status !== 200 || body.user?.id !== actor.id || typeof body.token !== 'string' || !body.token)
      throw Error(`SCENARIO_ACTUAL_LOGIN_FAILED: ${actor.key}`);
    tokens.set(actor.key, body.token);
    await verifyActor(actor.key);
  }
  const readResponse = async (response: Response, binary: boolean) => ({ status: response.status,
    body: binary ? Buffer.from(await response.arrayBuffer()) : await response.json() });
  const invoke: ScenarioInvoke = async (actor, method: ScenarioHttpMethod, url, body) => {
    targetUrl(url); // Validate before making any network call.
    await verifyActor(actor);
    const response = await call(url, { method: method.toUpperCase(), headers: {
      Authorization: `Bearer ${tokens.get(actor)}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return readResponse(response, /\/download(?:\?|$)/.test(url));
  };
  const upload = async (actor: ScenarioActorKey, url: string, file: { bytes: Buffer; filename: string }) => {
    targetUrl(url); await verifyActor(actor);
    if (!/^\/api\/v1\/customs\/trade-documents\/[^/?#]+\/external-archive$/.test(url)
      || !/^[\w.-]+\.pdf$/.test(file.filename) || file.bytes.subarray(0, 5).toString() !== '%PDF-') throw Error('SCENARIO_EXTERNAL_ARCHIVE_REQUIRED');
    const form = new FormData(); form.append('file', new Blob([new Uint8Array(file.bytes)], { type: 'application/pdf' }), file.filename);
    return readResponse(await call(url, { method: 'POST', headers: { Authorization: `Bearer ${tokens.get(actor)}` }, body: form }), false);
  };
  return { invoke, verifyActor, assertTarget, upload };
}
