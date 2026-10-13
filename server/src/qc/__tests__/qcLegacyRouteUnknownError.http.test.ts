/** Read-only diagnosis: actual Auth/QC HTTP routes and native typed producers.
 * Only current synthetic Prisma storage is substituted. No security/service
 * helper is mocked; no real database or business facts are written. */
import express from 'express';
import request from 'supertest';
import { writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { createAuthRouter } from '../../auth/route';
import { createAuthService } from '../../auth/service';
import { createQcRouter } from '../qcRoute';
import { logger } from '../../lib/logger';

const userId = 'QC-HTTP-PRIVATE', password = 'synthetic-private-qc-probe';
const marker = 'QC_HTTP_RAW_SQL_MARKER', internalPath = '/internal/qc/private-driver.sql';
const ordinaryMessages = [
  `${marker} SELECT private_qc_fact FROM private_table at ${internalPath}`,
  `${marker} SELECT private_qc_fact at ${internalPath} 不存在 必填 ROLE_REQUIRED`,
];
function matches(row: any, where: any): boolean {
  if (!row) return false;
  return Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
    if (key === 'OR') return value.some((part: any) => matches(row, part));
    if (key === 'AND') return (Array.isArray(value) ? value : [value]).every(part => matches(row, part));
    if (value === null) return row[key] == null;
    if (value && typeof value === 'object') {
      if ('equals' in value) return value.mode === 'insensitive'
        ? String(row[key]).toLowerCase() === String(value.equals).toLowerCase() : row[key] === value.equals;
      if ('in' in value) return value.in.includes(row[key]);
      return matches(row[key], value);
    }
    return row[key] === value;
  });
}
function project(row: any, select?: any): any {
  if (row == null) return null;
  if (!select) return { ...row };
  return Object.fromEntries(Object.entries(select).filter(([, value]) => value).map(([key, value]: [string, any]) => [key,
    value === true ? row[key] ?? null : Array.isArray(row[key])
      ? row[key].map((item: any) => project(item, value.select)) : project(row[key], value.select)]));
}
async function setup() {
  const identity = createAuthService();
  let current: any = { id: userId, displayName: 'Synthetic QC current principal', email: 'qc.probe@example.invalid',
    passwordHash: await identity.hashPassword(password), status: 'active', deletedAt: null,
    primaryDeptId: null, primaryDepartment: null,
    roles: [{ userId, roleId: 'role-qc', departmentId: null, role: { id: 'role-qc', name: 'QC', isSystem: true,
      permissions: ['qc:read', 'qc:write'].map(scope => ({ permission: { scope } })) } }] };
  const location = { id: 'LOC-CURRENT', code: 'current', name: 'Synthetic current location', deletedAt: null, createdAt: BigInt(1), updatedAt: BigInt(1) };
  const order = { id: 'ORDER-OWN', ownerId: userId, customerRelationId: null, type: 'garment', businessLine: 'garment', deletedAt: null };
  let refs = 0;
  const businessFacts: string[] = [];
  const db: any = {
    userAccount: {
      findFirst: vi.fn(async ({ where }: any) => matches(current, where) ? current : null),
      findUnique: vi.fn(async ({ where, select }: any) => matches(current, where) ? project(current, select) : null),
      update: vi.fn(async ({ where, data }: any) => { if (!matches(current, where)) throw Error('Synthetic missing auth account'); current = { ...current, ...data }; return current; }),
    },
    userPermissionOverrides: { findMany: vi.fn(async () => []) },
    qCLocation: {
      findMany: vi.fn(async ({ where }: any) => matches(location, where) ? [location] : []),
      findUnique: vi.fn(async ({ where }: any) => matches(location, where) ? location : null),
      create: vi.fn(async () => { businessFacts.push('unexpected_create'); throw Error('Unexpected accepted location mutation'); }),
      update: vi.fn(async () => { businessFacts.push('unexpected_update'); throw Error('Unexpected accepted location mutation'); }),
    },
    qCAssignment: { count: vi.fn(async ({ where }: any) => where.locationId === location.id ? refs : 0) },
    order: { findUnique: vi.fn(async ({ where }: any) => matches(order, where) ? order : null) },
    inspectionReport: { findUnique: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async ({ data }: any) => ({ ...data })) },
    $transaction: vi.fn(async (callback: any) => callback(db)),
  };
  const onDataChange = vi.fn(), app = express(); app.use(express.json());
  app.use('/api/auth', createAuthRouter({ prisma: db,
    email: { isReal: false, describe: () => 'No-delivery synthetic HTTP boundary probe', send: vi.fn(async () => undefined) } }));
  app.use('/api/v1/qc', createQcRouter({ prisma: db, requireAuth: true, apiKeys: new Set(['synthetic-unbound-key']), onDataChange }));
  const login = async () => {
    const response = await request(app).post('/api/auth/login').send({ identifier: current.email, password });
    expect(response.status).toBe(200); expect(response.body.ok).toBe(true);
    const principal = identity.verifyToken(response.body.token)!;
    expect(principal.authorizationLoaded).toBe(true); expect(principal.userId).toBe(userId);
    expect(principal.roles).not.toContain('owner'); expect(principal.roles).not.toContain('admin');
    expect(principal.roleIds).toEqual(['role-qc']); expect(principal.permissions).not.toContain('*');
    return { token: response.body.token as string, principal };
  };
  return { app, db, login, onDataChange, businessFacts, setRefs: (value: number) => { refs = value; },
    setScopes: (scopes: string[]) => { current.roles[0].role.permissions = scopes.map(scope => ({ permission: { scope } })); } };
}
const endpoints = [
  { name: 'location-list', method: 'get', url: '/api/v1/qc/locations', code: 'QC_LOCATION_LIST_FAILED', model: 'qCLocation', delegate: 'findMany' },
  { name: 'location-create', method: 'post', url: '/api/v1/qc/locations', code: 'QC_LOCATION_CREATE_FAILED', model: 'qCLocation', delegate: 'create', body: { code: 'new-private-location', name: 'Synthetic new location' } },
  { name: 'location-update', method: 'patch', url: '/api/v1/qc/locations/LOC-CURRENT', code: 'QC_LOCATION_UPDATE_FAILED', model: 'qCLocation', delegate: 'update', body: { name: 'Synthetic updated location' } },
  { name: 'location-delete', method: 'delete', url: '/api/v1/qc/locations/LOC-CURRENT', code: 'QC_LOCATION_DELETE_FAILED', model: 'qCLocation', delegate: 'update' },
  { name: 'shipment-eligibility', method: 'get', url: '/api/v1/qc/orders/ORDER-OWN/shipment-eligibility', code: 'QC_SHIPMENT_ELIGIBILITY_FAILED', model: 'order', delegate: 'findUnique' },
] as const;
it('actual current QC login/routes hide ordinary SQL/path errors without changing native business or authorization boundaries', async () => {
  const f = await setup(), logged = await f.login(), receipt: any = { principal: {
    userId: logged.principal.userId, roleIds: logged.principal.roleIds, roles: logged.principal.roles,
    permissions: logged.principal.permissions, authorizationLoaded: logged.principal.authorizationLoaded,
  }, cases: [], productionHelpersMocked: [], noDatabase: true };
  expect(logged.principal.permissions).toEqual(['qc:read', 'qc:write']);
  const internalLog = vi.spyOn(logger, 'error');
  const call = (method: string, url: string, body?: any, token = logged.token) => {
    const req = (request(f.app) as any)[method](url);
    if (token) req.set('Authorization', 'Bearer ' + token);
    return body === undefined ? req : req.send(body);
  };
  const record = (label: string, response: any, extra: any = {}) => receipt.cases.push({ label, status: response.status, body: response.body, ...extra });
  try {
    const list = await call('get', '/api/v1/qc/locations'); record('legitimate-current-QC-list', list);
    expect(list.status).toBe(200); expect(list.body.items.map((x: any) => x.id)).toEqual(['LOC-CURRENT']);
    const eligibility = await call('get', '/api/v1/qc/orders/ORDER-OWN/shipment-eligibility'); record('legitimate-own-order-current-eligibility', eligibility);
    expect(eligibility.status).toBe(200); expect(eligibility.body).toMatchObject({ orderId: 'ORDER-OWN', applicable: false, eligible: false });
    for (const endpoint of endpoints) for (const message of ordinaryMessages) {
      const delegate = f.db[endpoint.model][endpoint.delegate], before = delegate.mock.calls.length, logBefore = internalLog.mock.calls.length;
      const fault = new Error(message); let faultReached = 0;
      delegate.mockImplementationOnce(async () => { faultReached++; throw fault; });
      const response = await call(endpoint.method, endpoint.url, 'body' in endpoint ? endpoint.body : undefined);
      const internal = internalLog.mock.calls.slice(logBefore).map(args => ({ component: args[0], error: (args as any)[1]?.error }));
      record(endpoint.name + '-ordinary-unknown-' + (message.includes('ROLE_REQUIRED') ? 'keyword-shaped' : 'sql-path'), response,
        { delegate: endpoint.model + '.' + endpoint.delegate, actualDelegateCalls: delegate.mock.calls.length - before,
          faultReached, ordinaryError: { name: fault.name, message: fault.message, ownCode: Object.prototype.hasOwnProperty.call(fault, 'code'), ownStatusCode: Object.prototype.hasOwnProperty.call(fault, 'statusCode') }, internal });
      expect.soft(faultReached).toBe(1); expect.soft(delegate.mock.calls.length - before).toBe(1);
      expect.soft(response.status, endpoint.name + ' ordinary storage error must remain unknown500').toBe(500);
      expect.soft(response.body.error?.code).toBe(endpoint.code);
      expect.soft(JSON.stringify(response.body), endpoint.name + ' public response must hide SQL').not.toContain(marker);
      expect.soft(JSON.stringify(response.body), endpoint.name + ' public response must hide internal path').not.toContain(internalPath);
      expect.soft(internal.some(x => x.error === message), endpoint.name + ' internal diagnostic retains actual error').toBe(true);
    }
    const business = [
      { label: 'location-code-required', method: 'post', url: '/api/v1/qc/locations', body: { name: 'Name' }, status: 400, code: 'QC_LOCATION_CREATE_FAILED', message: '驻地代码必填' },
      { label: 'location-name-required', method: 'post', url: '/api/v1/qc/locations', body: { code: 'different' }, status: 400, code: 'QC_LOCATION_CREATE_FAILED', message: '驻地名称必填' },
      { label: 'location-code-duplicate', method: 'post', url: '/api/v1/qc/locations', body: { code: 'current', name: 'Name' }, status: 400, code: 'QC_LOCATION_CREATE_FAILED', message: '驻地代码已存在' },
      { label: 'location-not-found', method: 'patch', url: '/api/v1/qc/locations/MISSING', body: { name: 'Name' }, status: 404, code: 'QC_LOCATION_UPDATE_FAILED', message: '驻地不存在' },
      { label: 'location-code-immutable', method: 'patch', url: '/api/v1/qc/locations/LOC-CURRENT', body: { code: 'changed' }, status: 400, code: 'QC_LOCATION_UPDATE_FAILED', message: '驻地代码不可修改' },
      { label: 'location-patch-name-required', method: 'patch', url: '/api/v1/qc/locations/LOC-CURRENT', body: { name: ' ' }, status: 400, code: 'QC_LOCATION_UPDATE_FAILED', message: '驻地名称必填' },
      { label: 'location-reference-blocks-delete', method: 'delete', url: '/api/v1/qc/locations/LOC-CURRENT', status: 400, code: 'QC_LOCATION_DELETE_FAILED', message: '仍有验货任务引用此驻地，不可删除', refs: 1 },
      { label: 'eligibility-order-id-required', method: 'get', url: '/api/v1/qc/orders/%20/shipment-eligibility', status: 400, code: 'QC_SHIPMENT_ELIGIBILITY_FAILED', message: 'orderId 必填' },
      { label: 'eligibility-order-not-found', method: 'get', url: '/api/v1/qc/orders/MISSING/shipment-eligibility', status: 404, code: 'QC_SHIPMENT_ELIGIBILITY_FAILED', message: '订单不存在' },
    ];
    for (const item of business) {
      f.setRefs(item.refs ?? 0); const response = await call(item.method, item.url, item.body); record(item.label, response, { expected: { status: item.status, code: item.code, message: item.message } });
      expect.soft(response.status).toBe(item.status); expect.soft(response.body).toEqual({ error: { code: item.code, message: item.message } });
    }
    const report = await call('get', '/api/v1/qc/reports/MISSING'); record('native-QcReportError-not-found', report);
    expect(report.status).toBe(404); expect(report.body).toEqual({ error: { code: 'QC_REPORT_GET_FAILED', message: '验货报告不存在' } });
    const invalidRole = await call('post', '/api/v1/qc/reports/MISSING/sign', { role: 'invalid' }); record('native-QcReportError-validation', invalidRole);
    expect(invalidRole.status).toBe(400); expect(invalidRole.body.error.message).toBe('非法签署角色（允许 qc | business）');
    const accountRead = f.db.userAccount.findFirst, accountBefore = accountRead.mock.calls.length;
    accountRead.mockRejectedValueOnce(new Error(ordinaryMessages[0]));
    const unavailable = await call('get', '/api/v1/qc/reports/MISSING'); record('native-report-current-authority-unknown503', unavailable,
      { delegate: 'userAccount.findFirst', actualDelegateCalls: accountRead.mock.calls.length - accountBefore });
    expect(unavailable.status).toBe(503); expect(unavailable.body).toEqual({ error: { code: 'AUTHORIZATION_UNAVAILABLE', message: '暂时无法核验验货报告权限，请稍后重试。' } });
    expect(JSON.stringify(unavailable.body)).not.toContain(marker); expect(JSON.stringify(unavailable.body)).not.toContain(internalPath);
    const anonymous = await call('get', '/api/v1/qc/locations', undefined, ''); record('anonymous-before-location-storage', anonymous); expect(anonymous.status).toBe(401);
    const keyWrite = await request(f.app).post('/api/v1/qc/locations').set('X-Bambook-API-Key', 'synthetic-unbound-key').send({ code: 'new', name: 'Name' });
    record('API-key-cannot-write', keyWrite); expect(keyWrite.status).toBe(401);
    f.setScopes([]); const revoked = await f.login(); expect(revoked.principal.permissions).toEqual([]);
    const denied = await call('get', '/api/v1/qc/locations', undefined, revoked.token); record('actual-loaded-empty-grants-do-not-fallback-QC-role', denied); expect(denied.status).toBe(403);
    const reportCalls = f.db.inspectionReport.findUnique.mock.calls.length;
    const currentDenied = await call('get', '/api/v1/qc/reports/MISSING'); record('native-QcReportError-current-revocation403-despite-old-JWT', currentDenied);
    expect(currentDenied.status).toBe(403); expect(currentDenied.body).toEqual({ error: { code: 'FORBIDDEN', message: '当前账号没有该验货任务操作权限。' } });
    expect(f.db.inspectionReport.findUnique.mock.calls.length).toBe(reportCalls);
    expect(f.businessFacts).toEqual([]); expect(f.onDataChange).not.toHaveBeenCalled();
    receipt.businessFacts = f.businessFacts; receipt.onDataChangeCalls = f.onDataChange.mock.calls.length;
  } finally {
    internalLog.mockRestore();
    if (process.env.BAMBOOK_QC_HTTP_PROOF) writeFileSync(process.env.BAMBOOK_QC_HTTP_PROOF, JSON.stringify(receipt, null, 2) + '\n');
  }
});
