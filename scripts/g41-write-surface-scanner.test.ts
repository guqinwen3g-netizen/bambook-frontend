import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { classifyCompletePermissionMiddleware, classifyVerifiedMiddlewareArgument, extractVerifiedIdentityFactories } from './g41-write-surface-scanner.mjs';
import { SURFACE_MEASUREMENT_VERSION, classifyCurrentActorContinuation, classifyGuardArg, enumerateWriteRoutes, extractLocalGuards, reconcileSiteLists, siteKey, siteSignature, summarize, surfaceSourceEvidence, validateMeasurementCorrection } from './lib/writeRouteSurface.mjs';

const identityImport = "import { extractActorFromRequest } from '../auth/middleware';";
const moduleImport = "import { requireJwtForWrite, createModuleAuthGuard } from '../auth/moduleGuard';";
const permissionImport = "import { requirePermission } from '../auth/permissionGuard';";
const wrapper = `function asyncHandler(handler) {
  return (req, res, next) => {
    handler(req, res, next).catch(error => {
      logger.error('route failure', { error });
      if (!res.headersSent) { res.status(500).json({ error: 'FAILED' }); }
    });
  };
}`;
const factory = `function requireActor(prisma) {
  return asyncHandler(async (req, res, next) => {
    const actor = extractActorFromRequest(req);
    if (!actor) { return res.status(401).json({ error: 'UNAUTHORIZED' }); }
    req.actor = actor;
    next?.();
  });
}`;
const identitySource = `${identityImport}\n${wrapper}\n${factory}\nconst requireAgentActor = requireActor(prisma);`;
const conditional = `(req, res, next) => {
  const action = req.body?.action;
  if (!['submit', 'edit', 'return', 'cancel'].includes(action)) return res.status(400).json({ error: 'INVALID_INPUT' });
  return requirePermission(action === 'return' ? 'invoices:write' : 'products:write')(req, res, next);
}`;

describe('G41 source-backed identity factory evidence', () => {
  it('requires the real import, denied missing actor, attached actor and final next; counts identity only', () => {
    expect(extractVerifiedIdentityFactories(identitySource).requireActor).toMatchObject({ cls: 'identity', booleanGated: false });
    expect(extractLocalGuards(identitySource).requireAgentActor?.cls).toBe('identity');
    expect(classifyGuardArg('requireAgentActor', extractLocalGuards(identitySource))).toBe('identity');
  });

  it.each([
    ['fake import', identitySource.replace('../auth/middleware', '../fake/middleware')],
    ['type-only import', identitySource.replace('import {', 'import type {')],
    ['shadowed extractor', identitySource + '\nfunction bad(extractActorFromRequest) {}'],
    ['destructured extractor shadow', identitySource + '\nfunction bad({ extractActorFromRequest }) {}'],
    ['shadowed factory', identitySource + '\nfunction bad(requireActor) {}'],
    ['shadowed wrapper', identitySource.replace('function requireActor(prisma)', 'function requireActor(prisma, asyncHandler)')],
    ['missing denial', identitySource.replace("if (!actor) { return res.status(401).json({ error: 'UNAUTHORIZED' }); }", '')],
    ['denial calls next', identitySource.replace("{ error: 'UNAUTHORIZED' }", '{ error: next() }')],
    ['denial is not terminal', identitySource.replace('return res.status(401)', 'res.status(401)')],
    ['wrapper bypass', identitySource.replace('handler(req, res, next).catch', 'next().catch')],
    ['wrapper error bypass', identitySource.replace("logger.error('route failure', { error });", 'next();')],
    ['wrapper aliases next', identitySource.replace("logger.error('route failure', { error });", 'const bypass = next; bypass();')],
    ['caller proceeds before denial', identitySource.replace('const actor =', 'next(); const actor =')],
  ])('%s is unknown, never a name-only identity or permission grant', (_title, source) => {
    expect(extractVerifiedIdentityFactories(source)).toEqual({});
    expect(extractLocalGuards(source).requireAgentActor?.cls).toBe('unknown');
  });

  it('actual Agent factory is identity, preserving the permission ceiling of that evidence', () => {
    const source = readFileSync(new URL('../server/src/agent/route.ts', import.meta.url), 'utf8');
    expect(extractLocalGuards(source).requireAgentActor?.cls).toBe('identity');
  });
});

describe('G41 middleware arrays preserve independent strong scope evidence', () => {
  it('configurable JWT plus strong scope is strong in both orders and nested spreads', () => {
    const prefix = moduleImport + permissionImport + "const jwt = requireJwtForWrite({ requireAuth });\nconst scope = requirePermission('orders:write');\n";
    for (const array of ['[jwt, scope]', '[scope, jwt]']) {
      expect(extractLocalGuards(prefix + `const combined = ${array};`).combined).toMatchObject({ cls: 'permission', booleanGated: false });
    }
    expect(extractLocalGuards(prefix + 'const first = [jwt, scope]; const nested = [...first, jwt];').nested)
      .toMatchObject({ cls: 'permission', booleanGated: false });
  });

  it('JWT guards are configurable identity only; their Write display name grants no scope', () => {
    expect(extractLocalGuards(moduleImport + 'const a = requireJwtForWrite({ requireAuth }); const b = requireJwtForWrite({ requireAuth }); const gate = [a, b];').gate)
      .toMatchObject({ cls: 'identity', booleanGated: true });
    expect(extractLocalGuards(moduleImport + 'const a = requireJwtForWrite({ requireAuth }); const gate = [a, mystery];').gate?.unknownMembers).toEqual(['mystery']);
  });

  it('unknown members still get their own report and cannot masquerade as read-only scope', () => {
    expect(extractLocalGuards(moduleImport + permissionImport + "const jwt = requireJwtForWrite({ requireAuth }); const gate = [jwt, requirePermission('orders:read'), mystery];").gate)
      .toMatchObject({ cls: 'permission', booleanGated: false, readScopeKnown: false, unknownMembers: ['mystery'] });
    expect(extractLocalGuards('const requireWrite = createUnknownGate(); const gate = [requireWrite];').gate?.cls).toBe('unknown');
  });
});

describe('G41 complete conditional permission middleware', () => {
  it('both literal scope arms execute the real terminal permission middleware', () => {
    expect(classifyCompletePermissionMiddleware(conditional, permissionImport)).toMatchObject({ cls: 'permission', booleanGated: false,
      readScopeKnown: false, scopes: ['invoices:write', 'products:write'] });
    expect(classifyGuardArg(conditional, {}, permissionImport)).toBe('permission');
    expect(classifyCompletePermissionMiddleware(conditional.replaceAll(':write', ':read'), permissionImport)?.readScopeKnown).toBe(true);
  });

  it.each([
    ['fake import', conditional, permissionImport.replace('../auth/permissionGuard', '../fake/permissionGuard')],
    ['type-only import', conditional, permissionImport.replace('import {', 'import type {')],
    ['shadowed permission', conditional, permissionImport + '\nfunction fake(requirePermission) {}'],
    ['destructured permission shadow', conditional, permissionImport + '\nfunction fake({ requirePermission }) {}'],
    ['local permission alias', conditional.replace('const action = req.body?.action;', 'const requirePermission = fake; const action = req.body?.action;'), permissionImport],
    ['early next', conditional.replace('const action =', 'next(); const action ='), permissionImport],
    ['early return', conditional.replace('const action =', 'if (req.body.skip) return; const action ='), permissionImport],
    ['denial calls next', conditional.replace("{ error: 'INVALID_INPUT' }", '{ error: next() }'), permissionImport],
    ['ungated branch', conditional.replace("'products:write'", 'undefined'), permissionImport],
    ['dynamic scope', conditional.replace("'products:write'", 'req.body.scope'), permissionImport],
    ['wrong request arguments', conditional.replace('(req, res, next);', '(req.body, res, next);'), permissionImport],
    ['permission not invoked', conditional.replace('(req, res, next);', ';'), permissionImport],
    ['condition with side effects', conditional.replace("action === 'return'", 'changePermissions()'), permissionImport],
  ])('%s stays unknown', (_title, middleware, source) => {
    expect(classifyCompletePermissionMiddleware(middleware, source)).toBeNull();
    expect(classifyGuardArg(middleware, {}, source)).toBe('unknown');
  });
});

const scratch: string[] = [];
afterEach(() => scratch.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function fixtureRepo(source: string) {
  const root = mkdtempSync(join(tmpdir(), 'bambook-g41-pure-'));
  scratch.push(root);
  mkdirSync(join(root, 'server/src'), { recursive: true });
  writeFileSync(join(root, 'server/src/index.ts'), source);
  return root;
}

describe('G41 parser-owned fallback retains the direct handler boundary', () => {
  it('handles inert comment quotes without borrowing a protected sibling', () => {
    const source = `${permissionImport}const router=Router();
      router.post('/first', async(req,res)=>{
        // A customer comment is inert, including this unmatched quote: "
        const name='ordinary';return res.json({name});
      });
      router.post('/sibling',requirePermission('orders:write'),(req,res)=>res.end());`;
    const measured = enumerateWriteRoutes(fixtureRepo(source));
    expect(measured.routes.find(r => r.pathKey === "'/first'")).toMatchObject({ bodyBounded: true, bodyBoundBy: 'ast-direct-block', permissionCoveredAllLayers: false, authnCoveredAllLayers: false });
    expect(measured.routes.find(r => r.pathKey === "'/sibling'")?.permissionCoveredAllLayers).toBe(true);
  });
  it('malformed bodies cannot receive the parser-owned fallback', () => {
    const source = `const router=Router();router.post('/first',async(req,res)=>{
      // unmatched quote: '
      res.json({ok:true});`;
    expect(enumerateWriteRoutes(fixtureRepo(source)).routes.every(r => !r.bodyBounded && !r.permissionCoveredAllLayers)).toBe(true);
  });
  it('a nested registration cannot be swallowed into a bounded outer body', () => {
    const source = `${permissionImport}const router=Router();router.post('/outer',async(req,res)=>{
      // unmatched quote: '
      router.post('/inner',requirePermission('orders:write'),(req,res)=>res.end());res.end();});`;
    const measured = enumerateWriteRoutes(fixtureRepo(source));
    expect(measured.routes.find(r => r.pathKey === "'/outer'")?.bodyBounded).toBe(false);
    expect(measured.routes.find(r => r.pathKey === "'/inner'")?.permissionCoveredAllLayers).toBe(true);
  });
});

describe('G41 registration denominator and independent naked-route counterprobes', () => {
  const routeSource = `${identitySource}\n${permissionImport}\nconst router = Router();
    router.post('/identity', requireAgentActor, (req,res)=>res.end());
    router.post('/conditional', ${conditional}, (req,res)=>res.end());
    router.post('/unknown', mystery, (req,res)=>res.end());
    router.post('/bare', (req,res)=>res.end());
    router.post('/bare', (req,res)=>res.end());`;

  it('new bare writes and duplicate registrations stay in the denominator and signature multiplicity', () => {
    const result = enumerateWriteRoutes(fixtureRepo(routeSource));
    expect(result.routes).toHaveLength(5);
    expect(summarize(result.routes).total).toBe(5);
    const identity = result.routes.find(r => r.pathKey === "'/identity'");
    expect(identity?.authnCoveredAllLayers).toBe(true);
    expect(identity?.permissionCoveredAllLayers).toBe(false);
    expect(result.routes.find(r => r.pathKey === "'/conditional'")?.permissionCoveredAllLayers).toBe(true);
    expect(result.unknown.some(u => u.ident === 'mystery')).toBe(true);
    const bare = result.routes.filter(r => r.pathKey === "'/bare'");
    expect(bare).toHaveLength(2);
    expect(bare.every(r => !r.permissionCoveredAllLayers && !r.authnCoveredAllLayers)).toBe(true);
    expect(reconcileSiteLists({ registrations: [siteKey(bare[0])] }, { registrations: bare.map(siteKey) })).toHaveProperty('registrations');
  });

  it('line-only movement keeps signatures; new, removed and duplicate writes remain changes', () => {
    const before = enumerateWriteRoutes(fixtureRepo(routeSource)).routes.map(siteKey);
    const shifted = enumerateWriteRoutes(fixtureRepo('\n\n\n' + routeSource)).routes.map(siteKey);
    expect(reconcileSiteLists({ routes: before }, { routes: shifted })).toEqual({});
    const added = enumerateWriteRoutes(fixtureRepo(routeSource + "\nrouter.patch('/new-write', (req,res)=>res.end());")).routes.map(siteKey);
    expect(reconcileSiteLists({ routes: before }, { routes: added }).routes.added).toContain("server/src/index.ts:_ PATCH '/new-write'");
    expect(reconcileSiteLists({ routes: before }, { routes: shifted.slice(0, -1) })).toHaveProperty('routes');
    expect(new Set(before.map(siteSignature)).size).toBe(4);
  });
});


describe('G41 imported middleware provenance and real option semantics', () => {
  it('known auth APIs never become business authorization from a Write display name', () => {
    expect(classifyGuardArg('requireJwtForWrite({ requireAuth })', {}, moduleImport)).toBe('identity');
    expect(classifyGuardArg('requireJwtForWrite({ requireAuth })')).toBe('unknown');
    expect(classifyGuardArg('requireImaginaryWrite')).toBe('unknown');
    expect(extractLocalGuards(moduleImport + 'const requireOrdersWrite = requireJwtForWrite({requireAuth});').requireOrdersWrite)
      .toMatchObject({cls:'identity', booleanGated:true});
  });
  it('only the effective final requireAuth:true proves mandatory factory identity', () => {
    for (const text of ['{ requireAuth:true }', '{ ...options, requireAuth:true }'])
      expect(classifyVerifiedMiddlewareArgument(`createModuleAuthGuard(${text})`, moduleImport)?.booleanGated).toBe(false);
    for (const text of ['{ requireAuth:false }', '{ requireAuth }', 'options', '{ requireAuth:true, ...options }'])
      expect(classifyVerifiedMiddlewareArgument(`createModuleAuthGuard(${text})`, moduleImport)?.booleanGated).toBe(true);
    // Mentioning a boolean does not make a non-configurable JWT/DB loader optional.
    const currentImport = "import {createCurrentWriteActor} from '../auth/currentWriteActor';";
    expect(classifyVerifiedMiddlewareArgument('createCurrentWriteActor(prisma)', currentImport))
      .toMatchObject({cls:'identity',booleanGated:false});
  });
  it('aliases retain provenance; fake and locally shadowed symbols do not', () => {
    const imported = permissionImport.replace('requirePermission }','requirePermission as actualScope }');
    expect(classifyGuardArg("actualScope('orders:write')",{},imported)).toBe('permission');
    expect(classifyGuardArg("actualScope('orders:write')",{},imported.replace('../auth/permissionGuard','../fake/permissionGuard'))).toBe('unknown');
    expect(classifyGuardArg("actualScope('orders:write')",{},imported+'function fake(actualScope){}')).toBe('unknown');
  });
  it('a pure local auth factory follows the real delegated configuration, never the wrapper name', () => {
    const source = moduleImport+'function auth(options){return createModuleAuthGuard({...options,apiKeyActors:options.apiKeyActors});}';
    expect(classifyGuardArg('auth(options)',{},source)).toBe('identity');
    expect(classifyVerifiedMiddlewareArgument('auth(options)',source)?.booleanGated).toBe(true);
    expect(classifyGuardArg('auth(options)',{},source.replace('return createModuleAuthGuard','next(); return createModuleAuthGuard'))).toBe('unknown');
  });
  it('every accepted role branch must invoke its actual permission and unmatched roles deny', () => {
    const branch = `(req,res,next)=>{const role=String((req.body??{}).role??'');
      if(role==='production') return requirePermission('production:pp_release:production_sign')(req,res,next);
      if(role==='business') return requirePermission('production:pp_release:business_sign')(req,res,next);
      return res.status(400).json({error:'INVALID_ROLE'});}`;
    expect(classifyCompletePermissionMiddleware(branch,permissionImport)?.scopes).toEqual([
      'production:pp_release:production_sign','production:pp_release:business_sign']);
    for(const bad of [branch.replace('return res.status(400).json({error:\'INVALID_ROLE\'});','return next();'),
      branch.replace("return requirePermission('production:pp_release:business_sign')(req,res,next);",'return next();'),
      branch.replace('const role=', 'next(); const role=')]) expect(classifyCompletePermissionMiddleware(bad,permissionImport)).toBeNull();
    expect(classifyCompletePermissionMiddleware(branch,permissionImport+'function fake(String){}')).toBeNull();
  });
  it('server authSource gate is identity only; body source or nonterminal denial has no authority', () => {
    const gate = `(req,res,next)=>{if(req.authSource!=='user-session') return res.status(401).json({error:'UNAUTHORIZED'});next();}`;
    expect(classifyVerifiedMiddlewareArgument(gate,permissionImport)?.cls).toBe('identity');
    expect(classifyVerifiedMiddlewareArgument(gate.replace('req.authSource','req.body.authSource'),permissionImport)).toBeNull();
    expect(classifyVerifiedMiddlewareArgument(gate.replace('return res.status','res.status'),permissionImport)).toBeNull();
  });
});


describe('G41 actual composed identity then scope continuation',()=>{
  const source=moduleImport+permissionImport+`const jwt=requireJwtForWrite(options);
    const requireCrmWrite=(req,res,next)=>jwt(req,res,()=>requirePermission('crm:write')(req,res,next));`;
  it('scope is mandatory even when preceding JWT factory is configured off',()=>{
    expect(extractLocalGuards(source).requireCrmWrite).toMatchObject({cls:'permission',booleanGated:false,scopes:['crm:write']});
  });
  it.each([
    source.replace("()=>requirePermission('crm:write')(req,res,next)",'()=>next()'),
    source.replace("()=>requirePermission('crm:write')(req,res,next)","()=>flag?requirePermission('crm:write')(req,res,next):next()"),
    source.replace('../auth/moduleGuard','../fake/moduleGuard'),
    source.replace('const jwt=requireJwtForWrite(options)','const jwt=unknown(options)'),
    source.replace('jwt(req,res,','jwt(req.body,res,'),
  ])('incomplete/unknown continuation must remain unknown',bad=>{
    expect(extractLocalGuards(bad).requireCrmWrite?.cls).not.toBe('permission');
  });
});


describe('G41 parsers are visible but never authority',()=>{
  it('actual multer import and initializer count parser only, not arbitrary upload names',()=>{
    const source="import multer from 'multer';const upload=multer({storage:multer.memoryStorage()});";
    expect(classifyGuardArg("upload.single('file')",{},source)).toBe('nonPermission');
    expect(classifyGuardArg("upload.single('file')",{},source.replace("'multer'","'fake-multer'"))).toBe('unknown');
    expect(classifyGuardArg("upload.single('file')")).toBe('unknown');
    const wrapper="(req,res,next)=>{upload.single('file')(req,res,error=>{if(error)return res.status(400).end();next();});}";
    expect(classifyVerifiedMiddlewareArgument(wrapper,source)).toMatchObject({cls:'nonPermission'});
    expect(classifyVerifiedMiddlewareArgument(wrapper,source+'function fake(upload){}')).toBeNull();
  });
});

describe('G41 imported frozen role arrays require the actual local exported source', () => {
  const source = "import { requireRole as gate } from '../auth/middleware'; import { ROLES as roles } from './roles'; const write = [gate(...roles)];";
  function contextFor(remote: string) {
    const root = fixtureRepo(''); mkdirSync(join(root, 'server/src/orders'));
    const filename = join(root, 'server/src/orders/route.ts'); writeFileSync(filename, source);
    writeFileSync(join(root, 'server/src/orders/roles.ts'), remote);
    return { filename, root: join(root, 'server/src') };
  }
  it('resolved frozen literal array earns only the original requireRole evidence', () => {
    const context = contextFor("export const ROLES = Object.freeze(['owner','admin','manager'] as const);");
    expect(extractLocalGuards(source, context).write).toMatchObject({ cls: 'permission', unknownMembers: [], booleanGated: false });
    expect(extractLocalGuards(source).write?.unknownMembers).toEqual(['gate']);
    expect(classifyGuardArg('roles', {}, source, context)).toBe('unknown');
  });
  it('the imported literal-array bytes are included in independent source evidence', () => {
    const context = contextFor("export const ROLES = Object.freeze(['owner']);");
    writeFileSync(context.filename, source + "const router=Router();router.post('/x',...write,(req,res)=>res.end());");
    const root = join(context.root, '../..'), before = surfaceSourceEvidence(root);
    expect(before.files.some(file => file.file === 'server/src/orders/roles.ts')).toBe(true);
    writeFileSync(join(context.root, 'orders/roles.ts'), "export const ROLES = Object.freeze(['admin']);");
    expect(surfaceSourceEvidence(root).sha256).not.toBe(before.sha256);
  });
  it.each([
    "export const ROLES = ['owner'];",
    "const ROLES = Object.freeze(['owner']);",
    "export let ROLES = Object.freeze(['owner']);",
    "export const ROLES = Object.freeze([]);",
    "export const ROLES = Object.freeze([getRole()]);",
    "export const ROLES = Object.freeze(['owner', ...extra]);",
    "export const ROLES = Object.freeze(['owner']); function fake(Object) {}",
    "import Object from 'fake'; export const ROLES = Object.freeze(['owner']);",
    "Object.freeze = x => x; export const ROLES = Object.freeze(['owner']);",
    "export { ROLES } from './another';",
  ])('opaque/mutable/forged exports stay unknown: %s', remote => {
    expect(extractLocalGuards(source, contextFor(remote)).write?.unknownMembers).toEqual(['gate']);
  });
  it('shadowed imports, type imports and a relative path escaping the source root stay unknown', () => {
    const context = contextFor("export const ROLES = Object.freeze(['owner']);");
    for (const bad of [source + 'function fake(roles) {}', source.replace('import { ROLES', 'import type { ROLES'), source.replace("'./roles'", "'../../outside'")]) {
      expect(extractLocalGuards(bad, context).write?.unknownMembers).toEqual(['gate']);
    }
  });
});

describe('G41 additive data filters never become an authorization certificate', () => {
  const prefix = "import { safeRouteError } from '../shared/routeError';";
  const filter = `const scope = async(req,res,next)=>{try {
    const value = await getScope(req.actor); res.locals.scope = value; return next();
  } catch(error) { const safe = safeRouteError(error,{fallbackCode:'AUTHORIZATION_UNAVAILABLE'});
    return res.status(safe.status).json({ok:false,error:{code:safe.code,message:safe.message}}); }};`;
  it('recognizes the bounded filter but grants neither identity nor permission', () => {
    const source = prefix + filter;
    expect(extractLocalGuards(source).scope?.cls).toBe('nonPermission');
    const result = enumerateWriteRoutes(fixtureRepo(source + "const router=Router();router.post('/x',scope,(req,res)=>res.end());"));
    expect(result.routes[0]).toMatchObject({ authnCoveredAllLayers: false, permissionCoveredAllLayers: false });
    expect(summarize(result.routes).noEvidenceAtAll).toBe(1);
  });
  it('a curried filter with a local terminal error responder is also neutral', () => {
    const source = prefix + `const failure=(res,error)=>{const safe=safeRouteError(error,{fallbackCode:'INTERNAL_ERROR'});return res.status(safe.status).json({ok:false});};
    const scoped=mode=>async(req,res,next)=>{try{res.locals.scope=await getScope(req.actor,mode);next();}catch(error){failure(res,error);}};`;
    expect(classifyVerifiedMiddlewareArgument("scoped('write')", source)?.cls).toBe('nonPermission');
  });
  it.each([
    filter.replace('return next();', 'next(); return next();'),
    filter.replace('return res.status(safe.status)', 'next(); return res.status(safe.status)'),
    filter.replace('return res.status(safe.status)', 'res.status(safe.status)'),
    filter.replace('const value = await getScope(req.actor);', 'await mutateBusiness(req.body);'),
    filter.replace('{ok:false,error:{code:safe.code,message:safe.message}}', '{ok:next()}'),
    filter.replace('const safe = safeRouteError', 'const safe = unverifiedError'),
    filter.replace('catch(error)', 'finally'),
  ])('incomplete and unsafe filter paths remain unrecognized', bad => {
    expect(extractLocalGuards(prefix + bad).scope?.cls).not.toBe('nonPermission');
  });
  it('a fake error import cannot make the filter recognized', () => {
    expect(extractLocalGuards(prefix.replace('../shared/routeError','../fake/error') + filter).scope?.cls).not.toBe('nonPermission');
  });
});

describe('G41 current DB actor/scope continuation follows actual local and imported bodies', () => {
  // Read production source only; this fixture never imports runtime application
  // code or creates a Prisma client. Existing QC PG probes independently test
  // withdrawn grants, inactive accounts and [] / read-only credential ceilings.
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const route = readFileSync(join(repo, 'server/src/qc/qcRoute.ts'), 'utf8');
  function sourceFixture(changes: Record<string, (source: string) => string> = {}) {
    const root = fixtureRepo('');
    for (const file of ['qc/qcRoute.ts', 'qc/qcAssignmentAccess.ts', 'qc/qcReportAuthority.ts', 'auth/tokenHelpers.ts', 'auth/permissionService.ts',
      'auth/middleware.ts', 'shared/routeError.ts']) {
      mkdirSync(join(root, 'server/src', file, '..'), { recursive: true });
      const original = readFileSync(join(repo, 'server/src', file), 'utf8');
      writeFileSync(join(root, 'server/src', file), changes[file]?.(original) ?? original);
    }
    const context = { filename: join(root, 'server/src/qc/qcRoute.ts'), root: join(root, 'server/src') };
    return { root, context, source: readFileSync(context.filename, 'utf8') };
  }
  function evidence(changes: Record<string, (source: string) => string> = {}, argument = "assignmentActor('qc:write')") {
    const fixture = sourceFixture(changes);
    return { ...fixture, result: classifyCurrentActorContinuation(argument, fixture.source, fixture.context) };
  }
  it('the actual report error adapter retains transitive current grants and the mandatory session branch', () => {
    const fixture = evidence({}, "reportActor('qc:write')");
    expect(fixture.result).toMatchObject({ cls: 'permission', booleanGated: false, readScopeKnown: false, scopes: ['qc:write'] });
    expect(classifyCurrentActorContinuation("reportActor('qc:read')", fixture.source, fixture.context)?.readScopeKnown).toBe(true);
    expect(surfaceSourceEvidence(fixture.root).files.some(file => file.file === 'server/src/qc/qcReportAuthority.ts')).toBe(true);
  });
  it.each([
    ['scope from body', 'qc/qcRoute.ts', (s: string) => s.replace('await currentQcReportActor(prisma, request.actor ?? extractActorFromRequest(req), scope)', 'await currentQcReportActor(prisma, request.actor ?? extractActorFromRequest(req), req.body.scope)')],
    ['session bypass continues', 'qc/qcRoute.ts', (s: string) => s.replace("throw new QcReportError('UNAUTHORIZED', '验货报告写操作需要用户登录。');", 'return next();')],
    ['nonterminal report error', 'qc/qcRoute.ts', (s: string) => s.replace("return handleReportError(res, error, 'QC_AUTHORIZATION_FAILED');", 'return next();')],
    ['callback in error constructor', 'qc/qcReportAuthority.ts', (s: string) => s.replace("error.code === 'AUTHORIZATION_UNAVAILABLE' ? '暂时无法核验验货报告权限，请稍后重试。' : error.message", 'next()')],
    ['wrapper grants on failure', 'qc/qcReportAuthority.ts', (s: string) => s.replace('    throw error;\n', '    return prior;\n')],
    ['wrapper substitutes read permission', 'qc/qcReportAuthority.ts', (s: string) => s.replace('currentQcAssignmentActor(db, prior, scope)', "currentQcAssignmentActor(db, prior, 'qc:read')")],
    ['transitive cap omitted', 'qc/qcAssignmentAccess.ts', (s: string) => s.replace('if (prior.permissionCeiling !== undefined) actor.permissionCeiling = [...prior.permissionCeiling];', '')],
    ['transitive scope skipped', 'qc/qcAssignmentAccess.ts', (s: string) => s.replace('if (!hasScope({ ...actor, roles: [] }, scope))', 'if (false)')],
  ])('%s cannot earn report scope evidence', (_label, file, transform) => {
    const fixture = evidence({ [file]: transform }, "reportActor('qc:write')");
    expect(fixture.result).toBeNull();
    expect(enumerateWriteRoutes(fixture.root).unknown.some(item => item.ident === "reportActor('qc:write')")).toBe(true);
  });
  it('earns mandatory action evidence only after current DB grants/cap and terminal success', () => {
    const fixture = evidence();
    expect(fixture.result).toMatchObject({ cls: 'permission', booleanGated: false, readScopeKnown: false, scopes: ['qc:write'] });
    expect(classifyGuardArg("assignmentActor('qc:write')", {}, fixture.source, fixture.context)).toBe('permission');
    expect(classifyCurrentActorContinuation("assignmentActor('qc:read')", fixture.source, fixture.context)?.readScopeKnown).toBe(true);
    expect(classifyCurrentActorContinuation("assignmentActor(req.body.scope)", fixture.source, fixture.context)).toBeNull();
    expect(classifyCurrentActorContinuation("assignmentActor('qc:write')", route)).toBeNull();
  });
  it('renamed local factory and imported loader aliases retain body/provenance evidence', () => {
    const fixture = evidence({ 'qc/qcRoute.ts': source => source.replaceAll('assignmentActor', 'actualCurrentScope')
      .replace('currentQcAssignmentActor, QcAssignmentError', 'currentQcAssignmentActor as loadedCurrentActor, QcAssignmentError')
      .replace('await currentQcAssignmentActor(', 'await loadedCurrentActor(') }, "actualCurrentScope('qc:write')");
    expect(fixture.result?.cls).toBe('permission');
  });
  it.each([
    ['early next', (s: string) => s.replace('const request = req as', 'next(); const request = req as')],
    ['early conditional next', (s: string) => s.replace('const request = req as', 'if(req.body.skip)return next(); const request = req as')],
    ['unawaited load', (s: string) => s.replace('request.actor = await currentQcAssignmentActor', 'request.actor = currentQcAssignmentActor')],
    ['body actor', (s: string) => s.replace('request.actor ?? extractActorFromRequest(req)', 'req.body.actor')],
    ['body scope', (s: string) => s.replace('extractActorFromRequest(req), scope)', 'extractActorFromRequest(req), req.body.scope)')],
    ['after-load continuation before scope', (s: string) => s.replace('return next();\n    } catch', 'next(); return next();\n    } catch')],
    ['caught continuation', (s: string) => s.replace("return handleAssignmentError(res, error, 'QC_AUTHORIZATION_FAILED');", 'return next();')],
    ['nonterminal responder', (s: string) => s.replace('return res.status(result.status).json({ error: { code, message: result.message } });', 'res.status(result.status).json({ error: { code, message: result.message } });')],
    ['payload continues', (s: string) => s.replace('json({ error: { code, message: result.message } })', 'json({ error: next() })')],
    ['fake loader import', (s: string) => s.replace("'./qcAssignmentAccess'", "'./fakeAssignmentAccess'")],
    ['shadowed loader import', (s: string) => s + '\nfunction fake(currentQcAssignmentActor){}'],
    ['fake safe error import', (s: string) => s.replace("'../shared/routeError'", "'../shared/fakeRouteError'")],
    ['mutable factory', (s: string) => s.replace('const assignmentActor =', 'let assignmentActor =')],
    ['reassigned factory', (s: string) => s + '\nassignmentActor=()=>next=>next();'],
  ])('%s remains unknown even alongside a genuine requirePermission', (_label, transform) => {
    const fixture = evidence({ 'qc/qcRoute.ts': transform });
    expect(fixture.result).toBeNull();
    const scanned = enumerateWriteRoutes(fixture.root);
    expect(scanned.unknown.some(item => item.ident === "assignmentActor('qc:write')")).toBe(true);
    expect(scanned.routes.find(item => item.pathKey === "'/assignments'")?.permissionCoveredAllLayers).toBe(true);
  });
  it.each([
    ['skipped scope', (s: string) => s.replace('if (!hasScope({ ...actor, roles: [] }, scope))', 'if (false)')],
    ['ungated branch', (s: string) => s.replace('// Actual QC grants', "if(prior.roles?.includes('admin'))return actor;\n  // Actual QC grants")],
    ['lost ceiling', (s: string) => s.replace('if (prior.permissionCeiling !== undefined) actor.permissionCeiling = [...prior.permissionCeiling];', '')],
    ['empty ceiling skipped', (s: string) => s.replace('prior.permissionCeiling !== undefined', 'prior.permissionCeiling?.length')],
    ['role fallback retained', (s: string) => s.replace('{ ...actor, roles: [] }', 'actor')],
    ['inactive admitted', (s: string) => s.replace("user.status !== 'active'", 'false')],
    ['scope changed', (s: string) => s.replace('{ ...actor, roles: [] }, scope', "{ ...actor, roles: [] }, 'qc:read'")],
    ['fake DB auth import', (s: string) => s.replace("'../auth/tokenHelpers'", "'../auth/fakeTokenHelpers'")],
  ])('%s in the real exported dependency is not a verified guard', (_label, transform) => {
    const fixture = evidence({ 'qc/qcAssignmentAccess.ts': transform });
    expect(fixture.result).toBeNull();
    expect(classifyGuardArg("assignmentActor('qc:write')", {}, fixture.source, fixture.context)).toBe('unknown');
  });
  it.each([
    ['fake current DB loader', 'auth/tokenHelpers.ts', (s: string) => s.replace('return prisma.userAccount.findFirst({', 'return getCachedUser({')],
    ['old permissions builder', 'auth/tokenHelpers.ts', (s: string) => s.replace('const permissions = await loadEffectivePermissionScopes(prisma, user.id, payload.permissions);', 'const permissions = payload.permissions;')],
    ['forged permissions', 'auth/tokenHelpers.ts', (s: string) => s.replace('const permissions = collectPermissionScopes(user.roles || []);', "const permissions = ['*'];")],
    ['ceiling erased in scope contract', 'auth/permissionService.ts', (s: string) => s.replace("if (actor.permissionCeiling && !actor.permissionCeiling.includes('*') && !actor.permissionCeiling.includes(scope)) return false;", '')],
    ['expired grants allowed', 'auth/permissionService.ts', (s: string) => s.replace('OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],', '')],
    ['unconditional management shortcut', 'auth/permissionService.ts', (s: string) => s.replace("return !!actor.roles?.some(role => role === 'owner'", "return true || !!actor.roles?.some(role => role === 'owner'")],
  ])('%s cannot be laundered by an unchanged genuine import path', (_label, file, transform) => {
    expect(evidence({ [file]: transform }).result).toBeNull();
  });
  it('transitive actual loader and token builder bytes participate in source evidence', () => {
    const fixture = evidence(), first = surfaceSourceEvidence(fixture.root);
    for (const file of ['server/src/qc/qcAssignmentAccess.ts', 'server/src/auth/tokenHelpers.ts'])
      expect(first.files.some(item => item.file === file)).toBe(true);
    writeFileSync(join(fixture.context.root, 'auth/tokenHelpers.ts'), readFileSync(join(fixture.context.root, 'auth/tokenHelpers.ts'), 'utf8') + '\n// source drift');
    expect(surfaceSourceEvidence(fixture.root).sha256).not.toBe(first.sha256);
  });
});

describe('G41 re-freeze requires exact same-source old/new correction readings', () => {
  function proofFixture() {
    const source = "const router=Router();router.post('/bare',(req,res)=>res.end());";
    const root = fixtureRepo(source), result = enumerateWriteRoutes(root), evidence = surfaceSourceEvidence(root);
    const files = [{ file: 'server/src/index.ts', sha256: createHash('sha256').update(source).digest('hex') }];
    const application = { files, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
    const read = { applicationSourceDigest: application.sha256, routes: result.routes, unknown: result.unknown, summary: summarize(result.routes),
      scannerEvidence: [{ file: 'controlled-source-reader', sha256: createHash('sha256').update('controlled reader').digest('hex') }] };
    return { result, evidence, proof: { sourceEvidence: evidence, applicationSourceEvidence: application,
      before: { ...read, measurement: 'controlled-old-reader' }, after: { ...read, measurement: SURFACE_MEASUREMENT_VERSION } } };
  }
  it('accepts structurally consistent readings without pretending a new registration is measurement drift', () => {
    const fixture = proofFixture(); expect(validateMeasurementCorrection(fixture.proof, fixture.result, fixture.evidence)).toEqual([]);
  });
  it.each([
    ['missing raw before routes', (p: any) => { delete p.before.routes; }],
    ['summary lies about denominator', (p: any) => { p.after.summary.total += 1; }],
    ['source bytes changed', (p: any) => { p.applicationSourceEvidence.files[0].sha256 = 'forged'; }],
    ['two different application source snapshots', (p: any) => { p.before.applicationSourceDigest = 'other'; }],
    ['new registration disguised as correction', (p: any) => { p.before.routes = []; p.before.summary = summarize([]); }],
    ['duplicate registration erased', (p: any) => { p.before.routes.push(p.before.routes[0]); p.before.summary = summarize(p.before.routes); }],
    ['current raw permission result changed', (p: any) => { p.after.routes[0].permissionCoveredAllLayers = true; p.after.summary = summarize(p.after.routes); }],
    ['unknown rows removed', (p: any) => { p.after.unknown.push({ file:'server/src/index.ts', line:1, ident:'unmeasured' }); }],
  ])('%s rejects the baseline rewrite', (_label, mutate) => {
    const fixture = proofFixture(), altered = structuredClone(fixture.proof); mutate(altered);
    expect(validateMeasurementCorrection(altered, fixture.result, fixture.evidence).length).toBeGreaterThan(0);
  });
});
