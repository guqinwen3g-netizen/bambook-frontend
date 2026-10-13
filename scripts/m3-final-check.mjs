#!/usr/bin/env node
// M3 收口终检：把「三类对撞 + 阳性对照 + 整链」这一整套读数收成一条命令。
// 存在的理由：② 每批都要求"读数换到今天的代码上重跑"，而这套跑法此前只活在散文里，
// 每批手工重新推导（env、端口、期望值）——手工重推既慢又容易悄悄跑在旧后端上。
// ⇒ 本脚本在跑任何尺之前先**验后端身份**：跑的不是当天代码就拒绝出数，而不是出一版"看着绿"的读数。
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from './lib/acceptance-selfcheck.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(SCRIPTS_DIR);
const BASE = process.env.M3_BASE ?? 'http://127.0.0.1:8090';
const SELF_CHECK = process.argv.includes('--self-check');

// 期望值＝"当天现量"的钉。读数一变这里就红 —— 那是要求重新现量，不是为了让脚本绿而改表。
// kind: collide=对撞那一侧 / control=阳性对照那一侧 / chain=整链演练 / seed=造数与还原（不参与判定）
export const ARMS = [
  { key: 'crossview-amount', kind: 'collide', cls: '①', file: 'scripts/acceptance-crossview-amount.ts', args: [], pass: 3, fail: 0 },
  { key: 'crossview-amount--mutate', kind: 'control', cls: '①', file: 'scripts/acceptance-crossview-amount.ts', args: ['--mutate'], pass: 5, fail: 0, controls: 1 },
  // v3.237 补 27：部门那一维有了正例（此前只有反例 ⇒ 那条缺口是 gaps:1），两臂各 +5 格、缺口归 0。
  //   旧钉 74/1 与 78/1 是被这一改进**消灭**的量 ⇒ 不许留着当「下限」（那会让「关掉缺口」永远读成回归）。
  { key: 'xlsx-row-collision', kind: 'collide', cls: '①', file: 'scripts/acceptance-xlsx-row-collision.ts', args: [], pass: 79, fail: 0, gaps: 0, controls: 19 },
  { key: 'xlsx-row-collision--mutate', kind: 'control', cls: '①', file: 'scripts/acceptance-xlsx-row-collision.ts', args: ['--mutate'], pass: 83, fail: 0, gaps: 0, controls: 19 },
  // v3.144：移交物之一的「已知缺陷清单」与 §9 的耦合钉在这里——改了台账忘了重生成清单，这一臂就红
  // v3.146：同一臂的第三格核"状态格里那些 commit 证据指针还指不指得到"（真问 git）
  // v3.149：第四格核“已修（vX.Y）”那类批次引用追不追得到（证人＝台账声明 或 git 提交信息，取其一）
  { key: 'known-defects-list--check', kind: 'collide', cls: '③/④', file: 'scripts/known-defects-list.mjs', args: ['--check'],
    pass: 4, fail: 0, baseExempt: '作用域=本机文件（不访问任何外部服务）' },
  { key: 'derived-open-amount', kind: 'collide', cls: '②-1/②-3', file: 'scripts/acceptance-derived-open-amount.ts', args: [], pass: 6, fail: 0 },
  { key: 'derived-open-amount--control', kind: 'control', cls: '②-1/②-3', file: 'scripts/acceptance-derived-open-amount.ts', args: ['--control'], pass: 10, fail: 0, controls: 4 },
  // ★ v3.136：钱类出口的**删除面**演练（造一张带明细行+带发票的单 → 作废它 → 逐格问钱有没有跟着走）
  //   gaps=1 是**故意留着的红-name**：读侧·发票侧那一格（作废单的发票仍计入应收），它自己现量前提
  //   （库里除自造外这种行=0 张）；前提一破就转红。别把它读成"已修"。
  { key: 'deleted-order-money-face', kind: 'collide', cls: '②-1/删除面', file: 'scripts/acceptance-deleted-order-money-face.ts', args: [], pass: 21, fail: 0, gaps: 1, controls: 1, expectText: ['HAS_DEPENDENTS', '唯一护栏', '成本 +7500'] },
  { key: 'derived-collection-rate', kind: 'collide', cls: '②-6', file: 'scripts/acceptance-derived-collection-rate.ts', args: [], pass: 1, fail: 0 },
  { key: 'derived-collection-rate--control', kind: 'control', cls: '②-6', file: 'scripts/acceptance-derived-collection-rate.ts', args: ['--control'], pass: 3, fail: 0, controls: 2 },
  { key: 'derived-margin(fail-closed)', kind: 'collide', cls: '②-4', file: 'scripts/acceptance-derived-margin.ts', args: [], pass: 0, fail: 1, expectText: ['有毛利的行 = 0', '不许读成通过'] },
  { key: 'seed-margin-cost-drill --apply', kind: 'seed', cls: '②-4', file: 'scripts/seed-margin-cost-drill.mjs', args: ['--apply'], expectText: ['共改 3 张'] },
  { key: 'derived-margin', kind: 'collide', cls: '②-4', file: 'scripts/acceptance-derived-margin.ts', args: [], pass: 2, fail: 0 },
  { key: 'derived-margin--control', kind: 'control', cls: '②-4', file: 'scripts/acceptance-derived-margin.ts', args: ['--control'], pass: 4, fail: 0, controls: 2 },
  { key: 'seed-margin-cost-drill --revert', kind: 'seed', cls: '②-4', file: 'scripts/seed-margin-cost-drill.mjs', args: ['--revert'], expectText: ['全库带 purchasePrice 的订单数 = 0'] },
  { key: 'derived-margin(还原后应重新 fail-closed)', kind: 'collide', cls: '②-4', file: 'scripts/acceptance-derived-margin.ts', args: [], pass: 0, fail: 1, expectText: ['有毛利的行 = 0'] },
  { key: 'crossview-views', kind: 'collide', cls: '③', file: 'scripts/acceptance-crossview-views.ts', args: [], pass: 2, fail: 0 },
  { key: 'crossview-views--control', kind: 'control', cls: '③', file: 'scripts/acceptance-crossview-views.ts', args: ['--control'], pass: 4, fail: 0, controls: 2 },
  { key: 'derived-profit-sheet', kind: 'collide', cls: '③', file: 'scripts/acceptance-derived-profit-sheet.ts', args: [], pass: 4, fail: 0, controls: 1 },
  // ★ v3.206：同一份判据此前**只跑"刚生成的那一张"**（由构造即自洽），库里**存量行**没人碰过
  //   ⇒ 而 D7-1c 那一族的形状正是"新代码写对了、旧行停在默认 0"。补只读的全量存量行臂：
  //   逐行六组「明细→列」+ 逐条折算 + 标量副本 + 接口↔库逐字段（遮罩逐字段点名，不静默放行）。
  //   行数不钉进关键句（数据会长），钉的是"这四条臂都跑了 + 分母自检过了"。
  { key: 'derived-profit-sheet--rows', kind: 'collide', cls: '③', file: 'scripts/acceptance-derived-profit-sheet.ts', args: ['--all-rows'], pass: 4, fail: 0, expectText: ['存量行逐格自洽', '分母自检', '未折算外币行 = 0', '接口↔库逐字段对撞'] },
  { key: 'derived-profit-sheet--rows-control', kind: 'control', cls: '③', file: 'scripts/acceptance-derived-profit-sheet.ts', args: ['--all-rows', '--control'], pass: 13, fail: 0, controls: 9, expectText: ['阳性对照·反向', '缺字段 cnyAmount', '标量副本 details.bankFeeCost'] },
  // ★ v3.214（B265 闭口）：财务报表的「能点」以前只证到 HTTP 200 ⇒ 补「点出来的每个格子对不对」。
  //   正向＝同一时刻取 JSON 与 xlsx 两份，把工作簿解回单元格逐格对撞；对照＝三刀改坏期望值 + 一枚解析器自证。
  //   分母下限钉在件里（账龄 40 / 两张对账单各 20 格）⇒ 「库里没数」或解析器瞎了会红，不会读成通过。
  { key: 'report-export-collision', kind: 'collide', cls: '①', file: 'scripts/acceptance-report-export-collision.mjs', args: [], pass: 4, fail: 0,
    expectText: ['逐格全等', 'Content-Disposition'] },
  { key: 'report-export-collision--control', kind: 'control', cls: '①', file: 'scripts/acceptance-report-export-collision.mjs', args: ['--control'],
    pass: 8, fail: 0, controls: 4, expectText: ['阳性对照·对账单一笔借方 +1', '阳性对照·对象名换掉', '解析器在真表上'] },
  { key: 'e2e-business-chain', kind: 'chain', cls: '②-2', file: 'scripts/acceptance-e2e-business-chain.mjs', args: [],
    // 这一格是**状态依赖**的（同库同日实测到两个态，见下），所以收两个已测形状、别的都红：
    //   A＝本程动了 BusinessSequence（只有 updatedAt、无 createdAt ⇒ 该表不可按行归因）⇒ 32/1/0 + B166 + unproven
    //   B＝本程没动它 ⇒ 33/0/0 + clean（2026-09-26 11:0x 在 HEAD bb7c5e6b 实测）
    // 之前台账写的是"整链永远拿不到通过"，那句在 B 态出现当天就被证伪 ⇒ 这里同时把"不许把 B 态读成 M3 出关"钉住：
    //   B 态只证明"这一程的残留可归因"，不证明"任何一程都可归因"（A 态的根因 BusinessSequence 一个字没修）。
    accept: [
      { pass: 32, fail: 1, gaps: 0, expectText: ['B166', '判定=unproven'], shape: 'A 残留不可归因' },
      { pass: 33, fail: 0, gaps: 0, expectText: ['判定=clean', '归因盲区=0'], shape: 'B 本程未触及无 createdAt 的表' },
    ] },
];

function sh(bin, args, env) {
  const r = spawnSync(bin, args, {
    cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env,
  });
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, rc: r.status ?? -1 };
}

// 数与名字绑在一起打印，并把命中的那一行原文带出来（反解会撒谎：只留数字的读数不可核）
// 两套汇总格式并存：`══ 结果：32 通过 / 1 失败 / 0 缺口 ══` 与 ` 通过 3 · 失败 0`
const SUM_PATTERNS = [
  /(\d+)\s*通过\s*\/\s*(\d+)\s*失败(?:\s*\/\s*(\d+)\s*缺口)?/,
  /通过\s*(\d+)\s*·\s*失败\s*(\d+)/,
];

export function parseSummary(out) {
  const lines = out.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    for (const re of SUM_PATTERNS) {
      const m = lines[i].match(re);
      if (m) return { pass: Number(m[1]), fail: Number(m[2]), gaps: m[3] == null ? null : Number(m[3]), line: lines[i].trim() };
    }
  }
  return null;
}

export function countControls(out) {
  return out.split('\n').filter(l => l.includes('✓') && l.includes('阳性对照')).length;
}

// 每把尺自己会打印它连的端点。运行器验的是 A 后端、尺连的却是 B（尺的默认值是 8081）⇒ 读数署不到本分支。
// 这里拿运行器验过的那个端点逐臂核对，对不上就红；尺只报个端口号（整链那把）也按端口比。
export function baseMismatch(out, base) {
  const want = base.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const port = want.includes(':') ? want.split(':')[1] : '';
  const printed = [...out.matchAll(/(?:端点|后端|BASE|base)\s*[:=]?\s*(\S+)/g)].map(m =>
    m[1].replace(/^https?:\/\//, '').replace(/[，,。.）)】\]]+$/, ''));
  if (printed.length === 0) {
    return out.includes(want) ? null : `输出里取不到端点 ⇒ 无法确认连的是 ${want}`;
  }
  const ok = printed.some(p => p === want || (port != null && /^\d+$/.test(p) && p === port));
  return ok ? null : `端点=${printed.join(',')} ≠ 运行器验过的 ${want}`;
}

export function matchShape(arm, parsed, out) {
  if (!arm.accept || !parsed) return null;
  for (const s of arm.accept) {
    if (parsed.pass !== s.pass || parsed.fail !== s.fail || parsed.gaps !== s.gaps) continue;
    if ((s.expectText ?? []).every(t => out.includes(t))) return s.shape;
  }
  return null;
}

// 判决函数与"跑脚本"分开，好让 --self-check 能喂假读数进去验它有没有牙
export function judgeArm(arm, parsed, out, base) {
  const bad = [];
  if (arm.accept) {
    if (!parsed) bad.push('摘要行解析不到 ⇒ 无法判形状');
    else if (!matchShape(arm, parsed, out)) {
      bad.push(`读数不落在两个已测形状里（实测 ${parsed.pass}/${parsed.fail}/${parsed.gaps}）⇒ 要么新增红、要么该格换了形状，都得先现量`);
    }
  } else if (parsed) {
    if (arm.pass != null && parsed.pass !== arm.pass) bad.push(`通过 ${parsed.pass}≠期望 ${arm.pass}`);
    if (arm.fail != null && parsed.fail !== arm.fail) bad.push(`失败 ${parsed.fail}≠期望 ${arm.fail}`);
    if (arm.gaps != null && parsed.gaps !== arm.gaps) bad.push(`缺口 ${parsed.gaps}≠期望 ${arm.gaps}`);
  } else if (arm.kind !== 'seed') {
    bad.push('摘要行解析不到（尺可能改了输出格式，或中途崩了）⇒ 不许按 0 处理');
  }
  for (const t of arm.expectText ?? []) if (!out.includes(t)) bad.push(`缺少关键句「${t}」`);
  if (arm.controls != null) {
    const got = countControls(out);
    if (got < arm.controls) bad.push(`阳性对照 ✓ 只有 ${got} 条，期望 ≥ ${arm.controls}`);
  }
  // 不连端点的臂（只读本机文件）：不许静默跳过端点核对，改成"必须自报作用域"，
  // 且一旦它其实打出了端点/服务地址，这句"不访问外部"就被自己的输出证伪 ⇒ 红。
  if (arm.baseExempt) {
    if (!out.includes(arm.baseExempt)) bad.push(`声明了免端点却找不到作用域句「${arm.baseExempt}」⇒ 它连了谁？先现量再放行`);
    if (/https?:\/\/\S+:\d{2,5}/.test(out) || /(?:端点|后端)\s*[:=]/.test(out)) bad.push('免端点臂的输出里出现了服务地址 ⇒ "不访问外部服务"这句已被证伪');
  } else if (arm.kind !== 'seed') {
    const m = baseMismatch(out, base);
    if (m) bad.push(m);
  }
  return bad;
}

export function getHealth(base) {
  return new Promise((resolve, reject) => {
    const u = new URL('/api/health', base);
    const req = http.get({ host: u.hostname, port: u.port, path: u.pathname, timeout: 8000 }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', d => { buf += d; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('health 超时')));
    req.on('error', reject);
  });
}

// 跑的不是当天代码 ⇒ 拒绝出数。判据＝"该 build 到 HEAD 之间，server/ 有没有文件变过"。
export function freshness(build, head) {
  const anc = spawnSync('git', ['merge-base', '--is-ancestor', build, head], { cwd: REPO, encoding: 'utf8' });
  if (anc.status !== 0) return { ok: false, reason: `build ${build} 不是本分支 HEAD 的祖先（不是这棵树的代码，或 sha 已改写）` };
  const log = spawnSync('git', ['log', '--format=', '--name-only', `${build}..${head}`, '--', 'server/'], { cwd: REPO, encoding: 'utf8' });
  const files = new Set((log.stdout ?? '').split('\n').map(s => s.trim()).filter(Boolean));
  if (files.size > 0) return { ok: false, reason: `${build}..${head} 之间有 ${files.size} 个 server/ 文件变过 ⇒ 该端口跑的是旧代码`, sample: [...files].slice(0, 3) };
  return { ok: true };
}

function selfCheck() {
  const rows = [];
  const push = (name, ok, note) => rows.push({ name, ok, note });
  const s = parseSummary('══ 结果：32 通过 / 1 失败 / 0 缺口（待口径或未覆盖） ══');
  push('解析：整链那行', !!s && s.pass === 32 && s.fail === 1 && s.gaps === 0, JSON.stringify(s));
  const s2 = parseSummary(' 通过 3 · 失败 0');
  push('解析：`通过 N · 失败 M` 那种格式也认（六把尺里有四把是这格式）', !!s2 && s2.pass === 3 && s2.fail === 0, JSON.stringify(s2));
  const s3 = parseSummary(' 通过 1 · 失败 0（某一节的小计）\n 通过 6 · 失败 0');
  push('解析：取最后一条汇总行，不取中间那个小计', !!s3 && s3.pass === 6, JSON.stringify(s3));
  push('解析：缺关键句时不许回落 0', parseSummary('脚本崩在半路') === null, 'null');
  const B = 'http://127.0.0.1:8090';
  const good = '端点 http://127.0.0.1:8090 · 只读';
  const wrong = judgeArm({ key: 'x', kind: 'collide', pass: 3, fail: 0 }, { pass: 2, fail: 1, line: 'l' }, good, B);
  push('判决：读数变小时必须红', wrong.length === 2, wrong.join(' | '));
  const lostCtl = judgeArm({ key: 'y', kind: 'control', pass: 4, fail: 0, controls: 2 }, { pass: 4, fail: 0, line: 'l' }, good, B);
  push('判决：对照掉牙必须红', lostCtl.length === 1 && lostCtl[0].includes('阳性对照'), lostCtl.join(' | '));
  const goodArm = judgeArm({ key: 'z', kind: 'control', pass: 4, fail: 0, controls: 2 }, { pass: 4, fail: 0, line: 'l' },
    `${good}\n ✓ 阳性对照 A — 报出 1 处\n ✓ 阳性对照 B — 报出 1 处`, B);
  push('判决：等价写法不许假红（对照齐、读数齐 ⇒ 0 条问题）', goodArm.length === 0, goodArm.join(' | '));
  const mm8081 = baseMismatch(' 端点 http://127.0.0.1:8081 · 只读', 'http://127.0.0.1:8090');
  push('端点：尺连到 8081 而运行器验的是 8090 ⇒ 必须红，且要说清连到哪',
    mm8081 != null && mm8081.includes('8081'), mm8081);
  push('端点：整链那把只报端口号（后端:8090）⇒ 应放行',
    baseMismatch('  后端:8090  pid=48528 cwd=…', 'http://127.0.0.1:8090') === null, 'null');
  const mmNone = baseMismatch('这是一段什么都没写的输出', 'http://127.0.0.1:8090');
  push('端点：取不到端点时不许当作一致', mmNone != null && mmNone.includes('无法确认'), mmNone);
  // 免端点那一支：三格都要有——放行条件、缺作用域句、以及"它其实连了端点"被自己的输出证伪
  const exemptArm = ARMS.find(a => a.baseExempt);
  push('免端点：必须有臂声明这件事（否则这一支是死码，永不跑）', exemptArm != null, exemptArm ? exemptArm.key : '无');
  const exOk = judgeArm({ key: 'e1', kind: 'collide', pass: 2, fail: 0, baseExempt: '作用域=本机文件（不访问任何外部服务）' },
    { pass: 2, fail: 0, line: 'l' }, '  作用域=本机文件（不访问任何外部服务） — 只读两份文件\n 结论：2 通过 / 0 失败', B);
  push('免端点：作用域句在 ⇒ 不要求端点、也不报问题', exOk.length === 0, exOk.join(' | '));
  const exMiss = judgeArm({ key: 'e2', kind: 'collide', pass: 2, fail: 0, baseExempt: '作用域=本机文件（不访问任何外部服务）' },
    { pass: 2, fail: 0, line: 'l' }, ' 结论：2 通过 / 0 失败', B);
  push('免端点：作用域句被删 ⇒ 必须红（豁免不是免检）', exMiss.length === 1 && exMiss[0].includes('作用域'), exMiss.join(' | '));
  const exLie = judgeArm({ key: 'e3', kind: 'collide', pass: 2, fail: 0, baseExempt: '作用域=本机文件（不访问任何外部服务）' },
    { pass: 2, fail: 0, line: 'l' }, '  作用域=本机文件（不访问任何外部服务）\n  端点 http://127.0.0.1:8090\n 结论：2 通过 / 0 失败', B);
  push('免端点：它其实连了服务 ⇒ 那句自报被自己的输出证伪，必须红', exLie.length === 1 && exLie[0].includes('证伪'), exLie.join(' | '));
  const chainArm = ARMS.find(a => a.key === 'e2e-business-chain');
  push('整链：A 态（32/1/0 + B166 + unproven）收',
    judgeArm(chainArm, { pass: 32, fail: 1, gaps: 0, line: 'l' }, `${good} B166 判定=unproven`, B).length === 0, 'ok');
  push('整链：B 态（33/0/0 + clean + 归因盲区=0）收',
    judgeArm(chainArm, { pass: 33, fail: 0, gaps: 0, line: 'l' }, `${good} 判定=clean 归因盲区=0`, B).length === 0, 'ok');
  push('整链：第三个形状必须红（放宽只到"两个实测态"，不是"随便哪种绿"）',
    judgeArm(chainArm, { pass: 34, fail: 0, gaps: 0, line: 'l' }, `${good} 判定=clean 归因盲区=0`, B).length === 1, 'red');
  push('整链：B 态但盲区没清零 ⇒ 也必须红（关键句不许只对着数）',
    judgeArm(chainArm, { pass: 33, fail: 0, gaps: 0, line: 'l' }, `${good} 判定=clean 归因盲区=1`, B).length === 1, 'red');
  push('整链：红项换了名字（不是 B166）⇒ 必须红',
    judgeArm(chainArm, { pass: 32, fail: 1, gaps: 0, line: 'l' }, `${good} 判定=unproven 归因盲区=1`, B).length === 1, 'red');
  const f0 = freshness('86a451ce', 'HEAD');
  push('身份：旧后端（:8081 的 build）判为**不新鲜**', f0.ok === false, f0.reason);
  // :8081 那一格走的是"不是本分支祖先"这一支；"是本分支祖先、但之后 server/ 变过"是另一支，得有它自己的证人
  const revOld = spawnSync('git', ['log', '--format=%h', '--', 'server/'], { cwd: REPO, encoding: 'utf8' }).stdout.trim().split('\n');
  const old = revOld.length > 1 ? revOld[1] : null;
  const fOld = old ? freshness(old, 'HEAD') : { ok: false, reason: '本分支只有 1 个 server/ 提交，构造不出该臂' };
  push('身份：本分支旧 commit（祖先、但 server/ 之后变过）判为不新鲜', fOld.ok === false && (fOld.reason ?? '').includes('server/ 文件变过'), `${old ?? 'n/a'} — ${fOld.reason}`);
  const f1 = freshness('HEAD', 'HEAD');
  push('身份：HEAD 自身判为新鲜', f1.ok === true, f1.reason ?? 'ok');
  const f2 = freshness('not-a-rev-xyz', 'HEAD');
  push('身份：解析不了的 sha 判为不新鲜', f2.ok === false, f2.reason);
  for (const r of rows) console.log(`${r.ok ? '✓' : '✗'} 自证 ${r.name} — ${r.note}`);
  const red = rows.filter(r => !r.ok).length;
  console.log(`\n[M3-SELFCHECK] ${rows.length - red} 通过 / ${red} 失败`);
  return red === 0 ? 0 : 1;
}

async function main() {
  if (SELF_CHECK) return selfCheck();

  const head = spawnSync('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim();
  const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim();
  // 与整链那把尺同一条规则（B160）：工作树脏＝读数署不到任何 commit ⇒ 整套都不跑，而不是只躲开 server/
  const dirtyLines = (spawnSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' }).stdout || '')
    .split('\n').filter(Boolean);
  // 日志必须落在**被忽略**的目录：整链那把尺见脏就拒跑，而日志本身就是脏源
  const logDir = process.env.M3_LOG_DIR ?? path.join(REPO, 'logs', 'm3-final');
  const hasLocalEnvFile = fs.existsSync(path.join(REPO, 'server/.env.local')) || fs.existsSync(path.join(REPO, 'server/.env'));
  const envFrom = process.env.DATABASE_URL ? 'process.env.DATABASE_URL'
    : fs.existsSync(path.join(REPO, 'server/.env.local')) ? 'server/.env.local（本树）'
      : fs.existsSync(path.join(REPO, 'server/.env')) ? 'server/.env（本树）' : null;
  const issues = preflightEnvIssues({ hasLocalEnvFile });
  if (issues.length) {
    // 缺输入就当众拒，别跑完 22 臂再让最后两臂看起来像"产品回归"
    console.log('✗ 起跑前置没过（一条臂都不跑，免得尾巴上的"没跑"被读成"通过"）：');
    for (const x of issues) console.log(`    · 缺 ${x.key} —— ${x.why}`);
    return 1;
  }
  console.log(`[M3-FINAL] 起跑 仓库=${REPO} 分支=${branch} HEAD=${head} 工作树未提交=${dirtyLines.length} 处 · env 来源=${envFrom} · BASE=${BASE} · 逐臂日志=${logDir}`);
  if (dirtyLines.length > 0) {
    console.log(`✗ 工作树有 ${dirtyLines.length} 处未提交 ⇒ 这套读数署不到任何 commit（与整链那把尺同一条规则，§9 B160）：`);
    for (const l of dirtyLines.slice(0, 8)) console.log(`    ${l}`);
    console.log('  ⇒ 先提交再跑；不要为了跑绿而 stash（会把别处的活一起卷走）。');
    return 1;
  }

  let health;
  try {
    health = await getHealth(BASE);
  } catch (e) {
    console.log(`✗ 后端取不到（${BASE}）：${e.message} ⇒ 拒绝出数`);
    return 1;
  }
  const fr = freshness(health.build, 'HEAD');
  if (!fr.ok) {
    console.log(`✗ 后端身份不成立：${fr.reason}（该端口自报 build=${health.build}）${fr.sample ? ` 例如 ${fr.sample.join(', ')}` : ''}`);
    console.log('  ⇒ 把该端口重启到当前 HEAD 再来（② 要求"读数换到今天的代码"，跑在旧后端上的绿不算读数）');
    return 1;
  }
  console.log(`✓ 后端身份：build=${health.build} 到 HEAD 之间 server/ 零变动 ⇒ 本套读数署得到 ${head}`);

  const results = [];
  const childEnv = { ...process.env, BAMBOOK_API: BASE, CHAIN_BASE: BASE };
  fs.mkdirSync(logDir, { recursive: true });
  for (const arm of ARMS) {
    const cmd = path.extname(arm.file) === '.mjs' ? [process.execPath, arm.file, ...arm.args] : ['npx', 'tsx', arm.file, ...arm.args];
    const r = sh(cmd[0], cmd.slice(1), childEnv);
    const logFile = path.join(logDir, `${arm.key.replace(/[^\w.-]/g, '_')}.log`);
    fs.writeFileSync(logFile, `# rc=${r.rc} · ${arm.file} ${arm.args.join(' ')}\n${r.out}`);
    const parsed = parseSummary(r.out);
    const bad = judgeArm(arm, parsed, r.out, BASE);
    const shape = matchShape(arm, parsed, r.out);
    results.push({ arm, parsed, rc: r.rc, bad, shape });
    console.log(`${bad.length ? '✗' : '✓'} ${arm.cls} ${arm.key} — ${parsed ? parsed.line : `(无摘要行) rc=${r.rc}`}${shape ? ` ⟵形状 ${shape}` : ''}${bad.length ? ` ⚠️ ${bad.join('；')}（全文 ${logFile}）` : ''}`);
  }

  const red = results.filter(x => x.bad.length);
  const byKind = k => results.filter(x => x.arm.kind === k).length;
  console.log('\n─────────────────────────────────────────────────');
  console.log(`[M3-FINAL] HEAD=${head} build=${health.build} base=${BASE} 臂=${results.length}（对撞 ${byKind('collide')} · 对照 ${byKind('control')} · 整链 ${byKind('chain')} · 造/还原 ${byKind('seed')}） 未达期望=${red.length}`);
  console.log(`[M3-FINAL-READINGS] ${results.map(x => `${x.arm.key}=${x.parsed ? `${x.parsed.pass}/${x.parsed.fail}${x.parsed.gaps != null ? `/${x.parsed.gaps}` : ''}` : 'n/a'}${x.shape ? `[${x.shape}]` : ''}`).join(' ')}`);
  if (red.length) {
    console.log('\n未达期望的臂（逐条）：');
    for (const x of red) console.log(`  ✗ ${x.arm.key} — ${x.bad.join('；')}`);
    console.log('\n⇒ 读数变了就是变了：先现量确认原因（新产品码？数据变了？尺改了？），再决定改表还是改码。为了让脚本绿而改期望值＝把这套终检作废。');
    return 1;
  }
  const chainShape = results.find(x => x.arm.kind === 'chain')?.shape ?? '?';
  console.log(`\n⚠️ 本套绿**不等于 M3 出关**。整链这一次落在形状「${chainShape}」：`);
  if (chainShape.startsWith('A')) {
    console.log('   · 这一程动了 `BusinessSequence`（只有 `updatedAt`、无 `createdAt`）⇒ 残留判决 `unproven`，整链本身就没过；');
  } else {
    console.log('   · 这一程没动 `BusinessSequence` ⇒ 判 `clean`，但那只覆盖"这一程的残留可归因"，不覆盖"任何一程"（那张表仍无 `createdAt`，动了它的那一程仍是 A 态）；');
  }
  console.log('   · 另两条未清项（利润表面按 D102 不比跨视图、②-6 只在按业务员汇总那一层）见台账 §8 M3 行"未清四条"，**本运行器不复核它们**；');
  console.log('   · 因此本套绿＝"这套对撞与对照在今天的代码上成立"，不是"M3 出关"。');
  return 0;
}

/**
 * 起跑前置：把"跑到尾巴才露"的两条输入挪到最前面（v3.237 补 26）。
 *
 * 今天实测到的形状：少给 `EXPORT_COLLIDE_PASSWORD` 时，前 22 臂照样跑完，最后两臂才报
 * "摘要行解析不到" ⇒ 看着像产品回归，其实是我少一个输入（那两臂自己没错：缺口令就拒绝取数）。
 *
 * @param {{env?: Record<string,string|undefined>, hasLocalEnvFile?: boolean}} p
 * @returns {{key: string, why: string}[]} 缺哪几条（空数组＝可以开跑）
 */
export function preflightEnvIssues({ env = process.env, hasLocalEnvFile = false } = {}) {
  const issues = [];
  if (!env.DATABASE_URL && !hasLocalEnvFile) {
    issues.push({ key: 'DATABASE_URL', why: '本树没有 server/.env(.local)，也没收到显式 DATABASE_URL ⇒ 跨树借 env 正是 B35 要消灭的事' });
  }
  if (!env.BAMBOOK_DEMO_PASSWORD && !env.EXPORT_COLLIDE_PASSWORD) {
    issues.push({ key: 'EXPORT_COLLIDE_PASSWORD', why: '演示口令：补 40 起 8 条派生量臂 + 导出碰撞两臂都从 env 读（主名 BAMBOOK_DEMO_PASSWORD，本名仍作别名 ⇒ 两个都没给才算缺）；没给就只能"没跑"，不许读成"全等"' });
  }
  return issues;
}

// 只有"被当成命令跑"时才开跑；被 import（本文件的判据有测试在读）不许顺手把 24 臂跑一遍。
// ★ 判定用仓里那一族唯一的一份实现（`isCliEntry`，两侧 realpath）——自己比 argv[1] 与模块路径
//   会被 `acceptance-selfcheck` 那把既有尺当场抓住（经符号链接调用会静默不跑还退 0＝假绿）。
if (isCliEntry(import.meta.url)) {
  main().then(rc => { process.exitCode = rc; }).catch(e => {
    console.log(`✗ 运行器自身崩了：${e?.stack ?? e}`);
    process.exitCode = 2;
  });
}
