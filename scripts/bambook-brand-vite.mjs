import path from 'node:path';
import { readFileSync } from 'node:fs';

const palettes = ['mist', 'deep', 'mono'];
const forms = ['solid', 'outline', 'strands', 'mist'];
export const brandAssetNames = [
  ...palettes.flatMap(palette => forms.map(form => `bambook-v3-${palette}-${form}.svg`)),
  'bambook-v3-mark.svg', 'bambook-v3-mark-light.svg',
  'bambook-v3-app.svg', 'bambook-v3-app-32.png',
  'bambook-v3-favicon.svg', 'bambook-v3-favicon-32.png',
];

/** Explicit host integration, leaving upstream generic UI and legal identity intact. */
export function createBambookBrandPlugin({ root, designSystemSource }) {
  const adapter = path.join(root, 'components/brand/agentBrand.tsx');
  const targets = new Set(['OpenBitFunMark', 'OpenBitFunBrandMotion'].map(name =>
    path.join(designSystemSource, 'brand', name)));
  const asset = name => readFileSync(path.join(root, 'public/brand', name));
  let building = false;
  return {
    name: 'bambook-brand-integration', enforce: 'pre',
    configResolved(config) { building = config.command === 'build'; },
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.')) return;
      const resolved = path.resolve(path.dirname(importer.split('?')[0]), source).replace(/\.tsx$/, '');
      if (targets.has(resolved)) return adapter;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url || '/', 'http://localhost').pathname;
        const name = pathname.startsWith('/brand/') ? pathname.slice('/brand/'.length) : '';
        if (!brandAssetNames.includes(name)) return next();
        if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
        response.setHeader('Content-Type', name.endsWith('.png') ? 'image/png' : 'image/svg+xml');
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.end(request.method === 'HEAD' ? undefined : asset(name));
      });
    },
    buildStart() {
      if (building) for (const name of brandAssetNames) this.emitFile({type:'asset', fileName:`brand/${name}`, source:asset(name)});
    },
  };
}
