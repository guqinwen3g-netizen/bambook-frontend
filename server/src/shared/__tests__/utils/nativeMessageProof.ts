/** Test-side source proof. These finite results are NOT a general raw-message
 * exemption. All native producers, consumers and pure error dependencies are
 * pinned; a changed source needs fresh adjudication. No application imports. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'typescript';

export interface NativeMessageReceipt {
  sourceHead: string;
  sourceHashes: Record<string, string>;
  commandCodes: string[];
  accessCodes: string[];
  provenSites: Record<string, number>;
  consumerFiles: string[];
}
export const nativeReceiptPath = 'artifacts/acceptance-20261001/execution/source-readings/v1-066bdcbc-native-message-proof.json';
export const sourceHash = (source: string) => crypto.createHash('sha256').update(source).digest('hex');
// Reviewed source pins only. The original immutable receipt retains the exact
// seven finite sites, closed code sets and consumer graph; none is broadened.
export const nativeSourceReview = {
  "sourceHead": "378a21ca408f233e396ec15cd3f5b6b388f32d36",
  "originalProofHead": "066bdcbc6d92378b6df814251cbf2a5082b32169",
  "reviewedAt": "2026-10-03",
  "reviewedProductionSource": "378a21ca408f233e396ec15cd3f5b6b388f32d36",
  "sourceReviewFreezeSHA256": "287e46b70eedbda8a674c133a124a51649174711968aa2795e2f0afec1faf0d3",
  "unchangedExecutableProofAtoms": 10,
  "finiteSites": 7,
  "countercontrolLayers": "378a source/AST/whole error VM successor; prior counts are historical, see successor report",
  "sourceHashes": {
    "server/src/finance/proformaInvoiceService.ts": "13b9eec720dc96a6e7db25d67d93c26b4d708270f19538fe22c808137e2ef6e5",
    "server/src/finance/proformaInvoiceAccess.ts": "2470d0570a1f335ed5f7edd50df7145e6e2119ef923d40f65c1b8c8a77c3a5ab",
    "server/src/finance/routeV2.ts": "a130bf242c23887848b6543af414376e3f4ff5f7ec6017d1d50e8f76f4dc4a0a",
    "server/src/shared/errorCodes.ts": "cb1a4a630ad354739a93b3ef2c7aefa0751998b0fef452c64a6257650e48e358",
    "server/src/qc/qcService.ts": "d1741d50582e59872b00ac3080957bb26eb5a379126b5e1cfadc1e9230ac0bab",
    "server/src/pricing/commissionPayableService.ts": "ee5878aa3302d1f564055fffac62c3981184c89802b56ce44371d7b382bd13ba",
    "server/src/development/fabricDevelopmentService.ts": "65efd830a59a2bdbdb1f232b68fd8003a5b6d6c7c331d1e9d8a31d90e359acdf",
    "server/src/qc/qcRoute.ts": "df02c0b5f8134db1dfaa3a373b418b6c4cac45751146a3fec5ea500848747b86",
    "server/src/customs/customsRoute.ts": "562d807719c8ee17ad2ec5057c7a4905ee159a66bcae1f7e59eaf64c1083d34b",
    "server/src/shipping/route.ts": "1e84d23a0d1a0244ba6ec4db357f503c45582813b7487fae819f03029be0cc58"
  },
  "currentSourceReviewReceiptPath": "artifacts/acceptance-20261001/execution/source-readings/v1-378a21ca-carton-native-source-review.json",
  "executedCallbacks": 64,
  "reviewedExecutableProofAtoms": 11,
  "changedExecutableProofAtoms": [
    "businessError"
  ],
  "historicalCountercontrolTitlesSHA256": "97a12e9d9f511440f6ded9171a991c7611dfdbc21a0f18f695de83a41b0dffb2"
} as const;
export function readNativeProof(root: string) {
  const original: NativeMessageReceipt = JSON.parse(fs.readFileSync(path.join(root, nativeReceiptPath), 'utf8'));
  const receipt: NativeMessageReceipt = { ...original, sourceHead: nativeSourceReview.sourceHead,
    sourceHashes: { ...original.sourceHashes, ...nativeSourceReview.sourceHashes } };
  const sources = Object.fromEntries(Object.keys(receipt.sourceHashes).map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
  // Detect new literal imports/re-exports/dynamic imports or require consumers,
  // including aliased/namespace imports. Computed module paths are not proven.
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__') continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) { visit(absolute); continue; }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      const source = fs.readFileSync(absolute, 'utf8');
      if (source.includes('proformaInvoiceHttpError')) sources[path.relative(root, absolute).split(path.sep).join('/')] = source;
    }
  };
  visit(path.join(root, 'server/src'));
  assertNativeProof(sources, receipt);
  return { receipt, sources };
}
function nodes(source: ts.Node, predicate: (node: ts.Node) => boolean) {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node) => { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); };
  visit(source); return found;
}
const parse = (file: string, source: string) => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
const name = (node: ts.Node | undefined) => node?.getText() ?? '';
function ensure(value: unknown, reason: string): asserts value { if (!value) throw Error(`Native message proof invalid: ${reason}`); }
function definition(ast: ts.SourceFile, id: string) {
  return nodes(ast, node => ts.isFunctionDeclaration(node) && node.name?.text === id)[0] as ts.FunctionDeclaration | undefined;
}
function union(ast: ts.SourceFile, id: string) {
  const declaration = nodes(ast, node => ts.isTypeAliasDeclaration(node) && node.name.text === id)[0] as ts.TypeAliasDeclaration;
  ensure(declaration && ts.isUnionTypeNode(declaration.type), `${id} must remain a finite union`);
  return declaration.type.types.map(type => {
    ensure(ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal), `${id} has a non-literal member`);
    return type.literal.text;
  }).sort();
}
function uniqueBinding(ast: ts.SourceFile, id: string) {
  const bindings = nodes(ast, node => (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isClassDeclaration(node)
    || ts.isFunctionDeclaration(node) || ts.isImportSpecifier(node)) && name(node.name) === id);
  ensure(bindings.length === 1, `${id} was removed or shadowed`);
}
function imported(ast: ts.SourceFile, id: string, source: string) {
  uniqueBinding(ast, id);
  ensure(nodes(ast, node => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
    && node.moduleSpecifier.text === source && !!node.importClause?.namedBindings
    && ts.isNamedImports(node.importClause.namedBindings) && node.importClause.namedBindings.elements.some(e => e.name.text === id)).length === 1,
  `${id} must bind to its actual native module`);
}
export function assertNativeProof(sources: Record<string, string>, receipt: NativeMessageReceipt) {
  for (const [file, hash] of Object.entries(receipt.sourceHashes)) ensure(sourceHash(sources[file] ?? '') === hash, `${file} changed since ${receipt.sourceHead}`);
  const consumers = Object.entries(sources).filter(([file, source]) => {
    const ast = parse(file, source);
    return nodes(ast, node => {
      const module = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
        : ts.isCallExpression(node) && (name(node.expression) === 'require' || node.expression.kind === ts.SyntaxKind.ImportKeyword) ? node.arguments[0] : undefined;
      return !!module && ts.isStringLiteral(module) && path.posix.normalize(path.posix.join(path.posix.dirname(file), module.text)).replace(/\.(?:ts|js)$/, '') === 'server/src/finance/proformaInvoiceHttpError';
    }).length > 0;
  }).map(([file]) => file).sort();
  ensure(JSON.stringify(consumers) === JSON.stringify([...receipt.consumerFiles].sort()), 'native HTTP consumer file set changed');
  const service = parse('service.ts', sources['server/src/finance/proformaInvoiceService.ts']);
  const access = parse('access.ts', sources['server/src/finance/proformaInvoiceAccess.ts']);
  const route = parse('route.ts', sources['server/src/finance/routeV2.ts']);
  const http = parse('http.ts', sources['server/src/finance/proformaInvoiceHttpError.ts']);
  const internal = parse('internal.ts', sources['server/src/internalTrade/internalTransferService.ts']);
  ensure(JSON.stringify(union(service, 'ProformaCommandCode')) === JSON.stringify([...receipt.commandCodes].sort()), 'command code set changed');
  ensure(JSON.stringify(union(access, 'ProformaAccessCode')) === JSON.stringify([...receipt.accessCodes].sort()), 'access code set changed');
  imported(service, 'ProformaAccessError', './proformaInvoiceAccess'); uniqueBinding(service, 'ProformaCommandError');
  for (const [ast, id] of [[service, 'ProformaCommandError'], [access, 'ProformaAccessError']] as const) {
    const actual = nodes(ast, node => ts.isClassDeclaration(node) && node.name?.text === id)[0] as ts.ClassDeclaration;
    ensure(actual?.heritageClauses?.some(c => c.types.some(t => name(t.expression) === 'Error')), `${id} native class is missing`);
    const constructor = actual.members.find(ts.isConstructorDeclaration);
    ensure(constructor?.parameters.some(p => name(p.name) === 'code' && name(p.type) === (id === 'ProformaCommandError' ? 'ProformaCommandCode' : 'ProformaAccessCode')), `${id} code is not closed`);
  }
  const failure = definition(service, 'failure'); ensure(failure?.body, 'native failure consumer missing');
  for (const id of ['ProformaAccessError', 'ProformaCommandError']) {
    ensure(nodes(failure.body, n => ts.isIfStatement(n) && ts.isBinaryExpression(n.expression)
      && n.expression.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && name(n.expression.left) === 'error'
      && name(n.expression.right) === id).length === 1, `${id} instance guard missing`);
  }
  ensure(nodes(failure.body, n => ts.isCallExpression(n) && name(n.expression) === 'safeRouteError'
    && name(n.arguments[0]) === 'undefined').length === 1, 'unknown native error must be discarded');
  imported(route, 'proformaInvoiceHttpError', './proformaInvoiceHttpError'); imported(route, 'getProformaInvoiceService', './proformaInvoiceService');
  imported(http, 'lookupErrorCode', '../shared/errorCodes');
  const calls = nodes(route, n => ts.isCallExpression(n) && name(n.expression) === 'proformaInvoiceHttpError') as ts.CallExpression[];
  ensure(calls.length === 2, 'native HTTP result callers changed');
  for (const call of calls) {
    ensure(name(call.arguments[0]) === 'result.error', 'HTTP helper accepts a non-native result');
    let scope: ts.Node = call; while (scope.parent && !ts.isArrowFunction(scope) && !ts.isFunctionDeclaration(scope)) scope = scope.parent;
    const declarations = nodes(scope, ts.isVariableDeclaration) as ts.VariableDeclaration[];
    const result = declarations.find(d => name(d.name) === 'result'), factory = declarations.find(d => name(d.name) === 'piSvc');
    ensure(factory?.initializer && ts.isCallExpression(factory.initializer) && name(factory.initializer.expression) === 'getProformaInvoiceService', 'native service factory replaced');
    ensure(result?.initializer && ts.isAwaitExpression(result.initializer) && ts.isCallExpression(result.initializer.expression)
      && ['piSvc.generateFromQuotation', 'piSvc.convertToReceivable'].includes(name(result.initializer.expression.expression)), 'HTTP source result changed');
  }
  imported(internal, 'businessError', '../shared/errorCodes');
}

/** Offsets use the SAME stripped source as the original bare B22 regex. */
export function finiteMessageOffsets(file: string, stripped: string, sources: Record<string, string>, receipt: NativeMessageReceipt) {
  if (!(file in receipt.provenSites)) return new Set<number>();
  assertNativeProof(sources, receipt);
  const ast = parse(file, stripped), offsets = new Set<number>();
  for (const node of nodes(ast, ts.isPropertyAssignment) as ts.PropertyAssignment[]) {
    if (name(node.name) !== 'message' || !ts.isPropertyAccessExpression(node.initializer)) continue;
    const value = node.initializer;
    if (value.name.text !== 'message' || !ts.isIdentifier(value.expression)) continue;
    let proof = false;
    for (let parent: ts.Node | undefined = node; parent; parent = parent.parent) {
      if (file === 'server/src/finance/proformaInvoiceService.ts' && value.expression.text === 'error' && ts.isIfStatement(parent)
        && ts.isBinaryExpression(parent.expression) && parent.expression.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
        && name(parent.expression.left) === 'error' && ['ProformaAccessError', 'ProformaCommandError'].includes(name(parent.expression.right))) proof = true;
      if (file === 'server/src/finance/proformaInvoiceHttpError.ts' && value.expression.text === 'error' && ts.isFunctionDeclaration(parent)
        && parent.name?.text === 'proformaInvoiceHttpError') proof = true; // ONLY pinned native callers above; not arbitrary raw errors.
      if (file === 'server/src/finance/proformaInvoiceHttpError.ts' && value.expression.text === 'registered'
        && ts.isIfStatement(parent) && name(parent.expression) === 'registered') {
        const binding = nodes(ast, n => ts.isVariableDeclaration(n) && name(n.name) === 'registered')[0] as ts.VariableDeclaration;
        ensure(binding?.initializer && ts.isCallExpression(binding.initializer)
          && name(binding.initializer.expression) === 'lookupErrorCode' && name(binding.initializer.arguments[0]) === 'code', 'registered message is not a registry result');
        proof = true;
      }
    }
    if (file === 'server/src/internalTrade/internalTransferService.ts' && value.expression.text === 'conflict') {
      const binding = nodes(ast, n => ts.isVariableDeclaration(n) && name(n.name) === 'conflict')[0] as ts.VariableDeclaration;
      ensure(binding && ts.isCallExpression(binding.initializer!) && name(binding.initializer!.expression) === 'businessError'
        && name(binding.initializer!.arguments[0]) === "'SOURCE_CHANGED'" && ts.isStringLiteral(binding.initializer!.arguments[1]), 'registered literal conflict result changed');
      proof = true;
    }
    if (proof) offsets.add(node.getStart(ast));
  }
  ensure(offsets.size === receipt.provenSites[file], `${file} finite message sites changed`);
  return offsets;
}

/** Extract actual source snippets for isolated source-contract controls. The
 * caller supplies only pure errors/logger dependencies, never DB or services. */
export function functionSource(source: string, id: string) {
  const ast = parse('snippet.ts', source), fn = definition(ast, id); ensure(fn, `${id} absent`); return fn.getText(ast).replace(/^export /, '');
}
export function classSource(source: string, id: string) {
  const ast = parse('snippet.ts', source), declaration = nodes(ast, n => ts.isClassDeclaration(n) && n.name?.text === id)[0];
  ensure(declaration, `${id} absent`); return declaration.getText(ast).replace(/^export /, '');
}
export function variableSource(source: string, id: string) {
  const ast = parse('snippet.ts', source), declaration = nodes(ast, n => ts.isVariableDeclaration(n) && name(n.name) === id)[0];
  ensure(declaration, `${id} absent`); return `const ${declaration.getText(ast)};`;
}
