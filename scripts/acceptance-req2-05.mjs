// REQ2-05 面料工序级委外链 API 级实机验收
// 验收锚点（需求池原文）：任一面料订单可查看完整工序链进度与累计损耗；
//                        工序加工费计入 BOM/利润表（byType 聚合口径）
// 场景：三道工序链 坯布织造(10500→10400 ¥1.2) → 染整(10400→10200 ¥3.5) → 后整理(未完工 ¥0.8)
//   累计损耗 = (10500 − 10200) / 10500 = 2.857%
//   加工费合计 = 12480 + 35700 + 8160(预估) = 56340
const BASE = 'http://127.0.0.1:8081';
const EMAIL = 'chloe.su@bambook.local';
const PASSWORD = 'Bambook@2026';

const results = [];
let token = '';
function pass(name, detail = '') { results.push({ name, ok: true, detail }); console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
function fail(name, detail = '') { results.push({ name, ok: false, detail }); console.log(`  ✗ ${name} — ${detail}`); }

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

const ORDER = 'DEMO-PO-2601001'; // 面料订单（批次验收宿主）

async function main() {
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const login = await loginRes.json();
  if (!loginRes.ok || !login.token) { console.log('登录失败', loginRes.status); process.exit(1); }
  token = login.token;
  console.log(`登录成功：${login.user?.displayName ?? EMAIL}`);

  // 清场：删除该订单旧的 planned 验收节点（done 留痕不可删——核算约束）
  // seq 动态取当前最大值+1 起（幂等：done 历史节点保留，新链续号）
  const pre = await api('GET', `/api/v1/mes/order-processes?orderId=${encodeURIComponent(ORDER)}`);
  for (const n of (pre.data?.nodes || [])) {
    if (n.status === 'planned') await api('DELETE', `/api/v1/mes/order-processes/${n.id}`);
  }
  const maxSeq = (pre.data?.nodes || []).reduce((m, n) => Math.max(m, n.seq), 0);
  const S1 = maxSeq + 1, S2 = maxSeq + 2, S3 = maxSeq + 3;
  console.log(`工序链 seq：${S1}/${S2}/${S3}（历史 ${pre.data?.nodes?.length ?? 0} 节点，done 留痕）`);

  // ── 1 创建校验 ──
  console.log('\n── 创建校验 ──');
  {
    const bad = await api('POST', '/api/v1/mes/order-processes', {
      orderId: ORDER, seq: S1, processType: 'sewing', inputQty: 100, unitPrice: 1,
    });
    if (bad.status === 400 && bad.data?.error?.code === 'INVALID_PROCESS_TYPE') pass('工序类型枚举校验：sewing → 400（面料域限定）');
    else fail('工序类型枚举', JSON.stringify(bad.data).slice(0, 120));

    const badQty = await api('POST', '/api/v1/mes/order-processes', {
      orderId: ORDER, seq: S1, processType: 'dyeing', inputQty: 0, unitPrice: 1,
    });
    if (badQty.status === 400 && badQty.data?.error?.code === 'INVALID_QTY') pass('投入量校验：0 → 400 INVALID_QTY');
    else fail('投入量校验', JSON.stringify(badQty.data).slice(0, 120));
  }

  // ── 2 三道工序链登记 ──
  console.log('\n── 工序链登记（坯布→染整→后整理） ──');
  let n1 = '', n2 = '', n3 = '';
  {
    const r1 = await api('POST', '/api/v1/mes/order-processes', {
      orderId: ORDER, seq: S1, processType: 'gray_fabric', inputQty: 10500, unit: 'M', unitPrice: 1.2,
      notes: '验收链·白坯织造',
    });
    if (r1.status === 201 && Number(r1.data?.node?.amount) === 12600) {
      n1 = r1.data.node.id;
      pass('① 坯布织造：预估金额 = 投入 10500 × ¥1.2 = 12,600（estimate 口径）');
    } else fail('坯布织造登记', JSON.stringify(r1.data).slice(0, 150));

    const r2 = await api('POST', '/api/v1/mes/order-processes', {
      orderId: ORDER, seq: S2, processType: 'dyeing', inputQty: 10400, unit: 'M', unitPrice: 3.5,
      notes: '验收链·染整',
    });
    if (r2.status === 201) { n2 = r2.data.node.id; pass('② 染整：投入 10400 × ¥3.5 = 36,400（预估）'); }
    else fail('染整登记', JSON.stringify(r2.data).slice(0, 150));

    const r3 = await api('POST', '/api/v1/mes/order-processes', {
      orderId: ORDER, seq: S3, processType: 'finishing', inputQty: 10200, unit: 'M', unitPrice: 0.8,
      notes: '验收链·后整理（未完工）',
    });
    if (r3.status === 201) { n3 = r3.data.node.id; pass('③ 后整理：投入 10200 × ¥0.8 = 8,160（预估）'); }
    else fail('后整理登记', JSON.stringify(r3.data).slice(0, 150));

    const dup = await api('POST', '/api/v1/mes/order-processes', {
      orderId: ORDER, seq: S1, processType: 'dyeing', inputQty: 1, unitPrice: 1,
    });
    if (dup.status === 409 && dup.data?.error?.code === 'SEQ_DUP') pass('seq 唯一约束：重复序号 → 409 SEQ_DUP');
    else fail('seq 唯一约束', JSON.stringify(dup.data).slice(0, 120));
  }

  // ── 3 状态机 + 完工登记 ──
  console.log('\n── 开工/完工登记（损耗与金额自动重算） ──');
  {
    if (n1) {
      const start = await api('POST', `/api/v1/mes/order-processes/${n1}/start`, {});
      if (start.status === 200 && start.data?.node?.status === 'in_progress') pass('工序① 开工：planned → in_progress');
      else fail('工序①开工', JSON.stringify(start.data).slice(0, 120));

      const over = await api('POST', `/api/v1/mes/order-processes/${n1}/complete`, { outputQty: 10501 });
      if (over.status === 400 && over.data?.error?.code === 'OUTPUT_EXCEEDS_INPUT') pass('产出超投入 → 400 OUTPUT_EXCEEDS_INPUT');
      else fail('产出超投入校验', JSON.stringify(over.data).slice(0, 120));

      const done = await api('POST', `/api/v1/mes/order-processes/${n1}/complete`, { outputQty: 10400 });
      const loss1 = done.data?.lossPct;
      if (done.status === 200 && done.data?.node?.status === 'done' && loss1 === 0.9524) {
        pass('工序① 完工：10400 产出 → 损耗 0.9524% + 金额 12,480（按产出计费）');
      } else fail('工序①完工', `lossPct=${loss1} ${JSON.stringify(done.data?.node).slice(0, 120)}`);

      const done2 = await api('POST', `/api/v1/mes/order-processes/${n1}/complete`, { outputQty: 10000 });
      if (done2.status === 409 && done2.data?.error?.code === 'NODE_DONE') pass('二次完工拒 → 409 NODE_DONE（核算留痕）');
      else fail('二次完工拒', `status=${done2.status}`);
    }

    if (n2) {
      const done = await api('POST', `/api/v1/mes/order-processes/${n2}/complete`, { outputQty: 10200, actualUnitPrice: 3.5 });
      if (done.status === 200 && done.data?.lossPct === 1.9231) {
        pass('工序② 染整完工：10200 产出 → 损耗 1.9231% + 金额 35,700');
      } else fail('工序②完工', `lossPct=${done.data?.lossPct}`);
    }
  }

  // ── 4 全景聚合（验收锚点） ──
  console.log('\n── 订单工序链全景（验收锚点：进度 + 累计损耗 + 加工费合计） ──');
  {
    const r = await api('GET', `/api/v1/mes/order-processes?orderId=${encodeURIComponent(ORDER)}`);
    const { nodes, summary } = r.data || {};
    if (r.status === 200 && Array.isArray(nodes)) {
      const mine = nodes.filter(n => [S1, S2, S3].includes(n.seq));
      const seqs = mine.map(n => n.seq);
      if (seqs.includes(S1) && seqs.includes(S2) && seqs.includes(S3)) {
        pass(`完整工序链进度：${mine.map(n => `${n.seq}:${n.status === 'done' ? '✓' : n.status === 'in_progress' ? '◐' : '○'}`).join(' ')}`);
      } else fail('工序链完整性', JSON.stringify(seqs));

      if (summary.cumulativeLossPct != null) {
        // 验收链口径：首道投入 10500 → 末道 done 产出 10200 = 2.857%
        if (Math.abs(summary.cumulativeLossPct - 2.86) < 0.01) {
          pass(`累计损耗：${summary.cumulativeLossPct}%（首道投入 10500 → 末道完工产出 10200）`);
        } else fail('累计损耗', `got ${summary.cumulativeLossPct}%`);
      } else fail('累计损耗', 'null');

      // 加工费合计（含本链三道：12480 + 35700 + 8160 预估；可能有历史节点）
      if (summary.totalAmount >= 56340) {
        pass(`加工费合计：¥${summary.totalAmount.toLocaleString()}（验收链 56,340 = 12,480 完工 + 35,700 完工 + 8,160 预估）`);
      } else fail('加工费合计', `got ${summary.totalAmount}`);

      // byType 分解（BOM/利润表消费口径）
      const dyeing = (summary.byType || []).find(x => x.type === 'dyeing');
      if (dyeing && dyeing.amount >= 35700) pass(`分工序成本口径（BOM/利润表消费）：dyeing ¥${dyeing.amount.toLocaleString()}`);
      else fail('byType dyeing', JSON.stringify(summary.byType).slice(0, 120));
    } else fail('全景接口', `status=${r.status}`);
  }

  // ── 5 计划修正 + 软删约束 ──
  console.log('\n── 计划修正 + 软删约束 ──');
  {
    if (n3) {
      const upd = await api('PATCH', `/api/v1/mes/order-processes/${n3}`, { inputQty: 10200, unitPrice: 0.9 });
      if (upd.status === 200 && Number(upd.data?.node?.amount) === 9180) {
        pass('未完工改价：预估金额重算 10200 × ¥0.9 = 9,180');
      } else fail('未完工改价', JSON.stringify(upd.data?.node).slice(0, 120));

      // done 节点改计划字段拒绝
      if (n1) {
        const lock = await api('PATCH', `/api/v1/mes/order-processes/${n1}`, { inputQty: 999 });
        if (lock.status === 409 && lock.data?.error?.code === 'NODE_DONE') pass('已完工节点计划字段锁定 → 409 NODE_DONE');
        else fail('完工锁定', `status=${lock.status}`);
      }

      // 软删：planned 可删（n3 是 planned），done 拒
      if (n1) {
        const delDone = await api('DELETE', `/api/v1/mes/order-processes/${n1}`);
        if (delDone.status === 409 && delDone.data?.error?.code === 'NOT_PLANNED') pass('完工节点删除拒 → 409（核算留痕不可删）');
        else fail('完工删除拒', `status=${delDone.status}`);
      }
      const del = await api('DELETE', `/api/v1/mes/order-processes/${n3}`);
      if (del.status === 200) pass('软删：planned 节点可删');
      else fail('软删 planned', `status=${del.status}`);
    }
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n═══ REQ2-05 API 验收汇总：${results.length - failed.length}/${results.length} 通过 ${failed.length ? '· 失败 ' + failed.length : '· 全绿'} ═══`);
  if (failed.length) { failed.forEach(f => console.log(`  ✗ ${f.name}: ${f.detail}`)); process.exit(1); }
}

main().catch(e => { console.error('验收脚本异常：', e); process.exit(1); });
