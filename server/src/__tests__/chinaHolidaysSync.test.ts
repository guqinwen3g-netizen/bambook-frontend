/**
 * 服务端节假日副本 —— **数据对撞守卫** + 工作日计算用例（口径 C1，2026-09-17）
 *
 * ── 为什么必须有对撞守卫 ─────────────────────────────────
 * 服务端算「请假工作日天数 / 考勤汇总」，前端日历显示休息日 —— **两者必须用同一份节假日数据**。
 * 副本一旦漂移，症状是**静默的**：前端日历把某天标成休息，后端却把它算进请假天数
 * （或反之），员工与 HR 看到的天数对不上，且没有任何报错。
 *
 * ⇒ 本文件从**两个文件**里各自提取数据（**文本提取，不是 import 同一份**）后逐条比对：
 *   真源 `utils/chinaHolidays.ts` ⟷ 副本 `server/src/_shared/chinaHolidays.ts`。
 *   ⚠️ 刻意**不 import 前端文件**（跨层 import 会把前端模块拖进服务端 program），
 *      也刻意**不 import 同一个常量**（那样比对就恒真 = 空过）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  HOLIDAY_DATA,
  countWorkdaysInclusive,
  isWorkday,
  listWorkdaysInclusive,
  resolveDayTypeKey,
} from '../_shared/chinaHolidays';

const REPO_ROOT = path.resolve(__dirname, '../../..');

/** 从源码文本里提取 `{ start, end, name }` 三元组（只认单引号字面量，够用且不引 TS 解析器） */
function extractRanges(src: string): string[] {
  const out: string[] = [];
  const re = /\{\s*start:\s*'([\d-]+)',\s*end:\s*'([\d-]+)',\s*name:\s*'([^']+)'\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push(`${m[1]}~${m[2]}~${m[3]}`);
  return out.sort();
}

/** 从源码文本里提取 `adjustedWorkdays: [ 'a', 'b' ]` 的日期集合 */
function extractAdjusted(src: string): string[] {
  const block = /adjustedWorkdays:\s*\[([\s\S]*?)\]/.exec(src);
  if (!block) return [];
  return (block[1].match(/'([\d-]+)'/g) ?? []).map(s => s.replace(/'/g, '')).sort();
}

const FRONTEND_SRC = readFileSync(path.join(REPO_ROOT, 'utils/chinaHolidays.ts'), 'utf8');
const SERVER_SRC = readFileSync(path.join(REPO_ROOT, 'server/src/_shared/chinaHolidays.ts'), 'utf8');

describe('★ 服务端节假日副本 ⟷ 前端真源 数据对撞', () => {
  it('真源可被解析（防止提取正则失效导致下面全部空过）', () => {
    expect(extractRanges(FRONTEND_SRC).length, '前端未提取到任何假期区间').toBeGreaterThan(0);
    expect(extractAdjusted(FRONTEND_SRC).length, '前端未提取到任何调休上班日').toBeGreaterThan(0);
  });

  it('★ 假期区间逐条一致', () => {
    expect(extractRanges(SERVER_SRC)).toEqual(extractRanges(FRONTEND_SRC));
  });

  it('★ 调休上班日逐条一致', () => {
    expect(extractAdjusted(SERVER_SRC)).toEqual(extractAdjusted(FRONTEND_SRC));
  });

  it('★ 副本常量本身与真源提取结果一致（防止"文件文本对但常量没改"）', () => {
    const serverRanges = Object.values(HOLIDAY_DATA)
      .flatMap(d => d.holidayRanges.map(r => `${r.start}~${r.end}~${r.name}`))
      .sort();
    const serverAdjusted = Object.values(HOLIDAY_DATA).flatMap(d => d.adjustedWorkdays).sort();
    expect(serverRanges).toEqual(extractRanges(FRONTEND_SRC));
    expect(serverAdjusted).toEqual(extractAdjusted(FRONTEND_SRC));
  });
});

describe('★ 口径 C1：工作日判定与天数计算', () => {
  it('四态判定（2026 官方安排逐条核对）', () => {
    expect(resolveDayTypeKey('2026-01-01')).toBe('holiday'); // 元旦
    expect(resolveDayTypeKey('2026-01-04')).toBe('adjusted-workday'); // 周日调休上班
    expect(resolveDayTypeKey('2026-03-07')).toBe('weekend'); // 普通周六
    expect(resolveDayTypeKey('2026-03-09')).toBe('workday'); // 普通周一
  });

  it('★ 承重：跨周末不计入（3/6 周五 ~ 3/9 周一 → **2** 个工作日，自然日是 4 天）', () => {
    expect(countWorkdaysInclusive('2026-03-06', '2026-03-09')).toBe(2);
    expect(listWorkdaysInclusive('2026-03-06', '2026-03-09')).toEqual(['2026-03-06', '2026-03-09']);
  });

  it('★ 承重：法定假期不计入，但**调休上班日计入**（春节 2/13~2/24 → 3 个工作日）', () => {
    // 2/13 周五（工作日）· 2/14 周六（**调休上班**）· 2/15~2/23 春节假期 · 2/24 周二（工作日）
    const days = listWorkdaysInclusive('2026-02-13', '2026-02-24');
    expect(days).toEqual(['2026-02-13', '2026-02-14', '2026-02-24']);
    expect(countWorkdaysInclusive('2026-02-13', '2026-02-24')).toBe(3);
  });

  it('整段法定假期 → 0 个工作日（国庆 10/1~10/7）', () => {
    expect(countWorkdaysInclusive('2026-10-01', '2026-10-07')).toBe(0);
  });

  it('单日：工作日 1 / 周末 0 / 假期 0 / 调休上班 1', () => {
    expect(countWorkdaysInclusive('2026-03-09', '2026-03-09')).toBe(1);
    expect(countWorkdaysInclusive('2026-03-07', '2026-03-07')).toBe(0);
    expect(countWorkdaysInclusive('2026-10-01', '2026-10-01')).toBe(0);
    expect(countWorkdaysInclusive('2026-10-10', '2026-10-10')).toBe(1); // 周六调休上班
  });

  it('★ 边界：start > end → 空（不抛错）；无该年数据 → 退化为纯周末判定', () => {
    expect(listWorkdaysInclusive('2026-03-09', '2026-03-06')).toEqual([]);
    expect(countWorkdaysInclusive('2026-03-09', '2026-03-06')).toBe(0);
    // 2030 无数据：周一算工作日、周六算周末
    expect(isWorkday('2030-01-07')).toBe(true); // 周一
    expect(isWorkday('2030-01-05')).toBe(false); // 周六
  });
});
