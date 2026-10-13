/**
 * B131 的**文案级快照守卫**（v3.11，复核 MAJOR 之后补的）
 *
 * ★ 为什么要有它：我 v3.11 第一版在台账里准备写"改前 176 条掉兜底、改后只动 3 条"，
 *   而量出这些数的一次性脚本**用完就删了** ⇒ 那句话没人能复跑，等于把可证伪的读数写成了一句信仰
 *   （同族教训：`棘轮基线要有外部见证者`）。复核还手算复现了一遍，得到的是**另一组数**（209/146）
 *   ⇒ 说明口径没写清楚。本文件把"口径"和"读数"一起钉住：判据只有一份实现（就是 `statusFromError` 本身）。
 *
 * ⚠️ 这份快照**看不见**的东西（口径边界，必须连同读数一起引用）：
 *   · AST 绑定实际构造器/工厂，按 super(message) 的真实参数采文案；不把 code-first 的码当文案。
 *     动态/未知形状进入 unresolved 库存，纯内部标记单列；静态文案的关键词档位不等于 typed HTTP 状态。
 *   · 完全**不覆盖运行时才知道的错误对象** ⇒ 尤其 2c（TypeError/SyntaxError/ReferenceError ⇒ 500）在这一族里**读数恒为 0**，
 *     因为生产代码里没有一句 `throw new TypeError(...)`（实测 grep = 0）—— 它接住的是 Node/Prisma 自己抛的崩溃。
 *     ⇒ 所以"本快照 0 条改档"**绝不等于**"2c 没有影响"，两句话永远要一起说。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { statusFromError } from '../bizStatus';
import { resolveTierBaseline } from '../tierSnapshotFreeze';
import { scanTierMessageSources, legacyTierMessageSources, TIER_MESSAGE_MEASUREMENT } from '../../../../scripts/lib/tierMessageSources.mjs';

const REPO = join(process.cwd(), '..');                  // vitest 的 cwd 是 server/ ⇒ 仓根在其上一级
const FIXTURE = join(REPO, 'scripts', 'baselines', 'tier-message-snapshot.json');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { if (!['__tests__', 'node_modules', 'dist'].includes(name)) walk(p, out); }
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const sources = () => walk(join(process.cwd(), 'src')).map(f => ({
  file: relative(process.cwd(), f).split('\\').join('/'), src: readFileSync(f, 'utf8'),
}));
// The old raw meter remains visible for old/new fixed-source adjudication;
// counts are not silently moved to this corrected measurement's denominator.
const entries = sources();
const sourceReport = scanTierMessageSources(entries);
const historicalRows = legacyTierMessageSources(entries);
/** `file|message` 去重；关键词档位仅测试文案规则，不冒充 typed 合同状态。 */
function corpus(): Array<{ k: string; tier: number }> {
  return sourceReport.publicLiterals.map((row: { file: string; message: string }) => ({
    k: `${row.file}|${row.message.trim()}`, tier: statusFromError(new Error(row.message.trim())),
  })).sort((a: { k: string }, b: { k: string }) => a.k.localeCompare(b.k));
}

const hist = (rows: Array<{ tier: number }>) =>
  rows.reduce<Record<string, number>>((a, r) => { a[r.tier] = (a[r.tier] || 0) + 1; return a; }, {});

describe('B131 · 文案级档位快照（外部见证者：读数可一键重跑）', () => {
  const rows = corpus();

  it('① 分母非空且口径写死在这里：扫不到抛错文案 = 尺在空转，任何"改动很小"都不作数', () => {
    expect(rows.length, `语料只有 ${rows.length} 条 ⇒ 扫描根/正则配错了`).toBeGreaterThan(150);
    // 口径自检：同一份语料里必须能同时看到"掉兜底"与"有档"的两类，否则分布解读没有意义
    const h = hist(rows);
    expect(h[400] && h[404] && h[409], `分布缺桶就不是同一把尺：${JSON.stringify(h)}`).toBeTruthy();
  });

  it('② 分布与基线逐桶相等（新增掉兜底的文案 ⇒ 红，逼来重冻结并说明为什么）', () => {
    /**
       * ★ B146（v3.19 复核抓到、我复量成立）：这一支过去**没有刹车** —— 基线一缺席就直接 `writeFileSync`，
       *   紧接着拿"刚写进去的数"当期望值比对 ⇒ 该格在那一跑是恒真断言；而且落点是仓内被跟踪的文件，
       *   一次"红→删→再跑"就能静默把另一道闸门的真源补出来。
       * ★ v3.20（v3.19 复核 I3）：闸门逻辑搬进 `shared/tierSnapshotFreeze.ts`，为的是让它有**常驻证人**
       *   （见下面那组注入替身用例）。v3.19 我只在这里写了 `expect(env).toBe('1')` + 手测一次 ——
       *   把那句 expect 删掉什么都不会红，那正是这条闸门自己指控的病。
       * ⚠️ 加了 flag 之后"首冻那一跑"仍然是自我印证（结构上不可能不是：没有旧读数可对）；
       *    区别只是它现在是一次**显式操作**且当场打印这句话。真正的证据是第二跑。
       */
    const payload = () => JSON.stringify({
      _readme: 'B131 文案级快照基线。重跑：cd server && npx vitest run src/shared/__tests__/bizStatusTierSnapshot.test.ts -t "打印"。'
        + '口径见该文件头部与绑定扫描器；message-only 档位不等于 typed HTTP；动态和内部来源分别保留库存。'
        + '★ 首冻要显式：删掉本文件后必须带 TIER_SNAPSHOT_FREEZE=1 才重新生成（B146，无 flag ⇒ 红，不许静默自我印证）。',
      files: 'server/src（排除 __tests__ 目录与 *.test.ts / *.d.ts）',
      count: rows.length, byTier: hist(rows),
      measurement: TIER_MESSAGE_MEASUREMENT,
      sourceInventory: sourceReport.accounting,
      historicalRawCount: historicalRows.length,
    }, null, 1) + '\n';
    const outcome = resolveTierBaseline({
      exists: existsSync(FIXTURE),
      authorized: process.env.TIER_SNAPSHOT_FREEZE === '1',
      read: () => readFileSync(FIXTURE, 'utf8'),
      write: (p) => writeFileSync(FIXTURE, p),
      payload,
    });
    if (outcome.kind === 'frozen') {
      console.log('[B131 快照] ★ 首冻已生成：本格的比对在这一跑是**自我印证**（期望 = 刚写的读数）⇒ 绿不算证据，下一跑才有牙');
    }
    const base = JSON.parse(outcome.text);
    expect(rows.length, `语料条数与基线不符（基线 ${base.count}）⇒ 有人新增/删除了抛错文案，或扫描口径变了`).toBe(base.count);
    expect(hist(rows), `档位分布与基线不符 ⇒ 本批改动动了静态文案的档位（要的是逐条说明，不是重冻结了事）`).toEqual(base.byTier);
  });

  it('③ 2c 在本快照里必须**恒不可见**（这条就是防止有人拿"0 改动"当"2c 没影响"）', () => {
    const producerRows = rows.filter((r) => /TypeError|SyntaxError|ReferenceError/.test(r.k));
    expect(producerRows.map((r) => r.k),
      '生产代码里出现了显式 throw new TypeError 一类 ⇒ 上面注释里那句"2c 在本快照恒读 0"要重写').toEqual([]);
  });

  it('（打印用）把当前分布与掉兜底的样例打出来，重冻结前先看清楚', () => {
    console.log('[B131 快照] 条数', rows.length, '分布', JSON.stringify(hist(rows)));
    console.log('[B131 来源分账]', TIER_MESSAGE_MEASUREMENT, JSON.stringify(sourceReport.accounting),
      'typed records', sourceReport.typedContracts.length, 'old raw regex', historicalRows.length);
    console.log('[B131 unresolved 样例]', sourceReport.unresolved.slice(0, 8));
    console.log(rows.filter((r) => r.tier === 400).slice(0, 8).map((r) => '  ' + r.k.slice(0, 90)).join('\n'));
  });

  it('AST 来源库存必须完整分账，动态文案不能从分母静默消失', () => {
    const counts = sourceReport.accounting;
    const baseline = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    expect(counts, '每一分支须与外置来源基线对撞；不能仅以总和自洽掩盖动态来源消失').toEqual(baseline.sourceInventory);
    expect(counts.total).toBe(counts['public-message'] + counts['typed-contract'] + counts.internal + counts.unresolved);
    expect(counts.total).toBeGreaterThan(rows.length);
    expect(sourceReport.typedContracts.length).toBeGreaterThan(0);
    expect(sourceReport.internal.length).toBeGreaterThan(0);
    expect(sourceReport.unresolved.length).toBeGreaterThan(0);
    expect(sourceReport.unresolved.every((row: { file: string; line: number; reason: string }) =>
      row.file && row.line > 0 && row.reason)).toBe(true);
  });

  it('相同桶数不能掩盖文案替换：固定来源的完整file/message/tier身份须相等', () => {
    const baseline = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    expect(baseline._sourceEvidence.sourceHead).toMatch(/^[0-9a-f]{40}$/);
    expect(baseline.corpusSha256).toMatch(/^[0-9a-f]{64}$/);
    const digest = (items: typeof rows) => createHash('sha256').update(JSON.stringify(items)).digest('hex');
    expect(digest(rows)).toBe(baseline.corpusSha256);
    // Same length and same tier histogram, but a changed literal, must fail.
    const substitute = rows.map((row, index) => index ? row : { ...row, k: `${row.k} altered` });
    expect(substitute).toHaveLength(rows.length);
    expect(hist(substitute)).toEqual(hist(rows));
    expect(digest(substitute)).not.toBe(baseline.corpusSha256);
  });
});

/**
 * ★★ B146 的**常驻证人**（v3.20，v3.19 复核 I3：闸门只有"手测一次"= 没有证人）。
 *   这组用例全程不落盘：文件系统的读与写都是**注入的替身**，断言的是"到底有没有到达写这个副作用"。
 *   ⇒ 谁把 `resolveTierBaseline` 里那句"未授权就抛"删掉，`缺基线 + 未授权` 这一格当场红（v3.19 版删了什么都不会红）。
 */
describe('B146 · 首冻闸门的牙齿（注入替身，不碰任何真源）', () => {
  const stub = (text = '{"count":1,"byTier":{"400":1}}\n') => {
    const calls: string[] = [];
    return {
      calls,
      read: () => { calls.push('read'); return text; },
      write: (payload: string) => { calls.push('write:' + payload); },
      payload: () => 'PAYLOAD-1',
    };
  };
  const writes = (calls: string[]) => calls.filter((c) => c.startsWith('write')).length;

  it('缺基线 + 未授权 ⇒ 抛，且**一次写都没有**（★ 这一格就是 v3.19 缺的那位证人）', () => {
    const d = stub();
    expect(() => resolveTierBaseline({ exists: false, authorized: false, ...d }))
      .toThrow(/B146.*TIER_SNAPSHOT_FREEZE/s);
    expect(writes(d.calls), '未授权的那一跑发生了写盘 ⇒ 闸门形同虚设（B146 的病就是这么来的）').toBe(0);
  });

  it('基线在 ⇒ 只读不写、如实报 loaded（**正常路径不许顺手改真源**）', () => {
    const d = stub();
    const out = resolveTierBaseline({ exists: true, authorized: false, ...d });
    expect(out.kind).toBe('loaded');
    expect(writes(d.calls), '跑一次守卫就把基线写一遍 ⇒ 棘轮会被自己的门禁刷新').toBe(0);
    expect(JSON.parse(out.text).count, 'loaded 必须把磁盘上那份交回去（不是重新算的）').toBe(1);
  });

  it('缺基线 + 已授权 ⇒ 恰好写一次、如实报 frozen，并明说"这一跑是自我印证"', () => {
    const d = stub();
    const out = resolveTierBaseline({ exists: false, authorized: true, ...d });
    expect(writes(d.calls), '授权路径没写盘 ⇒ 首冻做不了').toBe(1);
    expect(d.calls[0], '写的必须是 payload() 给的内容（不是别处再抄一份序列化）').toBe('write:PAYLOAD-1');
    expect(out.kind).toBe('frozen');
    expect(JSON.parse(out.text).count).toBe(1);
  });

  it('★ 反空转对照：把"未授权也放行"这个突变放回去 ⇒ 上面第一格必须红（证人真的有牙）', () => {
    // 这一格不测生产代码，测的是**这组用例自己**：用一个故意没有闸门的假实现跑同一条断言，必须失败。
    const noGate = (d: { read: () => string; write: (p: string) => void; payload: () => string }) => {
      d.write(d.payload()); return { kind: 'frozen' as const, text: d.read() };
    };
    const d = stub();
    expect(() => resolveTierBaseline({ exists: false, authorized: false, ...d })).toThrow();      // 真实现：抛
    const d2 = stub();
    expect(() => noGate(d2)).not.toThrow();                                                        // 假实现：不抛
    expect(writes(d2.calls), '假实现写了盘 ⇒ 说明"没有闸门"确实会走到写，第一格不是空断言').toBe(1);
  });
});
