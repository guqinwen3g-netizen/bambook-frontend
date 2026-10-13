// 业务变异维度补全（2026-09-19）—— 把「未覆盖」变成「已覆盖 / 撞出真缺陷」
//
// 为什么单独一个脚本（而不是塞进 acceptance-e2e-business-chain.mjs）：
//   整链脚本验的是**主链的顺序与数字传递**（一条单子走到底，3–4s）；
//   本脚本验的是**正交的四个变异维度**，每个都要独立构造场景（多订单/多报关单/多币种/多处置），
//   塞在一起会让「主链」这个概念被稀释，且失败时定位成本变高。
//
// 覆盖的四个维度（都是此前诚实标注为「未覆盖」的）：
//   V1 CIF / CFR 成交方式 → 退税 FOB 剥离口径（真库 tradeTerms 48 条全 FOB，从无覆盖）
//   V2 拼柜（一运单多订单）→ 运费分摊（真库无数据；含「计量单位不可互算」退化）
//   V3 多币种核销 → fail-closed 阻断（真库 0 条跨币种核销）
//   V4 索赔其余三类处置 → ReturnRefund / Replace / Repair（此前只覆盖 Allowance）
//
// ★ 每个维度都要有**对照**，否则「通过」可能只是「没跑到」：
//   V1 用「CIF 全额登记 / CFR 只运费 / CIF 缺登记」三态对照
//   V2 用「混单位均摊 vs 同单位按量」双向对照（这一条正是 2026-09-19 修的那个缺陷）
//   V3 用「同币种通过 vs 跨币种阻断」对照
//   V4 用「三类各自产物」对照
//
// 用法：node scripts/acceptance-e2e-business-variants.mjs
//       VAR_DEBUG=1 node scripts/acceptance-e2e-business-variants.mjs
import { createRequire } from 'node:module';
import { SERVER_DIR, loadEnvForScript } from './lib/acceptance-selfcheck.mjs';
// ★ 全模型残留清扫器：手写回滚清单**必然漏**（业务事件总线会扇出 notification/agentJob、
//   建单会初始化 productionStage、处置动作会衍生单据）⇒ 用共享清扫器按标识全模型兜底。
import { settleAndClean, sweepResidue } from './lib/drill-residue.mjs';

const BASE = 'http://127.0.0.1:8081';
const PASSWORD = 'Bambook@2026';
const DEBUG = process.env.VAR_DEBUG === '1';

const TS = Date.now().toString(36).toUpperCase();
const MARK = `DRILLVAR${TS}`;
const REL_ID = `REL__${MARK}`;
const ORD_A = `${MARK}-A`;
const ORD_B = `${MARK}-B`;
const INV_A = `DRILLVAR-INV-${TS}-A`;
const INV_CUR = `DRILLVAR-INV-${TS}-CUR`;
const PV_CUR = `DRILLVAR-PV-${TS}-CUR`;
const CD_PREFIX = `DRILLVAR-CD-${TS}`;
const HS_CODE = '52093900'; // 真库唯一带退税率的税则码（13%）
const WAREHOUSE = 'SIM-WH-MAIN';
const WORKSTATION = 'SIM-WS-001';
const FX = 7.1; // 演练用汇率（挂到发票快照上，退税核算取它）

const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const plusDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const results = [];
const pass = (n, d = '') => { results.push({ ok: true, n }); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n, d = '') => { results.push({ ok: false, n }); console.log(`  ✗ ${n} — ${d}`); };
const gap = (n, d = '') => { results.push({ ok: null, n }); console.log(`  ⚠️  [gap] ${n}${d ? ' — ' + d : ''}`); };
const step = (s) => console.log(`\n── ${s} ──`);
const num = (v) => (v === null || v === undefined ? null : Number(v));
const near = (a, b, eps = 0.01) => a !== null && b !== null && Math.abs(a - b) < eps;

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
  if (DEBUG && res.status >= 400) console.log(`    [diag] ${method} ${path} → ${res.status} ${text.slice(0, 260)}`);
  return { status: res.status, data, text };
}

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

const created = {
  relationIds: [], orderIds: [], invoiceIds: [], voucherIds: [], shipmentIds: [],
  declarationIds: [], taxRefundIds: [], claimCaseIds: [], dispositionIds: [],
  creditNoteIds: [], returnReceiptIds: [], repairWorkOrderIds: [],
  // ★ 票内分摊行的 id 也必须记：它的审计 targetId 是 `SHPA__<分摊行id>`，
  //   与 shipmentId / orderId 都不同 ⇒ 不记就必然漏（行数对撞守卫实测抓到 +4/次）。
  allocationIds: [], auditIds: [],
};
const allIds = () => Object.values(created).flat().filter(Boolean);

async function tryDel(name, fn) {
  try { const r = await fn(); if (r?.count) console.log(`     · 删除 ${name}：${r.count} 行`); return r?.count ?? 0; }
  catch (e) { console.log(`     ! 删除 ${name} 失败：${String(e?.message ?? e).slice(0, 150)}`); return -1; }
}

const inIds = (arr) => (arr.length ? arr : ['__none__']);

async function rollback() {
  console.log('\n── 回滚 ──');
  const orderIds = inIds(created.orderIds), invIds = inIds(created.invoiceIds),
    shipIds = inIds(created.shipmentIds), declIds = inIds(created.declarationIds),
    caseIds = inIds(created.claimCaseIds), cnIds = inIds(created.creditNoteIds),
    dispIds = inIds(created.dispositionIds), relIds = inIds(created.relationIds);

  // 索赔族
  await tryDel('CreditNoteAllocation', () => prisma.creditNoteAllocation.deleteMany({ where: { OR: [{ creditNoteId: { in: cnIds } }, { invoiceId: { in: invIds } }] } }));
  await tryDel('CreditNote', () => prisma.creditNote.deleteMany({ where: { id: { in: cnIds } } }));
  await tryDel('ReturnReceipt', () => prisma.returnReceipt.deleteMany({ where: { OR: [{ id: { in: inIds(created.returnReceiptIds) } }, { claimCaseId: { in: caseIds } }] } }));
  await tryDel('RepairWorkOrder', () => prisma.repairWorkOrder.deleteMany({ where: { OR: [{ id: { in: inIds(created.repairWorkOrderIds) } }, { claimCaseId: { in: caseIds } }] } }));
  await tryDel('ClaimDisposition', () => prisma.claimDisposition.deleteMany({ where: { OR: [{ id: { in: dispIds } }, { claimCaseId: { in: caseIds } }] } }));
  await tryDel('ClaimCase', () => prisma.claimCase.deleteMany({ where: { OR: [{ id: { in: caseIds } }, { customerRelationId: { in: relIds } }] } }));

  // 财务族
  await tryDel('InvoiceAllocation', () => prisma.invoiceAllocation.deleteMany({ where: { OR: [{ invoiceId: { in: invIds } }, { voucherId: { in: inIds(created.voucherIds) } }] } }));
  await tryDel('InvoiceOrderAllocation', () => prisma.invoiceOrderAllocation.deleteMany({ where: { OR: [{ invoiceId: { in: invIds } }, { orderId: { in: orderIds } }] } }));
  await tryDel('InvoiceLine', () => prisma.invoiceLine.deleteMany({ where: { invoiceId: { in: invIds } } }));
  await tryDel('Invoice', () => prisma.invoice.deleteMany({ where: { OR: [{ id: { in: invIds } }, { invoiceNumber: { contains: MARK } }] } }));
  await tryDel('PaymentVoucher', () => prisma.paymentVoucher.deleteMany({ where: { OR: [{ id: { in: inIds(created.voucherIds) } }, { voucherNumber: { contains: MARK } }] } }));

  // 报关/退税
  await tryDel('TaxRefund', () => prisma.taxRefund.deleteMany({ where: { OR: [{ id: { in: inIds(created.taxRefundIds) } }, { declarationId: { in: declIds } }, { refundNumber: { contains: CD_PREFIX } }] } }));
  await tryDel('CustomsDeclarationLine', () => prisma.customsDeclarationLine.deleteMany({ where: { declarationId: { in: declIds } } }));
  await tryDel('CustomsDeclaration', () => prisma.customsDeclaration.deleteMany({ where: { OR: [{ id: { in: declIds } }, { declarationNumber: { contains: CD_PREFIX } }] } }));

  // 出运族（含 Replace 生成的补发运单）
  await tryDel('ShipmentOrderAllocation', () => prisma.shipmentOrderAllocation.deleteMany({ where: { OR: [{ shipmentId: { in: shipIds } }, { orderId: { in: orderIds } }] } }));
  await tryDel('ShipmentLine', () => prisma.shipmentLine.deleteMany({ where: { shipmentId: { in: shipIds } } }));
  await tryDel('ShipmentCarton', () => prisma.shipmentCarton.deleteMany({ where: { shipmentId: { in: shipIds } } }));
  await tryDel('ShipmentEvent', () => prisma.shipmentEvent.deleteMany({ where: { shipmentId: { in: shipIds } } }));
  await tryDel('Shipment', () => prisma.shipment.deleteMany({ where: { OR: [{ id: { in: shipIds } }, { orderId: { in: orderIds } }, { notes: { contains: MARK } }] } }));
  await tryDel('OrderShipmentBatch', () => prisma.orderShipmentBatch.deleteMany({ where: { orderId: { in: orderIds } } }));

  // 利润表 / BOM / 订单 / 客户
  await tryDel('OrderProfitSheet', () => prisma.orderProfitSheet.deleteMany({ where: { orderId: { in: orderIds } } }));
  await tryDel('BOMLine', () => prisma.bOMLine.deleteMany({ where: { bomId: { in: inIds(created.bomIds ?? []) } } }));
  await tryDel('BOM', () => prisma.bOM.deleteMany({ where: { OR: [{ id: { in: inIds(created.bomIds ?? []) } }, { orderId: { in: orderIds } }] } }));
  await tryDel('OrderStatusTransition', () => prisma.orderStatusTransition.deleteMany({ where: { orderId: { in: orderIds } } }));
  await tryDel('OrderLine', () => prisma.orderLine.deleteMany({ where: { orderId: { in: orderIds } } }));
  await tryDel('Order', () => prisma.order.deleteMany({ where: { OR: [{ id: { in: orderIds } }, { poNumber: { contains: MARK } }] } }));
  await tryDel('Relation', () => prisma.relation.deleteMany({ where: { id: { in: relIds } } }));

  // 联动副作用 —— ★ 三类必漏（2026-09-19 教训）：
  //   ① 复合键 targetId（ALLOC__<inv>__<pay> / CNA__<cn>__<inv>）
  //   ② targetId 为 null 的行（登录审计）⇒ 必须按 id 删
  //   ③ 自动联动产生的实体（这里没有 L6 BOM，因为本脚本不确认订单）
  const ids = allIds();
  const refOr = [{ ownerId: { contains: MARK } }, { targetId: { contains: MARK } }, { ownerId: { in: ids } }, { targetId: { in: ids } }];
  await tryDel('EntityReference', () => prisma.entityReference.deleteMany({ where: { OR: refOr } }));
  const linkOr = [{ fromId: { contains: MARK } }, { toId: { contains: MARK } }, { fromId: { in: ids } }, { toId: { in: ids } }];
  await tryDel('EntityLink', () => prisma.entityLink.deleteMany({ where: { OR: linkOr } }));
  await tryDel('ApprovalRequest', () => prisma.approvalRequest.deleteMany({ where: { OR: [{ targetId: { in: ids } }, { targetId: { contains: MARK } }] } }));
  const auditOr = [{ targetId: { in: ids } }, { targetId: { contains: MARK } }, { id: { in: inIds(created.auditIds) } }];
  for (const inv of created.invoiceIds) auditOr.push({ targetId: { contains: inv } });
  for (const pv of created.voucherIds) auditOr.push({ targetId: { contains: pv } });
  for (const cn of created.creditNoteIds) auditOr.push({ targetId: { contains: cn } });
  for (const al of created.allocationIds) auditOr.push({ targetId: { contains: al } });
  await tryDel('AuditLog', () => prisma.auditLog.deleteMany({ where: { OR: auditOr } }));
}

// ★ 原 `verifyNoResidue()`（手写模型清单）已**删除** —— 它只覆盖 16 个模型，
//   实测漏掉 `creditNote`/`productionStage`/`notification`/`agentJob` 等
//   ⇒ 会给出「零残留」的**假结论**。现由 `lib/drill-residue.mjs` 的
//   `sweepResidue()`（**全模型**，覆盖面取自 Prisma DMMF）承担复核，
//   见 `finally` 块。**别再把手写清单加回来**。

// ══════════════════════════════════════════════════════════════════════
async function main() {
  await connectPrisma();
  const admin = await login('jason.shen@bambook.local');
  if (!admin) { console.error('管理员登录失败'); process.exit(1); }
  const la = await prisma.auditLog.findFirst({ where: { action: 'login' }, orderBy: { createdAt: 'desc' } });
  if (la) created.auditIds.push(la.id);
  console.log(`══ 业务变异维度补全演练 ══`);
  console.log(`   标识 MARK=${MARK}  订单=${ORD_A} / ${ORD_B}`);

  try {
    // ── 公共前置：一个客户 + 两个订单（同客户是合票的硬前提）──────────
    step('前置：演练客户 + 两个订单');
    const rel = await api(admin, 'POST', '/api/v1/relations', {
      id: REL_ID, name: `DRILL 变异演练客户 ${TS}`, category: 'Customer',
      currency: 'USD', creditLimit: 900000, paymentTerms: 'T/T 30 days',
    });
    if (rel.status === 200) { created.relationIds.push(REL_ID); pass('建演练客户', REL_ID); }
    else { fail('建演练客户', `HTTP ${rel.status} ${rel.text.slice(0, 180)}`); return; }

    const mkOrder = (id, po) => api(admin, 'POST', '/api/v1/orders', {
      id, poNumber: po, customer: `DRILL 变异演练客户 ${TS}`, customerRelationId: REL_ID,
      millName: 'DRILL 演练工厂', type: 'Fabric', businessLine: 'fabric',
      currency: 'USD', deliveryTerms: 'FOB', paymentTerms: 'T/T 30 days',
      dueDate: plusDays(45), quoteAmount: 10000, quantity: 1000,
    });
    const oa = await mkOrder(ORD_A, `${MARK}-PO-A`);
    const ob = await mkOrder(ORD_B, `${MARK}-PO-B`);
    if (oa.status !== 200 && oa.status !== 201) { fail('建订单 A', `HTTP ${oa.status} ${oa.text.slice(0, 180)}`); return; }
    if (ob.status !== 200 && ob.status !== 201) { fail('建订单 B', `HTTP ${ob.status} ${ob.text.slice(0, 180)}`); return; }
    created.orderIds.push(ORD_A, ORD_B);
    pass('建两个订单（同客户 · 同业务线）', `${ORD_A} / ${ORD_B}`);

    // ══ V1 CIF / CFR → 退税 FOB 剥离 ═════════════════════════════════
    step('V1 CIF/CFR 成交方式 → 退税 FOB 剥离（真库 48 条报关全 FOB，此前零覆盖）');
    // 退税核算的汇率取自「该订单最近一张应收发票的 exchangeRate 快照」
    const invA = await api(admin, 'POST', '/api/v1/finance', {
      type: 'Receivable', status: 'Draft', amount: 10000, currency: 'USD', issueDate: today,
      invoiceNumber: INV_A, orderId: ORD_A, customerRelationId: REL_ID,
      customerName: `DRILL 变异演练客户 ${TS}`, exchangeRate: FX,
    });
    if (invA.status === 201 && invA.data?.id) {
      created.invoiceIds.push(invA.data.id);
      pass('挂一张带汇率快照的应收发票（退税核算取此汇率）', `exchangeRate=${FX}`);
    } else {
      gap('建汇率快照发票未通过', `HTTP ${invA.status} ${invA.text.slice(0, 180)} —— 缺汇率时退税额算不出，V1 只能验 FOB 金额`);
    }

    const GROSS = 10000, FREIGHT = 800, INSURANCE = 200;
    const mkDecl = (suffix, tradeTerms, freight, insurance) => api(admin, 'POST', '/api/v1/customs/declarations', {
      declarationNumber: `${CD_PREFIX}-${suffix}`, type: 'Export', orderId: ORD_A, relationId: REL_ID,
      declarationDate: today, tradeTerms, totalValue: GROSS, currency: 'USD',
      freightAmount: freight, insuranceAmount: insurance,
      notes: `${MARK} V1 ${suffix}`,
      lines: [{ productName: `DRILL 变异演练面料 ${TS}`, hsCode: HS_CODE, quantity: 1000, unit: 'M', unitPrice: 10, totalAmount: GROSS, currency: 'USD' }],
    });

    const d1 = await mkDecl('CIF', 'CIF', FREIGHT, INSURANCE);
    const d2 = await mkDecl('CFR', 'CFR', FREIGHT, null);
    const d3 = await mkDecl('CIF-MISS', 'CIF', null, null); // 缺运保费登记 → fail-closed 对照
    // ★ 2026-09-19 补全：CIP（与 CIF 同族，剥运费+保费）与 DDP（**不可剥离**族）
    const d4 = await mkDecl('CIP', 'CIP', FREIGHT, INSURANCE);
    const d5 = await mkDecl('DDP', 'DDP', FREIGHT, INSURANCE);
    const declOk = [d1, d2, d3, d4, d5].every((d) => d.status === 201 && d.data?.item?.id);
    if (!declOk) {
      fail('建五张报关单', `HTTP ${[d1, d2, d3, d4, d5].map((d) => d.status).join('/')} ${d1.text.slice(0, 200)}`);
    } else {
      const [id1, id2, id3, id4, id5] = [d1, d2, d3, d4, d5].map((d) => d.data.item.id);
      created.declarationIds.push(id1, id2, id3, id4, id5);
      pass('建五张报关单', `CIF(运${FREIGHT}+保${INSURANCE}) / CFR(仅运) / CIF 缺登记 / CIP / DDP`);

      const mkRefund = async (declId) => {
        const r = await api(admin, 'POST', `/api/v1/customs/tax-refunds/from-declaration/${encodeURIComponent(declId)}`, {});
        if (r.data?.item?.id) created.taxRefundIds.push(r.data.item.id);
        return r;
      };
      const r1 = await mkRefund(id1), r2 = await mkRefund(id2), r3 = await mkRefund(id3);
      const r4 = await mkRefund(id4), r5 = await mkRefund(id5);

      // CIF：毛额 10000 − 运费 800 − 保费 200 = 9000
      const fob1 = num(r1.data?.item?.exportAmountFob);
      if (r1.status === 201 && near(fob1, GROSS - FREIGHT - INSURANCE)) {
        pass('★ CIF 剥离：FOB = 毛额 − 运费 − 保费', `${GROSS} − ${FREIGHT} − ${INSURANCE} = ${fob1}`);
      } else {
        fail('★ CIF 剥离', `HTTP ${r1.status} FOB=${fob1}（期望 ${GROSS - FREIGHT - INSURANCE}）`);
      }

      // CFR：只剥运费
      const fob2 = num(r2.data?.item?.exportAmountFob);
      if (r2.status === 201 && near(fob2, GROSS - FREIGHT)) {
        pass('★ CFR 剥离：FOB = 毛额 − 运费（不扣保费）', `${GROSS} − ${FREIGHT} = ${fob2}`);
      } else {
        fail('★ CFR 剥离', `HTTP ${r2.status} FOB=${fob2}（期望 ${GROSS - FREIGHT}）`);
      }

      // 缺登记：fail-closed —— 绝不回退成毛额（回退 = 退税报给税务局的数静默虚高）
      const fob3 = num(r3.data?.item?.exportAmountFob);
      if (r3.status === 201 && (fob3 === null || fob3 === 0)) {
        pass('★ 阳性对照：CIF 缺运保费登记 → 不给 FOB（fail-closed，未回退成毛额）', `exportAmountFob=${fob3 ?? 'null'}`);
      } else if (r3.status === 201 && fob3 === GROSS) {
        fail('★ 阳性对照：缺登记竟回退成毛额', `exportAmountFob=${fob3} = 毛额 —— 退税基数虚高且不报错`);
      } else {
        gap('缺登记报关单未能生成退税单', `HTTP ${r3.status} ${r3.text.slice(0, 180)}`);
      }

      // 钱的那一刀：refundableVat 也必须按剥离后基数（不是毛额）
      // 单行口径 = 毛额 × (FOB/毛额) × 汇率 × 退税率 = FOB × 汇率 × 13%
      const vat1 = num(r1.data?.item?.refundableVat);
      const expectVat = Math.round((GROSS - FREIGHT - INSURANCE) * FX * 0.13 * 10000) / 10000;
      const grossVat = Math.round(GROSS * FX * 0.13 * 10000) / 10000;
      if (near(vat1, expectVat, 0.05)) {
        pass('★ CIF 退税额按剥离后 FOB 计（不是毛额）', `refundableVat=${vat1}（毛额口径会是 ${grossVat}）`);
      } else if (vat1 === null) {
        gap('退税额算不出（缺汇率快照或退税率）', `refundableVat=null —— FOB 已验，钱的那一刀未覆盖`);
      } else if (near(vat1, grossVat, 0.05)) {
        fail('★ 退税额仍按毛额计（「变量名对了、钱没对」）', `refundableVat=${vat1} = 毛额口径 ${grossVat}`);
      } else {
        fail('★ 退税额数值不符', `refundableVat=${vat1}（期望 ${expectVat}）`);
      }

      // ★ CIP：与 CIF 同族（剥运费 + 保费）—— 证明「同族口径一致」，不是只对 CIF 特判
      const fob4 = num(r4.data?.item?.exportAmountFob);
      if (r4.status === 201 && near(fob4, GROSS - FREIGHT - INSURANCE)) {
        pass('★ CIP 剥离：与 CIF 同族（毛额 − 运费 − 保费）', `${fob4}`);
      } else {
        fail('★ CIP 剥离', `HTTP ${r4.status} FOB=${fob4}（期望 ${GROSS - FREIGHT - INSURANCE}）`);
      }

      // ★ DDP：属**不可剥离**族 —— 应**不给数**（fail-closed），且**不得**误当 FOB 用
      const fob5 = num(r5.data?.item?.exportAmountFob);
      if (r5.status === 201 && (fob5 === null || fob5 === 0)) {
        pass('★ DDP（不可剥离族）：不给 FOB，未把含税到岸价当离岸价', `exportAmountFob=${fob5 ?? 'null'}`);
      } else if (r5.status === 201 && fob5 === GROSS) {
        fail('★ DDP 竟给出毛额当 FOB', `exportAmountFob=${fob5} —— 到岸价被当离岸价，退税基数虚高`);
      } else {
        gap('DDP 报关单未能生成退税单', `HTTP ${r5.status} ${r5.text.slice(0, 180)}`);
      }
    }

    // ══ V2 拼柜运费分摊 ══════════════════════════════════════════════
    step('V2 拼柜（一运单多订单）→ 运费分摊（真库无数据；含「计量单位不可互算」）');
    const FREIGHT_AMT = 1000;
    const mkShip = (suffix) => api(admin, 'POST', '/api/v1/shipping', {
      type: 'Export', shippingMethod: 'Sea', status: 'Booked',
      orderId: ORD_A, customerRelationId: REL_ID, customerName: `DRILL 变异演练客户 ${TS}`,
      portOfLoading: 'Shanghai', portOfDischarge: 'Rotterdam',
      bookingDate: today, etd: plusDays(3), eta: plusDays(25),
      freightAmount: FREIGHT_AMT, freightCurrency: 'USD', notes: `${MARK} V2 ${suffix}`,
    });
    const sMix = await mkShip('混单位');
    const sSame = await mkShip('同单位');
    // ★ 2026-09-19 补全「单位缺省」两态（口径：**缺省 unit 不视为「不同」**）
    const sPartialUnit = await mkShip('一单一缺省');
    const sNoUnit = await mkShip('全部缺省单位');
    const sNoQty = await mkShip('数量单位全缺');
    if ([sMix, sSame, sPartialUnit, sNoUnit, sNoQty].some((s) => s.status !== 201)) {
      fail('建五张拼柜运单', `HTTP ${[sMix, sSame, sPartialUnit, sNoUnit, sNoQty].map((s) => s.status).join('/')} ${sMix.text.slice(0, 200)}`);
    } else {
      const shipMix = sMix.data.id, shipSame = sSame.data.id;
      const shipPartialUnit = sPartialUnit.data.id, shipNoUnit = sNoUnit.data.id, shipNoQty = sNoQty.data.id;
      created.shipmentIds.push(shipMix, shipSame, shipPartialUnit, shipNoUnit, shipNoQty);
      pass('建五张运单（同一订单锚，用于合票）', `混单位 / 同单位 / 一单一缺省 / 全缺省单位 / 数量单位全缺`);

      // qty === null ⇒ **不传** plannedQty（构造「数量全缺」分支）
      const mkAlloc = async (shipId, orderId, qty, unit) => {
        const r = await api(admin, 'POST', `/api/v1/shipping/${encodeURIComponent(shipId)}/allocations`, {
          orderId,
          ...(qty == null ? {} : { plannedQty: qty }),
          ...(unit == null ? {} : { unit }),
        });
        if (r.data?.id) created.allocationIds.push(r.data.id);
        return r;
      };
      // 混单位票：A 100 M + B 300 KG（Σ数量无意义）
      const a1 = await mkAlloc(shipMix, ORD_A, 100, 'M');
      const a2 = await mkAlloc(shipMix, ORD_B, 300, 'KG');
      // 同单位票（对照）：A 100 M + B 300 M
      const a3 = await mkAlloc(shipSame, ORD_A, 100, 'M');
      const a4 = await mkAlloc(shipSame, ORD_B, 300, 'M');
      // 一单一缺省票：A 100 M + B 300 **无单位** ⇒ 「缺省不视为不同」⇒ 仍按数量 25%
      const a5 = await mkAlloc(shipPartialUnit, ORD_A, 100, 'M');
      const a6 = await mkAlloc(shipPartialUnit, ORD_B, 300, null);
      // 全部缺省**单位**（数量仍在）⇒ 同样按数量 25%
      const a7 = await mkAlloc(shipNoUnit, ORD_A, 100, null);
      const a8 = await mkAlloc(shipNoUnit, ORD_B, 300, null);
      // 数量 + 单位**全缺** ⇒ Σ数量 = 0 ⇒ 数量口径失效 ⇒ 按票内订单数均摊 50%
      const a9 = await mkAlloc(shipNoQty, ORD_A, null, null);
      const a10 = await mkAlloc(shipNoQty, ORD_B, null, null);
      const allocs = [a1, a2, a3, a4, a5, a6, a7, a8, a9, a10];
      if (allocs.some((r) => r.status !== 201)) {
        fail('建票内分配', `HTTP ${allocs.map((r) => r.status).join('/')} ${a1.text.slice(0, 200)}`);
      } else {
        pass('建票内分配', '混单位 A100M/B300KG · 同单位 A100M/B300M · 一单一缺省 · 全缺省单位 · 数量单位全缺');

        const gen = await api(admin, 'POST', `/api/v1/pricing/profit-sheets/generate/${encodeURIComponent(ORD_A)}`, {});
        // ★ 实测：利润表在响应的 `item` 下（不是 `sheet`）。
        // ⚠️ 另注意 `maskProfitSheetRow`：缺 `sensitive:cost` 权限时 `details.freight` 会被
        //    **整组遮罩成空数组** ⇒ 用无该权限的账号跑，会看到「运费 0 行」而被误判成缺陷。
        const sheet = gen.data?.item ?? gen.data?.sheet ?? gen.data;
        if (gen.status !== 200 && gen.status !== 201) {
          gap('生成订单利润表未通过', `HTTP ${gen.status} ${gen.text.slice(0, 200)}`);
        } else {
          const details = sheet?.details ?? {};
          const freight = details.freight ?? [];
          const unconverted = details.unconverted ?? [];
          const lineMix = freight.find((l) => l.id === shipMix);
          const lineSame = freight.find((l) => l.id === shipSame);

          if (!lineMix || !lineSame) {
            const freightUnconv = unconverted.filter((u) => u.kind === 'freight');
            gap('利润表未同时含两张运单的运费行',
              `details.freight=${freight.length} 行 · details.unconverted 中 freight=${freightUnconv.length} 行`
              + `（0 行且未折算也为 0 ⇒ 多半是账号缺 sensitive:cost 被整组遮罩，不是算错）`);
          } else {
            // 混单位 → 按票内订单数均摊 = 50%
            if (near(num(lineMix.amount), FREIGHT_AMT * 0.5) && String(lineMix.label).includes('计量单位不一')) {
              pass('★ 混单位票：按票内订单均摊 50% 且**透明标注**', `amount=${lineMix.amount} label=「${String(lineMix.label).slice(0, 46)}」`);
            } else {
              fail('★ 混单位票分摊', `amount=${lineMix.amount}（期望 ${FREIGHT_AMT * 0.5}）label=「${lineMix.label}」`);
            }
            // 同单位 → 按数量 = 100/400 = 25%
            if (near(num(lineSame.amount), FREIGHT_AMT * 0.25) && !String(lineSame.label).includes('计量单位不一')) {
              pass('★ 阳性对照：同单位票按数量分摊 25%（未误触发均摊）', `amount=${lineSame.amount} label=「${String(lineSame.label).slice(0, 46)}」`);
            } else {
              fail('★ 同单位票分摊（对照）', `amount=${lineSame.amount}（期望 ${FREIGHT_AMT * 0.25}）label=「${lineSame.label}」`);
            }
            // ★ 票内自洽（跨订单对撞）：票内**各订单**分摊之和必须 = 票面运费。
            //   ⚠️ 易错点（我第一版就写错了）：订单 A 的利润表里只有 A 的 share（500），
            //   不是票面 1000 —— 必须把 B 单的利润表也生成出来相加，
            //   否则会把自己写错的期望当成产品缺陷。
            const genB = await api(admin, 'POST', `/api/v1/pricing/profit-sheets/generate/${encodeURIComponent(ORD_B)}`, {});
            const sheetB = genB.data?.item ?? genB.data?.sheet ?? genB.data;
            const freightB = sheetB?.details?.freight ?? [];
            const mixSum = [...freight, ...freightB].filter((l) => l.id === shipMix).reduce((s, l) => s + num(l.amount), 0);
            const sameSum = [...freight, ...freightB].filter((l) => l.id === shipSame).reduce((s, l) => s + num(l.amount), 0);
            if (near(mixSum, FREIGHT_AMT) && near(sameSum, FREIGHT_AMT)) {
              pass('★ 票内自洽（跨订单对撞）：A 单 + B 单分摊之和 = 票面运费', `混单位 ${mixSum} / 同单位 ${sameSum} = ${FREIGHT_AMT}`);
            } else {
              fail('★ 票内自洽（跨订单对撞）', `混单位之和 ${mixSum} / 同单位之和 ${sameSum}（期望各 ${FREIGHT_AMT}）`);
            }

            // ★ 单位缺省三态（口径：**缺省 unit 不视为「不同」**；均摊只在「混单位」或「数量全缺」时触发）
            const linePartial = freight.find((l) => l.id === shipPartialUnit);
            const lineNoUnit = freight.find((l) => l.id === shipNoUnit);
            const lineNoQty = freight.find((l) => l.id === shipNoQty);
            if (!linePartial || !lineNoUnit || !lineNoQty) {
              gap('利润表未含「单位/数量缺省」三票的运费行', `details.freight=${freight.length} 行`);
            } else {
              // 一单一缺省：单位集合={'m'} ⇒ 不视为不同 ⇒ 按数量 100/400 = 25%，**不得**触发均摊
              if (near(num(linePartial.amount), FREIGHT_AMT * 0.25) && !String(linePartial.label).includes('计量单位不一')) {
                pass('★ 一单一缺省：缺省**不视为「不同」**⇒ 仍按数量 25%（未误触发均摊）',
                  `amount=${linePartial.amount}`);
              } else {
                fail('★ 一单一缺省票分摊', `amount=${linePartial.amount}（期望 ${FREIGHT_AMT * 0.25}）label=「${linePartial.label}」`);
              }
              // 全缺省**单位**（数量仍在）⇒ 同样按数量 25%
              //   ⚠️ 这里我第一次把期望写成 50%（以为「缺省」=「数量也没有」）——
              //      实际 `qtyOf` 取的是**数量**、与单位无关 ⇒ 数量还在就按数量算。**是判据写错了，不是产品缺陷。**
              if (near(num(lineNoUnit.amount), FREIGHT_AMT * 0.25) && !String(lineNoUnit.label).includes('计量单位不一')) {
                pass('★ 全缺省单位（数量仍在）：仍按数量 25%（缺省单位不影响数量口径）', `amount=${lineNoUnit.amount}`);
              } else {
                fail('★ 全缺省单位票分摊', `amount=${lineNoUnit.amount}（期望 ${FREIGHT_AMT * 0.25}）label=「${lineNoUnit.label}」`);
              }
              // 数量 + 单位**全缺** ⇒ Σ数量 = 0 ⇒ 数量口径失效 ⇒ 按票内订单数均摊 50%
              if (near(num(lineNoQty.amount), FREIGHT_AMT * 0.5)) {
                pass('★ 数量+单位全缺：数量口径失效 ⇒ 按票内订单数均摊 50%', `amount=${lineNoQty.amount}`);
              } else {
                fail('★ 数量单位全缺票分摊', `amount=${lineNoQty.amount}（期望 ${FREIGHT_AMT * 0.5}）`);
              }
            }
          }
        }
      }
    }

    // ══ V3 多币种核销 → fail-closed ══════════════════════════════════
    step('V3 多币种核销 → fail-closed 阻断（真库 0 条跨币种核销）');
    const invCur = await api(admin, 'POST', '/api/v1/finance', {
      type: 'Receivable', status: 'Draft', amount: 5000, currency: 'USD', issueDate: today,
      invoiceNumber: INV_CUR, orderId: ORD_B, customerRelationId: REL_ID,
      customerName: `DRILL 变异演练客户 ${TS}`,
    });
    const pvCur = await api(admin, 'POST', '/api/v1/finance/vouchers', {
      type: 'Receipt', voucherNumber: PV_CUR, amount: 5000, currency: 'EUR', paymentDate: today,
      paymentMethod: 'T/T', customerRelationId: REL_ID, customerName: `DRILL 变异演练客户 ${TS}`,
      notes: `${MARK} V3 欧元收款`,
    });
    if (invCur.status !== 201 || pvCur.status !== 201) {
      fail('建跨币种测试单据', `HTTP ${invCur.status}/${pvCur.status} ${invCur.text.slice(0, 180)}`);
    } else {
      const invCurId = invCur.data.id, pvCurId = pvCur.data.id;
      created.invoiceIds.push(invCurId); created.voucherIds.push(pvCurId);
      // 先置 Issued（Draft 不允许核销，会掩盖「币种」这个真正的判据）
      const iss = await api(admin, 'PATCH', `/api/v1/finance/${encodeURIComponent(invCurId)}`, { status: 'Issued' });
      if (iss.status !== 200) gap('跨币种票置为 Issued 未通过', `HTTP ${iss.status}`);

      const allocCross = await api(admin, 'POST', '/api/v1/finance/allocations', {
        invoiceId: invCurId, voucherId: pvCurId, appliedAmount: 5000, appliedDate: today,
      });
      const code = allocCross.data?.error?.code;
      if (allocCross.status === 400 && code === 'CURRENCY_MISMATCH') {
        pass('★ 跨币种核销被拒（USD 票 ← EUR 凭证）', `400 ${code} —— 报错优于算错`);
      } else {
        fail('★ 跨币种核销未按 CURRENCY_MISMATCH 拒绝', `HTTP ${allocCross.status} code=${code ?? JSON.stringify(allocCross.data).slice(0, 160)}`);
      }

      // 阳性对照：同币种可核销（证明上一条不是「什么都被拒」）
      const pvUsd = await api(admin, 'POST', '/api/v1/finance/vouchers', {
        type: 'Receipt', voucherNumber: `${PV_CUR}-USD`, amount: 1000, currency: 'USD', paymentDate: today,
        paymentMethod: 'T/T', customerRelationId: REL_ID, customerName: `DRILL 变异演练客户 ${TS}`,
        notes: `${MARK} V3 美元收款（对照）`,
      });
      if (pvUsd.status === 201) {
        created.voucherIds.push(pvUsd.data.id);
        const allocSame = await api(admin, 'POST', '/api/v1/finance/allocations', {
          invoiceId: invCurId, voucherId: pvUsd.data.id, appliedAmount: 1000, appliedDate: today,
        });
        if (allocSame.status === 201) pass('★ 阳性对照：同币种（USD←USD）核销成功', '证明上一条的拒绝来自币种判据，而非「一律拒绝」');
        else fail('★ 阳性对照：同币种核销竟失败', `HTTP ${allocSame.status} ${allocSame.text.slice(0, 180)}`);
      } else {
        gap('建同币种对照凭证未通过', `HTTP ${pvUsd.status}`);
      }
    }

    // ══ V4 索赔其余三类处置 ══════════════════════════════════════════
    step('V4 索赔其余三类处置（ReturnRefund / Replace / Repair —— 此前只覆盖 Allowance）');
    const claim = await api(admin, 'POST', '/api/v1/claims', {
      customerRelationId: REL_ID, customerName: `DRILL 变异演练客户 ${TS}`,
      sourceOrderId: ORD_A, category: 'Quality',
      problemDesc: `${MARK} 变异演练客诉：一单同时含退货退款 / 换货补发 / 返修三种诉求`,
    });
    if (claim.status !== 201 || !claim.data?.claimCase?.id) {
      gap('登记售后案件未通过', `HTTP ${claim.status} ${claim.text.slice(0, 200)}`);
    } else {
      const caseId = claim.data.claimCase.id;
      created.claimCaseIds.push(caseId);
      pass('登记售后案件（一案多处置）', `${claim.data.claimCase.caseNumber ?? caseId}`);

      // ★ 换货补发的「运输属性继承」要用**非默认属性**的原票才能验：
      //   若原票就是 `Sea`/`Export`（= 无原票时的默认值），继承坏了也照样通过 ⇒ 断言是空的。
      const srcShip = await api(admin, 'POST', '/api/v1/shipping', {
        type: 'Export', shippingMethod: 'Air', status: 'Booked',
        orderId: ORD_A, customerRelationId: REL_ID, customerName: `DRILL 变异演练客户 ${TS}`,
        consigneeName: `DRILL 继承用收货人 ${TS}`,
        notes: `${MARK} V4 继承用原票（非默认运输方式）`,
      });
      let srcShipId = null;
      if (srcShip.status === 201 && srcShip.data?.id) {
        srcShipId = srcShip.data.id;
        created.shipmentIds.push(srcShipId);
        pass('建「继承用原票」（非默认属性）', `shippingMethod=Air · consigneeName=${srcShip.data.consigneeName ?? '(未回显)'}`);
      } else {
        gap('建继承用原票未通过', `HTTP ${srcShip.status} ${srcShip.text.slice(0, 160)}`);
      }

      const runDisposition = async (label, body, execBody, artifactKey) => {
        const add = await api(admin, 'POST', `/api/v1/claims/${encodeURIComponent(caseId)}/dispositions`, body);
        if (add.status !== 201 || !add.data?.disposition?.id) {
          gap(`${label}：加处置未通过`, `HTTP ${add.status} ${add.text.slice(0, 200)}`);
          return;
        }
        const dispId = add.data.disposition.id;
        created.dispositionIds.push(dispId);
        const appr = await api(admin, 'POST', `/api/v1/claims/dispositions/${encodeURIComponent(dispId)}/approve`, {});
        if (appr.status !== 200) { gap(`${label}：审批未通过`, `HTTP ${appr.status} ${appr.text.slice(0, 160)}`); return; }
        const exec = await api(admin, 'POST', `/api/v1/claims/dispositions/${encodeURIComponent(dispId)}/execute`, execBody);
        if (exec.status !== 200) {
          gap(`${label}：执行未通过`, `HTTP ${exec.status} ${exec.text.slice(0, 220)}`);
          return;
        }
        const art = exec.data?.[artifactKey] ?? exec.data?.data?.[artifactKey];
        if (art?.id) {
          if (artifactKey === 'returnReceipt') created.returnReceiptIds.push(art.id);
          if (artifactKey === 'repairWorkOrder') created.repairWorkOrderIds.push(art.id);
          if (artifactKey === 'replacementShipment') created.shipmentIds.push(art.id);
          pass(`★ ${label}：执行成功并产出 ${artifactKey}`, art.id);
        } else {
          gap(`${label}：执行返回成功但未带 ${artifactKey}`, JSON.stringify(exec.data).slice(0, 180));
        }
        return art; // ★ 返回产物，供调用方做**更深**的断言（否则「产物存在」= 弱断言）
      };

      // ① ReturnRefund（动钱 + 动货）：需 amount+currency+quantity+unit+returnDisposition，执行需 warehouseId
      await runDisposition('退货退款', {
        kind: 'ReturnRefund', amount: 400, currency: 'USD', quantity: 50, unit: 'M',
        returnDisposition: 'Scrap', notes: `${MARK} 退货退款`,
      }, { warehouseId: WAREHOUSE, notes: `${MARK} 退入主仓` }, 'returnReceipt');

      // ② Replace（只动货）：需 quantity+unit+returnDisposition；执行可带 sourceShipmentId
      //    ★ 断言**继承**（不只是「产物存在」）：原票是非默认属性 ⇒ 能区分「真继承」与「取默认值」
      const replShip = await runDisposition('换货补发', {
        kind: 'Replace', quantity: 30, unit: 'M', returnDisposition: 'Replace', notes: `${MARK} 换货补发`,
      }, { sourceShipmentId: srcShipId, notes: `${MARK} 补发出运` }, 'replacementShipment');
      if (replShip?.id) {
        const inheritOk = replShip.shippingMethod === 'Air'
          && replShip.customerRelationId === REL_ID
          && String(replShip.consigneeName ?? '') === `DRILL 继承用收货人 ${TS}`;
        if (inheritOk) {
          pass('★ 换货补发**继承原票运输属性**（非默认值 ⇒ 能区分真继承与取默认）',
            `shippingMethod=${replShip.shippingMethod} consignee=${replShip.consigneeName} customer=${replShip.customerRelationId}`);
        } else {
          fail('★ 换货补发未继承原票属性',
            `shippingMethod=${replShip.shippingMethod}（期望 Air）· consignee=${replShip.consigneeName}（期望「DRILL 继承用收货人 ${TS}」）· customer=${replShip.customerRelationId}`);
        }
        const notesOk = String(replShip.notes ?? '').includes('客诉');
        if (notesOk) pass('★ 补发运单带来源标记（否则在运单列表里与正常运单无法区分）', String(replShip.notes).slice(0, 60));
        else fail('★ 补发运单缺来源标记', `notes=「${replShip.notes}」`);
      }

      // ③ Repair（只动货）：需 quantity+unit+returnDisposition；执行需 workStationId
      await runDisposition('返修', {
        kind: 'Repair', quantity: 20, unit: 'M', returnDisposition: 'Repair', notes: `${MARK} 返修`,
      }, { workStationId: WORKSTATION, notes: `${MARK} 派工到裁剪台` }, 'repairWorkOrder');
    }
  } catch (e) {
    fail('演练脚本异常', String(e?.stack ?? e).slice(0, 500));
  } finally {
    await rollback();
    // ★ 全模型**沉淀式**兜底清扫：手写清单必然漏（事件总线扇出 notification/agentJob、
    //   建单初始化 productionStage、处置动作衍生单据），且**总线是异步投递的**
    //   ⇒ 清一次还会剩（实测剩 notification +150 / agentJob +3）⇒ 等沉淀、多轮清。
    //   ★ markers 除业务标识外还要带**演练生成的实际 id**（订单 id 不含业务标识
    //     ⇒ 只按标识扫会漏掉 `productionStage.orderId` 这类**间接引用**）。
    const sweepMarkers = [MARK, ...allIds()].filter(Boolean);
    const cleaned = await settleAndClean({ prisma, Prisma: PrismaRef, markers: sweepMarkers, log: console.log });
    if (cleaned.deleted > 0) {
      console.log(`     · 全模型兜底清扫共补删 ${cleaned.deleted} 行（手写清单漏掉的）：${JSON.stringify(cleaned.byModel)}`);
    }
    const hits = await sweepResidue({ prisma, Prisma: PrismaRef, markers: sweepMarkers });
    // ★ 2026-09-29 修正（同 payr-atomicity-live）：`hits` 含着 count=0 的行（族扫描下界>0 也进），
    //   判残留要看**计数**不是数组长度（lib 的 residueVerdict 在 v3.48 已改对，本处是内联写法没跟上）。
    const realHits = hits.filter((h) => Number(h && h.count) > 0);
    if (realHits.length === 0) pass('零残留复核（**全模型**扫描）', '演练标识命中 0');
    else fail('零残留复核（**全模型**扫描）', realHits.map((h) => `${h.model}=${h.count}`).join(' · '));
    await prisma.$disconnect().catch(() => {});

    const ok = results.filter((r) => r.ok === true).length;
    const bad = results.filter((r) => r.ok === false).length;
    const gaps = results.filter((r) => r.ok === null).length;
    console.log(`\n══ 结果：${ok} 通过 / ${bad} 失败 / ${gaps} 缺口 ══`);
    if (gaps) console.log('   缺口明细：' + results.filter((r) => r.ok === null).map((r) => r.n).join(' · '));
    process.exit(bad === 0 ? 0 : 1);
  }
}

main().catch((e) => { console.error('脚本异常', e); process.exit(2); });
