#!/usr/bin/env node
/**
 * Mist Atelier 迁移守门脚本（Flat Frost 规则的机器检查）。
 *
 *   node scripts/check-mist.mjs                      # 检查 docs/mist-atelier/migrated.txt 里登记的已迁移文件 + Mist 本身
 *   node scripts/check-mist.mjs components/OrderManager.tsx components/orders/   # 只检查指定文件/目录
 *
 * 退出码：0 = 通过；1 = 有 error。warning 不阻断，但要在 PR 说明里解释。
 * 规则来源：docs/mist-atelier/01-principles.md。不要为了过检查而改这个脚本——改代码。
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const rel = p => path.relative(root, p);

const RULES = [
  // [id, level, regex, message]
  ['no-isDarkMode', 'error', /\bisDarkMode\b/, '已迁移文件不得再按 isDarkMode 分支——深浅色只由 token 决定（MistRoot 跟随宿主主题）'],
  ['no-tw-dark', 'error', /(["'`\s])dark:[\w-[]/, '不得使用 Tailwind dark: 变体'],
  ['no-hex', 'error', /(?<![\w&])#[0-9a-fA-F]{3,8}\b(?![\w-])/, '不得写死颜色，使用 var(--mist-*) 或组件 tone'],
  ['no-rgba', 'warn', /\brgba?\(|\bhsla?\(/, '疑似写死颜色，确认是否应改为 token'],
  ['no-tw-shadow', 'error', /(["'`\s])(drop-)?shadow(-[\w[\]/.]+)?(?=["'`\s])/, 'Flat Frost 禁止阴影（浮层由组件自带）'],
  ['no-tw-border', 'error', /(["'`\s])(border|border-[trblxy]|border-[\w[\]/.-]+|ring|ring-[\w[\]/.-]+|divide-[\w-]+|outline-[\w-]+)(?=["'`\s])/, 'Flat Frost 禁止描边/ring/divide，层级用填充色'],
  ['no-tw-color', 'error', /(["'`\s])(bg|text|from|via|to|fill|stroke)-(white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(-\d{2,3})?(\/\d+)?(?=["'`\s])/, '不得使用 Tailwind 调色板颜色'],
  ['no-tw-rounded', 'warn', /(["'`\s])rounded(-[\w[\]]+)?(?=["'`\s])/, '圆角应来自组件；自定义块请用 var(--mist-r-*)'],
  ['no-tw-weight', 'error', /(["'`\s])font-(medium|semibold|bold|extrabold|black)(?=["'`\s])/, '字重只来自组件 / var(--mist-fw-*)'],
  ['no-style-shadow', 'error', /\b(boxShadow|textShadow)\s*:/, '内联样式不得写阴影'],
  ['no-style-border', 'error', /\bborder(Top|Right|Bottom|Left|Color|Width)?\s*:\s*['"`]?(?!0\b|none\b)/, '内联样式不得写描边'],
  ['no-bds', 'error', /(["'`\s])bds-[\w-]+/, '已迁移文件不得混用旧 BDS 类名'],
  ['no-old-shell', 'error', /from\s+['"][./]*(components\/)?(Sidebar|ui\/PageHeader|bds\/[\w/]+)['"]/, '已迁移文件不得引用旧外壳/BDS 组件'],
  ['no-alert', 'error', /\b(window\.)?(alert|confirm)\(/, '用 Dialog / useToast，不用浏览器原生弹窗'],
  ['no-spinner', 'warn', /animate-spin|Loader2/, '加载态用 DataTable loading / Skeleton，不要自画 spinner'],
];

const EXEMPT_FILES = [/components\/mist\/markSvg\.ts$/, /dev-ui-preview\/mist-atelier\/app\/data\.ts$/];
const EXEMPT_RULES_IN_MIST = new Set(['no-rgba', 'no-tw-rounded']);

function listFiles(p) {
  const abs = path.resolve(root, p);
  if (!fs.existsSync(abs)) { console.error(`✗ 找不到 ${p}`); process.exitCode = 1; return []; }
  if (fs.statSync(abs).isFile()) return [abs];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap(d => d.name === 'node_modules' || d.name.startsWith('.') ? [] : listFiles(path.join(abs, d.name)))
    .filter(f => /\.(tsx?|jsx?)$/.test(f));
}

let targets = process.argv.slice(2);
if (!targets.length) {
  const manifest = path.join(root, 'docs/mist-atelier/migrated.txt');
  const listed = fs.existsSync(manifest) ? fs.readFileSync(manifest, 'utf8').split('\n').map(s => s.replace(/#.*/, '').trim()).filter(Boolean).filter(s => !s.startsWith('view:')) : [];
  targets = ['components/mist', 'dev-ui-preview/mist-atelier/app', ...listed];
}
const files = [...new Set(targets.flatMap(listFiles))].filter(f => !EXEMPT_FILES.some(r => r.test(f)));

let errors = 0, warns = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const isMist = /components\/mist\/|dev-ui-preview\/mist-atelier\//.test(f);
  const lines = src.split('\n');
  let inBlock = false;
  lines.forEach((line, i) => {
    let code = line;
    if (inBlock) { if (code.includes('*/')) { inBlock = false; code = code.slice(code.indexOf('*/') + 2); } else return; }
    if (code.includes('/*') && !code.includes('*/')) { inBlock = true; code = code.slice(0, code.indexOf('/*')); }
    code = code.replace(/\/\*.*?\*\//g, '').replace(/(^|[^:])\/\/.*$/, '$1');
    if (/mist-allow/.test(line)) return; // 单行豁免：行尾写 // mist-allow: 原因
    for (const [id, level, re, msg] of RULES) {
      if (isMist && EXEMPT_RULES_IN_MIST.has(id)) continue;
      if (re.test(code)) {
        level === 'error' ? errors++ : warns++;
        console.log(`${level === 'error' ? '✗' : '!'} ${rel(f)}:${i + 1}  [${id}] ${msg}\n    ${line.trim().slice(0, 140)}`);
      }
    }
  });
  if (!isMist && /\.tsx$/.test(f) && !/components\/mist['"/]/.test(src) && !/from ['"][./]*mist['"]/.test(src)) {
    warns++; console.log(`! ${rel(f)}  [use-mist] 已登记为迁移文件，但没有从 components/mist 引入任何组件`);
  }
}
console.log(`\nMist check: ${files.length} 个文件 · ${errors} error · ${warns} warning`);
if (errors) process.exitCode = 1;
