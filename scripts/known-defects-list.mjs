/**
 * 已知缺陷清单生成器（goal ③/④ · v3.144）
 *
 * 为什么要有这个文件：§11 第 10 条要的是「**已知缺陷清单已交付**」，而台账 §9 有 209 行 B 条——
 *   「清单」如果只是一份手抄的 markdown，它三天就会和 §9 脱钩（本仓的老病：文档说的和账上不一样）。
 *   ⇒ 本件把清单变成**从台账 §9 机读生成**的产物，并提供 `--check`：重新生成一次、和磁盘那份逐字节比，
 *     不一样就退出码非 0（＝"清单与 §9 脱钩"这件迟早会发生的事，现在有了声音）。
 *
 * 分类的诚实边界（重要）：
 *   · 档位**只按第 4 格里出现过的显式状态记号**归（⏸ / 等 Kevin 拍 / 待拍 / ◐ / ✅ / ❌ / ⚠️，按此优先级取第一个命中）；
 *     没有任何记号的 ⇒ 落进「未带状态记号」并**逐条点名**，不折算成任何一档。
 *   · 每条都同时抄出**状态格原文**，所以我归错档时读者能一眼看见——清单不替 §9 说话，只转述它。
 *   · §11 第 10 条那句「无阻断/口径级未修项」的判定**不由本件宣布**：那是内容判断（要人读标题），
 *     本件只给出候选数量与点名。
 *
 * 用法：
 *   node scripts/known-defects-list.mjs                # 生成/刷新 docs/已知缺陷清单-<日期>.md
 *   node scripts/known-defects-list.mjs --check        # 复量：与磁盘那份逐字节比（脱钩则红）
 *   node scripts/known-defects-list.mjs --self-check   # 分类器自己的正反用例（含"混合记号"这一格）
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..');
const LEDGER = path.join(REPO, 'docs/交付目标与验收标准-2026-09-20.md');
const OUT = path.join(REPO, 'docs/已知缺陷清单-2026-09-26.md');
const MARKS = ['⏸', '等 Kevin 拍', '待拍', '◐', '✅', '❌', '⚠️'];

function parseRows() {
  const lines = fs.readFileSync(LEDGER, 'utf8').split('\n');
  const rows = [];
  lines.forEach((l, i) => {
    const m = /^\| \*\*(B\d+)\*\* \|/.exec(l);
    if (!m) return;
    const cells = l.split('|');
    if (cells.length < 6) return;
    rows.push({
      id: m[1], line: i + 1,
      kind: (cells[2].match(/^\s*\*\*(.+?)（/) || cells[2].match(/^\s*\*\*(.+?)\*\*/) || [, '未标类别'])[1].trim(),
      title: cells[2].replace(/\*\*/g, '').trim(),
      status: cells[cells.length - 2].replace(/\*\*/g, '').trim(),
    });
  });
  return rows;
}

// ---------- 无记号那批行的"散文档" ----------
// 只报**那一格自己写的词**（并把命中的词打印出来供人逐行审），不代替状态记号、也不判那句话是真是假。
// ★ 一条硬规矩：散文档**只在没有记号时启用**，且永远不折算进上面那七档 ⇒ 否则就是把未经核实的散文洗成机器可读结论。
const CLOSED = ['已修', '已闭', '已补', '已接上', '已落地', '已结', '闭环', '已实现', '已建'];
const PENDING = ['待核实', '待验证', '待复核', '待独立验证', '待确认', '待使用方', '待 Kevin', '待排期', '待拍'];
const OPENED = ['只立账', '未修', '仍未', '未清', '开着', '未达成', '未覆盖', '延后', '立账', '未做', '缺失', '未实现', '未建', '未接', '未闭环'];
// 「未闭环」里含"闭环"两字，但它说的是**没闭** ⇒ 命中前先看前一个字是不是"未"（这类负向词是本分类器最容易骗过的一格）
function hits(word, st) {
  let from = 0;
  while (true) {
    const at = st.indexOf(word, from);
    if (at < 0) return false;
    if (st[at - 1] !== '未') return true;
    from = at + 1;
  }
}
function proseState(status) {
  const c = CLOSED.filter(w => hits(w, status));
  const p = PENDING.filter(w => hits(w, status));
  const o = OPENED.filter(w => hits(w, status));
  const fam = [c.length, p.length, o.length].filter(Boolean).length;
  const key = fam >= 2 ? '混合（不止一种口风）' : c.length ? '散文-已闭' : p.length ? '散文-待核' : o.length ? '散文-未闭' : '无信号（留给人）';
  return { key, words: [...c, ...p, ...o] };
}
const PROSE_ORDER = ['散文-未闭', '散文-待核', '混合（不止一种口风）', '散文-已闭', '无信号（留给人）'];

function bucket(status) {
  for (const mk of MARKS) if (status.includes(mk)) return mk;
  return '（无状态记号）';
}

// ---------- §9 状态格里的 commit 指针：抽出来 + 逐个问 git 存不存在 ----------
// 只认"反引号包起来的 7/8 位十六进制、且至少含一个字母"。全数字（`20260925` 这类日期/序号）不当指针，
// 否则会把日期读成"查无此 commit"＝发假指控。
const CITE = /`([0-9a-f]{7,8})`/g;
function citeTokens(rows) {
  const hits = [];
  for (const r of rows) {
    for (const m of r.status.matchAll(CITE)) {
      if (/[a-f]/.test(m[1])) hits.push({ id: r.id, line: r.line, tok: m[1] });
    }
  }
  return hits;
}

function resolveCites(hits, git = p => spawnSync('git', p, { cwd: REPO, encoding: 'utf8' })) {
  const bad = [];
  for (const h of hits) {
    const r = git(['cat-file', '-t', h.tok]);
    if (r.status !== 0 || (r.stdout ?? '').trim() !== 'commit') bad.push({ ...h, why: (r.stderr ?? r.stdout ?? '').trim().slice(0, 40) || '非 commit 对象' });
  }
  return { total: hits.length, bad };
}

// 判卷与"问 git"分开，好让 --self-check 能喂假读数进去验它有没有牙。
// 0 处分母不判通过（本仓的老病：空转的格长得像绿格）。
function citeVerdict({ total, bad }) {
  if (total === 0) return { ok: false, msg: '§9 状态格里一处 commit 指针都没有 ⇒ 这格无法判（先现量：是指针被删光了，还是抽取口径又变了）' };
  if (bad.length) return { ok: false, msg: `${bad.length}/${total} 处 commit 指针查无此对象 ⇒ 要么写错、要么历史被改写过（push 前那次清理就会触发这一格）：` +
    bad.slice(0, 6).map(b => `${b.id}@\`${b.tok}\`(${b.why})`).join(' ') };
  return { ok: true, msg: `§9 状态格里 ${total} 处 commit 指针全部指向真 commit` };
}

// ---------- 版本锚点：§9 里"已修（vX.Y）"这类话，指向的那一批还追得到吗 ----------
// 两个证人，都在**引用行的外面**（不是自比）：
//   ① 台账文本里**声明过**这个版本（横幅 / 降级行 / 附录 A 行 / `> **vX = ` 那种历史行）
//   ② git 提交信息里出现这枚 `vX.Y`（提交信息不会被文档裁剪掉 ⇒ 比①更耐久的证人）
// 只认形如 v数字.数字 的锚点；命中不了就点名，**不许把"解析不到"写成"不适用"**。
const ANCHOR = /\bv\d+\.\d+\b/g;
function versionAnchors(rows) {
  const by = new Map();
  for (const r of rows) for (const m of r.status.matchAll(ANCHOR)) {
    if (!by.has(m[0])) by.set(m[0], []);
    by.get(m[0]).push(r.id);
  }
  return by;
}
function declaredVersions(text) {
  const set = new Set();
  const pats = [/\*\*版本 (v\d+\.\d+)（/g, /（(v\d+\.\d+)）原文/g, /^\| (v\d+\.\d+) \|/gm, /^> \*\*(v\d+\.\d+) = /gm];
  for (const p of pats) for (const m of text.matchAll(p)) set.add(m[1]);
  return set;
}
function resolveAnchors(anchors, declared, git = p => spawnSync('git', p, { cwd: REPO, encoding: 'utf8' })) {
  const missing = [];
  let byGit = 0;
  for (const [ref, ids] of anchors) {
    if (declared.has(ref)) continue;
    const r = git(['log', '--format=%h', '--grep', ref]);
    if ((r.stdout ?? '').trim()) { byGit++; continue; }
    missing.push({ ref, ids });
  }
  return { total: anchors.size, declaredOnly: anchors.size - missing.length - byGit, byGit, missing };
}
function anchorVerdict({ total, missing }) {
  if (total === 0) return { ok: false, msg: '§9 里一个版本锚点都没有 ⇒ 这格无法判（口径变了还是引用被删光了）' };
  if (missing.length) return { ok: false, msg: `${missing.length}/${total} 个版本锚点两头都追不到（台账没声明、git 提交信息里也没有）⇒ 引用错置：` +
    missing.map(m => `${m.ref}←${m.ids.join(',')}`).slice(0, 8).join(' ') };
  return { ok: true, msg: `§9 里 ${total} 个版本锚点全部追得到（台账声明 + git 提交信息两种证人）` };
}


function render(rows) {
  const by = new Map();
  for (const r of rows) {
    const b = bucket(r.status);
    if (!by.has(b)) by.set(b, []);
    by.get(b).push(r);
  }
  const order = [...MARKS, '（无状态记号）'].filter(k => by.has(k));
  const out = [];
  out.push('# 已知缺陷清单（由台账 §9 机读生成 · 请勿手改）');
  out.push('');
  out.push('> **生成方式**：`node scripts/known-defects-list.mjs`（读 `docs/交付目标与验收标准-2026-09-20.md` 的 §9 **主表四列** B 行 —— 其他表形的 B 行不入本分母，缺口现量见台账 v3.229）。');
  out.push('> ★ 本文件是**转述**，不是第二份真源：状态档位只按 §9 第 4 格里**已有的记号**归，每条都抄出状态格原文，');
  out.push('>   归错了一眼看得见；改内容请改台账，然后重新生成。`--check` 会逐字节比对，脱钩就红。');
  out.push('');
  out.push('## 一、分档计数（由本文件生成时现量）');
  out.push('');
  out.push('| 记号 | 含义（§9 第 4 格里的记号，不是我下的判断） | 条数 |');
  out.push('|---|---|---|');
  const MEANING = {
    '⏸': '刻意停下等决定 / 延后', '等 Kevin 拍': '等使用方拍板', '待拍': '等使用方拍板（散文写法）',
    '◐': '部分达成 / 半开', '✅': '已修 / 已闭', '❌': '本次不可达成', '⚠️': '仍在、但带限制说明',
    '（无状态记号）': '第 4 格里没有任何上述记号 ⇒ 逐条点名在下面，不折算进任何档',
  };
  for (const k of order) out.push(`| \`${k}\` | ${MEANING[k] ?? ''} | ${by.get(k).length} |`);
  out.push(`| **合计** | §9 主表四列 B 行 | **${rows.length}** |`);
  out.push('');
  const noMark = by.get('（无状态记号）') ?? [];
  out.push(`★ **现量出的真实工作量**：${noMark.length} 行的第 4 格里**没有任何上述状态记号** ⇒ `);
  out.push('  下面「散文档」那一节把这批行按**那一格自己用的词**分成五档（作用只是"把该看的行挑出来给人看"，不代替记号、不判真假）。');
  out.push('  ⇒ "把 §9 变成一份能交付的清单"这件事的缺口不在解析，而在**这些行没有机器可读的状态**；本件**不猜**它们的状态（宁可留空、点名）。');
  const cites = citeTokens(rows);
  const citeRows = new Set(cites.map(c => c.id)).size;
  out.push(`★ **状态格里的 commit 指针**：${citeRows} 行 / 共 ${cites.length} 处（只认反引号里的 7–8 位十六进制且含字母；全数字那种是日期，不算指针）。`);
  out.push('  ⇒ 本文件**不写**"这些指针还指不指得到"的结论（那会变成一份"生成时正确、以后腐烂"的快照）；那一判由 `--check` 第三格现核现打。');
  const anchors = versionAnchors(rows);
  const undec = [...anchors.keys()].filter(k => !declaredVersions(fs.readFileSync(LEDGER, 'utf8')).has(k));
  out.push(`★ **版本锚点普查**：§9 的状态格里引用了 ${anchors.size} 个不同批次号（「vX.Y」那种），其中 ${undec.length} 个在台账现存文本里**已经没有对应的声明横幅**（版本史被裁剪过）`);
  out.push('  ⇒ 那批引用只能由 **git 提交信息**作证；这一判同样不留快照，由 `--check` 第四格现做现打（两种证人：台账声明 / git 里出现这枚标记）。');
  // 散文档：只对"没有记号"的那批行启用，逐行把**命中的原词**打出来，让人能一眼审
  const proseBy = new Map(PROSE_ORDER.map(k => [k, []]));
  for (const r of noMark) {
    const p = proseState(r.status);
    r.prose = p;
    proseBy.get(p.key).push(r);
  }
  const proseSum = PROSE_ORDER.reduce((n, k) => n + proseBy.get(k).length, 0);
  if (proseSum !== noMark.length) throw new Error(`散文档吞行或重计：四档合计 ${proseSum} ≠ 无记号 ${noMark.length} ⇒ 分类器坏了，不许出文件`);
  out.push('');
  out.push('### 无记号那批行的**散文档**（读的是那一格自己的原话，不是新的结论）');
  out.push('');
  out.push('| 散文档 | 条数 | 它说的是什么 |');
  out.push('|---|---|---|');
  const PM = {
    '散文-未闭': '那一格里有"未修 / 只立账 / 仍未 / 延后…"这类词 ⇒ **大概率还开着**，但没打记号',
    '散文-待核': '那一格里写的是"待核实 / 待复核 / 待独立验证…" ⇒ 话说着要做什么，但**没说是哪一档**，本件不代它折算',
    '混合（不止一种口风）': '同一格里出现了**两种以上**口风（已修 + 未修、或 已修 + 待核…）⇒ **不许折算进任一档**，逐行读才知道哪半是主句',
    '散文-已闭': '那一格里有"已修 / 已闭 / 已落地…"这类词 ⇒ **大概率已闭**，但同样没打记号，本件不代它宣布',
    '无信号（留给人）': '那一格里没有任何可匹配的状态词 ⇒ 这一档才是"必须人来补状态"的真缺口',
  };
  for (const k of PROSE_ORDER) out.push(`| ${k} | ${proseBy.get(k).length} | ${PM[k]} |`);
  out.push(`| **合计** | **${proseSum}** | ＝上面「（无状态记号）」那一档的行数（对不上就抛错、不出文件） |`);
  out.push('');
  out.push('> ★ **为什么不把「散文-已闭」那几十行直接写成 ✅**：那等于把**未经核实的一句话**洗成机器可读结论，');
  out.push('>   而本仓反复吃过的那类病恰恰是"文档里写着已修、其实没修"（§9 里就有就地更正的先例）。');
  out.push('>   ⇒ 这一档只是**把该看的行挑出来给人看**（每行都印了命中的原词），补记号要逐行核过再改台账。');
  out.push('');
  out.push('## 二、§11 第 10 条不在这份清单里被宣布');
  out.push('');
  out.push('第 10 条要的是「清单已交付 **且无阻断/口径级未修项**」。后半句是**内容判断**（要人读标题与后果），');
  out.push('本生成器只做机械转述 ⇒ **不替它打勾**。可读的候选是上面「未闭」那几档的条数，');
  out.push('逐条内容仍在台账 §9（本文件每行都带台账行号，可跳读）。');
  out.push('');
  out.push('## 三、逐条（按台账出现顺序 · 编号 / 台账行号 / 类别 / 状态记号 / 标题）');
  out.push('');
  out.push('| B 条 | 台账行 | 类别 | 记号 | 散文档（命中词） | 标题（§9 第 2 格） | 状态格开头（§9 第 4 格，原文抄） |');
  out.push('|---|---|---|---|---|---|---|');
  const clip = (s, n) => {
    // 必须按**码点**切：按 UTF-16 下标切会把 emoji 切成半个代理对 ⇒ 写盘时变成 U+FFFD、
    // 而内存里那份还是半个代理对 ⇒ "逐字节比对"永远对不上（本批实测：连续两次生成文件相同、
    // 但 --check 恒定报同一行脱钩）。宁可不切，也不切坏。
    const t = Array.from(s.replace(/\|/g, '\\|').replace(/\s+/g, ' '));
    return t.length > n ? t.slice(0, n).join('') + '…' : t.join('');
  };
  // 命中词周围取一小段：让逐行的人**当场看见那句原话**，而不是只看见一个档名（否则审不了、只能信分类器）
  const win = (st, w, n = 24) => {
    const at = w ? st.indexOf(w) : -1;
    if (at < 0) return '';
    const from = Math.max(0, at - n);
    let to = Math.min(st.length, at + w.length + n);
    // 切口的半个代理对丢掉（?? 之前 clip 已按码点切，这里仍可能切在窗口开头）
    const code = st.charCodeAt(to - 1);
    if (code >= 0xd800 && code <= 0xdbff) to -= 1;
    const hi = st.charCodeAt(from);
    return (from > 0 ? '…' : '') + st.slice(hi >= 0xdc00 && hi <= 0xdfff ? from + 1 : from, to) + (to < st.length ? '…' : '');
  };
  for (const r of rows) {
    const pd = !r.prose ? '—'
      : !r.prose.words.length ? r.prose.key
      : `${r.prose.key}：${r.prose.words.slice(0, 2).join('/')} ▸ ${clip(win(r.status, r.prose.words[0]), 58)}`;
    out.push(`| ${r.id} | ${r.line} | ${clip(r.kind, 22)} | \`${bucket(r.status)}\` | ${clip(pd, 96)} | ${clip(r.title, 110)} | ${clip(r.status, 90)} |`);
  }
  out.push('');
  const text = out.join('\n');
  // 收口自检：**落盘之前**验产物没有"半个代理对"和替换符。
  // 这一格是被本批实测逼出来的：切坏一个 emoji 时，写出去的文件两次相同、而 --check 恒定报脱钩
  //（内存里是半个代理对、磁盘上是 U+FFFD ⇒ 两个字符串永远不等 ⇒ 一份"永远修不好"的移交物）。
  const stray = text.match(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  if (stray) throw new Error('产物里有半个代理对 ⇒ 某处截断切坏了字符，去修切片，别忍');
  if (text.includes('\uFFFD')) throw new Error('产物里有替换符 U+FFFD ⇒ 上游已经切坏过，先找到是谁'); // 用 \uFFFD 转义，别贴字面量（贴过来会变空串 ⇒ includes 恒真）
  return text;
}

// ---------- 分类器的正反用例（它自己也要先喂已知样本）----------
function selfCheck() {
  const cases = [
    { s: '✅ **已修**（commit abc）', want: '✅', why: '闭' },
    { s: '⏸ **不自裁**：等 Kevin 拍', want: '⏸', why: '高优先档要压过 ✅/未修' },
    { s: '✅ 已修一半；另一半 ⚠️ 仍开着', want: '✅', why: '按优先级取第一个命中，混合句不猜' },
    { s: '这一条没有记号', want: '（无状态记号）', why: '没记号不许被折进任何档' },
    { s: '◐ **半开**：判据侧已修', want: '◐', why: '半开优先于闭' },
    { s: '等 Kevin 拍（§12.1 第 38 条）', want: '等 Kevin 拍', why: '散文写法也算' },
  ];
  let ok = 0, bad = 0;
  for (const c of cases) {
    const got = bucket(c.s);
    if (got === c.want) { ok++; console.log(`  ✓ ${c.why} → ${got}`); }
    else { bad++; console.log(`  ✗ ${c.why} → 得 ${got}，要 ${c.want}`); }
  }
  // commit 指针那一格：抽取口径三态 + 判卷三态（含"分母为 0 不许算通过"）
  const citeCases = [
    { s: '已修（`8b22d3ac`）', want: 1, why: '含字母的 8 位反引号十六进制 = 指针' },
    { s: '第 25 批（`20260925`）', want: 0, why: '全数字那种是日期，不许当指针（否则假指控"查无此 commit"）' },
    { s: '见 abc12345 与 `abc12345`', want: 1, why: '不带反引号的裸串不算引用（只认被标出来的那种）' },
    { s: '短码 `abc123` / 长码 `8b22d3ac8f`', want: 0, why: '6 位与 10 位都不在口径内（宁窄不宽）' },
  ];
  for (const c of citeCases) {
    const got = citeTokens([{ id: 'X', line: 1, status: c.s }]).length;
    if (got === c.want) { ok++; console.log(`  ✓ 指针口径：${c.why} → ${got} 处`); }
    else { bad++; console.log(`  ✗ 指针口径：${c.why} → 得 ${got}，要 ${c.want}`); }
  }
  const fakeGit = t => (t[2] === 'deadbee1' ? { status: 128, stdout: '', stderr: 'fatal: Not a valid object name' } : { status: 0, stdout: 'commit\n', stderr: '' });
  const vBad = citeVerdict(resolveCites([{ id: 'B1', line: 2, tok: 'deadbee1' }, { id: 'B2', line: 3, tok: '8b22d3ac' }], fakeGit));
  if (!vBad.ok && vBad.msg.includes('B1') && !vBad.msg.includes('B2@')) { ok++; console.log('  ✓ 判卷：查无此对象必须红，且点名到那条 B 行'); }
  else { bad++; console.log(`  ✗ 判卷（查无此对象）→ ${vBad.ok} / ${vBad.msg}`); }
  const vZero = citeVerdict({ total: 0, bad: [] });
  if (!vZero.ok && vZero.msg.includes('无法判')) { ok++; console.log('  ✓ 判卷：0 处分母不许算通过（空转的格长得像绿格）'); }
  else { bad++; console.log(`  ✗ 判卷（零分母）→ ${vZero.ok}`); }
  const vAll = citeVerdict(resolveCites([{ id: 'B2', line: 3, tok: '8b22d3ac' }], fakeGit));
  if (vAll.ok) { ok++; console.log('  ✓ 判卷：全部指得到 ⇒ 绿（这一格同时是上面两格的"能绿"对照）'); }
  else { bad++; console.log(`  ✗ 判卷（全指得到却报红）→ ${vAll.msg}`); }
  // 散文档四档 + 那格最容易骗过分类器的负向词（"未闭环"里含"闭环"，说的却是没闭）
  const proseCases = [
    { s: '开发（账龄报表侧同口径未修）', want: '散文-未闭', why: '只有未修词' },
    { s: '开发（v2.94 已修已验）', want: '散文-已闭', why: '只有已修词' },
    { s: '待独立验证（S0-B 构造）', want: '散文-待核', why: '"待核实/待复核"这一族单独一档，不折算成已闭或未闭' },
    { s: '开发（四条已落地并跑绿；未覆盖：两处局部 code 抄写）', want: '混合（不止一种口风）', why: '两半都有 ⇒ 不许折算进任一档' },
    { s: '已修，待复核读数', want: '混合（不止一种口风）', why: '已闭 + 待核 也是两种口风' },
    { s: 'Kevin 部署后复测（M0-b）', want: '无信号（留给人）', why: '没有任何状态词 ⇒ 留给人的那一档' },
    { s: '本行由"已交付"改回未闭环', want: '散文-未闭', why: '★ 负向词："未闭环"里的"闭环"不算已闭' },
    { s: '✅ 已修（有记号的行不走这里，但传进来也要给个档）', want: '散文-已闭', why: '散文档本身不判记号，由调用方只在无记号时启用' },
  ];
  for (const c of proseCases) {
    const got = proseState(c.s).key;
    if (got === c.want) { ok++; console.log(`  ✓ 散文档：${c.why} → ${got}`); }
    else { bad++; console.log(`  ✗ 散文档：${c.why} → 得 ${got}，要 ${c.want}`); }
  }
  // 版本锚点那一格：三种证人组合 + 零分母（两头都追不到必须红，且要点名是哪条 B 行在引用它）
  const aCases = [
    { ref: 'v3.99', declared: true, gitHit: false, want: true, why: '台账里声明过 ⇒ 不必再问 git' },
    { ref: 'v2.60', declared: false, gitHit: true, want: true, why: '声明横幅被裁掉了，但提交信息里有这枚标记 ⇒ 仍追得到' },
    { ref: 'v9.42', declared: false, gitHit: false, want: false, why: '两头都没有 ⇒ 必须红' },
  ];
  for (const c of aCases) {
    const v = anchorVerdict(resolveAnchors(new Map([[c.ref, ['B999']]]), new Set(c.declared ? [c.ref] : []),
      () => ({ status: 0, stdout: c.gitHit ? 'abc1234\n' : '' })));
    const named = v.msg.includes('B999');
    if (v.ok === c.want && (v.ok || named)) { ok++; console.log(`  ✓ 版本锚点：${c.why}${v.ok ? '' : '（已点名引用行）'}`); }
    else { bad++; console.log(`  ✗ 版本锚点：${c.why} → ok=${v.ok} 点名=${named} / ${v.msg}`); }
  }
  const avZero = anchorVerdict({ total: 0, missing: [] });
  if (!avZero.ok && avZero.msg.includes('无法判')) { ok++; console.log('  ✓ 版本锚点：0 个引用不许判通过'); }
  else { bad++; console.log(`  ✗ 版本锚点（零分母）→ ${avZero.ok}`); }
  console.log(`\n[KNOWN-LIST-SELFCHECK] ${ok} 通过 / ${bad} 失败`);
  process.exit(bad ? 1 : 0);
}

const rows = parseRows();
if (process.argv.includes('--self-check')) selfCheck();
if (!rows.length) { console.log('✗ 一条 B 行都没解析到 ⇒ 台账形状变了，本件不许产出空清单'); process.exit(1); }
const text = render(rows);
if (process.argv.includes('--check')) {
  // 两格判据（不是"只打一行字"）：① 磁盘那份与重新生成的一致 ② §9 分母非空——
  //   否则"逐字节一致"可以是"两边都是空清单"的一致（本仓吃过这类空转绿）。
  const cells = [];
  // 作用域自报：第 20 臂不连任何服务，所以它不能靠"端点核对"证明跑在本机代码上 ——
  // 运行器改为核这一句（见 m3-final-check.mjs 的 baseExempt）。
  console.log('  作用域=本机文件（不访问任何外部服务） — 只读台账 §9 与清单两份文件');
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '(文件不存在)';
  if (cur === text) console.log(`  ✓ 清单与 §9 逐字节一致 — ${rows.length} 行 B 条都被转述`);
  else {
    console.log('  ✗ 清单与 §9 脱钩 —— 重新生成：node scripts/known-defects-list.mjs');
    const a = cur.split('\n'), c = text.split('\n');
    let shown = 0;
    for (let i = 0; i < Math.max(a.length, c.length) && shown < 6; i++) {
      if (a[i] !== c[i]) { console.log(`    第 ${i + 1} 行不同：\n      磁盘 ${(a[i] ?? '').slice(0, 90)}\n      新生 ${(c[i] ?? '').slice(0, 90)}`); shown++; }
    }
  }
  cells.push(cur === text);
  cells.push(rows.length > 0);
  if (cells[1]) console.log(`  ✓ §9 分母非空 — 解析到 ${rows.length} 行 B 条（0 行＝台账形状变了，不算通过）`);
  else console.log('  ✗ §9 分母为 0 ⇒ 台账 §9 的形状变了，这份清单在空转');
  // 第三格：状态格里那些"指向某个 commit"的证据指针，现在还指不指得到。
  // 判据源不是本文件（那会自比），而是 git 对象库：每个 token 问一次 `cat-file -t`。
  const v = citeVerdict(resolveCites(citeTokens(rows)));
  cells.push(v.ok);
  console.log(`  ${v.ok ? '✓' : '✗'} ${v.msg}`);
  // 第四格：§9 那些"已修（vX.Y）"的批次引用，两种证人（台账里声明过 / git 提交信息里有这枚标记）至少要有一个
  const av = anchorVerdict(resolveAnchors(versionAnchors(rows), declaredVersions(fs.readFileSync(LEDGER, 'utf8'))));
  cells.push(av.ok);
  console.log(`  ${av.ok ? '✓' : '✗'} ${av.msg}`);
  const bad = cells.filter(x => !x).length;
  console.log(` 结论：${cells.length - bad} 通过 / ${bad} 失败`);
  process.exit(bad ? 1 : 0);
}
fs.writeFileSync(OUT, text);
const counts = new Map();
for (const r of rows) counts.set(bucket(r.status), (counts.get(bucket(r.status)) ?? 0) + 1);
console.log(`[KNOWN-LIST] 已生成 ${path.relative(REPO, OUT)} · §9 共 ${rows.length} 行 · 分档：` +
  [...counts].map(([k, v]) => `${k}=${v}`).join(' '));
