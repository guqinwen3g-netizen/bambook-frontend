// 把参考应用打成一个可双击打开的 HTML（所有 JS/CSS/图片/字体内联）。
//   node dev-ui-preview/mist-atelier/app/build-single.mjs [输出路径]
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname);
const out = process.argv[2] || path.join(here, '..', 'bambook-mist-atelier-reference.html');
execSync(`npx vite build --config ${path.join(here, 'vite.config.ts')}`, { stdio: 'inherit', cwd: path.join(here, '../../..') });
const dist = '/tmp/bambook-mist-build';
let html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
html = html.replace(/<script type="module" crossorigin src="([^"]+)"><\/script>/, (_, src) => '');
html = html.replace(/<link rel="stylesheet" crossorigin href="([^"]+)">/, (_, href) => `<style>${fs.readFileSync(path.join(dist, href), 'utf8')}</style>`);
const js = fs.readdirSync(path.join(dist, 'assets')).find(f => f.endsWith('.js'));
const fav = fs.readFileSync(path.join(here, '../../../public/brand/bambook-v3-favicon.svg'));
html = html.replace(/<link rel="icon"[^>]*>/, `<link rel="icon" href="data:image/svg+xml;base64,${fav.toString('base64')}">`);
html = html.replace('</body>', `<script type="module">${fs.readFileSync(path.join(dist, 'assets', js), 'utf8').replace(/<\/script/g, '<\\/script')}</script></body>`);
fs.writeFileSync(out, html);
console.log('wrote', out, Math.round(html.length / 1024), 'KB');
