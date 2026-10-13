/**
 * 真实数据边界验收：发票「客户联系人」渲染（外部输入面）
 *
 * 目标：不等业务方真实客户档案进来，先把「客户联系人字段里带 HTML」的各种形状压一遍，
 * 确认走真实 HTTP 预览端点（GET /api/v1/finance/:id/preview.html）出来的是惰性文本。
 *
 * 为什么要真机跑：单测只覆盖到 invoicePdfHtml 函数；这条链路还要过
 * loadInvoiceDoc（Prisma 取 Relation）→ Express 端点 → HTML 响应。
 * 且后端是 ts-node 无 watch，改完必须重启才生效——不真机验就不知道线上跑的是哪份代码。
 *
 * 做法：用 Prisma 直接造最小 Relation + Invoice（发票创建走审批流，HTTP 太重），
 * 再走真实 HTTP 取预览 HTML 断言；finally 里硬删干净。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadEnvForScript } from './lib/acceptance-selfcheck.mjs';

const API = 'http://127.0.0.1:8081';
const OUT = '/tmp/acceptance-invoice-contact';
fs.mkdirSync(OUT, { recursive: true });

// ── 从 server/ 解析依赖（脚本在 scripts/，ESM 直接 import '@prisma/client' 解析不到） ──
const serverRoot = path.resolve(import.meta.dirname, '..', 'server');
const requireFromServer = createRequire(path.join(serverRoot, 'package.json'));
// ★ G-3c 第 11 批复核处置（BLOCK-2）：构造 client 之前先把**本仓**那份 env 装上；取不到就抛 ENV_MISSING，
//   宁可拒跑也不让 Prisma 去借别的 worktree 的 env（此前 19/21 是这么被借走的）。
loadEnvForScript();
const { PrismaClient } = requireFromServer('@prisma/client');
const envFile = path.join(serverRoot, '.env');
let databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl && fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*DATABASE_URL\s*=\s*(.+)\s*$/.exec(line);
    if (m) { databaseUrl = m[1].trim().replace(/^["']|["']$/g, ''); break; }
  }
}
if (!databaseUrl) { console.log('✗ 拿不到 DATABASE_URL'); process.exit(1); }
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

// ── 登录 ──
const login = await fetch(`${API}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'jason.shen@bambook.local', password: 'Bambook@2026' }),
});
const { token } = await login.json();
if (!token) { console.log('✗ 登录失败'); process.exit(1); }

const shortId = () => Math.random().toString(36).slice(2, 10);

/** 造一个带指定联系人字段的客户档案 */
async function createRelation(contactName, contactEmail) {
  const id = `REL__ACC${shortId()}`;
  const row = await prisma.relation.create({
    data: {
      id,
      name: `验收客户-${shortId()}`,
      category: 'Customer',
      type: 'Organization',
      isOrganization: true,
      contactInfo: '',
      tags: [],
      rating: 0,
      lastInteraction: BigInt(Date.now()),
      englishName: 'ACCEPTANCE CORP',
      primaryContactName: contactName,
      primaryContactEmail: contactEmail,
    },
  });
  return row;
}

async function createInvoice(relationId, invoiceNumber) {
  const now = BigInt(Date.now());
  return prisma.invoice.create({
    data: {
      id: `INV__ACC${shortId()}`,
      invoiceNumber,
      type: 'Receivable',
      status: 'Draft',
      amount: 1000,
      currency: 'USD',
      issueDate: '2026-09-15',
      baseCurrency: 'CNY',
      customerRelationId: relationId,
      customerName: 'ACCEPTANCE CORP',
      createdAt: now,
      updatedAt: now,
    },
  });
}

const cases = [
  {
    name: '联系人姓名：属性闭合 + onerror',
    contactName: '"><img src=x onerror=alert(1)>',
    contactEmail: 'a@b.com',
  },
  {
    name: '联系人邮箱：属性闭合 + onmouseover',
    contactName: 'Alice',
    contactEmail: 'a@b.com" onmouseover="alert(1)',
  },
  {
    name: '联系人姓名：script 标签',
    contactName: '<script>alert(1)</script>',
    contactEmail: 'x@y.com',
  },
  {
    name: '联系人姓名：SVG onload（单引号闭合）',
    contactName: "Bob'><svg onload=alert(1)>",
    contactEmail: 'b@c.com',
  },
  {
    name: '正常联系人（不误伤）',
    contactName: 'Alice Zhang',
    contactEmail: 'alice@acme.com',
    expectRendered: ['Contact: Alice Zhang', 'Email: alice@acme.com'],
  },
  {
    name: '联系人含 & 符号',
    contactName: 'A & B Trading',
    contactEmail: 'a@b.com',
    expectRendered: ['A &amp; B Trading'],
  },
];

/** 只要这些结构片段原样出现，就说明没转义 */
const STRUCTURAL = ['<img', '<script', '<svg', '<iframe'];
const EXECUTABLE_IN_TAG = /<[a-z][^>]*\son[a-z]+\s*=/i;

console.log('== 发票客户联系人渲染边界验收（真实 DB + HTTP 预览端点）==\n');
let pass = 0, fail = 0;
let idx = 0;

for (const c of cases) {
  idx += 1;
  let relation = null, invoice = null;
  try {
    relation = await createRelation(c.contactName, c.contactEmail);
    invoice = await createInvoice(relation.id, `ACC-INV-${Date.now()}-${idx}`);

    const res = await fetch(`${API}/api/v1/finance/${invoice.id}/preview.html`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const html = await res.text();
    fs.writeFileSync(path.join(OUT, `case-${idx}.html`), html);

    const problems = [];
    if (res.status !== 200) problems.push(`status=${res.status}（应 200）`);
    for (const s of STRUCTURAL) {
      if (html.includes(s)) problems.push(`出现未转义结构 ${s}`);
    }
    if (EXECUTABLE_IN_TAG.test(html)) problems.push('标签内出现 on* 事件属性');
    for (const want of c.expectRendered ?? []) {
      if (!html.includes(want)) problems.push(`应有但未出现：${want}`);
    }

    const good = problems.length === 0;
    good ? pass++ : fail++;
    console.log(`${good ? '✓' : '✗'} ${c.name}`);
    console.log(`    status=${res.status} 长度=${html.length}${problems.length ? '\n    ⚠ ' + problems.join('；') : ''}`);
    // 打印买方栏片段，便于人工回看
    const i = html.indexOf('Contact:');
    if (i >= 0) console.log(`    片段: ${html.slice(i - 20, i + 150).replace(/\s+/g, ' ')}`);
  } catch (e) {
    fail++;
    console.log(`✗ ${c.name}\n    ⚠ 异常: ${e?.message || e}`);
  } finally {
    // 硬删，不留彩排垃圾
    try { if (invoice) await prisma.invoice.delete({ where: { id: invoice.id } }); } catch { /* noop */ }
    try { if (relation) await prisma.relation.delete({ where: { id: relation.id } }); } catch { /* noop */ }
  }
}

await prisma.$disconnect();
console.log(`\n结果: ${pass} 通过 / ${fail} 失败（HTML 存 ${OUT}）`);
process.exit(fail ? 1 : 0);
