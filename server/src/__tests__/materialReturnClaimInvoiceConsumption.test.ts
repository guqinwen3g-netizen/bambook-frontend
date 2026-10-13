/**
 * `MaterialReturn.claimInvoiceId` 消费点登记守卫（2026-09-17）
 *
 * 病灶：`confirmReturn` 在 `type='claim'` 时生成一张**负额 Payable 贷项票**
 *   （`CLM-YYYY-NNNN`，`amount = -Math.abs(...)`），并把票 id 回填到
 *   `MaterialReturn.claimInvoiceId`。但**全库没有任何「结清/冲销」动作消费它**：
 *     · 票自身永不 Paid（`recalcInvoiceStatus` 的判据是 `amount.gt(0) && …`）；
 *     · 任何正额核销被 400 拒（`AMOUNT_EXCEEDS_INVOICE`）；
 *     · `settleReturn` 只翻状态**不碰票**、`cancelReturn` 只允许 `pending`；
 *     · 手工 `PATCH Paid` 被 `STATUS_NOT_MANUAL_SETTABLE` 挡。
 *   ⇒ 作废是唯一出口，而作废后 `claimInvoiceId` **仍悬挂**、退换货单侧不联动。
 *   真库实测：`scripts/acceptance-credit-note-settlement-gap.ts` 的 S5b（账实不符）。
 *   完整结论见 `docs/handoff-20260917-094000.md` §一 / §四。
 *
 * 本文件**不修复**缺陷，而是把现状钉死 + **强制登记**：
 *   1. 该字段在 schema 里是**裸 `String?`（无 `@relation`）** ⇒ 无级联、无引用完整性，
 *      生命周期**只能靠人管** —— 这就是必须有登记守卫的根因；
 *   2. `server/src` 里每个**读**该字段的非测试文件都必须在 `REGISTRY` 里登记，
 *      并声明它的**角色**（封闭词汇表）——新增读点不登记就红；
 *   3. ★ `SETTLE_GAP_OPEN` 双向绊线：缺口开着时断言「结清类消费点 = 0」；
 *      谁补上口径 11/12 加了结清路径，必须回来把开关翻成 `false`，
 *      届时断言反过来要求「结清类消费点 ≥ 1」。
 *      ⇒ 既防止「建了没人管」，也防止「修完了没人知道」。
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // server/src/__tests__
const SRC = path.resolve(HERE, '..'); // server/src
const SCHEMA = path.resolve(SRC, '..', 'prisma', 'schema.prisma');

/** 角色词汇表（封闭集）——新增角色必须先想清楚它属于哪一类，别硬塞 */
const ROLES = ['produce', 'notify', 'settle', 'reconcile', 'release'] as const;
type Role = (typeof ROLES)[number];

interface Consumer {
  file: string;
  role: Role;
  note: string;
}

/**
 * ★ 登记表 —— 改代码时**必须同步改这里**，否则守卫红。
 * 只登记「读」该字段的文件；纯写（如 service 内部回填）也登记为 produce。
 */
const REGISTRY: Consumer[] = [
  {
    file: 'workflow/workflowInvoiceSource.ts',
    role: 'reconcile',
    note: '通用工作流沿实际 claimInvoiceId 与原确认审计回查退料、收料、采购单和供应商；拒绝不唯一、失效或金额币种不一致来源，不改变原生结算状态',
  },
  {
    file: 'finance/supplierClaimSettlementGuard.ts',
    role: 'reconcile',
    note: '锁定实际 claimInvoiceId 来源；财务更正失去足额有效核销时同事务追加审计并重开当前结算投影，保留历史事实',
  },
  {
    file: 'finance/supplierClaimInvoiceRelease.ts',
    role: 'release',
    note: '作废当前负额 Payable 时严格校验来源并释放当前 claimInvoiceId 投影，保留历史确认与作废审计；不结清贷项',
  },
  {
    file: 'procurement/materialReturnService.ts',
    role: 'settle',
    note: 'confirmReturn 生成负额 Payable；settleReturn 在同一事务校验原收料、供应商、确认审计、贷项和实际收款核销后结清；缺乏事实不得结案',
  },
  {
    file: 'procurement/procurementRoute.ts',
    role: 'notify',
    note: 'confirm 端点把 id 交给 onDataChange 做缓存失效（entity=Invoice, action=create）——不改变生命周期',
  },
];

/**
 * ★ 已知缺口开关。
 * 口径 11（供应商索赔怎么结清）/ 口径 12（撤销索赔流程）落地后，
 * 把这里改成 `false`，并在 REGISTRY 里补上 `settle` 角色的消费点。
 */
// Native supplierClaimSettlementRealDb coverage verifies the settlement path.
const SETTLE_GAP_OPEN = false;

/** 递归扫描 server/src（跳过测试与 node_modules）里提及该字段的 .ts 文件 */
function scanReaders(): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === '__tests__' || ent.name === 'node_modules' || ent.name === 'dist') continue;
        walk(abs);
      } else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.test.ts')) {
        if (fs.readFileSync(abs, 'utf8').includes('claimInvoiceId')) {
          hits.push(path.relative(SRC, abs).split(path.sep).join('/'));
        }
      }
    }
  };
  walk(SRC);
  return hits.sort();
}

describe('★ 结构守卫：claimInvoiceId 消费点必须登记', () => {
  it('扫描到的读点集合 === 登记集合（双向：漏登记红 / 登记了却已删也红）', () => {
    const scanned = scanReaders();
    const registered = REGISTRY.map((r) => r.file).sort();
    expect(scanned).toEqual(registered);
  });

  it('登记项角色合法（封闭词汇表）', () => {
    for (const c of REGISTRY) {
      expect(ROLES).toContain(c.role);
      expect(c.note.length).toBeGreaterThan(0);
    }
  });

  it('★ 绊线：缺口开着时不得有「结清/冲销」类消费点', () => {
    const settleLike = REGISTRY.filter((r) => r.role === 'settle' || r.role === 'reconcile');
    if (SETTLE_GAP_OPEN) {
      // 缺口仍开 ⇒ 结清路径不该存在；若这里红了，说明有人加了结清路径
      // → 请把 SETTLE_GAP_OPEN 翻成 false 并在此处登记，别让缺口标记说谎。
      expect(settleLike).toEqual([]);
    } else {
      // 缺口已关 ⇒ 必须真的存在结清路径，否则就是「开关翻了但活没干」。
      expect(settleLike.length).toBeGreaterThan(0);
    }
  });

  it('★ 根因断言：schema 里该字段是裸 String?（无 @relation）⇒ 无级联，只能靠登记管', () => {
    const schema = fs.readFileSync(SCHEMA, 'utf8');
    const line = schema.split('\n').find((l) => /^\s*claimInvoiceId\s/.test(l));
    expect(line).toBeDefined();
    expect(line).toMatch(/^\s*claimInvoiceId\s+String\?/); // 可空字符串
    expect(line).not.toMatch(/@relation/); // ★ 没有真 FK ⇒ 删票不会级联清引用
  });
});

describe('★ 行为守卫：负额贷项票的已知状态机缺陷（回归即红）', () => {
  /**
   * 这两个断言把「死票」的两个判据钉住：一旦有人改了判据（例如让 `amount <= 0`
   * 视为开完即结清、或放宽核销守卫），这里会红 —— 提醒同步更新口径 11 的结论
   * 与 `docs/handoff-20260917-094000.md` §一，而不是悄悄改完。
   */
  it('recalcInvoiceStatus 的 Paid 判据仍带 amount.gt(0)（负额票永不 Paid 的根因）', () => {
    const src = fs.readFileSync(path.join(SRC, 'finance', 'allocationService.ts'), 'utf8');
    const fn = src.slice(src.indexOf('export async function recalcInvoiceStatus'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toMatch(/invoiceAmount\.gt\(0\)/);
  });

  it('applyAllocation 仍对超出票面额的核销返回 AMOUNT_EXCEEDS_INVOICE', () => {
    const src = fs.readFileSync(path.join(SRC, 'finance', 'allocationService.ts'), 'utf8');
    expect(src).toMatch(/AMOUNT_EXCEEDS_INVOICE/);
    // ⚠️ 2026-09-19 修（此守卫自负额票修复起一直是红的）：变量已由
    //    `invoiceAmount` 改名为 `invoiceBasis`（走 shared/invoiceSettlementBasis 的
    //    结清基准额 = |amount|，为支持负额贷项票），守卫没跟着改 ⇒ 恒红 ⇒ 被人忽略。
    //    钉住「超票面额必须拦」这件事本身，而不是某个变量名 —— 允许 basis 命名演进。
    expect(src).toMatch(/appliedAmountDecimal\.gt\(invoiceBasis\)/);
    expect(src).toContain('AMOUNT_EXCEEDS_INVOICE');
  });

  it('cancelReturn 仍只允许 pending（⇒ 作废是 confirmed 索赔的唯一出口）', () => {
    const src = fs.readFileSync(path.join(SRC, 'procurement', 'materialReturnService.ts'), 'utf8');
    const fn = src.slice(src.indexOf('cancelReturn'));
    expect(fn).toMatch(/pending/);
  });
});
