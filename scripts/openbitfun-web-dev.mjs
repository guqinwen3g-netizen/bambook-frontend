import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { ensureBambookOverlayIntegration } from './openbitfun-overlay-integration.mjs';
import { ensureBambookInitialThemeIntegration } from './openbitfun-initial-theme-integration.mjs';
import { OPENBITFUN_REVISION, runtimeHealth } from './openbitfun-runtime.mjs';

const parents = ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:4173', 'http://127.0.0.1:4173'];

// Only a source-serving frontend: no credentials, filesystem RPC or business IPC.
export async function createWebDevHost({ webRoot, port = 1422, hmrPort = 1421, configFile = path.join(webRoot, 'vite.config.ts'), cacheDir, getStatus, plugins = [] }) {
  if (![port, hmrPort].every(value => Number.isInteger(value) && value >= 1024 && value <= 65535) || port === hmrPort) {
    throw new Error('Invalid OpenBitFun development ports');
  }
  await ensureBambookOverlayIntegration(webRoot, { optional: true, recordBasePatch: true });
  await ensureBambookInitialThemeIntegration(webRoot, { optional: true });
  const url = `http://127.0.0.1:${port}`;
  const allowedOrigins = new Set([...parents, url, `http://localhost:${port}`]);
  const require = createRequire(path.join(webRoot, 'package.json'));
  const viteEntry = path.join(path.dirname(require.resolve('vite/package.json')), 'dist/node/index.js');
  const { createServer } = await import(pathToFileURL(viteEntry).href);
  const server = await createServer({
    root: webRoot, configFile, cacheDir, mode: 'web',
    plugins: [{
      name: 'bambook-local-dev-boundary', enforce: 'pre',
      configResolved(config) {
        // Array merging otherwise retains upstream's **/apps/** exclusion,
        // which matches every source file under Claw/apps/Bambook.
        config.server.watch.ignored = ['**/target/**', '**/.git/**', '**/dist/**'];
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)
              || (req.headers.origin && !allowedOrigins.has(req.headers.origin))) {
            res.writeHead(403).end(); return;
          }
          if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Referrer-Policy', 'no-referrer');
          res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${parents.join(' ')} file:`);
          res.setHeader('Cache-Control', 'no-store');
          if (req.url !== '/bambook/status') { next(); return; }
          const origin = req.headers.origin;
          if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
          res.setHeader('Content-Type', 'application/json');
          try { res.end(JSON.stringify(await getStatus())); }
          catch { res.writeHead(503).end(JSON.stringify({ state: 'stopped', url })); }
        });
      },
    }, ...plugins],
    server: {
      host: '127.0.0.1', port, strictPort: true,
      allowedHosts: ['127.0.0.1', 'localhost'],
      cors: { origin: [...allowedOrigins] },
      hmr: { host: '127.0.0.1', port: hmrPort },
      // Never allow Vite's source watcher to scan bundled runtime/workspaces.
      watch: { ignored: ['**/target/**', '**/.git/**', '**/dist/**'] },
    },
  });
  try { await server.listen(); }
  catch (error) { await server.close(); throw error; }
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const webRoot = path.resolve(process.argv[2]);
  const port = Number(process.env.OPENBITFUN_DEV_PORT || 1422);
  const hmrPort = Number(process.env.OPENBITFUN_DEV_HMR_PORT || 1421);
  const url = `http://127.0.0.1:${port}`;
  let server, cancelled = false;
  const stop = () => {
    cancelled = true;
    // Vite can leave an optimizer-close promise pending during first startup.
    // This CLI is launched in a guarded owned group; exiting the parent also
    // makes that guard clean up any remaining workers, before its 1s deadline.
    const deadline = setTimeout(() => process.exit(0), 750);
    void server?.close().then(() => { clearTimeout(deadline); process.exit(0); }, () => process.exit(1));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    server = await createWebDevHost({ webRoot, port, hmrPort,
      getStatus: async () => ({ state: await runtimeHealth() ? 'ready' : 'starting', url, revision: OPENBITFUN_REVISION }),
    });
    if (cancelled) await server.close();
    else console.log(`[openbitfun:dev] Vite HMR ready at ${url}`);
  } catch (error) { console.error(`[openbitfun:dev] ${error.message}`); process.exitCode = 1; }
}
