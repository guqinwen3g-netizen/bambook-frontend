/**
 * acceptance-e-outward-amount.ts —— E 批端到端真跑：「对外金额」到底在屏面上给哪个数
 *
 * 为什么还要这一趟：E 批 12 处改动的证据此前只到**模板渲染层 + stub 装配层**，
 *   没有一次是真起服务、真发 HTTP、真拿回 HTML/JSON。台账 §五 一直挂着「端到端未做」。
 *
 * 做法（一张单，四个出口，跑完回滚）：
 *   ① 挑一张「有明细行 + 有门户账号能看 + 尚未登记过确认书」的活单；
 *   ② 基线：主档三列与 Σ明细行 今天相等（实测如此）⇒ 先取 preview.html 做"改前"样本；
 *   ③ 造分叉：把主档三列抬到 Σ明细行 + 3,850.50（＝S4 全批在治的那个真实病形「改价只改主档」），
 *      ★ 三列一起抬 ⇒ 真源第 ② 档（totalNet）也不许赢，只有 ①（Σ明细行）能给对；
 *   ④ 四个出口逐一验「给的是 Σ明细行，不是主档那个数」：
 *      OC preview.html（TOTAL 格 vs 行表逐格相加，恒等式）· 门户列表 DTO · 门户详情 DTO+行表 · 登记头 totalAmount；
 *   ⑤ 按**②里抓取的原值**回滚三列并回读相等；生成出来的那张文档（含版本行/PDF）逐条删干净，
 *      并回读「该单的文档数＝0」作证（跨通道回读，不接受"我删了"）。
 *
 * 用法：BAMBOOK_API=http://127.0.0.1:8123 npx tsx scripts/acceptance-e-outward-amount.ts
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { SERVER_DIR, REPO_ROOT, loadEnvForScript } from './lib/acceptance-selfcheck.mjs';

const req = createRequire(SERVER_DIR + '/');
loadEnvForScript();
const { PrismaClient } = req('@prisma/client');
const prisma = new PrismaClient();

const BASE = process.env.BAMBOOK_API ?? 'http://127.0.0.1:8123';
const STAFF_PASSWORD = process.env.BAMBOOK_DEMO_PASSWORD ?? 'Bambook@2026';
const PORTAL_PASSWORD = process.env.CUSTOMER_PORTAL_PASSWORD ?? 'Customer@123';
const DELTA = 3850.5;

const R = (x: any) => (x == null ? null : Math.round(Number(x) * 100) / 100);
const fmt = (n: number) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const rows: Array<[boolean, string, string]> = [];
const ok = (n: string, d = '') => { rows.push([true, n, d]); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const bad = (n: string, d = '') => { rows.push([false, n, d]); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const info = (n: string, d = '') => console.log(`  ⓘ ${n}${d ? ' — ' + d : ''}`);

async function staffLogin(): Promise<string | null> {
  for (const email of ['kevin@bambook.local', 'jason.shen@bambook.local', 'charlie.qian@bambook.local']) {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: STAFF_PASSWORD }),
    });
    const d: any = await r.json().catch(() => ({}));
    if (r.ok && (d.ok || d.token)) { info(` staff 登录 ${email}`); return d.token ?? d.data?.token; }
  }
  return null;
}

/** 从 preview.html 里把「TOTAL 合计」格与明细行 Amount 列都抠出来做恒等式（不看措辞，只看数） */
function parseAmounts(html: string): { lineVals: number[]; total: number | null } {
  const tbody = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));
  const money = /<td style="text-align:right">([\d,]+\.\d{2}) [A-Z]{3}<\/\/td>/g;
  const lineVals = [...tbody.matchAll(/<td style="text-align:right">([\d,]+\.\d{2}) USD<\/td>/g)]
    .map((m: RegExpMatchArray) => Number(m[1].replace(/,/g, '')));
  const t = html.slice(html.indexOf('<tfoot>')).match(/<td style="text-align:right">([\d,]+\.\d{2}) USD<\/td>/);
  return { lineVals, total: t ? Number(t[1].replace(/,/g, '')) : null };
}

let createdDoc: string | null = null;

async function main() {
  const sha = execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT }).toString().trim();
  const dirty = execSync('git status --porcelain', { cwd: REPO_ROOT }).toString().trim();
  console.log('════════════════════════════════════════════');
  console.log(` E 批端到端真跑 · ${BASE}`);
  console.log(` 代码 HEAD=${sha} 工作树${dirty ? '不干净(跑的是工作树)' : '干净'}`);
  console.log('════════════════════════════════════════════');

  const H = await staffLogin();
  if (!H) { bad('staff 登录', '三个账号都不可用 ⇒ 整趟不成立'); return finish(); }
  const auth = { Authorization: `Bearer ${H}` };

  // ── ① 挑靶子 ────────────────────────────────────────────
  const portalUsers = await prisma.customerUser.findMany({ where: { status: 'active' }, select: { email: true, relationId: true } });
  const relIds = [...new Set(portalUsers.map((u: any) => u.relationId).filter(Boolean))];
  const cands = await prisma.order.findMany({
    where: { deletedAt: null, customerRelationId: { in: relIds }, lines: { some: {} } },
    include: { lines: true }, take: 40, orderBy: { createdAt: 'desc' },
  });
  let target: any = null;
  for (const o of cands) {
    const docs = await prisma.tradeDocument.count({ where: { domain: 'orders', type: 'OrderConfirmation', sourceRef: o.id } });
    if (docs === 0) { target = o; break; }
  }
  if (!target) { bad('挑靶子', '找不到「有明细行 + 有门户账号 + 未登记过确认书」的活单 ⇒ 不硬造第二张单'); return finish(); }
  const lineSum = R(target.lines.reduce((s: number, l: any) => s + Number(l.netValue ?? 0), 0)) as number;
  const orig = { quoteAmount: R(target.quoteAmount), totalNet: R(target.totalNet), contractAmount: R(target.contractAmount) };
  info(`靶子 ${target.poNumber ?? target.id}：Σ明细行=${fmt(lineSum)} 抓取时点主档三列=${JSON.stringify(orig)}`);
  const pu: any = portalUsers.find((u: any) => u.relationId === target.customerRelationId);
  ok('靶子三面齐', `有明细行 ${target.lines.length} 行 · 门户账号 ${pu?.email ?? '无'} · 文档数 0`);

  // ── ② 基线（改前）─────────────────────────────────────────
  const before = await fetch(`${BASE}/api/v2/orders/${target.id}/preview.html`, { headers: auth });
  const beforeHtml = await before.text();
  if (before.status !== 200) { bad('OC preview 基线', `HTTP ${before.status}`); }
  const b = parseAmounts(beforeHtml);
  ok('OC 基线可解析', `改前 TOTAL=${b.total} 行表 ${b.lineVals.length} 格`);

  // ── ③ 造分叉（三列一起抬，只有 ① 能给对）────────────────────
  const diverged = R(lineSum + DELTA) as number;
  await prisma.order.update({ where: { id: target.id }, data: { quoteAmount: diverged, totalNet: diverged, contractAmount: diverged } });
  const back = await prisma.order.findUnique({ where: { id: target.id }, select: { quoteAmount: true, totalNet: true } });
  if (R(back!.quoteAmount) !== diverged) { bad('造分叉落库', `回读 ${R(back!.quoteAmount)} ≠ ${diverged} ⇒ 后面的读数都不算`); await restore(orig, target.id); return finish(); }
  info(`已把主档三列抬到 ${fmt(diverged)}（Σ明细行仍是 ${fmt(lineSum)}）`);

  try {
    // ── ④-A OC 预览：TOTAL 必须是 Σ明细行 ───────────────────
    const after = await fetch(`${BASE}/api/v2/orders/${target.id}/preview.html`, { headers: auth });
    const html = await after.text();
    const a = parseAmounts(html);
    if (a.total === lineSum) ok('OC TOTAL = Σ明细行', `${fmt(lineSum)}（主档写的是 ${fmt(diverged)}）`);
    else bad('OC TOTAL = Σ明细行', `拿到 ${a.total}，期望 ${lineSum}`);
    if (!html.includes(fmt(diverged))) ok('OC 页内不出现主档那个数', '旧写法会把它印在合计格');
    else bad('OC 页内不出现主档那个数', `页内仍有 ${fmt(diverged)}`);
    if (a.lineVals.length > 0 && R(a.lineVals.reduce((s, v) => s + v, 0)) === a.total) ok('恒等式：TOTAL === 行表逐格相加', `${a.lineVals.join(' + ')} = ${a.total}`);
    else bad('恒等式：TOTAL === 行表逐格相加', `行表 ${a.lineVals.join('+')} vs TOTAL ${a.total}`);

    // ── ④-B 门户列表 + 详情 ────────────────────────────────
    if (pu) {
      const lr = await fetch(`${BASE}/api/v2/customer/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: pu.email, password: PORTAL_PASSWORD }),
      });
      const ld: any = await lr.json().catch(() => ({}));
      const pt = ld.token ?? ld.data?.token;
      if (!pt) { bad('门户登录', `HTTP ${lr.status} ${JSON.stringify(ld).slice(0, 90)}`); }
      else {
        const ph = { Authorization: `Bearer ${pt}` };
        const lo = await fetch(`${BASE}/api/v2/customer/orders?limit=200`, { headers: ph });
        const lj: any = await lo.json().catch(() => ({}));
        const item = (lj.items ?? []).find((x: any) => x.id === target.id);
        if (!item) bad('门户列表命中靶子', `该单不在这一页（items=${(lj.items ?? []).length}）`);
        else if (R(item.orderAmount) === lineSum) ok('门户列表 orderAmount = Σ明细行', `${fmt(lineSum)}；字段 quoteAmount 已不在载荷里=${item.quoteAmount === undefined}`);
        else bad('门户列表 orderAmount = Σ明细行', `拿到 ${R(item.orderAmount)}，期望 ${lineSum}`);

        const d0 = await fetch(`${BASE}/api/v2/customer/orders/${target.id}`, { headers: ph });
        const dj: any = await d0.json().catch(() => ({}));
        const dsum = R((dj.lines ?? []).reduce((s: number, l: any) => s + Number(l.netValue ?? 0), 0));
        if (R(dj.order?.orderAmount) === lineSum && dsum === dj.order?.orderAmount) ok('门户详情：卡片金额 === 同页行表合计', `${fmt(lineSum)}（旧写法给 ${fmt(diverged)}，与行表差 ${fmt(DELTA)}）`);
        else bad('门户详情：卡片金额 === 同页行表合计', `卡片 ${R(dj.order?.orderAmount)} 行表 ${dsum}`);
      }
    } else info('门户两腿跳过：该单的 customerRelationId 没有可用门户账号');

    // ── ④-C 登记头 totalAmount（会写库，跑完删）─────────────
    const gen = await fetch(`${BASE}/api/v2/orders/${target.id}/generate-document`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' });
    const gj: any = await gen.json().catch(() => ({}));
    const docId = gj.document?.documentId ?? gj.document?.id ?? gj.file?.documentId;
    if (!gen.ok || !docId) bad('generate-document', `HTTP ${gen.status} ${JSON.stringify(gj).slice(0, 120)}`);
    else {
      createdDoc = docId;
      const doc: any = await prisma.tradeDocument.findUnique({ where: { id: docId }, select: { totalAmount: true, type: true, sourceRef: true } });
      if (R(doc?.totalAmount) === lineSum) ok('登记头 totalAmount = Σ明细行', `${fmt(lineSum)}（旧写法落库即错成 ${fmt(diverged)}）`);
      else bad('登记头 totalAmount = Σ明细行', `拿到 ${R(doc?.totalAmount)}，期望 ${lineSum}`);
      info(`临时文档 ${docId}（跑完删，含版本行与 PDF 文件）`);
    }
  } finally {
    // ── ⑤ 回滚 + 零残留回读 ────────────────────────────────
    await restore(orig, target.id);
    if (createdDoc) {
      const d: any = await prisma.tradeDocument.findUnique({ where: { id: createdDoc }, select: { filePath: true, id: true } }).catch(() => null);
      const abs = d?.filePath ? (fs.existsSync(d.filePath) ? d.filePath : `${REPO_ROOT}/uploads/${d.filePath}`) : null;
      if (abs && fs.existsSync(abs)) { fs.unlinkSync(abs); info(`PDF 已回收 ${abs.split('/').pop()}`); }
      else info(`PDF 未落盘或已不在：${String(abs).split('/').pop()}`);
      await prisma.documentVersion?.deleteMany?.({ where: { documentId: createdDoc } }).catch(() => undefined);
      await prisma.tradeDocument.delete({ where: { id: createdDoc } }).catch(() => undefined);
      const left = await prisma.tradeDocument.count({ where: { domain: 'orders', type: 'OrderConfirmation', sourceRef: target.id } });
      if (left === 0) ok('文档残留清零（跨通道回读）', `该单文档数=${left}`);
      else bad('文档残留清零', `还剩 ${left} 条 ⇒ 必须人工处理`);
    }
  }
  return finish();
}


async function restore(orig: any, id: string) {
  await prisma.order.update({ where: { id }, data: { quoteAmount: orig.quoteAmount, totalNet: orig.totalNet, contractAmount: orig.contractAmount } });
  const chk: any = await prisma.order.findUnique({ where: { id }, select: { quoteAmount: true, totalNet: true, contractAmount: true } });
  const same = R(chk.quoteAmount) === R(orig.quoteAmount) && R(chk.totalNet) === R(orig.totalNet) && R(chk.contractAmount) === R(orig.contractAmount);
  if (same) ok('主档三列已回滚到抓取时点原值', JSON.stringify(orig));
  else bad('主档三列回滚', `回读 ${JSON.stringify({ q: R(chk.quoteAmount), t: R(chk.totalNet), c: R(chk.contractAmount) })} ≠ ${JSON.stringify(orig)}`);
}

function finish() {
  const fails = rows.filter((r) => !r[0]);
  console.log('────────────────────────────────────────────');
  console.log(` 判定：${rows.length - fails.length}/${rows.length} 通过`);
  for (const [, n, d] of fails) console.log(`   ✗ ${n}${d ? ' — ' + d : ''}`);
  return fails.length;
}

main().then((code) => prisma.$disconnect().finally(() => process.exit(code))).catch(async (e) => {
  console.error(' 崩：', e?.message ?? e);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(3);
});
