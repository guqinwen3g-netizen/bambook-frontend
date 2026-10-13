// T7-3 收汇金额 ↔ 报关 FOB 勾稽 —— 真库只读验收（不建数据、无需回滚）
//
// 验的是**口径不变量**：
//   R1 所有差异 severity **恒为 'warning'**（口径 D：超差只预警不阻断）
//   R2 容差 = max(5% × FOB, 500) —— 脚本独立重算，与接口返回比对
//   R3 withinTolerance ⟺ |收汇 − 报关FOB| ≤ 容差
//   R4 剥离自洽：declaredFob = declaredGross − strippedFreight − strippedInsurance（有剥离时）
//   R5 订单不存在 → 404
//   R6 到期日门槛自洽：notYetDue ⟺ (paymentDueDate != null ∧ paymentDueDate >= today)
//   R7 **门槛是方向性的**：notYetDue=true 时**不得**出现「收汇少于 FOB / 尚无收汇」类差异；
//      「收汇多于 FOB」不受门槛影响（多收与到期日无关）
//
// 用法：node scripts/acceptance-t7-3-receipt-fob.mjs
const BASE = 'http://127.0.0.1:8081';
const PASSWORD = 'Bambook@2026';
const DEBUG = process.env.T7_DEBUG === '1';
const TODAY = new Date().toISOString().slice(0, 10);

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
  if (DEBUG && res.status >= 400) console.log(`    [diag] ${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return { status: res.status, data };
}

const round4 = (n) => Math.round(n * 10000) / 10000;

async function main() {
  const token = await login('charlie.qian@bambook.local');
  if (!token) { console.log('登录失败（charlie.qian 财务）'); process.exit(1); }
  console.log('══ T7-3 收汇 ↔ 报关 FOB 勾稽 · 真库只读验收 ══\n');

  // 样本：差异清单里的订单（覆盖面广）
  const list = await api(token, 'GET', '/api/v1/reconciliation/discrepancies?pageSize=200');
  if (list.status !== 200) { fail('GET /reconciliation/discrepancies', `HTTP ${list.status}`); return exit(); }
  const orderIds = [...new Set((list.data?.items ?? []).map(x => x.orderId).filter(Boolean))].slice(0, 10);
  pass('样本来源', `${orderIds.length} 个订单`);
  if (orderIds.length === 0) { info('无订单样本', '差异清单为空'); return exit(); }

  let withDiff = 0, zeroDiff = 0, stripped = 0, unStrippableSeen = 0, multiCur = 0;
  let notYetDueCount = 0, suppressedCount = 0;

  for (const oid of orderIds) {
    const r = await api(token, 'GET', `/api/v1/reconciliation/orders/${encodeURIComponent(oid)}/receipt-fob`);
    if (r.status !== 200) { fail(`收汇FOB ${oid}`, `HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`); continue; }
    const d = r.data;
    const rows = d.byCurrency ?? [];
    const ds = d.discrepancies ?? [];

    // R1 口径 D：全部 warning
    if (ds.every(x => x.severity === 'warning')) pass(`R1 ${oid} 差异全部 warning`, `${ds.length} 条 / ${rows.length} 币种`);
    else fail(`R1 ${oid}`, `存在非 warning：${JSON.stringify(ds.filter(x => x.severity !== 'warning').map(x => x.severity))}`);

    let allOk = true;
    for (const row of rows) {
      // R2 容差 = max(5% × FOB, 500)（脚本独立重算）
      const expectTol = round4(Math.max(0.05 * row.declaredFob, 500));
      if (Math.abs(round4(row.tolerance) - expectTol) < 0.0002) { /* ok */ }
      else { fail(`R2 ${oid}/${row.currency}`, `容差 ${row.tolerance} ≠ max(5%×${row.declaredFob}, 500) = ${expectTol}`); allOk = false; }

      // R3 withinTolerance 与差/容差自洽
      const diff = round4(row.receiptAmount - row.declaredFob);
      const expectWithin = Math.abs(diff) <= round4(row.tolerance) + 0.0001;
      if (expectWithin === row.withinTolerance) { /* ok */ }
      else { fail(`R3 ${oid}/${row.currency}`, `within=${row.withinTolerance} 但 |${diff}| vs 容差 ${row.tolerance}`); allOk = false; }

      // R4 剥离自洽
      const expectFob = round4(row.declaredGross - row.strippedFreight - row.strippedInsurance);
      if (Math.abs(round4(row.declaredFob) - expectFob) > 0.0002) {
        fail(`R4 ${oid}/${row.currency}`, `FOB ${row.declaredFob} ≠ 申报 ${row.declaredGross} − 运费 ${row.strippedFreight} − 保费 ${row.strippedInsurance} = ${expectFob}`);
        allOk = false;
      }
      if (row.strippedFreight > 0 || row.strippedInsurance > 0) stripped += 1;
      if ((row.unStrippable ?? []).length > 0) unStrippableSeen += 1;
    }
    if (rows.length > 1) multiCur += 1;
    if (allOk && rows.length > 0) pass(`R2/R3/R4 ${oid} 容差与剥离自洽`, rows.map(x => `${x.currency} 收 ${x.receiptAmount}/FOB ${x.declaredFob}/容差 ${x.tolerance}`).join(' | '));

    // ── R6 到期日门槛自洽 ────────────────────────────────────────────────
    const due = d.paymentDueDate ?? null;
    const dueShapeOk = due === null || /^\d{4}-\d{2}-\d{2}$/.test(due);
    const expectNotYetDue = due !== null && due >= TODAY;
    if (!dueShapeOk) fail(`R6 ${oid}`, `paymentDueDate 形状非法：${JSON.stringify(due)}`);
    else if (d.notYetDue !== expectNotYetDue) {
      fail(`R6 ${oid}`, `notYetDue=${d.notYetDue} 但到期日 ${due} vs 今天 ${TODAY} → 应为 ${expectNotYetDue}`);
    } else {
      pass(`R6 ${oid} 门槛自洽`, `到期日 ${due ?? '（无）'} / notYetDue=${d.notYetDue}`);
    }
    if (d.notYetDue) notYetDueCount += 1;

    // ── R7 方向性：未到期只压「收汇不足」，不压「多收」 ──────────────────
    if (d.notYetDue) {
      const shortSide = ds.filter(x => /收汇少于报关 FOB|尚无收汇记录/.test(x.message ?? ''));
      const overSide = ds.filter(x => /收汇多于报关 FOB/.test(x.message ?? ''));
      if (shortSide.length > 0) {
        fail(`R7 ${oid}`, `未到期却报了「收汇不足」${shortSide.length} 条：${shortSide[0].message.slice(0, 120)}`);
      } else {
        if (overSide.length > 0) suppressedCount += 1;
        pass(`R7 ${oid} 未到期只压不足方向`, overSide.length > 0 ? `仍报「多收」${overSide.length} 条（正确）` : '无差异');
      }
    } else if (ds.length > 0) {
      // 已到期/无到期日 → 不应存在「多收」被误压的迹象（无法直接验，记样本）
      suppressedCount += 0;
    }

    if (ds.length > 0) { withDiff += 1; if (withDiff <= 3) info(`  ${oid} 差异`, ds[0].message.slice(0, 130)); }
    else zeroDiff += 1;
  }

  // R5 不存在订单 → 404
  const nf = await api(token, 'GET', '/api/v1/reconciliation/orders/NOPE__x/receipt-fob');
  if (nf.status === 404) pass('R5 订单不存在 → 404', nf.data?.error?.code ?? '');
  else fail('R5', `期望 404，实际 ${nf.status}`);

  console.log('');
  info('样本统计', `${orderIds.length} 单：有差异 ${withDiff} / 零差异 ${zeroDiff} / 多币种 ${multiCur} / 发生过剥离 ${stripped} / 含不可剥票 ${unStrippableSeen} / 未到期(受门槛) ${notYetDueCount} / 未到期仍报多收 ${suppressedCount}`);
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
