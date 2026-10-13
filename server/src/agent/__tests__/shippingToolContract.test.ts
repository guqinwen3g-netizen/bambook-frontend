import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

import ts from 'typescript';

const read = (relative: string) => fs.readFileSync(path.resolve(__dirname, relative), 'utf-8');
const TR = read('../toolRuntime.ts');
const SERVICE = read('../../shipping/shipmentMutationService.ts');
const CONSUMER = read('../../shipping/shipmentPhysicalConsumerService.ts');
const RELEASE = read('../../production/releaseService.ts');
const AUTHORITY = read('../../shipping/shipmentPhysicalAllocationService.ts');
const ORDER_LINK = read('../../shipping/orderLinkService.ts');
const STATUS = read('../../statusTransition.ts');

type Sources = { runtime: string; service: string; consumer: string; release: string; authority: string };
const sources: Sources = { runtime: TR, service: SERVICE, consumer: CONSUMER, release: RELEASE, authority: AUTHORITY };
const parse = (name: string, source: string) => ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
function nodes<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node) => { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); };
  visit(root); return found;
}
function declaration(source: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  return source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
}
function imported(source: ts.SourceFile, local: string, original: string, module: string): boolean {
  return source.statements.some(node => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
    && node.moduleSpecifier.text === module && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
    && node.importClause.namedBindings.elements.some(item => item.name.text === local && (item.propertyName?.text ?? item.name.text) === original));
}
function calls(root: ts.Node, source: ts.SourceFile, expression: string): ts.CallExpression[] {
  return nodes(root, ts.isCallExpression).filter(call => call.expression.getText(source) === expression);
}
const awaited = (call: ts.CallExpression) => ts.isAwaitExpression(call.parent);
function objectProperty(node: ts.Node | undefined, source: ts.SourceFile, name: string): string | null {
  if (!node || !ts.isObjectLiteralExpression(node)) return null;
  const entry = node.properties.find(item => (ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item)) && item.name.getText(source) === name);
  if (!entry) return null;
  return ts.isPropertyAssignment(entry) ? entry.initializer.getText(source) : name;
}
function nativeLock(fn: ts.FunctionDeclaration, source: ts.SourceFile, table: string): ts.CallExpression[] {
  return calls(fn.body!, source, 'tx.$queryRaw').filter(call => awaited(call)
    && call.arguments.some(arg => ts.isTaggedTemplateExpression(arg) && arg.tag.getText(source) === 'Prisma.sql'
      && arg.template.getText(source).includes(`FROM "${table}"`) && arg.template.getText(source).includes('FOR UPDATE')));
}
function graph(kind: 'create' | 'update', src: Sources = sources) {
  const runtime = parse('runtime.ts', src.runtime), service = parse('service.ts', src.service);
  const handler = declaration(runtime, kind === 'create' ? 'handleShippingCreateShipment' : 'handleShippingUpdateTrackingStatus');
  const producer = declaration(service, kind === 'create' ? 'createShipment' : 'updateShipment');
  const alias = kind === 'create' ? 'createSharedShipment' : 'updateSharedShipment';
  const delegated = handler?.body ? calls(handler.body, runtime, alias) : [];
  const delegate = delegated[0];
  const delegation = delegated.length === 1 && !!delegate && awaited(delegate)
    && objectProperty(delegate.arguments[0], runtime, 'prisma') === 'prisma'
    && imported(runtime, alias, kind === 'create' ? 'createShipment' : 'updateShipment', '../shipping/shipmentMutationService');
  const withTransactions = producer?.body ? calls(producer.body, service, 'withTx') : [];
  const entry = withTransactions[0], callback = entry?.arguments[2];
  const txBody = callback && ts.isArrowFunction(callback) && callback.parameters[0]?.name.getText(service) === 't'
    && entry?.arguments[0]?.getText(service) === 'prisma' && entry?.arguments[1]?.getText(service) === 'tx' && awaited(entry)
    ? callback.body : null;
  const txHelper = declaration(service, 'withTx');
  const actualTransaction = txHelper?.body && nodes(txHelper.body, ts.isCallExpression).some(call => ts.isPropertyAccessExpression(call.expression)
    && call.expression.name.text === '$transaction' && call.arguments[0]?.getText(service) === 'fn' && awaited(call));
  const reusedTransaction = !!txHelper?.body && calls(txHelper.body, service, 'fn').some(call => awaited(call) && call.arguments[0]?.getText(service) === 'tx');
  const actualProducer = !!txBody && calls(txBody, service, kind === 'create' ? 't.shipment.create' : 't.shipment.update').filter(awaited).length === 1;
  const transaction = !!(actualProducer && delegation && withTransactions.length === 1 && txBody && actualTransaction && reusedTransaction);
  const inTx = (expression: string) => txBody ? calls(txBody, service, expression).filter(awaited) : [];
  const sync = transaction && imported(service, 'syncShipmentReferences', 'syncShipmentReferences', '../entities/sync')
    && inTx('syncShipmentReferences').length === 1 && inTx('syncShipmentReferences')[0].arguments[3]?.getText(service) === 't';
  const linkCalls = inTx('linkOrderStatusFromShipment');
  const link = transaction && imported(service, 'linkOrderStatusFromShipment', 'linkOrderStatusFromShipment', './orderLinkService')
    && linkCalls.length === 1 && linkCalls[0].arguments[0]?.getText(service) === 't'
    && (kind === 'create' ? linkCalls[0].arguments[1]?.getText(service) === 'sh.orderId'
      : !!txBody && nodes(txBody, ts.isVariableDeclaration).some(node => node.name.getText(service) === 'rollbackOrderIds'
        && !!node.initializer && nodes(node.initializer, ts.isPropertyAccessExpression).some(access => access.getText(service) === 'upd.orderId')));
  const auditCalls = inTx('writeRouteAuditLog');
  const auditCall = auditCalls[0];
  const auditOperation = kind === 'create' ? "auditOperation" : "'update_shipment'";
  const audit = transaction && imported(service, 'writeRouteAuditLog', 'writeRouteAuditLog', '../audit/routeAudit')
    && auditCalls.length === 1 && objectProperty(auditCall?.arguments[0], service, 'prisma') === 't'
    && objectProperty(auditCall?.arguments[0], service, 'operation') === auditOperation
    && !!objectProperty(auditCall?.arguments[0], service, 'after')
    && (kind === 'create' ? !!producer?.body && nodes(producer.body, ts.isBindingElement).some(node => node.name.getText(service) === 'auditOperation'
      && node.initializer && ts.isStringLiteral(node.initializer) && node.initializer.text === 'create_shipment')
      : !!objectProperty(auditCall?.arguments[0], service, 'before'));
  const statusCalls = txBody ? calls(txBody, service, 'validateStatusTransition') : [];
  const transition = transaction && imported(service, 'validateStatusTransition', 'validateStatusTransition', '../statusTransition')
    && statusCalls.length === 1 && statusCalls[0].arguments[0]?.getText(service) === "'Shipment'";
  const guards = producer?.body ? nodes(producer.body, ts.isIfStatement).filter(node => calls(node.expression, service, 'isValidShipmentStatus').length === 1
    && calls(node.thenStatement, service, 'withTx').length === 0 && nodes(node.thenStatement, ts.isReturnStatement).length === 1) : [];
  const invalidBeforeTx = transaction && guards.length === 1 && !!entry && guards[0].getStart(service) < entry.getStart(service);
  return { runtime, service, handler, producer, delegation, transaction, txBody, inTx, sync, link, audit, transition, invalidBeforeTx };
}
function sourceLocks(kind: 'create' | 'update', src: Sources = sources): boolean {
  const g = graph(kind, src), release = parse('release.ts', src.release), consumer = parse('consumer.ts', src.consumer);
  const parent = declaration(release, 'lockReleaseSources');
  if (!g.transaction || !parent?.body || !nativeLock(parent, release, 'Order').length
    || !nativeLock(parent, release, 'OrderLine').length || !nativeLock(parent, release, 'ReleaseScope').length) return false;
  const hintReads = calls(parent.body, release, 'releaseSourceHints').filter(call => awaited(call) && call.arguments[0]?.getText(release) === 'tx');
  const orderLock = nativeLock(parent, release, 'Order')[0];
  if (hintReads.length !== 2 || !(hintReads[0].getStart() < orderLock.getStart() && orderLock.getStart() < hintReads[1].getStart())) return false;
  if (kind === 'create') return imported(g.service, 'lockReleaseSources', 'lockReleaseSources', '../production/releaseService')
    && g.inTx('lockReleaseSources').length === 1 && g.inTx('lockReleaseSources')[0].arguments[0]?.getText(g.service) === 't'
    && g.inTx('lockReleaseSources')[0].getStart() < g.inTx('t.shipment.create')[0]?.getStart();
  const lockCall = g.inTx('lockShipmentPhysicalConsumer')[0];
  if (g.inTx('lockShipmentPhysicalConsumer').length !== 1 || lockCall.arguments[0]?.getText(g.service) !== 't'
    || !imported(g.service, 'lockShipmentPhysicalConsumer', 'lockShipmentPhysicalConsumer', './shipmentPhysicalConsumerService')) return false;
  const lock = declaration(consumer, 'lockShipmentPhysicalConsumer'), hints = declaration(consumer, 'sourceHints');
  if (!lock?.body || !hints?.body || calls(hints.body, consumer, 'tx.shipment.findUnique').filter(awaited).length !== 1) return false;
  const reads = calls(lock.body, consumer, 'sourceHints').filter(call => awaited(call) && call.arguments[0]?.getText(consumer) === 'tx');
  const shipmentLocks = nativeLock(lock, consumer, 'Shipment');
  const parents = calls(lock.body, consumer, 'lockReleaseSources').filter(call => awaited(call) && call.arguments[0]?.getText(consumer) === 'tx');
  return reads.length === 2 && shipmentLocks.length === 1 && parents.length === 1
    && parents[0].getStart() < shipmentLocks[0].getStart()
    && reads[0].getStart() < shipmentLocks[0].getStart() && shipmentLocks[0].getStart() < reads[1].getStart()
    && lockCall.getStart() < g.inTx('t.shipment.update')[0]?.getStart();
}
function currentActorWiring(kind: 'create' | 'update', src: Sources = sources): boolean {
  const g = graph(kind, src), auth = parse('authority.ts', src.authority), consumer = parse('consumer.ts', src.consumer);
  const actor = declaration(auth, 'currentActor');
  const exportedAuthority = nodes(auth, ts.isVariableDeclaration).some(node => node.name.getText(auth) === 'assertPhysicalShipmentWriteAuthority'
    && node.initializer?.getText(auth) === 'currentActor');
  const helperImported = kind === 'create'
    ? imported(g.service, 'assertPhysicalShipmentWriteAuthority', 'assertPhysicalShipmentWriteAuthority', './shipmentPhysicalAllocationService')
    : imported(consumer, 'assertPhysicalShipmentWriteAuthority', 'assertPhysicalShipmentWriteAuthority', './shipmentPhysicalAllocationService');
  if (!g.delegation || !actor?.body || !exportedAuthority || !helperImported
    || !imported(auth, 'loadUserWithRoles', 'loadUserWithRoles', '../auth/tokenHelpers')
    || !imported(auth, 'buildLoadedAuthTokenPayload', 'buildLoadedAuthTokenPayload', '../auth/tokenHelpers')) return false;
  const trustedToken = calls(g.handler!.body!, g.runtime, 'toolActorToken');
  const currentAccount = calls(actor.body, auth, 'loadUserWithRoles').some(call => awaited(call) && call.arguments[0]?.getText(auth) === 'tx');
  const currentGrants = calls(actor.body, auth, 'buildLoadedAuthTokenPayload').some(call => awaited(call) && call.arguments[0]?.getText(auth) === 'tx');
  const signedCeiling = nodes(actor.body, ts.isPropertyAccessExpression).some(node => node.getText(auth) === 'prior.permissionCeiling');
  const requiredScopes = calls(actor.body, auth, 'hasScope').map(call => call.arguments[1]?.getText(auth));
  if (trustedToken.length !== 1 || trustedToken[0].arguments[0]?.getText(g.runtime) !== 'context.actor'
    || !currentAccount || !currentGrants || !signedCeiling || !requiredScopes.includes("'orders:read'") || !requiredScopes.includes("'shipments:write'")) return false;
  if (actor.parameters[2]?.name.getText(auth) !== 'requireOrderRead' || actor.parameters[2]?.initializer?.getText(auth) !== 'true') return false;
  if (kind === 'create') {
    const checks = g.inTx('assertPhysicalShipmentWriteAuthority'), scopes = g.inTx('freshOrderLineScope');
    const writes = g.inTx('t.shipment.create'), audits = g.inTx('writeRouteAuditLog'), parents = g.inTx('lockReleaseSources');
    return checks.length === 3 && scopes.length === 2 && writes.length === 1 && audits.length === 1 && parents.length === 1
      && checks.every(call => call.arguments[0]?.getText(g.service) === 't')
      && scopes.every(call => call.arguments[0]?.getText(g.service) === 't' && call.arguments[1]?.getText(g.service) === 'actor')
      && checks[0].arguments[1]?.getText(g.service) === 'params.actor' && checks[0].arguments[2]?.getText(g.service) === 'false'
      && checks[1].arguments[1]?.getText(g.service) === 'params.actor ?? null' && checks[1].arguments[2] === undefined
      && checks[2].arguments[1]?.getText(g.service) === 'params.actor' && checks[2].arguments[2]?.getText(g.service) === '!!input.orderId'
      && checks[0].getStart() < parents[0].getStart() && parents[0].getStart() < checks[1].getStart()
      && checks[1].getStart() < scopes[0].getStart() && scopes[0].getStart() < writes[0].getStart()
      && writes[0].getStart() < checks[2].getStart() && checks[2].getStart() < scopes[1].getStart()
      && scopes[1].getStart() < audits[0].getStart();
  }
  const lock = declaration(consumer, 'lockShipmentPhysicalConsumer');
  const parents = declaration(consumer, 'visibleParents');
  return !!lock?.body && !!parents?.body && calls(lock.body, consumer, 'assertPhysicalShipmentWriteAuthority').some(call => call.arguments[0]?.getText(consumer) === 'tx'
      && call.arguments[2]?.getText(consumer) === 'before.orderIds.length > 0')
    && calls(parents.body, consumer, 'freshOrderLineScope').some(call => awaited(call) && call.arguments[0]?.getText(consumer) === 'tx')
    && calls(parents.body, consumer, 'tx.order.findFirst').some(awaited);
}
function fnBody(name: string): string {
  const file = parse('runtime.ts', TR), fn = declaration(file, name);
  return fn?.getText(file) ?? '';
}
// These assertions inspect source wiring only; the sibling storage controls
// execute handlers. Neither class of test proves PostgreSQL or browser behavior.
function emittedCode(source: string, fnName: string, code: string): boolean {
  const file = parse('codes.ts', source), fn = declaration(file, fnName);
  return !!fn?.body && (nodes(fn.body, ts.isPropertyAssignment).some(node => ['code', 'error'].includes(node.name.getText(file))
    && ts.isStringLiteral(node.initializer) && node.initializer.text === code)
    || calls(fn.body, file, 'businessError').some(call => ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === code));
}
/** Actual typed carrier dataflow, independent of a copied list of producer codes. */
function canonicalMutationErrorWiring(source: ts.SourceFile): boolean {
  const uniqueImport = (local: string, module: string) => imported(source, local, local, module)
    && nodes(source, ts.isImportSpecifier).filter(node => node.name.text === local).length === 1
    && !nodes(source, (node): node is ts.NamedDeclaration =>
      (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)
        || ts.isParameter(node) || ts.isBindingElement(node)) && !!node.name && node.name.getText(source) === local).length;
  if (!uniqueImport('isBusinessError', '../shared/errorCodes')
    || !uniqueImport('safeRouteError', '../shared/routeError')
    || !uniqueImport('CreditExceptionConsumptionError', '../credit/creditExceptionGate')) return false;
  const matches = source.statements.filter((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'toMutationError');
  const conversion = matches[0];
  if (matches.length !== 1 || !conversion?.body || conversion.parameters.length !== 2
    || conversion.parameters[0].name.getText(source) !== 'e' || conversion.parameters[1].name.getText(source) !== 'fallback') return false;
  const unwrap = (node: ts.Expression): ts.Expression => {
    while (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression;
    return node;
  };
  const property = (object: ts.ObjectLiteralExpression, name: string, expression: string) => {
    const entries = object.properties.filter((node): node is ts.PropertyAssignment =>
      ts.isPropertyAssignment(node) && node.name.getText(source) === name);
    return entries.length === 1 && unwrap(entries[0].initializer).getText(source) === expression;
  };
  const statements = conversion.body.statements;
  const typed = statements[0], credit = statements[1], unknown = statements[3];
  // Closed control-flow shape excludes an early bypass or ordinary code-only branch.
  if (statements.length !== 4 || !ts.isIfStatement(typed) || typed.elseStatement
    || typed.expression.getText(source) !== 'isBusinessError(e)' || !ts.isBlock(typed.thenStatement)
    || typed.thenStatement.statements.length !== 3 || !ts.isIfStatement(credit) || credit.elseStatement
    || credit.expression.getText(source) !== 'e instanceof CreditExceptionConsumptionError'
    || !ts.isBlock(credit.thenStatement) || credit.thenStatement.statements.length !== 2) return false;
  const safeProducer = (block: ts.Block, fallback: string) => {
    const declarations = nodes(block, ts.isVariableDeclaration).filter(node => node.name.getText(source) === 'safe');
    const safe = declarations[0]?.initializer;
    return declarations.length === 1 && !!safe && ts.isCallExpression(safe)
      && safe.expression.getText(source) === 'safeRouteError' && safe.arguments.length === 2
      && safe.arguments[0].getText(source) === 'e' && objectProperty(safe.arguments[1], source, 'fallbackCode') === fallback
      && calls(block, source, 'safeRouteError').length === 1;
  };
  if (!safeProducer(typed.thenStatement, 'fallback') || !safeProducer(credit.thenStatement, "'INTERNAL_ERROR'")) return false;
  const domain = nodes(typed.thenStatement, ts.isVariableDeclaration).filter(node => node.name.getText(source) === 'domain');
  if (domain.length !== 1 || !domain[0].initializer || unwrap(domain[0].initializer).getText(source) !== 'e') return false;
  const returned = typed.thenStatement.statements[2];
  if (!ts.isReturnStatement(returned) || !returned.expression || !ts.isObjectLiteralExpression(returned.expression)) return false;
  const result = returned.expression;
  const detail = (name: string) => result.properties.filter(node => ts.isSpreadAssignment(node)
    && unwrap(node.expression).getText(source).replace(/\s+/g, '') === `domain.${name}?{${name}:domain.${name}}:{}`).length === 1;
  if (result.properties.length !== 5 || !property(result, 'code', 'safe.code') || !property(result, 'message', 'safe.message')
    || !property(result, 'statusCode', 'safe.status') || !detail('gateDetails') || !detail('shortShipDetails')) return false;
  const creditReturn = credit.thenStatement.statements[1];
  if (!ts.isReturnStatement(creditReturn) || !creditReturn.expression || !ts.isObjectLiteralExpression(creditReturn.expression)
    || creditReturn.expression.properties.length !== 2 || !property(creditReturn.expression, 'code', 'e.code')
    || !property(creditReturn.expression, 'message', 'safe.message')) return false;
  if (!ts.isExpressionStatement(statements[2]) || !ts.isCallExpression(statements[2].expression)
    || statements[2].expression.expression.getText(source) !== 'logger.error'
    || !ts.isReturnStatement(unknown) || !unknown.expression || !ts.isObjectLiteralExpression(unknown.expression)
    || unknown.expression.properties.length !== 2 || !property(unknown.expression, 'code', 'fallback')) return false;
  const message = unknown.expression.properties.find((node): node is ts.PropertyAssignment =>
    ts.isPropertyAssignment(node) && node.name.getText(source) === 'message');
  return !!message && ts.isStringLiteral(message.initializer)
    && message.initializer.text === '出运操作未能完成，请刷新核对当前记录后重试。';
}
function errorsWired(kind: 'create' | 'update', src: Sources = sources): boolean {
  const g = graph(kind, src);
  const forward = g.handler?.body && nodes(g.handler.body, ts.isPropertyAssignment).some(node => node.name.getText(g.runtime) === 'error'
    && node.initializer.getText(g.runtime) === 'result.error!.code');
  const catchCalls = g.producer?.body ? calls(g.producer.body, g.service, 'toMutationError') : [];
  const fallback = kind === 'create' ? 'CREATE_FAILED' : 'UPDATE_FAILED';
  const fallbackPresent = catchCalls.some(call => nodes(call, ts.isStringLiteral).some(literal => literal.text === fallback));
  const passThrough = canonicalMutationErrorWiring(g.service);
  const originalOrderCodes = emittedCode(ORDER_LINK, 'linkOrderStatusFromShipment', 'ORDER_NOT_FOUND')
    && emittedCode(ORDER_LINK, 'linkOrderStatusFromShipment', 'ORDER_TERMINAL');
  const consumer = parse('consumer.ts', src.consumer), hints = declaration(consumer, 'sourceHints');
  const lock = declaration(consumer, 'lockShipmentPhysicalConsumer');
  const explicitMissingTarget = g.inTx('lockShipmentPhysicalConsumer').some(call => objectProperty(call.arguments[1], g.service, 'missingShipmentCode') === "'SHIPMENT_NOT_FOUND'")
    && !!hints?.body && calls(hints.body, consumer, 'businessError').some(call => call.arguments[0]?.getText(consumer) === 'missingShipmentCode')
    && !!lock?.body && calls(lock.body, consumer, 'sourceHints').filter(call => awaited(call)
      && call.arguments[2]?.getText(consumer) === 'params.missingShipmentCode').length === 2;
  const notFound = kind === 'create' || explicitMissingTarget;
  return !!(g.transaction && g.link && forward && fallbackPresent && passThrough && originalOrderCodes && notFound
    && (kind === 'create' || g.transition && emittedCode(STATUS, 'validateStatusTransition', 'INVALID_TRANSITION')));
}
function assertErrorWiringMutations(kind: 'create' | 'update'): void {
  const mutate = (from: string, to: string) => {
    const changed = SERVICE.replace(from, to);
    expect(changed, `negative control must change actual source: ${from}`).not.toBe(SERVICE);
    expect(errorsWired(kind, { ...sources, service: changed }), `unsafe carrier: ${from}`).toBe(false);
  };
  mutate("from '../shared/errorCodes'", "from '../shared/unrelatedErrorCodes'");
  mutate("from '../shared/routeError'", "from '../shared/unrelatedRouteError'");
  mutate('if (isBusinessError(e)) {', 'if (isBusinessError(other)) {');
  mutate('if (isBusinessError(e)) {', "if (e?.code === 'ORDER_TERMINAL') {");
  mutate('if (isBusinessError(e)) {', 'return {code:fallback,message:String(e.message)}; if (isBusinessError(e)) {');
  mutate('if (isBusinessError(e)) {', 'const isBusinessError = () => true; if (isBusinessError(e)) {');
  mutate('const safe = safeRouteError(e, { fallbackCode: fallback });', 'const safeRouteError = () => e; const safe = safeRouteError(e, { fallbackCode: fallback });');
  mutate('const safe = safeRouteError(e, { fallbackCode: fallback });', 'const safe = safeRouteError(other, { fallbackCode: fallback });');
  mutate('fallbackCode: fallback', "fallbackCode: 'CREATE_FAILED'");
  mutate('code: safe.code as ShipmentMutationErrorCode', 'code: e.code as ShipmentMutationErrorCode');
  mutate('message: safe.message, statusCode: safe.status', 'message: e.message, statusCode: safe.status');
  mutate('statusCode: safe.status', 'statusCode: e.statusCode');
  mutate('...(domain.gateDetails ? { gateDetails: domain.gateDetails } : {})', '...(domain.gateDetails ? { gateDetails: other.gateDetails } : {})');
  mutate("message: '出运操作未能完成，请刷新核对当前记录后重试。'", 'message: String(e.message)');
  mutate("message: '出运操作未能完成，请刷新核对当前记录后重试。'", "message: 'unreviewed fallback copy'");
}

describe('task order-shipment-link: toolRuntime handleShippingCreateShipment 契约', () => {
  const body = fnBody('handleShippingCreateShipment');

  it('使用 $transaction（事务闭环）', () => {
    expect(graph('create').transaction && sourceLocks('create')).toBe(true);
  });

  it('调用 syncShipmentReferences 传 tx', () => {
    expect(graph('create').sync).toBe(true);
  });

  it('调用 linkOrderStatusFromShipment（order 联动）', () => {
    expect(graph('create').link).toBe(true);
  });

  it('稳定错误码映射（ORDER_NOT_FOUND/ORDER_TERMINAL/CREATE_FAILED）', () => {
    expect(errorsWired('create')).toBe(true);
    assertErrorWiringMutations('create');
  });

  it('缺失字段返回 MISSING_FIELDS（稳定错误码）', () => {
    expect(body).toContain("'MISSING_FIELDS'");
  });

  it('显式非法 status fail-closed（validateStatusTransition 事务前校验）', () => {
    expect(graph('create').invalidBeforeTx).toBe(true);
  });

  it('事务内调用 writeRouteAuditLog（业务+sync+order+audit 同事务）', () => {
    expect(graph('create').audit).toBe(true);
  });
});

describe('task order-shipment-link: toolRuntime handleShippingUpdateTrackingStatus 契约', () => {
  const body = fnBody('handleShippingUpdateTrackingStatus');

  it('使用 $transaction（事务闭环）', () => {
    expect(graph('update').transaction && sourceLocks('update')).toBe(true);
  });

  it('调用 validateStatusTransition（复用 route 状态机）', () => {
    expect(graph('update').transition).toBe(true);
  });

  it('调用 linkOrderStatusFromShipment（order 联动）', () => {
    expect(graph('update').link).toBe(true);
  });

  it('调用 syncShipmentReferences 传 tx', () => {
    expect(graph('update').sync).toBe(true);
  });

  it('稳定错误码映射（SHIPMENT_NOT_FOUND/ORDER_NOT_FOUND/ORDER_TERMINAL/INVALID_TRANSITION/UPDATE_FAILED）', () => {
    expect(errorsWired('update')).toBe(true);
    assertErrorWiringMutations('update');
  });

  it('事务内调用 writeRouteAuditLog（业务+sync+order+audit 同事务，before+after）', () => {
    expect(graph('update').audit).toBe(true);
  });
});

describe('task order-shipment-link: toolRuntime imports', () => {
  it('import validateStatusTransition', () => {
    expect(TR).toContain("import { validateStatusTransition } from '../statusTransition'");
  });
  it('import linkOrderStatusFromShipment', () => {
    expect(TR).toContain("import { linkOrderStatusFromShipment } from '../shipping/orderLinkService'");
  });
});


// Historical titles below are retained. Their checks are source contracts.
// ============================================================================
// Source-wiring controls: canonical transaction and pre-transaction validation
// ============================================================================




describe('task review-fix: handleShippingCreateShipment 真实行为', () => {
  it('源码：非法 status 在事务前 fail-closed，不进 $transaction', () => {
    expect(graph('create').invalidBeforeTx).toBe(true);
  });

  it('源码：auditLog.create 在 $transaction 内（同事务闭环）', () => {
    expect(graph('create').audit && graph('create').transaction).toBe(true);
  });
});

describe('task review-fix: handleShippingUpdateTrackingStatus 真实行为', () => {
  it('源码：auditLog.create 在 $transaction 内（同事务闭环）', () => {
    expect(graph('update').audit && sourceLocks('update')).toBe(true);
  });

  it('源码：sync + order-link + audit 全在事务内（失败 rollback 不伪成功）', () => {
    const wiring = graph('update');
    expect(wiring.transaction && wiring.sync && wiring.link && wiring.audit).toBe(true);
  });
});

describe('Agent canonical shipping source-wiring mutation controls', () => {
  it('requires actual imported delegation rather than a matching name or comment', () => {
    expect(graph('create').delegation && graph('update').delegation).toBe(true);
    expect(graph('create', { ...sources, runtime: TR.replace('await createSharedShipment({', 'await otherCreateShipment({') }).delegation).toBe(false);
    expect(graph('update', { ...sources, runtime: TR.replace('await updateSharedShipment({', 'updateSharedShipment({') }).delegation).toBe(false);
    expect(graph('create', { ...sources, runtime: TR.replace("from '../shipping/shipmentMutationService'", "from '../shipping/unrelatedService'") }).delegation).toBe(false);
  });
  it('requires producer, sync, order linkage and mandatory audit to use the same awaited transaction', () => {
    const create = graph('create'), update = graph('update');
    expect(create.transaction && create.sync && create.link && create.audit).toBe(true);
    expect(update.transaction && update.sync && update.link && update.audit).toBe(true);
    expect(graph('update', { ...sources, service: SERVICE.replace('await syncShipmentReferences(prisma, upd, { source: syncSource }, t)', 'await syncShipmentReferences(prisma, upd, { source: syncSource }, otherTx)') }).sync).toBe(false);
    expect(graph('update', { ...sources, service: SERVICE.replace('await linkOrderStatusFromShipment(t, oid,', 'await linkOrderStatusFromShipment(otherTx, oid,') }).link).toBe(false);
    expect(graph('create', { ...sources, service: SERVICE.replace('const auditId = await writeRouteAuditLog({', 'const auditId = writeRouteAuditLog({') }).audit).toBe(false);
    expect(graph('update', { ...sources, service: SERVICE.replaceAll('async (t: any) => {', 'async (otherTx: any) => {') }).transaction).toBe(false);
  });
  it('requires awaited parent and Shipment native locks followed by real rereads', () => {
    expect(sourceLocks('create') && sourceLocks('update')).toBe(true);
    expect(sourceLocks('create', { ...sources, service: SERVICE.replace('await lockReleaseSources(t,', 'lockReleaseSources(t,') })).toBe(false);
    expect(sourceLocks('update', { ...sources, service: SERVICE.replace('await lockShipmentPhysicalConsumer(t,', 'await lockShipmentPhysicalConsumer(otherTx,') })).toBe(false);
    expect(sourceLocks('update', { ...sources, consumer: CONSUMER.replace('FROM "Shipment"', 'FROM "OtherTable"') })).toBe(false);
    expect(sourceLocks('update', { ...sources, consumer: CONSUMER.replace('const current = await sourceHints(tx, params.shipmentId, params.missingShipmentCode);', 'const current = before;') })).toBe(false);
    expect(sourceLocks('create', { ...sources, release: RELEASE.replace('FROM "Order"', 'FROM "OtherTable"') })).toBe(false);
  });
  it('requires both early and late native authority with linked-order L2 reread after the actual Shipment insert', () => {
    const droppedLate = SERVICE.replace('const actor = await assertPhysicalShipmentWriteAuthority(t, params.actor, !!input.orderId);', 'const actor = params.actor!;');
    expect(droppedLate).not.toBe(SERVICE);
    expect(currentActorWiring('create', { ...sources, service: droppedLate })).toBe(false);
    const droppedScope = SERVICE.replaceAll('const scope = await freshOrderLineScope(t, actor);', 'const scope = {};');
    expect(droppedScope).not.toBe(SERVICE);
    expect(currentActorWiring('create', { ...sources, service: droppedScope })).toBe(false);
  });
  it('default Order read remains required and only actual empty source-parent consumers may omit it', () => {
    const defaultOff = AUTHORITY.replace('requireOrderRead = true', 'requireOrderRead = false');
    expect(defaultOff).not.toBe(AUTHORITY);
    expect(currentActorWiring('create', { ...sources, authority: defaultOff })).toBe(false);
    const parentBypass = CONSUMER.replace('before.orderIds.length > 0', 'false');
    expect(parentBypass).not.toBe(CONSUMER);
    expect(currentActorWiring('update', { ...sources, consumer: parentBypass })).toBe(false);
  });
  it('requires actual tool token, freshly stored account/grants, signed ceiling and parent object scope', () => {
    expect(currentActorWiring('create') && currentActorWiring('update')).toBe(true);
    expect(currentActorWiring('create', { ...sources, runtime: TR.replace('actor: toolActorToken(context.actor)', 'actor: toolActorToken(input.actor)') })).toBe(false);
    expect(currentActorWiring('create', { ...sources, authority: AUTHORITY.replace('await loadUserWithRoles(tx, prior.userId)', 'prior') })).toBe(false);
    expect(currentActorWiring('update', { ...sources, authority: AUTHORITY.replace('await buildLoadedAuthTokenPayload(tx, user)', 'prior') })).toBe(false);
    expect(currentActorWiring('create', { ...sources, authority: AUTHORITY.replaceAll('prior.permissionCeiling', 'prior.ignoredCeiling') })).toBe(false);
    expect(currentActorWiring('create', { ...sources, authority: AUTHORITY.replace('export const assertPhysicalShipmentWriteAuthority = currentActor;', 'export const assertPhysicalShipmentWriteAuthority = uncheckedActor;') })).toBe(false);
  });
});
