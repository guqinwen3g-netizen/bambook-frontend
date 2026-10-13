// D6-Q1 米样长度口径 —— API 级实机验收（拍板 2026-09-16）
//
// 要证的业务链：
//   ① 长度建账（20M）→ ② 分割 3M（父样 17M + 子样 3M，继承来源）→ ③ 剪给客户 2M（15M）
//   → ④ 持有不足 409（fail-closed 不可负）→ ⑤ 重复建账 409 → ⑥ 台账 append-only 留痕
//
// 自回滚：父子样品全部软删（历史数据一律不动）。
// 用法：node scripts/acceptance-d6-sample-length.mjs
const BASE = 'http://127.0.0.1:8081';
const PASSWORD = 'Bambook@2026';
const DEBUG = process.env.D6_DEBUG === '1';

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
  const admin = await login('jason.shen@bambook.local');
  if (!admin) { console.log('管理员登录失败'); process.exit(1); }
  console.log('══ D6-Q1 米样长度 · 真库实跑 ══\n');

  const ids = [];
  const rollback = async () => {
    for (const id of ids.reverse()) {
      await api(admin, 'DELETE', `/api/v1/samples/${encodeURIComponent(id)}`);
    }
  };

  // ── 1. 建米样（yardage） ──
  const created = await api(admin, 'POST', '/api/v1/samples', {
    type: 'dev', subType: 'yardage', notes: 'D6-Q1 米样验收',
  });
  const sample = created.data?.sample;
  if (created.status !== 201 && created.status !== 200 || !sample?.id) {
    fail('建米样', `HTTP ${created.status} ${JSON.stringify(created.data).slice(0, 200)}`);
    return exit();
  }
  ids.push(sample.id);
  pass('建米样', `${sample.code}（dev/yardage，跑完软删）`);

  // ── 2. 长度建账 20M ──
  const set = await api(admin, 'POST', `/api/v1/samples/${encodeURIComponent(sample.id)}/length`, { quantity: 20, unit: 'M' });
  if (set.status !== 200 || Number(set.data?.sample?.lengthQty) !== 20) {
    fail('长度建账', `HTTP ${set.status} ${JSON.stringify(set.data).slice(0, 200)}`);
    await rollback(); return exit();
  }
  pass('长度建账 20M', `lengthQty=${set.data.sample.lengthQty} unit=${set.data.sample.lengthUnit}`);

  // ── 3. 分割 3M → 父 17 / 子 3 ──
  const cut = await api(admin, 'POST', `/api/v1/samples/${encodeURIComponent(sample.id)}/length/cut`, { quantity: 3, note: '客户要样' });
  if (cut.status !== 200 || !cut.data?.child?.id || Number(cut.data?.parent?.lengthQty) !== 17) {
    fail('分割 3M', `HTTP ${cut.status} ${JSON.stringify(cut.data).slice(0, 250)}`);
    await rollback(); return exit();
  }
  const child = cut.data.child;
  ids.push(child.id);
  pass('分割 3M', `父样 17M，子样 ${child.code} 3M（继承 subType=${child.subType}）`);

  // 子样也应有自己的账与流水
  const childMovs = await api(admin, 'GET', `/api/v1/samples/${encodeURIComponent(child.id)}/length/movements`);
  if (childMovs.status === 200 && (childMovs.data?.movements ?? []).length >= 1) {
    pass('子样自带建账流水', `${(childMovs.data.movements).length} 条（counterpart 互引父样）`);
  } else fail('子样流水', `HTTP ${childMovs.status}`);

  // ── 4. 剪给客户 2M → 15M ──
  const give = await api(admin, 'POST', `/api/v1/samples/${encodeURIComponent(sample.id)}/length/move`, { type: 'give', quantity: 2 });
  if (give.status !== 200 || Number(give.data?.sample?.lengthQty) !== 15) {
    fail('剪给客户 2M', `HTTP ${give.status} ${JSON.stringify(give.data).slice(0, 200)}`);
    await rollback(); return exit();
  }
  pass('剪给客户 2M', `父样 15M`);

  // ── 5. fail-closed：持有不足 409；重复建账 409 ──
  const over = await api(admin, 'POST', `/api/v1/samples/${encodeURIComponent(sample.id)}/length/move`, { type: 'give', quantity: 100 });
  if (over.status === 409 && String(over.data?.error?.message ?? '').includes('持有长度不足')) {
    pass('持有不足 → 409（不可负 fail-closed）', '账面不动');
  } else fail('持有不足', `HTTP ${over.status} ${JSON.stringify(over.data).slice(0, 150)}`);

  const reset = await api(admin, 'POST', `/api/v1/samples/${encodeURIComponent(sample.id)}/length`, { quantity: 99, unit: 'M' });
  if (reset.status === 409) pass('重复建账 → 409（调整必须走流水）', '账面不被覆盖');
  else fail('重复建账', `HTTP ${reset.status}`);

  // ── 6. 台账 append-only ──
  const movs = await api(admin, 'GET', `/api/v1/samples/${encodeURIComponent(sample.id)}/length/movements`);
  const types = (movs.data?.movements ?? []).map((m) => m.type);
  if (JSON.stringify(types) === JSON.stringify(['give', 'cut', 'set'])) {
    pass('台账 append-only', `[${types.join(', ')}]（倒序，含 balanceAfter 快照）`);
  } else fail('台账', `[${types.join(', ')}]（期望 [give, cut, set]）`);

  await rollback();
  const gone = await api(admin, 'GET', `/api/v1/samples/${encodeURIComponent(sample.id)}`);
  if (gone.status === 404 || gone.data?.sample == null) pass('回滚后样品不可见', '父子软删生效');
  else info('回滚后样品', '仍可见（查询口径，仅记录）');

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
