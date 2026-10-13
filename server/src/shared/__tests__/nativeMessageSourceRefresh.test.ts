/** Exact source/AST controls over current native code. No DB, service factory,
 * app router, fake authorization helper or public raw-message exemption. */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { safeRouteError } from '../routeError';
import { isBusinessError, lookupErrorCode, httpStatusOfCode } from '../errorCodes';
import { assertNativeProof, functionSource, nativeReceiptPath, nativeSourceReview,
  readNativeProof, sourceHash, variableSource } from './utils/nativeMessageProof';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const proof = readNativeProof(root);
const original = JSON.parse(fs.readFileSync(path.join(root, nativeReceiptPath), 'utf8'));
const domainFile = 'server/src/shared/__tests__/domainErrorShapes.test.ts';
const domainSource = () => fs.readFileSync(path.join(root, domainFile), 'utf8');
const actualSource = (file: string) => fs.readFileSync(path.join(root, 'server/src', file), 'utf8');
const wrapperProof = (file: string, source = actualSource(file)) => {
  const declaration = functionSource(domainSource(), 'privateTransactionResultProof');
  const javascript = ts.transpileModule(declaration + '\nprivateTransactionResultProof(file,source);', {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return vm.runInNewContext(javascript, { ts, file, source }, { timeout: 1000 });
};
const manual = 'finance/billingItemService.ts', commission = 'pricing/commissionPayableService.ts';
function runtime(file: string, error?: unknown) {
  const actual = actualSource(file), witness = wrapperProof(file);
  expect(witness).toBeTruthy();
  let code = witness.constructorSource + '\n' + variableSource(actual, 'fail');
  if (file === manual) {
    code += '\n' + witness.producerSource + '\n' + witness.consumerSource + `
      let native;try{abortManualInvoice('CONFLICT','independent original refusal',409)}catch(error){native=error}
      ({native:manualInvoiceFailure(native,'PRIVATE_WRAPPER_PROBE','independent safe fallback'),
        direct:safeRouteError(native,{fallbackCode:'INTERNAL_ERROR'}),
        foreign:manualInvoiceFailure(error,'PRIVATE_WRAPPER_PROBE','independent safe fallback')});`;
  } else {
    for (const id of ['COMMISSION_VIEW_FAILURE_MESSAGE', 'COMMISSION_CREATE_FAILURE_MESSAGE', 'INVOICE_ERROR_CODES', 'INVOICE_STATUS_VALIDATION_CODES'])
      code += '\n' + variableSource(actual, id);
    code += '\n' + functionSource(actual, 'unknownCommissionFailure') + '\n' + functionSource(actual, 'invoiceFailure');
    code += '\nfunction consume(error:unknown)' + witness.consumerSource + `
      const native=new CommissionAbort({ok:false,error:{code:'CONFLICT',message:'independent original refusal',status:409}});
      ({native:consume(native),direct:safeRouteError(native,{fallbackCode:'INTERNAL_ERROR'}),foreign:consume(error)});`;
  }
  const javascript = ts.transpileModule(code.replace(/^export /gm, ''), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return vm.runInNewContext(javascript, { Error, error, safeRouteError, isBusinessError,
    httpStatusOfCode, logger: { error() {} } }, { timeout: 1000 });
}
describe('reviewed ten source pins retain the exact original native graph', () => {
  it('only ten old hashes change; original finite sites, unions and consumer files remain exact', () => {
    const changed = Object.keys(original.sourceHashes).filter(file => original.sourceHashes[file] !== proof.receipt.sourceHashes[file]);
    expect(changed.sort()).toEqual(Object.keys(nativeSourceReview.sourceHashes).sort());
    expect(changed).toHaveLength(10); expect(Object.keys(proof.receipt.sourceHashes)).toHaveLength(20);
    expect(proof.receipt.commandCodes).toEqual(original.commandCodes);
    expect(proof.receipt.accessCodes).toEqual(original.accessCodes);
    expect(proof.receipt.consumerFiles).toEqual(original.consumerFiles);
    expect(proof.receipt.provenSites).toEqual(original.provenSites);
    expect(nativeSourceReview.unchangedExecutableProofAtoms).toBe(10);
    expect(nativeSourceReview.finiteSites).toBe(7);
  });
  it.each(Object.keys(nativeSourceReview.sourceHashes))('restoring the old %s pin is red on the current exact source', file => {
    expect(sourceHash(proof.sources[file])).toBe(nativeSourceReview.sourceHashes[file as keyof typeof nativeSourceReview.sourceHashes]);
    const receipt = { ...proof.receipt, sourceHashes: { ...proof.receipt.sourceHashes, [file]: original.sourceHashes[file] } };
    expect(() => assertNativeProof(proof.sources, receipt)).toThrow('changed since');
  });
  const service = 'server/src/finance/proformaInvoiceService.ts', route = 'server/src/finance/routeV2.ts';
  it.each([
    ['actual instance', service, 'error instanceof ProformaAccessError', 'true'],
    ['closed union', service, "type ProformaCommandCode = 'NOT_FOUND'", "type ProformaCommandCode = string | 'NOT_FOUND'"],
    ['native body', route, 'proformaInvoiceHttpError(result.error)', 'proformaInvoiceHttpError(req.body)'],
    ['native shadow', service, '', '\nfunction forged(ProformaAccessError:any){}\n'],
  ])('rehashing cannot bless a changed %s', (_name, file, from, to) => {
    const current = proof.sources[file];
    if (from) expect(current).toContain(from);
    const source = from ? current.replace(from, to) : current + to;
    const sources = { ...proof.sources, [file]: source };
    const receipt = { ...proof.receipt, sourceHashes: { ...proof.receipt.sourceHashes, [file]: sourceHash(source) } };
    expect(() => assertNativeProof(sources, receipt)).toThrow('Native message proof invalid');
  });
  it.each([
    "import {proformaInvoiceHttpError as other} from '../finance/proformaInvoiceHttpError';other(body);",
    "import * as other from '../finance/proformaInvoiceHttpError';other.proformaInvoiceHttpError(body);",
    "export * from '../finance/proformaInvoiceHttpError';",
    "const other=await import('../finance/proformaInvoiceHttpError');",
    "const other=require('../finance/proformaInvoiceHttpError');",
  ])('new literal consumer stays red: %s', source => {
    const file = 'server/src/unknown/newConsumer.ts';
    const sources = { ...proof.sources, [file]: source };
    const receipt = { ...proof.receipt, sourceHashes: { ...proof.receipt.sourceHashes, [file]: sourceHash(source) } };
    expect(() => assertNativeProof(sources, receipt)).toThrow('native HTTP consumer file set changed');
  });
});
describe('two exact native transaction result wrappers are not public classes', () => {
  it('the two new census class registrations bind to exactly their actual production files', () => {
    const locations: string[] = [];
    const walk = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) { walk(file); continue; }
        if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
        const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
        const visit = (node: ts.Node) => {
          if (ts.isClassDeclaration(node) && ['ManualInvoiceAbort', 'CommissionAbort'].includes(node.name?.text ?? ''))
            locations.push(path.relative(path.join(root, 'server/src'), file).split(path.sep).join('/') + ':' + node.name!.text);
          ts.forEachChild(node, visit);
        };
        visit(ast);
      }
    };
    walk(path.join(root, 'server/src'));
    expect(locations.sort()).toEqual(['finance/billingItemService.ts:ManualInvoiceAbort', 'pricing/commissionPayableService.ts:CommissionAbort']);
  });
  it.each([manual, commission])('%s has a real source-bound transaction throw and external native result consumer', file => {
    const witness = wrapperProof(file);
    expect(witness).toBeTruthy(); expect(witness.constructors).toBe(file === manual ? 3 : 5);
    expect(wrapperProof('unknown/' + path.basename(file), actualSource(file))).toBeUndefined();
    const result = runtime(file, new Error('SQL private_relation'));
    expect(result.native).toMatchObject({ ok: false, error: { code: 'CONFLICT', message: 'independent original refusal', status: 409 } });
    expect(result.direct).toMatchObject({ code: 'INTERNAL_ERROR', status: 500, passthrough: false });
    expect(result.foreign.ok).toBe(false); expect(result.foreign.error.status).toBe(500);
    expect(JSON.stringify(result.foreign)).not.toMatch(/SQL|private_relation/);
  });
  it.each([manual, commission])('%s foreign same-name and serialized wrapper results cannot borrow native identity', file => {
    class ManualInvoiceAbort extends Error { failure = { code: 'CONFLICT', message: 'SQL private_relation', status: 409 }; }
    class CommissionAbort extends Error { refusal = { ok: false, error: { code: 'CONFLICT', message: 'SQL private_relation', status: 409 } }; }
    const foreign = file === manual ? new ManualInvoiceAbort('SQL private_relation') : new CommissionAbort('SQL private_relation');
    for (const error of [foreign, { ...foreign, name: foreign.constructor.name }]) {
      const result = runtime(file, error);
      expect(result.foreign.error.status).toBe(500); expect(JSON.stringify(result.foreign)).not.toMatch(/SQL|private_relation/);
    }
  });
  it.each([
    [manual, 'error instanceof ManualInvoiceAbort) return', 'true) return'],
    [manual, 'return manualInvoiceFailure(error,', 'return forgedFailure(error,'],
    [manual, 'if (!r.ok) abortManualInvoice(', 'if (!r.ok) return forgedSuccess('],
    [manual, 'readonly failure:', 'readonly statusCode:number,readonly failure:'],
    [manual, '', '\nfunction shadow(ManualInvoiceAbort:any){}\n'],
    [manual, '', "\nfunction outside(){throw new ManualInvoiceAbort({code:'CONFLICT',message:'forged',status:409})}\n"],
    [commission, 'error instanceof CommissionAbort) return error.refusal;', "true) return error.refusal;"],
    [commission, 'if (!invoiceResult.ok) throw new CommissionAbort', 'if (!invoiceResult.ok) return new CommissionAbort'],
    [commission, 'readonly refusal:', 'readonly statusCode:number,readonly refusal:'],
    [commission, '', '\nfunction shadow(CommissionAbort:any){}\n'],
    [commission, '', "\nfunction outside(){throw new CommissionAbort({ok:false,error:{code:'CONFLICT',message:'forged',status:409}})}\n"],
    [commission, "return unknownCommissionFailure(error, 'create');", 'return {ok:true};'],
  ])('broken wrapper source remains unproven: %s / %s', (file, from, to) => {
    const actual = actualSource(file); if (from) expect(actual).toContain(from);
    const last = from ? actual.lastIndexOf(from) : -1;
    const changed = from ? actual.slice(0, last) + actual.slice(last).replace(from, to) : actual + to;
    expect(wrapperProof(file, changed)).toBeUndefined();
  });
});
describe('original fallback grammar still rejects newly registered 4xx', () => {
  it('literal registered 4xx probe is recognized as bad while a fixed unknown fallback remains safe', () => {
    const declaration = functionSource(domainSource(), 'fallbackHits');
    const script = ts.transpileModule(declaration + '\nfallbackHits(source);', {
      compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const bad = vm.runInNewContext(script, { source: "safeRouteError(error,{fallbackCode:'VALIDATION_FAILED'})" }) as string[];
    expect(bad).toEqual(['VALIDATION_FAILED']); expect(lookupErrorCode(bad[0])?.status).toBe(400);
    const refusal = () => { expect(bad.filter(code => lookupErrorCode(code) && lookupErrorCode(code)!.status < 500)).toEqual([]); };
    expect(refusal).toThrow();
    const safe = vm.runInNewContext(script, { source: "safeRouteError(error,{fallbackCode:'INTERNAL_ERROR'})" }) as string[];
    expect(safe).toEqual(['INTERNAL_ERROR']); expect(lookupErrorCode(safe[0])?.status).toBe(500);
  });
});
