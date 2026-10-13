'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const prefixes = ['components/', 'contexts/', 'hooks/', 'lib/', 'services/', 'styles/', 'utils/', 'src/', 'types/',
  'assets/', 'public/', 'pwa/', 'test-fixtures/', 'electron/', 'preload/', 'renderer/', 'desktop/', 'design-frontend/',
  'server/src/', 'server/ops-panel/src/', 'server/acceptance-tests/', 'server/scripts/', 'scripts/', 'docs/design/'];
function isSource(relative) {
  if (path.isAbsolute(relative) || relative.split('/').some(part => part === '..')) return false;
  // These two checked-in dictionaries are frontend source, not runtime data.
  if (['data/compositionTerms.ts', 'data/sttCustomTerms.ts', 'design-frontend/data/compositionTerms.ts', 'design-frontend/data/sttCustomTerms.ts'].includes(relative)) return true;
  if (relative.split('/').some(part => ['node_modules', '.git', 'dist', 'out', 'uploads', 'data', '.cache', '.vite'].includes(part))) return false;
  if (/(?:^|\/)\.env(?:\.|$)|\.(?:db|sqlite|sqlite3|pem|key)$/i.test(relative)) return false;
  if (relative.startsWith('server/prisma/')) return relative.endsWith('.prisma') || /^server\/prisma\/migrations\/[^/]+\/migration\.sql$/.test(relative);
  if (prefixes.some(prefix => relative.startsWith(prefix))) return true;
  if (/^server\/[^/]+\.(?:json|ts|mts|js|cjs)$/.test(relative)) return true;
  return !relative.includes('/') && /\.(?:tsx?|mts|js|mjs|cjs|json|html|css|svg)$/.test(relative);
}

/** Capture current source without a commit/reset or copying any existing DB/env.
 * A second read rejects a source changing during capture. The manifest binds
 * evidence to these bytes, not to the old Git HEAD or subsequent worker edits. */
function captureWorkingSource({ repo, workspace, relativeFiles, extraFiles = [] }) {
  if (fs.existsSync(workspace)) throw Error('Working-source destination must be fresh');
  const files = [...new Set(relativeFiles.filter(isSource).concat(extraFiles))].sort();
  const contents = new Map();
  for (const relative of files) {
    if (path.isAbsolute(relative) || relative.split('/').includes('..')) throw Error('Source path escapes repository');
    const absolute = path.join(repo, relative), stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Source snapshot requires regular repository files: ' + relative);
    contents.set(relative, fs.readFileSync(absolute));
  }
  fs.mkdirSync(workspace, { mode: 0o700 });
  for (const [relative, bytes] of contents) {
    const target = path.join(workspace, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' });
  }
  const hashes = Object.fromEntries([...contents].map(([relative, bytes]) => [relative, sha(bytes)]));
  for (const [relative, hash] of Object.entries(hashes)) {
    if (sha(fs.readFileSync(path.join(repo, relative))) !== hash) throw Error('Source changed during capture; retry when workers are between writes: ' + relative);
  }
  return { kind: 'current-working-source', sha256: sha(JSON.stringify(hashes)), files: hashes,
    boundary: 'Hashed private source snapshot; existing databases, environment files and generated dependencies excluded. Subsequent source changes require another snapshot.' };
}
module.exports = { captureWorkingSource, isSource };
