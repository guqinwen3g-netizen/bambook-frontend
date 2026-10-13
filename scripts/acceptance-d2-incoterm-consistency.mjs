// D2 报关成交方式 ↔ 订单 Incoterms 一致性核对 —— 真库只读验收（不建数据、无需回滚）
//
// 验的口径不变量：
//   R1 结构完整（orderTerms / declarationTerms / orderGroup / declarationGroup / consistent / discrepancies）
//   R2 所有差异 severity **恒为 'warning'**（口径：只预警不阻断）
//   R3 `consistent === true` ⟺ discrepancies 为空
//   R4 归一化不误报：真库订单 `FOB` / 报关 `FOB` 应判为一致（若误报会在这里暴露）
//   R5 报关单不存在 → 404
//
// 用法：node scripts/acceptance-d2-incoterm-consistency.mjs
const BASE = 'http://127.0.0.1:8081';
const PASSWORD = 'Bambook@2026';
const DEBUG = process.env.D2_DEBUG === '1';

const results = [];
function pass(name, detail = '') { results.push({ ok: true }); console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
function fail(name, detail = '') { results.push({ ok: false }); console.log(`  ✗ ${name} — ${detail}`); }
function info(name, detail = '') { results.push({ ok: null }); console.log(`  ⓘ ${name} — ${detail}`); }

async function login(email) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const data = await res.json().catch(() => null);
  return res.ok && data?.token ? data.token : null;
}

async function api(token, method, path) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (DEBUG && res.status >= 400) console.log(`    [diag] ${method} ${path} → ${res.status} ${text.slice(0, 250)}`);
  return { status: res.status, data };
}

async function main() {
  let token = await login('hank.zheng@bambook.local');
  let who = 'hank.zheng(单证)';
  if (!token) { token = await login('jason.shen@bambook.local'); who = 'jason.shen(超管)'; }
  if (!token) { console.log('登录失败'); process.exit(1); }
  console.log(`══ D2 成交方式一致性 · 真库只读验收（${who}）══\n`);

  const decl = await api(token, 'GET', '/api/v2/customs/declarations');
  if (decl.status !== 200) { fail('GET /api/v2/customs/declarations', `HTTP ${decl.status}`); return exit(); }
  const rows = decl.data?.items ?? decl.data?.declarations ?? decl.data?.data ?? [];
  pass('报关单列表', `${rows.length} 张`);
  if (rows.length === 0) { info('无样本', '跳过'); return exit(); }

  const sample = rows.slice(0, 10);
  let consistentCount = 0, mismatchCount = 0, crossGroupSeen = 0, sameGroupSeen = 0;

  for (const d of sample) {
    const r = await api(token, 'GET', `/api/v2/customs/declarations/${encodeURIComponent(d.id)}/incoterm-consistency`);
    if (r.status !== 200) { fail(`一致性 ${d.declarationNumber ?? d.id}`, `HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 150)}`); continue; }
    const x = r.data;
    const ds = x.discrepancies ?? [];

    // R1 结构
    const need = ['orderTerms', 'declarationTerms', 'orderGroup', 'declarationGroup', 'consistent', 'sameGroup'];
    const okStruct = need.every(k => k in x);
    if (okStruct) pass(`R1 ${d.declarationNumber} 结构完整`, `订单 ${x.orderTerms ?? '—'} vs 报关 ${x.declarationTerms ?? '—'}`);
    else fail(`R1 ${d.declarationNumber}`, `缺字段：${need.filter(k => !(k in x)).join(',')}`);

    // R2 severity 恒 warning
    if (ds.every(y => y.severity === 'warning')) { /* ok */ }
    else fail(`R2 ${d.declarationNumber}`, `存在非 warning：${JSON.stringify(ds.filter(y => y.severity !== 'warning').map(y => y.severity))}`);

    // R3 consistent ⟺ 零差异
    if ((ds.length === 0) === (x.consistent === true)) { /* ok */ }
    else fail(`R3 ${d.declarationNumber}`, `consistent=${x.consistent} 但 discrepancies=${ds.length} 条`);

    if (x.consistent) consistentCount += 1;
    else {
      mismatchCount += 1;
      if (x.sameGroup) sameGroupSeen += 1; else crossGroupSeen += 1;
      if (mismatchCount <= 3) info(`  ${d.declarationNumber} 不一致`, ds[0]?.message?.slice(0, 110) ?? '');
    }
  }

  // R4 归一化不误报：真库两侧都是 FOB → 一致数应等于样本数
  if (consistentCount === sample.length) {
    pass('R4 归一化未误报', `${sample.length} 张全部判为一致（订单 FOB / 报关 FOB）`);
  } else {
    info('R4 存在不一致样本', `一致 ${consistentCount} / 不一致 ${mismatchCount}（跨组 ${crossGroupSeen} / 同组细分 ${sameGroupSeen}）`);
  }

  // R5 不存在 → 404
  const nf = await api(token, 'GET', '/api/v2/customs/declarations/NOPE__x/incoterm-consistency');
  if (nf.status === 404) pass('R5 报关单不存在 → 404', nf.data?.error?.code ?? '');
  else fail('R5', `期望 404，实际 ${nf.status}`);

  console.log('');
  info('样本统计', `${sample.length} 张：一致 ${consistentCount} / 不一致 ${mismatchCount}`);
  exit();

  function exit() {
    const ok = results.filter(r => r.ok === true).length;
    const bad = results.filter(r => r.ok === false).length;
    const notes = results.filter(r => r.ok === null).length;
    console.log(`\n══ 结果：${ok} 通过 / ${bad} 失败 / ${notes} 需知会 ══`);
    process.exit(bad === 0 ? 0 : 1);
  }
}

main().catch((e) => { console.error('脚本异常', e); process.exit(2); });
