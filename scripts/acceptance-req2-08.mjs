// REQ2-08 催款函套件 API 级实机验收
// 验收锚点（需求池原文 / 设计文档 §7）：
//   ① 账龄页选中客户→生成中英双语催款函→发送→登记记录 ≤5min → 全链 API 实测（选中客户→函→登记→历史可查）
//   ② 账龄明细注入（逾期天数/分段/多发票汇总）→ letter summary 逐发票明细 + 五桶汇总 + 总额
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
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function daysAgo(n) {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
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

  // ── 测试数据：2 张逾期发票（45 天 → d31_60 桶 / 100 天 → d90plus 桶）+ 1 张未到期（不入函）──
  const CUSTOMER = `催款验收客户-${Date.now().toString(36)}`;
  const CUR = 'USD';
  const createdIds = [];
  console.log('\n── 测试数据准备（多发票 · 跨账龄桶 · 含未到期干扰项）──');
  {
    const specs = [
      { no: `INV-DUN-1-${Date.now() % 100000}`, amount: 84000, dueDate: daysAgo(45), expectBucket: 'd31_60' },
      { no: `INV-DUN-2-${Date.now() % 100000}`, amount: 16000, dueDate: daysAgo(100), expectBucket: 'd90plus' },
    ];
    for (const s of specs) {
      const r = await api('POST', '/api/v1/finance', {
        invoiceNumber: s.no, type: 'Receivable', amount: s.amount, currency: CUR,
        issueDate: daysAgo(130), dueDate: s.dueDate, customerName: CUSTOMER, status: 'Issued',
      });
      if (r.status === 201 && r.data?.id) { createdIds.push(r.data.id); }
      else fail('发票创建', `status=${r.status} ${JSON.stringify(r.data)?.slice(0, 120)}`);
    }
    // 未到期干扰项（dueDate 在未来，不应入函）
    const rFuture = await api('POST', '/api/v1/finance', {
      invoiceNumber: `INV-DUN-F-${Date.now() % 100000}`, type: 'Receivable', amount: 5000, currency: CUR,
      issueDate: daysAgo(5), dueDate: daysAgo(-30), customerName: CUSTOMER, status: 'Issued',
    });
    if (rFuture.status === 201 && rFuture.data?.id) createdIds.push(rFuture.data.id);
    if (createdIds.length === 3) pass('测试发票 3 张落库（2 逾期 + 1 未到期干扰项）');
  }

  // ── 1 中英催款函生成（验收锚点②：账龄明细注入）──
  console.log('\n── 中英函生成（账龄明细注入）──');
  let letter = null;
  let chainStart = 0;
  {
    chainStart = Date.now();
    const r = await api('POST', '/api/v1/finance/dunning/letter', { customerName: CUSTOMER, currency: CUR });
    letter = r.data;
    if (r.status === 200 && r.data?.zh && r.data?.en && r.data?.summary) {
      pass('函生成 200：{zh, en, summary} 三段结构齐备');
    } else fail('函生成', `status=${r.status} ${JSON.stringify(r.data)?.slice(0, 160)}`);

    const s = letter?.summary;
    if (s) {
      // 多发票汇总（锚点②）：2 张逾期发票合计 100000，未到期干扰项排除
      if (s.invoiceCount === 2 && Math.abs(s.totalOverdue - 100000) < 0.01) {
        pass(`多发票汇总：invoiceCount=2 · totalOverdue=$${s.totalOverdue}（未到期 $5,000 干扰项正确排除）`);
      } else fail('多发票汇总', `count=${s.invoiceCount} total=${s.totalOverdue}`);

      // 逐发票明细：发票号/金额/到期日/逾期天数/分段
      const it1 = s.items.find(x => x.invoiceNumber?.includes('DUN-1'));
      const it2 = s.items.find(x => x.invoiceNumber?.includes('DUN-2'));
      const detailOk = it1 && it2
        && Math.abs(it1.open - 84000) < 0.01 && Math.abs(it2.open - 16000) < 0.01
        && it1.bucket === 'd31_60' && it2.bucket === 'd90plus'
        && it1.daysOverdue >= 44 && it1.daysOverdue <= 46
        && it2.daysOverdue >= 99 && it2.daysOverdue <= 101
        && it1.dueDate && it2.dueDate;
      if (detailOk) pass(`逐发票明细：45 天→31-60 桶（${it1.daysOverdue}d）/ 100 天→90+ 桶（${it2.daysOverdue}d），金额与到期日齐备`);
      else fail('逐发票明细', JSON.stringify(s.items));

      // 五桶汇总
      if (Math.abs(s.buckets.d31_60 - 84000) < 0.01 && Math.abs(s.buckets.d90plus - 16000) < 0.01) {
        pass('五桶汇总：d31_60=$84,000 · d90plus=$16,000');
      } else fail('五桶汇总', JSON.stringify(s.buckets));
    }

    // 中文函内容：明细表 + 汇总行注入
    const zhBody = letter?.zh?.body || '';
    if (zhBody.includes('DUN-1') && zhBody.includes('DUN-2') && zhBody.includes('84,000.00')
      && zhBody.includes('31-60 天') && zhBody.includes('90 天以上') && zhBody.includes('100,000.00')) {
      pass('中文函注入：发票号 + 金额 + 分段标签 + 总额全部出现在正文');
    } else fail('中文函注入', '正文缺少明细要素');

    // 英文函内容：Payment Reminder 同构
    const enBody = letter?.en?.body || '';
    const enSubject = letter?.en?.subject || '';
    if (enSubject.includes('Payment Reminder') && enBody.includes('DUN-1') && enBody.includes('31-60 Days')
      && enBody.includes('90+ Days') && enBody.includes('100,000.00')) {
      pass('英文函注入：Payment Reminder 主题 + 明细 + 分段（31-60 Days / 90+ Days）+ 总额');
    } else fail('英文函注入', '正文缺少明细要素');
  }

  // ── 2 登记催款记录（验收锚点①：发送→登记）──
  console.log('\n── 登记催款记录（快照留痕）──');
  let recordId = '';
  {
    const s = letter?.summary;
    if (!s) {
      fail('登记前置', '函生成失败，跳过登记断言');
    } else {
    const r = await api('POST', '/api/v1/finance/dunning', {
      customerName: CUSTOMER, currency: CUR,
      totalOverdue: s.totalOverdue, invoiceCount: s.invoiceCount, agingBuckets: s.buckets,
      channel: 'email', result: 'promised', note: 'API 验收登记', operator: 'gm',
    });
    if (r.status === 201 && r.data?.record?.id) {
      recordId = r.data.record.id;
      const rec = r.data.record;
      const snapOk = Math.abs(Number(rec.totalOverdue) - 100000) < 0.01 && rec.invoiceCount === 2
        && Math.abs(Number(rec.agingBuckets?.d90plus) - 16000) < 0.01;
      pass(`登记 201：${recordId}（快照：$100,000 · 2 张 · d90plus $16,000 留痕${snapOk ? '' : ' 不完整'}）`);
      if (!snapOk) fail('快照完整性', JSON.stringify(rec).slice(0, 160));
    } else fail('登记', `status=${r.status} ${JSON.stringify(r.data)?.slice(0, 160)}`);

    const invalidChannel = await api('POST', '/api/v1/finance/dunning', {
      customerName: CUSTOMER, currency: CUR, totalOverdue: 1, invoiceCount: 1,
      channel: 'fax', result: 'sent',
    });
    if (invalidChannel.status === 400) pass('非法渠道 fax → 400 INVALID_CHANNEL');
    else fail('非法渠道校验', `status=${invalidChannel.status}`);

    const invalidResult = await api('POST', '/api/v1/finance/dunning', {
      customerName: CUSTOMER, currency: CUR, totalOverdue: 1, invoiceCount: 1,
      channel: 'email', result: 'maybe',
    });
    if (invalidResult.status === 400) pass('非法结果 maybe → 400 INVALID_RESULT');
    else fail('非法结果校验', `status=${invalidResult.status}`);
    }
  }

  // ── 3 催款历史（登记后立即可查 → 全链闭环）──
  console.log('\n── 催款历史 ──');
  {
    const r = await api('GET', `/api/v1/finance/dunning?customerName=${encodeURIComponent(CUSTOMER)}`);
    const items = r.data?.items || [];
    const hit = items.find(x => x.id === recordId);
    if (r.status === 200 && hit) {
      pass(`历史可查：按客户过滤命中刚登记的 ${recordId}（共 ${items.length} 条）`);
    } else fail('历史查询', `status=${r.status} items=${items.length}`);
  }

  // ── 4 边界与异常 ──
  console.log('\n── 边界与异常 ──');
  {
    const noCur = await api('POST', '/api/v1/finance/dunning/letter', { customerName: CUSTOMER });
    if (noCur.status === 400) pass('缺币种 → 400 CURRENCY_REQUIRED');
    else fail('缺币种校验', `status=${noCur.status}`);

    const noCustomer = await api('POST', '/api/v1/finance/dunning/letter', { currency: CUR });
    if (noCustomer.status === 400) pass('缺客户 → 400 CUSTOMER_REQUIRED');
    else fail('缺客户校验', `status=${noCustomer.status}`);

    const noOverdue = await api('POST', '/api/v1/finance/dunning/letter', { customerName: '不存在的客户-xyz', currency: CUR });
    if (noOverdue.status === 409 && noOverdue.data?.error?.code === 'NO_OVERDUE') {
      pass('无逾期客户 → 409 NO_OVERDUE（前端可提示无逾期）');
    } else fail('无逾期校验', `status=${noOverdue.status}`);
  }

  // ── 5 全链耗时（≤5min 锚点）──
  {
    const chainMs = Date.now() - chainStart;
    if (chainMs < 5 * 60 * 1000) pass(`全链耗时 ${chainMs}ms（选中客户→中英函→登记→历史 ≤5min 锚点裕量充足）`);
    else fail('全链耗时', `${chainMs}ms`);
  }

  // ── 清理测试发票（软删）──
  for (const id of createdIds) {
    await api('DELETE', `/api/v1/finance/${id}`);
  }
  console.log(`\n清理：${createdIds.length} 张测试发票已软删`);

  const failed = results.filter(r => !r.ok);
  console.log(`\n═══ REQ2-08 验收结果：${results.length - failed.length}/${results.length} 通过 ═══`);
  if (failed.length) { console.log('失败项：'); failed.forEach(f => console.log(`  ✗ ${f.name} — ${f.detail}`)); process.exit(1); }
}

main().catch(e => { console.error('验收脚本异常：', e); process.exit(1); });
