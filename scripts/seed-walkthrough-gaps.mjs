#!/usr/bin/env node
/**
 * seed-walkthrough-gaps.mjs —— 给走查环境里"功能齐了但库里没料"的两站补模拟数据（v3.216，① 看得到）
 *
 * 为什么补这两张表：`远期结汇` 与 `信用证` 两站界面、门禁、端点都在，屏面老实写着
 * 「还没有登记远期结汇合约」——**空态是诚实的，但使用方走不到功能**（到期提醒、信用证卡片、变更史入口都要有行才看得见）。
 * ⇒ Kevin 09-25 定过口径：测试库就是本机业务库，**造数是本职**；本件只做"可回滚 + 按自己写入清"这一种造。
 *
 * 刻意**不做**的第三张表：`OrderInternalTransfer`（内部供料）。它要求 `orderId` 指向
 * `Order.isInternalFabricTrade = true` 的订单，而现量 **0 张**这样的订单 ⇒ 要补就得翻某个订单的内部标记，
 * 那会**改掉合并利润那三格已记录的读数**（223,072.50 / 97,348.86 / 125,723.64）⇒ 属"会动别人读数"的写面，先问再动。
 *
 * 三条安全闸：
 *   ① 只往已知演示库写（`panda_hub_local` / `pandahub`），别的库名一律拒（要放行须显式 BAMBOOK_SEED_ALLOW_DB=1）；
 *   ② 主键前缀固定 `FFX_seed_v3216_` / `LC_seed_v3216_` ⇒ `--revert` 的删除面**不宽于本件的写入面**；
 *   ③ 凭据只进 env（复用 `lib/drill-db.mjs` 那一份 parse），不进命令行、不进日志。
 *
 * 跑法：
 *   set -a; . ../Bambook/server/.env.local; set +a
 *   node scripts/seed-walkthrough-gaps.mjs --apply | --revert | --status
 */
import { parseDatabaseUrl } from './lib/drill-db.mjs';
import { spawnSync } from 'node:child_process';

const ALLOW_DB = ['panda_hub_local', 'pandahub'];
const src = parseDatabaseUrl(process.env.DATABASE_URL);
if (!src) { console.error('[红] DATABASE_URL 解析不出来 ⇒ 不跑'); process.exit(1); }
if (!ALLOW_DB.includes(src.db) && process.env.BAMBOOK_SEED_ALLOW_DB !== '1') {
  console.error(`[红] 目标库名「${src.db}」不在演示库白名单里 ⇒ 拒绝写入（这工具只给走查库造数）`);
  process.exit(1);
}
const env = { ...process.env, PGHOST: src.host, PGPORT: src.port, PGUSER: src.user, PGPASSWORD: src.password, PGDATABASE: src.db };
const sql = (text) => {
  const r = spawnSync('psql', ['-v', 'ON_ERROR_STOP=1', '-At', '-c', text], { encoding: 'utf8', env, maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('psql 失败：' + String(r.stderr || r.stdout).split('\n').slice(0, 2).join(' | ').slice(0, 240));
  return String(r.stdout || '').trim();
};
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const NOW = Date.now();

// ── 写入清单（业务形态：远期结汇是"卖出外币锁定汇率"，两笔一笔临期一笔远期；信用证按真实客户开）──
const FFX = [
  { id: 'FFX_seed_v3216_a', no: 'FFX-SEED-2026-0001', bank: '中国银行苏州工业园区分行', ccy: 'USD', amt: '480000.0000', rate: '7.12500000', signed: '2026-08-18', mature: '2026-09-30', status: 'Open', note: '走查演示数据（v3.216 造）：Q4 结汇锁价，临期一笔' },
  { id: 'FFX_seed_v3216_b', no: 'FFX-SEED-2026-0002', bank: '中国银行苏州工业园区分行', ccy: 'EUR', amt: '120000.0000', rate: '7.68000000', signed: '2026-09-05', mature: '2026-11-20', status: 'Open', note: '走查演示数据（v3.216 造）：欧元尾款' },
];
const LC = [
  { id: 'LC_seed_v3216_a', no: 'LC-SEED-2026-0001', rel: 'SIM-CUS-06', applicant: 'Cascadia Outfitters Inc.', amount: '128500.0000', status: 'Issued', issue: '2026-08-20', expiry: '2026-11-15', present: '2026-10-20', ship: '2026-10-05' },
  { id: 'LC_seed_v3216_b', no: 'LC-SEED-2026-0002', rel: 'SIM-CUS-04', applicant: 'Southern Cross Fashion Pty Ltd', amount: '96400.0000', status: 'Accepted', issue: '2026-07-28', expiry: '2026-10-30', present: '2026-09-30', ship: '2026-09-10' },
];

function apply() {
  // 前置：客户必须是真存在的 Relation（信用证挂的是 snapshot FK，挂错人＝屏面点开是空的）
  const ids = sql('select id from "Relation" where id in (\'SIM-CUS-06\',\'SIM-CUS-04\') and "deletedAt" is null');
  const have = ids.split('\n').filter(Boolean);
  if (have.length !== 2) throw new Error(`演示客户没双双在库（找到 ${have.length}/2）⇒ 中止，不写半套`);
  for (const f of FFX) {
    sql(`insert into "ForwardFxContract"
      ("id","contractNumber","bankName","currency","foreignAmount","contractRate","signedDate","maturityDate","status","notes","createdAt","updatedAt")
      values (${q(f.id)},${q(f.no)},${q(f.bank)},${q(f.ccy)},${f.amt},${f.rate},${q(f.signed)},${q(f.mature)},${q(f.status)},${q(f.note)},${NOW},${NOW})
      on conflict ("id") do nothing`);
  }
  for (const c of LC) {
    sql(`insert into "LetterOfCredit"
      ("id","lcNumber","relationId","applicant","beneficiary","type","status","issueDate","issueBank","advisingBank",
       "amount","currency","availableAmount","expiryDate","presentationDeadline","shipmentDeadline","tradeTerms",
       "portOfLoading","portOfDischarge","documentsRequired","createdAt","updatedAt")
      values (${q(c.id)},${q(c.no)},${q(c.rel)},${q(c.applicant)},'Bambook 竹衍','Irrevocable',${q(c.status)},${q(c.issue)},
       'DBS Bank Ltd, Singapore','中国银行苏州工业园区分行',${c.amount},'USD',${c.amount},${q(c.expiry)},${q(c.present)},${q(c.ship)},'FOB',
       'Shanghai, China','Los Angeles, USA','["商业发票","全套海运提单","装箱单","保险单","原产地证"]'::json,${NOW},${NOW})
      on conflict ("id") do nothing`);
  }
  console.log(`[现量] 写入后条数：远期结汇 ${sql('select count(*) from "ForwardFxContract"')} 张 · 信用证 ${sql('select count(*) from "LetterOfCredit"')} 张`);
  console.log(`[点名] 本件写的 id：${[...FFX, ...LC].map(x => x.id).join(', ')}`);
}

function revert() {
  const del = (tbl, col, prefix) => sql(`delete from "${tbl}" where "${col}" like '${prefix}%'`);
  const a = del('ForwardFxContract', 'id', 'FFX_seed_v3216_');
  const b = del('LetterOfCredit', 'id', 'LC_seed_v3216_');
  const n = (s) => Number(String(s).replace(/\D/g, '') || 0);
  if (n(a) > FFX.length || n(b) > LC.length) throw new Error(`删除面超出本件写入面（${a} / ${b}）⇒ 立刻停手`);
  console.log(`[清] 删掉 远期结汇 ${a} 张 · 信用证 ${b} 张 ⇒ 剩余 ${sql('select count(*) from "ForwardFxContract"')} / ${sql('select count(*) from "LetterOfCredit"')}`);
}

function status() {
  console.log(`[状态] 远期结汇 ${sql('select count(*) from "ForwardFxContract"')} 张（本件造的 ${sql("select count(*) from \"ForwardFxContract\" where id like 'FFX_seed_v3216_%'")}）`);
  console.log(`[状态] 信用证 ${sql('select count(*) from "LetterOfCredit"')} 张（本件造的 ${sql("select count(*) from \"LetterOfCredit\" where id like 'LC_seed_v3216_%'")}）`);
}

const arg = process.argv[2] ?? '--status';
try {
  if (arg === '--apply') apply(); else if (arg === '--revert') revert(); else if (arg === '--status') status();
  else { console.error('用法：--apply | --revert | --status'); process.exit(1); }
} catch (e) { console.error('[红] ' + (e?.message ?? e)); process.exit(1); }
