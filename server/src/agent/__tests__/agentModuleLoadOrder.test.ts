/** Actual CommonJS production modules, fresh process and cleared source cache.
 * No registry/service mocks, database calls, remote network or UI claim. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

const sourceRoot = path.resolve(__dirname, '../..');
const serverRoot = path.dirname(sourceRoot);
const repositoryRoot = path.dirname(serverRoot);
let privateRoot: string;
let entryFile: string;

beforeAll(() => {
  privateRoot = fs.mkdtempSync(path.join(process.env.BAMBOOK_ACCEPTANCE_SANDBOX || os.tmpdir(), 'agent-module-load-'));
  const outputRoot = path.join(privateRoot, 'emitted');
  fs.mkdirSync(outputRoot);
  fs.writeFileSync(path.join(outputRoot, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  fs.symlinkSync(path.join(serverRoot, 'node_modules'), path.join(outputRoot, 'node_modules'), 'dir');
  const config = ts.readConfigFile(path.join(serverRoot, 'tsconfig.json'), ts.sys.readFile);
  if (config.error) throw Error('Original server compiler configuration is unreadable');
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, serverRoot);
  if (parsed.options.module !== ts.ModuleKind.CommonJS) throw Error('This control requires the original server CommonJS contract');
  function emit(directory: string) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (item.name === '__tests__' || item.name === 'node_modules') continue;
      const input = path.join(directory, item.name);
      if (item.isDirectory()) { emit(input); continue; }
      if (/\.test\.tsx?$|\.d\.ts$/.test(item.name)) continue;
      const relative = path.relative(sourceRoot, input);
      const output = path.join(outputRoot, relative.replace(/\.ts$/, '.js'));
      fs.mkdirSync(path.dirname(output), { recursive: true });
      if (item.name.endsWith('.ts')) {
        // Emit complete actual modules; no extracted callbacks or injected imports.
        fs.writeFileSync(output, ts.transpileModule(fs.readFileSync(input, 'utf8'), {
          fileName: input, compilerOptions: parsed.options,
        }).outputText);
      } else fs.copyFileSync(input, output);
    }
  }
  emit(sourceRoot);
  entryFile = path.join(privateRoot, 'load.cjs');
  fs.writeFileSync(entryFile, `
const path = require('node:path');
const emitted = path.join(__dirname, 'emitted');
function load(entry) {
  const get = name => require(path.join(emitted, 'agent', name + '.js'));
  if (entry === 'dispatcher-first') get('toolDispatchRegistry');
  if (entry === 'registry-first') get('toolRegistry');
  if (entry === 'runtime-first') get('toolRuntime');
  const query = get('newDomainQueryTools');
  if (entry !== 'runtime-first') query.registerNewDomainQueryTools();
  const dispatcher = get('toolDispatchRegistry'), registry = get('toolRegistry');
  const ids = query.NEW_DOMAIN_QUERY_TOOL_DEFINITIONS.map(item => item.id).sort();
  const registered = dispatcher.getRegisteredToolIds();
  return { definitions: ids.length, catalog: registry.P0B_TOOL_DEFINITIONS.length,
    registeredQueryIds: registered.filter(id => ids.includes(id)).sort(), ids,
    runtimeOrdersRegistered: entry === 'runtime-first' ? registered.includes('orders.query') : null };
}
try {
  const first = load(process.argv[2]);
  const removed = Object.keys(require.cache).filter(file => file.startsWith(emitted + path.sep));
  for (const file of removed) delete require.cache[file];
  const second = load(process.argv[2]);
  console.log('ACTUAL_LOAD_RESULT=' + JSON.stringify({ first, second, removedSourceCacheEntries: removed.length }));
} catch (error) { console.error(error.stack); process.exitCode = 1; }
`);
}, 60000);

afterAll(() => {
  if (privateRoot && path.basename(privateRoot).startsWith('agent-module-load-')) fs.rmSync(privateRoot, { recursive: true, force: true });
});

describe('actual Agent CommonJS import order and source cache reset', () => {
  it.each(['new-domain-first', 'dispatcher-first', 'registry-first', 'runtime-first'])('%s retains the actual query catalog and registered handlers', entry => {
    const guard = path.join(repositoryRoot, 'scripts', 'acceptance-network-guard.cjs');
    const child = spawnSync(process.execPath, ['--require', guard, entryFile, entry], {
      cwd: privateRoot, encoding: 'utf8', timeout: 25000,
      // No inherited API keys, tokens, remote endpoint or real DATABASE_URL.
      env: { PATH: process.env.PATH, TZ: 'UTC', NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://readonly:unused@127.0.0.1:1/NO_DATABASE?schema=public',
        BAMBOOK_ACCEPTANCE_SANDBOX: privateRoot, BAMBOOK_ACCEPTANCE_NO_DATABASE: '1',
        BAMBOOK_NO_SCHEDULER: '1', BAMBOOK_UPLOAD_DIR: path.join(privateRoot, 'uploads'),
      },
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const line = child.stdout.split('\n').find(value => value.startsWith('ACTUAL_LOAD_RESULT='));
    expect(line).toBeTruthy();
    const result = JSON.parse(line!.slice('ACTUAL_LOAD_RESULT='.length));
    expect(result.first.definitions).toBe(13);
    expect(result.first.catalog).toBe(63);
    expect(result.first.registeredQueryIds).toEqual(result.first.ids);
    if (entry === 'runtime-first') expect(result.first.runtimeOrdersRegistered).toBe(true);
    expect(result.removedSourceCacheEntries).toBeGreaterThan(0);
    expect(result.second).toEqual(result.first);
    expect(fs.existsSync(path.join(privateRoot, 'network-denials.jsonl'))).toBe(false);
  });
});
