/**
 * B126 普查尺进门禁（v3.10）——「catch 里的 HTTP 档位是谁定的」从**人肉数**变成**派生 + 棘轮**
 *
 * ★ 为什么必须有它：§9 B126 写着"未做全仓普查 ⇒ 数出来再谈收口"，而本族反复出现的病是
 *   **同一条判档规则被抄成第 N 份**（`msg.includes('不存在') ? 404 : …` 就是把真尺
 *   `statusFromError` 的关键词档手写复制；`e?.code === 'X' ? 409 : 500` 是复制注册表第 2 档）。
 *   不收口可以，但债有多大必须有一个**可跑读数**，否则下一批还是"凭印象说几处"。
 *
 * ★ 这把尺**不判对错**：catch 里写 `res.status(401)` 可能完全正确。它只回答"这个档位是谁定的"，
 *   所以本批**不声称**任何一族的档位答错，也**不声称** B126 达标 —— 只把数钉住、把新增堵死。
 *
 * ★ 五条反静默失效的设计（照 `g41-write-surface.test.ts` 的既有范式）：
 *   ① 分母非空（扫不到文件/落点 ⇒ 判据恒真，先红）；
 *   ② 分桶必须加得回总数（加不回去 = 有一桶被悄悄吞了）；
 *   ③ `unclassified` 必须为 0 ⇒ 出现认不出的形状就逼表态，不许"看不见=没有"；
 *   ④ sites 与基线**逐条相等**（双向：新增 ⇒ 红；消失 ⇒ 必须同批重冻结并说是哪一族收的口）；
 *   ⑤ **越界探针**：catch 之外的片段级读数必须等于基线 ⇒ 防"把写死的档位挪出 catch 来躲这把尺"。
 *
 * ⚠️ 已知盲区写在基线的 knownBlindSpots 里（间接常量映射、字符串拼装的 status 等），不要引用本读数说"穷尽"。
 */
import { describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, symlinkSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enumerateTierLandingPoints, enumerateWide, scanSourceText, scanSourceEntries, summarize, renderBucketsForDoc, tierSiteKey } from './lib/errorTierHardcodes.mjs';

/**
 * ★ B205（v3.102 修）：本文件每条用例都 spawn 子进程 / 建临时 git 仓，满并发 + 机器负载下单测实测可到 4278ms
 *  （v3.102 那次恰好压在 5s 档下；v3.83 的两次标准命令红里它是红的三份之一）⇒ 只给这一族抬阈值
 *  （30s，与 server/vitest.config.ts 同值），不动根域全局 —— 全局抬会把"真挂住"一起掩护掉。
 */
vi.setConfig({ testTimeout: 30_000 });

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = JSON.parse(readFileSync(join(REPO, 'scripts/baselines/error-tier-hardcodes.json'), 'utf8'));
const { files, points } = enumerateTierLandingPoints(REPO);
const sum = summarize(points);
const wide = enumerateWide(REPO);
const key = tierSiteKey; // ★ v3.14（B134）：原先这里和写手各抄一份键的字面量 ⇒ 收成 lib 里那一份
const kindDrift = (base: Record<string, number>, fresh: Record<string, number>) =>
  [...new Set([...Object.keys(base), ...Object.keys(fresh)])].filter(kind => (base[kind] ?? 0) !== (fresh[kind] ?? 0));

describe('B126 · catch 里定档的站点是派生的，且新增必须当场红', () => {
  it('① 分母非空：扫不到源码/落点 ⇒ 这把尺在空转，任何"覆盖率/债的规模"都不作数', () => {
    expect(files.length, `扫到 ${files.length} 个源文件 ⇒ 路径配错了（应约 477）`).toBeGreaterThanOrEqual(400);
    expect(sum.total, '一条落点都没有 ⇒ 判据恒真').toBeGreaterThanOrEqual(300);
  });

  it('② 分桶加得回总数，**且每一桶都必须与冻结基线逐桶相等**（复核 M-1：只把 byKind 求和与 points.length 比是**恒等式**，两边同源、永远绿）', () => {
    const s = Object.values(sum.byKind as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(s, JSON.stringify(sum.byKind)).toBe(sum.total);
    const baseKinds = BASELINE.byKind as Record<string, number>;
    const freshKinds = sum.byKind as Record<string, number>;
    const drifted = kindDrift(baseKinds, freshKinds);
    expect(drifted.map((k) => `${k}: 基线 ${baseKinds[k] ?? 0} → 实测 ${freshKinds[k] ?? 0}`),
      '分桶数与基线不符 ⇒ 基线是外置见证者，改数必须同批重冻结并说明原因').toEqual([]);
  });

  it('分桶漂移负控：相同总数下交换桶、增加新桶、删除旧桶都必须被发现', () => {
    expect(kindDrift({ literalStatus: 2, tierArg: 1 }, { literalStatus: 1, tierArg: 2 })).toEqual(['literalStatus', 'tierArg']);
    expect(kindDrift({ literalStatus: 1 }, { literalStatus: 1, unclassified: 1 })).toEqual(['unclassified']);
    expect(kindDrift({ literalStatus: 1, tierArg: 1 }, { literalStatus: 1 })).toEqual(['tierArg']);
    expect(kindDrift({ literalStatus: 1 }, { literalStatus: 1 })).toEqual([]);
  });

  it('仅本地Error构造器中已验证的public status参数算tierArg；名字、注释、无关金额参数不能冒充', () => {
    const run = (declaration: string, expression: string) => scanSourceText('probe.ts', `${declaration}\nasync function operation() { try { await work(); } catch(e) { ${expression}; } }`).map((point: any) => point.kind);
    expect(run('class LocalError extends Error { constructor(public code:string, message:string, public status=400){super(message)} }', "throw new LocalError('CONFLICT', 'retry', 409)")).toEqual(['tierArg']);
    expect(run('class LocalError extends Error { constructor(public code:string, message:string, public amount=400){super(message)} }', "throw new LocalError('X', 'value', 409)")).toEqual(['unclassified']);
    expect(run('// class LocalError extends Error { constructor(public code:string, message:string, public status=400){} }', "throw new LocalError('X', 'value', 409)")).toEqual(['unclassified']);
    expect(run('class LocalError extends OtherBase { constructor(public code:string, message:string, public status=400){super(message)} }', "throw new LocalError('X', 'value', 409)")).toEqual(['unclassified']);
    expect(run('class LocalError extends Error { constructor(public code:string, public amount:number, public status:number){super(code)} }', "throw new LocalError('X', 409, runtimeStatus)")).toEqual(['unclassified']);
    expect(run('class LocalError extends Error { constructor(public code:string, message:string, public status=400){super(message)} }', "const LocalError = OtherConstructor; throw new LocalError('X', 'value', 409)")).toEqual(['unclassified']);
  });

  it('③ unclassified 必须为 0：新形状要逼表态，不许"看不见 = 没有"', () => {
    const rows = points.filter((p: any) => p.kind === 'unclassified');
    expect(rows.map(key), `出现认不出的定档形状 ${rows.length} 处 ⇒ 要么归类、要么写明为什么不算`).toEqual([]);
    // ★ 覆盖面**实测**（复核 m-1 说"只有 fail/respond 那一窄族会进 unclassified"—— 我照它写了断言，结果**它错了**：
    //   任何"带档位字面量的调用实参"都掉进 unclassified，与被叫函数叫什么无关。教训同族：复核给的判断也要复量。）
    expect(scanSourceText('p.ts', 'async function h(req: any, res: any) { try { await f() } catch (e: any) { weirdHelper(e, 500) } }').map((p: any) => p.kind),
      '陌生的助手名 + 档位实参 ⇒ 必须逼表态进 unclassified').toEqual(['unclassified']);
    // 但仍然**不是万能**：语句里完全没有档位字面量时 classify 返回 null（隐形），例如档位从别的文件常量引进来。
    expect(scanSourceText('p.ts', 'async function h(req: any, res: any) { try { await f() } catch (e: any) { res.status(SERVER_ERROR_CONST).json({}) } }').map((p: any) => p.kind),
      '常量间接引用（字面量在别处）扫不到 ⇒ 已登记为盲区，别把 ③ 说成"任何新形状都会红"').toEqual([]);
  });

  it('④ sites 与基线**逐条相等**（新增 ⇒ 红；消失 ⇒ 同批重冻结并说明是哪一族收口）', () => {
    const now = points.map(key).sort();
    const base = [...BASELINE.sites].sort();
    expect(now.filter((k: string) => !base.includes(k)), '新增了手写档位的落点').toEqual([]);
    expect(base.filter((k: string) => !now.includes(k)), '基线里的条目不见了 ⇒ 收口了就来重冻结（并同步 §9 B126 的数）').toEqual([]);
    expect(now.length).toBe(BASELINE.totals.landingPoints);
  });

  it('④b 基线里每条站点的文件都必须还存在（防基线本身变假账）', () => {
    const missing = [...new Set(BASELINE.sites.map((k: string) => k.split(':')[0]))].filter((f: string) => !existsSync(join(REPO, f)));
    expect(missing, '基线登记了不存在的文件 ⇒ 行号/路径已经腐烂').toEqual([]);
  });

  it('⑤ 棘轮：债务桶只许下降、接尺桶只许上升', () => {
    for (const [kind, cap] of Object.entries(BASELINE.ratchet.caps)) {
      expect(sum.byKind[kind] ?? 0, `${kind} 比基线多了 ${(sum.byKind[kind] ?? 0) - (cap as number)} 处 ⇒ 新写了手写档位`).toBeLessThanOrEqual(cap as number);
    }
    for (const [kind, floor] of Object.entries(BASELINE.ratchet.floors)) {
      expect(sum.byKind[kind] ?? 0, `${kind} 低于下限 ${floor} ⇒ 有人把"走真尺"改回写死`).toBeGreaterThanOrEqual(floor as number);
    }
  });

  it('⑥ 越界探针：catch 之外的片段读数必须与基线相等（不许靠"挪出 catch"让主尺变小）', () => {
    expect(wide.length, 'catch 之外的定档片段数变了 ⇒ 要么有人把写死的档位搬出 catch（主尺会假降），要么扫描范围变了').toBe(BASELINE.ratchet.wideFragmentsMustEqual);
  });

  it('⑦ 已接真尺的站必须在册（B124 那几站不许被悄悄改回写死）', () => {
    const rulerFiles = new Set(points.filter((p: any) => p.kind === 'rulerFallback').map((p: any) => p.file));
    for (const must of ['customs/customsRouteV2.ts', 'quotations/quotationRoute.ts', 'customs/customsRoute.ts', 'mes/mesRoute.ts']) {
      expect([...rulerFiles].some((f: string) => f.endsWith(must)), `${must} 不再走 statusFromError ⇒ 档位真源被绕过（B124 回归）`).toBe(true);
    }
    expect(BASELINE.rulerSites.length).toBeGreaterThanOrEqual(7);
  });

  it('⑧ 台账里那句数必须等于当场实测（文档与尺**双向**对撞，防"基线重冻结了、文档还写着旧数"）', () => {
    expect(BASELINE.sites.length, '基线自身的自洽：sites 条数必须等于 totals.landingPoints').toBe(BASELINE.totals.landingPoints);
    const doc = readFileSync(join(REPO, 'docs/交付目标与验收标准-2026-09-20.md'), 'utf8');
    const row = doc.split('\n').find((l) => l.startsWith('| **B126**'));
    expect(row, '权威基准里找不到 B126 那一行 ⇒ 立账丢了，本尺就成了无主读数').toBeTruthy();
    // ★ 锚是显式记号 `[B126-COUNT]落点**N**`，不是"行里第一个 **N**"（同一行有 6/3/54 等多枚加粗数，会顶错）
    const claimed = /\[B126-COUNT\]落点\*\*(\d+)\*\*/.exec(row!);
    expect(claimed, 'B126 行里没有 `[B126-COUNT]落点**N**` 这个机器锚 ⇒ 数没法与尺对撞').toBeTruthy();
    expect(Number(claimed![1]), '台账写的落点数 ≠ 尺当场数出来的').toBe(sum.total);
    expect(row, 'B126 行必须写明"这把尺不判对错"，否则 463 会被读成 463 个 bug').toMatch(/不判对错|不许读成/);
  });

  /**
   * ★ ⑧b 分桶那句也必须与尺对撞（v3.12 复核 B-1 点破的漏洞）：
   *   本批收了 6 处 ⇒ `codeKey 24→20`、`rulerFallback 7→13`，而**总落点 538 一个字没变**
   *   ⇒ 上面那条 ⑧ 一路绿，台账却整批写着旧数。只比总数 = 半个判据。
   */
  it('⑧b 台账里的**分桶**句必须与尺当场渲染的相等（锚 [B126-BUCKETS]）', () => {
    const doc = readFileSync(join(REPO, 'docs/交付目标与验收标准-2026-09-20.md'), 'utf8');
    const row = doc.split('\n').find((l) => l.startsWith('| **B126**'));
    const claimed = /\[B126-BUCKETS\]桶\*\*([^*]+)\*\*/.exec(row!);
    expect(claimed, 'B126 行没有 `[B126-BUCKETS]桶**…**` 锚 ⇒ 分桶数无法与尺对撞（收口改了桶却看不见）').toBeTruthy();
    expect(claimed![1].trim(), '台账写的分桶数 ≠ 尺当场数出来的').toBe(renderBucketsForDoc(sum.byKind));
    // 恒真检查：渲染函数若整个坏掉（返回空串），上面那条会退化成"锚里必须有东西"
    expect(renderBucketsForDoc({}).startsWith('literalStatus 0 / tierArg 0'), '渲染器坏了 ⇒ 对撞成恒真').toBe(true);
  });
});

describe('B126 · 绑定的状态转发来源（不按 helper 或参数名白名单）', () => {
  const klass = `export class NativeFault extends Error {
    constructor(public code:string, message:string, public statusCode:number) { super(message); }
  }`;
  const forwarder = `export function abort(code:string, message:string, tier:number):never { throw new NativeFault(code, message, tier); }`;
  const handler = (body: string, parameter = '') => `async function handle(${parameter}) { try { await work(); } catch(e) { ${body}; } }`;
  const run = (declaration: string, body = "abort('CONFLICT', 'safe', 503)", parameter = '') =>
    scanSourceText('local.ts', `${declaration}\n${handler(body, parameter)}`);
  const pair = (consumer = `export async function consume(context:{stop(code:string,message:string,status:number):never}) {
      try { await work(); } catch(e) { context.stop('CONFLICT', 'safe', 409); }
    }`, caller = 'await consume({stop: abort});', producer = `${klass}\n${forwarder}`) => [
    { file: 'producer.ts', src: `${producer}\nimport {consume as importedConsumer} from './consumer';\nasync function caller() { ${caller.replace(/\bconsume\(/g, 'importedConsumer(')} }` },
    { file: 'consumer.ts', src: consumer },
  ];
  const consumerRows = (entries: Array<{file:string;src:string}>) => scanSourceEntries(entries).filter((row: any) => row.file === 'consumer.ts');

  it('本地转发到真实 public statusCode：任意名称与不在第三位的状态参数都按 binding 证明', () => {
    const rows = run(`${klass}\n${forwarder}`);
    expect(rows.map((row: any) => row.kind)).toEqual(['tierArg']);
    expect(rows[0].tiers).toEqual([503]);
    expect(rows[0].statusEvidence).toMatchObject([
      { file: 'local.ts', kind: 'public-error-status', field: 'statusCode', parameterIndex: 2 },
      { file: 'local.ts', kind: 'status-forwarder', parameterIndex: 2 },
    ]);
    expect(run(`${klass}\nfunction differentlyNamed(tier:number, code:string, message:string) { throw new NativeFault(code,message,tier); }`, "differentlyNamed(409,'CONFLICT','safe')").map((row: any) => row.kind)).toEqual(['tierArg']);
    expect(run(`${klass}\nconst abort = (code:string,message:string,tier:number):never => { throw new NativeFault(code,message,tier); };`).map((row: any) => row.kind)).toEqual(['tierArg']);
  });

  it('移除真实状态字段/构造来源/转发，文案或同名 helper 均不能留在 tierArg', () => {
    const variants = [
      `${klass.replace('public statusCode:number', 'public amount:number')}\n${forwarder}`,
      `${klass}\n${forwarder.replace('new NativeFault(code, message, tier)', 'new ForeignConstructor(code, message, tier)')}`,
      `${klass}\n${forwarder.replace('new NativeFault(code, message, tier)', 'new NativeFault(code, message, externalStatus)')}`,
      `${klass}\n${forwarder.replace('throw new NativeFault(code, message, tier)', 'unverified(code,message,tier); throw new NativeFault(code,message,tier)')}`,
      `// ${forwarder}\n${klass}`,
      `${klass.replace('super(message);', 'super(message); this.statusCode = 200;')}\n${forwarder}`,
      `class Error {}\n${klass}\n${forwarder}`,
    ];
    for (const source of variants) expect(run(source).map((row: any) => row.kind)).toEqual(['unclassified']);
  });

  it('局部遮蔽、可变 function 重绑定和动态状态实参不会冒用已知声明', () => {
    expect(run(`${klass}\n${forwarder}`, "abort('CONFLICT','safe',503)", 'abort:any').map((row: any) => row.kind)).toEqual(['unclassified']);
    expect(run(`${klass}\n${forwarder}\nabort = other;`).map((row: any) => row.kind)).toEqual(['unclassified']);
    expect(run(`${klass}\n${forwarder}\nNativeFault = OtherConstructor;`).map((row: any) => row.kind)).toEqual(['unclassified']);
    expect(run(`${klass}\n${forwarder}`, "const abort = other; abort('CONFLICT','safe',503)").map((row: any) => row.kind)).toEqual(['unclassified']);
    expect(run(`${klass}\n${forwarder}`, "abort('CONFLICT','safe',runtimeStatus)")).toEqual([]); // Existing literal-free blind spot stays explicit.
    expect(run(`${klass}\n${forwarder}`, "abort(...parameters,503)").map((row: any) => row.kind)).toEqual(['unclassified']);
  });

  it('跨文件 import 别名和真实参数对象 caller 闭合到同一 status 构造器', () => {
    const rows = consumerRows(pair());
    expect(rows.map((row: any) => row.kind)).toEqual(['tierArg']);
    expect(rows[0].statusEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: 'producer.ts', kind: 'public-error-status', field: 'statusCode' }),
      expect.objectContaining({ file: 'producer.ts', kind: 'callback-supplied', parameterIndex: 0, property: 'stop' }),
      expect.objectContaining({ file: 'consumer.ts', kind: 'callback-parameter', property: 'stop' }),
    ]));
    const inputs = pair();
    expect(scanSourceText('consumer.ts', inputs[1].src, {sourceEntries: inputs}).map((row: any) => row.kind)).toEqual(['tierArg']);
    const modified = inputs[1].src.replace('context.stop(', 'unknown.stop(');
    expect(scanSourceText('consumer.ts', modified, {sourceEntries: inputs}).map((row: any) => row.kind)).toEqual(['unclassified']);
    // A type annotation alone supplies no real status consumer.
    expect(consumerRows([inputs[1]]).map((row: any) => row.kind)).toEqual(['unclassified']);
  });

  it('任何未知 caller、动态对象/回调、spread 或重复属性令参数来源未证实', () => {
    for (const caller of [
      'await consume({stop: unknownCallback});', 'await consume(unknownObject);',
      'await consume({stop: abort}); await consume({stop: unknownCallback});',
      'await consume({stop: abort, ...unknownObject});', 'await consume({stop: abort, stop: unknownCallback});',
      'await consume({[property]: abort});', 'await consume(...unknownArguments);',
      'await consume({stop: abort}); expose(importedConsumer);',
    ]) expect(consumerRows(pair(undefined, caller)).map((row: any) => row.kind)).toEqual(['unclassified']);
  });

  it('参数重赋值、属性覆盖、逃逸和索引访问保持 unknown；实际绑定名称相同也不够', () => {
    const base = pair()[1].src;
    for (const statement of ['context = unknownObject;', 'context.stop = unknownCallback;', 'expose(context);', 'const alias = context;']) {
      const input = pair(base.replace('try {', `${statement} try {`));
      expect(consumerRows(input).map((row: any) => row.kind)).toEqual(['unclassified']);
    }
    const shadowed = base.replace('context.stop(', '(function(context:any){ context.stop(').replace("409); }", '409); })(unknownObject); }');
    expect(consumerRows(pair(shadowed)).map((row: any) => row.kind)).toEqual(['unclassified']);
    expect(consumerRows(pair(base.replace('context.stop(', "context['stop']("))).map((row: any) => row.kind)).toEqual(['unclassified']);
    expect(consumerRows(pair(base, 'await consume({stop: abort});', `${klass}\n${forwarder.replace('public ', '')}\nabort = unknownCallback;`)).map((row: any) => row.kind)).toEqual(['unclassified']);
  });

  it('主尺与宽尺使用同一来源证明；没有删除字面量分母，常量间接引用仍明确不可见', () => {
    const inputs = pair();
    const before = consumerRows([inputs[1]]), after = consumerRows(inputs);
    expect(after.map((row: any) => [row.file,row.line,row.tiers])).toEqual(before.map((row: any) => [row.file,row.line,row.tiers]));
    const src = `${klass}\n${forwarder}\nfunction outsideCatch() { abort('CONFLICT','safe',409); }`;
    const wideRows = scanSourceText('local.ts', src, {wide:true});
    expect(wideRows.some((row: any) => row.kind === 'tierArg' && row.tiers.includes(409))).toBe(true);
    expect(scanSourceText('local.ts', src.replace("abort('CONFLICT','safe',409)", "abort('CONFLICT','safe',IMPORTED_STATUS)"), {wide:true}).length).toBeLessThan(wideRows.length);
  });
});

/* ── 分类器自己的正负对照（同一把尺、内存里跑，不碰仓库文件）──────────────────────
 * 为什么单列：①–⑦ 只保证"与基线一致"，如果分类器整体坏了（全判成 0 落点），④ 会因为
 * "两边都空"而**假绿**。这一组是"尺自己还得会认形状"的证据。 */
describe('B126 · 分类器正负对照（缺一侧就是恒绿/恒红的尺）', () => {
  const one = (body: string) => scanSourceText('probe.ts', `async function h(req: any, res: any) { try { await f() } catch (e: any) { ${body} } }`);
  const kinds = (body: string) => one(body).map((p: any) => p.kind);

  it('正面：五种定档形状各自落进对的桶', () => {
    expect(kinds(`res.status(500).json({ error: 'x' })`), '纯写死').toEqual(['literalStatus']);
    expect(kinds(`const s = msg.includes('不存在') ? 404 : 500; res.status(s).json({})`), '抄关键词档').toEqual(['keywordCopy']);
    expect(kinds(`res.status(e?.code === 'NO_REVIEWER_RESOLVED' ? 409 : 500).json({})`), '按 code 自己分支').toEqual(['codeKey']);
    expect(kinds(`res.status(e?.statusCode ?? 500).json({})`), '信被捕获对象自带的 statusCode').toEqual(['passthroughStatusCode']);
    expect(kinds(`return fail(res, 500, 'X_FAILED', e?.message)`), '档位当实参传给助手').toEqual(['tierArg']);
    expect(kinds(`res.status(statusFromError(e, 500)).json({})`), '走真尺 ⇒ 只算兜底档').toEqual(['rulerFallback']);
  });

  it('负面：文案里的三位数与长度截断都**不算**落点（否则清单会被日志刷满）', () => {
    expect(kinds(`logger.warn('越权审计写入失败（不阻断 403）', { error: e?.message })`), '日志文案里的 403 不是档位').toEqual([]);
    expect(kinds(`const m = String(e?.message ?? e).slice(0, 500)`), '.slice(0,500) 是长度不是档位').toEqual([]);
    expect(kinds(`// 见 station :132 的写法\n      logger.error('boom')`), '注释里的行号不是档位').toEqual([]);
  });

  it('★ 复核 B-1 补的两格：接尺**不给兜底档**与"档位藏在变量里"都必须被记到（旧版两处都读成 0 落点）', () => {
    expect(kinds(`res.status(statusFromError(e)).json({ error: e?.message })`),
      '`statusFromError(e)` 没有字面量 ⇒ 旧版直接判"不是落点"，于是我把 83 处接尺读成 7 处').toEqual(['rulerNoFallback']);
    expect(kinds(`const myTier = 500; res.status(myTier).json({})`),
      '档位先存进变量、这行只用 ⇒ 旧版整条隐形（复核 M-2），"把新增堵死"就成了空话').toEqual(['tierViaVariable']);
    expect(kinds(`const s2 = msg.includes('x') ? 404 : 500; res.status(s2).json({})`),
      '定义句已被记为 keywordCopy ⇒ 使用处**不许**再记一次（一处决策只算一个落点）').toEqual(['keywordCopy']);
  });

  it('★ 复核 m-2 补的：字符串里的假 `catch {` 不许造出监听范围（结构扫描跑在抹过字符串的副本上）', () => {
    expect(scanSourceText('p.ts', `function f() { const s = 'please catch {this} and note 500'; return s }`),
      '文案里的 catch/{ 与 500 都不该产生落点').toEqual([]);
  });

  it('★ 尺不许慢成隐形成本（整树扫描是 O(n)，曾经因为递归切片挂死 >3 分钟）', () => {
    const t0 = Date.now();
    const r = enumerateTierLandingPoints(REPO);
    const ms = Date.now() - t0;
    expect(r.points.length, '扫描没数出东西').toBeGreaterThan(300);
    expect(ms, `整树扫描用了 ${ms}ms ⇒ 量级失控（基线时代码里就有 500+ 文件/20ms 级）`).toBeLessThan(8000);
  });

  it('突变自检：把 `statusFromError(e, 500)` 换成裸 `500` ⇒ 必须从 rulerFallback 变成 literalStatus', () => {
    // 这一条是"尺真能区分接没接尺"的证据。若两句话读出来的桶相同，说明 ⑦ 那条站名断言是空的。
    expect(kinds(`res.status(statusFromError(e, 500)).json({})`)).toEqual(['rulerFallback']);
    expect(kinds(`res.status(500).json({})`)).toEqual(['literalStatus']);
  });

  it('★ 接了尺的 catch 里，**读尺结果**的比较不算第二处定档（rulerConsumer 与 debt 分开）', () => {
    const rows = one(`const status = statusFromError(e, 500); if (status >= 500) log(); res.status(status).json({ error: status === 404 ? 'NF' : 'IE' })`);
    expect(rows.map((r: any) => r.kind).filter((k: string) => k === 'rulerConsumer').length, '两条"读尺"应当被认成 rulerConsumer').toBe(2);
    expect(rows.some((r: any) => r.kind === 'keywordCopy'), '不许把 `status === 404 ? 字符串` 误判成抄关键词档').toBe(false);
  });
});

/**
 * ★★ B134（v3.14）：重冻结写手必须分得清"行号搬家"与"真多了一处手写档位"
 *
 * 病（本批自己撞出来的）：claims 域只是给 catch **上方**补了两行注释 ⇒ 两条 `literalStatus` 的行号 +2 ⇒
 * 守卫 ④ 报"新增了手写档位的落点"。这条红本身是对的，**危险的是修法**：`--write` 一下它就没了 ——
 * 与"真的新写了一处手写档位"是同一个动作、同一个结果。当时判定"这是搬家"的证据只有一段人眼看的 diff，
 * 也就是说"重冻结没把新债吸收掉"这件事**只有操作者的自我声明**在担保（§2 G3 给这类病立的判据：不可证伪的"没问题"）。
 *
 * G4.1 的写手从 v3.12（B132）起就有这道闸门；这份写手一直没有 ⇒ 同一种修法只补了一个写手（B134）。
 *
 * ★ 下面三格是**真跑子进程**（不是读源码文案）：在临时 git 仓里造一份两文件的假树，
 *   把 `freeze-error-tier-baseline.mjs` 的 cwd 指过去，看它的退出码与基线文件的字节有没有变。
 *   假树只有几个文件 ⇒ 每次跑 ≈ 0.2s，不占真库、不碰本树基线。
 */
const FREEZE = join(REPO, 'scripts/freeze-error-tier-baseline.mjs');
const BL_REL = join('scripts', 'baselines', 'error-tier-hardcodes.json');
const ROUTE_A = (head: string) => `${head}export function handlerA(req: any, res: any) {
  try {
    doWork(req);
  } catch (e: any) {
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
}
`;
const ROUTE_B = `export function handlerB(req: any, res: any) {
  try {
    doOther(req);
  } catch (e: any) {
    return res.status(404).json({ error: 'NOT_FOUND' });
  }
}
`;

/** 造一个"已经首冻过一次"的临时仓：假树 1 个文件 1 条落点 ⇒ 返回仓目录与基线路径 */
function freshFrozenRepo(tag: string) {
  const dir = mkdtempSync(join(tmpdir(), `b134-${tag}-`));
  mkdirSync(join(dir, 'server', 'src', 'fake'), { recursive: true });
  mkdirSync(join(dir, dirname(BL_REL)), { recursive: true }); // ★ 只建**目录**（BL_REL 是文件路径）
  writeFileSync(join(dir, 'server/src/fake/aRoute.ts'), ROUTE_A('// 原始文件\n'));
  const g = (args: string[]) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' });
  expect(g(['init', '-q']).status, '临时仓 git init 失败 ⇒ 下面的子进程判据全部无意义').toBe(0);
  expect(g(['add', '-A']).status).toBe(0);
  expect(g(['commit', '-q', '--allow-empty', '-m', 'base']).status).toBe(0);
  // ★ v3.18 起写手**默认不写盘**（B144）⇒ 夹具这里必须显式 --write，否则「首冻落盘」这一步就空了
  const first = runFreeze(dir, ['--write']);
  expect(first.code, `首冻就该成功，实得 exit ${first.code}：${first.err || first.out}`).toBe(0);
  expect(existsSync(join(dir, BL_REL)), '首冻没落盘 ⇒ 后面的对撞没有对象').toBe(true);
  return { dir, bl: join(dir, BL_REL), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function runFreeze(dir: string, args: string[]) {
  const r = spawnSync('node', [FREEZE, ...args], { cwd: dir, encoding: 'utf8', timeout: 120_000 });
  expect(r.error, `跑不动 freeze ${args.join(' ')}：${r.error?.message}`).toBeUndefined();
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}
function runFreezeIn(cwdDir: string, args: string[]) {
  // ★ B147：这条专门用来跑"**cwd 不在仓根**"的形状（v3.19 复核实测：从 server/ 里跑相对 --out ⇒ 守卫与证人一起指空）
  const r = spawnSync('node', [FREEZE, ...args], { cwd: cwdDir, encoding: 'utf8', timeout: 120_000 });
  expect(r.error, `跑不动 freeze(in ${cwdDir}) ${args.join(' ')}：${r.error?.message}`).toBeUndefined();
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}
const readBl = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
/** ★ 本树真基线的**导入时**快照：下面 ④ 用它抓"临时仓的跑动有没有溢回主树"（必须在任何用例之前抓） */
const REAL_BASELINE_RAW = readFileSync(join(REPO, BL_REL), 'utf8');

describe('B134 · 重冻结写手：行号搬家自动过，集合真变了必须签字（真跑子进程）', () => {
  it('写手⑰ 集合签字不能提高历史 cap，下降后再新增仍保持更严上限', () => {
    const { dir, bl, cleanup } = freshFrozenRepo('cap-history');
    try {
      writeFileSync(join(dir, 'server/src/fake/bRoute.ts'), ROUTE_B);
      expect(runFreeze(dir, ['--write', '--allow-set-change=新增来源仅登记集合，仍须独立收债']).code).toBe(0);
      const expanded = readBl(bl);
      expect(expanded.byKind.literalStatus).toBe(2);
      expect(expanded.ratchet.caps.literalStatus).toBe(1);
      expect(expanded._baselineHistory.at(-1).ratchet.caps.literalStatus).toBe(1);
      // 收到 0 后再添加同类站点，不得把 cap 从 0 恢复成 1。
      writeFileSync(join(dir, 'server/src/fake/aRoute.ts'), 'export const done = true;\n');
      writeFileSync(join(dir, 'server/src/fake/bRoute.ts'), 'export const alsoDone = true;\n');
      expect(runFreeze(dir, ['--write', '--allow-set-change=两站实际退休并留旧判据']).code).toBe(0);
      expect(readBl(bl).ratchet.caps.literalStatus).toBe(0);
      writeFileSync(join(dir, 'server/src/fake/aRoute.ts'), ROUTE_A(''));
      expect(runFreeze(dir, ['--write', '--allow-set-change=恢复站点但不抬历史债务上限']).code).toBe(0);
      expect(readBl(bl).byKind.literalStatus).toBe(1);
      expect(readBl(bl).ratchet.caps.literalStatus).toBe(0);
    } finally { cleanup(); }
  });

  it('写手⑱ floor 真实退休须显式理由和逐站记录；历史 floor 不抹，不能拿无来源旧 floor 降限', () => {
    const { dir, bl, cleanup } = freshFrozenRepo('floor-retirement');
    try {
      writeFileSync(join(dir, 'server/src/fake/aRoute.ts'), ROUTE_A('').replace('res.status(500)', 'res.status(statusFromError(e, 500))'));
      expect(runFreeze(dir, ['--write', '--allow-set-change=接入统一档位消费']).code).toBe(0);
      const ruled = readBl(bl);
      expect(ruled.ratchet.floors.rulerFallback).toBe(1);
      writeFileSync(join(dir, 'server/src/fake/aRoute.ts'), 'export const delegatedToTypedBoundary = true;\n');
      const before = readFileSync(bl, 'utf8');
      expect(runFreeze(dir, ['--write']).code).toBe(1);
      expect(readFileSync(bl, 'utf8')).toBe(before);
      // 这里只证明写手留下退休身份和旧判据；新的生产出口仍需独立行为审定。
      expect(runFreeze(dir, ['--write', '--allow-set-change=原调用退休，typed消费者需另证']).code).toBe(0);
      const after = readBl(bl);
      expect(after.ratchet.floors.rulerFallback).toBe(0);
      expect(after._floorRetirements.at(-1).retirements[0]).toMatchObject({
        kind: 'rulerFallback', before: 1, after: 0,
        retired: [{ signature: 'server/src/fake/aRoute.ts#rulerFallback', count: 1, priorSites: ruled.rulerSites }],
      });
      expect(after._baselineHistory.at(-1).ratchet.floors.rulerFallback).toBe(1);
      after.ratchet.floors.rulerFallback = 2;
      writeFileSync(bl, JSON.stringify(after));
      const invalidBefore = readFileSync(bl, 'utf8');
      const unproven = runFreeze(dir, ['--write', '--allow-set-change=仅声明退休，无对应来源']);
      expect(unproven.code).toBe(1);
      expect(unproven.err).toContain('足量逐站退休记录');
      expect(readFileSync(bl, 'utf8')).toBe(invalidBefore);
    } finally { cleanup(); }
  });

  it('写手⑲ 完整等号理由与历史放行记录在无变化重冻后仍在；重复理由参数拒绝', () => {
    const { dir, bl, cleanup } = freshFrozenRepo('signoff-history');
    try {
      writeFileSync(join(dir, 'server/src/fake/bRoute.ts'), ROUTE_B);
      const reason = '核定 source=真实新增；cap=旧上限保持';
      expect(runFreeze(dir, ['--write', `--allow-set-change=${reason}`]).code).toBe(0);
      const signed = readBl(bl);
      expect(signed._setChangeLog[0].reason).toBe(reason);
      expect(runFreeze(dir, ['--write']).code).toBe(0);
      const again = readBl(bl);
      expect(again._setChangeLog).toEqual(signed._setChangeLog);
      expect(again._baselineHistory).toEqual(signed._baselineHistory);
      const before = readFileSync(bl, 'utf8');
      expect(runFreeze(dir, ['--write', '--allow-set-change=甲', '--allow-set-change=乙']).code).toBe(1);
      expect(readFileSync(bl, 'utf8')).toBe(before);
    } finally { cleanup(); }
  });

  it('写手⑳ 超过 20 条的判据、退休与放行历史继续追加，不截掉最早的依据', () => {
    const { dir, bl, cleanup } = freshFrozenRepo('history-over-twenty');
    try {
      writeFileSync(join(dir, 'server/src/fake/aRoute.ts'), ROUTE_A('').replace('res.status(500)', 'res.status(statusFromError(e, 500))'));
      expect(runFreeze(dir, ['--write', '--allow-set-change=接入统一档位来源']).code).toBe(0);
      const prior = readBl(bl);
      // 合成的是写手序列化历史，不构成任何生产业务批准或真实退款/权限证据。
      const witnesses = Array.from({ length: 21 }, (_, sequence) => ({ syntheticSerializationWitness: sequence }));
      prior._baselineHistory = witnesses;
      prior._floorRetirements = witnesses;
      prior._setChangeLog = witnesses;
      writeFileSync(bl, JSON.stringify(prior));
      writeFileSync(join(dir, 'server/src/fake/aRoute.ts'), 'export const delegatedToTypedBoundary = true;\n');
      expect(runFreeze(dir, ['--write', '--allow-set-change=来源调用真实退休，保留最早判据']).code).toBe(0);
      const after = readBl(bl);
      for (const key of ['_baselineHistory', '_floorRetirements', '_setChangeLog']) {
        expect(after[key]).toHaveLength(22);
        expect(after[key].slice(0, 21)).toEqual(witnesses);
      }
      expect(after._floorRetirements.at(-1).retirements[0]).toMatchObject({ kind: 'rulerFallback', before: 1, after: 0 });
      expect(after._baselineHistory.at(-1).ratchet.floors.rulerFallback).toBe(1);
      expect(after._setChangeLog.at(-1).landingPointsAfter).toBe(0);
    } finally { cleanup(); }
  });

  it('写手① 正面对照：catch **上方**加注释（行号搬家）⇒ 自动重冻结通过，且条目数不变、站点行号跟过去', () => {
    const { dir, bl, cleanup } = freshFrozenRepo('shift');
    try {
      const before = readBl(bl);
      expect(before.sites.length, '假树应当恰好数到 1 条落点（尺在假树上不空转）').toBe(1);
      writeFileSync(join(dir, 'server/src/fake/aRoute.ts'), ROUTE_A('// 第 1 行注释\n// 第 2 行注释\n// 第 3 行注释\n'));
      const again = runFreeze(dir, ['--write']);
      expect(again.code, `只是行号搬家却要签字？实得：${again.err || again.out}`).toBe(0);
      const after = readBl(bl);
      expect(after.sites.length).toBe(1);
      const lineOf = (k: string) => Number(k.match(/:(\d+)#/)?.[1]);
      expect(lineOf(after.sites[0]) - lineOf(before.sites[0]), '我在 catch 上方净插了 2 行 ⇒ 站点行号必须跟着搬 +2（不搬 = 尺没跟住源码）')
        .toBe(2);
      expect(after.sites[0].replace(/:\d+#/, '#'), '除了行号，签名必须还是那一条').toBe(before.sites[0].replace(/:\d+#/, '#'));
      expect(after._setChangeLog, '搬家不是集合变化 ⇒ 不该留下放行痕迹').toBeUndefined();
    } finally { cleanup(); }
  });

  it('写手② ★ 牙：在**另一个文件**新写一处手写档位 ⇒ 拒绝写盘（exit 1）且基线一个字节都没变', () => {
    const { dir, bl, cleanup } = freshFrozenRepo('tooth');
    try {
      const before = readFileSync(bl, 'utf8');
      writeFileSync(join(dir, 'server/src/fake/bRoute.ts'), ROUTE_B);
      const r = runFreeze(dir, ['--write']);
      expect(r.code, '新增了手写档位的落点，写手却照签放行 ⇒ 这道闸门是空的').toBe(1);
      expect(r.err).toContain('签名层');
      expect(r.err, '报错必须点名是哪一条签名').toContain('bRoute.ts#literalStatus');
      expect(readFileSync(bl, 'utf8'), '拒绝写盘 = 基线不许被改一个字节（半途写盘会让"红"变成"已登记"）').toBe(before);
    } finally { cleanup(); }
  });

  it('写手③ 放行要留痕：带理由的 `--allow-set-change` ⇒ 写盘并在 `_setChangeLog` 里点名理由与新增签名；不给理由 ⇒ 仍然拒', () => {
    const { dir, bl, cleanup } = freshFrozenRepo('signoff');
    try {
      writeFileSync(join(dir, 'server/src/fake/bRoute.ts'), ROUTE_B);
      expect(runFreeze(dir, ['--write', '--allow-set-change']).code, '光给 flag 不给理由 ⇒ 等于盲放行，必须拒').toBe(1);
      /**
       * ★ v3.19（复核 MINOR-5）：`--allow-set-change` 与 `--write` 是**两个正交开关**，过去只给前者时写手照样打印
       *   "已放行"，而 `_setChangeLog` 那一跑根本不落盘 ⇒ 输出比事实多说了一句。这一跑就是那个从没测过的组合：
       *   签名层**真的**变了、理由也给了，但没给 --write ⇒ 必须明说"只打印不落盘"，且基线一字节不动。
       *   ⚠️ 时机要紧：必须排在下面那次真 `--write` **之前** —— 写盘之后签名就不再变了，这一跑会走"对账通过"分支，
       *      断言当场变成恒假（我第一版就把它插在了后面，是本批自己抓到的一次"插错位置的假牙"）。
       */
      const blBeforeDry = readFileSync(bl, 'utf8');
      const dry = runFreeze(dir, ['--allow-set-change=演练：只预演不落盘的组合（过去没测过）']);
      expect(dry.code, `只给理由不给 --write 应当放行到"预演"就停住，实得：${dry.err || dry.out}`).toBe(0);
      expect(dry.out, '预演里不许出现无条件的"已放行"').toContain('但没给 --write');
      expect(dry.out, '预演不许说"允许写盘"').not.toContain('⇒ 允许写盘');
      expect(readFileSync(bl, 'utf8'), '只给 --allow-set-change 就把基线写了 ⇒ 放行痕迹被静默铸进真源').toBe(blBeforeDry);
      const r = runFreeze(dir, ['--write', '--allow-set-change=演练：本批故意新增一处，配了回退用例']);
      expect(r.code, `带理由应当放行，实得：${r.err || r.out}`).toBe(0);
      const after = readBl(bl);
      expect(after.sites.length).toBe(2);
      const log = after._setChangeLog ?? [];
      expect(log.length).toBe(1);
      expect(log[0].reason).toContain('演练');
      expect(log[0].added.sites, '留痕必须点名新增的签名').toEqual(['server/src/fake/bRoute.ts#literalStatus']);
      // 留的那个"放行后的条数"必须与账面上的数一致 ⇒ 有人**手改清单**（绕过写手）就会在下一条守卫上红
      expect(log[0].landingPointsAfter).toBe(after.totals.landingPoints);
    } finally { cleanup(); }
  });

  /**
   * ★ B144（v3.18）：这台写手**过去没有写盘开关** ⇒ '我先看一眼会怎样'本身就会把基线改掉
   *   （v3.16、v3.17 各踩一次）。G4.1 那份从 v3.12 起就要显式 `--write`，这次是把这个缺口的实现对齐过去。
   *   两格一起才算钉住：⑤ 证"默认不动盘"，⑥ 证"`--out` 是真能拿到副本的路、也不是靠不写实现假装安全"，
   *   ⑦（v3.19/B145）证"`--out` 的落点不许撞真源目录"。
   *
   * ★★ v3.19 更正（v3.18 复核抓到、本批**逐格实测**）：上一版这里写的是
   *   "①②③ 若不同批加 `--write`，会因为基线永远不变而**集体假绿**" —— 三格里只有 **② 真是假绿**：
   *   · ① 实测红：`站点行号必须跟着搬 +2` 读到 `expected +0 to be 2`（它读的是**重冻结之后**的文件，不写盘就对不上）；
   *   · ③ 实测红：`expected 1 to be 2`（同理，`sites.length` 停在 1）；
   *   · ② **实测仍绿** ⇒ 只有这一格是沉默的：它断言"被闸门拒（exit 1）+ 基线没变"，
   *     而闸门的中止发生在 `WRITE` 被读到**之前** ⇒ 不给 `--write` 时它照样 exit 1，
   *     于是它不再测自己声称的那件事（"闸门挡住了一个**真正的写盘企图**"）。
   *   ⇒ 教训：'这个改动会让 N 格集体变成空断言'这种句子，N 要逐格量，不能按"它们都读基线"推。
   *     推错的方向也很难看：我把两格红格说成假绿，等于给本批的修法记了一笔不存在的功劳。
   */
  it('写手⑤ 默认只预演：不给任何写盘开关 ⇒ 对账照说、基线逐字节不动，且明说没写盘', () => {
    const { dir, bl, cleanup } = freshFrozenRepo('dryrun');
    try {
      const before = readFileSync(bl, 'utf8');
      // ★ v3.19：这里插**两行**（原来一行 = 与夹具写入的那行等长 ⇒ 站点集合毫无变化，
      //   "它会写盘的话文件必然不同"这个前提只剩元数据在撑）。现在行号真搬家 ⇒ 一旦误写盘，`sites` 也会变。
      writeFileSync(join(dir, 'server/src/fake/aRoute.ts'), ROUTE_A('// 多插一行\n// 再插一行\n'));
      const r = runFreeze(dir, []);
      expect(r.code, `预演不该失败，实得：${r.err || r.out}`).toBe(0);
      expect(r.out).toContain('未写盘');
      expect(r.out).toContain('只预演');
      expect(readFileSync(bl, 'utf8'), '默认路径把基线写了 ⇒ 这道闸门是空的（探针式跑动会静默改真源）').toBe(before);
    } finally { cleanup(); }
  });

  /**
   * ★ B148（v3.21）：`--out` 整条**取消**，看内容只剩 `--dump` ⇒ 这一格不再测"副本写到别处对不对"，
   *   改测结构性事实：① stdout 是**纯 JSON**（进度行走 stderr —— v3.21 我自己踩到混行导致 `--dump > f.json` 得到废文件）；
   *   ② 跑前跑后**目录里的文件清单逐字相同**（只要 --dump 还能顺手写一个文件，B145/B147/B148 那一族就回来了）；
   *   ③ 打印的是**本次**读数（这一跑插了两行 ⇒ 行号必须搬，不许复读旧基线）。
   */
  it('写手⑥ `--dump` 只打印不落盘：stdout 是完整可解析 JSON，且跑前跑后文件清单逐字相同', () => {
    const { dir, bl, cleanup } = freshFrozenRepo('dump');
    try {
      const blBefore = readFileSync(bl, 'utf8');
      writeFileSync(join(dir, 'server/src/fake/aRoute.ts'), ROUTE_A('// 多插一行\n// 再插一行\n'));
      const listing = () => execFileSync('find', [dir, '-type', 'f', '-not', '-path', '*/.git/*'], { encoding: 'utf8' })
        .split('\n').filter(Boolean).sort().join('\n');
      const filesBefore = listing();
      const r = runFreeze(dir, ['--dump']);
      expect(r.code, `--dump 跑不动：${r.err}`).toBe(0);
      expect(r.out.trimStart(), 'stdout 只能是纯 JSON（进度行混进来就得到废文件）').toMatch(/^\{/);
      const parsed = JSON.parse(r.out) as { totals: { landingPoints: number }; sites: string[] };
      expect(parsed.totals.landingPoints, '--dump 必须给完整内容，不是摘要').toBeGreaterThan(0);
      expect(parsed.sites.length, '--dump 要带站点清单').toBeGreaterThan(0);
      expect(r.out, '--dump 给的是本次读数，不是旧基线的复读（这一跑插了两行 ⇒ 行号必须搬）').not.toBe(blBefore);
      expect(listing(), '--dump 产生了文件 ⇒ "只打印"是假话，B148 那一族立刻回归').toBe(filesBefore);
      expect(readFileSync(bl, 'utf8'), '--dump 顺手把基线改了').toBe(blBefore);
    } finally { cleanup(); }
  });

  /**
   * ★★ B148 的牙（一）：**任何"写目标"参数都不被接受** —— 不再逐条枚举危险路径（那已经连输三次：
   *   B145 路径照原样 → B147 大小写/错 cwd → B148 跨树/指判据文档），而是断言一条**结构性事实**：
   *   带落点的调用一律 exit 1，且文件系统上零新增、零变化。落点集合按"上一批真的成功过"的形状给。
   */
  it('写手⑦ ★ 牙（B148）：本份真源 / 隔壁基线 / 大小写变体 / `..` 混写 / 判据文档 / 仓外绝对路径 ⇒ 全部 exit 1 且零变化', () => {
    const { dir, bl, cleanup } = freshFrozenRepo('nopath');
    try {
      const sib = join(dir, 'scripts', 'baselines', 'g41-write-surface.json');
      const sibBefore = '{"sentinel":"隔壁基线：被盖掉就等于替另一道闸门改了真源"}\n';
      writeFileSync(sib, sibBefore);
      const doc = join(dir, 'docs', 'ledger-under-test.md');
      mkdirSync(join(dir, 'docs'), { recursive: true });   // 临时仓只建了 server/ 与 scripts/，docs/ 要自己造
      writeFileSync(doc, '# 一份被判据引用的文档（B148 里被截断的就是这种，不是 JSON）\n');
      const blBefore = readFileSync(bl, 'utf8');
      const targets: Array<[string, string]> = [
        ['本份真源（相对）', join('scripts', 'baselines', 'error-tier-hardcodes.json')],
        ['隔壁基线（相对）', join('scripts', 'baselines', 'g41-write-surface.json')],
        ['大小写变体目录', join('scripts', 'BASELINES', 'g3-fail-open.json')],
        ['`.`/`..` 混写', join('scripts', '.', 'baselines', '..', 'baselines', 'g41-write-surface.json')],
        ['判据文档本身', 'docs/ledger-under-test.md'],
        ['仓外绝对路径', join(dir, '..', 'somewhere-else.json')],
      ];
      for (const [name, target] of targets) {
        for (const flag of ['--out', '--output']) {
          const r = runFreeze(dir, [`${flag}=${target}`]);
          expect(r.code, `${name}：${flag} 居然被接受 ⇒ 写目标能力没被取消（B148 回归）`).toBe(1);
          expect(r.err + r.out, `${name}：报错必须点名"不接受写目标参数"并指向 --dump/--write`)
            .toMatch(/不接受任何写目标参数/);
        }
      }
      expect(runFreeze(dir, ['scripts/baselines/whatever.json']).code, '位置参数被接受 ⇒ 还能塞落点').toBe(1);
      expect(runFreeze(dir, ['--write', '--dump']).code, '--write 与 --dump 同时给 ⇒ 意图不清，必须拒').toBe(1);
      expect(runFreeze(dir, ['--out=']).code, '空值同样要拒（且理由要说"不接受写目标"，不是"必须给路径"）').toBe(1);
      expect(readFileSync(bl, 'utf8'), '被拒的这些跑动改了本份真源').toBe(blBefore);
      expect(readFileSync(sib, 'utf8'), '被拒的这些跑动改了隔壁基线').toBe(sibBefore);
      expect(readFileSync(doc, 'utf8'), '被拒的这一跑把判据文档改了').toContain('一份被判据引用的文档');
      expect(existsSync(join(dir, '..', 'somewhere-else.json')), '被拒的跑动把文件写到仓外去了').toBe(false);
    } finally { cleanup(); }
  });

  /**
   * ★★ B148 的牙（二）· **跨树**那一形状（v3.20 复核的 BLOCKER，我在 /tmp 双树副本自己复现过）：
   *   "受保护真源集合"是按**单棵树**算的 ⇒ 绝对路径指进另一棵树的基线，exit 0、还打印「受保护真源 5 份已实测逐份未变」
   *   （那句话对我们这棵树是真的，对被攻击的那棵树毫无意义）。同一条 flag 指到 `docs/交付目标与验收标准….md`
   *   把权威基准从 1014341B 截成 35759B ⇒ **真源不只有 JSON**，任何按清单/前缀的守卫都追不完。
   *   ⇒ 这一格造两棵临时树，从 A 攻 B；再留一条"合法 --write 仍可用 + 证人报得出份数"的正面对照。
   */
  it('写手⑧ ★ 牙（B148）：跨树绝对路径（A 树攻 B 树的基线）必须被拒；本树 --write 照旧能用且报得出实测份数', () => {
    const { dir: aDir, bl: aBl, cleanup: cleanA } = freshFrozenRepo('treeA');
    const b = freshFrozenRepo('treeB');
    try {
      const aBefore = readFileSync(aBl, 'utf8');
      const bBefore = readFileSync(b.bl, 'utf8');
      const r = runFreeze(aDir, [`--out=${b.bl}`]);
      expect(r.code, '跨树写目标被接受 ⇒ "受保护集合是每棵树各自的"那个洞还开着（B148 复现）').toBe(1);
      expect(r.err + r.out).toMatch(/不接受任何写目标参数/);
      expect(readFileSync(b.bl, 'utf8'), 'A 树的跑动改掉了 B 树的基线 ⇒ 正是 B148 实测的损害').toBe(bBefore);
      expect(readFileSync(aBl, 'utf8'), '被拒的这一跑连 A 树自己的基线也动了').toBe(aBefore);
      // ★ 正面对照：功能没被一起判死；且证人真的去读了清单（报得出份数 ≠ 打印一句固定话术）
      writeFileSync(join(aDir, 'server/src/fake/aRoute.ts'), ROUTE_A('// 搬家两行\n// 再来一行\n'));
      // ★ B149：先**种一份真实存在的隔壁基线**，否则这一跑落到"0 份"的自限句分支，正面对照就没对照了
      writeFileSync(join(aDir, 'scripts', 'baselines', 'g41-write-surface.json'), '{"sentinel":"隔壁真实存在的一份"}\n');
      const w = runFreeze(aDir, ['--write']);
      expect(w.code, `合法 --write 被挡住 ⇒ 取消 --out 时把功能一起判死了：${w.err || w.out}`).toBe(0);
      // ★ B149：份数下限必须是 [1-9]（\d+ 含 0 ⇒ 一句"逐份未动"可以在什么都没量的时候打印）
      expect(w.out, '要报得出**至少一份**被实测的隔壁真源 ⇒ 份数为 0 时这句不许以成就口吻出现').toMatch(/其余受保护真源 [1-9]\d* 份已实测逐份未动/);
      expect(readFileSync(aBl, 'utf8'), '--write 之后基线没变 ⇒ 这格是空跑').not.toBe(aBefore);
    } finally { cleanA(); b.cleanup(); }
  });

  /**
   * ★★ B147 第二条绕过（复核实测、我重跑确认）：**cwd 不在仓根**。
   *   过去这台写手把所有路径挂在 cwd 上 ⇒ 从 `server/` 里跑时：旧基线读不到 ⇒ 签名闸门自报"首冻"（**静默解除**）、
   *   守卫比的是不存在的路径、"写完实测真源字节"量的也是不存在的路径 ⇒ `--out=../scripts/baselines/<真源>`
   *   一路放行并把真基线写成 `落点 0 / filesScanned 0` 的空文档，而输出说"真源未变"。
   *   ⇒ 修法不是"禁止在子目录跑"（那会把本文件的临时仓测试一起废掉 —— 我先写成"根跟脚本走"，随即自己否了：
   *     那会让临时仓测试去读写**真仓真基线**，修一个越界写、造一个更大的），
   *     而是**当场验证这棵树像不像仓根**，不像就炸。临时仓（有 server/src + scripts/baselines）仍然合法通过 ⇒ 这一格两头都测。
   */
  it('写手⑨ ★ 牙（B147）：cwd 不像仓根 ⇒ 当场炸且不许碰到真源；像仓根的树照旧能跑', () => {
    const { dir, bl, cleanup } = freshFrozenRepo('wrongcwd');
    try {
      const blBefore = readFileSync(bl, 'utf8');
      mkdirSync(join(dir, 'sub'), { recursive: true });
      const wrong = runFreezeIn(join(dir, 'sub'), ['--dump']);
      expect(wrong.code, '从非仓根的 cwd 跑 ⇒ 必须拒（过去它一路放行并把真源写成空文档）').toBe(1);
      expect(wrong.err + wrong.out, '报错要讲清"缺哪个标志物"，不许只说 cwd 不对').toContain('仓根');
      expect(readFileSync(bl, 'utf8'), '被拒的这一跑把真源改了').toBe(blBefore);
      // ★ 正面对照：同一棵树换个**合法** cwd 必须仍然跑得动 ⇒ 否则这条检查只是在关掉功能
      //   （v3.21：B148 之后没有"写副本"这条路了 ⇒ 用 --dump 测"跑得动 + 不落盘"，功能没被树检查判死）
      const ok = runFreeze(dir, ['--dump']);
      expect(ok.code, `合法 cwd 也被拒 ⇒ 树检查越界关掉了功能：${ok.err || ok.out}`).toBe(0);
      expect(JSON.parse(ok.out).totals.landingPoints, '合法那一跑的 --dump 没给出内容').toBeGreaterThan(0);
      expect(existsSync(join(dir, 'probe-again.json')), '--dump 居然落盘了 ⇒ B148 那一族回归').toBe(false);
      // ★ 缺标志物的树（有 server/src 但没有 scripts/baselines）也要拒 —— 只查一半的检查拦不住"新克隆的空树"
      const bare = mkdtempSync(join(tmpdir(), 'b134-bare-'));
      mkdirSync(join(bare, 'server', 'src'), { recursive: true });
      const r3 = spawnSync('node', [FREEZE], { cwd: bare, encoding: 'utf8', timeout: 120_000 });
      expect(r3.error, '跑不动').toBeUndefined();
      expect(r3.status, '缺 scripts/baselines 的树也被放行 ⇒ 树检查只看了半个标志物').toBe(1);
      // ★ v3.21：B148 之后"错 cwd + 相对 --out"那一形状，已由"不接受任何写目标参数"这条结构性事实接管；
      //   本格只留树检查本身 —— 一条防线管一件事，别把两件事的功劳记在同一格上。
      rmSync(bare, { recursive: true, force: true });
    } finally { cleanup(); }
  });

  /**
   * ★ I4 的**升级**（v3.20 复核抓到：上一版这把尺只比"`：`之前的整段前缀" ⇒ ① 同序号不同文案**不红**、
   *   ② `it("…")` 双引号标题**完全扫不到**）⇒ B139 那个病我只治了一半。
   *   ⇒ 现在比**序号 token 本身**、单/双引号都扫，并且**先用合成样本自证这把尺有牙齿**
   *     （"同 token 不同文案必须被抓到"这一条，正是上一版漏掉的那个形状）。
   */
  it('写手⑩ ★ it() 的序号 token 在本文件内不得重复（单/双引号都算；先用合成样本证明这把尺有牙）', () => {
    const tokenOf = (t: string) => {
      const m = t.match(/^(写手)?([①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮]+|\d+)([a-z]?)/);
      return m ? `${m[1] || ''}${m[2]}${m[3] || ''}` : '';
    };
    const dupTokens = (titles: string[]) => {
      const c = new Map<string, number>();
      for (const t of titles) { const k = tokenOf(t); if (k) c.set(k, (c.get(k) ?? 0) + 1); }
      return [...c].filter(([, n]) => n > 1).map(([k, n]) => `${k}×${n}`).sort();
    };
    // ① 尺自己的正面对照（上一版缺的就是这两条）
    expect(dupTokens(['写手① 甲', '写手① 乙']), '同 token 不同文案必须抓到（上一版就是漏在这）').toEqual(['写手①×2']);
    expect(dupTokens(['① 甲', '① 乙']), '裸序号同样要抓到').toEqual(['①×2']);
    expect(dupTokens(['④ 甲', '④b 乙']), '④ 与 ④b 是两格，不许误伤（本文件真有 ④b/⑧b 这种命名 ⇒ 后缀要算进 token）').toEqual([]);
    expect(dupTokens(['写手① 甲', '① 甲']), '加了前缀的与裸序号是两族，不许互相误伤').toEqual([]);
    expect(dupTokens(['写手① 甲', '写手② 乙'])).toEqual([]);
    // ② 真文件（单引号与双引号两种 it() 形状都算）
    const src = readFileSync(join(REPO, 'scripts/error-tier-hardcodes.test.ts'), 'utf8');
    const titles = [...src.matchAll(/\bit\(\s*'([^']+)'|\bit\(\s*"([^"]+)"/g)].map((m) => m[1] ?? m[2] ?? '');
    expect(titles.length, `it() 只扫到 ${titles.length} 条 ⇒ 正则瞎了`).toBeGreaterThan(20);
    expect(dupTokens(titles),
      '标题序号撞车 ⇒ 台账里"第 N 格"这种引用没有唯一出处（B139 立过账，v3.20 复核 I4 又抓到回归）').toEqual([]);
  });

  it('写手④ ★ 反污染对照：上面几格把写手的 cwd 指到 /tmp，本树的**真基线**必须逐字节没被动过', () => {
    // 为什么要有这条：那三格依赖"写手用**相对 cwd** 的路径落盘"。哪天有人把它改成
    // "路径由脚本位置派生"（B85 那一课的另一面 —— 那边是审计器必须跟本树走，这边正相反），
    // 临时仓的产物就会直接盖掉 `scripts/baselines/error-tier-hardcodes.json`，而且**测试照样全绿**。
    // ⇒ 与其把风险写成注释，不如留一个"越界必被抓"的证人。
    // ⚠️ 期望侧必须是**跑之前**抓的快照（在 `it` 里现读再与现读比 = 恒等式，什么都拦不住 —— B79 那一课）。
    const now = readFileSync(join(REPO, BL_REL), 'utf8');
    expect(now, '真基线被临时仓的跑动改写过 ⇒ 上面那三格的隔离已失效（检查 BASELINE_REL 是否还跟着 cwd 走）')
      .toBe(REAL_BASELINE_RAW);
    /**
     * ★ v3.19（B146 同族）：这里原来第二条断言是 `now.generated.worktreeDiffSha === BASELINE.generated.worktreeDiffSha` ——
     *   而 `BASELINE` 是本文件 import 时对**同一个文件**的解析结果，`now` 是它的再读 ⇒ **值与自己的比对，恒真**，
     *   上面那条逐字节等值一旦成立它必然成立（不成立时它也已经先红了）⇒ 一行假牙。
     *   换成"基线自带合法出处"这条**独立**判据（上一条管的是"没被人中途改掉"，这条管"这数是从哪份树量的"）。
     */
    const gen = JSON.parse(now).generated as { fromCommit: string; worktreeDiffSha: string; filesScanned: number };
    expect(gen.fromCommit, '基线必须自带出处（HEAD 短码）⇒ 否则事后认不出量的哪一份树（B77）').toMatch(/^[0-9a-f]{7,8}$/);
    expect(gen.worktreeDiffSha, '出处要连"工作树偏离 HEAD 多远"一起记 ⇒ 只记 HEAD 是假的出处（复核 B-2 那一课）')
      .toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(gen.filesScanned, 'filesScanned 小到这个量级 ⇒ 尺在空转，别拿这份基线当分母').toBeGreaterThan(100);
  });

  /**
   * ★★ 写手⑪ · 牙（B149，v3.21 复核 BLOCKER-1 的第二条通道，我在 /tmp 三棵临时树里复现过）：
   *   `--out` 取消之后，"写到哪"仍然有一条**不经参数**的路 —— 文件系统间接层：
   *   把 `scripts/baselines` 做成指向**另一棵树**的符号链接 ⇒ v3.21 那版 exit 0、文件落进另一棵树，
   *   而本树打印「受保护真源逐份未动」（因为删 `--out` 时把 realpath 的用法一起删了，只剩一个没用的 import）。
   *   ⇒ 判据不是再枚举一批"危险路径"，而是**两个已求值的路径比一次**：落点目录 realpath 后必须仍在 ROOT 之内。
   */
  it('写手⑪ ★ 牙（B149）：baselines 目录被做成指向另一棵树的符号链接 ⇒ 必须拒写，且被指那棵树一字节不动', () => {
    const a = freshFrozenRepo('symA');
    const b = freshFrozenRepo('symB');
    try {
      const bBefore = readFileSync(b.bl, 'utf8');
      rmSync(join(a.dir, 'scripts', 'baselines'), { recursive: true, force: true });
      symlinkSync(join(b.dir, 'scripts', 'baselines'), join(a.dir, 'scripts', 'baselines'), 'dir');
      const r = runFreeze(a.dir, ['--write']);
      expect(r.code, '符号链接把唯一的写盘动作搬出本树却被放行 ⇒ realpath 归一那道检查是空的').toBe(1);
      expect(r.err + r.out, '报错要点名"落在哪、不在哪棵树里"，否则下一个人只会看到一个 exit 1').toMatch(/不在.*当前树/);
      expect(readFileSync(b.bl, 'utf8'), '被拒的这一跑改掉了被链接指向的那棵树的真源').toBe(bBefore);
      // ★ 正面对照：把目录换回真实的，同一棵树照旧写得动（否则这一格只是把功能关掉）
      rmSync(join(a.dir, 'scripts', 'baselines'), { recursive: true, force: true });
      mkdirSync(join(a.dir, 'scripts', 'baselines'), { recursive: true });
      writeFileSync(join(a.dir, 'scripts', 'baselines', 'g41-write-surface.json'), '{"s":"隔壁"}\n');
      const ok = runFreeze(a.dir, ['--write']);
      expect(ok.code, `普通目录（非符号链接）被挡住 ⇒ 这一格越界关掉合法写盘：${ok.err || ok.out}`).toBe(0);
      expect(existsSync(join(a.dir, BL_REL)), '正面对照没落盘 ⇒ 这格是空跑').toBe(true);
    } finally { a.cleanup(); b.cleanup(); }
  });

  /**
   * ★★ 写手⑫ · 牙（B149，v3.21 复核 BLOCKER-2）：证人句**不许在什么都没量的时候以成就口吻出现**。
   *   复现：一棵 baselines 目录里除自己那份之外没有别的文件的临时树，v3.21 打印「其余受保护真源 0 份
   *   已实测逐份未动」且 exit 0，而筛它的正则写的是 \d+（含 0）⇒ 这句话可以什么都不证明。
   *   ★ 不改成"0 份就中止"：夹具首冻时那个目录本来就是空的，中止会废掉整套子进程判据
   *   ⇒ 改成**自限句**（打 ⚠️ 并说清"不构成对隔壁的证人"），这里两头都测。
   */
  it('写手⑫ ★ 牙（B149）：除自己外没有第二份真实存在的真源 ⇒ 不许打成就句，必须打自限句；种一份之后必须换成成就句', () => {
    const { dir, bl, cleanup } = freshFrozenRepo('witness0');
    try {
      expect(readdirSync(join(dir, 'scripts', 'baselines')), '这格要求"目录里只有本份基线"的形状').toEqual([basename(bl)]);
      const r0 = runFreeze(dir, ['--write']);
      expect(r0.code, `合法写盘被挡住：${r0.err || r0.out}`).toBe(0);
      const said0 = r0.out + r0.err;
      expect(said0, '0 份却打印成就句 ⇒ 一句"逐份未动"可以在什么都没量时出现').not.toMatch(/其余受保护真源 \d+ 份已实测/);
      expect(said0, '必须显式承认这一跑不构成对隔壁的证人').toMatch(/不构成.*证人/);
      expect(said0, '清单里"此刻不存在"的条目要点名（不许静默计入份数，也不许静默消失）').toMatch(/另有 \d+ 份此刻不存在/);
      // ★ 正面对照：种一份**真实存在**的隔壁基线 ⇒ 同一句话必须换成可数的成就句
      writeFileSync(join(dir, 'scripts', 'baselines', 'g41-write-surface.json'), '{"s":"隔壁真实存在"}\n');
      const r1 = runFreeze(dir, ['--write']);
      expect(r1.code, `有种隔壁真源反而写不动：${r1.err || r1.out}`).toBe(0);
      expect(r1.out + r1.err, '有真实隔壁时仍打自限句 ⇒ 这格的谓词反了').toMatch(/其余受保护真源 [1-9]\d* 份已实测逐份未动/);
    } finally { cleanup(); }
  });

  /**
   * ★ 写手⑬ · 牙（B149，复核三条 MINOR 一次收口）：
   *   ① 从未实现的 `--json` 被静默接受 ⇒ 一个"看起来能用的开关"其实什么都不做（这类谎本族已记过 B134）；
   *   ② `--allow-set-change=` 要的是**一句话理由**，给一个像路径的东西也被放行 ⇒ 与"工具肯接受落点"同族；
   *   ③ 出处原来读 `process.env.SHORT_SHA` ⇒ 一个环境变量就能伪造 `fromCommit`（格子只验形状）。
   */
  it('写手⑬ ★ 牙（B149）：--json 不再被接受 / 理由像路径要拒 / 出处不接受调用者提供', () => {
    const { dir, bl, cleanup } = freshFrozenRepo('args13');
    try {
      const before = readFileSync(bl, 'utf8');
      const j = runFreeze(dir, ['--json']);
      expect(j.code, '--json 从未实现却被接受 ⇒ 一个空转开关会让人以为拿到了机器可读输出').toBe(1);
      expect(j.err + j.out, '报错要直说这个 flag 不存在，而不是回一句"不认识的参数"了事').toMatch(/--json/);
      const p = runFreeze(dir, ['--allow-set-change=scripts/baselines/x.json']);
      expect(p.code, '给"理由"塞一个路径被放行 ⇒ 这条 flag 有了第二个用途').toBe(1);
      expect(p.err + p.out, '要点名"整串就是一个路径"这条判据本身').toMatch(/就是一个路径/);
      // ★ B150（复核 MINOR-1：v3.22 那条正则漏与误杀并存）⇒ 边界要钉死两面：
      const prose = runFreeze(dir, ['--allow-set-change=为新增基线 scripts/baselines/g9-note.json 落账，理由见 B150']);
      expect(prose.code, `散文里提到一个路径就被误杀 ⇒ 这条检查在惩罚正常写法（实得：${prose.err || prose.out}）`).toBe(0);
      const sneaky = runFreeze(dir, ['--allow-set-change=/tmp/elsewhere/baseline.json']);
      expect(sneaky.code, '整串就是一个路径 ⇒ 仍要拒（它想用的是这条 flag 的第二个用途）').toBe(1);
      // ③ 出处：环境变量给一个合法形状的假短码，也必须仍以 git 为准（临时仓的真实 HEAD）
      const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).status;
      expect(head, '临时仓没有 HEAD ⇒ 这一发的前提没立住').toBe(0);
      const realHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim().slice(0, 8);
      const r = spawnSync('node', [FREEZE, '--write'], { cwd: dir, encoding: 'utf8', timeout: 120_000, env: { ...process.env, SHORT_SHA: 'deadbeef' } });
      expect(r.status, `带伪造出处跑 ⇒ 至少要能跑完：${r.stderr || r.stdout}`).toBe(0);
      expect(JSON.parse(readFileSync(bl, 'utf8')).generated.fromCommit,
        `SHORT_SHA 环境变量还能决定 fromCommit ⇒ 出处可以伪造（应恒等于该树 HEAD ${realHead}）`).toBe(realHead);
    } finally { cleanup(); }
  });

  /**
   * ★★ 写手⑭ · 牙（B150，v3.22 复核 B-1；我自己复现成立）：v3.22 的落点归一只做到**目录**，
   *   于是把 `error-tier-hardcodes.json` 这**一个文件**做成指向别处的符号链接就整条绕通 ——
   *   实测从 T 树跑 --write，U 树那份被凭空写出、exit 0。
   *   ★ 而且有两种形状，第二种更阴：目标**此刻还不存在**（悬空链接）时 `existsSync`/`realpathSync`
   *   都会说"没有这个文件"⇒ 只对目录取 realpath 的第二版仍然放行（我 v3.24 就是这么第二次绕过去的），
   *   必须再用 `readlinkSync` 把链接**声明的目标**审一遍。
   */
  it('写手⑭ ★ 牙（B150）：落点是符号链接（目标已存在 / 悬空两种）都要拒，且外面那份一字节不动、也不许被凭空造出来', () => {
    // 形状一：链接指向一份**已存在**的外部基线
    const t1 = freshFrozenRepo('filelink1');
    const u1 = freshFrozenRepo('filelink1-target'); // 这份自己 --write 过 ⇒ 基线真实存在
    try {
      const u1Before = readFileSync(u1.bl, 'utf8');
      rmSync(t1.bl, { force: true });
      symlinkSync(u1.bl, t1.bl);
      const r = runFreeze(t1.dir, ['--write']);
      expect(r.code, '文件级符号链接被放行 ⇒ 落点归一只审了父目录（B150 复现形状）').toBe(1);
      expect(r.err + r.out, '报错要指出落点被归一到了哪棵树之外').toMatch(/不在.*当前树/);
      expect(readFileSync(u1.bl, 'utf8'), '被拒的一跑改掉了外部那份真源').toBe(u1Before);
    } finally { t1.cleanup(); u1.cleanup(); }
    // 形状二：链接指向一份**尚不存在**的路径（悬空）⇒ 写下去等于在别的树里凭空造文件
    const t2 = freshFrozenRepo('filelink2');
    const ghost = join(tmpdir(), `b150-ghost-${Date.now()}`, 'error-tier-hardcodes.json');
    try {
      rmSync(t2.bl, { force: true });
      symlinkSync(ghost, t2.bl);
      const r2 = runFreeze(t2.dir, ['--write']);
      expect(r2.code, '悬空链接被放行 ⇒ existsSync 说不存在就直接开写（v3.24 第二版实测就是这条绕通的）').toBe(1);
      // ★ 这一例的"拒"必须由**归一检查**给出，不能由"写不下去"蒙混：目标路径的父目录本来也不存在，
      //   少了这道守卫时 writeFileSync 会自己抛（exit 1 但原因是 ENOENT）⇒ 只断言 exit 1 是**假咬**，
      //   所以这里必须点名"落在当前树之外"那句话（v3.24 突变 M12 实测：拿掉审查后红在该句，而非红在退出码）。
      expect(r2.err + r2.out, '拒的理由必须是"落点被归一到本树之外"，不是"文件写不下去"').toMatch(/不在.*当前树/);
      expect(existsSync(ghost), '被拒的一跑把目标路径凭空造出来了').toBe(false);
    } finally { t2.cleanup(); rmSync(dirname(ghost), { recursive: true, force: true }); }
  });

  /**
   * ★★ 写手⑮ · 牙（B150，v3.22 复核 B-2；我自己复现成立）：v3.22 只删了 `SHORT_SHA` 这个入口，
   *   却漏了 git **自己那一堆环境变量** ⇒ `GIT_DIR=<别处>/.git GIT_WORK_TREE=<别处>` 就能把
   *   `fromCommit`（连带 worktreeDirtyFiles / worktreeDiffSha）写成另一棵树的读数。
   *   实测：本树 HEAD=5a3ad0c7、基线里却写 e5d695b0，且 exit 0 ⇒「出处不接受调用者提供」这句话又说满了。
   *   ⇒ 修法两层：剥掉所有 `GIT_*` 后**让 git 自己发现这棵树**，再问一次 toplevel 是不是 ROOT。
   */
  it('写手⑮ ★ 牙（B150）：GIT_DIR / GIT_WORK_TREE 指到别的树，出处仍必须是本树的 HEAD（不能是伪造树那份）', () => {
    const a = freshFrozenRepo('gitdirA');
    const b = freshFrozenRepo('gitdirB');
    try {
      const g = (dir: string, args: string[]) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' });
      // 两棵树必须给出**不同**的 HEAD，否则这格分辨不了"取了谁的"（记忆里那条：对照要选必然下游不同值的样本）
      writeFileSync(join(a.dir, 'MINE-A.txt'), 'only in A\n');
      expect(g(a.dir, ['add', '-A']).status).toBe(0);
      expect(g(a.dir, ['commit', '-q', '-m', 'A 独有的一次提交']).status).toBe(0);
      const head = (dir: string) => String(g(dir, ['rev-parse', 'HEAD']).stdout || '').trim().slice(0, 8);
      const aHead = head(a.dir);
      const bHead = head(b.dir);
      expect(bHead, `两棵树 HEAD 相同（${bHead}）⇒ 这一格没有分辨力，前提没立住`).not.toBe(aHead);
      const r = spawnSync('node', [FREEZE, '--write'], {
        cwd: a.dir, encoding: 'utf8', timeout: 120_000,
        env: { ...process.env, GIT_DIR: join(b.dir, '.git'), GIT_WORK_TREE: b.dir },
      });
      expect(r.error, `跑不动：${r.error?.message}`).toBeUndefined();
      const txt = (r.stdout || '') + (r.stderr || '');
      if (r.status === 0) {
        const got = String(JSON.parse(readFileSync(a.bl, 'utf8')).generated?.fromCommit || '');
        expect(got, `GIT_DIR 被听进去了 ⇒ 出处记的是**别的树**（本树 ${aHead}，伪树 ${bHead}，基线写 ${got}）`).toBe(aHead);
      } else {
        expect(txt, '拒的话要说清为什么（toplevel 与扫描根不是同一棵）').toMatch(/toplevel|同一棵/);
      }
    } finally { a.cleanup(); b.cleanup(); }
  });

  /**
   * ★★ 写手⑯ · 牙（B150，v3.22 复核 I-2）：**「§9.1 是数字的唯一出处」这句话被这张表自己的用法否掉了** ——
   *   复核数过：`538` 在全文出现 36 次、`1307` 20 次，而我 v3.22 新加的族级账只是**又多一份没人盯的手抄**。
   *   ⇒ 要么把值做成与尺现算对撞的**锚**（抄几份都不怕，因为每份都被盯），要么这张表就不该写数。
   *   这一格把 §9.1 那行的三个数钉成锚：`[族级账-落点]落点**N**`、`[族级账-wide]wide**N**`、`[族级账-格数]**N** 格`。
   *   ★ 三条都按 B139 的规矩办：**先数锚的份数、再比值** ⇒ "锚丢了 / 抄了两份"与"锚里的数错了"给两种不同的红话。
   *   ★ 恒真防护：`格数` 的期望来自**当场数本文件的 it() 标题**（与 写手⑩ 同一把尺），不是文档里那个数自己。
   */
  it('写手⑯ ★ 牙（B150）：§9.1 那行的落点 / wide / 格数必须与尺现算对撞（先唯一、后相等）', () => {
    const doc = readFileSync(join(REPO, 'docs/交付目标与验收标准-2026-09-20.md'), 'utf8');
    const row = doc.split('\n').find((l) => l.startsWith('| 基线写手 · '));
    expect(row, '§9.1 里找不到「基线写手 · …」这一行 ⇒ 族级账被删了或改了前缀，三个锚随之无主').toBeTruthy();
    // ★ 口径（v3.24 自己踩出来的）：只数**行首两空格的 it() 声明**。
    //   第一版写的是 /\bit\(\s*['"]/ ⇒ 把 写手⑩ 自证用的**合成样本**（写在字符串里的那几条假标题）也算成格 ⇒ 34 vs 实跑 33，
    //   这一格当场把我自己写的数判红 —— 锚第一次跑就咬到人，是它该做的事。
    const selfTitles = [...readFileSync(join(REPO, 'scripts/error-tier-hardcodes.test.ts'), 'utf8')
      .matchAll(/^ {2}it\(\s*['"]/gm)].length;
    for (const [label, re, want] of [
      ['落点', /\[族级账-落点\]落点\*\*(\d+)\*\*/g, String(sum.total)],
      ['wide', /\[族级账-wide\]wide\*\*(\d+)\*\*/g, String(wide.length)],
      ['格数', /\[族级账-格数\]\*\*(\d+)\*\* 格/g, String(selfTitles)],
    ] as Array<[string, RegExp, string]>) {
      const hits = [...row!.matchAll(re)];
      expect(hits.length, `§9.1 行里「${label}」这个锚出现 ${hits.length} 次 ⇒ 要么丢了要么抄了两份（先唯一后相等）`).toBe(1);
      expect(hits[0][1], `§9.1 写的${label} ≠ 当场实测（文档与尺对不上 ⇒ 这张"唯一出处"表过期了）`).toBe(want);
    }
    expect(selfTitles, '数 it() 标题那把尺自己瞎了（0 条）⇒ 上面那条"格数"对撞会退化成恒真').toBeGreaterThan(10);
  });
});
