/** Actual release service/router with current-account JWT auth and native-shaped storage.
 * This is not PostgreSQL/lock proof; isolated PG acceptance remains separate. */
import express from 'express';
import request from 'supertest';
import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { createAuthService, type TokenPayload } from '../../auth/service';
import { createAuthorizationSnapshotGuard } from '../../auth/authorizationSnapshotGuard';
import { createReleaseRouter } from '../releaseRoute';
import * as realtime from '../../realtime';

const managerId = 'release-leader';
const applicantId = 'release-sales';
const managerScopes = ['production:read', 'orders:read', 'orders:write', 'production:pp_release:business_sign'];
const applicantScopes = ['orders:read', 'orders:write'];
const sample = { id: 'SMP-REWORK', code: 'PP-REWORK-1', type: 'pp', status: 'approved', round: 2,
  sourceCaseId: null, sourceOrderId: null, projectionKey: null, supplierName: 'Real mill', qcStatus: 'passed',
  customerStatus: 'approved', approvedAt: 10, productAssetId: null, specSnapshot: { fabric: 'cotton' }, deletedAt: null };

function account(id: string, roleId: string, scopes: string[]) {
  const legacyRole = roleId === 'role-sales-manager' ? 'manager' : 'sales';
  return { id, displayName: id === managerId ? 'Sales manager' : 'Applicant', status: 'active', deletedAt: null,
    primaryDeptId: null, roles: [{ roleId, departmentId: null, role: { id: roleId, name: roleId, isSystem: true,
      permissions: scopes.map(scope => ({ permission: { scope } })) } }], legacyRole };
}

function host(options: { role?: 'manager' | 'sales'; scopes?: string[]; state?: string; notificationFault?: boolean } = {}) {
  const sampleRow = structuredClone(sample);
  const users = new Map<string, any>([
    [managerId, account(managerId, 'role-sales-manager', managerScopes)],
    [applicantId, account(applicantId, 'role-sales', options.role === 'sales' && options.scopes ? options.scopes : applicantScopes)],
  ]);
  const line = { id: 'L-original', orderId: 'O-original', lineNumber: 1, itemNo: 'ITEM-1', description: 'Cotton twill',
    materialCode: null, width: '150cm', quantity: '1000', unit: 'M', deliveryDate: '2026-12-01', exMillDate: null,
    styleNo: 'STYLE-1', colorName: 'Navy', moqOverride: null, confirmedSourceType: null, confirmedSourceId: null,
    specSnapshot: { fabric: 'cotton' } };
  const scope = { id: 'RS-original', orderId: 'O-original', orderLineId: line.id, factoryRelationId: null,
    productionBatchId: null, productionBatchRevision: null, quantity: '1000', unit: 'M', scopeRevision: 1,
    state: 'no_release', currentReleaseId: null, confirmedSourceType: null, confirmedSourceId: null,
    specSnapshot: { fabric: 'cotton' }, createdAt: 1n, updatedAt: 1n, deletedAt: null };
  const requestRow = { id: 'RR-original', scopeId: scope.id, scopeRevision: 1,
    evidenceSnapshot: { sampleId: sampleRow.id, code: sampleRow.code, type: sampleRow.type, round: sampleRow.round, status: sampleRow.status,
      qcStatus: sampleRow.qcStatus, customerStatus: sampleRow.customerStatus, supplierName: sampleRow.supplierName,
      productAssetId: sampleRow.productAssetId, specSnapshot: sampleRow.specSnapshot, sampleOriginProof: null },
    specSnapshot: { fabric: 'cotton' }, ruleVersion: 'pp-release-v1', requestRevision: 1,
    state: options.state ?? 'pending', createdBy: applicantId, createdAt: 1n, updatedAt: 1n,
    rejectedBy: null, rejectedAt: null, rejectionReason: null, requestedChanges: null };
  const parent = { id: 'O-original', poNumber: 'PO-REWORK-1', deletedAt: null, customerRelationId: 'C-original',
    ownerId: applicantId, millRelationId: null, sourceCaseId: null, type: 'Fabric', businessLine: 'fabric',
    capsuleExemption: false, moqSnapshot: { fabricDefaultMoq: 800, garmentDefaultMoq: 200, capsuleMoq: 20,
      snapshotAt: '2026-10-04T00:00:00.000Z', configId: null, source: 'fallback_constant' } };
  const relations = [{ id: 'C-original', ownerId: applicantId, salesRepIds: [applicantId, managerId], deletedAt: null,
    customerAgreementMoq: null }];
  const state: any = { releaseRequests: [requestRow], releaseScopes: [scope], releaseSignatures: [], ppSampleReleases: [],
    releaseEvents: [], notifications: [], audits: [], samples: [sampleRow], relations };
  let notificationFault = options.notificationFault === true;
  const matches = (row: any, where: any = {}): boolean => Object.entries(where).every(([key, condition]: any) => {
    const value = row[key] ?? null;
    if (key === 'AND') return (Array.isArray(condition) ? condition : [condition]).every(part => matches(row, part));
    if (key === 'OR') return condition.some((part: any) => matches(row, part));
    if (condition && typeof condition === 'object') {
      if ('in' in condition) return condition.in.includes(value);
      if ('notIn' in condition) return !condition.notIn.includes(value);
      if ('not' in condition) return value !== condition.not;
      if ('has' in condition) return Array.isArray(value) && value.includes(condition.has);
      return matches(value ?? {}, condition);
    }
    return value === (condition ?? null);
  });
  const delegate = (rows: () => any[], key: string) => ({
    findFirst: vi.fn(async ({ where }: any = {}) => rows().find(row => matches(row, where)) ?? null),
    findUnique: vi.fn(async ({ where }: any = {}) => rows().find(row => where?.id ? row.id === where.id
      : where?.requestId_role ? row.requestId === where.requestId_role.requestId && row.role === where.requestId_role.role
        : where?.sampleId ? row.sampleId === where.sampleId : false) ?? null),
    findMany: vi.fn(async ({ where, orderBy }: any = {}) => {
      const result = rows().filter(row => matches(row, where));
      if (orderBy?.id) result.sort((a, b) => String(a.id).localeCompare(String(b.id)) * (orderBy.id === 'desc' ? -1 : 1));
      return result;
    }),
    create: vi.fn(async ({ data }: any) => { const row = { ...data }; rows().push(row); return row; }),
    createMany: vi.fn(async ({ data, skipDuplicates }: any) => {
      if (key === 'notification' && notificationFault) throw Error('injected durable notification failure');
      let count = 0;
      for (const row of data) {
        if (skipDuplicates && rows().some(existing => existing.id === row.id)) continue;
        rows().push({ ...row }); count++;
      }
      return { count };
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = rows().find(candidate => candidate.id === where.id);
      if (!row) throw Error(`${key} update target missing`);
      Object.assign(row, data); return row;
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const found = rows().filter(row => matches(row, where));
      for (const row of found) Object.assign(row, data);
      return { count: found.length };
    }),
  });
  const storage: any = {
    userAccount: {
      findFirst: vi.fn(async ({ where }: any) => { const found = users.get(where.id); return found && found.deletedAt == null ? found : null; }),
      findUnique: vi.fn(async ({ where }: any) => users.get(where.id) ?? null),
      findMany: vi.fn(async () => [...users.values()].filter(user => user.status === 'active' && user.deletedAt == null).map(user => ({ id: user.id }))),
    },
    userPermissionOverrides: { findMany: vi.fn(async () => []) },
    relation: {
      findMany: vi.fn(async ({ where }: any = {}) => relations.filter(row => matches(row, where)).map(row => ({ id: row.id }))),
      findUnique: vi.fn(async ({ where }: any) => relations.find(row => row.id === where.id) ?? null),
    },
    teamMember: { findMany: vi.fn(async () => []) }, teamDataGrant: { findMany: vi.fn(async () => []) },
    order: {
      findFirst: vi.fn(async ({ where }: any) => matches(parent, where) ? parent : null),
      findMany: vi.fn(async ({ where }: any) => matches(parent, where) ? [parent] : []),
      findUnique: vi.fn(async ({ where }: any) => where.id === parent.id ? { ...parent, lines: [line] } : null),
    },
    orderLine: {
      findFirst: vi.fn(async ({ where }: any) => matches(line, where) ? line : null),
      findUnique: vi.fn(async ({ where }: any) => where.id === line.id ? line : null),
      findMany: vi.fn(async ({ where }: any) => matches(line, where) ? [line] : []),
    },
    productAsset: { findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    customerTier: { findFirst: vi.fn(async () => null) },
    sample: delegate(() => state.samples, 'sample'), sampleSource: { findMany: vi.fn(async () => []) },
    orderSampleSource: { findUnique: vi.fn(async () => null) },
    releaseScope: {
      findFirst: delegate(() => state.releaseScopes, 'releaseScope').findFirst,
      findUnique: delegate(() => state.releaseScopes, 'releaseScope').findUnique,
      findMany: delegate(() => state.releaseScopes, 'releaseScope').findMany,
      update: delegate(() => state.releaseScopes, 'releaseScope').update,
    },
    releaseRequest: {
      ...delegate(() => state.releaseRequests, 'releaseRequest'),
    },
    releaseSignature: delegate(() => state.releaseSignatures, 'releaseSignature'),
    ppSampleRelease: delegate(() => state.ppSampleReleases, 'ppSampleRelease'),
    releaseEvent: delegate(() => state.releaseEvents, 'releaseEvent'),
    auditLog: { ...delegate(() => state.audits, 'auditLog'), create: vi.fn(async ({ data }: any) => { state.audits.push(data); return data; }) },
    notification: delegate(() => state.notifications, 'notification'),
    approvalRequest: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => [{ id: 'locked-row' }]),
  };
  let txQueue = Promise.resolve();
  storage.$transaction = vi.fn((work: any) => {
    const run = txQueue.then(async () => {
      const before = structuredClone(state);
      try { return await work(storage); }
      catch (error) {
        for (const key of Object.keys(state)) {
          if (Array.isArray(state[key])) state[key].splice(0, state[key].length, ...before[key]);
          else state[key] = before[key];
        }
        throw error;
      }
    });
    txQueue = run.then(() => undefined, () => undefined);
    return run;
  });
  const auth = createAuthService();
  const tokenFor = (id: string, scopes: string[], roleId: string, legacyRole: string): string => auth.signToken({
    userId: id, displayName: id, roles: [legacyRole], roleIds: [roleId], permissions: scopes, departmentIds: ['company'], authorizationLoaded: true,
  } as TokenPayload);
  const currentRole = options.role === 'sales' ? 'sales' : 'manager';
  const currentId = currentRole === 'sales' ? applicantId : managerId;
  const currentScopes = options.scopes ?? (currentRole === 'sales' ? applicantScopes : managerScopes);
  const currentRoleId = currentRole === 'sales' ? 'role-sales' : 'role-sales-manager';
  const currentLegacy = currentRole === 'sales' ? 'sales' : 'manager';
  const currentToken = tokenFor(currentId, currentScopes, currentRoleId, currentLegacy);
  const applicantToken = tokenFor(applicantId, applicantScopes, 'role-sales', 'sales');
  const app = express(); app.use(express.json());
  app.set('json replacer', (_key: string, value: unknown) => typeof value === 'bigint' ? Number(value) : value);
  app.use(createAuthorizationSnapshotGuard({ prisma: storage }));
  const changed = vi.fn();
  app.use('/api/v1/releases', createReleaseRouter({ prisma: storage, requireAuth: true, onDataChange: changed }));
  return { app, storage, state, line, scope, applicantToken, changed, currentToken,
    setNotificationFault: (value: boolean) => { notificationFault = value; },
    revokeCurrentManagerLeaderRole: () => users.set(managerId, account(managerId, 'role-sales', managerScopes)),
  removeApplicantOrderScope: () => {
    parent.ownerId = 'other'; relations[0].ownerId = 'other'; relations[0].salesRepIds = [managerId];
  },
  };
}

async function wire(h: ReturnType<typeof host>, method: 'get' | 'post', path: string, body?: unknown, token = h.currentToken) {
  const server = createServer(h.app);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const req = request(server)[method]('/api/v1/releases' + path).set('Authorization', `Bearer ${token}`);
    return await (body === undefined ? req : req.send(body));
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
async function reviewBody(h: ReturnType<typeof host>, patch: Record<string, unknown> = {}) {
  const response = await wire(h, 'get', '/release-requests/RR-original/action-context');
  expect(response.status).toBe(200);
  return { role: 'business', confirmedReviewedContent: true,
    expectedRequestRevision: response.body.item.request.requestRevision,
    expectedScopeRevision: response.body.item.scope.scopeRevision,
    reviewContentFingerprint: response.body.item.reviewContentFingerprint,
    rejectionReason: '现有样品色差超出客户确认范围', requestedChanges: '按客户确认色重新制作产前样并补齐复核记录', ...patch };
}
async function postReject(h: ReturnType<typeof host>, body: unknown) {
  return wire(h, 'post', '/release-requests/RR-original/reject', body);
}
function expectNoRejectionWrites(h: ReturnType<typeof host>) {
  expect(h.state.releaseRequests[0]).toMatchObject({ state: 'pending', rejectedBy: null, rejectionReason: null, requestedChanges: null });
  expect(h.scope.state).toBe('no_release'); expect(h.scope.currentReleaseId).toBeNull();
  expect(h.state.releaseSignatures).toHaveLength(0); expect(h.state.ppSampleReleases).toHaveLength(0);
  expect(h.state.releaseEvents).toHaveLength(0); expect(h.state.audits).toHaveLength(0); expect(h.state.notifications).toHaveLength(0);
}
afterEach(() => vi.restoreAllMocks());

it('release rejection requires both nonempty decision fields and explicit exact-content attestation before transaction', async () => {
  const h = host();
  const body = await reviewBody(h, { rejectionReason: ' ', requestedChanges: '' });
  h.storage.$transaction.mockClear();
  const response = await postReject(h, body);
  expect(response.status).toBe(400); expect(response.body.error.code).toBe('VALIDATION_FAILED');
  expect(h.storage.$transaction).not.toHaveBeenCalled(); expect(h.state.releaseRequests[0].state).toBe('pending');
  expect(h.state.notifications).toHaveLength(0); expect(h.state.audits).toHaveLength(0);
});

it('a current nonleader with the matching PP signature grant still cannot reject or spoof the leader identity', async () => {
  const h = host({ role: 'sales', scopes: [...applicantScopes, 'production:pp_release:business_sign'] });
  const body = await reviewBody(h, { actorId: managerId, actor: { userId: managerId, roles: ['manager'] } });
  const response = await postReject(h, body);
  expect(response.status).toBe(403); expect(response.body.error.code).toBe('FORBIDDEN');
  expect(h.state.releaseRequests[0].state).toBe('pending'); expect(h.state.releaseSignatures).toHaveLength(0);
  expect(h.state.releaseEvents).toHaveLength(0); expect(h.state.audits).toHaveLength(0); expect(h.state.notifications).toHaveLength(0);
});

it('rechecks current leadership after review and refuses when the leader role was revoked', async () => {
  const h = host(); const body = await reviewBody(h);
  // Keep the PP signature grant in the current account; remove only the
  // leader identity after the exact review context was read.
  h.revokeCurrentManagerLeaderRole();
  const response = await postReject(h, body);
  expect(response.status).toBe(403); expect(response.body.error.code).toBe('FORBIDDEN');
  expectNoRejectionWrites(h);
});

it('stale exact request/spec/sample/scope review fingerprint refuses with zero business writes', async () => {
  const h = host(); const body = await reviewBody(h);
  h.line.description = 'Changed after the leader read the request';
  const response = await postReject(h, body);
  expect(response.status).toBe(409); expect(response.body.error.code).toBe('REVIEW_CONTENT_CHANGED');
  expect(h.state.releaseRequests[0].state).toBe('pending'); expect(h.state.releaseRequests[0].rejectionReason).toBeNull();
  expect(h.state.releaseSignatures).toHaveLength(0); expect(h.state.ppSampleReleases).toHaveLength(0);
  expect(h.state.releaseEvents).toHaveLength(0); expect(h.state.audits).toHaveLength(0); expect(h.state.notifications).toHaveLength(0);
});

it('a request revision changed after review returns 409 without business writes', async () => {
  const h = host(); const body = await reviewBody(h);
  h.state.releaseRequests[0].requestRevision += 1;
  const response = await postReject(h, body);
  expect(response.status).toBe(409);
  expectNoRejectionWrites(h);
});

it('a frozen request evidence fingerprint changed after review returns 409 without business writes', async () => {
  const h = host(); const body = await reviewBody(h);
  h.state.releaseRequests[0].evidenceSnapshot = { ...h.state.releaseRequests[0].evidenceSnapshot, supplierName: 'Different mill' };
  const response = await postReject(h, body);
  expect(response.status).toBe(409);
  expectNoRejectionWrites(h);
});

it('a release scope revision changed after review returns 409 without business writes', async () => {
  const h = host(); const body = await reviewBody(h);
  h.scope.scopeRevision += 1;
  const response = await postReject(h, body);
  expect(response.status).toBe(409);
  expectNoRejectionWrites(h);
});

it('an evidence sample invalidated after review returns 409 without business writes', async () => {
  const h = host(); const body = await reviewBody(h);
  h.state.samples[0].status = 'revising';
  const response = await postReject(h, body);
  expect(response.status).toBe(409);
  expectNoRejectionWrites(h);
});

it('an evidence sample round changed after review returns 409 without business writes', async () => {
  const h = host(); const body = await reviewBody(h);
  h.state.samples[0].round += 1;
  const response = await postReject(h, body);
  expect(response.status).toBe(409);
  expectNoRejectionWrites(h);
});

it('a successful rejection preserves exact decision facts, leaves scope ungranted, notifies the applicant, and supports read/resubmit', async () => {
  const h = host();
  const event = vi.spyOn(realtime, 'publishNotificationEvent').mockImplementation(() => undefined);
  const body = await reviewBody(h, { actorId: 'forged-body-actor' });
  const response = await postReject(h, body);
  expect(response.status).toBe(200);
  expect(h.state.releaseRequests[0]).toMatchObject({ state: 'rejected', rejectedBy: managerId,
    rejectionReason: body.rejectionReason, requestedChanges: body.requestedChanges, requestRevision: 1, scopeRevision: 1 });
  expect(h.state.releaseRequests[0].rejectedAt).toEqual(expect.any(BigInt));
  expect(h.scope.state).toBe('no_release'); expect(h.scope.currentReleaseId).toBeNull();
  expect(h.state.releaseSignatures).toHaveLength(0); expect(h.state.ppSampleReleases).toHaveLength(0); expect(h.state.releaseEvents).toHaveLength(0);
  expect(h.state.audits).toHaveLength(1); expect(h.state.audits[0]).toMatchObject({ action: 'reject_release_request', targetId: 'RR-original' });
  expect(h.state.notifications).toHaveLength(1);
  expect(h.state.notifications[0]).toMatchObject({ userId: applicantId, type: 'approval_decided', level: 'warning',
    metadata: { orderId: 'O-original', scopeId: 'RS-original', releaseRequestId: 'RR-original', decisionStatus: 'rejected' } });
  expect(event).toHaveBeenCalledWith(expect.objectContaining({ eventId: h.state.notifications[0].id, recipientIds: [applicantId] }));
  expect(response.body.notificationStatus).toBe('persisted');

  const signAfterReject = await wire(h, 'post', '/release-requests/RR-original/signatures', {
    role: 'business', confirmedReviewedContent: true, expectedRequestRevision: 1, expectedScopeRevision: 1,
    reviewContentFingerprint: body.reviewContentFingerprint,
  });
  expect(signAfterReject.status).toBe(409); expect(signAfterReject.body.error.code).toBe('REQUEST_NOT_PENDING');
  expect(h.state.releaseSignatures).toHaveLength(0); expect(h.state.ppSampleReleases).toHaveLength(0);

  const details = await wire(h, 'get', '/release-requests/RR-original/rejection-context', undefined, h.applicantToken);
  expect(details.status).toBe(200);
  expect(details.body.item).toMatchObject({ request: { id: 'RR-original', state: 'rejected', rejectedBy: managerId,
    rejectionReason: body.rejectionReason, requestedChanges: body.requestedChanges,
    specSnapshot: { fabric: 'cotton' }, evidenceSnapshot: { sampleId: sample.id, code: sample.code, round: 2 } },
    scope: { id: 'RS-original', state: 'no_release' }, order: { id: 'O-original', poNumber: 'PO-REWORK-1' },
    line: { id: 'L-original', description: 'Cotton twill', specSnapshot: { fabric: 'cotton' } } });

  const resubmitted = await wire(h, 'post', '/release-scopes/RS-original/requests', { expectedScopeRevision: 1, sampleId: sample.id }, h.applicantToken);
  expect(resubmitted.status).toBe(201);
  expect(resubmitted.body.request).toMatchObject({ scopeId: 'RS-original', state: 'pending', createdBy: applicantId, requestRevision: 1 });
  expect(resubmitted.body.request.id).not.toBe('RR-original');
  expect(h.state.releaseRequests.find((row: any) => row.id === 'RR-original')).toMatchObject({ state: 'rejected', rejectedBy: managerId,
    rejectionReason: body.rejectionReason, requestedChanges: body.requestedChanges });
  expect(h.state.releaseRequests).toHaveLength(2); expect(h.scope.state).toBe('no_release');
});

it('concurrent rejection submissions serialize on the request and produce one rejection, audit, and notification', async () => {
  const h = host(); const body = await reviewBody(h);
  const [left, right] = await Promise.all([postReject(h, body), postReject(h, body)]);
  expect([left.status, right.status].sort()).toEqual([200, 409]);
  expect(h.state.releaseRequests[0].state).toBe('rejected'); expect(h.state.audits).toHaveLength(1);
  expect(h.state.notifications).toHaveLength(1); expect(h.state.releaseEvents).toHaveLength(0);
});

it('notification persistence failure rolls back the request rejection and audit', async () => {
  const h = host(); const body = await reviewBody(h); h.setNotificationFault(true);
  const response = await postReject(h, body);
  expect(response.status).toBe(500);
  expect(h.state.releaseRequests[0]).toMatchObject({ state: 'pending', rejectedBy: null, rejectionReason: null, requestedChanges: null });
  expect(h.state.audits).toHaveLength(0); expect(h.state.notifications).toHaveLength(0);
  expect(h.scope.state).toBe('no_release'); expect(h.state.releaseEvents).toHaveLength(0);
});

it('requester-only rejection read still requires the current order L2 scope', async () => {
  const h = host({ state: 'rejected' });
  Object.assign(h.state.releaseRequests[0], { rejectedBy: managerId, rejectedAt: 3n,
    rejectionReason: '理由', requestedChanges: '修改项' });
  const visible = await wire(h, 'get', '/release-requests/RR-original/rejection-context', undefined, h.applicantToken);
  expect(visible.status).toBe(200); expect(visible.body.item.request.rejectionReason).toBe('理由');
  h.removeApplicantOrderScope();
  const hidden = await wire(h, 'get', '/release-requests/RR-original/rejection-context', undefined, h.applicantToken);
  expect(hidden.status).toBe(404); expect(JSON.stringify(hidden.body)).not.toContain('理由');
  const outsider = host({ state: 'rejected' });
  outsider.state.releaseRequests[0].rejectedBy = managerId;
  outsider.state.releaseRequests[0].rejectionReason = 'private rejection';
  // A third account has current orders:read and the same L2 share, but is not
  // the original requester; the response hides the request existence.
  const user = account('another-sales', 'role-sales', applicantScopes);
  outsider.storage.userAccount.findFirst.mockImplementation(async ({ where }: any) => where.id === user.id ? user
    : where.id === managerId ? account(managerId, 'role-sales-manager', managerScopes)
      : where.id === applicantId ? account(applicantId, 'role-sales', applicantScopes) : null);
  const outsiderToken = createAuthService().signToken({ userId: user.id, displayName: user.displayName,
    roles: ['sales'], roleIds: ['role-sales'], permissions: applicantScopes, departmentIds: ['company'], authorizationLoaded: true } as TokenPayload);
  const noLeak = await wire(outsider, 'get', '/release-requests/RR-original/rejection-context', undefined, outsiderToken);
  expect(noLeak.status).toBe(404); expect(JSON.stringify(noLeak.body)).not.toContain('private rejection');
});
