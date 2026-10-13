/** Source-only positive/negative contracts. Actual snippets run with pure error
 * dependencies; no native service factory, middleware or database is executed. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { stripComments } from './utils/sourceScan';
import { assertNativeProof, classSource, functionSource, finiteMessageOffsets, readNativeProof, sourceHash, variableSource } from './utils/nativeMessageProof';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const proof = readNativeProof(root);
const serviceFile = 'server/src/finance/proformaInvoiceService.ts', accessFile = 'server/src/finance/proformaInvoiceAccess.ts';
function altered(file: string, change: (source: string) => string, repin = false) {
  const sources = { ...proof.sources, [file]: change(proof.sources[file]) };
  const receipt = { ...proof.receipt, sourceHashes: { ...proof.receipt.sourceHashes,
    ...(repin ? { [file]: sourceHash(sources[file]) } : {}) } };
  return { sources, receipt };
}
function sourceRuntime() {
  const context: any = { logger: { error: () => undefined }, Error };
  vm.createContext(context);
  const compile = (source: string) => ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
  const run = (source: string) => vm.runInContext(compile(source), context);
  const loadModule = (source: string, require: (id: string) => unknown) => {
    // Real CommonJS module scopes: compiled functions retain their own exports
    // binding, exactly as Node's wrapper does. Do not replace registry helpers.
    const module = { exports: {} as Record<string, any> };
    const wrapper = vm.runInContext(`(function(exports, require, module) {\n${compile(source)}\n})`, context);
    wrapper(module.exports, require, module);
    return module.exports;
  };
  const registry = loadModule(proof.sources['server/src/shared/errorCodes.ts'], () => { throw Error('Registry must remain pure'); });
  const route = loadModule(proof.sources['server/src/shared/routeError.ts'], id => {
    if (id !== './errorCodes') throw Error('Only actual pure error registry allowed'); return registry;
  });
  Object.assign(context, { safeRouteError: route.safeRouteError, lookupErrorCode: registry.lookupErrorCode,
    businessError: registry.businessError, isBusinessError: registry.isBusinessError });
  run([classSource(proof.sources[accessFile], 'ProformaAccessError'), classSource(proof.sources[serviceFile], 'ProformaCommandError'),
    functionSource(proof.sources[serviceFile], 'failure'), functionSource(proof.sources['server/src/finance/proformaInvoiceHttpError.ts'], 'proformaInvoiceHttpError'),
    'globalThis.nativeFailure = failure; globalThis.httpFailure = proformaInvoiceHttpError;',
    'globalThis.accessClass = ProformaAccessError; globalThis.commandClass = ProformaCommandError;'].join('\n'));
  context.runSnippet = run; return context;
}
describe('exact native message result proof; original bare grammar remains visible', () => {
  it('all seven actual AST message locations have native producer/consumer evidence', () => {
    const actual = Object.fromEntries(Object.entries(proof.receipt.provenSites).map(([file, count]) => [file,
      finiteMessageOffsets(file, stripComments(proof.sources[file]), proof.sources, proof.receipt).size]));
    expect(actual).toEqual({ 'server/src/finance/proformaInvoiceHttpError.ts': 4,
      'server/src/finance/proformaInvoiceService.ts': 2, 'server/src/internalTrade/internalTransferService.ts': 1 });
    expect(Object.values(actual).reduce((a, b) => a + b, 0)).toBe(7);
  });
  it('even a comment/source or consumer change requires fresh source adjudication', () => {
    for (const file of Object.keys(proof.receipt.sourceHashes)) {
      const variant = altered(file, source => `${source}\n// changed source\n`);
      expect(() => assertNativeProof(variant.sources, variant.receipt)).toThrow('changed since');
    }
  });
  it('rehashing cannot bless removal of the instance guard, code widening, shadowing, or non-native HTTP input', () => {
    const variants = [
      altered(serviceFile, source => source.replace('error instanceof ProformaAccessError', 'true'), true),
      altered(serviceFile, source => source.replace("type ProformaCommandCode = 'NOT_FOUND'", "type ProformaCommandCode = string | 'NOT_FOUND'"), true),
      altered(serviceFile, source => source + '\nfunction unsafe(ProformaAccessError: any) {}\n', true),
      altered('server/src/finance/routeV2.ts', source => source.replace('proformaInvoiceHttpError(result.error)', 'proformaInvoiceHttpError(req.body)'), true),
    ];
    for (const variant of variants) expect(() => assertNativeProof(variant.sources, variant.receipt)).toThrow('Native message proof invalid');
  });
  it('a new aliased/namespace/re-export or literal dynamic consumer cannot borrow the pinned native graph', () => {
    for (const source of [
      "import { proformaInvoiceHttpError as other } from '../finance/proformaInvoiceHttpError'; other(body);",
      "import * as native from '../finance/proformaInvoiceHttpError'; native.proformaInvoiceHttpError(body);",
      "export * from '../finance/proformaInvoiceHttpError';",
      "const other = await import('../finance/proformaInvoiceHttpError');",
      "const other = require('../finance/proformaInvoiceHttpError');",
    ]) expect(() => assertNativeProof({ ...proof.sources, 'server/src/unknown/newConsumer.ts': source }, proof.receipt))
      .toThrow('native HTTP consumer file set changed');
  });
  it('actual private command and imported access instances preserve finite declared public reasons', () => {
    const runtime = sourceRuntime();
    expect(runtime.httpFailure(runtime.nativeFailure(new runtime.commandClass('NOT_PROFORMA', '独立业务说明'), 'convert').error))
      .toMatchObject({ status: 400, code: 'NOT_PROFORMA', message: '独立业务说明' });
    expect(runtime.nativeFailure(new runtime.accessClass('FORBIDDEN', '当前账号无开票权限'), 'generate').error)
      .toMatchObject({ code: 'FORBIDDEN', statusCode: 403, message: '当前账号无开票权限' });
  });
  it('actual native unknown SQL and a foreign same-name class never reach HTTP as raw text', () => {
    const runtime = sourceRuntime();
    class ProformaAccessError extends Error { code = 'FORBIDDEN'; statusCode = 403; }
    class ProformaCommandError extends Error { code = 'NOT_PROFORMA'; }
    for (const error of [Object.assign(new Error('SQL private relation path'), { code: 'P2003' }),
      new ProformaAccessError('SQL private forged class'), new ProformaCommandError('SQL private forged command')]) {
      const result = runtime.nativeFailure(error, 'generate'), http = runtime.httpFailure(result.error);
      expect(result.error.code).toBe('INTERNAL_ERROR'); expect(http.status).toBe(500);
      expect(JSON.stringify({ result, http })).not.toMatch(/SQL private|relation path|forged/);
    }
  });
  it('HTTP helper is explicitly not a generic raw exception sanitizer', () => {
    const runtime = sourceRuntime();
    // This intentionally visible limit is why the caller graph is mandatory.
    expect(runtime.httpFailure({ code: 'NOT_PROFORMA', message: 'untrusted known-code text' }).message).toBe('untrusted known-code text');
    expect(finiteMessageOffsets('server/src/unknown.ts', "return {message: error.message}", proof.sources, proof.receipt).size).toBe(0);
  });
  it('actual registered literal SOURCE_CHANGED binding preserves 409 without copying caught driver text', () => {
    const runtime = sourceRuntime(), source = proof.sources['server/src/internalTrade/internalTransferService.ts'];
    runtime.runSnippet(variableSource(source, 'conflict') + '\nglobalThis.literalConflict = conflict;');
    expect(runtime.literalConflict).toMatchObject({ code: 'SOURCE_CHANGED', statusCode: 409,
      message: '内部供料来源并发变化，请保留原请求并重新加载' });
    const variant = altered('server/src/internalTrade/internalTransferService.ts', s => s.replace(
      "businessError('SOURCE_CHANGED', '内部供料来源并发变化，请保留原请求并重新加载')", "businessError('SOURCE_CHANGED', error.message)"), true);
    expect(() => finiteMessageOffsets('server/src/internalTrade/internalTransferService.ts', stripComments(variant.sources['server/src/internalTrade/internalTransferService.ts']), variant.sources, variant.receipt)).toThrow('registered literal');
  });
  it('actual retired fabric catch helper retains declared business status and rejects unknown SQL text', () => {
    const runtime = sourceRuntime(), source = proof.sources['server/src/development/fabricDevelopmentService.ts'];
    runtime.runSnippet([variableSource(source, 'fail'), variableSource(source, 'OPERATIONAL_ERROR_CODES'),
      functionSource(source, 'failFabricOperation'), 'globalThis.fabricFailure = failFabricOperation;'].join('\n'));
    expect(runtime.fabricFailure(Object.assign(new Error('原业务拒绝'), { code: 'INVALID_TRANSITION', statusCode: 409 }), 'BATCH_STAGE_FAILED', '安全兜底', ['INVALID_TRANSITION']))
      .toMatchObject({ ok: false, error: { code: 'INVALID_TRANSITION', status: 409, message: '原业务拒绝' } });
    const failure = runtime.fabricFailure(Object.assign(new Error('SQL 必填 private path'), { code: 'P2003' }), 'BATCH_STAGE_FAILED', '安全兜底', ['INVALID_TRANSITION']);
    expect(failure).toMatchObject({ ok: false, error: { code: 'BATCH_STAGE_FAILED', status: 500, message: '安全兜底' } });
    expect(JSON.stringify(failure)).not.toContain('SQL');
  });
  it('actual commission unknown failure discards original driver text and never claims rollback', () => {
    const runtime = sourceRuntime(), source = proof.sources['server/src/pricing/commissionPayableService.ts'];
    runtime.runSnippet([variableSource(source, 'fail'), variableSource(source, 'COMMISSION_VIEW_FAILURE_MESSAGE'),
      variableSource(source, 'COMMISSION_CREATE_FAILURE_MESSAGE'), functionSource(source, 'unknownCommissionFailure'),
      'globalThis.commissionFailure = unknownCommissionFailure;'].join('\n'));
    for (const mode of ['read', 'create']) {
      const failure = runtime.commissionFailure(new Error('SQL private table path'), mode);
      expect(failure.ok).toBe(false); expect(failure.error.status).toBe(500);
      expect(failure.error.message).not.toMatch(/SQL private|已回滚|未确认任何改动/);
    }
  });
  it('retired UTC defaults retain real imported local-date calls in both native producers', () => {
    expect(proof.sources[serviceFile]).toMatch(/from '\.\.\/shared\/localDate'/);
    expect(functionSource(proof.sources[serviceFile], 'issueDateOf')).toContain('input.issueDate || todayLocalKey()');
    expect(proof.sources['server/src/qc/qcService.ts']).toMatch(/inspectionDate:\s*r\.inspectionDate\s*\?\?\s*todayLocalKey\(\)/);
    expect(proof.sources['server/src/qc/qcService.ts']).toMatch(/from '\.\.\/shared\/localDate'/);
  });
});
