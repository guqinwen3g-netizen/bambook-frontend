/**
 * Ops Panel 部署「沿用（carryover）」守卫（2026-09-19）
 *
 * ── 病灶（实测，不是推测）──────────────────────────────────────────
 * 客户端 `ops-upload-webapp.sh` 走**增量模式**：远端清单里「同名同 size」的文件不打进包里
 * （为了省流量）。服务端 `deployUploadedWebapp` 是**整目录替换**语义（旧目录 mv 到 .prev，
 * 再 cp 新包）—— 所以**被省略的文件必须由服务端沿用补回**。
 *
 * 旧实现判据写的是 `if (!fs.existsSync(inPackage)) { 整目录 cp -R prev }`，
 * 而 `tar -C dist .` **一定会写入目录条目**（`./fonts/`）⇒ `inPackage` **恒为真**
 * ⇒ 沿用**从不触发** ⇒ 被省略的文件在部署时**被静默删除**。
 *
 * 实测后果（修复前，两个入口互相丢文件、站点 404 且无人报警）：
 *   · `webapp-root/fonts/` 只剩 Inter-*.woff2，AcherusGrotesque-*.otf 被删
 *   · `webapp/fonts/` 只剩 AcherusGrotesque-*.otf，Inter-*.woff2 被删
 *   · 浏览器侧表现为 `GET /fonts/Inter-300.woff2 → 404`
 *
 * 修法：**逐文件合并** —— prev 里有、包里没有的同路径文件逐个补齐（包里的新版优先）。
 *
 * ── 第二起（2026-09-19 晚，同一类，换了个位置）──────────────────────
 * 根级沿用**硬编码只列了 2 个文件名**（`ne_50m_admin_0_countries.geojson` /
 * `earth_specular_2048.jpg`）⇒ **其它根级文件**被增量包省略后同样被静默删除。
 * 生产实测：`webapp` 入口的 `pwa-icon.svg` / `ui-lab-icon.svg` / `logo_dual.svg` **已 404**，
 * 而 `webapp-root` 尚在 —— **又是「两个入口互相丢文件」**。
 * 修法：判据**翻转** —— 遍历 `prev` 根级、包里没有的才补（枚举「不沿用的」而不是「要沿用的」）；
 * ⚠️ 跨入口沿用（无 prev 时）**必须跳过 `index.html`**（两个入口 base 不同，拿了会指错路径）。
 *
 * ⚠️ 每条断言都要能踩红 —— 改完请把期望值反过来跑一次确认会失败。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(__dirname, '../../ops-panel/src/index.ts'), 'utf8');
const CLIENT = readFileSync(resolve(__dirname, '../../../scripts/ops-upload-webapp.sh'), 'utf8');

describe('服务端沿用：必须逐文件合并', () => {
  it('★ 不得再用「整目录 cp -R」做沿用（tar 必带目录条目 ⇒ 判据恒真 ⇒ 沿用永不触发）', () => {
    // 旧写法：execFileAsync('/bin/cp', ['-R', source, path.join(webappDir, heavyDir)])
    expect(SRC).not.toMatch(/'\/bin\/cp',\s*\['-R',\s*source,\s*path\.join\(webappDir,\s*heavyDir\)\]/);
    // 目录级判据（`!fs.existsSync(inPackage)` 用在 heavyDir 循环里）也不得回潮
    expect(SRC).not.toMatch(/if \(!fs\.existsSync\(inPackage\) && source\) \{\s*\n\s*await execFileAsync/);
  });

  it('阳性对照：根级文件仍是**文件级**沿用（那条判据本来就是对的，别一起删了）—— 2026-09-19 晚已泛化', () => {
    // ── 本条断言的**搬家记录**（意图不变、断言更强）──────────────────
    // 原断言钉的是**硬编码 2 个文件名**的写法（`for (const heavyFile of ['ne_50m_...']`）。
    // 当天晚些时候实测发现：**其它根级文件**（`pwa-icon.svg` / `ui-lab-icon.svg` / `logo_dual.svg`）
    // 被增量包省略后**静默删除**（生产 `webapp` 入口这 3 个已 404，`webapp-root` 尚在）
    // —— 与上面 fonts 那起**同一类**：**枚举「要沿用的」⇒ 覆盖面必然小于实际文件面**。
    //
    // 修法：判据**翻转**为「遍历 prev 根级、包里没有的才补」。
    // ⇒ 本断言随之搬家：不再钉字面清单，改钉**新形态的三要素**（枚举 / 新版优先 / 确实复制），
    //    并**额外禁止回退**到硬编码清单。
    expect(SRC).toMatch(/for \(const name of fs\.readdirSync\(rootSource\)\)/);          // ① 枚举，不是硬编码
    expect(SRC).toMatch(/if \(fs\.existsSync\(path\.join\(extractDir, name\)\)\) continue;/); // ② 包里的新版优先
    expect(SRC).toMatch(/fs\.copyFileSync\(srcAbs, path\.join\(webappDir, name\)\)/);     // ③ 确实在复制
    // ④ 不得回退到「硬编码根级文件数组」（那就是本次缺陷的成因）
    expect(SRC).not.toMatch(/for \(const heavyFile of \[/);
  });

  it('阳性对照：确实还在做沿用（不能靠整段删掉来"通过"）', () => {
    expect(SRC).toContain('carryDirs');
    expect(SRC).toContain('crossEntrySource');
    expect(SRC).toContain('carryover');
  });

  it('★ 逐文件补齐：包里没有的才从 prev 复制（包里的新版优先，不能被旧版覆盖）', () => {
    expect(SRC).toMatch(/if \(fs\.existsSync\(.*inPackage.*\)\) return;/);
    expect(SRC).toContain('fs.copyFileSync(srcAbs, dstAbs)');
  });

  it('★ 必须建父目录（包省略整个子目录时，目标目录还不存在）', () => {
    expect(SRC).toContain('fs.mkdirSync(path.dirname(dstAbs), { recursive: true })');
  });

  it('沿用目录清单必须覆盖 fonts（本次事故的目录）', () => {
    expect(SRC).toMatch(/carryDirs = target === 'webapp-root'[\s\S]{0,200}'fonts'/);
    expect(SRC).toMatch(/'data',\s*'wallpapers',\s*'glyphs',\s*'geo',\s*'fonts'/);
  });

  // ── 2026-09-19 晚新增：根级沿用**翻转**后的两条专属约束 ──────────────
  it('★ 根级沿用只管文件，目录交给 carryDirs（别在根级重复处理目录）', () => {
    const seg = SRC.slice(SRC.indexOf('const rootSource'), SRC.indexOf('const rootSource') + 1600);
    expect(seg).toMatch(/if \(isDir\) continue/);
  });

  it('★ 跨入口沿用必须跳过 index.html（两入口 base 不同，拿对方的会指错资源路径）', () => {
    const seg = SRC.slice(SRC.indexOf('const rootSource'), SRC.indexOf('const rootSource') + 1600);
    expect(seg).toMatch(/fromCross\s*&&\s*name\s*===\s*'index\.html'/);
  });

  it('守卫自检：能咬住「硬编码根级文件数组」的写法（证明上面那条禁止有区分度）', () => {
    const OLD = `for (const heavyFile of ['ne_50m_admin_0_countries.geojson', 'earth_specular_2048.jpg']) {
      if (!fs.existsSync(inPackage) && source) fs.copyFileSync(source, path.join(webappDir, heavyFile));
    }`;
    expect(OLD).toMatch(/for \(const heavyFile of \[/);
    expect(OLD).not.toContain('readdirSync');
  });
});

describe('客户端：增量跳过是沿用存在的前提', () => {
  it('阳性对照：客户端确实在做「同名同 size 就跳过」（否则本守卫的前提不成立）', () => {
    expect(CLIENT).toContain('remote_size');
    expect(CLIENT).toContain('local_size');
    expect(CLIENT).toContain('DIFF_EXCLUDES_FILE');
  });

  it('入口文件永不跳过（避免沿用没生效时连 HTML 都缺）', () => {
    expect(CLIENT).toMatch(/rel.*index\.html.*continue/);
  });
});
