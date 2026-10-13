/** Current source renewal only. Pure native error modules and extracted carriers
 * execute in one VM; no application factory, authority stub or writer runs. */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { Prisma } from '@prisma/client';
import { assertNativeProof, classSource, functionSource, nativeReceiptPath, nativeSourceReview,
  readNativeProof, sourceHash, variableSource } from './utils/nativeMessageProof';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const reviewPath = 'artifacts/acceptance-20261001/execution/source-readings/v1-378a21ca-carton-native-source-review.json';
const qcFile = 'server/src/qc/qcService.ts', routeFile = 'server/src/qc/qcRoute.ts', shippingFile = 'server/src/shipping/route.ts';
const source = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const parse = (text: string) => ts.createSourceFile('current.ts', text, ts.ScriptTarget.Latest, true);
function nodes<T extends ts.Node>(node: ts.Node, predicate: (node: ts.Node) => node is T): T[];
function nodes(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[];
function nodes(node: ts.Node, predicate: (node: ts.Node) => boolean) {
  const found: ts.Node[] = [];
  const visit = (item: ts.Node) => { if (predicate(item)) found.push(item); ts.forEachChild(item, visit); };
  visit(node); return found;
}
function imported(text: string, id: string, module: string) {
  const ast = parse(text);
  expect(nodes(ast, node => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
    && node.moduleSpecifier.text === module && !!node.importClause?.namedBindings
    && ts.isNamedImports(node.importClause.namedBindings) && node.importClause.namedBindings.elements.some(item => item.name.text === id))).toHaveLength(1);
}
function reportProjection(text: string) {
  imported(text, 'qcReportAccess', './qcReportAuthority');
  imported(text, 'attachReportCoverageContext', './qcReportReadProjection');
  const fn = parse(functionSource(text, 'getReport'));
  const calls = nodes(fn, ts.isCallExpression).map(call => call.expression.getText(fn));
  expect(calls).toEqual(['db.$transaction', 'qcReportAccess', 'attachReportCoverageContext']);
  const access = nodes(fn, ts.isCallExpression).find(call => call.expression.getText(fn) === 'qcReportAccess')!;
  expect(access.arguments.map(arg => arg.getText(fn))).toEqual(['tx', 'actor', 'reportId']);
  const coverage = nodes(fn, ts.isCallExpression).find(call => call.expression.getText(fn) === 'attachReportCoverageContext')!;
  expect(coverage.arguments.map(arg => arg.getText(fn))).toEqual(['tx', '[access.report]', 'access.actor']);
  const order = nodes(fn, ts.isPropertyAssignment).find(item => item.name.getText(fn) === 'order')!;
  expect(ts.isObjectLiteralExpression(order.initializer)).toBe(true);
  const fields = (order.initializer as ts.ObjectLiteralExpression).properties as ts.NodeArray<ts.PropertyAssignment>;
  expect(fields.map(item => [item.name.getText(fn), item.initializer.getText(fn)])).toEqual([
    ['id', 'access.order.id'], ['poNumber', 'access.order.poNumber'], ['customer', 'access.order.customer'], ['product', 'access.order.product'],
  ]);
  expect(functionSource(text, 'getReport')).toContain('Prisma.TransactionIsolationLevel.RepeatableRead');
}
function historyBinding(route: string, reader: string) {
  imported(route, 'readAuthorizedShipmentScheduleHistory', './shipmentScheduleHistoryRead');
  const ast = parse(route), calls = nodes(ast, ts.isCallExpression).filter(call => call.expression.getText(ast) === 'readAuthorizedShipmentScheduleHistory');
  expect(calls).toHaveLength(1);
  expect(calls[0].arguments.map(arg => arg.getText(ast))).toEqual(['prisma', '(req as any).actor ?? null', 'req.params.id', '{ datesOnly, limit }']);
  const fn = functionSource(reader, 'readAuthorizedShipmentScheduleHistory');
  expect(fn.match(/await qualify\(\);/g)).toHaveLength(2);
  expect(fn).toContain('loadUserWithRoles(prisma, prior.userId)');
  expect(fn).toContain('buildLoadedAuthTokenPayload(prisma, user)');
  expect(fn).toContain('actor.permissionCeiling = [...prior.permissionCeiling]');
  expect(fn).toContain("hasScope({ ...actor, roles: [] }, 'shipments:read')");
  expect(fn).toContain('resolveVisibleOrderIds(prisma, actor, { fresh: true, strict: true })');
  expect(fn).toContain('result.shipmentId !== shipmentId');
}
function errorRuntime(route = source(routeFile)) {
  const context: any = { Error, Prisma, logger: { error: () => undefined } };
  vm.createContext(context);
  const compile = (text: string) => ts.transpileModule(text, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const run = (text: string) => vm.runInContext(compile(text), context);
  const load = (text: string, require: (id: string) => unknown) => {
    const module = { exports: {} as Record<string, any> };
    vm.runInContext(`(function(exports,require,module){\n${compile(text)}\n})`, context)(module.exports, require, module);
    return module.exports;
  };
  const registry = load(source('server/src/shared/errorCodes.ts'), () => { throw Error('Registry must be pure'); });
  const carrier = load(source('server/src/shared/routeError.ts'), id => {
    if (id !== './errorCodes') throw Error('Unexpected error dependency'); return registry;
  });
  Object.assign(context, { businessError: registry.businessError, safeRouteError: carrier.safeRouteError });
  run([classSource(source('server/src/qc/qcAssignmentAccess.ts'), 'QcAssignmentError'),
    classSource(source('server/src/qc/qcReportAuthority.ts'), 'QcReportError'),
    functionSource(source('server/src/orders/orderLineWriteAccess.ts'), 'isOrderLineStorageConflict'),
    functionSource(source('server/src/qc/qcReportAuthority.ts'), 'qcReportFailure'), variableSource(route, 'handleError'),
    'globalThis.QcReportError = QcReportError; globalThis.handleError = handleError;'].join('\n'));
  return { run, context, carrier, registry };
}
function response(runtime: ReturnType<typeof errorRuntime>, error: unknown) {
  const res: any = { status(value: number) { this.statusCode = value; return this; }, json(body: unknown) { this.body = body; return this; } };
  runtime.context.handleError(res, error, 'QC_SUCCESSOR_PROOF_FAILED');
  return { status: res.statusCode, body: res.body };
}
describe('combined QC successor source renewal', () => {
  it('three renewed pins bind the current source and immutable finite graph, and every old pin still rejects', () => {
    const proof = readNativeProof(root), fresh = JSON.parse(source(reviewPath));
    expect(Object.keys(proof.receipt.sourceHashes)).toHaveLength(20);
    expect(Object.keys(nativeSourceReview.sourceHashes)).toHaveLength(10);
    expect(proof.receipt.consumerFiles).toEqual(['server/src/finance/routeV2.ts']);
    expect(Object.values(proof.receipt.provenSites).reduce((sum, value) => sum + value, 0)).toBe(7);
    expect(sourceHash(source(nativeReceiptPath))).toBe(fresh.originalNativeReceiptSHA256);
    for (const [file, pin] of Object.entries(fresh.dependencySourceHashes)) expect(sourceHash(source(file))).toBe(pin);
    for (const [file, oldPin] of Object.entries(fresh.previousReviewPins as Record<string, string>)) {
      expect(() => assertNativeProof(proof.sources, { ...proof.receipt,
        sourceHashes: { ...proof.receipt.sourceHashes, [file]: oldPin } })).toThrow(`${file} changed since`);
    }
    expect(fresh.currentCombinedNativeExecution.status).toBe('not_executed_in_this_packet');
    expect(fresh.historical787NativeExecution.actualControls).toBe(1220);
  });
  it('report metadata uses only the already-authorized parent and real coverage leaf; input-parent and extra-field counterchanges reject', () => {
    const text = source(qcFile); reportProjection(text);
    expect(() => reportProjection(text.replace('id: access.order.id', 'id: reportId'))).toThrow();
    expect(() => reportProjection(text.replace('customer: access.order.customer', 'customer: access.order.customer, ownerId: access.order.ownerId'))).toThrow();
    expect(() => reportProjection(text.replace('qcReportAccess(tx, actor, reportId)', 'qcReportAccess(tx, null, reportId)'))).toThrow();
  });
  it('actual nine native business producers retain 400/404 and typed 403/503, while ordinary SQL and ROLE_REQUIRED never escape the real carrier', () => {
    const runtime = errorRuntime(), text = source(qcFile);
    imported(text, 'QcReportError', './qcReportAuthority');
    imported(source(routeFile), 'qcReportFailure', './qcReportAuthority');
    imported(source(routeFile), 'safeRouteError', '../shared/routeError');
    const functions = ['getLocationOrThrow', 'createLocation', 'updateLocation', 'deleteLocation', 'checkShipmentEligibility'];
    const producers = functions.flatMap(id => {
      const fn = parse(functionSource(text, id));
      return nodes(fn, ts.isThrowStatement).filter(node => ts.isNewExpression(node.expression)
        && node.expression.expression.getText(fn) === 'QcReportError').map(node => node.expression.getText(fn));
    });
    expect(producers).toHaveLength(9);
    for (const producer of producers) {
      const error = runtime.run(producer), actual = response(runtime, error);
      expect(actual.status).toBe(error.code === 'NOT_FOUND' ? 404 : 400);
      expect(actual.body).toEqual({ error: { code: 'QC_SUCCESSOR_PROOF_FAILED', message: error.message } });
      expect(response(runtime, runtime.run(producer.replace('QcReportError', 'Error').replace(/'[^']+', /, ''))).status).toBe(500);
    }
    for (const [code, status] of [['FORBIDDEN', 403], ['AUTHORIZATION_UNAVAILABLE', 503]] as const) {
      const actual = response(runtime, new runtime.context.QcReportError(code, '已审定安全业务说明'));
      expect(actual).toEqual({ status, body: { error: { code, message: '已审定安全业务说明' } } });
    }
    for (const error of [new Error('SQL private_qc /internal/path ROLE_REQUIRED'),
      Object.assign(new Error('SQL private_qc /internal/path'), { code: 'NOT_FOUND', statusCode: 404 })]) {
      const actual = response(runtime, error);
      expect(actual).toEqual({ status: 500, body: { error: { code: 'QC_SUCCESSOR_PROOF_FAILED', message: 'QC 操作结果暂不可确认，请刷新记录后重试。' } } });
    }
    const unsafe = errorRuntime(source(routeFile).replace('const failure = qcReportFailure(e);', 'const failure = e;'));
    expect(JSON.stringify(response(unsafe, Object.assign(new Error('SQL private_qc /internal/path'), { code: 'NOT_FOUND', statusCode: 404 })))).toContain('SQL private_qc');
  });
  it('shipping keeps the actual current-authority reader and safe original catch; direct-reader and lost late-fence counterchanges reject', () => {
    const route = source(shippingFile), reader = source('server/src/shipping/shipmentScheduleHistoryRead.ts');
    historyBinding(route, reader);
    expect(() => historyBinding(route.replace('await readAuthorizedShipmentScheduleHistory(prisma', 'await getShipmentScheduleHistory(prisma'), reader)).toThrow();
    expect(() => historyBinding(route, reader.replace('await qualify();', '// removed qualification'))).toThrow();
    const ast = parse(route), call = nodes(ast, ts.isCallExpression).find(node => node.expression.getText(ast) === 'readAuthorizedShipmentScheduleHistory')!;
    let parent: ts.Node = call; while (parent.parent && !ts.isTryStatement(parent)) parent = parent.parent;
    const caught = (parent as ts.TryStatement).catchClause!;
    const se = nodes(caught, ts.isVariableDeclaration).find(node => node.name.getText(ast) === 'se')!;
    const runtime = errorRuntime();
    const carrier = runtime.run(`(err:unknown)=>{const ${se.getText(ast)}; return se;}`);
    expect(carrier(new Error('SQL private_audit /internal/path')).status).toBe(500);
    expect(carrier(new Error('SQL private_audit /internal/path')).message).not.toContain('SQL');
    const typed = runtime.registry.businessError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验权限。');
    expect(carrier(typed)).toMatchObject({ status: 503, code: 'AUTHORIZATION_UNAVAILABLE', message: '暂时无法核验权限。' });
  });
});
