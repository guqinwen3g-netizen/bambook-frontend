/**
 * CSV 公式注入防护回归测试（2026-09-15）
 *
 * 背景：系统两个 CSV 出口（relations 客户档案导出 / reporting 报表运行导出）
 * 此前各自实现的转义**只处理引号/逗号/换行**，不防公式注入。CSV 是纯文本，
 * Excel / WPS 打开时会把以 `=` `+` `-` `@` Tab / CR 开头的单元格当公式执行
 * （`=cmd|'/c calc'!A0`、`=HYPERLINK(...)`）。客户名 / 地址 / 备注均来自业务方
 * 录入或 Excel 导入，形状不可控 —— 真实场景里 `-` 开头地址、`=` 开头备注都出现过。
 *
 * 本测试锁定：危险前缀一律被"文本标记化"，且不影响正常值。
 */
import { describe, expect, it } from 'vitest';
import { csvCellSafe, csvRowSafe } from '../csvCell';

describe('CSV 单元格转义 + 公式注入防护', () => {
  const dangerous = [
    '=1+1',
    "=cmd|'/c calc'!A0",
    '=HYPERLINK("http://evil.tld","点我")',
    '+1+1',
    '-1+1',
    '@SUM(A1:A9)',
    '\t=1+1',
    '\r=1+1',
  ];

  for (const payload of dangerous) {
    it(`危险值被文本标记化（不再以触发字符开头）：${JSON.stringify(payload).slice(0, 34)}`, () => {
      const out = csvCellSafe(payload);
      // 输出后不再以 = + - @ Tab CR 裸开头（要么前置 '，要么被 " 包裹且内含 '）
      expect(/^[=+\-@\t\r]/.test(out)).toBe(false);
      expect(out.startsWith("'") || out.startsWith(`"'`)).toBe(true);
      // 原值内容仍完整保留（不丢数据）
      expect(out).toContain(payload.replace(/"/g, '""').replace(/^["']+|["']+$/g, '') || payload);
    });
  }

  it('正常中文/英文值不受影响（不加多余引号或前缀）', () => {
    expect(csvCellSafe('上海锦昀国际货运代理有限公司')).toBe('上海锦昀国际货运代理有限公司');
    expect(csvCellSafe('Cascadia Outfitters Inc.')).toBe('Cascadia Outfitters Inc.');
    expect(csvCellSafe('')).toBe('');
    expect(csvCellSafe(null)).toBe('');
    expect(csvCellSafe(undefined)).toBe('');
    // 数字仍走字符串（CSV 无需区分）
    expect(csvCellSafe(42)).toBe('42');
  });

  it('含逗号/引号/换行的值仍按标准 CSV 规则包裹转义', () => {
    expect(csvCellSafe('a,b')).toBe('"a,b"');
    expect(csvCellSafe('say "hi"')).toBe('"say ""hi"""');
    expect(csvCellSafe('line1\nline2')).toBe('"line1\nline2"');
  });

  it('组合场景：既含公式前缀又含逗号 → 前缀 + 包裹转义同时生效', () => {
    const out = csvCellSafe('=say,"hi"');
    expect(out.startsWith(`"'`)).toBe(true);
    expect(out).toContain('""hi""');
  });

  it('csvRowSafe 整行拼接正确', () => {
    expect(csvRowSafe(['a', '=1+1', 'b,c'])).toBe(`a,'=1+1,"b,c"`);
  });
});
