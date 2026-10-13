/**
 * 凭证泄露探针（只读，不发任何写请求）
 *
 * 用途：验证「部署后的网页端是否把 API Key 发到线上」。
 * 原理：Vite 会把 VITE_ 前缀的环境变量内联进客户端产物，
 *       而服务端又把 VITE_BAMBOOK_API_KEY 当作合法 API Key 接受
 *       （server/src/index.ts SDK_CONFIG.apiKeys）。
 *       二者叠加 = 任何能下载 JS 产物的人都能拿到一把能过鉴权的钥匙。
 *
 * 本脚本只做观测：打开目标页面，记录所有请求头里出现的凭据，
 * 不做登录、不提交任何数据。
 *
 * 用法：node scripts/probe-web-key-leak.mjs [url]
 */
import { chromium } from 'playwright';

const TARGET = process.argv[2] || 'https://bambook.jiangsupanda.com/';

/** 判定一个字符串是否像「被内联进前端的密钥」 */
const looksLikeSecret = (v) =>
  typeof v === 'string' && v.length >= 24 && /^[A-Za-z0-9_-]+$/.test(v);

const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();

const seen = new Map();   // 凭据值 → { urls, 首次出现的请求头 }
const jsAssets = [];

page.on('request', (req) => {
  const url = req.url();
  if (/\.js(\?|$)/.test(url)) jsAssets.push(url);
  const h = req.headers();
  for (const [name, value] of Object.entries(h)) {
    const lower = name.toLowerCase();
    if (!lower.includes('key') && !lower.includes('auth')) continue;
    if (!looksLikeSecret(value)) continue;
    if (!seen.has(value)) seen.set(value, { header: name, urls: new Set() });
    seen.get(value).urls.add(url);
  }
});

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

console.log(`目标：${TARGET}`);
await page.goto(TARGET, { waitUntil: 'networkidle', timeout: 60_000 }).catch((e) => {
  console.log(`  页面加载告警：${e.message}`);
});
// 首页渲染 + 首屏数据请求
await page.waitForTimeout(6000);

console.log(`\n加载的 JS 产物：${jsAssets.length} 个`);
for (const u of jsAssets.slice(0, 12)) console.log(`  · ${u}`);
if (jsAssets.length > 12) console.log(`  … 其余 ${jsAssets.length - 12} 个略`);

console.log(`\n请求头中出现的类密钥值：${seen.size} 个`);
for (const [value, info] of seen) {
  console.log(`  [${info.header}] ${value.slice(0, 6)}…（长度 ${value.length}）`);
  for (const u of info.urls) console.log(`      → ${u}`);
}

/** 逐个审计已加载 JS 产物：内联的长字符串常量（疑似密钥） */
console.log('\n--- 产物内联常量审计（长度 ≥ 24 的纯字符常量，取前 8） ---');
const inlineHits = await page.evaluate(async (urls) => {
  const out = [];
  for (const u of urls.slice(0, 40)) {
    try {
      const txt = await (await fetch(u)).text();
      const re = /["'`]([A-Za-z0-9_-]{24,64})["'`]/g;
      let m;
      const found = new Set();
      while ((m = re.exec(txt)) !== null) {
        // 排除明显的 hash / mime / base64 图片前缀
        if (/^[0-9a-f]{32}$/.test(m[1])) continue;
        found.add(m[1]);
      }
      if (found.size) out.push({ url: u, values: [...found].slice(0, 8) });
    } catch { /* 忽略跨域/网络失败 */ }
  }
  return out;
}, jsAssets);

let inlineCount = 0;
for (const { url, values } of inlineHits) {
  console.log(`  ${url}`);
  for (const v of values) {
    inlineCount += 1;
    console.log(`      ${v.slice(0, 6)}…（长度 ${v.length}）`);
  }
}
if (!inlineCount) console.log('  （未发现）');

console.log(`\n页面异常：${pageErrors.length}`);
for (const e of pageErrors.slice(0, 5)) console.log(`  ! ${e}`);

await browser.close();
