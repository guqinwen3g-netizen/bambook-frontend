// D7-② 货权标记 + 按货权汇总 —— 真库验收（**零写入**）
//
// 为什么只跑只读 + 拒绝路径：真库是**生产数据**（单租户给江苏熊猫用），
// 虽然货权字段可逆（改回即可），但脚本中断会让数据停在中间态 → 不做写入。
// 汇总口径与幂等语义由单测覆盖（inventoryOwnershipService.test.ts 10 例）。
//
// 验的口径不变量：
//   R1 汇总结构完整（byOwnership / ownedOnly / warehouseId）
//   R2 **ownedOnly 只含 Owned** —— 报表口径：货权已转移的不得计入我方存货
//   R3 **数量按 unit 分组**（跨单位不相加）；**金额按 currency 分组**（跨币种不相加）
//   R4 非法货权值 → 400；不存在的库存项 → 404（均零写入）
//   R5 复核：脚本跑完后汇总数字与跑之前**完全一致**（零写入自证）
//
// 用法：node scripts/acceptance-d7-2-inventory-ownership.mjs
const BASE = 'http://127.0.0.1:8081';
const PASSWORD = 'Bambook@2026';
const DEBUG = process.env.D7_DEBUG === '1';

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
  if (DEBUG && res.status >= 400) console.log(`    [diag] ${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  return { status: res.status, data };
}

const fingerprint = (d) => JSON.stringify({
  by: (d?.byOwnership ?? []).map(g => [g.ownership, g.itemCount, g.quantityByUnit, g.valueByCurrency]),
  owned: d?.ownedOnly ? [d.ownedOnly.itemCount, d.ownedOnly.quantityByUnit, d.ownedOnly.valueByCurrency] : null,
});

async function main() {
  let token = await login('jason.shen@bambook.local');
  const who = 'jason.shen(超管)';
  if (!token) { token = await login('charlie.qian@bambook.local'); }
  if (!token) { console.log('登录失败'); process.exit(1); }
  console.log(`══ D7-② 货权标记 · 真库验收（零写入，${who}）══\n`);

  const before = await api(token, 'GET', '/api/v1/inventory/summary-by-ownership');
  if (before.status !== 200) { fail('GET /summary-by-ownership', `HTTP ${before.status} ${JSON.stringify(before.data).slice(0, 160)}`); return exit(); }
  const d = before.data;
  pass('GET /summary-by-ownership', `HTTP 200`);

  // R1 结构
  const need = ['byOwnership', 'warehouseId'];
  const okStruct = need.every(k => k in d) && Array.isArray(d.byOwnership);
  if (okStruct) pass('R1 结构完整', `${d.byOwnership.length} 个货权分组`);
  else fail('R1', `缺字段或类型不对：${JSON.stringify(d).slice(0, 160)}`);

  /**
   * ★ 2026-09-29 更新（**断言过期，不是代码缺陷**）：`43155359`（2026-09-18）C6 把 `ownedOnly`
   *   语义升级为 `ourStock` 的**别名**（我方存货 = 可用 Owned + 在途 InTransit + 寄售 Consignment），
   *   不再是"只含 Owned"的旧口径。本脚本写于 2026-09-16（早于升级两天）⇒ 旧断言永远红。
   *   ⇒ 改为钉"别名契约 + 构成契约"，并**保留牙齿**（已转移的绝不能进我方存货）。
   */
  if (d.ourStock === null || d.ourStock === undefined) {
    info('R2 无我方存货分组', '真库可能无库存项或全为已转移');
  } else if (d.ourStock.ownership === 'OurStock') {
    pass('R2 ourStock = 我方存货（可用 + 在途 + 寄售）', `itemCount=${d.ourStock.itemCount}`);
  } else {
    fail('R2', `ourStock.ownership=${d.ourStock.ownership}（应为 OurStock）`);
  }
  if (d.ourStock && d.ownedOnly) {
    const same = JSON.stringify(d.ownedOnly) === JSON.stringify(d.ourStock);
    const expect = (d.byOwnership ?? [])
      .filter(g => ['Owned', 'InTransit', 'Consignment'].includes(g.ownership))
      .reduce((s, g) => s + (g.itemCount ?? 0), 0);
    if (same && d.ourStock.itemCount === expect) {
      pass('R2 ownedOnly 已是 ourStock 别名，且构成契约成立（已转移不计入）', `${expect} 项`);
    } else {
      fail('R2 别名/构成契约不符', `same=${same} ourStock=${d.ourStock.itemCount} 期望=${expect}`);
    }
  }

  // R3 数量按 unit / 金额按 currency 分组
  let r3ok = true;
  for (const g of d.byOwnership ?? []) {
    const units = (g.quantityByUnit ?? []).map(x => x.unit);
    const curs = (g.valueByCurrency ?? []).map(x => x.currency);
    if (new Set(units).size !== units.length) { fail('R3 单位分组重复', `${g.ownership}: ${JSON.stringify(units)}`); r3ok = false; }
    if (new Set(curs).size !== curs.length) { fail('R3 币种分组重复', `${g.ownership}: ${JSON.stringify(curs)}`); r3ok = false; }
  }
  if (r3ok) {
    pass('R3 数量按单位、金额按币种分组（不相加）',
      (d.byOwnership ?? []).map(g => `${g.ownership}: ${(g.quantityByUnit ?? []).map(x => `${x.quantity}${x.unit}`).join('+') || '—'}`).join(' | ') || '无数据');
  }

  // R4 拒绝路径（零写入）
  const bad = await api(token, 'PATCH', '/api/v1/inventory/items/NOPE__x/ownership', { ownership: 'Whatever' });
  if (bad.status === 400 || bad.status === 404) pass('R4 非法值/不存在 → 400/404（零写入）', `${bad.status} ${bad.data?.error?.code ?? ''}`);
  else fail('R4', `期望 400/404，实际 ${bad.status}`);

  const nf = await api(token, 'PATCH', '/api/v1/inventory/items/NOPE__x/ownership', { ownership: 'Transferred' });
  if (nf.status === 404) pass('R4 不存在库存项 → 404', nf.data?.error?.code ?? '');
  else fail('R4(404)', `期望 404，实际 ${nf.status}`);

  // R5 零写入自证
  const after = await api(token, 'GET', '/api/v1/inventory/summary-by-ownership');
  if (fingerprint(before.data) === fingerprint(after.data)) pass('R5 汇总数字与跑前完全一致（零写入自证）');
  else fail('R5', '汇总被改动了');

  console.log('');
  info('零写入保证', '只跑只读汇总 + 拒绝路径；货权变更（可逆）与汇总口径由单测覆盖（10 例）');
  exit();

  function exit() {
    const ok = results.filter(r => r.ok === true).length;
    const bad2 = results.filter(r => r.ok === false).length;
    const notes = results.filter(r => r.ok === null).length;
    console.log(`\n══ 结果：${ok} 通过 / ${bad2} 失败 / ${notes} 需知会 ══`);
    process.exit(bad2 === 0 ? 0 : 1);
  }
}

main().catch((e) => { console.error('脚本异常', e); process.exit(2); });
