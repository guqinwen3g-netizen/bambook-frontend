#!/usr/bin/env node
/**
 * 由源码生成 Mist 文档的「自动部分」，保证文档与代码永远一致。
 *   node scripts/gen-mist-docs.mjs
 * 产物：docs/mist-atelier/api/components.md、docs/mist-atelier/api/tokens.md
 * 改了 components/mist/* 或 styles/mist/tokens.css 之后重新运行。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const outDir = path.join(root, 'docs/mist-atelier/api');
fs.mkdirSync(outDir, { recursive: true });

const FILES = [
  ['shell.tsx', '外壳 / 页面框架'], ['connected.tsx', '接入真实 App 的适配层'], ['primitives.tsx', '原子组件'],
  ['form.tsx', '表单'], ['data.tsx', '数据展示'], ['patterns.tsx', '业务模式'], ['overlays.tsx', '浮层'], ['ai.tsx', 'AI'], ['MistMark.tsx', '品牌'], ['types.ts', '公共类型与工具'],
];

/** 用项目已有 TypeScript AST 读取导出，避免跨 JSDoc 吞入实现或截断 forwardRef。 */
function extract(src, filename) {
  const source = ts.createSourceFile(filename, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (source.parseDiagnostics.length) throw new Error(`Cannot document invalid syntax: ${filename}`);
  const out = [];
  const clean = text => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  const signature = node => `(${node.parameters.map(p => clean(p.getText(source))).join(', ')})${node.type ? ': ' + clean(node.type.getText(source)) : ''}`;
  for (const node of source.statements) {
    if (!node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    const doc = (node.jsDoc ?? []).map(d => typeof d.comment === 'string' ? d.comment : d.comment?.map(p => p.text).join('') ?? '').join(' ').replace(/\s+/g, ' ').trim();
    if (ts.isFunctionDeclaration(node) && node.name) out.push({ name: node.name.text, doc, sig: signature(node), kind: 'value' });
    else if (ts.isTypeAliasDeclaration(node)) out.push({ name: node.name.text, doc, sig: clean(node.getText(source)).replace(/^export\s+/, ''), kind: 'type' });
    else if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) {
      const init = declaration.initializer;
      let sig = declaration.type ? clean(declaration.type.getText(source)) : '';
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) sig = signature(init);
      else if (init && ts.isCallExpression(init) && init.expression.getText(source) === 'React.forwardRef') {
        sig = `forwardRef<${(init.typeArguments ?? []).map(t => clean(t.getText(source))).join(', ')}>`;
      }
      out.push({ name: declaration.name.getText(source), doc, sig, kind: 'value' });
    }
  }
  return out;
}

let md = '# 组件 API（自动生成，勿手改）\n\n> 由 `node scripts/gen-mist-docs.mjs` 用 TypeScript AST 从源码生成。通用组件从 `components/mist` 引入；生产适配层从 `components/mist/connected` 引入。Props 类型在所属文件同表列出。\n\n';
let total = 0, types = 0;
for (const [file, title] of FILES) {
  const src = fs.readFileSync(path.join(root, 'components/mist', file), 'utf8');
  const items = extract(src, file);
  total += items.length;
  types += items.filter(it => it.kind === 'type').length;
  md += `## ${title} · \`components/mist/${file}\`\n\n| 导出 | 说明 | Props / 签名 |\n|---|---|---|\n`;
  for (const it of items) md += `| \`${it.name}\` | ${it.doc.replace(/\|/g, '\\|') || '—'} | ${it.sig ? '`' + it.sig.replace(/\|/g, '\\|').replace(/`/g, "'") + '`' : '—'} |\n`;
  md += '\n';
}
md += `\n共 ${total} 个导出声明（${total - types} 个组件/函数/值，${types} 个类型）。重导出别名不重复计数。\n`;
fs.writeFileSync(path.join(outDir, 'components.md'), md);

// tokens
const css = fs.readFileSync(path.join(root, 'styles/mist/tokens.css'), 'utf8');
const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
const light = {}; const dark = {};
for (const [, sel, body] of blocks) {
  const isDark = /dark/.test(sel.split('*/').pop());
  for (const d of body.matchAll(/(--mist-[\w-]+)\s*:\s*([^;]+);/g)) (isDark ? dark : light)[d[1]] = d[2].trim().replace(/\s+/g, ' ');
}
const groups = {};
for (const k of Object.keys({ ...light, ...dark })) { const g = k.replace('--mist-', '').split('-')[0]; (groups[g] ??= []).push(k); }
let tm = '# Token 表（自动生成，勿手改）\n\n> 由 `node scripts/gen-mist-docs.mjs` 从 `styles/mist/tokens.css` 生成。业务代码只允许 `var(--mist-*)`，不允许写死颜色/阴影/字号。\n\n';
for (const [g, ks] of Object.entries(groups)) {
  tm += `## ${g}\n\n| Token | 浅色 | 深色 |\n|---|---|---|\n`;
  for (const k of ks) tm += `| \`${k}\` | \`${(light[k] ?? '—').replace(/\|/g, '\\|')}\` | \`${(dark[k] ?? '同浅色').replace(/\|/g, '\\|')}\` |\n`;
  tm += '\n';
}
fs.writeFileSync(path.join(outDir, 'tokens.md'), tm);
console.log(`components.md: ${total} exports · tokens.md: ${Object.keys(light).length} tokens (${Object.keys(dark).length} dark overrides)`);

// module map（35 个模块 → 模板 → 批次）
const mm = fs.readFileSync(path.join(root, 'dev-ui-preview/mist-atelier/app/moduleMap.ts'), 'utf8');
const T = {}; for (const t of mm.matchAll(/'([\w-]+)':\s*\{\s*name: '([^']+)',\s*(?:page: '([^']+)',\s*)?when: '([^']+)'\s*\}/g)) T[t[1]] = { name: t[2], page: t[3], when: t[4] };
const mods = [...mm.matchAll(/\{ id: '([^']+)', view: '([^']+)', label: '([^']+)', group: '([^']+)', entry: '([^']+)', lines: (\d+), template: '([^']+)'(?:, detail: '([^']+)')?(, create: true)?, wave: (\d)(?:, notes: '([^']*)')? \}/g)]
  .map(m => ({ id: m[1], view: m[2], label: m[3], group: m[4], entry: m[5], lines: +m[6], template: m[7], detail: m[8], create: !!m[9], wave: +m[10], notes: m[11] || '' }));
const migrated = (() => { try { return fs.readFileSync(path.join(root, 'docs/mist-atelier/migrated.txt'), 'utf8').split('\n').map(x => x.replace(/#.*/, '').trim()).filter(Boolean); } catch { return []; } })();
const isDone = m => migrated.some(x => m.entry === x || m.entry.startsWith(x.replace(/\/?$/, '/')) || x === `view:${m.view}`);
let mmd = '# 全站模块迁移表（自动生成，勿手改）\n\n> 由 `node scripts/gen-mist-docs.mjs` 从 `dev-ui-preview/mist-atelier/app/moduleMap.ts` 生成。**改映射请改 moduleMap.ts。**\n> ☑ = 已在 `docs/mist-atelier/migrated.txt` 登记（入口文件路径，或 `view:<view>` 用于共用入口文件的模块）。\n> 参考页地址：参考应用 `?view=<参考页>`，源码在 `dev-ui-preview/mist-atelier/app/pages/`。\n\n## 模板\n\n| 模板 | 参考页 view | 什么时候用 |\n|---|---|---|\n';
for (const t of Object.values(T)) mmd += `| ${t.name} | ${t.page ? '`' + t.page + '`' : '—'} | ${t.when} |\n`;
for (const w of [1, 2, 3, 4, 5]) {
  const list = mods.filter(m => m.wave === w);
  mmd += `\n## Wave ${w}（${list.length} 个模块，${list.reduce((a, m) => a + m.lines, 0).toLocaleString()} 行）\n\n| ☐ | 模块 | view | 入口文件 | 行数 | 列表/主页模板 | 详情模板 | 新建 | 备注 |\n|---|---|---|---|---|---|---|---|---|\n`;
  for (const m of list) mmd += `| ${isDone(m) ? '☑' : '☐'} | ${m.label} | \`${m.view}\` | \`${m.entry}\` | ${m.lines} | ${T[m.template]?.name ?? m.template} | ${m.detail ? T[m.detail]?.name : '—'} | ${m.create ? 'T9' : '—'} | ${m.notes} |\n`;
}
fs.writeFileSync(path.join(root, 'docs/mist-atelier/module-map.md'), mmd);
console.log(`module-map.md: ${mods.length} modules · ${mods.filter(isDone).length} migrated`);
