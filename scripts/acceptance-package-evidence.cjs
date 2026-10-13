// Lossless local evidence packaging. Never changes test verdicts or connects to DB.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const execution = path.resolve(__dirname, '../artifacts/acceptance-20261001/execution');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const completedOnly = process.argv.length === 3 && process.argv[2] === '--completed-only';
if (process.argv.length !== 2 && !completedOnly) throw Error('Use --completed-only to defer active runs');
for (const kind of ['runs', 'frontend-runs']) {
const base = path.join(execution, kind);
if (!fs.existsSync(base)) continue;
for (const name of fs.readdirSync(base).sort()) {
  const directory = path.join(base, name);
  const resultPath = path.join(directory, 'result.json');
  if (!fs.existsSync(resultPath)) continue;
  const original = fs.readFileSync(resultPath);
  const result = JSON.parse(original);
  if (!result.finishedAt) {
    if (completedOnly) { console.log(JSON.stringify({ run: name, archived: false, reason: 'Active run deferred' })); continue; }
    throw Error('Cannot package an active run: ' + name);
  }
  // Frontend runs provision no PostgreSQL cluster. Do not manufacture backend
  // teardown evidence for them; archive only their original finished verdict.
  if (kind === 'runs' && result.postgresStopped !== true) {
    // A pre-provision typecheck failure has no recorded PG teardown. Preserve
    // its full original evidence without manufacturing a stopped-database fact.
    if (result.status === 'blocked' && result.postgresStopped === undefined) {
      console.log(JSON.stringify({ run: name, archived: false, reason: 'No confirmed PostgreSQL teardown; original evidence retained' }));
      continue;
    }
    throw Error('Cannot package a run without confirmed PG teardown: ' + name);
  }
  if (result.evidenceArchive) {
    for (const file of result.evidenceArchive.files) {
      const bytes = fs.readFileSync(path.join(directory, file.archive));
      if (sha(bytes) !== file.archiveSha256 || sha(zlib.gunzipSync(bytes)) !== file.originalSha256) throw Error('Evidence changed: ' + file.archive);
    }
    continue;
  }
  const files = [];
  for (const [source, archive] of [['result.json', 'result.original.json.gz'], ['vitest.json', 'vitest.json.gz'], ['run.log', 'run.log.gz']]) {
    const sourcePath = path.join(directory, source);
    if (!fs.existsSync(sourcePath)) continue;
    const bytes = fs.readFileSync(sourcePath);
    const packed = zlib.gzipSync(bytes, { level: 9 });
    const archivePath = path.join(directory, archive);
    fs.writeFileSync(archivePath, packed);
    if (!zlib.gunzipSync(fs.readFileSync(archivePath)).equals(bytes)) throw Error('Non-lossless archive: ' + archive);
    files.push({ source, archive, originalSha256: sha(bytes), archiveSha256: sha(packed), originalBytes: bytes.length });
  }
  // Detailed assertions remain byte-for-byte in both original JSON and Vitest.
  delete result.assertions;
  result.evidenceArchive = { method: 'gzip; original bytes and SHA256 verified', files };
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n');
  for (const file of ['vitest.json', 'run.log']) if (files.some(item => item.source === file)) fs.unlinkSync(path.join(directory, file));
  console.log(JSON.stringify({ run: name, files: files.length, originalBytes: files.reduce((n, f) => n + f.originalBytes, 0) }));
}
}
