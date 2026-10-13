/**
 * 发票模板「客户联系人」存储型 XSS 回归锁。
 *
 * 背景（2026-09-15 外部输入面主动排查）：
 *   financeInvoice.partyDetail(detail, extra) 只转义了 detail，extra（= relationContact，
 *   由 Relation.primaryContactName / primaryContactEmail 拼出）原样内联进
 *   <div class="detail">。Relation 是客户/供应商档案（四方数据），且 contactSync 会用
 *   邮件同步得到的联系人姓名/邮箱回写这两个字段——来源完全外部可控。
 *   攻击路径：业务在客户档案填恶意联系人 → 开该客户的发票 → 预览/出 PDF → 触发。
 *
 * 本测试在修复前必须红（先证伪「没事」），修复后转绿并长期锁定。
 */

import { describe, expect, it } from 'vitest';
import { invoicePdfHtml } from '../docTemplates/financeInvoice';

const EXPORTER = {
  nameEn: 'BAMBOOK TRADING CO., LTD.',
  addressEn: 'No. 88 Nanjing Road, Shanghai, China',
  beneficiary: 'BAMBOOK TRADING',
  bankName: 'Bank of Shanghai',
  swiftCode: 'BOSHCNSH',
  bankAddress: 'Shanghai Main Branch',
  usdAccountNumber: 'USD-0001',
};

function renderWithContact(name: string | null, email: string | null): string {
  return invoicePdfHtml({
    invoice: { invoiceNumber: 'INV-2026-0001', issueDate: '2026-09-15', type: 'Commercial', amount: 1000, currency: 'USD' },
    allocs: [],
    exporter: EXPORTER,
    relation: {
      englishName: 'ACME CORP',
      name: 'ACME CORP',
      contactInfo: '',
      primaryContactName: name,
      primaryContactEmail: email,
    },
    ordersById: new Map(),
    linesByOrder: new Map(),
    shipment: null,
  });
}

/** 任何能让浏览器执行/闭合属性的产物 */
const EXECUTABLE_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'script 标签', re: /<script/i },
  // 只认「标签内部」的事件属性：转义后的惰性文本里出现 " onerror=" 字样是正常的
  { label: '标签内 on* 事件属性', re: /<[a-z][^>]*\son[a-z]+\s*=/i },
  { label: 'img 注入', re: /<img(?![^>]*class="doc-stamp")/i },
  { label: 'svg 注入', re: /<svg/i },
  { label: 'iframe 注入', re: /<iframe/i },
  { label: 'javascript: 协议', re: /javascript:/i },
];

/**
 * 结构性片段：只要原样出现在产物里就说明没被转义。
 * 注意 esc 只转义 & < > " '，所以 "onerror=" 这类字样仍会以纯文本残留——
 * 那无害（是文本不是属性），真正危险的是标签结构，故只锁结构片段。
 */
const RAW_FRAGMENTS = ['<img', '<script', '<svg', '<iframe', 'javascript:'];

const PAYLOADS: Array<{ label: string; name: string; email: string }> = [
  {
    label: '属性闭合 + onerror',
    name: '"><img src=x onerror=alert(1)>',
    email: 'a@b.com',
  },
  {
    label: '邮箱属性闭合 + onmouseover',
    name: 'Alice',
    email: 'a@b.com" onmouseover="alert(1)',
  },
  {
    label: 'script 标签直插',
    name: '<script>alert(1)</script>',
    email: 'x@y.com',
  },
  {
    label: '单引号闭合 + onload（SVG）',
    name: "Bob'><svg onload=alert(1)>",
    email: 'b@c.com',
  },
  {
    label: '反引号模板闭合',
    name: 'Eve` onerror=alert(1) `',
    email: 'e@f.com',
  },
];

describe('invoicePdfHtml 客户联系人注入防护', () => {
  for (const p of PAYLOADS) {
    it(`拒绝执行：${p.label}`, () => {
      const html = renderWithContact(p.name, p.email);
      for (const { label, re } of EXECUTABLE_PATTERNS) {
        expect(re.test(html), `产物出现「${label}」：${html.slice(0, 400)}`).toBe(false);
      }
    });

    it(`原文以纯文本呈现（原始危险片段不得原样出现）：${p.label}`, () => {
      const html = renderWithContact(p.name, p.email);
      expect(html).toContain('ACME CORP');
      // 原始 payload 的任一危险片段都不得原样出现在产物里（必须已被实体化）
      for (const frag of RAW_FRAGMENTS) {
        if (p.name.includes(frag) || p.email.includes(frag)) {
          expect(html, `原始危险片段 ${frag} 未被转义`).not.toContain(frag);
        }
      }
    });
  }

  it('正常联系人姓名/邮箱不误伤（照常渲染且无 HTML 实体污染）', () => {
    const html = renderWithContact('Alice Zhang', 'alice@acme.com');
    expect(html).toContain('Contact: Alice Zhang');
    expect(html).toContain('Email: alice@acme.com');
    // 合法值不含需转义字符，不应出现 &quot; 之类污染
    expect(html).not.toContain('&quot;Alice');
  });

  it('联系人含 & 符号时正确转义为 &amp;', () => {
    const html = renderWithContact('A & B Trading', 'a@b.com');
    expect(html).toContain('A &amp; B Trading');
    expect(html).not.toContain('A & B Trading</div>');
  });

  it('无联系人时 detail 区不产生空 Attn/Contact 噪声', () => {
    const html = renderWithContact(null, null);
    expect(html).not.toContain('Contact:');
    expect(html).not.toContain('Email:');
  });

  it('联系人与地址共存时换行分隔仍正常（<br> 不被转义掉）', () => {
    const html = invoicePdfHtml({
      invoice: { invoiceNumber: 'INV-1', issueDate: '2026-09-15', type: 'Commercial', amount: 1, currency: 'USD' },
      allocs: [],
      exporter: EXPORTER,
      relation: {
        englishName: 'ACME',
        name: 'ACME',
        contactInfo: 'Line1\nLine2',
        primaryContactName: 'Alice Zhang',
        primaryContactEmail: 'alice@acme.com',
      },
      ordersById: new Map(),
      linesByOrder: new Map(),
      shipment: null,
    });
    expect(html).toContain('Line1<br>Line2');
    expect(html).toContain('Contact: Alice Zhang<br>Email: alice@acme.com');
  });
});
