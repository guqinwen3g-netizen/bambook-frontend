/**
 * Narrow, source-backed G41 evidence for middleware shapes the text scanner
 * cannot safely classify. This module reads text only; unknown shapes stay
 * unknown. It does not import application code or grant runtime permissions.
 */
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

const unwrap = node => {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node))) node = node.expression;
  return node;
};
const ident = (node, name) => !!node && ts.isIdentifier(unwrap(node)) && unwrap(node).text === name;
const call = node => { const value = unwrap(node); return value && ts.isCallExpression(value) ? value : null; };
const functionNode = node => !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
const parameterNames = fn => fn.parameters.map(p => ts.isIdentifier(p.name) ? p.name.text : null);
const requestParameters = fn => JSON.stringify(parameterNames(fn)) === JSON.stringify(['req', 'res', 'next']);
const sourceCache = new Map();
const bindingCache = new WeakMap();
const contractCache = new WeakMap();
const parse = text => {
  if (!sourceCache.has(text)) sourceCache.set(text, ts.createSourceFile('g41-evidence.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
  return sourceCache.get(text);
};

function bindingNames(name) {
  if (!name) return [];
  if (ts.isIdentifier(name)) return [name.text];
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    return name.elements.flatMap(element => ts.isBindingElement(element) ? bindingNames(element.name) : []);
  }
  return [];
}
function localBindings(source) {
  if (bindingCache.has(source)) return bindingCache.get(source);
  const bindings = new Map();
  const visit = node => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) || ts.isClassDeclaration(node)) {
      for (const name of bindingNames(node.name)) {
        const declarations = bindings.get(name) ?? [];
        declarations.push(node);
        bindings.set(name, declarations);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  bindingCache.set(source, bindings);
  return bindings;
}

/** Imports are a provenance check, never a name-only permission whitelist. */
function trustedImports(source, modulePath, exportedName) {
  const bindings = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== modulePath || statement.importClause?.isTypeOnly) continue;
    const named = statement.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const element of named.elements) {
      if (!element.isTypeOnly && (element.propertyName?.text ?? element.name.text) === exportedName) bindings.push(element.name.text);
    }
  }
  // A local declaration or parameter with the same spelling invalidates this
  // bounded proof. It must not launder a shadowed fake through a genuine import.
  const locals = localBindings(source);
  return new Set(bindings.filter(name => !locals.has(name)));
}

function responseStatus(expression, status) {
  const response = call(expression);
  if (!response || !ts.isPropertyAccessExpression(response.expression) || !['json', 'send', 'end'].includes(response.expression.name.text)) return false;
  let unsafePayload = false;
  const payload = node => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node) || (ts.isIdentifier(node) && node.text === 'next') ||
      (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment)) unsafePayload = true;
    ts.forEachChild(node, payload);
  };
  response.arguments.forEach(payload);
  if (unsafePayload) return false;
  const statusCall = call(response.expression.expression);
  return !!statusCall && ts.isPropertyAccessExpression(statusCall.expression) && ident(statusCall.expression.expression, 'res') &&
    statusCall.expression.name.text === 'status' && statusCall.arguments.length === 1 &&
    ts.isNumericLiteral(statusCall.arguments[0]) && status(Number(statusCall.arguments[0].text));
}

function responseDenial(statement, status) {
  if (ts.isBlock(statement)) {
    if (statement.statements.length !== 1) return false;
    return responseDenial(statement.statements[0], status);
  }
  if (!ts.isReturnStatement(statement)) return false;
  return responseStatus(statement.expression, status);
}

/** Only the actual local Promise wrapper shape is credited, not its display name. */
function forwardingWrapper(declaration) {
  if (!declaration?.body || declaration.parameters.length !== 1 || !ts.isIdentifier(declaration.parameters[0].name) ||
    declaration.body.statements.length !== 1 || !ts.isReturnStatement(declaration.body.statements[0])) return false;
  const forwarded = unwrap(declaration.body.statements[0].expression);
  if (!functionNode(forwarded) || !requestParameters(forwarded) || !ts.isBlock(forwarded.body) || forwarded.body.statements.length !== 1) return false;
  const statement = forwarded.body.statements[0];
  if (!ts.isExpressionStatement(statement)) return false;
  const caught = call(statement.expression);
  if (!caught || !ts.isPropertyAccessExpression(caught.expression) || caught.expression.name.text !== 'catch' || caught.arguments.length !== 1) return false;
  const invoke = call(caught.expression.expression);
  if (!invoke || !ident(invoke.expression, declaration.parameters[0].name.text) || invoke.arguments.length !== 3 ||
    !invoke.arguments.every((arg, index) => ident(arg, ['req', 'res', 'next'][index]))) return false;
  const onError = unwrap(caught.arguments[0]);
  if (!functionNode(onError) || !ts.isBlock(onError.body)) return false;
  let failsClosed = false;
  for (const statement of onError.body.statements) {
    const logging = ts.isExpressionStatement(statement) ? call(statement.expression) : null;
    if (logging && ts.isPropertyAccessExpression(logging.expression) && ident(logging.expression.expression, 'logger') && logging.expression.name.text === 'error') continue;
    if (ts.isIfStatement(statement) && !statement.elseStatement && ts.isPrefixUnaryExpression(statement.expression) &&
      statement.expression.operator === ts.SyntaxKind.ExclamationToken && ts.isPropertyAccessExpression(statement.expression.operand) &&
      ident(statement.expression.operand.expression, 'res') && statement.expression.operand.name.text === 'headersSent' &&
      ts.isBlock(statement.thenStatement) && statement.thenStatement.statements.length === 1 &&
      ts.isExpressionStatement(statement.thenStatement.statements[0]) &&
      responseStatus(statement.thenStatement.statements[0].expression, status => status >= 500 && status <= 599)) { failsClosed = true; continue; }
    return false;
  }
  // Logging cannot hide next(), pass next onward, or alias it for later use.
  let continues = false;
  const visit = node => {
    if (ts.isIdentifier(node) && node.text === 'next') continues = true;
    ts.forEachChild(node, visit);
  };
  visit(onError.body);
  return failsClosed && !continues;
}

function identityMiddleware(fn, extractorNames) {
  if (!functionNode(fn) || !requestParameters(fn) || !ts.isBlock(fn.body) || fn.body.statements.length !== 4) return false;
  const [load, deny, attach, proceed] = fn.body.statements;
  if (!ts.isVariableStatement(load) || load.declarationList.declarations.length !== 1) return false;
  const principal = load.declarationList.declarations[0];
  const loading = call(principal.initializer);
  if (!ts.isIdentifier(principal.name) || !loading || !ts.isIdentifier(loading.expression) || !extractorNames.has(loading.expression.text) ||
    loading.arguments.length !== 1 || !ident(loading.arguments[0], 'req')) return false;
  if (!ts.isIfStatement(deny) || deny.elseStatement || !ts.isPrefixUnaryExpression(deny.expression) ||
    deny.expression.operator !== ts.SyntaxKind.ExclamationToken || !ident(deny.expression.operand, principal.name.text) ||
    !responseDenial(deny.thenStatement, status => status === 401)) return false;
  if (!ts.isExpressionStatement(attach) || !ts.isBinaryExpression(attach.expression) || attach.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isPropertyAccessExpression(unwrap(attach.expression.left)) || unwrap(attach.expression.left).name.text !== 'actor' ||
    !ident(unwrap(attach.expression.left).expression, 'req') || !ident(attach.expression.right, principal.name.text)) return false;
  const next = ts.isExpressionStatement(proceed) ? call(proceed.expression) : null;
  return !!next && ident(next.expression, 'next') && next.arguments.length === 0;
}

/** A local factory returning verified identity middleware is identity only. */
export function extractVerifiedIdentityFactories(src) {
  const source = parse(src);
  if (source.parseDiagnostics.length) return {};
  const extractorNames = trustedImports(source, '../auth/middleware', 'extractActorFromRequest');
  if (!extractorNames.size) return {};
  const bindings = localBindings(source);
  const functions = new Map(source.statements.filter(ts.isFunctionDeclaration).filter(fn => fn.name).map(fn => [fn.name.text, fn]));
  const out = {};
  for (const [name, factory] of functions) {
    if (bindings.get(name)?.length !== 1) continue;
    if (!factory.body || factory.body.statements.length !== 1 || !ts.isReturnStatement(factory.body.statements[0])) continue;
    const result = unwrap(factory.body.statements[0].expression);
    if (!result) continue;
    let middleware = result;
    if (ts.isCallExpression(result)) {
      if (!ts.isIdentifier(result.expression) || bindings.get(result.expression.text)?.length !== 1 ||
        result.arguments.length !== 1 || !forwardingWrapper(functions.get(result.expression.text))) continue;
      middleware = unwrap(result.arguments[0]);
    }
    if (identityMiddleware(middleware, extractorNames)) out[name] = { cls: 'identity', factory: name, booleanGated: false,
      provenance: '../auth/middleware#extractActorFromRequest', denies: true };
  }
  return out;
}

function pureCondition(node) {
  node = unwrap(node);
  if (!node) return false;
  if (ts.isIdentifier(node) || ts.isLiteralExpression(node) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)) return true;
  if (ts.isPropertyAccessExpression(node)) return pureCondition(node.expression);
  if (ts.isElementAccessExpression(node)) return pureCondition(node.expression) && pureCondition(node.argumentExpression);
  if (ts.isArrayLiteralExpression(node)) return node.elements.every(pureCondition);
  if (ts.isObjectLiteralExpression(node)) return node.properties.every(p => ts.isPropertyAssignment(p) && pureCondition(p.initializer));
  if (ts.isCallExpression(node) && ident(node.expression, 'String') && node.arguments.length === 1) return pureCondition(node.arguments[0]);
  if (ts.isPrefixUnaryExpression(node)) return node.operator === ts.SyntaxKind.ExclamationToken && pureCondition(node.operand);
  if (ts.isBinaryExpression(node)) return [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind) &&
    pureCondition(node.left) && pureCondition(node.right);
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'includes' &&
    ts.isArrayLiteralExpression(unwrap(node.expression.expression))) return pureCondition(node.expression.expression) && node.arguments.every(pureCondition);
  return false;
}

function literalScopes(node) {
  node = unwrap(node);
  if (ts.isStringLiteral(node) && /^[a-z][\w-]*(?::[\w-]+)+$/.test(node.text)) return [node.text];
  if (!ts.isConditionalExpression(node) || !pureCondition(node.condition)) return null;
  const left = literalScopes(node.whenTrue), right = literalScopes(node.whenFalse);
  return left && right ? [...left, ...right] : null;
}

/**
 * Credit only a full, terminal curried permission call. A conditional gate with
 * an ungated arm, a fake import, early next(), or an unrelated helper stays unknown.
 */
export function classifyCompletePermissionMiddleware(argText, src) {
  if (!src || !argText.includes('=>') || !/\bnext\b/.test(argText)) return null;
  const source = parse(src);
  if (source.parseDiagnostics.length) return null;
  const permissions = trustedImports(source, '../auth/permissionGuard', 'requirePermission');
  if (!permissions.size) return null;
  const parsed = parse(`const __g41Middleware = (${argText});`);
  if (parsed.parseDiagnostics.length) return null;
  const declaration = parsed.statements[0]?.declarationList?.declarations[0];
  const fn = unwrap(declaration?.initializer);
  if (!functionNode(fn) || !requestParameters(fn)) return null;
  const permissionInvoke = expr => {
    const invoke = call(expr), gate = invoke && call(invoke.expression);
    if (!invoke || !gate || !ts.isIdentifier(gate.expression) || !permissions.has(gate.expression.text) || gate.arguments.length !== 1 ||
      invoke.arguments.length !== 3 || !invoke.arguments.every((arg,index)=>ident(arg,['req','res','next'][index]))) return null;
    return literalScopeSet(gate.arguments[0]);
  };
  if (!ts.isBlock(fn.body)) {
    let values = permissionInvoke(fn.body);
    if (!values) {
      const outer = call(fn.body);
      const declaration = outer && ts.isIdentifier(outer.expression) ? localBindings(source).get(outer.expression.text) : null;
      const initial = declaration?.length === 1 && ts.isVariableDeclaration(declaration[0]) ? call(declaration[0].initializer) : null;
      const factory = initial && ts.isIdentifier(initial.expression) ? contractImports(source).get(initial.expression.text) : null;
      const continuation = outer?.arguments.length === 3 ? unwrap(outer.arguments[2]) : null;
      if (factory?.cls !== 'identity' || !outer.arguments.slice(0,2).every((arg,index)=>ident(arg,['req','res'][index])) ||
        !functionNode(continuation) || continuation.parameters.length || ts.isBlock(continuation.body)) return null;
      values = permissionInvoke(continuation.body);
    }
    return values ? {cls:'permission',booleanGated:false,readScopeKnown:values.every(s=>s.endsWith(':read')),
      scopes:values,provenance:'../auth/permissionGuard#requirePermission terminal continuation'} : null;
  }
  if (!fn.body.statements.length) return null;
  if (localBindings(source).has('String') || localBindings(parsed).has('String')) return null;
  const scopes = [];
  const terminal = statement => {
    if (responseDenial(statement, status => status >= 400 && status < 500)) return true;
    if (ts.isBlock(statement)) return sequence([...statement.statements]);
    if (!ts.isReturnStatement(statement)) return false;
    const invoke = call(statement.expression), gate = invoke && call(invoke.expression);
    if (!invoke || !gate || !ts.isIdentifier(gate.expression) || !permissions.has(gate.expression.text) || gate.arguments.length !== 1 ||
      invoke.arguments.length !== 3 || !invoke.arguments.every((arg, index) => ident(arg, ['req', 'res', 'next'][index]))) return false;
    const values = literalScopeSet(gate.arguments[0]);
    if (!values) return false;
    scopes.push(...values);
    return true;
  };
  const sequence = statements => {
    if (!statements.length) return false;
    const [first, ...rest] = statements;
    if (ts.isVariableStatement(first) && first.declarationList.declarations.every(d => ts.isIdentifier(d.name) &&
      !permissions.has(d.name.text) && !['req', 'res', 'next', 'String'].includes(d.name.text) && pureCondition(d.initializer))) return sequence(rest);
    if (ts.isIfStatement(first) && pureCondition(first.expression)) {
      if (!terminal(first.thenStatement)) return false;
      if (first.elseStatement) return rest.length === 0 && terminal(first.elseStatement);
      return sequence(rest);
    }
    return rest.length === 0 && terminal(first);
  };
  return sequence([...fn.body.statements]) && scopes.length ? { cls: 'permission', booleanGated: false,
    readScopeKnown: scopes.every(scope => scope.endsWith(':read')), provenance: '../auth/permissionGuard#requirePermission', scopes } : null;
}

/** Measurement version; changes to evidence semantics must be audited separately
 * from changes to the application route set. This is source evidence, not HTTP proof. */
export const MEASUREMENT_VERSION = '2026-10-01-frozen-import-and-neutral-filter-v2';

function contractImports(source) {
  if (contractCache.has(source)) return contractCache.get(source);
  const out = new Map();
  const contracts = [
    ['../auth/moduleGuard', 'createModuleAuthGuard', 'identity', true],
    ['../auth/moduleGuard', 'requireJwtForWrite', 'identity', true],
    ['../auth/currentWriteActor', 'createCurrentWriteActor', 'identity', false],
    ['../auth/middleware', 'requireAuth', 'identity', false],
    ['../auth/middleware', 'requireRole', 'permission', false],
    ['../auth/permissionGuard', 'requirePermission', 'permission', false],
  ];
  for (const [module, exported, cls, configurable] of contracts) {
    for (const name of trustedImports(source, module, exported)) out.set(name, {
      cls, configurable, exported, provenance: `${module}#${exported}`,
    });
  }
  contractCache.set(source, out);
  return out;
}

function literalScopeSet(node) {
  node = unwrap(node);
  if (node && ts.isArrayLiteralExpression(node)) {
    const sets = node.elements.map(literalScopes);
    return sets.every(Boolean) ? sets.flat() : null;
  }
  return node ? literalScopes(node) : null;
}
function authAlwaysRequired(node) {
  node = unwrap(node);
  if (!node || !ts.isObjectLiteralExpression(node)) return false;
  // Later spread/property can replace requireAuth. Only a final explicit true
  // assignment after all spreads proves the factory cannot bypass identity.
  let required = false;
  for (const field of node.properties) {
    if (ts.isSpreadAssignment(field)) { required = false; continue; }
    const name = field.name && (ts.isIdentifier(field.name) || ts.isStringLiteral(field.name)) ? field.name.text : null;
    if (name === 'requireAuth') required = ts.isPropertyAssignment(field) && unwrap(field.initializer)?.kind === ts.SyntaxKind.TrueKeyword;
    else if (field.name && ts.isComputedPropertyName(field.name)) required = false;
  }
  return required;
}
function middlewareNode(text) {
  const source = parse(`const __g41 = (${text.replace(/^\s*\.{3}/, '')});`);
  return source.parseDiagnostics.length ? null : unwrap(source.statements[0]?.declarationList?.declarations[0]?.initializer);
}

/** Recognize an additive async data-filter shape without granting identity,
 * permission, freshness or row-scope credit. Independent guards remain required. */
function neutralDataFilter(node, source) {
  node = unwrap(node);
  if (!functionNode(node) || !requestParameters(node) || !ts.isBlock(node.body) || node.body.statements.length !== 1) return false;
  const block = node.body.statements[0];
  if (!ts.isTryStatement(block) || !block.catchClause || block.finallyBlock || !block.catchClause.variableDeclaration ||
    !ts.isIdentifier(block.catchClause.variableDeclaration.name)) return false;
  const errorName = block.catchClause.variableDeclaration.name.text;
  const statements = [...block.tryBlock.statements], proceed = statements.pop();
  const next = proceed && (ts.isExpressionStatement(proceed) || ts.isReturnStatement(proceed)) ? call(proceed.expression) : null;
  if (!next || !ident(next.expression, 'next') || next.arguments.length) return false;
  const hasNext = part => {
    let found = false;
    const visit = value => { if (ident(value, 'next')) found = true; ts.forEachChild(value, visit); };
    visit(part); return found;
  };
  const awaited = value => !!unwrap(value) && ts.isAwaitExpression(unwrap(value)) && !!call(unwrap(value).expression);
  const localTarget = value => {
    value = unwrap(value);
    return !!value && ts.isPropertyAccessExpression(value) && ts.isPropertyAccessExpression(unwrap(value.expression)) &&
      ident(unwrap(value.expression).expression, 'res') && unwrap(value.expression).name.text === 'locals';
  };
  let filtered = false;
  for (const statement of statements) {
    if (hasNext(statement)) return false;
    if (ts.isIfStatement(statement) && !statement.elseStatement && pureCondition(statement.expression) &&
      responseDenial(statement.thenStatement, status => status >= 400 && status < 500)) continue;
    if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
      const item = statement.declarationList.declarations[0];
      if (ts.isIdentifier(item.name) && awaited(item.initializer)) { filtered = true; continue; }
    }
    if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(unwrap(statement.expression))) {
      const assign = unwrap(statement.expression);
      if (assign.operatorToken.kind === ts.SyntaxKind.EqualsToken && localTarget(assign.left) &&
        (awaited(assign.right) || ident(assign.right, unwrap(assign.right)?.text))) { filtered = true; continue; }
    }
    return false;
  }
  if (!filtered || hasNext(block.catchClause.block)) return false;
  const safeNames = trustedImports(source, '../shared/routeError', 'safeRouteError');
  const safeResponse = (statement, name) => {
    if (!statement || !ts.isReturnStatement(statement)) return false;
    const response = call(statement.expression);
    if (!response || !ts.isPropertyAccessExpression(response.expression) || response.expression.name.text !== 'json' ||
      !response.arguments.every(pureCondition)) return false;
    const status = call(response.expression.expression);
    return !!status && ts.isPropertyAccessExpression(status.expression) && ident(status.expression.expression, 'res') &&
      status.expression.name.text === 'status' && status.arguments.length === 1 &&
      ts.isPropertyAccessExpression(unwrap(status.arguments[0])) && ident(unwrap(status.arguments[0]).expression, name) &&
      unwrap(status.arguments[0]).name.text === 'status';
  };
  const closed = (parts, inputName) => {
    const [load, ...rest] = parts;
    if (!load || !ts.isVariableStatement(load) || load.declarationList.declarations.length !== 1) return false;
    const item = load.declarationList.declarations[0], safe = call(item.initializer);
    if (!ts.isIdentifier(item.name) || !safe || !ts.isIdentifier(safe.expression) || !safeNames.has(safe.expression.text) ||
      !ident(safe.arguments[0], inputName)) return false;
    const final = rest.pop();
    if (!safeResponse(final, item.name.text)) return false;
    return rest.every(statement => {
      if (!ts.isIfStatement(statement) || statement.elseStatement || !pureCondition(statement.expression)) return false;
      const log = ts.isExpressionStatement(statement.thenStatement) ? call(statement.thenStatement.expression) : null;
      return !!log && ts.isPropertyAccessExpression(log.expression) && ident(log.expression.expression, 'logger') && log.expression.name.text === 'error';
    });
  };
  const caught = block.catchClause.block.statements;
  if (closed([...caught], errorName)) return true;
  if (caught.length !== 1 || !ts.isExpressionStatement(caught[0])) return false;
  const delegated = call(caught[0].expression);
  if (!delegated || !ts.isIdentifier(delegated.expression) || delegated.arguments.length !== 2 ||
    !ident(delegated.arguments[0], 'res') || !ident(delegated.arguments[1], errorName)) return false;
  const binding = localBindings(source).get(delegated.expression.text);
  const responder = binding?.length === 1 && ts.isVariableDeclaration(binding[0]) ? unwrap(binding[0].initializer) : null;
  return functionNode(responder) && JSON.stringify(parameterNames(responder)) === JSON.stringify(['res', 'error']) &&
    ts.isBlock(responder.body) && !hasNext(responder.body) && closed([...responder.body.statements], 'error');
}

/** Resolve only an actual relative, exported, frozen literal array. No caller
 * provided values, re-exports, mutable arrays, code execution or name whitelist. */
function importedFrozenLiterals(name, source, context) {
  if (!context?.filename || !context?.root || localBindings(source).has(name)) return null;
  const imports = source.statements.filter(ts.isImportDeclaration).flatMap(statement => {
    const named = statement.importClause?.namedBindings;
    if (statement.importClause?.isTypeOnly || !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.startsWith('.') || !named || !ts.isNamedImports(named)) return [];
    return named.elements.filter(element => !element.isTypeOnly && element.name.text === name)
      .map(element => ({ module: statement.moduleSpecifier.text, exported: element.propertyName?.text ?? name }));
  });
  if (imports.length !== 1) return null;
  try {
    const base = path.resolve(path.dirname(context.filename), imports[0].module);
    const candidates = [base + '.ts', path.join(base, 'index.ts')].filter(file => fs.existsSync(file));
    if (candidates.length !== 1) return null;
    const root = fs.realpathSync(context.root), file = fs.realpathSync(candidates[0]);
    if (!file.startsWith(root + path.sep)) return null;
    const remote = parse(fs.readFileSync(file, 'utf8'));
    if (remote.parseDiagnostics.length || localBindings(remote).has('Object') || remote.statements.some(statement =>
      ts.isImportDeclaration(statement) && (statement.importClause?.name?.text === 'Object' ||
        (statement.importClause?.namedBindings && (ts.isNamespaceImport(statement.importClause.namedBindings) ? statement.importClause.namedBindings.name.text === 'Object'
          : statement.importClause.namedBindings.elements.some(element => element.name.text === 'Object')))))) return null;
    const declarations = remote.statements.filter(statement => ts.isVariableStatement(statement) &&
      statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
      !!(statement.declarationList.flags & ts.NodeFlags.Const))
      .flatMap(statement => statement.declarationList.declarations)
      .filter(declaration => ident(declaration.name, imports[0].exported));
    if (declarations.length !== 1 || localBindings(remote).get(imports[0].exported)?.length !== 1) return null;
    const frozen = call(declarations[0].initializer);
    if (!frozen || !ts.isPropertyAccessExpression(frozen.expression) || !ident(frozen.expression.expression, 'Object') ||
      frozen.expression.name.text !== 'freeze' || frozen.arguments.length !== 1) return null;
    const values = unwrap(frozen.arguments[0]);
    if (!values || !ts.isArrayLiteralExpression(values) || !values.elements.length ||
      !values.elements.every(value => ts.isStringLiteral(value) && value.text.trim())) return null;
    let overwritesFreeze = false;
    const visit = node => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        ts.isPropertyAccessExpression(unwrap(node.left)) && ident(unwrap(node.left).expression, 'Object')) overwritesFreeze = true;
      ts.forEachChild(node, visit);
    };
    visit(remote);
    if (overwritesFreeze) return null;
    context.dependencies?.add(file);
    return [...values.elements];
  } catch { return null; }
}

/** Proven imported APIs, including aliases. Similar display names are unknown. */
export function classifyImportedMiddlewareArgument(argText, src, context) {
  if (!src) return null;
  const source = parse(src);
  if (source.parseDiagnostics.length) return null;
  const node = middlewareNode(argText), invocation = call(node);
  const name = invocation ? invocation.expression : node;
  if (!name || !ts.isIdentifier(name)) return null;
  const contract = contractImports(source).get(name.text);
  if (!contract) return null;
  if (contract.exported === 'requireAuth') return invocation ? null : { ...contract, booleanGated: false };
  if (!invocation) return null; // Factories themselves are not returned middleware.
  if (contract.exported === 'requirePermission') {
    const scopes = literalScopeSet(invocation.arguments[0]);
    if (!scopes) return null;
    return { ...contract, booleanGated: false, scopes, readScopeKnown: scopes.every(s => s.endsWith(':read')) };
  }
  if (contract.exported === 'requireRole') {
    const roleValues = invocation.arguments.flatMap(arg => {
      if (!ts.isSpreadElement(arg)) return [unwrap(arg)];
      if (!ts.isIdentifier(unwrap(arg.expression))) return [null];
      const binding = localBindings(source).get(unwrap(arg.expression).text);
      const array = binding?.length === 1 && ts.isVariableDeclaration(binding[0]) ? unwrap(binding[0].initializer) : null;
      return array && ts.isArrayLiteralExpression(array) ? [...array.elements].map(unwrap)
        : importedFrozenLiterals(unwrap(arg.expression).text, source, context) ?? [null];
    });
    if (!roleValues.length || !roleValues.every(a => a && ts.isStringLiteral(a))) return null;
    return { ...contract, booleanGated: false, readScopeKnown: false };
  }
  return { ...contract, booleanGated: contract.configurable && !authAlwaysRequired(invocation.arguments[0]) };
}

/** A pure wrapper that delegates to the real auth factory, preserving its actual
 * configuration argument. The wrapper name, factory parameter spelling and
 * unrelated requireAuth words cannot authorize anything. */
function delegatedAuthFactories(source) {
  const contracts = contractImports(source), bindings = localBindings(source), out = {};
  for (const fn of source.statements.filter(ts.isFunctionDeclaration)) {
    if (!fn.name || bindings.get(fn.name.text)?.length !== 1 || fn.parameters.length !== 1 || !fn.body ||
      fn.body.statements.length !== 1 || !ts.isReturnStatement(fn.body.statements[0])) continue;
    const invoke = call(fn.body.statements[0].expression);
    if (!invoke || !ts.isIdentifier(invoke.expression) || invoke.arguments.length !== 1) continue;
    const contract = contracts.get(invoke.expression.text);
    if (!contract || contract.exported !== 'createModuleAuthGuard') continue;
    const config = unwrap(invoke.arguments[0]);
    if (!config || (!ts.isObjectLiteralExpression(config) && !ts.isIdentifier(config))) continue;
    out[fn.name.text] = { ...contract, booleanGated: !authAlwaysRequired(config), factory: fn.name.text };
  }
  return out;
}

/** Server authSource session gate. Only exact server-owned authSource is proof;
 * req.body/auth-header spelling or a nonterminal denial is not. */
function sessionGate(fn) {
  if (!functionNode(fn) || !requestParameters(fn) || !ts.isBlock(fn.body) || fn.body.statements.length !== 2) return false;
  const [deny, proceed] = fn.body.statements;
  const condition = ts.isIfStatement(deny) ? unwrap(deny.expression) : null;
  if (!condition || !ts.isBinaryExpression(condition) || condition.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    !ts.isPropertyAccessExpression(unwrap(condition.left)) || unwrap(condition.left).name.text !== 'authSource' ||
    !ident(unwrap(condition.left).expression, 'req') || !ts.isStringLiteral(unwrap(condition.right)) || unwrap(condition.right).text !== 'user-session' || deny.elseStatement ||
    !responseDenial(deny.thenStatement, status => status === 401)) return false;
  const next = ts.isExpressionStatement(proceed) ? call(proceed.expression) : null;
  return !!next && ident(next.expression, 'next') && !next.arguments.length;
}

/** Enumerate actual initializers rather than scanning require/create display
 * names. Unknown initializers remain unknown and cannot be laundered by arrays. */
export function extractVerifiedMiddlewareDefinitions(src, context) {
  const source = parse(src);
  if (source.parseDiagnostics.length) return {};
  const out = {}, factories = { ...extractVerifiedIdentityFactories(src), ...delegatedAuthFactories(source) };
  const variables = [];
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) variables.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const declaration of variables) {
    const node = unwrap(declaration.initializer), name = declaration.name.text;
    const imported = classifyImportedMiddlewareArgument(node.getText(source), src, context);
    if (imported) { out[name] = { ...imported, factory: call(node)?.expression.getText(source) }; continue; }
    const invoke = call(node);
    if (invoke && ts.isIdentifier(invoke.expression)) {
      if (factories[invoke.expression.text]) { out[name] = { ...factories[invoke.expression.text] }; continue; }
      const binding = localBindings(source).get(invoke.expression.text);
      const factory = binding?.length === 1 && ts.isVariableDeclaration(binding[0]) ? unwrap(binding[0].initializer) : null;
      if (functionNode(factory) && neutralDataFilter(factory.body, source)) { out[name] = { cls: 'nonPermission', factory: invoke.expression.text, booleanGated: false, provenance: 'additive async locals filter; no identity/scope/freshness credit' }; continue; }
      // A call resembling a gate but without provenance must block the older
      // body/name fallback. Service constructors are not middleware evidence.
      out[name] = { cls: 'unknown', factory: invoke.expression.text, booleanGated: false };
    }
    const complete = classifyCompletePermissionMiddleware(node.getText(source), src);
    if (complete) { out[name] = { ...complete, factory: 'terminal-permission-middleware' }; continue; }
    if (sessionGate(node)) out[name] = { cls: 'identity', factory: 'server-authSource-gate', booleanGated: false, provenance: 'req.authSource=user-session + terminal401' };
    else if (neutralDataFilter(node, source)) out[name] = { cls: 'nonPermission', factory: 'additive-filter', booleanGated: false, provenance: 'additive async locals filter; no identity/scope/freshness credit' };
  }
  return out;
}

/** Evidence for an argument, including a local delegating factory invocation. */
export function classifyVerifiedMiddlewareArgument(argText, src, context) {
  const complete = classifyCompletePermissionMiddleware(argText, src);
  if (complete) return complete;
  const imported = classifyImportedMiddlewareArgument(argText, src, context);
  if (imported) return imported;
  if (!src) return null;
  const source = parse(src), node = middlewareNode(argText), invoke = call(node);
  if (!source.parseDiagnostics.length) { const parser=multerParserEvidence(node,source);if(parser)return parser; }
  if (!source.parseDiagnostics.length && invoke && ts.isIdentifier(invoke.expression)) {
    const factory = { ...extractVerifiedIdentityFactories(src), ...delegatedAuthFactories(source) }[invoke.expression.text];
    if (factory) return factory;
    const binding = localBindings(source).get(invoke.expression.text);
    const delegated = binding?.length === 1 && ts.isVariableDeclaration(binding[0]) ? unwrap(binding[0].initializer) : null;
    if (functionNode(delegated) && neutralDataFilter(delegated.body, source)) return { cls: 'nonPermission', booleanGated: false, provenance: 'additive async locals filter; no identity/scope/freshness credit' };
  }
  if (node && neutralDataFilter(node, source)) return { cls: 'nonPermission', booleanGated: false, provenance: 'additive async locals filter; no identity/scope/freshness credit' };
  if (node && sessionGate(node)) return { cls: 'identity', booleanGated: false, provenance: 'req.authSource=user-session + terminal401' };
  return null;
}

function multerParserEvidence(node, source) {
  const locals=localBindings(source), multerNames=[];
  for(const statement of source.statements) if(ts.isImportDeclaration(statement)&&ts.isStringLiteral(statement.moduleSpecifier)&&
    statement.moduleSpecifier.text==='multer'&&!statement.importClause?.isTypeOnly&&statement.importClause?.name&&!locals.has(statement.importClause.name.text)) multerNames.push(statement.importClause.name.text);
  const actualParser=(value,seen=new Set())=>{
    value=unwrap(value);if(!value)return false;
    if(ts.isIdentifier(value)) {
      if(seen.has(value.text))return false;seen.add(value.text);
      const declarations=locals.get(value.text);
      return declarations?.length===1&&ts.isVariableDeclaration(declarations[0])&&actualParser(declarations[0].initializer,seen);
    }
    const invoke=call(value);if(!invoke)return false;
    if(ts.isIdentifier(invoke.expression)&&multerNames.includes(invoke.expression.text))return true;
    return ts.isPropertyAccessExpression(invoke.expression)&&['single','array','fields','any','none'].includes(invoke.expression.name.text)&&actualParser(invoke.expression.expression,seen);
  };
  if(actualParser(node))return {cls:'nonPermission',booleanGated:false,provenance:'multer import + actual parser initializer; no identity/scope credit'};
  if(!functionNode(node)||!requestParameters(node))return null;
  const body=ts.isBlock(node.body)?node.body.statements.length===1&&ts.isExpressionStatement(node.body.statements[0])?node.body.statements[0].expression:null:node.body;
  const invoke=call(body);
  if(!invoke||invoke.arguments.length!==3||!invoke.arguments.slice(0,2).every((arg,index)=>ident(arg,['req','res'][index]))||!actualParser(invoke.expression))return null;
  return {cls:'nonPermission',booleanGated:false,provenance:'multer import + parser(req,res,callback); no identity/scope credit'};
}
