/** Fixed-source evidence only. Runs the existing source scanner and the pure
 * bizStatus keyword meter. Never imports the backend app, Prisma or DB setup. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { isCliEntry } from './lib/acceptance-selfcheck.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE = 'artifacts/acceptance-20261001/execution/source-readings';
const G3_BEFORE = '17a9358996049597620e746811de1df30454e970';
const B131_BEFORE = 'b7586f0515c6f9d2d05c8925bf0ced93992e8c05';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const readArchive = file => JSON.parse(gunzipSync(fs.readFileSync(path.join(ROOT, EVIDENCE, file))));
const gitText = (head, file) => execFileSync('git', ['show', `${head}:${file}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });

/** Match multisets, not sets: two equal producer expressions are two facts.
 * Locator changes are retained separately rather than claimed as debt removal. */
export function compareRows(before, after, keyOf) {
  const pending = new Map();
  for (const row of before) { const key = keyOf(row), rows = pending.get(key) ?? []; rows.push(row); pending.set(key, rows); }
  const added = [], unchanged = [], moved = [];
  for (const row of after) {
    const rows = pending.get(keyOf(row));
    if (!rows?.length) { added.push(row); continue; }
    const prior = rows.shift(); unchanged.push({ before: prior, after: row });
    if (prior.line !== row.line || prior.start !== row.start) moved.push({ before: prior, after: row });
  }
  return { added, removed: [...pending.values()].flat(), moved, unchanged };
}
export const inventoryKey = row => JSON.stringify([row.file, row.origin, row.kind, row.contract, row.message, row.code, row.expression, row.reason]);
export const g3Key = row => JSON.stringify([row.file, row.shape, row.matched, row.cls, row.rule, row.sourceLine.trim()]);

function walkSources(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['__tests__', 'node_modules', 'dist'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walkSources(file, files);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) files.push(file);
  }
  return files.sort();
}
function keywordMeter(snapshot, readSource = rel => fs.readFileSync(path.join(snapshot, 'server/src', rel), 'utf8')) {
  // Only these two verified pure modules are evaluated; all other require calls
  // fail closed. The actual statusFromError implementation is the sole meter.
  const cache = new Map();
  const load = rel => {
    if (!['shared/bizStatus.ts', 'shared/errorCodes.ts'].includes(rel)) throw new Error(`Non-pure module refused: ${rel}`);
    if (cache.has(rel)) return cache.get(rel).exports;
    const module = { exports: {} }; cache.set(rel, module);
    const source = readSource(rel);
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const requirePure = name => { if (rel === 'shared/bizStatus.ts' && name === './errorCodes') return load('shared/errorCodes.ts'); throw new Error(`Non-pure import refused: ${name}`); };
    vm.runInThisContext(`(function(exports,require,module){${code}\n})`, { filename: rel })(module.exports, requirePure, module);
    return module.exports;
  };
  return load('shared/bizStatus.ts').statusFromError;
}
const histogram = rows => rows.reduce((out, row) => { out[row.tier] = (out[row.tier] ?? 0) + 1; return out; }, {});
async function collectB131(head, snapshot) {
  const scannerFile = path.join(snapshot, 'scripts/lib/tierMessageSources.mjs');
  const scanner = await import(pathToFileURL(scannerFile));
  const files = walkSources(path.join(snapshot, 'server/src'));
  const entries = files.map(file => ({ file: path.relative(path.join(snapshot, 'server'), file).split(path.sep).join('/'), src: fs.readFileSync(file, 'utf8') }));
  const tier = keywordMeter(snapshot), report = scanner.scanTierMessageSources(entries);
  const corpus = rows => rows.map(row => ({ ...row, tier: tier(new Error(row.message.trim())) }));
  const literals = corpus(report.publicLiterals), legacy = corpus(scanner.legacyTierMessageSources(entries));
  return { sourceHead: head, scope: 'Immutable production source inventory; message keyword tiers are not typed HTTP or business execution proof.',
    measurement: scanner.TIER_MESSAGE_MEASUREMENT, scannerSha256: sha(fs.readFileSync(scannerFile)),
    keywordMeterSha256: sha(fs.readFileSync(path.join(snapshot, 'server/src/shared/bizStatus.ts'))),
    sourceFiles: entries.map(entry => ({ file: entry.file, sha256: sha(entry.src) })),
    keywordCount: literals.length, byTier: histogram(literals), legacyCount: legacy.length, legacyByTier: histogram(legacy),
    accounting: report.accounting, literals, report };
}
function enrichG3(report, readSource) {
  const sources = new Map();
  return { ...report, hits: report.hits.map(row => {
    if (!sources.has(row.file)) sources.set(row.file, readSource(row.file).split('\n'));
    const lines = sources.get(row.file), index = row.line - 1;
    return { ...row, sourceLine: lines[index] ?? '', sourceContext: lines.slice(Math.max(0, index - 3), index + 4).join('\n') };
  }) };
}
export async function collect(head) {
  if (!/^[a-f0-9]{40}$/.test(head ?? '')) throw new Error('Pass one exact 40-character committed source HEAD.');
  if (execFileSync('git', ['rev-parse', `${head}^{commit}`], { cwd: ROOT, encoding: 'utf8' }).trim() !== head) throw new Error('Source HEAD must resolve exactly.');
  const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), 'bambook-source-guards-'));
  try {
    const roots = ['server/src', 'components', 'services', 'utils', 'lib', 'customer-portal/src', 'App.tsx', 'index.tsx', 'types.ts', 'appTheme.ts',
      'scripts/check-fail-open-inventory.mjs', 'scripts/baselines/g3-fail-open.json', 'scripts/lib/tierMessageSources.mjs'];
    const archive = execFileSync('git', ['archive', head, ...roots], { cwd: ROOT, maxBuffer: 80 * 1024 * 1024 });
    const extracted = spawnSync('tar', ['-xf', '-', '-C', snapshot], { input: archive, encoding: 'utf8' });
    if (extracted.status !== 0) throw new Error(`Fixed source extraction failed: ${extracted.stderr}`);
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(snapshot, 'node_modules'), 'dir');
    const meter = spawnSync(process.execPath, [path.join(snapshot, 'scripts/check-fail-open-inventory.mjs'), '--json', '--baseline'],
      { cwd: snapshot, encoding: 'utf8', maxBuffer: 25 * 1024 * 1024, timeout: 180_000 });
    if (meter.error || ![0, 1].includes(meter.status)) throw meter.error ?? new Error(`G3 scanner failed: ${meter.stderr}`);
    const g3 = enrichG3(JSON.parse(meter.stdout), file => fs.readFileSync(path.join(snapshot, file), 'utf8'));
    const priorG3 = enrichG3(readArchive('v1-g3-native-order.inventory.json.gz'), file => gitText(G3_BEFORE, file));
    const g3Delta = compareRows(priorG3.hits, g3.hits, g3Key);
    const b131 = await collectB131(head, snapshot), priorB131 = readArchive('v1-b758-message-source.inventory.json.gz');
    const priorTier = keywordMeter(null, rel => gitText(B131_BEFORE, `server/src/${rel}`));
    const beforeLiterals = priorB131.report.publicLiterals.map(row => ({ ...row, tier: priorTier(new Error(row.message.trim())) }));
    const literalKey = row => `${row.file}|${row.message.trim()}`;
    const literalDelta = compareRows(beforeLiterals, b131.literals, literalKey);
    const sourceDelta = compareRows(priorB131.report.inventory, b131.report.inventory, inventoryKey);
    const publicStatusChanges = literalDelta.unchanged.filter(pair => pair.before.tier !== pair.after.tier);
    const b131Adjudication = { kind: 'Source inventory refresh, not runtime or business debt clearance.', beforeHead: B131_BEFORE, afterHead: head,
      measurement: b131.measurement, keywordMeterChanged: sha(gitText(B131_BEFORE, 'server/src/shared/bizStatus.ts')) !== b131.keywordMeterSha256,
      scannerChanged: sha(gitText(B131_BEFORE, 'scripts/lib/tierMessageSources.mjs')) !== b131.scannerSha256,
      before: { count: priorB131.keywordCount, byTier: priorB131.byTier, accounting: priorB131.accounting },
      after: { count: b131.keywordCount, byTier: b131.byTier, accounting: b131.accounting },
      literalChanges: { added: literalDelta.added, removed: literalDelta.removed, moved: literalDelta.moved, changedTier: publicStatusChanges },
      sourceChanges: { added: sourceDelta.added, removed: sourceDelta.removed, moved: sourceDelta.moved },
      unresolvedRemain: b131.report.unresolved, classificationBoundary: 'Typed, private/internal and unproved/dynamic sources retain existing classifications; no new exemption or production throw edit.' };
    const g3Adjudication = { kind: 'Unchanged G3 source meter, lossless old/new hit differences; no business closure claim.', beforeHead: G3_BEFORE, afterHead: head,
      scannerSha256: sha(fs.readFileSync(path.join(snapshot, 'scripts/check-fail-open-inventory.mjs'))),
      scannerChanged: sha(gitText(G3_BEFORE, 'scripts/check-fail-open-inventory.mjs')) !== sha(fs.readFileSync(path.join(snapshot, 'scripts/check-fail-open-inventory.mjs'))),
      before: priorG3.totals, after: g3.totals, capsUnchanged: g3.baseline, targetLA: g3.target.la, targetMet: g3.totals['L-A'] === g3.target.la,
      added: g3Delta.added, removed: g3Delta.removed, moved: g3Delta.moved,
      boundary: 'A removed syntactic hit does not independently prove corrected business behavior. Added financial/inventory hits require source adjudication; cap slack is not debt clearance.' };
    const prefix = `v1-${head.slice(0, 8)}`;
    const outputs = [[`${prefix}-g3.inventory.json.gz`, { sourceHead: head, ...g3 }], [`${prefix}-g3.adjudication.json.gz`, g3Adjudication],
      [`${prefix}-message-source.inventory.json.gz`, b131], [`${prefix}-message-source.adjudication.json.gz`, b131Adjudication]];
    const archives = outputs.map(([file, value]) => { const raw = jsonBytes(value), bytes = gzipSync(raw, { level: 9 });
      fs.writeFileSync(path.join(ROOT, EVIDENCE, file), bytes); return { path: `${EVIDENCE}/${file}`, sha256: sha(bytes), uncompressedSha256: sha(raw), bytes: bytes.length }; });
    const summary = { sourceHead: head, sourceIsCommittedSnapshot: true, evidenceBoundary: 'Source only; no DB, app, HTTP, UI or functional acceptance execution.',
      g3: { before: priorG3.totals, after: g3.totals, added: g3Delta.added.length, removed: g3Delta.removed.length,
        addedLA: g3Delta.added.filter(row => row.cls === 'L-A'), removedLA: g3Delta.removed.filter(row => row.cls === 'L-A'),
        cap: g3.baseline, target: g3.target, targetMet: g3Adjudication.targetMet, filesScanned: g3.filesScanned, missing: g3.missing, exitCode: meter.status },
      b131: { before: b131Adjudication.before, after: b131Adjudication.after, literalsAdded: literalDelta.added.length,
        literalsRemoved: literalDelta.removed.length, changedTier: publicStatusChanges.length, inventoryAdded: sourceDelta.added.length,
        inventoryRemoved: sourceDelta.removed.length, scannerChanged: b131Adjudication.scannerChanged, keywordMeterChanged: b131Adjudication.keywordMeterChanged }, archives };
    fs.writeFileSync(path.join(ROOT, EVIDENCE, `${prefix}-g3-b131.json`), jsonBytes(summary));
    return summary;
  } finally { fs.rmSync(snapshot, { recursive: true, force: true }); }
}
if (isCliEntry(import.meta.url)) {
  const summary = await collect(process.argv[2]);
  console.log(JSON.stringify({ sourceHead: summary.sourceHead, g3: { ...summary.g3, addedLA: summary.g3.addedLA.length, removedLA: summary.g3.removedLA.length }, b131: summary.b131, archives: summary.archives }, null, 2));
}
