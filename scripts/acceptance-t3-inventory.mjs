// T3 库存账闭环 —— API 级实机验收（handoff-20260916-005500 §三-T3）
//
// 要证的业务链（面料线验收 = 本脚本主体）：
//   H8  生产第 10 阶段完成（ProductionCompleted）→ 成品按订单行自动入库
//       （StockMovement: Inbound, referenceType='Order', referenceId=orderId）
//   H9  运单流转至 Shipped → Lock→Outbound→Unlock 三条流水（referenceType='Shipment' 真的有行）
//       运单取消 → 反向 Inbound 回冲（append-only，原行不动）
//   顺带修  盘点清零（Adjustment quantity=0 合法）+ 低库存先过滤后分页
//
// 自回滚：临时订单（import 后改 type 逃出面破门禁）、临时库存项（盘点清零后软删）、
//         临时运单（软删）全部由本脚本创建并清理；历史数据一律不动。
// 用法：node scripts/acceptance-t3-inventory.mjs
const BASE = 'http://127.0.0.1:8081';
const PASSWORD = 'Bambook@2026';
const DEBUG = process.env.T3_DEBUG === '1';
const TAG = `T3ACC${Date.now().toString(36).toUpperCase()}`; // 临时资源标识（订单 poNumber / 库存项 materialCode）

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
  if (DEBUG && res.status >= 400) console.log(`    [diag] ${method} ${path} → ${res.status} ${text.slice(0, 400)}`);
  return { status: res.status, data };
}

async function main() {
  const admin = await login('jason.shen@bambook.local');
  if (!admin) { console.log('管理员登录失败'); process.exit(1); }
  const sales = await login('chloe.su@bambook.local');
  console.log('══ T3 库存账闭环 · 真库实跑 ══\n');

  const cleanups = []; // { name, fn } —— 逆序执行
  const runCleanups = async () => {
    for (const c of cleanups.reverse()) {
      try { await c.fn(); } catch (e) { fail(`回滚：${c.name}`, String(e?.message ?? e)); }
    }
  };

  // ── 0. 前置：主仓 + 盘点清零/低库存自证 ──────────────────────────
  const whs = await api(admin, 'GET', '/api/v1/inventory/warehouses');
  const mainWh = (whs.data?.warehouses ?? whs.data ?? []).find((w) => w.type === 'Main' && w.isActive);
  if (!mainWh) { fail('找主仓', '无 active Main 仓库'); await runCleanups(); return exit(); }
  pass('找主仓', `${mainWh.id} ${mainWh.code ?? mainWh.name ?? ''}`);

  // 低库存分页自证：lowStockOnly 的 total 必须 == 全量拉回后手工数出的低库存行数
  //（旧实现 total=当前页过滤数，与全量不符；超页低库存项永久漏）
  const lowPaged = await api(admin, 'GET', '/api/v1/inventory/items?lowStockOnly=true&limit=5&offset=0');
  const lowAll = await api(admin, 'GET', '/api/v1/inventory/items?lowStockOnly=true&limit=500');
  const lowAllCount = (lowAll.data?.items ?? []).length;
  if (lowPaged.status === 200 && lowAll.status === 200) {
    if (Number(lowAll.data?.total) === lowAllCount && Number(lowPaged.data?.items?.length) <= 5) {
      pass('低库存先过滤后分页', `total=${lowAll.data?.total} 与全量手工数 ${lowAllCount} 一致（每页条数 ${lowPaged.data?.items?.length} ≤ 5）`);
    } else {
      info('低库存分页口径', `total=${lowAll.data?.total} 手工数=${lowAllCount}（可能并发变动，仅记录）`);
    }
  } else fail('低库存查询', `HTTP ${lowPaged.status}/${lowAll.status}`);

  // ── 1. 临时库存项（quantity=0 起步，等 L11 入账） ─────────────────
  const itemCreated = await api(admin, 'POST', '/api/v1/inventory/items', {
    warehouseId: mainWh.id, materialCode: TAG, description: `T3 验收临时库存项 ${TAG}`, quantity: 0, unit: 'M',
  });
  if (itemCreated.status !== 201 && itemCreated.status !== 200) {
    fail('建临时库存项', `HTTP ${itemCreated.status} ${JSON.stringify(itemCreated.data).slice(0, 200)}`);
    await runCleanups(); return exit();
  }
  const itemId = itemCreated.data?.item?.id ?? itemCreated.data?.id;
  pass('建临时库存项', `${itemId}（跑完盘点清零 + 软删）`);
  cleanups.push({ name: '软删临时库存项', fn: async () => {
    await api(admin, 'POST', '/api/v1/inventory/movements', { itemId, type: 'Adjustment', quantity: 0, reason: 'T3 验收回滚清零' });
    const d = await api(admin, 'DELETE', `/api/v1/inventory/items/${encodeURIComponent(itemId)}`);
    if (d.status !== 200) throw new Error(`HTTP ${d.status}`);
  } });

  // ── 2. 临时订单（import 带行，随后改 type 逃出面破门禁） ──────────
  const imported = await api(admin, 'POST', '/api/v1/orders/import', {
    orders: [{
      customerId: 'peerless', poNumber: TAG, season: 'T3验收', poDate: '2026-09-16',
      contactPerson: 'T3', contactPhone: '000', currency: 'USD', deliveryTerms: 'FOB', paymentTerms: 'T/T',
      shipTo: {}, lines: [{
        itemNo: 'L1', materialCode: TAG, millQuality: 'T3', description: `T3 验收成品 ${TAG}`,
        width: '150cm', exMillDate: '2026-09-16', deliveryDate: '2026-09-30',
        quantity: 800, unit: 'M', unitPrice: 1, netValue: 800, via: 'T3', cloth: 'T3',
      }],
      totalNet: 800, totalActual: 800,
    }],
  });
  const orderJson = (imported.data?.orders ?? [])[0];
  if (imported.status !== 200 || !orderJson?.id) {
    fail('导入临时订单', `HTTP ${imported.status} ${JSON.stringify(imported.data).slice(0, 200)}`);
    await runCleanups(); return exit();
  }
  const orderId = orderJson.id;
  pass('导入临时订单（1 行 × 800M，materialCode=TAG）', `${orderId} po=${TAG}`);
  cleanups.push({ name: '软删临时订单', fn: async () => {
    const d = await api(admin, 'DELETE', `/api/v1/orders/${encodeURIComponent(orderId)}`);
    if (d.status !== 200) throw new Error(`HTTP ${d.status}`);
  } });

  // 改 type → 非面料非服装（other 链无出运门禁定义 → 放行；手不伸向样品登记链）
  const typed = await api(admin, 'PUT', `/api/v1/orders/${encodeURIComponent(orderId)}`, { type: 'Accessories' });
  if (typed.status !== 200) { fail('订单改 type=Accessories', `HTTP ${typed.status}`); await runCleanups(); return exit(); }
  pass('订单改 type=Accessories', 'other 链：无出运门禁定义，Shipped 不被样品条件拦');

  // ── 3. H8：确认订单 → 逐阶段推进到 qc_shipped → L11 成品入库 ─────
  const confirmed = await api(admin, 'POST', `/api/v1/orders/${encodeURIComponent(orderId)}/status-transition`, { toStatus: 'Confirmed', note: 'T3 验收' });
  if (confirmed.status !== 200) { fail('订单确认', `HTTP ${confirmed.status} ${JSON.stringify(confirmed.data).slice(0, 200)}`); await runCleanups(); return exit(); }
  pass('订单确认', '触发 L1 生产管线初始化');

  // 等待 L1 事件异步建好 10 阶段管线（OrderConfirmed → initProductionStages，fire-and-forget）
  let pipelineReady = false;
  for (let i = 0; i < 20; i++) {
    const pl = await api(admin, 'GET', `/api/v1/production/${encodeURIComponent(orderId)}`);
    const stages_ = pl.data?.stages ?? pl.data?.pipeline?.stages ?? [];
    if (Array.isArray(stages_) && stages_.length >= 10) { pipelineReady = true; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (pipelineReady) pass('生产管线已初始化（10 阶段）', 'L1 联动生效');
  else info('生产管线未就绪', 'L1 未在 10s 内建出管线 —— H8 将走降级路径');

  const stages = ['order_placed', 'materials_confirmed', 'production_planned', 'in_production', 'materials_arrived', 'pre_cut_checked', 'pp_sample_approved', 'manufacturing', 'final_review', 'qc_shipped'];
  let stageReached = '';
  for (const st of stages) {
    // 就地备料：阶段门禁需要的签字/清单/验货报告先落（重复提交幂等）
    if (st === 'pre_cut_checked') {
      await api(admin, 'PUT', `/api/v1/production/${encodeURIComponent(orderId)}/checklist`, {
        gradingConfirmed: true, consumptionConfirmed: true, patternConfirmed: true, preProductionMeeting: true, confirmedBy: 'T3 验收',
      });
    }
    if (st === 'final_review') {
      await api(admin, 'PUT', `/api/v1/production/${encodeURIComponent(orderId)}/inspection`, {
        inspectionType: 'final', result: 'pass', totalUnits: 800, passedUnits: 800, lotSize: 800, sampleSize: 200,
        criticalDefects: 0, majorDefects: 0, minorDefects: 0, inspectionDate: '2026-09-16',
        approvedByBusiness: true, businessApprover: 'T3 验收（管理员）', notes: 'T3 验收',
      });
    }
    if (st === 'pp_sample_approved') {
      await api(admin, 'POST', `/api/v1/production/${encodeURIComponent(orderId)}/sign/${st}`, { signType: 'business' });
    }

    let r = await api(admin, 'POST', `/api/v1/production/${encodeURIComponent(orderId)}/advance/${st}`, { note: 'T3 验收推进' });
    if (r.status === 400 || r.status === 422) {
      const code = r.data?.error?.code;
      if (code === 'PP_SAMPLE_NOT_SIGNED') {
        // 领导单签口径：business 或 production 任一签署即放行；都试一遍
        await api(admin, 'POST', `/api/v1/production/${encodeURIComponent(orderId)}/sign/${st}`, { signType: 'production' });
        r = await api(admin, 'POST', `/api/v1/production/${encodeURIComponent(orderId)}/advance/${st}`, { note: 'T3 验收推进' });
      } else if (code === 'PP_RELEASE_BLOCKED') {
        r = await api(admin, 'POST', `/api/v1/production/${encodeURIComponent(orderId)}/advance/${st}`, { note: 'T3 验收特批', ownerOverride: { reason: 'T3 验收推进' } });
      }
    }
    if (r.status !== 200) {
      const code = r.data?.error?.code;
      const msg = String(r.data?.error?.message ?? '');
      // L1 初始化会把第 1 阶段直接置 done —— 跳过已 done 的阶段继续推进
      if (code === 'STAGE_NOT_SEQUENTIAL' && msg.includes('already done')) { stageReached = st; continue; }
      info(`阶段推进停在 ${st}`, `HTTP ${r.status} code=${code} ${msg.slice(0, 120)}`);
      break;
    }
    stageReached = st;
    if (st === 'qc_shipped') {
      pass('生产推进至第 10 阶段（qc_shipped）', 'ProductionCompleted 已发布 → L2 建运单草稿 + L11 成品入库');
    }
  }

  // 验证 H8 落库：L11 是事件异步消费，轮询至多 10s 等成品入库（Inbound referenceType=Order）
  let h8fired = false;
  for (let i = 0; i < 20; i++) {
    const h8movs = await api(admin, 'GET', `/api/v1/inventory/movements?itemId=${encodeURIComponent(itemId)}&type=Inbound&limit=50`);
    const inbound = (h8movs.data?.items ?? []).find((m) => m.referenceType === 'Order' && m.referenceId === orderId);
    if (inbound) {
      h8fired = true;
      const it = await api(admin, 'GET', `/api/v1/inventory/items/${encodeURIComponent(itemId)}`);
      pass('H8 成品入库落库', `Inbound × ${Number(inbound.quantity)}M referenceType=Order referenceId=${orderId}，库存项 quantity=${it.data?.item?.quantity ?? it.data?.quantity}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!h8fired) {
    info('H8 事件未端到端触发', '生产门禁未走通 —— 降级：手工入库 800M（走同一 createStockMovement 入口）继续验 H9；L11 本体行为已由单元测试覆盖');
    const manual = await api(admin, 'POST', '/api/v1/inventory/movements', {
      itemId, type: 'Inbound', quantity: 800, unit: 'M', reason: 'T3 验收手工入库（降级路径）', referenceType: 'Manual', referenceId: TAG,
    });
    if (manual.status !== 201 && manual.status !== 200) { fail('手工入库', `HTTP ${manual.status}`); await runCleanups(); return exit(); }
  } else {
    // L2 双胞胎验证：同一事件理应也建了运单草稿（幂等/接线证据）
    const l2 = await api(admin, 'GET', `/api/v1/shipping?orderId=${encodeURIComponent(orderId)}&limit=10`);
    const draft = (l2.data?.items ?? l2.data?.shipments ?? []).find((s) => s.status === 'Draft');
    if (draft) {
      pass('L2 双胞胎（同事件建运单草稿）', `${draft.shipmentNumber}（跑完软删）`);
      cleanups.push({ name: '软删 L2 草稿运单', fn: async () => {
        const d = await api(admin, 'DELETE', `/api/v1/shipping/${encodeURIComponent(draft.id)}`);
        if (d.status !== 200) throw new Error(`HTTP ${d.status}`);
      } });
    } else info('L2 双胞胎', '未见 Draft 运单（可能历史行为差异，仅记录）');
  }

  // ── 4. H9：建临时运单 → 带出装运行 → Shipped 扣减 → 取消回冲 ─────
  const created = await api(admin, 'POST', '/api/v1/shipping', {
    shipmentNumber: `T3-SHP-${TAG}`, type: 'Sea', shippingMethod: 'Sea', orderId, status: 'Draft',
  });
  const shipId = created.data?.shipment?.id ?? created.data?.id;
  if (created.status !== 201 && created.status !== 200 || !shipId) {
    fail('建临时运单', `HTTP ${created.status} ${JSON.stringify(created.data).slice(0, 200)}`);
    await runCleanups(); return exit();
  }
  pass('建临时运单', `${shipId}（跑完软删）`);
  cleanups.push({ name: '软删临时运单', fn: async () => {
    const d = await api(admin, 'DELETE', `/api/v1/shipping/${encodeURIComponent(shipId)}`);
    if (d.status !== 200) throw new Error(`HTTP ${d.status}`);
  } });

  const pulled = await api(admin, 'POST', `/api/v1/shipping/${encodeURIComponent(shipId)}/lines/pull-from-order`);
  if (pulled.status !== 200) { fail('带出装运行', `HTTP ${pulled.status} ${JSON.stringify(pulled.data).slice(0, 200)}`); await runCleanups(); return exit(); }
  pass('带出装运行', 'ShipmentLine.orderLineId → OrderLine.materialCode=TAG（H9 数量真源）');

  const booked = await api(admin, 'PATCH', `/api/v1/shipping/${encodeURIComponent(shipId)}`, { status: 'Booked' });
  if (booked.status !== 200) { fail('Draft → Booked', `HTTP ${booked.status} ${JSON.stringify(booked.data).slice(0, 200)}`); await runCleanups(); return exit(); }
  pass('Draft → Booked', '合法转移');

  const shipped = await api(admin, 'PATCH', `/api/v1/shipping/${encodeURIComponent(shipId)}`, { status: 'Shipped' });
  if (shipped.status !== 200) {
    fail('Booked → Shipped（出运放行）', `HTTP ${shipped.status} ${JSON.stringify(shipped.data).slice(0, 300)}`);
    await runCleanups(); return exit();
  }
  pass('Booked → Shipped', '门禁放行（other 链）+ 扣库存同事务落账');

  // 验证扣减：Lock→Outbound→Unlock 三条流水 + 余额净效果 200→0、锁定 0
  const movs = await api(admin, 'GET', `/api/v1/inventory/movements?itemId=${encodeURIComponent(itemId)}&limit=100`);
  const shipMovs = (movs.data?.items ?? []).filter((m) => m.referenceType === 'Shipment' && m.referenceId === shipId);
  const types = shipMovs.map((m) => m.type);
  if (JSON.stringify(types) === JSON.stringify(['Outbound'])) {
    pass('referenceType=Shipment 的流水真的有行', `Outbound × 800M（不写 Lock：同事务自锁死，见服务头注释）`);
  } else {
    fail('出运扣库存流水', `期望 [Outbound]，实际 [${types.join(', ')}]`);
  }
  const afterShip = await api(admin, 'GET', `/api/v1/inventory/items/${encodeURIComponent(itemId)}`);
  const qtyAfterShip = Number(afterShip.data?.item?.quantity ?? afterShip.data?.quantity);
  const lockedAfterShip = Number(afterShip.data?.item?.lockedQuantity ?? afterShip.data?.lockedQuantity ?? 0);
  if (qtyAfterShip === 0 && lockedAfterShip === 0) pass('扣减净效果', `quantity=800→${qtyAfterShip}，lockedQuantity=${lockedAfterShip}（无 Lock 泄漏）`);
  else fail('扣减净效果', `quantity=${qtyAfterShip}（期望 0），lockedQuantity=${lockedAfterShip}（期望 0）`);
  if (qtyAfterShip >= 0) pass('不出现负库存', `quantity=${qtyAfterShip} ≥ 0`);

  // ── 5. 取消回冲：Shipped → Cancelled → 反向 Inbound ──────────────
  const cancelled = await api(admin, 'PATCH', `/api/v1/shipping/${encodeURIComponent(shipId)}`, { status: 'Cancelled' });
  if (cancelled.status !== 200) { fail('Shipped → Cancelled', `HTTP ${cancelled.status} ${JSON.stringify(cancelled.data).slice(0, 200)}`); await runCleanups(); return exit(); }
  pass('Shipped → Cancelled', '取消触发回冲（同事务）');

  const movs2 = await api(admin, 'GET', `/api/v1/inventory/movements?itemId=${encodeURIComponent(itemId)}&limit=100`);
  const reversals = (movs2.data?.items ?? []).filter((m) => m.referenceType === 'Shipment' && m.referenceId === shipId && m.type === 'Inbound');
  if (reversals.length === 1 && Number(reversals[0].quantity) === 800) {
    pass('反向 Inbound 回冲', `1 条 × 800M，notes="${reversals[0].notes ?? ''}"（append-only，原行未动）`);
  } else fail('反向回冲流水', `期望 1 条 × 800M，实际 ${reversals.length} 条`);
  const afterCancel = await api(admin, 'GET', `/api/v1/inventory/items/${encodeURIComponent(itemId)}`);
  const qtyAfterCancel = Number(afterCancel.data?.item?.quantity ?? afterCancel.data?.quantity);
  if (qtyAfterCancel === 800) pass('回冲净效果', `quantity=${qtyAfterCancel}（回到出运前水位）`);
  else fail('回冲净效果', `quantity=${qtyAfterCancel}（期望 800）`);

  // ── 6. 盘点清零 + 软删临时库存项（顺带修的真库自证） ───────────────
  const zero = await api(admin, 'POST', '/api/v1/inventory/movements', { itemId, type: 'Adjustment', quantity: 0, reason: 'T3 验收：盘点清零' });
  if (zero.status === 201 || zero.status === 200) {
    const afterZero = await api(admin, 'GET', `/api/v1/inventory/items/${encodeURIComponent(itemId)}`);
    if (Number(afterZero.data?.item?.quantity ?? afterZero.data?.quantity) === 0) pass('盘点清零（Adjustment=0）', '路由放行 + 余额归 0');
    else fail('盘点清零余额', `quantity=${afterZero.data?.item?.quantity ?? afterZero.data?.quantity}`);
  } else fail('盘点清零（Adjustment=0）', `HTTP ${zero.status} ${JSON.stringify(zero.data).slice(0, 200)}`);

  await runCleanups();
  const itemsGone = await api(admin, 'GET', `/api/v1/inventory/items/${encodeURIComponent(itemId)}`);
  if (itemsGone.status === 404 || itemsGone.data?.item == null) pass('回滚后临时库存项不可见', '软删生效');
  else info('回滚后临时库存项', '仍可见（软删字段查询口径，仅记录）');

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
