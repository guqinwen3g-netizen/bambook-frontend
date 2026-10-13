import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { reportingService } from './reportingService';

const ENDPOINT = 'https://test.example.com';
const sectionSource = readFileSync(new URL('../components/finance/MonthlyCloseSection.tsx', import.meta.url), 'utf8');
const panelSource = readFileSync(new URL('../components/finance/FinanceReportsPanel.tsx', import.meta.url), 'utf8');

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
    clear: vi.fn(() => { values.clear(); }),
  };
}

describe('reportingService（REQ2-17 月末结转 contract，DR-058）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('localStorage', createStorage());
    vi.stubGlobal('sessionStorage', createStorage());
  });

  it('runMonthlyClose POST /v1/reports/monthly-close（携带 periodKey）', async () => {
    const fetchMock = vi.fn(async (..._args: any[]) => ({
      ok: true,
      json: async () => ({ periodKey: '2026-07', total: 2, ran: 2, skipped: 0, failed: 0, results: [] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const r = await reportingService.runMonthlyClose('2026-07', ENDPOINT);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/reports/monthly-close');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ periodKey: '2026-07' });
    expect(r.ran).toBe(2);
  });

  it('compareMonthlyClose GET /monthly-close/compare?periodKey=', async () => {
    const fetchMock = vi.fn(async (..._args: any[]) => ({
      ok: true,
      json: async () => ({ periodKey: '2026-07', previousPeriodKey: '2026-06', items: [] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const r = await reportingService.compareMonthlyClose('2026-07', ENDPOINT);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/reports/monthly-close/compare?periodKey=2026-07');
    expect(r.previousPeriodKey).toBe('2026-06');
  });

  it('失败响应透传 error code（NO_MONTHLY_DEFINITIONS → 404）', async () => {
    const fetchMock = vi.fn(async (..._args: any[]) => ({
      ok: false,
      status: 404,
      json: async () => ({ error: { code: 'NO_MONTHLY_DEFINITIONS', message: '无可结转的月度报表定义' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(reportingService.runMonthlyClose('2026-07', ENDPOINT))
      .rejects.toMatchObject({ status: 404, code: 'NO_MONTHLY_DEFINITIONS' });
  });
});

describe('MonthlyCloseSection REQ2-17（DR-058 UI 契约）', () => {
  it('月份选择（默认上一个完整月）+ 一键结转（bdsConfirm 确认 + 幂等提示）+ 刷新对比', () => {
    expect(sectionSource).toContain('previousMonthKey()');
    expect(sectionSource).toContain('type="month"');
    expect(sectionSource).toContain('一键结转');
    expect(sectionSource).toContain("'确认月末结转'");
    expect(sectionSource).toContain('已结转的定义自动跳过，不覆盖历史');
    expect(sectionSource).toContain('刷新对比');
  });

  it('对比表：本期/上期/Δ/Δ% 四列 + 缺上期提示 + Δ% null 不除零显示', () => {
    expect(sectionSource).toContain("item.current ? `${item.current.rowCount} 行快照` : '本期未结转'");
    expect(sectionSource).toContain('上期未结转（Δ 无基线）');
    expect(sectionSource).toContain('fmtPct(d.deltaPct)');
    expect(sectionSource).toContain('function fmtPct(v: number | null)');
  });

  it('挂载：FinanceReportsPanel 报表 tab 新增月末结转子 tab', () => {
    expect(panelSource).toContain("{ id: 'monthly-close', label: '月末结转', en: 'Monthly Close' }");
    expect(panelSource).toContain("import MonthlyCloseSection from './MonthlyCloseSection'");
    expect(panelSource).toContain("{tab === 'monthly-close' && <MonthlyCloseSection");
  });
});

/**
 * ★ 跨层对撞守卫（空值红线，2026-09-25）
 *
 * 缺陷原形：上期（或本期）快照缺失时，后端把合计回落 `0` ⇒ Δ = 本期全额，
 * 前端同屏一边挂「上期未结转（Δ 无基线）」徽章、一边把上期显示成 `0`、Δ 显示 `+75`。
 * 「没有取到数」被渲染成「上期是 0、环比暴涨」——违反「「0」≠「没取到」」明令。
 *
 * 这里把两侧钉在一起：任一侧退回旧行为即红，避免只修一头造成新的跨层漂移。
 */
describe('★ 跨层对撞：月度对比 Δ 空值红线（后端 null ⇔ 前端「—」）', () => {
  const backendSource = readFileSync(new URL('../server/src/reporting/monthlyCloseService.ts', import.meta.url), 'utf8');

  it('后端：快照缺失侧一律 null，不得回落 0', () => {
    expect(backendSource).toContain('current == null ? null :');
    expect(backendSource).toContain('previous == null ? null :');
    // 反面：旧的 `?? 0` 兜底一旦回来就红
    expect(backendSource).not.toContain('current?.totals?.[col] ?? 0');
    expect(backendSource).not.toContain('previous?.totals?.[col] ?? 0');
    // delta/deltaPct 必须随"不可计算"一起为 null
    expect(backendSource).toContain('const computable = cur != null && prev != null;');
    expect(backendSource).toContain('computable && prev !== 0');
  });

  it('后端：判据是"快照是否存在"，不是"合计是否为 0"（真零仍要算）', () => {
    // 若改回 `prev === 0 → delta 也 null`，真零月份的 Δ 算术会被误杀 ⇒ 钉住真零分支仍在
    expect(backendSource).toContain('computable && prev !== 0 && delta != null');
    expect(backendSource).toMatch(/Math\.round\(\(delta \/ Math\.abs\(prev\)\) \* 10000\) \/ 100/);
  });

  it('前端：fmtNum 对 null/undefined/NaN 一律渲染「—」（Δ 为 null 时不会显示 0）', () => {
    expect(sectionSource).toContain('if (v == null || !Number.isFinite(v)) return \'—\';');
    // Δ 列必须走 fmtNum，不能裸拼数字
    expect(sectionSource).toContain('{fmtNum(d.delta)}');
    expect(sectionSource).toContain('{fmtNum(d.previous)}');
    expect(sectionSource).toContain('{fmtNum(d.current)}');
  });

  it('前端：无基线徽章判据与后端 null 同义（item.previous == null）', () => {
    expect(sectionSource).toContain('item.previous == null');
    expect(sectionSource).toContain('上期未结转（Δ 无基线）');
  });
});
