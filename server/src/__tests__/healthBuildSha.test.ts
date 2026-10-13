/**
 * 健康检查的**构建标识**（`build`）—— 源码守卫（2026-09-19）
 *
 * ## 为什么需要
 * 当天实测的缺口：`/api/health` 的 `version` 取的是 `package.json` 版本号（写死 `1.0.0`）
 * ⇒ **从外部无法判断生产部署的是哪个提交**。
 * 当时的替代办法是「探测某个新路由是否存在」来猜版本下界 —— 脆弱、间接、且只在加了路由时可用。
 *
 * ## 为什么用源码守卫而不是行为测试
 * `/api/health` 定义在 `index.ts`（启动整个 app 的入口，import 了全部路由与 Prisma）。
 * 为一个字段把它整条链路跑起来，成本远大于收益；而这里要钉的恰恰是**写法层面**的三条约束。
 *
 * ## 守什么（三条，都带理由）
 *   1. health 响应必须带 `build`（否则「生产跑哪一版」无从判断）
 *   2. 取构建号**必须 try/catch + 有兜底**（生产是打包上传、可能没有 git 仓库
 *      ⇒ 取不到构建号**绝不能**让 health 变 500 —— 健康检查比构建号重要）
 *   3. `BUILD_SHA` 环境变量**必须优先**（打包/部署时注入的正规路径）
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

/** 截出 resolveBuildSha 函数体（大括号配对；注释里也提到旧写法，故先剥注释） */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function fnBody(src: string, fnName: string): string {
  const re = new RegExp(`(?:async\\s+)?function\\s+${fnName}\\s*\\(`);
  const m = re.exec(src);
  if (!m) return '';
  const open = src.indexOf('{', m.index + m[0].length);
  if (open < 0) return '';
  let depth = 0;
  for (let j = open; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(m.index, j + 1);
    }
  }
  return src.slice(m.index);
}

const CODE = stripComments(SRC);
const FN = fnBody(CODE, 'resolveBuildSha');
/** health 响应对象所在片段（到下一个 `res.json` 之前足够） */
const HEALTH_SEG = (() => {
  const i = CODE.indexOf("app.get('/api/health'");
  return i < 0 ? '' : CODE.slice(i, i + 1200);
})();

describe('★ 健康检查构建标识守卫', () => {
  it('能定位到目标片段（防止守卫空过）', () => {
    expect(FN, '未定位到 resolveBuildSha 函数体').not.toBe('');
    expect(HEALTH_SEG, '未定位到 /api/health 片段').not.toBe('');
  });

  it('★ health 响应必须带 build（否则「生产跑的是哪个提交」无从判断）', () => {
    expect(HEALTH_SEG).toMatch(/build\s*:\s*BUILD_SHA/);
  });

  it('★ BUILD_SHA 环境变量必须优先（打包/部署时注入的正规路径）', () => {
    expect(FN).toContain('process.env.BUILD_SHA');
    // 且必须在 try 之前 return（否则 git 取不到时会盖掉注入值）
    const envIdx = FN.indexOf('process.env.BUILD_SHA');
    const tryIdx = FN.indexOf('try');
    expect(envIdx).toBeGreaterThanOrEqual(0);
    expect(tryIdx).toBeGreaterThan(envIdx);
  });

  it('★ 取构建号必须有 try/catch 与兜底（生产无 git 时不得让 health 变 500）', () => {
    expect(FN).toMatch(/try\s*\{/);
    expect(FN).toMatch(/catch/);
    expect(FN).toContain("'unknown'"); // 兜底值
  });

  it('守卫自检：正则确实能咬住「没兜底」的写法（证明上面几条有区分度）', () => {
    const BAD = `function resolveBuildSha() {
    const { execSync } = require('node:child_process');
    return execSync('git rev-parse --short HEAD').toString().trim();
  }`;
    expect(BAD).not.toMatch(/catch/);
    expect(BAD).not.toContain("'unknown'");
    expect(BAD).not.toContain('process.env.BUILD_SHA');
  });
});
