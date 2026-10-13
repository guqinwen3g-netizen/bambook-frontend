/**
 * sampleShipmentHistory.test.ts — ★ C5 真源单测：寄样历史（追加式）
 *
 * 为什么单测这块（零基础障碍清单 C5「分批寄样」· 实测订正）：
 *   三个寄样入口里**只有早产样**支持分批寄样（`attachments.rounds[]` 追加），
 *   面料取样与成衣轮次原来是**覆盖式**（只留最后一次）⇒ 客户问"上次那批什么时候寄的"查不到。
 *   C5 把后两者对齐成追加式 ⇒ 「追加 / 取最后一次 / 有界」这三件事必须可单测。
 */
import { describe, expect, it } from 'vitest';
import {
  appendShipmentHistory,
  latestShipmentOf,
  shipmentCountOf,
  totalShippingFeeOf,
  isMultiShipment,
  SHIPMENT_HISTORY_LIMIT,
  type SampleShipmentEntry,
} from '../sampleShipmentHistory';

const E = (sentDate: string, over: Partial<SampleShipmentEntry> = {}): SampleShipmentEntry =>
  ({ sentDate, courier: 'SF', trackingNumber: `T-${sentDate}`, shippingFee: 10, ...over });

describe('appendShipmentHistory（追加，不覆盖）', () => {
  it('① 追加到已有历史尾部（最旧在前）', () => {
    const r = appendShipmentHistory([E('2026-09-01')], E('2026-09-10'));
    expect(r.history.map(h => h.sentDate)).toEqual(['2026-09-01', '2026-09-10']);
    expect(r.truncated).toBe(false);
  });

  it('② 非数组/undefined → 视为空历史（历史数据没有该字段时不炸）', () => {
    for (const v of [undefined, null, {}, 'x', 0]) {
      expect(appendShipmentHistory(v, E('2026-09-01')).history).toHaveLength(1);
    }
  });

  it('③ 不修改入参（纯函数）', () => {
    const arr = [E('2026-09-01')];
    const before = JSON.stringify(arr);
    appendShipmentHistory(arr, E('2026-09-10'));
    expect(JSON.stringify(arr)).toBe(before);
  });

  it('★ ④ 有界：超过上限丢**最旧**的，且显式上报截断（不静默丢）', () => {
    const full = Array.from({ length: SHIPMENT_HISTORY_LIMIT }, (_, i) => E(`2026-01-${String(i + 1).padStart(2, '0')}`));
    const r = appendShipmentHistory(full, E('2026-12-31'));
    expect(r.history).toHaveLength(SHIPMENT_HISTORY_LIMIT);
    expect(r.truncated).toBe(true);
    expect(r.droppedCount).toBe(1);
    expect(r.history[r.history.length - 1].sentDate).toBe('2026-12-31'); // 新的仍在
    expect(r.history[0].sentDate).toBe('2026-01-02');                    // 最旧的被丢
  });
});

describe('latestShipmentOf（取最后一次）', () => {
  it('① 按 sentDate 取最新（与数组顺序无关）', () => {
    const r = latestShipmentOf([E('2026-09-01'), E('2026-09-20'), E('2026-09-10')]);
    expect(r!.sentDate).toBe('2026-09-20');
  });

  it('② 同一天多次寄样 → 按 shippedAt 取更晚的', () => {
    const r = latestShipmentOf([
      E('2026-09-01', { shippedAt: 100, courier: '早' }),
      E('2026-09-01', { shippedAt: 200, courier: '晚' }),
    ]);
    expect(r!.courier).toBe('晚');
  });

  it('★ ③ 空历史 → null（**不猜**一个空对象）', () => {
    expect(latestShipmentOf([])).toBeNull();
    expect(latestShipmentOf(undefined)).toBeNull();
    expect(latestShipmentOf({})).toBeNull();
  });
});

describe('统计口径', () => {
  it('shipmentCountOf：非数组 → 0', () => {
    expect(shipmentCountOf([E('a')])).toBe(1);
    expect(shipmentCountOf(undefined)).toBe(0);
  });

  it('totalShippingFeeOf：非数值/非正数不计入', () => {
    const r = totalShippingFeeOf([
      E('a', { shippingFee: 10 }),
      E('b', { shippingFee: null }),
      E('c', { shippingFee: -5 }),
      E('d', { shippingFee: 2.5 }),
    ]);
    expect(r).toBe(12.5);
  });

  it('isMultiShipment：≥2 次才算分批寄样', () => {
    expect(isMultiShipment([E('a')])).toBe(false);
    expect(isMultiShipment([E('a'), E('b')])).toBe(true);
  });
});
