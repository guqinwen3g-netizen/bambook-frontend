import ts from 'typescript';
import path from 'node:path';

/** Source evidence only. No module is imported/executed and no DB is opened.
 * The TypeScript binder resolves actual local/imported declarations, including
 * aliases and shadowing. Message extraction is separate from HTTP authority:
 * a keyword tier assigned to a literal is never a typed error's HTTP status.
 */
export const TIER_MESSAGE_MEASUREMENT = 'ast-bound-error-sources-v1';
const LEGACY_THROW_RE = /throw new \w*(?:Error|Exception)\(\s*(?:`([^`\n$]{3,140})`|'([^'\n]{3,140})'|"([^"\n]{3,140})")/g;
const BUILTINS = new Set(['Error', 'TypeError', 'SyntaxError', 'ReferenceError', 'RangeError', 'URIError', 'EvalError']);
const INTERNAL_CONTRACTS = new Map([
  ['src/inventory/inventoryService.ts|StockMovementCasConflictError', 'internal-cas-retry'],
  ['src/lib/ssrfGuard.ts|SsrfBlockedError', 'internal-network-policy'],
  ['src/templates/render.ts|TemplateNotFoundError', 'internal-template-id'],
  ['src/templates/render.ts|TemplateRenderError', 'internal-template-cause'],
  ['src/claims/creditNoteService.ts|CreditNoteTransactionError', 'internal-result-wrapper'],
]);
const unwrap = node => {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
    || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node))) node = node.expression;
  return node;
};
const normalized = file => file.replaceAll('\\', '/').replace(/^\.\//, '');
const internalKey = (file, name) => `${normalized(file).replace(/^.*?(?=src\/)/, '')}|${name}`;
const propertyName = node => node && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : null;
function visit(node, callback) { callback(node); ts.forEachChild(node, child => visit(child, callback)); }
function makeProgram(entries) {
  const sources = new Map(entries.map(entry => [path.posix.resolve('/source', normalized(entry.file ?? entry.rel)), entry.src]));
  const parsed = new Map();
  const options = { noLib: true, allowJs: true, target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Node10, jsx: ts.JsxEmit.Preserve };
  const host = {
    getSourceFile(file) {
      file = normalized(file); if (!sources.has(file)) return undefined;
      if (!parsed.has(file)) parsed.set(file, ts.createSourceFile(file, sources.get(file), options.target, true));
      return parsed.get(file);
    },
    fileExists: file => sources.has(normalized(file)), readFile: file => sources.get(normalized(file)),
    directoryExists: dir => [...sources.keys()].some(file => file.startsWith(normalized(dir).replace(/\/$/, '') + '/')),
    getDirectories: () => [], getCurrentDirectory: () => '/source', getCanonicalFileName: file => file,
    getDefaultLibFileName: () => '/source/no-library.d.ts', useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n', writeFile() {},
  };
  const program = ts.createProgram([...sources.keys()], options, host);
  const checker = program.getTypeChecker();
  const symbol = node => {
    if (!node) return null;
    const bound = checker.getSymbolAtLocation(node);
    if (bound?.flags & ts.SymbolFlags.Alias) {
      const actual = checker.getAliasedSymbol(bound);
      return actual?.declarations?.length ? actual : bound;
    }
    // Parameter properties have a property symbol at the declaration and a
    // local parameter symbol in super(...). Both refer to the same real node.
    const parameter = bound?.declarations?.[0];
    if (parameter && ts.isParameter(parameter)) return checker.getSymbolAtLocation(parameter.name) ?? bound;
    return bound ?? null;
  };
  const declaration = node => symbol(node)?.declarations?.[0] ?? null;
  const builtin = (node, names = BUILTINS) => ts.isIdentifier(node) && names.has(node.text) && !symbol(node);
  return { program, checker, symbol, declaration, builtin };
}

function privateResultBoundaries(binding) {
  const { program, checker, symbol, declaration, builtin } = binding;
  const same = (a, b) => symbol(a) && symbol(a) === symbol(b);
  const codesOf = node => {
    if (!node) return null;
    const type = checker.getTypeAtLocation(node), types = type.isUnion() ? type.types : [type];
    return types.length && types.every(t => t.flags & ts.TypeFlags.StringLiteral) ? types.map(t => t.value) : null;
  };
  const field = (object, name) => object && ts.isObjectLiteralExpression(object)
    ? object.properties.find(p => ts.isPropertyAssignment(p) && propertyName(p.name) === name)?.initializer : null;
  const proofs = new Map();
  for (const source of program.getSourceFiles()) visit(source, klass => {
    if (!ts.isClassDeclaration(klass) || !klass.name || klass.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) return;
    const base = klass.heritageClauses?.find(c => c.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
    if (!base || !builtin(base, new Set(['Error']))) return;
    const ctor = klass.members.find(ts.isConstructorDeclaration);
    const codeParameter = ctor?.parameters.find(p => propertyName(p.name) === 'code' && p.modifiers?.length);
    const codes = codesOf(codeParameter?.type);
    if (!ctor?.body || !codes || klass.members.some(m => propertyName(m.name) === 'statusCode')
      || ctor.parameters.some(p => propertyName(p.name) === 'statusCode')) return;
    let setsStatus = false;
    visit(ctor.body, node => { if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword
      && node.name.text === 'statusCode') setsStatus = true; });
    if (setsStatus) return;
    const producers = [];
    let unknownProducer = false;
    visit(source, node => {
      if (!ts.isNewExpression(node) || !same(node.expression, klass.name)) return;
      const suppliedCodes = codesOf(node.arguments?.[ctor.parameters.indexOf(codeParameter)]);
      if (!suppliedCodes?.length || suppliedCodes.some(code => !codes.includes(code))) unknownProducer = true;
      else producers.push(node);
    });
    if (unknownProducer || !producers.length) return;
    let consumer = null;
    visit(source, node => {
      if (!ts.isIfStatement(node) || !ts.isBinaryExpression(node.expression)
        || node.expression.operatorToken.kind !== ts.SyntaxKind.InstanceOfKeyword || !same(node.expression.right, klass.name)) return;
      const subject = node.expression.left;
      let fn = node.parent; while (fn && !ts.isFunctionDeclaration(fn)) fn = fn.parent;
      if (!fn?.body || !fn.name || !fn.parameters.some(p => same(p.name, subject))) return;
      const returnNode = ts.isReturnStatement(node.thenStatement) ? node.thenStatement
        : ts.isBlock(node.thenStatement) ? node.thenStatement.statements.find(ts.isReturnStatement) : null;
      const result = unwrap(returnNode?.expression), error = unwrap(field(result, 'error'));
      const code = field(error, 'code'), message = field(error, 'message');
      if (field(result, 'ok')?.kind !== ts.SyntaxKind.FalseKeyword || !code || !message
        || !ts.isPropertyAccessExpression(code) || code.name.text !== 'code' || !same(code.expression, subject)
        || !ts.isPropertyAccessExpression(message) || message.name.text !== 'message' || !same(message.expression, subject)) return;
      const unknownReturn = fn.body.statements.find(ts.isReturnStatement), unknownResult = unwrap(unknownReturn?.expression);
      const unknownError = unwrap(field(unknownResult, 'error')), unknownCode = field(unknownError, 'code');
      const unknownMessage = field(unknownError, 'message');
      if (field(unknownResult, 'ok')?.kind !== ts.SyntaxKind.FalseKeyword || !unknownCode
        || !ts.isStringLiteral(unknownCode) || unknownCode.text !== 'INTERNAL_ERROR'
        || !unknownMessage || !ts.isPropertyAccessExpression(unknownMessage) || unknownMessage.name.text !== 'message') return;
      const safeVariable = declaration(unknownMessage.expression), safeCall = unwrap(safeVariable?.initializer);
      const safeDeclaration = safeCall && ts.isCallExpression(safeCall) ? declaration(safeCall.expression) : null;
      const options = safeCall && ts.isCallExpression(safeCall) ? unwrap(safeCall.arguments[1]) : null;
      const fallback = field(options, 'fallbackCode');
      if (!safeDeclaration || !ts.isFunctionDeclaration(safeDeclaration) || safeDeclaration.name?.text !== 'safeRouteError'
        || !/(?:^|\/)src\/shared\/routeError\.ts$/.test(normalized(safeDeclaration.getSourceFile().fileName))
        || !options || !ts.isObjectLiteralExpression(options)
        || !fallback || !ts.isStringLiteral(fallback) || fallback.text !== 'INTERNAL_ERROR'
        || !ts.isIdentifier(safeCall.arguments[0]) || safeCall.arguments[0].text !== 'undefined' || symbol(safeCall.arguments[0])?.declarations?.length
        || options.properties.some(p => !ts.isPropertyAssignment(p) || !['fallbackCode', 'fallbackMessage'].includes(propertyName(p.name)))) return;
      const catches = [];
      visit(source, call => {
        if (!ts.isCallExpression(call) || !same(call.expression, fn.name) || !ts.isReturnStatement(call.parent)) return;
        let caught = call.parent; while (caught && !ts.isCatchClause(caught)) caught = caught.parent;
        if (caught?.variableDeclaration && same(call.arguments[0], caught.variableDeclaration.name)) catches.push(call);
      });
      if (catches.length) consumer = { fn, catches };
    });
    if (!consumer) return;
    const producer = producers[0]; let producerFunction = producer.parent;
    while (producerFunction && !ts.isFunctionDeclaration(producerFunction)) producerFunction = producerFunction.parent;
    if (!producerFunction?.name) return;
    proofs.set(klass, { file: normalized(source.fileName).replace(/^\/source\//, ''), className: klass.name.text,
      codes, producerLines: producers.map(n => source.getLineAndCharacterOfPosition(n.getStart()).line + 1),
      catchLines: consumer.catches.map(n => source.getLineAndCharacterOfPosition(n.getStart()).line + 1),
      consumerLine: source.getLineAndCharacterOfPosition(consumer.fn.getStart()).line + 1,
      constructorSource: klass.getText(source), producerSource: producerFunction.getText(source), producer: producerFunction.name.text,
      consumerSource: consumer.fn.getText(source), consumer: consumer.fn.name.text });
  });
  return proofs;
}

/** Finite native constructor -> actual instanceof result consumer -> catch
 * return -> safe unknown result. Names alone cannot exempt an internal wrapper.
 */
export function classifyPrivateResultBoundaries(entries) {
  return [...privateResultBoundaries(makeProgram(entries)).values()];
}

/** Kept byte-for-byte in spirit as a separate historical meter. Its results
 * include old code-as-message mistakes and comments; never call these HTTP facts.
 */
export function legacyTierMessageSources(entries) {
  const result = new Map();
  for (const entry of entries) {
    const file = normalized(entry.file ?? entry.rel);
    for (const match of entry.src.matchAll(LEGACY_THROW_RE)) {
      const message = (match[1] || match[2] || match[3] || '').trim();
      if (message && !message.includes('${')) result.set(`${file}|${message}`, { file, message });
    }
  }
  return [...result.values()].sort((a, b) => `${a.file}|${a.message}`.localeCompare(`${b.file}|${b.message}`));
}

export function scanTierMessageSources(entries) {
  const binding = makeProgram(entries);
  const resultBoundaries = privateResultBoundaries(binding);
  const { symbol, declaration, builtin } = binding;
  const classCache = new Map(), factoryCache = new Map();
  const nodeFile = node => normalized(node.getSourceFile().fileName).replace(/^\/source\//, '');
  const literal = node => {
    node = unwrap(node);
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text;
    if (node && ts.isNumericLiteral(node)) return Number(node.text);
    return null;
  };
  // Follow only actual parameters and immutable scalar constants; dynamic or
  // computed expressions are reported instead of evaluated or silently dropped.
  function substitute(node, environment, depth = 0) {
    node = unwrap(node); if (!node || depth > 12) return node;
    if (ts.isIdentifier(node)) {
      const bound = symbol(node);
      if (environment.has(bound)) return substitute(environment.get(bound), new Map(), depth + 1);
      const decl = declaration(node);
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer
        && (decl.parent.flags & ts.NodeFlags.Const) && literal(decl.initializer) !== null) return unwrap(decl.initializer);
    }
    return node;
  }
  function memberNames(klass) {
    const names = new Set();
    for (const member of klass.members) {
      if (member.name) names.add(propertyName(member.name));
      if (ts.isConstructorDeclaration(member)) {
        for (const p of member.parameters) if (p.modifiers?.some(m => [ts.SyntaxKind.PublicKeyword,
          ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.ReadonlyKeyword].includes(m.kind))) names.add(propertyName(p.name));
        if (member.body) visit(member.body, node => {
          if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
            && ts.isPropertyAccessExpression(node.left) && node.left.expression.kind === ts.SyntaxKind.ThisKeyword) names.add(node.left.name.text);
        });
      }
    }
    return names;
  }
  function describeClass(klass, depth = 0) {
    if (classCache.has(klass)) return classCache.get(klass);
    if (!klass || depth > 8 || (!ts.isClassDeclaration(klass) && !ts.isClassExpression(klass))) return null;
    const base = klass.heritageClauses?.find(c => c.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
    const parent = base && !builtin(base) ? describeClass(declaration(base), depth + 1) : null;
    if (!base || (!builtin(base) && !parent)) return null;
    const names = memberNames(klass);
    const typed = names.has('code') && names.has('statusCode') || parent?.typed === true;
    const name = klass.name?.text ?? '<anonymous-error-class>';
    const ctor = klass.members.find(ts.isConstructorDeclaration);
    let messageExpression = null, superArguments = [];
    if (ctor?.body) visit(ctor.body, node => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
        messageExpression = node.arguments[0] ?? null; superArguments = [...node.arguments];
      }
    });
    const resultBoundary = resultBoundaries.get(klass) ?? null;
    const result = { klass, name, ctor, messageExpression, superArguments, parent, typed, resultBoundary,
      internal: !typed ? resultBoundary ? 'private-result-boundary'
        : INTERNAL_CONTRACTS.get(internalKey(nodeFile(klass), name)) ?? null : null };
    classCache.set(klass, result); return result;
  }
  function callEnvironment(parameters, args, prior = new Map()) {
    const environment = new Map();
    for (let i = 0; i < parameters.length; i++) {
      const p = parameters[i]; if (ts.isIdentifier(p.name)) environment.set(symbol(p.name), substitute(args[i] ?? p.initializer, prior));
    }
    return environment;
  }
  function resolveMessage(node, environment, depth = 0) {
    node = substitute(node, environment); if (!node || depth > 12) return null;
    if (literal(node) !== null) return literal(node);
    if (ts.isPropertyAccessExpression(node)) {
      const subject = substitute(node.expression, environment);
      if (subject && ts.isObjectLiteralExpression(subject)) {
        const prop = subject.properties.find(p => ts.isPropertyAssignment(p) && propertyName(p.name) === node.name.text);
        return prop ? resolveMessage(prop.initializer, environment, depth + 1) : null;
      }
      const decl = declaration(node.expression);
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer && ts.isCallExpression(unwrap(decl.initializer))) {
        const call = unwrap(decl.initializer), factory = describeFactory(call.expression);
        if (factory?.central && node.name.text === 'message') return resolveMessage(call.arguments[factory.messageIndex], environment, depth + 1);
      }
    }
    return null;
  }
  function describeFactory(expression, depth = 0) {
    const decl = declaration(expression); if (!decl || depth > 8) return null;
    if (factoryCache.has(decl)) return factoryCache.get(decl);
    factoryCache.set(decl, null); // recursion cannot silently prove a factory
    let fn = decl;
    if (ts.isVariableDeclaration(fn)) fn = unwrap(fn.initializer);
    if (!fn || !(ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || !fn.body) return null;
    const source = nodeFile(fn);
    // This is the actual central export, not a name whitelist. Its returned
    // code/statusCode pair and source binding are both required.
    let central = false, messageIndex = -1, codeIndex = -1;
    if (ts.isFunctionDeclaration(fn) && fn.name?.text === 'businessError'
      && /(?:^|\/)src\/shared\/errorCodes\.ts$/.test(source)) {
      visit(fn.body, node => {
        if (!ts.isReturnStatement(node) || !node.expression || !ts.isCallExpression(node.expression)) return;
        const call = node.expression, props = unwrap(call.arguments[1]);
        const shape = call.expression.getText() === 'Object.assign' && builtin(call.expression.expression, new Set(['Object']))
          && call.arguments[0] && ts.isNewExpression(call.arguments[0]) && builtin(call.arguments[0].expression)
          && props && ts.isObjectLiteralExpression(props)
          && ['code', 'statusCode'].every(name => props.properties.some(p => propertyName(p.name) === name));
        if (shape) {
          messageIndex = fn.parameters.findIndex(p => symbol(p.name) === symbol(call.arguments[0].arguments?.[0]));
          const codeProp = props.properties.find(p => propertyName(p.name) === 'code');
          const codeSymbol = ts.isShorthandPropertyAssignment(codeProp) ? binding.checker.getShorthandAssignmentValueSymbol(codeProp)
            : ts.isPropertyAssignment(codeProp) ? symbol(codeProp.initializer) : null;
          codeIndex = fn.parameters.findIndex(p => symbol(p.name) === codeSymbol);
          central = messageIndex >= 0 && codeIndex >= 0;
        }
      });
    }
    let bodyExpression = ts.isBlock(fn.body) ? null : fn.body;
    if (ts.isBlock(fn.body) && fn.body.statements.length === 1) {
      const statement = fn.body.statements[0];
      if (ts.isThrowStatement(statement) || ts.isReturnStatement(statement)) bodyExpression = statement.expression;
    }
    if (!central && bodyExpression) {
      const body = unwrap(bodyExpression);
      if (ts.isNewExpression(body)) {
        if (!builtin(body.expression) && !describeClass(declaration(body.expression))) return null;
      } else if (ts.isCallExpression(body)) {
        if (!describeFactory(body.expression, depth + 1)) return null;
      } else return null;
    }
    if (!central && !bodyExpression) return null;
    const result = { fn, central, messageIndex, codeIndex, bodyExpression, parameters: fn.parameters, name: fn.name?.text ?? propertyName(decl.name) ?? expression.getText() };
    factoryCache.set(decl, result); return result;
  }
  function describeExpression(node, environment = new Map(), depth = 0) {
    node = unwrap(node); if (!node || depth > 12) return null;
    if (ts.isNewExpression(node)) {
      if (builtin(node.expression)) return { contract: 'plain', constructor: node.expression.text,
        message: resolveMessage(node.arguments?.[0], environment), messageExpression: node.arguments?.[0]?.getText() ?? '<missing>' };
      const klass = describeClass(declaration(node.expression)); if (!klass) return null;
      const classMessage = (desc, args, prior, hops = 0) => {
        if (hops > 8) return null;
        const env = desc.ctor ? callEnvironment(desc.ctor.parameters, args, prior) : prior;
        if (desc.parent) return classMessage(desc.parent, desc.ctor
          ? desc.superArguments.map(arg => substitute(arg, env)) : args, env, hops + 1);
        return desc.ctor ? resolveMessage(desc.messageExpression, env) : resolveMessage(args[0], prior);
      };
      const message = classMessage(klass, node.arguments ?? [], environment);
      return { contract: klass.internal ? 'internal' : klass.typed ? 'typed' : 'unknown-class-contract', constructor: klass.name,
        message, messageExpression: klass.messageExpression?.getText() ?? node.arguments?.[0]?.getText() ?? '<missing>',
        declaration: `${nodeFile(klass.klass)}:${klass.klass.getSourceFile().getLineAndCharacterOfPosition(klass.klass.getStart()).line + 1}`,
        internalReason: klass.internal, resultBoundary: klass.resultBoundary,
        publicResultMessage: klass.resultBoundary !== null, messageParameter: klass.ctor?.parameters.findIndex(p =>
          klass.messageExpression && symbol(p.name) === symbol(unwrap(klass.messageExpression))) ?? 0 };
    }
    if (ts.isCallExpression(node)) {
      const factory = describeFactory(node.expression); if (!factory) return null;
      const env = callEnvironment(factory.parameters, node.arguments, environment);
      if (factory.central) return { contract: 'typed', constructor: 'businessError', message: resolveMessage(node.arguments[factory.messageIndex], environment),
        messageExpression: node.arguments[factory.messageIndex]?.getText() ?? '<missing>', code: resolveMessage(node.arguments[factory.codeIndex], environment),
        declaration: `${nodeFile(factory.fn)}:${factory.fn.getSourceFile().getLineAndCharacterOfPosition(factory.fn.getStart()).line + 1}` };
      const result = describeExpression(factory.bodyExpression, env, depth + 1);
      return result ? { ...result, factory: factory.name } : null;
    }
    return null;
  }
  const inventory = [], classes = [];
  for (const source of binding.program.getSourceFiles()) {
    const file = normalized(source.fileName).replace(/^\/source\//, '');
    const privateSites = new Map(classifyPrivateSymbolRefusals(source.text, file).map(site => [site.index, site]));
    const recorded = new Set();
    const add = (node, result, origin) => {
      const start = node.getStart(source); if (recorded.has(start)) return;
      recorded.add(start);
      const literalMessage = typeof result?.message === 'string' && result.message.trim() !== '';
      const kind = result?.contract === 'internal' ? 'internal'
        : !literalMessage || result?.contract === 'unknown-class-contract' ? 'unresolved'
        : result.contract === 'typed' ? 'typed-contract' : 'public-message';
      inventory.push({ file, line: source.getLineAndCharacterOfPosition(start).line + 1, start, origin, kind,
        ...result, reason: kind === 'unresolved' ? !result ? 'unresolved-error-binding-or-propagation'
          : result.contract === 'unknown-class-contract' ? 'unadjudicated-class-contract' : 'dynamic-or-missing-message' : undefined,
        expression: node.getText(source).slice(0, 500) });
    };
    visit(source, node => {
      if (ts.isClassDeclaration(node)) {
        const desc = describeClass(node);
        if (desc) classes.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          name: desc.name, contract: desc.internal ? 'internal' : desc.typed ? 'typed' : 'unadjudicated',
          internalReason: desc.internal, resultBoundary: desc.resultBoundary,
          messageExpression: desc.messageExpression?.getText() ?? '<inherited-message>' });
      }
      if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
        // One private refusal has one producer entry, not both its Object.assign
        // wrapper and the enclosed allocation. Its finite consumer is retained.
        if (privateSites.has(node.getStart(source)) || node.parent && privateSites.has(node.parent.getStart(source))) return;
        const result = describeExpression(node); if (result) add(node, result, ts.isNewExpression(node) ? 'construction' : 'factory-call');
      }
      // Unknown/dynamic throw forms remain in the denominator as propagation or
      // unresolved producers; comments and string examples are never AST nodes.
      if (ts.isThrowStatement(node)) {
        const expression = unwrap(node.expression), result = describeExpression(expression);
        const refusal = privateSites.get(expression.getStart(source));
        if (refusal) add(expression, { contract: 'internal', constructor: 'Error', internalReason: 'private-finite-refusal',
          finiteKeys: refusal.keys, consumerLine: refusal.consumerLine }, 'private-refusal');
        else if (!result) add(expression, null, 'unresolved-throw');
      }
    });
  }
  inventory.sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start);
  const corpus = new Map();
  for (const row of inventory) if (typeof row.message === 'string' && row.message.trim()
    && (row.contract !== 'internal' || row.publicResultMessage) && row.contract !== 'unknown-class-contract') corpus.set(`${row.file}|${row.message.trim()}`, row);
  const accounting = inventory.reduce((out, row) => { out[row.kind] = (out[row.kind] ?? 0) + 1; return out; },
    { total: inventory.length, 'public-message': 0, 'typed-contract': 0, internal: 0, unresolved: 0 });
  return { measurement: TIER_MESSAGE_MEASUREMENT, inventory, accounting, classes,
    publicLiterals: [...corpus.values()], typedContracts: inventory.filter(row => row.contract === 'typed'),
    internal: inventory.filter(row => row.kind === 'internal'), unresolved: inventory.filter(row => row.kind === 'unresolved') };
}

/** A B34 exception is admissible only with an actual private Symbol producer,
 * finite immutable copies, and a catch consumer proving membership before
 * returning a failed/uncommitted result. This is not a name/path allowlist.
 * Every failure to prove the complete shape stays in the original B34 debt.
 */
export function classifyPrivateSymbolRefusals(src, file = 'src/probe.ts') {
  if (!src.includes('Symbol(') || !src.includes('hasOwnProperty')) return [];
  const { program, symbol, declaration, builtin } = makeProgram([{ file, src }]);
  const source = program.getSourceFiles()[0], results = [];
  const same = (a, b) => symbol(a) && symbol(a) === symbol(b);
  const constDeclaration = node => {
    const decl = declaration(node);
    return decl && ts.isVariableDeclaration(decl) && (decl.parent.flags & ts.NodeFlags.Const) ? decl : null;
  };
  const privateConst = decl => decl && ts.isVariableStatement(decl.parent.parent)
    && !decl.parent.parent.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
  function immutable(decl) {
    let valid = true;
    visit(source, node => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        let target = unwrap(node.left); while (target && (ts.isElementAccessExpression(target) || ts.isPropertyAccessExpression(target))) target = target.expression;
        if (target && same(target, decl.name)) valid = false;
      }
      if ((ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node))
        && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) {
        let target = unwrap(node.operand); while (target && (ts.isElementAccessExpression(target) || ts.isPropertyAccessExpression(target))) target = target.expression;
        if (target && same(target, decl.name)) valid = false;
      }
      // Passing the map into arbitrary code could mutate it. The one proven
      // Object.prototype.hasOwnProperty.call reader is the only argument use.
      if (ts.isCallExpression(node) && node.arguments.some(arg => same(unwrap(arg), decl.name))
        && node.expression.getText() !== 'Object.prototype.hasOwnProperty.call') valid = false;
    });
    return valid;
  }
  visit(source, node => {
    if (!ts.isThrowStatement(node) || !ts.isCallExpression(node.expression)) return;
    const assign = node.expression;
    if (assign.expression.getText() !== 'Object.assign' || !builtin(assign.expression.expression, new Set(['Object'])) || assign.arguments.length !== 2) return;
    const error = unwrap(assign.arguments[0]), properties = unwrap(assign.arguments[1]);
    if (!error || !ts.isNewExpression(error) || !builtin(error.expression) || !properties || !ts.isObjectLiteralExpression(properties)
      || properties.properties.length !== 1) return;
    const prop = properties.properties[0], message = unwrap(error.arguments?.[0]);
    if (!ts.isPropertyAssignment(prop) || !ts.isComputedPropertyName(prop.name) || !ts.isIdentifier(prop.initializer)
      || !message || !ts.isElementAccessExpression(message) || !same(message.argumentExpression, prop.initializer)) return;
    const marker = constDeclaration(prop.name.expression), copy = constDeclaration(message.expression);
    const markerInit = unwrap(marker?.initializer), copyInit = unwrap(copy?.initializer);
    if (!privateConst(marker) || !privateConst(copy) || !markerInit || !ts.isCallExpression(markerInit)
      || !builtin(markerInit.expression, new Set(['Symbol'])) || !copyInit || !ts.isObjectLiteralExpression(copyInit)
      || !immutable(marker) || !immutable(copy)) return;
    const keys = [], messages = {};
    for (const p of copyInit.properties) {
      if (!ts.isPropertyAssignment(p) || !propertyName(p.name) || !ts.isStringLiteralLike(p.initializer)) return;
      const key = propertyName(p.name); if (keys.includes(key)) return;
      keys.push(key); messages[key] = p.initializer.text;
    }
    if (!keys.length) return;
    let producer = node.parent;
    while (producer && !ts.isFunctionDeclaration(producer)) producer = producer.parent;
    if (!producer || producer.parameters.length !== 1 || !same(producer.parameters[0].name, prop.initializer)) return;
    const type = producer.parameters[0].type;
    if (!type || !ts.isTypeOperatorNode(type) || type.operator !== ts.SyntaxKind.KeyOfKeyword
      || !ts.isTypeQueryNode(type.type) || !same(type.type.exprName, copy.name)) return;
    let consumer = null;
    visit(source, candidate => {
      if (!ts.isIfStatement(candidate) || !ts.isBinaryExpression(candidate.expression)
        || candidate.expression.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) return;
      const refusal = candidate.expression.left, membership = candidate.expression.right;
      if (!ts.isIdentifier(refusal) || !ts.isCallExpression(membership)
        || membership.expression.getText() !== 'Object.prototype.hasOwnProperty.call'
        || !builtin(membership.expression.expression.expression.expression, new Set(['Object']))
        || membership.arguments.length !== 2 || !same(membership.arguments[0], copy.name) || !same(membership.arguments[1], refusal)) return;
      const refusalDecl = declaration(refusal), read = unwrap(refusalDecl?.initializer);
      if (!refusalDecl || !ts.isVariableDeclaration(refusalDecl) || !read || !ts.isElementAccessExpression(read)
        || !same(read.argumentExpression, marker.name)) return;
      let caught = candidate.parent; while (caught && !ts.isCatchClause(caught)) caught = caught.parent;
      if (!caught?.variableDeclaration || !same(read.expression, caught.variableDeclaration.name) || !ts.isBlock(candidate.thenStatement)) return;
      const publicCopyDecl = candidate.thenStatement.statements.flatMap(statement => ts.isVariableStatement(statement)
        ? [...statement.declarationList.declarations] : []).find(d => ts.isTemplateExpression(unwrap(d.initializer))
          && unwrap(d.initializer).templateSpans.length === 2
          && same(unwrap(d.initializer).templateSpans[0].expression, refusal)
          && ts.isElementAccessExpression(unwrap(d.initializer).templateSpans[1].expression)
          && same(unwrap(d.initializer).templateSpans[1].expression.expression, copy.name)
          && same(unwrap(d.initializer).templateSpans[1].expression.argumentExpression, refusal));
      const returned = candidate.thenStatement.statements.find(ts.isReturnStatement), result = unwrap(returned?.expression);
      if (!publicCopyDecl || !result || !ts.isObjectLiteralExpression(result)) return;
      const field = name => result.properties.find(p => ts.isPropertyAssignment(p) && propertyName(p.name) === name)?.initializer;
      if (field('ok')?.kind !== ts.SyntaxKind.FalseKeyword || field('committed')?.kind !== ts.SyntaxKind.FalseKeyword
        || !same(field('error'), publicCopyDecl.name)) return;
      let rawMessage = false;
      visit(candidate.thenStatement, part => {
        if (ts.isPropertyAccessExpression(part) && part.name.text === 'message'
          && same(part.expression, caught.variableDeclaration.name)) rawMessage = true;
      });
      if (!rawMessage) consumer = { statement: candidate, refusalDecl };
    });
    if (!consumer) return;
    results.push({ index: assign.getStart(source), producerLine: source.getLineAndCharacterOfPosition(assign.getStart()).line + 1,
      consumerLine: source.getLineAndCharacterOfPosition(consumer.statement.getStart()).line + 1,
      symbol: marker.name.text, map: copy.name.text, producer: producer.name?.text, keys, messages,
      setupSource: `${marker.parent.parent.getText(source)}\n${copy.parent.parent.getText(source)}\n${producer.getText(source)}`,
      consumerSource: `${consumer.refusalDecl.parent.parent.getText(source)}\n${consumer.statement.getText(source)}` });
  });
  return results;
}
