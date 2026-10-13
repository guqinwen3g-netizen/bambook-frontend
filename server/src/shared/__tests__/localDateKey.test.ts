/**
 * 业务日守卫：日期投影显式使用 Asia/Shanghai，今天来自业务时钟，
 * 历史 Date(value) 保留原 epoch。机器使用 UTC 时也应得到相同业务日。
 * AST 扫描生产源码中的 ISO 截日（slice/substring/split），排除注释和字符串。
 * 冻结基线只能减少；收口到零后，任何新增写法都必须失败。
 */

import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { businessNowDate } from '../businessClock';
import {
  isValidLocalDateKey,
  localDateKey,
  todayLocalKey,
  localDateKeyFromMs,
  localDateKeyFromBigInt,
} from '../localDate';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // server/src/shared/__tests__
const SRC = path.resolve(HERE, '..', '..'); // server/src

/** Parse actual expressions: comments and string examples are not date writers. */
function countUtcDateKeys(src: string): number {
  const source = ts.createSourceFile('business-date.ts', src, ts.ScriptTarget.Latest, true);
  const literal = (node: ts.Node | undefined, value: string) => !!node
    && (ts.isNumericLiteral(node) || ts.isStringLiteral(node)) && node.text === value;
  const isIso = (node: ts.Node) => ts.isCallExpression(node) && node.arguments.length === 0
    && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'toISOString';
  let total = 0;
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ['slice', 'substring'].includes(node.expression.name.text) && literal(node.arguments[0], '0')
      && literal(node.arguments[1], '10') && isIso(node.expression.expression)) total++;
    if (ts.isElementAccessExpression(node) && literal(node.argumentExpression, '0')
      && ts.isCallExpression(node.expression) && ts.isPropertyAccessExpression(node.expression.expression)
      && node.expression.expression.name.text === 'split' && literal(node.expression.arguments[0], 'T')
      && isIso(node.expression.expression.expression)) total++;
    ts.forEachChild(node, visit);
  }
  visit(source);
  return total;
}

function scanUtcDateKeys(): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === '__tests__' || ent.name === 'node_modules') continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(abs);
      } else if (ent.name.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(ent.name)) {
        const n = countUtcDateKeys(fs.readFileSync(abs, 'utf8'));
        if (n > 0) out[path.relative(SRC, abs).split(path.sep).join('/')] = n;
      }
    }
  };
  walk(SRC);
  return out;
}

/**
 * ★ 冻结基线（2026-09-17）。**只许减不许增**：
 *   · 新增一个 UTC 日期键 → 计数变大 → 红
 *   · 修好一处 → 必须回来把这里减 1（否则红）—— 防止「修完了没人知道」
 *   · 收敛整份文件后 → 删掉该条目
 */
// 2026-10-07 measured AST baseline: every actual business date writer now uses
// the Shanghai helper. No exception is kept for validation or split/substring.
const FROZEN_UTC_DATE_KEYS: Record<string, number> = {};

const SCAN_TIMEOUT_MS = 30_000;
let _scanned: Record<string, number> | null = null;
function scanned(): Record<string, number> {
  if (!_scanned) _scanned = scanUtcDateKeys();
  return _scanned;
}

describe('★ localDate 真源', () => {
  it('★ 上海业务日期不依赖服务端墙钟所在时区', () => {
    vi.stubEnv('TZ', 'UTC');
    try {
      expect(new Date('2026-09-16T17:00:00Z').getTimezoneOffset()).toBe(0);
      expect(localDateKey(new Date('2026-09-16T17:00:00Z'))).toBe('2026-09-17');
    } finally { vi.unstubAllEnvs(); }
  });

  it('★ 东区凌晨：本地日 ≠ UTC 日（证明两者确实会差一天）', () => {
    // 2026-09-16T17:00:00Z = 中国时间 2026-09-17 01:00（落在 00:00–08:00 窗口内）
    const d = new Date('2026-09-16T17:00:00Z');
    expect(localDateKey(d)).toBe('2026-09-17');            // 真源取本地日 = 中国日
    expect(d.toISOString().slice(0, 10)).toBe('2026-09-16'); // 反证：UTC 形式得到「昨天」
    expect(localDateKey(d)).not.toBe(d.toISOString().slice(0, 10));
  });

  it('本地日 = 本地 getter 组合（与 UTC 无关）；非凌晨时两者一致', () => {
    // 2026-09-17T04:00:00Z = 中国 12:00（同日，两者应一致）
    const noon = new Date('2026-09-17T04:00:00Z');
    expect(localDateKey(noon)).toBe('2026-09-17');
    expect(localDateKey(noon)).toBe(noon.toISOString().slice(0, 10));
    // 月末/年末不越界
    expect(localDateKey(new Date('2026-12-31T16:00:00Z'))).toBe('2027-01-01'); // 中国 2027-01-01 00:00
  });

  it('todayLocalKey 与业务时钟同源，历史 Date(value) 不替换', () => {
    expect(todayLocalKey()).toBe(localDateKey(businessNowDate()));
    expect(localDateKey(new Date('2024-02-29T04:00:00Z'))).toBe('2024-02-29');
  });

  it('localDateKeyFromMs / localDateKeyFromBigInt 边界', () => {
    const ms = new Date('2026-09-16T17:00:00Z').getTime();
    expect(localDateKeyFromMs(ms)).toBe('2026-09-17');
    expect(localDateKeyFromBigInt(BigInt(ms))).toBe('2026-09-17');
    // 缺失 → 默认 '未知'，可自定义占位符
    expect(localDateKeyFromBigInt(null)).toBe('未知');
    expect(localDateKeyFromBigInt(undefined)).toBe('未知');
    expect(localDateKeyFromBigInt(null, '')).toBe('');
  });
});

describe('★ 棘轮守卫：UTC 日期截取只许减不许增', () => {
  it('逐文件计数必须等于冻结基线（新增即红；修好一处必须回来改基线）', () => {
    const found = scanned();
    // 双向：多一处红、少一处也红（少 = 你修好了但没更新基线，别让基线说谎）
    expect(found).toEqual(FROZEN_UTC_DATE_KEYS);
  }, SCAN_TIMEOUT_MS);

  it('★ 守卫自检：AST 不把注释和字符串中的日期写法算作写入', () => {
    const sample = [
      "// 旧写法 toISOString().slice(0, 10) 是错的",
      "/* 也别写 toISOString().slice(0,10) */",
      "const ok = d.toISOString(); // 完整 ISO 合法",
      'const example = "d.toISOString().slice(0, 10)";',
      "const bad = d.toISOString().slice(0, 10);",
    ].join('\n');
    expect(countUtcDateKeys(sample)).toBe(1);
  });

  it('★ 守卫自检：真实代码行必须被算到（防止正则退化成恒不匹配）', () => {
    for (const s of [
      "const today = new Date().toISOString().slice(0, 10);",
      "const d = x.toISOString().slice(0,10);",
      "const d = x.toISOString().split('T')[0];",
      "const d = x.toISOString().substring(0,10);",
    ]) {
      expect(countUtcDateKeys(s)).toBe(1);
    }
  }, SCAN_TIMEOUT_MS);
});

describe('Explicit business calendar input', () => {
  it.each(['2026-10-01', '2024-02-29', '2000-02-29', '2026-01-01', '1999-12-31'])('accepts actual calendar day %s', day => {
    expect(isValidLocalDateKey(day)).toBe(true);
  });
  it.each(['2026-02-29', '1900-02-29', '2026-02-30', '2026-13-01', '2026-00-01', '2026-10-00', '2026-1-1', '2026-10-01T00:00:00Z', '', null, 20261001])('refuses rollover, timestamp or non-day input %s', day => {
    expect(isValidLocalDateKey(day)).toBe(false);
  });
});
