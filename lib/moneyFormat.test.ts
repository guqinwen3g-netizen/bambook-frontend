/**
 * B255 · 全站金额展示的**第一份共享实现**（`lib/moneyFormat.ts`）—— 与 `lib/dateFormat.ts` 同一条矩
 *
 * 为什么要新开这一份而不是"再抄一份到索赔页"：台账 B255 当初**刻意不修**索赔页那三处裸值，
 * 理由写得很清楚——"再抄第 9 份＝把 B249 那族的病复制一次"。现在实测那份账的份数还是错的
 * （按名 `formatAmount` 12 份、三个名字合计 22 份，见 v3.203），所以更不能再添一份私有的。
 * 这一份是**收口的落点**：`PricingManager.formatMoney` 改为转调它（实现只有一份），
 * `ClaimManager` 那三处裸值也走它。　〔原写「其余 21 份私有实现本批不动」（v3.204）：
 * ★ v3.219 现量更正 —— 那一族按七个名字实为 **29 处定义落点**（真源 1 + 纯委托 1 + 仍自己实现 27，
 * 台账原先按三个名字数的 22 少报了 `fmtAmount` 5 处与 `formatPrice` 1 处）；本批把其中
 * **把"没值"兜成 0 的 4 处**收进真源，其余 23 处按四轴对照表逐档排期（表见
 * `docs/跨页数字一致-订单金额收口-2026-09-18.md` §八）。〕
 *
 * ★ 行为口径只有四条，全部可跑：① 千分位 + 两位小数；② 非零不足一分保留四位（不把"有"显示成 0）；
 *   ③ 空值（null/undefined/空串）→ `—`，**不 → 0**；④ 认不出的字符串**原样显示**——
 *   既不猜数也不吞成 0（G3：算不出来就不给数）。
 */
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { formatMoneyText, formatMoneySymbol, formatMoneyCodeAfter, formatSettlementMoneyText, formatUnitPriceCodeAfter } from './moneyFormat';

describe('unit price display preserves the recorded basis and existing amount rules', () => {
  it.each([
    ['Meter', 'm'], ['M', 'm'], ['米', 'm'], ['Yard', 'yd'], ['yd', 'yd'],
    ['码', 'yd'], ['Pcs', 'pc'], ['Piece', 'pc'], ['KG', 'kg'], ['Dozen', 'doz'],
    ['Roll', 'roll'], ['Set', 'set'], ['定制卷', '定制卷'], ['constructor', 'constructor'],
  ])('formats %s as %s without converting the amount', (unit, expected) => {
    expect(formatUnitPriceCodeAfter(10, 'USD', unit)).toBe(`10.00 USD/${expected}`);
  });
  it('does not invent missing units or currency, and retains zero, tiny prices and raw values', () => {
    expect(formatUnitPriceCodeAfter(0, 'USD', 'Yard')).toBe('0.00 USD/yd');
    expect(formatUnitPriceCodeAfter(1234.5678, 'USD', 'Meter')).toBe(`${formatMoneyCodeAfter(1234.5678, 'USD')}/m`);
    expect(formatUnitPriceCodeAfter(0.004, 'USD', 'Meter')).toBe('0.004 USD/m');
    expect(formatUnitPriceCodeAfter(10, 'USD', null)).toBe('10.00 USD');
    expect(formatUnitPriceCodeAfter(10, 'USD', '  ')).toBe('10.00 USD');
    expect(formatUnitPriceCodeAfter(10, null, 'Meter')).toBe('10.00/m');
    expect(formatUnitPriceCodeAfter(null, 'USD', 'Meter')).toBe('—');
    expect(formatUnitPriceCodeAfter('待核', 'USD', 'Meter')).toBe('待核');
  });
});

const CLAIM_SRC = readFileSync(new URL('../components/ClaimManager.tsx', import.meta.url), 'utf8');
const DUNNING_SHEET_SRC = readFileSync(new URL('../components/finance/DunningSheet.tsx', import.meta.url), 'utf8');
const DUNNING_BOARD_SRC = readFileSync(new URL('../components/finance/DunningStageBoardPanel.tsx', import.meta.url), 'utf8');
const PAYMENT_REQ_SRC = readFileSync(new URL('../components/finance/FinancePaymentRequestsPanel.tsx', import.meta.url), 'utf8');
const CRM_RELATION_SRC = readFileSync(new URL('../components/ui/crm/crmRelationSections.tsx', import.meta.url), 'utf8');
const COMMISSION_SRC = readFileSync(new URL('../components/order/OrderCommissionSection.tsx', import.meta.url), 'utf8');
const FORWARD_FX_SRC = readFileSync(new URL('../components/finance/ForwardFxSection.tsx', import.meta.url), 'utf8');
const PROCUREMENT_SRC = readFileSync(new URL('../components/ProcurementManager.tsx', import.meta.url), 'utf8');
const QUOTATION_SRC = readFileSync(new URL('../components/QuotationManager.tsx', import.meta.url), 'utf8');
const SUPPLIER_INQUIRY_SRC = readFileSync(new URL('../components/SupplierInquiryPanel.tsx', import.meta.url), 'utf8');
const CRM_MANAGER_SRC = readFileSync(new URL('../components/CrmManager.tsx', import.meta.url), 'utf8');
const COCKPIT_SRC = readFileSync(new URL('../components/CockpitManager.tsx', import.meta.url), 'utf8');
const FIN_MGR_SRC = readFileSync(new URL('../components/FinanceManager.tsx', import.meta.url), 'utf8');
const BILLING_SRC = readFileSync(new URL('../components/finance/BillingItemsPanel.tsx', import.meta.url), 'utf8');
const CASH_CAL_SRC = readFileSync(new URL('../components/finance/CashCalendarPanel.tsx', import.meta.url), 'utf8');
const CREDIT_SRC = readFileSync(new URL('../components/finance/FinanceCreditPanel.tsx', import.meta.url), 'utf8');
const REPORTS_SRC = readFileSync(new URL('../components/finance/FinanceReportsPanel.tsx', import.meta.url), 'utf8');
const RECON_SRC = readFileSync(new URL('../components/finance/ReconciliationPanel.tsx', import.meta.url), 'utf8');
const PROC_CHAIN_SRC = readFileSync(new URL('../components/mes/OrderProcessChainPanel.tsx', import.meta.url), 'utf8');

describe('B255 · 共享金额格式化（lib/moneyFormat）', () => {
  it('settlement maxima retain all meaningful database decimals, including the largest amount', () => {
    expect(formatSettlementMoneyText('12.9999')).toBe('12.9999');
    expect(formatSettlementMoneyText('99999999999999.1234', 'USD')).toBe('USD 99,999,999,999,999.1234');
    expect(formatSettlementMoneyText('0.0001')).toBe('0.0001');
    expect(formatSettlementMoneyText('5.1200')).toBe('5.12');
    expect(formatSettlementMoneyText(0)).toBe('0.00');
    expect(formatSettlementMoneyText(null)).toBe('—');
  });
  it('① 千分位 + 两位小数：Prisma Decimal 串和 number 走同一条路', () => {
    expect(formatMoneyText('1305.0000')).toBe('1,305.00');
    expect(formatMoneyText('1305')).toBe('1,305.00');
    expect(formatMoneyText(1305)).toBe('1,305.00');
    expect(formatMoneyText(97348.8576)).toBe('97,348.86');
    expect(formatMoneyText(0)).toBe('0.00');
    expect(formatMoneyText(-1234.5)).toBe('-1,234.50');
  });

  it('② 非零不足一分不许显示成 0.00（"有"不能报成"没有"）', () => {
    expect(formatMoneyText(0.004)).toBe('0.004');
    expect(formatMoneyText('0.004')).toBe('0.004');
    expect(formatMoneyText(-0.0002)).toBe('-0.0002');
  });

  it('③ 空值一律 `—`，且**不得**退化成 0 / "0.00" / "null"', () => {
    for (const v of [null, undefined, '']) {
      const out = formatMoneyText(v as number | string | null | undefined);
      expect(out).toBe('—');
      expect(out).not.toBe('0.00');
      expect(out).not.toBe('0');
    }
  });

  it('④ 认不出的写法原样上屏：不猜数、不吞成 0（G3"算不出就不给数"）', () => {
    expect(formatMoneyText('待核')).toBe('待核');
    expect(formatMoneyText('12,3')).toBe('12,3');
    expect(formatMoneyText(NaN)).toBe('—');   // 计算出来的坏数：走空态，不显示 NaN
  });

  it('币种前缀是可选的，且不能挤掉千分位', () => {
    expect(formatMoneyText(1234.5, 'USD')).toBe('USD 1,234.50');
    expect(formatMoneyText(null, 'USD')).toBe('—');
  });

  it('★ 落点证人：索赔页那三处裸值必须已经改走这一份（不是"某处用了"而是"裸插值没了"）', () => {
    expect(CLAIM_SRC, '原额 那格仍是裸值').not.toMatch(/原额 \{n\.amount\}/);
    expect(CLAIM_SRC, '未核销 那格仍是裸值').not.toMatch(/未核销 \{n\.openAmount\} \{n\.currency\}/);
    expect(CLAIM_SRC, '退 … 那格仍是裸值').not.toMatch(/退 \{d\.amount\} \{d\.currency\}/);
    expect(CLAIM_SRC).toMatch(/from '\.\.\/lib\/moneyFormat'/);
    expect((CLAIM_SRC.match(/formatMoneyText\(/g) ?? []).length, '三处都要过一遍').toBeGreaterThanOrEqual(3);
  });

  it('★ 反向：这一份**不许**被当成单价格式化器（单价那族刻意 4 位，见 B255）', () => {
    // 单价若进来，1.2345 会被压成 1.23 —— 那是另一种"把数改了"
    expect(formatMoneyText(1.2345)).toBe('1.23');
    const unitPriceSites = CLAIM_SRC.match(/formatMoneyText\([^)]*[Uu]nitPrice/g) ?? [];
    expect(unitPriceSites.length, '索赔页若有单价格走了这份实现要单独复核').toBe(0);
  });
});

describe('v3.219 · 第二出口 formatMoneySymbol（符号在前那一族），四条口径与真源同源', () => {
  it('① 千分位 + 两位小数 + 符号在前：与三处催款/收款屏面原本的形状一致', () => {
    expect(formatMoneySymbol(1041444.5, 'CNY')).toBe('¥1,041,444.50');
    expect(formatMoneySymbol('1305.0000', 'USD')).toBe('$1,305.00');
    expect(formatMoneySymbol(-5, 'CNY')).toBe('¥-5.00');   // 符号仍在负号前（沿用那三处的既有形状）
    expect(formatMoneySymbol(0, 'CNY')).toBe('¥0.00');      // 真有 0 还是要写 0.00，不许看成空
    expect(formatMoneySymbol(1234.5, 'EUR')).toBe('€1,234.50');   // ★ v3.222 补：三个币种码各有一格断言（突变 P5 摘掉 EUR 时曾 39 例全绿）
    expect(formatMoneySymbol(-5, 'EUR')).toBe('€-5.00');
  });

  it('③★ 空值/坏数一律 `—`，**不得**回落成 `¥0.00`（这一刀就是本批改屏面的那一条）', () => {
    for (const v of [null, undefined, NaN, ''] as const) {
      const out = formatMoneySymbol(v, 'CNY');
      expect(out, `空值 ${String(v)} 被渲染成 ${out}`).toBe('—');
      expect(out).not.toContain('0');
    }
    // 计算出来的坏数（Number(undefined) ⇒ NaN）也走空态：那三处原来是 `Number(n || 0)` ⇒ ¥0.00
    expect(formatMoneySymbol(Number(undefined), 'CNY')).toBe('—');
  });

  it('② 非零不足一分保留四位：与第一出口同一条矩（不许两份实现各有各的小数规则）', () => {
    expect(formatMoneySymbol(0.004, 'CNY')).toBe('¥0.004');
  });

  it('④ 认不出的串原样上屏，且**不加符号**（加了就是把"待核"伪装成一笔钱）', () => {
    expect(formatMoneySymbol('待核', 'CNY')).toBe('待核');
    expect(formatMoneySymbol('12,3', 'USD')).toBe('12,3');
  });

  it('币种缺码与陌生码：缺码只出数字，陌生码原样带空格前缀（不是把 JPY 悄悄换成符号）', () => {
    expect(formatMoneySymbol(1234.5)).toBe('1,234.50');
    expect(formatMoneySymbol(1234.5, null)).toBe('1,234.50');
    expect(formatMoneySymbol(1234.5, 'JPY')).toBe('JPY 1,234.50');
  });
});

/**
 * 一处判定，两处消费：既判四份真文件，也判"把缺陷放回去"的那份拷贝。
 * 若判据与对照各写各的，对照就成了对我自己那句话的复读（恒真），抓不到任何东西。
 */
function convergesToSharedSource(src: string, alias: string, decl: RegExp): boolean {
  const importRe = new RegExp(`import \\{ formatMoneySymbol as ${alias} \\} from '\\.\\./\\.\\./lib/moneyFormat'`);
  if (decl.test(src)) return false;            // 私有实现还在 ⇒ 它会顶掉 import，真源变死码
  if (!importRe.test(src)) return false;       // 没接到真源
  if (/Number\(n \|\| 0\)/.test(src)) return false;   // 兜 0 的写法仍在
  if ((src.match(new RegExp(`${alias}\\(`, 'g')) ?? []).length < 2) return false;  // import 了没人调
  return true;
}

describe('v3.219 · 四处"没值兜成 0"的屏面必须真的走真源（落点在活路径上，不是死码）', () => {
  const SITES = [
    { name: '催款函 DunningSheet', src: DUNNING_SHEET_SRC, alias: 'formatMoney', decl: /function formatMoney\(/ },
    { name: '催款看板 DunningStageBoardPanel', src: DUNNING_BOARD_SRC, alias: 'formatAmount', decl: /function formatAmount\(/ },
    { name: '收款申请 FinancePaymentRequestsPanel', src: PAYMENT_REQ_SRC, alias: 'formatAmount', decl: /function formatAmount\(/ },
  ];

  for (const s of SITES) {
    it(`${s.name}：私有实现已删、真源已 import、调用点解析到那份 import`, () => {
      expect(convergesToSharedSource(s.src, s.alias, s.decl),
        '判据：私有函数还在 / 没 import 真源 / 仍写 Number(n || 0) / import 了没人调').toBe(true);
    });
  }

  it('★ 能红的对照：把当年那句私有实现原样塞回 DunningSheet，同一把尺必须判 false', () => {
    const restored = DUNNING_SHEET_SRC + '\nfunction formatMoney(n: number, currency: string): string {\n'
      + '  const sym = currency === \'CNY\' ? \'¥\' : currency;\n'
      + '  return `${sym}${Number(n || 0).toLocaleString()}`;\n}\n';
    expect(convergesToSharedSource(restored, 'formatMoney', /function formatMoney\(/), '缺陷放回去却没被抓到').toBe(false);
    // 只删 import 不补私有实现（另一种"退回"）也要被抓到
    const noImport = DUNNING_SHEET_SRC.replace("import { formatMoneySymbol as formatMoney } from '../../lib/moneyFormat';", '');
    expect(convergesToSharedSource(noImport, 'formatMoney', /function formatMoney\(/), '没接真源却没被抓到').toBe(false);
  });

  it('CRM 额度那格：一行转调真源，兜 0 与"不补零"两档都跟着真源走', () => {
    expect(CRM_RELATION_SRC).toMatch(/import \{ formatMoneyText \} from '\.\.\/\.\.\/\.\.\/lib\/moneyFormat'/);
    expect(CRM_RELATION_SRC).toMatch(/const fmtMoney = \([^)]*\) => formatMoneyText\(/);
    expect(CRM_RELATION_SRC, '仍有 Number(n || 0) 兜 0').not.toMatch(/Number\(n \|\| 0\)/);
    // 同一把尺的对照：把当年那份带兜 0 的一行塞回去
    const restored = CRM_RELATION_SRC.replace(
      /const fmtMoney = \([^)]*\) => formatMoneyText\([^)]*\);/,
      "const fmtMoney = (n: number, currency = 'CNY') => `${currency} ${Number(n || 0).toLocaleString()}`;");
    expect(restored).toMatch(/Number\(n \|\| 0\)/);
    expect(CRM_RELATION_SRC).not.toMatch(/Number\(n \|\| 0\)/);
  });
});

/**
 * v3.220 的判据与对照共用这一个谓词（不复用谓词的"对照"只是对我自己的话复读，抓不到东西）。
 * 检查四件事：私有实现已删、别名 import 到位、调用点确实解析到那份 import、
 * 而"币种裸拼"那个失败形状（`${...} ${currency}`）在本族已不存在。
 */
/** Inspect the imported binding rather than matching one textual import layout. */
function hasMoneyOutletImport(src:string, outlet:string, alias:string, relPath:string):boolean {
  const file=ts.createSourceFile('money-view.tsx',src,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  return file.statements.some(statement=>{
    if(!ts.isImportDeclaration(statement)||!ts.isStringLiteral(statement.moduleSpecifier)
      ||statement.moduleSpecifier.text!==relPath||statement.importClause?.isTypeOnly) return false;
    const bindings=statement.importClause?.namedBindings;
    return !!bindings&&ts.isNamedImports(bindings)&&bindings.elements.some(specifier=>
      !specifier.isTypeOnly&&(specifier.propertyName?.text??specifier.name.text)===outlet&&specifier.name.text===alias);
  });
}
function forwardsMoneyAlias(src:string, alias:string, outlet:string):boolean {
  const file=ts.createSourceFile('money-view.tsx',src,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let forwarded=false;
  const callsOutlet=(node:ts.Node):boolean=>{
    if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text===outlet)return true;
    let called=false;ts.forEachChild(node,child=>{if(callsOutlet(child))called=true;});return called;
  };
  const visit=(node:ts.Node)=>{
    if(ts.isFunctionDeclaration(node)&&node.name?.text===alias&&node.body&&callsOutlet(node.body))forwarded=true;
    if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.name.text===alias&&node.initializer
      &&(ts.isArrowFunction(node.initializer)||ts.isFunctionExpression(node.initializer))&&callsOutlet(node.initializer.body))forwarded=true;
    ts.forEachChild(node,visit);
  };
  visit(file);return forwarded;
}
function convergesToCodeAfterOutlet(src: string, alias: string, decl: RegExp, relPath: string): boolean {
  if (decl.test(src)) return false;
  if (!hasMoneyOutletImport(src,'formatMoneyCodeAfter',alias,relPath)) return false;
  if (/toLocaleString\([^)]*\)\s*\}\s*\$\{\s*currency\s*\}/.test(src)) return false;
  if ((src.match(new RegExp(`${alias}\\(`, 'g')) ?? []).length < 2) return false;
  return true;
}

describe('v3.220 · 第三出口 formatMoneyCodeAfter（币种码在后那一族）', () => {
  it('形状：数字在前、币种码在后，与那六个屏面原本一致', () => {
    expect(formatMoneyCodeAfter(1234.5, 'USD')).toBe('1,234.50 USD');
    expect(formatMoneyCodeAfter('1305.0000', 'CNY')).toBe('1,305.00 CNY');
    expect(formatMoneyCodeAfter(1041444.5, 'CNY')).toBe('1,041,444.50 CNY');
    expect(formatMoneyCodeAfter(-1234.5, 'USD')).toBe('-1,234.50 USD');
    expect(formatMoneyCodeAfter(0, 'CNY')).toBe('0.00 CNY');
  });

  it('★ 币种为空不许把 null 拼进屏面（这一档就是本批改这六处的理由）', () => {
    expect(formatMoneyCodeAfter(1234.5, null)).toBe('1,234.50');
    expect(formatMoneyCodeAfter(1234.5, undefined)).toBe('1,234.50');
    expect(formatMoneyCodeAfter(1234.5, '')).toBe('1,234.50');
    expect(formatMoneyCodeAfter(1234.5, '  ')).toBe('1,234.50');
    expect(formatMoneyCodeAfter(1234.5, ' USD ')).toBe('1,234.50 USD');
    for (const c of [null, undefined, ''] as const) {
      expect(formatMoneyCodeAfter(1234.5, c)).not.toContain('null');
      expect(formatMoneyCodeAfter(1234.5, c)).not.toMatch(/\s$/);   // 也不留一个孤零零的尾空格
    }
    // 反面对照：那六份原实现是这个形状 —— 币种为空时字面量 null 会直接上屏
    const oldShape = (n: number, currency: string) => `${n.toLocaleString('en-US')} ${currency}`;
    expect(oldShape(1234.5, null as unknown as string)).toBe('1,234.5 null');
  });

  it('空值 / 坏数一律 `—`；认不出的串原样上屏且不加币种', () => {
    for (const v of [null, undefined, NaN, ''] as const) {
      expect(formatMoneyCodeAfter(v, 'USD')).toBe('—');
    }
    expect(formatMoneyCodeAfter('待核', 'USD')).toBe('待核');
    expect(formatMoneyCodeAfter(Number(undefined), 'CNY')).toBe('—');
  });

  it('非零不足一分留四位：与前两个出口同一条矩（三份实现共用一套解析与小数规则）', () => {
    expect(formatMoneyCodeAfter(0.004, 'USD')).toBe('0.004 USD');
  });
});

describe('v3.220 · 币种码在后那六处屏面必须真的走第三出口（F 档清零）', () => {
  const SITES = [
    { name: '订单佣金 OrderCommissionSection', src: COMMISSION_SRC, alias: 'fmtMoney', decl: /const fmtMoney = /, rel: '../../lib/moneyFormat' },
    { name: '远期结汇 ForwardFxSection', src: FORWARD_FX_SRC, alias: 'fmtMoney', decl: /const fmtMoney = /, rel: '../../lib/moneyFormat' },
    { name: '采购 ProcurementManager', src: PROCUREMENT_SRC, alias: 'formatAmount', decl: /const formatAmount = /, rel: '../lib/moneyFormat' },
    { name: '报价 QuotationManager', src: QUOTATION_SRC, alias: 'formatAmount', decl: /const formatAmount = /, rel: '../lib/moneyFormat' },
    { name: '供应商询价 SupplierInquiryPanel', src: SUPPLIER_INQUIRY_SRC, alias: 'formatAmount', decl: /const formatAmount = /, rel: '../lib/moneyFormat' },
    { name: 'CRM CrmManager', src: CRM_MANAGER_SRC, alias: 'formatAmount', decl: /function formatAmount\(/, rel: '../lib/moneyFormat' },
  ];

  for (const s of SITES) {
    it(`${s.name}：私有实现已删、别名 import 到位、调用点解析到那份 import`, () => {
      expect(convergesToCodeAfterOutlet(s.src, s.alias, s.decl, s.rel),
        '判据：私有实现还在 / import 缺失 / 仍是币种裸拼的形状 / 别名没人调').toBe(true);
    });
  }

  it('多个/换行说明符仍绑定正确出口；同名调用接错别名或type-only import必须拒绝', () => {
    const body='const one=formatAmount(10,"USD"); const two=formatAmount(20,"USD");';
    const imports="import { formatMoneyText,\n formatMoneyCodeAfter as formatAmount } from '../lib/moneyFormat';";
    const check=(src:string)=>convergesToCodeAfterOutlet(src,'formatAmount',/function formatAmount\(/,'../lib/moneyFormat');
    expect(check(imports+body)).toBe(true);
    expect(check(imports.replace('as formatAmount','as unusedAlias')+body)).toBe(false);
    expect(check(imports.replace('import {','import type {')+body)).toBe(false);
  });

  it('★ 能红的对照：把 CrmManager 当年那份私有实现塞回去，同一把尺必须判 false', () => {
    const restored = CRM_MANAGER_SRC
      + '\nfunction formatAmount(amount: number, currency: string): string {'
      + '\n  return `${amount.toLocaleString()} ${currency}`;'
      + '\n}\n';
    expect(convergesToCodeAfterOutlet(restored, 'formatAmount', /function formatAmount\(/, '../lib/moneyFormat'),
      '私有实现回来了却没被抓到').toBe(false);
    // 另一种退回：只删 import 不补私有实现（真源变死码）
    const noImport = CRM_MANAGER_SRC.replace(/import\s*\{[^}]*formatMoneyCodeAfter\s+as\s+formatAmount[^}]*\}\s*from\s*['"]\.\.\/lib\/moneyFormat['"];?/, '');
    expect(noImport, '负面对照必须真正移除真源 import').not.toBe(CRM_MANAGER_SRC);
    expect(convergesToCodeAfterOutlet(noImport, 'formatAmount', /function formatAmount\(/, '../lib/moneyFormat'),
      '没接真源却没被抓到').toBe(false);
  });
});

/**
 * v3.222：判据与对照共用这一个谓词，并把"接的是哪一份出口"变成参数
 * （三族形状各一份出口：码在前 / 符号在前 / 码在后）。
 * 五件事：私有实现已删（或只剩一行转调）、别名 import 到位、调用点解析到那份 import、
 * 文件里不再出现"自带 toLocaleString 的同名实现"、以及可选的"某个失败形状不许回来"。
 */
function convergesViaOutlet(
  src: string,
  opt: { outlet: string; alias: string; rel: string; ban?: RegExp },
): boolean {
  const defRe = new RegExp(`^\\s*(?:export\\s+)?(?:function|const)\\s+${opt.alias}\\b[\\s\\S]{0,400}`, 'm');
  const hit = defRe.exec(src);
  // ★ v3.223 加宽：只 ban `toLocaleString` 的话，`new Intl.NumberFormat(...).format(...)` 那种
  //   自带实现塞回来抓不到（收款认领那处正是 Intl 写法，实测漏网）。三族自带实现都算。
  if (hit && /toLocaleString|Intl\.NumberFormat|toFixed\(/.test(hit[0])) return false;   // 还自带实现 ⇒ 没并干净
  // ★ v3.223：import 允许一行里带多个说明符（`import { a as b, c } from '…'`）——
  //   收款认领那处修内联形状时就是这种写法，逐字匹配会把"接了真源"读成"没接"。
  if (!hasMoneyOutletImport(src,opt.outlet,opt.alias,opt.rel)
    && !(hasMoneyOutletImport(src,opt.outlet,opt.outlet,opt.rel)&&forwardsMoneyAlias(src,opt.alias,opt.outlet))) return false;
  if ((src.match(new RegExp(`${opt.alias}\\(`, 'g')) ?? []).length < 2) return false;
  if (opt.ban && opt.ban.test(src)) return false;
  return true;
}

describe('金额出口绑定守卫的转调对照',()=>{
  it('本地别名只有真实转调 imported outlet 才成立；仅留import的死码不能通过',()=>{
    const prefix="import { formatMoneySymbol } from '../lib/moneyFormat';\n";
    const calls='fmtAmount(1);fmtAmount(2);';
    expect(convergesViaOutlet(prefix+"const fmtAmount=(n:number)=>formatMoneySymbol(n,'CNY');"+calls,{outlet:'formatMoneySymbol',alias:'fmtAmount',rel:'../lib/moneyFormat'})).toBe(true);
    expect(convergesViaOutlet(prefix+"const fmtAmount=(n:number)=>'CNY '+n;"+calls,{outlet:'formatMoneySymbol',alias:'fmtAmount',rel:'../lib/moneyFormat'})).toBe(false);
  });
});

describe('v3.222 · 符号在前那一整档（八处）并到第二出口 formatMoneySymbol', () => {
  const SITES = [
    { name: '驾驶舱 CockpitManager', src: COCKPIT_SRC, alias: 'formatAmount', rel: '../lib/moneyFormat' },
    { name: '财务管理 FinanceManager', src: FIN_MGR_SRC, alias: 'formatAmount', rel: '../lib/moneyFormat' },
    { name: '费用条目 BillingItemsPanel', src: BILLING_SRC, alias: 'fmtAmount', rel: '../../lib/moneyFormat' },
    { name: '现金日历 CashCalendarPanel', src: CASH_CAL_SRC, alias: 'formatAmount', rel: '../../lib/moneyFormat' },
    { name: '客户信用 FinanceCreditPanel', src: CREDIT_SRC, alias: 'formatAmount', rel: '../../lib/moneyFormat' },
    { name: '报表面板 FinanceReportsPanel', src: REPORTS_SRC, alias: 'formatAmount', rel: '../../lib/moneyFormat' },
    { name: '对账面板 ReconciliationPanel', src: RECON_SRC, alias: 'formatAmount', rel: '../../lib/moneyFormat' },
  ];
  for (const s of SITES) {
    it(`${s.name}：私有实现已删、别名 import 到位、调用点解析到那份 import`, () => {
      expect(convergesViaOutlet(s.src, { outlet: 'formatMoneySymbol', alias: s.alias, rel: s.rel }),
        '判据：仍自带 toLocaleString / import 缺失或形状不对 / 别名没人调').toBe(true);
    });
  }

  it('工序链那处：写死的 ¥ 改成显式 CNY 实参，形状不变但币种不再靠字面量偷偷决定', () => {
    expect(PROC_CHAIN_SRC).toMatch(/formatMoneySymbol\(n, 'CNY'\)/);
    expect(convergesViaOutlet(PROC_CHAIN_SRC, { outlet: 'formatMoneySymbol', alias: 'fmtAmount', rel: '../../lib/moneyFormat' })).toBe(true);
    // 这一处不能变成"没有币种参数"：那等于偷偷把 ¥ 丢了
    expect(PROC_CHAIN_SRC, '转调却没带币种 ⇒ 符号会消失').not.toMatch(/=> formatMoneySymbol\(n\)/);
  });

  it('★ 全仓不再有第四份"符号在前"私有实现：CNY→¥ 那串三元映射只剩真源里的一份', () => {
    // 真源用查表（CURRENCY_SYMBOLS），屏面侧不许再抄 ternary
    for (const [name, src] of SITES.map(s => [s.name, s.src] as const)) {
      expect(src, `${name} 仍有 currency === 'CNY' ? '¥' 这种私有映射`).not.toContain("currency === 'CNY' ? '¥'");
    }
  });

  it('★ 能红的对照：把驾驶舱当年那份私有实现塞回去，同一把谓词必须判 false', () => {
    const restored = COCKPIT_SRC + '\nfunction formatAmount(amount: number, currency?: string): string {'
      + "\n  const sym = currency === 'CNY' ? '\u00a5' : currency === 'USD' ? '$' : '';"
      + '\n  return `${sym}${amount.toLocaleString()}`;'
      + '\n}\n';
    expect(convergesViaOutlet(restored, { outlet: 'formatMoneySymbol', alias: 'formatAmount', rel: '../lib/moneyFormat' }),
      '私有实现回来了却没被抓到').toBe(false);
    const noImport = COCKPIT_SRC.replace("import { formatMoneySymbol as formatAmount } from '../lib/moneyFormat';", '');
    expect(convergesViaOutlet(noImport, { outlet: 'formatMoneySymbol', alias: 'formatAmount', rel: '../lib/moneyFormat' }),
      '没接真源却没被抓到').toBe(false);
  });

  it('★ 本批唯一一处使用方可见的形状差：费用条目那格不再替未知币种猜 ¥', () => {
    // 旧实现：CNY/USD/EUR 之外（含 undefined）一律给 ¥ —— 那是"没有币种也声称是人民币"
    expect(formatMoneySymbol(1234.5, undefined)).toBe('1,234.50');
    expect(formatMoneySymbol(1234.5, 'JPY')).toBe('JPY 1,234.50');
    expect(formatMoneySymbol(1234.5, 'CNY')).toBe('\u00a51,234.50');
    // 反面对照：旧实现会把未填币种渲染成人民币符号（这一格改了使用方看到的形状，已记进台账）
    const oldShape = (n: number, currency?: string) =>
      `${currency === 'USD' ? '$' : currency === 'EUR' ? '\u20ac' : '\u00a5'}${n.toFixed(2)}`;
    expect(oldShape(1234.5, undefined)).toBe('\u00a51234.50');
    expect(oldShape(1234.5, 'JPY')).toBe('\u00a51234.50');
  });
});
/* ── v3.223 · 码在前那一整档（五处）并到第一出口 formatMoneyText ─────────── */

const RECEIPT_CLAIM_SRC = readFileSync(new URL('../components/finance/ReceiptClaimsPanel.tsx', import.meta.url), 'utf8');
const SEASONS_SRC = readFileSync(new URL('../components/SeasonsManager.tsx', import.meta.url), 'utf8');
const MARKETING_SRC = readFileSync(new URL('../components/MarketingManager.tsx', import.meta.url), 'utf8');
const ORDER_CTX_SRC = readFileSync(new URL('../components/order/OrderContextSection.tsx', import.meta.url), 'utf8');
const PRODUCTS_SRC = readFileSync(new URL('../components/ProductsManager.tsx', import.meta.url), 'utf8');

describe('v3.223 · 码在前那一整档（五处）并到第一出口 formatMoneyText', () => {
  const PURE = [
    { name: '收款认领 ReceiptClaimsPanel', src: RECEIPT_CLAIM_SRC, alias: 'fmtMoney', rel: '../../lib/moneyFormat' },
    { name: '季度与活动 SeasonsManager', src: SEASONS_SRC, alias: 'formatMoney', rel: '../lib/moneyFormat' },
    { name: '营销管理 MarketingManager', src: MARKETING_SRC, alias: 'formatMoney', rel: '../lib/moneyFormat' },
  ];
  for (const s of PURE) {
    it(s.name + '：私有实现已删、别名 import 到位、调用点解析到那份 import', () => {
      expect(convergesViaOutlet(s.src, { outlet: 'formatMoneyText', alias: s.alias, rel: s.rel }),
        '判据：仍自带实现 / import 缺失或形状不对 / 别名没人调').toBe(true);
    });
  }

  it('★ 三处当年各自的失败形状：现在都挡在真源那一侧（用例只钉真源，不复制实现）', () => {
    // 收款认领：`new Intl.NumberFormat(...).format(x)` 实测 null → `0.00`、undefined/NaN → `NaN`
    expect(formatMoneyText(null, 'USD')).toBe('—');
    expect(formatMoneyText(undefined, 'USD')).toBe('—');
    expect(formatMoneyText(NaN, 'USD')).toBe('—');
    // 季度与活动：币种没填时不再替它猜一个 USD
    expect(formatMoneyText(1234.5, null)).toBe('1,234.50');
    expect(formatMoneyText(1234.5, 'USD')).toBe('USD 1,234.50');
    // 营销管理：原本"最多四位无条件"⇒ 收成两位（非零不足一分才留到四位）
    expect(formatMoneyText(1234.5678)).toBe('1,234.57');
    expect(formatMoneyText(0.004)).toBe('0.004');
    // 产品建档：`USD 1234.5` 那种"没千分位、不补零"从这一格消失
    expect(formatMoneyText(1234.5, 'CNY')).toBe('CNY 1,234.50');
  });

  it('订单上下文摘要：数字交真源，但空值**必须**继续给空串（.filter(Boolean) 靠它把整段摘掉）', () => {
    expect(convergesViaOutlet(ORDER_CTX_SRC, { outlet: 'formatMoneyText', alias: 'fmtAmount', rel: '../../lib/moneyFormat' }),
      '没接到真源').toBe(true);
    // ★ 只看"文件里有 import"不够：这一处要证的是**这一格**走了真源。
    //   否则"把转调换回 `cur + ' ' + n` 拼接、import 留着"这种退回是抓不到的（C1 实测就是这么设计出来的）。
    const fn = (ORDER_CTX_SRC.match(/const fmtAmount = \([\s\S]{0,300}/) ?? [''])[0];
    expect(fn, '没定位到 fmtAmount 这一份').not.toBe('');
    expect(fn.split('\n').slice(0, 3).join('\n'), '这一格没走真源').toContain('formatMoneyText(');
    expect(ORDER_CTX_SRC, '空值→空串这一档被抹成直接转调了').toMatch(/n == null \? '' :/);
    // 为什么不能图省事直接转调：真源的空值是 `—`，那会把摘要渲染成"收款 · — · 2026-05-01"
    expect(formatMoneyText(null)).toBe('—');
    expect(ORDER_CTX_SRC, '裸 toLocaleString 拼接回来＝又有一份私有实现').not.toMatch(/fmtAmount[\s\S]{0,160}toLocaleString/);
  });

  it('产品建档价格格：留"未填"与单位后缀，只把数字那一段交给真源', () => {
    expect(convergesViaOutlet(PRODUCTS_SRC, { outlet: 'formatMoneyText', alias: 'formatPrice', rel: '../lib/moneyFormat' }),
      '没接到真源').toBe(true);
    const fn = (PRODUCTS_SRC.match(/const formatPrice = \([\s\S]{0,400}?\n  \};/) ?? [''])[0];
    expect(fn, '没定位到 formatPrice 这一份').not.toBe('');
    expect(fn, '这一格没走真源（import 还在但转调被换回字符串拼接＝抓不到）').toContain('formatMoneyText(');
    expect(PRODUCTS_SRC, '业务文字"未填"没了＝这一格改成了没有数').toMatch(/if \(!price\) return '未填';/);
    expect(PRODUCTS_SRC, '单位后缀丢了（/ 米 这类信息就没了）').toMatch(/price\.unit \? ` \/ \$\{price\.unit\}` : ''/);
    expect(PRODUCTS_SRC, '裸插值 ${price.amount} 回来＝又没千分位').not.toMatch(/\$\{price\.amount\}/);
  });

  it('★ 能红的对照：三处当年那份私有实现塞回去，同一把谓词必须判 false（含 Intl 那一族）', () => {
    const cases: Array<[string, string, string, string, string, string]> = [
      ['收款认领', RECEIPT_CLAIM_SRC, 'fmtMoney', '../../lib/moneyFormat',
        'function fmtMoney(n: number, currency?: string): string {',
        "  const v = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);\n  return currency ? currency + ' ' + v : v;\n}\n"],
      ['季度与活动', SEASONS_SRC, 'formatMoney', '../lib/moneyFormat',
        'function formatMoney(value: number | null | undefined, currency?: string | null): string {',
        "  if (value === null || value === undefined) return '—';\n  return (currency || 'USD') + ' ' + value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });\n}\n"],
      ['营销管理', MARKETING_SRC, 'formatMoney', '../lib/moneyFormat',
        'function formatMoney(value: number | null | undefined, currency = \'\'): string {',
        "  if (value === null || value === undefined || Number.isNaN(value)) return '—';\n  const text = value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 4 });\n  return currency ? currency + ' ' + text : text;\n}\n"],
    ];
    for (const [name, src, alias, rel, decl, body] of cases) {
      const restored = src + '\n' + decl + '\n' + body;
      expect(convergesViaOutlet(restored, { outlet: 'formatMoneyText', alias, rel }),
        name + '：私有实现回来了却没被抓到').toBe(false);
      const noImport = src.replace(
        new RegExp(`import \\{[^}]*formatMoneyText as ${alias}[^}]*\\} from '${rel.replace(/\./g, '\\.')}';\\n?`), '');
      expect(noImport, name + '：那句 import 的字面没找到＝对照没喂进真身').not.toBe(src);
      expect(convergesViaOutlet(noImport, { outlet: 'formatMoneyText', alias, rel }),
        name + '：没接真源却没被抓到').toBe(false);
    }
  });

  it('★ 复核抓到的那一处：同一族会**内联在 JSX 里**，定义式普查看不见 ⇒ 给这个文件立一道内联守卫（B267）', () => {
    // 独立复核在 `合计可认领` 那行找到第二份"码在后"实现（内联、不走任何被扫到的函数名）。
    // ⇒ 本族的分母按"七个名字的定义"扫，**内联形状整类隐形**；这一格先钉住本批清干净的那个文件。
    const INLINE_MONEY = /\$\{[^}\n]*(toLocaleString\([^)]*FractionDigits|\.toFixed\()/;
    expect(RECEIPT_CLAIM_SRC, 'ReceiptClaimsPanel 里又有内联金额格式化（绕过真源，且普查数不到）').not.toMatch(INLINE_MONEY);
    expect(RECEIPT_CLAIM_SRC, '「合计可认领」那行没走第三出口').toContain('formatMoneyCodeAfter(amt, cur)');
    // 反面对照：把当年那句内联写法放回来，同一把正则必须抓到
    const restored = RECEIPT_CLAIM_SRC + '\nconst x = `${amt.toLocaleString(\'zh-CN\', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`;\n';
    expect(restored, '内联形状回来了却没被抓到').toMatch(INLINE_MONEY);
  });

  it('★ 三处旧的自带实现标记不许在屏面侧留任何一份（Intl / 猜 USD / 无条件四位 三种各一格）', () => {
    expect(RECEIPT_CLAIM_SRC, 'Intl.NumberFormat 又被人抄回屏面层').not.toMatch(/Intl\.NumberFormat/);
    expect(SEASONS_SRC, "币种缺省时猜 USD 的写法回来了").not.toMatch(/currency \|\| 'USD'/);
    expect(MARKETING_SRC, '无条件四位的小数档回来了').not.toMatch(/maximumFractionDigits: 4/);
  });
});

/* ── v3.224 · B267 起手表清两处（都在"七个名字"的分母之外）──────────────── */

const NOTIF_SRC = readFileSync(new URL('../components/NotificationCenter.tsx', import.meta.url), 'utf8');
const BOM_SRC = readFileSync(new URL('../components/BomManager.tsx', import.meta.url), 'utf8');

describe('v3.224 · B267 起手表清两处：通知中心那处"没值上屏 0.00" + BOM 那处"第八个名字"', () => {
  it('通知中心 · 付款申请金额：旧的 `Number(x ?? 0)` 会把"没数"说成"0.00" ⇒ 走真源后是 `—`', () => {
    expect(NOTIF_SRC, '那句 import 不见了').toMatch(/import \{[^}]*\bformatMoneyText\b[^}]*\} from '\.\.\/lib\/moneyFormat';/);
    expect(NOTIF_SRC, '那一格没走真源').toMatch(/金额[\s\S]{0,220}formatMoneyText\(p\.totalAmount, p\.currency\)/);
    expect(NOTIF_SRC, '兜 0 的写法回来了（A 档形状）').not.toMatch(/Number\([^)]*\? 0\)\.toLocaleString/);
    // 反面对照：旧写法就在那儿把"没有"写成"有"——这条断言钉的是**旧形状确实会撒谎**，不是我的文案
    const oldShape = (v?: number | null) => Number(v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2 });
    expect(oldShape(null)).toBe('0.00');
    expect(oldShape(undefined)).toBe('0.00');
    expect(formatMoneyText(null, 'USD'), '真源这一格给的是 —').toBe('—');
  });

  it('BOM · 第八个名字 formatCurrency 整份删掉，别名 import 到第三出口（十个调用点行为不变）', () => {
    expect(BOM_SRC, '私有实现回来了').not.toMatch(/function formatCurrency\(/);
    expect(convergesViaOutlet(BOM_SRC, { outlet: 'formatMoneyCodeAfter', alias: 'formatCurrency', rel: '../lib/moneyFormat' }),
      '判据：别名 import 缺失 / 仍自带实现 / 调用点没人用').toBe(true);
    // ★ "行为不变"的凭据不是我的判断，是这条现量：**每个调用点都显式带币种** ⇒ 原来那个 `= 'CNY'` 默认档是死路。
    //   只要有人新加一个不带币种的调用，这条就会红，逼他重新面对"要不要猜 CNY"那一问。
    const sites = BOM_SRC.match(/formatCurrency\([^)]*, ?[A-Za-z0-9_.]+\.currency\)/g) ?? [];
    expect(sites.length, '调用点数变了（原先现量 10 个，且逐个都带 x.currency）').toBe(10);
    expect(BOM_SRC, '又出现不带币种的调用（默认档会被复活）').not.toMatch(/formatCurrency\([^,)]*\)/);
    expect(formatMoneyCodeAfter(1234.5, 'CNY')).toBe('1,234.50 CNY');
  });

  it('★ 能红的对照：BOM 那份私有实现塞回真身，同一把谓词必须判 false', () => {
    const restored = BOM_SRC + '\nfunction formatCurrency(n: number | undefined | null, currency = \'CNY\'): string {\n'
      + "  if (n == null) return '—';\n"
      + '  return `${Number(n).toLocaleString(\'zh-CN\', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;\n}\n';
    expect(convergesViaOutlet(restored, { outlet: 'formatMoneyCodeAfter', alias: 'formatCurrency', rel: '../lib/moneyFormat' }),
      '私有实现回来了却没被抓到').toBe(false);
  });
});

// B267 第二档：三处"没值上屏成 0"的内联落点（现读自 5 行窗口的形状普查，不是按名字扫）
describe('v3.232 · 内联钱落点里的"空值兜 0"档（B267 续）', () => {
  const ORDER_MGR = readFileSync(new URL('../components/OrderManager.tsx', import.meta.url), 'utf8');
  const ADMIN_PANEL = readFileSync(new URL('../components/AdminPanel.tsx', import.meta.url), 'utf8');
  const GLOBE = readFileSync(new URL('../components/MapLibreProductionGlobe.tsx', import.meta.url), 'utf8');

  // 定点禁令（不用"通用形状正则"：那会把解释性注释里的旧写法也抓进来，尺先咬到自己）
  const BANS: Record<string, RegExp> = {
    orderAmountCoercion: /item\.amount \?\? 0/,
    orderCurrencyGuess: /salesCurrency \|\| '\$'/,
    adminTrackPriceCoercion: /trackA(?:MedianUsd|FinalUsd) \?\? 0/,
    globeValueCoercion: /tooltipTarget\.value \|\| 0/,
  };

  it('订单台账：行金额不再夹 0 上屏、缺币种不再猜，且确实走第一出口', () => {
    expect(ORDER_MGR, 'OrderManager 又把空金额夹成 0 上屏（$0）').not.toMatch(BANS.orderAmountCoercion);
    expect(ORDER_MGR, '缺币种时又用 $ 字面量猜 ⇒ 屏面会把"无币种"说成美元').not.toMatch(BANS.orderCurrencyGuess);
    expect(ORDER_MGR).toMatch(/import \{ formatMoneyText \} from '\.\.\/lib\/moneyFormat';/);
    const ledgerRows = readFileSync(new URL('../components/order/OrderLedgerRows.tsx', import.meta.url), 'utf8');
    expect(ledgerRows).toMatch(/formatMoneyText\(item\.amount, item\.salesCurrency\)/);
    expect(ledgerRows).not.toMatch(BANS.orderAmountCoercion);
    expect(ledgerRows).not.toMatch(BANS.orderCurrencyGuess);
    // 反面对照：缺陷放回来，同一把禁令必须抓到
    expect('`${c} ${(item.amount ?? 0).toLocaleString()}`').toMatch(BANS.orderAmountCoercion);
    expect("`${item.salesCurrency || '$'} 1,234`").toMatch(BANS.orderCurrencyGuess);
  });

  it('管理后台双轨审批：中位/终价没有值时是 —，不是 $0.0000', () => {
    expect(ADMIN_PANEL, 'AdminPanel 又把报价中位/终价夹成 0 上屏').not.toMatch(BANS.adminTrackPriceCoercion);
    expect(ADMIN_PANEL).toMatch(/formatMoneyText\(a\.payload\.trackAMedianUsd, 'USD'\)/);
    expect(ADMIN_PANEL).toMatch(/formatMoneyText\(a\.payload\.trackBFinalUsd, 'USD'\)/);
    expect("轨道 A 中位 \${Number(a.payload.trackAMedianUsd ?? 0).toFixed(4)}").toMatch(BANS.adminTrackPriceCoercion);
  });

  it('生产地球浮层：金额为空是 —；k 缩写（刻意的大数压缩）不许被当成缺陷改掉', () => {
    expect(GLOBE, '地球浮层又把空金额画成 $0.0k').not.toMatch(BANS.globeValueCoercion);
    expect(GLOBE).toMatch(/tooltipTarget\.value == null \? MONEY_EMPTY/);
    expect('`$${((tooltipTarget.value || 0) / 1000).toFixed(1)}k`').toMatch(BANS.globeValueCoercion);
    // 正面钉住"这次不是全并"：k 压缩仍在（并成真源反而会丢掉这一屏的可读性）
    expect(GLOBE, 'k 缩写被误删 ⇒ 这一屏的大数压缩是设计，不是缺陷').toMatch(/\$\$\{\(tooltipTarget\.value \/ 1000\)\.toFixed\(1\)\}k/);
    expect(GLOBE).toMatch(/import \{ MONEY_EMPTY \} from '\.\.\/lib\/moneyFormat';/);
  });
});
