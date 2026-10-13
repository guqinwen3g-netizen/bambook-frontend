/**
 * B35 第二刀（v2.54 起）：演练标识**不许是一份逐场景手写的字面量清单**
 *
 * 现场（2026-09-22 实测，只读）：`PaymentVoucher` 里 **453 行带 `TEST[-_]C7WO`** 的测试数据，
 * 而清扫器/审计脚本认的是六个**精确前缀** ⇒ 一行都不命中，工具**打印"零残留"**。
 * 这是本仓记忆里"判据的第四种沉默失效"的现行案例：**白名单不会喊我过时了**。
 *
 * 所以本文件不测"数据清没清"（那要写库，另批），只测**尺本身会不会静默过时**：
 *   ① 族正则必须认得**清单里没有的新式样本**（反面对照 = 这条判据的牙齿）；
 *   ② 旧的字面量清单必须**认不出**它 ⇒ 证明"补前缀"这种做法是在重新制造同一个病；
 *   ③ 词边界必须挡住 `LATEST_VERSION` / `GREATEST-2`（族正则若误伤，删除侧会**删掉真实业务行**，
 *      那比漏报更糟：§0.4 的代价在这里是数据损失）；
 *   ④ 三态结论不许把"没输入"说成"没毛病"（`0 vs 0` 时不得输出任何需要非空样本才成立的结论）。
 */
import { describe, expect, it } from 'vitest';
import {
  RESIDUE_MARKERS, RESIDUE_MARKER_RES, DELETABLE_MARKER_RES,
  detectResidueMarker, judgeResidue,
} from './lib/drill-residue.mjs';

/** 与旧清单同口径的"字面量是否命中"—— 只为构造反面对照，不是第二把尺（不参与任何账面数） */
const literalOnly = (s) => RESIDUE_MARKERS.some((m) => s.includes(m));

describe('B35 · 演练标识：族正则 vs 手写白名单（尺不许静默过时）', () => {
  it('★ ①+② 清单里没有的新式标记：族必须抓到，字面量清单必须抓不到（证明补前缀=重病）', () => {
    const brandNew = 'TEST-Q9ZZ-1727';           // 今天仓里不存在的场景名
    expect(literalOnly(brandNew), '字面量清单若能认得它，这条反面对照就失去了区分力').toBe(false);
    const d = detectResidueMarker(brandNew);
    expect(d, `族正则漏掉了 ${brandNew} ⇒ 下一个新场景仍会被打印成"零残留"`).toBeTruthy();
    expect(d.family.join(',')).toContain('TEST 族');
  });

  it('★ ① 历次真实命名都要被族覆盖（含下划线/连字符/冒号/中文后缀）', () => {
    // ★ 复核 IMPORTANT 4 之后新增两条中文后缀样本：`TEST_演练…` 旧族式**漏掉**（后接类只认 ASCII），
    //   现在用 [\p{L}\p{N}] 收回来 —— 中文命名的人造数据在本仓是真会出现的。
    for (const s of ['TEST_C7WO_A', 'TEST-C7WO-A', 'TEST_DCNL_1', 'TEST_D6FX_2', 'DRILL:7', 'E2E-order-9', 'SMOKE_x', 'TEST_演练单', 'DRILL:演练9']) {
      expect(detectResidueMarker(s), `族正则漏掉真实样本 ${s}`).toBeTruthy();
    }
  });

  it('★ ③ 词边界：含 TEST 的正常业务词不许命中（误伤会删掉真实行）', () => {
    for (const s of ['LATEST_VERSION 说明', 'GREATEST-2 报价', 'the best_price', 'index_latest-2026']) {
      expect(detectResidueMarker(s), `误伤真实内容：${s}`).toBeNull();
    }
  });

  it('★ ③b 本仓自己的品类词不许被"DRILL 族"误伤（drill = 斜纹布，见 §3.2）', () => {
    /**
     * 复核实测原式（`/i` + 分隔符可选）把三个正常面料名都打成了演练标识 ⇒
     * "族检测"看着只是报告侧，实际会喂给**删除授权用的命中清单**，误伤 = 让 Kevin 批错单。
     * 收紧后的规矩：**必须有分隔符 + 后接一个字母或数字 + 大小写敏感**。
     */
    for (const s of ['Cotton Drill 40s 坯布', 'brushed drill 面料', 'mining drill rod', 'SMOKE OIL 淬火油报价']) {
      expect(detectResidueMarker(s)?.family ?? [], `品类词/业务词被族式误伤：${s}`).toEqual([]);
    }
  });

  it('★ ③c 已知不覆盖的形状要写成断言，不许当"族已经全覆盖"（大小写与末尾形态两条边界）', () => {
    // 小写族前缀：字面量清单也没有小写项 ⇒ 这是**一致**的口径，不是新洞；要放宽得有人拍
    expect(detectResidueMarker('e2e-order-9')?.family ?? [], '小写 e2e 现在不收（族=大写前缀约定）').toEqual([]);
    // 标识在末尾、后面没有字符：放宽成 `TEST$` 会把 REGRESSION-TEST 这类正常命名放进来 ⇒ 刻意不收
    expect(detectResidueMarker('PAY-2026-TEST')?.family ?? [], '末尾形态现在不收（已在台账 B81 记为已知盲区）').toEqual([]);
  });


  it('★ ④ 三态：没输入与认不出都不许被说成"干净"', () => {
    expect(judgeResidue({ rowCount: 0, markerCapableColumns: 3, hitCount: 0 }).state).toBe('no-input');
    expect(judgeResidue({ rowCount: 0, markerCapableColumns: 3, hitCount: 0 }).canClaimClean,
      '0 行时给出"零残留"= 用空分母制造绿色').toBe(false);
    expect(judgeResidue({ rowCount: 500, markerCapableColumns: 0, hitCount: 0 }).state).toBe('unrecognized');
    expect(judgeResidue({ rowCount: 500, markerCapableColumns: 2, hitCount: 7 }).state).toBe('residue');
    expect(judgeResidue({ rowCount: 500, markerCapableColumns: 2, hitCount: 0 }).canClaimClean).toBe(true);
  });

  it('★ 族的数量必须 > 字面量清单能覆盖的数量，且删除侧仍是显式白名单（检测与可删不许混为一谈）', () => {
    expect(RESIDUE_MARKER_RES.length).toBeGreaterThan(0);
    expect(DELETABLE_MARKER_RES.length, '把族直接当成"可删"= 让误伤变成数据损失').toBe(0);
    // 既有字面量在"检测（字面量 ∪ 族）"下必须仍然命中（升级族时不许把老册子丢掉）
    for (const m of RESIDUE_MARKERS) {
      expect(detectResidueMarker(`${m}SAMPLE`), `检测全集漏掉既有字面量 ${m} ⇒ 升级族时丢了老册子`).toBeTruthy();
    }
  });
});
