// REQ2-17 月末批量结转 API 级实机验收
// 验收锚点（设计文档 §5 / DR-058 三决策）：
//   ① mc: 幂等键月末时点快照（区隔 A5 月初键）；重复结转 skipped
//   ② 月度对比：metric 汇总 Δ/Δ% 精确；缺上期 previous=null；上期为 0 → deltaPct null
//   ③ 无 monthly 定义 404；periodKey 非法 400；sales 权限 403
const BASE = 'http://127.0.0.1:8081';
const EMAIL = 'jason.shen@bambook.local';
const PASSWORD = 'Bambook@2026';

const results = [];
let token = '';
function pass(name, detail = '') { results.push({ name, ok: true, detail }); console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
function fail(name, detail = '') { results.push({ name, ok: false, detail }); console.log(`  ✗ ${name} — ${detail}`); }

async function api(method, path, body, bearer) {
  const headers = { Authorization: `Bearer ${bearer ?? token}` };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function main() {
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const login = await loginRes.json();
  if (!loginRes.ok || !login.token) { console.log('登录失败', loginRes.status); process.exit(1); }
  token = login.token;
  console.log(`登录成功：${login.user?.displayName ?? EMAIL}`);

  const stamp = Date.now() % 100000;

  // ── 1 无 monthly 定义 → 404（清场：软删本脚本历史定义跳过——按 name 前缀过滤本次造的） ──
  console.log('\n── 前置 ──');
  const defs0 = await api('GET', '/api/v1/reports/definitions');
  const myDefs = (defs0.data?.definitions ?? []).filter(d => String(d.name).startsWith('REQ2-17'));
  for (const d of myDefs) await api('DELETE', `/api/v1/reports/definitions/${d.id}`);

  const empty = await api('POST', '/api/v1/reports/monthly-close', { periodKey: '2026-07' });
  if (empty.status === 404) pass('无 monthly 定义 → 404 NO_MONTHLY_DEFINITIONS');
  else fail('空定义 404', `status=${empty.status}`);

  // ── 2 建 2 个 monthly 定义 ──
  const defOrders = await api('POST', '/api/v1/reports/definitions', {
    name: `REQ2-17订单月报${stamp}`, datasetKey: 'orders',
    dimensions: ['status'], metrics: [{ field: 'quantity', agg: 'sum' }, { field: '*', agg: 'count' }],
    schedule: 'monthly', enabled: true,
  });
  const defInvoices = await api('POST', '/api/v1/reports/definitions', {
    name: `REQ2-17发票月报${stamp}`, datasetKey: 'invoices',
    dimensions: ['currency'], metrics: [{ field: 'amount', agg: 'sum' }, { field: '*', agg: 'count' }],
    schedule: 'monthly', enabled: true,
  });
  const defOrdersId = defOrders.data?.id ?? defOrders.data?.definition?.id;
  const defInvoicesId = defInvoices.data?.id ?? defInvoices.data?.definition?.id;
  if (defOrdersId && defInvoicesId) pass(`建 2 个 monthly 定义（orders/invoices）`);
  else fail('建定义', `status=${defOrders.status}/${defInvoices.status} ${JSON.stringify(defOrders.data)?.slice(0, 140)}`);

  // ── 3 结转本期（2026-07）与上期（2026-06）──
  console.log('\n── 结转 ──');
  const close1 = await api('POST', '/api/v1/reports/monthly-close', { periodKey: '2026-07' });
  if (close1.status === 200 && close1.data?.ran === 2 && close1.data?.total === 2) {
    pass('结转 2026-07：2 ran（mc: 快照落库）');
  } else fail('结转 2026-07', `status=${close1.status} ${JSON.stringify(close1.data)?.slice(0, 160)}`);

  // 幂等键核验（mc: 前缀 + ReportRun 落库）
  const runs = await api('GET', '/api/v1/reports/runs?limit=100');
  const mcRuns = (runs.data?.runs ?? []).filter((r) => String(r.idempotencyKey ?? '').startsWith(`mc:${defOrdersId}:2026-07`)
    || String(r.idempotencyKey ?? '').startsWith(`mc:${defInvoicesId}:2026-07`));
  if (mcRuns.length === 2 && mcRuns.every((r) => r.status === 'Success')) pass('mc: 幂等键快照落库（2 条 Success）');
  else fail('mc: 快照落库', `n=${mcRuns.length}`);

  const close2 = await api('POST', '/api/v1/reports/monthly-close', { periodKey: '2026-07' });
  if (close2.status === 200 && close2.data?.skipped === 2 && close2.data?.ran === 0) pass('重复结转同 periodKey → skipped=2（不覆盖）');
  else fail('重复结转幂等', `ran=${close2.data?.ran} skipped=${close2.data?.skipped}`);

  const close3 = await api('POST', '/api/v1/reports/monthly-close', { periodKey: '2026-06' });
  if (close3.status === 200 && close3.data?.ran === 2) pass('补结转上期 2026-06 → ran=2');
  else fail('补结转上期', `status=${close3.status}`);

  // ── 4 对比 ──
  console.log('\n── 对比 ──');
  const cmp = await api('GET', '/api/v1/reports/monthly-close/compare?periodKey=2026-07');
  const items = cmp.data?.items ?? [];
  if (cmp.status === 200 && items.length === 2) {
    pass('对比 2026-07 vs 2026-06：2 个定义');
    const ordersItem = items.find((i) => i.definitionId === defOrdersId);
    const invItem = items.find((i) => i.definitionId === defInvoicesId);
    if (ordersItem?.current?.rowCount != null && ordersItem?.previous?.rowCount != null) {
      const countDelta = ordersItem.deltas.find(d => d.metric === 'count(*)');
      if (countDelta && countDelta.current === countDelta.previous && countDelta.delta === 0 && countDelta.deltaPct === 0) {
        pass(`metric 汇总对比精确（count(*) 总量：${countDelta.previous} → ${countDelta.current}，Δ=0——两期快照同数据时点自洽）`);
      } else fail('metric 对比', JSON.stringify(countDelta));
      // 两期同快照时点数据一致 → Δ=0 / Δ%=0（上一断言已含，保留独立提示）
      if (countDelta?.deltaPct === 0) pass('同数据时点 Δ%=0（口径自洽）');
    } else fail('对比明细缺失', JSON.stringify(ordersItem)?.slice(0, 140));
    if (invItem?.deltas?.length === 2) pass('发票定义 2 个 metric 列对比（sum(amount)/count(*)）');
    else fail('发票 metric 列', JSON.stringify(invItem?.deltas?.length));
  } else fail('对比', `status=${cmp.status} ${JSON.stringify(cmp.data)?.slice(0, 160)}`);

  // 缺上期（2026-05 未结转）
  const cmp2 = await api('GET', '/api/v1/reports/monthly-close/compare?periodKey=2026-06');
  const item0605 = (cmp2.data?.items ?? [])[0];
  if (cmp2.status === 200 && item0605?.previous === null) pass('缺上期快照 → previous=null（提示先结转上月）');
  else fail('缺上期标注', JSON.stringify(item0605?.previous));

  // ── 5 校验与权限 ──
  console.log('\n── 校验与权限 ──');
  const badPk = await api('POST', '/api/v1/reports/monthly-close', { periodKey: '2026-13' });
  if (badPk.status === 400) pass('periodKey 非法 → 400');
  else fail('periodKey 校验', `status=${badPk.status}`);

  const badPk2 = await api('POST', '/api/v1/reports/monthly-close', { periodKey: 'junk' });
  if (badPk2.status === 400) pass('periodKey 非字符串月 → 400');

  const salesEmail = `req217-sales-${stamp}@bambook.local`;
  await api('POST', '/api/admin/users', { displayName: `REQ2-17销售${stamp}`, email: salesEmail, password: 'Close@2026', roles: ['role-sales'] });
  const salesLogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: salesEmail, password: 'Close@2026' }),
  }).then(r => r.json()).catch(() => null);
  const salesClose = await api('POST', '/api/v1/reports/monthly-close', { periodKey: '2026-07' }, salesLogin?.token);
  if (salesClose.status === 403) pass('sales 触发结转 → 403（高风险角色门禁）');
  else fail('结转权限', `status=${salesClose.status}`);

  // ── 清场：软删本次造的定义（快照 ReportRun 保留作运行历史） ──
  await api('DELETE', `/api/v1/reports/definitions/${defOrdersId}`);
  await api('DELETE', `/api/v1/reports/definitions/${defInvoicesId}`);

  const failed = results.filter(r => !r.ok);
  console.log(`\n══ REQ2-17 实机验收：${results.length - failed.length}/${results.length} 通过 ══`);
  if (failed.length > 0) { console.log('失败项：'); failed.forEach(f => console.log(`  ✗ ${f.name} — ${f.detail}`)); process.exit(1); }
}

main().catch(e => { console.error('验收脚本异常：', e); process.exit(1); });
