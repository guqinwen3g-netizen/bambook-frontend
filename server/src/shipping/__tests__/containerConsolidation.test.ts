/**
 * containerConsolidation.test.ts — ★ C1 真源守卫：柜内矛盾检测（纯函数）
 *
 * 为什么单测这块（零基础障碍清单 C1）：
 *   拼柜（一柜多票）**必须同船、同航次、同目的港、同时离港**。
 *   而系统此前对「同柜但 ETD/目的港/船名不一致」**完全没有任何提示** ——
 *   填错了要等报关或客户查货才发现（一次改单代价远大于一条提示）。
 *
 * 判据：
 *   ① 单票柜 → 无矛盾（没有「一致性」可言）
 *   ② 四类字段各自不一致 → 各自一条，消息里带**冲突值 + 涉及票号**
 *   ③ ★ **空值不参与**（未填 ≠ 不一致 —— 宁可漏报，不可误报）
 *   ④ 全部一致 → 空数组（阳性对照：守卫不是恒真）
 *   ⑤ 大小写/首尾空白差异视为同一值（trim 归一）
 */
import { describe, expect, it } from 'vitest';
import { detectConsolidationConflicts, type ContainerShipmentRef } from '../containerConsolidationService';

const S = (over: Partial<ContainerShipmentRef> & { shipmentNumber: string }): ContainerShipmentRef => ({
  id: `id-${over.shipmentNumber}`,
  etd: '2026-09-20',
  portOfDischarge: 'ROTTERDAM',
  vesselOrFlight: 'MSC ANNA',
  voyageNumber: 'V001',
  ...over,
});

describe('detectConsolidationConflicts（柜内一致性）', () => {
  it('① 单票柜 → 无矛盾', () => {
    expect(detectConsolidationConflicts([S({ shipmentNumber: 'S1' })])).toEqual([]);
    expect(detectConsolidationConflicts([])).toEqual([]);
  });

  it('④ 阳性对照：两票完全一致 → 无矛盾（守卫不是恒真）', () => {
    expect(detectConsolidationConflicts([S({ shipmentNumber: 'S1' }), S({ shipmentNumber: 'S2' })])).toEqual([]);
  });

  it('② ETD 不一致 → ETD_MISMATCH，消息含冲突值与票号', () => {
    const r = detectConsolidationConflicts([
      S({ shipmentNumber: 'S1', etd: '2026-09-20' }),
      S({ shipmentNumber: 'S2', etd: '2026-09-27' }),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].code).toBe('ETD_MISMATCH');
    expect(r[0].values).toEqual(['2026-09-20', '2026-09-27']);
    expect(r[0].shipmentNumbers).toEqual(['S1', 'S2']);
    expect(r[0].message).toContain('拼柜必须同');
  });

  it('② 四类字段同时不一致 → 四条（各自独立）', () => {
    const r = detectConsolidationConflicts([
      S({ shipmentNumber: 'S1' }),
      S({ shipmentNumber: 'S2', etd: '2026-09-21', portOfDischarge: 'HAMBURG', vesselOrFlight: 'MSC BOB', voyageNumber: 'V002' }),
    ]);
    expect(r.map(c => c.code).sort()).toEqual(
      ['DISCHARGE_PORT_MISMATCH', 'ETD_MISMATCH', 'VESSEL_MISMATCH', 'VOYAGE_MISMATCH'].sort(),
    );
  });

  it('③ ★ 空值不参与（未填 ≠ 不一致，宁可漏报不可误报）', () => {
    const r = detectConsolidationConflicts([
      S({ shipmentNumber: 'S1', etd: '2026-09-20' }),
      S({ shipmentNumber: 'S2', etd: null }),
      S({ shipmentNumber: 'S3', etd: '   ' }),
    ]);
    expect(r).toEqual([]);
  });

  it('③b 一方有值、其余为空 → 仍不算不一致', () => {
    const r = detectConsolidationConflicts([
      S({ shipmentNumber: 'S1', portOfDischarge: null }),
      S({ shipmentNumber: 'S2', portOfDischarge: 'ROTTERDAM' }),
    ]);
    expect(r).toEqual([]);
  });

  it('⑤ 首尾空白差异视为同一值（trim 归一）', () => {
    const r = detectConsolidationConflicts([
      S({ shipmentNumber: 'S1', portOfDischarge: ' ROTTERDAM ' }),
      S({ shipmentNumber: 'S2', portOfDischarge: 'ROTTERDAM' }),
    ]);
    expect(r).toEqual([]);
  });

  it('多值（3 票 3 个 ETD）→ 一条冲突，values 三个', () => {
    const r = detectConsolidationConflicts([
      S({ shipmentNumber: 'S1', etd: '2026-09-20' }),
      S({ shipmentNumber: 'S2', etd: '2026-09-21' }),
      S({ shipmentNumber: 'S3', etd: '2026-09-22' }),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].values).toEqual(['2026-09-20', '2026-09-21', '2026-09-22']);
  });
});
