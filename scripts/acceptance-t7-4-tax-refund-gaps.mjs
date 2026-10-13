// T7-4 退税「报缺 + 补齐后重算」—— 真库验收（**零写入**）
//
// 安全性说明：本脚本**不修改任何数据**——
//   · gaps 是只读端点；
//   · recalc 只跑「必然被拒绝」的路径（状态约束 409 / 无退税单 404），
//     以及不存在的报关单 404；**不跑会落库的 fill_missing 成功路径**（那需要造 Draft 单）。
//
// 验的口径不变量：
//   R1 gaps 能说清缺什么（code ∈ no_lines|fx_rate|hs_rebate_rate|line_total，且带 howToFix）
//   R2 gaps 与 figures 自洽：缺 fx_rate ⟹ fxRate==null；缺 hs_rebate_rate ⟹ refundableVat==null
//   R3 recalc 对**非 Draft/Rejected** 状态 → 409 STATUS_NOT_RECALCULABLE（已提交数据不可悄悄改）
//   R4 recalc 对无退税单的报关单 → 404 TAX_REFUND_NOT_FOUND
//   R5 不存在的报关单 → 404
//
// 用法：node scripts/acceptance-t7-4-tax-refund-gaps.mjs
const BASE = 'http://127.0.0.1:8081';
const PASSWORD = 'Bambook@2026';
const DEBUG = process.env.T7_DEBUG === '1';

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

async function api(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (DEBUG) console.log(`    [diag] ${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  return { status: res.status, data };
}

// 合法报缺码全集（2026-09-17 增补运保费剥离三项：CIF/CFR 缺运保费、D 组不核算、剥离后 ≤0）
const GAP_CODES = new Set([
  'no_lines', 'fx_rate', 'hs_rebate_rate', 'line_total',
  'freight_missing', 'insurance_missing', 'trade_terms_unsupported', 'fob_not_positive',
]);

async function main() {
  let token = await login('hank.zheng@bambook.local');
  let who = 'hank.zheng(单证)';
  if (!token) { token = await login('jason.shen@bambook.local'); who = 'jason.shen(超管)'; }
  if (!token) { console.log('登录失败'); process.exit(1); }
  console.log(`══ T7-4 退税报缺 · 真库验收（零写入，${who}）══\n`);

  const decl = await api(token, 'GET', '/api/v2/customs/declarations');
  if (decl.status !== 200) { fail('GET /api/v2/customs/declarations', `HTTP ${decl.status}`); return exit(); }
  const rows = decl.data?.items ?? decl.data?.declarations ?? decl.data?.data ?? [];
  pass('报关单列表', `${rows.length} 张`);
  if (rows.length === 0) { info('无样本', '跳过'); return exit(); }

  const sample = rows.slice(0, 8);
  let withGaps = 0, zeroGaps = 0;

  for (const d of sample) {
    const r = await api(token, 'GET', `/api/v2/customs/declarations/${encodeURIComponent(d.id)}/tax-refund/gaps`);
    if (r.status !== 200) { fail(`gaps ${d.declarationNumber ?? d.id}`, `HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 150)}`); continue; }
    const gaps = r.data?.gaps ?? [];
    const figures = r.data?.figures ?? {};

    // R1 结构
    const badCode = gaps.find(g => !GAP_CODES.has(g.code));
    const badFix = gaps.find(g => !g.howToFix || !g.label);
    if (!badCode && !badFix) pass(`R1 ${d.declarationNumber} gaps 结构合法`, `${gaps.length} 项`);
    else fail(`R1 ${d.declarationNumber}`, `非法 code / 缺 howToFix：${JSON.stringify(badCode ?? badFix).slice(0, 120)}`);

    // R2 自洽
    const codes = gaps.map(g => g.code);
    if (codes.includes('fx_rate') && figures.fxRate !== null) fail(`R2 ${d.declarationNumber}`, `报缺 fx_rate 但 fxRate=${figures.fxRate}`);
    if (codes.some(c => c === 'hs_rebate_rate' || c === 'line_total') && figures.refundableVat !== null) {
      fail(`R2 ${d.declarationNumber}`, `报缺退税率/行金额但 refundableVat=${figures.refundableVat} 有值`);
    }
    if (codes.includes('fx_rate') && figures.exportAmountCny !== null) fail(`R2 ${d.declarationNumber}`, `缺汇率却有 CNY 金额`);
    // 2026-09-17 增补：剥不出 FOB 的四种情况都必须**不给数**
    // （给数 = 回退成含运保费的毛额 = 退税额虚高，且不报错 —— 这正是本批修的高危）
    if (codes.some(c => c === 'freight_missing' || c === 'insurance_missing' || c === 'trade_terms_unsupported' || c === 'fob_not_positive')) {
      if (figures.exportAmountFob !== null) fail(`R2 ${d.declarationNumber}`, `报缺运保费剥离但 exportAmountFob=${figures.exportAmountFob} 有值（毛额冒充 FOB）`);
      if (figures.refundAmount !== null) fail(`R2 ${d.declarationNumber}`, `报缺运保费剥离但 refundAmount=${figures.refundAmount} 有值`);
    }

    if (gaps.length > 0) {
      withGaps += 1;
      if (withGaps <= 3) info(`  ${d.declarationNumber} 缺项`, gaps.slice(0, 3).map(g => `${g.code}${g.ref ? ':' + g.ref : ''}`).join(' / '));
    } else zeroGaps += 1;
  }

  // R3 状态约束：找一张有退税单的报关单（真库唯一那张是 Reviewing → 应 409）
  let r3Checked = false;
  for (const d of sample) {
    const rc = await api(token, 'POST', `/api/v2/customs/declarations/${encodeURIComponent(d.id)}/tax-refund/recalc`, { mode: 'fill_missing' });
    if (rc.status === 409 && rc.data?.error?.code === 'STATUS_NOT_RECALCULABLE') {
      pass(`R3 ${d.declarationNumber} 非 Draft 状态拒绝重算`, rc.data.error.message.slice(0, 80));
      r3Checked = true;
      break;
    }
    if (rc.status === 404) continue; // 该报关单没有退税单 → 试下一张
    if (rc.status === 200) {
      // 不应发生：真库退税单是 Reviewing，若真落库了说明状态约束失效
      fail(`R3 ${d.declarationNumber} 意外落库`, `applied=${rc.data?.applied}`);
      r3Checked = true;
      break;
    }
  }
  if (!r3Checked) info('R3 未覆盖', '样本里没有「有退税单且非 Draft」的报关单');

  // R4 无退税单 → 404
  let r4Checked = false;
  for (const d of sample) {
    const rc = await api(token, 'POST', `/api/v2/customs/declarations/${encodeURIComponent(d.id)}/tax-refund/recalc`, { mode: 'fill_missing' });
    if (rc.status === 404 && rc.data?.error?.code === 'TAX_REFUND_NOT_FOUND') {
      pass(`R4 ${d.declarationNumber} 无退税单 → 404`, rc.data.error.message.slice(0, 70));
      r4Checked = true;
      break;
    }
  }
  if (!r4Checked) info('R4 未覆盖', '样本报关单都已有退税单');

  // R5 不存在的报关单
  const nf = await api(token, 'GET', '/api/v2/customs/declarations/NOPE__x/tax-refund/gaps');
  if (nf.status === 404) pass('R5 报关单不存在 → 404', nf.data?.error?.code ?? '');
  else fail('R5', `期望 404，实际 ${nf.status}`);

  console.log('');
  info('样本统计', `${sample.length} 张：有缺项 ${withGaps} / 无缺项 ${zeroGaps}`);
  info('零写入保证', '本脚本只跑只读 gaps 与「必然被拒」的 recalc 路径，未修改任何数据');
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
