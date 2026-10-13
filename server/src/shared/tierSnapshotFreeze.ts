/**
 * B146 的**闸门实现**（v3.20 从 `bizStatusTierSnapshot.test.ts` 里抽出来）。
 *
 * 为什么要单独一份：v3.19 我只把"缺基线就自己生成"改成"要显式 flag"，然后**手测一次**就把结论写进台账 ——
 * 那正是这条闸门自己指控的病（一句没有常驻证人的判据，下批改代码时它会静默消失）。
 * ⇒ 把决策做成**可注入依赖的纯函数**：文件系统与"有没有授权"都是传进来的，
 *   于是守卫可以用**替身**跑一遍，断言"到达副作用的调用到底发生了没有"（而不是断言源码里写了某个 if）。
 *
 * ⚠️ 本文件被 import 时不碰任何盘（无副作用），所以它能在门禁里被反复调用而不会污染工作树。
 */
export type TierBaselineDeps = {
  /** 基线文件在不在磁盘上 */
  exists: boolean;
  /** 操作方有没有显式授权首冻（`TIER_SNAPSHOT_FREEZE=1`） */
  authorized: boolean;
  read: () => string;
  write: (payload: string) => void;
  payload: () => string;
};

export type TierBaselineOutcome =
  | { kind: 'loaded'; text: string }
  | { kind: 'frozen'; text: string };

/** 缺基线 + 未授权 ⇒ 抛（这一条就是 B146 的牙）；缺基线 + 已授权 ⇒ 写并如实报 `frozen`。 */
export function resolveTierBaseline(d: TierBaselineDeps): TierBaselineOutcome {
  if (d.exists) return { kind: 'loaded', text: d.read() };
  if (!d.authorized) {
    throw new Error(
      'ABORT（B146）：基线不存在，且没给 TIER_SNAPSHOT_FREEZE=1 ⇒ 不能"这一跑自己生成、又拿它当期望值比对"（那是恒真断言）。'
      + '要首冻请显式跑：TIER_SNAPSHOT_FREEZE=1 npx vitest run src/shared/__tests__/bizStatusTierSnapshot.test.ts，'
      + '并把生成结果连同本轮改动一起交人复核后再提交。',
    );
  }
  d.write(d.payload());
  return { kind: 'frozen', text: d.read() };
}
