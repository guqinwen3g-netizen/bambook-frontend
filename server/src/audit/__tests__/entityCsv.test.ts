/**
 * G4.3 变更史导出：CSV 组装（§12.05 D110 的口径 + **v3.107 复核 #26 的收口**）
 *
 * v3.104 第一版在本模块里**又写了一遍**单元格转义（危险前缀只认 `= + - @`），比仓内共享出口
 * `server/src/_shared/csvCell.ts` **窄一档**（漏 `\t` / `\r` —— 而共享层自己的回归测试
 * `csvCell.test.ts` 恰好把 `\t=1+1` / `\r=1+1` 当危险 payload）。
 * ⇒ 现在一律委托共享出口；本文件钉两件事：① 导出这一层的组装口径；② **不许再自造转义**。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildEntityAuditCsv, csvTime, ENTITY_AUDIT_CSV_HEADER } from '../entityCsv';

const ROW = {
  createdAt: new Date(2026, 7, 7, 10, 0, 0), // 本地时区构造 ⇒ 断言与机器 TZ 无关
  actor: { id: 'u-9', displayName: '张三', email: 'zhang@example.com' },
  action: 'update_order',
  operationType: 'update',
  fieldPath: 'status',
  beforeValue: 'Draft',
  afterValue: 'Confirmed',
  detail: { source: 'orders.route' },
};

/** 取第 n 行（0 = 表头）按**严格 CSV 解析**切列（引号内的逗号不算分隔符） */
function parseLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

describe('entityCsv · 组装口径（BOM / 列位 / 时间 / 截断）', () => {
  it('① 带 BOM、CRLF 行尾、表头 8 列且顺序固定', () => {
    const csv = buildEntityAuditCsv([]);
    expect(csv.startsWith('\ufeff'), '缺 BOM ⇒ Excel 双击中文乱码').toBe(true);
    expect(csv).toBe(`\ufeff${ENTITY_AUDIT_CSV_HEADER.join(',')}\r\n`);
  });

  it('② 空历史：只有表头、且**不加**截断行', () => {
    const csv = buildEntityAuditCsv([]);
    expect(csv.trim().split('\r\n')).toHaveLength(1);
    expect(csv).not.toContain('已截断');
  });

  it('③ 正常一行：8 格按 时间/操作人/操作类型/字段/原值/新值/动作/详情 落位', () => {
    const csv = buildEntityAuditCsv([ROW]);
    const cells = parseLine(csv.split('\r\n')[1]);
    expect(cells).toHaveLength(8);
    expect(cells[0]).toBe('2026-08-07 10:00:00');
    expect(cells[1]).toBe('张三');
    expect(cells[2]).toBe('update');
    expect(cells[3]).toBe('status');
    expect(cells[4]).toBe('Draft');
    expect(cells[5]).toBe('Confirmed');
    expect(cells[6]).toBe('update_order');
    expect(cells[7]).toBe('{"source":"orders.route"}'); // 对象 → JSON 文本，不是 "[object Object]"
  });

  it('④ 含逗号 / 引号 / 换行的值：严格解析回来仍是 8 列、内容逐字相等', () => {
    const csv = buildEntityAuditCsv([{ ...ROW, beforeValue: 'a,b', afterValue: 'he said "hi"', fieldPath: 'x\ny' }]);
    const cells = parseLine(csv.split('\r\n')[1]);
    expect(cells).toHaveLength(8);
    expect(cells[3]).toBe('x\ny');
    expect(cells[4]).toBe('a,b');
    expect(cells[5]).toBe('he said "hi"');
  });

  it('⑤ ★ 公式注入：含 Tab / CR 的 payload 也必须被文本标记化（v3.104 第一版在这里漏了）', () => {
    const payloads = ['=1+1', '+1+1', '-1+1', '@SUM(A1:A9)', '\t=1+1', '\r=1+1', '=cmd|\'/c calc\'!A0'];
    for (const p of payloads) {
      const csv = buildEntityAuditCsv([{ ...ROW, afterValue: p }]);
      const cell = csv.split('\r\n')[1].split(',') // 危险 payload 不含逗号 ⇒ 简单切分够用
        .find(c => c.includes('1+1') || c.includes('calc') || c.includes('SUM'));
      expect(cell, `payload ${JSON.stringify(p)} 没出现在导出里`).toBeTruthy();
      // 输出后不许**裸**以危险字符开头；必须是 `'` 文本标记（或被引号包裹后再跟 `'`）
      expect(/^[=+\-@\t\r]/.test(cell as string), `payload ${JSON.stringify(p)} 可能被当公式执行：${cell}`).toBe(false);
      expect((cell as string).startsWith("'") || (cell as string).startsWith('"\'')).toBe(true);
    }
  });

  it('⑥ 转义实现只有一处：本模块必须委托共享出口（不许再自造一份）', () => {
    const src = readFileSync(new URL('../entityCsv.ts', import.meta.url), 'utf8');
    expect(src, '没引用共享 csvCell ⇒ 又各写一遍，两处必然漂移').toContain("from '../_shared/csvCell'");
    expect(/FORMULA_TRIGGER|FORMULA_PREFIX/.test(src), '本模块又在自造危险前缀正则').toBe(false);
  });

  it('⑦ 空值：null / undefined / 缺字段 ⇒ 空串（不是 "null" 字面量）', () => {
    const csv = buildEntityAuditCsv([{ createdAt: ROW.createdAt, fieldPath: null }]);
    const cells = parseLine(csv.split('\r\n')[1]);
    expect(cells[3]).toBe('');
    expect(cells[4]).toBe('');
  });

  it('⑧ 截断：调用方说截了，末尾必须有显式说明行（且带上限数字）', () => {
    const csv = buildEntityAuditCsv([ROW], { truncated: true, maxRows: 5000 });
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('已截断');
    expect(lines[2]).toContain('5000');
    expect(lines[2]).toContain('最近 1 条');
  });

  it('⑨ 非法时间：不抛异常、原样带出（导出不许因为一行坏数据整份失败）', () => {
    const csv = buildEntityAuditCsv([{ createdAt: 'not-a-date' }]);
    expect(csv).toContain('not-a-date');
    expect(csvTime('not-a-date')).toBe('not-a-date');
  });
});
