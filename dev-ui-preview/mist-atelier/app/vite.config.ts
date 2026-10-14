import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import type { Plugin } from 'vite';

const repoRoot = path.resolve(__dirname, '../../..');
/** 读取当前仓库版本：开发时每次请求实时读取（自动拉取后无需重启），构建时写入 mist-version.json。 */
function readMistVersion(startedAt: string) {
  const git = (...args: string[]) => { try { return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
  const [commit = '', committedAt = '', subject = ''] = git('log', '-1', '--format=%h%n%cI%n%s').split('\n');
  const changed = git('status', '--porcelain', '--untracked-files=no').split('\n').filter(line => line.trim() && !/server\/logs\//.test(line));
  return { commit, committedAt, subject, branch: git('rev-parse', '--abbrev-ref', 'HEAD'), localChanges: changed.length, startedAt };
}
function mistVersionPlugin(): Plugin {
  const startedAt = new Date().toISOString();
  return {
    name: 'mist-version',
    configureServer(server) {
      server.middlewares.use('/mist-version.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(readMistVersion(startedAt)));
      });
    },
    generateBundle() { this.emitFile({ type: 'asset', fileName: 'mist-version.json', source: JSON.stringify(readMistVersion(startedAt)) }); },
  };
}
/**
 * Mist Atelier 参考应用（独立构建，不影响主应用）。
 *   开发：npx vite --config dev-ui-preview/mist-atelier/app/vite.config.ts   → http://localhost:3130
 *   构建：npx vite build --config dev-ui-preview/mist-atelier/app/vite.config.ts
 */
export default defineConfig({
  root: __dirname,
  publicDir: path.resolve(__dirname, '../../../public'),
  plugins: [react(), mistVersionPlugin()],
  resolve: { alias: { '@': path.resolve(__dirname, '../../..') } },
  cacheDir: '/tmp/bambook-mist-vite-cache',
  server: {
    port: 3130, host: true, fs: { allow: [path.resolve(__dirname, '../../..')] },
    proxy: {
      '/api/mist': { target: 'http://127.0.0.1:8082', changeOrigin: true },
      '/api': { target: 'http://127.0.0.1:8082', changeOrigin: true },
    },
    // Native file events are unavailable to this desktop execution environment.
    watch: { usePolling: true, interval: 250 },
  },
  build: { outDir: '/tmp/bambook-mist-build', emptyOutDir: true, assetsInlineLimit: 100000000, cssCodeSplit: false },
});
