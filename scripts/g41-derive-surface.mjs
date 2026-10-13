import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SURFACE_MEASUREMENT_VERSION as MEASUREMENT_VERSION, enumerateWriteRoutes, summarize, reconcileSiteLists, siteSignature, siteKey as key, surfaceLists, signatureLists, surfaceSetDigest, surfaceSourceEvidence, validateMeasurementCorrection } from './lib/writeRouteSurface.mjs';
/**
 * ★ B85 同族：这一份原先写死绝对路径，且指向的是**本工作树**（bambook-s0a）。
 *   看着"今天没问题"，其实方向更坏 —— 守卫（`g41-write-surface.test.ts`）量的是自己所在的树，
 *   写手量的是另一棵 ⇒ 在主目录里跑一次 `--write`，就会拿 main 的源码普查结果**覆盖 s0a 的基线**。
 *   路径改成从 `import.meta.url` 派生，写手与守卫从此同树是**结构保证**，不是巧合。
 */
const R = join(dirname(fileURLToPath(import.meta.url)), '..');
const BF = join(R, 'scripts/baselines/g41-write-surface.json');
const j = JSON.parse(fs.readFileSync(BF, 'utf8'));
const initialEvidence = surfaceSourceEvidence(R);
const r = enumerateWriteRoutes(R);
const s = summarize(r.routes);
const noEv = r.routes.filter((x) => !x.permissionCoveredAllLayers && !x.authnCoveredAllLayers).map(key).sort();
const authn = r.routes.filter((x) => !x.permissionCoveredAllLayers && x.authnCoveredAllLayers).map(key).sort();
const unbounded = r.routes.filter((x) => !x.bodyBounded).map(key).sort();
/** ★ B88 的"配置档"：权限证据全部来自 `if (!requireAuth) return true` 型门的路由 */
const cfgDep = r.routes.filter((x) => x.permEvidenceAllBooleanGated);
/** ★ "写面只挂已知 :read scope"的路由：有门，但那道门判的是读权限 ⇒ 不许并进"拦住了写" */
const readOnly = r.routes.filter((x) => x.permEvidenceReadOnly);

if (process.argv.includes('--write')) {
  /**
   * ★★ v3.12：重冻结前必须先做**签名层对账**（治"守卫红了就盲 `--write`"）
   *   基线以 `file:line` 为键 ⇒ 一次无关的上方编辑就能造出 9 条假红（本批实测：
   *   B129 只改了 claimRoute 的 catch，8 条 naked + 1 条 authnOnly 全搬家、集合一条没变）。
   *   假红本身可以接受，**不可接受的是修法**：直接 `--write` 会把"真新增了一条裸写路由"
   *   与"行号搬家"混成同一个动作。这里把两者分开：签名变了 ⇒ 不落盘，除非显式给 `--allow-set-change`。
   */
  const beforeEvidence = initialEvidence;
  if(surfaceSourceEvidence(R).sha256!==beforeEvidence.sha256) {console.error('扫描期间源码变化，中止写盘。');process.exit(1);}
  const sourceCommit = execFileSync('git',['rev-parse','HEAD'],{cwd:R,encoding:'utf8'}).trim();
  const correctionArg = process.argv.find(a=>a.startsWith('--measurement-correction='));
  const correction = correctionArg ? JSON.parse(fs.readFileSync(correctionArg.slice('--measurement-correction='.length),'utf8')) : null;
  const nowLists = {
    nakedWriteRoutes: r.routes.filter((x) => x.shape === 'naked' && !x.routerLevelGuard).map(key),
    noEvidenceRoutes: noEv,
    authnOnlyRoutes: authn,
    bodyUnbounded: unbounded,
    configDependentRoutes: cfgDep.map(key),
    readOnlyScopeRoutes: readOnly.map(key),
    namedHandlerRoutes: r.routes.filter((x) => x.shape === 'named-handler').map(key),
  };
  const baseLists = {};
  for (const k of Object.keys(nowLists)) baseLists[k] = j[k] ?? [];
  const drift = reconcileSiteLists(baseLists, nowLists);
  const changed = Object.keys(drift);
  const allowArg = process.argv.find((a) => a.startsWith('--allow-set-change'));
  const reason = allowArg ? allowArg.slice(allowArg.indexOf('=') + 1).trim() : '';
  if (correction) {
    const failures = validateMeasurementCorrection(correction, r, beforeEvidence);
    if (failures.length) {
      console.error('测量修正缺少准确同源码 old/new 证据，中止写盘。', failures); process.exit(1);
    }
  }
  if (!correction && j.measurementVersion !== MEASUREMENT_VERSION) {
    console.error('测量版本改变且无同源码 old/new 比较，拒绝把口径变化冒充产品修复。'); process.exit(1);
  }
  if (allowArg && !reason) {
    console.error('★ `--allow-set-change` 现在必须带一句理由：`--allow-set-change="为什么放行这次集合变化"`。');
    console.error('   理由会连同"新增/消失了哪些签名"一起写进基线的 `_setChangeLog` ⇒ 放行这件事本身要留下可审的痕迹。');
    process.exit(1);
  }
  if (changed.length && !allowArg) {
    console.error('★ 签名层（file, method, pathKey）发生了变化 ⇒ 这不是"行号搬家"，是集合真的变了。中止写盘：');
    for (const name of changed) console.error(`   ${name}: 新增 ${JSON.stringify(drift[name].added)} 消失 ${JSON.stringify(drift[name].removed)}`);
    console.error('   确认这是你要登记的变化，再补 `--allow-set-change="一句话理由"` 重跑。');
    process.exit(1);
  }
  const totalEntries = Object.keys(nowLists).reduce((acc, k) => acc + nowLists[k].length, 0);
  console.log(changed.length
    ? `⚠️ 签名层变化已放行（理由：${reason}）：${JSON.stringify(drift)}`
    : `签名层对账通过（7 份清单共 ${totalEntries} 条目，只有行号搬家）⇒ 允许自动重冻结`);
  // ★ 数字一律由本次测量填入：手写进说明文本的数就是"第二处真源"（本仓 B79/B82 的同族病）
  j._说明 = 'G4.1 派生面基线。守卫要求：naked / noEvidence / authnOnly 三个集合与本文件**逐条相等**（新增⇒红；修好了⇒同批来删条目）；unknown/unparsed/authnOnly/noEvidence 只许下降。再生成：node scripts/g41-derive-surface.mjs --write';
  j._口径 =
    `★ 三套口径同时冻结，**禁止互相加减**：` +
    `nakedNoRouterGuard=${s.nakedNoRouterGuard} 是 v2.56 的"只看参数表与 router.use"口径（保留是为了让"尺补面之后少报了多少"这件事本身可证伪）；` +
    `permissionCovered=${s.permissionCovered} / authnOnlyNoAuthz=${s.authnOnlyNoAuthz} / noEvidenceAtAll=${s.noEvidenceAtAll} 是 v2.57 补了"handler 体内的门 + 挂载点注入"之后的口径。` +
    `三桶之和 = total = ${s.total}。` +
    `★ v2.60 起 permissionCovered 再拆两档，引用时必须一起给：` +
    `① 配置档 ${s.permissionCoveredButConfigDependent} 条 —— 权限证据**全部**来自 \`if (!requireAuth) return true;\` 型门` +
    `（requireAuth = BAMBOOK_REQUIRE_AUTH/NODE_ENV 推出来的布尔）⇒ 本地姿态下这条链整体放行；` +
    `② 读档档 ${s.permissionCoveredReadOnlyScope} 条 —— 写面只挂已知 \`:read\` scope 的门（有门，但那道门不判写权限）。` +
    `同理 authnOnlyNoAuthz=${s.authnOnlyNoAuthz} 里有 ${s.authnOnlyButConfigDependent} 条连身份功都是配置依赖的（挂载层 sdkAuth 第一行短路）。` +
    `★ 门的**落点**有四种（参数表 / 文件级 router.use / handler 体内 / 挂载点注入），v2.56 只认前两种 ⇒ 那一批"没门"的读数是尺的口径而非仓的实情。`;
  j._生产姿态 = { note: 'BAMBOOK_REQUIRE_AUTH=true 或 NODE_ENV=production 时（本地开发默认不是这个姿态）', permissionCovered: s.permissionCovered, configDependentSubset: s.permissionCoveredButConfigDependent, authnOnlyNoAuthz: s.authnOnlyNoAuthz, noEvidenceAtAll: s.noEvidenceAtAll };
  j._本地姿态 = { note: '两个环境变量都不开（本地开发默认）：只传布尔的那些文件里的门**第一行就放行**', permissionCoveredStrong: s.permissionCoveredStrong, configDependent: s.permissionCoveredButConfigDependent };
  Object.assign(j.totals, {
    // ★ v2.61（复核 A2 的 BLOCK）：这几个字段原先是**手冻结的旧值**，写手从不刷新、守卫也从不对账
    //   ⇒ 基线里长期躺着 655/563/608/14 这种"曾经真过"的数，而尺已经报 657/578/610/1。
    //   现在：全部由本次测量刷新，且守卫新增一条"基线 totals 必须与实测逐字段相等"的对账。
    routeFiles: r.files,
    total: s.total,
    guarded: s.guarded,
    nakedNoRouterGuard: s.nakedNoRouterGuard,
    namedHandlerUntouched: s.namedHandlerUntouched,
    unparsed: r.unparsed.length,
    denominatorIsMeaningful: s.denominatorIsMeaningful,
    permissionCovered: s.permissionCovered,
    permissionCoveredStrong: s.permissionCoveredStrong,
    permissionCoveredButConfigDependent: s.permissionCoveredButConfigDependent,
    permissionCoveredReadOnlyScope: s.permissionCoveredReadOnlyScope,
    authnOnlyNoAuthz: s.authnOnlyNoAuthz,
    authnOnlyButConfigDependent: s.authnOnlyButConfigDependent,
    noEvidenceAtAll: s.noEvidenceAtAll,
    notMountedAtAll: s.notMountedAtAll,
    mountUnattributedAtAll: s.mountUnattributedAtAll,
    mountFilesResolved: Object.keys(r.mounts.byFile).length,
    unknownEntries: r.unknown.length,
    unknownShapes: new Set(r.unknown.map((u) => u.ident)).size,
    mountFactoriesResolved: Object.keys(r.mounts.byFactory).length,
    mountBooleanFlagOnlyFiles: r.mounts.booleanFlagOnlyFiles.length,
  });
  // Re-freezing measurement never expands a failure cap. New registrations
  // remain visible/red until their actual source/triage is fixed separately.
  const lowerRatchet = (name, measured) => Number.isSafeInteger(j.ratchet[name]) ? Math.min(j.ratchet[name], measured) : measured;
  Object.assign(j.ratchet, {
    // ★ 棘轮随重冻结一起落到本次测量值（原先 `unknownMax` 一直停在 12 这个旧上界 ⇒ "只许下降"对它成了空话）
    unknownMax: lowerRatchet('unknownMax', new Set(r.unknown.map((u) => u.ident)).size),
    authnOnlyMax: lowerRatchet('authnOnlyMax', s.authnOnlyNoAuthz),
    noEvidenceMax: lowerRatchet('noEvidenceMax', s.noEvidenceAtAll),
    bodyUnboundedMax: lowerRatchet('bodyUnboundedMax', unbounded.length),
    configDependentMax: lowerRatchet('configDependentMax', s.permissionCoveredButConfigDependent),
    readOnlyScopeMax: lowerRatchet('readOnlyScopeMax', s.permissionCoveredReadOnlyScope),
    // ★ v2.61（复核 M-1）：`namedHandlerMax` 原先不在这里 ⇒ 头条数 14→1 之后棘轮还停在 14，"只许下降"对它成了空话
    namedHandlerMax: lowerRatchet('namedHandlerMax', s.namedHandlerUntouched),
    unparsedMax: lowerRatchet('unparsedMax', r.unparsed.length),
    unknownEntriesMax: lowerRatchet('unknownEntriesMax', r.unknown.length),
  });
  /**
   * ★★ v3.12 实测出来的第二个洞（比第一个更难看）：`nakedWriteRoutes` 与 `triageVerdicts`
   *   这两份**写手从来不刷新** ⇒ 基线里那份"78 条裸写路由"是手抄的：本批只改了 claimRoute
   *   catch 里的 4 行、路由注册一行没动，守卫就红 9 条，而 `--write` 修不掉它（它不写这两个字段），
   *   只能人去改两处字符串 —— 而"清单 + verdict 两张表要同步手改"正是本仓 B35/B75 那族
   *   "登记了但没人对"的现场。现在：清单由本次测量派生，**verdict 按签名（去掉行号）搬家**
   *   ⇒ 人的判断跟着路由走，行号只当噪声；签名对不上而消失的 verdict 会被打印并删掉（不留死认领）。
   */
  const nakedSorted = [...nowLists.nakedWriteRoutes].sort();
  const verdictKeys = Object.keys(j.triageVerdicts ?? {});
  const verdictBySig = {};
  const collided = [];
  for (const k of verdictKeys) {
    const sig = siteSignature(k);
    // ★ 复核 I-2 的牙：签名相同而条目不同（一个文件里同 method+path 注册两次）时，按签名搬家会
    //   **静默把两条判定并成一条** ⇒ 有一判定被悄悄换到另一条路由头上。今天实测零重复（下面这条
    //   因此是"将来真出现才会咬"的闸），但它是这个机制唯一的守门人，不能省。
    if (verdictBySig[sig]) collided.push(sig);
    verdictBySig[sig] = j.triageVerdicts[k];
  }
  if (collided.length) {
    console.error('★ 基线里有多条判定去掉行号后**同签名** ⇒ 无法按签名搬家（会静默覆盖判定）。中止写盘：'
      + JSON.stringify([...new Set(collided)]));
    console.error('   处置：手工把这两条的判定改成可区分的条目（或按本仓规矩，同 method+path 重复注册本身要先定性）。');
    process.exit(1);
  }
  const orphan = [];
  const nextVerdicts = {};
  for (const k of nakedSorted) {
    const v = verdictBySig[siteSignature(k)];
    if (v) nextVerdicts[k] = v;
    else { orphan.push(k); nextVerdicts[k] = { verdict: 'untriaged', reason: '' }; }
  }
  const dropped = Object.keys(verdictBySig).filter((s) => !nakedSorted.some((k) => siteSignature(k) === s));
  if (orphan.length) console.log(`★ 新出现在裸写清单上、此前没有 verdict 的 ${orphan.length} 条（已登记 untriaged，棘轮会盯住总数，不定性就别合批）:`, JSON.stringify(orphan.slice(0, 5)));
  if (dropped.length) console.log(`随裸路由消失而删除的 verdict ${dropped.length} 条（防"死认领"留在账上）:`, JSON.stringify(dropped.slice(0, 5)));
  j.nakedWriteRoutes = nakedSorted;
  j.triageVerdicts = nextVerdicts;
  /**
   * ★ 复核 M-2：清单改成派生之后，守卫那句"逐条相等"比的是刚被派生过的同一份读数 ⇒ **对集合变化恒真**。
   *   所以"放行"必须变成一条**留在文件里的、可审的记录**，而不是终端里滚过的一行：
   *   `_setChangeLog` 只追加、每条必带理由与放行后的裸路由条数 ⇒ 守卫钉"最后一条的条数 == 当前条数"，
   *   有人**手改清单**（绕过写手）就会在那一条上红。（只留最近 20 条，防基线无界膨胀。）
   */
  if (changed.length) {
    const beforeLists=signatureLists(baseLists), afterLists=signatureLists(nowLists);
    j._setChangeLog = [...(j._setChangeLog ?? []), {
      at:new Date().toISOString(), reason, measurementVersion:MEASUREMENT_VERSION, sourceCommit,
      sourceEvidence:beforeEvidence,
      beforeLists, afterLists, beforeDigest:surfaceSetDigest(beforeLists), afterDigest:surfaceSetDigest(afterLists),
      added:Object.fromEntries(changed.sort().map(n=>[n,[...drift[n].added].sort()])),
      removed:Object.fromEntries(changed.sort().map(n=>[n,[...drift[n].removed].sort()])),
      nakedCountAfter:nakedSorted.length,
      evidenceLimit:'Static route/source evidence only. Existing untriaged and cross-service unknowns remain unresolved; no runtime authorization coverage claim.',
    }];
  }
  j.measurementVersion=MEASUREMENT_VERSION;
  j.sourceEvidence=beforeEvidence;
  j.scannerEvidence=['scripts/lib/writeRouteSurface.mjs','scripts/g41-write-surface-scanner.mjs'].map(file=>({file,sha256:createHash('sha256').update(fs.readFileSync(join(R,file))).digest('hex')}));
  if(correction) {
    // Full exact route/source readings live in an independently hashed artifact;
    // do not duplicate megabytes of raw evidence in the ratchet baseline.
    const evidencePath = correctionArg.slice('--measurement-correction='.length);
    j._measurementCorrection = {
      sourceHead: correction.sourceHead, sourceEvidence: correction.sourceEvidence,
      evidenceFile: evidencePath.startsWith(R + '/') ? evidencePath.slice(R.length + 1) : evidencePath,
      evidenceSha256: createHash('sha256').update(fs.readFileSync(evidencePath)).digest('hex'),
      applicationSourceDigest: correction.applicationSourceEvidence.sha256,
      before: { measurement:correction.before.measurement, summary:correction.before.summary },
      after: { measurement:correction.after.measurement, summary:correction.after.summary },
      registrationChanges: correction.registrationChanges,
      evidenceLimit: correction.evidenceLimit,
    };
  }
  // New application registrations remain explicitly unresolved, not silently
  // converted to 'safe'. Future additions still fail exact multiset comparison.
  j.ratchet.untriagedMax=lowerRatchet('untriagedMax', nakedSorted.filter(k=>nextVerdicts[k]?.verdict==='untriaged').length);
  j._retainedRatchetViolations = [
    ['configDependentMax', s.permissionCoveredButConfigDependent],
    ['untriagedMax', nakedSorted.filter(k=>nextVerdicts[k]?.verdict==='untriaged').length],
  ].filter(([name, observed])=>observed>j.ratchet[name]).map(([name, observed])=>({name, observed, maximum:j.ratchet[name],
    reason:'Actual new registrations remain unresolved; measurement re-freeze does not expand the cap or certify authorization.'}));
  j.noEvidenceRoutes = noEv;
  j.authnOnlyRoutes = authn;
  j.bodyUnbounded = unbounded;
  j.configDependentRoutes = cfgDep.map(key).sort();
  j.readOnlyScopeRoutes = readOnly.map(key).sort();
  /**
   * `unknownGuardShapes` 也改成派生（原先是手抄清单 ⇒ 归类完忘了同步，基线就长期挂着一条已消失的形状）。
   * 牙齿没丢：守卫现在做**集合相等**，忘了重冻结就红；重冻结会在这里打印"消失了哪些 / 新增哪些"，改动留在 diff 里。
   */
  const shapesNow = [...new Set(r.unknown.map((u) => u.ident))].sort();
  const gone = (j.unknownGuardShapes ?? []).filter((k) => !shapesNow.includes(k));
  const added = shapesNow.filter((k) => !(j.unknownGuardShapes ?? []).includes(k));
  if (gone.length) console.log('已归类消失的形状（确认是真归类了，不是尺瞎了）:', JSON.stringify(gone));
  if (added.length) console.log('新增未归类形状:', JSON.stringify(added));
  j.unknownGuardShapes = shapesNow;
  /** ★ `namedHandlerRoutes` 原先也躺着 14 条旧值 ⇒ 一并派生刷新，并由守卫做集合对撞（不再是死字段） */
  j.namedHandlerRoutes = r.routes.filter((x) => x.shape === 'named-handler').map(key).sort();
  if (surfaceSourceEvidence(R).sha256 !== beforeEvidence.sha256) { console.error('扫描期间源码变化，拒绝写入混合快照。');process.exit(1); }
  fs.writeFileSync(BF, JSON.stringify(j, null, 1) + '\n');
  console.log('基线已写入', BF);
}
console.log(JSON.stringify(s));
console.log('noEvidence', noEv.length);
for (const k of noEv) console.log('   ', k);
console.log('authnOnly', authn.length);
for (const k of authn.slice(0, 25)) console.log('   ', k);
console.log('unbounded', JSON.stringify(unbounded));
