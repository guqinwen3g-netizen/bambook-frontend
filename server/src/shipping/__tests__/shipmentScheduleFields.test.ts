/**
 * shipmentScheduleFields.test.ts — ★ D5 真源单测：改期留痕字段（纯函数）
 *
 * 为什么单测这块（零基础障碍清单 D5）：
 *   甩柜/改船期是面料外贸最高频的异常，而 `update_shipment` 审计**只记 status+shipmentNumber**
 *   ⇒ 改 ETD/船名/港口全都查不到。修法是「逐字段留痕」，那「哪些字段算、怎么描述」
 *   就必须是一个可单测的真源 —— 否则「审计写了但字段没被追踪」会静默漏收。
 */
import { describe, expect, it } from 'vitest';
import {
  normalizeScheduleSnapshot,
  SHIPMENT_TRACKED_FIELDS,
  SHIPMENT_TRACKED_FIELD_KEYS,
  diffScheduleFields,
  describeScheduleChange,
  scheduleFieldLabel,
} from '../shipmentScheduleFields';

describe('SHIPMENT_TRACKED_FIELDS（受追踪字段）', () => {
  it('覆盖改期/物流的核心字段（漏一个就等于那一类改动查不到）', () => {
    for (const f of ['etd', 'eta', 'atd', 'ata', 'bookingDate', 'vesselOrFlight', 'voyageNumber', 'portOfLoading', 'portOfDischarge', 'containerNumber', 'sealNumber', 'status']) {
      expect(SHIPMENT_TRACKED_FIELD_KEYS, `缺字段 ${f}`).toContain(f);
    }
  });

  it('每个受追踪字段都有中文标签（UI 直接展示，不得出现英文裸字段名）', () => {
    for (const [k, label] of Object.entries(SHIPMENT_TRACKED_FIELDS)) {
      expect(label.length, `${k} 缺中文标签`).toBeGreaterThan(0);
      expect(label).not.toBe(k);
    }
  });

  it('未知字段原样返回（不猜、不乱贴标签）', () => {
    expect(scheduleFieldLabel('unknownField')).toBe('unknownField');
  });
});

describe('diffScheduleFields（从快照 diff 出真正变更的字段）', () => {
  it('① 只报**真正变化**的字段', () => {
    const r = diffScheduleFields(
      { etd: '2026-09-20', vesselOrFlight: 'MSC ANNA', eta: '2026-10-05' },
      { etd: '2026-09-27', vesselOrFlight: 'MSC ANNA', eta: '2026-10-05' },
    );
    expect(r).toEqual([{ field: 'etd', from: '2026-09-20', to: '2026-09-27' }]);
  });

  it('② 阳性对照：完全没变 → 空数组（不落噪音留痕）', () => {
    const snap = { etd: '2026-09-20', eta: '2026-10-05', status: 'Booked' };
    expect(diffScheduleFields(snap, { ...snap })).toEqual([]);
  });

  it('③ 真源口径**与写侧一致**：不自己做空串归一（否则真源会骗人）', () => {
    // ⓘ 我第一版把「'' 与 null 视作同一值」写进了 diff —— 但写侧 writeFieldAuditDiff 用的是
    //   JSON 浅比较（'' ≠ null），于是真源说"没变"、写侧却落了痕。**真源不能比写侧更聪明**。
    //   归一改放调用点（normalizeScheduleSnapshot）。
    expect(diffScheduleFields({ etd: null }, { etd: '' })).toEqual([{ field: 'etd', from: null, to: '' }]);
  });

  it('③b 调用点归一后：空串 vs null **不**报变更（避免 `— → —` 噪音）', () => {
    const before = normalizeScheduleSnapshot({ etd: null, sealNumber: 'SEAL-1' });
    const after = normalizeScheduleSnapshot({ etd: '', sealNumber: '' });
    expect(diffScheduleFields(before, after)).toEqual([{ field: 'sealNumber', from: 'SEAL-1', to: null }]);
  });

  it('③c 归一只作用于受追踪字段（不动无关字段）', () => {
    const r = normalizeScheduleSnapshot({ notes: '', etd: '' });
    expect(r.notes).toBe(''); // 无关字段保持原样
    expect(r.etd).toBeNull();
  });

  it('④ 值 ↔ null 算变更（清空一个字段也是变更，必须留痕）', () => {
    const r = diffScheduleFields({ etd: '2026-09-20' }, { etd: null });
    expect(r).toEqual([{ field: 'etd', from: '2026-09-20', to: null }]);
  });

  it('⑤ 只追踪受追踪字段（无关字段变化不产生留痕）', () => {
    const r = diffScheduleFields(
      { etd: '2026-09-20', notes: 'a', grossWeight: 100 },
      { etd: '2026-09-20', notes: 'b', grossWeight: 200 },
    );
    expect(r).toEqual([]);
  });

  it('⑥ 一次改多个字段 → 多条（甩柜常同时改 ETD+船名+航次）', () => {
    const r = diffScheduleFields(
      { etd: '2026-09-20', vesselOrFlight: 'MSC ANNA', voyageNumber: 'V001' },
      { etd: '2026-09-27', vesselOrFlight: 'MSC BOB', voyageNumber: 'V002' },
    );
    expect(r.map(x => x.field).sort()).toEqual(['etd', 'vesselOrFlight', 'voyageNumber']);
  });

  it('⑦ 可自定义追踪集合（复用同一 diff 逻辑，不另写一套）', () => {
    const r = diffScheduleFields({ etd: 'a', eta: 'b' }, { etd: 'c', eta: 'd' }, ['etd']);
    expect(r).toEqual([{ field: 'etd', from: 'a', to: 'c' }]);
  });
});

describe('describeScheduleChange（面向人的一句话）', () => {
  it('常规：中文标签 + 旧值 → 新值', () => {
    expect(describeScheduleChange('etd', '2026-09-20', '2026-09-27')).toBe('预计离港(ETD) 2026-09-20 → 2026-09-27');
  });

  it('空值显示 —（不把 null 直接摆到界面上）', () => {
    expect(describeScheduleChange('vesselOrFlight', null, 'MSC BOB')).toBe('船名/航班 — → MSC BOB');
    expect(describeScheduleChange('vesselOrFlight', 'MSC ANNA', null)).toBe('船名/航班 MSC ANNA → —');
    expect(describeScheduleChange('sealNumber', '', '')).toBe('封条号 — → —');
  });

  it('未知字段用原字段名（不猜中文）', () => {
    expect(describeScheduleChange('weird', 1, 2)).toBe('weird 1 → 2');
  });
});
