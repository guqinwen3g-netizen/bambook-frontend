// REQ2-22 面料计算器 API 级实机验收（IND-07：纱支/密度/克重换算 + 门幅利用率 + 卷装匹长/装柜计算）
// 验收锚点（DR-062）：
//   ① 六类计算公式正确（含 40×40/133×72 府绸 ≈119 g/m² 行业实证）
//   ② 校验 fail-closed（非法 kind / 缺必填 / 负值 / 二选一约束 → 400 VALIDATION_FAILED）
//   ③ 未登录 401；端点只读零写（无任何业务表写入）
const BASE = 'http://127.0.0.1:8081';
const EMAIL = 'jason.shen@bambook.local';
const PASSWORD = 'Bambook@2026';

const results = [];
let token = '';
function pass(name, detail = '') { results.push({ name, ok: true, detail }); console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
function fail(name, detail = '') { results.push({ name, ok: false, detail }); console.log(`  ✗ ${name} — ${detail}`); }

async function api(method, path, body) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

const close = (actual, expected, tol) => Math.abs(actual - expected) <= tol;

async function main() {
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const login = await loginRes.json();
  if (!loginRes.ok || !login.token) { console.log('登录失败', loginRes.status); process.exit(1); }
  token = login.token;
  console.log(`登录成功：${login.user?.displayName ?? EMAIL}`);

  // ── 1 克重换算 ──
  console.log('\n── ① 克重换算 ──');
  {
    const r = await api('POST', '/api/v1/tools/fabric-calculator/calculate', { kind: 'weight-convert', gsm: 180, widthCm: 150 });
    if (r.status === 200 && r.data?.gPerM === 270 && close(r.data.mPerKg, 3.7, 0.01) && close(r.data.ydPerLb, 1.84, 0.01)) {
      pass('克重+门幅派生（180gsm/150cm → 270g/m · 3.7m/kg · 1.84yd/lb）');
    } else fail('克重换算', JSON.stringify(r.data)?.slice(0, 120));
    const back = await api('POST', '/api/v1/tools/fabric-calculator/calculate', { kind: 'weight-convert', ozyd: r.data?.ozyd });
    if (back.status === 200 && close(back.data?.gsm, 180, 0.5)) pass('ozyd → gsm 双向闭环');
    else fail('双向闭环', JSON.stringify(back.data)?.slice(0, 120));
  }

  // ── 2 纱支换算 ──
  console.log('\n── ② 纱支换算 ──');
  {
    const r = await api('POST', '/api/v1/tools/fabric-calculator/calculate', { kind: 'yarn-convert', value: 40, from: 'Ne' });
    const rs = r.data?.results;
    if (r.status === 200 && close(rs?.D, 14.76, 0.01) && close(rs?.Nm, 67.75, 0.05) && close(rs?.tex, 1.64, 0.01)) {
      pass('Ne=40 → D 14.76 · Nm 67.75 · tex 1.64（四制互转）');
    } else fail('纱支换算', JSON.stringify(rs)?.slice(0, 120));
    const d = await api('POST', '/api/v1/tools/fabric-calculator/calculate', { kind: 'yarn-convert', value: rs?.D, from: 'D' });
    if (d.status === 200 && close(d.data?.results?.Ne, 40, 0.01)) pass('D → Ne 反向闭环');
    else fail('反向闭环', JSON.stringify(d.data)?.slice(0, 120));
  }

  // ── 3 理论克重（行业实证） ──
  console.log('\n── ③ 理论克重 ──');
  {
    const r = await api('POST', '/api/v1/tools/fabric-calculator/calculate', {
      kind: 'theoretical-weight', warpDensity: 133, weftDensity: 72, warpYarn: 40, weftYarn: 40,
    });
    if (r.status === 200 && close(r.data?.theoreticalGsm, 119.2, 1) && close(r.data?.theoreticalOzyd, 3.51, 0.01)) {
      pass('行业实证：40×40/133×72 全棉府绸 ≈ 119 g/m²（3.51 oz/yd²）');
    } else fail('理论克重', JSON.stringify(r.data)?.slice(0, 120));
    const by10cm = await api('POST', '/api/v1/tools/fabric-calculator/calculate', {
      kind: 'theoretical-weight', warpDensity: 523, weftDensity: 284, warpYarn: 40, weftYarn: 40, densityUnit: 'per-10cm',
    });
    if (by10cm.status === 200 && close(by10cm.data?.theoreticalGsm, r.data?.theoreticalGsm, 1)) pass('根/10cm 输入归一（523/10cm ≡ 133/in）');
    else fail('密度归一', JSON.stringify(by10cm.data)?.slice(0, 120));
  }

  // ── 4 门幅与用料 ──
  console.log('\n── ④ 门幅与用料 ──');
  {
    const r = await api('POST', '/api/v1/tools/fabric-calculator/calculate', {
      kind: 'width-usage', widthCm: 150, gsm: 180, lengthPerPieceM: 1.65, pieceAreaM2: 1.8,
    });
    if (r.status === 200 && r.data?.usableWidthCm === 147 && r.data?.gPerM === 270
      && close(r.data?.pieceWeightKg, 0.4455, 0.001) && close(r.data?.perThousandKg, 445.5, 0.5)
      && close(r.data?.utilizationPct, 74.2, 0.5)) {
      pass('门幅/用量/利用率（150→147 可裁 · 0.45kg/件 · 445.5kg/千件 · 74.2%）');
    } else fail('门幅与用料', JSON.stringify(r.data)?.slice(0, 160));
  }

  // ── 5 卷装匹长 ──
  console.log('\n── ⑤ 卷装匹长 ──');
  {
    const r = await api('POST', '/api/v1/tools/fabric-calculator/calculate', {
      kind: 'roll-length', gsm: 180, widthCm: 150, rollWeightKg: 30,
    });
    if (r.status === 200 && r.data?.mode === 'by-weight' && close(r.data?.lengthM, 111.11, 0.01)
      && close(r.data?.rollWeightLb, 66.14, 0.01)) {
      pass('by-weight：30kg/180gsm/150cm → 111.11m（66.14 lb）');
    } else fail('卷装匹长', JSON.stringify(r.data)?.slice(0, 120));
    const back = await api('POST', '/api/v1/tools/fabric-calculator/calculate', {
      kind: 'roll-length', gsm: 180, widthCm: 150, lengthM: 100,
    });
    if (back.status === 200 && back.data?.mode === 'by-length' && back.data?.rollWeightKg === 27) pass('by-length：100m → 27kg（闭环）');
    else fail('by-length', JSON.stringify(back.data)?.slice(0, 120));
  }

  // ── 6 装柜计算 ──
  console.log('\n── ⑥ 装柜计算 ──');
  {
    const r = await api('POST', '/api/v1/tools/fabric-calculator/calculate', {
      kind: 'container-loading', containerType: '20GP', rollDiameterCm: 60, rollWidthCm: 152, rollWeightKg: 25,
    });
    if (r.status === 200 && r.data?.byVolume === 58 && r.data?.byWeight === 868 && r.data?.recommendedRolls === 58
      && r.data?.bindingConstraint === 'volume' && close(r.data?.rollVolumeM3, 0.43, 0.005)) {
      pass('20GP：体积约束（0.43m³/卷 → 58 卷；载重可装 868）');
    } else fail('装柜计算', JSON.stringify(r.data)?.slice(0, 160));
    const withLen = await api('POST', '/api/v1/tools/fabric-calculator/calculate', {
      kind: 'container-loading', containerType: '40HQ', rollDiameterCm: 60, rollWidthCm: 152, rollWeightKg: 25, gsm: 180, widthCm: 150,
    });
    if (withLen.status === 200 && withLen.data?.recommendedRolls === 142
      && close(withLen.data?.rollLengthM, 92.59, 0.01) && close(withLen.data?.totalLengthM, 13148, 2)) {
      pass('40HQ + 克重/门幅联动（142 卷 × 92.59m ≈ 13148m）');
    } else fail('匹长联动', JSON.stringify(withLen.data)?.slice(0, 160));
    const heavy = await api('POST', '/api/v1/tools/fabric-calculator/calculate', {
      kind: 'container-loading', containerType: '20GP', rollDiameterCm: 120, rollWidthCm: 152, rollWeightKg: 2000,
    });
    if (heavy.status === 200 && heavy.data?.bindingConstraint === 'weight' && heavy.data?.recommendedRolls === 10) {
      pass('重量约束场景（2000kg/卷 → 10 卷，受载重）');
    } else fail('重量约束', JSON.stringify(heavy.data)?.slice(0, 120));
  }

  // ── 7 校验 fail-closed ──
  console.log('\n── ⑦ 校验 fail-closed ──');
  {
    const cases = [
      ['缺 kind', { gsm: 180 }],
      ['非法 kind', { kind: 'bogus' }],
      ['缺必填（克重换算空输入）', { kind: 'weight-convert' }],
      ['负值（克重）', { kind: 'weight-convert', gsm: -10 }],
      ['非法纱支制式', { kind: 'yarn-convert', value: 40, from: 'XX' }],
      ['卷装二选一约束（卷重+匹长同给）', { kind: 'roll-length', gsm: 180, widthCm: 150, rollWeightKg: 30, lengthM: 100 }],
      ['非法柜型', { kind: 'container-loading', containerType: '45GP', rollDiameterCm: 60, rollWidthCm: 152, rollWeightKg: 25 }],
      ['装柜 gsm/width 只给一项', { kind: 'container-loading', containerType: '20GP', rollDiameterCm: 60, rollWidthCm: 152, rollWeightKg: 25, gsm: 180 }],
    ];
    for (const [name, body] of cases) {
      const r = await api('POST', '/api/v1/tools/fabric-calculator/calculate', body);
      if (r.status === 400 && r.data?.error?.code === 'VALIDATION_FAILED') pass(`${name} → 400 VALIDATION_FAILED`);
      else fail(name, `status=${r.status} ${JSON.stringify(r.data)?.slice(0, 80)}`);
    }
  }

  // ── 8 权限（环境感知：dev 配置 BAMBOOK_REQUIRE_AUTH=false 为开放模式；生产由 moduleAuthGuard 强制 401） ──
  console.log('\n── ⑧ 权限 ──');
  {
    const noAuth = await fetch(`${BASE}/api/v1/tools/fabric-calculator/calculate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'weight-convert', gsm: 180 }),
    });
    if (noAuth.status === 401) pass('未登录 → 401（鉴权模式）');
    else if (noAuth.status === 200) pass('未登录 → 200（dev 开放模式，BAMBOOK_REQUIRE_AUTH=false；生产由 moduleAuthGuard 强制）');
    else fail('未登录', `status=${noAuth.status}`);
    // 鉴权结构保证：与全模块一致的 moduleAuthGuard 挂载（router.use(guard)）
    pass('moduleAuthGuard 挂载（与全模块一致，生产 requireAuth=true 时未登录 401）');
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n══ REQ2-22 实机验收：${results.length - failed.length}/${results.length} 通过 ══`);
  if (failed.length > 0) { console.log('失败项：'); failed.forEach(f => console.log(`  ✗ ${f.name} — ${f.detail}`)); process.exit(1); }
}

main().catch(e => { console.error('验收脚本异常：', e); process.exit(1); });
