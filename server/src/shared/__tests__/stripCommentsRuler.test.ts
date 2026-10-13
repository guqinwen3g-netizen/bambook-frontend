/**
 * ★ 尺的尺：`stripComments`（`scripts/lib/errorDebtScanners.mjs`）—— B32/B33/B34/B36/B37/B39、
 * RAW_LEAK、B74 前端尺、routeSurface **全部**建立在它之上。它瞎一次，上面每一条口径一起瞎一次，
 * 而且**红的是"零命中"**（最坏的那种失效：报告说干净）。
 *
 * B76（v2.49 立账 · v2.52 更正账面）：旧实现是"两遍 replace"，先无条件做块注释 ⇒ 任何**非注释文本**里出现的注释定界符
 * 都会劫持它。四扇门，逐扇一条用例：
 *   ① 行注释里写块注释开头（Markdown 强调、路径通配）
 *   ② JSX 正文里写块注释开头（`<code>/api/v1/*</code>`）
 *   ③ 块注释里写行注释符号（顺序反过来也会被劫持 ⇒ "换个顺序"不是修复）
 *   ④ 字符串 / 模板串 / 正则字面量里的 `//`（URL）
 * ★ 反面对照的**诚实账**（v2.50 banner 曾写"④b 补了自己的用例 ⇒ 删掉模板支会红"，v2.52 复核 I-1 证伪）：
 *   每条用例的 `bad` 都是**手抄的旧实现**，它证明的是"新尺比旧尺看得见更多"，
 *   **不证明**"这一支在当前实现里是承重的"。要把后者变成可跑的判据，必须能构造"当前实现的退化版"，
 *   本文件因此多了一份 `stripNaiveNoTemplate`（把模板内容当代码态的两遍式退化版）—— 它同样只是反面对照，不参与判据。
 *   另有一次性突变实测（`/tmp/i1-verify.mjs`，删掉 lib 里模板支那 26 行）：
 *   原 ④b 样本 **base=true 且 突变体=true**（无区分力 ⇒ 上一批那句覆盖声称是假的）；
 *   本批换成的两条 **base=true 而突变体=false**（★有牙齿）。
 * 现量（**同一件事有两个口径，禁止跨口径加减**；v2.52 复核 I-2 就是因为账面只写了其中一个）：
 *   口径 A｜守卫总闸集（`server/src` + `server/scripts` + 前端枚举器，= 本文件 `files` 数组）
 *          = **1427 文件 / 旧尺吃掉 1282 行 → 新尺 177 行 / 10 个文件有差异**
 *   口径 B｜`enumerateFrontendSources()` 单独（= B74 那把尺的扫描面，台账 B76 行引用的就是它）
 *          = **880 文件 / 1223 → 177 / 7 个文件**；其中 excluded=false 的可见面 = 324 文件 / 609 → 177 / 3 个文件
 *   口径 C｜server 子集（A 里以 `server/` 开头的 1089 文件）= 673 → **0** ⇒ "server 侧已清干净"只在 C 成立
 *   新尺更瞎的文件 **0 个**；行数守恒在 A 的全量 1427 个文件上成立。
 *   剩下那 177 行新旧完全相同（抽样 RelationsManager 六段核对 = 真块注释的**续行**，探针的 isCode 把不带星号的续行当代码）
 *   ⇒ 判为**探针噪声**，不是缺陷。
 *   模板支的代价（方向已量，v2.52 更正"25 行"为实测值）：**26 行**"模板里的真注释不再被剥"= 只会多看见（误报方向），
 *   反向"新尺反而看不见" = **0 行** ⇒ B76 那句"宁可多看见"成立。
 * ⚠️ 以上四个数目前**没有唯一读数出口**：口径 A 由本文件算，口径 B/C 靠一次性 /tmp 探针 ⇒ 已立账 **B77**
 *    （修法是把这些差分固化进 `measure-error-debt.mjs`，让台账每个数都能一条命令复现）。
 *
 * ⚠️ 本文件里那份 `stripOld` 是旧实现的**手抄本**（只作反面对照，不参与任何判据）。
 *    手抄本会抄错 ⇒ 第 0 条用例把它该做的事逐条钉住（同 B68 的 `legacy()` 教训）。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './utils/sourceScan';
import {
  scanFrontendSources, frontendLeakBuckets, FRONTEND_LEAK_SHAPES, enumerateFrontendSources,
  FRONTEND_EXCLUDE_ANY, FRONTEND_EXCLUDE_ROOT,
} from '../../../scripts/lib/errorDebtScanners.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));   // server/src/shared/__tests__
const SERVER = path.resolve(HERE, '..', '..', '..');         // server
const REPO = path.resolve(SERVER, '..');

/** 旧实现（`git show 4a4e7efc:server/scripts/lib/errorDebtScanners.mjs` 里的那两遍 replace），逐字抄 */
const stripOld = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length))
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** 另一种"看起来像修复"的写法：只把两遍换个顺序 ⇒ 死在另一扇门上（用例 ③ 的反面对照物） */
const stripOrderSwapped = (src: string) => src
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  .replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length));

/**
 * 又一种"看起来没问题"的写法：**不认模板串**，模板内容一律当代码态走两遍注释替换。
 * 它建模的是当前实现里"删掉模板支"之后会发生什么（v2.52 复核 I-1 用真突变体量过：base 看得见、这一版看不见）。
 * ★ 与上面两份一样，它只是**反面对照**，不参与任何判据与基线（同 B68 的 `legacy()` 处理）。
 *   与 `stripOld` 的差别很关键：旧尺的行注释那一遍带 `(^|[^:])` 这道"不咬 URL 的 `://`"的闸，
 *   所以 `stripOld` **在这一支上没有区分力** —— 用例 ④b-2 必须挂这一版，挂 `stripOld` 就是自证一个空命题。
 */
const stripNaiveNoTemplate = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length))
  .replace(/\/\/[^\n]*/g, '');

/** 某行在剥完之后还在不在（行号保真 ⇒ 能按行号这么问） */
const lineKept = (strip: (s: string) => string, src: string, needle: string) => {
  const lines = strip(src).split('\n');
  const at = src.split('\n').findIndex((l) => l.includes(needle));
  expect(at, `样本里没有那行：${needle}`).toBeGreaterThanOrEqual(0);
  return lines[at].includes(needle);
};

describe('B76 · 第 0 条：手抄本自检（stripOld 必须做到它当年那三件事）', () => {
  it('会剥行注释、会剥块注释、块注释跨行时按行还原', () => {
    expect(stripOld('a; // b').trim()).toBe('a;');
    expect(stripOld('a; /* b */ c;').trim()).toBe('a;  c;');
    const two = stripOld('a;\n/* x\ny */\nb;');
    expect(two.split('\n').length).toBe(4);   // 行数守恒（旧实现也保这一条）
    expect(two.split('\n')[3].trim()).toBe('b;');
  });
});

/**
 * 四扇门。**每扇的样本里都必须留一个"后面真的会闭合"的块注释** —— 劫持的成因是"假的开头找到下一个真的收尾"，
 * 没有收尾就什么都吃不到（我第一版样本正是漏了这个，四条全部假绿：旧尺也没瞎）。
 */
describe('B76 · 四扇门：每扇门都要"该瞎的那把尺当场瞎、新尺不瞎"（另有 ④c 一条防新尺自己退化，它不算门）', () => {
  const cases: Array<{ name: string; src: string; sentinel: string; bad: (s: string) => string; badName: string }> = [
    {
      name: '① 行注释里出现块注释开头（本批我自己踩过：注释里写 Markdown 强调）',
      src: "const A = 1; // 有发票/核销分摊/**批次计划**的订单不可删除\nconst B = 'SENTINEL_1';\n/** 后面某处的真块注释 */\nconst C = 3;\n",
      sentinel: 'SENTINEL_1', bad: stripOld, badName: '旧尺（两遍 replace，块在前）',
    },
    {
      name: '② JSX 正文里出现路径通配（Settings.tsx 的真实形状）',
      src: "export function P() {\n  return (\n    <p>\n      连接后端 <code>/api/v1/*</code> 时的认证方式。\n      <div className='SENTINEL_2'>认证模式</div>\n      <span>x</span>\n    </p>\n  );\n}\n/** 下一个真块注释收尾在这里 */\n",
      sentinel: 'SENTINEL_2', bad: stripOld, badName: '旧尺（JSX 正文它分不出来）',
    },
    {
      name: '③ 块注释里出现行注释符号 ⇒ "把两遍换个顺序"会死在这扇门上',
      src: "/* 说明 // 链接 收尾 */\nconst x = 'SENTINEL_3';\n/** 下一段真块注释 */\nconst y = 2;\n",
      sentinel: 'SENTINEL_3', bad: stripOrderSwapped, badName: '换序版（行注释在前，把收尾吃掉了）',
    },
    {
      name: '④a 字符串里的斜杠与通配（尺不该把字面量当注释态）',
      src: "const s = 'a 注释 // 还有 /* 通配';\nconst keep = 'SENTINEL_4';\n/** 真块注释 */\nconst after = 3;\n",
      sentinel: 'SENTINEL_4', bad: stripOld, badName: '旧尺（字符串里的假开头它一样认）',
    },
    {
      // ★ 复核 I-2（v2.50）：这一支从前"整段删掉守卫也全绿"⇒ 它必须有自己的用例
      // ★ 复核 I-1（v2.52）：原样本的假开头是 `v1/*` 这种形状 ⇒ 旧尺**确实**瞎（用例是绿的），
      //   但"删掉当前实现的模板支"那个突变体也不瞎 ⇒ 它保护的命题比上一批声称的窄。现已换成不闭合那一类。
      name: '④b 模板串里的假块注释开头且**不闭合** ⇒ 一路找到下一个真收尾，把下一行的代码吃掉',
      src: "const t = `note: /* 未闭合的假开头`;\nconst keep = 'SENTINEL_TPL';\n/** 下一个真块注释收尾 */\nconst after = 1;\n",
      sentinel: 'SENTINEL_TPL', bad: stripOld, badName: '旧尺（模板里的假开头一路找到下一个收尾）',
    },
    {
      // ★ v2.52 复核 I-1 补：这一条防的不是"旧两遍尺"，而是"把模板内容当代码态"这一族退化。
      //   哨兵必须与模板**同一行**才有牙齿 —— 行注释那一支只吃到行尾（这一点是复核实测逼出来的）。
      //   挂 `stripOld` 会变成空命题（旧尺的 `(^|[^:])` 不咬 URL 的 `://`）⇒ 挂 stripNaiveNoTemplate。
      name: '④b-2 模板里的 URL 双斜杠与代码同行（防"模板内容当代码态"的退化）',
      src: "const t = `详见 https://example.com/a`; const keep = 'SENTINEL_TPL2';\nconst after = 2;\n",
      sentinel: 'SENTINEL_TPL2', bad: stripNaiveNoTemplate, badName: '退化版（不认模板串，把模板里的双斜杠当行注释）',
    },

  ];

  for (const c of cases) {
    it(`${c.name} ⇒ 新尺看得见那一行、${c.badName}看不见`, () => {
      expect(lineKept(stripComments, c.src, c.sentinel), `新尺把 ${c.sentinel} 吃掉了`).toBe(true);
      expect(lineKept(c.bad, c.src, c.sentinel), '对照组没瞎 ⇒ 这条用例已经失去区分力，该换样本').toBe(false);
    });
  }

  /**
   * ★ ④c 正则字面量这一支**不声称"旧尺会瞎"** —— 复核实测旧尺在真实样本上恰好不被它咬
   *   （`/a\/\/b/` 里没有裸的双斜杠序列）。它防的是**新尺自己退化**：
   *   一旦哪天把 `/` 后面的内容当行注释，同一行后半段就会静默消失，而这条用例当场红。
   */
  it('④c 正则字面量：新尺不许把正则里的斜杠序列当注释（这一支是防自己退化，不是防旧尺）', () => {
    const src = "const re = /a\\/\\/b/; const keep = 'SENTINEL_RE';\nconst after = 2;\n";
    expect(lineKept(stripComments, src, 'SENTINEL_RE')).toBe(true);
    expect(lineKept(stripComments, src, 'SENTINEL_RE') && lineKept(stripOld, src, 'SENTINEL_RE')).toBe(true);
  });

  it('★ 但尺还是尺：真正的注释必须仍然被剥掉（不许为了"不瞎"退化成不剥）', () => {
    expect(stripComments("try { x(); } catch (e) {\n  // return fail('X', e?.message || '兜底');\n}")).not.toContain('e?.message');
    expect(stripComments("/* return fail('X', e?.message); */\nconst a = 1;")).not.toContain('e?.message');
    expect(stripComments("const a = 1; /* 注释 https://x */\nconst b = 2;")).toContain('const b = 2;');
  });
});

describe('B76 · 真实受害者：曾经瞎掉的五处代码，现在必须在场', () => {
  /** 按"整行内容"定位（不是 `includes`：这些片段在文件里另有出现，用全文包含会假绿） */
  const victims: Array<{ file: string; line: string; label: string }> = [
    { file: 'src/index.ts', line: "    if (req.url === '/bambook/api' || req.url.startsWith('/bambook/api/')) {", label: 'index.ts :376（盲区 375→1328，545 行 —— 里面躺着 /bambook 前缀剥离中间件）' },
    { file: 'src/notifications/notificationService.ts', line: "  lc_shipment_deadline: '信用证装运截止',", label: 'notificationService :70（盲区 62→116）' },
    { file: 'src/audit/auditService.ts', line: '    if (!matchSeg(patSegs[i], pathSegs[i])) return false;', label: 'auditService :65（盲区 60→73）' },
    { file: '../components/Settings.tsx', line: "                    <div className={labelCls + ' mb-2'}>认证模式</div>", label: 'Settings.tsx :700（该文件 32% 曾不可见）' },
    { file: '../services/apiService.ts', line: '  MarketingCampaign,', label: 'apiService.ts :232（行注释里的 /api/v2/marketing/ 通配吃掉 43 行）' },
  ];
  for (const v of victims) {
    it(`${v.label} ⇒ 新尺保留、旧尺丢失`, () => {
      const raw = fs.readFileSync(path.join(SERVER, v.file), 'utf8');
      const at = raw.split('\n').findIndex((l) => l.trim() === v.line.trim());
      expect(at, `样本行已不在原位（这行被改过 ⇒ 换个受害者，别放宽断言）`).toBeGreaterThanOrEqual(0);
      const kept = (strip: (s: string) => string) => (strip(raw).split('\n')[at] ?? '').trim().length > 0;
      expect(kept(stripComments), '新尺把它又吃回去了 ⇒ B76 复发').toBe(true);
      expect(kept(stripOld), '旧尺也看得见 ⇒ 这一处已不能区分两把尺，换个受害者').toBe(false);
    });
  }
});

describe('B76 · 总闸：全仓扫一遍，行数必须守恒、且"新尺更瞎"的文件必须为 0', () => {
  const SKIP = new Set(['node_modules', 'generated', '.prisma', 'dist', 'build', 'coverage']);
  const files: string[] = [];
  const extraAbs = new Set<string>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(SERVER, 'src'));
  walk(path.join(SERVER, 'scripts'));
  /**
   * ★ v2.49 复核 I-1：这条总闸原标题写"全仓"，可它只走 `server/src` + `server/scripts`
   *   ⇒ 同一批 5 处真实受害者哨里有 2 处（`components/Settings.tsx`、`services/apiService.ts`）
   *   它根本看不见，`vite.config.ts` 也看不见。现在前端与仓根文件由**尺自己的枚举器**带进来，
   *   不再各写一份遍历（两份枚举必然漂）。
   */
  for (const f of enumerateFrontendSources(REPO)) extraAbs.add(f.abs);

  for (const p of extraAbs) if (!files.includes(p)) files.push(p);
  it(`${files.length} 个文件逐一行数守恒（口径 A：server/src + server/scripts + 前端枚举器；台账里那个 880 是口径 B，见文件头）`, () => {
    for (const f of files) {
      const raw = fs.readFileSync(f, 'utf8');
      expect(stripComments(raw).split('\n').length, `${path.relative(REPO, f)} 行数不守恒`).toBe(raw.split('\n').length);
    }
  });

  it('★ 差分总闸：不存在"旧尺看得见、新尺反而吃掉"的文件（修复不许引入新的盲区）', () => {
    const isCode = (l: string) => { const t = l.trim(); return t !== '' && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); };
    const eaten = (raw: string, strip: (s: string) => string) => {
      const rl = raw.split('\n'), sl = strip(raw).split('\n');
      let v = 0;
      for (let i = 0; i < rl.length; i++) if (isCode(rl[i]) && (sl[i] ?? '').trim() === '') v++;
      return v;
    };
    const worse: string[] = [];
    const g = { server: { old: 0, new: 0 }, frontend: { old: 0, new: 0 } };
    for (const f of files) {
      const raw = fs.readFileSync(f, 'utf8');
      const o = eaten(raw, stripOld), n = eaten(raw, stripComments);
      const bucket = f.startsWith(SERVER) ? g.server : g.frontend;
      bucket.old += o; bucket.new += n;
      if (n > o) worse.push(`${path.relative(REPO, f)}(${o}→${n})`);
    }
    expect(worse, '新尺更瞎的文件').toEqual([]);
    /**
     * 分组的原因（复核 I-1 顺带暴露）：扩面之后"全仓 vanish=0"这个断言本来就不成立 ——
     * 前端那些**真块注释的不带星号续行**会被 `isCode` 当代码，两版尺都一样看不见 ⇒ 探针噪声。
     * 所以强命题只写在 server 侧（那里 vanish 必须为 0），前端侧只钉"不比旧尺更瞎 + 差分不许退步"。
     */
    expect(g.server.new, `server 侧新尺仍吃掉了 ${g.server.new} 行 ⇒ B76 复发`).toBe(0);
    // 差分总闸：旧尺在 server 侧吃掉的行数（口径 C = 总闸集里以 server/ 开头的 1089 个文件，v2.55 现量 **673**；原先这里写"约 610"是 B∩server=542 个文件那个口径的 614，混了两个口径）⇒ 一旦有人把尺换回去就会掉回来
    expect(g.server.old).toBeGreaterThanOrEqual(600);
    expect(g.frontend.new).toBeLessThan(g.frontend.old);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * 下半段管的是"尺的**视野**"（v2.47 复核 B1 / I-1 / I-2）。
 * 上半段防"看得见但看错"，这一段防"根本没在看"。
 * ───────────────────────────────────────────────────────────────────────── */
describe('B74 尺的视野 · 复核 B1：范围声明必须与真实扫描一致', () => {
  /**
   * 旧口径的手抄对照（白名单六项，其中三项在仓里根本不存在）——只用来证明"新范围 ⊇ 旧范围的**命中集**"。
   * ⚠️ 比的是"有命中的文件"，不是"被枚举的文件"：`scanFrontendSources` 只返回命中文件，
   *    拿全量文件清单去比会得到 188 个假差异（我第一版就是这么错的）。
   */
  const OLD_DIRS = ['components', 'services', 'src', 'utils', 'hooks', 'screens'];
  const FE = '(?:err|error|e|res|response)';
  const OLD_SHAPES = [
    new RegExp(`\\$\\{[^}]*\\b${FE}\\??\\.message`),
    /\+\s*(?:err|error|e|res|response)\b\??\.message/,          // 单向拼接（复核 I-2 说的那条）
    new RegExp(`\\bset[A-Za-z]*Error\\([^)]*\\b${FE}\\??\\.message`),
  ];
  const oldHits = (root: string) => {
    const out: string[] = [];
    for (const d of OLD_DIRS) {
      const abs0 = path.join(root, d);
      if (!fs.existsSync(abs0)) continue;
      const walk = (dd: string) => {
        for (const e of fs.readdirSync(dd, { withFileTypes: true })) {
          if (['node_modules', '__tests__', 'dist', 'build', 'generated', '.prisma'].includes(e.name)) continue;
          const p = path.join(dd, e.name);
          if (e.isDirectory()) { walk(p); continue; }
          if (!/\.tsx?$/.test(e.name) || /\.test\.|\.d\.ts$|\.spec\./.test(e.name)) continue;
          const hit = stripOld(fs.readFileSync(p, 'utf8')).split('\n')
            .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && OLD_SHAPES.some((rx) => rx.test(l))).length;
          if (hit) out.push(`${path.relative(root, p).split(path.sep).join('/')}#${hit}`);
        }
      };
      walk(abs0);
    }
    return out;
  };

  it('对照组自检：手抄的旧口径确实会命中、也确实漏掉新加的形', () => {
    const lines = stripOld("const s = `x:${err.message}`; setError(err.message); 'a' + e.message");
    // 实测 3（我第一版凭印象写 2 —— 这条自己就是"没量过的数不许进文本"的当场教材）
    expect(OLD_SHAPES.filter((rx) => rx.test(lines))).toHaveLength(3);
    expect(OLD_SHAPES[1].test("showError(err.message + '，请重试')")).toBe(false);
    expect(FRONTEND_LEAK_SHAPES.concat.test("showError(err.message + '，请重试')")).toBe(true);
  });

  it('★ 单调性：旧白名单命中的每一处，新范围一个都不许丢（这条抓"改范围时改出新区"）', () => {
    const seen = new Map(scanFrontendSources(REPO).map((f) => [f.rel, f.lines.length]));
    const dropped = oldHits(REPO).filter((entry) => (seen.get(entry.split('#')[0]) ?? 0) < Number(entry.split('#')[1]));
    expect(dropped, `换范围时丢掉的落点：${dropped.join(', ')}`).toEqual([]);
    expect(oldHits(REPO).length, '旧口径本来就该有命中，否则这条单调性断言是空的').toBeGreaterThan(50);
  });

  it('★ 三处"从前不在视野里"的真实位置现在必须在（复核点名的那三扇门）', () => {
    const rels = scanFrontendSources(REPO).map((f) => f.rel);
    expect(rels, '仓根文件曾整份不可见（台账 B74 行的起源例子就在 App.tsx:944）').toContain('App.tsx');
    expect(rels.some((r) => r.startsWith('customer-portal/')), 'customer-portal 是另一份交付前端').toBe(true);
    expect(rels).toContain('electron/main.ts');
    /** ★ 我自己这批踩过：把 `tools` 放进"任意深度"黑名单 ⇒ `components/tools/` 被顺带剪掉 5 处 */
    expect(rels.some((r) => r.startsWith('components/tools/')), '根级排除项外溢到了子目录').toBe(true);
  });

  it('排除清单分两层：产物目录任意深度剪，仓根目录只在第一层剪', () => {
    expect(FRONTEND_EXCLUDE_ROOT).toContain('tools');
    expect(FRONTEND_EXCLUDE_ANY, 'tools 若在 ANY 里就会误伤 components/tools/').not.toContain('tools');
    expect(FRONTEND_EXCLUDE_ANY).toContain('node_modules');
  });
});

describe('B74 尺的形状 · 复核 I-2：拼接三个方向都要认', () => {
  const hit = (s: string) => Object.values(FRONTEND_LEAK_SHAPES).some((rx) => rx.test(s));
  /** 旧的那一条只认「中文 + err.message」，复核实测另两个方向漏 ⇒ 拿它做反面对照 */
  const OLD_CONCAT = /\+\s*(?:err|error|e|res|response)\b\??\.message/;

  it.each([
    ["setError('失败：' + err.message)", '左拼'],
    ["showError(err.message + '，请重试')", '右拼'],
    ["msg += error.message", '复合赋值'],
    ['toast.error(`同步失败：${e.message}`)', '裸 e'],
    ['setSnapshotError(`订单装载失败：${err.message}`)', 'App.tsx:944 的形状'],
  ])('拼接/插值 %s（%s）', (src) => {
    expect(hit(src), '新尺漏了这一形').toBe(true);
  });

  it('★ 反面对照：旧单向拼接正则确实漏掉两个方向 ⇒ 用例不是为存在而存在', () => {
    expect(OLD_CONCAT.test("showError(err.message + '，请重试')")).toBe(false);
    expect(OLD_CONCAT.test('msg += error.message')).toBe(false);
  });
});

describe('B74 尺的分桶 · 复核 I-1：重叠要"报出来"，不许被 else-if 静默消解', () => {
  it('临时目录里放两行，overlap 必须如实计数（旧的恒等式自检做不到这件事）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b74-'));
    try {
      // 第 1 行同时像 toast 又像具名错误态 ⇒ 优先级取一之后没人知道丢了什么 ⇒ overlap 必须报 1
      fs.writeFileSync(path.join(dir, 'Toast.tsx'), 'setError(`a:${err.message}`); toast.error(x);\n');
      fs.writeFileSync(path.join(dir, 'Plain.tsx'), 'const m = `失败：${e.message}`;\n');
      const r = frontendLeakBuckets(dir);
      expect(r.totalLines).toBe(2);
      expect(r.overlapLines, '一行同时命中两类落点 ⇒ 必须被计成重叠').toBe(1);
      expect(Object.values(r.buckets).reduce((a, b) => a + b, 0)).toBe(r.totalLines);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
