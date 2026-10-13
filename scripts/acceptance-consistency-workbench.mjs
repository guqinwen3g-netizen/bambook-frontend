// 核对工作台 · 取数路径验收（真库只读，不建数据）
//
// 工作台按「对象类型」自动展示适用的核对项，三条取数路径：
//   订单   → 收汇↔报关 FOB（T7-③）
//   运单   → 三单一致（T7-②）
//   报关单 → 退税报缺（T7-④）+ 成交方式一致性（D2）**并行**
// 本脚本用真库样本把这**三条路径各跑一次**，证明工作台一次点击能拿到全部数据。
// （各端点的口径不变量已由 T7-2/3/4、D2 各自的验收脚本覆盖，此处只验**组合可用性**。）
//
// 用法：node scripts/acceptance-consistency-workbench.mjs
const BASE = 'http://127.0.0.1:8081';
const PASSWORD = 'Bambook@2026';
const DEBUG = process.env.WB_DEBUG === '1';

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
  if (DEBUG && res.status >= 400) console.log(`    [diag] ${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  return { status: res.status, data };
}

async function main() {
  let token = await login('jason.shen@bambook.local');
  const who = 'jason.shen(超管)';
  if (!token) { token = await login('hank.zheng@bambook.local'); }
  if (!token) { console.log('登录失败'); process.exit(1); }
  console.log(`══ 核对工作台 · 取数路径验收（真库只读，${who}）══\n`);

  // ── 下拉数据源（工作台的三个列表）──
  const orders = await api(token, 'GET', '/api/v1/orders?limit=50');
  const shipments = await api(token, 'GET', '/api/v1/shipping?limit=100');
  const decls = await api(token, 'GET', '/api/v2/customs/declarations');
  const orderRows = orders.data?.items ?? orders.data?.orders ?? [];
  const shipRows = shipments.data?.items ?? [];
  const declRows = decls.data?.items ?? decls.data?.declarations ?? [];
  if (orders.status === 200 && shipRows.length > 0) pass('下拉数据源 · 订单', `${orderRows.length} 条`);
  else fail('下拉数据源 · 订单', `HTTP ${orders.status} / ${orderRows.length} 条`);
  if (shipments.status === 200 && shipRows.length > 0) pass('下拉数据源 · 运单', `${shipRows.length} 条`);
  else fail('下拉数据源 · 运单', `HTTP ${shipments.status} / ${shipRows.length} 条`);
  if (decls.status === 200 && declRows.length > 0) pass('下拉数据源 · 报关单', `${declRows.length} 条`);
  else fail('下拉数据源 · 报关单', `HTTP ${decls.status} / ${declRows.length} 条`);
  if (orderRows.length === 0 || shipRows.length === 0 || declRows.length === 0) { info('样本不足', '跳过路径验证'); return exit(); }

  // ── 路径 1：订单 → 收汇↔报关 FOB ──
  const oid = orderRows[0].id;
  const p1 = await api(token, 'GET', `/api/v1/reconciliation/orders/${encodeURIComponent(oid)}/receipt-fob`);
  if (p1.status === 200 && Array.isArray(p1.data?.byCurrency)) {
    pass('路径1 订单 → 收汇↔报关 FOB', `${orderRows[0].code ?? oid} · ${p1.data.byCurrency.length} 币种 / ${p1.data.discrepancies?.length ?? 0} 差异`);
  } else fail('路径1', `HTTP ${p1.status} ${JSON.stringify(p1.data).slice(0, 140)}`);

  // ── 路径 2：运单 → 三单一致 ──
  const sid = shipRows[0].id;
  const p2 = await api(token, 'GET', `/api/v2/customs/shipments/${encodeURIComponent(sid)}/triple-consistency`);
  if (p2.status === 200 && p2.data?.documents) {
    pass('路径2 运单 → 三单一致', `${shipRows[0].shipmentNumber ?? sid} · 齐 ${['packingList', 'commercialInvoice', 'customsDeclaration'].filter(k => p2.data.documents[k]).length}/3 / ${p2.data.discrepancies?.length ?? 0} 差异`);
  } else fail('路径2', `HTTP ${p2.status} ${JSON.stringify(p2.data).slice(0, 140)}`);

  // ── 路径 3：报关单 → 退税报缺 + 成交方式一致性（**并行**，工作台实际是 Promise.all）──
  const did = declRows[0].id;
  const [g, inc] = await Promise.all([
    api(token, 'GET', `/api/v2/customs/declarations/${encodeURIComponent(did)}/tax-refund/gaps`),
    api(token, 'GET', `/api/v2/customs/declarations/${encodeURIComponent(did)}/incoterm-consistency`),
  ]);
  if (g.status === 200 && Array.isArray(g.data?.gaps)) {
    pass('路径3a 报关单 → 退税报缺', `${declRows[0].declarationNumber ?? did} · ${g.data.gaps.length} 项缺`);
  } else fail('路径3a', `HTTP ${g.status} ${JSON.stringify(g.data).slice(0, 140)}`);
  if (inc.status === 200 && 'consistent' in (inc.data ?? {})) {
    pass('路径3b 报关单 → 成交方式一致性', `${inc.data.orderTerms ?? '—'} vs ${inc.data.declarationTerms ?? '—'} · ${inc.data.consistent ? '一致' : '有差异'}`);
  } else fail('路径3b', `HTTP ${inc.status} ${JSON.stringify(inc.data).slice(0, 140)}`);

  // ── 只预警不阻断：四类差异的 severity 必须都是 warning ──
  const allD = [
    ...(p1.data?.discrepancies ?? []),
    ...(p2.data?.discrepancies ?? []),
    ...(inc.data?.discrepancies ?? []),
  ];
  if (allD.every(d => d.severity === 'warning')) pass('口径：全部差异 severity = warning（只预警不阻断）', `${allD.length} 条`);
  else fail('口径', `存在非 warning：${JSON.stringify(allD.filter(d => d.severity !== 'warning').map(d => d.severity))}`);

  console.log('');
  info('说明', '各端点口径不变量由 T7-2/3/4、D2 各自的验收脚本覆盖；此处只验工作台组合取数可用');
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
