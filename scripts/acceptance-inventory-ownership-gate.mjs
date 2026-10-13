// D7-② 货权汇总：**门控 + UI 取数** 真库验收（改货权走「演练 + 自回滚」）
//
// 为什么这一份要写入（与 acceptance-d7-2-inventory-ownership.mjs 的**零写入**不同）：
//   那份只验证读取口径；这一份要验证「在界面上改货权后，汇总真的会跟着变」。
//   改货权**可逆且落审计**，脚本用「演练 → 断言变化 → 改回 → 断言指纹复原」把风险关在笼子里；
//   任何一步失败都会尝试改回原值并**非零退出**，不会把数据停在中间态。
//
// 验的口径不变量：
//   R1 汇总结构完整（byOwnership / ownedOnly / warehouseId）
//   R2 **门控**：无 inventory:read 的角色（财务，持 reports:write）→ 403；
//      有 inventory:read 的角色（单证）→ 200 —— 与报表引擎 inventoryItems 数据集同口径
//   R3 ourStock 口径 = 我方存货（可用+在途+寄售）；ownedOnly 是它的**别名**（C6 语义升级，
//      2026-09-18 `43155359`）；数量按单位分行（跨单位不相加）。★ 2026-09-29 就地更新：原写
//      「ownedOnly 只含 Owned」是升级前的口径，本脚本 09-16 写成 ⇒ 过期的是断言，不是代码。
//   R4 改货权：Owned → Transferred → 汇总立即可见 → 改回 → 指纹复原
//   R5 仓库筛选透传（warehouseId 回显 + 汇总范围收敛）
//
// 用法：node scripts/acceptance-inventory-ownership-gate.mjs
const BASE = 'http://127.0.0.1:8081';
const PASSWORD = 'Bambook@2026';
const DEBUG = process.env.OWN_DEBUG === '1';

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

function exit() {
  const failed = results.filter(r => r.ok === false).length;
  const passed = results.filter(r => r.ok === true).length;
  console.log(`\n══ 结果：${passed} 通过 / ${failed} 失败 ══`);
  process.exit(failed > 0 ? 1 : 0);
}

async function main() {
  const admin = await login('jason.shen@bambook.local');
  const finance = await login('charlie.qian@bambook.local');
  const doc = await login('hank.zheng@bambook.local');
  if (!admin || !finance || !doc) { console.log('登录失败（三个账号都要能登）'); process.exit(1); }
  console.log('══ D7-② 货权汇总：门控 + UI 取数 · 真库验收 ══\n');

  // ── R1 结构 ──
  const base = await api(admin, 'GET', '/api/v1/inventory/summary-by-ownership');
  if (base.status !== 200) { fail('R1 超管读汇总', `HTTP ${base.status} ${JSON.stringify(base.data).slice(0, 160)}`); return exit(); }
  const d0 = base.data;
  pass('R1 超管读汇总 200', `${d0.byOwnership.length} 个货权分组 / ownedOnly ${d0.ownedOnly?.itemCount ?? 0} 项`);

  // ── R2 门控（2026-09-16 新加的 inventory:read 门）──
  const fin = await api(finance, 'GET', '/api/v1/inventory/summary-by-ownership');
  if (fin.status === 403) pass('R2 财务（有 reports:write，无 inventory:read）→ 403', '与报表引擎同口径，门未被绕过');
  else fail('R2 财务应被 403', `实际 HTTP ${fin.status} ${JSON.stringify(fin.data).slice(0, 120)}`);

  const docRes = await api(doc, 'GET', '/api/v1/inventory/summary-by-ownership');
  if (docRes.status === 200) pass('R2 单证（有 inventory:read）→ 200', '门不误伤合法主体');
  else fail('R2 单证应放行', `实际 HTTP ${docRes.status}`);

  // ── R3 汇总口径 ──
  const owned = d0.byOwnership.find(g => g.ownership === 'Owned');
  if (!owned) { fail('R3 存在 Owned 分组', '真库没有任何我方货权库存项'); return exit(); }
  if (Array.isArray(owned.quantityByUnit) && owned.quantityByUnit.length > 0) {
    pass('R3 数量按单位分行（跨单位不相加）', owned.quantityByUnit.map(b => `${b.quantity} ${b.unit}`).join(' · '));
  } else fail('R3 quantityByUnit 为空', JSON.stringify(owned).slice(0, 160));
  /**
   * ★ 2026-09-29 更新（**断言过期，不是代码缺陷**）：
   *   `43155359`（2026-09-18）C6「货权从 2 档扩到 4 档」把 `ownedOnly` 的**语义升级**了 ——
   *   它现在是 `ourStock` 的**别名**（我方存货 = 可用 Owned + 在途 InTransit + 寄售 Consignment），
   *   不再是"只含 Owned"的旧口径（服务里已标 `@deprecated`，并注明"新代码请用 `ourStock`"）。
   *   本脚本写于 2026-09-16，**早于那次升级两天** ⇒ 旧断言会永远红。
   *   ⇒ 改判：钉"别名契约 + 构成契约"，并**保留牙齿**（已转移的绝不能进我方存货）。
   */
  const groups = d0.byOwnership ?? [];
  const sumOf = (kinds) => groups.filter(g => kinds.includes(g.ownership))
    .reduce((s, g) => s + (g.itemCount ?? 0), 0);
  if (d0.ourStock && d0.ourStock.ownership === 'OurStock') {
    pass('R3 ourStock 口径正确（我方存货 = 可用 + 在途 + 寄售）', `${d0.ourStock.itemCount} 项`);
  } else fail('R3 ourStock 口径不对', JSON.stringify(d0.ourStock).slice(0, 160));

  // 别名契约：弃用字段必须与新字段**同一份**
  if (d0.ownedOnly && d0.ourStock && JSON.stringify(d0.ownedOnly) === JSON.stringify(d0.ourStock)) {
    pass('R3 ownedOnly 已是 ourStock 别名（C6 语义升级）', `${d0.ownedOnly.itemCount} 项`);
  } else fail('R3 ownedOnly 未与 ourStock 同步', JSON.stringify(d0.ownedOnly).slice(0, 160));

  // ★ 牙齿：构成契约 —— 我方存货必须**恰好**等于 可用+在途+寄售，且已转移一分不计
  const expectCount = sumOf(['Owned', 'InTransit', 'Consignment']);
  if (d0.ourStock && d0.ourStock.itemCount === expectCount) {
    pass('R3 构成契约：我方存货 = 可用 + 在途 + 寄售（已转移不计入）', `${expectCount} 项`);
  } else {
    fail('R3 构成契约不符', `ourStock=${d0.ourStock?.itemCount} 期望=${expectCount}（Owned+InTransit+Consignment；Transferred 不计）`);
  }

  // ── R4 改货权：演练 → 断言变化 → 改回 → 断言复原 ──
  const items = await api(admin, 'GET', '/api/v1/inventory/items?limit=1');
  const target = items.data?.items?.[0];
  if (!target) { info('R4 无库存项可演练', '真库库存为空，跳过写入演练'); return exit(); }
  const original = String(target.ownership ?? 'Owned').trim() || 'Owned';
  const next = original === 'Owned' ? 'Transferred' : 'Owned';
  const before = fingerprint(d0);
  console.log(`\n  ▸ 演练对象：${target.materialCode || target.description}（${target.id}） ${original} → ${next}`);

  const set1 = await api(admin, 'PATCH', `/api/v1/inventory/items/${target.id}/ownership`, { ownership: next });
  if (set1.status !== 200) { fail('R4 改货权', `HTTP ${set1.status} ${JSON.stringify(set1.data).slice(0, 160)}`); return exit(); }
  pass('R4 改货权 200', `changed=${set1.data?.changed}`);

  const mid = await api(admin, 'GET', '/api/v1/inventory/summary-by-ownership');
  if (fingerprint(mid.data) !== before) pass('R4 汇总随之变化（界面刷新即可见）');
  else fail('R4 汇总未变化', '改了货权但汇总没动 —— 前端刷了也看不出来');

  const set2 = await api(admin, 'PATCH', `/api/v1/inventory/items/${target.id}/ownership`, { ownership: original });
  if (set2.status !== 200) { fail('R4 改回原值', `HTTP ${set2.status} ${JSON.stringify(set2.data).slice(0, 160)}`); return exit(); }
  const after = await api(admin, 'GET', '/api/v1/inventory/summary-by-ownership');
  if (fingerprint(after.data) === before) pass('R4 自回滚：汇总指纹与演练前完全一致', '数据无残留');
  else fail('R4 自回滚失败', `before=${before.slice(0, 120)} after=${fingerprint(after.data).slice(0, 120)}`);

  // ── R5 仓库筛选透传 ──
  const wh = await api(admin, 'GET', '/api/v1/inventory/warehouses');
  const whId = wh.data?.warehouses?.[0]?.id;
  if (whId) {
    const scoped = await api(admin, 'GET', `/api/v1/inventory/summary-by-ownership?warehouseId=${encodeURIComponent(whId)}`);
    if (scoped.status === 200 && scoped.data.warehouseId === whId) {
      pass('R5 仓库筛选透传', `${wh.data.warehouses[0].name}：${scoped.data.ownedOnly?.itemCount ?? 0} 项`);
    } else fail('R5 仓库筛选', `HTTP ${scoped.status} warehouseId=${scoped.data?.warehouseId}`);
  } else info('R5 无仓库', '跳过');

  return exit();
}

main().catch(e => { console.error('脚本异常：', e); process.exit(1); });
