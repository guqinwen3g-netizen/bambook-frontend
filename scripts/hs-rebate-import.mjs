// HS 编码出口退税率 —— 补录 + **自校验**（T7-4 退税功能的生产前置）
//
// 为什么需要这个脚本（而不是手工在 UI 里点 7 次）：
//   真库盘点（2026-09-16）发现报关行用到的 **7 个 HS 编码连档案都不存在**，
//   故退税金额恒为 null。手工补录有两个**静默失败**陷阱，肉眼看不出来：
//     ① 归一化只去「点与空格」、**不比位数** —— 档案写 `6204.43.0000`(10位)
//        而报关行是 `6204.43.00`(8位) → 归一化后 `6204430000` ≠ `62044300` → **仍然失配**；
//     ② 档案里存在**归一化后重复**的编码（如 `52093900` 与 `5209.39.00`）→ 命中哪条不确定。
//   所以「录完」不等于「生效」。本脚本把补录与**用真实报缺端点回验**绑在一起。
//
// ⚠️ 本脚本**不提供任何退税率默认值**：rate 缺失/非数字一律拒绝。
//    退税率是税则事实，必须由业务/财务确认（历史上有 16/15/13 多档）。
//
// 用法：
//   node scripts/hs-rebate-import.mjs --emit-template docs/hs-rebate-rates.json
//       从真库生成待填模板（rebateRate 全为 null）
//   node scripts/hs-rebate-import.mjs --rates-file docs/hs-rebate-rates.json
//       预检（dry-run）：分类 CREATE/UPDATE/SKIP + 报重复/位数陷阱，**不写库**
//   node scripts/hs-rebate-import.mjs --rates-file docs/hs-rebate-rates.json --apply
//       写入（POST 新增 / PUT 更新），随后自动回验
//   node scripts/hs-rebate-import.mjs --verify-only
//       只回验当前档案对报关行的覆盖率（不写库）
//
// 退出码：0 = 通过；1 = 有失败；2 = 脚本异常
const BASE = process.env.BAMBOOK_API || 'http://127.0.0.1:8081';
const PASSWORD = 'Bambook@2026';
const LOGINS = ['hank.zheng@bambook.local', 'jason.shen@bambook.local'];
const DEBUG = process.env.HS_DEBUG === '1';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const argOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

const results = [];
const pass = (n, d = '') => { results.push({ ok: true }); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n, d = '') => { results.push({ ok: false }); console.log(`  ✗ ${n} — ${d}`); };
const info = (n, d = '') => { results.push({ ok: null }); console.log(`  ⓘ ${n} — ${d}`); };

/** 与服务端 taxRefundCalcService.normHs 逐字一致（改了那边必须同步改这里） */
const normHs = (c) => String(c ?? '').replace(/[.\s]/g, '').toUpperCase();

async function login() {
  for (const email of LOGINS) {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.token) return { token: data.token, email };
  }
  return null;
}

async function api(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (DEBUG) console.log(`    [diag] ${method} ${path} → ${res.status} ${text.slice(0, 220)}`);
  return { status: res.status, data };
}

let prisma = null;
async function connectPrisma() {
  const { createRequire } = await import('node:module');
  const req = createRequire('/Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/');
  const { PrismaClient } = req('@prisma/client');
  prisma = new PrismaClient();
}

/** 真库：报关行实际用到的 HS 编码 → { 原始写法: { 出现次数, 品名样本 } } */
async function usedHsCodes() {
  const lines = await prisma.customsDeclarationLine.findMany({
    select: { hsCode: true, productName: true },
    where: { hsCode: { not: null } },
  });
  const map = new Map();
  for (const l of lines) {
    const raw = String(l.hsCode ?? '').trim();
    if (!raw) continue;
    const cur = map.get(raw) ?? { raw, count: 0, samples: new Set() };
    cur.count += 1;
    if (l.productName) cur.samples.add(String(l.productName).trim());
    map.set(raw, cur);
  }
  return map;
}

/** 真库：HS 档案（含归一化键 → 检出重复） */
async function archive() {
  const rows = await prisma.hsCode.findMany({
    select: { id: true, code: true, description: true, category: true, exportTaxRebateRate: true, isActive: true },
  });
  const byNorm = new Map();
  const dups = [];
  for (const r of rows) {
    const k = normHs(r.code);
    if (byNorm.has(k)) dups.push([byNorm.get(k).code, r.code, k]);
    else byNorm.set(k, r);
  }
  return { rows, byNorm, dups };
}

// ─────────────────────────────────────────────────────────────────────────
async function emitTemplate(path) {
  const used = await usedHsCodes();
  const out = {};
  for (const [raw, v] of [...used.entries()].sort((a, b) => b[1].count - a[1].count)) {
    out[raw] = {
      rebateRate: null, // ← 必填：由业务/财务按税则确认（本脚本不提供默认值）
      description: [...v.samples][0] ?? '',
      category: '',      // ← 必填：Textile | Garment | Accessory | Material | Yarn | Other
      _usedByDeclarationLines: v.count,
      _goodsSamples: [...v.samples].slice(0, 4),
    };
  }
  const fs = await import('node:fs');
  fs.writeFileSync(path, JSON.stringify(out, null, 2) + '\n', 'utf8');
  pass('生成待填模板', `${path}（${Object.keys(out).length} 个编码，rebateRate 全为 null）`);
  info('下一步', '请业务/财务按税则填 rebateRate + category 后，跑 --rates-file 预检');
}

/** 预检：分类 + 陷阱检测（不写库） */
async function preflight(ratesFile) {
  const fs = await import('node:fs');
  if (!fs.existsSync(ratesFile)) { fail('读入税率文件', `不存在：${ratesFile}`); return null; }
  let rates;
  try { rates = JSON.parse(fs.readFileSync(ratesFile, 'utf8')); }
  catch (e) { fail('解析税率文件', e?.message); return null; }

  const entries = Object.entries(rates);
  pass('读入税率文件', `${ratesFile}（${entries.length} 条）`);

  const { rows, byNorm, dups } = await archive();
  pass('HS 档案现状', `${rows.length} 条`);

  // 陷阱②：归一化重复
  if (dups.length) {
    for (const [a, b, k] of dups) fail('档案存在归一化重复编码', `${a} 与 ${b} 归一化后同为 ${k} → 命中不确定，请先合并`);
  } else pass('档案无归一化重复', '（命中唯一）');

  const used = await usedHsCodes();
  const usedByNorm = new Map([...used.entries()].map(([raw, v]) => [normHs(raw), { raw, ...v }]));

  const plan = [];
  for (const [rawCode, v] of entries) {
    const rate = v?.rebateRate;
    if (rate === null || rate === undefined || rate === '' || Number.isNaN(Number(rate))) {
      fail(`税率缺失 ${rawCode}`, '本脚本不猜税率 —— 必须填确认值');
      continue;
    }
    const num = Number(rate);
    if (num < 0 || num > 100) { fail(`税率越界 ${rawCode}`, `${num}（应在 0–100）`); continue; }
    if (!v?.category) { fail(`缺 category ${rawCode}`, 'Textile|Garment|Accessory|Material|Yarn|Other'); continue; }
    if (!v?.description) { fail(`缺 description ${rawCode}`, ''); continue; }

    // 陷阱①：归一化后**匹配不上报关行实际写法**。
    // ⚠️ 勿改回「归一化相等但长度不等」的判定 —— 那恒为假（相等则长度必等），是逻辑空集，
    //    会让 10 位 vs 8 位这种静默失配完全漏过（本脚本首版就踩了，被 T2 用例抓出）。
    // 命中不了报关行写法时，再找**前缀近似**（同前导数字、位数不同）——那才是静默失配
    const key = normHs(rawCode);
    const u = usedByNorm.get(key);
    if (!u) {
      const nearMiss = [...usedByNorm.entries()]
        .filter(([k]) => k !== key && (k.startsWith(key) || key.startsWith(k)))
        .map(([k, v2]) => ({ k, raw: v2.raw, n: v2.count }));
      if (nearMiss.length > 0) {
        fail(`位数/写法不一致 ${rawCode}`, `归一化后 ${key}(${key.length}位) 匹配不上报关行 —— 近似写法：`
          + nearMiss.map(m => `${m.raw}(${m.k.length}位, ${m.n}行)`).join('、')
          + ' → **补进去也查不到退税率**，请与报关行写法对齐');
        continue;
      }
      // 无近似写法：该编码当前未被任何报关行使用（可能是新增编码），照常补录
    }

    const existing = byNorm.get(normHs(rawCode));
    const action = !existing ? 'CREATE'
      : (existing.exportTaxRebateRate != null && Number(existing.exportTaxRebateRate) === num && existing.isActive)
        ? 'SKIP'
        : 'UPDATE';
    plan.push({ rawCode, num, v, existing, action, usedCount: u?.count ?? 0 });
  }

  const nCreate = plan.filter(p => p.action === 'CREATE').length;
  const nUpdate = plan.filter(p => p.action === 'UPDATE').length;
  const nSkip = plan.filter(p => p.action === 'SKIP').length;
  info('预检计划', `CREATE ${nCreate} / UPDATE ${nUpdate} / SKIP ${nSkip}`);
  for (const p of plan) {
    console.log(`      ${p.action.padEnd(6)} ${p.rawCode.padEnd(14)} rate=${p.num}  （报关行用到 ${p.usedCount} 行）`);
  }
  return plan;
}

async function applyPlan(plan, token) {
  let created = 0, updated = 0;
  for (const p of plan) {
    if (p.action === 'SKIP') continue;
    const body = {
      code: p.rawCode,
      description: p.v.description,
      category: p.v.category,
      exportTaxRebateRate: p.num,
      isActive: true,
    };
    if (p.action === 'CREATE') {
      const r = await api(token, 'POST', '/api/v2/customs/hs-codes', body);
      if (r.status === 201) { created++; pass(`新增 ${p.rawCode}`, `rate=${p.num}`); }
      else fail(`新增 ${p.rawCode}`, `HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
    } else {
      const r = await api(token, 'PUT', `/api/v2/customs/hs-codes/${encodeURIComponent(p.existing.id)}`, body);
      if (r.status === 200) { updated++; pass(`更新 ${p.rawCode}`, `rate=${p.num}`); }
      else fail(`更新 ${p.rawCode}`, `HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
    }
  }
  info('写入汇总', `新增 ${created} / 更新 ${updated} / 跳过 ${plan.filter(p => p.action === 'SKIP').length}`);
}

/**
 * 回验：用**真实报缺端点**确认覆盖率 —— 不看档案字段，看接口是否还报缺。
 * 这是唯一可信的判据：归一化/位数/active 三个陷阱都会在这里暴露。
 */
async function verify(token) {
  const used = await usedHsCodes();
  const { byNorm } = await archive();

  // ① 档案层面：归一化后是否每条报关行编码都有非空退税率
  let covered = 0;
  const uncovered = [];
  for (const [raw, v] of used.entries()) {
    const hit = byNorm.get(normHs(raw));
    if (hit && hit.isActive && hit.exportTaxRebateRate != null) covered++;
    else uncovered.push(`${raw}(x${v.count})`);
  }
  if (uncovered.length === 0) pass('回验① 档案覆盖报关行全部编码', `${covered}/${used.size}`);
  else fail('回验① 仍有未覆盖编码', uncovered.join(' / '));

  // ② 接口层面：抽查用到了这些编码的报关单，看 gaps 里还有没有 hs_rebate_rate
  const decls = await prisma.customsDeclaration.findMany({
    where: { deletedAt: null, lines: { some: { hsCode: { not: null } } } },
    select: { id: true, declarationNumber: true },
    take: 6,
  });
  let clean = 0;
  for (const d of decls) {
    const r = await api(token, 'GET', `/api/v2/customs/declarations/${encodeURIComponent(d.id)}/tax-refund/gaps`);
    if (r.status !== 200) { fail(`回验② ${d.declarationNumber}`, `HTTP ${r.status}`); continue; }
    const hsGaps = (r.data?.gaps ?? []).filter(g => g.code === 'hs_rebate_rate');
    if (hsGaps.length === 0) { clean++; pass(`回验② ${d.declarationNumber} 无 HS 退税率缺项`, `refundableVat=${r.data?.figures?.refundableVat}`); }
    else fail(`回验② ${d.declarationNumber} 仍报缺`, hsGaps.map(g => g.label).join('；').slice(0, 160));
  }
  if (decls.length === 0) info('回验② 无样本报关单', '跳过');
  return uncovered.length === 0;
}

async function main() {
  const tplPath = argOf('--emit-template');
  const ratesFile = argOf('--rates-file');
  const apply = has('--apply');
  const verifyOnly = has('--verify-only');

  if (!tplPath && !ratesFile && !verifyOnly) {
    console.log('用法：');
    console.log('  --emit-template <file>          从真库生成待填模板');
    console.log('  --rates-file <file> [--apply]   预检 / 写入（默认 dry-run）');
    console.log('  --verify-only                   只回验覆盖率');
    process.exit(0);
  }

  await connectPrisma();

  if (tplPath) { console.log('══ 生成待填模板 ══\n'); await emitTemplate(tplPath); return; }

  const auth = await login();
  if (!auth) { fail('登录', LOGINS.join(' / ')); return; }
  info('登录', auth.email);

  if (verifyOnly) {
    console.log('══ 回验覆盖率（不写库）══\n');
    await verify(auth.token);
    return;
  }

  console.log(`══ HS 退税率补录 ${apply ? '（**写入**）' : '（dry-run，不写库）'} ══\n`);
  const plan = await preflight(ratesFile);
  if (!plan) return;

  if (!apply) {
    info('dry-run 结束', '确认无误后加 --apply 执行写入');
    return;
  }
  if (plan.length === 0) { fail('无可执行项', '预检未通过任何条目'); return; }

  console.log('\n── 写入 ──');
  await applyPlan(plan, auth.token);

  console.log('\n── 回验（真实报缺端点）──');
  await verify(auth.token);
}

try {
  await main();
} catch (e) {
  console.error('脚本异常', e);
  fail('脚本异常', String(e).slice(0, 300));
} finally {
  const ok = results.filter(r => r.ok === true).length;
  const bad = results.filter(r => r.ok === false).length;
  const notes = results.filter(r => r.ok === null).length;
  console.log(`\n══ 结果：${ok} 通过 / ${bad} 失败 / ${notes} 需知会 ══`);
  if (prisma) await prisma.$disconnect().catch(() => {});
  process.exit(bad === 0 ? 0 : 1);
}
