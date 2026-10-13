// 整链端到端业务模拟演练（2026-09-19）—— 一条真实业务单走完全链
//
// 为什么需要它：仓库里已有 63 个「单点」验收脚本（各自只验一个环节），
// **没有一条单子从头走到尾**。单点全绿 ≠ 链子通 —— 环节之间的**数字传递**
// （订单额 → 批次计划额 → 批次已开票额 → 收款核销 → 折让）才是真正会错的地方。
//
// 覆盖链路（服装外贸日常顺序）：
//   S1 客户档案 → S2 报价（发→接受）→ S3 转订单（确认）
//   → S4 分批出运 → S5 报关 → S6 分批开票 → S7 收汇核销 → S8 索赔折让
//
// 判据三态：pass / fail / gap（gap = 待业务拍板或本批未覆盖，不计入退出码）
//
// ★ 演练纪律（本仓血泪）：
//   1. 全部用 DRILLCHAIN 前缀标识，绝不碰真库生产实体
//   2. 回滚按「精确 ID」+「前缀扫描」双路，并清联动副作用
//      （EntityReference / EntityLink / AuditLog / ApprovalRequest）
//   3. **不信回滚自述** —— 独立 count 复核必须全为 0
//   4. 断言必须有阳性对照，避免「空过的验证器」
//
// 用法：node scripts/acceptance-e2e-business-chain.mjs
//       CHAIN_DEBUG=1 node scripts/acceptance-e2e-business-chain.mjs   # 打印 4xx/5xx 响应体
import { createRequire } from 'node:module';
import { SERVER_DIR, loadEnvForScript, selfCheck, isTrustworthy, formatBanner, attributionRefuse, emitResidueVerdict, createReporter, finishRun, verdictLine, assertResidueAudited, countAllModels, rowDelta, countCreatedInWindow, conservationCheck, canonModel, mergeDeleted, snapshotIdSets, pkDiff, deletedRowAttribution, readDbTarget, runAccusationAxisControl } from './lib/acceptance-selfcheck.mjs';
// ★ 全模型残留清扫器（详见 lib 头部注释）：手写回滚清单必然漏 ⇒ 按标识全模型兜底
import { settleAndClean, sweepResidue, SIM_DATASET_MARKERS } from './lib/drill-residue.mjs';
// ★ S4 任务3：跨环节数字对撞的订单额 ⇒ 走唯一真源（原写法 `quoteAmount ?? totalNet ?? contractAmount`
//   三个字段任意顺序，与真源次序 ①Σ明细行 → ②totalNet → ③quoteAmount 都不同）。
//   注意：这里**显式带 .ts** —— node ≥22.18 默认类型剥离，`.mjs` 可直接 import TS 真源。
import { orderAmountOf } from '../server/src/shared/orderAmount.ts';

// ★ B160：原先这行是常量 8081 —— 而"谁占着 8081"与本仓是哪个 checkout 无关（实测过：
//   另一个 checkout 的服务长期占着它，它自报的 build 与本仓 HEAD 不同）。
//   现在仍可指（CHAIN_BASE），但**指到哪儿都要先自证**，见 main() 开头那道闸。
const BASE = process.env.CHAIN_BASE || 'http://127.0.0.1:8081';
const ALLOW_UNATTRIBUTED = process.argv.includes('--allow-unattributed');
/** ★ v3.87（goal ②-2）：S6「批次已开票额 = 各自发票额」这条对撞此前**没有阳性对照**（覆盖面规则要求每条都能红）。
 *  `--poison-invoiced` 把**期望值**改 1 个数（只动内存里的期望、不写库、不碰被测系统），
 *  用来证「比较器 → fail 分支 → finishRun → 退出码」这条链真有牙 —— 不是只证比较器会打印。
 *  落定轮询仍用真值（那是"等它收敛"，不是判决），所以投毒不改变跑时长。 */
const POISON_INVOICED = process.argv.includes('--poison-invoiced');
/** 起手硬前置：这份读数能不能署在本分支本 commit 上。**放在连库之前**（顺序是有意的：
 *  connectPrisma 会先因本仓无 env 而抛 ENV_MISSING ⇒ 那样"打错服务"这一整类错误会被 env 问题挡在后面看不见，
 *  而门禁里想给这条断言配确定性对照（指一个必然没人监听的端口）也就做不成了。 */
function gateAttribution() {
  // ★ v3.47：这次真的只打 BASE 这一个地址 ⇒ 取证就取它的端口（不多取、不少取）
  const targetPort = String(urlPortOf(BASE));
  const sc = selfCheck({ targetPorts: [targetPort] });
  const t = isTrustworthy(sc);
  // ★ 两种情况都要打（复核发现跑器原来只在 !ok 时才 formatBanner ⇒ "日志里没有自证块"同时意味着
  //   ①测过且可信 ②压根没测 —— 缺席不等于通过，这一格必须可分辨）
  console.log(formatBanner(sc));
  if (!t.ok) {
    console.log(`   库：${sc.db.name ?? '未知'}@${sc.db.host ?? '?'} · 后端 pid 见上`);
    if (attributionRefuse(t, ALLOW_UNATTRIBUTED)) {
      // ⚠️ v3.35（复核 ②）：这段话**刻意回避"不能署到本次改动"那四个字的各种同义写法** ——
      //   上一批那条负面对照正是被这段拒跑话术喂绿的（断"输出里还有那个词"时，测的是我的文案，不是判决行）。
      console.error('★ B160 读数不能署到本次改动 ⇒ 拒绝开跑整链（它会在别人的服务上写、在自己的库里数残留）。'
        + '\n   该修的是"打的是谁的服务"：把本仓后端起起来，或用 CHAIN_BASE 指到它。'
        + '\n   确实要看别的分支跑到什么程度，就显式加 --allow-unattributed（加了也照样在判决行里留痕）。');
      process.exit(3);
    }
    console.log('   ⚠️ 已显式越过 ⇒ 继续跑；这份读数的状态会原样出现在末尾判决行');
  }
  return { ok: t.ok, reasons: t.reasons, head: sc.head, branch: sc.branch, db: sc.db.name };
}
const PASSWORD = 'Bambook@2026';
const DEBUG = process.env.CHAIN_DEBUG === '1';

const TS = Date.now().toString(36).toUpperCase();
const MARK = `DRILLCHAIN${TS}`;
const REL_ID = `REL__${MARK}`;
const PO_NO = `DRILL-PO-${TS}`;
const INV_NO_1 = `DRILL-INV-${TS}-B1`;
const INV_NO_2 = `DRILL-INV-${TS}-B2`;
const PV_NO = `DRILL-PV-${TS}`;
const CD_NO = `DRILL-CD-${TS}`;
const HS_CODE = '9999.99.97'; // 演练专用税则码

const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const plusDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// ── 三态计数 ─────────────────────────────────────────────────────────
// ★ v3.39（B165）：pass/fail/gap 不再是本地三行 lambda，而是 lib 的**带闸 reporter**——
//   残留族的句子只能等于 lib 的规范标签、且全 run 只许一次（越界或重复当场抛，由 main().catch 退 2）。
//   为什么搬：上一批的证人全是"读源码"，复核实测三条绕行（if(false) 包住 / 换措辞再写一句 / 塞进字符串）
//   全部不红 ⇒ 结论的唯一性与出处改由**执行**决定，不由文本决定。
const rep = createReporter({ log: console.log });
const { pass, fail, gap } = rep;
const step = (s) => console.log(`\n── ${s} ──`);
const num = (v) => (v === null || v === undefined ? null : Number(v));

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
  if (DEBUG && res.status >= 400) console.log(`    [diag] ${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return { status: res.status, data, text };
}

// ── Prisma（仅用于回滚与独立复核；被测写路径一律走 HTTP）──────────────
let prisma = null;
let PrismaRef = null;
async function connectPrisma() {
  const req = createRequire(SERVER_DIR + '/');
// ★ G-3c 第 11 批复核处置（BLOCK-2）：构造 client 之前先把**本仓**那份 env 装上；取不到就抛 ENV_MISSING，
//   宁可拒跑也不让 Prisma 去借别的 worktree 的 env（此前 19/21 是这么被借走的）。
loadEnvForScript();
  const { PrismaClient, Prisma } = req('@prisma/client');
  prisma = new PrismaClient();
  PrismaRef = Prisma;
}

// 演练产生的实体（按精确 ID 回滚）
const created = { relationId: null, quotationId: null, orderId: null, orderPoNumber: null, batchIds: [], declarationId: null, invoiceIds: [], voucherId: null, claimCaseId: null, dispositionIds: [], creditNoteIds: [], shipmentIds: [], bomIds: [], auditIds: [] };

/** 所有可精确指认的演练 id（用于清联动副作用） */
const allIds = () => [
  created.relationId, created.quotationId, created.orderId,
  ...created.batchIds, created.declarationId, ...created.invoiceIds,
  created.voucherId, created.claimCaseId, ...created.dispositionIds,
  ...created.creditNoteIds, ...created.shipmentIds, ...created.bomIds, ...created.auditIds,
].filter(Boolean);

/** ★ v3.59：链上"手写清单"这一路删了多少，也要进守恒校验。
 *  原先只有 `settleAndClean` 的 byModel 被喂进去 ⇒ Order / Relation / EntityReference 这些**链自己删的**行
 *  在 overDeleted 眼里等于没删过 ⇒ 漏报（方向不是误报，但让我那句"删面宽于写入"只覆盖了部分删除面）。 */
const OWN_DELETES = {};
// ★ v3.70（B178）逐主键守恒的数据源：删除**之前**用**同一个 where 对象**预读行身份。
//   为什么放得下：`findMany({ ...arg, select })` 与 `deleteMany(arg)` 共用一个 `arg` 引用
//   ⇒ 谓词不可能漂移（两条各写一遍才有的那种错，这里结构上不存在）。
//   ⚠️ 这只改"读"，不改删除面：删什么、删几张、按什么条件删，全部与改造前逐字相同。
const OWN_DELETED_ROWS = {};      // model → [{id, createdAt|null}]；不进这张表 = 预读没接上/没对齐 ⇒ 交给 unknown
const DEL_READ_BAD = new Set();   // 预读失败 或 预读条数 ≠ 实删条数 ⇒ 整张表按"判不了"处理（不许悄悄放行）
async function tryDel(name, delegate, arg, opts = {}) {
  let rows = null;
  try {
    rows = await delegate.findMany({ ...arg, select: { id: true, createdAt: true } });
  } catch {
    try { rows = await delegate.findMany({ ...arg, select: { id: true } }); }
    catch (e) { rows = null; DEL_READ_BAD.add(name); console.log(`     ! 预读 ${name} 失败 ⇒ 这一张退回"判不了"（不指控也不放行）：${String(e?.message ?? e).slice(0, 90)}`); }
  }
  try {
    const r = opts.tolerate ? await delegate.deleteMany(arg).catch(() => ({ count: 0 })) : await delegate.deleteMany(arg);
    const n = r?.count ?? 0;
    if (n) {
      console.log(`     · 删除 ${name}：${n} 行`);
      OWN_DELETES[name] = (OWN_DELETES[name] ?? 0) + n;
      const list = (rows ?? []).map((x) => ({ id: String(x.id), createdAt: x.createdAt ?? null }));
      if (rows && list.length !== n) {
        // 中间有别人写过/删过 ⇒ 预读不再等于实删。差额方向未知，整张表按判不了处理（fail-closed）。
        DEL_READ_BAD.add(name);
        console.log(`     ! 预读 ${name} = ${list.length} 行 ≠ 实删 ${n} 行 ⇒ 这张表不进逐主键守恒`);
      } else if (rows) {
        (OWN_DELETED_ROWS[name] = OWN_DELETED_ROWS[name] ?? []).push(...list);
      }
    }
    return n;
  } catch (e) { console.log(`     ! 删除 ${name} 失败：${String(e?.message ?? e).slice(0, 160)}`); return -1; }
}

/** 回滚：引用方 → 被引用方；最后清联动副作用 */
async function rollback() {
  console.log('\n── 回滚 ──');
  const orderId = created.orderId, invIds = created.invoiceIds, voucherId = created.voucherId;
  const batchIds = created.batchIds, declId = created.declarationId, caseId = created.claimCaseId;

  // 索赔族
  await tryDel('CreditNoteAllocation', prisma.creditNoteAllocation, { where: { OR: [{ creditNoteId: { in: created.creditNoteIds } }, { invoiceId: { in: invIds } }] } });
  await tryDel('CreditNote', prisma.creditNote, { where: { OR: [{ id: { in: created.creditNoteIds } }, { customerRelationId: REL_ID }] } });
  await tryDel('ClaimDisposition', prisma.claimDisposition, { where: { OR: [{ id: { in: created.dispositionIds } }, ...(caseId ? [{ claimCaseId: caseId }] : [])] } });
  await tryDel('ClaimCase', prisma.claimCase, { where: { OR: [{ customerRelationId: REL_ID }, ...(caseId ? [{ id: caseId }] : [])] } });

  // 财务族
  await tryDel('InvoiceAllocation', prisma.invoiceAllocation, { where: { OR: [{ invoiceId: { in: invIds } }, ...(voucherId ? [{ voucherId }] : [])] } });
  await tryDel('InvoiceOrderAllocation', prisma.invoiceOrderAllocation, { where: { OR: [{ invoiceId: { in: invIds } }, ...(orderId ? [{ orderId }] : [])] } });
  await tryDel('InvoiceLine', prisma.invoiceLine, { where: { invoiceId: { in: invIds } } });
  await tryDel('Invoice', prisma.invoice, { where: { OR: [{ id: { in: invIds } }, { invoiceNumber: { in: [INV_NO_1, INV_NO_2] } }] } });
  await tryDel('PaymentVoucher', prisma.paymentVoucher, { where: { OR: [{ id: voucherId ?? '__none__' }, { voucherNumber: PV_NO }] } });

  // 报关/退税
  await tryDel('TaxRefund', prisma.taxRefund, { where: { OR: [{ declarationId: declId ?? '__none__' }, { notes: { contains: MARK } }] } });
  await tryDel('CustomsDeclarationLine', prisma.customsDeclarationLine, { where: { declarationId: declId ?? '__none__' } });
  await tryDel('CustomsDeclaration', prisma.customsDeclaration, { where: { OR: [{ id: declId ?? '__none__' }, { declarationNumber: CD_NO }] } });

  // 出运族
  await tryDel('ShipmentOrderAllocation', prisma.shipmentOrderAllocation, { where: { OR: [{ shipmentId: { in: created.shipmentIds } }, ...(orderId ? [{ orderId }] : [])] } });
  await tryDel('ShipmentLine', prisma.shipmentLine, { where: { shipmentId: { in: created.shipmentIds } } });
  await tryDel('ShipmentCartonItem', prisma.shipmentCartonItem, { where: { carton: { shipmentId: { in: created.shipmentIds } } } } , { tolerate: true });
  await tryDel('ShipmentCarton', prisma.shipmentCarton, { where: { shipmentId: { in: created.shipmentIds } } });
  await tryDel('ShipmentEvent', prisma.shipmentEvent, { where: { shipmentId: { in: created.shipmentIds } } });
  await tryDel('Shipment', prisma.shipment, { where: { id: { in: created.shipmentIds } } });
  await tryDel('OrderShipmentBatch', prisma.orderShipmentBatch, { where: { OR: [{ id: { in: batchIds } }, ...(orderId ? [{ orderId }] : [])] } });

  // 订单/报价/客户
  await tryDel('BOMLine', prisma.bOMLine, { where: { bomId: { in: created.bomIds.length ? created.bomIds : ['__none__'] } } });
  await tryDel('BOM', prisma.bOM, { where: { OR: [{ id: { in: created.bomIds.length ? created.bomIds : ['__none__'] } }, { orderId: orderId ?? '__none__' }, { quotationId: created.quotationId ?? '__none__' }] } });
  await tryDel('OrderStatusTransition', prisma.orderStatusTransition, { where: { orderId: orderId ?? '__none__' } });
  await tryDel('OrderLine', prisma.orderLine, { where: { orderId: orderId ?? '__none__' } });
  await tryDel('Order', prisma.order, { where: { OR: [{ id: orderId ?? '__none__' }, { poNumber: PO_NO }, ...(created.orderPoNumber ? [{ poNumber: created.orderPoNumber }] : [])] } });
  await tryDel('QuotationVersion', prisma.quotationVersion, { where: { quotationId: created.quotationId ?? '__none__' } });
  await tryDel('QuotationLine', prisma.quotationLine, { where: { quotationId: created.quotationId ?? '__none__' } });
  await tryDel('Quotation', prisma.quotation, { where: { OR: [{ id: created.quotationId ?? '__none__' }, { customerRelationId: REL_ID }] } });
  await tryDel('Relation', prisma.relation, { where: { id: REL_ID } });

  // 联动副作用（删实体不自动清 —— 本仓已知：EntityReference 无级联）
  const ids = allIds();
  const refWhere = { OR: [{ ownerId: { contains: MARK } }, { targetId: { contains: MARK } }, { ownerId: { in: ids } }, { targetId: { in: ids } }] };
  await tryDel('EntityReference', prisma.entityReference, { where: refWhere });
  const linkWhere = { OR: [{ fromId: { contains: MARK } }, { toId: { contains: MARK } }, { fromId: { in: ids } }, { toId: { in: ids } }] };
  await tryDel('EntityLink', prisma.entityLink, { where: linkWhere });
  await tryDel('ApprovalRequest', prisma.approvalRequest, { where: { OR: [{ targetId: { in: ids } }, { targetId: { contains: MARK } }] } });

  // ★ 审计留痕：核销类审计的 targetId 是**复合键**（`ALLOC__<invoiceId>__<voucherId>` /
  //   `CNA__<creditNoteId>__<invoiceId>`），既不在实体 id 列表里、也不含 MARK
  //   ⇒ 只按 id/MARK 清会**静默漏掉 3 条/次**（行数对撞守卫实测抓到）。
  //   BOM 自动草稿（L6）同理：targetId 形如 `BOM_<ts>_<rand>`。
  //   ⚠️ 登录审计（action='login'）的 **targetId 为 null** ⇒ 按 targetId 过滤永远匹配不到，
  //      必须**按 id 删**（否则每次跑都留 1 行，行数对撞守卫实测抓到）。
  const auditOr = [{ targetId: { in: ids } }, { targetId: { contains: MARK } }, { id: { in: created.auditIds.length ? created.auditIds : ['__none__'] } }];
  for (const inv of created.invoiceIds) auditOr.push({ targetId: { contains: inv } });
  if (created.voucherId) auditOr.push({ targetId: { contains: created.voucherId } });
  for (const cn of created.creditNoteIds) auditOr.push({ targetId: { contains: cn } });
  await tryDel('AuditLog', prisma.auditLog, { where: { OR: auditOr } });
}

// ★ 原 `verifyNoResidue()`（手写模型清单）已**删除** —— 它只覆盖 12 个模型，
//   实测漏掉 `creditNote`/`productionStage`/`notification`/`agentJob` 等
//   ⇒ 会给出「零残留」的**假结论**（本仓 2026-09-19 实锤：漏 4261 行）。
//   现由 `lib/drill-residue.mjs` 的 `sweepResidue()`（**全模型**，覆盖面取自 Prisma DMMF）
//   承担复核，见 `finally` 块。**别再把手写清单加回来**。

// ══════════════════════════════════════════════════════════════════════
const urlPortOf = (u) => { try { return new URL(u).port || '80'; } catch { return 'unknown'; } };
let ATTR = null;
/** ★ v3.35（复核 ①）：同库证明**到手没有**是一个状态，不是一句断言。
 *  上一版的洞：回读整块嵌在"建单返回 200"的分支里 ⇒ 建单一旦非 200（服务端 upsert 已提交、随后回调抛错
 *  就会成 500 ⇒ 行在别人的库里），证人整块不可达，而 finally 仍无条件扫残留并打 `✓ 零残留复核`。
 *  ⇒ 现在收尾那句"零残留"**必须以拿到过证明为前提**，没拿到就报"不可采信"，不报干净。 */
let WORLD_PROVEN = false;
async function main() {
  ATTR = gateAttribution();          // ← 硬前置：不可署名就不往下走（连库之前）
  await connectPrisma();
  // ★ v3.50（B167）：跑前先取一份**与标识无关**的行数基线 ⇒ 收尾能抓到"标识看不见"的副作用
  const RUN_START = new Date();   // ★ v3.54：按行归因要用"本次进程的时间窗"，不是上一程的残留
  const ROWBASE = await countAllModels({ prisma, Prisma: PrismaRef });   // 时点①
            // ★ 复核 #14 I-4：原先叫 BASE，把模块级 HTTP 的 BASE 遮了 ⇒ 两个世界失败详情打出 [object Object]
  // ★ v3.64（B170）时点①′：**跑前主键快照**（顺序判据：必须排在任何写入之前）。
  //   为什么需要它：没有可用 `createdAt` 的那一族（现量 33 张 —— A1 补列后由 35 降 2，含链按自己拿到的 id 删过的
  //   `OrderLine` / `Relation`）按时间窗**根本数不出来** ⇒ 它们在判决里只剩"没被问过"这一格。
  const PK_PRE = await snapshotIdSets({ prisma, Prisma: PrismaRef });
  const admin = await login('jason.shen@bambook.local');
  if (!admin) { console.error('管理员登录失败'); process.exit(1); }
  // 登录本身会写一条审计（action='login'，无 targetType）—— 精确记下它的 id 以便回滚
  const loginAudit = await prisma.auditLog.findFirst({ where: { action: 'login' }, orderBy: { createdAt: 'desc' } });
  // ⚠️ v3.34 更正（复核 ②）：这条曾被我把"两个世界的证人"的帽子扣上去，**扣错了** —— 它只问
  //   "库里有没有一条 action='login' 的审计"，而实测本库这类审计有 **726 条**（最新一条是几天前的）
  //   ⇒ 两库各自有登录史时它照样满足 = **惰性证人**（正是 B159 我刚写进台账的那条罪：把"有历史"读成"我这次写的"）。
  //   现在它只负责"记下这条 id 以便回滚"，不再声称任何证明作用；真正的回读在 S1 之后（按自造 id 数）。
  if (loginAudit) created.auditIds.push(loginAudit.id);
  console.log(`══ 整链端到端业务模拟演练 ══`);
  console.log(`   标识 MARK=${MARK}  PO=${PO_NO}`);
  console.log(`   库：${(process.env.DATABASE_URL || 'panda_hub_local').includes('local') ? '本地 dev' : '⚠️ 非本地'}`);

  try {
    // ══ S1 客户档案 ══════════════════════════════════════════════════
    step('S1 客户档案（关系）');
    const rel = await api(admin, 'POST', '/api/v1/relations', {
      id: REL_ID, name: `DRILL 整链演练客户 ${TS}`, category: 'Customer',
      currency: 'USD', creditLimit: 500000, paymentTerms: 'T/T 30 days',
      email: `drill${TS.toLowerCase()}@example.invalid`, phone: '000-0000',
    });
    if (rel.status === 200 && rel.data?.relation?.id) {
      created.relationId = rel.data.relation.id;
      // ★★ B160/② 真正的证人（v3.34）：**用我自己造的那个 id 回读**。
      //   REL_ID = `REL__DRILLCHAIN<时间戳>` 是本脚本现造的、全局唯一、不来自任何历史 ⇒
      //   "HTTP 那侧写的行，在我这侧的库里存在"只有这一种问法是不惰性的：不靠时间窗、不撞历史、不受并发登录影响。
      //   数不到 = 服务端连的库与我连的库不是同一个世界 ⇒ 本次"零残留"不成立，立刻停。
      const seen = await prisma.relation.findFirst({ where: { id: REL_ID }, select: { id: true } });
      if (!seen) {
        fail('两个世界断言失败：HTTP 建的那条关系（自造 id）在脚本侧库里读不到',
          `id=${REL_ID} 库=${ATTR?.db ?? '?'} @ ${BASE} ⇒ 服务端与本脚本不同库（或不同 checkout）⇒ 本次"零残留"不可采信`);
        await rollback();
        // ★ B165：这里原先**自己拼**了一句同形汇总 ⇒ 同一句话两处真源，且两处措辞已经不一样了。
        console.log(verdictLine({ results: rep.results, residueCount: rep.residueCount(), verdictKind: rep.verdictKind(), attr: ATTR, waived: ALLOW_UNATTRIBUTED }));
        process.exit(4);
      }
      pass('两个世界断言（按自造 id 回读）：HTTP 写的关系在脚本侧库里读得到', `relation=${seen.id}`);
      WORLD_PROVEN = true;   // ← 收尾那句"零残留"以此为前提（v3.35/复核①）
      pass('建客户档案', `${created.relationId}`);
    } else {
      fail('建客户档案', `HTTP ${rel.status} ${rel.text.slice(0, 200)}`);
      return;
    }

    // ══ S2 报价 ══════════════════════════════════════════════════════
    step('S2 报价（建 → 发 → 接受）');
    const QTY = 10000, PRICE = 1.2, AMT = QTY * PRICE; // 12000 USD
    const qt = await api(admin, 'POST', '/api/v1/quotations', {
      currency: 'USD', customerName: `DRILL 整链演练客户 ${TS}`, customerRelationId: REL_ID,
      issueDate: today, validUntil: plusDays(30),
      lines: [{ fabricCode: MARK, description: `DRILL 面料行 ${TS}`, quantity: QTY, unit: 'YD', unitPrice: PRICE }],
    });
    if (qt.status !== 201 || !qt.data?.quotation?.id) {
      fail('建报价单', `HTTP ${qt.status} ${qt.text.slice(0, 250)}`);
      return;
    }
    created.quotationId = qt.data.quotation.id;
    const qtTotal = num(qt.data.quotation.totalAmount);
    pass('建报价单', `${created.quotationId} 报价额=${qtTotal}（期望 ${AMT}）`);
    if (qtTotal !== AMT) fail('报价额与明细行一致', `报价 ${qtTotal} ≠ 行小计 ${AMT}`);

    const snd = await api(admin, 'POST', `/api/v1/quotations/${encodeURIComponent(created.quotationId)}/send`, {});
    if (snd.status === 200) pass('报价发出（Draft→Sent）', `status=${snd.data?.quotation?.status}`);
    else gap('报价发出被门禁拦下', `HTTP ${snd.status} ${snd.text.slice(0, 200)} —— MOQ/审批门禁属业务规则，需按业务口径确认`);

    const acc = await api(admin, 'POST', `/api/v1/quotations/${encodeURIComponent(created.quotationId)}/accept`, { note: 'DRILL 演练接受' });
    if (acc.status === 200 && acc.data?.quotation?.status === 'Accepted') pass('报价接受（Sent→Accepted）');
    else { fail('报价接受', `HTTP ${acc.status} ${acc.text.slice(0, 200)}`); return; }

    // ══ S3 转订单 ════════════════════════════════════════════════════
    // ★ 实测发现（本演练第一版踩到）：报价「接受」会发布 `QuotationAccepted`，
    //   **L9 联动异步自动转单**（`events/linkages/L9ConvertQuotationToOrder`，默认 enabled）。
    //   此时再手工 POST /convert-to-order 必然 409「已转为订单」——
    //   这不是缺陷，是**真实链路的正确行为**（幂等保护生效）。
    //   ⇒ 正确做法：接受后**等自动转单落定**，取 `convertedOrderId`；
    //     超时（联动关闭/失败）才回退到手工转单。
    step('S3 转订单（报价→订单→确认）');
    let orderId = null;
    let autoConverted = false;
    // ★ 轮询上限取 12s：L9 是**异步**联动，且本机 dev server 与全量测试**共用同一个 Postgres**
    //   （并发跑门禁时会明显变慢）。上限过紧会把「慢」误报成「联动没发生」——假缺口比漏报更伤信任。
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const q = await api(admin, 'GET', `/api/v1/quotations/${encodeURIComponent(created.quotationId)}`);
      const cid = q.data?.quotation?.convertedOrderId ?? q.data?.convertedOrderId;
      if (cid) { orderId = cid; autoConverted = true; break; }
    }
    if (autoConverted) {
      pass('★ L9 联动：报价接受后自动转单（无需手工点「转为订单」）', `orderId=${orderId}`);
    } else {
      // 诊断（在手工转单**之前**读）：区分「慢」（等不够）与「真没发生」（联动关闭/失败）
      // —— 否则无法判断这是假缺口还是真问题。
      const q = await api(admin, 'GET', `/api/v1/quotations/${encodeURIComponent(created.quotationId)}`);
      const st = q.data?.quotation?.status ?? q.data?.status;
      const conv = await api(admin, 'POST', `/api/v1/quotations/${encodeURIComponent(created.quotationId)}/convert-to-order`, {
        poNumber: PO_NO, type: 'Fabric', dueDate: plusDays(45),
      });
      if (conv.status !== 201 || !conv.data?.orderId) {
        fail('报价转订单（自动与手工均未成功）', `HTTP ${conv.status} ${conv.text.slice(0, 250)}`);
        return;
      }
      orderId = conv.data.orderId;
      gap('L9 自动转单未落定，回退手工转单成功',
        `orderId=${orderId} · 转单前报价状态=${st} · 已等 ${(24 * 0.5).toFixed(0)}s`
        + `（Accepted 且无 convertedOrderId ⇒ 疑似联动未跑或很慢；查 automationConfig 的 L9 开关）`);
    }
    created.orderId = orderId;

    const od = await api(admin, 'GET', `/api/v1/orders/${encodeURIComponent(created.orderId)}`);
    if (od.status === 200) {
      const o = od.data?.order ?? od.data;
      created.orderPoNumber = o?.poNumber ?? null;
      const orderAmt = orderAmountOf(o);
      if (orderAmt === AMT) pass('★ 跨环节数字：报价额 = 订单额', `${orderAmt} = ${AMT}`);
      else fail('★ 跨环节数字：报价额 = 订单额', `订单 ${orderAmt} ≠ 报价 ${AMT}`);
      if (o?.customerRelationId === REL_ID) pass('订单挂到演练客户（客户档案不丢）', `customerRelationId=${o.customerRelationId}`);
      else gap('订单未挂客户关系', `customerRelationId=${o?.customerRelationId ?? 'null'} —— 影响后续发票/索赔按客户归集`);
      console.log(`     ⓘ 订单状态=${o?.status} poNumber=${o?.poNumber} 来源=${o?.source}`);
    } else fail('回读订单', `HTTP ${od.status}`);

    const conf = await api(admin, 'POST', `/api/v1/orders/${encodeURIComponent(created.orderId)}/status-transition`, { toStatus: 'Confirmed', note: 'DRILL 演练确认' });
    if (conf.status === 200) pass('订单确认（→Confirmed）');
    else gap('订单确认未通过', `HTTP ${conf.status} ${conf.text.slice(0, 160)}`);

    // ★ 实测发现（第二版踩到）：订单**确认**会发布事件 → **L6 联动自动生成 BOM 草稿**
    //   （`events/linkages/L6CreateBOMDraft`，描述「订单 X 的 BOM（自动生成，待补充）」）。
    //   这是链路里第二个「自动发生的环节」，单点脚本与手工走查都容易漏掉它。
    //   ⇒ 演练必须**断言它确实发生**，并把它纳入回滚（否则真库留下孤儿 BOM）。
    let bomId = null;
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 400));
      const bom = await prisma.bOM.findFirst({ where: { orderId: created.orderId }, select: { id: true, bomNumber: true, status: true } });
      if (bom) { bomId = bom.id; break; }
    }
    if (bomId) {
      created.bomIds.push(bomId);
      const bom = await prisma.bOM.findUnique({ where: { id: bomId }, select: { bomNumber: true, status: true } });
      pass('★ L6 联动：订单确认后自动生成 BOM 草稿', `${bom?.bomNumber}（status=${bom?.status}）`);
    } else {
      gap('订单确认后未生成自动 BOM 草稿',
        `已等 ${(12 * 0.4).toFixed(1)}s · 订单状态=${conf.status === 200 ? 'Confirmed' : '未确认'}`
        + `（若确认成功仍无 BOM ⇒ 查 automationConfig 的 L6 开关；若订单未确认 ⇒ 是本步更早的问题）`);
    }

    // ══ S4 分批出运 ══════════════════════════════════════════════════
    // ★ 实测发现（第一版踩到）：批次 `mark-shipped` 会 fail-closed 拦「批次尚未关联出运单」
    //   （`SHIPMENT_REQUIRED`）⇒ 真实顺序是**先建运单、再把批次挂到运单上**，
    //   而不是「先建计划批次再补运单」。这条顺序是链路的隐含依赖，单点脚本看不出来。
    step('S4 分批出运（一单两批 + 两张运单 —— 分批是服装外贸常态）');
    const B1 = 7000, B2 = 5000; // 计划额合计 12000 = 订单额
    const mkShipment = (label) => api(admin, 'POST', '/api/v1/shipping', {
      type: 'Export', shippingMethod: 'Sea', status: 'Booked',
      orderId: created.orderId, customerRelationId: REL_ID, customerName: `DRILL 整链演练客户 ${TS}`,
      portOfLoading: 'Shanghai', portOfDischarge: 'Los Angeles',
      bookingDate: today, etd: plusDays(3), eta: plusDays(20),
      containerNumber: `${MARK}-CNTU`, notes: `${MARK} ${label}`,
    });
    const sh1 = await mkShipment('运单一');
    const sh2 = await mkShipment('运单二');
    if (sh1.status !== 201 || sh2.status !== 201) {
      fail('建两张出运单', `HTTP ${sh1.status}/${sh2.status} ${sh1.text.slice(0, 200)}`);
      return;
    }
    created.shipmentIds = [sh1.data.id, sh2.data.id];
    pass('建两张出运单', `${sh1.data.shipmentNumber} / ${sh2.data.shipmentNumber}（挂订单 ${created.orderId}）`);

    const mkBatch = (amount, label, shipmentId, isFinalBatch) => api(admin, 'POST', '/api/v1/shipping/order-batches', {
      orderId: created.orderId, shipmentId, amount, currency: 'USD', plannedRatio: null,
      isFinalBatch, notes: `${MARK} ${label}`,
    });
    const b1 = await mkBatch(B1, 'B1', created.shipmentIds[0], false);
    const b2 = await mkBatch(B2, 'B2', created.shipmentIds[1], true); // B2 = 末批（门禁只认这一批）
    if (b1.status !== 201 || b2.status !== 201) {
      fail('登记两个出运批次', `HTTP ${b1.status}/${b2.status} ${b1.text.slice(0, 200)}`);
      return;
    }
    created.batchIds = [b1.data.batch.id, b2.data.batch.id];
    pass('登记两个出运批次（各自挂运单，B2 标末批）', `B1=${B1} / B2=${B2}（合计 ${B1 + B2} = 订单额 ${AMT}）`);
    if (B1 + B2 !== AMT) fail('★ 跨环节数字：批次计划额之和 = 订单额', `${B1 + B2} ≠ ${AMT}`);

    const markShipped = (batchId) => api(admin, 'POST', `/api/v1/shipping/order-batches/${encodeURIComponent(batchId)}/mark-shipped`, {});
    const ship1 = await markShipped(created.batchIds[0]);
    if (ship1.status === 200) pass('发运 B1（非末批，无收款门禁）');
    else fail('发运 B1', `HTTP ${ship1.status} ${ship1.text.slice(0, 200)}`);

    // ★ 阴性对照（防空过的验证器）：未收款时发运末批，门禁**必须**拦下来。
    //   若这条不红，后面「收款后放行」的通过就无法证明是门禁在起作用。
    const ship2Early = await markShipped(created.batchIds[1]);
    if (ship2Early.status === 409 && String(ship2Early.text).includes('FINAL_PAYMENT_GATE_BLOCKED')) {
      pass('★ 阳性对照：未收款时发运末批被门禁拦下（409）', '末批发运前须先收足「订单额 − 末批额」');
    } else {
      fail('★ 阳性对照：末批发运门禁未生效', `HTTP ${ship2Early.status} ${ship2Early.text.slice(0, 200)}`);
    }

    // ══ S5 报关 ══════════════════════════════════════════════════════
    step('S5 报关');
    const decl = await api(admin, 'POST', '/api/v1/customs/declarations', {
      declarationNumber: CD_NO, type: 'Export', orderId: created.orderId, relationId: REL_ID,
      shipmentId: created.shipmentIds[0],
      declarationDate: today, tradeTerms: 'FOB', totalValue: B1, currency: 'USD',
      customsCode: '0000', declarationPort: 'DRILL 港', destinationCountry: 'US',
      consignee: `DRILL 整链演练客户 ${TS}`, consignor: 'Jiangsu Panda',
      notes: MARK,
      lines: [{ productName: `DRILL 面料 ${TS}`, hsCode: HS_CODE, quantity: B1, unit: 'YD', unitPrice: PRICE, totalPrice: B1, currency: 'USD' }],
    });
    if (decl.status === 201 && decl.data?.item?.id) {
      created.declarationId = decl.data.item.id;
      pass('建报关单', `${CD_NO}（挂订单 ${created.orderId}）`);
      if (num(decl.data.item.totalValue) === B1) pass('★ 跨环节数字：报关金额 = B1 批次计划额', `${B1}`);
      else fail('★ 跨环节数字：报关金额 = B1 批次计划额', `报关 ${decl.data.item.totalValue} ≠ ${B1}`);
    } else {
      gap('建报关单未通过', `HTTP ${decl.status} ${decl.text.slice(0, 220)}`);
    }

    // ══ S6 分批开票 ══════════════════════════════════════════════════
    step('S6 分批开票（批次锚定）');
    const mkInv = async (no, amount, batchId, label) => api(admin, 'POST', '/api/v1/finance', {
      type: 'Receivable', status: 'Draft', amount, currency: 'USD', issueDate: today,
      invoiceNumber: no, customerRelationId: REL_ID, customerName: `DRILL 整链演练客户 ${TS}`,
      orderAllocations: [{ orderId: created.orderId, batchId, allocatedAmount: amount, note: `${MARK} ${label}` }],
    });
    const inv1 = await mkInv(INV_NO_1, B1, created.batchIds[0], 'B1');
    const inv2 = await mkInv(INV_NO_2, B2, created.batchIds[1], 'B2');
    if (inv1.status !== 201 || inv2.status !== 201) {
      fail('分批开票', `HTTP ${inv1.status}/${inv2.status} ${inv1.text.slice(0, 220)}`);
      return;
    }
    created.invoiceIds = [inv1.data.id, inv2.data.id];
    pass('B1 批次开票', `${INV_NO_1} 金额=${B1}`);
    pass('B2 批次开票', `${INV_NO_2} 金额=${B2}`);

    // 批次结算快照（fire-and-forget 重算 ⇒ 轮询落定）
    const batchSnapshot = async () => {
      const r = await api(admin, 'GET', `/api/v1/shipping/order-batches?orderId=${encodeURIComponent(created.orderId)}`);
      const rows = r.data?.batches ?? r.data?.items ?? [];
      return {
        b1: num(rows.find((x) => x.id === created.batchIds[0])?.invoicedAmount),
        b2: num(rows.find((x) => x.id === created.batchIds[1])?.invoicedAmount),
      };
    };
    let snap = null;
    // ★ 同上：批次结算是 fire-and-forget 重算，负载高时落定更慢；上限取 10s 避免假缺口
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      snap = await batchSnapshot();
      if (snap.b1 === B1 && snap.b2 === B2) break;
    }
    const expB1 = POISON_INVOICED ? B1 + 1 : B1;
    if (snap?.b1 === expB1 && snap?.b2 === B2) pass('★ 跨页数字：批次已开票额 = 各自发票额（互不串）', `B1=${snap.b1} B2=${snap.b2}`);
    else fail('★ 跨页数字：批次已开票额', `B1=${snap?.b1}（期望 ${expB1}）B2=${snap?.b2}（期望 ${B2}）${POISON_INVOICED ? ' ★ 阳性对照（期望被人为 +1）' : ''}`);

    // ★ 实测发现：Draft 票**不允许核销**（`INVALID_INVOICE_STATUS`）⇒ 开票后必须走状态流转。
    const issue = async (id, no) => api(admin, 'PATCH', `/api/v1/finance/${encodeURIComponent(id)}`, { status: 'Issued' });
    const iss1 = await issue(created.invoiceIds[0], INV_NO_1);
    const iss2 = await issue(created.invoiceIds[1], INV_NO_2);
    if (iss1.status === 200 && iss2.status === 200) pass('两张票 Draft→Issued（核销前置状态）');
    else fail('发票置为 Issued', `HTTP ${iss1.status}/${iss2.status} ${iss1.text.slice(0, 200)}`);

    // ══ S7 收汇核销 ══════════════════════════════════════════════════
    step('S7 收汇核销（客户少付 500 —— 部分收款变异）');
    const RECV = B1 + B2 - 500; // 11500，制造 500 尾差
    const pv = await api(admin, 'POST', '/api/v1/finance/vouchers', {
      type: 'Receipt', voucherNumber: PV_NO, amount: RECV, currency: 'USD', paymentDate: today,
      paymentMethod: 'T/T', customerRelationId: REL_ID, customerName: `DRILL 整链演练客户 ${TS}`,
      notes: `${MARK} 演练收款（少付 500）`,
    });
    if (pv.status !== 201 || !pv.data?.id) {
      fail('建收款凭证', `HTTP ${pv.status} ${pv.text.slice(0, 220)}`);
    } else {
      created.voucherId = pv.data.id;
      pass('建收款凭证', `${PV_NO} 金额=${RECV}`);
      const alloc = await api(admin, 'POST', '/api/v1/finance/allocations', {
        invoiceId: created.invoiceIds[0], voucherId: created.voucherId, appliedAmount: B1, appliedDate: today,
      });
      if (alloc.status === 201) pass('核销 B1 发票', `${B1}（B1 应全额结清）`);
      else fail('核销 B1 发票', `HTTP ${alloc.status} ${alloc.text.slice(0, 220)}`);

      const alloc2 = await api(admin, 'POST', '/api/v1/finance/allocations', {
        invoiceId: created.invoiceIds[1], voucherId: created.voucherId, appliedAmount: B2 - 500, appliedDate: today,
      });
      if (alloc2.status === 201) pass('核销 B2 发票（部分收款）', `${B2 - 500}（B2 应停在部分收款）`);
      else fail('核销 B2 发票', `HTTP ${alloc2.status} ${alloc2.text.slice(0, 220)}`);

      // 跨页对账：发票状态 vs Σ核销
      const i1 = await api(admin, 'GET', `/api/v1/finance/${encodeURIComponent(created.invoiceIds[0])}`);
      const i2 = await api(admin, 'GET', `/api/v1/finance/${encodeURIComponent(created.invoiceIds[1])}`);
      const s1 = i1.data?.status, s2 = i2.data?.status;
      if (s1 === 'Paid') pass('★ 跨页数字：B1 票状态 = Paid（收齐）', `status=${s1}`);
      else fail('★ 跨页数字：B1 票状态', `status=${s1}（期望 Paid）`);
      if (s2 === 'PartiallyPaid') pass('★ 跨页数字：B2 票状态 = PartiallyPaid（少付 500）', `status=${s2}`);
      else fail('★ 跨页数字：B2 票状态', `status=${s2}（期望 PartiallyPaid）`);

      // ★ 跨环节因果：收款落账后，末批发运门禁应当放行（前批款已收足 11500 ≥ 7000）
      const ship2 = await markShipped(created.batchIds[1]);
      if (ship2.status === 200) pass('★ 跨环节因果：收款后末批发运放行（收款解锁出运）', `已收 ${RECV} ≥ 订单额 ${AMT} − 末批 ${B2}`);
      else fail('★ 跨环节因果：收款后末批发运仍被拦', `HTTP ${ship2.status} ${ship2.text.slice(0, 220)}`);
    }

    // ══ S8 索赔折让 ══════════════════════════════════════════════════
    step('S8 索赔折让（客户投诉 → 折让 → 贷项票）');
    const ALLOW = 300;
    // ★ 路由前缀实测：claimRouter 挂在 `/api/v1` 上，其内部路径已含 `claims`
    //   ⇒ 正确入口是 `POST /api/v1/claims`（不是 `/api/v1/claims/claims`）。
    const claim = await api(admin, 'POST', '/api/v1/claims', {
      customerRelationId: REL_ID, customerName: `DRILL 整链演练客户 ${TS}`,
      sourceOrderId: created.orderId, sourceInvoiceId: created.invoiceIds[1],
      category: 'Quality', problemDesc: `${MARK} 演练客诉：面料色差，客户要求折让 ${ALLOW} USD`,
    });
    if (claim.status !== 201 || !claim.data?.claimCase?.id) {
      gap('登记售后案件未通过', `HTTP ${claim.status} ${claim.text.slice(0, 220)}`);
    } else {
      created.claimCaseId = claim.data.claimCase.id;
      pass('登记售后案件', `${claim.data.claimCase.caseNumber ?? created.claimCaseId}`);

      const disp = await api(admin, 'POST', `/api/v1/claims/${encodeURIComponent(created.claimCaseId)}/dispositions`, {
        kind: 'Allowance', amount: ALLOW, currency: 'USD', notes: `${MARK} 折让处置`,
      });
      if (disp.status !== 201 || !disp.data?.disposition?.id) {
        gap('加折让处置未通过', `HTTP ${disp.status} ${disp.text.slice(0, 220)}`);
      } else {
        const dispId = disp.data.disposition.id;
        created.dispositionIds.push(dispId);
        pass('加折让处置（Allowance）', `金额=${ALLOW} USD（自动建审批单）`);

        const appr = await api(admin, 'POST', `/api/v1/claims/dispositions/${encodeURIComponent(dispId)}/approve`, {});
        if (appr.status === 200) pass('处置审批通过');
        else gap('处置审批未通过', `HTTP ${appr.status} ${appr.text.slice(0, 200)}`);

        const exec = await api(admin, 'POST', `/api/v1/claims/dispositions/${encodeURIComponent(dispId)}/execute`, { notes: `${MARK} 执行折让` });
        if (exec.status === 200) {
          const cnId = exec.data?.creditNote?.id ?? exec.data?.data?.creditNote?.id;
          if (cnId) created.creditNoteIds.push(cnId);
          pass('执行折让处置', cnId ? `生成贷项票 ${cnId}` : '已执行（响应未带贷项票 id）');

          if (cnId) {
            const apply = await api(admin, 'POST', `/api/v1/credit-notes/${encodeURIComponent(cnId)}/apply`, {
              appliedAmount: ALLOW, toInvoiceId: created.invoiceIds[1],
            });
            if (apply.status === 200 || apply.status === 201) pass('贷项票抵扣到 B2 发票', `抵扣 ${ALLOW}`);
            else gap('贷项票抵扣未通过', `HTTP ${apply.status} ${apply.text.slice(0, 200)}`);

            // ★ 跨页数字：折让后 B2 剩余应收 = 500 − 300 = 200
            //   ⚠️ 实测：**净额只在列表端点派生**（DR-044：appliedAmount/openAmount 由
            //   `attachAllocationDerivedFields` 按 `sumAppliedAmountByInvoice` = 收款核销 + 贷项抵扣 计算），
            //   发票**详情端点不返回净额**（只有原始行 + orderAllocations）。
            //   ⇒ 对账必须走列表口径；详情页若自行计算就会与列表漂移（这正是「跨页数字一致」要盯的点）。
            const list = await api(admin, 'GET', `/api/v1/finance?customerRelationId=${encodeURIComponent(REL_ID)}`);
            const row = (list.data?.items ?? []).find((x) => x.invoiceNumber === INV_NO_2);
            const openAfter = num(row?.openAmount);
            const appliedAfter = num(row?.appliedAmount);
            if (openAfter === 200 && appliedAfter === 4800) {
              pass('★ 跨页数字：折让后 B2 净额（列表口径）= 已核销 4800 / 剩余 200', `applied=${appliedAfter} open=${openAfter}`);
            } else if (row === undefined) {
              gap('列表未取到 B2 行', `items=${(list.data?.items ?? []).length} —— 需确认按 customerRelationId 过滤是否生效`);
            } else {
              fail('★ 跨页数字：折让后 B2 净额', `applied=${appliedAfter}（期望 4800）open=${openAfter}（期望 200）`);
            }
          }
        } else {
          gap('执行折让处置未通过', `HTTP ${exec.status} ${exec.text.slice(0, 220)}`);
        }
      }
    }
  } catch (e) {
    fail('演练脚本异常', String(e?.stack ?? e).slice(0, 500));
  } finally {
    // ★ v3.61（B169 定位到的真因）：**归因快照必须取在任何删除之前**。
    //   这一程第一个删除点就是下面的 `rollback()`（手写清单在那里面删），而原先 WIN_W 取在 rollback **之后**
    //   ⇒ "本次窗口内造了几行"恒等于 0，而删除侧照报 1/16/16/31… ⇒ 对每张手写清单删过的表都算出
    //   `deleted > ownDeleted=0` ⇒ 第四程那 24 条"删了本次没造过的行"是我自己造的**假指控**。
    //   （时区说与 BigInt 单位说都被这个读数否掉了。）
    const POSTW = await countAllModels({ prisma, Prisma: PrismaRef });
    const WIN_W = await countCreatedInWindow({ prisma, Prisma: PrismaRef, since: RUN_START });
    await rollback();
    // ★ 全模型**沉淀式**兜底清扫：手写清单必然漏（事件总线扇出 notification/agentJob、
    //   建单初始化 productionStage、L6 自动建 BOM），且**总线由服务端异步投递**
    //   ⇒ 清一次还会剩 ⇒ 等沉淀、多轮清。
    //   ⚠️ 诚实边界：投递窗口不可控（数秒~一分钟）⇒ **脚本退出不保证零残留**；
    //      权威兜底是 `clean-drill-residue.mjs --apply` + `db-rowcount.mjs --compare`。
    //   ★ 注意 markers 里除了业务标识，还要带上**演练生成的实际 id**（订单 id 由 L9 自动生成、
    //     不含业务标识 ⇒ 只按标识扫会漏掉 `productionStage.orderId` 这类**间接引用**）。
    // ★ v3.43（复核 #11 B-3）：自造标识只认 MARK —— 它必然在 sweepMarkers 里（同源），
    //   而 PO_NO 不在（`allIds()` 只列 created.*Id，不含 poNumber）。上一批把它写进 markersExpected
    //   ⇒ 六个前提里的第 6 条**永不满足**，链的 clean 支路恒死、只能报 unproven（fail-closed，不是假绿，
    //   但"六个前提被真跑路径走到过"这句就是假的）。
    //   ⚠️ 修法取"收窄期望"而不是"放宽扫描"：把 PO_NO 塞进 sweepMarkers 会同时扩大
    //   `settleAndClean` 的删除面 ⇒ 那是 §12.1 第 26/27 条的地界，不许自主动。
    const RUN_MARK = MARK;
    const sweepMarkers = [MARK, ...allIds()].filter(Boolean);
    // ★ 洞③：时点②（POSTW 与 WIN_W）必须在**任何删除之前**取，否则"删多了"只会表现为变少、而变少按设计不算脏。
    //   v3.61：这两个快照原先只在 settleAndClean 之前、却在 rollback() 之后 ⇒ 等于取在"已经删完"之后，
    //   守恒式因此对每张手写清单删过的表都报"删了没造过的行"。现已上移到 rollback() 之前（判据钉住顺序）。
    // ★ v3.72（B184）：兜底清扫那一路现在也报"删了哪几行"（同谓词预读；不等长就交 broken）
    const SWEEP_ROWS = {};
    const cleaned = await settleAndClean({ prisma, Prisma: PrismaRef, markers: sweepMarkers, log: console.log, deletedRowsOut: SWEEP_ROWS });
    if (cleaned.deleted > 0) console.log(`     · 全模型兜底清扫补删 ${cleaned.deleted} 行（手写清单漏掉的）：${JSON.stringify(cleaned.byModel)}`);
    // ★ v3.41（B165 第二刀）：结论的**输入侧**也要自证 —— 三样都得带进判决：
    //   ① 不可读表清单（原先不传 unreadableOut ⇒ 逐表抛错被译成"这张表干净"）；
    //   ② 数过几张表 vs 可扫几张表（"一行都没数"不能等于"干净"）；
    //   ③ 普查**实际用了哪些标识**，与本次自造的标识对撞（复核：markers 换成永不自匹配的串 ⇒ hits=[] ⇒ ✓ 零残留 且退 0）。
    const unreadable = [];
    let POSTCLEAN = { counts: {}, unreadable: ['POSTCLEAN 未取到'] };
    const scanStat = { scannable: 0, scanned: 0 };
    const hits = await sweepResidue({ prisma, Prisma: PrismaRef, markers: sweepMarkers, unreadableOut: unreadable, scanStatOut: scanStat });
    // ★ v3.36：判决抽成纯函数 residueVerdict —— 上一版这里是一段内联 if，复核 #7 实测
    //   "把 if (!WORLD_PROVEN) 整块删掉，没有任何被提交的判据会红" ⇒ 本批标题那条当时是零判据。
    // ★ v3.37（复核 #8 I-1）：**连打印一起搬进 lib**，调用点只剩下面这一个表达式。
    //   上一批只搬了判决、留着调用点的 if/else ⇒ 复核实测"保留调用、把返回值丢掉、
    //   自己再内联一段 if"四条 pin 全绿，等于退回 v3.35 被否掉的形状。
    //   现在"打印那句结论"就发生在那一次调用内部 ⇒ 想丢掉结论就得丢掉调用，
    //   而丢掉调用会被下面两条 pin（都在去注释后的源码上匹配）当场抓到。
    POSTCLEAN = await countAllModels({ prisma, Prisma: PrismaRef });
    const WIN_C = await countCreatedInWindow({ prisma, Prisma: PrismaRef, since: RUN_START });
    // ★ v3.64（B170）：**跑后主键快照 + 差分**。必须排在删除（rollback / settleAndClean）之后 ⇒
    //   `created`（post∖pre）才是"本次新增且清理后仍活着"；`vanished`（pre∖post）只登记不指控。
    const PK_POST = await snapshotIdSets({ prisma, Prisma: PrismaRef });
    const PK = pkDiff({ pre: PK_PRE.sets, post: PK_POST.sets });
    // ★ v3.70（B178）逐主键守恒：把"我删了哪些行"与"跑前哪些行就在"直接对撞。
    //   预读没接上/不等长的表整张给 null ⇒ 进"判不了"，不许算成放行；兜底清扫那几张（本轮没有预读）同理。
    const DEL_ROW_INPUT = {};
    let DEL_UNRECONCILED = [];   // ★ v3.74：报得上数却没台账、或有台账却没数 ⇒ 一张都不许悄悄过去
    {
      // 两条删除通道（手写清单 tryDel + 兜底清扫 cleanResidue）合并后才是一张表的真实删除面：
      //   任一侧 broken / 缺预读，或两侧行数之和 ≠ 合并自报行数 ⇒ 整张表 null（判不了），
      //   绝不允许"看见多少算多少"（那是把预读漏报读成放行）。
      // ★ v3.74（复核 #17 B-2）：**两边都要归一命名再对账**。
      //   `mergeDeleted` 经 `byCanon` 把委托键归成 Pascal（`entityLink → EntityLink`），而 ① 级联那处
      //   写台账用的是**委托键**（camel）⇒ 原样直接按键取数会得到"有 3 行、报 0 行"的假相等或假不等，
      //   实测两头都是 0（真·跑前行被静默放行）。⇒ 行数桶、计数桶、broken 集合全部先 canonModel。
      const mergedCounts = mergeDeleted(OWN_DELETES, cleaned.byModel);
      const rowsByCanon = {};
      const markBroken = (name) => {
        const k = canonModel(name);
        const b = (rowsByCanon[k] = rowsByCanon[k] || { rows: [], broken: false });
        if (name !== k) b.broken = b.broken;   // 归一本身不算破
        return b;
      };
      for (const [m, v] of Object.entries(OWN_DELETED_ROWS)) {
        const b = markBroken(m);
        if (Array.isArray(v)) b.rows.push(...v); else b.broken = true;
      }
      for (const [m, v] of Object.entries(SWEEP_ROWS)) {
        const b = markBroken(m);
        if (v && v.broken) b.broken = true;
        else if (v && Array.isArray(v.rows)) b.rows.push(...v.rows);
        else b.broken = true;
      }
      for (const m of DEL_READ_BAD) markBroken(m).broken = true;
      // 行数与自报数**必须同时有**：只有行没有数（或反之）⇒ 判不了，且要能被数出来（不许静默变 0）
      const unrec = new Set();
      for (const [k, cnt] of Object.entries(mergedCounts)) {
        const b = rowsByCanon[canonModel(k)];
        if (!b) unrec.add(canonModel(k));
        else if (b.broken) unrec.add(canonModel(k));
      }
      for (const k of Object.keys(rowsByCanon)) if (!(Number(mergedCounts[k]) > 0)) unrec.add(k);
      for (const m of new Set([...Object.keys(mergedCounts).map(canonModel), ...Object.keys(rowsByCanon)])) {
        const b = rowsByCanon[m];
        const reported = Number(mergedCounts[m]) || 0;
        DEL_ROW_INPUT[m] = (b && !b.broken && b.rows.length === reported && reported > 0) ? b.rows : null;
      }
      DEL_UNRECONCILED = [...unrec].sort();
    }
    const DEL_ATTR = deletedRowAttribution({ deleted: DEL_ROW_INPUT, preIds: PK_PRE.sets, runStart: RUN_START,
      // ★ v3.71（B183）：把删除侧自报的行数交给它 ⇒ "整表没预读到"那种判不了能折算成**行**，不再按张冒充
      reportedCounts: mergeDeleted(OWN_DELETES, cleaned.byModel) });
    console.log(`     逐主键守恒：删的跑前行 ${DEL_ATTR.preexisting.length}（${DEL_ATTR.preexistingBrief.join(', ') || '无'}）`
      + ` · 非跑前行 ${DEL_ATTR.nonPre.length} · 判不了 ${DEL_ATTR.unknown.length} 条 = ${DEL_ATTR.unknownRows} 行（整表未读 ${DEL_ATTR.unknownWholeTables} 张${DEL_ATTR.unknownRowsSilent ? `，其中 ${DEL_ATTR.unknownRowsSilent} 张没报行数` : ''}）：${DEL_ATTR.unknownBrief.join(', ') || '无'}`
      + ` · 预读未接/不等长的表 ${DEL_READ_BAD.size} 张${DEL_READ_BAD.size ? '[' + [...DEL_READ_BAD].join(',') + ']' : ''}`
      + ` · 两通道对不上账的表 ${DEL_UNRECONCILED.length} 张${DEL_UNRECONCILED.length ? '[' + DEL_UNRECONCILED.join(',') + ']' : ''}`);
    // ★ v3.77（B187）指控轴正对照：**本程、本 client、同一个 RUN_START** 上一次真库往返。
    //   为什么必须在链里跑，而不是"有一条独立脚本跑绿过"：`删的跑前行=0` 有两种成因
    //   （真没多删 / 整根轴前移 ⇒ 永远哑），而独立脚本跑在**另一个时刻**，它绿不绿都不给这一程的 0 作证。
    //   这些落点（v3.79 起 7 个臂）住在同一个**回滚事务**里 ⇒ 这一程零持久写入（第一版按 id deleteMany 收尾，被 B120 那把尺
    //   当场抓住"新增手写删除面"⇒ 正解是不需要删，见 lib 里那段注释）。
    //   判据共用仓内那一份 `deletedRowAttribution` ⇒ 这里不是第二套真源。
    //   ★ v3.79 更正（复核 #20 MINOR-7）：这里原先写"位移 60s 与 120s 整档仍报通过 ⇒ 分辨率实测为≤120s 检不出"——
    //   那是 6 行时代只量过两个点、又把单侧结论写成双侧。两侧边界现在由 `axisResolutionGrid` 逐秒扫，
    //   随读数一起打（覆盖行那一格与判决明细都用同一份实现），注释里不复述数字。
    const AXIS = await runAccusationAxisControl({ prisma, db: readDbTarget(), runStart: RUN_START, log: (s) => console.log(s) });
    const grew = rowDelta(ROWBASE.counts, POSTCLEAN.counts);
    const below = rowDelta(POSTCLEAN.counts, ROWBASE.counts);
    emitResidueVerdict({ proven: WORLD_PROVEN, hits, unreadable, scanned: scanStat.scanned, scannable: scanStat.scannable, markersUsed: sweepMarkers, markersExpected: [RUN_MARK], unmarkedGrowth: grew,
      deletedBelowBaseline: below,
      countBlind: [...new Set([...ROWBASE.unreadable, ...POSTW.unreadable, ...POSTCLEAN.unreadable])],
      // ★ v3.64（B170）主键集合那一层的三条读数。"两侧分母不等 / 主键形状不合 / 快照读不到"
      //   全部并进 `pkSkipped` 现形 ⇒ 任何一条都不许被读成"这次没有新增"。
      pkResidue: PK.created,
      pkVanished: PK.vanished,
      // ★ 复核 #16（B176）：未覆盖的每一张都要**点名**，并且按名去重（一张表可能一侧形状不合、另一侧读不到）
      ...(() => {
        const unc = new Map();
        const put = (model, why) => { if (model && !unc.has(model)) unc.set(model, why); };
        for (const s of PK.skipped) put(s.model, s.why);
        for (const s of [...PK_PRE.badShape, ...PK_POST.badShape]) put(s.model, `主键形状不合（${s.why}）⇒ 不适用集合差分`);
        for (const s of [...PK_PRE.unreadable, ...PK_POST.unreadable]) put(s, '主键快照读不到');
        return {
          pkSkipped: [...unc].map(([model, why]) => ({ model, why })),
          // 枚举漂移不是"某一张表"，所以不混进点名清单，单列成一个**槽位数**参与对账。
          pkDrift: Math.abs(PK_PRE.enumerated - PK_POST.enumerated),
        };
      })(),
      // ★ v3.65（B174）：这一层**自己的**分母要与三条读数同屏，并且参与判决。
      //   `pkEnumerated`＝DMMF 枚举到几张"无可用 createdAt"（两侧取小 ⇒ 任一侧枚举失效当场不成立）；
      //   `pkCompared`＝其中两侧都拿到快照、真逐行比过的张数。缺任一 ⇒ 三条 0 读数是"没比过"的 0。
      pkEnumerated: Math.min(PK_PRE.enumerated, PK_POST.enumerated),
      pkCompared: PK.compared,
      // ★ v3.70（B178）：逐行守恒的三条读数（判不了那格排在指控之前，不许被"没有指控"顶掉）
      deletedPreexisting: DEL_ATTR.preexisting,
      deletedPreexistingBrief: DEL_ATTR.preexistingBrief,
      deletedUnknown: DEL_ATTR.unknown,
      deletedUnknownBrief: DEL_ATTR.unknownBrief,
      deletedUnknownRows: DEL_ATTR.unknownRows,
      deletedUnknownWholeTables: DEL_ATTR.unknownWholeTables,
      deletedUnknownRowsSilent: DEL_ATTR.unknownRowsSilent,
      // ★ v3.74（复核 #17 B-2）：命名口径不一致曾让"有 3 行、报 0 行"两头都读成 0 ⇒ 单列一个数
      deletedUnreconciled: DEL_UNRECONCILED,
      // ★ v3.77（B187）：正对照结果进判决。没跑过或跑失败 ⇒ `删的跑前行=0` 不许读成"没多删"（unproven）。
      axisControl: AXIS,
      // ★ v3.54 按行归因（成对误差只有这一层能抓）：
      //   windowResidue = 清理后仍活着的"本次窗口内创建的行"；overDeleted = 守恒校验失败的删除；
      //   attributionBlind **只取真正参与了这程的表**（有变化或清理报过数的），
      //   否则"没有 createdAt 的模型"一大片会把 clean 支路永远钉死（那是 v3.43 B-3 那个病）。
      ...(() => {
        const deletedAll = mergeDeleted(OWN_DELETES, cleaned.byModel);   // ★ v3.59：两条删除通道都要进守恒，只喂清扫那份＝漏掉手写清单删的行
        const touched = new Set([...Object.keys(deletedAll),
          ...grew.map((x) => x.model), ...below.map((x) => x.model),
          ...Object.keys(WIN_W.counts), ...Object.keys(WIN_C.counts || {})]);
        const cons = conservationCheck({
          createdInWindowAtWrite: WIN_W.counts,
          createdInWindowAtClean: WIN_C.counts,
          deletedByModel: deletedAll,
          // ★ v3.60：这些表我是**按自己拿到的 id 删的**（tryDel 那一路）⇒ "本次造了几行"绝不该数出 0；
          //   数出 0 就说明坏的是时间窗，不是删除面。没有这条正对照，第四程一口气报了 24 处伪指控。
          knownCreatedModels: Object.keys(OWN_DELETES),
        });
        return {
          windowResidue: cons.residue,
          overDeleted: cons.overDeleted,
          unattributedDeleted: cons.unattributed,
          instrumentSuspect: cons.instrumentSuspect,
          // ★ v3.63（复核 #15 I-1）：逐表落点要跟着判决出去。没有它，"守恒失败 0 处"就只能靠
          //   "那 24 张表在四个指控桶里都没出现"**反推**，而"每个非空桶都会打印"这条前提无人证。
          disposition: cons.disposition,
          attributionBlind: WIN_W.blind.filter((m) => touched.has(canonModel(m))),
          // ★ v3.55：归因层的分母。取两次窗口计数里较小的那个 ⇒ 任一次 DMMF 枚举失效都当场 unproven，
          //   不会让"counts 空对象"冒充"本次一行都没造"（那会把 overDeleted 变成对我的诬告）。
          attributionEnumerated: Math.min(WIN_W.enumerated, WIN_C.enumerated),
        };
      })() }, rep);
    //   ↑ 洞②：countAllModels 的 unreadable 原先被丢两次 ⇒ 对撞集合缺谁都不知道，"没有增长"就是假的   // ★ out 必须是 reporter 本身，判决才有地方落
    // ★ v3.87（Kevin 2026-09-25 拍定「承认来源合法的保留行」的落地）：判决**单列一格**。
    //   这里把「常驻演示数据集（SIM-）」作为唯一的保留行 arm —— 它有**独立机制证据**
    //   （生成器在 `server/scripts/company-sim/*`，族名取自 lib 的唯一出处 `SIM_DATASET_MARKERS`），
    //   不是"我说它干净"。本格**不参与**任何判定（不放松残留定义）、**纯读不删**（不动删除面）。
    //   ⚠️ 数不到就**不交这一格**（缺席 ≠ 0 行）：sweepResidue 会把"数不了的表"带进 unreadableOut。
    const SIM_UNREADABLE = [];
    const SIM_SCAN = { scannable: 0, scanned: 0 };
    let RETAINED = null;
    try {
      // ⚠️ `sweepResidue` **直接返回 hits 数组**（不是 {hits}）—— 第一版我读 `.hits` 拿到 undefined ⇒ 印成 0 行。
      const simHits = await sweepResidue({ prisma, Prisma: PrismaRef, markers: SIM_DATASET_MARKERS, withFamily: false, unreadableOut: SIM_UNREADABLE, scanStatOut: SIM_SCAN });
      const simTotal = (Array.isArray(simHits) ? simHits : []).reduce((s, h) => s + (Number(h?.count) || 0), 0);
      // ★ 分母为空不许印 0：一张表都没扫到（DMMF 枚举失效）与"库里真没有 SIM 行"必须分得开
      if (SIM_UNREADABLE.length > 0) {
        console.log(`  ⚠️ 保留行那一格**缺席**：有 ${SIM_UNREADABLE.length} 张表数不了 ⇒ 不许把它读成 0 行`);
      } else if (!(SIM_SCAN.scanned > 0)) {
        console.log('  ⚠️ 保留行那一格**缺席**：一张表都没被扫到（枚举失效）⇒ 不许读成 0 行');
      } else {
        RETAINED = [{ label: 'company-sim 常驻演示数据集（SIM-）', count: simTotal,
          evidence: '生成器 server/scripts/company-sim/*；族名取自 lib/drill-residue 的 SIM_DATASET_MARKERS（唯一出处）' }];
      }
    } catch (e) {
      console.log(`  ⚠️ 保留行那一格**缺席**（取数失败：${e?.message ?? e}）⇒ 不许读成 0 行`);
    }
    await prisma.$disconnect().catch(() => {});

    // ★ v3.39（B165）：收尾（三态计数 + 署名 + **残留结论是否真发出过一次** + 退出码）整体交给 lib。
    //   关键变化：0 条结论 ⇒ **退 5**，不再可能被读成"跑完了、只是没打印"。
    //   署名状态进判决行本身（日志常被单独复制，banner 在开头不等于结论带着走）。
    finishRun({ rep, attr: ATTR, waived: ALLOW_UNATTRIBUTED, retained: RETAINED });
  }
}

// ★ v3.41（BLOCKER-2）：顶层收尾后再复核一次「有没有产出结论」，被 return 跳过的那条路也从这里红
main().then(() => assertResidueAudited(rep)).catch((e) => { console.error('脚本异常', e); process.exit(2); });
