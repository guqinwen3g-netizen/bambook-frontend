/**
 * Source-bound index composition -> real PG grants -> actual module/permission guards.
 * Only private synthetic AuditLog sources/witnesses are written. This proves the
 * composition refresh contract; it does not certify any complete business route.
 * No production root import, hand-written reordered host, current-user substitute,
 * fake scope, shared database or original acceptance case participates.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { createAccountStatusGuard, invalidateAccountStatusCache } from '../src/auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from '../src/auth/authorizationSnapshotGuard';
import { createRequestTimingMiddleware } from '../src/lib/requestTiming';
import { createAuthService, type TokenPayload } from '../src/auth/service';
import { createModuleAuthGuard } from '../src/auth/moduleGuard';
import { requirePermission } from '../src/auth/permissionGuard';
import { createPermissionService } from '../src/auth/permissionService';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { getMeloPrewarmStatus } from '../src/ai/tts';
import { asyncHandler, globalErrorHandler } from '../src/lib/asyncHandler';
import { InvoiceAttachmentError, readLegacyInvoiceAttachment } from '../src/finance/invoiceAttachmentService';
import { safeRouteError } from '../src/shared/routeError';

const db = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
const prefix = `acceptance-alias-${randomUUID()}`;
const key = `${prefix}-bound-key`;
const evidence = process.env.BAMBOOK_ALIAS_PROBE_EVIDENCE_DIR;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const sourcePath = path.resolve(__dirname, '../src/index.ts');
let counter = 0;
const requestReceipts: unknown[] = [];
const fixtureReceipts: unknown[] = [];
function save(name: string, value: unknown) {
  if (evidence) fs.writeFileSync(path.join(evidence, name), JSON.stringify(value, null, 2) + '\n');
}
db.$on('query', event => {
  if (evidence) fs.appendFileSync(path.join(evidence, 'actual-pg-queries.jsonl'), JSON.stringify(event) + '\n');
});
beforeAll(async () => {
  const [identity] = await db.$queryRawUnsafe<Array<{ name: string; directory: string; port: number }>>(
    "SELECT current_database() AS name,current_setting('data_directory') AS directory,inet_server_port() AS port");
  expect(process.env.BAMBOOK_ACCEPTANCE_DB_NAME).toMatch(/^bambook_acceptance_[a-f0-9]+$/);
  expect(identity).toEqual({ name: process.env.BAMBOOK_ACCEPTANCE_DB_NAME,
    directory: process.env.BAMBOOK_ACCEPTANCE_DB_DIR, port: Number(process.env.BAMBOOK_ACCEPTANCE_DB_PORT) });
  save('test-native-identity.json', identity);
});
afterAll(async () => {
  save('http-pairs.json', requestReceipts);
  save('synthetic-fixtures.json', fixtureReceipts);
  save('native-witnesses.json', await db.auditLog.findMany({ where: { action: 'acceptance-composition-write' }, orderBy: { createdAt: 'asc' } }));
  await db.$disconnect();
});

function variableName(statement: ts.Statement): string | undefined {
  return ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1
    && ts.isIdentifier(statement.declarationList.declarations[0].name)
    ? statement.declarationList.declarations[0].name.text : undefined;
}
function appCall(statement: ts.Statement, method: string, first?: string): boolean {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
  const call = statement.expression;
  return ts.isPropertyAccessExpression(call.expression) && ts.isIdentifier(call.expression.expression)
    && call.expression.expression.text === 'app' && call.expression.name.text === method
    && (first === undefined || (ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === first));
}
/** Compile the actual contiguous middleware block, with original function bodies,
 * registrations and order. The root's app statement and public health registration
 * are also copied as exact AST spans. Root startup directories/schedulers/routes
 * outside these declared spans are deliberately not executed.
 */
function compileActualRoot(client: PrismaClient, actors: Map<string, TokenPayload>): express.Express {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const file = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statements = Array.from(file.statements);
  const app = statements.find(statement => variableName(statement) === 'app');
  const first = statements.findIndex(statement => variableName(statement) === 'ALLOWED_ORIGINS');
  const end = statements.findIndex(statement => appCall(statement, 'use', '/api/uploads')
    && statement.getText(file).includes('createUploadsGuard'));
  const health = statements.find(statement => appCall(statement, 'get', '/api/health'));
  const build = statements.find(statement => variableName(statement) === 'BUILD_SHA');
  const resolveBuild = statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'resolveBuildSha');
  if (!app || !health || !build || !resolveBuild || first < 0 || end <= first) throw Error('Actual index composition anchors missing');
  const selected = statements.slice(first, end);
  const aliases = selected.filter(statement => appCall(statement, 'get', '/api/uploads/invoices/:filename'));
  if (aliases.length !== 1) throw Error('Exact actual invoice attachment GET alias span missing or duplicated');
  for (const [name, modulePath] of [['InvoiceAttachmentError', './finance/invoiceAttachmentService'],
    ['readLegacyInvoiceAttachment', './finance/invoiceAttachmentService'], ['safeRouteError', './shared/routeError']]) {
    const imports = statements.filter(statement => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text === modulePath && statement.importClause?.namedBindings
      && ts.isNamedImports(statement.importClause.namedBindings) && statement.importClause.namedBindings.elements.some(element => element.name.text === name && (!element.propertyName || element.propertyName.text === name)));
    if (imports.length !== 1) throw Error('Actual invoice alias production dependency import does not match: ' + name);
  }
  if (selected.some(statement => variableName(statement) !== 'ALLOWED_ORIGINS'
    && variableName(statement) !== 'corsWithCredentials' && !appCall(statement, 'use')
    && !appCall(statement, 'get', '/api/uploads/invoices/:filename'))) {
    throw Error('Unexpected executable statement in actual middleware closure');
  }
  const text = (statement: ts.Statement) => source.slice(statement.getStart(file), statement.end);
  const middleware = source.slice(selected[0].getStart(file), selected[selected.length - 1].end);
  if (!middleware.includes('createAccountStatusGuard(prisma)')
    || !middleware.includes('createAuthorizationSnapshotGuard')
    || !middleware.includes("req.url.slice('/bambook'.length)")
    || !middleware.includes('createRequestTimingMiddleware()')) throw Error('Actual composition coverage missing');
  const closure = `(function () {\n${text(app)}\n${middleware}\n${text(resolveBuild)}\n${text(build)}\n${text(health)}\nreturn app;\n})()`;
  const compiled = ts.transpileModule(closure, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, strict: true }, reportDiagnostics: true });
  if (compiled.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) throw Error('Actual composition compile error');
  const executable = ts.createSourceFile('actual-index-closure.js', compiled.outputText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const locals = new Set<string>();
  function declared(node: ts.Node) {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node)) && node.name) {
      const collect = (name: ts.BindingName | ts.Identifier) => {
        if (ts.isIdentifier(name)) locals.add(name.text);
        else name.elements.forEach(element => { if (ts.isBindingElement(element)) collect(element.name); });
      };
      collect(node.name);
    }
    if (ts.isCatchClause(node) && node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name)) locals.add(node.variableDeclaration.name.text);
    ts.forEachChild(node, declared);
  }
  declared(executable);
  const bindings = { express, cors, cookieParser, createAccountStatusGuard, createAuthorizationSnapshotGuard,
    createRequestTimingMiddleware, prisma: client, SDK_CONFIG: { requireAuth: true, apiKeys: new Set([key]) },
    AGENT_API_KEY_ACTORS: actors, getMeloPrewarmStatus, InvoiceAttachmentError, readLegacyInvoiceAttachment, safeRouteError, encodeURIComponent, Error, process, require: createRequire(__filename) };
  const permitted = new Set([...Object.keys(bindings), ...locals, 'Set', 'Date', 'String', 'undefined']);
  const unexpected = new Set<string>();
  function check(node: ts.Node) {
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const property = (ts.isPropertyAccessExpression(parent) && parent.name === node)
        || ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === node)
        || (ts.isBindingElement(parent) && parent.propertyName === node);
      if (!property && !permitted.has(node.text)) unexpected.add(node.text);
    }
    ts.forEachChild(node, check);
  }
  check(executable);
  if (unexpected.size) throw Error(`Unbound actual composition closure: ${Array.from(unexpected).sort().join(',')}`);
  const spans = [app, ...selected, resolveBuild, build, health].map(statement => ({
    start: statement.getStart(file), end: statement.end,
    line: file.getLineAndCharacterOfPosition(statement.getStart(file)).line + 1,
    endLine: file.getLineAndCharacterOfPosition(statement.end).line + 1,
    sha256: sha(text(statement)), source: text(statement),
  }));
  save('actual-index-composition.json', { sourcePath, sourceSha256: sha(source), closureSha256: sha(closure),
    compiledSha256: sha(compiled.outputText), bindings: Object.keys(bindings), unbound: [], spans,
    excluded: 'startup/schedulers/filesystem initialization and unrelated business routes; no hand-written middlewares',
    claim: 'composition refresh plus original public health contract, not all real business endpoints' });
  const compiledApp = vm.runInNewContext(compiled.outputText, bindings, { filename: 'actual-index-composition.js', timeout: 1000 });
  if (typeof compiledApp !== 'function' || typeof compiledApp.use !== 'function') throw Error('Actual root did not produce Express app');
  return compiledApp;
}

async function fixture(scopes: string[]) {
  const id = `${prefix}-${++counter}`;
  const roleId = `${id}-custom-role`;
  await db.userAccount.create({ data: { id, displayName: 'Synthetic composition principal', status: 'active' } });
  await db.role.create({ data: { id: roleId, name: roleId, isSystem: false } });
  await db.userRole.create({ data: { id: `${id}-assignment`, userId: id, roleId } });
  for (const scope of scopes) {
    const permission = await db.permission.upsert({ where: { scope }, update: {},
      create: { id: `${id}-${scope}`, scope, description: 'Synthetic private composition permission' } });
    await db.rolePermission.create({ data: { id: `${id}-${scope}-link`, roleId, permissionId: permission.id } });
  }
  const payload = await buildLoadedAuthTokenPayload(db, await loadUserWithRoles(db, id));
  const token = createAuthService().signToken(payload);
  const sourceId = `${id}-synthetic-source`;
  await db.auditLog.create({ data: { id: sourceId, actorId: id, action: 'acceptance-composition-source', targetType: 'AcceptanceSynthetic' } });
  fixtureReceipts.push({ id, roleId, sourceId, scopes, tokenSha256: sha(token), payload });
  return { id, roleId, payload, token, sourceId };
}
function host(options: { actors?: Map<string, TokenPayload>; failLoad?: boolean } = {}) {
  const loads: unknown[] = [];
  const client = db.$extends({ query: { userAccount: { async findFirst({ args, query }) {
    loads.push(args);
    if (options.failLoad) throw Error('Synthetic current-role SELECT failure with secret SQL marker');
    return query(args);
  } } } }) as unknown as PrismaClient;
  const actors = options.actors ?? new Map<string, TokenPayload>();
  const app = compileActualRoot(client, actors);
  const module = createModuleAuthGuard({ requireAuth: true, apiKeys: new Set([key]), apiKeyActors: actors });
  const permissions = createPermissionService({ prisma: db });
  /** Actual DB L2 resolver constrains the synthetic source to its current owner.
   * AuditLog is used only as a private fixture/witness container; it is not an
   * Order source and these endpoints never claim to exercise order commands.
   */
  const sourceFor = async (req: express.Request) => {
    const actor = (req as any).actor as TokenPayload;
    const resolver = await permissions.getDataScopeResolver(actor, 'orders');
    const source = await db.auditLog.findFirst({ where: { id: String(req.query.sourceId || ''), action: 'acceptance-composition-source' } });
    return source && (resolver.rule.kind === 'all' || resolver.allowedUserIds?.includes(source.actorId)) ? source : null;
  };
  app.get('/api/acceptance-root-refresh/read', module, requirePermission('orders:read'), asyncHandler(async (req, res) => {
    const source = await sourceFor(req);
    if (!source) { res.status(404).json({ error: 'SYNTHETIC_SOURCE_NOT_FOUND' }); return; }
    res.json({ actor: (req as any).actor, authSource: (req as any).authSource, sourceId: source.id });
  }));
  app.post('/api/acceptance-root-refresh/write', module, requirePermission('orders:write'), asyncHandler(async (req, res) => {
    const source = await sourceFor(req);
    if (!source) { res.status(404).json({ error: 'SYNTHETIC_SOURCE_NOT_FOUND' }); return; }
    const actor = (req as any).actor as TokenPayload;
    const witness = await db.auditLog.create({ data: { id: `${prefix}-witness-${randomUUID()}`, actorId: actor.userId,
      action: 'acceptance-composition-write', targetType: 'AcceptanceSynthetic', targetId: source.id,
      detail: { originalUrl: req.originalUrl, path: req.path, identitySource: (req as any).authSource } } });
    res.json({ written: true, witnessId: witness.id, sourceId: source.id, actor });
  }));
  app.get('/acceptance-non-api', (_req, res) => res.json({ url: _req.url, hasCurrentActor: Boolean((_req as any).actor) }));
  app.use(globalErrorHandler);
  return { app, loads };
}
async function witnessCount(sourceId: string) {
  return db.auditLog.count({ where: { action: 'acceptance-composition-write', targetId: sourceId } });
}
/** All paired requests and native witness deltas are captured before assertions;
 * an early RED must not hide what the other path actually did.
 */
async function pair(label: string, h: ReturnType<typeof host>, f: Awaited<ReturnType<typeof fixture>>,
  method: 'get' | 'post', credentials: { token?: string; apiKey?: string } = { token: f.token }, body: unknown = {}) {
  const results = [];
  for (const base of ['/api', '/bambook/api']) {
    const before = await witnessCount(f.sourceId);
    const loadBefore = h.loads.length;
    let call = request(h.app)[method](`${base}/acceptance-root-refresh/${method === 'get' ? 'read' : 'write'}`)
      .query({ sourceId: f.sourceId });
    if (credentials.token) call = call.set('Authorization', `Bearer ${credentials.token}`);
    if (credentials.apiKey) call = call.set('X-Bambook-API-Key', credentials.apiKey);
    if (method === 'post') call = call.send(body as any);
    const response = await call;
    const after = await witnessCount(f.sourceId);
    const record = { label, base, method, status: response.status, body: response.body,
      witnessBefore: before, witnessAfter: after, witnessDelta: after - before,
      rootLoads: h.loads.slice(loadBefore), b15Identity: response.headers['x-b15-app'] };
    requestReceipts.push(record); results.push(record);
  }
  save('http-pairs.json', requestReceipts);
  return results;
}
function denied(results: Awaited<ReturnType<typeof pair>>, status = 403) {
  for (const result of results) {
    expect(result.status, JSON.stringify(result)).toBe(status);
    expect(result.witnessDelta).toBe(0);
    expect((result.body as any).written).toBeUndefined();
    expect((result.body as any).actor).toBeUndefined();
  }
}
async function revoke(f: Awaited<ReturnType<typeof fixture>>, scope?: string) {
  const permission = scope ? await db.permission.findUniqueOrThrow({ where: { scope } }) : null;
  await db.rolePermission.deleteMany({ where: { roleId: f.roleId, ...(permission ? { permissionId: permission.id } : {}) } });
}

describe('actual index alias authorization composition with native private PG', () => {
  it('current qualified JWTs and cookies read/write on both paths through the real source-bound composition', async () => {
    const f = await fixture(['orders:read', 'orders:write']); const h = host();
    const reads = await pair('eligible-jwt-read', h, f, 'get');
    const writes = await pair('eligible-jwt-write', h, f, 'post');
    for (const r of reads) { expect(r.status).toBe(200); expect((r.body as any).actor.userId).toBe(f.id); }
    for (const r of writes) { expect(r.status).toBe(200); expect(r.witnessDelta).toBe(1); }
    for (const base of ['/api', '/bambook/api']) {
      const response = await request(h.app).get(`${base}/acceptance-root-refresh/read`).query({ sourceId: f.sourceId })
        .set('Cookie', `bambook_token=${f.token}`).set('Origin', 'http://localhost:3000');
      expect(response.status).toBe(200); expect(response.body.actor.userId).toBe(f.id);
      expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
      expect(response.headers['access-control-allow-credentials']).toBe('true');
    }
  });
  it('withdrawn role writes are rejected on both paths with zero PG witness and current read grants retained', async () => {
    const f = await fixture(['orders:read', 'orders:write']); const h = host();
    const initial = await pair('before-role-withdrawal', h, f, 'post');
    for (const result of initial) expect(result.status).toBe(200);
    await revoke(f, 'orders:write');
    const writes = await pair('after-role-withdrawal-write', h, f, 'post', { token: f.token }, { roles: ['owner'], permissions: ['orders:write'] });
    const reads = await pair('after-role-withdrawal-read', h, f, 'get');
    for (const result of reads) { expect(result.status).toBe(200); expect((result.body as any).actor.permissions).toEqual(['orders:read']); }
    denied(writes);
  });
  it('expired personal write grants cannot survive in either path despite a still-valid signed JWT', async () => {
    const f = await fixture(['orders:read']);
    const grantId = `${f.id}-personal`;
    await db.userPermissionOverrides.create({ data: { id: grantId, userId: f.id, scope: 'orders:write', grantedBy: f.id,
      reason: 'Synthetic private expiry boundary', expiresAt: new Date(Date.now() + 120_000) } });
    const prior = await buildLoadedAuthTokenPayload(db, await loadUserWithRoles(db, f.id));
    expect(prior.permissions).toContain('orders:write'); const token = createAuthService().signToken(prior); const h = host();
    const initial = await pair('before-personal-expiry', h, f, 'post', { token });
    for (const result of initial) expect(result.status).toBe(200);
    await db.userPermissionOverrides.update({ where: { id: grantId }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    denied(await pair('after-personal-expiry', h, f, 'post', { token }));
  });
  it('an empty current DB grant set blocks old JWT reads and writes on both paths without owner/body fallback', async () => {
    const f = await fixture(['orders:read', 'orders:write']); await revoke(f); const h = host();
    const reads = await pair('empty-current-grants-read', h, f, 'get');
    const writes = await pair('empty-current-grants-write', h, f, 'post', { token: f.token }, { actor: { userId: f.id, roles: ['owner'] }, permissions: ['*'] });
    denied(reads); denied(writes);
  });
  it('an empty verified JWT credential ceiling is never expanded by either current loader or alias', async () => {
    const f = await fixture(['orders:read', 'orders:write']); const h = host();
    const token = createAuthService().signToken({ ...f.payload, permissionCeiling: [] });
    const reads = await pair('empty-jwt-ceiling-read', h, f, 'get', { token });
    const writes = await pair('empty-jwt-ceiling-write', h, f, 'post', { token }, { permissionCeiling: ['*'] });
    denied(reads); denied(writes);
  });
  it('a bound key reads its current DB grants on both paths; startup grants cannot survive withdrawal', async () => {
    const f = await fixture(['orders:read', 'orders:write']); const actors = new Map([[key, f.payload]]); const h = host({ actors });
    const before = await pair('bound-key-before-withdrawal', h, f, 'get', { apiKey: key });
    for (const result of before) expect(result.status).toBe(200);
    await revoke(f);
    const reads = await pair('bound-key-after-withdrawal', h, f, 'get', { apiKey: key });
    const writes = await pair('bound-key-high-risk', h, f, 'post', { apiKey: key });
    expect(actors.get(key)?.permissions).toContain('orders:read'); denied(writes, 401); denied(reads);
  });
  it('valid bound keys and key ceilings preserve read-only credential and principal restrictions on both paths', async () => {
    const f = await fixture(['orders:read', 'orders:write']); const h = host({ actors: new Map([[key, f.payload]]) });
    const reads = await pair('valid-key-read', h, f, 'get', { apiKey: key });
    for (const result of reads) { expect(result.status).toBe(200); expect((result.body as any).authSource).toBe('api-key'); }
    denied(await pair('valid-key-write-denied', h, f, 'post', { apiKey: key }), 401);
    const ceiling = host({ actors: new Map([[key, { ...f.payload, permissionCeiling: [] }]]) });
    denied(await pair('empty-key-ceiling-read', ceiling, f, 'get', { apiKey: key }));
    denied(await pair('empty-key-ceiling-write', ceiling, f, 'post', { apiKey: key }), 401);
    denied(await pair('unmapped-key-read', host(), f, 'get', { apiKey: key }));
    denied(await pair('invalid-key-read', h, f, 'get', { apiKey: 'invalid-private-probe-key' }), 401);
  });
  it('actual Prisma current-loader failure stops both JWT paths with safe 503 and zero synthetic writes', async () => {
    const f = await fixture(['orders:read', 'orders:write']); const h = host({ failLoad: true });
    const reads = await pair('loader-failure-jwt-read', h, f, 'get');
    const writes = await pair('loader-failure-jwt-write', h, f, 'post', { token: f.token }, { roles: ['owner'], permissions: ['*'] });
    for (const result of [...reads, ...writes]) {
      expect(JSON.stringify(result.body)).not.toContain('secret SQL');
      expect((result.body as any).error, JSON.stringify(result)).toBe('AUTHORIZATION_UNAVAILABLE');
    }
    denied(reads, 503); denied(writes, 503);
  });
  it('actual Prisma current-loader failure also rejects bound-key reads on both paths', async () => {
    const f = await fixture(['orders:read']); const h = host({ actors: new Map([[key, f.payload]]), failLoad: true });
    denied(await pair('loader-failure-key-read', h, f, 'get', { apiKey: key }), 503);
  });
  it('disabled or deleted accounts reject JWTs on both paths without altering the original global status guard', async () => {
    for (const deletion of [false, true]) {
      const f = await fixture(['orders:read', 'orders:write']); const h = host();
      await db.userAccount.update({ where: { id: f.id }, data: deletion ? { deletedAt: BigInt(Date.now()) } : { status: 'disabled' } });
      invalidateAccountStatusCache(f.id);
      const reads = await pair(deletion ? 'deleted-jwt-read' : 'disabled-jwt-read', h, f, 'get');
      const writes = await pair(deletion ? 'deleted-jwt-write' : 'disabled-jwt-write', h, f, 'post');
      denied(reads, 401); denied(writes, 401);
    }
  });
  it('source identity and missing source controls remain strict under the actual DB L2 resolver on both paths', async () => {
    const f = await fixture(['orders:read', 'orders:write']); const other = await fixture(['orders:read', 'orders:write']); const h = host();
    denied(await pair('foreign-synthetic-source', h, f, 'post', { token: other.token }, { actor: { userId: f.id }, roles: ['owner'] }), 404);
    const missing = { ...f, sourceId: `${f.id}-missing-source` };
    denied(await pair('missing-synthetic-source', h, missing, 'post'), 404);
    expect(await witnessCount(f.sourceId)).toBe(0);
  });
  it('the exact original public health route stays anonymous and only the documented alias is rewritten', async () => {
    const h = host();
    // Public health reports a supplied deployment build, or the source snapshot
    // Git revision, or 'unknown' for an archive without Git. The official runner
    // intentionally uses the current immutable clone without setting BUILD_SHA.
    let expectedBuild = process.env.BUILD_SHA;
    if (!expectedBuild) {
      try { expectedBuild = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: path.resolve(__dirname, '../..'), stdio: ['ignore', 'pipe', 'ignore'],
      }).toString().trim() || 'unknown'; } catch { expectedBuild = 'unknown'; }
    }
    for (const base of ['/api', '/bambook/api']) {
      const publicHealth = await request(h.app).get(`${base}/health`).query({ harmless: 'one' });
      expect(publicHealth.status).toBe(200); expect(publicHealth.body.status).toBe('ok');
      expect(publicHealth.body.database).toBe('ok'); expect(publicHealth.body.authRequired).toBe(true);
      expect(publicHealth.body.build).toBe(expectedBuild);
      const anonymousProtected = await request(h.app).post(`${base}/acceptance-root-refresh/write`).send({ roles: ['owner'] });
      expect(anonymousProtected.status).toBe(401);
    }
    const outside = await request(h.app).get('/acceptance-non-api').query({ x: 'one' });
    expect(outside.status).toBe(200); expect(outside.body).toEqual({ url: '/acceptance-non-api?x=one', hasCurrentActor: false });
    for (const url of ['/bambookx/api/health', '/bambook/apix/health', '/other/api/health']) {
      expect((await request(h.app).get(url)).status).toBe(404);
    }
    const foreignOrigin = await request(h.app).get('/bambook/api/health').set('Origin', 'https://untrusted.example');
    expect(foreignOrigin.status).toBe(200); expect(foreignOrigin.headers['access-control-allow-origin']).toBeUndefined();
    expect(h.loads.length).toBe(0);
  });
});
