// T1 面料订单出运资格 + 船样登记 —— API 级实机验收（handoff-20260916-005500 §二）
//
// 要证的不是「端点会返回 200」，而是这条**链路真的通**：
//   订单侧登记船样 → 写进 Sample 表 → 出运门禁读的那张表有人写了 → ss 条件转绿
// 同时验证 §二「必须回报的权限坑」：看得见订单的角色（销售/单证/财务）能否读到这份回显。
//
// 跑完必须自回滚（软删本次创建的船样），不留脏数据。
// 用法：node scripts/acceptance-t1-shipment-eligibility.mjs
const BASE = 'http://127.0.0.1:8081';
const PASSWORD = 'Bambook@2026';
const DEBUG = process.env.T1_DEBUG === '1';

const ROLES = [
  { label: '销售 SALES', email: 'chloe.su@bambook.local' },
  { label: '单证/物流 LOGISTICS', email: 'hank.zheng@bambook.local' },
  { label: '财务 FINANCE', email: 'charlie.qian@bambook.local' },
];

const results = [];
function pass(name, detail = '') { results.push({ name, ok: true, detail }); console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
function fail(name, detail = '') { results.push({ name, ok: false, detail }); console.log(`  ✗ ${name} — ${detail}`); }
function info(name, detail = '') { results.push({ name, ok: null, detail }); console.log(`  ⓘ ${name} — ${detail}`); }

async function login(email) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.token) return { ok: false, status: res.status, data };
  return { ok: true, token: data.token, user: data.user };
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
  if (DEBUG && res.status >= 400) console.log(`    [diag] ${method} ${path} → ${res.status} ${text.slice(0, 160)}`);
  return { status: res.status, data };
}

async function main() {
  console.log('══ T1 面料出运资格 · 真库实跑 ══\n');

  // ── 1. 找一个面料订单 ──
  const salesLogin = await login(ROLES[0].email);
  if (!salesLogin.ok) { console.log('登录失败', salesLogin.status, salesLogin.data); process.exit(1); }
  const token = salesLogin.token;
  console.log(`登录：${ROLES[0].label} ${salesLogin.user?.displayName ?? ROLES[0].email}\n`);

  const orders = await api(token, 'GET', '/api/v1/orders?limit=50');
  const list = orders.data?.items ?? orders.data?.orders ?? [];
  const fabricOrder = list.find((o) => (o.businessLine ?? '').toLowerCase() === 'fabric' || (o.type ?? '') === 'Fabric')
    ?? list[0];
  if (!fabricOrder) { console.log('没有可用订单，退出'); process.exit(1); }
  const ORDER = fabricOrder.id;
  console.log(`宿主订单：${ORDER}（businessLine=${fabricOrder.businessLine} type=${fabricOrder.type}）\n`);
  pass('取到面料订单', `${ORDER}`);

  const eligPath = `/api/v1/qc/orders/${encodeURIComponent(ORDER)}/shipment-eligibility`;

  // ── 2. 权限扫描：谁能读到这份回显（这是 §二 点名要回报的坑）──
  console.log('── 权限扫描（看得见订单的角色能否读到出运资格）──');
  for (const r of ROLES) {
    const lg = await login(r.email);
    if (!lg.ok) { fail(`${r.label} 登录`, `HTTP ${lg.status}`); continue; }
    const res = await api(lg.token, 'GET', eligPath);
    if (res.status === 200) pass(`${r.label} 可读`, `applicable=${res.data?.applicable} eligible=${res.data?.eligible}`);
    else info(`${r.label} 不可读`, `HTTP ${res.status} ${res.data?.error?.message ?? ''}`.trim());
  }
  console.log('');

  // ── 3. 基线：当前三条件 ──
  console.log('── 基线三条件 ──');
  const before = await api(token, 'GET', eligPath);
  if (before.status !== 200) { fail('回显端点可用', `HTTP ${before.status} ${JSON.stringify(before.data)}`); exit(); }
  pass('回显端点可用', `applicable=${before.data.applicable}`);
  const beforeSs = before.data.conditions?.ss?.satisfied;
  const beforeGates = before.data.missingGates ?? [];
  info('基线 ss', `satisfied=${beforeSs} missingGates=[${beforeGates.join(', ')}]`);
  console.log('');

  // ── 4. 登记船样并走完状态机 ──
  console.log('── 订单侧登记船样 → 推进到客户确认通过 ──');
  const created = await api(token, 'POST', '/api/v1/samples', {
    type: 'ship', sourceOrderId: ORDER, notes: 'T1 验收临时船样（跑完软删）',
  });
  if (created.status !== 201 && created.status !== 200) {
    fail('POST /v1/samples 建船样', `HTTP ${created.status} ${JSON.stringify(created.data)}`);
    exit();
  }
  const sid = created.data?.sample?.id;
  if (!sid) { fail('建船样返回 id', JSON.stringify(created.data)); exit(); }
  pass('建船样', `${sid} type=${created.data.sample.type} sourceOrderId=${created.data.sample.sourceOrderId}`);

  const steps = [
    ['start', {}, 'draft → making'],
    ['qc', { qcStatus: 'passed' }, 'making → qc（内部验货通过）'],
    ['submit', { courier: 'DHL', trackingNumber: 'T1-ACCEPTANCE-001', sentDate: new Date().toISOString().slice(0, 10) }, 'qc → submitted（登记寄送）'],
    ['confirm', { customerStatus: 'approved', feedback: 'T1 验收：客户通过' }, 'submitted → confirmed（客户确认通过）'],
  ];
  let stepOk = true;
  for (const [action, body, desc] of steps) {
    const res = await api(token, 'PATCH', `/api/v1/samples/${encodeURIComponent(sid)}/stage`, { action, ...body });
    if (res.status !== 200) { fail(`推进 ${action}`, `HTTP ${res.status} ${JSON.stringify(res.data)}`); stepOk = false; break; }
    pass(`推进 ${action}`, `${desc} → status=${res.data.sample.status} customerStatus=${res.data.sample.customerStatus ?? '-'}`);
  }
  console.log('');

  // ── 5. 关键判定：门禁读的表，真的被我们写了 ──
  console.log('── 核心判别：ss 条件是否因这次登记转绿 ──');
  const after = await api(token, 'GET', eligPath);
  const afterSs = after.data?.conditions?.ss?.satisfied;
  const afterGates = after.data?.missingGates ?? [];
  info('登记后 ss', `satisfied=${afterSs} sampleId=${after.data?.conditions?.ss?.sampleId ?? '-'} missingGates=[${afterGates.join(', ')}]`);
  if (afterSs === true) {
    pass('真源接通', '订单侧登记 → Sample 表 → 出运门禁 ss 条件转绿（写的表就是门禁读的表）');
  } else {
    fail('真源未接通', '登记后 ss 仍未通过 —— 这就是 §二 说的假修复，必须查 Creator');
  }
  if (beforeGates.includes('SS_NOT_CONFIRMED') && !afterGates.includes('SS_NOT_CONFIRMED')) {
    pass('missingGates 收敛', `SS_NOT_CONFIRMED 已从缺口列表移除`);
  } else if (!beforeGates.includes('SS_NOT_CONFIRMED')) {
    info('missingGates 变化', '基线本就不缺 SS（该订单已有通过的客户船样）');
  }
  console.log('');

  // ── 6. 回滚：软删本次创建的船样，再确认 ss 回落 ──
  console.log('── 回滚 ──');
  const del = await api(token, 'DELETE', `/api/v1/samples/${encodeURIComponent(sid)}`);
  if (del.status === 200) pass('软删船样', `${sid}`); else fail('软删船样', `HTTP ${del.status} ${JSON.stringify(del.data)}`);

  const rolled = await api(token, 'GET', eligPath);
  const rolledSs = rolled.data?.conditions?.ss?.satisfied;
  if (rolledSs === beforeSs) pass('ss 回到基线', `satisfied=${rolledSs}（与登记前一致）`);
  else info('ss 与基线不一致', `登记前=${beforeSs} 回滚后=${rolledSs}（该订单可能另有船样生效）`);

  // ── 7. RC 匹头样：门禁读的是订单上的两个日期字段 ──
  // 业务口径（2026-09-16 拍板）：匹头样是每卷布各剪一小块验色差，大货做完准备出运时才剪得出来，
  // ⇒ 不在建单时填，改为订单详情就地登记 Order.fabricSampleSentDate / fabricSampleConfirmedDate。
  console.log('\n── RC 匹头样（真源 = 订单上的两个日期字段）──');
  const origin = await api(token, 'GET', `/api/v1/orders/${encodeURIComponent(ORDER)}`);
  const original = {
    fabricSampleSentDate: origin.data?.order?.fabricSampleSentDate ?? null,
    fabricSampleConfirmedDate: origin.data?.order?.fabricSampleConfirmedDate ?? null,
    fabricSampleTrackingNumber: origin.data?.order?.fabricSampleTrackingNumber ?? null,
  };
  info('RC 原值', JSON.stringify(original));

  const rcToday = new Date().toISOString().slice(0, 10);
  const rcSentRes = await api(token, 'PUT', `/api/v1/orders/${encodeURIComponent(ORDER)}`, {
    fabricSampleSentDate: rcToday, fabricSampleTrackingNumber: 'T1-RC-ACCEPTANCE',
  });
  if (rcSentRes.status !== 200) fail('登记匹头样寄出', `HTTP ${rcSentRes.status} ${JSON.stringify(rcSentRes.data)}`);
  else {
    const afterSent = await api(token, 'GET', eligPath);
    const rc = afterSent.data?.conditions?.rc;
    pass('登记匹头样寄出', `rc.enabled=${rc?.enabled} sentDate=${rc?.sentDate}`);
    if (rc?.enabled === true && afterSent.data?.missingGates?.includes('RC_NOT_CONFIRMED')) {
      pass('RC 开始卡门禁', 'missingGates 出现 RC_NOT_CONFIRMED（寄了没确认就会卡住出运）');
    } else fail('RC 未计入门禁', `enabled=${rc?.enabled} gates=[${(afterSent.data?.missingGates ?? []).join(',')}]`);

    const rcOkRes = await api(token, 'PUT', `/api/v1/orders/${encodeURIComponent(ORDER)}`, { fabricSampleConfirmedDate: rcToday });
    if (rcOkRes.status !== 200) fail('登记客户确认', `HTTP ${rcOkRes.status} ${JSON.stringify(rcOkRes.data)}`);
    else {
      const afterOk = await api(token, 'GET', eligPath);
      const rcOk = afterOk.data?.conditions?.rc;
      if (rcOk?.satisfied === true && !(afterOk.data?.missingGates ?? []).includes('RC_NOT_CONFIRMED')) {
        pass('RC 条件转绿', `satisfied=true confirmedDate=${rcOk.confirmedDate}，RC_NOT_CONFIRMED 已消失`);
      } else fail('RC 未转绿', JSON.stringify(rcOk));
    }
  }

  const rcRollback = await api(token, 'PUT', `/api/v1/orders/${encodeURIComponent(ORDER)}`, original);
  if (rcRollback.status === 200) pass('RC 字段回滚', '已写回登记前原值');
  else fail('RC 字段回滚', `HTTP ${rcRollback.status} ${JSON.stringify(rcRollback.data)}`);
  const rcFinal = await api(token, 'GET', eligPath);
  const rcFinalState = rcFinal.data?.conditions?.rc;
  if (rcFinalState?.enabled === !!(original.fabricSampleSentDate)) pass('RC 回到基线', `enabled=${rcFinalState?.enabled}`);
  else info('RC 与基线不一致', `proto 未完全还原：${JSON.stringify(rcFinalState)}`);

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
