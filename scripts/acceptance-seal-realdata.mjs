// 真实业务数据边界验收：章图（seal）上传 + 渲染
// 目标：不等业务方真章，先把真实可能的各种章图形状压一遍，确认「真章进来不炸」
// 覆盖：PNG(小/大/超大) / JPEG / GIF / WebP / SVG / 非 base64 内联 SVG / 引号注入 / 空内容
import fs from 'fs';

const API = 'http://127.0.0.1:8081';
const OUT = '/tmp/acceptance-seal';
fs.mkdirSync(OUT, { recursive: true });

const login = await fetch(`${API}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'jason.shen@bambook.local', password: 'Bambook@2026' }),
});
const { token } = await login.json();
if (!token) { console.log('登录失败'); process.exit(1); }
const api = async (method, path, body) => {
  const res = await fetch(`${API}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

// ── 构造各种真实可能的章图 ──
// 1x1 红点 PNG（合法最小）
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// 512x512 纯色 PNG（模拟公章扫描件，用 zlib 构造较大体积）
function makeBigPng(approxBytes) {
  // 用重复 payload 逼近目标体积（模拟高 DPI 扫描件）
  const header = 'data:image/png;base64,';
  const chunk = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  let body = '';
  while ((header.length + body.length) < approxBytes) body += chunk;
  return header + body;
}
const cases = [
  { name: 'PNG 1x1（合法最小）', url: PNG_1PX, expect: 'ok' },
  { name: 'PNG 512（正常公章尺寸）', url: makeBigPng(40_000), expect: 'ok' },
  { name: 'PNG 扫描件 ~1MB（高 DPI）', url: makeBigPng(1_000_000), expect: 'ok' },
  { name: 'PNG 超大 ~3.5MB（超限）', url: makeBigPng(3_500_000), expect: 'reject' },
  { name: 'JPEG（手机拍照章）', url: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAg=' , expect: 'ok' },
  { name: 'GIF', url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', expect: 'ok' },
  { name: 'WebP', url: 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', expect: 'ok' },
  { name: 'SVG base64（可含脚本 + PDF 渲染不稳）', url: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=', expect: 'reject' },
  { name: 'SVG 非 base64 内联（onload 注入）', url: 'data:image/svg+xml,<svg onload="alert(1)"/>', expect: 'reject' },
  { name: 'PNG + 双引号闭合注入', url: 'data:image/png;base64,AAAA" onerror="alert(1)', expect: 'reject' },
  { name: 'PNG + <script>', url: 'data:image/png;base64,AAAA<script>alert(1)</script>', expect: 'reject' },
  { name: '空 payload', url: 'data:image/png;base64,', expect: 'reject' },
  { name: '非图片 data URL', url: 'data:text/html;base64,PHNjcmlwdD4=', expect: 'reject' },
  { name: '裸 URL（非 data）', url: 'https://evil.tld/seal.png', expect: 'reject' },
];

console.log('== 章图上传边界验收 ==\n');
let pass = 0, fail = 0;
const createdIds = [];
for (const c of cases) {
  const r = await api('POST', '/api/v1/seals', {
    name: `验收-${c.name}`.slice(0, 40),
    type: 'company_seal',
    imageDataUrl: c.url,
  });
  const ok = r.status === 201;
  const actual = ok ? 'ok' : 'reject';
  // 拒绝场景必须返回 400（客户端输入问题），不能是 500 —— 500 会污染告警并误导前端重试
  const statusOk = ok || r.status === 400;
  const good = actual === c.expect && statusOk;
  good ? pass++ : fail++;
  console.log(`${good ? '✓' : '✗'} ${c.name}`);
  console.log(`    期望=${c.expect} 实际=${actual} status=${r.status}${statusOk ? '' : '  ⚠ 状态码应为 400'}${r.data?.error ? ' msg=' + JSON.stringify(r.data.error.message ?? r.data.error).slice(0, 90) : ''}`);
  if (ok && r.data?.item?.id) createdIds.push(r.data.item.id);
}

// ── 清理本次创建的章 ──
console.log(`\n清理 ${createdIds.length} 个验收章…`);
for (const id of createdIds) {
  const d = await api('DELETE', `/api/v1/seals/${id}`);
  if (d.status >= 300) console.log(`  ⚠ 删除失败 ${id} status=${d.status}`);
}
console.log(`\n结果：${pass}/${cases.length} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
