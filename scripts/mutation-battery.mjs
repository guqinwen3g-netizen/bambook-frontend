#!/usr/bin/env node
/**
 * 突变电池（复核 #15 BLOCKER："提交信息里那 8 枚突变的定义不在仓里，只有散文" ⇒ 证据不可复现）。
 *
 * 跑法：  node scripts/mutation-battery.mjs            # 全部跑一遍，打印每枚红了哪几格
 *        node scripts/mutation-battery.mjs m9 m10     # 只跑指定的
 * 退出码：0 = 每枚都至少抓到一格；1 = 有惰性突变（改了行为却没人喊疼）；2 = 锚不唯一 / 还原不一致。
 *
 * 规矩（都是付过学费的）：
 *  · 只在**全绿基线**上跑（否则"突变前后都红"是零信息，见 v3.55 自曝）；
 *  · 每枚改的是**行为**不是签名；优先"退回缺陷原样"，不是"把我新加的保护拆掉一半"
 *    （v3.56 那枚只拆写入侧的归一，实测惰性 ⇒ 真实路径上根本不可达）；
 *  · 数证人按**失效方式**数：多枚红同一格 = 1 个证人，不许按枚数报成"N 个证人"。
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { isCliEntry } from './lib/acceptance-selfcheck.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(ROOT, 'scripts/lib/acceptance-selfcheck.mjs');
const JUDGE = join(ROOT, 'scripts/acceptance-selfcheck.test.ts');

/** 每枚：一句话说明它复现的是哪个缺陷（缺陷原样，不是我的改写）。 */
export const MUTATIONS = {
  m1: { why: '守恒校验永远返回空（成对误差那一层被摘掉）',
    from: '  return { residue, overDeleted, unattributed, instrumentSuspect, disposition };', to: '  return { residue: [], overDeleted: [], unattributed: [], instrumentSuspect: [], disposition: [] };' },
  m2: { why: '时间窗不进查询 ⇒ 把全部历史行算成本次造的', from: 'await delegate.count({ where: { createdAt: { gte: bound } } })', to: 'await delegate.count({ where: {} })' },
  m3: { why: '读不到却塌成"造了 0 行"（不可归因被读成干净）',
    from: '      blind.push(modelDef.name);\n      byType[kind ? \'取数失败\' : \'无createdAt\'] += 1;\n      continue;',
    to: '      counts[modelDef.name] = 0;\n      continue;' },
  m4: { why: '归因分母边界 >0 写成 >=0（枚举 0 个也算有分母）', from: 'if (attrClaimed && !(attrNum > 0 && Number.isFinite(attrNum))) {', to: 'if (attrClaimed && !(attrNum >= 0)) {' },
  m5: { why: '删除侧命名不归一 ⇒ 级联那一路的小写键被指控"删了没造过的行"', from: 'const d = byCanon(deletedByModel);', to: 'const d = deletedByModel || {};' },
  m6: { why: '同名两笔覆盖而不是相加 ⇒ 多删的行从缝里溜走（byCanon 那一处）',
    from: '\n    out[c] = (out[c] ?? 0) + (Number(v) || 0);', to: '\n    out[c] = Number(v) || 0;' },
  m7: { why: '不可归因明细不点名 ⇒ 读数没法据此做任何事',
    from: "${attrBlind.slice(0, 8).join(', ')}${attrBlind.length > 8 ? ' …' : ''}", to: "${attrBlind.length}" },
  m8: { why: '三侧都不归一命名（退回 v3.56 修复前的原样）',
    from: '  const w = byCanon(createdInWindowAtWrite);\n  const c = byCanon(createdInWindowAtClean);\n  const d = byCanon(deletedByModel);',
    to: '  const w = createdInWindowAtWrite || {};\n  const c = createdInWindowAtClean || {};\n  const d = deletedByModel || {};' },
  m9: { why: '去掉"只指控被问过的表"这条覆盖判据 ⇒ 复核 #15 BLOCKER-1 的伪指控复活',
    from: "    if (deleted > 0 && !asked.has(m)) {\n      unattributed.push({ model: m, deleted });\n      bucket = 'unasked';",
    to: "    if (false) {\n      unattributed.push({ model: m, deleted });\n      bucket = 'unasked';" },
  m10: { why: 'createdAt 类型谓词退回只认 DateTime ⇒ 复核 #15 那条"133 张被白说成不可归因"复活',
    from: "const kind = cf && (cf.type === 'DateTime' || cf.type === 'BigInt') ? cf.type : null;",
    to: "const kind = cf && cf.type === 'DateTime' ? cf.type : null;" },
  m11: { why: '归因盲区明细只在"行数分母没坏"时才报 ⇒ 复核 #15 BLOCKER-2（已知信息被排序吃掉）复活',
    // ★ v3.64：锚随合并分支的条件扩了 pk 两条一起改（不改这里就是电池 exit 2 报的那个"锚不唯一"）
    from: 'if (attrBlind.length > 0 || unattrDel.length > 0 || instrSus.length > 0 || pkVan.length > 0 || pkSkip.length > 0 || pkNoDenom || delUnk.length > 0 || delUnrec.length > 0 || axisBad) {', to: 'if (attrBlind.length > 0 && blind.length === 0) {' },
  m12: { why: '"核不了"把已看到的脏 launder 掉（守恒失败不再进明细）⇒ v3.59 那条要求复活',
    from: 'if (overDel.length > 0) {\n      parts.push(`★ 同时已看到守恒失败', to: 'if (false) {\n      parts.push(`★ 同时已看到守恒失败' },
  m13: { why: '多通道删除数按覆盖合并 ⇒ 真实删除被读少，多删从缝里溜走',
    from: '      out[c] = (out[c] ?? 0) + (Number(v) || 0);\n    }\n  }\n  return out;\n}\nexport function conservationCheck',
    to: '      out[c] = (Number(v) || 0);\n    }\n  }\n  return out;\n}\nexport function conservationCheck' },
  m14: { why: '去掉"我明知造过行"的正对照 ⇒ 第四程那 24 处伪指控复活（量具坏了却指控删除面）',
    from: "      if (ownDeleted === 0 && knows.has(m)) {\n        instrumentSuspect.push({ model: m, deleted });\n        bucket = 'suspect';",
    to: "      if (false) {\n        instrumentSuspect.push({ model: m, deleted });\n        bucket = 'suspect';" },
  // ★ v3.63（复核 #15 I-1）：覆盖行的两处断线，**失效方式不同**（一处是"算了没上屏"，一处是"根本没算"）
  m15: { why: '判决照发、覆盖行不上屏 ⇒ "守恒失败 0"重新变成无人证的缺席反推',
    from: '(v.ok ? out.pass : out.fail)(v.label, `${v.detail} · ${coverageLine(r)}`);',
    to: '(v.ok ? out.pass : out.fail)(v.label, v.detail);' },
  m16: { why: 'conservationCheck 不逐表记落点 ⇒ "通过"与"没被问过"在输出里同值',
    from: '    disposition.push({ model: m, bucket, deleted, created, alive });',
    to: '    void bucket;' },
  // ★ v3.64（B170）：主键集合那一层的三枚。失效方式各不相同（少算新增 / 分母口径漂 / 把消失读成指控）
  m17: { why: 'pkDiff 不再报"本次新增且仍活着"⇒ 没有 createdAt 的那一族重新回到"没被问过"',
    from: '    if (added.length) created.push({ model: m, n: added.length, ids: added.slice(0, maxIds) });',
    to: '    void added;' },
  m18: { why: '分母从"无可用 createdAt 全集"漂成"所有模型"（含带 createdAt 的两张）⇒ 覆盖口径不再可复算',
    from: "    const cf = (m.fields || []).find((f) => f.name === 'createdAt');\n    return !(cf && (cf.type === 'DateTime' || cf.type === 'BigInt'));",
    to: '    return true;' },
  m19: { why: '把"基线行消失"从明细里静默吃掉 ⇒ 判决仍 unproven，但读者再也看不见这条已知信息（v3.56 同族）',
    from: '    if (pkVan.length > 0) {',
    to: '    if (false) {' },
  // ★ v3.65（B174）：这一层**自己的**分母，三枚失效方式互不相同（判决侧放行 / 口径虚高 / 不上屏）
  m20: { why: '没有分母也照样读成"已归因"⇒ 第七程那三条 0 读数重新能冒充 clean',
    from: '  const pkNoDenom = pkClaimed',
    to: '  const pkNoDenom = false && pkClaimed' },
  m21: { why: '分母拿并集（含只有一侧、根本没比的表）⇒ 分母宽于证据面',
    from: '  return { created, vanished, skipped, compared };',
    to: '  return { created, vanished, skipped, compared: models.size };' },
  m22: { why: '分母算出来了但不上屏 ⇒ "已比对几张"重新只剩缺席反推',
    from: '  return `${counts} · ${pkDenom} · ${landing}`;',
    to: '  return `${counts} · ${landing}`;' },
  // ★ v3.66（复核 #16 实测的三条 + 我自己在 B174 里把前提写窄的那一条）
  m23: { why: '覆盖对账的等式被摘掉（退回 v3.65 那版"两个数都 >0 就算有分母"）⇒ 已比对 1 / 枚举 35 又能判 clean',
    from: '    || pkAccounted !== pkEnumNum',
    to: '    || false                 ' },
  m24: { why: '只有一条未覆盖就放过（复核 #16 的 x2：`pkSkip.length > 1`）⇒ 34/35 里那张没覆盖的表被读成全覆盖',
    from: '|| pkVan.length > 0 || pkSkip.length > 0 || pkNoDenom || delUnk.length > 0 || delUnrec.length > 0 || axisBad) {',
    to: '|| pkVan.length > 0 || pkSkip.length > 1 || pkNoDenom || delUnk.length > 0 || delUnrec.length > 0 || axisBad) {' },
  m25: { why: '覆盖行的计数格不再筛掉 count<=0 的条目（复核 #16 的 x11）⇒ 13 张零命中印成"标识命中=13"',
    from: "    return a.filter((x) => !(x && typeof x.count === 'number' && x.count <= 0)).length;",
    to: '    return a.length;' },
  m26: { why: '未覆盖清单只报条数不点名（复核 #16 的 x13）⇒ 读者无法核对到底是哪张表没覆盖',
    from: "        + pkSkip.slice(0, 6).map((x) => (x && typeof x === 'object' ? `${x.model}（${x.why}）` : String(x))).join(' / ')",
    to: "        + pkSkip.slice(0, 6).map(() => '（未点名）').join(' / ')" },
  m27: { why: '两侧 DMMF 枚举漂移不再算数 ⇒ 分母自己在动这一程却读成"整族比过了"',
    from: '    || (pkDriftNum ?? 0) > 0',
    to: '    || false               ' },
  // ★ v3.68（B181）：拆档被并回去 ⇒ "190 张核过"重新把 163 张恒成立混进来
  m28: { why: '守恒两档并回一档 ⇒ "删过且成立"与"一行都没删（恒成立）"又在读数里同值',
    from: "    let bucket = deleted > 0 ? 'passedDeleted' : 'passedIdle';",
    to: "    let bucket = 'passed';" },
  // ★ v3.70（B178）逐主键守恒的四枚：方向、放行、指控、分母声明
  m29: { why: 'createdAt 与起点的大小关系反了 ⇒ 跑前行被读成本次造的，真删多了也闭嘴',
    from: "        (cts < ts ? preexisting : nonPre).push({ model, id });",
    to: "        (cts > ts ? preexisting : nonPre).push({ model, id });" },
  m30: { why: '「判不了」塌成「清白」⇒ 量具失败被写成放行（B178 自己最防的那一格）',
    from: "      unknown.push({ model, id, why: '无 createdAt 也没有跑前主键快照 ⇒ 判不了' });",
    to: "      nonPre.push({ model, id });" },
  m31: { why: '「判不了」不再进合并分支 ⇒ 一句 clean 就把看不见的删除面放行',
    from: " || pkNoDenom || delUnk.length > 0 || delUnrec.length > 0 || axisBad) {",
    to: " || pkNoDenom || false) {" },
  m34: { why: '两通道对不上账那张格不进判决 ⇒ 键口径一错就"两头都是 0"（复核 #17 B-2 的形状）',
    from: " || pkNoDenom || delUnk.length > 0 || delUnrec.length > 0 || axisBad) {",
    to: " || pkNoDenom || delUnk.length > 0 || false) {" },
  m35: { why: '「对不上账」只算不用：合并分支不再为它出声 ⇒ 读数里看不见静默丢掉的表',
    from: "    if (delUnrec.length > 0) {",
    to: "    if (false) {" },
  m33: { why: '判不了按"条"报又不按删除侧行数折算 ⇒ 第十一程那个 3 冒充 412 的洞回来',
    from: "      const n = Number.isFinite(reportedCounts?.[model]) ? reportedCounts[model] : null;",
    to: "      const n = null;" },
  m32: { why: '逐行指控那一支摘掉 ⇒ 删了跑前行的事实退回去喂标量守恒（可被少数一行抵消）',
    from: "  if (delPre.length > 0) {\n    return { kind: 'residue', ok: false, label: RESIDUE_LABELS.residue,",
    to: "  if (false) {\n    return { kind: 'residue', ok: false, label: RESIDUE_LABELS.residue," },
  // ★ v3.77（B187）指控轴正对照的六枚：五枚是"这一维被摘掉/被写死"，一枚是**本批我自己踩到的过度拦截**
  m36: { why: '正对照这一维不进判决 ⇒ "删的跑前行=0"重新能冒充 clean（B187 要堵的就是这一格）',
    from: ' || axisBad) {', to: ' || false) {' },
  m37: { why: '正对照的 ok 硬写成 true ⇒ 哑轴也报"验过了"，整根尺变成自证的橡皮图章',
    from: '  return { ran: true, ok: reasons.length === 0,', to: '  return { ran: true, ok: true,' },
  m38: { why: '写入/读回这一路的前提摘掉 ⇒ 埋进去的时间已经不是我要的那个时间，却仍然只报"判据哑了"',
    from: "      } else if (p.role === 'past' && !(got < runStartMs)) {", to: '      } else if (false) {' },
  m39: { why: 'preId 通路只要求一个方向 ⇒ "跑前主键快照能响"这一向没人验（那 33 张没有 createdAt 的表重新全靠反推）',
    from: "  for (const role of ['past', 'notpast']) need.push(`preId|0|${role}`);",
    to: "  for (const role of ['past']) need.push(`preId|0|${role}`);" },
  m40: { why: '落进"判不了"这一支摘掉 ⇒ 分类通路整条没接上被读成"指控哑了"（两种失效方式混成一格）',
    from: '    if (unk.has(id)) {', to: '    if (false) {' },
  m41: { why: '★ 本批我自己写错的形状：正对照把**已响的指控**也降级成 unproven ⇒ 真指控被洗软',
    from: '  const axisBad = delLayerClaimed && !axisOk && delPre.length === 0;',
    to: '  const axisBad = delLayerClaimed && !axisOk;' },
  // ★ v3.77（B187 第二版）：改成回滚事务之后，"零持久写入"与"起点合理性带"这两条新增前提各补一枚
  m42: { why: '残留那一格摘掉 ⇒ 回滚没生效（埋的行真留在库里）也照样报"正对照通过"',
    from: '  if (!(Number.isFinite(leftover) && leftover === 0)) {',
    to: '  if (false) {' },
  m43: { why: '起点的合理性带摘掉 ⇒ runStart=0（1970）时窗口永远"跑前"，这根轴只剩一种答法却照样绿',
    from: '  if (startMs < Date.now() - 400 * DAY || startMs > Date.now() + 400 * DAY) {',
    to: '  if (false) {' },
  // ★ v3.79（复核 #20 处置）：五枚，各对应复核给的一条（其中 m44/m46 是"退回 v3.77 那一版"，不是凭空拆）
  m44: { why: '判决退回"只信 ok 这个自述字段" ⇒ {ok:true, leftover:5} 又能读成 clean（复核 MINOR-9 实跑复现过）',
    from: '  const axisOk = axBad.length === 0;',
    to: '  const axisOk = !!(ax && ax.ran === true && ax.ok === true);' },
  m45: { why: '库侧 DEFAULT 那一臂的偏差检查摘掉 ⇒ 会话时区/时钟偏差（整根轴平移 8h 的真实形状）看不见',
    from: "      } else if (p.role === 'defaulted') {", to: '      } else if (false) {' },
  m46: { why: '"这一层被声明了"退回两个具名键 ⇒ 只报 deletedUnknownRows 的调用方可以带着 0 读成干净（MINOR-8）',
    from: "Object.keys(r).some((k) => /^deleted(Preexisting|Unknown)/.test(k)) || r.axisControl !== undefined);",
    to: "Object.prototype.hasOwnProperty.call(r, 'deletedPreexisting') || r.axisControl !== undefined);" },
  m47: { why: '归因层早退分支不再提轴 ⇒ "提前 return 吃掉无关自我暴露"那一族复活（MINOR-11）',
    from: '        + (delLayerClaimed && !axisOk', to: "        + (false && !axisOk" },
  m48: { why: '普查尺丢掉"取子串"那种守卫的形状 ⇒ 方向相反、更坏的一族结构性隐身（MAJOR-3）',
    from: '    if (line.includes(B) || SUB.some((s) => line.includes(s))) hits.push(i + 1);',
    to: '    if (line.includes(B)) hits.push(i + 1);' },
  m49: { why: '网格只扫一侧就报另一侧 ⇒ "两侧不对称"这句重新变成散文（复核 #20 MINOR-7 的病，只是换了个位置复发）',
    from: '  const neg = findEdge(-1);', to: '  const neg = null;' },
  m50: { why: '扫到边界也不认（`return s` 改 `return null`）⇒ 覆盖行的"变晚侧 +1s 即响"退化成"≤Ns 哑"，读起来像更保守其实是不知道',
    from: '    for (let s = 1; s <= limit; s += 1) if (!probe(sign * s).ok) return s;',
    to: '    for (let s = 1; s <= limit; s += 1) if (!probe(sign * s).ok) return null;' },
  m51: { why: '网格缺失时不再承认"未量"，而是继续往下算 ⇒ 没跑过的东西也能产出一句看起来像结论的话',
    from: '  if (!grid || grid.ok !== true) {', to: '  if (false) {' },
  // ↓★★★★ v3.80（复核 #21 MA-3）：这一组打的是"**重算**到底存不存在"。
  //   复核给的事实是：v3.79 那版"不许只信 ok"只做字段级非零自检 ⇒ 六种坏 axisControl 全判 clean。
  m52: { why: '证据前置摘掉 ⇒ 又回到"只交一组汇总字段就能算过了"（MA-3 的原病）',
    from: "    if (!ev || typeof ev !== 'object' || !Array.isArray(ev.pairs) || !ev.attribution || typeof ev.attribution !== 'object') {",
    to: "    if (false && (!ev || typeof ev !== 'object' || !Array.isArray(ev.pairs) || !ev.attribution || typeof ev.attribution !== 'object')) {" },
  m53: { why: '网格不进判决 ⇒ "分辨率边界没量过"这件事不再挡 clean（v3.80 新加的那一项被摘）',
    from: '    if (!ax.grid || ax.grid.ok !== true) {', to: '    if (false) {' },
  m54: { why: '到达回滚点不查 ⇒ 没走到回滚（可能真留了行）也能算齐',
    from: '    if (ax.rolledBack !== true) axBad.push', to: '    if (false) axBad.push' },
  m55: { why: '写入行数≠计划落点数不查 ⇒ 有一臂静默缺席时正对照自欺',
    from: '    if (ax.createdRows !== ax.planted) {', to: '    if (false) {' },
  m56: { why: '重算的 ok 对撞摘掉 ⇒ "重算"退化成摆设，自述 false/true 随便填',
    from: '      if (rc.ok !== ax.ok) axBad.push', to: '      if (false) axBad.push' },
  m57: { why: '逐项计数对撞清空 ⇒ planted 谎报 99 也能过（复核给的正是这一种）',
    from: "      for (const k of ['planted', 'preexistingMine', 'nonPreMine', 'unknownMine', 'leftover']) {",
    to: "      for (const k of []) {" },
  // ★ v3.81（复核 #22 处置）：这一组买的都是**本批新写的行为**，不是"把保护拆一半"——
  //   m58 直接退回 B200 缺陷原样（拿 runStart 当时钟锚），m59~m62 是那条判据的两个分支与两个新量，
  //   m63~m65 是"派生字段留自报通道"那三处，m66 是网格退化档那两种措辞，m67 是异常丢码。
  m58: { why: '区间外距离只在缺锚点时才算 ⇒ 带锚点时这把尺**永不响**（这是『把保护摘掉』那一种，不是缺陷原样——原样见 m72）',
    from: 'const outside = a0 === null ? null : (got < a0 ? a0 - got : (got > a1 ? got - a1 : 0));',
    to: 'const outside = a0 === null ? Math.abs(got - runStartMs) : null;' },
  m59: { why: '缺锚点那一支被吞 ⇒ 没有区间时也悄悄按 runStart 判，B200 的错换个入口复活',
    from: '        if (a0 === null) {\n          // 缺锚点不许悄悄退回 runStart 判',
    to: '        if (false) {\n          // 缺锚点不许悄悄退回 runStart 判' },
  m60: { why: '退化档位（最小档 1s）又打成"≤−0s哑" ⇒ 读数看着像尺坏了（复核 #22 MINOR-6）',
    from: "if (s === 0) return '变早侧 0s 以内哑（＝1s 就响，这一侧没有哑区）';",
    to: 'if (s === 0) return `变早侧≤−${s}s哑`;' },
  m61: { why: '"扫到上限仍未越界"被写成"≤−nulls哑" ⇒ 把没扫到边界说成尺没接上（同族第二种坏法）',
    from: 'if (s === null || s === undefined) return `变早侧扫到 ${g.scannedSec}s 仍未越界`;',
    to: 'if (s === null || s === undefined) return `变早侧≤−${s}s哑`;' },
  m62: { why: '时钟偏差这一维不重算 ⇒ 自述 28800000ms 也能过（复核 #22 BL-1 的六种形状之一）',
    from: '      if (ax.defaultedClockDevMs !== dClock) {', to: '      if (false) {' },
  m63: { why: '区间宽这一维不重算 ⇒ 耗时与偏差又可以混着报（B200 的另一半；这一维 v3.81~v3.83 被误命名成"演练耗时"）',
    from: '      if (ax.defaultedElapsedMs !== dElapsed) {', to: '      if (false) {' },
  m64: { why: '网格只核 ok 一维 ⇒ {grid:{ok:true}} 空壳与"边界全是 null"重新过关（复核实测过的那种）',
    from: "        for (const k of ['ok', 'minTierSec', 'scannedSec', 'caughtAtOrAfterNegSec', 'silentNegSec', 'caughtAtOrAfterPosSec', 'zeroOk']) {",
    to: "        for (const k of ['ok']) {" },
  m65: { why: 'marker 命名律摘掉 ⇒ 拿别人的行充当本程证据不再有对撞（抬高编造成本那一刀被抹）',
    from: '      if (marker.length < 4) axBad.push(', to: '      if (false) axBad.push(' },
  m66: { why: 'resolutionSec 不重算 ⇒ 自述一个更大的数就自称更准（派生字段留自报通道）',
    from: '      if (ax.resolutionSec !== rc.resolutionSec) {', to: '      if (false) {' },
  m67: { why: '异常丢码 ⇒ "哪一种坏"又只能靠我去翻 pg 日志（B199 那次的归因方式）',
    from: "  for (const k of ['code']) if (e && typeof e[k] === 'string') codes.push(e[k]);",
    to: "  for (const k of []) if (e && typeof e[k] === 'string') codes.push(e[k]);" },
  // ★ v3.82（复核 #23 M1/M2/m3）：这一组买的是**驱动侧那一半**——v3.81 只给判据配了证人，
  //   "锚点是谁采的、从哪儿采的"一格没验（复核实测三枚突变 0 新增红格）。m70 正是他们点出的
  //   "对撞对象换成自己"：anchorMs 取库的回读 ⇒ defaultedClockDevMs 恒为 0。
  m68: { why: '驱动不采区间下界 ⇒ 判决只能退回拿 runStart 凑（B200 那个错从源头复活）',
    from: '    dAnchor.ms = Date.now();', to: '    dAnchor.ms = null;' },
  m69: { why: '驱动不采区间上界 ⇒ 耗时这一维变 null、区间退化成点（复核给的形状之一）',
    from: "        if (p.role === 'defaulted') dAnchor.notAfterMs = Date.now();", to: '        if (false) { }' },
  m70: { why: '★ 锚点取自**库的回读**而不是本机钟 ⇒ 偏差恒等于 0，这把尺永远说"时钟一致"（对撞对象换成自己）',
    from: "      ...(p.role === 'defaulted' ? { anchorMs: dAnchor.ms, anchorNotAfterMs: dAnchor.notAfterMs } : {}) };",
    to: "      ...(p.role === 'defaulted' ? { anchorMs: (v instanceof Date ? v.getTime() : dAnchor.ms), anchorNotAfterMs: dAnchor.notAfterMs } : {}) };" },
  m71: { why: 'defaulted 那一臂排回最后 ⇒ 区间宽＝前面 6 次插入，可检下界随演练长度膨胀（复核 #23 M2）',
    from: "  plan.push({ id: `${marker}_D_${rnd}`, path: 'createdAt', role: 'defaulted', sec: 0, createdAt: undefined });\n  for (const sec of offsetsSec) {\n    plan.push({ id: `${marker}_C_P${sec}_${rnd}`, path: 'createdAt', role: 'past', sec, createdAt: new Date(runStartMs - sec * 1000) });\n    plan.push({ id: `${marker}_C_N${sec}_${rnd}`, path: 'createdAt', role: 'notpast', sec, createdAt: new Date(runStartMs + sec * 1000) });\n  }\n  plan.push({ id: `${marker}_I_P_${rnd}`, path: 'preId', role: 'past', sec: 0, createdAt: new Date(runStartMs) });\n  plan.push({ id: `${marker}_I_N_${rnd}`, path: 'preId', role: 'notpast', sec: 0, createdAt: new Date(runStartMs) });", to: "  for (const sec of offsetsSec) {\n    plan.push({ id: `${marker}_C_P${sec}_${rnd}`, path: 'createdAt', role: 'past', sec, createdAt: new Date(runStartMs - sec * 1000) });\n    plan.push({ id: `${marker}_C_N${sec}_${rnd}`, path: 'createdAt', role: 'notpast', sec, createdAt: new Date(runStartMs + sec * 1000) });\n  }\n  plan.push({ id: `${marker}_I_P_${rnd}`, path: 'preId', role: 'past', sec: 0, createdAt: new Date(runStartMs) });\n  plan.push({ id: `${marker}_I_N_${rnd}`, path: 'preId', role: 'notpast', sec: 0, createdAt: new Date(runStartMs) });\n  plan.push({ id: `${marker}_D_${rnd}`, path: 'createdAt', role: 'defaulted', sec: 0, createdAt: undefined });" },
  m72: { why: '★ B200 的**缺陷原样**（v3.80 那一版）：区间外距离改成"对 runStart 取绝对差" ⇒ 演练一慢就伪报整轴平移',
    from: 'const outside = a0 === null ? null : (got < a0 ? a0 - got : (got > a1 ? got - a1 : 0));',
    to: 'const outside = Math.abs(got - runStartMs);' },
  m73: { why: '"实际可检下界 = 容差 + 区间宽"那句不上屏 ⇒ 读数又可以只报 ±最小档那个乐观口径（M2 的另一半）',
    from: '    + effBandTxt', to: "    + ''" },
  // ★ v3.83（B204）：第十七程真跑打印过一句**加起来不等**的拆解（54634 = 0 + 1）。
  //   这一组买的正是"三个数各自报得出、合起来不是拆解"这一族——m74 是对撞本身，m75/m76 是驱动不交新量，
  //   m77 是两处单项重算被摘，m78 是打印侧那道自洽守卫被摘。
  m74: { why: '恒等式的对撞对象换成**重算值**（那三个同源 ⇒ 由构造必相等）⇒ 这条判据变恒真，谁都不红',
    from: '      if (selfTriple.every((x) => Number.isFinite(x)) && ax.defaultedDevMs !== ax.defaultedLeadMs + ax.defaultedInTxMs) {',
    to: '      if (dDev !== null && dLead !== null && dInTx !== null && dDev !== dLead + dInTx) {' },
  m75: { why: '恒等式那一支整体摘掉 ⇒ 报出的三个数互相不是拆解关系也没人喊（同上，换一种摘法）',
    from: '      if (selfTriple.every((x) => Number.isFinite(x)) && ax.defaultedDevMs !== ax.defaultedLeadMs + ax.defaultedInTxMs) {',
    to: '      if (false) {' },
  m76: { why: '驱动不交"起跑耗时"⇒ 那个真正解释间距的量又没有字段了（B204 的根因形状）',
    from: '    defaultedLeadMs,', to: '    defaultedLeadMs: null,' },
  m77: { why: '驱动不交"事务内偏移"⇒ 恒等式两边凑不齐，拆解句又回到只能看区间宽',
    from: '    defaultedInTxMs,', to: '    defaultedInTxMs: null,' },
  m78: { why: '起跑耗时不重算 ⇒ 自报一小时也照样过（自报通道留在没查的那一维上）',
    from: '      if (ax.defaultedLeadMs !== dLead) {', to: '      if (false) {' },
  // ★ v3.85（复核 #24 M-1）：自洽守卫从"只住在 caveat 那一处"搬进了**共用的** `decompositionPhrase`，
  //   所以下面三枚各买一个不同的洞：m79 = 连接符（等号 vs ⇒）被写死；m80 = 那份拒绝整体被摘；
  //   m81 = 覆盖行不走共用那份（M-1 报的原样缺陷：守卫只盖住三处打印点里的一处）。
  m79: { why: '打印侧"只在真相加等于时才用等号"那一步被写死 ⇒ 数不自洽仍打出一句像等式的拆解（第十七程的形状）',
    from: "        + (lead !== null && inTx !== null && dev === lead + inTx ? '= ' : '⇒ ')",
    to: "        + '= '" },
  m80: { why: '共用那份 decompositionPhrase 的拒绝整体被摘 ⇒ 三处打印点同时开始说假话（守卫本身被摘）',
    from: '  if (lead + inTx !== dev) {', to: '  if (false) {' },
  m81: { why: '★ M-1 原样：覆盖行不用共用句手、自己拼一个恒等式 ⇒ 判决/CLI 有守卫而覆盖行照样说谎',
    from: "          + `拆开=` + decompositionPhrase({ devMs: ax.defaultedDevMs, leadMs: ax.defaultedLeadMs, inTxMs: ax.defaultedInTxMs })",
    to: "          + `拆开=` + `起跑耗时 ${ax.defaultedLeadMs}ms + 事务内偏移 ${ax.defaultedInTx}ms`" },
};

const runJudge = (jsonOut) => {
  try { execFileSync('npx', ['vitest', 'run', JUDGE, '--reporter=json', `--outputFile=${jsonOut}`], { cwd: ROOT, stdio: 'ignore' }); } catch { /* 红是预期的 */ }
  const r = JSON.parse(readFileSync(jsonOut, 'utf8'));
  const cells = [];
  let passed = 0;
  for (const f of r.testResults || []) {
    for (const a of f.assertionResults || []) {
      if (a.status === 'passed') passed += 1;
      else if (a.status === 'failed') cells.push(`${f.name.replace(`${ROOT}/`, '')} :: ${a.title}`);
    }
  }
  return { passed, cells };
};

/** 只有**直接执行**时才跑电池；被 import（例如判据要读 MUTATIONS 清单）时只导出、不产生任何副作用。
 *  ★ v3.77（复核 #19 BLOCKER-1 同族）：比较换成共用的 `isCliEntry`（realpath 两侧），
 *  否则经过符号链接的调用会让**整块电池静默不跑并退 0** ＝ "35 枚全咬"那种句子背后的假绿。 */
const RUNNER = isCliEntry(import.meta.url);
if (!RUNNER) {
  // 被当模块用：到此为止（跑电池的副作用全部关在 main() 里）
} else {
const want = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const ids = want.length ? want : Object.keys(MUTATIONS);
const base = runJudge('/tmp/battery-baseline.json');
console.log(`基线：通过=${base.passed} 失败=${base.cells.length}`);
if (base.cells.length !== 0) { console.log('!! 基线不绿 ⇒ 突变读数无意义，停'); for (const c of base.cells.slice(0, 5)) console.log('   ' + c); process.exit(2); }
const backup = '/tmp/battery-lib.bak';
copyFileSync(LIB, backup);
const sha0 = execFileSync('shasum', ['-a', '1', LIB]).toString().split(' ')[0];
const seenCells = new Set();
let inert = 0;
for (const id of ids) {
  const m = MUTATIONS[id];
  if (!m) { console.log(`?? 没有这枚突变 ${id}`); inert += 1; continue; }
  const t = readFileSync(LIB, 'utf8');
  const hits = t.split(m.from).length - 1;
  if (hits !== 1) { console.log(`!! ${id} 锚命中 ${hits} 次（要恰好 1）⇒ 电池本身坏了，停`); copyFileSync(backup, LIB); process.exit(2); }
  writeFileSync(LIB, t.replace(m.from, m.to));
  const { cells } = runJudge('/tmp/battery-mut.json');
  console.log(`${id} 红格=${cells.length}  ${cells.map((c) => c.split(' :: ')[1] || c).join(' | ').slice(0, 150)}`);
  if (!cells.length) { inert += 1; console.log(`   ^^ 惰性突变：${m.why}`); }
  cells.forEach((c) => seenCells.add(c));
  copyFileSync(backup, LIB);
  const sha = execFileSync('shasum', ['-a', '1', LIB]).toString().split(' ')[0];
  if (sha !== sha0) { console.log(`!! ${id} 还原后 shasum 不一致 ⇒ 停`); process.exit(2); }
}
const again = runJudge('/tmp/battery-final.json');
console.log(`\n小结：跑了 ${ids.length} 枚 → 惰性 ${inert} 枚 → 红过的不同格子 ${seenCells.size} 个；复跑基线 通过=${again.passed} 失败=${again.cells.length}`);
console.log(`（按失效方式数证人：${seenCells.size} 个不同格子 ≠ ${ids.length} 枚突变）`);
process.exit(inert === 0 && again.cells.length === 0 ? 0 : 1);

}
