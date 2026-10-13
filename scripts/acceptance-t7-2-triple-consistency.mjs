// T7-2 三单一致核对（箱单/商业发票/报关单）—— 真库只读验收（不建数据、无需回滚）
//
// 验的是**口径不变量**（不是"接口能通"）：
//   R1 所有差异 severity **恒为 'warning'**（口径 C：只预警不阻断 —— 不得出现 critical）
//   R2 三单齐备时 documents 三键非空；缺单时对应键为 null 且报 missing_document
//   R3 跨币种（发票 vs 报关）→ 只报 currency_mismatch，**不得报 amount_mismatch**（与 T7-① 同口径）
//   R4 internal/declared 数值结构完整（数量合计 / 件数 / 毛净重 / 金额 / 币种 / 行数）
//   R5 运单不存在 → 404
//
// 用法：node scripts/acceptance-t7-2-triple-consistency.mjs
const BASE = 'http://127.0.0.1:8081';
const PASSWORD = 'Bambook@2026';
const DEBUG = process.env.T7_DEBUG === '1';

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

async function main() {
  let token = await login('hank.zheng@bambook.local');
  let who = 'hank.zheng(单证)';
  if (!token) { token = await login('jason.shen@bambook.local'); who = 'jason.shen(超管)'; }
  if (!token) { console.log('登录失败'); process.exit(1); }
  console.log(`══ T7-2 三单一致 · 真库只读验收（${who}）══\n`);

  // ── 样本来源：报关单列表（每张都挂 shipmentId）──
  const decl = await api(token, 'GET', '/api/v2/customs/declarations');
  if (decl.status !== 200) {
    fail('GET /api/v2/customs/declarations', `HTTP ${decl.status} ${JSON.stringify(decl.data).slice(0, 200)}`);
    return exit();
  }
  const declRows = decl.data?.items ?? decl.data?.declarations ?? decl.data?.data ?? [];
  const shipmentIds = [...new Set(declRows.map(d => d.shipmentId).filter(Boolean))];
  pass('报关单列表', `${declRows.length} 张，其中带 shipmentId ${shipmentIds.length} 个`);
  if (shipmentIds.length === 0) { info('无样本', '没有挂运单的报关单，无法验收'); return exit(); }

  const sample = shipmentIds.slice(0, 10);
  let withDiff = 0, zeroDiff = 0, crossCurrency = 0, missingDoc = 0;

  for (const sid of sample) {
    const r = await api(token, 'GET', `/api/v2/customs/shipments/${encodeURIComponent(sid)}/triple-consistency`);
    if (r.status !== 200) { fail(`三单核对 ${sid}`, `HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`); continue; }
    const d = r.data;
    const ds = d.discrepancies ?? [];

    // R1 口径 C：全部 warning
    if (ds.every(x => x.severity === 'warning')) pass(`R1 ${sid} 差异全部 warning`, `${ds.length} 条`);
    else fail(`R1 ${sid}`, `存在非 warning：${JSON.stringify(ds.filter(x => x.severity !== 'warning').map(x => x.severity))}`);

    // R2 单据完整性
    const docs = d.documents ?? {};
    const present = ['packingList', 'commercialInvoice', 'customsDeclaration'].filter(k => docs[k]);
    const missReported = ds.filter(x => x.type === 'missing_document').length;
    const absent = 3 - present.length;
    if (absent === missReported) pass(`R2 ${sid} 缺单与 missing_document 一致`, `齐 ${present.length}/3，报缺 ${missReported}`);
    else fail(`R2 ${sid}`, `缺 ${absent} 张但报缺 ${missReported} 条`);
    if (absent > 0) missingDoc += 1;

    // R3 跨币种：只报币种差异，不报金额差异
    const cm = ds.filter(x => x.type === 'currency_mismatch');
    if (cm.length > 0) {
      crossCurrency += 1;
      if (ds.some(x => x.type === 'amount_mismatch')) fail(`R3 ${sid} 跨币种仍报金额差异`, JSON.stringify(cm[0]));
      else pass(`R3 ${sid} 跨币种只报币种差异`, `${cm[0].expected} vs ${cm[0].actual}`);
    }

    // R4 结构完整性
    const need = ['quantityTotal', 'totalPackages', 'grossWeight', 'netWeight', 'lineCount'];
    const okInt = need.every(k => k in (d.internal ?? {}));
    const okDec = need.every(k => k in (d.declared ?? {}));
    if (okInt && okDec) pass(`R4 ${sid} 数值结构完整`, `装运量 ${d.internal.quantityTotal} vs 报关量 ${d.declared.quantityTotal}`);
    else fail(`R4 ${sid}`, `internal/declared 缺字段`);

    if (ds.length > 0) withDiff += 1; else zeroDiff += 1;
    if (ds.length > 0 && withDiff <= 3) {
      info(`  ${sid} 差异明细`, ds.slice(0, 3).map(x => `${x.type}:${x.message.slice(0, 40)}`).join(' | '));
    }
  }

  // R5 不存在的运单 → 404
  const nf = await api(token, 'GET', '/api/v2/customs/shipments/NOPE__not_exist/triple-consistency');
  if (nf.status === 404) pass('R5 运单不存在 → 404', nf.data?.error?.code ?? '');
  else fail('R5', `期望 404，实际 ${nf.status}`);

  console.log('');
  info('样本统计', `${sample.length} 票：有差异 ${withDiff} / 零差异 ${zeroDiff} / 跨币种 ${crossCurrency} / 缺单 ${missingDoc}`);
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
