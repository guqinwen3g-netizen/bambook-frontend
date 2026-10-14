import { execFileSync } from 'node:child_process';
import type { Plugin } from 'vite';
import type { MistVersion } from '../dev-ui-preview/mist-atelier/app/runtime/versionData';

/** Read only Git metadata from the checkout that owns the running frontend. */
export function readMistVersion(repoRoot: string, startedAt: string): MistVersion {
  const git = (...args: string[]) => {
    try { return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { return ''; }
  };
  const [commit = '', committedAt = '', subject = ''] = git('log', '-1', '--format=%h%n%cI%n%s').split('\n');
  const changed = git('status', '--porcelain', '--untracked-files=all').split('\n').filter(line => line.trim());
  return { commit, committedAt, subject, branch: git('rev-parse', '--abbrev-ref', 'HEAD'), localChanges: changed.length, startedAt };
}

/** All Web/Mist/Electron builds embed and emit the same snapshot; dev requests read Git afresh. */
export function mistVersionPlugin(repoRoot: string): Plugin {
  const startedAt = new Date().toISOString();
  let buildVersion: MistVersion | null = null;
  return {
    name: 'mist-version',
    config(_config, env) {
      buildVersion = env.command === 'build' ? readMistVersion(repoRoot, startedAt) : null;
      return { define: { __MIST_BUILD_VERSION__: JSON.stringify(buildVersion) } };
    },
    configureServer(server) {
      const resource = `${server.config.base}mist-version.json`;
      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url || '/', 'http://mist.local').pathname;
        if (pathname !== resource && pathname !== '/mist-version.json') { next(); return; }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.statusCode = 405; res.setHeader('Allow', 'GET, HEAD'); res.end(); return;
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify(readMistVersion(repoRoot, startedAt)));
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'mist-version.json', source: JSON.stringify(buildVersion ?? readMistVersion(repoRoot, startedAt)) });
    },
  };
}
