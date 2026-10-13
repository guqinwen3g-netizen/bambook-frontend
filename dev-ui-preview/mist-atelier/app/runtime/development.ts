import { apiService } from '../../../../services/apiService';
import { getAuthState, hasPermission, subscribe } from '../../../../services/authService';
import {
  developmentService,
  type DevelopmentVersionConfirmation,
  type DevelopmentVersionConfirmationInput,
  type DevelopmentVersionQcReview,
} from '../../../../services/developmentService';
import { readBusinessWorkspace, type BusinessWorkspaceContext, type BusinessWorkspaceScope } from '../../../../services/businessWorkspaceService';
import type { DevelopmentCase, DevelopmentStage, DevelopmentSupplier, DevelopmentType, SampleBatch } from '../../../../types';

export type DevelopmentQuery = {
  limit?: number; offset?: number; type?: DevelopmentType; stage?: DevelopmentStage;
  search?: string; owner?: string; customer?: string; supplier?: string;
};
export type DevelopmentPage = {
  items: DevelopmentCase[]; total: number; limit: number; offset: number; hasMore: boolean;
};
export type DevelopmentVersion = {
  id: string; label: string; kind: string; parentVersionId: string | null;
  factoryId: string | null; factoryName: string | null; raw: Record<string, unknown>;
};
export type DevelopmentDetail = {
  item: DevelopmentCase; suppliers: DevelopmentSupplier[]; batches: SampleBatch[];
  versions: DevelopmentVersion[]; workspace: BusinessWorkspaceContext;
};
export type DevelopmentVersionDetail = {
  caseId: string; version: DevelopmentVersion; physicalVersionId: string;
  batches: SampleBatch[]; confirmations: DevelopmentVersionConfirmation[];
  qc: { latest: DevelopmentVersionQcReview | null; history: DevelopmentVersionQcReview[]; legacy: DevelopmentVersionQcReview[] };
  canConfirm: boolean; blockedReasons: string[]; workspace: BusinessWorkspaceContext;
};
export type RuntimeAuthority = {
  /** Opaque identity fingerprint; include account, roles, scopes, ceiling, endpoint and credentials. */
  identity: string; actorId: string | null; authenticated: boolean; loading: boolean;
  canRead: boolean; canConfirm: boolean; endpoint: string; headers: Record<string, string>;
};
export type DevelopmentRuntimeDependencies = {
  authority: () => RuntimeAuthority;
  subscribeAuthority: (changed: () => void) => () => void;
  fetch: typeof fetch;
  url: (path: string, endpoint: string) => string;
  service: Pick<typeof developmentService, 'getDevelopmentCase' | 'listDevelopmentSuppliers' | 'listSampleBatches' | 'listDevelopmentVersionConfirmations' | 'recordDevelopmentVersionConfirmation'>;
  workspace: (scope: BusinessWorkspaceScope) => Promise<BusinessWorkspaceContext>;
};
export type DevelopmentCallOptions = { signal?: AbortSignal };
export type PendingDevelopmentConfirmation = {
  caseId: string; versionId: string; input: DevelopmentVersionConfirmationInput;
};

export class DevelopmentRuntimeError extends Error {
  constructor(
    public code: string, message: string, public status?: number,
    public outcome: 'not_submitted' | 'unknown' = 'not_submitted',
    public original?: PendingDevelopmentConfirmation,
  ) { super(message); this.name = 'DevelopmentRuntimeError'; }
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const present = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const fail = (code: string, message: string): never => { throw new DevelopmentRuntimeError(code, message); };
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => record(item)
  ? Object.fromEntries(Object.keys(item).sort().filter(key => item[key] !== undefined).map(key => [key, item[key]])) : item);
const actualId = (value: string, label: string) => {
  if (!present(value) || value !== value.trim()) fail('INVALID_INPUT', `请提供准确${label} ID。`);
  return value;
};

function caseRecord(value: unknown, expected?: string): DevelopmentCase {
  if (!record(value) || !present(value.id) || (expected && value.id !== expected)
    || !['code', 'name', 'type', 'stage'].every(key => present(value[key])) || !Array.isArray(value.tags)
    || typeof value.createdAt !== 'number' || typeof value.updatedAt !== 'number') {
    return fail('INVALID_RESPONSE', '开发案响应缺少原始字段或未对应请求对象。');
  }
  return value as unknown as DevelopmentCase;
}

function versionsFrom(workspace: BusinessWorkspaceContext, caseId: string): DevelopmentVersion[] {
  if (!['development_case', 'development_version'].includes(workspace.scope.kind)
    || !('caseId' in workspace.scope) || workspace.scope.caseId !== caseId || workspace.overview.id !== caseId) fail('INVALID_RESPONSE', '版本列表未对应原开发案。');
  const ids = new Set<string>();
  return workspace.childSummaries.filter(row => row.kind === 'development_version').map(row => {
    if (!present(row.id) || !present(row.versionLabel) || !present(row.versionKind) || ids.has(row.id)) return fail('INVALID_RESPONSE', '工厂版本身份不完整或重复。');
    ids.add(row.id);
    return {
      id: row.id, label: row.versionLabel, kind: row.versionKind,
      parentVersionId: present(row.parentVersionId) ? row.parentVersionId : null,
      factoryId: present(row.factoryRelationId) ? row.factoryRelationId : null,
      factoryName: present(row.factoryName) ? row.factoryName : null, raw: row,
    };
  });
}

/** No report or confirmation is inherited from another factory or a parent version. */
export function exactVersionDecisions(batches: SampleBatch[], versionId: string) {
  const decisions = batches.flatMap(batch => [
    ...(batch.sampleVersionId === versionId ? [batch] : []),
    ...(batch.microVersions ?? []).filter(version => version.versionId === versionId),
  ]);
  const unique = (rows: DevelopmentVersionQcReview[]) => [...new Map(rows.filter(row => present(row?.id)).map(row => [row.id, row])).values()];
  const history = unique(decisions.flatMap(row => [
    ...(row.developmentQcHistory ?? []),
    ...(row.developmentQcReview ? [row.developmentQcReview] : []),
    ...(row.latestFormalQcReview ? [row.latestFormalQcReview] : []),
  ]) as DevelopmentVersionQcReview[]).filter(row => row.sampleVersionId === versionId);
  const candidates = unique(decisions.flatMap(row => row.latestFormalQcReview ? [row.latestFormalQcReview] : []) as DevelopmentVersionQcReview[])
    .filter(row => row.sampleVersionId === versionId && row.versionIdentityStatus !== 'unknown');
  candidates.sort((a, b) => (b.reviewSequence ?? 0) - (a.reviewSequence ?? 0) || Number(b.reviewedAt ?? 0) - Number(a.reviewedAt ?? 0));
  const legacy = unique(decisions.flatMap(row => row.legacyDevelopmentQcReviews ?? []) as DevelopmentVersionQcReview[]);
  return { latest: candidates[0] ?? null, history, legacy };
}

/** The wire contract has one basis text, not separate source/original-quotation fields. */
export function normalizeDevelopmentConfirmation(input: DevelopmentVersionConfirmationInput): DevelopmentVersionConfirmationInput {
  const text = (value: unknown, label: string, max: number) => {
    if (!present(value) || value.trim().length > max) return fail('INVALID_INPUT', `${label}须填写且不超过 ${max} 字。`);
    return value.trim();
  };
  if (!input || !['customer', 'internal'].includes(input.confirmerType) || !['approved', 'rejected', 'needs_adjustment'].includes(input.result)) fail('INVALID_INPUT', '确认方或三态结果无效。');
  const fields = new Set(['requestKey','confirmerType','confirmerName','confirmerUserId','confirmerRelationId','confirmerOrganization','confirmedAt','result','basis','evidence','sampleBatchId']);
  if (Object.keys(input).some(key => !fields.has(key))) fail('UNSUPPORTED_FIELD', '现有确认接口不支持独立来源类别或原文字段，请将实际依据记入 basis。');
  if (!/^\d{1,16}$/.test(input.confirmedAt) || BigInt(input.confirmedAt) <= 0n) fail('INVALID_INPUT', '确认时间须为真实发生时间的毫秒时间戳。');
  const evidence = input.evidence ?? [];
  if (!Array.isArray(evidence) || evidence.length > 30) fail('INVALID_INPUT', '确认凭证列表无效。');
  const normalized: DevelopmentVersionConfirmationInput = {
    requestKey: text(input.requestKey, '原请求编号', 128), confirmerType: input.confirmerType,
    confirmerName: text(input.confirmerName, '实际确认人', 120), confirmedAt: input.confirmedAt,
    result: input.result, basis: text(input.basis, '实际确认依据', 8000),
    evidence: evidence.map(value => text(value, '确认凭证引用', 2048)),
  };
  for (const key of ['confirmerUserId', 'confirmerRelationId', 'confirmerOrganization', 'sampleBatchId'] as const) {
    if (present(input[key])) normalized[key] = text(input[key], key, key === 'confirmerOrganization' ? 240 : 200);
  }
  return Object.freeze({ ...normalized, evidence: Object.freeze([...normalized.evidence!]) as unknown as string[] });
}

function verifyConfirmation(receipt: DevelopmentVersionConfirmation, caseId: string, versionId: string, input: DevelopmentVersionConfirmationInput, actorId: string) {
  if (!receipt || receipt.developmentCaseId !== caseId || receipt.sampleVersionId !== versionId || receipt.recordedBy !== actorId || !present(receipt.id) || !/^\d{1,16}$/.test(receipt.recordedAt) || BigInt(receipt.recordedAt) <= 0n
    || (['requestKey', 'confirmerType', 'confirmerName', 'confirmerUserId', 'confirmerRelationId', 'confirmerOrganization', 'confirmedAt', 'result', 'basis', 'sampleBatchId'] as const).some(key => (receipt[key] ?? null) !== (input[key] ?? null))
    || canonical(receipt.evidence ?? []) !== canonical(input.evidence ?? [])) fail('INVALID_RECEIPT', '确认回执与原请求的对象、身份或事实不一致。');
  return receipt;
}

function liveDependencies(): DevelopmentRuntimeDependencies {
  return {
    authority: () => {
      const auth = getAuthState(), endpoint = apiService.getStoredConfig().cloudEndpoint || '', headers = apiService.getAuthHeaders();
      return { identity: canonical([auth, endpoint, headers]), actorId: auth.user?.id ?? null, authenticated: auth.isAuthenticated, loading: auth.isLoading,
        canRead: hasPermission('products:read'), canConfirm: hasPermission('products:write'), endpoint, headers };
    },
    subscribeAuthority: changed => subscribe(() => changed()),
    fetch: (input, init) => fetch(input, init), url: (path, endpoint) => apiService.buildApiUrl(path, endpoint),
    service: developmentService, workspace: readBusinessWorkspace,
  };
}

/** Instantiate for the current Mist session; dispose and clear rendered data on logout/route teardown. */
export function createDevelopmentRuntime(overrides: Partial<DevelopmentRuntimeDependencies> = {}) {
  const deps = { ...liveDependencies(), ...overrides };
  let identity = deps.authority().identity, epoch = 0, selection = 0, disposed = false;
  const lanes = new Map<string, AbortController>();
  const pending = new Map<string, PendingDevelopmentConfirmation & { identity: string; epoch: number; actorId: string }>();
  const inFlightWrites = new Set<string>();
  function observe() {
    const next = deps.authority().identity;
    if (next !== identity) {
      identity = next; epoch++;
      for (const controller of lanes.values()) controller.abort(new DevelopmentRuntimeError('STALE_CONTEXT', '账号、权限、凭证或服务地址已变化，请重新读取。'));
    }
  }
  const stop = deps.subscribeAuthority(observe);
  function authority(write = false) {
    observe();
    if (disposed) return fail('DISPOSED', '开发会话已结束。');
    const value = deps.authority();
    if (!value.authenticated || value.loading || !value.actorId) return fail('UNAUTHENTICATED', '请先登录再读取开发业务。');
    if (!value.canRead || write && !value.canConfirm) return fail('FORBIDDEN', write ? '当前账号没有登记需求方确认的权限。' : '当前账号没有开发业务读取权限。');
    return value;
  }
  async function run<T>(lane: string, options: DevelopmentCallOptions, work: (check: () => RuntimeAuthority, signal: AbortSignal) => Promise<T>): Promise<T> {
    const bound = authority(), startEpoch = epoch;
    if (options.signal?.aborted) return fail('ABORTED', '读取已取消。');
    lanes.get(lane)?.abort(new DevelopmentRuntimeError('SUPERSEDED', '已开始读取新的业务对象。'));
    const controller = new AbortController(); lanes.set(lane, controller);
    const cancel = () => controller.abort(new DevelopmentRuntimeError('ABORTED', '操作已取消；已发出的写入须核对原请求。'));
    options.signal?.addEventListener('abort', cancel, { once: true });
    const check = () => {
      const current = authority();
      if (controller.signal.aborted) throw controller.signal.reason;
      if (current.identity !== bound.identity || epoch !== startEpoch) return fail('STALE_CONTEXT', '业务来源所属身份已变化。');
      return current;
    };
    let abortListener: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_resolve, reject) => { abortListener = () => reject(controller.signal.reason); controller.signal.addEventListener('abort', abortListener, { once: true }); });
      const result = await Promise.race([work(check, controller.signal), aborted]); check(); return result;
    } finally {
      options.signal?.removeEventListener('abort', cancel);
      if (abortListener) controller.signal.removeEventListener('abort', abortListener);
      if (lanes.get(lane) === controller) lanes.delete(lane);
    }
  }
  async function readVersion(caseId: string, versionId: string, check: () => RuntimeAuthority): Promise<DevelopmentVersionDetail> {
    const current = check();
    const [workspace, batches, confirmations] = await Promise.all([
      deps.workspace({ kind: 'development_version', caseId, sampleVersionId: versionId }),
      deps.service.listSampleBatches(caseId, current.endpoint),
      deps.service.listDevelopmentVersionConfirmations(caseId, [versionId], current.endpoint),
    ]); check();
    const version = versionsFrom(workspace, caseId).find(row => row.id === versionId);
    if (!version || !record(workspace.overview.version) || workspace.overview.version.id !== versionId) return fail('INVALID_RESPONSE', '准确版本不属于当前开发案。');
    if (!Array.isArray(batches) || batches.some(batch => batch.developmentCaseId !== caseId)
      || confirmations.some(row => row.developmentCaseId !== caseId || row.sampleVersionId !== versionId)) fail('INVALID_RESPONSE', '版本事实来自其他开发案或版本。');
    const physicalVersionId = present(workspace.overview.physicalSampleVersionId) ? workspace.overview.physicalSampleVersionId : version.kind === 'minor' ? version.parentVersionId : version.id;
    if (!physicalVersionId) return fail('INVALID_RESPONSE', '当前版本未能核对准确实物来源。');
    const node = workspace.nodes.find(row => row.id === 'confirmation');
    const blockedReasons = [...(node?.blockedReasons.map(reason => reason.message) ?? ['当前版本没有可核对的确认节点。']), ...(!current.canConfirm ? ['当前账号没有登记需求方确认的权限。'] : [])];
    return { caseId, version: { ...version, raw: workspace.overview.version }, physicalVersionId,
      batches: batches.filter(batch => batch.sampleVersionId === physicalVersionId), confirmations,
      qc: exactVersionDecisions(batches, versionId), canConfirm: !!node && current.canConfirm && (node.canOpen || node.canContinue) && blockedReasons.length === 0,
      blockedReasons, workspace };
  }
  return {
    async list(query: DevelopmentQuery = {}, options: DevelopmentCallOptions = {}): Promise<DevelopmentPage> {
      const limit = Math.min(200, Math.max(1, Math.trunc(query.limit ?? 30))), offset = Math.max(0, Math.trunc(query.offset ?? 0));
      if (!Number.isFinite(limit) || !Number.isFinite(offset)) return fail('INVALID_INPUT', '分页参数无效。');
      return run('list', options, async (check, signal) => {
        const current = check(), search = new URLSearchParams({ limit: String(limit), offset: String(offset) });
        for (const key of ['type', 'stage', 'search', 'owner', 'customer', 'supplier'] as const) if (query[key]) search.set(key, query[key]!);
        const response = await deps.fetch(deps.url(`/v1/development?${search}`, current.endpoint), { headers: current.headers, signal });
        const body: unknown = await response.json().catch(() => null); check();
        if (!response.ok) throw new DevelopmentRuntimeError(record(body) && record(body.error) && present(body.error.code) ? body.error.code : `HTTP_${response.status}`, record(body) && record(body.error) && present(body.error.message) ? body.error.message : '开发列表读取失败。', response.status);
        if (!record(body) || body.ok !== true || !Array.isArray(body.cases) || !Number.isSafeInteger(body.total) || Number(body.total) < 0 || body.limit !== limit || body.offset !== offset) return fail('INVALID_RESPONSE', '开发列表分页范围未能核对。');
        const items = body.cases.map(value => caseRecord(value));
        if (new Set(items.map(row => row.id)).size !== items.length || items.length > limit) return fail('INVALID_RESPONSE', '开发列表存在重复或越界记录。');
        return { items, total: Number(body.total), limit, offset, hasMore: offset + items.length < Number(body.total) };
      });
    },
    async detail(caseId: string, options: DevelopmentCallOptions = {}): Promise<DevelopmentDetail> {
      actualId(caseId, '开发案'); selection++;
      lanes.get('version')?.abort(new DevelopmentRuntimeError('SUPERSEDED', '已切换开发案。'));
      return run('detail', options, async check => {
        const current = check();
        const [item, suppliers, batches, workspace] = await Promise.all([
          deps.service.getDevelopmentCase(caseId, current.endpoint), deps.service.listDevelopmentSuppliers(caseId, current.endpoint),
          deps.service.listSampleBatches(caseId, current.endpoint), deps.workspace({ kind: 'development_case', caseId }),
        ]); check();
        if (suppliers.some(row => row.developmentCaseId !== caseId) || batches.some(row => row.developmentCaseId !== caseId)) return fail('INVALID_RESPONSE', '工厂或实物批次不属于当前开发案。');
        return { item: caseRecord(item, caseId), suppliers, batches, versions: versionsFrom(workspace, caseId), workspace };
      });
    },
    async version(caseId: string, versionId: string, options: DevelopmentCallOptions = {}): Promise<DevelopmentVersionDetail> {
      actualId(caseId, '开发案'); actualId(versionId, '版本'); const selected = selection;
      return run('version', options, async check => { const result = await readVersion(caseId, versionId, check); if (selected !== selection) return fail('SUPERSEDED', '已切换开发案。'); return result; });
    },
    pendingConfirmation(caseId: string, versionId: string): PendingDevelopmentConfirmation | null {
      const current = authority(), original = pending.get(`${caseId}:${versionId}`);
      return original?.identity === current.identity ? { caseId, versionId, input: original.input } : null;
    },
    async confirm(caseId: string, versionId: string, rawInput: DevelopmentVersionConfirmationInput, options: DevelopmentCallOptions = {}): Promise<DevelopmentVersionConfirmation> { // mist-allow: domain confirmation method; no browser native dialog
      actualId(caseId, '开发案'); actualId(versionId, '版本');
      const current = authority(true), input = normalizeDevelopmentConfirmation(rawInput), key = `${caseId}:${versionId}`;
      const old = pending.get(key);
      if (inFlightWrites.has(key)) return fail('WRITE_IN_PROGRESS', '该版本的原确认请求仍在处理中。');
      if (old && (canonical(old.input) !== canonical(input) || old.identity !== current.identity || old.epoch !== epoch)) return fail('UNRESOLVED_CONFIRMATION', '原确认结果尚未核对，只能恢复原请求。');
      let dispatched = false;
      inFlightWrites.add(key);
      try {
        return await run(`confirm:${key}`, options, async check => {
          const version = await readVersion(caseId, versionId, check); authority(true);
          if (!old && !version.canConfirm) return fail('BLOCKED', version.blockedReasons.join('；') || '当前版本不能登记需求方确认。');
          if (input.sampleBatchId && !version.batches.some(batch => batch.id === input.sampleBatchId)) return fail('INVALID_INPUT', '所选返样实物不属于当前准确版本。');
          check(); pending.set(key, { caseId, versionId, input, identity: current.identity, epoch, actorId: current.actorId! });
          dispatched = true;
          const receipt = await deps.service.recordDevelopmentVersionConfirmation(caseId, versionId, input, current.endpoint);
          check(); verifyConfirmation(receipt, caseId, versionId, input, current.actorId!); pending.delete(key); return receipt;
        });
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        if (!dispatched) throw error;
        const status = 'status' in error && typeof error.status === 'number' ? error.status : undefined;
        if (status && status >= 400 && status < 500 && status !== 408 && status !== 409) { pending.delete(key); throw error; }
        throw new DevelopmentRuntimeError('CONFIRMATION_UNCERTAIN', `已发出的确认须核对原请求：${error.message}`, status, 'unknown', { caseId, versionId, input });
      } finally { inFlightWrites.delete(key); }
    },
    async recoverConfirmation(caseId: string, versionId: string, options: DevelopmentCallOptions = {}): Promise<DevelopmentVersionConfirmation | null> {
      const current = authority(), key = `${caseId}:${versionId}`, original = pending.get(key);
      if (!original || original.identity !== current.identity) return null;
      return run(`recover:${key}`, options, async check => {
        const rows = await deps.service.listDevelopmentVersionConfirmations(caseId, [versionId], current.endpoint); check();
        const receipt = rows.find(row => row.requestKey === original.input.requestKey);
        if (!receipt) return null; // Absence is not evidence that a previous POST did not commit.
        verifyConfirmation(receipt, caseId, versionId, original.input, original.actorId); pending.delete(key); return receipt;
      });
    },
    dispose() { disposed = true; stop(); for (const controller of lanes.values()) controller.abort(new DevelopmentRuntimeError('DISPOSED', '开发会话已结束。')); lanes.clear(); },
  };
}

export type DevelopmentRuntime = ReturnType<typeof createDevelopmentRuntime>;
