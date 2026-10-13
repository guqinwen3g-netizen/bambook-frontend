/** Exact source/VM controls over the native QC fingerprint and reader flag.
 * No DB, application factory, writer callback or substituted authority helper. */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { Prisma } from '@prisma/client';
import { assertNativeProof, functionSource, nativeReceiptPath, nativeSourceReview,
  readNativeProof, sourceHash, variableSource } from './utils/nativeMessageProof';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const qcFile = 'server/src/qc/qcService.ts';
const leafFile = 'server/src/qc/qcReportReadProjection.ts';
const authorityFile = 'server/src/qc/qcReportAuthority.ts';
const writerFile = 'server/src/qc/qcScopedService.ts';
const oldQcPin = 'd01b52d0b2f9978859cce17be30f246bac1638e01ce4b3eeaba0608192510638';
const source = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const currentReviewPath = 'artifacts/acceptance-20261001/execution/source-readings/v1-378a21ca-carton-native-source-review.json';
const review = () => JSON.parse(source(currentReviewPath));
function runtime(leaf = source(leafFile)) {
  const ast = ts.createSourceFile(leafFile, leaf, ts.ScriptTarget.Latest, true);
  const bindings: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'contentCurrent') bindings.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast); expect(bindings).toHaveLength(1);
  const flag = bindings[0].parent.parent.getText(ast);
  const javascript = ts.transpileModule([
    functionSource(source(authorityFile), 'qcReportSourceFingerprint'),
    variableSource(leaf, 'QC_REPORT_CONTENT_FIELDS'),
    functionSource(leaf, 'reportContentFingerprint'),
    `async function actualCurrent(tx:any,report:any){${flag}\nreturn contentCurrent;}`,
    '({fingerprint:reportContentFingerprint,current:actualCurrent});',
  ].join('\n'), { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }).outputText;
  return vm.runInNewContext(javascript, { crypto, Prisma }, { timeout: 1000 }) as {
    fingerprint(tx: unknown, report: unknown): Promise<string>; current(tx: unknown, report: unknown): Promise<boolean>;
  };
}
const report = () => ({ id: 'synthetic-qc-current-source', result: 'Passed', inspectionDate: '2026-10-03',
  totalUnits: 100, passedUnits: 100, lotSize: 100, sampleSize: 10, aqlLevel: '2.5', criticalDefects: 0,
  majorDefects: 0, minorDefects: 0, defectSummary: null, notes: '实际源控制', contentFingerprint: '' });
const widths = () => [{ orderLineId: 'synthetic-line', measuredWidthCm: new Prisma.Decimal('149.50'),
  basisWidthCm: new Prisma.Decimal('150.00'), note: null }];
function storage(rows = widths()) {
  const calls: unknown[] = [];
  return { calls, tx: { inspectionWidthMeasurement: { findMany: async (input: unknown) => { calls.push(input); return rows; } } } };
}
describe('current QC source review keeps the original finite native message proof', () => {
  it('current exact source accepts the reviewed pin; restoring the old QC pin rejects the same source', () => {
    const proof = readNativeProof(root);
    expect(Object.keys(proof.receipt.sourceHashes)).toHaveLength(20);
    expect(Object.keys(nativeSourceReview.sourceHashes)).toHaveLength(10);
    expect(proof.receipt.provenSites).toEqual({ 'server/src/finance/proformaInvoiceHttpError.ts': 4,
      'server/src/finance/proformaInvoiceService.ts': 2, 'server/src/internalTrade/internalTransferService.ts': 1 });
    expect(proof.receipt.consumerFiles).toEqual(['server/src/finance/routeV2.ts']);
    expect(() => assertNativeProof(proof.sources, { ...proof.receipt,
      sourceHashes: { ...proof.receipt.sourceHashes, [qcFile]: oldQcPin } })).toThrow(`${qcFile} changed since`);
  });
  it('fresh receipt binds the actual reader import, shared writer fingerprint, canonical producer and immutable original graph', () => {
    const fresh = review();
    expect(sourceHash(source('server/src/shared/__tests__/nativeMessageQcCurrentSource.test.ts'))).toBe(fresh.newTestSHA256);
    expect(nativeSourceReview.currentSourceReviewReceiptPath).toBe(currentReviewPath);
    expect(sourceHash(source(currentReviewPath))).toBe(nativeSourceReview.sourceReviewFreezeSHA256);
    for (const file of [qcFile, leafFile, authorityFile, writerFile]) expect(sourceHash(source(file))).toBe(fresh.currentQcSources[file]);
    expect(sourceHash(source(nativeReceiptPath))).toBe(fresh.originalNativeReceiptSHA256);
    expect(source(qcFile)).toContain("import { attachReportCoverageContext } from './qcReportReadProjection';");
    expect(source(writerFile)).toContain("import { QC_REPORT_CONTENT_FIELDS as REPORT_FIELDS, reportContentFingerprint as contentFingerprint } from './qcReportReadProjection';");
    expect(source(writerFile)).toContain('contentFingerprint: await contentFingerprint(tx, report)');
    expect(source(writerFile)).toContain('report.contentFingerprint !== actualContent');
    expect(source(leafFile)).toContain("from './qcReportAuthority'");
    expect(source(leafFile)).toContain('canBusinessDecide: responsible && isCurrentRevision && coverageCurrent && contentCurrent');
  });
  it('actual persisted content and Decimal widths produce the canonical fingerprint and a current reader flag', async () => {
    const actual = runtime(), row = report(), seam = storage();
    const expected = { result: 'Passed', inspectionDate: '2026-10-03', totalUnits: 100, passedUnits: 100,
      lotSize: 100, sampleSize: 10, aqlLevel: '2.5', criticalDefects: 0, majorDefects: 0, minorDefects: 0,
      defectSummary: null, notes: '实际源控制', widths: [{ orderLineId: 'synthetic-line', measuredWidthCm: '149.5', basisWidthCm: '150', note: null }] };
    const canonical = (input: any): any => Array.isArray(input) ? input.map(canonical) : input && typeof input === 'object'
      ? Object.fromEntries(Object.keys(input).sort().map(key => [key, canonical(input[key])])) : input;
    row.contentFingerprint = crypto.createHash('sha256').update(JSON.stringify(canonical(expected))).digest('hex');
    expect(await actual.fingerprint(seam.tx, row)).toBe(row.contentFingerprint);
    expect(await actual.current(seam.tx, row)).toBe(true);
    expect(seam.calls).toEqual(Array(2).fill({ where: { reportId: row.id }, orderBy: { orderLineId: 'asc' },
      select: { orderLineId: true, measuredWidthCm: true, basisWidthCm: true, note: true } }));
  });
  it('same report IDs with changed actual content or persisted widths are no longer current', async () => {
    const actual = runtime(), row = report(), seam = storage();
    row.contentFingerprint = await actual.fingerprint(seam.tx, row);
    expect(await actual.current(seam.tx, { ...row, notes: '后续内容变更' })).toBe(false);
    const changed = widths(); changed[0].measuredWidthCm = new Prisma.Decimal('151');
    expect(await actual.current(storage(changed).tx, row)).toBe(false);
    expect(await actual.current(seam.tx, row)).toBe(true);
  });
  it('missing or malformed stored content fingerprints never invent a current report or read width storage', async () => {
    const actual = runtime(), seam = storage();
    for (const contentFingerprint of [undefined, null, 1]) expect(await actual.current(seam.tx, { ...report(), contentFingerprint })).toBe(false);
    expect(seam.calls).toEqual([]);
  });
  it('unknown width storage failure with an ordinary known-code shape propagates instead of becoming false or a valid fingerprint', async () => {
    const actual = runtime(), row = report(), seam = storage(); row.contentFingerprint = await actual.fingerprint(seam.tx, row);
    const error = Object.assign(new Error('SQL private_qc_width /internal/path'), { code: 'CONFLICT', statusCode: 409 });
    const broken = { inspectionWidthMeasurement: { findMany: async () => { throw error; } } };
    await expect(actual.fingerprint(broken, row)).rejects.toBe(error);
    await expect(actual.current(broken, row)).rejects.toBe(error);
  });
  it('a rehashed QC pin cannot cover a changed imported leaf; removing the real current comparison makes the width countercontrol observable', async () => {
    const original = source(leafFile), fresh = review(), actual = runtime(), row = report(), seam = storage();
    row.contentFingerprint = await actual.fingerprint(seam.tx, row);
    const widened = original.replace('report.contentFingerprint === await reportContentFingerprint(tx, report)', 'true');
    expect(widened).not.toBe(original); expect(sourceHash(widened)).not.toBe(fresh.currentQcSources[leafFile]);
    const changed = widths(); changed[0].measuredWidthCm = new Prisma.Decimal('151');
    expect(await runtime(widened).current(storage(changed).tx, row)).toBe(true);
    expect(await actual.current(storage(changed).tx, row)).toBe(false);
  });
});
