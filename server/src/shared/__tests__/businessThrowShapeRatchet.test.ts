// V1 2026-10-01: restore typed business errors across development, samples, procurement and finance;
// original 149-site census is historical. New alias-only writers were corrected, never grandfathered.
/**
 * §9 **B34** · 抛错只带 `code` 不带 `statusCode` ⇒ 会被"兜底文案"吞掉（计量棘轮，只减不增）
 *
 * 机理（一条**结构性陷阱**，不是某个域的个案）：
 *   `resolveError` 判"业务错误"的条件是 `code` 是 string **且** `statusCode` 是 number
 *   （`shared/errorCodes.ts` 的 `isBusinessError`）。只有 `code` 的抛错因此走**未预期分支**：
 *   状态由兜底码查表（查不到就 500），**文案换成兜底文案 ⇒ 服务层那句给用户看的中文校验提示消失**。
 *   而"把路由出口接到真源"这个动作（§9 B22 的收敛）恰恰会让这类抛错第一次经过这条分支
 *   ⇒ **收敛一个域之前，必须先确认该域的抛点带不带 `statusCode`**，否则收口 = 悄悄改坏提示文案。
 *
 * 本批（第 6 域 samples）实测撞到的就是这个形状 ⇒ 记 B34。
 *
 * ★ **本条判据自己的第 1 次误判（2026-09-20 15:20，由独立复核抓到）**：
 *   初版用正则 `Object\.assign\(\s*new Error\([\s\S]{0,240}?\),\s*\{([^}]*)\}\s*\)`，
 *   它**整类漏**两种常见写法：① 属性对象里出现任何 `}`（嵌套对象、`...(cond ? { a: 1 } : {})`）；
 *   ② 实参列表带**尾逗号**（`{…},\n)`）—— `\s*\)` 直接失配。
 *   后果：**基线 121 处 / 31 文件是虚低的**，实测应为 **149 处 / 33 文件**（最大单文件
 *   `shipping/allocationService.ts` 7 → 21）。虚低比虚高更阴 —— 它不会让任何一次"清了一批"看起来失败，
 *   只会让**剩下 28 处从来没进过账**。判据已换成括号配对扫描（`scripts/lib/errorDebtScanners.mjs` 的 `b34Sites`，
 *   与度量脚本共用同一份 ⇒ 两处不可能再给出两个数）。
 *
 * **本文件只计量、不判定可达性**：
 *   计数口径 = 同一文件内 `Object.assign(new Error(…), { … })` 且最后一个实参里没有 `statusCode`。
 *   ⚠️ **盲区（必须写出来，别把计量当结论）**：
 *     ① 这些抛点里有很多被**服务自己的 catch** 转成 `{ok:false, error:{code,message}}` 返回值，
 *        根本走不到路由 ⇒ 不构成缺陷；但"哪些走不到"要按调用链逐处核，文本判据核不出来；
 *        （15:20 独立复核已逐处核过**已收敛的五域**：结论 = **无回归**，全部被服务层 catch 吸收，
 *         且收敛过的出口是逐字打印 `result.error.message`。另记三处"假安全"进 §9 B34 处置栏。）
 *     ② `httpStatus` 等别名**照样计入** —— 这是对的：`isBusinessError` 只认 `statusCode`，写别名同样是缺陷；
 *     ③ 自定义 Error 子类里带 statusCode 的看不见（只扫 `Object.assign` 形状）。
 *
 * 基线取样：2026-09-20 15:35（判据修正后重测）⇒ **33 个文件 / 149 处**。只许减不许增。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { b34Sites, countByFile, scanSources, stripComments } from '../../../scripts/lib/errorDebtScanners.mjs';
import { classifyPrivateSymbolRefusals } from '../../../../scripts/lib/tierMessageSources.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..', '..', '..');

/** 初版那条**会漏数**的正则，只为反面对照留在测试里（生产判据是 lib 的 b34Sites）。 */
const LEGACY_ASSIGN_RE = /Object\.assign\(\s*new Error\([\s\S]{0,240}?\),\s*\{([^}]*)\}\s*\)/g;
const legacyCount = (s: string) => [...s.matchAll(LEGACY_ASSIGN_RE)].filter((m) => !/\bstatusCode\b/.test(m[1])).length;
// A private marker is not a public code-only business error. It is classified
// separately only when the actual finite producer AND catch consumer are proved.
// Any incomplete/changed witness remains in the old debt inventory and cap.
const debtSites = (src: string) => {
  const internal = new Set(classifyPrivateSymbolRefusals(src).map((site: { index: number }) => site.index));
  return b34Sites(src).filter((site: { index: number }) => !internal.has(site.index));
};
const legacyDebtCount = (src: string) => {
  const internal = new Set(classifyPrivateSymbolRefusals(src).map((site: { index: number }) => site.index));
  return [...src.matchAll(LEGACY_ASSIGN_RE)]
    .filter(match => !/\bstatusCode\b/.test(match[1]) && !internal.has(match.index!)).length;
};

/** 旧正则整类漏掉的两种真实形状（逐字取自本仓，见下面那条对照用例） */
const MISSED_SHAPES = [
  // ① 尾逗号：`{ … },\n)` —— `\s*\)` 失配
  "throw Object.assign(new Error('已出运，不能再改'), {\n  code: 'SHIPMENT_ALREADY_SHIPPED',\n},);",
  // ② 对象里带嵌套 `}` —— `[^}]*` 截断
  "throw Object.assign(new Error('价差超限'), { code: 'PRICE_DEVIATION_BLOCKED', ...(x.ok ? { id: 1 } : {}) });",
];

function countByFileHere(): Record<string, number> {
  return countByFile(scanSources(SERVER), debtSites) as Record<string, number>;
}

/**
 * 冻结基线（2026-09-20 15:35 实测，33 个文件全量）。给抛点补上 `statusCode` 就删掉那一行并同步改小总数。
 * ⚠️ 这张表初版只写了前 14 大 ⇒ 守卫当场把另外 17 个报成"新长出"（**虚报，不是缺陷**）：
 *    总数与文件数一开始就对得上，是明细不全。**报"某文件涨了"之前必须先核对明细是否全量** —— 已写在这里防下次再犯。
 */
const BASELINE: Record<string, number> = {
  'src/agent/emailReplySendFlow.ts': 1,
  'src/agent/invoiceIssueFlow.ts': 1,
  'src/agent/reconcileFlow.ts': 1,
  // Native issue/create/update now carry typed errors; retired four actual sites.
  'src/credit/bankruptcyService.ts': 1,
  'src/email/emailOutboxMutationService.ts': 5,
  'src/email/emailSyncService.ts': 2,
  'src/finance/fxSettlementService.ts': 6,
  'src/finance/outwardRemittanceService.ts': 6,
  'src/finance/vatInvoiceService.ts': 17,
  'src/finance/writeOffService.ts': 9,
  'src/internalTrade/internalTransferService.ts': 1,
  'src/inventory/stockOwnershipService.ts': 3,
  'src/mes/processChainService.ts': 4,
  'src/orderChanges/orderChangeRequestService.ts': 2,
  'src/orders/toleranceCore.ts': 2,
  'src/qc/testRequestService.ts': 6,
  'src/quotations/quotationService.ts': 2, // two native typed refusals retired; remaining two stay debt.
  'src/relations/relationMutationService.ts': 1,
  'src/reporting/reportDefinitionService.ts': 6,
  'src/samples/colorBatchService.ts': 10,
  'src/samples/colorCardService.ts': 1,
  'src/samples/sampleLengthService.ts': 1,
  'src/shipping/allocationService.ts': 21,
  'src/shipping/shipmentPackingService.ts': 10,
  'src/suppliers/tcCertificateService.ts': 3,
};

describe('B34 · 抛点缺 statusCode 的计量（只减不增）', () => {
  const actual = countByFileHere();

  it('★ 总数与文件数等于基线；任一文件涨了当场红', () => {
    const total = Object.values(actual).reduce((a, b) => a + b, 0);
    // Fixed c9ab5189: original toolRuntime four and quotationService two
    // retired; new quotationApproval/packing sites were fixed in production,
    // never grandfathered. Original scanner and every negative control remain.
    expect(total, `全仓公开「抛点缺 statusCode」总数（固定 c9ab5189 来源复核）`).toBe(122);
    expect(Object.keys(actual).length, '含此类抛点的文件数').toBe(25);
    const grew = Object.entries(actual)
      .filter(([f, n]) => (BASELINE[f] ?? 0) < n)
      .map(([f, n]) => `${f}: 基线 ${BASELINE[f] ?? 0} → 实际 ${n}`);
    expect(grew, `新长出缺 statusCode 的抛点（收敛过的域里它会吞掉用户文案）：${JSON.stringify(grew)}`).toEqual([]);
    const stale = Object.entries(BASELINE)
      .filter(([f, n]) => (actual[f] ?? 0) < n)
      .map(([f, n]) => `${f}: 基线 ${n} → 实际 ${actual[f] ?? 0}`);
    expect(stale, `补过 statusCode 就同步删掉那一行（留旧数会掩盖下一次回潮）：${JSON.stringify(stale)}`).toEqual([]);
  });

  it('★ 判据修正的正反对照：旧正则漏的两种形状，新判据必须数到', () => {
    for (const src of MISSED_SHAPES) {
      expect(legacyCount(src), `旧正则应当漏掉这一形（否则本对照没有意义）：${src}`).toBe(0);
      expect(b34Sites(src).length, `新判据必须数到：${src}`).toBe(1);
    }
    // 全仓差额 = 判据修正捞回来的量。这个数字本身要能被证伪：它必须**等于**逐文件明细之和的差。
    const legacyTotal = scanSources(SERVER)
      .reduce((sum, { src }) => sum + legacyDebtCount(src), 0);
    expect(legacyTotal, '固定 c9ab5189 旧正则数99，原判据数122（虚低23）；历史100/128保留在来源证据').toBe(99);
    expect(122 - legacyTotal, '虚低量必须显式记账，不能悄悄换基线').toBe(23);
  });

  it('双向对照：带 code 没 statusCode 算、补齐了不算、注释里不算', () => {
    const bad = "throw Object.assign(new Error('非法疵点原因：X'), { code: 'INVALID_DEFECT_CAUSES' });";
    const good = "throw Object.assign(new Error('非法疵点原因：X'), { code: 'INVALID_DEFECT_CAUSES', statusCode: 400 });";
    expect(b34Sites(bad)).toHaveLength(1);
    expect(b34Sites(good)).toHaveLength(0);
    expect(b34Sites(stripComments("// throw Object.assign(new Error('x'), { code: 'C' });"))).toHaveLength(0);
    // 别名不算（`httpStatus` 走不到 isBusinessError ⇒ 同样是缺陷，必须计入）
    expect(b34Sites("throw Object.assign(new Error('x'), { code: 'C', httpStatus: 400 });")).toHaveLength(1);
    // 判据可被满足：唯一能让它变绿的动作就是补 statusCode（上面 good 那条已证）
    // 反向自检：判据不能恒不匹配（恒不匹配会让上面那条"只减不增"永远绿）
    expect(Object.keys(actual).length, '基线为空 = 没有守卫').toBeGreaterThan(0);
  });

  it('★ 真源文件自己就是这条判据的正面样本：isBusinessError 要的是两件套', async () => {
    const { resolveError } = await import('../errorCodes');
    // 只带 code ⇒ 走未预期分支 ⇒ 文案被换掉（这就是 B34 的后果，不是设想）
    const onlyCode = resolveError(Object.assign(new Error('非法疵点原因：X'), { code: 'INVALID_DEFECT_CAUSES' }), 'FEEDBACK_FAILED');
    expect(onlyCode.code).toBe('FEEDBACK_FAILED');
    expect(onlyCode.message, '服务层那句中文校验提示在这里被兜底文案顶掉').not.toContain('非法疵点原因');
    // 两件套齐全 ⇒ 原样透传
    const both = resolveError(Object.assign(new Error('非法疵点原因：X'), { code: 'INVALID_DEFECT_CAUSES', statusCode: 400 }), 'FEEDBACK_FAILED');
    expect(both.status).toBe(400);
    expect(both.message).toContain('非法疵点原因');
  });
});

describe('B34 · 私有事务拒绝单独登记，不增加公共债务 cap', () => {
  const source = () => fs.readFileSync(path.join(SERVER, 'src/agent/commitTransaction.ts'), 'utf8');
  const witness = () => {
    const sites = classifyPrivateSymbolRefusals(source(), 'src/agent/commitTransaction.ts');
    expect(sites).toHaveLength(1);
    return sites[0];
  };
  const copies = [
    ['ORDER_NOT_FOUND', '订单不存在或已删除，请核对订单后重新办理。'],
    ['STATUS_DRIFT', '订单状态已变化，请刷新后重新确认。'],
    ['INVOICE_AMOUNT_INVALID', '发票金额必须为正数，请先核对订单金额。'],
    ['INVOICE_CURRENCY_MISSING', '发票币种未填写，请先完善订单币种。'],
  ] as const;
  it('完整内部库存只有已核定的一站；原始计量仍等于公共债务加内部库存', () => {
    const entries = scanSources(SERVER);
    const internal = entries.flatMap(({ rel, src }) => classifyPrivateSymbolRefusals(src, rel)
      .map((site: { keys: string[]; producer: string }) => ({ file: rel, producer: site.producer, keys: site.keys })));
    expect(internal).toEqual([{ file: 'src/agent/commitTransaction.ts', producer: 'rejectOrderConfirm',
      keys: ['ORDER_NOT_FOUND', 'STATUS_DRIFT', 'INVOICE_AMOUNT_INVALID', 'INVOICE_CURRENCY_MISSING'] }]);
    const raw = entries.reduce((sum, entry) => sum + b34Sites(entry.src).length, 0);
    const debt = entries.reduce((sum, entry) => sum + debtSites(entry.src).length, 0);
    expect(raw).toBe(debt + 1); // preserves the new station in the total inventory
  });
  // Execute only the AST-extracted native sentinel producer/consumer. Formatter
  // and result metadata are supplied; no backend import, tool action or DB runs.
  function inspect(probeInput: Record<string, unknown>) {
    const site = witness();
    const snippet = `${site.setupSource}
      const poNumber='synthetic-po',approvalId='synthetic-approval';
      const draft={idempotencyKey:'synthetic-request',subOperations:[],impactScope:{}};
      const buildOrderConfirmError=(message:string)=>({message});
      function inspect(input:any){let error:any;
        if(input.kind==='native'){try{${site.producer}(input.code)}catch(caught){error=caught}}
        else if(input.kind==='unknown-key') error={[${site.symbol}]:'UNREGISTERED_REFUSAL'};
        else if(input.kind==='foreign-symbol') error={[Symbol('order-confirm-business-refusal')]:'ORDER_NOT_FOUND'};
        else error=input.error;
        ${site.consumerSource}
        return {recognized:false};
      }
      inspect(probeInput);`;
    const compiled = ts.transpileModule(snippet, { compilerOptions: { target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None } }).outputText;
    return vm.runInNewContext(compiled, { probeInput }, { timeout: 1000 });
  }
  it.each(copies)('本地标记 %s 只返回核定的失败/未提交公开文案', (code, copy) => {
    const result = inspect({ kind: 'native', code });
    expect({ ok: result.ok, committed: result.committed, error: result.error, retryable: result.errorFeedback.retryable })
      .toEqual({ ok: false, committed: false, error: `${code}: ${copy}`, retryable: false });
  });
  it.each(['unknown-key', 'foreign-symbol'] as const)('%s 不能经过有限消费者', kind => {
    expect(inspect({ kind }).recognized).toBe(false);
  });
  it('同文案/同公开 code 的未知 SQL 错不能伪造私有拒绝', () => {
    const error = Object.assign(new Error('订单不存在 SELECT private_orders'), { code: 'ORDER_NOT_FOUND', statusCode: 404 });
    expect(inspect({ kind: 'unknown-error', error }).recognized).toBe(false);
  });
  it('有限消费者被移除则不能扣除内部一站，原 debt 判断仍咬住', () => {
    const changed = stripComments(source()).replace('Object.prototype.hasOwnProperty.call(COMMIT_REFUSAL_COPY, refusal)', 'true');
    expect(classifyPrivateSymbolRefusals(changed)).toHaveLength(0);
    expect(debtSites(changed)).toHaveLength(b34Sites(changed).length);
  });
});

/**
 * §9 **B34 处置栏 · "为什么现在没炸"的三条前提守卫**（2026-09-20 15:20 独立复核逐处核可达性）
 *
 * 复核结论是"**无回归**"，但"无回归"依赖三件此刻成立、写代码时不一定成立的前提。
 * 本组用例把前提钉成**可证伪**：前提一旦破就红，红 = "重核这一条"，不是"你写错了"。
 * 这正是 R4-T2 负面用例该有的样子 —— 不是再数一遍抛点，而是把"为什么现在没炸"变成守卫。
 *
 * ⚠️ **复核结论本身也被复核掉一条**（15:40 实测）：R1 原话是"`assertConsolidationAllowed` 的三处中文抛点
 *   **零生产调用方**"。实际它在本文件内被 `createAllocation` 调 **2 次**（:506 / :527），只是**外部**没有消费者，
 *   而且那两个码在路由本地表里已经明写 409（`shipping/route.ts:752-753`）。
 *   ⇒ "没人用"这句不成立，这里改钉真正起作用的那两件（服务层 catch + 路由表已给 409）。
 *   教训：**"没人用 / 已废弃"这类断言，无论来自注释还是来自复核报告，都要自己搜过再说。**
 */
describe('B34 处置栏 · "无回归"依赖的前提', () => {
  const read = (rel: string) => stripComments(fs.readFileSync(path.join(SERVER, rel), 'utf8'));

  it('P1 合票抛点：被本文件服务层 catch 吸收，且两个码在路由本地表里已经是 409（不是 500）', () => {
    const svc = read('src/shipping/allocationService.ts');
    expect(/assertConsolidationAllowed\(t, shipmentId\)[\s\S]{0,1600}catch \(e: any\)/.test(svc),
      'createAllocation 里那层吸收用的 catch 不见了 ⇒ 这三处抛点会直接冲到路由').toBe(true);
    const route = read('src/shipping/route.ts');
    for (const code of ['CONSOLIDATION_CUSTOMER_MISMATCH', 'CONSOLIDATION_BUSINESS_LINE_MISMATCH']) {
      expect(new RegExp(`${code}:\\s*409`).test(route), `${code} 不再被答成 409 = 业务拒绝被降档`).toBe(true);
    }
  });

  it('P2 finance/allocationService 的两处抛点只靠**上游 code 白名单**兜住 ⇒ 白名单少了要重核', () => {
    const guard = read('src/finance/allocationMutationService.ts');
    const whitelist = (guard.match(/const PASSTHROUGH_ERROR_CODES = \[([\s\S]*?)\]/) ?? [])[1] ?? '';
    expect(whitelist, '白名单形状变了 ⇒ 本条前提要重核').not.toBe('');
    const codes = b34Sites(read('src/finance/allocationService.ts'))
      .map((h: { match: string }) => (h.match.match(/code:\s*'([A-Z0-9_]+)'/) ?? [])[1])
      .filter(Boolean);
    expect(codes, '原两处缺形状的不存在拒绝已补typed404，缺形状抛点不得回潮').toEqual([]);
    for (const code of ['INVOICE_NOT_FOUND', 'VOUCHER_NOT_FOUND']) {
      const service = read('src/finance/allocationService.ts');
      expect(service).toMatch(new RegExp(`code: '${code}', statusCode: 404`));
      expect(whitelist).toContain(`'${code}'`);
    }
    for (const c of codes) {
      expect(new RegExp(`'${c}'`).test(whitelist), `${c} 掉出白名单 ⇒ 会被兜成 CREATE_FAILED 并丢掉中文文案`).toBe(true);
    }
  });

  it('P3 shipping 有 9 个写端点只查 result.ok、**没有路由级 try** ⇒ 未被吸收的抛点会变未处理拒绝', () => {
    const route = read('src/shipping/route.ts');
    const bare: string[] = [];
    for (const m of route.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
      const body = route.slice(m.index ?? 0);
      const end = body.indexOf('\n  });');
      const seg = end > 0 ? body.slice(0, end) : body.slice(0, 2500);
      if (/result\.ok/.test(seg) && !/\btry\s*\{/.test(seg)) bare.push(`${m[1].toUpperCase()} ${m[2]}`);
    }
    // Keep the historical nine-site title; current source shape has eight.
    expect(bare, '端点形状变了 ⇒ "哪些端点裸奔"必须重核（其后果**未覆盖**：没有执行证据）').toEqual([
      'PUT /:id/lines', 'POST /:id/lines/pull-from-order', 'PUT /:id/cartons', 'POST /',
      'PATCH /:id', 'DELETE /:id', 'POST /:id/allocations', 'PATCH /:id/allocations/:allocId',
      // DELETE gained the actual modern-presence catch. Its legacy call is
      // outside that catch, but the native service absorbs storage exceptions.
      // This is textual-shape retirement, not proof that every exit is covered.
    ]);
  });
});
