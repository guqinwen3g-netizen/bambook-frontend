/**
 * contractToleranceHonesty.test.ts — ★ 守卫：对外合同**不许自造业务事实**
 *
 * 为什么要有它（2026-09-29 与真实合同对撞时挖出）：
 *   合同模板条款区原写「Quantity Tolerance 溢短装: 按各订单行级溢短装条款执行
 *   （**默认 ±5%，行业惯例**）」。
 *   ★ 那句是**系统自己编的**：5% 只是 `OrderLine.tolerancePercent` 的**默认值**，
 *   与"行业惯例"无关；而真实合同里容差是**逐单约定**的
 *   （客户 PO 按数量分档 ±5/3/2/1%、采购合同 ±1%）。
 *   ⇒ 对外文件上写一句自造的业务事实，**功能测试全绿、但业务上是错的**。
 *
 * 本守卫钉三件事：
 *   ① 模板源码里**不许**出现"行业惯例"这类自我背书（在溢短装条款上）；
 *   ② 容差文字必须**由行级真实值算出**（一致→印该值；不一致→见各行；取不到→未载明）；
 *   ③ **取不到时不许回落成 5**（回落＝又编一个数）。
 *
 * 判据来源：`docs/inventory/v1补完清单-第一版.md` §9.5（独立成立、不受"客户要求"撤回影响）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// ★ vitest 的 cwd 是 server/ ⇒ 相对它取路径（写 __dirname 相对层级容易差一层，实测踩过）
const SRV = process.cwd();
const TEMPLATE = path.join(SRV, 'src/templates/docTemplates/contract.ts');

const src = fs.readFileSync(TEMPLATE, 'utf8');

describe('合同条款的诚实性（不许自造业务事实）', () => {
  it('① 溢短装条款里不许出现「行业惯例」这类自我背书', () => {
    // 只查条款区那一段，避免误伤别处的正常用词
    const section = src.slice(src.indexOf('Quantity Tolerance'), src.indexOf('Quantity Tolerance') + 200);
    expect(section).not.toContain('行业惯例');
    expect(section).not.toContain('默认 ±5%');
  });

  it('② 容差文字必须由行级真实值算出（三种情形都在）', () => {
    expect(src, '缺"一致→印该值"的分支').toMatch(/tolValues\.length === 1/);
    expect(src, '缺"不一致→见各行"的分支').toMatch(/tolValues\.length > 1/);
    expect(src, '缺"取不到→未载明"的分支').toContain('本合同未载明统一容差');
  });

  it('③ 取不到时不许回落成 5', () => {
    // 过滤只在 null/undefined 时才取值的写法；出现 `?? 5` / `|| 5` 即判红
    const fallbackToFive = /\?\?\s*5\b|\|\|\s*5\b/.test(src);
    expect(fallbackToFive, '发现把缺失容差回落成 5 的写法 —— 那是又替客户编一个数').toBe(false);
  });

  it('④ 行数据契约里必须真有 tolerancePercent（否则模板印不出来）', () => {
    expect(src, 'ContractDocLine 缺 tolerancePercent ⇒ 模板只能自造').toMatch(
      /interface ContractDocLine[\s\S]*?tolerancePercent:\s*number\s*\|\s*null/,
    );
  });

  it('⑥ 固定条款必须带版本号，且模板里真的渲染了它', () => {
    // 为什么：法律文本改过一次而没人知道，是本仓反复踩的坑 ⇒ 版本号必须落在输出里
    expect(src, '缺版本常量').toMatch(/CONTRACT_FIXED_CLAUSES_VERSION\s*=/);
    expect(src, '模板没渲染版本号 ⇒ 改过没人知道').toMatch(/条款文本版本：/);
    expect(src, '固定条款常量缺 CONTRACT_FIXED_CLAUSES').toMatch(/CONTRACT_FIXED_CLAUSES\s*:/);
  });

  it('⑦ 固定条款必须覆盖真实合同里那 3 条纯法律条款', () => {
    // 真实合同 9 条里，纯法律文本的是：不可抗力 / 签回 / 法律适用（见 docs/inventory/我方销售合同条款原文.md）
    expect(src).toContain('不可抗力 Force Majeure');
    expect(src).toContain('签回 Acknowledgement');
    expect(src).toContain('法律适用 Governing Law');
    expect(src, 'Incoterms 版本必须写死，否则约束对象不明').toContain('Incoterms 2010');
  });

  it('⑤ 装配侧必须真的把行级容差传进来', () => {
    const asm = fs.readFileSync(path.join(SRV, 'src/customs/compositeDocumentService.ts'), 'utf8');
    expect(asm, '装配处没传 tolerancePercent ⇒ 模板永远拿不到真值').toMatch(/tolerancePercent:\s*\(l as/);
  });
});
