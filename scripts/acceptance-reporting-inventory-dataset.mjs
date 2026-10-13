// 库存数据集进报表引擎 —— 真库验收（写路径用演练行 + 自回滚）
import { loadEnvForScript } from './lib/acceptance-selfcheck.mjs';
//
// 背景：报表引擎（src/reporting）此前只有 7 个数据集（订单/发票/收付凭证/运单/
// 增值税发票/付汇水单/退税申报），**没有库存** —— 报表引擎的消费方是
// 「保存的报表定义 + 定时任务（scheduledReportRunner → runReportDefinition）」，
// 所以没有库存数据集 = 无法定义/定时投递任何库存报表。
//
// 本批新增 inventoryItems 数据集，并把读 scope 收窄到 `inventory:read`
// （库存含**单位成本**= 金额，不能靠 reports:write 裸读）。
//
// 验的口径不变量：
//   R1 datasets 注册表含 inventoryItems，且维度含 ownership/unit/currency、指标含 unitCost
//   R2 **门控**：财务 charlie.qian（reports:write 但无 inventory:read）→ preview 403 INSUFFICIENT_SCOPE
//   R3 超管（有 inventory:read）→ preview 200 且返回行
//   R4 **独立重算**：脚本直连 DB 按 ownership/unit/currency 聚合 sum(quantity)，与接口逐行比对
//   R5 **软删排除（正反对照）**：造两条同维度演练行（一条软删一条正常，量 111/222）→
//      只有 222 被计入、111 不计入（否则「排除软删」的断言会**空过**）
//   R6 ownership 取值只应是 Owned / Transferred
//   R7 下钻（POST /drill）可用，返回明细行
//
// 自回滚：演练库存项按精确 id 硬删。
// 用法：node scripts/acceptance-reporting-inventory-dataset.mjs
const BASE = 'http://127.0.0.1:8081';
const PASSWORD = 'Bambook@2026';
const ADMIN = 'jason.shen@bambook.local';       // 有 inventory:read
const FINANCE = 'charlie.qian@bambook.local';   // reports:write 但**无** inventory:read

const results = [];
const pass = (n, d = '') => { results.push({ ok: true }); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n, d = '') => { results.push({ ok: false }); console.log(`  ✗ ${n} — ${d}`); };
const info = (n, d = '') => { results.push({ ok: null }); console.log(`  ⓘ ${n} — ${d}`); };

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
  return { status: res.status, data };
}

const TS = Date.now();
const ID_OK = `INV__DRILL_RPT_${TS}`;      // 正常行（应被计入）
const ID_DEL = `INV__DRILL_RPTDEL_${TS}`;  // 软删行（不得计入）
const CODE = `DRILL-RPT-${TS}`;
const QTY_OK = 222;
const QTY_DEL = 111;
const OWN = 'Owned';
const UNIT = 'M';
const CUR = 'CNY';

const PREVIEW_BODY = {
  datasetKey: 'inventoryItems',
  dimensions: ['ownership', 'unit', 'currency'],
  metrics: [{ field: 'quantity', agg: 'sum' }],
};

let prisma = null;
let warehouseId = null;
const created = [];

async function connectPrisma() {
  const { createRequire } = await import('node:module');
  const { SERVER_DIR } = await import('./lib/acceptance-selfcheck.mjs');
  const req = createRequire(SERVER_DIR + '/');
// ★ G-3c 第 11 批复核处置（BLOCK-2）：构造 client 之前先把**本仓**那份 env 装上；取不到就抛 ENV_MISSING，
//   宁可拒跑也不让 Prisma 去借别的 worktree 的 env（此前 19/21 是这么被借走的）。
loadEnvForScript();
  const { PrismaClient } = req('@prisma/client');
  prisma = new PrismaClient();
}

async function seed() {
  const wh = await prisma.warehouse.findFirst({ where: { deletedAt: null, isActive: true }, select: { id: true } });
  if (!wh) throw new Error('真库无可用仓库，无法造演练库存项');
  warehouseId = wh.id;
  const now = BigInt(Date.now());
  await prisma.inventoryItem.create({
    data: {
      id: ID_OK, warehouseId, materialCode: CODE, description: 'DRILL 报表演练行（正常）',
      category: 'Fabric', quantity: QTY_OK, lockedQuantity: 0, unit: UNIT,
      currency: CUR, ownership: OWN, createdAt: now, updatedAt: now,
    },
  });
  created.push(ID_OK);
  await prisma.inventoryItem.create({
    data: {
      id: ID_DEL, warehouseId, materialCode: CODE, description: 'DRILL 报表演练行（软删）',
      category: 'Fabric', quantity: QTY_DEL, lockedQuantity: 0, unit: UNIT,
      currency: CUR, ownership: OWN, createdAt: now, updatedAt: now, deletedAt: now,
    },
  });
  created.push(ID_DEL);
}

async function rollback() {
  try {
    const r = await prisma.inventoryItem.deleteMany({ where: { id: { in: created } } });
    pass('回滚：硬删演练库存项', `${r.count} 条`);
  } catch (e) {
    fail('回滚失败', `${e?.message} —— 需手工清理 ${created.join(' / ')}`);
  }
}

/** 脚本侧独立聚合（与接口同口径：排除软删，按 ownership/unit/currency 分组） */
async function independentAggregate() {
  const rows = await prisma.inventoryItem.findMany({
    where: { deletedAt: null },
    select: { ownership: true, unit: true, currency: true, quantity: true },
  });
  const map = new Map();
  for (const r of rows) {
    const k = `${r.ownership}|${r.unit}|${r.currency}`;
    map.set(k, (map.get(k) ?? 0) + Number(r.quantity));
  }
  return map;
}

async function main() {
  console.log('══ 库存数据集进报表引擎 · 真库验收（自回滚）══\n');
  await connectPrisma();
  await seed();
  pass('建演练数据', `仓库 ${warehouseId}｜正常行 ${QTY_OK} + 软删行 ${QTY_DEL}（同为 ${OWN}/${UNIT}/${CUR}）`);

  const adminToken = await login(ADMIN);
  const financeToken = await login(FINANCE);
  if (!adminToken) { fail('超管登录', ADMIN); return; }
  if (!financeToken) { fail('财务登录', FINANCE); return; }
  pass('登录', `${ADMIN}（有 inventory:read）+ ${FINANCE}（无）`);

  // ── R1 注册表 ──────────────────────────────────────────────────────
  const ds = await api(adminToken, 'GET', '/api/v1/reports/datasets');
  if (ds.status !== 200) { fail('R1 datasets 端点', `HTTP ${ds.status}`); return; }
  const inv = (ds.data?.datasets ?? []).find(d => d.key === 'inventoryItems');
  if (!inv) { fail('R1 注册表含 inventoryItems', `实际 keys：${(ds.data?.datasets ?? []).map(d => d.key).join(',')}`); return; }
  pass('R1 注册表含 inventoryItems', `${inv.label}｜维度 ${inv.dimensions.length} / 指标 ${inv.metrics.length}`);
  const dimKeys = (inv.dimensions ?? []).map(d => d.key);
  for (const need of ['ownership', 'unit', 'currency']) {
    if (dimKeys.includes(need)) pass(`R1 维度含 ${need}`);
    else fail(`R1 维度缺 ${need}`, dimKeys.join(','));
  }
  if ((inv.metrics ?? []).some(m => m.key === 'unitCost')) pass('R1 指标含 unitCost（金额）');
  else fail('R1 指标缺 unitCost', JSON.stringify(inv.metrics));

  // ── R2 门控：财务无 inventory:read → 403 ──────────────────────────
  const denied = await api(financeToken, 'POST', '/api/v1/reports/preview', PREVIEW_BODY);
  if (denied.status === 403 && denied.data?.error?.code === 'INSUFFICIENT_SCOPE') {
    pass('R2 财务（无 inventory:read）→ 403', denied.data.error.message);
  } else {
    fail('R2 门控失效', `期望 403/INSUFFICIENT_SCOPE，实际 ${denied.status} ${JSON.stringify(denied.data).slice(0, 160)}`);
  }

  // ── R3 超管放行 ───────────────────────────────────────────────────
  const prev = await api(adminToken, 'POST', '/api/v1/reports/preview', PREVIEW_BODY);
  if (prev.status !== 200) { fail('R3 超管 preview', `HTTP ${prev.status} ${JSON.stringify(prev.data).slice(0, 160)}`); return; }
  const rows = prev.data?.rows ?? [];
  pass('R3 超管 preview 200', `${rows.length} 行｜columns=${(prev.data?.columns ?? []).join(',')}`);

  // ── R4 独立重算逐行比对 ───────────────────────────────────────────
  // 指标列名由引擎生成（形如 `sum(quantity)`），**不要硬编码** —— 从 columnLabels 反查
  // 注意：引擎会给指标标签加聚合后缀（如「库存数量(合计)」）→ 用前缀匹配
  const colLabels = prev.data?.columnLabels ?? [];
  const colKeys = prev.data?.columns ?? [];
  const qtyIdx = colLabels.findIndex(l => String(l).startsWith('库存数量'));
  if (qtyIdx < 0) {
    fail('R4 找不到「库存数量」列', `columnLabels=${JSON.stringify(colLabels)}`);
    return;
  }
  const qtyKey = colKeys[qtyIdx];
  pass('R4 指标列名', `${qtyKey}（label=${colLabels[qtyIdx]}）`);

  const mine = await independentAggregate();
  const mineKey = `${OWN}|${UNIT}|${CUR}`;
  const expected = mine.get(mineKey);
  if (expected === undefined) {
    fail('R4 独立重算', `脚本侧没有 ${mineKey} 分组 —— 演练行可能未落库`);
  } else {
    const apiRow = rows.find(r => r.ownership === OWN && r.unit === UNIT && r.currency === CUR);
    const apiVal = apiRow ? Number(apiRow[qtyKey]) : null;
    // Decimal 经 JSON 往返会有浮点尾差 → 容差比较（4 位小数口径）
    if (apiVal !== null && Math.abs(apiVal - expected) < 0.0002) {
      pass('R4 接口值 = 脚本独立重算', `${mineKey} → ${apiVal}`);
    } else {
      fail('R4 值不一致', `接口 ${apiVal} vs 独立重算 ${expected}（row=${JSON.stringify(apiRow)}）`);
    }
  }

  // ── R5 软删排除（正反对照，避免空过）─────────────────────────────
  if (expected !== undefined && expected >= QTY_OK) {
    pass('R5 正常行已计入', `分组合计 ${expected} ≥ ${QTY_OK}`);
  } else {
    fail('R5 正常行未计入', `分组合计 ${expected}，期望 ≥ ${QTY_OK}`);
  }
  // 若软删行被计入，分组合计会多出 QTY_DEL；用「除以 111 不可整除」这类巧合不可靠，
  // 改为直接断言：软删行的 id 不得出现在下钻明细里（下面 R7 一起验）
  const drill = await api(adminToken, 'POST', '/api/v1/reports/drill', {
    ...PREVIEW_BODY, group: { ownership: OWN, unit: UNIT, currency: CUR },
  });
  if (drill.status === 200) {
    const detail = drill.data?.rows ?? drill.data?.items ?? [];
    const ids = detail.map(r => r.id);
    if (ids.includes(ID_OK)) pass('R7 下钻返回正常行明细', `id=${ID_OK}`);
    else fail('R7 下钻缺正常行', `明细 ${ids.length} 行里没有 ${ID_OK}`);
    if (!ids.includes(ID_DEL)) pass('R5 软删行**未**出现在下钻明细', `已排除 ${ID_DEL}`);
    else fail('R5 软删未排除', `${ID_DEL} 出现在明细里`);
  } else {
    fail('R7 下钻', `HTTP ${drill.status} ${JSON.stringify(drill.data).slice(0, 160)}`);
  }

  // ── R6 ownership 取值合法 ─────────────────────────────────────────
  const owners = [...new Set(rows.map(r => r.ownership))];
  const bad = owners.filter(o => o !== 'Owned' && o !== 'Transferred');
  if (bad.length === 0) pass('R6 ownership 取值合法', owners.join(','));
  else fail('R6 ownership 非法值', bad.join(','));
}

try {
  await main();
} catch (e) {
  console.error('脚本异常', e);
  fail('脚本异常', String(e).slice(0, 300));
} finally {
  if (!prisma) await connectPrisma().catch(() => {});
  if (created.length) await rollback();
  const ok = results.filter(r => r.ok === true).length;
  const bad = results.filter(r => r.ok === false).length;
  const notes = results.filter(r => r.ok === null).length;
  console.log(`\n══ 结果：${ok} 通过 / ${bad} 失败 / ${notes} 需知会 ══`);
  if (prisma) await prisma.$disconnect().catch(() => {});
  process.exit(bad === 0 ? 0 : 1);
}
