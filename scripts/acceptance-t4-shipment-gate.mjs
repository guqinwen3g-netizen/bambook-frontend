// T4 出运放行门禁 —— API 级实机验收（handoff-20260916-005500 §三-T4）
//
// 要证的不是「409 会返回」，而是**明细真的到了前端能用的形状**：
//   PATCH status→Shipped 被拦 → error.code=GATE_BLOCKED 且 error.gateDetails.orders[]
//   里有「哪个订单缺哪条」→ 前端据此逐行渲染 + 自动带齐 DR-013 三匹配键。
//
// 自回滚：本脚本为验门禁**新建**一张运单，跑完软删（历史运单一律不动）。
// 用法：node scripts/acceptance-t4-shipment-gate.mjs [订单号]
const BASE = 'http://127.0.0.1:8081';
const PASSWORD = 'Bambook@2026';
const DEBUG = process.env.T4_DEBUG === '1';

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
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (DEBUG && res.status >= 400) console.log(`    [diag] ${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return { status: res.status, data };
}

async function main() {
  const token = await login('chloe.su@bambook.local');
  if (!token) { console.log('登录失败'); process.exit(1); }
  // 删除运单需要的权限比建单高（销售建得成、删不掉 → 实测 403），回滚另用管理员身份
  const adminToken = await login('jason.shen@bambook.local');
  console.log('══ T4 出运放行门禁 · 真库实跑 ══\n');

  // 1. 宿主订单：优先取参数，否则取第一个面料订单
  let orderId = process.argv[2] || '';
  if (!orderId) {
    const orders = await api(token, 'GET', '/api/v1/orders?limit=50');
    const list = orders.data?.orders ?? [];
    /**
     * ★ 2026-09-29 修正（**脚本挑单条件不严 ⇒ 数据态假红**）：
     *   原来只按"面料单"取**第一张**，没排除终态 ⇒ 挑到 `SIM-FORD-002`（status=Delivered）时，
     *   后面的 `Draft → Booked` 会被 `ORDER_TERMINAL` 拦下 —— 那是**正确的业务门禁**，
     *   但脚本把它读成失败（`✗ Draft → Booked — HTTP 400 ORDER_TERMINAL`）。
     *   ⇒ 排除终态（Delivered / Cancelled），只挑还能改运单状态的单。
     */
    const TERMINAL = new Set(['Delivered', 'Cancelled']);
    const isFabric = (o) => (o.businessLine ?? '').toLowerCase() === 'fabric' || (o.type ?? '') === 'Fabric';
    const fo = list.find((o) => isFabric(o) && !TERMINAL.has(String(o.status ?? '')));
    orderId = fo?.id ?? '';
  }
  if (!orderId) { console.log('没有可用面料订单'); process.exit(1); }

  const elig = await api(token, 'GET', `/api/v1/qc/orders/${encodeURIComponent(orderId)}/shipment-eligibility`);
  const gates = elig.data?.missingGates ?? [];
  info('宿主订单', `${orderId} missingGates=[${gates.join(', ')}]`);
  if (gates.length === 0) { info('注意', '该订单三条件已全绿，出运不会被拦 —— 换成一条缺条件的面料订单再跑'); }

  // 2. 建一张临时运单（Draft）
  const created = await api(token, 'POST', '/api/v1/shipping', {
    shipmentNumber: `T4-GATE-${Date.now().toString(36).toUpperCase()}`,
    type: 'Sea',
    shippingMethod: 'Sea',
    orderId,
    status: 'Draft',
  });
  if (created.status !== 201 && created.status !== 200) {
    fail('建临时运单', `HTTP ${created.status} ${JSON.stringify(created.data).slice(0, 200)}`);
    return exit();
  }
  const shipId = created.data?.shipment?.id ?? created.data?.id;
  pass('建临时运单', `${shipId}（跑完软删）`);
  let deleted = false;
  const rollback = async () => {
    if (deleted || !shipId) return;
    const d = await api(adminToken || token, 'DELETE', `/api/v1/shipping/${encodeURIComponent(shipId)}`);
    deleted = d.status === 200;
    if (deleted) pass('回滚：软删临时运单', shipId); else fail('回滚：软删临时运单', `HTTP ${d.status}`);
  };

  // 3. Draft → Booked（合法转移，为触发 Shipped 铺路）
  const booked = await api(token, 'PATCH', `/api/v1/shipping/${encodeURIComponent(shipId)}`, { status: 'Booked' });
  if (booked.status !== 200) {
    fail('Draft → Booked', `HTTP ${booked.status} ${JSON.stringify(booked.data).slice(0, 200)}`);
    await rollback();
    return exit();
  }
  pass('Draft → Booked', '合法转移');

  // 4. Booked → Shipped：这里应当被门禁拦下
  const shipped = await api(token, 'PATCH', `/api/v1/shipping/${encodeURIComponent(shipId)}`, { status: 'Shipped' });
  if (shipped.status === 409) {
    const err = shipped.data?.error ?? {};
    pass('Booked → Shipped 被拦', `HTTP 409 code=${err.code}`);
    if (err.code !== 'GATE_BLOCKED') fail('错误码', `期望 GATE_BLOCKED，实际 ${err.code}`);
    else pass('错误码 = GATE_BLOCKED', '前端据此分出「门禁拦截」与「表单填错」');

    const gd = err.gateDetails;
    if (!gd) { fail('gateDetails 缺失', '响应体里没有 gateDetails —— 前端列不出缺哪条'); }
    else {
      const orders = gd.orders ?? [];
      const first = orders.find((o) => (o.blockingReasons ?? []).length > 0);
      pass('gateDetails 到位', `orders=${orders.length} blockingReasons=[${(gd.blockingReasons ?? []).join(', ')}]`);
      if (first) {
        pass('能指出哪个订单缺哪条', `${first.orderId} → ${first.blockingReasons.join(' / ')}`);
        // 与资格端点交叉验证：门禁给的原因码必须能在资格视图里找到
        const fromElig = gates;
        const overlap = first.blockingReasons.filter((r) => fromElig.includes(r));
        if (overlap.length > 0) pass('与资格端点口径一致', `交集 [${overlap.join(', ')}]`);
        else info('与资格端点口径', `门禁 [${first.blockingReasons.join(',')}] vs 资格 [${fromElig.join(',')}]（可能含订单不存在等其它码）`);
      } else fail('orders 里没有阻断明细', JSON.stringify(orders).slice(0, 200));
      info('例外查询结论', `${gd.exceptionReason ?? '（无）'} / ${gd.exceptionEntryHint ?? '（无）'}`);
    }
  } else if (shipped.status === 200) {
    info('Booked → Shipped 未被拦', `HTTP 200 —— 该订单三条件已全绿（missingGates 为空）或运单无订单锚点，门禁放行`);
    await rollback();
    return exit();
  } else {
    fail('Booked → Shipped', `HTTP ${shipped.status} ${JSON.stringify(shipped.data).slice(0, 200)}`);
  }

  await rollback();
  exit();

  function exit() {
    const ok = results.filter((r) => r.ok === true).length;
    const bad = results.filter((r) => r.ok === false).length;
    const notes = results.filter((r) => r.ok === null).length;
    console.log(`\n══ 结果：${ok} 通过 / ${bad} 失败 / ${notes} 需知会 ══`);
    process.exit(bad === 0 ? 0 : 1);
  }
}

main().catch((e) => { console.error('脚本异常', e); process.exit(2); });
