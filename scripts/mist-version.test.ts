import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import webConfig from '../vite.config';
import mistConfig from '../dev-ui-preview/mist-atelier/app/vite.config';
import electronConfig from '../electron.vite.config';
import { mistVersionPlugin, readMistVersion } from './mist-version';

let checkout: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (subject: string) => { git('add', 'source.txt'); git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', subject); };
beforeEach(() => {
  checkout = mkdtempSync(path.join(tmpdir(), 'bambook-mist-version-'));
  git('init', '--quiet'); git('config', 'user.name', 'Version fixture'); git('config', 'user.email', 'version@example.invalid');
  writeFileSync(path.join(checkout, 'source.txt'), 'first'); commit('fixture first');
});
afterEach(() => rmSync(checkout, { recursive: true, force: true }));

describe('shared Mist version metadata', () => {
  it('registers the same version plugin for default Web, Mist and the inherited Electron renderer', async () => {
    const env = { command: 'build' as const, mode: 'production' };
    const web = await (webConfig as any)(env), electron = await (electronConfig as any)(env);
    for (const config of [web, mistConfig, electron.renderer]) {
      expect(config.plugins.flat(Infinity).filter((plugin: any) => plugin?.name === 'mist-version')).toHaveLength(1);
    }
  });

  it('embeds the same build snapshot that it emits even if the checkout changes during bundling', () => {
    const plugin = mistVersionPlugin(checkout) as any;
    const config = plugin.config({}, { command: 'build', mode: 'production' });
    const embedded = JSON.parse(config.define.__MIST_BUILD_VERSION__);
    expect(embedded.commit).toBe(git('rev-parse', '--short', 'HEAD'));
    expect(embedded.subject).toBe('fixture first');
    writeFileSync(path.join(checkout, 'source.txt'), 'next'); commit('fixture next');
    const emitted: any[] = [];
    plugin.generateBundle.call({ emitFile: (asset: any) => emitted.push(asset) });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].fileName).toBe('mist-version.json');
    expect(JSON.parse(emitted[0].source)).toEqual(embedded);
  });

  it('serves fresh Git metadata under a deployment base with no cache and no filesystem exposure', () => {
    const plugin = mistVersionPlugin(checkout) as any;
    expect(plugin.config({}, { command: 'serve', mode: 'development' }).define.__MIST_BUILD_VERSION__).toBe('null');
    let handle: any;
    plugin.configureServer({ config: { base: '/bambook/api/app/' }, middlewares: { use: (middleware: any) => { handle = middleware; } } });
    const headers: Record<string, string> = {}, response: any = { setHeader: (key: string, value: string) => { headers[key] = value; }, end: (body: string) => { response.body = body; } };
    let next = 0;
    handle({ method: 'GET', url: '/bambook/api/app/mist-version.json?fresh=1' }, response, () => next++);
    const first = JSON.parse(response.body);
    expect(first.subject).toBe('fixture first'); expect(headers['Cache-Control']).toBe('no-store');
    writeFileSync(path.join(checkout, 'source.txt'), 'next'); commit('fixture next');
    handle({ method: 'GET', url: '/mist-version.json' }, response, () => next++);
    const second = JSON.parse(response.body);
    expect(second.commit).not.toBe(first.commit); expect(second.subject).toBe('fixture next'); expect(second.startedAt).toBe(first.startedAt);
    handle({ method: 'HEAD', url: '/mist-version.json' }, response, () => next++); expect(response.body).toBeUndefined();
    handle({ method: 'GET', url: '/mist-version.json/source.txt' }, response, () => next++); expect(next).toBe(1);
    handle({ method: 'POST', url: '/mist-version.json' }, response, () => next++); expect(response.statusCode).toBe(405);
    writeFileSync(path.join(checkout, 'source.txt'), 'uncommitted');
    expect(readMistVersion(checkout, 'fixture-start').localChanges).toBe(1);
  });

  it('counts untracked source changes while ignored runtime data contributes no count or names', () => {
    writeFileSync(path.join(checkout, '.git/info/exclude'), 'logs/\nprivate/\ncache/\n');
    for (const directory of ['logs', 'private', 'cache']) {
      mkdirSync(path.join(checkout, directory)); writeFileSync(path.join(checkout, directory, 'runtime-secret.txt'), 'private fixture');
    }
    expect(readMistVersion(checkout, 'fixture-start').localChanges).toBe(0);
    writeFileSync(path.join(checkout, 'new-module.ts'), 'export const untracked = true;');
    const metadata = readMistVersion(checkout, 'fixture-start');
    expect(metadata.localChanges).toBe(1);
    expect(Object.keys(metadata).sort()).toEqual(['branch', 'commit', 'committedAt', 'localChanges', 'startedAt', 'subject']);
    expect(JSON.stringify(metadata)).not.toContain('runtime-secret'); expect(JSON.stringify(metadata)).not.toContain('new-module.ts');
  });
});
