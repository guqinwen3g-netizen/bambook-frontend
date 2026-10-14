/// <reference types="vitest" />
import path from 'path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { mistVersionPlugin } from './scripts/mist-version';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const uiMode = process.env.VITE_UI_MODE || 'desktop';
  const isUiLabDev = process.env.BAMBOOK_UI_LAB_DEV === '1';
  const port = uiMode === 'mobile' ? 3001 : 3000;

  /** 与 dev 共用；`vite preview` 默认会继承 server.proxy，此处显式写入避免歧义 */
  const proxy = {
    '/api/zhipu': {
      target: 'https://open.bigmodel.cn/api/paas/v4',
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/api\/zhipu/, ''),
      secure: false
    },
    '/api/openai': {
      target: 'http://127.0.0.1:8045/v1',
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/api\/openai/, ''),
      secure: false
    },
    '/api/searx': {
      target: 'https://searx.be',
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/api\/searx/, ''),
      secure: false,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    },
    // 本地 Web 开发/浏览器模拟测试：配合 VITE_API_BASE_URL=/api 将业务 API
    // 代理到本地 8081 后端（zhipu/openai/searx 等更具体的 key 在前，优先匹配）。
    '/api': {
      // ★ v3.87：目标可配（默认仍是 8081 ⇒ 行为不变）。
      //   用途：把主线分支的成果接给走查环境 —— 另起一个后端实例（别的端口）时，
      //   用 VITE_API_PROXY_TARGET 指过去，不必动本机正在跑的那个 8081。
      target: process.env.VITE_API_PROXY_TARGET || 'http://localhost:8081',
      changeOrigin: true,
      secure: false,
    },

  } as const;

  // When building for web deployment behind the Cloudflare Tunnel
  // (https://jiangsupanda.com/bambook/api/app/), assets must be referenced
  // relative to that mount path, not the root. Set BAMBOOK_WEB_DEPLOY=1
  // before `npm run build` to switch to the deployed base path. Electron
  // and dev mode keep the default '/'. Override with BAMBOOK_WEB_BASE if
  // the public path ever changes.
  // /bambook/api/app/ reuses the existing /bambook/api Cloudflare Tunnel ingress
  // (server strips the /bambook prefix; webapp mounted at /api/app).
  // BAMBOOK_WEB_SUBDOMAIN=1：子域名入口（https://bambook.jiangsupanda.com/）
  // 根路径直挂 webapp，API 同域相对路径（VITE_API_BASE_URL=/api），base 回到 '/'。
  const webBase = process.env.BAMBOOK_WEB_BASE
    || (process.env.BAMBOOK_WEB_SUBDOMAIN === '1' ? '/'
      : (process.env.BAMBOOK_WEB_DEPLOY === '1' ? '/bambook/api/app/' : '/'));

  return {
    base: webBase,
    server: {
      port,
      // 2026-09-02 修复：端口被占时直接报错退出，而不是静默漂移到 +1 端口。
      // 之前 npm run dev 在旧实例未杀时悄悄换到 3001，浏览器/Electron 仍连
      // 3000 的旧实例，且双实例共享 node_modules/.vite 依赖缓存互相作废
      // 模块图 → "Failed to fetch dynamically imported module: App.tsx"。
      strictPort: true,
      host: '0.0.0.0',
      proxy,
      watch: {
        // The embedded Agent owns its own source watcher. Do not recursively
        // watch its checkout/runtime or generated evidence from the host Vite.
        ignored: [
          '**/out/**',
          '**/tmp/**',
          '**/artifacts/**',
          '**/docs/acceptance/evidence/**',
          '**/docs/design-system/evidence/**',
          '**/design-frontend/**',
          ...(isUiLabDev ? ['**/pwa/**', '**/public/pwa-icon.svg'] : []),
        ],
      },
    },
    preview: {
      port: 4173,
      host: '0.0.0.0',
      proxy
    },
    plugins: [react(), mistVersionPlugin(repoRoot)],
    define: {
      'import.meta.env.VITE_UI_MODE': JSON.stringify(uiMode)
    },
    resolve: {
      alias: {
        '@': repoRoot,
      }
    },
    optimizeDeps: {
      entries: ['index.html', 'dev-panda-lab.html'],
      exclude: ['winston']
    },
    build: {
      // Bundles can be large in this Electron app — disk delivery, no CDN.
      chunkSizeWarningLimit: 2500,
      // NOTE: Previously had a manualChunks() config that split React /
      // three / charts / etc into named vendor chunks. It produced
      // "Circular chunk" warnings at build time (vendor-react ↔ vendor ↔
      // vendor-three) and at runtime crashed the production preview with
      //   Uncaught TypeError: Cannot read properties of undefined
      //                       (reading 'useLayoutEffect')
      // because vendor-three loaded before vendor-react. Rollup's auto
      // chunking handles this correctly out of the box; the manual split
      // gave only a marginal caching benefit (this is an Electron app, no
      // CDN cache) and was not worth the breakage. Removed.
    },
    test: {
      setupFiles: ['./test/browserSetup.ts'],
      // 默认 node 环境：套件以源码契约测试（readFileSync + import.meta.url 定位）为主，
      // jsdom 会把 import.meta.url 改写为 http:// 导致 fs 读取全部失败。
      // 个别需浏览器语义的测试文件用 `// @vitest-environment jsdom` 文件级声明开启。
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/out/**',
        '**/archive/**',
        '**/.{idea,git,cache,output,temp}**',
        // server/ 为独立 vitest 套件（需 DATABASE_URL 等后端环境），cd server && npx vitest run
        'server/**',
        // 固定验收证据包含原测试副本，不能作为当前源码再次执行。
        'artifacts/**',
        'docs/acceptance/evidence/**',
        // Private runtime snapshots and temporary candidate checkouts are not active source tests.
        'tmp/**',
        // 未跟踪的设计探索资产，非交付面
        'design-lab/**',
        // 完整复制的设计前端有独立运行时；其中历史测试路径指向副本外的服务端，不属于主应用测试集。
        'design-frontend/**',
      ]
    },
  };
});
