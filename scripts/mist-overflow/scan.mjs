#!/usr/bin/env node
/**
 * Mist 自适应溢出扫描（全量 / 快速回归）。
 *
 *   npm run mist:overflow            全量：全部主路由、页签、详情（每类第一个对象）、新建页、常用弹窗与抽屉
 *                                     × 16 个宽度 × 浅色 / 深色
 *   npm run mist:overflow:quick      快速回归：代表性页面 × 6 个宽度 × 浅色 / 深色，有溢出即失败
 *
 * 数据：本地独立模式（`npm run dev:mist`，local-file 存储 + 演示种子），以「本地操作员」合成身份登录；
 * 未检测到 http://127.0.0.1:3001 时自动启动本地栈，结束后只关闭本次启动的服务。不连接正式环境与真实数据。
 * 扫描期间把当前工作区主题设为「跟随系统」以便切换浅色 / 深色，结束后恢复原设置。
 *
 * 选项：--quick  --out <dir>  --widths 360,390  --themes light,dark  --only orders,risks  --workers 4
 *       --report-only（有问题也以 0 退出，用于产出修复前清单）  --selftest（只跑判定自检夹具）
 * 环境：MIST_OVERFLOW_BASE（默认 http://127.0.0.1:3001）、CHROMIUM（浏览器可执行文件路径）
 * 输出：<out>/report.json 与 <out>/report.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { detectOverflow } from './detect.mjs';
import { selfTest } from './selftest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const flag = name => args.includes('--' + name);
const option = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : fallback; };
const QUICK = flag('quick');

const BASE = (process.env.MIST_OVERFLOW_BASE || 'http://127.0.0.1:3001').replace(/\/$/, '');
/**
 * 宽度：窄屏加密；每个断点（640 / 720 / 760 / 1180 / 1320，max-width）取「仍保持宽布局的最窄宽度」+1px，
 * 那是切换布局前最挤的状态；宽屏保留 1440 / 1920 各一个。
 */
const FULL_WIDTHS = [360, 375, 390, 414, 600, 641, 721, 761, 768, 900, 1024, 1181, 1280, 1321, 1440, 1920];
const QUICK_WIDTHS = [360, 390, 761, 1024, 1181, 1440];
const widths = (option('widths') ? option('widths').split(',').map(Number) : QUICK ? QUICK_WIDTHS : FULL_WIDTHS);
const themes = (option('themes') || 'light,dark').split(',');
const only = option('only') ? new Set(option('only').split(',')) : null;
const workers = Number(option('workers', 4));
const outDir = path.resolve(option('out', path.join(ROOT, 'mist-overflow', QUICK ? 'quick' : 'full')));
const reportOnly = flag('report-only');

/** 固定页面清单：侧栏全部主路由 + 侧栏外入口。不做自动点击探索。 */
const VIEWS = ['cockpit', 'calendar', 'relations', 'crm', 'suppliers', 'seasons', 'marketing', 'products', 'development', 'samples', 'quotations', 'orders', 'production-board', 'procurement', 'inventory', 'qc-workbench', 'shipments', 'customs', 'document-center', 'payment-vouchers', 'pricing', 'bom', 'risks', 'claims', 'assistant', 'data-center', 'hr', 'reports', 'business-tools', 'admin-panel', 'design-system', 'states', 'system-settings',
  'approvals', 'notifications', 'search', 'workspace-settings', 'emails', 'invoices', 'dashboard', 'mes'];
/** 有列表的页面再扫「第一个对象」的详情（点第一行，URL 变化才算）。 */
const DETAIL_VIEWS = ['relations', 'crm', 'suppliers', 'seasons', 'marketing', 'products', 'development', 'samples', 'quotations', 'orders', 'production-board', 'procurement', 'inventory', 'qc-workbench', 'shipments', 'customs', 'document-center', 'payment-vouchers', 'pricing', 'bom', 'risks', 'claims', 'hr', 'approvals', 'invoices'];
/** 常用新建弹窗 / 编辑页：点页头第一个「新建 / 登记」类按钮。 */
const CREATE_VIEWS = ['risks', 'claims', 'suppliers', 'procurement', 'shipments', 'quotations', 'samples', 'crm', 'relations', 'invoices'];
const CREATE = /^(?:[+＋]\s*)?(?:新建|新增|手工登记|登记|创建|添加|发起|录入)/;
const STATES = [
  ...VIEWS.map(v => ({ id: v, label: v, url: '?view=' + v })),
  { id: 'development/new', label: '新建开发案', url: '?view=development/new' },
  { id: 'orders/new', label: '新建订单', url: '?view=orders/new' },
  ...DETAIL_VIEWS.map(v => ({ id: v + '#detail', label: v + ' · 第一个对象详情', url: '?view=' + v, actions: [{ row: true }] })),
  ...CREATE_VIEWS.map(v => ({ id: v + '+create', label: v + ' · 新建', url: '?view=' + v, actions: [{ create: true }] })),
  { id: 'cockpit+palette', label: '命令面板', url: '?view=cockpit', actions: [{ press: 'Control+k' }] },
  { id: 'cockpit+account', label: '账号抽屉', url: '?view=cockpit', actions: [{ click: '.mist-me' }] },
  { id: 'cockpit+assistant', label: '小竹助手抽屉', url: '?view=cockpit', actions: [{ click: '.mist-side-ai' }] },
];
/** 快速回归：宽表 / 列表预览 / 单据详情 / 对象详情 / 模块工作台 / 新建 / 弹窗 / 抽屉各取代表。 */
const QUICK_STATES = new Set(['cockpit', 'orders', 'orders#detail', 'development', 'development#detail', 'development/new', 'risks', 'risks#detail', 'risks+create', 'payment-vouchers', 'quotations', 'shipments', 'crm#detail', 'cockpit+palette', 'cockpit+account']);

async function ensureServer() {
  const ok = async () => { try { const r = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(2000) }); const b = await r.json(); return r.ok && b.mode === 'local'; } catch { return false; } };
  if (await ok()) return null;
  if (process.env.MIST_OVERFLOW_BASE) throw new Error(`${BASE} 不可用，且指定了 MIST_OVERFLOW_BASE，不会自动启动`);
  const { startMistDevelopment } = await import(path.join(ROOT, 'scripts/mist-dev.mjs'));
  const running = await startMistDevelopment();
  for (let i = 0; i < 60 && !(await ok()); i++) await new Promise(r => setTimeout(r, 500));
  if (!(await ok())) { await running.close(); throw new Error('本地 Mist 栈未能就绪'); }
  return running;
}

async function signIn(context) {
  const page = await context.newPage();
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  const status = await page.evaluate(async () => {
    await fetch('/api/mist/session', { credentials: 'include' });
    const r = await fetch('/api/mist/session', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId: 'local-operator' }) });
    return r.status;
  });
  if (status !== 200) throw new Error('本地身份登录失败：' + status);
  return page;
}

/** 设置工作区主题；返回原值。 */
async function setTheme(page, theme) {
  return page.evaluate(async theme => {
    const ws = (await (await fetch('/api/mist/workspaces/default', { credentials: 'include' })).json()).workspace;
    const previous = ws.state.settings.theme;
    if (previous !== theme) {
      const r = await fetch(`/api/mist/workspaces/${ws.id}/commands`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'overflow-scan-theme-' + Date.now(), expectedRevision: ws.revision, command: { type: 'settings.update', payload: { theme } } }) });
      if (!r.ok) throw new Error('主题设置失败 ' + r.status + ' ' + await r.text());
    }
    return previous;
  }, theme);
}

const settle = async page => { await page.locator('.mist-scroll, .mist-auth').first().waitFor({ timeout: 8000 }).catch(() => {}); await page.waitForTimeout(500); };

/** 打开页面并执行动作；动作没有生效（没有行 / 没有新建按钮）时返回 false，跳过该状态。 */
async function replay(page, state) {
  await page.goto(BASE + '/' + state.url); await settle(page);
  for (const a of state.actions || []) {
    const before = page.url();
    if (a.press) await page.keyboard.press(a.press);
    if (a.click) { const el = page.locator(a.click).first(); if (!(await el.count()) || !(await el.isVisible())) return false; await el.click(); }
    if (a.row) {
      const row = page.locator('.mist-scroll .mist-tr[data-clickable]').first();
      await row.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      if (!(await row.count()) || !(await row.isVisible())) return false;
      await row.click();
      await page.waitForURL(u => u.toString() !== before, { timeout: 4000 }).catch(() => {});
      // 列表 + 预览布局里单击只选中，双击才进入详情。
      if (page.url() === before) { await row.dblclick().catch(() => {}); await page.waitForURL(u => u.toString() !== before, { timeout: 4000 }).catch(() => {}); }
      // 第一行若已是选中对象（URL 已带 id），点击不会改变地址，但已经处于详情状态。
      if (page.url() === before && !/[?&]id=/.test(page.url())) return false;
    }
    if (a.create) {
      const buttons = page.locator('.mist-scroll .mist-page-head button');
      let hit = null;
      for (let i = 0; i < await buttons.count(); i++) { const t = (await buttons.nth(i).innerText()).trim(); if (CREATE.test(t) && await buttons.nth(i).isEnabled()) { hit = buttons.nth(i); break; } }
      if (!hit) return false;
      await hit.click();
    }
    await page.waitForTimeout(500);
  }
  return true;
}

async function scanState(context, state, theme) {
  const page = await context.newPage();
  const found = [], designed = [], errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1440, height: 900 });
    if (!(await replay(page, state))) { await page.close(); return { found, designed, errors, skipped: true }; }
    for (const w of widths) {
      await page.setViewportSize({ width: w, height: w < 760 ? 844 : 900 });
      await page.waitForTimeout(260);
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      const result = await page.evaluate(detectOverflow, {});
      for (const issue of result.issues) found.push({ state: state.id, label: state.label, url: state.url, actions: state.actions, theme, width: w, ...issue });
      for (const d of result.designed) designed.push({ state: state.id, theme, width: w, ...d });
    }
  } catch (error) { errors.push(String(error.message || error)); }
  await page.close();
  return { found, designed, errors };
}

function writeReport(states, issues, designed, errors, ms) {
  fs.mkdirSync(outDir, { recursive: true });
  const sig = i => [i.state, i.kind, i.selector, i.culprit?.selector || ''].join('|');
  const groups = new Map();
  for (const i of issues) { const k = sig(i); const g = groups.get(k) || { ...i, widths: new Set(), themes: new Set(), maxOver: 0, count: 0 }; g.widths.add(i.width); g.themes.add(i.theme); g.maxOver = Math.max(g.maxOver, i.over, i.culprit?.over || 0); g.count++; groups.set(k, g); }
  const grouped = [...groups.values()].map(g => ({ ...g, widths: [...g.widths].sort((a, b) => a - b), themes: [...g.themes] }));
  const designedGroups = new Map();
  for (const d of designed) { const k = d.state + '|' + d.selector; const g = designedGroups.get(k) || { state: d.state, selector: d.selector, widths: new Set(), maxOver: 0 }; g.widths.add(d.width); g.maxOver = Math.max(g.maxOver, d.over); designedGroups.set(k, g); }
  const by = (list, key) => Object.entries(list.reduce((m, i) => { const k = key(i); m[k] = (m[k] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);
  const summary = { generatedAt: new Date().toISOString(), base: BASE, quick: QUICK, widths, themes, states: states.length, raw: issues.length, unique: grouped.length, durationSec: Math.round(ms / 1000),
    byKind: by(grouped, i => i.kind), byState: by(grouped, i => i.state), byWidth: by(issues, i => String(i.width)), byTheme: by(issues, i => i.theme) };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ summary, issues: grouped, raw: issues, designed: [...designedGroups.values()].map(g => ({ ...g, widths: [...g.widths] })), errors, states }, null, 1));
  const esc = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [`# Mist 溢出扫描${QUICK ? '（快速）' : '（全量）'}`, '', `- 时间：${summary.generatedAt}；耗时 ${summary.durationSec}s；地址 ${BASE}`, `- 页面状态 ${states.length} 个 × 宽度 ${widths.join('/')} × 主题 ${themes.join('/')}`, `- 问题：去重后 **${grouped.length}** 处（原始命中 ${issues.length} 次）`, '',
    '## 按类型', '', ...summary.byKind.map(([k, n]) => `- ${k}: ${n}`), '', '## 按页面', '', ...summary.byState.map(([k, n]) => `- ${k}: ${n}`), '', '## 按宽度（原始命中）', '', ...summary.byWidth.sort((a, b) => a[0] - b[0]).map(([k, n]) => `- ${k}: ${n}`), '', '## 按主题（原始命中）', '', ...summary.byTheme.map(([k, n]) => `- ${k}: ${n}`), '',
    '## 清单', '', '| 页面 | 类型 | 宽度 | 主题 | 超出 px | 元素 | 突出的子元素 / 文字 | 位置 (x,y,w,h @首个宽度) |', '|---|---|---|---|---|---|---|---|',
    ...grouped.sort((a, b) => a.state.localeCompare(b.state) || b.maxOver - a.maxOver).map(g => `| ${esc(g.label)} | ${g.kind} | ${g.widths.join(',')} | ${g.themes.join(',')} | ${g.maxOver} | \`${esc(g.selector.split(' > ').slice(-3).join(' > '))}\` «${esc(g.text?.slice(0, 24))}» | ${g.culprit ? '`' + esc(g.culprit.selector.split(' > ').slice(-2).join(' > ')) + '` «' + esc(g.culprit.text.slice(0, 24)) + '»' : '—'} | ${g.rect ? [g.rect.x, g.rect.y, g.rect.w, g.rect.h].join(',') : ''} |`),
    '', '## 按设计横向滚动（不计入问题）', '', ...(designedGroups.size ? [...designedGroups.values()].map(g => `- ${g.state}: \`${g.selector.split(' > ').slice(-3).join(' > ')}\`（宽度 ${[...g.widths].sort((a, b) => a - b).join(',')}，最多 ${g.maxOver}px）`) : ['- 无']),
    '', '## 运行错误', '', ...(errors.length ? errors.map(e => '- ' + esc(e)) : ['- 无'])];
  fs.writeFileSync(path.join(outDir, 'report.md'), lines.join('\n') + '\n');
  return { summary, grouped };
}

const started = Date.now();
const launchBrowser = () => chromium.launch({ ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}), args: ['--no-sandbox'] });
{
  // 先自检判定逻辑（不需要本地栈）。
  const probe = await launchBrowser();
  const failures = await selfTest(await probe.newPage());
  await probe.close();
  if (failures.length) { console.error('[overflow] 判定自检失败：\n  - ' + failures.join('\n  - ')); process.exit(2); }
  console.log('[overflow] 判定自检通过');
  if (flag('selftest')) process.exit(0);
}
const running = await ensureServer();
const browser = await launchBrowser();
let exitCode = 0, originalTheme;
try {
  const setup = await browser.newContext();
  const setupPage = await signIn(setup);
  originalTheme = await setTheme(setupPage, 'system');
  let states = STATES;
  if (QUICK) states = states.filter(s => QUICK_STATES.has(s.id));
  if (only) states = states.filter(s => only.has(s.id.split(/[+#]/)[0]) || only.has(s.id));
  console.log(`[overflow] ${states.length} 个页面状态 × ${widths.length} 宽度 × ${themes.length} 主题`);
  const jobs = states.flatMap(s => themes.map(t => [s, t]));
  const issues = [], designed = [], errors = [], skipped = new Set();
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: Math.max(1, workers) }, async () => {
    const context = await browser.newContext();
    await (await signIn(context)).close();
    while (next < jobs.length) {
      const [state, theme] = jobs[next++];
      const r = await scanState(context, state, theme);
      if (r.skipped) skipped.add(state.id);
      issues.push(...r.found); designed.push(...r.designed); errors.push(...r.errors.map(e => `${state.id} ${theme}: ${e}`));
      done++; if (done % 20 === 0 || done === jobs.length) console.log(`[overflow] ${done}/${jobs.length}，累计命中 ${issues.length}`);
    }
    await context.close();
  }));
  const { summary, grouped } = writeReport(states.filter(s => !skipped.has(s.id)), issues, designed, errors, Date.now() - started);
  console.log(`[overflow] 去重后 ${grouped.length} 处溢出（原始 ${summary.raw}）；报告 ${path.relative(process.cwd(), path.join(outDir, 'report.md'))}`);
  for (const g of grouped.slice(0, 15)) console.log(`  - ${g.state} ${g.kind} +${g.maxOver}px @${g.widths.join(',')} ${g.selector.split(' > ').slice(-2).join(' > ')}`);
  if (grouped.length && !reportOnly) exitCode = 1;
  await setTheme(setupPage, originalTheme);
  await setup.close();
} catch (error) {
  console.error('[overflow] 扫描失败：', error); exitCode = 2;
} finally {
  await browser.close();
  if (running) await running.close();
}
process.exit(exitCode);
