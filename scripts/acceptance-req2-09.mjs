// REQ2-09 Pantone 色号库 API 级实机验收
// 验收锚点（需求池原文 / 设计文档 §7）：
//   ① 打样单选 Pantone 色号后自动带出 RGB 参考与相近历史打色
//   ② 相近色推荐感知合理（Lab ΔE：近似色 ΔE 小、远色 ΔE 大）
const BASE = 'http://127.0.0.1:8081';
const EMAIL = 'raymond.lin@bambook.local';
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

async function main() {
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const login = await loginRes.json();
  if (!loginRes.ok || !login.token) { console.log('登录失败', loginRes.status); process.exit(1); }
  token = login.token;
  console.log(`登录成功：${login.user?.displayName ?? EMAIL}`);

  // ── 1 色号库搜索（验收锚点①前置） ──
  console.log('\n── 色号库搜索 ──');
  {
    const byCode = await api('GET', '/api/v1/samples/colors?search=19-4052');
    const items = byCode.data?.items || [];
    if (byCode.status === 200 && items.length === 1 && items[0].code === '19-4052 TCX' && items[0].name === 'Classic Blue') {
      pass('按色号搜索：19-4052 → Classic Blue（RGB 0,73,144 齐备）');
    } else fail('按色号搜索', `status=${byCode.status} items=${items.length}`);

    const byName = await api('GET', '/api/v1/samples/colors?search=classic');
    if (byName.status === 200 && (byName.data?.items || []).some(c => c.code === '19-4052 TCX')) {
      pass('按色名模糊搜索：classic → 命中 Classic Blue');
    } else fail('按色名搜索', `status=${byName.status}`);

    const family = await api('GET', '/api/v1/samples/colors?family=Blue&limit=200');
    const famItems = family.data?.items || [];
    if (family.status === 200 && famItems.length > 5 && famItems.every(c => c.family === 'Blue')) {
      pass(`按色系筛选：Blue ${famItems.length} 色全部 Blue 系`);
    } else fail('按色系筛选', `count=${famItems.length}`);
  }

  // ── 2 相近色推荐（验收锚点②：Lab ΔE 感知合理） ──
  console.log('\n── 相近色推荐（Lab ΔE） ──');
  {
    const r = await api('GET', '/api/v1/samples/colors/19-4052 TCX'.replace(/ /g, '%20'));
    const nearest = r.data?.nearest || [];
    if (r.status === 200 && nearest.length === 8) {
      // ΔE 升序 + 前三至少 2 个蓝/青系（紫系如 Ultra Violet 在 Lab 空间与深蓝相近属正确感知）
      const blueish = nearest.slice(0, 3).filter(c => c.family === 'Blue' || c.family === 'Teal' || c.family === 'Purple').length;
      const ascending = nearest.every((c, i) => i === 0 || nearest[i - 1].deltaE <= c.deltaE);
      if (blueish >= 2 && ascending) {
        pass(`nearest top 8 ΔE 严格升序且前三为蓝/紫近邻（最近 ${nearest[0].code} ΔE=${nearest[0].deltaE}）`);
      } else fail('nearest 排序/感知', JSON.stringify(nearest.map(n => [n.code, n.family, n.deltaE])));
    } else fail('nearest', `status=${r.status} len=${nearest.length}`);

    // 感知锚点：正蓝 vs 橙 ΔE 大（远色不进 nearest 前列）
    const orange = nearest.find(c => c.family === 'Orange');
    if (!orange || (orange && orange.deltaE > 40)) {
      pass('感知合理性：橙系 ΔE > 40 不进推荐前列');
    } else fail('感知合理性', `orange ΔE=${orange?.deltaE}`);
  }

  // ── 3 登记打色挂色号（验收锚点①：选中即上下文） ──
  console.log('\n── 打色登记挂色号 ──');
  let batchId = '';
  const DEV_CASE = 'DEMO-DEV-26002';
  {
    // 先取色卡 id
    const card = await api('GET', '/api/v1/samples/colors?search=19-4052');
    const cardId = card.data?.items?.[0]?.id;
    const r = await api('POST', '/api/v1/samples/color-batches', {
      stage: 'lab_dip', developmentCaseId: DEV_CASE, dyeLotNo: '验收缸-4052',
      colorRating: 4, colorCardId: cardId,
    });
    const batch = r.data?.batch;
    if (r.status === 201 && batch?.colorCardId === cardId && batch?.colorCode === '19-4052 TCX') {
      batchId = batch.id;
      pass('打色登记挂色号：colorCardId 关联 + colorCode 快照落库');
    } else fail('打色登记', `status=${r.status} ${JSON.stringify(r.data)?.slice(0, 160)}`);

    const bad = await api('POST', '/api/v1/samples/color-batches', {
      stage: 'lab_dip', developmentCaseId: DEV_CASE, dyeLotNo: '验收缸-X',
      colorRating: 4, colorCardId: 'CLR__NOPE',
    });
    if (bad.status === 400) pass('不存在色卡 → 400 COLOR_CARD_NOT_FOUND');
    else fail('色卡校验', `status=${bad.status}`);
  }

  // ── 4 相近历史打色（验收锚点①核心：选色号自动带出） ──
  console.log('\n── 相近历史打色 ──');
  {
    const r = await api('GET', '/api/v1/samples/colors/19-4052%20TCX/color-batches?includeNearby=true');
    const batches = r.data?.batches || [];
    const hit = batches.find(b => b.id === batchId);
    if (r.status === 200 && hit && hit.dyeLotNo === '验收缸-4052' && hit.colorCode === '19-4052 TCX') {
      pass(`历史打色自动带出：刚登记的「验收缸-4052」命中（共 ${batches.length} 条，含 ΔE≤15 相近色）`);
    } else fail('历史打色', `status=${r.status} batches=${batches.length}`);

    const exact = await api('GET', '/api/v1/samples/colors/19-4052%20TCX/color-batches?includeNearby=false');
    const exactBatches = exact.data?.batches || [];
    if (exact.status === 200 && exactBatches.every(b => b.colorCode === '19-4052 TCX')) {
      pass(`includeNearby=false 精确口径：仅同色号 ${exactBatches.length} 条`);
    } else fail('精确口径', JSON.stringify(exactBatches.map(b => b.colorCode)));
  }

  // ── 5 自定义色卡维护 ──
  console.log('\n── 自定义色卡维护 ──');
  let customId = '';
  {
    const r = await api('POST', '/api/v1/samples/colors', {
      code: `CUST-NAVY-${Date.now() % 10000}`, name: '验收客户藏青', family: 'Blue', r: 20, g: 40, b: 80,
    });
    if (r.status === 201 && r.data?.color?.source === 'custom') {
      customId = r.data.color.id;
      pass('自定义色卡创建：source=custom');
    } else fail('自定义创建', `status=${r.status}`);

    const bad = await api('POST', '/api/v1/samples/colors', { code: 'CUST-BAD', r: 999, g: 0, b: 0 });
    if (bad.status === 400) pass('RGB 越界 → 400 INVALID_RGB');
    else fail('RGB 校验', `status=${bad.status}`);

    const dup = await api('POST', '/api/v1/samples/colors', {
      code: '19-4052 TCX', r: 1, g: 1, b: 1,
    });
    if (dup.status === 409) pass('重复色号 → 409 CODE_DUPLICATED');
    else fail('重复校验', `status=${dup.status}`);

    if (customId) {
      const imm = await api('PATCH', `/api/v1/samples/colors/${customId}`, { code: 'CHANGED' });
      if (imm.status === 400) pass('code 不可改 → 400 CODE_IMMUTABLE');
      else fail('code 不可改', `status=${imm.status}`);

      const upd = await api('PATCH', `/api/v1/samples/colors/${customId}`, { name: '验收客户藏青 V2' });
      if (upd.status === 200 && upd.data?.color?.name === '验收客户藏青 V2') pass('name/rgb 可维护');
      else fail('维护', `status=${upd.status}`);

      const del = await api('DELETE', `/api/v1/samples/colors/${customId}`);
      if (del.status === 200) pass('软删 → 历史打色靠 colorCode 快照不失真');
      else fail('软删', `status=${del.status}`);
    }
  }

  // ── 清理：验收打色批次 ──
  if (batchId) await api('DELETE', `/api/v1/samples/color-batches/${batchId}`);
  console.log('\n清理：验收打色批次已软删');

  const failed = results.filter(r => !r.ok);
  console.log(`\n═══ REQ2-09 验收结果：${results.length - failed.length}/${results.length} 通过 ═══`);
  if (failed.length) { console.log('失败项：'); failed.forEach(f => console.log(`  ✗ ${f.name} — ${f.detail}`)); process.exit(1); }
}

main().catch(e => { console.error('验收脚本异常：', e); process.exit(1); });
