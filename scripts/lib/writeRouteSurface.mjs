/**
 * G4.1 source-only write-route measurement. Registration multiplicity is kept.
 * Identity and permission are separate, imported APIs require provenance, and
 * local middleware is traced through its actual initializer/function body.
 * Unknown shapes remain explicit. Legacy body/mount presence heuristics are
 * finite static evidence, not proof of fresh grants, row visibility, every
 * control-flow path, or HTTP interception. No application code is executed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { extractVerifiedMiddlewareDefinitions, classifyVerifiedMiddlewareArgument } from '../g41-write-surface-scanner.mjs';

export const SURFACE_MEASUREMENT_VERSION = '2026-10-03-conditional-native-archive-continuation-v5';

const unwrapEvidence = node => {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
    || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node))) node = node.expression;
  return node;
};
const evidenceSources = new Map();
const evidenceSource = text => {
  if (!evidenceSources.has(text)) evidenceSources.set(text, ts.createSourceFile('surface.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
  return evidenceSources.get(text);
};
const evidenceBindings = new WeakMap();
const evidenceFunctions = source => {
  if (evidenceBindings.has(source)) return evidenceBindings.get(source);
  const bindings = new Map();
  const visit = node => {
    if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name)) {
      const prior = bindings.get(node.name.text) ?? []; prior.push(node); bindings.set(node.name.text, prior);
    }
    ts.forEachChild(node, visit);
  };
  visit(source); evidenceBindings.set(source, bindings); return bindings;
};
function mutatesEvidenceBinding(source, name) {
  let mutation = false;
  const visit = node => {
    if ((ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
      || ts.isPostfixUnaryExpression(node) || (ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator))) {
      let target = unwrapEvidence(ts.isBinaryExpression(node) ? node.left : node.operand);
      while (target && (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target))) target = unwrapEvidence(target.expression);
      if (target && ts.isIdentifier(target) && target.text === name) mutation = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source); return mutation;
}
function evidenceImport(source, name, context) {
  if (!name || evidenceFunctions(source).has(name) || mutatesEvidenceBinding(source, name)) return null;
  const imports = source.statements.filter(ts.isImportDeclaration).flatMap(statement => {
    if (statement.importClause?.isTypeOnly || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
    const named = statement.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) return [];
    return named.elements.filter(element => !element.isTypeOnly && element.name.text === name)
      .map(element => ({ module: statement.moduleSpecifier.text, exported: element.propertyName?.text ?? element.name.text }));
  });
  if (imports.length !== 1 || !imports[0].module.startsWith('.') || !context?.filename || !context?.root) return null;
  const absolute = path.resolve(path.dirname(context.filename), imports[0].module + '.ts');
  try {
    const root = fs.realpathSync(context.root), filename = fs.realpathSync(absolute);
    if (!filename.startsWith(root + path.sep)) return null;
    const text = fs.readFileSync(filename, 'utf8'), remote = evidenceSource(text);
    if (remote.parseDiagnostics.length) return null;
    const definitions = evidenceFunctions(remote).get(imports[0].exported);
    if (definitions?.length !== 1 || !ts.isFunctionDeclaration(definitions[0])
      || !definitions[0].modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) return null;
    context.dependencies?.add(filename);
    return { ...imports[0], filename, source: remote, definition: definitions[0] };
  } catch { return null; }
}
const callEvidence = node => { node = unwrapEvidence(node); return node && ts.isCallExpression(node) ? node : null; };
const declarationEvidence = statement => ts.isVariableStatement(statement ?? {}) && statement.declarationList.declarations.length === 1
  ? statement.declarationList.declarations[0] : null;
const namesEvidence = fn => fn?.parameters.map(parameter => ts.isIdentifier(parameter.name) ? parameter.name.text : null);

/** Compare executable AST structure, ignoring type-only wrappers and inert throw
 * messages. Extra branches, early continuation, call-side effects and omitted
 * cap copies cannot match. No middleware/export display name earns authority. */
function evidenceShape(node, aliases = {}) {
  node = unwrapEvidence(node);
  if (!node) return null;
  if (ts.isThrowStatement(node)) {
    const value = unwrapEvidence(node.expression);
    if (ts.isIdentifier(value)) return ['throw', aliases[value.text] ?? value.text];
    if (!ts.isNewExpression(value) || !ts.isIdentifier(value.expression)
      || !(value.arguments ?? []).every(argument => ts.isStringLiteral(argument))) return ['unsafe-throw', evidenceShape(value, aliases)];
    return ['throw-new'];
  }
  if (ts.isIdentifier(node)) return ['identifier', aliases[node.text] ?? node.text];
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return [node.kind, node.text];
  const children = [];
  ts.forEachChild(node, child => { if (child !== node.type && !ts.isTypeNode(child)) children.push(evidenceShape(child, aliases)); });
  return [node.kind, ts.isVariableDeclarationList(node) ? node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const) : null, ...children];
}
function matchesEvidence(body, template, aliases = {}) {
  const expected = evidenceSource(`function proof(){${template}}`).statements[0].body;
  return JSON.stringify(evidenceShape(body, aliases)) === JSON.stringify(evidenceShape(expected));
}
function loadedAuthContracts(load, build, scope, context) {
  const [db, userId] = namesEvidence(load.definition) ?? [];
  const [builderDb, user] = namesEvidence(build.definition) ?? [];
  const [actor, requestedScope] = namesEvidence(scope.definition) ?? [];
  if (!db || !userId || !builderDb || !user || !actor || !requestedScope) return false;
  const loadShape = matchesEvidence(load.definition.body, `return prisma.userAccount.findFirst({
    where:{id:userId,deletedAt:null},include:{roles:{include:{role:{include:{permissions:{include:{permission:true}}}}}},primaryDepartment:true}});`,
  { [db]: 'prisma', [userId]: 'userId' });
  const buildShape = matchesEvidence(build.definition.body, `
    if(user.status!=='active'||user.deletedAt!=null) throw new Error('inactive');
    if(!Array.isArray(user.roles)||user.roles.some(ur=>!Array.isArray(ur.role?.permissions))) {throw new Error('roles');}
    const payload=buildAuthTokenPayload(user);const permissions=await loadEffectivePermissionScopes(prisma,user.id,payload.permissions);
    return {...payload,permissions,authorizationLoaded:true};`, { [builderDb]: 'prisma', [user]: 'user' });
  const scopeShape = matchesEvidence(scope.definition.body, `
    if(!actor)return false;
    if(actor.permissionCeiling&&!actor.permissionCeiling.includes('*')&&!actor.permissionCeiling.includes(scope))return false;
    if(isSuperAdminActor(actor))return true;
    if(actor.authorizationLoaded===true||(actor.permissions?.length??0)>0){return actor.permissions?.includes(scope)??false;}
    const roleIdsFromLegacy=(actor.roles||[]).flatMap(role=>LEGACY_TO_ROLE_ID[role]||[]);
    return fallbackHasPermission(roleIdsFromLegacy,scope);`, { [actor]: 'actor', [requestedScope]: 'scope' });
  const grants = evidenceImport(build.source, 'loadEffectivePermissionScopes', { ...context, filename: build.filename });
  const grantsShape = grants?.filename === scope.filename && matchesEvidence(grants.definition.body, `
    const scopes=new Set(Array.from(roleScopes).filter(Boolean));
    const overrides=await prisma.userPermissionOverrides.findMany({where:{userId,isActive:true,deletedAt:null,
      OR:[{expiresAt:null},{expiresAt:{gt:new Date()}}]},select:{scope:true}});
    for(const grant of overrides)if(grant.scope)scopes.add(grant.scope);return Array.from(scopes).sort();`);
  const helpers = evidenceFunctions(build.source), permissionHelpers = evidenceFunctions(scope.source);
  const projection = helpers.get('buildAuthTokenPayload'), collection = helpers.get('collectPermissionScopes');
  const superAdmin = permissionHelpers.get('isSuperAdminActor');
  const projectionShape = projection?.length === 1 && matchesEvidence(projection[0].body, `
    const {legacy:roles,newRoleIds}=userRolesToLegacyAgentRoles((user.roles||[]).map(ur=>({roleId:ur.roleId,role:ur.role})));
    const permissions=collectPermissionScopes(user.roles||[]);
    const departmentIds=(user.roles||[]).map(ur=>ur.departmentId).filter(Boolean);
    return {userId:user.id,displayName:user.displayName,roles,roleIds:newRoleIds,permissions,
      departmentIds:departmentIds.length?departmentIds:[user.primaryDeptId||'company']};`);
  const collectionShape = collection?.length === 1 && matchesEvidence(collection[0].body, `
    const scopes=new Set();for(const userRole of roles){for(const rolePermission of userRole.role?.permissions||[]){
      const scope=rolePermission.permission?.scope;if(scope)scopes.add(scope);}}return Array.from(scopes).sort();`);
  const superAdminShape = superAdmin?.length === 1 && matchesEvidence(superAdmin[0].body,
    `return !!actor.roles?.some(role=>role==='owner'||role===SYSTEM_ROLE_IDS.SUPER_ADMIN);`);
  return loadShape && buildShape && scopeShape && grantsShape && projectionShape && collectionShape && superAdminShape;
}
function currentScopeLoader(proof, context, depth = 0) {
  const fn = proof.definition, params = namesEvidence(fn);
  if (!fn.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) || params?.length !== 3 || params.some(name => !name) || !fn.body) return false;
  // A finite error adapter can delegate the entire identity/scope decision.
  // Follow the real relative import; a changed wrapper, early return, changed
  // scope or callback argument cannot inherit the underlying loader's proof.
  const wrapper = fn.body.statements.length === 1 && ts.isTryStatement(fn.body.statements[0]) ? fn.body.statements[0] : null;
  if (wrapper && depth < 2) {
    const statement = wrapper.tryBlock.statements[0];
    const awaited = ts.isReturnStatement(statement ?? {}) ? unwrapEvidence(statement.expression) : null;
    const delegate = awaited && ts.isAwaitExpression(awaited) ? callEvidence(awaited.expression) : null;
    const caught = wrapper.catchClause?.variableDeclaration?.name;
    if (!delegate || !ts.isIdentifier(delegate.expression) || !ts.isIdentifier(caught ?? {})) return false;
    const imported = evidenceImport(proof.source, delegate.expression.text, { ...context, filename: proof.filename });
    if (!imported || !currentScopeLoader(imported, context, depth + 1)) return false;
    const aliases = Object.fromEntries([...params.map((name, index) => [name, ['db', 'prior', 'scope'][index]]),
      [delegate.expression.text, 'load'], [caught.text, 'error']]);
    return matchesEvidence(fn.body, `try { return await load(db,prior,scope); } catch(error) {
      if(error instanceof QcAssignmentError) throw new QcReportError(error.code,
        error.code==='AUTHORIZATION_UNAVAILABLE'?'暂时无法核验验货报告权限，请稍后重试。':error.message); throw error;
    }`, aliases);
  }
  const [deny, actorDeclaration, guarded] = fn.body.statements;
  const actor = declarationEvidence(actorDeclaration), user = ts.isTryStatement(guarded ?? {}) ? declarationEvidence(guarded.tryBlock.statements[0]) : null;
  const firstThrow = ts.isIfStatement(deny ?? {}) ? deny.thenStatement : null;
  const thrown = firstThrow && ts.isThrowStatement(firstThrow) ? unwrapEvidence(firstThrow.expression) : null;
  const awaitedLoad = user?.initializer && ts.isAwaitExpression(unwrapEvidence(user.initializer)) ? callEvidence(unwrapEvidence(user.initializer).expression) : null;
  const assignment = guarded?.tryBlock?.statements[2];
  const builder = assignment && ts.isExpressionStatement(assignment) && ts.isBinaryExpression(assignment.expression)
    && ts.isAwaitExpression(unwrapEvidence(assignment.expression.right)) ? callEvidence(unwrapEvidence(assignment.expression.right).expression) : null;
  const scopeCheck = fn.body.statements[3], negation = ts.isIfStatement(scopeCheck ?? {}) ? unwrapEvidence(scopeCheck.expression) : null;
  const checker = negation && ts.isPrefixUnaryExpression(negation) ? callEvidence(negation.operand) : null;
  if (!actor || !ts.isIdentifier(actor.name) || !user || !ts.isIdentifier(user.name) || !thrown || !ts.isNewExpression(thrown)
    || !ts.isIdentifier(thrown.expression) || !awaitedLoad || !ts.isIdentifier(awaitedLoad.expression) || !builder || !ts.isIdentifier(builder.expression)
    || !checker || !ts.isIdentifier(checker.expression) || !guarded.catchClause || !ts.isIdentifier(guarded.catchClause.variableDeclaration?.name)) return false;
  const remoteContext = { ...context, filename: proof.filename };
  const load = evidenceImport(proof.source, awaitedLoad.expression.text, remoteContext);
  const build = evidenceImport(proof.source, builder.expression.text, remoteContext);
  const scope = evidenceImport(proof.source, checker.expression.text, remoteContext);
  if (load?.filename !== path.join(context.root, 'auth/tokenHelpers.ts') || load.exported !== 'loadUserWithRoles'
    || build?.filename !== load.filename || build.exported !== 'buildLoadedAuthTokenPayload'
    || scope?.filename !== path.join(context.root, 'auth/permissionService.ts') || scope.exported !== 'hasScope'
    || !loadedAuthContracts(load, build, scope, context)) return false;
  const aliases = Object.fromEntries([...params.map((name, index) => [name, ['db', 'prior', 'scope'][index]]),
    [actor.name.text, 'actor'], [user.name.text, 'user'], [thrown.expression.text, 'DomainError'],
    [guarded.catchClause.variableDeclaration.name.text, 'error'], [awaitedLoad.expression.text, 'loadUserWithRoles'],
    [builder.expression.text, 'buildLoadedAuthTokenPayload'], [checker.expression.text, 'hasScope']]);
  return matchesEvidence(fn.body, `
    if(!prior?.userId) throw new DomainError('UNAUTHORIZED','denied'); let actor;
    try { const user=await loadUserWithRoles(db,prior.userId);
      if(!user || user.status!=='active' || user.deletedAt!=null) {throw new DomainError('ACCOUNT_DISABLED','denied');}
      actor=await buildLoadedAuthTokenPayload(db,user);
      if(prior.permissionCeiling!==undefined) actor.permissionCeiling=[...prior.permissionCeiling];
    } catch(error) {if(error instanceof DomainError) throw error;throw new DomainError('AUTHORIZATION_UNAVAILABLE','denied');}
    if(!hasScope({...actor,roles:[]},scope)) {throw new DomainError('FORBIDDEN','denied');} return actor;`, aliases);
}
function terminalEvidenceResponder(declaration, source, context) {
  const fn = unwrapEvidence(declaration?.initializer), params = namesEvidence(fn);
  if (!fn || !ts.isArrowFunction(fn) || params?.length !== 3 || params.some(name => !name) || !ts.isBlock(fn.body)) return false;
  const logging = fn.body.statements[0];
  const log = ts.isExpressionStatement(logging ?? {}) ? callEvidence(logging.expression) : null;
  const hasLogging = !!log && ts.isPropertyAccessExpression(log.expression) && log.expression.name.text === 'error';
  const start = hasLogging ? 1 : 0;
  const [failureStatement, safeStatement] = [...fn.body.statements].slice(start);
  const failure = declarationEvidence(failureStatement), safe = declarationEvidence(safeStatement), safeCall = callEvidence(safe?.initializer);
  if (!failure || !ts.isIdentifier(failure.name) || !safe || !ts.isIdentifier(safe.name) || !safeCall || !ts.isIdentifier(safeCall.expression)
    ) return false;
  const safeImport = evidenceImport(source, safeCall.expression.text, context);
  if (safeImport?.filename !== path.join(context.root, 'shared/routeError.ts') || safeImport.exported !== 'safeRouteError') return false;
  // Responses may transform known errors, but cannot pass/alias next or invoke
  // arbitrary payload code. Every branch is a terminal res.status(...).json(...).
  const pure = node => {
    node = unwrapEvidence(node); if (!node) return true;
    if (ts.isCallExpression(node) || ts.isNewExpression(node) || (ts.isIdentifier(node) && node.text === 'next')
      || (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment)) return false;
    let ok = true; ts.forEachChild(node, child => { if (!pure(child)) ok = false; }); return ok;
  };
  const response = statement => {
    if (ts.isBlock(statement)) return statement.statements.length === 1 && response(statement.statements[0]);
    const json = ts.isReturnStatement(statement) ? callEvidence(statement.expression) : null;
    const status = json && ts.isPropertyAccessExpression(json.expression) && json.expression.name.text === 'json' ? callEvidence(json.expression.expression) : null;
    return !!status && ts.isPropertyAccessExpression(status.expression) && status.expression.name.text === 'status'
      && ts.isIdentifier(status.expression.expression) && status.expression.expression.text === params[0]
      && status.arguments.length === 1 && ts.isPropertyAccessExpression(unwrapEvidence(status.arguments[0]))
      && unwrapEvidence(status.arguments[0]).expression.getText(source) === safe.name.text
      && unwrapEvidence(status.arguments[0]).name.text === 'status' && json.arguments.every(pure);
  };
  const failureCall = callEvidence(failure.initializer);
  if (!failureCall || !ts.isIdentifier(failureCall.expression) || !evidenceImport(source, failureCall.expression.text, context)
    || failureCall.arguments.length !== 1 || failureCall.arguments[0].getText(source) !== params[1]
    || safeCall.arguments[0]?.getText(source) !== failure.name.text || !safeCall.arguments.slice(1).every(pure)
    || (hasLogging && !log.arguments.every(pure))) return false;
  const rest = [...fn.body.statements].slice(start + 2), last = rest.pop();
  if (!response(last)) return false;
  return rest.every(statement => (ts.isIfStatement(statement) && !statement.elseStatement && pure(statement.expression) && response(statement.thenStatement))
    || (ts.isVariableStatement(statement) && statement.declarationList.declarations.every(item => pure(item.initializer))));
}

/** Narrow curried current-DB actor -> literal scope -> terminal continuation.
 * Relative imported loader bytes and transitive auth contracts are included in
 * the manifest. Unsupported wrappers remain unknown even next to a known gate. */
export function classifyCurrentActorContinuation(argText, src, context) {
  if (!context?.root || !context?.filename) return null;
  try { context = { ...context, root: fs.realpathSync(context.root), filename: fs.realpathSync(context.filename) }; }
  catch { return null; }
  const source = evidenceSource(src), argumentSource = evidenceSource(`const value=${argText};`);
  if (source.parseDiagnostics.length || argumentSource.parseDiagnostics.length) return null;
  const invoke = callEvidence(argumentSource.statements[0]?.declarationList?.declarations[0]?.initializer);
  if (!invoke || !ts.isIdentifier(invoke.expression) || invoke.arguments.length !== 1 || !ts.isStringLiteral(invoke.arguments[0])
    || !/^[a-z][a-z0-9_:]*:(read|write)$/.test(invoke.arguments[0].text)) return null;
  const bindings = evidenceFunctions(source), declarations = bindings.get(invoke.expression.text);
  const factory = declarations?.length === 1 && ts.isVariableDeclaration(declarations[0]) ? unwrapEvidence(declarations[0].initializer) : null;
  const middleware = factory && ts.isArrowFunction(factory) ? unwrapEvidence(factory.body) : null;
  if (!middleware || !ts.isArrowFunction(middleware) || namesEvidence(factory)?.length !== 1
    || !(declarations[0].parent.flags & ts.NodeFlags.Const) || mutatesEvidenceBinding(source, invoke.expression.text)
    || !middleware.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    || JSON.stringify(namesEvidence(middleware)) !== JSON.stringify(['req', 'res', 'next']) || !ts.isBlock(middleware.body)
    || middleware.body.statements.length !== 1 || !ts.isTryStatement(middleware.body.statements[0])) return null;
  const guarded = middleware.body.statements[0], local = declarationEvidence(guarded.tryBlock.statements[0]);
  const requiresSession = ts.isIfStatement(guarded.tryBlock.statements[1] ?? {});
  const assignment = guarded.tryBlock.statements[requiresSession ? 2 : 1];
  const awaited = assignment && ts.isExpressionStatement(assignment) && ts.isBinaryExpression(assignment.expression)
    && ts.isAwaitExpression(unwrapEvidence(assignment.expression.right)) ? callEvidence(unwrapEvidence(assignment.expression.right).expression) : null;
  const caught = guarded.catchClause?.block.statements[0], responder = ts.isReturnStatement(caught ?? {}) ? callEvidence(caught.expression) : null;
  if (!local || !ts.isIdentifier(local.name) || !awaited || !ts.isIdentifier(awaited.expression) || !responder || !ts.isIdentifier(responder.expression)
    || !ts.isIdentifier(guarded.catchClause?.variableDeclaration?.name) || awaited.arguments.length !== 3 || !ts.isIdentifier(awaited.arguments[0])) return null;
  const loader = evidenceImport(source, awaited.expression.text, context);
  const errorDeclarations = bindings.get(responder.expression.text);
  if (!loader || !currentScopeLoader(loader, context) || errorDeclarations?.length !== 1
    || !terminalEvidenceResponder(errorDeclarations[0], source, context)) return null;
  const fallback = unwrapEvidence(awaited.arguments[1]);
  const extract = ts.isBinaryExpression(fallback) ? callEvidence(fallback.right) : null;
  if (!extract || !ts.isIdentifier(extract.expression)) return null;
  const extraction = evidenceImport(source, extract.expression.text, context);
  if (extraction?.filename !== path.join(context.root, 'auth/middleware.ts') || extraction.exported !== 'extractActorFromRequest') return null;
  const aliases = { [local.name.text]: 'request', [namesEvidence(factory)[0]]: 'scope', [awaited.expression.text]: 'currentActor',
    [awaited.arguments[0].text]: 'prisma', [extract.expression.text]: 'extractActor', [responder.expression.text]: 'failure',
    [guarded.catchClause.variableDeclaration.name.text]: 'error' };
  const sessionCheck = requiresSession ? `if(scope==='qc:write'&&request.authSource!=='user-session'){
    throw new Error('UNAUTHORIZED','denied');}` : '';
  if (!matchesEvidence(middleware.body, `try{const request=req;${sessionCheck}
    request.actor=await currentActor(prisma,request.actor??extractActor(req),scope);return next();
    }catch(error){return failure(res,error,'QC_AUTHORIZATION_FAILED');}`, aliases)) return null;
  return { cls: 'permission', booleanGated: false, readScopeKnown: invoke.arguments[0].text.endsWith(':read'),
    scopes: [invoke.arguments[0].text], provenance: `${path.relative(context.root, loader.filename)}#${loader.exported}: current DB scope/cap + terminal continuation` };
}


/** A read-only native archive branch and its write fallback share a POST. This
 * finite source proof does not exempt a middleware name or guess conditional
 * scopes. Every archive is awaited, the request marker is unique, and the actual
 * generating handler must refuse a missing archive before calling its producer.
 * Native scope-loader dependencies enter the source fingerprint; row visibility
 * and PostgreSQL races still require the independent business/HTTP controls. */
function documentActorScopeContract(proof, context) {
  const fn = proof.definition, params = namesEvidence(fn);
  if (params?.length !== 3 || params.some(name => !name) || !fn.body
    || !fn.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword) || fn.parameters.some(p=>p.initializer||p.dotDotDotToken)) return false;
  const remoteContext = { ...context, filename: proof.filename };
  const load = evidenceImport(proof.source, 'loadUserWithRoles', remoteContext);
  const build = evidenceImport(proof.source, 'buildLoadedAuthTokenPayload', remoteContext);
  const scope = evidenceImport(proof.source, 'hasScope', remoteContext);
  if (!load || !build || !scope || !loadedAuthContracts(load, build, scope, context)) return false;
  return matchesEvidence(fn.body, `
    if(!prior?.userId) throw businessError('UNAUTHORIZED','请使用当前账号读取业务单据。');
    let actor;
    try {const user=await loadUserWithRoles(tx,prior.userId);
      if(!user||user.status!=='active'||user.deletedAt!=null) throw businessError('ACCOUNT_DISABLED','当前账号不可用。');
      actor=await buildLoadedAuthTokenPayload(tx,user);
    }catch(error){if(isBusinessError(error))throw error;throw businessError('AUTHORIZATION_UNAVAILABLE','当前单据权限暂时无法核验。');}
    if(prior.permissionCeiling!==undefined)actor.permissionCeiling=[...prior.permissionCeiling];
    for(const scope of scopes)if(!hasScope(actor,scope))throw businessError('FORBIDDEN','当前账号没有来源单据权限。');return actor;`,
    Object.fromEntries(params.map((name,i)=>[name,['tx','prior','scopes'][i]])));
}
function nativeArchiveScopeContract(proof, context) {
  const fn = proof.definition, params = namesEvidence(fn);
  if (params?.length !== 3 || params.some(name => !name) || !fn.body
    || !fn.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword) || fn.parameters.some(p=>p.initializer||p.dotDotDotToken)) return false;
  const actor = evidenceImport(proof.source, 'currentDocumentActor', { ...context, filename: proof.filename });
  const history = evidenceImport(proof.source, 'readHistoricalCiDocumentInTx', { ...context, filename: proof.filename });
  if (!actor || !history || !documentActorScopeContract(actor, context)) return false;
  // Whole native read-validator shape: no extra writes, swallowed refusal,
  // early success, substituted identity or omitted final authority read.
  return matchesEvidence(fn.body, String.raw`
    await prisma.$transaction(async tx=>{
      await currentDocumentActor(tx,trustedActor,['customs:read']);
      const actual=await tx.tradeDocument.findFirst({where:{id:requested.id,deletedAt:null}});
      if(!actual)throw businessError('NOT_FOUND','归档单据不存在。');
      const requestedPath=typeof requested.filePath==='string'?path.posix.normalize(requested.filePath):null;
      const ciPrefix=requestedPath?.startsWith('trade-documents/ci-');
      const generations=requestedPath?await tx.auditLog.findMany({where:{action:'TRADE_DOCUMENT_FILE_GENERATED',detail:{path:['filePath'],equals:requestedPath}}}):[];
      const native=generations.find(row=>typeof row.detail?.sourceInvoiceId==='string');
      if(actual.type!=='CommercialInvoice'&&!ciPrefix&&!native)return;
      if(actual.type!=='CommercialInvoice'||actual.filePath!==requested.filePath||!requestedPath)throw businessError('CONFLICT','归档文件不属于当前原商业发票。');
      const detail=native?.detail;
      const history=await readHistoricalCiDocumentInTx(tx,actual.id,{trustedActor:trustedActor??null,...(detail?.sourceSnapshot?{additionalSnapshots:[detail.sourceSnapshot]}:{})});
      if(ciPrefix||native){
        if(!detail?.sourceSnapshot||detail.sourceSnapshot.invoice?.id!==history.currentInvoice?.id||detail.sourceSnapshot.fingerprint!==detail.sourceFingerprint
          ||documentSourceFingerprint(Object.fromEntries(Object.entries(detail.sourceSnapshot).filter(([key])=>key!=='fingerprint')))!==detail.sourceFingerprint)
          throw businessError('CONFLICT','原归档文件的来源快照凭据损坏。');
        if(!native||native.targetId!==actual.id||detail.sourceInvoiceId!==history.currentInvoice?.id||typeof detail.sourceFingerprint!=='string'
          ||typeof detail.sha!=='string'||!/^[0-9a-f]{64}$/.test(detail.sha)||!Number.isSafeInteger(detail.fileSize)||detail.fileSize<=0||detail.fileName!==actual.fileName)
          throw businessError('CONFLICT','原发票归档来源未核验或已变化，请重新生成。');
      }else{
        const expectedStem=actual.id+'-'+actual.documentNumber.replace(/[^\w.-]/g,'_')+'-v';
        const legacy=await tx.auditLog.findMany({where:{action:'TRADE_DOCUMENT_FILE_GENERATED',targetType:'TradeDocument',targetId:actual.id}});
        if(!requestedPath.startsWith('trade-documents/'+expectedStem)||!legacy.some(row=>row.detail?.fileName===actual.fileName))
          throw businessError('CONFLICT','该历史归档文件没有原单据生成凭据，只能阅读原历史版本。');
      }
      await currentDocumentActor(tx,trustedActor,['customs:read',...(history.currentInvoice?['invoices:read']:[])]);
    },{isolationLevel:Prisma.TransactionIsolationLevel.ReadCommitted});`,
    Object.fromEntries(params.map((name,i)=>[name,['prisma','requested','trustedActor'][i]])));
}
export function classifyConditionalArchiveContinuation(argText, src, context) {
  if (!context?.root || !context?.filename) return null;
  try { context = { ...context, root: fs.realpathSync(context.root), filename: fs.realpathSync(context.filename) }; }
  catch { return null; }
  const source = evidenceSource(src), bindings = evidenceFunctions(source);
  const argument = unwrapEvidence(evidenceSource(`const value=${argText};`).statements[0]?.declarationList?.declarations[0]?.initializer);
  if (source.parseDiagnostics.length || !argument || !ts.isIdentifier(argument)) return null;
  const declarations = bindings.get(argument.text), declaration = declarations?.length === 1 ? declarations[0] : null;
  const fn = declaration && ts.isVariableDeclaration(declaration) ? unwrapEvidence(declaration.initializer) : null;
  if (!fn || !ts.isArrowFunction(fn) || !fn.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword)
    || JSON.stringify(namesEvidence(fn))!==JSON.stringify(['req','res','next']) || !ts.isBlock(fn.body)
    || !(declaration.parent.flags & ts.NodeFlags.Const) || mutatesEvidenceBinding(source,argument.text)) return null;
  const guarded = fn.body.statements.length===1 && ts.isTryStatement(fn.body.statements[0]) ? fn.body.statements[0] : null;
  const read = guarded?.tryBlock.statements[2], fallback = guarded?.tryBlock.statements[3];
  if (!read || !ts.isIfStatement(read) || !ts.isBlock(read.thenStatement) || !ts.isReturnStatement(fallback ?? {})) return null;
  const loop = read.thenStatement.statements[0];
  const awaited = ts.isForOfStatement(loop ?? {}) && ts.isExpressionStatement(loop.statement) ? unwrapEvidence(loop.statement.expression) : null;
  const validatorCall = awaited && ts.isAwaitExpression(awaited) ? callEvidence(awaited.expression) : null;
  const principalCall = validatorCall && callEvidence(validatorCall.arguments[2]);
  const mark = read.thenStatement.statements[1], markCall = ts.isExpressionStatement(mark ?? {}) ? callEvidence(mark.expression) : null;
  if (!validatorCall || !ts.isIdentifier(validatorCall.expression) || !principalCall || !ts.isIdentifier(principalCall.expression)
    || !markCall || !ts.isPropertyAccessExpression(markCall.expression) || !ts.isIdentifier(markCall.expression.expression)) return null;
  const markerName = markCall.expression.expression.text;
  const markerDeclarations = bindings.get(markerName), markerDeclaration = markerDeclarations?.length===1 ? markerDeclarations[0] : null;
  const markerInit = markerDeclaration && ts.isVariableDeclaration(markerDeclaration) ? unwrapEvidence(markerDeclaration.initializer) : null;
  if (!markerInit || !ts.isNewExpression(markerInit) || !ts.isIdentifier(markerInit.expression) || markerInit.expression.text!=='WeakSet'
    || (markerInit.arguments?.length ?? 0)!==0 || !(markerDeclaration.parent.flags & ts.NodeFlags.Const)
    || bindings.has('WeakSet') || mutatesEvidenceBinding(source,markerName)) return null;
  const validator = evidenceImport(source,validatorCall.expression.text,context);
  if (!validator || !nativeArchiveScopeContract(validator,context)) return null;
  const actorDeclarations = bindings.get(principalCall.expression.text), actorDeclaration = actorDeclarations?.length===1 ? actorDeclarations[0] : null;
  const actorFn = actorDeclaration && ts.isVariableDeclaration(actorDeclaration) ? unwrapEvidence(actorDeclaration.initializer) : null;
  if (!actorFn || !ts.isArrowFunction(actorFn) || JSON.stringify(namesEvidence(actorFn))!==JSON.stringify(['req','write'])
    || actorFn.parameters[0].initializer || actorFn.parameters.some(p=>p.dotDotDotToken)
    || unwrapEvidence(actorFn.parameters[1].initializer)?.kind!==ts.SyntaxKind.FalseKeyword
    || !(actorDeclaration.parent.flags & ts.NodeFlags.Const) || mutatesEvidenceBinding(source,principalCall.expression.text)
    || !matchesEvidence(actorFn.body,`const request=req;if(write&&request.authSource!=='user-session')throw businessError('UNAUTHORIZED','商业发票写操作需要用户登录。');return request.actor??extractActorFromRequest(req);`)) return null;
  const extractor = evidenceImport(source,'extractActorFromRequest',context);
  if (!extractor || extractor.filename!==path.join(context.root,'auth/middleware.ts')) return null;
  const fallbackCall = callEvidence(fallback.expression), continuation = fallbackCall && unwrapEvidence(fallbackCall.arguments[2]);
  const writeCall = continuation && ts.isArrowFunction(continuation) ? callEvidence(continuation.body) : null;
  if (!fallbackCall || !ts.isIdentifier(fallbackCall.expression) || !writeCall || !ts.isIdentifier(writeCall.expression)) return null;
  const defs = extractVerifiedMiddlewareDefinitions(src,context), identity = defs[fallbackCall.expression.text], write = defs[writeCall.expression.text];
  if (identity?.cls!=='identity' || !identity.provenance?.includes('#requireJwtForWrite')
    || write?.cls!=='permission' || JSON.stringify(write.scopes)!==JSON.stringify(['customs:write'])) return null;
  const aliases = { [validatorCall.expression.text]:'archive', [principalCall.expression.text]:'principal', [markerName]:'marker',
    [fallbackCall.expression.text]:'jwt', [writeCall.expression.text]:'writeGate' };
  if (!matchesEvidence(fn.body,`try{
    const ids=[...new Set(Array.isArray(req.body?.ids)?req.body.ids.filter(id=>typeof id==='string'&&!!id):[])];
    const docs=ids.length?await prisma.tradeDocument.findMany({where:{id:{in:ids},deletedAt:null}}):[];
    if(docs.length===ids.length&&docs.length>0&&docs.every(doc=>doc.type==='CommercialInvoice'&&doc.filePath)){
      for(const doc of docs)await archive(prisma,doc,principal(req));marker.add(req);return next();}
    return jwt(req,res,()=>writeGate(req,res,next));
  }catch(error){const safe=safeRouteError(error,{fallbackCode:'INTERNAL_ERROR'});return res.status(safe.status).json({error:safe.code,message:safe.message});}`,aliases)) return null;
  const safe = evidenceImport(source,'safeRouteError',context);
  if (!safe || safe.filename!==path.join(context.root,'shared/routeError.ts')) return null;
  const registrations=[], mutations=[];
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      if (ts.isIdentifier(node.expression.expression) && node.expression.expression.text===markerName
        && ['add','delete'].includes(node.expression.name.text)) mutations.push(node);
      if (node.expression.name.text==='post' && node.arguments.slice(1,-1).some(value=>ts.isIdentifier(value)&&value.text===argument.text)) registrations.push(node);
    }
    ts.forEachChild(node,visit);
  };visit(source);
  if (mutations.length!==1 || mutations[0]!==markCall || registrations.length!==1) return null;
  const handler=unwrapEvidence(registrations[0].arguments.at(-1));
  if (!handler || !ts.isArrowFunction(handler) || !ts.isBlock(handler.body)) return null;
  const generator = evidenceImport(source,'generateTradeDocumentFile',context);
  if (!generator || generator.filename!==validator.filename) return null;
  const generationBlocks=[];let producerCalls=0;
  const generating = node=>{
    if (ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='generateTradeDocumentFile') producerCalls++;
    if (ts.isIfStatement(node)&&node.expression.getText(source)==='!doc.filePath') generationBlocks.push(node.thenStatement);
    ts.forEachChild(node,generating);
  };generating(handler.body);
  if (producerCalls!==1 || !generationBlocks.some(block=>matchesEvidence(block,`if(marker.has(req))throw businessError('CONFLICT','归档文件在读取时变化；本次历史读取不能生成新文件。');
    await generateTradeDocumentFile(prisma,{id:doc.id,actorId,...(isQcReportDocumentCandidate(doc)?{trustedActor:nativeQcActor(req,true)}:doc.type==='CommercialInvoice'?{trustedActor:principal(req,true)}:{})});`,aliases))) return null;
  return {cls:'permission',booleanGated:false,readScopeKnown:false,scopes:['customs:read','customs:write'],conditionalArchiveRead:true,
    provenance:`${path.relative(context.root,validator.filename)}#${validator.exported}: awaited whole archive set; current DB scope/cap; readonly generation fence; JWT/write fallback`};
}

const verifiedSurfaceArgument = (argument, src, context) => classifyVerifiedMiddlewareArgument(argument, src, context)
  ?? classifyCurrentActorContinuation(argument, src, context)
  ?? classifyConditionalArchiveContinuation(argument, src, context);

/** 门体里"配置一关就整体放行"的短路形状（B88：这类门只在 `requireAuth` 为真时生效） */
/**
 * B88 的短路形状。**允许成员路径**：`if (!SDK_CONFIG.requireAuth) return next();`（index.ts 的 sdkAuth）
 * 与 `if (!requireAuth) return true;`（各域局部门）是同一族语义 —— 配置不开 ⇒ 整条门不生效。
 */
const BOOLEAN_SHORT_CIRCUIT = /if\s*\(\s*!(?:[A-Za-z_$][\w$]*\.)*requireAuth\s*\)\s*return[^;]*;/;

const WRITE_METHODS = ['post', 'put', 'patch', 'delete'];
const SKIP_DIRS = new Set(['__tests__', 'node_modules', 'generated', 'dist']);

/** 括号/引号感知的顶层实参切分（不能用正则数括号 —— 那是 B76 那类"把字面量当结构"的老错） */
export function splitArgs(src, openIdx) {
  const args = [];
  let depth = 0, inStr = null, cur = '';
  for (let i = openIdx + 1; i < src.length; i++) {
    const c = src[i], d = src[i + 1];
    if (inStr) {
      if (c === '\\') { cur += c + (d ?? ''); i++; continue; }
      if (c === inStr) inStr = null;
      cur += c; continue;
    }
    /**
     * ★★ v2.61（复核 M-3/M-4 同根因）：**注释要先跳过，不进入引号状态机**。
     *   原实现在遇到 `//` 注释里的撇号（英文所有格、"don't"）时会把后面全部代码当字符串吃掉 ⇒
     *   实参切分"未闭合"、**整条真实写端点被踢出分母**（实测 `orders/route.ts:147` 就是这一例，
     *   它带着 `requireWrite + requirePermission('orders:write')`，是有门的写面，却被报成 unparsed）；
     *   另一半后果：注释行会被切成一个"只有注释的实参段" ⇒ 去归类门，
     *   于是 `unknown` 清单里出现中文注释碎片当"中间件形状"（清单存在但不可读）。
     *   跳过后两段都以注释本来的样子消失：**用长度等价的空格占位，保持偏移量不变**（行号由偏移算出）。
     */
    if (c === '/' && d === '/') {
      const nl = src.indexOf('\n', i);
      const end = nl < 0 ? src.length : nl;
      cur += src.slice(i, end); i = end - 1; continue;   // ★ 原样保留：下游要拿这段文本回查源码偏移
    }
    if (c === '/' && d === '*') {
      const close = src.indexOf('*/', i + 2);
      const end = close < 0 ? src.length : close + 2;
      cur += src.slice(i, end); i = end - 1; continue;    // ★ 同上
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0 && c === ')') { args.push(cur.trim()); return args; }
      depth--;
    } else if (c === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  return null; // 未闭合
}

const isHandlerLike = (a) => /^\s*(async\s+)?(\(|function\b)/.test(a) || /=>/.test(a) || /^\s*(asyncHandler|wrap|handle)/.test(a);
/**
 * 一段中间件实参 → 归类。★ 三条口径写死在这里，避免"下一次顺手改"：
 *  · 先剥 `...`（`...requireXWrite` 是**展开一个门数组**，本质仍是门）；
 *  · 取**第一个标识**判名字；取不到标识就直接归 unknown ——
 *    方向是刻意选的：误判成 unknown 只是"多逼一次表态"，误判成 permission 会**放绿**，后者才危险；
 *  · 带条件（`?` / `&&` / 三元 / 数组字面量）**不降级为 permission**，仍归 unknown：
 *    "这个门是否总生效"机器说了不算 ⇒ 要人写明。
 */
/**
 * 一段中间件实参 → 归类。`localDefs` = 本文件里"具名中间件常量 → 被赋成了什么"（`extractLocalGuards` 造）。
 * ★ 四条口径写死在这里：
 *  · 先剥 `...`（`...requireXWrite` 是**展开一个门数组**，本质仍是门）；
 *  · 取**第一个标识**判形状；取不到标识就 unknown —— 误判成 unknown 只是多逼一次表态，误判成 permission 会放绿；
 *  · 带条件（`?` / `&&` / 三元 / 数组字面量）**不降级为 permission**："这个门是否总生效"机器说了不算；
 *  · 名字不在任何形状里时，**先查它在本文件是不是某个门工厂的返回值**
 *    （`const guard = createModuleAuthGuard({requireAuth, apiKeys})` —— 通用名只能靠赋值来源定档，#25 的修法核心）。
 */
export function classifyGuardArg(argText, localDefs = {}, source = '', context) {
  const complete = verifiedSurfaceArgument(argText, source, context);
  if (complete) return complete.cls;
  const stripped = argText.replace(/^\s*\.{3}/, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').trim();
  if (/[?]|&&|\|\|/.test(stripped)) return 'unknown';
  const head = (stripped.match(/^[A-Za-z_$][\w$.]*/) ?? [null])[0];
  if (head) {
    /**
     * ★★ v2.61 的修法（本批自己发布 20 分钟后现量出来的 BLOCK）：**赋值来源优先于名字**。
     *   旧顺序是"名字命中 PERMISSION_SHAPE 就先 return permission"，于是
     *   `const requireWrite = requireJwtForWrite({ requireAuth, … })` 这种**同名但确实是配置依赖**的门，
     *   在实参位被按名字判成"强证据" ⇒ 配置档从 43 被低估到真实值 ~400（实测 357 条经这条路被误判强档，涉 41 个文件）。
     *   ⇒ 名字表只该用于"本地查无此名"的兜底；有局部定义时**以定义为准**（这与 `#25`/B91 的修法是同一条规则，之前只在局部实现了一半）。
     */
    const def = localDefs[head];
    if (def) return def.cls;
    // Imported/local provenance is required; a display name never grants scope.
    return def ? def.cls : 'unknown';
  }
  return 'unknown';   // 首标识取不到（复合表达式）⇒ 一律逼表态，不猜
}

/** B88：这个门是不是"配置一关就整体放行"。★ 允许成员路径：`if (!SDK_CONFIG.requireAuth) return next();` 与 `if (!requireAuth) return true;` 同一族 */
export function guardIsBooleanGated(text) {
  return BOOLEAN_SHORT_CIRCUIT.test(text);
}

/** 取 `[ ... ]` 字面量的成员（括号/引号感知；`splitArgs` 只处理 `(`…`)`，这里复用它的切分口径） */
function matchArrayMembers(src, atOpen) {
  let depth = 1, inStr = null, cur = '', out = [];
  for (let i = atOpen + 1; i < src.length; i++) {
    const c = src[i], d = src[i + 1];
    if (inStr) {
      if (c === '\\') { cur += c + (d ?? ''); i++; continue; }
      if (c === inStr) inStr = null;
      cur += c; continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 1 && c === ']') { if (cur.trim()) out.push(cur.trim()); return out; }
      depth--;
    } else if (c === ',' && depth === 1) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  return null;   // 未闭合 ⇒ 调用方要记成"解析失败"，不许当成"没有成员"
}

/**
 * 本文件里的具名中间件常量，三种落点都要认（★ 按**赋值来源/函数体做了什么**定档，不往名字白名单里加名字）：
 *   ① `const guard = createModuleAuthGuard({requireAuth, apiKeys})` → identity（工厂名形状定档）
 *   ② `const requireWrite = requireJwtForWrite({...})`              → permission
 *   ③ `const sdkAuth = (req,res,next) => { …res.status(401)… }`     → 由 `extractLocalGates` 的**函数体行为**定档
 *   ④ `const requireReleaseAdmin = [requireWrite, requirePermission('x:admin')]` → 成员组合（展开数组）
 * ★ ③④ 是 v2.60 补的两处**假洞**来源：只认 ①② 时，`...requireReleaseAdmin` 被归 unknown、
 *   `app.post(p, sdkAuth, h)` 三条都没拿到身份功（实测 3 条：releaseRoute 2 条 + sampleRoute 1 条 + index.ts 2 条）。
 */
export function extractLocalGuards(src, context) {
  const out = extractVerifiedMiddlewareDefinitions(src, context);
  /** ④ 数组字面量：`const NAME = [门A, 门B]` —— 展开时**全部成员都会跑**，所以权限档由成员决定 */
  for (const am of src.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*\[/g)) {
    const name = am[1];
    if (out[name]) continue;
    const atOpen = src.indexOf('[', am.index + am[0].length - 1);
    const members = atOpen >= 0 ? matchArrayMembers(src, atOpen) : null;
    if (!members) { out[name] = { cls: 'unknown', factory: '[…]', unparsed: true }; continue; }
    const clsOf = members.map((mem) => {
      const head = (mem.replace(/^\s*\.{3}/, '').match(/^[A-Za-z_$][\w$.]*/) ?? [null])[0];
      if (!head) return { cls: 'unknown', member: mem.slice(0, 30) };
      // Unknown local definitions stay unknown even when their display name
      // resembles requireWrite/requireAdmin. Arrays cannot launder that evidence.
      const def = out[head];
      if (def) return { cls: def.cls, readScopeKnown: def.readScopeKnown, booleanGated: def.booleanGated, member: head };
      const proven = verifiedSurfaceArgument(mem, src, context);
      if (proven) return { ...proven, member: head };
      return { cls: 'unknown', member: head };
    });
    const perms = clsOf.filter((c) => c.cls === 'permission');
    const idents = clsOf.filter((c) => c.cls === 'identity');
    const unknowns = clsOf.filter((c) => c.cls === 'unknown');
    out[name] = {
      cls: perms.length ? 'permission' : idents.length ? 'identity' : 'unknown',
      factory: '[…]',
      readScopeKnown: perms.length > 0 && perms.every((p) => p.readScopeKnown === true) && unknowns.length === 0,
      // All array members execute. One independent fail-closed scope guard
      // remains strong even when a neighbouring JWT guard is configurable.
      // Unknown members still appear below; they are never washed into safety.
      booleanGated: perms.length ? perms.every((p) => p.booleanGated === true) : idents.some((p) => p.booleanGated === true),
      unknownMembers: unknowns.map((u) => u.member),
    };
  }
  /** ③ 具名箭头函数：交给"函数体做了什么"那份分析器（它已处理表达式体/类型注解花括号这两个坑） */
  const byBody = extractLocalGates(src);
  for (const [name, rec] of Object.entries(byBody)) {
    if (out[name]) continue;                     // ①② 已经按赋值来源定档 ⇒ 不覆盖
    if (rec.cls === 'unknown') continue;         // 判不出行为的函数不算门（它多半根本不是门，如 `const apiKey = …`）
    out[name] = { cls: rec.cls === 'authn' ? 'identity' : rec.cls, factory: '‹body›', booleanGated: !!rec.booleanGated, denies: !!rec.denies };
  }
  return out;
}

/**
 * ★ v2.60（B89）：**入不入分母改看内容，不看文件名**。
 *   旧判据 `[Rr]oute.*.ts$` 让"文件名不含 Route、却确实注册了写端点"的文件整文件隐形 ——
 *   本仓活例：`server/src/index.ts` 上有 2 条 `app.post(...)`（实测），从来没进过 655 的分母。
 *   代价：扫描面从"文件名像路由的 81 个"变成"含 Router()/express() 的全部 .ts"⇒ 分母与基线都要重冻结。
 */
function isRouteBearing(abs) {
  try {
    const src = fs.readFileSync(abs, 'utf8');
    return /\b(?:const|let)\s+[A-Za-z_$][\w$]*\s*=\s*(?:express\.)?Router\(\)/.test(src)
      || /\bconst\s+app\s*=\s*express\(\)/.test(src);
  } catch { return false; }
}

function routeFiles(serverSrc) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d)) {
      const p = path.join(d, e);
      const st = fs.statSync(p);
      if (st.isDirectory()) { if (!SKIP_DIRS.has(e)) walk(p); }
      else if (e.endsWith('.ts') && !e.includes('.test.') && isRouteBearing(p)) out.push(p);
    }
  };
  walk(serverSrc);
  return out.sort();
}

/**
 * ★★ v2.57 补的**两层覆盖面**（起因：本模块 v2.56 只看得见 `router.post(path, 门…, handler)` 这一种写法，
 * 于是把 78 条报成"没有任何门" —— 那是**尺的口径**，不是仓的实情）：
 *
 *  1. **handler 体内的局部门**。实测本仓的门大量长这样：
 *     `router.post('/work-stations', async (req,res) => { if (!requireProductionWrite(req,res)) return; … })`
 *     ⇒ 门在**参数表里根本不存在**。而 `requireProductionWrite` / `scopeGate` / `authenticate`
 *     是同文件里的局部函数（全仓 26 处这种定义），它们的**语义差别很大**：
 *     `authenticate` 只验身份（任何登录账号 / 任何 API Key 都过），`scopeGate`/`requireScope` 才判权限。
 *     ⇒ 所以这里按**定义体里做了什么**分类，不按名字猜：名字会过时，行为不会（B35/B75/B76 同族教训）。
 *  2. **挂载点注入的门**。`server/src/index.ts` 里有 `(req,res,next) => { sdkAuth(req,res,() => router(req,res,next)) }`
 *     这种包装 ⇒ 认证在**挂进 app 的那一层**，路由文件里一个字都看不见。
 *
 *  ★★ 一个必须写下来的事实（差点被当成"门"）：`createXRouter({ requireAuth: SDK_CONFIG.requireAuth })`
 *    里的 `requireAuth` **是 boolean，不是中间件**（`SDK_CONFIG.requireAuth = process.env.BAMBOOK_REQUIRE_AUTH==='true' || NODE_ENV==='production'`），
 *    且这些局部门第一行几乎都是 `if (!requireAuth) return true;` ⇒ **本地开发模式下整条链放行**。
 *    ⇒ 它既不算权限门、也不算认证门，本模块**不按它给任何路由记功**；这条由 `enumerateMounts().booleanFlagOnlyFiles` + 守卫里的断言钉住（见 g41-write-surface.test.ts）。
 *
 *  ★ 方向性：分类拿不准一律 `unknown`，而 `unknown` 进棘轮 ⇒ 宁可多逼一次表态，也不放绿。
 */
const PERMISSION_BODY = /hasScope\w*\s*\(|hasPermission\s*\(|permissionService\s*\.|checkPermission\s*\(|roleCode|REQUIRED_ROLE|scopeName\s*\.\s*includes\s*\(/;
/** 能拒绝 = 会往响应上写状态（401/403 或任意 status()）—— 这是"门"与"取值函数"的分界 */
const DENY_SHAPE = /res\.status\s*\(|status\(\s*40[13]\b/;
const AUTHN_BODY = /extractActorFromRequest|apiKeys\.has|verifyJwt|jwtAuth|status\(\s*401\b/;
/** 门定义体的搜索窗口：窗口内既无权限痕迹也无身份痕迹 ⇒ unknown（逼表态），不猜 */
/** `requireAuth: <boolean 表达式>` —— **不是中间件**，见上面的说明；单列出来是为了能被断言"没给它记功" */
const BOOLEAN_AUTH_FLAG = /requireAuth\s*:/;

/**
 * 从源码里找出"局部的门函数"：`const NAME = (req, res…` / `function NAME(req, res…`
 * ★ 必须**要求 `=`**：本仓的路由写成 `router.get('/x', async (req, res) => {`，
 *   若允许没有 `=`，`const router = Router();` 的下一行会被误配成"名叫 router 的门"
 *   （第一版就踩到了：mesRoute 的 26 个门名全是 `authenticate:*` 假阳性）。
 *   匿名 handler（`const handle = async (req,res)=>…`）也**不算门**：它的体里出现 hasScope 是"这条路由的事"，
 *   不是"一个可复用的门"⇒ 门必须是**具名 + (req 开头) + 被别处调用**的形状。
 */
export function extractLocalGates(src) {
  const cand = {};
  const rx = /\b(?:const|function)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]{0,160})\)/g;
  let m;
  while ((m = rx.exec(src)) !== null) {
    const name = m[1];
    /**
     * ★ 首参必须**就是 `req`**（可带类型注解），不能是 `req.something`。
     *   只判"参数里出现 req"会吃到这类赋值：`const apiKey = (req.query.apiKey as string) || …`
     *   ⇒ 它会被当成一个叫 `apiKey` 的"门"，而它后面根本没有 `=>`，锚点会滑到**下一个函数**的箭头，
     *   于是把别人的 `res.status(` / `hasScope(` 记在它名下 = **越界给绿**（实测 mesRoute 凭空多出一个 permission 门）。
     */
    const params = (m[2] ?? '').trim();
    if (!/^_?req\b(:[^,)]*)?(,|$)/.test(params)) continue;
    // 门定义体两种写法：块体 `=> { … }`（配平取）与**表达式体** `=> a() && b(…)`（没有花括号，取到第一个 `;`）。
    // ★ 锚点必须是 **`=>` 之后**的第一个 `{`：返回类型注解自己带花括号
    //   （approvalKernelRoute 的 `): { userId: string; roles: string[] } | null => {`），
    //   从定义处直接找会**把类型注解当成函数体** ⇒ 那个真门被判成"不是门"而静默丢掉（实测 approvalK 的门数 = 0）。
    const arrowAt = src.indexOf('=>', m.index + m[0].length - 1);
    const from = arrowAt >= 0 ? arrowAt + 2 : m.index;
    const braceAt = src.indexOf('{', from);
    const semiAt = src.indexOf(';', from);
    const isExprBody = semiAt >= 0 && (braceAt < 0 || semiAt < braceAt);
    const matched = isExprBody ? { text: src.slice(m.index, semiAt + 1) } : matchBracedBody(src, from);
    if (!matched) { cand[name] = { cls: 'unknown', body: '', denies: true, why: '定义体没配平' }; continue; }
    const body = matched.text;
    cand[name] = {
      body,
      denies: DENY_SHAPE.test(body),                                    // 自己能拒绝
      // ★ B88：体里有 `if (!requireAuth) return true;` ⇒ 这个门只在配置打开时生效
      booleanGated: BOOLEAN_SHORT_CIRCUIT.test(body),
      cls: PERMISSION_BODY.test(body) ? 'permission' : AUTHN_BODY.test(body) ? 'authn' : 'unknown',
    };
  }
  /**
   * ★ 传递闭包（三轮：本仓实测组合深度 ≤ 2，多一轮留余量）。
   *   `requireProductionWrite = authenticate(req,res) && scopeGate(req,res,'production:write')`
   *   自身体内既没有 `res.status(` 也没有 `hasScope(`，只有**对别的门的调用** ⇒
   *   不做传递就会发生两件错事：① 它被当成"取值函数"丢掉；② mesRoute 那 26 条被降级成"只有身份没有权限"。
   *   ⇒ `denies` 与 `permission` 都沿调用继承（**只向上继承 permission 这一档**，保守方向）。
   */
  for (let pass = 0; pass < 3; pass += 1) {
    for (const [name, rec] of Object.entries(cand)) {
      if (!rec?.body) continue;
      for (const [other, orec] of Object.entries(cand)) {
        if (other === name || !orec) continue;
        if (!new RegExp(`\\b${other}\\s*\\(`).test(rec.body)) continue;
        if (orec.denies) rec.denies = true;
        /**
         * ★ B88 的组合语义：`requireProductionWrite = authenticate(req,res) && scopeGate(...)`
         *   自己体内没有 `if (!requireAuth) return true`，但它调用的那两颗**都有** ⇒ 整颗门仍然只在配置打开时生效。
         *   所以 taint 只能**沿"提供权限的被调门"向上flow**（有一个权限来源是布尔短路的 ⇒ 组合门也算布尔短路），
         *   不能反过来"见到一个非短路就洗白"——那正是我第一版写错的方向（17 条 vs 实际 43 条）。
         */
        if (orec.cls === 'permission' && orec.booleanGated === true) rec.booleanGated = true;
        if (orec.cls === 'permission' && rec.cls !== 'permission') { rec.cls = 'permission'; rec.inheritedFrom = other; }
      }
    }
  }
  const out = {};
  for (const [name, rec] of Object.entries(cand)) {
    if (rec.denies !== true) continue;   // 不会拒绝、也不调别的门 = **取值函数**，不是门
    out[name] = rec;
  }
  for (const k of Object.keys(out)) if (out[k]) delete out[k].body;   // 源码不留在返回值里
  return out;
}

/**
 * 取某条路由 handler 的体。
 * ① 主口径 = **从 handler 的第一个 `{` 起做花括号配平**（遇到引号/模板串跳过）——
 *    这是唯一能把"这一条路由的体"和"下一条路由的体"分开的办法；
 *    早期版本只按"下一条 `router.<method>(` 之前"切 ⇒ 同一个 handler 里的兄弟注册（`if (role==='admin') router.delete(...)`）
 *    会把下一条整条吞进来（实测吞掉 6661 字符），方向危险。
 * ② 配平失败（未闭合）⇒ 退回"到下一条 router. 之前"，并把 `bounded=false` 交出去 ⇒ 守卫要求这类路由**单独计数并设上限**，
 *    不许静默当成"体读全了"。
 */
function handlerBodyOf(src, fromIdx, nextRouterIdx) {
  const matched = matchBracedBody(src, fromIdx);
  if (matched && matched.end <= nextRouterIdx) return { text: matched.text, bounded: true, method: 'braces' };
  // Quotes inside comments/regular expressions and nested template literals
  // can defeat the legacy brace reader. Only an actual direct handler whose
  // parser-owned block ends before the sibling boundary supplies a fallback.
  // A named handler or a callback elsewhere cannot lend its body to this site.
  const source = evidenceSource(src);
  let direct;
  if (!source.parseDiagnostics.length) {
    const visit = node => {
      if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.getStart(source) === fromIdx) direct = node;
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  if (direct && ts.isBlock(direct.body) && direct.body.end <= nextRouterIdx) {
    return { text: src.slice(fromIdx, direct.body.end), bounded: true, method: 'ast-direct-block' };
  }
  if (matched) return { text: src.slice(fromIdx, nextRouterIdx), bounded: false, method: 'past-next-router' };
  return { text: src.slice(fromIdx, nextRouterIdx), bounded: false, method: 'unterminated' };
}

/**
 * 从 fromIdx 起找第一个 `{` 并做花括号配平（引号/模板串里的括号跳过）。
 * ★ 为什么处处要用它：早期版本用"固定 1400 字符窗口"读门定义体 ⇒ 窗口会**越过本函数**，
 *   把后面别的函数里的 `hasScope(` / `res.status(` 算进来 ⇒ 给只解析身份的 `authenticate`
 *   记成 permission、给只取值的 `actorOf` 记成 authn。**错的方向是"放绿"**，
 *   所以分类前必须先把"这一个函数的体"切出来。配不平 ⇒ 不归类，进 unknown 逼表态。
 */
function matchBracedBody(src, fromIdx) {
  const open = src.indexOf('{', fromIdx);
  if (open < 0) return null;
  let depth = 0, inStr = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return { text: src.slice(fromIdx, i + 1), end: i + 1 };
    }
  }
  return null;
}

/**
 * 下一条"同文件里的兄弟注册/兄弟工厂"的位置（找不到 = 传入的兜底值）。
 * ★ B88 附带修的一刀：接收者名不能写死 `router` —— 上一版只认 `\brouter\.`，
 *   于是 `const api = Router()` 那种文件里的体**一路读到文件尾**，把后面函数的门算进本条路由（给绿方向）。
 *   现在额外用"下一个 `create*Router` 工厂起点"兜边界：一个文件里两个工厂时，前一个工厂的最后一条路由不再越界。
 */
function nextRouterCallIdx(src, fromIdx, receivers, extraBounds) {
  const alt = receivers.map((r) => r.replace(/[$]/g, () => '\\$')).join('|');
  // 边界方法集**派生**自 WRITE_METHODS（写方法）+ 读/挂载方法：兄弟注册不管是哪一档，都是"本条 handler 结束"的证据
  const methods = WRITE_METHODS.concat(['get', 'all', 'use']).join('|');
  const rx = new RegExp(`\\b(?:${alt})\\.(?:${methods})\\s*\\(`, 'g');
  rx.lastIndex = fromIdx;
  const hit = rx.exec(src);
  const bounds = [hit ? hit.index : src.length, ...(extraBounds ?? []), src.length];
  return Math.min(...bounds.filter((b) => b > fromIdx));
}

/** 一个文件里所有 `create*Router` 工厂的起点（用于挂载归属与 body 定界） */
function factorySpans(src) {
  const out = [];
  for (const m of src.matchAll(/\b(?:export\s+)?(?:async\s+)?function\s+(create\w*Router)\b|\b(?:export\s+)?const\s+(create\w*Router)\s*=/g)) {
    const name = m[1] ?? m[2];
    if (name) out.push({ name, idx: m.index });
  }
  return out.sort((a, b) => a.idx - b.idx);
}

/**
 * 挂载点归属：解析 `server/src/index.ts`，把"哪个路由**工厂**被挂在哪、挂载表达式里出现了哪些门"算出来。
 * ★ B88/MINOR：原先按**文件**记账 ⇒ 一个文件里住两个工厂时（实测 `finance/billingItemRoute.ts` 就是），
 *   没被挂载的那个工厂会从兄弟那里继承 mounted/门（给绿方向）。现在按工厂记，`byFile` 保留为派生的并集。
 * @returns {{ byFactory: Record<string, {file:string, prefixes:string[], mountAuthn:boolean, mountPermission:boolean, mounted:boolean}>, byFile: object, factories:number, unparsed:number }}
 */
export function enumerateMounts(repoRoot) {
  const idx = path.join(repoRoot, 'server', 'src', 'index.ts');
  const byFile = {};
  const byFactory = {};
  let src;
  try { src = fs.readFileSync(idx, 'utf8'); } catch { return { byFile, byFactory, factoryToFile: {}, factories: 0, unparsed: 0, missing: true }; }
  /** import { createXRouter } from './mes/mesRoute' → 工厂名 → 相对文件路径 */
  const factoryToFile = {};
  for (const im of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]*)['"]/g)) {
    const rel0 = im[2].replace(/^\.\//, '');
    const target = path.normalize(path.join(repoRoot, 'server', 'src', rel0));
    const withTs = target.endsWith('.ts') ? target : `${target}.ts`;
    for (const nm of im[1].split(',')) {
      const name = nm.trim().replace(/^type\s+/, '');
      if (/^create\w*Router$/.test(name)) factoryToFile[name] = path.relative(repoRoot, withTs);
    }
  }
  let unparsed = 0;
  for (const u of src.matchAll(/\bapp\.use\s*\(/g)) {
    const args = splitArgs(src, u.index + u[0].length - 1);
    if (!args) { unparsed += 1; continue; }
    const text = args.join(',');
    const prefixes = args.filter((a) => /^\s*['"]/.test(a)).map((a) => a.trim().slice(1, -1));
    for (const f of text.match(/create\w*Router/g) ?? []) {
      const file = factoryToFile[f];
      if (!file) continue;
      // ★ 一条挂载表达式**只给它自己的工厂**记功。同一文件里的另一个工厂若不在这条表达式里出现，
      //   就必须由它自己的挂载点拿证据 —— 否则就是"兄弟继承"（v2.59 那份按文件记账的缺陷）。
      const rec = byFactory[f] ?? { factory: f, file, prefixes: [], mountAuthn: false, mountPermission: false, mounted: true, sites: 0 };
      rec.mounted = true;
      rec.sites += 1;
      for (const p of prefixes) if (!rec.prefixes.includes(p)) rec.prefixes.push(p);
      // ★ 只认"作为中间件被调用/传入"的形状：`\bsdkAuth\b` 出现在挂载表达式里
      if (/\bsdkAuth\b/.test(text)) rec.mountAuthn = true;
      // ★ 这里**不认** `create*AuthGuard`：本尺在局部门那一层把它判成"只验身份"（见 AUTH_FACTORY_SHAPE），
      //   同一名字在挂载层判成权限就是"同名两义"（复核 MINOR 之一）。今日实测 0 个挂载点命中，改判不动数。
      if (/\brequirePermission\b|\brequireRole\b/.test(text)) rec.mountPermission = true;
      // `requireAuth: SDK_CONFIG.requireAuth` 这种 boolean 注入**单独记账，不给它算成门**
      if (BOOLEAN_AUTH_FLAG.test(text)) rec.hasBooleanAuthFlag = true;
      byFactory[f] = rec;
    }
  }
  /** 派生的文件级并集：只在"该文件恰好只有一个工厂"时才等价，多工厂文件的 fallback 命中会被标出来 */
  for (const rec of Object.values(byFactory)) {
    const bf = byFile[rec.file] ?? { prefixes: [], mountAuthn: false, mountPermission: false, mounted: true, factories: [] };
    bf.mounted = bf.mounted || rec.mounted;
    bf.mountAuthn = bf.mountAuthn || rec.mountAuthn;
    bf.mountPermission = bf.mountPermission || rec.mountPermission;
    if (rec.hasBooleanAuthFlag) bf.hasBooleanAuthFlag = true;
    for (const p of rec.prefixes) if (!bf.prefixes.includes(p)) bf.prefixes.push(p);
    (bf.factories ??= []).push(rec.factory);
    byFile[rec.file] = bf;
  }
  for (const rec of Object.values(byFactory)) {
    rec.booleanAuthFlagOnly = !!rec.hasBooleanAuthFlag && !rec.mountAuthn && !rec.mountPermission;
  }
  for (const rec of Object.values(byFile)) {
    rec.booleanAuthFlagOnly = !!rec.hasBooleanAuthFlag && !rec.mountAuthn && !rec.mountPermission;
  }
  const boolOnly = Object.entries(byFile).filter(([, r]) => r.booleanAuthFlagOnly).map(([f]) => f);
  return { byFile, byFactory, factoryToFile, factories: Object.keys(factoryToFile).length, unparsed, booleanFlagOnlyFiles: boolOnly };
}

/**
 * 枚举。返回：
 *   routes      —— 每条写路由 {file, line, method, pathKey, guards[], permCovers, routerLevelGuard, shape}
 *   unknown     —— **必须为空**的集合：出现在门位但没归类的标识（新形状 ⇒ 逼表态）
 *   unparsed    —— 括号未闭合等解析失败（也不许静默吞）
 */
export function enumerateWriteRoutes(repoRoot, options = {}) {
  const files = routeFiles(path.join(repoRoot, 'server', 'src'));
  const mounts = enumerateMounts(repoRoot);
  const routes = [], unknown = [], unparsed = [];
  for (const abs of files) {
    const src = fs.readFileSync(abs, 'utf8');
    const rel = path.relative(repoRoot, abs);
    const localGates = extractLocalGates(src);
    const context = { filename: abs, root: path.join(repoRoot, 'server', 'src'), dependencies: options.dependencies };
    const localGuards = extractLocalGuards(src, context);   // ★ v2.60：`router.use(guard)` 这类具名门要按赋值来源定档
    const spans = factorySpans(src);
    // router.use(...) 里"在该路由之前注册"的模块级门
    const uses = [...src.matchAll(/\brouter\.use\s*\(/g)]
      .map((u) => ({ idx: u.index, args: splitArgs(src, u.index + u[0].length - 1) ?? [], parsed: (splitArgs(src, u.index + u[0].length - 1)) !== null }));
    for (const u of uses) if (!u.parsed) unparsed.push(`${rel}: router.use 括号未闭合`);
    /**
     * ★ v2.60（B89）：接收者名**不写死 `router`**。本仓绝大多数文件是 `const router = Router()`，
     *   但 `const api = Router(); api.post(...)` 一样能注册写端点，而旧版只认字面量 `router.` ⇒ 整个文件对分母隐形。
     *   另外 `server/src/index.ts` 直接在 app 上挂端点（实测 2 条写方法），也必须进分母。
     */
    const receivers = [...new Set([...(src.match(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:express\.)?Router\(\)/g) ?? [])
      .map((x) => (x.match(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)/) ?? [])[1]).filter(Boolean), 'app'])];
    for (const m of WRITE_METHODS) {
      const rx = new RegExp(`\\b(?:${receivers.map((r) => r.replace(/\$/g, '\\$')).join('|')})\\.${m}\\s*\\(`, 'g');
      let r;
      while ((r = rx.exec(src)) !== null) {
        const args = splitArgs(src, r.index + r[0].length - 1);
        /**
         * ★ v2.60：丢掉**空实参段**。多行写法带尾逗号时（`router.post(\n '/',\n gate,\n h,\n)`）
         *   `splitArgs` 会切出一个空段 ⇒ 原先发生两件错事：
         *   ① "最后一个实参不是内联 handler" 被判真 ⇒ 该路由进 `named-handler` 桶（现量这类共 14 条，本修正后要看差值）；
         *   ② 空段被当门去归类 ⇒ `unknown` 里 13 条 ident 为空的噪声（清单看了等于没看）。
         *   合法 express 调用不存在空实参 ⇒ 在**解析边界**收掉，不在下游逐个 if。
         */
        if (args) {
          // ★ v2.61：空段与"只有注释的段"都要收掉（尾逗号 ⇒ 误判 named-handler；注释段 ⇒ 污染 unknown 清单）
          const isBlank = (a) => a.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').trim() === '';
          while (args.length && isBlank(args[args.length - 1])) args.pop();
          for (let z = args.length - 1; z >= 1; z--) if (isBlank(args[z])) args.splice(z, 1);
        }
        const line = src.slice(0, r.index).split('\n').length;
        if (!args) { unparsed.push(`${rel}:${line} router.${m} 括号未闭合`); continue; }
        if (args.length < 2) { unparsed.push(`${rel}:${line} router.${m} 参数不足 2（路径都切不出来）`); continue; }
        const tail = args.slice(1);
        /**
         * ★ 挂载证据按**工厂**认领（B88/MINOR）：这条路由落在哪个 `create*Router` 的作用域里，
         *   就用那个工厂的挂载点证据。文件里只有一个工厂时与旧口径等价；
         *   有多个工厂而这条路由**不在任何工厂里** ⇒ 不给挂载功（兄弟继承是给绿方向，必须堵住）。
         * ★ 直接注册在 `app` 上（实测 `index.ts` 2 条）本身就是挂载点 ⇒ 记 `mounted`，但**不给任何门功**。
         */
        const receiver = (r[0].split('.')[0] ?? '').trim();
        const owner = spans.filter((s) => s.idx < r.index).pop();
        const mount = owner ? (mounts.byFactory[owner.name] ?? null) : null;
        const onAppDirectly = receiver === 'app' && rel.endsWith('index.ts');
        /**
         * `mountUnattributed` = "这条路由所在的文件**有**工厂，但它落在工厂外面" ⇒ 挂载证据**没拿到**，
         *   而这与"这个文件根本没被挂载"是两回事。两者必须分开，否则 `notMountedAtAll` 会把尺的盲区
         *   报成缺陷清单（B89 那类：分母小于实情）。
         */
        const mountUnattributed = !mount && !onAppDirectly && spans.length > 0;
        const mountedEvidence = mount ? { mountAuthn: mount.mountAuthn, mountPermission: mount.mountPermission, mounted: true }
          : onAppDirectly ? { mountAuthn: false, mountPermission: false, mounted: true }
          : { mountAuthn: false, mountPermission: false, mounted: false };
        const { mountAuthn, mountPermission, mounted } = mountedEvidence;
        const lastIsHandler = isHandlerLike(tail[tail.length - 1]);
        // The final argument is a handler even when it is named. Keep its
        // separate named-handler denominator; do not pretend it is middleware.
        const guardArgs = tail.slice(0, -1);
        const guards = guardArgs.map((g) => {
          const complete = verifiedSurfaceArgument(g, src, context);
          const cls = complete?.cls ?? classifyGuardArg(g, localGuards, src, context);
          const stripped = g.replace(/^\s*\.{3}/, '').trim();
          const head = (stripped.match(/^[A-Za-z_$][\w$.]*/) ?? [null])[0];
          const def = head ? localGuards[head] : undefined;
          // 读档 scope 的两种来路：① 局部常量 = `requirePermission('x:read')`；② 实参位直接内联写 `requirePermission('x:read')`
          const readScopeKnown = cls === 'permission' && (complete?.readScopeKnown === true || def?.readScopeKnown === true || /^\s*requirePermission\s*\(\s*['"][^'"]*:read\b/.test(stripped));
          return { text: g, cls, readScopeKnown, booleanGated: complete?.booleanGated === true || def?.booleanGated === true, provenance: complete?.provenance ?? def?.provenance ?? 'legacy-body-presence', unknownMembers: def?.unknownMembers ?? [] };
        });
        for (const g of guards) {
          if (g.cls === 'unknown') unknown.push({ file: rel, line, ident: g.text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').trim().replace(/\s+/g, ' ').slice(0, 80) });
          // 数组门里**判不出档的成员**不许随数组一起被"permission"掩盖：逐个逼表态
          for (const um of g.unknownMembers ?? []) unknown.push({ file: rel, line, ident: `array-member:${um}` });
        }
        const routerLevelGuard = uses
          .filter((u) => u.parsed && u.idx < r.index)
          .some((u) => u.args.some((a) => classifyGuardArg(a, localGuards, src, context) === 'permission'));

        const routerLevelIdentity = uses.filter(u => u.parsed && u.idx < r.index)
          .flatMap(u => u.args.map(a => ({ cls: classifyGuardArg(a, localGuards, src, context), evidence: verifiedSurfaceArgument(a, src, context), name: a.trim() })))
          .filter(g => g.cls === 'identity');

        // ★ 层 1：handler 体内调用的"局部门"（v2.57 新增 —— 这一层的名字在参数表里根本不存在）。
        //   体的起点 = **handler 文本自身**（不把前面的门实参算进来），终点 = 下一条兄弟注册 / 下一个工厂起点，取更早者。
        //   ⚠️ 仍可能定不了界（`bodyBounded=false`）：这类路由单列成 `bodyUnbounded` 棘轮桶，
        //      它们**可以**被记 permission 功 ⇒ 所以那一桶是"读数可信度的上限"，不是"已排除"。（v2.60 改掉旧注释里那句不存在的断言）
        const handlerText = tail[tail.length - 1];
        const hIdx = src.indexOf(handlerText, r.index);
        const nextIdx = nextRouterCallIdx(src, r.index + r[0].length, receivers, spans.map((s) => s.idx));
        const bodyInfo = hIdx >= 0 ? handlerBodyOf(src, hIdx, nextIdx) : { text: '', bounded: false, method: 'no-handler' };
        const body = bodyInfo.text;
        const bodyGates = [];
        for (const [gname, gdef] of Object.entries(localGates)) {
          if (new RegExp(`\\b${gname.replace(/\$/g, '\\$')}\\s*\\(`).test(body)) {
            const strong = ['permission', 'authn'].includes(gdef?.cls) && gdef?.booleanGated !== true;
            bodyGates.push({ name: gname, cls: gdef?.cls ?? 'unknown', strong });
          }
        }
        // 体内**直接**调权限 API（不走局部函数）也算，但要单独标出来，别和"调了门"混成一个数
        const bodyDirectPermission = /hasScope\w*\s*\(|hasPermission\s*\(|checkPermission\s*\(/.test(body);
        for (const g of bodyGates) {
          if (g.cls === 'unknown') unknown.push({ file: rel, line, ident: `body:${g.name}` });
        }
        const bodyPermission = bodyGates.some((g) => g.cls === 'permission') || bodyDirectPermission;
        const bodyAuthn = bodyGates.some((g) => g.cls === 'authn');
        const bodyAuthnStrong = bodyGates.some((g) => g.cls === 'authn' && g.strong === true);

        const argPermission = guards.some((g) => g.cls === 'permission');
        /**
         * ★★ v2.61（复核 A/B 同点命中）：**实参位 ≠ 强证据**。
         *   旧写法把"门出现在参数表里"直接当强档 ⇒ `const requireWrite = requireJwtForWrite({requireAuth,…})`
         *   这类局部门靠"实参位"三个字混过了配置档（`moduleGuard.ts:110` 体内确有 `if (!opts.requireAuth) return next();`）。
         *   ★ 现量：有 357 条路由的实参位带着这扇门，但其中只有 **25 条**是"唯一权限证据就是它"
         *     （其余 332 条同链上还带着 fail-closed 的 `requirePermission('<x>:write')` ⇒ 仍算强）。
         *     ⇒ 配置档 43 → **68**、强档 567 → **542**。（我中途在这段注释里写过"~400"，那是**没量过的数**，被复核当场抓住并删掉。）
         *   ⚠️ 尺的边界仍在：解析不到定义的**跨文件 import 门**按强处理 —— `requirePermission` 经实际读码确认
         *     写档 scope 在 dev 下 fail-closed（`permissionGuard.ts:102` 只对 `authSource==='dev'` 且**无写风险**时放行），
         *     所以这条边界的已知偏差方向是"若将来出现别的跨文件门带短路，会高估强档"。
         */
        const argPermissionHasStrong = guards.some((g) => g.cls === 'permission' && g.booleanGated !== true) || routerLevelGuard || mountPermission;
        /**
         * ★ "写路由只挂**读档** scope"是第三种姿态（既不是"拦住了写"也不是"没门"）：
         *   `router.post('/dunning/letter', requireInvoicesRead, …)` —— 有门，但门判的是 `invoices:read`。
         *   判据要求"**全部**权限证据都是已知的 :read scope"才算，缺一个证据源就退回普通档（保守方向）。
         */
        const permEvidenceReadOnly = (argPermission || routerLevelGuard || bodyPermission || mountPermission)
          && argPermission && !routerLevelGuard && !bodyPermission && !mountPermission
          && guards.filter((g) => g.cls === 'permission').every((g) => g.readScopeKnown === true);
        // （实参位是否算"强证据"由上面 argPermissionHasStrong 的逐门 booleanGated 判定决定，这里不再另写一套）
        const bodyPermissionOnlyBooleanGated = !bodyGates.some((g) => g.cls === 'permission' && g.strong === true) && !bodyDirectPermission;
        const permCovered = argPermission || routerLevelGuard || bodyPermission || mountPermission;
        const authnCovered = bodyAuthn || mountAuthn || routerLevelIdentity.length > 0 || guards.some((g) => g.cls === 'identity');
        /**
         * 身份证据的"配置档"：本尺认得的挂载层身份门只有 `sdkAuth` 一种，而它体内第一行是
         * `if (!SDK_CONFIG.requireAuth) return next();` ⇒ 挂载层记的身份功**本身就是配置依赖的**。
         * 所以这里不许把 mountAuthn 当强证据（否则"只有身份 29 条"会说得比实际更硬）。
         */
        const authnEvidenceConfigOnly = authnCovered && !bodyAuthnStrong
          && routerLevelIdentity.every(g => (g.evidence ?? localGuards[g.name])?.booleanGated === true)
          && guards.filter((g) => g.cls === 'identity').every((g) => g.booleanGated === true);
        routes.push({
          file: rel, line, method: m.toUpperCase(), pathKey: args[0],
          guards, shape: lastIsHandler ? (guards.length ? 'inline' : 'naked') : 'named-handler',
          hasAnyGuard: guards.length > 0 || routerLevelGuard,
          // ★ 口径分开留痕：v2.56 的 hasPermissionGuard **只看参数表与 router.use**，它把"门写在体内"的
          //   整族（mesRoute 的那一批）判成"没门"。这个字段**保持旧含义不动**（基线里那批 naked 条目靠它），
          //   新加的 permissionCoveredAllLayers 才是"补完两层之后"的判定。
          hasPermissionGuard: argPermission || routerLevelGuard,
          routerLevelGuard, routerLevelIdentity: routerLevelIdentity.map(g => g.name),
          argPermission, bodyPermission, bodyDirectPermission, bodyAuthn,
          bodyGates: bodyGates.map((g) => `${g.name}:${g.cls}`),
          bodyBounded: bodyInfo.bounded, bodyBoundBy: bodyInfo.method,
          mountAuthn: mountAuthn, mountPermission: mountPermission,
          mounted: mounted, mountUnattributed, permEvidenceReadOnly,
          permissionCoveredAllLayers: permCovered,
          /**
           * ★ B88：这条路由的权限证据是不是**全部**来自"`if (!requireAuth) return true` 型"的门。
           *   是 ⇒ 本地/非 production 姿态下这条链整体放行 ⇒ "有权限门"这句话依赖配置，不许混在一个数里报。
           */
          permEvidenceAllBooleanGated: permCovered && !argPermissionHasStrong && bodyPermissionOnlyBooleanGated,
          authnEvidenceConfigOnly,
          authnCoveredAllLayers: authnCovered,
        });
      }
    }
  }
  return { routes, unknown, unparsed, files: files.length, mounts };
}

/** 三态汇总（结论分支必须覆盖"没有输入"—— 不许把 0 当"干净"） */
export function summarize(list) {
  const total = list.length;
  const naked = list.filter((x) => x.shape === 'naked' && !x.routerLevelGuard);
  const namedHandler = list.filter((x) => x.shape === 'named-handler');
  const permAll = list.filter((x) => x.permissionCoveredAllLayers);
  const noPermButAuthn = list.filter((x) => !x.permissionCoveredAllLayers && x.authnCoveredAllLayers);
  const noEvidence = list.filter((x) => !x.permissionCoveredAllLayers && !x.authnCoveredAllLayers);
  const notMounted = list.filter((x) => x.mounted === false);
  return {
    total,
    guarded: total - naked.length - namedHandler.length,
    nakedNoRouterGuard: naked.length,
    namedHandlerUntouched: namedHandler.length,   // ← 不许被当成"已挂门"，也不许被当成"裸"
    // ★ v2.57 三层口径（与上面两个旧字段**同数不同义**，禁止互相加减）
    permissionCovered: permAll.length,
    /** ★ B88：权限证据全靠"配置开着才生效"的门 ⇒ 单列，不许并进 permissionCovered 里报一个数 */
    permissionCoveredButConfigDependent: permAll.filter((x) => x.permEvidenceAllBooleanGated).length,
    /** = permissionCovered − configDependent：本地姿态下仍然生效的那部分（"两档都要报"里的强档） */
    permissionCoveredStrong: permAll.filter((x) => !x.permEvidenceAllBooleanGated).length,
    /** ★ 写面上只挂已知 :read scope 的门（有门≠拦住写）；与 permissionCovered 同数不同义，单独成桶 */
    permissionCoveredReadOnlyScope: permAll.filter((x) => x.permEvidenceReadOnly).length,
    authnOnlyNoAuthz: noPermButAuthn.length,
    /** ★ "只有身份"这一档里，身份证据本身也是配置依赖的（sdkAuth 第一行短路）⇒ 本地姿态下连身份都没有 */
    authnOnlyButConfigDependent: noPermButAuthn.filter((x) => x.authnEvidenceConfigOnly).length,
    noEvidenceAtAll: noEvidence.length,
    notMountedAtAll: notMounted.length,
    /** 尺的盲区而非缺陷：所在文件有工厂但这条落在工厂外 ⇒ 挂载证据没拿到 */
    mountUnattributedAtAll: list.filter((x) => x.mountUnattributed).length,
    denominatorIsMeaningful: total > 0,
  };
}

/**
 * ★ v3.12 配套：让"重冻结基线"不再是盲操作
 *
 * 起因（本批实测）：B129 收口只改了 `claimRoute.ts` catch 里的 4 行，路由注册一行没动，
 * 却把 G4.1 守卫判红 9 条（8 条 naked + 1 条 authnOnly）。原因是基线**以 `file:line` 为键** ——
 * 行号是尺的噪声（任何一次上方编辑都会搬家），但把它留在键里有两个好处：定位快、同 file+method+path
 * 重复注册不会被并成一条。所以**不换键**，换的是"允许你怎么改键里的数"：
 *   签名（file, method, pathKey）不变 ⇒ 只是行号搬家 ⇒ 允许自动重冻结；
 *   签名变了 ⇒ 这是"集合真的变了"（新增裸路由 / 修好了 / 路由改名）⇒ 必须显式签字才能写盘。
 * 治的是本仓反复栽的那一类：守卫红了 → 有人不看原因直接 `--write` → 基线成假账。
 */
export function siteSignature(key) {
  return String(key).replace(/:\d+(?=\s)/, ':_');
}

/** 逐清单对撞签名重数；返回 { 清单名: { added: [...], removed: [...] } }，全空 = 只有行号搬家
 *  ★ v3.14（B134）：签名归一化器由调用方给（默认 G4.1 的 `siteSignature`）。
 *    第二个消费者是 B126 的冻结写手，它那边的键形如 `file:123#bucket`，行号后面跟 `#` 而不是空格，
 *    拿默认归一化器会"每次都像集合变了" ⇒ 并的是这份**对撞算法**，不是两份键格式。 */
export function reconcileSiteLists(baseLists, nowLists, sig = siteSignature) {
  const out = {};
  for (const name of new Set([...Object.keys(baseLists), ...Object.keys(nowLists)])) {
    const count = (arr) => {
      const m = new Map();
      for (const k of arr ?? []) m.set(sig(k), (m.get(sig(k)) ?? 0) + 1);
      return m;
    };
    const b = count(baseLists[name]);
    const n = count(nowLists[name]);
    const added = [...n.keys()].filter((k) => (n.get(k) ?? 0) > (b.get(k) ?? 0));
    const removed = [...b.keys()].filter((k) => (b.get(k) ?? 0) > (n.get(k) ?? 0));
    if (added.length || removed.length) out[name] = { added, removed };
  }
  return out;
}

/**
 * ★ v3.12：基线条目的键只此一份（原先守卫里两份 + 写手一份，三处字面量手抄）
 *   键含行号是**有意**的：定位快，且同 file+method+path 的重复注册不会被并成一条。
 *   代价由 `siteSignature` / `reconcileSiteLists` 兜：无关编辑造成的行号搬家可以自动重冻结，
 *   集合真变了则必须显式放行。
 */
export function siteKey(x) {
  return `${x.file}:${x.line} ${x.method} ${String(x.pathKey)}`;
}


export const SURFACE_LIST_NAMES = ['nakedWriteRoutes','noEvidenceRoutes','authnOnlyRoutes','bodyUnbounded','configDependentRoutes','readOnlyScopeRoutes','namedHandlerRoutes'];
export function surfaceLists(result) {
  const r = result.routes;
  return {
    nakedWriteRoutes:r.filter(x=>x.shape==='naked'&&!x.routerLevelGuard).map(siteKey).sort(),
    noEvidenceRoutes:r.filter(x=>!x.permissionCoveredAllLayers&&!x.authnCoveredAllLayers).map(siteKey).sort(),
    authnOnlyRoutes:r.filter(x=>!x.permissionCoveredAllLayers&&x.authnCoveredAllLayers).map(siteKey).sort(),
    bodyUnbounded:r.filter(x=>!x.bodyBounded).map(siteKey).sort(),
    configDependentRoutes:r.filter(x=>x.permEvidenceAllBooleanGated).map(siteKey).sort(),
    readOnlyScopeRoutes:r.filter(x=>x.permEvidenceReadOnly).map(siteKey).sort(),
    namedHandlerRoutes:r.filter(x=>x.shape==='named-handler').map(siteKey).sort(),
  };
}
export function signatureLists(lists) {
  return Object.fromEntries(SURFACE_LIST_NAMES.map(name=>[name,(lists[name]??[]).map(siteSignature).sort()]));
}
export function surfaceSetDigest(lists) {
  return createHash('sha256').update(JSON.stringify(signatureLists(lists))).digest('hex');
}
/** Every source file is content-addressed. Scope factories are included because
 * an unchanged route calling a changed imported factory is not unchanged proof. */
export function surfaceSourceEvidence(repoRoot) {
  repoRoot = fs.realpathSync(repoRoot);
  const routed = routeFiles(path.join(repoRoot,'server','src')), dependencies = new Set();
  // Imported curried guards are resolved at their actual route invocation, not
  // solely at a local variable initializer. Include those dependency bytes too.
  enumerateWriteRoutes(repoRoot, { dependencies });
  const files = [...new Set([...routed, ...dependencies,
    ...['middleware.ts','moduleGuard.ts','permissionGuard.ts','permissionService.ts','currentWriteActor.ts'].map(f=>path.join(repoRoot,'server','src','auth',f))])].sort();
  const evidence = files.filter(f=>fs.existsSync(f)).map(file=>({file:path.relative(repoRoot,file),sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')}));
  return { sha256:createHash('sha256').update(JSON.stringify(evidence)).digest('hex'), files:evidence };
}
/** Same-source correction is measurement evidence, never a permission cap or a
 * release claim. Registration changes need a separate explicit set-change log. */
export function validateMeasurementCorrection(correction, current, evidence) {
  const failures = [], hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  if (!correction?.sourceEvidence?.files || hash(correction.sourceEvidence.files) !== correction.sourceEvidence.sha256
    || correction.sourceEvidence.sha256 !== evidence.sha256) failures.push('current source manifest mismatch');
  const application = correction?.applicationSourceEvidence;
  if (!application?.files?.length || hash(application.files) !== application.sha256) failures.push('application source manifest missing or corrupt');
  for (const side of ['before', 'after']) {
    const read = correction?.[side];
    if (!Array.isArray(read?.routes) || !Array.isArray(read?.unknown) || !read?.scannerEvidence?.length
      || read.applicationSourceDigest !== application?.sha256) { failures.push(`${side}: exact same-source reading missing`); continue; }
    if (JSON.stringify(summarize(read.routes)) !== JSON.stringify(read.summary)) failures.push(`${side}: summary not derived from routes`);
  }
  if (correction?.before?.measurement === correction?.after?.measurement
    || correction?.after?.measurement !== SURFACE_MEASUREMENT_VERSION) failures.push('measurement version mismatch');
  if (correction?.before?.routes && correction?.after?.routes && Object.keys(reconcileSiteLists(
    { registrations: correction.before.routes.map(siteKey) }, { registrations: correction.after.routes.map(siteKey) })).length)
    failures.push('same-source registration multiplicity changed');
  if (JSON.stringify(correction?.after?.routes) !== JSON.stringify(current.routes)
    || JSON.stringify(correction?.after?.unknown) !== JSON.stringify(current.unknown)) failures.push('after reading differs from current measurement');
  return failures;
}
/** Audit checks are reusable counterprobe targets; they do not accept a cap
 * increase just because a newly generated baseline has the same current count. */
export function validateSetChangeLog(baseline) {
  const failures=[], log=baseline._setChangeLog??[];
  if(!Array.isArray(log)) return ['change log is not an array'];
  for(let i=0;i<log.length;i++) {
    const e=log[i];
    if(String(e.reason??'').trim().length<5) failures.push(`entry ${i}: reason missing`);
    if(!e.measurementVersion||!/^([a-f0-9]{40})$/.test(e.sourceCommit??'')||!e.sourceEvidence?.sha256||!e.sourceEvidence?.files?.length) failures.push(`entry ${i}: source evidence missing`);
    if(e.sourceEvidence?.files&&createHash('sha256').update(JSON.stringify(e.sourceEvidence.files)).digest('hex')!==e.sourceEvidence.sha256) failures.push(`entry ${i}: source manifest digest mismatch`);
    if(!e.beforeLists||!e.afterLists) { failures.push(`entry ${i}: exact signature lists missing`);continue; }
    const drift=reconcileSiteLists(e.beforeLists,e.afterLists);
    const added=Object.fromEntries(Object.keys(drift).sort().map(k=>[k,[...drift[k].added].sort()]));
    const removed=Object.fromEntries(Object.keys(drift).sort().map(k=>[k,[...drift[k].removed].sort()]));
    if(JSON.stringify(added)!==JSON.stringify(e.added)||JSON.stringify(removed)!==JSON.stringify(e.removed)) failures.push(`entry ${i}: delta does not match exact signature lists`);
    if(surfaceSetDigest(e.beforeLists)!==e.beforeDigest||surfaceSetDigest(e.afterLists)!==e.afterDigest) failures.push(`entry ${i}: digest mismatch`);
    if(e.nakedCountAfter!==e.afterLists.nakedWriteRoutes.length) failures.push(`entry ${i}: count mismatch`);
    if(i&&log[i-1].afterDigest!==e.beforeDigest) failures.push(`entry ${i}: prior audit chain mismatch`);
  }
  if(log.length&&surfaceSetDigest(baseline)!==log.at(-1).afterDigest) failures.push('current lists differ from final audited lists');
  return failures;
}
