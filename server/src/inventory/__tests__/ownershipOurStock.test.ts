/**
 * ownershipOurStock.test.ts — ★ C6 真源守卫：货权 4 档 + 「我方存货」合并判据
 *
 * 为什么要有（零基础障碍清单 C6「寄售/在途库存」）：
 *   原枚举只有 `Owned`/`Transferred` ⇒ 面料外贸两类**货权仍属我方但不在自己仓里**的货无处可标：
 *     · 寄售（货在客户/海外仓，卖出才结算）
 *     · 在途（已发运未到货）
 *   标不出来的后果二选一都是错账：塞进 `Owned` ⇒ 我方存货**虚高且看不出能不能马上用**；
 *   塞进 `Transferred` ⇒ 我方存货**静默少算**。
 *
 * 判据：① 枚举 4 档齐全 + 标签齐全（漏一个 = 那一档在界面上显示英文裸值）
 *      ② `countsAsOurStock` 是**单点真源**（汇总/UI/徽标都读它）
 *      ③ 未知档位按**不计入**（不把不知道的东西算进存货）
 */
import { describe, expect, it } from 'vitest';
import {
  INVENTORY_OWNERSHIP,
  OWNERSHIP_LABELS,
  OWNERSHIP_COUNTS_AS_OUR_STOCK,
  countsAsOurStock,
} from '../inventoryOwnershipService';

describe('C6 货权枚举（4 档）', () => {
  it('① 枚举含寄售与在途', () => {
    expect([...INVENTORY_OWNERSHIP].sort()).toEqual(['Consignment', 'InTransit', 'Owned', 'Transferred']);
  });

  it('② 每档都有中文标签（漏一个 = 界面显示英文裸值）', () => {
    for (const k of INVENTORY_OWNERSHIP) {
      expect(OWNERSHIP_LABELS[k], `${k} 缺标签`).toBeTruthy();
      expect(OWNERSHIP_LABELS[k]).not.toBe(k);
    }
  });

  it('③ 标签要写明「货权仍属我方」（否则业务员会误以为寄售/在途不算我们的货）', () => {
    expect(OWNERSHIP_LABELS.Consignment).toContain('货权仍属我方');
    expect(OWNERSHIP_LABELS.InTransit).toContain('货权仍属我方');
  });
});

describe('countsAsOurStock（计入我方存货的判据真源）', () => {
  it('① 可用 / 寄售 / 在途 计入；已转移 不计入', () => {
    expect(countsAsOurStock('Owned')).toBe(true);
    expect(countsAsOurStock('Consignment')).toBe(true);
    expect(countsAsOurStock('InTransit')).toBe(true);
    expect(countsAsOurStock('Transferred')).toBe(false);
  });

  it('② 缺省/空白视为 Owned（历史数据没有该字段 ⇒ 我方货权，与全库口径一致）', () => {
    expect(countsAsOurStock(null)).toBe(true);
    expect(countsAsOurStock(undefined)).toBe(true);
    expect(countsAsOurStock('   ')).toBe(true);
  });

  it('★ ③ 未知档位 → **不计入**（不把不知道的东西算进存货）', () => {
    expect(countsAsOurStock('Weird')).toBe(false);
    expect(countsAsOurStock('owned')).toBe(false); // 大小写敏感（枚举是精确值）
  });

  it('★ ④ 判据表必须覆盖枚举全集（漏一档 = 该档在汇总里被静默丢掉）', () => {
    for (const k of INVENTORY_OWNERSHIP) {
      expect(Object.keys(OWNERSHIP_COUNTS_AS_OUR_STOCK), `判据表缺 ${k}`).toContain(k);
    }
  });
});
